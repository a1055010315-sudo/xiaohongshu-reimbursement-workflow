# 运行可靠性约定

本页只约束执行方式，不改变父级业务口径、产物边界或两道门禁。同一任务中完整读取一次；只有本页在磁盘上变化时才重读。

## 1. 最少进程编排

将工作簿工作固定为三个主要进程，不能把三者合并；每个主要进程内部必须批量处理，不能按 Sheet、图片、检查项或单个工作簿反复启动：

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

在系统临时目录的本批专用目录中维护 `batch-manifest.json`。它只保存规范化业务事实和文件依赖；验收证书另存为临时 sidecar，不能写回 manifest 形成摘要自引用。推荐 `rulesVersion` 为 `xhs-reimbursement-fast-path-v1`，并包含：

```json
{
  "version": 1,
  "rulesVersion": "xhs-reimbursement-fast-path-v1",
  "batch": {
    "rootPath": "绝对路径",
    "archivePath": "绝对路径",
    "period": "完整时间段",
    "targetCategory": "小红书报销",
    "reviewRevision": 1
  },
  "files": [
    {"id": "baseline", "role": "baseline", "path": "绝对路径", "sha256": "64位小写十六进制"},
    {"id": "WX-I01", "role": "material", "kind": "image", "disposition": "used", "path": "绝对路径", "sha256": "64位小写十六进制"}
  ],
  "transactions": [
    {
      "id": "TX-001",
      "date": "2026-08-01",
      "person": "正式姓名",
      "project": "项目",
      "label": "正式姓名或汇总标签",
      "amount": "70",
      "category": "小红书报销",
      "reimbursable": true,
      "evidence": ["WX-I01"]
    }
  ],
  "expectedFeeTotal": "70",
  "expectedRealTotal": "70",
  "expectedCategoryTotals": {"小红书报销": "70"}
}
```

文件角色可使用 `material`、`archive-copy`、`detail`、`correspondence`、`candidate`、`summary-input`、`summary-output` 等稳定值。manifest 不得出现 `gate`、`approval`、`authorized` 或任何门禁/用户授权字段。

`material` 文件必须标记 `kind`（`image`、`text` 或 `attachment`）和 `disposition`（`used` 或 `excluded`）；排除项还要写 `reason`。无图片交易用 `missingEvidenceConfirmed: true`，它可以保留文字证据引用，但不能同时引用图片。调用 `scripts/audit_batch_manifest.mjs <manifest.json>` 验证 Decimal 金额、类目合计、引用完整性和磁盘文件哈希，并取得 manifest、文件和交易摘要。语义/视觉验收证书的缓存键至少为：

```text
rulesVersion + manifestDigest + 所有依赖文件SHA256 + 验收器版本
```

同一缓存键已经通过时直接复用，不重新导入或渲染。依赖变化时只使其下游证书失效；两道门禁本身从不写入或复用。第一门后仍独立重算金额；第二门后仍重新读取根表、明细和候选；发布后仍重新打开目标。

## 4. 图片 I/O

本批建立唯一图片注册表：

```text
sourceId → sourcePath → SHA256 → width/height → archiveCopies[] → workbookImageId → anchors[]
```

- 每张唯一原图只读取、取尺寸和解码一次。
- 实现支持时，同一原图在 XLSX 中只写入一个 OOXML media part，但每个业务行保留独立锚点。
- 重开 XLSX 时一次遍历 drawing relationship 和 media part，建立 SHA256 映射后核对全部锚点，不按图片实例重复解压整份工作簿。
- 每个实体归档副本仍逐个与来源哈希比较；不得用硬链接代替跨类目原图副本。
- 对话展示和工作簿嵌入共用本地原图；只有定位困难才生成一次临时裁剪或标注图。

## 5. Windows 与发布

开始批次时检查 Windows PowerShell 5.1+ 和 Node.js。缺少发布环境时仍可制作归档和候选，但必须在第二道门禁后的发布前停止。

Windows PowerShell 5.1 可能错误解析无 BOM UTF-8 `.ps1` 中的中文路径字面量。脚本源保持 ASCII，中文路径只通过参数传入；发布命令形态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <safe_publish.ps1> -BaselinePath <path> -CandidatePath <path> -TargetPath <path> -ExpectedBaselineSha256 <hash> -ExpectedCandidateSha256 <hash>
```

保留 `safe_publish.ps1` 的锁、回滚、临界窗口哈希和发布后核验。不要先优化这些安全 I/O；工作簿重复导入和渲染才是主要耗时。状态为 `published_cleanup_failed` 时先按返回哈希核验目标，再人工处理脚本给出的精确残留路径，禁止盲目重发。

## 6. 汇总文字说明

将已核对记录写入任务临时目录 JSON。预览和最终文件必须由同一脚本、同一输入生成：

```text
node scripts/build_reimbursement_summary.mjs --input <input.json> --preview
node scripts/build_reimbursement_summary.mjs --input <input.json> --output <new-output.txt> --expect-sha256 <预览textSha256>
```

预览返回 `summary` 正文及 `textSha256`；最终写入必须显式传入该哈希，写后重新读取并逐字节核对，再返回同一 `textSha256`。第一道门禁后才写最终 TXT。金额输入只接受非负、最多三位小数的字符串。

## 7. 临时目录与清理

每批生成至少 16 位随机 token，只创建一个系统临时目录直接子级 `codex-xhs-reimburse-<token>`，并写入：

```json
{"kind":"xiaohongshu-reimbursement-temp","version":1,"token":"<token>"}
```

目录保持扁平，只允许普通文件及明确的 Junction/符号链接；不放清理脚本。工作期间依据 manifest 访问精确文件，禁止反复全目录扫描。

结束时从 skill 目录调用 `cleanup_task_temp.mjs <temp-dir> <token>`。清理器必须保留 marker、路径、目录身份和内容的双重预检；目标已不存在视为幂等成功。遇到普通子目录、越界路径、身份变化或 token 不匹配时保留现场并报告，禁止宽泛递归删除。
