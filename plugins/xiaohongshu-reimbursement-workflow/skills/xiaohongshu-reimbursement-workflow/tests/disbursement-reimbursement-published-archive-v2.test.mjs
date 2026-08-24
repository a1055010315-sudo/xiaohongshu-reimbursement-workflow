import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { buildReimbursementArtifacts, REIMBURSEMENT_ARTIFACT_BUILD_KIND } from "../scripts/build_reimbursement_artifacts.mjs";
import {
  DISBURSEMENT_REIMBURSEMENT_SOURCE_AUDIT_KIND,
  auditDisbursementReimbursementSourcesV2,
} from "../scripts/disbursement_reimbursement_source_v2.mjs";
import { loadProfileRegistry } from "../scripts/finance_domain.mjs";
import {
  canonicalDigest,
  loadBundledDependency,
  readStableBinaryFile,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";

const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

const PERIOD = Object.freeze({ start: "2031-04-10", end: "2031-04-15" });
const REVIEW_TRANSACTIONS = Object.freeze([
  Object.freeze({ id: "TX-CURRENT", date: "2031-04-10", person: "合成人员甲", reimbursementAmount: "10.25" }),
  Object.freeze({ id: "TX-SUPPLEMENT", date: "2031-03-09", person: "合成人员乙", reimbursementAmount: "20.5" }),
]);
const ARCHIVE_NAME = "2031.4.10-2031.4.15_小红书报销（含合成人员乙2031.3.9补报1笔20.5元）";

let fixture;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function excelSerial(isoDate) {
  return String(Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000) + 25_569);
}

async function writeBytes(filePath, bytes) {
  const data = Buffer.from(bytes);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(data), size: data.length };
}

