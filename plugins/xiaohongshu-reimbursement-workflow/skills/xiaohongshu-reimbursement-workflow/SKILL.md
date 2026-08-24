---
name: xiaohongshu-reimbursement-workflow
description: "Process Xiaohongshu, company, or residence reimbursement batches and supplements, or explicitly build a compact downstream disbursement archive from user-identified published reimbursement artifacts or fresh evidence, final salary materials, payout vouchers, and disposition decisions. Use for 小红书报销、公司报销、驻所/住所报销、补报、续跑、终审、发布或发放归档. Historical ledger correction and compact disbursement are separate explicit modes and are never invoked by ordinary reimbursement."
---

# 报销工作流

## 模式边界

- 普通新增或补报：只用 `scripts/run_reimbursement_workflow.mjs`。
- 普通交付物使用 `assets/templates/xiaohongshu/` 中经 SHA256 校验的脱敏模板；模板数据区不预置业务合并，成品投影阶段可按真实业务数据恢复必要合并和明确行高规则。
- 发放归档：只有用户明确提出时才读 [简洁发放归档](references/compact-disbursement.md)，并使用独立 `--archive` 入口。用户从明确业务材料开始；当前任务内部生成 `sourceReview`、默认 v2 manifest 和严格四字段 request，不索取原 manifest、publish receipt、工资 certificate 或内部 JSON，也不寻找 sidecar。图片和未冻结工资 schema 的工作簿保持 review-bound；歧义先询问，不声称机械 OCR 或金额解析。一次调用完成完整安全链，不设人工 Gate；manifest v1 仅严格兼容一个发布周期并返回弃用 warning。普通报销不得导入发放模块、扫描工资目录或读取发放凭证。
- 历史总表修复或重排：只有用户明确提出时才读 [历史修正规则](references/ledger-business-correction.md)，并使用隔离的 ledger-reorder 脚本。
- 用户只要求检查或修改本 skill/plugin 时，不得读取、生成或修改任何报销文件。
- 普通模式绝不调用全表历史维护链，也不因历史空行、G/H 内容、共享公式、WPS 元数据或 `mc:AlternateContent` 拒绝本批。

## 必读规则

- 材料范围或聊天截图：[证据核对](references/wechat-evidence-review.md)
- Manifest、补报和交付目录：[批次输出](references/batch-output-rules.md)
- 动态表格与局部总表：[工作簿规则](references/expense-workbook-rules.md)
- 两道门禁和发布：[发布规则](references/ledger-publish-rules.md)
- Gate 2 逐笔、逐媒体对应：[全量对应复核](references/gate2-full-correspondence.md)
- 缓存、恢复和清理：[运行可靠性](references/runtime-reliability.md)

只读取当前任务需要的规则。不要把历史修正规则带入普通新增。

## 普通流程

固定顺序：

`材料扫描一次 → manifest v3 → 动态交付物 → 局部候选 → 本批预览 → Gate 1 → 独立本批终审 → Gate 2 → 原子发布 → 清理`

1. 确认材料根目录、正式总表、主期间、归档目录和用户业务口径。
2. 一次扫描所有材料，按 SHA256 建立文件清单和 source coverage；同一未变化图片不得再次识别。
3. 写 manifest v3。补报不能扩大主期间。
4. 运行 `--prepare`。只生成受影响 profile 的交付物和候选；正式总表保持原 SHA256。当前期追加只定位业务尾部和附近标准样式；补报先建立 A 列日期与 D:F 合并边界的局部索引，若插入点落在对齐的 D:F 跨日期组内，只定点读取该组 C 金额和 D:F 锚点并在可证明公式、缓存、子行与合计闭合时自动生成局部拆分计划。除此之外不得读取历史 B:F 业务内容。
5. 展示 TXT 全文、明细预览、截图表预览、本批总表增量预览、候选路径/SHA256 和 Gate 1 `bindingDigest`。
6. 只有用户在新消息中精确发送 `本次报销通过无误`，才运行 `--finalize`。
7. Gate 2 从磁盘独立重算本批和局部补丁，并使用 `independent-evidence-review-v1` 对原始绑定证据进行第二次语义读取，生成 `gate2-full-correspondence-v1` 全量逐项报告。Gate 2 的用途是主动发现 Gate 1 的内容错误，不是只复验哈希。第二次视觉读取不得复制或由 Gate 1 的 OCR、抽取结果、manifest、成品表或预览自动生成；若独立观察与 Gate 1 冲突，先形成可读 finding，再由绑定前次报告的 resolution 明确是 Gate 1 内容错、reviewer 错或证据不确定，禁止自动猜测。
8. 展示 Gate 2 全量对应报告、绑定、候选路径/SHA256。绑定完全一致时可以不重复展示 Gate 1 PNG，但不得省略报告。只有用户在新消息中精确发送 `确认更新根目录支出总表`，才运行 `--publish`。
9. 发布器再次核对正式总表基线 SHA256，原子替换，验证归档，再清理任务临时目录。

## Manifest v3 最小契约

必须包含：

- `batch.mainPeriod.start/end`
- `transactions[].reportingKind`: `current` 或 `supplement`
- 补报的 `supplementReason`
- `transactions[].sourceAmount/reimbursementAmount`
- 使用材料的 `files[].usage`: `voucher` 或 `context`
- `expected.transactionCount/feeTotal/reimbursementTotal/companyPaidNoReimbursementTotal/uniqueMediaCount/mediaReferenceCount`

日期早于主期间开始日时机械归为补报；明确补报也归为补报。补报原因缺失、金额精度丢失、文件哈希变化或 expected 不闭合时停止。

