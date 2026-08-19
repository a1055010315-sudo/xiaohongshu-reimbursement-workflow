import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatMilliunits,
  loadProfileRegistry,
  parseMilliunits,
} from "./finance_domain.mjs";
import {
  canonicalDigest,
  mapSettledLimit,
  readStableUtf8JsonFile,
} from "./workflow_primitives.mjs";
import { readWorkbookOoxmlFacts } from "./workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "./workbook_snapshot.mjs";
import { inspectRootWorkbookTransition } from "./workbook_transition_contract.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INPUT_KEYS = new Set([
  "kind",
  "profileId",
  "baselineSha256",
  "candidateSha256",
  "reimbursementFactsCertificate",
]);
const CERTIFICATE_KEYS = new Set([
  "kind",
  "operationMode",
  "manifestFileSha256",
  "manifestDigest",
  "configDigest",
  "profileConfigDigest",
  "factsDigest",
  "factsPreimage",
  "sourceCoverageDigest",
  "sourceCoveragePreimage",
  "certificateDigest",
]);
const FACTS_PREIMAGE_KEYS = new Set([
  "batchId",
  "targetCategory",
  "transactions",
  "expectedTotals",
  "affectedProfileIds",
  "profileConfigDigest",
]);
const TRANSACTION_KEYS = new Set([
  "id",
  "date",
  "person",
  "project",
  "label",
  "amount",
  "category",
  "profileId",
  "classification",
  "sourceOrder",
  "settlement",
  "adjustment",
]);
const SETTLEMENTS = new Set(["employee_reimbursement", "company_paid_no_reimbursement"]);
const HEADERS = ["日期", "支出明细", "支出金额", "合计", "支出人", "备注"];
const PHYSICAL_FIELDS = ["date", "project", "amount", "person", "classification"];
const MANIFEST_ONLY_FIELDS = [
  "id",
  "label",
  "profileId",
  "category",
  "sourceOrder",
  "settlement",
  "adjustment",
  "sourceRefs",
];
const FIRST_DATA_ROW = 2;
const MAX_EXCEL_SERIAL = 2_958_465;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error("Workbook business audit " + message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value, field) {
  if (!isRecord(value)) fail(field + " must be an object.");
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(field + " must be an array.");
  return value;
}

function rejectUnknown(value, allowed, field) {
  for (const key of Object.keys(record(value, field))) {
    if (!allowed.has(key)) fail(field + " contains unknown field " + key + ".");
  }
}

function requireExactKeys(value, allowed, field) {
  rejectUnknown(value, allowed, field);
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail(field + " is missing " + key + ".");
  }
}

function cleanText(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || /[\r\n\t]/u.test(value)) {
    fail(field + " must be a string without tabs or newlines.");
  }
  const result = value.trim();
  if (!allowEmpty && result.length === 0) fail(field + " must be non-empty.");
  return result;
}

function sha256(value, field) {
  const result = cleanText(value, field).toLowerCase();
  if (!SHA256_RE.test(result)) fail(field + " must be a lowercase SHA-256 digest.");
  return result;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(field + " must be a positive safe integer.");
  return value;
}

function isoDate(value, field) {
  const result = cleanText(value, field);
  const match = DATE_RE.exec(result);
  if (!match) fail(field + " must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail(field + " must be a real calendar date.");
  }
  return result;
}

function canonicalAmount(value, field) {
  const parsed = parseMilliunits(value, field, { allowNegative: true });
  const formatted = formatMilliunits(parsed);
  if (formatted !== value) fail(field + " must use canonical milliunits decimal text.");
  return { text: formatted, milliunits: parsed };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sortedExactly(values, key, field) {
  const expected = [...values].sort((left, right) => key(left).localeCompare(key(right), "en"));
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== expected[index]) fail(field + " must use canonical stable order.");
  }
}

function normalizeTransaction(raw, index, registry) {
  const field = "factsPreimage.transactions[" + index + "]";
  rejectUnknown(raw, TRANSACTION_KEYS, field);
  for (const key of TRANSACTION_KEYS) {
    if (key !== "adjustment" && !Object.hasOwn(raw, key)) fail(field + " is missing " + key + ".");
  }
  const profileId = cleanText(raw.profileId, field + ".profileId");
  const profile = registry.profiles[profileId];
  if (!profile) fail(field + ".profileId is not a canonical profile id.");
  const category = cleanText(raw.category, field + ".category");
  if (category !== profile.targetCategory) fail(field + ".category does not match the fixed profile.");
  const settlement = cleanText(raw.settlement, field + ".settlement");
  if (!SETTLEMENTS.has(settlement)) fail(field + ".settlement is unsupported.");
  const normalized = {
    id: cleanText(raw.id, field + ".id"),
    date: isoDate(raw.date, field + ".date"),
    person: cleanText(raw.person, field + ".person"),
    project: cleanText(raw.project, field + ".project"),
    label: cleanText(raw.label, field + ".label"),
    ...canonicalAmount(raw.amount, field + ".amount"),
    category,
    profileId,
    classification: cleanText(raw.classification, field + ".classification"),
    sourceOrder: positiveSafeInteger(raw.sourceOrder, field + ".sourceOrder"),
    settlement,
    adjustment: null,
  };
  if (raw.adjustment !== undefined) {
    const adjustment = record(raw.adjustment, field + ".adjustment");
    requireExactKeys(
      adjustment,
      new Set(["type", "sourceTransactionId", "reason"]),
      field + ".adjustment",
    );
    const type = cleanText(adjustment.type, field + ".adjustment.type");
    if (type !== "refund" && type !== "adjustment") fail(field + ".adjustment.type is unsupported.");
    normalized.adjustment = {
      type,
      sourceTransactionId: cleanText(
        adjustment.sourceTransactionId,
        field + ".adjustment.sourceTransactionId",
      ),
      reason: cleanText(adjustment.reason, field + ".adjustment.reason"),
    };
  }
  return normalized;
}

