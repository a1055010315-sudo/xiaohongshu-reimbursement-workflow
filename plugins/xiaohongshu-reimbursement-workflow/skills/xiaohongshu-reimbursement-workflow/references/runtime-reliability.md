# 运行可靠性约定

本页约束统一报销批次的执行、缓存、临时目录、门禁工件和发布恢复；不改变业务金额口径。每个任务完整读取一次，磁盘内容未变化时不重复读取。

## 1. 一次取证、分层并行

普通父批次按三个隔离阶段运行：

1. **事实冻结**：一次枚举和读取材料，生成 manifest v3、证据索引及 `affectedProfiles`。
2. **构建/独立审计**：每个受影响 profile 的基线只导入一次；构建关闭后，独立进程从持久化 XLSX/OOXML 重开一次完成事实、金额、公式、合并、样式、保护 Sheet 和图片锚点审计。
3. **有界视觉审计**：批量渲染首屏、末屏、最长合并块、分页/布局边界和异常区；仅异常时扩大范围。

同一阶段不要按 Sheet、图片或检查项反复启动。并发上限：证据哈希/普通校验 3，Excel 构建/审计 2，重型渲染 1～2；不得并发操控同一个微信或 Excel UI。

全部异步操作显式 `await`。每个进程只输出一条紧凑 JSON；真实异常返回非零，成功显式设置 `process.exitCode = 0`。大段数据、预览和 sidecar 只放任务临时目录。

## 2. Manifest v3 与父批次

新建或因本规则重建的普通批次只使用 manifest v3；v1/v2 仅只读恢复，不得静默补写新事实。父批次至少维护：

- 稳定 `batchId`、完整时间段、根目录和归档边界；
- 规范化 `affectedProfiles`，只含 `xiaohongshu`、`company`、`residence`，按固定顺序；
- profile 配置和样式契约 SHA256；
- 每个 profile 的根表/目标 Sheet/保护 Sheet、基线路径/SHA256 和候选修订；
- 来源范围、末端确认、来源单元和唯一处置；
- 每笔交易唯一 ID、正安全整数 `sourceOrder`、profile、日期、人员/主体、项目、严格 Decimal 金额、classification、settlement 和来源引用；
- `reviewRevision`、操作配置和期望的 profile/费用/实报/不实报合计。

每个 profile 的 manifest v3 是父事实的机械只读投影；不得形成三份可分别手工维护的业务源。父 manifest 和 Gate 工件均不得保存用户授权状态。

`settlement` 只允许 `employee_reimbursement` 或 `company_paid_no_reimbursement`，与 profile 独立。负数必须为可追溯退款/调整，并引用同 profile、同 settlement 的正金额来源；退款累计绝对值不得超过来源金额。交易日期必须是合法 `YYYY-MM-DD`；金额输入最多三位小数，禁止负零和静默舍入。

新任务用 `audit_batch_manifest.mjs` 验证 Decimal、日期、profile、settlement、合计、调整、来源覆盖、引用和材料哈希，取得 `factsDigest`、`evidenceDigest`、`sourceCoverageDigest`、`operationDigest`、`configDigest`。`factsDigest` 不含展示修订或候选状态；来源覆盖摘要与交易事实摘要分开。

## 3. 任务级缓存

使用 `"<bundled-node>" scripts/batch_cache.mjs --input <cache-request.json>` 执行 `canonical-digest` 或 `hash-files`，生成规范哈希；不要建立跨任务长期数据库。证据/OCR索引可以在当前任务内按内容哈希复用，门禁和授权不得缓存。

分层键：

1. **证据索引**：规范路径、大小、mtime、内容 SHA256、图像区域、识别器版本；同一证据/区域只哈希、解码和识别一次。
2. **事实快照**：manifest v3 事实、来源覆盖和规则版本摘要。
3. **工作簿候选**：基线 SHA256 + profile 事实摘要 + profile 配置摘要 + 样式契约摘要 + 构建器版本。
4. **审计/视觉证书**：候选 SHA256 + 独立审计器/渲染器版本 + 实际依赖摘要。

