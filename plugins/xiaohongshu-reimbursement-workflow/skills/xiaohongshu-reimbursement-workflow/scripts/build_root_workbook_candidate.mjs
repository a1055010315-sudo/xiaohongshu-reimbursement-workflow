import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { formatMilliunits, loadProfileRegistry, parseMilliunits } from "./finance_domain.mjs";
import { loadTemplateAsset } from "./template_assets.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  loadBundledDependency,
  mapSettledLimit,
  MAX_STABLE_BINARY_BYTES,
  parseStrictJson,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";

export const ROOT_WORKBOOK_BUILD_REQUEST_KIND = "root-workbook-build-request-v1";
export const ROOT_WORKBOOK_AUDIT_REQUEST_KIND = "root-workbook-audit-request-v2";
export const ROOT_WORKBOOK_AUDIT_BATCH_KIND = "root-workbook-business-audit-batch-v2";
export const ROOT_WORKBOOK_BUILD_RESULT_KIND = "root-workbook-build-batch-v2";

const BUSINESS_AUDIT_KIND = "root-workbook-business-audit-v2";
const LOCAL_PATCH_CERTIFICATE_KIND = "root-workbook-local-patch-certificate-v1";
const STAGING_PREFIX = "codex-xhs-reimburse-";
const TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 1024 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
const BUILDER_PATH = fileURLToPath(import.meta.url);
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SaxModule = loadBundledDependency("sax");
const sax = SaxModule.default ?? SaxModule;
const STANDARD_STYLE_WINDOW_RADIUS = 32;
const zipPartByteCaches = new WeakMap();

const BUILD_REQUEST_KEYS = new Set(["kind", "stagingToken", "reimbursementFactsCertificate", "artifacts"]);
const ARTIFACT_KEYS = new Set(["profileId", "baselinePath", "baselineSha256", "baselineSize", "candidateRevision"]);
const CERTIFICATE_KEYS = new Set([
  "kind", "operationMode", "manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest",
  "factsDigest", "factsPreimage", "sourceCoverageDigest", "sourceCoveragePreimage", "certificateDigest",
]);
const AUDIT_REQUEST_KEYS = new Set(["kind", "requestNonce", "reimbursementFactsCertificate", "profiles", "requestDigest"]);
const AUDIT_PROFILE_KEYS = new Set(["profileId", "baselinePath", "baselineSha256", "candidatePath", "candidateSha256", "localPatchCertificate"]);
const AUDIT_BATCH_KEYS = new Set(["kind", "requestDigest", "requestFileSha256", "requestNonce", "audits"]);
const LOCAL_PATCH_CERTIFICATE_KEYS = new Set(["kind", "profileId", "baseline", "candidate", "managedParts", "package", "projection", "transform", "transformDigest", "certificateDigest"]);
const LOCAL_PATCH_SOURCE_KEYS = new Set(["sourceSha256", "sourceSize"]);
const LOCAL_PATCH_PART_KEYS = new Set(["name", "beforeSha256", "beforeSize", "afterSha256", "afterSize"]);
const LOCAL_PATCH_PACKAGE_KEYS = new Set(["baselineFactsDigest", "candidateFactsDigest", "baselinePartCount", "candidatePartCount", "baselineInventoryDigest", "candidateInventoryDigest", "untouchedEntryDigest", "untouchedEntryCount"]);

function fail(message, cause) {
  throw new Error(`Root Candidate Builder ${message}`, cause ? { cause } : undefined);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function exact(value, keys, field) {
  object(value, field);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function text(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) fail(`${field} must be a trimmed non-empty string.`);
  return value;
}

function sha(value, field) {
  const result = text(value, field);
  if (!SHA_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function positive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive safe integer.`);
  return value;
}

function nonnegative(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative safe integer.`);
  return value;
}

function clone(value) { return structuredClone(value); }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function unxml(value) { return String(value).replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateCertificate(raw, registry) {
  exact(raw, CERTIFICATE_KEYS, "reimbursementFactsCertificate");
  if (raw.kind !== "reimbursement-manifest-facts-v1" || raw.operationMode !== "reimbursement-batch") fail("ordinary builder requires a reimbursement manifest facts certificate.");
  for (const field of ["manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest", "factsDigest", "sourceCoverageDigest", "certificateDigest"]) sha(raw[field], field);
  if (canonicalDigest(raw.factsPreimage) !== raw.factsDigest || canonicalDigest(raw.sourceCoveragePreimage) !== raw.sourceCoverageDigest) fail("certificate preimage digest differs.");
  const body = clone(raw); delete body.certificateDigest;
  if (canonicalDigest(body) !== raw.certificateDigest) fail("certificateDigest differs from the certificate body.");
  if (raw.profileConfigDigest !== registry.profileConfigDigest || raw.factsPreimage?.profileConfigDigest !== registry.profileConfigDigest) fail("certificate profile registry differs.");
  const transactions = array(raw.factsPreimage?.transactions, "factsPreimage.transactions").map((rawTransaction, index) => {
    const item = object(rawTransaction, `factsPreimage.transactions[${index}]`);
    const profile = registry.profiles[text(item.profileId, `${item.id}.profileId`)];
    if (!profile || item.category !== profile.targetCategory) fail(`${item.id} profile/category is invalid.`);
    const amount = item.sourceAmount ?? item.amount;
    const milliunits = parseMilliunits(amount, `${item.id}.sourceAmount`, { allowNegative: true });
    if (formatMilliunits(milliunits) !== amount) fail(`${item.id}.sourceAmount is not canonical.`);
    if (!new Set(["current", "supplement"]).has(item.reportingKind)) fail(`${item.id}.reportingKind is invalid.`);
    positive(item.sourceOrder, `${item.id}.sourceOrder`);
    return { ...clone(item), amount, milliunits };
  });
  if (transactions.length === 0 || new Set(transactions.map((item) => item.id)).size !== transactions.length) fail("certificate transactions are empty or duplicate.");
  const affectedProfileIds = registry.profileOrder.filter((profileId) => transactions.some((item) => item.profileId === profileId));
  if (canonicalDigest(affectedProfileIds) !== canonicalDigest(raw.factsPreimage.affectedProfileIds)) fail("certificate affected profiles differ.");
  return deepFreeze({ raw: clone(raw), transactions, affectedProfileIds });
}

function validateBuildRequest(raw, registry) {
  exact(raw, BUILD_REQUEST_KEYS, "request");
  if (raw.kind !== ROOT_WORKBOOK_BUILD_REQUEST_KIND || !TOKEN_RE.test(raw.stagingToken ?? "")) fail("request kind or stagingToken is invalid.");
  const certificate = validateCertificate(raw.reimbursementFactsCertificate, registry);
  const artifacts = array(raw.artifacts, "request.artifacts").map((rawArtifact, index) => {
    exact(rawArtifact, ARTIFACT_KEYS, `request.artifacts[${index}]`);
    const profileId = text(rawArtifact.profileId, `request.artifacts[${index}].profileId`);
    const profile = registry.profiles[profileId];
    if (!profile) fail(`${profileId} is not a canonical profile.`);
    const baselinePath = path.resolve(text(rawArtifact.baselinePath, `${profileId}.baselinePath`));
    if (!profile.rootWorkbookInputNames.includes(path.basename(baselinePath))) fail(`${profileId} baseline filename is outside configured inputs.`);
    return { profileId, profile, baselinePath, baselineSha256: sha(rawArtifact.baselineSha256, `${profileId}.baselineSha256`), baselineSize: positive(rawArtifact.baselineSize, `${profileId}.baselineSize`), candidateRevision: positive(rawArtifact.candidateRevision, `${profileId}.candidateRevision`) };
  });
  if (artifacts.length < 1 || artifacts.length > 3) fail("request.artifacts must contain one to three affected profiles.");
  const profileIds = artifacts.map((item) => item.profileId);
  if (new Set(profileIds).size !== profileIds.length || canonicalDigest(profileIds) !== canonicalDigest(certificate.affectedProfileIds)) fail("request artifacts differ from affected profiles.");
  return { stagingToken: raw.stagingToken, certificate, artifacts, profileIds };
}

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/gu)) result.set(match[1], unxml(match[2]));
  return result;
}

function normalizeZipTarget(basePart, target) {
  const slash = target.replaceAll("\\", "/");
  if (slash.startsWith("/")) return slash.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePart), slash));
}

async function binaryPart(zip, partName, field) {
  const entry = zip.file(partName);
  if (!entry) fail(`${field} is missing package part ${partName}.`);
  let cache = zipPartByteCaches.get(zip); if (!cache) { cache = new Map(); zipPartByteCaches.set(zip, cache); }
  if (!cache.has(partName)) cache.set(partName, entry.async("nodebuffer"));
  return cache.get(partName);
}

async function textPart(zip, partName, field) {
  return (await binaryPart(zip, partName, field)).toString("utf8");
}

async function resolveManagedSheet(zip, profile) {
  const workbookPart = "xl/workbook.xml";
  const workbookXml = await textPart(zip, workbookPart, "workbook");
  let relationshipId;
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?\s*>/gu)) {
    const attrs = attributes(match[0]);
    if (attrs.get("name") === profile.managedRootSheetName) { relationshipId = attrs.get("r:id") ?? attrs.get("id"); break; }
  }
  if (!relationshipId) fail(`workbook has no canonical ${profile.managedRootSheetName} sheet.`);
  const workbookRelsPart = "xl/_rels/workbook.xml.rels";
  const workbookRels = await textPart(zip, workbookRelsPart, "workbook relationships");
  let worksheetPart;
  for (const match of workbookRels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) {
    const attrs = attributes(match[0]);
    if (attrs.get("Id") === relationshipId) {
      if (!(attrs.get("Type") ?? "").endsWith("/worksheet")) fail("managed sheet relationship is not a worksheet.");
      worksheetPart = normalizeZipTarget(workbookPart, attrs.get("Target"));
      break;
    }
  }
  if (!worksheetPart) fail("managed worksheet relationship target is missing.");
  const worksheetXml = await textPart(zip, worksheetPart, "managed worksheet");
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*"(?:1|true)"/iu.test(workbookXml);
  return { workbookPart, workbookXml, worksheetPart, worksheetXml, date1904 };
}

function columnNumber(name) { let result = 0; for (const character of name) result = result * 26 + character.charCodeAt(0) - 64; return result; }
function columnName(index) { let result = ""; for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result; return result; }

function saxAttribute(tag, localName) {
  const direct = tag.attributes?.[localName];
  if (direct !== undefined) return typeof direct === "string" ? direct : direct.value;
  for (const [name, attribute] of Object.entries(tag.attributes ?? {})) {
    if ((attribute.local ?? attribute.name?.split(":").at(-1) ?? name.split(":").at(-1)) === localName) return typeof attribute === "string" ? attribute : attribute.value;
  }
  return undefined;
}

function scanWorksheetIndex(worksheetXml, { captureDates }) {
  const parser = sax.parser(true, { position: false, strictEntities: true, trim: false, normalize: false, xmlns: false });
  const rows = []; const mergeRefs = []; let inSheetData = false; let currentRow = null; let currentCell = null; let capturedText = ""; let captureValue = false; let parseError = null; let priorLogicalRow = 0;
  parser.onerror = (error) => { parseError ??= error; };
  parser.ondoctype = () => { parseError ??= new Error("DOCTYPE is forbidden"); };
  parser.onopentag = (tag) => {
    const local = tag.local ?? tag.name.split(":").at(-1);
    if (local === "sheetData") { inSheetData = true; return; }
    if (local === "mergeCell") {
      const ref = saxAttribute(tag, "ref");
      if (ref) mergeRefs.push(ref);
      return;
    }
    if (!inSheetData) return;
    if (local === "row") {
      if (currentRow) fail("managed worksheet contains nested rows.");
      const rawNumber = saxAttribute(tag, "r"); const explicitNumber = rawNumber === undefined ? null : Number(rawNumber);
      const coordinateSafe = rawNumber === undefined || (Number.isSafeInteger(explicitNumber) && explicitNumber > 0);
      const number = coordinateSafe && explicitNumber !== null ? explicitNumber : priorLogicalRow + 1;
      const spanStart = /^(\d+):\d+$/u.exec(saxAttribute(tag, "spans") ?? "")?.[1];
      currentRow = { number, ordinal: rows.length, explicitCoordinate: explicitNumber !== null && coordinateSafe, coordinateSafe, height: saxAttribute(tag, "ht") ?? null, hasBusinessPayload: false, dateValue: null, styles: new Map(), nextColumn: spanStart ? Number(spanStart) : 1, hasImplicitCellCoordinate: false };
      return;
    }
    if (local === "c" && currentRow) {
      const ref = saxAttribute(tag, "r"); const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(ref ?? "");
      const column = coordinate ? columnNumber(coordinate[1]) : currentRow.nextColumn;
      if (!coordinate) currentRow.hasImplicitCellCoordinate = true;
      if (coordinate && Number(coordinate[2]) !== currentRow.number) currentRow.coordinateSafe = false;
      currentRow.nextColumn = column + 1; currentCell = { column };
      if (column <= 6) currentRow.styles.set(column, Number(saxAttribute(tag, "s") ?? "0"));
      return;
    }
    if (currentCell && (local === "v" || local === "f" || local === "is")) {
      if (currentCell.column <= 6) currentRow.hasBusinessPayload = true;
      captureValue = captureDates && currentCell.column === 1 && local === "v";
      capturedText = "";
    }
  };
  parser.ontext = (value) => { if (captureValue) capturedText += value; };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (qualifiedName) => {
    const local = qualifiedName.split(":").at(-1);
    if (local === "v" && captureValue && currentRow) currentRow.dateValue = capturedText;
    if (local === "v" || local === "f" || local === "is") { captureValue = false; capturedText = ""; }
    if (local === "c") currentCell = null;
    if (local === "row") { if (!currentRow) fail("managed worksheet has an unmatched row close."); priorLogicalRow = Math.max(priorLogicalRow, currentRow.number); rows.push(currentRow); currentRow = null; }
    if (local === "sheetData") inSheetData = false;
  };
  try { parser.write(worksheetXml).close(); } catch (error) { parseError ??= error; }
  if (parseError) fail(`managed worksheet XML is malformed: ${parseError.message}`, parseError);
  return { rows, mergeRefs };
}

