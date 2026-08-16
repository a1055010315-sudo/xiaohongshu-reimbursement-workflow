import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as builder from "../scripts/build_root_workbook_candidate.mjs";
import {
  canonicalDigest,
  loadBundledDependency,
  parseStrictJson,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";
import * as primitives from "../scripts/workflow_primitives.mjs";
import {
  formatMilliunits,
  loadProfileRegistry,
  parseMilliunits,
} from "../scripts/finance_domain.mjs";
import { readWorkbookOoxmlFacts } from "../scripts/workbook_ooxml_facts.mjs";
import { readStableFileSnapshot } from "../scripts/workbook_snapshot.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_DOCUMENT_REL = DOCUMENT_REL_NS + "/officeDocument";
const WORKSHEET_REL = DOCUMENT_REL_NS + "/worksheet";
const STYLES_REL = DOCUMENT_REL_NS + "/styles";
const BUILDER_SCRIPT = fileURLToPath(new URL("../scripts/build_root_workbook_candidate.mjs", import.meta.url));
const STAGING_PREFIX = "codex-xhs-reimburse-";
const TOKEN_BYTES = 32;
const OWNED_FILE_KINDS = Object.freeze([
  "owner-marker",
  "worker-request",
  "temp-candidate",
  "final-candidate",
  "plan",
]);

let registry;
let tempRoot;
const stagingRoots = new Set();

function xml(body) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serial(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  assert.ok(match);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000)
    + 25_569;
}

function amount(value) {
  return parseMilliunits(value, "fixture amount", { allowNegative: true });
}

function cellString(ref, styleIndex, value) {
  return '<c r="' + ref + '" s="' + styleIndex + '" t="inlineStr"><is><t>'
    + escapeXml(value) + "</t></is></c>";
}

function cellNumber(ref, styleIndex, value) {
  return '<c r="' + ref + '" s="' + styleIndex + '" t="n"><v>'
    + escapeXml(value) + "</v></c>";
}

function cellFormula(ref, styleIndex, formula, cachedValue) {
  return '<c r="' + ref + '" s="' + styleIndex + '" t="n"><f>'
    + escapeXml(formula) + "</f>"
    + (cachedValue === null ? "" : "<v>" + escapeXml(cachedValue) + "</v>")
    + "</c>";
}

function runs(records, key) {
  const result = [];
  for (let index = 0; index < records.length; index += 1) {
    const value = key(records[index]);
    const previous = result.at(-1);
    if (!previous || previous.value !== value) result.push({ value, start: index, end: index });
    else previous.end = index;
  }
  return result;
}

function renderWorksheet(records, options = {}) {
  const dateRuns = runs(records, (record) => record.date);
  const groupRuns = runs(records, (record) => record.group);
  const dateByIndex = new Map();
  const groupByIndex = new Map();
  for (const run of dateRuns) {
    for (let index = run.start; index <= run.end; index += 1) dateByIndex.set(index, run);
  }
  for (const run of groupRuns) {
    for (let index = run.start; index <= run.end; index += 1) groupByIndex.set(index, run);
  }

  const rows = [];
  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2;
    const dateRun = dateByIndex.get(index);
    const groupRun = groupByIndex.get(index);
    let cells = "";
    if (dateRun.start === index) {
      cells += cellNumber("A" + rowNumber, record.aStyle ?? 1, serial(record.date));
    }
    cells += cellString("B" + rowNumber, record.bStyle ?? 2, record.project);
    cells += cellNumber("C" + rowNumber, record.cStyle ?? 3, record.amount);
    if (groupRun.start === index) {
      const startRow = groupRun.start + 2;
      const endRow = groupRun.end + 2;
      const total = formatMilliunits(records.slice(groupRun.start, groupRun.end + 1)
        .reduce((sum, item) => sum + amount(item.amount), 0n));
      if ((record.groupMode ?? "direct") === "direct") {
        cells += cellNumber("D" + rowNumber, record.dStyle ?? 4, total);
      } else {
        cells += cellFormula(
          "D" + rowNumber,
          record.dStyle ?? 4,
          record.formula ?? ("SUM(C" + startRow + ":C" + endRow + ")"),
          record.cache === false ? null : total,
        );
      }
      cells += cellString("E" + rowNumber, record.eStyle ?? 2, record.person);
      cells += cellString("F" + rowNumber, record.fStyle ?? 2, record.classification);
    }
    if (record.followerResidue) cells += cellNumber("D" + rowNumber, 4, record.followerResidue);
    const height = record.rowHeight ?? "22";
    rows.push('<row r="' + rowNumber + '" ht="' + height + '" customHeight="1">'
      + cells + "</row>");
  }

  const merges = [];
  for (const run of dateRuns) {
    if (run.start !== run.end) merges.push("A" + (run.start + 2) + ":A" + (run.end + 2));
  }
  for (const run of groupRuns) {
    if (run.start === run.end) continue;
    for (const column of ["D", "E", "F"]) {
      merges.push(column + (run.start + 2) + ":" + column + (run.end + 2));
    }
  }
  const mergeXml = merges.length === 0
    ? ""
    : '<mergeCells count="' + merges.length + '">'
      + merges.map((ref) => '<mergeCell ref="' + ref + '"/>').join("")
      + "</mergeCells>";
  const dimension = options.dimensionRef === undefined
    ? ""
    : '<dimension ref="' + escapeXml(options.dimensionRef) + '"/>';
  return xml(
    '<worksheet xmlns="' + MAIN_NS + '">'
      + dimension
      + '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<cols><col min="1" max="1" width="17.375" customWidth="1"/>'
      + '<col min="2" max="6" width="26.625" customWidth="1"/></cols>'
      + '<sheetData><row r="1" ht="22" customHeight="1">'
      + cellString("A1", 2, "日期")
      + cellString("B1", 2, "支出明细")
      + cellString("C1", 2, "支出金额")
      + cellString("D1", 2, "合计")
      + cellString("E1", 2, "支出人")
      + cellString("F1", 2, "备注")
      + "</row>" + rows.join("") + "</sheetData>"
      + mergeXml
      + '<printOptions horizontalCentered="1" headings="0" gridLines="0"/>'
      + '<pageMargins left="0.30" right="0.30" top="0.30" bottom="0.30" header="0.15" footer="0.15"/>'
      + '<pageSetup paperSize="9" orientation="landscape" scale="85" fitToWidth="1" fitToHeight="0"/>'
      + "</worksheet>",
  );
}

function relationships(items) {
  return xml('<Relationships xmlns="' + PACKAGE_REL_NS + '">'
    + items.map((item) => '<Relationship Id="' + item.id + '" Type="' + item.type
      + '" Target="' + item.target + '"/>').join("")
    + "</Relationships>");
}

function stylesXml() {
  return xml(
    '<styleSheet xmlns="' + MAIN_NS + '">'
      + '<numFmts count="2"><numFmt numFmtId="200" formatCode="mm-dd"/>'
      + '<numFmt numFmtId="201" formatCode="0.000"/></numFmts>'
      + '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>'
      + '<cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="200"/>'
      + '<xf numFmtId="0"/><xf numFmtId="201"/><xf numFmtId="201"/>'
      + '<xf numFmtId="0"/><xf numFmtId="201"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles>'
      + "</styleSheet>",
  );
}

function unmanagedSheetXml(label) {
  return xml('<worksheet xmlns="' + MAIN_NS + '"><sheetData><row r="1">'
    + cellString("A1", 2, label) + "</row></sheetData>"
    + '<printOptions horizontalCentered="1" gridLines="0"/>'
    + '<pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/>'
    + "</worksheet>");
}