当前可执行恢复边界是完整父阶段：`facts → build → audit → ready`。`run_reimbursement_batch.mjs` 发现已有阶段文件时，必须验证阶段前缀完整、计划/配置/样式摘要相同，并重新哈希基线、候选和明细；完全匹配才从下一阶段继续。乱序输出、半成品候选、哈希变化或事实差异一律阻塞。依赖变化时创建新的修订计划和输出路径，不覆盖或冒充旧阶段。

复用规则：

- 只改样式不返回微信、不重复 OCR；
- 只改一个 profile 时，另外 profile 的未变化证据/OCR结果应按内容哈希复用；统一工作簿是否重建由新父计划决定，不承诺跨事实修订复用旧候选；
- Gate 1 后候选未变时，Gate 2 只进行独立财务/磁盘终审，不重复 OCR、证据解码或视觉渲染；
- 根表 SHA256 变化只失效该 profile 候选及父门禁，不要求重看未变化原图。

缓存不能越过安全边界：Gate 1 后仍独立重算金额，Gate 2 前仍重读全部受影响根表和候选，发布后仍重新打开目标。

## 4. 结构预检与工作簿阶段

读取微信前，对每个待处理 profile 运行快速预检，缓存键为：

```text
baselineSha256 + profileConfigDigest + styleContractDigest + preflightVersion
```

一次遍历检查文件/S​​heet 身份、A–F 表头、D 列、隐藏行列、公式列、合并拓扑、关键样式角色、数字格式、行列尺寸、冻结窗格、打印设置和保护 Sheet 摘要。按 Excel reference 返回 `STYLE_DRIFT`、`LAYOUT_DRIFT` 或 `STRUCTURE_DRIFT`；结构错误必须在证据处理和写表前阻塞。

普通批次统一调用：

```text
"<bundled-node>" scripts/run_reimbursement_batch.mjs --input <batch-run-plan.json>
```

计划顶层严格包含 `version + batchId + taskRoot + affectedProfiles + profiles + outputs`；`outputs.factsSnapshotPath/buildCertificatePath/auditCertificatePath/batchStatePath` 都必须是 `taskRoot` 直接子级且彼此不同。首次运行时它们必须不存在；恢复时只接受按该顺序连续存在、能与当前计划及磁盘字节完全复核的同批阶段文件。每个受影响 profile 必须提供全新的 `detailPath`（以及 `detailTitle/period`），使明细与候选由同一事实快照一次构建。父编排器固定 profile 顺序，自动处理 1/2/3 个 profile，并以不超过 2 的并发分别调用构建器和独立审计器；状态输出每个 profile 的 baseline/candidate/detail/candidatePlan/audit 新鲜哈希，供统一 Gate 使用。构建器不得覆盖基线；独立审计器不得复用构建器的费用组、预期合并或 `actualRows`。

工作簿公式缓存是独立输入边界：先确认有限数值；仅当与最近千分位差不超过 `1e-9` 时规范化浮点噪声。进入汇总立即转换为有符号定点整数。

构建器和独立审计器都必须在算出“旧受控段与新布局的最大结束行”后调用 `controlled_segment_dependency_guard.mjs`；保护 Sheet、受控段外公式、定义名称、超链接、表格、绘图或其他 OOXML 关系只要可能引用被移动行且无法证明安全，就在写候选前 fail-closed。候选和本次明细统一规范冻结窗格、A4 横向、A:F 打印区、重复表头、适应一页宽和页脚；独立审计器从落盘 OOXML 重新验证，不继承错误设置。

## 5. 有界视觉检查

- 只渲染实际数据区，不自动包含上千空白格式行。
- 每个 profile 至少覆盖首屏、末屏、最长 D/E/F 合并块、分页/布局边界和异常区。
- 超 7 行或 210pt 的合并块必须专项预览，但不自动拆分。
- 图片表生成覆盖全部实际行的紧凑联系预览；自动锚点检查覆盖全部图片实例。
- 仅发现裁切、`####`、重叠、越界、边框断裂、合并/样式异常时扩大受影响范围。
- 渲染器已有成功输出但退出码异常时，只运行一次独立只读验证器，禁止循环重建。

