import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISBURSEMENT_PROFILE_NAMES,
  buildCompactDisbursementBatchName,
  formatDisbursementAmount,
  parseDisbursementAmount,
  resolveVisibleDisbursementStatus,
} from "../scripts/disbursement_domain.mjs";
import { buildReimbursementArtifacts, REIMBURSEMENT_ARTIFACT_BUILD_KIND } from "../scripts/build_reimbursement_artifacts.mjs";
import { loadProfileRegistry } from "../scripts/finance_domain.mjs";
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SALARY_TEMPLATE = path.join(SKILL_ROOT, "assets", "templates", "disbursement", "compact-disbursement.xlsx");

async function writeBound(filePath, bytes) {
  const data = Buffer.from(bytes);
  await fs.writeFile(filePath, data, { flag: "wx" });
  return Object.freeze({ path: filePath, sha256: sha256Bytes(data), size: data.length });
}

async function writeJson(filePath, value) {
  return writeBound(filePath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function add(values) {
  return values.reduce((sum, value) => sum + parseDisbursementAmount(value, "fixture amount", { allowNegative: true }), 0n);
}

function zeroAmounts() {
  return { xiaohongshu: "0", company: "0", residence: "0", salary: "0" };
}

function rowAmount(profileId, amount, salary = "0") {
  return { ...zeroAmounts(), [profileId]: amount, salary };
}

async function makePng(index, width = 72, height = 48) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: (index * 53) % 255, g: (index * 97) % 255, b: (index * 193) % 255 },
    },
  }).png({ compressionLevel: 6 }).toBuffer();
}

async function safeSalaryWorkbookBytes() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工资最终件" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>合成工资材料</t></is></c><c r="B1"><v>5800</v></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function excelSerial(isoDate) {
  return String(Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000) + 25_569);
}

function compactDate(value) {
  return `${value.slice(0, 4)}.${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}`;
}

async function copyBound(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  return writeBound(target, await fs.readFile(source.path));
}

async function createPublishedSnapshot(detail, outputPath, profile, transactions) {
  const zip = await JSZip.loadAsync(await fs.readFile(detail.path), { createFolders: false });
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  zip.file("xl/workbook.xml", workbookXml.replaceAll(profile.detailSheetName, profile.managedRootSheetName));
  const rows = transactions.map((item, index) => {
    const row = index + 1;
    return `<row r="${row}"><c r="A${row}"><v>${excelSerial(item.date)}</v></c><c r="B${row}" t="inlineStr"><is><t>${xml(item.project)}</t></is></c><c r="C${row}"><v>${item.sourceAmount}</v></c><c r="D${row}"><f>SUM(C${row}:C${row})</f><v>${item.sourceAmount}</v></c><c r="E${row}" t="inlineStr"><is><t>${xml(item.person)}</t></is></c><c r="F${row}" t="inlineStr"><is><t>${xml(item.classification)}</t></is></c></row>`;
  }).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  return writeBound(outputPath, bytes);
}