function packageParts(profile, records, options = {}) {
  const unmanaged = profile.profileId === "company" ? ["来源结算摘要", "核对说明"] : [];
  const sheets = [{ name: profile.managedRootSheetName, part: "sheet1.xml", id: "rSheet1" }]
    .concat(unmanaged.map((name, index) => ({
      name,
      part: "sheet" + (index + 2) + ".xml",
      id: "rSheet" + (index + 2),
    })));
  const workbookSheets = sheets.map((sheet, index) => (
    '<sheet name="' + escapeXml(sheet.name) + '" sheetId="' + (index + 1)
      + '" r:id="' + sheet.id + '"/>'
  )).join("");
  const printEnd = records.length + 1;
  const managedName = profile.managedRootSheetName.replaceAll("'", "''");
  const workbook = xml(
    '<workbook xmlns="' + MAIN_NS + '" xmlns:r="' + DOCUMENT_REL_NS + '">'
      + "<sheets>" + workbookSheets + "</sheets><definedNames>"
      + '<definedName name="_xlnm.Print_Area" localSheetId="0">\''
      + managedName + "'!$A$1:$F$" + printEnd + "</definedName>"
      + '<definedName name="_xlnm.Print_Titles" localSheetId="0">\''
      + managedName + "'!$1:$1</definedName>"
      + "</definedNames></workbook>",
  );
  const workbookRelationships = [
    { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
    ...sheets.map((sheet) => ({ id: sheet.id, type: WORKSHEET_REL, target: "worksheets/" + sheet.part })),
  ];
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map((sheet) => '<Override PartName="/xl/worksheets/' + sheet.part
      + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
  ].join("");
  const parts = {
    "[Content_Types].xml": xml('<Types xmlns="' + CONTENT_TYPES_NS + '">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>' + overrides + "</Types>"),
    "_rels/.rels": relationships([{ id: "rWorkbook", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml" }]),
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": relationships(workbookRelationships),
    "xl/styles.xml": stylesXml(),
    "xl/worksheets/sheet1.xml": renderWorksheet(records, options),
  };
  unmanaged.forEach((name, index) => {
    parts["xl/worksheets/sheet" + (index + 2) + ".xml"] = unmanagedSheetXml(name);
  });
  return parts;
}

async function writeWorkbook(directory, filename, profile, records, options = {}) {
  await fs.mkdir(directory, { recursive: true });
  const zip = new JSZip();
  for (const [partName, content] of Object.entries(packageParts(profile, records, options))) {
    zip.file(partName, content, { createFolders: false });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { filePath, bytes, size: bytes.length, sha256: sha256Bytes(bytes) };
}

function defaultBaselineRecord(profileId, overrides = {}) {
  return {
    date: "2026-08-01",
    project: "基线-" + profileId,
    amount: "10",
    person: "基线人员",
    classification: "基线组",
    group: "baseline-group",
    groupMode: "direct",
    ...overrides,
  };
}

function defaultTransaction(profileId, sourceOrder = 1, overrides = {}) {
  const profile = registry.profiles[profileId];
  return {
    id: "TX-" + profileId.toUpperCase() + "-" + sourceOrder,
    date: "2026-08-02",
    person: "新增-" + profileId,
    project: "新增项目-" + profileId,
    label: "新增-" + profileId,
    amount: profileId === "residence" ? "1.625" : profileId === "company" ? "30" : "20.25",
    category: profile.targetCategory,
    profileId,
    classification: "新增组-" + profileId,
    sourceOrder,
    settlement: profileId === "company" ? "company_paid_no_reimbursement" : "employee_reimbursement",
    ...overrides,
  };
}

function transactionRecord(transaction) {
  return {
    date: transaction.date,
    project: transaction.project,
    amount: transaction.amount,
    person: transaction.person,
    classification: transaction.classification,
    group: transaction.id,
    groupMode: "formula",
  };
}

function makeFactsCertificate(transactions) {
  const sorted = [...transactions].sort((left, right) => left.id.localeCompare(right.id, "en"));
  assert.ok(sorted.length > 0);
  const targetCategory = sorted[0].category;
  const categoryTotals = new Map();
  const realTotals = new Map();
  for (const transaction of sorted) {
    const value = amount(transaction.amount);
    categoryTotals.set(transaction.category, (categoryTotals.get(transaction.category) ?? 0n) + value);
    if (transaction.settlement === "employee_reimbursement") {
      realTotals.set(transaction.category, (realTotals.get(transaction.category) ?? 0n) + value);
    }
  }
  const factsPreimage = {
    batchId: "batch-root-builder-red-test",
    targetCategory,
    transactions: sorted.map((transaction) => structuredClone(transaction)),
    expectedTotals: {
      feeTotal: formatMilliunits(categoryTotals.get(targetCategory) ?? 0n),
      realTotal: formatMilliunits(realTotals.get(targetCategory) ?? 0n),
      categoryTotals: Object.fromEntries(
        [...categoryTotals].sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, value]) => [key, formatMilliunits(value)]),
      ),
    },
    affectedProfileIds: registry.profileOrder.filter((profileId) =>
      sorted.some((transaction) => transaction.profileId === profileId)),
    profileConfigDigest: registry.profileConfigDigest,
  };
  const sourceCoveragePreimage = {
    sourceScopes: sorted.map((transaction) => ({
      id: "SCOPE-" + transaction.id,
      fileId: "FILE-" + transaction.id,
      fileSha256: sha256Bytes("file-" + transaction.id),
      locator: "full-" + transaction.id,
      terminalConfirmed: true,
      expectedUnitCount: 1,
    })),
    sourceUnits: sorted.map((transaction) => ({
      id: "UNIT-" + transaction.id,
      scopeId: "SCOPE-" + transaction.id,
      locator: "unit-" + transaction.id,
      disposition: "used",
    })),
    transactionSourceRefs: sorted.map((transaction) => ({
      transactionId: transaction.id,
      sourceRefs: ["UNIT-" + transaction.id],
    })),
  };
  const body = {
    kind: "reimbursement-manifest-facts-v1",
    operationMode: "reimbursement-batch",
    manifestFileSha256: "1".repeat(64),
    manifestDigest: "2".repeat(64),
    configDigest: "3".repeat(64),
    profileConfigDigest: registry.profileConfigDigest,
    factsDigest: canonicalDigest(factsPreimage),
    factsPreimage,
    sourceCoverageDigest: canonicalDigest(sourceCoveragePreimage),
    sourceCoveragePreimage,
  };
  return { ...body, certificateDigest: canonicalDigest(body) };
}

function nextToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function stagingRootFor(token) {
  const root = path.join(path.resolve(os.tmpdir()), STAGING_PREFIX + token);
  stagingRoots.add(root);
  return root;
}

function candidatePathFor(root, profileId, revision = 1) {
  return path.join(root, registry.profiles[profileId].archiveStem + "_修正版" + revision + ".xlsx");
}

function planPathFor(root, profileId, revision = 1) {
  return path.join(root, registry.profiles[profileId].archiveStem + "_修正版" + revision + ".root-plan.json");
}

async function makeScenario(profileIds, options = {}) {
  const transactions = options.transactions ?? profileIds.map((profileId, index) =>
    defaultTransaction(profileId, index + 1));
  const certificate = makeFactsCertificate(transactions);
  const scenarioRoot = await fs.mkdtemp(path.join(tempRoot, "scenario-"));
  const artifacts = [];
  const baselines = new Map();
  for (const profileId of profileIds) {
    const profile = registry.profiles[profileId];
    const records = options.baselineRecords?.[profileId] ?? [defaultBaselineRecord(profileId)];
    const filename = profileId === "residence" && options.residenceAlias === true
      ? "住所支出.xlsx"
      : profile.canonicalRootWorkbookName;
    const baseline = await writeWorkbook(
      path.join(scenarioRoot, profileId),
      filename,
      profile,
      records,
      options.baselineOptions?.[profileId],
    );
    baselines.set(profileId, baseline);
    artifacts.push({
      profileId,
      baselinePath: baseline.filePath,
      baselineSha256: baseline.sha256,
      baselineSize: baseline.size,
      candidateRevision: options.candidateRevision ?? 1,
    });
  }
  const stagingToken = options.stagingToken ?? nextToken();
  const stagingRoot = stagingRootFor(stagingToken);
  return {
    artifacts,
    baselines,
    certificate,
    profileIds,
    request: {
      kind: builder.ROOT_WORKBOOK_BUILD_REQUEST_KIND,
      stagingToken,
      reimbursementFactsCertificate: certificate,
      artifacts,
    },
    stagingRoot,
    stagingToken,
  };
}

async function factsFor(filePath) {
  return readWorkbookOoxmlFacts(await readStableFileSnapshot(path.resolve(filePath)));
}

function managedWorksheet(facts, profileId) {
  const name = registry.profiles[profileId].managedRootSheetName;
  const identity = facts.workbook.sheets.find((sheet) => sheet.name === name);
  assert.ok(identity, "managed sheet identity must exist");
  return facts.worksheets.find((sheet) => sheet.partName === identity.partName);
}

function cellAt(worksheet, ref) {
  for (const row of worksheet.rows) {
    const cell = row.cells.find((item) => item.ref === ref);
    if (cell) return cell;
  }
  return undefined;
}

function syntheticAudit(profileId, certificate, baseline, candidate) {
  const profile = registry.profiles[profileId];
  const body = {
    kind: "root-workbook-business-audit-v1",
    requiresGate1Binding: true,
    profile: {
      profileId,
      targetCategory: profile.targetCategory,
      canonicalRootWorkbookName: profile.canonicalRootWorkbookName,
      managedRootSheetName: profile.managedRootSheetName,
    },
    manifest: {
      certificateDigest: certificate.certificateDigest,
      factsDigest: certificate.factsDigest,
      sourceCoverageDigest: certificate.sourceCoverageDigest,
      profileConfigDigest: certificate.profileConfigDigest,
      batchId: certificate.factsPreimage.batchId,
    },
    baseline: {
      sourceSize: baseline.size,
      sourceSha256: baseline.sha256,
      factsDigest: "4".repeat(64),
      recordCount: 1,
      amount: "10",
    },
    candidate: {
      sourceSize: candidate.size,
      sourceSha256: candidate.sha256,
      factsDigest: "5".repeat(64),
      recordCount: 2,
      amount: "30.25",
    },
    transitionDigest: "6".repeat(64),
    sourceCoverage: {
      scopes: certificate.sourceCoveragePreimage.sourceScopes.length,
      units: certificate.sourceCoveragePreimage.sourceUnits.length,
      usedUnits: certificate.sourceCoveragePreimage.sourceUnits
        .filter((unit) => unit.disposition === "used").length,
      excludedUnits: certificate.sourceCoveragePreimage.sourceUnits
        .filter((unit) => unit.disposition === "excluded").length,
      transactionRefs: certificate.sourceCoveragePreimage.transactionSourceRefs
        .reduce((total, item) => total + item.sourceRefs.length, 0),
    },
    projection: {
      baselineRecordCount: 1,
      manifestRecordCount: 1,
      transactionCount: 2,
      startRow: 2,
      endRow: 3,
      amount: "30.25",
      physicalFields: ["date", "project", "amount", "person", "classification"],
      manifestOnlyFields: ["id", "label", "profileId", "category", "sourceOrder", "settlement", "adjustment", "sourceRefs"],
      formulaCachePolicy: "optional-consistency-check",
      projectionDigest: "7".repeat(64),
    },
  };
  return { ...body, auditDigest: canonicalDigest(body) };
}

function outputPaths(scenario, profileId) {
  return {
    candidatePath: candidatePathFor(scenario.stagingRoot, profileId),
    planPath: planPathFor(scenario.stagingRoot, profileId),
  };
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function stagingEntries(scenario) {
  try {
    return await fs.readdir(scenario.stagingRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function assertNoCommittedOutputs(scenario) {
  for (const profileId of scenario.profileIds) {
    const paths = outputPaths(scenario, profileId);
    assert.equal(await pathExists(paths.candidatePath), false, "candidate must not be committed");
    assert.equal(await pathExists(paths.planPath), false, "plan must not be committed");
  }
}

function mutateAtPath(value, pathParts, replacement) {
  const result = structuredClone(value);
  let cursor = result;
  for (const part of pathParts.slice(0, -1)) cursor = cursor[part];
  cursor[pathParts.at(-1)] = replacement;
  return result;
}

function resignAudit(audit, mutation = {}) {
  const body = structuredClone(audit);
  delete body.auditDigest;
  const result = { ...body, ...mutation };
  return { ...result, auditDigest: canonicalDigest(result) };
}

function profileBindingsForScenario(scenario, candidateSha256 = "4".repeat(64)) {
  return scenario.profileIds.map((profileId) => {
    const artifact = scenario.artifacts.find((item) => item.profileId === profileId);
    return {
      profileId,
      baselineSha256: artifact.baselineSha256,
      candidateSha256,
    };
  });
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !pidExists(pid);
}

async function runChild(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function writeText(name, text) {
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
  return filePath;
}

async function writeJson(name, value) {
  return writeText(name, JSON.stringify(value) + "\n");
}

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-root-builder-red-"));
  registry = await loadProfileRegistry();
});

test.after(async () => {
  for (const root of stagingRoots) {
    if (
      path.dirname(root) === path.resolve(os.tmpdir())
      && path.basename(root).startsWith(STAGING_PREFIX)
    ) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("stable binary API is bounded, branded, private, and copy-isolated", async () => {
  assert.equal(typeof primitives.readStableBinaryFile, "function");
  assert.equal(typeof primitives.copyStableBinaryBytes, "function");
  const filePath = path.join(tempRoot, "binary-api.xlsx");
  await fs.writeFile(filePath, Buffer.from("stable-binary", "utf8"), { flag: "wx" });
  const snapshot = await primitives.readStableBinaryFile(filePath, { maxBytes: 100 * 1024 * 1024 });
  assert.equal(snapshot.kind, "stable-binary-file-v1");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.hasOwn(snapshot, "bytes"), false);
  assert.equal(snapshot.size, 13);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/u);
  const first = primitives.copyStableBinaryBytes(snapshot);
  const second = primitives.copyStableBinaryBytes(snapshot);
  assert.notStrictEqual(first, second);
  first[0] ^= 0xff;
  assert.equal(second.toString("utf8"), "stable-binary");
  assert.equal(primitives.copyStableBinaryBytes(snapshot).toString("utf8"), "stable-binary");
  await assert.rejects(
    () => primitives.readStableBinaryFile(filePath, { maxBytes: 100 * 1024 * 1024 + 1 }),
    /maximum|100.*MiB|limit/iu,
  );
});

test("existing stable JSON reader keeps its strict behavior while binary reads share its boundary", async () => {
  const validPath = await writeText("stable-json.json", '{"a":1}\n');
  const valid = await readStableUtf8JsonFile(validPath, { maxBytes: 1024 });
  assert.equal(valid.value.a, 1);
  assert.deepEqual(Object.keys(valid.value), ["a"]);
  assert.match(valid.sha256, /^[0-9a-f]{64}$/u);
  const duplicatePath = await writeText("stable-json-duplicate.json", '{"a":1,"\\u0061":2}\n');
  await assert.rejects(
    () => readStableUtf8JsonFile(duplicatePath, { maxBytes: 1024 }),
    /duplicate.*key/iu,
  );
  const invalidUtf8Path = path.join(tempRoot, "stable-json-invalid.bin");
  await fs.writeFile(invalidUtf8Path, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]), { flag: "wx" });
  await assert.rejects(
    () => readStableUtf8JsonFile(invalidUtf8Path, { maxBytes: 1024 }),
    /valid UTF-8/iu,
  );
});

test("binary reader rejects growth, truncation, replacement, and same-size rewrite during baseline open", async (t) => {
  assert.equal(typeof primitives.readStableBinaryFile, "function");
  const cases = [
    {
      name: "growth",
      mutate: async (filePath) => fs.appendFile(filePath, "growth"),
      error: /grow|changed|bounded/iu,
    },
    {
      name: "truncation",
      mutate: async (filePath) => fs.truncate(filePath, 1),
      error: /trunc|changed|expected/iu,
    },
    {
      name: "replacement",
      mutate: async (filePath) => {
        const replacement = filePath + ".replacement";
        await fs.writeFile(replacement, "replacement", { flag: "wx" });
        await fs.rename(replacement, filePath);
      },
      error: process.platform === "win32"
        ? /replac|identity|changed|could not be read/iu
        : /replac|identity|changed/iu,
    },
    {
      name: "same-size rewrite",
      mutate: async (filePath) => {
        const bytes = await fs.readFile(filePath);
        bytes[0] ^= 0x01;
        await fs.writeFile(filePath, bytes, { flag: "w" });
      },
      error: /changed|SHA|identity/iu,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const filePath = path.join(tempRoot, "binary-race-" + item.name.replaceAll(" ", "-") + ".xlsx");
      await fs.writeFile(filePath, "initial-bytes", { flag: "wx" });
      await assert.rejects(
        () => primitives.readStableBinaryFile(filePath, {
          maxBytes: 1024,
          testHooks: {
            afterOpen: async ({ phase }) => {
              if (phase === "initial") await item.mutate(filePath);
            },
          },
        }),
        item.error,
      );
      const renamed = filePath + ".released";
      await fs.rename(filePath, renamed);
      await fs.unlink(renamed);
    });
  }
});

test("audit request digest excludes only requestDigest and binds nonce, certificate, profile order, paths, and SHAs", async () => {
  const scenario = await makeScenario(["xiaohongshu", "company", "residence"]);
  const profiles = scenario.artifacts.map((artifact) => ({
    profileId: artifact.profileId,
    baselinePath: artifact.baselinePath,
    baselineSha256: artifact.baselineSha256,
    candidatePath: candidatePathFor(scenario.stagingRoot, artifact.profileId),
    candidateSha256: "a".repeat(64),
  }));
  const body = {
    kind: builder.ROOT_WORKBOOK_AUDIT_REQUEST_KIND,
    requestNonce: "b".repeat(64),
    reimbursementFactsCertificate: scenario.certificate,
    profiles,
    requestDigest: "0".repeat(64),
  };
  const digest = builder.computeRootWorkbookAuditRequestDigest(body);
  assert.equal(digest, canonicalDigest({
    kind: body.kind,
    requestNonce: body.requestNonce,
    reimbursementFactsCertificate: body.reimbursementFactsCertificate,
    profiles: body.profiles,
  }));
  for (const [field, replacement] of [
    ["requestNonce", "c".repeat(64)],
    ["reimbursementFactsCertificate", { ...body.reimbursementFactsCertificate, manifestDigest: "x".repeat(64) }],
    ["profiles", profiles.map((profile, index) => index === 0 ? { ...profile, profileId: "company" } : profile)],
    ["profiles", profiles.map((profile, index) => index === 0 ? { ...profile, baselinePath: profile.baselinePath + ".other" } : profile)],
    ["profiles", profiles.map((profile, index) => index === 0 ? { ...profile, candidateSha256: "d".repeat(64) } : profile)],
  ]) {
    const mutated = { ...body, [field]: replacement };
    assert.notEqual(builder.computeRootWorkbookAuditRequestDigest(mutated), digest);
  }
  assert.equal(
    builder.computeRootWorkbookAuditRequestDigest({ ...body, requestDigest: "e".repeat(64) }),
    digest,
  );
});

test("request validation fixes the lower-hex staging token and rejects pre-created directories", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  for (const token of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(64) + "-",
  ]) {
    const request = { ...scenario.request, stagingToken: token };
    await assert.rejects(
      () => builder.buildRootWorkbookCandidates(request),
      /stagingToken|lowercase|hex|length/iu,
    );
  }

  const precreated = stagingRootFor(nextToken());
  await fs.mkdir(precreated, { recursive: false });
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates({ ...scenario.request, stagingToken: path.basename(precreated).slice(STAGING_PREFIX.length) }),
    /already exists|exclusive|owned|staging/iu,
  );
  assert.equal(await pathExists(path.join(precreated, ".codex-xhs-owner.json")), false);
});