function locateSheetData(worksheetXml) {
  const open = /<(?:[A-Za-z_][\w.-]*:)?sheetData\b[^>]*>/iu.exec(worksheetXml);
  if (!open) fail("managed worksheet has no sheetData.");
  const prefix = /^<((?:[A-Za-z_][\w.-]*:)?)sheetData\b/iu.exec(open[0])?.[1] ?? "";
  const innerStart = open.index + open[0].length;
  const closePattern = new RegExp(`<\\/${prefix}sheetData\\s*>`, "iu");
  const close = closePattern.exec(worksheetXml.slice(innerStart));
  if (!close) fail("managed worksheet has an unclosed sheetData.");
  return { prefix, innerStart, innerEnd: innerStart + close.index };
}

function locateSheetDataRows(worksheetXml) {
  const bounds = locateSheetData(worksheetXml); const rows = []; let priorLogicalRow = 0;
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\/\s*>|<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?row\s*>/giu;
  rowPattern.lastIndex = bounds.innerStart;
  for (let match = rowPattern.exec(worksheetXml); match && match.index < bounds.innerEnd; match = rowPattern.exec(worksheetXml)) {
    if (rowPattern.lastIndex > bounds.innerEnd) fail("managed worksheet row crosses sheetData boundary.");
    const rowTag = /^<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>/iu.exec(match[0])?.[0] ?? match[0];
    const rawNumber = attributes(rowTag).get("r"); const explicitNumber = rawNumber === undefined ? null : Number(rawNumber); const coordinateSafe = rawNumber === undefined || (Number.isSafeInteger(explicitNumber) && explicitNumber > 0);
    const number = coordinateSafe && explicitNumber !== null ? explicitNumber : priorLogicalRow + 1; priorLogicalRow = Math.max(priorLogicalRow, number);
    rows.push({ number, ordinal: rows.length, explicitCoordinate: explicitNumber !== null && coordinateSafe, coordinateSafe, start: match.index, end: rowPattern.lastIndex, xml: match[0] });
  }
  return { ...bounds, rows };
}

function scanMergeRefs(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?mergeCell\b[^>]*\bref\s*=\s*"([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)"[^>]*\/\s*>/giu)].map((match) => match[1]);
}

function scanCurrentAppendIndex(worksheetXml) {
  const structural = locateSheetDataRows(worksheetXml); const rows = [];
  for (const source of structural.rows) {
    const rowTag = /^<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>/iu.exec(source.xml)?.[0] ?? source.xml; const rowAttrs = attributes(rowTag);
    const spanStart = /^(\d+):\d+$/u.exec(rowAttrs.get("spans") ?? "")?.[1]; let nextColumn = spanStart ? Number(spanStart) : 1;
    const row = { number: source.number, ordinal: source.ordinal, explicitCoordinate: source.explicitCoordinate, coordinateSafe: source.coordinateSafe, height: rowAttrs.get("ht") ?? null, hasBusinessPayload: false, dateValue: null, styles: new Map(), nextColumn, hasImplicitCellCoordinate: false };
    for (const match of source.xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\/\s*>|<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?c\s*>/giu)) {
      const tag = /^<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/iu.exec(match[0])?.[0] ?? match[0]; const cellAttrs = attributes(tag); const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(cellAttrs.get("r") ?? "");
      const column = coordinate ? columnNumber(coordinate[1]) : nextColumn; if (!coordinate) row.hasImplicitCellCoordinate = true;
      if (coordinate && Number(coordinate[2]) !== row.number) row.coordinateSafe = false;
      nextColumn = column + 1;
      if (column <= 6) {
        row.styles.set(column, Number(cellAttrs.get("s") ?? "0"));
        if (/<(?:[A-Za-z_][\w.-]*:)?(?:v|f|is)\b/iu.test(match[0])) row.hasBusinessPayload = true;
      }
    }
    rows.push(row);
  }
  return { rows, mergeRefs: scanMergeRefs(worksheetXml), structural };
}

function serialToIso(raw, date1904) {
  if (!/^-?\d+(?:\.0+)?$/u.test(raw ?? "")) return null;
  const serial = Number(raw);
  if (!Number.isSafeInteger(serial)) return null;
  const date = new Date((serial - (date1904 ? 24_107 : 25_569)) * 86_400_000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function materialRows(rows, date1904) {
  const result = []; let activeDate = null;
  for (const row of rows) {
    if (row.dateValue !== null) activeDate = serialToIso(row.dateValue, date1904) ?? activeDate;
    if (row.number > 1 && row.hasBusinessPayload) result.push({ ...row, date: activeDate });
  }
  return result;
}

function splitRange(ref) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/u.exec(ref);
  if (!match) fail(`unsupported range ${ref}.`);
  return { startColumn: columnNumber(match[1]), startRow: Number(match[2]), endColumn: columnNumber(match[3]), endRow: Number(match[4]) };
}

function chooseInsertionRow(transactionDate, rows, merges) {
  const dated = rows.filter((row) => row.date);
  const later = dated.find((row) => row.date > transactionDate);
  let beforeRow = later?.number;
  if (!beforeRow) {
    const same = dated.filter((row) => row.date === transactionDate);
    beforeRow = same.length ? same.at(-1).number + 1 : (rows.at(-1)?.number ?? 1) + 1;
  }
  for (const ref of merges) {
    const range = splitRange(ref);
    if (range.startColumn > 6 || range.endColumn < 4 || !(range.startRow < beforeRow && beforeRow <= range.endRow)) continue;
    const dates = [...new Set(rows.filter((row) => row.number >= range.startRow && row.number <= range.endRow).map((row) => row.date).filter(Boolean))];
    if (dates.length > 1 && dates[0] <= transactionDate && transactionDate < dates.at(-1)) fail(`supplement ${transactionDate} would split a local cross-date D:E:F expense group.`);
    beforeRow = dates.length > 0 && transactionDate < dates[0] ? range.startRow : range.endRow + 1;
  }
  return beforeRow;
}

function buildInsertions(transactions, indexedRows, date1904, merges) {
  const businessRows = indexedRows.filter((row) => row.number > 1 && row.hasBusinessPayload);
  const appendRow = Math.max(1, ...businessRows.map((row) => row.number)) + 1;
  const requiresDateIndex = transactions.some((transaction) => transaction.reportingKind === "supplement");
  const baselineRows = requiresDateIndex ? materialRows(indexedRows, date1904) : [];
  if (requiresDateIndex && !baselineRows.some((row) => row.date)) fail("supplement insertion requires a local A-column date index.");
  const expenseMerges = merges.filter((ref) => { const range = splitRange(ref); return range.startColumn <= 6 && range.endColumn >= 4; });
  const byRow = new Map();
  for (const transaction of [...transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder)) {
    const beforeRow = transaction.reportingKind === "supplement" ? chooseInsertionRow(transaction.date, baselineRows, expenseMerges) : appendRow;
    if (!byRow.has(beforeRow)) byRow.set(beforeRow, []);
    byRow.get(beforeRow).push(transaction);
  }
  return {
    insertions: [...byRow].sort(([left], [right]) => left - right).map(([beforeRow, items]) => ({ beforeRow, transactions: items.sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder) })),
    appendRow,
    baselineMaterialRowCount: businessRows.length,
    businessTailRow: appendRow - 1,
    requiresDateIndex,
  };
}

function whiteStyleIndexes(stylesXml) {
  const prefix = "(?:[A-Za-z_][\\w.-]*:)?";
  const fillsBlock = new RegExp(`<${prefix}fills\\b[^>]*>([\\s\\S]*?)<\\/${prefix}fills>`, "iu").exec(stylesXml)?.[1] ?? "";
  const whiteFills = new Set([0]); let fillIndex = 0;
  for (const match of fillsBlock.matchAll(new RegExp(`<${prefix}fill\\b[^>]*?\\/\\s*>|<${prefix}fill\\b[^>]*>[\\s\\S]*?<\\/${prefix}fill\\s*>`, "giu"))) {
    const pattern = new RegExp(`<${prefix}patternFill\\b[^>]*patternType\\s*=\\s*"solid"[^>]*>([\\s\\S]*?)<\\/${prefix}patternFill\\s*>|<${prefix}patternFill\\b[^>]*patternType\\s*=\\s*"solid"[^>]*/\\s*>`, "iu").exec(match[0]);
    if (pattern) {
      const foreground = new RegExp(`<${prefix}fgColor\\b[^>]*/\\s*>`, "iu").exec(pattern[0])?.[0];
      const attrs = foreground ? attributes(foreground) : new Map();
      const rgb = attrs.get("rgb"); const indexed = attrs.get("indexed");
      if ((rgb && /^(?:[0-9A-F]{2})?FFFFFF$/iu.test(rgb)) || indexed === "9") whiteFills.add(fillIndex);
    }
    fillIndex += 1;
  }
  const block = new RegExp(`<${prefix}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${prefix}cellXfs>`, "iu").exec(stylesXml)?.[1];
  if (!block) fail("baseline styles have no cellXfs collection.");
  const result = new Set();
  let index = 0;
  for (const match of block.matchAll(new RegExp(`<${prefix}xf\\b[^>]*?\\/\\s*>|<${prefix}xf\\b[^>]*>[\\s\\S]*?<\\/${prefix}xf\\s*>`, "gu"))) {
    const fillId = Number(attributes(new RegExp(`^<${prefix}xf\\b[^>]*>`, "u").exec(match[0])?.[0] ?? match[0]).get("fillId") ?? "0");
    if (whiteFills.has(fillId)) result.add(index);
    index += 1;
  }
  return result;
}

function standardStyleRow(rows, insertionRow, merges, stylesXml) {
  const white = whiteStyleIndexes(stylesXml);
  const intersectsBusinessMerge = (row) => merges.some((ref) => {
    const range = splitRange(ref);
    return range.startColumn <= 6 && range.endColumn >= 1 && range.startRow <= row.number && row.number <= range.endRow;
  });
  const localRows = rows.filter((row) => row.number > 1 && row.hasBusinessPayload && Math.abs(row.number - insertionRow) <= STANDARD_STYLE_WINDOW_RADIUS);
  const candidates = localRows.map((row) => ({ row, cells: row.styles })).filter(({ row, cells }) => Array.from({ length: 6 }, (_, index) => cells.get(index + 1)).every((style) => style !== undefined && white.has(style)) && row.height !== null && !intersectsBusinessMerge(row));
  const selected = candidates.sort((left, right) => Math.abs(left.row.number - insertionRow) - Math.abs(right.row.number - insertionRow) || right.row.number - left.row.number)[0];
  if (!selected) fail(`no whole white standard data row is available near insertion row ${insertionRow}.`);
  return {
    styles: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, selected.cells.get(index + 1)])),
    height: selected.row.height,
    sourceRow: selected.row.number,
    sourceOrdinal: selected.row.ordinal,
    inspectedRowCount: localRows.length,
  };
}

function isoToSerial(value, date1904) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) fail(`transaction date ${value} is invalid.`);
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) + (date1904 ? 24_107 : 25_569);
}

function tCell(ref, style, value, prefix = "") { return `<${prefix}c r="${ref}" s="${style}" t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${xml(value)}</${prefix}t></${prefix}is></${prefix}c>`; }
function nCell(ref, style, value, prefix = "") { return `<${prefix}c r="${ref}" s="${style}" t="n"><${prefix}v>${xml(value)}</${prefix}v></${prefix}c>`; }
function fCell(ref, style, formula, cached, prefix = "") { return `<${prefix}c r="${ref}" s="${style}" t="n"><${prefix}f>${xml(formula)}</${prefix}f><${prefix}v>${xml(cached)}</${prefix}v></${prefix}c>`; }

function previewMoneyPrecision(value) {
  const match = /^-?\d+(?:\.(\d{1,3}))?$/u.exec(String(value));
  if (!match) fail(`preview money value ${value} is not canonical to at most three decimals.`);
  return (match[1] ?? "").replace(/0+$/u, "").length;
}

function renderMoneyStyle(style, value) {
  if (!Array.isArray(style)) return style;
  const selected = style[previewMoneyPrecision(value)];
  if (!Number.isSafeInteger(selected) || selected < 0) fail(`preview money style is missing for ${value}.`);
  return selected;
}

function runs(items, key) {
  const result = [];
  for (let start = 0; start < items.length;) { let end = start; while (end + 1 < items.length && key(items[end + 1]) === key(items[start])) end += 1; result.push({ start, end }); start = end + 1; }
  return result;
}

const ROOT_BATCH_MERGE_POLICY = Object.freeze({ sameDate: true, expenseGroup: true });

