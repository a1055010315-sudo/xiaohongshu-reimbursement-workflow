import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { formatMilliunits, loadProfileRegistry, parseMilliunits } from "./finance_domain.mjs";
import {
  getDetailContract,
  getScreenshotContract,
  getSupplementContract,
  summarizeVisualContract,
} from "./builtin_visual_contracts.mjs";
import { EvidenceCache } from "./evidence_cache.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
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
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";

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

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function odtContentXml(summaryText) {
  const paragraphs = summaryText.split("\n").map((line) => `<text:p text:style-name="P1">${xml(line)}</text:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-content office:version="1.3" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${paragraphs}</office:text></office:body></office:document-content>`;
}

function odtManifestXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest manifest:version="1.3" xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${ODT_MIMETYPE}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
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

function canonicalCalendarDate(yearText, monthText, dayText, field) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || year > 9_999) fail(`${field} is not a calendar date.`);
  const timestamp = Date.UTC(year, month - 1, day);
  const checked = new Date(timestamp);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) {
    fail(`${field} is not a calendar date.`);
  }
  return `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
}

function periodDates(period) {
  const startMatch = /(?<!\d)(\d{4})(?:年|[.\/-])(\d{1,2})(?:月|[.\/-])(\d{1,2})日?/u.exec(period);
  if (!startMatch) fail("manifest.batch.period must contain a complete start and end date.");
  const start = canonicalCalendarDate(startMatch[1], startMatch[2], startMatch[3], "manifest.batch.period start date");
  const tail = period.slice(startMatch.index + startMatch[0].length);
  const endMatch = /^\s*(?:[-–—~～至到])\s*(?:(\d{4})(?:年|[.\/-]))?(\d{1,2})(?:月|[.\/-])(\d{1,2})日?\s*$/u.exec(tail);
  if (!endMatch) fail("manifest.batch.period must contain a complete start and end date.");
  const end = canonicalCalendarDate(endMatch[1] ?? startMatch[1], endMatch[2], endMatch[3], "manifest.batch.period end date");
  if (start > end) fail("manifest.batch.period start date must not be after its end date.");
  return {
    start,
    end,
  };
}

function periodEndDate(period) {
  return periodDates(period).end;
}

function periodStartDate(period) {
  return periodDates(period).start;
}

function renderProfileSummary(profile, period, transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const key = JSON.stringify([transaction.label, transaction.settlement]);
    const existing = groups.get(key);
    if (existing) {
      existing.total += transaction.milliunits;
    } else {
      groups.set(key, {
        label: transaction.label,
        settlement: transaction.settlement,
        total: transaction.milliunits,
        sourceOrder: transaction.sourceOrder,
      });
    }
  }
  const employee = transactions.filter((item) => item.settlement === "employee_reimbursement");
  const companyPaid = transactions.filter((item) => item.settlement === "company_paid_no_reimbursement");
  const lines = [`${period}${profile.targetCategory}`];
  for (const group of [...groups.values()].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    const suffix = group.settlement === "company_paid_no_reimbursement" ? "（对公已付不实报）" : "";
    lines.push(`${group.label}${suffix}：${formatMilliunits(group.total)}`);
  }
  lines.push(`费用合计：${formatMilliunits(sumMilliunits(transactions))}`);
  lines.push(`实报合计：${formatMilliunits(sumMilliunits(employee))}`);
  if (companyPaid.length > 0) lines.push(`对公已付不实报：${formatMilliunits(sumMilliunits(companyPaid))}`);
  const text = `${lines.join("\n")}\n`;
  return { text, sha256: sha256Bytes(Buffer.from(text, "utf8")) };
}

function numericCell(reference, value, style = 2) {
  return `<c r="${reference}" s="${style}"><v>${xml(value)}</v></c>`;
}

function formulaCell(reference, formula, cached, style = 2) {
  return `<c r="${reference}" s="${style}"><f>${xml(formula)}</f><v>${xml(cached)}</v></c>`;
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

function strictIsoDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${field} must be an ISO calendar date.`);
  }
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return canonicalCalendarDate(year, month, day, field);
}

function requiredSupplementText(value, field) {
  return cleanText(value, field);
}

function supplementEntriesFor(profile, selected, rawById, rawIndexById, period) {
  const contract = getSupplementContract(profile.profileId);
  const startDate = periodStartDate(period);
  const entries = [];
  for (const transaction of selected) {
    const raw = rawById.get(transaction.id);
    const rawIndex = rawIndexById.get(transaction.id);
    if (raw && Object.hasOwn(raw, "supplement") && typeof raw.supplement !== "boolean") {
      fail(`manifest.transactions[${rawIndex}].supplement must be boolean when supplied.`);
    }
    const marked = raw?.supplement === true
      || transaction.date < startDate
      || contract.supplementFieldDefinitions.some((field) => raw && Object.hasOwn(raw, field.id));
    if (!marked) continue;
    const values = { transactionId: transaction.id };
    for (const field of contract.supplementFieldDefinitions) {
      const fieldPath = `manifest.transactions[${rawIndex}].${field.id}`;
      values[field.id] = field.type === "date"
        ? strictIsoDate(raw?.[field.id], fieldPath)
        : requiredSupplementText(raw?.[field.id], fieldPath);
    }
    entries.push(values);
  }
  return entries;
}

