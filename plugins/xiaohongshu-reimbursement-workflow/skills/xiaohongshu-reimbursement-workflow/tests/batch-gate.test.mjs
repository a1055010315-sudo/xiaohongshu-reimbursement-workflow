import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalDigest, sha256FileFresh } from "../scripts/batch_cache.mjs";
import { buildBatchGateArtifact } from "../scripts/build_batch_gate_artifact.mjs";
import { buildReimbursementFinalAudit } from "../scripts/build_reimbursement_final_audit.mjs";

const CATEGORY = { xiaohongshu: "小红书报销", company: "公司报销", residence: "驻所报销" };

function businessTransaction(profileId) {
  return {
    id: `${profileId}-transaction-1`, sourceOrder: 1, date: "2026-08-14",
    project: `${profileId}-expense`, amount: "100", person: "anonymous",
    classification: "operation", rowType: "expense",
    settlement: "employee_reimbursement", settlementDisplay: "待报销",
  };
}

async function file(root, name, bytes = name) {
  const filePath = path.join(root, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return { path: filePath, sha256: await sha256FileFresh(filePath) };
}

async function auditFile(root, profileId, baseline, candidate, detail = null) {
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
    ...(detail ? {
      detailPath: detail.path,
      detailSha256: detail.sha256,
      detailAuditDigest: "e".repeat(64),
    } : {}),
  };
  return file(root, `${profileId}-audit.json`, `${JSON.stringify({ ...core, auditDigest: canonicalDigest(core) })}\n`);
}

async function coverageFile(root, profileId, batchId, transactionId) {
  const manifest = await file(root, `${profileId}-manifest.json`, `${profileId}:manifest`);
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
    normalizedTransactions: [{ ...businessTransaction(profileId), id: transactionId, category: CATEGORY[profileId], sourceRefs: [`${profileId}-source-1`] }],
  };
  return file(root, `${profileId}-coverage.json`, `${JSON.stringify({ ...core, certificateDigest: canonicalDigest(core) })}\n`);
}

async function factsFile(root, profileIds, batchId, inputs) {
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
      period: "2026-08-14--2026-08-14",
      candidateRevision: 1,
      controlledSegment: { startRow: 2 },
      transactions: [businessTransaction(profileId)],
    }])),
    planDigest: "a".repeat(64),
    styleContractDigest: "b".repeat(64),
    profileConfigDigest: "c".repeat(64),
  };
  return file(root, "facts.json", `${JSON.stringify({ ...core, factsDigest: canonicalDigest(core) })}\n`);
}

async function fakeFinalAudit(plan) {
  const certificates = [];
  for (const profileId of plan.affectedProfiles) {
    const profile = plan.profiles[profileId];
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
    };
    certificates.push({ ...core, auditDigest: canonicalDigest(core) });
  }
  const core = {
    ok: true,
    mode: "reimbursement-candidate-audit",
    version: 1,
    batchId: plan.batchId,
    affectedProfiles: plan.affectedProfiles,
    planDigest: "a".repeat(64),
    styleContractDigest: "b".repeat(64),
    profileConfigDigest: "c".repeat(64),
    profiles: certificates,
  };
  return { ...core, auditDigest: canonicalDigest(core) };
}

async function fixture(t, profileIds) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batch-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = {
    xiaohongshu: "小红书支出总表.xlsx",
    company: "公司支出总表.xlsx",
    residence: "驻所支出.xlsx",
  };
  const directories = {
    xiaohongshu: "01_小红书专项",
    company: "02_公司专项",
    residence: "03_驻所专项",
  };
  const batchId = "anonymous-batch";
  const profiles = {};
  const inputs = {};
  for (const profileId of profileIds) {
    const baseline = await file(root, path.join(directories[profileId], names[profileId]), `${profileId}-baseline`);
    const candidate = await file(root, `${profileId}-candidate.xlsx`, `${profileId}-candidate`);
    const detail = await file(root, `${profileId}-detail.xlsx`, `${profileId}-detail`);
    inputs[profileId] = { baseline, candidate, detail };
  }
  const facts = await factsFile(root, profileIds, batchId, inputs);
  for (const profileId of profileIds) {
    const { baseline, candidate, detail } = inputs[profileId];
    const coverage = await coverageFile(root, profileId, batchId, `${profileId}-transaction-1`);
    const audit = await auditFile(root, profileId, baseline, candidate, detail);
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
      sourceCoveragePath: coverage.path,
      sourceCoverageSha256: coverage.sha256,
      auditPath: audit.path,
      auditSha256: audit.sha256,
    };
  }
  const renders = {};
  for (const profileId of profileIds) {
    renders[profileId] = await file(root, `${profileId}-render.png`, `${profileId}-render`);
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
  const preview = await file(root, "preview-index.json", `${JSON.stringify(previewDocument)}\n`);
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
  const review = await file(root, "review-package.json", `${JSON.stringify(reviewDocument)}\n`);
  for (const profileId of profileIds) {
    Object.assign(profiles[profileId], {
      reviewPackagePath: review.path,
      reviewPackageSha256: review.sha256,
      previewIndexPath: preview.path,
      previewIndexSha256: preview.sha256,
    });
  }
  return {
    root,
    renders,
    previewDocument,
    reviewDocument,
    request: {
      version: 1,
      gate: "gate-1",
      batchId,
      affectedProfiles: [...profileIds].reverse(),
      factsPath: facts.path,
      factsSha256: facts.sha256,
      profiles,
    },
  };
}

