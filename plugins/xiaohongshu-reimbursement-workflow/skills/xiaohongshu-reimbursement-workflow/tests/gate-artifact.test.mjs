import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalDigest,
  loadLedgerReorderGateArtifact,
  parseLedgerReorderGateArtifactCli,
  validateLedgerReorderGateArtifact,
} from "../scripts/build_ledger_reorder_gate_artifact.mjs";
import { validateLedgerReorderPreviewCoverage } from "../scripts/build_ledger_reorder_preview_index.mjs";
import { loadPlan } from "../scripts/ledger_reorder_common.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactHelper = path.join(skillRoot, "tests", "ledger-reorder-artifact-helper.mjs");
const buildScript = path.join(skillRoot, "scripts", "build_ledger_reorder_candidate.mjs");
const gateArtifactScript = path.join(skillRoot, "scripts", "build_ledger_reorder_gate_artifact.mjs");
const previewIndexScript = path.join(skillRoot, "scripts", "build_ledger_reorder_preview_index.mjs");
const generateScript = path.join(skillRoot, "scripts", "generate_ledger_reorder_plan.mjs");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function digest(label) {
  return sha256(Buffer.from(label, "utf8"));
}

function runJsonScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(lines.length, 1, `Expected exactly one JSON line; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(lines[0]) };
}

function runArtifactHelper(args) {
  const result = spawnSync(process.execPath, [artifactHelper, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  const payloads = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const payload = payloads.findLast((value) => value && typeof value === "object" && "ok" in value);
  assert.ok(payload, `Artifact helper returned no JSON result: ${result.stdout}\n${result.stderr}`);
  assert.equal(payload.ok, true, payload.error);
  return { status: result.status, payload };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

let cleanupRoot;
let stagingRoot;
let planPath;
let plan;
let previewIndexPath;

test.before(async () => {
  cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-gate-artifact-test-"));
  const token = crypto.randomBytes(12).toString("hex");
  const rootPath = path.join(cleanupRoot, "root");
  const archivePath = path.join(rootPath, "archive");
  stagingRoot = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await Promise.all([
    fs.mkdir(archivePath, { recursive: true }),
    fs.mkdir(stagingRoot),
  ]);
  await writeJson(path.join(stagingRoot, ".codex-xhs-owner.json"), {
    kind: "xiaohongshu-reimbursement-temp",
    version: 1,
    token,
  });

  const sourcePath = path.join(rootPath, "anonymous-baseline.xlsx");
  const candidatePath = path.join(stagingRoot, "anonymous-ledger_修正版1.xlsx");
  const activeCandidatePath = path.join(archivePath, "anonymous-ledger_修正版1.xlsx");
  const requestPath = path.join(stagingRoot, "request.json");
  planPath = path.join(stagingRoot, "plan.json");
  const created = runArtifactHelper(["create-block", sourcePath]);
  assert.equal(created.status, 0);
  await writeJson(requestPath, {
    version: 1,
    mode: "ledger-reorder-plan-request",
    rootPath,
    stagingRoot,
    stagingToken: token,
    sourcePath,
    outputPath: candidatePath,
    activeCandidatePath,
    targetPath: path.join(rootPath, "小红书支出总表.xlsx"),
    candidateRevision: 1,
    sheetName: "Ledger",
    physicalRange: "A2:F7",
    scopeStart: "2031-06-01",
    scopeStartInclusive: true,
    scopeEnd: "2031-07-30",
    scopeEndInclusive: true,
    dateColumn: "A",
    amountColumn: "C",
    recordDetection: "merge-connected-components",
  });
  const generated = runJsonScript(generateScript, ["--request", requestPath, "--out", planPath]);
  assert.equal(generated.status, 0, JSON.stringify(generated.payload));
  plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const built = runJsonScript(buildScript, ["--plan", planPath]);
  assert.equal(built.status, 0, JSON.stringify(built.payload));
  await fs.copyFile(plan.outputPath, plan.activeCandidatePath, fs.constants.COPYFILE_EXCL);

  previewIndexPath = path.join(stagingRoot, "preview-index.json");
});

test.after(async () => {
  if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
  if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
});

test("strict CLI rejects unknown, duplicate, and gate-inapplicable arguments", () => {
  const common = [
    "--gate", "gate-2",
    "--plan", path.resolve("anonymous-plan.json"),
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--out", path.resolve("anonymous-gate.json"),
  ];
  assert.throws(
    () => parseLedgerReorderGateArtifactCli([...common, "--unknown", "x"]),
    /Unknown command-line argument/,
  );
  assert.throws(
    () => parseLedgerReorderGateArtifactCli([...common, "--plan", path.resolve("duplicate.json")]),
    /Duplicate command-line argument --plan/,
  );
  assert.throws(
    () => parseLedgerReorderGateArtifactCli([...common, "--facts-digest", digest("facts")]),
    /not accepted for gate-2/,
  );
});

test("controlled preview index binds exact plan and active candidate bytes", async () => {
  const standaloneIndexPath = path.join(stagingRoot, "standalone-preview-index.json");
  const indexed = runJsonScript(previewIndexScript, [
    "--plan", planPath,
    "--candidate", plan.activeCandidatePath,
    "--out", standaloneIndexPath,
  ]);
  assert.equal(indexed.status, 0, JSON.stringify(indexed.payload));
  const index = JSON.parse(await fs.readFile(standaloneIndexPath, "utf8"));
  assert.deepEqual(Object.keys(index).sort(), [
    "candidatePath",
    "candidateSha256",
    "files",
    "kind",
    "planFileSha256",
    "version",
  ]);
  assert.equal(index.version, 2);
  assert.equal(index.planFileSha256, await sha256File(planPath));
  assert.equal(index.candidatePath, plan.activeCandidatePath);
  assert.equal(index.candidateSha256, await sha256File(plan.activeCandidatePath));
  assert.equal(index.files.length, 1);
  assert.equal(index.files[0].sheetName, "Ledger");
  assert.equal(index.files[0].range, "A2:F7");
  assert.equal(index.files[0].sha256, await sha256File(index.files[0].path));
  const validatedPlan = await loadPlan(planPath);
  validateLedgerReorderPreviewCoverage(validatedPlan, index.files);

  assert.throws(
    () => validateLedgerReorderPreviewCoverage(validatedPlan, [{
      ...index.files[0],
      range: "A2:F6",
    }]),
    /do not cover the final row/,
  );

  const externalPreviewPath = path.join(stagingRoot, "old-external-preview.png");
  runArtifactHelper(["verify-block", plan.activeCandidatePath, externalPreviewPath]);
  const externalOutput = path.join(stagingRoot, "external-injection-index.json");
  const externalRejected = runJsonScript(previewIndexScript, [
    "--plan", planPath,
    "--candidate", plan.activeCandidatePath,
    "--preview", externalPreviewPath,
    "--out", externalOutput,
  ]);
  assert.equal(externalRejected.status, 1);
  assert.match(externalRejected.payload.error, /Usage|Unknown command-line argument/);
  await assert.rejects(fs.access(externalOutput), /ENOENT/);

  const staleCandidatePath = path.join(stagingRoot, "anonymous-stale-candidate.xlsx");
  await fs.copyFile(plan.activeCandidatePath, staleCandidatePath, fs.constants.COPYFILE_EXCL);
  const rejectedOutput = path.join(stagingRoot, "stale-controlled-index.json");
  const rejected = runJsonScript(previewIndexScript, [
    "--plan", planPath,
    "--candidate", staleCandidatePath,
    "--out", rejectedOutput,
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.payload.error, /active candidate bound by the current plan/);
  await assert.rejects(fs.access(rejectedOutput), /ENOENT/);
});

test("Gate1 re-audits the active candidate and binds a verified preview index", async () => {
  const outputPath = path.join(stagingRoot, "gate-1-artifact.json");
  const built = runJsonScript(gateArtifactScript, [
    "--gate", "gate-1",
    "--plan", planPath,
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--facts-digest", digest("facts"),
    "--preview-index", previewIndexPath,
    "--out", outputPath,
  ]);
  assert.equal(built.status, 0, JSON.stringify(built.payload));
  assert.equal(built.payload.status, "gate_artifact_created");
  assert.equal(built.payload.context.candidatePath, plan.activeCandidatePath);
  assert.equal(built.payload.context.candidateRevision, 1);
  assert.equal(built.payload.context.planFileSha256, await sha256File(planPath));
  assert.equal(built.payload.context.candidateSha256, await sha256File(plan.activeCandidatePath));
  assert.equal(built.payload.previewIndex.path, previewIndexPath);
  assert.equal(built.payload.previewIndex.files.length, 1);

  const artifact = await loadLedgerReorderGateArtifact(outputPath);
  assert.equal(artifact.bindingDigest, built.payload.bindingDigest);
  assert.equal(artifact.digestPayload.audit.audit, "exhaustive");
  assert.equal(artifact.digestPayload.previewIndex.files.length, 1);
  const previewEntry = artifact.digestPayload.previewIndex.files[0];
  assert.equal(previewEntry.sheetName, "Ledger");
  assert.equal(previewEntry.range, "A2:F7");
  assert.equal(previewEntry.sha256, await sha256File(previewEntry.path));
  assert.equal(artifact.digestPayload.previewIndex.planFileSha256, await sha256File(planPath));
  assert.equal(artifact.digestPayload.previewIndex.candidatePath, plan.activeCandidatePath);
  assert.equal(
    artifact.digestPayload.previewIndex.candidateSha256,
    await sha256File(plan.activeCandidatePath),
  );
  assert.equal(artifact.context.reviewPackageDigest, canonicalDigest(artifact.digestPayload));

  const tampered = structuredClone(artifact);
  tampered.digestPayload.previewIndex.files[0].sha256 = digest("tampered-preview");
  assert.throws(() => validateLedgerReorderGateArtifact(tampered), /does not match digestPayload/);
});

test("Gate1 refuses a pre-existing or manually written preview index", async () => {
  const manualIndex = path.join(stagingRoot, "manual-preview-index.json");
  await writeJson(manualIndex, {
    version: 2,
    kind: "ledger-reorder-preview-index",
    planFileSha256: await sha256File(planPath),
    candidatePath: plan.activeCandidatePath,
    candidateSha256: await sha256File(plan.activeCandidatePath),
    files: [],
  });
  const outputPath = path.join(stagingRoot, "manual-gate-artifact.json");
  const rejected = runJsonScript(gateArtifactScript, [
    "--gate", "gate-1",
    "--plan", planPath,
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--facts-digest", digest("facts"),
    "--preview-index", manualIndex,
    "--out", outputPath,
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.payload.error, /output path already exists; refusing to overwrite/);
  await assert.rejects(fs.access(outputPath), /ENOENT/);
});

test("Gate1 rejects an old candidate preview index in the same staging root without reading it", async () => {
  const staleCandidatePath = path.join(stagingRoot, "anonymous-old-candidate.xlsx");
  await fs.copyFile(plan.activeCandidatePath, staleCandidatePath, fs.constants.COPYFILE_EXCL);
  const staleIndexPath = path.join(stagingRoot, "stale-preview-index.json");
  await writeJson(staleIndexPath, {
    version: 2,
    kind: "ledger-reorder-preview-index",
    planFileSha256: await sha256File(planPath),
    candidatePath: staleCandidatePath,
    candidateSha256: await sha256File(staleCandidatePath),
    files: [],
  });
  const outputPath = path.join(stagingRoot, "stale-preview-gate-artifact.json");
  const rejected = runJsonScript(gateArtifactScript, [
    "--gate", "gate-1",
    "--plan", planPath,
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--facts-digest", digest("facts"),
    "--preview-index", staleIndexPath,
    "--out", outputPath,
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.payload.error, /output path already exists; refusing to overwrite/);
  await assert.rejects(fs.access(outputPath), /ENOENT/);
});

test("Gate2 re-audits and mechanically binds the current baseline and candidate", async () => {
  const outputPath = path.join(stagingRoot, "gate-2-artifact.json");
  const built = runJsonScript(gateArtifactScript, [
    "--gate", "gate-2",
    "--plan", planPath,
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--out", outputPath,
  ]);
  assert.equal(built.status, 0, JSON.stringify(built.payload));
  const artifact = await loadLedgerReorderGateArtifact(outputPath);
  assert.equal(artifact.context.gate, "gate-2");
  assert.equal(artifact.context.baselinePath, plan.sourcePath);
  assert.equal(artifact.context.baselineSha256, await sha256File(plan.sourcePath));
  assert.equal(artifact.context.candidateSha256, await sha256File(plan.activeCandidatePath));
  assert.equal(artifact.digestPayload.audit.audit, "exhaustive");

  const second = runJsonScript(gateArtifactScript, [
    "--gate", "gate-2",
    "--plan", planPath,
    "--batch-id", "anonymous-batch",
    "--operation-digest", digest("operation"),
    "--out", outputPath,
  ]);
  assert.equal(second.status, 1);
  assert.match(second.payload.error, /already exists; refusing to overwrite/);
});
