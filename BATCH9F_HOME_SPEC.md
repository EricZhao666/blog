# Batch 9F 首页个人模块规格（BATCH9F_HOME_SPEC）

> 适用范围：`js/app.js` 的 `renderHome()` + `home*` 系列函数、`css/style.css` 的 `.hp-*`。
> 本文描述**已实现并验证**的行为；口径细节见 `BATCH9E_METRIC_DEFINITIONS.md`。

## 1. DOM 契约

```html
<div id="app">
  <header class="home-head">              <!-- 原有标题区，结构保留 -->
    <div class="home-head-row">
      <h1 class="page-title">文章</h1>
      <button id="homePrefsBtn" aria-expanded="false" aria-controls="homePrefsPanel">⚙ 首页设置</button>
    </div>
    <p class="page-desc">…</p>
    <p class="home-meta">共 N 篇 · 更新至 YYYY-MM</p>
  </header>
  <div class="home-prefs" id="homePrefsPanel" hidden></div>
  <div class="article-list">…原有文章卡片…</div>   <!-- 顺序、class、字段完全不变 -->
  <div class="home-personal" id="homePersonal"
       data-home-personal="1" data-home-state="loading|empty|ready|hidden|error|unavailable"></div>
</div>
```

**位置说明**：个人模块放在 `.article-list` **之后**。原因有两条：
1. 首屏文章内容优先可见（个性化不能拖慢或挤走文章）；
2. 保持既有首页选择器契约 —— `#app a[href^="#/post/"]` 的前 N 个仍然来自文章卡片。
   （首次实现曾放在列表之前，`knowledge-center` 的 K4.1 因此回归；见 `BATCH9F_REPORT.md` 第 6 节。）

搜索结果视图（`searchQuery` 非空）不渲染 `#homePersonal`，清空后由同一份 `renderHome()` 重新输出并挂载。

## 2. 模块

| key | 标题 | 上限 | 数据来源（只读） | 入口 |
| --- | --- | --- | --- | --- |
| `continue` | 继续阅读 | 3 | `Knowledge.list({ flag:'continue', limit:3 })`（沿用 9A-1 的 5%–95% + `reading` 规则） | 行内 `data-km-resume`（沿用 9A-1 恢复契约）+ 「查看全部」→ `#/knowledge?tab=continue` |
| `recent` | 最近浏览 | 6 | `Knowledge.list({ flag:'history', sort:'recent', limit:6 })`（`lastSeenAt` 排序） | 行链接到真实目标；「查看全部」→ `#/knowledge?tab=history` |
| `favorites` | 我的收藏 | 4 | `Knowledge.list({ flag:'fav', sort:'fav', limit:4 })` + `Knowledge.counts().fav` | 行链接到真实目标；「查看全部收藏」→ `#/knowledge?tab=favorites` |
| `directions` | 最近学习方向 | 4 | `LearningStats.summarize().recentDirections`（30 天窗口，9E 口径） | 「查看统计」→ `#/knowledge?tab=stats`；单项在存在对应真实标签时 → `#/tags/<tag>` |

顶部概览条（`.hp-overview`）只有在收藏/待读/阅读中/已完成任一 > 0 时出现，链接分别指向知识库对应 tab（完成后为 `tab=history&state=done`）。

### 2.1 失效内容
行内用 `kmResolve()` 判断目标是否存在：
- `missing` → 渲染 `.hp-row-broken`，文案「内容已删除或迁移」，**不生成任何 `<a>`**；
- `unknown`（元数据未加载）→ 仍按真实路由渲染（内容可能有效，不能误判为失效）。

### 2.2 方向入口规则
- 方向只来自内容元数据（文章 `tags`、课程/论文/代码库 `category`、论文 `collections`、项目 `tags`+`tech`），**不读标题**。
- 单项入口只在「已加载文章里存在属于该方向的真实标签」时生成 `#/tags/<encodeURIComponent(tag)>`；
  否则渲染为静态条（无链接），绝不生成 `#/direction/...` 之类不存在的路由。
- 方向计数之和可大于唯一内容数，UI 明写「可大于唯一内容数」。

## 3. 加载策略

