import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveLedgerLayout, displayDecimalsForAmount } from "../scripts/derive_ledger_layout.mjs";
import { auditLedgerLayout } from "../scripts/audit_ledger_layout.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SUPERSEDED_PATH = path.resolve("candidate-superseded.xlsx");

function bytesSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function business(record) {
  return {
    date: record.date,
    project: record.project,
    amount: record.amount,
    person: record.person,
    classification: record.classification,
    rowType: record.rowType,
    settlement: record.settlement,
  };
}

function records() {
  return [
    {
      id: "R1",
      sourceOrder: 10,
      date: "2026-06-01",
      project: "整数项目",
      amount: "100",
      person: "甲",
      classification: "备注A",
      rowType: "expense",
      settlement: "employee_reimbursement",
      origin: "baseline",
      sourceIds: ["annotation:R1"],
    },
    {
      id: "R2",
      sourceOrder: 20,
      date: "2026-06-01",
      project: "两位项目",
      amount: "20.25",
      person: "甲",
      classification: "备注B",
      rowType: "expense",
      settlement: "employee_reimbursement",
      origin: "baseline",
      sourceIds: [],
    },
    {
      id: "R3",
      sourceOrder: 30,
      date: "2026-06-02",
      project: "跨日三位项目",
      amount: "1.625",
      person: "甲",
      classification: "备注B",
      rowType: "expense",
      settlement: "employee_reimbursement",
      origin: "baseline",
      sourceIds: [],
    },
    {
      id: "R4",
      sourceOrder: 40,
      date: "2026-06-02",
      project: "Z先录",
      amount: "5.20",
      person: "乙",
      classification: "备注C",
      rowType: "expense",
      settlement: "employee_reimbursement",
      origin: "baseline",
      sourceIds: [],
    },
    {
      id: "R5",
      sourceOrder: 50,
      date: "2026-06-02",
      project: "A后录",
      amount: "2",
      person: "乙",
      classification: "备注D",
      rowType: "expense",
      settlement: "employee_reimbursement",
      origin: "baseline",
      sourceIds: [],
    },
  ];
}

function validAuditPackage() {
  const expectedRecords = records();
  return {
    version: 1,
    baselineSha256: HASH_A,
    rebuildBaseSha256: HASH_A,
    candidateSha256: HASH_B,
    candidateRevision: 1,
    startRow: 2,
    expectedRecords,
    actualRows: [
      { row: 2, ...business(expectedRecords[0]), cDisplayDecimals: 0, dDisplayDecimals: 0, dFormula: null, dValue: "100" },
      { row: 3, ...business(expectedRecords[1]), cDisplayDecimals: 2, dDisplayDecimals: 3, dFormula: "=SUM(C3:C4)", dValue: "21.875" },
      { row: 4, ...business(expectedRecords[2]), cDisplayDecimals: 3, dDisplayDecimals: 3, dFormula: null, dValue: null },
      { row: 5, ...business(expectedRecords[3]), cDisplayDecimals: 2, dDisplayDecimals: 2, dFormula: null, dValue: "5.2" },
      { row: 6, ...business(expectedRecords[4]), cDisplayDecimals: 0, dDisplayDecimals: 0, dFormula: null, dValue: "2" },
    ],
    actualMerges: ["A2:A3", "A4:A6", "D3:D4", "E3:E4", "F3:F4"],
    sourceCoverage: [
      { sourceId: "annotation:R1", disposition: "transaction", transactionIds: ["R1"] },
      { sourceId: "reference:already", disposition: "already_in_baseline", baselineRecordFingerprint: HASH_C },
      { sourceId: "reference:non-target", disposition: "excluded_non_target", reason: "公司报销" },
    ],
    corrections: [
      {
        patchId: "PATCH-1",
        transactionId: "R1",
        sequence: 1,
        authorizedFields: ["classification"],
        before: { ...business(expectedRecords[0]), classification: "日常报销" },
        after: business(expectedRecords[0]),
        evidenceSourceId: "annotation:R1",
        supersededCandidate: {
          path: SUPERSEDED_PATH,
          sha256: HASH_C,
        },
      },
    ],
  };
}

test("display precision follows integer / two-place / explicit three-place policy", () => {
  assert.equal(displayDecimalsForAmount("100"), 0);
  assert.equal(displayDecimalsForAmount("5.20"), 2);
  assert.equal(displayDecimalsForAmount("93.5"), 2);
  assert.equal(displayDecimalsForAmount("1.625"), 3);
});

test("layout derives stable order, independent A merges, and semantic D/E/F groups", () => {
  const result = deriveLedgerLayout({ version: 1, startRow: 2, records: records().reverse() });
  assert.deepEqual(result.records.map((record) => record.id), ["R1", "R2", "R3", "R4", "R5"]);
  assert.deepEqual(result.records.map((record) => record.project), ["整数项目", "两位项目", "跨日三位项目", "Z先录", "A后录"]);
  assert.deepEqual(result.expectedMergeRanges, ["A2:A3", "A4:A6", "D3:D4", "E3:E4", "F3:F4"]);
  assert.equal(result.expenseGroups[1].formula, "=SUM(C3:C4)");
  assert.equal(result.expenseGroups[1].total, "21.875");
  assert.equal(result.expenseGroups[1].displayDecimals, 3);
  assert.equal(result.transactionCount, 5);
  assert.equal(result.amount, "129.075");
});

