import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanError,
  applyWorkbookDisplayContract,
  canonicalTitleForProfile,
  combineControlledRecords,
  digestObject,
  emitJson,
  expectedNumberFormat,
  extractControlledSegment,
  exportWorkbook,
  formulaForGroup,
  layoutFromCombined,
  normalizeBatchPlan,
  openWorkbook,
  packages,
  parseCli,
  preflightWorkbook,
  readJson,
  readWorkbookMetadata,
  resolvedThemeRole,
  restoreProtectedSheetParts,
  rowHeightFor,
  sha256File,
  stripMergedChildCells,
  totalNumberFormat,
  writeCertificate,
} from "./reimbursement_workbook_common.mjs";
import { assertControlledSegmentReferenceSafety } from "./controlled_segment_dependency_guard.mjs";

function ensureOutputDoesNotExist(filePath) {
  return fs.access(filePath).then(
    () => { throw new Error(`Candidate already exists; refusing to overwrite: ${filePath}`); },
    (error) => { if (error?.code !== "ENOENT") throw error; },
  );
}

async function assertRegularFile(filePath, field) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-link file.`);
}

function visualExceptions(layout, heights, styleContract) {
  const threshold = styleContract.mergeContract.largeMergePreviewThreshold;
  return layout.groups.flatMap((group) => {
    if (group.rows.length <= 1) return [];
    const totalHeightPoints = group.rows.reduce((sum, row) => sum + heights.get(row.row), 0);
    if (group.rows.length <= threshold.rowCountGreaterThan && totalHeightPoints <= threshold.totalHeightPointsGreaterThan) return [];
    return [{
      kind: "large-vertical-merge",
      rows: `${group.rows[0].row}:${group.rows.at(-1).row}`,
      rowCount: group.rows.length,
      totalHeightPoints,
      action: threshold.action,
    }];
  });
}

function detailPlan(profile) {
  const people = new Map();
  for (const record of profile.transactions) {
    const companyPaid = record.settlement === "company_paid_no_reimbursement";
    const key = JSON.stringify([companyPaid ? "company-paid" : "employee", record.person]);
    if (!people.has(key)) people.set(key, { person: record.person, companyPaid, records: [] });
    people.get(key).records.push(record);
  }
  const orderedPeople = [...people.values()].sort((a, b) => {
    return Number(a.companyPaid) - Number(b.companyPaid) || Math.min(...a.records.map((r) => r.sourceOrder)) - Math.min(...b.records.map((r) => r.sourceOrder));
  });
  let row = 4;
  const sections = [];
  for (const { person, companyPaid, records } of orderedPeople) {
    const personRow = row++;
    const headerRow = row++;
    const rows = records.sort((a, b) => a.date.localeCompare(b.date) || a.sourceOrder - b.sourceOrder).map((record) => ({ ...record, row: row++ }));
    const groups = [];
    for (const record of rows) {
      const key = JSON.stringify([record.classification, record.rowType, record.settlement]);
      const last = groups.at(-1);
      if (last?.key === key) last.rows.push(record);
      else groups.push({ key, rows: [record] });
    }
    const dateGroups = [];
    for (const record of rows) {
      const last = dateGroups.at(-1);
      if (last?.date === record.date) last.rows.push(record);
      else dateGroups.push({ date: record.date, rows: [record] });
    }
    sections.push({ person, personRow, headerRow, rows, groups, dateGroups, companyPaid, label: companyPaid ? `${person}（对公已付不实报）｜${records.length}笔` : `${person}｜${records.length}笔` });
  }
  return { sections, endRow: row - 1 };
}

async function buildDetail(profile, plan) {
  if (!profile.detailPath) return null;
  await ensureOutputDoesNotExist(profile.detailPath);
  const { artifact } = await packages();
  const workbook = artifact.Workbook.create();
  const sheet = workbook.worksheets.add("报销明细");
  const detail = detailPlan(profile);
  const widths = plan.styleContract.layout.columnWidths.currentDetail;
  const policies = plan.styleContract.layout.columnPolicies.currentDetail;
  const role = plan.styleContract.roles.businessCell;
  const themed = (roleName, semanticRoleName = roleName) => {
    const { semanticRole, fillArgb, fontColorArgb } = resolvedThemeRole(plan.styleContract, profile.config.themeOverride, roleName, semanticRoleName);
    return ({
    horizontalAlignment: semanticRole.horizontalAlignment,
    verticalAlignment: semanticRole.verticalAlignment,
    wrapText: semanticRole.wrapText,
    shrinkToFit: semanticRole.shrinkToFit,
    fill: `#${fillArgb.slice(-6)}`,
    font: { name: semanticRole.font.name, size: semanticRole.font.sizePoints, bold: semanticRole.font.bold, color: `#${fontColorArgb.slice(-6)}` },
    rowHeight: semanticRole.rowHeightPoints,
    });
  };
  for (const column of ["A", "B", "C", "D", "E", "F"]) {
    sheet.getRange(`${column}1:${column}${detail.endRow}`).format.columnWidth = widths[column];
  }
  sheet.mergeCells("A1:F1");
  sheet.getRange("A1").values = [[profile.period ? `${profile.detailTitle}（${profile.period}）` : profile.detailTitle]];
  sheet.getRange("A1:F1").format = themed("title");
  for (const ref of ["A2:B2", "C2:D2", "E2:F2"]) sheet.mergeCells(ref);
  const allRows = detail.sections.flatMap((section) => section.rows);
  const realRows = allRows.filter((record) => record.settlement !== "company_paid_no_reimbursement");
  const companyRows = allRows.filter((record) => record.settlement === "company_paid_no_reimbursement");
  const sumExpression = (rows) => rows.length ? rows.map((record) => `C${record.row}`).join("+") : "0";
  for (const [cell, label, rows] of [["A2", "实报合计", realRows], ["C2", "对公已付", companyRows], ["E2", "费用合计", allRows]]) {
    sheet.getRange(cell).formulas = [[`="${label}："&TEXT(${sumExpression(rows)},"${totalNumberFormat(rows, plan.styleContract)}")`]];
    sheet.getRange(cell).format = themed("summaryCard");
  }
  for (const section of detail.sections) {
    sheet.mergeCells(`A${section.personRow}:D${section.personRow}`);
    sheet.getRange(`A${section.personRow}`).values = [[section.label]];
    sheet.getRange(`E${section.personRow}`).values = [["人员合计"]];
    sheet.getRange(`F${section.personRow}`).formulas = [[`=SUM(C${section.rows[0].row}:C${section.rows.at(-1).row})`]];
    sheet.getRange(`F${section.personRow}`).format.numberFormat = totalNumberFormat(section.rows, plan.styleContract);
    sheet.getRange(`A${section.personRow}:F${section.personRow}`).format = themed(section.companyPaid ? "companyPaidBlockHeader" : "personBlockHeader", "personBlockHeader");
    sheet.getRange(`A${section.headerRow}:F${section.headerRow}`).values = [["日期", "支出明细", "支出金额", "费用组合计", "费用分类", "结算方式"]];
    sheet.getRange(`A${section.headerRow}:F${section.headerRow}`).format = themed("header");
    for (const record of section.rows) {
      sheet.getRange(`A${record.row}:C${record.row}`).values = [[new Date(`${record.date}T00:00:00Z`), record.project, record.amountNumber]];
      const range = sheet.getRange(`A${record.row}:F${record.row}`);
      range.format = {
        font: {
          name: role.font.name,
          size: role.font.sizePoints,
          bold: role.font.bold,
          color: `#${role.font.colorArgb.slice(-6)}`,
        },
        fill: `#${role.fillArgb.slice(-6)}`,
        verticalAlignment: role.verticalAlignment,
        shrinkToFit: role.shrinkToFit,
        rowHeight: rowHeightFor(record),
      };
      for (const column of ["A", "B", "C", "D", "E", "F"]) {
        sheet.getRange(`${column}${record.row}`).format.horizontalAlignment = policies[column].horizontalAlignment;
        sheet.getRange(`${column}${record.row}`).format.wrapText = policies[column].wrapText;
      }
      sheet.getRange(`A${record.row}`).format.numberFormat = plan.styleContract.numberFormats.date;
      sheet.getRange(`C${record.row}`).format.numberFormat = expectedNumberFormat(record.decimals, plan.styleContract);
    }
    for (const group of section.groups) {
      const start = group.rows[0].row;
      const end = group.rows.at(-1).row;
      sheet.getRange(`D${start}`).formulas = [[`=${formulaForGroup(start, end)}`]];
      sheet.getRange(`D${start}`).format.numberFormat = expectedNumberFormat(Math.max(...group.rows.map((r) => r.decimals)), plan.styleContract);
      sheet.getRange(`E${start}`).values = [[group.rows[0].classification]];
      sheet.getRange(`F${start}`).values = [[group.rows[0].settlementDisplay]];
      if (end > start) for (const column of ["D", "E", "F"]) { clearChildren(sheet, column, start, end); sheet.mergeCells(`${column}${start}:${column}${end}`); }
      sheet.getRange(`D${start}:F${start}`).format = { horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, shrinkToFit: false };
    }
    for (const dateGroup of section.dateGroups) if (dateGroup.rows.length > 1) {
      const start = dateGroup.rows[0].row; const end = dateGroup.rows.at(-1).row;
      clearChildren(sheet, "A", start, end); sheet.mergeCells(`A${start}:A${end}`);
      sheet.getRange(`A${start}`).format = { horizontalAlignment: "center", verticalAlignment: "center", wrapText: false, shrinkToFit: false };
    }
  }
  const tempPath = path.join(path.dirname(profile.detailPath), `.${path.basename(profile.detailPath)}.${crypto.randomUUID()}.tmp.xlsx`);
  const sidecars = [`${tempPath}.inspect.ndjson`, `${profile.detailPath}.inspect.ndjson`];
  let created = false;
  try {
    await exportWorkbook(workbook, tempPath);
    await stripMergedChildCells(tempPath, "报销明细");
    await applyWorkbookDisplayContract(tempPath, "报销明细", detail.sections[0]?.headerRow ?? 1, detail.endRow);
    await fs.copyFile(tempPath, profile.detailPath, fs.constants.COPYFILE_EXCL);
    created = true;
    return { detailPath: profile.detailPath, detailSha256: await sha256File(profile.detailPath), personCount: detail.sections.length, detailRowCount: profile.transactions.length };
  } catch (error) {
    if (created) await fs.unlink(profile.detailPath).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    await Promise.all(sidecars.map((filePath) => fs.unlink(filePath).catch((error) => { if (error?.code !== "ENOENT") throw error; })));
  }
}

