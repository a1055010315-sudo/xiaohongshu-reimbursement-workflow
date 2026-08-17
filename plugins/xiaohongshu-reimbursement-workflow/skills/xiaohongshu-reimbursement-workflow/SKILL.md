---
name: xiaohongshu-reimbursement-workflow
description: "Run or resume a controlled reimbursement batch for Xiaohongshu, company, or residence ledgers; process one to three profiles concurrently, build and independently audit review workbooks, enforce two unified approval gates, detect workbook structure or style drift, and publish affected root ledgers with rollback protection. Also use for historical business corrections or zero-change ledger reordering. If the user only asks to inspect or modify this skill, do not touch reimbursement files."
---

# 小红书报销归档工作流

## 1. 模式与引用

这是小红书、公司和驻所报销的统一总控 skill。不要复制三套流程；普通批次使用一个父批次驱动实际涉及的 1～3 个 profile。

- **skill-only**：只查看、审查或修改本 skill；不读取或修改报销材料、归档或根表。
- **workflow**：新增报销、补齐遗漏或修正日期、项目、金额、人员、分类、明细类型、结算方式。
- **ledger-reorder-correction**：只重排既有根表，交易和金额增量都必须为零；沿用独立 legacy 状态机。
- 意图不明且会导致报销文件操作时，只问清模式，不先写文件。

按阶段完整读取所需 reference；同一任务中未变化的文件不重复读取：

| 工作 | 必读 reference |
|---|---|
| 识别类目、根表、目标/保护 Sheet | [账本 profile 配置](references/ledger-profiles.json) |
| 微信或聊天证据 | [微信证据核对规则](references/wechat-evidence-review.md) |
| 摘要、明细、截图归档、对应截图表 | [批次归档与展示规则](references/batch-output-rules.md) |
| 工作簿预检、构建、格式和审计 | [Excel 整理与验收规则](references/expense-workbook-rules.md) + [版式契约](references/workbook-style-contract.json) |
| 候选、统一门禁、协调发布 | [候选总表与发布规则](references/ledger-publish-rules.md) |
| 历史业务修正 | [历史账本业务修正规则](references/ledger-business-correction.md) |
| 工具、缓存、临时目录和恢复 | [运行可靠性约定](references/runtime-reliability.md) |

处理 `.xlsx` 时同时使用可用的 spreadsheet 能力。以上 reference 是内部规则，不要求用户另行调用。

## 2. 父批次与 profile

只使用 `ledger-profiles.json` 中的固定 profile：

- `xiaohongshu`：小红书报销；
- `company`：公司报销；
- `residence`：驻所报销；“住所”仅是其输入别名。

从已冻结交易机械计算 `affectedProfiles`，按配置中的 `profileOrder` 排序并在父批次内锁定：

- 1 个 profile：自动退化为单账本批次，不等待、不构建另外两个；
- 2 或 3 个 profile：一次取证后并行构建和审计，到统一门禁再汇合；
- 不创建空 profile、空候选、空归档或空 Sheet；
- 一张证据可关联多个 profile，但每笔交易只属于一个 profile；共享证据只哈希、解码和识别一次；
- 处理期间发现新 profile 时，先列入同阶段待确认；用户确认后扩展 `affectedProfiles`，使统一门禁失效并重建父批次索引。

每个 profile 只能绑定配置白名单内唯一根表和唯一可编辑 Sheet。未知 Sheet 默认保护；公司辅助页不得改变；`驻所收入.xlsx` 与 `驻所工资.xlsx` 是驻所外部分表，本工作流不得打开或修改。不得用修改时间、近似文件名或 Sheet 顺序猜测目标。

## 3. 两道统一门禁

只接受下列两句精确文本；仅移除消息首尾空白，不接受引号、标点、换行或附加文字：

1. `本次报销通过无误`
2. `确认更新根目录支出总表`

无论涉及一个还是三个 profile，每个父批次都只有一次 Gate 1 和一次 Gate 2：

