import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

import {
  assertXml10Text,
  formatDisbursementAmount,
  parseDisbursementAmount,
} from "./disbursement_domain.mjs";
import { validateCompletePdfBytes } from "./disbursement_manifest.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  inspectFullyDecodedImageBytes,
  parseStrictJson,
  readStableBinaryFile,
  readStableUtf8JsonFile,
} from "./workflow_primitives.mjs";
import { readWorkbookOoxmlFacts } from "./workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "./workbook_snapshot.mjs";

export const DISBURSEMENT_FRESH_SOURCE_AUDIT_V2_KIND = "disbursement-fresh-source-audit-v2";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const DATE_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const MONTH_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/u;
const PROFILE_IDS = new Set(["xiaohongshu", "company", "residence"]);
const FILE_KINDS = new Set(["json", "text", "workbook", "image", "pdf"]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ORDINARY_MANIFEST_AUDITOR = path.join(SCRIPT_DIR, "audit_batch_manifest.mjs");
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`Disbursement Fresh Source v2 ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  if (nonEmpty && value.length === 0) fail(`${field} must not be empty.`);
  return value;
}

function exact(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function text(value, field, { maxLength = 500 } = {}) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value
    || value.length > maxLength
    || /[\r\n\t]/u.test(value)
  ) fail(`${field} must be a trimmed non-empty single-line string of at most ${maxLength} characters.`);
  return assertXml10Text(value, field);
}

function identifier(value, field) {
  const result = text(value, field, { maxLength: 96 });
  if (!ID_RE.test(result)) fail(`${field} must use a safe ASCII identifier.`);
  return result;
}

function digest(value, field) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function absolutePath(value, field) {
  const result = text(value, field, { maxLength: 32_000 });
  if (!path.isAbsolute(result)) fail(`${field} must be absolute.`);
  return path.resolve(result);
}

function relativeReference(value, field) {
  const result = text(value, field, { maxLength: 1_000 });
  if (path.isAbsolute(result) || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${field} must be a safe forward-slash relative reference.`);
  }
  return result;
}

