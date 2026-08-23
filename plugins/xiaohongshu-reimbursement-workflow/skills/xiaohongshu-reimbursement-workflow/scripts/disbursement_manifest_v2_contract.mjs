import path from "node:path";

export const DISBURSEMENT_MANIFEST_V1_KIND = "disbursement-archive-manifest-v1";
export const DISBURSEMENT_MANIFEST_V2_KIND = "disbursement-archive-manifest-v2";
export const DISBURSEMENT_SOURCE_REVIEW_V2_KIND = "disbursement-source-review-v2";

export const DISBURSEMENT_SOURCE_FILE_KINDS = Object.freeze([
  "json",
  "text",
  "workbook",
  "image",
  "pdf",
]);

export const DISBURSEMENT_SOURCE_FILE_USAGES = Object.freeze([
  "published_reimbursement_artifact",
  "fresh_reimbursement_evidence",
  "original_manifest_attestation",
  "publish_receipt_attestation",
  "salary_artifact",
  "salary_certificate_attestation",
  "payout_voucher",
]);

export const DISBURSEMENT_REIMBURSEMENT_SOURCE_MODES = Object.freeze([
  "published_archive",
  "fresh_evidence",
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SIGNED_AMOUNT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u;
const UNSIGNED_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u;
const DATE_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const MONTH_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/u;
const UTC_TIMESTAMP_RE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/u;
const XML10_FORBIDDEN_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;
const PROFILE_IDS = new Set(["xiaohongshu", "company", "residence"]);
const FILE_KINDS = new Set(DISBURSEMENT_SOURCE_FILE_KINDS);
const FILE_USAGES = new Set(DISBURSEMENT_SOURCE_FILE_USAGES);
const REIMBURSEMENT_MODES = new Set(DISBURSEMENT_REIMBURSEMENT_SOURCE_MODES);
const SCOPE_STATUSES = new Set(["in_batch", "not_in_batch"]);
const PAYOUT_STATUSES = new Set([
  "not_applicable",
  "reconciled",
  "pending_evidence",
  "pending_confirmation",
  "retained_by_self",
  "exception",
]);
const PAYMENT_METHODS = new Set(["transfer", "cash", "none"]);
const ADJUSTMENT_KINDS = new Set(["none", "rounding_tail"]);

function fail(message) {
  throw new Error(`Disbursement Manifest v2 Contract ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function exact(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function array(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  if (nonEmpty && value.length === 0) fail(`${field} must not be empty.`);
  return value;
}

function text(value, field, { maxLength = 500, singleLine = true } = {}) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value
    || value.length > maxLength
    || (singleLine && /[\r\n\t]/u.test(value))
    || XML10_FORBIDDEN_RE.test(value)
  ) {
    fail(`${field} must be a trimmed non-empty${singleLine ? " single-line" : ""} XML 1.0 string of at most ${maxLength} characters.`);
  }
  return value;
}

function id(value, field) {
  const result = text(value, field, { maxLength: 96 });
  if (!ID_RE.test(result)) fail(`${field} must use a safe ASCII identifier.`);
  return result;
}

function enumValue(value, allowed, field) {
  const result = text(value, field, { maxLength: 100 });
  if (!allowed.has(result)) fail(`${field} is not an allowed value.`);
  return result;
}

function sha256(value, field) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function amount(value, field, { allowNegative = false } = {}) {
  const expression = allowNegative ? SIGNED_AMOUNT_RE : UNSIGNED_AMOUNT_RE;
  if (typeof value !== "string" || !expression.test(value) || (allowNegative && /^-0(?:\.0+)?$/u.test(value))) {
    fail(`${field} must be a ${allowNegative ? "signed" : "non-negative"} decimal string with at most three decimal places and no negative zero.`);
  }
  return value;
}

function isoDate(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${field} must be a real calendar date.`);
  return value;
}

function salaryMonth(value, field) {
  if (typeof value !== "string" || !MONTH_RE.test(value)) fail(`${field} must use YYYY-MM.`);
  return value;
}

function utcTimestamp(value, field) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be a real UTC timestamp in YYYY-MM-DDTHH:mm:ss[.sss]Z form.`);
  }
  return value;
}

function absolutePath(value, field) {
  const result = text(value, field, { maxLength: 32_000 });
  if (!path.isAbsolute(result)) fail(`${field} must be absolute.`);
  return path.resolve(result);
}

function relativeReference(value, field) {
  const result = text(value, field, { maxLength: 1_000 });
  if (path.isAbsolute(result) || result.includes("\\") || result.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${field} must be a safe forward-slash relative reference.`);
  }
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative safe integer.`);
  return value;
}

function uniqueIds(values, field, { nonEmpty = false } = {}) {
  const result = array(values, field, { nonEmpty }).map((value, index) => id(value, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${field} must not contain duplicates.`);
  return result;
}

