import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runMeasuredProcess } from "./benchmark-helpers.mjs";

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(benchmarkDirectory, "..", "..");
const skillRoot = path.join(worktree, "plugins", "xiaohongshu-reimbursement-workflow", "skills", "xiaohongshu-reimbursement-workflow");
const node = process.execPath;
const resourceHook = path.join(benchmarkDirectory, "child-resource-hook.mjs");
const approvedRoot = "C:\\Users\\a1055\\Desktop\\Word和Excel文档\\skill测试\\成品_批准版式_v3_终验";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const profiles = [
  { id: "xiaohongshu", source: ["01_小红书专项", "小红书支出总表.xlsx"], input: "小红书支出总表.xlsx", canonical: "小红书支出总表.xlsx", category: "小红书报销" },
  { id: "company", source: ["02_公司专项", "公司支出总表.xlsx"], input: "公司支出总表.xlsx", canonical: "公司支出总表.xlsx", category: "公司报销" },
  { id: "residence", source: ["03_住所专项", "住所支出.xlsx"], input: "住所支出.xlsx", canonical: "驻所支出.xlsx", category: "驻所报销" },
];

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
async function sha256File(filePath) { return sha256(await fs.readFile(filePath)); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }

async function makeScenario(root, selected) {
  const archive = path.join(root, "archive");
  await fs.mkdir(archive, { recursive: true });
  const baselines = [];
  for (const profile of selected) {
    const profileRoot = path.join(root, profile.id);
    await fs.mkdir(profileRoot);
    const destination = path.join(profileRoot, profile.input);
    await fs.copyFile(path.join(approvedRoot, ...profile.source), destination, fs.constants.COPYFILE_EXCL);
    const bytes = await fs.readFile(destination);
    baselines.push({ profileId: profile.id, path: destination, sha256: sha256(bytes), size: bytes.length, candidateRevision: 1 });
  }
  const imagePath = path.join(root, "evidence.png");
  await fs.writeFile(imagePath, png, { flag: "wx" });
  const transactions = selected.map((profile, index) => ({
    id: `TX-${profile.id}`,
    sourceOrder: index + 1,
    date: `2026-08-${String(20 + index).padStart(2, "0")}`,
    person: `脱敏人员${index + 1}`,
    project: `完整链路项目${index + 1}`,
    label: `脱敏人员${index + 1}`,
    classification: `完整链路分类${index + 1}`,
    amount: `${index + 1}.125`,
    category: profile.category,
    settlement: index === 1 ? "company_paid_no_reimbursement" : "employee_reimbursement",
    evidence: ["IMG-1"],
    sourceRefs: [`UNIT-${index + 1}`],
  }));
  const manifest = {
    version: 3,
    rulesVersion: "ordinary-reimbursement-workflow-integration-v1",
    batch: { batchId: `benchmark-${crypto.randomBytes(16).toString("hex")}`, rootPath: root, archivePath: archive, period: "2026-08-20—2026-08-22", targetCategory: selected[0].category, reviewRevision: 1 },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baselines[0].path, sha256: baselines[0].sha256 },
      { id: "IMG-1", role: "material", path: imagePath, sha256: sha256(png), kind: "image", disposition: "used" },
    ],
    sourceScopes: [{ id: "SCOPE-1", fileId: "IMG-1", locator: "full-image", terminalConfirmed: true, expectedUnitCount: selected.length }],
    sourceUnits: transactions.map((_, index) => ({ id: `UNIT-${index + 1}`, scopeId: "SCOPE-1", locator: `region-${index + 1}`, disposition: "used" })),
    transactions,
    expectedFeeTotal: transactions[0].amount,
    expectedRealTotal: transactions[0].amount,
    expectedCategoryTotals: Object.fromEntries(transactions.map((item) => [item.category, item.amount])),
  };
  const manifestPath = path.join(root, "batch-manifest.json");
  const manifestBody = jsonBytes(manifest);
  await fs.writeFile(manifestPath, manifestBody, { flag: "wx" });
  return { token: crypto.randomBytes(32).toString("hex"), archive, baselines, manifestPath, manifestSha256: sha256(manifestBody) };
}

