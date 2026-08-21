import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { loadProfileRegistry } from "../scripts/finance_domain.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const candidateBuilderUrl = process.env.XHS_CANDIDATE_BUILDER_UNDER_TEST ? pathToFileURL(path.resolve(process.env.XHS_CANDIDATE_BUILDER_UNDER_TEST)).href : new URL("../scripts/build_root_workbook_candidate.mjs", import.meta.url).href;
const { ROOT_WORKBOOK_AUDIT_REQUEST_KIND, buildRootWorkbookCandidates, computeRootWorkbookAuditRequestDigest, runRootWorkbookAuditWorker } = await import(candidateBuilderUrl);

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function escaped(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function dateSerial(value) { return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000) + 25_569; }
function tCell(ref, style, value) { return `<x:c r="${ref}" s="${style}" t="inlineStr"><x:is><x:t>${escaped(value)}</x:t></x:is></x:c>`; }
function nCell(ref, style, value) { return `<x:c r="${ref}" s="${style}" t="n"><x:v>${value}</x:v></x:c>`; }

function stylesXml({ prefix = "x:", explicitWhite = false } = {}) {
  const fillId = explicitWhite ? 1 : 0;
  return `<?xml version="1.0" encoding="UTF-8"?><${prefix}styleSheet xmlns:${prefix.slice(0, -1)}="${MAIN_NS}"><${prefix}fonts count="1"><${prefix}font/></${prefix}fonts><${prefix}fills count="${explicitWhite ? 2 : 1}"><${prefix}fill/>${explicitWhite ? `<${prefix}fill><${prefix}patternFill patternType="solid"><${prefix}fgColor rgb="FFFFFFFF"/><${prefix}bgColor indexed="64"/></${prefix}patternFill></${prefix}fill>` : ""}</${prefix}fills><${prefix}borders count="1"><${prefix}border/></${prefix}borders><${prefix}cellStyleXfs count="1"><${prefix}xf numFmtId="0"/></${prefix}cellStyleXfs><${prefix}cellXfs count="5"><${prefix}xf numFmtId="0" fillId="0"/><${prefix}xf numFmtId="14" fillId="${fillId}"/><${prefix}xf numFmtId="0" fillId="${fillId}"/><${prefix}xf numFmtId="165" fillId="${fillId}"/><${prefix}xf numFmtId="165" fillId="${fillId}"/></${prefix}cellXfs><${prefix}cellStyles count="1"><${prefix}cellStyle name="Normal" xfId="0"/></${prefix}cellStyles></${prefix}styleSheet>`;
}

