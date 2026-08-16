import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatMilliunits, loadProfileRegistry, parseMilliunits } from "./finance_domain.mjs";
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
import { readWorkbookOoxmlFacts } from "./workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "./workbook_snapshot.mjs";

export const ROOT_WORKBOOK_BUILD_REQUEST_KIND = "root-workbook-build-request-v1";
export const ROOT_WORKBOOK_AUDIT_REQUEST_KIND = "root-workbook-audit-request-v1";
export const ROOT_WORKBOOK_AUDIT_BATCH_KIND = "root-workbook-business-audit-batch-v1";
export const ROOT_WORKBOOK_BUILD_RESULT_KIND = "root-workbook-build-batch-v1";

const BUILD_PLAN_KIND = "root-workbook-build-plan-v1";
const BUSINESS_AUDIT_KIND = "root-workbook-business-audit-v1";
const STAGING_PREFIX = "codex-xhs-reimburse-";
const STAGING_TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const FIRST_DATA_ROW = 2;
const MAX_WORKER_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_WORKER_STDERR_BYTES = 1024 * 1024;
const MAX_WORKER_REQUEST_BYTES = 16 * 1024 * 1024;
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value, field) {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function exactKeys(value, keys, field) {
  record(value, field);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function cleanText(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) {
    fail(`${field} must be a non-empty trimmed string without control whitespace.`);
  }
  return value;
}

function cleanSha(value, field) {
  const result = cleanText(value, field);
  if (!SHA256_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive safe integer.`);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function callHook(testHooks, name, value) {
  const hook = testHooks?.[name];
  if (hook !== undefined && typeof hook !== "function") fail(`test hook ${name} must be a function.`);
  if (hook) await hook(value);
}

function assertDigest(value, digest, field) {
  if (canonicalDigest(value) !== cleanSha(digest, field)) fail(`${field} does not match its preimage.`);
}

function validateCertificate(raw, registry) {
  exactKeys(raw, CERTIFICATE_KEYS, "reimbursementFactsCertificate");
  if (raw.kind !== "reimbursement-manifest-facts-v1" || raw.operationMode !== "reimbursement-batch") {
    fail("ordinary builder requires a reimbursement-manifest-facts-v1 reimbursement-batch certificate.");
  }
  for (const field of ["manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest", "factsDigest", "sourceCoverageDigest", "certificateDigest"]) {
    cleanSha(raw[field], `reimbursementFactsCertificate.${field}`);
  }
  assertDigest(raw.factsPreimage, raw.factsDigest, "reimbursementFactsCertificate.factsDigest");
  assertDigest(raw.sourceCoveragePreimage, raw.sourceCoverageDigest, "reimbursementFactsCertificate.sourceCoverageDigest");
  if (raw.profileConfigDigest !== registry.profileConfigDigest || raw.factsPreimage?.profileConfigDigest !== registry.profileConfigDigest) {
    fail("reimbursementFactsCertificate profileConfigDigest does not match the fixed registry.");
  }
  const body = clone(raw);
  delete body.certificateDigest;
  assertDigest(body, raw.certificateDigest, "reimbursementFactsCertificate.certificateDigest");
  const transactions = array(raw.factsPreimage?.transactions, "factsPreimage.transactions").map((item, index) => {
    const field = `factsPreimage.transactions[${index}]`;
    record(item, field);
    const profileId = cleanText(item.profileId, `${field}.profileId`);
    const profile = registry.profiles[profileId];
    if (!profile || item.category !== profile.targetCategory) fail(`${field} does not match a fixed profile category.`);
    const milliunits = parseMilliunits(item.amount, `${field}.amount`, { allowNegative: true });
    if (formatMilliunits(milliunits) !== item.amount) fail(`${field}.amount must use canonical milliunits text.`);
    return { ...clone(item), profileId, milliunits };
  });
  if (transactions.length === 0) fail("factsPreimage.transactions must be non-empty.");
  const ids = new Set();
  const orders = new Set();
  for (const transaction of transactions) {
    const id = cleanText(transaction.id, "transaction.id");
    if (ids.has(id)) fail(`factsPreimage contains duplicate transaction id ${id}.`);
    if (orders.has(transaction.sourceOrder)) fail("factsPreimage contains duplicate sourceOrder.");
    positiveInteger(transaction.sourceOrder, "transaction.sourceOrder");
    ids.add(id);
    orders.add(transaction.sourceOrder);
  }
  const affectedProfileIds = registry.profileOrder.filter((profileId) => transactions.some((item) => item.profileId === profileId));
  if (canonicalDigest(raw.factsPreimage.affectedProfileIds) !== canonicalDigest(affectedProfileIds)) {
    fail("factsPreimage.affectedProfileIds does not match transactions.");
  }
  return deepFreeze({ raw: clone(raw), transactions, affectedProfileIds });
}

function validateBuildRequest(raw, registry) {
  exactKeys(raw, BUILD_REQUEST_KEYS, "request");
  if (raw.kind !== ROOT_WORKBOOK_BUILD_REQUEST_KIND) fail("request kind is unsupported.");
  if (typeof raw.stagingToken !== "string" || !STAGING_TOKEN_RE.test(raw.stagingToken)) fail("stagingToken must be exactly 64 lowercase hexadecimal characters.");
  const certificate = validateCertificate(raw.reimbursementFactsCertificate, registry);
  const artifacts = array(raw.artifacts, "request.artifacts").map((item, index) => {
    exactKeys(item, ARTIFACT_KEYS, `request.artifacts[${index}]`);
    const profileId = cleanText(item.profileId, `request.artifacts[${index}].profileId`);
    const profile = registry.profiles[profileId];
    if (!profile) fail(`${profileId} is not a canonical profile.`);
    const baselinePath = path.resolve(cleanText(item.baselinePath, `request.artifacts[${index}].baselinePath`));
    if (!profile.rootWorkbookInputNames.includes(path.basename(baselinePath))) fail(`${profileId} baseline filename is outside its fixed inputs.`);
    return {
      profileId,
      profile,
      baselinePath,
      baselineSha256: cleanSha(item.baselineSha256, `request.artifacts[${index}].baselineSha256`),
      baselineSize: positiveInteger(item.baselineSize, `request.artifacts[${index}].baselineSize`),
      candidateRevision: positiveInteger(item.candidateRevision, `request.artifacts[${index}].candidateRevision`),
    };
  });
  if (artifacts.length < 1 || artifacts.length > 3) fail("request.artifacts must contain one to three affected profiles.");
  const profileIds = artifacts.map((item) => item.profileId);
  if (new Set(profileIds).size !== profileIds.length || canonicalDigest(profileIds) !== canonicalDigest(certificate.affectedProfileIds)) {
    fail("request artifacts must exactly match affectedProfileIds in registry order.");
  }
  return { stagingToken: raw.stagingToken, certificate, artifacts, profileIds };
}

export function computeRootWorkbookAuditRequestDigest(request) {
  record(request, "audit request");
  const body = clone(request);
  delete body.requestDigest;
  return canonicalDigest(body);
}

function validateAuditRequest(raw) {
  exactKeys(raw, AUDIT_REQUEST_KEYS, "audit request");
  if (raw.kind !== ROOT_WORKBOOK_AUDIT_REQUEST_KIND || !STAGING_TOKEN_RE.test(raw.requestNonce ?? "")) fail("audit request kind or nonce is invalid.");
  if (computeRootWorkbookAuditRequestDigest(raw) !== raw.requestDigest) fail("audit requestDigest does not match the complete request body.");
  const profiles = array(raw.profiles, "audit request profiles");
  if (profiles.length < 1 || profiles.length > 3) fail("audit request profiles must contain one to three profiles.");
  for (const [index, item] of profiles.entries()) {
    exactKeys(item, AUDIT_PROFILE_KEYS, `audit request profiles[${index}]`);
    cleanText(item.profileId, `audit request profiles[${index}].profileId`);
    cleanText(item.baselinePath, `audit request profiles[${index}].baselinePath`);
    cleanText(item.candidatePath, `audit request profiles[${index}].candidatePath`);
    cleanSha(item.baselineSha256, `audit request profiles[${index}].baselineSha256`);
    cleanSha(item.candidateSha256, `audit request profiles[${index}].candidateSha256`);
  }
  return raw;
}

function verifyAuditBody(audit, binding, certificate) {
  record(audit, `${binding.profileId} audit`);
  if (audit.kind !== BUSINESS_AUDIT_KIND || audit.requiresGate1Binding !== true) fail(`${binding.profileId} worker returned an incomplete or authorizing audit.`);
  const body = clone(audit);
  delete body.auditDigest;
  if (canonicalDigest(body) !== audit.auditDigest) fail(`${binding.profileId} auditDigest does not match the complete audit body.`);
  if (audit.profile?.profileId !== binding.profileId) fail(`${binding.profileId} audit profile binding differs from the request.`);
  if (audit.baseline?.sourceSha256 !== binding.baselineSha256) fail(`${binding.profileId} baseline SHA differs from the parent profile binding.`);
  if (audit.candidate?.sourceSha256 !== binding.candidateSha256) fail(`${binding.profileId} candidate SHA differs from the parent profile binding.`);
  for (const field of ["certificateDigest", "factsDigest", "sourceCoverageDigest", "profileConfigDigest"]) {
    if (audit.manifest?.[field] !== certificate[field]) fail(`${binding.profileId} audit manifest ${field} differs from the certificate.`);
  }
  cleanSha(audit.transitionDigest, `${binding.profileId} transitionDigest`);
  return clone(audit);
}

export function validateRootWorkbookAuditBatch(response, options) {
  exactKeys(response, AUDIT_BATCH_KEYS, "audit worker response");
  if (response.kind !== ROOT_WORKBOOK_AUDIT_BATCH_KIND) fail("audit worker response kind is unsupported.");
  for (const field of ["requestDigest", "requestFileSha256", "requestNonce"]) if (response[field] !== options[field]) fail(`audit worker response ${field} binding differs from the parent.`);
  const profileIds = array(options.profileIds, "expected profileIds");
  const bindings = array(options.profileBindings, "expected profileBindings");
  const audits = array(response.audits, "audit worker response audits");
  if (bindings.length !== profileIds.length || audits.length !== profileIds.length) fail("audit worker profile count does not match the request.");
  const seen = new Set();
  const checked = audits.map((audit, index) => {
    if (!isRecord(audit)) fail("audit worker response must contain complete audit objects, not string summaries.");
    const profileId = audit?.profile?.profileId;
    if (profileId !== profileIds[index] || seen.has(profileId)) fail("audit worker profiles are not unique fixed-registry order.");
    seen.add(profileId);
    if (bindings[index].profileId !== profileId) fail("profile binding order differs from the worker response.");
    return verifyAuditBody(audit, bindings[index], options.certificate);
  });
  return deepFreeze({ ...clone(response), audits: checked });
}

function xmlText(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function xmlAttribute(value) { return xmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function columnName(column) {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}
function cellByColumn(row) { return new Map(row.cells.map((cell) => [cell.column, cell])); }
function hasPayload(cell) { return Boolean(cell && (cell.value !== null || cell.formula !== null || cell.cachedValue !== null)); }
function textCell(cell, field) {
  if (!cell || cell.formula !== null || typeof cell.value?.text !== "string") fail(`${field} must be a plain text cell.`);
  return cell.value.text;
}
function numericCell(cell, field) {
  if (!cell || cell.formula !== null || cell.type !== "n" || typeof cell.value?.raw !== "string") fail(`${field} must be a plain numeric cell.`);
  return cell.value.raw;
}
function excelSerialToIso(raw, field) {
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) fail(`${field} must be an integer Excel serial.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value === 60 || value > 2_958_465) fail(`${field} is invalid.`);
  const z = value - 25_569 + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function isoToExcelSerial(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) fail(`date ${value} must use YYYY-MM-DD.`);
  let year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468 + 25_569;
}
function mergeAt(merges, column, row) { return merges.find((merge) => merge.startColumn === column && merge.endColumn === column && merge.startRow <= row && merge.endRow >= row) ?? null; }

function parseBaseline(worksheet) {
  if (worksheet.opaqueControlledPaths.length > 0) fail("managed worksheet contains unsupported controlled semantics.");
  const rowByIndex = new Map(worksheet.rows.map((row) => [row.index, row]));
  const materialRows = worksheet.rows.filter((row) => row.index >= FIRST_DATA_ROW && row.cells.some((cell) => cell.column <= 6 && hasPayload(cell)));
  if (materialRows.length === 0) fail("baseline managed worksheet contains no material records.");
  const lastRow = materialRows.at(-1).index;
  for (let row = FIRST_DATA_ROW; row <= lastRow; row += 1) if (!rowByIndex.has(row)) fail("baseline material rows are not contiguous from row 2.");
  for (const row of worksheet.rows) {
    if (row.cells.some((cell) => cell.column > 6 && hasPayload(cell))) fail("managed worksheet contains data outside A:F.");
    if (row.index > lastRow && row.cells.some(hasPayload)) fail("managed worksheet contains trailing material rows.");
  }
  const rows = [];
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastRow; rowNumber += 1) {
    const row = rowByIndex.get(rowNumber);
    const cells = cellByColumn(row);
    const dateMerge = mergeAt(worksheet.merges, 1, rowNumber);
    const groupMerge = mergeAt(worksheet.merges, 4, rowNumber);
    const dateMasterRow = dateMerge?.startRow ?? rowNumber;
    const groupStart = groupMerge?.startRow ?? rowNumber;
    const groupEnd = groupMerge?.endRow ?? rowNumber;
    const dateMaster = cellByColumn(rowByIndex.get(dateMasterRow)).get(1);
    const master = cellByColumn(rowByIndex.get(groupStart));
    const milliunits = parseMilliunits(numericCell(cells.get(3), `baseline C${rowNumber}`), `baseline C${rowNumber}`, { allowNegative: true });
    rows.push({
      origin: "baseline", baselineOrdinal: rows.length, row: rowNumber,
      date: excelSerialToIso(numericCell(dateMaster, `baseline A${dateMasterRow}`), `baseline A${dateMasterRow}`),
      project: textCell(cells.get(2), `baseline B${rowNumber}`), amount: formatMilliunits(milliunits), milliunits,
      person: textCell(master.get(5), `baseline E${groupStart}`), classification: textCell(master.get(6), `baseline F${groupStart}`),
      groupStart, groupEnd,
      style: { date: dateMaster.styleIndex, project: cells.get(2).styleIndex, amount: cells.get(3).styleIndex },
      rowPresentation: {
        spans: row.spans, styleIndex: row.styleIndex, customFormat: row.customFormat, height: row.height,
        customHeight: row.customHeight, hidden: row.hidden, outlineLevel: row.outlineLevel, collapsed: row.collapsed,
        thickTop: row.thickTop, thickBottom: row.thickBottom, phonetic: row.phonetic,
      },
    });
  }
  const groups = [];
  for (const item of rows) {
    let group = groups.at(-1);
    if (!group || group.startRow !== item.groupStart || group.endRow !== item.groupEnd) {
      const master = cellByColumn(rowByIndex.get(item.groupStart));
      const d = master.get(4);
      if (!d) fail(`baseline D${item.groupStart} is missing.`);
      group = { index: groups.length, startRow: item.groupStart, endRow: item.groupEnd, mode: d.formula === null ? "direct" : "formula", style: { total: d.styleIndex, person: master.get(5).styleIndex, classification: master.get(6).styleIndex }, rows: [] };
      groups.push(group);
    }
    item.baselineGroupIndex = group.index;
    group.rows.push(item);
  }
  const uniqueRole = (values, field) => {
    const keys = new Map(values.map((value) => [canonicalDigest(value), value]));
    if (keys.size !== 1) fail(`baseline ${field} is ambiguous; a unique role signature is required.`);
    return clone([...keys.values()][0]);
  };
  return {
    rows, groups, lastRow,
    roles: {
      date: uniqueRole(rows.map((item) => item.style.date), "date styleIndex"),
      project: uniqueRole(rows.map((item) => item.style.project), "project styleIndex"),
      amount: uniqueRole(rows.map((item) => item.style.amount), "amount styleIndex"),
      total: uniqueRole(groups.map((item) => item.style.total), "total styleIndex"),
      person: uniqueRole(groups.map((item) => item.style.person), "person styleIndex"),
      classification: uniqueRole(groups.map((item) => item.style.classification), "classification styleIndex"),
      rowPresentation: uniqueRole(rows.map((item) => item.rowPresentation), "material row presentation"),
    },
  };
}

