# Gate 2 全量对应复核

## 独立输入

Gate 2 必须接收 `independent-evidence-review-v1`。该输入由独立 reviewer/worker 对当前 manifest 绑定的原始证据字节执行第二次语义读取。`observations[]` 按每个 `sourceRef` 记录 `fileId`、原始 `sourceSha256`、媒体类型、原始宽高及 `facts[]`；每个 fact 必须含 `transactionId`，并至少观察 `date/person/project/sourceAmount` 中一项。同一交易的多个来源可以分工提供字段，但 Gate 2 聚合全部绑定 `sourceRefs` 后必须得到四项完整且无冲突的观察，不能要求每一张上下文图都单独包含全部字段。

输入还必须包含 `annotationObservations[]`；没有注释时传空数组。每项按原始证据独立记录 `profileId/person/kind/period.start/period.end/amount/sourceRefs`，用于核对 commission、bonus、allowance 等文字说明注释。该数组不能从 manifest、证书或 Gate 1 文字说明反推；证据不足以确认时必须阻塞 Gate 2。

所有交易和注释 `sourceRefs` 都按集合语义核对：先逐元素验证，在原数组上检测重复，再以与 locale 无关的稳定排序比较唯一集合并构造报告。只改变合法元素的输入顺序不得产生 mismatch；缺失、额外、重复、空白、非字符串或未绑定元素仍必须单独报告，不能在建立集合时被吞掉。

第二次视觉读取不得复制、筛选或自动变换 Gate 1 的 OCR、图片识别、业务抽取、manifest 交易、成品表格或预览结果，也不得复用 Gate 1 的媒体字节或解码结果。Gate 2 可以复用来源路径、预期 SHA256 和唯一媒体身份索引，但必须从每个唯一原始媒体 fresh-read 字节并完整 decode 一次；该次读取结果可在本次 Gate 2 内供同一媒体的全部交易引用复用。每一份 Gate 1 归档副本仍按 `resolvedPath + expectedSha256` 单独重读核验，不能因另一归档路径或原图具有同一 SHA 而跳过。独立输入必须有自己的 `independentEvidenceReviewDigest`，并纳入 Gate 2 报告摘要。

独立视觉复核只在 Gate 1 获得有效确认后执行，不得提前加入 `--prepare` 或 Gate 1 渲染热路径。其目的包括发现 Gate 1 的漏读、错读、金额、人员、分类、补报归属、证据对应和展示错误，不能退化为只比较文件哈希或复制 Gate 1 结论。

## 全量对应范围

复核必须从独立证据观察结果出发，逐项建立以下对应关系：

1. 每个 source scope 和 source unit 的使用、排除或无图状态都有唯一终态。
2. 每个 manifest 交易恰好对应明细、文字说明、候选本批行，以及适用的截图引用和补报行。
3. 每个唯一媒体按原始 SHA256 恰好归档一次；每个媒体引用都有交易归属。合并来源、重复引用和 `context` 单次展示不得减少引用审计数量。
4. 日期、人员、事项、分类、补报属性、结算状态、`sourceAmount` 和 `reimbursementAmount` 在全部交付物中一致。
5. 按人员、分类、结算状态、补报人员和全批次的合计由逐项结果重新汇总，并与 manifest expected、文字说明、工作簿公式和候选本批投影分别比较。
6. 候选检查只覆盖绑定的 `batchRows`、局部坐标补丁及未触及部件摘要，不检查历史全表业务。

## 报告契约

Gate 2 输出 `gate2-full-correspondence-v1`，至少包含：

- `candidateBindings[]`（每个 profile 的 `candidateSha256/planSha256`）、`sourceCoverageDigest`、`batchRows`；
- `independentEvidenceReviewDigest`；
- `transactionResults`：每笔交易的规范事实、按 sourceRef 的独立观察、各阶段 `checks`、定位、`requiredStages`、`fullyAudited` 和最终状态；必经阶段包括 visual、detail、screenshot、summary、candidate、root-preview、preview-binding、evidence，补报交易还必须经过 supplement；
- `mediaResults`：每个唯一媒体及每个引用的 SHA256、归属、归档和截图表显示结果；
- `supplementResults`：每位补报人员的期间、原因、逐笔明细和汇总对应结果；
- `annotationResults`：每条说明注释的独立观察、绑定和状态；
- `coverage`、`perPerson`、`perClassification`、`totals`；
- `missing`、`extra`、`duplicate`、`unbound` 和 `mismatches`；
- `previewBindingDigest`；
- `reportDigest`，其 preimage 必须覆盖上述全部字段，且不得包含自身。

