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
  parseStrictJson,
  readStableUtf8JsonFile,
} from "../scripts/workflow_primitives.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");
const summaryScript = path.join(skillRoot, "scripts", "build_reimbursement_summary.mjs");

let tempDir;
let baselineFile;
let usedImageFile;
let excludedTextFile;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runAudit(manifestPath, scriptPath = auditScript) {
  const result = spawnSync(process.execPath, [scriptPath, manifestPath], { encoding: "utf8" });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  assert.ok(jsonLine, `Expected JSON output; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(jsonLine) };
}

function runSummary(manifestPath) {
  const result = spawnSync(process.execPath, [summaryScript, "--manifest", manifestPath, "--preview"], {
    encoding: "utf8",
  });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  assert.ok(jsonLine, `Expected summary JSON output; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(jsonLine) };
}

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

async function writeRawJson(name, raw) {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, raw, { encoding: "utf8", flag: "wx" });
  return filePath;
}

function fileEntry(id, role, fixture, extra = {}) {
  return { id, role, path: fixture.path, sha256: fixture.sha256, ...extra };
}

function makeManifest() {
  return {
    version: 3,
    rulesVersion: "anonymous-manifest-v3-test",
    batch: {
      batchId: "anonymous-batch-v3-001",
      rootPath: tempDir,
      archivePath: path.join(tempDir, "archive"),
      period: "2026-08-01—2026-08-02",
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      fileEntry("baseline", "baseline", baselineFile),
      fileEntry("IMG-001", "material", usedImageFile, {
        kind: "image",
        disposition: "used",
      }),
      fileEntry("TXT-EXCLUDED", "material", excludedTextFile, {
        kind: "text",
        disposition: "excluded",
        reason: "匿名范围外说明",
      }),
    ],
    sourceScopes: [
      {
        id: "SCOPE-IMAGE",
        fileId: "IMG-001",
        locator: "full-image",
        terminalConfirmed: true,
        expectedUnitCount: 2,
      },
      {
        id: "SCOPE-EXCLUDED",
        fileId: "TXT-EXCLUDED",
        locator: "full-text",
        terminalConfirmed: true,
        expectedUnitCount: 1,
      },
    ],
    sourceUnits: [
      { id: "UNIT-001", scopeId: "SCOPE-IMAGE", locator: "region-1", disposition: "used" },
      { id: "UNIT-002", scopeId: "SCOPE-IMAGE", locator: "region-2", disposition: "used" },
      {
        id: "UNIT-EXCLUDED",
        scopeId: "SCOPE-EXCLUDED",
        locator: "line-1",
        disposition: "excluded",
        reason: "匿名非报销内容",
      },
    ],
    transactions: [
      {
        id: "TX-001",
        sourceOrder: 1,
        date: "2026-08-01",
        person: "匿名甲",
        project: "匿名项目一",
        label: "匿名甲",
        classification: "运营开支",
        amount: "1.25",
        category: "小红书报销",
        settlement: "employee_reimbursement",
        evidence: ["IMG-001"],
        sourceRefs: ["UNIT-001"],
      },
      {
        id: "TX-002",
        sourceOrder: 2,
        date: "2026-08-02",
        person: "匿名乙",
        project: "匿名项目二",
        label: "匿名乙",
        classification: "日常报销",
        amount: "2.375",
        category: "小红书报销",
        settlement: "company_paid_no_reimbursement",
        evidence: ["IMG-001"],
        sourceRefs: ["UNIT-002"],
      },
    ],
    expectedFeeTotal: "3.625",
    expectedRealTotal: "1.25",
    expectedCategoryTotals: { 小红书报销: "3.625" },
  };
}

