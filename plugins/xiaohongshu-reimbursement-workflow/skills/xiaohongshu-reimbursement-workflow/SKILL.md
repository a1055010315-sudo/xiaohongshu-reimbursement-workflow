---
name: xiaohongshu-reimbursement-workflow
description: "Run or resume the shared Xiaohongshu, company, and residence ordinary reimbursement workflow, or use the isolated legacy correction/reorder path. Collect evidence once, bind full source coverage, generate only affected-profile root/detail/screenshot workbooks, independently audit real OOXML, enforce two exact approval gates, and publish or recover safely. Use for 小红书报销、公司报销、驻所/住所报销, batch continuation, approval, publication, rollback, historical correction, or zero-change ledger reorder; if the user only asks to inspect or modify this skill, do not touch reimbursement files."
---

# 三类报销共享归档工作流

## 1. 模式与引用路由

这是用户唯一需要调用的总控 skill。普通路径由同一套 profile 驱动代码处理 `xiaohongshu`、`company`、`residence`；一次调用后，在同一任务中持续完成收件、核对、归档、候选总表、终审和受控发布。

- **skill-only**：用户只要求查看、审查或修改本 skill。只处理 skill 目录，不读取或改动任何报销材料。
- **workflow**：用户要求处理、续办、核对、审批或发布包含新增交易或历史业务字段修正的具体批次。历史遗漏、人员/项目/金额/分类/结算方式修正仍走本模式，并额外执行历史账本业务修正 reference。
- **ledger-reorder-correction**：用户明确要求只整理、重排或修正既有总表顺序，且不得新增、删除或改变业务记录及金额。执行第 7 节独立状态机，不进入微信取证或本次明细构建。
- **不明确**：只问一句用户要改 skill 还是处理报销，不做报销文件操作。

只完整读取当前阶段需要的 reference；同一任务中同一未变化 reference 不重复读取：

| 当前工作 | 必读 reference |
|---|---|
| 微信或聊天材料收集、核对 | [微信证据核对规则](references/wechat-evidence-review.md) |
| 文字说明、明细、截图归档、对应截图表 | [批次归档与展示规则](references/batch-output-rules.md) |
| 工作簿构建或验收 | [Excel 整理与验收规则](references/expense-workbook-rules.md) |
| 候选总表、两道门禁、发布 | [候选总表与发布规则](references/ledger-publish-rules.md) |
| 补齐历史遗漏、画布分类标注或修改既有业务字段 | [历史账本业务修正规则](references/ledger-business-correction.md) + [Excel 整理与验收规则](references/expense-workbook-rules.md) + [候选总表与发布规则](references/ledger-publish-rules.md) |
| 既有总表零增量重排修正 | [Excel 整理与验收规则](references/expense-workbook-rules.md) + [候选总表与发布规则](references/ledger-publish-rules.md) + [批次归档与展示规则](references/batch-output-rules.md) |
| 第一次调用工作簿工具、发布脚本或清理器前 | [运行可靠性约定](references/runtime-reliability.md) |

处理 `.xlsx` 时同时使用可用的 spreadsheet 能力。reference 是本 skill 的内部规则，不要求用户另行调用。

## 2. 业务边界

1. manifest v3 按固定 registry 把交易路由到 `小红书报销`、`公司报销`、`驻所报销`。只为本批实际有交易的 profile 生成并发布三类文件；无交易 profile 不创建空文件、不修改根表。
2. 三个 canonical 根表/Sheet 分别是 `小红书支出总表.xlsx`/`Sheet1`、`公司支出总表.xlsx`/`公司支出`、`驻所支出.xlsx`/`驻所支出`。`住所` 和 `住所支出.xlsx` 只作 residence 输入别名，输出身份始终 canonical；公司所有未受管 Sheet 必须逐 Part 保持。
3. 用户明确写出具体单子、项目或业务名称时，相关支出备注归入该名称，不得降级为 `日常报销`；具体规范见 Excel reference。
4. 金额只用 BigInt milliunits，最多三位小数，工作簿金额与合计统一使用批准的 `0.000`；超过三位小数先确认，禁止 Number 汇总、二进制浮点和静默舍入。
5. OCR 只辅助定位；原图和用户业务说明才是审计材料。不得覆盖用户原件、历史归档或已验收文件；修正使用 `_修正版N`。
6. 无法从当前对话和磁盘可靠判断的业务事实才询问。一次合并同阶段疑点，并给每项独立编号；视觉疑点必须附对应图片。

