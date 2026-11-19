# Batch 8E-3B-3 报告：实际全量并行加速与测试基础设施收尾

- 状态：**B8E3B3_PR_READY**（本地验收完成；PR #25 已创建，等待默认串行 CI 与人工审核）
- 基线：`origin/main = f4ebe34`（PR #24 squash 合并，`perf(test): add opt-in safe two-worker scheduler`）
- 分支：`perf/batch8e3b3-effective-parallelism`
- 本地提交：`1475031`（PR #25：https://github.com/EricZhao666/blog/pull/25）
- 本轮范围：只扩展已验证的**相邻精确配对**，并完成 8E-3 阶段收尾；默认仍为串行，不实现通用并行池、跨屏障搜索、3+ 并发或任意浏览器并发。

## 1. 变更摘要

修改文件仅两个：

- `scripts/run_tests.py`
  - 扩展 `PAIR_LICENSES`，加入 11 组非浏览器相邻配对和 2 组浏览器相邻配对；
  - 新增 `_pair_kind_allowed()`：含浏览器套件的组合，必须双方都是 `browser` 且许可显式标记 `browser_pair=True`；
  - 继续保留“选中顺序相邻 + 精确许可 + 显式串行屏障 + `TEST_PORT`/`B3_PORT` 冲突回退”的约束；
  - 默认 `workers=1`、旧命令、测试注册顺序、报告顺序均未改变。
- `tests/test50_parallel_scheduler.py`
  - 增加第二个浏览器 fixture 和浏览器配对许可测试（P3b/P3c）；
  - 现为 **22/22 PASS**（原 20 项 + 2 项浏览器许可边界）。

未修改：业务代码、UI/CSS、路由、正式内容、`sw.js`、`CACHE_VERSION`、生产内容构建器、CI/发布工作流、测试断言标准。

## 2. 已验证配对许可

### 2.1 非浏览器相邻配对（11 组，均通过）

同一代码、同一环境的串行与 2-worker 对照；下表为 `BATCH8E3B3_PARALLEL_RESULTS.csv` 的原始结果。

| 配对 | 串行 wall | 2-worker wall | 加速比 | 结果与断言 | 并行重叠 |
| --- | ---: | ---: | ---: | --- | ---: |
| `audit + test6` | 110.581s | 37.888s | 2.919x | exit 0/0；两套均无聚合计数 | 29.435s |
| `test8 + test9` | 54.395s | 29.970s | 1.815x | exit 0/0；均无聚合计数 | 22.013s |
| `test10 + test11` | 50.026s | 26.507s | 1.887x | exit 0/0；均无聚合计数 | 22.050s |
| `test14 + test15` | 151.110s | 91.873s | 1.645x | exit 0/0；`test15` 32/32 | 70.469s |
| `test16 + test17` | 68.695s | 46.203s | 1.487x | 20/20、11/11；exit 0/0 | 24.198s |
| `test25 + test26` | 49.818s | 24.292s | 2.051x | 13/13、21/21；exit 0/0 | 21.641s |
| `test32 + test33` | 39.827s | 25.027s | 1.591x | 42/42、68/68；exit 0/0 | 22.577s |
| `test34 + test35` | 39.970s | 26.576s | 1.504x | 67/67、78/78；exit 0/0 | 16.493s |
| `test37 + test38` | 43.544s | 26.184s | 1.663x | 66/66、59/59；exit 0/0 | 21.439s |
| `test40 + test41` | 52.023s | 33.497s | 1.553x | 35/35、44/44；exit 0/0 | 22.227s |
| `test42 + test43` | 56.329s | 31.118s | 1.810x | 29/29、40/40；exit 0/0 | 28.927s |

说明：

- `audit` 在单独 `--only` 运行时的耗时明显高于全量中的历史值，因此 `2.919x` 只是该次配对实验的表观加速比，不作为全量收益推算依据。
- `test14 + test15` 实验期间最低可用内存约 **305.8 MB**、内存负载最高 **98%**；结果通过，但这是明确的资源压力限制，不能推广为“任意两个长 Python 套件都可以并发”。

### 2.2 Chromium 精确配对（2 组，各复测两次）

| 配对 | 轮次 | 串行 wall | 并发 wall | 加速比 | 结果 | 最低可用内存 / 内存负载 | CPU 峰值 |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: |
| `editor-ux + editor-history` | run1 | 52.069s | 28.831s | 1.806x | 66/66、39/39 | 706.6MB / 95% | 98.8% |
| `editor-ux + editor-history` | run2 | 50.083s | 26.588s | 1.884x | 66/66、39/39 | 710.4MB / 95% | 95.8% |
| `reading-experience + image-lightbox` | run1 | 48.911s | 30.182s | 1.621x | 47/47、34/34 | 1127.5MB / 92% | 97.2% |
| `reading-experience + image-lightbox` | run2 | 46.895s | 27.957s | 1.677x | 47/47、34/34 | 735.0MB / 95% | 79.7% |

两组均使用独立 Chromium 进程、独立 `BrowserContext`、动态测试端口，四次实验均无残留活动进程。由于内存和 CPU 峰值较高，只允许这两个精确配对在显式 `--workers 2` 下并发，不能推广为任意浏览器并发。

## 3. 全量执行计划与实际结果

### 3.1 计划

在当前 64 套注册顺序下，`workers=2` 的计划为：

- 并行单元：**13 个**
- 串行套件：**38 个**
- 总执行单元：**51 个**
- 配对：11 组非浏览器 + 2 组浏览器
- 实际峰值：**2**

按 `b8e3b2-full.json` 的历史逐套耗时理论估算，可节省 **275.9s**，测试阶段 1392.6s → 约 1116.7s（约 19.8%）。这是估算，不是实际结果。