async function createPublishedV2Sources({ originalManifestFile, archiveRoot, profileIds, transactions, material, reimbursementPeriod }) {
  const registry = await loadProfileRegistry();
  const profileIdByName = Object.fromEntries(profileIds.map((profileId) => [DISBURSEMENT_PROFILE_NAMES[profileId], profileId]));
  const builderTransactions = transactions.map((transaction) => ({
    ...transaction,
    profileId: profileIdByName[transaction.category],
    amount: transaction.sourceAmount,
  }));
  const orderedProfileIds = [...profileIds].sort((left, right) => ["xiaohongshu", "company", "residence"].indexOf(left) - ["xiaohongshu", "company", "residence"].indexOf(right));
  const factsPreimage = {
    affectedProfileIds: orderedProfileIds,
    transactions: builderTransactions.map(({ evidence: _evidence, ...transaction }) => transaction),
    summaryAnnotations: [],
  };
  const sourceCoveragePreimage = {
    transactionSourceRefs: builderTransactions.map((transaction) => ({ transactionId: transaction.id, sourceRefs: transaction.sourceRefs })),
  };
  const certificateCore = {
    kind: "reimbursement-manifest-facts-v1",
    operationMode: "reimbursement-batch",
    manifestFileSha256: originalManifestFile.sha256,
    manifestDigest: crypto.createHash("sha256").update("production fixture builder manifest").digest("hex"),
    configDigest: crypto.createHash("sha256").update("production fixture builder config").digest("hex"),
    profileConfigDigest: registry.profileConfigDigest,
    factsDigest: canonicalDigest(factsPreimage),
    factsPreimage,
    sourceCoverageDigest: canonicalDigest(sourceCoveragePreimage),
    sourceCoveragePreimage,
  };
  const presentationBuild = await buildReimbursementArtifacts({
    kind: REIMBURSEMENT_ARTIFACT_BUILD_KIND,
    stagingToken: crypto.randomBytes(32).toString("hex"),
    manifestPath: originalManifestFile.path,
    manifestSha256: originalManifestFile.sha256,
    reimbursementFactsCertificate: { ...certificateCore, certificateDigest: canonicalDigest(certificateCore) },
  });
  try {
    const results = [];
    await fs.mkdir(archiveRoot, { recursive: true });
    for (const profileId of profileIds) {
      const profile = registry.profiles[profileId];
      const presentation = presentationBuild.artifacts.find((artifact) => artifact.profileId === profileId);
      if (!presentation) throw new Error(`published v2 fixture lacks presentation for ${profileId}`);
      const summary = await copyBound(presentation.summary, path.join(archiveRoot, path.basename(presentation.summary.path)));
      const detail = await copyBound(presentation.detail, path.join(archiveRoot, path.basename(presentation.detail.path)));
      const screenshot = await copyBound(presentation.screenshot, path.join(archiveRoot, path.basename(presentation.screenshot.path)));
      const supplements = [];
      for (const supplement of presentation.supplements) supplements.push(await copyBound(supplement, path.join(archiveRoot, path.basename(supplement.path))));
      const evidence = [];
      const evidenceDirectory = path.join(archiveRoot, "报销截图", profile.screenshotMapSheetName);
      for (const item of presentation.evidenceArchive) evidence.push(await copyBound(item, path.join(evidenceDirectory, item.finalName)));
      const profileTransactions = transactions.filter((transaction) => transaction.category === profile.targetCategory);
      const snapshot = await createPublishedSnapshot(
        detail,
        path.join(archiveRoot, `${profile.archiveStem}_截至${compactDate(reimbursementPeriod.end)}.xlsx`),
        profile,
        profileTransactions,
      );
      results.push({ profileId, summary, detail, screenshot, snapshot, supplements, evidence, material });
    }
    return results;
  } finally {
    await fs.rm(presentationBuild.stagingRoot, { recursive: true, force: true });
  }
}

function transactionAmount(index) {
  const special = ["3464.14", "9707", "13000", "10314", "6598", "40100.536", "-12.345"];
  return special[index] ?? `${120 + index}.${String((index * 37) % 1000).padStart(3, "0")}`;
}

function payoutKind(index) {
  if (index === 0) return "not-in-batch";
  if (index === 1) return "exception";
  if ([2, 3, 4].includes(index)) return "cash-pending";
  if (index === 5) return "retained";
  if (index === 6) return "refund";
  if (index % 11 === 0) return "pending-evidence";
  return "reconciled";
}

