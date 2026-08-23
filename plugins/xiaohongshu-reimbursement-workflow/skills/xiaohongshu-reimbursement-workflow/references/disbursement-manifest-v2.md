# 发放 manifest v2 内部契约

本契约供当前 Codex 任务在复核用户明确指出的业务材料后生成内部运行输入。不要要求用户编写、补齐或维护这些 JSON；业务事实不明确时先询问具体问题。

权威结构校验器是 [`scripts/disbursement_manifest_v2_contract.mjs`](../scripts/disbursement_manifest_v2_contract.mjs)。本文只说明生成 v2 时需要遵守的字段、引用和信任边界；运行器仍会 fresh 读取文件并实施业务闭合、安全审计和 TOCTOU 检查。

## 外层 archive request

外层请求继续使用 v1 封套，字段必须严格只有四个：

```json
{
  "kind": "compact-disbursement-archive-v1",
  "stagingToken": "64位小写十六进制",
  "manifestPath": "任务内部 manifest 的绝对路径",
  "manifestSha256": "64位小写十六进制"
}
```

不得加入确认文字、Gate、prepare、finalize、state 或其他字段。

## 顶层与版本

v2 顶层字段必须严格为：

```text
kind / version / batch / sourceFiles / reimbursementSources /
salaryArtifacts / vouchers / rows / sourceReview / expected
```

- `kind` 固定为 `disbursement-archive-manifest-v2`。
- `version` 固定为 `2`。
- 不允许未知字段，也不允许混入 v1 的路径/哈希字段。
- v1 只按原 exact schema 兼容；不得把 v2 字段塞入 v1 或隐式升级/降级。

## batch

```json
{
  "batchId": "safe-id",
  "archiveParentPath": "绝对输出父目录",
  "nameRevision": 1,
  "reimbursementPeriod": {
    "start": "YYYY-MM-DD",
    "end": "YYYY-MM-DD"
  }
}
```

`reimbursementPeriod` 仅工资批次必须省略；只要存在报销来源就必须提供。`archiveParentPath` 是输出位置，不得注册为来源文件。

## sourceFiles：唯一文件注册表

每项严格为：

```json
{
  "id": "file-id",
  "path": "绝对来源路径",
  "sha256": "64位小写十六进制",
  "kind": "json|text|workbook|image|pdf",
  "usage": ["一个或多个冻结用途"]
}
```

允许的 usage：

- `published_reimbursement_artifact`
- `fresh_reimbursement_evidence`
- `original_manifest_attestation`
- `publish_receipt_attestation`
- `salary_artifact`
- `salary_certificate_attestation`
- `payout_voucher`

所有可读取来源路径和 SHA256 只能出现在这里；其他结构只引用 file ID。同一 canonical path 只能注册一次；注册表不得含未引用项。运行器会核对普通文件身份、SHA、声明类型与实际内容，不能把 image 声明成 PDF 或反向声明。

## 报销来源与复核

来源项：

```json
{
  "id": "source-id",
  "profileId": "xiaohongshu|company|residence",
  "mode": "published_archive|fresh_evidence",
  "inputFileIds": ["file-id"],
  "attestations": {
    "originalManifestFileId": "可选 json file-id",
    "receiptFileId": "可选 json file-id"
  }
}
```

`attestations` 整体可省略，出现时不得为空。原 manifest 和 publish receipt 不是启动条件；一旦提供，就必须使用对应 usage 注册、纳入 review 并完整验证，错误或冲突不能忽略。

每个来源恰好对应一个 review item：

```json
{
  "id": "review-item-id",
  "sourceId": "source-id",
  "mode": "published_archive|fresh_evidence",
  "reviewedFileIds": ["该来源全部且仅有的输入与可选佐证 file-id"],
  "facts": {
    "batchId": "普通报销或任务派生批次 ID",
    "reimbursementPeriod": {
      "start": "YYYY-MM-DD",
      "end": "YYYY-MM-DD"
    },
    "transactions": [
      {
        "id": "transaction-id",
        "date": "YYYY-MM-DD",
        "person": "人员",
        "reimbursementAmount": "10.25"
      }
    ]
  }
}
```

