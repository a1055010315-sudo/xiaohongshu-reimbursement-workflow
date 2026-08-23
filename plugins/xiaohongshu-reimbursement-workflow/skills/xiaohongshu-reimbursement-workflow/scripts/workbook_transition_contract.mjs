import { isDeepStrictEqual } from "node:util";

import { canonicalDigest } from "./workflow_primitives.mjs";

const INPUT_KEYS = new Set([
  "baselineFacts",
  "candidateFacts",
  "managedSheetName",
  "startRow",
  "endRow",
]);
const MAX_EXCEL_ROW = 1_048_576;
const MAX_EXCEL_COLUMN = 16_384;
const MANAGED_START_COLUMN = 1;
const MANAGED_END_COLUMN = 6;

function fail(message) {
  throw new Error(`Workbook transition ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string.`);
  return value;
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

function withoutKeys(value, keys) {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function assertSame(left, right, message) {
  if (!isDeepStrictEqual(left, right)) fail(message);
}

function verifyFacts(facts, field) {
  requireRecord(facts, field);
  if (facts.kind !== "workbook-ooxml-facts-v1") {
    fail(`${field} has an unsupported facts kind.`);
  }
  if (!/^[0-9a-f]{64}$/u.test(facts.factsDigest ?? "")) {
    fail(`${field}.factsDigest must be a lowercase SHA-256 digest.`);
  }
  const body = { ...facts };
  delete body.factsDigest;
  if (canonicalDigest(body) !== facts.factsDigest) {
    fail(`${field}.factsDigest does not match the supplied facts; input may be tampered.`);
  }
  requireRecord(facts.source, `${field}.source`);
  requireRecord(facts.package, `${field}.package`);
  requireRecord(facts.workbook, `${field}.workbook`);
  requireArray(facts.worksheets, `${field}.worksheets`);
  return facts;
}

function validateInput(options) {
  requireRecord(options, "input");
  for (const key of Object.keys(options)) {
    if (!INPUT_KEYS.has(key)) fail(`input contains unknown field ${key}.`);
  }
  for (const key of INPUT_KEYS) {
    if (!Object.hasOwn(options, key)) fail(`input is missing ${key}.`);
  }
  const managedSheetName = requireString(options.managedSheetName, "managedSheetName");
  for (const [field, value] of [["startRow", options.startRow], ["endRow", options.endRow]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXCEL_ROW) {
      fail(`${field} must be an Excel row index.`);
    }
  }
  if (options.startRow > options.endRow) fail("startRow must not exceed endRow.");
  return {
    baselineFacts: verifyFacts(options.baselineFacts, "baselineFacts"),
    candidateFacts: verifyFacts(options.candidateFacts, "candidateFacts"),
    managedSheetName,
    startRow: options.startRow,
    endRow: options.endRow,
  };
}

function relationshipSemantic(item, field) {
  requireRecord(item, field);
  const sourcePartName = item.sourcePartName === null
    ? null
    : requireString(item.sourcePartName, `${field}.sourcePartName`);
  const relationshipPartName = requireString(item.relationshipPartName, `${field}.relationshipPartName`);
  const type = requireString(item.type, `${field}.type`);
  if (item.targetMode !== "Internal" && item.targetMode !== "External") {
    fail(`${field}.targetMode is invalid.`);
  }
  if (item.targetMode === "Internal") {
    return {
      sourcePartName,
      relationshipPartName,
      type,
      targetMode: "Internal",
      resolvedPartName: requireString(item.resolvedPartName, `${field}.resolvedPartName`),
      externalTarget: null,
    };
  }
  if (item.resolvedPartName !== null) fail(`${field} external relationship resolvedPartName must be null.`);
  return {
    sourcePartName,
    relationshipPartName,
    type,
    targetMode: "External",
    resolvedPartName: null,
    externalTarget: requireString(item.target, `${field}.target`),
  };
}

function relationshipSemantics(facts, field) {
  const semantics = requireArray(facts.package.relationships, `${field}.package.relationships`)
    .map((item, index) => relationshipSemantic(item, `${field}.package.relationships[${index}]`));
  semantics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  return semantics;
}

function relationshipPartForSource(facts, sourcePartName, field) {
  const names = new Set(
    facts.package.relationships
      .filter((item) => item.sourcePartName === sourcePartName)
      .map((item) => item.relationshipPartName),
  );
  if (names.size !== 1) fail(`${field} must have exactly one relationship Part for ${sourcePartName ?? "package root"}.`);
  return [...names][0];
}

function structuralPartMap(facts, field) {
  const result = new Map();
  for (const [index, item] of requireArray(facts.package.structuralParts, `${field}.package.structuralParts`).entries()) {
    requireRecord(item, `${field}.package.structuralParts[${index}]`);
    const name = requireString(item.name, `${field}.package.structuralParts[${index}].name`);
    if (result.has(name)) fail(`${field} contains duplicate structural Part ${name}.`);
    if (!Number.isSafeInteger(item.uncompressedSize) || item.uncompressedSize < 0) {
      fail(`${field} structural Part ${name} has an invalid size.`);
    }
    if (!/^[0-9a-f]{64}$/u.test(item.sha256 ?? "")) {
      fail(`${field} structural Part ${name} has an invalid SHA-256 digest.`);
    }
    result.set(name, item);
  }
  return result;
}

function workbookSheetSemantics(facts, field) {
  const workbookPartName = requireString(facts.package.workbookPartName, `${field}.package.workbookPartName`);
  const relationships = facts.package.relationships;
  const seenNames = new Set();
  const seenParts = new Set();
  return requireArray(facts.workbook.sheets, `${field}.workbook.sheets`).map((sheet, index) => {
    requireRecord(sheet, `${field}.workbook.sheets[${index}]`);
    if (sheet.order !== index) fail(`${field} workbook sheet order is not canonical.`);
    const name = requireString(sheet.name, `${field}.workbook.sheets[${index}].name`);
    const partName = requireString(sheet.partName, `${field}.workbook.sheets[${index}].partName`);
    if (seenNames.has(name) || seenParts.has(partName)) fail(`${field} workbook contains duplicate sheet identities.`);
    seenNames.add(name);
    seenParts.add(partName);
    const matches = relationships.filter((item) => (
      item.sourcePartName === workbookPartName && item.id === sheet.relationshipId
    ));
    if (
      matches.length !== 1
      || matches[0].targetMode !== "Internal"
      || matches[0].resolvedPartName !== partName
      || !/\/worksheet$/u.test(matches[0].type)
    ) {
      fail(`${field} workbook sheet ${name} is not bound to its worksheet relationship.`);
    }
    return {
      order: sheet.order,
      name,
      sheetId: sheet.sheetId,
      state: sheet.state,
      partName,
    };
  });
}

function worksheetByPartName(facts, field) {
  const result = new Map();
  for (const [index, worksheet] of facts.worksheets.entries()) {
    requireRecord(worksheet, `${field}.worksheets[${index}]`);
    const name = requireString(worksheet.partName, `${field}.worksheets[${index}].partName`);
    if (result.has(name)) fail(`${field} contains duplicate worksheet facts for ${name}.`);
    result.set(name, worksheet);
  }
  return result;
}

function validateSheetPartBindings(facts, sheetSemantics, partMap, worksheetMap, field) {
  if (worksheetMap.size !== sheetSemantics.length) fail(`${field} worksheet facts do not match workbook sheets.`);
  for (const sheet of sheetSemantics) {
    const worksheet = worksheetMap.get(sheet.partName);
    const part = partMap.get(sheet.partName);
    const workbookSheet = facts.workbook.sheets[sheet.order];
    if (!worksheet || !part) fail(`${field} is missing worksheet Part facts for ${sheet.name}.`);
    if (
      worksheet.order !== sheet.order
      || worksheet.name !== sheet.name
      || worksheet.sheetId !== sheet.sheetId
      || worksheet.state !== sheet.state
      || worksheet.partSha256 !== part.sha256
      || workbookSheet.partSha256 !== part.sha256
    ) {
      fail(`${field} worksheet identity or Part digest is inconsistent for ${sheet.name}.`);
    }
  }
}

function assertNoOpaqueOrNonStructural(facts, field) {
  const nonStructural = requireArray(
    facts.package.nonStructuralPartNames,
    `${field}.package.nonStructuralPartNames`,
  );
  if (nonStructural.length !== 0) fail(`${field} contains non-structural package Parts.`);
  const workbookOpaque = requireArray(
    facts.workbook.opaqueControlledPaths,
    `${field}.workbook.opaqueControlledPaths`,
  );
  if (workbookOpaque.length !== 0) fail(`${field} contains opaque controlled workbook semantics.`);
  for (const worksheet of facts.worksheets) {
    const opaque = requireArray(
      worksheet.opaqueControlledPaths,
      `${field}.worksheet.opaqueControlledPaths`,
    );
    if (opaque.length !== 0) fail(`${field} contains opaque controlled worksheet semantics.`);
  }
}

function comparePackage(
  baselineFacts,
  candidateFacts,
  baselineParts,
  candidateParts,
  managedPartName,
) {
  if (baselineFacts.package.workbookPartName !== candidateFacts.package.workbookPartName) {
    fail("workbook Part identity changed.");
  }
  const workbookPartName = baselineFacts.package.workbookPartName;
  const baselineRootRelationships = relationshipPartForSource(baselineFacts, null, "baselineFacts");
  const candidateRootRelationships = relationshipPartForSource(candidateFacts, null, "candidateFacts");
  if (baselineRootRelationships !== "_rels/.rels" || candidateRootRelationships !== baselineRootRelationships) {
    fail("root relationship Part identity changed.");
  }
  const baselineWorkbookRelationships = relationshipPartForSource(
    baselineFacts,
    workbookPartName,
    "baselineFacts",
  );
  const candidateWorkbookRelationships = relationshipPartForSource(
    candidateFacts,
    workbookPartName,
    "candidateFacts",
  );
  if (baselineWorkbookRelationships !== candidateWorkbookRelationships) {
    fail("workbook relationship Part identity changed.");
  }
  const exceptions = new Set([
    baselineRootRelationships,
    workbookPartName,
    baselineWorkbookRelationships,
    managedPartName,
  ]);
  const names = new Set([...baselineParts.keys(), ...candidateParts.keys()]);
  if (names.size !== baselineParts.size || names.size !== candidateParts.size) {
    fail("package structural Part identities changed.");
  }
  for (const name of names) {
    const before = baselineParts.get(name);
    const after = candidateParts.get(name);
    if (!before || !after) fail(`package structural Part ${name} was added or removed.`);
    if (!exceptions.has(name) && !isDeepStrictEqual(before, after)) {
      fail(`package structural Part ${name} was not preserved.`);
    }
  }
  const beforeRelationships = relationshipSemantics(baselineFacts, "baselineFacts");
  const afterRelationships = relationshipSemantics(candidateFacts, "candidateFacts");
  assertSame(beforeRelationships, afterRelationships, "relationship graph semantics changed.");
  return {
    workbookRelationshipPartName: baselineWorkbookRelationships,
    relationshipSemanticsDigest: canonicalDigest(beforeRelationships),
    preservedStructuralPartCount: names.size - exceptions.size,
  };
}

function columnName(column) {
  if (!Number.isSafeInteger(column) || column < 1 || column > MAX_EXCEL_COLUMN) {
    fail("worksheet contains an invalid column index.");
  }
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function actualUsedRange(worksheet, field) {
  let minRow = Infinity;
  let maxRow = 0;
  let minColumn = Infinity;
  let maxColumn = 0;
  for (const row of requireArray(worksheet.rows, `${field}.rows`)) {
    if (!Number.isSafeInteger(row.index) || row.index < 1 || row.index > MAX_EXCEL_ROW) {
      fail(`${field} contains an invalid row index.`);
    }
    for (const cell of requireArray(row.cells, `${field}.row.cells`)) {
      if (cell.row !== row.index) fail(`${field} cell ${cell.ref ?? "?"} does not match its row.`);
      columnName(cell.column);
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minColumn = Math.min(minColumn, cell.column);
      maxColumn = Math.max(maxColumn, cell.column);
    }
  }
  for (const merge of requireArray(worksheet.merges, `${field}.merges`)) {
    if (
      !Number.isSafeInteger(merge.startRow)
      || !Number.isSafeInteger(merge.endRow)
      || !Number.isSafeInteger(merge.startColumn)
      || !Number.isSafeInteger(merge.endColumn)
      || merge.startRow < 1
      || merge.endRow > MAX_EXCEL_ROW
      || merge.startRow > merge.endRow
      || merge.startColumn < 1
      || merge.endColumn > MAX_EXCEL_COLUMN
      || merge.startColumn > merge.endColumn
    ) {
      fail(`${field} contains an invalid merge range.`);
    }
    minRow = Math.min(minRow, merge.startRow);
    maxRow = Math.max(maxRow, merge.endRow);
    minColumn = Math.min(minColumn, merge.startColumn);
    maxColumn = Math.max(maxColumn, merge.endColumn);
  }
  if (maxRow === 0) fail(`${field} has no actual cells or merges.`);
  return {
    minRow,
    maxRow,
    minColumn,
    maxColumn,
    ref: `${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}`,
  };
}

function managedPrintExtent(worksheet, field) {
  let maxRow = 0;
  for (const row of requireArray(worksheet.rows, `${field}.rows`)) {
    for (const cell of requireArray(row.cells, `${field}.row.cells`)) {
      if (cell.column >= MANAGED_START_COLUMN && cell.column <= MANAGED_END_COLUMN) {
        maxRow = Math.max(maxRow, cell.row);
      }
    }
  }
  for (const merge of requireArray(worksheet.merges, `${field}.merges`)) {
    if (merge.startColumn <= MANAGED_END_COLUMN && merge.endColumn >= MANAGED_START_COLUMN) {
      maxRow = Math.max(maxRow, merge.endRow);
    }
  }
  if (maxRow === 0) fail(`${field} has no actual cells or merges in managed columns A:F.`);
  return {
    maxRow,
    ref: `A1:F${maxRow}`,
  };
}

function rangeContains(outer, inner) {
  return outer.minRow <= inner.minRow
    && outer.maxRow >= inner.maxRow
    && outer.minColumn <= inner.minColumn
    && outer.maxColumn >= inner.maxColumn;
}

function validateDimension(before, after, baselineRange, candidateRange) {
  if (before !== null && before !== baselineRange.ref) {
    fail("baseline managed dimensionRef does not match its actual used range.");
  }
  if (after !== null && after !== candidateRange.ref) {
    fail("candidate managed dimensionRef does not match its actual used range.");
  }
  if (before !== null && after === null) {
    fail("candidate managed dimensionRef cannot be removed.");
  }
  if (!rangeContains(candidateRange, baselineRange)) {
    fail("candidate managed used range cannot shrink.");
  }
}

function managedPrintArea(definedNames, sheetName, sheetIndex, printExtent, field) {
  requireArray(definedNames, `${field}.definedNames`);
  const matches = definedNames
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.name === "_xlnm.Print_Area");
  if (matches.length !== 1) fail(`${field} must contain one unique managed _xlnm.Print_Area.`);
  const { item, index } = matches[0];
  if (item.localSheetId !== sheetIndex) {
    fail(`${field} _xlnm.Print_Area localSheetId does not identify the managed sheet.`);
  }
  const escapedSheetName = sheetName.replaceAll("'", "''");
  const expected = `'${escapedSheetName}'!$A$1:$F$${printExtent.maxRow}`;
  if (item.text !== expected) {
    fail(`${field} _xlnm.Print_Area is not the single mechanical A1:F used-row range.`);
  }
  return { index, item, text: item.text };
}

function compareDefinedNames(baselineFacts, candidateFacts, managedSheetName, sheetIndex, ranges) {
  if (ranges.candidate.maxRow < ranges.baseline.maxRow) {
    fail("managed _xlnm.Print_Area row range cannot shrink.");
  }
  const before = managedPrintArea(
    baselineFacts.workbook.definedNames,
    managedSheetName,
    sheetIndex,
    ranges.baseline,
    "baseline workbook",
  );
  const after = managedPrintArea(
    candidateFacts.workbook.definedNames,
    managedSheetName,
    sheetIndex,
    ranges.candidate,
    "candidate workbook",
  );
  const normalize = (definedNames, area) => definedNames.map((item, index) => (
    index === area.index ? { ...item, text: "<managed-print-area>" } : item
  ));
  assertSame(
    normalize(baselineFacts.workbook.definedNames, before),
    normalize(candidateFacts.workbook.definedNames, after),
    "defined names, including _xlnm.Print_Titles, were not preserved.",
  );
  return { before: before.text, after: after.text };
}

function rowWithoutCells(row) {
  return withoutKeys(row, new Set(["cells"]));
}

function cellStyleSignature(cell) {
  return {
    styleIndex: cell.styleIndex,
    numberFormat: cell.numberFormat,
    cellMetadataIndex: cell.cellMetadataIndex,
    valueMetadataIndex: cell.valueMetadataIndex,
    phonetic: cell.phonetic,
  };
}

function cellMap(rows, predicate, field) {
  const result = new Map();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!predicate(cell, row)) continue;
      if (result.has(cell.ref)) fail(`${field} contains duplicate cell ${cell.ref}.`);
      result.set(cell.ref, cell);
    }
  }
  return result;
}

