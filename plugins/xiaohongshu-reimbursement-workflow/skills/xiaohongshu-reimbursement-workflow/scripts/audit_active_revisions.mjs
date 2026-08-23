#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquirePromotionFamilyMutex,
  assertNoPromotionTransactionState,
  assertPromotionFamilyMutexHeld,
  inspectRevisionState,
  normalizePromotionPlan,
  parsePlanCli,
  readPromotionPlan,
  releasePromotionFamilyMutex,
  verifyCandidateSource,
} from "./promote_active_revision.mjs";

function fail(message) {
  throw new Error(message);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function serializeEntries(entries) {
  return entries.map((entry) => ({
    revision: entry.revision,
    path: entry.path,
    sha256: entry.sha256,
  }));
}

async function auditActiveRevisionsUnderFamilyMutex(rawPlan, plan, { verifyCandidate = true } = {}) {
  if (verifyCandidate) await verifyCandidateSource(plan);
  await assertNoPromotionTransactionState(rawPlan);
  const state = await inspectRevisionState(plan, { requireOneActive: true });
  const current = state.active[0];

  if (!samePath(current.path, plan.candidateDestinationPath)) {
    fail(`Active current path differs from the bound candidate destination: ${current.path}.`);
  }
  if (current.revision !== plan.candidateRevision) {
    fail(`Active current revision ${current.revision} differs from candidateRevision ${plan.candidateRevision}.`);
  }
  if (current.sha256 !== plan.candidateSha256) {
    fail(`Active current SHA256 differs from candidateSha256: ${current.sha256}.`);
  }

  if (plan.expectedCurrentPath === null) {
    if (state.history.length !== 0) {
      fail("A first-revision plan must not have historical revisions for artifactKind.");
    }
  } else if (
    !samePath(plan.expectedCurrentPath, plan.candidateDestinationPath) ||
    plan.expectedCurrentSha256 !== plan.candidateSha256
  ) {
    const expectedHistoryPath = path.join(plan.historyPath, path.basename(plan.expectedCurrentPath));
    const prior = state.history.find((entry) => samePath(entry.path, expectedHistoryPath));
    if (!prior) {
      fail(`The bound prior current path is missing from history: ${expectedHistoryPath}.`);
    }
    if (prior.sha256 !== plan.expectedCurrentSha256) {
      fail(`Historical prior current SHA256 differs from expectedCurrentSha256: ${prior.sha256}.`);
    }
    if (prior.revision >= current.revision) {
      fail("The bound prior current revision must be older than the active current revision.");
    }
  }

  return {
    ok: true,
    status: "valid",
    artifactKind: plan.artifactKind,
    candidateRevision: plan.candidateRevision,
    current: { path: current.path, sha256: current.sha256 },
    history: serializeEntries(state.history),
  };
}

export async function auditActiveRevisions(
  rawPlan,
  { verifyCandidate = true, mutexTimeoutMs = 15_000 } = {},
) {
  const plan = normalizePromotionPlan(rawPlan);
  const familyMutexLease = await acquirePromotionFamilyMutex(plan, { timeoutMs: mutexTimeoutMs });
  let operationError = null;
  try {
    assertPromotionFamilyMutexHeld(familyMutexLease);
    return await auditActiveRevisionsUnderFamilyMutex(rawPlan, plan, { verifyCandidate });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releasePromotionFamilyMutex(familyMutexLease);
    } catch (releaseError) {
      if (operationError === null) throw releaseError;
    }
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  try {
    const planPath = parsePlanCli(process.argv.slice(2));
    const plan = await readPromotionPlan(planPath);
    emit(await auditActiveRevisions(plan));
    process.exitCode = 0;
  } catch (error) {
    emit({
      ok: false,
      status: "audit_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