const LEGACY_FIXTURE_NAMES = Object.freeze({
  detail: Object.freeze({ xiaohongshu: "xiaohongshu-detail.xlsx", company: "company-detail.xlsx", residence: "residence-detail.xlsx" }),
  screenshot: Object.freeze({ xiaohongshu: "xiaohongshu-screenshot.xlsx", company: "company-screenshot.xlsx", residence: "residence-screenshot.xlsx" }),
});

async function loadVisualContract(profile, kind) {
  const contract = kind === "detail"
    ? getDetailContract(profile.profileId)
    : kind === "screenshot"
      ? getScreenshotContract(profile.profileId)
      : kind === "supplement"
        ? getSupplementContract(profile.profileId)
        : null;
  if (!contract) fail(`unknown visual contract kind ${kind}.`);
  if (process.env.XHS_USE_TEMPLATE_FALLBACK !== "1") return contract;
  if (kind === "supplement") fail("template fallback is not supported for supplement contracts; use the built-in contract.");
  const fixtureRoot = process.env.XHS_TEMPLATE_FIXTURE_ROOT;
  const expectedText = process.env.XHS_TEMPLATE_FIXTURE_SHA256;
  if (!fixtureRoot || !expectedText) {
    fail("template fallback requires XHS_TEMPLATE_FIXTURE_ROOT and XHS_TEMPLATE_FIXTURE_SHA256; it is an explicit migration/test path only.");
  }
  let expected;
  try {
    expected = JSON.parse(expectedText);
  } catch {
    fail("XHS_TEMPLATE_FIXTURE_SHA256 must be a JSON object keyed by profileId:kind or filename.");
  }
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    fail("XHS_TEMPLATE_FIXTURE_SHA256 must be a JSON object keyed by profileId:kind or filename.");
  }
  const filename = LEGACY_FIXTURE_NAMES[kind]?.[profile.profileId];
  const expectedSha = expected[`${profile.profileId}:${kind}`] ?? expected[filename];
  if (!filename || !SHA256_RE.test(expectedSha ?? "")) {
    fail(`${profile.profileId} ${kind} template fallback requires a lowercase SHA-256 expectation.`);
  }
  const fixturePath = path.resolve(fixtureRoot, filename);
  const stable = await readStableBinaryFile(fixturePath);
  if (stable.sha256 !== expectedSha) fail(`${filename} fixture SHA differs from the explicit migration expectation.`);
  const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
  const stylesEntry = zip.file("xl/styles.xml");
  const themeEntry = zip.file("xl/theme/theme1.xml");
  if (!stylesEntry || !themeEntry) fail(`${filename} fixture is missing styles or theme.`);
  const fallbackBody = {
    ...contract,
    source: "template-fallback",
    stylesXml: await stylesEntry.async("string"),
    themeXml: await themeEntry.async("string"),
    legacyFixtureFile: filename,
    legacyFixtureSha256: stable.sha256,
  };
  delete fallbackBody.visualContractDigest;
  return Object.freeze({ ...fallbackBody, visualContractDigest: canonicalDigest(fallbackBody) });
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

