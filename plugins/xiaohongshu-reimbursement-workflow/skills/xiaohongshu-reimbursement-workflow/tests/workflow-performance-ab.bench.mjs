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
 *   node tests/workflow-performance-ab.bench.mjs --line=H --old-root=<19174146-skill-root> --new-root=<unmodified-21073607-skill-root> --renderer=fake
 *   node tests/workflow-performance-ab.bench.mjs --line=O --identity-only --old-root=<unmodified-21073607-skill-root> --new-root=<candidate-skill-root>
 *   node tests/workflow-performance-ab.bench.mjs --line=H --old-root=<19174146-skill-root> --new-root=<unmodified-21073607-skill-root> --renderer=fake --diagnostic --samples=1 --warmups=0
 *
 * O acceptance additionally requires the six identity values printed by
 * --identity-only. Acceptance never permits fewer than 11 timed pairs or two
 * warm-ups. The configured improvement percentage is reported as an
 * informational target; p95 non-regression, RSS and output safeguards decide
 * acceptance.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateStrictPerformanceAcceptance,
  improvementPercent,
  pairedBootstrapImprovement,
  summarizeDistribution,
} from "../scripts/performance_statistics.mjs";
import { loadBundledDependency } from "../scripts/workflow_primitives.mjs";
import {
  assertStableFileSnapshotCurrent,
  openWorkbookSnapshot,
  readStableFileSnapshot,
} from "../scripts/workbook_snapshot.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const STATISTICS_PATH = path.resolve(path.dirname(SCRIPT_PATH), "..", "scripts", "performance_statistics.mjs");
const DEFAULT_NEW_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_SAMPLES = 11;
const DEFAULT_WARMUPS = 2;
const DEFAULT_THRESHOLD_PERCENT = 20;
const BENCHMARK_KIND = "xiaohongshu-workflow-performance-ab-v2";
const FIXTURE_KIND = "xiaohongshu-workflow-performance-fixture-v1";
const SAMPLE_KIND = "xiaohongshu-workflow-performance-sample-v2";
const PLUGIN_NAME = "xiaohongshu-reimbursement-workflow";
const BENCHMARK_LINES = new Set(["H", "O"]);
const SHA_RE = /^[0-9a-f]{64}$/u;
const H_IDENTITY_LOCK = Object.freeze({
  old: Object.freeze({
    version: "0.5.0+codex.20260819174146",
    skillTreeSha256: "df2943f536af035724e8d00fd471888df28b975f83a2bb86640c1f7eb8d812a5",
    packageTreeSha256: "4dcce05f00e92a54ff339cb4485979307bbc5f7b062374355acc1f574e07986c",
  }),
  new: Object.freeze({
    version: "0.5.0+codex.20260821073607",
    skillTreeSha256: "2188793cf320dfece7289b719fbaaefecdc3949aff411c3ad2a8088b62c92ef5",
    packageTreeSha256: "48b9243e7b0364693b9e91a4ccaf563825bc06e7889fb52bec2f2aff0c044f3a",
  }),
});
// Keep the owned prefix short: Excel COM and Windows PowerShell still encounter
// legacy MAX_PATH behavior for deeply nested preview request names.
const SAFE_TEMP_PREFIX = "codex-xhs-ab-";
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function parseArgs(argv) {
  const result = {
    line: "H",
    renderer: "fake",
    samples: DEFAULT_SAMPLES,
    warmups: DEFAULT_WARMUPS,
    threshold: DEFAULT_THRESHOLD_PERCENT,
    diagnostic: false,
    identityOnly: false,
    output: null,
    oldRoot: process.env.XHS_BENCH_OLD_ROOT ? path.resolve(process.env.XHS_BENCH_OLD_ROOT) : null,
    newRoot: process.env.XHS_BENCH_NEW_ROOT ? path.resolve(process.env.XHS_BENCH_NEW_ROOT) : DEFAULT_NEW_ROOT,
  };
  for (const argument of argv) {
    if (argument === "--diagnostic") result.diagnostic = true;
    else if (argument === "--identity-only") result.identityOnly = true;
    else if (argument.startsWith("--line=")) result.line = argument.slice("--line=".length).toUpperCase();
    else if (argument.startsWith("--renderer=")) result.renderer = argument.slice("--renderer=".length);
    else if (argument.startsWith("--samples=")) result.samples = Number(argument.slice("--samples=".length));
    else if (argument.startsWith("--warmups=")) result.warmups = Number(argument.slice("--warmups=".length));
    else if (argument.startsWith("--threshold=")) result.threshold = Number(argument.slice("--threshold=".length));
    else if (argument.startsWith("--output=")) result.output = path.resolve(argument.slice("--output=".length));
    else if (argument.startsWith("--old-root=")) result.oldRoot = path.resolve(argument.slice("--old-root=".length));
    else if (argument.startsWith("--new-root=")) result.newRoot = path.resolve(argument.slice("--new-root=".length));
    else if (argument.startsWith("--old-version=")) result.oldVersion = argument.slice("--old-version=".length);
    else if (argument.startsWith("--new-version=")) result.newVersion = argument.slice("--new-version=".length);
    else if (argument.startsWith("--old-skill-sha256=")) result.oldSkillSha256 = argument.slice("--old-skill-sha256=".length);
    else if (argument.startsWith("--new-skill-sha256=")) result.newSkillSha256 = argument.slice("--new-skill-sha256=".length);
    else if (argument.startsWith("--old-package-sha256=")) result.oldPackageSha256 = argument.slice("--old-package-sha256=".length);
    else if (argument.startsWith("--new-package-sha256=")) result.newPackageSha256 = argument.slice("--new-package-sha256=".length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!BENCHMARK_LINES.has(result.line)) throw new Error("--line must be H or O");
  if (!new Set(["fake", "com"]).has(result.renderer)) throw new Error("--renderer must be fake or com");
  if (!result.oldRoot) throw new Error("verified baseline root is required: pass --old-root=... or set XHS_BENCH_OLD_ROOT");
  if (!Number.isSafeInteger(result.samples) || result.samples < 1) throw new Error("--samples must be a positive integer");
  if (!Number.isSafeInteger(result.warmups) || result.warmups < 0) throw new Error("--warmups must be a non-negative integer");
  if (!result.diagnostic && result.samples < DEFAULT_SAMPLES) throw new Error(`acceptance mode requires at least ${DEFAULT_SAMPLES} samples per version and temperature`);
  if (!result.diagnostic && result.warmups < DEFAULT_WARMUPS) throw new Error(`acceptance mode requires at least ${DEFAULT_WARMUPS} untimed warm-ups per version and temperature`);
  if (!Number.isFinite(result.threshold) || result.threshold < 0 || result.threshold > 100) throw new Error("--threshold must be between 0 and 100");
  const explicitIdentityFields = ["oldVersion", "newVersion", "oldSkillSha256", "newSkillSha256", "oldPackageSha256", "newPackageSha256"];
  for (const field of explicitIdentityFields.filter((name) => name.endsWith("Sha256"))) {
    if (result[field] !== undefined && !SHA_RE.test(result[field])) throw new Error(`--${field.replaceAll(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)} must be a lowercase SHA-256 digest`);
  }
  const explicitCount = explicitIdentityFields.filter((field) => result[field] !== undefined).length;
  if (explicitCount !== 0 && explicitCount !== explicitIdentityFields.length) throw new Error("an explicit identity lock must provide both versions and all four tree digests");
  if (!result.diagnostic && !result.identityOnly && result.line === "O" && explicitCount !== explicitIdentityFields.length) throw new Error("O acceptance requires an explicit six-field identity lock");
  result.identityLock = explicitCount === explicitIdentityFields.length
    ? {
        source: "explicit-cli",
        old: { version: result.oldVersion, skillTreeSha256: result.oldSkillSha256, packageTreeSha256: result.oldPackageSha256 },
        new: { version: result.newVersion, skillTreeSha256: result.newSkillSha256, packageTreeSha256: result.newPackageSha256 },
      }
    : result.line === "H"
      ? { source: "built-in-H-v1", old: { ...H_IDENTITY_LOCK.old }, new: { ...H_IDENTITY_LOCK.new } }
      : null;
  return result;
}

export const parseBenchmarkArgs = parseArgs;

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

function compactIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error(`benchmark date is not ISO: ${value}`);
  return `${match[1]}.${Number(match[2])}.${Number(match[3])}`;
}

