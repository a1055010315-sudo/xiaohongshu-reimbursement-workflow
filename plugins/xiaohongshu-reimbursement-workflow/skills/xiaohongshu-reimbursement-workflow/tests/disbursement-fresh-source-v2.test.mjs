import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DISBURSEMENT_FRESH_SOURCE_AUDIT_V2_KIND,
  auditDisbursementFreshSourcesV2,
} from "../scripts/disbursement_fresh_source_v2.mjs";
import {
  canonicalDigest,
  loadBundledDependency,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";
import { createCompactDisbursementProductionFixture } from "./disbursement-production-fixture.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "disbursement-fresh-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSource(root, {
  id,
  name,
  bytes,
  kind,
  usage,
}) {
  const filePath = path.join(root, name);
  const data = Buffer.from(bytes);
  await fs.writeFile(filePath, data, { flag: "wx" });
  return {
    id,
    path: filePath,
    sha256: sha256Bytes(data),
    kind,
    usage,
  };
}

async function writeJsonSource(root, options, value) {
  return writeSource(root, { ...options, bytes: Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), kind: "json" });
}

async function pngBytes(red = 42) {
  return sharp({
    create: {
      width: 24,
      height: 16,
      channels: 3,
      background: { r: red, g: 91, b: 173 },
    },
  }).png().toBuffer();
}

async function workbookBytes() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工资最终件" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>合成工资材料</t></is></c><c r="B1"><v>100</v></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function sourceReview({ reimbursement = [], salary = [] } = {}) {
  return {
    kind: "disbursement-source-review-v2",
    version: 2,
    id: "review-envelope",
    producer: "task_internal",
    generatedAt: "2031-05-01T00:00:00.000Z",
    reimbursement,
    salary,
  };
}

function reimbursementReview(reviewedFileIds = ["evidence-1"]) {
  return {
    id: "review-reimbursement",
    sourceId: "source-1",
    mode: "fresh_evidence",
    reviewedFileIds,
    facts: {
      batchId: "fresh-batch",
      reimbursementPeriod: { start: "2031-04-01", end: "2031-04-30" },
      transactions: [
        { id: "TX-1", date: "2031-04-12", person: "合成人员甲", reimbursementAmount: "10.25" },
      ],
    },
  };
}

function freshInput(sourceFiles, review = reimbursementReview(), overrides = {}) {
  return {
    sourceFiles,
    reimbursementSources: [{
      id: "source-1",
      profileId: "xiaohongshu",
      mode: "fresh_evidence",
      inputFileIds: sourceFiles.filter((file) => file.usage.includes("fresh_reimbursement_evidence")).map((file) => file.id),
      ...overrides,
    }],
    salaryArtifacts: [],
    sourceReview: sourceReview({ reimbursement: [review] }),
  };
}

function salaryReview(reviewedFileIds = ["salary-file"], overrides = {}) {
  return {
    id: "review-salary",
    salaryArtifactId: "salary-slot",
    mode: "final_artifact",
    reviewedFileIds,
    facts: {
      month: "2031-04",
      salaryCategoryId: "operations",
      salaryCategoryName: "运营工资",
      finalArtifactKind: "workbook",
      storeReference: "2031/04/operations/final.xlsx",
      grossPayTotal: "100",
      payments: [
        { id: "PAY-1", subject: "合成人员甲", amount: "60" },
        { id: "PAY-2", subject: "合成人员乙", amount: "40" },
      ],
      ...overrides,
    },
  };
}

function salaryInput(sourceFiles, review, artifactOverrides = {}) {
  return {
    sourceFiles,
    reimbursementSources: [],
    salaryArtifacts: [{
      id: "salary-slot",
      month: "2031-04",
      salaryCategoryId: "operations",
      salaryCategoryName: "运营工资",
      finalArtifactKind: "workbook",
      fileId: "salary-file",
      storeReference: "2031/04/operations/final.xlsx",
      ...artifactOverrides,
    }],
    sourceReview: sourceReview({ salary: [review] }),
  };
}

