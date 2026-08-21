import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const A1_RANGE_RE = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/;
const COLUMN_RE = /^[A-Z]{1,3}$/;
const EXCEL_MAX_COLUMN = 16_384;
const EXCEL_MAX_ROW = 1_048_576;
const WINDOWS_INVALID_BASENAME = /[<>:"/\\|?*\u0000-\u001f]/u;
const POSITIONAL_OR_VOLATILE_FORMULA_RE = /\b(?:ROW|ROWS|COLUMN|COLUMNS|CELL|ADDRESS|INDIRECT|OFFSET|NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY|SEQUENCE|INFO|SHEET|SHEETS|FORMULATEXT)\s*\(/i;
const DYNAMIC_REFERENCE_FORMULA_RE = /\b(?:INDIRECT|OFFSET)\s*\(/i;
const UNSUPPORTED_REFERENCE_GRAMMAR_RE = /(?:\[[^\]]+\]|'(?:[^']|'')*:(?:[^']|'')*'!|(?:'(?:[^']|'')+'|[\p{L}\p{N}\p{M}_. ]+):(?:'(?:[^']|'')+'|[\p{L}\p{N}\p{M}_. ]+)!)/iu;
const SCALE = 1000n;
const MAX_AUDIT_CELLS = 100_000;
const PLAN_KEYS_V1 = new Set([
  "version",
  "mode",
  "sourcePath",
  "outputPath",
  "expectedSourceSha256",
  "sheetName",
  "physicalRange",
  "scopeStart",
  "scopeStartInclusive",
  "scopeEnd",
  "scopeEndInclusive",
  "sortKeys",
  "stableTieBreaker",
  "blankRowsPolicy",
  "recordColumns",
  "dateColumn",
  "amountColumn",
  "records",
  "expectedRecordCount",
  "expectedScopedRecordCount",
  "expectedScopedAmount",
  "expectedAmountDelta",
]);
const PLAN_KEYS_V2 = new Set([
  ...PLAN_KEYS_V1,
  "generatorVersion",
  "recordModel",
  "datePolicy",
  "activeCandidatePath",
  "rootPath",
  "stagingRoot",
  "stagingToken",
  "targetPath",
  "candidateRevision",
  "expectedPhysicalRecordRowCount",
  "expectedScopedRowCount",
]);
const PLAN_REQUEST_KEYS = new Set([
  "version",
  "mode",
  "rootPath",
  "stagingRoot",
  "stagingToken",
  "sourcePath",
  "outputPath",
  "activeCandidatePath",
  "targetPath",
  "candidateRevision",
  "sheetName",
  "physicalRange",
  "scopeStart",
  "scopeStartInclusive",
  "scopeEnd",
  "scopeEndInclusive",
  "dateColumn",
  "amountColumn",
  "recordDetection",
]);

let artifactToolPromise;
let jszipPromise;

function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

function unsupported(message) {
  throw new Error(`unsupported: ${message}`);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function requireSafeInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${field} must be a safe integer >= ${min}.`);
  }
  return value;
}

function parseIsoDate(value, field) {
  const date = requireString(value, field);
  if (!ISO_DATE_RE.test(date)) throw new Error(`${field} must be a valid ISO date.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${field} must be a valid ISO date.`);
  }
  return date;
}

function parseFixed(value, field) {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)(\.\d{1,3})?$/.test(value)) {
    throw new Error(`${field} must be a signed decimal string with at most three decimal places.`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const parsed = BigInt(whole) * SCALE + BigInt((fraction + "000").slice(0, 3));
  if (negative && parsed === 0n) throw new Error(`${field} must not use negative zero.`);
  return negative ? -parsed : parsed;
}

function fixedFromCell(value, field) {
  if (typeof value === "string") return parseFixed(value, field);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must contain a finite number or signed decimal string.`);
  }
  const nearestMilliunit = Math.round(value * 1000) / 1000;
  if (Math.abs(value - nearestMilliunit) > 1e-9) {
    throw new Error(`${field} contains genuine precision beyond the permitted milliunit boundary.`);
  }
  const rounded = Math.round(nearestMilliunit * 1000);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${field} exceeds the safe fixed-point range.`);
  return BigInt(rounded);
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function parseCanonicalCandidateFilename(filePath, candidateRevision, field) {
  const filename = path.basename(filePath);
  const match = /^(.*)_修正版([1-9]\d*)(\.xlsx)$/i.exec(filename);
  if (!match || Number(match[2]) !== candidateRevision) {
    throw new Error(`${field} filename must use canonical <artifactKind>_修正版N.xlsx with the bound revision.`);
  }
  const artifactKind = match[1];
  if (
    !artifactKind ||
    artifactKind !== artifactKind.trim() ||
    artifactKind === "." ||
    artifactKind === ".." ||
    WINDOWS_INVALID_BASENAME.test(artifactKind) ||
    /[. ]$/u.test(artifactKind) ||
    /_修正版[0-9]+$/u.test(artifactKind)
  ) {
    throw new Error(`${field} contains an artifactKind that the revision promoter cannot accept.`);
  }
  return { filename, artifactKind, extension: match[3] };
}

function isStrictDescendant(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isDirectChild(parentPath, childPath) {
  return isStrictDescendant(parentPath, childPath) && samePath(path.dirname(childPath), parentPath);
}

function formatFixed(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = absolute % SCALE;
  const rendered = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
  return negative ? `-${rendered}` : rendered;
}

function columnToNumber(column) {
  let result = 0;
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function isValidExcelColumn(column) {
  return COLUMN_RE.test(column) && columnToNumber(column) <= EXCEL_MAX_COLUMN;
}

function assertExcelReferenceBounds(col, row, field) {
  if (
    !Number.isSafeInteger(col) || col < 1 || col > EXCEL_MAX_COLUMN ||
    !Number.isSafeInteger(row) || row < 1 || row > EXCEL_MAX_ROW
  ) {
    throw new Error(`${field} is outside Excel's XFD1048576 worksheet boundary.`);
  }
}

function assertBoundedPhysicalRange(range, field) {
  const cells = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  if (!Number.isSafeInteger(cells) || cells > MAX_AUDIT_CELLS) {
    unsupported(`${field} contains ${cells} cells and exceeds the ${MAX_AUDIT_CELLS}-cell execution boundary`);
  }
}

function numberToColumn(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function parseRange(value, field = "physicalRange") {
  const normalized = requireString(value, field).toUpperCase();
  const match = A1_RANGE_RE.exec(normalized);
  if (!match) throw new Error(`${field} must be a rectangular A1 range without a sheet prefix.`);
  const startCol = columnToNumber(match[1]);
  const startRow = Number(match[2]);
  const endCol = columnToNumber(match[3]);
  const endRow = Number(match[4]);
  assertExcelReferenceBounds(startCol, startRow, `${field} start`);
  assertExcelReferenceBounds(endCol, endRow, `${field} end`);
  if (startCol > endCol || startRow > endRow) {
    throw new Error(`${field} must be ordered from its top-left to bottom-right cell.`);
  }
  return { startCol, startRow, endCol, endRow, a1: `${match[1]}${startRow}:${match[3]}${endRow}` };
}

function parseCellRef(value) {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(value.toUpperCase());
  if (!match) throw new Error(`Invalid A1 cell reference: ${value}`);
  const col = columnToNumber(match[1]);
  const row = Number(match[2]);
  assertExcelReferenceBounds(col, row, `A1 cell reference ${value}`);
  return { col, row };
}

function rangeIntersects(left, right) {
  return !(
    left.endRow < right.startRow ||
    left.startRow > right.endRow ||
    left.endCol < right.startCol ||
    left.startCol > right.endCol
  );
}

function normalizeSortKey(value, index) {
  if (typeof value === "string") {
    const match = /^(date|dateSortKey|baselineOrder):(asc)$/i.exec(value.trim());
    if (!match) throw new Error(`sortKeys[${index}] is unsupported.`);
    return { field: match[1] === "date" ? "dateSortKey" : match[1], direction: "asc" };
  }
  const item = requireObject(value, `sortKeys[${index}]`);
  const allowed = new Set(["field", "direction"]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) throw new Error(`sortKeys[${index}] contains unknown field ${key}.`);
  }
  const field = requireString(item.field, `sortKeys[${index}].field`);
  const direction = requireString(item.direction, `sortKeys[${index}].direction`).toLowerCase();
  if (!["date", "dateSortKey", "baselineOrder"].includes(field) || direction !== "asc") {
    throw new Error(`sortKeys[${index}] is unsupported.`);
  }
  return { field: field === "date" ? "dateSortKey" : field, direction };
}

function packDestinationBlocks(scopedRecords, sortedScopedRecords) {
  const sourceOrdered = [...scopedRecords].sort((left, right) => left.startRow - right.startRow);
  const bands = [];
  for (const record of sourceOrdered) {
    const last = bands.at(-1);
    if (!last || record.startRow !== last.endRow + 1) {
      bands.push({ startRow: record.startRow, endRow: record.endRow });
    } else {
      last.endRow = record.endRow;
    }
  }
  const destinationStartRowById = new Map();
  let recordIndex = 0;
  for (const band of bands) {
    let cursor = band.startRow;
    while (cursor <= band.endRow) {
      const record = sortedScopedRecords[recordIndex];
      if (!record || cursor + record.rowCount - 1 > band.endRow) {
        unsupported(`sorted record blocks cannot fit wholly inside preserved band ${band.startRow}:${band.endRow}`);
      }
      destinationStartRowById.set(record.id, cursor);
      cursor += record.rowCount;
      recordIndex += 1;
    }
  }
  if (recordIndex !== sortedScopedRecords.length) {
    unsupported("sorted record blocks exceed the preserved movable bands");
  }
  return { bands, destinationStartRowById };
}