function buildProjection(baseline, transactions) {
  for (let index = 1; index < baseline.rows.length; index += 1) if (baseline.rows[index].date < baseline.rows[index - 1].date) fail("baseline date order requires the legacy migration path.");
  const expected = baseline.rows.map((item) => ({ ...item })).concat(transactions.map((transaction) => ({
    origin: "manifest", id: transaction.id, date: cleanText(transaction.date, "transaction.date"), project: cleanText(transaction.project, "transaction.project"),
    amount: formatMilliunits(transaction.milliunits), milliunits: transaction.milliunits, person: cleanText(transaction.person, "transaction.person"), classification: cleanText(transaction.classification, "transaction.classification"),
    sourceOrder: transaction.sourceOrder, settlement: transaction.settlement, style: { date: baseline.roles.date, project: baseline.roles.project, amount: baseline.roles.amount }, rowPresentation: clone(baseline.roles.rowPresentation),
  })));
  expected.sort((left, right) => left.date.localeCompare(right.date, "en") || (left.origin === right.origin ? left.origin === "baseline" ? left.baselineOrdinal - right.baselineOrdinal : left.sourceOrder - right.sourceOrder : left.origin === "baseline" ? -1 : 1));
  const positions = new Map();
  for (const [index, item] of expected.entries()) if (item.origin === "baseline") {
    const value = positions.get(item.baselineGroupIndex) ?? { first: index, last: index, count: 0 };
    value.last = index;
    value.count += 1;
    positions.set(item.baselineGroupIndex, value);
  }
  for (const group of baseline.groups) {
    const value = positions.get(group.index);
    if (!value || value.last - value.first + 1 !== value.count) fail("baseline atomic D/E/F group would be split by the date projection.");
  }
  return expected;
}

