import assert from "node:assert/strict";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReimbursementArtifacts } from "../scripts/build_reimbursement_artifacts.mjs";
import { buildRootWorkbookCandidates } from "../scripts/build_root_workbook_candidate.mjs";
import {
  finalizeReimbursementWorkflow,
  prepareReimbursementWorkflow,
} from "../scripts/run_reimbursement_workflow.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function serial(iso) {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25_569;
}

function tCell(ref, style, value) {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
}

function nCell(ref, style, value) {
  return `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`;
}

async function makeBaseline(filePath) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Sheet1\'!$A$1:$F$2</definedName></definedNames></workbook>');
  zip.file("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="mm-dd"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="165"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>');
  const header = ["日期", "支出明细", "支出金额", "合计", "支出人", "备注"].map((value, index) => tCell(`${String.fromCharCode(65 + index)}1`, 2, value)).join("");
  const prior = nCell("A2", 1, serial("2034-12-20")) + '<c r="B2" s="2" t="s"><v>0</v></c>' + nCell("C2", 3, "2.15") + '<c r="D2" s="4" t="n"><f>SUM(C2:C2)</f><v>2.15</v></c>' + tCell("E2", 2, "合成历史主体") + tCell("F2", 2, "历史分类");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F2"/><sheetData><row r="1" ht="22" customHeight="1">${header}</row><row r="2" ht="22" customHeight="1">${prior}</row></sheetData></worksheet>`);
  const sharedValues = Array.from({ length: 640 }, (_, index) => `<si><t>${index === 0 ? "合成历史项目" : `未使用历史字符串${index}`}</t></si>`).join("");
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="640" uniqueCount="640">${sharedValues}</sst>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "DOS" });
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
}

async function makeImage(filePath, width, height, color) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 72 }).toBuffer();
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), width, height };
}

function manifestFor(root, baseline, firstImage, secondImage) {
  return {
    version: 3,
    rulesVersion: "synthetic-full-correspondence-v1",
    batch: {
      batchId: "synthetic-correspondence-batch",
      rootPath: root,
      archivePath: path.join(root, "synthetic-archive"),
      period: "2035.4.11-2035.4.16",
      mainPeriod: { start: "2035-04-11", end: "2035-04-16" },
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASE", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
      { id: "IMG-A", role: "material", path: firstImage.path, sha256: firstImage.sha256, kind: "image", disposition: "used", usage: "context" },
      { id: "IMG-B", role: "material", path: secondImage.path, sha256: secondImage.sha256, kind: "image", disposition: "used", usage: "voucher" },
    ],
    sourceScopes: [
      { id: "SCOPE-A", fileId: "IMG-A", locator: "full", terminalConfirmed: true, expectedUnitCount: 1 },
      { id: "SCOPE-B", fileId: "IMG-B", locator: "full", terminalConfirmed: true, expectedUnitCount: 2 },
    ],
    sourceUnits: [
      { id: "UNIT-A", scopeId: "SCOPE-A", locator: "first", disposition: "used" },
      { id: "UNIT-B", scopeId: "SCOPE-B", locator: "second", disposition: "used" },
      { id: "UNIT-C", scopeId: "SCOPE-B", locator: "third", disposition: "used" },
    ],
    transactions: [
      { id: "SYN-001", sourceOrder: 1, date: "2035-04-12", person: "合成人员甲", project: "合成运营项目", label: "合成人员甲", classification: "运营开支", sourceAmount: "19.37", reimbursementAmount: "19.37", reportingKind: "current", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-A"], sourceRefs: ["UNIT-A"] },
      { id: "SYN-002", sourceOrder: 2, date: "2035-03-08", person: "合成人员乙", project: "合成补报项目", label: "合成人员乙", classification: "日常报销", sourceAmount: "8.21", reimbursementAmount: "8.21", reportingKind: "supplement", supplementReason: "合成材料延迟", category: "小红书报销", settlement: "employee_reimbursement", evidence: ["IMG-A", "IMG-B"], sourceRefs: ["UNIT-B"] },
      { id: "SYN-003", sourceOrder: 3, date: "2035-04-15", person: "合成主体丙", project: "合成对公项目", label: "合成主体丙", classification: "广告费", sourceAmount: "4.56", reimbursementAmount: "0", reportingKind: "current", category: "小红书报销", settlement: "company_paid_no_reimbursement", evidence: ["IMG-B"], sourceRefs: ["UNIT-C"] },
    ],
    expected: { transactionCount: 3, feeTotal: "32.14", reimbursementTotal: "27.58", companyPaidNoReimbursementTotal: "4.56", uniqueMediaCount: 2, mediaReferenceCount: 4 },
  };
}

async function pngBytes() {
  return sharp(Buffer.from('<svg width="840" height="520" xmlns="http://www.w3.org/2000/svg"><rect width="840" height="520" fill="white"/><path d="M0 0L840 520M0 520L840 0" stroke="#175080" stroke-width="10"/></svg>')).png().toBuffer();
}

async function fakeRenderer({ request, requestFileSha256 }) {
  const previews = [];
  for (const job of request.jobs) {
    const bytes = await pngBytes();
    await fs.writeFile(job.outputPath, bytes, { flag: "wx" });
    previews.push({
      profileId: job.profileId,
      role: job.role,
      workbookSha256: job.workbookSha256,
      sheetName: job.sheetName,
      rangeAddress: job.rangeAddress,
      candidateSha256: job.candidateSha256,
      planSha256: job.planSha256,
      sourceCoverageDigest: job.sourceCoverageDigest,
      batchRows: [...job.batchRows],
      bindingDigest: job.bindingDigest,
      outputPath: job.outputPath,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      renderAttempts: 1,
    });
  }
  return { kind: "ordinary-reimbursement-preview-response-v2", requestNonce: request.requestNonce, requestFileSha256, bindingDigest: request.bindingDigest, enginePeakWorkingSetBytes: 800_000, previews };
}

function reviewFor(gate1, firstImage, secondImage, mutate = (value) => value) {
  const observations = [
    { sourceRef: "UNIT-A", fileId: "IMG-A", sourceSha256: firstImage.sha256, mediaKind: "image", width: firstImage.width, height: firstImage.height, facts: [{ transactionId: "SYN-001", date: "2035-04-12", person: "合成人员甲", project: "合成运营项目", sourceAmount: "19.37" }] },
    { sourceRef: "UNIT-B", fileId: "IMG-B", sourceSha256: secondImage.sha256, mediaKind: "image", width: secondImage.width, height: secondImage.height, facts: [{ transactionId: "SYN-002", date: "2035-03-08", person: "合成人员乙", project: "合成补报项目", sourceAmount: "8.21" }] },
    { sourceRef: "UNIT-C", fileId: "IMG-B", sourceSha256: secondImage.sha256, mediaKind: "image", width: secondImage.width, height: secondImage.height, facts: [{ transactionId: "SYN-003", date: "2035-04-15", person: "合成主体丙", project: "合成对公项目", sourceAmount: "4.56" }] },
  ];
  return mutate({
    kind: "independent-evidence-review-v1",
    reviewerRunId: crypto.randomBytes(16).toString("hex"),
    gate1BindingDigest: gate1.gate1BindingDigest,
    sourceCoverageDigest: gate1.review[0].previews[0].sourceCoverageDigest,
    independence: { performedAfterGate1: true, originalSourcesReadFresh: true, gate1ArtifactsNotUsed: true, observationsNotCopied: true },
    observations,
    annotationObservations: [],
  });
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes) };
}

