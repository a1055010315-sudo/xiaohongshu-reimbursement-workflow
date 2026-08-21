import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const BUILD_REQUEST_KEYS = new Set(["kind", "stagingToken", "reimbursementFactsCertificate", "artifacts"]);
const ARTIFACT_KEYS = new Set(["profileId", "baselinePath", "baselineSha256", "baselineSize", "candidateRevision"]);
const CERTIFICATE_KEYS = new Set([
  "kind", "operationMode", "manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest",
  "factsDigest", "factsPreimage", "sourceCoverageDigest", "sourceCoveragePreimage", "certificateDigest",
]);
const AUDIT_REQUEST_KEYS = new Set(["kind", "requestNonce", "reimbursementFactsCertificate", "profiles", "requestDigest"]);
const AUDIT_PROFILE_KEYS = new Set(["profileId", "baselinePath", "baselineSha256", "candidatePath", "candidateSha256"]);
const AUDIT_BATCH_KEYS = new Set(["kind", "requestDigest", "requestFileSha256", "requestNonce", "audits"]);

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

async function textPart(zip, partName, field) {
  const entry = zip.file(partName);
  if (!entry) fail(`${field} is missing package part ${partName}.`);
  return entry.async("string");
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

function parseRows(worksheetXml) {
  const sheetDataMatch = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/iu.exec(worksheetXml);
  if (!sheetDataMatch) fail("managed worksheet has no sheetData.");
  const rows = [];
  for (const match of sheetDataMatch[1].matchAll(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/gu)) {
    const rowTag = /^<row\b[^>]*>/u.exec(match[0])?.[0] ?? match[0];
    const rowAttrs = attributes(rowTag);
    const number = Number(rowAttrs.get("r"));
    if (!Number.isSafeInteger(number) || number < 1) fail("managed worksheet row is missing an explicit coordinate.");
    const cells = [];
    for (const cellMatch of match[0].matchAll(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/gu)) {
      const tag = /^<c\b[^>]*>/u.exec(cellMatch[0])?.[0] ?? cellMatch[0];
      const attrs = attributes(tag);
      const ref = attrs.get("r");
      const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(ref ?? "");
      if (!coordinate) fail("managed worksheet cell is missing an explicit A1 coordinate.");
      cells.push({ xml: cellMatch[0], ref, column: columnNumber(coordinate[1]), row: Number(coordinate[2]), style: attrs.has("s") ? Number(attrs.get("s")) : 0, value: /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/iu.exec(cellMatch[0])?.[1] ?? null, hasPayload: /<(?:\w+:)?(?:v|f|is)\b/iu.test(cellMatch[0]) });
    }
    rows.push({ number, xml: match[0], cells, height: rowAttrs.get("ht") ?? null });
  }
  rows.sort((left, right) => left.number - right.number);
  if (new Set(rows.map((row) => row.number)).size !== rows.length) fail("managed worksheet contains duplicate row coordinates.");
  return { match: sheetDataMatch, rows };
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
    const dateCell = row.cells.find((cell) => cell.column === 1);
    if (dateCell?.value !== null) activeDate = serialToIso(unxml(dateCell.value), date1904) ?? activeDate;
    if (row.number > 1 && row.cells.some((cell) => cell.column <= 6 && cell.hasPayload)) result.push({ ...row, date: activeDate });
  }
  return result;
}

function parseMergeRefs(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*"([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)"[^>]*\/>/gu)].map((match) => match[1]);
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

function buildInsertions(transactions, baselineRows, merges) {
  const appendRow = (baselineRows.at(-1)?.number ?? 1) + 1;
  const byRow = new Map();
  for (const transaction of [...transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder)) {
    const beforeRow = transaction.reportingKind === "supplement" ? chooseInsertionRow(transaction.date, baselineRows, merges) : appendRow;
    if (!byRow.has(beforeRow)) byRow.set(beforeRow, []);
    byRow.get(beforeRow).push(transaction);
  }
  return [...byRow].sort(([left], [right]) => left - right).map(([beforeRow, items]) => ({ beforeRow, transactions: items.sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder) }));
}