function compareCellMaps(before, after, message) {
  const refs = new Set([...before.keys(), ...after.keys()]);
  for (const ref of refs) {
    if (!isDeepStrictEqual(before.get(ref), after.get(ref))) fail(`${message}: ${ref}.`);
  }
}

function coordinateSort(left, right, lookup) {
  const leftCell = lookup.get(left);
  const rightCell = lookup.get(right);
  return leftCell.row - rightCell.row || leftCell.column - rightCell.column;
}

function targetRows(worksheet, startRow, endRow) {
  return worksheet.rows
    .filter((row) => row.index >= startRow && row.index <= endRow)
    .map((row) => ({
      ...clone(rowWithoutCells(row)),
      cells: clone(row.cells.filter((cell) => (
        cell.column >= MANAGED_START_COLUMN && cell.column <= MANAGED_END_COLUMN
      ))),
    }));
}

function mergeIsInsideScope(merge, startRow, endRow) {
  return merge.startRow >= startRow
    && merge.endRow <= endRow
    && merge.startColumn >= MANAGED_START_COLUMN
    && merge.endColumn <= MANAGED_END_COLUMN;
}

function compareManagedRowsAndMerges(baseline, candidate, startRow, endRow) {
  const baselineOutsideRows = baseline.rows.filter((row) => row.index < startRow || row.index > endRow);
  const candidateOutsideRows = candidate.rows.filter((row) => row.index < startRow || row.index > endRow);
  assertSame(baselineOutsideRows, candidateOutsideRows, "scope-external rows were not preserved.");

  const baselineScopeRows = new Map(
    baseline.rows.filter((row) => row.index >= startRow && row.index <= endRow).map((row) => [row.index, row]),
  );
  const candidateScopeRows = new Map(
    candidate.rows.filter((row) => row.index >= startRow && row.index <= endRow).map((row) => [row.index, row]),
  );
  for (const index of new Set([...baselineScopeRows.keys(), ...candidateScopeRows.keys()])) {
    const before = baselineScopeRows.get(index);
    const after = candidateScopeRows.get(index);
    if (before && after) {
      assertSame(rowWithoutCells(before), rowWithoutCells(after), `existing managed row ${index} presentation changed.`);
    }
  }

  const outsideColumn = (cell, row) => (
    row.index >= startRow
    && row.index <= endRow
    && (cell.column < MANAGED_START_COLUMN || cell.column > MANAGED_END_COLUMN)
  );
  compareCellMaps(
    cellMap(baseline.rows, outsideColumn, "baseline managed worksheet"),
    cellMap(candidate.rows, outsideColumn, "candidate managed worksheet"),
    "scope-external columns were not preserved",
  );

  const inScope = (cell, row) => (
    row.index >= startRow
    && row.index <= endRow
    && cell.column >= MANAGED_START_COLUMN
    && cell.column <= MANAGED_END_COLUMN
  );
  const baselineCells = cellMap(baseline.rows, inScope, "baseline managed scope");
  const candidateCells = cellMap(candidate.rows, inScope, "candidate managed scope");
  const baselineStylesByColumn = new Map();
  for (const row of baseline.rows) {
    for (const cell of row.cells) {
      if (cell.column < MANAGED_START_COLUMN || cell.column > MANAGED_END_COLUMN) continue;
      const digest = canonicalDigest(cellStyleSignature(cell));
      if (!baselineStylesByColumn.has(cell.column)) baselineStylesByColumn.set(cell.column, new Set());
      baselineStylesByColumn.get(cell.column).add(digest);
    }
  }

  const allRefs = new Set([...baselineCells.keys(), ...candidateCells.keys()]);
  const changedCellRefs = [];
  const addedCellRefs = [];
  const removedCellRefs = [];
  for (const ref of allRefs) {
    const before = baselineCells.get(ref);
    const after = candidateCells.get(ref);
    if (before && after) {
      assertSame(
        cellStyleSignature(before),
        cellStyleSignature(after),
        `existing cell ${ref} style or number format changed.`,
      );
    } else if (after) {
      const signatures = baselineStylesByColumn.get(after.column);
      if (!signatures?.has(canonicalDigest(cellStyleSignature(after)))) {
        fail(`new cell ${ref} does not reuse a baseline same-column style signature.`);
      }
      addedCellRefs.push(ref);
    } else {
      removedCellRefs.push(ref);
    }
    if (!isDeepStrictEqual(before, after)) changedCellRefs.push(ref);
  }
  const lookup = new Map([...baselineCells, ...candidateCells]);
  for (const refs of [changedCellRefs, addedCellRefs, removedCellRefs]) {
    refs.sort((left, right) => coordinateSort(left, right, lookup));
  }

  const baselineOutsideMerges = baseline.merges.filter((merge) => !mergeIsInsideScope(merge, startRow, endRow));
  const candidateOutsideMerges = candidate.merges.filter((merge) => !mergeIsInsideScope(merge, startRow, endRow));
  assertSame(baselineOutsideMerges, candidateOutsideMerges, "scope-external or cross-boundary merges changed.");
  const baselineScopeMerges = baseline.merges.filter((merge) => mergeIsInsideScope(merge, startRow, endRow));
  const candidateScopeMerges = candidate.merges.filter((merge) => mergeIsInsideScope(merge, startRow, endRow));

  const addedRowIndexes = [...candidateScopeRows.keys()]
    .filter((index) => !baselineScopeRows.has(index))
    .sort((left, right) => left - right);
  const removedRowIndexes = [...baselineScopeRows.keys()]
    .filter((index) => !candidateScopeRows.has(index))
    .sort((left, right) => left - right);
  return {
    baselineTarget: {
      rows: targetRows(baseline, startRow, endRow),
      merges: clone(baselineScopeMerges),
    },
    candidateTarget: {
      rows: targetRows(candidate, startRow, endRow),
      merges: clone(candidateScopeMerges),
    },
    changes: {
      changedCellRefs,
      addedCellRefs,
      removedCellRefs,
      addedRowIndexes,
      removedRowIndexes,
      merges: {
        before: clone(baselineScopeMerges),
        after: clone(candidateScopeMerges),
      },
    },
    hasScopedChange: changedCellRefs.length > 0
      || addedRowIndexes.length > 0
      || removedRowIndexes.length > 0
      || !isDeepStrictEqual(baselineScopeMerges, candidateScopeMerges),
  };
}

