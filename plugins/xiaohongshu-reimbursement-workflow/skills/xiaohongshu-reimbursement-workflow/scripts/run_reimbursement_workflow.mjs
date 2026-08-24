import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { buildGateBinding } from "./build_gate_binding.mjs";
import { loadProfileRegistry } from "./finance_domain.mjs";
import { runSafePublish, runSafePublishAsync } from "./run_safe_publish.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
  loadBundledDependency,
  mapSettledLimit,
  parseStrictJson,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";

export const WORKFLOW_PREPARE_KIND = "ordinary-reimbursement-prepare-v1";
export const WORKFLOW_GATE1_KIND = "ordinary-reimbursement-ready-gate-1-v1";
export const WORKFLOW_GATE2_KIND = "ordinary-reimbursement-ready-gate-2-v1";
export const WORKFLOW_RECEIPT_KIND = "ordinary-reimbursement-published-v1";
export const WORKFLOW_PUBLISH_AUDIT_KIND = "ordinary-reimbursement-publish-audit-v1";
export const WORKFLOW_READY_PREVIEW_KIND = "ordinary-reimbursement-ready-preview-v1";

const TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_AUDITOR = path.join(SCRIPT_DIR, "audit_batch_manifest.mjs");
const PREVIEW_RENDERER = path.join(SCRIPT_DIR, "render_reimbursement_previews.ps1");
const WORKFLOW_PREFIX = "codex-xhs-workflow-";
const GATE1_TEXT = "本次报销通过无误";
const GATE2_TEXT = "确认更新根目录支出总表";
const PREVIEW_REQUEST_KIND = "ordinary-reimbursement-preview-request-v2";
const PREVIEW_RESPONSE_KIND = "ordinary-reimbursement-preview-response-v2";
const PREVIEW_RESULT_KIND = "ordinary-reimbursement-preview-set-v2";
const FULL_CORRESPONDENCE_AUDIT_KIND = "gate2-full-correspondence-v1";
const GATE2_ATTEMPT_REPORT_RE = /^gate2-review-([0-9a-f]{64})\.json$/u;
const GATE2_CORRECTION_KIND = "gate2-correction-carry-forward-v1";
const GATE1_RESTART_KIND = "gate1-restart-required-v1";
const GATE1_RESTART_REQUIRED_ERROR_CODE = "XHS_GATE1_RESTART_REQUIRED";
const VERIFIED_GATE2_CORRECTIONS = new WeakSet();
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_RENDERER_OUTPUT_BYTES = 2 * 1024 * 1024;
const RENDERER_TIMEOUT_MS = 120_000;
const PREVIEW_VALIDATION_CONCURRENCY = 3;
const REIMBURSEMENT_ARTIFACT_BUILD_KIND = "reimbursement-artifact-build-request-v1";

function loadPreviewSharp() {
  const module = loadBundledDependency("sharp");
  return module.default ?? module;
}