test("request rejects self-reported rows, paths, allowlists, authorization, and certificate tampering before staging", async (t) => {
  const cases = [
    ["actualRows", (request) => { request.actualRows = []; }, /actualRows|unknown.*field|self-reported/iu],
    ["actualMerges", (request) => { request.actualMerges = []; }, /actualMerges|unknown.*field|self-reported/iu],
    ["expected", (request) => { request.expected = { rows: [] }; }, /expected|unknown.*field|allowlist/iu],
    ["allowlist", (request) => { request.allowlist = []; }, /allowlist|unknown.*field/iu],
    ["candidatePath", (request) => { request.candidatePath = "caller-candidate.xlsx"; }, /candidatePath|unknown.*field|caller.*path/iu],
    ["planPath", (request) => { request.planPath = "caller-plan.json"; }, /planPath|unknown.*field|caller.*path/iu],
    ["stagingRoot", (request) => { request.stagingRoot = os.tmpdir(); }, /stagingRoot|unknown.*field|caller.*path/iu],
    ["approved", (request) => { request.approved = true; }, /approved|authorization|unknown.*field/iu],
    ["gate1Authorized", (request) => { request.gate1Authorized = true; }, /gate1Authorized|authorization|unknown.*field/iu],
    ["certificateDigest", (request) => {
      request.reimbursementFactsCertificate.certificateDigest = "f".repeat(64);
    }, /certificateDigest|certificate.*digest/iu],
    ["profileConfigDigest", (request) => {
      request.reimbursementFactsCertificate.profileConfigDigest = "f".repeat(64);
    }, /profileConfigDigest|profile.*config.*digest/iu],
  ];
  for (const [name, mutate, error] of cases) {
    await t.test(name, async () => {
      const scenario = await makeScenario(["xiaohongshu"]);
      const request = structuredClone(scenario.request);
      mutate(request);
      await assert.rejects(() => builder.buildRootWorkbookCandidates(request), error);
      assert.equal(await pathExists(scenario.stagingRoot), false, "invalid request must not create staging");
      await assertNoCommittedOutputs(scenario);
    });
  }
});

