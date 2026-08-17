import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  finalizeReimbursementWorkflow,
  prepareReimbursementWorkflow,
  publishReimbursementWorkflow,
  WORKFLOW_PREPARE_KIND,
} from "../scripts/run_reimbursement_workflow.mjs";
import { readStableBinaryFile } from "../scripts/workflow_primitives.mjs";

const APPROVED_ROOT = "C:\\Users\\a1055\\Desktop\\Word和Excel文档\\skill测试\\成品_批准版式_v3_终验";
const PROFILES = [
  { id: "xiaohongshu", source: ["01_小红书专项", "小红书支出总表.xlsx"], input: "小红书支出总表.xlsx", canonical: "小红书支出总表.xlsx", category: "小红书报销" },
  { id: "company", source: ["02_公司专项", "公司支出总表.xlsx"], input: "公司支出总表.xlsx", canonical: "公司支出总表.xlsx", category: "公司报销" },
  { id: "residence", source: ["03_住所专项", "住所支出.xlsx"], input: "住所支出.xlsx", canonical: "驻所支出.xlsx", category: "驻所报销" },
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PREVIEW_PNG = Buffer.concat([PNG, Buffer.alloc(1024)]);
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tempRoot;
let approvedAvailable = true;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function renderTestPreviews({ request, requestFileSha256 }) {
  const previews = [];
  for (const job of request.jobs) {
    await fs.writeFile(job.outputPath, PREVIEW_PNG, { flag: "wx" });
    previews.push({
      profileId: job.profileId,
      role: job.role,
      workbookSha256: job.workbookSha256,
      outputPath: job.outputPath,
      sha256: sha256(PREVIEW_PNG),
      size: PREVIEW_PNG.length,
    });
  }
  return {
    kind: "ordinary-reimbursement-preview-response-v1",
    requestNonce: request.requestNonce,
    requestFileSha256,
    enginePeakWorkingSetBytes: 64 * 1024 * 1024,
    previews,
  };
}

const TEST_HOOKS = { runPreviewRenderer: renderTestPreviews };

async function scenario(profileCount, { separateProfileRoots = false, supplement = false, createArchive = true } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const root = path.join(tempRoot, `scenario-${profileCount}-${token.slice(0, 8)}`);
  const archive = path.join(root, "archive");
  await fs.mkdir(root);
  if (createArchive) await fs.mkdir(archive);
  const selected = PROFILES.slice(0, profileCount);
  const baselines = [];
  for (const profile of selected) {
    const profileRoot = separateProfileRoots ? path.join(root, profile.id) : root;
    if (separateProfileRoots) await fs.mkdir(profileRoot);
    const destination = path.join(profileRoot, profile.input);
    await fs.copyFile(path.join(APPROVED_ROOT, ...profile.source), destination, fs.constants.COPYFILE_EXCL);
    const stable = await readStableBinaryFile(destination);
    baselines.push({ profileId: profile.id, path: destination, sha256: stable.sha256, size: stable.size, candidateRevision: 1 });
  }
  const imagePath = path.join(root, "evidence.png");
  await fs.writeFile(imagePath, PNG, { flag: "wx" });
  const transactions = selected.map((profile, index) => ({
    id: `TX-${profile.id}`,
    sourceOrder: index + 1,
    date: supplement ? `2026-07-${String(3 + index).padStart(2, "0")}` : `2026-08-${String(20 + index).padStart(2, "0")}`,
    person: `脱敏人员${index + 1}`,
    project: `${supplement ? "补报" : "完整链路"}项目${index + 1}`,
    label: `脱敏人员${index + 1}`,
    classification: `完整链路分类${index + 1}`,
    amount: `${index + 1}.125`,
    category: profile.category,
    settlement: index === 1 ? "company_paid_no_reimbursement" : "employee_reimbursement",
    evidence: ["IMG-1"],
    sourceRefs: [`UNIT-${index + 1}`],
  }));
  const manifest = {
    version: 3,
    rulesVersion: "ordinary-reimbursement-workflow-integration-v1",
    batch: { batchId: `workflow-${token}`, rootPath: root, archivePath: archive, period: "2026-08-20—2026-08-22", targetCategory: "小红书报销", reviewRevision: 1 },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baselines[0].path, sha256: baselines[0].sha256 },
      { id: "IMG-1", role: "material", path: imagePath, sha256: sha256(PNG), kind: "image", disposition: "used" },
    ],
    sourceScopes: [{ id: "SCOPE-1", fileId: "IMG-1", locator: "full-image", terminalConfirmed: true, expectedUnitCount: profileCount }],
    sourceUnits: transactions.map((_, index) => ({ id: `UNIT-${index + 1}`, scopeId: "SCOPE-1", locator: `region-${index + 1}`, disposition: "used" })),
    transactions,
    expectedFeeTotal: transactions[0].amount,
    expectedRealTotal: transactions[0].amount,
    expectedCategoryTotals: Object.fromEntries(transactions.map((item) => [item.category, item.amount])),
  };
  const manifestPath = path.join(root, "batch-manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
  return { token, root, archive, selected, baselines, manifestPath, manifestSha256: sha256(manifestBytes) };
}

