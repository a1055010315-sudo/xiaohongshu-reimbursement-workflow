import assert from "node:assert/strict";
import test from "node:test";

import { canonicalDigest } from "../scripts/workflow_primitives.mjs";
import { inspectRootWorkbookTransition } from "../scripts/workbook_transition_contract.mjs";

const HASHES = Object.freeze({
  baseline: "1".repeat(64),
  candidate: "2".repeat(64),
  contentTypes: "3".repeat(64),
  rootRelationships: "4".repeat(64),
  candidateRootRelationships: "5".repeat(64),
  coreProperties: "6".repeat(64),
  workbook: "7".repeat(64),
  candidateWorkbook: "8".repeat(64),
  workbookRelationships: "9".repeat(64),
  candidateWorkbookRelationships: "a".repeat(64),
  styles: "b".repeat(64),
  sharedStrings: "c".repeat(64),
  theme: "d".repeat(64),
  managed: "e".repeat(64),
  candidateManaged: "f".repeat(64),
  unmanagedSummary: "0".repeat(64),
  unmanagedNotes: "a1".repeat(32),
});

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sealFacts(body) {
  return deepFreeze({ ...body, factsDigest: canonicalDigest(body) });
}

function mutateFacts(facts, mutate) {
  const body = structuredClone(facts);
  delete body.factsDigest;
  mutate(body);
  return sealFacts(body);
}

function part(name, sha256, uncompressedSize = 100) {
  return { name, uncompressedSize, sha256 };
}

function relationship(sourcePartName, relationshipPartName, id, type, target, resolvedPartName, targetMode = "Internal") {
  return {
    sourcePartName,
    relationshipPartName,
    id,
    type,
    target,
    targetMode,
    resolvedPartName,
  };
}

function cell(ref, styleIndex, value, overrides = {}) {
  const match = /^([A-Z]+)(\d+)$/u.exec(ref);
  assert.ok(match);
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return {
    ref,
    row: Number(match[2]),
    column,
    type: "inlineStr",
    styleIndex,
    numberFormat: { numFmtId: 0, formatCode: "General" },
    cellMetadataIndex: null,
    valueMetadataIndex: null,
    phonetic: null,
    value: { raw: null, text: value, richTextDigest: canonicalDigest([{ kind: "plain", text: value }]) },
    formula: null,
    cachedValue: null,
    ...overrides,
  };
}

function row(index, cells, overrides = {}) {
  return {
    index,
    styleIndex: null,
    customFormat: null,
    height: "22",
    customHeight: true,
    hidden: null,
    outlineLevel: null,
    collapsed: null,
    thickTop: null,
    thickBottom: null,
    phonetic: null,
    cells,
    ...overrides,
  };
}

function worksheet(identity, rows, overrides = {}) {
  return {
    ...identity,
    opaqueControlledPaths: [],
    dimensionRef: "A1:F4",
    sheetFormat: {
      defaultRowHeight: "15",
      defaultColWidth: null,
      baseColWidth: "10",
      customHeight: null,
      zeroHeight: null,
      thickTop: null,
      thickBottom: null,
      outlineLevelRow: null,
      outlineLevelColumn: null,
    },
    columns: [
      { min: 1, max: 1, width: "17.375", styleIndex: null, hidden: null, bestFit: null, customWidth: true, phonetic: null, outlineLevel: null, collapsed: null },
      { min: 2, max: 6, width: "26.625", styleIndex: null, hidden: null, bestFit: null, customWidth: true, phonetic: null, outlineLevel: null, collapsed: null },
    ],
    views: [{
      workbookViewId: 0,
      windowProtection: null,
      showFormulas: null,
      showGridLines: false,
      showRowColHeaders: null,
      showZeros: null,
      rightToLeft: null,
      tabSelected: null,
      showRuler: null,
      showOutlineSymbols: null,
      defaultGridColor: null,
      showWhiteSpace: null,
      view: null,
      topLeftCell: null,
      colorId: null,
      zoomScale: null,
      zoomScaleNormal: null,
      zoomScaleSheetLayoutView: null,
      zoomScalePageLayoutView: null,
      pane: null,
      selections: [],
    }],
    rows,
    merges: [],
    print: {
      printOptions: { horizontalCentered: true, verticalCentered: null, headings: false, gridLines: false, gridLinesSet: null },
      pageMargins: { left: "0.3", right: "0.3", top: "0.3", bottom: "0.3", header: "0.15", footer: "0.15" },
      pageSetup: { paperSize: "9", paperHeight: null, paperWidth: null, scale: "85", firstPageNumber: null, fitToWidth: "1", fitToHeight: "0", pageOrder: null, orientation: "landscape", usePrinterDefaults: null, blackAndWhite: null, draft: null, cellComments: null, useFirstPageNumber: null, errors: null, horizontalDpi: null, verticalDpi: null, copies: null },
      pageSetUpPr: { autoPageBreaks: null, fitToPage: true },
      headerFooter: null,
    },
    ...overrides,
  };
}

