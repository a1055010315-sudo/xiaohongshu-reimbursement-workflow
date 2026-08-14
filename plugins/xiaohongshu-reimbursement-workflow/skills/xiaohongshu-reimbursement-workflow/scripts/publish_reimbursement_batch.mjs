#!/usr/bin/env node

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPlainDirectory,
  assertPlainFile,
  assertProfileTargetPath,
  canonicalDigest,
  cleanAbsolutePath,
  cleanSha256,
  cleanString,
  normalizeAffectedProfiles,
  readStrictJson,
  samePath,
  sha256FileFresh,
} from "./batch_cache.mjs";
import { auditReimbursementCandidates, validateAuditCertificate } from "./audit_reimbursement_candidates.mjs";
import { buildBatchGateArtifact } from "./build_batch_gate_artifact.mjs";
import { rebuildReimbursementFinalAudit } from "./build_reimbursement_final_audit.mjs";

const PLAN_KEYS = new Set(["version", "operation", "batchId", "taskRoot", "gateArtifactPath", "gateBindingDigest"]);
const GATE_KEYS = new Set(["ok", "context", "bindingDigest", "cacheStats"]);
const CONTEXT_KEYS = new Set([
  "version", "artifactKind", "gate", "batchId", "affectedProfiles", "facts", "profiles",
  "gate1Artifact", "gate1BindingDigest", "finalAudit", "finalAuditDigest",
]);
const CONTEXT_PROFILE_KEYS = new Set([
  "baseline",
  "candidate",
  "candidateRevision",
  "candidatePlan",
  "detail",
  "sourceCoverage",
  "audit",
  "previewIndex",
]);
function fail(message) {
  throw new Error(message);
}