test.before(async () => {
  try {
    await fs.access(path.join(APPROVED_ROOT, ...PROFILES[0].source));
  } catch {
    approvedAvailable = false;
    return;
  }
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-workflow-test-"));
});

test.after(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("approved roots complete the ordinary 1/2/3-profile workflow with one prepare audit worker", async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  for (const profileCount of [1, 2, 3]) {
    await t.test(`${profileCount} profile(s)`, async () => {
      const input = await scenario(profileCount);
      let workerCount = 0;
      const prepared = await prepareReimbursementWorkflow({
        kind: WORKFLOW_PREPARE_KIND,
        stagingToken: input.token,
        manifestPath: input.manifestPath,
        manifestSha256: input.manifestSha256,
        baselines: input.baselines,
      }, { testHooks: { ...TEST_HOOKS, onWorkerSpawn() { workerCount += 1; } } });
      assert.equal(workerCount, 1);
      assert.deepEqual(prepared.affectedProfileIds, input.selected.map((item) => item.id));
      assert.equal(prepared.review.length, profileCount);
      assert.equal(prepared.review.every((item) => item.previews.length === 3), true);
      assert.match(prepared.review[0].summary, /费用合计：/u);
      const finalized = await finalizeReimbursementWorkflow(
        { statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "本次报销通过无误" },
        { testHooks: TEST_HOOKS },
      );
      assert.equal(finalized.review.length, profileCount);
      for (const review of finalized.review) {
        assert.equal(review.previews.length, 3);
        for (const preview of review.previews) {
          const stable = await readStableBinaryFile(preview.path);
          assert.equal(stable.sha256, preview.sha256);
          assert.equal(preview.sourceSha256, preview.role === "root"
            ? prepared.review.find((item) => item.profileId === review.profileId).previews.find((item) => item.role === "root").sourceSha256
            : review[preview.role].sha256);
        }
      }
      const published = await publishReimbursementWorkflow({
        statePath: finalized.statePath,
        expectedGate1BindingDigest: prepared.gate1BindingDigest,
        gate1ApprovalText: "本次报销通过无误",
        expectedGate2BindingDigest: finalized.gate2BindingDigest,
        gate2ApprovalText: "确认更新根目录支出总表",
      });
      assert.deepEqual(published.affectedProfileIds, input.selected.map((item) => item.id));
      assert.equal(published.outputs.length, profileCount);
      for (const [index, output] of published.outputs.entries()) {
        assert.equal(path.basename(output.root.path), input.selected[index].canonical);
        assert.equal((await readStableBinaryFile(output.root.path)).sha256, output.root.sha256);
        assert.equal((await readStableBinaryFile(output.detail.path)).sha256, output.detail.sha256);
        assert.equal((await readStableBinaryFile(output.screenshot.path)).sha256, output.screenshot.sha256);
        assert.equal((await readStableBinaryFile(output.summary.path)).sha256, output.summary.sha256);
        assert.equal((await readStableBinaryFile(output.snapshot.path)).sha256, output.root.sha256);
        assert.match(path.basename(output.detail.path), /^\d{4}-\d{2}-\d{2}.*_本次报销明细\.xlsx$/u);
        assert.match(path.basename(output.screenshot.path), /^\d{4}-\d{2}-\d{2}.*_报销明细对应截图表\.xlsx$/u);
        assert.match(path.basename(output.summary.path), /^\d{4}-\d{2}-\d{2}.*_报销文字说明\.odt$/u);
        assert.match(path.basename(output.snapshot.path), /^\d{4}-\d{2}-\d{2}.*快照\.xlsx$/u);
        assert.match(path.basename(path.dirname(output.evidenceArchive[0].path)), /^\d{4}-\d{2}-\d{2}.*_报销截图$/u);
        assert.equal(output.evidenceArchive.length, 1);
        assert.equal((await readStableBinaryFile(output.evidenceArchive[0].path)).sha256, sha256(PNG));
        assert.match(output.publishAuditDigest, /^[0-9a-f]{64}$/u);
      }
      const archivedFiles = (await fs.readdir(input.archive, { recursive: true }))
        .filter((entry) => typeof entry === "string")
        .map((entry) => path.join(input.archive, entry));
      assert.equal(archivedFiles.some((filePath) => filePath.endsWith(".json")), false);
      for (const profile of PROFILES.slice(profileCount)) {
        await assert.rejects(() => fs.stat(path.join(input.archive, profile.id)), { code: "ENOENT" });
      }
      assert.equal(published.cleanup.preserved.length, 0);
      assert.equal(published.cleanup.failures.length, 0);
      await assert.rejects(() => fs.stat(path.join(os.tmpdir(), `codex-xhs-workflow-${input.token}`)), { code: "ENOENT" });
    });
  }
});

