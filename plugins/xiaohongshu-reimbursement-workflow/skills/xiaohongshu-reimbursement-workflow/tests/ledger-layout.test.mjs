import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalDigest, loadBundledDependency } from "../scripts/workflow_primitives.mjs";
import { loadProfileRegistry, formatMilliunits, parseMilliunits } from "../scripts/finance_domain.mjs";
import { auditLedgerLayout } from "../scripts/audit_ledger_layout.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_DOCUMENT_REL = DOCUMENT_REL_NS + "/officeDocument";
const WORKSHEET_REL = DOCUMENT_REL_NS + "/worksheet";
const STYLES_REL = DOCUMENT_REL_NS + "/styles";
const auditScript = fileURLToPath(new URL("../scripts/audit_ledger_layout.mjs", import.meta.url));

let tempRoot;
let registry;

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
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round(utc / 86_400_000) + 25_569;
}

function amount(value) {
  return parseMilliunits(value, "fixture amount", { allowNegative: true });
}

function sumAmounts(records) {
  return records.reduce((total, record) => total + amount(record.amount), 0n);
}

function cellString(ref, style, value) {
  return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t>'
    + escapeXml(value) + "</t></is></c>";
}

function cellNumber(ref, style, value) {
  return '<c r="' + ref + '" s="' + style + '" t="n"><v>' + escapeXml(value) + "</v></c>";
}

function cellFormula(ref, style, formula, cached) {
  return '<c r="' + ref + '" s="' + style + '" t="n"><f>'
    + escapeXml(formula) + "</f>" + (cached === null ? "" : "<v>" + escapeXml(cached) + "</v>") + "</c>";
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
  for (const item of dateRuns) {
    for (let index = item.start; index <= item.end; index += 1) dateByIndex.set(index, item);
  }
  for (const item of groupRuns) {
    for (let index = item.start; index <= item.end; index += 1) groupByIndex.set(index, item);
  }
  const rows = [];
  const headers = options.headers ?? ["日期", "支出明细", "支出金额", "合计", "支出人", "备注"];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const rowNumber = index + 2;
    const dateRun = dateByIndex.get(index);
    const groupRun = groupByIndex.get(index);
    let body = "";
    if (dateRun.start === index) {
      body += cellNumber("A" + rowNumber, record.aStyle ?? 1, record.dateSerial ?? serial(record.date));
    }
    body += cellString("B" + rowNumber, record.bStyle ?? 2, record.project);
    body += cellNumber("C" + rowNumber, record.cStyle ?? 3, record.amount);
    if (groupRun.start === index) {
      const startRow = groupRun.start + 2;
      const endRow = groupRun.end + 2;
      const total = formatMilliunits(sumAmounts(records.slice(groupRun.start, groupRun.end + 1)));
      const mode = record.groupMode ?? "formula";
      if (mode === "direct") {
        body += cellNumber("D" + rowNumber, record.dStyle ?? 4, record.dValue ?? total);
      } else if (mode !== "blank") {
        const formula = record.formula ?? ("SUM(C" + startRow + ":C" + endRow + ")");
        const cached = record.cache === false ? null : (record.dValue ?? total);
        body += cellFormula("D" + rowNumber, record.dStyle ?? 4, formula, cached);
      }
      body += cellString("E" + rowNumber, record.eStyle ?? 2, record.person);
      body += cellString("F" + rowNumber, record.fStyle ?? 2, record.classification);
    }
    if (options.followerResidue && index === options.followerResidue.rowIndex) {
      body += cellNumber("D" + rowNumber, 4, options.followerResidue.value);
    }
    if (options.extraCells && options.extraCells[rowNumber]) body += options.extraCells[rowNumber];
    rows.push('<row r="' + rowNumber + '">' + body + "</row>");
  }
  const merges = [];
  for (const item of dateRuns) {
    if (item.start !== item.end) merges.push("A" + (item.start + 2) + ":A" + (item.end + 2));
  }
  for (const item of groupRuns) {
    if (item.start !== item.end) {
      for (const column of ["D", "E", "F"]) {
        merges.push(column + (item.start + 2) + ":" + column + (item.end + 2));
      }
    }
  }
  if (options.mergeOverride) merges.splice(0, merges.length, ...options.mergeOverride);
  const mergeXml = merges.length === 0
    ? ""
    : '<mergeCells count="' + merges.length + '">' + merges.map((ref) => (
      '<mergeCell ref="' + ref + '"/>'
    )).join("") + "</mergeCells>";
  return xml(
    '<worksheet xmlns="' + MAIN_NS + '">'
      + '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<cols><col min="1" max="1" width="17.375" customWidth="1"/>'
      + '<col min="2" max="6" width="26.625" customWidth="1"/></cols>'
      + "<sheetData><row r=\"1\">"
      + cellString("A1", 2, headers[0])
      + cellString("B1", 2, headers[1])
      + cellString("C1", 2, headers[2])
      + cellString("D1", 2, headers[3])
      + cellString("E1", 2, headers[4])
      + cellString("F1", 2, headers[5])
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
    + items.map((item) => (
      '<Relationship Id="' + item.id + '" Type="' + item.type + '" Target="' + item.target + '"/>'
    )).join("") + "</Relationships>");
}

function stylesXml() {
  return xml(
    '<styleSheet xmlns="' + MAIN_NS + '">'
      + '<numFmts count="2"><numFmt numFmtId="200" formatCode="mm-dd"/>'
      + '<numFmt numFmtId="201" formatCode="0.000"/></numFmts>'
      + '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills>'
      + '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/>'
      + '</cellStyleXfs><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="200"/>'
      + '<xf numFmtId="0"/><xf numFmtId="201"/><xf numFmtId="201"/>'
      + '<xf numFmtId="2"/></cellXfs><cellStyles count="1">'
      + '<cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>',
  );
}

function unmanagedSheetXml(name, changed) {
  return xml(
    '<worksheet xmlns="' + MAIN_NS + '"><sheetData><row r="1">'
      + cellString("A1", 2, changed ? name + "-changed" : name) + "</row></sheetData></worksheet>",
  );
}