test("fresh image, text, and workbook evidence pass without manifest or receipt sidecars", async (t) => {
  for (const scenario of [
    { kind: "image", name: "evidence.png", bytes: await pngBytes() },
    { kind: "text", name: "evidence.txt", bytes: Buffer.from("合成报销说明 10.25 元\n", "utf8") },
    { kind: "workbook", name: "evidence.xlsx", bytes: await workbookBytes() },
  ]) {
    await t.test(scenario.kind, async (st) => {
      const root = await tempRoot(st);
      const source = await writeSource(root, {
        id: "evidence-1",
        name: scenario.name,
        bytes: scenario.bytes,
        kind: scenario.kind,
        usage: ["fresh_reimbursement_evidence"],
      });
      const result = await auditDisbursementFreshSourcesV2(freshInput([source]));
      assert.equal(result.kind, DISBURSEMENT_FRESH_SOURCE_AUDIT_V2_KIND);
      assert.equal(result.transactions.length, 1);
      assert.equal(result.reimbursementResults[0].semanticBasis, "task_internal_review_bound");
      assert.deepEqual(result.boundSourcePaths, [source.path]);
      assert.deepEqual(result.boundSourceDigests, [source.sha256]);
      assert.equal(result.fileBindings[0].verification.mode, scenario.kind === "image"
        ? "full-pixel-decode"
        : scenario.kind === "workbook" ? "safe-ooxml-structure" : "strict-utf8-text");
    });
  }
});

test("fresh evidence rejects incomplete review bindings and missing transaction facts before reading undeclared material", async (t) => {
  const root = await tempRoot(t);
  const first = await writeSource(root, { id: "evidence-1", name: "one.txt", bytes: "first", kind: "text", usage: ["fresh_reimbursement_evidence"] });
  const second = await writeSource(root, { id: "evidence-2", name: "two.txt", bytes: "second", kind: "text", usage: ["fresh_reimbursement_evidence"] });
  await assert.rejects(
    auditDisbursementFreshSourcesV2(freshInput([first, second], reimbursementReview(["evidence-1"]))),
    /reviewedFileIds.*missing evidence-2/iu,
  );
  const noTransactions = reimbursementReview();
  noTransactions.facts.transactions = [];
  await assert.rejects(
    auditDisbursementFreshSourcesV2(freshInput([first], noTransactions)),
    /missing transaction business facts/iu,
  );
});

test("fresh evidence rejects changed bytes, kind disguise, and damaged image payloads", async (t) => {
  await t.test("changed bytes", async (st) => {
    const root = await tempRoot(st);
    const source = await writeSource(root, { id: "evidence-1", name: "changed.txt", bytes: "before", kind: "text", usage: ["fresh_reimbursement_evidence"] });
    await fs.writeFile(source.path, "after", "utf8");
    await assert.rejects(auditDisbursementFreshSourcesV2(freshInput([source])), /SHA-256 differs/iu);
  });
  await t.test("kind disguise", async (st) => {
    const root = await tempRoot(st);
    const source = await writeSource(root, { id: "evidence-1", name: "fake.txt", bytes: await pngBytes(), kind: "text", usage: ["fresh_reimbursement_evidence"] });
    await assert.rejects(auditDisbursementFreshSourcesV2(freshInput([source])), /declared kind text.*image/iu);
  });
  await t.test("damaged image", async (st) => {
    const root = await tempRoot(st);
    const valid = await pngBytes();
    const source = await writeSource(root, { id: "evidence-1", name: "broken.png", bytes: valid.subarray(0, Math.max(16, Math.floor(valid.length / 2))), kind: "image", usage: ["fresh_reimbursement_evidence"] });
    await assert.rejects(auditDisbursementFreshSourcesV2(freshInput([source])), /damaged|incompletely decodable|decode/iu);
  });
});