function validateExpectedTotals(raw, transactions, targetCategory) {
  requireExactKeys(
    raw,
    new Set(["feeTotal", "realTotal", "categoryTotals"]),
    "factsPreimage.expectedTotals",
  );
  const categoryTotals = new Map();
  const realTotals = new Map();
  for (const transaction of transactions) {
    categoryTotals.set(
      transaction.category,
      (categoryTotals.get(transaction.category) ?? 0n) + transaction.milliunits,
    );
    if (transaction.settlement === "employee_reimbursement") {
      realTotals.set(
        transaction.category,
        (realTotals.get(transaction.category) ?? 0n) + transaction.milliunits,
      );
    }
  }
  const expectedFee = formatMilliunits(categoryTotals.get(targetCategory) ?? 0n);
  const expectedReal = formatMilliunits(realTotals.get(targetCategory) ?? 0n);
  if (raw.feeTotal !== expectedFee || raw.realTotal !== expectedReal) {
    fail("factsPreimage.expectedTotals does not match transaction milliunits.");
  }
  const rawCategories = record(raw.categoryTotals, "factsPreimage.expectedTotals.categoryTotals");
  const expectedCategories = Object.fromEntries(
    [...categoryTotals]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([category, total]) => [category, formatMilliunits(total)]),
  );
  if (canonicalDigest(rawCategories) !== canonicalDigest(expectedCategories)) {
    fail("factsPreimage.expectedTotals.categoryTotals does not match transactions.");
  }
  return { categoryTotals, realTotals };
}

function validateSourceCoverage(raw, transactions) {
  requireExactKeys(
    raw,
    new Set(["sourceScopes", "sourceUnits", "transactionSourceRefs"]),
    "sourceCoveragePreimage",
  );
  const scopes = array(raw.sourceScopes, "sourceCoveragePreimage.sourceScopes");
  const units = array(raw.sourceUnits, "sourceCoveragePreimage.sourceUnits");
  const transactionRefs = array(
    raw.transactionSourceRefs,
    "sourceCoveragePreimage.transactionSourceRefs",
  );
  sortedExactly(scopes, (item) => String(item.id), "sourceCoveragePreimage.sourceScopes");
  sortedExactly(units, (item) => String(item.id), "sourceCoveragePreimage.sourceUnits");
  sortedExactly(
    transactionRefs,
    (item) => String(item.transactionId),
    "sourceCoveragePreimage.transactionSourceRefs",
  );

  const scopeById = new Map();
  for (const [index, rawScope] of scopes.entries()) {
    const field = "sourceCoveragePreimage.sourceScopes[" + index + "]";
    requireExactKeys(
      rawScope,
      new Set(["id", "fileId", "fileSha256", "locator", "terminalConfirmed", "expectedUnitCount"]),
      field,
    );
    const id = cleanText(rawScope.id, field + ".id");
    if (scopeById.has(id)) fail("source coverage contains duplicate source scope " + id + ".");
    if (rawScope.terminalConfirmed !== true) fail(field + ".terminalConfirmed must be true.");
    scopeById.set(id, {
      id,
      fileId: cleanText(rawScope.fileId, field + ".fileId"),
      fileSha256: sha256(rawScope.fileSha256, field + ".fileSha256"),
      locator: cleanText(rawScope.locator, field + ".locator"),
      expectedUnitCount: positiveSafeInteger(rawScope.expectedUnitCount, field + ".expectedUnitCount"),
    });
  }

  const unitById = new Map();
  const unitCounts = new Map([...scopeById.keys()].map((id) => [id, 0]));
  for (const [index, rawUnit] of units.entries()) {
    const field = "sourceCoveragePreimage.sourceUnits[" + index + "]";
    const disposition = cleanText(rawUnit.disposition, field + ".disposition");
    const allowed = disposition === "excluded"
      ? new Set(["id", "scopeId", "locator", "disposition", "reason"])
      : new Set(["id", "scopeId", "locator", "disposition"]);
    requireExactKeys(rawUnit, allowed, field);
    if (disposition !== "used" && disposition !== "excluded") fail(field + ".disposition is unsupported.");
    const id = cleanText(rawUnit.id, field + ".id");
    if (unitById.has(id)) fail("source coverage contains duplicate source unit " + id + ".");
    const scopeId = cleanText(rawUnit.scopeId, field + ".scopeId");
    if (!scopeById.has(scopeId)) fail("source unit " + id + " references a missing scope.");
    const normalized = {
      id,
      scopeId,
      locator: cleanText(rawUnit.locator, field + ".locator"),
      disposition,
    };
    if (disposition === "excluded") normalized.reason = cleanText(rawUnit.reason, field + ".reason");
    unitById.set(id, normalized);
    unitCounts.set(scopeId, unitCounts.get(scopeId) + 1);
  }
  for (const [scopeId, count] of unitCounts) {
    if (count !== scopeById.get(scopeId).expectedUnitCount) {
      fail("source scope " + scopeId + " expectedUnitCount does not match its units.");
    }
  }

  const transactionIds = new Set(transactions.map((item) => item.id));
  const seenTransactions = new Set();
  const referenceCounts = new Map([...unitById.keys()].map((id) => [id, 0]));
  for (const [index, rawRefs] of transactionRefs.entries()) {
    const field = "sourceCoveragePreimage.transactionSourceRefs[" + index + "]";
    requireExactKeys(rawRefs, new Set(["transactionId", "sourceRefs"]), field);
    const transactionId = cleanText(rawRefs.transactionId, field + ".transactionId");
    if (!transactionIds.has(transactionId)) fail("source coverage references unknown transaction " + transactionId + ".");
    if (seenTransactions.has(transactionId)) fail("source coverage contains duplicate transaction refs.");
    seenTransactions.add(transactionId);
    const refs = array(rawRefs.sourceRefs, field + ".sourceRefs")
      .map((value, refIndex) => cleanText(value, field + ".sourceRefs[" + refIndex + "]"));
    if (refs.length === 0 || new Set(refs).size !== refs.length) {
      fail(field + ".sourceRefs must be non-empty and unique.");
    }
    const sorted = [...refs].sort((left, right) => left.localeCompare(right, "en"));
    if (canonicalDigest(refs) !== canonicalDigest(sorted)) fail(field + ".sourceRefs must be sorted.");
    for (const ref of refs) {
      const unit = unitById.get(ref);
      if (!unit) fail("transaction " + transactionId + " references missing source unit " + ref + ".");
      if (unit.disposition !== "used") fail("transaction " + transactionId + " references excluded source unit " + ref + ".");
      referenceCounts.set(ref, referenceCounts.get(ref) + 1);
    }
  }
  if (seenTransactions.size !== transactionIds.size) fail("source coverage does not bind every transaction.");
  for (const [unitId, unit] of unitById) {
    const count = referenceCounts.get(unitId);
    if (unit.disposition === "used" && count < 1) {
      fail("used source unit " + unitId + " is not referenced by any transaction.");
    }
    if (unit.disposition === "excluded" && count !== 0) {
      fail("excluded source unit " + unitId + " must not be referenced.");
    }
  }
  return {
    scopes: scopes.length,
    units: units.length,
    usedUnits: [...unitById.values()].filter((unit) => unit.disposition === "used").length,
    excludedUnits: [...unitById.values()].filter((unit) => unit.disposition === "excluded").length,
    transactionRefs: transactionRefs.reduce((count, item) => count + item.sourceRefs.length, 0),
  };
}

