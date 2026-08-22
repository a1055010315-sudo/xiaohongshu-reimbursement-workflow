import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

import {
  canonicalDigest,
  copyStableBinaryBytes,
  loadBundledDependency,
  mapSettledLimit,
  parseStrictJson,
  readStableBinaryFile,
  readStableUtf8JsonFile,
} from "./workflow_primitives.mjs";
import { loadProfileRegistry } from "./finance_domain.mjs";
import {
  DISBURSEMENT_PROFILE_ORDER,
  assertXml10Text,
  buildCompactDisbursementBatchName,
  deriveClosureStatus,
  formatDisbursementAmount,
  normalizeDisbursementIsoDate,
  normalizeRowAmounts,
  normalizeSalaryMonth,
  parseDisbursementAmount,
  paymentMethodDisplay,
  resolveVisibleDisbursementStatus,
} from "./disbursement_domain.mjs";

export const DISBURSEMENT_MANIFEST_KIND = "disbursement-archive-manifest-v1";
export const DISBURSEMENT_AUDIT_KIND = "compact-disbursement-audit-v1";
export const PUBLISHED_REIMBURSEMENT_FACTS_KIND = "published-reimbursement-facts-v1";
export const SALARY_FINAL_ARTIFACT_KIND = "salary-final-artifact-v1";

const SHA_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_VOUCHER_BYTES = 25 * 1024 * 1024;
const MAX_SALARY_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 1_000;
const MAX_PDF_OPERATORS_PER_PAGE = 100_000;
const MAX_PDF_OPERATORS_TOTAL = 1_000_000;
const MAX_PDF_WORKER_DIAGNOSTIC_BYTES = 64 * 1024;
const PDF_PARSE_TIMEOUT_MS = 30_000;
const PROFILE_SET = new Set(DISBURSEMENT_PROFILE_ORDER);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ORDINARY_MANIFEST_AUDITOR = path.join(SCRIPT_DIR, "audit_batch_manifest.mjs");
const PDF_VALIDATOR_WORKER = new URL("./validate_disbursement_pdf_worker.mjs", import.meta.url);
const execFileAsync = promisify(execFile);
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

function fail(message) {
  throw new Error(`Compact Disbursement Manifest ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function text(value, field, { maxLength = 500, singleLine = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || !value || (singleLine && /[\r\n\t]/u.test(value))) {
    fail(`${field} must be a trimmed non-empty${singleLine ? " single-line" : ""} string.`);
  }
  if (value.length > maxLength) fail(`${field} must be at most ${maxLength} characters.`);
  return assertXml10Text(value, field);
}

function optionalText(value, field, options) {
  return value === undefined ? undefined : text(value, field, options);
}

function id(value, field) {
  const result = text(value, field, { maxLength: 96 });
  if (!ID_RE.test(result)) fail(`${field} must use a safe ASCII identifier.`);
  return result;
}

function sha(value, field) {
  const result = text(value, field, { maxLength: 64 });
  if (!SHA_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function absolutePath(value, field) {
  const result = text(value, field, { maxLength: 32_000 });
  if (!path.isAbsolute(result)) fail(`${field} must be absolute.`);
  return path.resolve(result);
}

function exact(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function without(value, field) {
  const result = structuredClone(value);
  delete result[field];
  return result;
}

function assertCertificateDigest(value, field) {
  const expected = sha(value.certificateDigest, `${field}.certificateDigest`);
  if (canonicalDigest(without(value, "certificateDigest")) !== expected) fail(`${field} certificateDigest is invalid.`);
  return expected;
}

function canonicalRelativeReference(value, field) {
  const result = text(value, field, { maxLength: 1_000 });
  if (path.isAbsolute(result) || result.includes("\\") || result.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${field} must be a safe forward-slash relative reference.`);
  }
  return result;
}

async function readBoundJson(filePath, expectedSha256, field) {
  const snapshot = await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
  if (snapshot.sha256 !== expectedSha256) fail(`${field} SHA-256 differs from the manifest binding.`);
  return snapshot;
}

