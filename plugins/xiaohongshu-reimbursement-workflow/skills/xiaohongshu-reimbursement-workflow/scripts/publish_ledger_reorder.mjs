import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalDigest,
  loadLedgerReorderGateArtifact,
} from "./build_ledger_reorder_gate_artifact.mjs";
import {
  auditLedgerReorder,
  emitResult,
  failurePayload,
  loadPlan,
} from "./ledger_reorder_common.mjs";
import {
  validateLedgerReorderPreviewCoverage,
  verifyLedgerReorderPreviewRerender,
} from "./build_ledger_reorder_preview_index.mjs";
import { recoverSafePublish, runSafePublish } from "./run_safe_publish.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const FLAGS = new Set([
  "--plan",
  "--expected-plan-sha256",
  "--expected-baseline-sha256",
  "--expected-candidate-sha256",
  "--expected-batch-id",
  "--expected-operation-digest",
  "--gate-1-artifact",
  "--expected-gate-1-binding-digest",
  "--gate-2-artifact",
  "--expected-gate-2-binding-digest",
]);

const USAGE =
  "Usage: publish_ledger_reorder.mjs --plan <plan.json> --expected-plan-sha256 <hash> " +
  "--expected-baseline-sha256 <hash> --expected-candidate-sha256 <hash> " +
  "--expected-batch-id <id> --expected-operation-digest <hash> " +
  "--gate-1-artifact <gate-1.json> --expected-gate-1-binding-digest <hash> " +
  "--gate-2-artifact <gate-2.json> --expected-gate-2-binding-digest <hash>";
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

function parseArguments(args) {
  if (args.length !== FLAGS.size * 2 || args.length % 2 !== 0) throw new Error(USAGE);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!FLAGS.has(flag) || !value || Object.hasOwn(values, flag)) throw new Error(USAGE);
    values[flag] = value;
  }
  if (Object.keys(values).length !== FLAGS.size) throw new Error(USAGE);
  return values;
}