## 3. 两道不可省略的门禁

只有以下两句话需要精确匹配；仅移除消息首尾空白，不能带引号、标点、换行或附加文字：

1. `本次报销通过无误`
2. `确认更新根目录支出总表`

第一道门禁仅在适用模式的完整审阅包和候选快照已展示、路径与 SHA256 已报告后，由用户在一条新消息中发送才有效。普通批次一次确认摘要、明细、图片对应关系和候选内容；重排修正确认范围、排序不变量、全区预览和活动候选。不要增加“摘要自然语言确认”这一第三次等待。普通新任务用 `scripts/build_gate_binding.mjs` context v2 机械绑定 `mode + batchId + factsDigest + operationDigest + candidateRevision + 当前候选绝对路径/SHA256 + reviewPackageDigest + candidatePlanSha256 + sourceCoverageDigest`；context v1 只用于恢复已开始批次。重排修正调用 `scripts/build_ledger_reorder_gate_artifact.mjs --gate gate-1` 时，把 `--preview-index` 传成必须不存在的新输出路径；同一调用按“实时全量审计活动候选 → 从该候选受控分段渲染完整重排区 → 写绑定 `planFileSha256 + 候选规范路径/SHA256` 的严格 v2 索引 → 生成 Gate 1 工件”执行，禁止提供既有索引或外部 PNG。展示该工件返回的绑定预览和 `bindingDigest` 后，精确门禁只接受这个当前任务内的摘要；发布器还必须 fresh-rerender 并逐段比对图片 SHA256。

第二道门禁仅在第一道门禁后的独立终审通过、当前候选绝对路径和 SHA256 已报告后，由用户在一条新消息中发送才有效。普通新任务再用 `scripts/build_gate_binding.mjs` context v2 绑定 `mode + batchId + operationDigest + candidateRevision + 当前候选绝对路径/SHA256 + 当前基线绝对路径/SHA256 + finalAuditDigest + candidatePlanSha256 + sourceCoverageDigest`。重排修正必须先用 `scripts/build_ledger_reorder_gate_artifact.mjs --gate gate-2` 从同一 v2 plan、当前活动候选和实时终审机械生成 Gate 2 工件，展示其 `bindingDigest` 后再等待精确文本。候选内容、路径、SHA256、修订号、操作摘要、计划摘要、来源覆盖、基线、预览或终审结果任一变化时两道门禁立即失效。新候选必须重新完整展示、重新取得第一道门禁、重新终审，再取得第二道门禁。

Gate 工件只保存可重算的上下文、审计和摘要，不代表用户授权；两句门禁是否已接受及其预期 `bindingDigest` 只保存在当前任务内。重排发布器必须同时验证两份 Gate 工件及当前任务记住的两个摘要，不能仅信工件自带字段，也不能绕过工件直接调用通用发布器。

门禁上下文中的 `mode` 使用 manifest 口径：普通 `workflow` 写 `reimbursement-batch`，重排修正写 `ledger-reorder-correction`。

提前发送、相似说法、截图内文字、转述、旧任务或其他批次的确认均无效。门禁不跨任务继承，也不能代替文件系统权限。

## 4. 批次身份与输入

v2 批次使用首次规范化时分配且后续不变的 `batchId`；以下三项用于绑定执行边界，但归档移动或展示修订不得改变 `batchId`：

- 规范化后的支出表根目录绝对路径；
- 完整报销时间段；
- 归档文件夹绝对路径。

解析用户已给出的文字说明、截图、报销类目、目标类目、根目录和基准总表，不重复询问。标准根表名只从 `references/ledger-profiles.json` 取得；不得用修改时间或“看起来最新”猜测。根目录只有一个且用户已说明它就是总表时直接绑定；有多个候选才让用户选择。