function packageParts(managedXml, options = {}) {
  const sheetName = options.sheetName ?? "Sheet1";
  const unmanaged = options.unmanagedSheets ?? [];
  const sheets = [{ name: sheetName, part: "sheet1.xml", id: "rSheet1" }]
    .concat(unmanaged.map((name, index) => ({
      name,
      part: "sheet" + (index + 2) + ".xml",
      id: "rSheet" + (index + 2),
    })));
  const workbookSheets = sheets.map((sheet, index) => (
    '<sheet name="' + escapeXml(sheet.name) + '" sheetId="' + (index + 1)
      + '" r:id="' + sheet.id + '"/>'
  )).join("");
  const printEnd = (options.recordCount ?? 1) + 1;
  const workbook = xml(
    '<workbook xmlns="' + MAIN_NS + '" xmlns:r="' + DOCUMENT_REL_NS + '">'
      + (options.date1904 === true ? '<workbookPr date1904="1"/>' : "")
      + "<sheets>" + workbookSheets + "</sheets><definedNames>"
      + '<definedName name="_xlnm.Print_Area" localSheetId="0">'
      + "'" + sheetName.replaceAll("'", "''") + "'!$A$1:$F$" + printEnd + "</definedName>"
      + '<definedName name="_xlnm.Print_Titles" localSheetId="0">'
      + "'" + sheetName.replaceAll("'", "''") + "'!$1:$1</definedName>"
      + "</definedNames></workbook>",
  );
  const workbookRels = [
    { id: "rStyles", type: STYLES_REL, target: "styles.xml" },
    ...sheets.map((sheet) => ({ id: sheet.id, type: WORKSHEET_REL, target: "worksheets/" + sheet.part })),
  ];
  const contentOverrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map((sheet) => (
      '<Override PartName="/xl/worksheets/' + sheet.part
        + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    )),
  ].join("");
  const parts = {
    "[Content_Types].xml": xml(
      '<Types xmlns="' + CONTENT_TYPES_NS + '">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>' + contentOverrides + "</Types>",
    ),
    "_rels/.rels": relationships([{ id: "rWorkbook", type: OFFICE_DOCUMENT_REL, target: "/xl/workbook.xml" }]),
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": relationships(workbookRels),
    "xl/styles.xml": stylesXml(),
    "xl/worksheets/sheet1.xml": managedXml,
  };
  for (let index = 0; index < unmanaged.length; index += 1) {
    const name = unmanaged[index];
    parts["xl/worksheets/sheet" + (index + 2) + ".xml"] = unmanagedSheetXml(
      name,
      options.unmanagedChanged === true && index === 0,
    );
  }
  return parts;
}