function renderBatchRows(transactions, firstRow, styles, height, date1904, prefix = "", mergePolicy = ROOT_BATCH_MERGE_POLICY) {
  const dateStarts = new Map(runs(transactions, (item) => item.date).map((run) => [run.start, run]));
  const groupStarts = new Map(runs(transactions, (item) => JSON.stringify([item.person, item.classification, item.settlement])).map((run) => [run.start, run]));
  const rows = []; const merges = []; const batchRows = [];
  for (const [index, transaction] of transactions.entries()) {
    const row = firstRow + index; const cells = [];
    const dateRun = dateStarts.get(index);
    if (dateRun) { cells.push(nCell(`A${row}`, styles[1], isoToSerial(transaction.date, date1904), prefix)); if (mergePolicy.sameDate && dateRun.end > dateRun.start) merges.push(`A${row}:A${row + dateRun.end - dateRun.start}`); }
    cells.push(tCell(`B${row}`, styles[2], transaction.project, prefix), nCell(`C${row}`, renderMoneyStyle(styles[3], transaction.amount), transaction.amount, prefix));
    const groupRun = groupStarts.get(index);
    if (groupRun) {
      const endRow = row + groupRun.end - groupRun.start;
      const total = transactions.slice(groupRun.start, groupRun.end + 1).reduce((sum, item) => sum + item.milliunits, 0n);
      const cachedTotal = formatMilliunits(total);
      cells.push(fCell(`D${row}`, renderMoneyStyle(styles[4], cachedTotal), `SUM(C${row}:C${endRow})`, cachedTotal, prefix), tCell(`E${row}`, styles[5], transaction.person, prefix), tCell(`F${row}`, styles[6], transaction.classification, prefix));
      if (mergePolicy.expenseGroup && endRow > row) for (const column of ["D", "E", "F"]) merges.push(`${column}${row}:${column}${endRow}`);
    }
    rows.push(`<${prefix}row r="${row}" ht="${xml(height)}" customHeight="1">${cells.join("")}</${prefix}row>`);
    batchRows.push({ transactionId: transaction.id, row, fingerprint: canonicalDigest({ transactionId: transaction.id, row, date: transaction.date, project: transaction.project, amount: transaction.amount, person: transaction.person, classification: transaction.classification }) });
  }
  return { rows, merges, batchRows };
}

function insertionShift(row, insertions) { return insertions.reduce((count, insertion) => count + (insertion.beforeRow <= row ? insertion.transactions.length : 0), 0); }

function shiftFormula(formula, insertions) {
  const value = String(formula); let result = ""; let index = 0; let inString = false; let lastReference = null;
  while (index < value.length) {
    const encodedQuote = value.startsWith("&quot;", index);
    if (encodedQuote || value[index] === '"') {
      const quote = encodedQuote ? "&quot;" : '"';
      if (inString && value.startsWith(quote + quote, index)) { result += quote + quote; index += quote.length * 2; continue; }
      inString = !inString; result += quote; index += quote.length; lastReference = null; continue;
    }
    if (!inString && (value[index] === "[" || value[index] === "]")) fail(`formula contains an unsupported structured or external reference: ${value}.`);
    if (!inString) {
      const match = /^((?:\$)?[A-Za-z]{1,3})(\$?)([1-9]\d*)/u.exec(value.slice(index));
      if (match) {
        const before = index > 0 ? value[index - 1] : ""; const after = value[index + match[0].length] ?? "";
        const tokenBoundary = !/[A-Za-z0-9_.]/u.test(before) && !/[A-Za-z0-9_.]/u.test(after) && after !== "(";
        if (tokenBoundary) {
          const rangeContinuation = lastReference && value.slice(lastReference.end, index) === ":";
          const qualified = before === "!" || Boolean(rangeContinuation && lastReference.qualified);
          const shifted = qualified ? match[0] : `${match[1]}${match[2]}${Number(match[3]) + insertionShift(Number(match[3]), insertions)}`;
          result += shifted; lastReference = { end: index + match[0].length, qualified }; index += match[0].length; continue;
        }
      }
    }
    result += value[index]; index += 1;
    if (!inString && !/\s/u.test(value[index - 1]) && value[index - 1] !== ":") lastReference = null;
  }
  if (inString) fail(`formula contains an unterminated string literal: ${value}.`);
  return result;
}

function shiftReferenceList(value, insertions) {
  return value.split(/(\s+)/u).map((token) => (/\S/u.test(token) ? shiftFormula(token, insertions) : token)).join("");
}

function shiftWorksheetReferences(worksheetXml, insertions, sheetName) {
  return worksheetXml
    .replace(/<(?:[A-Za-z_][\w.-]*:)?(?:conditionalFormatting|dataValidation|hyperlink|autoFilter|sortState|protectedRange|ignoredError)\b[^>]*>/giu, (tag) => shiftReferenceTag(tag, insertions, sheetName))
    .replace(/(<(?:[A-Za-z_][\w.-]*:)?(?:formula|formula1|formula2)\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?(?:formula|formula1|formula2)>)/giu, (whole, open, formula, close) => `${open}${shiftFormula(formula, insertions)}${close}`);
}

function shiftOriginalRow(row, insertions) {
  const newNumber = row.number + insertionShift(row.number, insertions);
  let result = row.xml.replace(/^(<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\br\s*=\s*")[1-9]\d*(")/u, `$1${newNumber}$2`);
  result = result.replace(/(<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\br\s*=\s*")([A-Z]{1,3})([1-9]\d*)(")/gu, (whole, prefix, column, rowText, suffix) => `${prefix}${column}${Number(rowText) + insertionShift(Number(rowText), insertions)}${suffix}`);
  result = result.replace(/(<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?f>)/gu, (whole, open, formula, close) => `${open}${shiftFormula(formula, insertions)}${close}`);
  return { number: newNumber, xml: result };
}

function shiftMerge(ref, insertions) {
  const range = splitRange(ref);
  for (const insertion of insertions) if (range.startRow < insertion.beforeRow && insertion.beforeRow <= range.endRow) fail(`local insertion would split existing merge ${ref}.`);
  return `${columnName(range.startColumn)}${range.startRow + insertionShift(range.startRow, insertions)}:${columnName(range.endColumn)}${range.endRow + insertionShift(range.endRow, insertions)}`;
}

