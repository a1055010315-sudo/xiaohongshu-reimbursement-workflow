import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import JSZip from "jszip";

import { auditReimbursementCandidates } from "../scripts/audit_reimbursement_candidates.mjs";
import { buildReimbursementCandidates } from "../scripts/build_reimbursement_candidates.mjs";
import { loadContracts, readWorkbookMetadata, cellAt, excelDateToIso } from "../scripts/reimbursement_workbook_common.mjs";

let tempRoot;

async function makeBaseline({ mutateHeader = false, protectedText = "protected-original", protectedBold = false, blankProject = false, blankDate = false, headerOnly = false, headerRow = 1, sheetName = "Sheet1", extraHeader = false } = {}) {
  const { profileConfig, styleContract } = await loadContracts();
  const profile = profileConfig.profiles.xiaohongshu;
  const profileRoot = path.join(tempRoot, profileConfig.profileDirectories.xiaohongshu);
  await fs.mkdir(profileRoot);
  const baselinePath = path.join(profileRoot, profile.rootWorkbookNames[0]);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(sheetName);
  const protectedSheet = workbook.worksheets.add("Protected");
  const header = [...profile.rootSheet.headerFingerprints[0]];
  if (mutateHeader) header.splice(3, 1);
  sheet.getRange(`A${headerRow}:${mutateHeader ? "E" : "F"}${headerRow}`).values = [header];
  if (extraHeader) sheet.getRange(`G${headerRow}`).values = [["未经授权的新字段"]];
  const widths = styleContract.layout.columnWidths.ledgerRoot;
  for (const column of ["A", "B", "C", "D", "E", "F"]) sheet.getRange(`${column}1`).format.columnWidth = widths[column];
  sheet.getRange(`A${headerRow}:F${headerRow}`).format = { horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, shrinkToFit: false };
  if (!headerOnly) {
    sheet.getRange("A2:F2").values = [[blankDate ? null : new Date("2026-07-24T00:00:00Z"), blankProject ? null : "旧7月24日", 24, null, "匿名人员", "运营开支"]];
    sheet.getRange("D2").formulas = [["=SUM(C2:C2)"]];
    sheet.getRange("A2:F2").format.rowHeight = 30;
    sheet.getRange("C2:D2").format.numberFormat = "0";
    sheet.getRange("A2").format.numberFormat = styleContract.numberFormats.date;
  }
  protectedSheet.getRange("A1").values = [[protectedText]];
  if (protectedBold) protectedSheet.getRange("A1").format.font = { bold: true };
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(baselinePath);
  await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return baselinePath;
}

function planFor(baselinePath, candidateName = "candidate.xlsx") {
  return {
    version: 1,
    batchId: "anonymous-controlled-segment",
    affectedProfiles: ["xhs"],
    profiles: {
      xhs: {
        baselinePath,
        candidatePath: path.join(tempRoot, candidateName),
        candidateRevision: 2,
        controlledSegment: { startDate: "2026-06-01" },
        transactions: [{
          id: "NEW-0703",
          sourceOrder: 1,
          date: "2026-07-03",
          project: "新7月3日",
          amount: "3.25",
          person: "匿名人员",
          classification: "运营开支",
          rowType: "expense",
          settlement: "employee_reimbursement",
        }],
      },
    },
  };
}

