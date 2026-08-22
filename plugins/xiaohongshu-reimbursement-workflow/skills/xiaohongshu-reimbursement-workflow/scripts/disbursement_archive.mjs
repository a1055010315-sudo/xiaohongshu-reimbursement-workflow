import fs from "node:fs/promises";
import path from "node:path";

import { loadBundledDependency, canonicalDigest, readStableBinaryFile, sha256Bytes } from "./workflow_primitives.mjs";
import { assertXml10Text, formatDisbursementAmount, parseDisbursementAmount } from "./disbursement_domain.mjs";
import { loadDisbursementTemplate } from "./disbursement_template.mjs";
import { auditOpenedWorkbookStyleContract } from "./workbook_style_contract.mjs";

export const DISBURSEMENT_SUMMARY_FILENAME = "发放情况说明.txt";
export const DISBURSEMENT_WORKBOOK_FILENAME = "发放核对表.xlsx";
export const DISBURSEMENT_VOUCHER_DIRECTORY = "发放凭证";
export const DISBURSEMENT_WORKSHEET_NAME = "发放核对表";
export const DISBURSEMENT_FINAL_ROOT_ENTRIES = Object.freeze([
  DISBURSEMENT_SUMMARY_FILENAME,
  DISBURSEMENT_WORKBOOK_FILENAME,
  DISBURSEMENT_VOUCHER_DIRECTORY,
]);

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SaxModule = loadBundledDependency("sax");
const sax = SaxModule.default ?? SaxModule;
const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024;
const HEADERS = Object.freeze([
  "姓名/事项",
  "小红书报销",
  "公司报销",
  "驻所报销",
  "工资类别",
  "工资",
  "应发合计",
  "实际发放",
  "方式",
  "状态",
  "凭证/备注",
]);

function fail(message) {
  throw new Error(`Compact Disbursement Archive ${message}`);
}

function saxAttribute(tag, localName) {
  const direct = tag.attributes?.[localName];
  if (direct !== undefined) return typeof direct === "string" ? direct : direct.value;
  for (const [name, attribute] of Object.entries(tag.attributes ?? {})) {
    if ((attribute.local ?? attribute.name?.split(":").at(-1) ?? name.split(":").at(-1)) === localName) {
      return typeof attribute === "string" ? attribute : attribute.value;
    }
  }
  return undefined;
}