async function rewritePreview(value, mutate) {
  const previewPath = value.request.profiles[value.request.affectedProfiles[0]].previewIndexPath;
  const document = JSON.parse(await fs.readFile(previewPath, "utf8"));
  delete document.previewIndexDigest;
  mutate(document);
  document.previewIndexDigest = canonicalDigest(document);
  await fs.writeFile(previewPath, `${JSON.stringify(document)}\n`);
  const sha256 = await sha256FileFresh(previewPath);
  for (const profile of Object.values(value.request.profiles)) profile.previewIndexSha256 = sha256;
}

async function rewriteReview(value, mutate) {
  const reviewPath = value.request.profiles[value.request.affectedProfiles[0]].reviewPackagePath;
  const document = JSON.parse(await fs.readFile(reviewPath, "utf8"));
  delete document.reviewPackageDigest;
  mutate(document);
  document.reviewPackageDigest = canonicalDigest(document);
  await fs.writeFile(reviewPath, `${JSON.stringify(document)}\n`);
  const sha256 = await sha256FileFresh(reviewPath);
  for (const profile of Object.values(value.request.profiles)) profile.reviewPackageSha256 = sha256;
}

async function makeGate2(value) {
  const gate1 = await buildBatchGateArtifact(value.request);
  const gate1File = await file(value.root, "gate-1.json", `${JSON.stringify(gate1)}\n`);
  const profileIds = gate1.context.affectedProfiles;
  const finalRequest = {
    version: 1,
    batchId: gate1.context.batchId,
    affectedProfiles: profileIds,
    factsPath: gate1.context.facts.path,
    factsSha256: gate1.context.facts.sha256,
    profiles: Object.fromEntries(profileIds.map((profileId) => {
      const profile = gate1.context.profiles[profileId];
      return [profileId, {
        baselinePath: profile.baseline.path,
        baselineSha256: profile.baseline.sha256,
        candidatePath: profile.candidate.path,
        candidateSha256: profile.candidate.sha256,
        candidateRevision: profile.candidateRevision,
        candidateAuditPath: profile.audit.path,
        candidateAuditSha256: profile.audit.sha256,
        ...(profile.detail ? { detailPath: profile.detail.path, detailSha256: profile.detail.sha256 } : {}),
      }];
    })),
  };
  const finalAudit = await buildReimbursementFinalAudit(finalRequest, { auditImpl: fakeFinalAudit });
  const finalAuditFile = await file(value.root, "final-audit.json", `${JSON.stringify(finalAudit)}\n`);
  const request = structuredClone(value.request);
  request.gate = "gate-2";
  for (const profileId of profileIds) {
    delete request.profiles[profileId].reviewPackagePath;
    delete request.profiles[profileId].reviewPackageSha256;
  }
  Object.assign(request, {
    gate1ArtifactPath: gate1File.path,
    gate1ArtifactSha256: gate1File.sha256,
    gate1BindingDigest: gate1.bindingDigest,
    finalAuditPath: finalAuditFile.path,
    finalAuditSha256: finalAuditFile.sha256,
    finalAuditDigest: finalAudit.finalAuditDigest,
  });
  return { request, gate1, gate1File, finalAudit, finalAuditFile };
}

for (const profileIds of [
  ["xiaohongshu"],
  ["xiaohongshu", "residence"],
  ["xiaohongshu", "company", "residence"],
]) {
  test(`one unified gate binds a ${profileIds.length}-profile batch in fixed order`, async (t) => {
    const { request } = await fixture(t, profileIds);
    const first = await buildBatchGateArtifact(request);
    const second = await buildBatchGateArtifact(request);
    assert.deepEqual(first.context.affectedProfiles, profileIds);
    for (const profileId of profileIds) assert.equal(first.context.profiles[profileId].detail.path, request.profiles[profileId].detailPath);
    assert.equal(first.bindingDigest, second.bindingDigest);
    assert.match(first.bindingDigest, /^[0-9a-f]{64}$/u);
  });
}