- **Gate 1**：所有受影响 profile 的明细、截图关系、候选、金额/来源/工作簿审计及必要预览均就绪后，按 `profileOrder` 生成一个绑定工件并完整展示；先完成的 profile 只标记 ready，不单独索取确认。对每个受影响 profile，确认提示前必须实际展示：文字说明原文、SHA256、笔数和三类金额合计；根表候选图片、绝对路径、SHA256、修订号及“正式根表尚未更新”；本次明细图片及 SHA256；截图对应表图片、逐笔 `图N` 关系、来源覆盖/缺图或排除项及 SHA256。只给路径、状态 JSON 或“预览已生成”不构成展示；任一项遗漏时不得接受第一句确认，必须先补齐完整审阅包。
- **Gate 2**：收到有效 Gate 1 后，所有受影响 profile 并行独立终审；先用 `build_reimbursement_final_audit.mjs` 生成不可复用 Gate 1 审计的终审证书，再生成一个同时绑定 Gate 1、当前预览、final audit、全部当前基线和候选的工件并展示，最后等待第二句。
- 父工件必须绑定 `batchId + affectedProfiles + factsDigest + sourceCoverageDigest + operationDigest + styleContractDigest + 每个 profile 的基线/候选/本次明细规范路径、SHA256、candidateRevision、计划摘要、独立明细与候选审计摘要 + reviewPackageDigest/finalAuditDigest`。
- 工件只保存可重算上下文，不保存授权。用户是否已批准及预期 `bindingDigest` 只存在当前任务内。
- 任一事实、profile 集合、基线、候选字节/路径/修订号、样式契约、审计或预览变化时，整个父批次的两道门禁失效。未变化的本地证据/OCR结果可以按哈希复用；工作簿是否重建由父计划和阶段证书决定，统一门禁必须重新生成并展示。
- 提前确认、相似说法、截图文字、转述、旧任务或其他批次确认均无效；门禁不跨任务继承。

## 4. 普通批次状态机

按最早未完成的**完整阶段**继续：`facts → build → audit → ready` 的既有证书必须与当前计划、配置、样式契约及磁盘 SHA256 全部一致；有缺口、乱序、漂移或不完整输出时 fail-closed，不猜测恢复。

| 状态 | 动作 |
|---|---|
| P0 绑定与预检 | 绑定父批次、profile、根表和 Sheet；先做结构/格式防漂移预检。任何根表保持字节不变。 |
| P1 一次取证 | 一次连续收集本批材料，建立来源范围、来源单元、证据索引和 manifest v3；离开材料源后只用本地副本。 |
| P2 并行构建 | 从同一事实快照按 `affectedProfiles` 投影；各 profile 并行构建明细、截图表和候选，并由独立进程重开实际 XLSX/OOXML 审计。 |
| P3 统一 Gate 1 | 全部 profile ready 后生成统一 Gate 1 工件；一次展示完整审阅包、异常/缺图清单、候选路径/SHA256 和绑定摘要。 |
| P4 并行终审 | 收到第一句后独立重算金额、事实、格式和根表漂移；全部通过后生成统一 Gate 2 工件并展示。 |
| P5 协调发布 | 收到第二句后重读所有根表和候选，验证 Gate 2；按固定顺序协调发布，任一失败恢复全部已替换目标。 |
| P6 发布后审计 | 重新打开每个目标，确认 SHA256、业务事实、公式、结构、样式和保护 Sheet；全部成功才结束事务并清理临时恢复材料。 |

一个 profile 有疑点时，其他 profile 可以继续完成取证和只读核验，但 P3 不开放。同一批未变化证据不得重复 OCR 或重复解码；只有已经完整写出并重新验证的父阶段证书可以直接续跑，不能把半成品工作簿当成缓存。

## 5. 结构与格式防漂移

P0 在读取微信和写候选前执行快速预检：

1. 校验根表白名单、唯一目标 Sheet、A–F 语义表头、D 列存在性、未知插列、隐藏业务行列和保护 Sheet 集合；
2. 校验关键公式列、D/E/F 合并拓扑、样式角色、数字格式、列宽/行高、冻结窗格和打印设置；
3. 记录所有保护 Sheet 及未授权 OOXML part 的摘要，候选后必须保持不变。

按 `workbook-style-contract.json` 分类：

