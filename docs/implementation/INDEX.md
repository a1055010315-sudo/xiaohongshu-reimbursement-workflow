# 发放 vNext 实施索引

状态：S00 安全开发基线已建立；S01 已冻结 manifest v2 纯结构契约，来源解析与入口接入尚未实施。

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

树 SHA-256 的计算口径为：按 ordinal 升序排列相对路径，将每项编码为 `path NUL byteLength NUL fileSha256 LF`，再对 UTF-8 字节流计算 SHA-256；不含 Git 元数据。

## 单元状态

| 单元 | 状态 | 说明 |
| --- | --- | --- |
| S00 | complete | 纯来源导入、两处 cache 修正、基线证据、测试和交接 |
| S01 | complete | v2 exact schema、kind/version 分派、纯结构 validator、合成契约测试与 S02/S03 接口已冻结 |
| S02 | pending | 所有者和范围未冻结 |
| S03 | pending | 所有者和范围未冻结 |
| S04 | pending | 所有者和范围未冻结 |
| S05 | pending | 所有者和范围未冻结 |
| S06 | pending | 所有者和范围未冻结 |

## 当前边界

- S00 未修改 manifest、runner、archive 或其他业务逻辑。
- S00 未更新版本/cachebuster，未打包、未安装、未实施提速。
- manifest v2 结构已由 S01 冻结；结构通过不代表来源文件、sourceReview 事实或业务闭合已验证。
- S01 未修改现有 v1 auditor/runner/archive；后续必须严格按 kind/version 分派。
- 真实财务目录 `C:\Users\a1055\Desktop\luna\04_财务台账` 在 S00 中零读取、零枚举、零搜索。

## 文档入口

- `contracts/manifest-v2.md`：S01 冻结的 v2 schema、结构验证、兼容规则及 S02/S03/S04 接口。
- `contracts/ownership.md`：所有权与并行修改边界。
- `contracts/test-matrix.md`：现有基线测试证据。
- `handoffs/MASTER.md`：单元接续总表。
- `handoffs/S00.md` 至 `handoffs/S06.md`：逐单元交接。
