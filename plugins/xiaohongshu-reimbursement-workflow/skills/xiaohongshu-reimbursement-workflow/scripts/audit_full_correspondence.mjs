import path from "node:path";

import { inspectEvidenceImage } from "./build_reimbursement_artifacts.mjs";
import { formatMilliunits, loadProfileRegistry, parseMilliunits, resolveProfile } from "./finance_domain.mjs";
import { loadTextTemplateAsset } from "./template_assets.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  loadBundledDependency,
  mapSettledLimit,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";

export const INDEPENDENT_EVIDENCE_REVIEW_KIND = "independent-evidence-review-v1";
export const FULL_CORRESPONDENCE_AUDIT_KIND = "gate2-full-correspondence-v1";

const SHA_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const SOURCE_CONCURRENCY = 4;
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

class CorrespondenceValidationError extends Error {}

function fail(message) {
  throw new CorrespondenceValidationError(`Full Correspondence Auditor ${message}`);
}

function isRetryableInfrastructureError(error) {
  const codes = new Set(["EACCES", "EPERM", "EBUSY", "EMFILE", "ENFILE", "ENOMEM", "EIO", "ETIMEDOUT", "ENOENT"]);
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) if (codes.has(current.code)) return true;
  return false;
}

async function mapSettledInInputOrder(items, limit, worker) {
  try {
    return await mapSettledLimit(items, limit, worker);
  } catch (error) {
    const settled = error?.settledDetails?.settled;
    if (Array.isArray(settled)) {
      const firstRejected = settled.find((item) => item?.status === "rejected");
      if (firstRejected) throw firstRejected.reason;
    }
    throw error;
  }
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t\0]/u.test(value)) fail(`${field} must be trimmed non-empty text.`);
  return value;
}

function sha(value, field) {
  const result = text(value, field);
  if (!SHA_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function exact(value, keys, field) {
  object(value, field);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function clone(value) {
  return structuredClone(value);
}

function without(value, ...keys) {
  const result = clone(value);
  for (const key of keys) delete result[key];
  return result;
}

function asAmount(value, field) {
  return parseMilliunits(String(value), field, { allowNegative: true });
}

function amount(value) {
  return formatMilliunits(value);
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0n);
}

function stableTextCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSourceRefs(values, field, onDuplicate = null) {
  const original = array(values, field).map((value, index) => text(value, `${field}[${index}]`));
  const seen = new Set(); const duplicates = [];
  for (const value of original) {
    if (seen.has(value)) duplicates.push(value);
    else seen.add(value);
  }
  if (duplicates.length > 0) onDuplicate?.([...new Set(duplicates)].sort(stableTextCompare));
  return { original, sorted: [...seen].sort(stableTextCompare), duplicates };
}

function sortedUnique(values) {
  return normalizeSourceRefs(values, "internal stable text set").sorted;
}

function uniqueMap(items, keySelector, add, code, artifact) {
  const result = new Map();
  for (const [index, item] of items.entries()) {
    const key = keySelector(item, index);
    if (result.has(key)) add("duplicate", code, { artifact, location: `${artifact}[${index}]`, key });
    else result.set(key, item);
  }
  return result;
}

function unxml(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function serialToIso(raw, date1904) {
  const serial = Number(raw);
  if (!Number.isFinite(serial)) fail(`date serial ${raw} is invalid.`);
  return new Date((serial - (date1904 ? 24_107 : 25_569)) * 86_400_000).toISOString().slice(0, 10);
}

function issueStore() {
  const result = { missing: [], extra: [], mismatches: [], duplicate: [], unbound: [], blocking: [] };
  const add = (kind, code, detail = {}) => {
    if (!Object.hasOwn(result, kind)) fail(`internal issue kind ${kind} is invalid.`);
    result[kind].push({ code, ...detail });
  };
  const block = (code, detail = {}) => add("blocking", code, detail);
  return { result, add, block };
}

function publicValue(value) {
  if (typeof value === "bigint") return amount(value);
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publicValue(child)]));
  return value;
}

function sortIssues(issues) {
  const fields = ["code", "profileId", "transactionId", "sourceRef", "evidenceId", "fileId", "artifact", "location", "field", "annotationIndex"];
  for (const items of Object.values(issues)) items.sort((left, right) => {
    for (const field of fields) {
      const compared = stableTextCompare(String(left[field] ?? ""), String(right[field] ?? ""));
      if (compared !== 0) return compared;
    }
    return stableTextCompare(JSON.stringify(publicValue(left)), JSON.stringify(publicValue(right)));
  });
}

function compare(add, actual, expected, detail) {
  if (canonicalDigest(publicValue(actual)) !== canonicalDigest(publicValue(expected))) {
    add("mismatches", detail.code, { ...without(detail, "code"), expected: publicValue(expected), actual: publicValue(actual) });
    return false;
  }
  return true;
}

function cellMap(sheet) {
  const result = new Map();
  for (const row of sheet.rows) for (const cell of row.cells) result.set(cell.ref, cell);
  return result;
}

function cellScalar(cell) {
  if (!cell) return null;
  if (cell.formula) return cell.cachedValue;
  return cell.value?.text ?? cell.value?.raw ?? null;
}

function mergeAt(sheet, row, column) {
  return sheet.merges.find((item) => item.startRow <= row && row <= item.endRow && item.startColumn <= column && column <= item.endColumn) ?? null;
}

function columnName(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function resolvedCell(sheet, cells, row, column) {
  const direct = cells.get(`${columnName(column)}${row}`);
  if (direct) return direct;
  const merge = mergeAt(sheet, row, column);
  return merge ? cells.get(`${columnName(merge.startColumn)}${merge.startRow}`) ?? null : null;
}

function mergeRef(startColumn, startRow, endColumn, endRow) {
  return `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`;
}

function requireMerge(add, sheet, ref, detail) {
  if (!sheet.merges.some((item) => item.ref === ref)) add("missing", "required-merge-missing", { ...detail, expected: ref });
}

function requireFormula(add, cell, expected, detail) {
  const actual = cell?.formula?.text ?? null;
  compare(add, actual, expected, { code: "formula-mismatch", ...detail });
}

const TRANSACTION_CHECK_STAGES = ["visual", "detail", "screenshot", "supplement", "summary", "candidate", "root-preview", "preview-binding", "evidence"];
const TRANSACTION_STAGE_ARTIFACTS = new Map([
  ["visual", new Set(["independent-evidence-review", "source"])],
  ["summary", new Set(["summary", "summary-annotation"])],
  ["root-preview", new Set(["root-preview"])],
  ["preview-binding", new Set(["gate1-preview"])],
  ["evidence", new Set(["evidence-archive", "source"])],
]);

function markTransactionCheck(transactionResults, transactionId, stage, location) {
  const result = transactionResults.get(transactionId);
  if (!result) return;
  result.checkedStages.add(stage);
  if (location) result.locations.push({ artifact: stage, ...location });
}

function normalizeObservedFact(fact, field) {
  object(fact, field);
  const allowed = new Set(["transactionId", "date", "person", "project", "sourceAmount"]);
  for (const key of Object.keys(fact)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  const transactionId = text(fact.transactionId, `${field}.transactionId`);
  const result = { transactionId };
  for (const key of ["date", "person", "project"]) if (Object.hasOwn(fact, key)) result[key] = text(fact[key], `${field}.${key}`);
  if (Object.hasOwn(fact, "sourceAmount")) result.sourceAmount = amount(asAmount(fact.sourceAmount, `${field}.sourceAmount`));
  if (Object.keys(result).length === 1) fail(`${field} must observe at least one business field.`);
  return result;
}

function normalizeAnnotationObservation(annotation, field) {
  exact(annotation, new Set(["profileId", "person", "kind", "period", "amount", "sourceRefs"]), field);
  exact(annotation.period, new Set(["start", "end"]), `${field}.period`);
  const normalizedSourceRefs = normalizeSourceRefs(annotation.sourceRefs, `${field}.sourceRefs`);
  if (normalizedSourceRefs.original.length === 0 || normalizedSourceRefs.duplicates.length > 0) fail(`${field}.sourceRefs must be a non-empty unique array.`);
  return {
    profileId: text(annotation.profileId, `${field}.profileId`),
    person: text(annotation.person, `${field}.person`),
    kind: text(annotation.kind, `${field}.kind`),
    period: { start: text(annotation.period.start, `${field}.period.start`), end: text(annotation.period.end, `${field}.period.end`) },
    amount: amount(asAmount(annotation.amount, `${field}.amount`)),
    sourceRefs: normalizedSourceRefs.sorted,
  };
}

function groupedTotals(transactions, keySelector, amountSelector) {
  const grouped = new Map();
  for (const transaction of transactions) {
    const key = keySelector(transaction);
    grouped.set(key, (grouped.get(key) ?? 0n) + amountSelector(transaction));
  }
  return [...grouped].map(([key, total]) => ({ key, amount: amount(total) })).sort((left, right) => left.key.localeCompare(right.key, "zh-CN"));
}

function expectedDetailSections(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const key = JSON.stringify([transaction.settlement, transaction.person]);
    if (!groups.has(key)) groups.set(key, { settlement: transaction.settlement, person: transaction.person, transactions: [] });
    groups.get(key).transactions.push(transaction);
  }
  return [...groups.values()]
    .sort((left, right) => Number(left.settlement === "company_paid_no_reimbursement") - Number(right.settlement === "company_paid_no_reimbursement")
      || Math.min(...left.transactions.map((item) => item.sourceOrder)) - Math.min(...right.transactions.map((item) => item.sourceOrder)))
    .map((section) => ({ ...section, transactions: section.transactions.sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder) }));
}

function runs(items, keySelector) {
  const result = [];
  for (let start = 0; start < items.length;) {
    let end = start;
    while (end + 1 < items.length && keySelector(items[end + 1]) === keySelector(items[start])) end += 1;
    result.push({ start, end });
    start = end + 1;
  }
  return result;
}

function reimbursementAttribute(transaction, evidenceFiles) {
  const settlementText = transaction.settlement === "company_paid_no_reimbursement" ? "对公已付不实报" : "实报";
  const hasVoucher = transaction.evidence.some((evidenceId) => evidenceFiles.get(evidenceId)?.usage === "voucher");
  return `${settlementText}；${hasVoucher ? "有截图" : "无截图"}`;
}

function validateTabularRows({ add, sheet, expected, startRow, profileId, artifact, person, transactionResults, evidenceFiles }) {
  const cells = cellMap(sheet);
  const dateRuns = runs(expected, (item) => item.date);
  const feeRuns = runs(expected, (item) => JSON.stringify([item.classification, item.settlement]));
  const attributeRuns = runs(expected, (item) => reimbursementAttribute(item, evidenceFiles));
  const dateByStart = new Map(dateRuns.map((run) => [run.start, run]));
  const feeByStart = new Map(feeRuns.map((run) => [run.start, run]));
  const attributeByStart = new Map(attributeRuns.map((run) => [run.start, run]));
  for (const [index, transaction] of expected.entries()) {
    const row = startRow + index;
    const location = `${artifact}!${row}`;
    const actual = {
      date: serialToIso(cellScalar(resolvedCell(sheet, cells, row, 1)), sheet.date1904 ?? false),
      project: cellScalar(resolvedCell(sheet, cells, row, 2)),
      sourceAmount: amount(asAmount(cellScalar(resolvedCell(sheet, cells, row, 3)), `${location}.sourceAmount`)),
      person,
      classification: cellScalar(resolvedCell(sheet, cells, row, 5)),
      settlement: cellScalar(resolvedCell(sheet, cells, row, 6)),
    };
    const wanted = {
      date: transaction.date,
      project: transaction.project,
      sourceAmount: transaction.sourceAmount,
      person: transaction.person,
      classification: transaction.classification,
      settlement: reimbursementAttribute(transaction, evidenceFiles),
    };
    compare(add, actual, wanted, { code: "transaction-row-mismatch", profileId, transactionId: transaction.id, artifact, location });
    markTransactionCheck(transactionResults, transaction.id, artifact, { row });
    const dateRun = dateByStart.get(index);
    if (dateRun && dateRun.end > dateRun.start) requireMerge(add, sheet, mergeRef(1, row, 1, row + dateRun.end - dateRun.start), { profileId, transactionId: transaction.id, artifact, location });
    const feeRun = feeByStart.get(index);
    if (feeRun) {
      const endRow = row + feeRun.end - feeRun.start;
      const formulaCell = cells.get(`D${row}`);
      requireFormula(add, formulaCell, `SUM(C${row}:C${endRow})`, { profileId, transactionId: transaction.id, artifact, location: `D${row}` });
      const expectedTotal = sum(expected.slice(feeRun.start, feeRun.end + 1), (item) => item.sourceMilliunits);
      compare(add, amount(asAmount(cellScalar(formulaCell), `${artifact}!D${row}`)), amount(expectedTotal), { code: "formula-total-mismatch", profileId, transactionId: transaction.id, artifact, location: `D${row}` });
      if (endRow > row) for (const column of [4, 5]) requireMerge(add, sheet, mergeRef(column, row, column, endRow), { profileId, transactionId: transaction.id, artifact, location });
    }
    const attributeRun = attributeByStart.get(index);
    if (attributeRun && attributeRun.end > attributeRun.start) {
      requireMerge(add, sheet, mergeRef(6, row, 6, row + attributeRun.end - attributeRun.start), { profileId, transactionId: transaction.id, artifact, location });
    }
  }
}