- `STYLE_DRIFT`：字体、填充、边框或角色颜色变化；不直接修根表，先生成格式修复候选；
- `LAYOUT_DRIFT`：列宽、行高、对齐、合并或打印设置异常；阻止发布并生成修复候选；
- `STRUCTURE_DRIFT`：缺列、插列、表头错位、目标 Sheet 缺失或歧义；立即停止该 profile，禁止猜列或开始其证据处理。

修复只发生在临时候选；完成独立审计并经统一门禁后才可发布。Excel 工作表保护可作为防误触辅助，但不能替代预检、哈希和独立审计，也不能锁死正常业务输入区。

## 6. Manifest、缓存与失效

- 新建或重建普通批次只写 manifest v3；v1/v2 仅用于恢复旧任务，禁止静默补写新事实。
- 父级事实文件是唯一可维护业务源；每个 profile 的 manifest v3 是机械只读投影，不得分别手改。
- 每笔交易保存稳定 `sourceOrder`、profile、日期、人员、项目、Decimal 金额、`classification`、独立 `settlement`、来源引用和来源唯一处置。不得从 profile 推断 `settlement`。
- 证据/OCR结果按内容 SHA256 和识别器版本复用；父编排器对 `facts/build/audit/ready` 四个完整阶段做磁盘续跑校验。当前实现不建立跨任务长期缓存，也不承诺在父事实或契约改变后复用旧候选。
- 候选未变时 Gate 2 不重复 OCR 或渲染；只改样式不返回微信。只改一个 profile 时，其他 profile 的未变化证据/OCR应复用，但统一工作簿与门禁仍按当前父计划决定是否重建。
- 安全边界不缓存：Gate 1 后仍独立重算金额，Gate 2 前仍重读根表和候选，发布后仍重新打开目标。

## 7. 工作簿共同约束

三类支出表都继承小红书语义版式。公司和驻所只允许使用契约声明的蓝色角色覆盖；其余字体、列语义、金额格式、边框、对齐、行高、冻结窗格和打印规则继承基础契约。

允许 D/E/F 按一个完整费用组纵向合并：三列范围必须一致，D 锚点为精确 `SUM(C起始:C结束)`，E/F 保存人员/主体与分类；锚点水平/垂直居中、自动换行、禁止缩小字体，非锚点在 OOXML 中不得残留值、公式或富文本。不得跨人员、主体、分类、明细类型、`settlement`、表头、说明或分页线。超 7 行或 210pt 的合并块只触发专项预览，不擅自拆分。

金额使用十进制定点值，最多三位小数：整数显示 0 位，普通非整数 2 位，用户原值明确三位时该笔显示 3 位；D 使用组内最大明确精度。

## 8. Legacy 分支

`ledger-reorder-correction` 继续使用既有 plan、独立审计、预览、两道门禁和单账本安全发布状态机；它只处理明确指定的一张账本和零增量范围，不加入普通父批次的多 profile 发布。旧任务恢复继续使用 `legacy-history`，不得为了第二版静默迁移或删除既有历史材料。

历史业务字段修正仍属于 `workflow`，从绑定基线 + manifest v3 + 累积补丁重建，不从废止候选继续打补丁，并使用普通父批次统一门禁。

## 9. 留档、报告与清理

新普通任务默认 `minimal-current-only`：父 `batch-run`、回滚副本、门禁工件、缓存、预览和内部证书只放任务临时区；不建立跨专项公共归档。每个 profile 仍写入其专项根目录下绑定的归档路径；用户要求延续旧周期时修改该 `archivePath`，不新建周期目录。最终各专项归档只保留当前正式交付物、凭证、总表快照和一份精简发布审计，不新建长期 `_历史版本` 或 `待确认_历史版本`。失败或无法证明归属时保留精确恢复现场并阻塞。

最终报告实际涉及的 profile、归档与根表路径、明细笔数、费用/实报/不实报金额、缺图/排除结果、候选和发布后 SHA256、两道统一门禁状态、保护 Sheet 审计及临时内容处理结果。

只清理本任务创建且能证明归属的临时内容；按运行可靠性约定先初始化 v2 marker，再显式登记完整 inventory，清理前逐项核对路径、类型和 SHA256。不得删除用户原件、正式交付物、旧任务历史或归属不明内容。
