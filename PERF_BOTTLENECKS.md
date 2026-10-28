# Batch 6A：性能瓶颈分析（基于真实测量）

- 数据来源：`tests/perf/reports/baseline.json`（4 场景 × 桌面/移动 × 5 次）、`tests/perf/reports/lighthouse-summary.json`、`tests/perf/tmp/trace-summary.json`（Trace 探针，临时）
- 测量条件、账号口径与环境限制见 `PERF_BASELINE.md`（§2–§4、§8）
- 标记约定：**【实测】** / 【计算】 / 【推测】
- **本轮不修改任何代码**；以下全部是候选瓶颈与证据，供 Batch 6B 决策。

---

## 0. 结论速览

| 排序 | 候选瓶颈 | 影响量级（实测） | 证据强度 | 6B 是否建议动 |
| --- | --- | --- | --- | --- |
| B1 | SW network-first 使热启动不省流量 | 移动热启动 load 2 673 ms（冷 3 644 ms）；暖缓存下仍 10 个服务端请求 | 强（服务端计数 + 资源明细 + 源码一致） | **建议** |
| B2 | 首屏 JS 348 KB，`data.js` 114 KB 单文件最大 | 移动 `data.js` 传输 1 665 ms ≈ 冷启动 load 的 46% | 强（Resource Timing） | **建议（按场景，勿盲拆）** |
| B3 | 冷启动的 SW 预取额外拉 ~0.94 MB，含首屏不用的 `codefiles.js` 381 KB | 冷桌面 29 个服务端请求；移动下 ≈6 s 采样窗口结束时 SW 仍未激活 | 强（服务端计数 + 缓存清单 + 采样状态） | **建议** |
| B4 | 首访一次性引擎预热（Layout/编译） | 同一 DOM：Layout 272.5 → 6.1 ms；`app.js` eval 25.1 → 6.2 ms | 中（Trace 单样本、环境相关） | 先验证再动 |
| B5 | 搜索首次输入依赖 158 KB 懒加载 | 首帧 203 ms → 最终 1 591 ms（移动） | 强 | **建议（仅调度层）** |
| B6 | 长文 SPA 切换的布局/绘制 | 移动 rDOM 48.9 ms → 渲染完成 170.6 ms | 中（实测，成因未拆分） | 观察 |
| B7 | CLS 0.11 由页脚被推出视口造成 | 桌面 1 次位移，来源 `FOOTER.site-footer` | 强（layout-shift 来源节点） | **建议（低成本）** |
| — | Markdown/DOMPurify 是瓶颈 | `DOMPurify` 3.3/16.8 ms、`marked` 0.4/2.5 ms | 强（**否定**） | 不建议 |
| — | `highlight.min.js` 拖慢首屏 | 仅文章页按需加载，长文页 2.3–2.7 ms | 强（**否定**） | 不建议 |

---

## 1. 证据来源与可复核性

### 1.1 三条独立证据链

1. **浏览器侧**：`PerformanceObserver`（FCP/LCP/CLS/长任务）+ `Resource Timing`（每个资源的 `duration`/`encodedBodySize`）+ CDP `Performance.getMetrics`（`ScriptDuration`/`TaskDuration`/`LayoutDuration`）。
2. **服务端侧**：`tests/browser/helpers/server.js` 内部的逐路径命中计数（`state.hits`）。**这是判断「SW 是否真的省了请求」的唯一硬证据** —— 经 SW 返回的响应在 Resource Timing 里 `transferSize` 为 0，光看页面侧会误以为「没走网络」。
3. **探针侧**（`--no-diagnostics` 可跳过，主测量结束后单独会话执行）：
   - 微基准：直接调用页面已有函数（`renderMarkdown`/`renderPost`/`renderHome`/`renderGlobalSearch`/`loadData`），7 次取中位数；
   - CDP Trace（一次性，冷启动 vs 热启动各 1 次），按主线程（`CrRendererMain`）聚合 `X` 类事件耗时；
   - 专项复核：LCP 候选列表、`layout-shift` 来源节点。

