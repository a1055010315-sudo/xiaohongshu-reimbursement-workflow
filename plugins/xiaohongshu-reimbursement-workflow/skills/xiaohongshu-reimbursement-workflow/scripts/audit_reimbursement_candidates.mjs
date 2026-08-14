import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertNoMergedChildPayload,
  cellAt,
  cleanError,
  combineControlledRecords,
  digestObject,
  displayContractFailures,
  emitJson,
  excelDateToIso,
  expectedNumberFormat,
  extractControlledSegment,
  formulaEquivalent,
  formulaForGroup,
  layoutFromCombined,
  mergedStylePass,
  normalizeBatchPlan,
  parseCli,
  parseRange,
  preflightWorkbook,
  protectedSheetsEqual,
  readJson,
  readWorkbookMetadata,
  resolvedThemeRole,
  rowHeightFor,
  sha256File,
  stableJson,
  totalNumberFormat,
  workbookPackageIntegrityFailures,
  writeCertificate,
} from "./reimbursement_workbook_common.mjs";
import { assertControlledSegmentReferenceSafety } from "./controlled_segment_dependency_guard.mjs";

function numericValue(cell, field) {
  const value = Number(cell.value);
  if (!Number.isFinite(value)) throw new Error(`${field} must contain a finite numeric value.`);
  return value;
}

function sameAmount(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.0000001;
}

function mergeSet(sheet) {
  return new Set(sheet.merges);
}

function explicitColumnWidth(sheet, column) {
  const number = column.charCodeAt(0) - 64;
  const descriptor = sheet.columns.find((item) => number >= item.min && number <= item.max);
  return descriptor?.width ?? null;
}

function effectiveDateCell(sheet, row) {
  for (const ref of sheet.merges) {
    const range = parseRange(ref);
    if (range.startCol === 1 && range.endCol === 1 && row >= range.startRow && row <= range.endRow) {
      return cellAt(sheet, "A", range.startRow);
    }
  }
  return cellAt(sheet, "A", row);
}

function noVisibleBorder(style) {
  return !Object.values(style.border ?? {}).some(Boolean);
}

function businessStylePass(cell, column, styleContract, surface, { merged = false } = {}) {
  const role = styleContract.roles.businessCell;
  const policy = styleContract.layout.columnPolicies[surface][column];
  const expectedHorizontal = merged ? "center" : policy.horizontalAlignment;
  const expectedWrap = merged ? true : policy.wrapText;
  return cell.style.font?.name === role.font.name &&
    Math.abs((cell.style.font?.size ?? 0) - role.font.sizePoints) <= 0.01 &&
    cell.style.font?.bold === role.font.bold &&
    cell.style.font?.color === role.font.colorArgb &&
    cell.style.fill?.effectiveArgb === role.fillArgb &&
    cell.style.horizontal === expectedHorizontal &&
    ["center", "middle"].includes(cell.style.vertical) &&
    cell.style.wrapText === expectedWrap &&
    !cell.style.shrinkToFit &&
    (role.borderToken !== "none" || noVisibleBorder(cell.style));
}

function auditRows(metadata, sheet, layout, styleContract) {
  const failures = [];
  for (const record of layout.rows) {
    const dateCell = effectiveDateCell(sheet, record.row);
    const actualDate = dateCell.value ? excelDateToIso(dateCell.value, metadata.date1904) : null;
    if (actualDate !== record.date) failures.push(`A${record.row}:date:${actualDate ?? "blank"}!=${record.date ?? "blank"}`);
    if (cellAt(sheet, "B", record.row).value !== record.project) failures.push(`B${record.row}:project`);
    if (!sameAmount(numericValue(cellAt(sheet, "C", record.row), `C${record.row}`), record.amountNumber)) failures.push(`C${record.row}:amount`);
    const expectedFormat = expectedNumberFormat(record.decimals, styleContract);
    if (cellAt(sheet, "C", record.row).style.numberFormat !== expectedFormat) failures.push(`C${record.row}:number-format`);
    for (const column of ["A", "B", "C"]) {
      const styleCell = column === "A" ? effectiveDateCell(sheet, record.row) : cellAt(sheet, column, record.row);
      if (!businessStylePass(styleCell, column, styleContract, "ledgerRoot")) failures.push(`${column}${record.row}:business-style`);
    }
    const height = sheet.rows.get(record.row)?.height;
    if (!(height > 0) || Math.abs(height - rowHeightFor(record)) > 0.25) failures.push(`row${record.row}:explicit-height`);
  }
  return failures;
}

