#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BatchTaskCache,
  assertExactAffectedProfiles,
  assertPlainDirectory,
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

const REQUEST_KEYS = new Set(["version", "batchStatePath", "profiles", "outputs"]);
const REQUEST_PROFILE_KEYS = new Set(["renders"]);
const OUTPUT_KEYS = new Set(["previewIndexPath", "reviewPackagePath"]);
const STATE_KEYS = new Set([
  "version", "kind", "status", "batchId", "affectedProfiles", "facts",
  "buildCertificate", "auditCertificate", "profiles", "stateDigest", "cacheStats",
]);
const STATE_PROFILE_KEYS = new Set([
  "candidateRevision", "baseline", "candidate", "candidatePlan", "audit",
  "detail", "visualExceptions",
]);
const FACTS_KEYS = new Set([
  "version", "kind", "batchId", "affectedProfiles", "profiles", "planDigest",
  "styleContractDigest", "profileConfigDigest", "factsDigest",
]);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function rejectUnknown(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
}

function requireExactKeys(value, keys, field) {
  const object = requireObject(value, field);
  rejectUnknown(object, keys, field);
  for (const key of keys) if (!Object.hasOwn(object, key)) fail(`${field}.${key} is required.`);
  return object;
}

function exactProfiles(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function fixedAffectedProfiles(value, field, expected = null) {
  const normalized = normalizeAffectedProfiles(value, field);
  if (!exactProfiles(value, normalized)) fail(`${field} must use canonical profile IDs in fixed order.`);
  if (expected && !exactProfiles(normalized, expected)) fail(`${field} differs from the ready batch state.`);
  return normalized;
}

function normalizeBoundFile(value, field) {
  const raw = requireExactKeys(value, new Set(["path", "sha256"]), field);
  return {
    path: cleanAbsolutePath(raw.path, `${field}.path`),
    sha256: cleanSha256(raw.sha256, `${field}.sha256`),
  };
}

async function bindStateFile(cache, value, field) {
  const bound = normalizeBoundFile(value, field);
  const actual = await cache.hashFile(bound.path, { fresh: true, field: `${field}.path` });
  if (actual !== bound.sha256) fail(`${field} SHA256 mismatch: expected ${bound.sha256}, got ${actual}.`);
  return bound;
}

async function bindFile(cache, filePath, field) {
  const resolved = cleanAbsolutePath(filePath, `${field}.path`);
  return {
    path: resolved,
    sha256: await cache.hashFile(resolved, { fresh: true, field: `${field}.path` }),
  };
}

function normalizeOutputPath(value, taskRoot, field) {
  const resolved = cleanAbsolutePath(value, field);
  if (!samePath(path.dirname(resolved), taskRoot)) fail(`${field} must be a direct file child of the batch task root.`);
  if (path.extname(resolved).toLowerCase() !== ".json") fail(`${field} must use the .json extension.`);
  return resolved;
}

async function assertOutputAbsent(filePath, field) {
  try {
    await fs.lstat(filePath);
    fail(`${field} already exists; refusing to overwrite it.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeExclusivePair(previewPath, preview, reviewPath, review) {
  const previewBytes = `${JSON.stringify(preview)}\n`;
  const reviewBytes = `${JSON.stringify(review)}\n`;
  await fs.writeFile(previewPath, previewBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.writeFile(reviewPath, reviewBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      await fs.unlink(previewPath);
    } catch (cleanupError) {
      fail(`${error instanceof Error ? error.message : String(error)} Preview cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw error;
  }
}

async function loadReadyState(cache, statePath) {
  const state = requireExactKeys(
    await readStrictJson(statePath, "ready batch state"),
    STATE_KEYS,
    "ready batch state",
  );
  if (
    state.version !== 1 ||
    state.kind !== "reimbursement-batch-state" ||
    state.status !== "ready-for-unified-gate-1"
  ) fail("batch state is not ready for the unified Gate 1 review stage.");
  const batchId = cleanString(state.batchId, "ready batch state batchId");
  const affectedProfiles = fixedAffectedProfiles(state.affectedProfiles, "ready batch state affectedProfiles");
  const stateDigest = cleanSha256(state.stateDigest, "ready batch state stateDigest");
  const { stateDigest: _stateDigest, cacheStats, ...stateCore } = state;
  if (canonicalDigest(stateCore) !== stateDigest) fail("ready batch state stateDigest does not match canonical content.");
  requireObject(cacheStats, "ready batch state cacheStats");
  const stateSha256 = await cache.hashFile(statePath, { fresh: true, field: "ready batch state" });
  const facts = await bindStateFile(cache, state.facts, "ready batch state facts");
  const buildCertificate = await bindStateFile(cache, state.buildCertificate, "ready batch state buildCertificate");
  const auditCertificate = await bindStateFile(cache, state.auditCertificate, "ready batch state auditCertificate");
  const rawProfiles = assertExactAffectedProfiles(affectedProfiles, state.profiles, "ready batch state profiles");
  return {
    state,
    stateSha256,
    stateDigest,
    batchId,
    affectedProfiles,
    facts,
    buildCertificate,
    auditCertificate,
    rawProfiles,
  };
}

async function loadFacts(ready) {
  const facts = requireExactKeys(
    await readStrictJson(ready.facts.path, "ready facts snapshot"),
    FACTS_KEYS,
    "ready facts snapshot",
  );
  if (facts.version !== 1 || facts.kind !== "reimbursement-batch-facts" || facts.batchId !== ready.batchId) {
    fail("ready facts snapshot identity differs from the batch state.");
  }
  fixedAffectedProfiles(facts.affectedProfiles, "ready facts affectedProfiles", ready.affectedProfiles);
  assertExactAffectedProfiles(ready.affectedProfiles, facts.profiles, "ready facts profiles");
  for (const key of ["planDigest", "styleContractDigest", "profileConfigDigest", "factsDigest"]) {
    cleanSha256(facts[key], `ready facts ${key}`);
  }
  const { factsDigest, ...core } = facts;
  if (canonicalDigest(core) !== factsDigest) fail("ready facts factsDigest does not match canonical content.");
  return facts;
}

async function loadAudit(ready, facts) {
  const audit = requireObject(
    await readStrictJson(ready.auditCertificate.path, "ready candidate audit"),
    "ready candidate audit",
  );
  if (
    audit.ok !== true ||
    audit.mode !== "reimbursement-candidate-audit" ||
    audit.version !== 1 ||
    audit.batchId !== ready.batchId
  ) fail("ready candidate audit identity differs from the batch state.");
  fixedAffectedProfiles(audit.affectedProfiles, "ready candidate audit affectedProfiles", ready.affectedProfiles);
  if (
    audit.planDigest !== facts.planDigest ||
    audit.styleContractDigest !== facts.styleContractDigest ||
    audit.profileConfigDigest !== facts.profileConfigDigest
  ) fail("ready candidate audit does not bind the facts and workbook contracts.");
  if (!Array.isArray(audit.profiles) || audit.profiles.length !== ready.affectedProfiles.length) {
    fail("ready candidate audit profile certificates are incomplete.");
  }
  const { auditDigest, ...core } = audit;
  if (cleanSha256(auditDigest, "ready candidate audit auditDigest") !== canonicalDigest(core)) {
    fail("ready candidate audit auditDigest does not match canonical content.");
  }
  return audit;
}

async function bindReadyProfiles(cache, ready, facts, audit) {
  const profiles = {};
  const candidateAuditDigests = {};
  for (let index = 0; index < ready.affectedProfiles.length; index += 1) {
    const profileId = ready.affectedProfiles[index];
    const field = `ready batch state profiles.${profileId}`;
    const raw = requireObject(ready.rawProfiles[profileId], field);
    rejectUnknown(raw, STATE_PROFILE_KEYS, field);
    for (const key of [
      "candidateRevision", "baseline", "candidate", "candidatePlan", "audit", "visualExceptions",
    ]) if (!Object.hasOwn(raw, key)) fail(`${field}.${key} is required.`);
    if (!Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) {
      fail(`${field}.candidateRevision must be a positive safe integer.`);
    }
    if (!Array.isArray(raw.visualExceptions)) fail(`${field}.visualExceptions must be an array.`);
    const baseline = await bindStateFile(cache, raw.baseline, `${field}.baseline`);
    baseline.path = assertProfileTargetPath(profileId, baseline.path, `${field}.baseline.path`);
    const candidate = await bindStateFile(cache, raw.candidate, `${field}.candidate`);
    if (path.extname(candidate.path).toLowerCase() !== ".xlsx" || samePath(candidate.path, baseline.path)) {
      fail(`${field}.candidate path is invalid.`);
    }
    const candidatePlan = await bindStateFile(cache, raw.candidatePlan, `${field}.candidatePlan`);
    const auditFile = await bindStateFile(cache, raw.audit, `${field}.audit`);
    if (!samePath(candidatePlan.path, ready.facts.path) || candidatePlan.sha256 !== ready.facts.sha256) {
      fail(`${field}.candidatePlan differs from the ready facts snapshot.`);
    }
    if (!samePath(auditFile.path, ready.auditCertificate.path) || auditFile.sha256 !== ready.auditCertificate.sha256) {
      fail(`${field}.audit differs from the ready candidate audit.`);
    }
    let detail = null;
    if (Object.hasOwn(raw, "detail")) {
      const rawDetail = requireExactKeys(raw.detail, new Set(["path", "sha256", "auditDigest"]), `${field}.detail`);
      detail = await bindStateFile(cache, { path: rawDetail.path, sha256: rawDetail.sha256 }, `${field}.detail`);
      if (path.extname(detail.path).toLowerCase() !== ".xlsx") fail(`${field}.detail path must use the .xlsx extension.`);
      detail.auditDigest = cleanSha256(rawDetail.auditDigest, `${field}.detail.auditDigest`);
    }
    const fact = requireObject(facts.profiles[profileId], `ready facts profiles.${profileId}`);
    if (
      !samePath(fact.baselinePath, baseline.path) ||
      !samePath(fact.candidatePath, candidate.path) ||
      fact.candidateRevision !== raw.candidateRevision
    ) fail(`${profileId} ready state workbook bindings differ from the facts snapshot.`);
    const factDetailPath = fact.detailPath ?? null;
    if (
      (factDetailPath === null) !== (detail === null) ||
      (detail && !samePath(factDetailPath, detail.path))
    ) fail(`${profileId} ready detail binding differs from the facts snapshot.`);

    const certificate = validateAuditCertificate(audit.profiles[index]);
    if (
      certificate.profileId !== profileId ||
      !samePath(certificate.baselinePath, baseline.path) ||
      certificate.baselineSha256 !== baseline.sha256 ||
      !samePath(certificate.candidatePath, candidate.path) ||
      certificate.candidateSha256 !== candidate.sha256 ||
      certificate.planDigest !== facts.planDigest ||
      certificate.styleContractDigest !== facts.styleContractDigest ||
      certificate.profileConfigDigest !== facts.profileConfigDigest
    ) fail(`${profileId} ready candidate audit does not bind the state and facts snapshot.`);
    if (detail) {
      if (
        !samePath(certificate.detailPath, detail.path) ||
        certificate.detailSha256 !== detail.sha256 ||
        certificate.detailAuditDigest !== detail.auditDigest
      ) fail(`${profileId} ready candidate audit does not bind the detail workbook.`);
    } else if (certificate.detailPath !== undefined) {
      fail(`${profileId} ready candidate audit unexpectedly binds a detail workbook.`);
    }
    candidateAuditDigests[profileId] = cleanSha256(certificate.auditDigest, `${profileId} candidate auditDigest`);
    profiles[profileId] = { baseline, candidate, candidatePlan, audit: auditFile, ...(detail ? { detail } : {}) };
  }
  return { profiles, candidateAuditDigests };
}

async function bindRenders(cache, rawProfiles, affectedProfiles) {
  const requestProfiles = assertExactAffectedProfiles(affectedProfiles, rawProfiles, "review artifact profiles");
  const profiles = {};
  const seen = new Set();
  for (const profileId of affectedProfiles) {
    const field = `review artifact profiles.${profileId}`;
    const raw = requireExactKeys(requestProfiles[profileId], REQUEST_PROFILE_KEYS, field);
    if (!Array.isArray(raw.renders) || raw.renders.length < 1) fail(`${field}.renders must be a non-empty array of paths.`);
    const renders = [];
    for (let index = 0; index < raw.renders.length; index += 1) {
      const render = await bindFile(cache, raw.renders[index], `${field}.renders[${index}]`);
      const key = process.platform === "win32" ? render.path.toLowerCase() : render.path;
      if (seen.has(key)) fail(`${field}.renders[${index}] duplicates another batch render path.`);
      seen.add(key);
      renders.push(render);
    }
    profiles[profileId] = { renders };
  }
  return profiles;
}

export async function buildReimbursementReviewArtifacts(raw, { cache = new BatchTaskCache() } = {}) {
  const request = requireExactKeys(raw, REQUEST_KEYS, "review artifact request");
  if (request.version !== 1) fail("review artifact request version must be 1.");
  const batchStatePath = cleanAbsolutePath(request.batchStatePath, "review artifact batchStatePath");
  if (path.extname(batchStatePath).toLowerCase() !== ".json") fail("review artifact batchStatePath must use the .json extension.");
  const taskRoot = path.dirname(batchStatePath);
  await assertPlainDirectory(taskRoot, "review artifact task root");
  if (!samePath(await fs.realpath(taskRoot), taskRoot)) fail("review artifact task root must not resolve through a link or alias.");
  const outputsRaw = requireExactKeys(request.outputs, OUTPUT_KEYS, "review artifact outputs");
  const previewIndexPath = normalizeOutputPath(outputsRaw.previewIndexPath, taskRoot, "review artifact outputs.previewIndexPath");
  const reviewPackagePath = normalizeOutputPath(outputsRaw.reviewPackagePath, taskRoot, "review artifact outputs.reviewPackagePath");
  if (samePath(previewIndexPath, reviewPackagePath)) fail("review artifact output paths must be distinct.");

  const ready = await loadReadyState(cache, batchStatePath);
  const facts = await loadFacts(ready);
  const audit = await loadAudit(ready, facts);
  const bound = await bindReadyProfiles(cache, ready, facts, audit);
  const renderProfiles = await bindRenders(cache, request.profiles, ready.affectedProfiles);

  const previewCore = {
    version: 1,
    kind: "reimbursement-batch-preview-index",
    batchId: ready.batchId,
    affectedProfiles: ready.affectedProfiles,
    profiles: Object.fromEntries(ready.affectedProfiles.map((profileId) => {
      const profile = bound.profiles[profileId];
      return [profileId, {
        candidatePath: profile.candidate.path,
        candidateSha256: profile.candidate.sha256,
        ...(profile.detail ? {
          detailPath: profile.detail.path,
          detailSha256: profile.detail.sha256,
        } : {}),
        renders: renderProfiles[profileId].renders,
      }];
    })),
  };
  const previewIndex = { ...previewCore, previewIndexDigest: canonicalDigest(previewCore) };
  const reviewCore = {
    version: 1,
    kind: "reimbursement-batch-review-package",
    batchId: ready.batchId,
    affectedProfiles: ready.affectedProfiles,
    factsDigest: facts.factsDigest,
    candidateAuditDigests: bound.candidateAuditDigests,
    previewIndexDigest: previewIndex.previewIndexDigest,
  };
  const reviewPackage = { ...reviewCore, reviewPackageDigest: canonicalDigest(reviewCore) };

  await assertOutputAbsent(previewIndexPath, "review artifact previewIndex output");
  await assertOutputAbsent(reviewPackagePath, "review artifact reviewPackage output");
  await writeExclusivePair(previewIndexPath, previewIndex, reviewPackagePath, reviewPackage);
  const [previewIndexSha256, reviewPackageSha256] = await Promise.all([
    cache.hashFile(previewIndexPath, { fresh: true, field: "written preview index" }),
    cache.hashFile(reviewPackagePath, { fresh: true, field: "written review package" }),
  ]);
  return {
    ok: true,
    status: "review-artifacts-created",
    batchId: ready.batchId,
    affectedProfiles: ready.affectedProfiles,
    batchState: { path: batchStatePath, sha256: ready.stateSha256, stateDigest: ready.stateDigest },
    previewIndex: {
      path: previewIndexPath,
      sha256: previewIndexSha256,
      previewIndexDigest: previewIndex.previewIndexDigest,
    },
    reviewPackage: {
      path: reviewPackagePath,
      sha256: reviewPackageSha256,
      reviewPackageDigest: reviewPackage.reviewPackageDigest,
    },
    cacheStats: { ...cache.stats },
  };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    fail("Usage: build_reimbursement_review_artifacts.mjs --input <review-artifact-request.json>.");
  }
  const request = await readStrictJson(path.resolve(process.argv[3]), "review artifact request");
  const result = await buildReimbursementReviewArtifacts(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      status: "review_artifact_build_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
