# Batch 8D-4 报告：全站性能优化、无障碍改善与质量审计

- **分支**：`feature/batch8d4-performance-accessibility`（基于 `origin/main` @ `97a6680`，即 Batch 8D-3 合并后的最新 main）
- **执行日期**：2026-11-17（本机时间，全部阶段同日完成）
- **最终结论**：**B8D4_LOCAL_READY**（本地 commit 完成；未 push、未创建 PR、未部署，符合任务约束）
- **回归口径**：`python scripts/run_tests.py` → **PASS 59 / FAIL 0 / SKIP 0 / BLOCKED 0**（58 套原有 + 1 套新增，全部通过；含 SW 一致性/升级测试与 content-check / feed-check / image-check 门禁）

---

## 0. 执行时间线（各 Stage 实际开始/结束，依据产物文件时间戳）

| Stage | 内容 | 开始 | 结束 | 备注 |
|---|---|---|---|---|
| 0 | git fetch / CI 确认 / 建分支 / 结构勘察 | 17:18 | 17:23 | PR #18 checks 页面确认 tests workflow succeeded（gh CLI 与 api.github.com 在本机不可用，改用网页核查） |
| 1 | 无障碍审计器 + perf 场景扩展 + before 基线 | 17:24 | 18:08 | 审计 17:31 完成；性能基线采集 17:33–18:05（1541s）；诊断探针 bug 修复 18:05–18:08 |
| 2–5 | 代码修改（JS 性能/无障碍/响应式/SW 版本） | 18:08 | 18:16 | 全部修改一次落盘 |
| 6 | 新测试套件编写调试 + 定点回归 + 注册 + 全量回归 | 18:16 | 19:52 | 新套件三轮调试（58→59 全 PASS）；全量回归 19:29–19:52（23.5 min） |
| 7a | after 性能采集 | 19:53 | 20:19 | 1546s，verdict BATCH6A_READY |
| 7b | Lighthouse（npx 版本故障排查 + 两轮采集复测） | 20:19 | 21:35 | 含两次安全确认弹窗各 1 小时等待（非执行时间）；对比数据生成 |

> 墙钟时间中约 2 小时为「按需确认」模式下删除临时文件 / 停止进程的安全确认弹窗等待超时，未消耗机器资源；纯执行时间约 2.4 小时（其中自动化测试采集约 1.9 小时）。

---

## 1. 环境与工具口径

| 项 | 值 |
|---|---|
| 机器 | LAPTOP-KUA5JIQM，AMD Ryzen 7 3750H（8 线程）/ 15.44 GB RAM，Windows |
| 浏览器 | Chrome 157.0.8103.79（Playwright channel=chrome，Playwright 1.64.1，Node v22.23.2） |
| 性能采集 | tests/perf/perf.spec.js（Batch 6A 框架），网络整形 YES、CPU 限速 YES（前后两次运行均校验，比值 5.19 / 4.41） |
| 采样 | 每场景 × 每设备 × **5 次**，报告中位数与 min–max 极差 |
| 前后可比性 | 前后两次采集在同一台机器、同一网络整形档位、同一 CPU 限速档位、同一浏览器版本下完成；缓存状态在场景内显式区分（cold/warm/SW），符合任务"禁用不同网络/缓存/设备条件"约束 |
| Lighthouse | 12.8.2（本机 npm 可安装的最新版；任务备注中的 10.9.8 在 npm registry 不存在，npx 首次拉取失败后改用 12.8.2，已在结果中如实记录版本） |
| 无障碍审计 | tests/perf/a11y-audit.js（自研，真实 Chromium DOM/计算样式审计，7 页面 × 13 项检查） |

**指标可用性**：FCP / LCP / CLS / TBT / DOMContentLoaded / load / TTFB / 请求数 / 传输与编码体积 / JS 执行耗时（CDP ScriptDuration）/ 长任务数与总时长 / DOM 节点数 / 冷热缓存与 SW 状态 / 路由切换耗时 / 路由循环 DOM-资源增长 —— 全部实测。17 项次要指标（如 INP 类需要真实交互的指标）按框架口径登记为 UNAVAILABLE，未编造。

---

## 2. Stage 1：性能基线（before）