function attributes(tag) {
  const result = new Map();
  for (const match of String(tag).matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/gu)) result.set(match[1], unxml(match[2]));
  return result;
}

function normalizeZipTarget(basePart, target) {
  const slash = target.replaceAll("\\", "/");
  return slash.startsWith("/") ? slash.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(basePart), slash));
}

function parseProjectedWorksheet(xml, { selectedRows, includeAllRows = false }) {
  const rows = [];
  const outOfRangeValueCells = [];
  const selected = selectedRows ? new Set(selectedRows) : null;
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/giu)) {
    const rowAttributes = attributes(rowMatch[1]);
    const row = Number(rowAttributes.get("r"));
    if (!Number.isSafeInteger(row) || row < 1) fail("worksheet contains an invalid explicit row coordinate.");
    if (!includeAllRows && selected && !selected.has(row)) continue;
    const cells = [];
    for (const match of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/giu)) {
      const attrs = attributes(match[1]);
      const ref = attrs.get("r");
      const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(ref ?? "");
      if (!coordinate || Number(coordinate[2]) !== row) continue;
      let column = 0;
      for (const character of coordinate[1]) column = column * 26 + character.charCodeAt(0) - 64;
      const body = match[2] ?? "";
      if (column > 6) {
        if (/<(?:\w+:)?(?:f|v|is|t)\b/iu.test(body)) outOfRangeValueCells.push(ref);
        continue;
      }
      const type = attrs.get("t") ?? "n";
      const inline = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/giu)].map((item) => unxml(item[1])).join("");
      const raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/iu.exec(body)?.[1] ?? null;
      const formulaText = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/iu.exec(body)?.[1] ?? null;
      let value = raw === null ? null : unxml(raw);
      if (type === "s" && value !== null) fail("selected worksheet projection unexpectedly depends on historical shared strings.");
      if (inline) value = inline;
      cells.push({
        ref,
        row,
        column,
        type,
        value: formulaText === null && value !== null ? { raw: type === "inlineStr" || type === "str" || type === "s" ? null : value, text: type === "inlineStr" || type === "str" || type === "s" ? value : null } : null,
        formula: formulaText === null ? null : { text: unxml(formulaText) },
        cachedValue: formulaText === null ? null : value,
      });
    }
    rows.push({ index: row, cells });
  }
  const merges = [];
  for (const match of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref="([A-Z]{1,3}[1-9]\d*):([A-Z]{1,3}[1-9]\d*)"[^>]*\/>/giu)) {
    const parse = (ref) => {
      const coordinate = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(ref);
      let column = 0;
      for (const character of coordinate[1]) column = column * 26 + character.charCodeAt(0) - 64;
      return { row: Number(coordinate[2]), column };
    };
    const start = parse(match[1]);
    const end = parse(match[2]);
    if (end.column < 1 || start.column > 6) continue;
    if (selected && !includeAllRows && ![...selected].some((row) => start.row <= row && row <= end.row)) continue;
    merges.push({ ref: `${match[1]}:${match[2]}`, startRow: start.row, startColumn: start.column, endRow: end.row, endColumn: end.column });
  }
  return { rows, merges, outOfRangeValueCells };
}

async function loadWorkbookOnce(binding, role, cache, metrics, options) {
  const absolutePath = path.resolve(text(binding.path, `${role}.path`));
  const expectedSha = sha(binding.sha256, `${role}.sha256`);
  const selectedRows = options?.selectedRows ? [...options.selectedRows].sort((left, right) => left - right) : null;
  const key = `${absolutePath}\0${expectedSha}\0${options?.sheetName ?? ""}\0${selectedRows?.join(",") ?? "all"}`;
  if (cache.has(key)) {
    metrics.artifactCacheHits += 1;
    return cache.get(key);
  }
  const promise = (async () => {
    const stable = await readStableBinaryFile(absolutePath);
    if (stable.sha256 !== expectedSha || (binding.size !== undefined && stable.size !== binding.size)) fail(`${role} changed after Gate 1.`);
    const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
    const workbookPart = "xl/workbook.xml";
    const workbookXml = await zip.file(workbookPart)?.async("string");
    const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!workbookXml || !workbookRelsXml) fail(`${role} is missing workbook identity parts.`);
    const relationshipTargets = new Map();
    for (const match of workbookRelsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/giu)) relationshipTargets.set(match[1], normalizeZipTarget(workbookPart, unxml(match[2])));
    const expectedSheetName = text(options?.sheetName, `${role}.sheetName`);
    let sheetRelationshipId = null;
    const workbookSheets = [];
    for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?\s*>/giu)) {
      const attrs = attributes(match[0]);
      workbookSheets.push({
        name: attrs.get("name") ?? null,
        relationshipId: attrs.get("r:id") ?? attrs.get("id") ?? null,
        state: attrs.get("state") ?? "visible",
      });
      if (attrs.get("name") === expectedSheetName) {
        sheetRelationshipId = attrs.get("r:id") ?? attrs.get("id") ?? null;
      }
    }
    const worksheetPart = sheetRelationshipId ? relationshipTargets.get(sheetRelationshipId) : null;
    if (!worksheetPart) fail(`${role} is missing sheet ${expectedSheetName}.`);
    const worksheetXml = await zip.file(worksheetPart)?.async("string");
    if (!worksheetXml) fail(`${role} sheet part is missing.`);
    const parsed = parseProjectedWorksheet(worksheetXml, {
      selectedRows,
      includeAllRows: options?.includeAllRows === true,
    });
    if (options?.strictSingleSheet === true) {
      const worksheetParts = [...relationshipTargets.values()].filter((target) => /(?:^|\/)worksheets\/[^/]+\.xml$/iu.test(target));
      if (workbookSheets.length !== 1 || workbookSheets[0]?.name !== expectedSheetName || workbookSheets[0]?.state !== "visible" || worksheetParts.length !== 1 || worksheetParts[0] !== worksheetPart) {
        fail(`${role} must contain exactly one visible worksheet named ${expectedSheetName}.`);
      }
      if (parsed.outOfRangeValueCells.length > 0) fail(`${role} contains values outside A:F (${parsed.outOfRangeValueCells.join(", ")}).`);
    }
    const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/iu.test(workbookXml);
    const facts = { workbook: { date1904 }, worksheets: [{ name: expectedSheetName, date1904, ...parsed }] };
    metrics.artifactParseCount += 1;
    metrics.artifactParseByRole[role] = (metrics.artifactParseByRole[role] ?? 0) + 1;
    return { facts };
  })();
  cache.set(key, promise);
  return promise;
}

function sheetByName(facts, sheetName, role) {
  const sheet = facts.worksheets.find((item) => item.name === sheetName);
  if (!sheet) fail(`${role} is missing sheet ${sheetName}.`);
  return { ...sheet, date1904: facts.workbook.date1904 };
}

async function loadScreenshotOnce(binding, role, cache, metrics) {
  const absolutePath = path.resolve(text(binding.path, `${role}.path`));
  const expectedSha = sha(binding.sha256, `${role}.sha256`);
  const key = `${absolutePath}\0${expectedSha}`;
  if (cache.has(key)) {
    metrics.artifactCacheHits += 1;
    return cache.get(key);
  }
  const promise = (async () => {
    const stable = await readStableBinaryFile(absolutePath);
    if (stable.sha256 !== expectedSha || (binding.size !== undefined && stable.size !== binding.size)) fail(`${role} changed after Gate 1.`);
    const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    if (!sheetXml) fail(`${role} is missing its worksheet.`);
    const drawingXml = await zip.file("xl/drawings/drawing1.xml")?.async("string") ?? "";
    const relsXml = await zip.file("xl/drawings/_rels/drawing1.xml.rels")?.async("string") ?? "";
    const relationshipEntries = [];
    const relationships = new Map();
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/giu)) {
      const entry = { id: match[1], partName: `xl/${path.posix.normalize(path.posix.join("drawings", unxml(match[2])))}` };
      relationshipEntries.push(entry);
      if (!relationships.has(entry.id)) relationships.set(entry.id, entry.partName);
    }
    const anchors = [];
    for (const match of drawingXml.matchAll(/<(?:\w+:)?oneCellAnchor\b[^>]*>([\s\S]*?)<\/(?:\w+:)?oneCellAnchor>/giu)) {
      const body = match[1];
      const name = unxml(/<(?:\w+:)?cNvPr\b[^>]*\bname="([^"]+)"/iu.exec(body)?.[1] ?? "");
      const relationshipId = /<(?:\w+:)?blip\b[^>]*(?:\br:embed|\bembed)="([^"]+)"/iu.exec(body)?.[1] ?? "";
      const row = Number(/<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/iu.exec(body)?.[1] ?? -1) + 1;
      const column = Number(/<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>/iu.exec(body)?.[1] ?? -1) + 1;
      anchors.push({ name, relationshipId, row, column, partName: relationships.get(relationshipId) ?? null });
    }
    const media = new Map();
    const mediaParts = Object.keys(zip.files).filter((partName) => /^xl\/media\/[^/]+$/iu.test(partName)).sort();
    for (const partName of mediaParts) {
      const bytes = await zip.file(partName)?.async("nodebuffer");
      if (!bytes) fail(`${role} drawing media ${partName} is missing.`);
      media.set(partName, { sha256: sha256Bytes(bytes), size: bytes.length });
    }
    metrics.artifactParseCount += 1;
    metrics.artifactParseByRole[role] = (metrics.artifactParseByRole[role] ?? 0) + 1;
    const rows = parseProjectedWorksheet(sheetXml, { includeAllRows: true }).rows.map((row) => ({ row: row.index, cells: new Map(row.cells.map((cell) => [cell.ref, cellScalar(cell)])) }));
    return { rows, anchors, media, mediaParts, relationshipEntries };
  })();
  cache.set(key, promise);
  return promise;
}

function validateCertificate(state) {
  const certificate = object(state.certificate, "Gate 1 certificate");
  if (certificate.kind !== "reimbursement-manifest-facts-v1" || certificate.operationMode !== "reimbursement-batch") fail("Gate 1 certificate kind is unsupported.");
  for (const field of ["manifestFileSha256", "factsDigest", "sourceCoverageDigest", "certificateDigest"]) sha(certificate[field], `certificate.${field}`);
  if (canonicalDigest(certificate.factsPreimage) !== certificate.factsDigest || canonicalDigest(certificate.sourceCoveragePreimage) !== certificate.sourceCoverageDigest) fail("Gate 1 certificate preimage digest differs.");
  if (canonicalDigest(without(certificate, "certificateDigest")) !== certificate.certificateDigest) fail("Gate 1 certificate digest differs.");
  if (certificate.manifestFileSha256 !== state.manifest.sha256) fail("Gate 1 manifest SHA differs from its certificate.");
  return certificate;
}

