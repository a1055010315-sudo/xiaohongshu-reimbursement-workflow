# 实施所有权

状态：S00、S01 所有权已结案；S02-S06 待分配。

## 规则

- 一个单元开始前必须记录 owner、branch/worktree、base、允许修改的路径和明确排除项。
- 未冻结契约不得由实现单元自行补写为既成事实。
- 同一路径同时只能有一个写入所有者；跨单元需要通过 handoff 明确移交。
- 来源 marketplace、安装缓存和 Codex 配置始终只读。
- 真实财务目录不属于开发或测试输入。

## 当前分配

| 单元 | owner | 状态 | 写入范围 |
| --- | --- | --- | --- |
| S00 | baseline unit | complete | 独占创建整个新开发仓库；完成后停止修改 |
| S01 | contract unit | complete | 独占 v2 contract 模块/测试及本次指定实施文档；完成后停止修改 |
| S02 | unassigned | pending | 未冻结 |
| S03 | unassigned | pending | 未冻结 |
| S04 | unassigned | pending | 未冻结 |
| S05 | unassigned | pending | 未冻结 |
| S06 | unassigned | pending | 未冻结 |

S00 的实际业务脚本写入仅限从 cache 原样吸收以下两个文件：

- `audit_full_correspondence.mjs`
- `build_reimbursement_artifacts.mjs`

其余 S00 写入均为 marketplace 完整导入、Git 元数据或 `docs/implementation` 状态/交接文档。

## S01 冻结写入范围

- branch：`s01-contract`
- worktree：`C:\Users\a1055\plugins\development\xhs-worktrees\S01-contract`
- base：`baseline/s00-v0.5.0-codex.20260822170308`（peeled `8a09a77c4a7cef2845e4bff8825162b620544ecc`）
- 新增独占模块：`plugins/xiaohongshu-reimbursement-workflow/skills/xiaohongshu-reimbursement-workflow/scripts/disbursement_manifest_v2_contract.mjs`
- 新增独占测试：`plugins/xiaohongshu-reimbursement-workflow/skills/xiaohongshu-reimbursement-workflow/tests/disbursement-manifest-v2-contract.test.mjs`
- 文档：`contracts/manifest-v2.md`、`contracts/ownership.md`、`contracts/test-matrix.md`、`handoffs/S01.md`、`INDEX.md`

S01 明确没有 `disbursement_manifest.mjs`、runner、archive、生产 fixture、版本/cachebuster、打包或安装所有权。S02/S03 可消费 S01 导出的冻结接口，但若需改变字段或结构，必须先显式重开 contract 所有权，不能在解析器中暗改 schema。