async function writeJson(filePath, value) {
  return writeBytes(filePath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function copyBound(source, target) {
  return writeBytes(target, await fs.readFile(source.path));
}

async function makePng(red, green, blue) {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: { r: red, g: green, b: blue } } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

function builderTransactions() {
  return [
    {
      id: "TX-CURRENT",
      profileId: "xiaohongshu",
      sourceOrder: 1,
      date: "2031-04-10",
      person: "合成人员甲",
      project: "当前期交通费",
      label: "合成人员甲",
      category: "小红书报销",
      classification: "运营开支",
      settlement: "employee_reimbursement",
      sourceAmount: "10.25",
      reimbursementAmount: "10.25",
      amount: "10.25",
      reportingKind: "current",
      evidence: ["EVIDENCE"],
      sourceRefs: ["UNIT-CURRENT"],
    },
    {
      id: "TX-SUPPLEMENT",
      profileId: "xiaohongshu",
      sourceOrder: 2,
      date: "2031-03-09",
      person: "合成人员乙",
      project: "历史期办公费",
      label: "合成人员乙",
      category: "小红书报销",
      classification: "日常报销",
      settlement: "employee_reimbursement",
      sourceAmount: "20.5",
      reimbursementAmount: "20.5",
      amount: "20.5",
      reportingKind: "supplement",
      supplementReason: "票据补录",
      evidence: ["EVIDENCE"],
      sourceRefs: ["UNIT-SUPPLEMENT"],
    },
  ];
}

async function createPresentationBuild(root, evidence, transactions = builderTransactions()) {
  const manifest = {
    version: 3,
    operation: { mode: "reimbursement-batch" },
    batch: { mainPeriod: PERIOD, summaryAnnotations: [] },
    files: evidence ? [{ id: "EVIDENCE", role: "material", path: evidence.path, sha256: evidence.sha256, kind: "image", disposition: "used", usage: "voucher" }] : [],
    transactions: transactions.map(({ profileId, amount, ...item }) => item),
  };
  const manifestFile = await writeJson(path.join(root, "builder-manifest.json"), manifest);
  const registry = await loadProfileRegistry();
  const factsPreimage = {
    affectedProfileIds: ["xiaohongshu"],
    transactions: transactions.map(({ evidence: _evidence, ...item }) => item),
    summaryAnnotations: [],
  };
  const sourceCoveragePreimage = {
    transactionSourceRefs: transactions.map((transaction) => ({ transactionId: transaction.id, sourceRefs: [...transaction.sourceRefs] })),
  };
  const certificateCore = {
    kind: "reimbursement-manifest-facts-v1",
    operationMode: "reimbursement-batch",
    manifestFileSha256: manifestFile.sha256,
    manifestDigest: crypto.createHash("sha256").update("builder manifest digest").digest("hex"),
    configDigest: crypto.createHash("sha256").update("builder config digest").digest("hex"),
    profileConfigDigest: registry.profileConfigDigest,
    factsDigest: canonicalDigest(factsPreimage),
    factsPreimage,
    sourceCoverageDigest: canonicalDigest(sourceCoveragePreimage),
    sourceCoveragePreimage,
  };
  const certificate = { ...certificateCore, certificateDigest: canonicalDigest(certificateCore) };
  return buildReimbursementArtifacts({
    kind: REIMBURSEMENT_ARTIFACT_BUILD_KIND,
    stagingToken: crypto.randomBytes(32).toString("hex"),
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
    reimbursementFactsCertificate: certificate,
  });
}

async function createSnapshot(detailFile, outputPath, transactions = builderTransactions()) {
  const detailBytes = await fs.readFile(detailFile.path);
  const zip = await JSZip.loadAsync(detailBytes, { createFolders: false });
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  zip.file("xl/workbook.xml", workbookXml.replaceAll("本次报销明细", "Sheet1"));
  const rows = transactions.map((item, index) => {
    const row = index + 1;
    return `<row r="${row}"><c r="A${row}"><v>${excelSerial(item.date)}</v></c><c r="B${row}" t="inlineStr"><is><t>${xml(item.project)}</t></is></c><c r="C${row}"><v>${item.sourceAmount}</v></c><c r="D${row}"><f>SUM(C${row}:C${row})</f><v>${item.sourceAmount}</v></c><c r="E${row}" t="inlineStr"><is><t>${xml(item.person)}</t></is></c><c r="F${row}" t="inlineStr"><is><t>${xml(item.classification)}</t></is></c></row>`;
  }).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  return writeBytes(outputPath, bytes);
}

function sourceFile(id, binding, kind, usage = "published_reimbursement_artifact") {
  return { id, path: binding.path, sha256: binding.sha256, kind, usage: [usage] };
}

async function createFocusedPublisherFixture(transactions, { includeEvidence }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-s05-published-shape-"));
  const originalEvidence = includeEvidence
    ? await writeBytes(path.join(root, "builder-evidence.png"), await makePng(70, 140, 210))
    : null;
  const presentationBuild = await createPresentationBuild(root, originalEvidence, transactions);
  try {
    const presentation = presentationBuild.artifacts[0];
    const archiveRoot = path.join(root, "2031.4.10-2031.4.15_小红书报销");
    await fs.mkdir(archiveRoot, { recursive: false });
    const summary = await copyBound(presentation.summary, path.join(archiveRoot, path.basename(presentation.summary.path)));
    const detail = await copyBound(presentation.detail, path.join(archiveRoot, path.basename(presentation.detail.path)));
    const screenshot = await copyBound(presentation.screenshot, path.join(archiveRoot, path.basename(presentation.screenshot.path)));
    const snapshot = await createSnapshot(detail, path.join(archiveRoot, "小红书支出总表_截至2031.4.15.xlsx"), transactions);
    const evidence = [];
    for (const item of presentation.evidenceArchive) {
      evidence.push(await copyBound(item, path.join(archiveRoot, "报销截图", "小红书报销", item.finalName)));
    }
    const bindings = [
      ["FOCUSED-SUMMARY", summary, "text"],
      ["FOCUSED-DETAIL", detail, "workbook"],
      ["FOCUSED-SCREENSHOT", screenshot, "workbook"],
      ["FOCUSED-SNAPSHOT", snapshot, "workbook"],
      ...evidence.map((item, index) => [`FOCUSED-EVIDENCE-${index + 1}`, item, "image"]),
    ];
    const sourceFiles = bindings.map(([id, binding, kind]) => sourceFile(id, binding, kind));
    const inputFileIds = sourceFiles.map((file) => file.id);
    return {
      root,
      presentation,
      input: {
        sourceFiles,
        reimbursementSources: [{ id: "FOCUSED-SOURCE", profileId: "xiaohongshu", mode: "published_archive", inputFileIds }],
        reimbursementReviews: [{
          id: "FOCUSED-REVIEW",
          sourceId: "FOCUSED-SOURCE",
          mode: "published_archive",
          reviewedFileIds: inputFileIds,
          facts: {
            batchId: "focused-batch",
            reimbursementPeriod: { ...PERIOD },
            transactions: transactions.map(({ id, date, person, reimbursementAmount }) => ({ id, date, person, reimbursementAmount })),
          },
        }],
      },
    };
  } finally {
    await fs.rm(presentationBuild.stagingRoot, { recursive: true, force: true });
  }
}

async function createOriginalManifest(root, snapshot, evidence, overrides = {}) {
  const transactions = builderTransactions().map(({ profileId: _profileId, amount: _amount, ...item }) => ({ ...item }));
  const manifest = {
    version: 3,
    rulesVersion: "s02-published-archive-test-v1",
    batch: {
      batchId: overrides.batchId ?? "ordinary-batch-s02",
      rootPath: root,
      archivePath: path.join(root, "ordinary-attestation-archive"),
      period: "2031.4.10-2031.4.15",
      mainPeriod: PERIOD,
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASELINE", role: "baseline", path: snapshot.path, sha256: snapshot.sha256 },
      { id: "EVIDENCE", role: "material", path: evidence.path, sha256: overrides.materialSha256 ?? evidence.sha256, kind: "image", disposition: "used", usage: "voucher" },
    ],
    sourceScopes: [{ id: "SCOPE", fileId: "EVIDENCE", locator: "full-image", terminalConfirmed: true, expectedUnitCount: 2 }],
    sourceUnits: [
      { id: "UNIT-CURRENT", scopeId: "SCOPE", locator: "row-1", disposition: "used" },
      { id: "UNIT-SUPPLEMENT", scopeId: "SCOPE", locator: "row-2", disposition: "used" },
    ],
    transactions,
    expected: {
      transactionCount: 2,
      feeTotal: "30.75",
      reimbursementTotal: "30.75",
      companyPaidNoReimbursementTotal: "0",
      uniqueMediaCount: 1,
      mediaReferenceCount: 2,
    },
  };
  if (overrides.transactionPerson) manifest.transactions[0].person = overrides.transactionPerson;
  if (overrides.unknownExpectedField) manifest.expected.unknownAttestationField = true;
  return writeJson(path.join(root, overrides.filename ?? "ordinary-manifest.json"), manifest);
}

async function createReceipt(root, bindings, overrides = {}) {
  const receiptCore = {
    kind: "ordinary-reimbursement-published-v1",
    batchId: overrides.batchId ?? "ordinary-batch-s02",
    affectedProfileIds: ["xiaohongshu"],
    outputs: [{
      profileId: "xiaohongshu",
      root: overrides.reuseSnapshotAsRoot ? bindings.snapshot : bindings.root,
      detail: bindings.detail,
      screenshot: bindings.screenshot,
      summary: bindings.summary,
      snapshot: bindings.snapshot,
      supplements: [{ person: "合成人员乙", ...bindings.supplement }],
      evidenceArchive: [{ evidenceId: "EVIDENCE", ...bindings.evidence }],
      publishAuditDigest: crypto.createHash("sha256").update("publish audit").digest("hex"),
    }],
    postPublishAuditDigest: crypto.createHash("sha256").update("post publish audit").digest("hex"),
  };
  const receipt = {
    ...receiptCore,
    receiptDigest: overrides.invalidDigest ? "0".repeat(64) : canonicalDigest(receiptCore),
    cleanup: { removed: true, preserved: [], failures: [] },
  };
  return writeJson(path.join(root, overrides.filename ?? "ordinary-receipt.json"), receipt);
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-s02-published-archive-"));
  const originalEvidence = await writeBytes(path.join(root, "builder-evidence.png"), await makePng(30, 120, 210));
  const presentationBuild = await createPresentationBuild(root, originalEvidence);
  const presentation = presentationBuild.artifacts[0];
  const archiveRoot = path.join(root, ARCHIVE_NAME);
  await fs.mkdir(archiveRoot, { recursive: false });
  const detail = await copyBound(presentation.detail, path.join(archiveRoot, path.basename(presentation.detail.path)));
  const screenshot = await copyBound(presentation.screenshot, path.join(archiveRoot, path.basename(presentation.screenshot.path)));
  const summary = await copyBound(presentation.summary, path.join(archiveRoot, path.basename(presentation.summary.path)));
  const supplement = await copyBound(presentation.supplements[0], path.join(archiveRoot, path.basename(presentation.supplements[0].path)));
  const evidenceDirectory = path.join(archiveRoot, "报销截图", "小红书报销");
  const evidence = await copyBound(presentation.evidenceArchive[0], path.join(evidenceDirectory, presentation.evidenceArchive[0].finalName));
  const snapshot = await createSnapshot(detail, path.join(archiveRoot, "小红书支出总表_截至2031.4.15.xlsx"));
  const registry = await loadProfileRegistry();
  const rootWorkbook = await copyBound(snapshot, path.join(root, registry.profiles.xiaohongshu.canonicalRootWorkbookName));
  await fs.rm(presentationBuild.stagingRoot, { recursive: true, force: true });

  const duplicateSummary = await copyBound(summary, path.join(archiveRoot, "2031.4.10-2031.4.15_小红书报销_报销文字说明（含伪补报）.txt"));
  const unknown = await writeBytes(path.join(archiveRoot, "未知归档说明.txt"), Buffer.from("unknown\n", "utf8"));
  const extraEvidence = await writeBytes(path.join(evidenceDirectory, "999_额外_凭证_1_2031-04-10.png"), await makePng(220, 40, 80));
  const attestationOnlyBaseline = await writeBytes(path.join(root, "attestation-only-baseline.xlsx"), Buffer.from("no-follow baseline bytes\n", "utf8"));
  const originalManifest = await createOriginalManifest(root, attestationOnlyBaseline, originalEvidence);
  const conflictingManifest = await createOriginalManifest(root, attestationOnlyBaseline, originalEvidence, { filename: "ordinary-manifest-conflict.json", transactionPerson: "冲突人员" });
  const mappedManifest = await createOriginalManifest(root, attestationOnlyBaseline, evidence, { filename: "ordinary-manifest-mapped.json" });
  const badMappedManifest = await createOriginalManifest(root, attestationOnlyBaseline, evidence, { filename: "ordinary-manifest-mapped-bad-sha.json", materialSha256: "0".repeat(64) });
  const malformedManifest = await createOriginalManifest(root, attestationOnlyBaseline, originalEvidence, { filename: "ordinary-manifest-malformed.json", unknownExpectedField: true });
  const receiptBindings = { root: rootWorkbook, detail, screenshot, summary, supplement, evidence, snapshot };
  const receipt = await createReceipt(root, receiptBindings);
  const invalidReceipt = await createReceipt(root, receiptBindings, { filename: "ordinary-receipt-invalid.json", invalidDigest: true });
  const conflictingReceipt = await createReceipt(root, receiptBindings, { filename: "ordinary-receipt-conflict.json", batchId: "conflicting-batch" });
  const reusedRoleReceipt = await createReceipt(root, receiptBindings, { filename: "ordinary-receipt-reused-role.json", reuseSnapshotAsRoot: true });

  const files = [
    sourceFile("SUMMARY", summary, "text"),
    sourceFile("DETAIL", detail, "workbook"),
    sourceFile("SCREENSHOT", screenshot, "workbook"),
    sourceFile("SNAPSHOT", snapshot, "workbook"),
    sourceFile("SUPPLEMENT", supplement, "workbook"),
    sourceFile("EVIDENCE", evidence, "image"),
    sourceFile("ROOT", rootWorkbook, "workbook"),
    sourceFile("DUPLICATE-SUMMARY", duplicateSummary, "text"),
    sourceFile("UNKNOWN", unknown, "text"),
    sourceFile("EXTRA-EVIDENCE", extraEvidence, "image"),
    sourceFile("ORIGINAL-MANIFEST", originalManifest, "json", "original_manifest_attestation"),
    sourceFile("CONFLICTING-MANIFEST", conflictingManifest, "json", "original_manifest_attestation"),
    sourceFile("MAPPED-MANIFEST", mappedManifest, "json", "original_manifest_attestation"),
    sourceFile("BAD-MAPPED-MANIFEST", badMappedManifest, "json", "original_manifest_attestation"),
    sourceFile("MALFORMED-MANIFEST", malformedManifest, "json", "original_manifest_attestation"),
    sourceFile("RECEIPT", receipt, "json", "publish_receipt_attestation"),
    sourceFile("INVALID-RECEIPT", invalidReceipt, "json", "publish_receipt_attestation"),
    sourceFile("CONFLICTING-RECEIPT", conflictingReceipt, "json", "publish_receipt_attestation"),
    sourceFile("REUSED-ROLE-RECEIPT", reusedRoleReceipt, "json", "publish_receipt_attestation"),
  ];
  await fs.rm(attestationOnlyBaseline.path);
  await fs.rm(originalEvidence.path);
  return {
    root,
    filesById: new Map(files.map((file) => [file.id, file])),
    baseInputFileIds: ["SUMMARY", "DETAIL", "SCREENSHOT", "SNAPSHOT", "SUPPLEMENT", "EVIDENCE"],
  };
}

function request({
  inputFileIds = fixture.baseInputFileIds,
  attestations,
  reviewTransactions = REVIEW_TRANSACTIONS,
  period = PERIOD,
  batchId = "ordinary-batch-s02",
  fileOverrides = {},
} = {}) {
  const attestationIds = attestations ? Object.values(attestations) : [];
  const effectiveInputFileIds = attestations?.receiptFileId && !inputFileIds.includes("ROOT")
    ? [...inputFileIds, "ROOT"]
    : [...inputFileIds];
  const declaredIds = [...effectiveInputFileIds, ...attestationIds];
  const sourceFiles = declaredIds.map((id) => ({ ...fixture.filesById.get(id), ...(fileOverrides[id] ?? {}) }));
  return {
    sourceFiles,
    reimbursementSources: [{
      id: "SOURCE-XHS",
      profileId: "xiaohongshu",
      mode: "published_archive",
      inputFileIds: effectiveInputFileIds,
      ...(attestations ? { attestations: { ...attestations } } : {}),
    }],
    reimbursementReviews: [{
      id: "REVIEW-XHS",
      sourceId: "SOURCE-XHS",
      mode: "published_archive",
      reviewedFileIds: declaredIds,
      facts: {
        batchId,
        reimbursementPeriod: { ...period },
        transactions: reviewTransactions.map((item) => ({ ...item })),
      },
    }],
  };
}

before(async () => {
  fixture = await createFixture();
});

after(async () => {
  if (fixture?.root) await fs.rm(fixture.root, { recursive: true, force: true });
});

test("published archive without original manifest or receipt reconstructs stable facts and bindings", async () => {
  const first = await auditDisbursementReimbursementSourcesV2(request());
  const second = await auditDisbursementReimbursementSourcesV2(request());
  assert.equal(first.kind, DISBURSEMENT_REIMBURSEMENT_SOURCE_AUDIT_KIND);
  assert.equal(first.auditDigest, second.auditDigest);
  assert.deepEqual(first.transactions.map(({ id, date, person, reimbursementAmount }) => ({ id, date, person, reimbursementAmount })), REVIEW_TRANSACTIONS);
  assert.deepEqual(first.sources[0].artifactBindings.map((item) => item.role), ["summary", "detail", "screenshot", "snapshot", "supplement", "evidence"]);
  assert.equal(first.sources[0].transactionBindings[1].supplement.fileId, "SUPPLEMENT");
  assert.equal(first.sources[0].transactionBindings.every((item) => item.snapshot.row >= 1), true);
  assert.equal(first.sources[0].transactionBindings.every((item) => item.evidence.length === 1), true);
  assert.deepEqual(first.sources[0].attestations, {});
  assert.equal(first.sources[0].reviewBoundFacts.some((item) => item.field === "batchId" && item.corroboration === "none"), true);
});

test("shared published files are loaded once and retained only until their final source consumer", async () => {
  const sharedFileIds = [...fixture.baseInputFileIds];
  const firstAttestationId = "ORIGINAL-MANIFEST";
  const secondAttestationId = "MAPPED-MANIFEST";
  const declaredIds = [...sharedFileIds, firstAttestationId, secondAttestationId];
  const sourceFiles = declaredIds.map((id) => ({ ...fixture.filesById.get(id) }));
  const makeSource = (id, attestationId) => ({
    id,
    profileId: "xiaohongshu",
    mode: "published_archive",
    inputFileIds: [...sharedFileIds],
    attestations: { originalManifestFileId: attestationId },
  });
  const makeReview = (sourceId, attestationId) => ({
    id: `REVIEW-${sourceId}`,
    sourceId,
    mode: "published_archive",
    reviewedFileIds: [...sharedFileIds, attestationId],
    facts: {
      batchId: "ordinary-batch-s02",
      reimbursementPeriod: { ...PERIOD },
      transactions: REVIEW_TRANSACTIONS.map((item) => ({ ...item })),
    },
  });
  const states = [];
  const result = await auditDisbursementReimbursementSourcesV2({
    sourceFiles,
    reimbursementSources: [
      makeSource("SOURCE-CACHE-1", firstAttestationId),
      makeSource("SOURCE-CACHE-2", secondAttestationId),
    ],
    reimbursementReviews: [
      makeReview("SOURCE-CACHE-1", firstAttestationId),
      makeReview("SOURCE-CACHE-2", secondAttestationId),
    ],
  }, {
    testHooks: {
      afterSourceAudited(state) {
        states.push(state);
      },
    },
  });

  const expectedSharedBytes = (await Promise.all(sharedFileIds.map(async (fileId) => (
    await readStableBinaryFile(fixture.filesById.get(fileId).path)
  ).size))).reduce((sum, size) => sum + size, 0);
  assert.equal(result.sources.length, 2);
  assert.equal(states.length, 2);
  assert.deepEqual([...states[0].retainedFileIds].sort(), [...sharedFileIds].sort());
  assert.equal(states[0].retainedBytes, expectedSharedBytes);
  assert.deepEqual(states[1].retainedFileIds, []);
  assert.equal(states[1].retainedBytes, 0);
  for (const fileId of declaredIds) assert.equal(states[1].fileLoadCounts[fileId], 1);
  assert.equal(firstAttestationId in states[0].remainingUses, false);
  assert.equal(secondAttestationId in states[0].remainingUses, true);
});

test("real publisher zero-evidence shape has no drawing, media, anchors, or evidence archive and remains valid", async () => {
  const transactions = [{
    id: "TX-NO-EVIDENCE",
    profileId: "xiaohongshu",
    sourceOrder: 1,
    date: "2031-04-10",
    person: "无图人员",
    project: "无图合成事项",
    label: "无图人员",
    category: "小红书报销",
    classification: "运营开支",
    settlement: "employee_reimbursement",
    sourceAmount: "10",
    reimbursementAmount: "10",
    amount: "10",
    reportingKind: "current",
    evidence: [],
    missingEvidenceConfirmed: true,
    sourceRefs: ["UNIT-NO-EVIDENCE"],
  }];
  const focused = await createFocusedPublisherFixture(transactions, { includeEvidence: false });
  try {
    assert.equal(focused.presentation.screenshot.imageCount, 0);
    assert.equal(focused.presentation.screenshot.uniqueMediaCount, 0);
    assert.deepEqual(focused.presentation.evidenceArchive, []);
    const result = await auditDisbursementReimbursementSourcesV2(focused.input);
    assert.equal(result.sources[0].artifactBindings.some((item) => item.role === "evidence"), false);
    assert.deepEqual(result.sources[0].transactionBindings[0].evidence, []);
    assert.equal(result.sources[0].transactionBindings[0].artifactDerived.evidenceState, "no_evidence");
  } finally {
    await fs.rm(focused.root, { recursive: true, force: true });
  }
});

test("source amount can differ from task-reviewed reimbursement allocation while person and global published totals close", async () => {
  const transactions = [
    {
      id: "TX-ALLOC-1", profileId: "xiaohongshu", sourceOrder: 1, date: "2031-04-10", person: "同一人员", project: "分配事项甲",
      label: "同一人员", category: "小红书报销", classification: "运营开支", settlement: "employee_reimbursement",
      sourceAmount: "10", reimbursementAmount: "8", amount: "10", reportingKind: "current", evidence: ["EVIDENCE"], sourceRefs: ["UNIT-ALLOC-1"],
    },
    {
      id: "TX-ALLOC-2", profileId: "xiaohongshu", sourceOrder: 2, date: "2031-04-10", person: "同一人员", project: "分配事项乙",
      label: "同一人员", category: "小红书报销", classification: "运营开支", settlement: "employee_reimbursement",
      sourceAmount: "6", reimbursementAmount: "4", amount: "6", reportingKind: "current", evidence: ["EVIDENCE"], sourceRefs: ["UNIT-ALLOC-2"],
    },
  ];
  const focused = await createFocusedPublisherFixture(transactions, { includeEvidence: true });
  try {
    const result = await auditDisbursementReimbursementSourcesV2(focused.input);
    assert.deepEqual(result.sources[0].transactions.map((item) => item.reimbursementAmount), ["8", "4"]);
    assert.deepEqual(result.sources[0].transactionBindings.map((item) => ({
      row: item.detail.row,
      sourceAmount: item.artifactDerived.sourceAmount,
      reimbursementAmount: item.artifactDerived.reimbursementAmount,
      authority: item.artifactDerived.reimbursementAmountAuthority,
    })), [
      { row: 8, sourceAmount: "10", reimbursementAmount: "8", authority: "sourceReview" },
      { row: 9, sourceAmount: "6", reimbursementAmount: "4", authority: "sourceReview" },
    ]);
    assert.equal(result.sources[0].reviewBoundFacts.some((item) => (
      item.field === "transactions[].reimbursementAmount"
      && item.allocationSemantics === "review_bound_not_file_parsed"
    )), true);

    const conflict = structuredClone(focused.input);
    conflict.reimbursementReviews[0].facts.transactions[1].reimbursementAmount = "5";
    await assert.rejects(
      () => auditDisbursementReimbursementSourcesV2(conflict),
      /detail workbook E4 reimbursement total is invalid/u,
    );
  } finally {
    await fs.rm(focused.root, { recursive: true, force: true });
  }
});

for (const [role, fileId] of [
  ["summary", "SUMMARY"],
  ["detail", "DETAIL"],
  ["screenshot", "SCREENSHOT"],
  ["snapshot", "SNAPSHOT"],
]) {
  test(`missing ${role} role is rejected`, async () => {
    const inputFileIds = fixture.baseInputFileIds.filter((id) => id !== fileId);
    const expected = role === "detail" ? /must declare exactly one profile-specific detail workbook/u : new RegExp(`missing required ${role} role`, "u");
    await assert.rejects(() => auditDisbursementReimbursementSourcesV2(request({ inputFileIds })), expected);
  });
}

test("image-bearing archive cannot omit its evidence file", async () => {
  const inputFileIds = fixture.baseInputFileIds.filter((id) => id !== "EVIDENCE");
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ inputFileIds })),
    /zero-evidence screenshot workbook must not bind a drawing part/u,
  );
});