async function rewriteZipPart(filePath, partName, transform) {
  return rewriteZipFile(filePath, async (zip) => {
    const entry = zip.file(partName);
    assert.ok(entry, `${partName} must exist in the synthetic workbook`);
    const prior = await entry.async("string");
    const next = transform(prior);
    assert.notEqual(next, prior, `${partName} mutation must change synthetic bytes`);
    zip.file(partName, next);
  });
}

async function rewriteZipFile(filePath, mutate) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath), { createFolders: false });
  await mutate(zip);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  await fs.writeFile(filePath, bytes);
  return { sha256: sha256Bytes(bytes), size: bytes.length };
}

function tamperedRootPreviewBuilder(mutate) {
  return async (...args) => {
    const result = structuredClone(await buildRootWorkbookCandidates(...args));
    const artifact = result.artifacts[0];
    const binding = await rewriteZipFile(artifact.previewPath, mutate);
    artifact.previewSha256 = binding.sha256;
    artifact.previewSize = binding.size;
    result.ownedFiles = result.ownedFiles.map((item) => item.path === artifact.previewPath ? { path: item.path, ...binding } : item);
    return result;
  };
}

function rebindPresentation(result, artifact, binding) {
  const artifactBody = { ...artifact };
  delete artifactBody.artifactDigest;
  artifact.artifactDigest = canonicalDigest(artifactBody);
  result.ownedFiles = result.ownedFiles.map((item) => item.path === binding.path ? { path: item.path, sha256: binding.sha256, size: binding.size } : item);
  const resultBody = { ...result };
  delete resultBody.buildDigest;
  result.buildDigest = canonicalDigest(resultBody);
  return result;
}

function tamperedPresentationBuilder(role, transform) {
  return async (...args) => {
    const result = structuredClone(await buildReimbursementArtifacts(...args));
    const artifact = result.artifacts[0];
    const binding = artifact[role];
    Object.assign(binding, await rewriteZipPart(binding.path, transform.partName, transform.change));
    return rebindPresentation(result, artifact, binding);
  };
}

function tamperedSupplementBuilder(transform) {
  return async (...args) => {
    const result = structuredClone(await buildReimbursementArtifacts(...args));
    const artifact = result.artifacts[0];
    const binding = artifact.supplements[0];
    Object.assign(binding, await rewriteZipPart(binding.path, transform.partName, transform.change));
    return rebindPresentation(result, artifact, binding);
  };
}

