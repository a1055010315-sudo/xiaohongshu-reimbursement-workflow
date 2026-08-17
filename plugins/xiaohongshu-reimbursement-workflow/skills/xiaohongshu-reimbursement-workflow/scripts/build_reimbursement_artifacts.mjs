import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatMilliunits, loadProfileRegistry, parseMilliunits } from "./finance_domain.mjs";
import { readWorkbookOoxmlFacts } from "./workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "./workbook_snapshot.mjs";
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
const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates");
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const templateCache = new Map();
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

function periodEndDate(period) {
  const matches = [...period.matchAll(/(?<!\d)(\d{4})(?:年|[.\/-])(\d{1,2})(?:月|[.\/-])(\d{1,2})日?/gu)];
  if (matches.length < 1) fail("manifest.batch.period must contain a complete end date.");
  const [, year, month, day] = matches.at(-1);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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

async function loadVisualTemplate(profile, kind) {
  const fileField = kind === "detail" ? "detailTemplateFile" : "screenshotTemplateFile";
  const shaField = kind === "detail" ? "detailTemplateSha256" : "screenshotTemplateSha256";
  const cacheKey = `${profile.profileId}:${kind}:${profile[shaField]}`;
  if (!templateCache.has(cacheKey)) {
    templateCache.set(cacheKey, (async () => {
      const filePath = path.join(TEMPLATE_ROOT, profile[fileField]);
      const stable = await readStableBinaryFile(filePath);
      if (stable.sha256 !== profile[shaField]) fail(`${profile.profileId} ${kind} template SHA differs from the fixed profile registry.`);
      const snapshot = await readStableFileSnapshot(filePath);
      if (snapshot.sha256 !== stable.sha256 || snapshot.size !== stable.size) fail(`${profile.profileId} ${kind} template facts do not match its stable bytes.`);
      const facts = await readWorkbookOoxmlFacts(snapshot);
      if (facts.workbook.opaqueControlledPaths.length || facts.package.nonStructuralPartNames.length || facts.worksheets.length !== 1 || facts.worksheets[0].opaqueControlledPaths.length) {
        fail(`${profile.profileId} ${kind} template contains unsupported or opaque package structure.`);
      }
      const worksheet = facts.worksheets[0];
      const cell = (reference, formatCode) => {
        const found = worksheet.rows.flatMap((row) => row.cells).find((item) => item.ref === reference);
        if (!found || !Number.isSafeInteger(found.styleIndex)) fail(`${profile.profileId} ${kind} template role ${reference} has no unique styleIndex.`);
        if (formatCode && found.numberFormat?.formatCode !== formatCode) fail(`${profile.profileId} ${kind} template role ${reference} must use ${formatCode}.`);
        return found.styleIndex;
      };
      const roles = kind === "detail"
        ? {
            title: cell("A1"), subtitle: cell("A2"), summaryLabel: cell("A3"), summaryValue: cell("A4", "0.000"),
            header: cell("A6"), groupLabel: cell("A7"), groupTotal: cell("F7", "0.000"), date: cell("A8", "mm-dd"),
            text: cell("B8"), amount: cell("C8", "0.000"), feeTotal: cell("D8", "0.000"), classification: cell("E8"),
            settlement: cell("F8"), spacer: cell("A11"),
          }
        : {
            header: cell("A1"), oddDate: cell("A2", "mm-dd"), oddText: cell("B2"), oddAmount: cell("D2", "0.000"),
            oddNote: cell("E2"), image: cell("F2"), evenDate: cell("A3", "mm-dd"), evenText: cell("B3"),
            evenAmount: cell("D3", "0.000"), evenNote: cell("E3"),
          };
      const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
      const stylesEntry = zip.file("xl/styles.xml");
      const themeEntry = zip.file("xl/theme/theme1.xml");
      if (!stylesEntry || !themeEntry) fail(`${profile.profileId} ${kind} template is missing styles or theme.`);
      return {
        file: profile[fileField],
        sha256: stable.sha256,
        roles,
        stylesXml: await stylesEntry.async("string"),
        themeXml: await themeEntry.async("string"),
      };
    })());
  }
  return templateCache.get(cacheKey);
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
  const definedNames = printArea
    ? `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$A$1:$F$${printArea.endRow}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">'${xml(sheetName.replaceAll("'", "''"))}'!$6:$6</definedName></definedNames>`
    : "";
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>${definedNames}<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><family val="2"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF176B4D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEFE6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE4C2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB7C7BF"/></left><right style="thin"><color rgb="FFB7C7BF"/></right><top style="thin"><color rgb="FFB7C7BF"/></top><bottom style="thin"><color rgb="FFB7C7BF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
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

function detailProjection(profile, period, transactions, styles) {
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
    rowXml(1, [textCell("A1", `${profile.targetCategory}｜${period}`, styles.title)], { height: 32 }),
    rowXml(2, [textCell("A2", "本次报销明细（按人员分类）", styles.subtitle)], { height: 24 }),
    rowXml(3, [textCell("A3", "实报合计", styles.summaryLabel), textCell("C3", "对公已付不实报", styles.summaryLabel), textCell("E3", "费用合计", styles.summaryLabel)], { height: 24 }),
    rowXml(4, [
      formulaCell("A4", employee.length ? `SUM(${employee.map((_, index) => `C${index + 1}`).join(",")})` : "0", formatMilliunits(sumMilliunits(employee)), styles.summaryValue),
      formulaCell("C4", companyPaid.length ? "0" : "0", formatMilliunits(sumMilliunits(companyPaid)), styles.summaryValue),
      formulaCell("E4", "A4+C4", formatMilliunits(sumMilliunits(transactions)), styles.summaryValue),
    ], { height: 28 }),
    rowXml(5, [], { height: 10 }),
    rowXml(6, ["日期", "支出明细", "支出金额", "费用组合计", "费用分类", "结算方式"].map((value, index) => textCell(`${columnName(index + 1)}6`, value, styles.header)), { height: 24 }),
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
    rows.push(rowXml(row, [
      textCell(`A${row}`, sectionLabel, styles.groupLabel),
      textCell(`E${row}`, section.settlement === "company_paid_no_reimbursement" ? "对公合计" : "人员合计", styles.groupLabel),
      formulaCell(`F${row}`, `SUM(C${dataStart}:C${dataEnd})`, formatMilliunits(groupTotal), styles.groupTotal),
    ], { height: 24 }));
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
      rows.push(rowXml(row, cells, { height: 24 }));
      mapped.push({ ...transaction, row });
      (transaction.settlement === "employee_reimbursement" ? employeeRows : companyPaidRows).push(row);
      row += 1;
    }
  }
  const spacerRow = row;
  rows.push(rowXml(spacerRow, [blankCell(`A${spacerRow}`, styles.spacer)], { height: 24 }));
  merges.push(`A${spacerRow}:F${spacerRow}`);
  const cardFormula = (indexes) => indexes.length ? `SUM(${indexes.map((index) => `C${index}`).join(",")})` : "0";
  rows[3] = rowXml(4, [
    formulaCell("A4", cardFormula(employeeRows), formatMilliunits(sumMilliunits(employee)), styles.summaryValue),
    formulaCell("C4", cardFormula(companyPaidRows), formatMilliunits(sumMilliunits(companyPaid)), styles.summaryValue),
    formulaCell("E4", "A4+C4", formatMilliunits(sumMilliunits(transactions)), styles.summaryValue),
  ], { height: 28 });
  const orderedMerges = sortMergeRefs(merges);
  const mergeXml = `<mergeCells count="${orderedMerges.length}">${orderedMerges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A7" sqref="A7"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/><col min="3" max="3" width="15" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/><col min="5" max="5" width="24" customWidth="1"/><col min="6" max="6" width="38" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData>${mergeXml}<printOptions horizontalCentered="1" headings="0" gridLines="0"/><pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;8第 &amp;P 页 / 共 &amp;N 页</oddFooter></headerFooter></worksheet>`;
  return { worksheet, mapped, endRow: spacerRow, merges: orderedMerges, printArea: { endRow: spacerRow } };
}

