import {
  formatDisbursementAmount,
  parseDisbursementAmount,
} from "./disbursement_domain.mjs";
import { auditDisbursementFreshSourcesV2 } from "./disbursement_fresh_source_v2.mjs";
import { auditDisbursementReimbursementSourcesV2 } from "./disbursement_reimbursement_source_v2.mjs";
import {
  canonicalDigest,
  mapSettledLimit,
} from "./workflow_primitives.mjs";

const REIMBURSEMENT_FACTS_V2_KIND = "disbursement-reimbursement-facts-v2";
const SALARY_FACTS_V2_KIND = "disbursement-salary-facts-v2";

function fail(message) {
  throw new Error(`Compact Disbursement Manifest v2 Audit ${message}`);
}

function canonicalAmount(value, field, { allowNegative = false } = {}) {
  return formatDisbursementAmount(parseDisbursementAmount(value, field, { allowNegative }));
}

function samePeriod(left, right) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function transactionKey(sourceId, transactionId) {
  return `${sourceId}\u0000${transactionId}`;
}

function sortedPaymentTuples(values) {
  return values
    .map((item) => JSON.stringify([item.subject, item.amount]))
    .sort((left, right) => left.localeCompare(right));
}

function sourceReviewSlice(normalized, reimbursement) {
  return {
    kind: normalized.sourceReview.kind,
    version: normalized.sourceReview.version,
    id: normalized.sourceReview.id,
    producer: normalized.sourceReview.producer,
    generatedAt: normalized.sourceReview.generatedAt,
    reimbursement,
    salary: normalized.sourceReview.salary,
  };
}

/**
 * Performs the file-backed v2 source audits and returns only the compatibility
 * shape consumed by the unchanged compact-disbursement business closure. The
 * caller supplies the existing binary validator to avoid an ESM import cycle.
 */