function validateCertificate(raw, registry) {
  requireExactKeys(raw, CERTIFICATE_KEYS, "reimbursementFactsCertificate");
  if (raw.kind !== "reimbursement-manifest-facts-v1") fail("manifest certificate kind is unsupported.");
  if (raw.operationMode !== "reimbursement-batch") fail("ordinary auditor rejects correction or legacy operations.");
  for (const field of [
    "manifestFileSha256",
    "manifestDigest",
    "configDigest",
    "profileConfigDigest",
    "factsDigest",
    "sourceCoverageDigest",
    "certificateDigest",
  ]) {
    sha256(raw[field], "reimbursementFactsCertificate." + field);
  }
  if (canonicalDigest(raw.factsPreimage) !== raw.factsDigest) {
    fail("manifest factsDigest does not match its preimage.");
  }
  if (canonicalDigest(raw.sourceCoveragePreimage) !== raw.sourceCoverageDigest) {
    fail("manifest sourceCoverageDigest does not match its preimage.");
  }
  if (
    raw.profileConfigDigest !== registry.profileConfigDigest
    || raw.factsPreimage?.profileConfigDigest !== registry.profileConfigDigest
  ) {
    fail("manifest profileConfigDigest does not match the fixed registry.");
  }

  requireExactKeys(raw.factsPreimage, FACTS_PREIMAGE_KEYS, "factsPreimage");
  const batchId = cleanText(raw.factsPreimage.batchId, "factsPreimage.batchId");
  const targetCategory = cleanText(raw.factsPreimage.targetCategory, "factsPreimage.targetCategory");
  const targetProfile = registry.profileOrder
    .map((profileId) => registry.profiles[profileId])
    .find((profile) => profile.targetCategory === targetCategory);
  if (!targetProfile) fail("factsPreimage.targetCategory is not a fixed profile category.");
  const transactions = array(raw.factsPreimage.transactions, "factsPreimage.transactions")
    .map((item, index) => normalizeTransaction(item, index, registry));
  if (transactions.length === 0) fail("factsPreimage.transactions must be non-empty.");
  sortedExactly(transactions, (item) => item.id, "factsPreimage.transactions");
  const ids = new Set();
  const sourceOrders = new Set();
  for (const transaction of transactions) {
    if (ids.has(transaction.id)) fail("factsPreimage contains duplicate transaction id " + transaction.id + ".");
    if (sourceOrders.has(transaction.sourceOrder)) fail("factsPreimage contains duplicate sourceOrder.");
    ids.add(transaction.id);
    sourceOrders.add(transaction.sourceOrder);
  }
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const refundTotalsBySource = new Map();
  for (const transaction of transactions) {
    if (!transaction.adjustment) {
      if (transaction.milliunits < 0n) {
        fail("negative reimbursement transaction must carry an adjustment binding.");
      }
      continue;
    }
    if (transaction.milliunits >= 0n) {
      fail("adjustment transaction amount must be negative.");
    }
    const source = transactionById.get(transaction.adjustment.sourceTransactionId);
    if (!source || source.id === transaction.id) {
      fail("manifest adjustment references an invalid source transaction.");
    }
    if (
      source.profileId !== transaction.profileId
      || source.category !== transaction.category
      || source.settlement !== transaction.settlement
    ) {
      fail("manifest adjustment source must have the same profile, category, and settlement.");
    }
    if (source.milliunits <= 0n) {
      fail("manifest adjustment source must have a positive amount.");
    }
    if (transaction.adjustment.type === "refund") {
      const refundAmount = -transaction.milliunits;
      refundTotalsBySource.set(
        source.id,
        (refundTotalsBySource.get(source.id) ?? 0n) + refundAmount,
      );
    }
  }
  for (const [sourceId, refundTotal] of refundTotalsBySource) {
    if (refundTotal > transactionById.get(sourceId).milliunits) {
      fail("refunds referencing transaction " + sourceId + " exceed its positive amount.");
    }
  }

  const affectedProfileIds = array(
    raw.factsPreimage.affectedProfileIds,
    "factsPreimage.affectedProfileIds",
  ).map((value, index) => cleanText(value, "factsPreimage.affectedProfileIds[" + index + "]"));
  const expectedAffected = registry.profileOrder.filter((profileId) =>
    transactions.some((transaction) => transaction.profileId === profileId),
  );
  if (canonicalDigest(affectedProfileIds) !== canonicalDigest(expectedAffected)) {
    fail("factsPreimage.affectedProfileIds does not match transactions.");
  }
  if (!transactions.some((transaction) => transaction.category === targetCategory)) {
    fail("factsPreimage targetCategory has no transaction.");
  }
  validateExpectedTotals(raw.factsPreimage.expectedTotals, transactions, targetCategory);
  const sourceCoverage = validateSourceCoverage(raw.sourceCoveragePreimage, transactions);
  const certificateBody = structuredClone(raw);
  delete certificateBody.certificateDigest;
  if (canonicalDigest(certificateBody) !== raw.certificateDigest) {
    fail("manifest certificateDigest does not match its body.");
  }
  return deepFreeze({
    certificate: raw,
    batchId,
    targetCategory,
    targetProfileId: targetProfile.profileId,
    transactions,
    affectedProfileIds,
    sourceCoverage,
  });
}

