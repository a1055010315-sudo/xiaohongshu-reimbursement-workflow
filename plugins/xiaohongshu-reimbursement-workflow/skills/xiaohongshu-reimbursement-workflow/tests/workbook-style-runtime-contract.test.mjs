import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadBundledDependency } from "../scripts/workflow_primitives.mjs";
import {
  assertTemplateCodeRoleCoverage,
  auditOpenedWorkbookStyleContract,
  validateWorkbookStyleContract,
} from "../scripts/workbook_style_contract.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(skillRoot, "assets", "templates", "xiaohongshu");
const contractPath = path.join(skillRoot, "references", "workbook-style-contract.json");

async function loadFixture(templateId) {
  const [contractText, manifestText] = await Promise.all([
    fs.readFile(contractPath, "utf8"),
    fs.readFile(path.join(templateRoot, "template-manifest.json"), "utf8"),
  ]);
  const contract = validateWorkbookStyleContract(JSON.parse(contractText));
  const manifest = JSON.parse(manifestText);
  const definition = manifest.templates[templateId];
  const bytes = await fs.readFile(path.join(templateRoot, definition.file));
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const part = async (name, required = true) => {
    const entry = zip.file(name);
    if (!entry && required) throw new Error(`${templateId} fixture is missing ${name}`);
    return entry ? entry.async("string") : null;
  };
  return {
    contract,
    manifest,
    definition,
    parts: {
      stylesXml: await part("xl/styles.xml"),
      themeXml: await part("xl/theme/theme1.xml", false),
      worksheetXml: await part("xl/worksheets/sheet1.xml"),
      workbookXml: await part("xl/workbook.xml"),
    },
  };
}

function audit(fixture, replacements = {}, options = {}) {
  return auditOpenedWorkbookStyleContract({
    contract: fixture.contract,
    templateId: options.templateId ?? "current-detail",
    templateDefinition: options.definition ?? fixture.definition,
    styleRoles: options.styleRoles ?? fixture.definition.styleRoles,
    parts: { ...fixture.parts, ...replacements },
    throwOnMismatch: options.throwOnMismatch ?? false,
  });
}

test("runtime style audit consumes only already-opened OOXML and records zero added I/O, decode, COM, or ZIP work", async () => {
  const fixture = await loadFixture("current-detail");
  const result = audit(fixture);
  assert.equal(result.ok, true);
  assert.match(result.binding.bindingDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual({
    checks: result.metrics.styleContractChecks,
    inflatedParts: result.metrics.stylePartsInflated,
    inflatedBytes: result.metrics.styleBytesInflated,
    mismatches: result.metrics.styleMismatchCount,
    fileReads: result.metrics.addedFileReads,
    imageDecodes: result.metrics.addedImageDecodes,
    comCalls: result.metrics.addedComCalls,
    zipOpens: result.metrics.addedZipOpens,
  }, {
    checks: 1,
    inflatedParts: 0,
    inflatedBytes: 0,
    mismatches: 0,
    fileReads: 0,
    imageDecodes: 0,
    comCalls: 0,
    zipOpens: 0,
  });
  assert.ok(result.metrics.styleCheckMs >= 0);

  const source = await fs.readFile(path.join(skillRoot, "scripts", "workbook_style_contract.mjs"), "utf8");
  for (const forbidden of ["node:fs", "jszip", "loadBundledDependency", "child_process", "Excel.Application", "readFile(", "loadAsync("]) {
    assert.equal(source.includes(forbidden), false, `runtime style module imported ${forbidden}`);
  }
  assert.throws(() => auditOpenedWorkbookStyleContract({
    contract: fixture.contract,
    templateId: "current-detail",
    templateDefinition: fixture.definition,
    styleRoles: fixture.definition.styleRoles,
    parts: { ...fixture.parts, path: "synthetic.xlsx" },
  }), /already-opened OOXML|unsupported field/iu);
});

test("style, column, key-cell, view, and merge mutations are independently detected", async (context) => {
  const fixture = await loadFixture("current-detail");
  const cases = [
    {
      name: "semantic-fill",
      replacements: { stylesXml: fixture.parts.stylesXml.replace('rgb="FF567D27"', 'rgb="FF567D28"') },
      field: /roles\.title/iu,
    },
    {
      name: "column-width",
      replacements: { worksheetXml: fixture.parts.worksheetXml.replace('width="13"', 'width="13.25"') },
      field: /layout\.columns/iu,
    },
    {
      name: "key-cell-role",
      replacements: { worksheetXml: fixture.parts.worksheetXml.replace('<c r="A1" s="1"', '<c r="A1" s="2"') },
      field: /cellStyles\.A1/iu,
    },
    {
      name: "gridlines",
      replacements: { worksheetXml: fixture.parts.worksheetXml.replace('showGridLines="0"', 'showGridLines="1"') },
      field: /showGridLines/iu,
    },
    {
      name: "merge",
      replacements: { worksheetXml: fixture.parts.worksheetXml.replace('<mergeCell ref="A1:F1"/>', '<mergeCell ref="A1:E1"/>') },
      field: /merge\.A1:F1/iu,
    },
  ];
  for (const item of cases) {
    await context.test(item.name, () => {
      const result = audit(fixture, item.replacements);
      assert.equal(result.ok, false);
      assert.ok(result.metrics.styleMismatchCount > 0);
      assert.match(result.mismatches.map((value) => value.field).join("\n"), item.field);
      assert.equal(result.metrics.addedZipOpens, 0);
      assert.equal(result.metrics.addedFileReads, 0);
    });
  }
});

test("theme-resolved colors are mutation-sensitive without preserving theme relationship identifiers", async () => {
  const fixture = await loadFixture("ledger-batch-preview");
  const baseline = audit(fixture, {}, { templateId: "ledger-batch-preview" });
  assert.equal(baseline.ok, true);
  const themeColor = /<a:accent3><a:srgbClr val="([0-9A-F]{6})"\s*\/><\/a:accent3>/u.exec(fixture.parts.themeXml);
  assert.ok(themeColor, "fixture accent3 theme color");
  const changed = themeColor[1] === "000000" ? "000001" : "000000";
  const result = audit(fixture, {
    themeXml: fixture.parts.themeXml.replace(themeColor[0], themeColor[0].replace(themeColor[1], changed)),
  }, { templateId: "ledger-batch-preview" });
  assert.equal(result.ok, false);
  assert.match(result.mismatches.map((value) => value.field).join("\n"), /header(?:Date|Text|Amount)/u);
});

test("code-role coverage fails when a manifest consumer token is mutated", async () => {
  const fixture = await loadFixture("current-detail");
  const [artifactBuilder, rootBuilder] = await Promise.all([
    fs.readFile(path.join(skillRoot, "scripts", "build_reimbursement_artifacts.mjs"), "utf8"),
    fs.readFile(path.join(skillRoot, "scripts", "build_root_workbook_candidate.mjs"), "utf8"),
  ]);
  assert.throws(() => assertTemplateCodeRoleCoverage({
    contract: fixture.contract,
    templateManifest: fixture.manifest,
    sourceTexts: {
      "scripts/build_reimbursement_artifacts.mjs": artifactBuilder,
      "scripts/build_root_workbook_candidate.mjs": rootBuilder.replaceAll("roles.headerDate", "roles.header_Date"),
    },
  }), /headerDate|consumer token/iu);
});