function clearChildren(sheet, column, startRow, endRow) {
  for (let row = startRow + 1; row <= endRow; row += 1) {
    sheet.getRange(`${column}${row}`).clear({ applyTo: "contents" });
  }
}

function applyBusinessFormatting(sheet, layout, styleContract) {
  const dateFormat = styleContract.numberFormats.date;
  const widths = styleContract.layout.columnWidths.ledgerRoot;
  const policy = styleContract.layout.columnPolicies.ledgerRoot;
  const role = styleContract.roles.businessCell;
  const border = role.borderToken === "grid" ? styleContract.tokens.borders.grid : null;
  for (const column of ["A", "B", "C", "D", "E", "F"]) {
    const range = sheet.getRange(`${column}${layout.rows[0].row}:${column}${layout.endRow}`);
    range.format.columnWidth = widths[column];
    range.format.horizontalAlignment = policy[column].horizontalAlignment;
    range.format.verticalAlignment = role.verticalAlignment;
    range.format.wrapText = policy[column].wrapText;
    range.format.shrinkToFit = role.shrinkToFit;
    range.format.font = { name: role.font.name, size: role.font.sizePoints, bold: role.font.bold, color: `#${role.font.colorArgb.slice(-6)}` };
    range.format.fill = `#${role.fillArgb.slice(-6)}`;
    if (border) range.format.borders = {
      left: { style: border.left, color: `#${border.colorArgb.slice(-6)}` }, right: { style: border.right, color: `#${border.colorArgb.slice(-6)}` },
      top: { style: border.top, color: `#${border.colorArgb.slice(-6)}` }, bottom: { style: border.bottom, color: `#${border.colorArgb.slice(-6)}` },
    };
  }
  for (const record of layout.rows) {
    const rowRange = sheet.getRange(`A${record.row}:F${record.row}`);
    rowRange.format.rowHeight = rowHeightFor(record);
    sheet.getRange(`A${record.row}`).format.horizontalAlignment = "center";
    sheet.getRange(`A${record.row}`).format.numberFormat = dateFormat;
    sheet.getRange(`C${record.row}`).format.numberFormat = expectedNumberFormat(record.decimals, styleContract);
  }
}