async function writeWorkbook(name, records, options = {}) {
  const zip = new JSZip();
  const parts = packageParts(renderWorksheet(records, options), { ...options, recordCount: records.length });
  for (const [partName, mutation] of Object.entries(options.partMutations ?? {})) {
    if (!Object.hasOwn(parts, partName)) throw new Error("Unknown fixture part mutation: " + partName);
    parts[partName] = typeof mutation === "function" ? mutation(parts[partName]) : mutation;
  }
  for (const [partName, content] of Object.entries(parts)) {
    zip.file(partName, content, { createFolders: false });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { filePath, sha256: sha256(bytes) };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifestTransactions() {
  return [
    { id: "TX-XHS", date: "2032-04-17", person: "新甲", project: "小红书新增", label: "新甲",
      amount: "20.25", category: "小红书报销", profileId: "xiaohongshu", classification: "新组",
      sourceOrder: 10, settlement: "employee_reimbursement" },
    { id: "TX-COMPANY", date: "2032-04-17", person: "新乙", project: "公司新增", label: "新乙",
      amount: "30", category: "公司报销", profileId: "company", classification: "公司组",
      sourceOrder: 20, settlement: "company_paid_no_reimbursement" },
    { id: "TX-RESIDENCE", date: "2032-04-17", person: "新丙", project: "驻所新增", label: "新丙",
      amount: "1.625", category: "驻所报销", profileId: "residence", classification: "驻所组",
      sourceOrder: 30, settlement: "employee_reimbursement" },
  ];
}

function makeFactsCertificate(transactions = manifestTransactions()) {
  const sorted = [...transactions].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const targetCategory = registry.profiles.xiaohongshu.targetCategory;
  const categoryTotals = new Map();
  const realTotals = new Map();
  for (const transaction of sorted) {
    const value = amount(transaction.amount);
    categoryTotals.set(transaction.category, (categoryTotals.get(transaction.category) ?? 0n) + value);
    if (transaction.settlement === "employee_reimbursement") {
      realTotals.set(transaction.category, (realTotals.get(transaction.category) ?? 0n) + value);
    }
  }
  const factsTransactions = sorted.map((transaction) => ({ ...transaction }));
  const factsPreimage = {
    batchId: "batch-auditor-test",
    targetCategory,
    transactions: factsTransactions,
    expectedTotals: {
      feeTotal: formatMilliunits(categoryTotals.get(targetCategory) ?? 0n),
      realTotal: formatMilliunits(realTotals.get(targetCategory) ?? 0n),
      categoryTotals: Object.fromEntries(
        [...categoryTotals].sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, value]) => [key, formatMilliunits(value)]),
      ),
    },
    affectedProfileIds: registry.profileOrder.filter((profileId) =>
      factsTransactions.some((transaction) => transaction.profileId === profileId),
    ),
    profileConfigDigest: registry.profileConfigDigest,
  };
  const sourceCoveragePreimage = {
    sourceScopes: sorted.map((transaction) => ({
      id: "SCOPE-" + transaction.id,
      fileId: "FILE-" + transaction.id,
      fileSha256: sha256(Buffer.from("file-" + transaction.id, "utf8")),
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

function resignCertificate(certificate, { facts = true, sourceCoverage = true } = {}) {
  if (facts) certificate.factsDigest = canonicalDigest(certificate.factsPreimage);
  if (sourceCoverage) {
    certificate.sourceCoverageDigest = canonicalDigest(certificate.sourceCoveragePreimage);
  }
  const body = clone(certificate);
  delete body.certificateDigest;
  certificate.certificateDigest = canonicalDigest(body);
  return certificate;
}

function bindTransactionsToSharedSource(certificate) {
  certificate.sourceCoveragePreimage = {
    sourceScopes: [{
      id: "SCOPE-SHARED",
      fileId: "FILE-SHARED",
      fileSha256: sha256(Buffer.from("shared-source", "utf8")),
      locator: "shared-region",
      terminalConfirmed: true,
      expectedUnitCount: 1,
    }],
    sourceUnits: [{
      id: "UNIT-SHARED",
      scopeId: "SCOPE-SHARED",
      locator: "shared-unit",
      disposition: "used",
    }],
    transactionSourceRefs: certificate.factsPreimage.transactions.map((transaction) => ({
      transactionId: transaction.id,
      sourceRefs: ["UNIT-SHARED"],
    })),
  };
  return resignCertificate(certificate, { facts: false });
}

function makeInput(profileId, certificate, baselineSha256, candidateSha256) {
  return {
    kind: "root-workbook-business-audit-input-v2",
    profileId,
    baselineSha256,
    candidateSha256,
    reimbursementFactsCertificate: certificate,
  };
}

function baseRecord(profileId, options = {}) {
  return {
    date: options.date ?? "2032-04-16",
    project: options.project ?? "基线-" + profileId,
    amount: options.amount ?? "10",
    person: options.person ?? "基线人员",
    classification: options.classification ?? "基线组",
    group: options.group ?? "baseline-group",
    groupMode: options.groupMode ?? "direct",
  };
}

function transactionRecord(transaction, options = {}) {
  return {
    date: transaction.date,
    dateSerial: options.dateSerial ?? transaction.dateSerial,
    aStyle: options.aStyle ?? transaction.aStyle,
    project: transaction.project,
    amount: transaction.amount,
    person: transaction.person,
    classification: transaction.classification,
    group: options.group ?? ("manifest-" + transaction.id),
    groupMode: options.groupMode ?? "formula",
    cache: options.cache,
    formula: options.formula,
    dValue: options.dValue,
    cStyle: options.cStyle,
  };
}

async function pairFor(profileId, certificate = makeFactsCertificate(), candidateOptions = {}) {
  const profile = registry.profiles[profileId];
  const baselineRecords = candidateOptions.baselineRecords ?? [baseRecord(profileId, candidateOptions.baseline ?? {})];
  const selected = certificate.factsPreimage.transactions.filter((item) => item.profileId === profileId);
  const candidateRecords = candidateOptions.candidateRecords ?? baselineRecords.concat(
    selected.map((item) => transactionRecord(item, candidateOptions.transaction ?? {})),
  );
  const common = {
    sheetName: profile.managedRootSheetName,
    unmanagedSheets: profileId === "company" ? ["来源结算摘要", "核对说明"] : [],
  };
  const baseline = await writeWorkbook(profileId + "-" + crypto.randomUUID() + "-baseline.xlsx", baselineRecords, common);
  const candidate = await writeWorkbook(
    profileId + "-" + crypto.randomUUID() + "-candidate.xlsx",
    candidateRecords,
    { ...common, ...candidateOptions },
  );
  return {
    baseline,
    candidate,
    input: makeInput(profileId, certificate, baseline.sha256, candidate.sha256),
  };
}

async function explicitPair(profileId, certificate, baselineRecords, candidateRecords, options = {}) {
  const profile = registry.profiles[profileId];
  const common = {
    sheetName: profile.managedRootSheetName,
    unmanagedSheets: profileId === "company" ? ["来源结算摘要", "核对说明"] : [],
  };
  const baseline = await writeWorkbook(
    profileId + "-" + crypto.randomUUID() + "-explicit-baseline.xlsx",
    baselineRecords,
    { ...common, ...(options.baselineOptions ?? {}) },
  );
  const candidate = await writeWorkbook(
    profileId + "-" + crypto.randomUUID() + "-explicit-candidate.xlsx",
    candidateRecords,
    { ...common, ...(options.candidateOptions ?? {}) },
  );
  return {
    baseline,
    candidate,
    input: makeInput(profileId, certificate, baseline.sha256, candidate.sha256),
  };
}

async function runAudit(pair) {
  return auditLedgerLayout({
    input: pair.input,
    baselinePath: pair.baseline.filePath,
    candidatePath: pair.candidate.filePath,
  });
}

function clone(value) {
  return structuredClone(value);
}

function deepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => deepFrozen(child, seen));
}

async function runCli(pair, input = pair.input, name = "cli") {
  const inputPath = await writeJson(name + "-" + crypto.randomUUID() + ".json", input);
  return runCliWithInputPath(pair, inputPath);
}

async function writeJson(name, value) {
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx" });
  return filePath;
}

function runCliWithInputPath(pair, inputPath, extraArgs = []) {
  const child = spawnSync(
    process.execPath,
    [
      auditScript,
      "--input",
      inputPath,
      "--baseline",
      pair.baseline.filePath,
      "--candidate",
      pair.candidate.filePath,
      ...extraArgs,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const output = (child.stdout || child.stderr || "").trim().split(/\r?\n/u).at(-1) || "{}";
  return { ...child, payload: JSON.parse(output) };
}

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-root-audit-"));
  registry = await loadProfileRegistry();
});

test.after(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
});

test("ordinary auditor accepts one real candidate for each affected canonical profile", async () => {
  const certificate = makeFactsCertificate();
  for (const profileId of ["xiaohongshu", "company", "residence"]) {
    const result = await runAudit(await pairFor(profileId, certificate));
    assert.equal(result.kind, "root-workbook-business-audit-v1");
    assert.equal(result.profile.profileId, profileId);
    assert.equal(result.requiresGate1Binding, true);
    assert.equal(result.projection.manifestRecordCount, 1);
    assert.equal(result.projection.baselineRecordCount, 1);
    assert.equal(result.projection.transactionCount, 2);
    assert.match(result.auditDigest, /^[0-9a-f]{64}$/u);
  }
});

test("one certificate routes only selected profile facts and rejects an unaffected profile", async () => {
  const certificate = makeFactsCertificate(manifestTransactions().slice(0, 2));
  const result = await runAudit(await pairFor("company", certificate));
  assert.equal(result.profile.profileId, "company");
  await assert.rejects(
    async () => runAudit(await pairFor("residence", certificate)),
    /selected profile is not affected|must not generate an empty/iu,
  );
});

test("digest preimages are verified before any workbook business comparison", async (t) => {
  const pair = await pairFor("xiaohongshu");
  const cases = [
    {
      name: "facts transaction changed without digest",
      mutate: (certificate) => { certificate.factsPreimage.transactions[0].project = "伪造项目"; },
      error: /factsDigest.*preimage/iu,
    },
    {
      name: "facts digest changed without records",
      mutate: (certificate) => { certificate.factsDigest = "f".repeat(64); },
      error: /factsDigest.*preimage/iu,
    },
    {
      name: "source reference changed without digest",
      mutate: (certificate) => {
        certificate.sourceCoveragePreimage.transactionSourceRefs[0].sourceRefs = ["UNIT-MISSING"];
      },
      error: /sourceCoverageDigest.*preimage/iu,
    },
    {
      name: "duplicate source unit",
      mutate: (certificate) => {
        certificate.sourceCoveragePreimage.sourceUnits.push(
          clone(certificate.sourceCoveragePreimage.sourceUnits[0]),
        );
      },
      error: /source unit.*duplicate|sourceCoverageDigest.*preimage/iu,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const certificate = clone(makeFactsCertificate());
      item.mutate(certificate);
      const input = makeInput("xiaohongshu", certificate, pair.baseline.sha256, pair.candidate.sha256);
      await assert.rejects(
        () => auditLedgerLayout({ input, baselinePath: pair.baseline.filePath, candidatePath: pair.candidate.filePath }),
        item.error,
      );
    });
  }
});

