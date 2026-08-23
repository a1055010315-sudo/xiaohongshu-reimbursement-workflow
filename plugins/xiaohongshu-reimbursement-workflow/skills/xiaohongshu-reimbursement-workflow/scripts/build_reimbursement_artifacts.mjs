import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { formatMilliunits, loadProfileRegistry, parseMilliunits } from "./finance_domain.mjs";
import { loadArtifactTemplates } from "./template_assets.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  inspectFullyDecodedImageBytes,
  loadBundledDependency,
  mapSettledLimit,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";

export const REIMBURSEMENT_ARTIFACT_BUILD_KIND = "reimbursement-artifact-build-request-v1";
export const REIMBURSEMENT_ARTIFACT_RESULT_KIND = "reimbursement-artifact-build-batch-v1";

const STAGING_PREFIX = "codex-xhs-artifacts-";
const TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SUMMARY_ANNOTATION_KINDS = new Set(["commission", "bonus", "allowance"]);
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const imageMetadataCache = new Map();
const GENERATED_THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Codex Reimbursement"><a:themeElements><a:clrScheme name="Codex"><a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="176B4D"/></a:dk2><a:lt2><a:srgbClr val="DDEFE6"/></a:lt2><a:accent1><a:srgbClr val="176B4D"/></a:accent1><a:accent2><a:srgbClr val="E94B64"/></a:accent2><a:accent3><a:srgbClr val="FFE4C2"/></a:accent3><a:accent4><a:srgbClr val="6B7280"/></a:accent4><a:accent5><a:srgbClr val="0EA5E9"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Codex"><a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme><a:fmtScheme name="Codex"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>';

function fail(message) {
  throw new Error(`Reimbursement Artifact Builder ${message}`);
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
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

function exactKeys(value, allowed, field) {
  record(value, field);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function errorHasCode(error, code) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    if (current.code === code) return true;
    seen.add(current);
  }
  return false;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

function sumMilliunits(items) {
  return items.reduce((total, item) => total + item.milliunits, 0n);
}

function sumReimbursementMilliunits(items) {
  return items.reduce((total, item) => total + item.reimbursementMilliunits, 0n);
}

function compactDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) fail(`date ${isoDate} must be ISO YYYY-MM-DD.`);
  return `${match[1]}.${Number(match[2])}.${Number(match[3])}`;
}

function displayPeriod(mainPeriod) {
  return mainPeriod.start === mainPeriod.end
    ? compactDate(mainPeriod.start)
    : `${compactDate(mainPeriod.start)}-${compactDate(mainPeriod.end)}`;
}

function supplementSummary(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.reportingKind !== "supplement") continue;
    if (!groups.has(transaction.person)) groups.set(transaction.person, []);
    groups.get(transaction.person).push(transaction);
  }
  const entries = [...groups].map(([person, items]) => {
    const ordered = [...items].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
    const start = ordered[0].date;
    const end = ordered.at(-1).date;
    const period = start === end ? compactDate(start) : `${compactDate(start)}-${compactDate(end)}`;
    const amount = formatMilliunits(ordered.reduce((sum, item) => sum + item.reimbursementMilliunits, 0n));
    const reasons = [...new Set(ordered.map((item) => item.supplementReason))];
    return { person, transactions: ordered, start, end, period, amount, count: ordered.length, reasons };
  });
  return {
    entries,
    suffix: entries.length === 0
      ? ""
      : `（含${entries.map((entry) => `${entry.person}${entry.period}补报${entry.count}笔${entry.amount}元`).join("、")}）`,
  };
}

function chineseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) fail(`summary date ${value} is invalid.`);
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function fillSummaryLine(pattern, replacements, field) {
  let output = pattern;
  for (const [placeholder, value] of Object.entries(replacements)) output = output.replaceAll(placeholder, value);
  if (/<[^>]+>/u.test(output)) fail(`summary template ${field} retains an unresolved placeholder.`);
  return output;
}

function summaryPatterns(template) {
  const normalized = template.text.replaceAll("\r\n", "\n");
  const body = normalized.split(/\n填写规则：\n/u, 1)[0];
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const find = (placeholder, field) => {
    const line = lines.find((item) => item.includes(placeholder));
    if (!line) fail(`summary template has no ${field} line.`);
    return line;
  };
  return {
    title: lines[0],
    person: find("<报销人1>", "person"),
    annotation: find("<含提成人员>", "annotation"),
    supplement: find("<补报人员>", "supplement"),
    company: find("<对公事项或主体>", "company-paid"),
    total: find("<实际报销总额>", "reimbursement-total"),
  };
}

function summaryClause(pattern, replacements, field) {
  const clause = /（([^（）]*)）/u.exec(pattern)?.[1];
  if (!clause) fail(`summary template ${field} line has no full-width parenthetical clause.`);
  return fillSummaryLine(clause, replacements, field);
}