function baselineFacts() {
  const workbookPartName = "xl/workbook.xml";
  const workbookRelationshipPart = "xl/_rels/workbook.xml.rels";
  const sheetIdentities = [
    { order: 0, name: "公司支出", sheetId: 1, state: "visible", relationshipId: "rSheet1", partName: "xl/worksheets/sheet1.xml", partSha256: HASHES.managed },
    { order: 1, name: "来源结算摘要", sheetId: 2, state: "visible", relationshipId: "rSheet2", partName: "xl/worksheets/sheet2.xml", partSha256: HASHES.unmanagedSummary },
    { order: 2, name: "核对说明", sheetId: 3, state: "visible", relationshipId: "rSheet3", partName: "xl/worksheets/sheet3.xml", partSha256: HASHES.unmanagedNotes },
  ];
  const body = {
    kind: "workbook-ooxml-facts-v1",
    source: { size: 4_000, sha256: HASHES.baseline },
    package: {
      workbookPartName,
      nonStructuralPartNames: [],
      structuralParts: [
        part("[Content_Types].xml", HASHES.contentTypes),
        part("_rels/.rels", HASHES.rootRelationships),
        part("docProps/core.xml", HASHES.coreProperties),
        part(workbookPartName, HASHES.workbook),
        part(workbookRelationshipPart, HASHES.workbookRelationships),
        part("xl/sharedStrings.xml", HASHES.sharedStrings),
        part("xl/styles.xml", HASHES.styles),
        part("xl/theme/theme1.xml", HASHES.theme),
        part("xl/worksheets/sheet1.xml", HASHES.managed),
        part("xl/worksheets/sheet2.xml", HASHES.unmanagedSummary),
        part("xl/worksheets/sheet3.xml", HASHES.unmanagedNotes),
      ],
      relationships: [
        relationship(null, "_rels/.rels", "rOffice", `${REL_NS}/officeDocument`, "xl/workbook.xml", workbookPartName),
        relationship(null, "_rels/.rels", "rCore", `${PACKAGE_REL_NS}/metadata/core-properties`, "docProps/core.xml", "docProps/core.xml"),
        relationship(null, "_rels/.rels", "rExternal", "urn:codex:external-audit", "https://example.invalid/audit", null, "External"),
        relationship(workbookPartName, workbookRelationshipPart, "rStyles", `${REL_NS}/styles`, "styles.xml", "xl/styles.xml"),
        relationship(workbookPartName, workbookRelationshipPart, "rStrings", `${REL_NS}/sharedStrings`, "sharedStrings.xml", "xl/sharedStrings.xml"),
        relationship(workbookPartName, workbookRelationshipPart, "rTheme", `${REL_NS}/theme`, "theme/theme1.xml", "xl/theme/theme1.xml"),
        relationship(workbookPartName, workbookRelationshipPart, "rSheet1", `${REL_NS}/worksheet`, "worksheets/sheet1.xml", "xl/worksheets/sheet1.xml"),
        relationship(workbookPartName, workbookRelationshipPart, "rSheet2", `${REL_NS}/worksheet`, "worksheets/sheet2.xml", "xl/worksheets/sheet2.xml"),
        relationship(workbookPartName, workbookRelationshipPart, "rSheet3", `${REL_NS}/worksheet`, "worksheets/sheet3.xml", "xl/worksheets/sheet3.xml"),
      ],
    },
    workbook: {
      date1904: false,
      opaqueControlledPaths: [],
      definedNames: [
        { name: "_xlnm.Print_Area", localSheetId: 0, hidden: false, text: "'公司支出'!$A$1:$F$2" },
        { name: "_xlnm.Print_Titles", localSheetId: 0, hidden: false, text: "'公司支出'!$1:$1" },
      ],
      sheets: sheetIdentities,
    },
    styles: {
      partName: "xl/styles.xml",
      partSha256: HASHES.styles,
      customNumberFormats: [],
      cellFormats: [
        { index: 0, numFmtId: 0, formatCode: "General" },
        { index: 1, numFmtId: 0, formatCode: "General" },
        { index: 2, numFmtId: 2, formatCode: "0.00" },
      ],
    },
    sharedStrings: {
      partName: "xl/sharedStrings.xml",
      partSha256: HASHES.sharedStrings,
      count: 0,
      uniqueCount: 0,
      items: [],
    },
    worksheets: [
      worksheet(sheetIdentities[0], [
        row(1, [cell("A1", 1, "日期"), cell("B1", 1, "项目")]),
        row(2, [
          cell("A2", 1, "2026-08-13"),
          cell("B2", 1, "旧项目"),
          cell("C2", 2, "10.00", { type: "n", value: { raw: "10.00", text: null }, numberFormat: { numFmtId: 2, formatCode: "0.00" } }),
          cell("D2", 2, "10.00", { type: "n", value: { raw: "10.00", text: null }, numberFormat: { numFmtId: 2, formatCode: "0.00" } }),
          cell("E2", 1, "甲"),
          cell("F2", 1, "备注"),
        ]),
      ], {
        dimensionRef: "A1:F2",
        merges: [],
      }),
      worksheet(sheetIdentities[1], [row(1, [cell("A1", 1, "summary")])], {
        dimensionRef: "A1:A1",
        merges: [],
      }),
      worksheet(sheetIdentities[2], [row(1, [cell("A1", 1, "notes")])], {
        dimensionRef: "A1:A1",
        merges: [],
      }),
    ],
  };
  return sealFacts(body);
}

