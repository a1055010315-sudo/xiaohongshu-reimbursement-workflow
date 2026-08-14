import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalDigest, sha256FileFresh } from "../scripts/batch_cache.mjs";
import { buildBatchGateArtifact } from "../scripts/build_batch_gate_artifact.mjs";
import { buildReimbursementFinalAudit } from "../scripts/build_reimbursement_final_audit.mjs";
import {
  publishReimbursementBatch,
  recoverReimbursementBatch,
} from "../scripts/publish_reimbursement_batch.mjs";
import { digestObject, normalizeBatchPlan } from "../scripts/reimbursement_workbook_common.mjs";

const PROFILE_NAMES = {
  xiaohongshu: "小红书支出总表.xlsx",
  company: "公司支出总表.xlsx",
  residence: "驻所支出.xlsx",
};
const PROFILE_DIRECTORIES = {
  xiaohongshu: "01_小红书专项",
  company: "02_公司专项",
  residence: "03_驻所专项",
};
const PROFILE_CATEGORIES = { xiaohongshu: "小红书报销", company: "公司报销", residence: "驻所报销" };

async function createFile(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return { path: filePath, sha256: await sha256FileFresh(filePath) };
}

async function createAuditFile(root, profileId, baseline, candidate, detail = null) {
  const core = {
    ok: true,
    profileId,
    baselinePath: baseline.path,
    baselineSha256: baseline.sha256,
    candidatePath: candidate.path,
    candidateSha256: candidate.sha256,
    planDigest: "a".repeat(64),
    styleContractDigest: "b".repeat(64),
    profileConfigDigest: "c".repeat(64),
    ...(detail ? { detailPath: detail.path, detailSha256: detail.sha256, detailAuditDigest: "e".repeat(64) } : {}),
  };
  return createFile(
    path.join(root, `${profileId}-audit.json`),
    `${JSON.stringify({ ...core, auditDigest: canonicalDigest(core) })}\n`,
  );
}

async function createFactsFile(root, profileIds, batchId, inputs) {
  const core = {
    version: 1,
    kind: "reimbursement-batch-facts",
    batchId,
    affectedProfiles: profileIds,
    profiles: Object.fromEntries(profileIds.map((profileId) => [profileId, {
      baselinePath: inputs[profileId].baseline.path,
      candidatePath: inputs[profileId].candidate.path,
      detailPath: inputs[profileId].detail?.path ?? null,
      detailTitle: `${profileId} detail`,
      period: "2026-08-14—2026-08-14",
      candidateRevision: 1,
      controlledSegment: { startRow: 2 },
      transactions: [{
        id: `${profileId}-transaction-1`,
        date: "2026-08-14",
        project: `${profileId}-expense`,
        amount: "100",
        decimals: 0,
        person: "anonymous",
        classification: "operation",
        rowType: "expense",
        settlement: "employee_reimbursement",
        settlementDisplay: "待报销",
        sourceOrder: 1,
      }],
    }])),
    planDigest: "a".repeat(64),
    styleContractDigest: "b".repeat(64),
    profileConfigDigest: "c".repeat(64),
  };
  return createFile(path.join(root, "facts.json"), `${JSON.stringify({ ...core, factsDigest: canonicalDigest(core) })}\n`);
}

async function createCoverageFile(root, profileId, batchId) {
  const manifest = await createFile(path.join(root, `${profileId}-manifest.json`), `${profileId}:manifest`);
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
      id: `${profileId}-transaction-1`, sourceOrder: 1, date: "2026-08-14",
      project: `${profileId}-expense`, amount: "100", person: "anonymous",
      classification: "operation", settlement: "employee_reimbursement",
      category: PROFILE_CATEGORIES[profileId], sourceRefs: [`${profileId}-source-1`],
    }],
  };
  return createFile(
    path.join(root, `${profileId}-coverage.json`),
    `${JSON.stringify({ ...core, certificateDigest: canonicalDigest(core) })}\n`,
  );
}

