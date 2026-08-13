# 运行可靠性约定

本页只约束执行方式，不改变父级业务口径、产物边界或两道门禁。同一任务中完整读取一次；只有本页在磁盘上变化时才重读。

## 1. 隔离阶段与最少重复 I/O

将工作簿工作固定为三个隔离阶段；关键边界是构建关闭后必须从持久化字节独立重开验证，而不是机械追求某个操作系统进程数量。每个阶段内部必须批量处理，不能按 Sheet、图片、检查项或单个工作簿反复启动：

1. **构建/导出进程**：一次导入基线，批量生成本阶段全部工作簿；预先计算单元格、合并、行列尺寸和图片锚点，最后各保存一次。
2. **语义验证进程**：每个输出工作簿只重新打开一次；在同一遍遍历中完成记录多重集合、金额、日期、公式、合并、锚点、图片映射和代表性样式检查。
3. **视觉验证进程**：一次打开工作簿并批量渲染全部有界实际数据区或紧凑联系预览；只在异常时扩大受影响范围。

这种三阶段隔离用于避免成功导出被渲染器异常误判；阶段内部批处理用于避免昂贵的重复启动、导入、解压和 ZIP 保存。

全部异步操作显式 `await`。每个进程只向终端输出一条紧凑 JSON；大段表格、样式对象、NDJSON、预览和 sidecar 只放任务临时目录。真实异常返回非零，成功时显式设置 `process.exitCode = 0`。

## 2. 有界渲染

- 渲染实际数据区，不自动裁剪上千空白格式行。
- 截图对应表以 Sheet 为单位生成覆盖全部实际行的紧凑联系预览；“两个 Sheet”不等于两张打印页或两页 PDF。
- 首行、中间行、末行、最大图片数行和布局变化边界必须可见；自动锚点/边界检查覆盖全部图片实例。
- 只有发现裁切、重叠、越界、字体或格式异常时，才全尺寸渲染受影响区块。
- 渲染进程已输出成功 JSON 且预览存在、但退出码非零时，只运行一次独立只读验证器；语义和预览都通过则记录为“渲染器退出状态异常”，禁止循环重建。

## 3. Manifest 与验收证书

在系统临时目录的本批专用目录中维护 `batch-manifest.json`。它只保存规范化业务事实和文件依赖；验收证书另存为临时 sidecar，不能写回 manifest 形成摘要自引用。`audit_batch_manifest.mjs` 必须继续只读兼容既有 `version: 1`；新建或因本规则重建的批次使用 `version: 2` 和 `rulesVersion: "xhs-reimbursement-fast-path-v3"`。

新增报销批次使用以下核心结构。`settlement` 与 `category` 是两个独立维度；不得再用类目名称推断是否实报：

```json
{
  "version": 2,
  "rulesVersion": "xhs-reimbursement-fast-path-v3",
  "batch": {
    "batchId": "XHS-2026-08-anonymous-001",
    "rootPath": "绝对路径",
    "archivePath": "绝对路径",
    "period": "完整时间段",
    "targetCategory": "小红书报销",
    "reviewRevision": 1
  },
  "operation": {"mode": "reimbursement-batch"},
  "files": [
    {"id": "baseline", "role": "baseline", "path": "绝对路径", "sha256": "64位小写十六进制"},
    {"id": "WX-I01", "role": "material", "kind": "image", "disposition": "used", "path": "绝对路径", "sha256": "64位小写十六进制"}
  ],
  "transactions": [
    {
      "id": "TX-001",
      "sourceOrder": 1,
      "date": "2026-08-01",
      "person": "正式姓名",
      "project": "项目",
      "label": "正式姓名或汇总标签",
      "amount": "70",
      "category": "小红书报销",
      "settlement": "employee_reimbursement",
      "evidence": ["WX-I01"]
    }
  ],
  "expectedFeeTotal": "70",
  "expectedRealTotal": "70",
  "expectedCategoryTotals": {"小红书报销": "70"}
}
```