function bindTransactions(manifest, certificate, add, registry) {
  const rawById = new Map();
  const rawFileById = new Map(array(manifest.files, "manifest.files").map((file) => [file.id, file]));
  for (const [index, raw] of array(manifest.transactions, "manifest.transactions").entries()) {
    const id = text(raw?.id, `manifest.transactions[${index}].id`);
    if (rawById.has(id)) add("duplicate", "manifest-transaction-id-duplicate", { transactionId: id, location: `manifest.transactions[${index}]` });
    rawById.set(id, raw);
  }
  const sourceRefBindings = uniqueMap(array(certificate.sourceCoveragePreimage.transactionSourceRefs, "certificate.sourceCoveragePreimage.transactionSourceRefs"), (item) => item.transactionId, add, "source-coverage-transaction-duplicate", "transactionSourceRefs");
  const sourceRefsByTransaction = new Map([...sourceRefBindings].map(([transactionId, item]) => {
    const normalized = normalizeSourceRefs(item.sourceRefs, `certificate sourceRefs for ${transactionId}`, (duplicates) => add("duplicate", "source-coverage-source-ref-duplicate", { transactionId, artifact: "certificate", duplicates }));
    return [transactionId, normalized.sorted];
  }));
  const result = [];
  const certificateTransactionIds = new Set();
  for (const [index, fact] of array(certificate.factsPreimage.transactions, "certificate.factsPreimage.transactions").entries()) {
    if (certificateTransactionIds.has(fact.id)) add("duplicate", "certificate-transaction-id-duplicate", { transactionId: fact.id, artifact: "certificate", location: `factsPreimage.transactions[${index}]` });
    certificateTransactionIds.add(fact.id);
    const raw = rawById.get(fact.id);
    if (!raw) {
      add("missing", "manifest-transaction-missing", { transactionId: fact.id, location: `certificate.factsPreimage.transactions[${index}]` });
      continue;
    }
    const sourceAmount = amount(asAmount(fact.sourceAmount ?? fact.amount, `${fact.id}.sourceAmount`));
    const reimbursementAmount = amount(asAmount(fact.reimbursementAmount ?? fact.sourceAmount ?? fact.amount, `${fact.id}.reimbursementAmount`));
    const resolvedProfile = resolveProfile(raw.category, registry);
    const normalizedReportingKind = raw.date < manifest.batch.mainPeriod.start ? "supplement" : raw.reportingKind;
    const expectedRaw = {
      date: fact.date,
      person: fact.person,
      project: fact.project,
      label: fact.label,
      profileId: fact.profileId,
      category: fact.category,
      sourceOrder: fact.sourceOrder,
      classification: fact.classification,
      sourceAmount,
      reimbursementAmount,
      settlement: fact.settlement,
      reportingKind: fact.reportingKind,
      supplementReason: fact.supplementReason ?? null,
    };
    const actualRaw = {
      date: raw.date,
      person: raw.person,
      project: raw.project,
      label: raw.label,
      profileId: resolvedProfile.profileId,
      category: resolvedProfile.targetCategory,
      sourceOrder: raw.sourceOrder,
      classification: raw.classification,
      sourceAmount: amount(asAmount(raw.sourceAmount ?? raw.amount, `${fact.id}.manifestSourceAmount`)),
      reimbursementAmount: amount(asAmount(raw.reimbursementAmount ?? raw.sourceAmount ?? raw.amount, `${fact.id}.manifestReimbursementAmount`)),
      settlement: raw.settlement,
      reportingKind: normalizedReportingKind,
      supplementReason: raw.supplementReason ?? null,
    };
    compare(add, actualRaw, expectedRaw, { code: "manifest-certificate-transaction-mismatch", transactionId: fact.id, artifact: "manifest", location: `transactions[${index}]` });
    const rawSourceRefs = normalizeSourceRefs(raw.sourceRefs, `manifest.transactions[${index}].sourceRefs`, (duplicates) => add("duplicate", "manifest-transaction-source-ref-duplicate", { transactionId: fact.id, artifact: "manifest", location: `transactions[${index}].sourceRefs`, duplicates }));
    compare(add, rawSourceRefs.sorted, sourceRefsByTransaction.get(fact.id), { code: "manifest-source-refs-mismatch", transactionId: fact.id, artifact: "manifest", location: `transactions[${index}].sourceRefs` });
    const evidence = array(raw.evidence, `${fact.id}.evidence`).map((value, evidenceIndex) => text(value, `${fact.id}.evidence[${evidenceIndex}]`));
    if (new Set(evidence).size !== evidence.length) add("duplicate", "manifest-transaction-evidence-duplicate", { transactionId: fact.id, artifact: "manifest", location: `transactions[${index}].evidence` });
    const hasImage = evidence.some((id) => rawFileById.get(id)?.kind === "image");
    compare(add, raw.missingEvidenceConfirmed === true, !hasImage, { code: "manifest-missing-evidence-flag-mismatch", transactionId: fact.id, artifact: "manifest", location: `transactions[${index}].missingEvidenceConfirmed` });
    result.push({
      ...clone(fact),
      sourceAmount,
      reimbursementAmount,
      sourceMilliunits: asAmount(sourceAmount, `${fact.id}.sourceAmount`),
      reimbursementMilliunits: asAmount(reimbursementAmount, `${fact.id}.reimbursementAmount`),
      evidence,
      sourceRefs: normalizeSourceRefs(sourceRefsByTransaction.get(fact.id), `${fact.id}.sourceRefs`).sorted,
      missingEvidenceConfirmed: raw.missingEvidenceConfirmed === true,
    });
  }
  for (const id of rawById.keys()) if (!result.some((item) => item.id === id)) add("extra", "manifest-transaction-extra", { transactionId: id, artifact: "manifest" });
  return result;
}

function sourceBindings(manifest, certificate, transactions, add) {
  const files = new Map();
  for (const [index, file] of array(manifest.files, "manifest.files").entries()) {
    const id = text(file?.id, `manifest.files[${index}].id`);
    if (files.has(id)) add("duplicate", "manifest-file-id-duplicate", { artifact: "manifest", location: `files[${index}]`, fileId: id });
    files.set(id, { ...file, path: path.resolve(text(file.path, `${id}.path`)), sha256: sha(file.sha256, `${id}.sha256`) });
  }
  const scopes = uniqueMap(array(certificate.sourceCoveragePreimage.sourceScopes, "sourceScopes"), (scope) => scope.id, add, "source-scope-id-duplicate", "sourceScopes");
  const units = uniqueMap(array(certificate.sourceCoveragePreimage.sourceUnits, "sourceUnits"), (unit) => unit.id, add, "source-unit-id-duplicate", "sourceUnits");
  const byRef = new Map();
  const transactionById = new Map(transactions.map((item) => [item.id, item]));
  for (const transaction of transactions) {
    for (const evidenceId of transaction.evidence) {
      const file = files.get(evidenceId);
      if (!file) add("unbound", "transaction-evidence-file-unbound", { transactionId: transaction.id, evidenceId, artifact: "manifest" });
      else if (file.role !== "material" || file.disposition !== "used") add("mismatches", "transaction-evidence-file-state-mismatch", { transactionId: transaction.id, evidenceId, artifact: "manifest", expected: { role: "material", disposition: "used" }, actual: { role: file.role, disposition: file.disposition } });
    }
    for (const sourceRef of transaction.sourceRefs) {
    const unit = units.get(sourceRef);
    const scope = unit ? scopes.get(unit.scopeId) : null;
    const file = scope ? files.get(scope.fileId) : null;
    if (!unit || !scope || !file) {
      add("unbound", "source-ref-unbound", { transactionId: transaction.id, sourceRef, artifact: "manifest/sourceCoverage" });
      continue;
    }
    if (scope.fileSha256 !== file.sha256) add("mismatches", "source-scope-file-sha-mismatch", { transactionId: transaction.id, sourceRef, fileId: file.id, expected: scope.fileSha256, actual: file.sha256 });
    if (!transaction.evidence.includes(scope.fileId)) add("missing", "source-file-evidence-binding-missing", { transactionId: transaction.id, sourceRef, fileId: scope.fileId, artifact: "manifest" });
    byRef.set(sourceRef, { sourceRef, unit, scope, file });
    }
  }
  for (const item of certificate.sourceCoveragePreimage.transactionSourceRefs) if (!transactionById.has(item.transactionId)) add("unbound", "source-coverage-transaction-unbound", { transactionId: item.transactionId, artifact: "sourceCoverage" });
  const usedMediaFiles = [...files.values()].filter((file) => file.role === "material" && file.disposition === "used" && file.kind === "image");
  const boundMediaIds = new Set([...byRef.values()].filter((item) => item.file.kind === "image").map((item) => item.file.id));
  for (const file of usedMediaFiles) if (!boundMediaIds.has(file.id)) add("unbound", "used-media-unbound", { fileId: file.id, artifact: "manifest", sourceSha256: file.sha256 });
  return { files, byRef, usedMediaFiles };
}

function validateSummaryAnnotations(manifest, certificate, transactionsById, add) {
  const normalizeProjection = (annotation, field, artifact, annotationIndex) => {
    const normalized = clone(object(annotation, field));
    const sourceRefs = normalizeSourceRefs(normalized.sourceRefs, `${field}.sourceRefs`, (duplicates) => add("duplicate", "summary-annotation-source-ref-duplicate", { annotationIndex, artifact, location: field, duplicates }));
    normalized.sourceRefs = sourceRefs.sorted;
    return normalized;
  };
  const annotations = array(certificate.factsPreimage.summaryAnnotations, "certificate.factsPreimage.summaryAnnotations")
    .map((annotation, index) => normalizeProjection(annotation, `certificate.factsPreimage.summaryAnnotations[${index}]`, "certificate", index));
  const manifestAnnotations = array(manifest.batch.summaryAnnotations ?? [], "manifest.batch.summaryAnnotations")
    .map((annotation, index) => normalizeProjection(annotation, `manifest.batch.summaryAnnotations[${index}]`, "manifest", index));
  compare(add, manifestAnnotations, annotations, { code: "manifest-summary-annotations-mismatch", artifact: "manifest", location: "batch.summaryAnnotations" });
  const usedTransactions = new Set();
  const results = [];
  for (const [index, annotation] of annotations.entries()) {
    const location = `summaryAnnotations[${index}]`;
    const transactionIds = array(annotation.transactionIds, `${location}.transactionIds`);
    const selected = transactionIds.map((id) => transactionsById.get(id));
    if (new Set(transactionIds).size !== transactionIds.length) add("duplicate", "summary-annotation-transaction-duplicate", { annotationIndex: index, artifact: "summary-annotation", location });
    for (const id of transactionIds) {
      if (usedTransactions.has(id)) add("duplicate", "summary-annotation-transaction-reused", { annotationIndex: index, transactionId: id, artifact: "summary-annotation", location });
      usedTransactions.add(id);
    }
    if (selected.some((item) => !item)) add("unbound", "summary-annotation-transaction-unbound", { annotationIndex: index, artifact: "summary-annotation", location });
    else {
      for (const transaction of selected) compare(add, { profileId: transaction.profileId, person: transaction.person, settlement: transaction.settlement }, { profileId: annotation.profileId, person: annotation.person, settlement: "employee_reimbursement" }, { code: "summary-annotation-transaction-binding-mismatch", annotationIndex: index, transactionId: transaction.id, artifact: "summary-annotation", location });
      compare(add, annotation.amount, amount(sum(selected, (item) => item.reimbursementMilliunits)), { code: "summary-annotation-amount-mismatch", annotationIndex: index, artifact: "summary-annotation", location });
      compare(add, annotation.sourceRefs, sortedUnique(selected.flatMap((item) => item.sourceRefs)), { code: "summary-annotation-source-refs-mismatch", annotationIndex: index, artifact: "summary-annotation", location });
    }
    if (!new Set(["commission", "bonus", "allowance"]).has(annotation.kind)) add("mismatches", "summary-annotation-kind-mismatch", { annotationIndex: index, artifact: "summary-annotation", location, actual: annotation.kind });
    results.push({ annotationIndex: index, ...clone(annotation), independentReviewMatched: false });
  }
  return { annotations, results };
}