test("parent code path never loads auditor; only the fixed audit-worker branch may dynamically import it", async () => {
  const source = await fs.readFile(BUILDER_SCRIPT, "utf8");
  assert.doesNotMatch(source, /^\s*import\s+.*audit_ledger_layout\.mjs/mu);
  assert.equal([...source.matchAll(/import\(["']\.\/audit_ledger_layout\.mjs["']\)/gu)].length, 1);
  assert.match(source, /--audit-worker/u);

  const loaderPath = await writeText("parent-auditor-guard-loader.mjs", [
    "export async function resolve(specifier, context, nextResolve) {",
    "  const result = await nextResolve(specifier, context);",
    "  if (result.url.endsWith('/audit_ledger_layout.mjs') && process.env.ROOT_BUILDER_PARENT_PID === String(process.pid)) {",
    "    throw new Error('AUDITOR_LOADED_IN_PARENT');",
    "  }",
    "  return result;",
    "}",
  ].join("\n"));
  const wrapperPath = await writeText("parent-auditor-guard-wrapper.mjs", [
    "import fs from 'node:fs/promises';",
    "import { pathToFileURL } from 'node:url';",
    "process.env.ROOT_BUILDER_PARENT_PID = String(process.pid);",
    "const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));",
    "const builder = await import(pathToFileURL(process.argv[3]).href);",
    "await builder.buildRootWorkbookCandidates(request);",
  ].join("\n"));
  const scenario = await makeScenario(["xiaohongshu"]);
  const requestPath = await writeJson("parent-auditor-request.json", scenario.request);
  const result = await runChild(process.execPath, [
    "--experimental-loader", pathToFileURL(loaderPath).href,
    wrapperPath, requestPath, BUILDER_SCRIPT,
  ], { env: { ...process.env } });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /AUDITOR_LOADED_IN_PARENT/u);
});

function expectedAuditBatch(scenario) {
  return {
    kind: builder.ROOT_WORKBOOK_AUDIT_BATCH_KIND,
    requestDigest: "1".repeat(64),
    requestFileSha256: "2".repeat(64),
    requestNonce: "3".repeat(64),
    audits: scenario.profileIds.map((profileId) => syntheticAudit(
      profileId,
      scenario.certificate,
      scenario.baselines.get(profileId),
      { size: 1234, sha256: "4".repeat(64) },
    )),
  };
}

test("worker response contains complete one-to-one frozen audit objects in registry order", async () => {
  const scenario = await makeScenario(["xiaohongshu", "company", "residence"]);
  const response = expectedAuditBatch(scenario);
  const checked = builder.validateRootWorkbookAuditBatch(response, {
    requestDigest: response.requestDigest,
    requestFileSha256: response.requestFileSha256,
    requestNonce: response.requestNonce,
    profileIds: ["xiaohongshu", "company", "residence"],
    certificate: scenario.certificate,
    profileBindings: profileBindingsForScenario(scenario),
  });
  assert.deepEqual(checked.audits.map((audit) => audit.profile.profileId), [
    "xiaohongshu",
    "company",
    "residence",
  ]);
  assert.equal(checked.audits.every((audit) => audit.kind === "root-workbook-business-audit-v1"), true);
  assert.equal(checked.audits.every((audit) => audit.requiresGate1Binding === true), true);
  assert.equal(checked.audits.every((audit) => Object.isFrozen(audit)), true);
});

test("worker response rejects string summaries, duplicate, missing, extra, or tampered audits", async (t) => {
  const scenario = await makeScenario(["xiaohongshu", "company"]);
  const base = expectedAuditBatch(scenario);
  const cases = [
    ["string summary", { ...base, audits: [JSON.stringify(base.audits[0]), base.audits[1]] }, /complete audit|object|summary/iu],
    ["duplicate profile", { ...base, audits: [base.audits[0], base.audits[0]] }, /duplicate|one-to-one|profile/iu],
    ["missing profile", { ...base, audits: [base.audits[0]] }, /missing|profile/iu],
    ["extra profile", { ...base, audits: [...base.audits, syntheticAudit("residence", scenario.certificate, scenario.baselines.get("company"), { size: 1, sha256: "f".repeat(64) })] }, /extra|profile/iu],
    ["out of registry order", { ...base, audits: [...base.audits].reverse() }, /order|registry|profile/iu],
    ["audit digest tamper", { ...base, audits: [{ ...base.audits[0], auditDigest: "0".repeat(64) }, base.audits[1]] }, /auditDigest|digest/iu],
    ["candidate SHA tamper", {
      ...base,
      audits: [resignAudit(base.audits[0], {
        candidate: { ...base.audits[0].candidate, sourceSha256: "f".repeat(64) },
      }), base.audits[1]],
    }, /candidate (?:source )?SHA|sourceSha256|candidate workbook SHA/iu],
  ];
  for (const [name, response, error] of cases) {
    await t.test(name, async () => {
      assert.throws(
        () => builder.validateRootWorkbookAuditBatch(response, {
          requestDigest: base.requestDigest,
          requestFileSha256: base.requestFileSha256,
          requestNonce: base.requestNonce,
          profileIds: scenario.profileIds,
          certificate: scenario.certificate,
          profileBindings: profileBindingsForScenario(scenario),
        }),
        error,
      );
    });
  }
});

test("audit batch rejects a self-consistent tampered candidate SHA against the parent profile binding", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  const base = expectedAuditBatch(scenario);
  const tamperedSha = "f".repeat(64);
  const response = {
    ...base,
    audits: [resignAudit(base.audits[0], {
      candidate: { ...base.audits[0].candidate, sourceSha256: tamperedSha },
    })],
  };
  assert.throws(
    () => builder.validateRootWorkbookAuditBatch(response, {
      requestDigest: base.requestDigest,
      requestFileSha256: base.requestFileSha256,
      requestNonce: base.requestNonce,
      profileIds: scenario.profileIds,
      certificate: scenario.certificate,
      profileBindings: profileBindingsForScenario(scenario),
    }),
    /candidate (?:source )?SHA|profile binding|sourceSha256/iu,
  );
});

test("one bounded worker handles one, two, or three profiles in registry order", async (t) => {
  for (const profileIds of [
    ["xiaohongshu"],
    ["xiaohongshu", "company"],
    ["xiaohongshu", "company", "residence"],
  ]) {
    await t.test(profileIds.length + " profile(s)", async () => {
      const scenario = await makeScenario(profileIds);
      let workerSpawns = 0;
      let peakWorkerAudits = 0;
      const result = await builder.buildRootWorkbookCandidates(scenario.request, {
        testHooks: {
          onWorkerSpawn() {
            workerSpawns += 1;
          },
          onWorkerAuditConcurrency({ peak }) {
            peakWorkerAudits = Math.max(peakWorkerAudits, peak);
          },
        },
      });
      assert.equal(result.kind, builder.ROOT_WORKBOOK_BUILD_RESULT_KIND);
      assert.equal(workerSpawns, 1);
      assert.ok(peakWorkerAudits >= 1 && peakWorkerAudits <= 3);
      assert.deepEqual(result.artifacts.map((artifact) => artifact.profileId), profileIds);
      assert.equal(result.artifacts.every((artifact) => artifact.audit.kind === "root-workbook-business-audit-v1"), true);
      assert.equal(result.artifacts.every((artifact) => typeof artifact.audit !== "string"), true);
    });
  }
});

test("worker timeout kills the exact descendant tree and waits for close", async () => {
  const pidPath = path.join(tempRoot, "timeout-descendant.pid");
  const workerPath = await writeText("timeout-worker.mjs", [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });",
    "fs.writeFileSync(" + JSON.stringify(pidPath) + ", String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const requestPath = await writeText("timeout-worker-request.json", "{}\n");
  await assert.rejects(
    () => builder.runRootWorkbookAuditWorker({
      requestPath,
      requestFileSha256: sha256Bytes("{}\n"),
      requestNonce: "a".repeat(64),
      workerScriptPath: workerPath,
      timeoutMs: 100,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    }),
    /timeout|timed out|worker.*close/iu,
  );
  const descendantPid = Number(await fs.readFile(pidPath, "utf8"));
  assert.equal(Number.isSafeInteger(descendantPid), true);
  assert.equal(await waitForPidExit(descendantPid), true, "descendant must be gone before rejection settles");
});

test("worker stdout and stderr overflow terminate the process without accepting partial evidence", async (t) => {
  for (const stream of ["stdout", "stderr"]) {
    await t.test(stream, async () => {
      const workerPath = await writeText("overflow-" + stream + ".mjs", [
        "const target = process." + stream + ";",
        "target.write('x'.repeat(4096));",
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const requestPath = await writeText("overflow-" + stream + "-request.json", "{}\n");
      await assert.rejects(
        () => builder.runRootWorkbookAuditWorker({
          requestPath,
          requestFileSha256: sha256Bytes("{}\n"),
          requestNonce: "b".repeat(64),
          workerScriptPath: workerPath,
          timeoutMs: 5_000,
          stdoutMaxBytes: 1024,
          stderrMaxBytes: 1024,
        }),
        new RegExp(stream + ".*(?:limit|exceed|bounded)|(?:limit|exceed|bounded).*" + stream, "iu"),
      );
    });
  }
});

test("worker request file replacement is rejected by parent SHA, nonce, and semantic digest binding", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  let replacedRequestPath;
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(scenario.request, {
      testHooks: {
        async afterWorkerRequestWritten({ requestPath, requestBody }) {
          replacedRequestPath = requestPath;
          const replacement = structuredClone(requestBody);
          replacement.requestNonce = "f".repeat(64);
          replacement.requestDigest = builder.computeRootWorkbookAuditRequestDigest(replacement);
          const swap = requestPath + ".replacement";
          await fs.writeFile(swap, JSON.stringify(replacement) + "\n", { encoding: "utf8", flag: "wx" });
          await fs.rename(swap, requestPath);
        },
      },
    }),
    /request.*(?:SHA|nonce|digest|binding|preserv|external)|audit request.*changed/iu,
  );
  await assertNoCommittedOutputs(scenario);
  assert.ok(replacedRequestPath);
  assert.equal(await pathExists(replacedRequestPath), true, "externally replaced request must be preserved");
  assert.equal((await stagingEntries(scenario)).includes(path.basename(replacedRequestPath)), true);
});

test("baseline binary and OOXML facts must match request SHA and size before any patch", async (t) => {
  for (const mutation of [
    { name: "SHA", apply(artifact) { artifact.baselineSha256 = "f".repeat(64); }, error: /baseline.*SHA|SHA.*baseline/iu },
    { name: "size", apply(artifact) { artifact.baselineSize += 1; }, error: /baseline.*size|size.*baseline/iu },
  ]) {
    await t.test(mutation.name, async () => {
      const scenario = await makeScenario(["xiaohongshu"]);
      mutation.apply(scenario.request.artifacts[0]);
      await assert.rejects(
        () => builder.buildRootWorkbookCandidates(scenario.request),
        mutation.error,
      );
      await assertNoCommittedOutputs(scenario);
      assert.deepEqual(await stagingEntries(scenario), []);
    });
  }
});

test("builder baseline races leave no candidate, plan, request, or temp output", async (t) => {
  const cases = [
    { name: "growth", mutate: (filePath) => fs.appendFile(filePath, "growth"), error: /grow|changed|bounded/iu },
    { name: "truncation", mutate: (filePath) => fs.truncate(filePath, 1), error: /trunc|changed/iu },
    {
      name: "replacement",
      async mutate(filePath) {
        const swap = filePath + ".swap";
        const bytes = await fs.readFile(filePath);
        await fs.writeFile(swap, bytes, { flag: "wx" });
        await fs.rename(swap, filePath);
      },
      error: process.platform === "win32"
        ? /replace|identity|changed|could not be read/iu
        : /replace|identity|changed/iu,
    },
    {
      name: "same-size rewrite",
      async mutate(filePath) {
        const bytes = await fs.readFile(filePath);
        bytes[bytes.length - 1] ^= 0x01;
        await fs.writeFile(filePath, bytes, { flag: "w" });
      },
      error: /changed|SHA|identity/iu,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const scenario = await makeScenario(["xiaohongshu"]);
      let mutated = false;
      await assert.rejects(
        () => builder.buildRootWorkbookCandidates(scenario.request, {
          testHooks: {
            stableBinary: {
              async afterOpen({ phase, role, filePath }) {
                if (!mutated && role === "baseline" && phase === "initial") {
                  mutated = true;
                  await item.mutate(filePath);
                }
              },
            },
          },
        }),
        item.error,
      );
      await assertNoCommittedOutputs(scenario);
      assert.deepEqual(await stagingEntries(scenario), []);
    });
  }
});

test("unaffected profiles and zero-profile batches create no staging output", async (t) => {
  await t.test("unaffected profile", async () => {
    const scenario = await makeScenario(["xiaohongshu"]);
    const residence = await makeScenario(["residence"]);
    scenario.request.artifacts.push(residence.request.artifacts[0]);
    await assert.rejects(
      () => builder.buildRootWorkbookCandidates(scenario.request),
      /affectedProfileIds|unaffected|profile set/iu,
    );
    await assertNoCommittedOutputs(scenario);
    assert.deepEqual(await stagingEntries(scenario), []);
  });
  await t.test("empty artifacts", async () => {
    const scenario = await makeScenario(["xiaohongshu"]);
    scenario.request.artifacts = [];
    await assert.rejects(
      () => builder.buildRootWorkbookCandidates(scenario.request),
      /artifacts.*(?:non-empty|affected)|no affected profile/iu,
    );
    await assertNoCommittedOutputs(scenario);
    assert.deepEqual(await stagingEntries(scenario), []);
  });
});

test("real OOXML candidates build for all canonical profiles with one complete independent audit each", async (t) => {
  for (const profileId of ["xiaohongshu", "company", "residence"]) {
    await t.test(profileId, async () => {
      const scenario = await makeScenario([profileId]);
      const result = await builder.buildRootWorkbookCandidates(scenario.request);
      assert.equal(result.kind, builder.ROOT_WORKBOOK_BUILD_RESULT_KIND);
      assert.equal(result.artifacts.length, 1);
      const artifact = result.artifacts[0];
      assert.equal(artifact.profileId, profileId);
      assert.equal(artifact.audit.kind, "root-workbook-business-audit-v1");
      assert.equal(artifact.audit.requiresGate1Binding, true);
      assert.equal(artifact.audit.profile.profileId, profileId);
      assert.match(artifact.audit.transitionDigest, /^[0-9a-f]{64}$/u);
      assert.equal(await pathExists(artifact.candidatePath), true);
      assert.equal(await pathExists(artifact.planPath), true);

      const candidateFacts = await factsFor(artifact.candidatePath);
      const sheet = managedWorksheet(candidateFacts, profileId);
      assert.equal(sheet.name, registry.profiles[profileId].managedRootSheetName);
      assert.equal(cellAt(sheet, "B3").value.text, "新增项目-" + profileId);
      assert.equal(cellAt(sheet, "C3").numberFormat.formatCode, "0.000");
      assert.equal(cellAt(sheet, "D3").formula.text, "SUM(C3:C3)");
      const printArea = candidateFacts.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area");
      const printTitles = candidateFacts.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Titles");
      assert.equal(printArea.text, "'" + registry.profiles[profileId].managedRootSheetName + "'!$A$1:$F$3");
      assert.equal(printTitles.text, "'" + registry.profiles[profileId].managedRootSheetName + "'!$1:$1");
    });
  }
});

test("business projection uses manifest sourceOrder for same-day new rows and preserves baseline physical order", async () => {
  const first = defaultTransaction("xiaohongshu", 1, {
    id: "TX-XHS-01",
    date: "2026-08-02",
    project: "按序第一笔",
    amount: "1",
  });
  const second = defaultTransaction("xiaohongshu", 2, {
    id: "TX-XHS-02",
    date: "2026-08-02",
    project: "按序第二笔",
    amount: "2",
  });
  const scenario = await makeScenario(["xiaohongshu"], {
    transactions: [second, first],
    baselineRecords: {
      xiaohongshu: [defaultBaselineRecord("xiaohongshu", {
        date: "2026-08-02",
        project: "实际基线行",
      })],
    },
  });
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const sheet = managedWorksheet(await factsFor(result.artifacts[0].candidatePath), "xiaohongshu");
  assert.equal(cellAt(sheet, "B2").value.text, "实际基线行");
  assert.equal(cellAt(sheet, "B3").value.text, "按序第一笔");
  assert.equal(cellAt(sheet, "B4").value.text, "按序第二笔");
});

test("a cross-date baseline D/E/F atomic group cannot be split by an inserted manifest row", async () => {
  const scenario = await makeScenario(["xiaohongshu"], {
    baselineRecords: {
      xiaohongshu: [
        defaultBaselineRecord("xiaohongshu", { date: "2026-08-01", group: "cross-date-baseline" }),
        defaultBaselineRecord("xiaohongshu", { date: "2026-08-03", group: "cross-date-baseline" }),
      ],
    },
    transactions: [defaultTransaction("xiaohongshu", 1, { date: "2026-08-02" })],
  });
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(scenario.request),
    /cross[- ]date|atomic|group.*split|split.*group|manual/iu,
  );
  await assertNoCommittedOutputs(scenario);
});

test("same visible fields with different settlement remain separate D/E/F groups", async () => {
  const common = {
    date: "2026-08-02",
    person: "同一人员",
    classification: "同一分类",
  };
  const reimbursed = defaultTransaction("xiaohongshu", 1, {
    ...common,
    id: "TX-XHS-SETTLED-01",
    project: "报销记录",
    amount: "1",
    settlement: "employee_reimbursement",
  });
  const companyPaid = defaultTransaction("xiaohongshu", 2, {
    ...common,
    id: "TX-XHS-SETTLED-02",
    project: "公司支付记录",
    amount: "2",
    settlement: "company_paid_no_reimbursement",
  });
  const scenario = await makeScenario(["xiaohongshu"], { transactions: [reimbursed, companyPaid] });
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const sheet = managedWorksheet(await factsFor(result.artifacts[0].candidatePath), "xiaohongshu");
  assert.equal(cellAt(sheet, "D3").formula.text, "SUM(C3:C3)");
  assert.equal(cellAt(sheet, "D4").formula.text, "SUM(C4:C4)");
  assert.equal(sheet.merges.some((merge) => merge.ref === "D3:D4"), false);
});

test("residence filename alias is input-only and the managed sheet/output identity remains canonical", async () => {
  const scenario = await makeScenario(["residence"], { residenceAlias: true });
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const artifact = result.artifacts[0];
  assert.equal(path.basename(scenario.artifacts[0].baselinePath), "住所支出.xlsx");
  assert.equal(path.basename(artifact.candidatePath), "驻所支出_修正版1.xlsx");
  assert.equal(managedWorksheet(await factsFor(artifact.candidatePath), "residence").name, "驻所支出");

  const invalid = await makeScenario(["residence"], { residenceAlias: true });
  const aliasProfile = { ...registry.profiles.residence, managedRootSheetName: "住所支出" };
  const replacement = await writeWorkbook(
    path.dirname(invalid.artifacts[0].baselinePath),
    "alias-sheet.xlsx",
    aliasProfile,
    [defaultBaselineRecord("residence")],
  );
  await fs.unlink(invalid.artifacts[0].baselinePath);
  await fs.rename(replacement.filePath, invalid.artifacts[0].baselinePath);
  const bytes = await fs.readFile(invalid.artifacts[0].baselinePath);
  invalid.artifacts[0].baselineSize = bytes.length;
  invalid.artifacts[0].baselineSha256 = sha256Bytes(bytes);
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(invalid.request),
    /canonical.*驻所支出|managed sheet|住所.*alias/iu,
  );
  await assertNoCommittedOutputs(invalid);
});

