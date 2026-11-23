# Batch 9E 报告：个人学习统计与知识分析中心

- 状态：**B9E_PR_READY**（本地专项 + 受影响回归全部通过；未合并、未部署）
- 基线：`origin/main = 5aa5e8d`（Batch 9A-2 PR #32 已合并）
- 分支：`feat/batch9e-learning-analytics`（创建于 `origin/main`，工作树干净）
- 版本：`CACHE_VERSION 2026-11-20-4 → 2026-11-23-1`（首屏 `js/app.js`、`css/style.css` 有变更）
- 首屏清单：`REQUIRED_ASSETS` / `FIRST_SCREEN_ASSETS` **未变**（仍 7 项）；
  统计脚本 `js/learning-stats.js` 按需加载，不升级为首屏必需资源
- 数据契约：`blog-knowledge` 结构版本 1、`schemaVersion 2`、导入导出格式 **完全未改**；
  未清空、未迁移、未新建数据库
- 测试套件：71 → **73**（新增 `learning-stats`、`learning-analytics`）

## 1. 交付内容

### 1.1 新增

| 文件 | 作用 | 体积 |
| --- | --- | --- |
| `js/learning-stats.js` | 纯函数统计模块（`LearningStats.summarize/build`、`classify`、规则与不支持项清单） | 16 179 B |
| `tests/test54_learning_stats.js` | 统计口径专项（65 项，无浏览器） | 17 827 B |
| `tests/browser/learning-analytics.spec.js` | 真实浏览器统计页验收（55 项，含 firefox/webkit 冒烟） | 36 159 B |
| `BATCH9E_REPORT.md` / `BATCH9E_TEST_MATRIX.csv` / `BATCH9E_METRIC_DEFINITIONS.md` | 本批交付物 | — |

### 1.2 修改

| 文件 | 变更 | 是否触及持久化契约 |
| --- | --- | --- |
| `js/app.js` | 统计视图渲染、路由分支、`kmLearningAnalytics()`、页面标题、已完成筛选、失败/重试 | 否（只读） |
| `js/knowledge.js` | 新增只读 `snapshot()`；`list({readState})` 只读筛选 | **否**：无 schema 变更、无新 store、无迁移 |
| `css/style.css` | `.km-tab-ext` + `.km-an*` 统计样式（双主题、三档断点、焦点可见） | 否 |
| `sw.js` | `CACHE_VERSION` 递增一行 | 否（网络/快照策略未改） |
| `scripts/run_tests.py` | 注册 2 个套件，加入 `knowledge` 分组 | 否（默认执行方式与并行调度未改） |

## 2. 数据契约与只读边界

统计层**不写任何数据**，也不新增 schema：

```js
// 只读快照：把"本次读取是否完整"跟随结果返回（新增，最小只读接口）
Knowledge.snapshot() -> { rows, source: 'database'|'cache', complete, warning }

// 只读筛选：跨类型查 done，不要求存在浏览历史（新增可选参数）
Knowledge.list({ readState: 'done' })

// 应用层聚合接口（9F 唯一入口）
kmLearningAnalytics() -> Promise<{ ok, summary, continueItems, status, complete, warning }>
```

- 选 `snapshot()` 而不是复用 `list({})`：`list` 在读取失败时会静默回退到缓存，无法区分"最新"与"回退"，
  统计页必须能识别并拒绝展示。
- 未新增 IndexedDB store/index，未修改 `SCHEMA_VERSION`、导入导出格式、记录字段。

## 3. 指标实现（详细口径见 `BATCH9E_METRIC_DEFINITIONS.md`）

