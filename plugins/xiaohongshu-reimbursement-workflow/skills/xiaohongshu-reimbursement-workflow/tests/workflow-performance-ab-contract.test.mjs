import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

import {
  evaluateStrictPerformanceAcceptance,
  improvementPercent,
  medianAbsoluteDeviation,
  pairedBootstrapImprovement,
  summarizeDistribution,
} from "../scripts/performance_statistics.mjs";
import {
  assertDistinctFakePreviewAssets,
  assertIdentityLock,
  assertUnchangedIdentity,
  inspectBenchmarkRoot,
  makeFakeRenderer,
  parseBenchmarkArgs,
  summarizeOrdinaryPerformanceSamples,
} from "./workflow-performance-ab.bench.mjs";
import {
  buildDisbursementOutputContract,
  parseDisbursementBenchmarkArgs,
  summarizeDisbursementPerformanceSamples,
} from "./disbursement-performance-ab.bench.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..");
const ordinaryRunnerPath = path.join(skillRoot, "scripts", "run_reimbursement_workflow.mjs");
const productionDisbursementAdapterPath = path.join(testRoot, "disbursement-production-performance-adapter.mjs");
const fakeOldRoot = path.join(path.parse(skillRoot).root, "identity-only-old-root");

test("acceptance protocol keeps sample rigor while allowing an informational target below 20%", () => {
  const base = [`--old-root=${fakeOldRoot}`];
  assert.throws(() => parseBenchmarkArgs([...base, "--samples=10"]), /at least 11 samples/u);
  assert.throws(() => parseBenchmarkArgs([...base, "--warmups=1"]), /at least 2 untimed warm-ups/u);
  assert.equal(parseBenchmarkArgs([...base, "--threshold=5"]).threshold, 5);
  const diagnostic = parseBenchmarkArgs([...base, "--diagnostic", "--samples=1", "--warmups=0", "--threshold=0"]);
  assert.equal(diagnostic.diagnostic, true);
  assert.equal(diagnostic.samples, 1);
  assert.equal(diagnostic.warmups, 0);
  assert.equal(diagnostic.threshold, 0);
});

test("O acceptance requires a complete explicit two-sided identity lock", () => {
  assert.throws(() => parseBenchmarkArgs([`--old-root=${fakeOldRoot}`, "--line=O"]), /requires an explicit six-field identity lock/u);
  assert.equal(parseBenchmarkArgs([`--old-root=${fakeOldRoot}`, "--line=O", "--identity-only"]).identityOnly, true);
  assert.throws(
    () => parseBenchmarkArgs([`--old-root=${fakeOldRoot}`, "--line=O", "--old-version=one"]),
    /must provide both versions and all four tree digests/u,
  );
  const digest = "a".repeat(64);
  const parsed = parseBenchmarkArgs([
    `--old-root=${fakeOldRoot}`,
    "--line=O",
    "--old-version=baseline",
    "--new-version=candidate",
    `--old-skill-sha256=${digest}`,
    `--new-skill-sha256=${digest}`,
    `--old-package-sha256=${digest}`,
    `--new-package-sha256=${digest}`,
  ]);
  assert.equal(parsed.identityLock.source, "explicit-cli");
});