test("gate builder independently rehashes every bound file", async (t) => {
  const { request } = await fixture(t, ["company"]);
  await fs.writeFile(request.profiles.company.candidatePath, "changed-after-plan");
  await assert.rejects(() => buildBatchGateArtifact(request), /SHA256 mismatch/);
});

test("gate builder independently rehashes and audit-binds each detail workbook", async (t) => {
  const { request } = await fixture(t, ["xiaohongshu"]);
  await fs.writeFile(request.profiles.xiaohongshu.detailPath, "changed-detail-after-audit");
  await assert.rejects(() => buildBatchGateArtifact(request), /SHA256 mismatch/);
});

test("gate 1 rejects plain-text preview and review placeholders", async (t) => {
  for (const field of ["previewIndex", "reviewPackage"]) {
    const value = await fixture(t, ["company"]);
    const filePath = value.request.profiles.company[`${field}Path`];
    await fs.writeFile(filePath, `${field}:plain-text-placeholder`);
    value.request.profiles.company[`${field}Sha256`] = await sha256FileFresh(filePath);
    await assert.rejects(
      () => buildBatchGateArtifact(value.request),
      /JSON|must be an object/u,
    );
  }
});

test("preview index rejects a candidate that differs from facts and candidate audit", async (t) => {
  const value = await fixture(t, ["company"]);
  const wrongCandidate = await file(value.root, "wrong-candidate.xlsx", "wrong-candidate");
  await rewritePreview(value, (preview) => {
    preview.profiles.company.candidatePath = wrongCandidate.path;
    preview.profiles.company.candidateSha256 = wrongCandidate.sha256;
  });
  await assert.rejects(
    () => buildBatchGateArtifact(value.request),
    /candidate does not match the facts and candidate audit/u,
  );
});

test("preview index requires affectedProfiles in the fixed reimbursement order", async (t) => {
  const value = await fixture(t, ["xiaohongshu", "company"]);
  await rewritePreview(value, (preview) => {
    preview.affectedProfiles.reverse();
  });
  await assert.rejects(
    () => buildBatchGateArtifact(value.request),
    /affectedProfiles must use canonical profile IDs in fixed order/u,
  );
});

test("preview index rejects a detail that differs from facts and candidate audit", async (t) => {
  const value = await fixture(t, ["residence"]);
  const wrongDetail = await file(value.root, "wrong-detail.xlsx", "wrong-detail");
  await rewritePreview(value, (preview) => {
    preview.profiles.residence.detailPath = wrongDetail.path;
    preview.profiles.residence.detailSha256 = wrongDetail.sha256;
  });
  await assert.rejects(
    () => buildBatchGateArtifact(value.request),
    /detail does not match the facts and candidate audit/u,
  );
});

test("preview index independently rehashes every bound render", async (t) => {
  const value = await fixture(t, ["xiaohongshu"]);
  await fs.writeFile(value.renders.xiaohongshu.path, "changed-render-bytes");
  await assert.rejects(() => buildBatchGateArtifact(value.request), /renders\[0\] SHA256 mismatch/u);
});

test("review package rejects a candidate audit digest that was not reviewed", async (t) => {
  const value = await fixture(t, ["company"]);
  await rewriteReview(value, (review) => {
    review.candidateAuditDigests.company = "f".repeat(64);
  });
  await assert.rejects(
    () => buildBatchGateArtifact(value.request),
    /candidateAuditDigests\.company does not match/u,
  );
});

test("gate rejects canonical-looking placeholders without fact/source coverage semantics", async (t) => {
  const { request } = await fixture(t, ["company"]);
  await fs.writeFile(request.profiles.company.sourceCoveragePath, `${JSON.stringify({ ok: true })}\n`);
  request.profiles.company.sourceCoverageSha256 = await sha256FileFresh(request.profiles.company.sourceCoveragePath);
  await assert.rejects(() => buildBatchGateArtifact(request), /sourceCoverage certificate identity is invalid/u);
});

test("same transaction id cannot hide a different amount or settlement between manifest and candidate facts", async (t) => {
  const { request } = await fixture(t, ["company"]);
  const source = JSON.parse(await fs.readFile(request.profiles.company.sourceCoveragePath, "utf8"));
  const { certificateDigest: _old, ...core } = source;
  core.normalizedTransactions[0].amount = "10000";
  core.normalizedTransactions[0].settlement = "company_paid_no_reimbursement";
  await fs.writeFile(request.profiles.company.sourceCoveragePath, `${JSON.stringify({ ...core, certificateDigest: canonicalDigest(core) })}\n`);
  request.profiles.company.sourceCoverageSha256 = await sha256FileFresh(request.profiles.company.sourceCoveragePath);
  await assert.rejects(() => buildBatchGateArtifact(request), /business facts differ/);
});

