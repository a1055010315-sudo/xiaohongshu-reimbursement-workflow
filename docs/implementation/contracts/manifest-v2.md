# Manifest v2 冻结契约

状态：`FROZEN by S01`

本契约只取消发放核销内部对“原报销 manifest + publish receipt”和“工资 certificate”的强制启动依赖。它不改变普通报销 Gate 1/Gate 2，不实现来源解析、图片识别、工资内容审计、发布接入或性能优化。

实现与测试：

- 纯结构模块：`scripts/disbursement_manifest_v2_contract.mjs`
- 合成契约测试：`tests/disbursement-manifest-v2-contract.test.mjs`
- v2 kind/version：`disbursement-archive-manifest-v2` / `2`
- 内嵌复核 kind/version：`disbursement-source-review-v2` / `2`

## 1. 顶层与分派

顶层字段必须精确为：

```text
kind / version / batch / sourceFiles / reimbursementSources /
salaryArtifacts / vouchers / rows / sourceReview / expected
```

全部字段必填，不允许扩展字段。版本分派只接受下列精确配对：

| kind | version | 分派 |
| --- | ---: | --- |
| `disbursement-archive-manifest-v1` | 1 | 现有 v1 auditor |
| `disbursement-archive-manifest-v2` | 2 | v2 contract，后续接 v2 auditor |

`dispatchDisbursementManifestVersion(raw)` 只查看 `kind/version`，绝不根据其他字段猜版本。已知 kind 与错误 version、已知 version 与错误 kind、缺少任一字段都拒绝。v1 body 混入 v2 字段仍由 v1 exact schema 拒绝；v2 body 混入 v1 路径/哈希字段由 v2 exact schema 拒绝；不做自动升级、降级或字段兜底。

`validateDisbursementManifestV2(raw)` 只接受精确 v2 配对，返回规范化绝对路径后的深冻结副本，不修改调用方对象。

## 2. `batch`

精确字段：

```json
{
  "batchId": "safe-id",
  "archiveParentPath": "absolute output directory",
  "nameRevision": 1,
  "reimbursementPeriod": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }
}
```

- `batchId`：安全 ASCII ID；`nameRevision`：正安全整数。
- `reimbursementPeriod` 是唯一可选字段；有报销来源时必填，工资-only 时必须省略。
- `archiveParentPath` 是发布目标目录，不是来源文件绑定；因此不进入 `sourceFiles`。除该输出位置和只读逻辑名 `storeReference` 外，任何来源路径/哈希只能出现在 `sourceFiles`。
- S01 只验证日期是真实日历日期；期间先后、批次命名和业务闭合由后续 auditor 验证。

## 3. 唯一来源注册表 `sourceFiles`

每项精确字段：

```json
{
  "id": "file-id",
  "path": "absolute source file path",
  "sha256": "64 lowercase hex",
  "kind": "json|text|workbook|image|pdf",
  "usage": ["one-or-more-frozen-usages"]
}
```

`usage` 只允许：

- `published_reimbursement_artifact`
- `fresh_reimbursement_evidence`
- `original_manifest_attestation`
- `publish_receipt_attestation`
- `salary_artifact`
- `salary_certificate_attestation`
- `payout_voucher`

规则：

- `sourceFiles` 是全部输入来源的唯一 `path + sha256 + kind + usage` 注册表；其他结构只持有 `fileId`。
- ID、usage 均不得重复；注册表不得含未引用文件。
- 同一 canonical path 只能注册一次；同一路径重复，或同一路径出现不同 SHA/kind，均拒绝。同一 SHA 在不同路径出现时，kind 必须一致。
- 本模块只验证声明和身份无冲突，不读文件、不核对磁盘 SHA、不嗅探实际媒体类型。后续来源 auditor 必须 fresh-read 并验证这些绑定。

## 4. `reimbursementSources`

每项精确字段：