async function createPublishedArtifacts(root, profileIds, material) {
  const outputs = [];
  for (const profileId of profileIds) {
    const profileRoot = path.join(root, `published-${profileId}`);
    await fs.mkdir(profileRoot, { recursive: false });
    const role = async (name, suffix) => writeBound(path.join(profileRoot, name), Buffer.from(`${profileId}:${suffix}\n`, "utf8"));
    const rootWorkbook = await role(`${profileId}-root.xlsx`, "root");
    const detail = await role(`${profileId}-detail.xlsx`, "detail");
    const screenshot = await role(`${profileId}-screenshot.xlsx`, "screenshot");
    const summary = await role(`${profileId}-summary.txt`, "summary");
    const snapshot = await role(`${profileId}-snapshot.xlsx`, "snapshot");
    outputs.push({
      profileId,
      root: rootWorkbook,
      detail,
      screenshot,
      summary,
      snapshot,
      supplements: [],
      evidenceArchive: [material],
      publishAuditDigest: crypto.createHash("sha256").update(`audit:${profileId}`).digest("hex"),
    });
  }
  return outputs;
}

export async function createCompactDisbursementProductionFixture({
  root,
  profileIds = ["xiaohongshu", "company"],
  reimbursementTransactionCount = 47,
  includeSalary = true,
  requestedUniqueVoucherCount = 24,
  nameRevision = 1,
  manifestVersion = 1,
  reimbursementMode = "fresh_evidence",
  includeReimbursementAttestations = false,
  includeSalaryAttestation = false,
} = {}) {
  if (!path.isAbsolute(root)) throw new Error("fixture root must be absolute");
  if (![1, 2].includes(manifestVersion)) throw new Error("fixture manifestVersion must be 1 or 2");
  if (!["fresh_evidence", "published_archive"].includes(reimbursementMode)) throw new Error("fixture reimbursementMode is invalid");
  if (profileIds.length === 0 && !includeSalary) throw new Error("fixture requires reimbursement and/or salary");
  await fs.mkdir(root, { recursive: true });
  const reimbursementPeriod = Object.freeze({ start: "2031-04-10", end: "2031-04-15" });
  const baseline = await writeBound(path.join(root, "ordinary-baseline.xlsx"), Buffer.from("synthetic baseline\n", "utf8"));
  const material = await writeBound(path.join(root, "ordinary-voucher.png"), await makePng(251, 96, 64));

  let originalManifest = null;
  let originalManifestFile = null;
  let receipt = null;
  let receiptFile = null;
  const transactions = [];
  if (profileIds.length) {
    for (let index = 0; index < reimbursementTransactionCount; index += 1) {
      const profileId = profileIds[index % profileIds.length];
      const amount = transactionAmount(index);
      const transaction = {
        id: `TX-${String(index + 1).padStart(3, "0")}`,
        sourceOrder: index + 1,
        date: `2031-04-${String(10 + (index % 6)).padStart(2, "0")}`,
        person: `合成人员${String(index + 1).padStart(3, "0")}`,
        project: `合成事项${String(index + 1).padStart(3, "0")}`,
        label: `合成人员${String(index + 1).padStart(3, "0")}`,
        classification: "运营开支",
        sourceAmount: amount,
        reimbursementAmount: amount,
        reportingKind: "current",
        category: DISBURSEMENT_PROFILE_NAMES[profileId],
        settlement: "employee_reimbursement",
        evidence: ["MATERIAL-1"],
        sourceRefs: [`UNIT-${String(index + 1).padStart(3, "0")}`],
      };
      if (parseDisbursementAmount(amount, "fixture reimbursement amount", { allowNegative: true }) < 0n) {
        const refundSource = transactions.findLast((entry) => entry.category === transaction.category && parseDisbursementAmount(entry.sourceAmount, "fixture refund source") > 0n);
        if (!refundSource) throw new Error(`fixture refund ${transaction.id} has no earlier positive source in ${transaction.category}`);
        transaction.adjustment = {
          type: "refund",
          sourceTransactionId: refundSource.id,
          reason: "合成退款核销",
        };
      }
      transactions.push(transaction);
    }
    const ordinaryArchiveName = profileIds.length === 1
      ? `${compactDate(reimbursementPeriod.start)}-${compactDate(reimbursementPeriod.end)}_${DISBURSEMENT_PROFILE_NAMES[profileIds[0]]}`
      : "ordinary-archive";
    originalManifest = {
      version: 3,
      rulesVersion: "compact-disbursement-production-fixture-v1",
      batch: {
        batchId: "synthetic-ordinary-source",
        rootPath: root,
        archivePath: path.join(root, ordinaryArchiveName),
        period: "2031.4.10-2031.4.15",
        mainPeriod: reimbursementPeriod,
        targetCategory: DISBURSEMENT_PROFILE_NAMES[profileIds[0]],
        reviewRevision: 1,
      },
      operation: { mode: "reimbursement-batch" },
      files: [
        { id: "BASELINE", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
        { id: "MATERIAL-1", role: "material", path: material.path, sha256: material.sha256, kind: "image", disposition: "used", usage: "voucher" },
      ],
      sourceScopes: [{ id: "SCOPE-1", fileId: "MATERIAL-1", locator: "full-image", terminalConfirmed: true, expectedUnitCount: transactions.length }],
      sourceUnits: transactions.map((_, index) => ({ id: `UNIT-${String(index + 1).padStart(3, "0")}`, scopeId: "SCOPE-1", locator: `row-${index + 1}`, disposition: "used" })),
      transactions,
      expected: {
        transactionCount: transactions.length,
        feeTotal: formatDisbursementAmount(add(transactions.map((entry) => entry.sourceAmount))),
        reimbursementTotal: formatDisbursementAmount(add(transactions.map((entry) => entry.reimbursementAmount))),
        companyPaidNoReimbursementTotal: "0",
        uniqueMediaCount: 1,
        mediaReferenceCount: transactions.length,
      },
    };
    originalManifestFile = await writeJson(path.join(root, "ordinary-manifest.json"), originalManifest);
    const outputs = await createPublishedArtifacts(root, profileIds, material);
    const receiptCore = {
      kind: "ordinary-reimbursement-published-v1",
      batchId: originalManifest.batch.batchId,
      affectedProfileIds: [...profileIds].sort((left, right) => ["xiaohongshu", "company", "residence"].indexOf(left) - ["xiaohongshu", "company", "residence"].indexOf(right)),
      outputs,
      postPublishAuditDigest: crypto.createHash("sha256").update("synthetic post publish audit").digest("hex"),
    };
    receipt = { ...receiptCore, receiptDigest: canonicalDigest(receiptCore) };
    receiptFile = await writeJson(path.join(root, "ordinary-publish-receipt.json"), receipt);
  }
  const publishedV2Sources = manifestVersion === 2 && reimbursementMode === "published_archive" && profileIds.length
    ? await createPublishedV2Sources({
        originalManifestFile,
        archiveRoot: originalManifest.batch.archivePath,
        profileIds,
        transactions,
        material,
        reimbursementPeriod,
      })
    : [];

  const salaryArtifacts = [];
  let salaryAmount = "0";
  let salaryFile = null;
  let salaryCertificate = null;
  let salaryCertificateFile = null;
  if (includeSalary) {
    const salaryPath = path.join(root, "salary-final.xlsx");
    const salaryBytes = manifestVersion === 2 ? await safeSalaryWorkbookBytes() : await fs.readFile(SALARY_TEMPLATE);
    salaryFile = await writeBound(salaryPath, salaryBytes);
    salaryAmount = "5800";
    const certificateCore = {
      kind: "salary-final-artifact-v1",
      version: 1,
      month: "2031-04",
      salaryCategoryId: "xiaohongshu-salary",
      salaryCategoryName: "小红书工资",
      finalArtifactKind: "workbook",
      artifactSha256: salaryFile.sha256,
      storeReference: "工资最终件/2031-04/小红书工资/最终表.xlsx",
      grossPayTotal: salaryAmount,
    };
    salaryCertificate = { ...certificateCore, certificateDigest: canonicalDigest(certificateCore) };
    salaryCertificateFile = await writeJson(path.join(root, "salary-final-certificate.json"), salaryCertificate);
    salaryArtifacts.push({
      id: "salary-2031-04-xhs",
      month: "2031-04",
      salaryCategoryId: "xiaohongshu-salary",
      salaryCategoryName: "小红书工资",
      finalArtifactKind: "workbook",
      path: salaryFile.path,
      sha256: salaryFile.sha256,
      storeReference: salaryCertificate.storeReference,
      certificatePath: salaryCertificateFile.path,
      certificateSha256: salaryCertificateFile.sha256,
    });
  }

  const eligibleForVoucher = transactions.map((_, index) => index).filter((index) => ["reconciled", "refund", "retained"].includes(payoutKind(index)));
  const uniqueVoucherCount = eligibleForVoucher.length
    ? Math.max(1, Math.min(requestedUniqueVoucherCount, eligibleForVoucher.length))
    : includeSalary ? 1 : 0;
  const vouchers = [];
  for (let index = 0; index < uniqueVoucherCount; index += 1) {
    const file = await writeBound(path.join(root, `payout-${String(index + 1).padStart(3, "0")}.png`), await makePng(index + 1));
    vouchers.push({ id: `voucher-${String(index + 1).padStart(3, "0")}`, path: file.path, sha256: file.sha256 });
  }
  if (uniqueVoucherCount > 0) vouchers.push({ id: "voucher-duplicate-alias", path: vouchers[0].path, sha256: vouchers[0].sha256 });

  const voucherQueues = new Map(eligibleForVoucher.map((index) => [index, []]));
  if (eligibleForVoucher.length) {
    voucherQueues.get(eligibleForVoucher[0]).push(vouchers[0].id, "voucher-duplicate-alias");
    for (let voucherIndex = 1; voucherIndex < uniqueVoucherCount; voucherIndex += 1) {
      voucherQueues.get(eligibleForVoucher[voucherIndex % eligibleForVoucher.length]).push(vouchers[voucherIndex].id);
    }
    for (const rowIndex of eligibleForVoucher) {
      if (voucherQueues.get(rowIndex).length === 0) voucherQueues.get(rowIndex).push(vouchers[(rowIndex % uniqueVoucherCount)].id);
    }
  }

  const sourceIdByProfile = Object.fromEntries(profileIds.map((profileId) => [profileId, `source-${profileId}`]));
  const rows = transactions.map((transaction, index) => {
    const profileId = profileIds[index % profileIds.length];
    const kind = payoutKind(index);
    const salary = includeSalary && index === Math.min(7, Math.max(0, transactions.length - 1)) ? salaryAmount : "0";
    const amounts = rowAmount(profileId, transaction.reimbursementAmount, salary);
    const payable = formatDisbursementAmount(add(Object.values(amounts)));
    const base = {
      id: `row-${String(index + 1).padStart(3, "0")}`,
      order: index + 1,
      subject: transaction.person,
      scopeStatus: kind === "not-in-batch" ? "not_in_batch" : "in_batch",
      payoutStatus: "reconciled",
      paymentMethod: "transfer",
      adjustmentKind: "none",
      amounts,
      paidAmount: payable,
      reimbursementRefs: [{ sourceId: sourceIdByProfile[profileId], transactionId: transaction.id, amount: transaction.reimbursementAmount }],
      voucherRefs: [...(voucherQueues.get(index) ?? [])],
      ...(salary !== "0" ? { salaryArtifactId: "salary-2031-04-xhs" } : {}),
    };
    if (kind === "not-in-batch") Object.assign(base, { payoutStatus: "not_applicable", paymentMethod: "none", paidAmount: "0", voucherRefs: [], reason: "不属于本批", targetBatch: "下一发放批次" });
    else if (kind === "exception") Object.assign(base, { payoutStatus: "exception", paidAmount: "0", voucherRefs: [], reason: "反向转账原因待确认", followUp: "财务核实后处理" });
    else if (kind === "cash-pending") Object.assign(base, { payoutStatus: "pending_confirmation", paymentMethod: "cash", voucherRefs: [], reason: "现金签收待确认", followUp: "补现金签收证明" });
    else if (kind === "pending-evidence") Object.assign(base, { payoutStatus: "pending_evidence", voucherRefs: [], reason: "付款凭证待补", followUp: "补齐回单" });
    else if (kind === "retained") Object.assign(base, {
      payoutStatus: "retained_by_self",
      paymentMethod: "none",
      retentionProof: { fundsReceivedVoucherRefs: [vouchers[0].id], decisionVoucherRefs: ["voucher-duplicate-alias"] },
    });
    return base;
  });
  if (includeSalary && rows.length === 0) {
    rows.push({
      id: "row-salary-only",
      order: 1,
      subject: "合成人员工资",
      scopeStatus: "in_batch",
      payoutStatus: "reconciled",
      paymentMethod: "transfer",
      adjustmentKind: "none",
      amounts: { ...zeroAmounts(), salary: salaryAmount },
      paidAmount: salaryAmount,
      reimbursementRefs: [],
      salaryArtifactId: "salary-2031-04-xhs",
      voucherRefs: [vouchers[0].id, "voucher-duplicate-alias"],
    });
  }
  rows.push({
    id: "row-rounding-tail",
    order: rows.length + 1,
    subject: "合成尾差",
    scopeStatus: "in_batch",
    payoutStatus: "not_applicable",
    paymentMethod: "none",
    adjustmentKind: "rounding_tail",
    amounts: zeroAmounts(),
    paidAmount: "0",
    reimbursementRefs: [],
    voucherRefs: [],
    adjustment: { amount: "0.367", sourceRowId: rows.find((entry) => entry.scopeStatus === "in_batch" && entry.adjustmentKind === "none").id, reason: "三位小数尾差", tolerance: "0.5", authorization: "合成财务授权" },
  });

  const normalInBatch = rows.filter((row) => row.scopeStatus === "in_batch" && row.adjustmentKind === "none");
  const visible = rows.map((row) => ({ row, status: resolveVisibleDisbursementStatus(row) }));
  let disbursementManifest;
  if (manifestVersion === 1) disbursementManifest = {
    kind: "disbursement-archive-manifest-v1",
    version: 1,
    batch: {
      batchId: "synthetic-compact-disbursement",
      archiveParentPath: root,
      nameRevision,
      ...(profileIds.length ? { reimbursementPeriod } : {}),
    },
    reimbursementSources: profileIds.map((profileId) => ({
      id: sourceIdByProfile[profileId],
      profileId,
      originalManifestPath: originalManifestFile.path,
      originalManifestSha256: originalManifestFile.sha256,
      publishReceiptPath: receiptFile.path,
      publishReceiptSha256: receiptFile.sha256,
    })),
    salaryArtifacts,
    vouchers,
    rows,
    expected: {
      rowCount: rows.length,
      inBatchDueTotal: formatDisbursementAmount(add(normalInBatch.map((row) => formatDisbursementAmount(add(Object.values(row.amounts)))))),
      inBatchPaidTotal: formatDisbursementAmount(add(normalInBatch.map((row) => row.paidAmount))),
      reconciledTotal: formatDisbursementAmount(add(visible.filter((entry) => entry.row.scopeStatus === "in_batch" && entry.row.adjustmentKind === "none" && entry.status === "已核销").map((entry) => entry.row.paidAmount))),
      uniqueVoucherCount: new Set(vouchers.map((entry) => entry.sha256)).size,
      voucherReferenceCount: rows.reduce((sum, row) => sum + row.voucherRefs.length, 0),
      roundingTailTotal: "0.367",
      salarySlotCount: salaryArtifacts.length,
    },
  };
  else {
    if (reimbursementMode === "published_archive" && includeReimbursementAttestations) {
      throw new Error("published_archive fixture attestations are intentionally separate from its default no-attestation path");
    }
    const sourceFiles = [];
    const publishedInputFileIdsByProfile = new Map();
    if (profileIds.length) {
      if (reimbursementMode === "fresh_evidence") {
        sourceFiles.push({
          id: "fresh-reimbursement-evidence",
          path: material.path,
          sha256: material.sha256,
          kind: "image",
          usage: ["fresh_reimbursement_evidence"],
        });
        if (includeReimbursementAttestations) {
          sourceFiles.push(
            { id: "ordinary-manifest-attestation", path: originalManifestFile.path, sha256: originalManifestFile.sha256, kind: "json", usage: ["original_manifest_attestation"] },
            { id: "ordinary-receipt-attestation", path: receiptFile.path, sha256: receiptFile.sha256, kind: "json", usage: ["publish_receipt_attestation"] },
          );
        }
      } else {
        for (const published of publishedV2Sources) {
          const entries = [
            ["summary", published.summary, "text"],
            ["detail", published.detail, "workbook"],
            ["screenshot", published.screenshot, "workbook"],
            ["snapshot", published.snapshot, "workbook"],
            ...published.supplements.map((binding, index) => [`supplement-${index + 1}`, binding, "workbook"]),
            ...published.evidence.map((binding, index) => [`evidence-${index + 1}`, binding, "image"]),
          ];
          const ids = entries.map(([role, binding, kind]) => {
            const fileId = `published-${published.profileId}-${role}`;
            sourceFiles.push({ id: fileId, path: binding.path, sha256: binding.sha256, kind, usage: ["published_reimbursement_artifact"] });
            return fileId;
          });
          publishedInputFileIdsByProfile.set(published.profileId, ids);
        }
      }
    }
    if (includeSalary) {
      sourceFiles.push({ id: "salary-final-artifact", path: salaryFile.path, sha256: salaryFile.sha256, kind: "workbook", usage: ["salary_artifact"] });
      if (includeSalaryAttestation) {
        sourceFiles.push({ id: "salary-certificate-attestation", path: salaryCertificateFile.path, sha256: salaryCertificateFile.sha256, kind: "json", usage: ["salary_certificate_attestation"] });
      }
    }
    const voucherFileIdByPath = new Map();
    for (const voucher of vouchers) {
      if (voucherFileIdByPath.has(voucher.path)) continue;
      const fileId = `payout-voucher-file-${String(voucherFileIdByPath.size + 1).padStart(3, "0")}`;
      voucherFileIdByPath.set(voucher.path, fileId);
      sourceFiles.push({ id: fileId, path: voucher.path, sha256: voucher.sha256, kind: "image", usage: ["payout_voucher"] });
    }
    const reimbursementSourcesV2 = profileIds.map((profileId) => ({
      id: sourceIdByProfile[profileId],
      profileId,
      mode: reimbursementMode,
      inputFileIds: reimbursementMode === "fresh_evidence" ? ["fresh-reimbursement-evidence"] : publishedInputFileIdsByProfile.get(profileId),
      ...(includeReimbursementAttestations ? { attestations: { originalManifestFileId: "ordinary-manifest-attestation", receiptFileId: "ordinary-receipt-attestation" } } : {}),
    }));
    const reimbursementReviews = reimbursementSourcesV2.map((source) => ({
      id: `review-${source.id}`,
      sourceId: source.id,
      mode: reimbursementMode,
      reviewedFileIds: reimbursementMode === "fresh_evidence"
        ? ["fresh-reimbursement-evidence", ...(includeReimbursementAttestations ? ["ordinary-manifest-attestation", "ordinary-receipt-attestation"] : [])]
        : [...source.inputFileIds],
      facts: {
        batchId: originalManifest.batch.batchId,
        reimbursementPeriod,
        transactions: transactions
          .filter((transaction) => transaction.category === DISBURSEMENT_PROFILE_NAMES[source.profileId])
          .map((transaction) => ({ id: transaction.id, date: transaction.date, person: transaction.person, reimbursementAmount: transaction.reimbursementAmount })),
      },
    }));
    const salaryArtifactsV2 = includeSalary ? [{
      id: "salary-2031-04-xhs",
      month: "2031-04",
      salaryCategoryId: "xiaohongshu-salary",
      salaryCategoryName: "小红书工资",
      finalArtifactKind: "workbook",
      fileId: "salary-final-artifact",
      storeReference: salaryCertificate.storeReference,
      ...(includeSalaryAttestation ? { attestation: { salaryCertificateFileId: "salary-certificate-attestation" } } : {}),
    }] : [];
    const salaryRow = rows.find((row) => row.salaryArtifactId === "salary-2031-04-xhs");
    const salaryReviews = includeSalary ? [{
      id: "review-salary-2031-04-xhs",
      salaryArtifactId: "salary-2031-04-xhs",
      mode: "final_artifact",
      reviewedFileIds: ["salary-final-artifact", ...(includeSalaryAttestation ? ["salary-certificate-attestation"] : [])],
      facts: {
        month: "2031-04",
        salaryCategoryId: "xiaohongshu-salary",
        salaryCategoryName: "小红书工资",
        finalArtifactKind: "workbook",
        storeReference: salaryCertificate.storeReference,
        grossPayTotal: salaryAmount,
        payments: [{ id: "salary-payment-001", subject: salaryRow.subject, amount: salaryAmount }],
      },
    }] : [];
    disbursementManifest = {
      kind: "disbursement-archive-manifest-v2",
      version: 2,
      batch: {
        batchId: "synthetic-compact-disbursement",
        archiveParentPath: root,
        nameRevision,
        ...(profileIds.length ? { reimbursementPeriod } : {}),
      },
      sourceFiles,
      reimbursementSources: reimbursementSourcesV2,
      salaryArtifacts: salaryArtifactsV2,
      vouchers: vouchers.map((voucher) => ({ id: voucher.id, fileId: voucherFileIdByPath.get(voucher.path) })),
      rows,
      sourceReview: {
        kind: "disbursement-source-review-v2",
        version: 2,
        id: "production-fixture-review",
        producer: "task_internal",
        generatedAt: "2031-04-16T00:00:00Z",
        reimbursement: reimbursementReviews,
        salary: salaryReviews,
      },
      expected: {
        rowCount: rows.length,
        inBatchDueTotal: formatDisbursementAmount(add(normalInBatch.map((row) => formatDisbursementAmount(add(Object.values(row.amounts)))))),
        inBatchPaidTotal: formatDisbursementAmount(add(normalInBatch.map((row) => row.paidAmount))),
        reconciledTotal: formatDisbursementAmount(add(visible.filter((entry) => entry.row.scopeStatus === "in_batch" && entry.row.adjustmentKind === "none" && entry.status === "已核销").map((entry) => entry.row.paidAmount))),
        uniqueVoucherCount: new Set(vouchers.map((entry) => entry.sha256)).size,
        voucherReferenceCount: rows.reduce((sum, row) => sum + row.voucherRefs.length, 0),
        roundingTailTotal: "0.367",
        salarySlotCount: salaryArtifactsV2.length,
      },
    };
  }
  const manifestFile = await writeJson(path.join(root, "disbursement-manifest.json"), disbursementManifest);
  return Object.freeze({
    root,
    manifest: disbursementManifest,
    manifestPath: manifestFile.path,
    manifestSha256: manifestFile.sha256,
    originalManifest,
    originalManifestFile,
    receipt,
    receiptFile,
    expectedBatchName: buildCompactDisbursementBatchName({ reimbursementPeriod: profileIds.length ? reimbursementPeriod : undefined, profileIds, salaryMonth: includeSalary ? "2031-04" : null, nameRevision }),
  });
}