function makeMultiProfileManifest({ canonical = false } = {}) {
  const manifest = makeManifest();
  manifest.batch.targetCategory = canonical ? "小红书报销" : "小红书";
  manifest.sourceScopes[0].expectedUnitCount = 3;
  manifest.sourceUnits.push({
    id: "UNIT-003",
    scopeId: "SCOPE-IMAGE",
    locator: "region-3",
    disposition: "used",
  });
  manifest.transactions[0].category = canonical ? "小红书报销" : "小红书";
  manifest.transactions[1].category = canonical ? "公司报销" : "公司";
  manifest.transactions.push({
    id: "TX-003",
    sourceOrder: 3,
    date: "2026-08-02",
    person: "匿名丙",
    project: "匿名项目三",
    label: "匿名丙",
    classification: "驻所开支",
    amount: "3",
    category: canonical ? "驻所报销" : "住所",
    settlement: "employee_reimbursement",
    evidence: ["IMG-001"],
    sourceRefs: ["UNIT-003"],
  });
  manifest.expectedFeeTotal = "1.25";
  manifest.expectedRealTotal = "1.25";
  manifest.expectedCategoryTotals = canonical
    ? { 小红书报销: "1.25", 公司报销: "2.375", 驻所报销: "3" }
    : { 小红书: "1.25", 公司: "2.375", 住所: "3" };
  return manifest;
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-manifest-v3-test-"));
  await fs.mkdir(path.join(tempDir, "archive"));
  const fixtures = [];
  for (const [name, text] of [
    ["baseline.bin", "anonymous baseline\n"],
    ["used-image.bin", "anonymous used image\n"],
    ["excluded-text.bin", "anonymous excluded text\n"],
  ]) {
    const bytes = Buffer.from(text, "utf8");
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, bytes, { flag: "wx" });
    fixtures.push({ path: filePath, sha256: sha256(bytes) });
  }
  [baselineFile, usedImageFile, excludedTextFile] = fixtures;
});

test.after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("v3 reimbursement closes source coverage and emits normalized classification", async () => {
  const manifestPath = await writeJson("valid-v3.json", makeManifest());
  const result = runAudit(manifestPath);
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.validatorVersion, "4");
  assert.match(result.payload.sourceCoverageDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.payload.sourceCoverageCounts, {
    scopes: 2,
    units: 3,
    usedUnits: 2,
    excludedUnits: 1,
    referencedUnits: 2,
    transactionRefs: 2,
  });
  assert.deepEqual(
    result.payload.normalizedTransactions.map(({ id, classification, sourceRefs }) => ({
      id,
      classification,
      sourceRefs,
    })),
    [
      { id: "TX-001", classification: "运营开支", sourceRefs: ["UNIT-001"] },
      { id: "TX-002", classification: "日常报销", sourceRefs: ["UNIT-002"] },
    ],
  );

  const certificate = result.payload.reimbursementFactsCertificate;
  assert.equal(certificate.kind, "reimbursement-manifest-facts-v1");
  assert.equal(certificate.operationMode, "reimbursement-batch");
  assert.equal(canonicalDigest(certificate.factsPreimage), certificate.factsDigest);
  assert.equal(canonicalDigest(certificate.sourceCoveragePreimage), certificate.sourceCoverageDigest);
  const certificateBody = structuredClone(certificate);
  delete certificateBody.certificateDigest;
  assert.equal(canonicalDigest(certificateBody), certificate.certificateDigest);
  assert.deepEqual(certificate.factsPreimage.transactions, [
    {
      id: "TX-001",
      date: "2026-08-01",
      person: "匿名甲",
      project: "匿名项目一",
      label: "匿名甲",
      amount: "1.25",
      category: "小红书报销",
      profileId: "xiaohongshu",
      classification: "运营开支",
      sourceOrder: 1,
      settlement: "employee_reimbursement",
    },
    {
      id: "TX-002",
      date: "2026-08-02",
      person: "匿名乙",
      project: "匿名项目二",
      label: "匿名乙",
      amount: "2.375",
      category: "小红书报销",
      profileId: "xiaohongshu",
      classification: "日常报销",
      sourceOrder: 2,
      settlement: "company_paid_no_reimbursement",
    },
  ]);
  assert.deepEqual(certificate.sourceCoveragePreimage.transactionSourceRefs, [
    { transactionId: "TX-001", sourceRefs: ["UNIT-001"] },
    { transactionId: "TX-002", sourceRefs: ["UNIT-002"] },
  ]);
});