```json
{
  "id": "source-id",
  "profileId": "xiaohongshu|company|residence",
  "mode": "published_archive|fresh_evidence",
  "inputFileIds": ["file-id"],
  "attestations": {
    "originalManifestFileId": "optional-json-file-id",
    "receiptFileId": "optional-json-file-id"
  }
}
```

- `inputFileIds` 非空、唯一并指向 `sourceFiles`。
- `published_archive` 的输入必须含 `published_reimbursement_artifact` usage；`fresh_evidence` 必须含 `fresh_reimbursement_evidence` usage。
- `attestations` 整体可省略；出现时不得为空，内部两个字段均可单独出现。
- 原 manifest 与 receipt 只是可选佐证，不是启动门槛。出现时必须分别绑定 kind=`json` 且 usage 为 `original_manifest_attestation` / `publish_receipt_attestation` 的 `sourceFiles` 项，并进入该来源的 `sourceReview.reviewedFileIds`。S02 后续必须读字节、核 SHA、验内容和与复核事实的一致性；不能因为“可选”而跳过已提供佐证。

## 5. `salaryArtifacts`

每项精确字段：

```json
{
  "id": "salary-artifact-id",
  "month": "YYYY-MM",
  "salaryCategoryId": "safe-id",
  "salaryCategoryName": "text",
  "finalArtifactKind": "workbook|image",
  "fileId": "salary-source-file-id",
  "storeReference": "safe/forward/slash/reference",
  "attestation": {
    "salaryCertificateFileId": "optional-json-file-id"
  }
}
```

- `fileId` 必须指向 usage=`salary_artifact` 且 kind 与 `finalArtifactKind` 相同的注册项。
- `storeReference` 是工资存放逻辑引用，不是可读取路径；必须为安全、正斜杠、非绝对引用。
- `attestation` 整体可省略；出现时精确只含 `salaryCertificateFileId`，并绑定 kind=`json`、usage=`salary_certificate_attestation`。
- 工资 certificate 只是可选佐证，不是启动门槛。提供时 S03 必须 fresh 验证文件与复核事实，不得只信 manifest 字段。

## 6. `vouchers`

每项精确为 `{ "id": "voucher-id", "fileId": "file-id" }`。`fileId` 必须指向 usage=`payout_voucher` 且 kind 为 `image` 或 `pdf` 的注册项。行仍用 `voucherRefs[]` 引用 voucher ID，以保持逐行引用和按 SHA 去重语义。

## 7. 任务内部 `sourceReview`

`sourceReview` 是当前发放任务在扫描并复核已绑定来源后生成、直接内嵌于 manifest 的结构化事实，不是要求用户事先准备或维护的 JSON sidecar。它精确为：

```json
{
  "kind": "disbursement-source-review-v2",
  "version": 2,
  "id": "review-id",
  "producer": "task_internal",
  "generatedAt": "UTC timestamp ending Z",
  "reimbursement": [],
  "salary": []
}
```

禁止 `path/sha256` 等 sidecar 字段；`producer` 只能是 `task_internal`。review item ID 在报销和工资两组内全局唯一。每个来源/工资件恰好一个 review item，不能缺失或重复；每项 `reviewedFileIds` 必须“完整且仅”覆盖该来源声明的输入文件和可选佐证。

### 7.1 报销 review item

精确结构：

```json
{
  "id": "review-item-id",
  "sourceId": "reimbursement-source-id",
  "mode": "published_archive|fresh_evidence",
  "reviewedFileIds": ["file-id"],
  "facts": {
    "batchId": "ordinary-or-derived-batch-id",
    "reimbursementPeriod": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "transactions": [
      { "id": "transaction-id", "date": "YYYY-MM-DD", "person": "text", "reimbursementAmount": "10.25" }
    ]
  }
}
```

`mode` 必须与来源相同，`transactions` 非空，transaction ID 在该来源内唯一。`published_archive` 与 `fresh_evidence` 都必须产出同一形状的完整 transaction facts，使后续 auditor 能独立将每笔事实与来源文件、rows 和归档候选核对。S01 不判断事实是否正确；S02 负责从所选 mode 的文件独立重建并验证。