function validateReview(review, state, sourceByRef, transactions, annotations, annotationResults, add, block) {
  let reviewBlocked = false;
  const blockReview = (code, detail = {}) => { reviewBlocked = true; block(code, detail); };
  const pendingSemanticComparisons = [];
  exact(review, new Set(["kind", "reviewerRunId", "gate1BindingDigest", "sourceCoverageDigest", "independence", "observations", "annotationObservations"]), "independent evidence review");
  if (review.kind !== INDEPENDENT_EVIDENCE_REVIEW_KIND) fail("independent evidence review kind is unsupported.");
  text(review.reviewerRunId, "independent evidence review reviewerRunId");
  if (review.gate1BindingDigest !== state.gate1.bindingDigest || review.sourceCoverageDigest !== state.certificate.sourceCoverageDigest) fail("independent evidence review Gate 1/source binding differs.");
  exact(review.independence, new Set(["performedAfterGate1", "originalSourcesReadFresh", "gate1ArtifactsNotUsed", "observationsNotCopied"]), "independent evidence review independence");
  for (const field of ["performedAfterGate1", "originalSourcesReadFresh", "gate1ArtifactsNotUsed", "observationsNotCopied"]) if (review.independence[field] !== true) fail(`independent evidence review independence.${field} must be true.`);
  const observations = new Map();
  for (const [index, observation] of array(review.observations, "independent evidence review observations").entries()) {
    exact(observation, new Set(["sourceRef", "fileId", "sourceSha256", "mediaKind", "width", "height", "facts"]), `observations[${index}]`);
    const sourceRef = text(observation.sourceRef, `observations[${index}].sourceRef`);
    if (observations.has(sourceRef)) {
      blockReview("independent-review-source-ref-duplicate", { sourceRef, artifact: "independent-evidence-review", location: `observations[${index}]` });
      continue;
    }
    const normalized = {
      sourceRef,
      fileId: text(observation.fileId, `observations[${index}].fileId`),
      sourceSha256: sha(observation.sourceSha256, `observations[${index}].sourceSha256`),
      mediaKind: text(observation.mediaKind, `observations[${index}].mediaKind`),
      width: observation.width,
      height: observation.height,
      facts: array(observation.facts, `observations[${index}].facts`).map((fact, factIndex) => normalizeObservedFact(fact, `observations[${index}].facts[${factIndex}]`)),
    };
    observations.set(sourceRef, normalized);
  }
  const annotationObservations = array(review.annotationObservations, "independent evidence review annotationObservations")
    .map((annotation, index) => normalizeAnnotationObservation(annotation, `annotationObservations[${index}]`));
  const expectedByRef = new Map();
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const aggregated = new Map();
  for (const transaction of transactions) for (const sourceRef of transaction.sourceRefs) {
    if (!expectedByRef.has(sourceRef)) expectedByRef.set(sourceRef, new Set());
    expectedByRef.get(sourceRef).add(transaction.id);
  }
  for (const [sourceRef, expectedTransactions] of expectedByRef) {
    const source = sourceByRef.get(sourceRef);
    const observation = observations.get(sourceRef);
    if (!observation) {
      blockReview("independent-review-observation-missing", { sourceRef, fileId: source?.file.id, artifact: "independent-evidence-review" });
      continue;
    }
    if (source) {
      if (canonicalDigest({ fileId: observation.fileId, sourceSha256: observation.sourceSha256 }) !== canonicalDigest({ fileId: source.file.id, sourceSha256: source.file.sha256 })) blockReview("independent-review-source-binding-mismatch", { sourceRef, artifact: "independent-evidence-review", expected: { fileId: source.file.id, sourceSha256: source.file.sha256 }, actual: { fileId: observation.fileId, sourceSha256: observation.sourceSha256 } });
    }
    for (const fact of observation.facts) {
      const transaction = transactionById.get(fact.transactionId);
      if (!transaction || !expectedTransactions.has(fact.transactionId)) {
        blockReview("independent-review-fact-transaction-unbound", { sourceRef, transactionId: fact.transactionId, fileId: source?.file.id, artifact: "independent-evidence-review" });
        continue;
      }
      if (!aggregated.has(fact.transactionId)) aggregated.set(fact.transactionId, new Map());
      const fields = aggregated.get(fact.transactionId);
      for (const field of ["date", "person", "project", "sourceAmount"]) if (Object.hasOwn(fact, field)) {
        if (!fields.has(field)) fields.set(field, new Set());
        fields.get(field).add(fact[field]);
      }
    }
  }
  for (const sourceRef of observations.keys()) if (!expectedByRef.has(sourceRef)) blockReview("independent-review-observation-extra", { sourceRef, artifact: "independent-evidence-review" });
  for (const [index, annotation] of annotationObservations.entries()) for (const sourceRef of annotation.sourceRefs) {
    if (!expectedByRef.has(sourceRef)) blockReview("independent-review-annotation-source-ref-unbound", { annotationObservationIndex: index, sourceRef, artifact: "independent-evidence-review" });
  }
  const unusedAnnotationObservations = new Set(annotationObservations.map((_, index) => index));
  for (const [annotationIndex, annotation] of annotations.entries()) {
    const expected = normalizeAnnotationObservation({
      profileId: annotation.profileId,
      person: annotation.person,
      kind: annotation.kind,
      period: annotation.period,
      amount: annotation.amount,
      sourceRefs: annotation.sourceRefs,
    }, `summaryAnnotations[${annotationIndex}] projection`);
    const identityDigest = canonicalDigest(without(expected, "amount"));
    const matchIndexes = [...unusedAnnotationObservations].filter((index) => canonicalDigest(without(annotationObservations[index], "amount")) === identityDigest);
    if (matchIndexes.length === 0) {
      blockReview("independent-review-summary-annotation-missing", { annotationIndex, artifact: "independent-evidence-review", expected: without(expected, "amount") });
    } else if (matchIndexes.length > 1) {
      blockReview("independent-review-summary-annotation-ambiguous", { annotationIndex, artifact: "independent-evidence-review", matchIndexes });
    } else {
      const matchIndex = matchIndexes[0];
      unusedAnnotationObservations.delete(matchIndex);
      annotationResults[annotationIndex].observedFacts = clone(annotationObservations[matchIndex]);
      const amountMatches = annotationObservations[matchIndex].amount === expected.amount;
      annotationResults[annotationIndex].independentReviewMatched = amountMatches;
      if (!amountMatches) pendingSemanticComparisons.push({ actual: annotationObservations[matchIndex].amount, expected: expected.amount, detail: { code: "independent-review-summary-annotation-amount-mismatch", annotationIndex, artifact: "independent-evidence-review" } });
    }
  }
  for (const annotationObservationIndex of unusedAnnotationObservations) blockReview("independent-review-summary-annotation-extra", {
    annotationObservationIndex,
    artifact: "independent-evidence-review",
    actual: clone(annotationObservations[annotationObservationIndex]),
  });
  for (const transaction of transactions.filter((item) => item.sourceRefs.length > 0)) {
    const fields = aggregated.get(transaction.id) ?? new Map();
    for (const field of ["date", "person", "project", "sourceAmount"]) {
      const values = [...(fields.get(field) ?? [])];
      if (values.length === 0) blockReview("independent-review-transaction-field-missing", { transactionId: transaction.id, field, artifact: "independent-evidence-review" });
      else if (values.length > 1) blockReview("independent-review-transaction-field-conflict", { transactionId: transaction.id, field, artifact: "independent-evidence-review", actual: values.sort(stableTextCompare) });
      else pendingSemanticComparisons.push({ actual: values[0], expected: transaction[field], detail: { code: "independent-visual-observation-mismatch", transactionId: transaction.id, field, artifact: "independent-evidence-review" } });
    }
  }
  if (!reviewBlocked) for (const comparison of pendingSemanticComparisons) compare(add, comparison.actual, comparison.expected, comparison.detail);
  return observations;
}