function validateCallOptions(options) {
  requireExactKeys(options, new Set(["input", "baselinePath", "candidatePath"]), "call options");
  const input = deepFreeze(structuredClone(record(options.input, "input")));
  requireExactKeys(input, INPUT_KEYS, "input");
  if (input.kind !== "root-workbook-business-audit-input-v2") fail("input kind is unsupported.");
  const baselinePath = path.resolve(cleanText(options.baselinePath, "baselinePath"));
  const candidatePath = path.resolve(cleanText(options.candidatePath, "candidatePath"));
  if (samePath(baselinePath, candidatePath)) fail("baseline and candidate paths must differ.");
  return {
    input,
    baselinePath,
    candidatePath,
    baselineSha256: sha256(input.baselineSha256, "input.baselineSha256"),
    candidateSha256: sha256(input.candidateSha256, "input.candidateSha256"),
    profileId: cleanText(input.profileId, "input.profileId"),
  };
}

function cellByColumn(row) {
  return new Map(row.cells.map((cell) => [cell.column, cell]));
}

function hasPayload(cell) {
  return Boolean(cell && (cell.value !== null || cell.formula !== null || cell.cachedValue !== null));
}

function textCell(cell, field) {
  if (!cell || cell.formula !== null || !cell.value || typeof cell.value.text !== "string") {
    fail(field + " must be a non-formula text cell.");
  }
  return cell.value.text;
}

function numericCell(cell, field) {
  if (!cell || cell.formula !== null || !cell.value || typeof cell.value.raw !== "string") {
    fail(field + " must be a non-formula numeric cell.");
  }
  if (cell.type !== "n") fail(field + " must use OOXML numeric type.");
  return cell.value.raw;
}

function excelSerialToIso(raw, field) {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)$/u.test(raw)) {
    fail(field + " must be an integer Excel 1900 serial.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXCEL_SERIAL || value === 60) {
    fail(field + " is an invalid Excel 1900 serial.");
  }
  const daysSinceUnix = value - 25_569;
  let z = daysSinceUnix + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524)
      - Math.floor(dayOfEra / 146_096)) / 365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (
    365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100)
  );
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0")
    + "-" + String(day).padStart(2, "0");
}