function candidateFacts(baseline = baselineFacts()) {
  return mutateFacts(baseline, (body) => {
    body.source = { size: 4_100, sha256: HASHES.candidate };
    const hashes = new Map([
      ["_rels/.rels", HASHES.candidateRootRelationships],
      ["xl/workbook.xml", HASHES.candidateWorkbook],
      ["xl/_rels/workbook.xml.rels", HASHES.candidateWorkbookRelationships],
      ["xl/worksheets/sheet1.xml", HASHES.candidateManaged],
    ]);
    for (const item of body.package.structuralParts) {
      if (hashes.has(item.name)) {
        item.sha256 = hashes.get(item.name);
        item.uncompressedSize += item.name === "xl/worksheets/sheet1.xml" ? 137 : 29;
      }
    }
    const idMap = new Map();
    for (const [index, item] of body.package.relationships.entries()) {
      const nextId = `R${String(index + 1).padStart(4, "0")}`;
      idMap.set(`${item.sourcePartName ?? "root"}:${item.id}`, nextId);
      item.id = nextId;
    }
    body.package.relationships.reverse();
    for (const sheet of body.workbook.sheets) {
      sheet.relationshipId = idMap.get(`xl/workbook.xml:${sheet.relationshipId}`);
      if (sheet.partName === "xl/worksheets/sheet1.xml") sheet.partSha256 = HASHES.candidateManaged;
    }
    const managed = body.worksheets[0];
    managed.relationshipId = body.workbook.sheets[0].relationshipId;
    managed.partSha256 = HASHES.candidateManaged;
    managed.rows[1].cells.find((item) => item.ref === "B2").value.text = "新项目";
    managed.rows.splice(2, 0, row(3, [
      cell("B3", 1, "追加项目"),
      cell("C3", 2, "5.00", { type: "n", value: { raw: "5.00", text: null }, numberFormat: { numFmtId: 2, formatCode: "0.00" } }),
    ], { height: "24" }));
    managed.merges = [
      { ref: "D2:D3", startRow: 2, endRow: 3, startColumn: 4, endColumn: 4 },
      { ref: "E2:E3", startRow: 2, endRow: 3, startColumn: 5, endColumn: 5 },
      { ref: "F2:F3", startRow: 2, endRow: 3, startColumn: 6, endColumn: 6 },
    ];
    const cells = managed.rows.flatMap((item) => item.cells);
    const maxRow = Math.max(
      ...cells.map((item) => item.row),
      ...managed.merges.map((item) => item.endRow),
    );
    const maxColumn = Math.max(
      ...cells.map((item) => item.column),
      ...managed.merges.map((item) => item.endColumn),
    );
    managed.dimensionRef = `A1:${maxColumn > 6 ? "G" : "F"}${maxRow}`;
    const managedMaxRow = Math.max(
      ...cells.filter((item) => item.column <= 6).map((item) => item.row),
      ...managed.merges.filter((item) => item.startColumn <= 6).map((item) => item.endRow),
    );
    const sheetName = body.workbook.sheets[0].name.replaceAll("'", "''");
    body.workbook.definedNames.find((item) => (
      item.name === "_xlnm.Print_Area" && item.localSheetId === 0
    )).text = `'${sheetName}'!$A$1:$F$${managedMaxRow}`;
  });
}