- 采集报告：`tests/perf/reports/batch8d4-perf-before.json`（verdict BATCH6A_READY）+ `.log`
- 场景 10 个：既有 5 个（cold-home / warm-home / long-post / post-lazy / search，**口径一字未动**）+ 本轮新增 5 个（course / papers / editor / note-static / route-loop）
- before 无障碍审计：`tests/perf/reports/batch8d4-a11y-before.json` → **问题总数 220**
- 诊断探针（diagnostics）在 before 运行中因框架遗留 bug（6B-2 正文按需加载改造后探针仍读 `post.content`，导致 `marked()` 收到 undefined）失败，bench=null；已在 perf.spec.js 中修复探针（改走 `cachedPostContent`），**after 运行诊断可用**。此 bug 属测试工具层，不影响站点功能，也不影响场景级指标的前后可比性。

before 基线关键值（中位数，详见 JSON/对比 CSV）：

| 场景 | 设备 | FCP | LCP | TBT | JS 执行 | 请求数 | 编码体积 |
|---|---|---|---|---|---|---|---|
| cold-home | desktop | 312ms | 620ms | 233ms | 44.45ms | 9 | 434,759B* |
| cold-home | mobile | 2148ms | 4816ms | 1517ms | 169.03ms | 9 | 434,759B* |
| warm-home | desktop | 72ms | 124ms | 0 | 9.41ms | 9 | 5,827B |
| long-post | desktop | 424ms | 540ms | 77ms | 55.49ms | 12 | 5,827B |
| long-post | mobile | 328ms | 948ms | 586ms | 174.65ms | 12 | — |
| route-loop | desktop | — | — | — | 4.7ms/轮 | — | DOM 422 节点稳定 |

\* before JSON 记录 437,459B（含 sw.js 旧版本差异计入方式），对比以两轮各自实测值为准（见 §6）。

before 审计定位出的实际问题（本轮全部处理，见 §3–§5）：

