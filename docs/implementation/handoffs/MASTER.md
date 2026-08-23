# 实施交接总表

当前 generation：`0`

当前主分支：`vnext/integration`

S06 预发布基线：`cda49e30bfbc88c5c14d170cfc75ee1d8e0c9ba7`

当前候选版本：`0.5.0+codex.20260823144931`

## 主 Goal

只实施“取消发放核销内部 manifest / publish receipt / 工资 certificate 启动门槛”，新增严格 manifest v2 的 `published_archive` 与 `fresh_evidence`，继续兼容严格 v1 一个发布周期。单次 archive、来源 fresh audit、TOCTOU、candidate/stage/final 审计、fsync、原子发布、恢复和普通报销 Gate 1/Gate 2 均保持。本期不实施整体性能优化，发布候选只生成和验证，不安装。

执行子对话统一使用 `GPT-5.6-sol / xhigh`。真实财务目录、当前 marketplace、安装缓存和 `config.toml` 始终不属于写入范围。

## 单元状态

| 单元 | 状态 | 交接 | 关键提交 |
| --- | --- | --- | --- |
| S00 | complete | `S00.md` | `8a09a77` / tag `baseline/s00-v0.5.0-codex.20260822170308` |
| S01 | complete | `S01.md` | `493c702` |
| S02 | complete | `S02.md` | `dfe3a95`，后续修正集成于 `cda49e3` |
| S03 | complete | `S03.md` | `83f5389` |
| S04 | complete | `S04.md` | `e06898b`，集成于 `904ed27` |
| S05 | complete | `S05.md` | `680400a`，集成及审查修正至 `cda49e3` |
| S06 | in_progress | `S06.md` | cachebuster、候选构建与独立复验进行中 |

## 当前验证证据

- 全部 `disbursement-*.test.mjs`：137 pass，0 fail，0 skip。
- 其余普通报销与共享基础设施测试：386 pass，0 fail，2 skip。
- 总计：523 pass，0 fail，2 skip。
- 两个 skip：Windows 当前权限不支持 leaf symlink/reparse fixture；默认关闭的 candidate benchmark。
- Skill：`Skill is valid!`。
- Plugin：`Plugin validation passed`。
- 普通报销 runner、Gate binding、full-correspondence auditor 与 Gate 2 reference 相对 S00 基线无差异。
- 性能脚本和性能测试相对 S00 基线无差异；本期没有执行整体性能优化。

## 第一次压缩交接

- `thread_compression_count=1`
- `rollover_generation=0`
- 已重新读取主 Goal、manifest v2 冻结契约、ownership、test matrix、各单元 handoff 与 plugin-creator 更新规则。
- 已核对 branch=`vnext/integration`、预发布基线 HEAD=`cda49e3`、dirty diff 和测试证据。
- cachebuster helper 已将版本更新为 `0.5.0+codex.20260823144931`；helper 在 Windows 产生的 CRLF/JSON 重排已规范化，候选提交必须证明除 cachebuster 外没有 plugin manifest 语义变化。

第二次上下文压缩时必须将 `thread_compression_count=2` 和状态改为 `needs-successor`，停止新增设计，只记录 HEAD、dirty files、测试、候选 SHA256 和下一动作后换新主对话。继任名称增加 `R1/R2`，`rollover_generation+1`，压缩计数归零。

## S06 剩余动作

1. 提交唯一 cachebuster 和发布记录，确保 `git diff --check` 通过。
2. 复跑静态、Skill、Plugin 和当前树回归验证。
3. 构建只含 `.agents`、`plugins`、`AGENTS.md`、`README.md` 的 marketplace ZIP 与 SHA256 sidecar。
4. 解压到全新临时目录，复验 ZIP SHA、版本、validators、文件清单、链接/临时/恢复目录及真实数据泄漏。
5. 只读核对 marketplace、安装缓存和 `config.toml` 未变化；不安装、不刷新。
6. 接收 GPT-5.6-sol/xhigh 独立发布预审，逐项 completion audit 后再结束 Goal。
