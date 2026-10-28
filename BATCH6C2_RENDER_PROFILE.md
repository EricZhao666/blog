# Batch 6C-2 渲染剖析：长任务到底是谁

- 分支 `feature/batch6b2-data-split`，起点 `ba7bab6`
- 环境：真实 Chromium；移动 = Pixel 7 + 4× CPU + 1638.4 kbps/150 ms 整形；桌面 = 1440×900 无限速
- 新增工具：`tests/perf/diag-render.js`（三场景 × 10 次 × B/C 交错）、`tests/perf/profile-article.js`（CDP Profiler）

## 1. 三个场景的定义

| 场景 | 定义 | 是否典型 |
| --- | --- | --- |
| **A 稳定后重新进入** | 打开文章 → **空闲 2 s**（渲染/高亮/目录都做完）→ 回首页 → 再进入同一篇 | ✅ 典型（看完回列表再点） |
| **B 渲染中立即重开** | 打开文章 → **300 ms** → 文档级 reload | ❌ 压力（刚打开就刷新） |
| **C 连续切换文章** | art1 → 80 ms → art2 → 80 ms → art3，校验最终显示第 3 篇 | ✅ 典型（连续翻文章） |

## 2. 测量结果（首段正文可读，中位 [范围]，p90）

**移动端（10 次）**

| 场景 | B（`c87b39b`） | C（本轮） | 结论 |
| --- | --- | --- | --- |
| A 稳定后重进 | 225 [198~459]，p90 459 | **192 [181~253]，p90 253** | C 更快且**抖动减半** |
| B 渲染中重开 | **775 [668~2 306]，p90 2 306** | 1 530 [1 366~7 569]，p90 7 569 | C 更慢（唯一回退） |
| C 连续切换 | 7 174 [3 268~8 262] | **3 245 [2 159~6 094]** | C 快 **2.2×** |

**桌面端（10 次）**

| 场景 | B | C | 结论 |
| --- | --- | --- | --- |
| A | 54 [49~830]，p90 830 | **53 [43~77]，p90 77** | 持平但**抖动从 830 → 77** |
| B | 156 [143~179] | **118 [105~209]** | C 更快 |
| C | 545 [522~586] | **448 [445~557]** | C 更快 |

> 结论先行：**除"移动端 + 刚渲染完就重开"这一个压力场景外，C 在所有场景都不慢于 B**，连续切换甚至快一倍以上；A 场景的 p90 从 459/830 ms 降到 253/77 ms。

## 3. 长任务归因（marks + CPU Profile）

### 3.1 代码内 marks（C 版本，移动端一次真实样本）

| 阶段 | 耗时 |
| --- | --- |
| `art:md-start → art:md-end`（marked 解析 + DOMPurify 净化） | **156 ms** |
| `art:html-end → art:post-start`（innerHTML 之后的样式重算 + 布局 + 绘制，浏览器内部） | **1 274 ms** |
| `art:post-start → art:post-end`（代码工具条 + TOC + 阅读进度 + 首批高亮，本轮改为延后执行） | **8 ms** |

### 3.2 CDP CPU Profile（`Profiler`，采样 200 µs，覆盖"点进文章 → 可读 + 400 ms"）

```
总采样 2 462 ms | 正文可读 589 ms
 1 810.5 ms  73.5%  (program)            ← 浏览器内部：样式重算 / 布局 / 绘制 / 解析
   171.7 ms   7.0%  (idle)
    55.7 ms   2.3%  exec        @ vendor/highlight.min.js
    45.7 ms   1.9%  (anonymous) @ vendor/highlight.min.js
    38.2 ms   1.6%  $e          @ vendor/highlight.min.js
    20.7 ms   0.8%  (anonymous) @ vendor/purify.min.js
    15.1 ms   0.6%  n           @ vendor/highlight.min.js
    14.7 ms   0.6%  h           @ vendor/highlight.min.js
    12.7 ms   0.5%  emStrong    @ vendor/marked.min.js
    12.2 ms   0.5%  M           @ vendor/highlight.min.js
    10.5 ms   0.4%  (garbage collector)
     9.2 ms   0.4%  inlineTokens @ vendor/marked.min.js
     8.6 ms   0.3%  list        @ vendor/marked.min.js
     8.1 ms   0.3%  router      @ js/app.js
```

**读法**：

- JS 侧合计约 **250 ms**：高亮 ~181 ms、marked ~38 ms、DOMPurify ~21 ms、路由/渲染 ~8 ms；
- **73.5% 的采样落在 `(program)`**，即浏览器内部的样式重算 + 布局 + 绘制 —— 这是 10.6 KB Markdown（含代码块、表格、列表）在 4× CPU 下的固有排版成本；
- 因此"1.2 s 长任务"的主体**不是我们的 JS**，把 JS 优化到 0 也消不掉布局成本。

### 3.3 与 6C-1 结论的关系

6C-1 只看到"1.2 s 长任务 + 导航推迟"，本轮进一步把它拆成 **markdown 156 ms + 布局 1 274 ms + 增强 8 ms**，并确认布局占绝对多数（CPU Profile 交叉验证）。

## 4. 本轮实际改动（最小侵入）

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 非首屏增强延后到首帧之后 | `js/app.js` | `enhanceCodeBlocks` + `buildReadingTools` + `highlightIn` 从"路由尾部同步执行"改为 `rAF → idle` 执行（新增 `scheduleAfterPaint`） |
| 路由切换丢弃过期渲染 | `js/app.js` | 延后任务执行前校验 `token !== _routeToken` 与 `node.isConnected`，避免旧文章的内容/目录污染新路由 |
| 渲染阶段 marks | `js/app.js` | `perfMark('art:md-start/md-end/html-end/post-start/post-end')`，供后续诊断复用（开销 ~µs） |
| 三场景测量工具 | `tests/perf/diag-render.js` | 新增；含长任务、首段可读、连续切换串页校验 |
| CPU Profile 工具 | `tests/perf/profile-article.js` | 新增；输出 Top self-time 函数 |

效果（对比 6C-1 的 `long-post`/`post-lazy`）：

- A 场景移动端 192 ms（B 225），p90 253（B 459）；
- C 场景移动端 3 245 ms（B 7 174）；
- 桌面三个场景全部不慢于 B。

## 5. 未做的部分（明确说明）

- **不做 Markdown token 级渐进渲染**：需要处理表格、代码围栏、列表嵌套、净化与 TOC 一致性，收益上限是"把 1.27 s 布局拆到多帧"，但会引入跨帧状态与 XSS 边界风险，不符合本轮"最小优化"约束；
- 不做搜索语料 gzip/倒排（本轮只评估，见 `BATCH6C2_PERFORMANCE.md` §3）；
- 移动端压力场景 B 仍是 1.5 s 量级：它是"文章刚渲染完 300 ms 内立刻刷新"，此时浏览器正在做 1.27 s 布局，导航必然排队。要消除只能靠上述渐进渲染。

## 6. 复现

```bash
node tests/perf/diag-render.js --sites tests/perf/tmp/site-B-c87b39b,. --config mobile  --repeat 10 --out tests/perf/tmp/r-mobile.json
node tests/perf/diag-render.js --sites tests/perf/tmp/site-B-c87b39b,. --config desktop --repeat 10 --out tests/perf/tmp/r-desktop.json
node tests/perf/profile-article.js --site . --config mobile --out tests/perf/tmp/profile-C-mobile.json
```
