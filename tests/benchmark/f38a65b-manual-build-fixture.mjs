import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function loadPackage(name) { return import(pathToFileURL(require.resolve(name)).href); }
function optionMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || result[key]) throw new Error("fixture arguments must be unique --key value pairs");
    result[key] = path.resolve(value);
  }
  for (const key of ["--baseline", "--detail-template", "--screenshot-template", "--evidence", "--output-root"]) if (!result[key]) throw new Error(`${key} is required`);
  return result;
}

async function exportWorkbook(SpreadsheetFile, workbook, outputPath) {
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
}

const options = optionMap(process.argv.slice(2));
await fs.mkdir(options["--output-root"], { recursive: false });
const originalWrite = process.stdout.write;
process.stdout.write = () => true;
let result;
try {
  const { FileBlob, SpreadsheetFile } = await loadPackage("@oai/artifact-tool");
  const baseline = await SpreadsheetFile.importXlsx(await FileBlob.load(options["--baseline"]));
  const rootSheet = baseline.worksheets.getItemAt(0);
  rootSheet.getRange("A11:F11").copyTo(rootSheet.getRange("A12:F12"), "all");
  rootSheet.getRange("A12:F12").values = [[new Date(Date.UTC(2026, 7, 20)), "旧链脱敏项目", 1.125, null, "脱敏人员", "旧链分类"]];
  rootSheet.getRange("D12").formulas = [["=SUM(C12:C12)"]];
  rootSheet.getRange("A12").format.numberFormat = "mm-dd";
  rootSheet.getRange("C12:D12").format.numberFormat = "0.000";
  const rootPath = path.join(options["--output-root"], "小红书支出总表_修正版1.xlsx");
  await exportWorkbook(SpreadsheetFile, baseline, rootPath);

  const detail = await SpreadsheetFile.importXlsx(await FileBlob.load(options["--detail-template"]));
  const detailSheet = detail.worksheets.getItemAt(0);
  detailSheet.getRange("A7:F7").values = [[new Date(Date.UTC(2026, 7, 20)), "旧链脱敏项目", 1.125, null, "旧链分类", "待报销"]];
  detailSheet.getRange("D7").formulas = [["=SUM(C7:C7)"]];
  detailSheet.getRange("A7").format.numberFormat = "mm-dd";
  detailSheet.getRange("C7:D7").format.numberFormat = "0.000";
  const detailPath = path.join(options["--output-root"], "本次报销明细.xlsx");
  await exportWorkbook(SpreadsheetFile, detail, detailPath);

  const screenshot = await SpreadsheetFile.importXlsx(await FileBlob.load(options["--screenshot-template"]));
  const screenshotSheet = screenshot.worksheets.getItemAt(0);
  screenshotSheet.getRange("A2:H2").values = [[new Date(Date.UTC(2026, 7, 20)), "脱敏人员", "旧链脱敏项目", 1.125, "旧链分类", null, null, null]];
  screenshotSheet.getRange("A2").format.numberFormat = "mm-dd";
  screenshotSheet.getRange("D2").format.numberFormat = "0.000";
  const evidence = await fs.readFile(options["--evidence"]);
  screenshotSheet.images.add({ dataUrl: `data:image/png;base64,${evidence.toString("base64")}`, anchor: { from: { row: 1, col: 5 }, extent: { widthPx: 150, heightPx: 74 } } });
  const screenshotPath = path.join(options["--output-root"], "报销明细对应截图表.xlsx");
  await exportWorkbook(SpreadsheetFile, screenshot, screenshotPath);
  result = { rootPath, detailPath, screenshotPath };
} finally {
  process.stdout.write = originalWrite;
}
process.stdout.write(`${JSON.stringify(result)}\n`);