| 指标 | 定义摘要 | 关键字段 |
| --- | --- | --- |
| 已浏览的不同内容数 | `lastSeenAt > 0`，按 `type:refId` 去重 | `lastSeenAt` |
| 收藏 / 待读 | `fav=1` / `later=1`，可重叠，重叠数单独输出 | `fav`、`later` |
| 阅读中 / 已完成 | `readState='reading'` / `'done'`（人工与自动分开计数） | `readState`、`stateSource` |
| 各内容类型分布 | 全部唯一记录 group by `type`，附 `viewed` 子计数 | `type` |
| 用户收藏分类分布 | `fav=1` group by `favCat`，映射真实分类名；已删除分类归"未知分类" | `favCat` + `meta.favCategories` |
| 最近浏览内容 | 已浏览记录按 `lastSeenAt` 倒序取 8 条，带 `metaState`（缺失可识别） | `lastSeenAt` |
| 最近接触的技术方向 | 最近 30 天浏览记录按方向归类计数 | `lastSeenAt` + 内容元数据 |
| 有效内容阅读完成率 | `done_posts / viewed_posts`，分母**只**含已浏览文章 | `readState`、`lastSeenAt`、`type` |

口径关键结论：

- **去重**：严格 `type:refId`；`key` 不作为统计键；重复保留 `updatedAt` 较新者。
- **不混语义**：`progress=100%` 不自动等于已完成；人工 `done` 与自动阈值 `done` 分开统计。
- **不强行计入**：课程/论文/资料/代码库/项目/笔记没有可靠逐段进度，不进入完成率分母，只给出条数。
- **缺失标注**：`missing`（内容已删除）与 `unknown`（元数据未加载）分开；都不猜测归类。
- **导入数据**：按文件里的真实 `lastSeenAt`/`doneAt` 计算，不伪造"今天学习过"。

## 4. 方向归属（Phase C）

- 只使用元数据：文章 `tags`、课程 `category`、论文 `category`+`collections`、代码库 `category`、项目 `tags`+`tech`；
  **不读标题**，不做关键词猜测以外的推断。
- ASCII 关键词按词边界匹配（`AI` 不会命中 `Training`），中文按子串匹配。
- 一条内容可属于多个方向，`directionTotals.assignments` 会大于 `uniqueContent`，UI 明确说明。
- 通用标签（技术笔记/随笔/生活/深圳/读书笔记）与"状态型"分类（已读/已读论文/课程论文）不入方向。
- 三类维度严格分离：内容原始标签（输入）→ 技术方向（统计）；`meta.favCategories`（用户分类）→ 收藏分类统计。
- 未改动 `js/related.js` 的推荐权重与评分规则。

## 5. UI 与路由

- 入口：`#/knowledge?tab=stats`（复用现有知识页，不新增顶层导航项）。
- 列表 tab 仍是 4 个 `.km-tab`（`继续阅读/收藏/待读/浏览历史`）；统计入口用独立 class
  `.km-tab-ext`，样式与 tab 一致，`role="tab"` + `aria-selected` 完整。
- 统计视图移除分类条与批量入口（`#kmCatBar` / `#kmBulkToggle` 不渲染），避免出现无效控件。
- 页面区块：总览指标卡 → 内容类型分布 → 技术方向分布 → 最近接触的技术方向 → 收藏分类 →
  最近浏览 → 继续阅读 → 数据范围与统计说明。
- 图表：纯 CSS 条形图（`div` + `width:%`），无新增图表库；条形带数值与百分比文本，装饰层 `aria-hidden`。
- 跳转：收藏/待读/阅读中/已浏览 → 现有 tab；已完成 → `#/knowledge?tab=history&state=done`
  （新增只读筛选，`fillKnowledgeTab` 用 `Knowledge.list({readState:'done'})`，不要求存在历史）。
- 继续阅读沿用既有 `data-km-resume` + `sessionStorage['blog.km.resume']` 契约，没有第二套进度恢复逻辑。
- 空库、加载中（`role="status"`）、读取失败（`role="alert"` + 重试）、降级 banner、未来版本只读说明均已实现。
- 深浅色：全部使用既有 CSS 变量，无硬编码颜色；390 / 768 / 1440 三档均验证无横向溢出。