父批次达到 `ready-for-unified-gate-1` 且上述渲染全部落盘后，调用：

```text
"<bundled-node>" scripts/build_reimbursement_review_artifacts.mjs --input <review-artifact-request.json>
```

请求只允许 `version + batchStatePath + profiles + outputs`，每个固定顺序 profile 以 `renders` 明确列出一个或多个现有绝对路径；输出仅允许批次任务根内两个彼此不同、尚不存在的 JSON 路径。脚本从 ready state 派生 facts、候选/明细和候选审计绑定，对这些文件及每个 render 重新哈希，规范计算 `previewIndexDigest/reviewPackageDigest`，再以独占创建方式写出 preview index 和 review package。不得手写占位文本、复用旧输出，或由调用方重复声明候选/明细 SHA256。

## 6. 统一 Gate 工件

普通父批次只使用：

```text
"<bundled-node>" scripts/build_batch_gate_artifact.mjs --input <gate-request.json> --output <new-gate.json>
```

Gate 1/2 工件必须从磁盘重新哈希其绑定的父事实、profile 配置、样式契约、基线、候选、审计和预览；禁止信任调用方自报的 `verified`。工件以 `wx` 语义写入全新临时路径。

- Gate 1 绑定全部受影响 profile 的候选计划、候选 SHA256、明细 SHA256、独立明细/候选审计、review package 和 preview index。
- Gate 2 绑定全部当前基线/候选/明细 SHA256、独立终审和统一发布目标，不接受 review package。
- Gate 2 之前必须先运行 `build_reimbursement_final_audit.mjs` 生成独立 `gate-2-final-audit` 证书；Gate 2 同时绑定 Gate 1 工件三元组（路径、SHA256、`bindingDigest`）、当前预览索引和 final audit 三元组，禁止直接构造 Gate 2 绕过第一次确认。
- 工件本身不是授权；当前任务只在内存记住用户批准的两个 `bindingDigest`。
- 任一 profile、事实、基线、候选、配置、契约、审计或预览变化时，两道父 Gate 失效。

旧普通批次的 `build_gate_binding.mjs` context v1/v2 仅用于恢复；新普通批次不得再逐 profile 建立独立门禁。

## 7. 多目标发布与恢复

普通父批次只调用：

```text
"<bundled-node>" scripts/publish_reimbursement_batch.mjs --input <publish-or-recover-plan.json>
```

计划严格包含 `version: 1`、`operation: publish|recover`、`batchId`、`taskRoot`、统一 Gate 2 工件路径和已批准 `gateBindingDigest`。发布器按三目标名白名单和规范路径固定顺序锁定目标，重验 Gate 2、基线/候选 SHA256 和审计，建立一个父 journal，并保留所有旧目标恢复副本直到整批发布后审计成功。单 profile 使用同一逻辑且目标数组长度为 1。

任一替换或核验失败时反向恢复本事务已经更新的所有目标；外部改变或归属不明时不得强制回滚，保留 journal、目标、备份和锁并 fail-closed。崩溃恢复规则：全部等于候选则完成；部分发布则恢复全部基线；无法唯一判定则保留现场阻塞。只有全部目标重新打开并通过 SHA256、事实、结构、样式和保护 Sheet 审计后才算成功。

不要连续调用旧 `run_safe_publish.mjs` 冒充多目标事务。旧单表发布器、`safe_publish.ps1` 和 `publish_ledger_reorder.mjs` 只用于恢复旧普通任务或 legacy 重排；不得直接拼接 PowerShell、编辑根表或强制结束 Excel。

## 8. 图片与摘要 I/O

本批建立唯一图片注册表：

```text
sourceId → path → SHA256 → dimensions → regions → profileLinks → archiveCopies → workbookMedia → anchors
```

同一阶段每张唯一原图只读取、取尺寸和解码一次；跨 profile 共用识别结果。XLSX 实现支持时只写一个 media part，但每个业务行保留独立锚点。重开 XLSX 时一次遍历 drawing relationship/media part 建立哈希映射，不按图片实例重复解压。

摘要和最终 TXT 由同一 manifest v3 机械投影；预览返回正文和 SHA256，收到 Gate 1 后才按预期 SHA 写最终文件。不得手工维护第二套摘要事实。