test("v3 enforces the minimal classification boundary without persisting authorization state", async () => {
  for (const [name, classification] of [
    ["generic", "人员工资"],
    ["concrete-project", "上海竞业2"],
  ]) {
    const manifest = makeManifest();
    manifest.transactions[0].classification = classification;
    const result = runAudit(await writeJson(`classification-${name}.json`, manifest));
    assert.equal(result.status, 0, JSON.stringify(result.payload));
    assert.equal(result.payload.normalizedTransactions[0].classification, classification);
    assert.equal(Object.hasOwn(result.payload.normalizedTransactions[0], "authorization"), false);
  }

  for (const classification of ["话费", "上海天崇", "东莞柯南"]) {
    const rejected = makeManifest();
    rejected.transactions[0].classification = classification;
    const result = runAudit(await writeJson(`classification-disallowed-${classification}.json`, rejected));
    assert.equal(result.status, 1);
    assert.match(result.payload.error, new RegExp(`classification.*${classification}.*expense description.*approved grouping`, "iu"));
  }
});

test("v3 reimbursement certificate exposes the exact multi-profile digest preimages", async () => {
  const result = runAudit(await writeJson("certificate-multi-profile.json", makeMultiProfileManifest()));
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  const certificate = result.payload.reimbursementFactsCertificate;
  assert.deepEqual(certificate.factsPreimage.affectedProfileIds, ["xiaohongshu", "company", "residence"]);
  assert.deepEqual(
    certificate.factsPreimage.transactions.map(({ id, profileId, sourceOrder }) => ({ id, profileId, sourceOrder })),
    [
      { id: "TX-001", profileId: "xiaohongshu", sourceOrder: 1 },
      { id: "TX-002", profileId: "company", sourceOrder: 2 },
      { id: "TX-003", profileId: "residence", sourceOrder: 3 },
    ],
  );
  assert.equal(canonicalDigest(certificate.factsPreimage), result.payload.factsDigest);
  assert.equal(canonicalDigest(certificate.sourceCoveragePreimage), result.payload.sourceCoverageDigest);
});

test("v3 ordinary reimbursement certificate preserves a bounded negative refund adjustment", async () => {
  const manifest = makeManifest();
  manifest.sourceScopes[0].expectedUnitCount = 3;
  manifest.sourceUnits.push({
    id: "UNIT-003",
    scopeId: "SCOPE-IMAGE",
    locator: "region-3",
    disposition: "used",
  });
  manifest.transactions.push({
    id: "TX-003",
    sourceOrder: 3,
    date: "2026-08-02",
    person: "匿名甲",
    project: "匿名退款",
    label: "匿名甲",
    classification: "运营开支",
    amount: "-0.25",
    category: "小红书报销",
    settlement: "employee_reimbursement",
    adjustment: {
      type: "refund",
      sourceTransactionId: "TX-001",
      reason: "脱敏退款",
    },
    evidence: ["IMG-001"],
    sourceRefs: ["UNIT-003"],
  });
  manifest.expectedFeeTotal = "3.375";
  manifest.expectedRealTotal = "1";
  manifest.expectedCategoryTotals = { 小红书报销: "3.375" };
  const result = runAudit(await writeJson("refund-v3.json", manifest));
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  const refund = result.payload.reimbursementFactsCertificate.factsPreimage.transactions
    .find((transaction) => transaction.id === "TX-003");
  assert.deepEqual(refund.adjustment, {
    type: "refund",
    sourceTransactionId: "TX-001",
    reason: "脱敏退款",
  });
  assert.equal(result.payload.categoryTotals["小红书报销"], "3.375");
  assert.equal(result.payload.categoryRealTotals["小红书报销"], "1");
});

test("v3 classification changes factsDigest without changing sourceCoverageDigest", async () => {
  const original = makeManifest();
  const changed = makeManifest();
  changed.transactions[0].classification = "匿名修正分类";
  const originalResult = runAudit(await writeJson("classification-original.json", original));
  const changedResult = runAudit(await writeJson("classification-changed.json", changed));
  assert.equal(originalResult.status, 0, JSON.stringify(originalResult.payload));
  assert.equal(changedResult.status, 0, JSON.stringify(changedResult.payload));
  assert.notEqual(originalResult.payload.factsDigest, changedResult.payload.factsDigest);
  assert.equal(originalResult.payload.sourceCoverageDigest, changedResult.payload.sourceCoverageDigest);
});