function auditGroup(sheet, group, styleContract) {
  const failures = [];
  const startRow = group.rows[0].row;
  const endRow = group.rows.at(-1).row;
  const expectedFormula = formulaForGroup(startRow, endRow);
  if (!formulaEquivalent(cellAt(sheet, "D", startRow).formula, expectedFormula)) failures.push(`D${startRow}:formula`);
  if (cellAt(sheet, "E", startRow).value !== group.rows[0].person) failures.push(`E${startRow}:person`);
  if (cellAt(sheet, "F", startRow).value !== group.rows[0].classification) failures.push(`F${startRow}:classification`);
  const total = group.rows.reduce((sum, row) => sum + row.amountNumber, 0);
  const cached = cellAt(sheet, "D", startRow).value;
  if (cached !== "" && !sameAmount(cached, total)) failures.push(`D${startRow}:cached-total`);
  const decimals = Math.max(...group.rows.map((row) => row.decimals));
  if (cellAt(sheet, "D", startRow).style.numberFormat !== expectedNumberFormat(decimals, styleContract)) failures.push(`D${startRow}:number-format`);
  for (const column of ["D", "E", "F"]) {
    if (!businessStylePass(cellAt(sheet, column, startRow), column, styleContract, "ledgerRoot", { merged: true })) failures.push(`${column}${startRow}:business-style`);
  }
  const merges = mergeSet(sheet);
  if (endRow > startRow) {
    if (!mergedStylePass(cellAt(sheet, "D", startRow).style) || !mergedStylePass(cellAt(sheet, "E", startRow).style) || !mergedStylePass(cellAt(sheet, "F", startRow).style)) failures.push(`D${startRow}:merged-display`);
    for (const column of ["D", "E", "F"]) {
      if (!merges.has(`${column}${startRow}:${column}${endRow}`)) failures.push(`${column}${startRow}:${column}${endRow}:missing-merge`);
    }
    for (const breakRow of sheet.pageBreakRows) {
      if (breakRow >= startRow && breakRow < endRow) failures.push(`D${startRow}:F${endRow}:manual-page-break-${breakRow}`);
    }
  } else {
    for (const column of ["D", "E", "F"]) {
      if (merges.has(`${column}${startRow}:${column}${endRow}`)) failures.push(`${column}${startRow}:single-row-merge`);
    }
  }
  return failures;
}

function auditDateGroups(sheet, layout) {
  const failures = [];
  const merges = mergeSet(sheet);
  for (const group of layout.dateGroups) {
    const startRow = group.rows[0].row;
    const endRow = group.rows.at(-1).row;
    if (endRow > startRow && !merges.has(`A${startRow}:A${endRow}`)) failures.push(`A${startRow}:A${endRow}:date-merge`);
  }
  return failures;
}

function auditUnexpectedBusinessMerges(sheet, layout) {
  const expected = new Set();
  for (const group of layout.groups) {
    if (group.rows.length <= 1) continue;
    for (const column of ["D", "E", "F"]) expected.add(`${column}${group.rows[0].row}:${column}${group.rows.at(-1).row}`);
  }
  for (const group of layout.dateGroups) {
    if (group.rows.length > 1) expected.add(`A${group.rows[0].row}:A${group.rows.at(-1).row}`);
  }
  const failures = [];
  for (const ref of sheet.merges) {
    const range = parseRange(ref);
    if (range.endRow < layout.rows[0].row || range.startRow > layout.endRow) continue;
    if (range.startCol <= 6 && range.endCol >= 1 && !expected.has(ref)) failures.push(ref);
  }
  return failures;
}