function isoDate(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${field} is missing a valid date business fact.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${field} is missing a real calendar-date business fact.`);
  }
  return value;
}

function salaryMonth(value, field) {
  if (typeof value !== "string" || !MONTH_RE.test(value)) fail(`${field} is missing a valid salary month business fact.`);
  return value;
}

function amount(value, field, { allowNegative = false } = {}) {
  try {
    return formatDisbursementAmount(parseDisbursementAmount(value, field, { allowNegative }));
  } catch (error) {
    fail(`${field} is missing a valid ${allowNegative ? "signed " : ""}amount business fact: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function uniqueIds(values, field, { nonEmpty = false } = {}) {
  const normalized = array(values, field, { nonEmpty }).map((value, index) => identifier(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${field} must not contain duplicate file references.`);
  return normalized;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value) => new Set(right).has(value));
}

function bindingDifference(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((value) => !actualSet.has(value)),
    extra: actual.filter((value) => !expectedSet.has(value)),
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function binarySignature(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "image", imageKind: "png" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return { kind: "image", imageKind: "jpeg" };
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { kind: "pdf" };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { kind: "workbook" };
  }
  return null;
}

async function validateImage(bytes, field) {
  const signature = binarySignature(bytes);
  if (signature?.kind !== "image") fail(`${field} declared kind image but its magic bytes are not PNG or JPEG.`);
  let validationBytes = bytes;
  let repairedMissingJpegEoi = false;
  if (signature.imageKind === "jpeg" && !(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)) {
    validationBytes = Buffer.concat([bytes, Buffer.from([0xff, 0xd9])]);
    repairedMissingJpegEoi = true;
  }
  try {
    const decoded = await inspectFullyDecodedImageBytes(validationBytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      autoOrient: true,
    });
    if (
      !Number.isSafeInteger(decoded.width)
      || !Number.isSafeInteger(decoded.height)
      || decoded.width < 1
      || decoded.height < 1
    ) fail(`${field} image dimensions are invalid.`);
    return {
      mode: "full-pixel-decode",
      imageKind: signature.imageKind,
      width: decoded.width,
      height: decoded.height,
      repairedMissingJpegEoi,
    };
  } catch (error) {
    fail(`${field} image is damaged or incompletely decodable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeSourceFiles(sourceFiles) {
  const fileById = new Map();
  const fileByPath = new Map();
  const kindByDigest = new Map();
  for (const [index, raw] of array(sourceFiles, "sourceFiles", { nonEmpty: true }).entries()) {
    const field = `sourceFiles[${index}]`;
    const fileId = identifier(raw?.id, `${field}.id`);
    if (fileById.has(fileId)) fail(`${field}.id is duplicated.`);
    const filePath = absolutePath(raw?.path, `${field}.path`);
    const fileDigest = digest(raw?.sha256, `${field}.sha256`);
    const kind = text(raw?.kind, `${field}.kind`, { maxLength: 20 });
    if (!FILE_KINDS.has(kind)) fail(`${field}.kind is not supported.`);
    const usage = array(raw?.usage, `${field}.usage`, { nonEmpty: true }).map((value, usageIndex) => text(value, `${field}.usage[${usageIndex}]`, { maxLength: 100 }));
    if (new Set(usage).size !== usage.length) fail(`${field}.usage contains duplicates.`);
    const identity = pathIdentity(filePath);
    if (fileByPath.has(identity)) fail(`${field}.path duplicates another source file path.`);
    const previousKind = kindByDigest.get(fileDigest);
    if (previousKind && previousKind !== kind) fail(`${field}.kind conflicts with the kind declared for the same digest.`);
    const normalized = { id: fileId, path: filePath, sha256: fileDigest, kind, usage };
    fileById.set(fileId, normalized);
    fileByPath.set(identity, normalized);
    kindByDigest.set(fileDigest, kind);
  }
  return fileById;
}

function requireFile(fileById, fileId, field, { usage, kind } = {}) {
  const checkedId = identifier(fileId, field);
  const file = fileById.get(checkedId);
  if (!file) fail(`${field} references unknown source file ${checkedId}.`);
  if (usage && !file.usage.includes(usage)) fail(`${field} must reference usage ${usage}.`);
  if (kind && file.kind !== kind) fail(`${field} must reference declared kind ${kind}, not ${file.kind}.`);
  return file;
}

function createFileReader(fileById) {
  const cache = new Map();
  return async function readFile(fileId, field) {
    const file = requireFile(fileById, fileId, field);
    if (cache.has(file.id)) return cache.get(file.id);
    const pending = (async () => {
      let size;
      let verification;
      let jsonValue;
      if (file.kind === "workbook") {
        let snapshot;
        let facts;
        try {
          snapshot = await readStableFileSnapshot(file.path, {
            budgets: { packageCompressedBytes: MAX_WORKBOOK_BYTES },
          });
          if (snapshot.sha256 !== file.sha256) fail(`${field} SHA-256 differs from its sourceFiles binding.`);
          facts = await readWorkbookOoxmlFacts(snapshot);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Disbursement Fresh Source v2 ")) throw error;
          fail(`${field} workbook safety validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        size = snapshot.size;
        verification = {
          mode: "safe-ooxml-structure",
          factsDigest: facts.factsDigest,
          sheetCount: facts.workbook.sheets.length,
          worksheetCount: facts.worksheets.length,
          cellCount: facts.worksheets.reduce((sum, worksheet) => sum + worksheet.rows.reduce((rowSum, row) => rowSum + row.cells.length, 0), 0),
        };
      } else if (file.kind === "json") {
        let snapshot;
        try {
          snapshot = await readStableUtf8JsonFile(file.path, { maxBytes: MAX_JSON_BYTES });
        } catch (error) {
          fail(`${field} JSON safety validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (snapshot.sha256 !== file.sha256) fail(`${field} SHA-256 differs from its sourceFiles binding.`);
        size = snapshot.size;
        jsonValue = snapshot.value;
        verification = { mode: "strict-utf8-json" };
      } else {
        let snapshot;
        try {
          snapshot = await readStableBinaryFile(file.path, { maxBytes: MAX_EVIDENCE_BYTES });
        } catch (error) {
          fail(`${field} stable file read failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (snapshot.sha256 !== file.sha256) fail(`${field} SHA-256 differs from its sourceFiles binding.`);
        const bytes = copyStableBinaryBytes(snapshot);
        size = snapshot.size;
        if (file.kind === "text") {
          const disguised = binarySignature(bytes);
          if (disguised) fail(`${field} declared kind text but its magic bytes identify ${disguised.kind}.`);
          let decoded;
          try {
            decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
          } catch (error) {
            fail(`${field} text evidence is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!decoded.trim()) fail(`${field} text evidence contains no reviewable material.`);
          assertXml10Text(decoded, field);
          verification = { mode: "strict-utf8-text", characterCount: decoded.length };
        } else if (file.kind === "image") {
          verification = await validateImage(bytes, field);
        } else if (file.kind === "pdf") {
          if (binarySignature(bytes)?.kind !== "pdf") fail(`${field} declared kind pdf but its magic bytes do not identify PDF.`);
          const parsed = await validateCompletePdfBytes(bytes, field);
          verification = { mode: "complete-pdf-parse", ...parsed };
        }
      }
      const binding = Object.freeze({
        fileId: file.id,
        path: file.path,
        sha256: file.sha256,
        size,
        kind: file.kind,
        usage: Object.freeze([...file.usage]),
        verification: deepFreeze(verification),
      });
      return Object.freeze({ binding, jsonValue });
    })();
    cache.set(file.id, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(file.id);
      throw error;
    }
  };
}

function normalizeReimbursementFacts(raw, field) {
  object(raw, field);
  const batchId = identifier(raw.batchId, `${field}.batchId`);
  object(raw.reimbursementPeriod, `${field}.reimbursementPeriod`);
  const reimbursementPeriod = {
    start: isoDate(raw.reimbursementPeriod.start, `${field}.reimbursementPeriod.start`),
    end: isoDate(raw.reimbursementPeriod.end, `${field}.reimbursementPeriod.end`),
  };
  if (reimbursementPeriod.end < reimbursementPeriod.start) fail(`${field}.reimbursementPeriod has an end before its start.`);
  const seen = new Map();
  const rawTransactions = array(raw.transactions, `${field}.transactions`);
  if (rawTransactions.length === 0) fail(`${field}.transactions is missing transaction business facts; no receipt or original manifest is required.`);
  const transactions = rawTransactions.map((rawTransaction, index) => {
    const transactionField = `${field}.transactions[${index}]`;
    if (!rawTransaction || typeof rawTransaction !== "object") fail(`${transactionField} is missing transaction business facts.`);
    const transaction = {
      id: identifier(rawTransaction.id, `${transactionField}.id`),
      date: isoDate(rawTransaction.date, `${transactionField}.date`),
      person: text(rawTransaction.person, `${transactionField}.person`, { maxLength: 200 }),
      reimbursementAmount: amount(rawTransaction.reimbursementAmount, `${transactionField}.reimbursementAmount`, { allowNegative: true }),
    };
    const previous = seen.get(transaction.id);
    if (previous) {
      const conflict = canonicalDigest(previous) !== canonicalDigest(transaction);
      fail(`${transactionField}.id ${transaction.id} ${conflict ? "conflicts with" : "duplicates"} another transaction business fact.`);
    }
    seen.set(transaction.id, transaction);
    return Object.freeze(transaction);
  });
  return deepFreeze({ batchId, reimbursementPeriod, transactions });
}

function normalizeSalaryFacts(raw, field) {
  object(raw, field);
  const paymentsById = new Map();
  const rawPayments = array(raw.payments, `${field}.payments`);
  if (rawPayments.length === 0) fail(`${field}.payments is missing salary payment business facts; no salary certificate is required.`);
  const payments = rawPayments.map((rawPayment, index) => {
    const paymentField = `${field}.payments[${index}]`;
    if (!rawPayment || typeof rawPayment !== "object") fail(`${paymentField} is missing salary payment business facts.`);
    const payment = {
      id: identifier(rawPayment.id, `${paymentField}.id`),
      subject: text(rawPayment.subject, `${paymentField}.subject`, { maxLength: 200 }),
      amount: amount(rawPayment.amount, `${paymentField}.amount`),
    };
    const previous = paymentsById.get(payment.id);
    if (previous) {
      const conflict = canonicalDigest(previous) !== canonicalDigest(payment);
      fail(`${paymentField}.id ${payment.id} ${conflict ? "conflicts with" : "duplicates"} another salary payment business fact.`);
    }
    paymentsById.set(payment.id, payment);
    return Object.freeze(payment);
  });
  const grossPayTotal = amount(raw.grossPayTotal, `${field}.grossPayTotal`);
  const paymentsTotal = payments.reduce((sum, payment) => sum + parseDisbursementAmount(payment.amount, `${field}.payments.amount`), 0n);
  if (paymentsTotal !== parseDisbursementAmount(grossPayTotal, `${field}.grossPayTotal`)) {
    fail(`${field}.payments amount business facts do not sum exactly to grossPayTotal.`);
  }
  const finalArtifactKind = text(raw.finalArtifactKind, `${field}.finalArtifactKind`, { maxLength: 20 });
  if (!new Set(["workbook", "image"]).has(finalArtifactKind)) fail(`${field}.finalArtifactKind must be workbook or image.`);
  return deepFreeze({
    month: salaryMonth(raw.month, `${field}.month`),
    salaryCategoryId: identifier(raw.salaryCategoryId, `${field}.salaryCategoryId`),
    salaryCategoryName: text(raw.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 }),
    finalArtifactKind,
    storeReference: relativeReference(raw.storeReference, `${field}.storeReference`),
    grossPayTotal,
    payments,
  });
}

function reviewMaps(sourceReview) {
  object(sourceReview, "sourceReview");
  if (sourceReview.kind !== "disbursement-source-review-v2" || sourceReview.version !== 2) {
    fail("sourceReview kind/version must be disbursement-source-review-v2/2.");
  }
  if (sourceReview.producer !== "task_internal") fail("sourceReview must be produced inside the current task; a sidecar review is not accepted.");
  const reviewIds = new Set();
  const reimbursement = new Map();
  const salary = new Map();
  for (const [index, review] of array(sourceReview.reimbursement, "sourceReview.reimbursement").entries()) {
    const field = `sourceReview.reimbursement[${index}]`;
    const reviewId = identifier(review?.id, `${field}.id`);
    const sourceId = identifier(review?.sourceId, `${field}.sourceId`);
    if (reviewIds.has(reviewId)) fail(`${field}.id is duplicated across sourceReview items.`);
    if (reimbursement.has(sourceId)) fail(`${field}.sourceId has conflicting review facts in more than one item.`);
    reviewIds.add(reviewId);
    reimbursement.set(sourceId, review);
  }
  for (const [index, review] of array(sourceReview.salary, "sourceReview.salary").entries()) {
    const field = `sourceReview.salary[${index}]`;
    const reviewId = identifier(review?.id, `${field}.id`);
    const artifactId = identifier(review?.salaryArtifactId, `${field}.salaryArtifactId`);
    if (reviewIds.has(reviewId)) fail(`${field}.id is duplicated across sourceReview items.`);
    if (salary.has(artifactId)) fail(`${field}.salaryArtifactId has conflicting review facts in more than one item.`);
    reviewIds.add(reviewId);
    salary.set(artifactId, review);
  }
  return { reimbursement, salary };
}

function assertReviewFileBinding(review, expectedFileIds, field) {
  const reviewedFileIds = uniqueIds(review.reviewedFileIds, `${field}.reviewedFileIds`, { nonEmpty: true });
  if (!sameMembers(reviewedFileIds, expectedFileIds)) {
    const difference = bindingDifference(reviewedFileIds, expectedFileIds);
    const details = [
      difference.missing.length ? `missing ${difference.missing.join(", ")}` : null,
      difference.extra.length ? `undeclared ${difference.extra.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    fail(`${field}.reviewedFileIds does not bind every and only the declared source files (${details}).`);
  }
  return reviewedFileIds;
}

function compareFacts(actual, expected, field, businessFact) {
  if (canonicalDigest(actual) !== canonicalDigest(expected)) fail(`${field} conflicts with task-internal ${businessFact} business facts.`);
}

async function validateOriginalManifestAttestation(file, facts, source, field) {
  let audit;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      ORDINARY_MANIFEST_AUDITOR,
      file.path,
      "--defer-ordinary-file-verification",
    ], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_JSON_BYTES,
      timeout: 120_000,
    });
    if (stderr) fail(`${field} original manifest auditor wrote stderr.`);
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) fail(`${field} original manifest auditor must return one JSON line.`);
    audit = parseStrictJson(lines[0]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Disbursement Fresh Source v2 ")) throw error;
    fail(`${field} original manifest structure could not be verified without following its referenced files: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (audit.manifestFileSha256 !== file.sha256 || audit.fileVerificationMode !== "bound-builders") {
    fail(`${field} original manifest stable binding or no-follow audit mode is invalid.`);
  }
  compareFacts(audit.batch?.batchId, facts.batchId, `${field}.batchId`, "batchId");
  compareFacts(audit.batch?.mainPeriod, facts.reimbursementPeriod, `${field}.reimbursementPeriod`, "reimbursement period");
  const transactions = array(audit.normalizedTransactions, `${field}.normalizedTransactions`)
    .filter((transaction) => transaction.profileId === source.profileId)
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      person: transaction.person,
      reimbursementAmount: amount(transaction.reimbursementAmount, `${field}.${transaction.id}.reimbursementAmount`, { allowNegative: true }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (transactions.length === 0) fail(`${field} original manifest has no transaction business facts for profile ${source.profileId}.`);
  const expected = [...facts.transactions].sort((left, right) => left.id.localeCompare(right.id));
  compareFacts(transactions, expected, `${field}.transactions`, "transaction");
  return deepFreeze({
    mode: "v3-structure-and-review-facts-no-follow",
    manifestDigest: audit.manifestDigest,
    factsDigest: audit.factsDigest,
    affectedProfileIds: Object.freeze([...audit.affectedProfileIds]),
    referencedPathsFollowed: false,
  });
}

function validateReceiptBinding(raw, field) {
  exact(raw, new Set(["path", "sha256"]), new Set(["size"]), field);
  const normalized = { path: absolutePath(raw.path, `${field}.path`), sha256: digest(raw.sha256, `${field}.sha256`) };
  if (raw.size !== undefined) {
    if (!Number.isSafeInteger(raw.size) || raw.size < 0) fail(`${field}.size must be a non-negative safe integer.`);
    normalized.size = raw.size;
  }
  return normalized;
}

function validateReceiptAttestation(raw, facts, source, originalManifest, field) {
  exact(raw,
    new Set(["kind", "batchId", "affectedProfileIds", "outputs", "postPublishAuditDigest", "receiptDigest"]),
    new Set(["cleanup"]), field);
  if (raw.kind !== "ordinary-reimbursement-published-v1") fail(`${field}.kind is invalid.`);
  const receiptCore = {
    kind: raw.kind,
    batchId: identifier(raw.batchId, `${field}.batchId`),
    affectedProfileIds: array(raw.affectedProfileIds, `${field}.affectedProfileIds`, { nonEmpty: true })
      .map((profileId, index) => {
        const checked = identifier(profileId, `${field}.affectedProfileIds[${index}]`);
        if (!PROFILE_IDS.has(checked)) fail(`${field}.affectedProfileIds[${index}] is invalid.`);
        return checked;
      }),
    outputs: [],
    postPublishAuditDigest: digest(raw.postPublishAuditDigest, `${field}.postPublishAuditDigest`),
  };
  if (new Set(receiptCore.affectedProfileIds).size !== receiptCore.affectedProfileIds.length) fail(`${field}.affectedProfileIds contains duplicates.`);
  const outputProfiles = new Set();
  let outputBindingCount = 0;
  receiptCore.outputs = array(raw.outputs, `${field}.outputs`, { nonEmpty: true }).map((output, index) => {
    const outputField = `${field}.outputs[${index}]`;
    exact(output,
      new Set(["profileId", "root", "detail", "screenshot", "summary", "snapshot", "supplements", "evidenceArchive", "publishAuditDigest"]),
      new Set(), outputField);
    const profileId = identifier(output.profileId, `${outputField}.profileId`);
    if (!PROFILE_IDS.has(profileId) || outputProfiles.has(profileId)) fail(`${outputField}.profileId is invalid or duplicated.`);
    outputProfiles.add(profileId);
    const normalized = { profileId };
    for (const role of ["root", "detail", "screenshot", "summary", "snapshot"]) {
      normalized[role] = validateReceiptBinding(output[role], `${outputField}.${role}`);
      outputBindingCount += 1;
    }
    for (const role of ["supplements", "evidenceArchive"]) {
      normalized[role] = array(output[role], `${outputField}.${role}`).map((binding, bindingIndex) => {
        outputBindingCount += 1;
        return validateReceiptBinding(binding, `${outputField}.${role}[${bindingIndex}]`);
      });
    }
    normalized.publishAuditDigest = digest(output.publishAuditDigest, `${outputField}.publishAuditDigest`);
    return normalized;
  });
  if (!sameMembers([...outputProfiles], receiptCore.affectedProfileIds)) fail(`${field}.outputs do not close exactly over affectedProfileIds.`);
  const receiptDigest = digest(raw.receiptDigest, `${field}.receiptDigest`);
  if (canonicalDigest(receiptCore) !== receiptDigest) fail(`${field}.receiptDigest is invalid.`);
  if (receiptCore.batchId !== facts.batchId) fail(`${field}.batchId conflicts with task-internal batchId business facts.`);
  if (!receiptCore.affectedProfileIds.includes(source.profileId)) fail(`${field} has no output for reviewed profile ${source.profileId}.`);
  if (originalManifest && canonicalDigest(receiptCore.affectedProfileIds) !== canonicalDigest(originalManifest.affectedProfileIds)) {
    fail(`${field}.affectedProfileIds conflicts with the verified original manifest.`);
  }
  if (raw.cleanup !== undefined) object(raw.cleanup, `${field}.cleanup`);
  return deepFreeze({
    mode: "receipt-structure-and-batch-profile-facts-no-follow",
    receiptDigest,
    outputBindingCount,
    referencedPathsFollowed: false,
  });
}

function validateSalaryCertificate(raw, artifact, facts, field) {
  exact(raw,
    new Set(["kind", "version", "month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "artifactSha256", "storeReference", "grossPayTotal", "certificateDigest"]),
    new Set(), field);
  if (raw.kind !== "salary-final-artifact-v1" || raw.version !== 1) fail(`${field} kind/version is invalid.`);
  const core = {
    kind: raw.kind,
    version: raw.version,
    month: salaryMonth(raw.month, `${field}.month`),
    salaryCategoryId: identifier(raw.salaryCategoryId, `${field}.salaryCategoryId`),
    salaryCategoryName: text(raw.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 }),
    finalArtifactKind: text(raw.finalArtifactKind, `${field}.finalArtifactKind`, { maxLength: 20 }),
    artifactSha256: digest(raw.artifactSha256, `${field}.artifactSha256`),
    storeReference: relativeReference(raw.storeReference, `${field}.storeReference`),
    grossPayTotal: raw.grossPayTotal,
  };
  const certificateDigest = digest(raw.certificateDigest, `${field}.certificateDigest`);
  if (canonicalDigest(core) !== certificateDigest) fail(`${field}.certificateDigest is invalid.`);
  const normalized = { ...core, grossPayTotal: amount(core.grossPayTotal, `${field}.grossPayTotal`) };
  const expected = {
    month: facts.month,
    salaryCategoryId: facts.salaryCategoryId,
    salaryCategoryName: facts.salaryCategoryName,
    finalArtifactKind: facts.finalArtifactKind,
    artifactSha256: artifact.sha256,
    storeReference: facts.storeReference,
    grossPayTotal: facts.grossPayTotal,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (normalized[key] !== value) fail(`${field}.${key} conflicts with the final artifact or task-internal salary business facts.`);
  }
  return deepFreeze({ mode: "salary-final-artifact-v1", certificateDigest });
}

/**
 * Audits only the explicitly supplied fresh-evidence and final-salary source
 * file IDs. The caller must pass slices from a normalized manifest-v2 object;
 * published_archive sources and payout vouchers belong to other units.
 */
export async function auditDisbursementFreshSourcesV2({
  sourceFiles,
  reimbursementSources,
  salaryArtifacts,
  sourceReview,
}) {
  const fileById = normalizeSourceFiles(sourceFiles);
  const sources = array(reimbursementSources, "reimbursementSources");
  const artifacts = array(salaryArtifacts, "salaryArtifacts");
  if (sources.length === 0 && artifacts.length === 0) fail("requires at least one fresh reimbursement source or salary artifact.");
  const reviews = reviewMaps(sourceReview);
  const sourceIds = new Set();
  const artifactIds = new Set();
  const readFile = createFileReader(fileById);
  const fileBindingById = new Map();
  const bindFile = async (fileId, field, constraints) => {
    const file = requireFile(fileById, fileId, field, constraints);
    const runtime = await readFile(file.id, field);
    fileBindingById.set(file.id, runtime.binding);
    return runtime;
  };

  const reimbursementResults = [];
  for (const [index, source] of sources.entries()) {
    const field = `reimbursementSources[${index}]`;
    const sourceId = identifier(source?.id, `${field}.id`);
    if (sourceIds.has(sourceId)) fail(`${field}.id is duplicated.`);
    sourceIds.add(sourceId);
    if (source.mode !== "fresh_evidence") fail(`${field}.mode must be fresh_evidence; published_archive belongs to its separate auditor.`);
    const profileId = identifier(source.profileId, `${field}.profileId`);
    if (!PROFILE_IDS.has(profileId)) fail(`${field}.profileId is invalid.`);
    const inputFileIds = uniqueIds(source.inputFileIds, `${field}.inputFileIds`, { nonEmpty: true });
    const attestationFileIds = [];
    if (source.attestations !== undefined) {
      object(source.attestations, `${field}.attestations`);
      if (source.attestations.originalManifestFileId !== undefined) attestationFileIds.push(identifier(source.attestations.originalManifestFileId, `${field}.attestations.originalManifestFileId`));
      if (source.attestations.receiptFileId !== undefined) attestationFileIds.push(identifier(source.attestations.receiptFileId, `${field}.attestations.receiptFileId`));
      if (attestationFileIds.length === 0) fail(`${field}.attestations must not be empty.`);
    }
    const review = reviews.reimbursement.get(sourceId);
    if (!review) fail(`${field} is missing its task-internal reimbursement sourceReview and transaction business facts.`);
    if (review.mode !== "fresh_evidence") fail(`${field} sourceReview.mode conflicts with fresh_evidence.`);
    const reviewedFileIds = assertReviewFileBinding(review, [...inputFileIds, ...attestationFileIds], `${field}.sourceReview`);
    const facts = normalizeReimbursementFacts(review.facts, `${field}.sourceReview.facts`);
    const inputBindings = [];
    for (const [fileIndex, fileId] of inputFileIds.entries()) {
      const runtime = await bindFile(fileId, `${field}.inputFileIds[${fileIndex}]`, { usage: "fresh_reimbursement_evidence" });
      inputBindings.push(runtime.binding.fileId);
    }
    let originalManifest;
    if (source.attestations?.originalManifestFileId !== undefined) {
      const fileId = source.attestations.originalManifestFileId;
      const runtime = await bindFile(fileId, `${field}.attestations.originalManifestFileId`, { usage: "original_manifest_attestation", kind: "json" });
      originalManifest = await validateOriginalManifestAttestation(fileById.get(runtime.binding.fileId), facts, { profileId }, `${field}.originalManifestAttestation`);
    }
    let receipt;
    if (source.attestations?.receiptFileId !== undefined) {
      const fileId = source.attestations.receiptFileId;
      const runtime = await bindFile(fileId, `${field}.attestations.receiptFileId`, { usage: "publish_receipt_attestation", kind: "json" });
      receipt = validateReceiptAttestation(runtime.jsonValue, facts, { profileId }, originalManifest, `${field}.receiptAttestation`);
    }
    reimbursementResults.push(deepFreeze({
      sourceId,
      profileId,
      mode: "fresh_evidence",
      reviewId: identifier(review.id, `${field}.sourceReview.id`),
      semanticBasis: "task_internal_review_bound",
      inputFileIds: Object.freeze([...inputFileIds]),
      reviewedFileIds: Object.freeze([...reviewedFileIds]),
      facts,
      artifactBinding: Object.freeze({
        inputFileIds: Object.freeze(inputBindings),
        attestationFileIds: Object.freeze([...attestationFileIds]),
      }),
      ...(originalManifest ? { originalManifestAttestation: originalManifest } : {}),
      ...(receipt ? { receiptAttestation: receipt } : {}),
    }));
  }
  for (const sourceId of reviews.reimbursement.keys()) if (!sourceIds.has(sourceId)) fail(`sourceReview.reimbursement contains undeclared source ${sourceId}.`);

  const salaryResults = [];
  const salarySlots = new Set();
  const salaryArtifactDigests = new Set();
  const certificateDigests = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const field = `salaryArtifacts[${index}]`;
    const artifactId = identifier(artifact?.id, `${field}.id`);
    if (artifactIds.has(artifactId)) fail(`${field}.id is duplicated.`);
    artifactIds.add(artifactId);
    const declaration = {
      month: salaryMonth(artifact.month, `${field}.month`),
      salaryCategoryId: identifier(artifact.salaryCategoryId, `${field}.salaryCategoryId`),
      salaryCategoryName: text(artifact.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 }),
      finalArtifactKind: text(artifact.finalArtifactKind, `${field}.finalArtifactKind`, { maxLength: 20 }),
      storeReference: relativeReference(artifact.storeReference, `${field}.storeReference`),
    };
    if (!new Set(["workbook", "image"]).has(declaration.finalArtifactKind)) fail(`${field}.finalArtifactKind must be workbook or image.`);
    const slot = `${declaration.month}\u0000${declaration.salaryCategoryId.toLowerCase()}`;
    if (salarySlots.has(slot)) fail(`${field} conflicts with another salary artifact for the same month/category slot.`);
    salarySlots.add(slot);
    const certificateFileId = artifact.attestation?.salaryCertificateFileId;
    const expectedFileIds = [identifier(artifact.fileId, `${field}.fileId`)];
    if (certificateFileId !== undefined) expectedFileIds.push(identifier(certificateFileId, `${field}.attestation.salaryCertificateFileId`));
    const review = reviews.salary.get(artifactId);
    if (!review) fail(`${field} is missing its task-internal salary sourceReview and payment business facts.`);
    if (review.mode !== "final_artifact") fail(`${field} sourceReview.mode must be final_artifact.`);
    const reviewedFileIds = assertReviewFileBinding(review, expectedFileIds, `${field}.sourceReview`);
    const facts = normalizeSalaryFacts(review.facts, `${field}.sourceReview.facts`);
    for (const key of ["month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "storeReference"]) {
      if (facts[key] !== declaration[key]) fail(`${field}.sourceReview.facts.${key} conflicts with the salary artifact declaration.`);
    }
    const artifactRuntime = await bindFile(artifact.fileId, `${field}.fileId`, { usage: "salary_artifact", kind: declaration.finalArtifactKind });
    if (salaryArtifactDigests.has(artifactRuntime.binding.sha256)) fail(`${field} reuses one final salary artifact in multiple slots.`);
    salaryArtifactDigests.add(artifactRuntime.binding.sha256);
    let certificate;
    if (certificateFileId !== undefined) {
      const runtime = await bindFile(certificateFileId, `${field}.attestation.salaryCertificateFileId`, { usage: "salary_certificate_attestation", kind: "json" });
      certificate = validateSalaryCertificate(runtime.jsonValue, artifactRuntime.binding, facts, `${field}.salaryCertificate`);
      if (certificateDigests.has(certificate.certificateDigest)) fail(`${field} reuses one salary certificate in multiple slots.`);
      certificateDigests.add(certificate.certificateDigest);
    }
    const semanticBasis = declaration.finalArtifactKind === "image"
      ? "review_bound_no_ocr"
      : "review_bound_no_frozen_salary_schema";
    salaryResults.push(deepFreeze({
      artifactId,
      reviewId: identifier(review.id, `${field}.sourceReview.id`),
      ...declaration,
      grossPayTotal: facts.grossPayTotal,
      payments: facts.payments,
      semanticBasis,
      reviewedFileIds: Object.freeze([...reviewedFileIds]),
      artifactBinding: artifactRuntime.binding.fileId,
      ...(certificateFileId !== undefined ? { certificateBinding: certificateFileId, certificate } : {}),
    }));
  }
  for (const artifactId of reviews.salary.keys()) if (!artifactIds.has(artifactId)) fail(`sourceReview.salary contains undeclared artifact ${artifactId}.`);

  const fileBindings = [...fileBindingById.values()].sort((left, right) => left.fileId.localeCompare(right.fileId));
  const artifactBindings = [
    ...reimbursementResults.map((result) => ({
      ownerKind: "reimbursement_source",
      ownerId: result.sourceId,
      fileIds: [...result.reviewedFileIds],
    })),
    ...salaryResults.map((result) => ({
      ownerKind: "salary_artifact",
      ownerId: result.artifactId,
      fileIds: [...result.reviewedFileIds],
    })),
  ];
  const transactions = reimbursementResults.flatMap((result) => result.facts.transactions.map((transaction) => ({
    sourceId: result.sourceId,
    profileId: result.profileId,
    reviewId: result.reviewId,
    ...transaction,
  })));
  const salaryFacts = salaryResults.map((result) => ({
    artifactId: result.artifactId,
    reviewId: result.reviewId,
    month: result.month,
    salaryCategoryId: result.salaryCategoryId,
    salaryCategoryName: result.salaryCategoryName,
    finalArtifactKind: result.finalArtifactKind,
    storeReference: result.storeReference,
    grossPayTotal: result.grossPayTotal,
    payments: result.payments,
    semanticBasis: result.semanticBasis,
  }));
  const boundSourcePaths = [...new Set(fileBindings.map((binding) => binding.path))].sort((left, right) => left.localeCompare(right));
  const boundSourceDigests = [...new Set(fileBindings.map((binding) => binding.sha256))].sort();
  const bindingCore = { artifactBindings, fileBindings, boundSourcePaths, boundSourceDigests };
  return deepFreeze({
    kind: DISBURSEMENT_FRESH_SOURCE_AUDIT_V2_KIND,
    version: 2,
    transactions,
    salaryFacts,
    reimbursementResults,
    salaryResults,
    artifactBindings,
    fileBindings,
    boundSourcePaths,
    boundSourceDigests,
    sourceBindingDigest: canonicalDigest(bindingCore),
  });
}