function applyHeaderContract(sheet, headerRow, profile, styleContract) {
  const role = styleContract.roles.ledgerRootHeader ?? styleContract.roles.header;
  const themed = resolvedThemeRole(styleContract, profile.config.themeOverride, "header", styleContract.roles.ledgerRootHeader ? "ledgerRootHeader" : "header");
  const range = sheet.getRange(`A${headerRow}:F${headerRow}`);
  const format = {
    horizontalAlignment: role.horizontalAlignment,
    verticalAlignment: role.verticalAlignment,
    wrapText: role.wrapText,
    shrinkToFit: role.shrinkToFit,
    fill: `#${themed.fillArgb.slice(-6)}`,
    font: { name: role.font.name, size: role.font.sizePoints, bold: role.font.bold, color: `#${themed.fontColorArgb.slice(-6)}` },
    rowHeight: role.rowHeightPoints,
  };
  const borderPolicy = role.borderPolicy ?? role.borderToken;
  if (borderPolicy === "grid") {
    const border = styleContract.tokens.borders.grid;
    format.borders = {
      left: { style: border.left, color: `#${border.colorArgb.slice(-6)}` }, right: { style: border.right, color: `#${border.colorArgb.slice(-6)}` },
      top: { style: border.top, color: `#${border.colorArgb.slice(-6)}` }, bottom: { style: border.bottom, color: `#${border.colorArgb.slice(-6)}` },
    };
  }
  range.format = format;
}

