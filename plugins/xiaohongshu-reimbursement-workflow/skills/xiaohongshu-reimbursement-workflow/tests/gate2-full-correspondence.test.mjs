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
  GATE1_RESTART_REQUIRED_ERROR_CODE,
  readVerifiedGate1ManifestSnapshot,
} from "../scripts/audit_full_correspondence.mjs";
import {
  finalizeReimbursementWorkflow,
  prepareReimbursementWorkflow,
  publishReimbursementWorkflow,
  reviseGate2ReimbursementWorkflow,
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
  zip.file("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="mm-dd"/><numFmt numFmtId="165" formatCode="0.000"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="165"/><xf numFmtId="1"/><xf numFmtId="166"/><xf numFmtId="2"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>');
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

function resolveGate1ContentError(review, attempt, revisedManifestSha256) {
  return {
    ...structuredClone(review),
    reviewerRunId: crypto.randomBytes(16).toString("hex"),
    findingResolution: {
      kind: "gate2-finding-resolution-v1",
      priorReportDigest: attempt.fullCorrespondenceAudit.reportDigest,
      priorReviewSha256: attempt.independentEvidenceReview.sha256,
      decision: "gate1-content-error",
      reason: "independent recheck confirmed the original material facts",
      revisedManifestSha256,
    },
  };
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes) };
}

async function rewriteWorkflowState(statePath, mutate) {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  mutate(state);
  const core = structuredClone(state);
  delete core.stateDigest;
  state.stateDigest = canonicalDigest(core);
  await fs.writeFile(statePath, Buffer.from(`${JSON.stringify(state)}\n`, "utf8"));
  return state;
}

function refreshCorrectionAuthorization(correction) {
  const core = structuredClone(correction);
  delete core.authorizationDigest;
  correction.authorizationDigest = canonicalDigest(core);
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

async function prepareFixture(temp, { buildPresentation = buildReimbursementArtifacts, buildRoot = buildRootWorkbookCandidates, mutateManifest = (value) => value, afterFilesCreated = async () => {} } = {}) {
  const baseline = await makeBaseline(path.join(temp, "小红书支出总表.xlsx"));
  const firstImage = await makeImage(path.join(temp, "synthetic-a.jpg"), 420, 280, { r: 30, g: 110, b: 170 });
  const secondImage = await makeImage(path.join(temp, "synthetic-b.jpg"), 510, 330, { r: 150, g: 70, b: 40 });
  await afterFilesCreated({ temp, baseline, firstImage, secondImage });
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
  return { baseline, firstImage, secondImage, manifest, manifestFile, gate1, workflowRoot: path.dirname(gate1.statePath) };
}

async function reviseFromGate2Attempt(fixture, attempt, {
  manifestFile = fixture.manifestFile,
  buildPresentation,
  buildRoot,
} = {}) {
  return reviseGate2ReimbursementWorkflow({
    statePath: fixture.gate1.statePath,
    expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
    gate2AttemptReportPath: attempt.fullCorrespondenceAudit.path,
    gate2AttemptReportSha256: attempt.fullCorrespondenceAudit.sha256,
    stagingToken: crypto.randomBytes(32).toString("hex"),
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
  }, {
    testHooks: {
      runPreviewRenderer: fakeRenderer,
      ...(buildPresentation ? { buildReimbursementArtifacts: buildPresentation } : {}),
      ...(buildRoot ? { buildRootWorkbookCandidates: buildRoot } : {}),
    },
  });
}

async function preparePersonCorrectionFixture(temp, { mutateCorrectedManifest = (value) => value } = {}) {
  let correctedManifest;
  const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
    manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
    correctedManifest = structuredClone(manifest);
    correctedManifest.batch.reviewRevision += 1;
    correctedManifest = mutateCorrectedManifest(correctedManifest);
    manifest.transactions[2].person = "错误付款主体";
    return manifest;
  } });
  const reviewFile = await writeJson(path.join(temp, "lineage-original-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
  const reviewRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
  const correctedManifestFile = await writeJson(path.join(temp, "lineage-corrected-manifest.json"), correctedManifest);
  const resolvedReviewFile = await writeJson(
    path.join(temp, "lineage-resolved-review.json"),
    resolveGate1ContentError(await fs.readFile(reviewFile.path, "utf8").then(JSON.parse), reviewRequired, correctedManifestFile.sha256),
  );
  const correctionRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: resolvedReviewFile.path, independentEvidenceReviewSha256: resolvedReviewFile.sha256 });
  const corrected = await reviseFromGate2Attempt(fixture, correctionRequired, { manifestFile: correctedManifestFile });
  return { fixture, corrected, correctedManifestFile, reviewFile };
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
    const gate1State = JSON.parse(await fs.readFile(fixture.gate1.statePath, "utf8"));
    assert.equal(gate1State.manifest.size, (await fs.stat(fixture.manifestFile.path)).size);
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

