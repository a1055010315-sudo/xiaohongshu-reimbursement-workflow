---
name: xiaohongshu-reimbursement-workflow
description: "Process Xiaohongshu, company, or residence reimbursement batches and supplements from one manifest: scan source evidence once, instantiate fixed脱敏 templates, generate成品合并 from current business data, patch only batch rows into the bound root ledger, show batch-only previews, require two exact approval gates, publish atomically, and clean task-owned temporary files. Use for 小红书报销、公司报销、驻所/住所报销、补报、续跑、终审或发布. Historical ledger correction/reorder is a separate explicit mode and is never invoked by ordinary reimbursement."
---

# 报销工作流

## 模式边界

- 普通新增或补报：只用 `scripts/run_reimbursement_workflow.mjs`。
- 普通交付物使用 `assets/templates/xiaohongshu/` 中经 SHA256 校验的脱敏模板；模板数据区不预置业务合并，成品投影阶段可按真实业务数据恢复必要合并和明确行高规则。
- 历史总表修复或重排：只有用户明确提出时才读 [历史修正规则](references/ledger-business-correction.md)，并使用隔离的 ledger-reorder 脚本。
- 用户只要求检查或修改本 skill/plugin 时，不得读取、生成或修改任何报销文件。
- 普通模式绝不调用全表历史维护链，也不因历史空行、G/H 内容、共享公式、WPS 元数据或 `mc:AlternateContent` 拒绝本批。

## 必读规则

- 材料范围或聊天截图：[证据核对](references/wechat-evidence-review.md)
- Manifest、补报和交付目录：[批次输出](references/batch-output-rules.md)
- 动态表格与局部总表：[工作簿规则](references/expense-workbook-rules.md)
- 两道门禁和发布：[发布规则](references/ledger-publish-rules.md)
- 缓存、恢复和清理：[运行可靠性](references/runtime-reliability.md)

只读取当前任务需要的规则。不要把历史修正规则带入普通新增。

## 普通流程

固定顺序：

`材料扫描一次 → manifest v3 → 动态交付物 → 局部候选 → 本批预览 → Gate 1 → 独立本批终审 → Gate 2 → 原子发布 → 清理`

1. 确认材料根目录、正式总表、主期间、归档目录和用户业务口径。
2. 一次扫描所有材料，按 SHA256 建立文件清单和 source coverage；同一未变化图片不得再次识别。
3. 写 manifest v3。补报不能扩大主期间。
4. 运行 `--prepare`。只生成受影响 profile 的交付物和候选；正式总表保持原 SHA256。
5. 展示 TXT 全文、明细预览、截图表预览、本批总表增量预览、候选路径/SHA256 和 Gate 1 `bindingDigest`。
6. 只有用户在新消息中精确发送 `本次报销通过无误`，才运行 `--finalize`。
7. Gate 2 从磁盘独立重算本批和局部补丁。候选未变时复用已核验 Gate 1 PNG 字节，但生成新绑定。
8. 展示 Gate 2 绑定、候选路径/SHA256；只有用户在新消息中精确发送 `确认更新根目录支出总表`，才运行 `--publish`。
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

只归档：

1. 报销文字说明 `.txt`
2. 本次报销明细 `.xlsx`
3. 报销明细对应截图表 `.xlsx`
4. 候选总表 `小红书支出总表_截至<主期间结束日期>.xlsx`（其他 profile 使用各自固定表名）
5. 原始截图凭证 `报销截图\<报销类别>\`
6. 有补报时，每位人员一张补报明细 `.xlsx`

不归档 Gate、manifest、预览、日志、模板、中间候选或恢复文件，不创建二次 `01_小红书专项` 层级。

## 失效与安全

- 任一业务事实、来源覆盖、候选字节、计划或预览发生变化，两道门禁全部失效。
- 备注/分类修订复用未变化证据的 SHA 与图像元数据，只重建受影响事实及下游交付物。
- Gate 2 前正式总表不得变化；外部修改使发布立即阻塞。
- 普通总表审计只核对本批行、局部补丁和未涉及 OOXML 部件不变性，不计算历史总额、不重排历史、不解析历史业务。
- 候选总表全文件只做 SHA256 并发保护；普通模式只读取目标 Sheet 的表头、日期索引、合并边界和插入位置附近的整行标准样式，不执行历史全表业务检查。
- 总表预览必须是本批增量投影，绑定当前候选 SHA、计划 SHA、来源覆盖和本批行区段；不得渲染历史全表。
- 图片校验按 magic bytes、JPEG SOF/PNG 头和可解码性判断类型，保留原始字节与 SHA256；不得仅因 JPEG 缺少 FFD9 尾标拒绝可正常解码的原图。
- 失败时只保留一个带任务标记的恢复现场；成功时删除所有 workflow 创建的临时内容。
