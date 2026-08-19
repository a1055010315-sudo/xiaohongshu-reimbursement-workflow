import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReimbursementArtifacts,
  REIMBURSEMENT_ARTIFACT_BUILD_KIND,
} from "../scripts/build_reimbursement_artifacts.mjs";
import {
  getDetailContract,
  getScreenshotContract,
  getSupplementContract,
} from "../scripts/builtin_visual_contracts.mjs";
import { loadBundledDependency } from "../scripts/workflow_primitives.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

let tempRoot;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function fixture(name, bytes) {
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256(bytes) };
}

function transaction(profileId, category, sourceOrder, unitId, { supplement = false, supplementOverrides = {}, independentSupplementEvidence = false } = {}) {
  const value = {
    id: `TX-${sourceOrder}`,
    sourceOrder,
    date: supplement ? `2026-07-0${sourceOrder}` : `2026-08-0${sourceOrder}`,
    person: `匿名${profileId}`,
    project: `脱敏项目${sourceOrder}`,
    label: `匿名${profileId}`,
    classification: `脱敏分类${sourceOrder}`,
    amount: `${sourceOrder}.125`,
    category,
    settlement: sourceOrder === 2 ? "company_paid_no_reimbursement" : "employee_reimbursement",
    evidence: ["IMG-1"],
    sourceRefs: [unitId],
  };
  if (supplement) {
    Object.assign(value, {
      supplement: true,
      originalOccurrenceDate: value.date,
      supplementReason: "测试历史补报",
      sourceReference: unitId,
      ...supplementOverrides,
    });
    if (independentSupplementEvidence) {
      value.evidence.push("IMG-SUPPLEMENT");
      value.supplementEvidence = ["IMG-SUPPLEMENT"];
    }
  }
  return value;
}

async function auditedRequest(profileCount, { supplement = false, supplementOverrides = {}, independentSupplementEvidence = false, period = "2026-08-01—2026-08-03" } = {}) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const baseline = await fixture(`baseline-${profileCount}-${suffix}.bin`, Buffer.from(`baseline-${profileCount}\n`));
  const image = await fixture(`image-${profileCount}-${suffix}.png`, PNG);
  const supplementImage = independentSupplementEvidence
    ? await fixture(`supplement-image-${profileCount}-${suffix}.png`, PNG)
    : null;
  const all = [
    transaction("xiaohongshu", "小红书报销", 1, "UNIT-1", { supplement, supplementOverrides, independentSupplementEvidence }),
    transaction("company", "公司报销", 2, "UNIT-2", { supplement, supplementOverrides, independentSupplementEvidence }),
    transaction("residence", "驻所报销", 3, "UNIT-3", { supplement, supplementOverrides, independentSupplementEvidence }),
  ].slice(0, profileCount);
  const totals = Object.fromEntries(all.map((item) => [item.category, item.amount]));
  const real = all.filter((item) => item.settlement === "employee_reimbursement")
    .reduce((sum, item) => sum + BigInt(item.amount.replace(".", "")), 0n);
  const manifest = {
    version: 3,
    rulesVersion: "ordinary-reimbursement-artifact-test-v1",
    batch: {
      batchId: `artifact-batch-${profileCount}`,
      rootPath: tempRoot,
      archivePath: path.join(tempRoot, "archive"),
      period,
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
      { id: "IMG-1", role: "material", path: image.path, sha256: image.sha256, kind: "image", disposition: "used" },
      ...(supplementImage ? [{ id: "IMG-SUPPLEMENT", role: "material", path: supplementImage.path, sha256: supplementImage.sha256, kind: "image", disposition: "used" }] : []),
    ],
    sourceScopes: [{ id: "SCOPE-1", fileId: "IMG-1", locator: "full-image", terminalConfirmed: true, expectedUnitCount: profileCount }],
    sourceUnits: all.map((_, index) => ({ id: `UNIT-${index + 1}`, scopeId: "SCOPE-1", locator: `region-${index + 1}`, disposition: "used" })),
    transactions: all,
    expectedFeeTotal: all[0].amount,
    expectedRealTotal: all[0].amount,
    expectedCategoryTotals: totals,
  };
  void real;
  const manifestPath = path.join(tempRoot, `manifest-${profileCount}-${suffix}.json`);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(manifestPath, bytes, { flag: "wx" });
  const audited = spawnSync(process.execPath, [auditScript, manifestPath], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(audited.status, 0, audited.stderr);
  const result = JSON.parse(audited.stdout.trim());
  assert.equal(result.ok, true);
  return {
    request: {
      kind: REIMBURSEMENT_ARTIFACT_BUILD_KIND,
      stagingToken: crypto.randomBytes(32).toString("hex"),
      manifestPath,
      manifestSha256: sha256(bytes),
      reimbursementFactsCertificate: result.reimbursementFactsCertificate,
    },
    image,
  };
}

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-test-"));
  await fs.mkdir(path.join(tempRoot, "archive"));
});