微基准的部分是【计算/隔离测量】：它把「数据扫描」「HTML 构建」「DOM 赋值」「赋值到下一帧」拆开，避免把网络问题误判成渲染问题。

### 1.2 关键页面事实（供量化对照）

| 项 | 值 |
| --- | --- |
| 文章数 / 正文总字符 | 18 篇 / 66 495 字符（`postsChars`） |
| 长文样本 | `deep-learning-in-slam`，正文 8 097 字符 → 渲染后 HTML 9 580 字符 |
| 长文页 DOM | `#app` 内 201 节点、17 个 h2/h3、TOC 17 项，整页 591 节点 |
| 首页 DOM | 414 节点 |
| 首屏资源（9 个） | `index.html` 5 440 + `style.css` 50 928 + `atom-one-light.min.css` 856 + `marked.min.js` 39 903 + `purify.min.js` 29 828 + `data.js` 114 583 + `user-posts.js` 205 + `projects.js` 3 544 + `app.js` 103 156 = **348 443 B** |
| 懒加载分区数据 | `courses.js` 14 876 + `papers.js` 42 068 + `course-notes.js` 100 903 + `note-slugs.js` 966 = **158 813 B** |
| SW 预取集合 | 必需 6 个（343 838 B，与首屏重叠）+ 可选核心 7 个（小）+ 可选大文件 6 个 = **595 593 B**（`highlight` 56 113 + `courses` 14 876 + `course-notes` 100 903 + `note-slugs` 966 + `papers` 42 068 + **`codefiles` 380 667**） |

---

## 2. B1：SW 的 network-first 让热启动不具备省流量效果（最高优先级）

### 现象

| 指标 | 冷启动（桌面 / 移动） | 热启动（桌面 / 移动） | 变化 |
| --- | --- | --- | --- |
| load | 347.3 / 3 644.4 ms | 69.6 / 2 672.9 ms | −80% / **−26.6%** |
| FCP | 224 / 1 496 ms | 60 / 424 ms | −73% / −72% |
| 服务端请求数 | 29 / 16（含 SW 安装预取） | **10 / 10** | 仍完整拉取首屏 9 个资源 |
| `data.js` 传输耗时 | 30.1 / 1 665 ms | 24.4 / **1 359 ms** | 桌面几乎不变；移动只降 18% |
| SW 缓存条目 | — / 未接管 | 27 / 27（已预热） | 缓存是满的 |

**暖缓存下单次 reload 的服务端命中明细**【实测】：

```
/index.html 1   /css/style.css 1   /vendor/atom-one-light.min.css 1   /vendor/marked.min.js 1
/vendor/purify.min.js 1   /js/data.js 1   /js/user-posts.js 1   /js/projects.js 1   /js/app.js 1   /sw.js 1
```

### 解释与证据一致性

- `sw.js:167-229`：`navigate` → network-first；同源其它（HTML/CSS/JS）→ network-first；只有 `/vendor/` 走 stale-while-revalidate。
- 资源明细完全符合该策略【实测】：
  - `vendor/*`：冷 → 热 传输耗时 `marked` 723.9 → 12.6 ms、`purify` 1 053.1 → 26.6 ms、`atom-one` 567.7 → 4.2 ms（SWR 命中 CacheStorage）；
  - 其它：`style.css` 181.4 → 166.8 ms、`data.js` 1 661.1 → 1 359.4 ms、`app.js` 2 679.5 → 2 366.3 ms（network-first 仍需下载）。
- 也就是说：**SW 缓存对「vendor 大文件」有效，对「首屏最大的两个脚本 + HTML + CSS」无效**。

### 为什么移动端只省了 27%

移动整形下首屏 348 KB 的理论传输下限 ≈ 1.7 s（1638.4 kbps）。热启动仍需下载其中约 273 KB（`data.js` 114.6 + `app.js` 103.2 + `style.css` 50.9 + 小文件），因此 load 从 3.64 s 只降到 2.67 s。

### 置信度与反证检查