test("duplicate formal role is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ inputFileIds: [...fixture.baseInputFileIds, "DUPLICATE-SUMMARY"] })),
    /duplicate summary roles/u,
  );
});

test("unknown listed file is rejected without directory inference", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ inputFileIds: [...fixture.baseInputFileIds, "UNKNOWN"] })),
    /unknown file role/u,
  );
});

test("declared SHA tampering is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ fileOverrides: { DETAIL: { sha256: "0".repeat(64) } } })),
    /SHA-256 differs/u,
  );
});

for (const [field, mutate] of [
  ["person", (transactions) => { transactions[0].person = "错误人员"; }],
  ["date", (transactions) => { transactions[0].date = "2031-04-11"; }],
  ["amount", (transactions) => { transactions[0].reimbursementAmount = "10.26"; }],
]) {
  test(`sourceReview transaction ${field} mismatch is rejected`, async () => {
    const transactions = REVIEW_TRANSACTIONS.map((item) => ({ ...item }));
    mutate(transactions);
    await assert.rejects(
      () => auditDisbursementReimbursementSourcesV2(request({ reviewTransactions: transactions })),
      /cannot close sourceReview transaction|detail workbook E4 reimbursement total is invalid/u,
    );
  });
}

test("sourceReview reimbursement period mismatch is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ period: { start: "2031-04-11", end: "2031-04-15" } })),
    /must declare exactly one profile-specific detail workbook|unknown file role|detail workbook title/u,
  );
});