test.after(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("built-in visual contracts replace runtime template dependencies", () => {
  const detail = getDetailContract("xiaohongshu");
  const screenshot = getScreenshotContract("xiaohongshu");
  const supplement = getSupplementContract("xiaohongshu");
  assert.equal(detail.source, "builtin");
  assert.equal(screenshot.source, "builtin");
  assert.equal(supplement.source, "builtin");
  assert.deepEqual(detail.columns, ["日期", "支出明细", "支出金额", "费用组合计", "费用分类", "结算方式"]);
  assert.deepEqual(supplement.supplementFields, ["原始发生日期", "补报原因", "关联原始凭证/来源编号"]);
  assert.equal(detail.numberFormat, "0.000");
  assert.equal(detail.rowHeights.data, 24);
  assert.equal(screenshot.rowHeights.screenshotData, 172.5);
  assert.match(detail.stylesXml, /formatCode="0\.000"/u);
});

test("one shared writer emits only affected profile detail and screenshot workbooks", async (t) => {
  for (const profileCount of [1, 2, 3]) {
    await t.test(`${profileCount} profile(s)`, async () => {
      const { request } = await auditedRequest(profileCount);
      const result = await buildReimbursementArtifacts(request);
      assert.equal(result.requiresGate1Binding, true);
      assert.equal(result.artifacts.length, profileCount);
      assert.deepEqual(result.affectedProfileIds, ["xiaohongshu", "company", "residence"].slice(0, profileCount));
      for (const artifact of result.artifacts) {
        assert.match(artifact.detail.sha256, /^[0-9a-f]{64}$/u);
        assert.match(artifact.screenshot.sha256, /^[0-9a-f]{64}$/u);
        assert.match(artifact.summary.sha256, /^[0-9a-f]{64}$/u);
        assert.equal(artifact.supplement, null);
        assert.equal(artifact.visualContracts.supplement, null);
        assert.match(artifact.summary.text, /费用合计：/u);
        assert.match(artifact.summary.text, /实报合计：/u);
        assert.match(path.basename(artifact.summary.path), /_报销文字说明\.odt$/u);
        assert.match(artifact.summary.textSha256, /^[0-9a-f]{64}$/u);
        assert.equal(artifact.evidenceArchive.length, 1);
        assert.equal((await fs.readFile(artifact.evidenceArchive[0].path)).equals(PNG), true);
        assert.match(artifact.periodEndDate, /^2026-08-03$/u);
        const detail = await JSZip.loadAsync(await fs.readFile(artifact.detail.path));
        const screenshot = await JSZip.loadAsync(await fs.readFile(artifact.screenshot.path));
        const summary = await JSZip.loadAsync(await fs.readFile(artifact.summary.path));
        const detailSheet = await detail.file("xl/worksheets/sheet1.xml").async("string");
        const screenshotSheet = await screenshot.file("xl/worksheets/sheet1.xml").async("string");
        const detailStyles = await detail.file("xl/styles.xml").async("string");
        assert.equal(Object.hasOwn(artifact.detail, "templateFile"), false);
        assert.equal(Object.hasOwn(artifact.detail, "templateSha256"), false);
        assert.equal(artifact.detail.visualContractSource, "builtin");
        assert.equal(artifact.detail.visualContractId, "current-detail-person-grouped");
        assert.equal(artifact.detail.visualContractVersion, "1.0.0");
        assert.match(artifact.detail.visualContractDigest, /^[0-9a-f]{64}$/u);
        assert.match(detailStyles, /formatCode="0\.000"/u);
        assert.match(detailSheet, /<c r="C8" s="2">/u);
        assert.match(detailSheet, /ySplit="6"[^>]*topLeftCell="A7"/u);
        assert.match(detailSheet, /<col min="2" max="2" width="40"/u);
        assert.match(detailSheet, /SUM\(C\d+:C\d+\)/u);
        assert.match(screenshotSheet, /<row r="2" ht="172\.5"/u);
        assert.match(screenshotSheet, /<col min="6" max="8" width="42"/u);
        assert.match(screenshotSheet, /<drawing [^>]*r:id="rId1"/u);
        assert.ok(screenshot.file("xl/media/image1.png"));
        assert.equal(await summary.file("mimetype").async("string"), "application/vnd.oasis.opendocument.text");
        assert.match(await summary.file("content.xml").async("string"), /费用合计：/u);
      }
      await fs.rm(result.stagingRoot, { recursive: true, force: true });
    });
  }
});

test("supplement transactions keep the normal detail and emit one additional bound supplement workbook", async () => {
  const { request } = await auditedRequest(1, { supplement: true });
  const result = await buildReimbursementArtifacts(request);
  const artifact = result.artifacts[0];
  assert.equal(artifact.detail.presentationKind, "detail");
  assert.match(path.basename(artifact.detail.path), /_本次报销明细\.xlsx$/u);
  assert.ok(artifact.supplement);
  assert.match(path.basename(artifact.supplement.path), /_补报表\.xlsx$/u);
  assert.equal(artifact.supplement.visualContractId, "ordinary-reimbursement-supplement-detail");
  assert.equal(artifact.supplement.originalOccurrenceDate, "2026-07-01");
  assert.equal(artifact.supplement.supplementReason, "测试历史补报");
  assert.equal(artifact.supplement.sourceReference, "UNIT-1");
  assert.deepEqual(artifact.supplement.entries, [{
      transactionId: "TX-1",
      originalOccurrenceDate: "2026-07-01",
      supplementReason: "测试历史补报",
      sourceReference: "UNIT-1",
  }]);
  assert.equal(artifact.evidenceArchive[0].archiveKind, "reimbursement");
  const detailWorkbook = await JSZip.loadAsync(await fs.readFile(artifact.detail.path));
  const detailSheet = await detailWorkbook.file("xl/worksheets/sheet1.xml").async("string");
  assert.doesNotMatch(detailSheet, /补报说明/u);
  const supplementWorkbook = await JSZip.loadAsync(await fs.readFile(artifact.supplement.path));
  const supplementSheet = await supplementWorkbook.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(supplementSheet, /补报表（按人员分类）/u);
  assert.match(supplementSheet, /补报说明：TX-1/u);
  assert.match(supplementSheet, /原始发生日期：2026-07-01/u);
  assert.match(supplementSheet, /补报原因：测试历史补报/u);
  assert.match(supplementSheet, /关联原始凭证\/来源编号：UNIT-1/u);
  await fs.rm(result.stagingRoot, { recursive: true, force: true });
});

test("only explicitly identified independent supplement evidence receives the conditional archive kind", async () => {
  const { request } = await auditedRequest(1, { supplement: true, independentSupplementEvidence: true });
  const result = await buildReimbursementArtifacts(request);
  assert.deepEqual(
    result.artifacts[0].evidenceArchive.map(({ evidenceId, archiveKind }) => ({ evidenceId, archiveKind })),
    [
      { evidenceId: "IMG-1", archiveKind: "reimbursement" },
      { evidenceId: "IMG-SUPPLEMENT", archiveKind: "supplement" },
    ],
  );
  await fs.rm(result.stagingRoot, { recursive: true, force: true });
});

test("supplement required fields fail closed instead of falling back to transaction data", async (t) => {
  const cases = [
    ["missing original occurrence date", { originalOccurrenceDate: null }, /originalOccurrenceDate/iu],
    ["blank reason", { supplementReason: " " }, /supplementReason/iu],
    ["invalid source reference type", { sourceReference: 17 }, /sourceReference/iu],
    ["invalid original occurrence calendar date", { originalOccurrenceDate: "2026-02-31" }, /originalOccurrenceDate.*calendar|calendar.*originalOccurrenceDate/iu],
  ];
  for (const [name, overrides, error] of cases) {
    await t.test(name, async () => {
      const { request } = await auditedRequest(1, { supplement: true, supplementOverrides: overrides });
      await assert.rejects(() => buildReimbursementArtifacts(request), error);
    });
  }
});

test("period parsing requires both endpoints and supports abbreviated Chinese end dates", async (t) => {
  await t.test("abbreviated end date is normalized", async () => {
    const { request } = await auditedRequest(1, { period: "2026年8月1日-8月2日" });
    const result = await buildReimbursementArtifacts(request);
    assert.equal(result.artifacts[0].periodEndDate, "2026-08-02");
    await fs.rm(result.stagingRoot, { recursive: true, force: true });
  });
  for (const period of ["2026-08-01", "2026-08-01—bad", "2026年8月1日-8月"]) {
    await t.test("rejects incomplete period: " + period, async () => {
      const { request } = await auditedRequest(1, { period });
      await assert.rejects(() => buildReimbursementArtifacts(request), /period.*complete start and end date/iu);
    });
  }
});

test("evidence changed after manifest audit is rejected before artifact staging", async () => {
  const { request, image } = await auditedRequest(1);
  await fs.writeFile(image.path, Buffer.concat([PNG, Buffer.from("changed")]));
  await assert.rejects(() => buildReimbursementArtifacts(request), /evidence|SHA changed|stable|SHA256 mismatch/iu);
  const expectedRoot = path.join(os.tmpdir(), `codex-xhs-artifacts-${request.stagingToken}`);
  await assert.rejects(() => fs.stat(expectedRoot), { code: "ENOENT" });
});

test("approved-layout detail and embedded-image screenshot render through the real spreadsheet engine", {
  skip: !process.env.XHS_VISUAL_RENDERER || !process.env.XHS_VISUAL_EVIDENCE_DIR,
}, async () => {
  const outputRoot = path.resolve(process.env.XHS_VISUAL_EVIDENCE_DIR);
  await fs.mkdir(outputRoot, { recursive: false });
  const { request } = await auditedRequest(1);
  const result = await buildReimbursementArtifacts(request);
  const artifact = result.artifacts[0];
  for (const [role, source, range] of [
    ["detail", artifact.detail.path, `A1:F${artifact.detail.endRow}`],
    ["screenshot", artifact.screenshot.path, `A1:H${artifact.screenshot.endRow}`],
  ]) {
    const output = path.join(outputRoot, `${role}.png`);
    const rendered = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.resolve(process.env.XHS_VISUAL_RENDERER),
      "-WorkbookPath", source,
      "-OutputPath", output,
      "-RangeAddress", range,
    ], { encoding: "utf8", shell: false, windowsHide: true, timeout: 60_000 });
    assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
    const bytes = await fs.readFile(output);
    assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
    assert.ok(bytes.length > 1_000, `${role} render is unexpectedly small.`);
  }
  await fs.rm(result.stagingRoot, { recursive: true, force: true });
});
