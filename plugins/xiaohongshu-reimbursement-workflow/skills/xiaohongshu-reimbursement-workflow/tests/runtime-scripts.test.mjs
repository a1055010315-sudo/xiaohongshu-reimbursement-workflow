import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlan, validatePlan } from "../scripts/ledger_reorder_common.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");
const summaryScript = path.join(skillRoot, "scripts", "build_reimbursement_summary.mjs");
let tempDir;
let baselinePath;
let materialPath;
let baselineSha256;
let materialSha256;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runJsonScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  assert.ok(jsonLine, `Expected JSON output; got: ${lines.join(" | ")}`);
  return { status: result.status, payload: JSON.parse(jsonLine) };
}

function makeManifest({ date = "2024-02-29", reviewRevision = 1, batchExtra = {} } = {}) {
  return {
    version: 1,
    rulesVersion: "anonymous-runtime-test-v2",
    batch: {
      rootPath: tempDir,
      archivePath: path.join(tempDir, "archive-not-created"),
      period: "2024-02-01—2024-02-29",
      targetCategory: "小红书报销",
      reviewRevision,
      ...batchExtra,
    },
    files: [
      { id: "baseline", role: "baseline", path: baselinePath, sha256: baselineSha256 },
      {
        id: "IMG-001",
        role: "material",
        kind: "image",
        disposition: "used",
        path: materialPath,
        sha256: materialSha256,
      },
    ],
    transactions: [
      {
        id: "TX-001",
        date,
        person: "匿名甲",
        project: "匿名项目",
        label: "匿名甲",
        amount: "1",
        category: "小红书报销",
        reimbursable: true,
        evidence: ["IMG-001"],
      },
    ],
    expectedFeeTotal: "1",
    expectedRealTotal: "1",
    expectedCategoryTotals: { 小红书报销: "1" },
  };
}

async function writeJson(name, value) {
  const filePath = path.join(tempDir, name);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { filePath, bytes };
}

function makeReorderPlan({ sourcePath, outputPath }) {
  return {
    version: 1,
    mode: "ledger-reorder-correction",
    sourcePath,
    outputPath,
    expectedSourceSha256: "0".repeat(64),
    sheetName: "Ledger",
    physicalRange: "A1:B1",
    scopeStart: "2026-06-01",
    scopeStartInclusive: true,
    scopeEnd: "2026-06-01",
    scopeEndInclusive: true,
    sortKeys: ["date:asc", "baselineOrder:asc"],
    stableTieBreaker: "baselineOrder",
    blankRowsPolicy: "preserve-physical",
    recordColumns: ["A", "B"],
    dateColumn: "A",
    amountColumn: "B",
    records: [{ id: "R1", row: 1, dateSortKey: "2026-06-01", baselineOrder: 1 }],
    expectedRecordCount: 1,
    expectedScopedRecordCount: 1,
    expectedScopedAmount: "0",
    expectedAmountDelta: "0",
  };
}

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-runtime-test-"));
  baselinePath = path.join(tempDir, "baseline.bin");
  materialPath = path.join(tempDir, "material.bin");
  const baselineBytes = Buffer.from("anonymous baseline\n", "utf8");
  const materialBytes = Buffer.from("anonymous material\n", "utf8");
  await Promise.all([
    fs.writeFile(baselinePath, baselineBytes, { flag: "wx" }),
    fs.writeFile(materialPath, materialBytes, { flag: "wx" }),
  ]);
  baselineSha256 = sha256(baselineBytes);
  materialSha256 = sha256(materialBytes);
});

test.after(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("manifest accepts a leap-day date and reports the raw-byte SHA256", async () => {
  const { filePath, bytes } = await writeJson("valid-manifest.json", makeManifest());
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 0);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.validatorVersion, "4");
  assert.equal(result.payload.manifestFileSha256, sha256(bytes));
});

test("manifest rejects impossible calendar dates", async () => {
  const { filePath } = await writeJson("invalid-date-manifest.json", makeManifest({ date: "2026-02-30" }));
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /valid ISO date/);
});

test("manifest rejects persisted authorization and unsafe review revisions", async (context) => {
  await context.test("authorization alias", async () => {
    const { filePath } = await writeJson(
      "authorization-manifest.json",
      makeManifest({ batchExtra: { isApproved: true } }),
    );
    const result = runJsonScript(auditScript, [filePath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /must not persist/);
  });
  await context.test("unsafe integer", async () => {
    const { filePath } = await writeJson(
      "unsafe-revision-manifest.json",
      makeManifest({ reviewRevision: Number.MAX_SAFE_INTEGER + 1 }),
    );
    const result = runJsonScript(auditScript, [filePath]);
    assert.equal(result.status, 1);
    assert.match(result.payload.error, /safe integer/);
  });
});

test("manifest rejects invalid UTF-8 before JSON parsing", async () => {
  const filePath = path.join(tempDir, "invalid-utf8-manifest.json");
  await fs.writeFile(filePath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), { flag: "wx" });
  const result = runJsonScript(auditScript, [filePath]);
  assert.equal(result.status, 1);
  assert.equal(result.payload.ok, false);
});

test("ledger reorder plan rejects source and output paths that differ only by Windows casing", {
  skip: process.platform !== "win32",
}, () => {
  const sourcePath = path.join(tempDir, "Case-Sensitive-Looking.xlsx");
  const outputPath = sourcePath.toLowerCase();
  assert.throws(
    () => validatePlan(makeReorderPlan({ sourcePath, outputPath })),
    /sourcePath and outputPath must be different/,
  );
});

test("ledger reorder plan rejects invalid UTF-8 before JSON parsing", async () => {
  const filePath = path.join(tempDir, "invalid-utf8-reorder-plan.json");
  await fs.writeFile(filePath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), { flag: "wx" });
  await assert.rejects(loadPlan(filePath), /Unable to read plan/);
});

test("summary requires the target category and still computes mixed-category totals", async () => {
  const noTarget = await writeJson("summary-no-target.json", {
    period: "2026年8月1日-8月2日",
    targetCategory: "小红书报销",
    entries: [{ category: "公司报销", label: "匿名甲", amount: "1", reimbursable: true }],
  });
  const rejected = runJsonScript(summaryScript, ["--input", noTarget.filePath, "--preview"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.payload.error, /target-category/);

  const valid = await writeJson("summary-valid.json", {
    period: "2026年8月1日-8月2日",
    targetCategory: "小红书报销",
    entries: [
      { category: "小红书报销", label: "匿名甲", amount: "1.25", reimbursable: true },
      { category: "小红书报销", label: "匿名对公", amount: "2", reimbursable: false },
      { category: "公司报销", label: "匿名乙", amount: "3", reimbursable: true },
    ],
    expectedFeeTotal: "3.25",
    expectedRealTotal: "1.25",
    expectedCategoryTotals: { 小红书报销: "3.25", 公司报销: "3" },
  });
  const accepted = runJsonScript(summaryScript, ["--input", valid.filePath, "--preview"]);
  assert.equal(accepted.status, 0);
  assert.equal(accepted.payload.feeTotal, "3.25");
  assert.equal(accepted.payload.realTotal, "1.25");
  assert.match(accepted.payload.summary, /费用合计：3\.25/);
  assert.match(accepted.payload.summary, /实报合计：1\.25/);
});
