# Batch 6C-1 诊断：文档级打开文章的长尾与首次搜索开销

- 分支 `feature/batch6b2-data-split`，起点提交 `947762e`
- 环境：真实 Chromium（headless）+ 移动整形（1638.4 kbps / 150 ms / 4× CPU）+ CDP + SW 侧时间戳
- 工具：`tests/perf/diag-nav.js`（新增）
- 对照：**B** = `c87b39b`（6B-1.1），**C** = 当前工作区；**交错执行**（单数轮 B→C，双数轮 C→B）

## 1. 结论先说

**延迟不在 Service Worker，也不在缓存策略，而在渲染主线程。**

C 的 `/blog/` 导航请求到达 SW 的时刻是 **@903~950 ms**（B 是 **@21~25 ms**）；SW 本身处理只用了 **+154~159 ms** 就返回了缓存外壳。也就是说，从"用户触发重开"到"SW 开始干活"之间被主线程占掉了约 **0.9 s**。

`PerformanceObserver('longtask')` 抓到了占用的来源：**渲染文章正文**——

```
longtask { start: 8914 ms, duration: 1213 ms }   ← 重开就发生在 10100 ms 左右
longtask { start: 9169 ms, duration: 1115 ms }
```

这 1.2 s 的长任务由 `renderMarkdown()`（marked + DOMPurify 净化 10.6 KB 正文）+ 首次布局 + 代码高亮组成，在 4× CPU 下是**同步的一整块**。

## 2. 分阶段数据（各 10 次，settle=300 ms）

| 阶段 | B（`c87b39b`） | C（修复前） |
| --- | --- | --- |
| 重开 → SW 收到导航（SW 侧日志） | **21 / 25 ms** | **903 / 950 ms** |
| SW 决策耗时（start → finish cache） | +152 ms | +159 ms |
| 外壳返回 → 首个 css/js 开始 | 258 ms | **1 572 ms** |
| FCP | 376 ms | 1 656 ms |
| DOMContentLoaded | 493 ms | 1 673 ms |
| load | 973 ms | 1 681 ms |
| 正文请求耗时 | 无（内联） | **2 ms（缓存命中）** |
| 正文可读（中位 [范围]） | 893 [779~3 054] | 1 951 [928~2 781] |

补充两组决定性实验：

| 实验 | 结果 | 说明 |
| --- | --- | --- |
| C，把 settle 从 300 ms 加到 1 500 ms | 可读 **1 061 [536~1 387]**，首个 css/js 664 ms | 给旧页面 1.2 s 空闲后，长尾基本消失 → 确认是"旧页面还在忙" |
| C，屏蔽 giscus + 高亮分帧（4 次） | 可读 **702~820 ms**，SW 收到导航 @89~221 ms | 页面真正空闲时，C 与 B 同一水平 |

## 3. 已排除的原因

| 假设 | 证据 | 结论 |
| --- | --- | --- |
| 正文请求拖慢 | 正文请求 2 ms（运行期缓存命中），`transferSize=0` | 排除 |
| 首屏资源拖慢 | 8 个首屏资源全部缓存命中，2~29 ms | 排除 |
| SW 决策/缓存慢 | SW 侧 `start → finish cache` 仅 154~159 ms，与 B 持平 | 排除 |
| `highlight.min.js` 被请求两次 | **B 也是 2 次**（旧页面 1 次 + 新页面 1 次），C 相同 | 不是 C 特有，但确实是可优化项 |
| giscus 第三方拖慢 | 屏蔽 giscus 后 C 仍 1 937 ms | 不是主因 |

## 4. 已实施的最小修复

**`js/app.js`：代码高亮改分帧执行**（`HL_BATCH_SIZE=4` + `requestIdleCallback`/`setTimeout` 让出），并在元素已脱离文档时跳过。

- 目的：把"一次性 highlight 全部代码块"从一个大任务切成若干小任务，避免长时间独占主线程；
- 实测收益：空闲场景下 4/4 样本 702~820 ms（修复前同条件 1 012~2 043 ms）；
- 但在"打开文章后 300 ms 立刻重开"的极端场景下，`long-post` 中位数仍是 **1 556.7 ms**（修复前 1 435.6 ms，差异在噪声内）——因为剩下的 1.2 s 长任务来自 markdown + DOMPurify + 布局，不在高亮里。

`post-lazy`（从首页点进文章，SPA 路径）修复后：移动 **1 609.6 ms**（修复前 1 648.0），重复打开 **190.4 ms**；桌面 336 ms / 41.4 ms。

## 5. 尚未解决的部分（如实记录）

**"打开文章后立即重开/刷新"** 仍会出现 1.5~1.7 s（B 为 0.7~0.9 s）。原因不是数据架构，而是：

- C 的文章页比 B 多一次"取正文 → 渲染"的异步跳转，导致 markdown + 净化的 1.2 s 长任务整体后移；
- 用户在这 1.2 s 内触发重开时，导航请求必须等主线程空闲才能派发，于是整段延迟被记到"文档级打开"头上；
- B 因为正文内联，长任务结束得更早，恰好躲开了这个窗口。

可选的后续（都超出"最小修复"范围）：

1. 把 markdown 渲染切成增量（按段落分帧净化），把 1.2 s 压到多次 <100 ms；
2. 用 `scheduler.postTask(..., {priority:'user-blocking'})` 给导航让路（需要 Chrome 94+，且不解决任务本身）；
3. 接受该长尾：它只在"刚打开就立刻重开"时出现，正常阅读路径（SPA 1 609 ms、重复 190 ms）与 B 同级。

## 6. 复现命令

```bash
# B / C 交错 10 次，含 SW 侧时间戳与长任务
node tests/perf/diag-nav.js --sites tests/perf/tmp/site-B-c87b39b,. --repeat 10 --settle 300 --out tests/perf/tmp/diag.json

# 只测 C，给旧页面 1.5 s 空闲（验证"旧页面忙"假设）
node tests/perf/diag-nav.js --sites tests/perf/tmp/site-B-c87b39b,. --only C --repeat 6 --settle 1500

# 屏蔽 giscus（第三方干扰）后复测
node tests/perf/diag-nav.js --sites tests/perf/tmp/site-B-c87b39b,. --only C --repeat 4 --block-giscus
```

原始数据：`tests/perf/tmp/diag-smoke.json`、`diag-settle1500.json`、`diag-after-hl.json`、`diag-nogiscus.json`、`diag-lt.json`（均在 `.gitignore` 内）。