### 7.2 工资 review item

精确结构：

```json
{
  "id": "review-item-id",
  "salaryArtifactId": "salary-artifact-id",
  "mode": "final_artifact",
  "reviewedFileIds": ["file-id"],
  "facts": {
    "month": "YYYY-MM",
    "salaryCategoryId": "safe-id",
    "salaryCategoryName": "text",
    "finalArtifactKind": "workbook|image",
    "storeReference": "safe/reference",
    "grossPayTotal": "100",
    "payments": [
      { "id": "payment-id", "subject": "text", "amount": "100" }
    ]
  }
}
```

`payments` 非空、ID 在该工资 review 内唯一。逐人/逐项 payments 与 gross total 构成完整工资事实；S03 必须从 final artifact fresh 读取并独立核对，若提供 certificate 还须同时核对 certificate，不得以其替代 final artifact。

## 8. `rows` 与 `expected`

为避免无必要迁移，v2 保持 v1 行业务结构：

- row 必填精确字段：`id/order/subject/scopeStatus/payoutStatus/paymentMethod/adjustmentKind/amounts/paidAmount/reimbursementRefs/voucherRefs`
- row 可选字段：`salaryArtifactId/note/reason/followUp/targetBatch/retentionProof/adjustment`
- `amounts` 精确为 `xiaohongshu/company/residence/salary`；报销允许有符号金额，工资非负。
- `reimbursementRefs[]` 精确为 `sourceId/transactionId/amount`，并结构性指向 review transaction。
- `salaryArtifactId`、`voucherRefs`、retention proof voucher refs、rounding-tail `sourceRowId` 必须存在；ID/ref/order 不得重复，order 从 1 连续。

`expected` 与 v1 精确相同：

```text
rowCount / inBatchDueTotal / inBatchPaidTotal / reconciledTotal /
uniqueVoucherCount / voucherReferenceCount / roundingTailTotal / salarySlotCount
```

S01 只验证字段、整数类型和金额字符串格式；状态组合、逐笔金额相等、完整引用覆盖、工资/报销事实与 rows 对应、expected 闭合、尾差和六状态业务规则由 S04 的 v2 auditor 验证。

## 9. 原始格式与失败边界

- ID：`[A-Za-z0-9][A-Za-z0-9._-]{0,95}`。
- SHA-256：64 位小写十六进制。
- 金额：十进制定点字符串，最多三位小数；禁止指数、前导零、负零；工资类金额非负。
- 日期/月：真实 `YYYY-MM-DD` / `YYYY-MM`；review 时间为合法 UTC `...Z`。
- 文本：trim 后非空，单行，长度受限，拒绝 XML 1.0 禁止字符。
- structural contract 失败是确定性输入错误，修正结构后重试；不得降级成 v1 或跳过字段。
- 文件缺失、SHA/媒体不符、解析失败、来源事实冲突和业务闭合失败不属于本模块，分别由 S02/S03/S04 报告，不能被结构通过掩盖。

## 10. 后续接口

S02 接口：接收已通过 `validateDisbursementManifestV2` 的 `sourceFiles + reimbursementSources + sourceReview.reimbursement`；按 mode fresh 读取全部 `reviewedFileIds`，重建 transactions，验证每个已提供 attestation，并返回独立核对结果给 S04。

S03 接口：接收已通过结构验证的 `sourceFiles + salaryArtifacts + sourceReview.salary`；fresh 解析 workbook/image，重建 payments 与 gross total，验证每个已提供 certificate，并返回独立核对结果给 S04。

S04 接口：严格先用 `dispatchDisbursementManifestVersion` 分派，再把 v2 交给结构 validator；合并 S02/S03 结果，实施 rows/expected/状态/覆盖闭合和现有文件安全验证。S04 不得把 v2 逻辑塞入现有 v1 auditor，也不得按字段猜版本。