test("a pre-period transaction without its supplement workbook is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ inputFileIds: fixture.baseInputFileIds.filter((id) => id !== "SUPPLEMENT") })),
    /has no supplement workbook binding|archive directory name/u,
  );
});

test("archived evidence not referenced by screenshot media is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ inputFileIds: [...fixture.baseInputFileIds, "EXTRA-EVIDENCE"] })),
    /embedded media and archived evidence images do not close/u,
  );
});

test("original manifest attestation is independently optional and validated no-follow against archive facts", async () => {
  const result = await auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "ORIGINAL-MANIFEST" } }));
  assert.equal(result.sources[0].attestations.originalManifest.fileId, "ORIGINAL-MANIFEST");
  assert.equal(result.sources[0].attestations.originalManifest.referencedPathsFollowed, false);
  assert.equal(result.sources[0].attestations.originalManifest.fileMapping.mappedManifestFileCount, 0);
  assert.equal(result.sources[0].attestations.originalManifest.fileMapping.allDeclaredManifestPathsMapped, false);
  assert.equal(result.sources[0].attestations.originalManifest.fileMapping.unregisteredManifestPathsRead, false);
  assert.equal(result.sources[0].attestations.receipt, undefined);
  assert.equal(result.sources[0].reviewBoundFacts[0].corroboration, "original_manifest_attestation");
});