function parseDisbursementWorksheetRows(worksheetXmlText, template) {
  const autoFilter = /<autoFilter\b[^>]*\bref="A(\d+):K(\d+)"/iu.exec(worksheetXmlText);
  if (!autoFilter || Number(autoFilter[1]) !== template.headerRow) fail("generated workbook autoFilter range is invalid.");
  const dataEndRow = Number(autoFilter[2]);
  if (!Number.isSafeInteger(dataEndRow) || dataEndRow < template.dataStartRow) fail("generated workbook data range is invalid.");
  const parser = sax.parser(true, { position: false, strictEntities: true, trim: false, normalize: false, xmlns: false });
  const rows = new Map();
  let currentRow = null;
  let currentCell = null;
  let capture = null;
  let captured = "";
  let parseError = null;
  parser.onerror = (error) => { parseError ??= error; };
  parser.ondoctype = () => { parseError ??= new Error("DOCTYPE is forbidden"); };
  parser.onopentag = (tag) => {
    const local = tag.local ?? tag.name.split(":").at(-1);
    if (local === "row") {
      const raw = saxAttribute(tag, "r");
      const rowNumber = Number(raw);
      if (!/^[1-9]\d*$/u.test(raw ?? "") || !Number.isSafeInteger(rowNumber) || rows.has(rowNumber) || currentRow) {
        parseError ??= new Error("worksheet rows must have unique explicit coordinates");
        return;
      }
      currentRow = { rowNumber, cells: new Map() };
      return;
    }
    if (local === "c" && currentRow) {
      const ref = saxAttribute(tag, "r");
      const match = /^([A-K])([1-9]\d*)$/u.exec(ref ?? "");
      if (!match || Number(match[2]) !== currentRow.rowNumber || currentRow.cells.has(match[1]) || currentCell) {
        parseError ??= new Error("worksheet cells must have unique explicit A:K coordinates");
        return;
      }
      currentCell = { column: match[1], type: saxAttribute(tag, "t") ?? null, text: "", value: "", formula: "" };
      return;
    }
    if (currentCell && (local === "t" || local === "v" || local === "f")) {
      capture = local;
      captured = "";
    }
  };
  parser.ontext = (value) => { if (capture) captured += value; };
  parser.oncdata = parser.ontext;
  parser.onclosetag = (qualifiedName) => {
    const local = qualifiedName.split(":").at(-1);
    if (currentCell && capture === local) {
      if (local === "t") currentCell.text += captured;
      else if (local === "v") currentCell.value += captured;
      else currentCell.formula += captured;
      capture = null;
      captured = "";
    }
    if (local === "c") {
      if (currentRow && currentCell) currentRow.cells.set(currentCell.column, Object.freeze(currentCell));
      currentCell = null;
    }
    if (local === "row") {
      if (currentRow) rows.set(currentRow.rowNumber, Object.freeze(currentRow));
      currentRow = null;
    }
  };
  try { parser.write(worksheetXmlText).close(); } catch (error) { parseError ??= error; }
  if (parseError || currentRow || currentCell || capture) fail(`generated worksheet XML is malformed: ${parseError?.message ?? "unclosed element"}.`);

  const amount = (cell, field, allowNegative = true) => {
    if (!cell || cell.type !== "n" || !cell.value) fail(`${field} must be a numeric cell with a cached value.`);
    return formatDisbursementAmount(parseDisbursementAmount(cell.value, field, { allowNegative }));
  };
  const inline = (cell, field) => {
    if (!cell) return "";
    if (cell.type === null && !cell.text && !cell.value && !cell.formula) return "";
    if (cell.type !== "inlineStr" || cell.value || cell.formula) fail(`${field} must be an inline string cell.`);
    assertXml10Text(cell.text, field);
    return cell.text;
  };
  const result = [];
  let blankSeen = false;
  for (let rowNumber = template.dataStartRow; rowNumber <= dataEndRow; rowNumber += 1) {
    const row = rows.get(rowNumber);
    if (!row) fail(`generated worksheet is missing data row ${rowNumber}.`);
    const subject = inline(row.cells.get("A"), `A${rowNumber}`);
    if (!subject) {
      const nonBlank = [..."ABCDEFGHIJK"].filter((column) => {
        const cell = row.cells.get(column);
        return cell && (cell.text || cell.value || cell.formula || cell.type !== null);
      });
      if (nonBlank.length) fail(`generated worksheet reserved row ${rowNumber} has data outside column A: ${nonBlank.join(", ")}.`);
      blankSeen = true;
      continue;
    }
    if (blankSeen) fail("generated worksheet contains a populated row after a blank reserved row.");
    const payableCell = row.cells.get("G");
    const expectedFormula = `ROUND(SUM(B${rowNumber}:D${rowNumber},F${rowNumber}),3)`;
    if (payableCell?.formula !== expectedFormula) fail(`G${rowNumber} formula is invalid.`);
    result.push(Object.freeze({
      excelRow: rowNumber,
      subject,
      xiaohongshu: amount(row.cells.get("B"), `B${rowNumber}`),
      company: amount(row.cells.get("C"), `C${rowNumber}`),
      residence: amount(row.cells.get("D"), `D${rowNumber}`),
      salaryCategory: inline(row.cells.get("E"), `E${rowNumber}`),
      salary: amount(row.cells.get("F"), `F${rowNumber}`, false),
      payableAmount: amount(payableCell, `G${rowNumber}`),
      paidAmount: amount(row.cells.get("H"), `H${rowNumber}`),
      paymentMethod: inline(row.cells.get("I"), `I${rowNumber}`),
      visibleStatus: inline(row.cells.get("J"), `J${rowNumber}`),
      note: inline(row.cells.get("K"), `K${rowNumber}`),
      payableFormula: payableCell.formula,
    }));
  }
  return Object.freeze(result);
}