function patchMergeCells(worksheetXml, existingRefs, newRefs, insertions, worksheetPrefix) {
  const shiftedExisting = existingRefs.map((ref) => shiftMerge(ref, insertions));
  const allRefs = [...shiftedExisting, ...newRefs];
  const blockPattern = /<((?:[A-Za-z_][\w.-]*:)?)mergeCells\b([^>]*)>([\s\S]*?)<\/\1mergeCells\s*>/iu;
  const match = blockPattern.exec(worksheetXml);
  if (!match) {
    if (allRefs.length === 0) return worksheetXml;
    const block = `<${worksheetPrefix}mergeCells count="${allRefs.length}">${allRefs.map((ref) => `<${worksheetPrefix}mergeCell ref="${ref}"/>`).join("")}</${worksheetPrefix}mergeCells>`;
    return worksheetXml.replace(new RegExp(`<\\/${worksheetPrefix}worksheet>\\s*$`, "iu"), `${block}</${worksheetPrefix}worksheet>`);
  }
  let existingIndex = 0;
  const shiftedBody = match[3].replace(/<(?:[A-Za-z_][\w.-]*:)?mergeCell\b[^>]*\bref\s*=\s*"([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)"[^>]*\/\s*>/giu, (tag) => {
    const replacement = shiftedExisting[existingIndex++];
    return replacement ? tag.replace(/(\bref\s*=\s*")[^"]+(")/iu, `$1${replacement}$2`) : tag;
  });
  if (existingIndex !== existingRefs.length) fail("managed worksheet merge index differs from mergeCells content.");
  const openingAttributes = /\bcount\s*=\s*"[^"]*"/iu.test(match[2]) ? match[2].replace(/\bcount\s*=\s*"[^"]*"/iu, `count="${allRefs.length}"`) : `${match[2]} count="${allRefs.length}"`;
  const appended = newRefs.map((ref) => `<${match[1]}mergeCell ref="${ref}"/>`).join("");
  return `${worksheetXml.slice(0, match.index)}<${match[1]}mergeCells${openingAttributes}>${shiftedBody}${appended}</${match[1]}mergeCells>${worksheetXml.slice(match.index + match[0].length)}`;
}

function updateDimension(worksheetXml, maxRow) {
  return worksheetXml.replace(/(<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref\s*=\s*")([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?(")/iu, (whole, prefix, startColumn, startRow, endColumn, endRow, suffix) => `${prefix}${startColumn}${startRow}:${endColumn ?? startColumn}${Math.max(Number(endRow ?? startRow), maxRow)}${suffix}`);
}

function updatePrintArea(workbookXml, sheetName, maxRow) {
  const escaped = sheetName.replaceAll("'", "''");
  return workbookXml.replace(/(<(?:[A-Za-z_][\w.-]*:)?definedName\b[^>]*\bname\s*=\s*"_xlnm\.Print_Area"[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?definedName>)/giu, (whole, open, value, close) => {
    if (!unxml(value).includes(`'${escaped}'!`) && !unxml(value).includes(`${escaped}!`)) return whole;
    return `${open}'${xml(escaped)}'!$A$1:$F$${maxRow}${close}`;
  });
}

function contiguousRanges(rows) {
  const result = [];
  for (const row of [...rows].sort((left, right) => left - right)) { const prior = result.at(-1); if (prior && prior.endRow + 1 === row) prior.endRow = row; else result.push({ startRow: row, endRow: row }); }
  return result.map((item) => ({ ...item, rangeAddress: `A${item.startRow}:F${item.endRow}` }));
}

function formulaElements(xmlText, names = "f") {
  const pattern = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?)(${names})\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/\\1\\2\\s*>)`, "giu");
  return [...xmlText.matchAll(pattern)].map((match) => ({ prefix: match[1], name: match[2], attributes: match[3], body: match[4] ?? null }));
}

function rowCoordinateDescriptor(rowXml) {
  const rowTag = /^<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>/iu.exec(rowXml)?.[0] ?? rowXml;
  const explicitRow = /\sr\s*=\s*"([^"]*)"/iu.exec(rowTag)?.[1] ?? null; const cells = [];
  for (const match of rowXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/giu)) {
    const coordinate = /\sr\s*=\s*"([^"]*)"/iu.exec(match[0])?.[1] ?? null;
    cells.push({ coordinate, tagShape: match[0].replace(/(\sr\s*=\s*")[^"]*(")/iu, "$1#REF#$2") });
  }
  return {
    explicitRow,
    rowTagShape: rowTag.replace(/(\sr\s*=\s*")[^"]*(")/iu, "$1#ROW#$2"),
    cells,
    formulas: formulaElements(rowXml),
  };
}

function shiftedCellCoordinate(coordinate, insertions) {
  if (coordinate === null) return null;
  const parsed = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(coordinate);
  if (!parsed) fail(`historical cell coordinate ${coordinate} cannot be shifted safely.`);
  return `${parsed[1]}${Number(parsed[2]) + insertionShift(Number(parsed[2]), insertions)}`;
}

function referenceTags(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(?:conditionalFormatting|dataValidation|hyperlink|autoFilter|sortState|protectedRange|ignoredError)\b[^>]*>/giu)].map((match) => match[0]);
}

function shiftCurrentSheetLocation(value, insertions, sheetName) {
  const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/u.exec(value);
  if (!match) return value;
  const qualifiedSheet = unxml((match[1] ?? match[2]).replaceAll("''", "'"));
  if (qualifiedSheet !== sheetName) return value;
  const qualifier = value.slice(0, value.length - match[3].length);
  return `${qualifier}${shiftFormula(match[3], insertions)}`;
}

function shiftReferenceTag(tag, insertions, sheetName) {
  return tag.replace(/(\b(ref|sqref|location)\s*=\s*")([^"]+)(")/giu, (whole, prefix, attribute, value, suffix) => {
    if (attribute.toLowerCase() === "location") {
      if (!value.includes("!")) return whole;
      return `${prefix}${shiftCurrentSheetLocation(value, insertions, sheetName)}${suffix}`;
    }
    return `${prefix}${shiftReferenceList(value, insertions)}${suffix}`;
  });
}

function dimensionReference(worksheetXml) {
  return /<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref\s*=\s*"([^"]+)"/iu.exec(worksheetXml)?.[1] ?? null;
}

function structuralRowWitness(row) {
  return row ? { number: row.number, start: row.start, end: row.end, sha256: sha256Bytes(Buffer.from(row.xml, "utf8")) } : null;
}

function witnessedRowXml(worksheetXml, witness, field) {
  object(witness, field); nonnegative(witness.start, `${field}.start`); positive(witness.end, `${field}.end`); positive(witness.number, `${field}.number`); sha(witness.sha256, `${field}.sha256`);
  if (witness.end <= witness.start || witness.end > worksheetXml.length) fail(`${field} offsets are invalid.`);
  const rowXml = worksheetXml.slice(witness.start, witness.end);
  if (sha256Bytes(Buffer.from(rowXml, "utf8")) !== witness.sha256) fail(`${field} row digest differs.`);
  const descriptor = rowCoordinateDescriptor(rowXml);
  if (descriptor.explicitRow !== null && Number(descriptor.explicitRow) !== witness.number) fail(`${field} row coordinate differs.`);
  return rowXml;
}

function verifyAppendBoundaryTransform(beforeXml, afterXml, batchRowXmlByRow, batchMergeRefs, maxRow, boundary) {
  object(boundary, "append boundary"); nonnegative(boundary.baselineInsertionOffset, "append boundary baselineInsertionOffset");
  if (boundary.baselineInsertionOffset > beforeXml.length) fail("append boundary insertion offset is invalid.");
  const orderedBatchRows = [...batchRowXmlByRow].sort(([left], [right]) => left - right); const batchXml = orderedBatchRows.map(([, rowXml]) => rowXml).join("");
  if (!batchXml) fail("append coordinate transform has no batch rows.");
  const batchStart = afterXml.indexOf(batchXml); if (batchStart < 0 || afterXml.lastIndexOf(batchXml) !== batchStart) fail("candidate append batch boundary is missing or duplicate.");
  const tailXml = witnessedRowXml(beforeXml, boundary.tail, "append boundary tail"); const tailStart = afterXml.lastIndexOf(tailXml, batchStart);
  if (tailStart < 0) fail("candidate append predecessor boundary differs.");
  const baselineGapBefore = beforeXml.slice(boundary.tail.end, boundary.baselineInsertionOffset); const candidateGapBefore = afterXml.slice(tailStart + tailXml.length, batchStart);
  if (candidateGapBefore !== baselineGapBefore) fail("candidate append predecessor interstitial bytes differ.");
  let trailingDigest = null;
  if (boundary.trailing) {
    const trailingXml = witnessedRowXml(beforeXml, boundary.trailing, "append boundary trailing"); const trailingStart = afterXml.indexOf(trailingXml, batchStart + batchXml.length);
    if (trailingStart < 0) fail("candidate append trailing boundary differs.");
    const baselineGapAfter = beforeXml.slice(boundary.baselineInsertionOffset, boundary.trailing.start); const candidateGapAfter = afterXml.slice(batchStart + batchXml.length, trailingStart);
    if (candidateGapAfter !== baselineGapAfter) fail("candidate append trailing interstitial bytes differ.");
    trailingDigest = boundary.trailing.sha256;
  }
  const beforeReferenceTags = referenceTags(beforeXml); const afterReferenceTags = referenceTags(afterXml);
  if (canonicalDigest(beforeReferenceTags) !== canonicalDigest(afterReferenceTags)) fail("candidate append changed worksheet reference tags.");
  const beforeRuleFormulas = formulaElements(beforeXml, "formula|formula1|formula2"); const afterRuleFormulas = formulaElements(afterXml, "formula|formula1|formula2");
  if (canonicalDigest(beforeRuleFormulas) !== canonicalDigest(afterRuleFormulas)) fail("candidate append changed worksheet rule formulas.");
  const expectedMerges = [...scanMergeRefs(beforeXml), ...batchMergeRefs];
  if (canonicalDigest(scanMergeRefs(afterXml)) !== canonicalDigest(expectedMerges)) fail("candidate append merge boundary differs.");
  if (dimensionReference(afterXml) !== dimensionReference(updateDimension(beforeXml, maxRow))) fail("candidate append dimension differs.");
  const facts = {
    scope: "append-local-boundary", historicalRowCountCompared: boundary.trailing ? 2 : 1, shiftedHistoricalRowCount: 0,
    worksheetReferenceTagCount: beforeReferenceTags.length, worksheetRuleFormulaCount: beforeRuleFormulas.length, mergeReferenceCount: expectedMerges.length,
    boundaryDigest: canonicalDigest({ tail: boundary.tail.sha256, trailing: trailingDigest, predecessorGap: sha256Bytes(Buffer.from(baselineGapBefore, "utf8")), batchRows: orderedBatchRows.map(([row]) => row) }),
    candidateCoordinateDigest: canonicalDigest({ batchRows: orderedBatchRows.map(([row]) => row), tailRow: boundary.tail.number, trailingRow: boundary.trailing?.number ?? null }),
  };
  return { ...facts, factsDigest: canonicalDigest(facts) };
}

function verifySupplementSuffixTransform(beforeXml, afterXml, insertions, batchRows, batchMergeRefs, { maxRow, sheetName, beforeStructural = null, afterStructural = null } = {}) {
  const before = beforeStructural ?? locateSheetDataRows(beforeXml); const after = afterStructural ?? locateSheetDataRows(afterXml); const batchNumbers = new Set(batchRows.map((item) => item.row));
  const actualBatchRows = after.rows.filter((row) => batchNumbers.has(row.number));
  if (actualBatchRows.length !== batchNumbers.size || new Set(actualBatchRows.map((row) => row.number)).size !== batchNumbers.size) fail("candidate batch row coordinates are missing or duplicate.");
  const historical = after.rows.filter((row) => !batchNumbers.has(row.number));
  if (historical.length !== before.rows.length) fail("candidate historical row count differs outside the batch.");
  const firstAffectedIndex = before.rows.findIndex((row) => insertionShift(row.number, insertions) > 0);
  const preservedPrefixCount = firstAffectedIndex < 0 ? before.rows.length : firstAffectedIndex;
  for (let index = 0; index < preservedPrefixCount; index += 1) {
    if (historical[index].number !== before.rows[index].number || historical[index].xml !== before.rows[index].xml) fail(`historical prefix row ${before.rows[index].number} changed before the first supplement boundary.`);
  }
  let shiftedRowCount = 0; let cellCoordinateCount = 0; let formulaCount = 0;
  for (let index = preservedPrefixCount; index < before.rows.length; index += 1) {
    const baselineRow = before.rows[index];
    const candidateRow = historical[index]; const rowShift = insertionShift(baselineRow.number, insertions);
    if (rowShift <= 0) fail(`supplement affected suffix row ${baselineRow.number} has no coordinate shift.`);
    const baselineDescriptor = rowCoordinateDescriptor(baselineRow.xml); const candidateDescriptor = rowCoordinateDescriptor(candidateRow.xml);
    if (baselineDescriptor.rowTagShape !== candidateDescriptor.rowTagShape) fail(`historical row ${baselineRow.number} attributes changed outside its coordinate.`);
    const expectedRow = baselineDescriptor.explicitRow === null ? null : String(Number(baselineDescriptor.explicitRow) + rowShift);
    if (candidateDescriptor.explicitRow !== expectedRow) fail(`historical row ${baselineRow.number} coordinate transform differs.`);
    if (baselineDescriptor.cells.length !== candidateDescriptor.cells.length) fail(`historical row ${baselineRow.number} cell coordinate count differs.`);
    for (const [cellIndex, baselineCell] of baselineDescriptor.cells.entries()) {
      const candidateCell = candidateDescriptor.cells[cellIndex]; const expectedCoordinate = rowShift > 0 ? shiftedCellCoordinate(baselineCell.coordinate, insertions) : baselineCell.coordinate;
      if (candidateCell.coordinate !== expectedCoordinate || candidateCell.tagShape !== baselineCell.tagShape) fail(`historical row ${baselineRow.number} cell coordinate transform differs.`);
      cellCoordinateCount += 1;
    }
    if (baselineDescriptor.formulas.length !== candidateDescriptor.formulas.length) fail(`historical row ${baselineRow.number} formula count differs.`);
    for (const [formulaIndex, baselineFormula] of baselineDescriptor.formulas.entries()) {
      const candidateFormula = candidateDescriptor.formulas[formulaIndex];
      if (baselineFormula.prefix !== candidateFormula.prefix || baselineFormula.name !== candidateFormula.name || baselineFormula.attributes !== candidateFormula.attributes) fail(`historical row ${baselineRow.number} formula tag changed.`);
      const expectedFormula = baselineFormula.body === null || rowShift === 0 ? baselineFormula.body : shiftFormula(baselineFormula.body, insertions);
      if (candidateFormula.body !== expectedFormula) fail(`historical row ${baselineRow.number} formula transform differs.`);
      formulaCount += 1;
    }
    shiftedRowCount += 1;
  }
  const beforeReferenceTags = referenceTags(beforeXml); const afterReferenceTags = referenceTags(afterXml);
  if (beforeReferenceTags.length !== afterReferenceTags.length) fail("candidate worksheet reference-tag count differs.");
  for (const [index, tag] of beforeReferenceTags.entries()) {
    const expectedTag = shiftReferenceTag(tag, insertions, sheetName);
    if (afterReferenceTags[index] !== expectedTag) fail(`candidate worksheet reference tag ${index + 1} differs.`);
  }
  const beforeFormulas = formulaElements(beforeXml, "formula|formula1|formula2"); const afterFormulas = formulaElements(afterXml, "formula|formula1|formula2");
  if (beforeFormulas.length !== afterFormulas.length) fail("candidate worksheet rule-formula count differs.");
  for (const [index, formula] of beforeFormulas.entries()) {
    const candidateFormula = afterFormulas[index]; const expectedBody = formula.body === null ? formula.body : shiftFormula(formula.body, insertions);
    if (formula.prefix !== candidateFormula.prefix || formula.name !== candidateFormula.name || formula.attributes !== candidateFormula.attributes || candidateFormula.body !== expectedBody) fail(`candidate worksheet rule formula ${index + 1} differs.`);
  }
  const expectedMerges = [...scanMergeRefs(beforeXml).map((ref) => shiftMerge(ref, insertions)), ...batchMergeRefs];
  const candidateMerges = scanMergeRefs(afterXml);
  if (canonicalDigest(candidateMerges) !== canonicalDigest(expectedMerges)) fail("candidate merge coordinate transform differs.");
  const expectedDimension = dimensionReference(updateDimension(beforeXml, maxRow));
  if (dimensionReference(afterXml) !== expectedDimension) fail("candidate dimension transform differs.");
  const boundaryFacts = insertions.map((insertion) => {
    const predecessor = before.rows.filter((row) => row.number < insertion.beforeRow).at(-1) ?? null;
    const successor = before.rows.find((row) => row.number >= insertion.beforeRow) ?? null;
    const firstBatchRow = batchRows.find((row) => row.row === insertion.beforeRow + insertionShift(insertion.beforeRow - 1, insertions));
    if (!firstBatchRow) fail(`supplement insertion boundary ${insertion.beforeRow} has no candidate batch row.`);
    return {
      beforeRow: insertion.beforeRow,
      predecessor: predecessor?.number ?? null,
      successorBefore: successor?.number ?? null,
      successorAfter: successor ? successor.number + insertionShift(successor.number, insertions) : null,
      firstBatchRow: firstBatchRow.row,
      rowCount: insertion.transactions.length,
    };
  });
  const affectedBefore = before.rows.slice(preservedPrefixCount); const affectedAfter = historical.slice(preservedPrefixCount);
  const facts = {
    scope: "supplement-affected-suffix", baselineRowCount: before.rows.length, candidateRowCount: after.rows.length,
    preservedPrefixRowCount: preservedPrefixCount, historicalRowCountCompared: affectedBefore.length,
    shiftedHistoricalRowCount: shiftedRowCount, historicalCellCoordinateCount: cellCoordinateCount, historicalFormulaCount: formulaCount,
    worksheetReferenceTagCount: beforeReferenceTags.length, worksheetRuleFormulaCount: beforeFormulas.length, mergeReferenceCount: expectedMerges.length,
    boundaryDigest: canonicalDigest(boundaryFacts),
    candidateCoordinateDigest: canonicalDigest({
      batchRows: [...batchNumbers].sort((left, right) => left - right),
      affectedRows: affectedAfter.map((row, index) => ({ before: affectedBefore[index].number, after: row.number, explicit: row.explicitCoordinate })),
    }),
  };
  return { ...facts, factsDigest: canonicalDigest(facts) };
}

function patchWorksheet(worksheetXml, transactions, date1904, stylesXml, sheetName) {
  const captureDates = transactions.some((transaction) => transaction.reportingKind === "supplement");
  const currentIndex = captureDates ? null : scanCurrentAppendIndex(worksheetXml);
  const indexed = currentIndex ?? scanWorksheetIndex(worksheetXml, { captureDates: true });
  const bounds = currentIndex?.structural ?? locateSheetData(worksheetXml);
  const insertionPlan = buildInsertions(transactions, indexed.rows, date1904, indexed.mergeRefs);
  const insertions = insertionPlan.insertions;
  const renderedInsertions = new Map(); const batchRowXmlByRow = new Map(); const allBatchRows = []; const newMerges = []; const transformInsertions = []; let priorCount = 0; let styleRowsInspected = 0; let appendBoundary = null;
  for (const insertion of insertions) {
    const firstRow = insertion.beforeRow + priorCount;
    const standard = standardStyleRow(indexed.rows, insertion.beforeRow, indexed.mergeRefs, stylesXml);
    const rendered = renderBatchRows(insertion.transactions, firstRow, standard.styles, standard.height, date1904, bounds.prefix);
    renderedInsertions.set(insertion.beforeRow, rendered); allBatchRows.push(...rendered.batchRows); newMerges.push(...rendered.merges); priorCount += insertion.transactions.length;
    const styleWitness = currentIndex ? structuralRowWitness(currentIndex.structural.rows[standard.sourceOrdinal]) : null;
    transformInsertions.push({ beforeRow: insertion.beforeRow, rowCount: insertion.transactions.length, candidateStartRow: firstRow, candidateEndRow: firstRow + insertion.transactions.length - 1, transactionIds: insertion.transactions.map((item) => item.id), styleSource: { row: standard.sourceRow, height: standard.height, styles: standard.styles, witness: styleWitness } });
    for (const [index, batchRow] of rendered.batchRows.entries()) batchRowXmlByRow.set(batchRow.row, rendered.rows[index]);
    styleRowsInspected += standard.inspectedRowCount;
  }
  const rewrittenHistoricalRows = captureDates ? indexed.rows.filter((row) => insertionShift(row.number, insertions) > 0) : [];
  let changed; let baselineStructural = currentIndex?.structural ?? null;
  if (rewrittenHistoricalRows.length === 0) {
    const appended = insertions.flatMap((insertion) => renderedInsertions.get(insertion.beforeRow).rows).join("");
    const lastBusinessOrdinal = Math.max(-1, ...indexed.rows.filter((row) => row.number === insertionPlan.businessTailRow && row.hasBusinessPayload).map((row) => row.ordinal));
    const trailingRows = indexed.rows.filter((row) => row.ordinal > lastBusinessOrdinal);
    let insertionOffset = bounds.innerEnd;
    if (trailingRows.length) {
      for (const row of trailingRows) if (row.explicitCoordinate && row.number <= insertionPlan.appendRow) fail(`auxiliary row ${row.number} conflicts with append row ${insertionPlan.appendRow}.`);
      const structural = currentIndex?.structural ?? locateSheetDataRows(worksheetXml);
      if (structural.rows.length !== indexed.rows.length) fail(`managed worksheet SAX and structural row indexes differ (${indexed.rows.length}/${structural.rows.length}).`);
      insertionOffset = structural.rows[lastBusinessOrdinal + 1]?.start ?? bounds.innerEnd;
    }
    if (!captureDates) appendBoundary = { baselineInsertionOffset: insertionOffset, tail: structuralRowWitness(currentIndex.structural.rows[lastBusinessOrdinal]), trailing: structuralRowWitness(currentIndex.structural.rows[lastBusinessOrdinal + 1]) };
    changed = `${worksheetXml.slice(0, insertionOffset)}${appended}${worksheetXml.slice(insertionOffset)}`;
  } else {
    const structural = locateSheetDataRows(worksheetXml); baselineStructural = structural;
    if (structural.rows.length !== indexed.rows.length || structural.rows.some((row, index) => row.number !== indexed.rows[index].number)) fail(`managed worksheet SAX and structural row indexes differ (${indexed.rows.length}/${structural.rows.length}).`);
    for (const row of indexed.rows) if (insertionShift(row.number, insertions) > 0 && (!row.explicitCoordinate || !row.coordinateSafe || row.hasImplicitCellCoordinate)) fail(`supplement cannot safely shift coordinate-implicit row ${row.number}.`);
    const affectedNumbers = indexed.rows.filter((row) => insertionShift(row.number, insertions) > 0).map((row) => row.number);
    if (affectedNumbers.some((row, index) => index > 0 && row <= affectedNumbers[index - 1])) fail("supplement affected suffix has duplicate or out-of-order row coordinates.");
    const output = [worksheetXml.slice(0, structural.innerStart)]; let cursor = structural.innerStart; const pending = [...insertions];
    for (const row of structural.rows) {
      output.push(worksheetXml.slice(cursor, row.start));
      while (pending.length && pending[0].beforeRow <= row.number) output.push(...renderedInsertions.get(pending.shift().beforeRow).rows);
      output.push(shiftOriginalRow(row, insertions).xml); cursor = row.end;
    }
    output.push(worksheetXml.slice(cursor, structural.innerEnd));
    while (pending.length) output.push(...renderedInsertions.get(pending.shift().beforeRow).rows);
    output.push(worksheetXml.slice(structural.innerEnd)); changed = output.join("");
    changed = shiftWorksheetReferences(changed, insertions, sheetName);
  }
  changed = patchMergeCells(changed, indexed.mergeRefs, newMerges, captureDates ? insertions : [], bounds.prefix);
  const maxRow = Math.max(1, ...indexed.rows.filter((row) => row.hasBusinessPayload).map((row) => row.number + insertionShift(row.number, insertions)), ...allBatchRows.map((item) => item.row));
  changed = updateDimension(changed, maxRow);
  const localIndexDigest = canonicalDigest({
    mode: insertionPlan.requiresDateIndex ? "a-date-and-df-merge" : "append-tail-only",
    rows: indexed.rows.map((row) => ({ row: row.number, hasBusinessPayload: row.hasBusinessPayload, dateValue: captureDates ? row.dateValue : null })),
    expenseMerges: indexed.mergeRefs.filter((ref) => { const range = splitRange(ref); return range.startColumn <= 6 && range.endColumn >= 4; }),
  });
  const projectionBody = {
    batchRanges: contiguousRanges(allBatchRows.map((item) => item.row)), batchRows: allBatchRows, batchRowCount: allBatchRows.length,
    manifestRecordCount: transactions.length, transactionCount: transactions.length, baselineMaterialRowCount: insertionPlan.baselineMaterialRowCount,
    batchAmount: formatMilliunits(transactions.reduce((sum, item) => sum + item.milliunits, 0n)), localIndexDigest,
    locality: {
      indexMode: insertionPlan.requiresDateIndex ? "a-date-and-df-merge" : "append-tail-only", indexParser: insertionPlan.requiresDateIndex ? "bundled-sax" : "namespace-agnostic-structural", standardStyleWindowRadius: STANDARD_STYLE_WINDOW_RADIUS,
      baselineStructuralRowCount: indexed.rows.length, historicalBusinessValueReadCount: 0, styleRowsInspected,
      rewrittenHistoricalRowCount: rewrittenHistoricalRows.length, preservedHistoricalRowCount: indexed.rows.length - rewrittenHistoricalRows.length,
    },
  };
  const coordinateTransform = captureDates
    ? verifySupplementSuffixTransform(worksheetXml, changed, insertions, allBatchRows, newMerges, { maxRow, sheetName, beforeStructural: baselineStructural })
    : verifyAppendBoundaryTransform(worksheetXml, changed, batchRowXmlByRow, newMerges, maxRow, appendBoundary);
  const transformBody = {
    kind: "root-workbook-local-coordinate-transform-v1", indexMode: projectionBody.locality.indexMode, date1904, appendRow: insertionPlan.appendRow,
    businessTailRow: insertionPlan.businessTailRow, maxRow, insertions: transformInsertions, batchMergeRefs: newMerges, appendBoundary, coordinateTransform,
  };
  return {
    xml: changed, maxRow, projection: { ...projectionBody, batchProjectionDigest: canonicalDigest(projectionBody) }, batchRowXmlByRow, batchMergeRefs: newMerges,
    transform: { ...transformBody, transformDigest: canonicalDigest(transformBody) },
  };
}

function centralEntryFacts(zip) {
  const entries = [];
  for (const name of Object.keys(zip.files).filter((entryName) => !zip.files[entryName].dir).sort()) {
    const data = zip.files[name]._data; const crc32 = data?.crc32; const size = data?.uncompressedSize; const compressedSize = data?.compressedSize;
    if (!Number.isInteger(crc32) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(compressedSize) || compressedSize < 0) fail(`ZIP central metadata is unavailable for ${name}.`);
    const magic = data?.compression?.magic;
    const compressionMethod = typeof magic === "string" ? Buffer.from(magic, "binary").toString("hex") : Buffer.isBuffer(magic) ? magic.toString("hex") : null;
    if (!compressionMethod) fail(`ZIP compression metadata is unavailable for ${name}.`);
    entries.push({ name, crc32: (crc32 >>> 0).toString(16).padStart(8, "0"), size, compressedSize, compressionMethod });
  }
  return { partCount: entries.length, factsDigest: canonicalDigest(entries), inventoryDigest: canonicalDigest(entries.map((entry) => entry.name)), entries };
}

function compareUnchangedEntries(baselineFacts, candidateFacts, allowed) {
  if (baselineFacts.inventoryDigest !== candidateFacts.inventoryDigest) fail("candidate package entry inventory differs from baseline.");
  const afterByName = new Map(candidateFacts.entries.map((entry) => [entry.name, entry])); const untouched = [];
  for (const before of baselineFacts.entries) {
    if (allowed.has(before.name)) continue;
    const after = afterByName.get(before.name);
    if (!after || before.crc32 !== after.crc32 || before.size !== after.size) fail(`candidate changed untouched package entry ${before.name}.`);
    untouched.push({ name: before.name, crc32: before.crc32, size: before.size });
  }
  return { count: untouched.length, digest: canonicalDigest(untouched) };
}

function cellPayloads(rowXml) {
  const result = new Map();
  for (const match of rowXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?c\s*>)/giu)) {
    const tag = /^<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/iu.exec(match[0])?.[0] ?? match[0]; const attrs = attributes(tag); const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(attrs.get("r") ?? "");
    if (!coordinate || columnNumber(coordinate[1]) > 6) continue;
    const inline = [...match[0].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/giu)].map((item) => unxml(item[1])).join("");
    const value = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/iu.exec(match[0])?.[1] ?? null;
    result.set(columnNumber(coordinate[1]), { inline, value: value === null ? null : unxml(value) });
  }
  return result;
}

function projectCandidateBatchRows(worksheetXml, projection, date1904, { batchRowXmlByRow, batchMergeRefs }) {
  const batchBindings = new Map(projection.batchRows.map((item) => [item.row, item]));
  const groupRanges = batchMergeRefs.map(splitRange).filter((range) => range.startColumn <= 4 && range.endColumn >= 4);
  const records = []; const groupFacts = new Map(); let activeDate = null; let priorRangeEnd = 0;
  for (const rowNumber of [...batchBindings.keys()].sort((left, right) => left - right)) {
    if (rowNumber > priorRangeEnd + 1) activeDate = null;
    priorRangeEnd = rowNumber;
    const rowXml = batchRowXmlByRow.get(rowNumber); if (!rowXml || !worksheetXml.includes(rowXml)) fail(`candidate batch row ${rowNumber} is missing.`);
    const cells = cellPayloads(rowXml); const dateValue = cells.get(1)?.value;
    if (dateValue !== null && dateValue !== undefined) activeDate = serialToIso(dateValue, date1904);
    if (!activeDate) fail(`candidate batch row ${rowNumber} has no projected date.`);
    const groupRange = groupRanges.find((range) => range.startRow <= rowNumber && rowNumber <= range.endRow);
    const groupKey = groupRange ? `${groupRange.startRow}:${groupRange.endRow}` : String(rowNumber);
    if (!groupFacts.has(groupKey)) {
      const person = cells.get(5)?.inline; const classification = cells.get(6)?.inline;
      if (!person || !classification) fail(`candidate batch group ${groupKey} has no person or classification.`);
      groupFacts.set(groupKey, { person, classification });
    }
    const project = cells.get(2)?.inline; const amount = cells.get(3)?.value;
    if (!project || amount === null || amount === undefined) fail(`candidate batch row ${rowNumber} has no project or amount.`);
    const milliunits = parseMilliunits(amount, `candidate batch row ${rowNumber} amount`, { allowNegative: true }); const binding = batchBindings.get(rowNumber); const group = groupFacts.get(groupKey);
    const fingerprint = canonicalDigest({ transactionId: binding.transactionId, row: rowNumber, date: activeDate, project, amount, person: group.person, classification: group.classification });
    if (fingerprint !== binding.fingerprint) fail(`candidate batch row ${rowNumber} differs from its bound projection.`);
    records.push({ id: binding.transactionId, sourceOrder: records.length + 1, date: activeDate, project, amount, milliunits, person: group.person, classification: group.classification, settlement: `candidate-group-${groupKey}` });
  }
  if (records.length !== projection.batchRowCount) fail("candidate batch projection count differs.");
  return records;
}

async function createPreviewWorkbook({ transactions, date1904, template }) {
  const roles = template.styleRoles;
  const family = (role) => [0, 1, 2, 3].map((digits) => {
    const style = roles[`${role}${digits}`];
    if (!Number.isSafeInteger(style) || style < 0) fail(`preview template has no ${role}${digits} style.`);
    return style;
  });
  const styles = { 1: roles.date, 2: roles.text, 3: family("amount"), 4: family("total"), 5: roles.person, 6: roles.classification };
  const ordered = [...transactions];
  const rendered = renderBatchRows(ordered, 2, styles, template.definition.templateRowHeight, date1904, "", template.definition.outputMergePolicy);
  const headerStyles = [roles.headerDate, roles.headerText, roles.headerAmount, roles.headerAmount, roles.headerAmount, roles.headerText];
  const header = `<row r="1" ht="21.95" customHeight="1">${["日期", "支出明细", "支出金额", "合计", "支出人", "备注"].map((value, index) => tCell(`${columnName(index + 1)}1`, headerStyles[index], value)).join("")}</row>`;
  const mergeBlock = rendered.merges.length ? `<mergeCells count="${rendered.merges.length}">${rendered.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F${ordered.length + 1}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${template.columnsXml}<sheetData>${header}${rendered.rows.join("")}</sheetData>${mergeBlock}<pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/></worksheet>`;
  const stylesBytes = Buffer.from(template.stylesXml, "utf8");
  const themeBytes = template.themeXml ? Buffer.from(template.themeXml, "utf8") : null;
  const zip = new JSZip(); const sheetName = "本批总表增量";
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${themeBytes ? '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ""}</Types>`);
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${themeBytes ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' : ""}</Relationships>`);
  zip.file("xl/styles.xml", stylesBytes); if (themeBytes) zip.file("xl/theme/theme1.xml", themeBytes); zip.file("xl/worksheets/sheet1.xml", worksheet);
  return { bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" }), sheetName, endRow: ordered.length + 1, rangeAddress: `A1:F${ordered.length + 1}` };
}

async function writeExclusive(filePath, bytes) {
  let created = false;
  try {
    const handle = await fs.open(filePath, "wx", 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
  } catch (error) {
    if (created) {
      try { await fs.unlink(filePath); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw new Error(`${error instanceof Error ? error.message : String(error)}; incomplete exclusive-write cleanup: ${filePath}`, { cause: error }); }
    }
    throw error;
  }
}

function utf8PartFacts(value) {
  const bytes = Buffer.from(value, "utf8");
  return { sha256: sha256Bytes(bytes), size: bytes.length };
}

function createLocalPatchCertificate({ artifact, baselineStable, candidate, managed, updatedWorkbookXml, patch, baselineFacts, candidateFacts, untouched }) {
  const worksheetBefore = utf8PartFacts(managed.worksheetXml); const worksheetAfter = utf8PartFacts(patch.xml);
  const workbookBefore = utf8PartFacts(managed.workbookXml); const workbookAfter = utf8PartFacts(updatedWorkbookXml);
  const body = {
    kind: LOCAL_PATCH_CERTIFICATE_KIND, profileId: artifact.profileId,
    baseline: { sourceSha256: baselineStable.sha256, sourceSize: baselineStable.size },
    candidate: { sourceSha256: candidate.sha256, sourceSize: candidate.size },
    managedParts: {
      worksheet: { name: managed.worksheetPart, beforeSha256: worksheetBefore.sha256, beforeSize: worksheetBefore.size, afterSha256: worksheetAfter.sha256, afterSize: worksheetAfter.size },
      workbook: { name: managed.workbookPart, beforeSha256: workbookBefore.sha256, beforeSize: workbookBefore.size, afterSha256: workbookAfter.sha256, afterSize: workbookAfter.size },
    },
    package: {
      baselineFactsDigest: baselineFacts.factsDigest, candidateFactsDigest: candidateFacts.factsDigest,
      baselinePartCount: baselineFacts.partCount, candidatePartCount: candidateFacts.partCount,
      baselineInventoryDigest: baselineFacts.inventoryDigest, candidateInventoryDigest: candidateFacts.inventoryDigest,
      untouchedEntryDigest: untouched.digest, untouchedEntryCount: untouched.count,
    },
    projection: patch.projection, transform: patch.transform, transformDigest: patch.transform.transformDigest,
  };
  return deepFreeze({ ...body, certificateDigest: canonicalDigest(body) });
}

async function buildCandidate(artifact, certificate, stagingRoot, { onOwned, testHooks } = {}) {
  const traceStarted = performance.now(); const trace = [];
  const stable = await readStableBinaryFile(artifact.baselinePath, { maxBytes: MAX_STABLE_BINARY_BYTES });
  if (stable.sha256 !== artifact.baselineSha256 || stable.size !== artifact.baselineSize) fail(`${artifact.profileId} baseline SHA/size changed.`);
  const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
  const managed = await resolveManagedSheet(zip, artifact.profile);
  const baselineStylesXml = await textPart(zip, "xl/styles.xml", "baseline styles");
  const baselineFacts = centralEntryFacts(zip);
  const transactions = certificate.transactions.filter((item) => item.profileId === artifact.profileId);
  const patch = patchWorksheet(managed.worksheetXml, transactions, managed.date1904, baselineStylesXml, artifact.profile.managedRootSheetName);
  trace.push(["patch", performance.now() - traceStarted]);
  const updatedWorkbookXml = updatePrintArea(managed.workbookXml, artifact.profile.managedRootSheetName, patch.maxRow);
  zip.file(managed.worksheetPart, patch.xml, { createFolders: false });
  zip.file(managed.workbookPart, updatedWorkbookXml, { createFolders: false });
  const candidateBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 1 }, platform: "DOS" });
  trace.push(["generate", performance.now() - traceStarted]);
  const candidate = await writeExclusive(path.join(stagingRoot, `.${artifact.profileId}.${crypto.randomBytes(10).toString("hex")}.candidate.tmp.xlsx`), candidateBytes);
  onOwned?.(candidate);
  if (testHooks?.afterCandidateWritten) await testHooks.afterCandidateWritten({ profileId: artifact.profileId, candidate: { ...candidate } });
  const candidateZip = await JSZip.loadAsync(candidateBytes, { createFolders: false }); const candidateFacts = centralEntryFacts(candidateZip);
  trace.push(["candidate-central", performance.now() - traceStarted]);
  const untouched = compareUnchangedEntries(baselineFacts, candidateFacts, new Set([managed.worksheetPart, managed.workbookPart]));
  const localPatchCertificate = createLocalPatchCertificate({ artifact, baselineStable: stable, candidate, managed, updatedWorkbookXml, patch, baselineFacts, candidateFacts, untouched });
  const previewTemplate = await loadTemplateAsset("ledger-batch-preview");
  const previewTransactions = projectCandidateBatchRows(patch.xml, patch.projection, managed.date1904, patch);
  const preview = await createPreviewWorkbook({ transactions: previewTransactions, date1904: managed.date1904, template: previewTemplate });
  const previewState = await writeExclusive(path.join(stagingRoot, `${artifact.profileId}-本批总表增量.xlsx`), preview.bytes);
  onOwned?.(previewState);
  if (testHooks?.afterCandidatePreviewWritten) await testHooks.afterCandidatePreviewWritten({ profileId: artifact.profileId, preview: { ...previewState } });
  if (process.env.XHS_CANDIDATE_TRACE === "1") process.stderr.write(`candidate-build-trace ${JSON.stringify([...trace, ["complete", performance.now() - traceStarted]])}\n`);
  return { artifact, candidate, localPatchCertificate, preview: { ...previewState, sheetName: preview.sheetName, endRow: preview.endRow, rangeAddress: preview.rangeAddress } };
}

