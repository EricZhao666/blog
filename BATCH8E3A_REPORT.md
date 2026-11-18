# Batch 8E-3A 测试基础设施可靠性与耗时分析报告

- 日期：2026-11-18
- 分支：`perf/batch8e3a-test-infrastructure`
- 基线 commit：`ce27b46`（PR #20 squash 合并）
- 范围：仅测试基础设施（`scripts/run_tests.py`、新增运行器级测试、文档）
- 最终状态：B8E3A_PARTIAL

## 1. 基线

| 项 | 值 |
| --- | --- |
| main 基线 | `ce27b46` `fix: Batch 8E-2 harden inline handler encoding + SW cache bump (#20)` |
| 上一基线 | `8c188b8`（Batch 8D-4，PR #19） |
| 当前分支 | `perf/batch8e3a-test-infrastructure`（从 `ce27b46` 开出） |
| 功能基线 | PR #20 的 CI：PASS 60 / FAIL 0 / SKIP 0 / BLOCKED 0（按用户确认，不在本轮重复全量） |
| 发布状态 | GitHub Pages 已更新；`/blog/sw.js` 返回 `CACHE_VERSION = '2026-11-18-1'`；`/blog/js/app.js` 含 `jsInline` |
| 工作树起点 | 干净，无未提交修改 |

Phase A 已完成合并后确认：远程 main 与本地一致，Batch 8E-2 / 8E-2R 内容完整，线上部署为最新版本。本轮未 push、未创建 PR、未部署。

## 2. 审查与诊断范围

只检查测试基础设施，未读取/修改业务代码、UI、CSS、SW 缓存策略、路由、稳定 ID、搜索评分、正式内容与发布工作流。证据来源：

- `scripts/run_tests.py`（改造前 391 行）与测试清单；
- `tests/reports/last-run.md`（2026-11-18 10:10:01 的历史全量，60 套逐套耗时）；
- `.github/workflows/tests.yml`（CI 入口、20 分钟 job 超时、`PW_CHANNEL=chromium`）；
- `tests/browser/helpers/{server,switch-server,version-server}.js`；
- 对 `tests/` 的定向 grep（固定端口、临时目录、artifacts 文件名）。

`tests/reports/last-run.json` 当时不存在（`tests/reports/` 被 `.gitignore` 忽略），因此历史耗时以 Markdown 报告为唯一基线。

## 3. Phase B：耗时诊断

### 3.1 基线构成

历史全量 60 套：**PASS 60 / FAIL 0 / SKIP 0 / BLOCKED 0**，wall ≈ 22.5 分钟（逐套耗时合计 1343.7s）。

| 类型 | 套件数 | 逐套耗时合计 | 说明 |
| --- | --- | --- | --- |
| jsdom | 24 | 527.5s | 每套独立 Node 进程 + jsdom 初始化 + 本地 HTTP 服务 |
| python | 22 | 247.1s | 每套独立解释器启动 + 临时目录 fixture |
| browser | 14 | 569.1s | 每套启动 Chromium、临时 profile、页面加载与固定等待 |

耗时 Top 10（历史）：

| # | 套件 | 类型 | 耗时 |
| --- | --- | --- | --- |
| 1 | `sw-consistency` | browser | 93.7s |
| 2 | `performance-accessibility` | browser | 61.0s |
| 3 | `papers-deeplink` | browser | 57.9s |
| 4 | `test14` | jsdom | 55.7s |
| 5 | `test35` | jsdom | 47.0s |
| 6 | `ui-refresh` | browser | 45.8s |
| 7 | `mobile-notes` | browser | 45.7s |
| 8 | `test15` | python | 41.1s |
| 9 | `course-seo` | browser | 40.2s |
| 10 | `browser` | browser | 39.8s |

### 3.2 主要耗时来源

1. **串行执行**：61 套依次运行，短套件（0.2–0.6s）也要付出一次进程启动成本。
2. **每套独立进程**：Node 启动 + 模块加载 + jsdom 初始化；Python 解释器启动 + 导入。
3. **14 套 Chromium**：每套 `chromium.launch()`、独立临时 profile、页面加载、SW 安装/激活、固定等待（`sw-consistency` 93.7s 中占比较大）。
4. **Windows 与 Linux CI 差异**：Windows 上 Node/Chromium 进程启动与文件 IO 更慢；CI 为 Linux + `PW_CHANNEL=chromium`，本地为 Windows + `chrome` channel，绝对耗时不可直接横向比较。
5. **日志缓冲**：改造前仅套件结束打印一行，长时间无输出，无法区分“运行慢”与“卡住”。
6. **无并行调度**：所有套件共享墙钟时间，且固定端口使简单并发存在冲突风险。

### 3.3 资源冲突与隔离证据

