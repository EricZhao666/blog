# Batch 8E-3B-2 报告：可选安全双进程测试调度器

## 1. 状态与基线

- 最终状态：**B8E3B2_PR_READY**（PR #24 已创建；GitHub CI 已独立确认 64/64 PASS）。
- 正式基线：`b3f88ed`（PR #23 squash 合并，`fix(content): protect full sync lifecycle with build lock (#23)`）。
- 工作分支：`perf/batch8e3b2-parallel-runner`；PR：https://github.com/EricZhao666/blog/pull/24。
- 上游 8E-3B-R 已完成 C17 修复；本批不修改 `scripts/build_content.py`、业务代码、UI/CSS、正式内容、SW、CACHE_VERSION、CI 或发布工作流。
- 本批只实现 `BATCH8E3B_NEXT_PLAN.md` 的 Task 2，不启动 Task 3 的 Chromium 双实例实验。

## 2. 调度器架构

`scripts/run_tests.py` 新增可选参数：

```text
python scripts/run_tests.py                    # 默认 workers=1，完全串行
python scripts/run_tests.py --workers 1
python scripts/run_tests.py --workers 2
python scripts/run_tests.py --group smoke --workers 2
python scripts/run_tests.py --only test11 test20 --workers 2
python scripts/run_tests.py --workers 2 --json tests/reports/parallel.json
```

实现要点：

1. **默认路径不变**：`workers=1` 走原有逐套串行循环；旧命令、旧报告字段、旧退出码保持兼容。
2. **精确配对许可**：`workers=2` 只接受本批已实测的非浏览器配对，且要求两个套件在**选中顺序中相邻**。不是“所有 jsdom/Python 都可以并行”，也不是无条件并行池。
3. **独占串行屏障**：浏览器套件、`test23`、`build-lock`、`runner-infrastructure`、当前内容门禁等不会进入并行单元；没有相邻许可时安全回退为串行，不遗漏套件。
4. **单实例约束**：每个选中套件恰好执行一次；不运行同一套件的多个实例；不增加自动重试。
5. **主线程汇总**：并行单元最多两个独立外部测试进程；主线程是唯一汇总者，结果最终按注册顺序排列；完成顺序可以不同。
6. **中断清理**：主线程捕获 Ctrl+C 后终止本运行器登记的活动进程树；Windows 先枚举明确后代 PID，再 `taskkill /PID <pid> /T /F`，并补杀被孤儿化的后代；不按进程名批量终止。POSIX 使用独立进程组的 `killpg`。
7. **报告字段**：新增 `requested_workers`、`effective_workers`、`parallel_pairs`、`serial_suites`、`serial_fallback_reasons`、`suite_execution_order`、`peak_active_suites`、`summed_suite_seconds`、`test_wall_seconds`、`parallel_overlap_seconds`、`parallel_intervals`、`interrupted`、`interrupted_count`；保留原有字段。

### 2.1 配对许可清单

| 配对 | 依据 | 本批是否启用 |
| --- | --- | --- |
| `test11 + test20` | B8E3B1 隔离实验；B8E3B2 串行/2-worker 同一环境复测 | 是 |
| `test24 + test40` | B8E3B1 隔离实验；B8E3B2 复测 | 是 |
| `test16 + test43` | B8E3A/B8E3B1 历史配对；B8E3B2 复测 | 是 |
| `test16 + performance-accessibility` | 历史组合证据 | **否**：`performance-accessibility` 是 Chromium 套件，本轮明确独占串行 |

组合级证据不具有传递性。`test11` 与 `test20` 可并行，不代表 `test11` 与任何其他套件可并行；本批未把任何单套件标记为全局 `PARALLEL_SAFE`。

## 3. 专项测试

新增 `tests/test50_parallel_scheduler.py`（注册名 `parallel-scheduler`），20/20 PASS。覆盖：

