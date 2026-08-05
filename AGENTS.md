# Codex 安装指引

本仓库是一个公开的 Codex repo marketplace。用户提供本仓库链接并明确要求“安装”“配置”或“自动设置”时，在当前环境允许的范围内替用户完成安装，不要把正常命令步骤转交给用户。

## 自动安装流程

1. 先确认当前产品支持插件。支持的目标是 Codex 桌面端或 Codex CLI；IDE 扩展不支持插件安装。最终更新根目录总表只支持 Windows 10/11，其他系统只能完成归档和候选快照。若当前产品不支持，直接说明需要切换到支持的目标，不要修改仓库文件。
2. 检查 `codex` 命令是否可执行，并只读检查现有 marketplace 和插件状态。
3. 如果 marketplace `xiaohongshu-finance` 尚未添加，执行：

   ```bash
   codex plugin marketplace add a1055010315-sudo/xiaohongshu-reimbursement-workflow --ref main --json
   ```

4. 如果该 marketplace 已存在，先执行：

   ```bash
   codex plugin marketplace upgrade xiaohongshu-finance --json
   ```

5. 如果插件尚未安装，执行：

   ```bash
   codex plugin add xiaohongshu-reimbursement-workflow@xiaohongshu-finance --json
   ```

6. 使用 `codex plugin list --json` 验证插件已安装且启用。不要只根据命令退出码声称成功。
7. 告知用户重新打开 Codex 或新建任务，然后用下面的一次调用开始：

   ```text
   使用 $xiaohongshu-reimbursement-workflow:xiaohongshu-reimbursement-workflow 处理本次小红书报销。
   材料在：<材料路径或本消息附件>
   支出表根目录：<根目录绝对路径>
   ```

## 异常处理

- 用户只发送裸链接、没有明确安装意图时，只读取和说明，不执行安装；用一句话确认是否要安装即可。
- `codex` 命令不存在、当前产品不支持插件、组织策略阻止安装或需要系统级权限时，说明唯一的实际阻塞点；只有无法代为执行时才给用户最短的手动操作。
- 已安装时不要重复安装或先卸载；验证现有版本并按需升级 marketplace。
- 不修改用户的报销文件、个人 skill 或本仓库内容。安装阶段只管理 Codex marketplace 和插件状态。
- 不下载或保存任何报销截图、Excel、凭证或账号秘密。
