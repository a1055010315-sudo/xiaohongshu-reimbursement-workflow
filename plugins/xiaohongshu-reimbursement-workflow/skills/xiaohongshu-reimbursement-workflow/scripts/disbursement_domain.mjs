import { formatMilliunits, parseMilliunits } from "./finance_domain.mjs";

export const DISBURSEMENT_PROFILE_ORDER = Object.freeze(["xiaohongshu", "company", "residence"]);
export const DISBURSEMENT_PROFILE_NAMES = Object.freeze({
  xiaohongshu: "小红书报销",
  company: "公司报销",
  residence: "驻所报销",
});
export const DISBURSEMENT_VISIBLE_STATUSES = Object.freeze([
  "已核销",
  "待凭证",
  "待现金确认",
  "异常待说明",
  "非本批",
  "已忽略尾差",
]);

const PROFILE_SET = new Set(DISBURSEMENT_PROFILE_ORDER);
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
  throw new Error(`Compact Disbursement Domain ${message}`);
}

export function assertXml10Text(value, field = "text") {
  if (typeof value !== "string") fail(`${field} must be text.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) {
      fail(`${field} contains a character forbidden by XML 1.0.`);
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${field} contains an unpaired Unicode surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${field} contains an unpaired Unicode surrogate.`);
    }
  }
  return value;
}

function trimmedText(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) {
    fail(`${field} must be a trimmed non-empty single-line string.`);
  }
  return assertXml10Text(value, field);
}

function requireEnum(value, allowed, field) {
  const checked = trimmedText(value, field);
  if (!allowed.has(checked)) fail(`${field} is not an allowed value.`);
  return checked;
}

function optionalArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array.`);
  return value;
}

function requireReason(value, field) {
  const result = trimmedText(value, field);
  if (result.length > 500) fail(`${field} must be at most 500 characters.`);
  return result;
}

function ensureNoPositiveAmounts(amounts, field) {
  for (const [key, value] of Object.entries(amounts)) {
    if (value !== 0n) fail(`${field}.${key} must be zero for a rounding-tail row.`);
  }
}

export function parseDisbursementAmount(value, field, options = {}) {
  try {
    return parseMilliunits(value, field, options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function formatDisbursementAmount(value) {
  try {
    return formatMilliunits(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeReimbursementProfileIds(values, field = "profileIds") {
  if (!Array.isArray(values)) fail(`${field} must be an array.`);
  const unique = new Set();
  for (const value of values) {
    const profileId = trimmedText(value, `${field}[]`);
    if (!PROFILE_SET.has(profileId)) fail(`${field} contains an unknown reimbursement profile.`);
    unique.add(profileId);
  }
  return Object.freeze(DISBURSEMENT_PROFILE_ORDER.filter((profileId) => unique.has(profileId)));
}

export function normalizeSalaryMonth(value, field = "salaryMonth") {
  const month = trimmedText(value, field);
  if (!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/u.test(month)) fail(`${field} must use YYYY-MM.`);
  return month;
}

export function normalizeDisbursementIsoDate(value, field) {
  const result = trimmedText(value, field);
  if (!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(result)) {
    fail(`${field} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result) fail(`${field} is not a real calendar date.`);
  return result;
}

function displayIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}.${month}.${day}`;
}

export function buildCompactDisbursementBatchName({
  reimbursementPeriod,
  profileIds,
  salaryMonth,
  nameRevision = 1,
}) {
  const orderedProfiles = normalizeReimbursementProfileIds(profileIds);
  const checkedSalaryMonth = salaryMonth === null || salaryMonth === undefined
    ? null
    : normalizeSalaryMonth(salaryMonth);
  if (orderedProfiles.length === 0 && checkedSalaryMonth === null) fail("batch components must not be empty.");
  if (!Number.isSafeInteger(nameRevision) || nameRevision < 1) fail("nameRevision must be a positive safe integer.");

  let reimbursementPart = null;
  let periodPart = null;
  if (orderedProfiles.length > 0) {
    if (!reimbursementPeriod || typeof reimbursementPeriod !== "object" || Array.isArray(reimbursementPeriod)) {
      fail("reimbursementPeriod is required when a reimbursement component is present.");
    }
    const start = normalizeDisbursementIsoDate(reimbursementPeriod.start, "reimbursementPeriod.start");
    const end = normalizeDisbursementIsoDate(reimbursementPeriod.end, "reimbursementPeriod.end");
    if (start > end) fail("reimbursementPeriod.start must not be after reimbursementPeriod.end.");
    periodPart = `${displayIsoDate(start)}-${displayIsoDate(end)}`;
    reimbursementPart = orderedProfiles.length === 3
      ? "三类报销"
      : orderedProfiles.map((profileId) => DISBURSEMENT_PROFILE_NAMES[profileId]).join("+");
  } else if (reimbursementPeriod !== null && reimbursementPeriod !== undefined) {
    fail("reimbursementPeriod must be omitted for a salary-only batch.");
  }

  const salaryPart = checkedSalaryMonth === null ? null : `${checkedSalaryMonth.replace("-", ".")}工资`;
  const core = reimbursementPart
    ? `${periodPart}_${reimbursementPart}${salaryPart ? `+${salaryPart}` : ""}`
    : salaryPart;
  return `${core}${nameRevision === 1 ? "" : `_修订${nameRevision}`}`;
}

export function normalizeRowAmounts(rawAmounts, field = "amounts") {
  if (!rawAmounts || typeof rawAmounts !== "object" || Array.isArray(rawAmounts)) fail(`${field} must be an object.`);
  const exactKeys = new Set([...DISBURSEMENT_PROFILE_ORDER, "salary"]);
  for (const key of Object.keys(rawAmounts)) if (!exactKeys.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of exactKeys) if (!Object.hasOwn(rawAmounts, key)) fail(`${field} is missing ${key}.`);
  const milliunits = Object.freeze(Object.fromEntries([...exactKeys].map((key) => [
    key,
    parseDisbursementAmount(rawAmounts[key], `${field}.${key}`, { allowNegative: key !== "salary" }),
  ])));
  const total = Object.values(milliunits).reduce((sum, value) => sum + value, 0n);
  return Object.freeze({
    milliunits,
    canonical: Object.freeze(Object.fromEntries(
      [...exactKeys].map((key) => [key, formatDisbursementAmount(milliunits[key])]),
    )),
    total,
  });
}

export function resolveVisibleDisbursementStatus(rawRow, {
  amounts,
  paidAmount,
  voucherRefs,
} = {}) {
  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) fail("row must be an object.");
  const scopeStatus = requireEnum(rawRow.scopeStatus, SCOPE_STATUSES, "scopeStatus");
  const payoutStatus = requireEnum(rawRow.payoutStatus, PAYOUT_STATUSES, "payoutStatus");
  const paymentMethod = requireEnum(rawRow.paymentMethod, PAYMENT_METHODS, "paymentMethod");
  const adjustmentKind = requireEnum(rawRow.adjustmentKind, ADJUSTMENT_KINDS, "adjustmentKind");
  const normalizedAmounts = amounts ?? normalizeRowAmounts(rawRow.amounts).milliunits;
  const normalizedPaid = paidAmount ?? parseDisbursementAmount(rawRow.paidAmount, "paidAmount", { allowNegative: true });
  const normalizedVoucherRefs = voucherRefs ?? optionalArray(rawRow.voucherRefs, "voucherRefs");

  if (scopeStatus === "not_in_batch") {
    if (payoutStatus !== "not_applicable" || paymentMethod !== "none" || adjustmentKind !== "none") {
      fail("a not-in-batch row must use not_applicable, none, and no adjustment.");
    }
    if (normalizedPaid !== 0n) fail("a not-in-batch row must have zero actual payout.");
    requireReason(rawRow.reason, "reason");
    requireReason(rawRow.targetBatch, "targetBatch");
    return "非本批";
  }

  if (adjustmentKind === "rounding_tail") {
    if (payoutStatus !== "not_applicable" || paymentMethod !== "none" || normalizedPaid !== 0n) {
      fail("a rounding-tail row must be not_applicable, use no payment method, and have zero actual payout.");
    }
    ensureNoPositiveAmounts(normalizedAmounts, "amounts");
    const adjustment = rawRow.adjustment;
    if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) fail("a rounding-tail row requires adjustment details.");
    const amount = parseDisbursementAmount(adjustment.amount, "adjustment.amount", { allowNegative: true });
    const tolerance = parseDisbursementAmount(adjustment.tolerance, "adjustment.tolerance");
    if (amount === 0n || tolerance === 0n || (amount < 0n ? -amount : amount) > tolerance) {
      fail("adjustment.amount must be non-zero and within its positive tolerance.");
    }
    trimmedText(adjustment.sourceRowId, "adjustment.sourceRowId");
    requireReason(adjustment.reason, "adjustment.reason");
    requireReason(adjustment.authorization, "adjustment.authorization");
    if (normalizedVoucherRefs.length !== 0) fail("a rounding-tail row must not bind payout vouchers.");
    return "已忽略尾差";
  }

  if (payoutStatus === "not_applicable") fail("not_applicable is only valid for non-batch or rounding-tail rows.");
  if (payoutStatus === "reconciled") {
    if (paymentMethod === "none") fail("a reconciled transfer/cash row must identify its payment method.");
    if (normalizedPaid !== Object.values(normalizedAmounts).reduce((sum, value) => sum + value, 0n)) {
      fail("a reconciled row actual payout must equal its payable amount.");
    }
    if (normalizedVoucherRefs.length === 0) fail("a reconciled row requires at least one voucher reference.");
    return "已核销";
  }
  if (payoutStatus === "retained_by_self") {
    if (paymentMethod !== "none") fail("a retained-by-self row must use paymentMethod none.");
    const payable = Object.values(normalizedAmounts).reduce((sum, value) => sum + value, 0n);
    if (payable <= 0n) fail("a retained-by-self row must have a positive payable amount.");
    if (normalizedPaid !== payable) {
      fail("a retained-by-self row actual payout must equal its payable amount.");
    }
    const proof = rawRow.retentionProof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) fail("a retained-by-self row requires retentionProof.");
    const received = optionalArray(proof.fundsReceivedVoucherRefs, "retentionProof.fundsReceivedVoucherRefs");
    const decision = optionalArray(proof.decisionVoucherRefs, "retentionProof.decisionVoucherRefs");
    if (received.length === 0 || decision.length === 0) fail("retentionProof requires both funds-received and retention-decision evidence.");
    const bound = new Set(normalizedVoucherRefs);
    if (![...received, ...decision].every((id) => bound.has(id))) fail("retentionProof references must also appear in voucherRefs.");
    return "已核销";
  }
  if (payoutStatus === "pending_evidence") {
    requireReason(rawRow.reason, "reason");
    requireReason(rawRow.followUp, "followUp");
    return "待凭证";
  }
  if (payoutStatus === "pending_confirmation") {
    if (paymentMethod !== "cash") fail("pending_confirmation is only valid for cash.");
    requireReason(rawRow.reason, "reason");
    requireReason(rawRow.followUp, "followUp");
    return "待现金确认";
  }
  if (payoutStatus === "exception") {
    requireReason(rawRow.reason, "reason");
    requireReason(rawRow.followUp, "followUp");
    return "异常待说明";
  }
  fail("row state could not be mapped to a visible status.");
}

export function paymentMethodDisplay(rawRow) {
  if (rawRow.payoutStatus === "retained_by_self") return "本人留存";
  return Object.freeze({ transfer: "转账", cash: "现金", none: "—" })[rawRow.paymentMethod] ?? fail("paymentMethod is invalid.");
}

export function deriveClosureStatus(rows) {
  if (!Array.isArray(rows)) fail("rows must be an array.");
  const open = rows.some((row) => ["待凭证", "待现金确认", "异常待说明"].includes(row.visibleStatus));
  return open ? "open" : "closed";
}
