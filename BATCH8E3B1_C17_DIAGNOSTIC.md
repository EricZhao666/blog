# Batch 8E-3B-1：C17 并发构建诊断

- 诊断日期：2026-11-18
- 仓库：`E:\work_funnycode\blog`
- 基线：`a0157f1`（PR #21 squash 合并）
- 范围：只读诊断 `tests/test23_content_build.py` C17 与 `scripts/build_content.py` 的 BuildLock；**未修改生产构建逻辑**。
- 结论级别：**CONFIRMED**（合成 fixture 已复现 `[0,1]`，并捕获完整异常栈）。

## 1. C17 原本的契约

`tests/test23_content_build.py:349-363`：

```python
root7 = make_fixture('race')
sync(root7)
cmd = [sys.executable, BUILD, '--root', root7, '--sync', '--now', FIXED_NOW]
p1 = subprocess.Popen(cmd, ...)
p2 = subprocess.Popen(cmd, ...)
codes = sorted([p1.returncode, p2.returncode])
check('C17 并发时不会出现两个都半途而废（0/0 或 0/3）', codes in ([0, 0], [0, 3]), codes)
```

允许的退出码组合只有 `[0,0]`（都成功，可能都认为无变更）和 `[0,3]`（一个成功、一个 LockBusy）。`[0,1]` 表示一个进程成功，另一个以未预期异常失败。

## 2. 采样方法

- 合成 fixture：`js/data.js`（2 篇文章元数据）、`data/posts/post-a.md`、`post-b.md`、`js/user-posts.js`。
- 每个 trial：先单独 `--sync` 初始化产物；再同时启动两个 `build_content.py --root <fixture> --sync --now 2026-11-09T00:00:00Z`。
- 每个子进程最多 20s；总预算 180s；共 20 个 trial。
- 记录：退出码、stdout/stderr、锁文件、四份产物哈希、并发后 `--check` 退出码。
- 临时脚本：`%TEMP%\b8e3b1_c17_diag.py`；原始日志在 agent 工作区 `b8e3b1-c17b.log`。脚本与 fixture 均不写入仓库。

## 3. 结果

| 退出码组合 | 次数 | 占比 |
|---|---:|---:|
| `[0,0]` | 14 | 70% |
| `[0,3]` | 4 | 20% |
| `[0,1]` | **2** | **10%** |

- 20 次中 2 次复现失败，与上一轮 full 首次出现的 `[0,1]` 形态一致。
- 失败 trial 的产物哈希在并发前后一致，`--check` 退出 0，锁文件均不存在（`lock=False`）。即失败是**构建进程异常退出**，不是产物被破坏。
- 未复现 `[0,1]` 以外的异常组合；无超时。

### 失败样本 A（trial 1）

```
codes=[0,1]
stderr（失败进程）：
Traceback (most recent call last):
  File ".../scripts/build_content.py", line 407, in <module>
  File ".../scripts/build_content.py", line 380, in main
    changes = diff_artifacts(root, artifacts)
  File ".../scripts/build_content.py", line 209, in diff_artifacts
    with open(path, 'rb') as f:
PermissionError: [Errno 13] Permission denied:
  '...\t01\data\search-index.json'
```

### 失败样本 B（trial 18）

```
codes=[0,1]
stderr（失败进程）：
[FAIL] 写入失败：[WinError 5] 拒绝访问。:
  '...\t18\js\.tmp-build-p6krpoe3.part' -> '...\t18\js\data.js'
```

对应 `scripts/build_content.py:253-254` 的 `os.replace(tmp, target)`。

## 4. 根因

两个进程都执行以下顺序：

1. `diff_artifacts(root, artifacts)`（`build_content.py:202-215`）在**未持有 BuildLock** 时打开并读取现有产物；
2. 之后才进入 `with BuildLock(...)`（`build_content.py:389-391`）；
3. 锁内 `write_artifacts` 逐文件 `os.replace`（`build_content.py:253-254`）。

Windows 上，一个进程正在 `open(path,'rb')` 读取 `data/search-index.json` 时，另一个进程对该文件执行 `os.replace` 可能得到共享冲突；反之，`os.replace` 正在替换 `js/data.js` 时，另一个进程的 `open(...,'rb')` 也可能得到 `PermissionError`。这与 BuildLock 是否有效无关，因为**读取/比较阶段在锁外**。

`BuildLock` 本身只覆盖写入阶段；它的 `_lock_is_stale()` 只按 mtime 判断，不参与该共享冲突。`[0,3]` 是正常的锁竞争路径（`LockBusy` → exit 3），不是本问题。

## 5. 影响与分级

- 编号建议：`B8E3B1-C17-01`
- 严重程度：**P2**（发布构建在 Windows 并发场景下偶发失败；单进程正常路径不受影响；测试/CI 串行时通常不触发）
- 类型：**CONFIRMED**
- 触发条件：同一 root 上两个 `--sync` 并发，且其中一个在 diff 读取阶段与另一个的 `os.replace` 重叠；Windows 文件共享语义下概率更高。
- 影响范围：`scripts/build_content.py --sync` 并发调用；`tests/test23_content_build.py` C17；任何未来并行构建/并行测试调度。
- 测试覆盖：test23 C17 已覆盖该场景，但断言只接受 `[0,0]` / `[0,3]`；本次未改断言。
- 推荐修复（**未实施**）：把 `diff_artifacts` 纳入 BuildLock 临界区，或在读取时对 `PermissionError` 做有界重试；`write_artifacts` 的 `os.replace` 失败时清理剩余 staged `.tmp-build-*` 文件；不要放宽 C17 断言。由于本轮禁止修改生产构建逻辑，只记录为后续独立修复项。
- 修复风险：中；改变锁的临界区会影响 `--check` 与 `--sync` 的并发语义，需要单独回归。
- 复杂度：中（生产脚本 + test23 专项）。
- 并行结论：在根因修复或充分隔离前，`test23` 必须保持 **SERIAL_REQUIRED**，不得进入默认并行池。

## 6. 与 Batch 8E-3B-1 的关系

- 本问题与端口隔离改造无直接关系；`test23` 不使用本地 HTTP 端口。
- 本轮未修改 `scripts/build_content.py`、`tests/test23_content_build.py` 的断言或测试语义。
- 最终 full 若再次出现 `test23` 失败，应按本诊断记录为已知 C17 并发构建缺陷，而不是端口迁移回归。
