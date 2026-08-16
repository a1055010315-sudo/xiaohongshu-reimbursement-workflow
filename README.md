# 三类报销共享归档工作流

这是面向 Codex 的 skills-only 插件。它用一条 profile 驱动的普通报销流程处理小红书、公司和驻所报销，并保留独立的历史纠错/零增量重排路径。

普通流程只为本批实际有交易的 profile 生成和发布成品；无交易 profile 不创建空文件，也不修改根表。`住所` 可作为驻所输入别名，但正式文件和 Sheet 始终使用 canonical `驻所` 身份。

## 普通流程产物

每个受影响 profile 独立生成：

- 更新后的正式根表候选；
- 当期报销明细；
- 报销明细对应截图表；
- 截至结束日期的总表快照；
- 报销文字说明、截图归档和精简发布审计。

三份正式根表分别为 `小红书支出总表.xlsx`、`公司支出总表.xlsx` 和 `驻所支出.xlsx`。金额使用 BigInt milliunits 计算，工作簿统一显示三位小数。候选关闭后由独立进程重读真实 XLSX/OOXML 审计；发布前后均 fresh 读取并核对 SHA256。

## 安装

当前未合并成品以 `dist/xiaohongshu-reimbursement-workflow-0.5.0+codex.20260816-r2.zip` 为准。先核对同目录 `.sha256`，再解压到一个新的本地目录，并把该解压目录作为 marketplace 根：

```bash
codex plugin marketplace add <解压目录绝对路径> --json
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance --json
codex plugin list --json
```

OpenAI 官方文档支持将本地 marketplace 根目录传给 `codex plugin marketplace add`。安装后必须确认列表中的版本是 `0.5.0+codex.20260816`，然后新建 Codex 任务加载 Skill。当前环境只完成了隔离 marketplace/cache 安装与回滚模拟；由于 WindowsApps `codex.exe` 对自动化进程返回 Access Denied，没有声称已执行正式 CLI 安装。

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
2. 用户在新消息精确回复 `本次报销通过无误` 后，`--finalize` fresh 重读并生成 Gate 2 绑定。
3. 用户再精确回复 `确认更新根目录支出总表` 后，`--publish` 才可 exclusive 发布、复核并在批次失败时恢复。

任何候选、基线、来源覆盖、预览或摘要变化都会使旧门禁失效。公司根表的未受管 Sheet 必须保持；驻所输入别名不会改变正式输出身份。

## 仓库内容

- `SKILL.md`：唯一公开工作流入口和阶段路由；
- `references/ledger-profiles.json`：三 profile 的 canonical 配置；
- `scripts/run_reimbursement_workflow.mjs`：普通报销 prepare/finalize/publish 总控；
- `scripts/`：manifest、XLSX 构建、OOXML facts、transition、业务审计和安全发布实现；
- `assets/templates/`：已批准的明细和截图表版式模板；
- `tests/`：单元、真实 XLSX、安全、恢复和性能测试。

仓库不包含真实报销截图、财务数据、账号凭证或本机财务路径。
