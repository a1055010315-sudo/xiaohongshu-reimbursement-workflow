# 简洁发放归档

## 独立模式

- 只有用户明确要求“生成/更新发放归档”时，才进入本模式并运行 `scripts/run_compact_disbursement_workflow.mjs`。
- 本模式只把已发布报销成品或 fresh 证据复核出的报销事实、工资最终件、发放凭证和人工处置结论汇成下游核销归档；不执行付款，不重算工资，不修改报销工件或总表。
- 普通报销始终走 `scripts/run_reimbursement_workflow.mjs`，不得导入发放模块、扫描工资目录、读取发放凭证或生成本模式状态。普通报销的输入、门禁、发布和清理均不因本模式改变。

## 业务材料与任务内部 manifest

用户从明确业务材料开始，不负责制作 manifest、复核 JSON 或 sidecar。可用材料是：

- `published_archive`：用户指出的已发布报销成品，包括该来源实际需要的明细、截图对应表、文字说明、总表快照、条件性补报表和归档凭证；原报销 manifest 与 publish receipt 不是必需启动材料。
- `fresh_evidence`：用户指出的本次报销原始证据；可以没有原报销 manifest 或 publish receipt attestation。
- 工资：已定稿的工作簿或图片；可以没有 `salary-final-artifact-v1` certificate。
- 发放：用户指出的转账、现金或留存证据，以及明确的逐行人工处置决定。

当前任务先把实际要读取的文件收敛为明确清单，fresh 读取并进行语义复核，再在任务内部生成并内嵌 `disbursement-source-review-v2`，随后生成默认的 `disbursement-archive-manifest-v2`、计算 SHA256，并构造严格四字段 archive request。不要让用户手写这些内部 JSON，也不要要求用户扫描目录寻找原 manifest、receipt、certificate 或其他 sidecar；审计器不得枚举父目录、追随未注册路径或用隐式文件扩大发放输入。

v2 manifest 的详细 exact schema 见 [Manifest v2 冻结契约](../../../../../docs/implementation/contracts/manifest-v2.md)。所有来源都在 `sourceFiles` 中以显式路径、SHA256、类型和 usage 注册；报销、工资与凭证结构只引用 file ID。`sourceReview.reviewedFileIds` 必须完整且仅覆盖对应来源输入和已提供的可选佐证。每笔报销交易必须在 `rows[].reimbursementRefs` 中恰好出现一次；每个工资最终件、每份凭证都必须被行引用。`expected` 必须精确闭合行数、在批应发/实发/已核销、唯一凭证数、凭证引用数、尾差合计和工资槽位数。金额使用最多三位小数的定点十进制字符串。

## Review-bound 信任边界

`sourceReview` 是当前任务根据上述明确文件进行 fresh 语义复核后生成的结构化事实，`producer` 固定为 `task_internal` 并直接内嵌于 manifest。它不是用户提供的独立证明，也不是运行器从文件机械推出全部业务语义的声明。

- `published_archive` 会从正式报销工件机械重建并闭合可证明的日期、人员、金额、表格结构和媒体绑定；无法单凭成品字节推出的批次身份或交易映射继续明确标为 review-bound。
- fresh 报销图片和工资图片只承诺严格类型、大小、完整像素 decode、SHA 与文件身份验证，语义依据为 `review_bound_no_ocr`；不得宣称插件执行 OCR 并机械识别金额。
- 没有冻结工资业务 schema 的工作簿只承诺安全、完整的 OOXML 结构解析，语义依据为 `review_bound_no_frozen_salary_schema`；不得宣称插件从单元格布局机械重建 payments 或总额。
- 当前任务可以基于明确文件形成 review-bound 事实，但遇到人员、金额、期间、工资类别、行归属、处置或凭证对应歧义时必须询问用户并等待明确答案，不能猜测、平均分配或用文件名补足业务语义。

review-bound 不放宽文件绑定或业务闭合：运行器仍 fresh 读取全部注册文件，核对 source review、rows、expected、候选和发布输入，并把语义依据写入审计结果。

## 可选佐证与 v1 迁移