function whiteStyleIndexes(stylesXml) {
  const block = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/iu.exec(stylesXml)?.[1];
  if (!block) fail("baseline styles have no cellXfs collection.");
  const result = new Set();
  let index = 0;
  for (const match of block.matchAll(/<(?:\w+:)?xf\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/gu)) {
    const fillId = Number(attributes(/^<(?:\w+:)?xf\b[^>]*>/u.exec(match[0])?.[0] ?? match[0]).get("fillId") ?? "0");
    if (fillId === 0) result.add(index);
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
  const candidates = rows.filter((row) => {
    const cells = Array.from({ length: 6 }, (_, index) => row.cells.find((cell) => cell.column === index + 1));
    return cells.every((cell) => cell && white.has(cell.style)) && row.height !== null && !intersectsBusinessMerge(row);
  });
  const selected = candidates.sort((left, right) => Math.abs(left.number - insertionRow) - Math.abs(right.number - insertionRow) || right.number - left.number)[0];
  if (!selected) fail(`no whole white standard data row is available near insertion row ${insertionRow}.`);
  return {
    styles: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, selected.cells.find((cell) => cell.column === index + 1).style])),
    height: selected.height,
    sourceRow: selected.number,
  };
}

function isoToSerial(value, date1904) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) fail(`transaction date ${value} is invalid.`);
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) + (date1904 ? 24_107 : 25_569);
}

