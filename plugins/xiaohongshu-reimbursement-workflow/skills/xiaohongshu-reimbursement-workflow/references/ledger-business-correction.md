# 历史账本业务修正规则

## 目录

1. 适用边界
2. 不变量与来源覆盖
3. 画布标注与修正补丁
4. 候选布局计划
5. 独立验收
6. 修订、门禁与发布

## 1. 适用边界

当用户要求补齐历史遗漏，或修改既有交易的日期、项目、金额、人员、分类、明细类型、`settlement` 时，继续使用 `workflow/reimbursement-batch` 门禁和发布分支，但执行本 reference。不要误入只允许零业务变化的 `ledger-reorder-correction`。

本分支的最小事实单位是交易，不是工作表行、费用组合并区或截图。表格排序、D 列公式以及 A/D/E/F 合并均是交易事实的派生布局，不能反向决定交易是否存在、属于谁或属于哪个分类。

## 2. 不变量与来源覆盖

- 新任务使用 manifest v3；恢复既有 v1/v2 批次只读兼容，不把旧 manifest 静默升级为新事实。
- 每个 `sourceScope` 绑定材料文件、可复现边界 `locator`、`terminalConfirmed: true` 和 `expectedUnitCount`；每个 `sourceUnit` 绑定范围内的行/消息/图内区域 `locator`。实际单元数必须等于范围确认数，不能只声明“已检查”。
- `classification`、`settlement`、`sourceOrder` 分开保存。不得从人员名称、项目文字、行号或合并区域推断结算方式。
- 每个来源单元必须在来源覆盖证书中恰有一个处置：
  - `transaction`：关联一笔或多笔规范化交易；
  - `already_in_baseline`：关联唯一基线交易指纹；
  - `excluded_non_target`：附明确非目标类目原因；
  - 无法唯一判断时标记冲突并阻塞，不得写裸行号排除列表。
- 目标类目的 `company_paid_no_reimbursement` 仍进入本次明细和候选/根表，只从“实报”合计排除。只有非目标类目才能用 `excluded_non_target`。
- 每笔 manifest 交易至少引用一个已使用来源；被排除来源不得被交易引用。来源数量、已用数量、排除数量和末端确认必须能独立重算。
- 基线交易与新增交易用规范化业务多重集合核对；同金额或同文本不能单独作为去重依据。`already_in_baseline` 必须唯一绑定完整业务指纹。

## 3. 画布标注与修正补丁

用户按画布行号标注时，先汇总全部标注，再统一生成累积补丁集；根表保持不变。行号只用于定位，补丁必须同时绑定修改前的：日期、项目、金额、人员、分类、明细类型和 `settlement`。任一指纹字段不匹配就阻塞，不能把补丁套到“看起来相似”的行。

每个补丁至少记录：

- 唯一 `patchId`、目标交易 ID、递增 `sequence`；
- `before`、`after` 和精确 `authorizedFields`；
- 用户标注对应的来源 ID；
- 必填 `supersededCandidate: {path, sha256}`：`path` 是被该补丁废止候选的绝对路径，`sha256` 是其 64 位十六进制 SHA256。该对象只允许 `path`、`sha256` 两个字段，仅作审计链，不作重建基线。

`corrections[]` 只允许 `patchId`、`transactionId`、`sequence`、`authorizedFields`、`before`、`after`、`evidenceSourceId`、`supersededCandidate`；`before`/`after` 只允许七个业务字段。未知字段、相对路径、缺失或无效哈希、同一路径绑定冲突哈希都必须阻塞。被废止候选必须保留到本轮独立审计完成，不能用当前候选、基线或手写摘要替代其文件字节。

实际变化字段必须与 `authorizedFields` 完全相等。只改分类时，日期、项目、金额、人员、明细类型和 `settlement` 都必须字节语义不变；多次修改同一交易时，前一补丁的 `after` 必须等于下一补丁的 `before`。

每个新候选都从绑定根表基线 + 完整 manifest + 全部累积补丁重新构建；禁止在上一候选上继续打补丁。上一候选立即废止，候选修订号递增，两道门禁和旧终审全部失效。

## 4. 候选布局计划

先把候选业务交易投影成 JSON，再调用：

```text
"<bundled-node>" scripts/derive_ledger_layout.mjs --input <records.json> --out <new-layout.json>
```

输入记录必须含 `id + sourceOrder + date + project + amount + person + classification + rowType + settlement + origin + sourceIds`。构建器只消费已审计 manifest、绑定基线、累积补丁和这个新布局计划；不得重新解析截图、硬编码人员行号、人工排除参考表行或自行发明费用组。

布局计划机械执行：

- 全表按 `date:asc + sourceOrder:asc` 稳定排序；同日不得按人员、项目或金额二次排序。
- A 列只按连续相同日期形成运行段。
- D/E/F 使用同一费用组运行段。只有相邻交易的“正式人员/主体 + 精确分类 + 明细行类型 + settlement”均非空且完全相同才成组；日期变化本身不拆组。
- 分类、人员、类型或 `settlement` 任一变化都拆组；任一组键为空时该交易为单行组。
- 多行组的 D/E/F 三列必须使用完全相同的合并范围，D 左上角公式必须精确覆盖本组 C。
- C 的显示精度：整数 0 位；非整数且用户原值为三位小数时 3 位；其余非整数 2 位。D 使用组内最大显示精度，禁止整段统一成三位小数。

候选计划的 SHA256 和 manifest 的 `sourceCoverageDigest` 必须进入普通报销 Gate v2 上下文。

## 5. 独立验收

保存候选后，用与构建器不同的只读进程重新打开基线和候选，从候选实际 A-F、公式、数字格式和合并范围生成审计包。审计包不得复制构建器输出的组边界、公式或 `actualMerges`；必须从工作簿实际字节提取。

随后调用：

```text
"<bundled-node>" scripts/audit_ledger_layout.mjs --input <audit-package.json> --baseline <baseline.xlsx> --candidate <candidate.xlsx>
```

该审计器独立验证：

- 审计包绑定的基线/候选 SHA256 与磁盘文件一致，且每版都从绑定基线重建；
- 每个补丁绑定的被废止候选文件可读，磁盘字节 SHA256 与 `supersededCandidate.sha256` 一致；
- 来源覆盖没有遗漏、重复、裸排除或错误引用；
- 累积补丁只改变授权字段，补丁链连续，最终值等于候选事实；
- 候选逐行事实等于 `date + sourceOrder` 投影，笔数和十进制定点金额一致；
- A 运行段与 D/E/F 运行段分别正确，F 不得遗漏；
- D 公式、合并从属格、整数/两位/三位显示精度正确。

构建器和独立审计器可以共享低层 SHA256、UTF-8 和 Decimal 工具，但不得共享来源匹配结果、费用组边界、预期合并列表或“已存在/排除”判断。两个程序使用同一手工行号映射不算独立验收。

## 6. 修订、门禁与发布

每次候选变化都重新生成布局计划、来源覆盖摘要、候选预览和 Gate 1 v2 绑定。收到第一道精确确认后，再从磁盘独立终审并生成 Gate 2 v2；候选计划、来源覆盖、基线、候选或补丁任一变化都使两道门禁失效。

收到第二道精确确认后，发布前再次重读根表、候选、manifest v3、布局计划和来源覆盖证书；所有摘要完全一致才调用受控发布器。发布后重新打开根表，运行同一独立审计并确认根表 SHA256 等于候选 SHA256。