function fail(message) {
  throw new Error(`Ordinary Reimbursement Workflow ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) fail(`${field} must be a trimmed non-empty string.`);
  return value;
}

function sha(value, field) {
  const result = text(value, field);
  if (!SHA_RE.test(result)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function exact(value, keys, field) {
  object(value, field);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function withoutDigest(value, field) {
  const result = clone(value);
  delete result[field];
  return result;
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function deriveToken(token, role) {
  return sha256Bytes(`${token}:${role}`);
}

async function writeExclusiveJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const expectedSha256 = sha256Bytes(bytes);
  let created = false;
  try {
    const handle = await fs.open(filePath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw new Error(`${error instanceof Error ? error.message : String(error)}; incomplete exclusive JSON cleanup: ${filePath}`, { cause: error });
      }
    }
    throw error;
  }
  // This is a task-owned, exclusive, fsynced write. Consumers independently
  // re-read against this binding, so an immediate double read adds no durable
  // protection and only repeats I/O.
  return { path: filePath, sha256: expectedSha256, size: bytes.length };
}

function errorHasCode(error, code) {
  let current = error;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current.code === code) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function isRetryableInfrastructureError(error) {
  return ["EACCES", "EPERM", "EBUSY", "EMFILE", "ENFILE", "ENOMEM", "EIO", "ETIMEDOUT"].some((code) => errorHasCode(error, code));
}

function gate1RestartError(message, cause) {
  const error = new Error(`Ordinary Reimbursement Workflow ${message}`, cause instanceof Error ? { cause } : undefined);
  error.code = GATE1_RESTART_REQUIRED_ERROR_CODE;
  return error;
}

async function readOptionalStableJson(filePath) {
  try {
    return await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function writeIdempotentJson(filePath, value) {
  try {
    return await writeExclusiveJson(filePath, value);
  } catch (error) {
    if (!errorHasCode(error, "EEXIST")) throw error;
    const existing = await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
    if (canonicalDigest(existing.value) !== canonicalDigest(value)) fail(`content-addressed JSON differs at ${filePath}.`);
    return { path: filePath, sha256: existing.sha256, size: existing.size };
  }
}

async function writeGate1RestartMarker(workflowRoot, gate1BindingDigest, reason, evidenceDigest) {
  const core = { kind: GATE1_RESTART_KIND, gate1BindingDigest, reason, evidenceDigest };
  return writeIdempotentJson(path.join(workflowRoot, "gate1-restart-required.json"), { ...core, markerDigest: canonicalDigest(core) });
}

async function assertNoGate1RestartMarker(workflowRoot, gate1BindingDigest) {
  const markerPath = path.join(workflowRoot, "gate1-restart-required.json");
  const existing = await readOptionalStableJson(markerPath);
  if (!existing) return markerPath;
  const marker = object(existing.value, "Gate 1 restart marker");
  if (marker.kind !== GATE1_RESTART_KIND || marker.gate1BindingDigest !== gate1BindingDigest || canonicalDigest(withoutDigest(marker, "markerDigest")) !== marker.markerDigest) fail("Gate 1 restart marker is invalid.");
  throw gate1RestartError(`${marker.reason}; a new Gate 1 is required. Evidence: ${marker.evidenceDigest}`);
}

function validateGate1RestartLineage(value, field) {
  const seen = new Set();
  return array(value, field).map((entry, index) => {
    const itemField = `${field}[${index}]`;
    exact(entry, new Set(["workflowRoot", "gate1BindingDigest"]), itemField);
    const workflowRoot = text(entry.workflowRoot, `${itemField}.workflowRoot`);
    if (!path.isAbsolute(workflowRoot) || workflowRoot !== path.resolve(workflowRoot)) fail(`${itemField}.workflowRoot must be a normalized absolute path.`);
    const key = process.platform === "win32" ? workflowRoot.toLowerCase() : workflowRoot;
    if (seen.has(key)) fail(`${field} contains a duplicate workflow root.`);
    seen.add(key);
    return { workflowRoot, gate1BindingDigest: sha(entry.gate1BindingDigest, `${itemField}.gate1BindingDigest`) };
  });
}

function gate1RestartLineage(state) {
  const inherited = state.gate2Correction
    ? validateGate2Correction(state.gate2Correction, "workflow Gate 2 correction").restartLineage
    : [];
  return validateGate1RestartLineage([
    ...inherited,
    { workflowRoot: path.resolve(state.workflowRoot), gate1BindingDigest: state.gate1.bindingDigest },
  ], "Gate 1 restart lineage");
}

async function assertNoGate1RestartRequired(state) {
  for (const item of gate1RestartLineage(state)) await assertNoGate1RestartMarker(item.workflowRoot, item.gate1BindingDigest);
}

async function writeGate1RestartRequired(state, reason, evidenceDigest) {
  return Promise.all(gate1RestartLineage(state).map(async (item) => ({
    ...item,
    ...(await writeGate1RestartMarker(item.workflowRoot, item.gate1BindingDigest, reason, evidenceDigest)),
  })));
}

async function listGate2AttemptReports(workflowRoot, gate1BindingDigest) {
  const entries = await fs.readdir(workflowRoot, { withFileTypes: true });
  const reports = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const match = GATE2_ATTEMPT_REPORT_RE.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`Gate 2 attempt report ${entry.name} is not a plain file.`);
    const filePath = path.join(workflowRoot, entry.name);
    const stable = await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
    const report = object(stable.value, `Gate 2 attempt report ${entry.name}`);
    if (
      report.kind !== FULL_CORRESPONDENCE_AUDIT_KIND
      || report.reportDigest !== match[1]
      || canonicalDigest(withoutDigest(report, "reportDigest")) !== report.reportDigest
      || report.gate1BindingDigest !== gate1BindingDigest
      || !new Set(["REVIEW_REQUIRED", "CORRECTION_REQUIRED", "BLOCKED_RETRYABLE", "GATE1_REQUIRED"]).has(report.disposition)
    ) fail(`Gate 2 attempt report ${entry.name} is invalid.`);
    reports.push({ path: filePath, sha256: stable.sha256, size: stable.size, reportDigest: report.reportDigest, disposition: report.disposition });
  }
  return reports;
}

async function validateFindingResolution(report, workflowRoot, gate1BindingDigest) {
  const resolution = report.findingResolution;
  if (!resolution) return;
  if (resolution.decision === "gate1-content-error" && !new Set(["CORRECTION_REQUIRED", "BLOCKED_RETRYABLE", "GATE1_REQUIRED"]).has(report.disposition)) fail("gate1-content-error resolution has an invalid Gate 2 disposition.");
  if (resolution.decision === "evidence-uncertain" && report.disposition !== "GATE1_REQUIRED") fail("evidence-uncertain resolution has an invalid Gate 2 disposition.");
  const priorPath = path.join(workflowRoot, `gate2-review-${resolution.priorReportDigest}.json`);
  const prior = await readStableUtf8JsonFile(priorPath, { maxBytes: MAX_JSON_BYTES });
  const priorReport = object(prior.value, "prior Gate 2 finding report");
  if (
    priorReport.kind !== FULL_CORRESPONDENCE_AUDIT_KIND
    || priorReport.reportDigest !== resolution.priorReportDigest
    || canonicalDigest(withoutDigest(priorReport, "reportDigest")) !== priorReport.reportDigest
    || priorReport.gate1BindingDigest !== gate1BindingDigest
    || priorReport.independentEvidenceReviewSha256 !== resolution.priorReviewSha256
    || priorReport.disposition !== "REVIEW_REQUIRED"
    || array(priorReport.reviewFindings, "prior Gate 2 finding report reviewFindings").length === 0
  ) fail("Gate 2 finding resolution is not bound to a valid prior review attempt.");
}

function correctionAuthorizationCore(value) {
  const result = clone(value);
  delete result.authorizationDigest;
  return result;
}

function validateGate2Correction(value, field = "Gate 2 correction") {
  exact(value, new Set(["kind", "priorGate1BindingDigest", "attemptReport", "manifestChanged", "restartLineage", "authorizationDigest"]), field);
  if (value.kind !== GATE2_CORRECTION_KIND) fail(`${field} kind is invalid.`);
  const priorGate1BindingDigest = sha(value.priorGate1BindingDigest, `${field}.priorGate1BindingDigest`);
  exact(value.attemptReport, new Set(["path", "sha256", "size", "reportDigest", "disposition"]), `${field}.attemptReport`);
  const attemptReportPath = text(value.attemptReport.path, `${field}.attemptReport.path`);
  if (!path.isAbsolute(attemptReportPath) || attemptReportPath !== path.resolve(attemptReportPath)) fail(`${field}.attemptReport.path must be a normalized absolute path.`);
  sha(value.attemptReport.sha256, `${field}.attemptReport.sha256`);
  sha(value.attemptReport.reportDigest, `${field}.attemptReport.reportDigest`);
  if (!Number.isSafeInteger(value.attemptReport.size) || value.attemptReport.size < 1) fail(`${field}.attemptReport.size is invalid.`);
  if (!new Set(["REVIEW_REQUIRED", "CORRECTION_REQUIRED", "BLOCKED_RETRYABLE"]).has(value.attemptReport.disposition)) fail(`${field}.attemptReport.disposition is invalid.`);
  if (typeof value.manifestChanged !== "boolean") fail(`${field}.manifestChanged must be boolean.`);
  const restartLineage = validateGate1RestartLineage(value.restartLineage, `${field}.restartLineage`);
  const lineageTail = restartLineage.at(-1);
  if (!lineageTail) fail(`${field}.restartLineage must contain the prior Gate 1 workflow.`);
  if (lineageTail.gate1BindingDigest !== priorGate1BindingDigest) fail(`${field}.restartLineage tail does not match priorGate1BindingDigest.`);
  if (!samePath(path.dirname(attemptReportPath), lineageTail.workflowRoot)) fail(`${field}.attemptReport must belong to the prior Gate 1 workflow root.`);
  if (sha(value.authorizationDigest, `${field}.authorizationDigest`) !== canonicalDigest(correctionAuthorizationCore(value))) fail(`${field} authorization digest is invalid.`);
  return value;
}

function correctionSourceInventory(manifest) {
  return array(manifest.files, "manifest.files").map((file, index) => ({
    id: text(file?.id, `manifest.files[${index}].id`),
    role: text(file?.role, `manifest.files[${index}].role`),
    path: path.resolve(text(file?.path, `manifest.files[${index}].path`)),
    sha256: sha(file?.sha256, `manifest.files[${index}].sha256`),
    kind: file?.kind ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function assertSameGate2CorrectionScope(priorManifest, revisedManifest) {
  const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);
  if (priorManifest.version !== revisedManifest.version || priorManifest.rulesVersion !== revisedManifest.rulesVersion) fail("Gate 2 correction changed the manifest contract; a new Gate 1 is required.");
  const priorBatch = object(priorManifest.batch, "prior manifest.batch");
  const revisedBatch = object(revisedManifest.batch, "revised manifest.batch");
  for (const field of ["batchId", "rootPath", "targetCategory"]) if (!same(priorBatch[field], revisedBatch[field])) fail(`Gate 2 correction changed batch.${field}; a new Gate 1 is required.`);
  if (!same(priorBatch.mainPeriod, revisedBatch.mainPeriod) || !same(priorBatch.period, revisedBatch.period)) fail("Gate 2 correction changed the main reimbursement period; a new Gate 1 is required.");
  if (!same(priorManifest.operation, revisedManifest.operation)) fail("Gate 2 correction changed the operation mode; a new Gate 1 is required.");
  if (!same(correctionSourceInventory(priorManifest), correctionSourceInventory(revisedManifest))) fail("Gate 2 correction changed the original file set, path, kind, or SHA; a new Gate 1 is required.");
  const priorArchiveParent = path.dirname(path.resolve(text(priorBatch.archivePath, "prior manifest.batch.archivePath")));
  const revisedArchiveParent = path.dirname(path.resolve(text(revisedBatch.archivePath, "revised manifest.batch.archivePath")));
  if (!samePath(priorArchiveParent, revisedArchiveParent)) fail("Gate 2 correction moved the archive outside its original parent; a new Gate 1 is required.");
  const priorRevision = priorBatch.reviewRevision;
  const revisedRevision = revisedBatch.reviewRevision;
  if (!Number.isSafeInteger(priorRevision) || !Number.isSafeInteger(revisedRevision) || revisedRevision < priorRevision) fail("Gate 2 correction reviewRevision cannot decrease.");
}

function dedupeBoundFiles(files) {
  const result = new Map();
  for (const file of files) {
    if (!file?.path || !file?.sha256) continue;
    const key = process.platform === "win32" ? path.resolve(file.path).toLowerCase() : path.resolve(file.path);
    const prior = result.get(key);
    if (prior && (prior.sha256 !== file.sha256 || (prior.size !== undefined && file.size !== undefined && prior.size !== file.size))) fail(`cleanup binding conflicts for ${file.path}.`);
    result.set(key, { path: path.resolve(file.path), sha256: file.sha256, ...(file.size === undefined ? {} : { size: file.size }) });
  }
  return [...result.values()];
}

async function correctionCleanupFor(ready) {
  const attemptReports = await listGate2AttemptReports(ready.state.workflowRoot, ready.state.gate1.bindingDigest);
  const inherited = ready.state.supersededWorkflowCleanup ?? { files: [], roots: [] };
  return {
    files: dedupeBoundFiles([
      ...(inherited.files ?? []),
      ...ready.state.rootBuild.ownedFiles,
      ...ready.state.presentationBuild.ownedFiles,
      ...ready.state.previewBuild.ownedFiles,
      ...attemptReports,
      ready.state.previewCheckpoint,
      { path: ready.path, sha256: ready.snapshot.sha256, size: ready.snapshot.size },
    ]),
    roots: [...new Set([...(inherited.roots ?? []), ready.state.previewBuild.outputRoot, ready.state.rootBuild.stagingRoot, ready.state.presentationBuild.stagingRoot, ready.state.workflowRoot].filter(Boolean).map((item) => path.resolve(item)))],
  };
}

async function assertBoundFile(binding, field) {
  const stable = await readStableBinaryFile(binding.path);
  if (stable.sha256 !== binding.sha256 || (binding.size !== undefined && stable.size !== binding.size)) fail(`${field} changed after binding.`);
  return stable;
}

async function assertGate1BaselinesUnchanged(baselines) {
  const settled = await Promise.allSettled(baselines.map((baseline) => assertBoundFile(baseline, `${baseline.profileId} Gate 1 baseline`)));
  const failure = settled.find((result) => result.status === "rejected");
  if (!failure) return;
  const error = failure.reason;
  if (isRetryableInfrastructureError(error)) throw error;
  throw gate1RestartError(
    `formal ledger baseline changed after Gate 1; a new Gate 1 is required: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}

async function assertSourceMaterialsUnchanged(manifestBinding, phase) {
  try {
    const stable = await readStableUtf8JsonFile(manifestBinding.path, { maxBytes: MAX_JSON_BYTES });
    if (stable.sha256 !== manifestBinding.sha256) fail(`${phase} manifest changed after Gate 1.`);
    const manifest = object(stable.value, `${phase} manifest`);
    const materials = new Map();
    for (const [index, file] of array(manifest.files, `${phase} manifest.files`).entries()) {
      if (file?.role !== "material") continue;
      const binding = {
        path: path.resolve(text(file.path, `${phase} manifest.files[${index}].path`)),
        sha256: sha(file.sha256, `${phase} manifest.files[${index}].sha256`),
      };
      const key = process.platform === "win32" ? binding.path.toLowerCase() : binding.path;
      const prior = materials.get(key);
      if (prior && prior.sha256 !== binding.sha256) fail(`${phase} manifest binds one material path to multiple SHA values.`);
      materials.set(key, binding);
    }
    await mapSettledLimit([...materials.values()], 4, (binding) => assertBoundFile(binding, `${phase} source material`));
    return manifest;
  } catch (error) {
    if (error?.code === GATE1_RESTART_REQUIRED_ERROR_CODE || isRetryableInfrastructureError(error)) throw error;
    throw gate1RestartError(
      `${phase} source material changed after Gate 2; a new Gate 1 is required: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function createManifestAuditSession() {
  const worker = new Worker(pathToFileURL(MANIFEST_AUDITOR), {
    execArgv: [],
    workerData: { kind: "ordinary-manifest-audit-session-v1" },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
  });
  let state = "starting"; let fatalError = null; let pending = null; let nextRequestId = 1; let queue = Promise.resolve();
  let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const failSession = (error) => {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error)); state = "closed";
    if (pending) { clearTimeout(pending.timer); pending.reject(fatalError); pending = null; }
    else readyReject(fatalError);
  };
  worker.on("message", (message) => {
    if (state === "starting" && message?.kind === "ordinary-manifest-audit-session-ready-v1") { state = "ready"; readyResolve(); return; }
    if (state !== "running" || message?.kind !== "ordinary-manifest-audit-session-result-v1" || message.requestId !== pending?.requestId) return failSession(new Error("manifest audit session response protocol is invalid"));
    const current = pending; pending = null; clearTimeout(current.timer); state = "ready";
    if (message.ok !== true) current.reject(new Error(`manifest audit failed: ${message.error ?? "unknown worker error"}`));
    else current.resolve(message.result);
  });
  worker.once("error", failSession);
  worker.once("exit", (code) => { if (state !== "closed") failSession(new Error(`manifest audit session exited with code ${code}`)); });
  worker.unref();
  const runOne = async (manifestPath) => {
    await ready;
    if (fatalError || state !== "ready") throw fatalError ?? new Error("manifest audit session is unavailable");
    const requestId = nextRequestId; nextRequestId += 1; state = "running";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { failSession(new Error("manifest audit timed out")); void worker.terminate(); }, 60_000);
      pending = { requestId, resolve, reject, timer };
      worker.postMessage({ kind: "ordinary-manifest-audit-session-request-v1", requestId, manifestPath, deferOrdinaryFileVerification: true });
    });
  };
  return Object.freeze({
    run(manifestPath) {
      const result = queue.then(() => runOne(manifestPath));
      queue = result.catch(() => {});
      return result;
    },
  });
}

const manifestAuditSession = createManifestAuditSession();

export async function auditManifest(manifestPath, expectedSha256) {
  const result = object(await manifestAuditSession.run(manifestPath), "manifest audit result");
  if (result.ok !== true || result.manifestFileSha256 !== expectedSha256 || result.fileVerificationMode !== "bound-builders" || !result.reimbursementFactsCertificate) fail("manifest audit result is incomplete or changed.");
  return result;
}

function aggregateGate(gate, bindings, extra = {}) {
  const body = {
    kind: `ordinary-reimbursement-${gate}-binding-v1`,
    gate,
    profiles: bindings.map((item) => ({ profileId: item.profileId, bindingDigest: item.bindingDigest, context: item.context })),
    ...extra,
  };
  return deepFreeze({ ...body, bindingDigest: canonicalDigest(body) });
}

function gate1For(audit, rootBuild, reviewPackageDigest) {
  return aggregateGate("gate-1", rootBuild.artifacts.map((artifact) => {
    const binding = buildGateBinding({
      version: 2,
      gate: "gate-1",
      mode: "reimbursement-batch",
      batchId: audit.batch.batchId,
      operationDigest: audit.operationDigest,
      candidateRevision: artifact.candidateRevision,
      candidatePath: artifact.candidatePath,
      candidateSha256: artifact.candidateSha256,
      candidatePlanSha256: artifact.planSha256,
      sourceCoverageDigest: audit.sourceCoverageDigest,
      factsDigest: audit.factsDigest,
      reviewPackageDigest,
    });
    return { profileId: artifact.profileId, ...binding };
  }));
}

function gate2For(audit, rootBuild, finalAudits, baselines, gate2PreviewDigest, correspondenceAudit) {
  const previewDigest = sha(gate2PreviewDigest, "gate2PreviewDigest");
  const auditByProfile = new Map(finalAudits.map((item) => [item.profileId ?? item.profile?.profileId, item]));
  const baselineByProfile = new Map(baselines.map((item) => [item.profileId, item]));
  return aggregateGate("gate-2", rootBuild.artifacts.map((artifact) => {
    const finalAudit = auditByProfile.get(artifact.profileId);
    const baseline = baselineByProfile.get(artifact.profileId);
    if (!finalAudit || !baseline) fail(`${artifact.profileId} final audit or baseline binding is missing.`);
    const binding = buildGateBinding({
      version: 2,
      gate: "gate-2",
      mode: "reimbursement-batch",
      batchId: audit.batch.batchId,
      operationDigest: audit.operationDigest,
      candidateRevision: artifact.candidateRevision,
      candidatePath: artifact.candidatePath,
      candidateSha256: artifact.candidateSha256,
      baselinePath: baseline.path,
      baselineSha256: baseline.sha256,
      finalAuditDigest: finalAudit.auditDigest,
      candidatePlanSha256: artifact.planSha256,
      sourceCoverageDigest: audit.sourceCoverageDigest,
    });
    return { profileId: artifact.profileId, ...binding };
  }), {
    gate2PreviewDigest: previewDigest,
    fullCorrespondenceAuditDigest: sha(correspondenceAudit.reportDigest, "fullCorrespondenceAuditDigest"),
    independentEvidenceReviewDigest: sha(correspondenceAudit.independentEvidenceReviewDigest, "independentEvidenceReviewDigest"),
  });
}

async function cleanupBound(files, roots) {
  const preserved = [];
  const failures = [];
  for (const item of [...files].reverse()) {
    try {
      const current = await readStableBinaryFile(item.path);
      if (current.sha256 !== item.sha256 || (item.size !== undefined && current.size !== item.size)) {
        preserved.push(item.path);
        continue;
      }
      await fs.unlink(item.path);
    } catch (error) {
      if (!errorHasCode(error, "ENOENT")) failures.push({ path: item.path, error });
    }
  }
  const orderedRoots = [...new Set(roots.map((root) => path.resolve(root)))]
    .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length || right.length - left.length);
  for (const root of orderedRoots) {
    try { await fs.rmdir(root); } catch (error) { if (error?.code !== "ENOENT") failures.push({ path: root, error }); }
  }
  return { preserved, failures };
}

async function writeAuditRequest(workflowRoot, certificate, profiles, role, rootAuditModule) {
  const requestNonce = crypto.randomBytes(32).toString("hex");
  const request = { kind: rootAuditModule.ROOT_WORKBOOK_AUDIT_REQUEST_KIND, requestNonce, reimbursementFactsCertificate: certificate, profiles };
  request.requestDigest = rootAuditModule.computeRootWorkbookAuditRequestDigest(request);
  const binding = await writeExclusiveJson(path.join(workflowRoot, `.${role}-audit-${requestNonce}.json`), request);
  return { request, binding };
}

async function runBatchAudit(workflowRoot, certificate, profiles, role) {
  const rootAuditModule = await import("./build_root_workbook_candidate.mjs");
  const { request, binding } = await writeAuditRequest(workflowRoot, certificate, profiles, role, rootAuditModule);
  try {
    const raw = await rootAuditModule.runRootWorkbookAuditWorker({ requestPath: binding.path, requestFileSha256: binding.sha256, requestNonce: request.requestNonce });
    const { rawStdout: _stdout, ...response } = raw;
    return rootAuditModule.validateRootWorkbookAuditBatch(response, {
      requestDigest: request.requestDigest,
      requestFileSha256: binding.sha256,
      requestNonce: request.requestNonce,
      profileIds: profiles.map((item) => item.profileId),
      profileBindings: profiles.map(({ profileId, baselineSha256, candidateSha256, localPatchCertificate }) => ({ profileId, baselineSha256, candidateSha256, localPatchCertificate })),
      certificate,
    });
  } finally {
    const current = await readStableBinaryFile(binding.path).catch(() => null);
    if (current?.sha256 === binding.sha256) await fs.unlink(binding.path);
  }
}

async function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}

async function runPreviewRenderer({ requestPath, requestFileSha256, requestNonce }) {
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Sta",
    "-ExecutionPolicy", "Bypass",
    "-File", PREVIEW_RENDERER,
    "-RequestPath", requestPath,
    "-RequestSha256", requestFileSha256,
    "-RequestNonce", requestNonce,
  ], {
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopReason = null;
    let done = false;
    const terminate = (reason) => {
      if (!stopReason) stopReason = reason;
      void killProcessTree(child);
    };
    const timer = setTimeout(() => terminate(new Error("preview renderer timed out")), RENDERER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RENDERER_OUTPUT_BYTES) terminate(new Error("preview renderer stdout exceeded its bounded limit"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_RENDERER_OUTPUT_BYTES) terminate(new Error("preview renderer stderr exceeded its bounded limit"));
      else stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!done) { done = true; reject(error); }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (stopReason) return reject(stopReason);
      const rawStdout = Buffer.concat(stdout).toString("utf8");
      const rawStderr = Buffer.concat(stderr).toString("utf8");
      if (code !== 0 || signal || rawStderr) return reject(new Error(`preview renderer failed (${code ?? signal}): ${rawStderr.trim()}`));
      const lines = rawStdout.split(/\r?\n/u).filter(Boolean);
      if (lines.length !== 1) return reject(new Error("preview renderer must return exactly one JSON line"));
      try { resolve(parseStrictJson(lines[0])); } catch (error) { reject(new Error("preview renderer returned invalid strict JSON", { cause: error })); }
    });
  });
}

function bindingText(value, field) {
  const result = text(value, field);
  if (result.includes("\0")) fail(`${field} contains a forbidden NUL character.`);
  return result;
}

function normalizedBatchRows(value, field = "batchRows") {
  if (!Array.isArray(value) || value.length < 1) fail(`${field} must be a non-empty array.`);
  return value.map((entry, index) => {
    const rowRange = bindingText(entry, `${field}[${index}]`);
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(rowRange)) fail(`${field}[${index}] is invalid.`);
    const [start, end] = rowRange.split(":").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) fail(`${field}[${index}] is not an ordered row range.`);
    return rowRange;
  });
}

export function previewJobBindingDigest(rawJob) {
  const job = object(rawJob, "preview job binding");
  const fields = [
    "preview-job-binding-v2",
    bindingText(job.profileId, "preview job profileId"),
    bindingText(job.role, "preview job role"),
    sha(job.workbookSha256, "preview job workbookSha256"),
    bindingText(job.sheetName, "preview job sheetName"),
    bindingText(job.rangeAddress, "preview job rangeAddress"),
    sha(job.candidateSha256, "preview job candidateSha256"),
    sha(job.planSha256, "preview job planSha256"),
    sha(job.sourceCoverageDigest, "preview job sourceCoverageDigest"),
    normalizedBatchRows(job.batchRows).join(","),
  ];
  return sha256Bytes(fields.join("\0"));
}

export async function inspectPreviewPng(bytes, field = "preview") {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1_000) fail(`${field} is not a non-empty PNG.`);
  try {
    const sharp = loadPreviewSharp();
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 });
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (metadata.format !== "png" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 50_000 || height > 50_000) {
      fail(`${field} dimensions or format are invalid.`);
    }
    const aspectRatio = width / height;
    if (aspectRatio < 0.01 || aspectRatio > 100) fail(`${field} has an unreasonable aspect ratio.`);
    const stats = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 }).stats();
    const visibleChannels = stats.channels.slice(0, Math.min(3, stats.channels.length));
    if (visibleChannels.length < 1 || !visibleChannels.some((channel) => channel.max > channel.min && channel.stdev > 0.05) || !Number.isFinite(stats.entropy) || stats.entropy <= 0.0001) {
      fail(`${field} is blank or has no meaningful pixel variance.`);
    }
    return { width, height };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Ordinary Reimbursement Workflow ")) throw error;
    fail(`${field} cannot be fully decoded as PNG: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function buildReviewPreviews(workflowRoot, rootBuild, presentationBuild, sourceCoverageDigest, testHooks, stage = "gate-1", verifiedPreviewBuild = undefined) {
  if (!new Set(["gate-1", "gate-2"]).has(stage)) fail("preview stage is invalid.");
  if (verifiedPreviewBuild !== undefined && stage !== "gate-2") fail("only Gate 2 may build verified preview copies.");
  const outputRoot = verifiedPreviewBuild?.outputRoot ?? path.join(workflowRoot, `${stage}-previews`);
  const jobs = [];
  let requestNonce;
  let requestPath;
  let requestFile;
  let response;
  try {
    if (verifiedPreviewBuild === undefined) await fs.mkdir(outputRoot, { recursive: false });
    const verifiedByRole = new Map((verifiedPreviewBuild?.previews ?? []).map((item) => [`${item.profileId}\0${item.role}`, item]));
    const outputPathFor = (profileId, role) => verifiedByRole.get(`${profileId}\0${role}`)?.path ?? path.join(outputRoot, `${profileId}-${role}.png`);
    const presentationByProfile = new Map(presentationBuild.artifacts.map((item) => [item.profileId, item]));
    const bindings = [];
    for (const root of rootBuild.artifacts) {
    const presentation = presentationByProfile.get(root.profileId);
    if (!presentation) fail(`${root.profileId} presentation artifact is missing for preview rendering.`);
    if (!root.previewPath || !root.candidatePath || samePath(root.previewPath, root.candidatePath)) fail(`${root.profileId} root preview must be a dedicated batch-only projection and cannot fall back to the candidate workbook.`);
    const profileBinding = {
      profileId: root.profileId,
      candidateSha256: root.candidateSha256,
      planSha256: root.planSha256,
      sourceCoverageDigest: sha(sourceCoverageDigest, "sourceCoverageDigest"),
      batchRows: root.audit.projection.batchRanges.map((range) => `${range.startRow}:${range.endRow}`),
      rootPreviewRange: root.previewRangeAddress,
    };
    profileBinding.batchRows = normalizedBatchRows(profileBinding.batchRows, `${root.profileId} batchRows`);
    bindings.push(profileBinding);
    const bindJob = (job) => {
      const bound = {
        ...job,
        candidateSha256: profileBinding.candidateSha256,
        planSha256: profileBinding.planSha256,
        sourceCoverageDigest: profileBinding.sourceCoverageDigest,
        batchRows: [...profileBinding.batchRows],
      };
      return { ...bound, bindingDigest: previewJobBindingDigest(bound) };
    };
    jobs.push(
      bindJob({
        profileId: root.profileId,
        role: "root",
        workbookPath: root.previewPath,
        workbookSha256: root.previewSha256,
        sheetName: root.previewSheetName,
        rangeAddress: root.previewRangeAddress,
        outputPath: outputPathFor(root.profileId, "root"),
      }),
      bindJob({
        profileId: root.profileId,
        role: "detail",
        workbookPath: presentation.detail.path,
        workbookSha256: presentation.detail.sha256,
        sheetName: presentation.detail.sheetName,
        rangeAddress: `A1:F${presentation.detail.endRow}`,
        outputPath: outputPathFor(root.profileId, "detail"),
      }),
      bindJob({
        profileId: root.profileId,
        role: "screenshot",
        workbookPath: presentation.screenshot.path,
        workbookSha256: presentation.screenshot.sha256,
        sheetName: presentation.screenshot.sheetName,
        rangeAddress: `A1:${presentation.screenshot.endColumn}${presentation.screenshot.endRow}`,
        outputPath: outputPathFor(root.profileId, "screenshot"),
      }),
    );
    }
    requestNonce = crypto.randomBytes(32).toString("hex");
    const requestBindingDigest = canonicalDigest({
    bindings,
    jobs: jobs.map(({ profileId, role, workbookSha256, sheetName, rangeAddress, candidateSha256, planSha256, sourceCoverageDigest: coverage, batchRows, bindingDigest }) => ({
      profileId,
      role,
      workbookSha256,
      sheetName,
      rangeAddress,
      candidateSha256,
      planSha256,
      sourceCoverageDigest: coverage,
      batchRows,
      bindingDigest,
    })),
  });
    const request = { kind: PREVIEW_REQUEST_KIND, requestNonce, outputRoot, bindingDigest: requestBindingDigest, bindings, jobs };
    requestPath = path.join(workflowRoot, `.${stage}-preview-request-${requestNonce}.json`);
    requestFile = verifiedPreviewBuild === undefined
      ? await writeExclusiveJson(requestPath, request)
      : undefined;
    if (verifiedPreviewBuild !== undefined) {
      if (!Array.isArray(verifiedPreviewBuild.previews) || verifiedPreviewBuild.previews.length !== jobs.length) fail("Gate 1 preview set cannot satisfy the Gate 2 preview contract.");
      response = {
        kind: PREVIEW_RESPONSE_KIND,
        requestNonce,
        requestFileSha256: null,
        bindingDigest: requestBindingDigest,
        enginePeakWorkingSetBytes: 1,
        previews: await Promise.all(jobs.map(async (job, index) => {
          const prior = verifiedPreviewBuild.previews[index];
          if (
            prior.profileId !== job.profileId
            || prior.role !== job.role
            || prior.sourceSha256 !== job.workbookSha256
            || prior.sheetName !== job.sheetName
            || prior.rangeAddress !== job.rangeAddress
            || prior.candidateSha256 !== job.candidateSha256
            || prior.planSha256 !== job.planSha256
            || prior.sourceCoverageDigest !== job.sourceCoverageDigest
            || canonicalDigest(prior.batchRows) !== canonicalDigest(job.batchRows)
            || prior.bindingDigest !== job.bindingDigest
          ) {
            fail("Gate 1 preview source binding differs from the current Gate 2 source.");
          }
          return {
            profileId: job.profileId,
            role: job.role,
            workbookSha256: job.workbookSha256,
            sheetName: job.sheetName,
            rangeAddress: job.rangeAddress,
            candidateSha256: job.candidateSha256,
            planSha256: job.planSha256,
            sourceCoverageDigest: job.sourceCoverageDigest,
            batchRows: [...job.batchRows],
            bindingDigest: job.bindingDigest,
            outputPath: job.outputPath,
            sha256: prior.sha256,
            size: prior.size,
            renderAttempts: 0,
          };
        })),
      };
    } else {
      response = testHooks?.runPreviewRenderer
        ? await testHooks.runPreviewRenderer({ request: clone(request), requestPath: requestFile.path, requestFileSha256: requestFile.sha256 })
        : await runPreviewRenderer({ requestPath: requestFile.path, requestFileSha256: requestFile.sha256, requestNonce });
    }
    exact(response, new Set(["kind", "requestNonce", "requestFileSha256", "bindingDigest", "enginePeakWorkingSetBytes", "previews"]), "preview renderer response");
    if (response.kind !== PREVIEW_RESPONSE_KIND || response.requestNonce !== requestNonce || response.bindingDigest !== requestBindingDigest || (requestFile ? response.requestFileSha256 !== requestFile.sha256 : response.requestFileSha256 !== null)) fail("preview renderer response differs from the bound request.");
    if (!Number.isSafeInteger(response.enginePeakWorkingSetBytes) || response.enginePeakWorkingSetBytes < 1) fail("preview renderer did not report a valid engine peak working set.");
    if (!Array.isArray(response.previews) || response.previews.length !== jobs.length) fail("preview renderer returned the wrong preview count.");
    const validatedPreviewBindings = response.previews.map((raw, index) => {
      exact(raw, new Set(["profileId", "role", "workbookSha256", "sheetName", "rangeAddress", "candidateSha256", "planSha256", "sourceCoverageDigest", "batchRows", "bindingDigest", "outputPath", "sha256", "size", "renderAttempts"]), `preview renderer response previews[${index}]`);
      const job = jobs[index];
      for (const field of ["profileId", "role", "workbookSha256", "sheetName", "rangeAddress", "candidateSha256", "planSha256", "sourceCoverageDigest", "bindingDigest"]) {
        if (raw[field] !== job[field]) fail(`preview renderer output ${index} ${field} differs from its full source binding.`);
      }
      if (canonicalDigest(raw.batchRows) !== canonicalDigest(job.batchRows)) fail(`preview renderer output ${index} batchRows differs from its full source binding.`);
      if (previewJobBindingDigest(raw) !== job.bindingDigest) fail(`preview renderer output ${index} bindingDigest preimage is invalid.`);
      if (!samePath(raw.outputPath, job.outputPath)) fail(`preview renderer output ${index} path differs from its bound job.`);
      if (!Number.isSafeInteger(raw.renderAttempts) || raw.renderAttempts < 0 || raw.renderAttempts > 3 || (verifiedPreviewBuild === undefined ? raw.renderAttempts < 1 : raw.renderAttempts !== 0)) fail("preview renderer attempt count is invalid.");
      if (!Number.isSafeInteger(raw.size) || raw.size < 1_000) fail(`preview renderer output ${index} size is invalid.`);
      return { index, raw, job, renderSha256: sha(raw.sha256, `preview ${index} sha256`) };
    });
    const decodedPreviewBySha256 = new Map();
    const validated = await mapSettledLimit(validatedPreviewBindings, PREVIEW_VALIDATION_CONCURRENCY, async ({ index, raw, job, renderSha256 }) => {
      if (stage === "gate-2" && testHooks?.beforeGate2PreviewRead) await testHooks.beforeGate2PreviewRead({ index, profileId: job.profileId, role: job.role, path: job.outputPath });
      const stable = await readStableBinaryFile(job.outputPath, { maxBytes: MAX_PREVIEW_BYTES });
      if (stable.sha256 !== renderSha256 || stable.size !== raw.size) fail("preview renderer output changed after render.");
      let dimensions;
      if (verifiedPreviewBuild === undefined) {
        let inspection = decodedPreviewBySha256.get(renderSha256);
        if (!inspection) {
          inspection = inspectPreviewPng(copyStableBinaryBytes(stable), `preview ${index}`);
          decodedPreviewBySha256.set(renderSha256, inspection);
        }
        dimensions = await inspection;
      } else {
        dimensions = { width: verifiedPreviewBuild.previews[index].width, height: verifiedPreviewBuild.previews[index].height };
      }
      return {
        profileId: job.profileId,
        role: job.role,
        sourceSha256: job.workbookSha256,
        sheetName: job.sheetName,
        rangeAddress: job.rangeAddress,
        candidateSha256: job.candidateSha256,
        planSha256: job.planSha256,
        sourceCoverageDigest: job.sourceCoverageDigest,
        batchRows: [...job.batchRows],
        bindingDigest: job.bindingDigest,
        renderAttempts: raw.renderAttempts,
        path: job.outputPath,
        sha256: stable.sha256,
        size: stable.size,
        ...dimensions,
      };
    });
    const previews = validated.settled.map((entry) => entry.value);
    const body = {
      kind: PREVIEW_RESULT_KIND,
      stage,
      outputRoot,
      bindingDigest: requestBindingDigest,
      requestFileSha256: requestFile?.sha256 ?? null,
      ...(verifiedPreviewBuild === undefined ? {} : { rebuiltFromPreviewDigest: sha(verifiedPreviewBuild.previewDigest, "Gate 1 previewDigest") }),
      enginePeakWorkingSetBytes: response.enginePeakWorkingSetBytes,
      previews,
    };
    return deepFreeze({ ...body, previewDigest: canonicalDigest(body), ownedFiles: verifiedPreviewBuild === undefined ? previews.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })) : [] });
  } catch (error) {
    if (verifiedPreviewBuild !== undefined) throw error;
    let unboundRequestCleanupFailure;
    if (!requestFile && requestPath && !errorHasCode(error, "EEXIST")) {
      try { await fs.unlink(requestPath); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") unboundRequestCleanupFailure = cleanupError; }
    }
    const cleanupEntries = [];
    for (const job of jobs) {
      const current = await readStableBinaryFile(job.outputPath, { maxBytes: MAX_PREVIEW_BYTES }).catch(() => null);
      if (current) cleanupEntries.push({ path: job.outputPath, sha256: current.sha256, size: current.size });
    }
    const partialPrefix = requestNonce ? `.codex-preview-${requestNonce.slice(0, 16)}-` : null;
    const directoryEntries = await fs.readdir(outputRoot, { withFileTypes: true }).catch((readError) => readError?.code === "ENOENT" ? [] : Promise.reject(readError));
    for (const entry of directoryEntries) {
      if (!partialPrefix || !entry.isFile() || !entry.name.startsWith(partialPrefix) || !entry.name.endsWith(".partial.png")) continue;
      const partialPath = path.join(outputRoot, entry.name);
      const current = await readStableBinaryFile(partialPath, { maxBytes: MAX_PREVIEW_BYTES }).catch(() => null);
      if (current) cleanupEntries.push({ path: partialPath, sha256: current.sha256, size: current.size });
    }
    const cleanup = await cleanupBound(cleanupEntries, [outputRoot]);
    if (unboundRequestCleanupFailure || cleanup.preserved.length || cleanup.failures.length) fail(`${error instanceof Error ? error.message : String(error)}; preview cleanup was incomplete.`);
    throw error;
  } finally {
    if (requestFile) {
      const current = await readStableBinaryFile(requestFile.path, { maxBytes: MAX_JSON_BYTES }).catch(() => null);
      if (current?.sha256 === requestFile.sha256) await fs.unlink(requestFile.path);
    }
  }
}

function stateCore(value) {
  const result = clone(value);
  delete result.stateDigest;
  return result;
}

async function readState(statePath, expectedKind) {
  const snapshot = await readStableUtf8JsonFile(path.resolve(statePath), { maxBytes: MAX_JSON_BYTES });
  const state = object(snapshot.value, "workflow state");
  if (state.kind !== expectedKind || canonicalDigest(stateCore(state)) !== state.stateDigest) fail("workflow state identity or digest is invalid.");
  return { state, snapshot, path: path.resolve(statePath) };
}

async function assertPreviewCheckpoint(checkpoint, expected) {
  const state = checkpoint.state;
  if (
    state.stagingToken !== expected.stagingToken
    || !samePath(state.workflowRoot, expected.workflowRoot)
    || state.prepareRequestDigest !== expected.prepareRequestDigest
    || state.manifest?.sha256 !== expected.manifestSha256
    || (state.gate2Correction?.authorizationDigest ?? null) !== expected.correctionAuthorizationDigest
  ) fail("ready-preview checkpoint does not match the current prepare request.");
  if (
    !SHA_RE.test(state.certificate?.certificateDigest ?? "")
    || !SHA_RE.test(state.certificate?.sourceCoverageDigest ?? "")
    || !SHA_RE.test(state.factsDigest ?? "")
    || !Array.isArray(state.affectedProfileIds)
    || canonicalDigest(state.baselines.map((item) => item.profileId)) !== canonicalDigest(state.affectedProfileIds)
  ) fail("ready-preview checkpoint audit bindings are incomplete.");
  await Promise.all([
    ...state.baselines.map((baseline) => assertBoundFile(baseline, `${baseline.profileId} checkpoint baseline`)),
    ...state.rootBuild.ownedFiles.map((item) => assertBoundFile(item, "checkpoint root artifact")),
    ...state.presentationBuild.ownedFiles.map((item) => assertBoundFile(item, "checkpoint presentation artifact")),
  ]);
  return state;
}

export async function prepareReimbursementWorkflow(rawRequest, { testHooks, gate2CorrectionContext } = {}) {
  exact(rawRequest, new Set(["kind", "stagingToken", "manifestPath", "manifestSha256", "baselines"]), "prepare request");
  if (rawRequest.kind !== WORKFLOW_PREPARE_KIND || !TOKEN_RE.test(rawRequest.stagingToken ?? "")) fail("prepare kind or stagingToken is invalid.");
  if (gate2CorrectionContext !== undefined && !VERIFIED_GATE2_CORRECTIONS.has(gate2CorrectionContext)) fail("Gate 2 correction context was not verified by the correction entrypoint.");
  const gate2Correction = gate2CorrectionContext?.authorization ? validateGate2Correction(gate2CorrectionContext.authorization) : null;
  const supersededWorkflowCleanup = gate2CorrectionContext?.cleanup ?? null;
  if (!Array.isArray(rawRequest.baselines) || rawRequest.baselines.length < 1 || rawRequest.baselines.length > 3) fail("baselines must contain one to three profiles.");
  const manifestPath = path.resolve(text(rawRequest.manifestPath, "manifestPath"));
  const manifestSha256 = sha(rawRequest.manifestSha256, "manifestSha256");
  const workflowRoot = path.join(path.resolve(os.tmpdir()), `${WORKFLOW_PREFIX}${rawRequest.stagingToken}`);
  const registryPromise = loadProfileRegistry();
  const rootInfo = await fs.lstat(workflowRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const earlyManifestAudit = rootInfo ? null : (testHooks?.auditManifest
    ? Promise.resolve().then(() => testHooks.auditManifest(manifestPath, manifestSha256))
    : auditManifest(manifestPath, manifestSha256));
  const earlyManifestAuditSettled = earlyManifestAudit?.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const registry = await registryPromise;
  const baselines = rawRequest.baselines.map((raw, index) => {
    exact(raw, new Set(["profileId", "path", "sha256", "size", "candidateRevision"]), `baselines[${index}]`);
    const profileId = text(raw.profileId, `baselines[${index}].profileId`);
    if (!registry.profiles[profileId]) fail(`${profileId} is not a canonical profile.`);
    if (!Number.isSafeInteger(raw.size) || raw.size < 1 || !Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) fail(`${profileId} baseline size/revision is invalid.`);
    return { profileId, path: path.resolve(text(raw.path, `${profileId}.path`)), sha256: sha(raw.sha256, `${profileId}.sha256`), size: raw.size, candidateRevision: raw.candidateRevision };
  });
  const prepareRequestDigest = canonicalDigest({
    kind: rawRequest.kind,
    stagingToken: rawRequest.stagingToken,
    manifestPath,
    manifestSha256,
    baselines,
    correctionAuthorizationDigest: gate2Correction?.authorizationDigest ?? null,
  });
  const checkpointPath = path.join(workflowRoot, "ready-preview.json");
  let rootBuild;
  let presentationBuild;
  let previewBuild;
  let previewCheckpoint;
  let manifestAudit;
  let manifestRecord;
  let reusedCheckpoint = false;
  let existingWorkflowRoot = false;
  try {
    if (rootInfo) {
      existingWorkflowRoot = true;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await fs.realpath(workflowRoot), workflowRoot)) fail("existing workflow root is not a plain owned directory.");
      const manifestSnapshot = await readStableBinaryFile(manifestPath, { maxBytes: MAX_JSON_BYTES });
      if (manifestSnapshot.sha256 !== manifestSha256) fail("manifest SHA differs from the ready-preview request binding.");
      const checkpoint = await readState(checkpointPath, WORKFLOW_READY_PREVIEW_KIND);
      const checkpointState = await assertPreviewCheckpoint(checkpoint, {
        stagingToken: rawRequest.stagingToken,
        workflowRoot,
        prepareRequestDigest,
        manifestSha256,
        correctionAuthorizationDigest: gate2Correction?.authorizationDigest ?? null,
      });
      if (checkpointState.manifest.size !== undefined && checkpointState.manifest.size !== manifestSnapshot.size) {
        fail("ready-preview checkpoint manifest size differs from the bound bytes.");
      }
      manifestRecord = { ...checkpointState.manifest, size: manifestSnapshot.size };
      manifestAudit = {
        manifestFileSize: manifestRecord.size,
        affectedProfileIds: checkpointState.affectedProfileIds,
        batch: {
          batchId: manifestRecord.batchId,
          targetCategory: manifestRecord.targetCategory,
          period: manifestRecord.period,
          mainPeriod: manifestRecord.mainPeriod,
        },
        operationDigest: manifestRecord.operationDigest,
        sourceCoverageDigest: checkpointState.certificate.sourceCoverageDigest,
        factsDigest: checkpointState.factsDigest,
        reimbursementFactsCertificate: checkpointState.certificate,
      };
      rootBuild = checkpointState.rootBuild;
      presentationBuild = checkpointState.presentationBuild;
      previewCheckpoint = { path: checkpoint.path, sha256: checkpoint.snapshot.sha256, size: checkpoint.snapshot.size };
      reusedCheckpoint = true;
    } else {
      const manifestAuditPromise = earlyManifestAuditSettled.then((settled) => {
        if (settled.status === "rejected") throw settled.reason;
        return settled.value;
      });
      const rootBuilderModulePromise = testHooks?.buildRootWorkbookCandidates
        ? Promise.resolve(null)
        : import("./build_root_workbook_candidate.mjs");
      const presentationBuilderModulePromise = testHooks?.buildReimbursementArtifacts
        ? Promise.resolve(null)
        : import("./build_reimbursement_artifacts.mjs");
      const templateWarmPromise = import("./template_assets.mjs").then((module) => module.loadArtifactTemplates());
      const sharpWarmPromise = Promise.resolve().then(() => loadPreviewSharp());
      const startup = await Promise.allSettled([
        manifestAuditPromise,
        rootBuilderModulePromise,
        presentationBuilderModulePromise,
        templateWarmPromise,
        sharpWarmPromise,
      ]);
      const startupFailure = startup.find((item) => item.status === "rejected");
      if (startupFailure) throw startupFailure.reason;
      manifestAudit = startup[0].value;
      if (
        manifestAudit.manifestFileSha256 !== manifestSha256
        || !Number.isSafeInteger(manifestAudit.manifestFileSize)
        || manifestAudit.manifestFileSize < 1
        || !path.isAbsolute(manifestAudit.batch?.archivePath ?? "")
      ) fail("manifest auditor did not bind the requested bytes, size, and archive path.");
      if (canonicalDigest(baselines.map((item) => item.profileId)) !== canonicalDigest(manifestAudit.affectedProfileIds)) fail("baselines must exactly match affected profiles in registry order.");
      manifestRecord = {
        path: manifestPath,
        sha256: manifestSha256,
        size: manifestAudit.manifestFileSize,
        archivePath: path.resolve(manifestAudit.batch.archivePath),
        batchId: manifestAudit.batch.batchId,
        operationDigest: manifestAudit.operationDigest,
        targetCategory: manifestAudit.batch.targetCategory,
        period: manifestAudit.batch.period,
        mainPeriod: manifestAudit.batch.mainPeriod,
      };
      await fs.mkdir(workflowRoot, { recursive: false });
      const rootBuilder = testHooks?.buildRootWorkbookCandidates ?? startup[1].value.buildRootWorkbookCandidates;
      const presentationBuilder = testHooks?.buildReimbursementArtifacts ?? startup[2].value.buildReimbursementArtifacts;
      const [rootSettled, presentationSettled] = await Promise.allSettled([
        rootBuilder({
          kind: "root-workbook-build-request-v1",
          stagingToken: deriveToken(rawRequest.stagingToken, "root"),
          reimbursementFactsCertificate: manifestAudit.reimbursementFactsCertificate,
          artifacts: baselines.map((item) => ({ profileId: item.profileId, baselinePath: item.path, baselineSha256: item.sha256, baselineSize: item.size, candidateRevision: item.candidateRevision })),
        }, { testHooks }),
        presentationBuilder({
          kind: REIMBURSEMENT_ARTIFACT_BUILD_KIND,
          stagingToken: deriveToken(rawRequest.stagingToken, "presentation"),
          manifestPath,
          manifestSha256,
          reimbursementFactsCertificate: manifestAudit.reimbursementFactsCertificate,
        }),
      ]);
      if (rootSettled.status === "fulfilled") rootBuild = rootSettled.value;
      if (presentationSettled.status === "fulfilled") presentationBuild = presentationSettled.value;
      if (rootSettled.status === "rejected" || presentationSettled.status === "rejected") throw rootSettled.reason ?? presentationSettled.reason;
      const checkpointCore = {
        kind: WORKFLOW_READY_PREVIEW_KIND,
        stagingToken: rawRequest.stagingToken,
        workflowRoot,
        prepareRequestDigest,
        manifest: manifestRecord,
        certificate: manifestAudit.reimbursementFactsCertificate,
        factsDigest: manifestAudit.factsDigest,
        affectedProfileIds: manifestAudit.affectedProfileIds,
        baselines,
        rootBuild,
        presentationBuild,
        ...(gate2Correction ? { gate2Correction, supersededWorkflowCleanup } : {}),
      };
      const checkpointState = { ...checkpointCore, stateDigest: canonicalDigest(checkpointCore) };
      previewCheckpoint = await writeExclusiveJson(checkpointPath, checkpointState);
    }
    previewBuild = await buildReviewPreviews(workflowRoot, rootBuild, presentationBuild, manifestAudit.reimbursementFactsCertificate.sourceCoverageDigest, testHooks, "gate-1");
    const reviewPackageDigest = canonicalDigest({
      manifestSha256,
      certificateDigest: manifestAudit.reimbursementFactsCertificate.certificateDigest,
      roots: rootBuild.artifacts.map((item) => ({ profileId: item.profileId, candidateSha256: item.candidateSha256, planSha256: item.planSha256, auditDigest: item.audit.auditDigest })),
      presentation: presentationBuild.artifacts.map((item) => ({ profileId: item.profileId, artifactDigest: item.artifactDigest, detailSha256: item.detail.sha256, screenshotSha256: item.screenshot.sha256 })),
      previews: previewBuild.previews.map((item) => ({ profileId: item.profileId, role: item.role, sourceSha256: item.sourceSha256, sha256: item.sha256, sheetName: item.sheetName, rangeAddress: item.rangeAddress, bindingDigest: item.bindingDigest })),
    });
    const gate1 = gate1For(manifestAudit, rootBuild, reviewPackageDigest);
    const core = {
      kind: WORKFLOW_GATE1_KIND,
      requiresGate1Approval: !gate2Correction,
      stagingToken: rawRequest.stagingToken,
      workflowRoot,
      manifest: manifestRecord,
      certificate: manifestAudit.reimbursementFactsCertificate,
      affectedProfileIds: manifestAudit.affectedProfileIds,
      baselines,
      rootBuild,
      presentationBuild,
      previewBuild,
      previewCheckpoint,
      reusedPreviewCheckpoint: reusedCheckpoint,
      reviewPackageDigest,
      gate1,
      ...(gate2Correction ? { gate2Correction, supersededWorkflowCleanup } : {}),
    };
    const state = { ...core, stateDigest: canonicalDigest(core) };
    const stateFile = await writeIdempotentJson(path.join(workflowRoot, "ready-gate-1.json"), state);
    return deepFreeze({
      status: gate2Correction ? "ready-for-gate-2-correction-review" : "ready-for-gate-1",
      gate1BindingDigest: gate1.bindingDigest,
      approvalText: gate2Correction ? null : GATE1_TEXT,
      statePath: stateFile.path,
      stateSha256: stateFile.sha256,
      stateDigest: state.stateDigest,
      affectedProfileIds: state.affectedProfileIds,
      previewEnginePeakWorkingSetBytes: previewBuild.enginePeakWorkingSetBytes,
      review: presentationBuild.artifacts.map((item) => {
        const root = rootBuild.artifacts.find((artifact) => artifact.profileId === item.profileId);
        return {
          profileId: item.profileId,
          summary: item.summary.text,
          detail: { path: item.detail.path, sha256: item.detail.sha256 },
          screenshot: { path: item.screenshot.path, sha256: item.screenshot.sha256, imageCount: item.screenshot.imageCount },
          candidate: root ? { path: root.candidatePath, sha256: root.candidateSha256, planSha256: root.planSha256 } : null,
          structuralRepairs: clone(root?.structuralRepairs ?? []),
          previews: previewBuild.previews.filter((preview) => preview.profileId === item.profileId),
          evidenceCount: item.evidenceArchive.length,
        };
      }),
    });
  } catch (error) {
    if (previewCheckpoint) {
      const cleanup = previewBuild
        ? await cleanupBound(previewBuild.ownedFiles, [previewBuild.outputRoot])
        : { preserved: [], failures: [] };
      if (cleanup.preserved.length || cleanup.failures.length) fail(`${error instanceof Error ? error.message : String(error)}; preview cleanup was incomplete while business artifacts were preserved.`);
      fail(`${error instanceof Error ? error.message : String(error)}; business artifacts are preserved in ready-preview.json and the same prepare request may retry preview rendering only.`);
    }
    if (existingWorkflowRoot) throw error;
    const files = [...(rootBuild?.ownedFiles ?? []), ...(presentationBuild?.ownedFiles ?? []), ...(previewBuild?.ownedFiles ?? [])];
    const roots = [workflowRoot, previewBuild?.outputRoot, rootBuild?.stagingRoot, presentationBuild?.stagingRoot].filter(Boolean);
    const cleanup = await cleanupBound(files, roots);
    if (cleanup.preserved.length || cleanup.failures.length) fail(`${error instanceof Error ? error.message : String(error)}; cleanup preserved or failed for ${[...cleanup.preserved, ...cleanup.failures.map((item) => item.path)].join(", ")}`);
    throw error;
  }
}

export async function reviseGate2ReimbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["statePath", "expectedGate1BindingDigest", "gate2AttemptReportPath", "gate2AttemptReportSha256", "stagingToken", "manifestPath", "manifestSha256"]), "Gate 2 correction request");
  if (!TOKEN_RE.test(rawRequest.stagingToken ?? "")) fail("Gate 2 correction stagingToken is invalid.");
  const ready = await readState(rawRequest.statePath, WORKFLOW_GATE1_KIND);
  const expectedGate1BindingDigest = sha(rawRequest.expectedGate1BindingDigest, "expectedGate1BindingDigest");
  if (expectedGate1BindingDigest !== ready.state.gate1.bindingDigest) fail("Gate 2 correction Gate 1 binding differs from the reviewed state.");
  if (rawRequest.stagingToken === ready.state.stagingToken) fail("Gate 2 correction requires a fresh stagingToken.");
  await assertNoGate1RestartRequired(ready.state);
  try {
    await assertGate1BaselinesUnchanged(ready.state.baselines);
  } catch (error) {
    if (error?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`Gate 2 correction preflight could not complete; Gate 1 remains valid and may be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeGate1RestartRequired(ready.state, "formal ledger baseline changed after Gate 1", canonicalDigest(ready.state.baselines));
    throw error;
  }
  try {
    await assertSourceMaterialsUnchanged(ready.state.manifest, "Gate 2 correction");
  } catch (error) {
    if (error?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`Gate 2 correction source verification could not complete; Gate 1 remains valid and may be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeGate1RestartRequired(ready.state, "source material or manifest changed after Gate 1", canonicalDigest(ready.state.manifest));
    throw error;
  }

  const reportPath = path.resolve(text(rawRequest.gate2AttemptReportPath, "gate2AttemptReportPath"));
  if (!samePath(path.dirname(reportPath), ready.state.workflowRoot)) fail("Gate 2 correction report must belong to the prior workflow root.");
  const reportSha256 = sha(rawRequest.gate2AttemptReportSha256, "gate2AttemptReportSha256");
  const reportStable = await readStableUtf8JsonFile(reportPath, { maxBytes: MAX_JSON_BYTES });
  if (reportStable.sha256 !== reportSha256) fail("Gate 2 correction report SHA differs from the reviewed attempt.");
  const report = object(reportStable.value, "Gate 2 correction report");
  if (
    report.kind !== FULL_CORRESPONDENCE_AUDIT_KIND
    || canonicalDigest(withoutDigest(report, "reportDigest")) !== report.reportDigest
    || report.gate1BindingDigest !== ready.state.gate1.bindingDigest
    || !new Set(["REVIEW_REQUIRED", "CORRECTION_REQUIRED", "BLOCKED_RETRYABLE"]).has(report.disposition)
    || path.basename(reportPath) !== `gate2-review-${report.reportDigest}.json`
  ) fail("Gate 2 correction report is not a valid retryable attempt bound to this Gate 1.");

  const priorManifestStable = await readStableUtf8JsonFile(path.resolve(ready.state.manifest.path), { maxBytes: MAX_JSON_BYTES });
  if (priorManifestStable.sha256 !== ready.state.manifest.sha256) fail("prior manifest changed after Gate 1; a new Gate 1 is required.");
  const revisedManifestPath = path.resolve(text(rawRequest.manifestPath, "manifestPath"));
  const revisedManifestSha256 = sha(rawRequest.manifestSha256, "manifestSha256");
  const revisedManifestStable = await readStableUtf8JsonFile(revisedManifestPath, { maxBytes: MAX_JSON_BYTES });
  if (revisedManifestStable.sha256 !== revisedManifestSha256) fail("revised manifest SHA differs from the correction request.");
  assertSameGate2CorrectionScope(object(priorManifestStable.value, "prior manifest"), object(revisedManifestStable.value, "revised manifest"));
  const manifestChanged = ready.state.manifest.sha256 !== revisedManifestSha256;
  if (report.disposition !== "CORRECTION_REQUIRED") fail("only a Gate 2 CORRECTION_REQUIRED report can authorize artifact or manifest rebuilding; review/input findings must retry the independent review.");
  if (manifestChanged && report.findingResolution?.decision !== "gate1-content-error") fail("Gate 2 artifact correction did not authorize a manifest change.");
  if (report.findingResolution?.decision === "gate1-content-error" && report.findingResolution.revisedManifestSha256 !== revisedManifestSha256) fail("revised manifest SHA differs from the Gate 2 finding resolution authorization.");

  const cleanup = await correctionCleanupFor(ready);
  const correctionCore = {
    kind: GATE2_CORRECTION_KIND,
    priorGate1BindingDigest: ready.state.gate1.bindingDigest,
    attemptReport: { path: reportPath, sha256: reportStable.sha256, size: reportStable.size, reportDigest: report.reportDigest, disposition: report.disposition },
    manifestChanged,
    restartLineage: gate1RestartLineage(ready.state),
  };
  const authorization = { ...correctionCore, authorizationDigest: canonicalDigest(correctionCore) };
  const gate2CorrectionContext = { authorization, cleanup };
  VERIFIED_GATE2_CORRECTIONS.add(gate2CorrectionContext);
  const baselines = ready.state.baselines.map((baseline) => {
    if (!Number.isSafeInteger(baseline.candidateRevision) || baseline.candidateRevision >= Number.MAX_SAFE_INTEGER) fail(`${baseline.profileId} candidateRevision cannot be advanced for Gate 2 correction.`);
    return { profileId: baseline.profileId, path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: baseline.candidateRevision + 1 };
  });
  return prepareReimbursementWorkflow({
    kind: WORKFLOW_PREPARE_KIND,
    stagingToken: rawRequest.stagingToken,
    manifestPath: revisedManifestPath,
    manifestSha256: revisedManifestSha256,
    baselines,
  }, { testHooks, gate2CorrectionContext });
}

