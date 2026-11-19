# Batch 8E-3B 下一阶段计划

- 上游：Batch 8E-3A（`B8E3A_PARTIAL`，已由 Batch 8E-3A-R 恢复 61/61；PR 待审核）
- 基线：`ce27b46` + 8E-3A commit `50bb398` + 本批 S12 修复 commit
- 原则：按依赖顺序推进，不同时混合“端口隔离”“并行调度”“浏览器资源”三个方向；每完成一个任务即可独立验收。
- 快速分组（`--group smoke` 等）仅用于开发辅助，**不能替代 full 发布验收**。

## 前置事实（来自 8E-3A / 8E-3A-R）

- 61 套串行 full：8E-3A-R 后 **61/61 PASS**；8E-3A 基线为 1270.4s。
- `browser` S12 已改为状态驱动等待：连续 3 次 37/37；不再需要 Task 0。
- 固定端口冲突已证实：8136（`test11`/`test20`）、8142（`test24`/`test40`）、8146（`test16`/`performance-accessibility`）。
- 已验证 2-worker 组合：`test16 + test43`，38.3s → 24.3s，结果一致。
- 其余 38 套为 UNKNOWN（无并发实测）；22 套为 NEED_ISOLATION（固定端口）。

## 当前状态更新（Batch 8E-3B-R，2026-11-19）

- 合并后基线：`1e6da65`（PR #22 squash 合并，8E-3B-1 端口隔离已进入 main）。
- 本轮分支：`fix/batch8e3br-content-build-concurrency`；只修复 C17 内容构建并发缺陷，不实现并行调度。
- C17 根因已修复：`--sync` 的 `BuildLock` 现在覆盖“读取权威源 → 计算派生产物 → diff → 写入/回读”；`write_artifacts` 在 `os.replace`/回读失败时清理 staged `.tmp-build-*.part`。
- 新增 `build-lock` 专项（`tests/test49_content_build_lock.py`，25/25 PASS）；full 由 62 套变为 **63 套**，原有套件全部保留。
- `test23` C17 修复后 20/20 定向采样无 `[0,1]` 异常；但因尚未与其他套件做组合并发验证，矩阵状态维持 `NEED_ISOLATION`，不标记 `PARALLEL_SAFE`。
- 未解决：`--check` / `--dry-run` 保持无锁只读，与 `--sync` 并发时可能读到中间/旧产物；逐文件 `os.replace` 仍不是多文件事务；`_lock_is_stale` 对 `OSError` 的保守性待真实权限异常证据。详见 `BATCH8E3BR_REPORT.md`。

## Task 0：`browser` S12 固定等待窗口（P2，已完成）

- 完成批次：Batch 8E-3A-R；
- 方案：预期版本 core cache（`caches.has`）+ `registration.active === 'activated'` + t1 `controllerchange` 的有界等待（10s），旧缓存清理 5s；
- 证据：`browser` 连续 3 次 37/37；延迟 3s 下旧实现 RED / 新实现 GREEN；全量 61/61。详见 `BATCH8E3AR_REPORT.md`。

## Task 1：端口租约与动态端口（P1，前置）

**目标**：消除固定端口对并行的硬阻塞，不改变任何测试语义。

范围建议：
- 在 `tests/` 侧引入统一端口分配 helper（或允许 `PORT` 由环境变量注入，优先复用已有 `test14` 的 `B3_PORT` 模式）；
- 覆盖 8130–8183 的固定端口套件；冲突组（8136/8142/8146）必须优先；
- 运行器负责在启动前分配空闲端口并通过环境变量传入，测试内保留原有默认值以兼容单独运行；
- 不修改路由、业务数据、SW。

验收：
- 每个固定端口套件单独运行仍 PASS；
- 冲突组在 2 进程并发下均 PASS，无 `EADDRINUSE`；
- 全量串行：8E-3B-1 为 62/62 PASS；8E-3B-R 新增 `build-lock` 后为 63/63（以本批报告为准）；
- 新增端口分配的 fixture 级测试；
- 文档记录“哪些套件已改为可注入端口”。

风险/复杂度：中；涉及多个测试文件与运行器契约，但改动局限于测试基础设施。

### Task 1 执行状态（Batch 8E-3B-1，2026-11-18）