function consecutiveGroups(items, key) {
  const result = [];
  for (const [index, item] of items.entries()) {
    const value = key(item);
    const previous = result.at(-1);
    if (!previous || previous.key !== value) result.push({ key: value, start: index, end: index, items: [item] });
    else { previous.end = index; previous.items.push(item); }
  }
  return result;
}

function rowAttributes(rowNumber, presentation) {
  const values = [["r", rowNumber], ["spans", presentation.spans], ["s", presentation.styleIndex], ["customFormat", presentation.customFormat], ["ht", presentation.height], ["customHeight", presentation.customHeight], ["hidden", presentation.hidden], ["outlineLevel", presentation.outlineLevel], ["collapsed", presentation.collapsed], ["thickTop", presentation.thickTop], ["thickBot", presentation.thickBottom], ["ph", presentation.phonetic]];
  return values.filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => ` ${key}="${xmlAttribute(typeof value === "boolean" ? value ? "1" : "0" : value)}"`).join("");
}
function renderCell(prefix, ref, styleIndex, body, type = null) { return `<${prefix}c r="${ref}" s="${styleIndex}"${type ? ` t="${type}"` : ""}>${body}</${prefix}c>`; }
function renderTextCell(prefix, ref, styleIndex, value) { return renderCell(prefix, ref, styleIndex, `<${prefix}is><${prefix}t>${xmlText(value)}</${prefix}t></${prefix}is>`, "inlineStr"); }
function renderNumberCell(prefix, ref, styleIndex, value) { return renderCell(prefix, ref, styleIndex, `<${prefix}v>${xmlText(value)}</${prefix}v>`, "n"); }
function renderFormulaCell(prefix, ref, styleIndex, formula) { return renderCell(prefix, ref, styleIndex, `<${prefix}f>${xmlText(formula)}</${prefix}f>`, "n"); }