function requireSha256(value, field) {
  if (typeof value !== "string" || !SHA256_RE.test(value.toLowerCase())) {
    throw new Error(`${field} must be exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isStrictDescendant(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertArtifactInsideStaging(plan, artifactPath, field) {
  const absolute = path.resolve(artifactPath);
  if (!path.isAbsolute(artifactPath) || !isStrictDescendant(plan.stagingRoot, absolute)) {
    throw new Error(`${field} must be an absolute path strictly inside stagingRoot.`);
  }
  const [realRoot, realArtifact] = await Promise.all([fs.realpath(plan.stagingRoot), fs.realpath(absolute)]);
  if (!isStrictDescendant(realRoot, realArtifact)) {
    throw new Error(`${field} must resolve strictly inside stagingRoot.`);
  }
  return absolute;
}

async function stableFileSha256(filePath, field) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${field} must be a regular non-link file.`);
  const bytes = await fs.readFile(filePath);
  const after = await fs.lstat(filePath);
  if (
    !after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`${field} changed while it was being verified.`);
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function stableFileSha256IfExists(filePath, field) {
  try {
    return await stableFileSha256(filePath, field);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertReviewFilesRemainBound(plan, gate1) {
  const previewIndex = gate1.digestPayload.previewIndex;
  validateLedgerReorderPreviewCoverage(plan, previewIndex.files);
  if (previewIndex.planFileSha256 !== plan.planFileSha256) {
    throw new Error("Gate-1 preview index is not bound to the exact current plan file bytes.");
  }
  if (!samePath(previewIndex.candidatePath, plan.activeCandidatePath)) {
    throw new Error("Gate-1 preview index is not bound to the active candidate path.");
  }
  if (previewIndex.candidateSha256 !== gate1.context.candidateSha256) {
    throw new Error("Gate-1 preview index is not bound to the approved candidate bytes.");
  }
  const indexPath = await assertArtifactInsideStaging(plan, previewIndex.path, "gate-1 preview index");
  if (await stableFileSha256(indexPath, "gate-1 preview index") !== previewIndex.sha256) {
    throw new Error("Gate-1 preview index bytes no longer match the approved review package.");
  }
  for (const [index, entry] of previewIndex.files.entries()) {
    const previewPath = await assertArtifactInsideStaging(plan, entry.path, `gate-1 preview[${index}]`);
    if (await stableFileSha256(previewPath, `gate-1 preview[${index}]`) !== entry.sha256) {
      throw new Error(`Gate-1 preview[${index}] bytes no longer match the approved review package.`);
    }
  }
  await verifyLedgerReorderPreviewRerender(plan, previewIndex);
}

function assertGateCommon(gate, expectedGate, expected) {
  if (gate.context.gate !== expectedGate || gate.context.mode !== "ledger-reorder-correction") {
    throw new Error(`${expectedGate} artifact has the wrong gate or mode.`);
  }
  for (const [field, value] of [
    ["batchId", expected.batchId],
    ["operationDigest", expected.operationDigest],
    ["planFileSha256", expected.planFileSha256],
    ["candidateRevision", expected.candidateRevision],
    ["candidateSha256", expected.candidateSha256],
  ]) {
    if (gate.context[field] !== value) throw new Error(`${expectedGate} ${field} differs from the bound publish request.`);
  }
  if (!samePath(gate.context.candidatePath, expected.candidatePath)) {
    throw new Error(`${expectedGate} candidatePath differs from the active candidate bound by the plan.`);
  }
}

try {
  const values = parseArguments(process.argv.slice(2));
  const plan = await loadPlan(path.resolve(values["--plan"]));
  if (plan.version !== 2) throw new Error("Bound-plan publishing requires ledger reorder plan version 2.");

  const expectedPlanSha256 = requireSha256(values["--expected-plan-sha256"], "expected plan SHA256");
  const expectedBaselineSha256 = requireSha256(values["--expected-baseline-sha256"], "expected baseline SHA256");
  const expectedCandidateSha256 = requireSha256(values["--expected-candidate-sha256"], "expected candidate SHA256");
  const expectedOperationDigest = requireSha256(values["--expected-operation-digest"], "expected operation digest");
  const expectedGate1Digest = requireSha256(
    values["--expected-gate-1-binding-digest"],
    "expected gate-1 binding digest",
  );
  const expectedGate2Digest = requireSha256(
    values["--expected-gate-2-binding-digest"],
    "expected gate-2 binding digest",
  );
  const expectedBatchId = requireText(values["--expected-batch-id"], "expected batchId");

  if (expectedPlanSha256 !== plan.planFileSha256) {
    throw new Error("Expected plan SHA256 does not match the exact plan file bytes.");
  }
  if (expectedBaselineSha256 !== plan.expectedSourceSha256) {
    throw new Error("Expected baseline SHA256 must equal the source hash bound by the plan.");
  }

  const gate1Path = await assertArtifactInsideStaging(plan, values["--gate-1-artifact"], "gate-1 artifact");
  const gate2Path = await assertArtifactInsideStaging(plan, values["--gate-2-artifact"], "gate-2 artifact");
  const [gate1, gate2] = await Promise.all([
    loadLedgerReorderGateArtifact(gate1Path),
    loadLedgerReorderGateArtifact(gate2Path),
  ]);
  if (gate1.bindingDigest !== expectedGate1Digest) {
    throw new Error("Gate-1 artifact does not match the approval-bound gate-1 digest.");
  }
  if (gate2.bindingDigest !== expectedGate2Digest) {
    throw new Error("Gate-2 artifact does not match the approval-bound gate-2 digest.");
  }

  const expected = {
    batchId: expectedBatchId,
    operationDigest: expectedOperationDigest,
    planFileSha256: expectedPlanSha256,
    candidateRevision: plan.candidateRevision,
    candidatePath: plan.activeCandidatePath,
    candidateSha256: expectedCandidateSha256,
  };
  assertGateCommon(gate1, "gate-1", expected);
  assertGateCommon(gate2, "gate-2", expected);
  if (!samePath(gate2.context.baselinePath, plan.sourcePath) || gate2.context.baselineSha256 !== expectedBaselineSha256) {
    throw new Error("Gate-2 baseline path or SHA256 differs from the plan-bound source.");
  }
  if (gate1.context.batchId !== gate2.context.batchId || gate1.context.operationDigest !== gate2.context.operationDigest) {
    throw new Error("Gate artifacts do not belong to the same batch and operation.");
  }

  await assertReviewFilesRemainBound(plan, gate1);
  const publishOptions = {
    baselinePath: plan.sourcePath,
    candidatePath: plan.activeCandidatePath,
    targetPath: plan.targetPath,
    expectedBaselineSha256,
    expectedCandidateSha256,
  };
  const recoveryResult = recoverSafePublish(publishOptions);
  let result;
  if (recoveryResult.status === "no_recovery") {
    const targetAlreadyPublished =
      await stableFileSha256IfExists(plan.targetPath, "current standard ledger") === expectedCandidateSha256;
    if (targetAlreadyPublished) {
      result = {
        ok: true,
        status: "already_current",
        target: plan.targetPath,
        sha256: expectedCandidateSha256,
      };
    } else {
      const finalAudit = await auditLedgerReorder(plan, plan.activeCandidatePath);
      if (
        finalAudit.sourceSha256 !== expectedBaselineSha256 ||
        finalAudit.candidateSha256 !== expectedCandidateSha256
      ) {
        throw new Error("Current exhaustive audit does not match the expected baseline and candidate bytes.");
      }
      const actualAuditDigest = canonicalDigest(finalAudit);
      if (
        canonicalDigest(gate1.digestPayload.audit) !== actualAuditDigest ||
        canonicalDigest(gate2.digestPayload.audit) !== actualAuditDigest
      ) {
        throw new Error("Gate audit payloads do not match the current exhaustive audit result.");
      }
      result = runSafePublish(publishOptions);
    }
  } else {
    result = { ...recoveryResult, recovered: true };
  }
  const [publishedTargetSha256, activeCandidateSha256] = await Promise.all([
    stableFileSha256(plan.targetPath, "published standard ledger"),
    stableFileSha256(plan.activeCandidatePath, "active candidate after publish"),
  ]);
  if (publishedTargetSha256 !== expectedCandidateSha256 || activeCandidateSha256 !== expectedCandidateSha256) {
    throw new Error("Post-publish target or active candidate SHA256 differs from the approval-bound candidate.");
  }
  emitResult({
    ...result,
    mode: "ledger-reorder-correction",
    planPath: plan.planPath,
    planFileSha256: plan.planFileSha256,
    activeCandidatePath: plan.activeCandidatePath,
    gate1BindingDigest: gate1.bindingDigest,
    gate2BindingDigest: gate2.bindingDigest,
    finalAuditDigest: gate2.context.finalAuditDigest,
  });
  process.exitCode = 0;
} catch (error) {
  const payload = failurePayload(error);
  if (error && typeof error === "object" && error.recovery) payload.recovery = error.recovery;
  emitResult(payload, { failure: true });
  process.exitCode = 1;
}
console.log = originalConsoleLog;
console.warn = originalConsoleWarn;