test("baseline physical facts are the source of truth, not a forged expected record", async () => {
  const transaction = { ...manifestTransactions()[0], project: "伪造候选事实" };
  const certificate = makeFactsCertificate([transaction]);
  const profile = registry.profiles.xiaohongshu;
  const baseline = await writeWorkbook(
    "forged-baseline.xlsx",
    [baseRecord("xiaohongshu", { project: "真实基线事实" })],
    { sheetName: profile.managedRootSheetName },
  );
  const candidate = await writeWorkbook(
    "forged-candidate.xlsx",
    [transactionRecord(certificate.factsPreimage.transactions[0])],
    { sheetName: profile.managedRootSheetName },
  );
  const input = makeInput("xiaohongshu", certificate, baseline.sha256, candidate.sha256);
  await assert.rejects(
    () => auditLedgerLayout({ input, baselinePath: baseline.filePath, candidatePath: candidate.filePath }),
    /baseline.*physical|baseline.*record|missing.*baseline/iu,
  );
  const injected = clone(input);
  injected.expectedRecords = [{ origin: "baseline", project: "伪造候选事实" }];
  await assert.rejects(
    () => auditLedgerLayout({ input: injected, baselinePath: baseline.filePath, candidatePath: candidate.filePath }),
    /unknown.*expectedRecords|strict|input/iu,
  );
});

test("baseline same-date physical order is stable and cannot be caller-reordered", async () => {
  const certificate = makeFactsCertificate();
  const profile = registry.profiles.xiaohongshu;
  const baselineRecords = [
    baseRecord("xiaohongshu", { project: "基线甲", date: "2032-04-16", group: "g1" }),
    baseRecord("xiaohongshu", { project: "基线乙", date: "2032-04-16", group: "g2", person: "基线乙" }),
  ];
  const baseline = await writeWorkbook("order-baseline.xlsx", baselineRecords, {
    sheetName: profile.managedRootSheetName,
  });
  const tx = certificate.factsPreimage.transactions.find((item) => item.profileId === "xiaohongshu");
  const candidate = await writeWorkbook("order-candidate.xlsx", [
    baselineRecords[1],
    baselineRecords[0],
    transactionRecord(tx),
  ], { sheetName: profile.managedRootSheetName });
  const input = makeInput("xiaohongshu", certificate, baseline.sha256, candidate.sha256);
  await assert.rejects(
    () => auditLedgerLayout({ input, baselinePath: baseline.filePath, candidatePath: candidate.filePath }),
    /baseline.*order|physical.*order|stable projection/iu,
  );
});

test("baseline groups crossing an insertion date fail closed instead of being split", async () => {
  const certificate = makeFactsCertificate();
  const baselineRecords = [
    baseRecord("xiaohongshu", { date: "2032-04-16", project: "跨日甲", group: "cross", groupMode: "formula" }),
    baseRecord("xiaohongshu", { date: "2032-04-18", project: "跨日乙", group: "cross", groupMode: "formula" }),
  ];
  const baseline = await writeWorkbook("cross-date-baseline.xlsx", baselineRecords, {
    sheetName: registry.profiles.xiaohongshu.managedRootSheetName,
  });
  const tx = certificate.factsPreimage.transactions.find((item) => item.profileId === "xiaohongshu");
  const candidate = await writeWorkbook("cross-date-candidate.xlsx", [
    baselineRecords[0],
    transactionRecord(tx),
    baselineRecords[1],
  ], { sheetName: registry.profiles.xiaohongshu.managedRootSheetName });
  const input = makeInput("xiaohongshu", certificate, baseline.sha256, candidate.sha256);
  await assert.rejects(
    () => auditLedgerLayout({ input, baselinePath: baseline.filePath, candidatePath: candidate.filePath }),
    /baseline group.*cross|split.*group|atomic/iu,
  );
});

test("single-row direct baseline totals are preserved while new single rows use canonical SUM", async () => {
  const pair = await pairFor("xiaohongshu", makeFactsCertificate(), { transaction: { cache: false } });
  const result = await runAudit(pair);
  assert.equal(result.projection.formulaCachePolicy, "optional-consistency-check");
  await assert.rejects(
    async () => runAudit(await pairFor("xiaohongshu", makeFactsCertificate(), {
      transaction: { groupMode: "blank" },
    })),
    /single-row|D.*value|formula/iu,
  );
});

test("fixed approved 0.000 styles and OOXML formula text are enforced", async (t) => {
  await runAudit(await pairFor("xiaohongshu"));
  const cases = [
    { name: "non-approved number format", options: { transaction: { cStyle: 5 } }, error: /style|0\\.000|numberFormat/iu },
    { name: "leading equals", options: { transaction: { formula: "=SUM(C3:C3)" } }, error: /formula/iu },
    { name: "wrong range", options: { transaction: { formula: "SUM(C2:C3)" } }, error: /formula|range/iu },
    { name: "wrong cache", options: { transaction: { dValue: "999" } }, error: /cached|total/iu },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await assert.rejects(
        async () => runAudit(await pairFor("xiaohongshu", makeFactsCertificate(), item.options)),
        item.error,
      );
    });
  }
});

test("baseline and manifest records never cross-merge", async () => {
  const certificate = makeFactsCertificate([{
    ...manifestTransactions()[0],
    person: "基线人员",
    classification: "基线组",
    date: "2032-04-16",
  }]);
  await assert.rejects(
    async () => runAudit(await pairFor("xiaohongshu", certificate, {
      baseline: { date: "2032-04-16", groupMode: "formula" },
      transaction: { group: "baseline-group" },
    })),
    /cross.*group|baseline.*manifest|merge/iu,
  );
});

