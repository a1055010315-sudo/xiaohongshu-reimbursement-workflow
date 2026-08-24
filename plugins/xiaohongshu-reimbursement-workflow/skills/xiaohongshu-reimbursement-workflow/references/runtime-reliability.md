# 运行可靠性

## 依赖与入口

通过 workspace dependency loader 取得固定 Node.js 和依赖路径。普通报销只有：

```text
node scripts/run_reimbursement_workflow.mjs --prepare <request.json>
node scripts/run_reimbursement_workflow.mjs --finalize <request.json>
node scripts/run_reimbursement_workflow.mjs --revise-gate2 <request.json>
node scripts/run_reimbursement_workflow.mjs --publish <request.json>
```

不要扫描工作区其他 Excel，不要调用已删除的 batch/candidate/gate/publisher 旧链。Excel/PowerShell 预览只处理三个批次工作簿和批次总表投影。

## 一次读取与缓存

- manifest 绑定每个材料的 SHA256。普通 `--prepare` 的 manifest 审计只做结构和 stat 校验，材料字节由交付物构建器读取并核对 SHA，基线字节由局部总表构建器读取并核对 SHA，避免同轮预审再完整读取一遍。独立运行 manifest auditor 时仍执行全文件哈希。
- 交付物构建器按哈希去重，同一字节源只载入一次。
- 图像类型和 JPEG SOF 尺寸按 SHA 缓存；备注/分类修订不得重新做图像识别。
- 工作簿内每个唯一媒体只写一个 part；引用数和唯一媒体数分别审计。
- 预览阶段只读已生成工作簿，不重新打开原图。
- Gate 2 可复用 Gate 1 PNG 字节，但必须重新核对源工作簿与 PNG 哈希并创建新绑定。

任何源文件 SHA256 变化只使引用该源的事实及下游工件失效；失败重试不重建无关 profile 或无关证据。

## 临时目录

所有中间文件位于 `os.tmpdir()` 下带 64 位任务 token 的目录。目录内写 owner marker；所有写入使用排他创建。普通流程不得在财务目录写 manifest、模板、预览、候选中间件、日志或回滚文件。

成功发布后按已记录 SHA256 删除 task-owned 文件并移除空目录，包括 Gate 2 `REVIEW_REQUIRED`/`CORRECTION_REQUIRED`/`BLOCKED_RETRYABLE` 的内容寻址尝试报告和已取代 workflow。删除前若内容被外部修改，保留并报告，不能强删。失败时合并为唯一恢复现场；下一次恢复先核对 marker、基线、候选和状态摘要。

## 性能守卫

- 完整参数化合成批次回归必须使用批次预览，禁止全历史渲染。
- 根表构建器不得导入 `audit_ledger_layout.mjs` 或全表 facts reader。
- 在同机、同一参数化合成负载和相同冷/热规则下，以本轮修改前、与候选输出契约等价的只读已安装版本为普通 O 线基线，将最终 `prepare + Gate 1 + full-correspondence Gate 2 finalize` 配对测量；双方版本和树 digest 必须锁定并在运行前后复验。20% 是信息性改善目标。通过要求输出完全等价，冷、热 p50 与 p95 均不得退化超过 5%，各轮采样峰值 RSS 的 p95 增幅均不超过 15%，并且任何 renderer 的预览 PNG 均保持唯一；任一失败都禁止打包、安装或发布。
- 性能变慢时先检查全表扫描、原图重复读取、旧预览重渲染和失败后全批重试，不通过增加并行旧链解决。

## 错误边界

仅以下情况阻塞普通流程：当前材料/expected 不闭合、补报原因缺失、金额或 SHA 不一致、目标 Sheet/关系缺失、命中的跨日期 D:F 组无法用定点 C 金额和 D:F 锚点证明局部 splitPlan 安全闭合、候选局部审计失败、门禁失效或发布基线变化。对齐且公式、缓存、子行 payload、四精度样式族与合计守恒均可证明的组在 Gate 1 前自动局部拆分，不询问用户。历史区域其他格式问题不属于普通报销阻塞条件。
