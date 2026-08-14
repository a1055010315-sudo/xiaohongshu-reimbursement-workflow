# 候选总表、统一门禁与发布规则

普通批次的候选、两道统一门禁和协调发布使用本页。执行、缓存和临时目录见 `runtime-reliability.md`；工作簿语义见 `expense-workbook-rules.md`；根表和目标 Sheet 白名单见 `ledger-profiles.json`。

## 1. 父批次绑定

从 manifest v3 交易机械得出 `affectedProfiles`，规范名只允许 `xiaohongshu`、`company`、`residence`，并按配置固定排序。为每个 profile 绑定：

- 唯一根表规范绝对路径和 SHA256；
- 唯一可编辑 Sheet 及 A–F 表头指纹；
- 候选路径、候选修订号和计划路径；
- 所有保护 Sheet 及未授权 OOXML parts 摘要。

第二道门禁前所有根表必须保持字节不变；所有构建只发生在任务临时副本。一个 profile 时目标数组长度为 1，不等待或创建其他 profile。

## 2. 运行前防漂移

候选前执行 Excel reference 的结构与格式预检：

- `STRUCTURE_DRIFT`：缺列、插列、D 列缺失、表头错位、目标 Sheet 缺失/歧义；停止该 profile，禁止猜测。
- `LAYOUT_DRIFT`：列宽、行高、对齐、合并、打印设置异常；停止发布并生成修复候选。
- `STYLE_DRIFT`：字体、填充、边框或角色颜色异常；根表不动，按样式契约生成修复候选。

修复候选与报销候选合并成该 profile 的同一当前修订，并进入统一门禁；不要先在根表上修格式再做报销。

## 3. 已包含与增量

每个 profile 独立比较稳定业务多重集合：规范化日期、项目、Decimal 金额、人员/主体、classification、settlement、稳定来源标识。

- **完全未包含**：追加本 profile 全部交易。
- **唯一可追溯精确子集**：只追加缺失交易，并在统一审阅包列明已存在/新增数量。
- **完整包含**：停止该 profile 的追加，核验既有发布并报告。
- **相似但不能唯一追溯或字段冲突**：阻塞统一 Gate 1，不得猜测。

同额交易只有在证据和全部业务字段能证明独立时并存。截图 SHA256 证明证据内容，不单独充当交易身份。

## 4. 候选构建与独立审计

父编排器一次接收所有受影响 profile；各 profile 可并行构建/审计，但不得复制业务事实：

```text
"<bundled-node>" scripts/run_reimbursement_batch.mjs --input <batch-run-plan.json>
```

对每个 profile：

1. 从绑定基线 + 本 profile 的 manifest v3 机械投影直接构建，不导入明细中的人员标题、空白行或展示结构。
2. 候选多重集合必须等于基线 + 尚未包含交易；金额增量等于尚未包含费用合计，其他 profile 增量为零。
3. `company_paid_no_reimbursement` 进入候选和费用合计，但从实报合计排除。
4. 按 `date:asc + sourceOrder:asc` 稳定排序；D/E/F 同组同范围合并，D 公式、样式、显示和非锚点 OOXML 满足契约。
5. 独立审计器从实际候选 XLSX/OOXML 自行提取事实、公式、合并、样式和保护页摘要；不得相信构建器传入的 `actualRows`、费用组或 `actualMerges`。
6. 根表 SHA256 在构建前后必须不变；保护 Sheet 的值、公式、样式、合并、行列尺寸、关系和 OOXML 摘要差异为零。

历史业务修正额外执行 `ledger-business-correction.md`，每一版都从绑定基线 + manifest v3 + 累积补丁重建，不从废止候选继续修改。

## 5. 统一 Gate 1

只有所有 profile 都完成候选、金额/来源/工作簿审计和必要视觉预览后，先从 `ready-for-unified-gate-1` 状态及明确列出的每 profile 渲染路径生成统一复核工件：

```text
"<bundled-node>" scripts/build_reimbursement_review_artifacts.mjs --input <review-artifact-request.json>
```

请求严格包含 `version + batchStatePath + profiles + outputs`；`profiles.<profile>.renders` 是非空规范绝对路径数组，`outputs.previewIndexPath/reviewPackagePath` 是批次任务根的两个全新直接子级 JSON。脚本重新哈希 ready state、facts、候选审计、基线、候选、明细和全部 render，生成结构化 `reimbursement-batch-preview-index` 与 `reimbursement-batch-review-package`，写入使用独占创建语义，拒绝覆盖。preview index 按固定 profile 顺序绑定候选、可选明细及全部 render 的路径/SHA256；review package 绑定 `factsDigest`、逐 profile `candidateAuditDigests` 和 `previewIndexDigest`。

随后把同一对输出路径/SHA256填入 Gate 1 的每个 profile，再调用：

```text
"<bundled-node>" scripts/build_batch_gate_artifact.mjs --input <gate-1-request.json> --output <new-gate-1.json>
```

Gate 1 工件按固定 profile 顺序绑定：父 `batchId`、`affectedProfiles`、事实/来源/操作/样式摘要、每个 profile 的基线、候选和本次明细规范路径/SHA256、候选修订号、候选计划、独立明细/候选审计和预览，以及统一 `reviewPackageDigest`。明细必须带由实际工作簿独立计算的 `detailAuditDigest`；脚本从磁盘重新哈希实际依赖，不接受调用方声称 `verified`。