`settlement` 只允许 `employee_reimbursement` 或 `company_paid_no_reimbursement`。负数只允许作为可追溯退款或调整：必须有稳定交易 ID，并提供 `adjustment.type`、同输入中的正金额 `sourceTransactionId` 和非空 `reason`；退款累计绝对值不得超过来源交易金额，且来源类目和结算方式必须相同。业务输入仍只接受最多三位小数的严格十进制字符串，禁止负零和静默舍入。

零增量重排使用 `operation.mode: "ledger-reorder-correction"`，且不得包含新增报销交易或报销合计。它至少绑定：

```json
{
  "version": 2,
  "operation": {
    "mode": "ledger-reorder-correction",
    "candidateRevision": 2,
    "supersedes": "candidate-v1",
    "planFileSha256": "<64位小写SHA256>",
    "correctionPolicy": {
      "sheetName": "支出总表",
      "physicalRange": "A2:F120",
      "scopeStart": "2026-06-01",
      "scopeStartInclusive": true,
      "scopeEnd": "2026-08-31",
      "scopeEndInclusive": true,
      "sortKeys": ["date:asc", "baselineOrder:asc"],
      "stableTieBreaker": "baselineOrder",
      "blankRowsPolicy": "preserve-physical"
    },
    "expectedRecordCount": 80,
    "expectedPhysicalRecordRowCount": 119,
    "expectedScopedRecordCount": 30,
    "expectedScopedRowCount": 42,
    "expectedScopedAmount": "12345.67",
    "expectedAmountDelta": "0"
  }
}
```

修正 manifest 的 `files` 必须恰有一个 `baseline` 和一个 `current: true` 当前候选。`candidateRevision: 1` 必须使用 `supersedes: null`，且只能有这一个候选；后续 revision 必须用 `supersedes` 指向一个 `current: false` 旧候选。所有路径、SHA256、plan 摘要和文件字节都必须实校验。活动归档版本唯一性由第 7 节工具另行机械验收，不能只相信 manifest 声明。

文件角色可使用 `material`、`archive-copy`、`detail`、`correspondence`、`candidate`、`summary-input`、`summary-output` 等稳定值。manifest 不得出现 `gate`、`approval`、`authorized` 或任何门禁/用户授权字段。

v2 的 `batchId` 必须是稳定非空批次标识；移动归档或递增展示修订号不得生成新批次。每笔 v2/v3 报销交易的 `sourceOrder` 必须是唯一正安全整数，一经分配不得因展示排序重排。新任务使用 v3，并为每笔交易保存非空 `classification`、`sourceRefs`；每个 `sourceScope` 保存材料文件、可复现 `locator`、`terminalConfirmed: true` 和正整数 `expectedUnitCount`，每个 `sourceUnit` 保存范围内定位及唯一采用/排除处置，登记数必须与确认数相等；v1/v2 只读兼容。`reviewRevision` 必须是大于零的安全整数。`material` 文件必须标记 `kind`（`image`、`text` 或 `attachment`）和 `disposition`（`used` 或 `excluded`）；排除项还要写 `reason`。无图片交易用 `missingEvidenceConfirmed: true`，它可以保留文字证据引用，但不能同时引用图片。交易日期必须是合法日历日期的 `YYYY-MM-DD`，不能只验证字符串形状。用 `"<bundled-node>" scripts/audit_batch_manifest.mjs <manifest.json>` 验证 Decimal 金额、日期、结算方式、类目合计、调整关系、操作配置、引用完整性、来源覆盖和磁盘文件哈希，并取得 `factsDigest`、`evidenceDigest`、`sourceCoverageDigest`、`operationDigest`、`configDigest`、文件摘要和交易摘要。`factsDigest` 不得包含 `reviewRevision`、`archivePath`、候选或证据展示状态；`evidenceDigest` 只绑定实际采用材料指纹和交易—证据关系；`sourceCoverageDigest` 绑定来源范围、末端确认、预期数量、来源单元定位及采用/排除处置。

```text
rulesVersion + 按产物选择的factsDigest/evidenceDigest + operationDigest + configDigest + 实际依赖文件SHA256 + 验收器版本
```

