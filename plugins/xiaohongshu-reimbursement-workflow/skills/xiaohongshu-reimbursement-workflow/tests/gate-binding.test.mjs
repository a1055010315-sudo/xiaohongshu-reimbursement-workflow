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

function reimbursementGate(gate, overrides = {}, profileIds = ["xiaohongshu"]) {
  const previewScopes = profileIds.flatMap((profileId, profileIndex) => ["root", "detail", "screenshot"].map((role, index) => ({
    profileId,
    role,
    sheetName: `${profileId}-Sheet1`,
    rangeAddress: index === 0 ? "A1318:F1363" : index === 1 ? "A1:F46" : "A1:H46",
    sourceSha256: index === 0 ? digest("b") : digest("0123456789abcdef"[profileIndex * 3 + index]),
    previewSha256: digest("fedcba9876543210"[profileIndex * 3 + index]),
  })));
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
    affectedProfileIds: profileIds,
    previewScopes,
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

    const missingProfiles = reimbursementGate(gate);
    delete missingProfiles.affectedProfileIds;
    assert.throws(() => buildGateBinding(missingProfiles), /affectedProfileIds is required/);

    assert.throws(
      () => buildGateBinding(reimbursementGate(gate, { unexpectedDigest: digest("0") })),
      /unknown or persisted-authorization field unexpectedDigest/,
    );
  }
});

test("version 2 reimbursement gates bind preview scopes and preview bytes", () => {
  const original = buildGateBinding(reimbursementGate("gate-1"));
  assert.equal(original.context.previewScopes.length, 3);
  assert.deepEqual(original.context.affectedProfileIds, ["xiaohongshu"]);
  const changedRange = reimbursementGate("gate-1");
  changedRange.previewScopes[0].rangeAddress = "A2:F3";
  assert.notEqual(buildGateBinding(changedRange).bindingDigest, original.bindingDigest);
  const changedPreview = reimbursementGate("gate-1");
  changedPreview.previewScopes[1].previewSha256 = digest("9");
  assert.notEqual(buildGateBinding(changedPreview).bindingDigest, original.bindingDigest);
  const missing = reimbursementGate("gate-1");
  delete missing.previewScopes;
  assert.throws(() => buildGateBinding(missing), /previewScopes is required/);
});

test("preview scope ordering is canonical for the binding digest", () => {
  const context = reimbursementGate("gate-1");
  const original = buildGateBinding(context);
  const reordered = buildGateBinding({ ...context, previewScopes: [...context.previewScopes].reverse() });
  assert.equal(reordered.bindingDigest, original.bindingDigest);
  assert.deepEqual(reordered.context.previewScopes.map((scope) => scope.role), ["root", "detail", "screenshot"]);
});

test("version 2 reimbursement gates require complete preview roles for every affected profile", () => {
  const allProfiles = ["xiaohongshu", "company", "residence"];
  const original = buildGateBinding(reimbursementGate("gate-2", {}, allProfiles));
  assert.equal(original.context.previewScopes.length, 9);
  assert.deepEqual(original.context.affectedProfileIds, [...allProfiles].sort());

  const missingRole = reimbursementGate("gate-1", {}, allProfiles);
  missingRole.previewScopes = missingRole.previewScopes.filter(
    (scope) => !(scope.profileId === "company" && scope.role === "screenshot"),
  );
  assert.throws(
    () => buildGateBinding(missingRole),
    /exactly one detail and one screenshot/iu,
  );

  const missingRoot = reimbursementGate("gate-1", {}, allProfiles);
  missingRoot.previewScopes = missingRoot.previewScopes.filter(
    (scope) => !(scope.profileId === "company" && scope.role === "root"),
  );
  assert.throws(() => buildGateBinding(missingRoot), /one to 10 root scopes/iu);

  const duplicateRole = reimbursementGate("gate-1", {}, allProfiles);
  duplicateRole.previewScopes[3].role = "detail";
  assert.throws(() => buildGateBinding(duplicateRole), /one to 10 root scopes|exactly one detail and one screenshot/iu);

  const mismatchedSet = reimbursementGate("gate-1", {}, allProfiles);
  mismatchedSet.affectedProfileIds = ["xiaohongshu", "company"];
  assert.throws(() => buildGateBinding(mismatchedSet), /affectedProfileIds must exactly match/iu);

  const unknownRole = reimbursementGate("gate-1");
  unknownRole.previewScopes[0].role = "ledger";
  assert.throws(() => buildGateBinding(unknownRole), /role is unsupported/iu);

  const unknownProfile = reimbursementGate("gate-1");
  unknownProfile.previewScopes[0].profileId = "other";
  assert.throws(() => buildGateBinding(unknownProfile), /supported canonical lowercase profile/iu);

  const mixedProfileSpelling = reimbursementGate("gate-1");
  mixedProfileSpelling.previewScopes[1].profileId = "XIAOHONGSHU";
  assert.throws(() => buildGateBinding(mixedProfileSpelling), /supported canonical lowercase profile/iu);
});

test("preview scope ranges are bounded and directionally valid", () => {
  for (const rangeAddress of ["B2:A1", "A10:A2", "A0:F1", "A1:F0", "A1:F2", "XFE2:XFE3", "A1048577:F1048577", "A1:F9007199254740992"]) {
    const context = reimbursementGate("gate-1");
    context.previewScopes[0].rangeAddress = rangeAddress;
    assert.throws(() => buildGateBinding(context), /rangeAddress/iu);
  }
});

test("root preview scopes bind the candidate bytes and reject stale sources", () => {
  const context = reimbursementGate("gate-1");
  context.previewScopes[0].sourceSha256 = context.candidateSha256;
  const result = buildGateBinding(context);
  assert.equal(result.context.previewScopes[0].sourceSha256, context.candidateSha256);
  const staleRoot = structuredClone(context);
  staleRoot.previewScopes[0].sourceSha256 = digest("0");
  assert.throws(() => buildGateBinding(staleRoot), /sourceSha256.*candidateSha256|stale/iu);
});

test("root scope count stays within the renderer contract", () => {
  const context = reimbursementGate("gate-1");
  const [root, detail, screenshot] = context.previewScopes;
  context.previewScopes = [
    ...Array.from({ length: 11 }, (_, index) => ({ ...root, rangeAddress: `A${index + 2}:F${index + 2}` })),
    detail,
    screenshot,
  ];
  assert.throws(() => buildGateBinding(context), /one to 10 root scopes/iu);
});

test("multiple non-contiguous root scopes are canonical and overlaps fail closed", () => {
  const context = reimbursementGate("gate-1");
  const root = context.previewScopes[0];
  const detail = context.previewScopes[1];
  const screenshot = context.previewScopes[2];
  context.previewScopes = [
    { ...root, rangeAddress: "A2:F3" },
    detail,
    { ...root, rangeAddress: "A5:F6" },
    screenshot,
  ];
  const original = buildGateBinding(context);
  assert.deepEqual(
    original.context.previewScopes.filter((scope) => scope.role === "root").map((scope) => scope.rangeAddress),
    ["A2:F3", "A5:F6"],
  );
  assert.equal(buildGateBinding({ ...context, previewScopes: [...context.previewScopes].reverse() }).bindingDigest, original.bindingDigest);

  const overlap = structuredClone(context);
  overlap.previewScopes[2].rangeAddress = "A3:F6";
  assert.throws(() => buildGateBinding(overlap), /overlap/iu);
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
