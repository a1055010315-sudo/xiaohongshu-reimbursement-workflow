import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DISBURSEMENT_MANIFEST_V1_KIND,
  DISBURSEMENT_MANIFEST_V2_KIND,
  dispatchDisbursementManifestVersion,
  validateDisbursementManifestV2,
} from "../scripts/disbursement_manifest_v2_contract.mjs";

const DIGESTS = Object.freeze({
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
});

function fixturePath(name) {
  return path.resolve("synthetic-manifest-v2", name);
}

function sourceFile(id, name, sha256, kind, usage) {
  return { id, path: fixturePath(name), sha256, kind, usage };
}

function makeManifest({
  reimbursement = true,
  salary = false,
  mode = "published_archive",
  reimbursementAttestations = false,
  salaryAttestation = false,
  voucher = false,
} = {}) {
  const sourceFiles = [];
  const reimbursementSources = [];
  const salaryArtifacts = [];
  const vouchers = [];
  const rows = [];
  const reimbursementReviews = [];
  const salaryReviews = [];

  if (reimbursement) {
    const inputUsage = mode === "fresh_evidence" ? "fresh_reimbursement_evidence" : "published_reimbursement_artifact";
    sourceFiles.push(sourceFile("reim-file", "reimbursement.xlsx", DIGESTS.a, "workbook", [inputUsage]));
    const source = {
      id: "reim-source",
      profileId: "xiaohongshu",
      mode,
      inputFileIds: ["reim-file"],
    };
    const reviewedFileIds = ["reim-file"];
    if (reimbursementAttestations) {
      sourceFiles.push(
        sourceFile("manifest-file", "manifest.json", DIGESTS.b, "json", ["original_manifest_attestation"]),
        sourceFile("receipt-file", "receipt.json", DIGESTS.c, "json", ["publish_receipt_attestation"]),
      );
      source.attestations = {
        originalManifestFileId: "manifest-file",
        receiptFileId: "receipt-file",
      };
      reviewedFileIds.push("manifest-file", "receipt-file");
    }
    reimbursementSources.push(source);
    reimbursementReviews.push({
      id: "review-reimbursement",
      sourceId: "reim-source",
      mode,
      reviewedFileIds,
      facts: {
        batchId: "ordinary-batch",
        reimbursementPeriod: { start: "2026-07-25", end: "2026-08-12" },
        transactions: [{ id: "tx-1", date: "2026-08-01", person: "甲", reimbursementAmount: "10" }],
      },
    });
    rows.push({
      id: "row-reimbursement",
      order: rows.length + 1,
      subject: "甲",
      scopeStatus: "in_batch",
      payoutStatus: voucher ? "reconciled" : "pending_evidence",
      paymentMethod: "transfer",
      adjustmentKind: "none",
      amounts: { xiaohongshu: "10", company: "0", residence: "0", salary: "0" },
      paidAmount: voucher ? "10" : "0",
      reimbursementRefs: [{ sourceId: "reim-source", transactionId: "tx-1", amount: "10" }],
      voucherRefs: voucher ? ["voucher-1"] : [],
      ...(voucher ? {} : { reason: "待回单", followUp: "补回单" }),
    });
  }

  if (salary) {
    sourceFiles.push(sourceFile("salary-file", "salary.xlsx", DIGESTS.d, "workbook", ["salary_artifact"]));
    const artifact = {
      id: "salary-slot",
      month: "2026-07",
      salaryCategoryId: "operations",
      salaryCategoryName: "运营工资",
      finalArtifactKind: "workbook",
      fileId: "salary-file",
      storeReference: "2026/07/salary.xlsx",
    };
    const reviewedFileIds = ["salary-file"];
    if (salaryAttestation) {
      sourceFiles.push(sourceFile("salary-certificate", "salary-certificate.json", DIGESTS.e, "json", ["salary_certificate_attestation"]));
      artifact.attestation = { salaryCertificateFileId: "salary-certificate" };
      reviewedFileIds.push("salary-certificate");
    }
    salaryArtifacts.push(artifact);
    salaryReviews.push({
      id: "review-salary",
      salaryArtifactId: "salary-slot",
      mode: "final_artifact",
      reviewedFileIds,
      facts: {
        month: "2026-07",
        salaryCategoryId: "operations",
        salaryCategoryName: "运营工资",
        finalArtifactKind: "workbook",
        storeReference: "2026/07/salary.xlsx",
        grossPayTotal: "100",
        payments: [{ id: "salary-payment-1", subject: "乙", amount: "100" }],
      },
    });
    rows.push({
      id: "row-salary",
      order: rows.length + 1,
      subject: "乙",
      scopeStatus: "in_batch",
      payoutStatus: "pending_evidence",
      paymentMethod: "transfer",
      adjustmentKind: "none",
      amounts: { xiaohongshu: "0", company: "0", residence: "0", salary: "100" },
      paidAmount: "0",
      reimbursementRefs: [],
      salaryArtifactId: "salary-slot",
      voucherRefs: [],
      reason: "待回单",
      followUp: "补回单",
    });
  }

  if (voucher) {
    sourceFiles.push(sourceFile("voucher-file", "voucher.png", DIGESTS.f, "image", ["payout_voucher"]));
    vouchers.push({ id: "voucher-1", fileId: "voucher-file" });
  }

  return {
    kind: DISBURSEMENT_MANIFEST_V2_KIND,
    version: 2,
    batch: {
      batchId: "disbursement-batch",
      archiveParentPath: fixturePath("archive-parent"),
      nameRevision: 1,
      ...(reimbursement ? { reimbursementPeriod: { start: "2026-07-25", end: "2026-08-12" } } : {}),
    },
    sourceFiles,
    reimbursementSources,
    salaryArtifacts,
    vouchers,
    rows,
    sourceReview: {
      kind: "disbursement-source-review-v2",
      version: 2,
      id: "source-review",
      producer: "task_internal",
      generatedAt: "2026-08-23T01:02:03.456Z",
      reimbursement: reimbursementReviews,
      salary: salaryReviews,
    },
    expected: {
      rowCount: rows.length,
      inBatchDueTotal: reimbursement && salary ? "110" : reimbursement ? "10" : "100",
      inBatchPaidTotal: voucher ? "10" : "0",
      reconciledTotal: voucher ? "10" : "0",
      uniqueVoucherCount: voucher ? 1 : 0,
      voucherReferenceCount: voucher ? 1 : 0,
      roundingTailTotal: "0",
      salarySlotCount: salary ? 1 : 0,
    },
  };
}

