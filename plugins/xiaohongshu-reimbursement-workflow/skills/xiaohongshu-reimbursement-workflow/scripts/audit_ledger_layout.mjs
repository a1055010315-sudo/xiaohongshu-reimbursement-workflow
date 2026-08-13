import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCALE = 1000n;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SETTLEMENTS = new Set(["employee_reimbursement", "company_paid_no_reimbursement"]);
const ORIGINS = new Set(["baseline", "manifest"]);
const BUSINESS_FIELDS = ["date", "project", "amount", "person", "classification", "rowType", "settlement"];
const CORRECTION_FIELDS = [
  "patchId",
  "transactionId",
  "sequence",
  "authorizedFields",
  "before",
  "after",
  "evidenceSourceId",
  "supersededCandidate",
];

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function rejectUnknownFields(value, allowedFields, field) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${field} has unknown fields: ${unknown.join(", ")}.`);
}

function text(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a string without tabs or newlines.`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) throw new Error(`${field} must be non-empty.`);
  return result;
}

function sha(value, field) {
  const result = text(value, field).toLowerCase();
  if (!SHA256_RE.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function date(value, field) {
  const result = text(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(result);
  if (!match) throw new Error(`${field} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new Error(`${field} must be a real calendar date.`);
  }
  return result;
}

function amount(value, field) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u.test(value)) {
    throw new Error(`${field} must be a decimal string with at most three decimal places.`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const milli = BigInt(whole) * SCALE + BigInt((fraction + "000").slice(0, 3));
  if (negative && milli === 0n) throw new Error(`${field} must not use negative zero.`);
  return negative ? -milli : milli;
}

function renderAmount(milli) {
  const negative = milli < 0n;
  const absolute = negative ? -milli : milli;
  const whole = absolute / SCALE;
  const fraction = absolute % SCALE;
  const rendered = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/u, "")}`;
  return negative ? `-${rendered}` : rendered;
}

function displayDecimals(value) {
  const milli = amount(value, "amount");
  if (milli % SCALE === 0n) return 0;
  const fraction = (value.startsWith("-") ? value.slice(1) : value).split(".")[1] ?? "";
  return fraction.length === 3 ? 3 : 2;
}

function normalizeBusiness(raw, field) {
  object(raw, field);
  const settlement = text(raw.settlement, `${field}.settlement`);
  if (!SETTLEMENTS.has(settlement)) throw new Error(`${field}.settlement is unsupported.`);
  const amountText = text(raw.amount, `${field}.amount`);
  return {
    date: date(raw.date, `${field}.date`),
    project: text(raw.project, `${field}.project`),
    amount: renderAmount(amount(amountText, `${field}.amount`)),
    person: text(raw.person, `${field}.person`, { allowEmpty: true }),
    classification: text(raw.classification, `${field}.classification`, { allowEmpty: true }),
    rowType: text(raw.rowType, `${field}.rowType`, { allowEmpty: true }),
    settlement,
  };
}

function normalizeExpected(raw, index) {
  object(raw, `expectedRecords[${index}]`);
  const id = text(raw.id, `expectedRecords[${index}].id`);
  if (!Number.isSafeInteger(raw.sourceOrder) || raw.sourceOrder < 1) {
    throw new Error(`expectedRecords[${index}].sourceOrder must be a positive safe integer.`);
  }
  const origin = text(raw.origin, `expectedRecords[${index}].origin`);
  if (!ORIGINS.has(origin)) throw new Error(`expectedRecords[${index}].origin is unsupported.`);
  if (!Array.isArray(raw.sourceIds)) throw new Error(`expectedRecords[${index}].sourceIds must be an array.`);
  const sourceIds = raw.sourceIds.map((value, sourceIndex) =>
    text(value, `expectedRecords[${index}].sourceIds[${sourceIndex}]`),
  );
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`expectedRecords[${index}].sourceIds contains duplicates.`);
  }
  if (origin === "manifest" && sourceIds.length === 0) {
    throw new Error(`expectedRecords[${index}] from manifest must bind at least one source.`);
  }
  const business = normalizeBusiness(raw, `expectedRecords[${index}]`);
  return {
    id,
    sourceOrder: raw.sourceOrder,
    origin,
    sourceIds,
    ...business,
    amountMilli: amount(business.amount, `expectedRecords[${index}].amount`),
    displayDecimals: displayDecimals(raw.amount),
  };
}

function normalizeActual(raw, index, startRow) {
  object(raw, `actualRows[${index}]`);
  const expectedRow = startRow + index;
  if (raw.row !== expectedRow) throw new Error(`actualRows[${index}].row must be ${expectedRow}.`);
  const business = normalizeBusiness(raw, `actualRows[${index}]`);
  for (const field of ["cDisplayDecimals", "dDisplayDecimals"]) {
    if (![0, 2, 3].includes(raw[field])) throw new Error(`actualRows[${index}].${field} must be 0, 2, or 3.`);
  }
  const dFormula = raw.dFormula === null || raw.dFormula === undefined || raw.dFormula === ""
    ? null
    : text(raw.dFormula, `actualRows[${index}].dFormula`);
  const dValue = raw.dValue === null || raw.dValue === undefined || raw.dValue === ""
    ? null
    : renderAmount(amount(text(raw.dValue, `actualRows[${index}].dValue`), `actualRows[${index}].dValue`));
  return {
    row: expectedRow,
    ...business,
    amountMilli: amount(business.amount, `actualRows[${index}].amount`),
    cDisplayDecimals: raw.cDisplayDecimals,
    dDisplayDecimals: raw.dDisplayDecimals,
    dFormula,
    dValue,
  };
}

function groupKey(record) {
  const values = [record.person, record.classification, record.rowType, record.settlement];
  return values.every(Boolean) ? JSON.stringify(values) : `singleton:${record.id}`;
}

function groups(records, keyFor) {
  const result = [];
  for (const record of records) {
    const key = keyFor(record);
    const current = result.at(-1);
    if (!current || current.key !== key) result.push({ key, records: [record] });
    else current.records.push(record);
  }
  return result;
}

function range(column, startRow, endRow) {
  return startRow === endRow ? null : `${column}${startRow}:${column}${endRow}`;
}

function normalizeCoverage(rawCoverage, records) {
  if (!Array.isArray(rawCoverage) || rawCoverage.length === 0) {
    throw new Error("sourceCoverage must be a non-empty array.");
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const result = new Map();
  rawCoverage.forEach((raw, index) => {
    object(raw, `sourceCoverage[${index}]`);
    const sourceId = text(raw.sourceId, `sourceCoverage[${index}].sourceId`);
    if (result.has(sourceId)) throw new Error(`Duplicate source coverage: ${sourceId}`);
    const disposition = text(raw.disposition, `sourceCoverage[${index}].disposition`);
    if (disposition === "transaction") {
      if (!Array.isArray(raw.transactionIds) || raw.transactionIds.length === 0) {
        throw new Error(`sourceCoverage[${index}].transactionIds must be non-empty.`);
      }
      const transactionIds = raw.transactionIds.map((value, idIndex) =>
        text(value, `sourceCoverage[${index}].transactionIds[${idIndex}]`),
      );
      if (new Set(transactionIds).size !== transactionIds.length) {
        throw new Error(`sourceCoverage[${index}].transactionIds contains duplicates.`);
      }
      for (const transactionId of transactionIds) {
        const record = byId.get(transactionId);
        if (!record) throw new Error(`Source ${sourceId} references unknown transaction ${transactionId}.`);
        if (!record.sourceIds.includes(sourceId)) {
          throw new Error(`Transaction ${transactionId} does not bind source ${sourceId}.`);
        }
      }
      result.set(sourceId, { disposition, transactionIds });
      return;
    }
    if (disposition === "already_in_baseline") {
      result.set(sourceId, {
        disposition,
        baselineRecordFingerprint: sha(
          raw.baselineRecordFingerprint,
          `sourceCoverage[${index}].baselineRecordFingerprint`,
        ),
      });
      return;
    }
    if (disposition === "excluded_non_target") {
      result.set(sourceId, {
        disposition,
        reason: text(raw.reason, `sourceCoverage[${index}].reason`),
      });
      return;
    }
    throw new Error(`sourceCoverage[${index}].disposition is unsupported.`);
  });
  for (const record of records) {
    for (const sourceId of record.sourceIds) {
      const coverage = result.get(sourceId);
      if (!coverage || coverage.disposition !== "transaction" || !coverage.transactionIds.includes(record.id)) {
        throw new Error(`Transaction ${record.id} lacks transaction coverage for source ${sourceId}.`);
      }
    }
  }
  return result;
}

function equalBusiness(left, right) {
  return BUSINESS_FIELDS.every((field) => left[field] === right[field]);
}

function changedBusinessFields(before, after) {
  return BUSINESS_FIELDS.filter((field) => before[field] !== after[field]);
}

function normalizeSupersededCandidate(raw, field) {
  object(raw, field);
  rejectUnknownFields(raw, ["path", "sha256"], field);
  const candidatePath = text(raw.path, `${field}.path`);
  if (!path.isAbsolute(candidatePath)) throw new Error(`${field}.path must be absolute.`);
  return {
    path: path.normalize(candidatePath),
    sha256: sha(raw.sha256, `${field}.sha256`),
  };
}

function auditCorrections(rawCorrections, recordsById, coverage) {
  if (rawCorrections === undefined) return { correctionCount: 0, supersededCandidates: [] };
  if (!Array.isArray(rawCorrections)) throw new Error("corrections must be an array.");
  const patchIds = new Set();
  const byTransaction = new Map();
  const supersededByPath = new Map();
  for (const [index, raw] of rawCorrections.entries()) {
    object(raw, `corrections[${index}]`);
    rejectUnknownFields(raw, CORRECTION_FIELDS, `corrections[${index}]`);
    const patchId = text(raw.patchId, `corrections[${index}].patchId`);
    if (patchIds.has(patchId)) throw new Error(`Duplicate correction patch id: ${patchId}`);
    patchIds.add(patchId);
    const transactionId = text(raw.transactionId, `corrections[${index}].transactionId`);
    if (!recordsById.has(transactionId)) throw new Error(`Correction ${patchId} targets an unknown transaction.`);
    if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
      throw new Error(`corrections[${index}].sequence must be a positive safe integer.`);
    }
    if (!Array.isArray(raw.authorizedFields) || raw.authorizedFields.length === 0) {
      throw new Error(`corrections[${index}].authorizedFields must be non-empty.`);
    }
    const authorizedFields = raw.authorizedFields.map((value, fieldIndex) =>
      text(value, `corrections[${index}].authorizedFields[${fieldIndex}]`),
    );
    if (new Set(authorizedFields).size !== authorizedFields.length ||
        authorizedFields.some((field) => !BUSINESS_FIELDS.includes(field))) {
      throw new Error(`Correction ${patchId} has invalid or duplicate authorized fields.`);
    }
    object(raw.before, `corrections[${index}].before`);
    rejectUnknownFields(raw.before, BUSINESS_FIELDS, `corrections[${index}].before`);
    object(raw.after, `corrections[${index}].after`);
    rejectUnknownFields(raw.after, BUSINESS_FIELDS, `corrections[${index}].after`);
    const before = normalizeBusiness(raw.before, `corrections[${index}].before`);
    const after = normalizeBusiness(raw.after, `corrections[${index}].after`);
    const changed = changedBusinessFields(before, after).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...authorizedFields].sort())) {
      throw new Error(`Correction ${patchId} changed fields do not equal authorizedFields.`);
    }
    const evidenceSourceId = text(raw.evidenceSourceId, `corrections[${index}].evidenceSourceId`);
    const source = coverage.get(evidenceSourceId);
    if (!source || source.disposition !== "transaction" || !source.transactionIds.includes(transactionId)) {
      throw new Error(`Correction ${patchId} is not bound to transaction evidence.`);
    }
    const supersededCandidate = normalizeSupersededCandidate(
      raw.supersededCandidate,
      `corrections[${index}].supersededCandidate`,
    );
    const priorSha256 = supersededByPath.get(supersededCandidate.path);
    if (priorSha256 && priorSha256 !== supersededCandidate.sha256) {
      throw new Error(`Superseded candidate ${supersededCandidate.path} has conflicting SHA-256 digests.`);
    }
    supersededByPath.set(supersededCandidate.path, supersededCandidate.sha256);
    const list = byTransaction.get(transactionId) ?? [];
    list.push({ patchId, sequence: raw.sequence, before, after, supersededCandidate });
    byTransaction.set(transactionId, list);
  }
  for (const [transactionId, patches] of byTransaction) {
    patches.sort((left, right) => left.sequence - right.sequence);
    if (new Set(patches.map((patch) => patch.sequence)).size !== patches.length) {
      throw new Error(`Transaction ${transactionId} has duplicate correction sequence values.`);
    }
    for (let index = 1; index < patches.length; index += 1) {
      if (!equalBusiness(patches[index - 1].after, patches[index].before)) {
        throw new Error(`Transaction ${transactionId} correction chain is discontinuous.`);
      }
    }
    const expected = recordsById.get(transactionId);
    if (!equalBusiness(patches.at(-1).after, expected)) {
      throw new Error(`Transaction ${transactionId} final correction does not match expected record.`);
    }
  }
  return {
    correctionCount: rawCorrections.length,
    supersededCandidates: [...supersededByPath].map(([candidatePath, sha256]) => ({
      path: candidatePath,
      sha256,
    })),
  };
}

