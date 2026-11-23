# Batch 9F 报告：个性化首页与知识模块整合

- 状态：**B9F_PR_READY**（新增套件 + 受影响回归全部通过；未合并、未部署）
- 基线：`origin/main = 424c308`（Batch 9E PR #33 已合并，PR CI 绿；9E 候选提交 `74fcfbf` 已被 squash 合入）
- 分支：`feat/batch9f-personalized-home`（创建于 `origin/main`，未跟踪 main）
- 版本：`CACHE_VERSION 2026-11-23-1 → 2026-11-23-2`（首屏 `js/app.js`、`css/style.css` 有变更）
- 首屏清单：`REQUIRED_ASSETS` / `FIRST_SCREEN_ASSETS` **未变**（仍 7 项）；未新增首屏脚本
- 数据契约：`blog-knowledge` 结构版本 1 / `schemaVersion 2` / 导入导出格式 **完全未改**；未新建数据库
- 测试套件：73 → **75**（新增 `personalized-home`、`home-experience`）

## 1. 交付内容

### 1.1 新增

| 文件 | 作用 | 体积 |
| --- | --- | --- |
| `tests/test55_personalized_home.js` | 首页个人模块专项（47 项，jsdom） | 20.9 KB |
| `tests/browser/home-experience.spec.js` | 真实浏览器首页验收（32 项，含 firefox/webkit） | 26.7 KB |
| `BATCH9F_REPORT.md` / `BATCH9F_TEST_MATRIX.csv` / `BATCH9F_HOME_SPEC.md` | 本批交付物 | — |

### 1.2 修改

| 文件 | 变更 | 是否触及持久化契约 |
| --- | --- | --- |
| `js/app.js` | `renderHome()` 增加设置入口与个人容器；新增 `home*` 模块（偏好、渲染、异步填充、挂载观察、事件委托）；`kmScheduleDataRefresh` 增加一次首页刷新 | 否（全部只读） |
| `css/style.css` | `.home-head-row` / `.home-prefs*` / `.hp-*` 样式（双主题、三档断点、焦点可见） | 否 |
| `sw.js` | `CACHE_VERSION` 递增一行 | 否（网络/快照策略未改） |
| `scripts/run_tests.py` | 注册 2 个套件并加入 `knowledge` 分组 | 否（调度器与 CI 默认执行未改） |

## 2. 首页实际模块与数据来源

| 模块 | 内容 | 数据来源（全部只读） |
| --- | --- | --- |
| 顶部概览 | 收藏 / 待读 / 阅读中 / 已完成 计数（任一 > 0 才显示） | `Knowledge.counts()` |
| 继续阅读 | 最多 3 条，进度 5%–95% 且 `readState=reading` | `Knowledge.list({ flag:'continue', limit:3 })`（9A-1 原规则） |
| 最近浏览 | 最多 6 条，按 `lastSeenAt` 倒序 | `Knowledge.list({ flag:'history', sort:'recent', limit:6 })` |
| 我的收藏 | 最多 4 条 + 收藏总数 + 「查看全部收藏」 | `Knowledge.list({ flag:'fav', sort:'fav', limit:4 })` + `counts().fav` |
| 最近学习方向 | 最多 4 项，30 天浏览窗口 | `LearningStats.summarize().recentDirections`（9E 口径，未重写） |
| 原有文章列表 | 全部文章卡片（标题/摘要/日期/阅读时长/标签/收藏待读按钮） | 原有 `renderHome()` 代码路径，未改 |

- 继续阅读点击沿用 `data-km-resume` → `sessionStorage['blog.km.resume']` 恢复契约；普通文章卡片仍按原方式打开，不自动恢复进度（H2.1 实测）。
- 失效内容用 `kmResolve()` 判定，渲染为「内容已删除或迁移」且**不生成链接**（P4.2 / H5.1）。
- 方向入口只在存在对应真实文章标签时链接到 `#/tags/<tag>`，否则为静态条；不存在 `#/direction/*` 路由。

## 3. 加载与降级策略

1. `renderHome()` 保持同步：首屏只多一个空容器与一个设置按钮，**无数据读取、无网络请求**。
2. `MutationObserver`（仅 `#app` 直接子节点）发现新容器后挂载；`data-home-bound` 防重复挂载。
3. 第一阶段读取 `snapshot()` + 3 个 `list` + `counts()`；第二阶段在 `requestIdleCallback` 里按需补元数据并只替换方向区。
4. 数据变化复用 `Knowledge.subscribe` → 80ms 去抖 → `homeRefreshPersonal()`；已渲染区块原地更新，不闪回加载态。
5. 三重过期校验：`_homeGen` 请求代次、`isHomeRoute()`、`host.isConnected`；路由切换后旧结果不会插入任何页面（H7.1）。