function sameMembers(left, right) {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => new Set(right).has(value));
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateEnvelopeObject(raw) {
  object(raw, "manifest");
  if (!Object.hasOwn(raw, "kind") || !Object.hasOwn(raw, "version")) {
    fail("manifest must declare kind and version before dispatch; fields are never used to guess a version.");
  }
  if (typeof raw.kind !== "string" || !Number.isSafeInteger(raw.version)) {
    fail("manifest kind must be text and version must be a safe integer.");
  }
}

/**
 * Selects only from the exact, frozen kind/version pairs. It deliberately does
 * not inspect any other field and does not validate the selected schema.
 */
export function dispatchDisbursementManifestVersion(raw) {
  validateEnvelopeObject(raw);
  if (raw.kind === DISBURSEMENT_MANIFEST_V1_KIND && raw.version === 1) return 1;
  if (raw.kind === DISBURSEMENT_MANIFEST_V2_KIND && raw.version === 2) return 2;
  if (
    raw.kind === DISBURSEMENT_MANIFEST_V1_KIND
    || raw.kind === DISBURSEMENT_MANIFEST_V2_KIND
    || raw.version === 1
    || raw.version === 2
  ) {
    fail(`manifest kind/version pair ${JSON.stringify(raw.kind)}/${raw.version} is mismatched or unsupported.`);
  }
  fail(`manifest kind/version pair ${JSON.stringify(raw.kind)}/${raw.version} is unsupported.`);
}

function requireBoundFile(fileById, fileId, field, { usage, kinds } = {}) {
  const checkedId = id(fileId, field);
  const file = fileById.get(checkedId);
  if (!file) fail(`${field} references unknown sourceFiles id ${checkedId}.`);
  if (usage && !file.usage.includes(usage)) fail(`${field} must reference a sourceFiles entry with usage ${usage}.`);
  if (kinds && !kinds.has(file.kind)) fail(`${field} references a sourceFiles entry with an incompatible kind.`);
  return checkedId;
}

function validatePeriod(raw, field) {
  exact(raw, new Set(["start", "end"]), new Set(), field);
  return {
    start: isoDate(raw.start, `${field}.start`),
    end: isoDate(raw.end, `${field}.end`),
  };
}