- 置信度：**高**。服务端计数不受页面侧 `transferSize = 0` 干扰；与 SW 源码策略逐条对应。
- 反证检查：热启动样本的 `sw.controller` 全为 `true`、CORE 缓存 12 条齐全、`warmVerified = true`（5/5），排除「其实没预热」。
- 环境依赖：桌面回环下 network-first 的代价几乎为 0（`data.js` 24 ms），所以**该瓶颈只在有网络成本的场景（移动/公网）显著**。这是「桌面看起来没问题」却「手机上慢一倍」的原因。

---

## 3. B2：首屏 JS 348 KB，`data.js` 是最大单文件

### 证据

1. 首屏编码后体积 348 443 B（桌面/移动一致）【实测】。Lighthouse 独立口径 394 KiB（含 SW 预取），`unused-javascript` 估算可省 **98 KiB**（score 0）【实测·LH】。
2. 移动冷启动各资源传输耗时（实测，来自 `baseline.json`）【实测】：

| 资源 | 编码字节 | 冷启动 | 热启动 | 说明 |
| --- | --- | --- | --- | --- |
| `style.css` | 50 928 | 181.4 ms | 166.8 ms | network-first |
| `atom-one-light.min.css` | 856 | 567.7 ms | 4.2 ms | vendor → SWR 命中 |
| `marked.min.js` | 39 903 | 723.9 ms | 12.6 ms | vendor → SWR 命中 |
| `purify.min.js` | 29 828 | 1 053.1 ms | 26.6 ms | vendor → SWR 命中 |
| **`data.js`** | **114 583** | **1 661.1 ms** | **1 359.4 ms** | 首屏最大文件，且每次都要下 |
| `user-posts.js` | 205 | 2 044.6 ms | 1 746.0 ms | 排在 data.js 之后 |
| `projects.js` | 3 544 | 2 199.9 ms | 1 900.2 ms | 同上 |
| `app.js` | 103 156 | 2 679.5 ms | 2 366.3 ms | 最后完成，直接决定 DCL/首屏内容 |

3. 但**执行成本很小**【实测】：冷启动全部脚本 `ScriptDuration` 桌面 32.53 ms / 移动 139.89 ms；Trace 里 `EvaluateScript app.js` 25.1 ms（冷）【实测·Trace】。`data.js` 本身 `EvaluateScript` 仅 0.3 ms（大字符串常量）。
4. `data.js` 中 **66 495 字符是文章正文**，而首页渲染只需要标题/日期/标签/摘要/阅读时长（`renderHome` 只用 `content` 算 `readingTime`）【实测·诊断 meta】。

### 结论（谨慎版）

- **瓶颈是「传输」不是「解析」**：在受限网络下 `data.js` 占冷启动 load 的 ≈46%（1 661/3 644），在桌面回环下只占 ≈8%（30/383）。
- 因此 **不应基于本报告直接断言「必须拆分 data.js」**：桌面无收益；移动端收益取决于能否让首屏只下载索引部分。若要拆，验收基准建议是「移动冷启动 load ≤ 2.8 s」与「首屏字节 ≤ 200 KB」。
- 一个低风险替代方案：**构建期预计算 `excerpt`/`readingTime`/`tags` 索引**，把正文从首屏依赖中剥离，而不改渲染逻辑。

---

## 4. B3：冷启动的 SW 预取额外拉 ~0.94 MB（含首屏从不使用的 381 KB）

### 证据

1. 冷启动服务端命中 29 个（桌面）vs 页面自身只需 9 个【实测】。差额来自 SW：`sw.js` 自身 + 必需 6 个 + 可选核心 7 个 + 可选大文件 6 个。
2. 可选预取合计 595 593 B，其中 `js/codefiles.js` **380 667 B（64%）**，只有访问 `/code` 路由才需要【实测·文件体积 + `sw.js:38-45`】。
3. 移动端后果【实测】：冷启动采样窗口（load + 2.5 s ≈ 6.1 s）结束时 SW 仍未激活（`controller: false`、`cacheNamesAtLoad: []`），因此 `swCacheEntries` 记为 **UNAVAILABLE**；桌面同类样本已缓存 18 条。
4. 预热收敛耗时【实测】：移动端预热总耗时 ≈ 11.7 s（其中预取排空 ≈ 3.3 s，SW 接管等待 ≈ 0.1–0.2 s）。这说明预取在慢速链路上是一个「秒级」的后台任务。