export function validatePlan(raw) {
  const payload = requireObject(raw, "plan");
  if (![1, 2].includes(payload.version)) throw new Error("plan.version must be 1 or 2.");
  const allowedKeys = payload.version === 1 ? PLAN_KEYS_V1 : PLAN_KEYS_V2;
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) throw new Error(`plan contains unknown field ${key}.`);
  }
  for (const key of allowedKeys) {
    if (!(key in payload)) throw new Error(`plan.${key} is required.`);
  }
  if (payload.version === 2) {
    if (payload.generatorVersion !== 1) throw new Error("plan.generatorVersion must be 1.");
    if (payload.recordModel !== "contiguous-row-block") {
      throw new Error("plan.recordModel must be contiguous-row-block.");
    }
    if (payload.datePolicy !== "single-logical-date") {
      throw new Error("plan.datePolicy must be single-logical-date.");
    }
  }
  if (payload.mode !== "ledger-reorder-correction") {
    throw new Error("plan.mode must be ledger-reorder-correction.");
  }
  const sourcePath = requireString(payload.sourcePath, "sourcePath");
  const outputPath = requireString(payload.outputPath, "outputPath");
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath)) {
    throw new Error("sourcePath and outputPath must be absolute paths.");
  }
  if (samePath(sourcePath, outputPath)) throw new Error("sourcePath and outputPath must be different.");
  if (path.extname(sourcePath).toLowerCase() !== ".xlsx" || path.extname(outputPath).toLowerCase() !== ".xlsx") {
    throw new Error("sourcePath and outputPath must both use the .xlsx extension.");
  }
  let rootPath;
  let stagingRoot;
  let stagingToken;
  let targetPath;
  let activeCandidatePath;
  let candidateRevision;
  if (payload.version === 2) {
    rootPath = path.resolve(requireString(payload.rootPath, "rootPath"));
    stagingRoot = path.resolve(requireString(payload.stagingRoot, "stagingRoot"));
    stagingToken = requireString(payload.stagingToken, "stagingToken");
    targetPath = path.resolve(requireString(payload.targetPath, "targetPath"));
    activeCandidatePath = path.resolve(requireString(payload.activeCandidatePath, "activeCandidatePath"));
    candidateRevision = requireSafeInteger(payload.candidateRevision, "candidateRevision", { min: 1 });
    if (
      !path.isAbsolute(payload.rootPath) ||
      !path.isAbsolute(payload.stagingRoot) ||
      !path.isAbsolute(payload.targetPath) ||
      !path.isAbsolute(payload.activeCandidatePath)
    ) {
      throw new Error("rootPath, stagingRoot, targetPath, and activeCandidatePath must be absolute paths.");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(stagingToken) || path.basename(stagingRoot) !== `codex-xhs-reimburse-${stagingToken}`) {
      throw new Error("stagingRoot and stagingToken do not match the owned task-directory convention.");
    }
    if (!samePath(path.dirname(stagingRoot), os.tmpdir())) {
      throw new Error("stagingRoot must be a direct child of the system temporary directory.");
    }
    if (!isStrictDescendant(rootPath, sourcePath)) throw new Error("sourcePath must be inside rootPath.");
    if (!isDirectChild(stagingRoot, outputPath)) throw new Error("outputPath must be a direct child of stagingRoot.");
    if (!isStrictDescendant(rootPath, activeCandidatePath)) {
      throw new Error("activeCandidatePath must be inside rootPath.");
    }
    if (!samePath(targetPath, path.join(rootPath, "小红书支出总表.xlsx"))) {
      throw new Error("targetPath must be the exact standard root ledger path.");
    }
    const outputName = parseCanonicalCandidateFilename(outputPath, candidateRevision, "outputPath");
    const activeName = parseCanonicalCandidateFilename(activeCandidatePath, candidateRevision, "activeCandidatePath");
    if (
      path.extname(activeCandidatePath).toLowerCase() !== ".xlsx" ||
      samePath(activeCandidatePath, sourcePath) ||
      samePath(activeCandidatePath, targetPath) ||
      samePath(activeCandidatePath, outputPath) ||
      activeName.filename !== outputName.filename ||
      activeName.artifactKind !== outputName.artifactKind
    ) {
      throw new Error("activeCandidatePath must be a distinct .xlsx path.");
    }
  }
  const expectedSourceSha256 = requireString(payload.expectedSourceSha256, "expectedSourceSha256");
  if (!SHA256_RE.test(expectedSourceSha256)) {
    throw new Error("expectedSourceSha256 must be 64 lowercase hexadecimal characters.");
  }
  const sheetName = requireString(payload.sheetName, "sheetName");
  const physical = parseRange(payload.physicalRange);
  assertBoundedPhysicalRange(physical, "physicalRange");
  const scopeStart = parseIsoDate(payload.scopeStart, "scopeStart");
  const scopeEnd = parseIsoDate(payload.scopeEnd, "scopeEnd");
  if (scopeStart > scopeEnd) throw new Error("scopeStart must not be after scopeEnd.");
  if (typeof payload.scopeStartInclusive !== "boolean" || typeof payload.scopeEndInclusive !== "boolean") {
    throw new Error("scopeStartInclusive and scopeEndInclusive must be booleans.");
  }
  if (!Array.isArray(payload.sortKeys) || payload.sortKeys.length !== 2) {
    throw new Error("sortKeys must contain exactly date:asc and baselineOrder:asc.");
  }
  const sortKeys = payload.sortKeys.map(normalizeSortKey);
  if (sortKeys[0].field !== "dateSortKey" || sortKeys[1].field !== "baselineOrder") {
    throw new Error("sortKeys must be ordered as date:asc then baselineOrder:asc.");
  }
  if (payload.stableTieBreaker !== "baselineOrder") throw new Error("stableTieBreaker must be baselineOrder.");
  if (payload.blankRowsPolicy !== "preserve-physical") {
    throw new Error("blankRowsPolicy must be preserve-physical.");
  }
  if (!Array.isArray(payload.recordColumns) || payload.recordColumns.length === 0) {
    throw new Error("recordColumns must be a non-empty array.");
  }
  const recordColumns = payload.recordColumns.map((column, index) => {
    const normalized = requireString(column, `recordColumns[${index}]`).toUpperCase();
    if (!isValidExcelColumn(normalized)) throw new Error(`recordColumns[${index}] is invalid.`);
    return normalized;
  });
  if (new Set(recordColumns).size !== recordColumns.length) throw new Error("recordColumns must be unique.");
  const expectedColumns = [];
  for (let col = physical.startCol; col <= physical.endCol; col += 1) expectedColumns.push(numberToColumn(col));
  if (JSON.stringify(recordColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error("recordColumns must list every physicalRange column once, from left to right.");
  }
  const dateColumn = requireString(payload.dateColumn, "dateColumn").toUpperCase();
  const amountColumn = requireString(payload.amountColumn, "amountColumn").toUpperCase();
  if (!recordColumns.includes(dateColumn) || !recordColumns.includes(amountColumn)) {
    throw new Error("dateColumn and amountColumn must be included in recordColumns.");
  }
  if (dateColumn === amountColumn) throw new Error("dateColumn and amountColumn must be different.");
  if (!Array.isArray(payload.records) || payload.records.length === 0) {
    throw new Error("records must be a non-empty array.");
  }
  const ids = new Set();
  const occupiedRows = new Set();
  const baselineOrders = new Set();
  const records = payload.records.map((rawRecord, index) => {
    const record = requireObject(rawRecord, `records[${index}]`);
    const keys = payload.version === 1
      ? new Set(["id", "row", "dateSortKey", "baselineOrder"])
      : new Set(["id", "startRow", "endRow", "dateSortKey", "baselineOrder"]);
    for (const key of Object.keys(record)) {
      if (!keys.has(key)) throw new Error(`records[${index}] contains unknown field ${key}.`);
    }
    for (const key of keys) {
      if (!(key in record)) throw new Error(`records[${index}].${key} is required.`);
    }
    const id = requireString(record.id, `records[${index}].id`);
    const startRow = payload.version === 1
      ? requireSafeInteger(record.row, `records[${index}].row`, { min: 1 })
      : requireSafeInteger(record.startRow, `records[${index}].startRow`, { min: 1 });
    const endRow = payload.version === 1
      ? startRow
      : requireSafeInteger(record.endRow, `records[${index}].endRow`, { min: startRow });
    const dateSortKey = parseIsoDate(record.dateSortKey, `records[${index}].dateSortKey`);
    const baselineOrder = requireSafeInteger(record.baselineOrder, `records[${index}].baselineOrder`);
    if (startRow < physical.startRow || endRow > physical.endRow) {
      throw new Error(`records[${index}] is outside physicalRange.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate record id: ${id}`);
    if (baselineOrders.has(baselineOrder)) throw new Error(`Duplicate baselineOrder: ${baselineOrder}`);
    for (let row = startRow; row <= endRow; row += 1) {
      if (occupiedRows.has(row)) throw new Error(`Record blocks overlap at source row ${row}.`);
      occupiedRows.add(row);
    }
    ids.add(id);
    baselineOrders.add(baselineOrder);
    return {
      id,
      startRow,
      endRow,
      rowCount: endRow - startRow + 1,
      dateSortKey,
      baselineOrder,
      ...(payload.version === 1 ? { row: startRow } : {}),
    };
  });
  const byRow = [...records].sort((left, right) => left.startRow - right.startRow);
  for (let index = 1; index < byRow.length; index += 1) {
    if (byRow[index - 1].baselineOrder >= byRow[index].baselineOrder) {
      throw new Error("baselineOrder must strictly increase with the source physical row order.");
    }
  }
  const expectedRecordCount = requireSafeInteger(payload.expectedRecordCount, "expectedRecordCount", { min: 1 });
  const expectedScopedRecordCount = requireSafeInteger(payload.expectedScopedRecordCount, "expectedScopedRecordCount", { min: 1 });
  if (expectedRecordCount !== records.length) throw new Error("expectedRecordCount does not equal records.length.");
  const inScope = (record) => {
    const afterStart = payload.scopeStartInclusive ? record.dateSortKey >= scopeStart : record.dateSortKey > scopeStart;
    const beforeEnd = payload.scopeEndInclusive ? record.dateSortKey <= scopeEnd : record.dateSortKey < scopeEnd;
    return afterStart && beforeEnd;
  };
  const scopedRecords = records.filter(inScope);
  if (expectedScopedRecordCount !== scopedRecords.length) {
    throw new Error("expectedScopedRecordCount does not match the explicit date boundaries.");
  }
  const expectedPhysicalRecordRowCount = records.reduce((sum, record) => sum + record.rowCount, 0);
  const expectedScopedRowCount = scopedRecords.reduce((sum, record) => sum + record.rowCount, 0);
  if (payload.version === 2) {
    if (requireSafeInteger(payload.expectedPhysicalRecordRowCount, "expectedPhysicalRecordRowCount", { min: 1 }) !== expectedPhysicalRecordRowCount) {
      throw new Error("expectedPhysicalRecordRowCount does not match the record blocks.");
    }
    if (requireSafeInteger(payload.expectedScopedRowCount, "expectedScopedRowCount", { min: 1 }) !== expectedScopedRowCount) {
      throw new Error("expectedScopedRowCount does not match the scoped record blocks.");
    }
  }
  const expectedScopedAmountFixed = parseFixed(payload.expectedScopedAmount, "expectedScopedAmount");
  if (payload.expectedAmountDelta !== "0") throw new Error("expectedAmountDelta must be exactly '0'.");
  const sortedScopedRecords = [...scopedRecords].sort(
    (left, right) => left.dateSortKey.localeCompare(right.dateSortKey) || left.baselineOrder - right.baselineOrder,
  );
  const { bands: movableBands, destinationStartRowById } = packDestinationBlocks(scopedRecords, sortedScopedRecords);
  const scopedRows = scopedRecords.flatMap((record) => {
    const rows = [];
    for (let row = record.startRow; row <= record.endRow; row += 1) rows.push(row);
    return rows;
  }).sort((left, right) => left - right);
  const destinationRows = sortedScopedRecords.flatMap((record) => {
    const start = destinationStartRowById.get(record.id);
    return Array.from({ length: record.rowCount }, (_, offset) => start + offset);
  }).sort((left, right) => left - right);
  if (stableJson(scopedRows) !== stableJson(destinationRows)) {
    throw new Error("Destination record blocks do not preserve the exact scoped physical row set.");
  }
  const recordBySourceRow = new Map();
  for (const record of records) {
    for (let row = record.startRow; row <= record.endRow; row += 1) {
      recordBySourceRow.set(row, { record, offset: row - record.startRow });
    }
  }
  return {
    ...payload,
    sourcePath: path.resolve(sourcePath),
    outputPath: path.resolve(outputPath),
    ...(payload.version === 2
      ? { rootPath, stagingRoot, stagingToken, targetPath, activeCandidatePath, candidateRevision }
      : {}),
    expectedSourceSha256,
    sheetName,
    physical,
    scopeStart,
    scopeEnd,
    sortKeys,
    recordColumns,
    dateColumn,
    amountColumn,
    records,
    scopedRecords,
    sortedScopedRecords,
    scopedRows,
    scopedSlots: scopedRows,
    movableBands,
    destinationStartRowById,
    destinationRowById: destinationStartRowById,
    expectedPhysicalRecordRowCount,
    expectedScopedRowCount,
    expectedScopedAmountFixed,
    recordBySourceRow,
    recordByRow: new Map(records.map((record) => [record.startRow, record])),
  };
}

export function validatePlanRequest(raw) {
  const payload = requireObject(raw, "request");
  for (const key of Object.keys(payload)) {
    if (!PLAN_REQUEST_KEYS.has(key)) throw new Error(`request contains unknown field ${key}.`);
  }
  for (const key of PLAN_REQUEST_KEYS) {
    if (!(key in payload)) throw new Error(`request.${key} is required.`);
  }
  if (payload.version !== 1) throw new Error("request.version must be 1.");
  if (payload.mode !== "ledger-reorder-plan-request") {
    throw new Error("request.mode must be ledger-reorder-plan-request.");
  }
  if (payload.recordDetection !== "merge-connected-components") {
    throw new Error("request.recordDetection must be merge-connected-components.");
  }
  const rootPath = path.resolve(requireString(payload.rootPath, "request.rootPath"));
  const stagingRoot = path.resolve(requireString(payload.stagingRoot, "request.stagingRoot"));
  const stagingToken = requireString(payload.stagingToken, "request.stagingToken");
  const sourcePath = path.resolve(requireString(payload.sourcePath, "request.sourcePath"));
  const outputPath = path.resolve(requireString(payload.outputPath, "request.outputPath"));
  const activeCandidatePath = path.resolve(requireString(payload.activeCandidatePath, "request.activeCandidatePath"));
  const targetPath = path.resolve(requireString(payload.targetPath, "request.targetPath"));
  for (const [field, rawPath] of [
    ["rootPath", payload.rootPath],
    ["stagingRoot", payload.stagingRoot],
    ["sourcePath", payload.sourcePath],
    ["outputPath", payload.outputPath],
    ["activeCandidatePath", payload.activeCandidatePath],
    ["targetPath", payload.targetPath],
  ]) {
    if (!path.isAbsolute(rawPath)) throw new Error(`request.${field} must be an absolute path.`);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(stagingToken) || path.basename(stagingRoot) !== `codex-xhs-reimburse-${stagingToken}`) {
    throw new Error("request stagingRoot and stagingToken do not match the owned task-directory convention.");
  }
  if (!samePath(path.dirname(stagingRoot), os.tmpdir())) {
    throw new Error("request.stagingRoot must be a direct child of the system temporary directory.");
  }
  if (!isStrictDescendant(rootPath, sourcePath)) throw new Error("request.sourcePath must be inside rootPath.");
  if (!isDirectChild(stagingRoot, outputPath)) throw new Error("request.outputPath must be a direct child of stagingRoot.");
  if (!isStrictDescendant(rootPath, activeCandidatePath)) {
    throw new Error("request.activeCandidatePath must be inside rootPath.");
  }
  if (!samePath(targetPath, path.join(rootPath, "小红书支出总表.xlsx"))) {
    throw new Error("request.targetPath must be the exact standard root ledger path.");
  }
  if (samePath(sourcePath, outputPath)) throw new Error("request sourcePath and outputPath must differ.");
  if (path.extname(sourcePath).toLowerCase() !== ".xlsx" || path.extname(outputPath).toLowerCase() !== ".xlsx") {
    throw new Error("request sourcePath and outputPath must use the .xlsx extension.");
  }
  const candidateRevision = requireSafeInteger(payload.candidateRevision, "request.candidateRevision", { min: 1 });
  const outputName = parseCanonicalCandidateFilename(outputPath, candidateRevision, "request.outputPath");
  const activeName = parseCanonicalCandidateFilename(activeCandidatePath, candidateRevision, "request.activeCandidatePath");
  if (
    path.extname(activeCandidatePath).toLowerCase() !== ".xlsx" ||
    samePath(activeCandidatePath, sourcePath) ||
    samePath(activeCandidatePath, outputPath) ||
    samePath(activeCandidatePath, targetPath) ||
    activeName.filename !== outputName.filename ||
    activeName.artifactKind !== outputName.artifactKind
  ) {
    throw new Error("request.activeCandidatePath must be a distinct bound _修正版N.xlsx path.");
  }
  const physical = parseRange(payload.physicalRange, "request.physicalRange");
  assertBoundedPhysicalRange(physical, "request.physicalRange");
  const dateColumn = requireString(payload.dateColumn, "request.dateColumn").toUpperCase();
  const amountColumn = requireString(payload.amountColumn, "request.amountColumn").toUpperCase();
  if (!isValidExcelColumn(dateColumn) || !isValidExcelColumn(amountColumn) || dateColumn === amountColumn) {
    throw new Error("request dateColumn and amountColumn must be distinct valid columns.");
  }
  const dateNumber = columnToNumber(dateColumn);
  const amountNumber = columnToNumber(amountColumn);
  if (
    dateNumber < physical.startCol || dateNumber > physical.endCol ||
    amountNumber < physical.startCol || amountNumber > physical.endCol
  ) {
    throw new Error("request dateColumn and amountColumn must be inside physicalRange.");
  }
  const scopeStart = parseIsoDate(payload.scopeStart, "request.scopeStart");
  const scopeEnd = parseIsoDate(payload.scopeEnd, "request.scopeEnd");
  if (scopeStart > scopeEnd) throw new Error("request.scopeStart must not be after scopeEnd.");
  if (typeof payload.scopeStartInclusive !== "boolean" || typeof payload.scopeEndInclusive !== "boolean") {
    throw new Error("request scope inclusivity fields must be booleans.");
  }
  return {
    ...payload,
    rootPath,
    stagingRoot,
    stagingToken,
    sourcePath,
    outputPath,
    activeCandidatePath,
    targetPath,
    candidateRevision,
    sheetName: requireString(payload.sheetName, "request.sheetName"),
    physical,
    scopeStart,
    scopeEnd,
    dateColumn,
    amountColumn,
  };
}

export async function loadPlan(planPath) {
  const absolutePath = path.resolve(requireString(planPath, "plan path"));
  let text;
  let bytes;
  try {
    bytes = await fs.readFile(absolutePath);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`Unable to read plan: ${cleanError(error)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Plan is not valid JSON: ${cleanError(error)}`);
  }
  return {
    ...validatePlan(payload),
    planPath: absolutePath,
    planFileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function loadPlanRequest(requestPath) {
  const absolutePath = path.resolve(requireString(requestPath, "request path"));
  let bytes;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch (error) {
    throw new Error(`Unable to read plan request: ${cleanError(error)}`);
  }
  let payload;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Plan request is not valid UTF-8 JSON: ${cleanError(error)}`);
  }
  return {
    ...validatePlanRequest(payload),
    requestPath: absolutePath,
    requestFileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function loadPackage(name) {
  const runtimeRoot = path.resolve(path.dirname(process.execPath), "..");
  const require = createRequire(path.join(runtimeRoot, "__codex_bundled_runtime__.cjs"));
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch {
    throw new Error(`${name} is unavailable; run with the bundled Node runtime and workspace dependencies.`);
  }
  return import(pathToFileURL(resolved).href);
}

async function artifactTool() {
  artifactToolPromise ??= loadPackage("@oai/artifact-tool");
  return artifactToolPromise;
}

async function JSZipModule() {
  jszipPromise ??= loadPackage("jszip").then((module) => module.default ?? module);
  return jszipPromise;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function assertOwnedStaging(plan) {
  if (plan.version !== 2) return;
  const stat = await fs.lstat(plan.stagingRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("stagingRoot must be a real owned directory, not a link.");
  }
  const markerPath = path.join(plan.stagingRoot, ".codex-xhs-owner.json");
  let marker;
  try {
    const bytes = await fs.readFile(markerPath);
    marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Unable to validate staging ownership marker: ${cleanError(error)}`);
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.kind !== "xiaohongshu-reimbursement-temp" ||
    marker.version !== 1 ||
    marker.token !== plan.stagingToken
  ) {
    throw new Error("staging ownership marker does not match the bound plan.");
  }
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function normalizeZipTarget(base, target) {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return normalized.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), normalized));
}

