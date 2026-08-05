# 运行可靠性约定

本页只约束执行方式，不改变 `SKILL.md` 的业务口径和两道门禁。

## 工作簿工具

1. 将“构建/导出”“重新打开做语义校验”“渲染做视觉校验”拆成独立进程。一个进程只承担一个主要阶段，避免成功导出后被渲染器的退出状态误判为整批失败。
2. 每个进程只输出一条紧凑 JSON 结果；不要把整张表、完整样式对象或大段 NDJSON 打到终端。检查结果、预览和 sidecar 只能写入本任务专用临时目录。
3. 对全部异步操作显式 `await`。真实异常返回非零；已完成输出并通过本进程校验时显式设置 `process.exitCode = 0`。
4. 渲染范围必须有界。只渲染实际数据区或能验证样式/合计的代表性范围，禁止对上千空白格式行或整张超高工作表使用自动裁剪。
5. 若渲染进程已输出成功 JSON 且预览文件存在，但退出码仍非零，只运行一次独立只读验证器：重新打开工作簿、核对关键值/公式并打开预览。两者都通过时记录为“渲染器退出状态异常”，不得循环重建工作簿；任何一项不通过则按真实失败处理。

## Windows 与 PowerShell

1. 最终发布只在 Windows 10/11 上执行。开始批次时检查 Windows PowerShell 5.1+ 和 Node.js；缺少发布环境时仍可制作归档和候选快照，但必须在第二道门禁后的发布前停止。
2. Windows PowerShell 5.1 可能把无 BOM 的 UTF-8 `.ps1` 中的中文路径字面量解析坏。脚本源文件保持 ASCII，所有中文路径只通过参数传入；脚本只输出 ASCII 转义后的单条 JSON。
3. 发布时调用本 skill 的 `scripts/safe_publish.ps1`，不要在临时目录生成发布脚本。建议命令形态：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <safe_publish.ps1> -BaselinePath <path> -CandidatePath <path> -TargetPath <path> -ExpectedBaselineSha256 <hash> -ExpectedCandidateSha256 <hash>
   ```

4. 发布脚本用同目录 lock file 防止本工作流并发实例互相覆盖，并在释放目标读锁后立即按路径复核哈希再原子替换。非协作进程仍可能在极小窗口内改名或替换目标；不要声称这是绝对 CAS，脚本成功后必须重新打开并核对目标 SHA256、公式和结构。
5. 返回码非零时读取脚本唯一的紧凑 JSON 错误并停止；不得因为目标文件存在或终端有部分输出就声称发布成功。若状态为 `published_cleanup_failed`，先按返回的目标哈希核验，再人工处理脚本报告的精确残留路径，不能盲目重发。

## 汇总文字说明

将已核对记录写入专用临时目录的 JSON，并调用可用 Node.js 执行：

```text
node scripts/build_reimbursement_summary.mjs <input.json> <new-output.txt>
```

输入包含 `period`、`entries[]`；每个 entry 使用字符串金额 `amount`、标签 `label` 和布尔值 `reimbursable`。金额只接受非负且最多两位小数，禁止二进制浮点和静默四舍五入。可附 `expectedFeeTotal`、`expectedRealTotal` 进行双重校验。脚本以首次出现顺序聚合，输出真实 TAB，并拒绝覆盖已有文件。

## 临时目录与清理

1. 每批生成至少 16 位随机 token，只创建一个系统临时目录直接子级 `codex-xhs-reimburse-<token>`，并写入 `.codex-xhs-owner.json`：`{"kind":"xiaohongshu-reimbursement-temp","version":1,"token":"<token>"}`。
2. 依赖目录若必须链接，只允许 `node_modules` 等明确 Junction/符号链接；不要在临时目录里放清理脚本。
3. 从 skill 目录调用可用 Node.js：`cleanup_task_temp.mjs <temp-dir> <token>`。清理器先核对路径、marker、目录身份和完整内容，再只删除普通文件和链接；遇到普通子目录、越界路径、身份变化或 token 不匹配会拒绝，不做递归删除。目标已不存在返回 `already_absent`。

## 对话状态

只有 `本次报销通过无误` 和 `确认更新根目录支出总表` 需要精确匹配。其他信息只要语义清楚就直接记入当前批次；用户手动调整材料后必须重新扫描，不得继续使用旧清单。
