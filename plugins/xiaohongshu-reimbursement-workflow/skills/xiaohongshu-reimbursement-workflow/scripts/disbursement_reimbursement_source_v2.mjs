import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectEvidenceImage } from "./build_reimbursement_artifacts.mjs";
import { loadProfileRegistry } from "./finance_domain.mjs";
import {
  formatDisbursementAmount,
  normalizeDisbursementIsoDate,
  parseDisbursementAmount,
} from "./disbursement_domain.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  loadBundledDependency,
  parseStrictJson,
  readStableBinaryFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";
import { readWorkbookOoxmlFacts } from "./workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "./workbook_snapshot.mjs";

export const DISBURSEMENT_REIMBURSEMENT_SOURCE_AUDIT_KIND = "disbursement-reimbursement-source-audit-v2";
export const PUBLISHED_ARCHIVE_SOURCE_RESULT_KIND = "published-reimbursement-archive-source-v2";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 100 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ORDINARY_MANIFEST_AUDITOR = path.join(SCRIPT_DIR, "audit_batch_manifest.mjs");
const execFileAsync = promisify(execFile);
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SaxModule = loadBundledDependency("sax");
const sax = SaxModule.default ?? SaxModule;

function fail(message) {
  throw new Error(`Disbursement Reimbursement Source v2 ${message}`);
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
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) {
    fail(`${field} must be a trimmed non-empty single-line string.`);
  }
  return value;
}