`published_archive` 必须只使用用户明确列出的正式归档工件，不枚举父目录。能从工件机械证明的日期、人员、汇总、表格和媒体必须闭合；旧归档无法单独证明的批次 ID、交易 ID 或逐笔分配必须明确保持 review-bound，并受正式工件能证明的逐人/总额约束。无法唯一形成事实时询问用户，不猜测或平均分配。

`fresh_evidence` 由当前任务重新阅读原始材料形成 review。图片只宣称 `review_bound_no_ocr`，不能声称运行器执行了 OCR；不可证明来源的旧 OCR 或旧摘要不得复用。

## 工资来源与复核

工资最终件：

```json
{
  "id": "salary-artifact-id",
  "month": "YYYY-MM",
  "salaryCategoryId": "safe-id",
  "salaryCategoryName": "工资类别",
  "finalArtifactKind": "workbook|image",
  "fileId": "salary_artifact file-id",
  "storeReference": "安全的正斜杠逻辑引用",
  "attestation": {
    "salaryCertificateFileId": "可选 json file-id"
  }
}
```

certificate 不是启动条件；提供后必须 fresh 验证并与最终件、review 和 rows 一致。每个工资件恰好对应一个 review item：

```json
{
  "id": "review-item-id",
  "salaryArtifactId": "salary-artifact-id",
  "mode": "final_artifact",
  "reviewedFileIds": ["工资最终件及可选 certificate file-id"],
  "facts": {
    "month": "YYYY-MM",
    "salaryCategoryId": "safe-id",
    "salaryCategoryName": "工资类别",
    "finalArtifactKind": "workbook|image",
    "storeReference": "安全逻辑引用",
    "grossPayTotal": "100",
    "payments": [
      {
        "id": "payment-id",
        "subject": "发放对象",
        "amount": "100"
      }
    ]
  }
}
```

图片保持 `review_bound_no_ocr`；没有冻结工资业务 schema 的工作簿保持 `review_bound_no_frozen_salary_schema`。月份、类别、逻辑存放说明、逐项金额和总额仍必须明确，payments 合计必须等于 `grossPayTotal`，并与工资 rows 一一闭合。

## sourceReview

```json
{
  "kind": "disbursement-source-review-v2",
  "version": 2,
  "id": "review-id",
  "producer": "task_internal",
  "generatedAt": "合法 UTC ...Z 时间",
  "reimbursement": [],
  "salary": []
}
```

它直接内嵌于 manifest，不是 sidecar。review item ID 全局唯一；每个报销来源和工资件恰好一个 review。`reviewedFileIds` 必须完整且仅覆盖该项声明的输入文件和可选佐证。

## vouchers、rows 与 expected

每个凭证项严格为：

```json
{ "id": "voucher-id", "fileId": "payout_voucher file-id" }
```

凭证文件只能是严格验证的 image 或 PDF。rows 使用 v1 的精确行结构：

- 必填：`id/order/subject/scopeStatus/payoutStatus/paymentMethod/adjustmentKind/amounts/paidAmount/reimbursementRefs/voucherRefs`
- 可选：`salaryArtifactId/note/reason/followUp/targetBatch/retentionProof/adjustment`
- `amounts` 精确含 `xiaohongshu/company/residence/salary`。
- `reimbursementRefs[]` 精确含 `sourceId/transactionId/amount`。
- order 从 1 连续；每笔报销交易恰好被引用一次；每个工资件和每个凭证都必须被引用。

`expected` 精确包含：

```text
rowCount / inBatchDueTotal / inBatchPaidTotal / reconciledTotal /
uniqueVoucherCount / voucherReferenceCount / roundingTailTotal / salarySlotCount
```

金额全部使用最多三位小数的定点十进制字符串，禁止指数、前导零和负零。结构验证通过不代表业务通过；状态、金额、引用覆盖、工资/报销闭合、尾差、候选和最终三项仍由完整审计验证。

## 失败边界

- 未知字段、kind/version 错配、重复 ID/ref/path、未引用文件、usage/kind 不匹配：确定性拒绝。
- 文件缺失、SHA 或实际类型不符、解析损坏、已提供佐证错误、来源事实冲突：停止并报告具体完整性问题。
- 人员、金额、期间、工资类别、处置或凭证对应不明确：停止并询问具体业务问题。
- 不得扫描其他目录补文件，不得跟随未注册路径，不得猜测事实，也不得降级为 v1 绕过失败。