function imageKind(bytes, field) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) fail(`${field} PNG dimensions are invalid.`);
    return { extension: "png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    return { extension: "jpg", width: 4, height: 3 };
  }
  fail(`${field} must be a PNG or JPEG image.`);
}

function imageExtent(kind) {
  const widthPx = 260;
  const heightPx = Math.max(72, Math.min(210, Math.round(widthPx * kind.height / kind.width)));
  return { cx: widthPx * 9525, cy: heightPx * 9525 };
}

function screenshotProjection(profile, transactions, evidenceById, templateStyles) {
  const maxImages = Math.max(3, ...transactions.map((item) => item.evidence.filter((id) => evidenceById.get(id)?.kind === "image").length));
  const rows = [];
  const headers = ["日期", "支出人/主体", "项目", "金额", "备注", ...Array.from({ length: maxImages }, (_, index) => `图${index + 1}`)];
  rows.push(rowXml(1, headers.map((value, index) => textCell(`${columnName(index + 1)}1`, value, templateStyles.header)), { height: 28.5 }));
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
    ], { height: 172.5 }));
    for (const [imageIndex, evidenceId] of imageIds.entries()) {
      const evidence = evidenceById.get(evidenceId);
      let media = mediaBySha.get(evidence.sha256);
      if (!media) {
        const ordinal = mediaBySha.size + 1;
        media = { ...evidence, ordinal, partName: `xl/media/image${ordinal}.${evidence.extension}`, relationshipId: `rId${ordinal}` };
        mediaBySha.set(evidence.sha256, media);
        relationships.push(media);
      }
      const extent = imageExtent(evidence);
      anchors.push({ row: row - 1, column: 5 + imageIndex, extent, relationshipId: media.relationshipId, name: `${transaction.id}-${imageIndex + 1}` });
    }
  }
  const drawingTag = anchors.length > 0 ? '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' : "";
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="12.5" customWidth="1"/><col min="2" max="2" width="15" customWidth="1"/><col min="3" max="3" width="40" customWidth="1"/><col min="4" max="4" width="13" customWidth="1"/><col min="5" max="5" width="48" customWidth="1"/><col min="6" max="${headers.length}" width="42" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawingTag}</worksheet>`;
  if (anchors.length === 0) return { worksheet, drawing: null, endRow: transactions.length + 1, imageCount: 0 };
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map((anchor, index) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.column}</xdr:col><xdr:colOff>47625</xdr:colOff><xdr:row>${anchor.row}</xdr:row><xdr:rowOff>47625</xdr:rowOff></xdr:from><xdr:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="${xml(anchor.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${anchor.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${anchor.extent.cx}" cy="${anchor.extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("")}</xdr:wsDr>`;
  const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map((item) => `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${path.basename(item.partName)}"/>`).join("")}</Relationships>`;
  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  return { worksheet, drawing: { xml: drawingXml, rels: drawingRels, sheetRels, media: relationships }, endRow: transactions.length + 1, imageCount: anchors.length };
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
  return { sha256: stable.sha256, size: stable.size, partDigest: canonicalDigest([...expectedParts]), templateFile: template.file, templateSha256: template.sha256 };
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
    const milliunits = parseMilliunits(expected.amount, `${expected.id}.amount`, { allowNegative: true });
    if (formatMilliunits(milliunits) !== expected.amount) fail(`${expected.id}.amount is not canonical.`);
    return { ...clone(expected), milliunits, evidence: [...raw.evidence], missingEvidenceConfirmed: raw.missingEvidenceConfirmed === true };
  });
}

async function loadEvidence(manifest) {
  const evidence = new Map();
  const usedIds = new Set(manifest.transactions.flatMap((item) => item.evidence ?? []));
  for (const raw of manifest.files) {
    if (!usedIds.has(raw.id)) continue;
    if (raw.role !== "material" || raw.disposition !== "used") fail(`evidence ${raw.id} is not a used material.`);
    const filePath = path.resolve(cleanText(raw.path, `files.${raw.id}.path`));
    const stable = await readStableBinaryFile(filePath, { maxBytes: MAX_IMAGE_BYTES });
    if (stable.sha256 !== cleanSha(raw.sha256, `files.${raw.id}.sha256`)) fail(`evidence ${raw.id} SHA changed after manifest audit.`);
    if (raw.kind === "image") {
      const bytes = copyStableBinaryBytes(stable);
      evidence.set(raw.id, { id: raw.id, kind: "image", path: filePath, originalName: path.basename(filePath), sha256: stable.sha256, bytes, ...imageKind(bytes, `evidence ${raw.id}`) });
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

export async function buildReimbursementArtifacts(rawRequest) {
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
  const evidence = await loadEvidence(manifest);
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
      const [detailTemplate, screenshotTemplate] = await Promise.all([
        loadVisualTemplate(profile, "detail"),
        loadVisualTemplate(profile, "screenshot"),
      ]);
      const detail = detailProjection(profile, period, selected, detailTemplate.roles);
      const screenshot = screenshotProjection(profile, selected, evidence, screenshotTemplate.roles);
      const summary = renderProfileSummary(profile, period, selected);
      const safePeriod = period.replace(/[<>:"/\\|?*]/gu, "-");
      const detailPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_本次报销明细.xlsx`);
      const screenshotPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销明细对应截图表.xlsx`);
      const summaryPath = path.join(stagingRoot, `${safePeriod}_${profile.targetCategory}_报销文字说明.odt`);
      const detailState = await writeWorkbook(detailPath, profile.detailSheetName, detail, detailTemplate);
      owned.push({ path: detailPath, ...detailState });
      const screenshotState = await writeWorkbook(screenshotPath, profile.screenshotMapSheetName, screenshot, screenshotTemplate);
      owned.push({ path: screenshotPath, ...screenshotState });
      const summaryState = await writeOdtSummary(summaryPath, summary.text);
      owned.push({ path: summaryPath, ...summaryState });
      const evidenceIds = [...new Set(selected.flatMap((item) => item.evidence))]
        .filter((id) => evidence.get(id)?.kind === "image");
      const evidenceArchive = [];
      for (const [index, evidenceId] of evidenceIds.entries()) {
        const source = evidence.get(evidenceId);
        const finalName = `${String(index + 1).padStart(3, "0")}_${evidenceId}.${source.extension}`;
        const stagedPath = path.join(stagingRoot, `${profileId}_${finalName}`);
        const state = await writeBoundBytes(stagedPath, source.bytes);
        owned.push({ path: stagedPath, ...state });
        evidenceArchive.push({ evidenceId, finalName, path: stagedPath, ...state });
      }
      const body = {
        profileId,
        period,
        periodEndDate: endDate,
        transactionCount: selected.length,
        transactionDigest: canonicalDigest(selected.map(({ milliunits, evidence: imageIds, ...item }) => ({ ...item, evidence: imageIds }))),
        detail: { path: detailPath, ...detailState, sheetName: profile.detailSheetName, endRow: detail.endRow },
        screenshot: { path: screenshotPath, ...screenshotState, sheetName: profile.screenshotMapSheetName, endRow: screenshot.endRow, imageCount: screenshot.imageCount },
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