function renderSheetData(prefix, headerRowXml, projected, baseline) {
  const dateGroups = consecutiveGroups(projected, (item) => item.date);
  const dateMaster = new Map();
  for (const group of dateGroups) for (let index = group.start; index <= group.end; index += 1) dateMaster.set(index, group.start);
  const expenseGroups = consecutiveGroups(projected, (item) => item.origin === "baseline" ? `baseline:${item.baselineGroupIndex}` : `manifest:${JSON.stringify([item.person, item.classification, item.settlement])}`);
  const expenseByIndex = new Map();
  for (const group of expenseGroups) for (let index = group.start; index <= group.end; index += 1) expenseByIndex.set(index, group);
  const rows = [headerRowXml];
  for (const [index, item] of projected.entries()) {
    const rowNumber = index + FIRST_DATA_ROW;
    const group = expenseByIndex.get(index);
    let cells = "";
    if (dateMaster.get(index) === index) cells += renderNumberCell(prefix, `A${rowNumber}`, item.style.date, isoToExcelSerial(item.date));
    cells += renderTextCell(prefix, `B${rowNumber}`, item.style.project, item.project);
    cells += renderNumberCell(prefix, `C${rowNumber}`, item.style.amount, item.amount);
    if (group.start === index) {
      const startRow = group.start + FIRST_DATA_ROW;
      const endRow = group.end + FIRST_DATA_ROW;
      const baselineGroup = item.origin === "baseline" ? baseline.groups[item.baselineGroupIndex] : null;
      const style = baselineGroup?.style ?? { total: baseline.roles.total, person: baseline.roles.person, classification: baseline.roles.classification };
      const total = group.items.reduce((sum, value) => sum + value.milliunits, 0n);
      cells += baselineGroup?.mode === "direct" && startRow === endRow ? renderNumberCell(prefix, `D${rowNumber}`, style.total, formatMilliunits(total)) : renderFormulaCell(prefix, `D${rowNumber}`, style.total, `SUM(C${startRow}:C${endRow})`);
      cells += renderTextCell(prefix, `E${rowNumber}`, style.person, item.person);
      cells += renderTextCell(prefix, `F${rowNumber}`, style.classification, item.classification);
    }
    rows.push(`<${prefix}row${rowAttributes(rowNumber, item.rowPresentation)}>${cells}</${prefix}row>`);
  }
  const merges = [];
  for (const group of dateGroups) if (group.start !== group.end) merges.push(`A${group.start + FIRST_DATA_ROW}:A${group.end + FIRST_DATA_ROW}`);
  for (const group of expenseGroups) if (group.start !== group.end) for (const column of ["D", "E", "F"]) merges.push(`${column}${group.start + FIRST_DATA_ROW}:${column}${group.end + FIRST_DATA_ROW}`);
  return {
    sheetData: `<${prefix}sheetData>${rows.join("")}</${prefix}sheetData>`,
    mergeXml: merges.length === 0 ? "" : `<${prefix}mergeCells count="${merges.length}">${merges.map((ref) => `<${prefix}mergeCell ref="${ref}"/>`).join("")}</${prefix}mergeCells>`,
    endRow: projected.length + 1,
  };
}