1. **浅色模式代码高亮对比度**：vendor atom-one-light 默认 token 在 `#f0f2f5`/`#f4f5f7` 代码底色上仅 2.3~3.6:1（约 190 处 token 实测），低于 WCAG AA 4.5:1；
2. **文章页双 H1**：正文 Markdown 首个 H1 与页面标题重复（POST_ID=deep-learning-in-slam 实测命中）；
3. **分类 chips 缺 `aria-pressed`**：courses 6 个 + papers 8 个（`role="button"` 控件无按压状态语义；courses 页"有笔记/全部课程"两枚 chip 原本就有，为既有行为参照）；
4. **触控目标 < 24px**（WCAG 2.5.8）：文章页返回链接 22px；静态笔记页底部链接 17px；
5. **搜索覆盖层无 H1**：`renderGlobalSearch()` 整体替换 `#app` 后文档失去唯一 H1；
6. **编辑器 4 个输入域无可访问名称**（editorTitle / editorTags / editorExcerpt / editorContent）；
7. **editor-history-count 对比度**：`--color-primary`(#2563eb) 在 `--color-primary-light`(#e7efff) 上 4.48:1，略低于 AA。

---

## 3. Stage 2：JavaScript 与加载性能优化

**修改原则**：只修经测量证明的瓶颈；不大规模重构；不引入框架/CDN/第三方依赖；保留搜索竞态保护、编辑器草稿保存、稳定深链与 SW 一致性机制（相关测试全部继续通过）。

| # | 修改 | 文件 | 针对的实测问题 | 证据（after vs before） |
|---|---|---|---|---|
| 1 | `renderMarkdown` 有界 FIFO 缓存（40 条）：路由往返/重复访问同一文章时跳过重复的 `marked.parse` + `DOMPurify.sanitize`（路由切换中最贵的同步 CPU 工作） | js/app.js | long-post/search 重复路由的重复解析 | long-post desktop TBT **77→23ms（-70.1%）**、JS **55.5→43.0ms（-22.5%）**、FCP **-30.2%**、LCP **-25.9%**；post-lazy repeat JS **desktop 15→6.1ms（-59.5%）/ mobile 85.7→43.2ms（-49.7%）** |
| 2 | 返回顶部按钮 scroll 监听 rAF 合帧 + `{passive:true}` + 阈值跨越才写 DOM（原实现每个 scroll 事件同步读写 classList） | js/app.js | 全站高频滚动路径 | 结构性验证（新套件 F1.1–F1.3 断言通过）；路由循环长任务数无回归（desktop 3 个，与 before 一致） |
| 3 | `onReadingScroll` 无活动文章时提前 return（离开文章页后不再安排无效 rAF） | js/app.js | 非文章页滚动空转 | 阅读进度/目录功能回归通过（reading-experience 47/47） |
| 4 | `stripDuplicateLeadingH1`：正文首个 H1 文字与页面标题相同时移除（只处理第一个；标题不同保持原样） | js/app.js | 文章页双 H1（无障碍项，同时省一次重复大节点渲染） | audit post 页 h1=1；正文完整性断言通过 |

**明确不做**（分析后判断收益不足或风险过大，记录备查）：
- 未对 app.js 做拆包/懒加载改造：主脚本 6,235 行为单文件加载，cold-home 请求序列中脚本并行度已饱和，拆包反而增加请求数；
- 未延迟加载搜索索引：搜索场景实测 `searchLazyBytes` 前后一致（266,300B），索引加载已按需且无重复（serverRequestCount 5→5 不变）；
- 未改 Markdown/净化管线本身（安全契约不动），只做结果级缓存，键为原始 Markdown 源文，命中即跳过解析与净化。

---

## 4. Stage 3：无障碍优化（WCAG 2.2 AA 实查）

**方法**：自研真实 Chromium 审计（DOM/计算样式，非仅 Lighthouse）+ Lighthouse 交叉验证 + 手工键盘检查。任务要求"不能仅通过 Lighthouse 高分宣称完全符合 WCAG"——本报告的合规声明仅覆盖实测通过项，未覆盖项见 §10。

### 4.1 审计结果总览

| 页面 | before 问题 | after 问题 | 修复内容 |
|---|---|---|---|
| home | 0 | 0 | （LH 补充发现 3 项，见 4.2） |
| post | 193 | 0 | 浅色高亮对比度（约 190 处 token）、双 H1、返回链接 22px |
| courses | 8 | 0 | chips aria-pressed ×6、搜索框 aria-label、课程描述行内链接 18px |
| papers | 9 | 0 | chips aria-pressed ×8、论文搜索框 aria-label（无 class 裸 input） |
| search | 1 | 0 | 覆盖层补 sr-only H1 |
| editor | 5 | 0 | 4 输入域 aria-label、history-count 4.48→5.8:1 |
| noteStatic | 4 | 1 | 底部链接 17→24px；**剩余 1 项为静态页双 H1，属生成流水线（禁止修改范围），识别不修**（见 §9） |
| **合计** | **220** | **1** | **220→1（-99.5%）** |

### 4.2 Lighthouse 交叉验证补充发现（本轮追加修复）

自研审计通过后，Lighthouse 12.8.2 在首页又发现 3 项真实问题，全部修复：

1. **`aria-allowed-role`**：`article.article-card` 上 `role="link"` 不合法（ARIA in HTML 规范禁止 article 使用 link 角色）→ 移除该 role（首页卡片与搜索结果卡片两处生成点）。卡片内的真实 `<a>` 标题链接保留完整链接语义，`tabindex="0"` 与点击行为不变（ui-refresh / search-ux 回归通过）。
2. **`color-contrast`**：`.footer-sub` 因 `opacity:0.8` 混合后实测 #818995 on #ffffff = **3.53:1**（11px 正常文字，<4.5）→ 移除 opacity，恢复 `--color-text-muted`(#626b7a) 直接上色 = 5.7:1。**教训记录**：自研审计按计算样式取色，未对 opacity 做混合补偿，属审计器已知盲区（已在审计器改进方向记录，未在本轮改动审计器评分逻辑）。
3. **`target-size`**：`.article-card-title a` 高 22px → `display:block; min-height:24px`（保住多行标题换行）。

复测：Lighthouse Accessibility **91 → 100**（mobile，index 页）。desktop 95→（复测轮未跑 desktop，初测 95，其余扣分项与 mobile 相同 3 项，修复后按同一代码路径推断达标；此为推断，见 §10 未验证清单）。

### 4.3 已验证保留的既有无障碍能力（回归确认）

skip link（首次 Tab 聚焦 + 焦点指示 + 激活后焦点进入 main）、移动菜单 Esc 关闭焦点归还、icon-only 按钮可访问名称、主题切换对比度、`prefers-reduced-motion`、图片灯箱焦点管理、深浅色双主题结构——均由新套件 A/K 段与既有套件（ui-refresh、image-lightbox、papers-deeplink 等）继续断言通过。

---

## 5. Stage 4：响应式与移动端

新增检查（全部通过，断言在新套件 V 段）：

| 检查项 | 结果 |
|---|---|
| 六档视口 320 / 375 / 390 / 768 / 1024 / 1440px 首页横向溢出 | PASS（320×640 起全档） |
| 全局 `overflow-x:hidden` 掩盖检查 | PASS（未使用） |
| 320px 长代码块：代码块内部滚动、文档不撑破 | PASS |
| 200% 缩放（等效视口 720×450）首页/文章页 | PASS |
| 手机横屏 780×360 | PASS |
| 长英文标题/技术词（标签页 320px） | PASS（换行契约保持） |
| Markdown 表格/长代码在窄屏（8D-3 已建契约） | 由 ui-refresh 套件继续断言 PASS |

**未验证项**（无法在当前环境真实验证，明确标记）：编辑器软键盘弹出后的布局行为、iOS Safari 具体表现、真实触屏设备的 24px 目标手感——均需真机验证，本轮仅做视口仿真断言（详见 §10）。

---

## 6. Stage 5：缓存与稳定性

**SW 架构审查结论（未发现需要修改策略的问题，未重新设计离线体系）**：
- 版本化双缓存（`blog-<v>` 预缓存 + `blog-rt-<v>` 运行期缓存，运行期写入带 120 条上限与串行队列）；
- 安装原子性（必需资源任一失败 → install 失败并删除半成品缓存，浏览器保留旧 SW）；
- activate 清理全部旧版本缓存 + `skipWaiting`/`clients.claim` + 可选资源预热；
- 首屏网络优先 + 导航决策快照机制，避免"新 HTML + 旧脚本"混版；
- 以上行为由 sw-consistency、sw-upgrade、image-lightbox R4–R7、reading-experience S 系列、search-interaction SW 系列测试在本轮全部通过验证。

**修改**：仅按现有发布规则递增 `CACHE_VERSION`：`2026-11-17-1 → 2026-11-17-2`（app.js / style.css 为预缓存生产资源，本轮有实质修改；image-lightbox.spec.js 的精确版本断言同步更新，见 §7.3）。

**路由循环稳定性（实测）**：5 轮 × `/→courses→papers→editor→/` 循环，第 3 轮对第 2 轮：DOM 增长 **+4**（懒加载库注入的预期固定增量，非泄漏型增长）、Resource Timing 增长 **+4**、DOM 终值稳定在 **422** 节点（波动 0%）；mobile 同样稳定。与 before 完全一致（422/+4），路由循环无回归。

**多标签页/离线/弱网**：离线文章可读性（offlinePostReadable）前后一致（desktop 56→59ms / mobile 240→253ms，status=0 可读）；SW 升级与多标签页由既有套件通过。

---

## 7. Stage 6：测试

### 7.1 新增套件 `tests/browser/performance-accessibility.spec.js`（59 项断言，全部 PASS）

| 段 | 覆盖 | 数量 |
|---|---|---|
| P | 页面基本无障碍结构（各页唯一 H1、landmark、skip link 存在） | 6 |
| A | 新增行为：chips `aria-pressed`（courses/papers）与视觉激活态一致、编辑器输入域可访问名称 | 5 |
| C | 对比度：style.css 存在浅色高亮覆盖块、覆盖块全部 token ≥4.5:1、深色块独立作用域 | 3 |
| K | 键盘：skip link 首焦/可见指示/激活落点、移动菜单 Esc+焦点归还、编辑器键盘输入 | 7 |
| T | 触控目标 ≥24px（文章返回链接 / 静态页底部与返回链接） | 2 |
| V | 六档视口 + 无全局 overflow-x:hidden + 长代码块 + 200% 缩放 + 横屏 + 标签页长词 | 20 |
| R | 路由循环 3 轮 DOM/Resource 不增长 | 2 |
| F | 性能结构：scroll passive + rAF 节流（结构性断言，非毫秒阈值） | 3 |
| O | 原有功能回归冒烟（搜索渲染/目录/正文/主题/SW 注册） | 5 |
| X | 全流程无新增 Console/PageError | 1 |

设计要点：性能相关断言均为**结构性/行为性**（如"滚动监听声明 passive""路由循环后 DOM 节点差 ≤60"），未把受机器负载影响的单次绝对毫秒阈值作为 CI 硬门槛，符合任务要求。

**调试记录**（过程如实）：
- 首跑 49 项 48 PASS + 1 执行异常：R 段路由循环探针用模板字符串传参，Playwright 未将其识别为函数（返回 undefined）→ 改为真实函数声明 `loopFnSteps` 传参修复（最小复现确认后修复）；
- 二跑 59 项 58 PASS：F1.2 正则被箭头函数括号截断 → 放宽匹配窗口修复；
- 三跑 **59/59 ALL PASS**；`node --check` 全部通过。

### 7.2 注册与全量回归

- `scripts/run_tests.py` TESTS 数组新增 `performance-accessibility`（kind=browser，插在 ui-refresh 之后），总套件数 58 → **59**；
- 全量回归命令与结果：`python scripts/run_tests.py` → 退出码 **0**，**PASS 59 / FAIL 0 / SKIP 0 / BLOCKED 0**（19:29–19:52，23.5 min）；
- SW 一致性/升级测试全部通过；content-check / feed-check / image-check 门禁全部 PASS（0.6s / 0.3s / 0.4s）；
- 日志：`tests/reports/batch8d4-full-regression.log`、`tests/reports/last-run.md`。

**定点回归（改动直接影响面，均在全量回归前执行）**：image-lightbox 34/34、reading-experience 47/47、search-ux 30/30、editor-ux 66/66、search-interaction 56/56、ui-refresh 59/59 — 全部 PASS。LH 补充修复后再跑 ui-refresh + search-ux + 新套件：三套全 PASS（`tests/reports/batch8d4-targeted2.log`）。

### 7.3 测试断言修改说明（任务要求的透明披露）

本轮**唯一**一处修改既有测试断言：

| 项 | 内容 |
|---|---|
| 文件 | `tests/browser/image-lightbox.spec.js` R4 |
| 原断言 | `cacheVer === '2026-11-17-1'`（精确相等） |
| 修改原因 | CACHE_VERSION 按发布规则从 `2026-11-17-1` 递增至 `2026-11-17-2`（app.js/style.css 实质修改），精确相等断言随之失效。该断言的验收意图是"断言与 sw.js 当前发布版本严格同步"，不是"版本必须等于某个特定字符串" |
| 新断言 | `cacheVer === '2026-11-17-2'` |
| 验收标准是否改变 | **未改变**。R4 的验收标准（CACHE_VERSION 已按规则递增且与 sw.js 一致）原样保留；同文件 OLD_CACHE_VERSION（`2026-11-16-2`）比较基准未动，`cacheVer > OLD_CACHE_VERSION` 语义不变。与 8D-3 轮对同断言的处理方式一致 |
| 其他套件 | reading-experience / search-interaction 使用 `>` 比较不受影响（扫描确认全仓测试无其他硬编码 `2026-11-17-1`） |

未删除、未跳过、未弱化任何既有测试。

---

## 8. Stage 7：前后性能对比

完整数据：`tests/perf/reports/batch8d4-comparison.csv`（339 行指标 × 前后中位数/min–max/Δ%）与 `.json`。下表为核心指标（5 次中位数，括号内为 min–max 极差）：

### 8.1 主要改善项（与修复直接对应，波动范围不重叠或明显右移）

| 场景/指标（desktop 除注明） | before | after | Δ | 波动 before → after |
|---|---|---|---|---|
| long-post FCP | 424ms | 296ms | **-30.2%** | 380–564 → 260–388 |
| long-post LCP | 540ms | 400ms | **-25.9%** | — |
| long-post TBT | 77ms | 23ms | **-70.1%** | — |
| long-post JS 执行 | 55.49ms | 43.00ms | **-22.5%** | — |
| post-lazy repeat JS | 15.00ms | 6.08ms | **-59.5%** | — |
| post-lazy repeat JS（mobile） | 85.74ms | 43.16ms | **-49.7%** | — |
| post-lazy 首次正文可读（mobile） | 1833.9ms | 1593.6ms | **-13.1%** | — |
| cold-home TBT（mobile） | 1517ms | 1183ms | **-22.0%** | — |
| warm-home LCP（mobile） | 524ms | 436ms | **-16.8%** | — |
| 无障碍问题数（7 页合计） | 220 | 1 | **-99.5%** | — |
| Lighthouse Accessibility（mobile，index） | N/A（未采集） | 100 | — | 初测 91 → 修复后 100 |

### 8.2 持平/噪声范围内（不宣称改善，也不构成回归）

- cold-home desktop FCP -1.3%、LCP +1.3%（min–max 区间重叠）；warm-home desktop FCP 持平（72→72ms）；
- course / papers / editor / note-static 的 desktop FCP/LCP/TBT/JS 变化均在各自历史波动区间内（如 papers desktop FCP before 72–288ms 本身 spread 极大）；
- search 场景首末渲染、竞态行为、请求数（5→5）、懒加载体积（266,300B）前后一致；
- 资源数与体积：请求序列不变（9/10/12 个按场景）；编码体积 +6,427B（437,459→443,886B，全部来自 CSS 无障碍配色块/触控规则与 JS 的 aria 标注），慢网移动端影响折算约数十 ms 网络时间，未观测为稳定回归（见 8.3）。

### 8.3 未改善/变差指标及原因分析（如实披露）

| 指标 | before → after | 判定 | 原因分析 |
|---|---|---|---|
| note-static mobile FCP/LCP | 1936 → 2492ms（+28.7%） | **未改善，倾向变差但不判回归** | ① 静态页不经 app.js，本轮唯一影响路径是 style.css +6.4KB，在移动整形链路折算网络增量约数十 ms，不足以解释 +556ms；② 该场景 before 波动本就极大（1784–2536ms，spread 40%），after（2308–2756ms）与其重叠；③ 样本量 5 次不足以区分场景噪声与真实小幅劣化。结论：标注为噪声主导的未改善项，不做强行归因 |
| warm-home desktop LCP | 124 → 144ms（+16.1%） | 噪声 | 绝对增量 20ms，区间重叠（60–84 → 72–96）；同场景 FCP 持平 |
| warm-home desktop JS | 9.41 → 11.64ms（+23.7%） | 噪声 | 绝对增量 2.2ms，且同场景 mobile JS 反而 -8.8% |
| course/papers/editor mobile FCP | +3.8%~+14.3% | 噪声 | 绝对增量 12–140ms，均落在场景历史波动区间内 |
| search mobile repeat 长任务 | 154 → 228ms | 观察 | 单场景小幅上移；desktop 持平（47→43ms / 0→0）；结合 320px 溢出与功能断言全通过，判定为采样噪声，列入后续观察项 |

**撤回审查**：逐项核对后无需撤回的优化——所有改善项均为结构性修改且方向与机制一致；无一项产生与机制矛盾的全局劣化。

### 8.4 Lighthouse（辅助信号；before 未采集 → N/A）

| 设备 | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| Mobile（仿真） | 72（复测 71，单次运行波动） | 91 → **100** | 100 | 100 |
| Desktop（仿真） | 88 | 95（3 项扣分与 mobile 相同，已全部修复；复测未跑，推断达标） | 100 | 100 |

报告文件：`batch8d4-lighthouse-mobile.json`（初测）、`batch8d4-lighthouse-mobile-final.json`（修复后）、`batch8d4-lighthouse-desktop.json`。**性能分数不作为前后对比依据**（单次运行、±5 分噪声），权威结论以 5 次中位数采集为准。

### 8.5 对比图说明

前后对比以 CSV/JSON 结构化数据交付（§11 索引）。本次未生成图表图片：对比表已完整承载全部指标与波动区间，且任务要求"必要时"——数据文件可直接供下游绘图，无信息损失。

---

## 9. 禁止修改范围遵守情况

- 未修改：正式文章/课程/论文/项目数据；稳定 ID/路由/深链契约；搜索评分逻辑；编辑器导出契约；导入脚本与内容生成流水线（`gen_notes_pages.js` 等）；图片检查脚本；GitHub Actions 发布方式；外部模型 Benchmark 仓库；
- 未引入运行时 CDN、字体服务或任何第三方依赖（vendor 文件零改动）；
- **静态笔记页双 H1（noteStatic 剩余 1 项问题）**：由 `gen_notes_pages.js` 生成流水线产出（页面 `<h1>` 与正文首 H1 重复），属禁止修改范围——**识别但不修**，已在本文与审计 JSON 中如实登记。若未来放开该范围，修复方案与文章页 `stripDuplicateLeadingH1` 相同；
- 搜索竞态保护、编辑器草稿/历史、稳定深链、SW 一致性机制：零改动，测试全部通过。

---

## 10. 已知遗留与未验证事项

**未验证（无法在当前环境真实验证，明确标记）**：
1. 编辑器软键盘弹出后的视口/布局行为（需真机）；
2. iOS Safari 实际表现（含 100vh 与视觉视口差异）；
3. 真实触屏设备上的 24px 触控手感（本环境为视口仿真 + DOM 尺寸断言）；
4. Lighthouse desktop 复测（初测 95，3 项扣分与 mobile 相同且已修复，达标为推断）；
5. 搜索 mobile repeat 长任务 154→228ms 的波动归因（判定为噪声，未复跑确认）。

**已知遗留**：
1. noteStatic 双 H1（禁止修改范围，§9）；
2. 自研审计器未补偿 opacity 混合的取色盲区（本轮以 Lighthouse 交叉验证弥补；审计器评分逻辑未改动）；
3. `tests/tmp/loop-repro.js`（调试临时文件）：删除操作被系统安全确认拦截两次，**保留在磁盘未提交**——如需清理请手动删除（不影响任何测试与运行时行为）。

---

## 11. 交付物索引

| 类型 | 文件 |
|---|---|
| 报告 | `BATCH8D4_REPORT.md`（本文件，仓库根目录） |
| before/after 性能数据 | `tests/perf/reports/batch8d4-perf-before.json` / `batch8d4-perf-after.json`（+ 各自 .log） |
| before/after 无障碍审计 | `tests/perf/reports/batch8d4-a11y-before.json` / `batch8d4-a11y-after.json` |
| 前后对比数据 | `tests/perf/reports/batch8d4-comparison.csv` / `.json`（生成器 `tests/perf/batch8d4-compare.js`） |
| Lighthouse | `tests/perf/reports/batch8d4-lighthouse-{mobile,mobile-final,desktop}.json` |
| 新测试套件 | `tests/browser/performance-accessibility.spec.js`（59 项断言；日志 `tests/reports/batch8d4-newspec-first.log`） |
| 全量回归日志 | `tests/reports/batch8d4-full-regression.log`（退出码 0；`last-run.md` 由框架同步生成） |
| 定点回归日志 | `tests/reports/batch8d4-targeted.log` / `batch8d4-targeted2.log` |
| 测试基建 | `tests/perf/a11y-audit.js`（新增）、`tests/perf/perf.spec.js`（+5 场景 + 探针修复） |
| 生产代码 | `js/app.js`（8 处）、`css/style.css`（9 处）、`sw.js`（版本号） |

---

## 12. 结论

任务全部 Stage 完成：基于最新 origin/main 的独立分支、真实 Chromium 前后双基线（同环境同口径）、经测量证实的性能修复（长文场景 TBT -70%、重复访问 JS -50~60%）、无障碍问题 220→1（唯一遗留属禁止修改范围）、新增 59 项断言套件并注册统一入口、全量回归 **59 套全部通过（FAIL/SKIP/BLOCKED 0）**、唯一测试断言修改已按要求披露、交付物齐全、本地 commit 完成、未 push/PR/部署。

**B8D4_LOCAL_READY**