1. `renderHome()` 同步返回完整首页（文章卡片 + 一个占位 div），不改动任何既有渲染路径。
2. `MutationObserver`（只观察 `#app` 的直接子节点）发现新的 `#homePersonal` 后挂载（`data-home-bound` 防重复）。
3. 第一阶段：`Knowledge.snapshot()` + 3 个 `list` + `counts()` → 渲染概览与 A/B/C/D 四个区块（D 先给 `role="status"` 占位）。
4. 第二阶段（`requestIdleCallback`，无则 `setTimeout 30`）：按需补齐方向所需元数据并计算，只替换 `#hpDirections`。
5. 数据变更（收藏/待读/进度/分类/导入/批量/其他标签页）复用 `Knowledge.subscribe` → `kmScheduleDataRefresh`（80ms 去抖）→ `homeRefreshPersonal()`；已渲染过的区块原地更新，不回闪加载态。
6. 请求代次 `_homeGen` + `isHomeRoute()` + `host.isConnected` 三重校验，过期结果一律丢弃。

## 4. 偏好（localStorage）

| 项 | 值 |
| --- | --- |
| 键 | `blog.home.prefs.v1`（与 `theme`、`blog.search.history.*`、草稿键完全分离） |
| 结构 | `{ v: 1, hidden: ['recent'], order: ['continue','recent','favorites','directions'] }` |
| 归一化 | 未知 key 丢弃；`order` 缺失项按默认顺序补齐；`hidden` 去重；`v !== 1` / JSON 损坏 / 非对象 → 全部默认 |
| 写入失败 | 先写内存副本（本会话生效），`localStorage` 异常时静默降级，不影响首页 |
| 恢复默认 | 删除键 + 清内存副本；面板保持打开，焦点回到「恢复默认布局」 |
| 预设 | `default`（继续→最近→收藏→方向）、`reading`（继续→最近→方向→收藏）、`collection`（收藏→继续→最近→方向） |
| 隐藏语义 | 只写偏好，**不删除任何知识记录**；全部隐藏时显示「个人模块已全部隐藏」+ 恢复入口 |

## 5. 状态与降级

| 状态 | 触发 | UI |
| --- | --- | --- |
| `loading` | 首次挂载 | 一行 `role="status"` 占位 |
| `empty` | 知识库 0 条记录 | 容器清空、无高度（首页与改动前一致） |
| `ready` | 正常渲染 | 概览 + 按偏好顺序的区块 |
| `hidden` | 全部模块被隐藏 | 收起提示 + 恢复按钮 |
| `error` | `snapshot()` 走缓存回退 / 抛错 / 读取失败 | `role="alert"`，清空旧内容，提供重试，**不展示旧数字** |
| `unavailable` | `window.Knowledge` 不存在 | 静默隐藏（不制造噪点） |
| 方向子状态 | `learning-stats.js` 加载失败 / 离线未缓存 | 仅方向区块显示「方向统计暂时不可用」，其它区块正常 |

## 6. 设置面板与无障碍

- 入口是原生 `<button aria-expanded aria-controls>`；面板为 `<fieldset>/<legend>` + 原生 checkbox。
- 键盘：Enter/Space 开关、Tab 遍历、Escape 关闭并把焦点交还入口。
- 隐藏/显示模块后**不重建面板**，焦点停留在当前复选框；改预设后 `aria-pressed` 同步且焦点不丢。
- 状态变化通过 `#homePrefsStatus`（`role="status" aria-live="polite"`）播报。
- 所有模块行是真实 `<a>`（可新标签打开、可键盘激活）；装饰性条形 `aria-hidden`，数值以文本呈现。
- 收藏按钮（`data-km-toggle`）若出现在模块内会与外层卡片导航冲突——模块行**不使用** `data-href`，因此 `kmEnhance()` 不会给它们注入卡片级按钮。

## 7. 性能边界

- 首屏同步新增内容：一个空 `div` 与一个设置按钮；无数据读取、无计时器、无网络请求。
- 首页方向计算按需加载：
  - 只有「最近 30 天确实浏览过、且类型为 course/paper/material」的记录存在时才加载 `courses.js`（15KB）/`papers.js`（42KB）；
  - **不加载** `codefiles.js`（380KB）：代码库记录在首页方向里按「元数据未知」处理（不进任何方向），其它模块不受影响。
- `js/learning-stats.js`（16KB）仍按需加载，首次进入首页且有记录时才请求；SW 运行期缓存复用。
- 不在滚动事件中重算；方向只在数据变更或重新挂载时算一次。

## 8. 与 9E 的差异（已知且有意）

| 场景 | 9E 统计页 | 9F 首页方向 |
| --- | --- | --- |
| 课程/论文元数据 | 有记录就按需加载 | 仅在最近窗口内浏览过才加载 |
| 代码库元数据（380KB） | 有 `lib` 记录时加载 | 不加载，按未分类处理 |
| 覆盖范围 | 全部记录 | 最近 30 天浏览记录 |

因此首页方向数可能与统计页方向数不同；首页文案标注「复用知识库统计口径」并只展示有数据的方向，不宣称唯一内容总数。
