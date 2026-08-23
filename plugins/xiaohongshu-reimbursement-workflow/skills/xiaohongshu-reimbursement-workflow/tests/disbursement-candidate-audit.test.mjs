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

function fixtureAudit({ voucherCount = 0 } = {}) {
  const factsDigest = "1".repeat(64);
  const sourceBindingDigest = "2".repeat(64);
  const voucherBytes = Array.from({ length: voucherCount }, (_, index) => Buffer.from(`synthetic-voucher-${index + 1}`, "utf8"));
  const voucherArchive = voucherBytes.map((bytes, index) => Object.freeze({
    archiveName: `${String(index + 1).padStart(3, "0")}_${sha256Bytes(bytes).slice(0, 12)}.png`,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    sourceIds: Object.freeze([`voucher-${index + 1}`]),
    rowReferences: Object.freeze([]),
  }));
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
    voucherArchive: Object.freeze(voucherArchive),
    totals: Object.freeze({
      inBatchDueTotal: "0",
      inBatchPaidTotal: "0",
      reconciledTotal: "0",
      roundingTailTotal: "0.001",
      uniqueVoucherCount: voucherArchive.length,
      voucherReferenceCount: 0,
      salarySlotCount: 0,
      rowCount: 2,
    }),
    closureStatus: "closed",
    factsDigest,
    sourceBindingDigest,
    runtime: Object.freeze({ voucherBytesBySha256: new Map(voucherArchive.map((entry, index) => [entry.sha256, voucherBytes[index]])) }),
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

test("candidate durable writes use bounded concurrency while preserving voucher order", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-write-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalOpen = fs.open;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  fs.open = async (filePath, flags, ...rest) => {
    if (flags !== "wx") return originalOpen.call(fs, filePath, flags, ...rest);
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return await originalOpen.call(fs, filePath, flags, ...rest);
    } finally {
      activeWrites -= 1;
    }
  };
  try {
    const audit = fixtureAudit({ voucherCount: 5 });
    const candidate = await buildDisbursementArchive(audit, path.join(root, "candidate"));
    assert.ok(maxActiveWrites >= 2 && maxActiveWrites <= 3, `candidate write concurrency was ${maxActiveWrites}`);
    assert.deepEqual(candidate.vouchers.map((entry) => entry.name), audit.voucherArchive.map((entry) => entry.archiveName));
  } finally {
    fs.open = originalOpen;
  }
});

test("a concurrent candidate write failure removes completed and partial owned files", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-write-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const originalOpen = fs.open;
  let writeAttempt = 0;
  fs.open = async (filePath, flags, ...rest) => {
    const handle = await originalOpen.call(fs, filePath, flags, ...rest);
    if (flags !== "wx") return handle;
    writeAttempt += 1;
    if (writeAttempt !== 3) return handle;
    return {
      writeFile: async () => {
        await handle.writeFile(Buffer.from("partial-owned-candidate", "utf8"));
        throw new Error("synthetic concurrent candidate write failure");
      },
      stat: handle.stat.bind(handle),
      sync: handle.sync.bind(handle),
      close: handle.close.bind(handle),
    };
  };
  try {
    await assert.rejects(
      buildDisbursementArchive(fixtureAudit({ voucherCount: 5 }), candidateRoot),
      /synthetic concurrent candidate write failure/u,
    );
    assert.ok(writeAttempt >= 3);
    await assert.rejects(fs.access(candidateRoot), /ENOENT/u);
  } finally {
    fs.open = originalOpen;
  }
});

test("candidate write failure reports and preserves an owned file that cleanup cannot remove", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-cleanup-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  let writeAttempt = 0;
  let blockedPath;
  fs.open = async (filePath, flags, ...rest) => {
    const handle = await originalOpen.call(fs, filePath, flags, ...rest);
    if (flags !== "wx") return handle;
    writeAttempt += 1;
    if (writeAttempt !== 3) return handle;
    blockedPath = path.resolve(filePath);
    return {
      writeFile: async () => {
        await handle.writeFile(Buffer.from("partial-owned-candidate", "utf8"));
        throw new Error("synthetic candidate write failure before locked cleanup");
      },
      stat: handle.stat.bind(handle),
      sync: handle.sync.bind(handle),
      close: handle.close.bind(handle),
    };
  };
  fs.unlink = async (filePath) => {
    if (blockedPath && path.resolve(filePath) === blockedPath) {
      throw Object.assign(new Error("synthetic cleanup access denied"), { code: "EACCES" });
    }
    return originalUnlink.call(fs, filePath);
  };
  try {
    await assert.rejects(
      buildDisbursementArchive(fixtureAudit({ voucherCount: 5 }), candidateRoot),
      (error) => {
        assert.match(error.message, /synthetic candidate write failure before locked cleanup/u);
        assert.match(error.message, /candidate cleanup is incomplete; preserved paths/iu);
        assert.equal(error.cause?.message, "synthetic candidate write failure before locked cleanup");
        assert.ok(error.preservedPaths.includes(blockedPath));
        assert.ok(error.candidateCleanupFailures.some((entry) => entry.operation === "unlink_partial" && entry.path === blockedPath));
        return true;
      },
    );
    assert.ok(blockedPath);
    await fs.access(blockedPath);
    await fs.access(candidateRoot);
  } finally {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
  }
});