function relationshipsPathForPart(partPath) {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

function parseRelationshipMap(xml, basePart) {
  const relationships = new Map();
  if (!xml) return relationships;
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs.Id || !attrs.Target) throw new Error(`Relationship metadata is incomplete for ${basePart}.`);
    relationships.set(attrs.Id, {
      type: attrs.Type ?? "",
      target: (attrs.TargetMode ?? "").toLowerCase() === "external"
        ? attrs.Target
        : normalizeZipTarget(basePart, attrs.Target),
      targetMode: attrs.TargetMode ?? "",
    });
  }
  return relationships;
}

function relationshipValueSet(relationships) {
  return [...relationships.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function readXlsxMetadata(filePath) {
  const JSZip = await JSZipModule();
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("Workbook OOXML metadata is incomplete.");
  const relationships = parseRelationshipMap(relsXml, "xl/workbook.xml");
  const sheets = [];
  const nonCellFormulas = [];
  const worksheetPaths = new Set();
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?\s*>/g)) {
    const attrs = parseAttributes(match[0]);
    const relationId = attrs["r:id"];
    const sheetPath = relationships.get(relationId)?.target;
    if (!attrs.name || !sheetPath) throw new Error("Workbook sheet relationship is incomplete.");
    const xml = await zip.file(sheetPath)?.async("string");
    if (!xml) throw new Error(`Worksheet XML is missing for ${attrs.name}.`);
    const sheetRelationshipsPath = relationshipsPathForPart(sheetPath);
    const sheetRelationshipsXml = await zip.file(sheetRelationshipsPath)?.async("string");
    const sheetRelationships = parseRelationshipMap(sheetRelationshipsXml, sheetPath);
    const sheetDataMatch = /<(?:[\w.-]+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?sheetData\s*>/i.exec(xml);
    if (sheetDataMatch) {
      for (const rowMatch of sheetDataMatch[1].matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>/gi)) {
        if (!parseAttributes(`<row ${rowMatch[1]}>`).r) {
          unsupported(`worksheet ${attrs.name} contains a row without an explicit r coordinate`);
        }
      }
      for (const cellMatch of sheetDataMatch[1].matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>/gi)) {
        if (!parseAttributes(`<c ${cellMatch[1]}>`).r) {
          unsupported(`worksheet ${attrs.name} contains a cell without an explicit r coordinate`);
        }
      }
    }
    const merges = [];
    for (const mergeMatch of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\/?\s*>/g)) {
      const ref = parseAttributes(mergeMatch[0]).ref?.replace(/\$/g, "").toUpperCase();
      if (!ref) throw new Error(`Worksheet ${attrs.name} contains an invalid merge reference.`);
      merges.push({ ref, range: parseRange(ref, `merge ${ref}`) });
    }
    const cells = new Map();
    const cellAttributes = new Map();
    const cellPattern = /<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?c>|<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*)\/>/g;
    for (const cellMatch of xml.matchAll(cellPattern)) {
      const attrsForCell = parseAttributes(`<c ${cellMatch[1] ?? cellMatch[3] ?? ""}>`);
      if (attrsForCell.r) {
        const normalizedRef = attrsForCell.r.replace(/\$/g, "").toUpperCase();
        cells.set(normalizedRef, cellMatch[2] ?? "");
        cellAttributes.set(normalizedRef, attrsForCell);
      }
    }
    sheets.push({
      name: attrs.name,
      state: attrs.state ?? "visible",
      id: attrs.sheetId ?? "",
      path: sheetPath,
      xml,
      merges,
      cells,
      cellAttributes,
      relationships: sheetRelationships,
      relationshipValues: relationshipValueSet(sheetRelationships),
    });
    const structuralXml = xml.replace(
      /<(?:[\w.-]+:)?sheetData\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?sheetData\s*>/gi,
      "",
    );
    nonCellFormulas.push(...structuralFormulaEntries(
      structuralXml,
      attrs.name,
      `${attrs.name} worksheet structural metadata`,
      new Set(["f", "formula", "formula1", "formula2"]),
    ));
    worksheetPaths.add(sheetPath);
  }
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904=(?:"(?:1|true)"|'(?:1|true)')/i.test(workbookXml);
  const referenceModeR1C1 = /<(?:\w+:)?calcPr\b[^>]*\brefMode\s*=\s*(?:"R1C1"|'R1C1')/i.test(workbookXml);
  const hasCalcChain = Boolean(zip.file("xl/calcChain.xml"));
  const protectedParts = {};
  const protectedRelationships = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (
      name === "xl/workbook.xml" ||
      worksheetPaths.has(name) ||
      name === "xl/styles.xml" ||
      name === "xl/sharedStrings.xml" ||
      name.startsWith("docProps/")
    ) continue;
    const bytesForPart = await entry.async("nodebuffer");
    if (/\.xml$/i.test(name)) {
      nonCellFormulas.push(...structuralFormulaEntries(
        bytesForPart.toString("utf8"),
        null,
        name,
        new Set(["f", "formula", "formula1", "formula2", "calculatedcolumnformula", "totalsrowformula"]),
      ));
    }
    if (name.endsWith(".rels")) {
      if (
        name === "xl/_rels/workbook.xml.rels" ||
        sheets.some((sheet) => relationshipsPathForPart(sheet.path) === name)
      ) continue;
      const xml = bytesForPart.toString("utf8");
      protectedRelationships[name] = [...xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/g)]
        .map((match) => {
          const attrs = parseAttributes(match[0]);
          return {
            ...(name === "_rels/.rels" ? {} : { id: attrs.Id ?? "" }),
            type: attrs.Type ?? "",
            target: attrs.Target ?? "",
            targetMode: attrs.TargetMode ?? "",
          };
        })
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      continue;
    }
    protectedParts[name] = crypto.createHash("sha256").update(bytesForPart).digest("hex");
  }
  return {
    sheets,
    date1904,
    referenceModeR1C1,
    hasCalcChain,
    nonCellFormulas,
    workbookXml,
    workbookRelationships: relationships,
    workbookRelationshipValues: relationshipValueSet(relationships),
    protectedParts,
    protectedRelationships,
  };
}

function mergedChildrenWithPayload(sheetMeta) {
  const failures = [];
  for (const merge of sheetMeta.merges) {
    const { startCol, endCol, startRow, endRow } = merge.range;
    for (let row = startRow; row <= endRow; row += 1) {
      for (let col = startCol; col <= endCol; col += 1) {
        if (row === startRow && col === startCol) continue;
        const ref = `${numberToColumn(col)}${row}`;
        const inner = sheetMeta.cells.get(ref);
        if (inner !== undefined && /<(?:\w+:)?(?:v|f|is)\b/i.test(inner)) failures.push(`${sheetMeta.name}!${ref}`);
      }
    }
  }
  return failures;
}

function formulaEntries(sheetMeta) {
  const entries = [];
  for (const [ref, inner] of sheetMeta.cells) {
    const full = /<(?:\w+:)?f\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?f>/i.exec(inner);
    const empty = /<(?:\w+:)?f\b([^>]*)\/>/i.exec(inner);
    if (!full && !empty) continue;
    const attrs = parseAttributes(`<f ${full?.[1] ?? empty?.[1] ?? ""}>`);
    const formula = full ? decodeXml(full[2]).trim() : "";
    entries.push({ ref, attrs, formula });
  }
  return entries;
}

function structuralFormulaEntries(xml, currentSheetName, origin, acceptedTags) {
  const entries = [];
  const pattern = /<(?:[\w.-]+:)?(calculatedColumnFormula|totalsRowFormula|formula1|formula2|formula|f)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const tagName = match[1].toLowerCase();
    if (!acceptedTags.has(tagName)) continue;
    entries.push({
      formula: decodeXml(match[2]).trim(),
      currentSheetName,
      origin: `${origin} <${tagName}>`,
    });
  }
  return entries;
}

function parseA1References(formula, currentSheetName) {
  const references = [];
  const assertFormulaRange = (startCol, startRow, endCol, endRow) => {
    try {
      assertExcelReferenceBounds(startCol, startRow, "formula reference start");
      assertExcelReferenceBounds(endCol, endRow, "formula reference end");
    } catch (error) {
      unsupported(error instanceof Error ? error.message : String(error));
    }
  };
  const pattern = /(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}\p{M}_. ]*))!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?/giu;
  for (const match of formula.matchAll(pattern)) {
    const quotedSheet = match[1]?.replace(/''/g, "'");
    const sheetName = quotedSheet ?? match[2] ?? currentSheetName;
    const startCol = columnToNumber(match[4].toUpperCase());
    const startRow = Number(match[6]);
    const endCol = match[8] ? columnToNumber(match[8].toUpperCase()) : startCol;
    const endRow = match[10] ? Number(match[10]) : startRow;
    assertFormulaRange(startCol, startRow, endCol, endRow);
    references.push({
      sheetName,
      startCol: Math.min(startCol, endCol),
      endCol: Math.max(startCol, endCol),
      startRow: Math.min(startRow, endRow),
      endRow: Math.max(startRow, endRow),
      startRowAbsolute: match[5] === "$",
      endRowAbsolute: match[10] ? match[9] === "$" : match[5] === "$",
    });
  }
  const wholeColumnPattern = /(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}\p{M}_. ]*))!)?(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})/giu;
  for (const match of formula.matchAll(wholeColumnPattern)) {
    const quotedSheet = match[1]?.replace(/''/g, "'");
    const sheetName = quotedSheet ?? match[2] ?? currentSheetName;
    const startCol = columnToNumber(match[4].toUpperCase());
    const endCol = columnToNumber(match[6].toUpperCase());
    assertFormulaRange(startCol, 1, endCol, EXCEL_MAX_ROW);
    references.push({
      sheetName,
      startCol: Math.min(startCol, endCol),
      endCol: Math.max(startCol, endCol),
      startRow: 1,
      endRow: EXCEL_MAX_ROW,
      startRowAbsolute: true,
      endRowAbsolute: true,
    });
  }
  const wholeRowPattern = /(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}\p{M}_. ]*))!)?(\$?)(\d+):(\$?)(\d+)/gu;
  for (const match of formula.matchAll(wholeRowPattern)) {
    const quotedSheet = match[1]?.replace(/''/g, "'");
    const sheetName = quotedSheet ?? match[2] ?? currentSheetName;
    const startRow = Number(match[4]);
    const endRow = Number(match[6]);
    assertFormulaRange(1, startRow, EXCEL_MAX_COLUMN, endRow);
    references.push({
      sheetName,
      startCol: 1,
      endCol: EXCEL_MAX_COLUMN,
      startRow: Math.min(startRow, endRow),
      endRow: Math.max(startRow, endRow),
      startRowAbsolute: match[3] === "$",
      endRowAbsolute: match[5] === "$",
    });
  }
  return references;
}

function hasUnparsedSheetQualifiedReference(formula) {
  const qualifiedReference = /(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}\p{M}_. ]*)!\s*(?:\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)/giu;
  return formula.replace(qualifiedReference, "").includes("!");
}