function tamperedRootBuilder(transform) {
  return async (...args) => {
    const result = structuredClone(await buildRootWorkbookCandidates(...args));
    const artifact = result.artifacts[0];
    const binding = { path: artifact.candidatePath, sha256: artifact.candidateSha256, size: artifact.candidateSize };
    Object.assign(binding, await rewriteZipPart(binding.path, transform.partName, transform.change));
    artifact.candidateSha256 = binding.sha256;
    artifact.candidateSize = binding.size;
    result.ownedFiles = result.ownedFiles.map((item) => item.path === binding.path ? { path: item.path, sha256: binding.sha256, size: binding.size } : item);
    return result;
  };
}

function replaceOnce(pattern, replacement) {
  return (value) => {
    const next = value.replace(pattern, replacement);
    assert.notEqual(next, value, `synthetic mutation ${String(pattern)} must match`);
    return next;
  };
}

async function prepareFixture(temp, { buildPresentation = buildReimbursementArtifacts, buildRoot = buildRootWorkbookCandidates, mutateManifest = (value) => value } = {}) {
  const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
  const firstImage = await makeImage(path.join(temp, "synthetic-a.jpg"), 420, 280, { r: 30, g: 110, b: 170 });
  const secondImage = await makeImage(path.join(temp, "synthetic-b.jpg"), 510, 330, { r: 150, g: 70, b: 40 });
  const manifest = mutateManifest(manifestFor(temp, baseline, firstImage, secondImage));
  const manifestFile = await writeJson(path.join(temp, "manifest.json"), manifest);
  const token = crypto.randomBytes(32).toString("hex");
  const gate1 = await prepareReimbursementWorkflow({
    kind: "ordinary-reimbursement-prepare-v1",
    stagingToken: token,
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
    baselines: [{ profileId: "xiaohongshu", path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: 1 }],
  }, { testHooks: { runPreviewRenderer: fakeRenderer, buildReimbursementArtifacts: buildPresentation, buildRootWorkbookCandidates: buildRoot } });
  return { baseline, firstImage, secondImage, manifest, gate1, workflowRoot: path.dirname(gate1.statePath) };
}