export async function prepareDisbursementManifestV2Audit(normalized, { validateBoundBinary }) {
  if (typeof validateBoundBinary !== "function") fail("requires the existing bound binary validator.");
  const period = normalized.batch.reimbursementPeriod;
  if (period && period.start > period.end) fail("batch.reimbursementPeriod.start must not be after end.");

  const publishedSources = normalized.reimbursementSources.filter((source) => source.mode === "published_archive");
  const freshSources = normalized.reimbursementSources.filter((source) => source.mode === "fresh_evidence");
  const publishedReviews = normalized.sourceReview.reimbursement.filter((review) => review.mode === "published_archive");
  const freshReviews = normalized.sourceReview.reimbursement.filter((review) => review.mode === "fresh_evidence");

  for (const review of normalized.sourceReview.reimbursement) {
    if (!period || !samePeriod(review.facts.reimbursementPeriod, period)) {
      fail(`${review.sourceId} sourceReview reimbursementPeriod differs from batch.reimbursementPeriod.`);
    }
    for (const transaction of review.facts.transactions) {
      if (transaction.date > period.end) fail(`${review.sourceId}/${transaction.id} occurs after batch.reimbursementPeriod.end.`);
    }
  }

  const publishedAudit = publishedSources.length
    ? await auditDisbursementReimbursementSourcesV2({
      sourceFiles: normalized.sourceFiles,
      reimbursementSources: publishedSources,
      reimbursementReviews: publishedReviews,
    })
    : null;
  const freshAudit = freshSources.length || normalized.salaryArtifacts.length
    ? await auditDisbursementFreshSourcesV2({
      sourceFiles: normalized.sourceFiles,
      reimbursementSources: freshSources,
      salaryArtifacts: normalized.salaryArtifacts,
      sourceReview: sourceReviewSlice(normalized, freshReviews),
    })
    : null;

  const reviewBySourceId = new Map(normalized.sourceReview.reimbursement.map((review) => [review.sourceId, review]));
  const publishedResultById = new Map((publishedAudit?.sources ?? []).map((source) => [source.sourceId, source]));
  const freshResultById = new Map((freshAudit?.reimbursementResults ?? []).map((source) => [source.sourceId, source]));
  const batchProfileKeys = new Set();
  const reimbursementSources = normalized.reimbursementSources.map((source) => {
    const review = reviewBySourceId.get(source.id);
    const audited = source.mode === "published_archive"
      ? publishedResultById.get(source.id)
      : freshResultById.get(source.id);
    if (!review || !audited) fail(`${source.id} did not produce one complete source audit result.`);
    const batchProfileKey = `${review.facts.batchId}\u0000${source.profileId}`;
    if (batchProfileKeys.has(batchProfileKey)) fail(`${source.id} duplicates a reimbursement batch/profile source.`);
    batchProfileKeys.add(batchProfileKey);
    const transactions = source.mode === "published_archive"
      ? audited.transactions.map((transaction) => ({ ...transaction }))
      : audited.facts.transactions.map((transaction) => ({ ...transaction }));
    const seenTransactions = new Set();
    for (const transaction of transactions) {
      const key = transactionKey(source.id, transaction.id);
      if (seenTransactions.has(key)) fail(`${source.id} audited transaction ${transaction.id} is duplicated.`);
      seenTransactions.add(key);
    }
    const semanticBasis = source.mode === "fresh_evidence"
      ? "task_internal_review_bound"
      : "published_archive_reconstructed_with_review_bound_identifiers";
    const sourceAuditDigest = source.mode === "published_archive"
      ? audited.sourceDigest
      : canonicalDigest(audited);
    const certificateCore = {
      kind: REIMBURSEMENT_FACTS_V2_KIND,
      version: 2,
      sourceId: source.id,
      batchId: review.facts.batchId,
      profileId: source.profileId,
      mode: source.mode,
      reimbursementPeriod: { ...review.facts.reimbursementPeriod },
      transactions,
      semanticBasis,
      sourceAuditDigest,
    };
    const certificate = Object.freeze({ ...certificateCore, certificateDigest: canonicalDigest(certificateCore) });
    return Object.freeze({
      sourceId: source.id,
      profileId: source.profileId,
      mode: source.mode,
      certificate,
      verifiedV2Source: audited,
    });
  });

  const sourceFileById = new Map(normalized.sourceFiles.map((file) => [file.id, file]));
  const voucherFileIds = [...new Set(normalized.vouchers.map((voucher) => voucher.fileId))];
  const voucherJobs = await mapSettledLimit(voucherFileIds, 4, async (fileId) => {
    const file = sourceFileById.get(fileId);
    if (!file) fail(`voucher file ${fileId} is missing from sourceFiles.`);
    const validated = await validateBoundBinary(file.path, file.sha256, `sourceFiles voucher ${fileId}`, {
      expectedKind: file.kind,
    });
    return { fileId, validated };
  });
  const validatedVoucherByFileId = new Map(voucherJobs.settled.map((item) => [item.value.fileId, item.value.validated]));
  const voucherEntries = normalized.vouchers.map((voucher, index) => {
    const file = sourceFileById.get(voucher.fileId);
    return {
      voucherId: voucher.id,
      voucherPath: file.path,
      voucherSha256: file.sha256,
      field: `vouchers[${index}]`,
      validated: validatedVoucherByFileId.get(file.id),
    };
  });
  const voucherById = new Map(voucherEntries.map((voucher) => [voucher.voucherId, voucher]));

  const freshFileBindingById = new Map((freshAudit?.fileBindings ?? []).map((binding) => [binding.fileId, binding]));
  const salaryResultById = new Map((freshAudit?.salaryResults ?? []).map((result) => [result.artifactId, result]));
  const salaryArtifacts = normalized.salaryArtifacts.map((artifact) => {
    const audited = salaryResultById.get(artifact.id);
    const artifactFile = sourceFileById.get(artifact.fileId);
    const artifactBinding = freshFileBindingById.get(artifact.fileId);
    if (!audited || !artifactFile || !artifactBinding) fail(`${artifact.id} did not produce one complete salary artifact audit result.`);
    const expectedPayments = audited.payments.map((payment) => ({
      id: payment.id,
      subject: payment.subject,
      amount: canonicalAmount(payment.amount, `${artifact.id}/${payment.id}.amount`),
    }));
    const salaryRows = normalized.rows
      .filter((row) => row.salaryArtifactId === artifact.id && parseDisbursementAmount(row.amounts.salary, `${row.id}.amounts.salary`) > 0n)
      .map((row) => ({ subject: row.subject, amount: canonicalAmount(row.amounts.salary, `${row.id}.amounts.salary`) }));
    if (canonicalDigest(sortedPaymentTuples(salaryRows)) !== canonicalDigest(sortedPaymentTuples(expectedPayments))) {
      fail(`${artifact.id} salary payments do not close one-to-one by subject and amount over salary rows.`);
    }
    const certificateFileId = artifact.attestation?.salaryCertificateFileId;
    const certificateFile = certificateFileId ? sourceFileById.get(certificateFileId) : null;
    const certificateCore = {
      kind: SALARY_FACTS_V2_KIND,
      version: 2,
      artifactId: artifact.id,
      month: audited.month,
      salaryCategoryId: audited.salaryCategoryId,
      salaryCategoryName: audited.salaryCategoryName,
      finalArtifactKind: audited.finalArtifactKind,
      artifactSha256: artifactFile.sha256,
      storeReference: audited.storeReference,
      grossPayTotal: canonicalAmount(audited.grossPayTotal, `${artifact.id}.grossPayTotal`),
      payments: expectedPayments,
      semanticBasis: audited.semanticBasis,
      sourceAuditDigest: freshAudit.sourceBindingDigest,
    };
    const certificate = Object.freeze({ ...certificateCore, certificateDigest: canonicalDigest(certificateCore) });
    return Object.freeze({
      artifactId: artifact.id,
      month: artifact.month,
      salaryCategoryId: artifact.salaryCategoryId,
      salaryCategoryName: artifact.salaryCategoryName,
      finalArtifactKind: artifact.finalArtifactKind,
      artifactPath: artifactFile.path,
      artifactSha256: artifactFile.sha256,
      artifactSize: artifactBinding.size,
      storeReference: artifact.storeReference,
      ...(certificateFile ? { certificatePath: certificateFile.path, certificateSha256: certificateFile.sha256 } : {}),
      certificate,
      semanticBasis: audited.semanticBasis,
    });
  });
  const salaryById = new Map(salaryArtifacts.map((artifact) => [artifact.artifactId, artifact]));

  const verifiedFileIds = new Set([
    ...(publishedAudit?.boundSourceDigests ?? []).map((binding) => binding.fileId),
    ...(freshAudit?.fileBindings ?? []).map((binding) => binding.fileId),
    ...voucherFileIds,
  ]);
  const missingFileAudits = normalized.sourceFiles.filter((file) => !verifiedFileIds.has(file.id));
  if (missingFileAudits.length) {
    fail(`sourceFiles entries did not enter stable hash/type verification: ${missingFileAudits.map((file) => file.id).join(", ")}.`);
  }

  return Object.freeze({
    reimbursementSources: Object.freeze(reimbursementSources),
    salaryArtifacts: Object.freeze(salaryArtifacts),
    salaryById,
    voucherEntries,
    voucherById,
    boundSourcePaths: Object.freeze(normalized.sourceFiles.map((file) => file.path).sort((left, right) => left.localeCompare(right))),
  });
}