## 9. 临时目录与 minimal-current-only

每批创建一个系统临时目录直接子级 `codex-xhs-reimburse-<token>`，token 至少 16 位，并在根层写：

```json
{"kind":"xiaohongshu-reimbursement-temp","version":2,"token":"<token>","inventory":[]}
```

精确文件名为 `.codex-xhs-owner.json`。先用 `manage_task_temp.mjs --input <init-request.json>` 的 `init` 操作创建空目录和空 inventory；生成本批临时内容后，用同一脚本的 `register` 操作提交**完整** inventory。`register` 请求必须显式列出每个相对路径、`file|dir` 类型以及每个文件的小写 SHA256；清单按路径排序，不包含 marker 本身。脚本只验证调用方明确给出的完整清单，不枚举后自动认领未知内容；任何漏项、错项、哈希变化或身份变化都会保留现场并失败。

```json
{"version":1,"operation":"init","token":"<16-128位安全token>"}
```

```json
{"version":1,"operation":"register","taskRoot":"<init返回的绝对路径>","token":"<同一token>","inventory":[{"path":"cache","kind":"dir"},{"path":"cache/facts.json","kind":"file","sha256":"<64位小写SHA256>"}]}
```

目录可以包含由工具创建的受控子目录（例如 `preview/`、`cache/`、`rollback/`），但必须：

- 所有路径位于已解析任务根内；
- 由 marker、任务 inventory 和预期 SHA256 证明归属；
- 拒绝任何 reparse point、Junction、符号链接、越界路径或未登记内容；
- 清理前确认无活动 journal、锁或未完成恢复。

清理前再次调用 `register` 固化最终完整 inventory，再调用 `cleanup_task_temp.mjs <task-root> <token>`。清理器逐项重算 SHA256，并要求磁盘树与 inventory 完全一致；它只允许对通过上述检查的任务根做安全递归清理。遇到未知内容、缺失内容、身份/哈希变化、链接或活动恢复状态时保留现场并报告。不得用通配符、宽泛根目录或未解析环境变量清理。version 1 没有逐文件归属证明，清理器一律拒绝；旧任务只能保留，或在人工确认每个文件后显式迁入新的 version 2 受控目录并登记完整 inventory。

新普通任务默认 `minimal-current-only`：成功后只保留正式交付物和精简发布审计；Gate、缓存、预览、journal 和回滚材料清理。失败时保留恢复现场。旧任务、重排和恢复任务继续 `legacy-history`，不得静默删除历史目录。

## 10. Legacy 重排兼容

`ledger-reorder-correction` 仍使用既有 v2 plan、`generate_ledger_reorder_plan.mjs`、`build_ledger_reorder_candidate.mjs`、`audit_ledger_reorder.mjs`、专用 Gate 工件、活动版本晋升和 `publish_ledger_reorder.mjs`。它只处理一张明确根表的零业务/金额增量范围，不加入普通多 profile 父发布。

重排 plan、候选、预览、Gate、发布和恢复的既有安全不变量保持不变；第二版不得用普通快速路径绕过它。

## 11. 回归

修改运行脚本后运行完整既有测试，并新增匿名场景：

- 单/双/三 profile 各只有一次 Gate 1 和 Gate 2；单 profile 不等待或创建其他 profile。
- 并发完成顺序不同但父 Gate 摘要确定；一个 profile 失败时门禁不开放。
- 同一证据跨 profile 只 OCR 一次；完全相同父计划的中断恢复不重复已认证的 build/audit 阶段。
- 删除 D 列、插列或目标 Sheet 歧义在证据处理前阻塞；样式/布局漂移只进入修复候选。
- D/E/F 同范围合并、锚点显示、显式行高、非锚点无 OOXML 残留；公司/驻所只做蓝色角色覆盖。
- 在每个发布点注入失败并证明全部恢复；保护 Sheet 不变。
- 新普通任务成功后不产生长期历史目录；受控子目录可安全清理。
- 使用匿名材料做单、双、三 profile 独立前向验证，不读取真实报销材料。
