import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildGateBinding } from "../scripts/build_gate_binding.mjs";

const digest = (character) => character.repeat(64);
const candidatePath = path.resolve("anonymous", "candidate.xlsx");
const baselinePath = path.resolve("anonymous", "baseline.xlsx");

function gate1(overrides = {}) {
  return {
    version: 1,
    gate: "gate-1",
    mode: "ledger-reorder-correction",
    batchId: "anonymous-batch",
    factsDigest: digest("a"),
    operationDigest: digest("b"),
    planFileSha256: digest("c"),
    reviewPackageDigest: digest("d"),
    candidateRevision: 2,
    candidatePath,
    candidateSha256: digest("e"),
    ...overrides,
  };
}

function reimbursementGate(gate, overrides = {}) {
  return {
    version: 2,
    gate,
    mode: "reimbursement-batch",
    batchId: "anonymous-reimbursement-batch",
    operationDigest: digest("a"),
    candidateRevision: 1,
    candidatePath,
    candidateSha256: digest("b"),
    candidatePlanSha256: digest("c"),
    sourceCoverageDigest: digest("d"),
    ...(gate === "gate-1"
      ? {
          factsDigest: digest("e"),
          reviewPackageDigest: digest("f"),
        }
      : {
          baselinePath,
          baselineSha256: digest("e"),
          finalAuditDigest: digest("f"),
        }),
    ...overrides,
  };
}

test("gate 1 deterministically binds operation, plan, candidate path, revision, and bytes", () => {
  const first = buildGateBinding(gate1());
  const second = buildGateBinding(gate1());
  assert.equal(first.bindingDigest, second.bindingDigest);
  for (const mutation of [
    { operationDigest: digest("f") },
    { planFileSha256: digest("f") },
    { candidateRevision: 3 },
    { candidatePath: path.resolve("anonymous", "other.xlsx") },
    { candidateSha256: digest("f") },
  ]) {
    assert.notEqual(buildGateBinding(gate1(mutation)).bindingDigest, first.bindingDigest);
  }
});

test("gate 2 binds the current baseline and final audit", () => {
  const result = buildGateBinding({
    version: 1,
    gate: "gate-2",
    mode: "ledger-reorder-correction",
    batchId: "anonymous-batch",
    operationDigest: digest("a"),
    planFileSha256: digest("b"),
    candidateRevision: 2,
    candidatePath,
    candidateSha256: digest("c"),
    baselinePath: path.resolve("anonymous", "baseline.xlsx"),
    baselineSha256: digest("d"),
    finalAuditDigest: digest("e"),
  });
  assert.match(result.bindingDigest, /^[0-9a-f]{64}$/);
});

test("gate context rejects persisted authorization aliases", () => {
  assert.throws(() => buildGateBinding(gate1({ approved: true })), /unknown or persisted-authorization/);
});

test("version 1 reimbursement contexts remain compatible without version 2 digests", () => {
  const result = buildGateBinding({
    version: 1,
    gate: "gate-1",
    mode: "reimbursement-batch",
    batchId: "anonymous-legacy-batch",
    factsDigest: digest("a"),
    operationDigest: digest("b"),
    reviewPackageDigest: digest("c"),
    candidateRevision: 1,
    candidatePath,
    candidateSha256: digest("d"),
  });
  assert.equal(result.context.version, 1);
  assert.equal("candidatePlanSha256" in result.context, false);
  assert.equal("sourceCoverageDigest" in result.context, false);
});

test("version 2 reimbursement gates bind candidate plan and source coverage digests", () => {
  for (const gate of ["gate-1", "gate-2"]) {
    const original = buildGateBinding(reimbursementGate(gate));
    assert.equal(original.context.candidatePlanSha256, digest("c"));
    assert.equal(original.context.sourceCoverageDigest, digest("d"));
    assert.notEqual(
      buildGateBinding(reimbursementGate(gate, { candidatePlanSha256: digest("0") })).bindingDigest,
      original.bindingDigest,
    );
    assert.notEqual(
      buildGateBinding(reimbursementGate(gate, { sourceCoverageDigest: digest("1") })).bindingDigest,
      original.bindingDigest,
    );
  }
});

test("version 2 reimbursement gates require both new digests and reject unknown fields", () => {
  for (const gate of ["gate-1", "gate-2"]) {
    const missingPlan = reimbursementGate(gate);
    delete missingPlan.candidatePlanSha256;
    assert.throws(() => buildGateBinding(missingPlan), /candidatePlanSha256 is required/);

    const missingCoverage = reimbursementGate(gate);
    delete missingCoverage.sourceCoverageDigest;
    assert.throws(() => buildGateBinding(missingCoverage), /sourceCoverageDigest is required/);

    assert.throws(
      () => buildGateBinding(reimbursementGate(gate, { unexpectedDigest: digest("0") })),
      /unknown or persisted-authorization field unexpectedDigest/,
    );
  }
});

test("version 2 ledger correction keeps the existing field set", () => {
  const context = gate1({ version: 2 });
  const result = buildGateBinding(context);
  assert.equal(result.context.version, 2);
  assert.equal("candidatePlanSha256" in result.context, false);
  assert.equal("sourceCoverageDigest" in result.context, false);
  assert.throws(
    () => buildGateBinding({ ...context, candidatePlanSha256: digest("0") }),
    /unknown or persisted-authorization field candidatePlanSha256/,
  );
});