function workbookParts(sheetName, worksheetXml, drawing, template, printArea) {
  const imageDefaults = [...new Set((drawing?.media ?? []).map((item) => item.extension))]
    .map((extension) => `<Default Extension="${extension}" ContentType="${extension === "png" ? "image/png" : "image/jpeg"}"/>`)
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${drawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const print = template.layout?.print ?? {};
  const area = printArea ?? {};
  const startColumn = area.startColumn ?? print.area?.startColumn ?? "A";
  const endColumn = area.endColumn ?? print.area?.endColumn ?? "F";
  const startRow = area.startRow ?? print.area?.startRow ?? 1;
  const repeatRows = print.repeatRows;
  const definedNames = printArea
    ? `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$${startColumn}$${startRow}:$${endColumn}$${printArea.endRow}</definedName>${repeatRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$${repeatRows.start}:$${repeatRows.end}</definedName>` : ""}</definedNames>`
    : "";
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>${definedNames}<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`;
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
    ["xl/styles.xml", template.stylesXml],
    ["xl/theme/theme1.xml", template.themeXml],
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

function detailProjection(profile, period, transactions, visualContract, supplementEntries = []) {
  const styles = visualContract.roles;
  const geometry = visualContract.layout;
  const heights = visualContract.rowHeights;
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
  const rows = [
    rowXml(1, [textCell("A1", `${profile.targetCategory}｜${period}`, styles.title)], { height: heights.title }),
    rowXml(2, [textCell("A2", visualContract.kind === "supplement" ? "补报表（按人员分类）" : "本次报销明细（按人员分类）", styles.subtitle)], { height: heights.subtitle }),
    rowXml(3, [textCell("A3", "实报合计", styles.summaryLabel), textCell("C3", "对公已付不实报", styles.summaryLabel), textCell("E3", "费用合计", styles.summaryLabel)], { height: heights.summaryLabel }),
    rowXml(4, [
      formulaCell("A4", employee.length ? `SUM(${employee.map((_, index) => `C${index + 1}`).join(",")})` : "0", formatMilliunits(sumMilliunits(employee)), styles.summaryValue),
      formulaCell("C4", companyPaid.length ? "0" : "0", formatMilliunits(sumMilliunits(companyPaid)), styles.summaryValue),
      formulaCell("E4", "A4+C4", formatMilliunits(sumMilliunits(transactions)), styles.summaryValue),
    ], { height: heights.summaryValue }),
    rowXml(5, [], { height: heights.preHeaderSpacer }),
    rowXml(6, visualContract.columns.map((value, index) => textCell(`${columnName(index + 1)}6`, value, styles.header)), { height: heights.header }),
  ];
  const merges = ["A1:F1", "A2:F2", "A3:B3", "C3:D3", "E3:F3", "A4:B4", "C4:D4", "E4:F4"];
  const mapped = [];
  const employeeRows = [];
  const companyPaidRows = [];
  let row = 7;
  for (const section of sections) {
    const ordered = [...section.transactions].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
    const dataStart = row + 1;
    const dataEnd = row + ordered.length;
    const groupTotal = sumMilliunits(ordered);
    const sectionLabel = section.settlement === "company_paid_no_reimbursement"
      ? `${section.person}（对公已付不实报）｜${ordered.length}笔`
      : `${section.person}｜${ordered.length}笔`;
    const isCompanyPaid = section.settlement === "company_paid_no_reimbursement";
    const groupLabelStyle = isCompanyPaid ? styles.companyGroupLabel : styles.employeeGroupLabel;
    const groupTotalStyle = isCompanyPaid ? styles.companyGroupTotal : styles.employeeGroupTotal;
    rows.push(rowXml(row, [
      textCell(`A${row}`, sectionLabel, groupLabelStyle),
      textCell(`E${row}`, isCompanyPaid ? "对公合计" : "人员合计", groupLabelStyle),
      formulaCell(`F${row}`, `SUM(C${dataStart}:C${dataEnd})`, formatMilliunits(groupTotal), groupTotalStyle),
    ], { height: heights.group }));
    merges.push(`A${row}:D${row}`);
    row += 1;
    const dateRuns = contiguousRuns(ordered, (item) => item.date);
    const feeRuns = contiguousRuns(ordered, (item) => JSON.stringify([item.classification, item.settlement]));
    const dateByStart = new Map(dateRuns.map((run) => [run.start, run]));
    const feeByStart = new Map(feeRuns.map((run) => [run.start, run]));
    for (const [index, transaction] of ordered.entries()) {
      const cells = [];
      const dateRun = dateByStart.get(index);
      if (dateRun) {
        cells.push(numericCell(`A${row}`, excelSerial(transaction.date, `${transaction.id}.date`), styles.date));
        if (dateRun.end > dateRun.start) merges.push(`A${row}:A${row + dateRun.end - dateRun.start}`);
      }
      cells.push(textCell(`B${row}`, transaction.project, styles.text), numericCell(`C${row}`, transaction.amount, styles.amount));
      const feeRun = feeByStart.get(index);
      if (feeRun) {
        const runItems = ordered.slice(feeRun.start, feeRun.end + 1);
        const endRow = row + feeRun.end - feeRun.start;
        cells.push(
          formulaCell(`D${row}`, `SUM(C${row}:C${endRow})`, formatMilliunits(sumMilliunits(runItems)), styles.feeTotal),
          textCell(`E${row}`, transaction.classification, styles.classification),
          textCell(`F${row}`, transaction.settlement === "company_paid_no_reimbursement" ? "对公已付不实报" : "待报销", styles.settlement),
        );
        if (endRow > row) for (const column of ["D", "E", "F"]) merges.push(`${column}${row}:${column}${endRow}`);
      }
      rows.push(rowXml(row, cells, { height: heights.data }));
      mapped.push({ ...transaction, row });
      (transaction.settlement === "employee_reimbursement" ? employeeRows : companyPaidRows).push(row);
      row += 1;
    }
  }
  const spacerRow = row;
  rows.push(rowXml(spacerRow, [blankCell(`A${spacerRow}`, styles.spacer)], { height: heights.spacer }));
  merges.push(`A${spacerRow}:F${spacerRow}`);
  if (visualContract.kind === "supplement" && supplementEntries.length > 0) {
    const supplementHeight = heights.supplement ?? heights.data;
    for (const [index, entry] of supplementEntries.entries()) {
      const supplementRow = spacerRow + 1 + index;
      const fieldText = [
        `补报说明：${entry.transactionId}`,
        `原始发生日期：${entry.originalOccurrenceDate}`,
        `补报原因：${entry.supplementReason}`,
        `关联原始凭证/来源编号：${entry.sourceReference}`,
      ].join("；");
      rows.push(rowXml(supplementRow, [textCell(`A${supplementRow}`, fieldText, styles.text)], { height: supplementHeight }));
      merges.push(`A${supplementRow}:F${supplementRow}`);
    }
  }
  const cardFormula = (indexes) => indexes.length ? `SUM(${indexes.map((index) => `C${index}`).join(",")})` : "0";
  rows[3] = rowXml(4, [
    formulaCell("A4", cardFormula(employeeRows), formatMilliunits(sumMilliunits(employee)), styles.summaryValue),
    formulaCell("C4", cardFormula(companyPaidRows), formatMilliunits(sumMilliunits(companyPaid)), styles.summaryValue),
    formulaCell("E4", "A4+C4", formatMilliunits(sumMilliunits(transactions)), styles.summaryValue),
  ], { height: heights.summaryValue });
  const orderedMerges = sortMergeRefs(merges);
  const mergeXml = `<mergeCells count="${orderedMerges.length}">${orderedMerges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`;
  const columnsXml = geometry.columns.map((column) => `<col min="${column.min}" max="${column.max}" width="${column.width}" customWidth="1"/>`).join("");
  const pane = geometry.freezePane;
  const selection = geometry.selection;
  const print = geometry.print;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="${geometry.sheetView.showGridLines ? "1" : "0"}"><pane ySplit="${pane.ySplit}" topLeftCell="${pane.topLeftCell}" activePane="${pane.activePane}" state="${pane.state}"/><selection pane="${selection.pane}" activeCell="${selection.activeCell}" sqref="${selection.sqref}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columnsXml}</cols><sheetData>${rows.join("")}</sheetData>${mergeXml}<printOptions horizontalCentered="${print.options.horizontalCentered ? "1" : "0"}" headings="${print.options.headings ? "1" : "0"}" gridLines="${print.options.gridLines ? "1" : "0"}"/><pageMargins left="${print.margins.left}" right="${print.margins.right}" top="${print.margins.top}" bottom="${print.margins.bottom}" header="${print.margins.header}" footer="${print.margins.footer}"/><pageSetup paperSize="${print.pageSetup.paperSize}" orientation="${print.pageSetup.orientation}" fitToWidth="${print.pageSetup.fitToWidth}" fitToHeight="${print.pageSetup.fitToHeight}"/><headerFooter><oddFooter>${xml(print.footer)}</oddFooter></headerFooter></worksheet>`;
  const endRow = visualContract.kind === "supplement" && supplementEntries.length > 0
    ? spacerRow + supplementEntries.length
    : spacerRow;
  return { worksheet, mapped, endRow, merges: orderedMerges, printArea: { startColumn: "A", endColumn: "F", startRow: 1, endRow } };
}

function imageExtent(kind, visualContract) {
  const anchor = visualContract.imageAnchor;
  if (!anchor
    || !Number.isFinite(anchor.widthPx) || !Number.isFinite(anchor.minHeightPx) || !Number.isFinite(anchor.maxHeightPx)
    || !Number.isFinite(anchor.columnOffsetPx) || !Number.isFinite(anchor.rowOffsetPx)
    || !Number.isFinite(anchor.emuPerPixel) || anchor.widthPx < 1 || anchor.minHeightPx < 1
    || anchor.maxHeightPx < anchor.minHeightPx || anchor.emuPerPixel < 1
    || !Number.isFinite(kind.width) || !Number.isFinite(kind.height) || kind.width < 1 || kind.height < 1) {
    fail("image evidence dimensions and imageAnchor contract are required.");
  }
  const heightPx = Math.max(anchor.minHeightPx, Math.min(anchor.maxHeightPx, Math.round(anchor.widthPx * kind.height / kind.width)));
  return { cx: anchor.widthPx * anchor.emuPerPixel, cy: heightPx * anchor.emuPerPixel, widthPx: anchor.widthPx, heightPx };
}

function screenshotProjection(profile, transactions, evidenceById, visualContract) {
  const templateStyles = visualContract.roles;
  const geometry = visualContract.layout;
  const heights = visualContract.rowHeights;
  const maxImages = Math.max(3, ...transactions.map((item) => item.evidence.filter((id) => evidenceById.get(id)?.kind === "image").length));
  const rows = [];
  const headers = [...visualContract.columns, ...Array.from({ length: maxImages }, (_, index) => `图${index + 1}`)];
  rows.push(rowXml(1, headers.map((value, index) => textCell(`${columnName(index + 1)}1`, value, templateStyles.header)), { height: heights.header }));
  const anchors = [];
  const mediaBySha = new Map();
  const relationships = [];
  for (const [index, transaction] of transactions.entries()) {
    const row = index + 2;
    const imageIds = transaction.evidence.filter((id) => evidenceById.get(id)?.kind === "image");
    const note = imageIds.length === 0 ? `${transaction.classification}｜无图片凭证` : transaction.classification;
    const styles = index % 2 === 0
      ? { date: templateStyles.oddDate, text: templateStyles.oddText, amount: templateStyles.oddAmount, note: templateStyles.oddNote, image: templateStyles.image }
      : { date: templateStyles.evenDate, text: templateStyles.evenText, amount: templateStyles.evenAmount, note: templateStyles.evenNote, image: templateStyles.image };
    rows.push(rowXml(row, [
      numericCell(`A${row}`, excelSerial(transaction.date, `${transaction.id}.date`), styles.date),
      textCell(`B${row}`, transaction.person, styles.text),
      textCell(`C${row}`, transaction.project, styles.text),
      numericCell(`D${row}`, transaction.amount, styles.amount),
      textCell(`E${row}`, note, styles.note),
      ...Array.from({ length: maxImages }, (_, imageIndex) => blankCell(`${columnName(6 + imageIndex)}${row}`, styles.image)),
    ], { height: heights.data }));
    for (const [imageIndex, evidenceId] of imageIds.entries()) {
      const evidence = evidenceById.get(evidenceId);
      let media = mediaBySha.get(evidence.sha256);
      if (!media) {
        const ordinal = mediaBySha.size + 1;
        media = { ...evidence, ordinal, partName: `xl/media/image${ordinal}.${evidence.extension}`, relationshipId: `rId${ordinal}` };
        mediaBySha.set(evidence.sha256, media);
        relationships.push(media);
      }
      const extent = imageExtent(evidence, visualContract);
      const anchor = visualContract.imageAnchor;
      anchors.push({
        row: row - 1,
        column: 5 + imageIndex,
        colOffset: Math.round(anchor.columnOffsetPx * anchor.emuPerPixel),
        rowOffset: Math.round(anchor.rowOffsetPx * anchor.emuPerPixel),
        extent,
        relationshipId: media.relationshipId,
        name: `${transaction.id}-${imageIndex + 1}`,
      });
    }
  }
  const drawingTag = anchors.length > 0 ? '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' : "";
  const columnXml = geometry.columns.map((column) => {
    const max = column.max === null ? headers.length : column.max;
    return `<col min="${column.min}" max="${max}" width="${column.width}" customWidth="1"/>`;
  }).join("");
  const print = geometry.print;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="${geometry.sheetView.showGridLines ? "1" : "0"}"><pane ySplit="${geometry.freezePane.ySplit}" topLeftCell="${geometry.freezePane.topLeftCell}" activePane="${geometry.freezePane.activePane}" state="${geometry.freezePane.state}"/><selection pane="${geometry.selection.pane}" activeCell="${geometry.selection.activeCell}" sqref="${geometry.selection.sqref}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columnXml}</cols><sheetData>${rows.join("")}</sheetData><printOptions horizontalCentered="${print.options.horizontalCentered ? "1" : "0"}" headings="${print.options.headings ? "1" : "0"}" gridLines="${print.options.gridLines ? "1" : "0"}"/><pageMargins left="${print.margins.left}" right="${print.margins.right}" top="${print.margins.top}" bottom="${print.margins.bottom}" header="${print.margins.header}" footer="${print.margins.footer}"/><pageSetup paperSize="${print.pageSetup.paperSize}" orientation="${print.pageSetup.orientation}" fitToWidth="${print.pageSetup.fitToWidth}" fitToHeight="${print.pageSetup.fitToHeight}"/>${drawingTag}</worksheet>`;
  if (anchors.length === 0) return {
    worksheet,
    drawing: null,
    endRow: transactions.length + 1,
    imageCount: 0,
    printArea: { startColumn: "A", endColumn: columnName(headers.length), startRow: 1, endRow: transactions.length + 1 },
  };
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map((anchor, index) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.column}</xdr:col><xdr:colOff>${anchor.colOffset}</xdr:colOff><xdr:row>${anchor.row}</xdr:row><xdr:rowOff>${anchor.rowOffset}</xdr:rowOff></xdr:from><xdr:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="${xml(anchor.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${anchor.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("")}</xdr:wsDr>`;
  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map((item) => `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${path.basename(item.partName)}"/>`).join("")}</Relationships>`;
  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  return {
    worksheet,
    drawing: { xml: drawingXml, rels: drawingRels, sheetRels, media: relationships },
    endRow: transactions.length + 1,
    imageCount: anchors.length,
    printArea: { startColumn: "A", endColumn: columnName(headers.length), startRow: 1, endRow: transactions.length + 1 },
  };
}

async function writeWorkbook(filePath, sheetName, projection, template) {
  const zip = new JSZip();
  const expectedParts = workbookParts(sheetName, projection.worksheet, projection.drawing, template, projection.printArea);
  if (projection.drawing) {
    expectedParts.set("xl/drawings/drawing1.xml", projection.drawing.xml);
    expectedParts.set("xl/drawings/_rels/drawing1.xml.rels", projection.drawing.rels);
    expectedParts.set("xl/worksheets/_rels/sheet1.xml.rels", projection.drawing.sheetRels);
  }
  for (const [partName, content] of expectedParts) zip.file(partName, content);
  for (const media of projection.drawing?.media ?? []) zip.file(media.partName, media.bytes);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stable = await readStableBinaryFile(filePath);
  const reopened = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
  for (const [partName, expected] of expectedParts) {
    const entry = reopened.file(partName);
    if (!entry || await entry.async("string") !== expected) fail(`${path.basename(filePath)} ${partName} changed after write.`);
  }
  for (const media of projection.drawing?.media ?? []) {
    const entry = reopened.file(media.partName);
    if (!entry || sha256Bytes(await entry.async("nodebuffer")) !== media.sha256) fail(`${path.basename(filePath)} media changed after write.`);
  }
  return {
    sha256: stable.sha256,
    size: stable.size,
    partDigest: canonicalDigest([...expectedParts]),
    ...summarizeVisualContract(template),
  };
}

async function writeBoundBytes(filePath, bytes) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stable = await readStableBinaryFile(filePath, { maxBytes: MAX_IMAGE_BYTES });
  const expectedSha256 = sha256Bytes(bytes);
  if (stable.sha256 !== expectedSha256 || stable.size !== bytes.length) fail(`${path.basename(filePath)} changed after exclusive write.`);
  return { sha256: stable.sha256, size: stable.size };
}

async function writeOdtSummary(filePath, summaryText) {
  const zip = new JSZip();
  const contentXml = odtContentXml(summaryText);
  zip.file("mimetype", ODT_MIMETYPE, { compression: "STORE" });
  zip.file("content.xml", contentXml);
  zip.file("styles.xml", '<?xml version="1.0" encoding="UTF-8"?><office:document-styles office:version="1.3" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:styles><style:style style:name="P1" style:family="paragraph"/></office:styles></office:document-styles>');
  zip.file("meta.xml", '<?xml version="1.0" encoding="UTF-8"?><office:document-meta office:version="1.3" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:meta/></office:document-meta>');
  zip.file("settings.xml", '<?xml version="1.0" encoding="UTF-8"?><office:document-settings office:version="1.3" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:settings/></office:document-settings>');
  zip.file("META-INF/manifest.xml", odtManifestXml());
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  const state = await writeBoundBytes(filePath, bytes);
  const reopened = await JSZip.loadAsync(copyStableBinaryBytes(await readStableBinaryFile(filePath)), { createFolders: false });
  const mimetype = await reopened.file("mimetype")?.async("string");
  const reopenedContent = await reopened.file("content.xml")?.async("string");
  if (mimetype !== ODT_MIMETYPE || reopenedContent !== contentXml) fail(`${path.basename(filePath)} is not a stable OpenDocument text summary.`);
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

function bindTransactions(manifest, certificate, registry) {
  const expectedById = new Map(certificate.factsPreimage.transactions.map((item) => [item.id, item]));
  if (expectedById.size !== manifest.transactions.length) fail("manifest transactions do not match the certificate count.");
  return manifest.transactions.map((raw, index) => {
    const expected = expectedById.get(raw.id);
    if (!expected) fail(`manifest.transactions[${index}] is absent from certificate facts.`);
    const profile = registry.profiles[expected.profileId];
    if (!profile) fail(`certificate transaction ${expected.id} has an unknown profile.`);
    for (const field of ["date", "person", "project", "label", "amount", "category", "classification", "sourceOrder", "settlement"]) {
      if (raw[field] !== expected[field]) fail(`manifest transaction ${expected.id} ${field} differs from certificate facts.`);
    }
    if (!Array.isArray(raw.evidence) || new Set(raw.evidence).size !== raw.evidence.length) fail(`manifest transaction ${expected.id} evidence is invalid.`);
    const supplementEvidence = raw.supplementEvidence === undefined ? [] : raw.supplementEvidence;
    if (!Array.isArray(supplementEvidence) || new Set(supplementEvidence).size !== supplementEvidence.length
      || supplementEvidence.some((evidenceId) => !raw.evidence.includes(evidenceId))) {
      fail(`manifest transaction ${expected.id} supplementEvidence is invalid.`);
    }
    const milliunits = parseMilliunits(expected.amount, `${expected.id}.amount`, { allowNegative: true });
    if (formatMilliunits(milliunits) !== expected.amount) fail(`${expected.id}.amount is not canonical.`);
    return {
      ...clone(expected),
      milliunits,
      evidence: [...raw.evidence],
      supplementEvidence: [...supplementEvidence],
      missingEvidenceConfirmed: raw.missingEvidenceConfirmed === true,
    };
  });
}

async function loadEvidence(manifest, evidenceCache) {
  const evidence = new Map();
  const usedIds = new Set(manifest.transactions.flatMap((item) => item.evidence ?? []));
  for (const raw of manifest.files) {
    if (!usedIds.has(raw.id)) continue;
    if (raw.role !== "material" || raw.disposition !== "used") fail(`evidence ${raw.id} is not a used material.`);
    const filePath = path.resolve(cleanText(raw.path, `files.${raw.id}.path`));
    const expectedSha256 = cleanSha(raw.sha256, `files.${raw.id}.sha256`);
    const cached = raw.kind === "image"
      ? await evidenceCache.readStable(filePath, { sourceId: raw.id, kind: "image", expectedSha256 })
      : await readStableBinaryFile(filePath, { maxBytes: MAX_IMAGE_BYTES });
    const stable = raw.kind === "image"
      ? { sha256: cached.sourceSha256, size: cached.size, bytes: cached.bytes }
      : cached;
    if (stable.sha256 !== expectedSha256) fail(`evidence ${raw.id} SHA changed after manifest audit.`);
    if (raw.kind === "image") {
      const bytes = cached.bytes;
      evidence.set(raw.id, {
        id: raw.id,
        kind: "image",
        path: filePath,
        originalName: path.basename(filePath),
        sha256: stable.sha256,
        bytes,
        imageKind: cached.imageKind,
        extension: cached.extension,
        width: cached.width,
        height: cached.height,
      });
    } else {
      evidence.set(raw.id, { id: raw.id, kind: raw.kind, path: filePath, sha256: stable.sha256 });
    }
  }
  for (const id of usedIds) if (!evidence.has(id)) fail(`transaction evidence ${id} is not bound to a stable file.`);
  return evidence;
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
      if (error?.code !== "ENOENT") preserved.push(entry.path);
    }
  }
  if (preserved.length === 0) await fs.rmdir(stagingRoot).catch(() => {});
  return preserved;
}

export async function buildReimbursementArtifacts(rawRequest, { evidenceCache: injectedEvidenceCache } = {}) {
  exactKeys(rawRequest, new Set(["kind", "stagingToken", "manifestPath", "manifestSha256", "reimbursementFactsCertificate"]), "request");
  if (rawRequest.kind !== REIMBURSEMENT_ARTIFACT_BUILD_KIND) fail("request kind is unsupported.");
  if (!TOKEN_RE.test(rawRequest.stagingToken ?? "")) fail("stagingToken must be exactly 64 lowercase hexadecimal characters.");
  const request = { ...clone(rawRequest), manifestPath: path.resolve(cleanText(rawRequest.manifestPath, "manifestPath")), manifestSha256: cleanSha(rawRequest.manifestSha256, "manifestSha256") };
  const registry = await loadProfileRegistry();
  const certificate = validateCertificate(record(request.reimbursementFactsCertificate, "reimbursementFactsCertificate"), registry);
  const { manifest } = await loadManifest(request, certificate);
  const transactions = bindTransactions(manifest, certificate, registry);
  const affectedProfileIds = registry.profileOrder.filter((profileId) => transactions.some((item) => item.profileId === profileId));
  if (affectedProfileIds.length === 0 || canonicalDigest(affectedProfileIds) !== canonicalDigest(certificate.factsPreimage.affectedProfileIds)) fail("affected profiles differ from certificate facts.");
  const evidenceCache = injectedEvidenceCache ?? new EvidenceCache({ maxBytes: MAX_IMAGE_BYTES, maxResidentBytes: 512 * 1024 * 1024 });
  const evidence = await loadEvidence(manifest, evidenceCache);
  const period = cleanText(manifest.batch?.period, "manifest.batch.period");
  const endDate = periodEndDate(period);
  const stagingRoot = path.join(path.resolve(os.tmpdir()), `${STAGING_PREFIX}${request.stagingToken}`);
  const owned = [];
  let created = false;
  try {
    await fs.mkdir(stagingRoot, { recursive: false });
    created = true;
    const artifacts = await mapSettledLimit(affectedProfileIds, 3, async (profileId) => {
      const profile = registry.profiles[profileId];
      const selected = transactions.filter((item) => item.profileId === profileId).sort((left, right) => left.sourceOrder - right.sourceOrder);
      if (selected.length === 0) fail(`${profileId} has no reimbursement and must not emit files.`);
      const rawById = new Map(manifest.transactions.map((item) => [item.id, item]));
      const rawIndexById = new Map(manifest.transactions.map((item, index) => [item.id, index]));
      const supplementEntries = supplementEntriesFor(profile, selected, rawById, rawIndexById, period);
      const hasSupplementTransactions = supplementEntries.length > 0;
      const [detailContract, screenshotContract, supplementContract] = await Promise.all([
        loadVisualContract(profile, "detail"),
        loadVisualContract(profile, "screenshot"),
        hasSupplementTransactions ? loadVisualContract(profile, "supplement") : null,
      ]);
      const supplementInfo = hasSupplementTransactions
        ? {
            originalOccurrenceDate: supplementEntries.map((entry) => entry.originalOccurrenceDate).join("；"),
            supplementReason: supplementEntries.map((entry) => entry.supplementReason).join("；"),
            sourceReference: supplementEntries.map((entry) => entry.sourceReference).join("；"),
            entries: supplementEntries,
          }
        : null;
      const supplementTransactionIds = new Set(supplementEntries.map((entry) => entry.transactionId));
      const supplementTransactions = selected.filter((item) => supplementTransactionIds.has(item.id));
      const detail = detailProjection(profile, period, selected, detailContract);
      const supplement = supplementContract
        ? detailProjection(profile, period, supplementTransactions, supplementContract, supplementEntries)
        : null;
      const screenshot = screenshotProjection(profile, selected, evidence, screenshotContract);
      const summary = renderProfileSummary(profile, period, selected);
      const safePeriod = period.replace(/[<>:"/\\|?*]/gu, "-");
      const detailPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_本次报销明细.xlsx`);
      const screenshotPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销明细对应截图表.xlsx`);
      const summaryPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销文字说明.odt`);
      const detailState = await writeWorkbook(detailPath, profile.detailSheetName, detail, detailContract);
      owned.push({ path: detailPath, ...detailState });
      let supplementArtifact = null;
      if (supplement && supplementContract) {
        const supplementPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_补报表.xlsx`);
        const supplementState = await writeWorkbook(supplementPath, "补报表", supplement, supplementContract);
        owned.push({ path: supplementPath, ...supplementState });
        supplementArtifact = {
          path: supplementPath,
          ...supplementState,
          sheetName: "补报表",
          endRow: supplement.endRow,
          ...supplementInfo,
        };
      }
      const screenshotState = await writeWorkbook(screenshotPath, profile.screenshotMapSheetName, screenshot, screenshotContract);
      owned.push({ path: screenshotPath, ...screenshotState });
      const summaryState = await writeOdtSummary(summaryPath, summary.text);
      owned.push({ path: summaryPath, ...summaryState });
      const evidenceIds = [...new Set(selected.flatMap((item) => item.evidence))]
        .filter((id) => evidence.get(id)?.kind === "image");
      const supplementEvidenceIds = new Set(selected.flatMap((item) => item.supplementEvidence));
      const regularEvidenceIds = new Set(selected.flatMap((item) =>
        item.evidence.filter((evidenceId) => !item.supplementEvidence.includes(evidenceId))));
      const evidenceArchive = [];
      for (const [index, evidenceId] of evidenceIds.entries()) {
        const source = evidence.get(evidenceId);
        const finalName = `${String(index + 1).padStart(3, "0")}_${evidenceId}.${source.extension}`;
        const stagedPath = path.join(stagingRoot, `${profileId}_${finalName}`);
        const state = await writeBoundBytes(stagedPath, source.bytes);
        owned.push({ path: stagedPath, ...state });
        evidenceArchive.push({
          evidenceId,
          finalName,
          path: stagedPath,
          archiveKind: supplementEvidenceIds.has(evidenceId) && !regularEvidenceIds.has(evidenceId)
            ? "supplement"
            : "reimbursement",
          ...state,
        });
      }
      const body = {
        profileId,
        period,
        periodEndDate: endDate,
        transactionCount: selected.length,
        transactionDigest: canonicalDigest(selected.map(({ milliunits, evidence: imageIds, ...item }) => {
          const supplement = supplementEntries.find((entry) => entry.transactionId === item.id);
          return {
            ...item,
            evidence: imageIds,
            ...(supplement ? {
              supplement: {
                originalOccurrenceDate: supplement.originalOccurrenceDate,
                supplementReason: supplement.supplementReason,
                sourceReference: supplement.sourceReference,
              },
            } : {}),
          };
        })),
        detail: {
          path: detailPath,
          ...detailState,
          sheetName: profile.detailSheetName,
          endRow: detail.endRow,
          presentationKind: detailContract.kind,
        },
        supplement: supplementArtifact,
        screenshot: { path: screenshotPath, ...screenshotState, sheetName: profile.screenshotMapSheetName, endRow: screenshot.endRow, imageCount: screenshot.imageCount },
        visualContracts: {
          detail: summarizeVisualContract(detailContract),
          screenshot: summarizeVisualContract(screenshotContract),
          supplement: supplementContract ? summarizeVisualContract(supplementContract) : null,
        },
        summary: { path: summaryPath, ...summaryState, text: summary.text },
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
    return deepFreeze({
      ...body,
      buildDigest: canonicalDigest(body),
      diagnostics: { evidenceCache: evidenceCache.stats() },
    });
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
