# Batch 8E-3B-1：测试端口动态分配与资源隔离

- 日期：2026-11-18
- 仓库：`E:\work_funnycode\blog`
- 基线：`a0157f1`（PR #21 squash 合并：`Batch 8E-3A/8E-3A-R: test runner reliability + SW S12 stability (#21)`）
- 分支：`perf/batch8e3b1-test-isolation`
- 范围：只执行 `BATCH8E3B_NEXT_PLAN.md` 的 **Task 1**（端口隔离）与 C17 定向诊断；未实现 `--workers` 并行调度器，未修改业务代码、UI、正式内容、`sw.js`、`CACHE_VERSION`、CI 或生产构建逻辑。
- 最终状态：`B8E3B1_LOCAL_READY`

## 1. 基线与合并确认

- `origin/main` 已同步到 `a0157f1`；PR #21 的 squash commit 已进入 main。
- 8E-3A / 8E-3A-R 文件完整保留，包括 `BATCH8E3A_REPORT.md`、`BATCH8E3AR_REPORT.md`、`tests/test47_runner_infrastructure.py`、`tests/browser/sw.spec.js`。
- 迁移前工作树干净；未发现本任务遗留的 Node / Chromium / Python 测试进程。
- 使用 PR #21 已通过的 CI 全量结果作为功能基线；本轮不重复执行 8E-3A-R 的旧全量。

## 2. 动态端口迁移清单

新增：

- `tests/helpers/port.js`：`requestedPort()` 默认返回 `0`，`TEST_PORT` 仅显式覆盖且必须为 `0..65535` 整数；`listen()` 用 Promise 包装真实监听，监听成功返回 `server.address().port`。
- `tests/helpers/port-fixture-server.js`：动态端口 fixture，支持 `PORT_FILE`、`/__shutdown`、`ERR ...` 启动失败、SIGTERM/SIGINT 清理。
- `tests/test48_port_isolation.py`：端口专项，12 项；已注册为 `port-isolation`。

迁移的 25 个文件（其中 `tests/batch7c1/publish_scenarios.js` 未注册进 full；full 注册清单实际迁移 24 套）：

| 类别 | 文件 | 旧端口/机制 | 新机制 |
|---|---|---|---|
| 静态服务器 | `tests/audit.js` | 8131（直接 listen） | `listen(0)` + `TEST_PORT` |
| 静态服务器 | `tests/test6.js` | 8130 | 同上 |
| 静态服务器 | `tests/test7.js` | 8132 | 同上 |
| 静态服务器 | `tests/test8.js` | 8133 | 同上 |
| 静态服务器 | `tests/test9.js` | 8134 | 同上 |
| 静态服务器 | `tests/test10.js` | 8135 | 同上 |
| 静态服务器 | `tests/test11.js` | 8136 | 同上 |
| 静态服务器 | `tests/test14.js` | `B3_PORT` 默认 8137；父进程分配 8137–8139 | 默认各子进程 `listen(0)`；仅显式 `B3_PORT` 时保留 `base+idx` 覆盖 |
| 静态服务器 | `tests/test16.js` | 8146 | `listen(0)` + `TEST_PORT` |
| 静态服务器 | `tests/test20_publish_search.js` | 8136 | 同上 |
| 静态服务器 | `tests/test24_publish_queue.js` | 8142 | 同上 |
| 静态服务器 | `tests/test32_editor_export.js` | 8151 | 同上 |
| 静态服务器 | `tests/test35_editor_update.js` | 8161 | 同上 |
| 静态服务器 | `tests/test36_editor_toolbar.js` | 8181 | 同上 |
| 静态服务器 | `tests/test37_editor_images.js` | 8182 | 同上 |
| 静态服务器 | `tests/test38_draft_history.js` | 8183 | 同上 |
| 静态服务器 | `tests/test39_search_ranking.js` | 8141 | 同上 |
| 静态服务器 | `tests/test40_search_sources.js` | 8142 | 同上 |
| 静态服务器 | `tests/test41_search_filters.js` | 8143 | 同上 |
| 静态服务器 | `tests/test42_search_history.js` | 8144 | 同上 |
| 静态服务器 | `tests/test43_reading_tools.js` | 8145 | 同上 |
| 静态服务器 | `tests/test44_image_lightbox.js` | 8147 | 同上 |
| 静态服务器 | `tests/test46_inline_handlers.js` | 8148 | 同上 |
| 浏览器 | `tests/browser/performance-accessibility.spec.js` | 8146 | `listen(server, 0)` + 既有真实端口回写 |
| 未注册 helper | `tests/batch7c1/publish_scenarios.js` | 8141 | `listen(0)` + `TEST_PORT`；不在 full 注册清单 |

未迁移（保留原因）：

- `tests/perf/a11y-audit.js` 仍使用 8231，但 `tests/perf/*` 不在 61/62 套 full 注册清单中，属于独立性能脚本；本轮不扩大范围。
- 其他浏览器套件原本就是 `listen(0)` + 独立 BrowserContext profile；没有必须迁移的固定端口。
- 文档中的地址字符串、模拟 URL、非监听断言未做替换；本轮只改真实监听端口。