test("original manifest maps path, SHA, and kind only for an explicitly registered published artifact", async () => {
  const result = await auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "MAPPED-MANIFEST" } }));
  const mapping = result.sources[0].attestations.originalManifest.fileMapping;
  assert.equal(mapping.scope, "explicit_published_source_files_only");
  assert.equal(mapping.mappedManifestFileCount, 1);
  assert.equal(mapping.completePathShaKindMappingCount, 1);
  assert.deepEqual(mapping.explicitFileMappings[0].verifiedFields, ["path", "sha256", "kind"]);
  assert.equal(mapping.explicitFileMappings[0].sourceFileId, "EVIDENCE");
  assert.equal(mapping.allDeclaredManifestPathsMapped, false);
});

test("ordinary manifest auditor still rejects unknown attestation fields in no-follow mode", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "MALFORMED-MANIFEST" } })),
    /original manifest attestation audit failed|unknown field|unknownAttestationField/u,
  );
});

test("original manifest explicit published-artifact mapping rejects a wrong declared SHA", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "BAD-MAPPED-MANIFEST" } })),
    /SHA conflicts with its explicit published source file/u,
  );
});

test("real publisher receipt shape with post-digest cleanup is accepted and binds only explicit paths", async () => {
  const result = await auditDisbursementReimbursementSourcesV2(request({ attestations: { receiptFileId: "RECEIPT" } }));
  assert.equal(result.sources[0].attestations.receipt.fileId, "RECEIPT");
  assert.equal(result.sources[0].attestations.originalManifest, undefined);
  assert.equal(result.sources[0].attestations.receipt.artifactBindings.length, 7);
});