export function computeRootWorkbookAuditRequestDigest(request) { const body = clone(object(request, "audit request")); delete body.requestDigest; return canonicalDigest(body); }

function validateLocalPatchCertificate(raw, binding) {
  exact(raw, LOCAL_PATCH_CERTIFICATE_KEYS, `${binding.profileId} localPatchCertificate`);
  if (raw.kind !== LOCAL_PATCH_CERTIFICATE_KIND || raw.profileId !== binding.profileId) fail(`${binding.profileId} local patch certificate identity differs.`);
  const body = clone(raw); delete body.certificateDigest;
  if (canonicalDigest(body) !== sha(raw.certificateDigest, `${binding.profileId}.localPatchCertificate.certificateDigest`)) fail(`${binding.profileId} local patch certificate digest differs.`);
  for (const [field, expectedSha] of [["baseline", binding.baselineSha256], ["candidate", binding.candidateSha256]]) {
    exact(raw[field], LOCAL_PATCH_SOURCE_KEYS, `${binding.profileId}.${field}`);
    if (sha(raw[field].sourceSha256, `${binding.profileId}.${field}.sourceSha256`) !== expectedSha) fail(`${binding.profileId} local patch ${field} SHA differs.`);
    positive(raw[field].sourceSize, `${binding.profileId}.${field}.sourceSize`);
  }
  exact(raw.managedParts, new Set(["worksheet", "workbook"]), `${binding.profileId}.managedParts`);
  for (const partRole of ["worksheet", "workbook"]) {
    const part = raw.managedParts[partRole]; exact(part, LOCAL_PATCH_PART_KEYS, `${binding.profileId}.managedParts.${partRole}`); text(part.name, `${binding.profileId}.${partRole}.name`);
    for (const field of ["beforeSha256", "afterSha256"]) sha(part[field], `${binding.profileId}.${partRole}.${field}`);
    for (const field of ["beforeSize", "afterSize"]) positive(part[field], `${binding.profileId}.${partRole}.${field}`);
  }
  exact(raw.package, LOCAL_PATCH_PACKAGE_KEYS, `${binding.profileId}.package`);
  for (const field of ["baselineFactsDigest", "candidateFactsDigest", "baselineInventoryDigest", "candidateInventoryDigest", "untouchedEntryDigest"]) sha(raw.package[field], `${binding.profileId}.package.${field}`);
  for (const field of ["baselinePartCount", "candidatePartCount"]) positive(raw.package[field], `${binding.profileId}.package.${field}`);
  nonnegative(raw.package.untouchedEntryCount, `${binding.profileId}.package.untouchedEntryCount`);
  object(raw.projection, `${binding.profileId}.projection`); object(raw.transform, `${binding.profileId}.transform`);
  if (sha(raw.transformDigest, `${binding.profileId}.transformDigest`) !== raw.transform.transformDigest) fail(`${binding.profileId} local patch transform digest differs.`);
  const transformBody = clone(raw.transform); delete transformBody.transformDigest;
  if (canonicalDigest(transformBody) !== raw.transformDigest) fail(`${binding.profileId} local patch transform body differs.`);
  const projectionBody = clone(raw.projection); delete projectionBody.batchProjectionDigest;
  if (canonicalDigest(projectionBody) !== sha(raw.projection.batchProjectionDigest, `${binding.profileId}.projection.batchProjectionDigest`)) fail(`${binding.profileId} local patch projection digest differs.`);
  return deepFreeze(clone(raw));
}

