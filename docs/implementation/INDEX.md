# 发放 vNext 实施索引

状态：S00-S05 已完成 manifest v2 契约、来源审计、入口集成、回归修正和文档迁移；S06 正在生成并验证不安装的发布候选。

## 固定基线

- 开发仓库：`C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext`
- 分支：`s00-baseline`
- 来源 marketplace：`C:\Users\a1055\.agents\plugins\marketplaces\xiaohongshu-finance-0.5.0+codex.20260822170308-824ff19b`
- 只读安装缓存：`C:\Users\a1055\.codex\plugins\cache\xiaohongshu-finance\xiaohongshu-reimbursement-workflow\0.5.0+codex.20260822170308`
- 插件版本：`0.5.0+codex.20260822170308`
- 纯 marketplace 导入提交：`f4e1c0099872171d71838f65e796d1cd5e86126b`
- 两处 cache 修正提交：`90da41096913bb189ae8869898cc165d111fa185`
- 基线 tag：`baseline/s00-v0.5.0-codex.20260822170308`；tag 指向 S00 最终 HEAD，并在注释中记录最终 Git tree、来源、版本和运行时路径。
- 来源树 SHA-256：`249e1c1529b2d5a0fd6067d7b38ab085e6bc2a307d483c8b64fb7bbc77ec7187`
- 安装缓存树 SHA-256：`68e5d328a9344de270cb4058ed21209c71dd642cfc6690695fb7ec4832aba298`
- Codex bundled Node：`C:\Users\a1055\AppData\Local\OpenAI\Codex\runtimes\cua_node\cd454f7c85348168\bin\node.exe`，`v24.19.0`
- S05 文档集成基线：`904ed27dcd03ee90523866f71dbaa7dbf001461d`
- S06 预发布代码基线：`cda49e30bfbc88c5c14d170cfc75ee1d8e0c9ba7`
- S06 候选版本：`0.5.0+codex.20260823144931`

树 SHA-256 的计算口径为：按 ordinal 升序排列相对路径，将每项编码为 `path NUL byteLength NUL fileSha256 LF`，再对 UTF-8 字节流计算 SHA-256；不含 Git 元数据。

## 单元状态

| 单元 | 状态 | 说明 |
| --- | --- | --- |
| S00 | complete | 纯来源导入、两处 cache 修正、基线证据、测试和交接 |
| S01 | complete | v2 exact schema、kind/version 分派、纯结构 validator、合成契约测试与 S02/S03 接口已冻结 |
| S02 | complete | published archive 来源审计；原 manifest/receipt 为可选佐证，提供时严格验证 |
| S03 | complete | fresh reimbursement 与 salary 来源审计；certificate 可选，review-bound 语义诚实保留 |
| S04 | complete | v2 auditor/runner 集成；v1 弃用 warning 与原单次安全发布链保留 |
| S05 | complete | Skill、reference、UI 元数据、README 和迁移交接同步到业务材料直入与 v2 默认 |
| S06 | in_progress | 主对话独占集成分支；cachebuster、ZIP/SHA256、全新目录复验与未安装核对进行中 |

## 当前边界

- 发放用户入口从明确业务材料开始；`sourceReview`、默认 v2 manifest 与严格四字段 archive request 均由当前任务内部生成，不是用户手动准备步骤。
- v2 `published_archive` 可无原 manifest/receipt，`fresh_evidence` 可无 attestation，salary 可无 certificate；任何已提供佐证仍 fresh 严格验证，错误或冲突阻塞。
- 图片与没有冻结工资 schema 的工作簿继续使用 `review_bound_no_ocr` / `review_bound_no_frozen_salary_schema`，不能提升为插件机械金额识别；业务歧义必须询问。
- 旧 manifest v1 仅严格兼容一个发布周期并返回弃用 warning；不增加人工 Gate。普通报销 Gate 1/Gate 2 完全不变，发放继续一次完成且保留 TOCTOU、stage/final 审计、fsync、原子发布、恢复与最终三项复核。
- S05 文档后已完成独立代码审查修正：voucher kind 强绑定、owner-first 恢复、真实多 profile/零图片归档、来源金额差额及 ordinary-manifest deferred no-follow；这些修正均已纳入 `cda49e3`。
- 当前全集成回归为 523 pass、0 fail、2 skip；两个 skip 分别是 Windows leaf symlink/reparse 权限和默认关闭的 candidate benchmark。
- 本期未改性能实现文件、未运行新的性能评估，也未减少任何安全审计。
- 真实财务目录 `C:\Users\a1055\Desktop\luna\04_财务台账` 在 S00-S06 中保持零读取、零枚举、零搜索、零修改。

## 文档入口

- `contracts/manifest-v2.md`：S01 冻结的 v2 schema、结构验证、兼容规则及 S02/S03/S04 接口。
- `contracts/ownership.md`：所有权与并行修改边界。
- `contracts/test-matrix.md`：现有基线测试证据。
- `handoffs/MASTER.md`：单元接续总表。
- `handoffs/S00.md` 至 `handoffs/S06.md`：逐单元交接。
- `handoffs/S05.md`：本次 Skill、README、兼容迁移与验证证据。