async function fakePostAudit(rawPlan) {
  for (const profileId of rawPlan.affectedProfiles) {
    assert.equal(
      path.basename(path.dirname(rawPlan.profiles[profileId].baselinePath)),
      PROFILE_DIRECTORIES[profileId],
      "post-publish audit must retain the profile parent-directory whitelist",
    );
  }
  const plan = await normalizeBatchPlan(rawPlan);
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
      planDigest: plan.planDigest,
      styleContractDigest: plan.styleContractDigest,
      profileConfigDigest: plan.profileConfigDigest,
      ...(profile.detailPath ? {
        detailPath: profile.detailPath,
        detailSha256: await sha256FileFresh(profile.detailPath),
        detailAuditDigest: "e".repeat(64),
      } : {}),
      visualExceptions: [],
    };
    profiles.push({ ...core, auditDigest: digestObject(core) });
  }
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

async function fakeFinalAudit(rawPlan) {
  const profiles = [];
  for (const profileId of rawPlan.affectedProfiles) {
    const profile = rawPlan.profiles[profileId];
    assert.equal(path.basename(path.dirname(profile.baselinePath)), PROFILE_DIRECTORIES[profileId]);
    const core = {
      ok: true,
      profileId,
      baselinePath: profile.baselinePath,
      baselineSha256: await sha256FileFresh(profile.baselinePath),
      candidatePath: profile.candidatePath,
      candidateSha256: await sha256FileFresh(profile.candidatePath),
      planDigest: "a".repeat(64),
      styleContractDigest: "b".repeat(64),
      profileConfigDigest: "c".repeat(64),
      ...(profile.detailPath ? {
        detailPath: profile.detailPath,
        detailSha256: await sha256FileFresh(profile.detailPath),
        detailAuditDigest: "e".repeat(64),
      } : {}),
      visualExceptions: [],
    };
    profiles.push({ ...core, auditDigest: digestObject(core) });
  }
  const core = {
    ok: true,
    mode: "reimbursement-candidate-audit",
    version: 1,
    batchId: rawPlan.batchId,
    affectedProfiles: rawPlan.affectedProfiles,
    planDigest: "a".repeat(64),
    styleContractDigest: "b".repeat(64),
    profileConfigDigest: "c".repeat(64),
    profiles,
  };
  return { ...core, auditDigest: digestObject(core) };
}

function publish(plan, options = {}) {
  return publishReimbursementBatch(plan, {
    postAuditImpl: fakePostAudit,
    finalAuditImpl: fakeFinalAudit,
    ...options,
  });
}

function recover(plan) {
  return recoverReimbursementBatch(plan, { postAuditImpl: fakePostAudit });
}