function replaceManagedWorksheet(xml, projected, baseline) {
  const sheetDataRe = /<([A-Za-z_][A-Za-z0-9_.-]*:)?sheetData\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheetData\s*>/u;
  const match = sheetDataRe.exec(xml);
  if (!match) fail("managed worksheet XML is missing sheetData.");
  const prefix = match[1] ?? "";
  const header = new RegExp(`<${prefix}row\\b[^>]*\\br=(?:"1"|'1')[^>]*>[\\s\\S]*?<\\/${prefix}row\\s*>`, "u").exec(match[0])?.[0];
  if (!header) fail("managed worksheet XML is missing row 1.");
  const rendered = renderSheetData(prefix, header, projected, baseline);
  const mergeRe = /<([A-Za-z_][A-Za-z0-9_.-]*:)?mergeCells\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?mergeCells\s*>/gu;
  let result = xml.replace(mergeRe, "");
  result = result.replace(sheetDataRe, rendered.sheetData + rendered.mergeXml);
  const dimensionRe = /<([A-Za-z_][A-Za-z0-9_.-]*:)?dimension\b[^>]*\/>/u;
  if (dimensionRe.test(result)) result = result.replace(dimensionRe, `<${prefix}dimension ref="A1:F${rendered.endRow}"/>`);
  return { xml: result, endRow: rendered.endRow };
}

function replacePrintArea(xml, managedSheetName, managedSheetIndex, endRow) {
  const definedNameRe = /<([A-Za-z_][A-Za-z0-9_.-]*:)?definedName\b([^>]*)>[\s\S]*?<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?definedName\s*>/gu;
  let count = 0;
  const result = xml.replace(definedNameRe, (whole, prefix = "", attributes) => {
    const name = /\bname=(?:"([^"]*)"|'([^']*)')/u.exec(attributes)?.slice(1).find((value) => value !== undefined);
    const local = /\blocalSheetId=(?:"([^"]*)"|'([^']*)')/u.exec(attributes)?.slice(1).find((value) => value !== undefined);
    if (name !== "_xlnm.Print_Area" || local !== String(managedSheetIndex)) return whole;
    count += 1;
    return `<${prefix}definedName${attributes}>'${xmlText(managedSheetName.replaceAll("'", "''"))}'!$A$1:$F$${endRow}</${prefix}definedName>`;
  });
  if (count !== 1) fail("workbook must contain exactly one managed _xlnm.Print_Area.");
  return result;
}

async function stableFacts(filePath, expectedSha256, expectedSize, field) {
  const snapshot = await readStableFileSnapshot(filePath);
  if (snapshot.sha256 !== expectedSha256 || snapshot.size !== expectedSize) fail(`${field} stable SHA/size binding changed.`);
  return { snapshot, facts: await readWorkbookOoxmlFacts(snapshot) };
}

function managedWorksheet(facts, profile) {
  if (facts.workbook.opaqueControlledPaths.length > 0 || facts.package.nonStructuralPartNames.length > 0) fail("baseline workbook contains unsupported semantics.");
  const identities = facts.workbook.sheets.filter((sheet) => sheet.name === profile.managedRootSheetName);
  if (identities.length !== 1) fail(`baseline does not contain one canonical ${profile.managedRootSheetName} sheet.`);
  const worksheets = facts.worksheets.filter((sheet) => sheet.partName === identities[0].partName);
  if (worksheets.length !== 1) fail("managed sheet does not bind one worksheet Part.");
  if (worksheets[0].opaqueControlledPaths.length > 0) fail("managed worksheet contains unsupported opaque controlled semantics.");
  return { identity: identities[0], worksheet: worksheets[0] };
}

