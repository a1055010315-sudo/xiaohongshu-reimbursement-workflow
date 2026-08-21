import fs from "node:fs/promises";
import path from "node:path";

import { loadBundledDependency, sha256Bytes } from "./workflow_primitives.mjs";
import { templateAssetPaths } from "./template_assets.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

const configs = {
  "current-detail": {
    sheetName: "本次报销明细", dataStartRow: 7, dataStyleRow: 7, templateRowHeight: 24,
    staticMerges: ["A1:F1", "A2:F2", "A3:B3", "C3:D3", "E3:F3", "A4:B4", "C4:D4", "E4:F4", "A5:C5", "D5:F5"],
    styleRoles: { title: 1, subtitle: 2, summaryLabel: 3, companySummaryLabel: 4, feeSummaryLabel: 5, summaryValue: 6, companySummaryValue: 7, feeSummaryValue: 9, header: 12, groupLabel: 13, groupTotal: 14, date: 15, text: 16, amount: 17, feeTotal: 18, classification: 19, settlement: 19, spacer: 0 },
    rows: [
      [1, 32, [["A", 1, "<分类>｜<主期间>"]]], [2, 24, [["A", 2, "本次报销明细（按人员分类）"]]],
      [3, 24, [["A", 3, "实报合计"], ["C", 4, "对公已付不实报"], ["E", 5, "费用合计"]]],
      [4, 28, [["A", 6], ["C", 7], ["E", 9]]], [5, 24, [["A", 10, "<补报说明>"], ["D", 11, "<无截图说明>"]]],
      [6, 26, [["A", 12, "日期"], ["B", 12, "支出明细"], ["C", 12, "支出金额"], ["D", 12, "费用组合计"], ["E", 12, "费用分类"], ["F", 12, "结算方式"]]],
      [7, 24, [["A", 15], ["B", 16], ["C", 17], ["D", 18], ["E", 19], ["F", 19]]],
    ],
  },
  "screenshot-map": {
    sheetName: "报销明细对应截图表", dataStartRow: 2, dataStyleRow: 2, templateRowHeight: 172.5, staticMerges: [],
    styleRoles: { header: 6, oddDate: 14, oddText: 15, oddAmount: 16, oddNote: 11, image: 12, evenDate: 14, evenText: 15, evenAmount: 16, evenNote: 11 },
    rows: [[1, 28.5, [["A", 6, "日期"], ["B", 6, "支出人/主体"], ["C", 6, "项目"], ["D", 6, "金额"], ["E", 6, "备注"], ["F", 6, "图1"], ["G", 6, "图2"], ["H", 6, "图3"]]], [2, 172.5, [["A", 14], ["B", 15], ["C", 15], ["D", 16], ["E", 11], ["F", 12], ["G", 12], ["H", 12]]]],
  },
  "supplement-detail": {
    sheetName: "补报明细", dataStartRow: 5, dataStyleRow: 5, templateRowHeight: 21.95, staticMerges: ["A1:F1", "A2:F2", "A3:F3"],
    styleRoles: { title: 4, subtitle: 9, summaryLabel: 13, companySummaryLabel: 13, feeSummaryLabel: 13, summaryValue: 32, companySummaryValue: 32, feeSummaryValue: 32, header: 18, groupLabel: 23, groupTotal: 32, date: 31, text: 24, amount: 32, feeTotal: 32, classification: 23, settlement: 23, spacer: 0 },
    rows: [[1, 21.95, [["A", 4, "<人员> <补报期间> 小红书补报明细"]]], [2, 21.95, [["A", 9, "主期<主期间>｜<补报说明>"]]], [3, 21.95, [["A", 13, "补报合计：<金额>元｜共<笔数>笔"]]], [4, 21.95, [["A", 18, "日期"], ["B", 18, "支出明细"], ["C", 18, "单笔金额"], ["D", 18, "费用组合计"], ["E", 18, "备注 / 分类"], ["F", 18, "备注"]]], [5, 21.95, [["A", 31], ["B", 24], ["C", 32], ["D", 32], ["E", 23], ["F", 23]]]],
  },
  "ledger-batch-preview": {
    sheetName: "本批总表增量", dataStartRow: 2, dataStyleRow: 2, templateRowHeight: 21.95, staticMerges: [],
    styleRoles: { headerDate: 2, headerText: 3, headerAmount: 4, date: 73, text: 74, amount: 75, total: 75, person: 74, classification: 74 },
    rows: [[1, 21.95, [["A", 2, "日期"], ["B", 3, "支出明细"], ["C", 4, "支出金额"], ["D", 4, "合计"], ["E", 4, "支出人"], ["F", 3, "备注"]]], [2, 21.95, [["A", 73], ["B", 74], ["C", 75], ["D", 75], ["E", 74], ["F", 74]]]],
  },
};

function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function cell(column, row, style, value) { return value === undefined ? `<c r="${column}${row}" s="${style}"/>` : `<c r="${column}${row}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`; }

async function prepare(id, definition, priorManifest) {
  const file = priorManifest.templates[id].file;
  const filePath = path.join(templateAssetPaths.root, file);
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const oldSheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const columns = /<(?:\w+:)?cols\b[^>]*>[\s\S]*?<\/(?:\w+:)?cols>/iu.exec(oldSheet)?.[0]?.replaceAll(/<(\/?)(?:\w+:)/gu, "<$1") ?? "";
  const rows = definition.rows.map(([row, height, cells]) => `<row r="${row}" ht="${height}" customHeight="1">${cells.map(([column, style, value]) => cell(column, row, style, value)).join("")}</row>`).join("");
  const merges = definition.staticMerges.length ? `<mergeCells count="${definition.staticMerges.length}">${definition.staticMerges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns}<sheetData>${rows}</sheetData>${merges}</worksheet>`;
  zip.file("xl/worksheets/sheet1.xml", worksheet);
  zip.remove("xl/sharedStrings.xml");
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<(?:\w+:)?Relationship\b[^>]*\/sharedStrings[^>]*\/>/giu, ""));
  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  zip.file("[Content_Types].xml", contentTypes.replace(/<(?:\w+:)?Override\b[^>]*\/sharedStrings\.xml[^>]*\/>/giu, ""));
  const workbook = await zip.file("xl/workbook.xml").async("string");
  zip.file("xl/workbook.xml", workbook.replace(/(<(?:\w+:)?sheet\b[^>]*\bname\s*=\s*")[^"]*(")/iu, `$1${definition.sheetName}$2`));
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  await fs.writeFile(filePath, output);
  return { ...priorManifest.templates[id], ...definition, rows: undefined, sha256: sha256Bytes(output) };
}

const manifest = JSON.parse(await fs.readFile(templateAssetPaths.manifest, "utf8"));
const templates = {};
for (const [id, definition] of Object.entries(configs)) templates[id] = await prepare(id, definition, manifest);
await fs.writeFile(templateAssetPaths.manifest, `${JSON.stringify({ schemaVersion: 1, templates }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(Object.fromEntries(Object.entries(templates).map(([id, value]) => [id, value.sha256])))}\n`);
