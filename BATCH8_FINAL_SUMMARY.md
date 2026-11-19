# Batch 8 最终总结：测试基础设施、跨浏览器与 SW 可靠性收尾

- 收尾批次：Batch 8E-4R（`fix(sw): recover snapshot readiness after transient failure`）
- 上游基线：`main = 9543413`（PR #26 已合并）
- 最新产品版本：`CACHE_VERSION = 2026-11-19-1`
- 结论：Batch 8 的功能与质量目标已完成；剩余事项均为 P3 且不阻塞发布。
- 说明：逐批细节以各批次报告为准（`BATCH8*_REPORT.md`、`BATCH8E3_FINAL_SUMMARY.md`），本文件只做阶段级汇总，不重复推导历史数据。

## 1. 阶段成果

| 方向 | 成果 | 关键证据 |
| --- | --- | --- |
| 测试基础设施 | 统一运行器契约、25 个套件动态端口、C17 内容构建锁、可选 `--workers 2`（仅已验证精确配对） | `BATCH8E3_FINAL_SUMMARY.md`；全量 `--workers 2` 64 PASS，wall 1209.7s |
| 默认回归 | 64 套，默认串行；CI 命令与套件清单未变 | PR #24/#25 CI 64/64 PASS |
| 跨浏览器 | 新增独立入口，Chromium / Firefox / WebKit 同场景串行验证 | 249 项（含 3 项 SKIP），0 FAIL；`BATCH8E4_REPORT.md` |
| SW 离线可靠性 | 注册/接管、离线首页与文章、未缓存降级、恢复、版本切换、安装失败回退、多标签、存储不可用 | 三引擎各 25 项 PASS；`BATCH8E4_REPORT.md` |
| SW 快照自愈 | `snapshotReady` 否定结果不再锁死整个生命周期 | RED→GREEN 三引擎；`BATCH8E4R_REPORT.md` |
| 性能与无障碍 | 8D 系列完成全站性能优化、无障碍改善与质量审计 | 提交 `8c188b8`；`BATCH8D4_REPORT.md` |

## 2. 问题收敛情况

已关闭：

| 编号 | 说明 | 关闭批次 |
| --- | --- | --- |
| B8E1-001 | 含单引号标签破坏 inline onclick | 8E-2（inline handler 编码加固） |
| B8E1-002 | inline 事件 ID 拼接缺少统一转义 | 8E-2 |
| C17 | `--sync` 读取在 BuildLock 外导致并发缺陷 | 8E-3B-R |
| B8E1-003 / B8E4-001 | `snapshotReady` 否定结果不可自愈 | **8E-4R（本轮）** |

仍开放（均为 P3，不阻塞发布）：

| 编号 | 说明 | 处理建议 |
| --- | --- | --- |
| B8E1-004 | `focusSearch` 连按定时器冗余 | 可选清理，非必须 |
| B8E1-005 | 搜索索引主线程一次性解析 | 规模增长后再评估 |
| B8E4-002 | Firefox `setOffline` 不能验证 SW 兜底 | 保持服务端断流模拟；不改产品 |
| B8E4-006 | Pages 构建 API 404 | 需要时用带权限方式核对部署 commit |
| B8E4-007 | 真实 Safari/iOS 与真实 IME 未覆盖 | 单列真机验收批次 |

## 3. 发布契约

1. 生产 SW 内容变化必须递增 `CACHE_VERSION`，不得复用旧版本号发布不同内容；本轮已从 `2026-11-18-1` 升至 `2026-11-19-1`。
2. 默认 64 套完整回归是发布门禁；跨浏览器入口为本地/手动验证，不替代默认门禁。
3. `content-gate` 必须 PASS。
4. 部署后建议人工抽查一次：在线访问 → 断网 → 恢复；确认旧版本缓存被清理（DevTools → Application → Cache Storage 只应保留 `2026-11-19-1` 相关缓存）。

## 4. 运行手册

```powershell
# 默认发布验收（64 套串行，CI 同款）
python scripts/run_tests.py

# SW 功能分组
python scripts/run_tests.py --group sw

# 跨浏览器核心功能（本地，需已安装 firefox/webkit）
node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit

# 离线和升级（D）+ 快照自愈（E）
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit

# 快照逻辑轻量专项（无浏览器，未注册进默认套件）
node tests/browser/sw-snapshot-unit.spec.js
```

## 5. 已知限制

1. 性能数据（1209.7s / 1398.5s / 544.3s 等）来自不同环境与负载，只能作趋势参考，不是严格 A/B。
2. 并行安全只对 13 个精确配对成立，不具传递性；默认仍串行。
3. Playwright WebKit 只代表 WebKit 引擎，不等于 macOS Safari / iOS Safari 设备验收。
4. 内置浏览器版本随 `package-lock.json` 锁定；CI 只安装 Chromium，跨浏览器入口在 CI 中不可用。
5. 三个新增测试入口（跨浏览器 ×2、快照专项 ×1）未注册进默认 64 套，需手动执行，或在后续批次评估是否纳入门禁。

## 6. 下一步

Batch 9 的计划输入见 `BATCH9_READINESS.md`。优先级建议：跨浏览器入口的 CI 化（可选独立 job）→ 测试指南补充 → 真机抽检；不再扩大并行调度器。
