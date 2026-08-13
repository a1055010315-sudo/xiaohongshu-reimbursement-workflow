import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCALE = 1000n;
const SETTLEMENTS = new Set(["employee_reimbursement", "company_paid_no_reimbursement"]);

function cleanString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a string without tabs or newlines.`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) throw new Error(`${field} must be non-empty.`);
  return result;
}

function cleanDate(value, field) {
  const result = cleanString(value, field);
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

function parseAmount(value, field) {
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

function formatAmount(milli) {
  const negative = milli < 0n;
  const absolute = negative ? -milli : milli;
  const whole = absolute / SCALE;
  const fraction = absolute % SCALE;
  const rendered = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/u, "")}`;
  return negative ? `-${rendered}` : rendered;
}

export function displayDecimalsForAmount(value) {
  parseAmount(value, "amount");
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const fraction = unsigned.split(".")[1] ?? "";
  if (!fraction || /^0+$/u.test(fraction)) return 0;
  return fraction.length === 3 ? 3 : 2;
}

function normalizeRecord(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`records[${index}] must be an object.`);
  }
  const id = cleanString(raw.id, `records[${index}].id`);
  if (!Number.isSafeInteger(raw.sourceOrder) || raw.sourceOrder < 1) {
    throw new Error(`records[${index}].sourceOrder must be a positive safe integer.`);
  }
  const amount = cleanString(raw.amount, `records[${index}].amount`);
  const amountMilli = parseAmount(amount, `records[${index}].amount`);
  const settlement = cleanString(raw.settlement, `records[${index}].settlement`);
  if (!SETTLEMENTS.has(settlement)) {
    throw new Error(`records[${index}].settlement is unsupported.`);
  }
  const origin = cleanString(raw.origin, `records[${index}].origin`);
  if (!new Set(["baseline", "manifest"]).has(origin)) {
    throw new Error(`records[${index}].origin must be baseline or manifest.`);
  }
  const sourceIds = raw.sourceIds ?? [];
  if (!Array.isArray(sourceIds)) throw new Error(`records[${index}].sourceIds must be an array.`);
  const normalizedSourceIds = sourceIds.map((item, sourceIndex) =>
    cleanString(item, `records[${index}].sourceIds[${sourceIndex}]`),
  );
  if (new Set(normalizedSourceIds).size !== normalizedSourceIds.length) {
    throw new Error(`records[${index}].sourceIds contains duplicates.`);
  }
  if (origin === "manifest" && normalizedSourceIds.length === 0) {
    throw new Error(`records[${index}] from manifest must bind at least one source.`);
  }
  return {
    id,
    sourceOrder: raw.sourceOrder,
    date: cleanDate(raw.date, `records[${index}].date`),
    project: cleanString(raw.project, `records[${index}].project`),
    amount,
    amountMilli,
    person: cleanString(raw.person, `records[${index}].person`, { allowEmpty: true }),
    classification: cleanString(
      raw.classification,
      `records[${index}].classification`,
      { allowEmpty: true },
    ),
    rowType: cleanString(raw.rowType, `records[${index}].rowType`, { allowEmpty: true }),
    settlement,
    origin,
    sourceIds: normalizedSourceIds,
    displayDecimals: displayDecimalsForAmount(amount),
  };
}

function expenseKey(record) {
  const parts = [record.person, record.classification, record.rowType, record.settlement];
  return parts.every(Boolean) ? JSON.stringify(parts) : `singleton:${record.id}`;
}

function consecutiveGroups(records, keyFor) {
  const groups = [];
  for (const record of records) {
    const key = keyFor(record);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({ key, records: [record] });
    } else {
      current.records.push(record);
    }
  }
  return groups;
}

function mergeRange(column, startRow, endRow) {
  return startRow === endRow ? null : `${column}${startRow}:${column}${endRow}`;
}

export function deriveLedgerLayout(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Input must be an object.");
  if (raw.version !== 1) throw new Error("Input version must be 1.");
  if (!Number.isSafeInteger(raw.startRow) || raw.startRow < 1) {
    throw new Error("startRow must be a positive safe integer.");
  }
  if (!Array.isArray(raw.records) || raw.records.length === 0) {
    throw new Error("records must be a non-empty array.");
  }
  const records = raw.records.map(normalizeRecord);
  const ids = new Set();
  const sourceOrders = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate record id: ${record.id}`);
    if (sourceOrders.has(record.sourceOrder)) throw new Error(`Duplicate sourceOrder: ${record.sourceOrder}`);
    ids.add(record.id);
    sourceOrders.add(record.sourceOrder);
  }
  const sorted = [...records].sort((left, right) =>
    left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder,
  );
  const rows = sorted.map((record, index) => ({
    ...record,
    row: raw.startRow + index,
  }));
  const expenseGroups = consecutiveGroups(rows, expenseKey).map((group) => {
    const startRow = group.records[0].row;
    const endRow = group.records.at(-1).row;
    const totalMilli = group.records.reduce((sum, record) => sum + record.amountMilli, 0n);
    const displayDecimals = Math.max(...group.records.map((record) => record.displayDecimals));
    return {
      startRow,
      endRow,
      recordIds: group.records.map((record) => record.id),
      total: formatAmount(totalMilli),
      displayDecimals,
      formula: `=SUM(C${startRow}:C${endRow})`,
      mergeRanges: ["D", "E", "F"]
        .map((column) => mergeRange(column, startRow, endRow))
        .filter(Boolean),
    };
  });
  const dateGroups = consecutiveGroups(rows, (record) => record.date).map((group) => {
    const startRow = group.records[0].row;
    const endRow = group.records.at(-1).row;
    return {
      date: group.records[0].date,
      startRow,
      endRow,
      recordIds: group.records.map((record) => record.id),
      mergeRange: mergeRange("A", startRow, endRow),
    };
  });
  return {
    version: 1,
    startRow: raw.startRow,
    endRow: raw.startRow + rows.length - 1,
    records: rows.map(({ amountMilli, ...record }) => record),
    expenseGroups,
    dateGroups,
    expectedMergeRanges: [
      ...dateGroups.map((group) => group.mergeRange).filter(Boolean),
      ...expenseGroups.flatMap((group) => group.mergeRanges),
    ].sort(),
    transactionCount: rows.length,
    amount: formatAmount(rows.reduce((sum, record) => sum + record.amountMilli, 0n)),
  };
}

async function readJson(filePath) {
  const bytes = await fs.readFile(filePath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 && args.length !== 4) {
    throw new Error("Usage: derive_ledger_layout.mjs --input <records.json> [--out <layout.json>]");
  }
  if (args[0] !== "--input" || (args.length === 4 && args[2] !== "--out")) {
    throw new Error("Usage: derive_ledger_layout.mjs --input <records.json> [--out <layout.json>]");
  }
  const inputPath = path.resolve(args[1]);
  const result = deriveLedgerLayout(await readJson(inputPath));
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.length === 4) {
    await fs.writeFile(path.resolve(args[3]), output, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
