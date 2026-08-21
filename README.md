# 三类报销共享归档工作流

这是面向 Codex 的 skills-only 插件。它用一条 profile 驱动的普通报销流程处理小红书、公司和驻所报销，并保留独立的历史纠错/零增量重排路径。

普通流程只为本批实际有交易的 profile 生成和发布成品；无交易 profile 不创建空文件，也不修改根表。`住所` 可作为驻所输入别名，但正式文件和 Sheet 始终使用 canonical `驻所` 身份。

## 普通流程产物

每个受影响 profile 独立生成：

- 当期报销明细；
- 报销明细对应截图表；
- 本批受控发布所用的候选总表；
- 报销文字说明和截图凭证目录；
- 仅在有补报时额外生成补报表，有独立补报凭证时额外建立补报凭证目录。发布审计只在任务临时目录生成并在发布完成后清理。

三份正式根表分别为 `小红书支出总表.xlsx`、`公司支出总表.xlsx` 和 `驻所支出.xlsx`。金额使用 BigInt milliunits 计算，按规范值显示 0 至 3 位小数，不取整也不补无意义尾零。普通报销只索引本批插入边界，不解析历史 B:F 业务内容；候选关闭后由独立进程重读真实 XLSX/OOXML 审计，发布前后均 fresh 读取并核对 SHA256。

## 版本状态与下载

| 版本 | 状态 | 说明 |
|---|---|---|
| `0.5.0+codex.20260819174146` | 用户已确认本机原版可用 | 作为当前性能对比基线。原版含私有回归样例，因此不公开原字节；GitHub 提供删除私有测试并泛化示例的 [`portable1` 脱敏便携包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260819174146-portable1)，运行脚本保持一致，并附 SHA256。 |
| `0.5.0+codex.20260820094210` | **尚未经过用户业务验收** | 首次加入四个脱敏报销工作簿模板，并区分空白模板结构与成品动态合并/行高。仅作为[模板版预发布包](https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow/releases/tag/v0.5.0-codex.20260820094210)保留，不应取代已验证基线。 |
| `0.5.0+codex.20260821073607` | 当前 hardening 候选 | 完成固定脱敏模板、候选局部增量、批次预览、可恢复双门禁、严格图片验证和 Gate 2 全量独立对应复核。完整匿名回归与性能门槛均已通过，继续保留在草稿 PR 中，不自动安装或合并。 |

`19174146.portable1` 是隐私脱敏的可迁移运行包，不宣称与含私有测试的本机原版逐字节相同。原版来源证明摘要为 `d070ae296d0606db8a03a5d50f08559eb3a42fccadec7aecbeca20b400ca16b5`，算法为按相对路径排序后，对每项 `relativePath + NUL + SHA256 + NUL + size` 形成清单再计算 SHA256。

从对应 Release 或仓库 `dist/` 下载明确命名的插件 ZIP 和 `.sha256`，不要使用 GitHub 自动生成的 “Source code” 压缩包。先核对校验和，再解压到新的本地目录，并把该解压目录作为 marketplace 根：

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

任何候选、基线、来源覆盖、预览或摘要变化都会使旧门禁失效。公司根表的未受管 Sheet 必须保持；驻所输入别名不会改变正式输出身份。

## 仓库内容

- `SKILL.md`：唯一公开工作流入口和阶段路由；
- `references/ledger-profiles.json`：三 profile 的 canonical 配置；
- `scripts/run_reimbursement_workflow.mjs`：普通报销 prepare/finalize/publish 总控；
- `scripts/`：manifest、XLSX 构建、OOXML facts、transition、业务审计和安全发布实现；
- `assets/templates/xiaohongshu/`：经 SHA256 绑定的四个脱敏工作簿模板、文字说明模板和单一 `template-manifest.json`；模板只保存静态样式，成品按本批事实生成动态合并、行高、斑马色、公式和等比图片锚点；
- `references/gate2-full-correspondence.md`：Gate 2 逐交易、逐媒体和逐工件的独立复核契约；
- `tests/`：单元、真实 XLSX、安全、恢复和性能测试。

仓库不包含真实报销截图、财务数据、账号凭证或本机财务路径。

## 当前候选验收

- 顺序完整回归：346 项，344 通过、0 失败、2 项按环境条件跳过。
- 相对 `0.5.0+codex.20260819174146` 的同机交替 7×7：冷启动 `990.062ms → 668.146ms`，提速 32.515%；热运行 `810.233ms → 550.300ms`，提速 32.081%。
- 新版计时包含 Gate 2 对 7 类工件、全部唯一源图和归档媒体的独立读取、完整解码、逐项对应审计及报告生成；不包含外部人工/模型形成第二遍视觉观察的等待时间。
- 普通总表预览只含本批投影；预览失败只重跑渲染，不重建候选、交付表或证据。
- JPEG 允许仅缺少 EOI 但仍可严格完整解码的输入；扫描数据截断、无有效 SOF、超出 25 MiB 或像素上限的媒体会被拒绝，归档始终保留原始字节和 SHA256。
