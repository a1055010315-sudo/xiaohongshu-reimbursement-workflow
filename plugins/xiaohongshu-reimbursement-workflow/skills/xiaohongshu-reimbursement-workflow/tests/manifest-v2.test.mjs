import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");
const summaryScript = path.join(skillRoot, "scripts", "build_reimbursement_summary.mjs");

let tempDir;
let baselineFile;
let priorCandidateFile;
let currentCandidateFile;
let materialFile;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runJsonScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  assert.ok(jsonLine, `Expected JSON output; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(jsonLine) };
}

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

function fileEntry(id, role, fixture, extra = {}) {
  return { id, role, path: fixture.path, sha256: fixture.sha256, ...extra };
}

function commonBatch() {
  return {
    batchId: "anonymous-batch-2024-001",
    rootPath: tempDir,
    archivePath: path.join(tempDir, "archive"),
    period: "2024-01-01—2024-02-29",
    targetCategory: "小红书报销",
    reviewRevision: 1,
  };
}

function makeCorrectionManifest() {
  return {
    version: 2,
    rulesVersion: "anonymous-manifest-v2-test",
    batch: commonBatch(),
    operation: {
      mode: "ledger-reorder-correction",
      candidateRevision: 2,
      supersedes: "candidate-prior",
      planFileSha256: "d".repeat(64),
      correctionPolicy: {
        sheetName: "Sheet1",
        physicalRange: "A10:J25",
        scopeStart: "2024-01-01",
        scopeStartInclusive: true,
        scopeEnd: "2024-02-29",
        scopeEndInclusive: true,
        sortKeys: ["date:asc", "baselineOrder:asc"],
        stableTieBreaker: "baselineOrder",
        blankRowsPolicy: "preserve-physical",
      },
      expectedRecordCount: 12,
      expectedPhysicalRecordRowCount: 16,
      expectedScopedRecordCount: 8,
      expectedScopedRowCount: 10,
      expectedScopedAmount: "123.45",
      expectedAmountDelta: "0",
    },
    files: [
      fileEntry("baseline", "baseline", baselineFile),
      fileEntry("candidate-prior", "candidate", priorCandidateFile, { current: false }),
      fileEntry("candidate-current", "candidate", currentCandidateFile, { current: true }),
    ],
  };
}

function makeV2ReimbursementManifest(transactions, totals) {
  return {
    version: 2,
    rulesVersion: "anonymous-manifest-v2-test",
    batch: commonBatch(),
    operation: { mode: "reimbursement-batch" },
    files: [
      fileEntry("baseline", "baseline", baselineFile),
      fileEntry("IMG-001", "material", materialFile, {
        kind: "image",
        disposition: "used",
      }),
    ],
    transactions: transactions.map((transaction, index) => ({
      sourceOrder: index + 1,
      ...transaction,
    })),
    expectedFeeTotal: totals.fee,
    expectedRealTotal: totals.real,
    expectedCategoryTotals: { 小红书报销: totals.category },
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-manifest-v2-test-"));
  await fs.mkdir(path.join(tempDir, "archive"));
  const definitions = [
    ["baseline.bin", "anonymous baseline\n"],
    ["candidate-prior.bin", "anonymous prior candidate\n"],
    ["candidate-current.bin", "anonymous current candidate\n"],
    ["material.bin", "anonymous material\n"],
  ];
  const fixtures = [];
  for (const [name, text] of definitions) {
    const bytes = Buffer.from(text, "utf8");
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, bytes, { flag: "wx" });
    fixtures.push({ path: filePath, sha256: sha256(bytes) });
  }
  [baselineFile, priorCandidateFile, currentCandidateFile, materialFile] = fixtures;
});

test.after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("v2 ledger correction validates bound files and emits operation/config digests", async () => {
  const filePath = await writeJson("correction-valid.json", makeCorrectionManifest());
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 0);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.operation.mode, "ledger-reorder-correction");
  assert.equal(result.payload.operation.bindings.currentCandidateId, "candidate-current");
  assert.match(result.payload.operationDigest, /^[0-9a-f]{64}$/);
  assert.match(result.payload.configDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.payload.transactions, 0);
});

test("v2 ledger correction supports an explicit first revision without a superseded candidate", async () => {
  const manifest = makeCorrectionManifest();
  manifest.operation.candidateRevision = 1;
  manifest.operation.supersedes = null;
  manifest.files = manifest.files.filter((file) => file.id !== "candidate-prior");
  const filePath = await writeJson("correction-first-revision.json", manifest);
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  assert.equal(result.payload.operation.bindings.supersedes, null);
});

test("v2 correction candidate paths are case-insensitively distinct on Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const manifest = makeCorrectionManifest();
  manifest.files.find((file) => file.id === "candidate-prior").path = currentCandidateFile.path.toUpperCase();
  manifest.files.find((file) => file.id === "candidate-prior").sha256 = currentCandidateFile.sha256;
  const filePath = await writeJson("correction-case-alias.json", manifest);
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /distinct absolute paths/);
});

test("manifest v2 requires a stable non-empty batchId", async () => {
  const manifest = makeCorrectionManifest();
  delete manifest.batch.batchId;
  const filePath = await writeJson("correction-missing-batch-id.json", manifest);
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /batch\.batchId/);
});

test("v2 ledger correction rejects missing correction metadata", async (context) => {
  const cases = [
    ["candidateRevision", (manifest) => delete manifest.operation.candidateRevision],
    ["scopeStart", (manifest) => delete manifest.operation.correctionPolicy.scopeStart],
    ["physicalRange", (manifest) => delete manifest.operation.correctionPolicy.physicalRange],
    ["expectedScopedAmount", (manifest) => delete manifest.operation.expectedScopedAmount],
  ];
  for (const [name, remove] of cases) {
    await context.test(name, async () => {
      const manifest = makeCorrectionManifest();
      remove(manifest);
      const filePath = await writeJson(`correction-missing-${name}.json`, manifest);
      const result = runJsonScript(auditScript, [filePath]);
      assert.equal(result.status, 1);
      assert.equal(result.payload.ok, false);
    });
  }
});

test("v2 ledger correction rejects multiple current candidates", async () => {
  const manifest = makeCorrectionManifest();
  manifest.files.find((file) => file.id === "candidate-prior").current = true;
  const filePath = await writeJson("correction-multiple-current.json", manifest);
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /exactly one current candidate/);
});

test("v2 ledger correction rejects a non-zero expected amount delta", async () => {
  const manifest = makeCorrectionManifest();
  manifest.operation.expectedAmountDelta = "0.001";
  const filePath = await writeJson("correction-nonzero-delta.json", manifest);
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.match(result.payload.error, /expectedAmountDelta/);
});

test("v2 settlement is independent from category and drives reimbursed totals", async () => {
  const manifest = makeV2ReimbursementManifest(
    [
      {
        id: "TX-EMPLOYEE",
        date: "2024-01-01",
        person: "匿名甲",
        project: "匿名项目",
        label: "匿名甲",
        amount: "10",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
      },
      {
        id: "TX-COMPANY",
        date: "2024-01-02",
        person: "匿名乙",
        project: "匿名项目",
        label: "匿名对公",
        amount: "2",
        category: "小红书报销",
        settlement: "company_paid_no_reimbursement",
        evidence: ["IMG-001"],
      },
    ],
    { fee: "12", real: "10", category: "12" },
  );
  const manifestPath = await writeJson("settlement-manifest.json", manifest);
  const audited = runJsonScript(auditScript, [manifestPath]);
  assert.equal(audited.status, 0);
  assert.deepEqual(audited.payload.categoryTotals, { 小红书报销: "12" });
  assert.deepEqual(audited.payload.categoryRealTotals, { 小红书报销: "10" });
  assert.deepEqual(audited.payload.settlementTotals, {
    employee_reimbursement: "10",
    company_paid_no_reimbursement: "2",
  });

  const summaryPath = await writeJson("settlement-summary.json", {
    period: "2024年1月1日-1月2日",
    targetCategory: "小红书报销",
    entries: manifest.transactions.map(({ id, label, amount, category, settlement }) => ({
      id,
      label,
      amount,
      category,
      settlement,
    })),
    expectedFeeTotal: "12",
    expectedRealTotal: "10",
    expectedCategoryTotals: { 小红书报销: "12" },
  });
  const summarized = runJsonScript(summaryScript, ["--input", summaryPath, "--preview"]);
  assert.equal(summarized.status, 0);
  assert.equal(summarized.payload.feeTotal, "12");
  assert.equal(summarized.payload.realTotal, "10");
  assert.match(summarized.payload.summary, /费用合计：12/);
});

test("v2 factsDigest ignores presentation paths/revisions and changes with business facts", async () => {
  const baseManifest = makeV2ReimbursementManifest(
    [
      {
        id: "TX-DIGEST-001",
        date: "2024-01-03",
        person: "匿名甲",
        project: "匿名项目甲",
        label: "匿名甲",
        amount: "4.5",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
      },
    ],
    { fee: "4.5", real: "4.5", category: "4.5" },
  );
  const presentationOnly = structuredClone(baseManifest);
  presentationOnly.batch.reviewRevision = 7;
  presentationOnly.batch.archivePath = path.join(tempDir, "alternate-archive");
  const businessChanged = structuredClone(baseManifest);
  businessChanged.transactions[0].project = "匿名项目乙";

  const [basePath, presentationPath, businessPath] = await Promise.all([
    writeJson("facts-digest-base.json", baseManifest),
    writeJson("facts-digest-presentation.json", presentationOnly),
    writeJson("facts-digest-business.json", businessChanged),
  ]);
  const base = runJsonScript(auditScript, [basePath]);
  const presentation = runJsonScript(auditScript, [presentationPath]);
  const business = runJsonScript(auditScript, [businessPath]);
  assert.equal(base.status, 0, base.payload.error);
  assert.equal(presentation.status, 0, presentation.payload.error);
  assert.equal(business.status, 0, business.payload.error);
  assert.match(base.payload.factsDigest, /^[0-9a-f]{64}$/);
  assert.match(base.payload.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(base.payload.factsDigest, presentation.payload.factsDigest);
  assert.notEqual(base.payload.factsDigest, business.payload.factsDigest);
  assert.equal(base.payload.evidenceDigest, presentation.payload.evidenceDigest);
  assert.equal(base.payload.normalizedTransactions[0].sourceOrder, 1);
});

test("v2 reimbursement requires unique positive sourceOrder values", async (context) => {
  const transactions = [
    {
      id: "TX-ORDER-001",
      date: "2024-01-01",
      person: "匿名甲",
      project: "匿名项目",
      label: "匿名甲",
      amount: "1",
      category: "小红书报销",
      settlement: "employee_reimbursement",
      evidence: ["IMG-001"],
    },
    {
      id: "TX-ORDER-002",
      date: "2024-01-02",
      person: "匿名乙",
      project: "匿名项目",
      label: "匿名乙",
      amount: "2",
      category: "小红书报销",
      settlement: "employee_reimbursement",
      evidence: ["IMG-001"],
    },
  ];

  await context.test("missing sourceOrder", async () => {
    const manifest = makeV2ReimbursementManifest(transactions, { fee: "3", real: "3", category: "3" });
    delete manifest.transactions[0].sourceOrder;
    const manifestPath = await writeJson("source-order-missing.json", manifest);
    const result = runJsonScript(auditScript, [manifestPath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /sourceOrder.*positive safe integer/);
  });

  await context.test("duplicate sourceOrder", async () => {
    const manifest = makeV2ReimbursementManifest(transactions, { fee: "3", real: "3", category: "3" });
    manifest.transactions[1].sourceOrder = manifest.transactions[0].sourceOrder;
    const manifestPath = await writeJson("source-order-duplicate.json", manifest);
    const result = runJsonScript(auditScript, [manifestPath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /Duplicate sourceOrder/);
  });
});

test("summary --manifest matches its sourceOrder-sorted mechanical projection", async () => {
  const manifest = makeV2ReimbursementManifest(
    [
      {
        id: "TX-PROJECTION-LATER",
        date: "2024-01-02",
        person: "匿名乙",
        project: "匿名项目",
        label: "匿名乙",
        amount: "2",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
      },
      {
        id: "TX-PROJECTION-EARLIER",
        date: "2024-01-01",
        person: "匿名甲",
        project: "匿名项目",
        label: "匿名甲",
        amount: "1",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
      },
    ],
    { fee: "3", real: "3", category: "3" },
  );
  manifest.transactions[0].sourceOrder = 2;
  manifest.transactions[1].sourceOrder = 1;
  const manifestPath = await writeJson("summary-direct-manifest.json", manifest);
  const direct = runJsonScript(summaryScript, [
    "--manifest",
    path.relative(process.cwd(), manifestPath),
    "--preview",
  ]);
  assert.equal(direct.status, 0, direct.payload.error);

  const projectionPath = await writeJson("summary-equivalent-projection.json", {
    period: manifest.batch.period,
    targetCategory: manifest.batch.targetCategory,
    entries: [...manifest.transactions]
      .sort((left, right) => left.sourceOrder - right.sourceOrder)
      .map(({ id, label, amount, category, settlement, adjustment }) => ({
        id,
        label,
        amount,
        category,
        settlement,
        ...(adjustment ? { adjustment } : {}),
      })),
    expectedFeeTotal: manifest.expectedFeeTotal,
    expectedRealTotal: manifest.expectedRealTotal,
    expectedCategoryTotals: manifest.expectedCategoryTotals,
  });
  const projected = runJsonScript(summaryScript, ["--input", projectionPath, "--preview"]);
  assert.equal(projected.status, 0, projected.payload.error);
  assert.equal(direct.payload.summary, projected.payload.summary);
  assert.equal(direct.payload.textSha256, projected.payload.textSha256);
  assert.match(direct.payload.factsDigest, /^[0-9a-f]{64}$/);
  assert.match(direct.payload.manifestFileSha256, /^[0-9a-f]{64}$/);
  assert.ok(direct.payload.summary.indexOf("匿名甲：1") < direct.payload.summary.indexOf("匿名乙：2"));
});

test("summary --manifest rejects invalid business facts and file hashes", async (context) => {
  const baseManifest = makeV2ReimbursementManifest(
    [
      {
        id: "TX-INVALID-001",
        date: "2024-01-01",
        person: "匿名甲",
        project: "匿名项目",
        label: "匿名甲",
        amount: "1",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
      },
    ],
    { fee: "1", real: "1", category: "1" },
  );

  await context.test("invalid business field", async () => {
    const manifest = structuredClone(baseManifest);
    manifest.transactions[0].date = "2024-02-30";
    const manifestPath = await writeJson("summary-invalid-business-manifest.json", manifest);
    const result = runJsonScript(summaryScript, ["--manifest", manifestPath, "--preview"]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /Manifest audit failed.*valid ISO date/);
  });

  await context.test("invalid material hash", async () => {
    const manifest = structuredClone(baseManifest);
    manifest.files.find((file) => file.id === "IMG-001").sha256 = "0".repeat(64);
    const manifestPath = await writeJson("summary-invalid-hash-manifest.json", manifest);
    const result = runJsonScript(summaryScript, ["--manifest", manifestPath, "--preview"]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /Manifest audit failed.*SHA256 mismatch/);
  });
});

test("the same label may legitimately use both settlement modes", async () => {
  const employee = {
    id: "TX-SAME-LABEL-EMPLOYEE",
    date: "2024-01-01",
    person: "匿名甲",
    project: "匿名项目",
    label: "匿名甲",
    amount: "10",
    category: "小红书报销",
    settlement: "employee_reimbursement",
    evidence: ["IMG-001"],
  };
  const manifest = makeV2ReimbursementManifest(
    [
      employee,
      {
        ...employee,
        id: "TX-SAME-LABEL-COMPANY-PAID",
        amount: "2",
        settlement: "company_paid_no_reimbursement",
      },
    ],
    { fee: "12", real: "10", category: "12" },
  );
  const manifestPath = await writeJson("same-label-two-settlements.json", manifest);
  const audited = runJsonScript(auditScript, [manifestPath]);
  assert.equal(audited.status, 0, audited.payload.error);

  const summaryPath = await writeJson("same-label-two-settlements-summary.json", {
    period: manifest.batch.period,
    targetCategory: manifest.batch.targetCategory,
    entries: manifest.transactions.map(({ id, label, amount, category, settlement }) => ({
      id,
      label,
      amount,
      category,
      settlement,
    })),
    expectedFeeTotal: "12",
    expectedRealTotal: "10",
    expectedCategoryTotals: { [manifest.batch.targetCategory]: "12" },
  });
  const summarized = runJsonScript(summaryScript, ["--input", summaryPath, "--preview"]);
  assert.equal(summarized.status, 0, summarized.payload.error);
  assert.equal(summarized.payload.feeTotal, "12");
  assert.equal(summarized.payload.realTotal, "10");
});

test("sourced negative refunds are accepted and unsafe negatives are rejected", async (context) => {
  const transactions = [
    {
      id: "TX-ORIGINAL",
      date: "2024-01-01",
      person: "匿名甲",
      project: "匿名项目",
      label: "匿名甲",
      amount: "10",
      category: "小红书报销",
      settlement: "employee_reimbursement",
      evidence: ["IMG-001"],
    },
    {
      id: "TX-REFUND",
      date: "2024-01-02",
      person: "匿名甲",
      project: "匿名项目",
      label: "匿名甲",
      amount: "-2",
      category: "小红书报销",
      settlement: "employee_reimbursement",
      evidence: ["IMG-001"],
      adjustment: {
        type: "refund",
        sourceTransactionId: "TX-ORIGINAL",
        reason: "匿名退款",
      },
    },
  ];

  await context.test("manifest and summary calculate the signed net amount", async () => {
    const manifest = makeV2ReimbursementManifest(transactions, { fee: "8", real: "8", category: "8" });
    const manifestPath = await writeJson("negative-refund-valid.json", manifest);
    const audited = runJsonScript(auditScript, [manifestPath]);
    assert.equal(audited.status, 0);
    assert.equal(audited.payload.categoryTotals.小红书报销, "8");

    const summaryPath = await writeJson("negative-refund-summary.json", {
      period: "2024年1月1日-1月2日",
      targetCategory: "小红书报销",
      entries: transactions.map(({ id, label, amount, category, settlement, adjustment }) => ({
        id,
        label,
        amount,
        category,
        settlement,
        ...(adjustment ? { adjustment } : {}),
      })),
      expectedFeeTotal: "8",
      expectedRealTotal: "8",
      expectedCategoryTotals: { 小红书报销: "8" },
    });
    const summarized = runJsonScript(summaryScript, ["--input", summaryPath, "--preview"]);
    assert.equal(summarized.status, 0);
    assert.equal(summarized.payload.feeTotal, "8");
    assert.match(summarized.payload.summary, /匿名甲：8/);
  });

  await context.test("negative amount without provenance is rejected", async () => {
    const unsafeTransactions = structuredClone(transactions);
    delete unsafeTransactions[1].adjustment;
    const manifest = makeV2ReimbursementManifest(unsafeTransactions, { fee: "8", real: "8", category: "8" });
    const manifestPath = await writeJson("negative-refund-unsafe.json", manifest);
    const audited = runJsonScript(auditScript, [manifestPath]);
    assert.equal(audited.status, 1);
    assert.match(audited.payload.error, /adjustment must be an object/);
  });

  await context.test("a sourced negative adjustment is also accepted", async () => {
    const adjustedTransactions = structuredClone(transactions);
    adjustedTransactions[1].amount = "-3";
    adjustedTransactions[1].adjustment.type = "adjustment";
    adjustedTransactions[1].adjustment.reason = "匿名冲正";
    const manifest = makeV2ReimbursementManifest(adjustedTransactions, {
      fee: "7",
      real: "7",
      category: "7",
    });
    const manifestPath = await writeJson("negative-adjustment-valid.json", manifest);
    const audited = runJsonScript(auditScript, [manifestPath]);
    assert.equal(audited.status, 0);
    assert.equal(audited.payload.categoryTotals.小红书报销, "7");
  });
});