## 6. 刷新、一致性与并发（Phase F）

| 触发 | 实现 |
| --- | --- |
| 收藏/待读/进度/状态/历史/分类/批量/导入 | 复用 `Knowledge.subscribe` → `kmScheduleDataRefresh`（80ms 去抖）→ `kmRerenderIfKnowledge` |
| 其他标签页 | 复用 `BroadcastChannel`/`storage` ping → `handleRemote` → `emit` → 同一去抖链路 |
| 滚动 | 不注册任何滚动监听；统计只在数据变更或进入路由时计算 |
| 高频变更 | 80ms 合并 + 请求代次 `_kmStatsGen`，旧结果不覆盖新数据 |
| 路由离开 | 写 DOM 前校验 `kmStatsRouteActive()`；守卫不通过直接丢弃 |
| 读取失败 | 清空 `data-km-an` 标记，替换为错误态（**不保留上一份数字**） |
| 二次进入 | 首次给加载态；后续原地替换，不闪烁 |

主动偏差（已评估）：架构文档提到"缓存 60s"，本轮**未实现时间型缓存**——它会在写入后 60s 内返回陈旧结果，
与"不得把旧结果当最新"冲突。改为"按数据变更触发 + 请求代次"，计算成本仅数毫秒（见第 8 节）。

## 7. 多标签与离线

- 多标签：收藏/批量/分类/导入在另一标签页变更后，统计页自动同步（浏览器用例 L8.1 实测 2→3）。
- 离线：
  - `js/learning-stats.js` 不属于首屏资源，走 SW 的"其他同源资源：network-first + 运行期缓存"分支；
    首次访问后进入 `CACHE_RT`，离线可再次打开（L15.1/L15.2 实测 6/6 指标）。
  - 从未加载过统计脚本且离线时，UI 显示"统计模块加载失败"并提供重试，不会显示 0 冒充最新。
  - 离线时统计值来自本地 IndexedDB 记录（L15.2 收藏 ≥1）。
- 未改变 SW 的网络/快照一致性策略；仅递增 `CACHE_VERSION`。

## 8. 性能与资源占用

| 项 | 实测 |
| --- | --- |
| 纯聚合 500 条（含元数据索引） | 1.65 ms（5 次平均） |
| 纯聚合 2000 条 | 2.56 ms（5 次平均） |
| 统计脚本体积 | 16 179 B（按需加载，首屏 0 字节增量） |
| 首屏资源数 | 7 项，未变（`sw-snapshot-unit` U0b 仍 PASS） |
| 新增依赖 | 无（无图表库、无新 npm 包） |
| 额外网络请求 | 仅在进入统计页且存在对应类型记录时，加载 `courses.js`（15KB）/`papers.js`（42KB）/`codefiles.js`（380KB，仅当存在 lib 记录） |
| 内存 | 统计结果对象仅数百字节级数组；不缓存全量快照，不常驻监听 |

说明：统计页不预先加载 `codefiles.js`（380KB）。若用户有代码库记录才按需加载一次，加载后由 SW 运行期缓存复用。

## 9. 新增测试结果

| 套件 | 类型 | 项数 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| `learning-stats` | node（无浏览器） | 65 | **PASS 65 / FAIL 0** | 0.1s |
| `learning-analytics` | browser（chromium；含 firefox/webkit 冒烟） | 55 | **PASS 55 / FAIL 0** | 37.1s |

受影响回归（本地实跑，未改任何既有断言）：

| 套件 | 结果 |
| --- | --- |
| `knowledge-store` / `knowledge-center` / `knowledge-import` / `knowledge-management` | PASS（4/4） |
| `audit` / `test7` / `browser` / `sw-consistency`(37) / `sw-upgrade`(25) | PASS（5/5） |
| `ui-refresh`(59) / `reading-experience`(47) / `related-content` / `project-detail` | PASS（4/4） |
| `tests/browser/sw-snapshot-unit.spec.js`（未注册专项） | PASS 15/15（U0b 首屏 7 项未变） |