function sameSheetName(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function referenceTouchesMovable(reference, plan) {
  if (!sameSheetName(reference.sheetName, plan.sheetName)) return false;
  if (reference.endCol < plan.physical.startCol || reference.startCol > plan.physical.endCol) return false;
  return plan.scopedRows.some((row) => row >= reference.startRow && row <= reference.endRow);
}

function referenceInsideRecord(reference, plan, record) {
  return (
    sameSheetName(reference.sheetName, plan.sheetName) &&
    reference.startCol >= plan.physical.startCol &&
    reference.endCol <= plan.physical.endCol &&
    reference.startRow >= record.startRow &&
    reference.endRow <= record.endRow
  );
}

function workbookDefinedNames(metadata, plan) {
  const nodes = [];
  for (const match of metadata.workbookXml.matchAll(/<(?:\w+:)?definedName\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?definedName>/gi)) {
    const attributes = parseAttributes(`<definedName ${match[1]}>`);
    if (!attributes.name) continue;
    if (["_xlnm.print_area", "_xlnm.print_titles"].includes(attributes.name.toLowerCase())) continue;
    const localSheetIndex = attributes.localSheetId === undefined ? null : Number(attributes.localSheetId);
    const currentSheetName = Number.isSafeInteger(localSheetIndex)
      ? metadata.sheets[localSheetIndex]?.name ?? plan.sheetName
      : plan.sheetName;
    const definition = decodeXml(match[2]).trim();
    const references = parseA1References(definition, currentSheetName);
    nodes.push({
      name: attributes.name,
      key: attributes.name.toLowerCase(),
      definition,
      directDanger:
        POSITIONAL_OR_VOLATILE_FORMULA_RE.test(definition) ||
        UNSUPPORTED_REFERENCE_GRAMMAR_RE.test(definition) ||
        hasUnparsedSheetQualifiedReference(definition) ||
        (references.length > 0 && !definition.includes("!")) ||
        references.some((reference) => referenceTouchesMovable(reference, plan)),
    });
  }
  const keys = [...new Set(nodes.map((node) => node.key))];
  const displayName = new Map(nodes.map((node) => [node.key, node.name]));
  const dependencies = new Map(keys.map((key) => [key, new Set()]));
  for (const node of nodes) {
    for (const dependencyKey of keys) {
      if (formulaUsesDefinedName(node.definition, displayName.get(dependencyKey))) {
        dependencies.get(node.key).add(dependencyKey);
      }
    }
  }
  const dangerous = new Set(nodes.filter((node) => node.directDanger).map((node) => node.key));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (key) => {
    if (visiting.has(key)) {
      const index = stack.indexOf(key);
      for (const cyclic of stack.slice(index)) dangerous.add(cyclic);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    stack.push(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of keys) {
      if (dangerous.has(key)) continue;
      if ([...(dependencies.get(key) ?? [])].some((dependency) => dangerous.has(dependency))) {
        dangerous.add(key);
        changed = true;
      }
    }
  }
  return [...dangerous].map((key) => displayName.get(key));
}

function formulaUsesDefinedName(formula, definedName) {
  const escaped = definedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}(?=$|[^A-Za-z0-9_.])`, "i").test(formula);
}

function isOrderInvariantAggregate(formula, references, plan) {
  const aggregate = /^\s*=?(?:SUM|COUNT|COUNTA|AVERAGE|MIN|MAX)\s*\(([^()]*)\)\s*$/i.exec(formula);
  if (!aggregate) return false;
  const sheetQualifier = String.raw`(?:(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}\p{M}_. ]*)!)?`;
  const cell = String.raw`\$?[A-Z]{1,3}\$?\d+`;
  const reference = String.raw`${sheetQualifier}(?:${cell}(?::${cell})?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)`;
  if (!new RegExp(String.raw`^\s*${reference}(?:\s*[,;]\s*${reference})*\s*$`, "iu").test(aggregate[1])) {
    return false;
  }
  const relevant = references.filter((reference) => referenceTouchesMovable(reference, plan));
  if (relevant.length === 0) return false;
  const coverage = new Map();
  for (const reference of relevant) {
    for (const column of plan.recordColumns.map(columnToNumber)) {
      if (column < reference.startCol || column > reference.endCol) continue;
      for (const row of plan.scopedRows) {
        if (row < reference.startRow || row > reference.endRow) continue;
        const key = `${column}:${row}`;
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
      }
    }
  }
  for (const column of plan.recordColumns.map(columnToNumber)) {
    const touchesColumn = relevant.some((reference) => column >= reference.startCol && column <= reference.endCol);
    if (touchesColumn && plan.scopedRows.some((row) => coverage.get(`${column}:${row}`) !== 1)) return false;
  }
  return true;
}

function assertSafeFormulaDependencies(metadata, plan) {
  const scopedRowSet = new Set(plan.scopedRows);
  const dangerousNames = workbookDefinedNames(metadata, plan);
  if (dangerousNames.length > 0) {
    unsupported(`defined name ${dangerousNames[0]} can reference reordered cells even without a visible cell-formula consumer`);
  }
  for (const entry of metadata.nonCellFormulas) {
    if (!entry.formula) unsupported(`non-cell formula has no explicit text at ${entry.origin}`);
    if (UNSUPPORTED_REFERENCE_GRAMMAR_RE.test(entry.formula) || hasUnparsedSheetQualifiedReference(entry.formula)) {
      unsupported(`external or 3D non-cell formula references cannot be proven safe at ${entry.origin}`);
    }
    if (DYNAMIC_REFERENCE_FORMULA_RE.test(entry.formula)) {
      unsupported(`dynamic non-cell formula cannot be proven independent of reordered cells at ${entry.origin}`);
    }
    const references = parseA1References(entry.formula, entry.currentSheetName);
    if (entry.currentSheetName === null && references.some((reference) => !reference.sheetName)) {
      unsupported(`unqualified chart formula reference cannot be resolved to a worksheet at ${entry.origin}`);
    }
    if (references.some((reference) => referenceTouchesMovable(reference, plan))) {
      unsupported(`non-cell formula depends on reordered cells at ${entry.origin}`);
    }
  }
  for (const sheetMeta of metadata.sheets) {
    for (const entry of formulaEntries(sheetMeta)) {
      const formulaCell = parseCellRef(entry.ref);
      const formulaBinding = sameSheetName(sheetMeta.name, plan.sheetName) &&
        scopedRowSet.has(formulaCell.row) &&
        formulaCell.col >= plan.physical.startCol &&
        formulaCell.col <= plan.physical.endCol
        ? plan.recordBySourceRow.get(formulaCell.row)
        : undefined;
      const unsafeFormulaAttributes = Object.entries(entry.attrs).filter(
        ([name, value]) => name !== "t" || value !== "normal",
      );
      if (formulaBinding && unsafeFormulaAttributes.length > 0) {
        unsupported(`formula metadata cannot migrate safely at ${sheetMeta.name}!${entry.ref}: ${unsafeFormulaAttributes.map(([name]) => name).join(", ")}`);
      }
      if (entry.attrs.t && entry.attrs.t !== "normal") {
        unsupported(`shared, array, or data-table formula at ${sheetMeta.name}!${entry.ref}`);
      }
      if (!entry.formula) unsupported(`formula without explicit text at ${sheetMeta.name}!${entry.ref}`);
      if (UNSUPPORTED_REFERENCE_GRAMMAR_RE.test(entry.formula) || hasUnparsedSheetQualifiedReference(entry.formula)) {
        unsupported(`external or 3D formula references cannot be proven safe at ${sheetMeta.name}!${entry.ref}`);
      }
      if (DYNAMIC_REFERENCE_FORMULA_RE.test(entry.formula)) {
        unsupported(`dynamic reference formula cannot be proven independent of reordered cells at ${sheetMeta.name}!${entry.ref}`);
      }
      const usedDangerousName = dangerousNames.find((name) => formulaUsesDefinedName(entry.formula, name));
      if (usedDangerousName) {
        unsupported(`defined name ${usedDangerousName} can reference reordered cells at ${sheetMeta.name}!${entry.ref}`);
      }
      const references = parseA1References(entry.formula, sheetMeta.name);
      if (!formulaBinding) {
        if (references.some((reference) => referenceTouchesMovable(reference, plan)) && !isOrderInvariantAggregate(entry.formula, references, plan)) {
          unsupported(`formula outside the movable records depends on reordered cells at ${sheetMeta.name}!${entry.ref}`);
        }
        continue;
      }
      const { record } = formulaBinding;
      const delta = destinationStart(plan, record) - record.startRow;
      if (delta !== 0 && POSITIONAL_OR_VOLATILE_FORMULA_RE.test(entry.formula)) {
        unsupported(`row-dependent, indirect, or volatile formula moves with record ${record.id} at ${sheetMeta.name}!${entry.ref}`);
      }
      for (const reference of references) {
        if (referenceInsideRecord(reference, plan, record)) {
          if (delta !== 0 && (reference.startRowAbsolute || reference.endRowAbsolute)) {
            unsupported(`absolute row reference would not migrate with record ${record.id} at ${sheetMeta.name}!${entry.ref}`);
          }
          continue;
        }
        if (referenceTouchesMovable(reference, plan)) {
          unsupported(`formula crosses logical record blocks at ${sheetMeta.name}!${entry.ref}`);
        }
        if (delta !== 0 && (!reference.startRowAbsolute || !reference.endRowAbsolute)) {
          unsupported(`relative reference leaves logical record ${record.id} at ${sheetMeta.name}!${entry.ref}`);
        }
      }
    }
  }
}

function semanticCellMetadata(sheetMeta) {
  const result = new Map();
  const formulaByRef = new Map(formulaEntries(sheetMeta).map((entry) => [entry.ref.replace(/\$/g, "").toUpperCase(), entry]));
  for (const ref of new Set([...sheetMeta.cellAttributes.keys(), ...formulaByRef.keys()])) {
    const cellAttributes = { ...(sheetMeta.cellAttributes.get(ref) ?? {}) };
    delete cellAttributes.r;
    delete cellAttributes.s;
    delete cellAttributes.t;
    const formulaAttributes = { ...(formulaByRef.get(ref)?.attrs ?? {}) };
    if (Object.keys(cellAttributes).length === 0 && Object.keys(formulaAttributes).length === 0) continue;
    result.set(ref, { cellAttributes, formulaAttributes });
  }
  return result;
}

function assertPreservedSemanticCellMetadata(sourceMeta, candidateMeta, plan) {
  const scopedRows = new Set(plan.scopedSlots);
  for (const sourceSheet of sourceMeta.sheets) {
    const candidateSheet = candidateMeta.sheets.find((sheet) => sheet.name === sourceSheet.name);
    if (!candidateSheet) throw new Error(`Candidate worksheet is missing: ${sourceSheet.name}`);
    const sourceMetadata = semanticCellMetadata(sourceSheet);
    const candidateMetadata = semanticCellMetadata(candidateSheet);
    for (const ref of new Set([...sourceMetadata.keys(), ...candidateMetadata.keys()])) {
      const cell = parseCellRef(ref);
      const movable = sameSheetName(sourceSheet.name, plan.sheetName) &&
        scopedRows.has(cell.row) &&
        cell.col >= plan.physical.startCol &&
        cell.col <= plan.physical.endCol;
      if (movable) continue;
      if (stableJson(sourceMetadata.get(ref) ?? {}) !== stableJson(candidateMetadata.get(ref) ?? {})) {
        throw new Error(`Cell or formula OOXML metadata changed outside the reorder scope at ${sourceSheet.name}!${ref}.`);
      }
    }
  }
}

function assertSafeMovableCellMetadata(metadata, plan, label) {
  const sheet = metadata.sheets.find((item) => item.name === plan.sheetName);
  if (!sheet) throw new Error(`Worksheet not found: ${plan.sheetName}`);
  const scopedRows = new Set(plan.scopedSlots);
  for (const [ref, attributes] of sheet.cellAttributes) {
    const cell = parseCellRef(ref);
    if (!scopedRows.has(cell.row) || cell.col < plan.physical.startCol || cell.col > plan.physical.endCol) continue;
    const unsupportedAttributes = Object.keys(attributes).filter((name) => !["r", "s", "t"].includes(name));
    if (unsupportedAttributes.length > 0) {
      unsupported(`${label} cell ${plan.sheetName}!${ref} contains metadata attributes that cannot be migrated safely: ${unsupportedAttributes.join(", ")}`);
    }
  }
  for (const entry of formulaEntries(sheet)) {
    const cell = parseCellRef(entry.ref);
    if (!scopedRows.has(cell.row) || cell.col < plan.physical.startCol || cell.col > plan.physical.endCol) continue;
    const unsafe = Object.entries(entry.attrs).filter(([name, value]) => name !== "t" || value !== "normal");
    if (unsafe.length > 0) {
      unsupported(`${label} formula metadata cannot be migrated safely at ${plan.sheetName}!${entry.ref}: ${unsafe.map(([name]) => name).join(", ")}`);
    }
  }
}

function hyperlinkLocationReference(location, currentSheetName) {
  if (typeof location !== "string" || !location.trim()) return null;
  const fragment = location.includes("#") ? location.slice(location.lastIndexOf("#") + 1) : location;
  const match = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/i.exec(fragment.trim());
  if (!match) return null;
  const sheetName = match[1]?.replace(/''/g, "'") ?? match[2]?.trim() ?? currentSheetName;
  const ref = match[3].replace(/\$/g, "").toUpperCase();
  if (ref.includes(":")) return { sheetName, range: parseRange(ref, `hyperlink location ${location}`) };
  const cell = parseCellRef(ref);
  return {
    sheetName,
    range: { startCol: cell.col, endCol: cell.col, startRow: cell.row, endRow: cell.row },
  };
}

function assertSafeTargetStructures(metadata, plan) {
  if (metadata.referenceModeR1C1) {
    unsupported("R1C1 workbook reference mode cannot be proven safe by the A1 dependency auditor");
  }
  if (metadata.hasCalcChain) {
    unsupported("calcChain formula coordinates cannot be proven to migrate with reordered records");
  }
  const sheet = metadata.sheets.find((item) => item.name === plan.sheetName);
  if (!sheet) throw new Error(`Worksheet not found: ${plan.sheetName}`);
  assertSafeMovableCellMetadata(metadata, plan, "source");
  const childPayload = mergedChildrenWithPayload(sheet);
  if (childPayload.length > 0) {
    unsupported(`merged child cells contain value/formula/inline-string payload: ${childPayload.join(", ")}`);
  }
  if (/<(?:\w+:)?(?:conditionalFormatting|dataValidations|tableParts|pivotTableParts|drawing|legacyDrawing|controls|oleObjects|extLst|smartTags|cellWatches|ignoredErrors)\b/i.test(sheet.xml)) {
    unsupported("the target worksheet contains conditional formatting, validation, tables, pivots, drawings, controls, or extension metadata that cannot be proven record-bound");
  }
  const scopedRows = new Set(plan.scopedSlots);
  const actuallyMovedRows = new Set();
  for (const record of plan.scopedRecords) {
    const destination = destinationStart(plan, record);
    if (destination === record.startRow) continue;
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      actuallyMovedRows.add(record.startRow + offset);
      actuallyMovedRows.add(destination + offset);
    }
  }
  for (const hyperlinkSheet of metadata.sheets) {
    for (const match of hyperlinkSheet.xml.matchAll(/<(?:\w+:)?hyperlink\b([^>]*)\/?\s*>/gi)) {
      const attributes = parseAttributes(`<hyperlink ${match[1]}>`);
      if (sameSheetName(hyperlinkSheet.name, plan.sheetName)) {
        if (!attributes.ref) unsupported("a target-sheet hyperlink has no explicit cell reference");
        let range;
        try {
          if (attributes.ref.includes(":")) {
            range = parseRange(attributes.ref.replace(/\$/g, ""), `hyperlink ${attributes.ref}`);
          } else {
            const cell = parseCellRef(attributes.ref.replace(/\$/g, ""));
            range = { startCol: cell.col, endCol: cell.col, startRow: cell.row, endRow: cell.row };
          }
        } catch (error) {
          unsupported(`target-sheet hyperlink reference cannot be proven safe: ${error instanceof Error ? error.message : String(error)}`);
        }
        if ([...actuallyMovedRows].some((row) => row >= range.startRow && row <= range.endRow)) {
          unsupported(`hyperlink ${plan.sheetName}!${attributes.ref} is bound to an actually moved row and cannot remain attached to its record`);
        }
      }

      const locations = [];
      if (attributes.location) locations.push(attributes.location);
      const relationship = attributes["r:id"] ? hyperlinkSheet.relationships.get(attributes["r:id"]) : null;
      if (relationship?.target) locations.push(relationship.target);
      for (const location of locations) {
        let reference;
        try {
          reference = hyperlinkLocationReference(location, hyperlinkSheet.name);
        } catch (error) {
          unsupported(`hyperlink location cannot be proven safe: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (
          reference &&
          sameSheetName(reference.sheetName, plan.sheetName) &&
          [...actuallyMovedRows].some((row) => row >= reference.range.startRow && row <= reference.range.endRow)
        ) {
          unsupported(`hyperlink ${hyperlinkSheet.name}!${attributes.ref ?? "<unknown>"} points to an actually moved ledger row at ${location}`);
        }
      }
    }
  }
  for (const record of plan.scopedRecords) {
    const destination = destinationStart(plan, record);
    if (destination === record.startRow) continue;
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      for (const row of [record.startRow + offset, destination + offset]) {
        if (rowHasOutsidePhysicalStructure(sheet, plan, row)) {
          unsupported(`moving record ${record.id} would detach content or merges outside physicalRange at ${plan.sheetName}!${row}`);
        }
      }
    }
  }
  for (const formulaMatch of sheet.xml.matchAll(/<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
    const attrs = parseAttributes(`<c ${formulaMatch[1]}>`);
    if (!attrs.r) continue;
    const cell = parseCellRef(attrs.r.replace(/\$/g, ""));
    if (!scopedRows.has(cell.row) || cell.col < plan.physical.startCol || cell.col > plan.physical.endCol) continue;
    const formulaTag = /<(?:\w+:)?f\b([^>]*)>/i.exec(formulaMatch[2]);
    if (!formulaTag) continue;
    const formulaAttrs = parseAttributes(`<f ${formulaTag[1]}>`);
    if (formulaAttrs.t && formulaAttrs.t !== "normal") {
      unsupported(`shared, array, or data-table formula at ${plan.sheetName}!${attrs.r}`);
    }
  }
  for (const merge of sheet.merges) {
    if (!rangeIntersects(merge.range, plan.physical)) continue;
    const startBinding = plan.recordBySourceRow.get(merge.range.startRow);
    const endBinding = plan.recordBySourceRow.get(merge.range.endRow);
    if (
      merge.range.startCol < plan.physical.startCol ||
      merge.range.endCol > plan.physical.endCol ||
      !startBinding ||
      !endBinding ||
      startBinding.record.id !== endBinding.record.id
    ) {
      unsupported(`merge ${plan.sheetName}!${merge.ref} is not wholly contained in one declared record block`);
    }
  }
  const rowStructures = rowStructuralMetadata(sheet);
  for (const record of plan.scopedRecords) {
    const destination = destinationStart(plan, record);
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      const sourceAttributes = rowStructures.get(record.startRow + offset) ?? {};
      const destinationAttributes = rowStructures.get(destination + offset) ?? {};
      if (stableJson(sourceAttributes) !== stableJson(destinationAttributes)) {
        unsupported(`row outline/hidden/collapsed/style attributes would require unsupported migration for record ${record.id}`);
      }
    }
  }
  assertSafeFormulaDependencies(metadata, plan);
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Workbook contains a non-finite numeric cell.");
    if (Object.is(value, -0)) return 0;
    return Number(value.toPrecision(15));
  }
  if (["string", "boolean"].includes(typeof value)) return value;
  return JSON.parse(JSON.stringify(value));
}

