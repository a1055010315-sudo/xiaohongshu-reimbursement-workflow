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

function transaction(profileId, category, sourceOrder, unitId) {
  return {
    id: `TX-${sourceOrder}`,
    sourceOrder,
    date: `2026-08-0${sourceOrder}`,
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
}

async function auditedRequest(profileCount) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const baseline = await fixture(`baseline-${profileCount}-${suffix}.bin`, Buffer.from(`baseline-${profileCount}\n`));
  const image = await fixture(`image-${profileCount}-${suffix}.png`, PNG);
  const all = [
    transaction("xiaohongshu", "小红书报销", 1, "UNIT-1"),
    transaction("company", "公司报销", 2, "UNIT-2"),
    transaction("residence", "驻所报销", 3, "UNIT-3"),
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
      period: "2026-08-01—2026-08-03",
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
      { id: "IMG-1", role: "material", path: image.path, sha256: image.sha256, kind: "image", disposition: "used" },
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

test("supplement detail template preserves the approved detail presentation and requires its three supplement fields", async () => {
  const templatePath = path.join(skillRoot, "assets", "templates", "补报明细模板.xlsx");
  const template = await JSZip.loadAsync(await fs.readFile(templatePath));
  const workbook = await template.file("xl/workbook.xml").async("string");
  const worksheet = await template.file("xl/worksheets/sheet1.xml").async("string");
  const styles = await template.file("xl/styles.xml").async("string");
  assert.match(workbook, /name="补报明细模板"/u);
  assert.match(worksheet, /原始发生日期.*补报原因.*关联原始凭证/u);
  assert.match(styles, /formatCode="0\.000"/u);
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
        assert.equal(artifact.detail.templateSha256, sha256(await fs.readFile(path.join(skillRoot, "assets", "templates", artifact.detail.templateFile))));
        assert.match(detailStyles, /formatCode="0\.000"/u);
        assert.match(detailSheet, /<c r="C8" s="36">/u);
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

test("evidence changed after manifest audit is rejected before artifact staging", async () => {
  const { request, image } = await auditedRequest(1);
  await fs.writeFile(image.path, Buffer.concat([PNG, Buffer.from("changed")]));
  await assert.rejects(() => buildReimbursementArtifacts(request), /evidence|SHA changed|stable/iu);
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