- 默认 `workers=1` 兼容；
- 精确配对单元与相邻约束；
- 未验证组合不并行；
- 浏览器/独占套件不重叠；
- `--only` / `--group` 选择；
- 每套件一次、结果顺序不受完成顺序影响；
- 失败后继续剩余任务；
- BLOCKED / FAIL 汇总；
- 一个任务超时、另一个任务结果保留；
- 两个并行孙进程树清理；
- 主线程中断后清理两个活动进程树；
- 非法 workers 拒绝；
- 显式 `TEST_PORT` 安全回退；
- 无重复结果、无活动进程残留。

轻量 fixture 优先，不启动真实 Chromium；进程清理用例使用真实 Python 子进程和孙进程，不以模拟函数替代。

## 4. 真实配对性能实验

同一环境、同一代码、串行与 2-worker 紧邻执行；日志在 `tests/reports/b8e3b2-pairs/`。`test_wall_seconds` 为测试阶段单调时钟 wall，不含环境/语法检查。

| 配对 | 串行 wall | 2-worker wall | 加速比 | 串行/并行结果 | 重叠 |
| --- | ---: | ---: | ---: | --- | ---: |
| `test11 + test20` | 105.7s | 28.9s | 3.65x | exit 0 / 0；test20 24/24；test11 无 `共 N 项` 汇总但 exit 0 | 27.8s |
| `test24 + test40` | 54.2s | 35.7s | 1.52x | 22/22、35/35；exit 0 / 0 | 19.3s |
| `test16 + test43` | 44.4s | 28.2s | 1.57x | 20/20、40/40；exit 0 / 0 | 18.4s |

说明：

- 三组都同时满足 `PASS 2 / FAIL 0 / SKIP 0 / BLOCKED 0`；日志中未出现 `EADDRINUSE`。
- `test11` 当前输出不打印 `共 N 项`，因此运行器计数为 `n/a`，不能伪造为有计数的 19/19；其 exit 0 与 test20 24/24 均保留。
- 这是单次配对采样，不是统计证明；不把 3.65x 当作所有配对的普遍收益。
- CPU/内存未做低成本采样，不能据此断言资源余量；本轮只证明三组指定配对的串行/并行一致性。

## 5. 全量回归

命令：

```text
python scripts/run_tests.py --workers 2 --json tests/reports/b8e3b2-full.json
```

结果：

- **PASS 64 / FAIL 0 / SKIP 0 / BLOCKED 0**；结论 PASS。
- 总 wall：**1398.5s**（环境 0.5s / 语法 5.3s）；测试阶段 1392.6s；套件累计 1392.6s；**并行重叠 0.0s**。
- `requested_workers=2`，`effective_workers=1`，`peak_active_suites=1`，`parallel_pairs=[]`。
- 串行回退原因：`no_verified_adjacent_pair` 47 套、`browser_exclusive` 14 套、`explicit_serial` 3 套。
- 套件总数由 63 增至 **64**：新增 `parallel-scheduler`，原有 63 套全部保留且全部 PASS。
- 历史 8E-3B-1 1239.9s、8E-3B-R 1616.6s 属于不同批次/系统负载，不能作为严格 A/B；本批全量在原命令默认范围上增加了一个专项，且当前系统负载下没有相邻许可配对，因此没有全量并行加速。
- 全量 2-worker 的 0.0s 重叠是**安全回退结果**，不是并行收益；实际并行覆盖率为 0/64。真实配对收益只存在于第 4 节的定向实验。

## 6. 兼容性与默认行为

- 默认 `python scripts/run_tests.py` 仍是 `workers=1`、full、串行；CI 默认命令无需修改，本批未改 CI/发布工作流。
- `--only`、`--group`、`--list-groups`、`--skip-syntax`、`--report`、`--json` 保持可用。
- 非法 `--workers 0/3/abc` 由 argparse 拒绝并返回 2。
- `TEST_PORT` / `B3_PORT` 等显式共享端口环境存在时，配对许可禁用并安全回退串行；测试不会为了并行而覆盖用户的显式端口设置。
- 原有 BLOCKED（exit 2）、FAIL（exit 1）、PASS（exit 0）退出码优先级保持不变；新增中断路径返回 130 并生成 `INTERRUPTED` 结果。