同一缓存键已经通过时直接复用，不重新导入或渲染。依赖变化时只使其下游证书失效；两道门禁本身从不写入或复用。第一门后仍独立重算金额；第二门后仍重新读取根表、明细和候选；发布后仍重新打开目标。

普通新增或历史业务修正批次在每次收到门禁精确文本时，用临时 JSON 上下文调用 `"<bundled-node>" scripts/build_gate_binding.mjs --input <gate-context.json>`，不要手工串接字段。新任务使用 Gate context v2：两道门都绑定 `candidatePlanSha256` 和 `sourceCoverageDigest`；第一门另绑定 `mode`、`batchId`、`factsDigest`、`operationDigest`、`candidateRevision`、候选绝对路径/SHA256 和 `reviewPackageDigest`，第二门另绑定同一操作/候选字段、基线绝对路径/SHA256 和 `finalAuditDigest`。旧 context v1 只用于恢复已开始批次。

历史业务修正候选还要按以下顺序执行，两个输出都用全新路径和 `wx` 语义写入：

```text
"<bundled-node>" scripts/derive_ledger_layout.mjs --input <records.json> --out <new-layout.json>
"<bundled-node>" scripts/audit_ledger_layout.mjs --input <independently-extracted-audit-package.json> --baseline <baseline.xlsx> --candidate <candidate.xlsx>
```

第二个输入必须从候选实际工作簿重新提取，禁止复制第一个脚本的费用组、公式或合并结果。

重排修正不用调用方提供 `reviewPackageDigest`/`finalAuditDigest`，而是在等待对应门禁前调用专用脚本机械生成工件：

```text
"<bundled-node>" scripts/build_ledger_reorder_gate_artifact.mjs --gate gate-1 --plan <plan.json> --batch-id <batchId> --operation-digest <operationDigest> --facts-digest <factsDigest> --preview-index <new-preview-index.json> --out <new-gate-1.json>
"<bundled-node>" scripts/build_ledger_reorder_gate_artifact.mjs --gate gate-2 --plan <plan.json> --batch-id <batchId> --operation-digest <operationDigest> --out <new-gate-2.json>
```

Gate 1 的 `--preview-index` 是必须不存在的新输出路径，不是输入。Gate 1 脚本在同一调用中先重审活动候选，再直接从其稳定快照按不重叠连续区段渲染 plan 的完整 `physicalRange`，以 `wx + fsync` 写图片和严格 v2 索引，最后生成 Gate 工件；索引绑定 `planFileSha256`、活动候选规范路径/SHA256、每段 Sheet/range 和图片 SHA256。禁止手写索引、传外部 PNG、复用 standalone generator 产物或另一修订的旧预览。Gate 2 再从磁盘执行全量终审；发布器在任何恢复/发布动作前还要 fresh-rerender 当前候选并逐段比对 Sheet/range/PNG SHA256，防止手写 Gate 工件绕过来源绑定。两道工件都绑定 `planFileSha256`、候选路径/修订号/SHA256 和规范化审计负载，使用 `wx` 写入全新临时工件。工件本身不是授权；用户接受的 `bindingDigest` 仍只存在当前任务内，不能写入 manifest、归档或其他长期状态。

## 4. 图片 I/O

本批建立唯一图片注册表：

```text
sourceId → sourcePath → SHA256 → width/height → archiveCopies[] → workbookImageId → anchors[]
```

- 同一阶段、同一工作簿字节版本内，每张唯一原图只读取、取尺寸和解码一次；独立重开验证仍可读取已打包媒体。
- 实现支持时，同一原图在 XLSX 中只写入一个 OOXML media part，但每个业务行保留独立锚点。
- 重开 XLSX 时一次遍历 drawing relationship 和 media part，建立 SHA256 映射后核对全部锚点，不按图片实例重复解压整份工作簿。
- 每个实体归档副本仍逐个与来源哈希比较；不得用硬链接代替跨类目原图副本。
- 对话展示和工作簿嵌入共用本地原图；只有定位困难才生成一次临时裁剪或标注图。