async function addProtectedPrintFeatures(workbookPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(workbookPath));
  const part = "xl/worksheets/sheet2.xml";
  const xml = await zip.file(part)?.async("string");
  assert.ok(xml);
  zip.file(part, xml.replace(
    /<\/worksheet>\s*$/u,
    '<pageMargins left="0.33" right="0.34" top="0.35" bottom="0.36" header="0.1" footer="0.1"/><pageSetup orientation="landscape" paperSize="9"/></worksheet>',
  ));
  await fs.writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function rewriteWorkbookZip(workbookPath, mutate) {
  const zip = await JSZip.loadAsync(await fs.readFile(workbookPath));
  await mutate(zip);
  await fs.writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function addProtectedIntegrityFeatures(workbookPath) {
  await rewriteWorkbookZip(workbookPath, async (zip) => {
    const sheetPath = "xl/worksheets/sheet2.xml";
    let sheetXml = await zip.file(sheetPath)?.async("string");
    let stylesXml = await zip.file("xl/styles.xml")?.async("string");
    assert.ok(sheetXml && stylesXml);
    const prefix = /<((?:\w+:)?)worksheet\b/u.exec(sheetXml)?.[1] ?? "";
    const protectedStyleId = Number(/<(?:\w+:)?c\b[^>]*\br="A1"[^>]*\bs="(\d+)"/u.exec(sheetXml)?.[1] ?? 0);
    const sheetData = `<${prefix}sheetData><${prefix}row r="1"><${prefix}c r="A1" s="${protectedStyleId}" t="inlineStr" ph="1"><${prefix}is><${prefix}r><${prefix}rPr><${prefix}b/><${prefix}color rgb="FFFF0000"/></${prefix}rPr><${prefix}t>Rich</${prefix}t></${prefix}r><${prefix}r><${prefix}rPr><${prefix}i/></${prefix}rPr><${prefix}t>Text</${prefix}t></${prefix}r></${prefix}is></${prefix}c><${prefix}c r="B1" t="n"><${prefix}f t="shared" si="7" ref="B1:B2">ROW()</${prefix}f><${prefix}v>1</${prefix}v></${prefix}c><${prefix}c r="C1" t="n"><${prefix}f t="array" ref="C1:C2">ROW(C1:C2)</${prefix}f><${prefix}v>1</${prefix}v></${prefix}c></${prefix}row><${prefix}row r="2"><${prefix}c r="B2" t="n"><${prefix}f t="shared" si="7"/><${prefix}v>2</${prefix}v></${prefix}c><${prefix}c r="C2" t="n"><${prefix}v>2</${prefix}v></${prefix}c></${prefix}row></${prefix}sheetData>`;
    sheetXml = sheetXml.replace(/<(?:\w+:)?sheetData\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:\w+:)?sheetData\s*>)/u, `${sheetData}<${prefix}sheetProtection sheet="1" objects="1" scenarios="1"/>`);

    const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs\s*>/u.exec(stylesXml);
    assert.ok(cellXfs);
    const xfPattern = /<(?:\w+:)?xf\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?xf\s*>)/gu;
    const entries = [...cellXfs[1].matchAll(xfPattern)];
    const target = entries[protectedStyleId];
    assert.ok(target);
    const qualifiedName = /^<([\w:.-]+)\b/u.exec(target[0])?.[1];
    assert.ok(qualifiedName);
    const protection = `<${prefix}protection locked="0" hidden="1"/>`;
    const replacement = /\/\s*>$/u.test(target[0])
      ? target[0].replace(/\s*\/\s*>$/u, ` applyProtection="1">${protection}</${qualifiedName}>`)
      : target[0].replace(new RegExp(`<\\/${qualifiedName}>$`, "u"), `${protection}</${qualifiedName}>`).replace(/^<([\w:.-]+)\b/u, `<$1 applyProtection="1"`);
    const body = `${cellXfs[1].slice(0, target.index)}${replacement}${cellXfs[1].slice(target.index + target[0].length)}`;
    stylesXml = `${stylesXml.slice(0, cellXfs.index)}${cellXfs[0].replace(cellXfs[1], body)}${stylesXml.slice(cellXfs.index + cellXfs[0].length)}`;
    zip.file(sheetPath, sheetXml);
    zip.file("xl/styles.xml", stylesXml);
  });
}

async function addConflictingEditableFreeze(workbookPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(workbookPath));
  const part = "xl/worksheets/sheet1.xml";
  let xml = await zip.file(part)?.async("string");
  assert.ok(xml);
  xml = xml.replace(/<(?:\w+:)?sheetViews\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetViews\s*>)/gu, "");
  xml = xml.replace(/(<(?:\w+:)?sheetFormatPr\b)/u, '<x:sheetViews><x:sheetView workbookViewId="0"><x:pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/><x:selection pane="topRight"/><x:selection pane="bottomRight"/></x:sheetView></x:sheetViews>$1');
  zip.file(part, xml);
  await fs.writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