test("real builders survive a ready-preview retry without rebuilding or losing committed candidate paths", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-real-ready-preview-"));
  const token = crypto.randomBytes(32).toString("hex");
  const workflowRoot = path.join(os.tmpdir(), `codex-xhs-workflow-${token}`);
  try {
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const firstImage = await makeImage(path.join(temp, "resume-a.jpg"), 420, 280, { r: 30, g: 110, b: 170 });
    const secondImage = await makeImage(path.join(temp, "resume-b.jpg"), 510, 330, { r: 150, g: 70, b: 40 });
    const manifestFile = await writeJson(path.join(temp, "manifest.json"), manifestFor(temp, baseline, firstImage, secondImage));
    const request = { kind: "ordinary-reimbursement-prepare-v1", stagingToken: token, manifestPath: manifestFile.path, manifestSha256: manifestFile.sha256, baselines: [{ profileId: "xiaohongshu", path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: 1 }] };
    let rootBuildCount = 0;
    let presentationBuildCount = 0;
    let renderCount = 0;
    const hooks = {
      buildRootWorkbookCandidates: async (...args) => { rootBuildCount += 1; return buildRootWorkbookCandidates(...args); },
      buildReimbursementArtifacts: async (...args) => { presentationBuildCount += 1; return buildReimbursementArtifacts(...args); },
      runPreviewRenderer: async ({ request: previewRequest, requestFileSha256 }) => {
        renderCount += 1;
        if (renderCount === 1) throw new Error("synthetic first render failure");
        return fakeRenderer({ request: previewRequest, requestFileSha256 });
      },
    };
    await assert.rejects(() => prepareReimbursementWorkflow(request, { testHooks: hooks }), /business artifacts are preserved/u);
    const checkpoint = JSON.parse(await fs.readFile(path.join(workflowRoot, "ready-preview.json"), "utf8"));
    for (const owned of checkpoint.rootBuild.ownedFiles) {
      const bytes = await fs.readFile(owned.path);
      assert.equal(sha256Bytes(bytes), owned.sha256, `real root owned path must exist after candidate rename: ${owned.path}`);
    }
    const gate1 = await prepareReimbursementWorkflow(request, { testHooks: hooks });
    assert.equal(gate1.status, "ready-for-gate-1");
    assert.equal(rootBuildCount, 1);
    assert.equal(presentationBuildCount, 1);
    assert.equal(renderCount, 2);
    assert.equal(JSON.parse(await fs.readFile(gate1.statePath, "utf8")).reusedPreviewCheckpoint, true);
  } finally {
    await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("presentation's independent manifest snapshot catches an audit-to-build TOCTOU change", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-manifest-toctou-"));
  const token = crypto.randomBytes(32).toString("hex");
  const workflowRoot = path.join(os.tmpdir(), `codex-xhs-workflow-${token}`);
  try {
    const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
    const baselineBefore = await fs.readFile(baseline.path);
    const firstImage = await makeImage(path.join(temp, "toctou-a.jpg"), 420, 280, { r: 30, g: 110, b: 170 });
    const secondImage = await makeImage(path.join(temp, "toctou-b.jpg"), 510, 330, { r: 150, g: 70, b: 40 });
    const manifest = manifestFor(temp, baseline, firstImage, secondImage);
    const manifestFile = await writeJson(path.join(temp, "manifest.json"), manifest);
    const changedManifestBytes = Buffer.from(`${JSON.stringify({ ...manifest, rulesVersion: "synthetic-toctou-change" })}\n`, "utf8");
    let changed = false;
    const rootBuilder = (...args) => {
      if (!changed) {
        writeFileSync(manifestFile.path, changedManifestBytes);
        changed = true;
      }
      return buildRootWorkbookCandidates(...args);
    };
    await assert.rejects(prepareReimbursementWorkflow({
      kind: "ordinary-reimbursement-prepare-v1",
      stagingToken: token,
      manifestPath: manifestFile.path,
      manifestSha256: manifestFile.sha256,
      baselines: [{ profileId: "xiaohongshu", path: baseline.path, sha256: baseline.sha256, size: baseline.size, candidateRevision: 1 }],
    }, { testHooks: { runPreviewRenderer: fakeRenderer, buildRootWorkbookCandidates: rootBuilder } }), /manifest.*(?:changed|SHA)/iu);
    assert.equal(changed, true);
    assert.deepEqual(await fs.readFile(baseline.path), baselineBefore, "TOCTOU rejection must not change the baseline ledger");
    await assert.rejects(fs.access(workflowRoot), /ENOENT/u);
  } finally {
    await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 performs one cached full-correspondence pass and exposes its report", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-correspondence-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    const reviewFile = await writeJson(path.join(temp, "independent-review.json"), review);
    let gate2;
    try {
      gate2 = await finalizeReimbursementWorkflow({
        statePath: fixture.gate1.statePath,
        expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
        approvalText: "本次报销通过无误",
        independentEvidenceReviewPath: reviewFile.path,
        independentEvidenceReviewSha256: reviewFile.sha256,
      });
    } catch (error) {
      const report = JSON.parse(await fs.readFile(path.join(fixture.workflowRoot, "gate2-full-correspondence.json"), "utf8"));
      assert.fail(`${error.message}\n${JSON.stringify({ missing: report.missing, extra: report.extra, mismatches: report.mismatches, duplicate: report.duplicate, unbound: report.unbound }, null, 2)}`);
    }
    assert.equal(gate2.status, "ready-for-gate-2");
    assert.equal(gate2.fullCorrespondenceAudit.status, "passed");
    assert.equal(gate2.fullCorrespondenceAudit.coverage.expectedTransactions, fixture.manifest.transactions.length);
    assert.equal(gate2.fullCorrespondenceAudit.coverage.auditedTransactions, fixture.manifest.transactions.length);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueMediaReadCount, 2);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueMediaDecodeCount, 2);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueSourceReadCount, 2);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueArchiveMediaReadCount, 2);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.artifactParseCount, 6);
    assert.deepEqual(gate2.fullCorrespondenceAudit.metrics.artifactParseByRole, { detail: 1, screenshot: 1, summary: 1, supplement: 1, candidate: 1, "root-preview": 1 });
    assert.equal(gate2.fullCorrespondenceAudit.metrics.candidateSharedStringsLoaded, 0, "candidate batch projection must not expand historical shared strings");
    assert.equal(gate2.fullCorrespondenceAudit.metrics.candidateProjectedRowCount, fixture.manifest.transactions.length);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.artifactCacheHits, 0);
    assert.equal(Object.values(gate2.fullCorrespondenceAudit.issueCounts).every((count) => count === 0), true);
    const report = JSON.parse(await fs.readFile(gate2.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.transactionResults.every((item) => item.status === "matched" && item.fullyAudited && item.canonicalFacts && item.observedFactsBySourceRef.length > 0), true);
    assert.deepEqual(Object.keys(report.transactionResults[0].checks), ["visual", "detail", "screenshot", "supplement", "summary", "candidate", "root-preview", "preview-binding", "evidence"]);
    assert.equal(report.transactionResults.every((item) => ["visual", "evidence", "root-preview", "preview-binding"].every((stage) => item.checks[stage].status === "passed")), true);
    assert.equal(report.reportDigest, canonicalDigest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "reportDigest"))));
    assert.equal(report.independentEvidenceReviewDigest, canonicalDigest(review));
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 overlaps fresh source decode with Gate 1 artifact loading while retaining both audits", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-read-overlap-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "overlap-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    let activeFreshReads = 0;
    let freshReadCalls = 0;
    let artifactLoadCalls = 0;
    let artifactLoadObservedFreshRead = false;
    let activeArchiveReads = 0;
    let archiveReadCalls = 0;
    let artifactTasksObservedArchiveRead = false;
    let activeGate2PreviewReads = 0;
    let gate2PreviewReadCalls = 0;
    let correspondenceObservedGate2PreviewRead = false;
    const gate2 = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    }, {
      testHooks: {
        fullCorrespondenceHooks: {
          beforeSourceRead: async () => {
            freshReadCalls += 1;
            correspondenceObservedGate2PreviewRead ||= activeGate2PreviewReads > 0;
            activeFreshReads += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            activeFreshReads -= 1;
          },
          beforeArtifactLoad: ({ taskKeys }) => {
            artifactLoadCalls += 1;
            artifactLoadObservedFreshRead ||= activeFreshReads > 0;
            assert.deepEqual(taskKeys, ["detail", "screenshot", "summary", "supplement:0", "candidate", "root-preview"]);
          },
          beforeEvidenceArchiveRead: async () => {
            archiveReadCalls += 1;
            activeArchiveReads += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            activeArchiveReads -= 1;
          },
          beforeArtifactTasksExecute: ({ taskKeys }) => {
            artifactTasksObservedArchiveRead ||= activeArchiveReads > 0;
            assert.deepEqual(taskKeys, ["detail", "screenshot", "summary", "supplement:0", "candidate", "root-preview"]);
          },
        },
        beforeGate2PreviewRead: async () => {
          gate2PreviewReadCalls += 1;
          activeGate2PreviewReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeGate2PreviewReads -= 1;
        },
      },
    });
    assert.equal(gate2.status, "ready-for-gate-2");
    assert.equal(freshReadCalls, 2);
    assert.equal(artifactLoadCalls, 1);
    assert.equal(artifactLoadObservedFreshRead, true, "artifact loading must start while fresh source reads are still active");
    assert.equal(archiveReadCalls, 2);
    assert.equal(artifactTasksObservedArchiveRead, true, "artifact loading must start while evidence archive reads are still active");
    assert.equal(gate2PreviewReadCalls, 3);
    assert.equal(correspondenceObservedGate2PreviewRead, true, "full correspondence must start while Gate 2 preview reads are still active");
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueMediaDecodeCount, 2);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.artifactParseCount, 6);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 cannot pass when a required transaction correspondence stage was not checked", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-required-stage-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "required-stage-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await assert.rejects(() => finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    }, { testHooks: { fullCorrespondenceHooks: { omitTransactionCheckStages: [{ transactionId: "SYN-001", stage: "evidence" }] } } }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.missing.length + report.extra.length + report.mismatches.length + report.duplicate.length + report.unbound.length, 0, "the final status must not depend on issue-array count alone");
    const transaction = report.transactionResults.find((item) => item.transactionId === "SYN-001");
    assert.equal(transaction.checks.evidence.status, "not-checked");
    assert.equal(transaction.status, "failed");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 invalidates a wrong summary already bound and displayed by Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-bound-wrong-"));
  let workflowRoot;
  try {
    const tamperedBuilder = async (...args) => {
      const original = await buildReimbursementArtifacts(...args);
      const result = structuredClone(original);
      const artifact = result.artifacts[0];
      const wrongText = artifact.summary.text.replace(/实报合计：[^\n]+/u, "实报合计：91.73元");
      const bytes = Buffer.from(wrongText, "utf8");
      await fs.writeFile(artifact.summary.path, bytes);
      artifact.summary.sha256 = sha256Bytes(bytes);
      artifact.summary.size = bytes.length;
      artifact.summary.text = wrongText;
      artifact.summary.textSha256 = sha256Bytes(bytes);
      const artifactBody = { ...artifact };
      delete artifactBody.artifactDigest;
      artifact.artifactDigest = canonicalDigest(artifactBody);
      result.ownedFiles = result.ownedFiles.map((item) => item.path === artifact.summary.path ? { path: item.path, sha256: artifact.summary.sha256, size: artifact.summary.size } : item);
      const buildBody = { ...result };
      delete buildBody.buildDigest;
      result.buildDigest = canonicalDigest(buildBody);
      return result;
    };
    const fixture = await prepareFixture(temp, { buildPresentation: tamperedBuilder });
    workflowRoot = fixture.workflowRoot;
    assert.match(fixture.gate1.review[0].summary, /91\.73元/u, "Gate 1 must bind and display the wrong synthetic summary for this regression");
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    const reviewFile = await writeJson(path.join(temp, "correct-independent-review.json"), review);
    await assert.rejects(() => finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.mismatches.some((item) => item.code === "summary-contract-mismatch"), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(workflowRoot, "gate1-invalidation.json"), "utf8")).kind, "gate1-invalidation-v1");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 binds commission, bonus, and allowance annotations to transactions and summary clauses", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-annotations-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.transactions[2].settlement = "employee_reimbursement";
      manifest.transactions[2].reimbursementAmount = manifest.transactions[2].sourceAmount;
      manifest.expected.reimbursementTotal = manifest.expected.feeTotal;
      manifest.expected.companyPaidNoReimbursementTotal = "0";
      manifest.batch.summaryAnnotations = [
        { profileId: "xiaohongshu", person: "合成人员甲", kind: "commission", period: { start: "2035-04-01", end: "2035-04-10" }, amount: "19.37", transactionIds: ["SYN-001"], sourceRefs: ["UNIT-A"] },
        { profileId: "xiaohongshu", person: "合成人员乙", kind: "bonus", period: { start: "2035-03-08", end: "2035-03-08" }, amount: "8.21", transactionIds: ["SYN-002"], sourceRefs: ["UNIT-B"] },
        { profileId: "xiaohongshu", person: "合成主体丙", kind: "allowance", period: { start: "2035-04-15", end: "2035-04-15" }, amount: "4.56", transactionIds: ["SYN-003"], sourceRefs: ["UNIT-C"] },
      ];
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    assert.match(fixture.gate1.review[0].summary, /引流提成/u);
    assert.match(fixture.gate1.review[0].summary, /奖金/u);
    assert.match(fixture.gate1.review[0].summary, /补贴/u);
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.annotationObservations = [
      { profileId: "xiaohongshu", person: "合成人员甲", kind: "commission", period: { start: "2035-04-01", end: "2035-04-10" }, amount: "19.37", sourceRefs: ["UNIT-A"] },
      { profileId: "xiaohongshu", person: "合成人员乙", kind: "bonus", period: { start: "2035-03-08", end: "2035-03-08" }, amount: "8.21", sourceRefs: ["UNIT-B"] },
      { profileId: "xiaohongshu", person: "合成主体丙", kind: "allowance", period: { start: "2035-04-15", end: "2035-04-15" }, amount: "4.56", sourceRefs: ["UNIT-C"] },
    ];
    const reviewFile = await writeJson(path.join(temp, "annotation-review.json"), review);
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const report = JSON.parse(await fs.readFile(gate2.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.coverage.annotationCount, 3);
    assert.deepEqual(report.annotationResults.map((item) => item.kind), ["commission", "bonus", "allowance"]);
    assert.equal(report.annotationResults.every((item) => item.status === "matched"), true);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 rejects a summary annotation not confirmed by the independent source review", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-annotation-review-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.batch.summaryAnnotations = [{
        profileId: "xiaohongshu",
        person: "合成人员甲",
        kind: "commission",
        period: { start: "2035-04-01", end: "2035-04-10" },
        amount: "19.37",
        transactionIds: ["SYN-001"],
        sourceRefs: ["UNIT-A"],
      }];
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.annotationObservations = [{
      profileId: "xiaohongshu",
      person: "合成人员甲",
      kind: "commission",
      period: { start: "2035-04-01", end: "2035-04-10" },
      amount: "18.91",
      sourceRefs: ["UNIT-A"],
    }];
    const reviewFile = await writeJson(path.join(temp, "wrong-annotation-review.json"), review);
    await assert.rejects(() => finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.annotationResults[0].status, "failed");
    assert.equal(report.missing.some((item) => item.code === "independent-review-summary-annotation-missing"), true);
    assert.equal(report.extra.some((item) => item.code === "independent-review-summary-annotation-extra"), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(workflowRoot, "gate1-invalidation.json"), "utf8")).kind, "gate1-invalidation-v1");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("supplement audit keeps source expense and reimbursement semantics distinct", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-partial-supplement-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.transactions[1].reimbursementAmount = "5.13";
      manifest.expected.reimbursementTotal = "24.50";
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "partial-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const report = JSON.parse(await fs.readFile(gate2.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.supplementResults[0].amount, "5.13");
    assert.equal(report.totals.reimbursementAmount, "24.5");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const conflict of [false, true]) test(`independent visual observations ${conflict ? "reject conflicts" : "aggregate partial facts across multiple images"}`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-partial-observation-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.transactions[1].sourceRefs = ["UNIT-A", "UNIT-B"];
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations[0].facts.push({ transactionId: "SYN-002", date: "2035-03-08", person: "合成人员乙", ...(conflict ? { sourceAmount: "6.44" } : {}) });
    review.observations[1].facts = [{ transactionId: "SYN-002", project: "合成补报项目", sourceAmount: "8.21" }];
    const reviewFile = await writeJson(path.join(temp, "partial-observations.json"), review);
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    if (!conflict) {
      const gate2 = await finalizeReimbursementWorkflow(request);
      assert.equal(gate2.fullCorrespondenceAudit.status, "passed");
    } else {
      await assert.rejects(() => finalizeReimbursementWorkflow(request), /permanently invalid/u);
      const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
      assert.equal(report.mismatches.some((item) => item.code === "independent-review-transaction-field-conflict" && item.transactionId === "SYN-002"), true);
    }
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

const GATE1_BOUND_TAMPERS = [
  {
    name: "detail amount",
    options: { buildPresentation: tamperedPresentationBuilder("detail", { partName: "xl/worksheets/sheet1.xml", change: replaceOnce(/(<c r="C8"[^>]*><v>)19\.37(<\/v><\/c>)/u, "$188.42$2") }) },
    issueCode: "transaction-row-mismatch",
  },
  {
    name: "detail classification",
    options: { buildPresentation: tamperedPresentationBuilder("detail", { partName: "xl/worksheets/sheet1.xml", change: replaceOnce(/(<c r="E8"[^>]*><is><t[^>]*>)运营开支(<\/t><\/is><\/c>)/u, "$1合成错误分类$2") }) },
    issueCode: "transaction-row-mismatch",
  },
  {
    name: "detail person-group cached total",
    options: { buildPresentation: tamperedPresentationBuilder("detail", { partName: "xl/worksheets/sheet1.xml", change: replaceOnce(/(<c r="F7"[^>]*><f>SUM\(C8:C8\)<\/f><v>)19\.37(<\/v><\/c>)/u, "$117.11$2") }) },
    issueCode: "detail-person-group-total-mismatch",
  },
  {
    name: "screenshot note",
    options: { buildPresentation: tamperedPresentationBuilder("screenshot", { partName: "xl/worksheets/sheet1.xml", change: replaceOnce(/(<c r="E2"[^>]*><is><t[^>]*>)运营开支(<\/t><\/is><\/c>)/u, "$1合成错误备注$2") }) },
    issueCode: "screenshot-row-mismatch",
  },
  {
    name: "screenshot image mapping",
    options: { buildPresentation: tamperedPresentationBuilder("screenshot", { partName: "xl/drawings/_rels/drawing1.xml.rels", change: (value) => value.replace("../media/image1.jpg", "../media/__swap__.jpg").replace("../media/image2.jpg", "../media/image1.jpg").replace("../media/__swap__.jpg", "../media/image2.jpg") }) },
    issueCode: "screenshot-image-mapping-mismatch",
  },
  {
    name: "supplement transaction start",
    options: { buildPresentation: tamperedSupplementBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce(/(<c r="B5"[^>]*><is><t[^>]*>)合成补报项目(<\/t><\/is><\/c>)/u, "$1冗余人员分组$2") }) },
    issueCode: "transaction-row-mismatch",
  },
  {
    name: "supplement footer formula",
    options: { buildPresentation: tamperedSupplementBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce("<f>SUM(C5:C5)</f>", "<f>SUM(C5:C6)</f>") }) },
    issueCode: "formula-mismatch",
  },
  {
    name: "supplement footer merge",
    options: { buildPresentation: tamperedSupplementBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce('<mergeCell ref="C6:F6"/>', "") }) },
    issueCode: "required-merge-missing",
  },
  {
    name: "duplicate supplement footer",
    options: { buildPresentation: tamperedSupplementBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce("</sheetData>", '<row r="7" ht="28" customHeight="1"><c r="A7" t="inlineStr" s="30"><is><t xml:space="preserve">补报总计</t></is></c></row></sheetData>') }) },
    issueCode: "supplement-footer-count-mismatch",
  },
  {
    name: "candidate batch row",
    options: { buildRoot: tamperedRootBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce("合成运营项目", "合成错误候选项目") }) },
    issueCode: "candidate-row-mismatch",
  },
  {
    name: "candidate D:F merge crossing a batch/history boundary",
    options: { buildRoot: tamperedRootBuilder({ partName: "xl/worksheets/sheet1.xml", change: replaceOnce("</sheetData>", '</sheetData><mergeCells count="1"><mergeCell ref="D2:D3"/></mergeCells>') }) },
    issueCode: "candidate-merge-crosses-unbound-row",
  },
];

