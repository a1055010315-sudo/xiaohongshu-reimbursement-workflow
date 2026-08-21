import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReviewPreviews,
  inspectPreviewPng,
  prepareReimbursementWorkflow,
  previewJobBindingDigest,
  WORKFLOW_READY_PREVIEW_KIND,
} from "../scripts/run_reimbursement_workflow.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

function digest(value) { return sha256Bytes(String(value)); }

async function patternedPng() {
  const svg = Buffer.from('<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><path d="M0 0L640 360M0 360L640 0" stroke="#204060" stroke-width="12"/><rect x="80" y="60" width="480" height="240" fill="none" stroke="#d04040" stroke-width="8"/></svg>');
  return sharp(svg).png().toBuffer();
}

async function boundFile(filePath, bytes) {
  const value = Buffer.from(bytes);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(value), size: value.length };
}

function rendererResponse(request, requestFileSha256, bytes, mutate = undefined) {
  return Promise.all(request.jobs.map(async (job, index) => {
    await fs.writeFile(job.outputPath, bytes, { flag: "wx" });
    const response = {
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
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      renderAttempts: 1,
    };
    return mutate ? mutate(response, index) : response;
  })).then((previews) => ({
    kind: "ordinary-reimbursement-preview-response-v2",
    requestNonce: request.requestNonce,
    requestFileSha256,
    bindingDigest: request.bindingDigest,
    enginePeakWorkingSetBytes: 1_000_000,
    previews,
  }));
}

async function previewFixture(root) {
  const candidate = await boundFile(path.join(root, "candidate.xlsx"), "candidate");
  const preview = await boundFile(path.join(root, "batch-preview.xlsx"), "preview");
  const detail = await boundFile(path.join(root, "detail.xlsx"), "detail");
  const screenshot = await boundFile(path.join(root, "screenshot.xlsx"), "screenshot");
  const candidateSha256 = candidate.sha256;
  const planSha256 = digest("plan");
  return {
    rootBuild: {
      artifacts: [{
        profileId: "xiaohongshu",
        candidatePath: candidate.path,
        candidateSha256,
        planSha256,
        previewPath: preview.path,
        previewSha256: preview.sha256,
        previewSheetName: "本批总表增量",
        previewRangeAddress: "A1:F4",
        audit: { projection: { batchRanges: [{ startRow: 20, endRow: 22 }] } },
      }],
    },
    presentationBuild: {
      artifacts: [{
        profileId: "xiaohongshu",
        detail: { ...detail, sheetName: "本次报销明细", endRow: 8 },
        screenshot: { ...screenshot, sheetName: "报销明细对应截图表", endColumn: "F", endRow: 12 },
      }],
    },
    sourceCoverageDigest: digest("coverage"),
  };
}

test("preview job digest binds every workbook, range, candidate, plan, coverage, and batch-row field", () => {
  const job = {
    profileId: "xiaohongshu", role: "root", workbookSha256: digest("workbook"), sheetName: "本批总表增量",
    rangeAddress: "A1:F4", candidateSha256: digest("candidate"), planSha256: digest("plan"),
    sourceCoverageDigest: digest("coverage"), batchRows: ["20:22"],
  };
  const original = previewJobBindingDigest(job);
  for (const mutation of [
    { workbookSha256: digest("changed-workbook") }, { sheetName: "其他表" }, { rangeAddress: "A1:F5" },
    { candidateSha256: digest("changed-candidate") }, { planSha256: digest("changed-plan") },
    { sourceCoverageDigest: digest("changed-coverage") }, { batchRows: ["21:23"] }, { role: "detail" },
  ]) assert.notEqual(previewJobBindingDigest({ ...job, ...mutation }), original);
});