function escapeXml(value) {
  return assertXml10Text(String(value), "workbook text")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textCell(ref, style, value) {
  const rendered = escapeXml(value ?? "");
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${rendered}</t></is></c>`;
}

function numberCell(ref, style, value, formula) {
  const rendered = formatDisbursementAmount(parseDisbursementAmount(value, ref, { allowNegative: true }));
  return `<c r="${ref}" s="${style}" t="n">${formula ? `<f>${escapeXml(formula)}</f>` : ""}<v>${rendered}</v></c>`;
}

function blankCell(ref, style) {
  return `<c r="${ref}" s="${style}"/>`;
}

function amountSum(rows, selector, field = "paidAmount") {
  return rows
    .filter(selector)
    .reduce((sum, row) => sum + parseDisbursementAmount(row[field], `${row.id}.${field}`, { allowNegative: true }), 0n);
}

function adjustmentSum(rows) {
  return rows
    .filter((row) => row.adjustmentKind === "rounding_tail")
    .reduce((sum, row) => sum + parseDisbursementAmount(row.adjustment.amount, `${row.id}.adjustment.amount`, { allowNegative: true }), 0n);
}

function formatMoney(value) {
  return `${formatDisbursementAmount(value)}元`;
}

function rowNote(row, salaryById) {
  const pieces = [];
  if (row.voucherArchiveNames.length) pieces.push(`凭证：${row.voucherArchiveNames.join("、")}`);
  if (row.salaryArtifactId) pieces.push(`工资最终件：${salaryById.get(row.salaryArtifactId).storeReference}`);
  if (row.note) pieces.push(row.note);
  if (row.reason) pieces.push(`原因：${row.reason}`);
  if (row.followUp) pieces.push(`后续：${row.followUp}`);
  if (row.targetBatch) pieces.push(`去向：${row.targetBatch}`);
  if (row.adjustment) pieces.push(`尾差${row.adjustment.amount}元；来源行${row.adjustment.sourceRowId}；授权：${row.adjustment.authorization}`);
  return pieces.join("；");
}

function buildVisibleSummary(audit) {
  const rows = audit.rows;
  const normalInBatch = rows.filter((row) => row.scopeStatus === "in_batch" && row.adjustmentKind === "none");
  const summaries = [
    ["转账实际发放", amountSum(normalInBatch, (row) => row.paymentMethod === "transfer")],
    ["现金实际发放", amountSum(normalInBatch, (row) => row.paymentMethod === "cash")],
    ["本人留存", amountSum(normalInBatch, (row) => row.payoutStatus === "retained_by_self")],
    ["异常待说明", amountSum(normalInBatch, (row) => row.visibleStatus === "异常待说明", "payableAmount")],
    ["非本批", amountSum(rows, (row) => row.visibleStatus === "非本批", "payableAmount")],
    ["已忽略尾差", adjustmentSum(rows)],
    ["本批已核销", parseDisbursementAmount(audit.totals.reconciledTotal, "reconciledTotal", { allowNegative: true })],
    ["本批应发", parseDisbursementAmount(audit.totals.inBatchDueTotal, "inBatchDueTotal", { allowNegative: true })],
    ["本批实际发放", parseDisbursementAmount(audit.totals.inBatchPaidTotal, "inBatchPaidTotal", { allowNegative: true })],
    ["未闭合差额", parseDisbursementAmount(audit.totals.inBatchPaidTotal, "inBatchPaidTotal", { allowNegative: true }) - parseDisbursementAmount(audit.totals.inBatchDueTotal, "inBatchDueTotal", { allowNegative: true })],
  ];
  return Object.freeze(summaries.map(([label, amount]) => Object.freeze({ label, amount: formatDisbursementAmount(amount) })));
}

export function renderDisbursementSummary(audit) {
  if (!audit || audit.kind !== "compact-disbursement-audit-v1") fail("a compact-disbursement audit is required.");
  const visibleSummary = buildVisibleSummary(audit);
  const unresolved = audit.rows.filter((row) => ["待凭证", "待现金确认", "异常待说明"].includes(row.visibleStatus));
  const lines = [
    audit.batch.batchName,
    "",
    `本批应发：${audit.totals.inBatchDueTotal}元`,
    `本批实际发放：${audit.totals.inBatchPaidTotal}元`,
    `本批已核销：${audit.totals.reconciledTotal}元`,
    `核销状态：${audit.closureStatus === "closed" ? "已闭合" : "未结项"}`,
    "",
    "发放汇总：",
    ...visibleSummary.map((entry) => `- ${entry.label}：${entry.amount}元`),
    "",
    `凭证：${audit.totals.uniqueVoucherCount}份唯一文件，${audit.totals.voucherReferenceCount}条逐行引用。`,
  ];
  if (audit.salaryArtifacts.length) {
    lines.push("", "工资最终件：");
    for (const artifact of audit.salaryArtifacts) {
      lines.push(`- ${artifact.month.replace("-", ".")} ${artifact.salaryCategoryName}：${artifact.finalArtifactKind === "workbook" ? "最终表" : "最终图"}；${artifact.storeReference}`);
    }
  }
  if (unresolved.length) {
    lines.push("", "未结项：");
    for (const row of unresolved) lines.push(`- ${row.subject}｜${row.visibleStatus}｜${row.reason ?? "待补说明"}${row.followUp ? `｜${row.followUp}` : ""}`);
  } else {
    lines.push("", "未结项：无。");
  }
  lines.push("", "说明：本归档只记录核销与凭证对应，不执行付款，也不重新核算工资。", "");
  return lines.join("\n");
}

function columnsXml(template) {
  return template.columns.map((column) => `<col min="${column.min}" max="${column.max}" width="${column.width}" customWidth="1"/>`).join("");
}

function topSummaryRows(audit, template) {
  const style = template.styleRoles;
  const due = parseDisbursementAmount(audit.totals.inBatchDueTotal, "inBatchDueTotal", { allowNegative: true });
  const paid = parseDisbursementAmount(audit.totals.inBatchPaidTotal, "inBatchPaidTotal", { allowNegative: true });
  const rows = audit.rows;
  const normal = rows.filter((row) => row.scopeStatus === "in_batch" && row.adjustmentKind === "none");
  const definitions = [
    { label: "本批总额", expected: due, paid, method: "综合", status: audit.closureStatus === "closed" ? "已核销" : "待凭证", note: "应发与实际发放总额" },
    { label: "转账实际发放", paid: amountSum(normal, (row) => row.paymentMethod === "transfer"), method: "转账", status: "已核销" },
    { label: "现金实际发放", paid: amountSum(normal, (row) => row.paymentMethod === "cash"), method: "现金", status: rows.some((row) => row.visibleStatus === "待现金确认") ? "待现金确认" : "已核销" },
    { label: "本人留存", paid: amountSum(normal, (row) => row.payoutStatus === "retained_by_self"), method: "本人留存", status: rows.some((row) => row.payoutStatus === "retained_by_self" && row.visibleStatus !== "已核销") ? "待凭证" : "已核销" },
    { label: "异常", expected: amountSum(normal, (row) => row.visibleStatus === "异常待说明", "payableAmount"), status: "异常待说明" },
    { label: "非本批", expected: amountSum(rows, (row) => row.visibleStatus === "非本批", "payableAmount"), status: "非本批" },
    { label: "尾差", difference: adjustmentSum(rows), status: "已忽略尾差" },
    { label: "本批已核销", paid: parseDisbursementAmount(audit.totals.reconciledTotal, "reconciledTotal", { allowNegative: true }), status: "已核销" },
  ];
  return definitions.map((entry, index) => {
    const excelRow = 5 + index;
    const expected = entry.expected ?? 0n;
    const actual = entry.paid ?? 0n;
    const difference = entry.difference ?? actual - expected;
    return `<row r="${excelRow}" ht="24" customHeight="1">${textCell(`A${excelRow}`, style.text, entry.label)}${numberCell(`C${excelRow}`, style.amount, formatDisbursementAmount(expected))}${numberCell(`D${excelRow}`, style.amount, formatDisbursementAmount(actual))}${numberCell(`E${excelRow}`, style.amount, formatDisbursementAmount(difference))}${textCell(`F${excelRow}`, style.status, entry.method ?? "")}${textCell(`G${excelRow}`, style.status, entry.status)}${textCell(`I${excelRow}`, style.text, entry.note ?? "")}</row>`;
  });
}

function worksheetXml(audit, template) {
  const salaryById = new Map(audit.salaryArtifacts.map((entry) => [entry.artifactId, entry]));
  const style = template.styleRoles;
  const rowXml = [];
  rowXml.push(`<row r="1" ht="32" customHeight="1">${textCell("A1", style.title, "发放核对表")}</row>`);
  rowXml.push(`<row r="2" ht="16.5" customHeight="1">${textCell("A2", style.text, "核对期间")}${textCell("B2", style.subtitle, audit.batch.reimbursementPeriod ? `${audit.batch.reimbursementPeriod.start}—${audit.batch.reimbursementPeriod.end}` : audit.batch.salaryMonth.replace("-", "."))}${textCell("E2", style.text, "核销状态")}${textCell("F2", style.subtitle, audit.closureStatus === "closed" ? "已闭合" : "未结项")}${textCell("H2", style.text, "批次/事项")}${textCell("I2", style.subtitle, audit.batch.batchName)}</row>`);
  rowXml.push(`<row r="3" ht="24" customHeight="1">${textCell("A3", style.header, "发放汇总（逐项核对）")}</row>`);
  rowXml.push(`<row r="4" ht="26" customHeight="1">${textCell("A4", style.header, "资金来源/汇总")}${textCell("C4", style.header, "应到/金额")}${textCell("D4", style.header, "实际到账")}${textCell("E4", style.header, "差额")}${textCell("F4", style.header, "方式")}${textCell("G4", style.header, "状态")}${textCell("I4", style.header, "凭证/备注")}</row>`);
  rowXml.push(...topSummaryRows(audit, template));
  const due = audit.totals.inBatchDueTotal;
  const paid = audit.totals.inBatchPaidTotal;
  const difference = formatDisbursementAmount(parseDisbursementAmount(paid, "paid", { allowNegative: true }) - parseDisbursementAmount(due, "due", { allowNegative: true }));
  rowXml.push(`<row r="13" ht="28" customHeight="1">${textCell("A13", style.summaryLabel, "合计")}${numberCell("C13", style.summaryAmount, due)}${numberCell("D13", style.summaryAmount, paid)}${numberCell("E13", style.summaryAmount, difference)}${textCell("G13", style.status, audit.closureStatus === "closed" ? "已核销" : "待凭证")}${textCell("I13", style.summaryLabel, `唯一凭证${audit.totals.uniqueVoucherCount}份；逐行引用${audit.totals.voucherReferenceCount}条`)}</row>`);
  rowXml.push(`<row r="14" ht="8" customHeight="1"></row>`);
  rowXml.push(`<row r="15" ht="24" customHeight="1">${textCell("A15", style.header, "人员发放（按姓名/事项登记）")}</row>`);
  rowXml.push(`<row r="16" ht="26" customHeight="1">${HEADERS.map((header, index) => textCell(`${String.fromCharCode(65 + index)}16`, style.header, header)).join("")}</row>`);
  let excelRow = template.dataStartRow;
  for (const row of audit.rows) {
    const cells = [
      textCell(`A${excelRow}`, style.text, row.subject),
      numberCell(`B${excelRow}`, style.amount, row.amounts.xiaohongshu),
      numberCell(`C${excelRow}`, style.amount, row.amounts.company),
      numberCell(`D${excelRow}`, style.amount, row.amounts.residence),
      textCell(`E${excelRow}`, style.status, row.salaryArtifactId ? salaryById.get(row.salaryArtifactId).salaryCategoryName : ""),
      numberCell(`F${excelRow}`, style.amount, row.amounts.salary),
      numberCell(`G${excelRow}`, style.amount, row.payableAmount, `ROUND(SUM(B${excelRow}:D${excelRow},F${excelRow}),3)`),
      numberCell(`H${excelRow}`, style.amount, row.paidAmount),
      textCell(`I${excelRow}`, style.status, row.paymentMethodDisplay),
      textCell(`J${excelRow}`, style.status, row.visibleStatus),
      textCell(`K${excelRow}`, style.text, rowNote(row, salaryById)),
    ];
    rowXml.push(`<row r="${excelRow}" ht="36" customHeight="1">${cells.join("")}</row>`);
    excelRow += 1;
  }
  const actualDataEndRow = excelRow - 1;
  const dataEndRow = Math.max(template.minimumDataEndRow, actualDataEndRow);
  while (excelRow <= dataEndRow) {
    rowXml.push(`<row r="${excelRow}" ht="24" customHeight="1">${blankCell(`A${excelRow}`, style.text)}${blankCell(`B${excelRow}`, style.amount)}${blankCell(`C${excelRow}`, style.amount)}${blankCell(`D${excelRow}`, style.amount)}${blankCell(`E${excelRow}`, style.status)}${blankCell(`F${excelRow}`, style.amount)}${blankCell(`G${excelRow}`, style.amount)}${blankCell(`H${excelRow}`, style.amount)}${blankCell(`I${excelRow}`, style.status)}${blankCell(`J${excelRow}`, style.status)}${blankCell(`K${excelRow}`, style.text)}</row>`);
    excelRow += 1;
  }
  const totalRow = excelRow;
  const includedRows = audit.rows.filter((row) => row.scopeStatus === "in_batch" && row.adjustmentKind === "none");
  const cachedColumnTotal = (field) => formatDisbursementAmount(includedRows.reduce((sum, row) => sum + parseDisbursementAmount(field === "paidAmount" || field === "payableAmount" ? row[field] : row.amounts[field], field, { allowNegative: field !== "salary" }), 0n));
  const sumIfFormula = (column) => `ROUND(SUMIFS(${column}${template.dataStartRow}:${column}${dataEndRow},J${template.dataStartRow}:J${dataEndRow},"<>非本批",J${template.dataStartRow}:J${dataEndRow},"<>已忽略尾差"),3)`;
  rowXml.push(`<row r="${totalRow}" ht="28" customHeight="1">${textCell(`A${totalRow}`, style.summaryLabel, "合计")}${numberCell(`B${totalRow}`, style.summaryAmount, cachedColumnTotal("xiaohongshu"), sumIfFormula("B"))}${numberCell(`C${totalRow}`, style.summaryAmount, cachedColumnTotal("company"), sumIfFormula("C"))}${numberCell(`D${totalRow}`, style.summaryAmount, cachedColumnTotal("residence"), sumIfFormula("D"))}${numberCell(`F${totalRow}`, style.summaryAmount, cachedColumnTotal("salary"), sumIfFormula("F"))}${numberCell(`G${totalRow}`, style.summaryAmount, audit.totals.inBatchDueTotal, sumIfFormula("G"))}${numberCell(`H${totalRow}`, style.summaryAmount, audit.totals.inBatchPaidTotal, sumIfFormula("H"))}${textCell(`K${totalRow}`, style.summaryLabel, `发放差额：${difference}`)}</row>`);
  const lastRow = totalRow;
  const mergeRows = Array.from({ length: 8 }, (_, index) => 5 + index);
  const merges = ["A1:K1", "B2:D2", "F2:G2", "I2:K2", "A3:K3", "A4:B4", "G4:H4", "I4:K4", "A13:B13", "G13:H13", "I13:K13", "A15:K15", ...mergeRows.flatMap((row) => [`A${row}:B${row}`, `G${row}:H${row}`, `I${row}:K${row}`])];
  const conditionalStatusFormula = (value) => escapeXml(`$J${template.dataStartRow}="${value}"`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:K${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="100"><pane ySplit="${template.headerRow}" topLeftCell="A${template.dataStartRow}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${template.dataStartRow}" sqref="A${template.dataStartRow}"/></sheetView></sheetViews>
  <sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>
  <cols>${columnsXml(template)}</cols>
  <sheetData>${rowXml.join("")}</sheetData>
  <autoFilter ref="A${template.headerRow}:K${dataEndRow}"/>
  <mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>
  <conditionalFormatting sqref="J${template.dataStartRow}:J${dataEndRow}"><cfRule type="expression" priority="1" dxfId="7" stopIfTrue="1"><formula>${conditionalStatusFormula("已核销")}</formula></cfRule><cfRule type="expression" priority="2" dxfId="6" stopIfTrue="1"><formula>${conditionalStatusFormula("待凭证")}</formula></cfRule><cfRule type="expression" priority="3" dxfId="5" stopIfTrue="1"><formula>${conditionalStatusFormula("待现金确认")}</formula></cfRule><cfRule type="expression" priority="4" dxfId="5" stopIfTrue="1"><formula>${conditionalStatusFormula("异常待说明")}</formula></cfRule><cfRule type="expression" priority="5" dxfId="8" stopIfTrue="1"><formula>${conditionalStatusFormula("非本批")}</formula></cfRule><cfRule type="expression" priority="6" dxfId="9" stopIfTrue="1"><formula>${conditionalStatusFormula("已忽略尾差")}</formula></cfRule></conditionalFormatting>
  <dataValidations count="4"><dataValidation sqref="B${template.dataStartRow}:D${dataEndRow} H${template.dataStartRow}:H${dataEndRow}" showErrorMessage="1" allowBlank="1" type="decimal" operator="between"><formula1>-1000000000000</formula1><formula2>1000000000000</formula2></dataValidation><dataValidation sqref="F${template.dataStartRow}:F${dataEndRow}" showErrorMessage="1" allowBlank="1" type="decimal" operator="between"><formula1>0</formula1><formula2>1000000000000</formula2></dataValidation><dataValidation sqref="I${template.dataStartRow}:I${dataEndRow}" showErrorMessage="1" allowBlank="1" type="list"><formula1>"转账,现金,本人留存,—"</formula1></dataValidation><dataValidation sqref="J${template.dataStartRow}:J${dataEndRow}" showErrorMessage="1" allowBlank="1" type="list"><formula1>"已核销,待凭证,待现金确认,异常待说明,非本批,已忽略尾差"</formula1></dataValidation></dataValidations>
  <printOptions horizontalCentered="1" verticalCentered="0"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
  <pageSetup orientation="landscape" paperSize="9" fitToHeight="2" fitToWidth="1" pageOrder="downThenOver"/>
</worksheet>`;
}

async function buildWorkbookBytes(audit) {
  const template = await loadDisbursementTemplate();
  const zip = await JSZip.loadAsync(template.templateBytes, { createFolders: false });
  const dataEndRow = Math.max(template.minimumDataEndRow, template.dataStartRow + audit.rows.length - 1);
  const totalRow = dataEndRow + 1;
  const generatedWorksheetXml = worksheetXml(audit, template);
  const generatedWorkbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><workbookPr/><bookViews><workbookView visibility="visible" firstSheet="0" activeTab="0"/></bookViews><sheets><sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${DISBURSEMENT_WORKSHEET_NAME}" sheetId="1" state="visible" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${DISBURSEMENT_WORKSHEET_NAME}'!$A$${template.headerRow}:$K$${dataEndRow}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">'${DISBURSEMENT_WORKSHEET_NAME}'!$${template.headerRow}:$${template.headerRow}</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">'${DISBURSEMENT_WORKSHEET_NAME}'!$A$1:$K$${totalRow}</definedName></definedNames><calcPr calcId="124519" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const stylesXmlText = await zip.file("xl/styles.xml").async("string");
  const themeXmlText = await zip.file("xl/theme/theme1.xml").async("string");
  const styleAudit = auditOpenedWorkbookStyleContract({
    contract: template.styleContract,
    templateId: "compact-disbursement",
    templateDefinition: template.templateDefinition,
    styleRoles: template.styleRoles,
    parts: { stylesXml: stylesXmlText, themeXml: themeXmlText, worksheetXml: generatedWorksheetXml, workbookXml: generatedWorkbookXml },
    layoutMode: "generated",
  });
  zip.file("xl/worksheets/sheet1.xml", generatedWorksheetXml, { date: FIXED_ZIP_DATE, createFolders: false });
  zip.file("xl/workbook.xml", generatedWorkbookXml, { date: FIXED_ZIP_DATE, createFolders: false });
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  if (bytes.length > MAX_WORKBOOK_BYTES) fail("generated workbook exceeds the 32 MiB limit.");
  return Object.freeze({ bytes, template, styleAudit });
}

export async function inspectCompactDisbursementWorkbookBytes(bytes, suppliedTemplate = undefined) {
  if (!(bytes instanceof Uint8Array)) fail("workbook inspection requires bytes.");
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch (error) {
    fail(`generated workbook ZIP is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const worksheetXmlText = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
  const stylesXmlText = await zip.file("xl/styles.xml")?.async("string");
  const themeXmlText = await zip.file("xl/theme/theme1.xml")?.async("string");
  if (!workbookXml || !worksheetXmlText || !stylesXmlText || !themeXmlText) fail("generated workbook lacks its bound template/style parts.");
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?\s*>/giu) ?? [];
  if (sheetTags.length !== 1 || !sheetTags[0].includes(`name="${DISBURSEMENT_WORKSHEET_NAME}"`) || /state="(?:hidden|veryHidden)"/iu.test(sheetTags[0])) {
    fail("generated workbook must contain exactly one visible 发放核对表 worksheet.");
  }
  const worksheetParts = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/iu.test(name));
  if (worksheetParts.length !== 1 || worksheetParts[0] !== "xl/worksheets/sheet1.xml") fail("generated workbook contains an extra worksheet part.");
  for (const header of HEADERS) if (!worksheetXmlText.includes(escapeXml(header))) fail(`generated workbook is missing header ${header}.`);
  if (!/<sheetView\b[^>]*showGridLines="0"/iu.test(worksheetXmlText)) fail("generated workbook must hide gridlines.");
  const template = suppliedTemplate ?? await loadDisbursementTemplate();
  if (sha256Bytes(stylesXmlText) !== template.stylesPartSha256 || sha256Bytes(themeXmlText) !== template.themePartSha256) fail("generated workbook style/theme parts differ from the bound template.");
  const styleAudit = auditOpenedWorkbookStyleContract({
    contract: template.styleContract,
    templateId: "compact-disbursement",
    templateDefinition: template.templateDefinition,
    styleRoles: template.styleRoles,
    parts: { stylesXml: stylesXmlText, themeXml: themeXmlText, worksheetXml: worksheetXmlText, workbookXml },
    layoutMode: "generated",
  });
  const dataRows = parseDisbursementWorksheetRows(worksheetXmlText, template);
  return Object.freeze({
    sheetCount: 1,
    visibleSheetCount: 1,
    sheetName: DISBURSEMENT_WORKSHEET_NAME,
    hiddenSheetCount: 0,
    dataStartRow: template.dataStartRow,
    headerDigest: canonicalDigest(HEADERS),
    worksheetSha256: sha256Bytes(worksheetXmlText),
    styleBinding: styleAudit.binding,
    dataRows,
    dataRowsDigest: canonicalDigest(dataRows),
  });
}

export async function buildDisbursementArchiveBytes(audit) {
  const summaryText = renderDisbursementSummary(audit);
  const summaryBytes = Buffer.from(summaryText, "utf8");
  const generatedWorkbook = await buildWorkbookBytes(audit);
  const workbookBytes = generatedWorkbook.bytes;
  const workbookInspection = await inspectCompactDisbursementWorkbookBytes(workbookBytes, generatedWorkbook.template);
  const vouchers = audit.voucherArchive.map((entry) => {
    const bytes = audit.runtime?.voucherBytesBySha256?.get(entry.sha256);
    if (!bytes || sha256Bytes(bytes) !== entry.sha256 || bytes.length !== entry.size) fail(`voucher runtime bytes are missing for ${entry.archiveName}.`);
    return Object.freeze({ ...entry, bytes: Buffer.from(bytes) });
  });
  const bindings = Object.freeze({
    summary: Object.freeze({ name: DISBURSEMENT_SUMMARY_FILENAME, sha256: sha256Bytes(summaryBytes), size: summaryBytes.length }),
    workbook: Object.freeze({
      name: DISBURSEMENT_WORKBOOK_FILENAME,
      sha256: sha256Bytes(workbookBytes),
      size: workbookBytes.length,
      inspection: workbookInspection,
      template: Object.freeze({
        sha256: generatedWorkbook.template.templateSha256,
        manifestSha256: generatedWorkbook.template.templateManifestSha256,
        styleContractSha256: generatedWorkbook.template.styleContractSha256,
        styleBindingDigest: workbookInspection.styleBinding.bindingDigest,
      }),
    }),
    vouchers: Object.freeze(vouchers.map((entry) => Object.freeze({ name: entry.archiveName, sha256: entry.sha256, size: entry.size, sourceIds: entry.sourceIds, rowReferences: entry.rowReferences }))),
  });
  const artifactDigest = canonicalDigest(bindings);
  return Object.freeze({ summaryText, summaryBytes, workbookBytes, workbookInspection, vouchers: Object.freeze(vouchers), bindings, artifactDigest });
}

async function writeExclusive(filePath, bytes) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const snapshot = await readStableBinaryFile(filePath, { maxBytes: Math.max(bytes.length, 1) });
  if (snapshot.sha256 !== sha256Bytes(bytes) || snapshot.size !== bytes.length) fail(`exclusive write verification failed for ${filePath}.`);
  return Object.freeze({ path: filePath, sha256: snapshot.sha256, size: snapshot.size });
}

export async function buildDisbursementArchive(audit, outputRoot) {
  const resolvedOutputRoot = path.resolve(outputRoot);
  const parent = path.dirname(resolvedOutputRoot);
  if (resolvedOutputRoot === parent) fail("outputRoot is invalid.");
  const built = await buildDisbursementArchiveBytes(audit);
  const createdFiles = [];
  let rootCreated = false;
  let voucherDirectoryCreated = false;
  try {
    await fs.mkdir(resolvedOutputRoot, { recursive: false });
    rootCreated = true;
    const voucherDirectory = path.join(resolvedOutputRoot, DISBURSEMENT_VOUCHER_DIRECTORY);
    await fs.mkdir(voucherDirectory, { recursive: false });
    voucherDirectoryCreated = true;
    const summary = await writeExclusive(path.join(resolvedOutputRoot, DISBURSEMENT_SUMMARY_FILENAME), built.summaryBytes);
    createdFiles.push(summary);
    const workbook = await writeExclusive(path.join(resolvedOutputRoot, DISBURSEMENT_WORKBOOK_FILENAME), built.workbookBytes);
    createdFiles.push(workbook);
    const vouchers = [];
    for (const entry of built.vouchers) {
      const written = await writeExclusive(path.join(voucherDirectory, entry.archiveName), entry.bytes);
      createdFiles.push(written);
      vouchers.push(Object.freeze({ ...written, name: entry.archiveName, sourceIds: entry.sourceIds, rowReferences: entry.rowReferences }));
    }
    const rootEntries = (await fs.readdir(resolvedOutputRoot)).sort();
    if (canonicalDigest(rootEntries) !== canonicalDigest([...DISBURSEMENT_FINAL_ROOT_ENTRIES].sort())) fail("candidate archive root does not contain exactly the three required entries.");
    return Object.freeze({
      outputRoot: resolvedOutputRoot,
      summary: Object.freeze({ ...summary, text: built.summaryText }),
      workbook: Object.freeze({ ...workbook, inspection: built.workbookInspection }),
      voucherDirectory,
      vouchers: Object.freeze(vouchers),
      artifactDigest: built.artifactDigest,
      bindings: built.bindings,
      ownedFiles: Object.freeze(createdFiles),
    });
  } catch (error) {
    for (const entry of [...createdFiles].reverse()) await fs.unlink(entry.path).catch(() => {});
    if (voucherDirectoryCreated) await fs.rmdir(path.join(resolvedOutputRoot, DISBURSEMENT_VOUCHER_DIRECTORY)).catch(() => {});
    if (rootCreated) await fs.rmdir(resolvedOutputRoot).catch(() => {});
    throw error;
  }
}
