# Batch 8E-3 最终总结：测试基础设施收尾

- 阶段状态：**B8E3B3_PR_READY**（本轮 PR 等待默认串行 CI 与人工审核）
- 覆盖范围：Batch 8E-3A / 8E-3A-R / 8E-3B-1 / 8E-3B-R / 8E-3B-2 / 8E-3B-3
- 原则：默认串行不变；并行是显式 opt-in，只对已验证的精确配对生效；不以牺牲测试语义换取性能。

## 1. 阶段成果

### 1.1 运行器可靠性

- 统一运行器的选择、汇总、超时、报告和进程树清理契约；
- `runner-infrastructure` 专项 18/18；
- S12 `browser` 固定等待改为状态驱动，连续 3 次 37/37；
- 中断时主线程负责清理本运行器登记的活动进程树，避免 worker 线程无法接收 KeyboardInterrupt 的盲区。

### 1.2 动态端口

- 25 个测试文件迁移为 OS 动态端口（`server.listen(0)` + `server.address().port`），客户端在监听成功后使用真实端口；
- 保留原有 `TEST_PORT` / `B3_PORT` 显式覆盖能力；
- 固定端口冲突组 `8136`、`8142`、`8146` 已解除；
- 新增 `port-isolation` 专项 12/12；全量注册由 61 增至 62；
- 重要边界：固定端口消除不等于套件具备完整并行安全，仍须逐对验证。

### 1.3 C17 内容构建并发缺陷

- 根因：`diff_artifacts` 在 `BuildLock` 外读取，与另一进程锁内的 `os.replace` 在 Windows 上发生竞争；
- 修复：`--sync` 的 `BuildLock` 覆盖“读取权威源 → 计算派生产物 → diff → 写入/回读”完整临界区；
- `write_artifacts` 在 `os.replace` / 回读失败时清理 staged 临时文件；
- `test23` 41/41；`build-lock` 专项 25/25；20 次定向并发采样无非预期异常；
- 明确未解决：逐文件原子替换不是多文件事务；`--check` / `--dry-run` 保持只读契约，与并发 `--sync` 的边界已记录，不擅自改变门禁行为。

### 1.4 可选调度器

- 默认 `workers=1`，旧命令完全兼容；
- `workers=2` 只允许选中顺序相邻、存在精确许可的两个套件；
- 支持显式串行屏障、`TEST_PORT`/`B3_PORT` 冲突安全回退、每套恰好执行一次、主线程统一汇总；
- 不允许跨屏障搜索、不运行同套件多实例、不自动重试、不允许 3+ 并发；
- 结果按注册顺序输出；报告包含 `requested_workers`、`effective_workers`、`parallel_pairs`、`serial_suites`、`peak_active_suites`、`parallel_overlap_seconds`、wall 与累计套件时间。

## 2. 最终实际性能

本地最终命令：

```powershell
python scripts/run_tests.py --workers 2 --json tests/reports/b8e3b3-full.json
```

最终结果：

- 64 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED
- 13 个并行单元，38 个串行套件，51 个执行单元
- `effective_workers=2`，`peak_active_suites=2`
- 实际重叠 **350.8s**
- 总 wall **1209.7s**
- 测试阶段 wall **1200.6s**
- 套件累计 **1551.4s**
- 对比 8E-3B-2 串行 full `1398.5s`：节省 **188.8s（13.5%）**
- 两组浏览器配对在全量中实际形成重叠，13 组配对全部通过

历史耗时仅作趋势参考，不是严格同环境 A/B：

| 批次 | 套数 | 模式 | 本地 wall |
| --- | ---: | --- | ---: |
| 8E-3A | 61 | 串行 | 1270.4s |
| 8E-3B-1 | 62 | 串行 | 1239.9s |
| 8E-3B-R | 63 | 串行 | 1616.6s |
| 8E-3B-2 | 64 | `--workers 2`，实际无配对 | 1398.5s |
| 8E-3B-3 | 64 | `--workers 2`，13 配对 | **1209.7s** |
| PR #24 CI | 64 | 默认串行（Linux runner） | 542.5s |

PR #24 的 CI 耗时属于不同运行环境，不能与本地 wall 直接比较。本轮真实配对实验（同代码、同环境）是主要性能证据；全量数字受宿主负载影响。本轮未达到 15 分钟目标，但取得了可量化的实际并行收益。

## 3. 剩余限制与技术债务

1. 全局并行安全仍未证明；只有 13 个精确相邻配对获得许可，其他套件保持串行或 UNKNOWN。
2. 组合级安全不具传递性；不能因为 A+B、B+C 通过就推断 A+C 安全。
3. 浏览器资源余量有限：两组许可配对实测最低可用约 700–1127MB、CPU 95–99%；其他浏览器套件仍独占。
4. `test14+test15` 最低可用内存约 305.8MB、负载 98%，属于明显资源压力。
5. `test23` / `build-lock` / `runner-infrastructure` / `parallel-scheduler` 及正式内容门禁继续串行。
6. `--check` / `--dry-run` 与 `--sync` 并发的只读契约边界仍存在；逐文件替换不是多文件事务。
7. 没有通用并行池、跨屏障搜索、浏览器池、自动重试、失败自动重跑或 3+ 并发。
8. 全量性能数据受宿主负载影响；PR CI 默认串行只证明兼容性，不证明性能。

## 4. 推荐日常命令

```powershell
# 默认：完整串行，发布验收和 CI 使用
python scripts/run_tests.py

# 本地需要更快反馈时：显式启用已验证配对
python scripts/run_tests.py --workers 2

# 快速分组
python scripts/run_tests.py --group smoke --workers 2

# 定向组合
python scripts/run_tests.py --only test11 test20 --workers 2

# 生成 JSON
python scripts/run_tests.py --workers 2 --json tests/reports/parallel.json
```

日常开发可使用 `--workers 2` 获得已验证配对的收益；正式验收仍以默认串行 CI 为准。若对某个未验证组合有并行需求，必须先补资源隔离分析与同环境串行/并发一致性证据，不得直接加入许可清单。

## 5. 正式发布验收方式

1. PR 的默认串行 CI 必须 64/64 PASS，FAIL 0 / SKIP 0 / BLOCKED 0；
2. `content-gate` 必须 PASS；
3. 默认 `python scripts/run_tests.py` 行为不变；
4. 人工审核调度器配对清单、报告和矩阵；
5. 不自动合并、不自动部署；合并与发布由用户决定。

## 6. 阶段结论

8E-3 测试基础设施优化到此收尾：

- 可靠性、动态端口、C17 构建锁、可选调度器均已有独立证据；
- 实际全量已发生安全并行，wall 由 1398.5s 降至 1209.7s，约 13.5%；
- 仍保留保守边界，不把有限配对成功解释为全局并行安全；
- 不再新增通用调度框架优化批次；后续如需扩大并行范围，应按独立资源实验和精确配对逐组推进。