function inspect(baseline = baselineFacts(), candidate = candidateFacts(baseline), extra = {}) {
  return inspectRootWorkbookTransition({
    baselineFacts: baseline,
    candidateFacts: candidate,
    managedSheetName: "公司支出",
    startRow: 2,
    endRow: 3,
    ...extra,
  });
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("root transition observation tolerates rId churn but never represents authorization", () => {
  const baseline = baselineFacts();
  const candidate = candidateFacts(baseline);
  const first = inspect(baseline, candidate);
  const second = inspect(baseline, candidate);
  for (const name of ["xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
    assert.notEqual(
      baseline.package.structuralParts.find((item) => item.name === name).uncompressedSize,
      candidate.package.structuralParts.find((item) => item.name === name).uncompressedSize,
    );
  }
  assert.equal(first.kind, "root-workbook-transition-observation-v1");
  assert.equal(first.requiresIndependentBusinessAudit, true);
  assert.equal(first.requiresIndependentStyleAudit, true);
  assert.equal(Object.hasOwn(first, "ok"), false);
  assert.equal(Object.hasOwn(first, "approved"), false);
  assert.equal(Object.hasOwn(first, "authorized"), false);
  assert.equal(first.scope.columns, "A:F");
  assert.deepEqual(first.presentation.dimensionRef, { before: "A1:F2", after: "A1:F3" });
  assert.deepEqual(first.presentation.printArea, {
    before: "'公司支出'!$A$1:$F$2",
    after: "'公司支出'!$A$1:$F$3",
  });
  assert.deepEqual(first.changes.changedCellRefs, ["B2", "B3", "C3"]);
  assert.deepEqual(first.changes.addedRowIndexes, [3]);
  assert.deepEqual(first.candidateTarget.rows.find((item) => item.index === 3).cells.map((item) => [
    item.ref,
    item.styleIndex,
    item.numberFormat,
  ]), [
    ["B3", 1, { numFmtId: 0, formatCode: "General" }],
    ["C3", 2, { numFmtId: 2, formatCode: "0.00" }],
  ]);
  assert.equal(first.transitionDigest, second.transitionDigest);
  assertDeepFrozen(first);
});

test("input contract rejects allowlists, expected facts, and authorization aliases", () => {
  for (const extra of [
    { allowlist: ["B2"] },
    { expectedRecords: [] },
    { authorized: true },
    { approved: true },
  ]) {
    assert.throws(() => inspect(undefined, undefined, extra), /unknown|allowlist|expectedRecords|authorized|approved/iu);
  }
});

test("relationship semantics ignore IDs and order but reject graph changes", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  assert.doesNotThrow(() => inspect(baseline, valid));
  const cases = [
    {
      name: "type",
      mutate(body) { body.package.relationships.find((item) => item.resolvedPartName === "xl/styles.xml").type = `${REL_NS}/theme`; },
    },
    {
      name: "internal-target",
      mutate(body) { body.package.relationships.find((item) => item.resolvedPartName === "xl/styles.xml").resolvedPartName = "xl/theme/theme1.xml"; },
    },
    {
      name: "external-target",
      mutate(body) { body.package.relationships.find((item) => item.targetMode === "External").target = "https://example.invalid/changed"; },
    },
    {
      name: "extra",
      mutate(body) {
        body.package.relationships.push(relationship(null, "_rels/.rels", "R-extra", "urn:extra", "extra.xml", "extra.xml"));
      },
    },
  ];
  for (const item of cases) {
    const candidate = mutateFacts(valid, item.mutate);
    assert.throws(() => inspect(baseline, candidate), /relationship|graph|semantic/iu, item.name);
  }
});

test("company unmanaged sheets are discovered from baseline and preserved exactly", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  const cases = [
    {
      name: "delete-sheet",
      mutate(body) { body.workbook.sheets.splice(1, 1); body.worksheets.splice(1, 1); },
    },
    {
      name: "change-value",
      mutate(body) { body.worksheets[1].rows[0].cells[0].value.text = "tampered"; },
    },
    {
      name: "change-style",
      mutate(body) { body.worksheets[1].rows[0].cells[0].styleIndex = 2; },
    },
    {
      name: "change-print",
      mutate(body) { body.worksheets[2].print.pageMargins.left = "0.4"; },
    },
    {
      name: "change-relationship",
      mutate(body) { body.package.relationships.find((item) => item.resolvedPartName === "xl/worksheets/sheet2.xml").type = `${REL_NS}/chartsheet`; },
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => inspect(baseline, mutateFacts(valid, item.mutate)),
      /unmanaged|sheet|relationship|preserv/iu,
      item.name,
    );
  }
});

