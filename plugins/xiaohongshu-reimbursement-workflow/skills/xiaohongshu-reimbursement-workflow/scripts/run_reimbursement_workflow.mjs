import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildGateBinding } from "./build_gate_binding.mjs";
import { buildReimbursementArtifacts, REIMBURSEMENT_ARTIFACT_BUILD_KIND } from "./build_reimbursement_artifacts.mjs";
import {
  buildRootWorkbookCandidates,
  computeRootWorkbookAuditRequestDigest,
  ROOT_WORKBOOK_AUDIT_REQUEST_KIND,
  runRootWorkbookAuditWorker,
  validateRootWorkbookAuditBatch,
} from "./build_root_workbook_candidate.mjs";
import { loadProfileRegistry } from "./finance_domain.mjs";
import { runSafePublish, runSafePublishAsync } from "./run_safe_publish.mjs";
import {
  canonicalDigest,
  copyStableBinaryBytes,
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

const TOKEN_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_AUDITOR = path.join(SCRIPT_DIR, "audit_batch_manifest.mjs");
const PREVIEW_RENDERER = path.join(SCRIPT_DIR, "render_reimbursement_previews.ps1");
const WORKFLOW_PREFIX = "codex-xhs-workflow-";
const GATE1_TEXT = "本次报销通过无误";
const GATE2_TEXT = "确认更新根目录支出总表";
const PREVIEW_REQUEST_KIND = "ordinary-reimbursement-preview-request-v1";
const PREVIEW_RESPONSE_KIND = "ordinary-reimbursement-preview-response-v1";
const PREVIEW_RESULT_KIND = "ordinary-reimbursement-preview-set-v1";
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_RENDERER_OUTPUT_BYTES = 2 * 1024 * 1024;
const RENDERER_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(`Ordinary Reimbursement Workflow ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
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

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function deriveToken(token, role) {
  return sha256Bytes(`${token}:${role}`);
}

async function writeExclusiveJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stable = await readStableUtf8JsonFile(filePath, { maxBytes: MAX_JSON_BYTES });
  if (stable.sha256 !== sha256Bytes(bytes)) fail(`${path.basename(filePath)} changed after exclusive write.`);
  return { path: filePath, sha256: stable.sha256, size: stable.size };
}

async function assertBoundFile(binding, field) {
  const stable = await readStableBinaryFile(binding.path);
  if (stable.sha256 !== binding.sha256 || (binding.size !== undefined && stable.size !== binding.size)) fail(`${field} changed after binding.`);
  return stable;
}

function auditManifest(manifestPath, expectedSha256) {
  const child = spawnSync(process.execPath, [MANIFEST_AUDITOR, manifestPath, "--defer-ordinary-file-verification"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_JSON_BYTES,
    timeout: 60_000,
  });
  if (child.error || child.signal || child.status !== 0 || child.stderr) fail(`manifest audit failed: ${child.stderr?.trim() || child.error?.message || child.signal || child.status}`);
  const lines = child.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail("manifest auditor must return one JSON line.");
  const result = parseStrictJson(lines[0]);
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

function gate2For(audit, rootBuild, finalAudits, baselines, gate2PreviewDigest) {
  const previewDigest = sha(gate2PreviewDigest, "gate2PreviewDigest");
  const auditByProfile = new Map(finalAudits.map((item) => [item.profile.profileId, item]));
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
  }), { gate2PreviewDigest: previewDigest });
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
      if (error?.code !== "ENOENT") failures.push({ path: item.path, error });
    }
  }
  for (const root of [...new Set(roots)].reverse()) {
    try { await fs.rmdir(root); } catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") failures.push({ path: root, error }); }
  }
  return { preserved, failures };
}

async function writeAuditRequest(workflowRoot, certificate, profiles, role) {
  const requestNonce = crypto.randomBytes(32).toString("hex");
  const request = { kind: ROOT_WORKBOOK_AUDIT_REQUEST_KIND, requestNonce, reimbursementFactsCertificate: certificate, profiles };
  request.requestDigest = computeRootWorkbookAuditRequestDigest(request);
  const binding = await writeExclusiveJson(path.join(workflowRoot, `.${role}-audit-${requestNonce}.json`), request);
  return { request, binding };
}

async function runBatchAudit(workflowRoot, certificate, profiles, role) {
  const { request, binding } = await writeAuditRequest(workflowRoot, certificate, profiles, role);
  try {
    const raw = await runRootWorkbookAuditWorker({ requestPath: binding.path, requestFileSha256: binding.sha256, requestNonce: request.requestNonce });
    const { rawStdout: _stdout, ...response } = raw;
    return validateRootWorkbookAuditBatch(response, {
      requestDigest: request.requestDigest,
      requestFileSha256: binding.sha256,
      requestNonce: request.requestNonce,
      profileIds: profiles.map((item) => item.profileId),
      profileBindings: profiles.map(({ profileId, baselineSha256, candidateSha256 }) => ({ profileId, baselineSha256, candidateSha256 })),
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

function pngDimensions(bytes, field) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`${field} is not a PNG.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 50_000 || height > 50_000) fail(`${field} dimensions are invalid.`);
  return { width, height };
}