## 5. Windows 与发布

开始批次时检查 Windows PowerShell 5.1+，并通过工作区依赖加载器取得捆绑 Node.js 的绝对路径；运行本 skill 的 `.mjs` 时使用该路径，不依赖系统 `PATH` 中碰巧存在的 `node`。缺少发布环境时仍可制作归档和候选，但必须在第二道门禁后的发布前停止。

Windows PowerShell 5.1 可能错误解析无 BOM UTF-8 `.ps1` 中的中文路径字面量。脚本源保持 ASCII，中文路径只通过参数传入。工作流不得自行拼接或直接运行 PowerShell；统一调用固定启动器：

```text
"<bundled-node>" scripts/run_safe_publish.mjs --baseline-path <path> --candidate-path <path> --target-path <path> --expected-baseline-sha256 <hash> --expected-candidate-sha256 <hash>
```

启动器固定以 `shell: false` 调用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/safe_publish.ps1`。只有子进程退出码为 0、stderr 严格为空、stdout 恰为一行合法 JSON、`ok: true`、状态属于 `created/replaced/already_current`，且返回 SHA256 与候选绑定值完全一致时才算发布成功；任何策略异常、输出噪声或字段不符都返回单行 `runner_failed` JSON 和非零退出码。内部 `recoverSafePublish(options)` 只供绑定发布包装器先执行 `-RecoveryOnly`：没有匹配事务时返回 `no_recovery` 且绝不发布；有匹配的 stale owner/journal 时才恢复或完成同一事务。普通 workflow 不直接调用该内部接口。

`safe_publish.ps1` 使用 target-scoped mutex、完整 fsync 后原子安装的 owner/PID/start-time lock、不可变 armed write-ahead journal、事务专用 temp/backup、回滚、临界窗口哈希和发布后核验。进程在 create/replace 后崩溃时，同参数恢复入口根据目标/temp/backup 哈希续跑或收尾；任何元数据、目标或备份无法证明归属时保留现场并 fail-closed。状态为 `published_cleanup_failed` 时先按返回哈希核验目标，再处理返回的精确 lock/journal/backup 路径，禁止盲目重发。

## 6. 汇总文字说明

v2 直接由脚本审计并机械投影 `batch-manifest.json`；`--input` 机械投影只用于兼容既有 v1 批次，不得手工新增、删除或改写业务记录。预览和最终文件必须由同一脚本、同一输入生成：

```text
"<bundled-node>" scripts/build_reimbursement_summary.mjs --manifest <batch-manifest.json> --preview
"<bundled-node>" scripts/build_reimbursement_summary.mjs --manifest <batch-manifest.json> --output <new-output.txt> --expect-sha256 <预览textSha256>
```

预览返回 `summary` 正文及 `textSha256`；最终写入必须显式传入该哈希，写后重新读取并逐字节核对，再返回同一 `textSha256`。第一道门禁后才写最终 TXT。业务金额输入只接受最多三位小数的严格十进制字符串；负数必须满足第 3 节的退款/调整关系。

工作簿公式缓存是另一条输入边界。读取 XLSX 公式缓存时，先确认值是有限数字；仅当它与最近千分位的差值小于等于 `1e-9` 时，才允许规范化到该千分位，例如 `1004.5799999999999 → 1004.58`。超过容差的真实四位及以上精度仍必须阻塞，不能借公式缓存规则静默舍入。进入业务汇总后立即转换为有符号定点整数，禁止继续用二进制浮点累计。

## 7. 重排、活动版本与验收器

`ledger-reorder-correction` 只允许人工建立严格 request；完整 v2 plan 必须由基线只读预检机械生成，不能手填、复制旧 plan 或事后改写。request 必须包含全部字段：

```json
{
  "version": 1,
  "mode": "ledger-reorder-plan-request",
  "rootPath": "<已绑定根目录绝对路径>",
  "stagingRoot": "<系统临时目录直接子级 codex-xhs-reimburse-token>",
  "stagingToken": "<至少16位token>",
  "sourcePath": "<根目录内基线.xlsx>",
  "outputPath": "<stagingRoot直接子级_修正版N.xlsx>",
  "activeCandidatePath": "<根目录内活动归档_修正版N.xlsx>",
  "targetPath": "<rootPath/小红书支出总表.xlsx>",
  "candidateRevision": 2,
  "sheetName": "支出总表",
  "physicalRange": "A2:F120",
  "scopeStart": "2026-06-01",
  "scopeStartInclusive": true,
  "scopeEnd": "2026-08-31",
  "scopeEndInclusive": true,
  "dateColumn": "A",
  "amountColumn": "C",
  "recordDetection": "merge-connected-components"
}
```

`stagingRoot` 必须有匹配 token 的 `.codex-xhs-owner.json`。生成器把横向或竖向合并连通的连续行识别为 `contiguous-row-block` 逻辑记录，机械写入源路径/SHA256、plan 路径/SHA256、候选三种路径、工作表/物理范围、日期边界、`date:asc + baselineOrder:asc`、`preserve-physical`、每个记录块、业务列、日期/金额列、逻辑记录数、物理记录行数、范围金额和 `expectedAmountDelta: "0"`。不得依赖“看起来已经排序”或工作表当前物理格式。

```text
"<bundled-node>" scripts/generate_ledger_reorder_plan.mjs --request <request.json> --out <new-plan.json>
"<bundled-node>" scripts/build_ledger_reorder_candidate.mjs --plan <plan.json>
"<bundled-node>" scripts/audit_ledger_reorder.mjs --plan <plan.json> --candidate <candidate.xlsx>
```

构建器只能写 plan 绑定的全新暂存候选，不能覆盖基线或既有候选。顺序固定为：构建 → 独立审计暂存字节 → 晋升活动版本 → Gate 1 同调用对活动路径再审计并渲染完整重排区 → 写预览索引与 Gate 1 工件 → 展示。审计同时比较源/候选读前读后 SHA256，检测外部并发变化；还必须验范围内外单元格、公式缓存/依赖、逐格样式、行高、列宽、合并子格、工作表结构和受保护 OOXML parts。公式解析覆盖 Unicode 工作表名、整行/整列、定义名称及传递依赖，并扫描其他工作表条件格式/数据验证与 chart/table/pivot 等 OOXML part 的非单元格公式；外部/3D、动态引用、未解析引用和范围外记录依赖一律阻塞，聚合豁免只接受纯 A1 引用列表，R1C1 工作簿不得交给 A1 审计器。OOXML row/cell 缺显式坐标、可移动单元格/公式的未知语义属性、范围外语义属性变化、calcChain、移动行关联的 hyperlink、跨表指向移动行的 hyperlink、pivot/table/control/extension 元数据、无法保持消费者→relationship target 语义的结构也返回 `unsupported`。禁止降级为只移动值。

活动归档每个 `artifactKind` 恰好一个当前版本；旧版移动到同级可恢复历史目录，不能删除。promotion plan 的 `artifactKind` 是该交付物不含扩展名、也不含 `_修正版N` 的精确基础文件名，不是宽泛枚举；候选扩展名同时绑定文件族。活动集合只识别 `<artifactKind>.<ext>` 和 `<artifactKind>_修正版N.<ext>`，近似但畸形的修正版名必须 fail-closed。使用：

```text
"<bundled-node>" scripts/promote_active_revision.mjs --plan <promotion.json>
"<bundled-node>" scripts/audit_active_revisions.mjs --plan <promotion.json>
```

晋升必须绑定候选 SHA256、修订号和预期旧当前版本；任何哈希、重复当前版本、历史冲突或移动失败都回滚并阻塞 R2。Windows 上按 `archivePath + artifactKind + extension` 派生的 Local named Mutex 覆盖晋升、恢复和活动版本审计全程；独立 PowerShell helper 经 stdin 生命周期持锁，父进程被杀后自动释放，获取超时或 helper 异常必须在写前 fail-close。磁盘 v4 owner/PID/start-identity lock、v2 recovery guard 和事务 marker 仍作为崩溃日志与第二道防线，均以私有 staging、fsync 和原子安装写入；崩溃后同一计划重试恢复。`audit_active_revisions.mjs` 发现该文件族遗留 lock/recovery/marker 时必须阻塞并要求先用同一 promotion plan 恢复。检测到外部并发替换或无法证明归属时保留旧版快照、锁和恢复日志，不得删除现场、用修改时间猜当前版本或留下两个活动版本。

重排修正发布不得绕过 plan 重新传自由路径；只调用：

```text
"<bundled-node>" scripts/publish_ledger_reorder.mjs --plan <plan.json> --expected-plan-sha256 <planFileSha256> --expected-baseline-sha256 <当前重读hash> --expected-candidate-sha256 <当前活动候选hash> --expected-batch-id <batchId> --expected-operation-digest <operationDigest> --gate-1-artifact <gate-1.json> --expected-gate-1-binding-digest <当前任务已批准摘要> --gate-2-artifact <gate-2.json> --expected-gate-2-binding-digest <当前任务已批准摘要>
```

该包装器只接受 v2 plan；重新加载并验证两份 Gate 工件，逐项比对当前任务批准摘要、batch/operation/plan/candidate/baseline，复核预览文件仍为批准字节，并再次执行全量审计后才把 plan 绑定的三条路径交给通用发布器。通用 `run_safe_publish.mjs` 仅用于普通新增报销分支。发布失败时保留并报告 journal、`rollback_error`、`preserved_backup`、`preserved_target` 和 `cleanup_errors`；不得在目标被外部改变后强行回滚或删除现场。

## 8. 临时目录与清理

每批生成至少 16 位随机 token，只创建一个系统临时目录直接子级 `codex-xhs-reimburse-<token>`，并写入：

```json
{"kind":"xiaohongshu-reimbursement-temp","version":1,"token":"<token>"}
```

上述 JSON 必须保存为精确文件名 `.codex-xhs-owner.json`。目录保持扁平，只允许普通文件及明确的 Junction/符号链接；连“旧版”“日志”也使用带前缀的扁平文件名，不创建普通子目录，不放清理脚本。工作期间依据 manifest 访问精确文件，禁止反复全目录扫描。工作簿检查器自动产生的 `.inspect.ndjson` 等 sidecar 必须定向到任务临时目录；若工具仍在交付目录产生，则只删除本任务刚创建且已核实归属的精确 sidecar，不能用通配符清理。

结束时从 skill 目录调用 `"<bundled-node>" scripts/cleanup_task_temp.mjs <temp-dir> <token>`。清理器必须保留 marker、路径、目录身份和内容的双重预检；目标已不存在视为幂等成功。遇到普通子目录、越界路径、身份变化或 token 不匹配时保留现场并报告，禁止宽泛递归删除。

## 9. Skill 脚本维护回归

只有修改本 skill 的运行脚本后才运行 `"<bundled-node>" --test tests/runtime-scripts.test.mjs tests/manifest-v2.test.mjs tests/manifest-v3.test.mjs tests/ledger-layout.test.mjs tests/publish-runner.test.mjs tests/publish-crash-recovery.test.mjs tests/revision-promotion.test.mjs tests/gate-binding.test.mjs tests/gate-artifact.test.mjs tests/ledger-reorder.test.mjs`；普通报销批次不重复运行。测试必须只在 `os.tmpdir()` 的随机直接子目录创建匿名材料和工作簿，并在完成后清理该精确目录。历史业务修正测试必须覆盖来源唯一处置、同日同人不同分类拆组、跨日同人同分类同类型合组、不同 settlement 拆组、D/E/F 同步合并、`sourceOrder` 稳定、整数/两位/三位格式及未授权补丁拒绝。重排 forward-test 必须真实执行 v2 plan 生成、连续多行/竖向合并搬运、预览、活动版本晋升及审计、两份 Gate 工件、拒绝错误门禁摘要、受控发布；不得用 `copyFile` 冒充晋升，也不得读取真实报销材料。