function visualExceptions(sheet, layout, styleContract) {
  const threshold = styleContract.mergeContract.largeMergePreviewThreshold;
  return layout.groups.flatMap((group) => {
    if (group.rows.length <= 1) return [];
    const totalHeightPoints = group.rows.reduce((sum, row) => sum + (sheet.rows.get(row.row)?.height ?? 0), 0);
    if (group.rows.length <= threshold.rowCountGreaterThan && totalHeightPoints <= threshold.totalHeightPointsGreaterThan) return [];
    return [{ kind: "large-vertical-merge", rows: `${group.rows[0].row}:${group.rows.at(-1).row}`, rowCount: group.rows.length, totalHeightPoints, action: threshold.action }];
  });
}

function editableOutsideControlledFailures(baselineSheet, candidateSheet, profile, headerRow, startRow, baselineEndRow, candidateEndRow) {
  const failures = [];
  const controlledEnd = Math.max(baselineEndRow, candidateEndRow);
  const titleRow = profile.config.rootSheet.titleCell ? Number(/\d+$/u.exec(profile.config.rootSheet.titleCell)?.[0]) : null;
  const allowedRow = (row) => row === headerRow || row === titleRow || (row >= startRow && row <= controlledEnd);
  const cellSemantic = (cell) => ({
    value: cell.value,
    formula: cell.formula,
    style: {
      numberFormat: cell.style.numberFormat,
      font: cell.style.font,
      fill: cell.style.fill,
      border: cell.style.border,
      horizontal: cell.style.horizontal,
      vertical: cell.style.vertical,
      wrapText: cell.style.wrapText,
      shrinkToFit: cell.style.shrinkToFit,
    },
  });
  const refs = new Set([...baselineSheet.cells.keys(), ...candidateSheet.cells.keys()]);
  for (const ref of refs) {
    const match = /^([A-Z]+)(\d+)$/u.exec(ref);
    if (!match || parseRange(`${ref}:${ref}`).startCol > 6 || allowedRow(Number(match[2]))) continue;
    if (stableJson(cellSemantic(cellAt(baselineSheet, match[1], Number(match[2])))) !== stableJson(cellSemantic(cellAt(candidateSheet, match[1], Number(match[2]))))) {
      failures.push(`cell:${ref}`);
    }
  }
  const mergeState = (sheet) => {
    const outside = [];
    for (const ref of sheet.merges) {
      const range = parseRange(ref);
      if (range.startCol > 6 || range.endCol < 1) continue;
      const intersects = range.startRow <= controlledEnd && range.endRow >= startRow;
      if (intersects && (range.startRow < startRow || range.endRow > controlledEnd)) outside.push(`CROSSING:${ref}`);
      else if (!intersects && range.startRow !== headerRow && range.startRow !== titleRow) outside.push(ref);
    }
    return outside.sort();
  };
  if (stableJson(mergeState(baselineSheet)) !== stableJson(mergeState(candidateSheet))) failures.push("merges");
  const rowState = (sheet) => [...sheet.rows.entries()]
    .filter(([row]) => !allowedRow(row))
    .sort((left, right) => left[0] - right[0]);
  if (stableJson(rowState(baselineSheet)) !== stableJson(rowState(candidateSheet))) failures.push("rows");
  // Freeze/print metadata on the editable sheet is intentionally normalized
  // by the display contract and is audited independently below.
  if (baselineSheet.relationshipClosureSignature !== candidateSheet.relationshipClosureSignature) failures.push("relationships");
  return failures;
}