function sha(value, field) {
  const result = text(value, field);
  if (!SHA256_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function exact(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function without(value, ...fields) {
  const result = structuredClone(value);
  for (const field of fields) delete result[field];
  return result;
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

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function displayCompactDate(value) {
  const normalized = normalizeDisbursementIsoDate(value, "date");
  return `${normalized.slice(0, 4)}.${Number(normalized.slice(5, 7))}.${Number(normalized.slice(8, 10))}`;
}

function displayPeriod(period) {
  return period.start === period.end
    ? displayCompactDate(period.start)
    : `${displayCompactDate(period.start)}-${displayCompactDate(period.end)}`;
}

function chineseDate(value) {
  const normalized = normalizeDisbursementIsoDate(value, "date");
  return `${normalized.slice(0, 4)}年${Number(normalized.slice(5, 7))}月${Number(normalized.slice(8, 10))}日`;
}

function safeSegment(value, fallback = "未命名") {
  const cleaned = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[ .]+$/gu, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function supplementSheetName(person) {
  return `${safeSegment(person).replace(/[\[\]]/gu, "-").slice(0, 25)}补报明细`;
}

function canonicalAmount(value, field, { allowNegative = true } = {}) {
  return formatDisbursementAmount(parseDisbursementAmount(value, field, { allowNegative }));
}

function sumAmounts(items, selector) {
  return items.reduce((total, item) => total + parseDisbursementAmount(selector(item), "amount", { allowNegative: true }), 0n);
}

function amountString(value) {
  return formatDisbursementAmount(value);
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

function mergeAt(sheet, row, column) {
  return sheet.merges.find((item) => (
    item.startRow <= row && row <= item.endRow && item.startColumn <= column && column <= item.endColumn
  )) ?? null;
}

function resolvedCell(sheet, cells, row, column) {
  const direct = cells.get(`${columnName(column)}${row}`);
  if (direct) return direct;
  const merge = mergeAt(sheet, row, column);
  return merge ? cells.get(`${columnName(merge.startColumn)}${merge.startRow}`) ?? null : null;
}

function isoDateFromCell(cell, date1904, field) {
  const raw = cellScalar(cell);
  if (typeof raw !== "string" || !raw) fail(`${field} is missing a date value.`);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return normalizeDisbursementIsoDate(raw, field);
  const serial = Number(raw);
  if (!Number.isFinite(serial)) fail(`${field} has invalid Excel date serial ${raw}.`);
  const date = new Date((serial - (date1904 ? 24_107 : 25_569)) * 86_400_000).toISOString().slice(0, 10);
  return normalizeDisbursementIsoDate(date, field);
}

function singleSheet(facts, expectedName, role, { strictSingle = true } = {}) {
  const identities = facts.workbook.sheets.filter((item) => item.name === expectedName);
  if (identities.length !== 1 || identities[0].state !== "visible") {
    fail(`${role} must contain one visible worksheet named ${expectedName}.`);
  }
  if (strictSingle && (facts.workbook.sheets.length !== 1 || facts.worksheets.length !== 1)) {
    fail(`${role} must contain exactly one worksheet.`);
  }
  const sheet = facts.worksheets.find((item) => item.name === expectedName);
  if (!sheet) fail(`${role} worksheet ${expectedName} is not structurally bound.`);
  return { ...sheet, date1904: facts.workbook.date1904 };
}

function assertNoBusinessCellsPast(sheet, maxColumn, role) {
  for (const row of sheet.rows) for (const cell of row.cells) {
    if (cell.column > maxColumn && (cell.value !== null || cell.formula !== null)) {
      fail(`${role} contains business content outside column ${columnName(maxColumn)} at ${cell.ref}.`);
    }
  }
}

function transactionTuple(item) {
  return JSON.stringify([item.date, item.person, item.reimbursementAmount]);
}

function artifactTuple(item) {
  return JSON.stringify([item.date, item.person, item.reimbursementAmount]);
}

function completeTuple(item) {
  return JSON.stringify([item.date, item.person, item.project, item.sourceAmount, item.classification, item.settlement]);
}

function assertHeader(cells, row, expected, role) {
  for (const [index, value] of expected.entries()) {
    const ref = `${columnName(index + 1)}${row}`;
    if (cellScalar(cells.get(ref)) !== value) fail(`${role} header ${ref} must be ${value}.`);
  }
}

function requireFormula(cell, expected, field) {
  if (cell?.formula?.text !== expected) fail(`${field} formula must be ${expected}.`);
}

function requireMerge(sheet, ref, field) {
  if (!sheet.merges.some((item) => item.ref === ref)) fail(`${field} requires merge ${ref}.`);
}

function validateFormulaGroups(sheet, cells, transactions, startRow, role) {
  const seen = new Set();
  for (let index = 0; index < transactions.length; index += 1) {
    const row = startRow + index;
    const anchor = resolvedCell(sheet, cells, row, 4);
    if (!anchor || seen.has(anchor.ref)) continue;
    seen.add(anchor.ref);
    const match = /^SUM\(C(\d+):C(\d+)\)$/u.exec(anchor.formula?.text ?? "");
    if (!match) fail(`${role} ${anchor.ref} must contain a bounded SUM formula.`);
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (first !== row || last < first || last >= startRow + transactions.length) fail(`${role} ${anchor.ref} SUM range is outside its transaction rows.`);
    const expected = sumAmounts(transactions.slice(first - startRow, last - startRow + 1), (item) => item.sourceAmount);
    const actual = parseDisbursementAmount(cellScalar(anchor), `${role}.${anchor.ref}`, { allowNegative: true });
    if (actual !== expected) fail(`${role} ${anchor.ref} cached total differs from its C-column rows.`);
    if (last > first) {
      requireMerge(sheet, `D${first}:D${last}`, `${role}.${anchor.ref}`);
      requireMerge(sheet, `E${first}:E${last}`, `${role}.${anchor.ref}`);
    }
  }
}

function validateDetailWorkbook(binding, profile, period, reviewTransactions) {
  const sheet = singleSheet(binding.facts, profile.detailSheetName, "detail workbook");
  assertNoBusinessCellsPast(sheet, 6, "detail workbook");
  const cells = cellMap(sheet);
  const expectedTitle = `${displayPeriod(period)} 本次报销明细（按人员分类）`;
  if (cellScalar(cells.get("A1")) !== expectedTitle) fail(`detail workbook title must be ${expectedTitle}.`);
  assertHeader(cells, 6, ["日期", "支出明细", "单笔金额", "费用组合计", "备注 / 分类", "报销属性"], "detail workbook");
  const derived = [];
  const sections = [];
  let row = 7;
  while (true) {
    const value = cellScalar(cells.get(`A${row}`));
    if (typeof value === "string" && value.startsWith("说明：")) break;
    if (typeof value !== "string") fail(`detail workbook row ${row} must be a person group or description row.`);
    const group = /^(.*?)(（对公已付不实报）)?｜([1-9]\d*)笔$/u.exec(value);
    if (!group || !group[1]) fail(`detail workbook row ${row} has an invalid person group label.`);
    const person = group[1];
    const companyPaid = Boolean(group[2]);
    const count = Number(group[3]);
    requireMerge(sheet, `A${row}:D${row}`, `detail workbook row ${row}`);
    const start = row + 1;
    const end = row + count;
    requireFormula(cells.get(`F${row}`), `SUM(C${start}:C${end})`, `detail workbook F${row}`);
    const sectionTransactions = [];
    for (let transactionRow = start; transactionRow <= end; transactionRow += 1) {
      const sourceAmount = canonicalAmount(cellScalar(cells.get(`C${transactionRow}`)), `detail.C${transactionRow}`);
      const attribute = cellScalar(resolvedCell(sheet, cells, transactionRow, 6));
      const expectedPrefix = companyPaid ? "对公已付不实报；" : "实报；";
      if (typeof attribute !== "string" || !attribute.startsWith(expectedPrefix) || !/；(?:有截图|无截图)$/u.test(attribute)) {
        fail(`detail workbook F${transactionRow} contradicts its person group settlement.`);
      }
      const transaction = {
        date: isoDateFromCell(resolvedCell(sheet, cells, transactionRow, 1), sheet.date1904, `detail.A${transactionRow}`),
        person,
        project: text(cellScalar(cells.get(`B${transactionRow}`)), `detail.B${transactionRow}`),
        sourceAmount,
        reimbursementAmount: companyPaid ? "0" : sourceAmount,
        classification: text(cellScalar(resolvedCell(sheet, cells, transactionRow, 5)), `detail.E${transactionRow}`),
        settlement: companyPaid ? "company_paid_no_reimbursement" : "employee_reimbursement",
        evidenceState: attribute.endsWith("有截图") ? "has_evidence" : "no_evidence",
        detailRow: transactionRow,
      };
      sectionTransactions.push(transaction);
      derived.push(transaction);
    }
    validateFormulaGroups(sheet, cells, sectionTransactions, start, "detail workbook");
    const sectionTotal = sumAmounts(sectionTransactions, (item) => item.sourceAmount);
    if (parseDisbursementAmount(cellScalar(cells.get(`F${row}`)), `detail.F${row}`, { allowNegative: true }) !== sectionTotal) {
      fail(`detail workbook F${row} cached group total is invalid.`);
    }
    sections.push({ person, settlement: companyPaid ? "company_paid_no_reimbursement" : "employee_reimbursement", row, transactions: sectionTransactions });
    row = end + 1;
  }
  const descriptionRow = row;
  if (derived.length === 0) fail("detail workbook has no transaction rows.");
  for (const workbookRow of sheet.rows) {
    if (workbookRow.index > descriptionRow && workbookRow.cells.some((cell) => cell.value !== null || cell.formula !== null)) {
      fail(`detail workbook contains business content after its description row at row ${workbookRow.index}.`);
    }
  }
  if (derived.length !== reviewTransactions.length) fail("detail workbook transaction count differs from sourceReview facts.transactions.");
  const queues = new Map();
  for (const transaction of derived) {
    const key = artifactTuple(transaction);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(transaction);
  }
  const byReviewOrder = reviewTransactions.map((raw, index) => {
    const normalized = {
      id: text(raw.id, `sourceReview.transactions[${index}].id`),
      date: normalizeDisbursementIsoDate(raw.date, `sourceReview.transactions[${index}].date`),
      person: text(raw.person, `sourceReview.transactions[${index}].person`),
      reimbursementAmount: canonicalAmount(raw.reimbursementAmount, `sourceReview.transactions[${index}].reimbursementAmount`),
    };
    const queue = queues.get(transactionTuple(normalized));
    if (!queue?.length) fail(`detail workbook cannot close sourceReview transaction ${normalized.id} by date/person/reimbursementAmount.`);
    const artifact = queue.shift();
    artifact.transactionId = normalized.id;
    return { normalized, artifact };
  });
  if ([...queues.values()].some((queue) => queue.length > 0)) fail("detail workbook contains transactions absent from sourceReview facts.transactions.");

  const reimbursementTotal = sumAmounts(derived, (item) => item.reimbursementAmount);
  const companyTotal = sumAmounts(derived.filter((item) => item.settlement === "company_paid_no_reimbursement"), (item) => item.sourceAmount);
  const feeTotal = sumAmounts(derived, (item) => item.sourceAmount);
  requireFormula(cells.get("E4"), "A4+C4", "detail workbook E4");
  if (parseDisbursementAmount(cellScalar(cells.get("E4")), "detail.E4", { allowNegative: true }) !== reimbursementTotal) fail("detail workbook E4 reimbursement total is invalid.");
  if (cellScalar(cells.get("A5")) !== `对公已付不实报：${amountString(companyTotal)}`) fail("detail workbook A5 company-paid total is invalid.");
  if (cellScalar(cells.get("D5")) !== `费用合计：${amountString(feeTotal)}`) fail("detail workbook D5 fee total is invalid.");
  return { sheet, cells, derived, sections, byReviewOrder, descriptionRow, totals: { reimbursementTotal, companyTotal, feeTotal } };
}

function parseSupplementWorkbook(binding, detail, profile) {
  const sheetIdentity = binding.facts.workbook.sheets;
  if (sheetIdentity.length !== 1 || sheetIdentity[0].state !== "visible" || !sheetIdentity[0].name.endsWith("补报明细")) {
    fail("supplement workbook must contain one visible 补报明细 worksheet.");
  }
  const sheet = singleSheet(binding.facts, sheetIdentity[0].name, "supplement workbook");
  assertNoBusinessCellsPast(sheet, 6, "supplement workbook");
  const cells = cellMap(sheet);
  assertHeader(cells, 4, ["日期", "支出明细", "单笔金额", "费用组合计", "备注 / 分类", "报销属性"], "supplement workbook");
  const title = cellScalar(cells.get("A1"));
  const match = /^(.*?) (\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{4}\.\d{1,2}\.\d{1,2})?) 小红书补报明细$/u.exec(title ?? "");
  if (!match || !match[1]) fail("supplement workbook A1 has an invalid generated title.");
  const person = match[1];
  const periodText = match[2];
  if (sheet.name !== supplementSheetName(person)) fail("supplement workbook sheet name differs from its generated person binding.");
  const reasonLine = cellScalar(cells.get("A2"));
  if (typeof reasonLine !== "string" || !reasonLine.startsWith("补报明细｜原因：") || !reasonLine.slice("补报明细｜原因：".length)) {
    fail("supplement workbook A2 must contain a non-empty reason.");
  }
  const reasons = reasonLine.slice("补报明细｜原因：".length).split("；");
  if (new Set(reasons).size !== reasons.length || reasons.some((item) => !item)) fail("supplement workbook reasons must be non-empty and unique.");
  const rows = [];
  let row = 5;
  while (cellScalar(cells.get(`A${row}`)) !== "补报总计") {
    if (!cells.has(`C${row}`)) fail(`supplement workbook is missing its footer after row ${row - 1}.`);
    const attribute = cellScalar(resolvedCell(sheet, cells, row, 6));
    if (typeof attribute !== "string" || !/^(?:实报|对公已付不实报)；(?:有截图|无截图)$/u.test(attribute)) fail(`supplement workbook F${row} has an invalid reimbursement attribute.`);
    const sourceAmount = canonicalAmount(cellScalar(cells.get(`C${row}`)), `supplement.C${row}`);
    rows.push({
      date: isoDateFromCell(resolvedCell(sheet, cells, row, 1), sheet.date1904, `supplement.A${row}`),
      person,
      project: text(cellScalar(cells.get(`B${row}`)), `supplement.B${row}`),
      sourceAmount,
      reimbursementAmount: attribute.startsWith("对公已付不实报") ? "0" : sourceAmount,
      classification: text(cellScalar(resolvedCell(sheet, cells, row, 5)), `supplement.E${row}`),
      settlement: attribute.startsWith("对公已付不实报") ? "company_paid_no_reimbursement" : "employee_reimbursement",
      supplementRow: row,
    });
    row += 1;
  }
  if (rows.length === 0) fail("supplement workbook has no transaction rows.");
  validateFormulaGroups(sheet, cells, rows, 5, "supplement workbook");
  const footerRow = row;
  requireMerge(sheet, `A${footerRow}:B${footerRow}`, `supplement workbook row ${footerRow}`);
  requireMerge(sheet, `C${footerRow}:F${footerRow}`, `supplement workbook row ${footerRow}`);
  requireFormula(cells.get(`C${footerRow}`), `SUM(C5:C${footerRow - 1})`, `supplement workbook C${footerRow}`);
  const sourceTotal = sumAmounts(rows, (item) => item.sourceAmount);
  const reimbursementTotal = sumAmounts(rows, (item) => item.reimbursementAmount);
  if (parseDisbursementAmount(cellScalar(cells.get(`C${footerRow}`)), `supplement.C${footerRow}`, { allowNegative: true }) !== sourceTotal) fail("supplement workbook footer total is invalid.");
  const start = [...rows].sort((left, right) => left.date.localeCompare(right.date))[0].date;
  const end = [...rows].sort((left, right) => left.date.localeCompare(right.date)).at(-1).date;
  const expectedPeriod = start === end ? displayCompactDate(start) : `${displayCompactDate(start)}-${displayCompactDate(end)}`;
  if (periodText !== expectedPeriod) fail("supplement workbook title period differs from its transaction dates.");
  const expectedFilename = start === end
    ? `${safeSegment(person)}_${displayCompactDate(start)}_小红书补报明细.xlsx`
    : `${safeSegment(person)}_${displayCompactDate(start)}-${displayCompactDate(end)}_小红书补报明细.xlsx`;
  if (path.basename(binding.path) !== expectedFilename) fail("supplement workbook filename differs from its generated person/period binding.");
  const expectedSummary = `补报实报合计：${amountString(reimbursementTotal)}元｜费用合计：${amountString(sourceTotal)}元｜共${rows.length}笔`;
  if (cellScalar(cells.get("A3")) !== expectedSummary) fail("supplement workbook A3 totals are invalid.");
  const detailQueues = new Map();
  for (const transaction of detail.derived) {
    const key = completeTuple(transaction);
    if (!detailQueues.has(key)) detailQueues.set(key, []);
    detailQueues.get(key).push(transaction);
  }
  const matches = [];
  for (const supplement of rows) {
    const candidates = detailQueues.get(completeTuple(supplement))?.filter((item) => item.supplementBinding === undefined) ?? [];
    if (candidates.length === 0) fail(`supplement workbook row ${supplement.supplementRow} is absent from the detail workbook.`);
    const selected = candidates[0];
    if (selected.person !== person) fail("supplement workbook person differs from its detail transaction.");
    selected.supplementBinding = { fileId: binding.fileId, sheetName: sheet.name, row: supplement.supplementRow };
    selected.reportingKind = "supplement";
    matches.push(selected);
  }
  return { person, start, end, count: rows.length, sourceTotal, reimbursementTotal, reasons, sheetName: sheet.name, matches };
}

function validateSupplements(bindings, detail, profile, period) {
  const supplements = bindings.map((binding) => ({ binding, parsed: parseSupplementWorkbook(binding, detail, profile) }));
  const people = supplements.map((item) => item.parsed.person);
  if (new Set(people).size !== people.length) fail("published archive contains duplicate supplement workbook roles for one person.");
  for (const transaction of detail.derived) {
    if (transaction.date > period.end) fail(`detail transaction ${transaction.transactionId} is after reimbursementPeriod.end.`);
    if (transaction.date < period.start && transaction.reportingKind !== "supplement") {
      fail(`detail transaction ${transaction.transactionId} predates reimbursementPeriod.start but has no supplement workbook binding.`);
    }
    transaction.reportingKind ??= "current";
  }
  const mainTotal = sumAmounts(detail.derived.filter((item) => item.reportingKind === "current"), (item) => item.reimbursementAmount);
  const supplementTotal = sumAmounts(detail.derived.filter((item) => item.reportingKind === "supplement"), (item) => item.reimbursementAmount);
  if (parseDisbursementAmount(cellScalar(detail.cells.get("A4")), "detail.A4", { allowNegative: true }) !== mainTotal) fail("detail workbook A4 main reimbursement total is invalid.");
  if (parseDisbursementAmount(cellScalar(detail.cells.get("C4")), "detail.C4", { allowNegative: true }) !== supplementTotal) fail("detail workbook C4 supplement reimbursement total is invalid.");
  return supplements;
}

function parseDrawingAnchors(xmlBytes, partName) {
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
  } catch (error) {
    throw new Error(`${partName} is not valid UTF-8 XML.`, { cause: error });
  }
  const parser = sax.parser(true, { xmlns: true, strictEntities: true, position: false, trim: false, normalize: false });
  const stack = [];
  const anchors = [];
  let current = null;
  let rootSeen = false;
  let parseError = null;
  const attribute = (tag, local) => Object.values(tag.attributes).find((item) => item.local === local)?.value ?? null;
  parser.onerror = (error) => { parseError ??= error; };
  parser.ondoctype = () => { throw new Error(`${partName} contains forbidden DOCTYPE.`); };
  parser.onsgmldeclaration = () => { throw new Error(`${partName} contains forbidden SGML.`); };
  parser.onprocessinginstruction = ({ name }) => { if (name.toLowerCase() !== "xml") throw new Error(`${partName} contains unsupported processing instruction.`); };
  parser.onopentag = (tag) => {
    const frame = { local: tag.local, text: "", inFrom: stack.some((item) => item.local === "from") };
    if (stack.length === 0) {
      if (tag.local !== "wsDr" || rootSeen) throw new Error(`${partName} must contain one wsDr root.`);
      rootSeen = true;
    }
    if (["twoCellAnchor", "absoluteAnchor"].includes(tag.local)) throw new Error(`${partName} contains unsupported non-generated anchor semantics.`);
    if (tag.local === "oneCellAnchor") {
      if (current) throw new Error(`${partName} contains nested anchors.`);
      current = { name: null, relationshipId: null, row: null, column: null };
    } else if (current && tag.local === "cNvPr") {
      if (current.name !== null) throw new Error(`${partName} anchor has duplicate cNvPr.`);
      current.name = attribute(tag, "name");
    } else if (current && tag.local === "blip") {
      if (current.relationshipId !== null) throw new Error(`${partName} anchor has duplicate blip.`);
      current.relationshipId = attribute(tag, "embed");
    }
    stack.push(frame);
  };
  parser.ontext = (value) => { if (stack.length) stack.at(-1).text += value; else if (value.trim()) throw new Error(`${partName} has text outside its root.`); };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => {
    const frame = stack.pop();
    if (!frame) throw new Error(`${partName} has an unmatched close tag.`);
    if (current && frame.inFrom && frame.local === "row") current.row = Number(frame.text) + 1;
    if (current && frame.inFrom && frame.local === "col") current.column = Number(frame.text) + 1;
    if (frame.local === "oneCellAnchor") {
      if (!current.name || !current.relationshipId || !Number.isSafeInteger(current.row) || current.row < 1 || !Number.isSafeInteger(current.column) || current.column < 1) {
        throw new Error(`${partName} anchor is incomplete.`);
      }
      anchors.push(current);
      current = null;
    }
  };
  try { parser.write(xml).close(); } catch (error) { parseError ??= error; }
  if (parseError) throw new Error(`${partName} is malformed drawing XML: ${parseError.message}`, { cause: parseError });
  if (!rootSeen || current || stack.length) throw new Error(`${partName} has an incomplete drawing contract.`);
  return anchors;
}

async function loadScreenshotDrawing(binding, sheet) {
  const worksheetIdentity = binding.facts.workbook.sheets.find((item) => item.name === sheet.name);
  const drawingRelationships = binding.facts.package.relationships.filter((item) => (
    item.sourcePartName === worksheetIdentity.partName && /\/drawing$/u.test(item.type) && item.targetMode === "Internal"
  ));
  if (drawingRelationships.length !== 1) fail("screenshot workbook must bind exactly one internal drawing part.");
  const drawingPart = drawingRelationships[0].resolvedPartName;
  const imageRelationships = binding.facts.package.relationships.filter((item) => (
    item.sourcePartName === drawingPart && /\/image$/u.test(item.type) && item.targetMode === "Internal"
  ));
  if (imageRelationships.length === 0) fail("screenshot workbook drawing has no image relationships.");
  const relationshipById = new Map(imageRelationships.map((item) => [item.id, item]));
  const zip = await JSZip.loadAsync(copyStableBinaryBytes(binding.snapshot), { createFolders: false });
  const drawingBytes = await zip.file(drawingPart)?.async("nodebuffer");
  if (!drawingBytes) fail("screenshot workbook drawing part is missing.");
  const anchors = parseDrawingAnchors(drawingBytes, drawingPart);
  if (anchors.length === 0) fail("screenshot workbook drawing has no anchors.");
  const usedRelationshipIds = new Set();
  const media = new Map();
  for (const anchor of anchors) {
    const relationship = relationshipById.get(anchor.relationshipId);
    if (!relationship) fail(`screenshot anchor ${anchor.name} has an unbound image relationship.`);
    usedRelationshipIds.add(anchor.relationshipId);
    if (!media.has(relationship.resolvedPartName)) {
      const bytes = await zip.file(relationship.resolvedPartName)?.async("nodebuffer");
      if (!bytes) fail(`screenshot image part ${relationship.resolvedPartName} is missing.`);
      await inspectEvidenceImage(bytes, `screenshot image part ${relationship.resolvedPartName}`);
      media.set(relationship.resolvedPartName, { sha256: sha256Bytes(bytes), size: bytes.length });
    }
    anchor.partName = relationship.resolvedPartName;
    anchor.sha256 = media.get(relationship.resolvedPartName).sha256;
  }
  for (const relationship of imageRelationships) if (!usedRelationshipIds.has(relationship.id)) fail(`screenshot drawing image relationship ${relationship.id} is unreferenced.`);
  const packageMedia = binding.facts.package.nonStructuralPartNames.filter((name) => /^xl\/media\/[^/]+$/u.test(name)).sort();
  const boundMedia = [...new Set(imageRelationships.map((item) => item.resolvedPartName))].sort();
  if (canonicalDigest(packageMedia) !== canonicalDigest(boundMedia)) fail("screenshot workbook contains unbound or missing media parts.");
  return { anchors, media };
}

async function validateScreenshotWorkbook(binding, detail, profile, evidenceBindings) {
  const sheet = singleSheet(binding.facts, profile.screenshotMapSheetName, "screenshot workbook");
  const cells = cellMap(sheet);
  assertHeader(cells, 1, ["日期", "支出人/主体", "项目", "金额", "备注"], "screenshot workbook");
  const imageHeaders = [];
  for (let column = 6; ; column += 1) {
    const value = cellScalar(cells.get(`${columnName(column)}1`));
    if (value === null) break;
    if (value !== `图${column - 5}`) fail(`screenshot workbook image header ${columnName(column)}1 is not sequential.`);
    imageHeaders.push(value);
  }
  if (imageHeaders.length < 3) fail("screenshot workbook must retain at least the generated 图1-图3 columns.");
  assertNoBusinessCellsPast(sheet, 5 + imageHeaders.length, "screenshot workbook");
  const detailQueues = new Map();
  for (const transaction of detail.derived) {
    const key = JSON.stringify([transaction.date, transaction.person, transaction.project, transaction.sourceAmount]);
    if (!detailQueues.has(key)) detailQueues.set(key, []);
    detailQueues.get(key).push(transaction);
  }
  const rowToTransaction = new Map();
  for (let index = 0; index < detail.derived.length; index += 1) {
    const row = index + 2;
    const actual = {
      date: isoDateFromCell(cells.get(`A${row}`), sheet.date1904, `screenshot.A${row}`),
      person: text(cellScalar(cells.get(`B${row}`)), `screenshot.B${row}`),
      project: text(cellScalar(cells.get(`C${row}`)), `screenshot.C${row}`),
      sourceAmount: canonicalAmount(cellScalar(cells.get(`D${row}`)), `screenshot.D${row}`),
    };
    const key = JSON.stringify([actual.date, actual.person, actual.project, actual.sourceAmount]);
    const queue = detailQueues.get(key);
    if (!queue?.length) fail(`screenshot workbook row ${row} does not close to one detail transaction.`);
    const transaction = queue.shift();
    const note = cellScalar(cells.get(`E${row}`));
    if (note !== transaction.classification && note !== `${transaction.classification}｜无图片凭证`) fail(`screenshot workbook E${row} differs from detail classification.`);
    transaction.screenshotRow = row;
    rowToTransaction.set(row, transaction);
  }
  if ([...detailQueues.values()].some((queue) => queue.length)) fail("screenshot workbook omits detail transactions.");
  for (const row of sheet.rows) {
    if (row.index > detail.derived.length + 1 && row.cells.some((cell) => cell.value !== null || cell.formula !== null)) fail(`screenshot workbook contains extra business row ${row.index}.`);
  }
  const drawing = await loadScreenshotDrawing(binding, sheet);
  const transactionById = new Map(detail.derived.map((item) => [item.transactionId, item]));
  const names = new Set();
  for (const anchor of drawing.anchors) {
    if (names.has(anchor.name)) fail(`screenshot workbook contains duplicate anchor name ${anchor.name}.`);
    names.add(anchor.name);
    const match = /^(.*)-([1-9]\d*)$/u.exec(anchor.name);
    const transaction = match ? transactionById.get(match[1]) : null;
    if (!transaction) fail(`screenshot anchor ${anchor.name} does not bind a sourceReview transaction id.`);
    const ordinal = Number(match[2]);
    if (anchor.row !== transaction.screenshotRow || anchor.column !== 5 + ordinal) fail(`screenshot anchor ${anchor.name} has an invalid row/column binding.`);
    transaction.evidenceAnchors ??= [];
    transaction.evidenceAnchors.push({ name: anchor.name, sha256: anchor.sha256, row: anchor.row, column: anchor.column });
  }
  const archivedBySha = new Map();
  for (const evidence of evidenceBindings) {
    if (archivedBySha.has(evidence.sha256)) fail("published archive contains duplicate evidence image digests.");
    archivedBySha.set(evidence.sha256, evidence);
  }
  const embedded = new Set([...drawing.media.values()].map((item) => item.sha256));
  if (canonicalDigest([...embedded].sort()) !== canonicalDigest([...archivedBySha.keys()].sort())) {
    fail("screenshot embedded media and archived evidence images do not close by SHA-256.");
  }
  for (const transaction of detail.derived) {
    transaction.evidenceBindings = (transaction.evidenceAnchors ?? []).map((anchor) => ({
      ...anchor,
      fileId: archivedBySha.get(anchor.sha256).fileId,
    }));
  }
  return { sheet, drawing };
}

function validateSummary(binding, detail, supplements, profile, period) {
  const summaryText = binding.text;
  if (!summaryText.endsWith("\n") || summaryText.includes("\r")) fail("summary text must use the generated UTF-8 LF contract.");
  const lines = summaryText.split("\n");
  const title = `${chineseDate(period.start)}—${chineseDate(period.end)}${profile.targetCategory}`;
  if (lines[0] !== title) fail(`summary title must be ${title}.`);
  const nonEmpty = lines.slice(1).filter(Boolean);
  const used = new Set();
  const employeeByPerson = new Map();
  for (const transaction of detail.derived.filter((item) => item.settlement === "employee_reimbursement")) {
    employeeByPerson.set(transaction.person, (employeeByPerson.get(transaction.person) ?? 0n) + parseDisbursementAmount(transaction.reimbursementAmount, "reimbursementAmount", { allowNegative: true }));
  }
  for (const [person, total] of employeeByPerson) {
    const pattern = new RegExp(`^${escapeRegExp(person)}：${escapeRegExp(amountString(total))}元(?:（.+）)?$`, "u");
    const matches = nonEmpty.map((line, index) => ({ line, index })).filter((item) => pattern.test(item.line));
    if (matches.length !== 1) fail(`summary must contain exactly one amount line for ${person}.`);
    used.add(matches[0].index);
  }
  const companyLines = [];
  for (const [index, line] of nonEmpty.entries()) {
    const match = /^(.+)对公已付不实报：(-?(?:0|[1-9]\d*)(?:\.\d{1,3})?)元$/u.exec(line);
    if (match) {
      companyLines.push(canonicalAmount(match[2], `summary company line ${index}`));
      used.add(index);
    }
  }
  const companyTotal = companyLines.reduce((total, value) => total + parseDisbursementAmount(value, "summary company amount", { allowNegative: true }), 0n);
  if (companyTotal !== detail.totals.companyTotal) fail("summary company-paid lines do not equal the detail workbook company total.");
  const reimbursementLine = `实报合计：${amountString(detail.totals.reimbursementTotal)}元`;
  const reimbursementIndexes = nonEmpty.map((line, index) => line === reimbursementLine ? index : -1).filter((index) => index >= 0);
  if (reimbursementIndexes.length !== 1) fail("summary must contain exactly one detail-bound reimbursement total.");
  used.add(reimbursementIndexes[0]);
  const missingEvidence = detail.derived.filter((item) => item.evidenceState === "no_evidence");
  if (missingEvidence.length) {
    const line = `无截图说明：${missingEvidence.map((item) => `${item.person}-${item.project}-${item.sourceAmount}元`).join("；")}`;
    const index = nonEmpty.indexOf(line);
    if (index < 0) fail("summary is missing its detail-bound no-evidence explanation.");
    used.add(index);
  }
  for (const { parsed } of supplements) {
    const periodText = parsed.start === parsed.end ? displayCompactDate(parsed.start) : `${displayCompactDate(parsed.start)}-${displayCompactDate(parsed.end)}`;
    const line = `补报说明：${parsed.person} ${periodText}，${parsed.count}笔，${amountString(parsed.reimbursementTotal)}元；原因：${parsed.reasons.join("；")}`;
    const index = nonEmpty.indexOf(line);
    if (index < 0) fail(`summary is missing the supplement explanation for ${parsed.person}.`);
    used.add(index);
  }
  const extras = nonEmpty.filter((_, index) => !used.has(index));
  if (extras.length) fail(`summary contains unsupported or unbound lines: ${extras.join(" | ")}.`);
}

function validateSnapshot(binding, detail, profile, period) {
  const expectedName = `${profile.archiveStem}_截至${displayCompactDate(period.end)}.xlsx`;
  if (path.basename(binding.path) !== expectedName) fail(`snapshot filename must be ${expectedName}.`);
  const sheet = singleSheet(binding.facts, profile.managedRootSheetName, "archive snapshot", { strictSingle: false });
  const cells = cellMap(sheet);
  const candidates = new Map();
  for (const row of sheet.rows) {
    const project = cellScalar(cells.get(`B${row.index}`));
    const sourceRaw = cellScalar(cells.get(`C${row.index}`));
    const person = cellScalar(resolvedCell(sheet, cells, row.index, 5));
    const classification = cellScalar(resolvedCell(sheet, cells, row.index, 6));
    if (typeof project !== "string" || sourceRaw === null || typeof person !== "string" || typeof classification !== "string") continue;
    let date;
    let sourceAmount;
    try {
      date = isoDateFromCell(resolvedCell(sheet, cells, row.index, 1), sheet.date1904, `snapshot.A${row.index}`);
      sourceAmount = canonicalAmount(sourceRaw, `snapshot.C${row.index}`);
    } catch {
      continue;
    }
    const key = JSON.stringify([date, person, project, sourceAmount, classification]);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(row.index);
  }
  for (const transaction of detail.derived) {
    const key = JSON.stringify([transaction.date, transaction.person, transaction.project, transaction.sourceAmount, transaction.classification]);
    const rows = candidates.get(key);
    if (!rows?.length) fail(`archive snapshot does not contain detail transaction ${transaction.transactionId}.`);
    transaction.snapshotRow = rows.shift();
  }
  return sheet;
}

function roleBinding(binding, role, detail = {}) {
  return {
    fileId: binding.fileId,
    role,
    path: binding.path,
    sha256: binding.sha256,
    size: binding.size,
    kind: binding.kind,
    ...detail,
  };
}

function classifyArtifacts(loaded, source, profile, period) {
  const attestationIds = new Set(Object.values(source.attestations ?? {}));
  const artifacts = loaded.filter((item) => !attestationIds.has(item.fileId));
  const result = { summary: [], detail: [], screenshot: [], snapshot: [], supplement: [], evidence: [], root: [] };
  const periodText = escapeRegExp(displayPeriod(period));
  const category = escapeRegExp(profile.targetCategory);
  const detailPattern = new RegExp(`^${periodText}_${category}_本次报销明细(?:（含.+）)?\\.xlsx$`, "u");
  const screenshotPattern = new RegExp(`^${periodText}_${category}_报销明细对应截图表(?:（含.+）)?\\.xlsx$`, "u");
  const summaryPattern = new RegExp(`^${periodText}_${category}_报销文字说明(?:（含.+）)?\\.txt$`, "u");
  const snapshotName = `${profile.archiveStem}_截至${displayCompactDate(period.end)}.xlsx`;
  const supplementPattern = /^.+_\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{4}\.\d{1,2}\.\d{1,2})?_小红书补报明细\.xlsx$/u;
  const evidencePattern = /^\d{3}_.+_\d{4}-\d{2}-\d{2}(?:_[0-9a-f]{8})?\.(?:png|jpg)$/u;
  for (const binding of artifacts) {
    const name = path.basename(binding.path);
    let role = null;
    if (binding.kind === "text" && summaryPattern.test(name)) role = "summary";
    else if (binding.kind === "workbook" && detailPattern.test(name)) role = "detail";
    else if (binding.kind === "workbook" && screenshotPattern.test(name)) role = "screenshot";
    else if (binding.kind === "workbook" && name === snapshotName) role = "snapshot";
    else if (binding.kind === "workbook" && supplementPattern.test(name)) role = "supplement";
    else if (binding.kind === "workbook" && name === profile.canonicalRootWorkbookName) role = "root";
    else if (binding.kind === "image" && evidencePattern.test(name)) role = "evidence";
    if (!role) fail(`published archive contains unknown file role: ${binding.path}.`);
    result[role].push(binding);
  }
  for (const role of ["summary", "detail", "screenshot", "snapshot"]) {
    if (result[role].length === 0) fail(`published archive is missing required ${role} role.`);
    if (result[role].length > 1) fail(`published archive contains duplicate ${role} roles.`);
  }
  if (result.evidence.length === 0) fail("published archive is missing required evidence role.");
  if (result.root.length > 1) fail("published archive contains duplicate published root roles.");
  if (result.root.length && !source.attestations?.receiptFileId) fail("published root input is only allowed for an explicit receipt attestation.");
  const archiveRoot = path.dirname(result.detail[0].path);
  for (const role of ["summary", "screenshot", "snapshot", "supplement"]) {
    for (const binding of result[role]) if (!samePath(path.dirname(binding.path), archiveRoot)) fail(`${role} artifact is outside the single explicit archive root.`);
  }
  const expectedEvidenceDirectory = path.join(archiveRoot, "报销截图", profile.screenshotMapSheetName);
  for (const binding of result.evidence) if (!samePath(path.dirname(binding.path), expectedEvidenceDirectory)) fail("evidence image is outside the generated 报销截图 profile directory.");
  return { ...result, archiveRoot };
}

async function loadBoundSourceFile(file, field) {
  const filePath = path.resolve(text(file.path, `${field}.path`));
  const expectedSha = sha(file.sha256, `${field}.sha256`);
  const kind = text(file.kind, `${field}.kind`);
  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES
    : kind === "workbook" ? MAX_WORKBOOK_BYTES
      : kind === "text" ? MAX_TEXT_BYTES
        : kind === "json" ? MAX_JSON_BYTES
          : 0;
  if (!maxBytes) fail(`${field} kind ${kind} is outside the published archive allowlist.`);
  const snapshot = await readStableBinaryFile(filePath, { maxBytes });
  if (snapshot.sha256 !== expectedSha) fail(`${field} SHA-256 differs from its sourceFiles binding.`);
  const extension = path.extname(filePath).toLowerCase();
  const loaded = { fileId: file.id, path: filePath, sha256: snapshot.sha256, size: snapshot.size, kind, usage: [...file.usage], snapshot };
  if (kind === "workbook") {
    if (extension !== ".xlsx") fail(`${field} workbook must use .xlsx.`);
    const workbookSnapshot = await readStableFileSnapshot(filePath);
    if (workbookSnapshot.sha256 !== snapshot.sha256 || workbookSnapshot.size !== snapshot.size) fail(`${field} changed between its stable binary and workbook reads.`);
    loaded.facts = await readWorkbookOoxmlFacts(workbookSnapshot);
  } else if (kind === "image") {
    const image = await inspectEvidenceImage(copyStableBinaryBytes(snapshot), field);
    if ((image.extension === "png" && extension !== ".png") || (image.extension === "jpg" && extension !== ".jpg")) fail(`${field} image extension differs from decoded bytes.`);
    loaded.image = image;
  } else {
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(copyStableBinaryBytes(snapshot)); } catch (error) { throw new Error(`${field} is not valid UTF-8.`, { cause: error }); }
    if (kind === "text") {
      if (extension !== ".txt") fail(`${field} text artifact must use .txt.`);
      loaded.text = decoded;
    } else {
      if (extension !== ".json") fail(`${field} JSON attestation must use .json.`);
      loaded.json = parseStrictJson(decoded);
    }
  }
  return loaded;
}

async function auditOriginalManifestAttestation(binding, source, review, profile) {
  object(binding.json, "original manifest attestation");
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [
      ORDINARY_MANIFEST_AUDITOR,
      binding.path,
      "--defer-ordinary-file-verification",
    ], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_JSON_BYTES,
      timeout: 120_000,
    }));
  } catch (error) {
    fail(`original manifest attestation audit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stderr) fail("original manifest attestation auditor wrote stderr.");
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail("original manifest attestation auditor must return one JSON line.");
  const audit = parseStrictJson(lines[0]);
  if (audit.ok !== true || audit.fileVerificationMode !== "bound-builders" || audit.manifestFileSha256 !== binding.sha256) {
    fail("original manifest attestation audit binding is incomplete or changed.");
  }
  if (!audit.affectedProfileIds.includes(source.profileId)) fail("original manifest attestation does not include the reimbursement profile.");
  if (audit.batch?.batchId !== review.facts.batchId) fail("original manifest attestation batchId differs from sourceReview.");
  if (canonicalDigest(audit.batch?.mainPeriod) !== canonicalDigest(review.facts.reimbursementPeriod)) fail("original manifest attestation period differs from sourceReview.");
  const transactions = audit.normalizedTransactions
    .filter((item) => item.category === profile.targetCategory)
    .map((item) => ({ id: item.id, date: item.date, person: item.person, reimbursementAmount: item.reimbursementAmount }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expected = review.facts.transactions
    .map((item) => ({ id: item.id, date: item.date, person: item.person, reimbursementAmount: canonicalAmount(item.reimbursementAmount, `${item.id}.reimbursementAmount`) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalDigest(transactions) !== canonicalDigest(expected)) fail("original manifest attestation transactions conflict with reconstructed/sourceReview facts.");
  return {
    fileId: binding.fileId,
    sha256: binding.sha256,
    manifestDigest: audit.manifestDigest,
    affectedProfileIds: [...audit.affectedProfileIds],
    mode: "v3-structure-and-archive-facts-no-follow",
    referencedPathsFollowed: false,
  };
}

function receiptBinding(value, field) {
  object(value, field);
  return { path: path.resolve(text(value.path, `${field}.path`)), sha256: sha(value.sha256, `${field}.sha256`) };
}

function flattenReceiptOutput(output) {
  object(output, "receipt output");
  const bindings = [];
  for (const role of ["root", "detail", "screenshot", "summary", "snapshot"]) bindings.push({ receiptRole: role, ...receiptBinding(output[role], `receipt output.${role}`) });
  for (const [index, entry] of array(output.supplements, "receipt output.supplements").entries()) bindings.push({ receiptRole: `supplement-${String(index + 1).padStart(3, "0")}`, ...receiptBinding(entry, `receipt output.supplements[${index}]`) });
  for (const [index, entry] of array(output.evidenceArchive, "receipt output.evidenceArchive").entries()) bindings.push({ receiptRole: `evidence-${String(index + 1).padStart(3, "0")}`, ...receiptBinding(entry, `receipt output.evidenceArchive[${index}]`) });
  return bindings;
}

function expectedArtifactRole(receiptRole) {
  if (receiptRole.startsWith("supplement-")) return "supplement";
  if (receiptRole.startsWith("evidence-")) return "evidence";
  return receiptRole;
}

function auditReceiptAttestation(binding, source, review, roles, loadedByPath, manifestAttestation) {
  const receipt = object(binding.json, "publish receipt attestation");
  exact(receipt,
    new Set(["kind", "batchId", "affectedProfileIds", "outputs", "postPublishAuditDigest", "receiptDigest"]),
    new Set(["cleanup"]), "publish receipt attestation");
  if (receipt.kind !== "ordinary-reimbursement-published-v1") fail("publish receipt attestation kind is invalid.");
  const digest = sha(receipt.receiptDigest, "publish receipt attestation.receiptDigest");
  if (canonicalDigest(without(receipt, "receiptDigest", "cleanup")) !== digest) fail("publish receipt attestation digest is invalid.");
  if (receipt.cleanup !== undefined) object(receipt.cleanup, "publish receipt attestation.cleanup");
  if (receipt.batchId !== review.facts.batchId || !Array.isArray(receipt.affectedProfileIds) || !receipt.affectedProfileIds.includes(source.profileId)) {
    fail("publish receipt attestation does not bind sourceReview batch/profile.");
  }
  if (manifestAttestation && canonicalDigest(receipt.affectedProfileIds) !== canonicalDigest(manifestAttestation.affectedProfileIds)) {
    fail("publish receipt and original manifest attestations conflict on affected profiles.");
  }
  const outputs = array(receipt.outputs, "publish receipt attestation.outputs").filter((item) => item?.profileId === source.profileId);
  if (outputs.length !== 1) fail("publish receipt attestation must contain exactly one output for the profile.");
  const flattened = flattenReceiptOutput(outputs[0]);
  const resolved = [];
  const seenFileIds = new Set();
  const seenPaths = new Set();
  for (const item of flattened) {
    const loaded = loadedByPath.get(pathKey(item.path));
    if (!loaded) fail(`publish receipt attestation references undeclared artifact path ${item.path}.`);
    if (loaded.sha256 !== item.sha256) fail(`publish receipt attestation ${item.receiptRole} SHA conflicts with explicit source file.`);
    const identity = pathKey(loaded.path);
    if (seenFileIds.has(loaded.fileId) || seenPaths.has(identity)) {
      fail(`publish receipt attestation ${item.receiptRole} reuses an artifact file already assigned to another receipt role.`);
    }
    seenFileIds.add(loaded.fileId);
    seenPaths.add(identity);
    const actualRole = Object.entries(roles).find(([, values]) => Array.isArray(values) && values.includes(loaded))?.[0] ?? null;
    const wantedRole = expectedArtifactRole(item.receiptRole);
    if (actualRole !== wantedRole) {
      fail(`publish receipt attestation ${item.receiptRole} path has archive role ${actualRole ?? "unknown"}.`);
    }
    resolved.push({ receiptRole: item.receiptRole, fileId: loaded.fileId, path: loaded.path, sha256: loaded.sha256 });
  }
  const archiveFileIds = new Set([
    roles.detail[0].fileId,
    roles.screenshot[0].fileId,
    roles.summary[0].fileId,
    roles.snapshot[0].fileId,
    ...roles.supplement.map((item) => item.fileId),
    ...roles.evidence.map((item) => item.fileId),
    ...roles.root.map((item) => item.fileId),
  ]);
  const receiptFileIds = new Set(resolved.map((item) => item.fileId));
  for (const fileId of archiveFileIds) if (!receiptFileIds.has(fileId)) fail(`publish receipt attestation omits explicit archive artifact ${fileId}.`);
  for (const fileId of receiptFileIds) if (!archiveFileIds.has(fileId)) fail(`publish receipt attestation includes non-archive artifact ${fileId}.`);
  if (receiptFileIds.size !== archiveFileIds.size || resolved.length !== archiveFileIds.size) {
    fail("publish receipt attestation artifact roles do not close one-to-one over the explicit published output set.");
  }
  return { fileId: binding.fileId, sha256: binding.sha256, receiptDigest: digest, artifactBindings: resolved };
}

function validateArchiveDirectoryName(roles, profile, period, supplements, detail) {
  const supplementedIds = new Set(supplements.flatMap((item) => item.parsed.matches.map((transaction) => transaction.transactionId)));
  const grouped = new Map();
  for (const transaction of detail.derived) {
    if (!supplementedIds.has(transaction.transactionId)) continue;
    if (!grouped.has(transaction.person)) grouped.set(transaction.person, []);
    grouped.get(transaction.person).push(transaction);
  }
  const suffix = grouped.size === 0 ? "" : `（含${[...grouped].map(([person, items]) => {
    const ordered = [...items].sort((left, right) => left.date.localeCompare(right.date) || left.detailRow - right.detailRow);
    const start = ordered[0].date;
    const end = ordered.at(-1).date;
    const periodText = start === end ? displayCompactDate(start) : `${displayCompactDate(start)}-${displayCompactDate(end)}`;
    const total = amountString(sumAmounts(ordered, (item) => item.reimbursementAmount));
    return `${person}${periodText}补报${ordered.length}笔${total}元`;
  }).join("、")}）`;
  const expected = `${displayPeriod(period)}_${profile.targetCategory}${suffix}`;
  if (path.basename(roles.archiveRoot) !== expected) fail(`published archive directory name must be ${expected}.`);
  return suffix;
}

function transactionBindings(detail, roles, profile) {
  return detail.byReviewOrder.map(({ normalized, artifact }) => ({
    transactionId: normalized.id,
    detail: { fileId: roles.detail[0].fileId, sheetName: profile.detailSheetName, row: artifact.detailRow },
    screenshot: { fileId: roles.screenshot[0].fileId, sheetName: profile.screenshotMapSheetName, row: artifact.screenshotRow },
    snapshot: { fileId: roles.snapshot[0].fileId, sheetName: profile.managedRootSheetName, row: artifact.snapshotRow },
    ...(artifact.supplementBinding ? { supplement: artifact.supplementBinding } : {}),
    evidence: (artifact.evidenceBindings ?? []).map((item) => ({ fileId: item.fileId, sha256: item.sha256, anchorName: item.name, row: item.row, column: item.column })),
    artifactDerived: {
      project: artifact.project,
      classification: artifact.classification,
      sourceAmount: artifact.sourceAmount,
      settlement: artifact.settlement,
      reportingKind: artifact.reportingKind,
      evidenceState: artifact.evidenceState,
    },
  }));
}

async function auditPublishedArchiveSource(source, review, fileById, registry) {
  if (source.mode !== "published_archive" || review.mode !== "published_archive") fail(`${source.id} is not a published_archive source.`);
  const profile = registry.profiles[source.profileId];
  if (!profile) fail(`${source.id} has unknown profile ${source.profileId}.`);
  if (review.sourceId !== source.id) fail(`${source.id} sourceReview sourceId differs.`);
  const period = {
    start: normalizeDisbursementIsoDate(review.facts.reimbursementPeriod.start, `${review.id}.reimbursementPeriod.start`),
    end: normalizeDisbursementIsoDate(review.facts.reimbursementPeriod.end, `${review.id}.reimbursementPeriod.end`),
  };
  if (period.start > period.end) fail(`${source.id} sourceReview reimbursementPeriod is reversed.`);
  const declaredFileIds = [...source.inputFileIds, ...Object.values(source.attestations ?? {})];
  if (new Set(declaredFileIds).size !== declaredFileIds.length) fail(`${source.id} declares duplicate input/attestation file ids.`);
  if (canonicalDigest([...review.reviewedFileIds].sort()) !== canonicalDigest([...declaredFileIds].sort())) {
    fail(`${source.id} sourceReview reviewedFileIds do not exactly cover explicit source files.`);
  }
  const loaded = [];
  for (const [index, fileId] of declaredFileIds.entries()) {
    const file = fileById.get(fileId);
    if (!file) fail(`${source.id} references missing sourceFiles id ${fileId}.`);
    loaded.push(await loadBoundSourceFile(file, `${source.id}.files[${index}]`));
  }
  const loadedById = new Map(loaded.map((item) => [item.fileId, item]));
  const loadedByPath = new Map(loaded.map((item) => [pathKey(item.path), item]));
  if (loadedByPath.size !== loaded.length) fail(`${source.id} explicit source paths are duplicated.`);
  const roles = classifyArtifacts(loaded, source, profile, period);
  const detail = validateDetailWorkbook(roles.detail[0], profile, period, review.facts.transactions);
  const supplements = validateSupplements(roles.supplement, detail, profile, period);
  const supplementSuffix = validateArchiveDirectoryName(roles, profile, period, supplements, detail);
  await validateScreenshotWorkbook(roles.screenshot[0], detail, profile, roles.evidence);
  validateSummary(roles.summary[0], detail, supplements, profile, period);
  validateSnapshot(roles.snapshot[0], detail, profile, period);
  let originalManifest = null;
  if (source.attestations?.originalManifestFileId) {
    originalManifest = await auditOriginalManifestAttestation(loadedById.get(source.attestations.originalManifestFileId), source, review, profile);
  }
  let receipt = null;
  if (source.attestations?.receiptFileId) {
    receipt = auditReceiptAttestation(loadedById.get(source.attestations.receiptFileId), source, review, roles, loadedByPath, originalManifest);
  }
  const artifactBindings = [
    roleBinding(roles.summary[0], "summary"),
    roleBinding(roles.detail[0], "detail", { sheetName: profile.detailSheetName }),
    roleBinding(roles.screenshot[0], "screenshot", { sheetName: profile.screenshotMapSheetName }),
    roleBinding(roles.snapshot[0], "snapshot", { sheetName: profile.managedRootSheetName }),
    ...roles.supplement.map((binding) => {
      const parsed = supplements.find((item) => item.binding === binding).parsed;
      return roleBinding(binding, "supplement", { person: parsed.person, start: parsed.start, end: parsed.end, count: parsed.count, sheetName: parsed.sheetName });
    }),
    ...roles.evidence.map((binding) => roleBinding(binding, "evidence", { width: binding.image.width, height: binding.image.height })),
    ...roles.root.map((binding) => roleBinding(binding, "published_root_attestation_artifact", { sheetName: profile.managedRootSheetName })),
  ];
  const transactions = detail.byReviewOrder.map(({ normalized }) => ({ ...normalized }));
  const boundSourcePaths = loaded.map((item) => item.path);
  const boundSourceDigests = loaded.map((item) => ({ fileId: item.fileId, sha256: item.sha256, size: item.size, kind: item.kind }));
  const sourceCore = {
    kind: PUBLISHED_ARCHIVE_SOURCE_RESULT_KIND,
    sourceId: source.id,
    profileId: source.profileId,
    mode: source.mode,
    reviewId: review.id,
    batchId: review.facts.batchId,
    reimbursementPeriod: period,
    supplementSuffix,
    transactions,
    transactionBindings: transactionBindings(detail, roles, profile),
    artifactBindings,
    boundSourcePaths,
    boundSourceDigests,
    attestations: {
      ...(originalManifest ? { originalManifest } : {}),
      ...(receipt ? { receipt } : {}),
    },
    reviewBoundFacts: [
      { field: "batchId", authority: "sourceReview", corroboration: originalManifest ? "original_manifest_attestation" : receipt ? "publish_receipt_attestation" : "none" },
      { field: "transactions[].id", authority: "sourceReview", corroboration: "screenshot_anchor_when_present_otherwise_date_person_amount_tuple" },
      { field: "summary.annotations", authority: "sourceReview", corroboration: "amount_line_only" },
      { field: "companyPaid.summaryLabelGrouping", authority: "sourceReview", corroboration: "file_total_only" },
      { field: "supplement.reasons", authority: "published_archive_file_only", corroboration: "not_present_in_sourceReview_v2" },
    ],
  };
  return { ...sourceCore, sourceDigest: canonicalDigest(sourceCore) };
}

/**
 * Audits normalized v2 published-archive reimbursement sources without scanning
 * any directory. Every byte read is named by inputFileIds or attestations.
 */
export async function auditDisbursementReimbursementSourcesV2(rawInput) {
  exact(rawInput, new Set(["sourceFiles", "reimbursementSources", "reimbursementReviews"]), new Set(), "input");
  const sourceFiles = array(rawInput.sourceFiles, "sourceFiles");
  const reimbursementSources = array(rawInput.reimbursementSources, "reimbursementSources");
  const reviews = array(rawInput.reimbursementReviews, "reimbursementReviews");
  const fileById = new Map();
  for (const [index, file] of sourceFiles.entries()) {
    const fileId = text(file.id, `sourceFiles[${index}].id`);
    if (fileById.has(fileId)) fail(`sourceFiles id ${fileId} is duplicated.`);
    fileById.set(fileId, file);
  }
  const reviewBySource = new Map();
  for (const review of reviews) {
    if (reviewBySource.has(review.sourceId)) fail(`sourceReview for ${review.sourceId} is duplicated.`);
    reviewBySource.set(review.sourceId, review);
  }
  if (reimbursementSources.length === 0) fail("reimbursementSources must contain at least one published_archive source.");
  const registry = await loadProfileRegistry();
  const sources = [];
  for (const source of reimbursementSources) {
    const review = reviewBySource.get(source.id);
    if (!review) fail(`sourceReview for ${source.id} is missing.`);
    sources.push(await auditPublishedArchiveSource(source, review, fileById, registry));
  }
  if (reviewBySource.size !== sources.length) fail("reimbursementReviews contains a review without a reimbursement source.");
  const body = {
    kind: DISBURSEMENT_REIMBURSEMENT_SOURCE_AUDIT_KIND,
    version: 2,
    sources,
    transactions: sources.flatMap((source) => source.transactions.map((transaction) => ({ sourceId: source.sourceId, profileId: source.profileId, ...transaction }))),
    artifactBindings: sources.flatMap((source) => source.artifactBindings.map((binding) => ({ sourceId: source.sourceId, ...binding }))),
    boundSourcePaths: sources.flatMap((source) => source.boundSourcePaths),
    boundSourceDigests: sources.flatMap((source) => source.boundSourceDigests.map((binding) => ({ sourceId: source.sourceId, ...binding }))),
  };
  return deepFreeze({ ...body, auditDigest: canonicalDigest(body) });
}