function applyFormalTitle(sheet, profile, styleContract) {
  const { titleCell } = profile.config.rootSheet;
  const canonicalTitle = canonicalTitleForProfile(profile);
  if (!titleCell && !canonicalTitle) return;
  if (!titleCell || !canonicalTitle) throw new Error(`${profile.profileId} titleCell/canonicalTitle must be configured together.`);
  sheet.getRange(titleCell).values = [[canonicalTitle]];
  const row = /\d+$/u.exec(titleCell)?.[0];
  if (!row) throw new Error(`${profile.profileId} titleCell is invalid.`);
  const themed = resolvedThemeRole(styleContract, profile.config.themeOverride, "title");
  sheet.getRange(`A${row}:F${row}`).format = {
    horizontalAlignment: themed.semanticRole.horizontalAlignment,
    verticalAlignment: themed.semanticRole.verticalAlignment,
    wrapText: themed.semanticRole.wrapText,
    shrinkToFit: themed.semanticRole.shrinkToFit,
    fill: `#${themed.fillArgb.slice(-6)}`,
    font: {
      name: themed.semanticRole.font.name,
      size: themed.semanticRole.font.sizePoints,
      bold: themed.semanticRole.font.bold,
      color: `#${themed.fontColorArgb.slice(-6)}`,
    },
    rowHeight: themed.semanticRole.rowHeightPoints,
  };
  const forbidden = styleContract.layout.formalTitleForbiddenTokens;
  if (forbidden.some((token) => canonicalTitle.includes(token))) throw new Error(`${profile.profileId} canonicalTitle contains a forbidden status token.`);
}