test.beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-workbook-controlled-"));
});

test.afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("controlled segment rebuild globally sorts old 7/24 and new 7/3 and independently audits it", async () => {
  const baselinePath = await makeBaseline();
  const plan = planFor(baselinePath);
  plan.profiles.xhs.detailPath = path.join(tempRoot, "本次报销明细.xlsx");
  plan.profiles.xhs.detailTitle = "匿名报销明细";
  plan.profiles.xhs.period = "2026-07-03至2026-07-03";
  const before = await readWorkbookMetadata(baselinePath);
  const protectedBefore = before.sheets.find((sheet) => sheet.name === "Protected").xmlSha256;

  const built = await buildReimbursementCandidates(plan);
  assert.deepEqual(built.affectedProfiles, ["xiaohongshu"]);
  assert.equal(built.profiles[0].baselineRecordCount, 1);
  assert.equal(built.profiles[0].batchRecordCount, 1);
  assert.equal(built.profiles[0].candidateRevision, 2);
  assert.match(built.profiles[0].detailSha256, /^[0-9a-f]{64}$/u);

  const audited = await auditReimbursementCandidates(plan);
  assert.equal(audited.ok, true);
  assert.equal(audited.profiles[0].transactionCount, 2);
  assert.match(audited.profiles[0].auditDigest, /^[0-9a-f]{64}$/u);
  assert.match(audited.profiles[0].detailAuditDigest, /^[0-9a-f]{64}$/u);

  const candidate = await readWorkbookMetadata(plan.profiles.xhs.candidatePath);
  const target = candidate.sheets.find((sheet) => sheet.name === "Sheet1");
  assert.equal(cellAt(target, "B", 2).value, "新7月3日");
  assert.equal(cellAt(target, "B", 3).value, "旧7月24日");
  assert.equal(candidate.sheets.find((sheet) => sheet.name === "Protected").xmlSha256, protectedBefore);
  await assert.rejects(fs.access(`${baselinePath}.inspect.ndjson`));
  await assert.rejects(fs.access(`${plan.profiles.xhs.candidatePath}.inspect.ndjson`));
  const detail = await readWorkbookMetadata(plan.profiles.xhs.detailPath);
  const detailSheet = detail.sheets[0];
  assert.ok(detailSheet.merges.includes("A4:D4"));
  assert.equal(cellAt(detailSheet, "B", 6).value, "新7月3日");
});

test("structure drift from a deleted D header blocks before creating a candidate", async () => {
  const baselinePath = await makeBaseline({ mutateHeader: true });
  const plan = planFor(baselinePath, "must-not-exist.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /editable sheet|header fingerprint|STRUCTURE_DRIFT/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath));
});

test("a header moved away from its fixed profile row is structural drift", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true, headerRow: 2 });
  const plan = planFor(baselinePath, "shifted-header-must-not-exist.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /editable sheet|fingerprint|header/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath));
});

test("an otherwise matching sheet with an unapproved name is structural drift", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true, sheetName: "误改名" });
  const plan = planFor(baselinePath, "wrong-sheet-name-must-not-exist.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /allowed name|editable sheet|fingerprint/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath));
});

test("an unmanaged column is blocked even when only its header has content", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true, extraHeader: true });
  const plan = planFor(baselinePath, "unmanaged-column-must-not-exist.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /UNMANAGED_BUSINESS_COLUMN/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath));
});

test("Excel date serial time fractions never advance the business date", () => {
  const wholeDay = (Date.UTC(2026, 7, 10) - Date.UTC(1899, 11, 30)) / 86_400_000;
  assert.equal(excelDateToIso(wholeDay + 0.75), "2026-08-10");
});