async function runCli(scriptName, args, metricsPath) {
  const result = await runMeasuredProcess(node, ["--import", pathToFileURL(resourceHook).href, path.join(skillRoot, "scripts", scriptName), ...args], {
    cwd: skillRoot,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? "" , XHS_BENCHMARK_METRICS_PATH: metricsPath },
    metricsPath,
    timeoutMs: 180_000,
  });
  assert.equal(result.status, 0, `${scriptName}: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `${scriptName} did not return one JSON line.`);
  return { result, value: JSON.parse(lines[0]) };
}

async function runOne(profileSet, root) {
  const started = performance.now();
  const input = await makeScenario(root, profileSet);
  const preparedAt = performance.now();
  const prepareRequest = path.join(root, "prepare-request.json");
  const prepareBody = { kind: "ordinary-reimbursement-prepare-v1", stagingToken: input.token, manifestPath: input.manifestPath, manifestSha256: input.manifestSha256, baselines: input.baselines };
  await fs.writeFile(prepareRequest, jsonBytes(prepareBody), { flag: "wx" });
  const preparedRun = await runCli("run_reimbursement_workflow.mjs", ["--prepare", prepareRequest], path.join(root, "prepare-resource.json"));
  const gate1At = performance.now();
  const finalizeRequest = path.join(root, "finalize-request.json");
  const finalizeBody = { statePath: preparedRun.value.statePath, expectedGate1BindingDigest: preparedRun.value.gate1BindingDigest, approvalText: "本次报销通过无误" };
  await fs.writeFile(finalizeRequest, jsonBytes(finalizeBody), { flag: "wx" });
  const finalizedRun = await runCli("run_reimbursement_workflow.mjs", ["--finalize", finalizeRequest], path.join(root, "finalize-resource.json"));
  const gate2At = performance.now();
  const publishRequest = path.join(root, "publish-request.json");
  const publishBody = { statePath: finalizedRun.value.statePath, expectedGate1BindingDigest: preparedRun.value.gate1BindingDigest, gate1ApprovalText: "本次报销通过无误", expectedGate2BindingDigest: finalizedRun.value.gate2BindingDigest, gate2ApprovalText: "确认更新根目录支出总表" };
  await fs.writeFile(publishRequest, jsonBytes(publishBody), { flag: "wx" });
  const publishedRun = await runCli("run_reimbursement_workflow.mjs", ["--publish", publishRequest], path.join(root, "publish-resource.json"));
  const ended = performance.now();
  return {
    profileIds: profileSet.map((item) => item.id),
    profileCount: profileSet.length,
    inputPreparationMs: preparedAt - started,
    prepareToGate1Ms: gate1At - preparedAt,
    gate1ToGate2Ms: gate2At - gate1At,
    gate2PublishVerifyMs: ended - gate2At,
    totalMs: ended - started,
    stages: [preparedRun.result, finalizedRun.result, publishedRun.result].map(({ stdout, stderr, ...item }) => item),
    childMaxRssKilobytes: [preparedRun, finalizedRun, publishedRun].map((item) => item.result.resourceUsage?.maxRssKilobytes ?? null),
    previewEnginePeakWorkingSetBytes: preparedRun.value.previewEnginePeakWorkingSetBytes,
    publishedProfiles: publishedRun.value.affectedProfileIds,
  };
}

async function main() {
  const outputPath = path.resolve(process.argv[2] ?? path.join(worktree, "tests", "benchmark", "reimbursement-workflow-performance.json"));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-workflow-benchmark-"));
  const formalSets = [
    profiles.slice(0, 1),
    profiles.slice(1, 2),
    profiles.slice(2, 3),
    profiles.slice(0, 2),
    profiles,
  ];
  const results = [];
  const coldStarts = {};
  try {
    for (const [index, profileSet] of formalSets.entries()) {
      const set = profileSet.map((item) => item.id).join("+");
      coldStarts[set] = await runOne(profileSet, path.join(tempRoot, `warmup-${index}`));
      for (let run = 1; run <= 5; run += 1) {
        results.push({ set, run, ...(await runOne(profileSet, path.join(tempRoot, `formal-${index}-${run}`))) });
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const grouped = Object.groupBy(results, (item) => item.set);
  const summary = Object.fromEntries(Object.entries(grouped).map(([set, items]) => {
    const values = items.map((item) => item.totalMs).sort((left, right) => left - right);
    return [set, { runs: values.length, medianMs: values[Math.floor(values.length / 2)], slowestMs: values.at(-1), p95Ms: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)], stageMediansMs: Object.fromEntries(["inputPreparationMs", "prepareToGate1Ms", "gate1ToGate2Ms", "gate2PublishVerifyMs"].map((key) => { const stage = items.map((item) => item[key]).sort((a, b) => a - b); return [key, stage[Math.floor(stage.length / 2)]]; })), maxChildRssKilobytes: Math.max(...items.flatMap((item) => item.childMaxRssKilobytes.filter((value) => value !== null))), maxPreviewEngineWorkingSetBytes: Math.max(...items.map((item) => item.previewEnginePeakWorkingSetBytes)), }];
  }));
  const report = { kind: "ordinary-reimbursement-cli-performance-v1", generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, base: "f38a65b571a92e42ba57250e306d7b3534a4c26b", warmupsPerSet: 1, formalRunsPerSet: 5, humanWaitExcluded: true, renderingIncludedInPrepare: true, coldStarts, sets: summary, rawRuns: results };
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ outputPath, sets: summary })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