function cellSnapshot(sheet, column, row) {
  const range = sheet.getRange(`${column}${row}`);
  return {
    value: normalizeValue(range.values?.[0]?.[0]),
    formula: range.formulas?.[0]?.[0] || "",
    formulaR1C1: range.formulasR1C1?.[0]?.[0] || "",
  };
}

function isBlankSnapshot(snapshot) {
  return !snapshot.formula && (snapshot.value === null || snapshot.value === "");
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function recordSnapshot(sheet, recordColumns, row) {
  return recordColumns.map((column) => cellSnapshot(sheet, column, row));
}

function blockSnapshot(sheet, recordColumns, record, startRow = record.startRow) {
  return Array.from(
    { length: record.rowCount },
    (_, offset) => recordSnapshot(sheet, recordColumns, startRow + offset),
  );
}

function recordSignature(snapshot) {
  return stableJson(
    snapshot.map((row) => row.map((cell) => ({
      // A1 references legitimately change when a logical record moves. R1C1
      // captures the record-bound formula. The normalized cached result remains
      // part of the logical record so row-dependent formulas cannot silently
      // change the displayed business value after a move.
      value: cell.value,
      formulaR1C1: cell.formulaR1C1,
    }))),
  );
}

function destinationStart(plan, record) {
  return plan.destinationStartRowById.get(record.id) ?? record.startRow;
}

function recordLogicalDate(sheet, plan, record, startRow, date1904, field) {
  const values = [];
  for (let offset = 0; offset < record.rowCount; offset += 1) {
    const snapshot = cellSnapshot(sheet, plan.dateColumn, startRow + offset);
    if (isBlankSnapshot(snapshot)) continue;
    values.push(dateFromExcelSerial(snapshot.value, date1904, `${field}.${plan.dateColumn}[${offset}]`));
  }
  if (values.length === 0) throw new Error(`${field} has no logical date anchor.`);
  if (new Set(values).size !== 1) throw new Error(`${field} contains multiple logical dates.`);
  return values[0];
}

function recordAmount(sheet, plan, record, startRow, field) {
  let total = 0n;
  let anchors = 0;
  for (let offset = 0; offset < record.rowCount; offset += 1) {
    const snapshot = cellSnapshot(sheet, plan.amountColumn, startRow + offset);
    if (isBlankSnapshot(snapshot)) continue;
    total += fixedFromCell(snapshot.value, `${field}.${plan.amountColumn}[${offset}]`);
    anchors += 1;
  }
  if (anchors === 0) throw new Error(`${field} has no amount anchor.`);
  return total;
}

function multiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function assertSameMultiset(left, right, message) {
  if (left.size !== right.size) throw new Error(message);
  for (const [key, count] of left) if (right.get(key) !== count) throw new Error(message);
}

function dateFromExcelSerial(value, date1904, field) {
  if (typeof value === "string") return parseIsoDate(value, field);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must contain an ISO date string or an Excel date serial.`);
  }
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-9) throw new Error(`${field} must not contain a time component.`);
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  return new Date(epoch + rounded * 86_400_000).toISOString().slice(0, 10);
}

async function computedStyle(workbook, sheetName, cellRef) {
  async function inspectCell() {
    const result = await workbook.inspect({
      kind: "computedStyle",
      sheetId: sheetName,
      range: cellRef,
      maxChars: 20_000,
    });
    const lines = String(result.ndjson ?? "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        record.kind === "computedStyle" &&
        record.sheet === sheetName &&
        record.for?.replace(/\$/g, "").toUpperCase() === cellRef.toUpperCase()
      ) {
        const style = { ...(record.style ?? {}) };
        delete style.styleId;
        return stableObject(style);
      }
    }
    return null;
  }

  const direct = await inspectCell();
  if (direct) return direct;

  // artifact-tool omits empty cells from computedStyle inspection, including
  // merged children. Probe only the in-memory workbook, then restore contents.
  // Conditional formatting is rejected before this path, so the sentinel
  // cannot change the effective style being measured.
  const sheet = workbook.worksheets.getItem(sheetName);
  const cell = sheet?.getRange(cellRef);
  if (!cell) throw new Error(`Unable to inspect computed style for ${sheetName}!${cellRef}.`);
  const originalValue = cell.values?.[0]?.[0] ?? null;
  const originalFormulaR1C1 = cell.formulasR1C1?.[0]?.[0] || "";
  if (originalFormulaR1C1 || (originalValue !== null && originalValue !== "")) {
    throw new Error(`Unable to inspect computed style for non-empty ${sheetName}!${cellRef}.`);
  }
  try {
    cell.values = [["__codex_style_probe__"]];
    const probed = await inspectCell();
    if (!probed) throw new Error(`Unable to inspect computed style for ${sheetName}!${cellRef}.`);
    return probed;
  } finally {
    cell.clear({ applyTo: "contents" });
  }
}

function colorHex(color, field) {
  if (!color) return undefined;
  if (typeof color === "string" && /^#?[0-9a-f]{6,8}$/i.test(color)) {
    return color.startsWith("#") ? color.toUpperCase() : `#${color.toUpperCase()}`;
  }
  if (typeof color === "object" && typeof color.value === "string" && /^[0-9a-f]{6,8}$/i.test(color.value)) {
    return `#${color.value.toUpperCase()}`;
  }
  unsupported(`${field} uses an unresolved or non-RGB color`);
}

function styleToFormat(style, field) {
  const allowedStyleKeys = new Set([
    "fill",
    "font",
    "border",
    "numberFormat",
    "wrapText",
    "horizontalAlignment",
    "verticalAlignment",
    "textRotation",
    "shrinkToFit",
    "indentLevel",
  ]);
  for (const key of Object.keys(style)) {
    if (!allowedStyleKeys.has(key)) unsupported(`${field} computed style property ${key}`);
  }
  const format = {};
  if (style.fill) {
    const fill = style.fill;
    const fillType = typeof fill.type === "string" ? Number(fill.type) : fill.type;
    const patternType = typeof fill.pattern?.patternType === "string"
      ? Number(fill.pattern.patternType)
      : fill.pattern?.patternType;
    const isDefaultPattern =
      fillType === 3 &&
      (!fill.color || !fill.color.value) &&
      (!fill.gradientStops || fill.gradientStops.length === 0) &&
      (!fill.pictureEffects || fill.pictureEffects.length === 0) &&
      (!fill.pattern || patternType === 1);
    const isNoFill =
      (fillType === 0 || fillType === undefined) &&
      (!fill.color || !fill.color.value) &&
      (!fill.gradientStops || fill.gradientStops.length === 0) &&
      (!fill.pictureEffects || fill.pictureEffects.length === 0);
    const isSolidFill =
      (fillType === 1 || (fillType === 3 && patternType === 2)) &&
      fill.color &&
      (!fill.gradientStops || fill.gradientStops.length === 0) &&
      (!fill.pictureEffects || fill.pictureEffects.length === 0);
    if (isSolidFill) {
      format.fill = colorHex(fill.color, `${field}.fill`);
    } else if (!isDefaultPattern && !isNoFill) {
      unsupported(`${field} uses a gradient, picture, or non-default pattern fill: ${stableJson(fill)}`);
    }
  }
  if (style.font) {
    const allowedFontKeys = new Set(["bold", "italic", "fontSize", "typeface", "fill", "underline", "strikethrough"]);
    for (const key of Object.keys(style.font)) {
      if (!allowedFontKeys.has(key)) unsupported(`${field}.font property ${key}`);
    }
    const font = {};
    if (style.font.bold !== undefined) font.bold = style.font.bold;
    if (style.font.italic !== undefined) font.italic = style.font.italic;
    if (style.font.fontSize !== undefined) font.size = style.font.fontSize;
    if (style.font.typeface !== undefined) font.name = style.font.typeface;
    if (style.font.underline !== undefined) font.underline = style.font.underline;
    if (style.font.strikethrough !== undefined) font.strikethrough = style.font.strikethrough;
    if (style.font.fill?.color) font.color = colorHex(style.font.fill.color, `${field}.font.fill`);
    format.font = font;
  }
  if (style.border) {
    const borders = {};
    const allowedBorders = new Set(["top", "bottom", "left", "right"]);
    for (const [edge, border] of Object.entries(style.border)) {
      if (!allowedBorders.has(edge)) unsupported(`${field}.border edge ${edge}`);
      if (!border || typeof border !== "object" || !border.style) unsupported(`${field}.border.${edge}`);
      borders[edge] = { style: border.style };
      if (border.color) borders[edge].color = colorHex(border.color, `${field}.border.${edge}.color`);
    }
    if (Object.keys(borders).length > 0) format.borders = borders;
  }
  for (const key of [
    "numberFormat",
    "wrapText",
    "horizontalAlignment",
    "verticalAlignment",
    "textRotation",
    "shrinkToFit",
    "indentLevel",
  ]) {
    if (style[key] !== undefined) format[key] = style[key];
  }
  return format;
}