test("independent audit rejects changes to editable-sheet history outside the controlled segment", async () => {
  const baselinePath = await makeBaseline();
  const plan = planFor(baselinePath, "outside-controlled-tamper.xlsx");
  plan.profiles.xhs.controlledSegment = { startRow: 3 };
  await buildReimbursementCandidates(plan);

  const zip = await JSZip.loadAsync(await fs.readFile(plan.profiles.xhs.candidatePath));
  const metadata = await readWorkbookMetadata(plan.profiles.xhs.candidatePath);
  const part = metadata.sheets.find((sheet) => sheet.name === "Sheet1").path;
  const xml = await zip.file(part).async("string");
  const changed = xml.replace(/(<(?:\w+:)?c\b[^>]*\br="C2"[^>]*>[\s\S]*?<(?:\w+:)?v>)24(<\/(?:\w+:)?v>)/u, "$125$2");
  assert.notEqual(changed, xml);
  zip.file(part, changed);
  await fs.writeFile(plan.profiles.xhs.candidatePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  await assert.rejects(auditReimbursementCandidates(plan), /editable-outside-controlled-changed:cell:C2/u);
});

test("an eight-row D/E/F group is preserved but emits a visual exception", async () => {
  const baselinePath = await makeBaseline();
  const plan = planFor(baselinePath, "large-merge.xlsx");
  plan.profiles.xhs.detailPath = path.join(tempRoot, "large-detail.xlsx");
  plan.profiles.xhs.transactions = Array.from({ length: 8 }, (_, index) => ({
    id: `NEW-${index + 1}`,
    sourceOrder: index + 1,
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    project: `匿名项目${index + 1}`,
    amount: "1",
    person: "同一人员",
    classification: "同一分类",
    rowType: "expense",
    settlement: "employee_reimbursement",
  }));
  const built = await buildReimbursementCandidates(plan);
  assert.equal(built.profiles[0].visualExceptions.length, 1);
  const audited = await auditReimbursementCandidates(plan);
  assert.equal(audited.profiles[0].visualExceptions.length, 1);
  const candidate = await readWorkbookMetadata(plan.profiles.xhs.candidatePath);
  const target = candidate.sheets.find((sheet) => sheet.name === "Sheet1");
  assert.ok(target.merges.includes("D2:D9"));
  assert.ok(target.merges.includes("E2:E9"));
  assert.ok(target.merges.includes("F2:F9"));
  const detail = await readWorkbookMetadata(plan.profiles.xhs.detailPath);
  assert.ok(detail.sheets[0].merges.includes("D6:D13"));
  assert.ok(detail.sheets[0].merges.includes("E6:E13"));
  assert.ok(detail.sheets[0].merges.includes("F6:F13"));
});

test("same-date rows audit through A merges and the same person is split by settlement", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true });
  const plan = planFor(baselinePath, "mixed-settlement.xlsx");
  plan.profiles.xhs.detailPath = path.join(tempRoot, "mixed-settlement-detail.xlsx");
  plan.profiles.xhs.detailTitle = "匿名报销明细";
  plan.profiles.xhs.period = "2026-08-01至2026-08-01";
  plan.profiles.xhs.transactions = [
    { id: "E1", sourceOrder: 1, date: "2026-08-01", project: "实报一", amount: "100", person: "同一人员", classification: "运营开支", settlement: "employee_reimbursement" },
    { id: "E2", sourceOrder: 2, date: "2026-08-01", project: "实报二", amount: "23.50", person: "同一人员", classification: "运营开支", settlement: "employee_reimbursement" },
    { id: "C1", sourceOrder: 3, date: "2026-08-01", project: "对公一", amount: "1000", person: "同一人员", classification: "运营开支", settlement: "company_paid_no_reimbursement" },
    { id: "C2", sourceOrder: 4, date: "2026-08-01", project: "对公二", amount: "64.125", person: "同一人员", classification: "运营开支", settlement: "company_paid_no_reimbursement" },
  ];
  await buildReimbursementCandidates(plan);
  assert.equal((await auditReimbursementCandidates(plan)).ok, true);
  const detail = await readWorkbookMetadata(plan.profiles.xhs.detailPath);
  const sheet = detail.sheets[0];
  assert.ok(sheet.merges.includes("A6:A7"));
  assert.ok(sheet.merges.includes("A10:A11"));
  assert.equal(cellAt(sheet, "A", 4).value, "同一人员｜2笔");
  assert.equal(cellAt(sheet, "A", 8).value, "同一人员（对公已付不实报）｜2笔");
  assert.equal(cellAt(sheet, "A", 8).style.fill.effectiveArgb, "FFF4B183");
  assert.equal(cellAt(sheet, "F", 4).style.numberFormat, "0.00");
  assert.equal(cellAt(sheet, "F", 8).style.numberFormat, "0.000");
  assert.match(cellAt(sheet, "A", 2).formula, /TEXT\([^,]+,"0\.00"\)/u);
  assert.match(cellAt(sheet, "C", 2).formula, /TEXT\([^,]+,"0\.000"\)/u);
});