- 基线：`a0157f1`（PR #21 squash 合并）；分支 `perf/batch8e3b1-test-isolation`。
- **已完成**：25 个固定端口测试文件迁移为 OS 动态端口（`listen(0)` + 回写真实端口）；新增 `tests/helpers/port.js`、`tests/helpers/port-fixture-server.js`、`tests/test48_port_isolation.py`（12/12 PASS）；`scripts/run_tests.py` 注册 `port-isolation`，full 由 61 套变为 62 套。
- 冲突组实测：`test11+test20`、`test24+test40`、`test16+performance-accessibility` 串行与双进程并发均 exit 0，无 `EADDRINUSE`；并发实际端口 `54617/54545`（第三组）。组合级 PASS 不等于全局并行安全。
- `test16` 的旧 `test16+test43` 并行证据仍保留；本轮不实现 `--workers`，默认 full 仍串行。
- **C17 诊断**：20 次合成 fixture 采样中 2 次 `[0,1]`；根因是 `diff_artifacts` 在 BuildLock 外读取，与另一进程 `os.replace` 在 Windows 上发生共享冲突。`test23` 标记 `SERIAL_REQUIRED`，待独立修复，详见 `BATCH8E3B1_C17_DIAGNOSTIC.md`。
- 未完成/移交：全局并行安全矩阵仍以组合级证据为主；`tests/batch7c1/publish_scenarios.js` 已迁移但不在 full 注册清单；Task 2（2-worker 调度器）未启动。
- 验收：受影响套件 PASS；新增端口专项 12/12；full 62 套结果见 `BATCH8E3B1_REPORT.md`。

## Task 2：2-worker 调度器（仅已验证安全子集）（P1，依赖 Task 1）

**目标**：把已验证的并行能力产品化，但默认仍串行。

范围建议：
- 运行器新增 `--workers N`（默认 1；N=2 时启用）；
- 只允许 `BATCH8E3A_PARALLEL_MATRIX.csv` 中 `PARALLEL_SAFE` 或经 Task 1 重新验证为安全的套件进入并行池；
- 每个 worker 独立进程、独立日志缓冲；主进程统一汇总 PASS/FAIL/SKIP/BLOCKED；
- 结果必须与串行逐套结果一致（同名套件 exit code、PASS 项数、失败项一致）；
- 任一 worker 超时/失败时，终止其进程树并按现有退出码契约返回；
- 默认 `--workers 1`，CI 命令不变。

验收：
- 选定子集串行 vs 2-worker：结果逐套一致；
- 全量仍默认串行 63/63 PASS；
- 超时/中断/残留进程测试通过；
- 报告中记录实际 wall、各 worker 耗时与并行套件清单。

风险/复杂度：中高；调度、日志聚合、失败传播是主要风险，必须保留串行回退。

### Task 2 执行状态（Batch 8E-3B-2，2026-11-19）

- 基线：`b3f88ed`（PR #23 squash 合并）；分支 `perf/batch8e3b2-parallel-runner`。
- **已完成**：`run_tests.py` 新增 `--workers 1/2`（默认 1）；`workers=2` 只并行“选中顺序相邻 + 精确配对许可”的两个非浏览器套件，其他套件保持独占串行。配对许可为 `test11+test20`、`test24+test40`、`test16+test43`；test16+performance-accessibility 的历史证据不启用，因为本轮所有 Chromium 套件必须独占。
- 新增 `tests/test50_parallel_scheduler.py`（注册名 `parallel-scheduler`，20/20 PASS）；full 由 63 套变为 **64 套**。`runner-infrastructure` 18/18 PASS；默认 `workers=1` 行为保持不变。
- 真实配对实验（同一环境、串行/2-worker 紧邻执行）：`test11+test20` 105.7s→28.9s（3.65x）；`test24+test40` 54.2s→35.7s（1.52x）；`test16+test43` 44.4s→28.2s（1.57x）；三组退出码 0、计数一致。
- 全量回归 `--workers 2`：64 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED，1398.5s；因 full 顺序中没有相邻的已许可配对，实际 peak=1、重叠 0.0s，属于安全回退，不是全量并行加速。测试阶段 1392.6s，套件累计 1392.6s。
- 未完成/限制：配对许可不具传递性；全局并行安全未证明；其他 47 个非浏览器套件仍无并发实测；浏览器套件保持独占。Task 3 可继续做 Chromium 双实例资源实验，但不得把本轮保守结论当成浏览器并行许可。
- 交付：`BATCH8E3B2_REPORT.md`、`BATCH8E3B2_PARALLEL_RESULTS.csv`；矩阵已更新。

## Task 3：浏览器并发资源实验（P2，依赖 Task 1）

**目标**：判断 Chromium 套件能否安全并发，而不是直接启用。