function tCell(ref, style, value) { return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`; }
function nCell(ref, style, value) { return `<c r="${ref}" s="${style}" t="n"><v>${xml(value)}</v></c>`; }
function fCell(ref, style, formula, cached) { return `<c r="${ref}" s="${style}" t="n"><f>${xml(formula)}</f><v>${xml(cached)}</v></c>`; }

function runs(items, key) {
  const result = [];
  for (let start = 0; start < items.length;) { let end = start; while (end + 1 < items.length && key(items[end + 1]) === key(items[start])) end += 1; result.push({ start, end }); start = end + 1; }
  return result;
}

function renderBatchRows(transactions, firstRow, styles, height, date1904) {
  const dateStarts = new Map(runs(transactions, (item) => item.date).map((run) => [run.start, run]));
  const groupStarts = new Map(runs(transactions, (item) => JSON.stringify([item.person, item.classification, item.settlement])).map((run) => [run.start, run]));
  const rows = []; const merges = []; const batchRows = [];
  for (const [index, transaction] of transactions.entries()) {
    const row = firstRow + index; const cells = [];
    const dateRun = dateStarts.get(index);
    if (dateRun) { cells.push(nCell(`A${row}`, styles[1], isoToSerial(transaction.date, date1904))); if (dateRun.end > dateRun.start) merges.push(`A${row}:A${row + dateRun.end - dateRun.start}`); }
    cells.push(tCell(`B${row}`, styles[2], transaction.project), nCell(`C${row}`, styles[3], transaction.amount));
    const groupRun = groupStarts.get(index);
    if (groupRun) {
      const endRow = row + groupRun.end - groupRun.start;
      const total = transactions.slice(groupRun.start, groupRun.end + 1).reduce((sum, item) => sum + item.milliunits, 0n);
      cells.push(fCell(`D${row}`, styles[4], `SUM(C${row}:C${endRow})`, formatMilliunits(total)), tCell(`E${row}`, styles[5], transaction.person), tCell(`F${row}`, styles[6], transaction.classification));
      if (endRow > row) for (const column of ["D", "E", "F"]) merges.push(`${column}${row}:${column}${endRow}`);
    }
    rows.push(`<row r="${row}" ht="${xml(height)}" customHeight="1">${cells.join("")}</row>`);
    batchRows.push({ transactionId: transaction.id, row, fingerprint: canonicalDigest({ transactionId: transaction.id, row, date: transaction.date, project: transaction.project, amount: transaction.amount, person: transaction.person, classification: transaction.classification }) });
  }
  return { rows, merges, batchRows };
}

function insertionShift(row, insertions) { return insertions.reduce((count, insertion) => count + (insertion.beforeRow <= row ? insertion.transactions.length : 0), 0); }

function shiftFormula(formula, insertions) {
  return formula.replace(/(?<![A-Za-z0-9_])((?:\$)?[A-Z]{1,3})(\$?)([1-9]\d*)/gu, (whole, column, absolute, rowText) => `${column}${absolute}${Number(rowText) + insertionShift(Number(rowText), insertions)}`);
}

function shiftReferenceList(value, insertions) {
  return value.split(/(\s+)/u).map((token) => (/\S/u.test(token) ? shiftFormula(token, insertions) : token)).join("");
}

function shiftWorksheetReferences(worksheetXml, insertions) {
  return worksheetXml
    .replace(/<(?:\w+:)?(?:conditionalFormatting|dataValidation|hyperlink|autoFilter|sortState|protectedRange|ignoredError)\b[^>]*>/giu, (tag) => tag.replace(/(\b(ref|sqref|location)\s*=\s*")([^"]+)(")/giu, (whole, prefix, attribute, value, suffix) => {
      if (attribute.toLowerCase() === "location" && !value.includes("!")) return whole;
      return `${prefix}${shiftReferenceList(value, insertions)}${suffix}`;
    }))
    .replace(/(<(?:\w+:)?(?:formula|formula1|formula2)\b[^>]*>)([\s\S]*?)(<\/(?:\w+:)?(?:formula|formula1|formula2)>)/giu, (whole, open, formula, close) => `${open}${shiftFormula(formula, insertions)}${close}`);
}

function shiftOriginalRow(row, insertions) {
  const newNumber = row.number + insertionShift(row.number, insertions);
  let result = row.xml.replace(/^(<row\b[^>]*\br\s*=\s*")[1-9]\d*(")/u, `$1${newNumber}$2`);
  result = result.replace(/(<c\b[^>]*\br\s*=\s*")([A-Z]{1,3})([1-9]\d*)(")/gu, (whole, prefix, column, rowText, suffix) => `${prefix}${column}${Number(rowText) + insertionShift(Number(rowText), insertions)}${suffix}`);
  result = result.replace(/(<f\b[^>]*>)([\s\S]*?)(<\/f>)/gu, (whole, open, formula, close) => `${open}${shiftFormula(formula, insertions)}${close}`);
  return { number: newNumber, xml: result };
}

function shiftMerge(ref, insertions) {
  const range = splitRange(ref);
  for (const insertion of insertions) if (range.startRow < insertion.beforeRow && insertion.beforeRow <= range.endRow) fail(`local insertion would split existing merge ${ref}.`);
  return `${columnName(range.startColumn)}${range.startRow + insertionShift(range.startRow, insertions)}:${columnName(range.endColumn)}${range.endRow + insertionShift(range.endRow, insertions)}`;
}

function replaceMergeCells(worksheetXml, merges) {
  const block = merges.length ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  if (/<(?:\w+:)?mergeCells\b/iu.test(worksheetXml)) return worksheetXml.replace(/<(?:\w+:)?mergeCells\b[^>]*>[\s\S]*?<\/(?:\w+:)?mergeCells>/iu, block);
  return worksheetXml.replace(/<\/(?:\w+:)?worksheet>\s*$/iu, `${block}</worksheet>`);
}

function updateDimension(worksheetXml, maxRow) {
  return worksheetXml.replace(/(<(?:\w+:)?dimension\b[^>]*\bref\s*=\s*")([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?(")/iu, (whole, prefix, startColumn, startRow, endColumn, endRow, suffix) => `${prefix}${startColumn}${startRow}:${endColumn ?? startColumn}${Math.max(Number(endRow ?? startRow), maxRow)}${suffix}`);
}

function updatePrintArea(workbookXml, sheetName, maxRow) {
  const escaped = sheetName.replaceAll("'", "''");
  return workbookXml.replace(/(<(?:\w+:)?definedName\b[^>]*\bname\s*=\s*"_xlnm\.Print_Area"[^>]*>)([\s\S]*?)(<\/(?:\w+:)?definedName>)/giu, (whole, open, value, close) => {
    if (!unxml(value).includes(`'${escaped}'!`) && !unxml(value).includes(`${escaped}!`)) return whole;
    return `${open}'${xml(escaped)}'!$A$1:$F$${maxRow}${close}`;
  });
}

function contiguousRanges(rows) {
  const result = [];
  for (const row of [...rows].sort((left, right) => left - right)) { const prior = result.at(-1); if (prior && prior.endRow + 1 === row) prior.endRow = row; else result.push({ startRow: row, endRow: row }); }
  return result.map((item) => ({ ...item, rangeAddress: `A${item.startRow}:F${item.endRow}` }));
}

function patchWorksheet(worksheetXml, transactions, date1904, stylesXml) {
  const parsed = parseRows(worksheetXml);
  const material = materialRows(parsed.rows, date1904);
  const existingMerges = parseMergeRefs(worksheetXml);
  const insertions = buildInsertions(transactions, material, existingMerges);
  const insertionByRow = new Map(insertions.map((item) => [item.beforeRow, item]));
  const renderedInsertions = new Map(); const allBatchRows = []; const newMerges = []; let priorCount = 0;
  for (const insertion of insertions) {
    const firstRow = insertion.beforeRow + priorCount;
    const standard = standardStyleRow(material, insertion.beforeRow, existingMerges, stylesXml);
    const rendered = renderBatchRows(insertion.transactions, firstRow, standard.styles, standard.height, date1904);
    renderedInsertions.set(insertion.beforeRow, rendered); allBatchRows.push(...rendered.batchRows); newMerges.push(...rendered.merges); priorCount += insertion.transactions.length;
  }
  const outputRows = [];
  for (const row of parsed.rows) { if (insertionByRow.has(row.number)) outputRows.push(...renderedInsertions.get(row.number).rows); outputRows.push(shiftOriginalRow(row, insertions).xml); }
  for (const insertion of insertions) if (!parsed.rows.some((row) => row.number >= insertion.beforeRow)) outputRows.push(...renderedInsertions.get(insertion.beforeRow).rows);
  let changed = worksheetXml.replace(parsed.match[1], outputRows.join(""));
  changed = replaceMergeCells(changed, [...existingMerges.map((ref) => shiftMerge(ref, insertions)), ...newMerges]);
  changed = shiftWorksheetReferences(changed, insertions);
  const maxRow = Math.max(1, ...parsed.rows.map((row) => row.number + insertionShift(row.number, insertions)), ...allBatchRows.map((item) => item.row));
  changed = updateDimension(changed, maxRow);
  const projectionBody = { batchRanges: contiguousRanges(allBatchRows.map((item) => item.row)), batchRows: allBatchRows, batchRowCount: allBatchRows.length, manifestRecordCount: transactions.length, transactionCount: transactions.length, baselineMaterialRowCount: material.length, batchAmount: formatMilliunits(transactions.reduce((sum, item) => sum + item.milliunits, 0n)) };
  return { xml: changed, maxRow, projection: { ...projectionBody, batchProjectionDigest: canonicalDigest(projectionBody) } };
}

async function packageFacts(zip) {
  const parts = [];
  for (const name of Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort()) { const bytes = await zip.file(name).async("nodebuffer"); parts.push({ name, size: bytes.length, sha256: sha256Bytes(bytes) }); }
  return { partCount: parts.length, factsDigest: canonicalDigest(parts) };
}

async function createPreviewWorkbook({ transactions, date1904, template }) {
  const roles = template.styleRoles;
  const styles = { 1: roles.date, 2: roles.text, 3: roles.amount, 4: roles.total, 5: roles.person, 6: roles.classification };
  const ordered = [...transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
  const rendered = renderBatchRows(ordered, 2, styles, template.definition.templateRowHeight, date1904);
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
  const handle = await fs.open(filePath, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
}

async function buildCandidate(artifact, certificate, stagingRoot) {
  const stable = await readStableBinaryFile(artifact.baselinePath, { maxBytes: MAX_STABLE_BINARY_BYTES });
  if (stable.sha256 !== artifact.baselineSha256 || stable.size !== artifact.baselineSize) fail(`${artifact.profileId} baseline SHA/size changed.`);
  const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
  const managed = await resolveManagedSheet(zip, artifact.profile);
  const baselineStylesXml = await textPart(zip, "xl/styles.xml", "baseline styles");
  const transactions = certificate.transactions.filter((item) => item.profileId === artifact.profileId);
  const patch = patchWorksheet(managed.worksheetXml, transactions, managed.date1904, baselineStylesXml);
  zip.file(managed.worksheetPart, patch.xml, { createFolders: false });
  zip.file(managed.workbookPart, updatePrintArea(managed.workbookXml, artifact.profile.managedRootSheetName, patch.maxRow), { createFolders: false });
  const candidateBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const candidate = await writeExclusive(path.join(stagingRoot, `.${artifact.profileId}.${crypto.randomBytes(10).toString("hex")}.candidate.tmp.xlsx`), candidateBytes);
  const previewTemplate = await loadTemplateAsset("ledger-batch-preview");
  const preview = await createPreviewWorkbook({ transactions, date1904: managed.date1904, template: previewTemplate });
  const previewState = await writeExclusive(path.join(stagingRoot, `${artifact.profileId}-本批总表增量.xlsx`), preview.bytes);
  return { artifact, candidate, preview: { ...previewState, sheetName: preview.sheetName, endRow: preview.endRow, rangeAddress: preview.rangeAddress } };
}

export function computeRootWorkbookAuditRequestDigest(request) { const body = clone(object(request, "audit request")); delete body.requestDigest; return canonicalDigest(body); }

function validateAuditRequest(raw) {
  exact(raw, AUDIT_REQUEST_KEYS, "audit request");
  if (raw.kind !== ROOT_WORKBOOK_AUDIT_REQUEST_KIND || !TOKEN_RE.test(raw.requestNonce ?? "") || computeRootWorkbookAuditRequestDigest(raw) !== raw.requestDigest) fail("audit request kind, nonce, or digest is invalid.");
  const profiles = array(raw.profiles, "audit request profiles");
  if (profiles.length < 1 || profiles.length > 3) fail("audit request profiles must contain one to three profiles.");
  for (const [index, profile] of profiles.entries()) { exact(profile, AUDIT_PROFILE_KEYS, `audit request profiles[${index}]`); text(profile.profileId, `${index}.profileId`); text(profile.baselinePath, `${index}.baselinePath`); text(profile.candidatePath, `${index}.candidatePath`); sha(profile.baselineSha256, `${index}.baselineSha256`); sha(profile.candidateSha256, `${index}.candidateSha256`); }
  return raw;
}

async function compareUnchangedParts(baselineZip, candidateZip, allowed) {
  const beforeNames = Object.keys(baselineZip.files).filter((name) => !baselineZip.files[name].dir).sort();
  const afterNames = Object.keys(candidateZip.files).filter((name) => !candidateZip.files[name].dir).sort();
  if (canonicalDigest(beforeNames) !== canonicalDigest(afterNames)) fail("candidate package part inventory differs from baseline.");
  for (const name of beforeNames) { if (allowed.has(name)) continue; const [before, after] = await Promise.all([baselineZip.file(name).async("nodebuffer"), candidateZip.file(name).async("nodebuffer")]); if (!before.equals(after)) fail(`candidate changed untouched package part ${name}.`); }
}

async function auditOne(binding, certificate, registry) {
  const profile = registry.profiles[binding.profileId]; if (!profile) fail(`audit profile ${binding.profileId} is unknown.`);
  const [baselineStable, candidateStable] = await Promise.all([readStableBinaryFile(path.resolve(binding.baselinePath), { maxBytes: MAX_STABLE_BINARY_BYTES }), readStableBinaryFile(path.resolve(binding.candidatePath), { maxBytes: MAX_STABLE_BINARY_BYTES })]);
  if (baselineStable.sha256 !== binding.baselineSha256 || candidateStable.sha256 !== binding.candidateSha256) fail(`${binding.profileId} audit source SHA changed.`);
  const [baselineZip, candidateZip] = await Promise.all([JSZip.loadAsync(copyStableBinaryBytes(baselineStable)), JSZip.loadAsync(copyStableBinaryBytes(candidateStable))]);
  const baselineManaged = await resolveManagedSheet(baselineZip, profile); const candidateManaged = await resolveManagedSheet(candidateZip, profile);
  if (baselineManaged.worksheetPart !== candidateManaged.worksheetPart || baselineManaged.workbookPart !== candidateManaged.workbookPart) fail("candidate managed part identity changed.");
  await compareUnchangedParts(baselineZip, candidateZip, new Set([baselineManaged.worksheetPart, baselineManaged.workbookPart]));
  const transactions = certificate.transactions.filter((item) => item.profileId === binding.profileId);
  const baselineStylesXml = await textPart(baselineZip, "xl/styles.xml", "baseline styles");
  const expected = patchWorksheet(baselineManaged.worksheetXml, transactions, baselineManaged.date1904, baselineStylesXml);
  if (candidateManaged.worksheetXml !== expected.xml || candidateManaged.workbookXml !== updatePrintArea(baselineManaged.workbookXml, profile.managedRootSheetName, expected.maxRow)) fail(`${binding.profileId} candidate is not the exact local batch patch.`);
  const [baselineFacts, candidateFacts] = await Promise.all([packageFacts(baselineZip), packageFacts(candidateZip)]);
  const transitionDigest = canonicalDigest({ baselineSha256: baselineStable.sha256, candidateSha256: candidateStable.sha256, projection: expected.projection });
  const body = {
    kind: BUSINESS_AUDIT_KIND, requiresGate1Binding: true, auditScope: "batch-local-increment-only",
    profile: { profileId: profile.profileId, targetCategory: profile.targetCategory, canonicalRootWorkbookName: profile.canonicalRootWorkbookName, managedRootSheetName: profile.managedRootSheetName },
    manifest: { certificateDigest: certificate.raw.certificateDigest, factsDigest: certificate.raw.factsDigest, sourceCoverageDigest: certificate.raw.sourceCoverageDigest, profileConfigDigest: certificate.raw.profileConfigDigest, batchId: certificate.raw.factsPreimage.batchId },
    baseline: { sourceSize: baselineStable.size, sourceSha256: baselineStable.sha256, factsDigest: baselineFacts.factsDigest, partCount: baselineFacts.partCount },
    candidate: { sourceSize: candidateStable.size, sourceSha256: candidateStable.sha256, factsDigest: candidateFacts.factsDigest, partCount: candidateFacts.partCount },
    transitionDigest,
    sourceCoverage: certificate.raw.sourceCoveragePreimage.transactionSourceRefs.filter((item) => transactions.some((transaction) => transaction.id === item.transactionId)),
    projection: expected.projection,
    unchangedPartCount: baselineFacts.partCount - 2,
  };
  return { ...body, auditDigest: canonicalDigest(body) };
}

function verifyAuditBody(audit, binding, certificate) {
  object(audit, `${binding.profileId} audit`); const body = clone(audit); delete body.auditDigest;
  if (audit.kind !== BUSINESS_AUDIT_KIND || audit.requiresGate1Binding !== true || canonicalDigest(body) !== audit.auditDigest) fail(`${binding.profileId} worker audit is invalid.`);
  if (audit.profile?.profileId !== binding.profileId || audit.baseline?.sourceSha256 !== binding.baselineSha256 || audit.candidate?.sourceSha256 !== binding.candidateSha256) fail(`${binding.profileId} worker audit binding differs.`);
  for (const field of ["certificateDigest", "factsDigest", "sourceCoverageDigest", "profileConfigDigest"]) if (audit.manifest?.[field] !== certificate[field]) fail(`${binding.profileId} audit ${field} differs.`);
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

export async function runRootWorkbookAuditWorker({ requestPath, requestFileSha256, requestNonce, timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, stdoutMaxBytes = MAX_WORKER_STDOUT_BYTES, stderrMaxBytes = MAX_WORKER_STDERR_BYTES, workerScriptPath = BUILDER_PATH } = {}) {
  const absoluteRequest = path.resolve(text(requestPath, "worker requestPath")); sha(requestFileSha256, "worker requestFileSha256"); if (!TOKEN_RE.test(requestNonce ?? "")) fail("worker requestNonce is invalid.");
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
    const builtSet = await mapSettledLimit(checked.artifacts, 3, (artifact) => buildCandidate(artifact, checked.certificate, stagingRoot)); const built = builtSet.settled.map((entry) => entry.value); for (const item of built) owned.push(item.candidate, item.preview);
    const requestNonce = crypto.randomBytes(32).toString("hex");
    const workerRequest = { kind: ROOT_WORKBOOK_AUDIT_REQUEST_KIND, requestNonce, reimbursementFactsCertificate: checked.certificate.raw, profiles: built.map((item) => ({ profileId: item.artifact.profileId, baselinePath: item.artifact.baselinePath, baselineSha256: item.artifact.baselineSha256, candidatePath: item.candidate.path, candidateSha256: item.candidate.sha256 })) };
    workerRequest.requestDigest = computeRootWorkbookAuditRequestDigest(workerRequest);
    const requestEntry = await writeExclusive(path.join(stagingRoot, `.audit-request.${requestNonce}.json`), jsonBytes(workerRequest)); owned.push(requestEntry);
    if (testHooks?.afterWorkerRequestWritten) await testHooks.afterWorkerRequestWritten({ requestPath: requestEntry.path, requestBody: clone(workerRequest) });
    const raw = await runRootWorkbookAuditWorker({ requestPath: requestEntry.path, requestFileSha256: requestEntry.sha256, requestNonce }); const { rawStdout: _rawStdout, ...response } = raw;
    const auditBatch = validateRootWorkbookAuditBatch(response, { requestDigest: workerRequest.requestDigest, requestFileSha256: requestEntry.sha256, requestNonce, profileIds: checked.profileIds, profileBindings: workerRequest.profiles, certificate: checked.certificate.raw });
    const committed = [];
    for (const [index, item] of built.entries()) {
      const audit = auditBatch.audits[index]; const candidateBytes = copyStableBinaryBytes(await readStableBinaryFile(item.candidate.path));
      const final = await writeExclusive(path.join(stagingRoot, candidateFilename(item.artifact.profile, item.artifact.candidateRevision)), candidateBytes); owned.push(final);
      const planBody = { kind: "root-workbook-local-increment-plan-v2", requiresGate1Binding: true, profile: audit.profile, manifest: audit.manifest, baseline: audit.baseline, candidate: { path: final.path, sha256: final.sha256, size: final.size, factsDigest: audit.candidate.factsDigest }, preview: item.preview, transitionDigest: audit.transitionDigest, audit, candidateRevision: item.artifact.candidateRevision, stagingOwnership: { token: checked.stagingToken, ownerMarkerSha256: marker.sha256 } };
      const plan = { ...planBody, planDigest: canonicalDigest(planBody) }; const planEntry = await writeExclusive(path.join(stagingRoot, planFilename(item.artifact.profile, item.artifact.candidateRevision)), jsonBytes(plan)); owned.push(planEntry);
      committed.push({ profileId: item.artifact.profileId, candidateRevision: item.artifact.candidateRevision, candidatePath: final.path, candidateSha256: final.sha256, candidateSize: final.size, candidateFactsDigest: audit.candidate.factsDigest, previewPath: item.preview.path, previewSha256: item.preview.sha256, previewSize: item.preview.size, previewSheetName: item.preview.sheetName, previewRangeAddress: item.preview.rangeAddress, previewEndRow: item.preview.endRow, planPath: planEntry.path, planSha256: planEntry.sha256, planSize: planEntry.size, planDigest: plan.planDigest, audit });
    }
    return deepFreeze({ kind: ROOT_WORKBOOK_BUILD_RESULT_KIND, requiresGate1Binding: true, stagingRoot, stagingToken: checked.stagingToken, requestDigest: workerRequest.requestDigest, requestFileSha256: requestEntry.sha256, auditBatchDigest: canonicalDigest(auditBatch), artifacts: committed, ownedFiles: owned.map((item) => ({ path: item.path, sha256: item.sha256, size: item.size })) });
  } catch (reason) {
    const cleanup = await cleanupOwned(owned, stagingRoot); const message = reason instanceof Error ? reason.message : String(reason);
    if (cleanup.preserved.length || cleanup.failures.length) fail(`${message}; cleanup incomplete: ${[...cleanup.preserved, ...cleanup.failures.map((item) => item.path)].join(", ")}`);
    throw reason;
  }
}

async function auditWorkerMain(args) {
  if (args.length !== 7 || args[0] !== "--audit-worker" || args[1] !== "--request" || args[3] !== "--request-sha256" || args[5] !== "--request-nonce") fail("audit worker arguments are invalid.");
  const requestPath = path.resolve(args[2]); const expectedSha = sha(args[4], "audit worker expected request SHA"); const expectedNonce = text(args[6], "audit worker expected nonce");
  const snapshot = await readStableUtf8JsonFile(requestPath, { maxBytes: MAX_JSON_BYTES }); if (snapshot.sha256 !== expectedSha) fail("audit request file SHA differs.");
  const request = validateAuditRequest(snapshot.value); if (request.requestNonce !== expectedNonce) fail("audit request nonce differs.");
  const registry = await loadProfileRegistry(); const certificate = validateCertificate(request.reimbursementFactsCertificate, registry); const expectedOrder = registry.profileOrder.filter((profileId) => request.profiles.some((item) => item.profileId === profileId)); if (canonicalDigest(expectedOrder) !== canonicalDigest(request.profiles.map((item) => item.profileId))) fail("audit profiles are outside registry order.");
  const settled = await mapSettledLimit(request.profiles, 3, (profile) => auditOne(profile, certificate, registry));
  process.stdout.write(`${JSON.stringify({ kind: ROOT_WORKBOOK_AUDIT_BATCH_KIND, requestDigest: request.requestDigest, requestFileSha256: snapshot.sha256, requestNonce: request.requestNonce, audits: settled.settled.map((entry) => entry.value) })}\n`);
}

async function main() {
  const args = process.argv.slice(2); if (args[0] === "--audit-worker") return auditWorkerMain(args);
  if (args.length !== 2 || args[0] !== "--input") fail("usage: build_root_workbook_candidate.mjs --input <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_JSON_BYTES }); process.stdout.write(`${JSON.stringify(await buildRootWorkbookCandidates(input.value))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
