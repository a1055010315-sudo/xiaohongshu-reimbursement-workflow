import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPackage, runMeasuredProcess } from "./benchmark-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, "..", "..");
const skillRelative = "plugins/xiaohongshu-reimbursement-workflow/skills/xiaohongshu-reimbursement-workflow";
const currentSkill = path.join(worktree, ...skillRelative.split("/"));
const approvedRoot = process.env.XHS_APPROVED_FIXTURE_ROOT?.trim();
assert.ok(approvedRoot, "Set XHS_APPROVED_FIXTURE_ROOT to the approved synthetic workbook fixture directory.");
const renderer = process.env.XHS_APPROVED_RENDERER_PATH?.trim()
  || path.join(approvedRoot, "00_验收证据", "screenshot-map-copy-picture-renderer.ps1");
const resourceHook = path.join(here, "child-resource-hook.mjs");
const manualBuilder = path.join(here, "f38a65b-manual-build-fixture.mjs");
const commit = "f38a65b571a92e42ba57250e306d7b3534a4c26b";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
async function sha256File(filePath) { return sha256(await fs.readFile(filePath)); }
function bytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }

async function extractBaseline(root) {
  const archivePath = path.join(root, "baseline.zip");
  const archived = await runMeasuredProcess("git", ["archive", "--format=zip", "-o", archivePath, commit], { cwd: worktree, timeoutMs: 30_000 });
  assert.equal(archived.status, 0, archived.stderr);
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  const baselineRoot = path.join(root, "baseline");
  const prefix = `${skillRelative}/`;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    if (!relative.startsWith("scripts/")) continue;
    const outputPath = path.join(baselineRoot, relative.replaceAll("/", path.sep));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, await entry.async("nodebuffer"), { flag: "wx" });
  }
  return baselineRoot;
}

async function measuredNode(scriptPath, args, root, name) {
  const metricsPath = path.join(root, `${name}-resource.json`);
  const result = await runMeasuredProcess(process.execPath, ["--import", pathToFileURL(resourceHook).href, scriptPath, ...args], {
    cwd: root,
    env: { ...process.env, XHS_BENCHMARK_METRICS_PATH: metricsPath },
    metricsPath,
    timeoutMs: 180_000,
  });
  assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `${name} did not return one JSON line.`);
  return { result, value: JSON.parse(lines[0]) };
}

async function measuredRender(workbookPath, outputPath, rangeAddress, root, name) {
  const result = await runMeasuredProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", renderer, "-WorkbookPath", workbookPath, "-OutputPath", outputPath, "-RangeAddress", rangeAddress], { cwd: root, timeoutMs: 120_000 });
  assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.ok((await fs.stat(outputPath)).size > 1_000);
  return result;
}

async function createInput(root) {
  await fs.mkdir(root, { recursive: true });
  const archive = path.join(root, "archive");
  await fs.mkdir(archive);
  const baselinePath = path.join(root, "小红书支出总表.xlsx");
  await fs.copyFile(path.join(approvedRoot, "01_小红书专项", "小红书支出总表.xlsx"), baselinePath, fs.constants.COPYFILE_EXCL);
  const evidencePath = path.join(root, "evidence.png");
  await fs.writeFile(evidencePath, png, { flag: "wx" });
  const baselineSha256 = await sha256File(baselinePath);
  const manifest = {
    version: 3,
    rulesVersion: "f38a65b-manual-replay-v1",
    batch: { batchId: `f38-replay-${crypto.randomBytes(16).toString("hex")}`, rootPath: root, archivePath: archive, period: "2026-08-20—2026-08-20", targetCategory: "小红书报销", reviewRevision: 1 },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baselinePath, sha256: baselineSha256 },
      { id: "IMG-1", role: "material", path: evidencePath, sha256: sha256(png), kind: "image", disposition: "used" },
    ],
    sourceScopes: [{ id: "SCOPE-1", fileId: "IMG-1", locator: "full-image", terminalConfirmed: true, expectedUnitCount: 1 }],
    sourceUnits: [{ id: "UNIT-1", scopeId: "SCOPE-1", locator: "region-1", disposition: "used" }],
    transactions: [{ id: "TX-XHS", sourceOrder: 1, date: "2026-08-20", person: "脱敏人员", project: "旧链脱敏项目", label: "脱敏人员", classification: "旧链分类", amount: "1.125", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-1"], sourceRefs: ["UNIT-1"] }],
    expectedFeeTotal: "1.125",
    expectedRealTotal: "1.125",
    expectedCategoryTotals: { "小红书报销": "1.125" },
  };
  const manifestPath = path.join(root, "batch-manifest.json");
  await fs.writeFile(manifestPath, bytes(manifest), { flag: "wx" });
  return { archive, baselinePath, baselineSha256, evidencePath, manifest, manifestPath };
}