function wrapStableHooks(testHooks, role) {
  const hooks = testHooks?.stableBinary;
  if (!hooks) return undefined;
  return Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, (context) => hook({ ...context, role })]));
}

async function writeExclusive(filePath, bytes) {
  const handle = await fs.open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function buildCandidateTemp(artifact, certificate, stagingRoot, testHooks) {
  const binary = await readStableBinaryFile(artifact.baselinePath, { maxBytes: MAX_STABLE_BINARY_BYTES, testHooks: wrapStableHooks(testHooks, "baseline") });
  if (binary.sha256 !== artifact.baselineSha256 || binary.size !== artifact.baselineSize) fail(`${artifact.profileId} baseline binary SHA/size differs from the request.`);
  const baseline = await stableFacts(artifact.baselinePath, artifact.baselineSha256, artifact.baselineSize, `${artifact.profileId} baseline`);
  if (baseline.snapshot.sha256 !== binary.sha256 || baseline.snapshot.size !== binary.size) fail(`${artifact.profileId} baseline facts and binary bytes are not the same source.`);
  const managed = managedWorksheet(baseline.facts, artifact.profile);
  const parsed = parseBaseline(managed.worksheet);
  const transactions = certificate.transactions.filter((item) => item.profileId === artifact.profileId);
  if (transactions.length === 0) fail(`${artifact.profileId} has no actual reimbursement and must not produce output.`);
  const projected = buildProjection(parsed, transactions);
  const zip = await JSZip.loadAsync(copyStableBinaryBytes(binary), { createFolders: false });
  const worksheetEntry = zip.file(managed.identity.partName);
  const workbookPartName = baseline.facts.package.workbookPartName;
  const workbookEntry = zip.file(workbookPartName);
  if (!worksheetEntry || !workbookEntry) fail("baseline package is missing managed worksheet or workbook Part.");
  const [worksheetXml, workbookXml] = await Promise.all([worksheetEntry.async("string"), workbookEntry.async("string")]);
  const changedSheet = replaceManagedWorksheet(worksheetXml, projected, parsed);
  const changedWorkbook = replacePrintArea(workbookXml, artifact.profile.managedRootSheetName, managed.identity.order, changedSheet.endRow);
  zip.file(managed.identity.partName, changedSheet.xml, { createFolders: false });
  zip.file(workbookPartName, changedWorkbook, { createFolders: false });
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const tempPath = path.join(stagingRoot, `.${artifact.profileId}.${crypto.randomBytes(12).toString("hex")}.candidate.tmp.xlsx`);
  await writeExclusive(tempPath, bytes);
  const snapshot = await readStableFileSnapshot(tempPath);
  return { profileId: artifact.profileId, artifact, baseline, tempPath, tempSha256: snapshot.sha256, tempSize: snapshot.size, facts: await readWorkbookOoxmlFacts(snapshot) };
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
async function recordOwned(owned, entry, testHooks) { owned.push(entry); await callHook(testHooks, "afterOwnedFileCreated", clone(entry)); }
async function writeOwned(owned, kind, filePath, bytes, testHooks, profileId = null) {
  await writeExclusive(filePath, bytes);
  const entry = { kind, path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
  if (profileId) entry.profileId = profileId;
  await recordOwned(owned, entry, testHooks);
  return entry;
}
async function currentFileDigest(filePath) {
  try { const snapshot = await readStableBinaryFile(filePath, { maxBytes: MAX_STABLE_BINARY_BYTES }); return { sha256: snapshot.sha256, size: snapshot.size }; }
  catch (error) { if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return null; throw error; }
}
async function cleanupOwned(owned, stagingRoot) {
  const preserved = [];
  const failures = [];
  for (const entry of [...owned].reverse()) {
    try {
      const current = await currentFileDigest(entry.path);
      if (!current) continue;
      if (current.sha256 !== entry.sha256 || current.size !== entry.size) { preserved.push(entry.path); continue; }
      await fs.unlink(entry.path);
    } catch (error) { failures.push({ path: entry.path, error }); }
  }
  try { await fs.rmdir(stagingRoot); } catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") failures.push({ path: stagingRoot, error }); }
  return { preserved, failures };
}

async function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("close", resolve); killer.once("error", resolve);
    });
  } else { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} }
}