test("gate rejects forged row type and settlement display even when transaction IDs and amounts match", async (t) => {
  for (const tamper of [
    (transaction) => { transaction.rowType = "summary"; },
    (transaction) => { transaction.settlementDisplay = "已付款"; },
  ]) {
    const value = await fixture(t, ["company"]);
    const facts = JSON.parse(await fs.readFile(value.request.factsPath, "utf8"));
    tamper(facts.profiles.company.transactions[0]);
    const { factsDigest: _oldDigest, ...core } = facts;
    const bytes = `${JSON.stringify({ ...core, factsDigest: canonicalDigest(core) })}\n`;
    await fs.writeFile(value.request.factsPath, bytes);
    value.request.factsSha256 = await sha256FileFresh(value.request.factsPath);
    value.request.profiles.company.candidatePlanSha256 = value.request.factsSha256;
    await assert.rejects(
      () => buildBatchGateArtifact(value.request),
      /rowType must be expense|settlementDisplay must be derived/u,
    );
  }
});

test("gate builder rejects authorization aliases and wrong target filename", async (t) => {
  const { request, root } = await fixture(t, ["company"]);
  await assert.rejects(() => buildBatchGateArtifact({ ...request, approved: true }), /persisted-authorization/);
  const wrong = await file(root, "not-company.xlsx", "baseline");
  request.profiles.company.baselinePath = wrong.path;
  request.profiles.company.baselineSha256 = wrong.sha256;
  await assert.rejects(() => buildBatchGateArtifact(request), /exact filename/);
});

test("gate 2 excludes review authorization while retaining visual evidence", async (t) => {
  const value = await fixture(t, ["residence"]);
  const { request } = await makeGate2(value);
  const result = await buildBatchGateArtifact(request);
  assert.equal(result.context.gate, "gate-2");
  assert.equal("reviewPackage" in result.context.profiles.residence, false);
  assert.equal("previewIndex" in result.context.profiles.residence, true);
  assert.equal(result.context.finalAuditDigest, request.finalAuditDigest);
  assert.equal(result.context.gate1BindingDigest, request.gate1BindingDigest);
});

test("gate 2 cannot bypass Gate 1 or omit its reviewed preview", async (t) => {
  const value = await fixture(t, ["company"]);
  const { request } = await makeGate2(value);
  const noGate1 = structuredClone(request);
  delete noGate1.gate1ArtifactPath;
  delete noGate1.gate1ArtifactSha256;
  delete noGate1.gate1BindingDigest;
  await assert.rejects(() => buildBatchGateArtifact(noGate1), /requires gate1ArtifactPath/u);
  const noPreview = structuredClone(request);
  delete noPreview.profiles.company.previewIndexPath;
  delete noPreview.profiles.company.previewIndexSha256;
  await assert.rejects(() => buildBatchGateArtifact(noPreview), /requires previewIndex/u);
});

test("gate 2 rejects a Gate 1 artifact for a different candidate or preview", async (t) => {
  const value = await fixture(t, ["xiaohongshu"]);
  const { request } = await makeGate2(value);
  const changedPreview = await file(
    value.root,
    "changed-preview.json",
    await fs.readFile(request.profiles.xiaohongshu.previewIndexPath),
  );
  request.profiles.xiaohongshu.previewIndexPath = changedPreview.path;
  request.profiles.xiaohongshu.previewIndexSha256 = changedPreview.sha256;
  await assert.rejects(() => buildBatchGateArtifact(request), /previewIndex differs between Gate 1 and Gate 2/u);
});

test("gate 2 requires an independent final audit kind and digest", async (t) => {
  const value = await fixture(t, ["residence"]);
  const { request } = await makeGate2(value);
  request.finalAuditPath = request.profiles.residence.auditPath;
  request.finalAuditSha256 = request.profiles.residence.auditSha256;
  await assert.rejects(() => buildBatchGateArtifact(request), /different file and kind/u);
});

test("gate 1 cannot accept Gate 2 final-audit authorization inputs", async (t) => {
  const value = await fixture(t, ["company"]);
  value.request.finalAuditPath = value.request.profiles.company.auditPath;
  value.request.finalAuditSha256 = value.request.profiles.company.auditSha256;
  value.request.finalAuditDigest = "f".repeat(64);
  await assert.rejects(() => buildBatchGateArtifact(value.request), /gate-1 must not accept/u);
});