test("ordinary entry rejects legacy corrections and caller supplied facts", async () => {
  const pair = await pairFor("xiaohongshu");
  for (const field of [
    "corrections",
    "supersededCandidate",
    "actualRows",
    "actualMerges",
    "transitionObservation",
    "baselineSourceOrder",
    "sourceOrderForBaseline",
  ]) {
    const input = clone(pair.input);
    input[field] = [];
    await assert.rejects(
      () => auditLedgerLayout({ input, baselinePath: pair.baseline.filePath, candidatePath: pair.candidate.filePath }),
      /unknown|ordinary|legacy|strict/iu,
    );
  }
});

test("company unmanaged sheets and residence canonical identity are checked", async () => {
  await runAudit(await pairFor("company"));
  await assert.rejects(
    async () => runAudit(await pairFor("company", makeFactsCertificate(), { unmanagedChanged: true })),
    /unmanaged|preserved|transition/iu,
  );
  await runAudit(await pairFor("residence"));
  await assert.rejects(
    async () => runAudit(await pairFor("residence", makeFactsCertificate(), { sheetName: "住所支出" })),
    /managed sheet|canonical|驻所/iu,
  );
});

test("certificate and audit output are deeply immutable and non-authorizing", async () => {
  const result = await runAudit(await pairFor("xiaohongshu"));
  assert.equal(result.requiresGate1Binding, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(deepFrozen(result), true);
  assert.equal(Object.hasOwn(result, "approved"), false);
  assert.equal(Object.hasOwn(result, "authorized"), false);
  assert.equal(Object.hasOwn(result, "gatePassed"), false);
  const body = clone(result);
  delete body.auditDigest;
  assert.equal(canonicalDigest(body), result.auditDigest);
  const before = result.auditDigest;
  assert.throws(() => result.projection.physicalFields.push("forged"), TypeError);
  assert.throws(() => { result.sourceCoverage.units = 999; }, TypeError);
  assert.equal(result.auditDigest, before);
});

test("self-consistent digest preimages still reject invalid facts and source graph semantics first", async (t) => {
  const pair = await pairFor("xiaohongshu");
  const invoke = (certificate) => auditLedgerLayout({
    input: makeInput("xiaohongshu", certificate, pair.baseline.sha256, "0".repeat(64)),
    baselinePath: pair.baseline.filePath,
    candidatePath: pair.candidate.filePath,
  });
  const factsCases = [
    {
      name: "expected totals",
      mutate(certificate) { certificate.factsPreimage.expectedTotals.feeTotal = "999"; },
      error: /expectedTotals.*transaction|milliunits/iu,
    },
    {
      name: "affected profiles",
      mutate(certificate) { certificate.factsPreimage.affectedProfileIds = ["xiaohongshu"]; },
      error: /affectedProfileIds.*transactions/iu,
    },
    {
      name: "profile category mismatch",
      mutate(certificate) {
        const transaction = certificate.factsPreimage.transactions.find((item) => item.profileId === "xiaohongshu");
        transaction.category = "公司报销";
      },
      error: /category.*fixed profile/iu,
    },
    {
      name: "duplicate source order",
      mutate(certificate) {
        certificate.factsPreimage.transactions[1].sourceOrder = certificate.factsPreimage.transactions[0].sourceOrder;
      },
      error: /duplicate sourceOrder/iu,
    },
    {
      name: "baseline order injection",
      mutate(certificate) { certificate.factsPreimage.transactions[0].baselineSourceOrder = 1; },
      error: /unknown field baselineSourceOrder/iu,
    },
    {
      name: "NaN source order",
      mutate(certificate) { certificate.factsPreimage.transactions[0].sourceOrder = Number.NaN; },
      error: /sourceOrder.*safe integer/iu,
    },
    {
      name: "unsafe source order",
      mutate(certificate) { certificate.factsPreimage.transactions[0].sourceOrder = Number.MAX_SAFE_INTEGER + 1; },
      error: /sourceOrder.*safe integer/iu,
    },
  ];
  for (const item of factsCases) {
    await t.test("facts: " + item.name, async () => {
      const certificate = clone(makeFactsCertificate());
      item.mutate(certificate);
      resignCertificate(certificate, { sourceCoverage: false });
      await assert.rejects(() => invoke(certificate), item.error);
    });
  }

  const sourceCases = [
    {
      name: "duplicate source unit",
      mutate(preimage) { preimage.sourceUnits[1].id = preimage.sourceUnits[0].id; },
      error: /duplicate source unit/iu,
    },
    {
      name: "dangling source reference",
      mutate(preimage) { preimage.transactionSourceRefs[0].sourceRefs = ["UNIT-MISSING"]; },
      error: /missing source unit/iu,
    },
    {
      name: "excluded source reference",
      mutate(preimage) {
        preimage.sourceUnits[0].disposition = "excluded";
        preimage.sourceUnits[0].reason = "excluded fixture";
      },
      error: /references excluded source unit/iu,
    },
    {
      name: "used source unit not covered",
      mutate(preimage) {
        preimage.transactionSourceRefs[0].sourceRefs = [preimage.sourceUnits[1].id];
      },
      error: /used source unit.*not referenced/iu,
    },
    {
      name: "scope unit count",
      mutate(preimage) { preimage.sourceScopes[0].expectedUnitCount += 1; },
      error: /expectedUnitCount.*units/iu,
    },
    {
      name: "duplicate ref within transaction",
      mutate(preimage) {
        const ref = preimage.transactionSourceRefs[0].sourceRefs[0];
        preimage.transactionSourceRefs[0].sourceRefs = [ref, ref];
      },
      error: /sourceRefs.*unique/iu,
    },
  ];
  for (const item of sourceCases) {
    await t.test("source: " + item.name, async () => {
      const certificate = clone(makeFactsCertificate());
      item.mutate(certificate.sourceCoveragePreimage);
      resignCertificate(certificate, { facts: false });
      await assert.rejects(() => invoke(certificate), item.error);
    });
  }
});

test("one used source unit may support multiple same-profile and cross-profile transactions", async () => {
  const sameProfileTransactions = [
    { ...manifestTransactions()[0], id: "TX-XHS-A", sourceOrder: 1, project: "共享来源甲", classification: "共享甲" },
    { ...manifestTransactions()[0], id: "TX-XHS-B", sourceOrder: 2, project: "共享来源乙", classification: "共享乙" },
  ];
  const sameProfileCertificate = bindTransactionsToSharedSource(
    makeFactsCertificate(sameProfileTransactions),
  );
  await runAudit(await pairFor("xiaohongshu", sameProfileCertificate));

  const crossProfileCertificate = bindTransactionsToSharedSource(makeFactsCertificate([
    { ...manifestTransactions()[0], sourceOrder: 1 },
    { ...manifestTransactions()[1], sourceOrder: 2 },
  ]));
  await runAudit(await pairFor("xiaohongshu", crossProfileCertificate));
  await runAudit(await pairFor("company", crossProfileCertificate));
});

test("manifest sourceOrder controls only manifest peers while baseline same-date rows stay first", async () => {
  const transactions = [
    { ...manifestTransactions()[0], id: "TX-XHS-Z", sourceOrder: 1, date: "2032-04-16", project: "来源顺序一", classification: "顺序一" },
    { ...manifestTransactions()[0], id: "TX-XHS-A", sourceOrder: 2, date: "2032-04-16", project: "来源顺序二", classification: "顺序二" },
  ].reverse();
  const certificate = makeFactsCertificate(transactions);
  const first = certificate.factsPreimage.transactions.find((item) => item.sourceOrder === 1);
  const second = certificate.factsPreimage.transactions.find((item) => item.sourceOrder === 2);
  const baselineRecords = [
    baseRecord("xiaohongshu", { date: "2032-04-16", project: "基线同日甲", group: "baseline-a" }),
    baseRecord("xiaohongshu", { date: "2032-04-16", project: "基线同日乙", person: "基线乙", group: "baseline-b" }),
  ];
  const accepted = await explicitPair(
    "xiaohongshu",
    certificate,
    baselineRecords,
    baselineRecords.concat([transactionRecord(first), transactionRecord(second)]),
  );
  await runAudit(accepted);
  const reordered = await explicitPair(
    "xiaohongshu",
    certificate,
    baselineRecords,
    baselineRecords.concat([transactionRecord(second), transactionRecord(first)]),
  );
  await assert.rejects(() => runAudit(reordered), /manifest.*record|sourceOrder|projection/iu);
});

test("manifest groups with different settlement values remain separate", async () => {
  const transactions = [
    { ...manifestTransactions()[0], id: "TX-SETTLEMENT-A", sourceOrder: 1, person: "同人", classification: "同类", settlement: "employee_reimbursement" },
    { ...manifestTransactions()[0], id: "TX-SETTLEMENT-B", sourceOrder: 2, person: "同人", classification: "同类", settlement: "company_paid_no_reimbursement" },
  ];
  const certificate = makeFactsCertificate(transactions);
  const selected = [...certificate.factsPreimage.transactions].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const baselineRecords = [baseRecord("xiaohongshu")];
  await runAudit(await explicitPair(
    "xiaohongshu",
    certificate,
    baselineRecords,
    baselineRecords.concat(selected.map((transaction) => transactionRecord(transaction))),
  ));
  await assert.rejects(
    async () => runAudit(await explicitPair(
      "xiaohongshu",
      certificate,
      baselineRecords,
      baselineRecords.concat(selected.map((transaction) => transactionRecord(transaction, { group: "merged-settlement" }))),
    )),
    /merge group|settlement|projection/iu,
  );
});

test("ordinary auditor accepts bounded refunds and rejects invalid adjustment bindings", async (t) => {
  const source = {
    ...manifestTransactions()[0],
    id: "TX-REFUND-SOURCE",
    sourceOrder: 1,
    amount: "10",
    project: "退款原交易",
    person: "退款人员",
    classification: "退款组",
  };
  const refund = {
    ...source,
    id: "TX-REFUND",
    sourceOrder: 2,
    amount: "-2",
    project: "普通退款",
    adjustment: {
      type: "refund",
      sourceTransactionId: source.id,
      reason: "脱敏退款",
    },
  };
  const certificate = makeFactsCertificate([source, refund]);
  const ordered = [...certificate.factsPreimage.transactions].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const baselineRecords = [baseRecord("xiaohongshu")];
  const result = await runAudit(await explicitPair(
    "xiaohongshu",
    certificate,
    baselineRecords,
    baselineRecords.concat(ordered.map((transaction) => transactionRecord(transaction, { group: "refund-group" }))),
  ));
  assert.equal(result.candidate.amount, "18");

  const cases = [
    {
      name: "dangling source",
      mutate(transaction) { transaction.adjustment.sourceTransactionId = "TX-MISSING"; },
      error: /invalid source transaction/iu,
    },
    {
      name: "cross profile",
      mutate(transaction) { transaction.profileId = "company"; transaction.category = "公司报销"; },
      error: /same profile.*category.*settlement/iu,
    },
    {
      name: "cross settlement",
      mutate(transaction) { transaction.settlement = "company_paid_no_reimbursement"; },
      error: /same profile.*category.*settlement/iu,
    },
    {
      name: "refund exceeds source",
      mutate(transaction) { transaction.amount = "-11"; },
      error: /refunds.*exceed/iu,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const changed = clone(certificate);
      item.mutate(changed.factsPreimage.transactions.find((transaction) => transaction.id === refund.id));
      resignCertificate(changed, { sourceCoverage: false });
      const pair = await pairFor("xiaohongshu", certificate);
      await assert.rejects(
        () => auditLedgerLayout({
          input: makeInput("xiaohongshu", changed, pair.baseline.sha256, "0".repeat(64)),
          baselinePath: pair.baseline.filePath,
          candidatePath: pair.candidate.filePath,
        }),
        item.error,
      );
    });
  }
  await t.test("facts digest tamper precedes adjustment semantics", async () => {
    const changed = clone(certificate);
    changed.factsPreimage.transactions.find((transaction) => transaction.id === refund.id).amount = "-20";
    resignCertificate(changed, { facts: false, sourceCoverage: false });
    const pair = await pairFor("xiaohongshu", certificate);
    await assert.rejects(
      () => auditLedgerLayout({
        input: makeInput("xiaohongshu", changed, pair.baseline.sha256, "0".repeat(64)),
        baselinePath: pair.baseline.filePath,
        candidatePath: pair.candidate.filePath,
      }),
      /factsDigest.*preimage/iu,
    );
  });
});