test("blank-project and blank-date baseline rows are retained after dated rows without amount loss", async () => {
  const baselinePath = await makeBaseline({ blankProject: true, blankDate: true });
  const plan = planFor(baselinePath, "blank-legacy.xlsx");
  const built = await buildReimbursementCandidates(plan);
  assert.equal(built.profiles[0].transactionCount, 2);
  const audited = await auditReimbursementCandidates(plan);
  assert.equal(audited.profiles[0].transactionCount, 2);
  const candidate = await readWorkbookMetadata(plan.profiles.xhs.candidatePath);
  const target = candidate.sheets.find((sheet) => sheet.name === "Sheet1");
  assert.equal(cellAt(target, "B", 2).value, "新7月3日");
  assert.equal(cellAt(target, "B", 3).value, "");
  assert.equal(Number(cellAt(target, "C", 3).value), 24);
  assert.equal(cellAt(target, "A", 3).value, "");
});

test("a header-only ledger accepts the first controlled-segment reimbursement", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true });
  const plan = planFor(baselinePath, "first.xlsx");
  const built = await buildReimbursementCandidates(plan);
  assert.equal(built.profiles[0].baselineRecordCount, 0);
  assert.equal((await auditReimbursementCandidates(plan)).profiles[0].transactionCount, 1);
});

test("protected sheet print features survive candidate construction and independent audit", async () => {
  const baselinePath = await makeBaseline({ headerOnly: true });
  await addProtectedPrintFeatures(baselinePath);
  const plan = planFor(baselinePath, "protected-features.xlsx");
  await buildReimbursementCandidates(plan);
  assert.equal((await auditReimbursementCandidates(plan)).ok, true);
  const [baseline, candidate] = await Promise.all([
    readWorkbookMetadata(baselinePath),
    readWorkbookMetadata(plan.profiles.xhs.candidatePath),
  ]);
  const baselineProtected = baseline.sheets.find((sheet) => sheet.name === "Protected");
  const candidateProtected = candidate.sheets.find((sheet) => sheet.name === "Protected");
  assert.equal(candidateProtected.protectedFeatureSignature, baselineProtected.protectedFeatureSignature);
  assert.equal(candidateProtected.relationshipClosureSignature, baselineProtected.relationshipClosureSignature);
});

