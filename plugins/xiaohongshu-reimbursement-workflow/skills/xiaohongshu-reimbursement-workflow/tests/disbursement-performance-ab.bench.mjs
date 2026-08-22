#!/usr/bin/env node

/**
 * D-line benchmark: first complete, safe compact-disbursement implementation
 * versus a later implementation with the same frozen output contract.
 *
 * The benchmark owns runner import and the single archive-operation timing. A
 * separately hashed adapter only creates the production-representative fixture,
 * extracts canonical output
 * digests. Until a complete baseline tree and a frozen adapter fixture exist,
 * this file may be used for --identity-only or diagnostic runs, never acceptance.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateStrictPerformanceAcceptance,
  improvementPercent,
  pairedBootstrapImprovement,
  summarizeDistribution,
} from "../scripts/performance_statistics.mjs";
import {
  assertIdentityLock,
  assertUnchangedIdentity,
  inspectBenchmarkRoot,
} from "./workflow-performance-ab.bench.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const STATISTICS_PATH = path.join(SKILL_ROOT, "scripts", "performance_statistics.mjs");
const IDENTITY_HELPER_PATH = path.join(SKILL_ROOT, "tests", "workflow-performance-ab.bench.mjs");
const DEFAULT_SAMPLES = 11;
const DEFAULT_WARMUPS = 2;
const DEFAULT_THRESHOLD_PERCENT = 20;
const SHA_RE = /^[0-9a-f]{64}$/u;
const RUNNER_NAME = "run_compact_disbursement_workflow.mjs";
const REPORT_KIND = "compact-disbursement-performance-ab-v2";
const SAMPLE_KIND = "compact-disbursement-performance-sample-v2";
const FIXTURE_KIND = "compact-disbursement-performance-fixture-v2";
const ADAPTER_KIND = "compact-disbursement-performance-adapter-v2";
const SAFE_TEMP_PREFIX = "codex-xhs-disb-ab-";
const LOAD_SCALES = new Set(["small", "standard", "large"]);
const FINAL_SUMMARY_NAME = "发放情况说明.txt";
const FINAL_WORKBOOK_NAME = "发放核对表.xlsx";
const FINAL_VOUCHER_DIRECTORY_NAME = "发放凭证";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function round(value, digits = 3) {
  if (value === null || value === undefined) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(argv) {
  const result = {
    samples: DEFAULT_SAMPLES,
    warmups: DEFAULT_WARMUPS,
    threshold: DEFAULT_THRESHOLD_PERCENT,
    loadScale: "standard",
    diagnostic: false,
    identityOnly: false,
    baselineRoot: null,
    candidateRoot: null,
    adapter: null,
    adapterSha256: null,
    output: null,
  };
  for (const argument of argv) {
    if (argument === "--diagnostic") result.diagnostic = true;
    else if (argument === "--identity-only") result.identityOnly = true;
    else if (argument.startsWith("--samples=")) result.samples = Number(argument.slice(10));
    else if (argument.startsWith("--warmups=")) result.warmups = Number(argument.slice(10));
    else if (argument.startsWith("--threshold=")) result.threshold = Number(argument.slice(12));
    else if (argument.startsWith("--scale=")) result.loadScale = argument.slice(8).toLowerCase();
    else if (argument.startsWith("--baseline-root=")) result.baselineRoot = path.resolve(argument.slice(16));
    else if (argument.startsWith("--candidate-root=")) result.candidateRoot = path.resolve(argument.slice(17));
    else if (argument.startsWith("--adapter=")) result.adapter = path.resolve(argument.slice(10));
    else if (argument.startsWith("--adapter-sha256=")) result.adapterSha256 = argument.slice(17);
    else if (argument.startsWith("--output=")) result.output = path.resolve(argument.slice(9));
    else if (argument.startsWith("--baseline-version=")) result.baselineVersion = argument.slice(19);
    else if (argument.startsWith("--candidate-version=")) result.candidateVersion = argument.slice(20);
    else if (argument.startsWith("--baseline-skill-sha256=")) result.baselineSkillSha256 = argument.slice(24);
    else if (argument.startsWith("--candidate-skill-sha256=")) result.candidateSkillSha256 = argument.slice(25);
    else if (argument.startsWith("--baseline-package-sha256=")) result.baselinePackageSha256 = argument.slice(26);
    else if (argument.startsWith("--candidate-package-sha256=")) result.candidatePackageSha256 = argument.slice(27);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.baselineRoot || !result.candidateRoot) throw new Error("--baseline-root and --candidate-root are required");
  if (!LOAD_SCALES.has(result.loadScale)) throw new Error("--scale must be small, standard, or large");
  if (!Number.isSafeInteger(result.samples) || result.samples < 1) throw new Error("--samples must be a positive integer");
  if (!Number.isSafeInteger(result.warmups) || result.warmups < 0) throw new Error("--warmups must be a non-negative integer");
  if (!Number.isFinite(result.threshold) || result.threshold < 0 || result.threshold > 100) throw new Error("--threshold must be between 0 and 100");
  if (!result.diagnostic && !result.identityOnly && result.samples < DEFAULT_SAMPLES) throw new Error("D acceptance requires at least 11 timed pairs per temperature");
  if (!result.diagnostic && !result.identityOnly && result.warmups < DEFAULT_WARMUPS) throw new Error("D acceptance requires at least two untimed warm-ups per side and temperature");
  if (!result.identityOnly && !result.adapter) throw new Error("--adapter is required for D measurement");
  if (result.adapterSha256 !== null && !result.adapter) throw new Error("--adapter-sha256 requires --adapter");
  if (result.adapterSha256 !== null && !SHA_RE.test(result.adapterSha256)) throw new Error("adapterSha256 must be a lowercase SHA-256 digest");
  const identityFields = ["baselineVersion", "candidateVersion", "baselineSkillSha256", "candidateSkillSha256", "baselinePackageSha256", "candidatePackageSha256"];
  const identityCount = identityFields.filter((field) => result[field] !== undefined).length;
  if (identityCount !== 0 && identityCount !== identityFields.length) throw new Error("D identity lock requires both versions and all four tree digests");
  for (const field of identityFields.filter((name) => name.endsWith("Sha256"))) {
    if (result[field] !== undefined && !SHA_RE.test(result[field])) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
  if (!result.diagnostic && !result.identityOnly && identityCount !== identityFields.length) throw new Error("D acceptance requires an explicit six-field identity lock");
  if (!result.diagnostic && !result.identityOnly && result.adapterSha256 === null) throw new Error("D acceptance requires an explicit adapter SHA-256 identity lock");
  result.identityLock = identityCount === identityFields.length ? {
    source: "explicit-cli",
    baseline: { version: result.baselineVersion, skillTreeSha256: result.baselineSkillSha256, packageTreeSha256: result.baselinePackageSha256 },
    candidate: { version: result.candidateVersion, skillTreeSha256: result.candidateSkillSha256, packageTreeSha256: result.candidatePackageSha256 },
  } : null;
  return result;
}

export const parseDisbursementBenchmarkArgs = parseArgs;

function workerArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(3).find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`worker is missing ${prefix}`);
  return value.slice(prefix.length);
}

async function fileIdentity(filePath) {
  const canonicalPath = await fs.realpath(filePath);
  const bytes = await fs.readFile(canonicalPath);
  return { canonicalPath, sha256: sha256(bytes), size: bytes.length };
}

async function harnessIdentity(adapterPath) {
  const [benchmark, statistics, identityHelper, adapter] = await Promise.all([
    fileIdentity(SCRIPT_PATH),
    fileIdentity(STATISTICS_PATH),
    fileIdentity(IDENTITY_HELPER_PATH),
    adapterPath ? fileIdentity(adapterPath) : null,
  ]);
  const files = { benchmark, statistics, identityHelper, adapter };
  return { kind: "compact-disbursement-performance-harness-v1", files, digest: sha256(Buffer.from(JSON.stringify(files), "utf8")) };
}

function observeOperation(operation) {
  const rssStartBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssStartBytes;
  let sampleCount = 1;
  const usageStart = process.resourceUsage();
  const cpuStart = process.cpuUsage();
  const timer = setInterval(() => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    sampleCount += 1;
  }, 5);
  timer.unref();
  const started = performance.now();
  return Promise.resolve().then(operation).then(
    (value) => finish(value, null),
    (error) => finish(undefined, error),
  );
  function finish(value, error) {
    const elapsedMs = performance.now() - started;
    clearInterval(timer);
    const rssEndBytes = process.memoryUsage().rss;
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, rssEndBytes);
    const usageEnd = process.resourceUsage();
    const cpu = process.cpuUsage(cpuStart);
    const metrics = {
      measurement: "benchmark-worker-node-process-resource-observation-v1",
      rssScope: "benchmark-worker-node-process-only",
      elapsedMs,
      rssStartBytes,
      rssEndBytes,
      sampledPeakRssBytes,
      rssSampleCount: sampleCount + 1,
      cpuUserMicroseconds: cpu.user,
      cpuSystemMicroseconds: cpu.system,
      fsReadOperations: usageEnd.fsRead - usageStart.fsRead,
      fsWriteOperations: usageEnd.fsWrite - usageStart.fsWrite,
    };
    if (error) throw error;
    return { value, metrics };
  }
}

function mergeResources(parts) {
  const sum = (field) => parts.reduce((total, item) => total + item[field], 0);
  return {
    measurement: "benchmark-worker-node-process-resource-observation-v1",
    rssScope: "benchmark-worker-node-process-only",
    rssStartBytes: parts[0].rssStartBytes,
    rssEndBytes: parts.at(-1).rssEndBytes,
    sampledPeakRssBytes: Math.max(...parts.map((item) => item.sampledPeakRssBytes)),
    rssSampleCount: sum("rssSampleCount"),
    cpuUserMicroseconds: sum("cpuUserMicroseconds"),
    cpuSystemMicroseconds: sum("cpuSystemMicroseconds"),
    fsReadOperations: sum("fsReadOperations"),
    fsWriteOperations: sum("fsWriteOperations"),
    ioBytes: null,
    ioBytesReason: "portable process I/O byte counters are unavailable in Node; operation counts are measured",
    externalProcessRssBoundary: {
      childReimbursementManifestAuditor: {
        timingIncluded: true,
        includedInWorkerRss: false,
        reason: "The reimbursement manifest auditor is a child Node process and cannot be included in parent process.memoryUsage RSS.",
      },
      comRenderer: {
        applicable: false,
        includedInWorkerRss: false,
        reason: "The compact-disbursement runner does not invoke Excel/PowerShell COM.",
      },
    },
  };
}

async function loadRunner(root, tag) {
  const entry = pathToFileURL(path.join(root, "scripts", RUNNER_NAME));
  entry.searchParams.set("disbursement-benchmark", tag);
  const module = await import(entry.href);
  for (const name of ["archiveCompactDisbursementWorkflow"]) {
    if (typeof module[name] !== "function") throw new Error(`D runner is missing export ${name}`);
  }
  return module;
}

async function loadAdapter(adapterPath, tag) {
  const entry = pathToFileURL(adapterPath);
  entry.searchParams.set("disbursement-benchmark", tag);
  const module = await import(entry.href);
  if (module.DISBURSEMENT_PERFORMANCE_ADAPTER_KIND !== ADAPTER_KIND) throw new Error("D adapter kind is invalid");
  for (const name of ["createDisbursementPerformanceFixture", "openDisbursementPerformanceSample"]) {
    if (typeof module[name] !== "function") throw new Error(`D adapter is missing export ${name}`);
  }
  return module;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) throw new Error(`${field} fields are not exact`);
}

function normalizedPublishedFile(value, field, expectedName = null) {
  exactKeys(value, ["name", "type", "sha256", "size"], field);
  if (value.type !== "file") throw new Error(`${field}.type must be file`);
  if (typeof value.name !== "string" || !value.name || value.name.includes("/") || value.name.includes("\\")) throw new Error(`${field}.name is unsafe`);
  if (expectedName !== null && value.name !== expectedName) throw new Error(`${field}.name must be ${expectedName}`);
  if (!SHA_RE.test(value.sha256)) throw new Error(`${field}.sha256 is not SHA-256`);
  if (!Number.isSafeInteger(value.size) || value.size < 0) throw new Error(`${field}.size must be a non-negative safe integer`);
  return Object.freeze({ name: value.name, type: "file", sha256: value.sha256, size: value.size });
}

function normalizeFinalArchive(value) {
  exactKeys(value, ["entries"], "D finalArchive");
  if (!Array.isArray(value.entries) || value.entries.length !== 3) throw new Error("D finalArchive must contain exactly three root entries");
  const byName = new Map();
  for (const entry of value.entries) {
    if (!entry || typeof entry.name !== "string" || byName.has(entry.name)) throw new Error("D finalArchive root entry names must be unique");
    byName.set(entry.name, entry);
  }
  const summary = normalizedPublishedFile(byName.get(FINAL_SUMMARY_NAME), "D finalArchive summary", FINAL_SUMMARY_NAME);
  const workbook = normalizedPublishedFile(byName.get(FINAL_WORKBOOK_NAME), "D finalArchive workbook", FINAL_WORKBOOK_NAME);
  const voucherDirectory = byName.get(FINAL_VOUCHER_DIRECTORY_NAME);
  exactKeys(voucherDirectory, ["name", "type", "entries"], "D finalArchive voucher directory");
  if (voucherDirectory.name !== FINAL_VOUCHER_DIRECTORY_NAME || voucherDirectory.type !== "directory" || !Array.isArray(voucherDirectory.entries)) {
    throw new Error("D finalArchive voucher directory is invalid");
  }
  const vouchers = voucherDirectory.entries.map((entry, index) => normalizedPublishedFile(entry, `D finalArchive voucher[${index}]`));
  vouchers.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(vouchers.map((entry) => process.platform === "win32" ? entry.name.toLowerCase() : entry.name)).size !== vouchers.length) {
    throw new Error("D finalArchive voucher names must be unique");
  }
  return Object.freeze({
    entries: Object.freeze([
      summary,
      workbook,
      Object.freeze({ name: FINAL_VOUCHER_DIRECTORY_NAME, type: "directory", entries: Object.freeze(vouchers) }),
    ]),
  });
}

function digestJson(value) {
  return sha256(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function snapshotActualPublishedFile(filePath, name, field) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${field} is not a plain regular file`);
  const bytes = await fs.readFile(filePath);
  const after = await fs.lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error(`${field} changed while the D harness read it`);
  }
  return Object.freeze({ name, type: "file", sha256: sha256(bytes), size: bytes.length });
}

async function snapshotActualFinalArchive(finalArchivePath, runRoot) {
  const resolved = path.resolve(finalArchivePath);
  if (!within(runRoot, resolved)) throw new Error("D published final archive resolves outside its isolated run root");
  const rootStats = await fs.lstat(resolved);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("D published final archive is not a plain directory");
  const rootEntries = await fs.readdir(resolved, { withFileTypes: true });
  if (rootEntries.length !== 3 || rootEntries.some((entry) => entry.isSymbolicLink())) throw new Error("D published final archive must have exactly three plain root entries");
  const rootByName = new Map(rootEntries.map((entry) => [entry.name, entry]));
  if (!rootByName.get(FINAL_SUMMARY_NAME)?.isFile() || !rootByName.get(FINAL_WORKBOOK_NAME)?.isFile() || !rootByName.get(FINAL_VOUCHER_DIRECTORY_NAME)?.isDirectory()) {
    throw new Error("D published final archive root entry names or types are invalid");
  }
  const voucherRoot = path.join(resolved, FINAL_VOUCHER_DIRECTORY_NAME);
  const voucherStats = await fs.lstat(voucherRoot);
  if (!voucherStats.isDirectory() || voucherStats.isSymbolicLink()) throw new Error("D published voucher entry is not a plain directory");
  const voucherEntries = await fs.readdir(voucherRoot, { withFileTypes: true });
  const seenNames = new Set();
  const vouchers = [];
  for (const entry of voucherEntries) {
    const key = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    if (!entry.isFile() || entry.isSymbolicLink() || seenNames.has(key)) throw new Error("D published voucher directory contains an invalid entry");
    seenNames.add(key);
    vouchers.push(await snapshotActualPublishedFile(path.join(voucherRoot, entry.name), entry.name, `D published voucher ${entry.name}`));
  }
  vouchers.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    entries: Object.freeze([
      await snapshotActualPublishedFile(path.join(resolved, FINAL_SUMMARY_NAME), FINAL_SUMMARY_NAME, "D published summary"),
      await snapshotActualPublishedFile(path.join(resolved, FINAL_WORKBOOK_NAME), FINAL_WORKBOOK_NAME, "D published workbook"),
      Object.freeze({ name: FINAL_VOUCHER_DIRECTORY_NAME, type: "directory", entries: Object.freeze(vouchers) }),
    ]),
  });
}

export function buildDisbursementOutputContract({ businessDigest, finalArchive } = {}) {
  if (!SHA_RE.test(businessDigest)) throw new Error("D output contract businessDigest is not SHA-256");
  const normalizedArchive = normalizeFinalArchive(finalArchive);
  const [summary, workbook, voucherDirectory] = normalizedArchive.entries;
  const artifacts = { summary, workbook, vouchers: voucherDirectory.entries };
  const shape = {
    rootEntries: normalizedArchive.entries.map((entry) => entry.type === "directory"
      ? { name: entry.name, type: entry.type, entries: entry.entries.map((child) => ({ name: child.name, type: child.type })) }
      : { name: entry.name, type: entry.type }),
  };
  return Object.freeze({
    businessDigest,
    publishedArtifactDigest: digestJson({ kind: "compact-disbursement-published-artifacts-v1", artifacts }),
    finalShapeDigest: digestJson({ kind: "compact-disbursement-final-three-shape-v1", shape }),
    finalArchive: normalizedArchive,
  });
}

export function assertDisbursementOutputContract(value) {
  exactKeys(value, ["businessDigest", "publishedArtifactDigest", "finalShapeDigest", "finalArchive"], "D output contract");
  const rebuilt = buildDisbursementOutputContract(value);
  if (value.publishedArtifactDigest !== rebuilt.publishedArtifactDigest) throw new Error("D output contract publishedArtifactDigest does not bind the final published files");
  if (value.finalShapeDigest !== rebuilt.finalShapeDigest) throw new Error("D output contract finalShapeDigest does not bind exactly the final three root entries");
  return rebuilt;
}

async function safeRemoveRunRoot(benchmarkRoot, runRoot) {
  if (!within(benchmarkRoot, runRoot) || !path.basename(runRoot).startsWith("run-")) throw new Error(`refusing to remove unbound D run root: ${runRoot}`);
  await fs.rm(runRoot, { recursive: true, force: true });
}

async function runSample({ benchmarkRoot, fixturePath, adapterPath, side, root, round: sampleRound, temperature, runnerModule }) {
  const runRoot = path.join(benchmarkRoot, `run-${temperature[0]}-${sampleRound}-${side[0]}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(runRoot, { recursive: false });
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = runRoot;
  process.env.TMP = runRoot;
  let plan;
  try {
    const adapter = await loadAdapter(adapterPath, `${temperature}-${sampleRound}-${side}`);
    plan = await adapter.openDisbursementPerformanceSample({ fixturePath, runRoot, side, root, round: sampleRound, temperature });
    if (!plan || typeof plan !== "object" || typeof plan.extractOutputContract !== "function") {
      throw new Error("D adapter sample plan is incomplete");
    }
    let module = runnerModule;
    let importMs = 0;
    const resources = [];
    if (!module) {
      const measured = await observeOperation(() => loadRunner(root, `${temperature}-${sampleRound}-${side}`));
      module = measured.value;
      importMs = measured.metrics.elapsedMs;
      resources.push(measured.metrics);
    }
    const archive = await observeOperation(() => module.archiveCompactDisbursementWorkflow(plan.archiveRequest));
    resources.push(archive.metrics);
    const outputStarted = performance.now();
    const adapterOutputContract = assertDisbursementOutputContract(await plan.extractOutputContract({ receipt: archive.value }));
    const receiptArchivePath = archive.value?.finalArchivePath;
    if (typeof receiptArchivePath !== "string" || !path.isAbsolute(receiptArchivePath)) throw new Error("D archive receipt has no absolute finalArchivePath");
    const outputContract = buildDisbursementOutputContract({
      businessDigest: adapterOutputContract.businessDigest,
      finalArchive: await snapshotActualFinalArchive(receiptArchivePath, runRoot),
    });
    if (digestJson(outputContract) !== digestJson(adapterOutputContract)) {
      throw new Error("D adapter output contract differs from the harness-owned published archive snapshot");
    }
    const excludedOutputContractMs = performance.now() - outputStarted;
    return {
      kind: SAMPLE_KIND,
      side,
      round: sampleRound,
      temperature,
      importMs,
      archiveMs: archive.metrics.elapsedMs,
      totalPluginMs: importMs + archive.metrics.elapsedMs,
      excludedOutputContractMs,
      resources: mergeResources(resources),
      outputContract,
      runnerMetrics: {
        receipt: archive.value?.metrics ?? null,
      },
    };
  } finally {
    try {
      if (plan?.cleanup) await plan.cleanup();
    } finally {
      process.env.TEMP = priorTemp;
      process.env.TMP = priorTmp;
      await safeRemoveRunRoot(benchmarkRoot, runRoot);
    }
  }
}

function sampleOrder(count) {
  const result = [];
  for (let roundIndex = 0; roundIndex < count; roundIndex += 1) {
    for (const side of roundIndex % 2 === 0 ? ["candidate", "baseline"] : ["baseline", "candidate"]) result.push({ side, round: roundIndex });
  }
  return result;
}

async function workerOne() {
  const benchmarkRoot = path.resolve(workerArg("benchmark-root"));
  const fixturePath = path.resolve(workerArg("fixture"));
  const adapterPath = path.resolve(workerArg("adapter"));
  const side = workerArg("side");
  const root = path.resolve(workerArg("root"));
  const roundValue = Number(workerArg("round"));
  if (!new Set(["baseline", "candidate"]).has(side) || !Number.isSafeInteger(roundValue)) throw new Error("D cold worker arguments are invalid");
  const sample = await runSample({ benchmarkRoot, fixturePath, adapterPath, side, root, round: roundValue, temperature: "cold", runnerModule: null });
  process.stdout.write(`${JSON.stringify(sample)}\n`);
}

async function workerHot() {
  const benchmarkRoot = path.resolve(workerArg("benchmark-root"));
  const fixturePath = path.resolve(workerArg("fixture"));
  const adapterPath = path.resolve(workerArg("adapter"));
  const baselineRoot = path.resolve(workerArg("baseline-root"));
  const candidateRoot = path.resolve(workerArg("candidate-root"));
  const samples = Number(workerArg("samples"));
  const warmups = Number(workerArg("warmups"));
  const modules = {
    baseline: await loadRunner(baselineRoot, "hot-baseline"),
    candidate: await loadRunner(candidateRoot, "hot-candidate"),
  };
  const roots = { baseline: baselineRoot, candidate: candidateRoot };
  for (const item of sampleOrder(warmups)) await runSample({ benchmarkRoot, fixturePath, adapterPath, ...item, round: item.round - warmups, root: roots[item.side], temperature: "hot", runnerModule: modules[item.side] });
  const results = [];
  for (const item of sampleOrder(samples)) results.push(await runSample({ benchmarkRoot, fixturePath, adapterPath, ...item, root: roots[item.side], temperature: "hot", runnerModule: modules[item.side] }));
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

function spawnJson(args, timeoutMs = 20 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`D worker timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) return reject(new Error(`D worker failed (${code ?? signal}): ${stderr || stdout}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(new Error(`D worker emitted invalid JSON: ${stdout}`, { cause: error })); }
    });
  });
}

function distribution(values) {
  return Object.fromEntries(Object.entries(summarizeDistribution(values)).map(([key, value]) => [key, round(value)]));
}

function pairField(samples, field) {
  const pairs = new Map();
  for (const sample of samples) {
    if (!sample || !new Set(["baseline", "candidate"]).has(sample.side) || !Number.isSafeInteger(sample.round)) throw new Error("D sample side/round is invalid");
    const pair = pairs.get(sample.round) ?? {};
    if (pair[sample.side]) throw new Error(`D duplicate ${sample.side} sample for round ${sample.round}`);
    pair[sample.side] = sample;
    pairs.set(sample.round, pair);
  }
  const ordered = [...pairs.entries()].sort(([left], [right]) => left - right);
  for (const [sampleRound, pair] of ordered) if (!pair.baseline || !pair.candidate) throw new Error(`D round ${sampleRound} is incomplete`);
  return {
    baseline: ordered.map(([, pair]) => pair.baseline[field]),
    candidate: ordered.map(([, pair]) => pair.candidate[field]),
  };
}

export function summarizeDisbursementPerformanceSamples(samples, temperature, threshold, acceptance) {
  const paired = pairField(samples, "totalPluginMs");
  const baseline = summarizeDistribution(paired.baseline);
  const candidate = summarizeDistribution(paired.candidate);
  const unavailable = { method: "unavailable", pairCount: paired.baseline.length, reason: "at least two timed pairs are required", pointEstimatePercent: null, lowerPercent: null, upperPercent: null };
  const p50 = paired.baseline.length >= 2
    ? pairedBootstrapImprovement({ baseline: paired.baseline, candidate: paired.candidate, probability: 0.5, seedMaterial: `D:${temperature}:p50` })
    : unavailable;
  const p95 = paired.baseline.length >= 2
    ? pairedBootstrapImprovement({ baseline: paired.baseline, candidate: paired.candidate, probability: 0.95, seedMaterial: `D:${temperature}:p95` })
    : unavailable;
  const baselineSamples = samples.filter((sample) => sample.side === "baseline");
  const candidateSamples = samples.filter((sample) => sample.side === "candidate");
  const peakBaseline = summarizeDistribution(baselineSamples.map((sample) => sample.resources.sampledPeakRssBytes));
  const peakCandidate = summarizeDistribution(candidateSamples.map((sample) => sample.resources.sampledPeakRssBytes));
  const outputPairs = pairField(samples, "outputContract");
  const baselineOutputDigests = outputPairs.baseline.map((value) => digestJson(assertDisbursementOutputContract(value)));
  const candidateOutputDigests = outputPairs.candidate.map((value) => digestJson(assertDisbursementOutputContract(value)));
  const outputEquivalent = baselineOutputDigests.every((digest, index) => digest === candidateOutputDigests[index])
    && new Set(baselineOutputDigests).size === 1
    && new Set(candidateOutputDigests).size === 1;
  const p50Improvement = improvementPercent(baseline.p50, candidate.p50);
  const p95Improvement = improvementPercent(baseline.p95, candidate.p95);
  const rssRegression = ((peakCandidate.p50 - peakBaseline.p50) / peakBaseline.p50) * 100;
  const strict = evaluateStrictPerformanceAcceptance({
    thresholdPercent: threshold,
    p50ImprovementPercent: p50Improvement,
    p50BootstrapLowerPercent: Number.isFinite(p50.lowerPercent) ? p50.lowerPercent : -Number.MAX_VALUE,
    p95ImprovementPercent: p95Improvement,
    peakRssRegressionPercent: rssRegression,
    outputEquivalent,
  });
  const criteria = strict.criteria;
  const wouldPass = strict.passed;
  const phaseFields = ["importMs", "archiveMs", "totalPluginMs", "excludedOutputContractMs"];
  const resourceFields = ["sampledPeakRssBytes", "cpuUserMicroseconds", "cpuSystemMicroseconds", "fsReadOperations", "fsWriteOperations"];
  const phasesFor = (sideSamples) => Object.fromEntries(phaseFields.map((field) => [field, distribution(sideSamples.map((sample) => sample[field]))]));
  const resourcesFor = (sideSamples) => Object.fromEntries(resourceFields.map((field) => [field, distribution(sideSamples.map((sample) => sample.resources[field]))]));
  return {
    sampleCountPerSide: paired.baseline.length,
    baseline: distribution(paired.baseline),
    candidate: distribution(paired.candidate),
    p50ImprovementPercent: round(p50Improvement),
    p95ImprovementPercent: round(p95Improvement),
    pairedBootstrap95: {
      p50: Object.fromEntries(Object.entries(p50).map(([key, value]) => [key, typeof value === "number" ? round(value) : value])),
      p95: Object.fromEntries(Object.entries(p95).map(([key, value]) => [key, typeof value === "number" ? round(value) : value])),
    },
    peakRss: { baseline: distribution(baselineSamples.map((sample) => sample.resources.sampledPeakRssBytes)), candidate: distribution(candidateSamples.map((sample) => sample.resources.sampledPeakRssBytes)), regressionPercent: round(rssRegression) },
    phases: { baseline: phasesFor(baselineSamples), candidate: phasesFor(candidateSamples) },
    resources: { baseline: resourcesFor(baselineSamples), candidate: resourcesFor(candidateSamples) },
    outputEquivalent,
    criteria,
    improvementTargetMet: strict.improvementTargetMet,
    safeguardsPassed: strict.safeguardsPassed,
    acceptancePassed: acceptance ? wouldPass : null,
    diagnosticWouldPassConfiguredCriteria: acceptance ? null : strict.improvementTargetMet && wouldPass,
    diagnosticWouldPassSafeguards: acceptance ? null : wouldPass,
  };
}

async function writeAtomic(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootsBefore = {
    baseline: await inspectBenchmarkRoot(options.baselineRoot),
    candidate: await inspectBenchmarkRoot(options.candidateRoot),
  };
  if (samePath(rootsBefore.baseline.canonicalSkillRoot, rootsBefore.candidate.canonicalSkillRoot)) throw new Error("D baseline and candidate resolve to the same tree");
  for (const identity of Object.values(rootsBefore)) {
    const runner = await fs.stat(path.join(identity.canonicalSkillRoot, "scripts", RUNNER_NAME));
    if (!runner.isFile()) throw new Error(`D runner is missing from ${identity.canonicalSkillRoot}`);
  }
  if (options.identityLock) {
    assertIdentityLock(rootsBefore.baseline, options.identityLock.baseline, "D baseline");
    assertIdentityLock(rootsBefore.candidate, options.identityLock.candidate, "D candidate");
  }
  const harnessBefore = await harnessIdentity(options.adapter);
  if (options.adapterSha256 !== null && harnessBefore.files.adapter?.sha256 !== options.adapterSha256) {
    throw new Error(`D adapter SHA-256 differs from the explicit identity lock: expected ${options.adapterSha256}, observed ${harnessBefore.files.adapter?.sha256 ?? "missing"}`);
  }
  if (!options.diagnostic && !options.identityOnly && !within(rootsBefore.candidate.canonicalSkillRoot, harnessBefore.files.adapter.canonicalPath)) {
    throw new Error("D acceptance adapter must be inside the explicitly locked candidate skill tree");
  }
  if (options.identityOnly) {
    process.stdout.write(`${JSON.stringify({
      kind: "compact-disbursement-performance-identity-v1",
      roots: rootsBefore,
      harness: harnessBefore,
      acceptanceCliLock: {
        baselineVersion: rootsBefore.baseline.version,
        candidateVersion: rootsBefore.candidate.version,
        baselineSkillSha256: rootsBefore.baseline.skillTreeSha256,
        candidateSkillSha256: rootsBefore.candidate.skillTreeSha256,
        baselinePackageSha256: rootsBefore.baseline.packageTreeSha256,
        candidatePackageSha256: rootsBefore.candidate.packageTreeSha256,
        adapterSha256: harnessBefore.files.adapter?.sha256 ?? null,
      },
    }, null, 2)}\n`);
    return;
  }
  const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), SAFE_TEMP_PREFIX));
  try {
    const adapter = await loadAdapter(options.adapter, "fixture");
    const fixture = await adapter.createDisbursementPerformanceFixture({ benchmarkRoot, loadScale: options.loadScale, roots: rootsBefore });
    if (!fixture || fixture.kind !== FIXTURE_KIND || fixture.loadScale !== options.loadScale || fixture.productionRepresentative !== true || fixture.outputContractFrozen !== true) {
      throw new Error("D fixture is not a frozen production-representative fixture");
    }
    const fixturePath = path.resolve(fixture.metadataPath);
    if (!within(benchmarkRoot, fixturePath) || !SHA_RE.test(fixture.metadataSha256)) throw new Error("D fixture metadata binding is unsafe or invalid");
    const fixtureBefore = await fileIdentity(fixturePath);
    if (!within(benchmarkRoot, fixtureBefore.canonicalPath)) throw new Error("D fixture metadata resolves outside the benchmark root");
    if (fixtureBefore.sha256 !== fixture.metadataSha256) throw new Error("D fixture metadata SHA differs from its declaration");
    const roots = { baseline: rootsBefore.baseline.canonicalSkillRoot, candidate: rootsBefore.candidate.canonicalSkillRoot };
    for (const item of sampleOrder(options.warmups)) {
      await spawnJson(["--worker-one", `--benchmark-root=${benchmarkRoot}`, `--fixture=${fixturePath}`, `--adapter=${options.adapter}`, `--side=${item.side}`, `--root=${roots[item.side]}`, `--round=${item.round - options.warmups}`]);
    }
    const cold = [];
    for (const item of sampleOrder(options.samples)) {
      cold.push(await spawnJson(["--worker-one", `--benchmark-root=${benchmarkRoot}`, `--fixture=${fixturePath}`, `--adapter=${options.adapter}`, `--side=${item.side}`, `--root=${roots[item.side]}`, `--round=${item.round}`]));
    }
    const hot = await spawnJson(["--worker-hot", `--benchmark-root=${benchmarkRoot}`, `--fixture=${fixturePath}`, `--adapter=${options.adapter}`, `--baseline-root=${roots.baseline}`, `--candidate-root=${roots.candidate}`, `--samples=${options.samples}`, `--warmups=${options.warmups}`], 40 * 60_000);
    const rootsAfter = {
      baseline: await inspectBenchmarkRoot(options.baselineRoot),
      candidate: await inspectBenchmarkRoot(options.candidateRoot),
    };
    assertUnchangedIdentity(rootsBefore.baseline, rootsAfter.baseline, "D baseline");
    assertUnchangedIdentity(rootsBefore.candidate, rootsAfter.candidate, "D candidate");
    const [harnessAfter, fixtureAfter] = await Promise.all([harnessIdentity(options.adapter), fileIdentity(fixturePath)]);
    if (harnessBefore.digest !== harnessAfter.digest || fixtureBefore.sha256 !== fixtureAfter.sha256) throw new Error("D harness or fixture changed during measurement");
    const acceptance = !options.diagnostic;
    const coldSummary = summarizeDisbursementPerformanceSamples(cold, "cold", options.threshold, acceptance);
    const hotSummary = summarizeDisbursementPerformanceSamples(hot, "hot", options.threshold, acceptance);
    const acceptancePassed = acceptance ? coldSummary.acceptancePassed === true && hotSummary.acceptancePassed === true : null;
    const report = {
      kind: REPORT_KIND,
      generatedAt: new Date().toISOString(),
      acceptance,
      benchmarkLine: "D",
      loadScale: options.loadScale,
      protocol: {
        baselineDefinition: "first complete safe no-human-gate single-archive compact-disbursement implementation",
        identityLock: options.identityLock ?? { source: "observed-diagnostic-only" },
        adapterIdentityLock: options.adapterSha256 === null
          ? { source: "observed-diagnostic-only", sha256: harnessBefore.files.adapter.sha256 }
          : { source: "explicit-cli", sha256: options.adapterSha256 },
        rootsBefore,
        rootsAfter,
        harnessBefore,
        harnessAfter,
        fixture: { ...fixture, metadataPath: fixturePath, observedMetadataSha256: fixtureAfter.sha256 },
        samplesPerSidePerTemperature: options.samples,
        untimedWarmupsPerSidePerTemperature: options.warmups,
        thresholdPercent: options.threshold,
        improvementTargetIsInformational: true,
        cold: "fresh Node process; runner import + one complete archive operation timed; Windows file cache not flushed",
        hot: "both runners imported before timing; one complete archive operation timed in one process",
        excluded: ["fixture creation", "output-contract extraction", "warm-ups"],
        outputEquivalence: "adapter must expose the actual published summary/workbook/voucher bindings and exactly the three final root entries; the harness recomputes artifact and shape digests",
        resourceMeasurement: {
          rss: "5 ms user-space sampling of the benchmark worker Node process; the 15% ceiling is enforced independently for both cold and hot summaries",
          childReimbursementManifestAuditor: "timing is included, but child-process RSS is outside parent process.memoryUsage and is explicitly excluded",
          comRenderer: "not applicable: compact disbursement does not invoke Excel/PowerShell COM",
          io: "process.resourceUsage filesystem operation deltas; portable per-process byte counters are unavailable and reported as null",
        },
      },
      environment: { node: process.version, nodeExecPath: process.execPath, platform: process.platform, arch: process.arch, osRelease: os.release(), cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem() },
      summaries: { cold: coldSummary, hot: hotSummary },
      acceptancePassed,
      diagnosticWouldPassConfiguredCriteria: acceptance ? null : coldSummary.diagnosticWouldPassConfiguredCriteria === true && hotSummary.diagnosticWouldPassConfiguredCriteria === true,
      diagnosticWouldPassSafeguards: acceptance ? null : coldSummary.diagnosticWouldPassSafeguards === true && hotSummary.diagnosticWouldPassSafeguards === true,
      rawSamples: { cold, hot },
    };
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (options.output) await writeAtomic(options.output, bytes);
    process.stdout.write(bytes);
    if (acceptance && !acceptancePassed) process.exitCode = 2;
  } finally {
    if (!path.basename(benchmarkRoot).startsWith(SAFE_TEMP_PREFIX)) throw new Error(`refusing to remove unsafe D benchmark root: ${benchmarkRoot}`);
    await fs.rm(benchmarkRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && samePath(process.argv[1], SCRIPT_PATH)) {
  try {
    if (process.argv[2] === "--worker-one") await workerOne();
    else if (process.argv[2] === "--worker-hot") await workerHot();
    else await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