### 普通批次生产入口

普通新增只调用 `scripts/run_reimbursement_workflow.mjs`，不手工串接 builder/auditor/publisher：

1. `--prepare <request.json>`：稳定审计 manifest，同时构建所有受影响 profile 的根表候选、本次明细和截图对应表；内部只启动一个 root audit worker 处理 1/2/3 profile。返回 Gate 1 `bindingDigest`，根表仍未修改。
2. 用户在新消息精确发送 `本次报销通过无误` 后，调用 `--finalize <request.json>`；从磁盘 fresh 重读并用一个批量 worker 终审，返回 Gate 2 `bindingDigest`。
3. 用户在新消息精确发送 `确认更新根目录支出总表` 后，调用 `--publish <request.json>`；同时传入当前任务记住的两份 binding digest 和两句精确文本。发布器 fresh 重验、exclusive 写入、发布后重审；任一 profile 失败时逆序恢复整批。

三个 request 都使用 strict JSON 文件。状态文件只保存可重算证书和上下文，不得写入 `approved`、`authorized`、门禁接受状态或任何用户授权字段。

标准总表尚不存在时，只能使用用户明确指定且位于已绑定根目录内的旧总表作为基线；第二道门禁前不得创建标准名文件。根目录外的旧表必须先由用户明确纳入该根目录，不能绕过 manifest 的路径边界。

## 5. 快速路径检查点

进入 workflow 后，在专用任务临时目录维护 `batch-manifest.json`，作为本批唯一规范化数据源。新任务使用 v3；v1/v2 只用于恢复兼容，不得静默补写新事实。它不属于最终归档，不得写入截图工作簿的隐藏 Sheet，也不得保存任何门禁或用户授权。至少记录：

- 批次身份、registry/profile 配置摘要、规则版本和每个受影响 profile 的基线路径/SHA256；
- 来源编号、原图或文字路径、SHA256、尺寸、检查状态和图内区域；
- 稳定 `batchId`、交易 ID、唯一正安全整数 `sourceOrder`、日期、人员、项目、汇总标签、金额、canonical profile/category、最终 `classification`、独立的 `settlement` 结算方式和来源引用；新增记录只能分配新 `sourceOrder`，不能因展示排序重排；负数退款/调整还必须引用同 profile、同类目、同结算方式的正金额来源交易；
- v3 的来源范围、末端确认和每个来源单元的唯一处置；每个单元只能是已关联交易、已唯一存在于对应 profile 基线或有明确排除原因，禁止把其他受支持 profile 当作“非目标”排除，也禁止裸行号排除。`sourceCoverageDigest` 与交易事实摘要分开计算；
- 当前 `reviewRevision` 和操作配置；候选的 `candidateRevision` 在 `artifact-index.json` 维护，普通批次首次候选为 1，每生成一个新字节版本单调递增。`ledger-reorder-correction` 的 manifest operation 还必须记录 `candidateRevision`、`planFileSha256`、精确重排范围/日期边界、`date:asc + baselineOrder:asc` 排序键、每条记录的基线顺序号、逻辑记录数与物理记录行数、`expectedAmountDelta: "0"`、基线与当前/被替代候选路径及 SHA256；首版使用 `supersedes: null`，后续修订必须指向唯一被替代候选。候选绑定由机械计划和构建结果写入，禁止手工补写。

由同一 manifest 驱动摘要预览、本次明细、截图对应表、归档和候选校验，禁止各阶段重新解析同一材料。摘要优先直接用 `--manifest` 机械投影，兼容旧批次时产生的输入 JSON 也不得成为第二套可手工维护的业务事实。输出路径/SHA256、行映射、图片锚点和验收证书放在同一临时目录的 `artifact-index.json`/sidecar，不把用户授权写回 manifest。验收证书只绑定它实际依赖的 `factsDigest`、`evidenceDigest`、操作/配置摘要和文件 SHA256，不能用整份 manifest 的无关展示状态造成全量失效。`reviewPackageDigest` 由摘要正文、明细语义、对应图顺序与图片哈希、缺图/排除清单及候选 SHA256 机械计算；`finalAuditDigest` 由终审不变量和当前基线/候选 SHA256 机械计算。