test("reimbursement-only, salary-only, and mixed manifests pass the pure v2 structure contract", async (t) => {
  const cases = [
    ["reimbursement-only published archive", makeManifest()],
    ["reimbursement-only fresh evidence", makeManifest({ mode: "fresh_evidence" })],
    ["salary-only", makeManifest({ reimbursement: false, salary: true })],
    ["mixed", makeManifest({ salary: true, voucher: true })],
  ];
  for (const [name, manifest] of cases) await t.test(name, () => {
    const validated = validateDisbursementManifestV2(manifest);
    assert.equal(validated.kind, DISBURSEMENT_MANIFEST_V2_KIND);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.sourceReview), true);
  });
});

test("unknown fields are rejected at every exact-schema boundary", async (t) => {
  await t.test("top level", () => {
    const manifest = makeManifest();
    manifest.legacy = true;
    assert.throws(() => validateDisbursementManifestV2(manifest), /manifest contains unknown field legacy/u);
  });
  await t.test("nested reimbursement source", () => {
    const manifest = makeManifest();
    manifest.reimbursementSources[0].originalManifestPath = fixturePath("legacy.json");
    assert.throws(() => validateDisbursementManifestV2(manifest), /contains unknown field originalManifestPath/u);
  });
  await t.test("source review cannot be a path sidecar", () => {
    const manifest = makeManifest();
    manifest.sourceReview.path = fixturePath("review.json");
    assert.throws(() => validateDisbursementManifestV2(manifest), /sourceReview contains unknown field path/u);
  });
});

test("kind/version dispatch is exact and never guesses from fields", async (t) => {
  assert.equal(dispatchDisbursementManifestVersion({ kind: DISBURSEMENT_MANIFEST_V1_KIND, version: 1 }), 1);
  assert.equal(dispatchDisbursementManifestVersion({ kind: DISBURSEMENT_MANIFEST_V2_KIND, version: 2 }), 2);
  for (const envelope of [
    { kind: DISBURSEMENT_MANIFEST_V1_KIND, version: 2 },
    { kind: DISBURSEMENT_MANIFEST_V2_KIND, version: 1 },
    { kind: DISBURSEMENT_MANIFEST_V2_KIND },
    { version: 2, sourceFiles: [] },
  ]) {
    await t.test(JSON.stringify(envelope), () => {
      assert.throws(() => dispatchDisbursementManifestVersion(envelope), /kind and version|mismatched or unsupported/u);
    });
  }
  await t.test("a v2-shaped body carrying the v1 pair is dispatched as v1 and rejected by the v2 validator", () => {
    const mixed = makeManifest();
    mixed.kind = DISBURSEMENT_MANIFEST_V1_KIND;
    mixed.version = 1;
    assert.equal(dispatchDisbursementManifestVersion(mixed), 1);
    assert.throws(() => validateDisbursementManifestV2(mixed), /requires the exact v2 kind\/version pair/u);
  });
});