test("publication creates the bound batch archive directory when it is absent", async () => {
  if (!approvedAvailable) return;
  const input = await scenario(1, { createArchive: false });
  const prepared = await prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: input.token,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    baselines: input.baselines,
  }, { testHooks: TEST_HOOKS });
  const finalized = await finalizeReimbursementWorkflow({
    statePath: prepared.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    approvalText: "本次报销通过无误",
  }, { testHooks: TEST_HOOKS });
  const published = await publishReimbursementWorkflow({
    statePath: finalized.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    gate1ApprovalText: "本次报销通过无误",
    expectedGate2BindingDigest: finalized.gate2BindingDigest,
    gate2ApprovalText: "确认更新根目录支出总表",
  });
  assert.equal((await fs.stat(input.archive)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(input.archive, "01_小红书专项"))).isDirectory(), true);
  assert.equal(published.cleanup.preserved.length, 0);
  assert.equal(published.cleanup.failures.length, 0);
});

test("production workflow batches all Gate 1 previews through the real spreadsheet renderer", {
  skip: process.env.CODEX_RUN_REAL_SPREADSHEET_RENDER !== "1" ? "set CODEX_RUN_REAL_SPREADSHEET_RENDER=1" : false,
}, async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  const profileCount = Number(process.env.CODEX_RENDER_PROFILE_COUNT ?? "1");
  assert.ok([1, 2, 3].includes(profileCount));
  const started = performance.now();
  const input = await scenario(profileCount, { separateProfileRoots: process.env.CODEX_SEPARATE_PROFILE_ROOTS === "1" });
  const preparedInputAt = performance.now();
  const prepared = await prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: input.token,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    baselines: input.baselines,
  });
  const gate1At = performance.now();
  assert.equal(prepared.review.length, profileCount);
  for (const review of prepared.review) {
    assert.equal(review.previews.length, 3);
    for (const preview of review.previews) {
      const stable = await readStableBinaryFile(preview.path);
      assert.equal(stable.sha256, preview.sha256);
      assert.ok(preview.width > 1 && preview.height > 1 && stable.size > 1_000);
    }
  }
  const finalized = await finalizeReimbursementWorkflow({ statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "本次报销通过无误" });
  assert.equal(finalized.review.length, profileCount);
  for (const review of finalized.review) {
    assert.equal(review.previews.length, 3);
    for (const preview of review.previews) {
      const stable = await readStableBinaryFile(preview.path);
      assert.equal(stable.sha256, preview.sha256);
      assert.ok(preview.width > 1 && preview.height > 1 && stable.size > 1_000);
    }
  }
  const gate2At = performance.now();
  await publishReimbursementWorkflow({
    statePath: finalized.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    gate1ApprovalText: "本次报销通过无误",
    expectedGate2BindingDigest: finalized.gate2BindingDigest,
    gate2ApprovalText: "确认更新根目录支出总表",
  });
  const publishedAt = performance.now();
  if (process.env.CODEX_PERF_TRACE === "1") {
    console.log(JSON.stringify({ kind: "workflow-stage-trace", profileCount, inputPreparationMs: preparedInputAt - started, prepareToGate1Ms: gate1At - preparedInputAt, gate1ToGate2Ms: gate2At - gate1At, gate2PublishVerifyMs: publishedAt - gate2At, totalMs: publishedAt - started, maxRssKilobytes: process.resourceUsage().maxRSS }));
  }
});

