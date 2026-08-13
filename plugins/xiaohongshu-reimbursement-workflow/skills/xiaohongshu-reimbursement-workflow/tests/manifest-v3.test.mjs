import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

function runAudit(manifestPath) {
  const result = spawnSync(process.execPath, [auditScript, manifestPath], { encoding: "utf8" });
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