test("a secondary concurrent write cleanup failure is preserved in the primary error", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-secondary-cleanup-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  let blockedPath;
  let releaseSecondary;
  const secondaryStarted = new Promise((resolve) => { releaseSecondary = resolve; });
  fs.open = async (filePath, flags, ...rest) => {
    const handle = await originalOpen.call(fs, filePath, flags, ...rest);
    if (flags !== "wx") return handle;
    const resolved = path.resolve(filePath);
    if (resolved.endsWith(".txt")) {
      return {
        writeFile: async () => {
          await handle.writeFile(Buffer.from("primary-partial", "utf8"));
          await secondaryStarted;
          throw new Error("synthetic primary candidate failure");
        },
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }
    if (resolved.endsWith(".png")) {
      blockedPath = resolved;
      return {
        writeFile: async () => {
          await handle.writeFile(Buffer.from("secondary-partial", "utf8"));
          releaseSecondary();
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("synthetic secondary candidate failure");
        },
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }
    return handle;
  };
  fs.unlink = async (filePath) => {
    if (blockedPath && path.resolve(filePath) === blockedPath) {
      throw Object.assign(new Error("synthetic secondary cleanup access denied"), { code: "EACCES" });
    }
    return originalUnlink.call(fs, filePath);
  };
  try {
    await assert.rejects(
      buildDisbursementArchive(fixtureAudit({ voucherCount: 1 }), candidateRoot),
      (error) => {
        assert.match(error.message, /synthetic primary candidate failure/u);
        assert.match(error.message, /candidate cleanup is incomplete/iu);
        assert.ok(blockedPath);
        assert.ok(error.preservedPaths.includes(blockedPath));
        assert.ok(error.candidateCleanupFailures.some((entry) => (
          entry.operation === "unlink_partial"
          && entry.path === blockedPath
          && /secondary cleanup access denied/u.test(entry.message)
        )));
        return true;
      },
    );
    await fs.access(blockedPath);
    await fs.access(candidateRoot);
  } finally {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
  }
});

test("failure cleanup preserves a completed candidate file replaced by identical bytes", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-same-bytes-replacement-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const originalOpen = fs.open;
  let summaryPath;
  let summaryBytes;
  let pngOpenCount = 0;
  let replacementMade = false;
  fs.open = async (filePath, flags, ...rest) => {
    const handle = await originalOpen.call(fs, filePath, flags, ...rest);
    if (flags !== "wx") return handle;
    const resolved = path.resolve(filePath);
    if (resolved.endsWith(".txt")) {
      summaryPath = resolved;
      return {
        writeFile: async (bytes) => {
          summaryBytes = Buffer.from(bytes);
          await handle.writeFile(bytes);
        },
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }
    if (resolved.endsWith(".xlsx")) {
      return {
        writeFile: async (bytes) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          await handle.writeFile(bytes);
        },
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }
    if (resolved.endsWith(".png")) {
      pngOpenCount += 1;
      if (pngOpenCount === 1) {
        return {
          writeFile: async (bytes) => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            await handle.writeFile(bytes);
          },
          stat: handle.stat.bind(handle),
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
        };
      }
      assert.ok(summaryPath && summaryBytes, "summary must finish before the next queued voucher starts");
      const replacementPath = path.join(root, "same-bytes-summary-replacement.txt");
      const replacementHandle = await originalOpen.call(fs, replacementPath, "wx", 0o600);
      await replacementHandle.writeFile(summaryBytes);
      await replacementHandle.sync();
      await replacementHandle.close();
      await fs.unlink(summaryPath);
      await fs.rename(replacementPath, summaryPath);
      replacementMade = true;
      return {
        writeFile: async () => {
          await handle.writeFile(Buffer.from("trigger-failure", "utf8"));
          throw new Error("synthetic failure after same-byte replacement");
        },
        stat: handle.stat.bind(handle),
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    }
    return handle;
  };
  try {
    await assert.rejects(
      buildDisbursementArchive(fixtureAudit({ voucherCount: 3 }), candidateRoot),
      (error) => {
        assert.match(error.message, /synthetic failure after same-byte replacement/u);
        assert.match(error.message, /candidate cleanup is incomplete/iu);
        assert.ok(error.preservedPaths.includes(summaryPath));
        return true;
      },
    );
    assert.equal(replacementMade, true);
    assert.deepEqual(await fs.readFile(summaryPath), summaryBytes);
    await fs.access(candidateRoot);
  } finally {
    fs.open = originalOpen;
  }
});

test("an output path exchanged immediately after open is preserved and reported", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-disbursement-open-path-exchange-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const originalOpen = fs.open;
  const foreignBytes = Buffer.from("foreign same-path replacement", "utf8");
  let exchangedPath;
  fs.open = async (filePath, flags, ...rest) => {
    const handle = await originalOpen.call(fs, filePath, flags, ...rest);
    const resolved = path.resolve(filePath);
    if (flags !== "wx" || exchangedPath || !resolved.endsWith(".txt")) return handle;
    const replacementPath = path.join(root, "open-exchange-replacement.txt");
    const replacementHandle = await originalOpen.call(fs, replacementPath, "wx", 0o600);
    await replacementHandle.writeFile(foreignBytes);
    await replacementHandle.sync();
    await replacementHandle.close();
    await fs.unlink(resolved);
    await fs.rename(replacementPath, resolved);
    exchangedPath = resolved;
    return handle;
  };
  try {
    await assert.rejects(
      buildDisbursementArchive(fixtureAudit({ voucherCount: 1 }), candidateRoot),
      (error) => {
        assert.match(error.message, /candidate path identity changed immediately after creation/u);
        assert.match(error.message, /candidate cleanup is incomplete/iu);
        assert.ok(error.preservedPaths.includes(exchangedPath));
        return true;
      },
    );
    assert.ok(exchangedPath);
    assert.deepEqual(await fs.readFile(exchangedPath), foreignBytes);
    await fs.access(candidateRoot);
  } finally {
    fs.open = originalOpen;
  }
});