async function freshReviewSources(sourceByRef, usedMediaFiles, observations, add, metrics, hooks) {
  const unique = new Map();
  for (const binding of sourceByRef.values()) if (!unique.has(binding.file.sha256)) unique.set(binding.file.sha256, binding.file);
  for (const file of usedMediaFiles) if (!unique.has(file.sha256)) unique.set(file.sha256, file);
  const settled = await mapSettledLimit([...unique.values()], SOURCE_CONCURRENCY, async (file) => {
    await hooks?.beforeSourceRead?.(clone(file));
    const stable = await readStableBinaryFile(file.path, { maxBytes: MAX_SOURCE_BYTES });
    metrics.uniqueSourceReadCount += 1;
    if (stable.sha256 !== file.sha256) return { file, error: "source SHA changed after Gate 1" };
    let image = null;
    if (file.kind === "image") {
      metrics.uniqueMediaReadCount += 1;
      try {
        image = await inspectEvidenceImage(copyStableBinaryBytes(stable), `independent source ${file.id}`);
        metrics.uniqueMediaDecodeCount += 1;
      } catch (error) {
        return { file, error: `source full decode failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { file, image };
  });
  const results = new Map(settled.settled.map((entry) => [entry.value.file.sha256, entry.value]));
  for (const [sourceRef, binding] of sourceByRef) {
    const result = results.get(binding.file.sha256);
    const observation = observations.get(sourceRef);
    if (!result || result.error) {
      add("mismatches", "fresh-source-read-mismatch", { sourceRef, fileId: binding.file.id, artifact: "source", expected: binding.file.sha256, actual: result?.error ?? null });
      continue;
    }
    const expectedKind = binding.file.kind === "image" ? "image" : "other";
    if (observation) {
      compare(add, observation.mediaKind, expectedKind, { code: "independent-review-media-kind-mismatch", sourceRef, fileId: binding.file.id, artifact: "independent-evidence-review" });
      if (result.image) compare(add, { width: observation.width, height: observation.height }, { width: result.image.width, height: result.image.height }, { code: "independent-review-dimensions-mismatch", sourceRef, fileId: binding.file.id, artifact: "independent-evidence-review" });
    }
  }
  return results;
}

function validateDetail(add, sheet, transactions, profileId, transactionResults, evidenceFiles) {
  const cells = cellMap(sheet);
  const employeeTotal = sum(transactions.filter((item) => item.settlement === "employee_reimbursement"), (item) => item.reimbursementMilliunits);
  const mainTotal = sum(transactions.filter((item) => item.reportingKind === "current"), (item) => item.reimbursementMilliunits);
  const supplementTotal = sum(transactions.filter((item) => item.reportingKind === "supplement"), (item) => item.reimbursementMilliunits);
  const companyTotal = sum(transactions.filter((item) => item.settlement === "company_paid_no_reimbursement"), (item) => item.sourceMilliunits);
  const feeTotal = sum(transactions, (item) => item.sourceMilliunits);
  for (const [ref, expected, label] of [["A4", mainTotal, "main-reimbursement"], ["C4", supplementTotal, "supplement-reimbursement"], ["E4", employeeTotal, "reimbursement-total"]]) {
    compare(add, amount(asAmount(cellScalar(cells.get(ref)), `detail.${ref}`)), amount(expected), { code: "detail-summary-total-mismatch", profileId, artifact: "detail", location: ref, field: label });
  }
  requireFormula(add, cells.get("E4"), "A4+C4", { profileId, artifact: "detail", location: "E4" });
  compare(add, cellScalar(cells.get("A5")), `对公已付不实报：${amount(companyTotal)}`, { code: "detail-company-total-mismatch", profileId, artifact: "detail", location: "A5" });
  compare(add, cellScalar(cells.get("D5")), `费用合计：${amount(feeTotal)}`, { code: "detail-fee-total-mismatch", profileId, artifact: "detail", location: "D5" });
  compare(add, cellScalar(cells.get("F6")), "报销属性", { code: "detail-reimbursement-header-mismatch", profileId, artifact: "detail", location: "F6" });
  const sections = expectedDetailSections(transactions);
  let row = 7;
  for (const section of sections) {
    const sectionLabel = section.settlement === "company_paid_no_reimbursement" ? `${section.person}（对公已付不实报）｜${section.transactions.length}笔` : `${section.person}｜${section.transactions.length}笔`;
    compare(add, cellScalar(cells.get(`A${row}`)), sectionLabel, { code: "detail-person-group-mismatch", profileId, artifact: "detail", location: `A${row}` });
    requireMerge(add, sheet, mergeRef(1, row, 4, row), { profileId, artifact: "detail", location: `A${row}` });
    const start = row + 1;
    const end = start + section.transactions.length - 1;
    requireFormula(add, cells.get(`F${row}`), `SUM(C${start}:C${end})`, { profileId, artifact: "detail", location: `F${row}` });
    compare(add, amount(asAmount(cellScalar(cells.get(`F${row}`)), `detail.F${row}`)), amount(sum(section.transactions, (item) => item.sourceMilliunits)), { code: "detail-person-group-total-mismatch", profileId, transactionId: section.transactions[0]?.id, artifact: "detail", location: `F${row}` });
    validateTabularRows({ add, sheet, expected: section.transactions, startRow: start, profileId, artifact: "detail", person: section.person, transactionResults, evidenceFiles });
    row = end + 1;
  }
  const actualDataRows = sheet.rows.filter((item) => item.index >= 7 && item.cells.some((cell) => cell.column === 3 && cellScalar(cell) !== null)).length;
  compare(add, actualDataRows, transactions.length, { code: "detail-transaction-count-mismatch", profileId, artifact: "detail" });
}

function validateSupplement(add, sheet, expected, metadata, profileId, transactionResults, evidenceFiles) {
  const cells = cellMap(sheet);
  const ordered = [...expected].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
  const start = ordered[0]?.date ?? null;
  const end = ordered.at(-1)?.date ?? null;
  const period = start === end ? compactDate(start) : `${compactDate(start)}-${compactDate(end)}`;
  const reasons = [...new Set(ordered.map((item) => item.supplementReason))];
  const expectedSource = sum(ordered, (item) => item.sourceMilliunits);
  const expectedReimbursement = sum(ordered, (item) => item.reimbursementMilliunits);
  compare(add, metadata.count, expected.length, { code: "supplement-metadata-count-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.person, ordered[0]?.person, { code: "supplement-person-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.start, start, { code: "supplement-metadata-start-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.end, end, { code: "supplement-metadata-end-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.reasons, reasons, { code: "supplement-metadata-reasons-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.sourceAmount, amount(expectedSource), { code: "supplement-metadata-source-total-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.reimbursementAmount, amount(expectedReimbursement), { code: "supplement-metadata-reimbursement-total-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, metadata.amount, amount(expectedReimbursement), { code: "supplement-metadata-total-mismatch", profileId, artifact: "supplement", location: metadata.path });
  compare(add, cellScalar(cells.get("A1")), `${metadata.person} ${period} 小红书补报明细`, { code: "supplement-title-mismatch", profileId, artifact: "supplement", location: "A1" });
  compare(add, cellScalar(cells.get("A2")), `补报明细｜原因：${reasons.join("；")}`, { code: "supplement-reason-mismatch", profileId, artifact: "supplement", location: "A2" });
  compare(add, cellScalar(cells.get("A3")), `补报实报合计：${amount(expectedReimbursement)}元｜费用合计：${amount(expectedSource)}元｜共${ordered.length}笔`, { code: "supplement-summary-mismatch", profileId, artifact: "supplement", location: "A3" });
  compare(add, cellScalar(cells.get("F4")), "报销属性", { code: "supplement-reimbursement-header-mismatch", profileId, artifact: "supplement", location: "F4" });
  const footerRow = 5 + ordered.length;
  const footerLabels = sheet.rows.flatMap((item) => item.cells.map((cell) => ({ row: item.index, value: cellScalar(cell) }))).filter((item) => item.value === "补报总计");
  compare(add, footerLabels.length, 1, { code: "supplement-footer-count-mismatch", profileId, artifact: "supplement", location: `A${footerRow}` });
  compare(add, cellScalar(cells.get(`A${footerRow}`)), "补报总计", { code: "supplement-footer-label-mismatch", profileId, artifact: "supplement", location: `A${footerRow}` });
  requireMerge(add, sheet, `A${footerRow}:B${footerRow}`, { profileId, artifact: "supplement", location: `A${footerRow}` });
  requireMerge(add, sheet, `C${footerRow}:F${footerRow}`, { profileId, artifact: "supplement", location: `C${footerRow}` });
  requireFormula(add, cells.get(`C${footerRow}`), `SUM(C5:C${footerRow - 1})`, { profileId, artifact: "supplement", location: `C${footerRow}` });
  compare(add, amount(asAmount(cellScalar(cells.get(`C${footerRow}`)), `supplement.C${footerRow}`)), amount(expectedSource), { code: "supplement-formula-total-mismatch", profileId, artifact: "supplement", location: `C${footerRow}` });
  validateTabularRows({ add, sheet, expected: ordered, startRow: 5, profileId, artifact: "supplement", person: metadata.person, transactionResults, evidenceFiles });
  const actualDataRows = sheet.rows.filter((item) => item.index >= 5 && item.index < footerRow && item.cells.some((cell) => cell.column === 3 && cellScalar(cell) !== null)).length;
  compare(add, actualDataRows, ordered.length, { code: "supplement-transaction-count-mismatch", profileId, artifact: "supplement" });
  const trailingBusinessRows = sheet.rows.filter((item) => item.index > footerRow && item.cells.some((cell) => cellScalar(cell) !== null)).map((item) => item.index);
  compare(add, trailingBusinessRows, [], { code: "supplement-business-row-after-footer", profileId, artifact: "supplement", location: `row ${footerRow + 1}+` });
}

function validateScreenshot(add, screenshot, transactions, files, profileId, metadata, transactionResults) {
  const ordered = [...transactions].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const rowByNumber = new Map(screenshot.rows.map((item) => [item.row, item]));
  const displayedContext = new Set();
  const expectedAnchors = [];
  for (const [index, transaction] of ordered.entries()) {
    const row = index + 2;
    const cells = rowByNumber.get(row)?.cells ?? new Map();
    const referencedImageIds = transaction.evidence.filter((id) => files.get(id)?.kind === "image");
    const imageIds = referencedImageIds.filter((id) => {
      const file = files.get(id);
      if (file.usage !== "context") return true;
      if (displayedContext.has(file.sha256)) return false;
      displayedContext.add(file.sha256);
      return true;
    });
    const actual = {
      date: serialToIso(cells.get(`A${row}`), false),
      person: cells.get(`B${row}`),
      project: cells.get(`C${row}`),
      sourceAmount: amount(asAmount(cells.get(`D${row}`), `screenshot.D${row}`)),
      note: cells.get(`E${row}`),
    };
    const expected = { date: transaction.date, person: transaction.person, project: transaction.project, sourceAmount: transaction.sourceAmount, note: referencedImageIds.length ? transaction.classification : `${transaction.classification}｜无图片凭证` };
    compare(add, actual, expected, { code: "screenshot-row-mismatch", profileId, transactionId: transaction.id, artifact: "screenshot", location: `row ${row}` });
    markTransactionCheck(transactionResults, transaction.id, "screenshot", { row });
    for (const [imageIndex, evidenceId] of imageIds.entries()) expectedAnchors.push({ name: `${transaction.id}-${imageIndex + 1}`, row, column: 6 + imageIndex, sha256: files.get(evidenceId).sha256, evidenceId });
  }
  compare(add, screenshot.rows.filter((item) => item.row >= 2).length, ordered.length, { code: "screenshot-transaction-count-mismatch", profileId, artifact: "screenshot" });
  compare(add, metadata.imageCount, expectedAnchors.length, { code: "screenshot-image-count-mismatch", profileId, artifact: "screenshot" });
  compare(add, metadata.imageReferenceCount, ordered.reduce((count, item) => count + item.evidence.filter((id) => files.get(id)?.kind === "image").length, 0), { code: "screenshot-image-reference-count-mismatch", profileId, artifact: "screenshot" });
  const relationshipIds = Map.groupBy(screenshot.relationshipEntries, (item) => item.id);
  for (const [relationshipId, entries] of relationshipIds) if (entries.length > 1) add("duplicate", "screenshot-relationship-id-duplicate", { profileId, artifact: "screenshot", location: relationshipId });
  const anchorsByName = Map.groupBy(screenshot.anchors, (item) => item.name);
  for (const [name, anchors] of anchorsByName) if (anchors.length > 1) add("duplicate", "screenshot-anchor-name-duplicate", { profileId, artifact: "screenshot", location: name });
  const actualAnchorNames = new Set();
  for (const expected of expectedAnchors) {
    const anchor = screenshot.anchors.find((item) => item.name === expected.name);
    if (!anchor) {
      add("missing", "screenshot-anchor-missing", { profileId, transactionId: expected.name.split("-").slice(0, -1).join("-"), evidenceId: expected.evidenceId, artifact: "screenshot", location: expected.name });
      continue;
    }
    if (actualAnchorNames.has(anchor.name)) add("duplicate", "screenshot-anchor-duplicate", { profileId, artifact: "screenshot", location: anchor.name });
    actualAnchorNames.add(anchor.name);
    compare(add, { row: anchor.row, column: anchor.column, sha256: screenshot.media.get(anchor.partName)?.sha256 ?? null }, { row: expected.row, column: expected.column, sha256: expected.sha256 }, { code: "screenshot-image-mapping-mismatch", profileId, evidenceId: expected.evidenceId, artifact: "screenshot", location: expected.name });
  }
  for (const anchor of screenshot.anchors) if (!expectedAnchors.some((item) => item.name === anchor.name)) add("extra", "screenshot-anchor-extra", { profileId, artifact: "screenshot", location: anchor.name });
  const referencedMediaParts = new Set(screenshot.relationshipEntries.map((item) => item.partName));
  for (const relationship of screenshot.relationshipEntries) if (!screenshot.anchors.some((anchor) => anchor.relationshipId === relationship.id)) add("extra", "screenshot-drawing-target-extra", { profileId, artifact: "screenshot", location: relationship.id, partName: relationship.partName });
  for (const partName of screenshot.mediaParts) if (!referencedMediaParts.has(partName)) add("extra", "screenshot-media-part-extra", { profileId, artifact: "screenshot", location: partName });
  for (const partName of referencedMediaParts) if (!screenshot.media.has(partName)) add("missing", "screenshot-media-part-missing", { profileId, artifact: "screenshot", location: partName });
  compare(add, metadata.uniqueMediaCount, new Set(expectedAnchors.map((item) => item.sha256)).size, { code: "screenshot-unique-media-count-mismatch", profileId, artifact: "screenshot" });
}

function validateCandidate(add, sheet, root, transactionsById, profileId, transactionResults) {
  const cells = cellMap(sheet);
  const projectionRows = [...array(root.audit?.projection?.batchRows, `${profileId}.batchRows`)].sort((left, right) => left.row - right.row);
  const batchSet = new Set(projectionRows.map((item) => item.row));
  let activeDate = null;
  let priorRow = null;
  const records = [];
  for (const binding of projectionRows) {
    const transaction = transactionsById.get(binding.transactionId);
    if (!transaction) {
      add("unbound", "candidate-batch-row-unbound", { profileId, transactionId: binding.transactionId, artifact: "candidate", location: `row ${binding.row}` });
      continue;
    }
    if (priorRow === null || binding.row !== priorRow + 1) activeDate = null;
    const directDate = cellScalar(cells.get(`A${binding.row}`));
    if (directDate !== null) activeDate = serialToIso(directDate, sheet.date1904);
    const actual = {
      date: activeDate,
      project: cellScalar(cells.get(`B${binding.row}`)),
      sourceAmount: amount(asAmount(cellScalar(cells.get(`C${binding.row}`)), `candidate.C${binding.row}`)),
      person: cellScalar(resolvedCell(sheet, cells, binding.row, 5)),
      classification: cellScalar(resolvedCell(sheet, cells, binding.row, 6)),
    };
    const expected = { date: transaction.date, project: transaction.project, sourceAmount: transaction.sourceAmount, person: transaction.person, classification: transaction.classification };
    compare(add, actual, expected, { code: "candidate-row-mismatch", profileId, transactionId: transaction.id, artifact: "candidate", location: `row ${binding.row}` });
    markTransactionCheck(transactionResults, transaction.id, "candidate", { row: binding.row });
    records.push({ transaction, row: binding.row });
    priorRow = binding.row;
  }
  compare(add, projectionRows.length, [...transactionsById.values()].filter((item) => item.profileId === profileId).length, { code: "candidate-batch-count-mismatch", profileId, artifact: "candidate" });
  const segmentedRuns = (keySelector) => {
    const result = [];
    for (let start = 0; start < records.length;) {
      let end = start;
      while (end + 1 < records.length && records[end + 1].row === records[end].row + 1 && keySelector(records[end + 1]) === keySelector(records[start])) end += 1;
      result.push({ start, end });
      start = end + 1;
    }
    return result;
  };
  for (const dateRun of segmentedRuns((item) => item.transaction.date)) {
    const first = records[dateRun.start];
    const last = records[dateRun.end];
    if (first && last && last.row > first.row) requireMerge(add, sheet, mergeRef(1, first.row, 1, last.row), { profileId, transactionId: first.transaction.id, artifact: "candidate", location: `A${first.row}` });
  }
  for (const segment of segmentedRuns((item) => `${item.transaction.person}\0${item.transaction.classification}\0${item.transaction.settlement}`)) {
    const first = records[segment.start];
    const last = records[segment.end];
    if (!first || !last) continue;
    const d = cells.get(`D${first.row}`);
    requireFormula(add, d, `SUM(C${first.row}:C${last.row})`, { profileId, transactionId: first.transaction.id, artifact: "candidate", location: `D${first.row}` });
    compare(add, amount(asAmount(cellScalar(d), `candidate.D${first.row}`)), amount(sum(records.slice(segment.start, segment.end + 1), (item) => item.transaction.sourceMilliunits)), { code: "candidate-group-total-mismatch", profileId, transactionId: first.transaction.id, artifact: "candidate", location: `D${first.row}` });
    if (last.row > first.row) for (const column of [4, 5, 6]) requireMerge(add, sheet, mergeRef(column, first.row, column, last.row), { profileId, transactionId: first.transaction.id, artifact: "candidate", location: `${columnName(column)}${first.row}` });
  }
  for (const merge of sheet.merges) {
    const boundRowsCovered = [...batchSet].filter((row) => merge.startRow <= row && row <= merge.endRow).length;
    const coveredRowCount = merge.endRow - merge.startRow + 1;
    if (boundRowsCovered > 0 && merge.startColumn <= 6 && merge.endColumn >= 4 && boundRowsCovered !== coveredRowCount) add("mismatches", "candidate-merge-crosses-unbound-row", { profileId, artifact: "candidate", location: merge.ref });
  }
  return projectionRows;
}

function validateRootPreview(add, sheet, root, candidateSheet, projectionRows, transactionsById, profileId) {
  const cells = cellMap(sheet);
  const candidateCells = cellMap(candidateSheet);
  compare(add, root.previewRangeAddress, `A1:F${projectionRows.length + 1}`, { code: "root-preview-range-mismatch", profileId, artifact: "root-preview" });
  compare(add, [1, 2, 3, 4, 5, 6].map((column) => cellScalar(cells.get(`${columnName(column)}1`))), ["日期", "支出明细", "支出金额", "合计", "支出人", "备注"], { code: "root-preview-header-mismatch", profileId, artifact: "root-preview", location: "A1:F1" });
  const projected = projectionRows.map((binding) => ({ binding, transaction: transactionsById.get(binding.transactionId) }));
  const dateRuns = runs(projected, (item) => item.transaction?.date ?? "");
  const groupRuns = runs(projected, (item) => {
    const merge = candidateSheet.merges.find((candidateMerge) => candidateMerge.startColumn <= 4 && candidateMerge.endColumn >= 4 && candidateMerge.startRow <= item.binding.row && item.binding.row <= candidateMerge.endRow);
    return `${merge?.ref ?? item.binding.row}\0${item.transaction?.person}\0${item.transaction?.classification}`;
  });
  for (const [index, binding] of projectionRows.entries()) {
    const previewRow = index + 2;
    const transaction = transactionsById.get(binding.transactionId);
    const actual = {
      date: serialToIso(cellScalar(resolvedCell(sheet, cells, previewRow, 1)), sheet.date1904),
      project: cellScalar(cells.get(`B${previewRow}`)),
      sourceAmount: amount(asAmount(cellScalar(cells.get(`C${previewRow}`)), `root-preview.C${previewRow}`)),
      person: cellScalar(resolvedCell(sheet, cells, previewRow, 5)),
      classification: cellScalar(resolvedCell(sheet, cells, previewRow, 6)),
    };
    const candidate = {
      date: transaction?.date ?? null,
      project: cellScalar(candidateCells.get(`B${binding.row}`)),
      sourceAmount: amount(asAmount(cellScalar(candidateCells.get(`C${binding.row}`)), `candidate.C${binding.row}`)),
      person: cellScalar(resolvedCell(candidateSheet, candidateCells, binding.row, 5)),
      classification: cellScalar(resolvedCell(candidateSheet, candidateCells, binding.row, 6)),
    };
    compare(add, actual, candidate, { code: "root-preview-candidate-mismatch", profileId, transactionId: binding.transactionId, artifact: "root-preview", location: `row ${previewRow}` });
  }
  for (const dateRun of dateRuns) if (dateRun.end > dateRun.start) requireMerge(add, sheet, mergeRef(1, dateRun.start + 2, 1, dateRun.end + 2), { profileId, artifact: "root-preview", location: `A${dateRun.start + 2}` });
  for (const groupRun of groupRuns) {
    const startRow = groupRun.start + 2;
    const endRow = groupRun.end + 2;
    const formulaCell = cells.get(`D${startRow}`);
    requireFormula(add, formulaCell, `SUM(C${startRow}:C${endRow})`, { profileId, artifact: "root-preview", location: `D${startRow}` });
    compare(add, amount(asAmount(cellScalar(formulaCell), `root-preview.D${startRow}`)), amount(sum(projected.slice(groupRun.start, groupRun.end + 1), (item) => item.transaction.sourceMilliunits)), { code: "root-preview-total-mismatch", profileId, artifact: "root-preview", location: `D${startRow}` });
    if (endRow > startRow) for (const column of [4, 5, 6]) requireMerge(add, sheet, mergeRef(column, startRow, column, endRow), { profileId, artifact: "root-preview", location: `${columnName(column)}${startRow}` });
  }
  const dataRows = sheet.rows.filter((row) => row.index >= 2 && row.cells.some((cell) => cell.column === 3)).length;
  compare(add, dataRows, projectionRows.length, { code: "root-preview-row-count-mismatch", profileId, artifact: "root-preview" });
  for (const row of sheet.rows.filter((item) => item.index > projectionRows.length + 1 && item.cells.some((cell) => cell.column <= 6 && cellScalar(cell) !== null))) add("extra", "root-preview-historical-row-extra", { profileId, artifact: "root-preview", location: `row ${row.index}` });
}

function compactDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}.${month}.${day}`;
}

function chineseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function expectedSummaryText(transactions, mainPeriod, targetCategory, annotations, annotationLabels) {
  const groups = new Map();
  for (const transaction of transactions) {
    const displayLabel = transaction.settlement === "employee_reimbursement" ? transaction.person : transaction.label;
    const key = JSON.stringify([displayLabel, transaction.settlement]);
    const existing = groups.get(key);
    if (existing) {
      existing.source += transaction.sourceMilliunits;
      existing.reimbursement += transaction.reimbursementMilliunits;
      existing.sourceOrder = Math.min(existing.sourceOrder, transaction.sourceOrder);
    } else groups.set(key, { label: displayLabel, settlement: transaction.settlement, source: transaction.sourceMilliunits, reimbursement: transaction.reimbursementMilliunits, sourceOrder: transaction.sourceOrder });
  }
  const supplements = [...Map.groupBy(transactions.filter((item) => item.reportingKind === "supplement"), (item) => item.person)].map(([person, items]) => {
    const ordered = [...items].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
    const start = ordered[0].date;
    const end = ordered.at(-1).date;
    return {
      person,
      period: start === end ? compactDate(start) : `${compactDate(start)}-${compactDate(end)}`,
      count: ordered.length,
      amount: amount(sum(ordered, (item) => item.reimbursementMilliunits)),
      reasons: [...new Set(ordered.map((item) => item.supplementReason))],
    };
  });
  const supplementByPerson = new Map(supplements.map((item) => [item.person, item]));
  const annotationsByPerson = Map.groupBy(annotations, (item) => item.person);
  const lines = [`${chineseDate(mainPeriod.start)}—${chineseDate(mainPeriod.end)}${targetCategory}`, ""];
  for (const group of [...groups.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    if (group.settlement !== "employee_reimbursement") continue;
    const supplement = supplementByPerson.get(group.label);
    const clauses = (annotationsByPerson.get(group.label) ?? []).map((annotation) => `含${annotation.period.start === annotation.period.end ? compactDate(annotation.period.start) : `${compactDate(annotation.period.start)}-${compactDate(annotation.period.end)}`}${annotationLabels[annotation.kind]}${annotation.amount}元`);
    if (supplement) clauses.push(`含${supplement.period}补报${supplement.count}笔${supplement.amount}元`);
    lines.push(`${group.label}：${amount(group.reimbursement)}元${clauses.length ? `（${clauses.join("、")}）` : ""}`);
  }
  for (const group of [...groups.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) if (group.settlement === "company_paid_no_reimbursement") lines.push(`${group.label}对公已付不实报：${amount(group.source)}元`);
  lines.push(`实报合计：${amount(sum(transactions.filter((item) => item.settlement === "employee_reimbursement"), (item) => item.reimbursementMilliunits))}元`);
  const missing = transactions.filter((item) => item.missingEvidenceConfirmed);
  if (missing.length) lines.push("", `无截图说明：${missing.map((item) => `${item.person}-${item.project}-${item.sourceAmount}元`).join("；")}`);
  for (const supplement of supplements) lines.push(`补报说明：${supplement.person} ${supplement.period}，${supplement.count}笔，${supplement.amount}元；原因：${supplement.reasons.join("；")}`);
  return `${lines.join("\n")}\n`;
}

function validateSummary(add, summaryText, artifact, transactions, profileId, mainPeriod, targetCategory, annotations, summaryTemplate) {
  const expected = expectedSummaryText(transactions, mainPeriod, targetCategory, annotations, summaryTemplate.definition.annotationKindLabels);
  compare(add, summaryText, expected, { code: "summary-contract-mismatch", profileId, artifact: "summary", location: artifact.path });
  compare(add, artifact.templateSha256, summaryTemplate.sha256, { code: "summary-template-binding-mismatch", profileId, artifact: "summary", location: artifact.path });
  compare(add, artifact.annotationCount, annotations.length, { code: "summary-annotation-count-mismatch", profileId, artifact: "summary", location: artifact.path });
  compare(add, artifact.annotationDigest, canonicalDigest(annotations), { code: "summary-annotation-digest-mismatch", profileId, artifact: "summary", location: artifact.path });
}

function validatePreviewBindings(add, state, root, presentation, profileId) {
  const previews = state.previewBuild.previews.filter((item) => item.profileId === profileId);
  const expected = new Map([
    ["root", { sha256: root.previewSha256, sheetName: root.previewSheetName, range: root.previewRangeAddress }],
    ["detail", { sha256: presentation.detail.sha256, sheetName: presentation.detail.sheetName, range: `A1:F${presentation.detail.endRow}` }],
    ["screenshot", { sha256: presentation.screenshot.sha256, sheetName: presentation.screenshot.sheetName, range: `A1:${presentation.screenshot.endColumn}${presentation.screenshot.endRow}` }],
  ]);
  for (const [role, binding] of expected) {
    const preview = previews.find((item) => item.role === role);
    if (!preview) {
      add("missing", "gate1-preview-binding-missing", { profileId, artifact: "gate1-preview", role });
      continue;
    }
    compare(add, { sourceSha256: preview.sourceSha256, sheetName: preview.sheetName, rangeAddress: preview.rangeAddress, candidateSha256: preview.candidateSha256, planSha256: preview.planSha256, sourceCoverageDigest: preview.sourceCoverageDigest, batchRows: preview.batchRows }, { sourceSha256: binding.sha256, sheetName: binding.sheetName, rangeAddress: binding.range, candidateSha256: root.candidateSha256, planSha256: root.planSha256, sourceCoverageDigest: state.certificate.sourceCoverageDigest, batchRows: root.audit.projection.batchRanges.map((range) => `${range.startRow}:${range.endRow}`) }, { code: "gate1-preview-binding-mismatch", profileId, artifact: "gate1-preview", role });
    const expectedBindingDigest = sha256Bytes([
      "preview-job-binding-v2",
      preview.profileId,
      preview.role,
      preview.sourceSha256,
      preview.sheetName,
      preview.rangeAddress,
      preview.candidateSha256,
      preview.planSha256,
      preview.sourceCoverageDigest,
      preview.batchRows.join(","),
    ].join("\0"));
    compare(add, preview.bindingDigest, expectedBindingDigest, { code: "gate1-preview-job-digest-mismatch", profileId, artifact: "gate1-preview", role });
  }
  for (const preview of previews) if (!expected.has(preview.role)) add("extra", "gate1-preview-binding-extra", { profileId, artifact: "gate1-preview", role: preview.role });
}

async function validateEvidenceArchive(add, artifact, transactions, files, profileId, metrics, archiveCache, hooks) {
  const expectedBySha = new Map();
  for (const transaction of transactions) for (const evidenceId of transaction.evidence) {
    const file = files.get(evidenceId);
    if (file?.kind === "image" && !expectedBySha.has(file.sha256)) expectedBySha.set(file.sha256, evidenceId);
  }
  const actualBySha = new Map();
  for (const entry of artifact.evidenceArchive) {
    if (actualBySha.has(entry.sha256)) add("duplicate", "evidence-archive-sha-duplicate", { profileId, artifact: "evidence-archive", evidenceId: entry.evidenceId, location: entry.path });
    actualBySha.set(entry.sha256, entry);
    metrics.boundMediaArtifactCount += 1;
  }
  const loaded = await mapSettledInInputOrder(artifact.evidenceArchive, SOURCE_CONCURRENCY, async (entry) => {
    const archivePath = path.resolve(entry.path);
    const cacheKey = `${archivePath}\0${entry.sha256}`;
    let snapshot = archiveCache.get(cacheKey);
    if (!snapshot) {
      snapshot = (async () => {
        if (hooks?.beforeEvidenceArchiveRead) await hooks.beforeEvidenceArchiveRead({ profileId, path: archivePath, sha256: entry.sha256 });
        return readStableBinaryFile(archivePath, { maxBytes: MAX_SOURCE_BYTES });
      })();
      archiveCache.set(cacheKey, snapshot);
      metrics.uniqueArchiveMediaReadCount += 1;
    } else {
      metrics.archiveMediaCacheHits += 1;
    }
    const stable = await snapshot;
    return { entry, stable };
  });
  for (const { value: { entry, stable } } of loaded.settled) {
    if (stable.sha256 !== entry.sha256 || stable.size !== entry.size) add("mismatches", "evidence-archive-bytes-mismatch", { profileId, artifact: "evidence-archive", evidenceId: entry.evidenceId, location: entry.path, expected: { sha256: entry.sha256, size: entry.size }, actual: { sha256: stable.sha256, size: stable.size } });
  }
  for (const [digest, evidenceId] of expectedBySha) if (!actualBySha.has(digest)) add("missing", "evidence-archive-media-missing", { profileId, artifact: "evidence-archive", evidenceId, expected: digest });
  for (const [digest, entry] of actualBySha) if (!expectedBySha.has(digest)) add("extra", "evidence-archive-media-extra", { profileId, artifact: "evidence-archive", evidenceId: entry.evidenceId, actual: digest });
}

export async function auditFullCorrespondence(rawInput, { hooks } = {}) {
  exact(rawInput, new Set(["gate1State", "independentEvidenceReviewSnapshot"]), "full correspondence input");
  const state = object(rawInput.gate1State, "gate1State");
  const certificate = validateCertificate(state);
  const suppliedReview = object(rawInput.independentEvidenceReviewSnapshot, "independentEvidenceReviewSnapshot");
  exact(suppliedReview, new Set(["path", "sha256", "size", "value"]), "independentEvidenceReviewSnapshot");
  const reviewPath = path.resolve(text(suppliedReview.path, "independentEvidenceReviewSnapshot.path"));
  const reviewSha256 = sha(suppliedReview.sha256, "independentEvidenceReviewSnapshot.sha256");
  if (!Number.isSafeInteger(suppliedReview.size) || suppliedReview.size < 1) fail("independentEvidenceReviewSnapshot.size is invalid.");
  const metrics = {
    artifactParseCount: 0,
    artifactParseByRole: {},
    artifactCacheHits: 0,
    boundMediaArtifactCount: 0,
    uniqueArchiveMediaReadCount: 0,
    archiveMediaCacheHits: 0,
    uniqueMediaReadCount: 0,
    uniqueSourceReadCount: 0,
    uniqueMediaDecodeCount: 0,
    candidateSharedStringsLoaded: 0,
    candidateProjectedRowCount: 0,
    sourceReadConcurrency: SOURCE_CONCURRENCY,
    transactionCount: 0,
  };
  const { result: issues, add, block } = issueStore();
  compare(add, state.previewBuild.previewDigest, canonicalDigest(without(state.previewBuild, "previewDigest", "ownedFiles")), { code: "gate1-preview-set-digest-mismatch", artifact: "gate1-preview" });
  const registry = await loadProfileRegistry();
  const summaryTemplate = await loadTextTemplateAsset("summary-text");
  if (registry.profileConfigDigest !== certificate.profileConfigDigest) fail("profile registry differs from the Gate 1 certificate.");
  const manifestSnapshot = await readStableUtf8JsonFile(path.resolve(state.manifest.path), { maxBytes: MAX_JSON_BYTES });
  if (manifestSnapshot.sha256 !== state.manifest.sha256 || manifestSnapshot.sha256 !== certificate.manifestFileSha256) fail("manifest bytes changed after Gate 1.");
  const manifest = object(manifestSnapshot.value, "manifest");
  const transactions = bindTransactions(manifest, certificate, add, registry);
  metrics.transactionCount = transactions.length;
  const transactionsById = new Map(transactions.map((item) => [item.id, item]));
  const { annotations: summaryAnnotations, results: annotationResults } = validateSummaryAnnotations(manifest, certificate, transactionsById, add);
  const { files, byRef: sourceByRef, usedMediaFiles } = sourceBindings(manifest, certificate, transactions, add);

  const reviewSnapshot = suppliedReview;
  const review = object(reviewSnapshot.value, "independent evidence review");
  const observations = validateReview(review, state, sourceByRef, transactions, summaryAnnotations, annotationResults, add, block);
  // Fresh source verification and Gate 1 artifact loading are independent inputs
  // to this one Gate 2 audit. Start the fresh reads now, but join them before any
  // artifact validation so the original source-first error and issue ordering is
  // preserved while workbook ZIP inflation no longer waits on media decoding.
  const freshSourcesSettled = freshReviewSources(sourceByRef, usedMediaFiles, observations, add, metrics, hooks).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  let freshSources;
  const requireFreshSources = async () => {
    if (freshSources) return freshSources;
    const settled = await freshSourcesSettled;
    if (settled.status === "rejected") throw settled.reason;
    freshSources = settled.value;
    return freshSources;
  };

  const workbookCache = new Map();
  const screenshotCache = new Map();
  const archiveCache = new Map();
  const transactionResults = new Map(transactions.map((item) => [item.id, {
    transactionId: item.id,
    profileId: item.profileId,
    canonicalFacts: Object.fromEntries(["date", "person", "project", "label", "category", "sourceOrder", "classification", "sourceAmount", "reimbursementAmount", "settlement", "reportingKind", "supplementReason"].map((field) => [field, item[field] ?? null])),
    sourceRefs: [...item.sourceRefs],
    evidenceIds: [...item.evidence],
    missingEvidenceConfirmed: item.missingEvidenceConfirmed,
    multiImage: item.evidence.filter((id) => files.get(id)?.kind === "image").length > 1,
    observedFactsBySourceRef: item.sourceRefs.map((sourceRef) => {
      const observation = observations.get(sourceRef);
      return {
        sourceRef,
        fileId: observation?.fileId ?? null,
        sourceSha256: observation?.sourceSha256 ?? null,
        facts: (observation?.facts ?? []).filter((fact) => fact.transactionId === item.id).map(({ transactionId: _transactionId, ...fact }) => fact),
      };
    }),
    requiredStages: ["visual", "detail", "screenshot", ...(item.reportingKind === "supplement" ? ["supplement"] : []), "summary", "candidate", "root-preview", "preview-binding", "evidence"],
    checkedStages: new Set(),
    locations: [],
  }]));
  for (const transaction of transactions) markTransactionCheck(transactionResults, transaction.id, "visual", { reviewerRunId: review.reviewerRunId });
  const supplementResults = [];
  const profileAudits = [];
  const rootByProfile = new Map(state.rootBuild.artifacts.map((item) => [item.profileId, item]));
  const presentationByProfile = new Map(state.presentationBuild.artifacts.map((item) => [item.profileId, item]));
  for (const profileId of state.affectedProfileIds) {
    const profileTransactions = transactions.filter((item) => item.profileId === profileId);
    const presentation = presentationByProfile.get(profileId);
    const root = rootByProfile.get(profileId);
    if (!presentation || !root) {
      add("unbound", "profile-artifacts-unbound", { profileId, artifact: "Gate1-state" });
      continue;
    }
    const issueCountsBefore = Object.fromEntries(Object.entries(issues).map(([key, value]) => [key, value.length]));
    try {
      const supplementsByPerson = Map.groupBy(profileTransactions.filter((item) => item.reportingKind === "supplement"), (item) => item.person);
      const supplementPlans = new Map();
      for (const [index, supplement] of presentation.supplements.entries()) {
        const expected = (supplementsByPerson.get(supplement.person) ?? []).sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
        if (expected.length > 0) {
          supplementPlans.set(index, { supplement, expected });
          supplementsByPerson.delete(supplement.person);
        }
      }
      const candidateRows = root.audit.projection.batchRows.map((item) => item.row);
      const loadTasks = [
        { key: "detail", load: () => loadWorkbookOnce(presentation.detail, "detail", workbookCache, metrics, { sheetName: presentation.detail.sheetName, includeAllRows: true }) },
        { key: "screenshot", load: () => loadScreenshotOnce(presentation.screenshot, "screenshot", screenshotCache, metrics) },
        { key: "summary", load: async () => {
          const stable = await readStableBinaryFile(presentation.summary.path, { maxBytes: MAX_JSON_BYTES });
          metrics.artifactParseCount += 1;
          metrics.artifactParseByRole.summary = (metrics.artifactParseByRole.summary ?? 0) + 1;
          if (stable.sha256 !== presentation.summary.sha256 || stable.size !== presentation.summary.size) fail(`${profileId} summary changed after Gate 1.`);
          return { stable, text: copyStableBinaryBytes(stable).toString("utf8") };
        } },
        ...[...supplementPlans].map(([index, { supplement }]) => ({
          key: `supplement:${index}`,
          load: () => loadWorkbookOnce(supplement, "supplement", workbookCache, metrics, { sheetName: supplement.sheetName, includeAllRows: true }),
        })),
        { key: "candidate", load: () => loadWorkbookOnce({ path: root.candidatePath, sha256: root.candidateSha256, size: root.candidateSize }, "candidate", workbookCache, metrics, { sheetName: root.audit.profile.managedRootSheetName, selectedRows: candidateRows }) },
        { key: "root-preview", load: () => loadWorkbookOnce({ path: root.previewPath, sha256: root.previewSha256, size: root.previewSize }, "root-preview", workbookCache, metrics, { sheetName: root.previewSheetName, includeAllRows: true, strictSingleSheet: true }) },
      ];
      if (hooks?.beforeArtifactLoad) await hooks.beforeArtifactLoad({ profileId, taskKeys: loadTasks.map((task) => task.key) });
      // Evidence archive bytes are independent of the workbook/text artifact loads.
      // Start their stable reads here, but isolate issues and metrics until the
      // original evidence-validation point below so report ordering is unchanged.
      const evidenceIssueStore = issueStore();
      const evidenceMetrics = {
        boundMediaArtifactCount: 0,
        uniqueArchiveMediaReadCount: 0,
        archiveMediaCacheHits: 0,
      };
      const evidenceArchiveSettled = validateEvidenceArchive(
        evidenceIssueStore.add,
        presentation,
        profileTransactions,
        files,
        profileId,
        evidenceMetrics,
        archiveCache,
        hooks,
      ).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      );
      if (hooks?.beforeArtifactTasksExecute) await hooks.beforeArtifactTasksExecute({ profileId, taskKeys: loadTasks.map((task) => task.key) });
      let loaded;
      try {
        loaded = await mapSettledInInputOrder(loadTasks, SOURCE_CONCURRENCY, (task) => task.load());
      } catch (error) {
        await requireFreshSources();
        throw error;
      }
      await requireFreshSources();
      const loadedByKey = new Map(loadTasks.map((task, index) => [task.key, loaded.settled[index].value]));

      const detailFacts = loadedByKey.get("detail");
      validateDetail(add, sheetByName(detailFacts.facts, presentation.detail.sheetName, "detail"), profileTransactions, profileId, transactionResults, files);

      const screenshot = loadedByKey.get("screenshot");
      validateScreenshot(add, screenshot, profileTransactions, files, profileId, presentation.screenshot, transactionResults);

      const summaryText = loadedByKey.get("summary").text;
      compare(add, summaryText, presentation.summary.text, { code: "summary-state-file-mismatch", profileId, artifact: "summary", location: presentation.summary.path });
      const profileAnnotations = summaryAnnotations.filter((item) => item.profileId === profileId);
      validateSummary(add, summaryText, presentation.summary, profileTransactions, profileId, manifest.batch.mainPeriod, registry.profiles[profileId].targetCategory, profileAnnotations, summaryTemplate);
      for (const transaction of profileTransactions) markTransactionCheck(transactionResults, transaction.id, "summary", { path: presentation.summary.path });

      for (const [index, supplement] of presentation.supplements.entries()) {
        const plan = supplementPlans.get(index);
        if (!plan) {
          add("extra", "supplement-workbook-extra", { profileId, artifact: "supplement", location: supplement.path, person: supplement.person });
          continue;
        }
        const workbook = loadedByKey.get(`supplement:${index}`);
        validateSupplement(add, sheetByName(workbook.facts, supplement.sheetName, "supplement"), plan.expected, supplement, profileId, transactionResults, files);
        supplementResults.push({ profileId, person: supplement.person, start: supplement.start, end: supplement.end, count: supplement.count, amount: supplement.amount, sourceAmount: supplement.sourceAmount, reimbursementAmount: supplement.reimbursementAmount, reasons: [...supplement.reasons], path: supplement.path });
      }
      for (const [person, expected] of supplementsByPerson) add("missing", "supplement-workbook-missing", { profileId, artifact: "supplement", person, expectedCount: expected.length });

      const candidate = loadedByKey.get("candidate");
      const candidateSheet = sheetByName(candidate.facts, root.audit.profile.managedRootSheetName, "candidate");
      metrics.candidateProjectedRowCount += candidateSheet.rows.length;
      const projectionRows = validateCandidate(add, candidateSheet, root, transactionsById, profileId, transactionResults);
      const rootPreview = loadedByKey.get("root-preview");
      validateRootPreview(add, sheetByName(rootPreview.facts, root.previewSheetName, "root-preview"), root, candidateSheet, projectionRows, transactionsById, profileId);
      for (const transaction of profileTransactions) markTransactionCheck(transactionResults, transaction.id, "root-preview", { path: root.previewPath, range: root.previewRangeAddress });
      validatePreviewBindings(add, state, root, presentation, profileId);
      for (const transaction of profileTransactions) markTransactionCheck(transactionResults, transaction.id, "preview-binding", { previewDigest: state.previewBuild.previewDigest });
      const evidenceArchiveResult = await evidenceArchiveSettled;
      if (evidenceArchiveResult.status === "rejected") throw evidenceArchiveResult.reason;
      for (const [kind, items] of Object.entries(evidenceIssueStore.result)) issues[kind].push(...items);
      metrics.boundMediaArtifactCount += evidenceMetrics.boundMediaArtifactCount;
      metrics.uniqueArchiveMediaReadCount += evidenceMetrics.uniqueArchiveMediaReadCount;
      metrics.archiveMediaCacheHits += evidenceMetrics.archiveMediaCacheHits;
      for (const transaction of profileTransactions) markTransactionCheck(transactionResults, transaction.id, "evidence", { archiveCount: presentation.evidenceArchive.length });
    } catch (error) {
      if (isRetryableInfrastructureError(error)) throw error;
      if (error instanceof CorrespondenceValidationError) add("mismatches", "artifact-parse-or-validation-failure", { profileId, artifact: "gate1-deliverables", actual: error.message });
      else block("artifact-audit-internal-failure", { profileId, artifact: "gate1-deliverables", actual: error instanceof Error ? error.message : String(error) });
    }
    const profileIssueCounts = Object.fromEntries(Object.entries(issues).map(([key, value]) => [key, value.length - issueCountsBefore[key]]));
    const body = {
      profileId,
      transactionCount: profileTransactions.length,
      totals: {
        sourceAmount: amount(sum(profileTransactions, (item) => item.sourceMilliunits)),
        reimbursementAmount: amount(sum(profileTransactions, (item) => item.reimbursementMilliunits)),
        companyPaidNoReimbursement: amount(sum(profileTransactions.filter((item) => item.settlement === "company_paid_no_reimbursement"), (item) => item.sourceMilliunits)),
      },
      issueCounts: profileIssueCounts,
      status: Object.values(profileIssueCounts).every((count) => count === 0) ? "passed" : "failed",
    };
    profileAudits.push({ ...body, auditDigest: canonicalDigest(body) });
  }
  await requireFreshSources();

  const mediaReferences = transactions.flatMap((transaction) => transaction.evidence
    .filter((evidenceId) => files.get(evidenceId)?.kind === "image")
    .map((evidenceId, evidenceIndex) => {
      const file = files.get(evidenceId);
      return {
        transactionId: transaction.id,
        profileId: transaction.profileId,
        evidenceId,
        evidenceIndex,
        sourceSha256: file.sha256,
        sourceRefs: transaction.sourceRefs.filter((sourceRef) => sourceByRef.get(sourceRef)?.file.id === evidenceId),
      };
    })).sort((left, right) => (transactionsById.get(left.transactionId)?.sourceOrder ?? 0) - (transactionsById.get(right.transactionId)?.sourceOrder ?? 0) || left.evidenceIndex - right.evidenceIndex || stableTextCompare(left.evidenceId, right.evidenceId));
  const archiveEntries = state.presentationBuild.artifacts.flatMap((artifact) => artifact.evidenceArchive.map((entry) => ({ profileId: artifact.profileId, ...entry })));
  const mediaBySha = Map.groupBy(usedMediaFiles, (file) => file.sha256);
  for (const omission of hooks?.omitTransactionCheckStages ?? []) {
    const transaction = transactionResults.get(omission.transactionId);
    transaction?.checkedStages.delete(omission.stage);
    if (transaction?.requiredStages.includes(omission.stage)) block("required-transaction-stage-incomplete", { transactionId: omission.transactionId, profileId: transaction.profileId, artifact: omission.stage, stage: omission.stage });
  }
  sortIssues(issues);
  const allIssues = Object.values(issues).flat();
  const mediaResults = [...mediaBySha].sort(([left], [right]) => stableTextCompare(left, right)).map(([sourceSha256, mediaFiles]) => {
    const fileIds = sortedUnique(mediaFiles.map((item) => item.id));
    const sourceRefs = sortedUnique([...sourceByRef].filter(([, binding]) => binding.file.sha256 === sourceSha256).map(([sourceRef]) => sourceRef));
    const references = mediaReferences.filter((item) => item.sourceSha256 === sourceSha256);
    const source = freshSources.get(sourceSha256);
    const touched = allIssues.some((issue) => issue.sourceSha256 === sourceSha256
      || fileIds.includes(issue.fileId)
      || sourceRefs.includes(issue.sourceRef)
      || references.some((reference) => reference.evidenceId === issue.evidenceId || reference.transactionId === issue.transactionId));
    return {
      sourceSha256,
      fileIds,
      usages: sortedUnique(mediaFiles.map((item) => item.usage ?? "voucher")),
      sourceRefs,
      transactionReferenceCount: references.length,
      transactionReferences: references,
      archiveBindings: archiveEntries.filter((entry) => entry.sha256 === sourceSha256).map((entry) => ({ profileId: entry.profileId, evidenceId: entry.evidenceId, path: entry.path, sha256: entry.sha256 })),
      observationCount: sourceRefs.filter((sourceRef) => observations.has(sourceRef)).length,
      width: source?.image?.width ?? null,
      height: source?.image?.height ?? null,
      status: touched || !source || source.error ? "failed" : "reviewed",
    };
  });
  const allIssueCount = Object.values(issues).reduce((total, items) => total + items.length, 0);
  const blockingIssueCount = issues.blocking.length;
  const knownSourceRefs = new Set(transactions.flatMap((transaction) => transaction.sourceRefs));
  const knownEvidenceIds = new Set(transactions.flatMap((transaction) => transaction.evidence));
  const publicTransactionResults = [...transactionResults.values()].sort((left, right) => (transactionsById.get(left.transactionId)?.sourceOrder ?? 0) - (transactionsById.get(right.transactionId)?.sourceOrder ?? 0) || stableTextCompare(left.transactionId, right.transactionId)).map((item) => {
    const checks = Object.fromEntries(TRANSACTION_CHECK_STAGES.map((stage) => {
      const required = item.requiredStages.includes(stage);
      const checked = item.checkedStages.has(stage);
      const stageIssues = allIssues.filter((issue) => {
        if (issue.transactionId && issue.transactionId !== item.transactionId) return false;
        if (issue.profileId && issue.profileId !== item.profileId) return false;
        if (issue.sourceRef && knownSourceRefs.has(issue.sourceRef) && !item.sourceRefs.includes(issue.sourceRef)) return false;
        if (issue.evidenceId && knownEvidenceIds.has(issue.evidenceId) && !item.evidenceIds.includes(issue.evidenceId)) return false;
        if (issue.fileId && knownEvidenceIds.has(issue.fileId) && !item.evidenceIds.includes(issue.fileId)) return false;
        const artifacts = TRANSACTION_STAGE_ARTIFACTS.get(stage);
        return artifacts ? artifacts.has(issue.artifact) : issue.artifact === stage;
      });
      return [stage, {
        status: !required ? "not-applicable" : !checked ? "not-checked" : stageIssues.length > 0 ? "failed" : "passed",
        locations: item.locations.filter((location) => location.artifact === stage).map(({ artifact: _artifact, ...location }) => location),
      }];
    }));
    const fullyAudited = item.requiredStages.every((stage) => item.checkedStages.has(stage));
    const directlyTouched = allIssues.some((issue) => {
      if (issue.transactionId) return issue.transactionId === item.transactionId;
      if (issue.profileId) return issue.profileId === item.profileId;
      if (issue.sourceRef && knownSourceRefs.has(issue.sourceRef)) return item.sourceRefs.includes(issue.sourceRef);
      if (issue.evidenceId && knownEvidenceIds.has(issue.evidenceId)) return item.evidenceIds.includes(issue.evidenceId);
      if (issue.fileId && knownEvidenceIds.has(issue.fileId)) return item.evidenceIds.includes(issue.fileId);
      return true;
    });
    const { checkedStages: _checkedStages, ...visible } = item;
    return { ...visible, checks, fullyAudited, status: fullyAudited && !directlyTouched && Object.values(checks).every((check) => check.status === "passed" || check.status === "not-applicable") ? "matched" : "failed" };
  });
  const publicAnnotationResults = annotationResults.map((item) => {
    const relatedIssue = allIssues.some((issue) => issue.annotationIndex === item.annotationIndex
      || (issue.artifact === "summary" && issue.profileId === item.profileId)
      || (!Object.hasOwn(issue, "annotationIndex") && (issue.artifact === "summary-annotation" || issue.code === "manifest-summary-annotations-mismatch")));
    const { independentReviewMatched, ...visible } = item;
    return { ...visible, status: independentReviewMatched && !relatedIssue ? "matched" : "failed" };
  });
  const publicMediaReferenceResults = mediaReferences.map((item) => ({
    ...item,
    status: allIssues.some((issue) => issue.transactionId === item.transactionId
      || issue.evidenceId === item.evidenceId
      || item.sourceRefs.includes(issue.sourceRef)) ? "failed" : "matched",
  }));
  const publicSupplementResults = supplementResults.map((item) => ({
    ...item,
    status: allIssues.some((issue) => issue.artifact === "supplement"
      && issue.profileId === item.profileId
      && (!issue.person || issue.person === item.person)) ? "failed" : "matched",
  }));
  const allCorrespondenceMatched = allIssueCount === 0
    && publicTransactionResults.every((item) => item.status === "matched")
    && mediaResults.every((item) => item.status === "reviewed")
    && publicMediaReferenceResults.every((item) => item.status === "matched")
    && publicAnnotationResults.every((item) => item.status === "matched")
    && profileAudits.every((item) => item.status === "passed")
    && publicSupplementResults.every((item) => item.status === "matched");
  const disposition = allCorrespondenceMatched ? "PASSED" : blockingIssueCount > 0 ? "BLOCKED_RETRYABLE" : "SUBSTANTIVE_MISMATCH";
  const body = {
    kind: FULL_CORRESPONDENCE_AUDIT_KIND,
    gate1BindingDigest: state.gate1.bindingDigest,
    certificateDigest: certificate.certificateDigest,
    candidateBindings: state.rootBuild.artifacts.map((item) => ({ profileId: item.profileId, candidateSha256: item.candidateSha256, planSha256: item.planSha256 })),
    sourceCoverageDigest: certificate.sourceCoverageDigest,
    batchRows: state.rootBuild.artifacts.map((item) => ({ profileId: item.profileId, ranges: item.audit.projection.batchRanges.map((range) => `${range.startRow}:${range.endRow}`) })),
    previewBindingDigest: state.previewBuild.previewDigest,
    independentEvidenceReviewDigest: canonicalDigest(review),
    independentEvidenceReviewSha256: reviewSnapshot.sha256,
    reviewerRunId: review.reviewerRunId,
    coverage: {
      expectedTransactions: transactions.length,
      auditedTransactions: publicTransactionResults.filter((item) => item.fullyAudited).length,
      sourceRefCount: sourceByRef.size,
      uniqueSourceCount: new Set([...sourceByRef.values()].map((item) => item.file.sha256)).size,
      uniqueMediaCount: mediaResults.length,
      mediaReferenceCount: mediaReferences.length,
      unboundMediaCount: mediaResults.filter((item) => item.sourceRefs.length === 0).length,
      profileCount: profileAudits.length,
      supplementWorkbookCount: supplementResults.length,
      annotationCount: summaryAnnotations.length,
    },
    totals: {
      sourceAmount: amount(sum(transactions, (item) => item.sourceMilliunits)),
      reimbursementAmount: amount(sum(transactions, (item) => item.reimbursementMilliunits)),
      companyPaidNoReimbursement: amount(sum(transactions.filter((item) => item.settlement === "company_paid_no_reimbursement"), (item) => item.sourceMilliunits)),
    },
    perPerson: groupedTotals(transactions, (item) => item.person, (item) => item.reimbursementMilliunits),
    perClassification: groupedTotals(transactions, (item) => item.classification, (item) => item.sourceMilliunits),
    profileAudits,
    transactionResults: publicTransactionResults,
    mediaResults,
    mediaReferenceResults: publicMediaReferenceResults,
    supplementResults: publicSupplementResults,
    annotationResults: publicAnnotationResults,
    ...issues,
    metrics,
    disposition,
    status: disposition === "PASSED" ? "passed" : disposition === "BLOCKED_RETRYABLE" ? "blocked" : "failed",
  };
  return Object.freeze({ ...body, reportDigest: canonicalDigest(body) });
}