test("Gate 2 preview mutation rejects publication before roots change", async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  const input = await scenario(1);
  const baseline = await readStableBinaryFile(input.baselines[0].path);
  const prepared = await prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: input.token,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    baselines: input.baselines,
  }, { testHooks: TEST_HOOKS });
  const finalized = await finalizeReimbursementWorkflow(
    { statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "本次报销通过无误" },
    { testHooks: TEST_HOOKS },
  );
  await fs.appendFile(finalized.review[0].previews[0].path, Buffer.from("preview mutation"));
  await assert.rejects(() => publishReimbursementWorkflow({
    statePath: finalized.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    gate1ApprovalText: "本次报销通过无误",
    expectedGate2BindingDigest: finalized.gate2BindingDigest,
    gate2ApprovalText: "确认更新根目录支出总表",
  }), /preview|changed|bound/iu);
  assert.equal((await readStableBinaryFile(input.baselines[0].path)).sha256, baseline.sha256);
});

test("historical-date supplement completes the ordinary audited workflow", async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  const supplementTemplate = path.join(SKILL_ROOT, "assets", "templates", "补报明细模板.xlsx");
  await fs.access(supplementTemplate);
  const input = await scenario(1, { supplement: true });
  const prepared = await prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: input.token,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    baselines: input.baselines,
  }, { testHooks: TEST_HOOKS });
  assert.match(prepared.review[0].detail.path, /2026-08-20.*本次报销明细/u);
  const finalized = await finalizeReimbursementWorkflow(
    { statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "本次报销通过无误" },
    { testHooks: TEST_HOOKS },
  );
  const published = await publishReimbursementWorkflow({
    statePath: finalized.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    gate1ApprovalText: "本次报销通过无误",
    expectedGate2BindingDigest: finalized.gate2BindingDigest,
    gate2ApprovalText: "确认更新根目录支出总表",
  });
  assert.equal(published.outputs.length, 1);
  assert.match(path.basename(published.outputs[0].snapshot.path), /^2026-08-20.*快照\.xlsx$/u);
});

test("Gate texts and binding digests are fail-closed before publication", async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  const input = await scenario(1);
  const prepared = await prepareReimbursementWorkflow({ kind: WORKFLOW_PREPARE_KIND, stagingToken: input.token, manifestPath: input.manifestPath, manifestSha256: input.manifestSha256, baselines: input.baselines }, { testHooks: TEST_HOOKS });
  await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "通过" }), /approval text|Gate 1/iu);
  await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: prepared.statePath, expectedGate1BindingDigest: "0".repeat(64), approvalText: "本次报销通过无误" }), /binding digest/iu);
});

test("multi-profile publication failure restores earlier roots and removes only owned archive files", async (t) => {
  if (!approvedAvailable) return t.skip("approved root fixtures are unavailable");
  const input = await scenario(2);
  const original = await Promise.all(input.baselines.map((item) => readStableBinaryFile(item.path)));
  const prepared = await prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: input.token,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    baselines: input.baselines,
  }, { testHooks: TEST_HOOKS });
  const finalized = await finalizeReimbursementWorkflow(
    { statePath: prepared.statePath, expectedGate1BindingDigest: prepared.gate1BindingDigest, approvalText: "本次报销通过无误" },
    { testHooks: TEST_HOOKS },
  );
  const collisionDirectory = path.join(input.archive, "02_公司专项");
  await fs.mkdir(collisionDirectory);
  const collisionPath = path.join(collisionDirectory, path.basename(prepared.review[1].detail.path));
  const externalBytes = Buffer.from("external archive owner\n");
  await fs.writeFile(collisionPath, externalBytes, { flag: "wx" });
  await assert.rejects(() => publishReimbursementWorkflow({
    statePath: finalized.statePath,
    expectedGate1BindingDigest: prepared.gate1BindingDigest,
    gate1ApprovalText: "本次报销通过无误",
    expectedGate2BindingDigest: finalized.gate2BindingDigest,
    gate2ApprovalText: "确认更新根目录支出总表",
  }), /exist|copy|archive/iu);
  for (const [index, baseline] of input.baselines.entries()) {
    assert.equal((await readStableBinaryFile(baseline.path)).sha256, original[index].sha256);
  }
  assert.equal((await fs.readFile(collisionPath)).equals(externalBytes), true);
  await assert.rejects(() => fs.stat(path.join(input.archive, "01_小红书专项")), { code: "ENOENT" });
});