function expectedDetail(profile) {
  const people = new Map();
  for (const record of profile.transactions) {
    const companyPaid = record.settlement === "company_paid_no_reimbursement";
    const key = JSON.stringify([companyPaid ? "company-paid" : "employee", record.person]);
    if (!people.has(key)) people.set(key, { person: record.person, companyPaid, records: [] });
    people.get(key).records.push(record);
  }
  const ordered = [...people.values()].sort((a, b) => Number(a.companyPaid) - Number(b.companyPaid) || Math.min(...a.records.map((r) => r.sourceOrder)) - Math.min(...b.records.map((r) => r.sourceOrder)));
  let row = 4;
  const sections = [];
  for (const { person, companyPaid, records } of ordered) {
    const personRow = row++; const headerRow = row++;
    const rows = records.sort((a, b) => a.date.localeCompare(b.date) || a.sourceOrder - b.sourceOrder).map((record) => ({ ...record, row: row++ }));
    const groups = [];
    for (const record of rows) {
      const key = JSON.stringify([record.classification, record.rowType, record.settlement]);
      if (groups.at(-1)?.key === key) groups.at(-1).rows.push(record); else groups.push({ key, rows: [record] });
    }
    const dates = [];
    for (const record of rows) { if (dates.at(-1)?.date === record.date) dates.at(-1).rows.push(record); else dates.push({ date: record.date, rows: [record] }); }
    sections.push({ person, personRow, headerRow, rows, groups, dates, companyPaid, label: companyPaid ? `${person}（对公已付不实报）｜${records.length}笔` : `${person}｜${records.length}笔` });
  }
  return { sections, endRow: row - 1 };
}

