import crypto from "node:crypto";

export const MAX_ORDINARY_REGRESSION_PERCENT = 5;

function finiteValues(values, field) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${field} must contain at least one sample.`);
  const result = values.map((value, index) => {
    if (!Number.isFinite(value)) throw new Error(`${field}[${index}] must be finite.`);
    return value;
  });
  return result;
}

export function quantile(values, probability) {
  const ordered = finiteValues(values, "quantile values").sort((left, right) => left - right);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("quantile probability must be between zero and one.");
  if (ordered.length === 1) return ordered[0];
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const weight = position - lower;
  return ordered[lower] * (1 - weight) + ordered[upper] * weight;
}

export function median(values) {
  return quantile(values, 0.5);
}

export function medianAbsoluteDeviation(values) {
  const checked = finiteValues(values, "MAD values");
  const center = median(checked);
  return median(checked.map((value) => Math.abs(value - center)));
}

export function improvementPercent(baseline, candidate) {
  if (!Number.isFinite(baseline) || baseline <= 0) throw new Error("baseline statistic must be finite and greater than zero.");
  if (!Number.isFinite(candidate)) throw new Error("candidate statistic must be finite.");
  return ((baseline - candidate) / baseline) * 100;
}

export function summarizeDistribution(values) {
  const checked = finiteValues(values, "distribution values");
  return {
    count: checked.length,
    p50: median(checked),
    p95: quantile(checked, 0.95),
    mad: medianAbsoluteDeviation(checked),
    min: Math.min(...checked),
    max: Math.max(...checked),
  };
}

export function evaluateStrictPerformanceAcceptance({
  thresholdPercent,
  p50ImprovementPercent,
  p50BootstrapLowerPercent,
  p95ImprovementPercent,
  peakRssRegressionPercent,
  outputEquivalent,
} = {}) {
  const finite = {
    thresholdPercent,
    p50ImprovementPercent,
    p50BootstrapLowerPercent,
    p95ImprovementPercent,
    peakRssRegressionPercent,
  };
  for (const [field, value] of Object.entries(finite)) {
    if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`);
  }
  if (thresholdPercent < 0 || thresholdPercent > 100) throw new Error("thresholdPercent must be between zero and 100.");
  if (typeof outputEquivalent !== "boolean") throw new Error("outputEquivalent must be boolean.");
  const criteria = Object.freeze({
    p50PointAtLeastThreshold: p50ImprovementPercent >= thresholdPercent,
    p50PairedBootstrapLowerAtLeastThreshold: p50BootstrapLowerPercent >= thresholdPercent,
    p50PointRegressionAtMostFivePercent: p50ImprovementPercent >= -MAX_ORDINARY_REGRESSION_PERCENT,
    p95PointRegressionAtMostFivePercent: p95ImprovementPercent >= -MAX_ORDINARY_REGRESSION_PERCENT,
    peakRssIncreaseAtMostFifteenPercent: peakRssRegressionPercent <= 15,
    outputExactlyEquivalent: outputEquivalent,
  });
  const improvementTargetMet = criteria.p50PointAtLeastThreshold
    && criteria.p50PairedBootstrapLowerAtLeastThreshold;
  const safeguardsPassed = criteria.p50PointRegressionAtMostFivePercent
    && criteria.p95PointRegressionAtMostFivePercent
    && criteria.peakRssIncreaseAtMostFifteenPercent
    && criteria.outputExactlyEquivalent;
  return Object.freeze({ criteria, improvementTargetMet, safeguardsPassed, passed: safeguardsPassed });
}

function seededRandom(seedBytes) {
  let state = seedBytes.readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function statistic(values, probability) {
  return quantile(values, probability);
}

/**
 * Percentile bootstrap over paired rounds. The pair is the resampling unit, so
 * machine drift shared by the baseline/candidate executions in a round is not
 * discarded. The deterministic seed makes a saved report reproducible.
 */
export function pairedBootstrapImprovement({
  baseline,
  candidate,
  probability = 0.5,
  confidenceLevel = 0.95,
  iterations = 10_000,
  seedMaterial = "paired-bootstrap-v1",
} = {}) {
  const checkedBaseline = finiteValues(baseline, "paired baseline");
  const checkedCandidate = finiteValues(candidate, "paired candidate");
  if (checkedBaseline.length !== checkedCandidate.length) throw new Error("paired bootstrap inputs must have the same length.");
  if (checkedBaseline.length < 2) throw new Error("paired bootstrap requires at least two pairs.");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("bootstrap statistic probability must be between zero and one.");
  if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) throw new Error("bootstrap confidence level must be between zero and one.");
  if (!Number.isSafeInteger(iterations) || iterations < 1_000) throw new Error("bootstrap iterations must be an integer of at least 1000.");
  const seedSha256 = crypto.createHash("sha256")
    .update(JSON.stringify({ checkedBaseline, checkedCandidate, probability, confidenceLevel, iterations, seedMaterial }))
    .digest("hex");
  const random = seededRandom(Buffer.from(seedSha256, "hex"));
  const estimates = new Array(iterations);
  const baselineResample = new Array(checkedBaseline.length);
  const candidateResample = new Array(checkedCandidate.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let index = 0; index < checkedBaseline.length; index += 1) {
      const selected = Math.floor(random() * checkedBaseline.length);
      baselineResample[index] = checkedBaseline[selected];
      candidateResample[index] = checkedCandidate[selected];
    }
    estimates[iteration] = improvementPercent(statistic(baselineResample, probability), statistic(candidateResample, probability));
  }
  const alpha = (1 - confidenceLevel) / 2;
  return {
    method: "paired-percentile-bootstrap-v1",
    statistic: probability === 0.5 ? "p50" : probability === 0.95 ? "p95" : `p${probability * 100}`,
    pairCount: checkedBaseline.length,
    iterations,
    confidenceLevel,
    deterministicSeedSha256: seedSha256,
    pointEstimatePercent: improvementPercent(statistic(checkedBaseline, probability), statistic(checkedCandidate, probability)),
    lowerPercent: quantile(estimates, alpha),
    upperPercent: quantile(estimates, 1 - alpha),
  };
}
