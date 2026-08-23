import assert from "node:assert/strict";
import test from "node:test";

import {
  DISBURSEMENT_PROFILE_ORDER,
  DISBURSEMENT_VISIBLE_STATUSES,
  assertXml10Text,
  buildCompactDisbursementBatchName,
  formatDisbursementAmount,
  normalizeRowAmounts,
  parseDisbursementAmount,
  resolveVisibleDisbursementStatus,
} from "../scripts/disbursement_domain.mjs";

const period = Object.freeze({ start: "2026-07-25", end: "2026-08-12" });

test("all 15 non-empty reimbursement/salary component combinations have stable unique names", () => {
  const names = new Set();
  for (let mask = 1; mask < 8; mask += 1) {
    const profiles = DISBURSEMENT_PROFILE_ORDER.filter((_, index) => mask & (1 << index));
    for (const salaryMonth of [null, "2026-07"]) {
      const name = buildCompactDisbursementBatchName({ reimbursementPeriod: period, profileIds: [...profiles].reverse(), salaryMonth });
      names.add(name);
      assert.equal(name, buildCompactDisbursementBatchName({ reimbursementPeriod: period, profileIds: [...profiles, ...profiles], salaryMonth }));
    }
  }
  names.add(buildCompactDisbursementBatchName({ profileIds: [], salaryMonth: "2026-07" }));
  assert.equal(names.size, 15);
  assert.equal(names.has("2026.7.25-2026.8.12_三类报销+2026.07工资"), true);
  assert.equal(names.has("2026.7.25-2026.8.12_小红书报销+驻所报销"), true);
  assert.equal(names.has("2026.07工资"), true);
  assert.equal(buildCompactDisbursementBatchName({ reimbursementPeriod: period, profileIds: ["company"], salaryMonth: null, nameRevision: 2 }), "2026.7.25-2026.8.12_公司报销_修订2");
});

test("legal internal state axes map to exactly six visible statuses", () => {
  const zero = { xiaohongshu: "0", company: "0", residence: "0", salary: "0" };
  const due = { xiaohongshu: "1", company: "0", residence: "0", salary: "0" };
  const cases = [
    [{ scopeStatus: "in_batch", payoutStatus: "reconciled", paymentMethod: "transfer", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: ["v"] }, "已核销"],
    [{ scopeStatus: "in_batch", payoutStatus: "retained_by_self", paymentMethod: "none", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: ["received", "decision"], retentionProof: { fundsReceivedVoucherRefs: ["received"], decisionVoucherRefs: ["decision"] } }, "已核销"],
    [{ scopeStatus: "in_batch", payoutStatus: "pending_evidence", paymentMethod: "transfer", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: [], reason: "缺回单", followUp: "补回单" }, "待凭证"],
    [{ scopeStatus: "in_batch", payoutStatus: "pending_confirmation", paymentMethod: "cash", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: [], reason: "现金待签收", followUp: "补签收" }, "待现金确认"],
    [{ scopeStatus: "in_batch", payoutStatus: "exception", paymentMethod: "transfer", adjustmentKind: "none", amounts: due, paidAmount: "0", voucherRefs: [], reason: "反向转账", followUp: "查明原因" }, "异常待说明"],
    [{ scopeStatus: "not_in_batch", payoutStatus: "not_applicable", paymentMethod: "none", adjustmentKind: "none", amounts: due, paidAmount: "0", voucherRefs: [], reason: "非本批", targetBatch: "下批" }, "非本批"],
    [{ scopeStatus: "in_batch", payoutStatus: "not_applicable", paymentMethod: "none", adjustmentKind: "rounding_tail", amounts: zero, paidAmount: "0", voucherRefs: [], adjustment: { amount: "-0.367", tolerance: "0.5", sourceRowId: "row-1", reason: "尾差", authorization: "财务确认" } }, "已忽略尾差"],
  ];
  const actual = cases.map(([row, expected]) => {
    const status = resolveVisibleDisbursementStatus(row);
    assert.equal(status, expected);
    return status;
  });
  assert.deepEqual([...new Set(actual)], DISBURSEMENT_VISIBLE_STATUSES);
});

test("illegal state combinations, floating precision, and XML control text are rejected", () => {
  const due = { xiaohongshu: "1", company: "0", residence: "0", salary: "0" };
  assert.throws(() => resolveVisibleDisbursementStatus({ scopeStatus: "in_batch", payoutStatus: "pending_confirmation", paymentMethod: "transfer", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: [], reason: "待确认", followUp: "跟进" }), /only valid for cash/u);
  assert.throws(() => resolveVisibleDisbursementStatus({ scopeStatus: "not_in_batch", payoutStatus: "reconciled", paymentMethod: "transfer", adjustmentKind: "none", amounts: due, paidAmount: "1", voucherRefs: ["v"], reason: "非本批", targetBatch: "下批" }), /not-in-batch row/u);
  assert.throws(() => parseDisbursementAmount("0.0001", "amount", { allowNegative: true }), /at most three decimal places/u);
  assert.throws(() => assertXml10Text("非法\u0001文本", "note"), /forbidden by XML 1\.0/u);
});

test("fixed-point amounts preserve representative boundaries and reimbursement refunds", () => {
  for (const value of ["3464.14", "9707", "29912", "40100.536", "0.367", "-12.345"]) {
    assert.equal(formatDisbursementAmount(parseDisbursementAmount(value, "amount", { allowNegative: true })), value);
  }
  const refund = normalizeRowAmounts({ xiaohongshu: "-12.345", company: "0", residence: "0", salary: "0" });
  assert.equal(refund.canonical.xiaohongshu, "-12.345");
  assert.equal(formatDisbursementAmount(refund.total), "-12.345");
  assert.throws(() => normalizeRowAmounts({ xiaohongshu: "0", company: "0", residence: "0", salary: "-1" }), /must be a non-negative decimal string/u);
});
