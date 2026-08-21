#!/usr/bin/env node

/**
 * Reproducible end-to-end performance acceptance benchmark.
 *
 * This file deliberately does not end in `.test.mjs`, so ordinary test runs do
 * not execute it. It compares the immutable installed 20260819174146 baseline
 * with the current personal-marketplace source using one generated, anonymous
 * workload. Independent evidence observations are prepared outside the timed
 * region; all plugin-controlled reads, decodes, audits and report writes remain
 * inside it.
 *
 * Examples:
 *   node tests/workflow-performance-ab.bench.mjs --old-root=<verified-baseline-skill-root> --renderer=fake
 *   node tests/workflow-performance-ab.bench.mjs --old-root=<verified-baseline-skill-root> --renderer=com
 *   node tests/workflow-performance-ab.bench.mjs --old-root=<verified-baseline-skill-root> --renderer=fake --diagnostic --samples=1
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_NEW_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_SAMPLES = 7;
const DEFAULT_THRESHOLD_PERCENT = 20;
const BENCHMARK_KIND = "xiaohongshu-workflow-performance-ab-v1";
const FIXTURE_KIND = "xiaohongshu-workflow-performance-fixture-v1";
const SAMPLE_KIND = "xiaohongshu-workflow-performance-sample-v1";
// Keep the owned prefix short: Excel COM and Windows PowerShell still encounter
// legacy MAX_PATH behavior for deeply nested preview request names.
const SAFE_TEMP_PREFIX = "codex-xhs-ab-";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function parseArgs(argv) {
  const result = {
    renderer: "fake",
    samples: DEFAULT_SAMPLES,
    threshold: DEFAULT_THRESHOLD_PERCENT,
    diagnostic: false,
    output: null,
    oldRoot: process.env.XHS_BENCH_OLD_ROOT ? path.resolve(process.env.XHS_BENCH_OLD_ROOT) : null,
    newRoot: process.env.XHS_BENCH_NEW_ROOT ? path.resolve(process.env.XHS_BENCH_NEW_ROOT) : DEFAULT_NEW_ROOT,
  };
  for (const argument of argv) {
    if (argument === "--diagnostic") result.diagnostic = true;
    else if (argument.startsWith("--renderer=")) result.renderer = argument.slice("--renderer=".length);
    else if (argument.startsWith("--samples=")) result.samples = Number(argument.slice("--samples=".length));
    else if (argument.startsWith("--threshold=")) result.threshold = Number(argument.slice("--threshold=".length));
    else if (argument.startsWith("--output=")) result.output = path.resolve(argument.slice("--output=".length));
    else if (argument.startsWith("--old-root=")) result.oldRoot = path.resolve(argument.slice("--old-root=".length));
    else if (argument.startsWith("--new-root=")) result.newRoot = path.resolve(argument.slice("--new-root=".length));
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!new Set(["fake", "com"]).has(result.renderer)) throw new Error("--renderer must be fake or com");
  if (!result.oldRoot) throw new Error("verified baseline root is required: pass --old-root=... or set XHS_BENCH_OLD_ROOT");
  if (!Number.isSafeInteger(result.samples) || result.samples < 1) throw new Error("--samples must be a positive integer");
  if (!result.diagnostic && result.samples < DEFAULT_SAMPLES) throw new Error(`acceptance mode requires at least ${DEFAULT_SAMPLES} samples per version and temperature`);
  if (!Number.isFinite(result.threshold) || result.threshold < 0 || result.threshold > 100) throw new Error("--threshold must be between 0 and 100");
  return result;
}

function workerArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(3).find((value) => value.startsWith(prefix));
  if (!found) throw new Error(`worker is missing ${prefix}`);
  return found.slice(prefix.length);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function excelSerial(iso) {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25_569;
}

function isoAfter(start, dayOffset) {
  return new Date(Date.parse(`${start}T00:00:00Z`) + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

function textCell(ref, style, value) {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function numberCell(ref, style, value) {
  return `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`;
}

function formatMoney(cents) {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function parseMoney(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(value);
  if (!match) throw new Error(`benchmark amount is not fixed-point: ${value}`);
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt(fraction || "0"));
}

async function writeExclusive(filePath, bytes) {
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256(bytes), size: bytes.length };
}

async function buildHistoryWorkbook(filePath, newRoot) {
  const primitives = await import(pathToFileURL(path.join(newRoot, "scripts", "workflow_primitives.mjs")).href);
  const JSZipModule = primitives.loadBundledDependency("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = new JSZip();
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>';
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><workbookPr/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><mc:AlternateContent><mc:Choice Requires="x15"><x15:workbookPr chartTrackingRefBase="1"/></mc:Choice><mc:Fallback/></mc:AlternateContent><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Sheet1\'!$A$1:$F$1501</definedName></definedNames><calcPr calcId="191029"/></workbook>');
  zip.file("docProps/custom.xml", '<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="SyntheticProducer"><vt:lpwstr>WPS-compatible anonymous benchmark</vt:lpwstr></property></Properties>');
  zip.file("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  const headers = ["日期", "支出明细", "支出金额", "合计", "支出人", "备注", "匿名辅助键", "匿名辅助值"];
  const rows = [`<row r="1" ht="24" customHeight="1">${headers.map((value, index) => textCell(`${String.fromCharCode(65 + index)}1`, 2, value)).join("")}</row>`];
  for (let row = 2; row <= 1501; row += 1) {
    if (row % 113 === 0) {
      rows.push(`<row r="${row}" ht="22" customHeight="1"/>`);
      continue;
    }
    const date = isoAfter("2030-01-01", row - 2);
    const amount = ((row * 37) % 9000 + 101) / 100;
    const amountText = amount.toFixed(2);
    const formula = row === 2
      ? `<c r="D${row}" s="4" t="n"><f t="shared" si="0" ref="D2:D1501">SUM(C2:C2)</f><v>${amountText}</v></c>`
      : `<c r="D${row}" s="4" t="n"><f t="shared" si="0"/><v>${amountText}</v></c>`;
    const auxiliary = row % 10 === 0 ? textCell(`G${row}`, 2, `AUX-${String(row).padStart(4, "0")}`) + numberCell(`H${row}`, 3, row % 97) : "";
    rows.push(`<row r="${row}" ht="22" customHeight="1">${numberCell(`A${row}`, 1, excelSerial(date))}${textCell(`B${row}`, 2, `匿名历史事项-${String(row).padStart(4, "0")}`)}${numberCell(`C${row}`, 3, amountText)}${formula}${textCell(`E${row}`, 2, `历史人员${row % 17}`)}${textCell(`F${row}`, 2, row % 3 === 0 ? "运营开支" : "日常报销")}${auxiliary}</row>`);
  }
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" mc:Ignorable="x14"><dimension ref="A1:H1501"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="22"/><sheetData>${rows.join("")}</sheetData><extLst><ext uri="{00000000-0000-0000-0000-000000000001}"><x14:syntheticFlag val="1"/></ext></extLst></worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  return writeExclusive(filePath, bytes);
}

async function makeSyntheticImage(filePath, definition, sharp) {
  const { width, height, format, seed } = definition;
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const index = offset / 3;
    const x = index % width;
    const y = Math.floor(index / width);
    pixels[offset] = (x * 5 + y * 3 + seed * 17) % 256;
    pixels[offset + 1] = (x * 2 + y * 7 + seed * 29) % 256;
    pixels[offset + 2] = (x * 11 + y + seed * 41) % 256;
  }
  const pipeline = sharp(pixels, { raw: { width, height, channels: 3 } });
  const bytes = format === "png" ? await pipeline.png({ compressionLevel: 6 }).toBuffer() : await pipeline.jpeg({ quality: 78 }).toBuffer();
  return { ...(await writeExclusive(filePath, bytes)), width, height, format };
}

function fileEntry(id, role, entry, extra = {}) {
  return { id, role, path: entry.path, sha256: entry.sha256, ...extra };
}

async function buildFixture(benchmarkRoot, oldRoot, newRoot) {
  const inputRoot = path.join(benchmarkRoot, "input");
  await fs.mkdir(inputRoot, { recursive: false });
  const primitives = await import(pathToFileURL(path.join(newRoot, "scripts", "workflow_primitives.mjs")).href);
  const SharpModule = primitives.loadBundledDependency("sharp");
  const sharp = SharpModule.default ?? SharpModule;
  const baseline = await buildHistoryWorkbook(path.join(inputRoot, "小红书支出总表.xlsx"), newRoot);
  const imageDefinitions = [
    ["CTX", "context.png", { width: 704, height: 512, format: "png", seed: 3 }, "context"],
    ["V-A", "voucher-a.jpg", { width: 720, height: 540, format: "jpeg", seed: 5 }, "voucher"],
    ["V-B", "voucher-b.jpg", { width: 736, height: 552, format: "jpeg", seed: 7 }, "voucher"],
    ["V-C", "voucher-c.png", { width: 680, height: 520, format: "png", seed: 11 }, "voucher"],
    ["V-D", "voucher-d.jpg", { width: 760, height: 570, format: "jpeg", seed: 13 }, "voucher"],
    ["V-E", "voucher-e.jpg", { width: 696, height: 522, format: "jpeg", seed: 17 }, "voucher"],
    ["V-F", "voucher-f.png", { width: 712, height: 534, format: "png", seed: 19 }, "voucher"],
  ];
  const images = new Map();
  for (const [id, name, definition, usage] of imageDefinitions) images.set(id, { ...(await makeSyntheticImage(path.join(inputRoot, name), definition, sharp)), id, usage });
  const rawTransactions = [
    ["TX-A01", "2034-05-11", "匿名甲", "当期事项一", "运营开支", "112.37", "109.11", "current", "employee_reimbursement", ["V-A"]],
    ["TX-A02", "2034-05-12", "匿名乙", "当期事项二", "广告费", "245.68", "245.68", "current", "employee_reimbursement", ["CTX"]],
    ["TX-A03", "2034-05-12", "匿名丙", "当期事项三", "日常报销", "73.19", "0", "current", "company_paid_no_reimbursement", ["V-B"]],
    ["TX-A04", "2034-05-13", "匿名甲", "当期多图事项", "运营开支", "38.42", "38.42", "current", "employee_reimbursement", ["V-C", "V-D"]],
    ["TX-A05", "2034-05-14", "匿名丁", "上下文复用一", "日常报销", "91.05", "91.05", "current", "employee_reimbursement", ["CTX"]],
    ["TX-A06", "2034-05-15", "匿名戊", "凭证复用一", "运营开支", "64.77", "64.77", "current", "employee_reimbursement", ["V-A"]],
    ["TX-A07", "2033-08-03", "匿名乙", "跨期补录一", "合成项目甲", "129.36", "120", "supplement", "employee_reimbursement", ["V-E"]],
    ["TX-A08", "2033-08-04", "匿名乙", "跨期补录二", "合成项目甲", "57.28", "57.28", "supplement", "employee_reimbursement", ["CTX"]],
    ["TX-A09", "2033-09-09", "匿名丙", "跨期对公项", "日常报销", "18.91", "0", "supplement", "company_paid_no_reimbursement", ["V-F"]],
    ["TX-A10", "2034-05-16", "匿名己", "部分实报事项", "广告费", "204.53", "200.53", "current", "employee_reimbursement", ["V-B"]],
    ["TX-A11", "2034-05-16", "匿名庚", "上下文复用二", "运营开支", "83.66", "83.66", "current", "employee_reimbursement", ["CTX"]],
    ["TX-A12", "2034-05-17", "匿名辛", "凭证复用二", "日常报销", "47.22", "47.22", "current", "employee_reimbursement", ["V-E"]],
  ];
  const scopeUnits = new Map(imageDefinitions.map(([id]) => [id, []]));
  const transactions = rawTransactions.map(([id, date, person, project, classification, sourceAmount, reimbursementAmount, reportingKind, settlement, evidence], index) => {
    const sourceRefs = evidence.map((fileId, evidenceIndex) => {
      const unitId = `SRC-${String(index + 1).padStart(2, "0")}-${evidenceIndex + 1}`;
      scopeUnits.get(fileId).push(unitId);
      return unitId;
    });
    return {
      id,
      sourceOrder: index + 1,
      date,
      person,
      project,
      label: person,
      classification,
      sourceAmount,
      reimbursementAmount,
      reportingKind,
      ...(reportingKind === "supplement" ? { supplementReason: "匿名材料跨期补录" } : {}),
      category: "小红书报销",
      settlement,
      evidence,
      sourceRefs,
    };
  });
  const sourceScopes = imageDefinitions.map(([fileId]) => ({ id: `SCOPE-${fileId}`, fileId, locator: "full-image", terminalConfirmed: true, expectedUnitCount: scopeUnits.get(fileId).length }));
  const sourceUnits = sourceScopes.flatMap((scope) => scopeUnits.get(scope.fileId).map((id, index) => ({ id, scopeId: scope.id, locator: `synthetic-observation-${index + 1}`, disposition: "used" })));
  const feeTotal = transactions.reduce((sum, item) => sum + parseMoney(item.sourceAmount), 0n);
  const reimbursementTotal = transactions.reduce((sum, item) => sum + parseMoney(item.reimbursementAmount), 0n);
  const companyTotal = transactions.filter((item) => item.settlement === "company_paid_no_reimbursement").reduce((sum, item) => sum + parseMoney(item.sourceAmount), 0n);
  const mediaReferenceCount = transactions.reduce((sum, item) => sum + item.evidence.length, 0);
  const manifest = {
    version: 3,
    rulesVersion: "anonymous-performance-acceptance-v1",
    batch: {
      batchId: "anonymous-performance-batch-2034-05",
      rootPath: inputRoot,
      archivePath: path.join(inputRoot, "2034.5.11-2034.5.17_小红书报销_匿名性能夹具"),
      period: "2034.5.11-2034.5.17",
      mainPeriod: { start: "2034-05-11", end: "2034-05-17" },
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      fileEntry("BASELINE", "baseline", baseline),
      ...imageDefinitions.map(([id]) => fileEntry(id, "material", images.get(id), { kind: "image", disposition: "used", usage: images.get(id).usage })),
    ],
    sourceScopes,
    sourceUnits,
    transactions,
    expected: {
      transactionCount: transactions.length,
      feeTotal: formatMoney(feeTotal),
      reimbursementTotal: formatMoney(reimbursementTotal),
      companyPaidNoReimbursementTotal: formatMoney(companyTotal),
      uniqueMediaCount: new Set([...images.values()].map((item) => item.sha256)).size,
      mediaReferenceCount,
    },
  };
  const manifestFile = await writeExclusive(path.join(inputRoot, "anonymous-manifest.json"), jsonBytes(manifest));
  const auditor = path.join(newRoot, "scripts", "audit_batch_manifest.mjs");
  const audit = spawnSync(process.execPath, [auditor, manifestFile.path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (audit.status !== 0) throw new Error(`synthetic manifest audit failed: ${audit.stderr || audit.stdout}`);
  const audited = JSON.parse(audit.stdout.trim());
  const observations = sourceUnits.map((unit) => {
    const scope = sourceScopes.find((item) => item.id === unit.scopeId);
    const image = images.get(scope.fileId);
    const transaction = transactions.find((item) => item.sourceRefs.includes(unit.id));
    return {
      sourceRef: unit.id,
      fileId: scope.fileId,
      sourceSha256: image.sha256,
      mediaKind: "image",
      width: image.width,
      height: image.height,
      facts: [{ transactionId: transaction.id, date: transaction.date, person: transaction.person, project: transaction.project, sourceAmount: transaction.sourceAmount }],
    };
  });
  const fakePng = images.get("CTX");
  const metadata = {
    kind: FIXTURE_KIND,
    inputRoot,
    manifest: manifestFile,
    baseline,
    expected: manifest.expected,
    sourceCoverageDigest: audited.sourceCoverageDigest,
    observations,
    fakePng: { path: fakePng.path, sha256: fakePng.sha256, size: fakePng.size },
    roots: { old: oldRoot, new: newRoot },
  };
  const metadataFile = await writeExclusive(path.join(benchmarkRoot, "fixture.json"), jsonBytes(metadata));
  return { ...metadata, metadataPath: metadataFile.path };
}

async function treeDigest(root) {
  const digest = crypto.createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        digest.update(relative, "utf8");
        digest.update("\0");
        digest.update(await fs.readFile(absolute));
        digest.update("\0");
      } else throw new Error(`benchmark roots may not contain links or special entries: ${absolute}`);
    }
  }
  await visit(root);
  return digest.digest("hex");
}

async function readFixture(metadataPath) {
  const value = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  if (value.kind !== FIXTURE_KIND) throw new Error("worker fixture kind is invalid");
  return value;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function safeRemoveRunRoot(benchmarkRoot, runRoot) {
  if (!within(benchmarkRoot, runRoot) || !path.basename(runRoot).startsWith("run-")) throw new Error(`refusing to remove unbound benchmark run root: ${runRoot}`);
  await fs.rm(runRoot, { recursive: true, force: true });
}

function makeFakeRenderer(pngBytes, pngSha256) {
  return async ({ request, requestFileSha256 }) => {
    const previews = [];
    for (const job of request.jobs) {
      await fs.writeFile(job.outputPath, pngBytes, { flag: "wx" });
      if (request.kind === "ordinary-reimbursement-preview-request-v1") {
        previews.push({ profileId: job.profileId, role: job.role, workbookSha256: job.workbookSha256, outputPath: job.outputPath, sha256: pngSha256, size: pngBytes.length });
      } else if (request.kind === "ordinary-reimbursement-preview-request-v2") {
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
          sha256: pngSha256,
          size: pngBytes.length,
          renderAttempts: 1,
        });
      } else throw new Error(`fake renderer does not support ${request.kind}`);
    }
    return request.kind.endsWith("v1")
      ? { kind: "ordinary-reimbursement-preview-response-v1", requestNonce: request.requestNonce, requestFileSha256, enginePeakWorkingSetBytes: 1, previews }
      : { kind: "ordinary-reimbursement-preview-response-v2", requestNonce: request.requestNonce, requestFileSha256, bindingDigest: request.bindingDigest, enginePeakWorkingSetBytes: 1, previews };
  };
}

async function loadWorkflow(root, cacheTag = "") {
  const entry = pathToFileURL(path.join(root, "scripts", "run_reimbursement_workflow.mjs"));
  if (cacheTag) entry.searchParams.set("benchmark", cacheTag);
  return import(entry.href);
}

function replaceOnce(source, marker, replacement) {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`artifact profiler marker is absent: ${marker.slice(0, 80)}`);
  if (source.indexOf(marker, index + marker.length) >= 0) throw new Error(`artifact profiler marker is ambiguous: ${marker.slice(0, 80)}`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + marker.length)}`;
}

async function loadInstrumentedArtifactBuilder(root, runRoot) {
  const originalPath = path.join(root, "scripts", "build_reimbursement_artifacts.mjs");
  let source = await fs.readFile(originalPath, "utf8");
  source = source.replace(/from "(\.\/[^"\r\n]+)";/gu, (_match, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(originalPath), relative)).href)};`);
  source = replaceOnce(source, "const imageMetadataCache = new Map();", `const imageMetadataCache = new Map();
const __artifactProfile = {
  evidenceTotalMs: 0, evidenceStableReadMs: 0, evidenceStableReadCount: 0,
  evidenceDecodeMs: 0, evidenceDecodeCount: 0, templateLoadMs: 0,
  workbookTotalMs: 0, workbookCount: 0, workbookGenerateMs: 0,
  workbookWriteSyncMs: 0, workbookStableReadMs: 0, workbookReopenMs: 0,
  workbookVerifyMs: 0, boundWriteMs: 0, boundWriteWallMs: 0, boundWriteCount: 0,
  boundWriteByExtension: {},
};
export function __benchmarkArtifactMetrics() { return structuredClone(__artifactProfile); }`);
  source = replaceOnce(source, "async function loadEvidence(manifest) {", `async function loadEvidence(manifest) {
  const __evidenceStarted = performance.now();`);
  source = replaceOnce(source,
    "const loaded = await mapSettledInInputOrder(jobs, 3, async (job) => {\n    const stable = await readStableBinaryFile(job.filePath, { maxBytes: MAX_IMAGE_BYTES });",
    `const loaded = await mapSettledInInputOrder(jobs, 3, async (job) => {
      const __stableReadStarted = performance.now();
      const stable = await readStableBinaryFile(job.filePath, { maxBytes: MAX_IMAGE_BYTES });
      __artifactProfile.evidenceStableReadMs += performance.now() - __stableReadStarted;
      __artifactProfile.evidenceStableReadCount += 1;`);
  source = replaceOnce(source,
    "metadata = await inspectEvidenceImage(bytes, `evidence ${job.evidenceId}`);",
    `const __decodeStarted = performance.now();
        metadata = await inspectEvidenceImage(bytes, \`evidence \${job.evidenceId}\`);
        __artifactProfile.evidenceDecodeMs += performance.now() - __decodeStarted;
        __artifactProfile.evidenceDecodeCount += 1;`);
  source = replaceOnce(source,
    "for (const id of usedIds) if (!evidence.has(id)) fail(`transaction evidence ${id} is not bound to a stable file.`);\n  return evidence;",
    `for (const id of usedIds) if (!evidence.has(id)) fail(\`transaction evidence \${id} is not bound to a stable file.\`);
  __artifactProfile.evidenceTotalMs += performance.now() - __evidenceStarted;
  return evidence;`);
  source = replaceOnce(source, "async function writeWorkbook(filePath, sheetName, projection, beforeValidation = undefined) {", `async function writeWorkbook(filePath, sheetName, projection, beforeValidation = undefined) {
  const __workbookStarted = performance.now();`);
  source = replaceOnce(source,
    'const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });',
    `const __generateStarted = performance.now();
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  __artifactProfile.workbookGenerateMs += performance.now() - __generateStarted;`);
  source = replaceOnce(source,
    "  let created = false;\n  try {\n    const handle = await fs.open(filePath, \"wx\", 0o600);",
    `  let created = false;
  try {
    const __writeStarted = performance.now();
    const handle = await fs.open(filePath, "wx", 0o600);`);
  source = replaceOnce(source,
    "    }\n    if (beforeValidation) {",
    `    }
    __artifactProfile.workbookWriteSyncMs += performance.now() - __writeStarted;
    if (beforeValidation) {`);
  source = replaceOnce(source,
    "    return { sha256: expectedSha256, size: bytes.length, partDigest: canonicalDigest([...expectedParts]), generatedStyleVersion: 1 };",
    `    __artifactProfile.workbookVerifyMs += 0;
    __artifactProfile.workbookTotalMs += performance.now() - __workbookStarted;
    __artifactProfile.workbookCount += 1;
    return { sha256: expectedSha256, size: bytes.length, partDigest: canonicalDigest([...expectedParts]), generatedStyleVersion: 1 };`);
  source = replaceOnce(source, "async function writeBoundBytes(filePath, bytes) {", `async function writeBoundBytes(filePath, bytes) {
  const __boundStarted = performance.now();`);
  source = replaceOnce(source,
    "  // Gate consumers independently reread every bound artifact. The exclusive,\n  // fsynced write already binds these exact bytes without an immediate duplicate read.\n  return { sha256: expectedSha256, size: bytes.length };",
    `  // Gate consumers independently reread every bound artifact. The exclusive,
  // fsynced write already binds these exact bytes without an immediate duplicate read.
  const __boundElapsed = performance.now() - __boundStarted;
  const __boundExtension = path.extname(filePath).toLowerCase() || "<none>";
  __artifactProfile.boundWriteMs += __boundElapsed;
  __artifactProfile.boundWriteCount += 1;
  __artifactProfile.boundWriteByExtension[__boundExtension] = (__artifactProfile.boundWriteByExtension[__boundExtension] ?? 0) + __boundElapsed;
  return { sha256: expectedSha256, size: bytes.length };`);
  source = replaceOnce(source,
    "    loadArtifactTemplates(),\n  ]);",
    `    (async () => {
      const __templateStarted = performance.now();
      try { return await loadArtifactTemplates(); }
      finally { __artifactProfile.templateLoadMs += performance.now() - __templateStarted; }
    })(),
  ]);`);
  source = replaceOnce(source,
    "const boundWrites = await mapSettledInInputOrder(boundWriteJobs, 3, async (job) => {",
    `const __boundGroupStarted = performance.now();
      const boundWrites = await mapSettledInInputOrder(boundWriteJobs, 3, async (job) => {`);
  source = replaceOnce(source,
    "        return { ...job, state };\n      });\n      const summaryState = boundWrites.settled[0].value.state;",
    `        return { ...job, state };
      });
      __artifactProfile.boundWriteWallMs += performance.now() - __boundGroupStarted;
      const summaryState = boundWrites.settled[0].value.state;`);
  const instrumentedPath = path.join(runRoot, "instrumented-artifact-builder.mjs");
  await fs.writeFile(instrumentedPath, source, { flag: "wx" });
  return import(pathToFileURL(instrumentedPath).href);
}

async function runTimedSample({ benchmarkRoot, fixture, version, renderer, round, temperature, workflowModule, includeImport }) {
  const runRoot = path.join(benchmarkRoot, `run-${temperature[0]}-${round}-${version[0]}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(runRoot, { recursive: false });
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = runRoot;
  process.env.TMP = runRoot;
  let module = workflowModule;
  let importMs = 0;
  try {
    if (!module) {
      const started = performance.now();
      module = await loadWorkflow(fixture.roots[version], `${temperature}-${round}-${version}`);
      importMs = performance.now() - started;
    }
    const fakeBytes = renderer === "fake" ? await fs.readFile(fixture.fakePng.path) : null;
    const profilePhases = process.env.XHS_WORKFLOW_PROFILE === "1" && version === "new" ? {} : null;
    const baseRenderer = renderer === "fake" ? makeFakeRenderer(fakeBytes, fixture.fakePng.sha256) : null;
    let hooks = baseRenderer ? { runPreviewRenderer: baseRenderer } : undefined;
    if (profilePhases) {
      const rootBuilderModule = await import(pathToFileURL(path.join(fixture.roots.new, "scripts", "build_root_workbook_candidate.mjs")).href);
      const artifactBuilderModule = await loadInstrumentedArtifactBuilder(fixture.roots.new, runRoot);
      const timeAsync = async (field, operation) => {
        const started = performance.now();
        try { return await operation(); } finally { profilePhases[field] = (profilePhases[field] ?? 0) + performance.now() - started; }
      };
      hooks = {
        ...(hooks ?? {}),
        auditManifest: async (manifestPath, expectedSha256) => timeAsync("manifestAuditMs", async () => {
          const child = spawnSync(process.execPath, [path.join(fixture.roots.new, "scripts", "audit_batch_manifest.mjs"), manifestPath, "--defer-ordinary-file-verification"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
          if (child.status !== 0) throw new Error(`profile manifest audit failed: ${child.stderr || child.stdout}`);
          const audited = JSON.parse(child.stdout.trim());
          if (audited.manifestFileSha256 !== expectedSha256) throw new Error("profile manifest audit SHA differs");
          return audited;
        }),
        buildRootWorkbookCandidates: (request, options) => timeAsync("candidateBuildAuditMs", () => rootBuilderModule.buildRootWorkbookCandidates(request, options)),
        buildReimbursementArtifacts: (request) => timeAsync("artifactTemplateImageMs", async () => {
          const result = await artifactBuilderModule.buildReimbursementArtifacts(request);
          profilePhases.artifactInternal = artifactBuilderModule.__benchmarkArtifactMetrics();
          return result;
        }),
        ...(baseRenderer ? { runPreviewRenderer: (request) => timeAsync("previewRendererCallbackMs", () => baseRenderer(request)) } : {}),
      };
    }
    const stagingToken = crypto.randomBytes(32).toString("hex");
    const prepareRequest = {
      kind: "ordinary-reimbursement-prepare-v1",
      stagingToken,
      manifestPath: fixture.manifest.path,
      manifestSha256: fixture.manifest.sha256,
      baselines: [{ profileId: "xiaohongshu", path: fixture.baseline.path, sha256: fixture.baseline.sha256, size: fixture.baseline.size, candidateRevision: 1 }],
    };
    const prepareStarted = performance.now();
    const gate1 = await module.prepareReimbursementWorkflow(prepareRequest, hooks ? { testHooks: hooks } : undefined);
    const prepareMs = performance.now() - prepareStarted;
    if (profilePhases) {
      profilePhases.parallelBuilderBarrierMs = Math.max(profilePhases.candidateBuildAuditMs ?? 0, profilePhases.artifactTemplateImageMs ?? 0);
      profilePhases.prepareResidualMs = prepareMs - (profilePhases.manifestAuditMs ?? 0) - profilePhases.parallelBuilderBarrierMs - (profilePhases.previewRendererCallbackMs ?? 0);
    }
    const gate1RenderAttempts = gate1.review.flatMap((profile) => profile.previews.map((preview) => ({
      profileId: profile.profileId,
      role: preview.role,
      attempts: preview.renderAttempts ?? null,
    })));

    let reviewSetupMs = 0;
    let finalizeRequest;
    if (version === "new") {
      const reviewStarted = performance.now();
      const review = {
        kind: "independent-evidence-review-v1",
        reviewerRunId: crypto.randomBytes(16).toString("hex"),
        gate1BindingDigest: gate1.gate1BindingDigest,
        sourceCoverageDigest: fixture.sourceCoverageDigest,
        independence: { performedAfterGate1: true, originalSourcesReadFresh: true, gate1ArtifactsNotUsed: true, observationsNotCopied: true },
        annotationObservations: [],
        observations: fixture.observations,
      };
      const reviewPath = path.join(runRoot, "independent-evidence-review.json");
      const reviewBytes = jsonBytes(review);
      await fs.writeFile(reviewPath, reviewBytes, { flag: "wx" });
      reviewSetupMs = performance.now() - reviewStarted;
      finalizeRequest = {
        statePath: gate1.statePath,
        expectedGate1BindingDigest: gate1.gate1BindingDigest,
        approvalText: "本次报销通过无误",
        independentEvidenceReviewPath: reviewPath,
        independentEvidenceReviewSha256: sha256(reviewBytes),
      };
    } else {
      finalizeRequest = { statePath: gate1.statePath, expectedGate1BindingDigest: gate1.gate1BindingDigest, approvalText: "本次报销通过无误" };
    }
    const finalizeStarted = performance.now();
    const gate2 = await module.finalizeReimbursementWorkflow(finalizeRequest);
    const finalizeMs = performance.now() - finalizeStarted;
    if (profilePhases && version === "new") {
      const [gate1StateBytes, reviewBytes] = await Promise.all([
        fs.readFile(gate1.statePath),
        fs.readFile(finalizeRequest.independentEvidenceReviewPath),
      ]);
      const gate1State = JSON.parse(gate1StateBytes.toString("utf8"));
      const reviewValue = JSON.parse(reviewBytes.toString("utf8"));
      const auditor = await import(pathToFileURL(path.join(fixture.roots.new, "scripts", "audit_full_correspondence.mjs")).href);
      const auditStarted = performance.now();
      await auditor.auditFullCorrespondence({
        gate1State,
        independentEvidenceReviewSnapshot: {
          path: finalizeRequest.independentEvidenceReviewPath,
          sha256: finalizeRequest.independentEvidenceReviewSha256,
          size: reviewBytes.length,
          value: reviewValue,
        },
      });
      profilePhases.gate2FullCorrespondenceDirectMs = performance.now() - auditStarted;
    }
    const totalPluginMs = (includeImport ? importMs : 0) + prepareMs + finalizeMs;
    return {
      kind: SAMPLE_KIND,
      version,
      temperature,
      renderer,
      round,
      importMs: includeImport ? importMs : 0,
      prepareMs,
      finalizeMs,
      totalPluginMs,
      excludedIndependentReviewSetupMs: reviewSetupMs,
      gate1RenderAttempts,
      profilePhases,
      gate2Metrics: gate2.fullCorrespondenceAudit?.metrics ?? null,
    };
  } finally {
    process.env.TEMP = priorTemp;
    process.env.TMP = priorTmp;
    await safeRemoveRunRoot(benchmarkRoot, runRoot);
  }
}

function sampleOrder(samples) {
  const result = [];
  for (let round = 0; round < samples; round += 1) {
    const order = round % 2 === 0 ? ["new", "old"] : ["old", "new"];
    for (const version of order) result.push({ round, version });
  }
  return result;
}

async function workerOne() {
  const metadataPath = path.resolve(workerArg("fixture"));
  const benchmarkRoot = path.resolve(workerArg("benchmark-root"));
  const version = workerArg("version");
  const renderer = workerArg("renderer");
  const round = Number(workerArg("round"));
  if (!new Set(["old", "new"]).has(version) || !new Set(["fake", "com"]).has(renderer) || !Number.isSafeInteger(round)) throw new Error("cold worker arguments are invalid");
  const fixture = await readFixture(metadataPath);
  const result = await runTimedSample({ benchmarkRoot, fixture, version, renderer, round, temperature: "cold", workflowModule: null, includeImport: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function workerHot() {
  const metadataPath = path.resolve(workerArg("fixture"));
  const benchmarkRoot = path.resolve(workerArg("benchmark-root"));
  const renderer = workerArg("renderer");
  const samples = Number(workerArg("samples"));
  const fixture = await readFixture(metadataPath);
  const modules = {
    old: await loadWorkflow(fixture.roots.old, "hot-old"),
    new: await loadWorkflow(fixture.roots.new, "hot-new"),
  };
  const results = [];
  for (const { version, round } of sampleOrder(samples)) {
    results.push(await runTimedSample({ benchmarkRoot, fixture, version, renderer, round, temperature: "hot", workflowModule: modules[version], includeImport: false }));
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

function spawnJson(args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`benchmark worker timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) return reject(new Error(`benchmark worker failed (${code ?? signal}): ${stderr || stdout}`));
      if (stderr && process.env.XHS_CANDIDATE_TRACE === "1") process.stderr.write(stderr);
      try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(new Error(`benchmark worker emitted invalid JSON: ${stdout}`, { cause: error })); }
    });
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function medianBreakdown(samples) {
  return Object.fromEntries(["importMs", "prepareMs", "finalizeMs", "totalPluginMs", "excludedIndependentReviewSetupMs"].map((field) => [field, round(median(samples.map((sample) => sample[field])))]));
}

function summarizeTemperature(samples, threshold) {
  const oldSamples = samples.filter((sample) => sample.version === "old");
  const newSamples = samples.filter((sample) => sample.version === "new");
  const oldMedian = median(oldSamples.map((sample) => sample.totalPluginMs));
  const newMedian = median(newSamples.map((sample) => sample.totalPluginMs));
  const improvementPercent = ((oldMedian - newMedian) / oldMedian) * 100;
  return {
    sampleCountPerVersion: oldSamples.length,
    old: medianBreakdown(oldSamples),
    new: medianBreakdown(newSamples),
    improvementPercent: round(improvementPercent),
    requiredImprovementPercent: threshold,
    passed: improvementPercent >= threshold,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const root of [options.oldRoot, options.newRoot]) {
    const stats = await fs.stat(path.join(root, "scripts", "run_reimbursement_workflow.mjs"));
    if (!stats.isFile()) throw new Error(`workflow root is invalid: ${root}`);
  }
  const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), SAFE_TEMP_PREFIX));
  let finalReport;
  try {
    const oldTreeBefore = await treeDigest(options.oldRoot);
    const newTreeBefore = await treeDigest(options.newRoot);
    const fixture = await buildFixture(benchmarkRoot, options.oldRoot, options.newRoot);
    const cold = [];
    for (const { version, round: sampleRound } of sampleOrder(options.samples)) {
      cold.push(await spawnJson([
        "--worker-one",
        `--fixture=${fixture.metadataPath}`,
        `--benchmark-root=${benchmarkRoot}`,
        `--version=${version}`,
        `--renderer=${options.renderer}`,
        `--round=${sampleRound}`,
      ]));
    }
    const hot = await spawnJson([
      "--worker-hot",
      `--fixture=${fixture.metadataPath}`,
      `--benchmark-root=${benchmarkRoot}`,
      `--renderer=${options.renderer}`,
      `--samples=${options.samples}`,
    ], { timeoutMs: 30 * 60_000 });
    const oldTreeAfter = await treeDigest(options.oldRoot);
    const newTreeAfter = await treeDigest(options.newRoot);
    if (oldTreeBefore !== oldTreeAfter) throw new Error("immutable installed baseline changed during benchmark");
    if (newTreeBefore !== newTreeAfter) throw new Error("new workflow source changed during benchmark; discard mixed-version samples and rerun");
    const coldSummary = summarizeTemperature(cold, options.threshold);
    const hotSummary = summarizeTemperature(hot, options.threshold);
    finalReport = {
      kind: BENCHMARK_KIND,
      generatedAt: new Date().toISOString(),
      acceptance: !options.diagnostic,
      renderer: options.renderer,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      protocol: {
        oldRoot: options.oldRoot,
        newRoot: options.newRoot,
        immutableOldTreeSha256: oldTreeAfter,
        measuredNewTreeSha256: newTreeAfter,
        samplesPerVersionPerTemperature: options.samples,
        ordering: "alternating-old-new/new-old-by-round",
        cold: "one fresh Node process per sample; timed dynamic import + prepare/Gate1 + finalize",
        hot: "both versions imported before timing; repeated in one Node process",
        excluded: ["synthetic fixture generation", "independent evidence observation construction and JSON write"],
        included: ["all plugin-controlled manifest/workbook/media reads", "candidate and delivery construction", "preview validation", "Gate 2 fresh media decode", "full correspondence audit/report", "Gate 2 preview binding"],
      },
      fixture: {
        historyRows: 1500,
        transactionCount: fixture.expected.transactionCount,
        uniqueMediaCount: fixture.expected.uniqueMediaCount,
        mediaReferenceCount: fixture.expected.mediaReferenceCount,
        hasCurrentAndSupplement: true,
        hasDifferentSourceAndReimbursementAmounts: true,
        hasCompanyPaidNoReimbursement: true,
        hasContextVoucherMultiImageAndRepeatedReferences: true,
        manifestSha256: fixture.manifest.sha256,
        baselineSha256: fixture.baseline.sha256,
      },
      summaries: { cold: coldSummary, hot: hotSummary },
      thresholdPassed: coldSummary.passed && hotSummary.passed,
      rawSamples: { cold, hot },
    };
    const bytes = Buffer.from(`${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
    if (options.output) {
      await fs.mkdir(path.dirname(options.output), { recursive: true });
      const temporary = `${options.output}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      await fs.rename(temporary, options.output);
    }
    process.stdout.write(bytes);
    if (!options.diagnostic && !finalReport.thresholdPassed) process.exitCode = 2;
  } finally {
    if (!path.basename(benchmarkRoot).startsWith(SAFE_TEMP_PREFIX)) throw new Error(`refusing to clean unsafe benchmark root: ${benchmarkRoot}`);
    await fs.rm(benchmarkRoot, { recursive: true, force: true });
  }
}

try {
  if (process.argv[2] === "--worker-one") await workerOne();
  else if (process.argv[2] === "--worker-hot") await workerHot();
  else await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