function canonicalMoney(cents) {
  return formatMoney(cents).replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
}

function expectedOrdinaryArchiveName(mainPeriod, targetCategory, transactions) {
  const period = mainPeriod.start === mainPeriod.end
    ? compactIsoDate(mainPeriod.start)
    : `${compactIsoDate(mainPeriod.start)}-${compactIsoDate(mainPeriod.end)}`;
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.reportingKind !== "supplement") continue;
    const items = groups.get(transaction.person) ?? [];
    items.push(transaction);
    groups.set(transaction.person, items);
  }
  const supplements = [...groups.entries()].map(([person, items]) => {
    const ordered = [...items].sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
    const start = ordered[0].date;
    const end = ordered.at(-1).date;
    const supplementPeriod = start === end ? compactIsoDate(start) : `${compactIsoDate(start)}-${compactIsoDate(end)}`;
    const amount = canonicalMoney(ordered.reduce((sum, item) => sum + parseMoney(item.reimbursementAmount), 0n));
    return `${person}${supplementPeriod}补报${ordered.length}笔${amount}元`;
  });
  return `${period}_${targetCategory}${supplements.length ? `（含${supplements.join("、")}）` : ""}`;
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

async function buildFixture(benchmarkRoot, oldRoot, newRoot, benchmarkLine) {
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
  const previewDefinitions = ["xiaohongshu", "company", "residence"].flatMap((profileId, profileIndex) =>
    ["root", "detail", "screenshot"].map((role, roleIndex) => ({
      key: `${profileId}:${role}`,
      profileId,
      role,
      name: `preview-${profileId}-${role}.png`,
      definition: { width: 820 + roleIndex * 17, height: 610 + profileIndex * 13, format: "png", seed: 101 + profileIndex * 11 + roleIndex * 3 },
    })),
  );
  const images = new Map();
  for (const [id, name, definition, usage] of imageDefinitions) images.set(id, { ...(await makeSyntheticImage(path.join(inputRoot, name), definition, sharp)), id, usage });
  const fakePreviews = [];
  for (const item of previewDefinitions) {
    fakePreviews.push({ ...item, ...(await makeSyntheticImage(path.join(inputRoot, item.name), item.definition, sharp)) });
  }
  if (new Set(fakePreviews.map((item) => item.sha256)).size !== fakePreviews.length) throw new Error("synthetic fake preview PNGs are not byte-distinct");
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
      archivePath: path.join(inputRoot, expectedOrdinaryArchiveName(
        { start: "2034-05-11", end: "2034-05-17" },
        "小红书报销",
        transactions,
      )),
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
  const metadata = {
    kind: FIXTURE_KIND,
    inputRoot,
    manifest: manifestFile,
    baseline,
    expected: manifest.expected,
    sourceCoverageDigest: audited.sourceCoverageDigest,
    observations,
    fakePreviews: fakePreviews.map(({ key, profileId, role, path: previewPath, sha256: digest, size, width, height, format }) => ({ key, profileId, role, path: previewPath, sha256: digest, size, width, height, format })),
    roots: { old: oldRoot, new: newRoot },
    benchmarkLine,
  };
  const metadataFile = await writeExclusive(path.join(benchmarkRoot, "fixture.json"), jsonBytes(metadata));
  return { ...metadata, metadataPath: metadataFile.path };
}

async function treeDigest(root) {
  const digest = crypto.createHash("sha256");
  let fileCount = 0;
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        fileCount += 1;
        digest.update(relative, "utf8");
        digest.update("\0");
        digest.update(await fs.readFile(absolute));
        digest.update("\0");
      } else throw new Error(`benchmark roots may not contain links or special entries: ${absolute}`);
    }
  }
  await visit(root);
  return { sha256: digest.digest("hex"), fileCount };
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function packageTreeDigest(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push({ relative, absolute });
      else throw new Error(`plugin package may not contain links or special entries: ${absolute}`);
    }
  }
  await visit(root);
  files.sort((left, right) => ordinalCompare(left.relative.toLowerCase(), right.relative.toLowerCase()) || ordinalCompare(left.relative, right.relative));
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    const fileSha256 = sha256(await fs.readFile(file.absolute));
    digest.update(file.relative, "utf8");
    digest.update("\0");
    digest.update(fileSha256, "utf8");
    digest.update("\n");
  }
  return { sha256: digest.digest("hex"), fileCount: files.length };
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

