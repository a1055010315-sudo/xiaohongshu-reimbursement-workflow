import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function loadArtifactTool() {
  return import(pathToFileURL(require.resolve("@oai/artifact-tool")).href);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function serialToIso(value) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
}

async function createFixture(filePath) {
  const { SpreadsheetFile, Workbook } = await loadArtifactTool();
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("Ledger");
  const aux = workbook.worksheets.add("Audit Notes");
  sheet.getRange("A1:F1").values = [["Date", "Person", "Reserved", "Double", "Note", "Amount"]];
  sheet.getRange("A1:F1").format = {
    fill: "#1F4E78",
    font: { bold: true, color: "#FFFFFF", name: "Arial", size: 11 },
    horizontalAlignment: "center",
  };
  const rows = [
    { id: "R1", row: 2, date: "2026-07-30", person: "Alpha", amount: 100.58 },
    { id: "R2", row: 3, date: "2026-06-10", person: "Beta", amount: 10.125 },
    { id: "R3", row: 5, date: "2026-06-30", person: "Gamma", amount: -2 },
    { id: "R4", row: 6, date: "2026-07-10", person: "Same-day first", amount: 3 },
    { id: "R5", row: 7, date: "2026-07-10", person: "Same-day second", amount: 4 },
    { id: "R6", row: 9, date: "2026-05-31", person: "Outside scope", amount: 7 },
    { id: "R7", row: 10, date: "2026-06-01", person: "Start boundary", amount: 1.875 },
  ];
  const fills = ["#FCE4D6", "#DDEBF7", "#E2F0D9", "#FFF2CC", "#E4DFEC", "#D9EAD3", "#F4CCCC"];
  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index];
    sheet.getRange(`A${record.row}:F${record.row}`).values = [[
      new Date(`${record.date}T00:00:00Z`),
      record.person,
      null,
      null,
      `anonymous wrapped note ${record.id}`,
      record.amount,
    ]];
    sheet.getRange(`D${record.row}`).formulas = [[`=F${record.row}*2`]];
    sheet.getRange(`A${record.row}:F${record.row}`).format = {
      fill: fills[index],
      font: {
        bold: index % 2 === 0,
        italic: index % 3 === 0,
        color: index % 2 === 0 ? "#203864" : "#7F6000",
        name: "Arial",
        size: 10 + (index % 3),
      },
      wrapText: index % 2 === 0,
      verticalAlignment: "center",
      borders: { preset: "all", style: "thin", color: "#808080" },
    };
    sheet.getRange(`A${record.row}`).format.numberFormat = "m.d";
    sheet.getRange(`D${record.row}:F${record.row}`).format.numberFormat = index % 2 === 0 ? "0.000" : "0.00";
    sheet.getRange(`A${record.row}:F${record.row}`).format.rowHeight = 22 + index * 3;
    sheet.mergeCells(`B${record.row}:C${record.row}`);
  }
  sheet.getRange("A4:F4").format.rowHeight = 17;
  sheet.getRange("A8:F8").format.rowHeight = 19;
  sheet.getRange("A12:F12").values = [["outside", "must", "remain", "exactly", "unchanged", 123]];
  sheet.getRange("A12:F12").format = { fill: "#C6E0B4", font: { bold: true, color: "#375623" } };
  sheet.getRange("A1:A12").format.columnWidth = 14;
  sheet.getRange("B1:C12").format.columnWidth = 19;
  sheet.getRange("D1:F12").format.columnWidth = 16;
  aux.getRange("A1:B3").values = [["Key", "Value"], ["immutable", 42], ["negative", -1]];
  aux.getRange("A1:B1").format = { fill: "#7030A0", font: { bold: true, color: "#FFFFFF" } };
  aux.getRange("B4").formulas = [["=SUM(B2:B3)"]];
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(filePath);
  return { ok: true, mode: "create", rows };
}