- `published_archive` 可以同时没有原报销 manifest 和 publish receipt；`fresh_evidence` 可以没有这两类 attestation；工资可以没有 certificate。
- 任一可选 attestation 一旦提供，就必须显式注册并进入该来源的 `reviewedFileIds`，fresh 核 SHA、exact schema、内部 digest、文件绑定和与 `sourceReview` 事实的一致性。损坏、缺字段、错误、复用或冲突一律阻塞；不能因为它可选就忽略。
- manifest v2 是新任务默认格式。现有 `disbursement-archive-manifest-v1` 仅严格兼容一个发布周期：继续按原 exact schema 和原安全链运行，并返回 `DISBURSEMENT_MANIFEST_V1_DEPRECATED` warning。warning 只用于迁移提示，不增加人工 Gate、确认口令或分步状态；兼容期后不再把 v1 写入新任务。

## 十五种稳定命名

设 `P=YYYY.M.D-YYYY.M.D`，`M=YYYY.MM工资`。报销标签按“小红书、公司、驻所”固定顺序，只能是以下七种：`小红书报销`、`公司报销`、`驻所报销`、`小红书报销+公司报销`、`小红书报销+驻所报销`、`公司报销+驻所报销`、`三类报销`。

- 仅报销：七种 `P_<报销标签>`；
- 报销加工资：七种 `P_<报销标签>+M`；
- 仅工资：一种 `M`。

共十五种非空组合。profile 输入顺序或重复项不改变名称；三类齐全必须折叠为“三类报销”。`nameRevision=1` 不加后缀，后续固定追加 `_修订N`。例如：`2026.7.25-2026.8.12_三类报销+2026.07工资`。

## 行、退款、尾差与六种状态

最终只显示六种状态：

| 状态 | 必要条件 |
| --- | --- |
| 已核销 | 转账/现金行的实际发放等于应发且至少绑定一份凭证；或“本人留存”行应发为正、实际发放等于应发，并同时绑定资金到账和留存决定证据。 |
| 待凭证 | `pending_evidence`，必须写明原因和后续动作。 |
| 待现金确认 | 仅限现金，必须写明原因和后续动作。 |
| 异常待说明 | `exception`，必须写明原因和后续动作。 |
| 非本批 | `not_in_batch`；实际发放为零、方式为 `none`、无尾差，并写明原因和目标批次。 |
| 已忽略尾差 | 独立尾差行；见下述规则。 |

“本人留存”是付款方式/处置，不是第七种状态。只有“待凭证、待现金确认、异常待说明”会使批次保持 `open`。

- 退款必须与正向报销拆成不同的有符号行；同一行的非零报销引用不得正负混合。退款行只能含负数报销、工资为零、实际发放不得为正。
- 尾差必须另建 `rounding_tail` 行：四类应发和实际发放均为零，方式为 `none`，不绑定发放凭证；`adjustment.amount` 非零且绝对值不超过正数 `tolerance`，并绑定另一条普通来源行、原因和人工授权。尾差不混入在批应发/实发，只进入 `roundingTailTotal`。

## 凭证按 SHA256 去重、逐行保留引用

- `vouchers[]` 的每个 ID 都绑定绝对路径和 SHA256；凭证只接受严格完整像素解码的 PNG/JPEG 或完整 PDF，单文件上限 25 MiB。PDF 必须由 bundled `pdfjs-dist` 在独立 Worker 中以严格错误模式解析 catalog/page tree；先检查 `EncryptFilterName` 和 permissions，任何加密或权限字典都拒绝，包括能以空 user password 自动打开的标准加密 PDF；随后逐页执行 `getOperatorList` 触发全部内容流解析。页数限 1000、单页 operators 限 100000、总 operators 限 1000000，依赖缺失、加密、解析异常或任何 parser warning/error 都拒绝，不得退回只查 `%PDF-`/`%%EOF`。唯一兼容例外是 JPEG 原字节只缺末尾 `FFD9` 时，可仅在内存验证副本中临时补尾。
- 行内 `voucherRefs` 不得重复 ID，未被任何行引用的凭证直接拒绝；同一凭证可被多行引用。
- 归档按完整 SHA256 去重，不按文件名去重。唯一文件依首次逐行引用顺序命名为 `NNN_<SHA前12位>.<扩展名>`。
- 去重后仍须保存全部 `sourceIds` 和 `rowReferences`（`rowId`、行顺序、行内引用序号）；工作簿每行按原引用顺序列出归档名。`uniqueVoucherCount` 与 `voucherReferenceCount` 分别核对唯一文件数和全部逐行引用数。

## 单次显式归档

发放归档没有人工门禁，也不要求用户发送确认口令。用户明确要求生成或更新发放归档后，当前任务先完成明确材料的复核和内部 v2 manifest/request 生成，再只调用一次：

