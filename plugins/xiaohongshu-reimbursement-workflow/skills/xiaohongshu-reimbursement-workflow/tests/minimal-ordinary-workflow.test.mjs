import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReimbursementArtifacts, inspectEvidenceImage } from "../scripts/build_reimbursement_artifacts.mjs";
import { buildRootWorkbookCandidates } from "../scripts/build_root_workbook_candidate.mjs";
import { loadProfileRegistry } from "../scripts/finance_domain.mjs";
import { loadArtifactTemplates } from "../scripts/template_assets.mjs";
import {
  finalizeReimbursementWorkflow,
  prepareReimbursementWorkflow,
  publishReimbursementWorkflow,
} from "../scripts/run_reimbursement_workflow.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestAuditor = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function serial(iso) { return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25_569; }
function tCell(ref, style, value) { return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`; }
function nCell(ref, style, value) { return `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`; }

async function makeBaseline(filePath) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><mc:AlternateContent><mc:Choice Requires="x15"><ignored/></mc:Choice><mc:Fallback/></mc:AlternateContent><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Sheet1\'!$A$1:$F$4</definedName></definedNames></workbook>');
  zip.file("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="mm-dd"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="165"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>');
  const header = ["日期", "支出明细", "支出金额", "合计", "支出人", "备注"].map((value, index) => tCell(`${String.fromCharCode(65 + index)}1`, 2, value)).join("");
  const row2 = nCell("A2", 1, serial("2031-01-05")) + tCell("B2", 2, "历史甲") + nCell("C2", 3, "1") + nCell("D2", 4, "1") + tCell("E2", 2, "历史人员") + tCell("F2", 2, "历史备注");
  const row4 = nCell("A4", 1, serial("2031-04-01")) + tCell("B4", 2, "历史乙") + nCell("C4", 3, "2") + '<c r="D4" s="4" t="n"><f t="shared" si="0">SUM(C4:C4)</f><v>2</v></c>' + tCell("E4", 2, "历史人员") + tCell("F4", 2, "历史备注") + tCell("G4", 2, "辅助列保留") + nCell("H4", 3, "99");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H4"/><sheetData><row r="1" ht="22" customHeight="1">${header}</row><row r="2" ht="22" customHeight="1">${row2}</row><row r="4" ht="22" customHeight="1">${row4}</row></sheetData><conditionalFormatting sqref="A4:F4"><cfRule type="expression" priority="1"><formula>C4&gt;0</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="whole" sqref="H4"><formula1>$H$4</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="B4" location="'Sheet1'!B4"/></hyperlinks></worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "DOS" });
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
}

async function jpegWithoutEoi(width, height, salt) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: salt, g: (salt * 3) % 255, b: (salt * 7) % 255 } } }).jpeg({ quality: 70 }).toBuffer();
  assert.equal(bytes.at(-2), 0xff);
  assert.equal(bytes.at(-1), 0xd9);
  return bytes.subarray(0, -2);
}

async function writeFixture(root, name, bytes) {
  const resolved = await bytes;
  const filePath = path.join(root, name); await fs.writeFile(filePath, resolved, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(resolved) };
}

function fileEntry(id, role, file, extra = {}) { return { id, role, path: file.path, sha256: file.sha256, ...extra }; }

function makeManifest(root, archivePath, baseline, contextImage, voucherImage) {
  return {
    version: 3,
    rulesVersion: "minimal-local-increment-v1",
    batch: {
      batchId: "minimal-batch-001",
      rootPath: root,
      archivePath,
      period: "2031.4.10-2031.4.15",
      mainPeriod: { start: "2031-04-10", end: "2031-04-15" },
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      fileEntry("baseline", "baseline", baseline),
      fileEntry("IMG-CONTEXT", "material", contextImage, { kind: "image", disposition: "used", usage: "context" }),
      fileEntry("IMG-VOUCHER", "material", voucherImage, { kind: "image", disposition: "used", usage: "voucher" }),
    ],
    sourceScopes: [
      { id: "SCOPE-CONTEXT", fileId: "IMG-CONTEXT", locator: "full-image", terminalConfirmed: true, expectedUnitCount: 2 },
      { id: "SCOPE-VOUCHER", fileId: "IMG-VOUCHER", locator: "full-image", terminalConfirmed: true, expectedUnitCount: 1 },
    ],
    sourceUnits: [
      { id: "UNIT-1", scopeId: "SCOPE-CONTEXT", locator: "row-1", disposition: "used" },
      { id: "UNIT-2", scopeId: "SCOPE-CONTEXT", locator: "row-2", disposition: "used" },
      { id: "UNIT-3", scopeId: "SCOPE-VOUCHER", locator: "row-3", disposition: "used" },
    ],
    transactions: [
      { id: "TX-001", sourceOrder: 1, date: "2031-04-10", person: "人员甲", project: "当期费用", label: "人员甲", classification: "运营开支", sourceAmount: "12.34", reimbursementAmount: "12.34", reportingKind: "current", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-CONTEXT"], sourceRefs: ["UNIT-1"] },
      { id: "TX-002", sourceOrder: 2, date: "2031-02-20", person: "人员乙", project: "补报费用", label: "人员乙", classification: "项目乙", sourceAmount: "23.45", reimbursementAmount: "23.45", reportingKind: "current", supplementReason: "前期材料晚到", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-CONTEXT"], sourceRefs: ["UNIT-2"] },
      { id: "TX-003", sourceOrder: 3, date: "2031-03-03", person: "人员丙", project: "跨期费用", label: "人员丙", classification: "项目丙", sourceAmount: "6.78", reimbursementAmount: "6.78", reportingKind: "supplement", supplementReason: "跨期补录", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-VOUCHER"], sourceRefs: ["UNIT-3"] },
    ],
    expected: { transactionCount: 3, feeTotal: "42.57", reimbursementTotal: "42.57", companyPaidNoReimbursementTotal: "0", uniqueMediaCount: 2, mediaReferenceCount: 3 },
  };
}

async function auditManifest(manifestPath, extraArgs = []) {
  const child = spawnSync(process.execPath, [manifestAuditor, manifestPath, ...extraArgs], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

function pngBytes(width = 900, height = 600) {
  const bytes = Buffer.alloc(1200, 0); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}

async function previewRenderer({ request, requestFileSha256 }) {
  assert.equal(request.bindings.length * 3, request.jobs.length);
  for (const binding of request.bindings) {
    assert.match(binding.candidateSha256, /^[0-9a-f]{64}$/u);
    assert.match(binding.planSha256, /^[0-9a-f]{64}$/u);
    assert.match(binding.sourceCoverageDigest, /^[0-9a-f]{64}$/u);
    assert.ok(binding.batchRows.length > 0);
    assert.equal(request.jobs.find((job) => job.profileId === binding.profileId && job.role === "root").rangeAddress, binding.rootPreviewRange);
  }
  const previews = [];
  for (const job of request.jobs) {
    const bytes = pngBytes(); await fs.writeFile(job.outputPath, bytes, { flag: "wx" });
    previews.push({ profileId: job.profileId, role: job.role, workbookSha256: job.workbookSha256, outputPath: job.outputPath, sha256: sha256Bytes(bytes), size: bytes.length });
  }
  return { kind: "ordinary-reimbursement-preview-response-v1", requestNonce: request.requestNonce, requestFileSha256, enginePeakWorkingSetBytes: 1_000_000, previews };
}

test("minimal ordinary workflow uses manifest v3, local ledger patch, batch previews, supplements, and clean archive", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-minimal-e2e-"));
  const taskRoots = [];
  try {
    const registry = await loadProfileRegistry();
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const contextImage = await writeFixture(temp, "context.jpg", jpegWithoutEoi(640, 480, 7));
    const voucherImage = await writeFixture(temp, "voucher.jpg", jpegWithoutEoi(800, 600, 9));
    const suffix = "（含人员乙2031.2.20补报1笔23.45元、人员丙2031.3.3补报1笔6.78元）";
    const archivePath = path.join(temp, `2031.4.10-2031.4.15_小红书报销${suffix}`);
    const manifest = makeManifest(temp, archivePath, baseline, contextImage, voucherImage);
    const manifestPath = path.join(temp, "manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const audited = await auditManifest(manifestPath);
    assert.equal(audited.validatorVersion, "5");
    assert.equal(audited.fileVerificationMode, "manifest-auditor");
    const deferredAudit = await auditManifest(manifestPath, ["--defer-ordinary-file-verification"]);
    assert.equal(deferredAudit.fileVerificationMode, "bound-builders");
    assert.deepEqual(audited.batch.mainPeriod, { start: "2031-04-10", end: "2031-04-15" });
    assert.equal(audited.normalizedTransactions[1].reportingKind, "supplement");
    assert.equal(audited.reimbursementFactsCertificate.factsPreimage.expectedTotals.uniqueMediaCount, 2);

    const presentation = await buildReimbursementArtifacts({ kind: "reimbursement-artifact-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), manifestPath, manifestSha256: sha256Bytes(manifestBytes), reimbursementFactsCertificate: audited.reimbursementFactsCertificate });
    taskRoots.push(presentation.stagingRoot);
    const product = presentation.artifacts[0];
    assert.match(path.basename(product.summary.path), /报销文字说明.*\.txt$/u);
    assert.equal(product.supplementSuffix, suffix);
    assert.equal(product.supplements.length, 2);
    assert.equal(product.screenshot.uniqueMediaCount, 2);
    assert.equal(product.screenshot.imageReferenceCount, 3);
    assert.equal(product.screenshot.imageCount, 2, "context evidence must be displayed only once");
    assert.equal(product.evidenceArchive.length, 2);
    assert.match(product.evidenceArchive[0].finalName, /^001_人员甲_当期费用_12.34_2031-04-10/u);

    const root = await buildRootWorkbookCandidates({ kind: "root-workbook-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), reimbursementFactsCertificate: audited.reimbursementFactsCertificate, artifacts: [{ profileId: "xiaohongshu", baselinePath: baseline.path, baselineSha256: baseline.sha256, baselineSize: baseline.size, candidateRevision: 1 }] });
    taskRoots.push(root.stagingRoot);
    const candidate = root.artifacts[0];
    assert.equal(candidate.audit.auditScope, "batch-local-increment-only");
    assert.equal(candidate.audit.projection.batchRowCount, 3);
    assert.equal(candidate.previewRangeAddress, "A1:F4");
    assert.equal(candidate.audit.projection.batchRanges.some((range) => range.rangeAddress === "A4:F5"), true);
    assert.equal(candidate.audit.projection.batchRanges.some((range) => range.rangeAddress === "A7:F7"), true);
    const candidateZip = await JSZip.loadAsync(await fs.readFile(candidate.candidatePath));
    const sheet = await candidateZip.file("xl/worksheets/sheet1.xml").async("string");
    assert.match(sheet, /<c r="G6"[^>]*>.*辅助列保留/su);
    assert.match(sheet, /<f t="shared" si="0">SUM\(C6:C6\)<\/f>/u);
    assert.match(sheet, /conditionalFormatting sqref="A6:F6"/u);
    assert.match(sheet, /<formula>C6&gt;0<\/formula>/u);
    assert.match(sheet, /dataValidation type="whole" sqref="H6"/u);
    assert.match(sheet, /<formula1>\$H\$6<\/formula1>/u);
    assert.match(sheet, /<hyperlink ref="B6" location="'Sheet1'!B6"\/>/u);
    const workbook = await candidateZip.file("xl/workbook.xml").async("string");
    assert.match(workbook, /AlternateContent/u);

    const prepareToken = crypto.randomBytes(32).toString("hex");
    const gate1 = await prepareReimbursementWorkflow({ kind: "ordinary-reimbursement-prepare-v1", stagingToken: prepareToken, manifestPath, manifestSha256: sha256Bytes(manifestBytes), baselines: [{ profileId: "xiaohongshu", path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: 1 }] }, { testHooks: { runPreviewRenderer: previewRenderer } });
    const rootPreview = gate1.review[0].previews.find((item) => item.role === "root");
    assert.equal(rootPreview.rangeAddress, "A1:F4");
    assert.doesNotMatch(rootPreview.rangeAddress, /1363/u);
    const gate2 = await finalizeReimbursementWorkflow({ statePath: gate1.statePath, expectedGate1BindingDigest: gate1.gate1BindingDigest, approvalText: "本次报销通过无误" });
    const receipt = await publishReimbursementWorkflow({ statePath: gate2.statePath, expectedGate1BindingDigest: gate1.gate1BindingDigest, gate1ApprovalText: "本次报销通过无误", expectedGate2BindingDigest: gate2.gate2BindingDigest, gate2ApprovalText: "确认更新根目录支出总表" });
    assert.equal(receipt.outputs.length, 1);
    const archiveNames = (await fs.readdir(archivePath)).sort();
    assert.equal(archiveNames.includes("01_小红书专项"), false);
    assert.equal(archiveNames.includes("报销截图"), true);
    assert.equal(archiveNames.includes("小红书支出总表_截至2031.4.15.xlsx"), true);
    assert.equal(archiveNames.filter((name) => /补报明细\.xlsx$/u.test(name)).length, 2);
    assert.equal(archiveNames.some((name) => /Gate|manifest|preview|\.json$/iu.test(name)), false);
    const screenshotNames = await fs.readdir(path.join(archivePath, "报销截图", "小红书报销"));
    assert.equal(screenshotNames.length, 2);
    assert.equal(sha256Bytes(await fs.readFile(baseline.path)), receipt.outputs[0].root.sha256);
    assert.equal(registry.profiles.xiaohongshu.archiveDirectoryName, undefined);
  } finally {
    await Promise.all(taskRoots.map((taskRoot) => fs.rm(taskRoot, { recursive: true, force: true })));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("manifest v3 rejects rounded source amounts and incomplete expected image counts", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-minimal-invalid-"));
  try {
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const one = await writeFixture(temp, "one.jpg", jpegWithoutEoi(10, 10, 1));
    const two = await writeFixture(temp, "two.jpg", jpegWithoutEoi(20, 20, 2));
    const manifest = makeManifest(temp, path.join(temp, "archive"), baseline, one, two);
    manifest.transactions[0].amount = "9";
    const manifestPath = path.join(temp, "invalid.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
    const child = spawnSync(process.execPath, [manifestAuditor, manifestPath], { encoding: "utf8" });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /amount must equal sourceAmount/u);
    assert.notEqual(canonicalDigest(manifest.expected), canonicalDigest({ ...manifest.expected, uniqueMediaCount: 1 }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a batch without supplements emits no empty parentheses or supplement workbooks", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-no-supplement-"));
  const taskRoots = [];
  try {
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const image = await writeFixture(temp, "current.jpg", jpegWithoutEoi(100, 80, 5));
    const archivePath = path.join(temp, "2031.4.10-2031.4.15_小红书报销");
    const manifest = makeManifest(temp, archivePath, baseline, image, image);
    manifest.files = [manifest.files[0], { ...manifest.files[1], usage: "voucher" }];
    manifest.sourceScopes = [{ id: "SCOPE-CONTEXT", fileId: "IMG-CONTEXT", locator: "full-image", terminalConfirmed: true, expectedUnitCount: 1 }];
    manifest.sourceUnits = [{ id: "UNIT-1", scopeId: "SCOPE-CONTEXT", locator: "row-1", disposition: "used" }];
    manifest.transactions = [manifest.transactions[0]];
    manifest.expected = { transactionCount: 1, feeTotal: "12.34", reimbursementTotal: "12.34", companyPaidNoReimbursementTotal: "0", uniqueMediaCount: 1, mediaReferenceCount: 1 };
    const manifestPath = path.join(temp, "manifest.json");
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"); await fs.writeFile(manifestPath, bytes, { flag: "wx" });
    const audited = await auditManifest(manifestPath);
    const result = await buildReimbursementArtifacts({ kind: "reimbursement-artifact-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), manifestPath, manifestSha256: sha256Bytes(bytes), reimbursementFactsCertificate: audited.reimbursementFactsCertificate });
    taskRoots.push(result.stagingRoot);
    const product = result.artifacts[0];
    assert.equal(product.supplementSuffix, "");
    assert.deepEqual(product.supplements, []);
    assert.doesNotMatch(path.basename(product.detail.path), /（）/u);
    assert.doesNotMatch(path.basename(product.summary.path), /（）/u);
  } finally {
    await Promise.all(taskRoots.map((taskRoot) => fs.rm(taskRoot, { recursive: true, force: true })));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("48-transaction synthetic stress fixture preserves supplements and 56/58 evidence coverage", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-synthetic-stress-"));
  const taskRoots = [];
  try {
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const imageFiles = [];
    for (let index = 0; index < 56; index += 1) {
      imageFiles.push(await writeFixture(temp, `evidence-${String(index + 1).padStart(2, "0")}.jpg`, jpegWithoutEoi(600 + index, 400 + index, (index + 3) % 250)));
    }
    const missingSource = await writeFixture(temp, "missing-evidence-context.txt", Buffer.from("项目乙无截图合并说明\n", "utf8"));
    const transactions = [{ id: "TX-001", sourceOrder: 1, date: "2031-04-10", person: "人员甲", project: "日常费用", label: "人员甲", classification: "日常报销", sourceAmount: "412.34", reimbursementAmount: "412.34", reportingKind: "current", category: "小红书报销", settlement: "employee_reimbursement" }];
    for (let index = 0; index < 20; index += 1) {
      transactions.push({
        id: `TX-${String(index + 2).padStart(3, "0")}`,
        sourceOrder: index + 2,
        date: `2031-02-${String(index + 1).padStart(2, "0")}`,
        person: "人员乙", project: `项目乙凭证${index + 1}`, label: "人员乙", classification: "项目乙",
        sourceAmount: `${100 + index}.25`, reimbursementAmount: `${100 + index}.25`,
        reportingKind: "supplement", supplementReason: "前期资料补齐", category: "小红书报销", settlement: "employee_reimbursement",
      });
    }
    transactions.push({ id: "TX-022", sourceOrder: 22, date: "2031-02-21", person: "人员乙", project: "项目乙汇总费用", label: "人员乙", classification: "项目乙", sourceAmount: "234.56", reimbursementAmount: "234.56", reportingKind: "supplement", supplementReason: "无截图部分合并补报", category: "小红书报销", settlement: "employee_reimbursement", missingEvidenceConfirmed: true });
    transactions.push({ id: "TX-023", sourceOrder: 23, date: "2031-03-03", person: "人员丙", project: "项目丙费用", label: "人员丙", classification: "项目丙", sourceAmount: "456.78", reimbursementAmount: "456.78", reportingKind: "supplement", supplementReason: "跨期补报", category: "小红书报销", settlement: "employee_reimbursement" });
    for (let index = 0; index < 25; index += 1) {
      const companyPaid = index === 0;
      const amount = companyPaid ? "1700" : `${50 + index}.5`;
      transactions.push({
        id: `TX-${String(index + 24).padStart(3, "0")}`, sourceOrder: index + 24,
        date: `2031-04-${String(10 + (index % 6)).padStart(2, "0")}`,
        person: companyPaid ? "人员丁" : `人员${index + 4}`,
        project: companyPaid ? "公司承担费用" : index === 1 ? "合成电费" : `本期费用${index + 1}`,
        label: companyPaid ? "人员丁" : `人员${index + 4}`,
        classification: companyPaid || index === 1 ? "日常报销" : "运营开支",
        sourceAmount: amount, reimbursementAmount: companyPaid ? "0" : amount,
        reportingKind: "current", category: "小红书报销",
        settlement: companyPaid ? "company_paid_no_reimbursement" : "employee_reimbursement",
      });
    }
    assert.equal(transactions.length, 48);
    const imageTransactions = transactions.filter((item) => item.id !== "TX-022");
    imageTransactions.forEach((transaction, index) => { transaction.evidence = [`IMG-${String(index + 1).padStart(3, "0")}`]; });
    for (let index = 0; index < 9; index += 1) imageTransactions[index].evidence.push(`IMG-${String(48 + index).padStart(3, "0")}`);
    imageTransactions[10].evidence.push("IMG-001");
    imageTransactions[11].evidence.push("IMG-002");
    const referenceCounts = new Map();
    for (const transaction of imageTransactions) for (const id of transaction.evidence) referenceCounts.set(id, (referenceCounts.get(id) ?? 0) + 1);
    const sourceScopes = [];
    const sourceUnits = [];
    let unitNumber = 1;
    for (let index = 0; index < 56; index += 1) {
      const id = `IMG-${String(index + 1).padStart(3, "0")}`;
      sourceScopes.push({ id: `SCOPE-${id}`, fileId: id, locator: "full-image", terminalConfirmed: true, expectedUnitCount: referenceCounts.get(id) });
      for (let occurrence = 0; occurrence < referenceCounts.get(id); occurrence += 1) sourceUnits.push({ id: `UNIT-${String(unitNumber++).padStart(3, "0")}`, scopeId: `SCOPE-${id}`, locator: `reference-${occurrence + 1}`, disposition: "used" });
    }
    const unitsByScope = new Map();
    for (const unit of sourceUnits) { if (!unitsByScope.has(unit.scopeId)) unitsByScope.set(unit.scopeId, []); unitsByScope.get(unit.scopeId).push(unit.id); }
    const cursorByScope = new Map();
    for (const transaction of imageTransactions) {
      transaction.sourceRefs = transaction.evidence.map((id) => {
        const scopeId = `SCOPE-${id}`; const cursor = cursorByScope.get(scopeId) ?? 0; cursorByScope.set(scopeId, cursor + 1); return unitsByScope.get(scopeId)[cursor];
      });
    }
    transactions.find((item) => item.id === "TX-022").evidence = ["TEXT-MISSING"];
    transactions.find((item) => item.id === "TX-022").sourceRefs = ["UNIT-MISSING"];
    sourceScopes.push({ id: "SCOPE-MISSING", fileId: "TEXT-MISSING", locator: "full-text", terminalConfirmed: true, expectedUnitCount: 1 });
    sourceUnits.push({ id: "UNIT-MISSING", scopeId: "SCOPE-MISSING", locator: "line-1", disposition: "used" });
    const archivePath = path.join(temp, "2031.4.10-2031.4.15_小红书报销（含人员乙2031.2.1-2031.2.21补报21笔2429.56元、人员丙2031.3.3补报1笔456.78元）");
    const manifest = {
      version: 3, rulesVersion: "synthetic-stress-v1",
      batch: { batchId: "synthetic-stress", rootPath: temp, archivePath, period: "2031.4.10-2031.4.15", mainPeriod: { start: "2031-04-10", end: "2031-04-15" }, targetCategory: "小红书报销", reviewRevision: 1 },
      operation: { mode: "reimbursement-batch" },
      files: [
        fileEntry("baseline", "baseline", baseline),
        ...imageFiles.map((file, index) => fileEntry(`IMG-${String(index + 1).padStart(3, "0")}`, "material", file, { kind: "image", disposition: "used", usage: index === 0 ? "context" : "voucher" })),
        fileEntry("TEXT-MISSING", "material", missingSource, { kind: "text", disposition: "used", usage: "context" }),
      ],
      sourceScopes, sourceUnits, transactions,
      expected: { transactionCount: 48, feeTotal: "6510.68", reimbursementTotal: "4810.68", companyPaidNoReimbursementTotal: "1700", uniqueMediaCount: 56, mediaReferenceCount: 58 },
    };
    const manifestPath = path.join(temp, "synthetic-stress.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"); await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const audited = await auditManifest(manifestPath);
    assert.equal(audited.transactions, 48);
    assert.equal(audited.categoryTotals["小红书报销"], "6510.68");
    assert.equal(audited.categoryRealTotals["小红书报销"], "4810.68");
    assert.equal(audited.settlementTotals.company_paid_no_reimbursement, "1700");
    const supplementsForPersonB = audited.normalizedTransactions.filter((item) => item.person === "人员乙");
    assert.equal(supplementsForPersonB.length, 21);
    assert.equal(supplementsForPersonB.reduce((sum, item) => sum + Number(item.sourceAmount), 0).toFixed(2), "2429.56");
    const buildStartedAt = performance.now();
    const artifacts = await buildReimbursementArtifacts({ kind: "reimbursement-artifact-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), manifestPath, manifestSha256: sha256Bytes(manifestBytes), reimbursementFactsCertificate: audited.reimbursementFactsCertificate });
    taskRoots.push(artifacts.stagingRoot);
    const product = artifacts.artifacts[0];
    assert.equal(product.transactionCount, 48);
    assert.equal(product.screenshot.uniqueMediaCount, 56);
    assert.equal(product.screenshot.imageReferenceCount, 58);
    assert.equal(product.evidenceArchive.length, 56);
    assert.equal(product.supplements.length, 2);
    assert.equal(product.supplementSuffix, "（含人员乙2031.2.1-2031.2.21补报21笔2429.56元、人员丙2031.3.3补报1笔456.78元）");
    assert.match(product.summary.text, /无截图说明：人员乙-项目乙汇总费用-234.56元/u);
    const detailZip = await JSZip.loadAsync(await fs.readFile(product.detail.path));
    assert.match(await detailZip.file("xl/worksheets/sheet1.xml").async("string"), /合成电费/u);
    const root = await buildRootWorkbookCandidates({ kind: "root-workbook-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), reimbursementFactsCertificate: audited.reimbursementFactsCertificate, artifacts: [{ profileId: "xiaohongshu", baselinePath: baseline.path, baselineSha256: baseline.sha256, baselineSize: baseline.size, candidateRevision: 1 }] });
    taskRoots.push(root.stagingRoot);
    assert.equal(root.artifacts[0].audit.projection.batchRowCount, 48);
    assert.equal(root.artifacts[0].audit.projection.batchAmount, "6510.68");
    assert.ok(performance.now() - buildStartedAt < 10_000, "synthetic artifact, local candidate, and independent audit build exceeded 10 seconds");
  } finally {
    await Promise.all(taskRoots.map((taskRoot) => fs.rm(taskRoot, { recursive: true, force: true })));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("sanitized templates contain only static layout and one blank standard data row", async () => {
  const templates = await loadArtifactTemplates();
  for (const template of Object.values(templates)) {
    const zip = await JSZip.loadAsync(await fs.readFile(template.filePath));
    assert.equal(zip.file("xl/sharedStrings.xml"), null, `${template.id} retained shared strings`);
    const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    const rows = [...sheet.matchAll(/<(?:\w+:)?row\b[^>]*\br="([1-9]\d*)"[^>]*>[\s\S]*?<\/(?:\w+:)?row>/gu)];
    assert.equal(Math.max(...rows.map((match) => Number(match[1]))), template.definition.dataStyleRow);
    const dataRow = rows.find((match) => Number(match[1]) === template.definition.dataStyleRow)?.[0];
    assert.ok(dataRow);
    assert.doesNotMatch(dataRow, /<(?:\w+:)?(?:v|f|is)\b/iu);
  }
});

test("image validation accepts decodable JPEG without EOI and rejects structurally forged media", async () => {
  const complete = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  assert.deepEqual(await inspectEvidenceImage(complete), { extension: "jpg", width: 32, height: 24 });
  assert.deepEqual(await inspectEvidenceImage(complete.subarray(0, -2)), { extension: "jpg", width: 32, height: 24 });
  const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: "#abcdef" } }).png().toBuffer();
  assert.deepEqual(await inspectEvidenceImage(png), { extension: "png", width: 20, height: 10 });
  const forged = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x18, 0x00, 0x20, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  await assert.rejects(inspectEvidenceImage(forged), /cannot be decoded safely/u);
});

test("ordinary architecture guard uses templates but excludes full-ledger readers and legacy parallel entrypoints", async () => {
  const rootBuilder = await fs.readFile(path.join(skillRoot, "scripts", "build_root_workbook_candidate.mjs"), "utf8");
  const workflow = await fs.readFile(path.join(skillRoot, "scripts", "run_reimbursement_workflow.mjs"), "utf8");
  const artifactBuilder = await fs.readFile(path.join(skillRoot, "scripts", "build_reimbursement_artifacts.mjs"), "utf8");
  for (const forbidden of ["audit_ledger_layout.mjs", "workbook_ooxml_facts.mjs", "workbook_snapshot.mjs", "workbook_transition_contract.mjs"]) {
    assert.equal(rootBuilder.includes(`from \"./${forbidden}\"`), false, `ordinary root builder imports ${forbidden}`);
    assert.equal(workflow.includes(`from \"./${forbidden}\"`), false, `ordinary workflow imports ${forbidden}`);
  }
  assert.match(workflow, /workbookPath: root\.previewPath/u);
  assert.doesNotMatch(workflow, /workbookPath: root\.candidatePath/u);
  assert.match(artifactBuilder, /compression: "STORE"/u);
  assert.match(artifactBuilder, /loadArtifactTemplates/u);
  await fs.access(path.join(skillRoot, "assets", "templates", "xiaohongshu", "template-manifest.json"));
  for (const removed of [
    "run_reimbursement_batch.mjs", "build_reimbursement_candidate.mjs", "audit_reimbursement_candidate.mjs",
    "batch_cache.mjs", "publish_reimbursement_batch.mjs", "cleanup_task_temp.mjs", "manage_task_temp.mjs",
    "task_temp_inventory_common.mjs",
  ]) await assert.rejects(fs.stat(path.join(skillRoot, "scripts", removed)), { code: "ENOENT" });
});