function validateAuditRequest(raw) {
  exact(raw, AUDIT_REQUEST_KEYS, "audit request");
  if (raw.kind !== ROOT_WORKBOOK_AUDIT_REQUEST_KIND || !TOKEN_RE.test(raw.requestNonce ?? "") || computeRootWorkbookAuditRequestDigest(raw) !== raw.requestDigest) fail("audit request kind, nonce, or digest is invalid.");
  const profiles = array(raw.profiles, "audit request profiles");
  if (profiles.length < 1 || profiles.length > 3) fail("audit request profiles must contain one to three profiles.");
  for (const [index, profile] of profiles.entries()) {
    exact(profile, AUDIT_PROFILE_KEYS, `audit request profiles[${index}]`); text(profile.profileId, `${index}.profileId`); text(profile.baselinePath, `${index}.baselinePath`); text(profile.candidatePath, `${index}.candidatePath`); sha(profile.baselineSha256, `${index}.baselineSha256`); sha(profile.candidateSha256, `${index}.candidateSha256`);
    validateLocalPatchCertificate(profile.localPatchCertificate, profile);
  }
  return raw;
}

function localRowStyleFacts(rowXml, logicalRow) {
  const rowTag = /^<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>/iu.exec(rowXml)?.[0] ?? rowXml; const rowAttrs = attributes(rowTag);
  const spanStart = /^(\d+):\d+$/u.exec(rowAttrs.get("spans") ?? "")?.[1]; let nextColumn = spanStart ? Number(spanStart) : 1; const styles = new Map(); let hasBusinessPayload = false;
  for (const match of rowXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*?\/\s*>|<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?c\s*>/giu)) {
    const tag = /^<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*>/iu.exec(match[0])?.[0] ?? match[0]; const attrs = attributes(tag); const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(attrs.get("r") ?? "");
    const column = coordinate ? columnNumber(coordinate[1]) : nextColumn; if (coordinate && Number(coordinate[2]) !== logicalRow) fail(`witnessed style row ${logicalRow} has a foreign cell coordinate.`);
    nextColumn = column + 1;
    if (column <= 6) { styles.set(column, Number(attrs.get("s") ?? "0")); if (/<(?:[A-Za-z_][\w.-]*:)?(?:v|f|is)\b/iu.test(match[0])) hasBusinessPayload = true; }
  }
  return { height: rowAttrs.get("ht") ?? null, styles, hasBusinessPayload };
}