test("package, workbook, shared resources, opaque facts, and canonical identity fail closed", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  const cases = [
    { name: "date-system", mutate(body) { body.workbook.date1904 = true; } },
    { name: "defined-name", mutate(body) { body.workbook.definedNames[0].text = "'公司支出'!$A$1:$F$5"; } },
    { name: "styles-part", mutate(body) { body.package.structuralParts.find((item) => item.name === "xl/styles.xml").sha256 = HASHES.candidate; } },
    { name: "styles-part-size", mutate(body) { body.package.structuralParts.find((item) => item.name === "xl/styles.xml").uncompressedSize += 1; } },
    { name: "shared-strings", mutate(body) { body.sharedStrings.items.push({ index: 0, text: "new", richTextDigest: HASHES.candidate }); } },
    { name: "extra-structural", mutate(body) { body.package.structuralParts.push(part("xl/extra.xml", HASHES.candidate)); } },
    { name: "non-structural", mutate(body) { body.package.nonStructuralPartNames.push("xl/media/image1.png"); } },
    { name: "workbook-opaque", mutate(body) { body.workbook.opaqueControlledPaths.push("workbook/calcPr"); } },
    { name: "managed-opaque", mutate(body) { body.worksheets[0].opaqueControlledPaths.push("worksheet/drawing"); } },
    { name: "managed-rename", mutate(body) { body.workbook.sheets[0].name = "住所支出"; body.worksheets[0].name = "住所支出"; } },
    { name: "managed-state", mutate(body) { body.workbook.sheets[0].state = "hidden"; body.worksheets[0].state = "hidden"; } },
  ];
  for (const item of cases) {
    assert.throws(
      () => inspect(baseline, mutateFacts(valid, item.mutate)),
      /package|part|workbook|style|shared|opaque|managed|sheet|identity|date|defined/iu,
      item.name,
    );
  }
});