### 影响与不确定性

- 对**首屏指标**的直接影响有限（预取在 `load` 之后启动），但它与首屏共享带宽：移动冷启动 FCP 1 496 ms、`data.js` 到 1 661 ms、`app.js` 到 2 680 ms，预取字节会插队（整形代理是全局限速，真实网络同理）。
- 影响【推测】：慢速链路上，预取会推迟 SW 接管到下一屏（首访期间没有离线能力），并消耗用户流量 ≈ 0.6–0.95 MB（其中 381 KB 是首页用不到的代码库数据）。
- 置信度：请求数量与体积是实测；「对首屏的具体拖慢比例」未拆分验证（【推测】）。

---

## 5. B4：首访一次性引擎预热成本（冷 ≠ 复杂，但真实存在）

### 证据（CDP Trace，桌面冷启动 vs 同页热启动，各 1 次）【实测·Trace】

| 事件（主线程） | 冷启动 | 热启动 |
| --- | --- | --- |
| `RunTask`（总） | 612 次 / 504.9 ms | 535 次 / 152.1 ms |
| `Layout` | **4 次 / 272.5 ms** | **4 次 / 6.1 ms** |
| `UpdateLayoutTree` | 79 次 / 42.0 ms | 77 次 / 31.4 ms |
| `Paint` | 68 次 / 10.1 ms | 90 次 / 12.3 ms |
| `EvaluateScript`（全部） | 6 次 / 41.6 ms | 6 次 / 11.6 ms |
| 其中 `app.js` | 25.1 ms | 6.2 ms |
| 其中 `marked.min.js` | 11.0 ms | — |

同一份 DOM、同样 4 次布局：**冷启动 272.5 ms，热启动 6.1 ms（45×）**。这与页面复杂度无关，只能解释为「首次渲染/首次编译的一次性成本」（字体/样式/布局引擎初始化、V8 代码缓存缺失）【推测（强证据支持的推断）】。

### 数据可信度

- 冷启动 `LayoutDuration`（CDP，5 次中位 248.9 ms 桌面 / 1 202 ms 移动）与 Trace 的 `Layout` 合计（272.5 ms）互相印证【实测×2】。
- 该成本属于**首访用户真实承担**的成本（每个新访客的渲染进程都是冷的），因此不该被当作「测量噪声」剔除。
- 但绝对值受环境影响大（headless、无 GPU 光栅化），**必须在真实浏览器复核后才能据此优化**【推测】。

### 与「DOM 规模」的区分

- 首页 414 节点、长文页 591 节点，二者 `LayoutCount` 都只有 3–5 次；而长文页（暖缓存整页重载）桌面 `LayoutDuration` 仅 14.96 ms（`long-post/desktop` 样本 `cdp.values.LayoutDuration`）【实测】。
  → **更长、节点更多的文章页布局反而更便宜**，进一步说明首页冷启动的 249 ms 不能归因于「卡片太多」。

---

## 6. B5：搜索首次输入受 158 KB 懒加载支配，计算本身不是瓶颈

### 证据

| 度量 | 桌面 | 移动 |
| --- | --- | --- |
| 首次输入首帧（含 180 ms 防抖） | 188.8 ms | 202.9 ms |
| 首次输入最终结果（懒加载补齐） | 245.9 ms | **1 591.3 ms** |
| 首次输入新增下载 | 158 813 B | 158 813 B |
| 首次输入 JS 执行 | 2.73 ms | 12.99 ms |
| 重复输入（数据已就绪） | 184.8 ms | 300.8 ms（248.5~346.4） |
| `renderGlobalSearch('SLAM')` 纯构建 | **1.0 ms** | **3.7 ms** |
| 纯关键词扫描（不含 HTML） | 0.4 ms | 1.1 ms |