test("company unmanaged sheets, shared resources, styles, relationships, and print settings remain preserved", async () => {
  const scenario = await makeScenario(["company"]);
  const baselineFacts = await factsFor(scenario.baselines.get("company").filePath);
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const candidateFacts = await factsFor(result.artifacts[0].candidatePath);
  assert.deepEqual(candidateFacts.styles, baselineFacts.styles);
  assert.deepEqual(candidateFacts.sharedStrings, baselineFacts.sharedStrings);
  const managedPart = baselineFacts.workbook.sheets.find((sheet) => sheet.name === "公司支出").partName;
  const baselineUnmanaged = baselineFacts.worksheets.filter((sheet) => sheet.partName !== managedPart);
  const candidateUnmanaged = candidateFacts.worksheets.filter((sheet) => sheet.partName !== managedPart);
  assert.deepEqual(candidateUnmanaged, baselineUnmanaged);
  assert.deepEqual(
    candidateFacts.package.relationships.map(({ id, ...item }) => item),
    baselineFacts.package.relationships.map(({ id, ...item }) => item),
  );
});

test("milliunits, refunds, formula text, merge topology, styles, and print area are mechanically correct", async () => {
  const source = defaultTransaction("xiaohongshu", 1, {
    id: "TX-XHS-SOURCE",
    amount: "1000000000000.999",
    date: "2026-08-03",
    person: "同组人员",
    classification: "同组分类",
  });
  const refund = defaultTransaction("xiaohongshu", 2, {
    id: "TX-XHS-REFUND",
    amount: "-0.125",
    date: "2026-08-03",
    person: "同组人员",
    classification: "同组分类",
    adjustment: { type: "refund", sourceTransactionId: source.id, reason: "原交易退款" },
  });
  const scenario = await makeScenario(["xiaohongshu"], { transactions: [source, refund] });
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const facts = await factsFor(result.artifacts[0].candidatePath);
  const sheet = managedWorksheet(facts, "xiaohongshu");
  assert.equal(cellAt(sheet, "C3").value.raw, "1000000000000.999");
  assert.equal(cellAt(sheet, "C4").value.raw, "-0.125");
  assert.equal(cellAt(sheet, "C3").numberFormat.formatCode, "0.000");
  assert.equal(cellAt(sheet, "C4").numberFormat.formatCode, "0.000");
  assert.equal(cellAt(sheet, "D3").formula.text, "SUM(C3:C4)");
  assert.equal(cellAt(sheet, "D3").numberFormat.formatCode, "0.000");
  assert.equal(cellAt(sheet, "D4"), undefined);
  assert.deepEqual(sheet.merges.map((merge) => merge.ref), ["A3:A4", "D3:D4", "E3:E4", "F3:F4"]);
  assert.equal(cellAt(sheet, "A4"), undefined);
  assert.equal(cellAt(sheet, "E4"), undefined);
  assert.equal(cellAt(sheet, "F4"), undefined);
  const printArea = facts.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Area");
  const printTitles = facts.workbook.definedNames.find((item) => item.name === "_xlnm.Print_Titles");
  assert.equal(printArea.text, "'Sheet1'!$A$1:$F$4");
  assert.equal(printTitles.text, "'Sheet1'!$1:$1");
  assert.ok(facts.worksheets[0].dimensionRef === null || facts.worksheets[0].dimensionRef === "A1:F4");
});

