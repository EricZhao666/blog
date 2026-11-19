# Batch 9 就绪评估（基于 Batch 8E-4 / 8E-4R）

- 评估时间：2026-11-19（Batch 8E-4R 收尾后更新）
- 上游基线：`main = 9543413`（PR #25、PR #26 均已合并）
- 收尾分支：`fix/batch8e4r-snapshot-recovery`
- 结论：**B8E4R_PR_READY**；Batch 8 质量目标完成，未进入 Batch 9

## 1. 就绪结论

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 发布阻塞缺陷 | 无 | 无 P0/P1 |
| 三引擎功能一致性 | 已验证 | Chromium / Firefox / WebKit 各 58 PASS / 0 FAIL（C1–C5） |
| SW 离线可靠性 | 已验证 | 10 项场景 × 3 引擎全部 PASS |
| 历史 SW 风险（B8E1-003 / B8E4-001） | **已修复** | 三引擎 RED→GREEN；同生命周期内可自愈；离线兜底未变 |
| 生产版本 | `CACHE_VERSION = 2026-11-19-1` | 已按发布契约递增；未部署 |
| 默认 64 套回归 | 未改动 | 新入口不注册；由 PR 默认串行 CI 做最终验收 |
| 真机与真实 IME | 未覆盖 | 环境限制，明确不计 PASS |

结论：具备进入 Batch 9 计划阶段的条件；唯一需要额外留意的是**合并部署后的真实升级抽查**（旧 2026-11-18-1 → 新 2026-11-19-1）。

## 2. 进入 Batch 9 前置条件

1. Batch 8E-4R PR 被人工审核并合并；
2. 默认串行 CI 64/64 PASS、`content-gate` PASS；
3. 合并部署后人工抽查一次：在线访问 → 断网 → 恢复，并确认 Cache Storage 仅保留 `2026-11-19-1` 相关缓存；
4. 若要扩大跨浏览器覆盖，先决定运行位置（本地手动 / 独立 CI job），不得改动默认 job 的命令与范围；
5. 任何后续 SW 改动必须复用 `--scenario=E` 与 `sw-snapshot-unit.spec.js` 作为定向回归。

## 3. 已有可复用资产

| 资产 | 用途 | 命令 |
| --- | --- | --- |
| `tests/browser/helpers/cross-browser.js` | 引擎启动、结果 JSON、artifact 隔离 | 被两个 spec 引用 |
| `tests/browser/cross-browser.spec.js` | C1–C5 功能矩阵 | `--engines=` / `--scenario=` |
| `tests/browser/cross-browser-offline.spec.js` | D 离线/升级 + E 快照自愈 | `--scenario=D` / `--scenario=E` |
| `tests/browser/sw-snapshot-unit.spec.js` | snapshotReady 逻辑专项（无浏览器） | `node tests/browser/sw-snapshot-unit.spec.js` |
| `tests/reports/b8e4/*.json` | 结构化结果（不入库） | 自动生成 |
| `BATCH8E4_BROWSER_MATRIX.csv` | 跨浏览器逐项矩阵（252 行） | 由 JSON 汇总 |
| `BATCH8E4_ISSUES.csv` | 问题清单（含 8E-4R 状态更新） | — |
| `BATCH8E4R_REPORT.md` | 自愈修复的 RED/GREEN 证据 | — |
| `BATCH8_FINAL_SUMMARY.md` | 阶段级收尾 | — |

## 4. 建议的 Batch 9 候选（按优先级）

1. **P3：跨浏览器入口的 CI 化**（可选独立 job，安装 firefox/webkit；默认 job 不变）。三引擎串行约 78s（C1–C5）+ 约 78s（D/E），需评估 runner 成本。
2. **P3：测试指南补充**（Firefox `setOffline` 限制、WebKit 不等于 Safari、未缓存资源需用确定性路径、快照自愈判据用状态而非计时）。
3. **P3：真机抽检**（macOS Safari / iOS Safari / 真实中文输入法），单列批次，不替代自动化。
4. **P2 候选（需产品侧输入）**：目前未发现，故不预设。

不建议在 Batch 9 做的：再次扩大并行调度器、把跨浏览器全量设为默认、用真实设备验收替代自动化、无内容变化时随意递增 `CACHE_VERSION`。

## 5. 风险与约束

1. 新增浏览器组件属于本地环境依赖（Firefox 157.0 / WebKit 27.2），CI 未安装；新入口在 CI 中若被误调用会以退出码 2（BLOCKED）失败，属预期。
2. `cross-browser-offline.spec.js` 用“服务端断流”模拟断网，不等价于操作系统级断网（Firefox 的 `setOffline` 不可用）。
3. 自愈判据以“首屏资源是否产生网络请求”（状态）为主，计时（600ms 注入 / 450ms 阈值）为辅；高负载下计时可能抖动，不应单独作为失败依据。
4. 时间型辅助判据依赖 `NAV_TIMEOUT_MS=150ms`；若生产调整该值，需要同步更新判据。
5. 未注册的三个入口（跨浏览器 ×2、快照专项 ×1）不在默认门禁内，需手动执行或在后续批次评估纳入。
6. 本轮所有数字为本机单次运行结果（Windows），不含 CI 数据；不作为性能基线。

## 6. 验收命令（Batch 9 起沿用）

```powershell
# 发布验收（不变）
python scripts/run_tests.py

# SW 功能分组
python scripts/run_tests.py --group sw

# 跨浏览器（串行）
node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit

# 快照自愈定向
node tests/browser/sw-snapshot-unit.spec.js
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit --scenario=E
```