test("actual OOXML business extractor rejects field, date, row, merge, and out-of-scope mutations", async (t) => {
  const certificate = makeFactsCertificate([manifestTransactions()[0]]);
  const transaction = certificate.factsPreimage.transactions[0];
  const baselineRecords = [baseRecord("xiaohongshu")];
  const validCandidate = () => baselineRecords.concat([transactionRecord(transaction)]);

  await t.test("modern Excel 1900 serial succeeds", async () => {
    const candidateRecords = baselineRecords.concat([
      transactionRecord(transaction, { dateSerial: String(serial(transaction.date)) }),
    ]);
    await runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, candidateRecords));
  });
  for (const [name, dateSerial] of [
    ["fractional serial", "46236.5"],
    ["Excel phantom day 60", "60"],
    ["zero serial", "0"],
  ]) {
    await t.test(name, async () => {
      const candidateRecords = baselineRecords.concat([transactionRecord(transaction, { dateSerial })]);
      await assert.rejects(
        async () => runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, candidateRecords)),
        /Excel 1900 serial|integer Excel|invalid.*serial/iu,
      );
    });
  }
  await t.test("date1904 workbook", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        certificate,
        baselineRecords,
        validCandidate(),
        { candidateOptions: { date1904: true } },
      )),
      /1900 date system|date1904/iu,
    );
  });
  await t.test("header mutation", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        certificate,
        baselineRecords,
        validCandidate(),
        { candidateOptions: { headers: ["日期", "错误明细", "支出金额", "合计", "支出人", "备注"] } },
      )),
      /header|B1/iu,
    );
  });

  const fieldCases = [
    ["date", { date: "2032-04-18" }],
    ["project", { project: "篡改项目" }],
    ["amount", { amount: "20.251" }],
    ["person", { person: "篡改人员" }],
    ["classification", { classification: "篡改分类" }],
  ];
  for (const [field, mutation] of fieldCases) {
    await t.test(field + " mutation", async () => {
      const candidateRecords = baselineRecords.concat([{ ...transactionRecord(transaction), ...mutation }]);
      await assert.rejects(
        async () => runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, candidateRecords)),
        new RegExp(field + "|manifest.*record|projection", "iu"),
      );
    });
  }
  await t.test("missing manifest row", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, baselineRecords)),
      /missing.*manifest|no actual profile addition|record/iu,
    );
  });
  await t.test("extra candidate row", async () => {
    const candidateRecords = validCandidate().concat([
      baseRecord("xiaohongshu", { date: "2032-04-18", project: "额外行", person: "额外人员", group: "extra" }),
    ]);
    await assert.rejects(
      async () => runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, candidateRecords)),
      /missing.*baseline|manifest transaction|record/iu,
    );
  });
  await t.test("managed A:F external G cell", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        certificate,
        baselineRecords,
        validCandidate(),
        { candidateOptions: { extraCells: { 3: cellString("G3", 2, "未授权外部单元格") } } },
      )),
      /scope|transition|structural|managed|outside/iu,
    );
  });
});

