# 测试矩阵

状态：S00 基线已执行；后续契约测试未冻结。

## S00 发放测试

- 测试文件发现规则：`tests/disbursement-*.test.mjs`
- 文件数：4
- 顶层 `test(...)` 声明数：29
- Node test runner 最终真实计数：38（含 9 个嵌套子测试）
- 最终结果：38 pass，0 fail，0 skipped
- 最终耗时：17,391.252 ms
- Node：Codex bundled Node `v24.19.0`

四个测试文件：

- `disbursement-candidate-audit.test.mjs`
- `disbursement-domain.test.mjs`
- `disbursement-pdf-security.test.mjs`
- `disbursement-production-e2e.test.mjs`

Codex 本地 Node 镜像将 `node_modules` 放在 `bin/node_modules`，而来源加载器的 CJS 固定路径从 Node 父级读取。S00 未修改加载器，而是为测试建立并在结束后删除临时运行视图：Node 为 bundled `node.exe` 的硬链接，运行视图与 skill 根的 `node_modules` 均为指向 primary runtime 依赖根的临时 junction。

### 运行记录

1. 直接运行本地 bundled Node：runner 只装载出 7 项，4 pass、3 个测试文件加载失败；错误为 `Bundled runtime dependency root is unavailable`，加载器寻找的父级 `node_modules` 不存在。
2. 首个临时 Junction 指向 bundled Node 自身的 `bin/node_modules`：仍为 7 项、4 pass、3 个文件加载失败；该依赖集合没有 `jszip`。
3. Junction 改指 Codex primary runtime 完整依赖根：真实 38 项运行到 37 pass、1 fail；唯一失败是加密 PDF fixture 按临时 Node 的相对位置找不到 bundled Python/pypdf。
4. 使用测试已支持的固定变量 `XHS_BUNDLED_PYTHON` 指向 Codex primary runtime Python：同一 38 项全部通过。

以上失败均为运行时定位/fixture 依赖证据，没有修改实现来规避。WindowsApps 内的原始 packaged `node.exe` 还曾因系统 ACL 无法直接启动；最终使用的本地 Codex runtime Node 与其版本一致。

最终执行命令等价于：

```powershell
$env:XHS_BUNDLED_PYTHON = 'C:\Users\a1055\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& 'C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext\.tmp-s00-codex-node\bin\node.exe' --test --test-reporter=tap `
  'C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext\plugins\xiaohongshu-reimbursement-workflow\skills\xiaohongshu-reimbursement-workflow\tests\disbursement-candidate-audit.test.mjs' `
  'C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext\plugins\xiaohongshu-reimbursement-workflow\skills\xiaohongshu-reimbursement-workflow\tests\disbursement-domain.test.mjs' `
  'C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext\plugins\xiaohongshu-reimbursement-workflow\skills\xiaohongshu-reimbursement-workflow\tests\disbursement-pdf-security.test.mjs' `
  'C:\Users\a1055\plugins\development\xiaohongshu-finance-disbursement-vnext\plugins\xiaohongshu-reimbursement-workflow\skills\xiaohongshu-reimbursement-workflow\tests\disbursement-production-e2e.test.mjs'
```

临时 Node 与 bundled Node 的 SHA-256 均为 `b8983a7a4af031048d92632291bb53989aed5411d62e02f25b78daaddc2a10ea`。测试完成后，两个 junction、Node 硬链接及临时目录均已删除。

## 后续矩阵占位

| 契约/能力 | 单元 | 测试 | 状态 |
| --- | --- | --- | --- |
| manifest v2 | TBD | TBD | 未冻结 |
| 启动门槛替换 | TBD | TBD | 未冻结 |
| 兼容/迁移 | TBD | TBD | 未冻结 |
| 失败恢复 | TBD | TBD | 未冻结 |

不得把 TBD 行视为已承诺的设计或测试范围。
