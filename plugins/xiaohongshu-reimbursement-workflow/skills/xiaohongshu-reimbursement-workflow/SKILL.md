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
- Gate 2 逐笔、逐媒体对应：[全量对应复核](references/gate2-full-correspondence.md)
- 缓存、恢复和清理：[运行可靠性](references/runtime-reliability.md)

只读取当前任务需要的规则。不要把历史修正规则带入普通新增。

## 普通流程

固定顺序：

`材料扫描一次 → manifest v3 → 动态交付物 → 局部候选 → 本批预览 → Gate 1 → 独立本批终审 → Gate 2 → 原子发布 → 清理`

1. 确认材料根目录、正式总表、主期间、归档目录和用户业务口径。
2. 一次扫描所有材料，按 SHA256 建立文件清单和 source coverage；同一未变化图片不得再次识别。
3. 写 manifest v3。补报不能扩大主期间。
4. 运行 `--prepare`。只生成受影响 profile 的交付物和候选；正式总表保持原 SHA256。当前期追加只定位业务尾部和附近标准样式，补报只建立 A 列日期与 D:F 合并边界的局部索引，两者都不得读取历史 B:F 业务内容。
5. 展示 TXT 全文、明细预览、截图表预览、本批总表增量预览、候选路径/SHA256 和 Gate 1 `bindingDigest`。
6. 只有用户在新消息中精确发送 `本次报销通过无误`，才运行 `--finalize`。
7. Gate 2 从磁盘独立重算本批和局部补丁，并使用 `independent-evidence-review-v1` 对原始绑定证据进行第二次语义读取，生成 `gate2-full-correspondence-v1` 全量逐项报告。Gate 2 的用途是主动发现 Gate 1 的内容错误，不是只复验哈希。第二次视觉读取不得复制或由 Gate 1 的 OCR、抽取结果、manifest、成品表或预览自动生成。
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

- 任一业务事实、来源覆盖、候选字节、计划或预览发生变化，两道门禁全部失效。
- 备注/分类修订复用未变化证据的 SHA 与图像元数据，只重建受影响事实及下游交付物。
- Gate 2 前正式总表不得变化；外部修改使发布立即阻塞。
- 对候选总表计算全文件 SHA256 只用于并发保护，不代表也不得触发历史全表业务检查。普通审计只核对本批行、局部补丁和未涉及 OOXML 部件不变性，不计算历史总额、不重排历史、不解析历史业务。
- 当前期追加只定位业务尾部和插入点附近的一整行标准样式；补报只读取 A 列日期索引和 D:F 合并边界。历史 B:F、辅助列业务值和旧公式均不参与本批业务判断。
- 普通 Gate 只能使用本批投影，并严格绑定工作簿 SHA、Sheet、渲染范围、候选 SHA、计划 SHA、来源覆盖、本批行区段和任务摘要；不得渲染历史全表或回退到旧预览。
- 渲染失败只重跑当前预览任务，复用同一 staging token 下已绑定且未变化的业务工件、候选和证据；持续失败时阻塞 Gate，禁止全流程重建或用旧图替代。
- Gate 2 必须逐笔、逐媒体、逐引用和逐交付表核对原始证据、manifest、明细、截图表、补报表、文字说明及候选本批行。任一 missing、extra、duplicate、unbound 或字段/金额/分类/补报/媒体 mismatch 都使当前 Gate 1 失效；修正后必须生成并重新展示新的 Gate 1，禁止只重跑 Gate 2。
- Gate 1 热路径不得增加 Gate 2 独立复核成本。Gate 2 启动后每个工件只解析一次，每个唯一媒体从原始路径 fresh-read 并完整 decode 一次后供本门禁全部引用复用，候选只读取绑定的 `batchRows` 和局部补丁。最终性能基线固定为只读安装版本 `0.5.0+codex.20260819174146`：同机、同一完全合成批次和相同冷/热规则下，分别比较旧版 `prepare + Gate 1 + finalize` 与新版 `prepare + Gate 1 + full-correspondence Gate 2 finalize` 的插件可控代码阶段中位总耗时，新版在冷、热条件下都必须至少快 20%。外部人员或模型生成独立观察的等待时间单列且不计入，但插件读取 review、媒体 fresh-read/decode、审计和报告必须计入。未达标时先做热点 review 和局部优化，不得修改基线安装缓存，也不得通过跳过独立视觉复核、减少逐项范围或信任 Gate 1 语义结果提速。
- 图片校验按 magic bytes、JPEG SOF/PNG 头和严格完整像素解码判断类型，保留原始字节与 SHA256，并执行 25 MiB 文件与一亿像素上限；唯一兼容例外是原字节只缺末尾 `FFD9` 时可在内存验证副本临时补尾，扫描数据或其他结构被截断仍必须拒绝。
- 失败时只保留一个带任务标记的恢复现场；成功时删除所有 workflow 创建的临时内容。
