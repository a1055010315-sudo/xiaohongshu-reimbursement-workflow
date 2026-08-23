import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBundledDependency } from "../scripts/workflow_primitives.mjs";
import {
  DEFAULT_OOXML_FACT_BUDGETS,
  readWorkbookOoxmlFacts,
} from "../scripts/workbook_ooxml_facts.mjs";
import {
  readStableFileSnapshot,
  snapshotMetrics,
} from "../scripts/workbook_snapshot.mjs";

const loadedJSZip = loadBundledDependency("jszip");
const JSZip = loadedJSZip.default ?? loadedJSZip;

const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_DOCUMENT_REL = `${DOCUMENT_REL_NS}/officeDocument`;
const SHARED_STRINGS_REL = `${DOCUMENT_REL_NS}/sharedStrings`;
const STYLES_REL = `${DOCUMENT_REL_NS}/styles`;
const WORKSHEET_REL = `${DOCUMENT_REL_NS}/worksheet`;

let tempRoot;

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-ooxml-facts-"));
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function relationships(items) {
  return xml(`<Relationships xmlns="${PACKAGE_REL_NS}">${items.map((item) => (
    `<Relationship Id="${item.id}" Type="${item.type}" Target="${item.target}"${
      item.targetMode ? ` TargetMode="${item.targetMode}"` : ""
    }/>`
  )).join("")}</Relationships>`);
}

function worksheetOne({ extension = true, formula = "SUM(C2:C3)", formulaAttributes = "" } = {}) {
  return xml(
    `<worksheet xmlns="${MAIN_NS}" xmlns:ext="urn:codex:benign-extension">`
      + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
      + '<dimension ref="A1:G3"/>'
      + '<sheetViews><sheetView workbookViewId="0" showGridLines="0">'
      + '<pane ySplit="1.0" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      + '</sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15.00" defaultColWidth="8.43" baseColWidth="10" zeroHeight="0"/>'
      + '<cols>'
      + '<col min="1" max="1" width="17.3750" style="0" hidden="0" customWidth="1"/>'
      + '<col min="2" max="6" width="26.625" hidden="0" customWidth="1"/>'
      + '</cols>'
      + '<sheetData>'
      + '<row r="1" ht="30.50" customHeight="1">'
      + '<c r="A1" s="0" t="inlineStr"><is><r><t>Head</t></r><r><t>er</t></r></is></c>'
      + '<c r="B1" s="0" t="s"><v>0</v></c>'
      + '<c r="C1" s="1" t="n"><v>001.2300</v></c>'
      + `<c r="D1" s="1" t="n"><f${formulaAttributes}>${formula}</f><v>3.50</v></c>`
      + '<c r="G1" s="0" t="str"><v>outside-controlled-range</v></c>'
      + '</row>'
      + '<row r="2" ht="22" customHeight="1">'
      + '<c r="A2" s="0" t="b"><v>1</v></c>'
      + '<c r="B2" s="0" t="e"><v>#N/A</v></c>'
      + '<c r="C2" s="1" t="n"><v>2.27</v></c>'
      + '<c r="D2" s="1" t="n"><f>SUM(C2:C3)</f></c>'
      + '</row>'
      + '<row r="3"><c r="C3" s="1" t="n"><v>1.23E+0</v></c></row>'
      + '</sheetData>'
      + '<mergeCells count="2"><mergeCell ref="E1:E2"/><mergeCell ref="F1:F2"/></mergeCells>'
      + '<printOptions horizontalCentered="1" headings="0" gridLines="0"/>'
      + '<pageMargins left="0.30" right="0.30" top="0.30" bottom="0.30" header="0.15" footer="0.15"/>'
      + '<pageSetup paperSize="9" orientation="landscape" scale="85.0" fitToWidth="1" fitToHeight="0"/>'
      + '<headerFooter differentOddEven="0"><oddFooter>&amp;P / &amp;N</oddFooter></headerFooter>'
      + (extension ? '<extLst><ext:opaque ext:flag="bounded"><ext:child/></ext:opaque></extLst>' : "")
      + '</worksheet>',
  );
}

function worksheetTwo() {
  return xml(
    `<worksheet xmlns="${MAIN_NS}">`
      + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<sheetData><row r="1"><c r="A1" t="str"><v>unmanaged-value</v></c></row></sheetData>'
      + '</worksheet>',
  );
}