function auditLedgerLayoutDetailed(raw) {
  object(raw, "input");
  if (raw.version !== 1) throw new Error("Input version must be 1.");
  const baselineSha256 = sha(raw.baselineSha256, "baselineSha256");
  const rebuildBaseSha256 = sha(raw.rebuildBaseSha256, "rebuildBaseSha256");
  if (baselineSha256 !== rebuildBaseSha256) {
    throw new Error("Each candidate revision must rebuild from the bound baseline, not the superseded candidate.");
  }
  const candidateSha256 = sha(raw.candidateSha256, "candidateSha256");
  if (!Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) {
    throw new Error("candidateRevision must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(raw.startRow) || raw.startRow < 1) {
    throw new Error("startRow must be a positive safe integer.");
  }
  if (!Array.isArray(raw.expectedRecords) || raw.expectedRecords.length === 0) {
    throw new Error("expectedRecords must be non-empty.");
  }
  if (!Array.isArray(raw.actualRows) || raw.actualRows.length !== raw.expectedRecords.length) {
    throw new Error("actualRows must have exactly one row per expected record.");
  }
  const expected = raw.expectedRecords.map(normalizeExpected);
  const ids = new Set();
  const sourceOrders = new Set();
  for (const record of expected) {
    if (ids.has(record.id)) throw new Error(`Duplicate expected record id: ${record.id}`);
    if (sourceOrders.has(record.sourceOrder)) throw new Error(`Duplicate expected sourceOrder: ${record.sourceOrder}`);
    ids.add(record.id);
    sourceOrders.add(record.sourceOrder);
  }
  const coverage = normalizeCoverage(raw.sourceCoverage, expected);
  const recordsById = new Map(expected.map((record) => [record.id, record]));
  const { correctionCount, supersededCandidates } = auditCorrections(raw.corrections, recordsById, coverage);
  const sorted = [...expected].sort((left, right) =>
    left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder,
  );
  const actual = raw.actualRows.map((row, index) => normalizeActual(row, index, raw.startRow));
  for (let index = 0; index < sorted.length; index += 1) {
    if (!equalBusiness(sorted[index], actual[index])) {
      throw new Error(`Actual row ${actual[index].row} does not match date + sourceOrder stable projection.`);
    }
    if (actual[index].cDisplayDecimals !== sorted[index].displayDecimals) {
      throw new Error(`Actual row ${actual[index].row} has incorrect C display precision.`);
    }
    sorted[index].row = actual[index].row;
  }
  const expenseGroups = groups(sorted, groupKey);
  const dateGroups = groups(sorted, (record) => record.date);
  const expectedMerges = [];
  for (const group of dateGroups) {
    const merged = range("A", group.records[0].row, group.records.at(-1).row);
    if (merged) expectedMerges.push(merged);
  }
  for (const group of expenseGroups) {
    const startRow = group.records[0].row;
    const endRow = group.records.at(-1).row;
    const firstIndex = startRow - raw.startRow;
    const total = group.records.reduce((sum, record) => sum + record.amountMilli, 0n);
    const precision = Math.max(...group.records.map((record) => record.displayDecimals));
    const expectedFormula = `=SUM(C${startRow}:C${endRow})`;
    if (actual[firstIndex].dDisplayDecimals !== precision) {
      throw new Error(`Actual row ${startRow} has incorrect D display precision.`);
    }
    if (startRow === endRow) {
      const formulaAllowed = actual[firstIndex].dFormula === `=C${startRow}` ||
        actual[firstIndex].dFormula === expectedFormula;
      const valueAllowed = actual[firstIndex].dFormula === null && actual[firstIndex].dValue === renderAmount(total);
      if (!formulaAllowed && !valueAllowed) throw new Error(`Single-row expense group at ${startRow} has an invalid D value.`);
    } else {
      if (actual[firstIndex].dFormula !== expectedFormula) {
        throw new Error(`Expense group ${startRow}:${endRow} has an incorrect D formula.`);
      }
      for (const column of ["D", "E", "F"]) expectedMerges.push(`${column}${startRow}:${column}${endRow}`);
      for (let row = startRow + 1; row <= endRow; row += 1) {
        const follower = actual[row - raw.startRow];
        if (follower.dFormula !== null || follower.dValue !== null) {
          throw new Error(`Merged follower D${row} contains hidden content.`);
        }
      }
    }
  }
  if (!Array.isArray(raw.actualMerges)) throw new Error("actualMerges must be an array.");
  const actualMerges = raw.actualMerges.map((value, index) => text(value, `actualMerges[${index}]`)).sort();
  if (new Set(actualMerges).size !== actualMerges.length) throw new Error("actualMerges contains duplicates.");
  const expectedSortedMerges = expectedMerges.sort();
  if (JSON.stringify(actualMerges) !== JSON.stringify(expectedSortedMerges)) {
    throw new Error("A merges or D/E/F expense-group merges do not match independently derived boundaries.");
  }
  const expectedTotal = sorted.reduce((sum, record) => sum + record.amountMilli, 0n);
  const actualTotal = actual.reduce((sum, record) => sum + record.amountMilli, 0n);
  if (expectedTotal !== actualTotal) throw new Error("Expected and actual transaction amounts differ.");
  return {
    report: {
      ok: true,
      baselineSha256,
      candidateSha256,
      candidateRevision: raw.candidateRevision,
      transactionCount: sorted.length,
      amount: renderAmount(expectedTotal),
      expenseGroupCount: expenseGroups.length,
      multiExpenseGroupCount: expenseGroups.filter((group) => group.records.length > 1).length,
      mergeCount: expectedMerges.length,
      sourceCount: coverage.size,
      correctionCount,
      supersededCandidateCount: supersededCandidates.length,
    },
    supersededCandidates,
  };
}

export function auditLedgerLayout(raw) {
  return auditLedgerLayoutDetailed(raw).report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--input" || args[2] !== "--baseline" || args[4] !== "--candidate") {
    throw new Error(
      "Usage: audit_ledger_layout.mjs --input <audit-package.json> --baseline <baseline.xlsx> --candidate <candidate.xlsx>",
    );
  }
  const bytes = await fs.readFile(path.resolve(args[1]));
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""));
  const fileSha256 = async (filePath) =>
    crypto.createHash("sha256").update(await fs.readFile(path.resolve(filePath))).digest("hex");
  const baselineFileSha256 = await fileSha256(args[3]);
  const candidateFileSha256 = await fileSha256(args[5]);
  if (baselineFileSha256 !== String(raw.baselineSha256).toLowerCase()) {
    throw new Error("The baseline file SHA-256 does not match the audit package.");
  }
  if (candidateFileSha256 !== String(raw.candidateSha256).toLowerCase()) {
    throw new Error("The candidate file SHA-256 does not match the audit package.");
  }
  const { report, supersededCandidates } = auditLedgerLayoutDetailed(raw);
  for (const supersededCandidate of supersededCandidates) {
    let actualSha256;
    try {
      actualSha256 = await fileSha256(supersededCandidate.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read superseded candidate ${supersededCandidate.path}: ${detail}`);
    }
    if (actualSha256 !== supersededCandidate.sha256) {
      throw new Error(`Superseded candidate file SHA-256 does not match: ${supersededCandidate.path}`);
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