async function runOrdinaryManifestAudit(source, field) {
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [ORDINARY_MANIFEST_AUDITOR, source.originalManifestPath], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_JSON_BYTES,
      timeout: 120_000,
    }));
  } catch (error) {
    fail(`${field} original reimbursement manifest audit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stderr) fail(`${field} original reimbursement manifest auditor wrote stderr.`);
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail(`${field} original reimbursement manifest auditor must return one JSON line.`);
  const result = parseStrictJson(lines[0]);
  if (
    result.ok !== true
    || result.fileVerificationMode !== "manifest-auditor"
    || result.manifestFileSha256 !== source.originalManifestSha256
    || !Array.isArray(result.normalizedTransactions)
    || !Array.isArray(result.affectedProfileIds)
  ) fail(`${field} original reimbursement manifest audit binding is incomplete or changed.`);
  return result;
}

function receiptBinding(value, field) {
  object(value, field);
  return Object.freeze({
    path: absolutePath(value.path, `${field}.path`),
    sha256: sha(value.sha256, `${field}.sha256`),
  });
}

function flattenReceiptOutput(output, field) {
  object(output, field);
  const roles = [];
  for (const role of ["root", "detail", "screenshot", "summary", "snapshot"]) {
    roles.push(Object.freeze({ role, ...receiptBinding(output[role], `${field}.${role}`) }));
  }
  for (const [index, entry] of array(output.supplements, `${field}.supplements`).entries()) {
    roles.push(Object.freeze({ role: `supplement-${String(index + 1).padStart(3, "0")}`, ...receiptBinding(entry, `${field}.supplements[${index}]`) }));
  }
  for (const [index, entry] of array(output.evidenceArchive, `${field}.evidenceArchive`).entries()) {
    roles.push(Object.freeze({ role: `evidence-${String(index + 1).padStart(3, "0")}`, ...receiptBinding(entry, `${field}.evidenceArchive[${index}]`) }));
  }
  if (new Set(roles.map((entry) => entry.role)).size !== roles.length) fail(`${field} has duplicate artifact roles.`);
  return Object.freeze(roles);
}

async function derivePublishedReimbursementSource(source, field, registry) {
  const manifestAudit = await runOrdinaryManifestAudit(source, field);
  const originalManifestSnapshot = await readBoundJson(source.originalManifestPath, source.originalManifestSha256, `${field}.originalManifest`);
  const originalManifestFilePaths = Object.freeze(array(originalManifestSnapshot.value.files, `${field}.originalManifest.files`)
    .map((entry, index) => absolutePath(entry?.path, `${field}.originalManifest.files[${index}].path`)));
  if (!manifestAudit.affectedProfileIds.includes(source.profileId)) {
    fail(`${field} original reimbursement manifest does not contain the requested profile.`);
  }
  const profile = registry.profiles[source.profileId];
  if (!profile) fail(`${field} profile is not in the canonical registry.`);
  const transactions = manifestAudit.normalizedTransactions
    .filter((entry) => entry.category === profile.targetCategory)
    .map((entry) => ({ id: entry.id, date: entry.date, person: entry.person, reimbursementAmount: entry.reimbursementAmount }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (transactions.length === 0) fail(`${field} original reimbursement manifest has no transactions for the requested profile.`);

  const receiptSnapshot = await readBoundJson(source.publishReceiptPath, source.publishReceiptSha256, `${field}.publishReceipt`);
  const receipt = receiptSnapshot.value;
  object(receipt, `${field}.publishReceipt`);
  if (receipt.kind !== "ordinary-reimbursement-published-v1") fail(`${field} publish receipt kind is invalid.`);
  if (canonicalDigest(without(receipt, "receiptDigest")) !== sha(receipt.receiptDigest, `${field}.publishReceipt.receiptDigest`)) {
    fail(`${field} publish receipt digest is invalid.`);
  }
  if (
    receipt.batchId !== manifestAudit.batch?.batchId
    || !Array.isArray(receipt.affectedProfileIds)
    || canonicalDigest(receipt.affectedProfileIds) !== canonicalDigest(manifestAudit.affectedProfileIds)
    || !Array.isArray(receipt.outputs)
  ) fail(`${field} publish receipt does not bind the audited reimbursement batch.`);
  const matchingOutputs = receipt.outputs.filter((entry) => entry?.profileId === source.profileId);
  if (matchingOutputs.length !== 1) fail(`${field} publish receipt must contain exactly one output for the profile.`);
  const actualBindings = flattenReceiptOutput(matchingOutputs[0], `${field}.publishReceipt.output`);
  await mapSettledLimit(actualBindings, 4, async (binding) => {
    const snapshot = await readStableBinaryFile(binding.path);
    if (snapshot.sha256 !== binding.sha256) fail(`${field} published artifact ${binding.role} changed after publication.`);
    return true;
  });
  const certificateCore = {
    kind: PUBLISHED_REIMBURSEMENT_FACTS_KIND,
    version: 1,
    batchId: manifestAudit.batch.batchId,
    profileId: source.profileId,
    originalManifestPath: source.originalManifestPath,
    originalManifestSha256: source.originalManifestSha256,
    publishReceiptPath: source.publishReceiptPath,
    publishReceiptSha256: source.publishReceiptSha256,
    sourceManifestDigest: manifestAudit.manifestDigest,
    publishReceiptDigest: receipt.receiptDigest,
    artifactBindings: actualBindings,
    transactions,
  };
  const certificate = Object.freeze({ ...certificateCore, certificateDigest: canonicalDigest(certificateCore) });
  return Object.freeze({
    certificate,
    manifestAudit,
    receiptDigest: receipt.receiptDigest,
    artifactBindings: actualBindings,
    originalManifestFilePaths,
  });
}

function validateSalaryCertificate(raw, field) {
  exact(raw,
    new Set(["kind", "version", "month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "artifactSha256", "storeReference", "grossPayTotal", "certificateDigest"]),
    new Set(), field);
  if (raw.kind !== SALARY_FINAL_ARTIFACT_KIND || raw.version !== 1) fail(`${field} kind/version is invalid.`);
  const finalArtifactKind = text(raw.finalArtifactKind, `${field}.finalArtifactKind`, { maxLength: 20 });
  if (!new Set(["workbook", "image"]).has(finalArtifactKind)) fail(`${field}.finalArtifactKind must be workbook or image.`);
  const grossPayTotal = parseDisbursementAmount(raw.grossPayTotal, `${field}.grossPayTotal`);
  const normalized = Object.freeze({
    month: normalizeSalaryMonth(raw.month, `${field}.month`),
    salaryCategoryId: id(raw.salaryCategoryId, `${field}.salaryCategoryId`),
    salaryCategoryName: text(raw.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 }),
    finalArtifactKind,
    artifactSha256: sha(raw.artifactSha256, `${field}.artifactSha256`),
    storeReference: canonicalRelativeReference(raw.storeReference, `${field}.storeReference`),
    grossPayTotal: formatDisbursementAmount(grossPayTotal),
    certificateDigest: assertCertificateDigest(raw, field),
  });
  return normalized;
}

function mediaSignature(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", extension: ".png", imageKind: "png" };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return { kind: "image", extension: ".jpg", imageKind: "jpeg" };
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { kind: "pdf", extension: ".pdf" };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return { kind: "workbook", extension: ".xlsx" };
  fail("file content type is not an allowed PNG, JPEG, PDF, or XLSX.");
}

async function validateImageBytes(bytes, signature, field) {
  let validationBytes = bytes;
  let repairedMissingJpegEoi = false;
  if (signature.imageKind === "jpeg" && !(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) {
    validationBytes = Buffer.concat([bytes, Buffer.from([0xff, 0xd9])]);
    repairedMissingJpegEoi = true;
  }
  try {
    const SharpModule = loadBundledDependency("sharp");
    const sharp = SharpModule.default ?? SharpModule;
    const result = await sharp(validationBytes, { failOn: "error", limitInputPixels: 100_000_000 })
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!Number.isSafeInteger(result.info.width) || !Number.isSafeInteger(result.info.height) || result.info.width < 1 || result.info.height < 1) {
      fail(`${field} image dimensions are invalid.`);
    }
    return Object.freeze({ width: result.info.width, height: result.info.height, repairedMissingJpegEoi });
  } catch (error) {
    fail(`${field} image decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function collectWorkerOutput(stream) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  stream.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    const remaining = Math.max(0, MAX_PDF_WORKER_DIAGNOSTIC_BYTES - size);
    if (size < MAX_PDF_WORKER_DIAGNOSTIC_BYTES) {
      chunks.push(bytes.subarray(0, remaining));
      size += Math.min(bytes.length, remaining);
    }
    if (bytes.length > remaining) overflow = true;
  });
  return new Promise((resolve) => stream.on("end", () => resolve({
    text: Buffer.concat(chunks).toString("utf8"),
    overflow,
  })));
}