function auditCurrentAppendPatch({ baselineXml, candidateXml, transactions, date1904, stylesXml, certificate }) {
  const transformBinding = certificate.transform; const projection = certificate.projection;
  if (transformBinding.indexMode !== "append-tail-only" || projection.locality?.indexMode !== "append-tail-only" || transactions.some((item) => item.reportingKind !== "current")) fail("current append local certificate mode differs.");
  const ordered = [...transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
  if (transformBinding.insertions.length !== 1) fail("current append must have exactly one local insertion.");
  const insertion = transformBinding.insertions[0];
  if (transformBinding.appendRow !== transformBinding.businessTailRow + 1 || insertion.beforeRow !== transformBinding.appendRow || insertion.candidateStartRow !== insertion.beforeRow || insertion.candidateEndRow !== insertion.candidateStartRow + ordered.length - 1 || insertion.rowCount !== ordered.length || canonicalDigest(insertion.transactionIds) !== canonicalDigest(ordered.map((item) => item.id))) fail("current append insertion boundary differs.");
  if (transformBinding.appendBoundary?.tail?.number !== transformBinding.businessTailRow) fail("current append tail witness differs.");
  const tailXml = witnessedRowXml(baselineXml, transformBinding.appendBoundary.tail, "current append tail");
  if (!localRowStyleFacts(tailXml, transformBinding.businessTailRow).hasBusinessPayload) fail("current append tail witness has no A:F payload.");
  const styleSource = insertion.styleSource; const styleXml = witnessedRowXml(baselineXml, styleSource.witness, "current append style source"); const styleFacts = localRowStyleFacts(styleXml, styleSource.row);
  if (styleSource.witness.number !== styleSource.row || Math.abs(styleSource.row - insertion.beforeRow) > STANDARD_STYLE_WINDOW_RADIUS || styleFacts.height !== styleSource.height || canonicalDigest(Object.fromEntries(styleFacts.styles)) !== canonicalDigest(styleSource.styles) || !styleFacts.hasBusinessPayload) fail("current append style witness differs.");
  const white = whiteStyleIndexes(stylesXml);
  if (!Array.from({ length: 6 }, (_, index) => styleFacts.styles.get(index + 1)).every((style) => style !== undefined && white.has(style))) fail("current append style witness is not a whole white row.");
  for (const ref of scanMergeRefs(baselineXml)) { const range = splitRange(ref); if (range.startColumn <= 6 && range.endColumn >= 1 && range.startRow <= styleSource.row && styleSource.row <= range.endRow) fail("current append style witness intersects a business merge."); }
  const rendered = renderBatchRows(ordered, insertion.candidateStartRow, styleSource.styles, styleSource.height, date1904, locateSheetData(baselineXml).prefix);
  const expectedRows = new Map(rendered.batchRows.map((row, index) => [row.row, rendered.rows[index]]));
  const expectedBatchBody = {
    batchRanges: contiguousRanges(rendered.batchRows.map((item) => item.row)), batchRows: rendered.batchRows, batchRowCount: rendered.batchRows.length,
    manifestRecordCount: ordered.length, transactionCount: ordered.length, batchAmount: formatMilliunits(ordered.reduce((sum, item) => sum + item.milliunits, 0n)),
  };
  for (const [field, expected] of Object.entries(expectedBatchBody)) if (canonicalDigest(projection[field]) !== canonicalDigest(expected)) fail(`current append projection ${field} differs.`);
  if (projection.locality.standardStyleWindowRadius !== STANDARD_STYLE_WINDOW_RADIUS || projection.locality.historicalBusinessValueReadCount !== 0 || projection.locality.rewrittenHistoricalRowCount !== 0 || projection.locality.styleRowsInspected > STANDARD_STYLE_WINDOW_RADIUS || projection.locality.preservedHistoricalRowCount !== projection.locality.baselineStructuralRowCount) fail("current append projection locality differs.");
  const coordinateTransform = verifyAppendBoundaryTransform(baselineXml, candidateXml, expectedRows, rendered.merges, transformBinding.maxRow, transformBinding.appendBoundary);
  const transformBody = {
    kind: "root-workbook-local-coordinate-transform-v1", indexMode: "append-tail-only", date1904, appendRow: transformBinding.appendRow,
    businessTailRow: transformBinding.businessTailRow, maxRow: transformBinding.maxRow, insertions: [{ ...insertion, styleSource: { row: styleSource.row, height: styleFacts.height, styles: Object.fromEntries(styleFacts.styles), witness: styleSource.witness } }],
    batchMergeRefs: rendered.merges, appendBoundary: transformBinding.appendBoundary, coordinateTransform,
  };
  const transform = { ...transformBody, transformDigest: canonicalDigest(transformBody) };
  if (canonicalDigest(transform) !== canonicalDigest(transformBinding) || transform.transformDigest !== certificate.transformDigest) fail("current append transform differs from its local boundary audit.");
  projectCandidateBatchRows(candidateXml, projection, date1904, { batchRowXmlByRow: expectedRows, batchMergeRefs: rendered.merges });
  return {
    projection: clone(projection), transform,
    operationCounts: {
      patchWorksheetCallCount: 0, historicalBusinessValueReadCount: 0, batchRowsParsed: rendered.batchRows.length,
      baselineStructuralRowsIndexed: 0, coordinateRowsCompared: coordinateTransform.historicalRowCountCompared,
      historicalFormulasChecked: coordinateTransform.worksheetRuleFormulaCount, styleRowsInspected: 1,
    },
  };
}

function auditLocalWorksheetPatch({ baselineXml, candidateXml, transactions, date1904, stylesXml, certificate, sheetName }) {
  const detailTraceStarted = performance.now(); const detailTrace = [];
  const captureDates = transactions.some((transaction) => transaction.reportingKind === "supplement");
  if (!captureDates) return auditCurrentAppendPatch({ baselineXml, candidateXml, transactions, date1904, stylesXml, certificate });
  const currentIndex = captureDates ? null : scanCurrentAppendIndex(baselineXml);
  const indexed = currentIndex ?? scanWorksheetIndex(baselineXml, { captureDates: true });
  detailTrace.push(["baseline-index", performance.now() - detailTraceStarted]);
  const bounds = currentIndex?.structural ?? locateSheetData(baselineXml);
  const insertionPlan = buildInsertions(transactions, indexed.rows, date1904, indexed.mergeRefs); const insertions = insertionPlan.insertions;
  const allBatchRows = []; const batchMergeRefs = []; const expectedRows = new Map(); const transformInsertions = []; let priorCount = 0; let styleRowsInspected = 0;
  for (const insertion of insertions) {
    const firstRow = insertion.beforeRow + priorCount; const standard = standardStyleRow(indexed.rows, insertion.beforeRow, indexed.mergeRefs, stylesXml);
    const rendered = renderBatchRows(insertion.transactions, firstRow, standard.styles, standard.height, date1904, bounds.prefix);
    for (const [index, batchRow] of rendered.batchRows.entries()) expectedRows.set(batchRow.row, rendered.rows[index]);
    allBatchRows.push(...rendered.batchRows); batchMergeRefs.push(...rendered.merges);
    transformInsertions.push({ beforeRow: insertion.beforeRow, rowCount: insertion.transactions.length, candidateStartRow: firstRow, candidateEndRow: firstRow + insertion.transactions.length - 1, transactionIds: insertion.transactions.map((item) => item.id), styleSource: { row: standard.sourceRow, height: standard.height, styles: standard.styles, witness: null } });
    priorCount += insertion.transactions.length; styleRowsInspected += standard.inspectedRowCount;
  }
  detailTrace.push(["batch-render", performance.now() - detailTraceStarted]);
  const candidateStructural = locateSheetDataRows(candidateXml); const candidateRows = candidateStructural.rows; const actualRows = new Map();
  for (const row of candidateRows) if (expectedRows.has(row.number)) {
    if (actualRows.has(row.number)) fail(`candidate batch row ${row.number} is duplicate.`);
    actualRows.set(row.number, row.xml);
  }
  for (const [row, expectedXml] of expectedRows) if (actualRows.get(row) !== expectedXml) fail(`candidate batch row ${row} differs from its independently rendered batch row.`);
  detailTrace.push(["candidate-index", performance.now() - detailTraceStarted]);
  const rewrittenHistoricalRowCount = captureDates ? indexed.rows.filter((row) => insertionShift(row.number, insertions) > 0).length : 0;
  const localIndexDigest = canonicalDigest({
    mode: insertionPlan.requiresDateIndex ? "a-date-and-df-merge" : "append-tail-only",
    rows: indexed.rows.map((row) => ({ row: row.number, hasBusinessPayload: row.hasBusinessPayload, dateValue: captureDates ? row.dateValue : null })),
    expenseMerges: indexed.mergeRefs.filter((ref) => { const range = splitRange(ref); return range.startColumn <= 6 && range.endColumn >= 4; }),
  });
  const projectionBody = {
    batchRanges: contiguousRanges(allBatchRows.map((item) => item.row)), batchRows: allBatchRows, batchRowCount: allBatchRows.length,
    manifestRecordCount: transactions.length, transactionCount: transactions.length, baselineMaterialRowCount: insertionPlan.baselineMaterialRowCount,
    batchAmount: formatMilliunits(transactions.reduce((sum, item) => sum + item.milliunits, 0n)), localIndexDigest,
    locality: {
      indexMode: insertionPlan.requiresDateIndex ? "a-date-and-df-merge" : "append-tail-only", indexParser: insertionPlan.requiresDateIndex ? "bundled-sax" : "namespace-agnostic-structural", standardStyleWindowRadius: STANDARD_STYLE_WINDOW_RADIUS,
      baselineStructuralRowCount: indexed.rows.length, historicalBusinessValueReadCount: 0, styleRowsInspected,
      rewrittenHistoricalRowCount, preservedHistoricalRowCount: indexed.rows.length - rewrittenHistoricalRowCount,
    },
  };
  const projection = { ...projectionBody, batchProjectionDigest: canonicalDigest(projectionBody) };
  if (canonicalDigest(projection) !== canonicalDigest(certificate.projection)) fail("candidate local patch projection differs from its independently audited projection.");
  const maxRow = Math.max(1, ...indexed.rows.filter((row) => row.hasBusinessPayload).map((row) => row.number + insertionShift(row.number, insertions)), ...allBatchRows.map((item) => item.row));
  const coordinateTransform = verifySupplementSuffixTransform(baselineXml, candidateXml, insertions, allBatchRows, batchMergeRefs, { maxRow, sheetName, afterStructural: candidateStructural });
  detailTrace.push(["coordinate-transform", performance.now() - detailTraceStarted]);
  const transformBody = {
    kind: "root-workbook-local-coordinate-transform-v1", indexMode: projection.locality.indexMode, date1904, appendRow: insertionPlan.appendRow,
    businessTailRow: insertionPlan.businessTailRow, maxRow, insertions: transformInsertions, batchMergeRefs, appendBoundary: null, coordinateTransform,
  };
  const transform = { ...transformBody, transformDigest: canonicalDigest(transformBody) };
  if (canonicalDigest(transform) !== canonicalDigest(certificate.transform) || transform.transformDigest !== certificate.transformDigest) fail("candidate coordinate transform differs from its independently audited transform.");
  projectCandidateBatchRows(candidateXml, projection, date1904, { batchRowXmlByRow: actualRows, batchMergeRefs });
  if (process.env.XHS_CANDIDATE_TRACE === "1") process.stderr.write(`candidate-audit-local-trace ${JSON.stringify([...detailTrace, ["complete", performance.now() - detailTraceStarted]])}\n`);
  return {
    projection, transform,
    operationCounts: {
      patchWorksheetCallCount: 0, historicalBusinessValueReadCount: 0, batchRowsParsed: allBatchRows.length,
      baselineStructuralRowsIndexed: indexed.rows.length, coordinateRowsCompared: coordinateTransform.historicalRowCountCompared,
      historicalFormulasChecked: coordinateTransform.historicalFormulaCount + coordinateTransform.worksheetRuleFormulaCount,
      styleRowsInspected,
    },
  };
}

async function auditOne(binding, certificate, registry) {
  const traceStarted = performance.now(); const trace = [];
  const profile = registry.profiles[binding.profileId]; if (!profile) fail(`audit profile ${binding.profileId} is unknown.`);
  const localPatchCertificate = validateLocalPatchCertificate(binding.localPatchCertificate, binding);
  const [baselineStable, candidateStable] = await Promise.all([readStableBinaryFile(path.resolve(binding.baselinePath), { maxBytes: MAX_STABLE_BINARY_BYTES }), readStableBinaryFile(path.resolve(binding.candidatePath), { maxBytes: MAX_STABLE_BINARY_BYTES })]);
  if (baselineStable.sha256 !== binding.baselineSha256 || candidateStable.sha256 !== binding.candidateSha256 || baselineStable.size !== localPatchCertificate.baseline.sourceSize || candidateStable.size !== localPatchCertificate.candidate.sourceSize) fail(`${binding.profileId} audit source SHA/size changed.`);
  const [baselineZip, candidateZip] = await Promise.all([JSZip.loadAsync(copyStableBinaryBytes(baselineStable), { createFolders: false }), JSZip.loadAsync(copyStableBinaryBytes(candidateStable), { createFolders: false })]);
  trace.push(["zip-load", performance.now() - traceStarted]);
  const baselineFacts = centralEntryFacts(baselineZip); const candidateFacts = centralEntryFacts(candidateZip);
  const packageBinding = localPatchCertificate.package;
  if (baselineFacts.factsDigest !== packageBinding.baselineFactsDigest || candidateFacts.factsDigest !== packageBinding.candidateFactsDigest || baselineFacts.partCount !== packageBinding.baselinePartCount || candidateFacts.partCount !== packageBinding.candidatePartCount || baselineFacts.inventoryDigest !== packageBinding.baselineInventoryDigest || candidateFacts.inventoryDigest !== packageBinding.candidateInventoryDigest) fail(`${binding.profileId} ZIP central metadata differs from the local patch certificate.`);
  const baselineManaged = await resolveManagedSheet(baselineZip, profile); const candidateManaged = await resolveManagedSheet(candidateZip, profile);
  trace.push(["managed-parts", performance.now() - traceStarted]);
  if (baselineManaged.worksheetPart !== candidateManaged.worksheetPart || baselineManaged.workbookPart !== candidateManaged.workbookPart) fail("candidate managed part identity changed.");
  if (baselineManaged.worksheetPart !== localPatchCertificate.managedParts.worksheet.name || baselineManaged.workbookPart !== localPatchCertificate.managedParts.workbook.name) fail("local patch certificate managed part identity differs.");
  const untouched = compareUnchangedEntries(baselineFacts, candidateFacts, new Set([baselineManaged.worksheetPart, baselineManaged.workbookPart]));
  if (untouched.digest !== packageBinding.untouchedEntryDigest || untouched.count !== packageBinding.untouchedEntryCount) fail("candidate untouched ZIP entry digest differs.");
  for (const [role, beforeValue, afterValue] of [["worksheet", baselineManaged.worksheetXml, candidateManaged.worksheetXml], ["workbook", baselineManaged.workbookXml, candidateManaged.workbookXml]]) {
    const before = utf8PartFacts(beforeValue); const after = utf8PartFacts(afterValue); const expected = localPatchCertificate.managedParts[role];
    if (before.sha256 !== expected.beforeSha256 || before.size !== expected.beforeSize || after.sha256 !== expected.afterSha256 || after.size !== expected.afterSize) fail(`${binding.profileId} managed ${role} digest differs from the local patch certificate.`);
  }
  const transactions = certificate.transactions.filter((item) => item.profileId === binding.profileId);
  const baselineStylesXml = await textPart(baselineZip, "xl/styles.xml", "baseline styles");
  if (baselineManaged.date1904 !== candidateManaged.date1904) fail("candidate workbook date system changed.");
  const localAudit = auditLocalWorksheetPatch({ baselineXml: baselineManaged.worksheetXml, candidateXml: candidateManaged.worksheetXml, transactions, date1904: baselineManaged.date1904, stylesXml: baselineStylesXml, certificate: localPatchCertificate, sheetName: profile.managedRootSheetName });
  trace.push(["local-audit", performance.now() - traceStarted]);
  if (candidateManaged.workbookXml !== updatePrintArea(baselineManaged.workbookXml, profile.managedRootSheetName, localAudit.transform.maxRow)) fail(`${binding.profileId} candidate workbook metadata is not the local print-area patch.`);
  const transitionDigest = canonicalDigest({ baselineSha256: baselineStable.sha256, candidateSha256: candidateStable.sha256, projection: localAudit.projection, transformDigest: localAudit.transform.transformDigest });
  const body = {
    kind: BUSINESS_AUDIT_KIND, requiresGate1Binding: true, auditScope: "batch-local-increment-only",
    profile: { profileId: profile.profileId, targetCategory: profile.targetCategory, canonicalRootWorkbookName: profile.canonicalRootWorkbookName, managedRootSheetName: profile.managedRootSheetName },
    manifest: { certificateDigest: certificate.raw.certificateDigest, factsDigest: certificate.raw.factsDigest, sourceCoverageDigest: certificate.raw.sourceCoverageDigest, profileConfigDigest: certificate.raw.profileConfigDigest, batchId: certificate.raw.factsPreimage.batchId },
    baseline: { sourceSize: baselineStable.size, sourceSha256: baselineStable.sha256, factsDigest: baselineFacts.factsDigest, partCount: baselineFacts.partCount },
    candidate: { sourceSize: candidateStable.size, sourceSha256: candidateStable.sha256, factsDigest: candidateFacts.factsDigest, partCount: candidateFacts.partCount },
    transitionDigest, localPatchCertificateDigest: localPatchCertificate.certificateDigest, transformDigest: localAudit.transform.transformDigest,
    sourceCoverage: certificate.raw.sourceCoveragePreimage.transactionSourceRefs.filter((item) => transactions.some((transaction) => transaction.id === item.transactionId)),
    projection: localAudit.projection,
    localIndexDigest: localAudit.projection.localIndexDigest,
    unchangedPartsDigest: untouched.digest,
    unchangedPartCount: untouched.count,
    auditOperations: { ...localAudit.operationCounts, zipEntryMetadataReadCount: baselineFacts.partCount + candidateFacts.partCount, zipEntryPayloadInflateCount: 7 },
  };
  if (process.env.XHS_CANDIDATE_TRACE === "1") process.stderr.write(`candidate-audit-trace ${JSON.stringify([...trace, ["complete", performance.now() - traceStarted]])}\n`);
  return { ...body, auditDigest: canonicalDigest(body) };
}

function verifyAuditBody(audit, binding, certificate) {
  object(audit, `${binding.profileId} audit`); const body = clone(audit); delete body.auditDigest;
  if (audit.kind !== BUSINESS_AUDIT_KIND || audit.requiresGate1Binding !== true || canonicalDigest(body) !== audit.auditDigest) fail(`${binding.profileId} worker audit is invalid.`);
  if (audit.profile?.profileId !== binding.profileId || audit.baseline?.sourceSha256 !== binding.baselineSha256 || audit.candidate?.sourceSha256 !== binding.candidateSha256) fail(`${binding.profileId} worker audit binding differs.`);
  for (const field of ["certificateDigest", "factsDigest", "sourceCoverageDigest", "profileConfigDigest"]) if (audit.manifest?.[field] !== certificate[field]) fail(`${binding.profileId} audit ${field} differs.`);
  if (audit.localPatchCertificateDigest !== binding.localPatchCertificate.certificateDigest || audit.transformDigest !== binding.localPatchCertificate.transformDigest) fail(`${binding.profileId} worker local patch binding differs.`);
  return clone(audit);
}

export function validateRootWorkbookAuditBatch(response, options) {
  exact(response, AUDIT_BATCH_KEYS, "audit worker response");
  if (response.kind !== ROOT_WORKBOOK_AUDIT_BATCH_KIND) fail("audit worker response kind is unsupported.");
  for (const field of ["requestDigest", "requestFileSha256", "requestNonce"]) if (response[field] !== options[field]) fail(`audit worker ${field} binding differs.`);
  const rawAudits = array(response.audits, "audit worker audits"); if (rawAudits.length !== options.profileIds.length) fail("audit worker profile count differs.");
  return deepFreeze({ ...clone(response), audits: rawAudits.map((audit, index) => verifyAuditBody(audit, options.profileBindings[index], options.certificate)) });
}

async function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") await new Promise((resolve) => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" }); killer.once("close", resolve); killer.once("error", resolve); });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} }
}

