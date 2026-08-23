# 实施所有权

状态：S00-S05 已完成并集成；S06 由主对话独占集成分支写入。

## 规则

- 一个单元开始前记录 owner、branch/worktree、base、允许修改路径和明确排除项。
- 同一路径同时只能有一个 writer；跨单元通过 handoff 移交。
- 来源 marketplace、安装缓存、`config.toml` 和真实财务目录始终只读。
- 测试只使用合成或脱敏 fixture。
- 本期只取消发放核销内部 sidecar 启动门槛；普通报销 Gate 1/Gate 2 与整体性能优化不属于实现范围。

## 已完成分配

| 单元 | owner / branch | 状态 | 主要写入范围 |
| --- | --- | --- | --- |
| S00 | baseline / `s00-baseline` | complete | 新开发仓库、两处已知 cache 修正、基线文档 |
| S01 | contract / `s01-contract` | complete | v2 structural contract、契约测试和冻结文档 |
| S02 | published archive / `s02-published-archive` | complete | published source auditor、专属测试和交接 |
| S03 | fresh/salary / `s03-fresh-salary` | complete | fresh/salary auditor、专属测试和交接 |
| S04 | integration / `s04-integration` | complete | v1/v2 dispatcher、统一 audit、runner/fixture/E2E |
| S05 | docs / `s05-docs` | complete | Skill、reference、README、prompt、迁移文档 |
| S05 fixes | isolated review fixes | complete | voucher/owner-first 与真实 published archive 修正 |
| S06 | master / `vnext/integration` | in_progress | cachebuster、发布记录、`dist` 候选和验证证据 |

S02/S03 从 `493c702` 并行，S04 集成提交 `e06898b`，主分支集成至 `cda49e3`。S06 期间只有主对话可以修改 `vnext/integration`；`s06_release_preflight` 仅做 GPT-5.6-sol/xhigh 只读审查。

## 普通报销边界

S00 基线已单独吸收安装缓存中两处普通报销修正：

- `audit_full_correspondence.mjs`
- `build_reimbursement_artifacts.mjs`

本期相对 S00 基线没有修改：

- `run_reimbursement_workflow.mjs`
- `build_gate_binding.mjs`
- `audit_full_correspondence.mjs`
- `references/gate2-full-correspondence.md`

`audit_batch_manifest.mjs` 只有 optional ordinary-manifest attestation 的 deferred no-follow 安全修正：deferred 模式不再 stat/read manifest 声明的未注册历史路径，并明确报告 `declaredPathVerification`。普通报销非 deferred 路径仍 fresh 读取并校验 SHA，Gate 语义不变。

## S06 允许与排除

允许：

- plugin-creator helper 生成的单一 cachebuster；
- README 与 `docs/implementation` 发布记录；
- `dist` 中最终 ZIP 和 SHA256 sidecar。

排除：

- 候选缓存复用、文件并发、PDF Worker、减少审计次数或其他性能重构；
- 修改 marketplace entry、`config.toml`、安装 cache 或运行安装/升级；
- 读取、枚举、搜索或打包真实财务目录；
- 将测试临时目录、Junction/reparse、恢复目录、任务内部 request/manifest 或秘密放入候选。