export async function validateCompletePdfBytes(bytes, field = "PDF voucher") {
  if (!(bytes instanceof Uint8Array)) fail(`${field} PDF bytes must be a Uint8Array.`);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_VOUCHER_BYTES) {
    fail(`${field} PDF must be between 1 byte and 25 MiB.`);
  }
  const worker = new Worker(PDF_VALIDATOR_WORKER, {
    type: "module",
    execArgv: [],
    workerData: {
      bytes: Uint8Array.from(bytes),
      maxPages: MAX_PDF_PAGES,
      maxOperatorsPerPage: MAX_PDF_OPERATORS_PER_PAGE,
      maxOperatorsTotal: MAX_PDF_OPERATORS_TOTAL,
    },
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 64,
      stackSizeMb: 8,
    },
  });
  const stdoutDone = collectWorkerOutput(worker.stdout);
  const stderrDone = collectWorkerOutput(worker.stderr);
  const outcomePromise = new Promise((resolve, reject) => {
    let message;
    let messageCount = 0;
    worker.on("message", (value) => {
      message = value;
      messageCount += 1;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => resolve({ code, message, messageCount }));
  });
  let timeout;
  let outcome;
  try {
    outcome = await Promise.race([
      outcomePromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`PDF parser exceeded ${PDF_PARSE_TIMEOUT_MS} ms`)), PDF_PARSE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    await worker.terminate().catch(() => {});
    fail(`${field} PDF full parse failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const [stdout, stderr] = await Promise.all([stdoutDone, stderrDone]);
  const diagnostic = [stdout.text, stderr.text].filter(Boolean).join(" | ").trim();
  if (stdout.overflow || stderr.overflow || diagnostic) {
    fail(`${field} PDF parser emitted a warning or error${diagnostic ? `: ${diagnostic.slice(0, 4_000)}` : "."}`);
  }
  if (
    outcome.code !== 0
    || outcome.messageCount !== 1
    || !outcome.message
    || typeof outcome.message !== "object"
    || outcome.message.ok !== true
    || !Number.isSafeInteger(outcome.message.pageCount)
    || !Number.isSafeInteger(outcome.message.totalOperators)
  ) {
    const detail = outcome.message?.error ? `: ${String(outcome.message.error).slice(0, 2_000)}` : ".";
    fail(`${field} PDF full parse failed${detail}`);
  }
  return Object.freeze({
    pageCount: outcome.message.pageCount,
    totalOperators: outcome.message.totalOperators,
  });
}

async function validateWorkbookBytes(bytes, field) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch (error) {
    fail(`${field} XLSX ZIP is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!zip.file("[Content_Types].xml") || !zip.file("xl/workbook.xml") || !zip.file("xl/_rels/workbook.xml.rels")) {
    fail(`${field} XLSX lacks required workbook parts.`);
  }
  if (zip.file("xl/vbaProject.bin")) fail(`${field} must not contain VBA.`);
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  if (!/<sheet\b/iu.test(workbookXml)) fail(`${field} XLSX must contain at least one worksheet.`);
}

async function validateBoundBinary(filePath, expectedSha256, field, { salaryKind } = {}) {
  const stable = await readStableBinaryFile(filePath, {
    maxBytes: salaryKind ? MAX_SALARY_ARTIFACT_BYTES : MAX_VOUCHER_BYTES,
  });
  if (stable.sha256 !== expectedSha256) fail(`${field} SHA-256 differs from the manifest binding.`);
  const bytes = copyStableBinaryBytes(stable);
  const signature = mediaSignature(bytes);
  let image;
  if (signature.kind === "image") image = await validateImageBytes(bytes, signature, field);
  else if (signature.kind === "pdf") await validateCompletePdfBytes(bytes, field);
  else if (signature.kind === "workbook") await validateWorkbookBytes(bytes, field);
  if (salaryKind && signature.kind !== salaryKind) fail(`${field} content does not match finalArtifactKind.`);
  if (!salaryKind && !new Set(["image", "pdf"]).has(signature.kind)) fail(`${field} must be an image or PDF voucher.`);
  return Object.freeze({ stable, bytes, signature, image });
}

function normalizeExpectedAmount(value, field, options) {
  return formatDisbursementAmount(parseDisbursementAmount(value, field, options));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export async function auditDisbursementManifest({ manifestPath, manifestSha256 }) {
  const resolvedManifestPath = absolutePath(manifestPath, "manifestPath");
  const expectedManifestSha256 = sha(manifestSha256, "manifestSha256");
  const manifestSnapshot = await readStableUtf8JsonFile(resolvedManifestPath, { maxBytes: MAX_JSON_BYTES });
  if (manifestSnapshot.sha256 !== expectedManifestSha256) fail("manifest SHA-256 differs from the request binding.");
  const raw = manifestSnapshot.value;
  exact(raw,
    new Set(["kind", "version", "batch", "reimbursementSources", "salaryArtifacts", "vouchers", "rows", "expected"]),
    new Set(), "manifest");
  if (raw.kind !== DISBURSEMENT_MANIFEST_KIND || raw.version !== 1) fail("manifest kind/version is invalid.");

  exact(raw.batch,
    new Set(["batchId", "archiveParentPath", "nameRevision"]),
    new Set(["reimbursementPeriod"]), "batch");
  const batchId = id(raw.batch.batchId, "batch.batchId");
  const archiveParentPath = absolutePath(raw.batch.archiveParentPath, "batch.archiveParentPath");
  if (!Number.isSafeInteger(raw.batch.nameRevision) || raw.batch.nameRevision < 1) fail("batch.nameRevision must be a positive safe integer.");
  let reimbursementPeriod;
  if (raw.batch.reimbursementPeriod !== undefined) {
    exact(raw.batch.reimbursementPeriod, new Set(["start", "end"]), new Set(), "batch.reimbursementPeriod");
    reimbursementPeriod = Object.freeze({
      start: normalizeDisbursementIsoDate(raw.batch.reimbursementPeriod.start, "batch.reimbursementPeriod.start"),
      end: normalizeDisbursementIsoDate(raw.batch.reimbursementPeriod.end, "batch.reimbursementPeriod.end"),
    });
  }

  const registry = await loadProfileRegistry();
  const reimbursementSources = [];
  const sourceById = new Map();
  const reimbursementCertificateDigests = new Set();
  const reimbursementBatchProfileKeys = new Set();
  const reimbursementManifestProfileKeys = new Set();
  for (const [index, entry] of array(raw.reimbursementSources, "reimbursementSources").entries()) {
    const field = `reimbursementSources[${index}]`;
    exact(entry, new Set(["id", "profileId", "originalManifestPath", "originalManifestSha256", "publishReceiptPath", "publishReceiptSha256"]), new Set(), field);
    const sourceId = id(entry.id, `${field}.id`);
    if (sourceById.has(sourceId)) fail(`${field}.id is duplicated.`);
    const profileId = id(entry.profileId, `${field}.profileId`);
    if (!PROFILE_SET.has(profileId)) fail(`${field}.profileId is not canonical.`);
    const sourceInput = Object.freeze({
      sourceId,
      profileId,
      originalManifestPath: absolutePath(entry.originalManifestPath, `${field}.originalManifestPath`),
      originalManifestSha256: sha(entry.originalManifestSha256, `${field}.originalManifestSha256`),
      publishReceiptPath: absolutePath(entry.publishReceiptPath, `${field}.publishReceiptPath`),
      publishReceiptSha256: sha(entry.publishReceiptSha256, `${field}.publishReceiptSha256`),
    });
    const verifiedPublishedSource = await derivePublishedReimbursementSource(sourceInput, field, registry);
    const certificate = verifiedPublishedSource.certificate;
    const batchProfileKey = `${certificate.batchId}\u0000${profileId}`;
    const manifestProfileKey = `${process.platform === "win32" ? certificate.originalManifestPath.toLowerCase() : certificate.originalManifestPath}\u0000${profileId}`;
    if (reimbursementCertificateDigests.has(certificate.certificateDigest)) fail(`${field} duplicates a reimbursement facts certificate.`);
    if (reimbursementBatchProfileKeys.has(batchProfileKey)) fail(`${field} duplicates a reimbursement batch/profile source.`);
    if (reimbursementManifestProfileKeys.has(manifestProfileKey)) fail(`${field} duplicates an original reimbursement manifest/profile source.`);
    reimbursementCertificateDigests.add(certificate.certificateDigest);
    reimbursementBatchProfileKeys.add(batchProfileKey);
    reimbursementManifestProfileKeys.add(manifestProfileKey);
    const normalized = Object.freeze({ ...sourceInput, certificate, verifiedPublishedSource });
    reimbursementSources.push(normalized);
    sourceById.set(sourceId, normalized);
  }
  if (reimbursementSources.length > 0) {
    if (!reimbursementPeriod) fail("batch.reimbursementPeriod is required when reimbursement sources are present.");
    if (reimbursementPeriod.start > reimbursementPeriod.end) fail("batch.reimbursementPeriod.start must not be after end.");
    for (const source of reimbursementSources) {
      const sourcePeriod = source.verifiedPublishedSource.manifestAudit.batch?.mainPeriod;
      if (!sourcePeriod || canonicalDigest(sourcePeriod) !== canonicalDigest(reimbursementPeriod)) {
        fail(`${source.sourceId} original reimbursement mainPeriod differs from batch.reimbursementPeriod.`);
      }
    }
  } else if (reimbursementPeriod) {
    fail("batch.reimbursementPeriod must be omitted when no reimbursement source is present.");
  }

  const salaryArtifacts = [];
  const salaryById = new Map();
  const salarySlotKeys = new Set();
  const salaryArtifactDigests = new Set();
  const salaryCertificateDigests = new Set();
  for (const [index, entry] of array(raw.salaryArtifacts, "salaryArtifacts").entries()) {
    const field = `salaryArtifacts[${index}]`;
    exact(entry,
      new Set(["id", "month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "path", "sha256", "storeReference", "certificatePath", "certificateSha256"]),
      new Set(), field);
    const artifactId = id(entry.id, `${field}.id`);
    if (salaryById.has(artifactId)) fail(`${field}.id is duplicated.`);
    const month = normalizeSalaryMonth(entry.month, `${field}.month`);
    const salaryCategoryId = id(entry.salaryCategoryId, `${field}.salaryCategoryId`);
    const salaryCategoryName = text(entry.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 });
    const finalArtifactKind = text(entry.finalArtifactKind, `${field}.finalArtifactKind`, { maxLength: 20 });
    if (!new Set(["workbook", "image"]).has(finalArtifactKind)) fail(`${field}.finalArtifactKind is invalid.`);
    const artifactPath = absolutePath(entry.path, `${field}.path`);
    const artifactSha256 = sha(entry.sha256, `${field}.sha256`);
    const storeReference = canonicalRelativeReference(entry.storeReference, `${field}.storeReference`);
    const certificatePath = absolutePath(entry.certificatePath, `${field}.certificatePath`);
    const certificateSha256 = sha(entry.certificateSha256, `${field}.certificateSha256`);
    const slotKey = `${month}\u0000${salaryCategoryId.toLowerCase()}`;
    if (salarySlotKeys.has(slotKey)) fail(`${field} duplicates a salary month/category slot.`);
    salarySlotKeys.add(slotKey);
    const certificateSnapshot = await readBoundJson(certificatePath, certificateSha256, `${field}.certificate`);
    const certificate = validateSalaryCertificate(certificateSnapshot.value, `${field}.certificate`);
    const compared = { month, salaryCategoryId, salaryCategoryName, finalArtifactKind, artifactSha256, storeReference };
    for (const [key, value] of Object.entries(compared)) if (certificate[key] !== value) fail(`${field}.${key} differs from its certificate.`);
    if (salaryArtifactDigests.has(artifactSha256)) fail(`${field} reuses one final salary artifact in multiple slots.`);
    if (salaryCertificateDigests.has(certificate.certificateDigest)) fail(`${field} reuses one salary certificate in multiple slots.`);
    salaryArtifactDigests.add(artifactSha256);
    salaryCertificateDigests.add(certificate.certificateDigest);
    const validated = await validateBoundBinary(artifactPath, artifactSha256, `${field}.artifact`, { salaryKind: finalArtifactKind });
    const normalized = Object.freeze({
      artifactId,
      month,
      salaryCategoryId,
      salaryCategoryName,
      finalArtifactKind,
      artifactPath,
      artifactSha256,
      artifactSize: validated.stable.size,
      storeReference,
      certificatePath,
      certificateSha256,
      certificate,
    });
    salaryArtifacts.push(normalized);
    salaryById.set(artifactId, normalized);
  }

  const voucherEntries = [];
  const voucherById = new Map();
  const voucherReadJobs = new Map();
  for (const [index, entry] of array(raw.vouchers, "vouchers").entries()) {
    const field = `vouchers[${index}]`;
    exact(entry, new Set(["id", "path", "sha256"]), new Set(), field);
    const voucherId = id(entry.id, `${field}.id`);
    if (voucherById.has(voucherId)) fail(`${field}.id is duplicated.`);
    const voucherPath = absolutePath(entry.path, `${field}.path`);
    const voucherSha256 = sha(entry.sha256, `${field}.sha256`);
    const normalized = { voucherId, voucherPath, voucherSha256, field };
    voucherEntries.push(normalized);
    voucherById.set(voucherId, normalized);
    const readKey = `${process.platform === "win32" ? voucherPath.toLowerCase() : voucherPath}\u0000${voucherSha256}`;
    if (!voucherReadJobs.has(readKey)) voucherReadJobs.set(readKey, normalized);
  }
  const readJobs = [...voucherReadJobs.entries()];
  const settled = await mapSettledLimit(readJobs, 4, async ([readKey, entry]) => ({
    readKey,
    validated: await validateBoundBinary(entry.voucherPath, entry.voucherSha256, `${entry.field}.voucher`),
  }));
  const voucherRuntimeByReadKey = new Map(settled.settled.map((item) => [item.value.readKey, item.value.validated]));
  for (const entry of voucherEntries) {
    const readKey = `${process.platform === "win32" ? entry.voucherPath.toLowerCase() : entry.voucherPath}\u0000${entry.voucherSha256}`;
    entry.validated = voucherRuntimeByReadKey.get(readKey);
  }

  const referencedTransactionKeys = new Set();
  const allTransactionKeys = new Set();
  const transactionByKey = new Map();
  for (const source of reimbursementSources) {
    for (const transaction of source.certificate.transactions) {
      const key = `${source.sourceId}\u0000${transaction.id}`;
      allTransactionKeys.add(key);
      transactionByKey.set(key, { source, transaction });
    }
  }
  const usedSalaryArtifactIds = new Set();
  const salaryTotalsById = new Map(salaryArtifacts.map((entry) => [entry.artifactId, 0n]));
  const referencedVoucherIds = new Set();
  const voucherRowReferences = new Map(voucherEntries.map((entry) => [entry.voucherId, []]));
  const normalizedRows = [];
  const rowIds = new Set();
  const orders = new Set();

  for (const [index, rawRow] of array(raw.rows, "rows").entries()) {
    const field = `rows[${index}]`;
    exact(rawRow,
      new Set(["id", "order", "subject", "scopeStatus", "payoutStatus", "paymentMethod", "adjustmentKind", "amounts", "paidAmount", "reimbursementRefs", "voucherRefs"]),
      new Set(["salaryArtifactId", "note", "reason", "followUp", "targetBatch", "retentionProof", "adjustment"]), field);
    const rowId = id(rawRow.id, `${field}.id`);
    if (rowIds.has(rowId)) fail(`${field}.id is duplicated.`);
    rowIds.add(rowId);
    if (!Number.isSafeInteger(rawRow.order) || rawRow.order < 1) fail(`${field}.order must be a positive safe integer.`);
    if (orders.has(rawRow.order)) fail(`${field}.order is duplicated.`);
    orders.add(rawRow.order);
    const subject = text(rawRow.subject, `${field}.subject`, { maxLength: 200 });
    const parsedAmounts = normalizeRowAmounts(rawRow.amounts, `${field}.amounts`);
    const paidAmount = parseDisbursementAmount(rawRow.paidAmount, `${field}.paidAmount`, { allowNegative: true });

    const voucherRefs = array(rawRow.voucherRefs, `${field}.voucherRefs`).map((value, refIndex) => id(value, `${field}.voucherRefs[${refIndex}]`));
    if (new Set(voucherRefs).size !== voucherRefs.length) fail(`${field}.voucherRefs must not contain duplicates.`);
    for (const [refIndex, voucherId] of voucherRefs.entries()) {
      if (!voucherById.has(voucherId)) fail(`${field}.voucherRefs[${refIndex}] is unknown.`);
      referencedVoucherIds.add(voucherId);
      voucherRowReferences.get(voucherId).push(Object.freeze({ rowId, order: rawRow.order, referenceIndex: refIndex }));
    }

    if (rawRow.retentionProof !== undefined) {
      exact(rawRow.retentionProof, new Set(["fundsReceivedVoucherRefs", "decisionVoucherRefs"]), new Set(), `${field}.retentionProof`);
    }
    if (rawRow.adjustment !== undefined) {
      exact(rawRow.adjustment, new Set(["amount", "sourceRowId", "reason", "tolerance", "authorization"]), new Set(), `${field}.adjustment`);
    }
    const visibleStatus = resolveVisibleDisbursementStatus(rawRow, {
      amounts: parsedAmounts.milliunits,
      paidAmount,
      voucherRefs,
    });
    if (rawRow.payoutStatus !== "retained_by_self" && rawRow.retentionProof !== undefined) fail(`${field}.retentionProof is only valid for retained_by_self.`);
    if (rawRow.adjustmentKind !== "rounding_tail" && rawRow.adjustment !== undefined) fail(`${field}.adjustment is only valid for rounding_tail.`);

    const reimbursementRefs = array(rawRow.reimbursementRefs, `${field}.reimbursementRefs`).map((entry, refIndex) => {
      const refField = `${field}.reimbursementRefs[${refIndex}]`;
      exact(entry, new Set(["sourceId", "transactionId", "amount"]), new Set(), refField);
      const sourceId = id(entry.sourceId, `${refField}.sourceId`);
      const transactionId = id(entry.transactionId, `${refField}.transactionId`);
      const key = `${sourceId}\u0000${transactionId}`;
      const bound = transactionByKey.get(key);
      if (!bound) fail(`${refField} does not identify a bound reimbursement transaction.`);
      if (referencedTransactionKeys.has(key)) fail(`${refField} duplicates a reimbursement transaction already assigned to a row.`);
      const amount = parseDisbursementAmount(entry.amount, `${refField}.amount`, { allowNegative: true });
      if (formatDisbursementAmount(amount) !== bound.transaction.reimbursementAmount) fail(`${refField}.amount differs from the reimbursement certificate.`);
      if (bound.transaction.person !== subject) fail(`${refField} person differs from the row subject.`);
      referencedTransactionKeys.add(key);
      return Object.freeze({ sourceId, transactionId, profileId: bound.source.profileId, amount: formatDisbursementAmount(amount) });
    });
    const referenceTotals = Object.fromEntries(DISBURSEMENT_PROFILE_ORDER.map((profileId) => [profileId, 0n]));
    for (const reference of reimbursementRefs) referenceTotals[reference.profileId] += parseDisbursementAmount(reference.amount, `${field}.reimbursementRefs.amount`, { allowNegative: true });
    for (const profileId of DISBURSEMENT_PROFILE_ORDER) {
      if (referenceTotals[profileId] !== parsedAmounts.milliunits[profileId]) fail(`${field}.amounts.${profileId} does not equal its reimbursement references.`);
    }
    const reimbursementSigns = new Set(reimbursementRefs
      .map((reference) => parseDisbursementAmount(reference.amount, `${field}.reimbursementRefs.amount`, { allowNegative: true }))
      .filter((amount) => amount !== 0n)
      .map((amount) => amount < 0n ? "negative" : "positive"));
    if (reimbursementSigns.size > 1) fail(`${field} must split reimbursements and refunds into separate signed rows.`);
    if (reimbursementSigns.has("negative")) {
      if (parsedAmounts.milliunits.salary !== 0n || DISBURSEMENT_PROFILE_ORDER.some((profileId) => parsedAmounts.milliunits[profileId] > 0n)) {
        fail(`${field} refund row must contain only negative reimbursement amounts and no salary.`);
      }
      if (paidAmount > 0n) fail(`${field} refund row actual payout must not be positive.`);
    }

    let salaryArtifactId;
    if (parsedAmounts.milliunits.salary > 0n) {
      salaryArtifactId = id(rawRow.salaryArtifactId, `${field}.salaryArtifactId`);
      if (!salaryById.has(salaryArtifactId)) fail(`${field}.salaryArtifactId is unknown.`);
      usedSalaryArtifactIds.add(salaryArtifactId);
      salaryTotalsById.set(salaryArtifactId, salaryTotalsById.get(salaryArtifactId) + parsedAmounts.milliunits.salary);
    } else if (rawRow.salaryArtifactId !== undefined) {
      fail(`${field}.salaryArtifactId must be omitted when salary is zero.`);
    }

    const adjustment = rawRow.adjustment === undefined ? undefined : Object.freeze({
      amount: normalizeExpectedAmount(rawRow.adjustment.amount, `${field}.adjustment.amount`, { allowNegative: true }),
      sourceRowId: id(rawRow.adjustment.sourceRowId, `${field}.adjustment.sourceRowId`),
      reason: text(rawRow.adjustment.reason, `${field}.adjustment.reason`, { maxLength: 500 }),
      tolerance: normalizeExpectedAmount(rawRow.adjustment.tolerance, `${field}.adjustment.tolerance`),
      authorization: text(rawRow.adjustment.authorization, `${field}.adjustment.authorization`, { maxLength: 500 }),
    });
    const normalized = Object.freeze({
      id: rowId,
      order: rawRow.order,
      subject,
      scopeStatus: rawRow.scopeStatus,
      payoutStatus: rawRow.payoutStatus,
      paymentMethod: rawRow.paymentMethod,
      paymentMethodDisplay: paymentMethodDisplay(rawRow),
      adjustmentKind: rawRow.adjustmentKind,
      amounts: parsedAmounts.canonical,
      payableAmount: formatDisbursementAmount(parsedAmounts.total),
      paidAmount: formatDisbursementAmount(paidAmount),
      reimbursementRefs,
      ...(salaryArtifactId ? { salaryArtifactId } : {}),
      voucherRefs: Object.freeze(voucherRefs),
      visibleStatus,
      ...(rawRow.note === undefined ? {} : { note: optionalText(rawRow.note, `${field}.note`, { maxLength: 500 }) }),
      ...(rawRow.reason === undefined ? {} : { reason: optionalText(rawRow.reason, `${field}.reason`, { maxLength: 500 }) }),
      ...(rawRow.followUp === undefined ? {} : { followUp: optionalText(rawRow.followUp, `${field}.followUp`, { maxLength: 500 }) }),
      ...(rawRow.targetBatch === undefined ? {} : { targetBatch: optionalText(rawRow.targetBatch, `${field}.targetBatch`, { maxLength: 500 }) }),
      ...(rawRow.retentionProof === undefined ? {} : { retentionProof: structuredClone(rawRow.retentionProof) }),
      ...(adjustment === undefined ? {} : { adjustment }),
    });
    normalizedRows.push(normalized);
  }

  if (normalizedRows.length === 0) fail("rows must not be empty.");
  normalizedRows.sort((left, right) => left.order - right.order);
  if (normalizedRows.some((row, index) => row.order !== index + 1)) fail("row order must be contiguous from 1.");
  const normalizedRowById = new Map(normalizedRows.map((row) => [row.id, row]));
  const roundingTailBySourceRowId = new Map();
  for (const row of normalizedRows) {
    if (row.adjustmentKind !== "rounding_tail") continue;
    const sourceRow = normalizedRowById.get(row.adjustment.sourceRowId);
    if (!sourceRow) fail(`${row.id} rounding-tail sourceRowId does not identify a row in this batch.`);
    if (sourceRow.id === row.id || sourceRow.adjustmentKind !== "none") {
      fail(`${row.id} rounding-tail sourceRowId must identify a different ordinary row.`);
    }
    const existingTail = roundingTailBySourceRowId.get(sourceRow.id);
    if (existingTail) {
      fail(`${row.id} rounding-tail sourceRowId ${sourceRow.id} is already bound by ${existingTail.id}; one ordinary row may bind at most one rounding-tail row.`);
    }
    roundingTailBySourceRowId.set(sourceRow.id, row);
  }
  const missingTransactions = [...allTransactionKeys].filter((key) => !referencedTransactionKeys.has(key));
  if (missingTransactions.length) fail(`reimbursement certificate transactions are missing from rows: ${missingTransactions.join(", ")}.`);
  const unusedVouchers = voucherEntries.filter((entry) => !referencedVoucherIds.has(entry.voucherId));
  if (unusedVouchers.length) fail(`vouchers are unbound to rows: ${unusedVouchers.map((entry) => entry.voucherId).join(", ")}.`);
  const unusedSalary = salaryArtifacts.filter((entry) => !usedSalaryArtifactIds.has(entry.artifactId));
  if (unusedSalary.length) fail(`salary artifacts are unbound to rows: ${unusedSalary.map((entry) => entry.artifactId).join(", ")}.`);
  for (const artifact of salaryArtifacts) {
    const actual = salaryTotalsById.get(artifact.artifactId);
    const expected = parseDisbursementAmount(artifact.certificate.grossPayTotal, `${artifact.artifactId}.grossPayTotal`);
    if (actual !== expected) fail(`${artifact.artifactId} salary rows do not equal the final-artifact grossPayTotal.`);
  }

  const inBatchNormalRows = normalizedRows.filter((row) => row.scopeStatus === "in_batch" && row.adjustmentKind === "none");
  const inBatchDueTotal = inBatchNormalRows.reduce((sum, row) => sum + parseDisbursementAmount(row.payableAmount, `${row.id}.payableAmount`, { allowNegative: true }), 0n);
  const inBatchPaidTotal = inBatchNormalRows.reduce((sum, row) => sum + parseDisbursementAmount(row.paidAmount, `${row.id}.paidAmount`, { allowNegative: true }), 0n);
  const reconciledTotal = inBatchNormalRows
    .filter((row) => row.visibleStatus === "已核销")
    .reduce((sum, row) => sum + parseDisbursementAmount(row.paidAmount, `${row.id}.paidAmount`, { allowNegative: true }), 0n);
  const roundingTailTotal = normalizedRows
    .filter((row) => row.adjustmentKind === "rounding_tail")
    .reduce((sum, row) => sum + parseDisbursementAmount(row.adjustment.amount, `${row.id}.adjustment.amount`, { allowNegative: true }), 0n);

  const activeProfileIds = DISBURSEMENT_PROFILE_ORDER.filter((profileId) => inBatchNormalRows.some((row) => parseDisbursementAmount(row.amounts[profileId], `${row.id}.amounts.${profileId}`, { allowNegative: true }) !== 0n));
  const activeSalaryMonths = sortedUnique(inBatchNormalRows
    .filter((row) => parseDisbursementAmount(row.amounts.salary, `${row.id}.amounts.salary`) > 0n)
    .map((row) => salaryById.get(row.salaryArtifactId).month));
  if (activeSalaryMonths.length > 1) fail("one compact disbursement batch may contain only one salary month; split multiple months.");
  const salaryMonth = activeSalaryMonths[0] ?? null;
  const batchName = buildCompactDisbursementBatchName({
    reimbursementPeriod,
    profileIds: activeProfileIds,
    salaryMonth,
    nameRevision: raw.batch.nameRevision,
  });

  const voucherDigestsInReferenceOrder = [];
  const seenVoucherDigests = new Set();
  for (const row of normalizedRows) {
    for (const voucherId of row.voucherRefs) {
      const digest = voucherById.get(voucherId).voucherSha256;
      if (!seenVoucherDigests.has(digest)) {
        seenVoucherDigests.add(digest);
        voucherDigestsInReferenceOrder.push(digest);
      }
    }
  }
  const voucherArchive = voucherDigestsInReferenceOrder.map((digest, index) => {
    const entries = voucherEntries.filter((entry) => entry.voucherSha256 === digest);
    const canonical = entries[0].validated;
    if (entries.some((entry) => entry.validated.signature.kind !== canonical.signature.kind)) fail(`voucher digest ${digest} has conflicting media kinds.`);
    const sourceIds = entries.map((entry) => entry.voucherId).sort();
    const rowReferences = sourceIds.flatMap((voucherId) => voucherRowReferences.get(voucherId)).sort((left, right) => left.order - right.order || left.referenceIndex - right.referenceIndex);
    return Object.freeze({
      sha256: digest,
      size: canonical.stable.size,
      mediaKind: canonical.signature.kind,
      archiveName: `${String(index + 1).padStart(3, "0")}_${digest.slice(0, 12)}${canonical.signature.extension}`,
      sourceIds: Object.freeze(sourceIds),
      rowReferences: Object.freeze(rowReferences),
    });
  });
  const voucherArchiveNameById = Object.fromEntries(voucherArchive.flatMap((entry) => entry.sourceIds.map((voucherId) => [voucherId, entry.archiveName])));
  const rowsWithVoucherNames = normalizedRows.map((row) => Object.freeze({
    ...row,
    voucherArchiveNames: Object.freeze(row.voucherRefs.map((voucherId) => voucherArchiveNameById[voucherId])),
    ...(row.salaryArtifactId ? { salaryCategoryName: salaryById.get(row.salaryArtifactId).salaryCategoryName } : {}),
  }));
  const closureStatus = deriveClosureStatus(rowsWithVoucherNames);

  exact(raw.expected,
    new Set(["rowCount", "inBatchDueTotal", "inBatchPaidTotal", "reconciledTotal", "uniqueVoucherCount", "voucherReferenceCount", "roundingTailTotal", "salarySlotCount"]),
    new Set(), "expected");
  if (!Number.isSafeInteger(raw.expected.rowCount) || raw.expected.rowCount !== rowsWithVoucherNames.length) fail("expected.rowCount does not close.");
  const expectedIntegerFields = {
    uniqueVoucherCount: voucherArchive.length,
    voucherReferenceCount: rowsWithVoucherNames.reduce((sum, row) => sum + row.voucherRefs.length, 0),
    salarySlotCount: salaryArtifacts.length,
  };
  for (const [key, value] of Object.entries(expectedIntegerFields)) {
    if (!Number.isSafeInteger(raw.expected[key]) || raw.expected[key] !== value) fail(`expected.${key} does not close.`);
  }
  const expectedAmounts = {
    inBatchDueTotal: formatDisbursementAmount(inBatchDueTotal),
    inBatchPaidTotal: formatDisbursementAmount(inBatchPaidTotal),
    reconciledTotal: formatDisbursementAmount(reconciledTotal),
    roundingTailTotal: formatDisbursementAmount(roundingTailTotal),
  };
  for (const [key, actual] of Object.entries(expectedAmounts)) {
    const normalizedExpected = normalizeExpectedAmount(raw.expected[key], `expected.${key}`, { allowNegative: true });
    if (normalizedExpected !== actual) fail(`expected.${key} does not close.`);
  }

  const normalizedSalary = salaryArtifacts.map((entry) => Object.freeze({
    artifactId: entry.artifactId,
    month: entry.month,
    salaryCategoryId: entry.salaryCategoryId,
    salaryCategoryName: entry.salaryCategoryName,
    finalArtifactKind: entry.finalArtifactKind,
    artifactPath: entry.artifactPath,
    artifactSha256: entry.artifactSha256,
    artifactSize: entry.artifactSize,
    storeReference: entry.storeReference,
    certificatePath: entry.certificatePath,
    certificateSha256: entry.certificateSha256,
    certificateDigest: entry.certificate.certificateDigest,
    grossPayTotal: entry.certificate.grossPayTotal,
  }));
  const normalizedReimbursement = reimbursementSources.map((entry) => Object.freeze({
    sourceId: entry.sourceId,
    profileId: entry.profileId,
    certificateDigest: entry.certificate.certificateDigest,
    factsCertificate: entry.certificate,
  }));
  const totals = Object.freeze({ ...expectedAmounts, ...expectedIntegerFields, rowCount: rowsWithVoucherNames.length });
  const factsCore = {
    batchId,
    batchName,
    activeProfileIds,
    salaryMonth,
    rows: rowsWithVoucherNames,
    totals,
    closureStatus,
  };
  const sourceBindingCore = {
    manifestSha256: expectedManifestSha256,
    reimbursementSources: normalizedReimbursement,
    salaryArtifacts: normalizedSalary,
    vouchers: voucherArchive.map((entry) => ({ sha256: entry.sha256, size: entry.size, archiveName: entry.archiveName, sourceIds: entry.sourceIds, rowReferences: entry.rowReferences })),
  };
  const result = {
    kind: DISBURSEMENT_AUDIT_KIND,
    manifest: Object.freeze({ path: resolvedManifestPath, sha256: expectedManifestSha256, size: manifestSnapshot.size }),
    batch: Object.freeze({
      batchId,
      archiveParentPath,
      nameRevision: raw.batch.nameRevision,
      ...(reimbursementPeriod ? { reimbursementPeriod } : {}),
      activeProfileIds: Object.freeze(activeProfileIds),
      salaryMonth,
      batchName,
      finalArchivePath: path.join(archiveParentPath, batchName),
    }),
    reimbursementSources: Object.freeze(normalizedReimbursement),
    salaryArtifacts: Object.freeze(normalizedSalary),
    voucherArchive: Object.freeze(voucherArchive),
    rows: Object.freeze(rowsWithVoucherNames),
    totals,
    closureStatus,
    factsDigest: canonicalDigest(factsCore),
    sourceBindingDigest: canonicalDigest(sourceBindingCore),
  };
  const bytesByDigest = new Map();
  for (const entry of voucherEntries) {
    if (!bytesByDigest.has(entry.voucherSha256)) bytesByDigest.set(entry.voucherSha256, Buffer.from(entry.validated.bytes));
  }
  const boundSourcePathMap = new Map();
  const addBoundSourcePath = (filePath) => {
    const resolved = path.resolve(filePath);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!boundSourcePathMap.has(key)) boundSourcePathMap.set(key, resolved);
  };
  addBoundSourcePath(resolvedManifestPath);
  for (const entry of reimbursementSources) {
    addBoundSourcePath(entry.originalManifestPath);
    addBoundSourcePath(entry.publishReceiptPath);
    for (const filePath of entry.verifiedPublishedSource.originalManifestFilePaths) addBoundSourcePath(filePath);
    for (const binding of entry.verifiedPublishedSource.artifactBindings) addBoundSourcePath(binding.path);
  }
  for (const entry of salaryArtifacts) {
    addBoundSourcePath(entry.artifactPath);
    addBoundSourcePath(entry.certificatePath);
  }
  for (const entry of voucherEntries) addBoundSourcePath(entry.voucherPath);
  const boundSourcePaths = Object.freeze([...boundSourcePathMap.values()].sort((left, right) => left.localeCompare(right)));
  Object.defineProperty(result, "runtime", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ voucherBytesBySha256: bytesByDigest, boundSourcePaths }),
    writable: false,
  });
  return Object.freeze(result);
}