export async function inspectBenchmarkRoot(skillRoot) {
  const requestedSkillRoot = path.resolve(skillRoot);
  const canonicalSkillRoot = await fs.realpath(requestedSkillRoot);
  const skillsDirectory = path.dirname(canonicalSkillRoot);
  if (path.basename(skillsDirectory).toLowerCase() !== "skills") throw new Error(`workflow skill root is not directly inside a skills directory: ${requestedSkillRoot}`);
  const packageRoot = path.dirname(skillsDirectory);
  const canonicalPackageRoot = await fs.realpath(packageRoot);
  if (!within(canonicalPackageRoot, canonicalSkillRoot)) throw new Error(`workflow skill root escapes its plugin package: ${requestedSkillRoot}`);
  const manifestPath = path.join(canonicalPackageRoot, ".codex-plugin", "plugin.json");
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.name !== PLUGIN_NAME || typeof manifest.version !== "string" || !manifest.version) throw new Error(`plugin manifest identity is invalid: ${manifestPath}`);
  const [skillTree, packageTree] = await Promise.all([treeDigest(canonicalSkillRoot), packageTreeDigest(canonicalPackageRoot)]);
  return {
    requestedSkillRoot,
    canonicalSkillRoot,
    canonicalPackageRoot,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    pluginName: manifest.name,
    version: manifest.version,
    skillTreeSha256: skillTree.sha256,
    skillFileCount: skillTree.fileCount,
    packageTreeSha256: packageTree.sha256,
    packageFileCount: packageTree.fileCount,
  };
}

export function assertIdentityLock(actual, expected, label) {
  if (!expected) throw new Error(`${label} has no explicit identity lock.`);
  for (const field of ["version", "skillTreeSha256", "packageTreeSha256"]) {
    if (actual[field] !== expected[field]) throw new Error(`${label} ${field} differs from the locked identity: expected ${expected[field]}, observed ${actual[field]}`);
  }
}

export function assertUnchangedIdentity(before, after, label) {
  for (const field of ["canonicalSkillRoot", "canonicalPackageRoot", "manifestSha256", "version", "skillTreeSha256", "skillFileCount", "packageTreeSha256", "packageFileCount"]) {
    const equal = field.startsWith("canonical") ? samePath(before[field], after[field]) : before[field] === after[field];
    if (!equal) throw new Error(`${label} changed during benchmark (${field}); discard all mixed-version samples.`);
  }
}

async function benchmarkHarnessIdentity() {
  const [scriptBytes, statisticsBytes] = await Promise.all([fs.readFile(SCRIPT_PATH), fs.readFile(STATISTICS_PATH)]);
  return {
    kind: "xiaohongshu-performance-harness-identity-v1",
    benchmarkPath: SCRIPT_PATH,
    benchmarkSha256: sha256(scriptBytes),
    statisticsPath: STATISTICS_PATH,
    statisticsSha256: sha256(statisticsBytes),
    combinedSha256: sha256(jsonBytes({ benchmarkSha256: sha256(scriptBytes), statisticsSha256: sha256(statisticsBytes) })),
  };
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

export function assertDistinctFakePreviewAssets(assets) {
  if (!Array.isArray(assets) || assets.length < 1) throw new Error("fake renderer requires preview assets");
  const keys = new Set();
  const digests = new Set();
  for (const [index, asset] of assets.entries()) {
    if (!asset || typeof asset !== "object" || typeof asset.key !== "string" || !asset.key) throw new Error(`fake preview asset ${index} has no key`);
    if (keys.has(asset.key)) throw new Error(`fake preview asset key is duplicated: ${asset.key}`);
    keys.add(asset.key);
    if (!Buffer.isBuffer(asset.bytes) || asset.bytes.length < 1_000 || !asset.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`fake preview asset ${asset.key} is not a semantically valid benchmark PNG`);
    }
    const actualSha256 = sha256(asset.bytes);
    if (asset.sha256 !== actualSha256) throw new Error(`fake preview asset ${asset.key} SHA-256 differs from its bytes`);
    if (digests.has(actualSha256)) throw new Error("fake renderer refuses identical PNG bytes for different preview bindings");
    digests.add(actualSha256);
  }
  return true;
}