function rowHeight(sheet, row, firstColumn) {
  const value = sheet.getRange(`${firstColumn}${row}`).format.rowHeight;
  return value === undefined ? null : value;
}

function columnWidth(sheet, column) {
  const value = sheet.getRange(`${column}1`).format.columnWidth;
  return value === undefined ? null : value;
}

function sameDimension(left, right) {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-6;
}

function rowHasOutsidePhysicalStructure(sheetMeta, plan, row) {
  for (const ref of sheetMeta.cells.keys()) {
    const cell = parseCellRef(ref);
    if (cell.row === row && (cell.col < plan.physical.startCol || cell.col > plan.physical.endCol)) return true;
  }
  return sheetMeta.merges.some((merge) => (
    row >= merge.range.startRow &&
    row <= merge.range.endRow &&
    (merge.range.startCol < plan.physical.startCol || merge.range.endCol > plan.physical.endCol)
  ));
}

function assertSafeRowHeightMigration(workbook, metadata, plan) {
  const sheet = workbook.worksheets.getItem(plan.sheetName);
  const sheetMeta = metadata.sheets.find((item) => item.name === plan.sheetName);
  if (!sheet || !sheetMeta) throw new Error(`Worksheet not found: ${plan.sheetName}`);
  for (const record of plan.scopedRecords) {
    const destination = destinationStart(plan, record);
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      const sourceRow = record.startRow + offset;
      const destinationRow = destination + offset;
      const sourceHeight = rowHeight(sheet, sourceRow, plan.recordColumns[0]);
      const destinationHeight = rowHeight(sheet, destinationRow, plan.recordColumns[0]);
      if (sameDimension(sourceHeight, destinationHeight)) continue;
      if (sourceHeight === null && destinationHeight !== null) {
        unsupported(`default row height cannot be safely cleared at ${plan.sheetName}!${destinationRow}`);
      }
      if (rowHasOutsidePhysicalStructure(sheetMeta, plan, destinationRow)) {
        unsupported(`row-height migration would alter content or structure outside physicalRange at ${plan.sheetName}!${destinationRow}`);
      }
    }
  }
}

function usedBounds(sheet) {
  const used = sheet.getUsedRange();
  if (!used) return null;
  return {
    startRow: used.rowIndex + 1,
    endRow: used.rowIndex + used.rowCount,
    startCol: used.columnIndex + 1,
    endCol: used.columnIndex + used.columnCount,
  };
}

function unionBounds(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    startRow: Math.min(left.startRow, right.startRow),
    endRow: Math.max(left.endRow, right.endRow),
    startCol: Math.min(left.startCol, right.startCol),
    endCol: Math.max(left.endCol, right.endCol),
  };
}

function ensureAuditSize(bounds, sheetName) {
  if (!bounds) return;
  const cells = (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
  if (cells > MAX_AUDIT_CELLS) unsupported(`exhaustive audit of ${sheetName} exceeds ${MAX_AUDIT_CELLS} cells`);
}

function expectedCandidateMerges(sourceMeta, plan) {
  const sourceSheet = sourceMeta.sheets.find((sheet) => sheet.name === plan.sheetName);
  const result = [];
  for (const merge of sourceSheet.merges) {
    const binding = plan.recordBySourceRow.get(merge.range.startRow);
    const record = binding?.record;
    if (
      record &&
      plan.destinationStartRowById.has(record.id) &&
      rangeIntersects(merge.range, plan.physical)
    ) {
      const delta = destinationStart(plan, record) - record.startRow;
      result.push(
        `${numberToColumn(merge.range.startCol)}${merge.range.startRow + delta}:${numberToColumn(merge.range.endCol)}${merge.range.endRow + delta}`,
      );
    } else {
      result.push(merge.ref);
    }
  }
  return result.sort();
}

function worksheetStructures(metadata) {
  return {
    date1904: metadata.date1904,
    sheets: metadata.sheets.map((sheet) => ({ name: sheet.name, state: sheet.state })),
  };
}

function normalizeStructuralXml(xml, relationships = new Map()) {
  return xml
    .replace(/<(?:\w+:)?sheetData\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheetData>/gi, "<sheetData/>")
    .replace(/<(?:\w+:)?mergeCells\b[^>]*>[\s\S]*?<\/(?:\w+:)?mergeCells>/gi, "<mergeCells/>")
    .replace(/<(?:\w+:)?mergeCells\b[^>]*\/>/gi, "<mergeCells/>")
    .replace(/\s+r:id=(?:"([^"]*)"|'([^']*)')/gi, (match, doubleQuoted, singleQuoted) => {
      const id = doubleQuoted ?? singleQuoted ?? "";
      const relationship = relationships.get(id);
      const signature = relationship
        ? crypto.createHash("sha256").update(stableJson(relationship), "utf8").digest("hex")
        : `missing:${id}`;
      return ` r:id="<relationship:${signature}>"`;
    })
    .replace(/>\s+</g, "><")
    .trim();
}

function rowStructuralMetadata(sheetMeta) {
  const rows = new Map();
  for (const match of sheetMeta.xml.matchAll(/<(?:\w+:)?row\b([^>]*)>/gi)) {
    const attributes = parseAttributes(`<row ${match[1]}>`);
    const row = Number(attributes.r);
    if (!Number.isSafeInteger(row) || row < 1) continue;
    delete attributes.r;
    delete attributes.spans;
    delete attributes.ht;
    delete attributes.customHeight;
    if (Object.keys(attributes).length > 0) rows.set(row, attributes);
  }
  return rows;
}

function assertMappedRowStructures(sourceMeta, candidateMeta, plan) {
  for (const sourceSheet of sourceMeta.sheets) {
    const candidateSheet = candidateMeta.sheets.find((sheet) => sheet.name === sourceSheet.name);
    if (!candidateSheet) throw new Error(`Candidate worksheet is missing: ${sourceSheet.name}`);
    const sourceRows = rowStructuralMetadata(sourceSheet);
    const candidateRows = rowStructuralMetadata(candidateSheet);
    const expected = new Map();
    for (const [sourceRow, attributes] of sourceRows) {
      let destinationRow = sourceRow;
      if (sourceSheet.name === plan.sheetName) {
        const binding = plan.recordBySourceRow.get(sourceRow);
        if (binding && plan.destinationStartRowById.has(binding.record.id)) {
          destinationRow = destinationStart(plan, binding.record) + binding.offset;
        }
      }
      if (expected.has(destinationRow)) {
        throw new Error(`Multiple source row structures map to ${sourceSheet.name}!${destinationRow}.`);
      }
      expected.set(destinationRow, attributes);
    }
    const serialize = (rows) => stableJson(
      [...rows.entries()].sort((left, right) => left[0] - right[0]),
    );
    if (serialize(expected) !== serialize(candidateRows)) {
      throw new Error(`Row outline/hidden/collapsed/style structure did not follow the bound row mapping: ${sourceSheet.name}.`);
    }
  }
}

function assertPreservedPackageStructures(sourceMeta, candidateMeta) {
  if (
    normalizeStructuralXml(sourceMeta.workbookXml, sourceMeta.workbookRelationships) !==
    normalizeStructuralXml(candidateMeta.workbookXml, candidateMeta.workbookRelationships) ||
    stableJson(sourceMeta.workbookRelationshipValues) !== stableJson(candidateMeta.workbookRelationshipValues)
  ) {
    throw new Error("Workbook-level OOXML structure changed during ledger reorder.");
  }
  if (stableJson(sourceMeta.protectedParts) !== stableJson(candidateMeta.protectedParts)) {
    throw new Error("Protected non-cell OOXML parts changed during ledger reorder.");
  }
  for (const name of [...new Set([
    ...Object.keys(sourceMeta.protectedRelationships),
    ...Object.keys(candidateMeta.protectedRelationships),
  ])].sort()) {
    if (stableJson(sourceMeta.protectedRelationships[name]) !== stableJson(candidateMeta.protectedRelationships[name])) {
      throw new Error(`OOXML relationship structure changed during ledger reorder: ${name}.`);
    }
  }
  for (const sourceSheet of sourceMeta.sheets) {
    const candidateSheet = candidateMeta.sheets.find((sheet) => sheet.name === sourceSheet.name);
    if (!candidateSheet) throw new Error(`Candidate worksheet is missing: ${sourceSheet.name}`);
    if (
      normalizeStructuralXml(sourceSheet.xml, sourceSheet.relationships) !==
      normalizeStructuralXml(candidateSheet.xml, candidateSheet.relationships) ||
      stableJson(sourceSheet.relationshipValues) !== stableJson(candidateSheet.relationshipValues)
    ) {
      throw new Error(`Worksheet structure outside cells/merges changed: ${sourceSheet.name}.`);
    }
  }
}

function assertNoFormulaErrors(workbook) {
  const errors = /^(?:#NULL!|#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A|#GETTING_DATA|#SPILL!|#CALC!|#FIELD!|#BLOCKED!|#BUSY!|#CONNECT!|#UNKNOWN!|#PYTHON!)$/;
  for (const sheet of workbook.worksheets.items) {
    const bounds = usedBounds(sheet);
    ensureAuditSize(bounds, sheet.name);
    if (!bounds) continue;
    for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
      for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
        const value = sheet.getCell(row - 1, col - 1).values?.[0]?.[0];
        if (typeof value === "string" && errors.test(value.trim())) {
          throw new Error(`Formula error found at ${sheet.name}!${numberToColumn(col)}${row}.`);
        }
      }
    }
  }
}

async function openWorkbook(filePath) {
  const { FileBlob, SpreadsheetFile } = await artifactTool();
  return SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
}

export async function generateLedgerReorderPlan(request) {
  await assertOwnedStaging({ version: 2, stagingRoot: request.stagingRoot, stagingToken: request.stagingToken });
  const sourceStat = await fs.lstat(request.sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("request.sourcePath must be a regular non-link file.");
  }
  try {
    await fs.access(request.outputPath);
    throw new Error("request.outputPath already exists; choose a new candidate revision.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const sourceHashBefore = await sha256File(request.sourcePath);
  const sourceMeta = await readXlsxMetadata(request.sourcePath);
  const sourceSheetMeta = sourceMeta.sheets.find((sheet) => sheet.name === request.sheetName);
  if (!sourceSheetMeta) throw new Error(`Worksheet not found: ${request.sheetName}`);
  const workbook = await openWorkbook(request.sourcePath);
  const sheet = workbook.worksheets.getItem(request.sheetName);
  if (!sheet) throw new Error(`Worksheet not found: ${request.sheetName}`);

  const activeRows = new Set();
  for (let row = request.physical.startRow; row <= request.physical.endRow; row += 1) {
    const snapshot = [];
    for (let col = request.physical.startCol; col <= request.physical.endCol; col += 1) {
      snapshot.push(cellSnapshot(sheet, numberToColumn(col), row));
    }
    if (!snapshot.every(isBlankSnapshot)) activeRows.add(row);
  }
  for (const merge of sourceSheetMeta.merges) {
    if (!rangeIntersects(merge.range, request.physical)) continue;
    if (
      merge.range.startRow < request.physical.startRow ||
      merge.range.endRow > request.physical.endRow ||
      merge.range.startCol < request.physical.startCol ||
      merge.range.endCol > request.physical.endCol
    ) {
      unsupported(`merge ${request.sheetName}!${merge.ref} crosses the requested physicalRange boundary`);
    }
    for (let row = merge.range.startRow; row <= merge.range.endRow; row += 1) activeRows.add(row);
  }
  if (activeRows.size === 0) throw new Error("The requested physicalRange contains no business records.");

  const parent = new Map([...activeRows].map((row) => [row, row]));
  const find = (row) => {
    let root = row;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(row) !== row) {
      const next = parent.get(row);
      parent.set(row, root);
      row = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const merge of sourceSheetMeta.merges) {
    if (!rangeIntersects(merge.range, request.physical) || merge.range.startRow === merge.range.endRow) continue;
    for (let row = merge.range.startRow + 1; row <= merge.range.endRow; row += 1) union(merge.range.startRow, row);
  }
  const components = new Map();
  for (const row of [...activeRows].sort((left, right) => left - right)) {
    const root = find(row);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(row);
  }
  const ranges = [...components.values()]
    .map((rows) => ({ startRow: Math.min(...rows), endRow: Math.max(...rows) }))
    .sort((left, right) => left.startRow - right.startRow);
  for (const range of ranges) {
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      if (!activeRows.has(row)) unsupported(`record component ${range.startRow}:${range.endRow} contains an unbound gap at row ${row}`);
    }
  }
  const recordColumns = [];
  for (let col = request.physical.startCol; col <= request.physical.endCol; col += 1) {
    recordColumns.push(numberToColumn(col));
  }
  const planView = {
    dateColumn: request.dateColumn,
    amountColumn: request.amountColumn,
  };
  const records = [];
  let scopedAmount = 0n;
  let scopedRecordCount = 0;
  let scopedRowCount = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const record = {
      id: `R${String(index + 1).padStart(6, "0")}`,
      startRow: range.startRow,
      endRow: range.endRow,
      rowCount: range.endRow - range.startRow + 1,
      baselineOrder: index + 1,
    };
    record.dateSortKey = recordLogicalDate(
      sheet,
      planView,
      record,
      record.startRow,
      sourceMeta.date1904,
      `generated ${record.id}`,
    );
    const amount = recordAmount(sheet, planView, record, record.startRow, `generated ${record.id} amount`);
    const afterStart = request.scopeStartInclusive
      ? record.dateSortKey >= request.scopeStart
      : record.dateSortKey > request.scopeStart;
    const beforeEnd = request.scopeEndInclusive
      ? record.dateSortKey <= request.scopeEnd
      : record.dateSortKey < request.scopeEnd;
    if (afterStart && beforeEnd) {
      scopedAmount += amount;
      scopedRecordCount += 1;
      scopedRowCount += record.rowCount;
    }
    records.push({
      id: record.id,
      startRow: record.startRow,
      endRow: record.endRow,
      dateSortKey: record.dateSortKey,
      baselineOrder: record.baselineOrder,
    });
  }
  if (scopedRecordCount === 0) throw new Error("The explicit date boundaries select no record blocks.");
  const rawPlan = {
    version: 2,
    generatorVersion: 1,
    recordModel: "contiguous-row-block",
    datePolicy: "single-logical-date",
    mode: "ledger-reorder-correction",
    rootPath: request.rootPath,
    stagingRoot: request.stagingRoot,
    stagingToken: request.stagingToken,
    sourcePath: request.sourcePath,
    outputPath: request.outputPath,
    activeCandidatePath: request.activeCandidatePath,
    targetPath: request.targetPath,
    candidateRevision: request.candidateRevision,
    expectedSourceSha256: sourceHashBefore,
    sheetName: request.sheetName,
    physicalRange: request.physical.a1,
    scopeStart: request.scopeStart,
    scopeStartInclusive: request.scopeStartInclusive,
    scopeEnd: request.scopeEnd,
    scopeEndInclusive: request.scopeEndInclusive,
    sortKeys: ["date:asc", "baselineOrder:asc"],
    stableTieBreaker: "baselineOrder",
    blankRowsPolicy: "preserve-physical",
    recordColumns,
    dateColumn: request.dateColumn,
    amountColumn: request.amountColumn,
    records,
    expectedRecordCount: records.length,
    expectedPhysicalRecordRowCount: records.reduce((sum, record) => sum + record.endRow - record.startRow + 1, 0),
    expectedScopedRecordCount: scopedRecordCount,
    expectedScopedRowCount: scopedRowCount,
    expectedScopedAmount: formatFixed(scopedAmount),
    expectedAmountDelta: "0",
  };
  const plan = validatePlan(rawPlan);
  assertSafeTargetStructures(sourceMeta, plan);
  assertSafeRowHeightMigration(workbook, sourceMeta, plan);
  const sourceHashAfter = await sha256File(request.sourcePath);
  if (sourceHashAfter !== sourceHashBefore) throw new Error("Source workbook changed during plan generation.");
  return { plan: rawPlan, normalizedPlan: plan, sourceSha256: sourceHashBefore };
}