function compareManagedPresentation(baseline, candidate) {
  const ignored = new Set(["relationshipId", "partSha256", "dimensionRef", "rows", "merges"]);
  assertSame(
    withoutKeys(baseline, ignored),
    withoutKeys(candidate, ignored),
    "managed sheet identity, columns, views, print, or presentation changed outside the scoped facts.",
  );
}

function compareUnmanagedSheets(
  baselineSheets,
  candidateSheets,
  baselineWorksheets,
  candidateWorksheets,
  managedPartName,
) {
  const names = [];
  for (const sheet of baselineSheets) {
    if (sheet.partName === managedPartName) continue;
    const candidateSheet = candidateSheets[sheet.order];
    const before = baselineWorksheets.get(sheet.partName);
    const after = candidateWorksheets.get(sheet.partName);
    if (!candidateSheet || !before || !after) fail(`unmanaged sheet ${sheet.name} is missing.`);
    assertSame(
      withoutKeys(before, new Set(["relationshipId"])),
      withoutKeys(after, new Set(["relationshipId"])),
      `unmanaged sheet ${sheet.name} was not fully preserved.`,
    );
    names.push(sheet.name);
  }
  return names;
}

export function inspectRootWorkbookTransition(options) {
  const {
    baselineFacts,
    candidateFacts,
    managedSheetName,
    startRow,
    endRow,
  } = validateInput(options);
  assertNoOpaqueOrNonStructural(baselineFacts, "baselineFacts");
  assertNoOpaqueOrNonStructural(candidateFacts, "candidateFacts");

  const baselineParts = structuralPartMap(baselineFacts, "baselineFacts");
  const candidateParts = structuralPartMap(candidateFacts, "candidateFacts");
  const baselineSheets = workbookSheetSemantics(baselineFacts, "baselineFacts");
  const candidateSheets = workbookSheetSemantics(candidateFacts, "candidateFacts");
  assertSame(baselineSheets, candidateSheets, "workbook sheet identities or order changed.");
  if (baselineFacts.workbook.date1904 !== candidateFacts.workbook.date1904) {
    fail("workbook date system changed.");
  }

  const managedSheetIndex = baselineSheets.findIndex((sheet) => sheet.name === managedSheetName);
  if (managedSheetIndex < 0) fail(`managed sheet identity ${managedSheetName} is absent.`);
  if (baselineSheets.filter((sheet) => sheet.name === managedSheetName).length !== 1) {
    fail(`managed sheet identity ${managedSheetName} is ambiguous.`);
  }
  const managedPartName = baselineSheets[managedSheetIndex].partName;
  const baselineWorksheets = worksheetByPartName(baselineFacts, "baselineFacts");
  const candidateWorksheets = worksheetByPartName(candidateFacts, "candidateFacts");
  validateSheetPartBindings(
    baselineFacts,
    baselineSheets,
    baselineParts,
    baselineWorksheets,
    "baselineFacts",
  );
  validateSheetPartBindings(
    candidateFacts,
    candidateSheets,
    candidateParts,
    candidateWorksheets,
    "candidateFacts",
  );
  const baselineManaged = baselineWorksheets.get(managedPartName);
  const candidateManaged = candidateWorksheets.get(managedPartName);

  const packageEvidence = comparePackage(
    baselineFacts,
    candidateFacts,
    baselineParts,
    candidateParts,
    managedPartName,
  );
  assertSame(baselineFacts.styles, candidateFacts.styles, "styles facts were not preserved.");
  assertSame(baselineFacts.sharedStrings, candidateFacts.sharedStrings, "shared strings facts were not preserved.");
  compareManagedPresentation(baselineManaged, candidateManaged);
  const unmanagedSheetNames = compareUnmanagedSheets(
    baselineSheets,
    candidateSheets,
    baselineWorksheets,
    candidateWorksheets,
    managedPartName,
  );

  const baselineRange = actualUsedRange(baselineManaged, "baseline managed worksheet");
  const candidateRange = actualUsedRange(candidateManaged, "candidate managed worksheet");
  const baselinePrintExtent = managedPrintExtent(baselineManaged, "baseline managed worksheet");
  const candidatePrintExtent = managedPrintExtent(candidateManaged, "candidate managed worksheet");
  validateDimension(
    baselineManaged.dimensionRef,
    candidateManaged.dimensionRef,
    baselineRange,
    candidateRange,
  );
  const printArea = compareDefinedNames(
    baselineFacts,
    candidateFacts,
    managedSheetName,
    managedSheetIndex,
    { baseline: baselinePrintExtent, candidate: candidatePrintExtent },
  );
  const scoped = compareManagedRowsAndMerges(baselineManaged, candidateManaged, startRow, endRow);
  if (!scoped.hasScopedChange) {
    fail("contains no scoped root workbook transition change.");
  }

  const body = {
    kind: "root-workbook-transition-observation-v1",
    requiresIndependentBusinessAudit: true,
    requiresIndependentStyleAudit: true,
    baseline: {
      sourceSize: baselineFacts.source.size,
      sourceSha256: baselineFacts.source.sha256,
      factsDigest: baselineFacts.factsDigest,
    },
    candidate: {
      sourceSize: candidateFacts.source.size,
      sourceSha256: candidateFacts.source.sha256,
      factsDigest: candidateFacts.factsDigest,
    },
    scope: {
      managedSheetName,
      managedSheetOrder: managedSheetIndex,
      managedPartName,
      startRow,
      endRow,
      columns: "A:F",
    },
    packageEvidence,
    workbookIdentity: {
      date1904: baselineFacts.workbook.date1904,
      sheets: clone(baselineSheets),
      unmanagedSheetNames,
    },
    presentation: {
      actualUsedRange: {
        before: baselineRange.ref,
        after: candidateRange.ref,
      },
      managedPrintRange: {
        before: baselinePrintExtent.ref,
        after: candidatePrintExtent.ref,
      },
      dimensionRef: {
        before: baselineManaged.dimensionRef,
        after: candidateManaged.dimensionRef,
      },
      printArea,
    },
    baselineTarget: scoped.baselineTarget,
    candidateTarget: scoped.candidateTarget,
    changes: scoped.changes,
  };
  return deepFreeze({
    ...body,
    transitionDigest: canonicalDigest(body),
  });
}