test("ambiguous role styleIndex or material row presentation fails closed before output", async () => {
  const scenario = await makeScenario(["xiaohongshu"], {
    baselineRecords: {
      xiaohongshu: [
        defaultBaselineRecord("xiaohongshu", {
          date: "2026-07-30",
          project: "样式甲",
          group: "baseline-a",
          bStyle: 2,
          rowHeight: "22",
        }),
        defaultBaselineRecord("xiaohongshu", {
          date: "2026-08-01",
          project: "样式乙",
          group: "baseline-b",
          bStyle: 5,
          rowHeight: "23",
        }),
      ],
    },
  });
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(scenario.request),
    /ambiguous|unique.*role|styleIndex|row.*(?:height|presentation)/iu,
  );
  await assertNoCommittedOutputs(scenario);
});

function containsAuthorizationKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)(?:gate|approval|approved|authorization|authorized)(?:_|$)/iu.test(key)) return true;
    if (containsAuthorizationKey(child, seen)) return true;
  }
  return false;
}

test("plan is committed only after final stable reread and embeds the complete independent audit", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  const result = await builder.buildRootWorkbookCandidates(scenario.request);
  const artifact = result.artifacts[0];
  const planSnapshot = await readStableUtf8JsonFile(artifact.planPath, { maxBytes: 16 * 1024 * 1024 });
  const plan = planSnapshot.value;
  assert.equal(plan.kind, "root-workbook-build-plan-v1");
  assert.equal(plan.requiresGate1Binding, true);
  assert.equal(typeof plan.audit, "object");
  assert.equal(Array.isArray(plan.audit), false);
  assert.equal(plan.audit.kind, "root-workbook-business-audit-v1");
  const auditBody = structuredClone(plan.audit);
  delete auditBody.auditDigest;
  assert.equal(plan.audit.auditDigest, canonicalDigest(auditBody));
  assert.equal(plan.audit.candidate.sourceSha256, plan.candidate.sha256);
  assert.equal(plan.audit.candidate.sourceSize, plan.candidate.size);
  assert.equal(plan.audit.candidate.factsDigest, plan.candidate.factsDigest);
  assert.equal(plan.audit.transitionDigest, plan.transitionDigest);
  assert.equal(plan.manifest.certificateDigest, scenario.certificate.certificateDigest);
  assert.equal(plan.manifest.factsDigest, scenario.certificate.factsDigest);
  assert.equal(plan.manifest.sourceCoverageDigest, scenario.certificate.sourceCoverageDigest);
  assert.equal(plan.manifest.profileConfigDigest, scenario.certificate.profileConfigDigest);
  assert.equal(plan.stagingOwnership.token, scenario.stagingToken);
  assert.match(plan.stagingOwnership.ownerMarkerSha256, /^[0-9a-f]{64}$/u);
  assert.equal(containsAuthorizationKey(plan), false);

  const finalSnapshot = await readStableFileSnapshot(artifact.candidatePath);
  const finalFacts = await readWorkbookOoxmlFacts(finalSnapshot);
  assert.equal(finalSnapshot.sha256, plan.candidate.sha256);
  assert.equal(finalSnapshot.size, plan.candidate.size);
  assert.equal(finalFacts.factsDigest, plan.candidate.factsDigest);
});