async function auditDetail(profile, plan) {
  if (!profile.detailPath) return null;
  const metadata = await readWorkbookMetadata(profile.detailPath);
  if (metadata.sheets.length !== 1 || metadata.sheets[0].name !== "报销明细") throw new Error(`${profile.profileId} detail must contain exactly one 报销明细 sheet.`);
  const sheet = metadata.sheets[0];
  const expected = expectedDetail(profile);
  const failures = [];
  const roleStyle = (cell, roleName, semanticRoleName = roleName) => {
    const expectedRole = resolvedThemeRole(plan.styleContract, profile.config.themeOverride, roleName, semanticRoleName);
    return cell.style.fill?.effectiveArgb === expectedRole.fillArgb &&
      cell.style.font?.name === expectedRole.semanticRole.font.name &&
      Math.abs((cell.style.font?.size ?? 0) - expectedRole.semanticRole.font.sizePoints) <= 0.01 &&
      cell.style.font?.bold === expectedRole.semanticRole.font.bold &&
      cell.style.font?.color === expectedRole.fontColorArgb &&
      ["center", "centerContinuous"].includes(cell.style.horizontal) &&
      ["center", "middle"].includes(cell.style.vertical) &&
      cell.style.wrapText && !cell.style.shrinkToFit &&
      ((expectedRole.semanticRole.borderToken ?? expectedRole.semanticRole.borderPolicy) !== "none" || noVisibleBorder(cell.style));
  };
  const expectedTitle = profile.period ? `${profile.detailTitle}（${profile.period}）` : profile.detailTitle;
  if (cellAt(sheet, "A", 1).value !== expectedTitle || !sheet.merges.includes("A1:F1") || !roleStyle(cellAt(sheet, "A", 1), "title")) failures.push("title");
  const expectedMerges = new Set(["A1:F1", "A2:B2", "C2:D2", "E2:F2"]);
  const allRows = expected.sections.flatMap((section) => section.rows);
  const sumExpression = (rows) => rows.length ? rows.map((record) => `C${record.row}`).join("+") : "0";
  for (const [cell, label, rows] of [["A2", "实报合计", allRows.filter((r) => r.settlement !== "company_paid_no_reimbursement")], ["C2", "对公已付", allRows.filter((r) => r.settlement === "company_paid_no_reimbursement")], ["E2", "费用合计", allRows]]) {
    if (!formulaEquivalent(cellAt(sheet, cell[0], 2).formula, `"${label}："&TEXT(${sumExpression(rows)},"${totalNumberFormat(rows, plan.styleContract)}")`) || !roleStyle(cellAt(sheet, cell[0], 2), "summaryCard")) failures.push(`summary-card:${cell}`);
  }
  for (const section of expected.sections) {
    if (cellAt(sheet, "A", section.personRow).value !== section.label || !sheet.merges.includes(`A${section.personRow}:D${section.personRow}`)) failures.push(`person:${section.personRow}`);
    expectedMerges.add(`A${section.personRow}:D${section.personRow}`);
    if (
      cellAt(sheet, "E", section.personRow).value !== "人员合计" ||
      !formulaEquivalent(cellAt(sheet, "F", section.personRow).formula, `SUM(C${section.rows[0].row}:C${section.rows.at(-1).row})`) ||
      cellAt(sheet, "F", section.personRow).style.numberFormat !== totalNumberFormat(section.rows, plan.styleContract)
    ) failures.push(`person-total:${section.personRow}`);
    const blockRole = section.companyPaid ? "companyPaidBlockHeader" : "personBlockHeader";
    if (["A", "E", "F"].some((column) => !roleStyle(cellAt(sheet, column, section.personRow), blockRole, "personBlockHeader"))) failures.push(`section-style:${section.personRow}`);
    const headers = ["日期", "支出明细", "支出金额", "费用组合计", "费用分类", "结算方式"];
    for (let index = 0; index < headers.length; index += 1) {
      const column = String.fromCharCode(65 + index);
      if (cellAt(sheet, column, section.headerRow).value !== headers[index]) failures.push(`header:${section.headerRow}:${index}`);
      if (!roleStyle(cellAt(sheet, column, section.headerRow), "header")) failures.push(`header-style:${section.headerRow}:${column}`);
    }
    for (const record of section.rows) {
      if (excelDateToIso(effectiveDateCell(sheet, record.row).value, metadata.date1904) !== record.date) failures.push(`date:${record.row}`);
      if (cellAt(sheet, "B", record.row).value !== record.project) failures.push(`project:${record.row}`);
      if (!sameAmount(cellAt(sheet, "C", record.row).value, record.amountNumber)) failures.push(`amount:${record.row}`);
      if (cellAt(sheet, "C", record.row).style.numberFormat !== expectedNumberFormat(record.decimals, plan.styleContract)) failures.push(`precision:${record.row}`);
      for (const column of ["A", "B", "C"]) {
        const styleCell = column === "A" ? effectiveDateCell(sheet, record.row) : cellAt(sheet, column, record.row);
        if (!businessStylePass(styleCell, column, plan.styleContract, "currentDetail")) failures.push(`business-style:${record.row}:${column}`);
      }
      if (!(sheet.rows.get(record.row)?.height > 0)) failures.push(`height:${record.row}`);
    }
    for (const group of section.groups) {
      const start = group.rows[0].row; const end = group.rows.at(-1).row;
      if (!formulaEquivalent(cellAt(sheet, "D", start).formula, formulaForGroup(start, end))) failures.push(`formula:${start}`);
      if (cellAt(sheet, "E", start).value !== group.rows[0].classification) failures.push(`classification:${start}`);
      if (cellAt(sheet, "F", start).value !== group.rows[0].settlementDisplay) failures.push(`settlement:${start}`);
      for (const column of ["D", "E", "F"]) {
        if (!businessStylePass(cellAt(sheet, column, start), column, plan.styleContract, "currentDetail", { merged: true })) failures.push(`business-style:${start}:${column}`);
      }
      if (end > start) for (const column of ["D", "E", "F"]) { const ref = `${column}${start}:${column}${end}`; expectedMerges.add(ref); if (!sheet.merges.includes(ref)) failures.push(`merge:${ref}`); }
      if (end > start && ["D", "E", "F"].some((column) => !mergedStylePass(cellAt(sheet, column, start).style))) failures.push(`merged-display:${start}`);
    }
    for (const date of section.dates) if (date.rows.length > 1) { const ref = `A${date.rows[0].row}:A${date.rows.at(-1).row}`; expectedMerges.add(ref); if (!sheet.merges.includes(ref)) failures.push(`date-merge:${ref}`); }
  }
  for (const ref of sheet.merges) if (!expectedMerges.has(ref)) failures.push(`unexpected-merge:${ref}`);
  const widths = plan.styleContract.layout.columnWidths.currentDetail;
  for (const column of ["A", "B", "C", "D", "E", "F"]) {
    const actual = explicitColumnWidth(sheet, column);
    if (!(actual > 0) || Math.abs(actual - widths[column]) > 0.05) failures.push(`column-width:${column}`);
  }
  failures.push(...displayContractFailures(metadata, sheet, expected.sections[0]?.headerRow ?? 1, expected.endRow).map((failure) => `display-contract:${failure}`));
  failures.push(...assertNoMergedChildPayload(sheet, [...expectedMerges]).map((ref) => `child-payload:${ref}`));
  if (failures.length) throw new Error(`${profile.profileId} independent detail audit failed: ${failures.join(", ")}`);
  return { detailPath: profile.detailPath, detailSha256: metadata.bytesSha256, detailPersonCount: expected.sections.length, detailTransactionCount: profile.transactions.length, detailAuditDigest: digestObject({ detailPath: profile.detailPath, detailSha256: metadata.bytesSha256, profileId: profile.profileId, transactionCount: profile.transactions.length }) };
}