async function fixture(t, profileIds) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batch-publish-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const batchId = "anonymous-publish-batch";
  const inputs = {};
  const profiles = {};
  const expected = {};
  for (const profileId of profileIds) {
    const detail = await createFile(path.join(root, "details", `${profileId}-detail.xlsx`), `${profileId}:detail`);
    const baseline = await createFile(
      path.join(root, PROFILE_DIRECTORIES[profileId], PROFILE_NAMES[profileId]),
      `${profileId}:baseline`,
    );
    const candidate = await createFile(
      path.join(root, "candidates", `${profileId}-candidate.xlsx`),
      `${profileId}:candidate`,
    );
    inputs[profileId] = { baseline, candidate, detail };
    expected[profileId] = { baseline, candidate };
  }
  const facts = await createFactsFile(root, profileIds, batchId, inputs);
  for (const profileId of profileIds) {
    const { baseline, candidate, detail } = inputs[profileId];
    const sourceCoverage = await createCoverageFile(root, profileId, batchId);
    const audit = await createAuditFile(root, profileId, baseline, candidate, detail);
    inputs[profileId].audit = audit;
    profiles[profileId] = {
      baselinePath: baseline.path,
      baselineSha256: baseline.sha256,
      candidatePath: candidate.path,
      candidateSha256: candidate.sha256,
      candidateRevision: 1,
      candidatePlanPath: facts.path,
      candidatePlanSha256: facts.sha256,
      detailPath: detail.path,
      detailSha256: detail.sha256,
      sourceCoveragePath: sourceCoverage.path,
      sourceCoverageSha256: sourceCoverage.sha256,
      auditPath: audit.path,
      auditSha256: audit.sha256,
    };
  }
  const renders = {};
  for (const profileId of profileIds) {
    renders[profileId] = await createFile(
      path.join(root, "renders", `${profileId}-preview.png`),
      `${profileId}:render`,
    );
  }
  const previewCore = {
    version: 1,
    kind: "reimbursement-batch-preview-index",
    batchId,
    affectedProfiles: profileIds,
    profiles: Object.fromEntries(profileIds.map((profileId) => [profileId, {
      candidatePath: inputs[profileId].candidate.path,
      candidateSha256: inputs[profileId].candidate.sha256,
      detailPath: inputs[profileId].detail.path,
      detailSha256: inputs[profileId].detail.sha256,
      renders: [renders[profileId]],
    }])),
  };
  const previewDocument = { ...previewCore, previewIndexDigest: canonicalDigest(previewCore) };
  const preview = await createFile(
    path.join(root, "preview-index.json"),
    `${JSON.stringify(previewDocument)}\n`,
  );
  const factsDocument = JSON.parse(await fs.readFile(facts.path, "utf8"));
  const candidateAuditDigests = Object.fromEntries(await Promise.all(profileIds.map(async (profileId) => [
    profileId,
    JSON.parse(await fs.readFile(inputs[profileId].audit.path, "utf8")).auditDigest,
  ])));
  const reviewCore = {
    version: 1,
    kind: "reimbursement-batch-review-package",
    batchId,
    affectedProfiles: profileIds,
    factsDigest: factsDocument.factsDigest,
    candidateAuditDigests,
    previewIndexDigest: previewDocument.previewIndexDigest,
  };
  const reviewDocument = { ...reviewCore, reviewPackageDigest: canonicalDigest(reviewCore) };
  const review = await createFile(
    path.join(root, "review-package.json"),
    `${JSON.stringify(reviewDocument)}\n`,
  );
  for (const profileId of profileIds) {
    Object.assign(profiles[profileId], {
      previewIndexPath: preview.path,
      previewIndexSha256: preview.sha256,
      reviewPackagePath: review.path,
      reviewPackageSha256: review.sha256,
    });
  }
  const gate1Request = {
    version: 1,
    gate: "gate-1",
    batchId,
    affectedProfiles: profileIds,
    factsPath: facts.path,
    factsSha256: facts.sha256,
    profiles,
  };
  const gate1 = await buildBatchGateArtifact(gate1Request);
  const gate1Artifact = await createFile(path.join(root, "gate-1.json"), `${JSON.stringify(gate1)}\n`);
  const finalAuditRequest = {
    version: 1,
    batchId,
    affectedProfiles: profileIds,
    factsPath: facts.path,
    factsSha256: facts.sha256,
    profiles: Object.fromEntries(profileIds.map((profileId) => [profileId, {
      baselinePath: profiles[profileId].baselinePath,
      baselineSha256: profiles[profileId].baselineSha256,
      candidatePath: profiles[profileId].candidatePath,
      candidateSha256: profiles[profileId].candidateSha256,
      candidateRevision: profiles[profileId].candidateRevision,
      candidateAuditPath: profiles[profileId].auditPath,
      candidateAuditSha256: profiles[profileId].auditSha256,
      detailPath: profiles[profileId].detailPath,
      detailSha256: profiles[profileId].detailSha256,
    }])),
  };
  const finalAudit = await buildReimbursementFinalAudit(finalAuditRequest, { auditImpl: fakeFinalAudit });
  const finalAuditFile = await createFile(path.join(root, "final-audit.json"), `${JSON.stringify(finalAudit)}\n`);
  const gate2Profiles = structuredClone(profiles);
  for (const profileId of profileIds) {
    delete gate2Profiles[profileId].reviewPackagePath;
    delete gate2Profiles[profileId].reviewPackageSha256;
  }
  const gateRequest = {
    ...gate1Request,
    gate: "gate-2",
    profiles: gate2Profiles,
    gate1ArtifactPath: gate1Artifact.path,
    gate1ArtifactSha256: gate1Artifact.sha256,
    gate1BindingDigest: gate1.bindingDigest,
    finalAuditPath: finalAuditFile.path,
    finalAuditSha256: finalAuditFile.sha256,
    finalAuditDigest: finalAudit.finalAuditDigest,
  };
  const gate = await buildBatchGateArtifact(gateRequest);
  const gateArtifactPath = path.join(root, "gate-2.json");
  await fs.writeFile(gateArtifactPath, `${JSON.stringify(gate)}\n`);
  const publishPlan = {
    version: 1,
    operation: "publish",
    batchId: gateRequest.batchId,
    taskRoot: root,
    gateArtifactPath,
    gateBindingDigest: gate.bindingDigest,
  };
  return {
    root,
    gate,
    gate1,
    gateRequest,
    gateArtifactPath,
    finalAudit,
    finalAuditFile,
    renders,
    publishPlan,
    expected,
  };
}