## 3. 端口专项验证

`tests/test48_port_isolation.py`：

- D1：两个独立 fixture 同时启动，操作系统分配 54835/54836（另一次 54899/54900），两者都返回自身真实端口。
- D2：`/__shutdown` 正常退出码 0；退出后同一端口可重新绑定并正常服务。
- D3：`TEST_PORT` 指向已占用端口时非 0 退出（exit 2），stderr 包含 `EADDRINUSE`。
- D4：非法 `TEST_PORT` 快速失败，stderr 指出 `TEST_PORT`。
- 结果：**12/12 PASS**，约 2.1s。

## 4. 冲突组实测

串行与双进程并发均使用默认动态端口；详细日志见 agent 工作区 `conf-*` / `par-*`。

| 组合 | 串行 exits | 串行 wall | 并发 exits | 并发 wall | PASS 计数 | 并发端口 | EADDRINUSE | 结果 |
|---|---|---|---:|---|---:|---|---|---|---|
| `test11 + test20` | 0 / 0 | 57.5s | 0 / 0 | 25.9s | 19/19, 24/24 | 60731 / 60734 | 无 | PAIR_SAFE |
| `test24 + test40` | 0 / 0 | 46.3s | 0 / 0 | 36.7s | 22/22, 35/35 | 60859 / 60856 | 无 | PAIR_SAFE |
| `test16 + performance-accessibility` | 0 / 0 | 86.7s | 0 / 0 | 63.0s | 20/20, 59/59 | 54617 / 54545 | 无 | PAIR_SAFE |

实测收益：

- pair1：57.5s → 25.9s，约 **54.9%** 缩短。
- pair2：46.3s → 36.7s，约 **20.7%** 缩短。
- pair3：86.7s → 63.0s，约 **27.3%** 缩短。
- 以上只是**组合级**结果，不能推断所有 62 套可以全局并行；Chromium CPU/内存压力、共享 artifact 和测试顺序依赖仍未验证。

## 5. C17 诊断

详见 `BATCH8E3B1_C17_DIAGNOSTIC.md`。结论：

- 20 次合成 fixture 并发采样：14 次 `[0,0]`、4 次 `[0,3]`、**2 次 `[0,1]`**。
- 失败样本 A：`diff_artifacts` 读取 `data/search-index.json` 时 `PermissionError`（`build_content.py:209`）。
- 失败样本 B：`os.replace` 替换 `js/data.js` 时 `WinError 5`（`build_content.py:253-254`）。
- 根因：`diff_artifacts` 在 BuildLock 外读取（`build_content.py:380`），与另一进程锁内的 `os.replace` 在 Windows 文件共享语义下冲突；`[0,3]` 是正常锁竞争，不是本问题。
- 影响：P2；`test23` 保持 `SERIAL_REQUIRED`，不得进入默认并行池；本轮未修改生产构建逻辑或 C17 断言。
- 本次 final 的 `test23` 通过了 C17；但 20 次采样中 2 次失败的统计风险仍然存在，不能据此认为 C17 已稳定。

## 6. 全量回归

- 命令：`python scripts/run_tests.py --json tests/reports/b8e3b1-full.json --report tests/reports/b8e3b1-full.md`
- 套件总数：62（原 61 + `port-isolation`）。
- 结果：**62 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED（结论 PASS，exit 0）**
- 耗时：**1239.9s（约 20.7 分钟；环境 0.6s / 语法 7.6s；browser 540.9s / jsdom 484.6s / python 206.2s）**
- 报告：`tests/reports/b8e3b1-full.md` / `.json`（gitignored，不提交）。

## 7. 尚未解除的资源隔离风险

- 已迁移套件只证明“固定端口冲突消除”；除已验证的三个组合外，没有全局并行证据。
- 浏览器套件虽使用独立 profile/临时端口，但 Chromium 启动成本、CPU/内存和截图/artifact 竞争未量化。
- `test23` 的 Windows 并发构建共享冲突仍需独立修复。
- `tests/batch7c1/publish_scenarios.js` 不在 full 注册清单，迁移未纳入正式回归覆盖。
- `tests/perf/a11y-audit.js` 仍固定 8231，不在本轮 full 范围。

## 8. 代码修改与边界

- 只修改测试基础设施：25 个测试文件、`scripts/run_tests.py`、新增端口 helper/fixture/test48，以及文档/矩阵。
- 未修改 `js/app.js`、CSS、文章数据、路由/稳定 ID、`sw.js`/`CACHE_VERSION`、`scripts/build_content.py`、CI/发布流程。
- 未实现 `--workers`，未启用默认并行，未增加自动重试，未删除任何原有测试或降低断言。
- `tests/reports/*`、agent 工作区日志、临时脚本不进入 commit。

## 9. 工作树与残留进程

- 工作树：**提交前仅有本轮预期修改；提交后 clean**
- 残留进程：**无本任务相关 Node / Python / Chromium 进程；8100–8300 无监听端口**
- 本地 commit：`test: Batch 8E-3B-1 isolate test server ports and resources`（本地，未 push；完整 hash 见 `git log -1`）