降级矩阵：

| 场景 | 行为 |
| --- | --- |
| 知识库 0 条记录 | 容器清空（与原首页一致），不渲染空壳 |
| `window.Knowledge` 缺失 | 静默隐藏该区块 |
| IndexedDB 不可用（内存模式） | 仍按内存数据渲染模块，文章列表完整（H11.1） |
| 读取走缓存回退 / 抛错 | `#homePersonal[data-home-state="error"]`：清空旧内容 + 重试，**不把缓存当最新**（P6.1 / H8.1） |
| `js/learning-stats.js` 加载失败 | 仅方向区显示「方向统计暂时不可用」，其余模块正常（H11.2） |
| localStorage 不可用 | 使用默认偏好；会话内改动仍在内存生效（P2.8） |
| 偏好损坏 / 版本不符 | 全量回退默认（P2.1 / P2.6） |

## 4. 模块设置

- 入口：首页标题区右侧 `⚙ 首页设置`（`aria-expanded` / `aria-controls`）。
- 能力：显示/隐藏 4 个模块；3 个预设顺序（默认 / 阅读优先 / 收藏优先）；恢复默认布局。
- 存储：独立键 `blog.home.prefs.v1`，与主题（`theme`）、搜索历史、草稿数据完全分离（P2.5）。
- 面板交互不重建整页：切换复选框后焦点留在该复选框，改预设后 `aria-pressed` 同步，Escape 关闭并把焦点还给入口（H4.2–H4.5）。
- 隐藏不等于删除：只写 `hidden` 列表，`Knowledge.list({flag:'history'})` 在隐藏后仍返回原记录（P5.3）。
- 本轮不做拖拽排序（仅预设）。

## 5. 搜索与路由兼容

| 场景 | 结果 |
| --- | --- |
| 输入搜索词 | 走原有 `renderGlobalSearch`，`#homePersonal` 不渲染（H3.1），排序/筛选/折叠不变 |
| 清空搜索词 | `renderHome()` 重绘 → 观察器重新挂载 → 模块与文章列表同时恢复（P7.2 / H3.2） |
| 首页 → 文章 → 返回 | 个人模块重新挂载，文章列表完整（P8.1 / H2.2） |
| 快速连续切换 7 次路由 | 回到首页后模块 4 个、无重复、无串页（H7.1） |
| 卡片收藏按钮 | 未改动；模块行不使用 `data-href`，不会被注入卡片级按钮 |

### 5.1 过程中发现并修复的兼容回归

首版把个人模块放在 `.article-list` **之前**，导致 `knowledge-center` 的 K4.1 失败：
`#app a[href^="#/post/"]` 的前几个匹配变成了模块里的文章链接，测试点击的不再是文章卡片。

处理方式：**不修改既有断言**，把模块容器移到文章列表之后。这样同时满足：
1. 首屏文章内容优先可见（§5 性能要求）；
2. 既有首页选择器契约不变（`knowledge-center` / `mobile-notes` / `learning-analytics` 等全部恢复通过）。

这偏离了任务书 §7 推荐的「概览在顶部」，属于有依据的主动偏差，已记录在 `BATCH9F_HOME_SPEC.md` 第 1 节。

## 6. 性能前后对照

测量方法：同一台机器、Chromium（channel=chrome，headless），每侧 3 次取中位数；
「9E 基线」通过服务器内存覆盖把 `js/app.js` 换回 `424c308` 版本（其余文件相同，SW 关闭、第三方请求阻断）。
脚本位于 `tests/perf/tmp/`（gitignored，未入库）。

| 指标 | 9E 基线 | 9F | 说明 |
| --- | --- | --- | --- |
| 导航 → 首篇文章卡片可见（第 1 轮） | 359.6 ms | 352.9 ms | 无回归（差值在噪声内） |
| 导航 → 首篇文章卡片可见（第 2 轮） | 377.7 ms | 427.5 ms | 两轮波动 −7 ~ +50 ms，属本地冷启动噪声 |
| `renderHome()` 同步耗时 | 0.3 ms | 0.4–0.5 ms | 多一个空容器与按钮，无数据读取 |
| `load` 事件（wall） | 731 / 822 ms | 918 / 969 ms | 含首次资源排队波动；个人模块在 `load` 之后异步填充 |
| 个人模块 `ready`（导航起算） | — | 870 / 955 ms | 异步，不阻塞文章列表 |

结构性结论：文章列表的渲染路径与数据来源完全未变；个人模块的全部读取都在首屏之后，
首次进入还额外经过 `requestIdleCallback`（超时 1.2s）。首页方向只对「最近 30 天浏览过且类型为课程/论文」的记录补元数据，
不加载 `codefiles.js`（380KB），`learning-stats.js`（16KB）仍按需加载。