- 180 ms 防抖是**固定下限**（`js/app.js:303`）：桌面重复输入 184.8 ms ≈ 180 ms + 4.8 ms 渲染，说明搜索本身已接近「零成本」。
- 移动端首次输入 1 591 ms 中，180 ms 是防抖，其余 ≈ 1.4 s 基本等于 158 813 B / 204.8 KB/s ≈ 776 ms 加上排队/解析（4 个脚本串行 `loadScriptOnce`，`asyno=false` 顺序注入）【实测 + 计算】。
- 移动端重复输入波动 32%（248.5–346.4 ms）：4× CPU 下定时器/渲染抖动【推测】。

### 结论

搜索的**算法与 DOM 构建都不是瓶颈**，瓶颈是「首次输入才去下载 158 KB 分区数据」。可优化的只有调度策略（空闲预取/骨架/分段返回），**不要动 180 ms 防抖** —— 它是避免每次按键重建整页 DOM 的唯一保护（`bindLiveSearch` 注释也写明了这一点）。

---

## 7. B6：长文页的 SPA 路由切换（移动 170 ms 渲染，桌面 44 ms）

| 度量 | 桌面 | 移动 |
| --- | --- | --- |
| 首页→文章：DOM 更新完成 | 11.7 ms | 48.9 ms |
| 首页→文章：渲染完成（双 rAF） | 44.3 ms | **170.6 ms** |
| 其中 JS 执行 | 11.02 ms | 44.64 ms |
| 文章→首页：DOM 更新 | 5.5 ms | 25.0 ms |
| 其中 JS 执行 | 4.76 ms | 21.68 ms |

- 移动端从「DOM 已更新」到「渲染完成」多出 ≈ 122 ms，即样式/布局/绘制成本（4× CPU）【实测】。
- 该段 JS（44.6 ms）与诊断探针的 `renderPost`（29.2 ms，含 `renderMarkdown` 22 ms）同量级，剩余部分为 `enhanceCodeBlocks` / 目录构建 / 事件委托等【实测 + 推测】。
- 文档级（重载）加载文章页：移动 FCP 424 ms、LCP 2 992 ms、load 2 983 ms，其中 LCP 候选就是代码块，说明**文章页的可见时间主要被首屏资源下载 + 页面启动支配**，而不是 Markdown 渲染（22 ms）。

---

## 8. B7：CLS 0.11 全部来自页脚被推出视口

### 证据（专项复核，冷启动桌面）【实测】

```
layout-shift: t=369ms  value=0.1111  shiftCount=1
source: FOOTER.site-footer
  previousRect: { x:0, y:799.5, width:1440, height:100.5 }   ← 首屏时页脚在视口内
  currentRect : { x:0, y:0, width:0, height:0 }             ← 卡片插入后被推出视口
```

- 归因明确：`#app` 初始为空 → 页脚紧贴页头 → `renderHome()` 插入 18 张卡片 → 页脚被推到折叠线以下。
- 移动端基线 CLS 也是 0.12，但一次**未限速**的专项复核未复现位移 → CLS 对渲染时序/视口高度敏感，**不解释为设备差异**【实测 + 推测】。
- 低成本修复方向：给 `#app` 或 `.article-list` 预留 `min-height`（或首屏骨架占位），属"零逻辑"改动候选。

---

## 9. 明确否定的假设（避免 6B 走错方向）

