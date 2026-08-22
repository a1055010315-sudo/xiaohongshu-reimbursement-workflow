import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DISBURSEMENT_WORKBOOK_FILENAME,
  buildDisbursementArchive,
  inspectCompactDisbursementWorkbookBytes,
} from "../scripts/disbursement_archive.mjs";
import { auditCompactDisbursementCandidate } from "../scripts/run_compact_disbursement_workflow.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

function fixtureAudit() {
  const factsDigest = "1".repeat(64);
  const sourceBindingDigest = "2".repeat(64);
  return Object.freeze({
    kind: "compact-disbursement-audit-v1",
    manifest: Object.freeze({ path: "C:\\fixture\\manifest.json", sha256: "3".repeat(64), size: 1 }),
    batch: Object.freeze({
      batchId: "candidate-row-audit",
      batchName: "2026.7.25-2026.8.12_小红书报销",
      reimbursementPeriod: Object.freeze({ start: "2026-07-25", end: "2026-08-12" }),
      salaryMonth: null,
      activeProfileIds: Object.freeze(["xiaohongshu"]),
    }),
    rows: Object.freeze([
      Object.freeze({
        id: "row-1",
        order: 1,
        subject: "示例对象甲",
        scopeStatus: "not_in_batch",
        payoutStatus: "not_applicable",
        paymentMethod: "none",
        paymentMethodDisplay: "—",
        adjustmentKind: "none",
        amounts: Object.freeze({ xiaohongshu: "100", company: "0", residence: "0", salary: "0" }),
        payableAmount: "100",
        paidAmount: "0",
        reimbursementRefs: Object.freeze([]),
        voucherRefs: Object.freeze([]),
        voucherArchiveNames: Object.freeze([]),
        visibleStatus: "非本批",
        reason: "不属于本批",
        targetBatch: "下批处理",
      }),
      Object.freeze({
        id: "row-2",
        order: 2,
        subject: "尾差",
        scopeStatus: "in_batch",
        payoutStatus: "not_applicable",
        paymentMethod: "none",
        paymentMethodDisplay: "—",
        adjustmentKind: "rounding_tail",
        amounts: Object.freeze({ xiaohongshu: "0", company: "0", residence: "0", salary: "0" }),
        payableAmount: "0",
        paidAmount: "0",
        reimbursementRefs: Object.freeze([]),
        voucherRefs: Object.freeze([]),
        voucherArchiveNames: Object.freeze([]),
        visibleStatus: "已忽略尾差",
        adjustment: Object.freeze({
          amount: "0.001",
          sourceRowId: "row-1",
          reason: "三位小数尾差",
          tolerance: "0.01",
          authorization: "财务确认忽略",
        }),
      }),
    ]),
    salaryArtifacts: Object.freeze([]),
    reimbursementSources: Object.freeze([]),
    voucherArchive: Object.freeze([]),
    totals: Object.freeze({
      inBatchDueTotal: "0",
      inBatchPaidTotal: "0",
      reconciledTotal: "0",
      roundingTailTotal: "0.001",
      uniqueVoucherCount: 0,
      voucherReferenceCount: 0,
      salarySlotCount: 0,
      rowCount: 2,
    }),
    closureStatus: "closed",
    factsDigest,
    sourceBindingDigest,
    runtime: Object.freeze({ voucherBytesBySha256: new Map() }),
  });
}

function expectedRecordFromCandidate(candidate) {
  return Object.freeze({
    summaryText: candidate.summary.text,
    bindings: candidate.bindings,
    artifactDigest: candidate.artifactDigest,
  });
}

test("candidate audit independently matches every workbook row", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-row-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = fixtureAudit();
  const candidate = await buildDisbursementArchive(audit, path.join(root, "candidate"));

  const report = await auditCompactDisbursementCandidate(audit, candidate.outputRoot, expectedRecordFromCandidate(candidate));
  assert.equal(report.status, "passed");
  assert.deepEqual(report.coverage, { expectedRows: 2, auditedRows: 2, expectedVouchers: 0, auditedVouchers: 0 });
  assert.deepEqual(report.rowResults.map((entry) => entry.status), ["matched", "matched"]);
  assert.equal(report.rowResults[0].actual.subject, "示例对象甲");
  assert.equal(report.rowResults[1].actual.note, "尾差0.001元；来源行row-1；授权：财务确认忽略");
});

test("candidate audit reports a workbook row mismatch even when the changed workbook is rebound", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-row-tamper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = fixtureAudit();
  const candidate = await buildDisbursementArchive(audit, path.join(root, "candidate"));
  const workbookPath = path.join(candidate.outputRoot, DISBURSEMENT_WORKBOOK_FILENAME);
  const originalBytes = await fs.readFile(workbookPath);
  const zip = await JSZip.loadAsync(originalBytes, { createFolders: false });
  const worksheetPath = "xl/worksheets/sheet1.xml";
  const worksheet = await zip.file(worksheetPath).async("string");
  const changedWorksheet = worksheet.replace(">示例对象甲</t>", ">篡改姓名</t>");
  assert.notEqual(changedWorksheet, worksheet, "fixture subject must exist in sheet1.xml");
  zip.file(worksheetPath, changedWorksheet);
  const changedBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  await fs.writeFile(workbookPath, changedBytes);

  const changedInspection = await inspectCompactDisbursementWorkbookBytes(changedBytes);
  const changedBindings = Object.freeze({
    ...candidate.bindings,
    workbook: Object.freeze({
      ...candidate.bindings.workbook,
      sha256: sha256Bytes(changedBytes),
      size: changedBytes.length,
      inspection: changedInspection,
    }),
  });
  const expectedRecord = Object.freeze({
    summaryText: candidate.summary.text,
    bindings: changedBindings,
    artifactDigest: canonicalDigest(changedBindings),
  });
  const report = await auditCompactDisbursementCandidate(audit, candidate.outputRoot, expectedRecord);

  assert.equal(report.actualArtifactDigest, expectedRecord.artifactDigest, "artifact rebinding should close before semantic row comparison");
  assert.equal(report.status, "failed");
  assert.equal(report.coverage.auditedRows, 1);
  assert.equal(report.rowResults[0].status, "failed");
  assert.deepEqual(report.rowResults[0].differences.map((entry) => entry.field), ["subject"]);
  assert.equal(report.mismatches.some((entry) => entry.code === "workbook-row-field-mismatch"), true);
});