function workbookParts(overrides = {}) {
  const workbookPr = overrides.workbookPr ?? "";
  const workbook = overrides.workbook ?? xml(
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${DOCUMENT_REL_NS}">`
      + workbookPr
      + '<sheets>'
      + '<sheet name="Managed" sheetId="1" r:id="rSheet1"/>'
      + '<sheet name="Unmanaged" sheetId="2" state="hidden" r:id="rSheet2"/>'
      + '</sheets>'
      + '<definedNames>'
      + '<definedName name="_xlnm.Print_Area" localSheetId="0">Managed!$A$1:$G$3</definedName>'
      + '<definedName name="_xlnm.Print_Titles" localSheetId="0" hidden="0">Managed!$1:$1</definedName>'
      + '</definedNames>'
      + '</workbook>',
  );
  const rootRelationships = overrides.rootRelationships ?? relationships([
    { id: "rWorkbook", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml" },
  ]);
  const workbookRelationships = overrides.workbookRelationships ?? relationships([
    { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
    { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
    { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
    { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
    { id: "rExternal", type: `${DOCUMENT_REL_NS}/hyperlink`, target: "https://example.invalid/", targetMode: "External" },
  ]);
  const styles = overrides.styles ?? xml(
    `<styleSheet xmlns="${MAIN_NS}">`
      + '<numFmts count="2"><numFmt numFmtId="200" formatCode="mm-dd"/><numFmt numFmtId="201" formatCode="0.000"/></numFmts>'
      + '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="201"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles>'
      + '</styleSheet>',
  );
  const sharedStrings = overrides.sharedStrings ?? xml(
    `<sst xmlns="${MAIN_NS}" count="2" uniqueCount="2">`
      + '<si><t>shared-one</t></si><si><r><t>shared</t></r><r><t>-two</t></r></si>'
      + '</sst>',
  );
  const parts = {
    "[Content_Types].xml": overrides.contentTypes ?? xml(
      `<Types xmlns="${CONTENT_TYPES_NS}">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        + '</Types>',
    ),
    "_rels/.rels": rootRelationships,
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": workbookRelationships,
    "xl/styles.xml": styles,
    "xl/sharedStrings.xml": sharedStrings,
    "xl/worksheets/sheet1.xml": overrides.sheet1 ?? worksheetOne(overrides.sheet1Options),
    "xl/worksheets/sheet2.xml": overrides.sheet2 ?? worksheetTwo(),
  };
  for (const name of overrides.removeParts ?? []) delete parts[name];
  return { ...parts, ...(overrides.extraParts ?? {}) };
}

async function writeWorkbook(name, overrides = {}, zipOptions = {}) {
  const zip = new JSZip();
  for (const [partName, bytes] of Object.entries(workbookParts(overrides))) {
    zip.file(partName, bytes, { createFolders: false });
  }
  const output = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
    ...zipOptions,
  });
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, output, { flag: "wx" });
  return { filePath, output };
}

async function readFacts(name, overrides = {}, options) {
  const { filePath } = await writeWorkbook(name, overrides);
  const stable = await readStableFileSnapshot(filePath, options?.snapshotOptions);
  const facts = await readWorkbookOoxmlFacts(stable, options?.factsOptions);
  return { facts, filePath, stable };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value instanceof Map, false);
  assert.equal(value instanceof Set, false);
  assert.equal(Buffer.isBuffer(value), false);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("actual OOXML facts are source-bound, typed, complete, and deeply immutable", async () => {
  const { facts, stable } = await readFacts("actual-facts.xlsx");
  assert.equal(facts.kind, "workbook-ooxml-facts-v1");
  assert.deepEqual(facts.source, { size: stable.size, sha256: stable.sha256 });
  assert.deepEqual(facts.package.nonStructuralPartNames, []);
  assert.equal(facts.workbook.date1904, false);
  assert.deepEqual(facts.workbook.opaqueControlledPaths, []);
  assert.deepEqual(facts.workbook.sheets.map((sheet) => [sheet.name, sheet.state, sheet.partName]), [
    ["Managed", "visible", "xl/worksheets/sheet1.xml"],
    ["Unmanaged", "hidden", "xl/worksheets/sheet2.xml"],
  ]);
  assert.equal(facts.package.relationships.find((item) => item.id === "rExternal").resolvedPartName, null);
  assert.equal(facts.styles.customNumberFormats[1].formatCode, "0.000");
  assert.deepEqual(facts.sharedStrings.items.map((item) => item.text), ["shared-one", "shared-two"]);

  const managed = facts.worksheets[0];
  assert.deepEqual(managed.opaqueControlledPaths, ["worksheet/extLst"]);
  assert.equal(managed.sheetFormat.defaultRowHeight, "15.00");
  assert.equal(managed.columns[0].width, "17.3750");
  assert.equal(managed.rows[0].height, "30.50");
  assert.equal(managed.views[0].pane.ySplit, "1.0");
  assert.equal(managed.print.pageMargins.left, "0.30");
  assert.equal(managed.print.pageSetup.scale, "85.0");
  assert.equal(managed.rows[0].cells.find((cell) => cell.ref === "C1").value.raw, "001.2300");
  assert.equal(managed.rows[0].cells.find((cell) => cell.ref === "D1").formula.text, "SUM(C2:C3)");
  assert.equal(managed.rows[0].cells.find((cell) => cell.ref === "D1").cachedValue, "3.50");
  assert.equal(managed.rows[1].cells.find((cell) => cell.ref === "D2").cachedValue, null);
  assert.equal(managed.rows[0].cells.find((cell) => cell.ref === "G1").value.text, "outside-controlled-range");
  assert.equal(facts.worksheets[1].rows[0].cells[0].value.text, "unmanaged-value");
  assert.match(facts.factsDigest, /^[0-9a-f]{64}$/u);
  assert.ok(facts.package.structuralParts.every((part) => /^[0-9a-f]{64}$/u.test(part.sha256)));
  assertDeepFrozen(facts);
  assert.equal(snapshotMetrics(stable).readCount, 2);
  assert.equal(snapshotMetrics(stable).structuralDecompressCount, facts.package.structuralParts.length);
});

test("package metadata is excluded when the workbook uses the default XML content type", async () => {
  const contentTypes = xml(
    `<Types xmlns="${CONTENT_TYPES_NS}">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>',
  );
  const { facts } = await readFacts("default-xml-workbook-content-type.xlsx", { contentTypes });
  assert.equal(facts.package.workbookPartName, "xl/workbook.xml");
});

test("date1904 is explicit, source-bound, and rejects duplicate or invalid declarations", async (context) => {
  for (const [value, expected] of [["0", false], ["false", false], ["1", true], ["true", true]]) {
    await context.test(value, async () => {
      const { facts } = await readFacts(`date1904-${value}.xlsx`, {
        workbookPr: `<workbookPr date1904="${value}"/>`,
      });
      assert.equal(facts.workbook.date1904, expected);
    });
  }
  const invalidCases = [
    { name: "invalid", workbookPr: '<workbookPr date1904="yes"/>', error: /date1904/iu },
    { name: "duplicate-workbook-pr", workbookPr: '<workbookPr date1904="0"/><workbookPr date1904="1"/>', error: /workbookPr|date1904/iu },
    { name: "duplicate-attribute", workbookPr: '<workbookPr date1904="0" date1904="1"/>', error: /malformed|duplicate|date1904/iu },
  ];
  for (const item of invalidCases) {
    await context.test(item.name, async () => {
      await assert.rejects(() => readFacts(`date1904-${item.name}.xlsx`, { workbookPr: item.workbookPr }), item.error);
    });
  }
});

test("core OPC identities and relationship targets fail closed", async (context) => {
  const cases = [
    {
      name: "duplicate-office-document",
      overrides: { rootRelationships: relationships([
        { id: "r1", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml" },
        { id: "r2", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml" },
      ]) },
      error: /officeDocument.*unique|exactly one/iu,
    },
    {
      name: "external-workbook",
      overrides: { rootRelationships: relationships([
        { id: "r1", type: OFFICE_DOCUMENT_REL, target: "https://example.invalid/book", targetMode: "External" },
      ]) },
      error: /officeDocument.*internal|external/iu,
    },
    {
      name: "query-target",
      overrides: { rootRelationships: relationships([
        { id: "r1", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml?x=1" },
      ]) },
      error: /query|target/iu,
    },
    {
      name: "fragment-target",
      overrides: { rootRelationships: relationships([
        { id: "r1", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml#x" },
      ]) },
      error: /fragment|target/iu,
    },
    {
      name: "double-percent-target",
      overrides: { rootRelationships: relationships([
        { id: "r1", type: OFFICE_DOCUMENT_REL, target: "/xl/%252e%252e/workbook.xml" },
      ]) },
      error: /percent|target|escape/iu,
    },
    {
      name: "duplicate-relationship-id",
      overrides: { workbookRelationships: relationships([
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
      ]) },
      error: /duplicate.*relationship.*Id/iu,
    },
    {
      name: "shared-sheet-part",
      overrides: { workbookRelationships: relationships([
        { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
        { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
      ]) },
      error: /worksheet part.*multiple|unique/iu,
    },
    {
      name: "unconsumed-internal-worksheet-relationship",
      overrides: { workbookRelationships: relationships([
        { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
        { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
        { id: "rUnused", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
      ]) },
      error: /worksheet relationship|orphan|unconsumed/iu,
    },
    {
      name: "unconsumed-external-worksheet-relationship",
      overrides: { workbookRelationships: relationships([
        { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
        { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
        { id: "rUnused", type: WORKSHEET_REL, target: "https://example.invalid/sheet", targetMode: "External" },
      ]) },
      error: /worksheet relationship|orphan|unconsumed/iu,
    },
    {
      name: "orphan-worksheet",
      overrides: { extraParts: { "xl/worksheets/orphan.xml": worksheetTwo() } },
      error: /orphan.*worksheet/iu,
    },
    {
      name: "orphan-styles",
      overrides: { workbookRelationships: relationships([
        { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
      ]) },
      error: /orphan.*styles/iu,
    },
    {
      name: "orphan-canonical-styles-with-generic-content-type",
      overrides: {
        contentTypes: workbookParts()["[Content_Types].xml"].replace(
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
          "",
        ),
        sheet1: worksheetTwo(),
        workbookRelationships: relationships([
          { id: "rStrings", type: SHARED_STRINGS_REL, target: "sharedStrings.xml" },
          { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
          { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
        ]),
      },
      error: /orphan.*styles/iu,
    },
    {
      name: "orphan-shared-strings",
      overrides: { workbookRelationships: relationships([
        { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
        { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
        { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
      ]) },
      error: /shared strings|sharedStrings|orphan/iu,
    },
    {
      name: "orphan-canonical-shared-strings-with-generic-content-type",
      overrides: {
        contentTypes: workbookParts()["[Content_Types].xml"].replace(
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
          "",
        ),
        sheet1: worksheetTwo(),
        workbookRelationships: relationships([
          { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
          { id: "rSheet1", type: WORKSHEET_REL, target: "worksheets/sheet1.xml" },
          { id: "rSheet2", type: WORKSHEET_REL, target: "worksheets/sheet2.xml" },
        ]),
      },
      error: /shared strings|sharedStrings|orphan/iu,
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      await assert.rejects(() => readFacts(`opc-${item.name}.xlsx`, item.overrides), item.error);
    });
  }
});

test("worksheet ordering, coordinates, ranges, and formula modes are fail-closed", async (context) => {
  const mutations = [
    {
      name: "descending-rows",
      sheet: worksheetOne().replace('<row r="2"', '<row r="4"'),
      error: /row.*order|row.*index/iu,
    },
    {
      name: "descending-cells",
      sheet: worksheetOne().replace('<c r="A1"', '<c r="Z1"'),
      error: /cell.*order|coordinate/iu,
    },
    {
      name: "duplicate-cell",
      sheet: worksheetOne().replace('</row><row r="2"', '<c r="G1" t="str"><v>duplicate</v></c></row><row r="2"'),
      error: /duplicate.*cell|cell.*order/iu,
    },
    {
      name: "overlapping-columns",
      sheet: worksheetOne().replace('min="2" max="6"', 'min="1" max="6"'),
      error: /column.*overlap|column.*order/iu,
    },
    {
      name: "overlapping-merges",
      sheet: worksheetOne().replace('ref="F1:F2"', 'ref="E2:F2"'),
      error: /overlap.*merge|merge.*overlap|merge.*order/iu,
    },
    {
      name: "descending-merge-endpoints",
      sheet: worksheetOne().replace('ref="E1:E2"', 'ref="E2:E1"'),
      error: /descending.*range|range.*endpoint/iu,
    },
    {
      name: "shared-formula",
      sheet: worksheetOne({ formulaAttributes: ' t="shared" si="0" ref="D1:D2"' }),
      error: /shared formula|unsupported formula/iu,
    },
    {
      name: "array-formula",
      sheet: worksheetOne({ formulaAttributes: ' t="array" ref="D1:D2"' }),
      error: /array formula|unsupported formula/iu,
    },
    {
      name: "data-table-formula",
      sheet: worksheetOne({ formulaAttributes: ' t="dataTable" ref="D1:D2"' }),
      error: /dataTable formula|unsupported formula/iu,
    },
    {
      name: "duplicate-value",
      sheet: worksheetOne().replace('<v>001.2300</v>', '<v>001.2300</v><v>9</v>'),
      error: /duplicate.*v|exactly one.*value/iu,
    },
  ];
  for (const item of mutations) {
    await context.test(item.name, async () => {
      await assert.rejects(() => readFacts(`worksheet-${item.name}.xlsx`, { sheet1: item.sheet }), item.error);
    });
  }
});

test("merge facts retain their actual non-overlapping OOXML order", async () => {
  const reversed = worksheetOne().replace(
    '<mergeCells count="2"><mergeCell ref="E1:E2"/><mergeCell ref="F1:F2"/></mergeCells>',
    '<mergeCells count="2"><mergeCell ref="F1:F2"/><mergeCell ref="E1:E2"/></mergeCells>',
  );
  const { facts } = await readFacts("merge-source-order.xlsx", { sheet1: reversed });
  assert.deepEqual(facts.worksheets[0].merges.map((merge) => merge.ref), ["F1:F2", "E1:E2"]);
});

test("rich text digests bind run formatting for shared and inline strings", async () => {
  function formattedSharedString(properties) {
    return xml(
      `<sst xmlns="${MAIN_NS}" count="2" uniqueCount="2">`
        + `<si><r><rPr>${properties}</rPr><t>same-text</t></r></si>`
        + '<si><t>shared-two</t></si>'
        + '</sst>',
    );
  }
  const richVariants = {
    base: '<rFont val="Aptos"/><sz val="11"/><color rgb="FFFF0000"/><b/><i val="0"/><u val="single"/>',
    font: '<rFont val="Arial"/><sz val="11"/><color rgb="FFFF0000"/><b/><i val="0"/><u val="single"/>',
    size: '<rFont val="Aptos"/><sz val="12"/><color rgb="FFFF0000"/><b/><i val="0"/><u val="single"/>',
    color: '<rFont val="Aptos"/><sz val="11"/><color rgb="FF0000FF"/><b/><i val="0"/><u val="single"/>',
    bold: '<rFont val="Aptos"/><sz val="11"/><color rgb="FFFF0000"/><b val="0"/><i val="0"/><u val="single"/>',
    italic: '<rFont val="Aptos"/><sz val="11"/><color rgb="FFFF0000"/><b/><i val="1"/><u val="single"/>',
    underline: '<rFont val="Aptos"/><sz val="11"/><color rgb="FFFF0000"/><b/><i val="0"/><u val="double"/>',
  };
  const sharedResults = [];
  for (const [name, properties] of Object.entries(richVariants)) {
    sharedResults.push(await readFacts(`shared-rich-${name}.xlsx`, {
      sharedStrings: formattedSharedString(properties),
    }));
  }
  assert.ok(sharedResults.every((result) => result.facts.sharedStrings.items[0].text === "same-text"));
  assert.equal(
    new Set(sharedResults.map((result) => result.facts.sharedStrings.items[0].richTextDigest)).size,
    sharedResults.length,
  );

  function formattedInlineString(color) {
    return worksheetOne().replace(
      '<r><t>Head</t></r>',
      `<r><rPr><color rgb="${color}"/></rPr><t>Head</t></r>`,
    );
  }
  const redInline = await readFacts("inline-rich-red.xlsx", { sheet1: formattedInlineString("FFFF0000") });
  const blueInline = await readFacts("inline-rich-blue.xlsx", { sheet1: formattedInlineString("FF0000FF") });
  const redValue = redInline.facts.worksheets[0].rows[0].cells[0].value;
  const blueValue = blueInline.facts.worksheets[0].rows[0].cells[0].value;
  assert.equal(redValue.text, blueValue.text);
  assert.notEqual(redValue.richTextDigest, blueValue.richTextDigest);
});

test("benign extensions are byte-bound while unknown controlled semantics are rejected", async () => {
  const { facts } = await readFacts("benign-extension.xlsx");
  assert.equal(facts.worksheets[0].rows.length, 3);
  assert.deepEqual(facts.worksheets[0].opaqueControlledPaths, ["worksheet/extLst"]);
  const noOpaque = await readFacts("no-opaque-extension.xlsx", {
    sheet1Options: { extension: false },
  });
  assert.deepEqual(noOpaque.facts.worksheets[0].opaqueControlledPaths, []);
  const controlledOpaque = await readFacts("controlled-opaque.xlsx", {
    sheet1: worksheetOne({ extension: false }).replace(
      "<sheetData>",
      '<sheetProtection sheet="1"/><sheetData>',
    ),
  });
  assert.deepEqual(controlledOpaque.facts.worksheets[0].opaqueControlledPaths, [
    "worksheet/sheetProtection",
  ]);
  const workbookOpaque = await readFacts("workbook-opaque.xlsx", {
    workbook: xml(
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${DOCUMENT_REL_NS}">`
        + '<sheets><sheet name="Managed" sheetId="1" r:id="rSheet1"/>'
        + '<sheet name="Unmanaged" sheetId="2" state="hidden" r:id="rSheet2"/></sheets>'
        + '<calcPr calcId="1"/>'
        + '</workbook>',
    ),
  });
  assert.deepEqual(workbookOpaque.facts.workbook.opaqueControlledPaths, ["workbook/calcPr"]);
  const nonStructural = await readFacts("non-structural-part.xlsx", {
    extraParts: { "xl/media/image1.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  });
  assert.deepEqual(nonStructural.facts.package.nonStructuralPartNames, ["xl/media/image1.png"]);
  assert.equal(
    snapshotMetrics(nonStructural.stable).structuralDecompressCount,
    nonStructural.facts.package.structuralParts.length,
  );
  await assert.rejects(
    () => readFacts("unknown-main-child.xlsx", {
      sheet1: worksheetOne().replace(
        '<sheetData>',
        `<sheetData><unknownControlled xmlns="${MAIN_NS}"/>`,
      ),
    }),
    /unknown.*controlled|unsupported.*unknownControlled/iu,
  );
  await assert.rejects(
    () => readFacts("doctype.xlsx", {
      sheet1: worksheetOne().replace("?>", '?><!DOCTYPE worksheet [<!ENTITY xxe "unsafe">]>'),
    }),
    /DOCTYPE|entity/iu,
  );
});

test("accepted managed worksheet attributes are projected or explicitly opaque", async () => {
  const sheetProperty = await readFacts("sheet-property-attribute.xlsx", {
    sheet1: worksheetOne({ extension: false }).replace(
      "<sheetPr>",
      '<sheetPr codeName="ManagedCode">',
    ),
  });
  assert.deepEqual(sheetProperty.facts.worksheets[0].opaqueControlledPaths, [
    "worksheet/sheetPr@codeName",
  ]);

  const rowSpans = await readFacts("row-spans-attribute.xlsx", {
    sheet1: worksheetOne({ extension: false }).replace(
      '<row r="1" ht="30.50" customHeight="1">',
      '<row r="1" spans="1:7" ht="30.50" customHeight="1">',
    ),
  });
  assert.equal(rowSpans.facts.worksheets[0].rows[0].spans, "1:7");

  const activeCellId = await readFacts("selection-active-cell-id.xlsx", {
    sheet1: worksheetOne({ extension: false }).replace(
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>',
      '<selection pane="bottomLeft" activeCell="A2" activeCellId="7" sqref="A2"/>',
    ),
  });
  assert.equal(activeCellId.facts.worksheets[0].views[0].selections[0].activeCellId, 7);
});

test("raw-SHA-exempt workbook and worksheet nodes reject unbound attributes", async () => {
  const defaultWorkbook = workbookParts()["xl/workbook.xml"];
  const cases = [
    {
      name: "workbook-root",
      overrides: {
        workbook: defaultWorkbook.replace(
          `<workbook xmlns="${MAIN_NS}"`,
          `<workbook unexpected="1" xmlns="${MAIN_NS}"`,
        ),
      },
    },
    {
      name: "workbook-sheets-container",
      overrides: { workbook: defaultWorkbook.replace("<sheets>", '<sheets unexpected="1">') },
    },
    {
      name: "workbook-defined-names-container",
      overrides: { workbook: defaultWorkbook.replace("<definedNames>", '<definedNames unexpected="1">') },
    },
    {
      name: "worksheet-root",
      overrides: {
        sheet1: worksheetOne({ extension: false }).replace(
          `<worksheet xmlns="${MAIN_NS}"`,
          `<worksheet unexpected="1" xmlns="${MAIN_NS}"`,
        ),
      },
    },
    {
      name: "worksheet-sheet-views-container",
      overrides: {
        sheet1: worksheetOne({ extension: false }).replace(
          "<sheetViews>",
          '<sheetViews unexpected="1">',
        ),
      },
    },
    {
      name: "worksheet-merge-container",
      overrides: {
        sheet1: worksheetOne({ extension: false }).replace(
          '<mergeCells count="2">',
          '<mergeCells count="2" unexpected="1">',
        ),
      },
    },
    {
      name: "worksheet-page-setup-unqualified-id",
      overrides: {
        sheet1: worksheetOne({ extension: false }).replace(
          '<pageSetup paperSize="9"',
          '<pageSetup id="not-a-relationship" paperSize="9"',
        ),
      },
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => readFacts(`${item.name}.xlsx`, item.overrides),
      /unknown controlled attribute|unsupported.*attribute/iu,
      item.name,
    );
  }
});

test("fact budgets reject before unbounded OOXML fact allocation", async (context) => {
  const limits = {
    xmlElementsPerPart: 1,
    xmlDepth: 1,
    xmlAttributesPerElement: 1,
    xmlAttributeValueChars: 1,
    xmlTextCharsPerNode: 1,
    totalXmlTextChars: 1,
    sheetCount: 1,
    relationshipCount: 1,
    definedNameCount: 1,
    customNumberFormatCount: 1,
    cellFormatCount: 1,
    sharedStringCount: 1,
    sharedStringItemChars: 1,
    sharedStringTotalChars: 1,
    rowsPerSheet: 2,
    totalRows: 3,
    cellsPerSheet: 8,
    totalCells: 9,
    mergesPerSheet: 1,
    totalMerges: 1,
    columnRangesPerSheet: 1,
    totalColumnRanges: 1,
  };
  assert.deepEqual(Object.keys(DEFAULT_OOXML_FACT_BUDGETS).sort(), Object.keys(limits).sort());
  for (const [budget, limit] of Object.entries(limits)) {
    await context.test(budget, async () => {
      const { filePath } = await writeWorkbook(`budget-${budget}.xlsx`);
      const stable = await readStableFileSnapshot(filePath);
      await assert.rejects(
        () => readWorkbookOoxmlFacts(stable, { factBudgets: { [budget]: limit } }),
        new RegExp(budget, "iu"),
      );
    });
  }
  const { filePath } = await writeWorkbook("budget-unknown.xlsx");
  const stable = await readStableFileSnapshot(filePath);
  await assert.rejects(
    () => readWorkbookOoxmlFacts(stable, { factBudgets: { unknownBudget: 1 } }),
    /unknownBudget|unknown field/iu,
  );
});

test("fresh current-check rejects same-size changes and leaves the file handle closed", async () => {
  const { filePath, output } = await writeWorkbook("changed-after-stable.xlsx");
  const stable = await readStableFileSnapshot(filePath);
  const changed = Buffer.from(output);
  changed[changed.length - 1] ^= 1;
  await fs.writeFile(filePath, changed);
  await assert.rejects(
    () => readWorkbookOoxmlFacts(stable),
    /changed|SHA-256|identity|ZIP/iu,
  );
  const renamed = `${filePath}.renamed`;
  await fs.rename(filePath, renamed);
  await fs.rename(renamed, filePath);
});
