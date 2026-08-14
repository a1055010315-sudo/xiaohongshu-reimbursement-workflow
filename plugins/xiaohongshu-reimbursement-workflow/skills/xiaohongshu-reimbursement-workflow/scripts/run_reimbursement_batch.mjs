#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BatchTaskCache,
  assertPlainDirectory,
  assertProfileTargetPath,
  canonicalDigest,
  cleanAbsolutePath,
  cleanString,
  normalizeAffectedProfiles,
  readStrictJson,
  samePath,
} from "./batch_cache.mjs";
import { auditReimbursementCandidates, validateAuditCertificate } from "./audit_reimbursement_candidates.mjs";
import { buildReimbursementCandidates } from "./build_reimbursement_candidates.mjs";
import { canonicalProfileId, normalizeBatchPlan } from "./reimbursement_workbook_common.mjs";

const TOP_LEVEL_KEYS = new Set(["version", "batchId", "taskRoot", "affectedProfiles", "profiles", "outputs"]);
const OUTPUT_KEYS = new Set(["factsSnapshotPath", "buildCertificatePath", "auditCertificatePath", "batchStatePath"]);

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

function directTaskJsonPath(value, taskRoot, field) {
  const resolved = cleanAbsolutePath(value, field);
  if (!samePath(path.dirname(resolved), taskRoot)) fail(`${field} must be a direct file child of taskRoot.`);
  if (path.extname(resolved).toLowerCase() !== ".json") fail(`${field} must use the .json extension.`);
  return resolved;
}