function managedWorksheet(facts, profile, field) {
  if (facts.workbook.date1904 !== false) fail(field + " must use the Excel 1900 date system.");
  const identities = facts.workbook.sheets.filter((sheet) => sheet.name === profile.managedRootSheetName);
  if (identities.length !== 1) {
    fail(field + " does not contain exactly one canonical managed sheet " + profile.managedRootSheetName + ".");
  }
  const identity = identities[0];
  const worksheets = facts.worksheets.filter((sheet) => sheet.partName === identity.partName);
  if (worksheets.length !== 1 || worksheets[0].name !== profile.managedRootSheetName) {
    fail(field + " managed sheet identity does not bind one worksheet Part.");
  }
  return worksheets[0];
}

function validateHeader(worksheet, field) {
  const row = worksheet.rows.find((item) => item.index === 1);
  if (!row) fail(field + " is missing the header row.");
  const cells = cellByColumn(row);
  for (let column = 1; column <= 6; column += 1) {
    if (textCell(cells.get(column), field + " header " + column) !== HEADERS[column - 1]) {
      fail(field + " header A:F does not match the approved contract.");
    }
  }
}

function mergeRangeMap(worksheet, materialStart, materialEnd, field) {
  const byColumn = new Map([[1, []], [4, []], [5, []], [6, []]]);
  for (const merge of worksheet.merges) {
    const intersectsManaged = merge.startColumn <= 6 && merge.endColumn >= 1;
    if (!intersectsManaged) continue;
    if (
      merge.startColumn !== merge.endColumn
      || !byColumn.has(merge.startColumn)
      || merge.startRow < materialStart
      || merge.endRow > materialEnd
    ) {
      fail(field + " contains an unsupported merge intersecting A:F.");
    }
    byColumn.get(merge.startColumn).push(merge);
  }
  return byColumn;
}

function createMergeCursor(merges) {
  let index = 0;
  return (row) => {
    while (index < merges.length && merges[index].endRow < row) index += 1;
    const merge = merges[index];
    return merge && merge.startRow <= row && merge.endRow >= row ? merge : null;
  };
}

function assertRangesEqual(actual, expected, field) {
  const actualRefs = actual.map((item) => item.ref).sort((left, right) => left.localeCompare(right, "en"));
  const expectedRefs = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalDigest(actualRefs) !== canonicalDigest(expectedRefs)) {
    fail(field + " merge ranges do not match independently reconstructed groups.");
  }
}

function consecutiveRuns(items, key) {
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const value = key(items[index]);
    const prior = result.at(-1);
    if (!prior || prior.key !== value) result.push({ key: value, start: index, end: index });
    else prior.end = index;
  }
  return result;
}

