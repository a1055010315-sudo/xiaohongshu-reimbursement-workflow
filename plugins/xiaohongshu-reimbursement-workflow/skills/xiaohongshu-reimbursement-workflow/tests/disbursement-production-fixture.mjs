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
import { canonicalDigest, loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
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
} = {}) {
  if (!path.isAbsolute(root)) throw new Error("fixture root must be absolute");
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
    originalManifest = {
      version: 3,
      rulesVersion: "compact-disbursement-production-fixture-v1",
      batch: {
        batchId: "synthetic-ordinary-source",
        rootPath: root,
        archivePath: path.join(root, "ordinary-archive"),
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

  const salaryArtifacts = [];
  let salaryAmount = "0";
  if (includeSalary) {
    const salaryPath = path.join(root, "salary-final.xlsx");
    const salaryBytes = await fs.readFile(SALARY_TEMPLATE);
    const salaryFile = await writeBound(salaryPath, salaryBytes);
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
    const certificate = { ...certificateCore, certificateDigest: canonicalDigest(certificateCore) };
    const certificateFile = await writeJson(path.join(root, "salary-final-certificate.json"), certificate);
    salaryArtifacts.push({
      id: "salary-2031-04-xhs",
      month: "2031-04",
      salaryCategoryId: "xiaohongshu-salary",
      salaryCategoryName: "小红书工资",
      finalArtifactKind: "workbook",
      path: salaryFile.path,
      sha256: salaryFile.sha256,
      storeReference: certificate.storeReference,
      certificatePath: certificateFile.path,
      certificateSha256: certificateFile.sha256,
    });
  }

  const eligibleForVoucher = transactions.map((_, index) => index).filter((index) => ["reconciled", "refund", "retained"].includes(payoutKind(index)));
  const uniqueVoucherCount = Math.max(1, Math.min(requestedUniqueVoucherCount, eligibleForVoucher.length));
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
  const disbursementManifest = {
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