test("duplicate identifiers and references are rejected", async (t) => {
  await t.test("duplicate sourceFiles id", () => {
    const manifest = makeManifest();
    manifest.sourceFiles.push(sourceFile("reim-file", "other.xlsx", DIGESTS.b, "workbook", ["published_reimbursement_artifact"]));
    assert.throws(() => validateDisbursementManifestV2(manifest), /sourceFiles\[1\]\.id is duplicated/u);
  });
  await t.test("duplicate row id", () => {
    const manifest = makeManifest({ salary: true });
    manifest.rows[1].id = manifest.rows[0].id;
    assert.throws(() => validateDisbursementManifestV2(manifest), /rows\[1\]\.id is duplicated/u);
  });
  await t.test("duplicate review id across review kinds", () => {
    const manifest = makeManifest({ salary: true });
    manifest.sourceReview.salary[0].id = manifest.sourceReview.reimbursement[0].id;
    assert.throws(() => validateDisbursementManifestV2(manifest), /duplicated across sourceReview items/u);
  });
});

test("unknown fileId and conflicting file identity are rejected", async (t) => {
  await t.test("unknown source input fileId", () => {
    const manifest = makeManifest();
    manifest.reimbursementSources[0].inputFileIds[0] = "missing-file";
    assert.throws(() => validateDisbursementManifestV2(manifest), /references unknown sourceFiles id missing-file/u);
  });
  await t.test("same path with a different SHA-256", () => {
    const manifest = makeManifest();
    manifest.sourceFiles.push({
      ...sourceFile("conflicting-file", "ignored.xlsx", DIGESTS.b, "workbook", ["published_reimbursement_artifact"]),
      path: manifest.sourceFiles[0].path,
    });
    assert.throws(() => validateDisbursementManifestV2(manifest), /conflicts with the SHA-256 or kind registered for the same path/u);
  });
});

test("reimbursement mode is limited to published_archive and fresh_evidence", () => {
  const manifest = makeManifest();
  manifest.reimbursementSources[0].mode = "legacy_receipt";
  assert.throws(() => validateDisbursementManifestV2(manifest), /reimbursementSources\[0\]\.mode is not an allowed value/u);
});

test("manifest, receipt, and salary certificate attestations are optional but strictly file-bound when supplied", async (t) => {
  await t.test("all attestations omitted", () => {
    assert.doesNotThrow(() => validateDisbursementManifestV2(makeManifest({ salary: true })));
  });
  await t.test("all attestations supplied with valid bindings", () => {
    assert.doesNotThrow(() => validateDisbursementManifestV2(makeManifest({
      salary: true,
      reimbursementAttestations: true,
      salaryAttestation: true,
    })));
  });
  await t.test("provided reimbursement attestation has an unknown fileId", () => {
    const manifest = makeManifest({ reimbursementAttestations: true });
    manifest.reimbursementSources[0].attestations.receiptFileId = "missing-receipt";
    assert.throws(() => validateDisbursementManifestV2(manifest), /references unknown sourceFiles id missing-receipt/u);
  });
  await t.test("provided salary attestation has the wrong usage", () => {
    const manifest = makeManifest({ reimbursement: false, salary: true, salaryAttestation: true });
    manifest.sourceFiles.find((file) => file.id === "salary-certificate").usage = ["salary_artifact"];
    assert.throws(() => validateDisbursementManifestV2(manifest), /must reference a sourceFiles entry with usage salary_certificate_attestation/u);
  });
});

test("sourceReview is task-internal, complete, file-bound, and primitively formatted", async (t) => {
  await t.test("external producer", () => {
    const manifest = makeManifest();
    manifest.sourceReview.producer = "user_sidecar";
    assert.throws(() => validateDisbursementManifestV2(manifest), /producer must be task_internal/u);
  });
  await t.test("review omits a declared source file", () => {
    const manifest = makeManifest({ reimbursementAttestations: true });
    manifest.sourceReview.reimbursement[0].reviewedFileIds.pop();
    assert.throws(() => validateDisbursementManifestV2(manifest), /must bind every and only the files declared/u);
  });
  await t.test("invalid transaction date", () => {
    const manifest = makeManifest();
    manifest.sourceReview.reimbursement[0].facts.transactions[0].date = "2026-02-30";
    assert.throws(() => validateDisbursementManifestV2(manifest), /must be a real calendar date/u);
  });
  await t.test("amount precision beyond milliunits", () => {
    const manifest = makeManifest();
    manifest.rows[0].paidAmount = "0.0001";
    assert.throws(() => validateDisbursementManifestV2(manifest), /at most three decimal places/u);
  });
});