test("Node preview validation fully decodes PNG and rejects blank or corrupt output", async () => {
  const valid = await patternedPng();
  assert.deepEqual(await inspectPreviewPng(valid), { width: 640, height: 360 });
  const blank = await sharp({ create: { width: 640, height: 360, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(inspectPreviewPng(blank), /blank|variance/u);
  await assert.rejects(inspectPreviewPng(Buffer.alloc(1500, 1)), /decode|PNG/u);
});

test("preview request/response v2 is strict and Gate 2 reuses only the complete binding", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-v2-"));
  try {
    const fixture = await previewFixture(temp);
    const bytes = await patternedPng();
    let captured;
    const gate1 = await buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {
      runPreviewRenderer: async ({ request, requestFileSha256 }) => {
        captured = request;
        return rendererResponse(request, requestFileSha256, bytes);
      },
    });
    assert.equal(captured.kind, "ordinary-reimbursement-preview-request-v2");
    assert.equal(captured.jobs.length, 3);
    assert.equal(captured.jobs.every((job) => previewJobBindingDigest(job) === job.bindingDigest), true);
    assert.equal(gate1.previews.every((preview) => preview.bindingDigest && preview.renderAttempts === 1), true);
    const gate2 = await buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, undefined, "gate-2", gate1);
    assert.equal(gate2.previews.every((preview) => preview.renderAttempts === 0), true);
    assert.deepEqual(gate2.previews.map((preview) => preview.bindingDigest), gate1.previews.map((preview) => preview.bindingDigest));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }

  const tamperTemp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-v2-tamper-"));
  try {
    const fixture = await previewFixture(tamperTemp);
    const bytes = await patternedPng();
    await assert.rejects(
      buildReviewPreviews(tamperTemp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {
        runPreviewRenderer: ({ request, requestFileSha256 }) => rendererResponse(request, requestFileSha256, bytes, (preview, index) => index === 0 ? { ...preview, rangeAddress: "A1:F5" } : preview),
      }),
      /full source binding/u,
    );
  } finally {
    await fs.rm(tamperTemp, { recursive: true, force: true });
  }
});

