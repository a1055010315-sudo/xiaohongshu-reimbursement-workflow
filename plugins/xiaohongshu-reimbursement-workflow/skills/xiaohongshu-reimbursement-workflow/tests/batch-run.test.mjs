import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalDigest, sha256FileFresh } from "../scripts/batch_cache.mjs";
import { buildBatchGateArtifact } from "../scripts/build_batch_gate_artifact.mjs";
import { digestObject, normalizeBatchPlan } from "../scripts/reimbursement_workbook_common.mjs";
import { prepareReimbursementBatch } from "../scripts/run_reimbursement_batch.mjs";

const REVIEW_ARTIFACT_SCRIPT = fileURLToPath(new URL("../scripts/build_reimbursement_review_artifacts.mjs", import.meta.url));

const NAMES = {
  xiaohongshu: "小红书支出总表.xlsx",
  company: "公司支出总表.xlsx",
  residence: "驻所支出.xlsx",
};
const DIRECTORIES = {
  xiaohongshu: "01_小红书专项",
  company: "02_公司专项",
  residence: "03_驻所专项",
};
const CATEGORIES = { xiaohongshu: "小红书报销", company: "公司报销", residence: "驻所报销" };

async function writeBoundFile(filePath, bytes) {
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: await sha256FileFresh(filePath) };
}

async function sourceCoverage(taskRoot, profileId, batchId, transaction) {
  const manifest = await writeBoundFile(path.join(taskRoot, `${profileId}-manifest.json`), `${profileId}:manifest`);
  const core = {
    ok: true,
    kind: "reimbursement-manifest-audit",
    validatorVersion: "4",
    manifest: manifest.path,
    manifestFileSha256: manifest.sha256,
    batch: { batchId },
    operation: { mode: "reimbursement-batch" },
    profileId,
    sourceCoverageDigest: "d".repeat(64),
    sourceCoverageCounts: { scopes: 1, units: 1, usedUnits: 1, excludedUnits: 0 },
    normalizedTransactions: [{
      ...transaction,
      category: CATEGORIES[profileId],
      sourceRefs: [`${profileId}-source-1`],
    }],
  };
  return writeBoundFile(
    path.join(taskRoot, `${profileId}-source-coverage.json`),
    `${JSON.stringify({ ...core, certificateDigest: canonicalDigest(core) })}\n`,
  );
}

async function fixture(t, profileIds) {
  const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-run-"));
  t.after(() => fs.rm(taskRoot, { recursive: true, force: true }));
  const profiles = {};
  for (const [index, profileId] of profileIds.entries()) {
    const baselinePath = path.join(taskRoot, DIRECTORIES[profileId], NAMES[profileId]);
    const candidatePath = path.join(taskRoot, `${profileId}-candidate.xlsx`);
    const detailPath = path.join(taskRoot, `${profileId}-detail.xlsx`);
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, `${profileId}:baseline`);
    profiles[profileId] = {
      baselinePath,
      candidatePath,
      detailPath,
      detailTitle: `${profileId} detail`,
      period: "2026-08-14—2026-08-14",
      candidateRevision: index + 1,
      controlledSegment: { startRow: 2 },
      transactions: [{
        id: `${profileId}-1`,
        date: "2026-08-14",
        project: `${profileId}-expense`,
        amount: index === 0 ? "100" : "100.25",
        person: "anonymous",
        classification: "operation",
        sourceOrder: index + 1,
      }],
    };
  }
  return {
    version: 1,
    batchId: "anonymous-batch",
    taskRoot,
    affectedProfiles: [...profileIds].reverse(),
    profiles,
    outputs: {
      factsSnapshotPath: path.join(taskRoot, "batch-facts.json"),
      buildCertificatePath: path.join(taskRoot, "build-certificate.json"),
      auditCertificatePath: path.join(taskRoot, "audit-certificate.json"),
      batchStatePath: path.join(taskRoot, "batch-state.json"),
    },
  };
}