test("v3 source locator changes sourceCoverageDigest without changing factsDigest", async () => {
  const original = makeManifest();
  const changed = makeManifest();
  changed.sourceUnits[0].locator = "region-1-refined";
  const originalResult = runAudit(await writeJson("locator-original.json", original));
  const changedResult = runAudit(await writeJson("locator-changed.json", changed));
  assert.equal(originalResult.status, 0, JSON.stringify(originalResult.payload));
  assert.equal(changedResult.status, 0, JSON.stringify(changedResult.payload));
  assert.equal(originalResult.payload.factsDigest, changedResult.payload.factsDigest);
  assert.notEqual(originalResult.payload.sourceCoverageDigest, changedResult.payload.sourceCoverageDigest);
});

test("v3 manifest projects through the summary builder with source coverage binding", async () => {
  const manifestPath = await writeJson("summary-v3.json", makeManifest());
  const audited = runAudit(manifestPath);
  const summary = runSummary(manifestPath);
  assert.equal(audited.status, 0, JSON.stringify(audited.payload));
  assert.equal(summary.status, 0, JSON.stringify(summary.payload));
  assert.equal(summary.payload.sourceCoverageDigest, audited.payload.sourceCoverageDigest);
  assert.equal(summary.payload.factsDigest, audited.payload.factsDigest);
  assert.equal(summary.payload.feeTotal, "3.625");
  assert.equal(summary.payload.realTotal, "1.25");
});

test("v3 routes one normalized fact set to stable affected profiles without empty profiles", async () => {
  const manifestPath = await writeJson("multi-profile-aliases.json", makeMultiProfileManifest());
  const result = runAudit(manifestPath);
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  assert.match(result.payload.profileConfigDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.payload.batch.targetProfileId, "xiaohongshu");
  assert.equal(result.payload.batch.targetCategory, "小红书报销");
  assert.deepEqual(result.payload.affectedProfileIds, ["xiaohongshu", "company", "residence"]);
  assert.deepEqual(
    result.payload.normalizedTransactions.map(({ id, profileId, category }) => ({ id, profileId, category })),
    [
      { id: "TX-001", profileId: "xiaohongshu", category: "小红书报销" },
      { id: "TX-002", profileId: "company", category: "公司报销" },
      { id: "TX-003", profileId: "residence", category: "驻所报销" },
    ],
  );
  assert.deepEqual(
    result.payload.profileSummaries.map((profile) => ({
      profileId: profile.profileId,
      targetCategory: profile.targetCategory,
      transactionCount: profile.transactionCount,
      feeTotal: profile.feeTotal,
      realTotal: profile.realTotal,
      canonicalRootWorkbookName: profile.canonicalRootWorkbookName,
      managedRootSheetName: profile.managedRootSheetName,
      detailSheetName: profile.detailSheetName,
      screenshotMapSheetName: profile.screenshotMapSheetName,
      archiveDirectoryName: profile.archiveDirectoryName,
      archiveStem: profile.archiveStem,
      preserveUnmanagedSheets: profile.preserveUnmanagedSheets,
    })),
    [
      {
        profileId: "xiaohongshu",
        targetCategory: "小红书报销",
        transactionCount: 1,
        feeTotal: "1.25",
        realTotal: "1.25",
        canonicalRootWorkbookName: "小红书支出总表.xlsx",
        managedRootSheetName: "Sheet1",
        detailSheetName: "本次报销明细",
        screenshotMapSheetName: "小红书报销",
        archiveDirectoryName: "01_小红书专项",
        archiveStem: "小红书支出总表",
        preserveUnmanagedSheets: true,
      },
      {
        profileId: "company",
        targetCategory: "公司报销",
        transactionCount: 1,
        feeTotal: "2.375",
        realTotal: "0",
        canonicalRootWorkbookName: "公司支出总表.xlsx",
        managedRootSheetName: "公司支出",
        detailSheetName: "本次报销明细",
        screenshotMapSheetName: "公司报销",
        archiveDirectoryName: "02_公司专项",
        archiveStem: "公司支出总表",
        preserveUnmanagedSheets: true,
      },
      {
        profileId: "residence",
        targetCategory: "驻所报销",
        transactionCount: 1,
        feeTotal: "3",
        realTotal: "3",
        canonicalRootWorkbookName: "驻所支出.xlsx",
        managedRootSheetName: "驻所支出",
        detailSheetName: "本次报销明细",
        screenshotMapSheetName: "住所报销",
        archiveDirectoryName: "03_住所专项",
        archiveStem: "驻所支出",
        preserveUnmanagedSheets: true,
      },
    ],
  );

  const summary = runSummary(manifestPath);
  assert.equal(summary.status, 0, JSON.stringify(summary.payload));
  assert.equal(summary.payload.targetCategory, "小红书报销");
  assert.deepEqual(summary.payload.affectedProfileIds, ["xiaohongshu", "company", "residence"]);
  assert.equal(summary.payload.profileConfigDigest, result.payload.profileConfigDigest);
  assert.deepEqual(summary.payload.profileSummaries, result.payload.profileSummaries);
  assert.match(summary.payload.summary, /公司报销/u);
  assert.match(summary.payload.summary, /驻所报销/u);
  assert.doesNotMatch(summary.payload.summary, /住所报销/u);
});