固定端口（`grep const PORT / server.listen`，均为 CONFIRMED）：

| 端口 | 套件 |
| --- | --- |
| 8130 | `test6` |
| 8131 | `audit` |
| 8132 | `test7` |
| 8133 | `test8` |
| 8134 | `test9` |
| 8135 | `test10` |
| 8136 | `test11`、`test20`（冲突） |
| 8137 | `test14`（`B3_PORT` 可覆盖） |
| 8141 | `test39` |
| 8142 | `test24`、`test40`（冲突） |
| 8143 | `test41` |
| 8144 | `test42` |
| 8145 | `test43` |
| 8146 | `test16`、`performance-accessibility`（冲突） |
| 8147 | `test44` |
| 8148 | `test46` |
| 8151 | `test32` |
| 8161 | `test35` |
| 8181–8183 | `test36`–`test38` |

其余浏览器套件使用 `listen(server, 0)` 临时端口，并各自创建临时 Chromium profile；`tests/browser/artifacts/` 下的证据文件名互不相同（`course-seo.json`、`mobile-notes.json`、`papers-deeplink.json`、`sw-consistency.json`）。Python 套件使用 `tempfile.mkdtemp` 独立目录，未见仓库内共享临时目录。

### 3.4 运行器缺陷（改造前，均为 CONFIRMED 或由代码直接证实）

| 编号 | 缺陷 | 证据 | 影响 |
| --- | --- | --- | --- |
| D1 | 套件级 BLOCKED 不进入汇总 | `run_test` 仅 browser 且 exit 2 记 blocked；`main` 只打印 `len(blocked)`（环境原因字符串数） | `test18` 缺产物 exit 2 被记为 FAIL；BLOCKED 数量失真 |
| D2 | `--only` 与帮助不符 | 帮助写“名称或文件名”，实际只比较 `t['name']` | 文件名/路径无法命中 |
| D3 | node 缺失时 `syntax_checks` 返回结构不一致 | 返回 `False, ['未找到 node…']`；`write_report` 按三元组解包 | 必崩 `ValueError` |
| D4 | 超时只杀直接子进程 | `subprocess.run(timeout=...)` | 孙进程可能残留；无中断清理 |
| D5 | 无可观测进度/耗时 | 仅套件结束一行；无总耗时、分类耗时、Top 慢套件 | 长时间无输出，无法定位瓶颈 |
| D6 | 无功能分组 | 只有 `--only` | 局部调试必须手写名单 |

## 4. Phase C：运行器改造

### 4.1 C1 状态统计与异常处理

- `run_test`：**任意 kind 的 exit 2 均记为 BLOCKED**（浏览器缺 Chromium、`test18` 缺产物等），不再混入 FAIL；结果新增 `kind/timeout/reason`。
- 汇总：`blocked_total = 环境阻塞项 + blocked_tests`；BLOCKED 套件在 Markdown/JSON 中单独列出。
- `--only`：支持注册名、文件名、相对路径，可省略 `.js/.py`；未知 token 列出并 exit 2。
- `syntax_checks`：恒定返回 `(相对路径, True/False/None, [消息])`；node 缺失时 JS 项为 `None`（SKIP），Python 语法检查照常；只有 `False` 计入失败。
- 退出码契约保持不变：0 通过 / 1 失败 / 2 环境阻塞。

### 4.2 C2 进度可观测性

- 套件开始：`[i/N] name (kind) 开始 HH:MM:SS`；
- 套件结束：`[i/N] status 耗时 (项数) 剩余 N desc`；
- 超过 30s 的套件每 30s 一行低频 heartbeat（`HEARTBEAT_SECONDS=30`），不使用高频轮询；
- 汇总打印总耗时、环境/语法耗时、分类耗时、Top 5 慢套件；
- 所有进度行 `flush=True`，避免日志长期缓冲。

### 4.3 C3 子进程生命周期

- 由 `subprocess.run` 改为 `Popen`：
  - Windows：`CREATE_NEW_PROCESS_GROUP`；超时用 `taskkill /PID <pid> /T /F`，只终止该 PID 树；
  - POSIX：`start_new_session=True`；超时 `killpg(SIGTERM)` → 宽限后 `SIGKILL`；
  - `KeyboardInterrupt`：先终止本进程树，再向上抛出；
  - 心跳线程在 `finally` 中停止；
  - 启动失败（`OSError`）返回 125，不再抛出。
- **不按进程名批量终止** Node/Python/Chromium；无法确定归属时只记录限制。

### 4.4 C4 功能分组

新增 `--group {smoke,editor,search,content,sw,browser,full}` 与 `--list-groups`：