export async function writeGeneratedPlan(planOutputPath, rawPlan) {
  const absolutePath = path.resolve(requireString(planOutputPath, "plan output path"));
  const normalized = validatePlan(rawPlan);
  if (!isDirectChild(normalized.stagingRoot, absolutePath) || path.extname(absolutePath).toLowerCase() !== ".json") {
    throw new Error("Generated plan output must be a new .json direct child of stagingRoot.");
  }
  await assertOwnedStaging(normalized);
  const bytes = Buffer.from(`${JSON.stringify(stableObject(rawPlan), null, 2)}\n`, "utf8");
  let created = false;
  try {
    await fs.writeFile(absolutePath, bytes, { flag: "wx" });
    created = true;
    const persisted = await fs.readFile(absolutePath);
    if (!persisted.equals(bytes)) throw new Error("Persisted plan bytes differ from the generated plan bytes.");
    return {
      path: absolutePath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  } catch (error) {
    if (created) {
      try {
        await fs.unlink(absolutePath);
      } catch (cleanupError) {
        throw new Error(`${cleanError(error)} Cleanup failed; generated plan remains at ${absolutePath}: ${cleanError(cleanupError)}`);
      }
    }
    throw error;
  }
}

async function assertMergedChildrenBlankAfterUnmerge(filePath, metadata) {
  const workbook = await openWorkbook(filePath);
  let inspectedChildren = 0;
  for (const sheetMeta of metadata.sheets) {
    const sheet = workbook.worksheets.getItem(sheetMeta.name);
    if (!sheet) throw new Error(`Worksheet not found during merged-child audit: ${sheetMeta.name}`);
    for (const merge of sheetMeta.merges) {
      const { startCol, endCol, startRow, endRow } = merge.range;
      inspectedChildren += (endCol - startCol + 1) * (endRow - startRow + 1) - 1;
      if (inspectedChildren > MAX_AUDIT_CELLS) {
        unsupported(`merged-child unmerge audit exceeds ${MAX_AUDIT_CELLS} cells`);
      }
      sheet.unmergeCells(merge.ref);
      for (let row = startRow; row <= endRow; row += 1) {
        for (let col = startCol; col <= endCol; col += 1) {
          if (row === startRow && col === startCol) continue;
          const ref = `${numberToColumn(col)}${row}`;
          if (!isBlankSnapshot(cellSnapshot(sheet, numberToColumn(col), row))) {
            throw new Error(`Candidate merged child is non-empty after independent unmerge: ${sheetMeta.name}!${ref}`);
          }
        }
      }
    }
  }
}

async function auditWorkbookPair(plan, candidatePath, { sourceWorkbook, candidateWorkbook, sourceMeta, candidateMeta } = {}) {
  await assertOwnedStaging(plan);
  const sourceHash = await sha256File(plan.sourcePath);
  if (sourceHash !== plan.expectedSourceSha256) {
    throw new Error(`Source SHA256 ${sourceHash} does not match expectedSourceSha256.`);
  }
  const candidateAbsolute = path.resolve(candidatePath);
  if (samePath(candidateAbsolute, plan.sourcePath)) throw new Error("Candidate must not be the source workbook.");
  const candidateHashBefore = await sha256File(candidateAbsolute);
  sourceMeta ??= await readXlsxMetadata(plan.sourcePath);
  candidateMeta ??= await readXlsxMetadata(candidateAbsolute);
  assertSafeTargetStructures(sourceMeta, plan);
  const candidateTargetMeta = candidateMeta.sheets.find((sheet) => sheet.name === plan.sheetName);
  if (!candidateTargetMeta) throw new Error(`Candidate worksheet not found: ${plan.sheetName}`);
  assertSafeMovableCellMetadata(candidateMeta, plan, "candidate");
  const childPayload = candidateMeta.sheets.flatMap(mergedChildrenWithPayload);
  if (childPayload.length > 0) {
    throw new Error(`Candidate merged child cells contain value/formula/inline-string payload: ${childPayload.join(", ")}`);
  }
  if (stableJson(worksheetStructures(sourceMeta)) !== stableJson(worksheetStructures(candidateMeta))) {
    throw new Error("Candidate workbook sheet names/order/visibility differ from the source.");
  }
  assertPreservedPackageStructures(sourceMeta, candidateMeta);
  assertPreservedSemanticCellMetadata(sourceMeta, candidateMeta, plan);
  assertMappedRowStructures(sourceMeta, candidateMeta, plan);
  sourceWorkbook ??= await openWorkbook(plan.sourcePath);
  candidateWorkbook ??= await openWorkbook(candidateAbsolute);
  const sourceSheets = sourceWorkbook.worksheets.items;
  const candidateSheets = candidateWorkbook.worksheets.items;
  if (sourceSheets.length !== candidateSheets.length) throw new Error("Candidate contains an extra or missing worksheet.");
  const sourceTarget = sourceWorkbook.worksheets.getItem(plan.sheetName);
  const candidateTarget = candidateWorkbook.worksheets.getItem(plan.sheetName);
  if (!sourceTarget || !candidateTarget) throw new Error(`Worksheet not found: ${plan.sheetName}`);
  assertSafeRowHeightMigration(sourceWorkbook, sourceMeta, plan);

  const sourceRows = new Map();
  for (const record of plan.records) {
    const snapshot = blockSnapshot(sourceTarget, plan.recordColumns, record);
    if (snapshot.flat().every(isBlankSnapshot)) throw new Error(`Declared source record ${record.id} is blank.`);
    const actualDate = recordLogicalDate(
      sourceTarget,
      plan,
      record,
      record.startRow,
      sourceMeta.date1904,
      `source ${record.id}`,
    );
    if (actualDate !== record.dateSortKey) {
      throw new Error(`Record ${record.id} logical date does not match dateSortKey.`);
    }
    sourceRows.set(record.id, snapshot);
  }
  for (let row = plan.physical.startRow; row <= plan.physical.endRow; row += 1) {
    if (plan.recordBySourceRow.has(row)) continue;
    const snapshot = recordSnapshot(sourceTarget, plan.recordColumns, row);
    if (!snapshot.every(isBlankSnapshot)) {
      throw new Error(`Undeclared source row ${row} is not blank under preserve-physical.`);
    }
    const candidateSnapshot = recordSnapshot(candidateTarget, plan.recordColumns, row);
    if (!candidateSnapshot.every(isBlankSnapshot)) {
      throw new Error(`Candidate changed preserved blank row ${row}.`);
    }
  }

  const candidateBlocks = plan.records.map((record) => ({
    record,
    startRow: destinationStart(plan, record),
  }));
  const sourceSignatures = [...sourceRows.values()].map(recordSignature);
  const candidateSignatures = candidateBlocks.map(({ record, startRow }) => (
    recordSignature(blockSnapshot(candidateTarget, plan.recordColumns, record, startRow))
  ));
  assertSameMultiset(
    multiset(sourceSignatures),
    multiset(candidateSignatures),
    "Candidate business-record multiset differs from the source, including duplicate counts.",
  );
  if (candidateBlocks.length !== plan.expectedRecordCount) throw new Error("Candidate record count differs from expectedRecordCount.");

  let sourceScopedAmount = 0n;
  let candidateScopedAmount = 0n;
  let sourceTotalAmount = 0n;
  let candidateTotalAmount = 0n;
  for (const record of plan.records) {
    const sourceAmount = recordAmount(sourceTarget, plan, record, record.startRow, `source ${record.id} amount`);
    sourceTotalAmount += sourceAmount;
    if (plan.destinationStartRowById.has(record.id)) sourceScopedAmount += sourceAmount;
    candidateTotalAmount += recordAmount(
      candidateTarget,
      plan,
      record,
      destinationStart(plan, record),
      `candidate ${record.id} amount`,
    );
  }
  for (const record of plan.sortedScopedRecords) {
    candidateScopedAmount += recordAmount(
      candidateTarget,
      plan,
      record,
      destinationStart(plan, record),
      `candidate scoped ${record.id} amount`,
    );
  }
  if (sourceScopedAmount !== plan.expectedScopedAmountFixed || candidateScopedAmount !== plan.expectedScopedAmountFixed) {
    throw new Error("Scoped amount does not match expectedScopedAmount in both source and candidate.");
  }
  const amountDelta = candidateTotalAmount - sourceTotalAmount;
  if (amountDelta !== 0n) throw new Error(`Candidate amount delta is ${formatFixed(amountDelta)}, expected 0.`);

  for (const record of plan.sortedScopedRecords) {
    const destinationRow = destinationStart(plan, record);
    const expected = sourceRows.get(record.id);
    const actual = blockSnapshot(candidateTarget, plan.recordColumns, record, destinationRow);
    if (recordSignature(expected) !== recordSignature(actual)) {
      throw new Error(`Candidate block starting at row ${destinationRow} is not logical record ${record.id}.`);
    }
    const actualDate = recordLogicalDate(
      candidateTarget,
      plan,
      record,
      destinationRow,
      candidateMeta.date1904,
      `candidate ${record.id}`,
    );
    if (actualDate !== record.dateSortKey) throw new Error(`Candidate date mismatch for record ${record.id}.`);
  }
  for (let index = 1; index < plan.sortedScopedRecords.length; index += 1) {
    const previous = plan.sortedScopedRecords[index - 1];
    const current = plan.sortedScopedRecords[index];
    if (
      previous.dateSortKey > current.dateSortKey ||
      (previous.dateSortKey === current.dateSortKey && previous.baselineOrder >= current.baselineOrder) ||
      destinationStart(plan, previous) + previous.rowCount > destinationStart(plan, current)
    ) {
      throw new Error("Candidate does not satisfy stable dateSortKey/baselineOrder ordering.");
    }
  }

  const expectedTargetMerges = expectedCandidateMerges(sourceMeta, plan);
  const actualTargetMerges = candidateTargetMeta.merges.map((merge) => merge.ref).sort();
  if (stableJson(expectedTargetMerges) !== stableJson(actualTargetMerges)) {
    throw new Error("Candidate merge structure does not match the record-bound mapping.");
  }
  for (const sourceSheetMeta of sourceMeta.sheets) {
    if (sourceSheetMeta.name === plan.sheetName) continue;
    const candidateSheetMeta = candidateMeta.sheets.find((sheet) => sheet.name === sourceSheetMeta.name);
    if (!candidateSheetMeta || stableJson(sourceSheetMeta.merges.map((m) => m.ref).sort()) !== stableJson(candidateSheetMeta.merges.map((m) => m.ref).sort())) {
      throw new Error(`Merge structure changed outside the target worksheet: ${sourceSheetMeta.name}.`);
    }
  }

  const scopedRows = new Set(plan.scopedSlots);
  for (let sheetIndex = 0; sheetIndex < sourceSheets.length; sheetIndex += 1) {
    const sourceSheet = sourceSheets[sheetIndex];
    const candidateSheet = candidateSheets[sheetIndex];
    if (sourceSheet.name !== candidateSheet.name) throw new Error("Worksheet order changed.");
    let bounds = unionBounds(usedBounds(sourceSheet), usedBounds(candidateSheet));
    if (sourceSheet.name === plan.sheetName) bounds = unionBounds(bounds, plan.physical);
    ensureAuditSize(bounds, sourceSheet.name);
    if (!bounds) continue;
    for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
      const column = numberToColumn(col);
      if (!sameDimension(columnWidth(sourceSheet, column), columnWidth(candidateSheet, column))) {
        throw new Error(`Column width changed at ${sourceSheet.name}!${column}.`);
      }
    }
    for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
      const targetMovableRow = sourceSheet.name === plan.sheetName && scopedRows.has(row);
      if (!targetMovableRow && !sameDimension(rowHeight(sourceSheet, row, numberToColumn(bounds.startCol)), rowHeight(candidateSheet, row, numberToColumn(bounds.startCol)))) {
        throw new Error(`Row height changed outside the reorder scope at ${sourceSheet.name}!${row}.`);
      }
      for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
        const isMovableCell =
          sourceSheet.name === plan.sheetName &&
          scopedRows.has(row) &&
          col >= plan.physical.startCol &&
          col <= plan.physical.endCol;
        if (isMovableCell) continue;
        const column = numberToColumn(col);
        const ref = `${column}${row}`;
        if (stableJson(cellSnapshot(sourceSheet, column, row)) !== stableJson(cellSnapshot(candidateSheet, column, row))) {
          throw new Error(`Value or formula changed outside the reorder scope at ${sourceSheet.name}!${ref}.`);
        }
        const sourceStyle = await computedStyle(sourceWorkbook, sourceSheet.name, ref);
        const candidateStyle = await computedStyle(candidateWorkbook, candidateSheet.name, ref);
        if (stableJson(sourceStyle) !== stableJson(candidateStyle)) {
          throw new Error(`Computed style changed outside the reorder scope at ${sourceSheet.name}!${ref}.`);
        }
      }
    }
  }

  for (const record of plan.sortedScopedRecords) {
    const destinationRow = destinationStart(plan, record);
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      const sourcePhysicalRow = record.startRow + offset;
      const destinationPhysicalRow = destinationRow + offset;
      const sourceHeight = rowHeight(sourceTarget, sourcePhysicalRow, plan.recordColumns[0]);
      const destinationHeight = rowHeight(candidateTarget, destinationPhysicalRow, plan.recordColumns[0]);
      if (!sameDimension(sourceHeight, destinationHeight)) {
        throw new Error(`Row height did not migrate with record ${record.id} offset ${offset}.`);
      }
      for (const column of plan.recordColumns) {
        const sourceRef = `${column}${sourcePhysicalRow}`;
        const destinationRef = `${column}${destinationPhysicalRow}`;
        const sourceStyle = await computedStyle(sourceWorkbook, plan.sheetName, sourceRef);
        const candidateStyle = await computedStyle(candidateWorkbook, plan.sheetName, destinationRef);
        if (stableJson(sourceStyle) !== stableJson(candidateStyle)) {
          throw new Error(`Computed style did not migrate with record ${record.id}: ${sourceRef} -> ${destinationRef}.`);
        }
      }
    }
  }
  assertNoFormulaErrors(candidateWorkbook);
  await assertMergedChildrenBlankAfterUnmerge(candidateAbsolute, candidateMeta);
  const sourceHashAfter = await sha256File(plan.sourcePath);
  if (sourceHashAfter !== sourceHash) {
    throw new Error("Source workbook changed during the ledger reorder audit.");
  }
  const candidateHashAfter = await sha256File(candidateAbsolute);
  if (candidateHashAfter !== candidateHashBefore) {
    throw new Error("Candidate workbook changed during the ledger reorder audit.");
  }
  return {
    ok: true,
    mode: "ledger-reorder-correction",
    sourceSha256: sourceHash,
    candidateSha256: candidateHashBefore,
    planVersion: plan.version,
    planFileSha256: plan.planFileSha256 ?? null,
    expectedRecordCount: plan.expectedRecordCount,
    expectedScopedRecordCount: plan.expectedScopedRecordCount,
    expectedScopedRowCount: plan.expectedScopedRowCount,
    expectedScopedAmount: formatFixed(candidateScopedAmount),
    amountDelta: formatFixed(amountDelta),
    audit: "exhaustive",
  };
}