完整展示：每个 profile 的人员/分类汇总、费用/实报/不实报金额、缺图/排除清单、候选路径/SHA256、关键预览及父 `bindingDigest`。随后只等待一次精确文本 `本次报销通过无误`。

任何 profile 尚未 ready、存在未决问题或基线发生漂移时，不开放门禁。已完整写出的父 `facts/build/audit/ready` 阶段可在计划与磁盘哈希完全一致时续跑；半成品候选不得视为缓存。

## 6. 独立终审与统一 Gate 2

收到绑定当前 Gate 1 的有效第一句后，各 profile 并行从磁盘独立终审：

- 用 Decimal 重算人员/分类、费用、实报、不实报及本批增量；
- 重读候选事实、公式、合并、样式、保护 Sheet 和未授权 OOXML；
- 重算根表和候选 SHA256；
- 未变化证据、截图表及视觉证书只验证缓存绑定，不重复 OCR、解码或渲染。

全部通过后，先把本次独立终审写成新的、只读重开所得的 Gate 2 终审证书：

```text
"<bundled-node>" scripts/build_reimbursement_final_audit.mjs --input <final-audit-request.json> --output <new-final-audit.json>
```

终审请求必须绑定 Gate 1 已展示的同一 `batchId/affectedProfiles/facts`，并逐 profile 绑定当前基线、候选、候选审计和可选明细的路径与 SHA256。输出必须为 `kind: reimbursement-batch-final-audit`、`phase: gate-2-final-audit`，且不得与 Gate 1 的候选审计复用路径、SHA256 或摘要。

随后调用：

```text
"<bundled-node>" scripts/build_batch_gate_artifact.mjs --input <gate-2-request.json> --output <new-gate-2.json>
```

Gate 2 请求还必须提供 `gate1ArtifactPath/gate1ArtifactSha256/gate1BindingDigest`、`finalAuditPath/finalAuditSha256/finalAuditDigest`，并继续绑定 Gate 1 已展示的当前 `previewIndex`。Gate 2 绑定同一父批次和全部 profile 当前基线/候选，并增加统一 `finalAuditDigest`；它不能跳过 Gate 1，也不能把 Gate 1 的 review package 当成发布授权。展示所有路径、SHA256 和父 `bindingDigest` 后，只等待一次精确文本 `确认更新根目录支出总表`。

事实、profile 集合、基线、候选、计划、样式契约、审计或预览任一变化，使父批次两道门禁全部失效。未变化证据/OCR可以按内容哈希复用；工作簿按当前父计划和完整阶段证书决定是否重建，统一工件必须重建、重展示和重新确认。

## 7. 多目标协调发布

收到绑定当前 Gate 2 的有效第二句后，从磁盘重读所有根表、候选和 Gate 依赖，再调用：

```text
"<bundled-node>" scripts/publish_reimbursement_batch.mjs --input <publish-or-recover-plan.json>
```

发布器必须：

1. 按规范目标路径固定排序并锁定全部目标；单 profile 使用同一逻辑，目标数组长度为 1。
2. 重新验证 Gate 1/2 摘要、根表/候选 SHA256、结构预检、最终审计和 `affectedProfiles`。
3. 建立一个父事务 journal；所有旧根表恢复副本保留到最后一个目标完成发布后审计。
4. 任一目标失败时，按反向顺序恢复本事务已经替换的所有根表；外部并发改变导致无法证明时保留精确现场并 fail-closed。
5. 崩溃恢复时：全部等于候选则收口；部分发布则恢复全部基线；无法唯一判断则保留 journal、目标和备份并阻塞。
6. 所有目标重新打开并通过 SHA256、事实、公式、结构、样式和保护 Sheet 审计后，才标记整批成功并清理恢复材料。

这实现“全成或全回滚”的协调事务，不宣称跨目录有操作系统层面的瞬时原子替换。不得连续手工调用旧单表发布器冒充多目标事务，不得直接编辑根表、拼接 PowerShell、强制关闭 Excel 或绕过 Gate 工件。

## 8. 等待期间外部变化

任一根表 SHA256 改变时禁止用旧候选覆盖：

- 未包含本批：从最新根表重建该 profile 候选；
- 唯一包含精确子集：只追加缺失记录并重建；
- 已完整包含：核验外部发布并停止该 profile 的重复追加；
- 相似、歧义或冲突：列出差异并阻塞。

新候选不得覆盖旧候选；其 revision 单调递增。变更使整个父批次 Gate 失效，但未受影响 profile 的事实和证据缓存可以复用。

## 9. 最小留档

新普通任务默认 `minimal-current-only`：候选、journal、回滚副本、Gate 工件、预览和内部证书只在任务临时区存在。成功后每个专项既有归档只保留该 profile 的当前明细、截图表、凭证、当前总表快照及一份精简 `发布审计.json`；父 `batch-run`、Gate、缓存和回滚材料不进入专项归档。不创建公共父归档，也不创建长期 `_历史版本` 或 `待确认_历史版本`。用户要求延续旧周期时修改已绑定 `archivePath`，不另建新周期目录。

失败、外部替换或无法证明归属时保留精确恢复材料并报告。旧任务、零增量重排或恢复任务继续使用 `legacy-history` 和既有单账本 plan/审计/晋升/发布工具，不静默迁移或删除历史文件。
