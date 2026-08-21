import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildGateBinding } from "../scripts/build_gate_binding.mjs";
import { canonicalDigest } from "../scripts/build_ledger_reorder_gate_artifact.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(skillRoot, "scripts", "build_ledger_reorder_candidate.mjs");
const auditScript = path.join(skillRoot, "scripts", "audit_ledger_reorder.mjs");
const generateScript = path.join(skillRoot, "scripts", "generate_ledger_reorder_plan.mjs");
const gateArtifactScript = path.join(skillRoot, "scripts", "build_ledger_reorder_gate_artifact.mjs");
const promoteScript = path.join(skillRoot, "scripts", "promote_active_revision.mjs");
const auditActiveScript = path.join(skillRoot, "scripts", "audit_active_revisions.mjs");
const publishScript = path.join(skillRoot, "scripts", "publish_ledger_reorder.mjs");
const artifactHelper = path.join(skillRoot, "tests", "ledger-reorder-artifact-helper.mjs");
const runtimeRoot = path.resolve(path.dirname(process.execPath), "..");
const require = createRequire(path.join(runtimeRoot, "__codex_bundled_runtime__.cjs"));

async function loadPackage(name) {
  return import(pathToFileURL(require.resolve(name)).href);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function runJsonScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(lines.length, 1, `Expected exactly one JSON line; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(lines[0]) };
}

function runArtifactHelper(args) {
  const result = spawnSync(process.execPath, [artifactHelper, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  const payloads = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const payload = payloads.findLast((value) => value && typeof value === "object" && "ok" in value);
  assert.ok(payload, `Artifact helper returned no JSON result: ${result.stdout}\n${result.stderr}`);
  assert.equal(payload.ok, true, payload.error);
  return { status: result.status, payload };
}

let tempDir;
let sourcePath;
let outputPath;
let planPath;
let plan;

async function writePlan(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function mutateWorkbook(source, target, mutateSheetXml, sheetName = "sheet1.xml") {
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  const sheetFile = zip.file(`xl/worksheets/${sheetName}`);
  assert.ok(sheetFile, `fixture ${sheetName} is missing`);
  const xml = await sheetFile.async("string");
  zip.file(`xl/worksheets/${sheetName}`, mutateSheetXml(xml));
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
}

async function mutateWorkbookParts(source, target, mutations) {
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  for (const [partName, mutate] of Object.entries(mutations)) {
    const part = zip.file(partName);
    assert.ok(part, `fixture ${partName} is missing`);
    zip.file(partName, mutate(await part.async("string")));
  }
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
}

async function addWorkbookPart(source, target, partName, content) {
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  assert.equal(zip.file(partName), null, `fixture already contains ${partName}`);
  zip.file(partName, content);
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
}

function injectFormulaCell(xml, row, ref, formula) {
  const replaced = xml.replace(
    new RegExp(`(<(?:\\w+:)?row\\b[^>]*\\br="${row}"[^>]*>[\\s\\S]*?)(<\\/(?:\\w+:)?row>)`),
    (_, prefix, suffix) => `${prefix}<c r="${ref}"><f>${formula}</f><v>0</v></c>${suffix}`,
  );
  assert.notEqual(replaced, xml, `failed to inject formula at ${ref}`);
  return replaced;
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ledger-reorder-test-"));
  sourcePath = path.join(tempDir, "anonymous-source.xlsx");
  outputPath = path.join(tempDir, "anonymous-candidate.xlsx");
  planPath = path.join(tempDir, "plan.json");
  const created = runArtifactHelper(["create", sourcePath]);
  assert.equal(created.status, 0, "Anonymous fixture creation must exit cleanly.");
  const rows = created.payload.rows;
  plan = {
    version: 1,
    mode: "ledger-reorder-correction",
    sourcePath,
    outputPath,
    expectedSourceSha256: await sha256File(sourcePath),
    sheetName: "Ledger",
    physicalRange: "A2:F10",
    scopeStart: "2031-06-01",
    scopeStartInclusive: true,
    scopeEnd: "2031-07-30",
    scopeEndInclusive: true,
    sortKeys: ["date:asc", "baselineOrder:asc"],
    stableTieBreaker: "baselineOrder",
    blankRowsPolicy: "preserve-physical",
    recordColumns: ["A", "B", "C", "D", "E", "F"],
    dateColumn: "A",
    amountColumn: "F",
    records: rows.map((record, index) => ({
      id: record.id,
      row: record.row,
      dateSortKey: record.date,
      baselineOrder: (index + 1) * 10,
    })),
    expectedRecordCount: rows.length,
    expectedScopedRecordCount: 6,
    expectedScopedAmount: "117.58",
    expectedAmountDelta: "0",
  };
  await writePlan(planPath, plan);
});

test.after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("builds, exhaustively audits, preserves blank rows, and renders an anonymous preview", async () => {
  const built = runJsonScript(buildScript, ["--plan", planPath]);
  assert.equal(built.status, 0, JSON.stringify(built.payload));
  assert.equal(built.payload.ok, true);
  assert.equal(built.payload.status, "created");
  assert.equal(built.payload.amountDelta, "0");
  assert.equal(built.payload.selfAudit, "passed-before-and-after-promotion");

  const audited = runJsonScript(auditScript, ["--candidate", outputPath, "--plan", planPath]);
  assert.equal(audited.status, 0);
  assert.equal(audited.payload.ok, true);
  assert.equal(audited.payload.audit, "exhaustive");

  const expectedRows = [
    { row: 2, date: "2031-06-01", person: "Start boundary" },
    { row: 3, date: "2031-06-10", person: "Beta" },
    { row: 5, date: "2031-06-30", person: "Gamma" },
    { row: 6, date: "2031-07-10", person: "Same-day first" },
    { row: 7, date: "2031-07-10", person: "Same-day second" },
    { row: 10, date: "2031-07-30", person: "Alpha" },
  ];
  const previewPath = path.join(tempDir, "anonymous-candidate-preview.png");
  const visual = runArtifactHelper(["verify-render", outputPath, previewPath]);
  assert.deepEqual(visual.payload.expectedRows, expectedRows);
  assert.deepEqual(visual.payload.blankRows, [
    [null, null, null, null, null, null],
    [null, null, null, null, null, null],
  ]);
  assert.equal(visual.payload.outsideScopePerson, "Outside scope");
  assert.equal(visual.payload.outsideScopeMarker, "outside");
  assert.equal(visual.payload.auxiliaryMarker, "immutable");
  assert.ok(visual.payload.previewSize > 100);

  const beforeSecondBuild = await sha256File(outputPath);
  const refused = runJsonScript(buildScript, ["--plan", planPath]);
  assert.equal(refused.status, 1);
  assert.match(refused.payload.error, /already exists/i);
  assert.equal(await sha256File(outputPath), beforeSecondBuild);
});

test("rejects a mismatched source hash before creating output", async () => {
  const badPlanPath = path.join(tempDir, "bad-hash-plan.json");
  const badOutputPath = path.join(tempDir, "bad-hash-output.xlsx");
  await writePlan(badPlanPath, {
    ...plan,
    outputPath: badOutputPath,
    expectedSourceSha256: "0".repeat(64),
  });
  const result = runJsonScript(buildScript, ["--plan", badPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /does not match expectedSourceSha256/);
  await assert.rejects(fs.access(badOutputPath));
});

test("rejects genuine amount overprecision instead of rounding it", async () => {
  const overprecisionSource = path.join(tempDir, "overprecision-source.xlsx");
  const overprecisionOutput = path.join(tempDir, "overprecision-output.xlsx");
  await mutateWorkbook(sourcePath, overprecisionSource, (xml) => {
    const replaced = xml.replace(
      /(<(?:\w+:)?c\b[^>]*\br="F2"[^>]*>[\s\S]*?<(?:\w+:)?v>)[^<]*(<\/(?:\w+:)?v>)/,
      (_, prefix, suffix) => `${prefix}1.2345${suffix}`,
    );
    assert.notEqual(replaced, xml, "failed to mutate F2 numeric value");
    return replaced;
  });
  const overprecisionPlanPath = path.join(tempDir, "overprecision-plan.json");
  await writePlan(overprecisionPlanPath, {
    ...plan,
    sourcePath: overprecisionSource,
    outputPath: overprecisionOutput,
    expectedSourceSha256: await sha256File(overprecisionSource),
  });
  const result = runJsonScript(buildScript, ["--plan", overprecisionPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /precision beyond the permitted milliunit boundary/);
  await assert.rejects(fs.access(overprecisionOutput));
});

test("fails closed when a merged child cell contains inline-string residue", async () => {
  const dirtySource = path.join(tempDir, "dirty-merge-source.xlsx");
  const dirtyOutput = path.join(tempDir, "dirty-merge-output.xlsx");
  await mutateWorkbook(sourcePath, dirtySource, (xml) => {
    const selfClosing = /<(\w+:)?c\b([^>]*\br="C2"[^>]*)\/>/;
    const full = /<(\w+:)?c\b([^>]*\br="C2"[^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/;
    if (selfClosing.test(xml)) {
      return xml.replace(selfClosing, '<$1c $2 t="inlineStr"><$1is><$1t>residue</$1t></$1is></$1c>');
    }
    if (full.test(xml)) {
      return xml.replace(full, '<$1c $2 t="inlineStr"><$1is><$1t>residue</$1t></$1is></$1c>');
    }
    throw new Error("failed to locate merged child C2");
  });
  const dirtyPlanPath = path.join(tempDir, "dirty-merge-plan.json");
  await writePlan(dirtyPlanPath, {
    ...plan,
    sourcePath: dirtySource,
    outputPath: dirtyOutput,
    expectedSourceSha256: await sha256File(dirtySource),
  });
  const result = runJsonScript(buildScript, ["--plan", dirtyPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /merged child cells contain value\/formula\/inline-string payload/i);
  await assert.rejects(fs.access(dirtyOutput));
});

test("fails closed when an outside formula depends on a reordered cell", async () => {
  const dependentSource = path.join(tempDir, "dependent-formula-source.xlsx");
  const dependentOutput = path.join(tempDir, "dependent-formula-output.xlsx");
  await mutateWorkbook(sourcePath, dependentSource, (xml) => {
    const replaced = xml.replace(
      /(<(?:\w+:)?row\b[^>]*\br="1"[^>]*>[\s\S]*?)(<\/(?:\w+:)?row>)/,
      (_, prefix, suffix) => `${prefix}<c r="G1"><f>B2</f><v>0</v></c>${suffix}`,
    );
    assert.notEqual(replaced, xml, "failed to inject the outside dependency formula");
    return replaced;
  });
  const dependentPlanPath = path.join(tempDir, "dependent-formula-plan.json");
  await writePlan(dependentPlanPath, {
    ...plan,
    sourcePath: dependentSource,
    outputPath: dependentOutput,
    expectedSourceSha256: await sha256File(dependentSource),
  });
  const result = runJsonScript(buildScript, ["--plan", dependentPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /formula outside the movable records depends on reordered cells/i);
  await assert.rejects(fs.access(dependentOutput));
});

test("detects an unquoted Unicode sheet name in an outside formula dependency", async () => {
  const unicodeSource = path.join(tempDir, "unicode-sheet-formula-source.xlsx");
  const unicodeOutput = path.join(tempDir, "unicode-sheet-formula-output.xlsx");
  await mutateWorkbookParts(sourcePath, unicodeSource, {
    "xl/workbook.xml": (xml) => {
      const replaced = xml.replace(/(<(?:\w+:)?sheet\b[^>]*\bname=)"Ledger"/i, '$1"支出总表"');
      assert.notEqual(replaced, xml, "failed to rename the target worksheet");
      return replaced;
    },
    "xl/worksheets/sheet2.xml": (xml) => injectFormulaCell(xml, 1, "G1", "支出总表!B2"),
  });
  const unicodePlanPath = path.join(tempDir, "unicode-sheet-formula-plan.json");
  await writePlan(unicodePlanPath, {
    ...plan,
    sourcePath: unicodeSource,
    outputPath: unicodeOutput,
    expectedSourceSha256: await sha256File(unicodeSource),
    sheetName: "支出总表",
  });
  const result = runJsonScript(buildScript, ["--plan", unicodePlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /formula outside the movable records depends on reordered cells/i);
  await assert.rejects(fs.access(unicodeOutput));
});

test("fails closed when another sheet's conditional formula depends on a reordered cell", async () => {
  const structuralSource = path.join(tempDir, "cross-sheet-conditional-formula-source.xlsx");
  const structuralOutput = path.join(tempDir, "cross-sheet-conditional-formula-output.xlsx");
  await mutateWorkbook(sourcePath, structuralSource, (xml) => {
    const replaced = xml.replace(
      /<\/(?:\w+:)?worksheet>\s*$/i,
      '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>\'Ledger\'!B2&gt;0</formula></cfRule></conditionalFormatting></worksheet>',
    );
    assert.notEqual(replaced, xml, "failed to inject cross-sheet conditional formula");
    return replaced;
  }, "sheet2.xml");
  const structuralPlanPath = path.join(tempDir, "cross-sheet-conditional-formula-plan.json");
  await writePlan(structuralPlanPath, {
    ...plan,
    sourcePath: structuralSource,
    outputPath: structuralOutput,
    expectedSourceSha256: await sha256File(structuralSource),
  });
  const result = runJsonScript(buildScript, ["--plan", structuralPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /non-cell formula depends on reordered cells/i);
  await assert.rejects(fs.access(structuralOutput));
});

test("fails closed when a chart-series formula depends on a reordered cell", async () => {
  const chartSource = path.join(tempDir, "chart-formula-source.xlsx");
  const chartOutput = path.join(tempDir, "chart-formula-output.xlsx");
  await addWorkbookPart(
    sourcePath,
    chartSource,
    "xl/charts/chart999.xml",
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart><c:ser><c:f>\'Ledger\'!$B$2:$B$10</c:f></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>',
  );
  const chartPlanPath = path.join(tempDir, "chart-formula-plan.json");
  await writePlan(chartPlanPath, {
    ...plan,
    sourcePath: chartSource,
    outputPath: chartOutput,
    expectedSourceSha256: await sha256File(chartSource),
  });
  const result = runJsonScript(buildScript, ["--plan", chartPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /non-cell formula depends on reordered cells/i);
  await assert.rejects(fs.access(chartOutput));
});

test("fails closed when a table calculated-column formula depends on a reordered cell", async () => {
  const tableSource = path.join(tempDir, "table-formula-source.xlsx");
  const tableOutput = path.join(tempDir, "table-formula-output.xlsx");
  await addWorkbookPart(
    sourcePath,
    tableSource,
    "xl/tables/table999.xml",
    '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><tableColumns count="1"><tableColumn id="1" name="anonymous"><calculatedColumnFormula>\'Ledger\'!B2</calculatedColumnFormula></tableColumn></tableColumns></table>',
  );
  const tablePlanPath = path.join(tempDir, "table-formula-plan.json");
  await writePlan(tablePlanPath, {
    ...plan,
    sourcePath: tableSource,
    outputPath: tableOutput,
    expectedSourceSha256: await sha256File(tableSource),
  });
  const result = runJsonScript(buildScript, ["--plan", tablePlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /non-cell formula depends on reordered cells/i);
  await assert.rejects(fs.access(tableOutput));
});

test("fails closed when workbook formulas use R1C1 reference mode", async () => {
  const r1c1Source = path.join(tempDir, "r1c1-source.xlsx");
  const r1c1Output = path.join(tempDir, "r1c1-output.xlsx");
  await mutateWorkbookParts(sourcePath, r1c1Source, {
    "xl/workbook.xml": (xml) => {
      if (/<(?:\w+:)?calcPr\b/i.test(xml)) {
        const replaced = xml.replace(/<((?:\w+:)?calcPr)\b[^>]*\/?\s*>/i, '<$1 refMode="R1C1"/>');
        assert.notEqual(replaced, xml, "failed to set R1C1 mode");
        return replaced;
      }
      const replaced = xml.replace(/<\/(?:\w+:)?workbook>/i, '<calcPr refMode="R1C1"/></workbook>');
      assert.notEqual(replaced, xml, "failed to inject R1C1 mode");
      return replaced;
    },
  });
  const r1c1PlanPath = path.join(tempDir, "r1c1-plan.json");
  await writePlan(r1c1PlanPath, {
    ...plan,
    sourcePath: r1c1Source,
    outputPath: r1c1Output,
    expectedSourceSha256: await sha256File(r1c1Source),
  });
  const result = runJsonScript(buildScript, ["--plan", r1c1PlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /R1C1 workbook reference mode cannot be proven safe/i);
  await assert.rejects(fs.access(r1c1Output));
});

test("fails closed when a calculation chain could retain stale formula coordinates", async () => {
  const chainSource = path.join(tempDir, "calc-chain-source.xlsx");
  const chainOutput = path.join(tempDir, "calc-chain-output.xlsx");
  await addWorkbookPart(
    sourcePath,
    chainSource,
    "xl/calcChain.xml",
    '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="D2" i="1"/></calcChain>',
  );
  const chainPlanPath = path.join(tempDir, "calc-chain-plan.json");
  await writePlan(chainPlanPath, {
    ...plan,
    sourcePath: chainSource,
    outputPath: chainOutput,
    expectedSourceSha256: await sha256File(chainSource),
  });
  const result = runJsonScript(buildScript, ["--plan", chainPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /calcChain formula coordinates cannot be proven/i);
  await assert.rejects(fs.access(chainOutput));
});

test("fails closed on overlapping, whole-row, case-folded, and same-row outside dependencies", async () => {
  const cases = [
    ["overlap", 1, "G1", "SUM(B2:B10,B2)", /formula outside the movable records depends on reordered cells/i],
    ["whole-row", 1, "G1", "SUM(2:2)", /formula outside the movable records depends on reordered cells/i],
    ["case-folded", 1, "G1", "ledger!B2", /formula outside the movable records depends on reordered cells/i],
    ["quoted-3d", 1, "G1", "'Ledger 2026:Summary 2026'!B2", /external or 3D formula references cannot be proven safe/i],
    ["unicode-3d", 1, "G1", "SUM(支出总表:末表!B2)", /external or 3D formula references cannot be proven safe/i],
    ["outside-offset", 1, "G1", "OFFSET(B1,1,0)", /dynamic reference formula cannot be proven independent/i],
    ["outside-indirect", 1, "G1", "INDIRECT(&quot;B&quot;&amp;2)", /dynamic reference formula cannot be proven independent/i],
    ["weighted-product", 1, "G1", "SUM(B2:B10*Z2:Z10)", /formula outside the movable records depends on reordered cells/i],
    ["beyond-xfd", 1, "G1", "XFE1", /outside Excel's XFD1048576 worksheet boundary/i],
    ["outside-column", 2, "G2", "B2", /detach content or merges outside physicalRange/i],
  ];
  for (const [name, row, ref, formula, expectedError] of cases) {
    const formulaSource = path.join(tempDir, `${name}-formula-source.xlsx`);
    const formulaOutput = path.join(tempDir, `${name}-formula-output.xlsx`);
    await mutateWorkbook(sourcePath, formulaSource, (xml) => injectFormulaCell(xml, row, ref, formula));
    const formulaPlanPath = path.join(tempDir, `${name}-formula-plan.json`);
    await writePlan(formulaPlanPath, {
      ...plan,
      sourcePath: formulaSource,
      outputPath: formulaOutput,
      expectedSourceSha256: await sha256File(formulaSource),
    });
    const result = runJsonScript(buildScript, ["--plan", formulaPlanPath]);
    assert.equal(result.status, 1, `${name}: ${JSON.stringify(result.payload)}`);
    assert.match(result.payload.error, expectedError);
    await assert.rejects(fs.access(formulaOutput));
  }
});

test("rejects out-of-grid and excessively large physical ranges before iteration", async () => {
  for (const [name, physicalRange, expectedError] of [
    ["out-of-grid", "A2:XFE10", /outside Excel's XFD1048576 worksheet boundary/i],
    ["too-large", "A1:XFD1048576", /exceeds the 100000-cell execution boundary/i],
  ]) {
    const badOutput = path.join(tempDir, `${name}-range-output.xlsx`);
    const badPlanPath = path.join(tempDir, `${name}-range-plan.json`);
    await writePlan(badPlanPath, { ...plan, outputPath: badOutput, physicalRange });
    const result = runJsonScript(buildScript, ["--plan", badPlanPath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, expectedError);
    await assert.rejects(fs.access(badOutput));
  }
});

test("fails closed when a hyperlink is attached to a movable evidence cell", async () => {
  const hyperlinkSource = path.join(tempDir, "hyperlink-source.xlsx");
  const hyperlinkOutput = path.join(tempDir, "hyperlink-output.xlsx");
  await mutateWorkbook(sourcePath, hyperlinkSource, (xml) => {
    const replaced = xml.replace(
      /<\/(?:\w+:)?worksheet>\s*$/i,
      '<hyperlinks><hyperlink ref="G2" location="Ledger!A1" display="anonymous evidence"/></hyperlinks></worksheet>',
    );
    assert.notEqual(replaced, xml, "failed to inject hyperlink metadata");
    return replaced;
  });
  const hyperlinkPlanPath = path.join(tempDir, "hyperlink-plan.json");
  await writePlan(hyperlinkPlanPath, {
    ...plan,
    sourcePath: hyperlinkSource,
    outputPath: hyperlinkOutput,
    expectedSourceSha256: await sha256File(hyperlinkSource),
  });
  const result = runJsonScript(buildScript, ["--plan", hyperlinkPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /hyperlink Ledger!G2 is bound to an actually moved row/i);
  await assert.rejects(fs.access(hyperlinkOutput));
});

test("fails closed when another sheet hyperlinks to an actually moved ledger row", async () => {
  const hyperlinkSource = path.join(tempDir, "cross-sheet-hyperlink-source.xlsx");
  const hyperlinkOutput = path.join(tempDir, "cross-sheet-hyperlink-output.xlsx");
  await mutateWorkbook(sourcePath, hyperlinkSource, (xml) => {
    const replaced = xml.replace(
      /<\/(?:\w+:)?worksheet>\s*$/i,
      '<hyperlinks><hyperlink ref="A1" location="\'Ledger\'!B2" display="anonymous jump"/></hyperlinks></worksheet>',
    );
    assert.notEqual(replaced, xml, "failed to inject cross-sheet hyperlink metadata");
    return replaced;
  }, "sheet2.xml");
  const hyperlinkPlanPath = path.join(tempDir, "cross-sheet-hyperlink-plan.json");
  await writePlan(hyperlinkPlanPath, {
    ...plan,
    sourcePath: hyperlinkSource,
    outputPath: hyperlinkOutput,
    expectedSourceSha256: await sha256File(hyperlinkSource),
  });
  const result = runJsonScript(buildScript, ["--plan", hyperlinkPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /hyperlink .*A1 points to an actually moved ledger row/i);
  await assert.rejects(fs.access(hyperlinkOutput));
});

test("fails closed on pivot and opaque extension metadata in the target sheet", async () => {
  for (const [name, metadata, expectedError] of [
    ["pivot", '<pivotTableParts count="1"><pivotTablePart r:id="rId999"/></pivotTableParts>', /tables, pivots, drawings/i],
    ["extension", '<extLst><ext uri="anonymous"/></extLst>', /extension metadata/i],
  ]) {
    const structuralSource = path.join(tempDir, `${name}-metadata-source.xlsx`);
    const structuralOutput = path.join(tempDir, `${name}-metadata-output.xlsx`);
    await mutateWorkbook(sourcePath, structuralSource, (xml) => {
      const replaced = xml.replace(/<\/(?:\w+:)?worksheet>\s*$/i, `${metadata}</worksheet>`);
      assert.notEqual(replaced, xml, `failed to inject ${name} metadata`);
      return replaced;
    });
    const structuralPlanPath = path.join(tempDir, `${name}-metadata-plan.json`);
    await writePlan(structuralPlanPath, {
      ...plan,
      sourcePath: structuralSource,
      outputPath: structuralOutput,
      expectedSourceSha256: await sha256File(structuralSource),
    });
    const result = runJsonScript(buildScript, ["--plan", structuralPlanPath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, expectedError);
    await assert.rejects(fs.access(structuralOutput));
  }
});

test("fails closed on cell metadata indexes inside movable records", async () => {
  const metadataSource = path.join(tempDir, "cell-metadata-source.xlsx");
  const metadataOutput = path.join(tempDir, "cell-metadata-output.xlsx");
  await mutateWorkbook(sourcePath, metadataSource, (xml) => {
    const replaced = xml.replace(
      /<((?:\w+:)?c)\b([^>]*\br="B2"[^>]*)>/i,
      '<$1$2 cm="1">',
    );
    assert.notEqual(replaced, xml, "failed to inject a cell metadata index");
    return replaced;
  });
  const metadataPlanPath = path.join(tempDir, "cell-metadata-plan.json");
  await writePlan(metadataPlanPath, {
    ...plan,
    sourcePath: metadataSource,
    outputPath: metadataOutput,
    expectedSourceSha256: await sha256File(metadataSource),
  });
  const result = runJsonScript(buildScript, ["--plan", metadataPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /cell Ledger!B2 contains metadata attributes.*cm/i);
  await assert.rejects(fs.access(metadataOutput));
});

test("fails closed when worksheet coordinates are implicit", async () => {
  for (const [name, mutate, expected] of [
    [
      "implicit-cell",
      (xml) => xml.replace(
        /(<(?:\w+:)?row\b[^>]*\br="1"[^>]*>[\s\S]*?)(<\/(?:\w+:)?row>)/,
        '$1<c><f>B2</f><v>0</v></c>$2',
      ),
      /cell without an explicit r coordinate/i,
    ],
    [
      "implicit-row",
      (xml) => xml.replace(/(<(?:\w+:)?row\b[^>]*?)\s+r="2"([^>]*>)/i, "$1$2"),
      /row without an explicit r coordinate/i,
    ],
  ]) {
    const implicitSource = path.join(tempDir, `${name}-source.xlsx`);
    const implicitOutput = path.join(tempDir, `${name}-output.xlsx`);
    await mutateWorkbook(sourcePath, implicitSource, (xml) => {
      const replaced = mutate(xml);
      assert.notEqual(replaced, xml, `failed to inject ${name}`);
      return replaced;
    });
    const implicitPlanPath = path.join(tempDir, `${name}-plan.json`);
    await writePlan(implicitPlanPath, {
      ...plan,
      sourcePath: implicitSource,
      outputPath: implicitOutput,
      expectedSourceSha256: await sha256File(implicitSource),
    });
    const result = runJsonScript(buildScript, ["--plan", implicitPlanPath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, expected);
    await assert.rejects(fs.access(implicitOutput));
  }
});

test("audit detects semantic cell and formula metadata loss or injection", async () => {
  const outsideSource = path.join(tempDir, "outside-formula-metadata-source.xlsx");
  const outsideCandidate = path.join(tempDir, "outside-formula-metadata-candidate.xlsx");
  await mutateWorkbook(sourcePath, outsideSource, (xml) => {
    const injected = injectFormulaCell(xml, 1, "G1", "B1");
    const replaced = injected.replace('<f>B1</f>', '<f ca="1">B1</f>');
    assert.notEqual(replaced, injected, "failed to add formula metadata");
    return replaced;
  });
  await mutateWorkbook(outsideSource, outsideCandidate, (xml) => {
    const replaced = xml.replace('<f ca="1">B1</f>', '<f>B1</f>');
    assert.notEqual(replaced, xml, "failed to remove formula metadata");
    return replaced;
  });
  const outsidePlanPath = path.join(tempDir, "outside-formula-metadata-plan.json");
  await writePlan(outsidePlanPath, {
    ...plan,
    sourcePath: outsideSource,
    outputPath: outsideCandidate,
    expectedSourceSha256: await sha256File(outsideSource),
  });
  const outsideResult = runJsonScript(auditScript, ["--candidate", outsideCandidate, "--plan", outsidePlanPath]);
  assert.equal(outsideResult.status, 1);
  assert.match(outsideResult.payload.error, /formula OOXML metadata changed outside the reorder scope/i);

  const movableCandidate = path.join(tempDir, "movable-cell-metadata-candidate.xlsx");
  await mutateWorkbook(sourcePath, movableCandidate, (xml) => {
    const replaced = xml.replace(/<((?:\w+:)?c)\b([^>]*\br="B2"[^>]*)>/i, '<$1$2 vm="1">');
    assert.notEqual(replaced, xml, "failed to add candidate cell metadata");
    return replaced;
  });
  const movablePlanPath = path.join(tempDir, "movable-cell-metadata-audit-plan.json");
  await writePlan(movablePlanPath, {
    ...plan,
    outputPath: movableCandidate,
  });
  const movableResult = runJsonScript(auditScript, ["--candidate", movableCandidate, "--plan", movablePlanPath]);
  assert.equal(movableResult.status, 1);
  assert.match(movableResult.payload.error, /candidate cell Ledger!B2 contains metadata attributes.*vm/i);
});

test("fails closed when a used defined name can reference reordered cells", async () => {
  const namedSource = path.join(tempDir, "defined-name-source.xlsx");
  const namedOutput = path.join(tempDir, "defined-name-output.xlsx");
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(sourcePath));
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  const workbookFile = zip.file("xl/workbook.xml");
  assert.ok(sheetFile && workbookFile, "fixture workbook parts are missing");
  const sheetXml = await sheetFile.async("string");
  const workbookXml = await workbookFile.async("string");
  zip.file("xl/worksheets/sheet1.xml", injectFormulaCell(sheetXml, 1, "G1", "SUM(MovedAlias)"));
  const namedWorkbookXml = workbookXml.replace(
    /<\/(?:\w+:)?workbook>/i,
    '<definedNames><definedName name="MovedRows">\'Ledger\'!$B$2:$B$10</definedName><definedName name="MovedAlias">MovedRows</definedName></definedNames></workbook>',
  );
  assert.notEqual(namedWorkbookXml, workbookXml, "failed to add the defined name");
  zip.file("xl/workbook.xml", namedWorkbookXml);
  await fs.writeFile(namedSource, await zip.generateAsync({ type: "nodebuffer" }), { flag: "wx" });
  const namedPlanPath = path.join(tempDir, "defined-name-plan.json");
  await writePlan(namedPlanPath, {
    ...plan,
    sourcePath: namedSource,
    outputPath: namedOutput,
    expectedSourceSha256: await sha256File(namedSource),
  });
  const result = runJsonScript(buildScript, ["--plan", namedPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /defined name (?:MovedRows|MovedAlias) can reference reordered cells/i);
  await assert.rejects(fs.access(namedOutput));
});

test("fails closed on an unused defined name bound to a moved record", async () => {
  const namedSource = path.join(tempDir, "unused-defined-name-source.xlsx");
  const namedOutput = path.join(tempDir, "unused-defined-name-output.xlsx");
  await mutateWorkbookParts(sourcePath, namedSource, {
    "xl/workbook.xml": (xml) => {
      const replaced = xml.replace(
        /<\/(?:\w+:)?workbook>/i,
        '<definedNames><definedName name="UnusedMoved">\'Ledger\'!$B$2</definedName></definedNames></workbook>',
      );
      assert.notEqual(replaced, xml, "failed to inject unused defined name");
      return replaced;
    },
  });
  const namedPlanPath = path.join(tempDir, "unused-defined-name-plan.json");
  await writePlan(namedPlanPath, {
    ...plan,
    sourcePath: namedSource,
    outputPath: namedOutput,
    expectedSourceSha256: await sha256File(namedSource),
  });
  const result = runJsonScript(buildScript, ["--plan", namedPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /defined name UnusedMoved can reference reordered cells even without/i);
  await assert.rejects(fs.access(namedOutput));
});

test("fails closed on a row-dependent formula inside a moving record", async () => {
  const rowFormulaSource = path.join(tempDir, "row-formula-source.xlsx");
  const rowFormulaOutput = path.join(tempDir, "row-formula-output.xlsx");
  await mutateWorkbook(sourcePath, rowFormulaSource, (xml) => {
    const replaced = xml.replace(
      /(<(?:\w+:)?c\b[^>]*\br="D2"[^>]*>[\s\S]*?<(?:\w+:)?f[^>]*>)[\s\S]*?(<\/(?:\w+:)?f>)/,
      (_, prefix, suffix) => `${prefix}ROW()${suffix}`,
    );
    assert.notEqual(replaced, xml, "failed to replace D2 with ROW()");
    return replaced;
  });
  const rowFormulaPlanPath = path.join(tempDir, "row-formula-plan.json");
  await writePlan(rowFormulaPlanPath, {
    ...plan,
    sourcePath: rowFormulaSource,
    outputPath: rowFormulaOutput,
    expectedSourceSha256: await sha256File(rowFormulaSource),
  });
  const result = runJsonScript(buildScript, ["--plan", rowFormulaPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /row-dependent.*formula moves with record/i);
  await assert.rejects(fs.access(rowFormulaOutput));
});

test("fails closed when row-height migration would affect an outside column", async () => {
  const outsideColumnSource = path.join(tempDir, "outside-column-source.xlsx");
  const outsideColumnOutput = path.join(tempDir, "outside-column-output.xlsx");
  await mutateWorkbook(sourcePath, outsideColumnSource, (xml) => {
    const replaced = xml.replace(
      /(<(?:\w+:)?row\b[^>]*\br="10"[^>]*>[\s\S]*?)(<\/(?:\w+:)?row>)/,
      (_, prefix, suffix) => `${prefix}<c r="G10" t="inlineStr"><is><t>outside-column</t></is></c>${suffix}`,
    );
    assert.notEqual(replaced, xml, "failed to inject G10 outside-column content");
    return replaced;
  });
  const outsideColumnPlanPath = path.join(tempDir, "outside-column-plan.json");
  await writePlan(outsideColumnPlanPath, {
    ...plan,
    sourcePath: outsideColumnSource,
    outputPath: outsideColumnOutput,
    expectedSourceSha256: await sha256File(outsideColumnSource),
  });
  const result = runJsonScript(buildScript, ["--plan", outsideColumnPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /outside physicalRange/i);
  await assert.rejects(fs.access(outsideColumnOutput));
});

test("fails closed when moving A:F would detach a static outside-column value", async () => {
  const outsideSource = path.join(tempDir, "outside-static-source.xlsx");
  const outsideOutput = path.join(tempDir, "outside-static-output.xlsx");
  await mutateWorkbook(sourcePath, outsideSource, (xml) => {
    const replaced = xml.replace(
      /(<(?:\w+:)?row\b[^>]*\br="2"[^>]*>[\s\S]*?)(<\/(?:\w+:)?row>)/,
      (_, prefix, suffix) => `${prefix}<c r="G2" t="inlineStr"><is><t>outside-record</t></is></c>${suffix}`,
    );
    assert.notEqual(replaced, xml, "failed to inject G2 outside value");
    return replaced;
  });
  const outsidePlanPath = path.join(tempDir, "outside-static-plan.json");
  await writePlan(outsidePlanPath, {
    ...plan,
    sourcePath: outsideSource,
    outputPath: outsideOutput,
    expectedSourceSha256: await sha256File(outsideSource),
  });
  const result = runJsonScript(buildScript, ["--plan", outsidePlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /detach content or merges outside physicalRange/i);
  await assert.rejects(fs.access(outsideOutput));
});

test("fails closed before export when a default source height would have to clear a custom target height", async () => {
  const defaultHeightSource = path.join(tempDir, "default-height-source.xlsx");
  const defaultHeightOutput = path.join(tempDir, "default-height-output.xlsx");
  await mutateWorkbook(sourcePath, defaultHeightSource, (xml) => {
    const rowPattern = /<(?:\w+:)?row\b[^>]*\br="10"[^>]*>/;
    const match = rowPattern.exec(xml);
    assert.ok(match, "failed to locate row 10");
    const replacement = match[0]
      .replace(/\s+ht=(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\s+customHeight=(?:"[^"]*"|'[^']*')/i, "");
    assert.notEqual(replacement, match[0], "row 10 did not have an explicit height to remove");
    return xml.replace(rowPattern, replacement);
  });
  const defaultHeightPlanPath = path.join(tempDir, "default-height-plan.json");
  await writePlan(defaultHeightPlanPath, {
    ...plan,
    sourcePath: defaultHeightSource,
    outputPath: defaultHeightOutput,
    expectedSourceSha256: await sha256File(defaultHeightSource),
  });
  const result = runJsonScript(buildScript, ["--plan", defaultHeightPlanPath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /default row height cannot be safely cleared/i);
  await assert.rejects(fs.access(defaultHeightOutput));
});

test("mechanically generates and executes a v2 plan for vertical merged record blocks", async () => {
  const token = crypto.randomBytes(12).toString("hex");
  const rootPath = path.join(tempDir, "block-root");
  const archivePath = path.join(rootPath, "archive");
  const historyPath = path.join(rootPath, "archive-history");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await fs.mkdir(rootPath);
  await Promise.all([fs.mkdir(archivePath), fs.mkdir(historyPath), fs.mkdir(stagingRoot)]);
  try {
    await fs.writeFile(
      path.join(stagingRoot, ".codex-xhs-owner.json"),
      `${JSON.stringify({ kind: "xiaohongshu-reimbursement-temp", version: 1, token })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    const blockSource = path.join(rootPath, "baseline.xlsx");
    const blockCandidate = path.join(stagingRoot, "anonymous-block_修正版1.xlsx");
    const requestPath = path.join(stagingRoot, "request.json");
    const generatedPlanPath = path.join(stagingRoot, "generated-plan.json");
    const created = runArtifactHelper(["create-block", blockSource]);
    assert.equal(created.status, 0);
    await writePlan(requestPath, {
      version: 1,
      mode: "ledger-reorder-plan-request",
      rootPath,
      stagingRoot,
      stagingToken: token,
      sourcePath: blockSource,
      outputPath: blockCandidate,
      activeCandidatePath: path.join(archivePath, "anonymous-block_修正版1.xlsx"),
      targetPath: path.join(rootPath, "小红书支出总表.xlsx"),
      candidateRevision: 1,
      sheetName: "Ledger",
      physicalRange: "A2:F7",
      scopeStart: "2031-06-01",
      scopeStartInclusive: true,
      scopeEnd: "2031-07-30",
      scopeEndInclusive: true,
      dateColumn: "A",
      amountColumn: "C",
      recordDetection: "merge-connected-components",
    });
    const generated = runJsonScript(generateScript, ["--out", generatedPlanPath, "--request", requestPath]);
    assert.equal(generated.status, 0, JSON.stringify(generated.payload));
    assert.equal(generated.payload.status, "plan_created");
    assert.equal(generated.payload.expectedRecordCount, 4);
    assert.equal(generated.payload.expectedPhysicalRecordRowCount, 6);
    assert.equal(generated.payload.expectedScopedRecordCount, 3);
    assert.equal(generated.payload.expectedScopedRowCount, 5);
    assert.equal(generated.payload.expectedScopedAmount, "132.125");
    const generatedPlan = JSON.parse(await fs.readFile(generatedPlanPath, "utf8"));
    assert.deepEqual(generatedPlan.records.map(({ startRow, endRow }) => [startRow, endRow]), [
      [2, 2],
      [3, 4],
      [5, 6],
      [7, 7],
    ]);

    const wrongCandidate = runJsonScript(auditScript, ["--plan", generatedPlanPath, "--candidate", blockSource]);
    assert.equal(wrongCandidate.status, 1);
    assert.match(wrongCandidate.payload.error, /exactly a candidate path bound by the plan/);

    const built = runJsonScript(buildScript, ["--plan", generatedPlanPath]);
    assert.equal(built.status, 0, JSON.stringify(built.payload));
    assert.equal(built.payload.ok, true);
    assert.equal(built.payload.planVersion, 2);
    assert.equal(built.payload.amountDelta, "0");
    assert.equal(built.payload.planFileSha256, generated.payload.planFileSha256);
    const audited = runJsonScript(auditScript, ["--candidate", blockCandidate, "--plan", generatedPlanPath]);
    assert.equal(audited.status, 0, JSON.stringify(audited.payload));
    const promotionPlanPath = path.join(stagingRoot, "promotion-plan.json");
    await writePlan(promotionPlanPath, {
      version: 1,
      archivePath,
      historyPath,
      artifactKind: "anonymous-block",
      candidatePath: blockCandidate,
      candidateSha256: audited.payload.candidateSha256,
      candidateRevision: generatedPlan.candidateRevision,
      expectedCurrentPath: null,
      expectedCurrentSha256: null,
    });
    const promoted = runJsonScript(promoteScript, ["--plan", promotionPlanPath]);
    assert.equal(promoted.status, 0, JSON.stringify(promoted.payload));
    assert.equal(promoted.payload.status, "created");
    assert.equal(promoted.payload.current.path, generatedPlan.activeCandidatePath);
    const activeRevisionAudit = runJsonScript(auditActiveScript, ["--plan", promotionPlanPath]);
    assert.equal(activeRevisionAudit.status, 0, JSON.stringify(activeRevisionAudit.payload));
    assert.equal(activeRevisionAudit.payload.status, "valid");
    const activeAudited = runJsonScript(auditScript, [
      "--candidate",
      generatedPlan.activeCandidatePath,
      "--plan",
      generatedPlanPath,
    ]);
    assert.equal(activeAudited.status, 0, JSON.stringify(activeAudited.payload));
    assert.equal(activeAudited.payload.candidateSha256, audited.payload.candidateSha256);
    const previewPath = path.join(stagingRoot, "block-preview.png");
    const visual = runArtifactHelper(["verify-block", generatedPlan.activeCandidatePath, previewPath]);
    assert.deepEqual(visual.payload.persons, ["Beta-1", "Beta-2", "Gamma-1", "Gamma-2", "Alpha", "Outside scope"]);
    assert.deepEqual(visual.payload.dates, ["2031-06-10", "2031-06-30", "2031-07-20", "2031-05-31"]);
    assert.equal(visual.payload.outsideMarker, "outside");
    assert.equal(visual.payload.auxiliaryMarker, "immutable");
    assert.ok(visual.payload.previewSize > 100);
    const previewIndexPath = path.join(stagingRoot, "preview-index.json");
    const batchId = "anonymous-ledger-reorder-batch";
    const operationDigest = sha256(Buffer.from("anonymous bound reorder operation", "utf8"));
    const factsDigest = sha256(Buffer.from("anonymous reconciled facts", "utf8"));
    const gate1Path = path.join(stagingRoot, "gate-1-artifact.json");
    const gate2Path = path.join(stagingRoot, "gate-2-artifact.json");
    const gate1 = runJsonScript(gateArtifactScript, [
      "--gate", "gate-1",
      "--plan", generatedPlanPath,
      "--batch-id", batchId,
      "--operation-digest", operationDigest,
      "--facts-digest", factsDigest,
      "--preview-index", previewIndexPath,
      "--out", gate1Path,
    ]);
    assert.equal(gate1.status, 0, JSON.stringify(gate1.payload));
    const gate2 = runJsonScript(gateArtifactScript, [
      "--gate", "gate-2",
      "--plan", generatedPlanPath,
      "--batch-id", batchId,
      "--operation-digest", operationDigest,
      "--out", gate2Path,
    ]);
    assert.equal(gate2.status, 0, JSON.stringify(gate2.payload));
    const publishArgs = [
      "--plan", generatedPlanPath,
      "--expected-plan-sha256", generated.payload.planFileSha256,
      "--expected-baseline-sha256", generatedPlan.expectedSourceSha256,
      "--expected-candidate-sha256", activeAudited.payload.candidateSha256,
      "--expected-batch-id", batchId,
      "--expected-operation-digest", operationDigest,
      "--gate-1-artifact", gate1Path,
      "--expected-gate-1-binding-digest", gate1.payload.bindingDigest,
      "--gate-2-artifact", gate2Path,
      "--expected-gate-2-binding-digest", gate2.payload.bindingDigest,
    ];
    const forgedPreviewIndexPath = path.join(stagingRoot, "forged-preview-index.json");
    const forgedPreviewIndexDocument = {
      version: 2,
      kind: "ledger-reorder-preview-index",
      planFileSha256: generated.payload.planFileSha256,
      candidatePath: generatedPlan.activeCandidatePath,
      candidateSha256: activeAudited.payload.candidateSha256,
      files: [{
        path: previewPath,
        sha256: await sha256File(previewPath),
        sheetName: generatedPlan.sheetName,
        range: generatedPlan.physicalRange,
      }],
    };
    await writePlan(forgedPreviewIndexPath, forgedPreviewIndexDocument);
    const forgedGate1 = JSON.parse(await fs.readFile(gate1Path, "utf8"));
    forgedGate1.digestPayload.previewIndex = {
      path: forgedPreviewIndexPath,
      sha256: await sha256File(forgedPreviewIndexPath),
      planFileSha256: forgedPreviewIndexDocument.planFileSha256,
      candidatePath: forgedPreviewIndexDocument.candidatePath,
      candidateSha256: forgedPreviewIndexDocument.candidateSha256,
      files: forgedPreviewIndexDocument.files,
    };
    forgedGate1.context.reviewPackageDigest = canonicalDigest(forgedGate1.digestPayload);
    const forgedBinding = buildGateBinding(forgedGate1.context);
    forgedGate1.context = forgedBinding.context;
    forgedGate1.bindingDigest = forgedBinding.bindingDigest;
    const forgedGate1Path = path.join(stagingRoot, "forged-gate-1-artifact.json");
    await writePlan(forgedGate1Path, forgedGate1);
    const forgedPublishArgs = [...publishArgs];
    forgedPublishArgs[forgedPublishArgs.indexOf("--gate-1-artifact") + 1] = forgedGate1Path;
    forgedPublishArgs[forgedPublishArgs.indexOf("--expected-gate-1-binding-digest") + 1] =
      forgedBinding.bindingDigest;
    const rejectedForgedPreview = runJsonScript(publishScript, forgedPublishArgs);
    assert.equal(rejectedForgedPreview.status, 1);
    assert.match(rejectedForgedPreview.payload.error, /fresh controlled rerender|does not match.*rerender/i);
    await assert.rejects(fs.access(generatedPlan.targetPath));

    const rejectedArgs = [...publishArgs];
    rejectedArgs[rejectedArgs.indexOf("--expected-gate-1-binding-digest") + 1] = "f".repeat(64);
    const rejectedGate = runJsonScript(publishScript, rejectedArgs);
    assert.equal(rejectedGate.status, 1);
    assert.match(rejectedGate.payload.error, /approval-bound gate-1 digest/i);
    await assert.rejects(fs.access(generatedPlan.targetPath));
    const published = runJsonScript(publishScript, publishArgs);
    assert.equal(published.status, 0, JSON.stringify(published.payload));
    assert.equal(published.payload.status, "created");
    assert.equal(published.payload.planFileSha256, generated.payload.planFileSha256);
    assert.equal(published.payload.gate1BindingDigest, gate1.payload.bindingDigest);
    assert.equal(published.payload.gate2BindingDigest, gate2.payload.bindingDigest);
    assert.deepEqual(
      await fs.readFile(generatedPlan.targetPath),
      await fs.readFile(generatedPlan.activeCandidatePath),
    );
    const repeated = runJsonScript(publishScript, publishArgs);
    assert.equal(repeated.status, 0, JSON.stringify(repeated.payload));
    assert.equal(repeated.payload.status, "already_current");
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
});
