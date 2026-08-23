# 三类报销与发放归档工作流

这是面向 Codex 的 skills-only 插件。它用一条 profile 驱动的普通报销流程处理小红书、公司和驻所报销，并提供一条与普通报销隔离的发放归档流程；发放归档可直接从用户明确指出的报销成品或 fresh 证据、工资最终件、发放凭证和处置决定开始。历史纠错/零增量重排仍走独立路径。

普通流程只为本批实际有交易的 profile 生成和发布成品；无交易 profile 不创建空文件，也不修改根表。`住所` 可作为驻所输入别名，但正式文件和 Sheet 始终使用 canonical `驻所` 身份。

## 普通流程产物

每个受影响 profile 独立生成：

- 当期报销明细；
- 报销明细对应截图表；
- 本批受控发布所用的候选总表；
- 报销文字说明和截图凭证目录；
- 仅在有补报时额外生成补报表，有独立补报凭证时额外建立补报凭证目录。发布审计只在任务临时目录生成并在发布完成后清理。

三份正式根表分别为 `小红书支出总表.xlsx`、`公司支出总表.xlsx` 和 `驻所支出.xlsx`。金额使用 BigInt milliunits 计算，按规范值显示 0 至 3 位小数，不取整也不补无意义尾零。普通报销只索引本批插入边界，不解析历史 B:F 业务内容；候选关闭后由独立进程重读真实 XLSX/OOXML 审计，发布前后均 fresh 读取并核对 SHA256。

## 发放归档产物

发放归档没有人工 Gate，也不复用普通报销的 Gate 1/Gate 2 状态。唯一 CLI 是 `scripts/run_compact_disbursement_workflow.mjs --archive <request.json>`，唯一 API 是 `archiveCompactDisbursementWorkflow`。请求严格只允许四个字段：`kind`、`stagingToken`、`manifestPath`、`manifestSha256`；其中 `kind` 固定为 `compact-disbursement-archive-v1`。

用户不需要准备原报销 manifest、publish receipt、工资 certificate、`sourceReview` 或其他内部 JSON。当前任务根据明确文件 fresh 复核业务语义，在内部生成并内嵌 `sourceReview`、默认 v2 manifest 和四字段 request，再用一次调用完成来源审计、候选生成、内部校验和原子归档。最终批次目录严格只有：

- `发放情况说明.txt`；
- `发放核对表.xlsx`；
- `发放凭证/`。

最终目录由 manifest 中的 `batch.archiveParentPath` 与批次名派生。v2 的 `published_archive` 可以没有原报销 manifest 和 publish receipt，`fresh_evidence` 可以没有 attestation，工资可以没有 certificate；任何可选佐证一旦提供，就必须 fresh 验证，错误、损坏或与来源事实冲突都会阻塞。发放流程只读取当前任务显式注册的文件，不移动、不覆盖原报销材料，不扫描工资目录或 sidecar，也不改动三份报销根表；普通报销入口不得导入发放模块。

图片和没有冻结工资业务 schema 的工作簿属于 review-bound。插件会严格验证文件身份、SHA、媒体完整性或 OOXML 结构，但不宣称通过 OCR 或固定单元格布局机械识别金额；当前任务必须基于明确文件完成语义复核，遇到业务歧义先询问，不能猜测。

## 已有版本记录与下载