test("protected OOXML semantics and the package whitelist fail closed on every unauthorized drift", async (context) => {
  const baselinePath = await makeBaseline({ headerOnly: true, protectedBold: true });
  await addProtectedIntegrityFeatures(baselinePath);
  const plan = planFor(baselinePath, "protected-integrity.xlsx");
  await buildReimbursementCandidates(plan);

  await context.test("positive: shared and array formulas, protection, rich text, and controlled global parts survive", async () => {
    assert.equal((await auditReimbursementCandidates(plan)).ok, true);
    const [baseline, candidate] = await Promise.all([
      readWorkbookMetadata(baselinePath),
      readWorkbookMetadata(plan.profiles.xhs.candidatePath),
    ]);
    const baselineProtected = baseline.sheets.find((sheet) => sheet.name === "Protected");
    const candidateProtected = candidate.sheets.find((sheet) => sheet.name === "Protected");
    assert.equal(candidateProtected.cellMetadataSignature, baselineProtected.cellMetadataSignature);
    assert.equal(candidateProtected.styleProtectionSignature, baselineProtected.styleProtectionSignature);
  });

  const auditMutation = async (name, mutate, error) => context.test(name, async () => {
    const candidatePath = path.join(tempRoot, `${name.replace(/[^a-z0-9]+/giu, "-")}.xlsx`);
    await fs.copyFile(plan.profiles.xhs.candidatePath, candidatePath);
    await rewriteWorkbookZip(candidatePath, mutate);
    const mutatedPlan = structuredClone(plan);
    mutatedPlan.profiles.xhs.candidatePath = candidatePath;
    await assert.rejects(() => auditReimbursementCandidates(mutatedPlan), error);
  });

  await auditMutation("shared-formula-si", async (zip) => {
    const part = "xl/worksheets/sheet2.xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/(<(?:\w+:)?f\b[^>]*\bt="shared"[^>]*\bsi=")7("[^>]*>)/u, (_, before, after) => `${before}8${after}`));
  }, /protected-sheet-changed:Protected:content-layout/u);

  await auditMutation("array-formula-ref", async (zip) => {
    const part = "xl/worksheets/sheet2.xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/(<(?:\w+:)?f\b[^>]*\bt="array"[^>]*\bref=")C1:C2("[^>]*>)/u, "$1C1:C3$2"));
  }, /protected-sheet-changed:Protected:content-layout/u);

  await auditMutation("cell-attribute", async (zip) => {
    const part = "xl/worksheets/sheet2.xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/(<(?:\w+:)?c\b[^>]*\br="A1"[^>]*\bph=")1("[^>]*>)/u, (_, before, after) => `${before}0${after}`));
  }, /protected-sheet-changed:Protected:content-layout/u);

  await auditMutation("inline-rich-text-format", async (zip) => {
    const part = "xl/worksheets/sheet2.xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/<(\w+:)?b\s*\/>/u, (_, prefix = "") => `<${prefix}u/>`));
  }, /protected-sheet-changed:Protected:content-layout/u);

  await auditMutation("xf-protection", async (zip) => {
    const part = "xl/styles.xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/(<(?:\w+:)?protection\b[^>]*\blocked=")0("[^>]*\/\s*>)/u, (_, before, after) => `${before}1${after}`));
  }, /protected-sheet-changed:Protected:computed-style/u);

  await auditMutation("customXml-part", async (zip) => {
    zip.file("customXml/item1.xml", "<unauthorized/>");
  }, /package-integrity:part-added:customXml\/item1\.xml/u);

  await auditMutation("content-types", async (zip) => {
    const part = "[Content_Types].xml";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/<\/Types>\s*$/u, '<Default Extension="auditx" ContentType="application/unauthorized"/></Types>'));
  }, /package-integrity:part-modified:\[Content_Types\]\.xml/u);

  await auditMutation("workbook-relationship", async (zip) => {
    const part = "xl/_rels/workbook.xml.rels";
    const xml = await zip.file(part)?.async("string");
    zip.file(part, xml.replace(/<(?:\w+:)?Relationship\b[^>]*\bType="[^"]*\/styles"[^>]*\/\s*>/u, (relation) => relation.replace("/xl/styles.xml", "/xl/theme/theme1.xml")));
  }, /package-integrity:workbook-relationships/u);

  await auditMutation("non-print-defined-name", async (zip) => {
    const part = "xl/workbook.xml";
    const xml = await zip.file(part)?.async("string");
    const prefix = /<((?:\w+:)?)workbook\b/u.exec(xml)?.[1] ?? "";
    zip.file(part, xml.replace(new RegExp(`<\\/${prefix}definedNames>`, "u"), `<${prefix}definedName name="HiddenAuditName" hidden="1">1</${prefix}definedName></${prefix}definedNames>`));
  }, /package-integrity:workbook-metadata/u);
});

