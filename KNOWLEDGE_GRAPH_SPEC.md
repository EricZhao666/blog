# KNOWLEDGE_GRAPH_SPEC.md — 全站知识图谱规格（Batch 9B-2）

纯静态 GitHub Pages 架构内的知识图谱：无后端、无 AI API、无 Embedding、无向量/图数据库、
无大型图可视化框架（原生 SVG）。

## 1. 路由与入口

- 正式路由：`#/graph`（与现有 hash 路由架构一致）。
- 入口：知识库页头部「🕸️ 知识图谱」链接（`km-head-actions`）。不改动顶部主导航。
- 资源全部按需加载：`js/knowledge-graph.js`（纯计算）→ `js/graph-demo.js`（SVG UI）→
  `data/content-links.json`（构建期索引）。**首页首屏零新增请求**（已实测）。

## 2. 节点

复用 `type:refId` 稳定键，来自构建索引（权威源见 CONTENT_LINK_FORMAT.md §3）：

| 类型 | 数量（当前数据版本） | 跳转 |
|---|---|---|
| post | 18 | `#/post/<id>` |
| course | 45 | `#/course/<id>` |
| paper | 32 | `#/papers?kind=paper&target=<id>` |
| material | 74 | `#/papers?kind=material&target=<id>` |
| lib | 6 | `#/codelib/<id>` |
| project | 6 | `#/project/<id>`（example 标记保留并在 UI 标注） |
| note | 14 | `notes/<slug>.html`（真实静态页） |

合计 195。不存在独立详情页的内容使用真实既有跳转；失效目标不生成节点。
工程实验（lab）本轮未纳入：无稳定内容 id 与明确关联依据，属可选扩展。

## 3. 关系（严格三分，每条可说明来源）

1. **显式引用 explicit**（有向 source→target，箭头）：正文站内 Markdown 链接 + WikiLink。
   反向链接由真实显式引用自动推导（`byTarget`）。当前 6 条。
2. **同系列 series**（无向，灰色实线，独立说明「非正文引用」）：真实 `series` 字段。当前 4 条。
3. **推断关联 inferred**（无向，橙色虚线，明确标注「算法推荐，非正文引用」）：
   复用 9B-1 `Related.recommend()`，**权重/阈值/推荐理由一律不改**。当前 514 条（无向去重后）。

去重与自环：构建期按 (source,target,via) 确定性去重、排除自环；真实循环引用保留。
推断边按码元序规范化无向对，取双向较高分。

### 推断候选池（固定）

候选池 = 索引内**全部节点**（同一数据版本 → 同一图谱）。不读取用户浏览历史、
个人收藏或会话状态，因此全站图谱不会因用户先前访问不同页面而变化。
`Related` 缺失时推断边为空但显式/系列仍在，UI 不误判「没有关联」。

## 4. 布局与性能预算

- 确定性 O(N) 布局：7 个类型簇均匀分布圆周，簇内黄金角螺旋（phyllotaxis）。
  无随机、无 Date、无力导向迭代，无收敛问题。
- 实测（Node，当前数据）：模型 ~96ms、布局 ~1ms；浏览器模型 ~65ms、布局 ~1ms。
- 合成扩展：500 节点模型 ~755ms / 布局 <1ms；1000 节点模型 ~2.8s / 布局 ~1ms（预算 <5s）。
- 默认可见边上限 300：**展示层裁剪**，只裁低分推断边；显式/系列真实关系永不隐藏。
  裁剪时如实标注「已裁剪 N 条…被裁剪的关系依然存在」。
- rAF 仅用于拖动节流（每帧至多一次），路由退出即取消。

## 5. 交互

- 类型筛选 chips（7 类，含计数）、关系筛选 chips（3 类）。
- 搜索框：标题/ID 大小写不敏感匹配，Enter 定位并选中首个命中（中文可用）。
- 选中节点：详情面板显示标题、类型、示例标记、有效跳转、全部关联（方向/来源/理由）。
- 一跳邻居视图：选中后切换，仅显示中心 + 直接邻居；统计行如实标注「一跳局部视图」。
- 缩放（滚轮/双指捏合）、平移（拖动/触摸）、重置视图。
- 键盘等价视图：列表视图按钮切换为可聚焦节点列表，↑/↓ 移动、Enter 选中；
  所有 chips/按钮有 focus-visible 轮廓与 aria-pressed。
- 孤立节点（无显式/系列关系，推断不计）：半透明显示 + 列表「孤立节点」徽标，不隐藏。

## 6. 生命周期与安全

- `router()` 每次切换调用 `GraphDemo.unmount()`：取消 rAF、移除 window 级
  pointerup/pointercancel 监听、清空拖动/捏合状态、销毁 DOM。幂等。
- 快速路由切换由 `_routeToken` 守卫，失效异步不渲染。
- 节点标题、关系理由、搜索文本一律 textContent/escapeHtml；跳转仅允许 `#/` 或
  `notes/*.html`（safeHref 白名单），杜绝 `javascript:` 与 HTML 注入。
- 索引/脚本缺失：明确降级提示（`.graph-degraded`），不阻塞站点其他功能。

## 7. 反向链接区（详情页）

- 文章/课程/项目详情页独立 `<section class="backlinks">`「🔗 引用本文的内容」，
  与「相关阅读」完全分离。
- 只展示构建索引 `byTarget` 的真实显式引用，标注来源类型与 via（正文链接/WikiLink）。
- 无反向引用时隐藏；索引缺失时局部降级（保持隐藏），不阻塞正文。
- 个人收藏绝不作为公开反向链接。

## 8. 离线与缓存

- SW `CACHE_VERSION` 递增至 `2026-11-24-3`；新增 4 个资源进 OPTIONAL_ASSETS
  （随 warmOptionalAssets 预热）：content-links.js / knowledge-graph.js / graph-demo.js /
  data/content-links.json。REQUIRED（8）与 FIRST_SCREEN（7）集合不变，缓存策略不变。
- 首次离线可用性以真实缓存条件为准（已实测：在线访问后离线重载图谱完整渲染）。
- 不清空 IndexedDB，不修改个人知识库 schema。

## 9. 已知限制（如实记录）

- 真实显式引用稀疏（6 条，全部 post→lib）；同系列 4 条；183 个节点无真实关系。
  本轮不批量改写正式文章，不为增加关系数量编造链接。
- WikiLink v1 仅 post 类型（课程 id 含竖线的歧义见 CONTENT_LINK_FORMAT.md §1.2）。
- 推断关联质量沿用 9B-1 算法上限，未调参。
- 合成 1000 节点模型构建 ~2.8s 为一次性同步计算（可接受预算内），未做增量/Worker 化。