test("salary workbook and image pass without certificate and expose honest review-bound semantics", async (t) => {
  for (const scenario of [
    {
      kind: "workbook",
      name: "salary.xlsx",
      bytes: await workbookBytes(),
      review: salaryReview(),
      marker: "review_bound_no_frozen_salary_schema",
    },
    {
      kind: "image",
      name: "salary.png",
      bytes: await pngBytes(187),
      review: salaryReview(["salary-file"], { finalArtifactKind: "image", storeReference: "2031/04/operations/final.png" }),
      marker: "review_bound_no_ocr",
    },
  ]) {
    await t.test(scenario.kind, async (st) => {
      const root = await tempRoot(st);
      const source = await writeSource(root, { id: "salary-file", name: scenario.name, bytes: scenario.bytes, kind: scenario.kind, usage: ["salary_artifact"] });
      const result = await auditDisbursementFreshSourcesV2(salaryInput([source], scenario.review, {
        finalArtifactKind: scenario.kind,
        storeReference: scenario.review.facts.storeReference,
      }));
      assert.equal(result.salaryFacts[0].grossPayTotal, "100");
      assert.equal(result.salaryFacts[0].semanticBasis, scenario.marker);
      assert.deepEqual(result.salaryFacts[0].payments.map((payment) => payment.amount), ["60", "40"]);
      assert.equal(result.salaryResults[0].certificate, undefined);
    });
  }
});

test("salary review must close payments, gross total, month, category, and store reference", async (t) => {
  const scenarios = [
    ["payments/gross", { payments: [{ id: "PAY-1", subject: "合成人员甲", amount: "99" }] }, {}, /sum exactly to grossPayTotal/iu],
    ["month", { month: "2031-05" }, {}, /facts\.month conflicts/iu],
    ["category", { salaryCategoryId: "other" }, {}, /facts\.salaryCategoryId conflicts/iu],
    ["store reference", { storeReference: "2031/04/other/final.xlsx" }, {}, /facts\.storeReference conflicts/iu],
  ];
  for (const [name, factOverrides, artifactOverrides, error] of scenarios) {
    await t.test(name, async (st) => {
      const root = await tempRoot(st);
      const source = await writeSource(root, { id: "salary-file", name: "salary.xlsx", bytes: await workbookBytes(), kind: "workbook", usage: ["salary_artifact"] });
      await assert.rejects(
        auditDisbursementFreshSourcesV2(salaryInput([source], salaryReview(["salary-file"], factOverrides), artifactOverrides)),
        error,
      );
    });
  }
});

async function certificateCase(t, mutateCertificate) {
  const root = await tempRoot(t);
  const salaryFile = await writeSource(root, { id: "salary-file", name: "salary.xlsx", bytes: await workbookBytes(), kind: "workbook", usage: ["salary_artifact"] });
  const core = {
    kind: "salary-final-artifact-v1",
    version: 1,
    month: "2031-04",
    salaryCategoryId: "operations",
    salaryCategoryName: "运营工资",
    finalArtifactKind: "workbook",
    artifactSha256: salaryFile.sha256,
    storeReference: "2031/04/operations/final.xlsx",
    grossPayTotal: "100",
  };
  let certificate = { ...core, certificateDigest: canonicalDigest(core) };
  if (mutateCertificate) certificate = mutateCertificate(certificate);
  const certificateFile = await writeJsonSource(root, {
    id: "salary-certificate",
    name: "salary-certificate.json",
    usage: ["salary_certificate_attestation"],
  }, certificate);
  const review = salaryReview(["salary-file", "salary-certificate"]);
  return salaryInput([salaryFile, certificateFile], review, {
    attestation: { salaryCertificateFileId: "salary-certificate" },
  });
}