test("actual A and D/E/F merge topology is independently enforced", async (t) => {
  const sameDateTransaction = { ...manifestTransactions()[0], date: "2032-04-16", sourceOrder: 1 };
  const sameDateCertificate = makeFactsCertificate([sameDateTransaction]);
  const sameDateCanonical = sameDateCertificate.factsPreimage.transactions[0];
  const baselineRecords = [baseRecord("xiaohongshu", { date: "2032-04-16" })];
  const sameDateCandidate = baselineRecords.concat([transactionRecord(sameDateCanonical)]);
  await t.test("missing A merge", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        sameDateCertificate,
        baselineRecords,
        sameDateCandidate,
        { candidateOptions: { mergeOverride: [] } },
      )),
      /A3|date.*merge|numeric cell/iu,
    );
  });
  await t.test("extra A merge across different dates", async () => {
    const certificate = makeFactsCertificate([manifestTransactions()[0]]);
    const candidateRecords = baselineRecords.concat([transactionRecord(certificate.factsPreimage.transactions[0])]);
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        certificate,
        baselineRecords,
        candidateRecords,
        { candidateOptions: { mergeOverride: ["A2:A3"] } },
      )),
      /merged date follower|date.*merge|hidden/iu,
    );
  });

  const transactions = [
    { ...manifestTransactions()[0], id: "TX-MERGE-A", sourceOrder: 1, person: "合并人员", classification: "合并组" },
    { ...manifestTransactions()[0], id: "TX-MERGE-B", sourceOrder: 2, person: "合并人员", classification: "合并组" },
  ];
  const certificate = makeFactsCertificate(transactions);
  const selected = [...certificate.factsPreimage.transactions].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const candidateRecords = baselineRecords.concat(
    selected.map((transaction) => transactionRecord(transaction, { group: "manifest-merged" })),
  );
  await runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, candidateRecords));
  await t.test("missing F merge", async () => {
    await assert.rejects(
      async () => runAudit(await explicitPair(
        "xiaohongshu",
        certificate,
        baselineRecords,
        candidateRecords,
        { candidateOptions: { mergeOverride: ["A3:A4", "D3:D4", "E3:E4"] } },
      )),
      /D\/E\/F merge boundaries|F.*merge/iu,
    );
  });
  await t.test("extra cross-origin D/E/F merge", async () => {
    const crossBaseline = [baseRecord("xiaohongshu", {
      date: "2032-04-16",
      person: "合并人员",
      classification: "合并组",
    })];
    const crossRecords = [
      { ...crossBaseline[0], group: "cross", groupMode: "formula" },
      ...selected.map((transaction) => transactionRecord(transaction, { group: "cross" })),
    ];
    await assert.rejects(
      async () => runAudit(await explicitPair("xiaohongshu", certificate, crossBaseline, crossRecords)),
      /cross.*group|baseline.*manifest|merge group/iu,
    );
  });
  for (const [name, candidateOptions] of [
    ["D follower residue", { followerResidue: { rowIndex: 2, value: "1" } }],
    ["F follower residue", { extraCells: { 4: cellString("F4", 2, "隐藏残留") } }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        async () => runAudit(await explicitPair(
          "xiaohongshu",
          certificate,
          baselineRecords,
          candidateRecords,
          { candidateOptions },
        )),
        /follower.*content|hidden D\/E\/F/iu,
      );
    });
  }
});