export function makeFakeRenderer(assets) {
  assertDistinctFakePreviewAssets(assets);
  const byKey = new Map(assets.map((asset) => [asset.key, asset]));
  return async ({ request, requestFileSha256 }) => {
    const previews = [];
    const usedDigests = new Set();
    for (const job of request.jobs) {
      const asset = byKey.get(`${job.profileId}:${job.role}`);
      if (!asset) throw new Error(`fake renderer has no PNG for ${job.profileId}:${job.role}`);
      if (usedDigests.has(asset.sha256)) throw new Error("fake renderer refuses to reuse one PNG for two preview jobs");
      usedDigests.add(asset.sha256);
      await fs.writeFile(job.outputPath, asset.bytes, { flag: "wx" });
      if (request.kind === "ordinary-reimbursement-preview-request-v1") {
        previews.push({ profileId: job.profileId, role: job.role, workbookSha256: job.workbookSha256, outputPath: job.outputPath, sha256: asset.sha256, size: asset.bytes.length });
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
          sha256: asset.sha256,
          size: asset.bytes.length,
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
    "  __artifactProfile.workbookGenerateMs += performance.now() - __generateStarted;\n  const expectedSha256 = sha256Bytes(bytes);\n  let created = false;\n  try {\n    const handle = await fs.open(filePath, \"wx\", 0o600);",
    `  __artifactProfile.workbookGenerateMs += performance.now() - __generateStarted;
  const expectedSha256 = sha256Bytes(bytes);
  let created = false;
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

function beginResourceObservation() {
  const rssStartBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssStartBytes;
  let sampleCount = 1;
  const startedUsage = process.resourceUsage();
  const startedCpu = process.cpuUsage();
  const intervalMs = 5;
  const timer = setInterval(() => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    sampleCount += 1;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    const rssEndBytes = process.memoryUsage().rss;
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, rssEndBytes);
    sampleCount += 1;
    const endedUsage = process.resourceUsage();
    const cpu = process.cpuUsage(startedCpu);
    return {
      measurement: "node-process-resource-observation-v1",
      rssScope: "benchmark-worker-node-process-only",
      rssStartBytes,
      rssEndBytes,
      sampledPeakRssBytes,
      rssSamplingIntervalMs: intervalMs,
      rssSampleCount: sampleCount,
      processMaxRssKilobytes: endedUsage.maxRSS,
      cpuUserMicroseconds: cpu.user,
      cpuSystemMicroseconds: cpu.system,
      fsReadOperations: endedUsage.fsRead - startedUsage.fsRead,
      fsWriteOperations: endedUsage.fsWrite - startedUsage.fsWrite,
      involuntaryContextSwitches: endedUsage.involuntaryContextSwitches - startedUsage.involuntaryContextSwitches,
      voluntaryContextSwitches: endedUsage.voluntaryContextSwitches - startedUsage.voluntaryContextSwitches,
      ioBytes: null,
      ioBytesReason: "Node process.resourceUsage exposes operation counters, not portable byte counts.",
    };
  };
}

function mergeResourceObservations(observations) {
  if (!Array.isArray(observations) || observations.length < 1) throw new Error("resource observations are missing");
  const sum = (field) => observations.reduce((total, item) => total + item[field], 0);
  return {
    measurement: "node-process-resource-observation-v1",
    rssScope: "benchmark-worker-node-process-only",
    measuredSegments: ["import-and-prepare", "finalize"],
    rssStartBytes: observations[0].rssStartBytes,
    rssEndBytes: observations.at(-1).rssEndBytes,
    sampledPeakRssBytes: Math.max(...observations.map((item) => item.sampledPeakRssBytes)),
    rssSamplingIntervalMs: observations[0].rssSamplingIntervalMs,
    rssSampleCount: sum("rssSampleCount"),
    processMaxRssKilobytes: Math.max(...observations.map((item) => item.processMaxRssKilobytes)),
    cpuUserMicroseconds: sum("cpuUserMicroseconds"),
    cpuSystemMicroseconds: sum("cpuSystemMicroseconds"),
    fsReadOperations: sum("fsReadOperations"),
    fsWriteOperations: sum("fsWriteOperations"),
    involuntaryContextSwitches: sum("involuntaryContextSwitches"),
    voluntaryContextSwitches: sum("voluntaryContextSwitches"),
    ioBytes: null,
    ioBytesReason: observations[0].ioBytesReason,
  };
}

function assertShaOrNull(value, field, { required = false } = {}) {
  if (value === null && !required) return null;
  if (!SHA_RE.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest${required ? "" : " or null"}`);
  return value;
}

export function assertOrdinaryOutputContract(value, { requirePublished = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ordinary output contract must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["businessFactsDigest", "candidateArtifactDigest", "publishedArtifactDigest", "publishedShapeDigest"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("ordinary output contract fields are not exact");
  assertShaOrNull(value.businessFactsDigest, "businessFactsDigest", { required: true });
  assertShaOrNull(value.candidateArtifactDigest, "candidateArtifactDigest", { required: true });
  assertShaOrNull(value.publishedArtifactDigest, "publishedArtifactDigest", { required: requirePublished });
  assertShaOrNull(value.publishedShapeDigest, "publishedShapeDigest", { required: requirePublished });
  return value;
}

async function readPreparedOutputContract(statePath) {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const semantic = {
    factsDigest: state.factsDigest ?? state.certificate?.factsDigest ?? null,
    sourceCoverageDigest: state.certificate?.sourceCoverageDigest ?? null,
    profileConfigDigest: state.certificate?.profileConfigDigest ?? null,
    affectedProfileIds: [...(state.affectedProfileIds ?? [])],
  };
  const artifacts = [];
  for (const item of state.rootBuild?.artifacts ?? []) {
    artifacts.push(await snapshotArtifactBinding(
      { path: item.candidatePath, sha256: item.candidateSha256, size: item.candidateSize },
      `${item.profileId}:root`,
      "candidate",
    ));
  }
  for (const item of state.presentationBuild?.artifacts ?? []) {
    for (const role of ["detail", "screenshot", "summary"]) {
      artifacts.push(await snapshotArtifactBinding(item[role], `${item.profileId}:${role}`, "candidate"));
    }
    for (const [index, supplement] of (item.supplements ?? []).entries()) {
      artifacts.push(await snapshotArtifactBinding(supplement, `${item.profileId}:supplement:${String(index + 1).padStart(3, "0")}`, "candidate"));
    }
    for (const [index, evidence] of (item.evidenceArchive ?? []).entries()) {
      artifacts.push(await snapshotArtifactBinding(evidence, `${item.profileId}:evidence:${String(index + 1).padStart(3, "0")}`, "candidate"));
    }
  }
  artifacts.sort((left, right) => ordinalCompare(left.identity, right.identity));
  return assertOrdinaryOutputContract({
    businessFactsDigest: sha256(jsonBytes(semantic)),
    candidateArtifactDigest: sha256(jsonBytes({ kind: "ordinary-candidate-artifacts-v2", artifacts })),
    publishedArtifactDigest: null,
    publishedShapeDigest: null,
  });
}

async function canonicalOpcArtifact(filePath, stableSnapshot) {
  const workbook = await openWorkbookSnapshot(stableSnapshot, {});
  const rawBytes = await fs.readFile(filePath);
  if (sha256(rawBytes) !== stableSnapshot.sha256 || rawBytes.length !== stableSnapshot.size) {
    throw new Error(`workbook changed before canonical OPC hashing: ${filePath}`);
  }
  const zip = await JSZip.loadAsync(rawBytes, { checkCRC32: true, createFolders: false });
  const parts = [];
  for (const part of [...workbook.parts].sort((left, right) => ordinalCompare(left.name, right.name))) {
    if (part.directory) {
      parts.push({ name: part.name, type: "directory" });
      continue;
    }
    const entry = zip.files[part.name];
    if (!entry || entry.dir) throw new Error(`canonical OPC part is missing or changed type: ${part.name}`);
    const bytes = await entry.async("nodebuffer");
    parts.push({ name: part.name, type: "file", sha256: sha256(bytes), size: bytes.length });
  }
  await assertStableFileSnapshotCurrent(stableSnapshot);
  return {
    contentKind: "canonical-opc-parts-v1",
    contentSha256: sha256(jsonBytes({ kind: "canonical-opc-parts-v1", parts })),
    partCount: parts.length,
  };
}

async function snapshotArtifactBinding(binding, identity, source = "published") {
  if (!binding || typeof binding !== "object" || typeof binding.path !== "string" || !SHA_RE.test(binding.sha256)) {
    throw new Error(`${source} binding ${identity} is incomplete`);
  }
  const resolved = path.resolve(binding.path);
  const stats = await fs.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${source} binding ${identity} is not a regular file`);
  const stable = await readStableFileSnapshot(resolved, {});
  if (stable.sha256 !== binding.sha256) throw new Error(`${source} binding ${identity} differs from its bound SHA-256`);
  if (binding.size !== undefined && binding.size !== stable.size) throw new Error(`${source} binding ${identity} differs from its bound size`);
  const common = { identity, name: path.basename(resolved) };
  if (path.extname(resolved).toLowerCase() === ".xlsx") return { ...common, ...(await canonicalOpcArtifact(resolved, stable)) };
  await assertStableFileSnapshotCurrent(stable);
  return { ...common, contentKind: "raw-file-v1", contentSha256: stable.sha256, size: stable.size };
}

async function snapshotPublishedTree(directoryPath) {
  const root = path.resolve(directoryPath);
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`published archive is not a plain directory: ${root}`);
  const entries = [];
  async function visit(directory, prefix = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => ordinalCompare(left.name, right.name));
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error(`published archive contains a symbolic link: ${path.join(directory, child.name)}`);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        await visit(absolute, relative);
      } else if (child.isFile()) {
        const bytes = await fs.readFile(absolute);
        entries.push({ path: relative, type: "file", sha256: sha256(bytes), size: bytes.length });
      } else {
        throw new Error(`published archive contains a special entry: ${absolute}`);
      }
    }
  }
  await visit(root);
  return entries;
}

async function readPublishedOutputContract(prepared, receipt) {
  if (!receipt || receipt.kind !== "ordinary-reimbursement-published-v1" || !Array.isArray(receipt.outputs) || receipt.outputs.length < 1) {
    throw new Error("ordinary publish receipt is incomplete");
  }
  const artifacts = [];
  const archiveRoots = new Map();
  const outputs = [...receipt.outputs].sort((left, right) => ordinalCompare(left.profileId, right.profileId));
  for (const output of outputs) {
    for (const role of ["root", "detail", "screenshot", "summary", "snapshot"]) {
      artifacts.push(await snapshotArtifactBinding(output[role], `${output.profileId}:${role}`));
    }
    for (const [index, binding] of (output.supplements ?? []).entries()) {
      artifacts.push(await snapshotArtifactBinding(binding, `${output.profileId}:supplement:${String(index + 1).padStart(3, "0")}`));
    }
    for (const [index, binding] of (output.evidenceArchive ?? []).entries()) {
      artifacts.push(await snapshotArtifactBinding(binding, `${output.profileId}:evidence:${String(index + 1).padStart(3, "0")}`));
    }
    const archiveRoot = path.dirname(path.resolve(output.detail.path));
    archiveRoots.set(process.platform === "win32" ? archiveRoot.toLowerCase() : archiveRoot, archiveRoot);
  }
  artifacts.sort((left, right) => ordinalCompare(left.identity, right.identity));
  const shapes = [];
  for (const archiveRoot of [...archiveRoots.values()].sort(ordinalCompare)) {
    const entries = await snapshotPublishedTree(archiveRoot);
    shapes.push({ name: path.basename(archiveRoot), entries: entries.map((entry) => ({ path: entry.path, type: entry.type })) });
  }
  return assertOrdinaryOutputContract({
    ...prepared,
    publishedArtifactDigest: sha256(jsonBytes({ kind: "ordinary-published-artifacts-v1", artifacts })),
    publishedShapeDigest: sha256(jsonBytes({ kind: "ordinary-published-shape-v1", archives: shapes })),
  }, { requirePublished: true });
}

async function createIsolatedPublishInput(runRoot, fixture) {
  const isolatedRoot = path.join(runRoot, "published-input");
  await fs.mkdir(isolatedRoot, { recursive: false });
  const baselinePath = path.join(isolatedRoot, path.basename(fixture.baseline.path));
  await fs.copyFile(fixture.baseline.path, baselinePath, fs.constants.COPYFILE_EXCL);
  const baselineBytes = await fs.readFile(baselinePath);
  if (sha256(baselineBytes) !== fixture.baseline.sha256) throw new Error("isolated ordinary baseline copy differs from the frozen fixture");
  const manifest = JSON.parse(await fs.readFile(fixture.manifest.path, "utf8"));
  manifest.batch.rootPath = isolatedRoot;
  manifest.batch.archivePath = path.join(isolatedRoot, path.basename(manifest.batch.archivePath));
  const baselineEntry = manifest.files.find((entry) => entry.role === "baseline");
  if (!baselineEntry) throw new Error("ordinary fixture has no baseline binding");
  baselineEntry.path = baselinePath;
  const manifestBytes = jsonBytes(manifest);
  const manifestPath = path.join(runRoot, "isolated-manifest.json");
  await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
  return {
    manifest: { path: manifestPath, sha256: sha256(manifestBytes), size: manifestBytes.length },
    baseline: { path: baselinePath, sha256: fixture.baseline.sha256, size: baselineBytes.length },
  };
}

function ordinaryBenchmarkRunIdentity(fixture, purpose, hexLength) {
  if (fixture.benchmarkLine !== "O") return crypto.randomBytes(hexLength / 2).toString("hex");
  return sha256(jsonBytes({
    kind: "ordinary-performance-deterministic-run-identity-v1",
    sourceCoverageDigest: fixture.sourceCoverageDigest,
    purpose,
  })).slice(0, hexLength);
}

async function runTimedSample({ benchmarkRoot, fixture, version, renderer, round, temperature, workflowModule, includeImport }) {
  const runRoot = fixture.benchmarkLine === "O"
    ? path.join(benchmarkRoot, `run-${temperature[0]}-paired`)
    : path.join(benchmarkRoot, `run-${temperature[0]}-${round}-${version[0]}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(runRoot, { recursive: false });
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = runRoot;
  process.env.TMP = runRoot;
  let module = workflowModule;
  let importMs = 0;
  let stopResourceObservation;
  let resourceMetrics;
  try {
    const fakeAssets = renderer === "fake"
      ? await Promise.all(fixture.fakePreviews.map(async (item) => ({ key: item.key, sha256: item.sha256, bytes: await fs.readFile(item.path) })))
      : null;
    const publishContractRequired = fixture.benchmarkLine === "O";
    const publishInputStarted = performance.now();
    const sampleInput = publishContractRequired
      ? await createIsolatedPublishInput(runRoot, fixture)
      : { manifest: fixture.manifest, baseline: fixture.baseline };
    const excludedPublishInputSetupMs = performance.now() - publishInputStarted;
    stopResourceObservation = beginResourceObservation();
    if (!module) {
      const started = performance.now();
      module = await loadWorkflow(fixture.roots[version], `${temperature}-${round}-${version}`);
      importMs = performance.now() - started;
    }
    const profilePhases = process.env.XHS_WORKFLOW_PROFILE === "1" && version === "new" ? {} : null;
    const baseRenderer = renderer === "fake" ? makeFakeRenderer(fakeAssets) : null;
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
        auditManifest: (manifestPath, expectedSha256) => timeAsync("manifestAuditMs", () => module.auditManifest(manifestPath, expectedSha256)),
        buildRootWorkbookCandidates: (request, options) => timeAsync("candidateBuildAuditMs", () => rootBuilderModule.buildRootWorkbookCandidates(request, options)),
        buildReimbursementArtifacts: (request) => timeAsync("artifactTemplateImageMs", async () => {
          const result = await artifactBuilderModule.buildReimbursementArtifacts(request);
          profilePhases.artifactInternal = artifactBuilderModule.__benchmarkArtifactMetrics();
          return result;
        }),
        ...(baseRenderer ? { runPreviewRenderer: (request) => timeAsync("previewRendererCallbackMs", () => baseRenderer(request)) } : {}),
      };
    }
    const stagingToken = ordinaryBenchmarkRunIdentity(fixture, "staging-token", 64);
    const prepareRequest = {
      kind: "ordinary-reimbursement-prepare-v1",
      stagingToken,
      manifestPath: sampleInput.manifest.path,
      manifestSha256: sampleInput.manifest.sha256,
      baselines: [{ profileId: "xiaohongshu", path: sampleInput.baseline.path, sha256: sampleInput.baseline.sha256, size: sampleInput.baseline.size, candidateRevision: 1 }],
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
    const prepareResourceMetrics = stopResourceObservation();
    stopResourceObservation = undefined;

    let reviewSetupMs = 0;
    let finalizeRequest;
    const requiresIndependentReview = fixture.benchmarkLine === "O" || version === "new";
    if (requiresIndependentReview) {
      const reviewStarted = performance.now();
      const review = {
        kind: "independent-evidence-review-v1",
        reviewerRunId: ordinaryBenchmarkRunIdentity(fixture, "independent-reviewer-run", 32),
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
    stopResourceObservation = beginResourceObservation();
    const finalizeStarted = performance.now();
    const gate2 = await module.finalizeReimbursementWorkflow(finalizeRequest);
    const finalizeMs = performance.now() - finalizeStarted;
    const finalizeResourceMetrics = stopResourceObservation();
    stopResourceObservation = undefined;
    resourceMetrics = mergeResourceObservations([prepareResourceMetrics, finalizeResourceMetrics]);
    resourceMetrics.externalProcessRssBoundary = {
          manifestAuditorWorker: {
            timingIncluded: true,
            includedInWorkerRss: true,
            reason: "The manifest auditor is an isolated worker thread in the benchmark Node process and is included in process RSS.",
      },
      previewRenderer: {
        mode: renderer,
        timingIncluded: true,
        includedInWorkerRss: renderer === "fake",
        enginePeakWorkingSetBytes: Math.max(gate1.previewEnginePeakWorkingSetBytes ?? 0, gate2.previewEnginePeakWorkingSetBytes ?? 0),
        reason: renderer === "fake"
          ? "The fake renderer executes in the benchmark worker and is included in worker RSS."
          : "Excel/PowerShell COM executes outside the Node worker; its reported engine peak is recorded separately and not added to worker RSS.",
      },
    };
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
    const contractStarted = performance.now();
    const preparedOutputContract = await readPreparedOutputContract(gate1.statePath);
    let excludedOutputContractReadMs = performance.now() - contractStarted;
    let outputContract = preparedOutputContract;
    let excludedPublishForEquivalenceMs = 0;
    if (publishContractRequired) {
      const publishStarted = performance.now();
      const receipt = await module.publishReimbursementWorkflow({
        statePath: gate2.statePath,
        expectedGate1BindingDigest: gate1.gate1BindingDigest,
        gate1ApprovalText: "本次报销通过无误",
        expectedGate2BindingDigest: gate2.gate2BindingDigest,
        gate2ApprovalText: "确认更新根目录支出总表",
      });
      excludedPublishForEquivalenceMs = performance.now() - publishStarted;
      const publishedContractStarted = performance.now();
      outputContract = await readPublishedOutputContract(preparedOutputContract, receipt);
      excludedOutputContractReadMs += performance.now() - publishedContractStarted;
    }
    const gate1PreviewSha256 = gate1.review.flatMap((profile) => profile.previews.map((preview) => preview.sha256));
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
      excludedPublishInputSetupMs,
      excludedPublishForEquivalenceMs,
      excludedIndependentReviewSetupMs: reviewSetupMs,
      excludedOutputContractReadMs,
      gate1RenderAttempts,
      observedCounts: {
        gate1PreviewCount: gate1PreviewSha256.length,
        gate1UniquePreviewPngCount: new Set(gate1PreviewSha256).size,
        gate1PreviewRenderAttemptCount: gate1RenderAttempts.reduce((sum, item) => sum + (item.attempts ?? 1), 0),
        gate2: gate2.fullCorrespondenceAudit?.metrics ?? null,
      },
      bindings: {
        gate1BindingDigest: gate1.gate1BindingDigest,
        gate2BindingDigest: gate2.gate2BindingDigest ?? null,
        gate2ReportDigest: gate2.fullCorrespondenceAudit?.reportDigest ?? null,
        gate2Status: gate2.fullCorrespondenceAudit?.status ?? null,
      },
      resources: resourceMetrics,
      outputContract,
      profilePhases,
      gate2Metrics: gate2.fullCorrespondenceAudit?.metrics ?? null,
    };
  } finally {
    if (stopResourceObservation) stopResourceObservation();
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
  const warmups = Number(workerArg("warmups"));
  const fixture = await readFixture(metadataPath);
  if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(warmups) || warmups < 0) throw new Error("hot worker sample and warm-up counts are invalid");
  const modules = {
    old: await loadWorkflow(fixture.roots.old, "hot-old"),
    new: await loadWorkflow(fixture.roots.new, "hot-new"),
  };
  for (const { version, round } of sampleOrder(warmups)) {
    await runTimedSample({ benchmarkRoot, fixture, version, renderer, round: round - warmups, temperature: "hot", workflowModule: modules[version], includeImport: false });
  }
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

function round(value, digits = 3) {
  if (value === null || value === undefined) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundedDistribution(values) {
  return Object.fromEntries(Object.entries(summarizeDistribution(values)).map(([field, value]) => [field, Number.isFinite(value) ? round(value) : value]));
}

function metricBreakdown(samples) {
  return Object.fromEntries(
    ["importMs", "prepareMs", "finalizeMs", "totalPluginMs", "excludedPublishInputSetupMs", "excludedPublishForEquivalenceMs", "excludedIndependentReviewSetupMs", "excludedOutputContractReadMs"]
      .map((field) => [field, roundedDistribution(samples.map((sample) => sample[field]))]),
  );
}

function pairedValues(samples, field) {
  const byRound = new Map();
  for (const sample of samples) {
    const pair = byRound.get(sample.round) ?? {};
    if (pair[sample.version]) throw new Error(`duplicate ${sample.version} sample for round ${sample.round}`);
    pair[sample.version] = sample;
    byRound.set(sample.round, pair);
  }
  const ordered = [...byRound.entries()].sort(([left], [right]) => left - right);
  for (const [sampleRound, pair] of ordered) if (!pair.old || !pair.new) throw new Error(`round ${sampleRound} is not a complete pair`);
  return {
    old: ordered.map(([, pair]) => pair.old[field]),
    new: ordered.map(([, pair]) => pair.new[field]),
  };
}

function summarizeResources(samples) {
  return Object.fromEntries(
    ["rssStartBytes", "rssEndBytes", "sampledPeakRssBytes", "processMaxRssKilobytes", "cpuUserMicroseconds", "cpuSystemMicroseconds", "fsReadOperations", "fsWriteOperations", "involuntaryContextSwitches", "voluntaryContextSwitches"]
      .map((field) => [field, roundedDistribution(samples.map((sample) => sample.resources[field]))]),
  );
}

export function summarizeOrdinaryPerformanceSamples(samples, { threshold, acceptance, line, temperature, renderer }) {
  const oldSamples = samples.filter((sample) => sample.version === "old");
  const newSamples = samples.filter((sample) => sample.version === "new");
  const pairs = pairedValues(samples, "totalPluginMs");
  const oldDistribution = summarizeDistribution(pairs.old);
  const newDistribution = summarizeDistribution(pairs.new);
  const p50Improvement = improvementPercent(oldDistribution.p50, newDistribution.p50);
  const p95Improvement = improvementPercent(oldDistribution.p95, newDistribution.p95);
  const insufficientConfidence = { method: "unavailable", pairCount: pairs.old.length, reason: "at least two timed pairs are required", pointEstimatePercent: null, lowerPercent: null, upperPercent: null };
  const p50Confidence = pairs.old.length >= 2
    ? pairedBootstrapImprovement({ baseline: pairs.old, candidate: pairs.new, probability: 0.5, seedMaterial: `${line}:${temperature}:p50` })
    : insufficientConfidence;
  const p95Confidence = pairs.old.length >= 2
    ? pairedBootstrapImprovement({ baseline: pairs.old, candidate: pairs.new, probability: 0.95, seedMaterial: `${line}:${temperature}:p95` })
    : insufficientConfidence;
  const outputPairs = pairedValues(samples, "outputContract");
  const requirePublished = line === "O";
  const oldOutputDigests = outputPairs.old.map((item) => sha256(jsonBytes(assertOrdinaryOutputContract(item, { requirePublished }))));
  const newOutputDigests = outputPairs.new.map((item) => sha256(jsonBytes(assertOrdinaryOutputContract(item, { requirePublished }))));
  const outputEquivalent = oldOutputDigests.every((digest, index) => digest === newOutputDigests[index])
    && new Set(oldOutputDigests).size === 1
    && new Set(newOutputDigests).size === 1;
  const fakePngDistinct = renderer !== "fake" || samples.every((sample) => sample.observedCounts.gate1PreviewCount === sample.observedCounts.gate1UniquePreviewPngCount);
  const oldResource = summarizeResources(oldSamples);
  const newResource = summarizeResources(newSamples);
  const peakRssRegressionPercent = ((newResource.sampledPeakRssBytes.p50 - oldResource.sampledPeakRssBytes.p50) / oldResource.sampledPeakRssBytes.p50) * 100;
  const strict = evaluateStrictPerformanceAcceptance({
    thresholdPercent: threshold,
    p50ImprovementPercent: p50Improvement,
    p50BootstrapLowerPercent: Number.isFinite(p50Confidence.lowerPercent) ? p50Confidence.lowerPercent : -Number.MAX_VALUE,
    p95ImprovementPercent: p95Improvement,
    peakRssRegressionPercent,
    outputEquivalent,
  });
  const criteria = { ...strict.criteria, fakePreviewPngsAreDistinct: fakePngDistinct };
  const improvementTargetMet = strict.improvementTargetMet;
  const safeguardsPassed = strict.safeguardsPassed && fakePngDistinct;
  return {
    sampleCountPerVersion: oldSamples.length,
    old: { phases: metricBreakdown(oldSamples), resources: oldResource },
    new: { phases: metricBreakdown(newSamples), resources: newResource },
    totalPluginMs: {
      old: Object.fromEntries(Object.entries(oldDistribution).map(([field, value]) => [field, round(value)])),
      new: Object.fromEntries(Object.entries(newDistribution).map(([field, value]) => [field, round(value)])),
      p50ImprovementPercent: round(p50Improvement),
      p95ImprovementPercent: round(p95Improvement),
      pairedBootstrap95: {
        p50: Object.fromEntries(Object.entries(p50Confidence).map(([field, value]) => [field, typeof value === "number" ? round(value) : value])),
        p95: Object.fromEntries(Object.entries(p95Confidence).map(([field, value]) => [field, typeof value === "number" ? round(value) : value])),
      },
    },
    peakRssRegressionPercent: round(peakRssRegressionPercent),
    outputEquivalent,
    fakePngDistinct,
    requiredImprovementPercent: threshold,
    criteria,
    improvementTargetMet,
    safeguardsPassed,
    acceptancePassed: acceptance ? safeguardsPassed : null,
    diagnosticWouldMeetConfiguredCriteria: acceptance ? null : improvementTargetMet && safeguardsPassed,
    diagnosticWouldPassSafeguards: acceptance ? null : safeguardsPassed,
  };
}

async function dependencyIdentity(packageName) {
  const packageRoot = path.join(path.resolve(path.dirname(process.execPath), ".."), "node_modules", packageName);
  try {
    const canonicalRoot = await fs.realpath(packageRoot);
    const packageJsonBytes = await fs.readFile(path.join(canonicalRoot, "package.json"));
    const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
    return { name: packageName, version: packageJson.version ?? null, canonicalRoot, packageJsonSha256: sha256(packageJsonBytes) };
  } catch (error) {
    return { name: packageName, available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function environmentIdentity() {
  const power = process.platform === "win32"
    ? spawnSync("powercfg", ["/getactivescheme"], { encoding: "utf8", windowsHide: true, timeout: 10_000 })
    : null;
  return {
    node: process.version,
    nodeExecPath: process.execPath,
    nodeVersions: { ...process.versions },
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    osVersion: os.version(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    uptimeSecondsAtStart: round(os.uptime()),
    powerScheme: power?.status === 0 ? power.stdout.trim() : null,
    powerSchemeObservationError: power && power.status !== 0 ? (power.stderr || `exit ${power.status}`).trim() : null,
    bundledRuntimeRoot: path.resolve(path.dirname(process.execPath), ".."),
    dependencies: await Promise.all([dependencyIdentity("jszip"), dependencyIdentity("sharp")]),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const harnessBefore = await benchmarkHarnessIdentity();
  for (const root of [options.oldRoot, options.newRoot]) {
      const stats = await fs.stat(path.join(root, "scripts", "run_reimbursement_workflow.mjs"));
      if (!stats.isFile()) throw new Error(`workflow root is invalid: ${root}`);
  }
  const identitiesBefore = {
    old: await inspectBenchmarkRoot(options.oldRoot),
    new: await inspectBenchmarkRoot(options.newRoot),
  };
  if (samePath(identitiesBefore.old.canonicalSkillRoot, identitiesBefore.new.canonicalSkillRoot)) throw new Error("old and new benchmark roots resolve to the same skill tree");
  if (options.identityLock) {
    assertIdentityLock(identitiesBefore.old, options.identityLock.old, "old workflow root");
    assertIdentityLock(identitiesBefore.new, options.identityLock.new, "new workflow root");
  }
  if (options.identityOnly) {
    process.stdout.write(`${JSON.stringify({
      kind: "xiaohongshu-workflow-performance-identity-v1",
      benchmarkLine: options.line,
      generatedAt: new Date().toISOString(),
      harness: harnessBefore,
      roots: identitiesBefore,
      acceptanceCliLock: {
        oldVersion: identitiesBefore.old.version,
        newVersion: identitiesBefore.new.version,
        oldSkillSha256: identitiesBefore.old.skillTreeSha256,
        newSkillSha256: identitiesBefore.new.skillTreeSha256,
        oldPackageSha256: identitiesBefore.old.packageTreeSha256,
        newPackageSha256: identitiesBefore.new.packageTreeSha256,
      },
    }, null, 2)}\n`);
    return;
  }
  const benchmarkRoot = await fs.mkdtemp(path.join(os.tmpdir(), SAFE_TEMP_PREFIX));
  let finalReport;
  try {
    const fixture = await buildFixture(benchmarkRoot, identitiesBefore.old.canonicalSkillRoot, identitiesBefore.new.canonicalSkillRoot, options.line);
    for (const { version, round: warmupRound } of sampleOrder(options.warmups)) {
      await spawnJson([
        "--worker-one",
        `--fixture=${fixture.metadataPath}`,
        `--benchmark-root=${benchmarkRoot}`,
        `--version=${version}`,
        `--renderer=${options.renderer}`,
        `--round=${warmupRound - options.warmups}`,
      ]);
    }
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
      `--warmups=${options.warmups}`,
    ], { timeoutMs: 30 * 60_000 });
    const identitiesAfter = {
      old: await inspectBenchmarkRoot(options.oldRoot),
      new: await inspectBenchmarkRoot(options.newRoot),
    };
    const harnessAfter = await benchmarkHarnessIdentity();
    if (harnessBefore.combinedSha256 !== harnessAfter.combinedSha256) throw new Error("benchmark harness changed during the run; discard all samples");
    assertUnchangedIdentity(identitiesBefore.old, identitiesAfter.old, "old workflow root");
    assertUnchangedIdentity(identitiesBefore.new, identitiesAfter.new, "new workflow root");
    if (options.identityLock) {
      assertIdentityLock(identitiesAfter.old, options.identityLock.old, "old workflow root after benchmark");
      assertIdentityLock(identitiesAfter.new, options.identityLock.new, "new workflow root after benchmark");
    }
    const summaryOptions = { threshold: options.threshold, acceptance: !options.diagnostic, line: options.line, renderer: options.renderer };
    const coldSummary = summarizeOrdinaryPerformanceSamples(cold, { ...summaryOptions, temperature: "cold" });
    const hotSummary = summarizeOrdinaryPerformanceSamples(hot, { ...summaryOptions, temperature: "hot" });
    const acceptancePassed = coldSummary.acceptancePassed === true && hotSummary.acceptancePassed === true;
    finalReport = {
      kind: BENCHMARK_KIND,
      generatedAt: new Date().toISOString(),
      acceptance: !options.diagnostic,
      benchmarkLine: options.line,
      renderer: options.renderer,
      environment: await environmentIdentity(),
      protocol: {
        line: options.line,
        lineMeaning: options.line === "H"
          ? "immutable installed 20260819174146 legacy contract versus unmodified 20260821073607 full-correspondence contract"
          : "unmodified 20260821073607 full-correspondence ordinary path versus candidate full-correspondence ordinary path",
        identityLock: options.identityLock ?? { source: "observed-diagnostic-only", old: null, new: null },
        harnessBefore,
        harnessAfter,
        rootsBefore: identitiesBefore,
        rootsAfter: identitiesAfter,
        samplesPerVersionPerTemperature: options.samples,
        untimedWarmupsPerVersionPerTemperature: options.warmups,
        improvementTargetIsInformational: true,
        ordering: "alternating-old-new/new-old-by-round",
        cold: "one fresh Node process per sample (Windows filesystem cache not flushed); timed dynamic import + prepare/Gate1 + finalize",
        hot: "both versions imported before timing; repeated in one Node process",
        excluded: [
          "synthetic fixture generation",
          "independent evidence observation construction and JSON write",
          "O-line isolated publish-input copy/rebinding",
          "O-line publish execution used only to prove published-output equivalence",
          "benchmark-only published artifact/tree read and hashing",
          "warm-up runs",
        ],
        included: ["all plugin-controlled manifest/workbook/media reads", "candidate and delivery construction", "preview validation", "Gate 2 fresh media decode", "full correspondence audit/report", "Gate 2 preview binding"],
        resourceMeasurement: {
          rss: "5 ms user-space sampling of the benchmark worker Node process; enforced for both cold and hot summaries, with cold samples isolated and hot samples sharing one process",
          workerScope: "runner import (cold only), prepare/Gate 1, and finalize/Gate 2",
          manifestAuditorWorker: "timing is included and the isolated worker thread is included in benchmark-process RSS",
          previewRenderer: "fake rendering runs in-process and is included; Excel/PowerShell COM is out-of-process, so its enginePeakWorkingSetBytes is reported separately and is not added to worker RSS",
          io: "process.resourceUsage filesystem operation deltas; portable per-process byte counters unavailable and therefore reported as null",
        },
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
        fakePreviewPngCount: fixture.fakePreviews.length,
        fakePreviewPngSha256: fixture.fakePreviews.map((item) => ({ key: item.key, sha256: item.sha256 })),
      },
      summaries: { cold: coldSummary, hot: hotSummary },
      acceptancePassed: options.diagnostic ? null : acceptancePassed,
      diagnosticWouldMeetConfiguredCriteria: options.diagnostic
        ? coldSummary.diagnosticWouldMeetConfiguredCriteria === true && hotSummary.diagnosticWouldMeetConfiguredCriteria === true
        : null,
      diagnosticWouldPassSafeguards: options.diagnostic
        ? coldSummary.diagnosticWouldPassSafeguards === true && hotSummary.diagnosticWouldPassSafeguards === true
        : null,
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
    if (!options.diagnostic && !finalReport.acceptancePassed) process.exitCode = 2;
  } finally {
    if (!path.basename(benchmarkRoot).startsWith(SAFE_TEMP_PREFIX)) throw new Error(`refusing to clean unsafe benchmark root: ${benchmarkRoot}`);
    await fs.rm(benchmarkRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && samePath(SCRIPT_PATH, process.argv[1])) {
  try {
    if (process.argv[2] === "--worker-one") await workerOne();
    else if (process.argv[2] === "--worker-hot") await workerHot();
    else await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