test("v3 aliases and canonical profile names produce equivalent semantic and cache digests", async () => {
  const aliasResult = runAudit(
    await writeJson("multi-profile-alias-digest.json", makeMultiProfileManifest()),
  );
  const canonicalResult = runAudit(
    await writeJson("multi-profile-canonical-digest.json", makeMultiProfileManifest({ canonical: true })),
  );
  assert.equal(aliasResult.status, 0, JSON.stringify(aliasResult.payload));
  assert.equal(canonicalResult.status, 0, JSON.stringify(canonicalResult.payload));
  for (const field of [
    "manifestDigest",
    "transactionsDigest",
    "factsDigest",
    "configDigest",
    "cacheKey",
    "profileConfigDigest",
  ]) {
    assert.equal(aliasResult.payload[field], canonicalResult.payload[field], field);
  }
  assert.notEqual(aliasResult.payload.manifestFileSha256, canonicalResult.payload.manifestFileSha256);
});

test("v3 invalidates semantic and cache digests when the fixed profile registry changes", async () => {
  const manifestPath = await writeJson("profile-config-binding.json", makeMultiProfileManifest());
  const originalResult = runAudit(manifestPath);
  assert.equal(originalResult.status, 0, JSON.stringify(originalResult.payload));

  const isolatedSkill = path.join(tempDir, "isolated-profile-config-skill");
  const isolatedScripts = path.join(isolatedSkill, "scripts");
  const isolatedReferences = path.join(isolatedSkill, "references");
  await fs.mkdir(isolatedScripts, { recursive: true });
  await fs.mkdir(isolatedReferences, { recursive: true });
  await Promise.all([
    fs.copyFile(auditScript, path.join(isolatedScripts, "audit_batch_manifest.mjs")),
    fs.copyFile(
      path.join(skillRoot, "scripts", "finance_domain.mjs"),
      path.join(isolatedScripts, "finance_domain.mjs"),
    ),
    fs.copyFile(
      path.join(skillRoot, "scripts", "workflow_primitives.mjs"),
      path.join(isolatedScripts, "workflow_primitives.mjs"),
    ),
  ]);
  const profileConfig = JSON.parse(
    await fs.readFile(path.join(skillRoot, "references", "ledger-profiles.json"), "utf8"),
  );
  profileConfig.profiles.company.archiveStem = "公司支出总表_策略变更";
  await fs.writeFile(
    path.join(isolatedReferences, "ledger-profiles.json"),
    `${JSON.stringify(profileConfig, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const changedResult = runAudit(manifestPath, path.join(isolatedScripts, "audit_batch_manifest.mjs"));
  assert.equal(changedResult.status, 0, JSON.stringify(changedResult.payload));
  for (const field of ["profileConfigDigest", "factsDigest", "configDigest", "cacheKey"]) {
    assert.notEqual(originalResult.payload[field], changedResult.payload[field], field);
  }
  for (const field of ["manifestDigest", "transactionsDigest", "filesDigest", "sourceCoverageDigest"]) {
    assert.equal(originalResult.payload[field], changedResult.payload[field], field);
  }
});

test("v3 rejects an unknown profile category fail-closed", async () => {
  const manifest = makeMultiProfileManifest();
  manifest.transactions[1].category = "未登记类目";
  manifest.expectedCategoryTotals = { 小红书: "1.25", 未登记类目: "2.375", 住所: "3" };
  const result = runAudit(await writeJson("unknown-profile.json", manifest));
  assert.equal(result.status, 1);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /unknown reimbursement profile.*未登记类目/iu);
});

test("v3 source coverage rejects incomplete or contradictory states", async (context) => {
  const cases = [
    {
      name: "missing classification",
      mutate(manifest) {
        delete manifest.transactions[0].classification;
      },
      error: /classification.*string/,
    },
    {
      name: "transaction without sourceRefs",
      mutate(manifest) {
        delete manifest.transactions[0].sourceRefs;
      },
      error: /sourceRefs must be a non-empty array/,
    },
    {
      name: "duplicate sourceRefs",
      mutate(manifest) {
        manifest.transactions[0].sourceRefs = ["UNIT-001", "UNIT-001"];
      },
      error: /sourceRefs contains duplicate ids/,
    },
    {
      name: "missing source unit",
      mutate(manifest) {
        manifest.transactions[0].sourceRefs = ["UNIT-MISSING"];
      },
      error: /references missing source unit/,
    },
    {
      name: "excluded unit is referenced",
      mutate(manifest) {
        manifest.transactions[0].sourceRefs = ["UNIT-EXCLUDED"];
      },
      error: /references excluded source unit/,
    },
    {
      name: "used unit is orphaned",
      mutate(manifest) {
        manifest.sourceScopes[0].expectedUnitCount = 3;
        manifest.sourceUnits.push({
          id: "UNIT-ORPHAN",
          scopeId: "SCOPE-IMAGE",
          locator: "region-3",
          disposition: "used",
        });
      },
      error: /Used source unit is not referenced/,
    },
    {
      name: "source terminal is not confirmed",
      mutate(manifest) {
        manifest.sourceScopes[0].terminalConfirmed = false;
      },
      error: /terminalConfirmed must be true/,
    },
    {
      name: "source unit count differs from the confirmed boundary",
      mutate(manifest) {
        manifest.sourceScopes[0].expectedUnitCount = 3;
      },
      error: /expected 3 units but registered 2/,
    },
    {
      name: "unit disposition is neither used nor excluded",
      mutate(manifest) {
        manifest.sourceUnits[0].disposition = "pending";
      },
      error: /disposition must be used or excluded/,
    },
    {
      name: "source reference lacks its scope evidence file",
      mutate(manifest) {
        manifest.transactions[0].evidence = [];
        manifest.transactions[0].missingEvidenceConfirmed = true;
      },
      error: /requires evidence file IMG-001/,
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    await context.test(item.name, async () => {
      const manifest = makeManifest();
      item.mutate(manifest);
      const result = runAudit(await writeJson(`invalid-${index}.json`, manifest));
      assert.equal(result.status, 1);
      assert.equal(result.payload.ok, false);
      assert.match(result.payload.error, item.error);
    });
  }
});

test("shared strict JSON rejects decoded duplicate keys and unsafe parser inputs", () => {
  assert.throws(
    () => parseStrictJson('{"amount":"1","\\u0061mount":"2"}'),
    /duplicate object key/iu,
  );
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => parseStrictJson("[".repeat(140) + "]".repeat(140)), /nesting depth/iu);
  assert.throws(() => parseStrictJson("1e999"), /non-finite number/iu);
  assert.throws(() => parseStrictJson("{\"x\":1,}"), /expected.*string|duplicate|invalid/iu);
  assert.throws(() => parseStrictJson("{\"x\":1} trailing"), /trailing content/iu);
});

test("stable JSON reader returns a frozen value and rejects invalid UTF-8 and oversize input", async () => {
  const validBytes = Buffer.from('{"stable":{"value":1}}\n', "utf8");
  const validPath = await writeRawJson("stable-valid.json", validBytes);
  const snapshot = await readStableUtf8JsonFile(validPath, { maxBytes: 1024 });
  assert.equal(snapshot.size, validBytes.length);
  assert.equal(snapshot.sha256, sha256(validBytes));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.value), true);
  assert.equal(Object.isFrozen(snapshot.value.stable), true);
  assert.throws(() => { snapshot.value.stable.value = 2; }, TypeError);

  const invalidPath = path.join(tempDir, "stable-invalid-utf8.json");
  await fs.writeFile(invalidPath, Buffer.from([0xc3, 0x28]), { flag: "wx" });
  await assert.rejects(
    () => readStableUtf8JsonFile(invalidPath, { maxBytes: 1024 }),
    /UTF-8/iu,
  );

  const oversizedPath = await writeRawJson("stable-oversized.json", "1234567890");
  await assert.rejects(
    () => readStableUtf8JsonFile(oversizedPath, { maxBytes: 4 }),
    /bounded|size|maximum|exceeds|limit/iu,
  );
});

test("stable JSON reader bounds growth, detects replacement and same-size rewrites, and closes handles", async (t) => {
  await t.test("growth after open reads at most maxBytes plus one byte", async () => {
    const filePath = await writeRawJson("stable-growth.json", "{}\n");
    let bytesRead = 0;
    await assert.rejects(
      () => readStableUtf8JsonFile(filePath, {
        maxBytes: 64,
        testHooks: {
          afterOpen: async ({ phase }) => {
            if (phase === "initial") await fs.appendFile(filePath, "x".repeat(128), "utf8");
          },
          onRead: ({ totalBytes }) => { bytesRead = Math.max(bytesRead, totalBytes); },
        },
      }),
      /grown|changed|bounded|size/iu,
    );
    assert.ok(bytesRead <= 65, `reader consumed ${bytesRead} bytes`);
    await fs.rename(filePath, `${filePath}.renamed`);
  });

  await t.test("truncation after open is rejected within the original declared length", async () => {
    const raw = '{"x":1}\n';
    const declaredSize = Buffer.byteLength(raw, "utf8");
    const filePath = await writeRawJson("stable-truncated.json", raw);
    let bytesRead = 0;
    await assert.rejects(
      () => readStableUtf8JsonFile(filePath, {
        maxBytes: 1024,
        testHooks: {
          afterOpen: async ({ phase }) => {
            if (phase === "initial") await fs.truncate(filePath, 2);
          },
          onRead: ({ totalBytes }) => { bytesRead = Math.max(bytesRead, totalBytes); },
        },
      }),
      /truncated during read/iu,
    );
    assert.ok(bytesRead <= declaredSize, `reader consumed ${bytesRead} of ${declaredSize} declared bytes`);
    await fs.rename(filePath, `${filePath}.renamed`);
  });

  await t.test("replacement during read is rejected and the path can be renamed", async () => {
    const filePath = await writeRawJson("stable-replaced.json", '{"x":1}\n');
    const oldPath = `${filePath}.old`;
    await assert.rejects(
      () => readStableUtf8JsonFile(filePath, {
        maxBytes: 1024,
        testHooks: {
          afterOpen: async ({ phase }) => {
            if (phase !== "initial") return;
            await fs.rename(filePath, oldPath);
            await fs.writeFile(filePath, '{"x":2}\n', { encoding: "utf8", flag: "wx" });
          },
        },
      }),
      /identity|replaced|changed|path/iu,
    );
    await fs.rename(filePath, `${filePath}.renamed`);
    await fs.rename(oldPath, `${oldPath}.renamed`);
  });

  await t.test("same-size rewrite after the initial read is rejected by fresh hash", async () => {
    const filePath = await writeRawJson("stable-rewrite.json", '{"x":1}\n');
    await assert.rejects(
      () => readStableUtf8JsonFile(filePath, {
        maxBytes: 1024,
        testHooks: {
          afterInitialRead: async () => fs.writeFile(filePath, '{"x":2}\n', "utf8"),
        },
      }),
      /hash|changed|identity|stable/iu,
    );
    await fs.rename(filePath, `${filePath}.renamed`);
  });
});

test("manifest CLI rejects decoded duplicate keys before schema and emits no certificate", async (t) => {
  const base = JSON.stringify(makeManifest());
  const cases = [
    {
      name: "top-level version",
      raw: base.replace(
        '"version":3',
        '"version":3,"\\u0076ersion":3',
      ),
    },
    {
      name: "nested transaction amount",
      raw: base.replace(
        '"amount":"1.25"',
        '"amount":"1.25","amou\\u006et":"1.25"',
      ),
    },
    {
      name: "nested transaction sourceRefs",
      raw: base.replace(
        '"sourceRefs":["UNIT-001"]',
        '"sourceRefs":["UNIT-001"],"source\\u0052efs":["UNIT-001"]',
      ),
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const manifestPath = await writeRawJson(`duplicate-${item.name}.json`, item.raw);
      const result = spawnSync(process.execPath, [auditScript, manifestPath], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim(), "");
      assert.match(result.stderr, /duplicate object key/iu);
    });
  }
});