export async function runRootWorkbookAuditWorker({ requestPath, requestBody, requestFileSha256, requestNonce, timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, stdoutMaxBytes = MAX_WORKER_STDOUT_BYTES, stderrMaxBytes = MAX_WORKER_STDERR_BYTES, workerScriptPath = BUILDER_PATH } = {}) {
  const absoluteRequest = requestBody ? null : path.resolve(text(requestPath, "worker requestPath")); sha(requestFileSha256, "worker requestFileSha256"); if (!TOKEN_RE.test(requestNonce ?? "")) fail("worker requestNonce is invalid.");
  if (requestBody && sha256Bytes(jsonBytes(requestBody)) !== requestFileSha256) fail("in-memory audit request SHA differs.");
  if (path.resolve(workerScriptPath) === BUILDER_PATH) {
    const worker = new Worker(pathToFileURL(BUILDER_PATH), { execArgv: [], workerData: { kind: "root-workbook-audit-thread-v1", requestPath: absoluteRequest, requestBody: requestBody ? clone(requestBody) : null, requestFileSha256, requestNonce }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (callback) => { if (done) return; done = true; clearTimeout(timer); callback(); };
      const timer = setTimeout(() => finish(() => { void worker.terminate(); reject(new Error("audit worker timed out")); }), timeoutMs);
      worker.once("message", (message) => finish(() => {
        if (!message?.ok) return reject(new Error(`audit worker failed: ${message?.error ?? "unknown error"}`));
        const out = `${JSON.stringify(message.response)}\n`; if (Buffer.byteLength(out) > stdoutMaxBytes) return reject(new Error("audit worker stdout exceeded its bounded limit"));
        resolve({ ...message.response, rawStdout: out });
      }));
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => { if (!done && code !== 0) finish(() => reject(new Error(`audit worker exited with code ${code}`))); });
    });
  }
  if (!absoluteRequest) fail("custom audit worker requires a requestPath.");
  const child = spawn(process.execPath, [path.resolve(workerScriptPath), "--audit-worker", "--request", absoluteRequest, "--request-sha256", requestFileSha256, "--request-nonce", requestNonce], { shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let done = false; let stopReason;
    const terminate = (reason) => { stopReason ??= reason; void killProcessTree(child); };
    const timer = setTimeout(() => terminate(new Error("audit worker timed out")), timeoutMs);
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes > stdoutMaxBytes) terminate(new Error("audit worker stdout exceeded its bounded limit")); else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > stderrMaxBytes) terminate(new Error("audit worker stderr exceeded its bounded limit")); else stderr.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); if (!done) { done = true; reject(error); } });
    child.once("close", (code, signal) => { clearTimeout(timer); if (done) return; done = true; if (stopReason) return reject(stopReason); const out = Buffer.concat(stdout).toString("utf8"); const err = Buffer.concat(stderr).toString("utf8"); if (code !== 0 || signal || err) return reject(new Error(`audit worker failed (${code ?? signal}): ${err.trim()}`)); const lines = out.split(/\r?\n/u).filter(Boolean); if (lines.length !== 1) return reject(new Error("audit worker stdout must contain one JSON line")); try { resolve({ ...parseStrictJson(lines[0]), rawStdout: out }); } catch (error) { reject(new Error("audit worker stdout is not strict JSON", { cause: error })); } });
  });
}

async function cleanupOwned(owned, stagingRoot) {
  const preserved = []; const failures = [];
  for (const entry of [...owned].reverse()) { try { const current = await readStableBinaryFile(entry.path).catch(() => null); if (!current) continue; if (current.sha256 !== entry.sha256 || current.size !== entry.size) { preserved.push(entry.path); continue; } await fs.unlink(entry.path); } catch (error) { failures.push({ path: entry.path, error }); } }
  try { await fs.rmdir(stagingRoot); } catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") failures.push({ path: stagingRoot, error }); }
  return { preserved, failures };
}

function candidateFilename(profile, revision) { return `${profile.archiveStem}_候选修订${revision}.xlsx`; }
function planFilename(profile, revision) { return `${profile.archiveStem}_候选修订${revision}.root-plan.json`; }

export async function buildRootWorkbookCandidates(request, { testHooks } = {}) {
  const registry = await loadProfileRegistry(); const checked = validateBuildRequest(clone(request), registry); const stagingRoot = path.join(path.resolve(os.tmpdir()), `${STAGING_PREFIX}${checked.stagingToken}`); const owned = [];
  try {
    await fs.mkdir(stagingRoot, { recursive: false });
    const marker = await writeExclusive(path.join(stagingRoot, ".codex-xhs-owner.json"), jsonBytes({ kind: "root-workbook-staging-owner-v2", stagingToken: checked.stagingToken, pid: process.pid })); owned.push(marker);
    const builtSet = await mapSettledLimit(checked.artifacts, 3, (artifact) => buildCandidate(artifact, checked.certificate, stagingRoot, { onOwned: (entry) => owned.push(entry), testHooks })); const built = builtSet.settled.map((entry) => entry.value);
    const requestNonce = crypto.randomBytes(32).toString("hex");
    const workerRequest = { kind: ROOT_WORKBOOK_AUDIT_REQUEST_KIND, requestNonce, reimbursementFactsCertificate: checked.certificate.raw, profiles: built.map((item) => ({ profileId: item.artifact.profileId, baselinePath: item.artifact.baselinePath, baselineSha256: item.artifact.baselineSha256, candidatePath: item.candidate.path, candidateSha256: item.candidate.sha256, localPatchCertificate: item.localPatchCertificate })) };
    workerRequest.requestDigest = computeRootWorkbookAuditRequestDigest(workerRequest);
    const requestBytes = jsonBytes(workerRequest); const requestFileSha256 = sha256Bytes(requestBytes); let requestPath;
    if (testHooks?.afterWorkerRequestWritten) { const requestEntry = await writeExclusive(path.join(stagingRoot, `.audit-request.${requestNonce}.json`), requestBytes); owned.push(requestEntry); requestPath = requestEntry.path; await testHooks.afterWorkerRequestWritten({ requestPath, requestBody: clone(workerRequest) }); }
    const raw = await runRootWorkbookAuditWorker({ requestPath, requestBody: requestPath ? undefined : workerRequest, requestFileSha256, requestNonce }); const { rawStdout: _rawStdout, ...response } = raw;
    const auditBatch = validateRootWorkbookAuditBatch(response, { requestDigest: workerRequest.requestDigest, requestFileSha256, requestNonce, profileIds: checked.profileIds, profileBindings: workerRequest.profiles, certificate: checked.certificate.raw });
    const committed = [];
    for (const [index, item] of built.entries()) {
      const audit = auditBatch.audits[index];
      const final = { ...item.candidate, path: path.join(stagingRoot, candidateFilename(item.artifact.profile, item.artifact.candidateRevision)) };
      const candidateOwnedIndex = owned.findIndex((entry) => entry.path === item.candidate.path && entry.sha256 === item.candidate.sha256);
      if (candidateOwnedIndex < 0) fail(`owned candidate is missing before commit for ${item.artifact.profileId}.`);
      await fs.rename(item.candidate.path, final.path);
      owned[candidateOwnedIndex] = final;
      const planBody = { kind: "root-workbook-local-increment-plan-v2", requiresGate1Binding: true, profile: audit.profile, manifest: audit.manifest, baseline: audit.baseline, candidate: { path: final.path, sha256: final.sha256, size: final.size, factsDigest: audit.candidate.factsDigest }, preview: item.preview, transitionDigest: audit.transitionDigest, localPatchCertificate: item.localPatchCertificate, audit, candidateRevision: item.artifact.candidateRevision, stagingOwnership: { token: checked.stagingToken, ownerMarkerSha256: marker.sha256 } };
      const plan = { ...planBody, planDigest: canonicalDigest(planBody) }; const planEntry = await writeExclusive(path.join(stagingRoot, planFilename(item.artifact.profile, item.artifact.candidateRevision)), jsonBytes(plan)); owned.push(planEntry);
      committed.push({ profileId: item.artifact.profileId, candidateRevision: item.artifact.candidateRevision, candidatePath: final.path, candidateSha256: final.sha256, candidateSize: final.size, candidateFactsDigest: audit.candidate.factsDigest, localPatchCertificate: item.localPatchCertificate, previewPath: item.preview.path, previewSha256: item.preview.sha256, previewSize: item.preview.size, previewSheetName: item.preview.sheetName, previewRangeAddress: item.preview.rangeAddress, previewEndRow: item.preview.endRow, planPath: planEntry.path, planSha256: planEntry.sha256, planSize: planEntry.size, planDigest: plan.planDigest, audit });
    }
    return deepFreeze({ kind: ROOT_WORKBOOK_BUILD_RESULT_KIND, requiresGate1Binding: true, stagingRoot, stagingToken: checked.stagingToken, requestDigest: workerRequest.requestDigest, requestFileSha256, auditBatchDigest: canonicalDigest(auditBatch), artifacts: committed, ownedFiles: owned.map((item) => ({ path: item.path, sha256: item.sha256, size: item.size })) });
  } catch (reason) {
    const cleanup = await cleanupOwned(owned, stagingRoot); const message = reason instanceof Error ? reason.message : String(reason);
    if (cleanup.preserved.length || cleanup.failures.length) fail(`${message}; cleanup incomplete: ${[...cleanup.preserved, ...cleanup.failures.map((item) => item.path)].join(", ")}`);
    throw reason;
  }
}

async function executeAuditWorker({ requestPath: rawRequestPath, requestBody, requestFileSha256, requestNonce }) {
  const expectedSha = sha(requestFileSha256, "audit worker expected request SHA"); const expectedNonce = text(requestNonce, "audit worker expected nonce");
  const snapshot = requestBody ? { value: clone(requestBody), sha256: sha256Bytes(jsonBytes(requestBody)) } : await readStableUtf8JsonFile(path.resolve(rawRequestPath), { maxBytes: MAX_JSON_BYTES });
  if (snapshot.sha256 !== expectedSha) fail("audit request file SHA differs.");
  const request = validateAuditRequest(snapshot.value); if (request.requestNonce !== expectedNonce) fail("audit request nonce differs.");
  const registry = await loadProfileRegistry(); const certificate = validateCertificate(request.reimbursementFactsCertificate, registry); const expectedOrder = registry.profileOrder.filter((profileId) => request.profiles.some((item) => item.profileId === profileId)); if (canonicalDigest(expectedOrder) !== canonicalDigest(request.profiles.map((item) => item.profileId))) fail("audit profiles are outside registry order.");
  const settled = await mapSettledLimit(request.profiles, 3, (profile) => auditOne(profile, certificate, registry));
  return { kind: ROOT_WORKBOOK_AUDIT_BATCH_KIND, requestDigest: request.requestDigest, requestFileSha256: snapshot.sha256, requestNonce: request.requestNonce, audits: settled.settled.map((entry) => entry.value) };
}

async function auditWorkerMain(args) {
  if (args.length !== 7 || args[0] !== "--audit-worker" || args[1] !== "--request" || args[3] !== "--request-sha256" || args[5] !== "--request-nonce") fail("audit worker arguments are invalid.");
  process.stdout.write(`${JSON.stringify(await executeAuditWorker({ requestPath: args[2], requestFileSha256: args[4], requestNonce: args[6] }))}\n`);
}

async function main() {
  const args = process.argv.slice(2); if (args[0] === "--audit-worker") return auditWorkerMain(args);
  if (args.length !== 2 || args[0] !== "--input") fail("usage: build_root_workbook_candidate.mjs --input <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_JSON_BYTES }); process.stdout.write(`${JSON.stringify(await buildRootWorkbookCandidates(input.value))}\n`);
}

if (!isMainThread && workerData?.kind === "root-workbook-audit-thread-v1") {
  executeAuditWorker(workerData).then((response) => parentPort.postMessage({ ok: true, response })).catch((error) => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
}