function injectedImplementations(counters, { corruptAudit = false } = {}) {
  return {
    async buildImpl(raw) {
      counters.build += 1;
      const plan = await normalizeBatchPlan(raw);
      const profiles = [];
      for (const profileId of plan.affectedProfiles) {
        const profile = plan.profiles[profileId];
        await fs.writeFile(profile.candidatePath, `${profileId}:candidate`, { flag: "wx" });
        await fs.writeFile(profile.detailPath, `${profileId}:detail`, { flag: "wx" });
        profiles.push({
          profileId,
          baselinePath: profile.baselinePath,
          baselineSha256: await sha256FileFresh(profile.baselinePath),
          candidatePath: profile.candidatePath,
          candidateSha256: await sha256FileFresh(profile.candidatePath),
          detailPath: profile.detailPath,
          detailSha256: await sha256FileFresh(profile.detailPath),
          planDigest: plan.planDigest,
          styleContractDigest: plan.styleContractDigest,
          profileConfigDigest: plan.profileConfigDigest,
        });
      }
      const core = {
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
      return { ...core, buildDigest: digestObject(core) };
    },
    async auditImpl(raw) {
      counters.audit += 1;
      const plan = await normalizeBatchPlan(raw);
      const profiles = [];
      for (const profileId of plan.affectedProfiles) {
        const profile = plan.profiles[profileId];
        const core = {
          ok: true,
          profileId,
          baselinePath: profile.baselinePath,
          baselineSha256: await sha256FileFresh(profile.baselinePath),
          candidatePath: profile.candidatePath,
          candidateSha256: await sha256FileFresh(profile.candidatePath),
          detailPath: profile.detailPath,
          detailSha256: await sha256FileFresh(profile.detailPath),
          detailAuditDigest: "e".repeat(64),
          detailPersonCount: 1,
          detailTransactionCount: 1,
          planDigest: plan.planDigest,
          styleContractDigest: plan.styleContractDigest,
          profileConfigDigest: plan.profileConfigDigest,
          visualExceptions: [],
        };
        profiles.push({ ...core, auditDigest: digestObject(core) });
      }
      if (corruptAudit) profiles[0].candidateSha256 = "0".repeat(64);
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
    },
  };
}

for (const profileIds of [
  ["xiaohongshu"],
  ["company", "residence"],
  ["xiaohongshu", "company", "residence"],
]) {
  test(`parent batch runs build/audit once for ${profileIds.length} affected profile(s)`, async (t) => {
    const plan = await fixture(t, profileIds);
    const counters = { build: 0, audit: 0 };
    const result = await prepareReimbursementBatch(plan, injectedImplementations(counters));
    assert.equal(counters.build, 1);
    assert.equal(counters.audit, 1);
    assert.equal(result.status, "ready-for-unified-gate-1");
    assert.deepEqual(result.affectedProfiles, ["xiaohongshu", "company", "residence"].filter((id) => profileIds.includes(id)));
    assert.deepEqual(Object.keys(result.profiles), result.affectedProfiles);
    for (const profileId of result.affectedProfiles) {
      assert.equal(result.profiles[profileId].detail.path, plan.profiles[profileId].detailPath);
      assert.match(result.profiles[profileId].detail.sha256, /^[0-9a-f]{64}$/u);
    }
    assert.match(result.stateDigest, /^[0-9a-f]{64}$/u);
    for (const outputPath of Object.values(plan.outputs)) assert.equal((await fs.lstat(outputPath)).isFile(), true);
  });
}

test("parent rejects a forged or mismatched independent audit certificate", async (t) => {
  const plan = await fixture(t, ["company"]);
  const counters = { build: 0, audit: 0 };
  await assert.rejects(
    () => prepareReimbursementBatch(plan, injectedImplementations(counters, { corruptAudit: true })),
    /auditDigest does not match|differs/u,
  );
  await assert.rejects(() => fs.access(plan.outputs.batchStatePath));
});

test("a completed parent batch resumes without rebuilding or re-auditing", async (t) => {
  const plan = await fixture(t, ["residence"]);
  const counters = { build: 0, audit: 0 };
  const first = await prepareReimbursementBatch(plan, injectedImplementations(counters));
  const resumed = await prepareReimbursementBatch(plan, injectedImplementations(counters));
  assert.deepEqual(counters, { build: 1, audit: 1 });
  assert.deepEqual(resumed, first);
});

test("a ready batch produces review artifacts that feed one unified Gate 1", async (t) => {
  const plan = await fixture(t, ["company", "residence"]);
  const counters = { build: 0, audit: 0 };
  const ready = await prepareReimbursementBatch(plan, injectedImplementations(counters));
  const reviewRequest = {
    version: 1,
    batchStatePath: plan.outputs.batchStatePath,
    profiles: {},
    outputs: {
      previewIndexPath: path.join(plan.taskRoot, "preview-index.json"),
      reviewPackagePath: path.join(plan.taskRoot, "review-package.json"),
    },
  };
  for (const profileId of ready.affectedProfiles) {
    const renderPath = path.join(plan.taskRoot, `${profileId}-preview.png`);
    await fs.writeFile(renderPath, `${profileId}:render`);
    reviewRequest.profiles[profileId] = { renders: [renderPath] };
  }
  const reviewRequestPath = path.join(plan.taskRoot, "review-artifact-request.json");
  await fs.writeFile(reviewRequestPath, `${JSON.stringify(reviewRequest)}\n`, { flag: "wx" });
  const built = spawnSync(process.execPath, [REVIEW_ARTIFACT_SCRIPT, "--input", reviewRequestPath], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const review = JSON.parse(built.stdout);
  assert.equal(review.status, "review-artifacts-created");
  assert.deepEqual(review.affectedProfiles, ready.affectedProfiles);
  const repeated = spawnSync(process.execPath, [REVIEW_ARTIFACT_SCRIPT, "--input", reviewRequestPath], { encoding: "utf8" });
  assert.notEqual(repeated.status, 0);
  assert.match(JSON.parse(repeated.stderr).error, /already exists; refusing to overwrite/u);

  const facts = JSON.parse(await fs.readFile(ready.facts.path, "utf8"));
  const coverages = {};
  for (const profileId of ready.affectedProfiles) {
    coverages[profileId] = await sourceCoverage(
      plan.taskRoot,
      profileId,
      ready.batchId,
      facts.profiles[profileId].transactions[0],
    );
  }
  const gate1 = await buildBatchGateArtifact({
    version: 1,
    gate: "gate-1",
    batchId: ready.batchId,
    affectedProfiles: ready.affectedProfiles,
    factsPath: ready.facts.path,
    factsSha256: ready.facts.sha256,
    profiles: Object.fromEntries(ready.affectedProfiles.map((profileId) => {
      const profile = ready.profiles[profileId];
      return [profileId, {
        baselinePath: profile.baseline.path,
        baselineSha256: profile.baseline.sha256,
        candidatePath: profile.candidate.path,
        candidateSha256: profile.candidate.sha256,
        candidateRevision: profile.candidateRevision,
        candidatePlanPath: profile.candidatePlan.path,
        candidatePlanSha256: profile.candidatePlan.sha256,
        detailPath: profile.detail.path,
        detailSha256: profile.detail.sha256,
        sourceCoveragePath: coverages[profileId].path,
        sourceCoverageSha256: coverages[profileId].sha256,
        auditPath: profile.audit.path,
        auditSha256: profile.audit.sha256,
        previewIndexPath: review.previewIndex.path,
        previewIndexSha256: review.previewIndex.sha256,
        reviewPackagePath: review.reviewPackage.path,
        reviewPackageSha256: review.reviewPackage.sha256,
      }];
    })),
  });
  assert.equal(gate1.context.gate, "gate-1");
  assert.deepEqual(gate1.context.affectedProfiles, ready.affectedProfiles);
  assert.match(gate1.bindingDigest, /^[0-9a-f]{64}$/u);
});

test("a batch resumes at independent audit after the build stage was certified", async (t) => {
  const plan = await fixture(t, ["company"]);
  const counters = { build: 0, audit: 0 };
  const implementations = injectedImplementations(counters);
  await assert.rejects(
    () => prepareReimbursementBatch(plan, {
      ...implementations,
      async auditImpl() {
        counters.audit += 1;
        throw new Error("simulated audit interruption");
      },
    }),
    /simulated audit interruption/u,
  );
  assert.equal(counters.build, 1);
  assert.equal(counters.audit, 1);
  const resumed = await prepareReimbursementBatch(plan, implementations);
  assert.equal(resumed.status, "ready-for-unified-gate-1");
  assert.deepEqual(counters, { build: 1, audit: 2 });
});

test("a mismatched saved facts snapshot blocks resume before build or audit", async (t) => {
  const plan = await fixture(t, ["xiaohongshu"]);
  await fs.writeFile(plan.outputs.factsSnapshotPath, JSON.stringify({ version: 1, batchId: "other" }));
  const counters = { build: 0, audit: 0 };
  await assert.rejects(
    () => prepareReimbursementBatch(plan, injectedImplementations(counters)),
    /facts snapshot differs/u,
  );
  assert.deepEqual(counters, { build: 0, audit: 0 });
});

test("a later output without its prerequisite stage is rejected", async (t) => {
  const plan = await fixture(t, ["residence"]);
  await fs.writeFile(plan.outputs.batchStatePath, "{}");
  const counters = { build: 0, audit: 0 };
  await assert.rejects(
    () => prepareReimbursementBatch(plan, injectedImplementations(counters)),
    /after an earlier batch stage is missing/u,
  );
  assert.deepEqual(counters, { build: 0, audit: 0 });
});