test("managed scope allows material rows but preserves outside rows and presentation", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  const accepted = inspect(baseline, valid);
  assert.deepEqual(accepted.changes.addedRowIndexes, [3]);
  assert.equal(accepted.candidateTarget.rows.find((item) => item.index === 3).height, "24");
  const cases = [
    { name: "outside-column", mutate(body) { body.worksheets[0].rows.find((item) => item.index === 2).cells.push(cell("G2", 1, "tampered")); } },
    { name: "existing-row-height", mutate(body) { body.worksheets[0].rows.find((item) => item.index === 2).height = "25"; } },
    { name: "column-width", mutate(body) { body.worksheets[0].columns[0].width = "18"; } },
    { name: "freeze-view", mutate(body) { body.worksheets[0].views[0].showGridLines = true; } },
    { name: "print", mutate(body) { body.worksheets[0].print.pageSetup.scale = "90"; } },
    { name: "dimension", mutate(body) { body.worksheets[0].dimensionRef = "A1:G4"; } },
    { name: "cross-boundary-merge", mutate(body) { body.worksheets[0].merges.push({ ref: "A1:A2", startRow: 1, endRow: 2, startColumn: 1, endColumn: 1 }); } },
  ];
  for (const item of cases) {
    assert.throws(
      () => inspect(baseline, mutateFacts(valid, item.mutate)),
      /scope|outside|row|column|view|print|dimension|merge|presentation|preserv/iu,
      item.name,
    );
  }

  const baselineWithOutsideRow = mutateFacts(baseline, (body) => {
    body.worksheets[0].rows.push(row(4, [
      cell("A4", 1, "scope-outside"),
      cell("G4", 1, "outside-column"),
    ]));
    body.worksheets[0].dimensionRef = "A1:G4";
    body.workbook.definedNames[0].text = "'公司支出'!$A$1:$F$4";
  });
  const shiftedOutsideRow = mutateFacts(candidateFacts(baselineWithOutsideRow), (body) => {
    const row4 = body.worksheets[0].rows.find((item) => item.index === 4);
    row4.index = 5;
    for (const item of row4.cells) {
      item.row = 5;
      item.ref = item.ref.replace("4", "5");
    }
    body.worksheets[0].dimensionRef = "A1:G5";
    body.workbook.definedNames[0].text = "'公司支出'!$A$1:$F$5";
  });
  assert.throws(
    () => inspect(baselineWithOutsideRow, shiftedOutsideRow),
    /scope|outside|row|preserv/iu,
  );
});