test("receipt root and snapshot roles cannot reuse one path or file identity", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { receiptFileId: "REUSED-ROLE-RECEIPT" } })),
    /root path has archive role snapshot|reuses an artifact file already assigned/u,
  );
});

test("both optional attestations can corroborate one reconstructed archive", async () => {
  const result = await auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "ORIGINAL-MANIFEST", receiptFileId: "RECEIPT" } }));
  assert.equal(Boolean(result.sources[0].attestations.originalManifest), true);
  assert.equal(Boolean(result.sources[0].attestations.receipt), true);
});

test("damaged receipt digest is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { receiptFileId: "INVALID-RECEIPT" } })),
    /receipt attestation digest is invalid/u,
  );
});

test("receipt conflict with sourceReview is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { receiptFileId: "CONFLICTING-RECEIPT" } })),
    /does not bind sourceReview batch\/profile/u,
  );
});

test("original manifest conflict with reconstructed facts is rejected", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ attestations: { originalManifestFileId: "CONFLICTING-MANIFEST" } })),
    /transactions conflict with reconstructed\/sourceReview facts/u,
  );
});

test("sourceReview batch id remains review-bound but conflicting attestation cannot override it", async () => {
  await assert.rejects(
    () => auditDisbursementReimbursementSourcesV2(request({ batchId: "wrong-review-batch", attestations: { originalManifestFileId: "ORIGINAL-MANIFEST" } })),
    /batchId differs from sourceReview/u,
  );
});

test("fixture files remain stable for every published source binding", async () => {
  for (const fileId of fixture.baseInputFileIds) {
    const file = fixture.filesById.get(fileId);
    const stable = await readStableBinaryFile(file.path);
    assert.equal(stable.sha256, file.sha256);
  }
});