test("tampered full audit body or digest prevents all final candidate and plan commits", async (t) => {
  for (const mutation of [
    {
      name: "audit digest",
      apply(response) { response.audits[0].auditDigest = "0".repeat(64); },
      error: /auditDigest|digest/iu,
    },
    {
      name: "candidate SHA",
      apply(response) { response.audits[0].candidate.sourceSha256 = "f".repeat(64); },
      error: /candidate.*SHA|SHA.*candidate/iu,
    },
  ]) {
    await t.test(mutation.name, async () => {
      const scenario = await makeScenario(["xiaohongshu"]);
      await assert.rejects(
        () => builder.buildRootWorkbookCandidates(scenario.request, {
          testHooks: {
            afterAuditWorkerResponse(response) {
              mutation.apply(response);
              if (mutation.name !== "audit digest") {
                const body = structuredClone(response.audits[0]);
                delete body.auditDigest;
                response.audits[0].auditDigest = canonicalDigest(body);
              }
            },
          },
        }),
        mutation.error,
      );
      await assertNoCommittedOutputs(scenario);
    });
  }
});

test("every owned file kind is inventoried and cleaned only while its current SHA still matches", async (t) => {
  for (const ownedKind of OWNED_FILE_KINDS) {
    await t.test(ownedKind, async () => {
      const scenario = await makeScenario(["xiaohongshu"]);
      const seen = [];
      await assert.rejects(
        () => builder.buildRootWorkbookCandidates(scenario.request, {
          testHooks: {
            afterOwnedFileCreated(entry) {
              seen.push({ ...entry });
              if (entry.kind === ownedKind) throw new Error("injected owned-file failure " + ownedKind);
            },
          },
        }),
        new RegExp("injected owned-file failure " + ownedKind.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      );
      assert.equal(seen.some((entry) => entry.kind === ownedKind), true);
      assert.equal(seen.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)), true);
      assert.deepEqual(await stagingEntries(scenario), []);
    });
  }
});