### 失效规则

- 每次恢复任务都重新枚举精确材料目录并比较路径、大小和 SHA256；只重新打开新增或内容变化的材料，未变化文件复用既有完整视觉核验结果。
- 用户纠正人员、项目、日期、金额、类目、`settlement` 结算方式或证据归属时，只失效受影响交易及全部下游输出；第一道门禁后发生任何业务修正时，两道门禁和终审全部失效。
- 画布标注先汇总为累积补丁集。每个新候选都从同一绑定根表基线 + 完整 manifest + 全部补丁重建，禁止在上一候选上继续打补丁；行号只定位，修改前完整业务指纹不匹配时阻塞。
- 摘要、逐笔对应表、金额、缺图说明或其他用户可见审阅内容变化时递增 `reviewRevision`；第一道门禁只绑定用户最后完整看到的 revision。
- 候选工作簿字节、SHA256、候选修订号、重排范围或排序策略发生任何变化时，两道门禁和终审全部失效；不得把旧确认迁移到新候选。
- 根表 SHA256 变化只失效候选及其下游，不要求重看未变化的原始图片。
- 已发布批次若只修订本次明细的分区、颜色、列宽或说明文字，且规范化交易多重集合、金额、证据、摘要、候选和根表哈希都未变化，走“纯展示修订”分支：创建新的 `_修正版N`，只重验明细语义/公式/视觉并递增 `reviewRevision`；该 revision 只标识新的展示产物，不改写已完成的账本发布状态，也不复用旧门禁；旧版移入可恢复的同级历史目录，不再次追加或发布根表，也不索取第二道门禁。任一业务字段变化都不得走此分支。
- 任一依赖哈希、manifest 摘要或规则版本变化时，禁止复用对应验收证书；未变化时禁止无理由重复导入、解压、渲染或返回微信。

## 6. 批次状态机与分流

先只读检查精确路径、哈希、manifest 和工作簿可打开性，再从最早未完成状态继续：

| 磁盘状态 | 下一步 |
|---|---|
| 只有材料 | 阶段 A：一次收集并本地核对 |
| 材料已核对 | 阶段 B：批量生成或验证归档产物 |
| 阶段 B 通过 | 阶段 C：生成候选总表 |
| 候选和业务核对包已展示 | 等待第一道门禁 |
| 已收到第一道门禁 | 执行独立终审 |
| 终审通过 | 报告候选路径/SHA256，等待第二道门禁 |
| 已收到第二道门禁 | 发布前重读、受控发布、发布后复核 |
| 已发布且用户明确要求纯展示修订 | 生成明细修正版、独立验收、归档旧版；根表不变 |
| 用户要求既有总表零增量重排 | 切换到 `ledger-reorder-correction` 独立状态机 |

同事已完成且哈希未变化的产物只验证一次，不重做。归档保存数据检查点，但不保存授权。

## 7. `ledger-reorder-correction` 独立状态机

只在用户要求整理既有总表顺序，且预期交易增量和金额增量都为零时进入本模式。只要发现日期、项目、金额、支出人、备注/分类、报销属性或交易数量需要改变，就立即退出本模式，转入相应批次/业务修正流程并重新取得门禁。

按下列状态顺序执行，不借用新增报销批次的“本次明细 + 增量”判定：

