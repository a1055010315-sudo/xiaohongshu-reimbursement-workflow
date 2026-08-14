import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  digestObject,
  loadContracts,
  normalizeBatchPlan,
  parseAmount,
  preflightWorkbook,
  rowHeightFor,
} from "../scripts/reimbursement_workbook_common.mjs";
import { validateAuditCertificate } from "../scripts/audit_reimbursement_candidates.mjs";

let tempRoot;

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-profile-contract-"));
});

test.after(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("profile and style contracts agree on protected ledger-root semantics", async () => {
  const { profileConfig, styleContract } = await loadContracts();
  assert.deepEqual(profileConfig.profileOrder, ["xiaohongshu", "company", "residence"]);
  assert.deepEqual(profileConfig.semanticColumns.ledgerRoot, {
    A: "date", B: "project", C: "amount", D: "groupTotal", E: "personOrSubject", F: "classification",
  });
  assert.deepEqual(profileConfig.semanticColumns, styleContract.semanticColumns);
  assert.equal(styleContract.mergeContract.requireIdenticalRangeAcrossBusinessGroupColumns, true);
  assert.equal(styleContract.mergeContract.verifyNonAnchorOOXMLIsEmpty, true);
  assert.equal(styleContract.allowedProfileOverrides.company, "blue-role-override");
  assert.equal(profileConfig.profiles.residence.protectedSheets, "all-except-editable");
  assert.deepEqual(profileConfig.profiles.residence.requiredProtectedSheetGroups, [
    ["驻所收入", "住所收入"],
    ["驻所工资", "住所工资"],
  ]);
});

test("one, two, and three profiles normalize in fixed order and xhs is only an input alias", async () => {
  const { profileConfig } = await loadContracts();
  const makeProfile = (id) => ({
    baselinePath: path.join(tempRoot, profileConfig.profileDirectories[id], profileConfig.profiles[id].rootWorkbookNames[0]),
    candidatePath: path.join(tempRoot, `${id}-candidate.xlsx`),
    controlledSegment: { startDate: "2026-06-01" },
    transactions: [{ id: `${id}-1`, date: "2026-08-01", project: "匿名项目", amount: "1", person: "匿名人员", classification: "运营开支" }],
  });
  for (const requested of [["xhs"], ["company", "xhs"], ["residence", "company", "xhs"]]) {
    const profiles = {};
    for (const key of requested) profiles[key] = makeProfile(key === "xhs" ? "xiaohongshu" : key);
    const result = await normalizeBatchPlan({ version: 1, affectedProfiles: requested, profiles });
    assert.deepEqual(result.affectedProfiles, ["xiaohongshu", "company", "residence"].filter((id) => requested.includes(id) || (id === "xiaohongshu" && requested.includes("xhs"))));
  }
});

test("profiles keys must exactly match affectedProfiles", async () => {
  const { profileConfig } = await loadContracts();
  const makeProfile = (id) => ({
    baselinePath: path.join(tempRoot, profileConfig.profileDirectories[id], profileConfig.profiles[id].rootWorkbookNames[0]),
    candidatePath: path.join(tempRoot, `${id}-candidate.xlsx`),
    controlledSegment: { startDate: "2026-06-01" },
    transactions: [{ id: `${id}-1`, date: "2026-08-01", project: "匿名项目", amount: "1", person: "匿名人员", classification: "运营开支" }],
  });
  await assert.rejects(
    normalizeBatchPlan({
      version: 1,
      affectedProfiles: ["xiaohongshu"],
      profiles: {
        xiaohongshu: makeProfile("xiaohongshu"),
        company: makeProfile("company"),
      },
    }),
    /exactly match affectedProfiles/u,
  );
  await assert.rejects(
    normalizeBatchPlan({
      version: 1,
      affectedProfiles: ["xiaohongshu", "company"],
      profiles: { xhs: makeProfile("xiaohongshu") },
    }),
    /exactly match affectedProfiles/u,
  );
});

test("amount precision and row height follow the executable contract", () => {
  assert.equal(parseAmount("100", "amount").decimals, 0);
  assert.equal(parseAmount("10.5", "amount").decimals, 2);
  assert.equal(parseAmount("10.125", "amount").decimals, 3);
  assert.throws(() => parseAmount("1.2345", "amount"), /three places/u);
  assert.throws(() => parseAmount("-0.00", "amount"), /negative zero/u);
  assert.equal(rowHeightFor({ project: "短项目", classification: "运营开支" }), 30);
  assert.ok(rowHeightFor({ project: "很长的项目说明".repeat(12), classification: "运营开支" }) > 30);
});

test("the right ledger filename under the wrong parent directory is rejected", async () => {
  const { profileConfig } = await loadContracts();
  const raw = {
    version: 1,
    affectedProfiles: ["xiaohongshu"],
    profiles: {
      xiaohongshu: {
        baselinePath: path.join(tempRoot, "wrong-parent", profileConfig.profiles.xiaohongshu.rootWorkbookNames[0]),
        candidatePath: path.join(tempRoot, "candidate.xlsx"),
        controlledSegment: { startDate: "2026-06-01" },
        transactions: [{ date: "2026-08-01", project: "匿名", amount: "1", person: "匿名", classification: "运营开支" }],
      },
    },
  };
  await assert.rejects(normalizeBatchPlan(raw), /parent directory.*whitelist/u);
});

test("audit certificate rejects forged canonical digest", () => {
  const core = {
    ok: true,
    profileId: "xiaohongshu",
    baselinePath: path.join(tempRoot, "baseline.xlsx"),
    baselineSha256: "a".repeat(64),
    candidatePath: path.join(tempRoot, "candidate.xlsx"),
    candidateSha256: "b".repeat(64),
    sheetName: "Sheet1",
    headerRow: 1,
    appendStartRow: 2,
    appendEndRow: 2,
    transactionCount: 1,
    groupCount: 1,
    protectedSheetCount: 0,
    planDigest: "c".repeat(64),
    styleContractDigest: "d".repeat(64),
    profileConfigDigest: "e".repeat(64),
    visualExceptions: [],
  };
  const accepted = { ...core, auditDigest: digestObject(core) };
  assert.equal(validateAuditCertificate(accepted), accepted);
  assert.throws(() => validateAuditCertificate({ ...accepted, transactionCount: 2 }), /auditDigest/u);
});

test("a hidden populated business row is structural drift while an empty hidden row is ignored", async () => {
  const { profileConfig, styleContract } = await loadContracts();
  const profile = { profileId: "xiaohongshu", config: profileConfig.profiles.xiaohongshu, transactions: [{ date: "2026-08-01" }], controlledSegment: { startDate: "2026-06-01" } };
  const style = { horizontal: "center", vertical: "center", wrapText: true, shrinkToFit: false, font: null, fill: null, border: null };
  const cells = new Map();
  profile.config.rootSheet.headerFingerprints[0].forEach((value, index) => cells.set(`${String.fromCharCode(65 + index)}1`, { value, formula: null, hasPayload: true, style }));
  cells.set("C2", { value: "1", formula: null, hasPayload: true, style });
  const sheet = { name: "Sheet1", cells, merges: [], rows: new Map([[2, { hidden: true }], [3, { hidden: true }]]), columns: [{ min: 1, max: 6, width: 17.375, hidden: false }], maxUsedRow: 3 };
  const result = preflightWorkbook({ sheets: [sheet] }, profile, styleContract);
  assert.ok(result.blocking.some((issue) => issue.code === "HIDDEN_BUSINESS_ROW" && issue.row === 2));
  assert.equal(result.issues.some((issue) => issue.code === "HIDDEN_BUSINESS_ROW" && issue.row === 3), false);
});
