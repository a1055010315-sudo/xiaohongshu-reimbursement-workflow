#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BatchTaskCache,
  assertExactAffectedProfiles,
  assertProfileTargetPath,
  canonicalDigest,
  cleanAbsolutePath,
  cleanSha256,
  cleanString,
  normalizeAffectedProfiles,
  readStrictJson,
  samePath,
} from "./batch_cache.mjs";
import { validateAuditCertificate } from "./audit_reimbursement_candidates.mjs";
import { validateReimbursementFinalAudit } from "./build_reimbursement_final_audit.mjs";
import { parseAmount } from "./reimbursement_workbook_common.mjs";

const REQUEST_KEYS = new Set([
  "version",
  "gate",
  "batchId",
  "affectedProfiles",
  "factsPath",
  "factsSha256",
  "profiles",
  "finalAuditPath",
  "finalAuditSha256",
  "finalAuditDigest",
  "gate1ArtifactPath",
  "gate1ArtifactSha256",
  "gate1BindingDigest",
]);
const REQUIRED_REQUEST_KEYS = new Set([
  "version",
  "gate",
  "batchId",
  "affectedProfiles",
  "factsPath",
  "factsSha256",
  "profiles",
]);
const PROFILE_KEYS = new Set([
  "baselinePath",
  "baselineSha256",
  "candidatePath",
  "candidateSha256",
  "candidateRevision",
  "candidatePlanPath",
  "candidatePlanSha256",
  "detailPath",
  "detailSha256",
  "sourceCoveragePath",
  "sourceCoverageSha256",
  "auditPath",
  "auditSha256",
  "reviewPackagePath",
  "reviewPackageSha256",
  "previewIndexPath",
  "previewIndexSha256",
]);
const GATE_ARTIFACT_KEYS = new Set(["ok", "context", "bindingDigest", "cacheStats"]);
const GATE_CONTEXT_KEYS = new Set([
  "version", "artifactKind", "gate", "batchId", "affectedProfiles", "facts", "profiles",
]);
const GATE_CONTEXT_PROFILE_KEYS = new Set([
  "baseline", "candidate", "candidateRevision", "candidatePlan", "detail",
  "sourceCoverage", "audit", "previewIndex", "reviewPackage",
]);
const PREVIEW_INDEX_KEYS = new Set([
  "version", "kind", "batchId", "affectedProfiles", "profiles", "previewIndexDigest",
]);
const PREVIEW_PROFILE_KEYS = new Set([
  "candidatePath", "candidateSha256", "detailPath", "detailSha256", "renders",
]);
const PREVIEW_RENDER_KEYS = new Set(["path", "sha256"]);
const REVIEW_PACKAGE_KEYS = new Set([
  "version", "kind", "batchId", "affectedProfiles", "factsDigest",
  "candidateAuditDigests", "previewIndexDigest", "reviewPackageDigest",
]);

function fail(message) {
  throw new Error(message);
}