test("D acceptance keeps 11+2 and identity locks while allowing an informational target below 20%", () => {
  const roots = [`--baseline-root=${fakeOldRoot}`, `--candidate-root=${skillRoot}`];
  assert.throws(() => parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs", "--samples=10"]), /at least 11 timed pairs/u);
  assert.throws(() => parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs", "--warmups=1"]), /at least two untimed warm-ups/u);
  assert.throws(() => parseDisbursementBenchmarkArgs([...roots]), /--adapter is required/u);
  assert.throws(() => parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs"]), /explicit six-field identity lock/u);
  const digest = "a".repeat(64);
  const runnerIdentity = [
    "--baseline-version=baseline",
    "--candidate-version=candidate",
    `--baseline-skill-sha256=${digest}`,
    `--candidate-skill-sha256=${digest}`,
    `--baseline-package-sha256=${digest}`,
    `--candidate-package-sha256=${digest}`,
  ];
  assert.throws(
    () => parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs", ...runnerIdentity]),
    /adapter SHA-256 identity lock/u,
  );
  const accepted = parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs", "--threshold=5", `--adapter-sha256=${digest}`, ...runnerIdentity]);
  assert.equal(accepted.adapterSha256, digest);
  assert.equal(accepted.threshold, 5);
  assert.equal(accepted.loadScale, "standard");
  assert.equal(parseDisbursementBenchmarkArgs([...roots, "--identity-only", "--scale=small"]).loadScale, "small");
  assert.throws(() => parseDisbursementBenchmarkArgs([...roots, "--identity-only", "--scale=unknown"]), /small, standard, or large/u);
  const diagnostic = parseDisbursementBenchmarkArgs([...roots, "--adapter=fake.mjs", "--diagnostic", "--samples=1", "--warmups=0", "--threshold=0"]);
  assert.equal(diagnostic.diagnostic, true);
  assert.equal(diagnostic.identityLock, null);
  assert.equal(parseDisbursementBenchmarkArgs([...roots, "--identity-only"]).identityOnly, true);
});

test("identity guards reject a wrong version, wrong tree, or mid-run mutation", async () => {
  const identity = await inspectBenchmarkRoot(skillRoot);
  assert.throws(() => assertIdentityLock(identity, { version: "wrong", skillTreeSha256: identity.skillTreeSha256, packageTreeSha256: identity.packageTreeSha256 }, "candidate"), /version differs/u);
  assert.throws(() => assertIdentityLock(identity, { version: identity.version, skillTreeSha256: "0".repeat(64), packageTreeSha256: identity.packageTreeSha256 }, "candidate"), /skillTreeSha256 differs/u);
  assert.throws(() => assertUnchangedIdentity(identity, { ...identity, packageTreeSha256: "f".repeat(64) }, "candidate"), /changed during benchmark/u);
});

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function makePng(seed) {
  const width = 96;
  const height = 72;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      scanlines[pixel] = (x * 17 + y * 3 + seed * 29) % 256;
      scanlines[pixel + 1] = (x * 5 + y * 19 + seed * 11) % 256;
      scanlines[pixel + 2] = (x * 13 + y * 7 + seed * 23) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodedPngBytes(bytes) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  return inflateSync(Buffer.concat(idat));
}

test("fake renderer refuses identical PNGs and binds a different valid PNG to every preview", async () => {
  const first = makePng(3);
  const second = makePng(7);
  const firstAsset = { key: "xiaohongshu:root", bytes: first, sha256: crypto.createHash("sha256").update(first).digest("hex") };
  const secondAsset = { key: "xiaohongshu:detail", bytes: second, sha256: crypto.createHash("sha256").update(second).digest("hex") };
  assert.ok(first.length > 1_000 && second.length > 1_000);
  assert.throws(
    () => assertDistinctFakePreviewAssets([firstAsset, { ...firstAsset, key: "xiaohongshu:detail" }]),
    /refuses identical PNG bytes/u,
  );
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-fake-contract-"));
  try {
    const jobs = [
      { profileId: "xiaohongshu", role: "root", workbookSha256: "1".repeat(64), outputPath: path.join(temporaryRoot, "root.png") },
      { profileId: "xiaohongshu", role: "detail", workbookSha256: "2".repeat(64), outputPath: path.join(temporaryRoot, "detail.png") },
    ];
    const renderer = makeFakeRenderer([firstAsset, secondAsset]);
    const response = await renderer({ request: { kind: "ordinary-reimbursement-preview-request-v1", requestNonce: "nonce", jobs }, requestFileSha256: "3".repeat(64) });
    assert.equal(response.previews.length, 2);
    assert.notEqual(response.previews[0].sha256, response.previews[1].sha256);
    const written = await Promise.all(jobs.map((job) => fs.readFile(job.outputPath)));
    assert.notDeepEqual(written[0], written[1]);
    for (const bytes of written) assert.equal(decodedPngBytes(bytes).length, 72 * (1 + 96 * 3));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("distribution and paired-bootstrap statistics are deterministic", () => {
  const baseline = [100, 104, 98, 102, 101, 99, 103, 100, 105, 97, 101];
  const candidate = baseline.map((value, index) => value * (index % 2 === 0 ? 0.75 : 0.77));
  const distribution = summarizeDistribution(baseline);
  assert.equal(distribution.p50, 101);
  assert.ok(distribution.p95 >= distribution.p50);
  assert.equal(distribution.mad, medianAbsoluteDeviation(baseline));
  assert.ok(improvementPercent(distribution.p50, summarizeDistribution(candidate).p50) > 20);
  const first = pairedBootstrapImprovement({ baseline, candidate, seedMaterial: "contract-test" });
  const second = pairedBootstrapImprovement({ baseline, candidate, seedMaterial: "contract-test" });
  assert.deepEqual(first, second);
  assert.equal(first.iterations, 10_000);
  assert.ok(first.lowerPercent > 20);
});

test("improvement target is informational while the five-percent p50/p95, RSS, and output safeguards remain mandatory", () => {
  const passing = {
    thresholdPercent: 20,
    p50ImprovementPercent: 5,
    p50BootstrapLowerPercent: 2,
    p95ImprovementPercent: -5,
    peakRssRegressionPercent: 15,
    outputEquivalent: true,
  };
  const belowTarget = evaluateStrictPerformanceAcceptance(passing);
  assert.equal(belowTarget.passed, true);
  assert.equal(belowTarget.improvementTargetMet, false);
  assert.equal(belowTarget.criteria.p50PointAtLeastThreshold, false);
  assert.equal(belowTarget.criteria.p50PairedBootstrapLowerAtLeastThreshold, false);
  assert.equal(belowTarget.criteria.p50PointRegressionAtMostFivePercent, true);
  assert.equal(belowTarget.criteria.p95PointRegressionAtMostFivePercent, true);
  const failures = [
    ["p50PointRegressionAtMostFivePercent", { p50ImprovementPercent: -5.001 }],
    ["p95PointRegressionAtMostFivePercent", { p95ImprovementPercent: -5.001 }],
    ["peakRssIncreaseAtMostFifteenPercent", { peakRssRegressionPercent: 15.01 }],
    ["outputExactlyEquivalent", { outputEquivalent: false }],
  ];
  for (const [criterion, mutation] of failures) {
    const result = evaluateStrictPerformanceAcceptance({ ...passing, ...mutation });
    assert.equal(result.passed, false, criterion);
    assert.equal(result.criteria[criterion], false, criterion);
  }
  for (const mutation of [{ p50ImprovementPercent: -5 }, { p95ImprovementPercent: -5 }]) {
    assert.equal(evaluateStrictPerformanceAcceptance({ ...passing, ...mutation }).passed, true, "the exact five-percent boundary must pass");
  }
});

test("O and D pass below the 20% improvement target when all safeguards pass", () => {
  const retimeOrdinary = (sample) => ({
    ...sample,
    totalPluginMs: sample.version === "old" ? 100 : 95,
    prepareMs: sample.version === "old" ? 50 : 47.5,
    finalizeMs: sample.version === "old" ? 50 : 47.5,
  });
  const ordinary = [
    retimeOrdinary(ordinarySample("old", 0)), retimeOrdinary(ordinarySample("new", 0)),
    retimeOrdinary(ordinarySample("old", 1)), retimeOrdinary(ordinarySample("new", 1)),
  ];
  const ordinarySummary = summarizeOrdinaryPerformanceSamples(ordinary, { threshold: 20, acceptance: true, line: "O", temperature: "hot", renderer: "com" });
  assert.equal(ordinarySummary.improvementTargetMet, false);
  assert.equal(ordinarySummary.safeguardsPassed, true);
  assert.equal(ordinarySummary.acceptancePassed, true);

  const retimeDisbursement = (sample) => ({
    ...sample,
    totalPluginMs: sample.side === "baseline" ? 100 : 95,
    archiveMs: sample.side === "baseline" ? 100 : 95,
  });
  const disbursement = [
    retimeDisbursement(disbursementSample("baseline", 0)), retimeDisbursement(disbursementSample("candidate", 0)),
    retimeDisbursement(disbursementSample("baseline", 1)), retimeDisbursement(disbursementSample("candidate", 1)),
  ];
  const disbursementSummary = summarizeDisbursementPerformanceSamples(disbursement, "hot", 20, true);
  assert.equal(disbursementSummary.improvementTargetMet, false);
  assert.equal(disbursementSummary.safeguardsPassed, true);
  assert.equal(disbursementSummary.acceptancePassed, true);
});

test("ordinary acceptance enforces the five-percent p50 and p95 boundary", () => {
  const summarizeAt = (candidateTimes) => {
    const samples = [];
    for (const [round, candidateMs] of candidateTimes.entries()) {
      samples.push(ordinarySample("old", round));
      const candidate = ordinarySample("new", round);
      candidate.totalPluginMs = candidateMs;
      candidate.prepareMs = candidateMs / 2;
      candidate.finalizeMs = candidateMs / 2;
      samples.push(candidate);
    }
    return summarizeOrdinaryPerformanceSamples(samples, { threshold: 20, acceptance: true, line: "O", temperature: "hot", renderer: "com" });
  };
  const boundary = summarizeAt([105, 105, 105, 105]);
  assert.equal(boundary.criteria.p50PointRegressionAtMostFivePercent, true);
  assert.equal(boundary.criteria.p95PointRegressionAtMostFivePercent, true);
  assert.equal(boundary.acceptancePassed, true);
  const p50Failure = summarizeAt([105.001, 105.001, 105.001, 105.001]);
  assert.equal(p50Failure.criteria.p50PointRegressionAtMostFivePercent, false);
  assert.equal(p50Failure.acceptancePassed, false);
  const p95Failure = summarizeAt([100, 100, 100, 106]);
  assert.equal(p95Failure.criteria.p50PointRegressionAtMostFivePercent, true);
  assert.equal(p95Failure.criteria.p95PointRegressionAtMostFivePercent, false);
  assert.equal(p95Failure.acceptancePassed, false);
});

test("ordinary acceptance cannot bypass preview uniqueness or hide a peak RSS outlier", () => {
  const duplicatePngSamples = [ordinarySample("old", 0), ordinarySample("new", 0)];
  duplicatePngSamples[1].observedCounts.gate1UniquePreviewPngCount = 2;
  const duplicatePng = summarizeOrdinaryPerformanceSamples(duplicatePngSamples, { threshold: 20, acceptance: true, line: "O", temperature: "hot", renderer: "com" });
  assert.equal(duplicatePng.criteria.previewPngsAreDistinct, false);
  assert.equal(duplicatePng.acceptancePassed, false);

  const peakRssSamples = [];
  for (let round = 0; round < 4; round += 1) {
    peakRssSamples.push(ordinarySample("old", round));
    const candidate = ordinarySample("new", round);
    candidate.resources.sampledPeakRssBytes = round === 3 ? 2_000 : 1_000;
    peakRssSamples.push(candidate);
  }
  const peakRss = summarizeOrdinaryPerformanceSamples(peakRssSamples, { threshold: 20, acceptance: true, line: "O", temperature: "hot", renderer: "com" });
  assert.ok(peakRss.peakRssRegressionPercent > 15);
  assert.equal(peakRss.criteria.peakRssIncreaseAtMostFifteenPercent, false);
  assert.equal(peakRss.acceptancePassed, false);
});

function contractSha(label) {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function ordinaryContract(suffix = "same") {
  return {
    businessFactsDigest: contractSha("ordinary-business"),
    candidateArtifactDigest: contractSha("ordinary-candidate"),
    publishedArtifactDigest: contractSha(`ordinary-published-${suffix}`),
    publishedShapeDigest: contractSha("ordinary-shape"),
  };
}

function disbursementContract(suffix = "same") {
  return buildDisbursementOutputContract({
    businessDigest: contractSha("D-business"),
    finalArchive: {
      entries: [
        { name: "发放情况说明.txt", type: "file", sha256: contractSha(`D-summary-${suffix}`), size: 101 },
        { name: "发放核对表.xlsx", type: "file", sha256: contractSha("D-workbook"), size: 202 },
        { name: "发放凭证", type: "directory", entries: [{ name: "001_voucher.png", type: "file", sha256: contractSha("D-voucher"), size: 303 }] },
      ],
    },
  });
}

function ordinarySample(version, round, outputContract = ordinaryContract()) {
  const totalPluginMs = version === "old" ? 100 : 70;
  return {
    version,
    round,
    importMs: 0,
    prepareMs: totalPluginMs / 2,
    finalizeMs: totalPluginMs / 2,
    totalPluginMs,
    excludedPublishInputSetupMs: 1,
    excludedPublishForEquivalenceMs: 1,
    excludedIndependentReviewSetupMs: 1,
    excludedOutputContractReadMs: 1,
    outputContract,
    observedCounts: { gate1PreviewCount: 3, gate1UniquePreviewPngCount: 3 },
    resources: {
      rssStartBytes: 1_000,
      rssEndBytes: 1_000,
      sampledPeakRssBytes: 1_000,
      processMaxRssKilobytes: 1,
      cpuUserMicroseconds: 1,
      cpuSystemMicroseconds: 1,
      fsReadOperations: 1,
      fsWriteOperations: 1,
      involuntaryContextSwitches: 1,
      voluntaryContextSwitches: 1,
    },
  };
}

function disbursementSample(side, round, outputContract = disbursementContract()) {
  const totalPluginMs = side === "baseline" ? 100 : 70;
  return {
    side,
    round,
    importMs: 0,
    archiveMs: totalPluginMs,
    totalPluginMs,
    excludedOutputContractMs: 1,
    outputContract,
    resources: { sampledPeakRssBytes: 1_000, cpuUserMicroseconds: 1, cpuSystemMicroseconds: 1, fsReadOperations: 1, fsWriteOperations: 1 },
  };
}

test("O and D reject one different published output digest", () => {
  const ordinary = [
    ordinarySample("old", 0), ordinarySample("new", 0),
    ordinarySample("old", 1), ordinarySample("new", 1, ordinaryContract("changed")),
  ];
  const ordinarySummary = summarizeOrdinaryPerformanceSamples(ordinary, { threshold: 20, acceptance: true, line: "O", temperature: "hot", renderer: "com" });
  assert.equal(ordinarySummary.outputEquivalent, false);
  assert.equal(ordinarySummary.criteria.outputExactlyEquivalent, false);
  assert.equal(ordinarySummary.acceptancePassed, false);

  const disbursement = [
    disbursementSample("baseline", 0), disbursementSample("candidate", 0),
    disbursementSample("baseline", 1), disbursementSample("candidate", 1, disbursementContract("changed")),
  ];
  const disbursementSummary = summarizeDisbursementPerformanceSamples(disbursement, "hot", 20, true);
  assert.equal(disbursementSummary.outputEquivalent, false);
  assert.equal(disbursementSummary.criteria.outputExactlyEquivalent, false);
  assert.equal(disbursementSummary.acceptancePassed, false);
});

test("O and D reject missing and duplicate timed pairs", () => {
  const ordinaryMissing = [ordinarySample("old", 0), ordinarySample("new", 0), ordinarySample("old", 1)];
  assert.throws(
    () => summarizeOrdinaryPerformanceSamples(ordinaryMissing, { threshold: 20, acceptance: true, line: "O", temperature: "cold", renderer: "com" }),
    /not a complete pair/u,
  );
  const ordinaryDuplicate = [ordinarySample("old", 0), ordinarySample("old", 0), ordinarySample("new", 0)];
  assert.throws(
    () => summarizeOrdinaryPerformanceSamples(ordinaryDuplicate, { threshold: 20, acceptance: true, line: "O", temperature: "cold", renderer: "com" }),
    /duplicate old sample/u,
  );

  const disbursementMissing = [disbursementSample("baseline", 0), disbursementSample("candidate", 0), disbursementSample("baseline", 1)];
  assert.throws(() => summarizeDisbursementPerformanceSamples(disbursementMissing, "cold", 20, true), /round 1 is incomplete/u);
  const disbursementDuplicate = [disbursementSample("baseline", 0), disbursementSample("baseline", 0), disbursementSample("candidate", 0)];
  assert.throws(() => summarizeDisbursementPerformanceSamples(disbursementDuplicate, "cold", 20, true), /duplicate baseline sample/u);
});

test("ordinary runner import surface remains isolated from disbursement and payroll", async () => {
  const source = await fs.readFile(ordinaryRunnerPath, "utf8");
  const localImports = [
    ...source.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu),
    ...source.matchAll(/\bimport\(\s*["'](\.\/[^"']+)["']\s*\)/gu),
  ].map((match) => match[1]).sort();
  assert.deepEqual(localImports, [
    "./audit_full_correspondence.mjs",
    "./build_gate_binding.mjs",
    "./build_reimbursement_artifacts.mjs",
    "./build_root_workbook_candidate.mjs",
    "./build_root_workbook_candidate.mjs",
    "./finance_domain.mjs",
    "./run_safe_publish.mjs",
    "./template_assets.mjs",
    "./workflow_primitives.mjs",
  ]);
  assert.doesNotMatch(source, /compact[_-]?disbursement|disbursement|payroll|salary|\bwage\b|工资|发放核对|发放情况/iu);

  const visited = new Set();
  async function visit(modulePath) {
    const resolved = path.resolve(modulePath);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const moduleSource = await fs.readFile(resolved, "utf8");
    const specifiers = [
      ...moduleSource.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu),
      ...moduleSource.matchAll(/\bimport\(\s*["'](\.\/[^"']+)["']\s*\)/gu),
    ].map((match) => match[1]);
    for (const specifier of specifiers) await visit(path.resolve(path.dirname(resolved), specifier));
  }
  await visit(ordinaryRunnerPath);
  assert.equal([...visited].some((modulePath) => /disbursement|payroll|salary|wage/iu.test(path.basename(modulePath))), false, `ordinary dependency closure leaked: ${[...visited].join(", ")}`);
});

test("production D adapter remains independent of its dynamically importing benchmark", async () => {
  const source = await fs.readFile(productionDisbursementAdapterPath, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["']\.\/disbursement-performance-ab\.bench\.mjs["']/u);
});