function rejectUnknown(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function safeComponent(value) {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48);
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, { exclusive = false } = {}) {
  const bytes = `${JSON.stringify(value)}\n`;
  const temporaryPath = `${filePath}.pending-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) await fs.link(temporaryPath, filePath);
    else await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function assertHash(filePath, expectedSha256, field) {
  await assertPlainFile(filePath, field);
  const actual = await sha256FileFresh(filePath, field);
  if (actual !== expectedSha256) fail(`${field} SHA256 mismatch: expected ${expectedSha256}, got ${actual}.`);
  return actual;
}

function normalizeBoundFile(value, field) {
  requireObject(value, field);
  rejectUnknown(value, new Set(["path", "sha256"]), field);
  if (!Object.hasOwn(value, "path") || !Object.hasOwn(value, "sha256")) fail(`${field} requires path and sha256.`);
  return {
    path: cleanAbsolutePath(value.path, `${field}.path`),
    sha256: cleanSha256(value.sha256, `${field}.sha256`),
  };
}

async function normalizeGateArtifact(raw, expectedDigest, expectedBatchId) {
  requireObject(raw, "gate artifact");
  rejectUnknown(raw, GATE_KEYS, "gate artifact");
  if (raw.ok !== true) fail("gate artifact must report ok:true.");
  const context = requireObject(raw.context, "gate artifact context");
  rejectUnknown(context, CONTEXT_KEYS, "gate artifact context");
  for (const key of CONTEXT_KEYS) if (!Object.hasOwn(context, key)) fail(`gate artifact context ${key} is required.`);
  if (context.version !== 1 || context.artifactKind !== "reimbursement-batch-gate" || context.gate !== "gate-2") {
    fail("Only a version 1 reimbursement batch gate-2 artifact can authorize publishing.");
  }
  const batchId = cleanString(context.batchId, "gate artifact batchId");
  if (batchId !== expectedBatchId) fail("gate artifact batchId does not match publish plan batchId.");
  const affectedProfiles = normalizeAffectedProfiles(context.affectedProfiles, "gate artifact affectedProfiles");
  const bindingDigest = cleanSha256(raw.bindingDigest, "gate artifact bindingDigest");
  if (bindingDigest !== expectedDigest) fail("gate artifact bindingDigest does not match publish plan gateBindingDigest.");
  const actualBindingDigest = canonicalDigest(context);
  if (actualBindingDigest !== bindingDigest) fail("gate artifact bindingDigest is not the canonical digest of its context.");
  const facts = normalizeBoundFile(context.facts, "gate artifact facts");
  const gate1Artifact = normalizeBoundFile(context.gate1Artifact, "gate artifact gate1Artifact");
  const gate1BindingDigest = cleanSha256(context.gate1BindingDigest, "gate artifact gate1BindingDigest");
  const finalAudit = normalizeBoundFile(context.finalAudit, "gate artifact finalAudit");
  const finalAuditDigest = cleanSha256(context.finalAuditDigest, "gate artifact finalAuditDigest");

  const rawProfiles = requireObject(context.profiles, "gate artifact profiles");
  const rawKeys = Object.keys(rawProfiles);
  if (rawKeys.length !== affectedProfiles.length || rawKeys.some((key) => !affectedProfiles.includes(key))) {
    fail("gate artifact profiles must match affectedProfiles exactly.");
  }
  const profiles = {};
  for (const profileId of affectedProfiles) {
    const rawProfile = requireObject(rawProfiles[profileId], `gate artifact profiles.${profileId}`);
    rejectUnknown(rawProfile, CONTEXT_PROFILE_KEYS, `gate artifact profiles.${profileId}`);
    for (const key of ["baseline", "candidate", "candidateRevision", "candidatePlan", "sourceCoverage", "audit"]) {
      if (!Object.hasOwn(rawProfile, key)) fail(`gate artifact profiles.${profileId}.${key} is required.`);
    }
    if (Object.hasOwn(rawProfile, "reviewPackage")) fail("gate-2 artifact must not contain reviewPackage authorization input.");
    if (!Number.isSafeInteger(rawProfile.candidateRevision) || rawProfile.candidateRevision < 1) {
      fail(`gate artifact profiles.${profileId}.candidateRevision must be a positive safe integer.`);
    }
    const baseline = normalizeBoundFile(rawProfile.baseline, `gate artifact profiles.${profileId}.baseline`);
    baseline.path = assertProfileTargetPath(profileId, baseline.path, `gate artifact profiles.${profileId}.baseline.path`);
    const candidate = normalizeBoundFile(rawProfile.candidate, `gate artifact profiles.${profileId}.candidate`);
    if (path.extname(candidate.path).toLowerCase() !== ".xlsx" || samePath(candidate.path, baseline.path)) {
      fail(`gate artifact profiles.${profileId}.candidate path is invalid.`);
    }
    profiles[profileId] = {
      profileId,
      baseline,
      candidate,
      candidateRevision: rawProfile.candidateRevision,
      candidatePlan: normalizeBoundFile(rawProfile.candidatePlan, `gate artifact profiles.${profileId}.candidatePlan`),
      ...(rawProfile.detail
        ? { detail: normalizeBoundFile(rawProfile.detail, `gate artifact profiles.${profileId}.detail`) }
        : {}),
      sourceCoverage: normalizeBoundFile(rawProfile.sourceCoverage, `gate artifact profiles.${profileId}.sourceCoverage`),
      audit: normalizeBoundFile(rawProfile.audit, `gate artifact profiles.${profileId}.audit`),
      ...(rawProfile.previewIndex
        ? { previewIndex: normalizeBoundFile(rawProfile.previewIndex, `gate artifact profiles.${profileId}.previewIndex`) }
        : {}),
    };
    if (!profiles[profileId].previewIndex) {
      fail(`gate artifact profiles.${profileId}.previewIndex is required for Gate 2 publishing.`);
    }
    if (
      samePath(finalAudit.path, profiles[profileId].audit.path) ||
      finalAudit.sha256 === profiles[profileId].audit.sha256
    ) fail(`gate artifact finalAudit must differ from profiles.${profileId}.audit.`);
  }
  return {
    batchId,
    affectedProfiles,
    profiles,
    facts,
    gate1Artifact,
    gate1BindingDigest,
    finalAudit,
    finalAuditDigest,
    bindingDigest,
    context,
  };
}

export function normalizePublishPlan(raw) {
  requireObject(raw, "publish plan");
  rejectUnknown(raw, PLAN_KEYS, "publish plan");
  for (const key of PLAN_KEYS) if (!Object.hasOwn(raw, key)) fail(`publish plan ${key} is required.`);
  if (raw.version !== 1) fail("publish plan version must be 1.");
  const operation = cleanString(raw.operation, "operation");
  if (!new Set(["publish", "recover"]).has(operation)) fail("operation must be publish or recover.");
  return {
    version: 1,
    operation,
    batchId: cleanString(raw.batchId, "batchId"),
    taskRoot: cleanAbsolutePath(raw.taskRoot, "taskRoot"),
    gateArtifactPath: cleanAbsolutePath(raw.gateArtifactPath, "gateArtifactPath"),
    gateBindingDigest: cleanSha256(raw.gateBindingDigest, "gateBindingDigest"),
  };
}

async function assertTaskRoot(plan) {
  await assertPlainDirectory(plan.taskRoot, "taskRoot");
  const taskRootReal = await fs.realpath(plan.taskRoot);
  if (!samePath(taskRootReal, plan.taskRoot)) fail("taskRoot must not resolve through a link or alias.");
}

function workspacePaths(plan) {
  const suffix = canonicalDigest({ batchId: plan.batchId, gateBindingDigest: plan.gateBindingDigest }).slice(0, 20);
  const workspacePath = path.join(plan.taskRoot, `.codex-batch-publish-${suffix}`);
  return {
    workspacePath,
    markerPath: path.join(workspacePath, "owner.json"),
    journalPath: path.join(workspacePath, "journal.json"),
  };
}

function targetAuxiliaryPaths(entry, token) {
  const directory = path.dirname(entry.baseline.path);
  const stem = safeComponent(`${entry.profileId}-${token}`);
  return {
    lockPath: path.join(directory, `.${path.basename(entry.baseline.path)}.codex-batch-publish.lock`),
    candidateStagingPath: path.join(directory, `.codex-${stem}.candidate.xlsx`),
    oldStagingPath: path.join(directory, `.codex-${stem}.old.xlsx`),
    failedStagingPath: path.join(directory, `.codex-${stem}.failed.xlsx`),
  };
}

async function acquireLocks(entries, token, batchId) {
  const locks = [];
  try {
    for (const entry of entries) {
      const auxiliary = targetAuxiliaryPaths(entry, token);
      const record = { version: 1, kind: "reimbursement-batch-publish-lock", token, batchId, profileId: entry.profileId };
      const handle = await fs.open(auxiliary.lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      locks.push({ ...auxiliary, handle, record });
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) {
      await lock.handle.close().catch(() => {});
      await fs.unlink(lock.lockPath).catch(() => {});
    }
    throw error;
  }
}

async function releaseLocks(locks, token) {
  const errors = [];
  for (const lock of [...locks].reverse()) {
    try {
      await lock.handle?.close().catch(() => {});
      const current = await readStrictJson(lock.lockPath, "publish lock");
      if (current.token !== token) fail(`Publish lock ownership changed: ${lock.lockPath}.`);
      await fs.unlink(lock.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function writeJournal(paths, journal) {
  await writeJsonAtomic(paths.journalPath, journal);
}

async function verifyGateFiles(gate) {
  const checks = [gate.facts, gate.gate1Artifact, gate.finalAudit];
  for (const profileId of gate.affectedProfiles) {
    const entry = gate.profiles[profileId];
    checks.push(entry.baseline, entry.candidate, entry.candidatePlan, entry.sourceCoverage, entry.audit);
    if (entry.detail) checks.push(entry.detail);
    if (entry.previewIndex) checks.push(entry.previewIndex);
  }
  for (const [index, item] of checks.entries()) await assertHash(item.path, item.sha256, `gate-bound file ${index + 1}`);
}

async function rebuildBoundGate2(gate, finalAuditImpl = auditReimbursementCandidates) {
  const request = {
    version: 1,
    gate: "gate-2",
    batchId: gate.batchId,
    affectedProfiles: gate.affectedProfiles,
    factsPath: gate.facts.path,
    factsSha256: gate.facts.sha256,
    gate1ArtifactPath: gate.gate1Artifact.path,
    gate1ArtifactSha256: gate.gate1Artifact.sha256,
    gate1BindingDigest: gate.gate1BindingDigest,
    finalAuditPath: gate.finalAudit.path,
    finalAuditSha256: gate.finalAudit.sha256,
    finalAuditDigest: gate.finalAuditDigest,
    profiles: {},
  };
  for (const profileId of gate.affectedProfiles) {
    const profile = gate.profiles[profileId];
    request.profiles[profileId] = {
      baselinePath: profile.baseline.path,
      baselineSha256: profile.baseline.sha256,
      candidatePath: profile.candidate.path,
      candidateSha256: profile.candidate.sha256,
      candidateRevision: profile.candidateRevision,
      candidatePlanPath: profile.candidatePlan.path,
      candidatePlanSha256: profile.candidatePlan.sha256,
      ...(profile.detail ? {
        detailPath: profile.detail.path,
        detailSha256: profile.detail.sha256,
      } : {}),
      sourceCoveragePath: profile.sourceCoverage.path,
      sourceCoverageSha256: profile.sourceCoverage.sha256,
      auditPath: profile.audit.path,
      auditSha256: profile.audit.sha256,
      ...(profile.previewIndex ? {
        previewIndexPath: profile.previewIndex.path,
        previewIndexSha256: profile.previewIndex.sha256,
      } : {}),
    };
  }
  const rebuilt = await buildBatchGateArtifact(request);
  if (rebuilt.bindingDigest !== gate.bindingDigest) {
    fail("The independently rebuilt Gate 2 binding differs from the supplied artifact.");
  }
  const finalAuditDocument = await readStrictJson(gate.finalAudit.path, "Gate 2 final audit");
  await rebuildReimbursementFinalAudit(finalAuditDocument, {
    auditImpl: finalAuditImpl,
    expected: {
      batchId: gate.batchId,
      affectedProfiles: gate.affectedProfiles,
      facts: gate.facts,
      profiles: gate.profiles,
      finalAuditDigest: gate.finalAuditDigest,
    },
  });
}

async function prepareWorkspace(plan, gate, token, paths, entries, locks) {
  await fs.mkdir(paths.workspacePath, { recursive: false, mode: 0o700 });
  const marker = {
    version: 1,
    kind: "reimbursement-batch-publish-workspace",
    token,
    batchId: plan.batchId,
    gateBindingDigest: plan.gateBindingDigest,
  };
  await writeJsonAtomic(paths.markerPath, marker, { exclusive: true });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const lock = locks[index];
    entry.rollbackPath = path.join(paths.workspacePath, `${index + 1}-${entry.profileId}-baseline.xlsx`);
    entry.candidateStagingPath = lock.candidateStagingPath;
    entry.oldStagingPath = lock.oldStagingPath;
    entry.failedStagingPath = lock.failedStagingPath;
    entry.state = "awaiting-preparation";
  }
  const journal = {
    version: 1,
    kind: "reimbursement-batch-publish-journal",
    token,
    batchId: plan.batchId,
    gateArtifactPath: plan.gateArtifactPath,
    gateBindingDigest: plan.gateBindingDigest,
    affectedProfiles: gate.affectedProfiles,
    phase: "preparing",
    entries: entries.map((entry) => ({ ...entry })),
  };
  await writeJournal(paths, journal);
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    await fs.copyFile(entry.baseline.path, entry.rollbackPath, fsConstants.COPYFILE_EXCL);
    await assertHash(entry.rollbackPath, entry.baseline.sha256, `${entry.profileId} rollback snapshot`);
    await fs.copyFile(entry.candidate.path, entry.candidateStagingPath, fsConstants.COPYFILE_EXCL);
    await assertHash(entry.candidateStagingPath, entry.candidate.sha256, `${entry.profileId} candidate staging`);
    entry.state = "prepared";
    await writeJournal(paths, journal);
  }
  journal.phase = "prepared";
  await writeJournal(paths, journal);
  return journal;
}

async function restoreEntry(entry) {
  const targetExists = await pathExists(entry.baseline.path);
  const oldExists = await pathExists(entry.oldStagingPath);
  if (targetExists) {
    const currentHash = await sha256FileFresh(entry.baseline.path);
    if (currentHash === entry.baseline.sha256) {
      if (oldExists) {
        await assertHash(entry.oldStagingPath, entry.baseline.sha256, `${entry.profileId} redundant old staging`);
        await fs.unlink(entry.oldStagingPath);
      }
      return;
    }
    if (currentHash !== entry.candidate.sha256) {
      fail(`${entry.profileId} target contains bytes outside the bound baseline/candidate pair; recovery preserved all files.`);
    }
    if (oldExists) {
      await assertHash(entry.oldStagingPath, entry.baseline.sha256, `${entry.profileId} old staging`);
      await fs.rename(entry.baseline.path, entry.failedStagingPath);
      try {
        await fs.rename(entry.oldStagingPath, entry.baseline.path);
        await assertHash(entry.baseline.path, entry.baseline.sha256, `${entry.profileId} restored target`);
        await fs.unlink(entry.failedStagingPath);
      } catch (error) {
        if (!await pathExists(entry.baseline.path) && await pathExists(entry.failedStagingPath)) {
          await fs.rename(entry.failedStagingPath, entry.baseline.path).catch(() => {});
        }
        throw error;
      }
      return;
    }
    await assertHash(entry.rollbackPath, entry.baseline.sha256, `${entry.profileId} rollback snapshot`);
    await fs.rename(entry.baseline.path, entry.failedStagingPath);
    try {
    await fs.copyFile(entry.rollbackPath, entry.baseline.path, fsConstants.COPYFILE_EXCL);
      await assertHash(entry.baseline.path, entry.baseline.sha256, `${entry.profileId} restored target`);
      await fs.unlink(entry.failedStagingPath);
    } catch (error) {
      if (!await pathExists(entry.baseline.path) && await pathExists(entry.failedStagingPath)) {
        await fs.rename(entry.failedStagingPath, entry.baseline.path).catch(() => {});
      }
      throw error;
    }
    return;
  }
  if (oldExists) {
    await assertHash(entry.oldStagingPath, entry.baseline.sha256, `${entry.profileId} old staging`);
    await fs.rename(entry.oldStagingPath, entry.baseline.path);
    return;
  }
  await assertHash(entry.rollbackPath, entry.baseline.sha256, `${entry.profileId} rollback snapshot`);
  await fs.copyFile(entry.rollbackPath, entry.baseline.path, fsConstants.COPYFILE_EXCL);
  await assertHash(entry.baseline.path, entry.baseline.sha256, `${entry.profileId} restored target`);
}

async function rollbackEntries(entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      await restoreEntry(entry);
      for (const filePath of [entry.candidateStagingPath, entry.failedStagingPath]) {
        if (await pathExists(filePath)) await fs.unlink(filePath);
      }
    } catch (error) {
      errors.push(`${entry.profileId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function cleanupCommitted(paths, journal, locks) {
  const errors = [];
  for (const entry of journal.entries) {
    for (const filePath of [entry.oldStagingPath, entry.candidateStagingPath, entry.failedStagingPath, entry.rollbackPath]) {
      try {
        if (await pathExists(filePath)) await fs.unlink(filePath);
      } catch (error) {
        errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  errors.push(...await releaseLocks(locks, journal.token));
  if (errors.length === 0) {
    for (const filePath of [paths.journalPath, paths.markerPath]) await fs.unlink(filePath).catch((error) => errors.push(String(error)));
    if (errors.length === 0) await fs.rmdir(paths.workspacePath).catch((error) => errors.push(String(error)));
  }
  return errors;
}

async function runPostPublishSemanticAudit(gate, journal, paths, auditImpl) {
  const facts = await readStrictJson(gate.context.facts.path, "post-publish facts snapshot");
  const postAuditRoot = path.join(paths.workspacePath, "post-publish-audit");
  await fs.mkdir(postAuditRoot, { recursive: false, mode: 0o700 });
  const auditPlan = {
    version: 1,
    batchId: journal.batchId,
    taskRoot: postAuditRoot,
    affectedProfiles: gate.affectedProfiles,
    profiles: {},
  };
  const cleanupPaths = [];
  try {
    for (const entry of journal.entries) {
      const profileDirectory = path.join(postAuditRoot, path.basename(path.dirname(entry.baseline.path)));
      await fs.mkdir(profileDirectory, { recursive: false, mode: 0o700 });
      const auditBaselinePath = path.join(profileDirectory, path.basename(entry.baseline.path));
      await fs.copyFile(entry.rollbackPath, auditBaselinePath, fsConstants.COPYFILE_EXCL);
      await assertHash(auditBaselinePath, entry.baseline.sha256, `${entry.profileId} post-audit baseline`);
      cleanupPaths.push(profileDirectory, auditBaselinePath);
      const factProfile = requireObject(facts.profiles?.[entry.profileId], `post-publish facts.${entry.profileId}`);
      auditPlan.profiles[entry.profileId] = {
        baselinePath: auditBaselinePath,
        candidatePath: entry.baseline.path,
        ...(entry.detail ? {
          detailPath: entry.detail.path,
          detailTitle: factProfile.detailTitle,
          period: factProfile.period,
        } : {}),
        candidateRevision: entry.candidateRevision,
        controlledSegment: factProfile.controlledSegment,
        transactions: factProfile.transactions,
      };
    }
    const audit = await auditImpl(auditPlan);
    if (
      audit?.ok !== true ||
      audit.mode !== "reimbursement-candidate-audit" ||
      !Array.isArray(audit.profiles) ||
      audit.profiles.length !== gate.affectedProfiles.length
    ) fail("Post-publish semantic audit returned an incomplete certificate.");
    const { auditDigest, ...auditCore } = audit;
    if (canonicalDigest(auditCore) !== auditDigest) fail("Post-publish batch auditDigest is invalid.");
    for (let index = 0; index < gate.affectedProfiles.length; index += 1) {
      const profileId = gate.affectedProfiles[index];
      const certificate = validateAuditCertificate(audit.profiles[index]);
      const entry = journal.entries[index];
      if (
        certificate.profileId !== profileId ||
        !samePath(certificate.candidatePath, entry.baseline.path) ||
        certificate.candidateSha256 !== entry.candidate.sha256
      ) fail(`${profileId} post-publish semantic audit does not bind the published target.`);
      if (entry.detail && (
        !samePath(certificate.detailPath, entry.detail.path) ||
        certificate.detailSha256 !== entry.detail.sha256 ||
        typeof certificate.detailAuditDigest !== "string"
      )) fail(`${profileId} post-publish semantic audit does not bind the approved detail workbook.`);
    }
    return cleanSha256(auditDigest, "post-publish auditDigest");
  } finally {
    for (const cleanupPath of cleanupPaths.reverse()) {
      if (await pathExists(cleanupPath)) {
        const stat = await fs.lstat(cleanupPath);
        if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(cleanupPath);
        else if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rmdir(cleanupPath);
      }
    }
    await fs.rmdir(postAuditRoot).catch(() => {});
  }
}

export async function publishReimbursementBatch(
  rawPlan,
  {
    hooks = {},
    postAuditImpl = auditReimbursementCandidates,
    finalAuditImpl = auditReimbursementCandidates,
  } = {},
) {
  const plan = normalizePublishPlan(rawPlan);
  if (plan.operation !== "publish") fail("publishReimbursementBatch requires operation publish.");
  await assertTaskRoot(plan);
  const gateRaw = await readStrictJson(plan.gateArtifactPath, "gate artifact");
  const gate = await normalizeGateArtifact(gateRaw, plan.gateBindingDigest, plan.batchId);
  // Never trust a supplied Gate artifact merely because it says it was
  // verified: rebuild its semantic bindings and fresh hashes from disk.
  await rebuildBoundGate2(gate, finalAuditImpl);
  await verifyGateFiles(gate);
  const paths = workspacePaths(plan);
  if (await pathExists(paths.workspacePath)) fail(`A publish workspace already exists; recover it first: ${paths.workspacePath}.`);

  const token = crypto.randomBytes(16).toString("hex");
  const entries = gate.affectedProfiles.map((profileId) => structuredClone(gate.profiles[profileId]));
  const locks = await acquireLocks(entries, token, plan.batchId);
  let journal;
  try {
    // Revalidate every bound input after all locks are held, before mutation.
    await verifyGateFiles(gate);
    journal = await prepareWorkspace(plan, gate, token, paths, entries, locks);
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      await assertHash(entry.baseline.path, entry.baseline.sha256, `${entry.profileId} baseline at publish boundary`);
      await fs.rename(entry.baseline.path, entry.oldStagingPath);
      entry.state = "old-staged";
      journal.phase = "publishing";
      await writeJournal(paths, journal);
      try {
        await assertHash(entry.oldStagingPath, entry.baseline.sha256, `${entry.profileId} atomically staged baseline`);
      } catch (error) {
        // A writer raced the boundary check. Restore the exact moved bytes to
        // the standard path and stop before exposing any candidate bytes.
        if (!await pathExists(entry.baseline.path) && await pathExists(entry.oldStagingPath)) {
          await fs.rename(entry.oldStagingPath, entry.baseline.path);
        }
        throw error;
      }
      await fs.rename(entry.candidateStagingPath, entry.baseline.path);
      entry.state = "published";
      await assertHash(entry.baseline.path, entry.candidate.sha256, `${entry.profileId} published target`);
      await writeJournal(paths, journal);
      if (typeof hooks.afterTargetPublished === "function") await hooks.afterTargetPublished({ index, entry, journal, paths });
    }
    for (const entry of journal.entries) {
      await assertHash(entry.baseline.path, entry.candidate.sha256, `${entry.profileId} post-publish target`);
    }
    journal.postPublishAuditDigest = await runPostPublishSemanticAudit(gate, journal, paths, postAuditImpl);
    journal.phase = "post-audited";
    await writeJournal(paths, journal);
    journal.phase = "committed";
    await writeJournal(paths, journal);
    const cleanupErrors = await cleanupCommitted(paths, journal, locks);
    return {
      ok: cleanupErrors.length === 0,
      status: cleanupErrors.length === 0 ? "published" : "published_cleanup_failed",
      batchId: plan.batchId,
      affectedProfiles: gate.affectedProfiles,
      gateBindingDigest: plan.gateBindingDigest,
      postPublishAuditDigest: journal.postPublishAuditDigest,
      targets: Object.fromEntries(journal.entries.map((entry) => [entry.profileId, {
        path: entry.baseline.path,
        sha256: entry.candidate.sha256,
      }])),
      cleanupErrors,
      ...(cleanupErrors.length ? { recoveryJournal: paths.journalPath } : {}),
    };
  } catch (error) {
    if (error?.preserveForRecovery === true) {
      for (const lock of locks) await lock.handle?.close().catch(() => {});
      throw error;
    }
    if (!journal && await pathExists(paths.journalPath)) {
      journal = await readStrictJson(paths.journalPath, "publish journal").catch(() => null);
    }
    const rollbackErrors = journal ? await rollbackEntries(journal.entries) : [];
    if (journal) {
      journal.phase = rollbackErrors.length === 0 ? "rolled-back" : "recovery-required";
      journal.error = error instanceof Error ? error.message : String(error);
      journal.rollbackErrors = rollbackErrors;
      await writeJournal(paths, journal).catch(() => {});
    }
    const lockErrors = rollbackErrors.length === 0 ? await releaseLocks(locks, token) : [];
    if (rollbackErrors.length === 0 && lockErrors.length === 0 && journal) {
      for (const entry of journal.entries) {
        if (await pathExists(entry.rollbackPath)) await fs.unlink(entry.rollbackPath).catch(() => {});
      }
      await fs.unlink(paths.journalPath).catch(() => {});
      await fs.unlink(paths.markerPath).catch(() => {});
      await fs.rmdir(paths.workspacePath).catch(() => {});
    } else if (!journal && lockErrors.length === 0 && await pathExists(paths.workspacePath)) {
      await fs.unlink(paths.markerPath).catch(() => {});
      await fs.unlink(paths.journalPath).catch(() => {});
      await fs.rmdir(paths.workspacePath).catch(() => {});
    }
    const details = [...rollbackErrors, ...lockErrors];
    fail(`${error instanceof Error ? error.message : String(error)}${details.length ? ` Recovery incomplete: ${details.join("; ")}` : " All targets were restored."}`);
  }
}

async function loadOwnedJournal(plan) {
  const paths = workspacePaths(plan);
  await assertPlainDirectory(paths.workspacePath, "publish recovery workspace");
  const marker = await readStrictJson(paths.markerPath, "publish workspace marker");
  requireObject(marker, "publish workspace marker");
  rejectUnknown(marker, new Set(["version", "kind", "token", "batchId", "gateBindingDigest"]), "publish workspace marker");
  const rawJournal = await readStrictJson(paths.journalPath, "publish journal");
  requireObject(rawJournal, "publish journal");
  rejectUnknown(
    rawJournal,
    new Set([
      "version",
      "kind",
      "token",
      "batchId",
      "gateArtifactPath",
      "gateBindingDigest",
      "affectedProfiles",
      "phase",
      "entries",
      "postPublishAuditDigest",
      "error",
      "rollbackErrors",
    ]),
    "publish journal",
  );
  const gateRaw = await readStrictJson(plan.gateArtifactPath, "gate artifact");
  const gate = await normalizeGateArtifact(gateRaw, plan.gateBindingDigest, plan.batchId);
  const journal = rawJournal;
  if (marker.kind !== "reimbursement-batch-publish-workspace" || journal.kind !== "reimbursement-batch-publish-journal") {
    fail("Publish recovery files have an unsupported kind.");
  }
  if (marker.version !== 1 || journal.version !== 1) fail("Publish recovery files have an unsupported version.");
  if (
    marker.token !== journal.token ||
    marker.batchId !== plan.batchId ||
    journal.batchId !== plan.batchId ||
    marker.gateBindingDigest !== plan.gateBindingDigest ||
    journal.gateBindingDigest !== plan.gateBindingDigest
  ) {
    fail("Publish recovery ownership does not match the requested batch and gate.");
  }
  if (!/^[0-9a-f]{32}$/u.test(marker.token) || marker.token !== journal.token) fail("Publish recovery token is invalid.");
  const journalGateArtifactPath = cleanAbsolutePath(journal.gateArtifactPath, "journal gateArtifactPath");
  if (!samePath(journalGateArtifactPath, plan.gateArtifactPath)) fail("Publish journal gateArtifactPath changed.");
  const affectedProfiles = normalizeAffectedProfiles(journal.affectedProfiles, "journal affectedProfiles");
  if (
    affectedProfiles.length !== gate.affectedProfiles.length ||
    affectedProfiles.some((item, index) => item !== gate.affectedProfiles[index])
  ) {
    fail("Publish journal affectedProfiles differ from the bound gate.");
  }
  if (!Array.isArray(journal.entries) || journal.entries.length !== affectedProfiles.length) {
    fail("Publish journal entries are incomplete.");
  }
  const allowedStates = new Set(["awaiting-preparation", "prepared", "old-staged", "published"]);
  const safeEntries = [];
  for (let index = 0; index < affectedProfiles.length; index += 1) {
    const profileId = affectedProfiles[index];
    const expected = gate.profiles[profileId];
    const rawEntry = requireObject(journal.entries[index], `journal entries[${index}]`);
    const allowedEntryKeys = new Set([
      ...CONTEXT_PROFILE_KEYS,
      "profileId",
      "rollbackPath",
      "candidateStagingPath",
      "oldStagingPath",
      "failedStagingPath",
      "state",
    ]);
    rejectUnknown(rawEntry, allowedEntryKeys, `journal entries[${index}]`);
    if (rawEntry.profileId !== profileId || !allowedStates.has(rawEntry.state)) {
      fail(`journal entries[${index}] profile or state is invalid.`);
    }
    const boundFields = {
      profileId,
      baseline: rawEntry.baseline,
      candidate: rawEntry.candidate,
      candidateRevision: rawEntry.candidateRevision,
      candidatePlan: rawEntry.candidatePlan,
      ...(rawEntry.detail ? { detail: rawEntry.detail } : {}),
      sourceCoverage: rawEntry.sourceCoverage,
      audit: rawEntry.audit,
      ...(rawEntry.previewIndex ? { previewIndex: rawEntry.previewIndex } : {}),
    };
    if (canonicalDigest(boundFields) !== canonicalDigest(expected)) {
      fail(`journal entries[${index}] no longer matches the bound gate profile.`);
    }
    const auxiliary = targetAuxiliaryPaths(expected, journal.token);
    const rollbackPath = path.join(paths.workspacePath, `${index + 1}-${profileId}-baseline.xlsx`);
    for (const [field, expectedPath] of [
      ["rollbackPath", rollbackPath],
      ["candidateStagingPath", auxiliary.candidateStagingPath],
      ["oldStagingPath", auxiliary.oldStagingPath],
      ["failedStagingPath", auxiliary.failedStagingPath],
    ]) {
      if (!samePath(rawEntry[field], expectedPath)) fail(`journal entries[${index}].${field} changed.`);
    }
    safeEntries.push({ ...structuredClone(expected), ...auxiliary, rollbackPath, state: rawEntry.state });
  }
  return { paths, marker, gate, journal: { ...journal, affectedProfiles, entries: safeEntries } };
}

export async function recoverReimbursementBatch(
  rawPlan,
  { postAuditImpl = auditReimbursementCandidates } = {},
) {
  const plan = normalizePublishPlan(rawPlan);
  if (plan.operation !== "recover") fail("recoverReimbursementBatch requires operation recover.");
  await assertTaskRoot(plan);
  const { paths, journal, gate } = await loadOwnedJournal(plan);
  const affectedProfiles = normalizeAffectedProfiles(journal.affectedProfiles, "journal affectedProfiles");
  if (!Array.isArray(journal.entries) || journal.entries.length !== affectedProfiles.length) fail("Publish journal entries are incomplete.");
  const entries = journal.entries;
  const allCandidate = (await Promise.all(entries.map(async (entry) =>
    await pathExists(entry.baseline.path) && await sha256FileFresh(entry.baseline.path) === entry.candidate.sha256
  ))).every(Boolean);
  const locks = entries.map((entry) => ({
    ...targetAuxiliaryPaths(entry, journal.token),
    lockPath: targetAuxiliaryPaths(entry, journal.token).lockPath,
  }));
  if (allCandidate) {
    try {
      for (const entry of entries) await assertHash(entry.baseline.path, entry.candidate.sha256, `${entry.profileId} recovered committed target`);
      journal.postPublishAuditDigest = await runPostPublishSemanticAudit(gate, journal, paths, postAuditImpl);
      journal.phase = "post-audited";
      await writeJournal(paths, journal);
      journal.phase = "committed";
      await writeJournal(paths, journal);
      const cleanupErrors = await cleanupCommitted(paths, journal, locks);
      return {
        ok: cleanupErrors.length === 0,
        status: cleanupErrors.length === 0 ? "completed" : "published_cleanup_failed",
        batchId: plan.batchId,
        affectedProfiles,
        postPublishAuditDigest: journal.postPublishAuditDigest,
        cleanupErrors,
      };
    } catch (error) {
      const rollbackErrors = await rollbackEntries(entries);
      journal.phase = rollbackErrors.length === 0 ? "rolled-back" : "recovery-required";
      journal.error = error instanceof Error ? error.message : String(error);
      journal.rollbackErrors = rollbackErrors;
      await writeJournal(paths, journal).catch(() => {});
      if (rollbackErrors.length > 0) {
        fail(`${journal.error} Recovery could not restore every target: ${rollbackErrors.join("; ")}`);
      }
      const lockErrors = await releaseLocks(locks, journal.token);
      if (lockErrors.length > 0) fail(`${journal.error} Targets were restored but lock cleanup failed: ${lockErrors.join("; ")}`);
      for (const entry of entries) if (await pathExists(entry.rollbackPath)) await fs.unlink(entry.rollbackPath);
      await fs.unlink(paths.journalPath);
      await fs.unlink(paths.markerPath);
      await fs.rmdir(paths.workspacePath);
      fail(`${journal.error} All targets were restored.`);
    }
  }
  const rollbackErrors = await rollbackEntries(entries);
  if (rollbackErrors.length > 0) {
    journal.phase = "recovery-required";
    journal.rollbackErrors = rollbackErrors;
    await writeJournal(paths, journal);
    fail(`Batch recovery could not restore every target: ${rollbackErrors.join("; ")}`);
  }
  const lockErrors = await releaseLocks(locks, journal.token);
  if (lockErrors.length > 0) fail(`Targets were restored but lock cleanup failed: ${lockErrors.join("; ")}`);
  for (const entry of entries) if (await pathExists(entry.rollbackPath)) await fs.unlink(entry.rollbackPath);
  await fs.unlink(paths.journalPath);
  await fs.unlink(paths.markerPath);
  await fs.rmdir(paths.workspacePath);
  return { ok: true, status: "restored", batchId: plan.batchId, affectedProfiles };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    fail("Usage: publish_reimbursement_batch.mjs --input <publish-plan.json>.");
  }
  const raw = await readStrictJson(path.resolve(process.argv[3]), "publish plan");
  const plan = normalizePublishPlan(raw);
  const result = plan.operation === "publish"
    ? await publishReimbursementBatch(raw)
    : await recoverReimbursementBatch(raw);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, status: "publish_failed", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