async function auditProfile(plan, profileId) {
  const profile = plan.profiles[profileId];
  const potentialSidecars = [`${profile.baselinePath}.inspect.ndjson`, `${profile.candidatePath}.inspect.ndjson`];
  const preexistingSidecars = new Set((await Promise.all(potentialSidecars.map(async (filePath) => {
    try { await fs.access(filePath); return filePath; } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean));
  let baselineMeta;
  let candidateMeta;
  try {
    [baselineMeta, candidateMeta] = await Promise.all([
      readWorkbookMetadata(profile.baselinePath),
      readWorkbookMetadata(profile.candidatePath),
    ]);
  } finally {
    await Promise.all(potentialSidecars.filter((filePath) => !preexistingSidecars.has(filePath)).map((filePath) => fs.unlink(filePath).catch((error) => { if (error?.code !== "ENOENT") throw error; })));
  }
  const baselineHash = await sha256File(profile.baselinePath);
  const candidateHash = await sha256File(profile.candidatePath);
  if (baselineHash !== baselineMeta.bytesSha256 || candidateHash !== candidateMeta.bytesSha256) throw new Error(`${profileId} workbook bytes changed during audit.`);
  const baselinePreflight = preflightWorkbook(baselineMeta, profile, plan.styleContract);
  if (baselinePreflight.blocking.length) throw new Error(`${profileId} baseline drifted before independent audit.`);
  const candidateResolved = preflightWorkbook(candidateMeta, profile, plan.styleContract);
  const sheet = candidateResolved.sheet;
  const segment = extractControlledSegment(baselineMeta, profile, baselinePreflight);
  const combined = combineControlledRecords(segment, profile);
  const layout = layoutFromCombined(combined, segment.startRow);
  await assertControlledSegmentReferenceSafety({
    metadata: baselineMeta,
    editableSheet: baselinePreflight.sheet,
    startRow: segment.startRow,
    endRow: Math.max(segment.endRow, layout.endRow),
    profileId,
  });

  const rowFailures = auditRows(candidateMeta, sheet, layout, plan.styleContract);
  const groupFailures = layout.groups.flatMap((group) => auditGroup(sheet, group, plan.styleContract));
  const dateFailures = auditDateGroups(sheet, layout);
  const unexpectedMerges = auditUnexpectedBusinessMerges(sheet, layout);
  const relevantMerges = sheet.merges.filter((ref) => {
    const range = parseRange(ref);
    return range.startRow >= layout.rows[0].row && range.endRow <= layout.endRow && range.startCol <= 6;
  });
  const childPayload = assertNoMergedChildPayload(sheet, relevantMerges);
  const protectedFailures = protectedSheetsEqual(baselineMeta, candidateMeta, sheet.name);
  const packageFailures = workbookPackageIntegrityFailures(baselineMeta, candidateMeta, sheet.name);
  const baselineEditable = baselinePreflight.sheet;
  const outsideFailures = editableOutsideControlledFailures(
    baselineEditable,
    sheet,
    profile,
    candidateResolved.headerRow,
    segment.startRow,
    segment.endRow,
    layout.endRow,
  );
  const columnFailures = ["A", "B", "C", "D", "E", "F"].filter((column) => !(explicitColumnWidth(sheet, column) > 0));
  const displayFailures = displayContractFailures(candidateMeta, sheet, candidateResolved.headerRow, layout.endRow);
  const failures = [
    ...candidateResolved.issues.map((issue) => `candidate-preflight:${issue.level}:${issue.code}:${JSON.stringify(issue.actual ?? {})}`),
    ...rowFailures,
    ...groupFailures,
    ...dateFailures,
    ...unexpectedMerges.map((ref) => `unexpected-merge:${ref}`),
    ...childPayload.map((ref) => `merged-child-payload:${ref}`),
    ...protectedFailures.map((name) => `protected-sheet-changed:${name}`),
    ...packageFailures.map((name) => `package-integrity:${name}`),
    ...outsideFailures.map((name) => `editable-outside-controlled-changed:${name}`),
    ...columnFailures.map((column) => `missing-explicit-width:${column}`),
    ...displayFailures.map((failure) => `display-contract:${failure}`),
  ];
  if (failures.length) throw new Error(`${profileId} independent workbook audit failed: ${failures.join(", ")}`);

  const detailAudit = await auditDetail(profile, plan);

  const certificateCore = {
    ok: true,
    profileId,
    baselinePath: profile.baselinePath,
    baselineSha256: baselineHash,
    candidatePath: profile.candidatePath,
    candidateSha256: candidateHash,
    sheetName: sheet.name,
    headerRow: candidateResolved.headerRow,
    controlledStartRow: layout.rows[0].row,
    controlledEndRow: layout.endRow,
    candidateRevision: profile.candidateRevision,
    baselineRecordCount: combined.baselineRecordCount,
    batchRecordCount: combined.batchRecordCount,
    transactionCount: layout.rows.length,
    groupCount: layout.groups.length,
    expectedMultisetDigest: combined.expectedMultisetDigest,
    protectedSheetCount: candidateMeta.sheets.length - 1,
    planDigest: plan.planDigest,
    styleContractDigest: plan.styleContractDigest,
    profileConfigDigest: plan.profileConfigDigest,
    visualExceptions: visualExceptions(sheet, layout, plan.styleContract),
    ...detailAudit,
  };
  return { ...certificateCore, auditDigest: digestObject(certificateCore) };
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

export function validateAuditCertificate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.ok !== true) throw new Error("Audit certificate must be an ok:true object.");
  for (const field of ["profileId", "baselinePath", "baselineSha256", "candidatePath", "candidateSha256", "planDigest", "styleContractDigest", "profileConfigDigest", "auditDigest"]) {
    if (typeof raw[field] !== "string" || !raw[field]) throw new Error(`Audit certificate.${field} is required.`);
  }
  const { auditDigest, ...core } = raw;
  if (digestObject(core) !== auditDigest) throw new Error("Audit certificate auditDigest does not match canonical content.");
  return raw;
}

export async function auditReimbursementCandidates(rawRequest) {
  const plan = await normalizeBatchPlan(rawRequest);
  const profiles = await mapLimit(plan.affectedProfiles, 2, (profileId) => auditProfile(plan, profileId));
  for (const certificate of profiles) validateAuditCertificate(certificate);
  const core = {
    ok: true,
    mode: "reimbursement-candidate-audit",
    version: 1,
    batchId: plan.batchId,
    affectedProfiles: plan.affectedProfiles,
    planDigest: plan.planDigest,
    styleContractDigest: plan.styleContractDigest,
    profileConfigDigest: plan.profileConfigDigest,
    profiles,
  };
  return { ...core, auditDigest: digestObject(core) };
}

async function main() {
  try {
    const cli = parseCli(process.argv.slice(2));
    const raw = await readJson(cli.input, "candidate audit request");
    const result = await auditReimbursementCandidates(raw);
    await writeCertificate(cli.output, result);
    emitJson(result);
  } catch (error) {
    emitJson({ ok: false, mode: "reimbursement-candidate-audit", error: cleanError(error) }, { failure: true });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
