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
- 全量串行 61/61 PASS；
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
- 全量仍默认串行 61/61 PASS；
- 超时/中断/残留进程测试通过；
- 报告中记录实际 wall、各 worker 耗时与并行套件清单。

风险/复杂度：中高；调度、日志聚合、失败传播是主要风险，必须保留串行回退。

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
5. 一次 full（61 套）PASS 61 / FAIL 0 / SKIP 0 / BLOCKED 0；
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