test("optional salary certificate passes when exact and rejects corruption or conflict", async (t) => {
  await t.test("exact", async (st) => {
    const result = await auditDisbursementFreshSourcesV2(await certificateCase(st));
    assert.equal(result.salaryResults[0].certificate.mode, "salary-final-artifact-v1");
  });
  await t.test("bad digest", async (st) => {
    const input = await certificateCase(st, (certificate) => ({ ...certificate, certificateDigest: "0".repeat(64) }));
    await assert.rejects(auditDisbursementFreshSourcesV2(input), /certificateDigest is invalid/iu);
  });
  await t.test("malformed JSON", async (st) => {
    const input = await certificateCase(st);
    const certificateFile = input.sourceFiles.find((file) => file.id === "salary-certificate");
    const damaged = Buffer.from('{"kind":"salary-final-artifact-v1",', "utf8");
    await fs.writeFile(certificateFile.path, damaged);
    certificateFile.sha256 = sha256Bytes(damaged);
    await assert.rejects(auditDisbursementFreshSourcesV2(input), /JSON safety validation failed/iu);
  });
  await t.test("conflicting gross", async (st) => {
    const input = await certificateCase(st, (certificate) => {
      const core = { ...certificate, grossPayTotal: "101" };
      delete core.certificateDigest;
      return { ...core, certificateDigest: canonicalDigest(core) };
    });
    await assert.rejects(auditDisbursementFreshSourcesV2(input), /grossPayTotal conflicts/iu);
  });
});

test("optional original manifest and receipt are verified no-follow and must agree with review facts", async (t) => {
  const root = await tempRoot(t);
  const fixture = await createCompactDisbursementProductionFixture({
    root,
    profileIds: ["xiaohongshu"],
    reimbursementTransactionCount: 2,
    includeSalary: false,
    requestedUniqueVoucherCount: 1,
  });
  const material = fixture.originalManifest.files.find((file) => file.id === "MATERIAL-1");
  const evidence = {
    id: "evidence-1",
    path: material.path,
    sha256: material.sha256,
    kind: "image",
    usage: ["fresh_reimbursement_evidence"],
  };
  const manifestFile = {
    id: "original-manifest",
    path: fixture.originalManifestFile.path,
    sha256: fixture.originalManifestFile.sha256,
    kind: "json",
    usage: ["original_manifest_attestation"],
  };
  const receiptFile = {
    id: "publish-receipt",
    path: fixture.receiptFile.path,
    sha256: fixture.receiptFile.sha256,
    kind: "json",
    usage: ["publish_receipt_attestation"],
  };
  const review = reimbursementReview(["evidence-1", "original-manifest", "publish-receipt"]);
  review.facts.batchId = fixture.originalManifest.batch.batchId;
  review.facts.reimbursementPeriod = fixture.originalManifest.batch.mainPeriod;
  review.facts.transactions = fixture.originalManifest.transactions.map((transaction) => ({
    id: transaction.id,
    date: transaction.date,
    person: transaction.person,
    reimbursementAmount: transaction.reimbursementAmount,
  }));
  const input = freshInput([evidence, manifestFile, receiptFile], review, {
    attestations: {
      originalManifestFileId: "original-manifest",
      receiptFileId: "publish-receipt",
    },
  });
  const result = await auditDisbursementFreshSourcesV2(input);
  assert.equal(result.reimbursementResults[0].originalManifestAttestation.referencedPathsFollowed, false);
  assert.equal(result.reimbursementResults[0].receiptAttestation.referencedPathsFollowed, false);
  const conflict = structuredClone(input);
  conflict.sourceReview.reimbursement[0].facts.transactions[0].reimbursementAmount = "1";
  await assert.rejects(auditDisbursementFreshSourcesV2(conflict), /originalManifestAttestation\.transactions conflicts/iu);

  const receiptCore = { ...fixture.receipt, batchId: "different-batch" };
  delete receiptCore.receiptDigest;
  const conflictingReceipt = { ...receiptCore, receiptDigest: canonicalDigest(receiptCore) };
  const conflictingReceiptBytes = Buffer.from(`${JSON.stringify(conflictingReceipt)}\n`, "utf8");
  await fs.writeFile(receiptFile.path, conflictingReceiptBytes);
  const receiptConflictInput = structuredClone(input);
  receiptConflictInput.sourceFiles.find((file) => file.id === "publish-receipt").sha256 = sha256Bytes(conflictingReceiptBytes);
  await assert.rejects(auditDisbursementFreshSourcesV2(receiptConflictInput), /receiptAttestation\.batchId conflicts/iu);
});
