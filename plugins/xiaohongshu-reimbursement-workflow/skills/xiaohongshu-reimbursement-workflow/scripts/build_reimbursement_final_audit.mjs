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
import {
  auditReimbursementCandidates,
  validateAuditCertificate,
} from "./audit_reimbursement_candidates.mjs";

const REQUEST_KEYS = new Set([
  "version",
  "batchId",
  "affectedProfiles",
  "factsPath",
  "factsSha256",
  "profiles",
]);
const REQUEST_PROFILE_KEYS = new Set([
  "baselinePath",
  "baselineSha256",
  "candidatePath",
  "candidateSha256",
  "candidateRevision",
  "candidateAuditPath",
  "candidateAuditSha256",
  "detailPath",
  "detailSha256",
]);
const DOCUMENT_KEYS = new Set([
  "version",
  "kind",
  "phase",
  "ok",
  "batchId",
  "affectedProfiles",
  "facts",
  "profiles",
  "freshAudit",
  "finalAuditDigest",
]);
const DOCUMENT_PROFILE_KEYS = new Set([
  "baseline",
  "candidate",
  "candidateRevision",
  "candidateAudit",
  "detail",
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

function exactProfiles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function bindFile(cache, filePath, expectedSha256, field) {
  const resolved = cleanAbsolutePath(filePath, `${field}.path`);
  const expected = cleanSha256(expectedSha256, `${field}.sha256`);
  const actual = await cache.hashFile(resolved, { fresh: true, field });
  if (actual !== expected) fail(`${field} SHA256 mismatch: expected ${expected}, got ${actual}.`);
  return { path: resolved, sha256: actual };
}

function normalizeBoundFile(value, field) {
  const file = requireObject(value, field);
  rejectUnknown(file, new Set(["path", "sha256"]), field);
  if (!Object.hasOwn(file, "path") || !Object.hasOwn(file, "sha256")) fail(`${field} requires path and sha256.`);
  return {
    path: cleanAbsolutePath(file.path, `${field}.path`),
    sha256: cleanSha256(file.sha256, `${field}.sha256`),
  };
}

async function readFacts(cache, facts, batchId, affectedProfiles) {
  const raw = requireObject(await readStrictJson(facts.path, "final audit facts snapshot"), "final audit facts snapshot");
  const allowed = new Set([
    "version", "kind", "batchId", "affectedProfiles", "profiles",
    "planDigest", "styleContractDigest", "profileConfigDigest", "factsDigest",
  ]);
  rejectUnknown(raw, allowed, "final audit facts snapshot");
  for (const key of allowed) if (!Object.hasOwn(raw, key)) fail(`final audit facts snapshot ${key} is required.`);
  if (raw.version !== 1 || raw.kind !== "reimbursement-batch-facts" || raw.batchId !== batchId) {
    fail("final audit facts snapshot identity is invalid.");
  }
  const actualProfiles = normalizeAffectedProfiles(raw.affectedProfiles, "final audit facts affectedProfiles");
  if (!exactProfiles(actualProfiles, affectedProfiles)) fail("final audit facts affectedProfiles differ from the request.");
  assertExactAffectedProfiles(affectedProfiles, raw.profiles, "final audit facts profiles");
  for (const key of ["planDigest", "styleContractDigest", "profileConfigDigest", "factsDigest"]) {
    cleanSha256(raw[key], `final audit facts ${key}`);
  }
  const { factsDigest, ...core } = raw;
  if (canonicalDigest(core) !== factsDigest) fail("final audit factsDigest does not match canonical content.");
  const freshSha256 = await cache.hashFile(facts.path, { fresh: true, field: "final audit facts snapshot" });
  if (freshSha256 !== facts.sha256) fail("final audit facts snapshot changed while it was read.");
  return raw;
}

function candidateAuditForProfile(raw, profileId) {
  if (raw?.mode === "reimbursement-candidate-audit") {
    if (raw.ok !== true || raw.version !== 1 || !Array.isArray(raw.profiles)) {
      fail(`${profileId} candidate audit batch identity is invalid.`);
    }
    const { auditDigest, ...core } = raw;
    if (canonicalDigest(core) !== auditDigest) fail(`${profileId} candidate audit batch digest is invalid.`);
    const certificate = raw.profiles.find((item) => item?.profileId === profileId);
    if (!certificate) fail(`${profileId} candidate audit batch is missing its profile certificate.`);
    return certificate;
  }
  return raw;
}

function validateCandidateAudit(certificate, profileId, bound, facts) {
  validateAuditCertificate(certificate);
  if (
    certificate.profileId !== profileId ||
    !samePath(certificate.baselinePath, bound.baseline.path) ||
    certificate.baselineSha256 !== bound.baseline.sha256 ||
    !samePath(certificate.candidatePath, bound.candidate.path) ||
    certificate.candidateSha256 !== bound.candidate.sha256 ||
    certificate.planDigest !== facts.planDigest ||
    certificate.styleContractDigest !== facts.styleContractDigest ||
    certificate.profileConfigDigest !== facts.profileConfigDigest
  ) fail(`${profileId} candidate audit does not bind the final-audit baseline, candidate, and contracts.`);
  if (bound.detail) {
    if (
      !samePath(certificate.detailPath, bound.detail.path) ||
      certificate.detailSha256 !== bound.detail.sha256 ||
      typeof certificate.detailAuditDigest !== "string"
    ) fail(`${profileId} candidate audit does not bind the detail workbook.`);
  } else if (certificate.detailPath !== undefined) {
    fail(`${profileId} candidate audit unexpectedly binds a detail workbook.`);
  }
}

function auditPlanFromDocument(document, facts) {
  return {
    version: 1,
    batchId: document.batchId,
    taskRoot: path.dirname(document.facts.path),
    affectedProfiles: document.affectedProfiles,
    profiles: Object.fromEntries(document.affectedProfiles.map((profileId) => {
      const bound = document.profiles[profileId];
      const fact = requireObject(facts.profiles[profileId], `final audit facts profiles.${profileId}`);
      return [profileId, {
        baselinePath: bound.baseline.path,
        candidatePath: bound.candidate.path,
        candidateRevision: bound.candidateRevision,
        controlledSegment: fact.controlledSegment,
        transactions: fact.transactions,
        ...(bound.detail ? {
          detailPath: bound.detail.path,
          detailTitle: fact.detailTitle,
          period: fact.period,
        } : {}),
      }];
    })),
  };
}

function validateFreshAudit(audit, document, facts) {
  const value = requireObject(audit, "fresh final audit result");
  if (
    value.ok !== true ||
    value.mode !== "reimbursement-candidate-audit" ||
    value.version !== 1 ||
    value.batchId !== document.batchId
  ) fail("fresh final audit result has an invalid identity.");
  const actualProfiles = normalizeAffectedProfiles(value.affectedProfiles, "fresh final audit affectedProfiles");
  if (!exactProfiles(actualProfiles, document.affectedProfiles)) fail("fresh final audit affectedProfiles differ.");
  if (
    value.planDigest !== facts.planDigest ||
    value.styleContractDigest !== facts.styleContractDigest ||
    value.profileConfigDigest !== facts.profileConfigDigest
  ) fail("fresh final audit does not bind the fact/style/profile contracts.");
  if (!Array.isArray(value.profiles) || value.profiles.length !== document.affectedProfiles.length) {
    fail("fresh final audit profile certificates are incomplete.");
  }
  for (let index = 0; index < document.affectedProfiles.length; index += 1) {
    const profileId = document.affectedProfiles[index];
    const certificate = validateAuditCertificate(value.profiles[index]);
    const bound = document.profiles[profileId];
    if (
      certificate.profileId !== profileId ||
      !samePath(certificate.baselinePath, bound.baseline.path) ||
      certificate.baselineSha256 !== bound.baseline.sha256 ||
      !samePath(certificate.candidatePath, bound.candidate.path) ||
      certificate.candidateSha256 !== bound.candidate.sha256 ||
      certificate.planDigest !== facts.planDigest ||
      certificate.styleContractDigest !== facts.styleContractDigest ||
      certificate.profileConfigDigest !== facts.profileConfigDigest
    ) fail(`${profileId} fresh final audit certificate does not bind the expected files and contracts.`);
    if (bound.detail && (
      !samePath(certificate.detailPath, bound.detail.path) ||
      certificate.detailSha256 !== bound.detail.sha256 ||
      typeof certificate.detailAuditDigest !== "string"
    )) fail(`${profileId} fresh final audit certificate does not bind the detail workbook.`);
    if (!bound.detail && certificate.detailPath !== undefined) {
      fail(`${profileId} fresh final audit certificate unexpectedly binds a detail workbook.`);
    }
  }
  const { auditDigest, ...core } = value;
  if (canonicalDigest(core) !== auditDigest) fail("fresh final audit auditDigest does not match canonical content.");
  return value;
}

async function normalizeRequest(raw, cache) {
  const request = requireObject(raw, "final audit request");
  rejectUnknown(request, REQUEST_KEYS, "final audit request");
  for (const key of REQUEST_KEYS) if (!Object.hasOwn(request, key)) fail(`final audit request ${key} is required.`);
  if (request.version !== 1) fail("final audit request version must be 1.");
  const batchId = cleanString(request.batchId, "final audit batchId");
  const affectedProfiles = normalizeAffectedProfiles(request.affectedProfiles, "final audit affectedProfiles");
  const rawProfiles = assertExactAffectedProfiles(affectedProfiles, request.profiles, "final audit profiles");
  const facts = await bindFile(cache, request.factsPath, request.factsSha256, "final audit facts");
  const factsSnapshot = await readFacts(cache, facts, batchId, affectedProfiles);
  const profiles = {};
  for (const profileId of affectedProfiles) {
    const profile = requireObject(rawProfiles[profileId], `final audit profiles.${profileId}`);
    rejectUnknown(profile, REQUEST_PROFILE_KEYS, `final audit profiles.${profileId}`);
    for (const key of [
      "baselinePath", "baselineSha256", "candidatePath", "candidateSha256",
      "candidateRevision", "candidateAuditPath", "candidateAuditSha256",
    ]) if (!Object.hasOwn(profile, key)) fail(`final audit profiles.${profileId}.${key} is required.`);
    if (!Number.isSafeInteger(profile.candidateRevision) || profile.candidateRevision < 1) {
      fail(`final audit profiles.${profileId}.candidateRevision must be a positive safe integer.`);
    }
    const baselinePath = assertProfileTargetPath(profileId, profile.baselinePath, `final audit profiles.${profileId}.baselinePath`);
    const baseline = await bindFile(cache, baselinePath, profile.baselineSha256, `final audit ${profileId} baseline`);
    const candidate = await bindFile(cache, profile.candidatePath, profile.candidateSha256, `final audit ${profileId} candidate`);
    if (path.extname(candidate.path).toLowerCase() !== ".xlsx" || samePath(candidate.path, baseline.path)) {
      fail(`final audit ${profileId} candidate path is invalid.`);
    }
    const candidateAudit = await bindFile(cache, profile.candidateAuditPath, profile.candidateAuditSha256, `final audit ${profileId} candidateAudit`);
    const detailPresent = Object.hasOwn(profile, "detailPath") || Object.hasOwn(profile, "detailSha256");
    if (detailPresent && (!Object.hasOwn(profile, "detailPath") || !Object.hasOwn(profile, "detailSha256"))) {
      fail(`final audit profiles.${profileId}.detailPath/detailSha256 must be supplied together.`);
    }
    const detail = detailPresent
      ? await bindFile(cache, profile.detailPath, profile.detailSha256, `final audit ${profileId} detail`)
      : null;
    const fact = requireObject(factsSnapshot.profiles[profileId], `final audit facts profiles.${profileId}`);
    if (
      !samePath(fact.baselinePath, baseline.path) ||
      !samePath(fact.candidatePath, candidate.path) ||
      fact.candidateRevision !== profile.candidateRevision
    ) fail(`${profileId} final audit request differs from the facts snapshot.`);
    const factDetailPath = fact.detailPath ?? null;
    if (
      (factDetailPath === null) !== (detail === null) ||
      (factDetailPath !== null && !samePath(factDetailPath, detail.path))
    ) fail(`${profileId} final audit detail differs from the facts snapshot.`);
    const rawCandidateAudit = await readStrictJson(candidateAudit.path, `${profileId} candidate audit`);
    validateCandidateAudit(candidateAuditForProfile(rawCandidateAudit, profileId), profileId, { baseline, candidate, detail }, factsSnapshot);
    profiles[profileId] = {
      baseline,
      candidate,
      candidateRevision: profile.candidateRevision,
      candidateAudit,
      ...(detail ? { detail } : {}),
    };
  }
  return {
    version: 1,
    kind: "reimbursement-batch-final-audit",
    phase: "gate-2-final-audit",
    ok: true,
    batchId,
    affectedProfiles,
    facts,
    profiles,
    factsSnapshot,
  };
}

export async function buildReimbursementFinalAudit(
  raw,
  { cache = new BatchTaskCache(), auditImpl = auditReimbursementCandidates } = {},
) {
  const normalized = await normalizeRequest(raw, cache);
  const { factsSnapshot, ...documentCore } = normalized;
  const auditPlan = auditPlanFromDocument(documentCore, factsSnapshot);
  const freshAudit = validateFreshAudit(await auditImpl(auditPlan), documentCore, factsSnapshot);
  const core = { ...documentCore, freshAudit };
  return { ...core, finalAuditDigest: canonicalDigest(core) };
}

export async function validateReimbursementFinalAudit(
  raw,
  expected = {},
  { cache = new BatchTaskCache() } = {},
) {
  const document = requireObject(raw, "final audit document");
  rejectUnknown(document, DOCUMENT_KEYS, "final audit document");
  for (const key of DOCUMENT_KEYS) if (!Object.hasOwn(document, key)) fail(`final audit document ${key} is required.`);
  if (
    document.version !== 1 ||
    document.kind !== "reimbursement-batch-final-audit" ||
    document.phase !== "gate-2-final-audit" ||
    document.ok !== true
  ) fail("final audit document kind/phase identity is invalid.");
  const batchId = cleanString(document.batchId, "final audit document batchId");
  const affectedProfiles = normalizeAffectedProfiles(document.affectedProfiles, "final audit document affectedProfiles");
  if (expected.batchId !== undefined && batchId !== expected.batchId) fail("final audit document batchId differs from Gate 2.");
  if (expected.affectedProfiles !== undefined && !exactProfiles(affectedProfiles, expected.affectedProfiles)) {
    fail("final audit document affectedProfiles differ from Gate 2.");
  }
  const facts = normalizeBoundFile(document.facts, "final audit document facts");
  const factsSha256 = await cache.hashFile(facts.path, { fresh: true, field: "final audit document facts" });
  if (factsSha256 !== facts.sha256) fail("final audit document facts SHA256 changed.");
  if (expected.facts && (!samePath(facts.path, expected.facts.path) || facts.sha256 !== expected.facts.sha256)) {
    fail("final audit document facts differ from Gate 2.");
  }
  const factsSnapshot = await readFacts(cache, facts, batchId, affectedProfiles);
  const rawProfiles = assertExactAffectedProfiles(affectedProfiles, document.profiles, "final audit document profiles");
  const profiles = {};
  for (const profileId of affectedProfiles) {
    const rawProfile = requireObject(rawProfiles[profileId], `final audit document profiles.${profileId}`);
    rejectUnknown(rawProfile, DOCUMENT_PROFILE_KEYS, `final audit document profiles.${profileId}`);
    for (const key of ["baseline", "candidate", "candidateRevision", "candidateAudit"]) {
      if (!Object.hasOwn(rawProfile, key)) fail(`final audit document profiles.${profileId}.${key} is required.`);
    }
    if (!Number.isSafeInteger(rawProfile.candidateRevision) || rawProfile.candidateRevision < 1) {
      fail(`final audit document profiles.${profileId}.candidateRevision is invalid.`);
    }
    const baseline = normalizeBoundFile(rawProfile.baseline, `final audit document ${profileId} baseline`);
    baseline.path = assertProfileTargetPath(profileId, baseline.path, `final audit document ${profileId} baseline.path`);
    const candidate = normalizeBoundFile(rawProfile.candidate, `final audit document ${profileId} candidate`);
    const candidateAudit = normalizeBoundFile(rawProfile.candidateAudit, `final audit document ${profileId} candidateAudit`);
    const detail = rawProfile.detail ? normalizeBoundFile(rawProfile.detail, `final audit document ${profileId} detail`) : null;
    for (const [field, bound] of [["baseline", baseline], ["candidate", candidate], ["candidateAudit", candidateAudit], ...(detail ? [["detail", detail]] : [])]) {
      const actual = await cache.hashFile(bound.path, { fresh: true, field: `final audit document ${profileId} ${field}` });
      if (actual !== bound.sha256) fail(`final audit document ${profileId} ${field} SHA256 changed.`);
    }
    const expectedProfile = expected.profiles?.[profileId];
    if (expectedProfile) {
      for (const [field, bound] of [["baseline", baseline], ["candidate", candidate], ["audit", candidateAudit]]) {
        if (!expectedProfile[field] || !samePath(bound.path, expectedProfile[field].path) || bound.sha256 !== expectedProfile[field].sha256) {
          fail(`final audit document ${profileId} ${field} differs from Gate 2.`);
        }
      }
      if (rawProfile.candidateRevision !== expectedProfile.candidateRevision) fail(`final audit document ${profileId} candidateRevision differs from Gate 2.`);
      if ((detail?.path ?? null) !== (expectedProfile.detail?.path ?? null) || (detail?.sha256 ?? null) !== (expectedProfile.detail?.sha256 ?? null)) {
        fail(`final audit document ${profileId} detail differs from Gate 2.`);
      }
    }
    const candidateAuditRaw = await readStrictJson(candidateAudit.path, `final audit document ${profileId} candidate audit`);
    validateCandidateAudit(candidateAuditForProfile(candidateAuditRaw, profileId), profileId, { baseline, candidate, detail }, factsSnapshot);
    profiles[profileId] = { baseline, candidate, candidateRevision: rawProfile.candidateRevision, candidateAudit, ...(detail ? { detail } : {}) };
  }
  const normalized = { ...document, batchId, affectedProfiles, facts, profiles };
  validateFreshAudit(document.freshAudit, normalized, factsSnapshot);
  const { finalAuditDigest, ...core } = document;
  const digest = cleanSha256(finalAuditDigest, "final audit document finalAuditDigest");
  if (canonicalDigest(core) !== digest) fail("final audit document finalAuditDigest does not match canonical content.");
  if (expected.finalAuditDigest !== undefined && digest !== expected.finalAuditDigest) {
    fail("final audit document finalAuditDigest differs from Gate 2.");
  }
  return { document: normalized, factsSnapshot, finalAuditDigest: digest };
}

export async function rebuildReimbursementFinalAudit(
  raw,
  { cache = new BatchTaskCache(), auditImpl = auditReimbursementCandidates, expected = {} } = {},
) {
  const validated = await validateReimbursementFinalAudit(raw, expected, { cache });
  const auditPlan = auditPlanFromDocument(validated.document, validated.factsSnapshot);
  const rebuiltAudit = validateFreshAudit(await auditImpl(auditPlan), validated.document, validated.factsSnapshot);
  if (canonicalDigest(rebuiltAudit) !== canonicalDigest(validated.document.freshAudit)) {
    fail("freshly rebuilt final audit differs from the Gate 2 final audit file.");
  }
  return validated;
}

export async function writeReimbursementFinalAudit(raw, outputPath, options = {}) {
  const resolved = cleanAbsolutePath(outputPath, "final audit outputPath");
  const result = await buildReimbursementFinalAudit(raw, options);
  await fs.writeFile(resolved, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return result;
}

async function main() {
  if (process.argv.length !== 6 || process.argv[2] !== "--input" || process.argv[4] !== "--output") {
    fail("Usage: build_reimbursement_final_audit.mjs --input <request.json> --output <new-final-audit.json>.");
  }
  const request = await readStrictJson(path.resolve(process.argv[3]), "final audit request");
  const result = await writeReimbursementFinalAudit(request, path.resolve(process.argv[5]));
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