范围建议：
- 选 2 个临时端口浏览器套件（如 `image-lightbox` + `search-interaction`），2-worker 并发；
- 记录 wall、峰值内存、CPU、超时、失败、残留进程；
- 与串行结果逐项对比；
- 若出现资源竞争，记录阈值并停止，不通过“缩短等待/增加重试”掩盖。

验收：
- 至少一组浏览器 2-worker 实验数据；
- 明确结论：可并行 / 需要资源上限 / 必须串行；
- 不修改测试断言与等待时间。

风险/复杂度：中；结论可能为“暂不并行”，这也是有效交付。

## Task 4：耗时基线与报告增强（P3，可与 Task 2 并行文档侧）

**目标**：让后续批次能比较“改造前后”而不是只看单次 wall。

范围建议：
- 保留每次 full 的 JSON 摘要（不入库，写入 `tests/reports/`）；
- 增加可选的 `--history` 输出（套件级耗时 CSV/JSON Lines），便于趋势对比；
- 在报告中固定记录：总 wall、语法/环境、Top 10、超时数；
- 不引入外部依赖，不改变旧字段。

验收：
- 连续两次 full 可生成可比较的套件级耗时；
- 旧 `--report/--json` 调用不变；
- 文档说明字段含义。

风险/复杂度：低。

## 验证门禁（每个任务均适用）

1. 修改文件语法检查（`py_compile` / `node --check`）；
2. 运行器专项 `runner-infrastructure`；
3. 受影响套件单独运行；
4. `git diff --check`；
5. 一次 full（当前 64 套）PASS 64 / FAIL 0 / SKIP 0 / BLOCKED 0；
6. 检查固定端口无监听、无本任务遗留 Chromium/Node 子进程；
7. 不 push、不建 PR、不部署，等待用户审核。

## 明确不做

- 不修改业务代码、UI、CSS、正式内容、路由、稳定 ID、搜索评分、IndexedDB；
- 不修改 SW 缓存策略或 `CACHE_VERSION`；
- 不修改 CI 默认命令与发布工作流；
- 不删除测试、不降低断言标准；
- 不在未验证资源隔离的情况下默认开启并行；
- 不进行全站代码审查或 Lighthouse。

## 推荐顺序与产出

1. Task 1（端口租约）→ 产出端口改造清单与并发验证；
2. Task 2（2-worker 调度器）→ 产出可选 `--workers` 与一致性证据；
3. Task 3（浏览器实验）→ 产出资源结论；
4. Task 4（报告增强）→ 产出趋势基线。

每个任务独立 commit、独立报告；Task 2/3 不得在 Task 1 未通过前启动。

## Batch 8E-3B-3 完成状态（2026-11-19）

- 基线：`f4ebe34`（PR #24 squash 合并）；分支 `perf/batch8e3b3-effective-parallelism`。
- 完成 Task 2 后续的**相邻配对优化**：在 `PAIR_LICENSES` 中新增 11 组非浏览器配对和 2 组 Chromium 配对；`_pair_kind_allowed()` 要求浏览器配对双方均为 browser 且显式 `browser_pair=True`。默认串行和旧命令不变。
- `test50_parallel_scheduler.py` 由 20 项增至 **22/22 PASS**，新增 P3b（显式浏览器配对许可）和 P3c（缺省时浏览器组合仍串行）。
- 真实配对实验：11 组非浏览器全部通过（1.487x–2.919x 表观加速）；2 组浏览器各复测两次均通过（1.621x–1.884x）。
- 全量 `--workers 2`：**64 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED**，wall **1209.7s**，测试阶段 **1200.6s**，套件累计 **1551.4s**，实际重叠 **350.8s**，peak=2，13 个并行单元；对比 8E-3B-2 串行 1398.5s，节省 188.8s（13.5%）。
- 保留边界：只有 13 个精确相邻配对；`test23`、`build-lock`、`runner-infrastructure`、`parallel-scheduler` 和正式内容门禁串行；除两个浏览器配对外的所有浏览器套件独占串行；不实现通用并行池、跨屏障搜索、3+ 并发、自动重试或浏览器池。
- Task 3（浏览器资源实验）已完成有限验证，但只许可 `editor-ux+editor-history` 与 `reading-experience+image-lightbox` 两个精确配对；Task 4（历史趋势工具）未实施，不视为本阶段交付。
- 交付：`BATCH8E3B3_REPORT.md`、`BATCH8E3B3_PARALLEL_RESULTS.csv`、`BATCH8E3_FINAL_SUMMARY.md`；矩阵与计划已更新。
- 状态：**B8E3B3_PR_READY**。本轮结束后不再开启新的调度器优化批次；后续扩大并行需独立资源实验与精确配对证据。