async function runOne(baselineSkill, root) {
  const started = performance.now();
  const input = await createInput(root);
  const inputReadyAt = performance.now();
  const scripts = path.join(baselineSkill, "scripts");
  const stages = [];
  const manifestAudit = await measuredNode(path.join(scripts, "audit_batch_manifest.mjs"), [input.manifestPath], root, "manifest-audit");
  stages.push(manifestAudit.result);
  const summaryPreview = await measuredNode(path.join(scripts, "build_reimbursement_summary.mjs"), ["--manifest", input.manifestPath, "--preview"], root, "summary-preview");
  stages.push(summaryPreview.result);
  const summaryPath = path.join(root, "报销文字说明.txt");
  const summaryWrite = await measuredNode(path.join(scripts, "build_reimbursement_summary.mjs"), ["--manifest", input.manifestPath, "--output", summaryPath, "--expect-sha256", summaryPreview.value.textSha256], root, "summary-write");
  stages.push(summaryWrite.result);
  const build = await measuredNode(manualBuilder, [
    "--baseline", input.baselinePath,
    "--detail-template", path.join(currentSkill, "assets", "templates", "xiaohongshu-detail.xlsx"),
    "--screenshot-template", path.join(currentSkill, "assets", "templates", "xiaohongshu-screenshot.xlsx"),
    "--evidence", input.evidencePath,
    "--output-root", path.join(root, "built"),
  ], root, "manual-artifact-build");
  stages.push(build.result);
  const candidateSha256 = await sha256File(build.value.rootPath);
  const auditInput = {
    version: 1,
    baselineSha256: input.baselineSha256,
    rebuildBaseSha256: input.baselineSha256,
    candidateSha256,
    candidateRevision: 1,
    startRow: 12,
    expectedRecords: [{ id: "TX-XHS", sourceOrder: 1, origin: "manifest", sourceIds: ["UNIT-1"], date: "2026-08-20", project: "旧链脱敏项目", amount: "1.125", person: "脱敏人员", classification: "旧链分类", rowType: "expense", settlement: "employee_reimbursement" }],
    actualRows: [{ row: 12, date: "2026-08-20", project: "旧链脱敏项目", amount: "1.125", person: "脱敏人员", classification: "旧链分类", rowType: "expense", settlement: "employee_reimbursement", cDisplayDecimals: 3, dDisplayDecimals: 3, dFormula: "=SUM(C12:C12)", dValue: null }],
    actualMerges: [],
    sourceCoverage: [{ sourceId: "UNIT-1", disposition: "transaction", transactionIds: ["TX-XHS"] }],
  };
  const auditInputPath = path.join(root, "audit-input.json");
  await fs.writeFile(auditInputPath, bytes(auditInput), { flag: "wx" });
  const initialAudit = await measuredNode(path.join(scripts, "audit_ledger_layout.mjs"), ["--input", auditInputPath, "--baseline", input.baselinePath, "--candidate", build.value.rootPath], root, "initial-audit");
  stages.push(initialAudit.result);
  stages.push(await measuredRender(build.value.rootPath, path.join(root, "root.png"), "A1:F12", root, "root-render"));
  stages.push(await measuredRender(build.value.detailPath, path.join(root, "detail.png"), "A1:F7", root, "detail-render"));
  stages.push(await measuredRender(build.value.screenshotPath, path.join(root, "screenshot.png"), "A1:H2", root, "screenshot-render"));
  const gate1Context = { version: 2, gate: "gate-1", mode: "reimbursement-batch", batchId: input.manifest.batch.batchId, operationDigest: manifestAudit.value.operationDigest, candidateRevision: 1, candidatePath: build.value.rootPath, candidateSha256, factsDigest: manifestAudit.value.factsDigest, reviewPackageDigest: sha256(bytes({ summary: summaryPreview.value.textSha256, candidateSha256 })), candidatePlanSha256: candidateSha256, sourceCoverageDigest: manifestAudit.value.sourceCoverageDigest };
  const gate1Path = path.join(root, "gate1-context.json");
  await fs.writeFile(gate1Path, bytes(gate1Context), { flag: "wx" });
  const gate1 = await measuredNode(path.join(scripts, "build_gate_binding.mjs"), ["--input", gate1Path], root, "gate1");
  stages.push(gate1.result);
  const gate1At = performance.now();
  const finalAudit = await measuredNode(path.join(scripts, "audit_ledger_layout.mjs"), ["--input", auditInputPath, "--baseline", input.baselinePath, "--candidate", build.value.rootPath], root, "final-audit");
  stages.push(finalAudit.result);
  const gate2Context = { version: 2, gate: "gate-2", mode: "reimbursement-batch", batchId: input.manifest.batch.batchId, operationDigest: manifestAudit.value.operationDigest, candidateRevision: 1, candidatePath: build.value.rootPath, candidateSha256, baselinePath: input.baselinePath, baselineSha256: input.baselineSha256, finalAuditDigest: sha256(bytes(finalAudit.value)), candidatePlanSha256: candidateSha256, sourceCoverageDigest: manifestAudit.value.sourceCoverageDigest };
  const gate2Path = path.join(root, "gate2-context.json");
  await fs.writeFile(gate2Path, bytes(gate2Context), { flag: "wx" });
  const gate2 = await measuredNode(path.join(scripts, "build_gate_binding.mjs"), ["--input", gate2Path], root, "gate2");
  stages.push(gate2.result);
  const gate2At = performance.now();
  const publish = await measuredNode(path.join(scripts, "run_safe_publish.mjs"), ["--baseline-path", input.baselinePath, "--candidate-path", build.value.rootPath, "--target-path", input.baselinePath, "--expected-baseline-sha256", input.baselineSha256, "--expected-candidate-sha256", candidateSha256], root, "publish");
  stages.push(publish.result);
  assert.equal(await sha256File(input.baselinePath), candidateSha256);
  const ended = performance.now();
  return {
    inputPreparationMs: inputReadyAt - started,
    prepareToGate1Ms: gate1At - inputReadyAt,
    gate1ToGate2Ms: gate2At - gate1At,
    gate2PublishVerifyMs: ended - gate2At,
    totalMs: ended - started,
    childMaxRssKilobytes: Math.max(...stages.map((item) => item.resourceUsage?.maxRssKilobytes ?? 0)),
    stageSpawnToCloseMs: stages.map((item) => ({ command: item.command, ms: item.spawnToCloseMs })),
    gate1BindingDigest: gate1.value.bindingDigest,
    gate2BindingDigest: gate2.value.bindingDigest,
  };
}