test("managed used range and unique Print_Area may expand mechanically while Print_Titles stays fixed", () => {
  const baseline = baselineFacts();
  const candidate = candidateFacts(baseline);
  assert.doesNotThrow(() => inspect(baseline, candidate));

  const nullDimensionBaseline = mutateFacts(baseline, (body) => {
    body.worksheets[0].dimensionRef = null;
  });
  const nullDimensionCandidate = mutateFacts(candidateFacts(nullDimensionBaseline), (body) => {
    body.worksheets[0].dimensionRef = null;
  });
  assert.doesNotThrow(() => inspect(nullDimensionBaseline, nullDimensionCandidate));
  assert.doesNotThrow(() => inspect(nullDimensionBaseline, candidateFacts(nullDimensionBaseline)));

  const mergeOnlyCandidate = mutateFacts(candidateFacts(baseline), (body) => {
    const managed = body.worksheets[0];
    managed.rows.find((item) => item.index === 2).cells.find((item) => item.ref === "B2").value.text = "旧项目";
    managed.rows = managed.rows.filter((item) => item.index !== 3);
  });
  const mergeOnly = inspect(baseline, mergeOnlyCandidate);
  assert.deepEqual(mergeOnly.changes.changedCellRefs, []);
  assert.equal(mergeOnly.presentation.actualUsedRange.after, "A1:F3");
  assert.equal(mergeOnly.presentation.printArea.after, "'公司支出'!$A$1:$F$3");

  const baselineWithOutsideColumn = mutateFacts(baseline, (body) => {
    body.worksheets[0].rows.push(row(20, [cell("G20", 1, "preserved-outside-column")]));
    body.worksheets[0].dimensionRef = "A1:G20";
  });
  const candidateWithOutsideColumn = mutateFacts(candidateFacts(baselineWithOutsideColumn), (body) => {
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$3";
  });
  const outsideColumn = inspect(baselineWithOutsideColumn, candidateWithOutsideColumn);
  assert.equal(outsideColumn.presentation.actualUsedRange.after, "A1:G20");
  assert.equal(outsideColumn.presentation.printArea.after, "'公司支出'!$A$1:$F$3");

  const shrinkingPrintBaseline = mutateFacts(baseline, (body) => {
    body.worksheets[0].rows.push(row(3, [cell("B3", 1, "old-last-row")]));
    body.worksheets[0].rows.push(row(20, [cell("G20", 1, "preserved-outside-column")]));
    body.worksheets[0].dimensionRef = "A1:G20";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$3";
  });
  const shrinkingPrintCandidate = mutateFacts(candidateFacts(shrinkingPrintBaseline), (body) => {
    body.worksheets[0].rows = body.worksheets[0].rows.filter((item) => item.index !== 3);
    body.worksheets[0].merges = [];
    body.worksheets[0].dimensionRef = "A1:G20";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$2";
  });
  assert.throws(
    () => inspect(shrinkingPrintBaseline, shrinkingPrintCandidate),
    /Print_Area|managed.*range|shrink/iu,
  );

  const cases = [
    {
      name: "print-titles",
      mutate(body) { body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Titles").text = "'公司支出'!$1:$2"; },
    },
    {
      name: "duplicate-print-area",
      mutate(body) { body.workbook.definedNames.push(structuredClone(body.workbook.definedNames[0])); },
    },
    {
      name: "wrong-local-sheet",
      mutate(body) { body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").localSheetId = 1; },
    },
    {
      name: "multiple-print-ranges",
      mutate(body) { body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text += ",'公司支出'!$A$1:$F$3"; },
    },
    {
      name: "wrong-print-end",
      mutate(body) { body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$9"; },
    },
    {
      name: "dimension-shrink-to-null",
      mutate(body) { body.worksheets[0].dimensionRef = null; },
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => inspect(baseline, mutateFacts(candidate, item.mutate)),
      /Print_Area|Print_Titles|defined|dimension|used range|localSheetId/iu,
      item.name,
    );
  }
});

test("existing cell styles remain exact and new cells only reuse unapproved baseline column signatures", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  const existingDrift = mutateFacts(valid, (body) => {
    body.worksheets[0].rows.find((item) => item.index === 2).cells.find((item) => item.ref === "B2").styleIndex = 2;
  });
  assert.throws(() => inspect(baseline, existingDrift), /style|number format/iu);
  const newDrift = mutateFacts(valid, (body) => {
    body.worksheets[0].rows.find((item) => item.index === 3).cells.find((item) => item.ref === "B3").styleIndex = 2;
  });
  assert.throws(() => inspect(baseline, newDrift), /style|signature|column/iu);
});

test("tampered facts and candidates without a scoped change are rejected", () => {
  const baseline = baselineFacts();
  const valid = candidateFacts(baseline);
  const tampered = structuredClone(valid);
  tampered.source.size += 1;
  assert.throws(() => inspect(baseline, tampered), /factsDigest|digest|tamper/iu);
  const unchanged = mutateFacts(valid, (body) => {
    const sourceManaged = structuredClone(baseline.worksheets[0]);
    sourceManaged.relationshipId = body.workbook.sheets[0].relationshipId;
    sourceManaged.partSha256 = HASHES.candidateManaged;
    body.worksheets[0] = sourceManaged;
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$2";
  });
  assert.throws(() => inspect(baseline, unchanged), /no.*scope|unchanged|transition/iu);

  const nullDimensionBaseline = mutateFacts(baseline, (body) => {
    body.worksheets[0].dimensionRef = null;
  });
  const dimensionOnly = mutateFacts(candidateFacts(nullDimensionBaseline), (body) => {
    const sourceManaged = structuredClone(nullDimensionBaseline.worksheets[0]);
    sourceManaged.relationshipId = body.workbook.sheets[0].relationshipId;
    sourceManaged.partSha256 = HASHES.candidateManaged;
    sourceManaged.dimensionRef = "A1:F2";
    body.worksheets[0] = sourceManaged;
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'公司支出'!$A$1:$F$2";
  });
  assert.throws(() => inspect(nullDimensionBaseline, dimensionOnly), /no.*scope|unchanged|transition/iu);
});

test("canonical residence identity succeeds before an ordinary alias rename is rejected", () => {
  const baseline = mutateFacts(baselineFacts(), (body) => {
    body.workbook.sheets[0].name = "驻所支出";
    body.worksheets[0].name = "驻所支出";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'驻所支出'!$A$1:$F$2";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Titles").text = "'驻所支出'!$1:$1";
  });
  const candidate = candidateFacts(baseline);
  const accepted = inspectRootWorkbookTransition({
    baselineFacts: baseline,
    candidateFacts: candidate,
    managedSheetName: "驻所支出",
    startRow: 2,
    endRow: 3,
  });
  assert.equal(accepted.scope.managedSheetName, "驻所支出");
  assert.deepEqual(accepted.presentation.printArea, {
    before: "'驻所支出'!$A$1:$F$2",
    after: "'驻所支出'!$A$1:$F$3",
  });

  const aliasCandidate = mutateFacts(candidate, (body) => {
    body.workbook.sheets[0].name = "住所支出";
    body.worksheets[0].name = "住所支出";
  });
  assert.throws(
    () => inspectRootWorkbookTransition({
      baselineFacts: baseline,
      candidateFacts: aliasCandidate,
      managedSheetName: "驻所支出",
      startRow: 2,
      endRow: 3,
    }),
    /managed|sheet|identity|驻所/u,
  );
});

test("canonical Xiaohongshu Sheet1 identity succeeds without a profile-specific branch", () => {
  const baseline = mutateFacts(baselineFacts(), (body) => {
    body.workbook.sheets[0].name = "Sheet1";
    body.worksheets[0].name = "Sheet1";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area").text = "'Sheet1'!$A$1:$F$2";
    body.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Titles").text = "'Sheet1'!$1:$1";
  });
  const accepted = inspectRootWorkbookTransition({
    baselineFacts: baseline,
    candidateFacts: candidateFacts(baseline),
    managedSheetName: "Sheet1",
    startRow: 2,
    endRow: 3,
  });
  assert.equal(accepted.scope.managedSheetName, "Sheet1");
  assert.equal(accepted.presentation.printArea.after, "'Sheet1'!$A$1:$F$3");
});