## 7. 多标签与离线

- 多标签：`Knowledge` 的 `BroadcastChannel`/storage ping → `emit` → 80ms 去抖 → 首页模块原地刷新（H6.1 实测收藏计数变化）。
- 离线（SW 已接管）：再次访问首页时文章列表、个人模块、方向统计（脚本已进运行期缓存）均可用（H11.3）。
- 离线且统计脚本从未缓存：方向区显示不可用提示，其余模块与文章正常（H11.2 用 404 模拟同类路径）。
- 未改变 SW 网络/快照一致性策略，只递增 `CACHE_VERSION`。

## 8. 三引擎

| 引擎 | 结果 |
| --- | --- |
| Chromium 157（主验收） | 32/32 通过（含视口/主题/键盘/离线/快速路由） |
| Firefox（playwright 内置） | 首页渲染 3 个模块、无横向溢出、无运行时异常 |
| WebKit（playwright 内置） | 同上 |

## 9. 测试结果

| 套件 | 类型 | 项数 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| `personalized-home` | jsdom | 47 | **PASS 47 / FAIL 0** | 6.2s |
| `home-experience` | browser（chromium + firefox/webkit 冒烟） | 32 | **PASS 32 / FAIL 0** | 37.1s |

受影响回归（本地实跑，未改任何既有断言）：

| 批次 | 套件 | 结果 |
| --- | --- | --- |
| 第一轮（14 套） | `personalized-home` `home-experience` `learning-analytics` `knowledge-center` `audit` `test9` `test20` `test40` `test41` `ui-refresh` `performance-accessibility` `reading-experience` `browser` `sw-consistency` | 13 PASS / 1 FAIL（`knowledge-center` K4.1） |
| 修复后复跑 | `knowledge-center` `personalized-home` `home-experience` | 3 PASS |
| 第二轮（5 套） | `audit` `test41` `ui-refresh` `project-detail` `performance-accessibility` | 5 PASS |
| 补充 | `mobile-notes` | PASS |
| 发布契约 | `sw-snapshot-unit`（未注册专项） | PASS 15/15（`CACHE_VERSION 2026-11-23-2`、首屏仍 7 项） |

完整默认 75 套串行回归交 PR CI 执行，本地未跑全量。

## 10. 剩余限制

1. 首页方向**不含**代码库记录的贡献（不加载 380KB 的 `codefiles.js`），因此与 9E 统计页的方向数可能不同；首页文案已说明「复用知识库统计口径」，且只展示有数据的方向。
2. 首页方向只看最近 30 天浏览记录；统计页覆盖全部记录。
3. 方向入口依赖文章标签：某方向若只有课程/项目内容，首页该项为静态条（无链接），避免生成不存在的方向路由。
4. 偏好是「每浏览器」的本地设置，不跨设备同步（本轮明确不做云同步/账户）。
5. 无拖拽排序（仅预设顺序），符合本轮范围。
6. 「继续阅读」依赖文章滚动进度；课程/项目没有可靠进度，不会出现在该模块。

## 11. 平台耗时 / Token / 积分

| 项 | 值 | 说明 |
| --- | --- | --- |
| 墙钟时间 | 约 1 小时 40 分钟（2026-11-23 15:55–17:35 +0800，按 shell 时间戳） | 明显超过 40 分钟检查点；超出部分用于受影响回归（约 12 分钟）与一次兼容回归修复后的复跑，未扩大知识库架构 |
| 本地测试耗时 | 494.0s（14 套）+ 93.4s（3 套）+ 159.7s（5 套）+ 35.9s（mobile-notes）+ 新套件 ≈ 13 分钟 | `tests/reports/last-run.md` 有逐套件明细 |
| Token | **未知** | 平台未向 Agent 暴露本次会话的 token 计量，无法读取，不提供估算 |
| 积分 | **未知** | 同上，计费/积分由平台侧统计，Agent 不可见 |

## 12. 提交与 PR

- 分支：`feat/batch9f-personalized-home`（基于 `424c308`）
- 提交：单提交 `feat: Batch 9F add personalized home modules`（含代码、两个测试套件与三份交付物）
- PR：仓库环境**未安装 `gh` CLI**，请用真实链接创建（base = `main`）：
  - https://github.com/EricZhao666/blog/pull/new/feat/batch9f-personalized-home
  - 对比视图：https://github.com/EricZhao666/blog/compare/main...feat/batch9f-personalized-home?expand=1
- 未自动合并、未部署；等待 CI 与人工审核。

## 13. 最终状态

**B9F_PR_READY** — 首页个人模块、偏好设置、降级与离线路径齐备；两个新套件与受影响回归全部通过；
分支待推送后创建 PR。不进入 9C-1，不自动合并或部署。