备注只能使用用户授权口径：运营开支、日常报销、人员工资、社保、房租、广告费，或明确授权的具体项目名。“单子名”是类型，不是单元格字面值。只有用户明确指定的“项目甲”类具体名称才可写入；人员、地点或费用事项不得自动推断为单子名。

## 交付物

报销文字说明必须从固定脱敏模板 `assets/templates/xiaohongshu/summary-text.txt` 生成。人员顺序与明细一致；人员金额及实报合计使用 `reimbursementAmount`，对公已付不实报项使用 `sourceAmount` 且不计入实报合计。该人员有补报时，将补报括号紧跟在其金额后；对公项位于全部人员之后、实报合计之前。没有对应业务时删除整行占位内容及空括号，模板内的填写规则说明不得进入成品。

只归档：

1. 报销文字说明 `.txt`
2. 本次报销明细 `.xlsx`
3. 报销明细对应截图表 `.xlsx`
4. 候选总表 `小红书支出总表_截至<主期间结束日期>.xlsx`（其他 profile 使用各自固定表名）
5. 原始截图凭证 `报销截图\<报销类别>\`
6. 有补报时，每位人员一张补报明细 `.xlsx`

不归档 Gate、manifest、预览、日志、模板、中间候选或恢复文件，不创建二次 `01_小红书专项` 层级。

## 失效与安全

- Gate 1 之后若原始材料集合/路径/类型/SHA 或正式总表基线变化，必须建立新 Gate 1。同一批、同一材料和同一基线内，Gate 2 已确认的业务事实、漏项、重复项或派生工件错误属于例外：使用 `--revise-gate2` 重建并自动携带原确认，不再次索取人工 Gate 1。
- 备注/分类修订复用未变化证据的 SHA 与图像元数据，只重建受影响事实及下游交付物。
- Gate 2 前正式总表不得变化；外部修改使发布立即阻塞。
- 对候选总表计算全文件 SHA256 只用于并发保护，不代表也不得触发历史全表业务检查。普通审计只核对本批行、局部补丁和未涉及 OOXML 部件不变性，不计算历史总额、不重排历史、不解析历史业务。
- 当前期追加只定位业务尾部和插入点附近的一整行标准样式；补报先读取 A 列日期索引和 D:F 合并边界。只有插入点命中对齐的跨日期 D:F 组时，才可定点读取受影响组的 C 金额及 D:F 锚点，自证原 `SUM`、缓存、合并子行、样式族与合计守恒后在 Gate 1 前自动拆分；无法证明时阻塞。历史其他 B:F、辅助列业务值和旧公式均不参与本批业务判断。
- 普通 Gate 只能使用本批投影，并严格绑定工作簿 SHA、Sheet、渲染范围、候选 SHA、计划 SHA、来源覆盖、本批行区段和任务摘要；不得渲染历史全表或回退到旧预览。
- 成品工作簿必须同时满足模板 manifest 与 [工作簿样式契约](references/workbook-style-contract.json)。运行时只核对已在构建或 Gate 2 中打开的关键 OOXML 部件，不得为样式检查在 Gate 1 增加文件读取、解码或 COM，也不得在 Gate 2 再次打开同一 ZIP；完整视觉 golden 只用于发布验证。
- 渲染失败只重跑当前预览任务，复用同一 staging token 下已绑定且未变化的业务工件、候选和证据；持续失败时阻塞 Gate，禁止全流程重建或用旧图替代。
- Gate 2 必须逐笔、逐媒体、逐引用和逐交付表核对原始证据、manifest、明细、截图表、补报表、文字说明及候选本批行。reviewer 单方差异先标记 `REVIEW_REQUIRED`；修正 reviewer 后直接重跑。绑定 resolution 确认 Gate 1 内容错，或派生工件存在可稳定重算的确定性错误时标记 `CORRECTION_REQUIRED`，只允许 `--revise-gate2` 在同材料/同基线边界内修复。证据不确定、材料/SHA 或基线变化标记 `GATE1_REQUIRED`。格式、绑定、临时 I/O/解析/机器或未知内部问题标记 `BLOCKED_RETRYABLE`。
- 普通 Gate 1 热路径不得增加普通 Gate 2 独立复核成本。普通 Gate 2 启动后每个工件只解析一次，每个原始材料路径 fresh-read 并核对 SHA，每个唯一媒体 SHA 完整 decode 一次，候选只读取绑定的 `batchRows` 和局部补丁。正式性能评估必须使用锁定版本与树 digest 的 H/O/D 基准。20% 仅作为信息性改善目标；保存原始样本并报告 p50、p95、MAD 与配对 bootstrap 95% 置信区间。普通成功路径的冷、热 p50 和 p95 相对锁定基线均不得退化超过 5%，同时要求输出完全等价、各轮采样峰值 RSS 的 p95 增幅不超过 15% 并保持所有 renderer 的预览 PNG 唯一性；任一项失败都禁止打包、安装或发布。不得为性能跳过独立复核或增加低收益的第二套状态/构建链。
- 图片校验按 magic bytes、JPEG SOF/PNG 头和严格完整像素解码判断类型，保留原始字节与 SHA256，并执行 25 MiB 文件与一亿像素上限；唯一兼容例外是原字节只缺末尾 `FFD9` 时可在内存验证副本临时补尾，扫描数据或其他结构被截断仍必须拒绝。
- 失败时只保留一个带任务标记的恢复现场；成功时删除所有 workflow 创建的临时内容。