async function buildReviewPreviews(workflowRoot, rootBuild, presentationBuild, sourceCoverageDigest, testHooks, stage = "gate-1", verifiedPreviewBuild = undefined) {
  if (!new Set(["gate-1", "gate-2"]).has(stage)) fail("preview stage is invalid.");
  if (verifiedPreviewBuild !== undefined && stage !== "gate-2") fail("only Gate 2 may build verified preview copies.");
  const outputRoot = path.join(workflowRoot, `${stage}-previews`);
  await fs.mkdir(outputRoot, { recursive: false });
  const presentationByProfile = new Map(presentationBuild.artifacts.map((item) => [item.profileId, item]));
  const jobs = [];
  const bindings = [];
  for (const root of rootBuild.artifacts) {
    const presentation = presentationByProfile.get(root.profileId);
    if (!presentation) fail(`${root.profileId} presentation artifact is missing for preview rendering.`);
    bindings.push({
      profileId: root.profileId,
      candidateSha256: root.candidateSha256,
      planSha256: root.planSha256,
      sourceCoverageDigest: sha(sourceCoverageDigest, "sourceCoverageDigest"),
      batchRows: root.audit.projection.batchRanges.map((range) => `${range.startRow}:${range.endRow}`),
      rootPreviewRange: root.previewRangeAddress,
    });
    jobs.push(
      {
        profileId: root.profileId,
        role: "root",
        workbookPath: root.previewPath,
        workbookSha256: root.previewSha256,
        sheetName: root.previewSheetName,
        rangeAddress: root.previewRangeAddress,
        outputPath: path.join(outputRoot, `${root.profileId}-root.png`),
      },
      {
        profileId: root.profileId,
        role: "detail",
        workbookPath: presentation.detail.path,
        workbookSha256: presentation.detail.sha256,
        sheetName: presentation.detail.sheetName,
        rangeAddress: `A1:F${presentation.detail.endRow}`,
        outputPath: path.join(outputRoot, `${root.profileId}-detail.png`),
      },
      {
        profileId: root.profileId,
        role: "screenshot",
        workbookPath: presentation.screenshot.path,
        workbookSha256: presentation.screenshot.sha256,
        sheetName: presentation.screenshot.sheetName,
        rangeAddress: `A1:${presentation.screenshot.endColumn}${presentation.screenshot.endRow}`,
        outputPath: path.join(outputRoot, `${root.profileId}-screenshot.png`),
      },
    );
  }
  const requestNonce = crypto.randomBytes(32).toString("hex");
  const request = { kind: PREVIEW_REQUEST_KIND, requestNonce, outputRoot, bindings, jobs };
  const requestFile = verifiedPreviewBuild === undefined
    ? await writeExclusiveJson(path.join(workflowRoot, `.${stage}-preview-request-${requestNonce}.json`), request)
    : undefined;
  let response;
  try {
    if (verifiedPreviewBuild !== undefined) {
      if (!Array.isArray(verifiedPreviewBuild.previews) || verifiedPreviewBuild.previews.length !== jobs.length) fail("Gate 1 preview set cannot satisfy the Gate 2 preview contract.");
      response = {
        kind: PREVIEW_RESPONSE_KIND,
        requestNonce,
        requestFileSha256: null,
        enginePeakWorkingSetBytes: 1,
        previews: await Promise.all(jobs.map(async (job, index) => {
          const prior = verifiedPreviewBuild.previews[index];
          if (prior.profileId !== job.profileId || prior.role !== job.role || prior.sourceSha256 !== job.workbookSha256) {
            fail("Gate 1 preview source binding differs from the current Gate 2 source.");
          }
          const priorStable = await assertBoundFile(prior, `Gate 1 ${prior.profileId} ${prior.role} preview`);
          await fs.copyFile(prior.path, job.outputPath, fsConstants.COPYFILE_EXCL);
          return { profileId: job.profileId, role: job.role, workbookSha256: job.workbookSha256, outputPath: job.outputPath, sha256: priorStable.sha256, size: priorStable.size };
        })),
      };
    } else {
      response = testHooks?.runPreviewRenderer
        ? await testHooks.runPreviewRenderer({ request: clone(request), requestPath: requestFile.path, requestFileSha256: requestFile.sha256 })
        : await runPreviewRenderer({ requestPath: requestFile.path, requestFileSha256: requestFile.sha256, requestNonce });
    }
    exact(response, new Set(["kind", "requestNonce", "requestFileSha256", "enginePeakWorkingSetBytes", "previews"]), "preview renderer response");
    if (response.kind !== PREVIEW_RESPONSE_KIND || response.requestNonce !== requestNonce || (requestFile ? response.requestFileSha256 !== requestFile.sha256 : response.requestFileSha256 !== null)) fail("preview renderer response differs from the bound request.");
    if (!Number.isSafeInteger(response.enginePeakWorkingSetBytes) || response.enginePeakWorkingSetBytes < 1) fail("preview renderer did not report a valid engine peak working set.");
    if (!Array.isArray(response.previews) || response.previews.length !== jobs.length) fail("preview renderer returned the wrong preview count.");
    const previews = [];
    for (const [index, raw] of response.previews.entries()) {
      exact(raw, new Set(["profileId", "role", "workbookSha256", "outputPath", "sha256", "size"]), `preview renderer response previews[${index}]`);
      const job = jobs[index];
      if (raw.profileId !== job.profileId || raw.role !== job.role || raw.workbookSha256 !== job.workbookSha256 || !samePath(raw.outputPath, job.outputPath)) fail("preview renderer output order or source binding is invalid.");
      const stable = await readStableBinaryFile(job.outputPath, { maxBytes: MAX_PREVIEW_BYTES });
      if (stable.sha256 !== sha(raw.sha256, `preview ${index} sha256`) || stable.size !== raw.size || stable.size < 1_000) fail("preview renderer output changed after render.");
      const dimensions = pngDimensions(copyStableBinaryBytes(stable), `preview ${index}`);
      previews.push({ profileId: job.profileId, role: job.role, sourceSha256: job.workbookSha256, sheetName: job.sheetName, rangeAddress: job.rangeAddress, path: job.outputPath, sha256: stable.sha256, size: stable.size, ...dimensions });
    }
    const body = {
      kind: PREVIEW_RESULT_KIND,
      stage,
      outputRoot,
      bindingDigest: canonicalDigest(bindings),
      requestFileSha256: requestFile?.sha256 ?? null,
      ...(verifiedPreviewBuild === undefined ? {} : { rebuiltFromPreviewDigest: sha(verifiedPreviewBuild.previewDigest, "Gate 1 previewDigest") }),
      enginePeakWorkingSetBytes: response.enginePeakWorkingSetBytes,
      previews,
    };
    return deepFreeze({ ...body, previewDigest: canonicalDigest(body), ownedFiles: previews.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })) });
  } catch (error) {
    const cleanupEntries = [];
    for (const job of jobs) {
      const current = await readStableBinaryFile(job.outputPath, { maxBytes: MAX_PREVIEW_BYTES }).catch(() => null);
      if (current) cleanupEntries.push({ path: job.outputPath, sha256: current.sha256, size: current.size });
    }
    const cleanup = await cleanupBound(cleanupEntries, [outputRoot]);
    if (cleanup.preserved.length || cleanup.failures.length) fail(`${error instanceof Error ? error.message : String(error)}; preview cleanup was incomplete.`);
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

export async function prepareReimbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["kind", "stagingToken", "manifestPath", "manifestSha256", "baselines"]), "prepare request");
  if (rawRequest.kind !== WORKFLOW_PREPARE_KIND || !TOKEN_RE.test(rawRequest.stagingToken ?? "")) fail("prepare kind or stagingToken is invalid.");
  if (!Array.isArray(rawRequest.baselines) || rawRequest.baselines.length < 1 || rawRequest.baselines.length > 3) fail("baselines must contain one to three profiles.");
  const manifestPath = path.resolve(text(rawRequest.manifestPath, "manifestPath"));
  const manifestSha256 = sha(rawRequest.manifestSha256, "manifestSha256");
  const manifestStable = await readStableUtf8JsonFile(manifestPath, { maxBytes: MAX_JSON_BYTES });
  if (manifestStable.sha256 !== manifestSha256) fail("manifest SHA differs from prepare request.");
  const manifestAudit = auditManifest(manifestPath, manifestSha256);
  const registry = await loadProfileRegistry();
  const baselines = rawRequest.baselines.map((raw, index) => {
    exact(raw, new Set(["profileId", "path", "sha256", "size", "candidateRevision"]), `baselines[${index}]`);
    const profileId = text(raw.profileId, `baselines[${index}].profileId`);
    if (!registry.profiles[profileId]) fail(`${profileId} is not a canonical profile.`);
    if (!Number.isSafeInteger(raw.size) || raw.size < 1 || !Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) fail(`${profileId} baseline size/revision is invalid.`);
    return { profileId, path: path.resolve(text(raw.path, `${profileId}.path`)), sha256: sha(raw.sha256, `${profileId}.sha256`), size: raw.size, candidateRevision: raw.candidateRevision };
  });
  if (canonicalDigest(baselines.map((item) => item.profileId)) !== canonicalDigest(manifestAudit.affectedProfileIds)) fail("baselines must exactly match affected profiles in registry order.");
  const workflowRoot = path.join(path.resolve(os.tmpdir()), `${WORKFLOW_PREFIX}${rawRequest.stagingToken}`);
  await fs.mkdir(workflowRoot, { recursive: false });
  let rootBuild;
  let presentationBuild;
  let previewBuild;
  try {
    const [rootSettled, presentationSettled] = await Promise.allSettled([
      buildRootWorkbookCandidates({
        kind: "root-workbook-build-request-v1",
        stagingToken: deriveToken(rawRequest.stagingToken, "root"),
        reimbursementFactsCertificate: manifestAudit.reimbursementFactsCertificate,
        artifacts: baselines.map((item) => ({ profileId: item.profileId, baselinePath: item.path, baselineSha256: item.sha256, baselineSize: item.size, candidateRevision: item.candidateRevision })),
      }, { testHooks }),
      buildReimbursementArtifacts({
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
    previewBuild = await buildReviewPreviews(workflowRoot, rootBuild, presentationBuild, manifestAudit.reimbursementFactsCertificate.sourceCoverageDigest, testHooks, "gate-1");
    const reviewPackageDigest = canonicalDigest({
      manifestSha256,
      certificateDigest: manifestAudit.reimbursementFactsCertificate.certificateDigest,
      roots: rootBuild.artifacts.map((item) => ({ profileId: item.profileId, candidateSha256: item.candidateSha256, planSha256: item.planSha256, auditDigest: item.audit.auditDigest })),
      presentation: presentationBuild.artifacts.map((item) => ({ profileId: item.profileId, artifactDigest: item.artifactDigest, detailSha256: item.detail.sha256, screenshotSha256: item.screenshot.sha256 })),
      previews: previewBuild.previews.map((item) => ({ profileId: item.profileId, role: item.role, sourceSha256: item.sourceSha256, sha256: item.sha256, rangeAddress: item.rangeAddress })),
    });
    const gate1 = gate1For(manifestAudit, rootBuild, reviewPackageDigest);
    const core = {
      kind: WORKFLOW_GATE1_KIND,
      requiresGate1Approval: true,
      stagingToken: rawRequest.stagingToken,
      workflowRoot,
      manifest: {
        path: manifestPath,
        sha256: manifestSha256,
        archivePath: path.resolve(manifestStable.value.batch.archivePath),
        batchId: manifestAudit.batch.batchId,
        operationDigest: manifestAudit.operationDigest,
        targetCategory: manifestAudit.batch.targetCategory,
        period: manifestAudit.batch.period,
        mainPeriod: manifestAudit.batch.mainPeriod,
      },
      certificate: manifestAudit.reimbursementFactsCertificate,
      affectedProfileIds: manifestAudit.affectedProfileIds,
      baselines,
      rootBuild,
      presentationBuild,
      previewBuild,
      reviewPackageDigest,
      gate1,
    };
    const state = { ...core, stateDigest: canonicalDigest(core) };
    const stateFile = await writeExclusiveJson(path.join(workflowRoot, "ready-gate-1.json"), state);
    return deepFreeze({
      status: "ready-for-gate-1",
      gate1BindingDigest: gate1.bindingDigest,
      approvalText: GATE1_TEXT,
      statePath: stateFile.path,
      stateSha256: stateFile.sha256,
      stateDigest: state.stateDigest,
      affectedProfileIds: state.affectedProfileIds,
      previewEnginePeakWorkingSetBytes: previewBuild.enginePeakWorkingSetBytes,
      review: presentationBuild.artifacts.map((item) => ({
        profileId: item.profileId,
        summary: item.summary.text,
        detail: { path: item.detail.path, sha256: item.detail.sha256 },
        screenshot: { path: item.screenshot.path, sha256: item.screenshot.sha256, imageCount: item.screenshot.imageCount },
        previews: previewBuild.previews.filter((preview) => preview.profileId === item.profileId),
        evidenceCount: item.evidenceArchive.length,
      })),
    });
  } catch (error) {
    const files = [...(rootBuild?.ownedFiles ?? []), ...(presentationBuild?.ownedFiles ?? []), ...(previewBuild?.ownedFiles ?? [])];
    const roots = [workflowRoot, previewBuild?.outputRoot, rootBuild?.stagingRoot, presentationBuild?.stagingRoot].filter(Boolean);
    const cleanup = await cleanupBound(files, roots);
    if (cleanup.preserved.length || cleanup.failures.length) fail(`${error instanceof Error ? error.message : String(error)}; cleanup preserved or failed for ${[...cleanup.preserved, ...cleanup.failures.map((item) => item.path)].join(", ")}`);
    throw error;
  }
}

export async function finalizeReimbursementWorkflow(rawRequest, { testHooks } = {}) {
  exact(rawRequest, new Set(["statePath", "expectedGate1BindingDigest", "approvalText"]), "finalize request");
  if (rawRequest.approvalText !== GATE1_TEXT) fail("Gate 1 approval text is not exact.");
  const ready = await readState(rawRequest.statePath, WORKFLOW_GATE1_KIND);
  if (sha(rawRequest.expectedGate1BindingDigest, "expectedGate1BindingDigest") !== ready.state.gate1.bindingDigest) fail("Gate 1 binding digest differs from the displayed review package.");
  await Promise.all([
    ...ready.state.baselines.map((baseline) => assertBoundFile(baseline, `${baseline.profileId} baseline`)),
    ...ready.state.rootBuild.artifacts.map((artifact) => assertBoundFile(
      { path: artifact.candidatePath, sha256: artifact.candidateSha256, size: artifact.candidateSize },
      `${artifact.profileId} candidate`,
    )),
    ...ready.state.presentationBuild.artifacts.flatMap((artifact) => [
      assertBoundFile(artifact.detail, `${artifact.profileId} detail`),
      assertBoundFile(artifact.screenshot, `${artifact.profileId} screenshot`),
      assertBoundFile(artifact.summary, `${artifact.profileId} summary`),
      ...artifact.evidenceArchive.map((evidence) => assertBoundFile(evidence, `${artifact.profileId} evidence ${evidence.evidenceId}`)),
    ]),
    ...ready.state.previewBuild.previews.map((preview) => assertBoundFile(preview, `${preview.profileId} ${preview.role} preview`)),
  ]);
  const rootByProfile = new Map(ready.state.rootBuild.artifacts.map((item) => [item.profileId, item]));
  const profiles = ready.state.baselines.map((baseline) => ({
    profileId: baseline.profileId,
    baselinePath: baseline.path,
    baselineSha256: baseline.sha256,
    candidatePath: rootByProfile.get(baseline.profileId).candidatePath,
    candidateSha256: rootByProfile.get(baseline.profileId).candidateSha256,
  }));
  const finalAudit = await runBatchAudit(ready.state.workflowRoot, ready.state.certificate, profiles, "final");
  const gate2PreviewBuild = await buildReviewPreviews(ready.state.workflowRoot, ready.state.rootBuild, ready.state.presentationBuild, ready.state.certificate.sourceCoverageDigest, testHooks, "gate-2", ready.state.previewBuild);
  try {
    const gate2 = gate2For(
      { ...ready.state.manifest, batch: { batchId: ready.state.manifest.batchId }, sourceCoverageDigest: ready.state.certificate.sourceCoverageDigest },
      ready.state.rootBuild,
      finalAudit.audits,
      ready.state.baselines,
      gate2PreviewBuild.previewDigest,
    );
    const core = {
      ...stateCore(ready.state),
      kind: WORKFLOW_GATE2_KIND,
      requiresGate1Approval: false,
      requiresGate2Approval: true,
      finalAudit,
      finalAuditDigest: canonicalDigest(finalAudit),
      gate2PreviewBuild,
      gate2,
      previousState: { path: ready.path, sha256: ready.snapshot.sha256 },
    };
    const state = { ...core, stateDigest: canonicalDigest(core) };
    const stateFile = await writeExclusiveJson(path.join(ready.state.workflowRoot, "ready-gate-2.json"), state);
    return deepFreeze({
      status: "ready-for-gate-2",
      gate2BindingDigest: gate2.bindingDigest,
      approvalText: GATE2_TEXT,
      statePath: stateFile.path,
      stateSha256: stateFile.sha256,
      stateDigest: state.stateDigest,
      affectedProfileIds: state.affectedProfileIds,
      previewEnginePeakWorkingSetBytes: gate2PreviewBuild.enginePeakWorkingSetBytes,
      review: ready.state.presentationBuild.artifacts.map((item) => ({
        profileId: item.profileId,
        summary: item.summary.text,
        detail: { path: item.detail.path, sha256: item.detail.sha256 },
        screenshot: { path: item.screenshot.path, sha256: item.screenshot.sha256, imageCount: item.screenshot.imageCount },
        previews: gate2PreviewBuild.previews.filter((preview) => preview.profileId === item.profileId),
        evidenceCount: item.evidenceArchive.length,
      })),
    });
  } catch (error) {
    const cleanup = await cleanupBound(gate2PreviewBuild.ownedFiles, [gate2PreviewBuild.outputRoot]);
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
      if (error?.code !== "ENOENT") failures.push(directoryPath);
    }
  }
  return failures;
}

async function copyExclusiveBound(source, target) {
  await fs.copyFile(source.path, target, fsConstants.COPYFILE_EXCL);
  const stable = await readStableBinaryFile(target);
  if (stable.sha256 !== source.sha256 || stable.size !== source.size) fail(`${target} differs from its approved source.`);
  return { path: target, sha256: stable.sha256, size: stable.size };
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

export async function publishReimbursementWorkflow(rawRequest) {
  exact(rawRequest, new Set(["statePath", "expectedGate1BindingDigest", "gate1ApprovalText", "expectedGate2BindingDigest", "gate2ApprovalText"]), "publish request");
  if (rawRequest.gate1ApprovalText !== GATE1_TEXT || rawRequest.gate2ApprovalText !== GATE2_TEXT) fail("both approval texts must be exact and supplied from the current task.");
  const ready = await readState(rawRequest.statePath, WORKFLOW_GATE2_KIND);
  if (sha(rawRequest.expectedGate1BindingDigest, "expectedGate1BindingDigest") !== ready.state.gate1.bindingDigest || sha(rawRequest.expectedGate2BindingDigest, "expectedGate2BindingDigest") !== ready.state.gate2.bindingDigest) fail("Gate binding digest differs from the reviewed state.");
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
      const copies = await Promise.all([
        copyExclusiveBound(presentation.detail, path.join(profileArchive, path.basename(presentation.detail.path))),
        copyExclusiveBound(presentation.screenshot, path.join(profileArchive, path.basename(presentation.screenshot.path))),
        copyExclusiveBound(presentation.summary, path.join(profileArchive, path.basename(presentation.summary.path))),
        copyExclusiveBound({ path: root.candidatePath, sha256: root.candidateSha256, size: root.candidateSize }, path.join(profileArchive, `${profile.archiveStem}_截至${ledgerEnd}.xlsx`)),
        ...presentation.supplements.map((supplement) => copyExclusiveBound(supplement, path.join(profileArchive, path.basename(supplement.path)))),
        ...presentation.evidenceArchive.map((evidence) => copyExclusiveBound(evidence, path.join(screenshotArchiveDirectory, evidence.finalName))),
      ]);
      [archived.detail, archived.screenshot, archived.summary, archived.snapshot] = copies;
      const supplementOffset = 4;
      archived.supplements = copies.slice(supplementOffset, supplementOffset + presentation.supplements.length)
        .map((copied, index) => ({ person: presentation.supplements[index].person, ...copied }));
      const evidenceOffset = supplementOffset + presentation.supplements.length;
      archived.evidenceArchive = copies.slice(evidenceOffset).map((copied, index) => ({ evidenceId: presentation.evidenceArchive[index].evidenceId, ...copied }));
      archiveCopies.push(...copies);
      const baselineStable = await readStableBinaryFile(baseline.path);
      const backupPath = path.join(ready.state.workflowRoot, `.rollback-${baseline.profileId}-${crypto.randomBytes(8).toString("hex")}.xlsx`);
      const handle = await fs.open(backupPath, "wx", 0o600);
      try { await handle.writeFile(copyStableBinaryBytes(baselineStable)); await handle.sync(); } finally { await handle.close(); }
      const backup = await readStableBinaryFile(backupPath);
      const backupBinding = { path: backupPath, sha256: backup.sha256, size: backup.size };
      backups.push(backupBinding);
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
    for (const item of publishResults) if (item.status === "fulfilled") published.push({ profileId: item.value.profileId, targetPath: item.value.targetPath, targetOriginallyAbsent: item.value.targetOriginallyAbsent, baselineSha256: item.value.baseline.sha256, candidateSha256: item.value.root.candidateSha256, backup: item.value.backup, result: item.value.result, archived: item.value.archived });
    const publishFailure = publishResults.find((item) => item.status === "rejected");
    if (publishFailure) throw publishFailure.reason;
    const postProfiles = published.map((entry) => ({ profileId: entry.profileId, baselinePath: entry.backup.path, baselineSha256: entry.baselineSha256, candidatePath: entry.targetPath, candidateSha256: entry.candidateSha256 }));
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
    const cleanupFiles = [...backups, ...temporaryAuditFiles, ...ready.state.rootBuild.ownedFiles, ...ready.state.presentationBuild.ownedFiles, ...ready.state.previewBuild.ownedFiles, ...ready.state.gate2PreviewBuild.ownedFiles, { path: ready.path, sha256: ready.snapshot.sha256 }, ready.state.previousState];
    const cleanup = await cleanupBound(cleanupFiles, [ready.state.workflowRoot, ready.state.previewBuild.outputRoot, ready.state.gate2PreviewBuild.outputRoot, ready.state.rootBuild.stagingRoot, ready.state.presentationBuild.stagingRoot]);
    return deepFreeze({ ...receiptCore, receiptDigest: canonicalDigest(receiptCore), cleanup });
  } catch (error) {
    const rollbackErrors = await rollbackPublished(published);
    const archiveCleanup = await cleanupBound([...archiveCopies, ...temporaryAuditFiles], []);
    const directoryCleanupFailures = await cleanupCreatedDirectories(createdDirectories);
    if (rollbackErrors.length || archiveCleanup.preserved.length || archiveCleanup.failures.length || directoryCleanupFailures.length) fail(`${error instanceof Error ? error.message : String(error)}; recovery incomplete: ${[...rollbackErrors, ...archiveCleanup.preserved, ...archiveCleanup.failures.map((item) => item.path), ...directoryCleanupFailures].join(", ")}`);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !["--prepare", "--finalize", "--publish"].includes(args[0])) fail("usage: run_reimbursement_workflow.mjs --prepare|--finalize|--publish <strict-json-request>.");
  const input = await readStableUtf8JsonFile(path.resolve(args[1]), { maxBytes: MAX_JSON_BYTES });
  const result = args[0] === "--prepare"
    ? await prepareReimbursementWorkflow(input.value)
    : args[0] === "--finalize"
      ? await finalizeReimbursementWorkflow(input.value)
      : await publishReimbursementWorkflow(input.value);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
