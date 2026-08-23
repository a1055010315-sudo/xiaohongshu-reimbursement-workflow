# 实施所有权

状态：S00 所有权已结案；S01-S06 尚未分配。

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
| S01 | unassigned | pending | 未冻结 |
| S02 | unassigned | pending | 未冻结 |
| S03 | unassigned | pending | 未冻结 |
| S04 | unassigned | pending | 未冻结 |
| S05 | unassigned | pending | 未冻结 |
| S06 | unassigned | pending | 未冻结 |

S00 的实际业务脚本写入仅限从 cache 原样吸收以下两个文件：

- `audit_full_correspondence.mjs`
- `build_reimbursement_artifacts.mjs`

其余 S00 写入均为 marketplace 完整导入、Git 元数据或 `docs/implementation` 状态/交接文档。