```text
node scripts/run_compact_disbursement_workflow.mjs --archive <request.json>
```

这个 request 是当前任务的内部运行输入，不是让用户手动准备的业务材料。其 kind 固定为 `compact-disbursement-archive-v1`，字段严格只有 `kind`、64 位小写十六进制 `stagingToken`、`manifestPath` 和 `manifestSha256`。不得加入审批文本、状态路径、门禁摘要或其他分步发布字段。

一次调用必须完整执行：owner/目录身份绑定 → fresh 来源全审计 → 候选生成或安全恢复 → 候选逐行/逐凭证完整审计 → 再次 fresh 来源与候选完整复核 → 发布输入指纹前后 TOCTOU 核对 → task-owned stage 复制与独立审计 → 在 stage 审计完成后再次复核完整发布输入身份 → 原子改名 → 最终三项完整复核 → allowlist 清理并返回 receipt。最后一次发布输入复核必须覆盖全部 `boundSourcePaths` 和候选三项，不能只复核 stage；任一来源、事实、目录身份、候选或 stage 变化都立即停止，不发布部分结果。

## 最终形状、恢复与清理

最终批次目录根部必须严格只有三项：

1. `发放情况说明.txt`
2. `发放核对表.xlsx`
3. `发放凭证\`

manifest、内部审计/journal、owner、receipt、facts certificate、工资最终件/证书和临时文件都不得进入最终目录。工作簿固定为一个可见的“发放核对表”工作表；发布前后都要按三项形状、工件 SHA、逐行内容、样式和凭证对应重新审计。

工作现场固定在系统临时目录的 `codex-xhs-disbursement-<stagingToken>`，带 owner marker、目录身份和内部恢复 journal。相同 archive 请求可恢复已核对候选、未完成 stage 或改名后待清理状态；同一 token 对应的请求、来源、owner、目录身份或候选不一致时停止，不拼接旧结果。发布先在归档父目录创建任务专属 staging，逐件复制并复核后原子改名；目标已存在时只接受内容完全相同的幂等恢复，绝不覆盖不同内容。

清理只能删除 owner marker 和严格 allowlist 能证明由本任务创建的文件/目录。发布前必须绑定 candidate 根目录/凭证目录身份、owner 以及每个 candidate owned file 的 canonical path、`dev/ino/size/mode/mtime/ctime/birthtime`、SHA256 和内容大小；删除前先全量复核，且每个文件 `unlink` 前再次复核。同路径替换即使字节、SHA 和大小相同也必须判定 `cleanup incomplete`，保留替换文件和工作现场。出现未知项、重解析点、身份变化或删除失败时保留现场并在结果中报告。成功发布后检查返回 receipt 的 `cleanup` 结果；不得用宽泛递归删除处理残留。

## O/D 性能评估

- 本期只迁移发放入口、信任边界和兼容说明，没有实施或宣称整体性能优化，也没有生成新的性能结论。
- O 线固定比较“未修改目标版普通报销”与“加入/优化发放功能后的普通报销”，必须保持普通报销语义输出完全等价；D 线固定比较“首个完整安全、无人工门禁、单次 archive 的发放实现”与“同一冻结输出契约下的优化实现”。旧分步发放实现不得继续充当 D 基线。两线都必须锁定双方版本、skill tree SHA256 和 package tree SHA256。
- 20% 是默认信息性改善目标，不是验收硬门。冷/热各至少 11 组配对样本、每侧至少 2 次不计时预热；保存原始样本，并报告 p50、p95、MAD、配对 bootstrap 95% 置信区间和改善目标是否达到。O/D 两线通过仍要求 p95 不退化、输出完全等价且冷、热峰值内存增幅均不超过 15%；普通 O 线还必须保持预览 PNG 唯一性。子进程 manifest auditor 和 Excel/COM 渲染进程的内存必须计入端到端边界或单独报告；不得把未计入的子进程资源当作整体 RSS 已达标。
- 外部人员或模型产生独立观察的等待时间可单列排除；插件控制的来源/媒体 fresh-read 与完整 decode、候选生成、全部独立审计、原子发布、最终三项复核和清理必须纳入 D 线单次 archive 计时。未达到改善目标时如实报告，不得据此继续叠加低收益复杂度；不得改动只读基线、关闭样式检查、减少逐项覆盖、跳过独立复核或信任前一轮语义结果提速。