export async function finalizeReimbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["statePath", "expectedGate1BindingDigest", "approvalText", "independentEvidenceReviewPath", "independentEvidenceReviewSha256"]), "finalize request");
  const ready = await readState(rawRequest.statePath, WORKFLOW_GATE1_KIND);
  const carriedCorrection = ready.state.gate2Correction ? validateGate2Correction(ready.state.gate2Correction, "workflow Gate 2 correction") : null;
  const correctionApprovalCarried = rawRequest.approvalText === null && carriedCorrection !== null && ready.state.requiresGate1Approval === false;
  if (rawRequest.approvalText !== GATE1_TEXT && !correctionApprovalCarried) fail("Gate 1 approval text is not exact and no verified Gate 2 correction carry-forward is present.");
  if (carriedCorrection) await assertBoundFile(carriedCorrection.attemptReport, "Gate 2 correction attempt report");
  if (sha(rawRequest.expectedGate1BindingDigest, "expectedGate1BindingDigest") !== ready.state.gate1.bindingDigest) fail("Gate 1 binding digest differs from the displayed review package.");
  const correspondencePath = path.join(ready.state.workflowRoot, "gate2-full-correspondence.json");
  const auditModulePromise = import("./audit_full_correspondence.mjs");
  void auditModulePromise.catch(() => {});
  await assertNoGate1RestartRequired(ready.state);
  const gate1Preflight = await Promise.allSettled([
    assertGate1BaselinesUnchanged(ready.state.baselines),
    auditModulePromise.then((module) => module.readVerifiedGate1ManifestSnapshot(
      ready.state.manifest,
      { testHooks: testHooks?.manifestSnapshotHooks },
    )),
  ]);
  if (gate1Preflight[0].status === "rejected") {
    if (gate1Preflight[0].reason?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`Gate 2 preflight could not complete; Gate 1 remains valid and may be retried: ${gate1Preflight[0].reason instanceof Error ? gate1Preflight[0].reason.message : String(gate1Preflight[0].reason)}`);
    }
    await writeGate1RestartRequired(ready.state, "formal ledger baseline changed after Gate 1", canonicalDigest(ready.state.baselines));
    throw gate1Preflight[0].reason;
  }
  if (gate1Preflight[1].status === "rejected") {
    if (gate1Preflight[1].reason?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`full correspondence audit could not complete; Gate 1 remains valid and may be retried: ${gate1Preflight[1].reason instanceof Error ? gate1Preflight[1].reason.message : String(gate1Preflight[1].reason)}`);
    }
    await writeGate1RestartRequired(ready.state, "manifest changed after Gate 1", canonicalDigest(ready.state.manifest));
    throw gate1RestartError(
      `manifest changed after Gate 1; a new Gate 1 is required: ${gate1Preflight[1].reason instanceof Error ? gate1Preflight[1].reason.message : String(gate1Preflight[1].reason)}`,
      gate1Preflight[1].reason,
    );
  }
  const auditModule = await auditModulePromise;
  const verifiedManifestSnapshot = gate1Preflight[1].value;
  const reviewSnapshotPromise = Promise.resolve().then(async () => {
    const reviewPath = path.resolve(text(rawRequest.independentEvidenceReviewPath, "independentEvidenceReviewPath"));
    const reviewSha256 = sha(rawRequest.independentEvidenceReviewSha256, "independentEvidenceReviewSha256");
    const stable = await readStableUtf8JsonFile(reviewPath, { maxBytes: MAX_JSON_BYTES });
    if (stable.sha256 !== reviewSha256) fail("independent evidence review SHA differs before Gate 2.");
    return { path: reviewPath, sha256: reviewSha256, stable };
  });
  const planCheckPromise = Promise.all(ready.state.rootBuild.artifacts.map((artifact) => assertBoundFile(
    { path: artifact.planPath, sha256: artifact.planSha256, size: artifact.planSize },
    `${artifact.profileId} candidate plan`,
  )));
  const preflight = await Promise.allSettled([
    reviewSnapshotPromise,
    readOptionalStableJson(correspondencePath),
    planCheckPromise,
  ]);
  if (preflight[0].status === "rejected") throw preflight[0].reason;
  if (preflight[1].status === "rejected") throw preflight[1].reason;
  const { path: independentEvidenceReviewPath, sha256: independentEvidenceReviewSha256, stable: independentReviewStable } = preflight[0].value;
  const existingCorrespondence = preflight[1].value;
  let correspondence;
  let correspondenceFile;
  if (existingCorrespondence) {
    correspondence = object(existingCorrespondence.value, "full correspondence checkpoint");
    if (
      correspondence.kind !== FULL_CORRESPONDENCE_AUDIT_KIND
      || canonicalDigest(withoutDigest(correspondence, "reportDigest")) !== correspondence.reportDigest
      || correspondence.status !== "passed"
      || correspondence.disposition !== "PASSED"
      || correspondence.gate1BindingDigest !== ready.state.gate1.bindingDigest
      || correspondence.independentEvidenceReviewSha256 !== independentEvidenceReviewSha256
    ) fail("full correspondence checkpoint is invalid or bound to another Gate 1/review.");
  }
  if (preflight[2].status === "rejected") throw preflight[2].reason;
  // Gate 2 preview verification only rereads and hashes the already-bound Gate 1
  // PNGs. Start it alongside full correspondence, but keep a settled wrapper so
  // correspondence remains the first reported failure and no rejection escapes.
  const gate2PreviewBuildSettled = buildReviewPreviews(
    ready.state.workflowRoot,
    ready.state.rootBuild,
    ready.state.presentationBuild,
    ready.state.certificate.sourceCoverageDigest,
    testHooks,
    "gate-2",
    ready.state.previewBuild,
  ).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  try {
  if (existingCorrespondence) {
    correspondenceFile = { path: correspondencePath, sha256: existingCorrespondence.sha256, size: existingCorrespondence.size };
    await Promise.all([
      ...ready.state.rootBuild.artifacts.flatMap((artifact) => [
        assertBoundFile({ path: artifact.candidatePath, sha256: artifact.candidateSha256, size: artifact.candidateSize }, `${artifact.profileId} checkpoint candidate`),
        assertBoundFile({ path: artifact.previewPath, sha256: artifact.previewSha256, size: artifact.previewSize }, `${artifact.profileId} checkpoint root preview`),
      ]),
      ...ready.state.presentationBuild.artifacts.flatMap((artifact) => [
        assertBoundFile(artifact.detail, `${artifact.profileId} checkpoint detail`),
        assertBoundFile(artifact.screenshot, `${artifact.profileId} checkpoint screenshot`),
        assertBoundFile(artifact.summary, `${artifact.profileId} checkpoint summary`),
        ...artifact.supplements.map((supplement) => assertBoundFile(supplement, `${artifact.profileId} checkpoint supplement ${supplement.person}`)),
        ...artifact.evidenceArchive.map((evidence) => assertBoundFile(evidence, `${artifact.profileId} checkpoint evidence ${evidence.evidenceId}`)),
      ]),
    ]);
  } else {
    try {
      correspondence = await auditModule.auditFullCorrespondence({
        gate1State: ready.state,
        independentEvidenceReviewSnapshot: {
          path: independentEvidenceReviewPath,
          sha256: independentEvidenceReviewSha256,
          size: independentReviewStable.size,
          value: independentReviewStable.value,
        },
      }, { hooks: testHooks?.fullCorrespondenceHooks, verifiedManifestSnapshot });
    } catch (error) {
      fail(`full correspondence audit could not complete; Gate 1 remains valid and may be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!new Set(["PASSED", "REVIEW_REQUIRED", "CORRECTION_REQUIRED", "BLOCKED_RETRYABLE", "GATE1_REQUIRED"]).has(correspondence.disposition)) fail("full correspondence audit returned an invalid disposition; Gate 1 remains valid and may be retried.");
    await validateFindingResolution(correspondence, ready.state.workflowRoot, ready.state.gate1.bindingDigest);
    if (new Set(["REVIEW_REQUIRED", "CORRECTION_REQUIRED", "BLOCKED_RETRYABLE", "GATE1_REQUIRED"]).has(correspondence.disposition)) {
      const attemptPath = path.join(ready.state.workflowRoot, `gate2-review-${correspondence.reportDigest}.json`);
      correspondenceFile = await writeIdempotentJson(attemptPath, correspondence);
      let gate1Restart = null;
      if (correspondence.disposition === "GATE1_REQUIRED") {
        const reason = correspondence.findingResolution?.decision === "evidence-uncertain" ? "source evidence is uncertain after Gate 1" : "source material changed after Gate 1";
        const markers = await writeGate1RestartRequired(ready.state, reason, correspondence.reportDigest);
        gate1Restart = markers.at(-1);
      }
      const gate2PreviewBuildResult = await gate2PreviewBuildSettled;
      if (gate2PreviewBuildResult.status === "rejected") throw gate2PreviewBuildResult.reason;
      return deepFreeze({
        status: correspondence.disposition === "REVIEW_REQUIRED"
          ? "gate-2-review-required"
          : correspondence.disposition === "CORRECTION_REQUIRED"
            ? "gate-2-correction-required"
            : correspondence.disposition === "GATE1_REQUIRED"
              ? "gate-1-required"
              : "gate-2-blocked-retryable",
        disposition: correspondence.disposition,
        gate1RemainsValid: correspondence.disposition !== "GATE1_REQUIRED",
        retryWithoutNewGate1: correspondence.disposition !== "GATE1_REQUIRED",
        ...(gate1Restart ? { gate1Restart } : {}),
        gate1BindingDigest: ready.state.gate1.bindingDigest,
        fullCorrespondenceAudit: {
          ...correspondenceFile,
          reportDigest: correspondence.reportDigest,
          status: correspondence.status,
          disposition: correspondence.disposition,
          coverage: correspondence.coverage,
          totals: correspondence.totals,
          issueCounts: Object.fromEntries(["missing", "extra", "mismatches", "duplicate", "unbound", "reviewFindings", "blocking"].map((field) => [field, correspondence[field].length])),
          reviewFindings: clone(correspondence.reviewFindings),
          blocking: clone(correspondence.blocking),
        },
        independentEvidenceReview: {
          path: independentEvidenceReviewPath,
          sha256: independentEvidenceReviewSha256,
          size: independentReviewStable.size,
          digest: correspondence.independentEvidenceReviewDigest,
          reviewerRunId: correspondence.reviewerRunId,
        },
        candidateBindings: clone(correspondence.candidateBindings),
        previewBindingDigest: gate2PreviewBuildResult.value.previewDigest,
      });
    }
    correspondenceFile = await writeExclusiveJson(correspondencePath, correspondence);
  }
  } catch (error) {
    await gate2PreviewBuildSettled;
    throw error;
  }
  const finalAudit = {
    kind: "gate2-full-correspondence-profile-audits-v1",
    reportDigest: correspondence.reportDigest,
    audits: correspondence.profileAudits,
  };
  const gate2PreviewBuildResult = await gate2PreviewBuildSettled;
  if (gate2PreviewBuildResult.status === "rejected") throw gate2PreviewBuildResult.reason;
  const gate2PreviewBuild = gate2PreviewBuildResult.value;
  const gate2AttemptReports = await listGate2AttemptReports(ready.state.workflowRoot, ready.state.gate1.bindingDigest);
  try {
    const gate2 = gate2For(
      { ...ready.state.manifest, batch: { batchId: ready.state.manifest.batchId }, sourceCoverageDigest: ready.state.certificate.sourceCoverageDigest },
      ready.state.rootBuild,
      finalAudit.audits,
      ready.state.baselines,
      gate2PreviewBuild.previewDigest,
      correspondence,
    );
    const core = {
      ...stateCore(ready.state),
      kind: WORKFLOW_GATE2_KIND,
      requiresGate1Approval: false,
      requiresGate2Approval: true,
      finalAudit,
      finalAuditDigest: canonicalDigest(finalAudit),
      fullCorrespondenceAudit: {
        ...correspondenceFile,
        reportDigest: correspondence.reportDigest,
        independentEvidenceReviewDigest: correspondence.independentEvidenceReviewDigest,
        status: correspondence.status,
        disposition: correspondence.disposition,
        coverage: correspondence.coverage,
        totals: correspondence.totals,
        issueCounts: Object.fromEntries(["missing", "extra", "mismatches", "duplicate", "unbound", "reviewFindings", "blocking"].map((field) => [field, correspondence[field].length])),
        metrics: correspondence.metrics,
      },
      independentEvidenceReview: {
        path: independentEvidenceReviewPath,
        sha256: independentEvidenceReviewSha256,
        size: independentReviewStable.size,
        digest: correspondence.independentEvidenceReviewDigest,
        reviewerRunId: correspondence.reviewerRunId,
      },
      gate2AttemptReports,
      gate2PreviewBuild,
      gate2,
      previousState: { path: ready.path, sha256: ready.snapshot.sha256 },
    };
    const state = { ...core, stateDigest: canonicalDigest(core) };
    const stateFile = await writeIdempotentJson(path.join(ready.state.workflowRoot, "ready-gate-2.json"), state);
    return deepFreeze({
      status: "ready-for-gate-2",
      gate2BindingDigest: gate2.bindingDigest,
      approvalText: GATE2_TEXT,
      statePath: stateFile.path,
      stateSha256: stateFile.sha256,
      stateDigest: state.stateDigest,
      affectedProfileIds: state.affectedProfileIds,
      previewEnginePeakWorkingSetBytes: gate2PreviewBuild.enginePeakWorkingSetBytes,
      fullCorrespondenceAudit: clone(state.fullCorrespondenceAudit),
      review: ready.state.presentationBuild.artifacts.map((item) => {
        const root = ready.state.rootBuild.artifacts.find((artifact) => artifact.profileId === item.profileId);
        return {
          profileId: item.profileId,
          summary: item.summary.text,
          detail: { path: item.detail.path, sha256: item.detail.sha256 },
          screenshot: { path: item.screenshot.path, sha256: item.screenshot.sha256, imageCount: item.screenshot.imageCount },
          candidate: root ? { path: root.candidatePath, sha256: root.candidateSha256, planSha256: root.planSha256 } : null,
          structuralRepairs: clone(root?.structuralRepairs ?? []),
          previews: gate2PreviewBuild.previews.filter((preview) => preview.profileId === item.profileId),
          evidenceCount: item.evidenceArchive.length,
          fullCorrespondenceAudit: {
            path: state.fullCorrespondenceAudit.path,
            sha256: state.fullCorrespondenceAudit.sha256,
            reportDigest: state.fullCorrespondenceAudit.reportDigest,
            status: state.fullCorrespondenceAudit.status,
            coverage: state.fullCorrespondenceAudit.coverage,
            totals: state.fullCorrespondenceAudit.totals,
            issueCounts: state.fullCorrespondenceAudit.issueCounts,
          },
        };
      }),
    });
  } catch (error) {
    const cleanup = await cleanupBound(gate2PreviewBuild.ownedFiles, []);
    if (cleanup.preserved.length || cleanup.failures.length) {
      fail(`${error instanceof Error ? error.message : String(error)}; Gate 2 preview cleanup was incomplete.`);
    }
    throw error;
  }
}

async function ensurePlainDirectory(directoryPath, field) {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${field} must be a plain directory.`);
  if (!samePath(await fs.realpath(directoryPath), directoryPath)) fail(`${field} resolves through an alias or reparse point.`);
}

async function ensureArchiveDirectory(directoryPath, field, createdDirectories) {
  try {
    await fs.mkdir(directoryPath, { recursive: false });
    createdDirectories.push(directoryPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await ensurePlainDirectory(directoryPath, field);
}

async function cleanupCreatedDirectories(directories) {
  const failures = [];
  for (const directoryPath of [...directories].reverse()) {
    try {
      await fs.rmdir(directoryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push({ path: directoryPath, error });
    }
  }
  return failures;
}

async function copyExclusiveBound(source, target) {
  let copied = false;
  try {
    await fs.copyFile(source.path, target, fsConstants.COPYFILE_EXCL);
    copied = true;
    const stable = await readStableBinaryFile(target);
    if (stable.sha256 !== source.sha256 || stable.size !== source.size) fail(`${target} differs from its approved source.`);
    return { path: target, sha256: stable.sha256, size: stable.size };
  } catch (error) {
    if (copied && error && typeof error === "object") {
      const current = await readStableBinaryFile(target).catch(() => null);
      if (current?.sha256 === source.sha256 && current.size === source.size) {
        Object.defineProperty(error, "ownedFile", { configurable: true, value: { path: target, sha256: current.sha256, size: current.size } });
      }
    }
    throw error;
  }
}

async function rollbackPublished(entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      const current = await readStableBinaryFile(entry.targetPath);
      if (current.sha256 !== entry.candidateSha256) throw new Error("published target was externally changed");
      if (entry.targetOriginallyAbsent) {
        await fs.unlink(entry.targetPath);
      } else {
        runSafePublish({ baselinePath: entry.targetPath, candidatePath: entry.backup.path, targetPath: entry.targetPath, expectedBaselineSha256: entry.candidateSha256, expectedCandidateSha256: entry.baselineSha256 });
      }
    } catch (error) {
      errors.push(`${entry.profileId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export async function publishReimbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["statePath", "expectedGate1BindingDigest", "gate1ApprovalText", "expectedGate2BindingDigest", "gate2ApprovalText"]), "publish request");
  const ready = await readState(rawRequest.statePath, WORKFLOW_GATE2_KIND);
  const publishCorrection = ready.state.gate2Correction ? validateGate2Correction(ready.state.gate2Correction, "publish Gate 2 correction") : null;
  if (rawRequest.gate2ApprovalText !== GATE2_TEXT) fail("Gate 2 approval text must be exact and supplied from the current task.");
  if (publishCorrection ? rawRequest.gate1ApprovalText !== null : rawRequest.gate1ApprovalText !== GATE1_TEXT) fail("Gate 1 approval must be the original exact text for an unchanged Gate 1, or null for a verified Gate 2 correction carry-forward.");
  await assertNoGate1RestartRequired(ready.state);
  try {
    await assertSourceMaterialsUnchanged(ready.state.manifest, "publish");
  } catch (error) {
    if (error?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`publish source verification could not complete; Gate 1 remains valid and may be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeGate1RestartRequired(ready.state, "source material or manifest changed after Gate 2", canonicalDigest(ready.state.manifest));
    throw error;
  }
  try {
    await assertGate1BaselinesUnchanged(ready.state.baselines);
  } catch (error) {
    if (error?.code !== GATE1_RESTART_REQUIRED_ERROR_CODE) {
      fail(`publish baseline verification could not complete; Gate 1 remains valid and may be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeGate1RestartRequired(ready.state, "formal ledger baseline changed after Gate 2", canonicalDigest(ready.state.baselines));
    throw error;
  }
  if (sha(rawRequest.expectedGate1BindingDigest, "expectedGate1BindingDigest") !== ready.state.gate1.bindingDigest || sha(rawRequest.expectedGate2BindingDigest, "expectedGate2BindingDigest") !== ready.state.gate2.bindingDigest) fail("Gate binding digest differs from the reviewed state.");
  await Promise.all([
    assertBoundFile(ready.state.fullCorrespondenceAudit, "publish full correspondence audit"),
    assertBoundFile(ready.state.independentEvidenceReview, "publish independent evidence review"),
    ...(publishCorrection ? [assertBoundFile(publishCorrection.attemptReport, "publish Gate 2 correction attempt report")] : []),
    ...(ready.state.gate2AttemptReports ?? []).map((report) => assertBoundFile(report, "publish Gate 2 attempt report")),
  ]);
  const registry = await loadProfileRegistry();
  const rootByProfile = new Map(ready.state.rootBuild.artifacts.map((item) => [item.profileId, item]));
  const presentationByProfile = new Map(ready.state.presentationBuild.artifacts.map((item) => [item.profileId, item]));
  const previewsByProfile = new Map(ready.state.affectedProfileIds.map((profileId) => [profileId, ready.state.gate2PreviewBuild.previews.filter((item) => item.profileId === profileId)]));
  const archiveCopies = [];
  const temporaryAuditFiles = [];
  const createdDirectories = [];
  const backups = [];
  const published = [];
  try {
    await ensureArchiveDirectory(ready.state.manifest.archivePath, "manifest archivePath", createdDirectories);
    const preparation = await Promise.allSettled(ready.state.baselines.map(async (baseline) => {
      const profile = registry.profiles[baseline.profileId];
      const root = rootByProfile.get(baseline.profileId);
      const presentation = presentationByProfile.get(baseline.profileId);
      await Promise.all([
        assertBoundFile(baseline, `${baseline.profileId} publish baseline`),
        assertBoundFile({ path: root.candidatePath, sha256: root.candidateSha256, size: root.candidateSize }, `${baseline.profileId} publish candidate`),
        assertBoundFile(presentation.detail, `${baseline.profileId} publish detail`),
        assertBoundFile(presentation.screenshot, `${baseline.profileId} publish screenshot`),
        assertBoundFile(presentation.summary, `${baseline.profileId} publish summary`),
        ...presentation.supplements.map((supplement) => assertBoundFile(supplement, `${baseline.profileId} publish supplement ${supplement.person}`)),
        ...presentation.evidenceArchive.map((evidence) => assertBoundFile(evidence, `${baseline.profileId} publish evidence ${evidence.evidenceId}`)),
        ...(previewsByProfile.get(baseline.profileId) ?? []).map((preview) => assertBoundFile(preview, `${baseline.profileId} publish ${preview.role} preview`)),
      ]);
      const profileArchive = ready.state.manifest.archivePath;
      const expectedArchiveName = `${presentation.period}_${profile.targetCategory}${presentation.supplementSuffix}`;
      if (ready.state.affectedProfileIds.length === 1 && path.basename(profileArchive) !== expectedArchiveName) {
        fail(`manifest archive folder must be named ${expectedArchiveName}.`);
      }
      const screenshotRoot = path.join(profileArchive, "报销截图");
      await ensureArchiveDirectory(screenshotRoot, `${baseline.profileId} screenshot root`, createdDirectories);
      const screenshotArchiveDirectory = path.join(screenshotRoot, profile.screenshotMapSheetName);
      await ensureArchiveDirectory(screenshotArchiveDirectory, `${baseline.profileId} screenshot archive directory`, createdDirectories);
      const archived = { evidenceArchive: [], supplements: [] };
      const ledgerEnd = `${Number(presentation.periodEndDate.slice(0, 4))}.${Number(presentation.periodEndDate.slice(5, 7))}.${Number(presentation.periodEndDate.slice(8, 10))}`;
      const copyResults = await Promise.allSettled([
        copyExclusiveBound(presentation.detail, path.join(profileArchive, path.basename(presentation.detail.path))),
        copyExclusiveBound(presentation.screenshot, path.join(profileArchive, path.basename(presentation.screenshot.path))),
        copyExclusiveBound(presentation.summary, path.join(profileArchive, path.basename(presentation.summary.path))),
        copyExclusiveBound({ path: root.candidatePath, sha256: root.candidateSha256, size: root.candidateSize }, path.join(profileArchive, `${profile.archiveStem}_截至${ledgerEnd}.xlsx`)),
        ...presentation.supplements.map((supplement) => copyExclusiveBound(supplement, path.join(profileArchive, path.basename(supplement.path)))),
        ...presentation.evidenceArchive.map((evidence) => copyExclusiveBound(evidence, path.join(screenshotArchiveDirectory, evidence.finalName))),
      ]);
      for (const result of copyResults) {
        if (result.status === "fulfilled") archiveCopies.push(result.value);
        else if (result.reason?.ownedFile) archiveCopies.push(result.reason.ownedFile);
      }
      const copyFailure = copyResults.find((result) => result.status === "rejected");
      if (copyFailure) throw copyFailure.reason;
      const copies = copyResults.map((result) => result.value);
      [archived.detail, archived.screenshot, archived.summary, archived.snapshot] = copies;
      const supplementOffset = 4;
      archived.supplements = copies.slice(supplementOffset, supplementOffset + presentation.supplements.length)
        .map((copied, index) => ({ person: presentation.supplements[index].person, ...copied }));
      const evidenceOffset = supplementOffset + presentation.supplements.length;
      archived.evidenceArchive = copies.slice(evidenceOffset).map((copied, index) => ({ evidenceId: presentation.evidenceArchive[index].evidenceId, ...copied }));
      const baselineStable = await readStableBinaryFile(baseline.path);
      const backupPath = path.join(ready.state.workflowRoot, `.rollback-${baseline.profileId}-${crypto.randomBytes(8).toString("hex")}.xlsx`);
      const backupBinding = { path: backupPath, sha256: baselineStable.sha256, size: baselineStable.size };
      let backupCreated = false;
      try {
        const handle = await fs.open(backupPath, "wx", 0o600);
        backupCreated = true;
        try { await handle.writeFile(copyStableBinaryBytes(baselineStable)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if (backupCreated) {
          try { await fs.unlink(backupPath); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw new Error(`${error instanceof Error ? error.message : String(error)}; incomplete rollback backup cleanup: ${backupPath}`, { cause: error }); }
        }
        throw error;
      }
      backups.push(backupBinding);
      await testHooks?.afterBackupCreated?.(clone(backupBinding));
      await assertBoundFile(backupBinding, `${baseline.profileId} rollback backup`);
      const targetPath = path.join(path.dirname(baseline.path), profile.canonicalRootWorkbookName);
      let targetOriginallyAbsent = false;
      if (!samePath(targetPath, baseline.path)) {
        try { await fs.lstat(targetPath); fail(`${baseline.profileId} canonical target already exists separately from its bound baseline.`); } catch (error) { if (error?.code === "ENOENT") targetOriginallyAbsent = true; else throw error; }
      }
      return { profileId: baseline.profileId, baseline, root, targetPath, targetOriginallyAbsent, backup: backupBinding, archived };
    }));
    const preparationFailure = preparation.find((item) => item.status === "rejected");
    if (preparationFailure) throw preparationFailure.reason;
    const preparedProfiles = preparation.map((item) => item.value);
    const targetDirectories = new Set(preparedProfiles.map((item) => path.dirname(item.targetPath).toLowerCase()));
    const publishResults = targetDirectories.size === preparedProfiles.length
      ? await Promise.allSettled(preparedProfiles.map(async (item) => ({
        ...item,
        result: await runSafePublishAsync({ baselinePath: item.baseline.path, candidatePath: item.root.candidatePath, targetPath: item.targetPath, expectedBaselineSha256: item.baseline.sha256, expectedCandidateSha256: item.root.candidateSha256 }),
      })))
      : await (async () => {
        const results = [];
        for (const item of preparedProfiles) {
          try {
            results.push({ status: "fulfilled", value: { ...item, result: await runSafePublishAsync({ baselinePath: item.baseline.path, candidatePath: item.root.candidatePath, targetPath: item.targetPath, expectedBaselineSha256: item.baseline.sha256, expectedCandidateSha256: item.root.candidateSha256 }) } });
          } catch (reason) {
            results.push({ status: "rejected", reason });
            break;
          }
        }
        return results;
      })();
    for (const item of publishResults) if (item.status === "fulfilled") published.push({ profileId: item.value.profileId, targetPath: item.value.targetPath, targetOriginallyAbsent: item.value.targetOriginallyAbsent, baselineSha256: item.value.baseline.sha256, candidateSha256: item.value.root.candidateSha256, localPatchCertificate: item.value.root.localPatchCertificate, backup: item.value.backup, result: item.value.result, archived: item.value.archived });
    const publishFailure = publishResults.find((item) => item.status === "rejected");
    if (publishFailure) throw publishFailure.reason;
    const postProfiles = published.map((entry) => ({ profileId: entry.profileId, baselinePath: entry.backup.path, baselineSha256: entry.baselineSha256, candidatePath: entry.targetPath, candidateSha256: entry.candidateSha256, localPatchCertificate: entry.localPatchCertificate }));
    const postAudit = await runBatchAudit(ready.state.workflowRoot, ready.state.certificate, postProfiles, "post-publish");
    const postAuditByProfile = new Map(postAudit.audits.map((item) => [item.profile.profileId, item]));
    for (const entry of published) {
      const profile = registry.profiles[entry.profileId];
      const presentation = presentationByProfile.get(entry.profileId);
      const audit = postAuditByProfile.get(entry.profileId);
      if (!audit) fail(`${entry.profileId} post-publish audit is missing.`);
      const auditCore = {
        kind: WORKFLOW_PUBLISH_AUDIT_KIND,
        batchId: ready.state.manifest.batchId,
        profileId: entry.profileId,
        root: { filename: path.basename(entry.targetPath), sha256: entry.candidateSha256 },
        snapshot: { filename: path.basename(entry.archived.snapshot.path), sha256: entry.archived.snapshot.sha256 },
        detail: { filename: path.basename(entry.archived.detail.path), sha256: entry.archived.detail.sha256 },
        screenshot: { filename: path.basename(entry.archived.screenshot.path), sha256: entry.archived.screenshot.sha256 },
        summary: { filename: path.basename(entry.archived.summary.path), sha256: entry.archived.summary.sha256 },
        evidence: entry.archived.evidenceArchive.map((item) => ({ filename: path.basename(item.path), sha256: item.sha256 })),
        supplements: entry.archived.supplements.map((item) => ({ person: item.person, filename: path.basename(item.path), sha256: item.sha256 })),
        previews: (previewsByProfile.get(entry.profileId) ?? []).map((item) => ({ role: item.role, sourceSha256: item.sourceSha256, sha256: item.sha256, rangeAddress: item.rangeAddress })),
        manifestSha256: ready.state.manifest.sha256,
        factsDigest: ready.state.certificate.factsDigest,
        sourceCoverageDigest: ready.state.certificate.sourceCoverageDigest,
        profileConfigDigest: ready.state.certificate.profileConfigDigest,
        businessAuditDigest: audit.auditDigest,
        transitionDigest: audit.transitionDigest,
        gate1BindingDigest: ready.state.gate1.bindingDigest,
        gate2BindingDigest: ready.state.gate2.bindingDigest,
        fullCorrespondenceAuditDigest: ready.state.fullCorrespondenceAudit.reportDigest,
        independentEvidenceReviewDigest: ready.state.independentEvidenceReview.digest,
      };
      const auditDocument = { ...auditCore, auditDigest: canonicalDigest(auditCore) };
      const auditFile = await writeExclusiveJson(
        path.join(ready.state.workflowRoot, `.publish-audit-${entry.profileId}.json`),
        auditDocument,
      );
      temporaryAuditFiles.push(auditFile);
      entry.publishAuditDigest = auditDocument.auditDigest;
    }
    const outputs = published.map((entry) => {
      return {
        profileId: entry.profileId,
        root: { path: entry.targetPath, sha256: entry.candidateSha256 },
        detail: entry.archived.detail,
        screenshot: entry.archived.screenshot,
        summary: entry.archived.summary,
        snapshot: entry.archived.snapshot,
        supplements: entry.archived.supplements,
        evidenceArchive: entry.archived.evidenceArchive,
        publishAuditDigest: entry.publishAuditDigest,
      };
    });
    const receiptCore = { kind: WORKFLOW_RECEIPT_KIND, batchId: ready.state.manifest.batchId, affectedProfileIds: ready.state.affectedProfileIds, outputs, postPublishAuditDigest: canonicalDigest(postAudit) };
    const cleanupFiles = [...backups, ...temporaryAuditFiles, ...ready.state.rootBuild.ownedFiles, ...ready.state.presentationBuild.ownedFiles, ...ready.state.previewBuild.ownedFiles, ...ready.state.gate2PreviewBuild.ownedFiles, ...(ready.state.gate2AttemptReports ?? []), ...(ready.state.supersededWorkflowCleanup?.files ?? []), ready.state.fullCorrespondenceAudit, ready.state.previewCheckpoint, { path: ready.path, sha256: ready.snapshot.sha256 }, ready.state.previousState];
    const cleanup = await cleanupBound(cleanupFiles, [...(ready.state.supersededWorkflowCleanup?.roots ?? []), ready.state.workflowRoot, ready.state.previewBuild.outputRoot, ready.state.gate2PreviewBuild.outputRoot, ready.state.rootBuild.stagingRoot, ready.state.presentationBuild.stagingRoot]);
    return deepFreeze({ ...receiptCore, receiptDigest: canonicalDigest(receiptCore), cleanup });
  } catch (error) {
    const rollbackErrors = await rollbackPublished(published);
    const backupCleanup = rollbackErrors.length ? { preserved: backups.map((item) => item.path), failures: [] } : await cleanupBound(backups, []);
    const archiveCleanup = await cleanupBound([...archiveCopies, ...temporaryAuditFiles], []);
    const directoryCleanupFailures = await cleanupCreatedDirectories(createdDirectories);
    if (rollbackErrors.length || backupCleanup.preserved.length || backupCleanup.failures.length || archiveCleanup.preserved.length || archiveCleanup.failures.length || directoryCleanupFailures.length) fail(`${error instanceof Error ? error.message : String(error)}; recovery incomplete: ${[...rollbackErrors, ...backupCleanup.preserved, ...backupCleanup.failures.map((item) => item.path), ...archiveCleanup.preserved, ...archiveCleanup.failures.map((item) => item.path), ...directoryCleanupFailures.map((item) => `${item.path}${item.error?.code ? ` [${item.error.code}]` : ""}`)].join(", ")}`);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !["--prepare", "--finalize", "--revise-gate2", "--publish"].includes(args[0])) fail("usage: run_reimbursement_workflow.mjs --prepare|--finalize|--revise-gate2|--publish <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_JSON_BYTES });
  const result = args[0] === "--prepare"
    ? await prepareReimbursementWorkflow(input.value)
    : args[0] === "--finalize"
      ? await finalizeReimbursementWorkflow(input.value)
      : args[0] === "--revise-gate2"
        ? await reviseGate2ReimbursementWorkflow(input.value)
      : await publishReimbursementWorkflow(input.value);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