## 7. 失败与清理证据

- `parallel-scheduler`：20/20；`runner-infrastructure`：18/18。
- 专项用例验证：
  - 一个任务超时时，另一个并行任务仍保留 PASS 结果；
  - 两个并行 fixture 的孙进程在超时后均不存活；
  - 主线程中断时两个活动进程树均被清理；
  - 结束后本运行器活动表为空（正常退出路径）。
- 全量回归结束后未发现本任务残留的 Node/Chromium 子进程；最终工作树与分支状态见第 9 节。

## 8. 未解决风险与剩余潜力

1. **全局并行安全未证明**：只有 3 个精确配对；不能把 `workers=2` 理解为全站并行。
2. **全量顺序无相邻配对**：当前 full 的 3 个许可配对都被未许可套件隔开；调度器选择不跨越屏障，因此 full 2-worker 实际串行。要提升 full 覆盖，需新增相邻配对并重新取得串行/并行一致性证据，而不是放宽顺序或屏障。
3. **Chromium 独占**：14 个浏览器套件本轮全部串行；CPU/内存竞争未量化，留给 Task 3。
4. **内容构建锁**：`test23`、`build-lock` 仍为独占串行；C17 的修复不改变其全局并行候选身份。
5. **中断测试的边界**：进程清理使用明确的 PID/后代枚举，不覆盖所有可能的进程创建竞态；若未来出现无法归属的进程，应停止扩大并行范围并记录限制。
6. **性能结论有限**：配对实验是单次采样；全量 0 重叠，不能声称“已实现全量加速”。

## 9. 交付物与提交

新增/修改：

- `scripts/run_tests.py`：`--workers`、配对许可、报告字段、进程树清理、专项注册；
- `tests/test50_parallel_scheduler.py`：20 项调度器专项；
- `BATCH8E3B2_REPORT.md`（本文件）；
- `BATCH8E3B2_PARALLEL_RESULTS.csv`；
- `BATCH8E3A_PARALLEL_MATRIX.csv`：64 行，新增 `parallel-scheduler`，更新配对/浏览器/门禁状态；
- `BATCH8E3B_NEXT_PLAN.md`：Task 2 状态与 64 套基线更新。

计划提交信息：`perf(test): add opt-in safe two-worker scheduler`。提交后 push 并创建 PR，由默认串行 GitHub CI 完成最终验证；不自动合并、不部署、不进入 Task 3。

## 10. PR 与 GitHub CI 结果

- PR：**#24**，`perf(test): add opt-in safe two-worker scheduler` → `main`。
- 分支包含两个提交：
  - `7f8a714 perf(test): add opt-in safe two-worker scheduler`；
  - `26cb12c test: isolate scheduler interrupt fixture process groups`。
- 第一次 CI（`7f8a714`）唯一失败为 `parallel-scheduler` **exit -15**：Linux 上 P16 fixture 由 `subprocess.Popen` 直接创建，与测试进程同组，`killpg` 误向测试自身发送 SIGTERM。修复方式是让 fixture 在 POSIX 使用 `start_new_session=True`、Windows 使用 `CREATE_NEW_PROCESS_GROUP`，与调度器实际子进程启动方式一致；本地重跑专项 **20/20 PASS**。
- 第二次 CI（`26cb12c`）：
  - `tests #84`（push）：**PASS 64 / FAIL 0 / SKIP 0 / BLOCKED 0**，总耗时 **572.2s**（环境 0.1s / 语法 1.0s），测试阶段 571.1s，并行重叠 0.0s；`parallel-scheduler` 20/20。
  - `content-gate #19`（pull_request）：**PASS**，13s。
- CI 使用默认 `python scripts/run_tests.py`（`workers=1`），未使用 `--workers 2`，因此 CI 验证的是旧命令兼容性；并发配对收益只在本报告第 4 节的定向实验中有实测证据。
- PR 保持 Open，不自动合并、不部署。