test("date style roles follow baseline records and new date masters", async () => {
  const transaction = { ...manifestTransactions()[0], date: "2032-04-16", sourceOrder: 1 };
  const certificate = makeFactsCertificate([transaction]);
  const canonical = certificate.factsPreimage.transactions[0];
  const baselineRecords = [baseRecord("xiaohongshu", { date: "2032-04-18" })];
  const movedBaseline = { ...baselineRecords[0], aStyle: 5 };
  await assert.rejects(
    async () => runAudit(await explicitPair(
      "xiaohongshu",
      certificate,
      baselineRecords,
      [transactionRecord(canonical), movedBaseline],
    )),
    /baseline physical record style|date.*style/iu,
  );
  await assert.rejects(
    async () => runAudit(await explicitPair(
      "xiaohongshu",
      certificate,
      baselineRecords,
      [transactionRecord(canonical, { aStyle: 5 }), baselineRecords[0]],
    )),
    /baseline date style|manifest.*date.*style|style role/iu,
  );
});

test("ordinary audit rejects a selected profile with no actual workbook addition", async () => {
  const certificate = makeFactsCertificate([manifestTransactions()[0]]);
  const baselineRecords = [baseRecord("xiaohongshu")];
  await assert.rejects(
    async () => runAudit(await explicitPair("xiaohongshu", certificate, baselineRecords, baselineRecords)),
    /missing.*manifest|no actual profile addition|record/iu,
  );
});

test("production CLI accepts v2 and rejects v1, unknown arguments, SHA drift, and duplicate JSON keys", async (t) => {
  const pair = await pairFor("xiaohongshu", makeFactsCertificate([manifestTransactions()[0]]));
  const accepted = await runCli(pair, pair.input, "v2-accepted");
  assert.equal(accepted.status, 0, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.kind, "root-workbook-business-audit-v1");

  const v1 = clone(pair.input);
  v1.kind = "root-workbook-business-audit-input-v1";
  const old = await runCli(pair, v1, "v1-rejected");
  assert.equal(old.status, 1);
  assert.match(old.payload.error, /input kind.*unsupported/iu);

  const inputPath = await writeJson("unknown-arg-" + crypto.randomUUID() + ".json", pair.input);
  const unknown = runCliWithInputPath(pair, inputPath, ["--unexpected"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.payload.error, /usage/iu);

  const drift = clone(pair.input);
  drift.candidateSha256 = "0".repeat(64);
  const drifted = await runCli(pair, drift, "sha-drift");
  assert.equal(drifted.status, 1);
  assert.match(drifted.payload.error, /candidate workbook SHA-256/iu);

  const duplicateCases = [
    {
      name: "candidateSha256",
      raw: JSON.stringify(pair.input).replace(
        `"candidateSha256":"${pair.input.candidateSha256}"`,
        `"candidateSha256":"${"0".repeat(64)}","candidateSha256":"${pair.input.candidateSha256}"`,
      ),
    },
    {
      name: "certificate factsDigest",
      raw: JSON.stringify(pair.input).replace(
        `"factsDigest":"${pair.input.reimbursementFactsCertificate.factsDigest}"`,
        `"factsDigest":"${"0".repeat(64)}","factsDigest":"${pair.input.reimbursementFactsCertificate.factsDigest}"`,
      ),
    },
    {
      name: "decoded top-level candidateSha256",
      raw: JSON.stringify(pair.input).replace(
        `"candidateSha256":"${pair.input.candidateSha256}"`,
        `"candidateSha256":"${"0".repeat(64)}","candidate\\u0053ha256":"${pair.input.candidateSha256}"`,
      ),
    },
    {
      name: "decoded nested transaction amount",
      raw: JSON.stringify(pair.input).replace(
        `"amount":"${pair.input.reimbursementFactsCertificate.factsPreimage.transactions[0].amount}"`,
        `"amount":"0","amou\\u006et":"${pair.input.reimbursementFactsCertificate.factsPreimage.transactions[0].amount}"`,
      ),
    },
    {
      name: "decoded nested sourceRefs",
      raw: JSON.stringify(pair.input).replace(
        `"sourceRefs":${JSON.stringify(pair.input.reimbursementFactsCertificate.sourceCoveragePreimage.transactionSourceRefs[0].sourceRefs)}`,
        `"sourceRefs":${JSON.stringify(pair.input.reimbursementFactsCertificate.sourceCoveragePreimage.transactionSourceRefs[0].sourceRefs)},"source\\u0052efs":${JSON.stringify(pair.input.reimbursementFactsCertificate.sourceCoveragePreimage.transactionSourceRefs[0].sourceRefs)}`,
      ),
    },
  ];
  for (const item of duplicateCases) {
    await t.test("duplicate " + item.name, async () => {
      const rawPath = path.join(tempRoot, "duplicate-" + crypto.randomUUID() + ".json");
      await fs.writeFile(rawPath, item.raw, { encoding: "utf8", flag: "wx" });
      const result = runCliWithInputPath(pair, rawPath);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim(), "");
      assert.match(result.payload.error, /duplicate object key/iu);
    });
  }
});

test("large workbook audit growth remains near-linear across rows and merges", async () => {
  const transaction = { ...manifestTransactions()[0], date: "2032-04-17", sourceOrder: 1 };
  const certificate = makeFactsCertificate([transaction]);
  const canonical = certificate.factsPreimage.transactions[0];
  const makeBaseline = (count) => Array.from({ length: count }, (_, index) => {
    const pairIndex = Math.floor(index / 4);
    const inPair = index % 4 < 2;
    const group = inPair ? "pair-" + pairIndex : "single-" + index;
    return baseRecord("xiaohongshu", {
      date: "2032-04-16",
      project: "large-row-" + String(index).padStart(5, "0"),
      amount: "1",
      person: "person-" + group,
      classification: "classification-" + group,
      group,
      groupMode: inPair ? "formula" : "direct",
    });
  });
  const measure = async (count) => {
    const baselineRecords = makeBaseline(count);
    const pair = await explicitPair(
      "xiaohongshu",
      certificate,
      baselineRecords,
      baselineRecords.concat([transactionRecord(canonical)]),
    );
    const started = performance.now();
    await runAudit(pair);
    return performance.now() - started;
  };
  await measure(200);
  const smallMs = await measure(2_000);
  const largeMs = await measure(4_000);
  const ratio = largeMs / smallMs;
  console.log(JSON.stringify({
    kind: "root-workbook-auditor-linear-characterization-v1",
    smallRows: 2_000,
    smallMs,
    largeRows: 4_000,
    largeMs,
    ratio,
  }));
  assert.ok(smallMs < 10_000, "2k-row audit exceeded 10 seconds: " + smallMs);
  assert.ok(largeMs < 20_000, "4k-row audit exceeded 20 seconds: " + largeMs);
  assert.ok(largeMs < smallMs * 4 + 500, "2x rows grew superlinearly: " + ratio);
});