| 版本 | 状态 | 说明 |
|---|---|---|
| `0.5.0+codex.20260819174146` | 历史已验证基线 | 原版含私有回归样例，因此不公开原字节；GitHub 提供删除私有测试并泛化示例的 [`portable1` 脱敏便携包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260819174146-portable1)，运行脚本保持一致，并附 SHA256。 |
| `0.5.0+codex.20260820094210` | 历史模板预发布包 | 首次加入四个脱敏报销工作簿模板，并区分空白模板结构与成品动态合并/行高；该[预发布包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260820094210)未经过用户业务验收。 |
| `0.5.0+codex.20260821194339` | 历史已验证版本 | 保留普通报销 Gate 1/Gate 2，并加入隔离的单次无人工 Gate 发放归档；这是既有版本记录，不再标为本仓库“当前候选”。 |
| `0.5.0+codex.20260822170308` | 本次开发基线 manifest | vNext 从此版本建立只读基线，并单独保留安装缓存中的两处普通报销修正；它不是当前发布候选。 |
| `0.5.0+codex.20260823144931` | 已验证归档修复候选 | 首次发布“取消发放核销内部 sidecar 启动依赖”的候选；保留严格 v1、普通报销 Gate 1/Gate 2 和完整安全发布链，现由下方稳定版本取代。 |
| `0.5.0+codex.20260823161923` | 当前稳定版本 | 在不夹带整体性能优化的前提下，正式提升上述归档修复候选；普通报销沿用已验证业务实现，发放归档不再要求原报销 manifest、publish receipt 或工资 certificate。成品文件名为 `xiaohongshu-finance-0.5.0+codex.20260823161923.zip`，必须与同名 `.sha256` sidecar 一起核验。 |

`19174146.portable1` 是隐私脱敏的可迁移运行包，不宣称与含私有测试的本机原版逐字节相同。原版来源证明摘要为 `d070ae296d0606db8a03a5d50f08559eb3a42fccadec7aecbeca20b400ca16b5`，算法为按相对路径排序后，对每项 `relativePath + NUL + SHA256 + NUL + size` 形成清单再计算 SHA256。

从对应 Release 或仓库 `dist/` 取得实际存在、明确命名的 marketplace ZIP 和 `.sha256`，不要使用 GitHub 自动生成的 “Source code” 压缩包。先核对校验和，再解压到新的本地目录，并把该解压目录注册为 `xiaohongshu-finance` marketplace 根。不得使用 `personal` marketplace 或旧安装缓存代替所选成品包。当前稳定版本已经按下列流程完成本地安装验证：

### 安装

```bash
codex plugin marketplace add <解压目录绝对路径> --json
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance --json
codex plugin list --json
```

安装后必须核对插件列表显示为所下载包的明确版本，再新建 Codex 任务加载 Skill。版本选择以实际 Release/ZIP、SHA256 sidecar 和包内 plugin manifest 一致为准；历史表中的“开发基线”不等于已经生成可安装的新候选。

该版本正式合并到 GitHub `main` 后，同事也可把仓库链接和明确安装要求交给 Codex：

```text
请读取并安装、配置和验证这个 Codex 插件：
https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow
```

届时 Codex 自动执行的远程安装命令为：

```bash
codex plugin marketplace add a1055010315-sudo/xiaohongshu-reimbursement-workflow --ref main --json
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance --json
codex plugin list --json
```

更新已有远程安装时，先运行 `codex plugin marketplace upgrade xiaohongshu-finance --json`，再运行 `codex plugin add ... --json` 刷新。回滚时使用先前已核验的解压包重新注册本地 marketplace、重新安装并核对版本；确认恢复成功后再移除失败版本的本地 marketplace/cache。不得用回滚操作改动报销文件或根表。

裸链接只授权读取，不授权安装。正式安装、发布或修改财务文件仍需用户明确授权。

## 使用

```text
使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 处理本批小红书、公司和驻所报销。
材料在：<材料路径或本消息附件>
支出表根目录：<根目录绝对路径>
```

普通新增只由 `scripts/run_reimbursement_workflow.mjs` 编排：

1. `--prepare` 构建所有受影响 profile 的三类工作簿、独立审计并生成 Gate 1 审阅包，根表不变。
2. 用户在新消息精确回复 `本次报销通过无误` 后，`--finalize` 独立重读全部 Gate 1 工件、原始证据和本批候选行，生成 `full-correspondence` Gate 2 报告与绑定；文件哈希一致不能替代内容复核。
3. 用户再精确回复 `确认更新根目录支出总表` 后，`--publish` 才可 exclusive 发布、复核并在批次失败时恢复。

任何候选、基线、来源覆盖、预览或摘要变化都会使旧门禁失效。公司根表的未受管 Sheet 必须保持；驻所输入别名不会改变正式输出身份。

