# 小红书、公司与驻所报销工作流

这是一个面向 Codex 的 skills-only 插件。它用一个总控 skill 处理小红书、公司和驻所报销：一次收集材料，只构建实际涉及的 1–3 个账本 profile，并行完成明细、证据对应表、候选总表和独立审计，再通过两道统一确认协调发布。

仓库只包含插件说明、skill、内部 references、确定性脚本和测试，不包含报销截图、财务数据、账号凭证或本机路径。

## 主要能力

- 一个类目时自动走单 profile，不等待也不创建另外两个类目。
- 两个或三个类目时并行取证、构建和审计；全部 ready 后只展示一次统一 Gate 1，终审后只展示一次统一 Gate 2。
- 三个固定 profile：`xiaohongshu`、`company`、`residence`；公司和驻所支出表继承小红书语义版式，允许显式蓝色主题覆盖。
- 允许 D/E/F 按完整费用组纵向合并，并检查同范围、公式、居中、换行、金额精度及合并子单元格 OOXML 残留。
- 工作簿预检会拦截缺列、错表头、未知插列、隐藏业务行、目标 Sheet 改名和未授权跨行依赖；公司辅助页以及驻所收入、工资页保持受保护。
- 统一 Gate 绑定事实、来源覆盖、候选、明细、审计、预览和版式契约；任一输入变化都会使旧确认失效。
- 多账本发布采用同目录原子替换、事务日志、全批回滚和发布后独立重开审计。
- 未变化的本地证据和 OCR 可按 SHA256 复用；安全门禁仍会重新读取当前工作簿和候选。
- 新任务默认最小留档，只保留当前正式交付物、凭证、总表快照和精简发布审计；临时目录按显式 inventory 清理。

## 给同事：只需把链接交给 Codex

同事不需要手动复制安装命令。在 Codex 桌面端或 Codex CLI 中发送：

```text
请读取下面的 GitHub 项目，并自动为我安装、配置和验证这个 Codex 插件；除非权限或当前产品不支持，否则不要让我手动执行安装命令：
https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow
```

仅发送裸链接只授权读取，不足以授权安装；需要明确写“请安装并配置”。

## Codex 自动执行的安装步骤

```bash
codex plugin marketplace add a1055010315-sudo/xiaohongshu-reimbursement-workflow --ref main
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance
```

安装或更新后请新建一个 Codex 任务，使新版 skill 被重新加载。

## 一次调用

单类目示例：

```text
使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 处理这次小红书报销。
材料在：<材料路径或本消息附件>
财务台账根目录：<绝对路径>
```

多类目示例：

```text
使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 同时处理这次小红书、公司和驻所报销。
一次收集全部材料，并行整理到统一门禁，不要按类目逐个等待确认。
财务台账根目录：<绝对路径>
```

## 两道统一确认门禁

无论实际涉及一个还是三个 profile，每个父批次都只接受两次确认：

1. Codex 完成所有受影响 profile 的明细、截图关系、候选、独立审计和预览；根表不变。
2. 完整核对后单独回复：`本次报销通过无误`
3. Codex 并行完成独立终审，生成统一 Gate 2 并报告候选与 SHA256。
4. 确认终审结果后单独回复：`确认更新根目录支出总表`
5. Codex 重新核验全部根表、候选与门禁，再协调发布所有受影响总表；任一失败会回滚整批。

相似说法、提前确认、旧任务确认以及候选或预览变化后的旧确认均无效。

## 更新

```bash
codex plugin marketplace upgrade xiaohongshu-finance
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance
```

第二条命令会依据插件 manifest 的 cachebuster 刷新已安装版本，无需先卸载。

## 插件内容

- `xiaohongshu-reimbursement-workflow`：唯一可调用的总控工作流。
- `references/ledger-profiles.json`：三个固定账本 profile、正式文件名、目标 Sheet 与保护页白名单。
- `references/workbook-style-contract.json`：小红书语义版式、蓝色角色覆盖、合并、精度、冻结和打印契约。
- `run_reimbursement_batch.mjs`：父批次编排与 1–3 profile 并行准备。
- `build_reimbursement_candidates.mjs` / `audit_reimbursement_candidates.mjs`：候选与明细构建、独立 XLSX/OOXML 审计。
- `build_reimbursement_review_artifacts.mjs` / `build_batch_gate_artifact.mjs` / `build_reimbursement_final_audit.mjs`：结构化预览、两道统一门禁和独立终审。
- `publish_reimbursement_batch.mjs`：多账本事务发布、恢复、回滚和发布后审计。
- `manage_task_temp.mjs` / `cleanup_task_temp.mjs`：显式 inventory 的任务临时目录管理。

`对公已付不实报` 会计入费用合计和支出总表，但不计入员工实报合计。