export async function auditLedgerReorder(plan, candidatePath) {
  const absolute = path.resolve(requireString(candidatePath, "candidate path"));
  const allowed = [plan.outputPath];
  if (plan.version === 2) allowed.push(plan.activeCandidatePath);
  if (!allowed.some((candidate) => samePath(absolute, candidate))) {
    throw new Error("The audited candidate must be exactly a candidate path bound by the plan.");
  }
  return auditWorkbookPair(plan, absolute);
}

function mappedMerges(sourceMeta, plan) {
  const sheet = sourceMeta.sheets.find((item) => item.name === plan.sheetName);
  const scopedRows = new Set(plan.scopedSlots);
  const toUnmerge = [];
  const toMerge = [];
  for (const merge of sheet.merges) {
    if (!scopedRows.has(merge.range.startRow) || !rangeIntersects(merge.range, plan.physical)) continue;
    toUnmerge.push(merge.ref);
    const record = plan.recordBySourceRow.get(merge.range.startRow)?.record;
    const delta = destinationStart(plan, record) - record.startRow;
    const startRow = merge.range.startRow + delta;
    const endRow = merge.range.endRow + delta;
    toMerge.push({
      ref: `${numberToColumn(merge.range.startCol)}${startRow}:${numberToColumn(merge.range.endCol)}${endRow}`,
      startCol: merge.range.startCol,
      endCol: merge.range.endCol,
      startRow,
      endRow,
    });
  }
  return { toUnmerge, toMerge };
}

async function replayRecordStyles(workbook, sheet, plan, sourceStyles) {
  for (const record of plan.sortedScopedRecords) {
    const destinationRow = destinationStart(plan, record);
    for (let offset = 0; offset < record.rowCount; offset += 1) {
      for (const column of plan.recordColumns) {
        const sourceStyle = sourceStyles.get(`${record.id}:${offset}:${column}`);
        sheet.getRange(`${column}${destinationRow + offset}`).format = styleToFormat(
          sourceStyle,
          `${plan.sheetName}!${column}${record.startRow + offset}`,
        );
      }
    }
  }
}

export async function buildLedgerReorderCandidate(plan) {
  let outputCreated = false;
  let createdOutputSha256;
  let tempPath;
  let result;
  let primaryError;
  try {
    await assertOwnedStaging(plan);
    const sourceHash = await sha256File(plan.sourcePath);
    if (sourceHash !== plan.expectedSourceSha256) {
      throw new Error(`Source SHA256 ${sourceHash} does not match expectedSourceSha256.`);
    }
    try {
      await fs.access(plan.outputPath);
      throw new Error("outputPath already exists; refusing to overwrite it.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const outputDirectory = path.dirname(plan.outputPath);
    const directoryStat = await fs.stat(outputDirectory);
    if (!directoryStat.isDirectory()) throw new Error("outputPath parent is not a directory.");
    const sourceMeta = await readXlsxMetadata(plan.sourcePath);
    assertSafeTargetStructures(sourceMeta, plan);
    const workbook = await openWorkbook(plan.sourcePath);
    const sheet = workbook.worksheets.getItem(plan.sheetName);
    if (!sheet) throw new Error(`Worksheet not found: ${plan.sheetName}`);
    assertSafeRowHeightMigration(workbook, sourceMeta, plan);

    const sourceSnapshots = new Map();
    const sourceStyles = new Map();
    const sourceHeights = new Map();
    for (const record of plan.records) {
      const snapshot = blockSnapshot(sheet, plan.recordColumns, record);
      if (snapshot.flat().every(isBlankSnapshot)) throw new Error(`Declared source record ${record.id} is blank.`);
      sourceSnapshots.set(record.id, snapshot);
      const actualDate = recordLogicalDate(
        sheet,
        plan,
        record,
        record.startRow,
        sourceMeta.date1904,
        `source ${record.id}`,
      );
      if (actualDate !== record.dateSortKey) throw new Error(`Record ${record.id} logical date does not match dateSortKey.`);
      for (let offset = 0; offset < record.rowCount; offset += 1) {
        sourceHeights.set(`${record.id}:${offset}`, rowHeight(sheet, record.startRow + offset, plan.recordColumns[0]));
        for (const column of plan.recordColumns) {
          const sourceRow = record.startRow + offset;
          const style = await computedStyle(workbook, plan.sheetName, `${column}${sourceRow}`);
          styleToFormat(style, `${plan.sheetName}!${column}${sourceRow}`);
          sourceStyles.set(`${record.id}:${offset}:${column}`, style);
        }
      }
    }
    for (let row = plan.physical.startRow; row <= plan.physical.endRow; row += 1) {
      if (plan.recordBySourceRow.has(row)) continue;
      if (!recordSnapshot(sheet, plan.recordColumns, row).every(isBlankSnapshot)) {
        throw new Error(`Undeclared source row ${row} is not blank under preserve-physical.`);
      }
    }
    let scopedAmount = 0n;
    for (const record of plan.scopedRecords) {
      scopedAmount += recordAmount(sheet, plan, record, record.startRow, `source ${record.id} amount`);
    }
    if (scopedAmount !== plan.expectedScopedAmountFixed) {
      throw new Error(
        `Source scoped amount ${formatFixed(scopedAmount)} does not match expectedScopedAmount ${formatFixed(plan.expectedScopedAmountFixed)}.`,
      );
    }

    const { toUnmerge, toMerge } = mappedMerges(sourceMeta, plan);
    for (const ref of toUnmerge) {
      const merge = parseRange(ref, `merge ${ref}`);
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let col = merge.startCol; col <= merge.endCol; col += 1) {
          if (row === merge.startRow && col === merge.startCol) continue;
          sheet.getRange(`${numberToColumn(col)}${row}`).clear({ applyTo: "contents" });
        }
      }
      sheet.unmergeCells(ref);
    }
    for (const row of plan.scopedSlots) {
      sheet.getRange(`${plan.recordColumns[0]}${row}:${plan.recordColumns.at(-1)}${row}`).clear({ applyTo: "all" });
    }
    for (const record of plan.sortedScopedRecords) {
      const destinationRow = destinationStart(plan, record);
      const snapshot = sourceSnapshots.get(record.id);
      for (let offset = 0; offset < record.rowCount; offset += 1) {
        for (let index = 0; index < plan.recordColumns.length; index += 1) {
          const column = plan.recordColumns[index];
          const cell = sheet.getRange(`${column}${destinationRow + offset}`);
          if (snapshot[offset][index].formulaR1C1) {
            cell.formulasR1C1 = [[snapshot[offset][index].formulaR1C1]];
          } else {
            cell.values = [[snapshot[offset][index].value]];
          }
        }
        const height = sourceHeights.get(`${record.id}:${offset}`);
        if (height !== null) {
          sheet.getRange(`${plan.recordColumns[0]}${destinationRow + offset}:${plan.recordColumns.at(-1)}${destinationRow + offset}`).format.rowHeight = height;
        }
      }
    }
    await replayRecordStyles(workbook, sheet, plan, sourceStyles);
    for (const merge of toMerge) {
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let col = merge.startCol; col <= merge.endCol; col += 1) {
          if (row === merge.startRow && col === merge.startCol) continue;
          sheet.getRange(`${numberToColumn(col)}${row}`).clear({ applyTo: "contents" });
        }
      }
      sheet.mergeCells(merge.ref);
    }

    const { SpreadsheetFile } = await artifactTool();
    tempPath = path.join(
      outputDirectory,
      `.${path.basename(plan.outputPath)}.codex-ledger-reorder-${crypto.randomUUID()}.tmp.xlsx`,
    );
    const exported = await SpreadsheetFile.exportXlsx(workbook);
    await exported.save(tempPath);
    const selfAudit = await auditWorkbookPair(plan, tempPath, { sourceMeta });
    await assertOwnedStaging(plan);
    await fs.copyFile(tempPath, plan.outputPath, fs.constants.COPYFILE_EXCL);
    outputCreated = true;
    createdOutputSha256 = selfAudit.candidateSha256;
    const outputSha256 = await sha256File(plan.outputPath);
    if (outputSha256 !== selfAudit.candidateSha256) {
      throw new Error("Promoted output hash differs from the self-audited candidate hash.");
    }
    const promotedAudit = await auditWorkbookPair(plan, plan.outputPath, { sourceMeta });
    result = {
      ...promotedAudit,
      status: "created",
      outputPath: plan.outputPath,
      selfAudit: "passed-before-and-after-promotion",
    };
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  if (primaryError && outputCreated) {
    const quarantinePath = path.join(
      path.dirname(plan.outputPath),
      `.codex-ledger-reorder-preserved-${crypto.randomUUID()}.tmp.xlsx`,
    );
    try {
      await fs.rename(plan.outputPath, quarantinePath);
      outputCreated = false;
      const quarantinedSha256 = await sha256File(quarantinePath);
      if (quarantinedSha256 !== createdOutputSha256) {
        cleanupErrors.push(
          `${plan.outputPath}: output changed after creation and was preserved at ${quarantinePath} (SHA256 ${quarantinedSha256})`,
        );
      } else {
        await fs.unlink(quarantinePath);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        outputCreated = false;
      } else {
        cleanupErrors.push(`${plan.outputPath}: cleanup/quarantine failed; inspect ${quarantinePath}: ${cleanError(error)}`);
      }
    }
  }
  if (tempPath) {
    try {
      await fs.unlink(tempPath);
      tempPath = undefined;
    } catch (error) {
      cleanupErrors.push(`${tempPath}: ${cleanError(error)}`);
    }
  }
  if (cleanupErrors.length > 0) {
    const prefix = primaryError ? `${cleanError(primaryError)} ` : "";
    throw new Error(`${prefix}Cleanup failed; exact paths were preserved: ${cleanupErrors.join(" | ")}`);
  }
  if (primaryError) throw primaryError;
  return result;
}

export function parseBuildCli(args) {
  if (args.length !== 2 || args[0] !== "--plan" || !args[1]) {
    throw new Error("Usage: build_ledger_reorder_candidate.mjs --plan <plan.json>");
  }
  return { planPath: args[1] };
}

export function parseGenerateCli(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--request", "--out"].includes(flag) || values[flag]) {
      throw new Error("Usage: generate_ledger_reorder_plan.mjs --request <request.json> --out <new-plan.json>");
    }
    values[flag] = value;
  }
  if (args.length !== 4 || !values["--request"] || !values["--out"]) {
    throw new Error("Usage: generate_ledger_reorder_plan.mjs --request <request.json> --out <new-plan.json>");
  }
  return { requestPath: values["--request"], outputPath: values["--out"] };
}

export function parseAuditCli(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--plan", "--candidate"].includes(flag) || values[flag]) {
      throw new Error("Usage: audit_ledger_reorder.mjs --plan <plan.json> --candidate <candidate.xlsx>");
    }
    values[flag] = value;
  }
  if (args.length !== 4 || !values["--plan"] || !values["--candidate"]) {
    throw new Error("Usage: audit_ledger_reorder.mjs --plan <plan.json> --candidate <candidate.xlsx>");
  }
  return { planPath: values["--plan"], candidatePath: values["--candidate"] };
}

export function emitResult(payload, { failure = false } = {}) {
  const stream = failure ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function failurePayload(error) {
  return { ok: false, mode: "ledger-reorder-correction", error: cleanError(error) };
}
