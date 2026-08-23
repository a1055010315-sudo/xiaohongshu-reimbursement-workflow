import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DISBURSEMENT_FINAL_ROOT_ENTRIES,
  DISBURSEMENT_SUMMARY_FILENAME,
  DISBURSEMENT_VOUCHER_DIRECTORY,
  DISBURSEMENT_WORKBOOK_FILENAME,
  buildDisbursementArchive,
  buildDisbursementArchiveBytes,
  inspectCompactDisbursementWorkbookBytes,
} from "./disbursement_archive.mjs";
import { auditDisbursementManifest } from "./disbursement_manifest.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  mapSettledLimit,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";

export const DISBURSEMENT_ARCHIVE_KIND = "compact-disbursement-archive-v1";
export const DISBURSEMENT_RECEIPT_KIND = "compact-disbursement-published-v1";

const TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024;
const MAX_VOUCHER_BYTES = 25 * 1024 * 1024;
const WORKFLOW_PREFIX = "codex-xhs-disbursement-";
const OWNER_FILE = ".owner.json";
const CANDIDATE_READY_FILE = "candidate-ready.json";
const PUBLISH_STAGE_FILE = "publish-stage-ready.json";
const PUBLISH_RENAMED_FILE = "publish-renamed.json";

function fail(message) {
  throw new Error(`Compact Disbursement Workflow ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function text(value, field, { maxLength = 32_000 } = {}) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t\0]/u.test(value)) {
    fail(`${field} must be trimmed non-empty single-line text.`);
  }
  if (value.length > maxLength) fail(`${field} is too long.`);
  return value;
}

function sha(value, field) {
  const result = text(value, field, { maxLength: 64 });
  if (!SHA_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function token(value, field = "stagingToken") {
  const result = text(value, field, { maxLength: 64 });
  if (!TOKEN_RE.test(result)) fail(`${field} must be 64 lowercase hexadecimal characters.`);
  return result;
}

function absolute(value, field) {
  const result = text(value, field);
  if (!path.isAbsolute(result)) fail(`${field} must be absolute.`);
  return path.resolve(result);
}

function exact(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function clone(value) {
  return structuredClone(value);
}

function without(value, ...fields) {
  const result = clone(value);
  for (const field of fields) delete result[field];
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparable(left) === comparable(right);
}

function assertWithin(child, parent, field) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${field} must be a strict descendant of its owned root.`);
  }
}

function errorCode(error, code) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code === code) return true;
  }
  return false;
}

function statToken(value) {
  return typeof value === "bigint" ? value.toString() : String(value ?? "");
}

function fileSystemFingerprint(stats) {
  return Object.freeze({
    dev: statToken(stats.dev),
    ino: statToken(stats.ino),
    size: statToken(stats.size),
    mode: statToken(stats.mode),
    mtimeNs: statToken(stats.mtimeNs ?? stats.mtimeMs),
    ctimeNs: statToken(stats.ctimeNs ?? stats.ctimeMs),
    birthtimeNs: statToken(stats.birthtimeNs ?? stats.birthtimeMs),
  });
}

async function assertPlainDirectory(directoryPath, field) {
  const resolved = path.resolve(directoryPath);
  let stats;
  try {
    stats = await fs.lstat(resolved);
  } catch (error) {
    fail(`${field} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${field} must be a plain directory.`);
  const canonical = await fs.realpath(resolved);
  if (!samePath(canonical, resolved)) fail(`${field} must not traverse a reparse point or symbolic link.`);
  return resolved;
}

async function capturePlainDirectoryIdentity(directoryPath, field) {
  const resolved = await assertPlainDirectory(directoryPath, field);
  const [canonical, stats] = await Promise.all([
    fs.realpath(resolved),
    fs.lstat(resolved, { bigint: true }),
  ]);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(canonical, resolved)) {
    fail(`${field} identity changed while it was inspected.`);
  }
  return Object.freeze({
    path: resolved,
    realpath: path.resolve(canonical),
    dev: String(stats.dev),
    ino: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
  });
}

async function capturePlainFileFingerprint(filePath, field) {
  const resolved = await assertPlainRegularFile(filePath, field);
  if (!resolved) fail(`${field} is missing.`);
  const [canonical, beforeStats] = await Promise.all([
    fs.realpath(resolved),
    fs.lstat(resolved, { bigint: true }),
  ]);
  if (!beforeStats.isFile() || beforeStats.isSymbolicLink() || !samePath(canonical, resolved)) fail(`${field} identity is unsafe.`);
  const before = fileSystemFingerprint(beforeStats);
  const afterStats = await fs.lstat(resolved, { bigint: true });
  const after = fileSystemFingerprint(afterStats);
  if (canonicalDigest(before) !== canonicalDigest(after) || !samePath(await fs.realpath(resolved), resolved)) {
    fail(`${field} identity changed while its fingerprint was captured.`);
  }
  return Object.freeze({ kind: "file", path: resolved, realpath: path.resolve(canonical), fingerprint: before });
}

async function captureOwnedFileIdentity(filePath, field, { expectedSha256, expectedSize } = {}) {
  const before = await capturePlainFileFingerprint(filePath, field);
  const maxBytes = expectedSize === undefined ? MAX_WORKBOOK_BYTES : Math.max(expectedSize, 1);
  const snapshot = await readStableBinaryFile(before.path, { maxBytes });
  const after = await capturePlainFileFingerprint(filePath, field);
  if (canonicalDigest(after) !== canonicalDigest(before)) fail(`${field} changed while its cleanup identity was captured.`);
  if (String(snapshot.size) !== before.fingerprint.size) fail(`${field} stat size differs from its stable content size.`);
  if (expectedSha256 !== undefined && snapshot.sha256 !== expectedSha256) fail(`${field} SHA-256 differs from its owned binding.`);
  if (expectedSize !== undefined && snapshot.size !== expectedSize) fail(`${field} size differs from its owned binding.`);
  return deepFreeze({
    kind: "compact-disbursement-owned-file-identity-v1",
    path: before.path,
    canonicalPath: before.realpath,
    ...before.fingerprint,
    content: { sha256: snapshot.sha256, size: snapshot.size },
  });
}

async function assertOwnedFileIdentity(expected, field) {
  object(expected, `${field} identity`);
  const current = await captureOwnedFileIdentity(expected.path, field, {
    expectedSha256: expected.content?.sha256,
    expectedSize: expected.content?.size,
  });
  if (canonicalDigest(current) !== canonicalDigest(expected)) fail(`${field} was replaced after cleanup ownership binding.`);
  return current;
}