### 3.2 实际 `--workers 2` 全量回归

命令：

```powershell
python scripts/run_tests.py --workers 2 --json tests/reports/b8e3b3-full.json
```

结果：

- **64 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED**；`verdict: PASS`
- 总 wall：**1209.7s**（环境 0.6s；语法 8.5s）
- 测试阶段 wall：**1200.6s**
- 套件累计：**1551.4s**
- 实际并行重叠：**350.8s**
- `effective_workers`：**2**
- `peak_active_suites`：**2**
- `parallel_pairs`：13 组（非空）
- `serial_suites`：38
- `interrupted`：false；`timeouts`：空

对比 `b8e3b2-full.json` 的串行基线 `1398.5s`：

- wall 节省 **188.8s**，约 **13.5%**
- 测试阶段节省约 **192.0s**，约 **13.8%**
- 但本次运行中套件累计时间比旧基线多约 **158.8s**（受宿主负载影响），说明实际 wall 收益被负载部分抵消；不能把它当作严格同负载 A/B
- 两组 Chromium 配对在全量中实际形成重叠：`editor-ux 22.9s + editor-history 25.2s`；`reading-experience 27.6s + image-lightbox 20.4s`
- 13 组配对全部通过，无跨测试数据污染证据

性能结论：

- 明确了“13 个真实并行单元、350.8s 重叠、13.5% wall 降幅”的全量结果，达到本轮 10%–20% 目标的低端；
- 不声称已达到 15 分钟目标；实际值仍明显高于 15 分钟；
- 配对实验是主要性能证据，全量数字受宿主负载影响，仅作本轮实际运行记录。

### 3.3 首次全量运行被宿主中断的记录

第一次启动全量后台任务后，宿主任务管理器在 `54/64`（`mobile-notes` 开始附近）将任务终止，未写出 JSON；这是执行环境中断，不是测试断言失败。随后改用独立 `Start-Process` 启动同一命令与同一代码，输出到 `tests/reports/b8e3b3-full-run2.log`，第二次完整运行成功。报告不把该中断隐藏为“测试稳定通过”，也不把重复运行当作自动重试机制。

## 4. 调度器与中断边界

`tests/test50_parallel_scheduler.py` 当前 **22/22 PASS**，覆盖：

- 默认 `workers=1` 与旧命令兼容；
- `workers=2` 实际启动两个安全任务；
- 未验证组合不并行；
- 独占串行任务不重叠；
- `--only` / `--group` 选择正确，每套只执行一次；
- 完成顺序变化不影响报告顺序；
- 单任务失败不遗漏剩余任务；
- `BLOCKED` / `FAIL` 汇总；
- 一个任务超时不影响另一个任务结果；
- 两个并行任务产生真实孙进程时，超时清理完整；
- 主线程 Ctrl+C 时清理全部活动进程树（真实子进程树，不是仅 mock）；
- 非法 `workers` 参数拒绝；
- `TEST_PORT` 显式配置导致配对安全回退；
- 浏览器精确配对许可与缺少 `browser_pair` 时仍串行。

全量结束后检查：

- 运行器 Python/Node 进程：**0**
- 含测试 Profile/测试目录特征的 Chromium 进程：**0**
- 浏览器配对实验 `residual_active_procs`：**0**
- 系统用户自己的 Chrome/Edge 进程未计入，也未终止。

## 5. 保留串行与未验证范围

默认 `workers=1` 时 64 套全部串行。`workers=2` 时仍保持：

- 显式串行屏障：`test23`、`build-lock`、`runner-infrastructure`、`parallel-scheduler`、`content-check`、`feed-check`、`image-check`；
- 未获得精确许可的非浏览器套件：串行；
- 12 个未获浏览器配对的浏览器套件：独占串行；
- 两个已许可浏览器配对：仅在显式 `--workers 2` 下并行，默认仍独占。

旧许可 `test11+test20`、`test24+test40`、`test16+test43` 仍保留在代码中，但当前 full 顺序中不形成相邻重叠；因此本轮实际全量只使用 13 组新的相邻配对。组合级安全不具传递性。

## 6. 未解决风险

1. **全局并行安全未证明**：13 个精确配对之外仍是 UNKNOWN/串行；不能因为配对通过就推断任意两个套件安全。
2. **资源压力**：`test14+test15` 最低 305.8MB 可用内存；浏览器配对最低约 700–1127MB、CPU 95–99%。全量在宿主负载较高时通过，但资源余量有限。
3. **浏览器仅两个精确配对**：没有任意浏览器并发许可；`sw-consistency`、`sw-upgrade`、严格性能计时套件仍不参与浏览器并发实验。
4. **逐文件原子替换不是多文件事务**（继承 8E-3B-R）：C17 构建锁已覆盖 sync 临界区，但 `--check` / `--dry-run` 的只读契约与并发写仍有已知边界。
5. **性能数据受环境影响**：1398.5s、1616.6s、1239.9s 和本轮 1209.7s 不是严格同环境 A/B；PR CI 的串行完整回归用于兼容性，不用于性能比较。

## 7. 兼容性与后续

已保留：

```powershell
python scripts/run_tests.py
python scripts/run_tests.py --workers 1
python scripts/run_tests.py --group smoke --workers 2
python scripts/run_tests.py --only test11 test20 --workers 2
python scripts/run_tests.py --workers 2 --json tests/reports/parallel.json
```

`--workers` 仅接受 1 或 2；其他值拒绝。默认 CI 命令不变，由 PR 的默认串行 CI 做最终兼容性验收。

下一步：push 分支并创建 PR；等待 CI 与人工审核，不自动合并、不部署、不进入新的调度器优化批次。