async function createBlockFixture(filePath) {
  const { SpreadsheetFile, Workbook } = await loadArtifactTool();
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("Ledger");
  const aux = workbook.worksheets.add("Audit Notes");
  sheet.getRange("A1:F1").values = [["Date", "Person", "Amount", "Group", "Reserved", "Reserved"]];
  sheet.getRange("A1:F1").format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" } };
  const rows = [
    [new Date("2026-07-20T00:00:00Z"), "Alpha", 100, "alpha-group", null, null],
    [new Date("2026-06-10T00:00:00Z"), "Beta-1", 10, "beta-group", null, null],
    [null, "Beta-2", 20.125, null, null, null],
    [new Date("2026-06-30T00:00:00Z"), "Gamma-1", -2, "gamma-group", null, null],
    [null, "Gamma-2", 4, null, null, null],
    [new Date("2026-05-31T00:00:00Z"), "Outside scope", 7, "outside", null, null],
  ];
  sheet.getRange("A2:F7").values = rows;
  const fills = ["#FCE4D6", "#DDEBF7", "#E2F0D9", "#FFF2CC", "#E4DFEC", "#D9EAD3"];
  for (let offset = 0; offset < rows.length; offset += 1) {
    const row = offset + 2;
    sheet.getRange(`A${row}:F${row}`).format = {
      fill: fills[offset],
      font: { bold: offset % 2 === 0, italic: offset % 3 === 0, color: "#203864", name: "Arial", size: 10 + offset },
      wrapText: true,
      verticalAlignment: "center",
      borders: { preset: "all", style: "thin", color: "#808080" },
      rowHeight: 21 + offset * 4,
    };
    sheet.getRange(`A${row}`).format.numberFormat = "m.d";
    sheet.getRange(`C${row}`).format.numberFormat = "0.000";
  }
  sheet.mergeCells("D2:F2");
  sheet.mergeCells("A3:A4");
  sheet.mergeCells("D3:F4");
  sheet.mergeCells("A5:A6");
  sheet.mergeCells("D5:F6");
  sheet.mergeCells("D7:F7");
  sheet.getRange("A9:F9").values = [["outside", "must", "remain", "exactly", "unchanged", 123]];
  sheet.getRange("A1:A9").format.columnWidth = 14;
  sheet.getRange("B1:B9").format.columnWidth = 19;
  sheet.getRange("C1:F9").format.columnWidth = 16;
  aux.getRange("A1:B2").values = [["Key", "Value"], ["immutable", 42]];
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(filePath);
  return { ok: true, mode: "create-block" };
}

async function verifyAndRender(candidatePath, previewPath) {
  const { FileBlob, SpreadsheetFile } = await loadArtifactTool();
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(candidatePath));
  const sheet = workbook.worksheets.getItem("Ledger");
  const expectedRows = [2, 3, 5, 6, 7, 10].map((row) => ({
    row,
    date: serialToIso(sheet.getRange(`A${row}`).values[0][0]),
    person: sheet.getRange(`B${row}`).values[0][0],
  }));
  const blankRows = [4, 8].map((row) =>
    sheet.getRange(`A${row}:F${row}`).values[0].map((value) => value ?? null),
  );
  const preview = await workbook.render({ sheetName: "Ledger", range: "A1:F12", scale: 1, format: "png" });
  await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()), { flag: "wx" });
  return {
    ok: true,
    mode: "verify-render",
    expectedRows,
    blankRows,
    outsideScopePerson: sheet.getRange("B9").values[0][0],
    outsideScopeMarker: sheet.getRange("A12").values[0][0],
    auxiliaryMarker: workbook.worksheets.getItem("Audit Notes").getRange("A2").values[0][0],
    previewPath: path.resolve(previewPath),
    previewSize: (await fs.stat(previewPath)).size,
  };
}

async function verifyBlockAndRender(candidatePath, previewPath) {
  const { FileBlob, SpreadsheetFile } = await loadArtifactTool();
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(candidatePath));
  const sheet = workbook.worksheets.getItem("Ledger");
  const preview = await workbook.render({ sheetName: "Ledger", range: "A1:F9", scale: 1, format: "png" });
  await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()), { flag: "wx" });
  return {
    ok: true,
    mode: "verify-block",
    persons: [2, 3, 4, 5, 6, 7].map((row) => sheet.getRange(`B${row}`).values[0][0]),
    dates: [2, 4, 6, 7].map((row) => serialToIso(sheet.getRange(`A${row}`).values[0][0])),
    outsideMarker: sheet.getRange("A9").values[0][0],
    auxiliaryMarker: workbook.worksheets.getItem("Audit Notes").getRange("A2").values[0][0],
    previewPath: path.resolve(previewPath),
    previewSize: (await fs.stat(previewPath)).size,
  };
}

try {
  const [mode, firstPath, secondPath] = process.argv.slice(2);
  if (mode === "create" && firstPath && !secondPath) {
    emit(await createFixture(path.resolve(firstPath)));
  } else if (mode === "create-block" && firstPath && !secondPath) {
    emit(await createBlockFixture(path.resolve(firstPath)));
  } else if (mode === "verify-render" && firstPath && secondPath) {
    emit(await verifyAndRender(path.resolve(firstPath), path.resolve(secondPath)));
  } else if (mode === "verify-block" && firstPath && secondPath) {
    emit(await verifyBlockAndRender(path.resolve(firstPath), path.resolve(secondPath)));
  } else {
    throw new Error("Usage: ledger-reorder-artifact-helper.mjs create|create-block <xlsx> | verify-render|verify-block <xlsx> <png>.");
  }
  process.exitCode = 0;
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