function rejectUnknown(object, allowed, field) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${field} contains unknown or persisted-authorization field ${key}.`);
  }
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function profilePath(value, field) {
  const resolved = cleanAbsolutePath(value, field);
  return resolved;
}

function exactProfiles(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function requireFixedAffectedProfiles(value, expected, field) {
  const normalized = normalizeAffectedProfiles(value, field);
  if (!exactProfiles(value, normalized)) fail(`${field} must use canonical profile IDs in fixed order.`);
  if (!exactProfiles(normalized, expected)) fail(`${field} differs from the reimbursement batch.`);
  return normalized;
}

const CATEGORY_PROFILE = new Map([
  ["小红书", "xiaohongshu"], ["小红书报销", "xiaohongshu"],
  ["公司", "company"], ["公司报销", "company"],
  ["驻所", "residence"], ["驻所报销", "residence"], ["住所", "residence"], ["住所报销", "residence"],
]);

function comparableBusinessFact(item, field, profileId, { source = false } = {}) {
  const value = requireObject(item, field);
  const settlement = cleanString(value.settlement, `${field}.settlement`);
  if (!["employee_reimbursement", "company_paid_no_reimbursement"].includes(settlement)) {
    fail(`${field}.settlement is unsupported.`);
  }
  const rowType = source ? "expense" : cleanString(value.rowType, `${field}.rowType`);
  if (rowType !== "expense") fail(`${field}.rowType must be expense.`);
  const expectedSettlementDisplay = settlement === "employee_reimbursement" ? "待报销" : "对公已付，不实报";
  const settlementDisplay = source
    ? expectedSettlementDisplay
    : cleanString(value.settlementDisplay, `${field}.settlementDisplay`);
  if (settlementDisplay !== expectedSettlementDisplay) {
    fail(`${field}.settlementDisplay must be derived from settlement.`);
  }
  const projection = {
    id: cleanString(value.id, `${field}.id`),
    sourceOrder: value.sourceOrder,
    date: cleanString(value.date, `${field}.date`),
    project: cleanString(value.project, `${field}.project`),
    amountMilliunits: parseAmount(value.amount, `${field}.amount`).milliunits.toString(),
    person: cleanString(value.person, `${field}.person`),
    classification: cleanString(value.classification, `${field}.classification`),
    rowType,
    settlement,
    settlementDisplay,
  };
  if (!Number.isSafeInteger(projection.sourceOrder) || projection.sourceOrder < 1) {
    fail(`${field}.sourceOrder must be a positive safe integer.`);
  }
  if (source) {
    const category = cleanString(value.category, `${field}.category`);
    if (CATEGORY_PROFILE.get(category) !== profileId) {
      fail(`${field}.category does not belong to profile ${profileId}.`);
    }
  }
  return projection;
}

async function validateFactsSnapshot(factsFile, batchId, affectedProfiles) {
  const raw = await readStrictJson(factsFile.path, "facts snapshot");
  const facts = requireObject(raw, "facts snapshot");
  const allowed = new Set([
    "version",
    "kind",
    "batchId",
    "affectedProfiles",
    "profiles",
    "planDigest",
    "styleContractDigest",
    "profileConfigDigest",
    "factsDigest",
  ]);
  rejectUnknown(facts, allowed, "facts snapshot");
  for (const key of allowed) if (!Object.hasOwn(facts, key)) fail(`facts snapshot ${key} is required.`);
  if (facts.version !== 1 || facts.kind !== "reimbursement-batch-facts" || facts.batchId !== batchId) {
    fail("facts snapshot identity does not match the reimbursement batch.");
  }
  const factsProfiles = normalizeAffectedProfiles(facts.affectedProfiles, "facts snapshot affectedProfiles");
  if (!exactProfiles(factsProfiles, affectedProfiles)) fail("facts snapshot affectedProfiles differ from the gate request.");
  const profileFacts = assertExactAffectedProfiles(affectedProfiles, facts.profiles, "facts snapshot profiles");
  for (const profileId of affectedProfiles) {
    const profile = requireObject(profileFacts[profileId], `facts snapshot profiles.${profileId}`);
    if (!Array.isArray(profile.transactions) || profile.transactions.length === 0) {
      fail(`facts snapshot profiles.${profileId}.transactions must be non-empty.`);
    }
    const ids = profile.transactions.map((item, index) => cleanString(item?.id, `facts snapshot ${profileId} transaction ${index} id`));
    if (new Set(ids).size !== ids.length) fail(`facts snapshot profiles.${profileId} contains duplicate transaction IDs.`);
  }
  for (const key of ["planDigest", "styleContractDigest", "profileConfigDigest", "factsDigest"]) {
    cleanSha256(facts[key], `facts snapshot ${key}`);
  }
  const { factsDigest, ...core } = facts;
  if (canonicalDigest(core) !== factsDigest) fail("facts snapshot factsDigest does not match canonical content.");
  return facts;
}

async function bindFile(cache, filePath, expectedSha256, field) {
  const resolved = profilePath(filePath, `${field}.path`);
  const expected = cleanSha256(expectedSha256, `${field}.sha256`);
  const actual = await cache.hashFile(resolved, { fresh: true, field: `${field}.path` });
  if (actual !== expected) fail(`${field} SHA256 mismatch: expected ${expected}, got ${actual}.`);
  return { path: resolved, sha256: actual };
}

function normalizeBoundFile(value, field) {
  const raw = requireObject(value, field);
  rejectUnknown(raw, new Set(["path", "sha256"]), field);
  if (!Object.hasOwn(raw, "path") || !Object.hasOwn(raw, "sha256")) {
    fail(`${field} requires path and sha256.`);
  }
  return {
    path: cleanAbsolutePath(raw.path, `${field}.path`),
    sha256: cleanSha256(raw.sha256, `${field}.sha256`),
  };
}

function assertSameBoundFile(actual, expected, field) {
  if (!samePath(actual.path, expected.path) || actual.sha256 !== expected.sha256) {
    fail(`${field} differs between Gate 1 and Gate 2.`);
  }
}

async function rehashBoundFile(cache, value, field) {
  const bound = normalizeBoundFile(value, field);
  const actual = await cache.hashFile(bound.path, { fresh: true, field: `${field}.path` });
  if (actual !== bound.sha256) {
    fail(`${field} SHA256 mismatch: expected ${bound.sha256}, got ${actual}.`);
  }
  return bound;
}

async function validatePreviewIndex(
  cache,
  previewFile,
  { batchId, affectedProfiles, factsSnapshot, profiles, auditCertificates },
) {
  const raw = requireObject(
    await readStrictJson(previewFile.path, "batch preview index"),
    "batch preview index",
  );
  rejectUnknown(raw, PREVIEW_INDEX_KEYS, "batch preview index");
  for (const key of PREVIEW_INDEX_KEYS) {
    if (!Object.hasOwn(raw, key)) fail(`batch preview index ${key} is required.`);
  }
  if (raw.version !== 1 || raw.kind !== "reimbursement-batch-preview-index" || raw.batchId !== batchId) {
    fail("batch preview index identity does not match the reimbursement batch.");
  }
  requireFixedAffectedProfiles(raw.affectedProfiles, affectedProfiles, "batch preview index affectedProfiles");
  const rawProfiles = assertExactAffectedProfiles(
    affectedProfiles,
    raw.profiles,
    "batch preview index profiles",
  );
  const seenRenders = new Set();
  for (const profileId of affectedProfiles) {
    const field = `batch preview index profiles.${profileId}`;
    const rawProfile = requireObject(rawProfiles[profileId], field);
    rejectUnknown(rawProfile, PREVIEW_PROFILE_KEYS, field);
    for (const key of ["candidatePath", "candidateSha256", "renders"]) {
      if (!Object.hasOwn(rawProfile, key)) fail(`${field}.${key} is required.`);
    }
    const detailPathPresent = Object.hasOwn(rawProfile, "detailPath");
    const detailShaPresent = Object.hasOwn(rawProfile, "detailSha256");
    if (detailPathPresent !== detailShaPresent) fail(`${field}.detailPath and ${field}.detailSha256 must be supplied together.`);

    const candidate = normalizeBoundFile(
      { path: rawProfile.candidatePath, sha256: rawProfile.candidateSha256 },
      `${field}.candidate`,
    );
    const expected = profiles[profileId];
    const audit = auditCertificates[profileId];
    const factProfile = requireObject(factsSnapshot.profiles[profileId], `facts profiles.${profileId}`);
    const factsCandidatePath = cleanAbsolutePath(factProfile.candidatePath, `facts profiles.${profileId}.candidatePath`);
    if (
      !samePath(candidate.path, expected.candidate.path) ||
      candidate.sha256 !== expected.candidate.sha256 ||
      !samePath(candidate.path, factsCandidatePath) ||
      !samePath(candidate.path, audit.candidatePath) ||
      candidate.sha256 !== audit.candidateSha256
    ) fail(`${field}.candidate does not match the facts and candidate audit.`);

    const expectedDetailPath = factProfile.detailPath == null
      ? null
      : cleanAbsolutePath(factProfile.detailPath, `facts profiles.${profileId}.detailPath`);
    if ((expected.detail === undefined) !== (expectedDetailPath === null)) {
      fail(`facts profiles.${profileId}.detailPath does not match the bound candidate audit.`);
    }
    if (expected.detail) {
      if (!detailPathPresent) fail(`${field}.detail is required by the facts and candidate audit.`);
      const detail = normalizeBoundFile(
        { path: rawProfile.detailPath, sha256: rawProfile.detailSha256 },
        `${field}.detail`,
      );
      if (
        !samePath(detail.path, expected.detail.path) ||
        detail.sha256 !== expected.detail.sha256 ||
        !samePath(detail.path, expectedDetailPath) ||
        !samePath(detail.path, audit.detailPath) ||
        detail.sha256 !== audit.detailSha256
      ) fail(`${field}.detail does not match the facts and candidate audit.`);
    } else if (detailPathPresent) {
      fail(`${field}.detail is not declared by the facts and candidate audit.`);
    }

    if (!Array.isArray(rawProfile.renders) || rawProfile.renders.length < 1) {
      fail(`${field}.renders must be a non-empty array.`);
    }
    for (let index = 0; index < rawProfile.renders.length; index += 1) {
      const renderField = `${field}.renders[${index}]`;
      const render = requireObject(rawProfile.renders[index], renderField);
      rejectUnknown(render, PREVIEW_RENDER_KEYS, renderField);
      for (const key of PREVIEW_RENDER_KEYS) {
        if (!Object.hasOwn(render, key)) fail(`${renderField}.${key} is required.`);
      }
      const boundRender = await bindFile(cache, render.path, render.sha256, renderField);
      const renderKey = process.platform === "win32" ? boundRender.path.toLowerCase() : boundRender.path;
      if (seenRenders.has(renderKey)) fail(`${renderField}.path duplicates another batch render.`);
      seenRenders.add(renderKey);
    }
  }
  const previewIndexDigest = cleanSha256(raw.previewIndexDigest, "batch preview index previewIndexDigest");
  const { previewIndexDigest: _digest, ...core } = raw;
  if (canonicalDigest(core) !== previewIndexDigest) {
    fail("batch preview index previewIndexDigest does not match canonical content.");
  }
  return { previewIndexDigest };
}

async function validatePreviewIndexes(cache, files, expected) {
  let previewIndexDigest = null;
  for (const [profileId, previewFile] of files) {
    const result = await validatePreviewIndex(cache, previewFile, expected);
    if (previewIndexDigest !== null && result.previewIndexDigest !== previewIndexDigest) {
      fail(`profiles.${profileId}.previewIndex differs from the unified batch preview.`);
    }
    previewIndexDigest = result.previewIndexDigest;
  }
  return previewIndexDigest;
}

async function validateReviewPackage(
  reviewFile,
  { batchId, affectedProfiles, factsDigest, candidateAuditDigests, previewIndexDigest },
) {
  const raw = requireObject(
    await readStrictJson(reviewFile.path, "batch review package"),
    "batch review package",
  );
  rejectUnknown(raw, REVIEW_PACKAGE_KEYS, "batch review package");
  for (const key of REVIEW_PACKAGE_KEYS) {
    if (!Object.hasOwn(raw, key)) fail(`batch review package ${key} is required.`);
  }
  if (raw.version !== 1 || raw.kind !== "reimbursement-batch-review-package" || raw.batchId !== batchId) {
    fail("batch review package identity does not match the reimbursement batch.");
  }
  requireFixedAffectedProfiles(raw.affectedProfiles, affectedProfiles, "batch review package affectedProfiles");
  if (cleanSha256(raw.factsDigest, "batch review package factsDigest") !== factsDigest) {
    fail("batch review package factsDigest does not match the facts snapshot.");
  }
  if (cleanSha256(raw.previewIndexDigest, "batch review package previewIndexDigest") !== previewIndexDigest) {
    fail("batch review package previewIndexDigest does not match the validated preview index.");
  }
  const rawAuditDigests = assertExactAffectedProfiles(
    affectedProfiles,
    raw.candidateAuditDigests,
    "batch review package candidateAuditDigests",
  );
  for (const profileId of affectedProfiles) {
    if (
      cleanSha256(rawAuditDigests[profileId], `batch review package candidateAuditDigests.${profileId}`) !==
      candidateAuditDigests[profileId]
    ) fail(`batch review package candidateAuditDigests.${profileId} does not match the candidate audit.`);
  }
  const reviewPackageDigest = cleanSha256(raw.reviewPackageDigest, "batch review package reviewPackageDigest");
  const { reviewPackageDigest: _digest, ...core } = raw;
  if (canonicalDigest(core) !== reviewPackageDigest) {
    fail("batch review package reviewPackageDigest does not match canonical content.");
  }
  return { reviewPackageDigest };
}

async function validateReviewPackages(files, expected) {
  let reviewPackageDigest = null;
  for (const [profileId, reviewFile] of files) {
    const result = await validateReviewPackage(reviewFile, expected);
    if (reviewPackageDigest !== null && result.reviewPackageDigest !== reviewPackageDigest) {
      fail(`profiles.${profileId}.reviewPackage differs from the unified batch review package.`);
    }
    reviewPackageDigest = result.reviewPackageDigest;
  }
  return reviewPackageDigest;
}

async function validateBoundGate1Artifact(
  cache,
  artifactFile,
  expectedBindingDigest,
  {
    batchId,
    affectedProfiles,
    facts,
    factsSnapshot,
    profiles,
    candidateAuditDigests,
    previewIndexDigest,
  },
) {
  const artifact = requireObject(await readStrictJson(artifactFile.path, "bound Gate 1 artifact"), "bound Gate 1 artifact");
  rejectUnknown(artifact, GATE_ARTIFACT_KEYS, "bound Gate 1 artifact");
  if (artifact.ok !== true) fail("bound Gate 1 artifact must report ok:true.");
  const context = requireObject(artifact.context, "bound Gate 1 context");
  rejectUnknown(context, GATE_CONTEXT_KEYS, "bound Gate 1 context");
  for (const key of GATE_CONTEXT_KEYS) {
    if (!Object.hasOwn(context, key)) fail(`bound Gate 1 context ${key} is required.`);
  }
  if (
    context.version !== 1 ||
    context.artifactKind !== "reimbursement-batch-gate" ||
    context.gate !== "gate-1" ||
    context.batchId !== batchId
  ) fail("bound Gate 1 artifact identity differs from Gate 2.");
  const gate1Profiles = normalizeAffectedProfiles(context.affectedProfiles, "bound Gate 1 affectedProfiles");
  if (!exactProfiles(gate1Profiles, affectedProfiles)) fail("bound Gate 1 affectedProfiles differ from Gate 2.");
  const bindingDigest = cleanSha256(artifact.bindingDigest, "bound Gate 1 bindingDigest");
  if (bindingDigest !== expectedBindingDigest || canonicalDigest(context) !== bindingDigest) {
    fail("bound Gate 1 bindingDigest is invalid or differs from the Gate 2 request.");
  }
  const gate1Facts = normalizeBoundFile(context.facts, "bound Gate 1 facts");
  assertSameBoundFile(gate1Facts, facts, "facts");
  const rawProfiles = assertExactAffectedProfiles(affectedProfiles, context.profiles, "bound Gate 1 profiles");
  const gate1ReviewFiles = [];
  for (const profileId of affectedProfiles) {
    const rawProfile = requireObject(rawProfiles[profileId], `bound Gate 1 profiles.${profileId}`);
    rejectUnknown(rawProfile, GATE_CONTEXT_PROFILE_KEYS, `bound Gate 1 profiles.${profileId}`);
    for (const key of [
      "baseline", "candidate", "candidateRevision", "candidatePlan", "sourceCoverage",
      "audit", "previewIndex", "reviewPackage",
    ]) if (!Object.hasOwn(rawProfile, key)) fail(`bound Gate 1 profiles.${profileId}.${key} is required.`);
    const expected = profiles[profileId];
    if (rawProfile.candidateRevision !== expected.candidateRevision) {
      fail(`profiles.${profileId}.candidateRevision differs between Gate 1 and Gate 2.`);
    }
    for (const [key, expectedFile] of [
      ["baseline", expected.baseline],
      ["candidate", expected.candidate],
      ["candidatePlan", expected.candidatePlan],
      ["sourceCoverage", expected.sourceCoverage],
      ["audit", expected.audit],
      ["previewIndex", expected.previewIndex],
    ]) {
      if (!expectedFile) fail(`profiles.${profileId}.${key} is missing from Gate 2.`);
      assertSameBoundFile(
        normalizeBoundFile(rawProfile[key], `bound Gate 1 profiles.${profileId}.${key}`),
        expectedFile,
        `profiles.${profileId}.${key}`,
      );
    }
    const gate1Detail = rawProfile.detail
      ? normalizeBoundFile(rawProfile.detail, `bound Gate 1 profiles.${profileId}.detail`)
      : null;
    if ((gate1Detail === null) !== (expected.detail === undefined)) {
      fail(`profiles.${profileId}.detail presence differs between Gate 1 and Gate 2.`);
    }
    if (gate1Detail) assertSameBoundFile(gate1Detail, expected.detail, `profiles.${profileId}.detail`);
    // reviewPackage is evidence shown at Gate 1, not a Gate 2 authorization
    // input. Rehash and revalidate it here so a hand-written Gate 1 artifact
    // cannot smuggle in an unstructured or unrelated review package.
    gate1ReviewFiles.push([
      profileId,
      await rehashBoundFile(cache, rawProfile.reviewPackage, `bound Gate 1 profiles.${profileId}.reviewPackage`),
    ]);
  }
  await validateReviewPackages(gate1ReviewFiles, {
    batchId,
    affectedProfiles,
    factsDigest: factsSnapshot.factsDigest,
    candidateAuditDigests,
    previewIndexDigest,
  });
  return { artifact: artifactFile, bindingDigest };
}

async function bindOptionalFile(cache, profile, prefix, field) {
  const pathKey = `${prefix}Path`;
  const shaKey = `${prefix}Sha256`;
  const pathPresent = Object.hasOwn(profile, pathKey);
  const shaPresent = Object.hasOwn(profile, shaKey);
  if (pathPresent !== shaPresent) fail(`${field}.${pathKey} and ${field}.${shaKey} must both be supplied or both be absent.`);
  if (!pathPresent) return null;
  return bindFile(cache, profile[pathKey], profile[shaKey], `${field}.${prefix}`);
}

async function validateBoundAudit(auditFile, profileId, baseline, candidate, facts) {
  const raw = await readStrictJson(auditFile.path, `profiles.${profileId}.audit certificate`);
  let certificate;
  if (raw?.mode === "reimbursement-candidate-audit") {
    if (raw.ok !== true || raw.version !== 1 || !Array.isArray(raw.profiles)) {
      fail(`profiles.${profileId}.audit batch certificate is invalid.`);
    }
    const { auditDigest, ...core } = raw;
    if (canonicalDigest(core) !== auditDigest) fail(`profiles.${profileId}.audit batch digest is invalid.`);
    certificate = raw.profiles.find((item) => item?.profileId === profileId);
    if (!certificate) fail(`profiles.${profileId}.audit batch certificate does not contain the profile.`);
  } else {
    certificate = raw;
  }
  validateAuditCertificate(certificate);
  if (
    certificate.profileId !== profileId ||
    !samePath(certificate.baselinePath, baseline.path) ||
    certificate.baselineSha256 !== baseline.sha256 ||
    !samePath(certificate.candidatePath, candidate.path) ||
    certificate.candidateSha256 !== candidate.sha256
  ) {
    fail(`profiles.${profileId}.audit certificate does not bind the actual baseline and candidate.`);
  }
  if (
    certificate.planDigest !== facts.planDigest ||
    certificate.styleContractDigest !== facts.styleContractDigest ||
    certificate.profileConfigDigest !== facts.profileConfigDigest
  ) fail(`profiles.${profileId}.audit certificate does not bind the fact/style/profile contracts.`);
  return certificate;
}

async function validateSourceCoverage(cache, sourceFile, profileId, batchId, facts) {
  const source = requireObject(
    await readStrictJson(sourceFile.path, `profiles.${profileId}.sourceCoverage certificate`),
    `profiles.${profileId}.sourceCoverage certificate`,
  );
  if (
    source.ok !== true ||
    source.kind !== "reimbursement-manifest-audit" ||
    source.profileId !== profileId ||
    source.batch?.batchId !== batchId ||
    source.operation?.mode !== "reimbursement-batch"
  ) fail(`profiles.${profileId}.sourceCoverage certificate identity is invalid.`);
  cleanSha256(source.sourceCoverageDigest, `profiles.${profileId}.sourceCoverageDigest`);
  cleanSha256(source.manifestFileSha256, `profiles.${profileId}.manifestFileSha256`);
  cleanSha256(source.certificateDigest, `profiles.${profileId}.sourceCoverage certificateDigest`);
  const { certificateDigest, ...core } = source;
  if (canonicalDigest(core) !== certificateDigest) {
    fail(`profiles.${profileId}.sourceCoverage certificateDigest does not match canonical content.`);
  }
  const manifestPath = cleanAbsolutePath(source.manifest, `profiles.${profileId}.sourceCoverage manifest`);
  const manifestSha256 = await cache.hashFile(manifestPath, { fresh: true, field: `profiles.${profileId}.sourceCoverage manifest` });
  if (manifestSha256 !== source.manifestFileSha256) {
    fail(`profiles.${profileId}.sourceCoverage manifest SHA256 changed after its audit.`);
  }
  const counts = requireObject(source.sourceCoverageCounts, `profiles.${profileId}.sourceCoverageCounts`);
  for (const key of ["scopes", "units", "usedUnits", "excludedUnits"]) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail(`profiles.${profileId}.sourceCoverageCounts.${key} is invalid.`);
  }
  if (counts.scopes < 1 || counts.units < 1 || counts.usedUnits + counts.excludedUnits !== counts.units) {
    fail(`profiles.${profileId}.sourceCoverageCounts is incomplete.`);
  }
  if (!Array.isArray(source.normalizedTransactions)) fail(`profiles.${profileId}.sourceCoverage normalizedTransactions is required.`);
  const sourceFacts = source.normalizedTransactions
    .map((item, index) => comparableBusinessFact(item, `profiles.${profileId}.sourceCoverage transaction ${index}`, profileId, { source: true }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const profileFacts = facts.profiles[profileId].transactions
    .map((item, index) => comparableBusinessFact(item, `facts profiles.${profileId}.transaction ${index}`, profileId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (sourceFacts.length !== profileFacts.length || canonicalDigest(sourceFacts) !== canonicalDigest(profileFacts)) {
    fail(`profiles.${profileId}.sourceCoverage business facts differ from the candidate facts snapshot.`);
  }
  return source;
}

export async function buildBatchGateArtifact(raw, { cache = new BatchTaskCache() } = {}) {
  requireObject(raw, "batch gate request");
  rejectUnknown(raw, REQUEST_KEYS, "batch gate request");
  for (const key of REQUIRED_REQUEST_KEYS) if (!Object.hasOwn(raw, key)) fail(`batch gate request ${key} is required.`);
  if (raw.version !== 1) fail("batch gate request version must be 1.");
  const gate = cleanString(raw.gate, "gate");
  if (!new Set(["gate-1", "gate-2"]).has(gate)) fail("gate must be gate-1 or gate-2.");
  const batchId = cleanString(raw.batchId, "batchId");
  const affectedProfiles = normalizeAffectedProfiles(raw.affectedProfiles);
  const rawProfiles = assertExactAffectedProfiles(affectedProfiles, raw.profiles);

  const facts = await bindFile(cache, raw.factsPath, raw.factsSha256, "facts");
  const factsSnapshot = await validateFactsSnapshot(facts, batchId, affectedProfiles);
  const profiles = {};
  const auditCertificates = {};
  for (const profileId of affectedProfiles) {
    const profile = requireObject(rawProfiles[profileId], `profiles.${profileId}`);
    rejectUnknown(profile, PROFILE_KEYS, `profiles.${profileId}`);
    const required = [
      "baselinePath",
      "baselineSha256",
      "candidatePath",
      "candidateSha256",
      "candidateRevision",
      "candidatePlanPath",
      "candidatePlanSha256",
      "sourceCoveragePath",
      "sourceCoverageSha256",
      "auditPath",
      "auditSha256",
    ];
    for (const key of required) if (!Object.hasOwn(profile, key)) fail(`profiles.${profileId}.${key} is required.`);
    if (!Number.isSafeInteger(profile.candidateRevision) || profile.candidateRevision < 1) {
      fail(`profiles.${profileId}.candidateRevision must be a positive safe integer.`);
    }
    const baselinePath = assertProfileTargetPath(profileId, profile.baselinePath, `profiles.${profileId}.baselinePath`);
    const baseline = await bindFile(cache, baselinePath, profile.baselineSha256, `profiles.${profileId}.baseline`);
    const candidate = await bindFile(cache, profile.candidatePath, profile.candidateSha256, `profiles.${profileId}.candidate`);
    if (path.extname(candidate.path).toLowerCase() !== ".xlsx") {
      fail(`profiles.${profileId}.candidatePath must use the .xlsx extension.`);
    }
    if (samePath(candidate.path, baseline.path)) fail(`profiles.${profileId}.candidatePath must not equal baselinePath.`);
    const candidatePlan = await bindFile(
      cache,
      profile.candidatePlanPath,
      profile.candidatePlanSha256,
      `profiles.${profileId}.candidatePlan`,
    );
    if (candidatePlan.sha256 !== facts.sha256 || !samePath(candidatePlan.path, facts.path)) {
      fail(`profiles.${profileId}.candidatePlan must be the bound canonical facts snapshot.`);
    }
    const sourceCoverage = await bindFile(
      cache,
      profile.sourceCoveragePath,
      profile.sourceCoverageSha256,
      `profiles.${profileId}.sourceCoverage`,
    );
    await validateSourceCoverage(cache, sourceCoverage, profileId, batchId, factsSnapshot);
    const audit = await bindFile(cache, profile.auditPath, profile.auditSha256, `profiles.${profileId}.audit`);
    const auditCertificate = await validateBoundAudit(audit, profileId, baseline, candidate, factsSnapshot);
    auditCertificates[profileId] = auditCertificate;
    const expectedDetailPath = factsSnapshot.profiles[profileId].detailPath ?? null;
    const detail = await bindOptionalFile(cache, profile, "detail", `profiles.${profileId}`);
    if (expectedDetailPath) {
      if (!detail || !samePath(detail.path, expectedDetailPath)) {
        fail(`profiles.${profileId}.detail must bind the detail workbook declared by the facts snapshot.`);
      }
      if (
        auditCertificate.detailPath !== detail.path ||
        auditCertificate.detailSha256 !== detail.sha256 ||
        typeof auditCertificate.detailAuditDigest !== "string"
      ) fail(`profiles.${profileId}.audit certificate does not bind the actual detail workbook.`);
    } else if (detail || auditCertificate.detailPath !== undefined) {
      fail(`profiles.${profileId} supplied an unrequested detail workbook.`);
    }
    const reviewPackage = await bindOptionalFile(cache, profile, "reviewPackage", `profiles.${profileId}`);
    const previewIndex = await bindOptionalFile(cache, profile, "previewIndex", `profiles.${profileId}`);
    if (gate === "gate-1" && (!reviewPackage || !previewIndex)) {
      fail(`profiles.${profileId} gate-1 requires reviewPackage and previewIndex.`);
    }
    if (gate === "gate-2" && reviewPackage) {
      fail(`profiles.${profileId} gate-2 must not accept reviewPackage authorization input.`);
    }
    if (gate === "gate-2" && !previewIndex) {
      fail(`profiles.${profileId} gate-2 requires previewIndex from the reviewed Gate 1 candidate.`);
    }

    profiles[profileId] = {
      baseline,
      candidate,
      candidateRevision: profile.candidateRevision,
      candidatePlan,
      sourceCoverage,
      audit,
      ...(detail ? { detail } : {}),
      ...(previewIndex ? { previewIndex } : {}),
      ...(reviewPackage ? { reviewPackage } : {}),
    };
  }

  const candidateAuditDigests = Object.fromEntries(affectedProfiles.map((profileId) => [
    profileId,
    cleanSha256(auditCertificates[profileId].auditDigest, `profiles.${profileId}.auditDigest`),
  ]));
  const previewIndexDigest = await validatePreviewIndexes(
    cache,
    affectedProfiles.map((profileId) => [profileId, profiles[profileId].previewIndex]),
    { batchId, affectedProfiles, factsSnapshot, profiles, auditCertificates },
  );
  if (gate === "gate-1") {
    await validateReviewPackages(
      affectedProfiles.map((profileId) => [profileId, profiles[profileId].reviewPackage]),
      {
        batchId,
        affectedProfiles,
        factsDigest: factsSnapshot.factsDigest,
        candidateAuditDigests,
        previewIndexDigest,
      },
    );
  }

  const gate1Keys = ["gate1ArtifactPath", "gate1ArtifactSha256", "gate1BindingDigest"];
  const gate1Presence = gate1Keys.filter((key) => Object.hasOwn(raw, key));
  if (gate === "gate-1" && gate1Presence.length > 0) {
    fail("gate-1 must not bind another Gate 1 artifact.");
  }
  if (gate === "gate-2" && gate1Presence.length !== gate1Keys.length) {
    fail("gate-2 requires gate1ArtifactPath, gate1ArtifactSha256, and gate1BindingDigest.");
  }
  let gate1Artifact = null;
  let gate1BindingDigest = null;
  if (gate === "gate-2") {
    gate1Artifact = await bindFile(cache, raw.gate1ArtifactPath, raw.gate1ArtifactSha256, "gate1Artifact");
    gate1BindingDigest = cleanSha256(raw.gate1BindingDigest, "gate1BindingDigest");
    await validateBoundGate1Artifact(cache, gate1Artifact, gate1BindingDigest, {
      batchId,
      affectedProfiles,
      facts,
      factsSnapshot,
      profiles,
      candidateAuditDigests,
      previewIndexDigest,
    });
  }

  const finalAuditKeys = ["finalAuditPath", "finalAuditSha256", "finalAuditDigest"];
  const finalAuditPresence = finalAuditKeys.filter((key) => Object.hasOwn(raw, key));
  if (gate === "gate-1" && finalAuditPresence.length > 0) {
    fail("gate-1 must not accept a gate-2 final audit file.");
  }
  if (gate === "gate-2" && finalAuditPresence.length !== finalAuditKeys.length) {
    fail("gate-2 requires finalAuditPath, finalAuditSha256, and finalAuditDigest from a fresh final audit.");
  }
  let finalAudit = null;
  let finalAuditDigest = null;
  if (gate === "gate-2") {
    finalAudit = await bindFile(cache, raw.finalAuditPath, raw.finalAuditSha256, "finalAudit");
    finalAuditDigest = cleanSha256(raw.finalAuditDigest, "finalAuditDigest");
    for (const profileId of affectedProfiles) {
      if (
        samePath(finalAudit.path, profiles[profileId].audit.path) ||
        finalAudit.sha256 === profiles[profileId].audit.sha256
      ) fail(`finalAudit must be a different file and kind from profiles.${profileId}.audit.`);
    }
    const finalAuditDocument = await readStrictJson(finalAudit.path, "Gate 2 final audit");
    await validateReimbursementFinalAudit(finalAuditDocument, {
      batchId,
      affectedProfiles,
      facts,
      profiles,
      finalAuditDigest,
    }, { cache });
  }

  const context = {
    version: 1,
    artifactKind: "reimbursement-batch-gate",
    gate,
    batchId,
    affectedProfiles,
    facts,
    profiles,
    ...(gate1Artifact ? { gate1Artifact, gate1BindingDigest } : {}),
    ...(finalAudit ? { finalAudit, finalAuditDigest } : {}),
  };
  return {
    ok: true,
    context,
    bindingDigest: canonicalDigest(context),
    cacheStats: { ...cache.stats },
  };
}

export async function writeBatchGateArtifact(raw, outputPath, options = {}) {
  const result = await buildBatchGateArtifact(raw, options);
  const resolved = cleanAbsolutePath(outputPath, "outputPath");
  await fs.writeFile(resolved, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "wx" });
  return result;
}

async function main() {
  if (![4, 6].includes(process.argv.length) || process.argv[2] !== "--input") {
    fail("Usage: build_batch_gate_artifact.mjs --input <request.json> [--output <artifact.json>].");
  }
  if (process.argv.length === 6 && process.argv[4] !== "--output") {
    fail("Usage: build_batch_gate_artifact.mjs --input <request.json> [--output <artifact.json>].");
  }
  const inputPath = path.resolve(process.argv[3]);
  const request = await readStrictJson(inputPath, "batch gate request");
  const result = process.argv.length === 6
    ? await writeBatchGateArtifact(request, path.resolve(process.argv[5]))
    : await buildBatchGateArtifact(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
