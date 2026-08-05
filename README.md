# 小红书报销归档工作流

这是一个面向 Codex 的 skills-only 插件，用一次显式调用完成小红书报销的材料核对、本次明细制作、归档、候选总表快照、终审和受控发布。

仓库只包含插件说明和 skill，不包含报销截图、财务数据、账号凭证或本机路径。

## 给同事：只需把链接交给 Codex

同事不需要手动复制下面的安装命令。只需在 Codex 桌面端或 Codex CLI 中发送：

```text
请读取下面的 GitHub 项目，并自动为我安装、配置和验证这个 Codex 插件；除非权限或当前产品不支持，否则不要让我手动执行安装命令：
https://github.com/a1055010315-sudo/xiaohongshu-reimbursement-workflow
```

Codex 应读取本仓库根目录的 `AGENTS.md` 和本说明，自动完成 marketplace 添加、插件安装及结果验证。安装完成后，同事只需要按 Codex 提示重新打开 Codex 或新建任务。

仅发送裸链接只授权读取，不足以授权安装；加上“请安装并配置”这句话即可，其余步骤交给 Codex。

## Codex 自动执行的安装步骤

以下命令供 Codex 自动执行，也可用于故障排查。插件需要支持插件功能的 Codex 桌面端或 Codex CLI：

```bash
codex plugin marketplace add a1055010315-sudo/xiaohongshu-reimbursement-workflow --ref main
codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance
```

安装后请新建一个 Codex 任务，让新安装的 skills 被加载。

## 一次调用

在新任务中调用总控 skill 一次：

```text
使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 处理 2026.7.14-2026.7.25 的小红书报销。
材料在：<材料路径或本消息附件>
支出表根目录：<根目录绝对路径>
```

之后继续在同一任务中回复即可，不需要再调用内部的 Excel skill。

## 两道确认门禁

1. Codex 先归档本次材料、制作本次明细和候选总表快照；根目录总表保持不变。
2. 核对报销业务无误后，单独回复：`本次报销通过无误`
3. Codex 完成终审并报告当前有效候选文件及 SHA256。
4. 确认终审结果后，单独回复：`确认更新根目录支出总表`
5. Codex 重新读取磁盘并验证无并发变化后，才更新根目录 `小红书支出总表.xlsx`。

相似说法、提前发送的确认、旧任务中的确认以及候选文件发生变化后的旧确认都无效。

## 同事已经完成前半段

如果同事已经做好文字说明、报销截图和本次明细，不需要重做。新任务仍只调用一次总控 skill，并给出已有时间段文件夹和支出表根目录。Codex 验证已有成果后会从对应检查点继续；两道用户确认需要在当前任务中重新取得。

## 更新

刷新 GitHub marketplace：

```bash
codex plugin marketplace upgrade xiaohongshu-finance
```

更新后请重新打开 Codex，并在新任务中使用插件。

## 插件内容

- `xiaohongshu-reimbursement-workflow`：唯一需要用户显式调用的总控工作流。
- `xiaohongshu-expense-sheet`：插件内部使用的 Excel 整理与验收能力。

`对公已付不实报` 会计入费用合计和支出总表，但不计入实报合计。