test("batch cleanup removes matching owned files but preserves and reports an externally rewritten file", async () => {
  const scenario = await makeScenario(["xiaohongshu", "company"]);
  let rewrittenPath;
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(scenario.request, {
      testHooks: {
        async afterOwnedFileCreated(entry) {
          if (entry.kind === "final-candidate" && entry.profileId === "xiaohongshu") {
            rewrittenPath = entry.path;
            const bytes = await fs.readFile(entry.path);
            bytes[bytes.length - 1] ^= 0x01;
            await fs.writeFile(entry.path, bytes, { flag: "w" });
          }
          if (entry.kind === "final-candidate" && entry.profileId === "company") {
            throw new Error("injected second-profile commit failure");
          }
        },
      },
    }),
    /external|preserv|changed/iu,
  );
  assert.ok(rewrittenPath);
  assert.equal(await pathExists(rewrittenPath), true, "externally rewritten file must be preserved");
  const companyPaths = outputPaths(scenario, "company");
  assert.equal(await pathExists(companyPaths.candidatePath), false, "matching owned company candidate must be removed");
  assert.equal(await pathExists(companyPaths.planPath), false);
});

test("an existing final path is never overwritten or adopted", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  const paths = outputPaths(scenario, "xiaohongshu");
  const externalBytes = Buffer.from("external-preexisting-final", "utf8");
  await assert.rejects(
    () => builder.buildRootWorkbookCandidates(scenario.request, {
      testHooks: {
        async afterStagingCreated() {
          await fs.writeFile(paths.candidatePath, externalBytes, { flag: "wx" });
        },
      },
    }),
    /already exists|exclusive|must not overwrite|external/iu,
  );
  assert.deepEqual(await fs.readFile(paths.candidatePath), externalBytes);
  assert.equal(await pathExists(paths.planPath), false);
});

test("worker success wire format is one strict JSON line with bounded complete audits", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  const profile = registry.profiles.xiaohongshu;
  const candidatePath = candidatePathFor(scenario.stagingRoot, "xiaohongshu");
  const transaction = scenario.certificate.factsPreimage.transactions[0];
  const candidate = await writeWorkbook(
    scenario.stagingRoot,
    path.basename(candidatePath),
    profile,
    [defaultBaselineRecord("xiaohongshu"), transactionRecord(transaction)],
  );
  assert.equal(candidate.filePath, candidatePath);
  const requestBody = {
    kind: builder.ROOT_WORKBOOK_AUDIT_REQUEST_KIND,
    requestNonce: "c".repeat(64),
    reimbursementFactsCertificate: scenario.certificate,
    profiles: [{
      profileId: "xiaohongshu",
      baselinePath: scenario.artifacts[0].baselinePath,
      baselineSha256: scenario.artifacts[0].baselineSha256,
      candidatePath,
      candidateSha256: candidate.sha256,
    }],
  };
  requestBody.requestDigest = builder.computeRootWorkbookAuditRequestDigest(requestBody);
  const requestBytes = Buffer.from(JSON.stringify(requestBody) + "\n", "utf8");
  const requestPath = path.join(tempRoot, "worker-wire-request.json");
  await fs.writeFile(requestPath, requestBytes, { flag: "wx" });
  const response = await builder.runRootWorkbookAuditWorker({
    requestPath,
    requestFileSha256: sha256Bytes(requestBytes),
    requestNonce: requestBody.requestNonce,
    timeoutMs: 30_000,
    stdoutMaxBytes: 8 * 1024 * 1024,
    stderrMaxBytes: 1024 * 1024,
  });
  assert.equal(response.rawStdout.split(/\r?\n/u).filter(Boolean).length, 1);
  const decoded = parseStrictJson(response.rawStdout.trim());
  assert.equal(decoded.kind, builder.ROOT_WORKBOOK_AUDIT_BATCH_KIND);
  assert.equal(decoded.requestDigest, requestBody.requestDigest);
  assert.equal(decoded.requestFileSha256, sha256Bytes(requestBytes));
  assert.equal(decoded.requestNonce, requestBody.requestNonce);
  assert.equal(Array.isArray(decoded.audits), true);
  assert.equal(typeof decoded.audits[0], "object");
  assert.equal(decoded.audits[0].candidate.sourceSha256, candidate.sha256);
});

test("production audit worker rejects a nonexistent candidate even when its path and SHA are well formed", async () => {
  const scenario = await makeScenario(["xiaohongshu"]);
  const requestBody = {
    kind: builder.ROOT_WORKBOOK_AUDIT_REQUEST_KIND,
    requestNonce: "d".repeat(64),
    reimbursementFactsCertificate: scenario.certificate,
    profiles: [{
      profileId: "xiaohongshu",
      baselinePath: scenario.artifacts[0].baselinePath,
      baselineSha256: scenario.artifacts[0].baselineSha256,
      candidatePath: path.join(tempRoot, "missing-candidate.xlsx"),
      candidateSha256: "e".repeat(64),
    }],
  };
  requestBody.requestDigest = builder.computeRootWorkbookAuditRequestDigest(requestBody);
  const requestBytes = Buffer.from(JSON.stringify(requestBody) + "\n", "utf8");
  const requestPath = path.join(tempRoot, "worker-missing-candidate-request.json");
  await fs.writeFile(requestPath, requestBytes, { flag: "wx" });
  await assert.rejects(
    () => builder.runRootWorkbookAuditWorker({
      requestPath,
      requestFileSha256: sha256Bytes(requestBytes),
      requestNonce: requestBody.requestNonce,
      timeoutMs: 30_000,
      stdoutMaxBytes: 8 * 1024 * 1024,
      stderrMaxBytes: 1024 * 1024,
    }),
    /candidate.*(?:missing|ENOENT|not found)|missing.*candidate/iu,
  );
});
