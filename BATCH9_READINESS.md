# Batch 9 就绪评估（基于 Batch 8E-4）

- 评估时间：2026-11-19
- 上游基线：`main = afc3646`（PR #25 已合并）
- 本轮分支：`test/batch8e4-cross-browser-reliability`
- 本轮结论：**B8E4_PR_READY**；未进入 Batch 9

## 1. 就绪结论

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 发布阻塞缺陷 | 无 | 无 P0/P1；本轮未修改生产代码 |
| 三引擎功能一致性 | 已验证 | Chromium / Firefox / WebKit 各 58 PASS / 0 FAIL（C1–C5） |
| SW 离线可靠性 | 已验证 | 10 项场景 × 3 引擎全部 PASS |
| 历史 SW 风险（B8E1-003） | 仍存在（P3） | 同一 SW 生命周期内不自愈；离线兜底未失效 |
| 默认 64 套回归 | 未改动 | 新入口不注册；由 PR 默认串行 CI 做最终验收 |
| 真机与真实 IME | 未覆盖 | 环境限制，明确不计 PASS |

结论：可以进入 Batch 9 的**计划阶段**，但 B8E1-003 的修复建议优先安排在一个独立、低风险的小批次中处理，且必须配套定向回归。

## 2. 进入 Batch 9 前置条件

1. PR #25（已合并）之后的本轮 PR 被人工审核并合并；
2. 默认串行 CI 64/64 PASS、`content-gate` PASS；
3. 若要扩大跨浏览器覆盖，必须先决定运行位置（本地手动 / 独立 CI job），不得改动默认 job 的命令与范围；
4. 任何 SW 改动必须先补 B8E1-003 定向用例（已有 `--scenario=E` 可直接复用）。

## 3. 已有可复用资产

| 资产 | 用途 | 命令 |
| --- | --- | --- |
| `tests/browser/helpers/cross-browser.js` | 引擎启动、结果 JSON、artifact 隔离 | 被两个 spec 引用 |
| `tests/browser/cross-browser.spec.js` | C1–C5 功能矩阵 | `--engines=` / `--scenario=` |
| `tests/browser/cross-browser-offline.spec.js` | D 离线/升级 + E 快照自愈 | `--scenario=D` / `--scenario=E` |
| `tests/reports/b8e4/*.json` | 结构化结果（不入库） | 自动生成 |
| `BATCH8E4_BROWSER_MATRIX.csv` | 逐项矩阵（252 行） | 由 JSON 汇总 |
| `BATCH8E4_ISSUES.csv` | 问题清单与分级 | — |

## 4. 建议的 Batch 9 候选（按优先级）

1. **P3：`snapshotReady` 否定结果自愈**（`sw.js` 单函数改动 + `--scenario=E` 回归 + 现有 `sw`/`sw-upgrade`/`sw-consistency` 套件）。风险低，但必须有“修复前 RED / 修复后 GREEN”的同环境证据。
2. **P3：跨浏览器入口的 CI 化**（可选独立 job，安装 firefox/webkit；默认 job 不变）。若接入，需接受运行时长增加约 75s（三引擎串行）。
3. **P3：测试指南补充**（Firefox `setOffline` 限制、WebKit 不等于 Safari、未缓存资源需用确定性路径）。
4. **P2 候选（需产品侧输入）**：本轮未发现，故不预设。

不建议在 Batch 9 做的：再次扩大并行调度器、把跨浏览器全量设为默认、用真实设备验收替代自动化、修改 `CACHE_VERSION`。

## 5. 风险与约束

1. 新增浏览器组件属于本地环境依赖（Firefox 157.0 / WebKit 27.2），CI 未安装；新入口在 CI 中若被误调用会以退出码 2（BLOCKED）失败，属预期。
2. `tests/browser/cross-browser-offline.spec.js` 用“服务端断流”模拟断网，不等价于操作系统级断网（Firefox 的 `setOffline` 不可用）。
3. 版本切换场景使用独立浏览器实例，避免同源历史连接影响；若后续改成共享实例，需重新验证。
4. 时间型判据依赖 `NAV_TIMEOUT_MS=150ms` 与 600ms 注入延迟的差距（阈值 450ms）。若生产改用其他超时值，需要同步更新该判据。
5. 本轮所有数字为本机单次运行结果（Windows），不含 CI 数据；不作为性能基线。

## 6. 验收命令（Batch 9 起沿用）

```powershell
# 发布验收（不变）
python scripts/run_tests.py

# 跨浏览器（本轮新增，串行）
node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit

# 仅 B8E1-003 定向
node tests/browser/cross-browser-offline.spec.js --engines=chromium --scenario=E
```