function validateSourceReview(raw, {
  reimbursementById,
  salaryById,
  fileById,
}) {
  exact(raw,
    new Set(["kind", "version", "id", "producer", "generatedAt", "reimbursement", "salary"]),
    new Set(), "sourceReview");
  if (raw.kind !== DISBURSEMENT_SOURCE_REVIEW_V2_KIND || raw.version !== 2) {
    fail("sourceReview kind/version must be disbursement-source-review-v2/2.");
  }
  id(raw.id, "sourceReview.id");
  if (raw.producer !== "task_internal") fail("sourceReview.producer must be task_internal.");
  utcTimestamp(raw.generatedAt, "sourceReview.generatedAt");

  const reviewIds = new Set();
  const reimbursementReviewBySourceId = new Map();
  const reimbursementTransactions = new Map();
  for (const [index, review] of array(raw.reimbursement, "sourceReview.reimbursement").entries()) {
    const field = `sourceReview.reimbursement[${index}]`;
    exact(review, new Set(["id", "sourceId", "mode", "reviewedFileIds", "facts"]), new Set(), field);
    const reviewId = id(review.id, `${field}.id`);
    if (reviewIds.has(reviewId)) fail(`${field}.id is duplicated across sourceReview items.`);
    reviewIds.add(reviewId);
    const sourceId = id(review.sourceId, `${field}.sourceId`);
    const source = reimbursementById.get(sourceId);
    if (!source) fail(`${field}.sourceId is unknown.`);
    if (reimbursementReviewBySourceId.has(sourceId)) fail(`${field}.sourceId has more than one review item.`);
    const mode = enumValue(review.mode, REIMBURSEMENT_MODES, `${field}.mode`);
    if (mode !== source.mode) fail(`${field}.mode differs from its reimbursement source.`);
    const reviewedFileIds = uniqueIds(review.reviewedFileIds, `${field}.reviewedFileIds`, { nonEmpty: true });
    for (const [fileIndex, fileId] of reviewedFileIds.entries()) {
      requireBoundFile(fileById, fileId, `${field}.reviewedFileIds[${fileIndex}]`);
    }
    if (!sameMembers(reviewedFileIds, source.boundFileIds)) {
      fail(`${field}.reviewedFileIds must bind every and only the files declared by its reimbursement source.`);
    }

    exact(review.facts, new Set(["batchId", "reimbursementPeriod", "transactions"]), new Set(), `${field}.facts`);
    id(review.facts.batchId, `${field}.facts.batchId`);
    validatePeriod(review.facts.reimbursementPeriod, `${field}.facts.reimbursementPeriod`);
    const transactionIds = new Set();
    const transactions = new Set();
    for (const [transactionIndex, transaction] of array(review.facts.transactions, `${field}.facts.transactions`, { nonEmpty: true }).entries()) {
      const transactionField = `${field}.facts.transactions[${transactionIndex}]`;
      exact(transaction, new Set(["id", "date", "person", "reimbursementAmount"]), new Set(), transactionField);
      const transactionId = id(transaction.id, `${transactionField}.id`);
      if (transactionIds.has(transactionId)) fail(`${transactionField}.id is duplicated within the source review.`);
      transactionIds.add(transactionId);
      isoDate(transaction.date, `${transactionField}.date`);
      text(transaction.person, `${transactionField}.person`, { maxLength: 200 });
      amount(transaction.reimbursementAmount, `${transactionField}.reimbursementAmount`, { allowNegative: true });
      transactions.add(transactionId);
    }
    reimbursementTransactions.set(sourceId, transactions);
    reimbursementReviewBySourceId.set(sourceId, review);
  }

  const salaryReviewByArtifactId = new Map();
  for (const [index, review] of array(raw.salary, "sourceReview.salary").entries()) {
    const field = `sourceReview.salary[${index}]`;
    exact(review, new Set(["id", "salaryArtifactId", "mode", "reviewedFileIds", "facts"]), new Set(), field);
    const reviewId = id(review.id, `${field}.id`);
    if (reviewIds.has(reviewId)) fail(`${field}.id is duplicated across sourceReview items.`);
    reviewIds.add(reviewId);
    const artifactId = id(review.salaryArtifactId, `${field}.salaryArtifactId`);
    const artifact = salaryById.get(artifactId);
    if (!artifact) fail(`${field}.salaryArtifactId is unknown.`);
    if (salaryReviewByArtifactId.has(artifactId)) fail(`${field}.salaryArtifactId has more than one review item.`);
    if (review.mode !== "final_artifact") fail(`${field}.mode must be final_artifact.`);
    const reviewedFileIds = uniqueIds(review.reviewedFileIds, `${field}.reviewedFileIds`, { nonEmpty: true });
    for (const [fileIndex, fileId] of reviewedFileIds.entries()) {
      requireBoundFile(fileById, fileId, `${field}.reviewedFileIds[${fileIndex}]`);
    }
    if (!sameMembers(reviewedFileIds, artifact.boundFileIds)) {
      fail(`${field}.reviewedFileIds must bind every and only the files declared by its salary artifact.`);
    }

    exact(review.facts,
      new Set(["month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "storeReference", "grossPayTotal", "payments"]),
      new Set(), `${field}.facts`);
    salaryMonth(review.facts.month, `${field}.facts.month`);
    id(review.facts.salaryCategoryId, `${field}.facts.salaryCategoryId`);
    text(review.facts.salaryCategoryName, `${field}.facts.salaryCategoryName`, { maxLength: 100 });
    enumValue(review.facts.finalArtifactKind, new Set(["workbook", "image"]), `${field}.facts.finalArtifactKind`);
    relativeReference(review.facts.storeReference, `${field}.facts.storeReference`);
    amount(review.facts.grossPayTotal, `${field}.facts.grossPayTotal`);
    const paymentIds = new Set();
    for (const [paymentIndex, payment] of array(review.facts.payments, `${field}.facts.payments`, { nonEmpty: true }).entries()) {
      const paymentField = `${field}.facts.payments[${paymentIndex}]`;
      exact(payment, new Set(["id", "subject", "amount"]), new Set(), paymentField);
      const paymentId = id(payment.id, `${paymentField}.id`);
      if (paymentIds.has(paymentId)) fail(`${paymentField}.id is duplicated within the salary review.`);
      paymentIds.add(paymentId);
      text(payment.subject, `${paymentField}.subject`, { maxLength: 200 });
      amount(payment.amount, `${paymentField}.amount`);
    }
    salaryReviewByArtifactId.set(artifactId, review);
  }

  for (const sourceId of reimbursementById.keys()) {
    if (!reimbursementReviewBySourceId.has(sourceId)) fail(`reimbursement source ${sourceId} is missing its task-internal sourceReview item.`);
  }
  for (const artifactId of salaryById.keys()) {
    if (!salaryReviewByArtifactId.has(artifactId)) fail(`salary artifact ${artifactId} is missing its task-internal sourceReview item.`);
  }
  return { reimbursementTransactions };
}

/**
 * Validates only the frozen v2 JSON structure, identifiers, references and
 * primitive formats. It never reads a source file or accepts a sidecar review.
 */
export function validateDisbursementManifestV2(raw) {
  const selectedVersion = dispatchDisbursementManifestVersion(raw);
  if (selectedVersion !== 2) fail("validateDisbursementManifestV2 requires the exact v2 kind/version pair.");
  const manifest = structuredClone(raw);
  exact(manifest,
    new Set(["kind", "version", "batch", "sourceFiles", "reimbursementSources", "salaryArtifacts", "vouchers", "rows", "sourceReview", "expected"]),
    new Set(), "manifest");

  exact(manifest.batch,
    new Set(["batchId", "archiveParentPath", "nameRevision"]),
    new Set(["reimbursementPeriod"]), "batch");
  id(manifest.batch.batchId, "batch.batchId");
  manifest.batch.archiveParentPath = absolutePath(manifest.batch.archiveParentPath, "batch.archiveParentPath");
  positiveInteger(manifest.batch.nameRevision, "batch.nameRevision");
  if (manifest.batch.reimbursementPeriod !== undefined) validatePeriod(manifest.batch.reimbursementPeriod, "batch.reimbursementPeriod");

  const fileById = new Map();
  const fileByPath = new Map();
  const kindByDigest = new Map();
  for (const [index, file] of array(manifest.sourceFiles, "sourceFiles", { nonEmpty: true }).entries()) {
    const field = `sourceFiles[${index}]`;
    exact(file, new Set(["id", "path", "sha256", "kind", "usage"]), new Set(), field);
    const fileId = id(file.id, `${field}.id`);
    if (fileById.has(fileId)) fail(`${field}.id is duplicated.`);
    file.path = absolutePath(file.path, `${field}.path`);
    const digest = sha256(file.sha256, `${field}.sha256`);
    const kind = enumValue(file.kind, FILE_KINDS, `${field}.kind`);
    const usage = array(file.usage, `${field}.usage`, { nonEmpty: true })
      .map((value, usageIndex) => enumValue(value, FILE_USAGES, `${field}.usage[${usageIndex}]`));
    if (new Set(usage).size !== usage.length) fail(`${field}.usage must not contain duplicates.`);
    const identity = pathIdentity(file.path);
    const previousPath = fileByPath.get(identity);
    if (previousPath) {
      const detail = previousPath.sha256 === digest && previousPath.kind === kind
        ? "duplicates one registered path"
        : "conflicts with the SHA-256 or kind registered for the same path";
      fail(`${field} ${detail}; sourceFiles is the unique file identity registry.`);
    }
    const previousKind = kindByDigest.get(digest);
    if (previousKind && previousKind !== kind) fail(`${field}.kind conflicts with another sourceFiles entry for the same SHA-256 identity.`);
    kindByDigest.set(digest, kind);
    const normalized = { id: fileId, path: file.path, sha256: digest, kind, usage };
    fileById.set(fileId, normalized);
    fileByPath.set(identity, normalized);
  }

  const referencedSourceFileIds = new Set();
  const reimbursementById = new Map();
  for (const [index, source] of array(manifest.reimbursementSources, "reimbursementSources").entries()) {
    const field = `reimbursementSources[${index}]`;
    exact(source, new Set(["id", "profileId", "mode", "inputFileIds"]), new Set(["attestations"]), field);
    const sourceId = id(source.id, `${field}.id`);
    if (reimbursementById.has(sourceId)) fail(`${field}.id is duplicated.`);
    enumValue(source.profileId, PROFILE_IDS, `${field}.profileId`);
    const mode = enumValue(source.mode, REIMBURSEMENT_MODES, `${field}.mode`);
    const inputFileIds = uniqueIds(source.inputFileIds, `${field}.inputFileIds`, { nonEmpty: true });
    const inputUsage = mode === "published_archive" ? "published_reimbursement_artifact" : "fresh_reimbursement_evidence";
    for (const [fileIndex, fileId] of inputFileIds.entries()) {
      requireBoundFile(fileById, fileId, `${field}.inputFileIds[${fileIndex}]`, { usage: inputUsage });
      referencedSourceFileIds.add(fileId);
    }
    const attestationFileIds = [];
    if (source.attestations !== undefined) {
      exact(source.attestations, new Set(), new Set(["originalManifestFileId", "receiptFileId"]), `${field}.attestations`);
      if (Object.keys(source.attestations).length === 0) fail(`${field}.attestations must contain at least one attestation when provided.`);
      if (source.attestations.originalManifestFileId !== undefined) {
        const fileId = requireBoundFile(fileById, source.attestations.originalManifestFileId, `${field}.attestations.originalManifestFileId`, {
          usage: "original_manifest_attestation",
          kinds: new Set(["json"]),
        });
        attestationFileIds.push(fileId);
        referencedSourceFileIds.add(fileId);
      }
      if (source.attestations.receiptFileId !== undefined) {
        const fileId = requireBoundFile(fileById, source.attestations.receiptFileId, `${field}.attestations.receiptFileId`, {
          usage: "publish_receipt_attestation",
          kinds: new Set(["json"]),
        });
        attestationFileIds.push(fileId);
        referencedSourceFileIds.add(fileId);
      }
    }
    reimbursementById.set(sourceId, {
      id: sourceId,
      mode,
      boundFileIds: [...inputFileIds, ...attestationFileIds],
    });
  }

  const salaryById = new Map();
  for (const [index, artifact] of array(manifest.salaryArtifacts, "salaryArtifacts").entries()) {
    const field = `salaryArtifacts[${index}]`;
    exact(artifact,
      new Set(["id", "month", "salaryCategoryId", "salaryCategoryName", "finalArtifactKind", "fileId", "storeReference"]),
      new Set(["attestation"]), field);
    const artifactId = id(artifact.id, `${field}.id`);
    if (salaryById.has(artifactId)) fail(`${field}.id is duplicated.`);
    salaryMonth(artifact.month, `${field}.month`);
    id(artifact.salaryCategoryId, `${field}.salaryCategoryId`);
    text(artifact.salaryCategoryName, `${field}.salaryCategoryName`, { maxLength: 100 });
    const finalArtifactKind = enumValue(artifact.finalArtifactKind, new Set(["workbook", "image"]), `${field}.finalArtifactKind`);
    const fileId = requireBoundFile(fileById, artifact.fileId, `${field}.fileId`, {
      usage: "salary_artifact",
      kinds: new Set([finalArtifactKind]),
    });
    referencedSourceFileIds.add(fileId);
    relativeReference(artifact.storeReference, `${field}.storeReference`);
    const boundFileIds = [fileId];
    if (artifact.attestation !== undefined) {
      exact(artifact.attestation, new Set(["salaryCertificateFileId"]), new Set(), `${field}.attestation`);
      const certificateFileId = requireBoundFile(fileById, artifact.attestation.salaryCertificateFileId, `${field}.attestation.salaryCertificateFileId`, {
        usage: "salary_certificate_attestation",
        kinds: new Set(["json"]),
      });
      boundFileIds.push(certificateFileId);
      referencedSourceFileIds.add(certificateFileId);
    }
    salaryById.set(artifactId, { id: artifactId, boundFileIds });
  }

  if (reimbursementById.size === 0 && salaryById.size === 0) fail("manifest must contain a reimbursement source and/or a salary artifact.");
  if (reimbursementById.size > 0 && manifest.batch.reimbursementPeriod === undefined) {
    fail("batch.reimbursementPeriod is required when reimbursementSources is not empty.");
  }
  if (reimbursementById.size === 0 && manifest.batch.reimbursementPeriod !== undefined) {
    fail("batch.reimbursementPeriod must be omitted for a salary-only manifest.");
  }

  const voucherById = new Map();
  for (const [index, voucher] of array(manifest.vouchers, "vouchers").entries()) {
    const field = `vouchers[${index}]`;
    exact(voucher, new Set(["id", "fileId"]), new Set(), field);
    const voucherId = id(voucher.id, `${field}.id`);
    if (voucherById.has(voucherId)) fail(`${field}.id is duplicated.`);
    const fileId = requireBoundFile(fileById, voucher.fileId, `${field}.fileId`, {
      usage: "payout_voucher",
      kinds: new Set(["image", "pdf"]),
    });
    referencedSourceFileIds.add(fileId);
    voucherById.set(voucherId, { id: voucherId, fileId });
  }

  const { reimbursementTransactions } = validateSourceReview(manifest.sourceReview, {
    reimbursementById,
    salaryById,
    fileById,
  });

  const rowIds = new Set();
  const rowOrders = new Set();
  const adjustmentSourceRefs = [];
  for (const [index, row] of array(manifest.rows, "rows", { nonEmpty: true }).entries()) {
    const field = `rows[${index}]`;
    exact(row,
      new Set(["id", "order", "subject", "scopeStatus", "payoutStatus", "paymentMethod", "adjustmentKind", "amounts", "paidAmount", "reimbursementRefs", "voucherRefs"]),
      new Set(["salaryArtifactId", "note", "reason", "followUp", "targetBatch", "retentionProof", "adjustment"]), field);
    const rowId = id(row.id, `${field}.id`);
    if (rowIds.has(rowId)) fail(`${field}.id is duplicated.`);
    rowIds.add(rowId);
    const order = positiveInteger(row.order, `${field}.order`);
    if (rowOrders.has(order)) fail(`${field}.order is duplicated.`);
    rowOrders.add(order);
    text(row.subject, `${field}.subject`, { maxLength: 200 });
    enumValue(row.scopeStatus, SCOPE_STATUSES, `${field}.scopeStatus`);
    enumValue(row.payoutStatus, PAYOUT_STATUSES, `${field}.payoutStatus`);
    enumValue(row.paymentMethod, PAYMENT_METHODS, `${field}.paymentMethod`);
    enumValue(row.adjustmentKind, ADJUSTMENT_KINDS, `${field}.adjustmentKind`);
    exact(row.amounts, new Set(["xiaohongshu", "company", "residence", "salary"]), new Set(), `${field}.amounts`);
    amount(row.amounts.xiaohongshu, `${field}.amounts.xiaohongshu`, { allowNegative: true });
    amount(row.amounts.company, `${field}.amounts.company`, { allowNegative: true });
    amount(row.amounts.residence, `${field}.amounts.residence`, { allowNegative: true });
    amount(row.amounts.salary, `${field}.amounts.salary`);
    amount(row.paidAmount, `${field}.paidAmount`, { allowNegative: true });

    const reimbursementRefKeys = new Set();
    for (const [refIndex, reference] of array(row.reimbursementRefs, `${field}.reimbursementRefs`).entries()) {
      const refField = `${field}.reimbursementRefs[${refIndex}]`;
      exact(reference, new Set(["sourceId", "transactionId", "amount"]), new Set(), refField);
      const sourceId = id(reference.sourceId, `${refField}.sourceId`);
      const transactionId = id(reference.transactionId, `${refField}.transactionId`);
      const transactions = reimbursementTransactions.get(sourceId);
      if (!transactions) fail(`${refField}.sourceId is unknown.`);
      if (!transactions.has(transactionId)) fail(`${refField}.transactionId is unknown for source ${sourceId}.`);
      const key = `${sourceId}\u0000${transactionId}`;
      if (reimbursementRefKeys.has(key)) fail(`${field}.reimbursementRefs must not repeat one source/transaction pair.`);
      reimbursementRefKeys.add(key);
      amount(reference.amount, `${refField}.amount`, { allowNegative: true });
    }

    if (row.salaryArtifactId !== undefined) {
      const artifactId = id(row.salaryArtifactId, `${field}.salaryArtifactId`);
      if (!salaryById.has(artifactId)) fail(`${field}.salaryArtifactId is unknown.`);
    }
    const voucherRefs = uniqueIds(row.voucherRefs, `${field}.voucherRefs`);
    for (const [refIndex, voucherId] of voucherRefs.entries()) {
      if (!voucherById.has(voucherId)) fail(`${field}.voucherRefs[${refIndex}] is unknown.`);
    }
    for (const optionalField of ["note", "reason", "followUp", "targetBatch"]) {
      if (row[optionalField] !== undefined) text(row[optionalField], `${field}.${optionalField}`, { maxLength: 500 });
    }
    if (row.retentionProof !== undefined) {
      exact(row.retentionProof, new Set(["fundsReceivedVoucherRefs", "decisionVoucherRefs"]), new Set(), `${field}.retentionProof`);
      for (const proofField of ["fundsReceivedVoucherRefs", "decisionVoucherRefs"]) {
        const proofRefs = uniqueIds(row.retentionProof[proofField], `${field}.retentionProof.${proofField}`);
        for (const voucherId of proofRefs) if (!voucherById.has(voucherId)) fail(`${field}.retentionProof.${proofField} references unknown voucher ${voucherId}.`);
      }
    }
    if (row.adjustment !== undefined) {
      exact(row.adjustment, new Set(["amount", "sourceRowId", "reason", "tolerance", "authorization"]), new Set(), `${field}.adjustment`);
      amount(row.adjustment.amount, `${field}.adjustment.amount`, { allowNegative: true });
      const sourceRowId = id(row.adjustment.sourceRowId, `${field}.adjustment.sourceRowId`);
      adjustmentSourceRefs.push({ field: `${field}.adjustment.sourceRowId`, sourceRowId });
      text(row.adjustment.reason, `${field}.adjustment.reason`, { maxLength: 500 });
      amount(row.adjustment.tolerance, `${field}.adjustment.tolerance`);
      text(row.adjustment.authorization, `${field}.adjustment.authorization`, { maxLength: 500 });
    }
  }
  for (const { field, sourceRowId } of adjustmentSourceRefs) if (!rowIds.has(sourceRowId)) fail(`${field} is unknown.`);
  for (let order = 1; order <= rowOrders.size; order += 1) if (!rowOrders.has(order)) fail("rows[].order must be contiguous from 1.");

  exact(manifest.expected,
    new Set(["rowCount", "inBatchDueTotal", "inBatchPaidTotal", "reconciledTotal", "uniqueVoucherCount", "voucherReferenceCount", "roundingTailTotal", "salarySlotCount"]),
    new Set(), "expected");
  nonNegativeInteger(manifest.expected.rowCount, "expected.rowCount");
  nonNegativeInteger(manifest.expected.uniqueVoucherCount, "expected.uniqueVoucherCount");
  nonNegativeInteger(manifest.expected.voucherReferenceCount, "expected.voucherReferenceCount");
  nonNegativeInteger(manifest.expected.salarySlotCount, "expected.salarySlotCount");
  for (const field of ["inBatchDueTotal", "inBatchPaidTotal", "reconciledTotal", "roundingTailTotal"]) {
    amount(manifest.expected[field], `expected.${field}`, { allowNegative: true });
  }

  const unreferencedFiles = [...fileById.keys()].filter((fileId) => !referencedSourceFileIds.has(fileId));
  if (unreferencedFiles.length > 0) fail(`sourceFiles contains unreferenced entries: ${unreferencedFiles.join(", ")}.`);
  return deepFreeze(manifest);
}