export async function runRootWorkbookAuditWorker({ requestPath, requestFileSha256, requestNonce, timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, stdoutMaxBytes = MAX_WORKER_STDOUT_BYTES, stderrMaxBytes = MAX_WORKER_STDERR_BYTES, workerScriptPath = BUILDER_PATH } = {}) {
  const absoluteRequest = path.resolve(cleanText(requestPath, "worker requestPath"));
  cleanSha(requestFileSha256, "worker requestFileSha256");
  if (!STAGING_TOKEN_RE.test(requestNonce ?? "")) fail("worker requestNonce is invalid.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail("timeoutMs exceeds the fixed worker limit.");
  if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1 || stdoutMaxBytes > MAX_WORKER_STDOUT_BYTES) fail("stdoutMaxBytes exceeds the fixed worker limit.");
  if (!Number.isSafeInteger(stderrMaxBytes) || stderrMaxBytes < 1 || stderrMaxBytes > MAX_WORKER_STDERR_BYTES) fail("stderrMaxBytes exceeds the fixed worker limit.");
  const child = spawn(process.execPath, [path.resolve(workerScriptPath), "--audit-worker", "--request", absoluteRequest, "--request-sha256", requestFileSha256, "--request-nonce", requestNonce], { shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let done = false; let stopReason = null;
    const terminate = (reason) => { if (!stopReason) stopReason = reason; void killProcessTree(child); };
    const timer = setTimeout(() => terminate(new Error("audit worker timed out")), timeoutMs);
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes > stdoutMaxBytes) terminate(new Error("audit worker stdout exceeded its bounded limit")); else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > stderrMaxBytes) terminate(new Error("audit worker stderr exceeded its bounded limit")); else stderr.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); if (!done) { done = true; reject(error); } });
    child.once("close", (code, signal) => {
      clearTimeout(timer); if (done) return; done = true;
      if (stopReason) return reject(stopReason);
      const rawStdout = Buffer.concat(stdout).toString("utf8"); const rawStderr = Buffer.concat(stderr).toString("utf8");
      if (code !== 0 || signal || rawStderr) return reject(new Error(`audit worker failed (${code ?? signal}): ${rawStderr.trim()}`));
      const lines = rawStdout.split(/\r?\n/u).filter(Boolean);
      if (lines.length !== 1) return reject(new Error("audit worker stdout must contain exactly one strict JSON line"));
      try { resolve({ ...parseStrictJson(lines[0]), rawStdout }); } catch (error) { reject(new Error("audit worker stdout is not strict JSON", { cause: error })); }
    });
  });
}

function candidateFilename(profile, revision) { return `${profile.archiveStem}_修正版${revision}.xlsx`; }
function planFilename(profile, revision) { return `${profile.archiveStem}_修正版${revision}.root-plan.json`; }

export async function buildRootWorkbookCandidates(request, { testHooks } = {}) {
  const registry = await loadProfileRegistry();
  const checked = validateBuildRequest(clone(request), registry);
  const stagingRoot = path.join(path.resolve(os.tmpdir()), `${STAGING_PREFIX}${checked.stagingToken}`);
  const owned = [];
  let createdRoot = false;
  try {
    await fs.mkdir(stagingRoot, { recursive: false });
    createdRoot = true;
    await callHook(testHooks, "afterStagingCreated", { stagingRoot });
    const marker = await writeOwned(owned, "owner-marker", path.join(stagingRoot, ".codex-xhs-owner.json"), jsonBytes({ kind: "root-workbook-staging-owner-v1", stagingToken: checked.stagingToken, pid: process.pid }), testHooks);
    const builtDetails = await mapSettledLimit(checked.artifacts, 3, async (artifact) => {
      const built = await buildCandidateTemp(artifact, checked.certificate, stagingRoot, testHooks);
      await recordOwned(owned, { kind: "temp-candidate", path: built.tempPath, profileId: artifact.profileId, sha256: built.tempSha256, size: built.tempSize }, testHooks);
      return built;
    });
    const built = builtDetails.settled.map((entry) => entry.value);
    const requestNonce = crypto.randomBytes(32).toString("hex");
    const workerRequest = { kind: ROOT_WORKBOOK_AUDIT_REQUEST_KIND, requestNonce, reimbursementFactsCertificate: checked.certificate.raw, profiles: built.map((item) => ({ profileId: item.profileId, baselinePath: item.artifact.baselinePath, baselineSha256: item.artifact.baselineSha256, candidatePath: item.tempPath, candidateSha256: item.tempSha256 })) };
    workerRequest.requestDigest = computeRootWorkbookAuditRequestDigest(workerRequest);
    const requestBytes = jsonBytes(workerRequest);
    const requestEntry = await writeOwned(owned, "worker-request", path.join(stagingRoot, `.audit-request.${requestNonce}.json`), requestBytes, testHooks);
    await callHook(testHooks, "afterWorkerRequestWritten", { requestPath: requestEntry.path, requestBody: clone(workerRequest) });
    await callHook(testHooks, "onWorkerSpawn", { profiles: checked.profileIds.length });
    await callHook(testHooks, "onWorkerAuditConcurrency", { peak: Math.min(3, checked.profileIds.length) });
    const rawResponse = await runRootWorkbookAuditWorker({ requestPath: requestEntry.path, requestFileSha256: requestEntry.sha256, requestNonce });
    await callHook(testHooks, "afterAuditWorkerResponse", rawResponse);
    const { rawStdout: _rawStdout, ...response } = rawResponse;
    const auditBatch = validateRootWorkbookAuditBatch(response, { requestDigest: workerRequest.requestDigest, requestFileSha256: requestEntry.sha256, requestNonce, profileIds: checked.profileIds, profileBindings: workerRequest.profiles.map((item) => ({ profileId: item.profileId, baselineSha256: item.baselineSha256, candidateSha256: item.candidateSha256 })), certificate: checked.certificate.raw });
    const committed = [];
    for (const [index, item] of built.entries()) {
      const audit = auditBatch.audits[index];
      const finalPath = path.join(stagingRoot, candidateFilename(item.artifact.profile, item.artifact.candidateRevision));
      const tempBytes = await fs.readFile(item.tempPath);
      const finalEntry = await writeOwned(owned, "final-candidate", finalPath, tempBytes, testHooks, item.profileId);
      await callHook(testHooks, "afterFinalCandidateWrite", { finalPath, profileId: item.profileId });
      const final = await stableFacts(finalPath, item.tempSha256, item.tempSize, `${item.profileId} final candidate`);
      if (finalEntry.sha256 !== item.tempSha256 || final.facts.factsDigest !== item.facts.factsDigest || audit.candidate.sourceSha256 !== final.snapshot.sha256) fail(`${item.profileId} final candidate differs from the independently audited temp bytes.`);
      const planBody = { kind: "root-workbook-build-plan-v1", requiresGate1Binding: true, profile: clone(audit.profile), manifest: clone(audit.manifest), baseline: clone(audit.baseline), candidate: { path: finalPath, sha256: final.snapshot.sha256, size: final.snapshot.size, factsDigest: final.facts.factsDigest }, profileBinding: { profileId: item.profileId, baselineSha256: workerRequest.profiles[index].baselineSha256, candidateSha256: workerRequest.profiles[index].candidateSha256 }, transitionDigest: audit.transitionDigest, audit: clone(audit), stagingOwnership: { token: checked.stagingToken, ownerMarkerSha256: marker.sha256 }, candidateRevision: item.artifact.candidateRevision };
      const plan = { ...planBody, planDigest: canonicalDigest(planBody) };
      const planEntry = await writeOwned(owned, "plan", path.join(stagingRoot, planFilename(item.artifact.profile, item.artifact.candidateRevision)), jsonBytes(plan), testHooks, item.profileId);
      const stablePlan = await readStableUtf8JsonFile(planEntry.path, { maxBytes: MAX_WORKER_REQUEST_BYTES });
      if (stablePlan.sha256 !== planEntry.sha256 || stablePlan.value.planDigest !== plan.planDigest) fail(`${item.profileId} plan stable digest changed after commit.`);
      committed.push({ profileId: item.profileId, candidateRevision: item.artifact.candidateRevision, candidatePath: finalPath, candidateSha256: final.snapshot.sha256, candidateSize: final.snapshot.size, candidateFactsDigest: final.facts.factsDigest, planPath: planEntry.path, planSha256: stablePlan.sha256, planSize: stablePlan.size, planDigest: plan.planDigest, audit });
    }
    return deepFreeze({
      kind: ROOT_WORKBOOK_BUILD_RESULT_KIND,
      requiresGate1Binding: true,
      stagingRoot,
      stagingToken: checked.stagingToken,
      requestDigest: workerRequest.requestDigest,
      requestFileSha256: requestEntry.sha256,
      auditBatchDigest: canonicalDigest(auditBatch),
      artifacts: committed,
      ownedFiles: owned.map(({ kind, path: filePath, sha256, size, profileId }) => ({
        kind,
        path: filePath,
        sha256,
        size,
        ...(profileId ? { profileId } : {}),
      })),
    });
  } catch (reason) {
    const primary = reason instanceof Error ? reason : new Error(String(reason));
    if (!createdRoot) throw primary;
    const cleanup = await cleanupOwned(owned, stagingRoot);
    if (cleanup.preserved.length || cleanup.failures.length) {
      const detail = [cleanup.preserved.length ? `externally changed files preserved: ${cleanup.preserved.join(", ")}` : "", cleanup.failures.length ? `cleanup failures: ${cleanup.failures.map((item) => item.path).join(", ")}` : ""].filter(Boolean).join("; ");
      throw new Error(`${primary.message}; ${detail}`, { cause: primary });
    }
    throw primary;
  }
}