function writeLayout(sheet, layout, styleContract) {
  for (const record of layout.rows) {
    sheet.getRange(`A${record.row}:F${record.row}`).clear({ applyTo: "contents" });
    sheet.getRange(`A${record.row}:C${record.row}`).values = [[
      record.date === null ? null : new Date(`${record.date}T00:00:00Z`),
      record.project,
      record.amountNumber,
    ]];
  }
  applyBusinessFormatting(sheet, layout, styleContract);

  for (const group of layout.groups) {
    const startRow = group.rows[0].row;
    const endRow = group.rows.at(-1).row;
    const totalDecimals = Math.max(...group.rows.map((row) => row.decimals));
    sheet.getRange(`D${startRow}`).formulas = [[`=${formulaForGroup(startRow, endRow)}`]];
    sheet.getRange(`D${startRow}`).format.numberFormat = expectedNumberFormat(totalDecimals, styleContract);
    sheet.getRange(`E${startRow}`).values = [[group.rows[0].person]];
    sheet.getRange(`F${startRow}`).values = [[group.rows[0].classification]];
    if (endRow > startRow) {
      for (const column of ["D", "E", "F"]) {
        clearChildren(sheet, column, startRow, endRow);
        sheet.mergeCells(`${column}${startRow}:${column}${endRow}`);
      }
    }
    const anchor = sheet.getRange(`D${startRow}:F${startRow}`);
    anchor.format.horizontalAlignment = "center";
    anchor.format.verticalAlignment = "center";
    anchor.format.wrapText = true;
    anchor.format.shrinkToFit = false;
    if (styleContract.roles.businessCell.borderToken === "grid") {
      sheet.getRange(`A${endRow}:F${endRow}`).format.borders = { bottom: { style: "medium", color: "#808080" } };
    }
  }

  for (const dateGroup of layout.dateGroups) {
    if (dateGroup.rows.length <= 1) continue;
    const startRow = dateGroup.rows[0].row;
    const endRow = dateGroup.rows.at(-1).row;
    clearChildren(sheet, "A", startRow, endRow);
    sheet.mergeCells(`A${startRow}:A${endRow}`);
    const anchor = sheet.getRange(`A${startRow}`);
    anchor.format.horizontalAlignment = "center";
    anchor.format.verticalAlignment = "center";
    anchor.format.wrapText = false;
    anchor.format.shrinkToFit = false;
  }
}

async function buildProfile(plan, profileId) {
  const profile = plan.profiles[profileId];
  await Promise.all([
    assertRegularFile(profile.baselinePath, `${profileId}.baselinePath`),
    ensureOutputDoesNotExist(profile.candidatePath),
  ]);
  const baselineHashBefore = await sha256File(profile.baselinePath);
  const baselineMeta = await readWorkbookMetadata(profile.baselinePath);
  const preflight = preflightWorkbook(baselineMeta, profile, plan.styleContract);
  if (preflight.blocking.length) {
    const summary = preflight.blocking.map((issue) => `${issue.level}:${issue.code}`).join(", ");
    throw new Error(`${profileId} workbook drift blocks candidate construction: ${summary}`);
  }
  const segment = extractControlledSegment(baselineMeta, profile, preflight);
  const combined = combineControlledRecords(segment, profile);
  const layout = layoutFromCombined(combined, segment.startRow);
  await assertControlledSegmentReferenceSafety({
    metadata: baselineMeta,
    editableSheet: preflight.sheet,
    startRow: segment.startRow,
    endRow: Math.max(segment.endRow, layout.endRow),
    profileId,
  });
  const workbook = await openWorkbook(profile.baselinePath);
  const sheet = workbook.worksheets.getItem(preflight.sheet.name);
  if (!sheet) throw new Error(`Artifact workbook cannot resolve editable sheet: ${preflight.sheet.name}`);
  applyHeaderContract(sheet, preflight.headerRow, profile, plan.styleContract);
  applyFormalTitle(sheet, profile, plan.styleContract);
  const clearEnd = Math.max(segment.endRow, layout.endRow);
  for (const ref of preflight.sheet.merges) {
    const range = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/u.exec(ref);
    if (!range) continue;
    const startRow = Number(range[2]);
    const endRow = Number(range[4]);
    if (endRow < segment.startRow || startRow > segment.endRow) continue;
    sheet.unmergeCells(ref);
  }
  if (clearEnd >= segment.startRow) sheet.getRange(`A${segment.startRow}:F${clearEnd}`).clear({ applyTo: "contents" });
  for (let row = segment.endRow + 1; row <= layout.endRow; row += 1) {
    for (const column of ["A", "B", "C", "D", "E", "F"]) {
      const existing = preflight.sheet.cells.get(`${column}${row}`);
      if (existing?.hasPayload) throw new Error(`${profileId} rebuild would overwrite out-of-segment content at ${column}${row}.`);
    }
  }
  writeLayout(sheet, layout, plan.styleContract);

  const outputDirectory = path.dirname(profile.candidatePath);
  const outputStat = await fs.stat(outputDirectory);
  if (!outputStat.isDirectory()) throw new Error(`${profileId} candidate parent must be an existing directory.`);
  const tempPath = path.join(outputDirectory, `.${path.basename(profile.candidatePath)}.${crypto.randomUUID()}.tmp.xlsx`);
  const potentialSidecars = [
    `${profile.baselinePath}.inspect.ndjson`,
    `${profile.candidatePath}.inspect.ndjson`,
    `${tempPath}.inspect.ndjson`,
  ];
  const preexistingSidecars = new Set((await Promise.all(potentialSidecars.map(async (filePath) => {
    try { await fs.access(filePath); return filePath; } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }))).filter(Boolean));
  let promoted = false;
  try {
    await exportWorkbook(workbook, tempPath);
    await restoreProtectedSheetParts(profile.baselinePath, tempPath, preflight.sheet.name);
    await stripMergedChildCells(tempPath, preflight.sheet.name);
    await applyWorkbookDisplayContract(tempPath, preflight.sheet.name, preflight.headerRow, layout.endRow);
    if (await sha256File(profile.baselinePath) !== baselineHashBefore) throw new Error(`${profileId} baseline changed during construction.`);
    await fs.copyFile(tempPath, profile.candidatePath, fs.constants.COPYFILE_EXCL);
    promoted = true;
    const candidateSha256 = await sha256File(profile.candidatePath);
    const heights = new Map(layout.rows.map((row) => [row.row, rowHeightFor(row)]));
    const detailResult = await buildDetail(profile, plan);
    return {
      profileId,
      baselinePath: profile.baselinePath,
      baselineSha256: baselineHashBefore,
      candidatePath: profile.candidatePath,
      candidateSha256,
      sheetName: preflight.sheet.name,
      headerRow: preflight.headerRow,
      controlledStartRow: layout.rows[0].row,
      controlledEndRow: layout.endRow,
      candidateRevision: profile.candidateRevision,
      baselineRecordCount: combined.baselineRecordCount,
      batchRecordCount: combined.batchRecordCount,
      transactionCount: layout.rows.length,
      groupCount: layout.groups.length,
      expectedMultisetDigest: combined.expectedMultisetDigest,
      planDigest: plan.planDigest,
      styleContractDigest: plan.styleContractDigest,
      profileConfigDigest: plan.profileConfigDigest,
      preflightIssues: preflight.issues,
      repairActions: preflight.issues.map((issue) => `${issue.level}:${issue.code}`),
      visualExceptions: visualExceptions(layout, heights, plan.styleContract),
      ...detailResult,
    };
  } catch (error) {
    if (promoted) await fs.unlink(profile.candidatePath).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    await Promise.all(potentialSidecars.filter((filePath) => !preexistingSidecars.has(filePath)).map((filePath) => fs.unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    })));
  }
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