test("same classification is not enough when settlement differs", () => {
  const input = records();
  input[2].settlement = "company_paid_no_reimbursement";
  const result = deriveLedgerLayout({ version: 1, startRow: 2, records: input });
  assert.equal(result.expectedMergeRanges.includes("D3:D4"), false);
  assert.equal(result.expenseGroups.length, 5);
});

test("independent audit accepts the valid projection and correction chain", () => {
  const result = auditLedgerLayout(validAuditPackage());
  assert.equal(result.ok, true);
  assert.equal(result.transactionCount, 5);
  assert.equal(result.amount, "129.075");
  assert.equal(result.expenseGroupCount, 4);
  assert.equal(result.multiExpenseGroupCount, 1);
  assert.equal(result.mergeCount, 5);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.correctionCount, 1);
  assert.equal(result.supersededCandidateCount, 1);
});

test("independent audit rejects layout, order, formula, precision, patch, coverage, and baseline drift", async (context) => {
  const cases = [
    {
      name: "missing F merge",
      mutate: (input) => { input.actualMerges = input.actualMerges.filter((item) => item !== "F3:F4"); },
      error: /D\/E\/F expense-group merges/u,
    },
    {
      name: "same-date source order changed",
      mutate: (input) => {
        const left = input.actualRows[3];
        const right = input.actualRows[4];
        input.actualRows[3] = { ...right, row: 5 };
        input.actualRows[4] = { ...left, row: 6 };
      },
      error: /stable projection/u,
    },
    {
      name: "wrong group formula",
      mutate: (input) => { input.actualRows[1].dFormula = "=SUM(C2:C4)"; },
      error: /incorrect D formula/u,
    },
    {
      name: "integer forced to two decimals",
      mutate: (input) => { input.actualRows[0].cDisplayDecimals = 2; },
      error: /incorrect C display precision/u,
    },
    {
      name: "unauthorized amount mutation",
      mutate: (input) => { input.corrections[0].after.amount = "101"; },
      error: /changed fields do not equal authorizedFields/u,
    },
    {
      name: "bare exclusion disposition",
      mutate: (input) => { input.sourceCoverage[2].disposition = "excluded"; },
      error: /disposition is unsupported/u,
    },
    {
      name: "candidate rebuilt from superseded bytes",
      mutate: (input) => { input.rebuildBaseSha256 = HASH_C; },
      error: /bound baseline/u,
    },
    {
      name: "missing superseded candidate binding",
      mutate: (input) => { delete input.corrections[0].supersededCandidate; },
      error: /supersededCandidate must be an object/u,
    },
    {
      name: "relative superseded candidate path",
      mutate: (input) => { input.corrections[0].supersededCandidate.path = "candidate-old.xlsx"; },
      error: /path must be absolute/u,
    },
    {
      name: "invalid superseded candidate hash",
      mutate: (input) => { input.corrections[0].supersededCandidate.sha256 = "not-a-sha256"; },
      error: /SHA-256 digest/u,
    },
    {
      name: "unknown superseded candidate field",
      mutate: (input) => { input.corrections[0].supersededCandidate.revision = 24; },
      error: /unknown fields: revision/u,
    },
    {
      name: "unknown correction field",
      mutate: (input) => { input.corrections[0].supersededCandidatePath = SUPERSEDED_PATH; },
      error: /unknown fields: supersededCandidatePath/u,
    },
  ];
  for (const item of cases) {
    await context.test(item.name, () => {
      const input = structuredClone(validAuditPackage());
      item.mutate(input);
      assert.throws(() => auditLedgerLayout(input), item.error);
    });
  }
});

test("CLI verifies superseded candidate bytes against the bound SHA-256", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-ledger-audit-"));
  try {
    const baselinePath = path.join(tempRoot, "baseline.xlsx");
    const candidatePath = path.join(tempRoot, "candidate.xlsx");
    const supersededPath = path.join(tempRoot, "candidate-superseded.xlsx");
    const packagePath = path.join(tempRoot, "audit-package.json");
    const baselineBytes = Buffer.from("baseline-bytes", "utf8");
    const candidateBytes = Buffer.from("candidate-bytes", "utf8");
    const supersededBytes = Buffer.from("superseded-candidate-bytes", "utf8");
    await Promise.all([
      fs.writeFile(baselinePath, baselineBytes),
      fs.writeFile(candidatePath, candidateBytes),
      fs.writeFile(supersededPath, supersededBytes),
    ]);

    const input = validAuditPackage();
    input.baselineSha256 = bytesSha256(baselineBytes);
    input.rebuildBaseSha256 = input.baselineSha256;
    input.candidateSha256 = bytesSha256(candidateBytes);
    input.corrections[0].supersededCandidate = {
      path: supersededPath,
      sha256: bytesSha256(supersededBytes),
    };
    await fs.writeFile(packagePath, JSON.stringify(input), "utf8");

    const scriptPath = fileURLToPath(new URL("../scripts/audit_ledger_layout.mjs", import.meta.url));
    const args = [
      scriptPath,
      "--input", packagePath,
      "--baseline", baselinePath,
      "--candidate", candidatePath,
    ];
    const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).supersededCandidateCount, 1);

    input.corrections[0].supersededCandidate.sha256 = HASH_C;
    await fs.writeFile(packagePath, JSON.stringify(input), "utf8");
    const rejected = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Superseded candidate file SHA-256 does not match/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