async function assertTargets(fixtureValue, kind) {
  for (const [profileId, files] of Object.entries(fixtureValue.expected)) {
    const actual = await fs.readFile(files.baseline.path, "utf8");
    assert.equal(actual, `${profileId}:${kind}`);
  }
}

test("single-profile batches use the same coordinated publisher", async (t) => {
  const value = await fixture(t, ["company"]);
  const result = await publish(value.publishPlan);
  assert.equal(result.status, "published");
  assert.match(result.postPublishAuditDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.affectedProfiles, ["company"]);
  await assertTargets(value, "candidate");
  assert.equal((await fs.readdir(value.root)).some((name) => name.startsWith(".codex-batch-publish-")), false);
});

test("three-profile publishing commits every target as one coordinated transaction", async (t) => {
  const value = await fixture(t, ["xiaohongshu", "company", "residence"]);
  const result = await publish(value.publishPlan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.affectedProfiles, ["xiaohongshu", "company", "residence"]);
  await assertTargets(value, "candidate");
});

for (const failureIndex of [0, 1, 2]) {
  test(`a failure after replacement ${failureIndex + 1} restores every target`, async (t) => {
    const value = await fixture(t, ["xiaohongshu", "company", "residence"]);
    await assert.rejects(
      () => publish(value.publishPlan, {
        hooks: {
          afterTargetPublished({ index }) {
            if (index === failureIndex) throw new Error("injected failure");
          },
        },
      }),
      /injected failure.*All targets were restored/u,
    );
    await assertTargets(value, "baseline");
  });
}

test("recovery restores a partially published interrupted batch", async (t) => {
  const value = await fixture(t, ["xiaohongshu", "company"]);
  const interruption = new Error("simulated process interruption");
  interruption.preserveForRecovery = true;
  await assert.rejects(
    () => publish(value.publishPlan, {
      hooks: { afterTargetPublished: ({ index }) => { if (index === 0) throw interruption; } },
    }),
    /simulated process interruption/,
  );
  const recovered = await recover({ ...value.publishPlan, operation: "recover" });
  assert.equal(recovered.status, "restored");
  await assertTargets(value, "baseline");
});

test("recovery completes an interrupted batch when all targets already equal candidates", async (t) => {
  const value = await fixture(t, ["company", "residence"]);
  const interruption = new Error("simulated final interruption");
  interruption.preserveForRecovery = true;
  await assert.rejects(
    () => publish(value.publishPlan, {
      hooks: { afterTargetPublished: ({ index }) => { if (index === 1) throw interruption; } },
    }),
    /simulated final interruption/,
  );
  const recovered = await recover({ ...value.publishPlan, operation: "recover" });
  assert.equal(recovered.status, "completed");
  await assertTargets(value, "candidate");
});

test("recovery restores every target when the all-candidate post-audit fails", async (t) => {
  const value = await fixture(t, ["company", "residence"]);
  const interruption = new Error("simulated final interruption before post-audit");
  interruption.preserveForRecovery = true;
  await assert.rejects(
    () => publish(value.publishPlan, {
      hooks: { afterTargetPublished: ({ index }) => { if (index === 1) throw interruption; } },
    }),
    /simulated final interruption/u,
  );
  await assert.rejects(
    () => recoverReimbursementBatch(
      { ...value.publishPlan, operation: "recover" },
      { postAuditImpl: async () => { throw new Error("recovered semantic audit failed"); } },
    ),
    /recovered semantic audit failed.*All targets were restored/u,
  );
  await assertTargets(value, "baseline");
});