async function auditWorkerMain(args) {
  if (args.length !== 7 || args[0] !== "--audit-worker" || args[1] !== "--request" || args[3] !== "--request-sha256" || args[5] !== "--request-nonce") fail("audit worker arguments are invalid.");
  const requestPath = path.resolve(args[2]);
  const expectedSha256 = cleanSha(args[4], "audit worker expected request SHA");
  const expectedNonce = cleanText(args[6], "audit worker expected nonce");
  const snapshot = await readStableUtf8JsonFile(requestPath, { maxBytes: MAX_WORKER_REQUEST_BYTES });
  if (snapshot.sha256 !== expectedSha256) fail("audit request file SHA differs from the parent binding.");
  const request = validateAuditRequest(snapshot.value);
  if (request.requestNonce !== expectedNonce) fail("audit request nonce differs from the parent binding.");
  const registry = await loadProfileRegistry();
  const profileIds = request.profiles.map((item) => item.profileId);
  const expectedOrder = registry.profileOrder.filter((profileId) => profileIds.includes(profileId));
  if (canonicalDigest(profileIds) !== canonicalDigest(expectedOrder) || new Set(profileIds).size !== profileIds.length) fail("audit request profiles are duplicate or outside fixed registry order.");
  const { auditLedgerLayout } = await import("./audit_ledger_layout.mjs");
  const settled = await mapSettledLimit(request.profiles, 3, (profile) => auditLedgerLayout({ input: { kind: "root-workbook-business-audit-input-v2", profileId: profile.profileId, baselineSha256: profile.baselineSha256, candidateSha256: profile.candidateSha256, reimbursementFactsCertificate: request.reimbursementFactsCertificate }, baselinePath: profile.baselinePath, candidatePath: profile.candidatePath }));
  process.stdout.write(`${JSON.stringify({ kind: ROOT_WORKBOOK_AUDIT_BATCH_KIND, requestDigest: request.requestDigest, requestFileSha256: snapshot.sha256, requestNonce: request.requestNonce, audits: settled.settled.map((entry) => entry.value) })}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--audit-worker") return auditWorkerMain(args);
  if (args.length !== 2 || args[0] !== "--input") fail("usage: build_root_workbook_candidate.mjs --input <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_WORKER_REQUEST_BYTES });
  process.stdout.write(`${JSON.stringify(await buildRootWorkbookCandidates(input.value))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
}