function parseWorkbookRecords(worksheet, field) {
  validateHeader(worksheet, field);
  const rowByIndex = new Map(worksheet.rows.map((row) => [row.index, row]));
  const materialIndexes = worksheet.rows
    .filter((row) => row.index >= FIRST_DATA_ROW)
    .filter((row) => row.cells.some((cell) => cell.column <= 6 && hasPayload(cell)))
    .map((row) => row.index);
  if (materialIndexes.length === 0) fail(field + " has no baseline material records.");
  const lastRow = Math.max(...materialIndexes);
  const materialIndexSet = new Set(materialIndexes);
  for (let row = FIRST_DATA_ROW; row <= lastRow; row += 1) {
    if (!materialIndexSet.has(row)) fail(field + " material rows must be contiguous from row 2.");
  }
  const merges = mergeRangeMap(worksheet, FIRST_DATA_ROW, lastRow, field);
  const mergeAtRow = new Map(
    [...merges].map(([column, columnMerges]) => [column, createMergeCursor(columnMerges)]),
  );
  const rows = [];
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastRow; rowNumber += 1) {
    const row = rowByIndex.get(rowNumber);
    const cells = cellByColumn(row);
    const b = cells.get(2);
    const c = cells.get(3);
    if (!hasPayload(b) || !hasPayload(c)) fail(field + " row " + rowNumber + " is missing B or C.");
    const cRaw = numericCell(c, field + " C" + rowNumber);
    const cAmount = canonicalAmount(cRaw, field + " C" + rowNumber);
    if (c.numberFormat.formatCode !== "0.000") {
      fail(field + " C" + rowNumber + " must preserve approved 0.000 numberFormat.");
    }
    const dateMerge = mergeAtRow.get(1)(rowNumber);
    const dateMasterRow = dateMerge ? dateMerge.startRow : rowNumber;
    const dateMaster = cellByColumn(rowByIndex.get(dateMasterRow)).get(1);
    if (rowNumber !== dateMasterRow && hasPayload(cells.get(1))) {
      fail(field + " merged date follower A" + rowNumber + " contains hidden content.");
    }
    const date = excelSerialToIso(
      numericCell(dateMaster, field + " A" + dateMasterRow),
      field + " A" + dateMasterRow,
    );
    const dMerge = mergeAtRow.get(4)(rowNumber);
    const eMerge = mergeAtRow.get(5)(rowNumber);
    const fMerge = mergeAtRow.get(6)(rowNumber);
    const ranges = [dMerge, eMerge, fMerge].map((merge) => (
      merge ? `${merge.startRow}:${merge.endRow}` : null
    ));
    if (!(ranges[0] === ranges[1] && ranges[1] === ranges[2])) {
      fail(field + " D/E/F merge boundaries differ at row " + rowNumber + ".");
    }
    const groupStart = dMerge ? dMerge.startRow : rowNumber;
    const groupEnd = dMerge ? dMerge.endRow : rowNumber;
    const masterCells = cellByColumn(rowByIndex.get(groupStart));
    const d = masterCells.get(4);
    if (!d) fail(field + " D" + groupStart + " must contain a direct value or SUM formula.");
    if (rowNumber !== groupStart) {
      for (const column of [4, 5, 6]) {
        if (hasPayload(cells.get(column))) {
          fail(field + " merged follower row " + rowNumber + " contains hidden D/E/F content.");
        }
      }
    }
    rows.push({
      row: rowNumber,
      date,
      project: textCell(b, field + " B" + rowNumber),
      amount: cAmount.text,
      milliunits: cAmount.milliunits,
      person: textCell(masterCells.get(5), field + " E" + groupStart),
      classification: textCell(masterCells.get(6), field + " F" + groupStart),
      style: {
        date: dateMaster.styleIndex,
        project: b.styleIndex,
        amount: c.styleIndex,
      },
      groupStart,
      groupEnd,
    });
  }

  const dateRuns = consecutiveRuns(rows, (item) => item.date);
  assertRangesEqual(
    merges.get(1),
    dateRuns.filter((run) => run.start !== run.end)
      .map((run) => "A" + (run.start + 2) + ":A" + (run.end + 2)),
    field + " date",
  );

  const groups = consecutiveRuns(rows, (item) => item.groupStart + ":" + item.groupEnd);
  for (const [groupIndex, group] of groups.entries()) {
    const startRow = group.start + 2;
    const endRow = group.end + 2;
    if (rows[group.start].groupStart !== startRow || rows[group.start].groupEnd !== endRow) {
      fail(field + " D/E/F groups are not contiguous.");
    }
    const groupRows = rows.slice(group.start, group.end + 1);
    const masterCells = cellByColumn(rowByIndex.get(startRow));
    const d = masterCells.get(4);
    if (!d || d.numberFormat.formatCode !== "0.000") {
      fail(field + " D" + startRow + " must preserve approved 0.000 numberFormat.");
    }
    const total = groupRows.reduce((sum, item) => sum + item.milliunits, 0n);
    let mode;
    if (d.formula !== null) {
      if (
        d.formula.type !== null
        || d.formula.ref !== null
        || d.formula.sharedIndex !== null
        || d.formula.text !== "SUM(C" + startRow + ":C" + endRow + ")"
      ) {
        fail(field + " D" + startRow + " formula text or range is invalid.");
      }
      if (d.cachedValue !== null) {
        const cached = canonicalAmount(d.cachedValue, field + " D" + startRow + " cached value");
        if (cached.milliunits !== total) fail(field + " D cached total differs from C milliunits.");
      }
      mode = "formula";
    } else {
      if (startRow !== endRow) fail(field + " multi-row group D must use SUM formula.");
      const direct = canonicalAmount(numericCell(d, field + " D" + startRow), field + " D" + startRow);
      if (direct.milliunits !== total) fail(field + " direct single-row D differs from C milliunits.");
      mode = "direct";
    }
    groupRows.forEach((item) => {
      item.groupIndex = groupIndex;
    });
    group.startRow = startRow;
    group.endRow = endRow;
    group.mode = mode;
    group.total = total;
    group.style = {
      total: d.styleIndex,
      person: masterCells.get(5).styleIndex,
      classification: masterCells.get(6).styleIndex,
    };
  }
  assertRangesEqual(
    merges.get(4),
    groups.filter((group) => group.startRow !== group.endRow)
      .map((group) => "D" + group.startRow + ":D" + group.endRow),
    field + " D",
  );
  assertRangesEqual(
    merges.get(5),
    groups.filter((group) => group.startRow !== group.endRow)
      .map((group) => "E" + group.startRow + ":E" + group.endRow),
    field + " E",
  );
  assertRangesEqual(
    merges.get(6),
    groups.filter((group) => group.startRow !== group.endRow)
      .map((group) => "F" + group.startRow + ":F" + group.endRow),
    field + " F",
  );
  return { rows, groups, lastRow };
}

function manifestProjection(transaction) {
  return {
    origin: "manifest",
    id: transaction.id,
    date: transaction.date,
    project: transaction.project,
    amount: transaction.text,
    milliunits: transaction.milliunits,
    person: transaction.person,
    classification: transaction.classification,
    sourceOrder: transaction.sourceOrder,
    settlement: transaction.settlement,
  };
}