test("display repair replaces a conflicting two-axis freeze with the exact profile pane", async () => {
  const baselinePath = await makeBaseline();
  await addConflictingEditableFreeze(baselinePath);
  const plan = planFor(baselinePath, "freeze-repaired.xlsx");
  await buildReimbursementCandidates(plan);
  assert.equal((await auditReimbursementCandidates(plan)).ok, true);
  const candidate = await readWorkbookMetadata(plan.profiles.xhs.candidatePath);
  const xml = candidate.sheets.find((sheet) => sheet.name === "Sheet1").xml;
  assert.match(xml, /<x:pane\b[^>]*\bySplit="1"[^>]*\btopLeftCell="A2"[^>]*\bactivePane="bottomLeft"[^>]*\bstate="frozen"/u);
  assert.doesNotMatch(xml, /\bxSplit=/u);
  assert.equal((xml.match(/<x:selection\b/gu) ?? []).length, 1);
  assert.match(xml, /<x:selection\b[^>]*\bpane="bottomLeft"/u);
});

test("a configured protected sheet deleted before the run is structural drift", async () => {
  const { profileConfig } = await loadContracts();
  const config = profileConfig.profiles.company;
  const directory = path.join(tempRoot, config.profileDirectory);
  await fs.mkdir(directory);
  const baselinePath = path.join(directory, config.rootWorkbookNames[0]);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(config.rootSheet.names[0]);
  workbook.worksheets.add("来源结算摘要").getRange("A1").values = [["存在"]];
  sheet.getRange("A4:F4").values = [config.rootSheet.headerFingerprints[0]];
  const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(baselinePath);
  await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await assert.rejects(
    () => buildReimbursementCandidates({
      version: 1,
      affectedProfiles: ["company"],
      profiles: { company: { baselinePath, candidatePath: path.join(tempRoot, "missing-protected.xlsx"), titleYear: 2026, controlledSegment: { startDate: "2026-06-01" }, transactions: [{ id: "C1", date: "2026-08-01", project: "公司项目", amount: "10", person: "匿名", classification: "运营开支" }] } },
    }),
    /MISSING_REQUIRED_PROTECTED_SHEET_GROUP/u,
  );
});

test("residence accepts either editable-sheet alias without embedding the external income and wage ledgers", async (context) => {
  const { profileConfig } = await loadContracts();
  const config = profileConfig.profiles.residence;
  for (const editableName of ["驻所支出", "住所支出"]) {
    await context.test(editableName, async () => {
      const directory = path.join(tempRoot, editableName, config.profileDirectory);
      await fs.mkdir(directory, { recursive: true });
      const baselinePath = path.join(directory, config.rootWorkbookNames[0]);
      const workbook = Workbook.create();
      const sheet = workbook.worksheets.add(editableName);
      sheet.getRange("A1").values = [["2026年驻所支出总表"]];
      sheet.getRange("A4:F4").values = [config.rootSheet.headerFingerprints[0]];
      const blob = await SpreadsheetFile.exportXlsx(workbook);
      await blob.save(baselinePath);
      await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
      const plan = {
        version: 1,
        affectedProfiles: ["residence"],
        profiles: { residence: {
          baselinePath,
          candidatePath: path.join(directory, `${editableName}-candidate.xlsx`),
          titleYear: 2026,
          controlledSegment: { startDate: "2026-06-01" },
          transactions: [{ id: `R-${editableName}`, date: "2026-08-01", project: "驻所项目", amount: "10", person: "匿名", classification: "运营开支" }],
        } },
      };
      await buildReimbursementCandidates(plan);
      assert.equal((await auditReimbursementCandidates(plan)).ok, true);
    });
  }
});