| 状态 | 必须完成的动作 |
|---|---|
| R0 绑定 | 只读建立严格 request，绑定根目录、根表绝对路径/SHA256、系统临时目录 marker、暂存/活动候选/标准目标路径、候选修订号、工作表、精确物理范围和日期边界；调用 `scripts/generate_ledger_reorder_plan.mjs` 机械识别记录并生成不可手填的 v2 plan。根表保持字节不变。 |
| R1 构建 | 只使用该 v2 plan 调用 `scripts/build_ledger_reorder_candidate.mjs` 在专用临时目录生成新的暂存 `_修正版N`；业务多重集合与基线完全相等，金额增量严格为 `0`，范围外内容/公式/样式/行高/合并关系不变，范围内按 `date:asc + baselineOrder:asc` 稳定排序。完整位于一个逻辑记录内的竖向/横向合并可作为连续多行记录整体迁移；跨记录、跨边界或无法无损迁移时报告 `unsupported` 并阻塞。 |
| R2 验收与展示 | 严格执行“独立审计暂存候选 → 晋升为活动 `_修正版N` → Gate 1 同调用重审活动候选并受控渲染完整重排区 → 写绑定 plan/候选的全新 v2 预览索引 → 机械生成 Gate 1 工件 → 展示该工件返回的预览”顺序；晋升前不得展示为可确认版本，standalone 预览索引不得交给 Gate 1 复用。全部通过后报告活动候选绝对路径、修订号、SHA256、`planFileSha256`、Gate 1 `bindingDigest` 及“根表未修改”，再等待第一道门禁。 |
| R3 独立终审 | 收到绑定当前 Gate 1 摘要的有效第一道门禁后，从磁盘独立重读基线和候选，重算记录多重集合、笔数、十进制定点金额、范围边界、稳定顺序、公式、样式、行高、合并及 OOXML 关系；通过后机械生成 Gate 2 工件，再报告当前候选路径/SHA256 和 Gate 2 `bindingDigest`，等待第二道门禁。 |
| R4 发布前重读 | 收到有效第二道门禁后重新计算根表和候选 SHA256，并重验 R1 的全部不变量；任何变化都停止发布并使两道门禁失效。 |
| R5 受控发布 | 仅按发布 reference 调用受控发布器，并传入 v2 plan、两个 Gate 工件及当前任务内已获批准的两个 `bindingDigest`；发布器实时重验 plan、候选、审计、预览和基线绑定。发布后重新打开根表并确认 SHA256 与候选一致，所有 R1 不变量仍成立。 |

候选字节/路径、plan 字节/摘要、重排范围、排序策略或候选修订号变化时回到 R0/R1，生成新的 plan 和 `_修正版N` 后重新执行 R2 并重新取得两道门禁。活动归档版本晋升和活动候选独立审计必须在 R2 展示前成功；晋升失败或出现多个当前版本时阻塞，不得进入门禁或发布。

## 8. 阶段 A：一次收集、本地核对

1. 固定本批可审计边界；微信材料必须在同一次连续遍历中完成来源编号、业务文字登记、候选原图保存和末端确认。
2. 离开微信前确认候选数、保存数和末端状态；之后的放大、金额识别、去重、归档、展示和制表只使用本地文件。只有缺失、不可读、关键上下文截断或用户新增材料时才返回微信。
3. 逐张完整检查原图。区分来源图片数、图内金额候选数和规范化交易数；按时间、参与方、方向、状态及交易标识判断付款、退款、优惠、计算项或重复状态。
4. 建立“业务说明 ↔ 来源图片/区域 ↔ 规范化交易 ↔ 明细行”的多对多关系。凭证、用户业务说明和计算依据职责不同，冲突时询问。
5. 确实无截图的记录只有用户明确确认后才可继续，并在明细备注写 `无截图（用户确认，问题N）`；不得伪造凭证，也不写入汇总文字说明。
6. 阶段 A 只展示疑点涉及的图片，不提前全量展示。完整对应表统一在阶段 B 验收后展示一次。

只有业务文字均有处置、金额候选均已分类、每笔交易有凭证或已确认缺图，才进入阶段 B。

## 9. 阶段 B：一次构建、一次验收

按批次归档 reference 生成：摘要预览、每个受影响 profile 的按人员连续分区本次明细、原图归档和带嵌入图片的对应截图表。人员分区只是明细展示结构，分区标题和空白分隔行不是交易，不得进入候选或根表。最终归档不得出现内部 manifest、验收证书、预览、日志或差异说明。

同一构建进程可批量生成所有阶段 B 工作簿；同一语义验证进程各打开一次；同一视觉进程只渲染有界实际数据区。同一阶段、同一工作簿字节版本内，每张来源图只读取、解码和登记一次；独立重开验证仍可读取已打包媒体，业务行不得因图片 SHA256 相同而删除。