async function main() {
  const outputPath = path.resolve(process.argv[2] ?? path.join(here, "f38a65b-performance.json"));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-f38-benchmark-"));
  const runs = [];
  try {
    const baselineSkill = await extractBaseline(tempRoot);
    await runOne(baselineSkill, path.join(tempRoot, "warmup"));
    for (let run = 1; run <= 5; run += 1) runs.push({ run, ...(await runOne(baselineSkill, path.join(tempRoot, `formal-${run}`))) });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const totals = runs.map((item) => item.totalMs).sort((a, b) => a - b);
  const stageKeys = ["inputPreparationMs", "prepareToGate1Ms", "gate1ToGate2Ms", "gate2PublishVerifyMs"];
  const summary = {
    runs: runs.length,
    medianMs: totals[Math.floor(totals.length / 2)],
    slowestMs: totals.at(-1),
    p95Ms: totals[Math.min(totals.length - 1, Math.ceil(totals.length * 0.95) - 1)],
    stageMediansMs: Object.fromEntries(stageKeys.map((key) => { const values = runs.map((item) => item[key]).sort((a, b) => a - b); return [key, values[Math.floor(values.length / 2)]]; })),
    maxChildRssKilobytes: Math.max(...runs.map((item) => item.childMaxRssKilobytes)),
  };
  const report = { kind: "f38a65b-manual-workflow-replay-v1", generatedAt: new Date().toISOString(), commit, node: process.version, platform: process.platform, warmups: 1, formalRuns: 5, humanWaitExcluded: true, manualBuildReplay: "artifact-tool reproduces the documented manual workbook build; all manifest, summary, audit, Gate, and publish scripts are extracted from f38a65b", conservativeOmissions: ["archive copies are omitted", "post-publish visual rerender is omitted"], summary, rawRuns: runs };
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ outputPath, summary })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