for (const scenario of GATE1_BOUND_TAMPERS) test(`Gate 2 invalidates Gate 1-bound wrong ${scenario.name}`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-bound-artifact-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, scenario.options);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "correct-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.status, "failed");
    assert.equal([...report.mismatches, ...report.missing, ...report.extra, ...report.duplicate, ...report.unbound].some((item) => item.code === scenario.issueCode), true, JSON.stringify(report.mismatches, null, 2));
    assert.equal(JSON.parse(await fs.readFile(path.join(workflowRoot, "gate1-invalidation.json"), "utf8")).kind, "gate1-invalidation-v1");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("transaction coverage never reports matched rows after an early profile artifact parse failure", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-parse-coverage-"));
  let workflowRoot;
  try {
    const brokenDetail = tamperedPresentationBuilder("detail", { partName: "xl/workbook.xml", change: replaceOnce('name="本次报销明细"', 'name="BrokenSyntheticSheet"') });
    const fixture = await prepareFixture(temp, { buildPresentation: brokenDetail });
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "parse-coverage-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.coverage.auditedTransactions, 0);
    assert.equal(report.transactionResults.every((item) => item.status === "failed" && item.fullyAudited === false && item.checks.detail.status === "not-checked"), true);
    assert.equal(report.transactionResults.every((item) => item.canonicalFacts && Array.isArray(item.observedFactsBySourceRef)), true);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

const ROOT_PREVIEW_STRUCTURE_TAMPERS = [
  {
    name: "value outside A:F",
    mutate: async (zip) => {
      const entry = zip.file("xl/worksheets/sheet1.xml");
      const prior = await entry.async("string");
      zip.file("xl/worksheets/sheet1.xml", prior.replace(/(<row r="2"[^>]*>)/u, `$1${tCell("G2", 2, "hidden synthetic sentinel")}`));
    },
  },
  {
    name: "hidden extra worksheet",
    mutate: async (zip) => {
      const workbook = await zip.file("xl/workbook.xml").async("string");
      const relationships = await zip.file("xl/_rels/workbook.xml.rels").async("string");
      zip.file("xl/workbook.xml", workbook.replace("</sheets>", '<sheet name="HiddenSynthetic" sheetId="99" state="hidden" r:id="rId99"/></sheets>'));
      zip.file("xl/_rels/workbook.xml.rels", relationships.replace("</Relationships>", '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet99.xml"/></Relationships>'));
      zip.file("xl/worksheets/sheet99.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden synthetic sentinel</t></is></c></row></sheetData></worksheet>');
    },
  },
];

for (const scenario of ROOT_PREVIEW_STRUCTURE_TAMPERS) test(`root batch preview rejects ${scenario.name}`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-root-preview-structure-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { buildRoot: tamperedRootPreviewBuilder(scenario.mutate) });
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "root-preview-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "artifact-parse-or-validation-failure" && item.artifact === "gate1-deliverables"), true);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a wrong second visual observation permanently invalidates that Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-invalid-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage, (value) => {
      value.observations[0].facts[0].sourceAmount = "77.31";
      return value;
    });
    const reviewFile = await writeJson(path.join(temp, "wrong-review.json"), review);
    const request = {
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    };
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /permanently invalid/u);
    const marker = JSON.parse(await fs.readFile(path.join(fixture.workflowRoot, "gate1-invalidation.json"), "utf8"));
    assert.equal(marker.kind, "gate1-invalidation-v1");
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /permanently invalidated/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a transient Gate 2 infrastructure error preserves Gate 1 for retry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-retryable-system-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    const invalidReview = structuredClone(review);
    delete invalidReview.annotationObservations;
    const invalidReviewFile = await writeJson(path.join(temp, "invalid-review-schema.json"), invalidReview);
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: invalidReviewFile.path, independentEvidenceReviewSha256: invalidReviewFile.sha256 }), /Gate 1 remains valid/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    const reviewFile = await writeJson(path.join(temp, "retryable-review.json"), review);
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    await assert.rejects(
      () => finalizeReimbursementWorkflow(request, {
        testHooks: {
          beforeGate2PreviewRead: () => { throw new Error("synthetic preview verification failure"); },
          fullCorrespondenceHooks: {
            beforeSourceRead: () => {
              const error = new Error("synthetic source is temporarily locked");
              error.code = "EACCES";
              throw error;
            },
          },
        },
      }),
      (error) => {
        assert.match(error.message, /Gate 1 remains valid/u);
        assert.doesNotMatch(error.message, /synthetic preview verification failure/u);
        return true;
      },
    );
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate2-full-correspondence.json")), /ENOENT/u);
    const retried = await finalizeReimbursementWorkflow(request);
    assert.equal(retried.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("evidence archive cache verifies every bound path even when expected SHA is shared", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-archive-path-cache-"));
  let workflowRoot;
  try {
    const duplicateArchiveBuilder = async (...args) => {
      const result = structuredClone(await buildReimbursementArtifacts(...args));
      const artifact = result.artifacts[0];
      const original = artifact.evidenceArchive[0];
      const corruptPath = path.join(path.dirname(original.path), "synthetic-corrupt-archive.jpg");
      const corruptBytes = Buffer.from("synthetic-corrupt-archive-bytes", "utf8");
      await fs.writeFile(corruptPath, corruptBytes, { flag: "wx" });
      artifact.evidenceArchive.push({ ...original, evidenceId: "SYN-DUPLICATE-ARCHIVE", path: corruptPath });
      result.ownedFiles.push({ path: corruptPath, sha256: sha256Bytes(corruptBytes), size: corruptBytes.length });
      const artifactBody = { ...artifact };
      delete artifactBody.artifactDigest;
      artifact.artifactDigest = canonicalDigest(artifactBody);
      const buildBody = { ...result };
      delete buildBody.buildDigest;
      result.buildDigest = canonicalDigest(buildBody);
      return result;
    };
    const fixture = await prepareFixture(temp, { buildPresentation: duplicateArchiveBuilder });
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "archive-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }), /permanently invalid/u);
    const report = JSON.parse(await fs.readFile(path.join(workflowRoot, "gate2-full-correspondence.json"), "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "evidence-archive-bytes-mismatch" && item.evidenceId === "SYN-DUPLICATE-ARCHIVE"), true);
    assert.equal(report.metrics.uniqueArchiveMediaReadCount, 3, "each distinct archive path must be read once");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});