| 假设 | 结论 | 证据 |
| --- | --- | --- |
| 「Markdown + DOMPurify 是首屏/搜索瓶颈」 | **否** | 首页根本不解析 Markdown；长文页 `marked` 0.4/2.5 ms + `DOMPurify` 3.3/16.8 ms，`renderPost` 合计 5.2/29.2 ms |
| 「`highlight.min.js`（56 KB）拖慢首屏」 | **否** | 只在含代码块的页面按需加载；长文页加载耗时 2.3–2.7 ms（SW 已预取），且不在首屏 9 个资源内 |
| 「首页 DOM 太大/卡片太多导致布局慢」 | **否（证据不支持）** | 长文页节点更多（591 vs 414），其桌面 `LayoutDuration` 仅 14.96 ms；首页冷启动的 249 ms 是首访一次性成本（B4） |
| 「搜索算法需要优化」 | **否** | 纯扫描 0.4/1.1 ms，HTML 构建 1.0/3.7 ms；端到端 184.8 ms 中 180 ms 是防抖 |
| 「必须拆分 `data.js`」 | **数据不足以下此结论** | 桌面收益 ≈ 0（30 ms→?）；移动端潜在收益大但与「拆分方案是否让首屏少下 100 KB」强相关，需 6B 用同一工具做 A/B 基线对比 |
| 「SW 让热启动很快」 | **仅在桌面成立** | 桌面热启动 load 69.6 ms（HTTP 缓存关闭 + 回环），移动 2 672.9 ms（−26.6%） |

---

## 10. Batch 6B 建议（按收益/风险排序）

| 优先级 | 动作 | 预期收益（可用本轮基线验收） | 风险 |
| --- | --- | --- | --- |
| P1 | 调整 SW 策略：`index.html` 与首屏关键脚本（`data.js`/`app.js`/`style.css`）改 stale-while-revalidate 或版本化 cache-first | 移动热启动 load 2 672.9 → 目标 ≤ 1.2 s；服务端请求 10 → 0 | 中（需保证发版后能更新：用 `CACHE_VERSION` + 后台 revalidate） |
| P2 | 削弱首访预取：`codefiles.js`（381 KB）改为访问 `/code` 时才预取；`papers/courses/notes` 交由空闲调度 | 首访额外流量 −381 KB（≈64% 的预取量）；移动端 SW 接管时间目标 ≤ 3 s（当前 ≈1.3 MB / 204.8 KB/s ≈ 6.5 s，计算值） | 低（只影响离线可用范围） |
| P3 | 首屏数据瘦身：构建期产出「索引版」`data.js`（去掉 66 495 字符正文，保留 `excerpt/readingTime/tags`） | 首屏字节 348 KB → 目标 ≤ 200 KB；移动冷启动 load 3 644 → 目标 ≤ 2.8 s | 中（需同步改 `renderPost` 的数据来源） |
| P4 | 搜索分区数据改为空闲预取 + 首屏结果先出（保留 180 ms 防抖） | 移动首次输入最终结果 1 591.3 ms → 目标 ≤ 400 ms | 低-中（需避免与首屏抢带宽） |
| P5 | 给 `#app` 预留最小高度 | CLS 0.11 → 目标 ≤ 0.05 | 低 |
| P6 | 首屏卡片分批渲染（首屏可见 N 张 + 滚动补） | 桌面冷启动 Layout 248.9 ms 的下降（需先在真实浏览器复核 B4 的量级） | 中（改动渲染路径，需回归 `tests/test9.js` 等） |

**验收方法**：全部沿用 `node tests/perf/perf.spec.js`（同一配置、同一预热校验、同一关键词），对比 `baseline.json` 的 `summary.*.median` 与 `serverRequestCount`；目标值必须同时给出桌面与移动两组。

---

## 11. 需要标注的不确定性（不做过度解读）

1. **B4 的绝对值**：headless + 软件光栅化 + 无 GPU 会放大 `Layout`/`Paint`，真实浏览器可能只有其 1/2–1/3【推测】。
2. **B3 对首屏的拖慢比例**：预取与首屏共享带宽的现象在整形代理上是真实的，但具体抢走多少带宽未拆分验证【推测】。
3. **移动端 TBT / CLS 的稳定性**：TBT 移动端波动 20.73%，CLS 在限速与不限速两次测量中不同（0.12 vs 未复现）【实测】。
4. **`unused-javascript` 98 KiB**：Lighthouse 估算值，未逐模块核对是哪部分未被使用（【实测·LH】数值，归因未验证）。
5. **首次访问 vs 回访**：本报告只有「全新 BrowserContext」与「同会话预热」两种状态，没有覆盖「隔天回访」（浏览器磁盘缓存 + V8 代码缓存已存在，但 SW 可能已更新）的真实分布。