用户明确要求整理发放记录时才进入发放归档。使用者直接给出明确业务材料和处置决定即可，例如：

```text
使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 生成本批发放归档。
已发布报销成品或 fresh 报销证据：<明确文件/附件>
工资最终件：<明确工作簿或图片；没有则写无>
发放凭证：<明确文件/附件>
逐行处置决定与归档父目录：<明确说明>
```

当前任务会 fresh 复核这些明确文件；业务事实或对应关系不清楚时先询问，不猜测。随后由任务内部生成 `sourceReview`、默认 `disbursement-archive-manifest-v2`、manifest SHA256 和 request，再只执行一次：

```bash
node scripts/run_compact_disbursement_workflow.mjs --archive <request.json>
```

`request.json` 是任务内部运行输入，不是用户手动准备步骤。它必须严格为以下四字段结构，不接受批准口令、Gate、`statePath`、binding 或其他旧字段：

```json
{
  "kind": "compact-disbursement-archive-v1",
  "stagingToken": "<本次暂存令牌>",
  "manifestPath": "<manifest 绝对路径>",
  "manifestSha256": "<manifest SHA256>"
}
```

外层 archive request 的 kind 继续是 `compact-disbursement-archive-v1`，这与内部默认 v2 manifest 不冲突。旧的 `disbursement-archive-manifest-v1` 仅严格兼容一个发布周期，并返回 `DISBURSEMENT_MANIFEST_V1_DEPRECATED` warning；warning 不新增 Gate 或确认口令。

## 仓库内容

- `SKILL.md`：唯一公开工作流入口和阶段路由；
- `references/ledger-profiles.json`：三 profile 的 canonical 配置；
- `scripts/run_reimbursement_workflow.mjs`：普通报销 prepare/finalize/publish 总控；
- `scripts/run_compact_disbursement_workflow.mjs`：发放归档的唯一 `--archive` CLI；
- `scripts/disbursement_*.mjs`：发放 manifest、领域规则、候选生成、审计和原子归档实现；
- `scripts/`：manifest、XLSX 构建、OOXML facts、transition、业务审计和安全发布实现；
- `assets/templates/xiaohongshu/`：经 SHA256 绑定的四个脱敏工作簿模板、文字说明模板和单一 `template-manifest.json`；模板只保存静态样式，成品按本批事实生成动态合并、行高、斑马色、公式和等比图片锚点；
- `assets/templates/disbursement/`：发放说明与核对表模板及其样式契约；
- `references/compact-disbursement.md`：严格四字段、无人工 Gate 的发放归档契约；
- `references/gate2-full-correspondence.md`：Gate 2 逐交易、逐媒体和逐工件的独立复核契约；
- `tests/`：普通报销与发放归档的单元、真实 XLSX、安全、恢复、隔离和性能测试。

仓库不包含真实报销截图、财务数据、账号凭证或本机财务路径。

## 当前实现边界

- 普通报销继续使用 Gate 1/Gate 2；发放归档是一次调用完成的独立无人工 Gate 流程。两者不共享状态、来源扫描或发布入口。
- 发放仍保留两次来源审计、候选/stage/final 完整审计、TOCTOU 核对、fsync、原子发布、恢复保护、最终三项复核和 allowlist 清理；入口迁移不减少安全链。
- 本期只更新发放业务材料入口、review-bound 信任边界和 v1 一周期迁移说明，没有实施整体性能优化、运行新性能评估或生成新的性能结论。20% 仍只是默认信息性改善目标，不是通过硬门。
- 普通总表预览只含本批投影；预览失败只重跑渲染，不重建候选、交付表或证据。
- JPEG 允许仅缺少 EOI 但仍可严格完整解码的输入；扫描数据截断、无有效 SOF、超出 25 MiB 或像素上限的媒体会被拒绝，归档始终保留原始字节和 SHA256。发放 PDF 还会逐页解析内容流，并拒绝加密、损坏、超限或无法完整解析的文件。