test("a lost successful Gate 2 response can be replayed idempotently", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-success-replay-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "success-replay-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    const first = await finalizeReimbursementWorkflow(request);
    const second = await finalizeReimbursementWorkflow(request);
    assert.equal(second.statePath, first.statePath);
    assert.equal(second.stateSha256, first.stateSha256);
    assert.equal(second.gate2BindingDigest, first.gate2BindingDigest);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("an invalid correspondence checkpoint takes precedence over a damaged candidate plan", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-checkpoint-priority-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "checkpoint-priority-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    const first = await finalizeReimbursementWorkflow(request);
    const checkpoint = JSON.parse(await fs.readFile(first.fullCorrespondenceAudit.path, "utf8"));
    checkpoint.status = "tampered";
    delete checkpoint.reportDigest;
    checkpoint.reportDigest = canonicalDigest(checkpoint);
    await fs.writeFile(first.fullCorrespondenceAudit.path, `${JSON.stringify(checkpoint)}\n`, "utf8");
    const gate1State = JSON.parse(await fs.readFile(fixture.gate1.statePath, "utf8"));
    await fs.appendFile(gate1State.rootBuild.artifacts[0].planPath, Buffer.from("damaged-plan", "utf8"));
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /full correspondence checkpoint is invalid or bound to another Gate 1\/review/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a Gate 2 state write conflict preserves reused Gate 1 previews without a false cleanup error", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-state-conflict-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "state-conflict-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const previewPaths = fixture.gate1.review.flatMap((entry) => entry.previews.map((preview) => preview.path));
    await writeJson(path.join(workflowRoot, "ready-gate-2.json"), { kind: "synthetic-conflict" });
    await assert.rejects(
      () => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }),
      (error) => /content-addressed JSON differs/u.test(error.message) && !/preview cleanup was incomplete/u.test(error.message),
    );
    await Promise.all(previewPaths.map((previewPath) => fs.access(previewPath)));
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 treats transaction and annotation sourceRefs as validated stable sets", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-source-ref-set-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.transactions[1].sourceRefs = ["UNIT-B", "UNIT-A"];
      manifest.batch.summaryAnnotations = [{
        profileId: "xiaohongshu",
        person: "合成人员乙",
        kind: "bonus",
        period: { start: "2035-03-08", end: "2035-03-08" },
        amount: "8.21",
        transactionIds: ["SYN-002"],
        sourceRefs: ["UNIT-B", "UNIT-A"],
      }];
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.annotationObservations = [{
      profileId: "xiaohongshu",
      person: "合成人员乙",
      kind: "bonus",
      period: { start: "2035-03-08", end: "2035-03-08" },
      amount: "8.21",
      sourceRefs: ["UNIT-A", "UNIT-B"],
    }];
    const reviewFile = await writeJson(path.join(temp, "permuted-source-ref-review.json"), review);
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const report = JSON.parse(await fs.readFile(gate2.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.disposition, "PASSED");
    assert.equal(report.mismatches.some((item) => item.code === "manifest-source-refs-mismatch" || item.code === "manifest-summary-annotations-mismatch"), false);
    assert.deepEqual(report.transactionResults.find((item) => item.transactionId === "SYN-002").sourceRefs, ["UNIT-A", "UNIT-B"]);
    assert.deepEqual(report.annotationResults[0].sourceRefs, ["UNIT-A", "UNIT-B"]);
    assert.equal(report.coverage.sourceRefCount, 3);
    assert.equal(report.metrics.uniqueSourceReadCount, 2);
    assert.equal(report.metrics.uniqueMediaDecodeCount, 2);
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

test("Gate 2 pipelines source reads into decode while preserving per-path SHA checks and one decode per SHA", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-source-pipeline-"));
  let workflowRoot;
  try {
    let duplicatePath;
    const fixture = await prepareFixture(temp, { afterFilesCreated: async ({ firstImage }) => {
      duplicatePath = path.join(temp, "synthetic-a-duplicate.jpg");
      await fs.copyFile(firstImage.path, duplicatePath, fs.constants.COPYFILE_EXCL);
    }, mutateManifest: (manifest) => {
      const first = manifest.files.find((file) => file.id === "IMG-A");
      manifest.files.push({ id: "IMG-C", role: "material", path: duplicatePath, sha256: first.sha256, kind: "image", disposition: "used", usage: "context" });
      manifest.sourceScopes.push({ id: "SCOPE-C", fileId: "IMG-C", locator: "full", terminalConfirmed: true, expectedUnitCount: 1 });
      manifest.sourceUnits.push({ id: "UNIT-D", scopeId: "SCOPE-C", locator: "fourth", disposition: "used" });
      manifest.transactions[0].evidence.push("IMG-C");
      manifest.transactions[0].sourceRefs.push("UNIT-D");
      manifest.expected.mediaReferenceCount += 1;
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations.push({
      sourceRef: "UNIT-D",
      fileId: "IMG-C",
      sourceSha256: fixture.firstImage.sha256,
      mediaKind: "image",
      width: fixture.firstImage.width,
      height: fixture.firstImage.height,
      facts: [{ transactionId: "SYN-001", date: "2035-04-12", person: "合成人员甲", project: "合成运营项目", sourceAmount: "19.37" }],
    });
    const reviewFile = await writeJson(path.join(temp, "source-pipeline-review.json"), review);
    let sourceReadIndex = 0;
    let firstReadStillWaiting = false;
    let decodeStartedBeforeAllReadsFinished = false;
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }, {
      testHooks: { fullCorrespondenceHooks: {
        beforeSourceRead: async () => {
          sourceReadIndex += 1;
          if (sourceReadIndex === 1) {
            firstReadStillWaiting = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            firstReadStillWaiting = false;
          }
        },
        beforeSourceDecode: () => { decodeStartedBeforeAllReadsFinished ||= firstReadStillWaiting; },
      } },
    });
    assert.equal(gate2.status, "ready-for-gate-2");
    assert.equal(decodeStartedBeforeAllReadsFinished, true, "a completed path must begin decode before an unrelated slow path finishes reading");
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueSourceReadCount, 3);
    assert.equal(gate2.fullCorrespondenceAudit.metrics.uniqueMediaDecodeCount, 2);
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
    const request = {
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    };
    const blocked = await finalizeReimbursementWorkflow(request, { testHooks: { fullCorrespondenceHooks: { omitTransactionCheckStages: [{ transactionId: "SYN-001", stage: "evidence" }] } } });
    assert.equal(blocked.status, "gate-2-blocked-retryable");
    assert.equal(blocked.fullCorrespondenceAudit.blocking.some((item) => item.code === "required-transaction-stage-incomplete"), true);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate2-full-correspondence.json")), /ENOENT/u);
    const retried = await finalizeReimbursementWorkflow(request);
    assert.equal(retried.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 repairs a wrong bound summary without asking for Gate 1 approval again", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-bound-wrong-"));
  let workflowRoot;
  let correctedWorkflowRoot;
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
    const fixture = await prepareFixture(temp, {
      buildPresentation: tamperedBuilder,
      mutateManifest: (manifest) => {
        manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
        return manifest;
      },
    });
    workflowRoot = fixture.workflowRoot;
    assert.match(fixture.gate1.review[0].summary, /91\.73元/u, "Gate 1 must bind and display the wrong synthetic summary for this regression");
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    const reviewFile = await writeJson(path.join(temp, "correct-independent-review.json"), review);
    const correctionRequired = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    });
    assert.equal(correctionRequired.status, "gate-2-correction-required");
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    assert.equal(correctionRequired.retryWithoutNewGate1, true);
    const report = JSON.parse(await fs.readFile(correctionRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.status, "correction-required");
    assert.equal(report.mismatches.some((item) => item.code === "summary-contract-mismatch"), true);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);

    const corrected = await reviseFromGate2Attempt(fixture, correctionRequired);
    correctedWorkflowRoot = path.dirname(corrected.statePath);
    assert.equal(corrected.status, "ready-for-gate-2-correction-review");
    assert.equal(corrected.approvalText, null);
    const [priorState, correctedState] = await Promise.all([
      fs.readFile(fixture.gate1.statePath, "utf8").then(JSON.parse),
      fs.readFile(corrected.statePath, "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(correctedState.baselines.map(({ profileId, path: filePath, sha256, size }) => ({ profileId, path: filePath, sha256, size })), priorState.baselines.map(({ profileId, path: filePath, sha256, size }) => ({ profileId, path: filePath, sha256, size })));
    assert.equal(correctedState.baselines[0].candidateRevision, priorState.baselines[0].candidateRevision + 1);
    const correctedReview = await writeJson(path.join(temp, "review-after-bound-summary-rebuild.json"), reviewFor(corrected, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({
      statePath: corrected.statePath,
      expectedGate1BindingDigest: corrected.gate1BindingDigest,
      approvalText: null,
      independentEvidenceReviewPath: correctedReview.path,
      independentEvidenceReviewSha256: correctedReview.sha256,
    });
    assert.equal(gate2.status, "ready-for-gate-2");
    const readyState = JSON.parse(await fs.readFile(gate2.statePath, "utf8"));
    assert.equal(readyState.requiresGate1Approval, false);
    assert.equal(readyState.gate2Correction.priorGate1BindingDigest, fixture.gate1.gate1BindingDigest);
    const receipt = await publishReimbursementWorkflow({
      statePath: gate2.statePath,
      expectedGate1BindingDigest: corrected.gate1BindingDigest,
      gate1ApprovalText: null,
      expectedGate2BindingDigest: gate2.gate2BindingDigest,
      gate2ApprovalText: "确认更新根目录支出总表",
    });
    assert.equal(receipt.outputs.length, 1);
    await assert.rejects(fs.access(correctionRequired.fullCorrespondenceAudit.path), /ENOENT/u);
    await assert.rejects(fs.access(workflowRoot), /ENOENT/u);
    await assert.rejects(fs.access(correctedWorkflowRoot), /ENOENT/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    if (correctedWorkflowRoot) await fs.rm(correctedWorkflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

const GATE1_SEMANTIC_CORRECTIONS = [
  { field: "person", wrong: "错误付款主体", correct: "合成主体丙" },
  { field: "project", wrong: "错误项目", correct: "合成对公项目" },
  { field: "date", wrong: "2035-04-14", correct: "2035-04-15" },
  {
    field: "sourceAmount",
    wrong: "5.56",
    correct: "4.56",
    makeWrongExpected: (expected) => ({ ...expected, feeTotal: "33.14", companyPaidNoReimbursementTotal: "5.56" }),
    makeCorrectExpected: (expected) => ({ ...expected, feeTotal: "32.14", companyPaidNoReimbursementTotal: "4.56" }),
  },
];

for (const scenario of GATE1_SEMANTIC_CORRECTIONS) test(`Gate 2 corrects a wrong Gate 1 ${scenario.field} without a second approval`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-gate2-semantic-${scenario.field}-`));
  let oldWorkflowRoot;
  let correctedWorkflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
      manifest.transactions[2][scenario.field] = scenario.wrong;
      if (scenario.makeWrongExpected) manifest.expected = scenario.makeWrongExpected(manifest.expected);
      return manifest;
    } });
    oldWorkflowRoot = fixture.workflowRoot;
    const independentReview = await writeJson(path.join(temp, `independent-${scenario.field}-review.json`), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const reviewRequired = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: independentReview.path,
      independentEvidenceReviewSha256: independentReview.sha256,
    });
    assert.equal(reviewRequired.disposition, "REVIEW_REQUIRED");
    assert.equal(reviewRequired.fullCorrespondenceAudit.reviewFindings.some((item) => item.transactionId === "SYN-003" && item.field === scenario.field), true);

    const correctedManifest = structuredClone(fixture.manifest);
    correctedManifest.batch.reviewRevision += 1;
    correctedManifest.transactions[2][scenario.field] = scenario.correct;
    if (scenario.makeCorrectExpected) correctedManifest.expected = scenario.makeCorrectExpected(correctedManifest.expected);
    const correctedManifestFile = await writeJson(path.join(temp, `corrected-${scenario.field}-manifest.json`), correctedManifest);
    const resolvedReview = resolveGate1ContentError(await fs.readFile(independentReview.path, "utf8").then(JSON.parse), reviewRequired, correctedManifestFile.sha256);
    const resolvedReviewFile = await writeJson(path.join(temp, `resolved-${scenario.field}-review.json`), resolvedReview);
    const correctionRequired = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: resolvedReviewFile.path,
      independentEvidenceReviewSha256: resolvedReviewFile.sha256,
    });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    if (scenario.field === "project") {
      const unauthorizedManifest = structuredClone(correctedManifest);
      unauthorizedManifest.batch.reviewRevision += 1;
      const unauthorizedManifestFile = await writeJson(path.join(temp, "unauthorized-second-revised-manifest.json"), unauthorizedManifest);
      await assert.rejects(
        () => reviseFromGate2Attempt(fixture, correctionRequired, { manifestFile: unauthorizedManifestFile }),
        /revised manifest SHA differs from the Gate 2 finding resolution authorization/u,
      );
    }
    const corrected = await reviseFromGate2Attempt(fixture, correctionRequired, { manifestFile: correctedManifestFile });
    correctedWorkflowRoot = path.dirname(corrected.statePath);
    assert.equal(corrected.status, "ready-for-gate-2-correction-review");
    assert.equal(corrected.approvalText, null);
    const correctedReview = await writeJson(path.join(temp, `corrected-${scenario.field}-review.json`), reviewFor(corrected, fixture.firstImage, fixture.secondImage));
    let attemptBytes;
    if (scenario.field === "person") {
      attemptBytes = await fs.readFile(correctionRequired.fullCorrespondenceAudit.path);
      await fs.appendFile(correctionRequired.fullCorrespondenceAudit.path, Buffer.from("tampered", "utf8"));
      await assert.rejects(() => finalizeReimbursementWorkflow({
        statePath: corrected.statePath,
        expectedGate1BindingDigest: corrected.gate1BindingDigest,
        approvalText: null,
        independentEvidenceReviewPath: correctedReview.path,
        independentEvidenceReviewSha256: correctedReview.sha256,
      }), /Gate 2 correction attempt report changed after binding/u);
      await fs.writeFile(correctionRequired.fullCorrespondenceAudit.path, attemptBytes);
    }
    const gate2 = await finalizeReimbursementWorkflow({
      statePath: corrected.statePath,
      expectedGate1BindingDigest: corrected.gate1BindingDigest,
      approvalText: null,
      independentEvidenceReviewPath: correctedReview.path,
      independentEvidenceReviewSha256: correctedReview.sha256,
    });
    assert.equal(gate2.status, "ready-for-gate-2");
    assert.notEqual(corrected.gate1BindingDigest, fixture.gate1.gate1BindingDigest);
    if (scenario.field === "person") {
      await fs.appendFile(correctionRequired.fullCorrespondenceAudit.path, Buffer.from("tampered-before-publish", "utf8"));
      await assert.rejects(() => publishReimbursementWorkflow({
        statePath: gate2.statePath,
        expectedGate1BindingDigest: corrected.gate1BindingDigest,
        gate1ApprovalText: null,
        expectedGate2BindingDigest: gate2.gate2BindingDigest,
        gate2ApprovalText: "确认更新根目录支出总表",
      }), /publish Gate 2 correction attempt report changed after binding/u);
    }
  } finally {
    if (oldWorkflowRoot) await fs.rm(oldWorkflowRoot, { recursive: true, force: true });
    if (correctedWorkflowRoot) await fs.rm(correctedWorkflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const kind of ["missing", "duplicate"]) test(`Gate 2 corrects a ${kind} transaction from the same source material`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-gate2-${kind}-transaction-`));
  let oldWorkflowRoot;
  let correctedWorkflowRoot;
  try {
    let correctedManifest;
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
      correctedManifest = structuredClone(manifest);
      correctedManifest.batch.reviewRevision += 1;
      if (kind === "missing") {
        manifest.transactions = manifest.transactions.slice(0, 2);
        manifest.sourceUnits[2] = { ...manifest.sourceUnits[2], disposition: "excluded", reason: "synthetic Gate 1 omission" };
        manifest.expected = { transactionCount: 2, feeTotal: "27.58", reimbursementTotal: "27.58", companyPaidNoReimbursementTotal: "0", uniqueMediaCount: 2, mediaReferenceCount: 3 };
      } else {
        manifest.transactions.push({ ...structuredClone(manifest.transactions[2]), id: "SYN-004", sourceOrder: 4 });
        manifest.expected = { ...manifest.expected, transactionCount: 4, feeTotal: "36.70", companyPaidNoReimbursementTotal: "9.12", mediaReferenceCount: 5 };
      }
      return manifest;
    } });
    oldWorkflowRoot = fixture.workflowRoot;
    const independentReview = await writeJson(path.join(temp, `${kind}-transaction-review.json`), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const blocked = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: independentReview.path,
      independentEvidenceReviewSha256: independentReview.sha256,
    });
    assert.equal(blocked.status, "gate-2-review-required");
    assert.equal(blocked.disposition, "REVIEW_REQUIRED");
    assert.equal(blocked.gate1RemainsValid, true);
    const correctedManifestFile = await writeJson(path.join(temp, `corrected-${kind}-transaction-manifest.json`), correctedManifest);
    const resolvedReview = resolveGate1ContentError(await fs.readFile(independentReview.path, "utf8").then(JSON.parse), blocked, correctedManifestFile.sha256);
    const resolvedReviewFile = await writeJson(path.join(temp, `resolved-${kind}-transaction-review.json`), resolvedReview);
    const correctionRequired = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: resolvedReviewFile.path,
      independentEvidenceReviewSha256: resolvedReviewFile.sha256,
    });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const corrected = await reviseFromGate2Attempt(fixture, correctionRequired, { manifestFile: correctedManifestFile });
    correctedWorkflowRoot = path.dirname(corrected.statePath);
    assert.equal(corrected.approvalText, null);
    const correctedReview = await writeJson(path.join(temp, `corrected-${kind}-transaction-review.json`), reviewFor(corrected, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({
      statePath: corrected.statePath,
      expectedGate1BindingDigest: corrected.gate1BindingDigest,
      approvalText: null,
      independentEvidenceReviewPath: correctedReview.path,
      independentEvidenceReviewSha256: correctedReview.sha256,
    });
    assert.equal(gate2.status, "ready-for-gate-2");
  } finally {
    if (oldWorkflowRoot) await fs.rm(oldWorkflowRoot, { recursive: true, force: true });
    if (correctedWorkflowRoot) await fs.rm(correctedWorkflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("review-only findings cannot rebuild unchanged Gate 1 artifacts", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-review-only-revise-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations[2].facts[0].person = "错误 reviewer 主体";
    const reviewFile = await writeJson(path.join(temp, "review-only-mismatch.json"), review);
    const reviewRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    await assert.rejects(() => reviseFromGate2Attempt(fixture, reviewRequired), /only a Gate 2 CORRECTION_REQUIRED report can authorize artifact or manifest rebuilding/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("an evidence-uncertain finding resolution requires a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-evidence-uncertain-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations[2].facts[0].person = "无法确定的付款主体";
    const reviewFile = await writeJson(path.join(temp, "uncertain-first-review.json"), review);
    const reviewRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const uncertainReview = {
      ...structuredClone(review),
      reviewerRunId: crypto.randomBytes(16).toString("hex"),
      findingResolution: {
        kind: "gate2-finding-resolution-v1",
        priorReportDigest: reviewRequired.fullCorrespondenceAudit.reportDigest,
        priorReviewSha256: reviewRequired.independentEvidenceReview.sha256,
        decision: "evidence-uncertain",
        reason: "the original image does not identify the payment subject conclusively",
        revisedManifestSha256: null,
      },
    };
    uncertainReview.observations[2].facts[0].person = "合成主体丙";
    const uncertainFile = await writeJson(path.join(temp, "uncertain-resolution-review.json"), uncertainReview);
    const restart = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: uncertainFile.path, independentEvidenceReviewSha256: uncertainFile.sha256 });
    assert.equal(restart.status, "gate-1-required");
    assert.equal(restart.gate1RemainsValid, false);
    const restartReport = JSON.parse(await fs.readFile(restart.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(restartReport.mismatches.length, 0, "evidence uncertainty must require Gate 1 even when the current observation matches Gate 1");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 correction rejects added or replacement source material", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-source-scope-change-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations[2].facts[0].project = "reviewed corrected project";
    const reviewFile = await writeJson(path.join(temp, "source-scope-review.json"), review);
    const reviewRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const changedManifests = [
      ["added", (manifest) => manifest.files.push({ id: "IMG-C", role: "material", path: fixture.firstImage.path, sha256: fixture.firstImage.sha256, kind: "image", disposition: "excluded", reason: "synthetic new source" })],
      ["replacement-sha", (manifest) => { manifest.files[1].sha256 = "0".repeat(64); }],
    ];
    for (const [name, mutate] of changedManifests) {
      const changed = structuredClone(fixture.manifest);
      changed.batch.reviewRevision += 1;
      mutate(changed);
      const changedFile = await writeJson(path.join(temp, `${name}-source-manifest.json`), changed);
      await assert.rejects(() => reviseFromGate2Attempt(fixture, reviewRequired, { manifestFile: changedFile }), /changed the original file set, path, kind, or SHA; a new Gate 1 is required/u);
    }
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a source SHA change permanently requires a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-source-sha-changed-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "source-sha-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const originalBytes = await fs.readFile(fixture.firstImage.path);
    await fs.writeFile(fixture.firstImage.path, Buffer.concat([originalBytes, Buffer.from("changed-after-gate1", "utf8")]));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    const restart = await finalizeReimbursementWorkflow(request);
    assert.equal(restart.status, "gate-1-required");
    assert.equal(restart.gate1RemainsValid, false);
    assert.equal(restart.retryWithoutNewGate1, false);
    const report = JSON.parse(await fs.readFile(restart.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "fresh-source-sha-changed"), true);
    await fs.writeFile(fixture.firstImage.path, originalBytes);
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /source material changed after Gate 1; a new Gate 1 is required/u);
    await assert.rejects(() => reviseFromGate2Attempt(fixture, restart), /source material changed after Gate 1; a new Gate 1 is required/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a source missing after Gate 1 permanently requires a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-source-missing-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "source-missing-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    await fs.rm(fixture.firstImage.path);
    const restart = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(restart.status, "gate-1-required");
    assert.equal(restart.gate1RemainsValid, false);
    assert.equal(restart.retryWithoutNewGate1, false);
    const report = JSON.parse(await fs.readFile(restart.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "fresh-source-sha-changed" && item.fileId === "IMG-A" && /missing after Gate 1/u.test(item.actual)), true);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a source change overrides a bound Gate 1 content-error resolution", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-resolved-source-change-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.transactions[2].person = "错误付款主体";
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    const reviewFile = await writeJson(path.join(temp, "resolved-source-change-first-review.json"), review);
    const reviewRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(reviewRequired.disposition, "REVIEW_REQUIRED");
    const correctedManifest = structuredClone(fixture.manifest);
    correctedManifest.batch.reviewRevision += 1;
    correctedManifest.transactions[2].person = "合成主体丙";
    const correctedManifestFile = await writeJson(path.join(temp, "resolved-source-change-manifest.json"), correctedManifest);
    const resolvedReviewFile = await writeJson(path.join(temp, "resolved-source-change-review.json"), resolveGate1ContentError(review, reviewRequired, correctedManifestFile.sha256));
    await fs.appendFile(fixture.firstImage.path, Buffer.from("changed-after-resolution", "utf8"));
    const restart = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: resolvedReviewFile.path, independentEvidenceReviewSha256: resolvedReviewFile.sha256 });
    assert.equal(restart.status, "gate-1-required");
    assert.equal(restart.disposition, "GATE1_REQUIRED");
    assert.equal(restart.gate1RemainsValid, false);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a manifest change permanently requires a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-manifest-changed-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "manifest-change-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    const originalBytes = await fs.readFile(fixture.manifestFile.path);
    await fs.appendFile(fixture.manifestFile.path, Buffer.from(" ", "utf8"));
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /manifest changed after Gate 1; a new Gate 1 is required/u);
    await fs.writeFile(fixture.manifestFile.path, originalBytes);
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /manifest changed after Gate 1; a new Gate 1 is required/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a verified manifest snapshot honors an optional size binding", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-manifest-size-"));
  try {
    const manifestFile = await writeJson(path.join(temp, "manifest.json"), { version: 1 });
    const size = (await fs.stat(manifestFile.path)).size;
    await assert.rejects(
      () => readVerifiedGate1ManifestSnapshot({ ...manifestFile, size: size + 1 }),
      (error) => error?.code === GATE1_RESTART_REQUIRED_ERROR_CODE && /manifest size changed after Gate 1/u.test(error.message),
    );
    const snapshot = await readVerifiedGate1ManifestSnapshot({ ...manifestFile, size });
    assert.deepEqual({ path: snapshot.path, sha256: snapshot.sha256, size: snapshot.size }, { path: manifestFile.path, sha256: manifestFile.sha256, size });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a transient manifest read failure preserves Gate 1 for a direct retry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-manifest-retry-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "manifest-retry-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    await assert.rejects(
      () => finalizeReimbursementWorkflow(request, { testHooks: { manifestSnapshotHooks: { afterInitialRead: () => {
        const error = new Error("synthetic manifest lock");
        error.code = "EACCES";
        throw error;
      } } } }),
      /Gate 1 remains valid and may be retried: synthetic manifest lock/u,
    );
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-restart-required.json")), /ENOENT/u);
    const gate2 = await finalizeReimbursementWorkflow(request);
    assert.equal(gate2.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Gate 2 hashes every original path even when two materials share one SHA", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-same-sha-paths-"));
  let workflowRoot;
  try {
    const duplicatePath = path.join(temp, "synthetic-a-duplicate.jpg");
    const fixture = await prepareFixture(temp, {
      afterFilesCreated: async ({ firstImage }) => fs.copyFile(firstImage.path, duplicatePath, fs.constants.COPYFILE_EXCL),
      mutateManifest: (manifest) => {
      const first = manifest.files.find((file) => file.id === "IMG-A");
      manifest.files.push({ id: "IMG-C", role: "material", path: duplicatePath, sha256: first.sha256, kind: "image", disposition: "used", usage: "context" });
      manifest.sourceScopes.push({ id: "SCOPE-C", fileId: "IMG-C", locator: "full", terminalConfirmed: true, expectedUnitCount: 1 });
      manifest.sourceUnits.push({ id: "UNIT-D", scopeId: "SCOPE-C", locator: "fourth", disposition: "used" });
      manifest.transactions[0].evidence.push("IMG-C");
      manifest.transactions[0].sourceRefs.push("UNIT-D");
      manifest.expected.mediaReferenceCount = 5;
      return manifest;
      },
    });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations.push({
      sourceRef: "UNIT-D",
      fileId: "IMG-C",
      sourceSha256: fixture.firstImage.sha256,
      mediaKind: "image",
      width: fixture.firstImage.width,
      height: fixture.firstImage.height,
      facts: [{ transactionId: "SYN-001", date: "2035-04-12", person: "合成人员甲", project: "合成运营项目", sourceAmount: "19.37" }],
    });
    const reviewFile = await writeJson(path.join(temp, "same-sha-path-review.json"), review);
    await fs.appendFile(duplicatePath, Buffer.from("changed-second-path", "utf8"));
    const restart = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(restart.status, "gate-1-required");
    const report = JSON.parse(await fs.readFile(restart.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "fresh-source-sha-changed" && item.fileId === "IMG-C"), true);
    assert.equal(report.metrics.uniqueSourceReadCount, 3, "all three material paths must be hashed even though only two SHA values are unique");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a formal ledger baseline change requires a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-baseline-changed-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "baseline-change-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const originalBytes = await fs.readFile(fixture.baseline.path);
    await fs.appendFile(fixture.baseline.path, Buffer.from("changed-after-gate1", "utf8"));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /formal ledger baseline changed after Gate 1; a new Gate 1 is required/u);
    await fs.writeFile(fixture.baseline.path, originalBytes);
    await assert.rejects(() => finalizeReimbursementWorkflow(request), /formal ledger baseline changed after Gate 1; a new Gate 1 is required/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const changedInput of ["source", "baseline"]) test(`a ${changedInput} change at publish permanently requires a new Gate 1`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-gate2-publish-${changedInput}-changed-`));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, `${changedInput}-publish-review.json`), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const publishRequest = {
      statePath: gate2.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      gate1ApprovalText: "本次报销通过无误",
      expectedGate2BindingDigest: gate2.gate2BindingDigest,
      gate2ApprovalText: "确认更新根目录支出总表",
    };
    const changedPath = changedInput === "source" ? fixture.firstImage.path : fixture.baseline.path;
    const originalBytes = await fs.readFile(changedPath);
    await fs.appendFile(changedPath, Buffer.from(`changed-before-publish-${changedInput}`, "utf8"));
    await assert.rejects(
      () => publishReimbursementWorkflow(publishRequest),
      changedInput === "source" ? /publish source material changed after Gate 2/u : /formal ledger baseline changed after Gate 1/u,
    );
    await fs.writeFile(changedPath, originalBytes);
    await assert.rejects(
      () => publishReimbursementWorkflow(publishRequest),
      changedInput === "source" ? /source material or manifest changed after Gate 2; a new Gate 1 is required/u : /formal ledger baseline changed after Gate 2; a new Gate 1 is required/u,
    );
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const direction of ["corrected-to-original", "original-to-corrected"]) test(`Gate 1 restart markers propagate ${direction} across a correction lineage`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-gate2-lineage-${direction}-`));
  let originalWorkflowRoot;
  let correctedWorkflowRoot;
  try {
    const { fixture, corrected, reviewFile } = await preparePersonCorrectionFixture(temp);
    originalWorkflowRoot = fixture.workflowRoot;
    correctedWorkflowRoot = path.dirname(corrected.statePath);
    const correctedReviewFile = await writeJson(path.join(temp, `${direction}-corrected-review.json`), reviewFor(corrected, fixture.firstImage, fixture.secondImage));
    const originalRequest = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    const correctedRequest = { statePath: corrected.statePath, expectedGate1BindingDigest: corrected.gate1BindingDigest, approvalText: null, independentEvidenceReviewPath: correctedReviewFile.path, independentEvidenceReviewSha256: correctedReviewFile.sha256 };
    if (direction === "corrected-to-original") {
      const originalBytes = await fs.readFile(fixture.firstImage.path);
      await fs.appendFile(fixture.firstImage.path, Buffer.from("lineage-source-change", "utf8"));
      const restart = await finalizeReimbursementWorkflow(correctedRequest);
      assert.equal(restart.disposition, "GATE1_REQUIRED");
      await fs.writeFile(fixture.firstImage.path, originalBytes);
      await assert.rejects(() => finalizeReimbursementWorkflow(originalRequest), /source material changed after Gate 1; a new Gate 1 is required/u);
    } else {
      const originalBytes = await fs.readFile(fixture.baseline.path);
      await fs.appendFile(fixture.baseline.path, Buffer.from("lineage-baseline-change", "utf8"));
      await assert.rejects(() => finalizeReimbursementWorkflow(originalRequest), /formal ledger baseline changed after Gate 1; a new Gate 1 is required/u);
      await fs.writeFile(fixture.baseline.path, originalBytes);
      await assert.rejects(() => finalizeReimbursementWorkflow(correctedRequest), /formal ledger baseline changed after Gate 1; a new Gate 1 is required/u);
    }
  } finally {
    if (originalWorkflowRoot) await fs.rm(originalWorkflowRoot, { recursive: true, force: true });
    if (correctedWorkflowRoot) await fs.rm(correctedWorkflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "empty lineage",
    expected: /restartLineage must contain the prior Gate 1 workflow/u,
    mutate: (correction) => { correction.restartLineage = []; },
  },
  {
    name: "mismatched lineage tail",
    expected: /restartLineage tail does not match priorGate1BindingDigest/u,
    mutate: (correction) => { correction.restartLineage.at(-1).gate1BindingDigest = "0".repeat(64); },
  },
  {
    name: "attempt report outside the lineage tail",
    expected: /attemptReport must belong to the prior Gate 1 workflow root/u,
    mutate: (correction, temp) => { correction.attemptReport.path = path.join(temp, "outside-attempt.json"); },
  },
]) test(`Gate 2 correction rejects ${scenario.name}`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-lineage-binding-"));
  let originalWorkflowRoot;
  let correctedWorkflowRoot;
  try {
    const { fixture, corrected } = await preparePersonCorrectionFixture(temp);
    originalWorkflowRoot = fixture.workflowRoot;
    correctedWorkflowRoot = path.dirname(corrected.statePath);
    await rewriteWorkflowState(corrected.statePath, (state) => {
      scenario.mutate(state.gate2Correction, temp);
      refreshCorrectionAuthorization(state.gate2Correction);
    });
    const reviewFile = await writeJson(path.join(temp, "lineage-binding-review.json"), reviewFor(corrected, fixture.firstImage, fixture.secondImage));
    await assert.rejects(
      () => finalizeReimbursementWorkflow({ statePath: corrected.statePath, expectedGate1BindingDigest: corrected.gate1BindingDigest, approvalText: null, independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 }),
      scenario.expected,
    );
  } finally {
    if (originalWorkflowRoot) await fs.rm(originalWorkflowRoot, { recursive: true, force: true });
    if (correctedWorkflowRoot) await fs.rm(correctedWorkflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("two consecutive Gate 2 corrections keep a flat restart lineage and carry approval", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-lineage-two-hop-"));
  const workflowRoots = new Set();
  try {
    const { fixture, corrected, correctedManifestFile } = await preparePersonCorrectionFixture(temp, { mutateCorrectedManifest: (manifest) => {
      manifest.transactions[2].project = "仍然错误项目";
      return manifest;
    } });
    workflowRoots.add(fixture.workflowRoot);
    workflowRoots.add(path.dirname(corrected.statePath));
    const firstReview = reviewFor(corrected, fixture.firstImage, fixture.secondImage);
    const firstReviewFile = await writeJson(path.join(temp, "two-hop-first-review.json"), firstReview);
    const reviewRequired = await finalizeReimbursementWorkflow({ statePath: corrected.statePath, expectedGate1BindingDigest: corrected.gate1BindingDigest, approvalText: null, independentEvidenceReviewPath: firstReviewFile.path, independentEvidenceReviewSha256: firstReviewFile.sha256 });
    assert.equal(reviewRequired.disposition, "REVIEW_REQUIRED");

    const secondManifest = JSON.parse(await fs.readFile(correctedManifestFile.path, "utf8"));
    secondManifest.batch.reviewRevision += 1;
    secondManifest.transactions[2].project = "合成对公项目";
    const secondManifestFile = await writeJson(path.join(temp, "two-hop-second-manifest.json"), secondManifest);
    const resolvedReviewFile = await writeJson(path.join(temp, "two-hop-resolved-review.json"), resolveGate1ContentError(firstReview, reviewRequired, secondManifestFile.sha256));
    const correctionRequired = await finalizeReimbursementWorkflow({ statePath: corrected.statePath, expectedGate1BindingDigest: corrected.gate1BindingDigest, approvalText: null, independentEvidenceReviewPath: resolvedReviewFile.path, independentEvidenceReviewSha256: resolvedReviewFile.sha256 });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const twiceCorrected = await reviseGate2ReimbursementWorkflow({
      statePath: corrected.statePath,
      expectedGate1BindingDigest: corrected.gate1BindingDigest,
      gate2AttemptReportPath: correctionRequired.fullCorrespondenceAudit.path,
      gate2AttemptReportSha256: correctionRequired.fullCorrespondenceAudit.sha256,
      stagingToken: crypto.randomBytes(32).toString("hex"),
      manifestPath: secondManifestFile.path,
      manifestSha256: secondManifestFile.sha256,
    }, { testHooks: { runPreviewRenderer: fakeRenderer } });
    workflowRoots.add(path.dirname(twiceCorrected.statePath));
    assert.equal(twiceCorrected.approvalText, null);
    const twiceCorrectedState = JSON.parse(await fs.readFile(twiceCorrected.statePath, "utf8"));
    assert.equal(twiceCorrectedState.gate2Correction.restartLineage.length, 2);
    assert.equal(twiceCorrectedState.gate2Correction.restartLineage.at(-1).workflowRoot, path.dirname(corrected.statePath));
    assert.equal(twiceCorrectedState.gate2Correction.restartLineage.at(-1).gate1BindingDigest, corrected.gate1BindingDigest);
    assert.equal(twiceCorrectedState.gate2Correction.restartLineage.every((item) => !Object.hasOwn(item, "restartLineage")), true);

    const finalReviewFile = await writeJson(path.join(temp, "two-hop-final-review.json"), reviewFor(twiceCorrected, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({ statePath: twiceCorrected.statePath, expectedGate1BindingDigest: twiceCorrected.gate1BindingDigest, approvalText: null, independentEvidenceReviewPath: finalReviewFile.path, independentEvidenceReviewSha256: finalReviewFile.sha256 });
    assert.equal(gate2.status, "ready-for-gate-2");
  } finally {
    for (const workflowRoot of workflowRoots) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a failed publish removes its registered rollback backup and reports non-empty cleanup errors", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-publish-backup-cleanup-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "publish-backup-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const gate2 = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    const publishRequest = { statePath: gate2.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, gate1ApprovalText: "本次报销通过无误", expectedGate2BindingDigest: gate2.gate2BindingDigest, gate2ApprovalText: "确认更新根目录支出总表" };
    await assert.rejects(
      () => publishReimbursementWorkflow(publishRequest, { testHooks: { afterBackupCreated: () => { throw new Error("synthetic failure before rollback backup verification"); } } }),
      /synthetic failure before rollback backup verification/u,
    );
    assert.equal((await fs.readdir(workflowRoot)).some((name) => name.startsWith(".rollback-")), false);

    const archiveKeepPath = path.join(fixture.manifest.batch.archivePath, "external-keep.txt");
    await assert.rejects(
      () => publishReimbursementWorkflow(publishRequest, { testHooks: { afterBackupCreated: async () => {
        await fs.writeFile(archiveKeepPath, Buffer.from("external", "utf8"), { flag: "wx" });
        throw new Error("synthetic failure with non-empty archive");
      } } }),
      /synthetic failure with non-empty archive; recovery incomplete: .+\[ENOTEMPTY\]/u,
    );
    assert.equal((await fs.readdir(workflowRoot)).some((name) => name.startsWith(".rollback-")), false);
    await fs.unlink(archiveKeepPath);
    await fs.rmdir(fixture.manifest.batch.archivePath);

    const externalPath = path.join(workflowRoot, "external-keep.txt");
    await fs.writeFile(externalPath, Buffer.from("external", "utf8"), { flag: "wx" });
    const receipt = await publishReimbursementWorkflow(publishRequest);
    assert.equal(receipt.outputs.length, 1);
    assert.equal(receipt.cleanup.failures.some((item) => item.path === workflowRoot && item.error?.code === "ENOTEMPTY"), true);
    await fs.unlink(externalPath);
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

test("Gate 2 keeps Gate 1 valid when an independent reviewer disputes a summary annotation", async () => {
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
    const reviewRequired = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: reviewFile.path,
      independentEvidenceReviewSha256: reviewFile.sha256,
    });
    assert.equal(reviewRequired.status, "gate-2-review-required");
    assert.equal(reviewRequired.gate1RemainsValid, true);
    assert.equal(reviewRequired.retryWithoutNewGate1, true);
    const report = JSON.parse(await fs.readFile(reviewRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.annotationResults[0].status, "failed");
    assert.equal(report.disposition, "REVIEW_REQUIRED");
    assert.equal(report.reviewFindings.some((item) => item.code === "independent-review-summary-annotation-amount-mismatch"), true);
    assert.equal(report.mismatches.some((item) => item.code === "independent-review-summary-annotation-amount-mismatch"), false);
    assert.equal(report.missing.some((item) => item.code === "independent-review-summary-annotation-missing"), false);
    assert.equal(report.extra.some((item) => item.code === "independent-review-summary-annotation-extra"), false);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);

    review.annotationObservations[0].amount = "19.37";
    const correctedReview = await writeJson(path.join(temp, "corrected-annotation-review.json"), review);
    const gate2 = await finalizeReimbursementWorkflow({
      statePath: fixture.gate1.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      approvalText: "本次报销通过无误",
      independentEvidenceReviewPath: correctedReview.path,
      independentEvidenceReviewSha256: correctedReview.sha256,
    });
    assert.equal(gate2.status, "ready-for-gate-2");
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
      const blocked = await finalizeReimbursementWorkflow(request);
      assert.equal(blocked.status, "gate-2-review-required");
      assert.equal(blocked.gate1RemainsValid, true);
      await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
      await assert.rejects(fs.access(path.join(workflowRoot, "gate2-full-correspondence.json")), /ENOENT/u);
      review.observations[0].facts[1].sourceAmount = "8.21";
      const corrected = await writeJson(path.join(temp, "corrected-partial-observations.json"), review);
      const retried = await finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: corrected.path, independentEvidenceReviewSha256: corrected.sha256 });
      assert.equal(retried.status, "ready-for-gate-2");
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

for (const scenario of GATE1_BOUND_TAMPERS) test(`Gate 2 requests an internal correction for Gate 1-bound wrong ${scenario.name}`, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-bound-artifact-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, scenario.options);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "correct-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const correctionRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const report = JSON.parse(await fs.readFile(correctionRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.status, "correction-required");
    assert.equal([...report.mismatches, ...report.missing, ...report.extra, ...report.duplicate, ...report.unbound].some((item) => item.code === scenario.issueCode), true, JSON.stringify(report.mismatches, null, 2));
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
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
    const correctionRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const report = JSON.parse(await fs.readFile(correctionRequired.fullCorrespondenceAudit.path, "utf8"));
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
    const correctionRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const report = JSON.parse(await fs.readFile(correctionRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "artifact-parse-or-validation-failure" && item.artifact === "gate1-deliverables"), true);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a reviewer payment-subject misjudgment stays in Gate 2 and can be corrected without a new Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-invalid-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp, { mutateManifest: (manifest) => {
      manifest.batch.archivePath = path.join(temp, "2035.4.11-2035.4.16_小红书报销（含合成人员乙2035.3.8补报1笔8.21元）");
      return manifest;
    } });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage, (value) => {
      value.observations[2].facts[0].person = "合成报销人丁";
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
    const reviewRequired = await finalizeReimbursementWorkflow(request);
    assert.equal(reviewRequired.status, "gate-2-review-required");
    assert.equal(reviewRequired.disposition, "REVIEW_REQUIRED");
    assert.equal(reviewRequired.gate1RemainsValid, true);
    assert.match(path.basename(reviewRequired.fullCorrespondenceAudit.path), /^gate2-review-[0-9a-f]{64}\.json$/u);
    const report = JSON.parse(await fs.readFile(reviewRequired.fullCorrespondenceAudit.path, "utf8"));
    const finding = report.reviewFindings.find((item) => item.code === "independent-visual-observation-mismatch" && item.transactionId === "SYN-003" && item.field === "person");
    assert.deepEqual({ expected: finding?.expected, actual: finding?.actual }, { expected: "合成主体丙", actual: "合成报销人丁" });
    assert.equal(report.mismatches.some((item) => item.code === "independent-visual-observation-mismatch"), false);
    await assert.rejects(fs.access(path.join(fixture.workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    const repeated = await finalizeReimbursementWorkflow(request);
    assert.deepEqual(repeated.fullCorrespondenceAudit, reviewRequired.fullCorrespondenceAudit, "the same review must reuse the same content-addressed report");
    const secondWrongReview = { ...structuredClone(review), reviewerRunId: crypto.randomBytes(16).toString("hex") };
    const secondWrongFile = await writeJson(path.join(temp, "second-wrong-review.json"), secondWrongReview);
    const secondReviewRequired = await finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: secondWrongFile.path, independentEvidenceReviewSha256: secondWrongFile.sha256 });
    assert.equal(secondReviewRequired.status, "gate-2-review-required");

    review.observations[2].facts[0].person = "合成主体丙";
    const correctedReview = {
      ...structuredClone(review),
      reviewerRunId: crypto.randomBytes(16).toString("hex"),
      findingResolution: {
        kind: "gate2-finding-resolution-v1",
        priorReportDigest: reviewRequired.fullCorrespondenceAudit.reportDigest,
        priorReviewSha256: reviewRequired.independentEvidenceReview.sha256,
        decision: "reviewer-error",
        reason: "the independent reviewer had mistaken the reimbursement claimant for the payment subject",
        revisedManifestSha256: null,
      },
    };
    const corrected = await writeJson(path.join(temp, "corrected-payment-subject-review.json"), correctedReview);
    const gate2 = await finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: corrected.path, independentEvidenceReviewSha256: corrected.sha256 });
    assert.equal(gate2.status, "ready-for-gate-2");
    const passedReport = JSON.parse(await fs.readFile(gate2.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(passedReport.disposition, "PASSED");
    assert.equal(passedReport.findingResolution.decision, "reviewer-error");
    for (const field of ["missing", "extra", "mismatches", "duplicate", "unbound", "reviewFindings", "blocking"]) assert.deepEqual(passedReport[field], []);
    const readyState = JSON.parse(await fs.readFile(gate2.statePath, "utf8"));
    assert.equal(readyState.gate1.bindingDigest, fixture.gate1.gate1BindingDigest);
    assert.equal(readyState.gate2AttemptReports.some((item) => item.reportDigest === report.reportDigest && item.disposition === "REVIEW_REQUIRED"), true);
    const attemptReportNames = readyState.gate2AttemptReports.map((item) => path.basename(item.path));
    assert.deepEqual(attemptReportNames, [...attemptReportNames].sort((left, right) => left.localeCompare(right, "en")));
    const receipt = await publishReimbursementWorkflow({
      statePath: gate2.statePath,
      expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest,
      gate1ApprovalText: "本次报销通过无误",
      expectedGate2BindingDigest: gate2.gate2BindingDigest,
      gate2ApprovalText: "确认更新根目录支出总表",
    });
    assert.equal(receipt.outputs.length, 1);
    await assert.rejects(fs.access(reviewRequired.fullCorrespondenceAudit.path), /ENOENT/u);
    await assert.rejects(fs.access(secondReviewRequired.fullCorrespondenceAudit.path), /ENOENT/u);
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("reviewer media metadata mistakes require only a corrected Gate 2 review", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-reviewer-media-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations[0].mediaKind = "other";
    review.observations[1].width += 1;
    const wrong = await writeJson(path.join(temp, "wrong-media-metadata-review.json"), review);
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: wrong.path, independentEvidenceReviewSha256: wrong.sha256 };
    const reviewRequired = await finalizeReimbursementWorkflow(request);
    const report = JSON.parse(await fs.readFile(reviewRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.disposition, "REVIEW_REQUIRED");
    assert.deepEqual(report.reviewFindings.map((item) => item.code).sort(), ["independent-review-dimensions-mismatch", "independent-review-media-kind-mismatch"]);
    assert.equal(report.mismatches.length, 0);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);

    review.observations[0].mediaKind = "image";
    review.observations[1].width -= 1;
    const corrected = await writeJson(path.join(temp, "corrected-media-metadata-review.json"), review);
    const gate2 = await finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: corrected.path, independentEvidenceReviewSha256: corrected.sha256 });
    assert.equal(gate2.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a transient Gate 2 infrastructure error preserves Gate 1 for retry", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-retryable-system-"));
  let workflowRoot;
  try {
    const duplicatePaths = [];
    const fixture = await prepareFixture(temp, {
      afterFilesCreated: async ({ firstImage }) => {
        for (const suffix of ["c", "d", "e"]) {
          const duplicatePath = path.join(temp, `synthetic-${suffix}.jpg`);
          await fs.copyFile(firstImage.path, duplicatePath, fs.constants.COPYFILE_EXCL);
          duplicatePaths.push(duplicatePath);
        }
      },
      mutateManifest: (manifest) => {
        const first = manifest.files.find((file) => file.id === "IMG-A");
        for (const [index, duplicatePath] of duplicatePaths.entries()) {
          const suffix = String.fromCharCode(67 + index);
          manifest.files.push({ id: `IMG-${suffix}`, role: "material", path: duplicatePath, sha256: first.sha256, kind: "image", disposition: "used", usage: "context" });
          manifest.sourceScopes.push({ id: `SCOPE-${suffix}`, fileId: `IMG-${suffix}`, locator: "full", terminalConfirmed: true, expectedUnitCount: 1 });
          manifest.sourceUnits.push({ id: `UNIT-${String.fromCharCode(68 + index)}`, scopeId: `SCOPE-${suffix}`, locator: `extra-${index + 1}`, disposition: "used" });
          manifest.transactions[0].evidence.push(`IMG-${suffix}`);
          manifest.transactions[0].sourceRefs.push(`UNIT-${String.fromCharCode(68 + index)}`);
        }
        manifest.expected.mediaReferenceCount += duplicatePaths.length;
        return manifest;
      },
    });
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    for (const [index] of duplicatePaths.entries()) review.observations.push({
      ...structuredClone(review.observations[0]),
      sourceRef: `UNIT-${String.fromCharCode(68 + index)}`,
      fileId: `IMG-${String.fromCharCode(67 + index)}`,
    });
    const invalidReview = structuredClone(review);
    delete invalidReview.annotationObservations;
    const invalidReviewFile = await writeJson(path.join(temp, "invalid-review-schema.json"), invalidReview);
    await assert.rejects(() => finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: invalidReviewFile.path, independentEvidenceReviewSha256: invalidReviewFile.sha256 }), /Gate 1 remains valid/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    const reviewFile = await writeJson(path.join(temp, "retryable-review.json"), review);
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    let sourceReadCalls = 0;
    const blocked = await finalizeReimbursementWorkflow(request, {
      testHooks: {
        fullCorrespondenceHooks: {
          beforeSourceRead: (file) => {
            sourceReadCalls += 1;
            if (file.id === "IMG-A") {
              const error = new Error("synthetic source is temporarily locked");
              error.code = "EACCES";
              throw error;
            }
          },
        },
      },
    });
    assert.equal(blocked.status, "gate-2-blocked-retryable");
    assert.equal(blocked.disposition, "BLOCKED_RETRYABLE");
    assert.equal(blocked.gate1RemainsValid, true);
    assert.equal(sourceReadCalls, 5, "one temporary source error must not stop a path beyond the four-worker concurrency window from being checked");
    assert.equal(blocked.fullCorrespondenceAudit.blocking.some((item) => item.code === "fresh-source-read-or-decode-blocked" && /synthetic source is temporarily locked/u.test(item.actual)), true);
    assert.match(path.basename(blocked.fullCorrespondenceAudit.path), /^gate2-review-[0-9a-f]{64}\.json$/u);
    const blockedReport = JSON.parse(await fs.readFile(blocked.fullCorrespondenceAudit.path, "utf8"));
    const { reportDigest: blockedDigest, ...blockedBody } = blockedReport;
    assert.equal(blockedDigest, canonicalDigest(blockedBody));
    assert.equal(blockedReport.metrics.uniqueSourceReadCount, 4);
    const forgedResolution = structuredClone(review);
    forgedResolution.reviewerRunId = crypto.randomBytes(16).toString("hex");
    forgedResolution.observations[2].facts[0].person = "synthetic disputed payment subject";
    forgedResolution.findingResolution = {
      kind: "gate2-finding-resolution-v1",
      priorReportDigest: blocked.fullCorrespondenceAudit.reportDigest,
      priorReviewSha256: blocked.independentEvidenceReview.sha256,
      decision: "gate1-content-error",
      reason: "a pure infrastructure report cannot authorize a semantic correction",
      revisedManifestSha256: fixture.manifestFile.sha256,
    };
    const forgedResolutionFile = await writeJson(path.join(temp, "blocked-report-forged-resolution.json"), forgedResolution);
    await assert.rejects(() => finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: forgedResolutionFile.path, independentEvidenceReviewSha256: forgedResolutionFile.sha256 }), /not bound to a valid prior review attempt/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate2-full-correspondence.json")), /ENOENT/u);
    const retried = await finalizeReimbursementWorkflow(request);
    assert.equal(retried.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("duplicate independent-review observations block Gate 2 without invalidating Gate 1", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-duplicate-review-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const review = reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage);
    review.observations.push(structuredClone(review.observations[0]));
    const duplicateReview = await writeJson(path.join(temp, "duplicate-review.json"), review);
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: duplicateReview.path, independentEvidenceReviewSha256: duplicateReview.sha256 };
    const blocked = await finalizeReimbursementWorkflow(request);
    assert.equal(blocked.status, "gate-2-blocked-retryable");
    assert.equal(blocked.fullCorrespondenceAudit.blocking.some((item) => item.code === "independent-review-source-ref-duplicate"), true);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate1-invalidation.json")), /ENOENT/u);
    await assert.rejects(fs.access(path.join(workflowRoot, "gate2-full-correspondence.json")), /ENOENT/u);
    review.observations.pop();
    const corrected = await writeJson(path.join(temp, "deduplicated-review.json"), review);
    const retried = await finalizeReimbursementWorkflow({ ...request, independentEvidenceReviewPath: corrected.path, independentEvidenceReviewSha256: corrected.sha256 });
    assert.equal(retried.status, "ready-for-gate-2");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("unknown Gate 2 internal artifact exceptions default to retryable blocking", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-gate2-unknown-internal-"));
  let workflowRoot;
  try {
    const fixture = await prepareFixture(temp);
    workflowRoot = fixture.workflowRoot;
    const reviewFile = await writeJson(path.join(temp, "unknown-internal-review.json"), reviewFor(fixture.gate1, fixture.firstImage, fixture.secondImage));
    const request = { statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 };
    let archiveReadFinished = 0;
    const blocked = await finalizeReimbursementWorkflow(request, { testHooks: { fullCorrespondenceHooks: {
      beforeEvidenceArchiveRead: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        archiveReadFinished += 1;
        if (archiveReadFinished === 1) {
          const error = new Error("synthetic evidence archive is temporarily locked");
          error.code = "EACCES";
          throw error;
        }
      },
      beforeArtifactTasksExecute: () => { throw new Error("synthetic unknown artifact exception"); },
    } } });
    assert.equal(blocked.status, "gate-2-blocked-retryable");
    assert.equal(blocked.disposition, "BLOCKED_RETRYABLE");
    assert.equal(blocked.fullCorrespondenceAudit.blocking.some((item) => item.code === "artifact-audit-internal-failure"), true);
    assert.equal(blocked.fullCorrespondenceAudit.blocking.some((item) => item.code === "evidence-archive-read-or-audit-blocked" && /temporarily locked/u.test(item.actual)), true);
    assert.equal(archiveReadFinished, 2, "an early artifact failure must join every already-started evidence archive read before returning");
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
    const correctionRequired = await finalizeReimbursementWorkflow({ statePath: fixture.gate1.statePath, expectedGate1BindingDigest: fixture.gate1.gate1BindingDigest, approvalText: "本次报销通过无误", independentEvidenceReviewPath: reviewFile.path, independentEvidenceReviewSha256: reviewFile.sha256 });
    assert.equal(correctionRequired.disposition, "CORRECTION_REQUIRED");
    const report = JSON.parse(await fs.readFile(correctionRequired.fullCorrespondenceAudit.path, "utf8"));
    assert.equal(report.mismatches.some((item) => item.code === "evidence-archive-bytes-mismatch" && item.evidenceId === "SYN-DUPLICATE-ARCHIVE"), true);
    assert.equal(report.metrics.uniqueArchiveMediaReadCount, 3, "each distinct archive path must be read once");
  } finally {
    if (workflowRoot) await fs.rm(workflowRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});