async function capturePlainDirectoryFingerprint(directoryPath, field) {
  const resolved = await assertPlainDirectory(directoryPath, field);
  const [canonical, beforeStats] = await Promise.all([
    fs.realpath(resolved),
    fs.lstat(resolved, { bigint: true }),
  ]);
  if (!beforeStats.isDirectory() || beforeStats.isSymbolicLink() || !samePath(canonical, resolved)) fail(`${field} identity is unsafe.`);
  const entries = (await fs.readdir(resolved, { withFileTypes: true })).map((entry) => {
    if (entry.isSymbolicLink()) fail(`${field} contains a symbolic link or reparse point.`);
    return Object.freeze({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  const before = fileSystemFingerprint(beforeStats);
  const afterStats = await fs.lstat(resolved, { bigint: true });
  const after = fileSystemFingerprint(afterStats);
  if (canonicalDigest(before) !== canonicalDigest(after) || !samePath(await fs.realpath(resolved), resolved)) {
    fail(`${field} identity changed while its fingerprint was captured.`);
  }
  return Object.freeze({ kind: "directory", path: resolved, realpath: path.resolve(canonical), fingerprint: before, entries: Object.freeze(entries) });
}

async function assertPlainDirectoryFingerprintIdentity(expected, field) {
  object(expected, `${field} identity`);
  const current = await capturePlainDirectoryFingerprint(expected.path, field);
  if (canonicalDigest(current) !== canonicalDigest(expected)) fail(`${field} was replaced or changed after cleanup ownership binding.`);
  return current;
}

async function assertPlainDirectoryIdentity(expected, field) {
  object(expected, `${field} identity`);
  const current = await capturePlainDirectoryIdentity(expected.path, field);
  if (canonicalDigest(current) !== canonicalDigest(expected)) fail(`${field} was replaced after operation binding.`);
  return current;
}

async function assertMovedPlainDirectoryIdentity(expected, movedPath, field) {
  object(expected, `${field} identity`);
  const current = await capturePlainDirectoryIdentity(movedPath, field);
  for (const key of ["dev", "ino", "birthtimeNs"]) {
    if (current[key] !== expected[key]) fail(`${field} is not the directory that was independently audited.`);
  }
  return current;
}

async function assertPlainRegularFile(filePath, field) {
  const resolved = path.resolve(filePath);
  let stats;
  try {
    stats = await fs.lstat(resolved);
  } catch (error) {
    if (errorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${field} must be a non-symlink regular file.`);
  const canonical = await fs.realpath(resolved);
  if (!samePath(canonical, resolved)) fail(`${field} must not traverse a reparse point or symbolic link.`);
  return resolved;
}

async function writeExclusiveBytes(filePath, bytes) {
  const resolved = path.resolve(filePath);
  const expected = Buffer.from(bytes);
  const handle = await fs.open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(expected);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const snapshot = await readStableBinaryFile(resolved, { maxBytes: Math.max(expected.length, 1) });
  const expectedSha256 = sha256Bytes(expected);
  if (snapshot.sha256 !== expectedSha256 || snapshot.size !== expected.length) fail(`exclusive write verification failed for ${resolved}.`);
  return Object.freeze({ path: resolved, sha256: snapshot.sha256, size: snapshot.size });
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function writeExclusiveJson(filePath, value) {
  return writeExclusiveBytes(filePath, jsonBytes(value));
}

async function writeOrValidateJson(filePath, value) {
  const bytes = jsonBytes(value);
  try {
    return await writeExclusiveBytes(filePath, bytes);
  } catch (error) {
    if (!errorCode(error, "EEXIST")) throw error;
    const snapshot = await readStableUtf8JsonFile(path.resolve(filePath), { maxBytes: MAX_JSON_BYTES });
    if (snapshot.sha256 !== sha256Bytes(bytes) || canonicalDigest(snapshot.value) !== canonicalDigest(value)) {
      fail(`${filePath} already exists with different content.`);
    }
    return Object.freeze({ path: path.resolve(filePath), sha256: snapshot.sha256, size: snapshot.size });
  }
}

function boundSourcePathsFromAudit(audit) {
  const paths = audit?.runtime?.boundSourcePaths;
  if (!Array.isArray(paths) || paths.length === 0) fail("manifest audit did not expose its complete bound source path set.");
  const normalized = paths.map((entry, index) => absolute(entry, `audit.runtime.boundSourcePaths[${index}]`));
  const comparablePaths = normalized.map(comparable);
  if (new Set(comparablePaths).size !== normalized.length) fail("manifest audit bound source path set contains duplicates.");
  return Object.freeze(normalized);
}

function candidateRecord(candidate) {
  return deepFreeze({
    outputRoot: candidate.outputRoot,
    summary: { path: candidate.summary.path, sha256: candidate.summary.sha256, size: candidate.summary.size, text: candidate.summary.text },
    workbook: { path: candidate.workbook.path, sha256: candidate.workbook.sha256, size: candidate.workbook.size, inspection: candidate.workbook.inspection },
    voucherDirectory: candidate.voucherDirectory,
    vouchers: candidate.vouchers.map((entry) => ({
      path: entry.path,
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
      sourceIds: entry.sourceIds,
      rowReferences: entry.rowReferences,
    })),
    artifactDigest: candidate.artifactDigest,
    bindings: candidate.bindings,
    ownedFiles: candidate.ownedFiles,
  });
}

function expectedRecordFromCandidate(candidate) {
  return Object.freeze({
    summaryText: candidate.summary.text,
    bindings: candidate.bindings,
    artifactDigest: candidate.artifactDigest,
  });
}

function expectedRecordFromBytes(built) {
  return Object.freeze({
    summaryText: built.summaryText,
    bindings: built.bindings,
    artifactDigest: built.artifactDigest,
  });
}

function pushIssue(issues, bucket, code, details = {}) {
  issues[bucket].push(Object.freeze({ code, ...details }));
}

function expectedWorkbookRowNote(row, salaryById) {
  const pieces = [];
  if (row.voucherArchiveNames.length) pieces.push(`凭证：${row.voucherArchiveNames.join("、")}`);
  if (row.salaryArtifactId) {
    const salary = salaryById.get(row.salaryArtifactId);
    if (!salary) fail(`candidate row ${row.id} references an unknown salary artifact.`);
    pieces.push(`工资最终件：${salary.storeReference}`);
  }
  if (row.note) pieces.push(row.note);
  if (row.reason) pieces.push(`原因：${row.reason}`);
  if (row.followUp) pieces.push(`后续：${row.followUp}`);
  if (row.targetBatch) pieces.push(`去向：${row.targetBatch}`);
  if (row.adjustment) {
    pieces.push(`尾差${row.adjustment.amount}元；来源行${row.adjustment.sourceRowId}；授权：${row.adjustment.authorization}`);
  }
  return pieces.join("；");
}

function compareCandidateWorkbookRows(audit, workbookInspection, issues) {
  const actualRows = workbookInspection?.dataRows ?? [];
  const dataStartRow = workbookInspection?.dataStartRow;
  const salaryById = new Map(audit.salaryArtifacts.map((entry) => [entry.artifactId, entry]));
  const rowResults = [];
  const matchedRowIds = new Set();
  const fields = Object.freeze([
    "excelRow",
    "subject",
    "xiaohongshu",
    "company",
    "residence",
    "salaryCategory",
    "salary",
    "payableAmount",
    "paidAmount",
    "paymentMethod",
    "visibleStatus",
    "note",
    "payableFormula",
  ]);

  if (!Number.isSafeInteger(dataStartRow) || dataStartRow < 1) {
    pushIssue(issues, "mismatches", "workbook-data-start-row-invalid", { actual: dataStartRow ?? null });
  }

  const resultCount = Math.max(audit.rows.length, actualRows.length);
  for (let index = 0; index < resultCount; index += 1) {
    const row = audit.rows[index];
    const actual = actualRows[index];
    if (!row) {
      pushIssue(issues, "extra", "workbook-row-extra", {
        index: index + 1,
        excelRow: actual?.excelRow ?? null,
        subject: actual?.subject ?? null,
      });
      rowResults.push(Object.freeze({
        rowId: null,
        order: null,
        expected: null,
        actual: actual ?? null,
        differences: Object.freeze(["unexpected-row"]),
        status: "extra",
      }));
      continue;
    }

    const expectedExcelRow = Number.isSafeInteger(dataStartRow) ? dataStartRow + index : null;
    const expected = Object.freeze({
      excelRow: expectedExcelRow,
      subject: row.subject,
      xiaohongshu: row.amounts.xiaohongshu,
      company: row.amounts.company,
      residence: row.amounts.residence,
      salaryCategory: row.salaryArtifactId ? salaryById.get(row.salaryArtifactId)?.salaryCategoryName ?? null : "",
      salary: row.amounts.salary,
      payableAmount: row.payableAmount,
      paidAmount: row.paidAmount,
      paymentMethod: row.paymentMethodDisplay,
      visibleStatus: row.visibleStatus,
      note: expectedWorkbookRowNote(row, salaryById),
      payableFormula: expectedExcelRow === null ? null : `ROUND(SUM(B${expectedExcelRow}:D${expectedExcelRow},F${expectedExcelRow}),3)`,
    });
    if (!actual) {
      pushIssue(issues, "missing", "workbook-row-missing", {
        rowId: row.id,
        order: row.order,
        expectedExcelRow,
        subject: row.subject,
      });
      rowResults.push(Object.freeze({
        rowId: row.id,
        order: row.order,
        expected,
        actual: null,
        differences: Object.freeze(["missing-row"]),
        status: "missing",
      }));
      continue;
    }

    const differences = fields
      .filter((field) => actual[field] !== expected[field])
      .map((field) => Object.freeze({ field, expected: expected[field], actual: actual[field] }));
    if (differences.length) {
      pushIssue(issues, "mismatches", "workbook-row-field-mismatch", {
        rowId: row.id,
        order: row.order,
        excelRow: actual.excelRow,
        differences,
      });
    } else {
      matchedRowIds.add(row.id);
    }
    rowResults.push(Object.freeze({
      rowId: row.id,
      order: row.order,
      expected,
      actual,
      differences: Object.freeze(differences),
      status: differences.length ? "failed" : "matched",
    }));
  }
  return Object.freeze({
    rowResults: Object.freeze(rowResults),
    matchedRowIds,
  });
}

async function inspectCandidateEntry(filePath, field, maxBytes, issues, expected) {
  const plain = await assertPlainRegularFile(filePath, field).catch((error) => {
    pushIssue(issues, "mismatches", "unsafe-or-invalid-file", { artifact: field, path: filePath, message: error.message });
    return null;
  });
  if (!plain) {
    pushIssue(issues, "missing", "artifact-missing", { artifact: field, path: filePath });
    return null;
  }
  const stable = await readStableBinaryFile(plain, { maxBytes });
  if (stable.sha256 !== expected.sha256 || stable.size !== expected.size) {
    pushIssue(issues, "mismatches", "artifact-binding-mismatch", {
      artifact: field,
      path: plain,
      expected: { sha256: expected.sha256, size: expected.size },
      actual: { sha256: stable.sha256, size: stable.size },
    });
  }
  return Object.freeze({ path: plain, snapshot: stable, bytes: copyStableBinaryBytes(stable) });
}

export async function auditCompactDisbursementCandidate(audit, candidateRoot, expectedRecord) {
  if (!audit || audit.kind !== "compact-disbursement-audit-v1") fail("candidate audit requires a compact-disbursement audit.");
  object(expectedRecord, "expectedRecord");
  const root = path.resolve(candidateRoot);
  const issues = { missing: [], extra: [], duplicate: [], unbound: [], mismatches: [] };
  try {
    await assertPlainDirectory(root, "candidate archive root");
  } catch (error) {
    pushIssue(issues, "missing", "archive-root-missing-or-unsafe", { path: root, message: error.message });
    const body = {
      kind: "compact-disbursement-candidate-audit-v1",
      batchId: audit.batch.batchId,
      batchName: audit.batch.batchName,
      candidateRoot: root,
      factsDigest: audit.factsDigest,
      sourceBindingDigest: audit.sourceBindingDigest,
      expectedArtifactDigest: expectedRecord.artifactDigest,
      actualArtifactDigest: null,
      coverage: { expectedRows: audit.rows.length, auditedRows: 0, expectedVouchers: audit.voucherArchive.length, auditedVouchers: 0 },
      rowResults: [],
      salaryResults: [],
      voucherResults: [],
      artifactResults: [],
      ...issues,
      status: "failed",
    };
    return Object.freeze({ ...body, reportDigest: canonicalDigest(body) });
  }

  const expectedRootEntries = [...DISBURSEMENT_FINAL_ROOT_ENTRIES].sort();
  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  const actualRootNames = rootEntries.map((entry) => entry.name).sort();
  for (const name of expectedRootEntries) if (!actualRootNames.includes(name)) pushIssue(issues, "missing", "root-entry-missing", { name });
  for (const name of actualRootNames) if (!expectedRootEntries.includes(name)) pushIssue(issues, "extra", "root-entry-extra", { name });
  if (new Set(actualRootNames.map((name) => process.platform === "win32" ? name.toLowerCase() : name)).size !== actualRootNames.length) {
    pushIssue(issues, "duplicate", "root-entry-case-collision");
  }
  for (const entry of rootEntries) {
    const expectedDirectory = entry.name === DISBURSEMENT_VOUCHER_DIRECTORY;
    if (entry.isSymbolicLink() || (expectedDirectory ? !entry.isDirectory() : !entry.isFile())) {
      pushIssue(issues, "mismatches", "root-entry-type-mismatch", { name: entry.name });
    }
  }

  const expectedBindings = expectedRecord.bindings;
  const summary = await inspectCandidateEntry(
    path.join(root, DISBURSEMENT_SUMMARY_FILENAME),
    "summary",
    MAX_JSON_BYTES,
    issues,
    expectedBindings.summary,
  );
  if (summary) {
    let summaryText;
    try {
      summaryText = new TextDecoder("utf-8", { fatal: true }).decode(summary.bytes);
    } catch (error) {
      pushIssue(issues, "mismatches", "summary-utf8-invalid", { message: error.message });
    }
    if (summaryText !== undefined && summaryText !== expectedRecord.summaryText) {
      pushIssue(issues, "mismatches", "summary-content-mismatch");
    }
  }

  const workbook = await inspectCandidateEntry(
    path.join(root, DISBURSEMENT_WORKBOOK_FILENAME),
    "workbook",
    MAX_WORKBOOK_BYTES,
    issues,
    expectedBindings.workbook,
  );
  let workbookInspection = null;
  if (workbook) {
    try {
      workbookInspection = await inspectCompactDisbursementWorkbookBytes(workbook.bytes);
      if (canonicalDigest(workbookInspection) !== canonicalDigest(expectedBindings.workbook.inspection)) {
        pushIssue(issues, "mismatches", "workbook-inspection-mismatch");
      }
    } catch (error) {
      pushIssue(issues, "mismatches", "workbook-structure-or-style-invalid", { message: error.message });
    }
  }

  const voucherDirectory = path.join(root, DISBURSEMENT_VOUCHER_DIRECTORY);
  let voucherEntries = [];
  try {
    await assertPlainDirectory(voucherDirectory, "voucher directory");
    voucherEntries = await fs.readdir(voucherDirectory, { withFileTypes: true });
  } catch (error) {
    pushIssue(issues, "missing", "voucher-directory-missing-or-unsafe", { message: error.message });
  }
  const expectedVouchers = expectedBindings.vouchers;
  const expectedVoucherByName = new Map(expectedVouchers.map((entry) => [entry.name, entry]));
  const actualVoucherNames = voucherEntries.map((entry) => entry.name).sort();
  for (const expected of expectedVouchers) if (!actualVoucherNames.includes(expected.name)) pushIssue(issues, "missing", "voucher-missing", { name: expected.name });
  for (const name of actualVoucherNames) if (!expectedVoucherByName.has(name)) pushIssue(issues, "extra", "voucher-extra", { name });
  if (new Set(actualVoucherNames.map((name) => process.platform === "win32" ? name.toLowerCase() : name)).size !== actualVoucherNames.length) {
    pushIssue(issues, "duplicate", "voucher-case-collision");
  }
  const voucherResults = [];
  for (const entry of voucherEntries) {
    const expected = expectedVoucherByName.get(entry.name);
    if (!expected) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      pushIssue(issues, "mismatches", "voucher-entry-type-mismatch", { name: entry.name });
      continue;
    }
    const loaded = await inspectCandidateEntry(path.join(voucherDirectory, entry.name), `voucher:${entry.name}`, MAX_VOUCHER_BYTES, issues, expected);
    voucherResults.push(Object.freeze({
      name: entry.name,
      sha256: loaded?.snapshot.sha256 ?? null,
      size: loaded?.snapshot.size ?? null,
      sourceIds: expected.sourceIds,
      rowReferences: expected.rowReferences,
      status: loaded && loaded.snapshot.sha256 === expected.sha256 && loaded.snapshot.size === expected.size ? "matched" : "failed",
    }));
  }

  let actualArtifactDigest = null;
  if (summary && workbook && workbookInspection && voucherResults.length === expectedVouchers.length && voucherResults.every((entry) => entry.status === "matched")) {
    const actualBindings = {
      summary: { name: DISBURSEMENT_SUMMARY_FILENAME, sha256: summary.snapshot.sha256, size: summary.snapshot.size },
      workbook: {
        name: DISBURSEMENT_WORKBOOK_FILENAME,
        sha256: workbook.snapshot.sha256,
        size: workbook.snapshot.size,
        inspection: workbookInspection,
        template: expectedBindings.workbook.template,
      },
      vouchers: expectedVouchers.map((entry) => ({ ...entry })),
    };
    actualArtifactDigest = canonicalDigest(actualBindings);
    if (actualArtifactDigest !== expectedRecord.artifactDigest) pushIssue(issues, "mismatches", "archive-artifact-digest-mismatch");
  }

  const comparedRows = compareCandidateWorkbookRows(audit, workbookInspection, issues);
  const rowResults = comparedRows.rowResults;
  const salaryResults = audit.salaryArtifacts.map((entry) => Object.freeze({
    artifactId: entry.artifactId,
    month: entry.month,
    salaryCategoryId: entry.salaryCategoryId,
    finalArtifactKind: entry.finalArtifactKind,
    artifactSha256: entry.artifactSha256,
    storeReference: entry.storeReference,
    grossPayTotal: entry.grossPayTotal,
    status: audit.rows
      .filter((row) => row.salaryArtifactId === entry.artifactId)
      .every((row) => comparedRows.matchedRowIds.has(row.id)) ? "matched" : "failed",
  }));
  const artifactResults = [
    { role: "summary", path: summary?.path ?? null, sha256: summary?.snapshot.sha256 ?? null, status: summary && summary.snapshot.sha256 === expectedBindings.summary.sha256 ? "matched" : "failed" },
    { role: "workbook", path: workbook?.path ?? null, sha256: workbook?.snapshot.sha256 ?? null, status: workbook && workbook.snapshot.sha256 === expectedBindings.workbook.sha256 && workbookInspection ? "matched" : "failed" },
    ...voucherResults.map((entry) => ({ role: "voucher", path: path.join(voucherDirectory, entry.name), sha256: entry.sha256, status: entry.status })),
  ];
  const issueCount = Object.values(issues).reduce((sum, entries) => sum + entries.length, 0);
  const body = {
    kind: "compact-disbursement-candidate-audit-v1",
    batchId: audit.batch.batchId,
    batchName: audit.batch.batchName,
    candidateRoot: root,
    factsDigest: audit.factsDigest,
    sourceBindingDigest: audit.sourceBindingDigest,
    expectedArtifactDigest: expectedRecord.artifactDigest,
    actualArtifactDigest,
    coverage: {
      expectedRows: audit.rows.length,
      auditedRows: comparedRows.matchedRowIds.size,
      expectedVouchers: expectedVouchers.length,
      auditedVouchers: voucherResults.filter((entry) => entry.status === "matched").length,
    },
    rowResults,
    salaryResults,
    voucherResults,
    artifactResults,
    ...issues,
    status: issueCount === 0 && actualArtifactDigest === expectedRecord.artifactDigest ? "passed" : "failed",
  };
  return Object.freeze({ ...body, reportDigest: canonicalDigest(body) });
}

async function createOwnerMarker(workflowRoot, workflowRootIdentity, stagingToken, archiveRequestDigest, manifest) {
  const core = {
    kind: "compact-disbursement-owner-v1",
    stagingToken,
    workflowRoot,
    workflowRootIdentity,
    archiveRequestDigest,
    manifest,
  };
  const marker = { ...core, markerDigest: canonicalDigest(core) };
  const binding = await writeExclusiveJson(path.join(workflowRoot, OWNER_FILE), marker);
  return Object.freeze({ ...binding, marker, workflowRootIdentity });
}

async function assertOwnerMarker(workflowRoot, expected) {
  const workflowRootIdentity = await capturePlainDirectoryIdentity(workflowRoot, "workflow root");
  const markerPath = path.join(workflowRoot, OWNER_FILE);
  const snapshot = await readStableUtf8JsonFile(markerPath, { maxBytes: MAX_JSON_BYTES });
  const marker = object(snapshot.value, "owner marker");
  if (
    marker.kind !== "compact-disbursement-owner-v1"
    || marker.stagingToken !== expected.stagingToken
    || !samePath(marker.workflowRoot, workflowRoot)
    || canonicalDigest(marker.workflowRootIdentity) !== canonicalDigest(workflowRootIdentity)
    || marker.archiveRequestDigest !== expected.archiveRequestDigest
    || !samePath(marker.manifest?.path, expected.manifest.path)
    || marker.manifest?.sha256 !== expected.manifest.sha256
    || canonicalDigest(without(marker, "markerDigest")) !== marker.markerDigest
  ) fail("workflow owner marker is invalid or belongs to another archive request.");
  if (expected.binding && (
    !samePath(expected.binding.path, markerPath)
    || snapshot.sha256 !== expected.binding.sha256
    || snapshot.size !== expected.binding.size
  )) fail("workflow owner marker changed after binding.");
  if (expected.workflowRootIdentity && canonicalDigest(expected.workflowRootIdentity) !== canonicalDigest(workflowRootIdentity)) {
    fail("workflow root identity differs from its owner binding.");
  }
  return Object.freeze({ path: markerPath, sha256: snapshot.sha256, size: snapshot.size, marker, workflowRootIdentity });
}

function ensureAuditIdentity(freshAudit, baselineAudit, baselineBoundSourcePaths, field = "fresh audit") {
  const freshBoundSourcePaths = boundSourcePathsFromAudit(freshAudit);
  if (
    freshAudit.manifest.sha256 !== baselineAudit.manifest.sha256
    || freshAudit.factsDigest !== baselineAudit.factsDigest
    || freshAudit.sourceBindingDigest !== baselineAudit.sourceBindingDigest
    || freshAudit.batch.batchId !== baselineAudit.batch.batchId
    || freshAudit.batch.batchName !== baselineAudit.batch.batchName
    || !samePath(freshAudit.batch.finalArchivePath, baselineAudit.batch.finalArchivePath)
    || canonicalDigest(freshBoundSourcePaths) !== canonicalDigest(baselineBoundSourcePaths)
  ) fail(`${field} differs from the initial source and business bindings.`);
  return freshBoundSourcePaths;
}

function candidateRecordFromExisting(candidateRoot, expectedRecord) {
  const outputRoot = path.resolve(candidateRoot);
  const voucherDirectory = path.join(outputRoot, DISBURSEMENT_VOUCHER_DIRECTORY);
  const summary = Object.freeze({
    path: path.join(outputRoot, DISBURSEMENT_SUMMARY_FILENAME),
    ...expectedRecord.bindings.summary,
    text: expectedRecord.summaryText,
  });
  const workbook = Object.freeze({
    path: path.join(outputRoot, DISBURSEMENT_WORKBOOK_FILENAME),
    ...expectedRecord.bindings.workbook,
  });
  const vouchers = Object.freeze(expectedRecord.bindings.vouchers.map((entry) => Object.freeze({
    path: path.join(voucherDirectory, entry.name),
    ...entry,
  })));
  return deepFreeze({
    outputRoot,
    summary,
    workbook,
    voucherDirectory,
    vouchers,
    artifactDigest: expectedRecord.artifactDigest,
    bindings: expectedRecord.bindings,
    ownedFiles: Object.freeze([summary, workbook, ...vouchers]),
  });
}

async function openOwnedWorkflow({ workflowRoot, stagingToken, archiveRequestDigest, manifest, testHooks }) {
  const existing = await fs.lstat(workflowRoot).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("existing workflow root is not a plain owned directory.");
    const owner = await assertOwnerMarker(workflowRoot, { stagingToken, archiveRequestDigest, manifest });
    return Object.freeze({ owner, workflowRootIdentity: owner.workflowRootIdentity, recovered: true });
  }
  await fs.mkdir(workflowRoot, { recursive: false });
  const workflowRootIdentity = await capturePlainDirectoryIdentity(workflowRoot, "new workflow root");
  const owner = await createOwnerMarker(workflowRoot, workflowRootIdentity, stagingToken, archiveRequestDigest, manifest);
  await testHooks?.afterOwnerCreated?.({ workflowRoot, owner });
  return Object.freeze({ owner, workflowRootIdentity, recovered: false });
}

async function prepareAndAuditCandidate(context, testHooks) {
  const expected = expectedRecordFromBytes(await buildDisbursementArchiveBytes(context.initialAudit));
  const candidateRoot = path.join(context.workflowRoot, "candidate");
  const existing = await fs.lstat(candidateRoot).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  let candidate;
  let recovered = false;
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("recovered candidate root is not a plain directory.");
    const recoveryAudit = await auditCompactDisbursementCandidate(context.initialAudit, candidateRoot, expected);
    if (recoveryAudit.status !== "passed") fail("recovered candidate differs from the freshly verified archive inputs.");
    candidate = candidateRecordFromExisting(candidateRoot, expected);
    recovered = true;
  } else {
    candidate = candidateRecord(await buildDisbursementArchive(context.initialAudit, candidateRoot));
  }
  await testHooks?.afterCandidateBuilt?.({ ...context, candidate, recovered });
  const candidateAudit = await auditCompactDisbursementCandidate(context.initialAudit, candidateRoot, expectedRecordFromCandidate(candidate));
  if (candidateAudit.status !== "passed") fail(`candidate full correspondence audit failed: ${candidateAudit.reportDigest}.`);
  const candidateReadyCore = {
    kind: "compact-disbursement-candidate-ready-v1",
    archiveRequestDigest: context.archiveRequestDigest,
    manifest: context.initialAudit.manifest,
    factsDigest: context.initialAudit.factsDigest,
    sourceBindingDigest: context.initialAudit.sourceBindingDigest,
    boundSourcePathsDigest: canonicalDigest(context.boundSourcePaths),
    archiveParentIdentity: context.archiveParentIdentity,
    artifactDigest: candidate.artifactDigest,
    candidateAuditDigest: candidateAudit.reportDigest,
  };
  const candidateReady = { ...candidateReadyCore, journalDigest: canonicalDigest(candidateReadyCore) };
  const candidateReadyBinding = await writeOrValidateJson(path.join(context.workflowRoot, CANDIDATE_READY_FILE), candidateReady);
  await testHooks?.afterCandidateAudited?.({ ...context, candidate, candidateAudit, recovered });
  return Object.freeze({ candidate, candidateAudit, candidateReadyBinding, expected, recovered });
}

async function captureCandidateCleanupIdentity(context) {
  const expectedOwner = context.owner;
  const candidateFiles = context.candidate.ownedFiles;
  if (!Array.isArray(candidateFiles) || candidateFiles.length < 2) fail("candidate did not expose its complete owned-file set.");
  const [candidateRoot, voucherDirectory, owner, files] = await Promise.all([
    capturePlainDirectoryFingerprint(context.candidate.outputRoot, "candidate cleanup root"),
    capturePlainDirectoryFingerprint(context.candidate.voucherDirectory, "candidate cleanup voucher directory"),
    captureOwnedFileIdentity(expectedOwner.path, "workflow cleanup owner marker", {
      expectedSha256: expectedOwner.sha256,
      expectedSize: expectedOwner.size,
    }),
    Promise.all(candidateFiles.map((entry, index) => captureOwnedFileIdentity(
      entry.path,
      `candidate cleanup owned file[${index}]`,
      { expectedSha256: entry.sha256, expectedSize: entry.size },
    ))),
  ]);
  const core = {
    kind: "compact-disbursement-candidate-cleanup-identity-v1",
    archiveRequestDigest: context.archiveRequestDigest,
    candidateRoot,
    voucherDirectory,
    owner,
    files,
  };
  return deepFreeze({ ...core, identityDigest: canonicalDigest(core) });
}

async function capturePublicationInputIdentity(context) {
  if (!Array.isArray(context.boundSourcePaths) || context.boundSourcePaths.length === 0) {
    fail("archive context does not bind a complete source path set.");
  }
  const candidateFiles = [
    context.candidate.summary.path,
    context.candidate.workbook.path,
    ...context.candidate.vouchers.map((entry) => entry.path),
  ];
  const uniqueFiles = new Map();
  for (const [index, filePath] of [...context.boundSourcePaths, ...candidateFiles].entries()) {
    const resolved = absolute(filePath, `publication input path[${index}]`);
    const key = comparable(resolved);
    if (!uniqueFiles.has(key)) uniqueFiles.set(key, resolved);
  }
  const orderedFiles = [...uniqueFiles.values()].sort((left, right) => comparable(left).localeCompare(comparable(right)));
  const [files, candidateRoot, voucherDirectory] = await Promise.all([
    Promise.all(orderedFiles.map((filePath, index) => capturePlainFileFingerprint(filePath, `publication input file[${index}]`))),
    capturePlainDirectoryFingerprint(context.candidate.outputRoot, "candidate root"),
    capturePlainDirectoryFingerprint(context.candidate.voucherDirectory, "candidate voucher directory"),
  ]);
  const core = {
    kind: "compact-disbursement-publication-input-identity-v1",
    archiveRequestDigest: context.archiveRequestDigest,
    boundSourcePathsDigest: canonicalDigest(context.boundSourcePaths),
    artifactDigest: context.candidate.artifactDigest,
    sourceFileCount: context.boundSourcePaths.length,
    candidateFileCount: candidateFiles.length,
    files,
    candidateDirectories: [candidateRoot, voucherDirectory],
  };
  return deepFreeze({ ...core, identityDigest: canonicalDigest(core) });
}

async function requireSamePublicationInputIdentity(context, expected, reason) {
  const current = await capturePublicationInputIdentity(context);
  if (current.identityDigest !== expected.identityDigest || canonicalDigest(current) !== canonicalDigest(expected)) {
    fail(`${reason}; bound sources or candidate changed during the single archive operation.`);
  }
  return current;
}

async function verifyFreshCandidate(context) {
  const freshAudit = await auditDisbursementManifest({
    manifestPath: context.manifest.path,
    manifestSha256: context.manifest.sha256,
  });
  ensureAuditIdentity(freshAudit, context.initialAudit, context.boundSourcePaths, "pre-publication fresh audit");
  const freshExpected = expectedRecordFromBytes(await buildDisbursementArchiveBytes(freshAudit));
  const candidateAudit = await auditCompactDisbursementCandidate(freshAudit, context.candidate.outputRoot, freshExpected);
  if (
    candidateAudit.status !== "passed"
    || candidateAudit.actualArtifactDigest !== context.candidate.artifactDigest
    || candidateAudit.reportDigest !== context.candidateAudit.reportDigest
  ) fail(`pre-publication candidate full correspondence audit failed: ${candidateAudit.reportDigest}.`);
  return Object.freeze({ freshAudit, freshExpected, candidateAudit });
}

async function copyBoundFile(source, destination, maxBytes) {
  const stable = await readStableBinaryFile(source.path, { maxBytes });
  if (stable.sha256 !== source.sha256 || stable.size !== source.size) fail(`candidate file changed before publish: ${source.path}.`);
  return writeExclusiveBytes(destination, copyStableBinaryBytes(stable));
}

function publishStageMarkerBody(context, stageRoot, targetPath) {
  const markerPath = `${path.resolve(stageRoot)}.owner.json`;
  const core = {
    kind: "compact-disbursement-publish-stage-owner-v1",
    stagingToken: context.stagingToken,
    archiveRequestDigest: context.archiveRequestDigest,
    workflowRoot: context.workflowRoot,
    stageRoot,
    markerPath,
    targetPath,
    archiveParentIdentity: context.archiveParentIdentity,
    artifactDigest: context.candidate.artifactDigest,
  };
  return { ...core, markerDigest: canonicalDigest(core) };
}

function publishStageMarkerPath(stageRoot) {
  return `${path.resolve(stageRoot)}.owner.json`;
}

async function readPublishStageMarker(context, stageRoot, targetPath, { required = true } = {}) {
  const markerPath = publishStageMarkerPath(stageRoot);
  const plain = await assertPlainRegularFile(markerPath, "publish staging owner marker");
  if (!plain) {
    if (required) fail("publish staging owner marker is missing; the stage was preserved for review.");
    return null;
  }
  const markerSnapshot = await readStableUtf8JsonFile(plain, { maxBytes: MAX_JSON_BYTES });
  const expectedMarker = publishStageMarkerBody(context, stageRoot, targetPath);
  if (canonicalDigest(markerSnapshot.value) !== canonicalDigest(expectedMarker)) fail("publish staging owner marker is invalid.");
  return Object.freeze({
    path: plain,
    sha256: markerSnapshot.sha256,
    size: markerSnapshot.size,
    value: markerSnapshot.value,
  });
}

async function assertPublishStageMarkerUnchanged(context, stageRoot, targetPath, expected) {
  const current = await readPublishStageMarker(context, stageRoot, targetPath);
  if (current.path !== expected.path || current.sha256 !== expected.sha256 || current.size !== expected.size) {
    fail("publish staging owner marker changed after it was bound.");
  }
  return current;
}

async function removePublishStageMarker(context, stageRoot, targetPath, { required = true } = {}) {
  const marker = await readPublishStageMarker(context, stageRoot, targetPath, { required });
  if (!marker) return false;
  await fs.unlink(marker.path);
  return true;
}

async function markedStageIsComplete(stageRoot, expected) {
  const rootNames = (await fs.readdir(stageRoot)).sort();
  const allowed = [...DISBURSEMENT_FINAL_ROOT_ENTRIES].sort();
  if (canonicalDigest(rootNames) !== canonicalDigest(allowed)) return false;
  let voucherNames;
  try {
    voucherNames = (await fs.readdir(path.join(stageRoot, DISBURSEMENT_VOUCHER_DIRECTORY))).sort();
  } catch (error) {
    if (errorCode(error, "ENOENT")) return false;
    throw error;
  }
  if (canonicalDigest(voucherNames) !== canonicalDigest(expected.bindings.vouchers.map((entry) => entry.name).sort())) return false;
  const issues = { missing: [], extra: [], duplicate: [], unbound: [], mismatches: [] };
  const checks = [
    inspectCandidateEntry(path.join(stageRoot, DISBURSEMENT_SUMMARY_FILENAME), "publish-stage-summary", MAX_JSON_BYTES, issues, expected.bindings.summary),
    inspectCandidateEntry(path.join(stageRoot, DISBURSEMENT_WORKBOOK_FILENAME), "publish-stage-workbook", MAX_WORKBOOK_BYTES, issues, expected.bindings.workbook),
    ...expected.bindings.vouchers.map((entry) => inspectCandidateEntry(
      path.join(stageRoot, DISBURSEMENT_VOUCHER_DIRECTORY, entry.name),
      `publish-stage-voucher:${entry.name}`,
      MAX_VOUCHER_BYTES,
      issues,
      entry,
    )),
  ];
  const loaded = await Promise.all(checks);
  return loaded.every(Boolean) && Object.values(issues).every((entries) => entries.length === 0);
}

function candidateCopyPlan(context, stageRoot) {
  return Object.freeze([
    Object.freeze({ source: context.candidate.summary, destination: path.join(stageRoot, DISBURSEMENT_SUMMARY_FILENAME), field: "summary", maxBytes: MAX_JSON_BYTES, binding: context.expected.bindings.summary }),
    Object.freeze({ source: context.candidate.workbook, destination: path.join(stageRoot, DISBURSEMENT_WORKBOOK_FILENAME), field: "workbook", maxBytes: MAX_WORKBOOK_BYTES, binding: context.expected.bindings.workbook }),
    ...context.candidate.vouchers.map((voucher) => Object.freeze({
      source: voucher,
      destination: path.join(stageRoot, DISBURSEMENT_VOUCHER_DIRECTORY, voucher.name),
      field: `voucher:${voucher.name}`,
      maxBytes: MAX_VOUCHER_BYTES,
      binding: context.expected.bindings.vouchers.find((entry) => entry.name === voucher.name),
    })),
  ]);
}

async function resumeMarkedPublishStage(context, stageRoot, targetPath, markerSnapshot) {
  const allowedRootNames = new Set(DISBURSEMENT_FINAL_ROOT_ENTRIES);
  const rootEntries = await fs.readdir(stageRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!allowedRootNames.has(entry.name) || entry.isSymbolicLink()) fail("incomplete publish stage contains an unowned entry; it was preserved for review.");
    const shouldBeDirectory = entry.name === DISBURSEMENT_VOUCHER_DIRECTORY;
    if (shouldBeDirectory ? !entry.isDirectory() : !entry.isFile()) fail("incomplete publish stage entry type is invalid.");
  }
  const normalizedRootNames = rootEntries.map((entry) => process.platform === "win32" ? entry.name.toLowerCase() : entry.name);
  if (new Set(normalizedRootNames).size !== normalizedRootNames.length) fail("incomplete publish stage contains a case-colliding entry.");

  const voucherDirectory = path.join(stageRoot, DISBURSEMENT_VOUCHER_DIRECTORY);
  const voucherDirectoryStats = await fs.lstat(voucherDirectory).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (!voucherDirectoryStats) await fs.mkdir(voucherDirectory, { recursive: false });
  else await assertPlainDirectory(voucherDirectory, "incomplete publish stage voucher directory");
  const expectedVoucherNames = new Set(context.expected.bindings.vouchers.map((entry) => entry.name));
  const existingVoucherEntries = await fs.readdir(voucherDirectory, { withFileTypes: true });
  for (const entry of existingVoucherEntries) {
    if (!expectedVoucherNames.has(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      fail("incomplete publish stage contains an unowned or invalid voucher entry; it was preserved for review.");
    }
  }

  await mapSettledLimit(candidateCopyPlan(context, stageRoot), 6, async (item) => {
    const stats = await fs.lstat(item.destination).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (!stats) return copyBoundFile(item.source, item.destination, item.maxBytes);
    const issues = { missing: [], extra: [], duplicate: [], unbound: [], mismatches: [] };
    const loaded = await inspectCandidateEntry(item.destination, item.field, item.maxBytes, issues, item.binding);
    if (!loaded || Object.values(issues).some((entries) => entries.length)) {
      fail(`incomplete publish stage ${item.field} differs from its candidate binding; it was preserved for review.`);
    }
    return loaded;
  });
  await assertPublishStageMarkerUnchanged(context, stageRoot, targetPath, markerSnapshot);
}

async function preparePublishStage(context, stageRoot, targetPath) {
  const existing = await fs.lstat(stageRoot).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  let marker = await readPublishStageMarker(context, stageRoot, targetPath, { required: false });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("publish staging path is not a plain directory.");
    if (!marker) fail("existing publish staging directory has no owner marker; it was preserved for review.");
    if (!await markedStageIsComplete(stageRoot, context.expected)) {
      await resumeMarkedPublishStage(context, stageRoot, targetPath, marker);
    }
    marker = await assertPublishStageMarkerUnchanged(context, stageRoot, targetPath, marker);
    const recoveredAudit = await auditCompactDisbursementCandidate(context.freshAudit, stageRoot, context.expected);
    if (recoveredAudit.status !== "passed") fail("existing publish staging directory is incomplete or changed; it was preserved for recovery.");
    const stageIdentity = await capturePlainDirectoryIdentity(stageRoot, "recovered publish stage");
    return Object.freeze({ stageRoot, stageIdentity, stageMarker: marker, audit: recoveredAudit, recovered: true });
  }

  let recovered = true;
  if (!marker) {
    const markerFile = await writeExclusiveJson(publishStageMarkerPath(stageRoot), publishStageMarkerBody(context, stageRoot, targetPath));
    marker = Object.freeze({ path: markerFile.path, sha256: markerFile.sha256, size: markerFile.size });
    recovered = false;
  }
  await fs.mkdir(stageRoot, { recursive: false });
  await fs.mkdir(path.join(stageRoot, DISBURSEMENT_VOUCHER_DIRECTORY), { recursive: false });
  await mapSettledLimit(candidateCopyPlan(context, stageRoot), 6, (item) => copyBoundFile(item.source, item.destination, item.maxBytes));
  marker = await assertPublishStageMarkerUnchanged(context, stageRoot, targetPath, marker);
  const audit = await auditCompactDisbursementCandidate(context.freshAudit, stageRoot, context.expected);
  if (audit.status !== "passed") fail(`publish staging audit failed: ${audit.reportDigest}.`);
  const stageIdentity = await capturePlainDirectoryIdentity(stageRoot, "publish stage");
  return Object.freeze({ stageRoot, stageIdentity, stageMarker: marker, audit, recovered });
}

function cleanupIncomplete(root, error) {
  return Object.freeze({
    removed: false,
    preserved: [root],
    failures: error ? [{ path: root, message: error instanceof Error ? error.message : String(error) }] : [],
  });
}

async function bindValidatedControlJournal(context, filePath, fileName) {
  const snapshot = await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
  const journal = object(snapshot.value, `${fileName} cleanup journal`);
  const targetPath = path.resolve(context.freshAudit.batch.finalArchivePath);
  const stageRoot = path.join(
    path.resolve(context.freshAudit.batch.archiveParentPath),
    `.codex-disbursement-${context.stagingToken.slice(0, 20)}.publishing`,
  );
  if (fileName === PUBLISH_STAGE_FILE) {
    exact(journal,
      new Set(["kind", "archiveRequestDigest", "stageRoot", "targetPath", "stageRootIdentity", "stageMarker", "artifactDigest", "stageAuditDigest", "journalDigest"]),
      new Set(), `${fileName} cleanup journal`);
    if (
      journal.kind !== "compact-disbursement-publish-stage-ready-v1"
      || journal.archiveRequestDigest !== context.archiveRequestDigest
      || !samePath(journal.stageRoot, stageRoot)
      || !samePath(journal.targetPath, targetPath)
      || journal.artifactDigest !== context.candidate.artifactDigest
      || sha(journal.stageAuditDigest, `${fileName}.stageAuditDigest`) !== journal.stageAuditDigest
      || !samePath(journal.stageRootIdentity?.path, stageRoot)
      || !samePath(journal.stageRootIdentity?.realpath, stageRoot)
      || !samePath(journal.stageMarker?.path, publishStageMarkerPath(stageRoot))
      || sha(journal.stageMarker?.sha256, `${fileName}.stageMarker.sha256`) !== journal.stageMarker.sha256
      || !Number.isSafeInteger(journal.stageMarker?.size)
      || journal.stageMarker.size < 1
    ) fail(`${fileName} does not prove task ownership for cleanup.`);
  } else if (fileName === PUBLISH_RENAMED_FILE) {
    exact(journal,
      new Set(["kind", "archiveRequestDigest", "targetPath", "stageMarker", "artifactDigest", "finalAuditDigest", "journalDigest"]),
      new Set(), `${fileName} cleanup journal`);
    if (
      journal.kind !== "compact-disbursement-publish-renamed-v1"
      || journal.archiveRequestDigest !== context.archiveRequestDigest
      || !samePath(journal.targetPath, targetPath)
      || journal.artifactDigest !== context.candidate.artifactDigest
      || sha(journal.finalAuditDigest, `${fileName}.finalAuditDigest`) !== journal.finalAuditDigest
      || !samePath(journal.stageMarker?.path, publishStageMarkerPath(stageRoot))
      || sha(journal.stageMarker?.sha256, `${fileName}.stageMarker.sha256`) !== journal.stageMarker.sha256
      || !Number.isSafeInteger(journal.stageMarker?.size)
      || journal.stageMarker.size < 1
    ) fail(`${fileName} does not prove task ownership for cleanup.`);
  } else {
    fail(`${fileName} is not an allowlisted cleanup journal.`);
  }
  if (canonicalDigest(without(journal, "journalDigest")) !== sha(journal.journalDigest, `${fileName}.journalDigest`)) {
    fail(`${fileName} cleanup journal digest is invalid.`);
  }
  return captureOwnedFileIdentity(filePath, `${fileName} cleanup journal`, {
    expectedSha256: snapshot.sha256,
    expectedSize: snapshot.size,
  });
}

async function cleanupWorkflowRoot(context, { controlBindings = [] } = {}) {
  const root = path.resolve(context.workflowRoot);
  try {
    await assertPlainDirectoryIdentity(context.workflowRootIdentity, "workflow cleanup root");
    await assertOwnerMarker(root, {
      stagingToken: context.stagingToken,
      archiveRequestDigest: context.archiveRequestDigest,
      manifest: context.manifest,
      binding: context.owner,
      workflowRootIdentity: context.workflowRootIdentity,
    });
    await assertPlainDirectoryFingerprintIdentity(context.candidateCleanupIdentity.candidateRoot, "candidate cleanup root");
    await assertPlainDirectoryFingerprintIdentity(context.candidateCleanupIdentity.voucherDirectory, "candidate cleanup voucher directory");
    await assertOwnedFileIdentity(context.candidateCleanupIdentity.owner, "workflow cleanup owner marker");
    await Promise.all(context.candidateCleanupIdentity.files.map((entry, index) => assertOwnedFileIdentity(entry, `candidate cleanup owned file[${index}]`)));
  } catch (error) {
    return cleanupIncomplete(root, error);
  }
  const allowedFiles = new Set([
    OWNER_FILE,
    CANDIDATE_READY_FILE,
    PUBLISH_STAGE_FILE,
    PUBLISH_RENAMED_FILE,
    path.join("candidate", DISBURSEMENT_SUMMARY_FILENAME),
    path.join("candidate", DISBURSEMENT_WORKBOOK_FILENAME),
    ...context.candidate.vouchers.map((entry) => path.join("candidate", DISBURSEMENT_VOUCHER_DIRECTORY, entry.name)),
  ].map((entry) => entry.split(path.sep).join("/")));
  const allowedDirectories = new Set(["candidate", `candidate/${DISBURSEMENT_VOUCHER_DIRECTORY}`]);
  const discoveredFiles = [];
  const discoveredDirectories = [];
  let unknown = false;

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relative = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        unknown = true;
      } else if (entry.isDirectory()) {
        if (!allowedDirectories.has(relative)) unknown = true;
        else {
          await walk(absolutePath);
          discoveredDirectories.push(absolutePath);
        }
      } else if (entry.isFile()) {
        if (!allowedFiles.has(relative)) unknown = true;
        else discoveredFiles.push(absolutePath);
      } else {
        unknown = true;
      }
    }
  }

  try {
    await assertPlainDirectory(root, "workflow cleanup root");
    await walk(root);
  } catch (error) {
    return cleanupIncomplete(root, error);
  }
  if (unknown) return Object.freeze({ removed: false, preserved: [root], failures: [] });

  const boundByPath = new Map([
    [comparable(context.candidateCleanupIdentity.owner.path), context.candidateCleanupIdentity.owner],
    ...context.candidateCleanupIdentity.files.map((entry) => [comparable(entry.path), entry]),
  ]);
  const fixedControlBindings = [context.candidateReadyBinding, ...controlBindings];
  try {
    for (const binding of fixedControlBindings) {
      if (!binding) continue;
      const identity = await captureOwnedFileIdentity(binding.path, "workflow cleanup control file", {
        expectedSha256: binding.sha256,
        expectedSize: binding.size,
      });
      boundByPath.set(comparable(identity.path), identity);
    }
    for (const filePath of discoveredFiles) {
      const key = comparable(filePath);
      if (boundByPath.has(key)) continue;
      const fileName = path.basename(filePath);
      if (!new Set([PUBLISH_STAGE_FILE, PUBLISH_RENAMED_FILE]).has(fileName)) {
        fail(`cleanup file ${filePath} lacks an exact task ownership binding.`);
      }
      boundByPath.set(key, await bindValidatedControlJournal(context, filePath, fileName));
    }
    if (boundByPath.size !== discoveredFiles.length) fail("cleanup ownership binding count differs from the discovered owned-file set.");
    await assertPlainDirectoryFingerprintIdentity(context.candidateCleanupIdentity.candidateRoot, "candidate cleanup root before deletion");
    await assertPlainDirectoryFingerprintIdentity(context.candidateCleanupIdentity.voucherDirectory, "candidate cleanup voucher directory before deletion");
    await Promise.all(discoveredFiles.map((filePath, index) => {
      const identity = boundByPath.get(comparable(filePath));
      if (!identity) fail(`cleanup discovered file[${index}] is unbound.`);
      return assertOwnedFileIdentity(identity, `cleanup discovered file[${index}]`);
    }));
    await assertPlainDirectoryIdentity(context.workflowRootIdentity, "workflow cleanup root before deletion");
  } catch (error) {
    return cleanupIncomplete(root, error);
  }

  const failures = [];
  for (const filePath of discoveredFiles.reverse()) {
    try {
      const identity = boundByPath.get(comparable(filePath));
      if (!identity) fail(`cleanup file ${filePath} lost its ownership binding.`);
      await assertOwnedFileIdentity(identity, `cleanup file ${filePath}`);
      await fs.unlink(filePath);
    } catch (error) {
      failures.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  if (failures.length) return Object.freeze({ removed: false, preserved: [root], failures });
  for (const directory of discoveredDirectories.sort((left, right) => right.length - left.length)) {
    try {
      const expected = samePath(directory, context.candidateCleanupIdentity.voucherDirectory.path)
        ? context.candidateCleanupIdentity.voucherDirectory
        : context.candidateCleanupIdentity.candidateRoot;
      const operationIdentity = {
        path: expected.path,
        realpath: expected.realpath,
        dev: expected.fingerprint.dev,
        ino: expected.fingerprint.ino,
        birthtimeNs: expected.fingerprint.birthtimeNs,
      };
      await assertPlainDirectoryIdentity(operationIdentity, `cleanup directory ${directory}`);
      await fs.rmdir(directory);
    } catch (error) {
      failures.push({ path: directory, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  if (failures.length) return Object.freeze({ removed: false, preserved: [root], failures });
  await assertPlainDirectoryIdentity(context.workflowRootIdentity, "workflow cleanup root before final removal");
  try { await fs.rmdir(root); } catch (error) { if (!errorCode(error, "ENOENT")) failures.push({ path: root, message: error.message }); }
  return Object.freeze({ removed: failures.length === 0, preserved: failures.length ? [root] : [], failures });
}

function assertCleanupComplete(cleanup, finalArchivePath) {
  if (!cleanup?.removed) {
    const preserved = Array.isArray(cleanup?.preserved) ? cleanup.preserved.join(", ") : "unknown workflow recovery path";
    fail(`published archive ${finalArchivePath} was verified, but workflow cleanup is incomplete and was preserved at ${preserved}.`);
  }
  return cleanup;
}

function publishReceipt(context, finalAudit, { recovered, cleanup }) {
  const finalArchivePath = context.freshAudit.batch.finalArchivePath;
  const core = {
    kind: DISBURSEMENT_RECEIPT_KIND,
    batchId: context.freshAudit.batch.batchId,
    batchName: context.freshAudit.batch.batchName,
    finalArchivePath,
    archiveRequestDigest: context.archiveRequestDigest,
    manifestSha256: context.manifest.sha256,
    factsDigest: context.freshAudit.factsDigest,
    sourceBindingDigest: context.freshAudit.sourceBindingDigest,
    artifactDigest: context.candidate.artifactDigest,
    candidateAuditDigest: context.candidateAudit.reportDigest,
    prePublishAuditDigest: context.prePublishAudit.reportDigest,
    publicationInputIdentityDigest: context.publicationInputIdentity.identityDigest,
    summary: { path: path.join(finalArchivePath, DISBURSEMENT_SUMMARY_FILENAME), sha256: context.candidate.summary.sha256, size: context.candidate.summary.size },
    workbook: { path: path.join(finalArchivePath, DISBURSEMENT_WORKBOOK_FILENAME), sha256: context.candidate.workbook.sha256, size: context.candidate.workbook.size },
    vouchers: context.candidate.vouchers.map((entry) => ({
      path: path.join(finalArchivePath, DISBURSEMENT_VOUCHER_DIRECTORY, entry.name),
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
      rowReferences: entry.rowReferences,
    })),
    finalAuditDigest: finalAudit.reportDigest,
    recovered,
    cleanup,
  };
  return deepFreeze({ ...core, receiptDigest: canonicalDigest(core) });
}

async function publishVerifiedArchive(context, testHooks) {
  const archiveParentIdentity = await assertPlainDirectoryIdentity(context.archiveParentIdentity, "archive parent");
  const archiveParent = archiveParentIdentity.path;
  const targetPath = path.resolve(context.freshAudit.batch.finalArchivePath);
  assertWithin(targetPath, archiveParent, "final archive path");
  if (!samePath(path.dirname(targetPath), archiveParent)) fail("final archive must be a direct child of archiveParentPath.");
  const stageRoot = path.join(archiveParent, `.codex-disbursement-${context.stagingToken.slice(0, 20)}.publishing`);
  if (!samePath(path.dirname(stageRoot), archiveParent)) fail("publish stage must be a direct child of archiveParentPath.");

  const targetStats = await fs.lstat(targetPath).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (targetStats) {
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) fail("existing final archive path is not a plain directory; refusing to overwrite.");
    const lingeringStage = await fs.lstat(stageRoot).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
    if (lingeringStage) fail("final archive and publish staging directory both exist; both were preserved for review.");
    const existingAudit = await auditCompactDisbursementCandidate(context.freshAudit, targetPath, context.expected);
    if (existingAudit.status !== "passed") fail("final archive path already exists with different content; refusing to overwrite.");
    await removePublishStageMarker(context, stageRoot, targetPath, { required: false });
    const cleanup = assertCleanupComplete(await cleanupWorkflowRoot(context), targetPath);
    return publishReceipt(context, existingAudit, { recovered: true, cleanup });
  }

  const staged = await preparePublishStage(context, stageRoot, targetPath);
  const stageJournalCore = {
    kind: "compact-disbursement-publish-stage-ready-v1",
    archiveRequestDigest: context.archiveRequestDigest,
    stageRoot,
    targetPath,
    stageRootIdentity: staged.stageIdentity,
    stageMarker: { path: staged.stageMarker.path, sha256: staged.stageMarker.sha256, size: staged.stageMarker.size },
    artifactDigest: context.candidate.artifactDigest,
    stageAuditDigest: staged.audit.reportDigest,
  };
  const stageJournal = { ...stageJournalCore, journalDigest: canonicalDigest(stageJournalCore) };
  const stageJournalBinding = await writeOrValidateJson(path.join(context.workflowRoot, PUBLISH_STAGE_FILE), stageJournal);
  await testHooks?.afterPublishStageVerified?.({ ...context, stageRoot, targetPath, staged });

  await assertPlainDirectoryIdentity(staged.stageIdentity, "publish stage after verification hook");
  await assertPublishStageMarkerUnchanged(context, stageRoot, targetPath, staged.stageMarker);
  const preRenameAudit = await auditCompactDisbursementCandidate(context.freshAudit, stageRoot, context.expected);
  if (preRenameAudit.status !== "passed" || preRenameAudit.reportDigest !== staged.audit.reportDigest) {
    fail("publish stage changed after its independent audit; refusing to rename it into the final archive.");
  }
  await assertPlainDirectoryIdentity(staged.stageIdentity, "publish stage immediately before rename");
  const targetBeforeRename = await fs.lstat(targetPath).catch((error) => errorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (targetBeforeRename) fail("final archive path appeared before atomic rename; refusing to overwrite.");
  await assertPlainDirectoryIdentity(context.archiveParentIdentity, "archive parent immediately before publish rename");
  await requireSamePublicationInputIdentity(
    context,
    context.publicationInputIdentity,
    "publication inputs changed after publish stage verification and before atomic rename",
  );
  await fs.rename(stageRoot, targetPath);
  await assertMovedPlainDirectoryIdentity(staged.stageIdentity, targetPath, "published archive");
  await assertPlainDirectoryIdentity(context.archiveParentIdentity, "archive parent after publish rename");
  await testHooks?.afterPublishRename?.({ ...context, targetPath });

  const finalAudit = await auditCompactDisbursementCandidate(context.freshAudit, targetPath, context.expected);
  if (finalAudit.status !== "passed") fail(`published archive final verification failed: ${finalAudit.reportDigest}.`);
  const renamedJournalCore = {
    kind: "compact-disbursement-publish-renamed-v1",
    archiveRequestDigest: context.archiveRequestDigest,
    targetPath,
    stageMarker: { path: staged.stageMarker.path, sha256: staged.stageMarker.sha256, size: staged.stageMarker.size },
    artifactDigest: context.candidate.artifactDigest,
    finalAuditDigest: finalAudit.reportDigest,
  };
  const renamedJournal = { ...renamedJournalCore, journalDigest: canonicalDigest(renamedJournalCore) };
  const renamedJournalBinding = await writeOrValidateJson(path.join(context.workflowRoot, PUBLISH_RENAMED_FILE), renamedJournal);
  await removePublishStageMarker(context, stageRoot, targetPath);
  const cleanup = assertCleanupComplete(await cleanupWorkflowRoot(context, {
    controlBindings: [stageJournalBinding, renamedJournalBinding],
  }), targetPath);
  return publishReceipt(context, finalAudit, { recovered: context.recovered || staged.recovered, cleanup });
}

export async function archiveCompactDisbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["kind", "stagingToken", "manifestPath", "manifestSha256"]), new Set(), "archive request");
  if (rawRequest.kind !== DISBURSEMENT_ARCHIVE_KIND) fail("archive request kind is invalid.");
  const stagingToken = token(rawRequest.stagingToken);
  const manifestPath = absolute(rawRequest.manifestPath, "manifestPath");
  const manifestSha256 = sha(rawRequest.manifestSha256, "manifestSha256");
  const manifest = Object.freeze({ path: manifestPath, sha256: manifestSha256 });
  const archiveRequestDigest = canonicalDigest({ kind: rawRequest.kind, stagingToken, manifestPath, manifestSha256 });
  const workflowRoot = path.join(path.resolve(os.tmpdir()), `${WORKFLOW_PREFIX}${stagingToken}`);
  const initialAudit = await auditDisbursementManifest({ manifestPath, manifestSha256 });
  const boundSourcePaths = boundSourcePathsFromAudit(initialAudit);
  const archiveParentIdentity = await capturePlainDirectoryIdentity(initialAudit.batch.archiveParentPath, "archive parent");
  const opened = await openOwnedWorkflow({ workflowRoot, stagingToken, archiveRequestDigest, manifest, testHooks });
  const baseContext = Object.freeze({
    stagingToken,
    workflowRoot,
    workflowRootIdentity: opened.workflowRootIdentity,
    owner: opened.owner,
    archiveRequestDigest,
    manifest,
    initialAudit,
    boundSourcePaths,
    archiveParentIdentity,
    recovered: opened.recovered,
  });
  const prepared = await prepareAndAuditCandidate(baseContext, testHooks);
  let context = Object.freeze({
    ...baseContext,
    candidate: prepared.candidate,
    candidateAudit: prepared.candidateAudit,
    candidateReadyBinding: prepared.candidateReadyBinding,
    recovered: baseContext.recovered || prepared.recovered,
  });

  const auditStartIdentity = await capturePublicationInputIdentity(context);
  const verified = await verifyFreshCandidate(context);
  const independentAuditIdentity = await requireSamePublicationInputIdentity(
    context,
    auditStartIdentity,
    "publication inputs changed during the pre-publication fresh audit",
  );
  await testHooks?.afterPrePublishAudit?.({ ...context, verified });
  await assertPlainDirectoryIdentity(context.workflowRootIdentity, "workflow root before publication");
  await assertOwnerMarker(context.workflowRoot, {
    stagingToken,
    archiveRequestDigest,
    manifest,
    binding: context.owner,
    workflowRootIdentity: context.workflowRootIdentity,
  });
  await assertPlainDirectoryIdentity(context.archiveParentIdentity, "archive parent before publication");
  const publicationInputIdentity = await requireSamePublicationInputIdentity(
    context,
    independentAuditIdentity,
    "publication inputs changed immediately before publication",
  );
  const candidateCleanupIdentity = await captureCandidateCleanupIdentity(context);
  context = Object.freeze({
    ...context,
    freshAudit: verified.freshAudit,
    expected: verified.freshExpected,
    prePublishAudit: verified.candidateAudit,
    publicationInputIdentity,
    candidateCleanupIdentity,
  });
  return publishVerifiedArchive(context, testHooks);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--archive") {
    fail("usage: run_compact_disbursement_workflow.mjs --archive <strict-json-request>.");
  }
  const requestPath = path.resolve(args[1]);
  const snapshot = await readStableUtf8JsonFile(requestPath, { maxBytes: MAX_JSON_BYTES });
  const result = await archiveCompactDisbursementWorkflow(snapshot.value);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