`transactionResults`、`mediaResults` 和 `annotationResults` 必须保留逐项状态，不能只输出总数或布尔值。`coverage.auditedTransactions` 只统计全部必经阶段实际完成的交易；任一工件解析失败时，相关交易必须显示 failed/unverified，不能仍标 matched。报告整体 `passed` 还必须要求全部交易、媒体、引用、补报和注释逐项 matched。报告中所有集合采用稳定排序，金额使用定点字符串，任何未知字段或缺失字段都视为不合格。

## 性能与安全约束

- Gate 1 热路径的独立复核新增成本必须为零；Gate 1 只保留原有材料收集、成品构建、候选和预览工作。
- Gate 2 中每个交付工件只读取并解析一次，所得结构化表示供逐项对应、汇总和报告共同复用。
- 每个唯一媒体从原始路径 fresh-read、核对 SHA256 并完整 decode 一次；多个交易引用不得触发重复磁盘读取或重复解码。
- 候选总表只读取当前绑定的 `batchRows`、必要表头和局部补丁摘要，禁止为 Gate 2 扫描历史全表业务。
- 性能评估基线固定为只读安装版本 `0.5.0+codex.20260819174146`，禁止修改其文件或缓存。使用同一机器、同一完全合成批次和相同冷/热规则，分别比较旧版 `prepare + Gate 1 + finalize` 与新版 `prepare + Gate 1 + full-correspondence Gate 2 finalize` 的插件可控代码阶段总耗时。20% 仅作为默认信息性改善目标；通过仍要求输出完全等价、p95 不退化且冷/热峰值内存增幅均不超过 15%。
- 外部人员或模型生成独立观察的等待时间必须单列记录并从插件计时中排除；插件读取 `independent-evidence-review-v1`、校验其摘要、每个唯一媒体的 fresh-read/decode、逐项审计、汇总和 `gate2-full-correspondence-v1` 报告生成均属于插件可控阶段，必须计入。新旧测量使用同一计时边界，且不得以等待时间排除掩盖插件内部工作。
- 未达到信息性改善目标时如实报告，并优先 review 重复文件读取、图片解码、OOXML 解析和摘要计算；不为跨过目标继续叠加低收益复杂度。不得通过跳过第二视觉读取、信任 Gate 1 抽取、减少媒体/交易/交付物覆盖或只验哈希来提速。

## 失效与展示

只有 `missing`、`extra`、`duplicate`、`unbound`、`mismatches` 全为空，全部逐项状态通过，并且候选、计划、来源覆盖、本批行区段、独立复核和预览绑定均未变化时，才能生成 Gate 2 binding；成功报告的 disposition 为 `PASSED`。

Gate 1 工件被成功读取且完成有效 review 后确认的任一内容 mismatch，都表示用户确认的 Gate 1 材料不再成立：报告 disposition 为 `SUBSTANTIVE_MISMATCH`，立即使当前 Gate 1 和未完成的 Gate 2 同时失效。修正业务事实或成品后必须重新生成、重新展示并重新获得一个新的 Gate 1，禁止沿用旧确认或只重新运行 Gate 2。独立 review 自身格式/绑定错误、missing/extra/duplicate/unbound、字段不完整或内部冲突、临时权限/I/O/解析/机器问题以及未知内部异常的 disposition 为 `BLOCKED_RETRYABLE`，只阻塞并允许绑定不变时修正后重试，不得据此永久判定 Gate 1 内容错误。

若完整预览绑定未变化，Gate 2 可以复用已核验 Gate 1 PNG 字节，界面也可以不重复展示同一组 PNG；但必须向用户展示本次 `gate2-full-correspondence-v1` 报告及 `reportDigest`、新的 Gate 2 binding、候选路径和候选 SHA256。报告属于门禁工件，不进入最终归档。