| 分组 | 套件数 | 用途 |
| --- | --- | --- |
| smoke | 9 | 核心冒烟 |
| editor | 11 | 编辑器/草稿/导出 |
| search | 8 | 搜索/筛选/历史 |
| content | 23 | 内容构建、发布门禁、数据生命周期 |
| sw | 4 | SW 缓存/离线/升级 |
| browser | 14 | 真实 Chromium |
| full | 61 | 完整回归（默认） |

分组是**开发辅助**，不代表发布验收；CI 默认仍为 full，本轮未修改 CI 配置。

### 4.5 C5 耗时报告

- Markdown 新增：总 wall-clock、环境准备、语法检查、分类耗时、Top 10 最慢、超时原因、阻塞用例；
- JSON 新增：`wall_seconds/env_seconds/syntax_seconds/by_kind/slowest/timeouts/blocked_tests/blocked_total/group/selection`；
- **旧字段全部保留**（`started/verdict/pass/fail/skip/blocked/syntax/results`），旧调用方式不变；
- 使用 `time.monotonic()` 计算 wall（避免系统时钟跳变）。

## 5. 验证结果

| 检查 | 结果 |
| --- | --- |
| `py_compile`（`run_tests.py`、`test47_runner_infrastructure.py`） | PASS |
| 新增运行器专项 `tests/test47_runner_infrastructure.py` | **18/18 PASS**，6.7s（独立执行） |
| 真实入口 `--only runner-infrastructure` | **1/1 PASS**，13.1s（语法 6.4s） |
| `--group smoke` | **9/9 PASS**，113.7s（语法 5.5s） |
| `git diff --check` | 通过 |
| 全量回归（旧 60 + 新增 1） | **60 PASS / 1 FAIL / 0 SKIP / 0 BLOCKED**，wall 1270.4s；唯一失败为 `browser` S12（36/37） |
| `browser` 定向复现（仅该套件） | **37/37 PASS**，42.6s，S12 未复现 |

`test47` 覆盖：分组/选择（G1–G3）、正常路径与新旧 JSON 字段（R1–R4）、文件名匹配（R5）、未知用例 exit 2（R6）、BLOCKED 汇总（R7）、失败 exit 1（R8）、超时记录（R9）、**超时后孙进程清理（R10，真实 Python 子进程树）**、`KeyboardInterrupt` 清理（R11，模拟 Popen）、node 缺失三态（R12）、报告 SKIP 不崩溃（R13）、环境阻塞 SKIP=套件数（R14）、`--list-groups`（R15）。

运行器专项使用临时 fixture，不启动 Chromium；测试结束后临时目录由系统临时目录管理，不写入仓库。

## 6. Phase D：并行可行性验证

### 6.1 实验设计

选择 `test16`（固定 8146，14.6s 历史）+ `test43`（临时端口 8145，20.4s 历史），先串行、再 2 进程并发，各记录 exit code、PASS 项数与耗时。实验前确认 8146 空闲；不修改任一测试，不删除断言。

### 6.2 实测结果（Windows，8 核 / 16.6GB，2026-11-18）

| 模式 | wall | test16 | test43 | 结果一致性 |
| --- | --- | --- | --- | --- |
| 串行 | 38.3s | 14.7s，20/20 PASS | 23.6s，40/40 PASS | 基准 |
| 2 进程并发 | **24.3s** | 14.7s，20/20 PASS | 24.3s，40/40 PASS | 完全一致 |

- wall 降低 14.0s（约 36.6%），相对串行加速 1.58×；
- 理论下界为 `max(14.7, 23.6)=23.6s`，实测 24.3s 接近该下界；
- 两组端口不冲突（8146 固定 + 8145 临时），无失败、无 SKIP、无 BLOCKED，退出后端口释放；
- **结论仅适用于该已验证组合**，不能外推到全部 61 套。

### 6.3 并行矩阵

`BATCH8E3A_PARALLEL_MATRIX.csv` 共 61 行：

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| PARALLEL_SAFE | 1 | `test43`：仅证明与 `test16` 的 2 进程组合安全 |
| NEED_ISOLATION | 22 | 固定端口套件；其中 8136、8142、8146 为已证实冲突 |
| UNKNOWN | 38 | 临时端口/临时目录，理论低冲突，但无并发实测证据 |
| SERIAL_REQUIRED | 0 | 未发现已证实的强制串行套件 |

未把任何“理论无冲突”的套件归入 PARALLEL_SAFE；浏览器套件（Chromium 资源竞争）与 Python 套件（共享只读仓库内容）均保持 UNKNOWN。

### 6.4 并行结论

- 本轮**不启用默认并行**，CI 与本地默认仍为串行 full；
- 已验证 2-worker 对特定组合有 1.58× 实测收益；
- 固定端口是首要阻塞：至少 3 组端口冲突，需先做端口租约/动态分配；
- 浏览器并发需单独验证 CPU/内存、超时、残留进程与结果一致性，留给 Batch 8E-3B。

