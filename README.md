# 三类报销与发放归档工作流

这是面向 Codex 的 skills-only 插件。它用一条 profile 驱动的普通报销流程处理小红书、公司和驻所报销，并提供一条与普通报销隔离的发放归档流程；历史纠错/零增量重排仍走独立路径。

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

一次调用依次完成来源 fresh 复核、候选生成、内部校验和原子归档。最终批次目录严格只有：

- `发放情况说明.txt`；
- `发放核对表.xlsx`；
- `发放凭证/`。

最终目录由 manifest 中的 `batch.archiveParentPath` 与批次名派生。报销来源只通过 `reimbursementSources[].originalManifestPath` 和 `publishReceiptPath` 绑定；发放流程不移动、不覆盖原报销材料，也不扫描工资目录或改动三份报销根表，普通报销入口则不得导入发放模块。

## 版本状态与下载

| 版本 | 状态 | 说明 |
|---|---|---|
| `0.5.0+codex.20260819174146` | 用户已确认本机原版可用 | 作为当前性能对比基线。原版含私有回归样例，因此不公开原字节；GitHub 提供删除私有测试并泛化示例的 [`portable1` 脱敏便携包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260819174146-portable1)，运行脚本保持一致，并附 SHA256。 |
| `0.5.0+codex.20260820094210` | **尚未经过用户业务验收** | 首次加入四个脱敏报销工作簿模板，并区分空白模板结构与成品动态合并/行高。仅作为[模板版预发布包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260820094210)保留，不应取代已验证基线。 |
| `0.5.0+codex.20260821194339` | 上一已验证版本 | 普通报销保留可恢复 Gate 1/Gate 2、严格图片验证和 Gate 2 全量对应复核；新增隔离的单次无人工 Gate 发放归档。全量回归、独立前向测试、打包及安装态复核均已通过。 |
| `0.5.0+codex.20260824072912` | 当前发布候选 | Gate 2 可在原材料与正式基线未变时纠正金额、项目、笔数、主体、日期、漏项、重复项及绑定工件错误，不重新索取 Gate 1；reviewer 单方误判只修订 review。580 项完整回归中 574 通过、0 失败、6 条件跳过，正式 fake 11+2 性能硬门通过。 |

`19174146.portable1` 是隐私脱敏的可迁移运行包，不宣称与含私有测试的本机原版逐字节相同。原版来源证明摘要为 `d070ae296d0606db8a03a5d50f08559eb3a42fccadec7aecbeca20b400ca16b5`，算法为按相对路径排序后，对每项 `relativePath + NUL + SHA256 + NUL + size` 形成清单再计算 SHA256。

从对应 Release 或仓库 `dist/` 下载明确命名的 marketplace ZIP 和 `.sha256`，不要使用 GitHub 自动生成的 “Source code” 压缩包。先核对校验和，再解压到新的本地目录，并把该解压目录注册为 `xiaohongshu-finance` marketplace 根。不得使用 `personal` marketplace 或其旧安装缓存代替当前候选：

### 安装

```bash
codex plugin marketplace add <解压目录绝对路径> --json
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance --json
codex plugin list --json
```

安装后必须核对插件列表显示为所下载包的明确版本，再新建 Codex 任务加载 Skill。`20094210` 是未测试模板版，除非专门回归模板行为，否则优先使用已确认基线的脱敏便携包。

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

原材料集合/路径/类型/SHA 或正式基线变化会使旧 Gate 1 失效；同材料、同基线内由 Gate 2 确认的业务事实或派生工件错误在 Gate 2 correction 中修复，不再次索取人工 Gate 1。公司根表的未受管 Sheet 必须保持；驻所输入别名不会改变正式输出身份。

用户明确要求整理发放记录时才进入发放归档。准备好经过来源绑定的 manifest 后，只执行一次：

```bash
node scripts/run_compact_disbursement_workflow.mjs --archive <request.json>
```

`request.json` 必须严格为以下四字段结构，不接受批准口令、Gate、`statePath`、binding 或其他旧字段：

```json
{
  "kind": "compact-disbursement-archive-v1",
  "stagingToken": "<本次暂存令牌>",
  "manifestPath": "<manifest 绝对路径>",
  "manifestSha256": "<manifest SHA256>"
}
```

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

## 当前候选验证与性能口径

- 普通报销继续使用 Gate 1/Gate 2；发放归档是一次调用完成的独立无人工 Gate 流程。两者不共享状态、来源扫描或发布入口。
- 20% 只作为信息性改善目标。保留已证明有效且安全的优化；不为跨过 20% 叠加未证明收益的复杂度。普通 O 线锁定本轮修改前、与候选输出契约等价的已安装版本，并在运行前后复验双方 version、skill tree 和 package tree digest；硬门是输出完全等价、普通成功路径冷/热 p50 与 p95 均不得退化超过 5%、各轮采样峰值 RSS 的 p95 增幅不超过 15%，并保持所有 renderer 的普通流程预览 PNG 唯一性。任一项失败都禁止打包、安装或发布。
- H 线正式对比（只读旧安装缓存与未修改目标版）记录的冷、热改善分别为 `34.159%`、`34.148%`。
- O 线 r12 信息性诊断（未修改目标版与当前普通报销优化版）记录的冷、热 p50 改善分别为 `18.311%`、`23.142%`；冷启动未达到 20%，如实保留为信息性结果，不写成“20% 门槛通过”。该次诊断输出等价、PNG 唯一性及 RSS 条件通过。
- 当前 `0.5.0+codex.20260824072912` 相对锁定安装基线 `0.5.0+codex.20260823170757` 的正式 fake 11+2：冷 p50/p95 分别退化 `3.163%/1.165%`，热 p50/p95 分别改善 `3.200%/6.298%`；输出完全等价，冷/热峰值 RSS 分别改善 `2.816%/0.617%`，所有预览 PNG 唯一性通过。
- 新版普通报销计时包含 Gate 2 对 7 类工件、全部唯一源图和归档媒体的独立读取、完整解码、逐项对应审计及报告生成；不包含外部人工/模型形成第二遍视觉观察的等待时间。
- 普通总表预览只含本批投影；预览失败只重跑渲染，不重建候选、交付表或证据。
- JPEG 允许仅缺少 EOI 但仍可严格完整解码的输入；扫描数据截断、无有效 SOF、超出 25 MiB 或像素上限的媒体会被拒绝，归档始终保留原始字节和 SHA256。发放 PDF 还会逐页解析内容流，并拒绝加密、损坏、超限或无法完整解析的文件。
