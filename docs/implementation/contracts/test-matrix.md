# 测试矩阵

状态：S00-S06 已完成；全量回归、静态检查和解压候选复验均绑定固定 source commit。

## 运行时

- Node：`C:\Users\a1055\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- Python：`C:\Users\a1055\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`
- 测试材料：只使用合成或脱敏 fixture；不读取真实财务目录。

## 历史基线

S00 的四个原发放测试文件使用 bundled Node 运行：38 pass，0 fail，0 skip。基线 tag 为 `baseline/s00-v0.5.0-codex.20260822170308`。

## 当前集成树

候选 source commit：`9e9b52142020433af7092c6788562720d766bda6`；生产代码基线为 `cda49e3`。

| 组 | 结果 | 说明 |
| --- | --- | --- |
| 全部 `disbursement-*.test.mjs` | 137 pass / 0 fail / 0 skip | v1、v2 contract、published、fresh/salary、PDF、安全链、恢复、E2E、等价输出 |
| 其余普通报销与共享基础设施 | 386 pass / 0 fail / 2 skip | Gate、发布/恢复、workbook、模板、布局、并发与共享原语 |
| 总计 | 523 pass / 0 fail / 2 skip | 当前全集成回归 |

实际运行使用 `node --test --test-concurrency=1 --test-reporter=spec` 分两组串行：

- 发放组 7 个文件：duration `41646.746 ms`。
- 其余组 20 个文件：duration `367841.7422 ms`。
- Node `v24.19.0`；Python `3.12.13`；`XHS_BUNDLED_PYTHON` 固定到 bundled Python。

两个 skip：

1. Windows 当前权限不支持 leaf symlink/reparse fixture；同类 ancestor/reparse 拒绝测试通过。
2. candidate benchmark 默认关闭；本期明确不实施性能优化，也不生成新的性能结论。

## 需求覆盖

| 契约/能力 | 主要测试 | 状态 |
| --- | --- | --- |
| manifest v2 exact schema、版本分派、fileId/路径绑定 | `disbursement-manifest-v2-contract.test.mjs` | pass |
| published archive 无 manifest/receipt、可选 attestation、allowlist、多 profile、零图片、差额 review-bound | `disbursement-reimbursement-published-archive-v2.test.mjs` | pass |
| fresh evidence、工资 workbook/image 无 certificate、可选 attestation、歧义 fail-closed | `disbursement-fresh-source-v2.test.mjs` | pass |
| v1 严格兼容与弃用 warning、v1/v2 等价最终字节 | `disbursement-production-e2e.test.mjs` | pass |
| 单次 `--archive`、旧 prepare/finalize/approvalText 拒绝 | `disbursement-production-e2e.test.mjs` | pass |
| 双次来源读取、TOCTOU、candidate/stage 替换、原子发布、最终审计和恢复 | `disbursement-production-e2e.test.mjs` / `disbursement-pdf-security.test.mjs` / `publish-crash-recovery.test.mjs` | pass |
| voucher 声明 kind 与真实 image/PDF 绑定 | `disbursement-pdf-security.test.mjs` | pass |
| owner-first 与非法新 token 不留恢复目录 | `disbursement-production-e2e.test.mjs` | pass |
| 普通报销 Gate 1/Gate 2 隔离 | 普通 Gate/runner/full-correspondence 回归与基线 diff | pass |

## 静态与包验证

- 修改/新增生产 `.mjs`：`node --check`。
- Skill：skill-creator `quick_validate.py`。
- Plugin：plugin-creator `validate_plugin.py`。
- source diff：`git diff --check`。
- 发布 ZIP：SHA256 sidecar、严格顶层清单、全新目录解压后重复 Skill/Plugin/static 校验。

S06 解压候选另运行 v2 contract 与模板定向测试：36 pass、0 fail、0 skip；Skill、Plugin、37 个生产脚本静态检查通过。最终候选路径、SHA256、source commit、外部未变和独立 GO 记录在 `handoffs/S06.md`。不得把窄测试、未启用 benchmark 或“没有发现失败”当成整体性能优化完成证据。