async function writeExclusiveJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function outputState(filePath, field) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${field} must be a regular file, not a link.`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function serializableTransactions(transactions) {
  return transactions.map(({ amountNumber, milliunits, ...transaction }) => transaction);
}

function factsSnapshot(plan) {
  const core = {
    version: 1,
    kind: "reimbursement-batch-facts",
    batchId: plan.batchId,
    affectedProfiles: plan.affectedProfiles,
    profiles: Object.fromEntries(plan.affectedProfiles.map((profileId) => [profileId, {
      baselinePath: plan.profiles[profileId].baselinePath,
      candidatePath: plan.profiles[profileId].candidatePath,
      detailPath: plan.profiles[profileId].detailPath,
      detailTitle: plan.profiles[profileId].detailTitle,
      period: plan.profiles[profileId].period,
      candidateRevision: plan.profiles[profileId].candidateRevision,
      controlledSegment: plan.profiles[profileId].controlledSegment,
      transactions: serializableTransactions(plan.profiles[profileId].transactions),
    }])),
    planDigest: plan.planDigest,
    styleContractDigest: plan.styleContractDigest,
    profileConfigDigest: plan.profileConfigDigest,
  };
  return { ...core, factsDigest: canonicalDigest(core) };
}

function exactCanonical(left, right) {
  return canonicalDigest(left) === canonicalDigest(right);
}

async function readMatchingFacts(filePath, expected) {
  const facts = await readStrictJson(filePath, "existing facts snapshot");
  if (!exactCanonical(facts, expected)) {
    fail("Existing facts snapshot differs from the normalized batch plan; refusing an ambiguous resume.");
  }
  return facts;
}

async function validateBuildCertificate(build, plan, cache) {
  requireObject(build, "candidate build certificate");
  if (build.ok !== true || build.mode !== "reimbursement-candidate-build" || build.version !== 1) {
    fail("candidate build certificate has an unsupported identity.");
  }
  const affectedProfiles = normalizeAffectedProfiles(build.affectedProfiles, "candidate build affectedProfiles");
  if (
    affectedProfiles.length !== plan.affectedProfiles.length ||
    affectedProfiles.some((item, index) => item !== plan.affectedProfiles[index])
  ) fail("candidate build affectedProfiles differ from the normalized batch plan.");
  if (
    build.batchId !== plan.batchId ||
    build.planDigest !== plan.planDigest ||
    build.styleContractDigest !== plan.styleContractDigest ||
    build.profileConfigDigest !== plan.profileConfigDigest
  ) fail("candidate build certificate does not bind the normalized batch plan and contracts.");
  if (!Array.isArray(build.profiles) || build.profiles.length !== plan.affectedProfiles.length) {
    fail("candidate build profiles are incomplete.");
  }
  if (typeof build.buildDigest !== "string") fail("candidate build certificate is missing buildDigest.");
  const { buildDigest, ...core } = build;
  if (canonicalDigest(core) !== buildDigest) fail("candidate build buildDigest does not match canonical content.");
  for (let index = 0; index < build.profiles.length; index += 1) {
    const certificate = requireObject(build.profiles[index], `candidate build profiles[${index}]`);
    const profileId = plan.affectedProfiles[index];
    const profile = plan.profiles[profileId];
    if (certificate.profileId !== profileId) fail(`Candidate build profile order/identity differs at ${index}.`);
    for (const [field, expected] of Object.entries({
      baselinePath: profile.baselinePath,
      candidatePath: profile.candidatePath,
      detailPath: profile.detailPath,
      planDigest: plan.planDigest,
      styleContractDigest: plan.styleContractDigest,
      profileConfigDigest: plan.profileConfigDigest,
    })) {
      if (certificate[field] !== expected) fail(`${profileId} build ${field} differs from the normalized batch plan.`);
    }
    const [baselineSha256, candidateSha256, detailSha256] = await Promise.all([
      cache.hashFile(certificate.baselinePath, { fresh: true, field: `${profileId} resumed baseline` }),
      cache.hashFile(certificate.candidatePath, { fresh: true, field: `${profileId} resumed candidate` }),
      cache.hashFile(certificate.detailPath, { fresh: true, field: `${profileId} resumed detail` }),
    ]);
    if (
      baselineSha256 !== certificate.baselineSha256 ||
      candidateSha256 !== certificate.candidateSha256 ||
      detailSha256 !== certificate.detailSha256
    ) fail(`${profileId} workbook bytes changed after the saved build stage.`);
  }
  return build;
}

function validateBatchAudit(audit, build, plan) {
  requireObject(audit, "batch audit certificate");
  if (audit.ok !== true || audit.mode !== "reimbursement-candidate-audit" || audit.version !== 1) {
    fail("batch audit certificate has an unsupported identity.");
  }
  const affectedProfiles = normalizeAffectedProfiles(audit.affectedProfiles, "batch audit affectedProfiles");
  if (
    affectedProfiles.length !== plan.affectedProfiles.length ||
    affectedProfiles.some((item, index) => item !== plan.affectedProfiles[index])
  ) fail("batch audit affectedProfiles differ from the normalized batch plan.");
  if (
    audit.batchId !== plan.batchId ||
    audit.planDigest !== plan.planDigest ||
    audit.styleContractDigest !== plan.styleContractDigest ||
    audit.profileConfigDigest !== plan.profileConfigDigest
  ) fail("batch audit certificate does not bind the normalized batch plan and contracts.");
  if (!Array.isArray(audit.profiles) || audit.profiles.length !== plan.affectedProfiles.length) {
    fail("batch audit profiles are incomplete.");
  }
  const buildByProfile = new Map(build.profiles.map((item) => [item.profileId, item]));
  for (let index = 0; index < audit.profiles.length; index += 1) {
    const certificate = validateAuditCertificate(audit.profiles[index]);
    const profileId = plan.affectedProfiles[index];
    const built = buildByProfile.get(profileId);
    if (!built || certificate.profileId !== profileId) fail(`Audit profile order/identity differs at ${index}.`);
    for (const field of ["baselinePath", "baselineSha256", "candidatePath", "candidateSha256", "planDigest", "styleContractDigest", "profileConfigDigest"]) {
      if (certificate[field] !== built[field]) fail(`${profileId} audit ${field} differs from the independently built candidate certificate.`);
    }
    const expectedDetailPath = plan.profiles[profileId].detailPath;
    if (expectedDetailPath) {
      for (const field of ["detailPath", "detailSha256"]) {
        if (certificate[field] !== built[field]) fail(`${profileId} audit ${field} differs from the independently built detail certificate.`);
      }
      if (certificate.detailPath !== expectedDetailPath || typeof certificate.detailAuditDigest !== "string") {
        fail(`${profileId} detail audit does not bind the normalized batch plan.`);
      }
    } else if (built.detailPath !== undefined || certificate.detailPath !== undefined) {
      fail(`${profileId} emitted an unrequested detail workbook.`);
    }
  }
  const { auditDigest, ...core } = audit;
  if (canonicalDigest(core) !== auditDigest) fail("batch audit auditDigest does not match canonical content.");
}

export async function prepareReimbursementBatch(
  rawPlan,
  {
    buildImpl = buildReimbursementCandidates,
    auditImpl = auditReimbursementCandidates,
    cache = new BatchTaskCache(),
  } = {},
) {
  requireObject(rawPlan, "batch run plan");
  rejectUnknown(rawPlan, TOP_LEVEL_KEYS, "batch run plan");
  for (const key of TOP_LEVEL_KEYS) if (!Object.hasOwn(rawPlan, key)) fail(`batch run plan ${key} is required.`);
  if (rawPlan.version !== 1) fail("batch run plan version must be 1.");
  const batchId = cleanString(rawPlan.batchId, "batchId");
  const taskRoot = cleanAbsolutePath(rawPlan.taskRoot, "taskRoot");
  await assertPlainDirectory(taskRoot, "taskRoot");
  const rootReal = await fs.realpath(taskRoot);
  if (!samePath(rootReal, taskRoot)) fail("taskRoot must not resolve through a link or alias.");
  const outputsRaw = requireObject(rawPlan.outputs, "outputs");
  rejectUnknown(outputsRaw, OUTPUT_KEYS, "outputs");
  for (const key of OUTPUT_KEYS) if (!Object.hasOwn(outputsRaw, key)) fail(`outputs.${key} is required.`);
  const outputs = Object.fromEntries([...OUTPUT_KEYS].map((key) => [key, directTaskJsonPath(outputsRaw[key], taskRoot, `outputs.${key}`)]));
  if (new Set(Object.values(outputs).map((value) => process.platform === "win32" ? value.toLowerCase() : value)).size !== OUTPUT_KEYS.size) {
    fail("Every batch output path must be distinct.");
  }
  const normalizedPlan = await normalizeBatchPlan(rawPlan);
  if (normalizedPlan.batchId !== batchId || !samePath(normalizedPlan.taskRoot, taskRoot)) {
    fail("Normalized batch identity differs from the batch run plan.");
  }
  const requestedProfiles = normalizeAffectedProfiles(rawPlan.affectedProfiles);
  if (requestedProfiles.some((item, index) => item !== normalizedPlan.affectedProfiles[index])) {
    fail("Normalized affectedProfiles differ from the batch run plan.");
  }
  for (const profileId of normalizedPlan.affectedProfiles) {
    assertProfileTargetPath(profileId, normalizedPlan.profiles[profileId].baselinePath, `profiles.${profileId}.baselinePath`);
    const profile = normalizedPlan.profiles[profileId];
    if (!profile.detailPath || !profile.detailTitle || !profile.period) {
      fail(`profiles.${profileId} must declare detailPath, detailTitle, and period for the normal reimbursement workflow.`);
    }
  }

  const outputPresence = Object.fromEntries(await Promise.all(Object.entries(outputs).map(async ([key, outputPath]) => [
    key,
    await outputState(outputPath, `outputs.${key}`),
  ])));
  const orderedOutputKeys = ["factsSnapshotPath", "buildCertificatePath", "auditCertificatePath", "batchStatePath"];
  let seenMissing = false;
  for (const key of orderedOutputKeys) {
    if (!outputPresence[key]) seenMissing = true;
    else if (seenMissing) fail(`outputs.${key} exists after an earlier batch stage is missing; refusing an ambiguous resume.`);
  }

  const expectedFacts = factsSnapshot(normalizedPlan);
  const facts = outputPresence.factsSnapshotPath
    ? await readMatchingFacts(outputs.factsSnapshotPath, expectedFacts)
    : expectedFacts;
  if (!outputPresence.factsSnapshotPath) await writeExclusiveJson(outputs.factsSnapshotPath, facts);
  const factsSha256 = await cache.hashFile(outputs.factsSnapshotPath, { field: "facts snapshot" });

  let build;
  if (outputPresence.buildCertificatePath) {
    build = await validateBuildCertificate(
      await readStrictJson(outputs.buildCertificatePath, "existing candidate build certificate"),
      normalizedPlan,
      cache,
    );
  } else {
    build = await buildImpl(rawPlan);
    await validateBuildCertificate(build, normalizedPlan, cache);
    await writeExclusiveJson(outputs.buildCertificatePath, build);
  }
  const buildCertificateSha256 = await cache.hashFile(outputs.buildCertificatePath, { field: "build certificate" });

  let audit;
  if (outputPresence.auditCertificatePath) {
    audit = await readStrictJson(outputs.auditCertificatePath, "existing candidate audit certificate");
    validateBatchAudit(audit, build, normalizedPlan);
  } else {
    audit = await auditImpl(rawPlan);
    validateBatchAudit(audit, build, normalizedPlan);
    await writeExclusiveJson(outputs.auditCertificatePath, audit);
  }
  const auditCertificateSha256 = await cache.hashFile(outputs.auditCertificatePath, { field: "audit certificate" });

  const profiles = {};
  for (let index = 0; index < normalizedPlan.affectedProfiles.length; index += 1) {
    const profileId = normalizedPlan.affectedProfiles[index];
    const certificate = audit.profiles[index];
    // Fresh boundary hashes prevent an audit certificate from authorizing later bytes.
    const [baselineSha256, candidateSha256, detailSha256] = await Promise.all([
      cache.hashFile(certificate.baselinePath, { fresh: true, field: `${profileId} baseline` }),
      cache.hashFile(certificate.candidatePath, { fresh: true, field: `${profileId} candidate` }),
      certificate.detailPath
        ? cache.hashFile(certificate.detailPath, { fresh: true, field: `${profileId} detail` })
        : Promise.resolve(null),
    ]);
    if (baselineSha256 !== certificate.baselineSha256 || candidateSha256 !== certificate.candidateSha256) {
      fail(`${profileId} workbook changed after independent audit.`);
    }
    if (certificate.detailPath && detailSha256 !== certificate.detailSha256) {
      fail(`${profileId} detail workbook changed after independent audit.`);
    }
    const rawProfile = Object.entries(rawPlan.profiles)
      .find(([rawId]) => canonicalProfileId(rawId, normalizedPlan.profileConfig) === profileId)?.[1];
    const candidateRevision = rawProfile?.candidateRevision ?? 1;
    if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 1) {
      fail(`profiles.${profileId}.candidateRevision must be a positive safe integer when supplied.`);
    }
    profiles[profileId] = {
      candidateRevision,
      baseline: { path: certificate.baselinePath, sha256: baselineSha256 },
      candidate: { path: certificate.candidatePath, sha256: candidateSha256 },
      candidatePlan: { path: outputs.factsSnapshotPath, sha256: factsSha256 },
      audit: { path: outputs.auditCertificatePath, sha256: auditCertificateSha256 },
      ...(certificate.detailPath ? {
        detail: {
          path: certificate.detailPath,
          sha256: detailSha256,
          auditDigest: certificate.detailAuditDigest,
        },
      } : {}),
      visualExceptions: certificate.visualExceptions,
    };
  }
  const stateCore = {
    version: 1,
    kind: "reimbursement-batch-state",
    status: "ready-for-unified-gate-1",
    batchId,
    affectedProfiles: normalizedPlan.affectedProfiles,
    facts: { path: outputs.factsSnapshotPath, sha256: factsSha256 },
    buildCertificate: { path: outputs.buildCertificatePath, sha256: buildCertificateSha256 },
    auditCertificate: { path: outputs.auditCertificatePath, sha256: auditCertificateSha256 },
    profiles,
  };
  const state = { ...stateCore, stateDigest: canonicalDigest(stateCore), cacheStats: { ...cache.stats } };
  if (!outputPresence.batchStatePath) {
    await writeExclusiveJson(outputs.batchStatePath, state);
    return state;
  }
  const existingState = await readStrictJson(outputs.batchStatePath, "existing batch state");
  const { stateDigest, cacheStats, ...existingCore } = requireObject(existingState, "existing batch state");
  if (stateDigest !== canonicalDigest(existingCore) || !exactCanonical(existingCore, stateCore)) {
    fail("Existing batch state differs from freshly validated batch artifacts.");
  }
  if (!cacheStats || typeof cacheStats !== "object" || Array.isArray(cacheStats)) {
    fail("Existing batch state cacheStats are invalid.");
  }
  return existingState;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    fail("Usage: run_reimbursement_batch.mjs --input <batch-run-plan.json>.");
  }
  const rawPlan = await readStrictJson(path.resolve(process.argv[3]), "batch run plan");
  const result = await prepareReimbursementBatch(rawPlan);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, status: "batch_run_failed", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