test("candidate workbook can never be used as the ordinary root preview fallback", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-no-fallback-"));
  try {
    const fixture = await previewFixture(temp);
    fixture.rootBuild.artifacts[0].previewPath = fixture.rootBuild.artifacts[0].candidatePath;
    await assert.rejects(buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {}), /cannot fall back to the candidate workbook/u);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a pre-render contract failure cleans its preview root so the same workflow root can retry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-contract-retry-"));
  try {
    const fixture = await previewFixture(temp);
    const dedicatedPreviewPath = fixture.rootBuild.artifacts[0].previewPath;
    fixture.rootBuild.artifacts[0].previewPath = fixture.rootBuild.artifacts[0].candidatePath;
    await assert.rejects(buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {}), /cannot fall back to the candidate workbook/u);
    await assert.rejects(fs.access(path.join(temp, "gate-1-previews")), /ENOENT/u);
    fixture.rootBuild.artifacts[0].previewPath = dedicatedPreviewPath;
    const bytes = await patternedPng();
    const retry = await buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {
      runPreviewRenderer: ({ request, requestFileSha256 }) => rendererResponse(request, requestFileSha256, bytes),
    });
    assert.equal(retry.previews.length, 3);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a partial exclusive preview request is removed so the same workflow root can retry", { concurrency: false }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-request-partial-"));
  const originalOpen = fs.open;
  try {
    const fixture = await previewFixture(temp);
    let injected = false;
    fs.open = async (filePath, flags, ...rest) => {
      const handle = await originalOpen.call(fs, filePath, flags, ...rest);
      if (injected || flags !== "wx" || !/\.gate-1-preview-request-[0-9a-f]+\.json$/u.test(String(filePath))) return handle;
      injected = true;
      return {
        writeFile: async () => {
          await handle.writeFile(Buffer.from("{\"partial\":", "utf8"));
          throw new Error("synthetic partial preview-request failure");
        },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    };
    await assert.rejects(
      buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {}),
      /synthetic partial preview-request failure/u,
    );
    assert.equal(injected, true);
    assert.equal((await fs.readdir(temp)).some((name) => /preview-request/u.test(name)), false);
    await assert.rejects(fs.access(path.join(temp, "gate-1-previews")), /ENOENT/u);
    fs.open = originalOpen;
    const bytes = await patternedPng();
    const retry = await buildReviewPreviews(temp, fixture.rootBuild, fixture.presentationBuild, fixture.sourceCoverageDigest, {
      runPreviewRenderer: ({ request, requestFileSha256 }) => rendererResponse(request, requestFileSha256, bytes),
    });
    assert.equal(retry.previews.length, 3);
  } finally {
    fs.open = originalOpen;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("same staging token resumes ready-preview and reruns only rendering", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ready-preview-resume-"));
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const workflowRoot = path.join(os.tmpdir(), `codex-xhs-workflow-${stagingToken}`);
  let rootBuildCount = 0;
  let presentationBuildCount = 0;
  let renderCount = 0;
  let auditManifestCount = 0;
  try {
    const manifestPath = path.join(temp, "manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify({ batch: { archivePath: path.join(temp, "archive") } })}\n`);
    await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const baseline = await boundFile(path.join(temp, "baseline.xlsx"), "baseline");
    const candidate = await boundFile(path.join(temp, "root-stage", "candidate.xlsx"), "candidate");
    const rootPreview = await boundFile(path.join(temp, "root-stage", "preview.xlsx"), "preview");
    const rootPlan = await boundFile(path.join(temp, "root-stage", "plan.json"), "plan");
    const detail = await boundFile(path.join(temp, "presentation-stage", "detail.xlsx"), "detail");
    const screenshot = await boundFile(path.join(temp, "presentation-stage", "screenshot.xlsx"), "screenshot");
    const summary = await boundFile(path.join(temp, "presentation-stage", "summary.txt"), "summary");
    const certificate = { certificateDigest: digest("certificate"), sourceCoverageDigest: digest("coverage") };
    const audit = {
      manifestFileSha256: sha256Bytes(manifestBytes),
      affectedProfileIds: ["xiaohongshu"],
      batch: { batchId: "anonymous-batch", archivePath: path.join(temp, "archive"), targetCategory: "小红书报销", period: "2035.1.1-2035.1.2", mainPeriod: { start: "2035-01-01", end: "2035-01-02" } },
      operationDigest: digest("operation"), sourceCoverageDigest: certificate.sourceCoverageDigest, factsDigest: digest("facts"), reimbursementFactsCertificate: certificate,
    };
    const hooks = {
      auditManifest: async () => { auditManifestCount += 1; return audit; },
      buildRootWorkbookCandidates: async () => {
        rootBuildCount += 1;
        return {
          stagingRoot: path.dirname(candidate.path),
          ownedFiles: [candidate, rootPreview, rootPlan],
          artifacts: [{ profileId: "xiaohongshu", candidateRevision: 1, candidatePath: candidate.path, candidateSha256: candidate.sha256, candidateSize: candidate.size, planPath: rootPlan.path, planSha256: rootPlan.sha256, previewPath: rootPreview.path, previewSha256: rootPreview.sha256, previewSheetName: "本批总表增量", previewRangeAddress: "A1:F2", audit: { auditDigest: digest("audit"), projection: { batchRanges: [{ startRow: 10, endRow: 10 }] } } }],
        };
      },
      buildReimbursementArtifacts: async () => {
        presentationBuildCount += 1;
        return {
          stagingRoot: path.dirname(detail.path),
          ownedFiles: [detail, screenshot, summary],
          artifacts: [{ profileId: "xiaohongshu", artifactDigest: digest("artifacts"), detail: { ...detail, sheetName: "本次报销明细", endRow: 2 }, screenshot: { ...screenshot, sheetName: "报销明细对应截图表", endColumn: "F", endRow: 2, imageCount: 0 }, summary: { ...summary, text: "匿名说明" }, evidenceArchive: [] }],
        };
      },
      runPreviewRenderer: async ({ request, requestFileSha256 }) => {
        renderCount += 1;
        if (renderCount === 1) throw new Error("simulated renderer failure");
        return rendererResponse(request, requestFileSha256, await patternedPng());
      },
    };
    const request = { kind: "ordinary-reimbursement-prepare-v1", stagingToken, manifestPath, manifestSha256: sha256Bytes(manifestBytes), baselines: [{ profileId: "xiaohongshu", path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: 1 }] };
    await assert.rejects(prepareReimbursementWorkflow(request, { testHooks: hooks }), /business artifacts are preserved/u);
    assert.equal(rootBuildCount, 1);
    assert.equal(presentationBuildCount, 1);
    assert.equal(auditManifestCount, 1);
    const checkpoint = JSON.parse(await fs.readFile(path.join(workflowRoot, "ready-preview.json"), "utf8"));
    assert.equal(checkpoint.kind, WORKFLOW_READY_PREVIEW_KIND);
    const result = await prepareReimbursementWorkflow(request, { testHooks: hooks });
    assert.equal(result.status, "ready-for-gate-1");
    assert.equal(rootBuildCount, 1);
    assert.equal(presentationBuildCount, 1);
    assert.equal(auditManifestCount, 1, "checkpoint recovery must not rescan manifest evidence");
    assert.equal(renderCount, 2);
    const ready = JSON.parse(await fs.readFile(result.statePath, "utf8"));
    assert.equal(ready.reusedPreviewCheckpoint, true);

    const mismatchedToken = crypto.randomBytes(32).toString("hex");
    const mismatchedRoot = path.join(os.tmpdir(), `codex-xhs-workflow-${mismatchedToken}`);
    const buildCounts = { root: rootBuildCount, presentation: presentationBuildCount };
    await assert.rejects(prepareReimbursementWorkflow({ ...request, stagingToken: mismatchedToken }, {
      testHooks: {
        ...hooks,
        auditManifest: async () => ({ ...audit, manifestFileSha256: digest("wrong-manifest-bytes") }),
      },
    }), /did not bind the requested bytes/u);
    assert.deepEqual({ root: rootBuildCount, presentation: presentationBuildCount }, buildCounts, "an unbound manifest audit must fail before either business builder runs");
    await assert.rejects(fs.access(mismatchedRoot), /ENOENT/u);
  } finally {
    await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("PowerShell renderer contract includes STA, clipboard freshness, bounded retries, and atomic temporary PNGs", async () => {
  const script = await fs.readFile(path.join(scriptRoot, "render_reimbursement_previews.ps1"), "utf8");
  assert.match(script, /GetClipboardSequenceNumber/u);
  assert.match(script, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/u);
  assert.match(script, /if \(\$attempt -gt 1\).*Start-ExcelEngine/u);
  assert.match(script, /\.partial\.png/u);
  assert.doesNotMatch(script, /Sleep\(100\)/u, "renderer must not impose a fixed post-paste delay");
  assert.match(script, /GetClipboardSequenceNumber\(\).*break[\s\S]*Sleep\(15\)/u, "clipboard polling must check immediately before a bounded short wait");
  assert.match(script, /RequestNonce\.Substring\(0, 16\)/u, "Chart.Export temporary paths must stay below legacy Office path limits");
  assert.match(script, /Preview render step '\$step' failed/u, "renderer failures must name the exact COM step");
  assert.match(script, /\[IO\.File\]::Move\(\$TemporaryPath, \$OutputPath\)/u);
  assert.match(script, /catch \{[\s\S]*Test-Path -LiteralPath \$outputPath[\s\S]*Remove-Item -LiteralPath \$outputPath/u, "a post-move failure must remove only the current job output before retry");
  assert.match(script, /ordinary-reimbursement-preview-response-v2/u);
});

test("real Excel COM renderer produces three fully validated bound previews when available", { timeout: 120_000 }, async (context) => {
  if (process.platform !== "win32") return context.skip("Excel COM integration is Windows-only");
  const probe = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Sta", "-Command",
    "$e=$null; try{$e=New-Object -ComObject Excel.Application; exit 0}catch{exit 2}finally{if($null -ne $e){$e.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($e)}}",
  ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (probe.status !== 0) return context.skip("Excel COM is unavailable");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-preview-real-com-"));
  try {
    const longWorkflowRoot = path.join(temp, `workflow-${"x".repeat(64)}`);
    await fs.mkdir(longWorkflowRoot);
    const templateRoot = path.resolve(scriptRoot, "..", "assets", "templates", "xiaohongshu");
    const candidate = await boundFile(path.join(temp, "candidate.xlsx"), "candidate-is-never-rendered");
    const [rootPreviewBytes, detailBytes, screenshotBytes] = await Promise.all([
      fs.readFile(path.join(templateRoot, "ledger-batch-preview.xlsx")),
      fs.readFile(path.join(templateRoot, "current-detail.xlsx")),
      fs.readFile(path.join(templateRoot, "screenshot-map.xlsx")),
    ]);
    const rootPreview = { path: path.join(templateRoot, "ledger-batch-preview.xlsx"), sha256: sha256Bytes(rootPreviewBytes), size: rootPreviewBytes.length };
    const detail = { path: path.join(templateRoot, "current-detail.xlsx"), sha256: sha256Bytes(detailBytes), size: detailBytes.length };
    const screenshot = { path: path.join(templateRoot, "screenshot-map.xlsx"), sha256: sha256Bytes(screenshotBytes), size: screenshotBytes.length };
    const rootBuild = { artifacts: [{ profileId: "xiaohongshu", candidatePath: candidate.path, candidateSha256: candidate.sha256, planSha256: digest("real-com-plan"), previewPath: rootPreview.path, previewSha256: rootPreview.sha256, previewSheetName: "本批总表增量", previewRangeAddress: "A1:F2", audit: { projection: { batchRanges: [{ startRow: 10, endRow: 10 }] } } }] };
    const presentationBuild = { artifacts: [{ profileId: "xiaohongshu", detail: { ...detail, sheetName: "本次报销明细", endRow: 7 }, screenshot: { ...screenshot, sheetName: "报销明细对应截图表", endColumn: "F", endRow: 2 } }] };
    const rendered = await buildReviewPreviews(longWorkflowRoot, rootBuild, presentationBuild, digest("real-com-coverage"));
    assert.equal(rendered.previews.length, 3);
    assert.equal(rendered.previews.every((preview) => preview.renderAttempts >= 1 && preview.renderAttempts <= 3), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