验收后在对话中一次性给出完整业务核对包：

1. 与最终 TXT 完全一致的摘要原文及摘要 SHA256；
2. 与本地工作簿同数据、同图片顺序的逐笔对应表，所有 `图N` 直接显示；
3. 本次明细的行数、金额汇总和路径；
4. 已解释缺图、分类或拆分清单。

没有未决疑点时不要等待额外自然语言确认，直接进入阶段 C。用户主动纠正时按失效规则处理。

## 10. 阶段 C：候选快照，根表不变

按候选与发布 reference 绑定每个受影响 profile 的正式基线并生成候选。普通新增只使用 `build_root_workbook_candidate.mjs` 的 profile 驱动 patch 和独立 auditor；不得导入本次明细的人员标题、空白分隔行或展示结构。历史业务修正仍使用原隔离流程，不能混入普通入口。第二道门禁前不得编辑、创建或替换任何 canonical 根表。

随后补齐业务核对包中的候选绝对路径、SHA256及“根目录总表未修改”。到此等待第一道门禁；不要主动索要第二道门禁。

## 11. 第一道门禁后的终审

本节用于包含新增交易的 `workflow`；`ledger-reorder-correction` 按 R3 终审，不得要求不存在的本次明细或摘要。

收到有效的 `本次报销通过无误` 后：

1. 按 profile 重新读取每份本次明细，排除人员标题、表头、说明和空白分隔行后，使用 BigInt milliunits 独立重算人员/分类汇总、费用合计和实报合计；确认其他 profile 的交易未进入当前明细或候选。
2. 将摘要预览按同一输入写入最终 UTF-8 TXT，并核对正文 SHA256 与用户看到的预览一致。
3. 重新计算根表和候选 SHA256。对 manifest、对应截图表和原图：哈希及规则版本未变化时验证既有验收证书，不重新打开或渲染；变化时只重验受影响部分。
4. 核对候选业务多重集合、金额增量、公式、合并、已解释缺图和所有归档文件；历史业务修正还要重新核对来源覆盖、累积补丁链、候选布局计划以及独立 `audit_ledger_layout.mjs` 结果。

任一项失败只修正受影响部分并重新终审。全部通过后报告当前候选绝对路径和 SHA256，并明确询问用户是否发送第二道精确文本。

## 12. 第二道门禁与发布

本节的新增交易等式用于 `workflow`；`ledger-reorder-correction` 按 R4 的零增量等式和范围不变量重验。

收到有效的 `确认更新根目录支出总表` 后，必须从磁盘重新读取当前根表和当前候选；`workflow` 还要重新读取本次明细。随后重新验证：

- 每个受影响 profile 的当前根表业务记录多重集合 + 本批该 profile 明细 = 该 profile 候选业务记录多重集合；
- 当前根表 SHA256 与终审基线一致；
- 候选 SHA256 与终审报告一致。

任何不一致都使两道门禁失效，不能用旧候选覆盖新根表。普通 `workflow` 仅调用 `scripts/run_reimbursement_workflow.mjs --publish`；`ledger-reorder-correction` 仅调用绑定 v2 plan、两份 Gate 工件及当前任务批准摘要的 `scripts/publish_ledger_reorder.mjs`。不得绕过总控入口直接调用 PowerShell 或通用 publisher。发布后从真实 OOXML 重新打开每个根表，SHA256 必须与候选一致。

## 13. 最终报告与清理

最终只报告用户需要判断的结果：批次和各 profile 归档路径、费用/实报/不实报金额、profile 隔离结果、明细行数、截图数、对应表 Sheet 与图片实例数、候选和根表路径、两道门禁状态、发布后 SHA256，以及临时内容是否清理。

只清理由本任务创建且确认无用的专用临时内容。不得删除用户原件、归档交付物、历史文件、依赖 skill 或归属不明内容。按运行可靠性 reference 调用 `scripts/cleanup_task_temp.mjs`；清理器拒绝时保留现场并报告精确路径和原因。