## 7. 性能收益评估（区分证据等级）

| 等级 | 内容 |
| --- | --- |
| 实测收益 | `test16 + test43` 2 进程：38.3s → 24.3s（−14.0s，1.58×）；结果完全一致 |
| 实测开销 | 新增 `test47` 在专项运行中 6.7s；全量中预计增加约 7–13s（含其内部语法扫描），相对 22.5 分钟基线 <1% |
| 理论收益 | 若仅对已证实无端口冲突的轻量套件启用 2 workers，按 Amdahl 上限可压缩部分 wall；未做全量估算 |
| 待验证假设 | 固定端口改租约后 2-worker 全量收益；浏览器 2-worker 的资源上限；Python 套件并发一致性；Windows 与 Linux CI 差异 |

本轮不声称“全量可安全并行”，也不声称“已实现全量加速”。

## 8. 合规与未修改项

- 未修改业务代码、UI、CSS、正式内容、路由、稳定 ID、搜索评分、IndexedDB、导入/构建脚本；
- 未修改 `sw.js`、`CACHE_VERSION`、SW 导航/缓存策略；
- 未修改 `.github/workflows/tests.yml`，CI 默认仍执行完整 `python scripts/run_tests.py`；
- 未删除任何原有测试，未降低断言标准；
- 未运行 Lighthouse，未重复全站 UI/可访问性审查；
- 未 push、未创建 PR、未合并、未部署。

## 9. 未完成检查及原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 全量并行调度实现 | 未做 | 明确留给 Batch 8E-3B；本轮只做可行性验证 |
| 浏览器 2-worker 实验 | 未做 | 需单独评估 Chromium 资源与超时，避免与端口租约混杂 |
| 全量多次采样/统计分布 | 未做 | 单次全量已 20+ 分钟，遵循 60 分钟预算；历史报告提供基线 |
| 内存/CPU 采样 | 未做 | 无轻量采集设施，避免引入无关依赖 |
| CI 上运行新增测试 | 未做 | 未 push；本地已验证，CI 配置未改 |
| 8E-1 全部历史问题复查 | 未做 | 超出本轮范围；仅验证测试基础设施不回归 |

## 10. 残留进程与工作树

- 全量回归与定向复现结束后检查固定端口 8130–8183 均无监听，未发现本任务遗留 Node/Chromium 子进程；
- 本任务启动的临时探测脚本仅存放在 agent 工作区，未入库；
- Git 工作树最终状态：提交后 clean（commit 仅含 `scripts/run_tests.py`、`tests/test47_runner_infrastructure.py` 与四份 8E-3A 文档）。

## 11. 全量回归中的唯一失败（`browser` S12）

- 现象：`browser` 套件 36/37；`S12 新版本在第二个标签页安装并生效` 失败，断言时的 cache 列表为 `blog-2026-11-18-1,blog-rt-2026-11-18-1`，缺少 `-t2` 新缓存。
- 同一 S12 后续检查均通过：旧版本缓存被清理、旧标签页被新 SW 接管且页面未崩溃。
- 定向复现：同一代码、同一环境单独运行 `browser` 套件 **37/37 PASS**（42.6s），S12 未复现。
- 归因：HYPOTHESIS —— 全量运行后段系统负载下，S12 固定 `2500ms` 等待窗口偏紧；不是运行器改造直接引入（本轮未修改 SW、业务代码或该测试）。
- 未处理：按本轮范围禁止修改断言/等待时间，未改该测试；建议在后续独立批次中以确定性事件（而非固定 sleep）修复，并保留串行基线。
- 证据：`tests/reports/last-run.json`（`browser` 的 `fails/tail`）、`tests/reports/b8e3a-browser-rerun.md` / `.json`（均被 `.gitignore` 忽略，仅本地留存）。

## 12. 结论

- 测试运行器已具备：正确 BLOCKED 汇总、三态语法检查、进程树超时清理、进度/耗时可观测、功能分组、兼容旧报告字段；
- 新增 18 项运行器回归，覆盖异常路径与真实进程树清理，且在 full 中 18/18 通过；
- 2-worker 对已验证组合有 1.58× 收益，但全量并行仍被固定端口与未验证资源竞争阻塞；
- 未发现需要修改业务代码的问题；本轮只改测试基础设施；
- 全量门禁为 60 PASS / 1 FAIL（`browser` S12 时序性失败，定向复现 37/37 未复现），因此不声称 61/61 全绿。

**最终状态：B8E3A_PARTIAL**（基础设施改造完成并验证；全量门禁存在 1 个未复现的时序性失败）