function buildExpectedProjection(baseline, manifestTransactions) {
  for (let index = 1; index < baseline.rows.length; index += 1) {
    if (baseline.rows[index].date < baseline.rows[index - 1].date) {
      fail("baseline physical date order requires the isolated legacy migration path.");
    }
  }
  const expected = baseline.rows.map((item, index) => ({
    ...item,
    origin: "baseline",
    baselineOrdinal: index,
    baselineGroupIndex: item.groupIndex,
  })).concat(manifestTransactions.map(manifestProjection));
  expected.sort((left, right) => (
    left.date.localeCompare(right.date, "en")
    || (left.origin === right.origin
      ? (left.origin === "baseline"
        ? left.baselineOrdinal - right.baselineOrdinal
        : left.sourceOrder - right.sourceOrder)
      : left.origin === "baseline" ? -1 : 1)
  ));
  const baselineGroupPositions = new Map();
  for (const [position, item] of expected.entries()) {
    if (item.origin !== "baseline") continue;
    const existing = baselineGroupPositions.get(item.baselineGroupIndex);
    if (existing) {
      existing.last = position;
      existing.count += 1;
    } else {
      baselineGroupPositions.set(item.baselineGroupIndex, { first: position, last: position, count: 1 });
    }
  }
  for (const [groupIndex] of baseline.groups.entries()) {
    const positions = baselineGroupPositions.get(groupIndex);
    if (!positions || positions.last - positions.first + 1 !== positions.count) {
      fail("baseline atomic D/E/F group would be split by global date projection.");
    }
  }
  return expected;
}

function expectedExpenseGroups(expected) {
  const result = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = expected[index];
    const prior = result.at(-1);
    const key = item.origin === "baseline"
      ? "baseline:" + item.baselineGroupIndex
      : "manifest:" + JSON.stringify([item.person, item.classification, item.settlement]);
    if (!prior || prior.key !== key || prior.origin !== item.origin) {
      result.push({ key, origin: item.origin, start: index, end: index, items: [item] });
    } else {
      prior.end = index;
      prior.items.push(item);
    }
  }
  return result;
}