test("publish rehashes gate-bound candidate bytes before acquiring a transaction", async (t) => {
  const value = await fixture(t, ["residence"]);
  await fs.writeFile(value.expected.residence.candidate.path, "changed-after-gate");
  await assert.rejects(() => publish(value.publishPlan), /SHA256 mismatch/);
  await assertTargets(value, "baseline");
});

test("publisher Gate 2 rebuild independently rehashes every reviewed render", async (t) => {
  const value = await fixture(t, ["company"]);
  await fs.writeFile(value.renders.company.path, "changed-after-review");
  await assert.rejects(() => publish(value.publishPlan), /renders\[0\] SHA256 mismatch/u);
  await assertTargets(value, "baseline");
});

test("publisher Gate 2 rebuild rejects a replaced Gate 1 review package", async (t) => {
  const value = await fixture(t, ["residence"]);
  const reviewPath = value.gate1.context.profiles.residence.reviewPackage.path;
  await fs.writeFile(reviewPath, "plain-text-review-placeholder");
  await assert.rejects(() => publish(value.publishPlan), /reviewPackage SHA256 mismatch/u);
  await assertTargets(value, "baseline");
});

test("a failed post-publish semantic reopen audit rolls every target back", async (t) => {
  const value = await fixture(t, ["xiaohongshu", "company", "residence"]);
  await assert.rejects(
    () => publishReimbursementBatch(value.publishPlan, {
      postAuditImpl: async () => { throw new Error("semantic reopen failed"); },
      finalAuditImpl: fakeFinalAudit,
    }),
    /semantic reopen failed.*All targets were restored/u,
  );
  await assertTargets(value, "baseline");
});

test("publisher rebuilds the independent Gate 2 final audit before mutation", async (t) => {
  const value = await fixture(t, ["company"]);
  const changedAudit = async (plan) => {
    const audit = await fakeFinalAudit(plan);
    const profileCore = { ...audit.profiles[0], visualExceptions: ["changed-final-audit-result"] };
    delete profileCore.auditDigest;
    const changedProfile = { ...profileCore, auditDigest: digestObject(profileCore) };
    const batchCore = { ...audit, profiles: [changedProfile] };
    delete batchCore.auditDigest;
    return { ...batchCore, auditDigest: digestObject(batchCore) };
  };
  await assert.rejects(
    () => publish(value.publishPlan, { finalAuditImpl: changedAudit }),
    /freshly rebuilt final audit differs/u,
  );
  await assertTargets(value, "baseline");
});

test("publisher rejects a changed final-audit file before mutation", async (t) => {
  const value = await fixture(t, ["residence"]);
  await fs.writeFile(value.finalAuditFile.path, `${JSON.stringify({ ...value.finalAudit, phase: "changed" })}\n`);
  await assert.rejects(() => publish(value.publishPlan), /SHA256 mismatch/u);
  await assertTargets(value, "baseline");
});

test("recovery rejects a journal whose owned paths were redirected", async (t) => {
  const value = await fixture(t, ["company", "residence"]);
  const interruption = new Error("simulated journal interruption");
  interruption.preserveForRecovery = true;
  await assert.rejects(
    () => publish(value.publishPlan, {
      hooks: { afterTargetPublished: ({ index }) => { if (index === 0) throw interruption; } },
    }),
  );
  const workspace = (await fs.readdir(value.root)).find((name) => name.startsWith(".codex-batch-publish-"));
  assert.ok(workspace);
  const journalPath = path.join(value.root, workspace, "journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  journal.entries[0].rollbackPath = path.join(value.root, "unowned.xlsx");
  await fs.writeFile(journalPath, `${JSON.stringify(journal)}\n`);
  await assert.rejects(
    () => recover({ ...value.publishPlan, operation: "recover" }),
    /rollbackPath changed/u,
  );
});