function renderProfileSummary(profile, mainPeriod, transactions, supplements, annotations, template) {
  const groups = new Map();
  for (const transaction of transactions) {
    const displayLabel = transaction.settlement === "employee_reimbursement" ? transaction.person : transaction.label;
    const key = JSON.stringify([displayLabel, transaction.settlement]);
    const existing = groups.get(key);
    if (existing) {
      existing.total += transaction.milliunits;
      existing.reimbursementTotal += transaction.reimbursementMilliunits;
    } else {
      groups.set(key, {
        label: displayLabel,
        settlement: transaction.settlement,
        total: transaction.milliunits,
        reimbursementTotal: transaction.reimbursementMilliunits,
        sourceOrder: transaction.sourceOrder,
      });
    }
  }
  const employee = transactions.filter((item) => item.settlement === "employee_reimbursement");
  const supplementByPerson = new Map(supplements.entries.map((entry) => [entry.person, entry]));
  const annotationsByPerson = new Map();
  for (const annotation of annotations) {
    if (!annotationsByPerson.has(annotation.person)) annotationsByPerson.set(annotation.person, []);
    annotationsByPerson.get(annotation.person).push(annotation);
  }
  const patterns = summaryPatterns(template);
  const kindLabels = record(template.definition.annotationKindLabels, "summary template annotationKindLabels");
  const periodText = `${chineseDate(mainPeriod.start)}—${chineseDate(mainPeriod.end)}`;
  let title = patterns.title.replace("YYYY年M月D日—YYYY年M月D日", periodText);
  if (profile.targetCategory !== "小红书报销") title = title.replace("小红书报销", profile.targetCategory);
  if (/YYYY|<[^>]+>/u.test(title)) fail("summary template title retains an unresolved placeholder.");
  const lines = [title, ""];
  for (const group of [...groups.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    if (group.settlement !== "employee_reimbursement") continue;
    const supplement = supplementByPerson.get(group.label);
    const personAnnotations = annotationsByPerson.get(group.label) ?? [];
    const personLine = fillSummaryLine(patterns.person, {
      "<报销人1>": group.label,
      "<实报金额>": `${formatMilliunits(group.reimbursementTotal)}元`,
    }, "person");
    const clauses = personAnnotations.map((annotation) => {
      const label = cleanText(kindLabels[annotation.kind], `summary template annotationKindLabels.${annotation.kind}`);
      return summaryClause(patterns.annotation, {
        "<提成期间>": displayPeriod(annotation.period),
        "<提成金额>": `${annotation.amount}元`,
      }, "annotation").replace("引流提成", label);
    });
    if (supplement) {
      clauses.push(summaryClause(patterns.supplement, {
        "<补报期间>": supplement.period,
        "<补报笔数>": String(supplement.count),
        "<补报金额>": `${supplement.amount}元`,
      }, "supplement"));
    }
    lines.push(`${personLine}${clauses.length ? `（${clauses.join("、")}）` : ""}`);
  }
  for (const group of [...groups.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    if (group.settlement !== "company_paid_no_reimbursement") continue;
    lines.push(fillSummaryLine(patterns.company, {
      "<对公事项或主体>": group.label,
      "<金额>": `${formatMilliunits(group.total)}元`,
    }, "company-paid"));
  }
  lines.push(fillSummaryLine(patterns.total, { "<实际报销总额>": `${formatMilliunits(employee.reduce((sum, item) => sum + item.reimbursementMilliunits, 0n))}元` }, "reimbursement-total"));
  const missing = transactions.filter((item) => item.missingEvidenceConfirmed === true);
  if (missing.length > 0) lines.push("", `无截图说明：${missing.map((item) => `${item.person}-${item.project}-${item.amount}元`).join("；")}`);
  for (const supplement of supplements.entries) {
    lines.push(`补报说明：${supplement.person} ${supplement.period}，${supplement.count}笔，${supplement.amount}元；原因：${supplement.reasons.join("；")}`);
  }
  const text = `${lines.join("\n")}\n`;
  return { text, sha256: sha256Bytes(Buffer.from(text, "utf8")), annotationCount: annotations.length, annotationDigest: canonicalDigest(annotations) };
}

function numericCell(reference, value, style = 2) {
  return `<c r="${reference}" s="${style}"><v>${xml(value)}</v></c>`;
}

function formulaCell(reference, formula, cached, style = 2) {
  return `<c r="${reference}" s="${style}"><f>${xml(formula)}</f><v>${xml(cached)}</v></c>`;
}

function moneyPrecision(value) {
  const match = /^-?\d+(?:\.(\d{1,3}))?$/u.exec(String(value));
  if (!match) fail(`money value ${value} is not canonical to at most three decimals.`);
  return (match[1] ?? "").replace(/0+$/u, "").length;
}

function moneyStyle(styles, role, value) {
  const style = styles[`${role}${moneyPrecision(value)}`];
  if (!Number.isSafeInteger(style) || style < 0) fail(`template has no ${role} money style.`);
  return style;
}

function moneyCell(reference, value, styles, role) {
  return numericCell(reference, value, moneyStyle(styles, role, value));
}

function moneyFormulaCell(reference, formula, cached, styles, role) {
  return formulaCell(reference, formula, cached, moneyStyle(styles, role, cached));
}

function blankCell(reference, style) {
  return `<c r="${reference}" s="${style}"/>`;
}

function textCell(reference, value, style = 0) {
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function rowXml(index, cells, { height = 21 } = {}) {
  return `<row r="${index}" ht="${height}" customHeight="1">${cells.join("")}</row>`;
}

function outputRowHeight(template, role, fallback) {
  const declared = template?.definition?.outputRowHeightPolicy?.[role];
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return declared;
  if (declared === "template") return template.definition.templateRowHeight;
  return fallback;
}

function excelSerial(isoDate, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) fail(`${field} must be an ISO date.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const timestamp = Date.UTC(year, month - 1, day);
  const checked = new Date(timestamp);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) fail(`${field} is not a calendar date.`);
  const days = Math.floor(timestamp / 86_400_000);
  return String(days + 25_569);
}

function columnName(index) {
  let value = index;
  let result = "";
  while (value > 0) {
    const offset = (value - 1) % 26;
    result = String.fromCharCode(65 + offset) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function workbookParts(sheetName, worksheetXml, drawing, printArea, template) {
  const imageDefaults = [...new Set((drawing?.media ?? []).map((item) => item.extension))]
    .map((extension) => `<Default Extension="${extension}" ContentType="${extension === "png" ? "image/png" : "image/jpeg"}"/>`)
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${drawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const definedNames = printArea
    ? `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$A$1:$F$${printArea.endRow}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$${Math.max(1, (template?.definition.dataStartRow ?? 7) - 1)}:$${Math.max(1, (template?.definition.dataStartRow ?? 7) - 1)}</definedName></definedNames>`
    : "";
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>${definedNames}<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`;
  const styles = template?.stylesXml;
  if (!styles) fail(`${sheetName} has no bound template styles.`);
  const now = "2026-01-01T00:00:00Z";
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Codex reimbursement workflow</dc:creator><cp:lastModifiedBy>Codex reimbursement workflow</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codex reimbursement workflow</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${xml(sheetName)}</vt:lpstr></vt:vector></TitlesOfParts></Properties>`;
  return new Map([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["docProps/core.xml", core],
    ["docProps/app.xml", app],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ["xl/styles.xml", styles],
    ["xl/theme/theme1.xml", template.themeXml ?? GENERATED_THEME_XML],
    ["xl/worksheets/sheet1.xml", worksheetXml],
  ]);
}

function contiguousRuns(items, key) {
  const runs = [];
  for (let start = 0; start < items.length;) {
    let end = start;
    while (end + 1 < items.length && key(items[end + 1]) === key(items[start])) end += 1;
    runs.push({ start, end });
    start = end + 1;
  }
  return runs;
}

function sortMergeRefs(refs) {
  const cell = (value) => {
    const match = /^([A-Z]+)(\d+)$/u.exec(value);
    let column = 0;
    for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
    return { row: Number(match[2]), column };
  };
  return [...refs].sort((left, right) => {
    const [leftStart, leftEnd] = left.split(":").map(cell);
    const [rightStart, rightEnd] = right.split(":").map(cell);
    return leftStart.row - rightStart.row || leftStart.column - rightStart.column || leftEnd.row - rightEnd.row || leftEnd.column - rightEnd.column;
  });
}

function detailDescription(transactions) {
  const mainCount = transactions.filter((item) => item.reportingKind === "current").length;
  const supplementCounts = new Map();
  for (const transaction of transactions) {
    if (transaction.reportingKind !== "supplement") continue;
    supplementCounts.set(transaction.person, (supplementCounts.get(transaction.person) ?? 0) + 1);
  }
  const supplementFact = supplementCounts.size === 0
    ? "无补报"
    : `补报：${[...supplementCounts].map(([person, count]) => `${person}${count}笔`).join("、")}`;
  const missingEvidenceCount = transactions.filter((item) => item.missingEvidenceConfirmed === true).length;
  const evidenceFact = missingEvidenceCount === 0
    ? "凭证对应关系详见截图表"
    : `缺少原始付款/订单凭证${missingEvidenceCount}笔，已在截图表标注`;
  return `说明：本表按人员分类；主期${mainCount}笔；${supplementFact}；主期与补报分开标注；${evidenceFact}。`;
}

function hasVoucherEvidence(transaction, evidenceById) {
  return transaction.evidence.some((evidenceId) => evidenceById.get(evidenceId)?.usage === "voucher");
}

function reimbursementAttribute(transaction, evidenceById) {
  const settlementText = transaction.settlement === "company_paid_no_reimbursement" ? "对公已付不实报" : "实报";
  return `${settlementText}；${hasVoucherEvidence(transaction, evidenceById) ? "有截图" : "无截图"}`;
}

function detailProjection(profile, period, transactions, styles, { suffix = "", subtitle = undefined, template, evidenceById } = {}) {
  const mergePolicy = template?.definition.outputMergePolicy ?? {};
  const groups = new Map();
  for (const transaction of transactions) {
    const key = JSON.stringify([transaction.settlement, transaction.person]);
    if (!groups.has(key)) groups.set(key, { settlement: transaction.settlement, person: transaction.person, transactions: [] });
    groups.get(key).transactions.push(transaction);
  }
  const sections = [...groups.values()].sort((left, right) => {
    const settlement = Number(left.settlement === "company_paid_no_reimbursement") - Number(right.settlement === "company_paid_no_reimbursement");
    return settlement || Math.min(...left.transactions.map((item) => item.sourceOrder)) - Math.min(...right.transactions.map((item) => item.sourceOrder));
  });
  const employee = transactions.filter((item) => item.settlement === "employee_reimbursement");
  const companyPaid = transactions.filter((item) => item.settlement === "company_paid_no_reimbursement");
  const feeTotal = sumMilliunits(transactions);
  const reimbursementTotal = sumReimbursementMilliunits(employee);
  const mainReimbursementTotal = sumReimbursementMilliunits(transactions.filter((item) => item.reportingKind === "current"));
  const supplementReimbursementTotal = sumReimbursementMilliunits(transactions.filter((item) => item.reportingKind === "supplement"));
  const supplementCount = transactions.filter((item) => item.reportingKind === "supplement").length;
  const companyPaidTotal = sumMilliunits(companyPaid);
  const supplementLabel = suffix ? suffix.slice(1, -1) : "无补报";
  const rows = [
    rowXml(1, [textCell("A1", `${period} 本次报销明细（按人员分类）`, styles.title)], { height: outputRowHeight(template, "title", 32) }),
    rowXml(2, [textCell("A2", subtitle ?? `主期：${period}｜补报：${supplementLabel}｜对公已付不实报单列`, styles.subtitle)], { height: outputRowHeight(template, "subtitle", 15) }),
    rowXml(3, [textCell("A3", "主期实报", styles.summaryLabel), textCell("C3", `补报（${supplementCount}笔）`, styles.companySummaryLabel ?? styles.summaryLabel), textCell("E3", "实报合计", styles.feeSummaryLabel ?? styles.summaryLabel)], { height: outputRowHeight(template, "summaryLabel", 15) }),
    rowXml(4, [
      moneyCell("A4", formatMilliunits(mainReimbursementTotal), styles, "summaryValue"),
      moneyCell("C4", formatMilliunits(supplementReimbursementTotal), styles, "companySummaryValue"),
      moneyFormulaCell("E4", "A4+C4", formatMilliunits(reimbursementTotal), styles, "feeSummaryValue"),
    ], { height: outputRowHeight(template, "summaryValue", 15) }),
    rowXml(5, [
      textCell("A5", `对公已付不实报：${formatMilliunits(companyPaidTotal)}`, styles.companyNote ?? styles.companySummaryLabel ?? styles.summaryLabel),
      textCell("D5", `费用合计：${formatMilliunits(feeTotal)}`, styles.feeNote ?? styles.feeSummaryLabel ?? styles.summaryLabel),
    ], { height: outputRowHeight(template, "notes", 24) }),
    rowXml(6, ["日期", "支出明细", "单笔金额", "费用组合计", "备注 / 分类", "报销属性"].map((value, index) => textCell(`${columnName(index + 1)}6`, value, styles.header)), { height: outputRowHeight(template, "header", 26) }),
  ];
  const merges = [...(template?.definition.staticMerges ?? [])];
  const mapped = [];
  let row = 7;
  for (const section of sections) {
    const ordered = [...section.transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
    const dataStart = row + 1;
    const dataEnd = row + ordered.length;
    const groupTotal = sumMilliunits(ordered);
    const sectionLabel = section.settlement === "company_paid_no_reimbursement"
      ? `${section.person}（对公已付不实报）｜${ordered.length}笔`
      : `${section.person}｜${ordered.length}笔`;
    rows.push(rowXml(row, [
      textCell(`A${row}`, sectionLabel, styles.groupLabel),
      textCell(`E${row}`, section.settlement === "company_paid_no_reimbursement" ? "对公费用合计" : "人员小计", styles.groupLabel),
      moneyFormulaCell(`F${row}`, `SUM(C${dataStart}:C${dataEnd})`, formatMilliunits(groupTotal), styles, "groupTotal"),
    ], { height: outputRowHeight(template, "group", 15) }));
    if (mergePolicy.personGroup) merges.push(`A${row}:D${row}`);
    row += 1;
    const dateRuns = contiguousRuns(ordered, (item) => item.date);
    const feeRuns = contiguousRuns(ordered, (item) => JSON.stringify([item.classification, item.settlement]));
    const attributeRuns = contiguousRuns(ordered, (item) => reimbursementAttribute(item, evidenceById));
    const dateByStart = new Map(dateRuns.map((run) => [run.start, run]));
    const feeByStart = new Map(feeRuns.map((run) => [run.start, run]));
    const attributeByStart = new Map(attributeRuns.map((run) => [run.start, run]));
    for (const [index, transaction] of ordered.entries()) {
      const cells = [];
      const dateRun = dateByStart.get(index);
      if (dateRun) {
        cells.push(numericCell(`A${row}`, excelSerial(transaction.date, `${transaction.id}.date`), styles.date));
        if (mergePolicy.sameDate && dateRun.end > dateRun.start) merges.push(`A${row}:A${row + dateRun.end - dateRun.start}`);
      }
      cells.push(textCell(`B${row}`, transaction.project, styles.text), moneyCell(`C${row}`, transaction.amount, styles, "amount"));
      const feeRun = feeByStart.get(index);
      if (feeRun) {
        const runItems = ordered.slice(feeRun.start, feeRun.end + 1);
        const endRow = row + feeRun.end - feeRun.start;
        cells.push(
        moneyFormulaCell(`D${row}`, `SUM(C${row}:C${endRow})`, formatMilliunits(sumMilliunits(runItems)), styles, "feeTotal"),
        textCell(`E${row}`, transaction.classification, styles.classification),
        );
        if (mergePolicy.expenseGroup && endRow > row) for (const column of ["D", "E"]) merges.push(`${column}${row}:${column}${endRow}`);
      }
      const attributeRun = attributeByStart.get(index);
      if (attributeRun) {
        const endRow = row + attributeRun.end - attributeRun.start;
        cells.push(textCell(`F${row}`, reimbursementAttribute(transaction, evidenceById), styles.settlement));
        if (mergePolicy.expenseGroup && endRow > row) merges.push(`F${row}:F${endRow}`);
      }
      const longText = Array.from(transaction.project).length > 24 || Array.from(transaction.classification).length > 14;
      rows.push(rowXml(row, cells, { height: longText ? outputRowHeight(template, "longText", 42) : outputRowHeight(template, "default", 24) }));
      mapped.push({ ...transaction, row });
      row += 1;
    }
  }
  const descriptionRow = row;
  rows.push(rowXml(descriptionRow, [
    textCell(`A${descriptionRow}`, detailDescription(transactions), styles.description),
    ...["B", "C", "D", "E", "F"].map((column) => blankCell(`${column}${descriptionRow}`, styles.description)),
  ], { height: outputRowHeight(template, "description", 28) }));
  if (mergePolicy.description) merges.push(`A${descriptionRow}:F${descriptionRow}`);
  const orderedMerges = sortMergeRefs(merges);
  const mergeXml = `<mergeCells count="${orderedMerges.length}">${orderedMerges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`;
  const columns = template?.columnsXml || '<cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/><col min="3" max="3" width="15" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/><col min="6" max="6" width="38" customWidth="1"/></cols>';
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A7" sqref="A7"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns}<sheetData>${rows.join("")}</sheetData>${mergeXml}<printOptions horizontalCentered="1" headings="0" gridLines="0"/><pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;8第 &amp;P 页 / 共 &amp;N 页</oddFooter></headerFooter></worksheet>`;
  return {
    worksheet,
    mapped,
    endRow: descriptionRow,
    merges: orderedMerges,
    printArea: { endRow: descriptionRow },
    totals: {
      sourceAmount: formatMilliunits(feeTotal),
      reimbursementAmount: formatMilliunits(reimbursementTotal),
      companyPaidNoReimbursementAmount: formatMilliunits(companyPaidTotal),
    },
    template,
  };
}

function supplementProjection(period, transactions, styles, { subtitle, template, evidenceById }) {
  const mergePolicy = template.definition.outputMergePolicy;
  const person = transactions[0].person;
  const total = sumMilliunits(transactions);
  const reimbursementTotal = sumReimbursementMilliunits(transactions);
  const subtitleHeight = Array.from(subtitle).length > 34 ? outputRowHeight(template, "longSubtitle", 30) : outputRowHeight(template, "subtitle", 28);
  const rows = [
    rowXml(1, [textCell("A1", `${person} ${period} 小红书补报明细`, styles.title)], { height: outputRowHeight(template, "title", 34) }),
    rowXml(2, [textCell("A2", subtitle, styles.subtitle)], { height: subtitleHeight }),
    rowXml(3, [textCell("A3", `补报实报合计：${formatMilliunits(reimbursementTotal)}元｜费用合计：${formatMilliunits(total)}元｜共${transactions.length}笔`, styles.summaryLabel)], { height: outputRowHeight(template, "summary", 24) }),
    rowXml(4, ["日期", "支出明细", "单笔金额", "费用组合计", "备注 / 分类", "报销属性"].map((value, index) => textCell(`${columnName(index + 1)}4`, value, styles.header)), { height: outputRowHeight(template, "header", 24) }),
  ];
  const merges = [...template.definition.staticMerges];
  const ordered = [...transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
  const dateStarts = new Map(contiguousRuns(ordered, (item) => item.date).map((run) => [run.start, run]));
  const expenseStarts = new Map(contiguousRuns(ordered, (item) => JSON.stringify([item.classification, item.settlement])).map((run) => [run.start, run]));
  const attributeStarts = new Map(contiguousRuns(ordered, (item) => reimbursementAttribute(item, evidenceById)).map((run) => [run.start, run]));
  let row = 5;
  for (const [index, transaction] of ordered.entries()) {
    const cells = [];
    const dateRun = dateStarts.get(index);
    if (dateRun) {
      cells.push(numericCell(`A${row}`, excelSerial(transaction.date, `${transaction.id}.date`), styles.date));
      if (mergePolicy.sameDate && dateRun.end > dateRun.start) merges.push(`A${row}:A${row + dateRun.end - dateRun.start}`);
    }
    cells.push(textCell(`B${row}`, transaction.project, styles.text), moneyCell(`C${row}`, transaction.amount, styles, "amount"));
    const expenseRun = expenseStarts.get(index);
    if (expenseRun) {
      const runItems = ordered.slice(expenseRun.start, expenseRun.end + 1);
      const endRow = row + expenseRun.end - expenseRun.start;
      cells.push(
        moneyFormulaCell(`D${row}`, `SUM(C${row}:C${endRow})`, formatMilliunits(sumMilliunits(runItems)), styles, "feeTotal"),
        textCell(`E${row}`, transaction.classification, styles.classification),
      );
      if (mergePolicy.expenseGroup && endRow > row) for (const column of ["D", "E"]) merges.push(`${column}${row}:${column}${endRow}`);
    }
    const attributeRun = attributeStarts.get(index);
    if (attributeRun) {
      const endRow = row + attributeRun.end - attributeRun.start;
      cells.push(textCell(`F${row}`, reimbursementAttribute(transaction, evidenceById), styles.settlement));
      if (mergePolicy.expenseGroup && endRow > row) merges.push(`F${row}:F${endRow}`);
    }
    const longText = Array.from(transaction.project).length > 18 || Array.from(transaction.classification).length > 12;
    rows.push(rowXml(row, cells, { height: longText ? outputRowHeight(template, "longText", 38) : outputRowHeight(template, "default", template.definition.templateRowHeight) }));
    row += 1;
  }
  const footerRow = row;
  rows.push(rowXml(footerRow, [
    textCell(`A${footerRow}`, "补报总计", styles.footerLabel),
    moneyFormulaCell(`C${footerRow}`, `SUM(C5:C${footerRow - 1})`, formatMilliunits(total), styles, "footerValue"),
  ], { height: outputRowHeight(template, "footer", 28) }));
  if (mergePolicy.footer) merges.push(`A${footerRow}:B${footerRow}`, `C${footerRow}:F${footerRow}`);
  const orderedMerges = sortMergeRefs(merges);
  const mergeXml = `<mergeCells count="${orderedMerges.length}">${orderedMerges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`;
  const columns = template.columnsXml || '<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="3" width="13" customWidth="1"/><col min="4" max="4" width="15" customWidth="1"/><col min="5" max="5" width="22" customWidth="1"/><col min="6" max="6" width="28" customWidth="1"/></cols>';
  const endRow = footerRow;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns}<sheetData>${rows.join("")}</sheetData>${mergeXml}<pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/></worksheet>`;
  return {
    worksheet,
    endRow,
    merges: orderedMerges,
    printArea: { endRow },
    totals: { sourceAmount: formatMilliunits(total), reimbursementAmount: formatMilliunits(reimbursementTotal) },
    template,
  };
}

export async function inspectEvidenceImage(bytes, field = "image") {
  let structural;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) fail(`${field} PNG dimensions are invalid.`);
    structural = { extension: "png", width, height };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 <= bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (sofMarkers.has(marker)) {
        if (length < 7) break;
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        if (width < 1 || height < 1) break;
        structural = { extension: "jpg", width, height };
        break;
      }
      offset += length;
    }
    if (!structural) fail(`${field} JPEG has no readable SOF dimensions.`);
  } else {
    fail(`${field} must be a PNG or JPEG image.`);
  }
  try {
    const hasJpegEoi = structural.extension !== "jpg" || (bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9);
    const validationBytes = hasJpegEoi ? bytes : Buffer.concat([bytes, Buffer.from([0xff, 0xd9])]);
    const decoded = await inspectFullyDecodedImageBytes(validationBytes, {
      failOn: "warning",
      limitInputPixels: 100_000_000,
      autoOrient: false,
    });
    if (decoded.width !== structural.width || decoded.height !== structural.height) fail(`${field} decoded pixels differ from its original bytes.`);
  } catch (error) {
    fail(`${field} cannot be decoded safely.`, error);
  }
  return structural;
}

function imageExtent(kind, policy) {
  if (!policy || policy.fit !== "contain" || policy.align !== "center" || !Number.isSafeInteger(policy.maxWidthPx) || !Number.isSafeInteger(policy.maxHeightPx) || policy.maxWidthPx < 1 || policy.maxHeightPx < 1) {
    fail("screenshot template outputImagePolicy must declare a positive contain/center box.");
  }
  const boxWidthPx = policy.maxWidthPx;
  const boxHeightPx = policy.maxHeightPx;
  const scale = Math.min(boxWidthPx / kind.width, boxHeightPx / kind.height);
  const widthPx = Math.max(1, Math.round(kind.width * scale));
  const heightPx = Math.max(1, Math.round(kind.height * scale));
  return {
    cx: widthPx * 9525,
    cy: heightPx * 9525,
    colOff: Math.floor((boxWidthPx - widthPx) / 2) * 9525,
    rowOff: Math.floor((boxHeightPx - heightPx) / 2) * 9525,
  };
}

function screenshotProjection(profile, transactions, evidenceById, templateStyles, template) {
  const maxImages = Math.max(3, ...transactions.map((item) => item.evidence.filter((id) => evidenceById.get(id)?.kind === "image").length));
  const rows = [];
  const headers = ["日期", "支出人/主体", "项目", "金额", "备注", ...Array.from({ length: maxImages }, (_, index) => `图${index + 1}`)];
  rows.push(rowXml(1, headers.map((value, index) => textCell(`${columnName(index + 1)}1`, value, templateStyles.header)), { height: 28.5 }));
  const anchors = [];
  const mediaBySha = new Map();
  const displayedContext = new Set();
  const relationships = [];
  for (const [index, transaction] of transactions.entries()) {
    const row = index + 2;
    const referencedImageIds = transaction.evidence.filter((id) => evidenceById.get(id)?.kind === "image");
    const imageIds = referencedImageIds.filter((id) => {
      const evidence = evidenceById.get(id);
      if (evidence.usage !== "context") return true;
      if (displayedContext.has(evidence.sha256)) return false;
      displayedContext.add(evidence.sha256);
      return true;
    });
    const note = referencedImageIds.length === 0 ? `${transaction.classification}｜无图片凭证` : transaction.classification;
    const styles = index % 2 === 0
      ? { date: templateStyles.oddDate, text: templateStyles.oddText, amount: templateStyles.oddAmount, note: templateStyles.oddNote, image: templateStyles.image }
      : { date: templateStyles.evenDate, text: templateStyles.evenText, amount: templateStyles.evenAmount, note: templateStyles.evenNote, image: templateStyles.image };
    rows.push(rowXml(row, [
      numericCell(`A${row}`, excelSerial(transaction.date, `${transaction.id}.date`), styles.date),
      textCell(`B${row}`, transaction.person, styles.text),
      textCell(`C${row}`, transaction.project, styles.text),
      moneyCell(`D${row}`, transaction.amount, templateStyles, index % 2 === 0 ? "oddAmount" : "evenAmount"),
      textCell(`E${row}`, note, styles.note),
      ...Array.from({ length: maxImages }, (_, imageIndex) => blankCell(`${columnName(6 + imageIndex)}${row}`, styles.image)),
    ], { height: imageIds.length > 0 ? outputRowHeight(template, "image", 172.5) : outputRowHeight(template, "noImage", template.definition.templateRowHeight) }));
    for (const [imageIndex, evidenceId] of imageIds.entries()) {
      const evidence = evidenceById.get(evidenceId);
      let media = mediaBySha.get(evidence.sha256);
      if (!media) {
        const ordinal = mediaBySha.size + 1;
        media = { ...evidence, ordinal, partName: `xl/media/image${ordinal}.${evidence.extension}`, relationshipId: `rId${ordinal}` };
        mediaBySha.set(evidence.sha256, media);
        relationships.push(media);
      }
      const extent = imageExtent(evidence, template.definition.outputImagePolicy);
      anchors.push({ row: row - 1, column: 5 + imageIndex, extent, relationshipId: media.relationshipId, name: `${transaction.id}-${imageIndex + 1}` });
    }
  }
  const drawingTag = anchors.length > 0 ? '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' : "";
  const fallbackColumns = `<cols><col min="1" max="1" width="12.5" customWidth="1"/><col min="2" max="2" width="15" customWidth="1"/><col min="3" max="3" width="40" customWidth="1"/><col min="4" max="4" width="13" customWidth="1"/><col min="5" max="5" width="48" customWidth="1"/><col min="6" max="${headers.length}" width="42" customWidth="1"/></cols>`;
  const columns = template.columnsXml || fallbackColumns;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns}<sheetData>${rows.join("")}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawingTag}</worksheet>`;
  if (anchors.length === 0) return { worksheet, drawing: null, endRow: transactions.length + 1, imageCount: 0, uniqueMediaCount: 0, imageReferenceCount: transactions.reduce((count, item) => count + item.evidence.filter((id) => evidenceById.get(id)?.kind === "image").length, 0), endColumn: columnName(headers.length), template };
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map((anchor, index) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.column}</xdr:col><xdr:colOff>${anchor.extent.colOff}</xdr:colOff><xdr:row>${anchor.row}</xdr:row><xdr:rowOff>${anchor.extent.rowOff}</xdr:rowOff></xdr:from><xdr:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="${xml(anchor.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${anchor.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("")}</xdr:wsDr>`;
  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map((item) => `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${path.basename(item.partName)}"/>`).join("")}</Relationships>`;
  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  return { worksheet, drawing: { xml: drawingXml, rels: drawingRels, sheetRels, media: relationships }, endRow: transactions.length + 1, imageCount: anchors.length, uniqueMediaCount: mediaBySha.size, imageReferenceCount: transactions.reduce((count, item) => count + item.evidence.filter((id) => evidenceById.get(id)?.kind === "image").length, 0), endColumn: columnName(headers.length), template };
}

async function writeWorkbook(filePath, sheetName, projection, beforeValidation = undefined) {
  const zip = new JSZip();
  const expectedParts = workbookParts(sheetName, projection.worksheet, projection.drawing, projection.printArea, projection.template);
  if (projection.drawing) {
    expectedParts.set("xl/drawings/drawing1.xml", projection.drawing.xml);
    expectedParts.set("xl/drawings/_rels/drawing1.xml.rels", projection.drawing.rels);
    expectedParts.set("xl/worksheets/_rels/sheet1.xml.rels", projection.drawing.sheetRels);
  }
  for (const [partName, content] of expectedParts) zip.file(partName, content);
  // PNG/JPEG bytes are already compressed. Storing them avoids recompressing every
  // unchanged voucher when a note or classification revision rebuilds the workbook.
  for (const media of projection.drawing?.media ?? []) zip.file(media.partName, media.bytes, { compression: "STORE" });
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const expectedSha256 = sha256Bytes(bytes);
  let created = false;
  try {
    const handle = await fs.open(filePath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeValidation) {
      await beforeValidation({ path: filePath, sheetName });
      const stable = await readStableBinaryFile(filePath);
      if (stable.sha256 !== expectedSha256 || stable.size !== bytes.length) fail(`${path.basename(filePath)} changed after exclusive write.`);
    }
    // Exclusive write + fsync binds the exact in-memory package. Gate 1 preview
    // independently rereads it before use, so an immediate second read only
    // duplicates I/O; the hook path above retains post-write tamper coverage.
    return { sha256: expectedSha256, size: bytes.length, partDigest: canonicalDigest([...expectedParts]), generatedStyleVersion: 1 };
  } catch (error) {
    if (created) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw new Error(`${error instanceof Error ? error.message : String(error)}; incomplete workbook cleanup: ${filePath}`, { cause: error });
      }
    }
    throw error;
  }
}

async function writeBoundBytes(filePath, bytes) {
  const expectedSha256 = sha256Bytes(bytes);
  let created = false;
  try {
    const handle = await fs.open(filePath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw new Error(`${error instanceof Error ? error.message : String(error)}; incomplete bound-byte cleanup: ${filePath}`, { cause: error });
      }
    }
    throw error;
  }
  // Gate consumers independently reread every bound artifact. The exclusive,
  // fsynced write already binds these exact bytes without an immediate duplicate read.
  return { sha256: expectedSha256, size: bytes.length };
}

async function writeTextSummary(filePath, summaryText) {
  const bytes = Buffer.from(summaryText, "utf8");
  const state = await writeBoundBytes(filePath, bytes);
  return { ...state, text: summaryText, textSha256: sha256Bytes(Buffer.from(summaryText, "utf8")) };
}

function validateCertificate(certificate, registry) {
  const required = new Set(["kind", "operationMode", "manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest", "factsDigest", "factsPreimage", "sourceCoverageDigest", "sourceCoveragePreimage", "certificateDigest"]);
  exactKeys(certificate, required, "reimbursementFactsCertificate");
  if (certificate.kind !== "reimbursement-manifest-facts-v1" || certificate.operationMode !== "reimbursement-batch") fail("certificate kind or operation is unsupported.");
  for (const field of ["manifestFileSha256", "manifestDigest", "configDigest", "profileConfigDigest", "factsDigest", "sourceCoverageDigest", "certificateDigest"]) cleanSha(certificate[field], field);
  if (certificate.profileConfigDigest !== registry.profileConfigDigest) fail("certificate profileConfigDigest differs from the fixed registry.");
  if (canonicalDigest(certificate.factsPreimage) !== certificate.factsDigest) fail("certificate factsDigest does not match its preimage.");
  if (canonicalDigest(certificate.sourceCoveragePreimage) !== certificate.sourceCoverageDigest) fail("certificate sourceCoverageDigest does not match its preimage.");
  const body = clone(certificate);
  delete body.certificateDigest;
  if (canonicalDigest(body) !== certificate.certificateDigest) fail("certificateDigest does not match the complete certificate body.");
  return certificate;
}

async function loadManifest(request, certificate) {
  const snapshot = await readStableUtf8JsonFile(request.manifestPath, { maxBytes: MAX_MANIFEST_BYTES });
  if (snapshot.sha256 !== request.manifestSha256 || snapshot.sha256 !== certificate.manifestFileSha256) fail("manifest SHA differs from the request or certificate.");
  const manifest = record(snapshot.value, "manifest");
  if (manifest.version !== 3 || manifest.operation?.mode !== "reimbursement-batch") fail("manifest must be an ordinary v3 reimbursement batch.");
  if (!Array.isArray(manifest.transactions) || !Array.isArray(manifest.files)) fail("manifest transactions/files are required.");
  return { manifest, snapshot };
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

function bindTransactions(manifest, certificate, registry) {
  const expectedById = new Map(certificate.factsPreimage.transactions.map((item) => [item.id, item]));
  if (expectedById.size !== manifest.transactions.length) fail("manifest transactions do not match the certificate count.");
  const sourceBindings = certificate.sourceCoveragePreimage?.transactionSourceRefs;
  if (!Array.isArray(sourceBindings) || sourceBindings.length !== expectedById.size) fail("certificate transaction source coverage is incomplete.");
  const sourceRefsByTransaction = new Map();
  for (const [index, binding] of sourceBindings.entries()) {
    const item = record(binding, `sourceCoveragePreimage.transactionSourceRefs[${index}]`);
    const transactionId = cleanText(item.transactionId, `sourceCoveragePreimage.transactionSourceRefs[${index}].transactionId`);
    if (sourceRefsByTransaction.has(transactionId) || !expectedById.has(transactionId)) fail(`certificate source coverage has invalid transaction ${transactionId}.`);
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0 || new Set(item.sourceRefs).size !== item.sourceRefs.length) fail(`certificate source refs for ${transactionId} are invalid.`);
    sourceRefsByTransaction.set(transactionId, [...item.sourceRefs].map((value, sourceIndex) => cleanText(value, `${transactionId}.sourceRefs[${sourceIndex}]`)).sort((left, right) => left.localeCompare(right)));
  }
  return manifest.transactions.map((raw, index) => {
    const expected = expectedById.get(raw.id);
    if (!expected) fail(`manifest.transactions[${index}] is absent from certificate facts.`);
    const profile = registry.profiles[expected.profileId];
    if (!profile) fail(`certificate transaction ${expected.id} has an unknown profile.`);
    for (const field of [
      "date", "person", "project", "label", "category", "classification", "sourceOrder", "settlement",
      "sourceAmount", "reimbursementAmount", "reportingKind",
    ]) {
      const rawValue = field === "reportingKind" && raw.date < manifest.batch.mainPeriod.start
        ? "supplement"
        : raw[field];
      if (rawValue !== expected[field]) fail(`manifest transaction ${expected.id} ${field} differs from certificate facts.`);
    }
    if ((raw.supplementReason ?? undefined) !== (expected.supplementReason ?? undefined)) {
      fail(`manifest transaction ${expected.id} supplementReason differs from certificate facts.`);
    }
    if (raw.amount !== undefined && raw.amount !== expected.amount) fail(`manifest transaction ${expected.id} amount differs from sourceAmount.`);
    if (!Array.isArray(raw.evidence) || new Set(raw.evidence).size !== raw.evidence.length) fail(`manifest transaction ${expected.id} evidence is invalid.`);
    if (!Array.isArray(raw.sourceRefs) || raw.sourceRefs.length === 0 || new Set(raw.sourceRefs).size !== raw.sourceRefs.length) fail(`manifest transaction ${expected.id} sourceRefs are invalid.`);
    const rawSourceRefs = [...raw.sourceRefs].map((value, sourceIndex) => cleanText(value, `${expected.id}.sourceRefs[${sourceIndex}]`)).sort((left, right) => left.localeCompare(right));
    const boundSourceRefs = sourceRefsByTransaction.get(expected.id);
    if (!boundSourceRefs || canonicalDigest(rawSourceRefs) !== canonicalDigest(boundSourceRefs)) fail(`manifest transaction ${expected.id} sourceRefs differ from certificate source coverage.`);
    const milliunits = parseMilliunits(expected.sourceAmount, `${expected.id}.sourceAmount`, { allowNegative: true });
    const reimbursementMilliunits = parseMilliunits(expected.reimbursementAmount, `${expected.id}.reimbursementAmount`, { allowNegative: true });
    if (formatMilliunits(milliunits) !== expected.amount) fail(`${expected.id}.amount is not canonical.`);
    if (formatMilliunits(reimbursementMilliunits) !== expected.reimbursementAmount) fail(`${expected.id}.reimbursementAmount is not canonical.`);
    return { ...clone(expected), milliunits, reimbursementMilliunits, sourceRefs: boundSourceRefs, evidence: [...raw.evidence], missingEvidenceConfirmed: raw.missingEvidenceConfirmed === true };
  });
}

function bindSummaryAnnotations(manifest, certificate, transactions) {
  const rawAnnotations = manifest.batch?.summaryAnnotations ?? [];
  const expectedAnnotations = certificate.factsPreimage?.summaryAnnotations;
  if (!Array.isArray(rawAnnotations) || !Array.isArray(expectedAnnotations) || rawAnnotations.length !== expectedAnnotations.length) {
    fail("manifest summaryAnnotations differ from certificate facts.");
  }
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const usedTransactionIds = new Set();
  return rawAnnotations.map((rawAnnotation, index) => {
    exactKeys(rawAnnotation, new Set(["profileId", "person", "kind", "period", "amount", "transactionIds", "sourceRefs"]), `manifest.batch.summaryAnnotations[${index}]`);
    exactKeys(rawAnnotation.period, new Set(["start", "end"]), `manifest.batch.summaryAnnotations[${index}].period`);
    const profileId = cleanText(rawAnnotation.profileId, `summaryAnnotations[${index}].profileId`);
    const person = cleanText(rawAnnotation.person, `summaryAnnotations[${index}].person`);
    const kind = cleanText(rawAnnotation.kind, `summaryAnnotations[${index}].kind`);
    if (!SUMMARY_ANNOTATION_KINDS.has(kind)) fail(`summaryAnnotations[${index}].kind is unsupported.`);
    const period = {
      start: cleanText(rawAnnotation.period.start, `summaryAnnotations[${index}].period.start`),
      end: cleanText(rawAnnotation.period.end, `summaryAnnotations[${index}].period.end`),
    };
    displayPeriod(period);
    if (period.end < period.start) fail(`summaryAnnotations[${index}] period is reversed.`);
    const amountMilliunits = parseMilliunits(rawAnnotation.amount, `summaryAnnotations[${index}].amount`, { allowNegative: true });
    if (formatMilliunits(amountMilliunits) !== rawAnnotation.amount) fail(`summaryAnnotations[${index}].amount is not canonical.`);
    if (!Array.isArray(rawAnnotation.transactionIds) || rawAnnotation.transactionIds.length === 0 || new Set(rawAnnotation.transactionIds).size !== rawAnnotation.transactionIds.length) fail(`summaryAnnotations[${index}].transactionIds are invalid.`);
    const selected = rawAnnotation.transactionIds.map((id, transactionIndex) => {
      const transactionId = cleanText(id, `summaryAnnotations[${index}].transactionIds[${transactionIndex}]`);
      const transaction = transactionById.get(transactionId);
      if (!transaction || usedTransactionIds.has(transactionId)) fail(`summaryAnnotations[${index}] has an unbound or reused transaction ${transactionId}.`);
      if (transaction.profileId !== profileId || transaction.person !== person || transaction.settlement !== "employee_reimbursement") fail(`summaryAnnotations[${index}] transaction ${transactionId} differs from its profile/person/settlement binding.`);
      return transaction;
    });
    if (sumReimbursementMilliunits(selected) !== amountMilliunits) fail(`summaryAnnotations[${index}].amount differs from its transaction reimbursement total.`);
    const transactionIds = [...selected].sort((left, right) => left.sourceOrder - right.sourceOrder).map((transaction) => transaction.id);
    if (!Array.isArray(rawAnnotation.sourceRefs) || rawAnnotation.sourceRefs.length === 0 || new Set(rawAnnotation.sourceRefs).size !== rawAnnotation.sourceRefs.length) fail(`summaryAnnotations[${index}].sourceRefs are invalid.`);
    const sourceRefs = [...rawAnnotation.sourceRefs].map((value, sourceIndex) => cleanText(value, `summaryAnnotations[${index}].sourceRefs[${sourceIndex}]`)).sort((left, right) => left.localeCompare(right));
    const expectedSourceRefs = [...new Set(selected.flatMap((transaction) => transaction.sourceRefs))].sort((left, right) => left.localeCompare(right));
    if (canonicalDigest(sourceRefs) !== canonicalDigest(expectedSourceRefs)) fail(`summaryAnnotations[${index}].sourceRefs differ from its transactions.`);
    const normalized = { profileId, person, kind, period, amount: formatMilliunits(amountMilliunits), transactionIds, sourceRefs };
    if (canonicalDigest(normalized) !== canonicalDigest(expectedAnnotations[index])) fail(`summaryAnnotations[${index}] differs from certificate facts.`);
    for (const transactionId of transactionIds) usedTransactionIds.add(transactionId);
    return normalized;
  });
}

async function loadEvidence(manifest) {
  const evidence = new Map();
  const usedIds = new Set(manifest.transactions.flatMap((item) => item.evidence ?? []));
  const bindings = [];
  const jobsBySha256 = new Map();
  for (const raw of manifest.files) {
    if (!usedIds.has(raw.id)) continue;
    if (raw.role !== "material" || raw.disposition !== "used") fail(`evidence ${raw.id} is not a used material.`);
    const filePath = path.resolve(cleanText(raw.path, `files.${raw.id}.path`));
    const expectedSha256 = cleanSha(raw.sha256, `files.${raw.id}.sha256`);
    const binding = { raw, filePath, expectedSha256 };
    bindings.push(binding);
    const existing = jobsBySha256.get(expectedSha256);
    if (existing) {
      if (raw.kind === "image") existing.requiresImageDecode = true;
    } else {
      jobsBySha256.set(expectedSha256, {
        expectedSha256,
        filePath,
        evidenceId: raw.id,
        requiresImageDecode: raw.kind === "image",
      });
    }
  }
  const jobs = [...jobsBySha256.values()];
  let decodeActive = 0; const decodeQueue = [];
  const pumpDecodeQueue = () => {
    while (decodeActive < 2 && decodeQueue.length > 0) {
      const task = decodeQueue.shift(); decodeActive += 1;
      Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => { decodeActive -= 1; pumpDecodeQueue(); });
    }
  };
  const scheduleDecode = (operation) => new Promise((resolve, reject) => { decodeQueue.push({ operation, resolve, reject }); pumpDecodeQueue(); });
  const decodeTasks = new Array(jobs.length);
  let loaded; let readFailure;
  try {
    loaded = await mapSettledLimit(jobs, 3, async (job, index) => {
      const stable = await readStableBinaryFile(job.filePath, { maxBytes: MAX_IMAGE_BYTES });
      if (stable.sha256 !== job.expectedSha256) fail(`evidence ${job.evidenceId} SHA changed after manifest audit.`);
      const bytes = copyStableBinaryBytes(stable);
      const cachedMetadata = imageMetadataCache.get(stable.sha256);
      if (job.requiresImageDecode) {
        decodeTasks[index] = cachedMetadata
          ? Promise.resolve({ status: "fulfilled", value: cachedMetadata })
          : scheduleDecode(() => inspectEvidenceImage(bytes, `evidence ${job.evidenceId}`)).then(
              (metadata) => { imageMetadataCache.set(stable.sha256, metadata); return { status: "fulfilled", value: metadata }; },
              (reason) => ({ status: "rejected", reason }),
            );
      }
      return { stable, bytes };
    });
  } catch (error) {
    readFailure = error;
    loaded = error?.settledDetails;
  }
  const decodeResults = await Promise.all(Array.from({ length: jobs.length }, (_, index) => decodeTasks[index] ?? Promise.resolve({ status: "fulfilled", value: undefined })));
  const failures = [];
  for (const [index, entry] of (loaded?.settled ?? []).entries()) if (entry?.status === "rejected") failures.push({ index, reason: entry.reason });
  for (const [index, entry] of decodeResults.entries()) if (entry.status === "rejected") failures.push({ index, reason: entry.reason });
  failures.sort((left, right) => left.index - right.index);
  if (failures.length > 0) throw failures[0].reason;
  if (readFailure) throw readFailure;
  const loadedBySha256 = new Map(jobs.map((job, index) => [job.expectedSha256, { ...loaded.settled[index].value, metadata: decodeResults[index].value }]));
  for (const { raw, filePath, expectedSha256 } of bindings) {
    const { stable, bytes, metadata } = loadedBySha256.get(expectedSha256);
    if (raw.kind === "image") {
      evidence.set(raw.id, { id: raw.id, kind: "image", usage: raw.usage, path: filePath, originalName: path.basename(filePath), sha256: stable.sha256, bytes, ...metadata });
    } else {
      evidence.set(raw.id, { id: raw.id, kind: raw.kind, path: filePath, sha256: stable.sha256 });
    }
  }
  for (const id of usedIds) if (!evidence.has(id)) fail(`transaction evidence ${id} is not bound to a stable file.`);
  return evidence;
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
  const prefix = safeSegment(person).replace(/[\[\]]/gu, "-").slice(0, 25);
  return `${prefix}补报明细`;
}

function evidenceArchiveName(index, evidenceId, evidence, transactions, usedNames) {
  const transaction = transactions.find((item) => item.evidence.includes(evidenceId));
  const stem = [
    String(index + 1).padStart(3, "0"),
    safeSegment(transaction?.person, "未知人员"),
    safeSegment(transaction?.project, "凭证"),
    safeSegment(transaction?.sourceAmount ?? transaction?.amount ?? "0", "0"),
    safeSegment(transaction?.date ?? "未知日期", "未知日期"),
  ].join("_");
  let candidate = `${stem}.${evidence.extension}`;
  const key = candidate.toLowerCase();
  if (usedNames.has(key)) candidate = `${stem}_${evidence.sha256.slice(0, 8)}.${evidence.extension}`;
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function removeOwned(entries, stagingRoot) {
  const preserved = [];
  for (const entry of [...entries].reverse()) {
    try {
      const current = await readStableBinaryFile(entry.path);
      if (current.sha256 !== entry.sha256 || current.size !== entry.size) {
        preserved.push(entry.path);
        continue;
      }
      await fs.unlink(entry.path);
    } catch (error) {
      if (!errorHasCode(error, "ENOENT")) preserved.push(entry.path);
    }
  }
  if (preserved.length === 0) await fs.rmdir(stagingRoot).catch(() => {});
  return preserved;
}

export async function buildReimbursementArtifacts(rawRequest, { testHooks } = {}) {
  exactKeys(rawRequest, new Set(["kind", "stagingToken", "manifestPath", "manifestSha256", "reimbursementFactsCertificate"]), "request");
  if (rawRequest.kind !== REIMBURSEMENT_ARTIFACT_BUILD_KIND) fail("request kind is unsupported.");
  if (!TOKEN_RE.test(rawRequest.stagingToken ?? "")) fail("stagingToken must be exactly 64 lowercase hexadecimal characters.");
  const request = { ...clone(rawRequest), manifestPath: path.resolve(cleanText(rawRequest.manifestPath, "manifestPath")), manifestSha256: cleanSha(rawRequest.manifestSha256, "manifestSha256") };
  const registry = await loadProfileRegistry();
  const certificate = validateCertificate(record(request.reimbursementFactsCertificate, "reimbursementFactsCertificate"), registry);
  const { manifest } = await loadManifest(request, certificate);
  const transactions = bindTransactions(manifest, certificate, registry);
  const summaryAnnotations = bindSummaryAnnotations(manifest, certificate, transactions);
  const affectedProfileIds = registry.profileOrder.filter((profileId) => transactions.some((item) => item.profileId === profileId));
  if (affectedProfileIds.length === 0 || canonicalDigest(affectedProfileIds) !== canonicalDigest(certificate.factsPreimage.affectedProfileIds)) fail("affected profiles differ from certificate facts.");
  const [evidenceLoad, templateLoad] = await Promise.allSettled([
    loadEvidence(manifest),
    loadArtifactTemplates(),
  ]);
  if (evidenceLoad.status === "rejected") throw evidenceLoad.reason;
  if (templateLoad.status === "rejected") throw templateLoad.reason;
  const evidence = evidenceLoad.value;
  const templates = templateLoad.value;
  const mainPeriod = record(manifest.batch?.mainPeriod, "manifest.batch.mainPeriod");
  const period = displayPeriod({
    start: cleanText(mainPeriod.start, "manifest.batch.mainPeriod.start"),
    end: cleanText(mainPeriod.end, "manifest.batch.mainPeriod.end"),
  });
  const endDate = mainPeriod.end;
  const stagingRoot = path.join(path.resolve(os.tmpdir()), `${STAGING_PREFIX}${request.stagingToken}`);
  const owned = [];
  let created = false;
  try {
    await fs.mkdir(stagingRoot, { recursive: false });
    created = true;
    const artifacts = await mapSettledLimit(affectedProfileIds, 3, async (profileId) => {
      const profile = registry.profiles[profileId];
      const selected = transactions.filter((item) => item.profileId === profileId).sort((left, right) => left.sourceOrder - right.sourceOrder);
      const selectedAnnotations = summaryAnnotations.filter((annotation) => annotation.profileId === profileId);
      if (selected.length === 0) fail(`${profileId} has no reimbursement and must not emit files.`);
      const supplements = supplementSummary(selected);
      const detail = detailProjection(profile, period, selected, templates.currentDetail.styleRoles, { suffix: supplements.suffix, template: templates.currentDetail, evidenceById: evidence });
      const screenshot = screenshotProjection(profile, selected, evidence, templates.screenshotMap.styleRoles, templates.screenshotMap);
      const summary = renderProfileSummary(profile, mainPeriod, selected, supplements, selectedAnnotations, templates.summaryText);
      const safePeriod = safeSegment(period);
      const detailPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_本次报销明细${supplements.suffix}.xlsx`);
      const screenshotPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销明细对应截图表${supplements.suffix}.xlsx`);
      const summaryPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销文字说明${supplements.suffix}.txt`);
      const workbookWrites = await Promise.allSettled([
        writeWorkbook(detailPath, profile.detailSheetName, detail, testHooks?.beforeArtifactWorkbookValidation ? (binding) => testHooks.beforeArtifactWorkbookValidation({ ...binding, profileId, role: "detail" }) : undefined),
        writeWorkbook(screenshotPath, profile.screenshotMapSheetName, screenshot, testHooks?.beforeArtifactWorkbookValidation ? (binding) => testHooks.beforeArtifactWorkbookValidation({ ...binding, profileId, role: "screenshot" }) : undefined),
      ]);
      const workbookPaths = [detailPath, screenshotPath];
      for (const [index, settled] of workbookWrites.entries()) if (settled.status === "fulfilled") owned.push({ path: workbookPaths[index], ...settled.value });
      const workbookFailure = workbookWrites.find((settled) => settled.status === "rejected");
      if (workbookFailure) throw workbookFailure.reason;
      const [detailState, screenshotState] = workbookWrites.map((settled) => settled.value);
      const evidenceIds = [...new Set(selected.flatMap((item) => item.evidence))]
        .filter((id) => evidence.get(id)?.kind === "image")
        .filter((id, index, values) => values.findIndex((other) => evidence.get(other).sha256 === evidence.get(id).sha256) === index);
      const usedNames = new Set();
      const archiveJobs = evidenceIds.map((evidenceId, index) => {
        const source = evidence.get(evidenceId);
        const finalName = evidenceArchiveName(index, evidenceId, source, selected, usedNames);
        const stagedPath = path.join(stagingRoot, `${profileId}_${finalName}`);
        return { kind: "evidence", evidenceId, finalName, path: stagedPath, bytes: source.bytes, expectedSha256: source.sha256 };
      });
      const summaryBytes = Buffer.from(summary.text, "utf8");
      const boundWriteJobs = [
        { kind: "summary", path: summaryPath, bytes: summaryBytes, expectedSha256: sha256Bytes(summaryBytes) },
        ...archiveJobs,
      ];
      for (const job of boundWriteJobs) owned.push({ path: job.path, sha256: job.expectedSha256, size: job.bytes.length });
      const boundWrites = await mapSettledInInputOrder(boundWriteJobs, 3, async (job) => {
        const state = job.kind === "summary"
          ? await writeTextSummary(job.path, summary.text)
          : await writeBoundBytes(job.path, job.bytes);
        return { ...job, state };
      });
      const summaryState = boundWrites.settled[0].value.state;
      const evidenceArchive = boundWrites.settled.slice(1).map(({ value }) => ({
        evidenceId: value.evidenceId,
        finalName: value.finalName,
        path: value.path,
        ...value.state,
      }));
      const supplementArtifacts = [];
      for (const supplement of supplements.entries) {
        const sheetName = supplementSheetName(supplement.person);
        const supplementWorkbook = supplementProjection(
          supplement.period,
          supplement.transactions,
          templates.supplementDetail.styleRoles,
          { subtitle: `补报明细｜原因：${supplement.reasons.join("；")}`, template: templates.supplementDetail, evidenceById: evidence },
        );
        const supplementName = supplement.start === supplement.end
          ? `${safeSegment(supplement.person)}_${compactDate(supplement.start)}_小红书补报明细.xlsx`
          : `${safeSegment(supplement.person)}_${compactDate(supplement.start)}-${compactDate(supplement.end)}_小红书补报明细.xlsx`;
        const supplementPath = path.join(stagingRoot, supplementName);
        const supplementState = await writeWorkbook(supplementPath, sheetName, supplementWorkbook, testHooks?.beforeArtifactWorkbookValidation ? (binding) => testHooks.beforeArtifactWorkbookValidation({ ...binding, profileId, role: "supplement" }) : undefined);
        owned.push({ path: supplementPath, ...supplementState });
        supplementArtifacts.push({
          person: supplement.person,
          start: supplement.start,
          end: supplement.end,
          count: supplement.count,
          amount: supplement.amount,
          sourceAmount: supplementWorkbook.totals.sourceAmount,
          reimbursementAmount: supplementWorkbook.totals.reimbursementAmount,
          reasons: supplement.reasons,
          path: supplementPath,
          ...supplementState,
          sheetName,
          endRow: supplementWorkbook.endRow,
        });
      }
      const body = {
        profileId,
        period,
        periodEndDate: endDate,
        mainPeriod: { start: mainPeriod.start, end: mainPeriod.end },
        supplementSuffix: supplements.suffix,
        transactionCount: selected.length,
        transactionDigest: canonicalDigest(selected.map(({ milliunits, reimbursementMilliunits, evidence: imageIds, ...item }) => ({ ...item, evidence: imageIds }))),
        detail: { path: detailPath, ...detailState, sheetName: profile.detailSheetName, endRow: detail.endRow, totals: detail.totals },
        screenshot: { path: screenshotPath, ...screenshotState, sheetName: profile.screenshotMapSheetName, endRow: screenshot.endRow, endColumn: screenshot.endColumn, imageCount: screenshot.imageCount, uniqueMediaCount: screenshot.uniqueMediaCount, imageReferenceCount: screenshot.imageReferenceCount },
        summary: {
          path: summaryPath,
          ...summaryState,
          text: summary.text,
          templateSha256: templates.summaryText.sha256,
          annotationCount: summary.annotationCount,
          annotationDigest: summary.annotationDigest,
        },
        supplements: supplementArtifacts,
        evidenceArchive,
      };
      return { ...body, artifactDigest: canonicalDigest(body) };
    });
    const body = {
      kind: REIMBURSEMENT_ARTIFACT_RESULT_KIND,
      requiresGate1Binding: true,
      stagingRoot,
      manifestSha256: request.manifestSha256,
      certificateDigest: certificate.certificateDigest,
      factsDigest: certificate.factsDigest,
      sourceCoverageDigest: certificate.sourceCoverageDigest,
      profileConfigDigest: certificate.profileConfigDigest,
      affectedProfileIds,
      artifacts: artifacts.settled.map((item) => item.value),
      ownedFiles: owned.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })),
    };
    return deepFreeze({ ...body, buildDigest: canonicalDigest(body) });
  } catch (error) {
    if (created) {
      const preserved = await removeOwned(owned, stagingRoot);
      if (preserved.length > 0) throw new Error(`${error instanceof Error ? error.message : String(error)}; externally changed files preserved: ${preserved.join(", ")}`, { cause: error });
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input") fail("usage: build_reimbursement_artifacts.mjs --input <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_MANIFEST_BYTES });
  process.stdout.write(`${JSON.stringify(await buildReimbursementArtifacts(input.value))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