function compareProjection(expected, candidate, baseline) {
  if (candidate.rows.length !== expected.length) {
    fail("candidate is missing a baseline physical record or a manifest transaction.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const actual = candidate.rows[index];
    for (const field of PHYSICAL_FIELDS) {
      if (actual[field] !== wanted[field]) {
        const origin = wanted.origin === "baseline" ? "baseline physical" : "manifest";
        fail("candidate " + origin + " record at row " + actual.row + " changed " + field + "; baseline physical order or facts differ.");
      }
    }
    if (wanted.origin === "baseline") {
      if (
        actual.style.date !== wanted.style.date
        ||
        actual.style.project !== wanted.style.project
        || actual.style.amount !== wanted.style.amount
      ) {
        fail("candidate baseline physical record style changed.");
      }
    }
  }
  const roleStyles = {
    date: new Set(baseline.rows.map((item) => item.style.date)),
    project: new Set(baseline.rows.map((item) => item.style.project)),
    amount: new Set(baseline.rows.map((item) => item.style.amount)),
    total: new Set(baseline.groups.map((item) => item.style.total)),
    person: new Set(baseline.groups.map((item) => item.style.person)),
    classification: new Set(baseline.groups.map((item) => item.style.classification)),
  };
  for (const [index, actual] of candidate.rows.entries()) {
    if (expected[index].origin !== "manifest") continue;
    for (const role of ["date", "project", "amount"]) {
      if (!roleStyles[role].has(actual.style[role])) {
        fail("candidate manifest record does not reuse the baseline " + role + " style role.");
      }
    }
  }

  const expectedGroups = expectedExpenseGroups(expected);
  if (candidate.groups.length !== expectedGroups.length) {
    fail("candidate D/E/F merge groups cross baseline and manifest boundaries.");
  }
  for (let index = 0; index < expectedGroups.length; index += 1) {
    const wanted = expectedGroups[index];
    const actual = candidate.groups[index];
    if (actual.start !== wanted.start || actual.end !== wanted.end) {
      fail("candidate D/E/F merge group boundaries differ from the independent projection.");
    }
    if (wanted.origin === "manifest" && actual.mode !== "formula") {
      fail("candidate manifest single-row D must use canonical SUM formula.");
    }
    if (wanted.origin === "baseline") {
      const baselineGroup = baseline.groups[wanted.items[0].baselineGroupIndex];
      if (actual.mode !== baselineGroup.mode) {
        fail("candidate baseline single-row D representation changed.");
      }
      if (
        actual.style.total !== baselineGroup.style.total
        || actual.style.person !== baselineGroup.style.person
        || actual.style.classification !== baselineGroup.style.classification
      ) {
        fail("candidate baseline D/E/F group style changed.");
      }
    } else {
      for (const role of ["total", "person", "classification"]) {
        if (!roleStyles[role].has(actual.style[role])) {
          fail("candidate manifest group does not reuse baseline " + role + " style role.");
        }
      }
    }
  }
}

async function stableFacts(filePath, expectedSha256, field) {
  const snapshot = await readStableFileSnapshot(filePath);
  if (snapshot.sha256 !== expectedSha256) fail(field + " SHA-256 does not match the audit input.");
  const facts = await readWorkbookOoxmlFacts(snapshot);
  return { snapshot, facts };
}

export async function auditLedgerLayout(options) {
  const checked = validateCallOptions(options);
  const registry = await loadProfileRegistry();
  const profile = registry.profiles[checked.profileId];
  if (!profile || profile.profileId !== checked.profileId) {
    fail("input.profileId must be an exact canonical profile id.");
  }
  const manifest = validateCertificate(
    checked.input.reimbursementFactsCertificate,
    registry,
  );
  if (!manifest.affectedProfileIds.includes(profile.profileId)) {
    fail("selected profile is not affected and must not generate an empty audit certificate.");
  }
  const selectedTransactions = manifest.transactions.filter(
    (transaction) => transaction.profileId === profile.profileId,
  );
  if (selectedTransactions.length === 0) {
    fail("selected profile is not affected and must not generate an empty audit certificate.");
  }

  const settledFiles = await mapSettledLimit([
    {
      path: checked.baselinePath,
      sha256: checked.baselineSha256,
      field: "baseline workbook",
    },
    {
      path: checked.candidatePath,
      sha256: checked.candidateSha256,
      field: "candidate workbook",
    },
  ], 2, (item) => stableFacts(item.path, item.sha256, item.field));
  const [baselineFile, candidateFile] = settledFiles.settled.map((entry) => entry.value);

  const baselineSheet = managedWorksheet(baselineFile.facts, profile, "baseline workbook");
  const candidateSheet = managedWorksheet(candidateFile.facts, profile, "candidate workbook");
  const baseline = parseWorkbookRecords(baselineSheet, "baseline workbook");
  const candidate = parseWorkbookRecords(candidateSheet, "candidate workbook");
  const expected = buildExpectedProjection(baseline, selectedTransactions);
  compareProjection(expected, candidate, baseline);
  if (candidate.rows.length <= baseline.rows.length) {
    fail("ordinary reimbursement candidate contains no actual profile addition.");
  }

  const scopeEnd = Math.max(baseline.lastRow, candidate.lastRow);
  const transition = inspectRootWorkbookTransition({
    baselineFacts: baselineFile.facts,
    candidateFacts: candidateFile.facts,
    managedSheetName: profile.managedRootSheetName,
    startRow: FIRST_DATA_ROW,
    endRow: scopeEnd,
  });
  const baselineTotal = baseline.rows.reduce((sum, item) => sum + item.milliunits, 0n);
  const candidateTotal = candidate.rows.reduce((sum, item) => sum + item.milliunits, 0n);
  const manifestTotal = selectedTransactions.reduce((sum, item) => sum + item.milliunits, 0n);
  if (candidateTotal !== baselineTotal + manifestTotal) {
    fail("candidate C milliunits total does not equal baseline plus selected manifest transactions.");
  }
  const projectionForDigest = expected.map((item) => ({
    origin: item.origin,
    date: item.date,
    project: item.project,
    amount: item.amount,
    person: item.person,
    classification: item.classification,
  }));
  const manifestRowRanges = [];
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].origin !== "manifest") continue;
    const row = index + FIRST_DATA_ROW;
    const prior = manifestRowRanges.at(-1);
    if (prior && prior.endRow + 1 === row) prior.endRow = row;
    else manifestRowRanges.push({ startRow: row, endRow: row });
  }
  const body = {
    kind: "root-workbook-business-audit-v1",
    requiresGate1Binding: true,
    profile: {
      profileId: profile.profileId,
      targetCategory: profile.targetCategory,
      canonicalRootWorkbookName: profile.canonicalRootWorkbookName,
      managedRootSheetName: profile.managedRootSheetName,
    },
    manifest: {
      certificateDigest: manifest.certificate.certificateDigest,
      factsDigest: manifest.certificate.factsDigest,
      sourceCoverageDigest: manifest.certificate.sourceCoverageDigest,
      profileConfigDigest: manifest.certificate.profileConfigDigest,
      batchId: manifest.batchId,
    },
    baseline: {
      sourceSize: baselineFile.facts.source.size,
      sourceSha256: baselineFile.facts.source.sha256,
      factsDigest: baselineFile.facts.factsDigest,
      recordCount: baseline.rows.length,
      amount: formatMilliunits(baselineTotal),
    },
    candidate: {
      sourceSize: candidateFile.facts.source.size,
      sourceSha256: candidateFile.facts.source.sha256,
      factsDigest: candidateFile.facts.factsDigest,
      recordCount: candidate.rows.length,
      amount: formatMilliunits(candidateTotal),
    },
    transitionDigest: transition.transitionDigest,
    sourceCoverage: manifest.sourceCoverage,
    projection: {
      baselineRecordCount: baseline.rows.length,
      manifestRecordCount: selectedTransactions.length,
      manifestRowRanges,
      transactionCount: candidate.rows.length,
      startRow: FIRST_DATA_ROW,
      endRow: candidate.lastRow,
      amount: formatMilliunits(candidateTotal),
      physicalFields: PHYSICAL_FIELDS,
      manifestOnlyFields: MANIFEST_ONLY_FIELDS,
      formulaCachePolicy: "optional-consistency-check",
      projectionDigest: canonicalDigest(projectionForDigest),
    },
  };
  return deepFreeze({ ...body, auditDigest: canonicalDigest(body) });
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 6
    || args[0] !== "--input"
    || args[2] !== "--baseline"
    || args[4] !== "--candidate"
  ) {
    fail("usage: audit_ledger_layout.mjs --input <json> --baseline <xlsx> --candidate <xlsx>.");
  }
  const inputSnapshot = await readStableUtf8JsonFile(path.resolve(args[1]), {
    maxBytes: MAX_INPUT_BYTES,
  });
  const result = await auditLedgerLayout({
    input: inputSnapshot.value,
    baselinePath: path.resolve(args[3]),
    candidatePath: path.resolve(args[5]),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  });
}