完整默认串行回归（73 套）仍交 PR CI 执行，本地未跑全量。

## 10. 不提供的统计项（及原因）

| 项 | 原因 |
| --- | --- |
| 总访问次数 | 没有逐次浏览事件日志，每记录只有 `lastSeenAt` |
| 阅读时长 / 每天在线分钟 | 无计时采样，`progress` 只是滚动百分比 |
| 连续学习天数 | 历史上限 500 条会被裁剪；导入数据的日期来自文件，不代表真实学习日期 |
| 精确历史阅读频率 | 只有首次/最近浏览时间，没有中间序列 |

上述清单同时存在于 `LearningStats.UNSUPPORTED`、统计页说明区与本节，避免各处自造指标。

## 11. 9F 可复用接口

```js
// 1) 纯计算（无 IO，9F 可直接调用；测试固定 now 即可复现）
LearningStats.summarize({
  records,            // Knowledge.snapshot().rows
  categories,         // Knowledge.categories()
  content,            // { post|course|paper|material|lib|project: { [refId]: {title,tags,category,tech,collections} } }
  now, recentLimit, recentWindowDays
});

// 2) 应用层聚合（含完整性/降级/写入闸门信息；失败 reject）
kmLearningAnalytics().then(function (r) {
  r.summary.totals        // records/viewed/fav/later/reading/done/favLater/silent
  r.summary.types         // [{type,label,count,viewed}]
  r.summary.directions    // [{key,label,count}]（可多方向）
  r.summary.favCategories // [{id,name,system,count,unknown}]
  r.summary.recent        // [{key,type,refId,title,progress,readState,metaState}]
  r.summary.recentDirections
  r.summary.completion    // {viewed,done,rate,doneManual,doneAuto,excludedTypes,...}
  r.summary.quality       // {missing,unknownMeta,untitled,unknownFavCategory}
  r.summary.unsupported   // 不提供的指标清单
  r.continueItems         // 复用既有 continue 口径
});
```

约束：9F 只需读取上述结构，不要在前端重算去重/分母/方向；`summary.unsupported` 为"无数据来源指标"的唯一事实源。

## 12. 风险与后续

1. `Knowledge.list({readState})` 与 `snapshot()` 是新增只读入口，若后续 9F 需要"按时间范围"筛选，应继续加只读参数而非新 store。
2. 方向规则是显式关键词表，新增标签需要同步 `LearningStats.RULES`（有单测保护词边界行为）。
3. 统计页依赖内容元数据；`note` 类型暂无稳定映射，按"元数据未知"计入未分类（已在说明区标注）。
4. 未做"统计快照持久化"，刷新后重新计算（毫秒级），避免引入第二份可失真的数据。

## 13. 执行记录（时间 / Token / 积分）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 墙钟时间 | 约 50 分钟（2026-11-23 15:0x–15:5x +0800） | 超过 40 分钟检查点；超出部分主要用于受影响回归（397.5s）与三份交付物，未扩大知识库架构 |
| 本地测试耗时 | 122.8s（6 套）+ 274.7s（9 套）+ 37.1s（新浏览器套件）= 434.6s | 运行器 `tests/reports/last-run.md` 有明细 |
| Token | 估算 9–13 万（输入+输出合计） | **非精确值**：会话内无法读取 IDE 计量；按读取约 300KB 源码/文档 + 写入约 90KB 新文件估算 |
| 积分 | 估算 90–130（与 token 同量级） | **非精确值**：积分规则由 IDE 计费侧决定，Agent 侧不可见 |

## 14. 最终状态

**B9E_PR_READY** — 代码、两个正式测试套件、三份交付物齐备；本地专项与受影响回归全部通过；
已推送分支并创建 PR，未自动合并、未部署，不进入 9F。