test("residence leaves external income and wage workbooks unopened and preserves unknown sheets in the expense workbook", async () => {
  const { profileConfig } = await loadContracts();
  const config = profileConfig.profiles.residence;
  const directory = path.join(tempRoot, config.profileDirectory);
  await fs.mkdir(directory, { recursive: true });
  const baselinePath = path.join(directory, config.rootWorkbookNames[0]);
  const incomePath = path.join(directory, "驻所收入.xlsx");
  const wagePath = path.join(directory, "驻所工资.xlsx");
  await fs.writeFile(incomePath, "external-income-ledger-sentinel");
  await fs.writeFile(wagePath, "external-wage-ledger-sentinel");
  const incomeBefore = await fs.readFile(incomePath);
  const wageBefore = await fs.readFile(wagePath);
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("驻所支出");
  workbook.worksheets.add("自定义辅助页").getRange("A1").values = [["未知页必须保护"]];
  sheet.getRange("A1").values = [["2026年驻所支出总表"]];
  sheet.getRange("A4:F4").values = [config.rootSheet.headerFingerprints[0]];
  const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(baselinePath);
  await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const candidatePath = path.join(directory, "residence-candidate.xlsx");
  const plan = {
    version: 1,
    affectedProfiles: ["residence"],
    profiles: { residence: { baselinePath, candidatePath, titleYear: 2026, controlledSegment: { startDate: "2026-06-01" }, transactions: [{ id: "R1", date: "2026-08-01", project: "驻所项目", amount: "10", person: "匿名", classification: "运营开支" }] } },
  };
  await buildReimbursementCandidates(plan);
  assert.equal((await auditReimbursementCandidates(plan)).ok, true);
  assert.deepEqual(await fs.readFile(incomePath), incomeBefore);
  assert.deepEqual(await fs.readFile(wagePath), wageBefore);
  const candidate = await readWorkbookMetadata(candidatePath);
  assert.equal(cellAt(candidate.sheets.find((item) => item.name === "自定义辅助页"), "A", 1).value, "未知页必须保护");
});

test("company header style and widths drift are repaired to the blue XHS-derived contract while protected sheets remain unchanged", async () => {
  const { profileConfig } = await loadContracts();
  const config = profileConfig.profiles.company;
  const directory = path.join(tempRoot, config.profileDirectory);
  await fs.mkdir(directory);
  const baselinePath = path.join(directory, config.rootWorkbookNames[0]);
  const candidatePath = path.join(tempRoot, "company-candidate.xlsx");
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(config.rootSheet.names[0]);
  const protectedSheet = workbook.worksheets.add("来源结算摘要");
  const reviewSheet = workbook.worksheets.add("核对说明");
  sheet.getRange("A1").values = [["2026年公司支出总表（候选）"]];
  sheet.getRange("A4:F4").values = [config.rootSheet.headerFingerprints[0]];
  for (const column of ["A", "B", "C", "D", "E", "F"]) sheet.getRange(`${column}1`).format.columnWidth = 10;
  protectedSheet.getRange("A1").values = [["必须保护"]];
  protectedSheet.getRange("A1").format = { font: { name: "Arial", size: 16, bold: true }, fill: "#FFCC00" };
  reviewSheet.getRange("A1").values = [["同样必须保护"]];
  const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(baselinePath);
  await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const raw = {
    version: 1,
    affectedProfiles: ["company"],
    profiles: { company: { baselinePath, candidatePath, titleYear: 2026, controlledSegment: { startDate: "2026-06-01" }, transactions: [{ id: "C1", date: "2026-08-01", project: "公司项目", amount: "10", person: "匿名", classification: "运营开支" }] } },
  };
  const built = await buildReimbursementCandidates(raw);
  assert.ok(built.profiles[0].repairActions.some((item) => item.includes("COLUMN_WIDTH_DRIFT")));
  assert.ok(built.profiles[0].repairActions.some((item) => item.includes("FORMAL_TITLE")));
  assert.equal((await auditReimbursementCandidates(raw)).ok, true);
  const candidate = await readWorkbookMetadata(candidatePath);
  const target = candidate.sheets.find((item) => item.name === config.rootSheet.names[0]);
  assert.equal(cellAt(target, "A", 1).value, "2026年公司支出总表");
  assert.equal(cellAt(target, "A", 1).style.fill.effectiveArgb, "FF4472C4");
  assert.equal(cellAt(target, "A", 1).style.font.color, "FFFFFFFF");
  assert.equal(cellAt(target, "A", 4).style.fill.effectiveArgb, "FF4472C4");
  assert.equal(cellAt(target, "A", 4).style.font.color, "FFFFFFFF");
  assert.equal(cellAt(candidate.sheets.find((item) => item.name === "来源结算摘要"), "A", 1).value, "必须保护");
  assert.equal(cellAt(candidate.sheets.find((item) => item.name === "核对说明"), "A", 1).value, "同样必须保护");
});