export async function buildReimbursementCandidates(rawPlan) {
  const plan = await normalizeBatchPlan(rawPlan);
  const settled = await Promise.allSettled(plan.affectedProfiles.map((profileId) => buildProfile(plan, profileId)));
  const failure = settled.find((item) => item.status === "rejected");
  if (failure) {
    await Promise.all(settled.filter((item) => item.status === "fulfilled").flatMap((item) => [item.value.candidatePath, item.value.detailPath].filter(Boolean)).map((filePath) => fs.unlink(filePath).catch((error) => { if (error?.code !== "ENOENT") throw error; })));
    throw failure.reason;
  }
  const profiles = settled.map((item) => item.value);
  const payload = {
    ok: true,
    mode: "reimbursement-candidate-build",
    version: 1,
    batchId: plan.batchId,
    affectedProfiles: plan.affectedProfiles,
    planDigest: plan.planDigest,
    styleContractDigest: plan.styleContractDigest,
    profileConfigDigest: plan.profileConfigDigest,
    profiles,
  };
  return { ...payload, buildDigest: digestObject(payload) };
}

async function main() {
  try {
    const cli = parseCli(process.argv.slice(2));
    const rawPlan = await readJson(cli.input, "candidate build plan");
    const result = await buildReimbursementCandidates(rawPlan);
    await writeCertificate(cli.output, result);
    emitJson(result);
  } catch (error) {
    emitJson({ ok: false, mode: "reimbursement-candidate-build", error: cleanError(error) }, { failure: true });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