async function writeWorkbook(filePath, { rows, merges = [], tail = "", worksheetPrefix = "x:", dimensionEndRow = rows.length, printEndRow = rows.length, styles = stylesXml(), sheetName = "Sheet1" }) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><x:workbook xmlns:x="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><x:sheets><x:sheet name="${escaped(sheetName)}" sheetId="1" r:id="rId1"/></x:sheets><mc:AlternateContent><mc:Choice Requires="x15"><x:ignored/></mc:Choice><mc:Fallback/></mc:AlternateContent><x:definedNames><x:definedName name="_xlnm.Print_Area" localSheetId="0">'${escaped(sheetName)}'!$A$1:$F$${printEndRow}</x:definedName></x:definedNames></x:workbook>`);
  zip.file("xl/styles.xml", styles);
  const normalizedRows = worksheetPrefix ? rows : rows.map((row) => row.replaceAll("x:", "")); const normalizedTail = worksheetPrefix ? tail : tail.replaceAll("x:", "");
  const mergeBlock = merges.length ? `<${worksheetPrefix}mergeCells count="${merges.length}">${merges.map((ref) => `<${worksheetPrefix}mergeCell ref="${ref}"/>`).join("")}</${worksheetPrefix}mergeCells>` : "";
  const namespace = worksheetPrefix ? `xmlns:x="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><${worksheetPrefix}worksheet ${namespace} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><${worksheetPrefix}dimension ref="A1:H${dimensionEndRow}"/><${worksheetPrefix}sheetData>${normalizedRows.join("")}</${worksheetPrefix}sheetData>${mergeBlock}${normalizedTail}</${worksheetPrefix}worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "DOS" });
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
}

function headerRow() {
  return `<x:row r="1" ht="22" customHeight="1">${["日期", "支出明细", "支出金额", "合计", "支出人", "备注"].map((value, index) => tCell(`${String.fromCharCode(65 + index)}1`, 2, value)).join("")}</x:row>`;
}

function dataRow(row, { date = "2032-01-01", project = `历史-${row}`, amount = "1", person = "历史人员", classification = "历史分类", shared = false, formulaText = null, sentinel = `sentinel-${row}` } = {}) {
  const sharedFormula = row === 2 ? `<x:f t="shared" si="0">SUM(C${row}:C${row})</x:f>` : '<x:f t="shared" si="0"/>';
  const formula = formulaText !== null ? `<x:c r="D${row}" s="4" t="n"><x:f>${escaped(formulaText)}</x:f><x:v>${amount}</x:v></x:c>` : shared ? `<x:c r="D${row}" s="4" t="n">${sharedFormula}<x:v>${amount}</x:v></x:c>` : nCell(`D${row}`, 4, amount);
  return `<x:row r="${row}" ht="24" customHeight="1">${nCell(`A${row}`, 1, dateSerial(date))}${tCell(`B${row}`, 2, project)}${nCell(`C${row}`, 3, amount)}${formula}${tCell(`E${row}`, 2, person)}${tCell(`F${row}`, 2, classification)}${tCell(`G${row}`, 2, sentinel)}${nCell(`H${row}`, 3, row)}</x:row>`;
}

async function certificate(transactions) {
  const registry = await loadProfileRegistry();
  const normalized = transactions.map((item, index) => ({
    id: item.id ?? `TX-${String(index + 1).padStart(3, "0")}`, sourceOrder: index + 1, profileId: item.profileId ?? "xiaohongshu", category: registry.profiles[item.profileId ?? "xiaohongshu"].targetCategory,
    date: item.date, person: item.person ?? "人员甲", project: item.project ?? `本批项目-${index + 1}`, classification: item.classification ?? "运营开支",
    sourceAmount: item.amount, reimbursementAmount: item.amount, reportingKind: item.reportingKind ?? "current", settlement: "employee_reimbursement",
    ...(item.reportingKind === "supplement" ? { supplementReason: "匿名材料延后" } : {}),
  }));
  const factsPreimage = { batchId: "anonymous-local-increment", profileConfigDigest: registry.profileConfigDigest, affectedProfileIds: registry.profileOrder.filter((profileId) => normalized.some((item) => item.profileId === profileId)), transactions: normalized };
  const sourceCoveragePreimage = { transactionSourceRefs: normalized.map((item) => ({ transactionId: item.id, sourceRefs: [`UNIT-${item.sourceOrder}`] })) };
  const body = {
    kind: "reimbursement-manifest-facts-v1", operationMode: "reimbursement-batch", manifestFileSha256: canonicalDigest("anonymous-manifest"), manifestDigest: canonicalDigest({ anonymous: true }),
    configDigest: canonicalDigest({ config: "anonymous" }), profileConfigDigest: registry.profileConfigDigest, factsDigest: canonicalDigest(factsPreimage), factsPreimage,
    sourceCoverageDigest: canonicalDigest(sourceCoveragePreimage), sourceCoveragePreimage,
  };
  return { ...body, certificateDigest: canonicalDigest(body) };
}

async function buildWith(builder, baseline, transactions, options) {
  return builder({
    kind: "root-workbook-build-request-v1", stagingToken: crypto.randomBytes(32).toString("hex"), reimbursementFactsCertificate: await certificate(transactions),
    artifacts: [{ profileId: "xiaohongshu", baselinePath: baseline.path, baselineSha256: baseline.sha256, baselineSize: baseline.size, candidateRevision: 1 }],
  }, options);
}

async function build(baseline, transactions, options) { return buildWith(buildRootWorkbookCandidates, baseline, transactions, options); }

function zipCentralFacts(zip) {
  const entries = [];
  for (const name of Object.keys(zip.files).filter((entryName) => !zip.files[entryName].dir).sort()) {
    const data = zip.files[name]._data;
    const magic = data?.compression?.magic;
    const compressionMethod = typeof magic === "string" ? Buffer.from(magic, "binary").toString("hex") : Buffer.isBuffer(magic) ? magic.toString("hex") : null;
    entries.push({ name, crc32: (data.crc32 >>> 0).toString(16).padStart(8, "0"), size: data.uncompressedSize, compressedSize: data.compressedSize, compressionMethod });
  }
  return { partCount: entries.length, factsDigest: canonicalDigest(entries), inventoryDigest: canonicalDigest(entries.map((entry) => entry.name)) };
}

async function maliciousAuditRequest({ artifact, baseline, transactions, candidatePath, candidateBytes, worksheetXml }) {
  const zip = await JSZip.loadAsync(candidateBytes); const central = zipCentralFacts(zip);
  const localPatchCertificate = structuredClone(artifact.localPatchCertificate);
  localPatchCertificate.candidate = { sourceSha256: sha256Bytes(candidateBytes), sourceSize: candidateBytes.length };
  localPatchCertificate.managedParts.worksheet.afterSha256 = sha256Bytes(Buffer.from(worksheetXml, "utf8"));
  localPatchCertificate.managedParts.worksheet.afterSize = Buffer.byteLength(worksheetXml, "utf8");
  localPatchCertificate.package.candidateFactsDigest = central.factsDigest;
  localPatchCertificate.package.candidatePartCount = central.partCount;
  localPatchCertificate.package.candidateInventoryDigest = central.inventoryDigest;
  delete localPatchCertificate.certificateDigest;
  localPatchCertificate.certificateDigest = canonicalDigest(localPatchCertificate);
  const requestNonce = crypto.randomBytes(32).toString("hex");
  const request = {
    kind: ROOT_WORKBOOK_AUDIT_REQUEST_KIND,
    requestNonce,
    reimbursementFactsCertificate: await certificate(transactions),
    profiles: [{
      profileId: "xiaohongshu", baselinePath: baseline.path, baselineSha256: baseline.sha256,
      candidatePath, candidateSha256: sha256Bytes(candidateBytes), localPatchCertificate,
    }],
  };
  request.requestDigest = computeRootWorkbookAuditRequestDigest(request);
  return { request, requestNonce, requestFileSha256: sha256Bytes(jsonBytes(request)) };
}

test("1500-row current append preserves every historical row byte and projects preview from candidate batch rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-current-")); let stagingRoot;
  try {
    const rows = [headerRow()]; for (let row = 2; row <= 1501; row += 1) rows.push(dataRow(row, { shared: true }));
    rows.push('<x:row/>', '<x:row r="5000" spans="7:8" ht="24" customHeight="1"><x:c s="2" t="inlineStr"><x:is><x:t>remote-aux-only</x:t></x:is></x:c><x:c s="3" t="n"><x:v>5000</x:v></x:c></x:row>');
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows, dimensionEndRow: 5000, printEndRow: 1501, tail: '<x:conditionalFormatting sqref="G1501:H1501"><x:cfRule type="expression" priority="1"><x:formula>H1501&gt;0</x:formula></x:cfRule></x:conditionalFormatting>' });
    const result = await build(baseline, [
      { id: "TX-A", date: "2032-08-01", amount: "10.125", project: "匿名当期甲" },
      { id: "TX-B", date: "2032-08-01", amount: "20.25", project: "匿名当期乙" },
    ]);
    stagingRoot = result.stagingRoot; const artifact = result.artifacts[0]; const locality = artifact.audit.projection.locality;
    assert.equal(locality.indexMode, "append-tail-only");
    assert.equal(locality.historicalBusinessValueReadCount, 0);
    assert.equal(locality.rewrittenHistoricalRowCount, 0);
    assert.equal(locality.preservedHistoricalRowCount, 1503);
    assert.ok(locality.styleRowsInspected <= 32, `style scan escaped its local window: ${locality.styleRowsInspected}`);
    assert.equal(artifact.audit.auditOperations.patchWorksheetCallCount, 0, "independent audit must not rebuild the historical worksheet");
    assert.equal(artifact.audit.auditOperations.historicalBusinessValueReadCount, 0);
    assert.equal(artifact.audit.auditOperations.zipEntryPayloadInflateCount, 7, "audit inflates only workbook/rels/managed sheet plus baseline styles");
    assert.equal(artifact.audit.localPatchCertificateDigest, artifact.localPatchCertificate.certificateDigest);
    assert.equal(artifact.localPatchCertificate.projection.batchRowCount, 2);
    assert.match(artifact.localPatchCertificate.managedParts.worksheet.beforeSha256, /^[0-9a-f]{64}$/u);
    assert.match(artifact.localPatchCertificate.managedParts.worksheet.afterSha256, /^[0-9a-f]{64}$/u);
    const zip = await JSZip.loadAsync(await fs.readFile(artifact.candidatePath)); const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    assert.ok(sheet.includes(rows.slice(0, 1501).join("")), "ordinary append must preserve every historical A:F row byte-for-byte");
    assert.ok(sheet.includes(rows.slice(1501).join("")), "ordinary append must preserve trailing empty and G/H-only rows byte-for-byte");
    assert.match(sheet, /<x:row r="1502"[^>]*>.*匿名当期甲/su);
    assert.match(sheet, /<x:row r="1503"[^>]*>.*匿名当期乙/su);
    assert.match(sheet, /<x:row r="1503"[^>]*>.*匿名当期乙[\s\S]*<x:row\/>[\s\S]*<x:row r="5000" spans="7:8"/u);
    assert.match(sheet, /remote-aux-only/u);
    assert.match(sheet, /<x:f t="shared" si="0"\/><x:v>1<\/x:v>/u);
    assert.match(sheet, /sentinel-1501/u);
    const previewZip = await JSZip.loadAsync(await fs.readFile(artifact.previewPath)); const previewSheet = await previewZip.file("xl/worksheets/sheet1.xml").async("string");
    assert.match(previewSheet, /dimension ref="A1:F3"/u);
    assert.match(previewSheet, /匿名当期甲/u);
    assert.doesNotMatch(previewSheet, /sentinel-|历史-/u);
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supplement insertion indexes only A dates and D:F boundaries while shifting the affected suffix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-supplement-")); let stagingRoot;
  try {
    const rows = [headerRow(),
      dataRow(2, { date: "2032-01-10", project: "不应解析的历史文本甲", amount: "1", sentinel: "prefix-stays" }),
      dataRow(3, { date: "2032-01-20", project: "#VALUE! 与任意文本", amount: "2", shared: true, sentinel: "suffix-shifts" }),
      dataRow(4, { date: "2032-02-10", project: "历史文本乙", amount: "3" }),
      dataRow(5, { date: "2032-02-10", project: "历史文本丙", amount: "4" }),
      dataRow(6, { date: "2032-03-10", project: "历史文本丁", amount: "5" }),
    ];
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows, merges: ["D4:D5", "E4:E5", "F4:F5"], tail: '<x:dataValidations count="1"><x:dataValidation type="whole" sqref="H3:H6"><x:formula1>$H$3</x:formula1></x:dataValidation></x:dataValidations><x:hyperlinks><x:hyperlink ref="B3" location="\'Sheet1\'!B3"/><x:hyperlink ref="B4" location="\'Other Sheet\'!B4"/></x:hyperlinks>' });
    const result = await build(baseline, [{ id: "TX-S", date: "2032-01-15", amount: "7.5", project: "匿名补报", reportingKind: "supplement" }]);
    stagingRoot = result.stagingRoot; const artifact = result.artifacts[0]; const locality = artifact.audit.projection.locality;
    assert.equal(locality.indexMode, "a-date-and-df-merge");
    assert.equal(locality.historicalBusinessValueReadCount, 0);
    assert.equal(locality.rewrittenHistoricalRowCount, 4);
    const zip = await JSZip.loadAsync(await fs.readFile(artifact.candidatePath)); const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    assert.match(sheet, /<x:row r="2"[^>]*>.*prefix-stays/su);
    assert.match(sheet, /<x:row r="3"[^>]*>.*匿名补报/su);
    assert.match(sheet, /<x:row r="4"[^>]*>.*suffix-shifts/su);
    assert.match(sheet, /<x:mergeCell ref="D5:D6"\/>/u);
    assert.match(sheet, /<x:dataValidation type="whole" sqref="H4:H7"><x:formula1>\$H\$4<\/x:formula1>/u);
    assert.match(sheet, /<x:hyperlink ref="B4" location="'Sheet1'!B4"\/>/u, "managed-sheet hyperlink ref and location must shift together");
    assert.match(sheet, /<x:hyperlink ref="B5" location="'Other Sheet'!B4"\/>/u, "other-sheet hyperlink location must stay qualified and unchanged");
    assert.equal(artifact.audit.projection.batchRanges[0].rangeAddress, "A3:F3");
    assert.match(artifact.audit.unchangedPartsDigest, /^[0-9a-f]{64}$/u);
    assert.equal(artifact.audit.auditOperations.patchWorksheetCallCount, 0);
    assert.equal(artifact.audit.auditOperations.coordinateRowsCompared, 4, "supplement audit compares only the shifted historical suffix");
    assert.equal(artifact.localPatchCertificate.transform.coordinateTransform.preservedPrefixRowCount, 2);
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("formula shifting is token-aware for current-sheet refs, strings, and qualified-sheet ranges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-formulas-")); let stagingRoot;
  try {
    const rows = [headerRow(),
      dataRow(2, { date: "2032-01-10" }),
      dataRow(3, { date: "2032-01-20", formulaText: "LOG10(C3)+SUM(C3:C5)+$A$3+A$3+$A3" }),
      dataRow(4, { date: "2032-01-21", formulaText: 'IF(B4="A5","OtherSheet!A5",C4)' }),
      dataRow(5, { date: "2032-01-22", formulaText: "OtherSheet!A5+'Other Sheet'!A5:B6+C5" }),
    ];
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows });
    const result = await build(baseline, [{ id: "TX-F", date: "2032-01-15", amount: "7.5", project: "匿名公式补报", reportingKind: "supplement" }]);
    stagingRoot = result.stagingRoot;
    const zip = await JSZip.loadAsync(await fs.readFile(result.artifacts[0].candidatePath)); const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
    assert.match(sheet, /<x:f>LOG10\(C4\)\+SUM\(C4:C6\)\+\$A\$4\+A\$4\+\$A4<\/x:f>/u, "unqualified current-sheet A1 refs must shift once without rewriting function names");
    assert.match(sheet, /<x:f>IF\(B5=&quot;A5&quot;,&quot;OtherSheet!A5&quot;,C5\)<\/x:f>/u, "quoted A1-looking text must stay literal");
    assert.match(sheet, /<x:f>OtherSheet!A5\+'Other Sheet'!A5:B6\+C6<\/x:f>/u, "qualified other-sheet range must not shift");
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supplement blocks structured and external formula references explicitly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-unsafe-formulas-"));
  try {
    for (const [index, formulaText] of ["SUM(Table1[Amount])+C3", "SUM([Book.xlsx]Sheet1!A5)+C3"].entries()) {
      const baseline = await writeWorkbook(path.join(root, `小红书支出总表-${index}.xlsx`), { rows: [headerRow(), dataRow(2, { date: "2032-01-10" }), dataRow(3, { date: "2032-01-20", formulaText })] });
      const canonicalBaseline = path.join(root, "小红书支出总表.xlsx");
      await fs.copyFile(baseline.path, canonicalBaseline);
      const bytes = await fs.readFile(canonicalBaseline); const canonical = { path: canonicalBaseline, sha256: sha256Bytes(bytes), size: bytes.length };
      await assert.rejects(() => build(canonical, [{ id: `TX-U-${index}`, date: "2032-01-15", amount: "1", reportingKind: "supplement" }]), /unsupported structured or external reference/u);
      await fs.unlink(canonicalBaseline);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hyphenated styles namespace and explicit solid-white fills remain eligible within the local window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-white-fill-")); let stagingRoot;
  try {
    const rows = [headerRow(), dataRow(2, { date: "2032-01-10" })];
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows, styles: stylesXml({ prefix: "style-1:", explicitWhite: true }) });
    const result = await build(baseline, [{ id: "TX-W", date: "2032-02-01", amount: "2", project: "匿名白底" }]); stagingRoot = result.stagingRoot;
    assert.equal(result.artifacts[0].audit.projection.locality.styleRowsInspected, 1);
    assert.equal(result.artifacts[0].localPatchCertificate.transform.insertions[0].styleSource.row, 2);
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit worker independently rereads the bound candidate from disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-reread-")); let stagingRoot;
  try {
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows: [headerRow(), dataRow(2)] });
    await assert.rejects(() => build(baseline, [{ id: "TX-R", date: "2032-02-01", amount: "2" }], { testHooks: { afterWorkerRequestWritten: async ({ requestBody }) => {
      const candidatePath = requestBody.profiles[0].candidatePath; stagingRoot = path.dirname(candidatePath); await fs.appendFile(candidatePath, Buffer.from([0]));
    } } }), /audit source SHA\/size changed|cleanup incomplete/u);
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a multi-profile post-write failure cleans every candidate and the same token can retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-multi-cleanup-"));
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-reimburse-${stagingToken}`);
  let retry;
  try {
    const xiaohongshu = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows: [headerRow(), dataRow(2)] });
    const company = await writeWorkbook(path.join(root, "公司支出总表.xlsx"), { rows: [headerRow(), dataRow(2)], sheetName: "公司支出" });
    const transactions = [
      { id: "TX-M-X", profileId: "xiaohongshu", date: "2032-02-01", amount: "2", project: "匿名小红书项目" },
      { id: "TX-M-C", profileId: "company", date: "2032-02-02", amount: "3", project: "匿名公司项目" },
    ];
    const request = {
      kind: "root-workbook-build-request-v1",
      stagingToken,
      reimbursementFactsCertificate: await certificate(transactions),
      artifacts: [
        { profileId: "xiaohongshu", baselinePath: xiaohongshu.path, baselineSha256: xiaohongshu.sha256, baselineSize: xiaohongshu.size, candidateRevision: 1 },
        { profileId: "company", baselinePath: company.path, baselineSha256: company.sha256, baselineSize: company.size, candidateRevision: 1 },
      ],
    };
    await assert.rejects(
      buildRootWorkbookCandidates(request, { testHooks: { afterCandidateWritten: async ({ profileId }) => { if (profileId === "company") throw new Error("synthetic company post-write failure"); } } }),
      /synthetic company post-write failure/u,
    );
    await assert.rejects(fs.access(stagingRoot), /ENOENT/u);
    retry = await buildRootWorkbookCandidates(request);
    assert.deepEqual(retry.artifacts.map((item) => item.profileId), ["xiaohongshu", "company"]);
  } finally {
    if (retry?.stagingRoot) await fs.rm(retry.stagingRoot, { recursive: true, force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supplement audit rejects missing shifts, wrong shifts, and changed cross-sheet formula references", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-tamper-")); let stagingRoot;
  const transactions = [{ id: "TX-T", date: "2032-01-15", amount: "7.5", project: "匿名审计补报", reportingKind: "supplement" }];
  try {
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows: [
      headerRow(),
      dataRow(2, { date: "2032-01-10", project: "边界前缀" }),
      dataRow(3, { date: "2032-01-20", project: "坐标目标", formulaText: "OtherSheet!A5+C3" }),
      dataRow(4, { date: "2032-01-21", project: "后缀目标", formulaText: "SUM(C4:C4)" }),
    ] });
    const clean = await build(baseline, transactions); stagingRoot = clean.stagingRoot; const artifact = clean.artifacts[0];
    const cleanZip = await JSZip.loadAsync(await fs.readFile(artifact.candidatePath));
    const cleanSheet = await cleanZip.file("xl/worksheets/sheet1.xml").async("string");
    const scenarios = [
      ["missing row shift", (xml) => xml.replace(/(<x:row r=")4("[^>]*>[\s\S]*?坐标目标)/u, "$13$2")],
      ["wrong cell shift", (xml) => xml.replace('<x:c r="C4"', '<x:c r="C5"')],
      ["changed cross-sheet reference", (xml) => xml.replace("OtherSheet!A5+C4", "OtherSheet!A6+C4")],
    ];
    for (const [label, mutate] of scenarios) await context.test(label, async () => {
      const worksheetXml = mutate(cleanSheet);
      assert.notEqual(worksheetXml, cleanSheet, `${label} fixture did not mutate the candidate`);
      const zip = await JSZip.loadAsync(await fs.readFile(artifact.candidatePath));
      zip.file("xl/worksheets/sheet1.xml", worksheetXml);
      const candidateBytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 1 }, platform: "DOS" });
      const candidatePath = path.join(root, `${label.replaceAll(" ", "-")}.xlsx`);
      await fs.writeFile(candidatePath, candidateBytes, { flag: "wx" });
      const binding = await maliciousAuditRequest({ artifact, baseline, transactions, candidatePath, candidateBytes, worksheetXml });
      await assert.rejects(() => runRootWorkbookAuditWorker({ requestBody: binding.request, requestFileSha256: binding.requestFileSha256, requestNonce: binding.requestNonce }), /audit worker failed|coordinate|formula/u);
    });
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("candidate current append benchmark", { skip: process.env.XHS_CANDIDATE_BENCHMARK !== "1" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-candidate-benchmark-")); const stagingRoots = [];
  try {
    const installedBuilderPath = path.resolve(process.env.XHS_INSTALLED_CANDIDATE_BUILDER ?? path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "xiaohongshu-reimbursement-workflow", "0.5.0+codex.20260819174146", "skills", "xiaohongshu-reimbursement-workflow", "scripts", "build_root_workbook_candidate.mjs"));
    const { buildRootWorkbookCandidates: installedBuilder } = await import(pathToFileURL(installedBuilderPath).href);
    const rows = [headerRow()]; for (let row = 2; row <= 1501; row += 1) rows.push(dataRow(row, { shared: true }));
    const baseline = await writeWorkbook(path.join(root, "小红书支出总表.xlsx"), { rows, worksheetPrefix: "", tail: '<conditionalFormatting sqref="G1501:H1501"><cfRule type="expression" priority="1"><formula>H1501&gt;0</formula></cfRule></conditionalFormatting>' });
    const currentSamples = []; const installedSamples = []; const operationCounts = [];
    for (let round = 0; round < 6; round += 1) {
      const transactions = [
        { id: `TX-BENCH-A-${round}`, date: "2032-08-01", amount: "10.125", project: "匿名基准甲" },
        { id: `TX-BENCH-B-${round}`, date: "2032-08-01", amount: "20.25", project: "匿名基准乙" },
      ];
      const variants = round % 2 === 0 ? [["installed", installedBuilder], ["current", buildRootWorkbookCandidates]] : [["current", buildRootWorkbookCandidates], ["installed", installedBuilder]];
      for (const [label, builder] of variants) {
        const started = performance.now(); const result = await buildWith(builder, baseline, transactions); const elapsed = performance.now() - started; stagingRoots.push(result.stagingRoot);
        if (label === "current") { currentSamples.push(elapsed); operationCounts.push(result.artifacts[0].audit.auditOperations); } else installedSamples.push(elapsed);
      }
    }
    const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const currentMedian = median(currentSamples.slice(1)); const installedMedian = median(installedSamples.slice(1)); const ratio = currentMedian / installedMedian;
    process.stdout.write(`CANDIDATE_APPEND_AB=${JSON.stringify({ baselineVersion: "0.5.0+codex.20260819174146", installedMs: installedSamples.map((value) => Number(value.toFixed(3))), currentMs: currentSamples.map((value) => Number(value.toFixed(3))), installedHotMedianMs: Number(installedMedian.toFixed(3)), currentHotMedianMs: Number(currentMedian.toFixed(3)), improvementPct: Number(((1 - ratio) * 100).toFixed(2)), currentAuditOperations: operationCounts.at(-1) })}\n`);
    assert.ok(Number.isFinite(currentMedian) && Number.isFinite(installedMedian) && currentMedian > 0 && installedMedian > 0);
    assert.ok(ratio <= 0.8, `current candidate append median ${currentMedian.toFixed(3)}ms must be at least 20% faster than installed ${installedMedian.toFixed(3)}ms`);
  } finally {
    await Promise.all(stagingRoots.map((stagingRoot) => fs.rm(stagingRoot, { recursive: true, force: true })));
    await fs.rm(root, { recursive: true, force: true });
  }
});
