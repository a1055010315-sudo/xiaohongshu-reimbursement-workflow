import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

import { auditReimbursementCandidates } from "../scripts/audit_reimbursement_candidates.mjs";
import { buildReimbursementCandidates } from "../scripts/build_reimbursement_candidates.mjs";
import { loadContracts } from "../scripts/reimbursement_workbook_common.mjs";

let tempRoot;

async function makeAnonymousBaseline({ protectedFormula = null } = {}) {
  const { profileConfig, styleContract } = await loadContracts();
  const config = profileConfig.profiles.xiaohongshu;
  const profileDirectory = path.join(tempRoot, profileConfig.profileDirectories.xiaohongshu);
  await fs.mkdir(profileDirectory, { recursive: true });
  const baselinePath = path.join(profileDirectory, config.rootWorkbookNames[0]);
  const workbook = Workbook.create();
  const editable = workbook.worksheets.add("Sheet1");
  const protectedSheet = workbook.worksheets.add("Protected");
  editable.getRange("A1:F1").values = [config.rootSheet.headerFingerprints[0]];
  editable.getRange("A2:F2").values = [[new Date("2026-07-24T00:00:00Z"), "Legacy", 24, null, "Anonymous", "Operations"]];
  editable.getRange("D2").formulas = [["=SUM(C2:C2)"]];
  editable.getRange("A2").format.numberFormat = styleContract.numberFormats.date;
  editable.getRange("C2:D2").format.numberFormat = "0";
  for (const column of ["A", "B", "C", "D", "E", "F"]) editable.getRange(`${column}1`).format.columnWidth = styleContract.layout.columnWidths.ledgerRoot[column];
  if (protectedFormula) protectedSheet.getRange("A1").formulas = [[protectedFormula]];
  else protectedSheet.getRange("A1").values = [["Unrelated protected content"]];
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(baselinePath);
  await fs.unlink(`${baselinePath}.inspect.ndjson`).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return baselinePath;
}

function planFor(baselinePath, candidateName) {
  return {
    version: 1,
    batchId: "anonymous-dependency-guard",
    affectedProfiles: ["xhs"],
    profiles: {
      xhs: {
        baselinePath,
        candidatePath: path.join(tempRoot, candidateName),
        candidateRevision: 2,
        controlledSegment: { startDate: "2026-06-01" },
        transactions: [{
          id: "ANON-NEW",
          sourceOrder: 1,
          date: "2026-07-03",
          project: "New item",
          amount: "3.25",
          person: "Anonymous",
          classification: "Operations",
          rowType: "expense",
          settlement: "employee_reimbursement",
        }],
      },
    },
  };
}

test.beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-dependency-guard-"));
});

test.afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("a protected-sheet formula that directly references controlled C rows blocks construction", async () => {
  const baselinePath = await makeAnonymousBaseline({ protectedFormula: "='Sheet1'!C2" });
  const plan = planFor(baselinePath, "blocked.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /CONTROLLED_SEGMENT_DEPENDENCY:xiaohongshu:protected-formula:Protected!A1/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath), (error) => error?.code === "ENOENT");
});

test("the guard includes a newly extended output row when the baseline controlled segment ends earlier", async () => {
  const baselinePath = await makeAnonymousBaseline({ protectedFormula: "='Sheet1'!C3" });
  const plan = planFor(baselinePath, "blocked-future-row.xlsx");
  await assert.rejects(buildReimbursementCandidates(plan), /CONTROLLED_SEGMENT_DEPENDENCY:xiaohongshu:protected-formula:Protected!A1/u);
  await assert.rejects(fs.access(plan.profiles.xhs.candidatePath), (error) => error?.code === "ENOENT");
});

test("a workbook with no controlled-row dependency builds and passes the independent audit", async () => {
  const baselinePath = await makeAnonymousBaseline();
  const plan = planFor(baselinePath, "safe.xlsx");
  assert.equal((await buildReimbursementCandidates(plan)).ok, true);
  assert.equal((await auditReimbursementCandidates(plan)).ok, true);
});
