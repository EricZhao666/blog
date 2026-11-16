# Batch 8C-1：全站搜索 2.0 —— 相关性排序与多数据源可靠性

## 0. 基线说明

| 项目 | 值 |
| --- | --- |
| 本地目录 | `E:\work_funnycode\blog` |
| 仓库 | `EricZhao666/blog` |
| 新分支 | `feature/batch8c1-search-quality` |
| 分支基点 | `df9f390c04c3e93c7a60e9568001e93d7f2878da`（B8B3：草稿历史，已含 Batch 8B-3 全部能力） |
| 本地 `main` | `0f727be2b77f135bbc0838f733aeb5c1db23659f` |
| 任务给定 main | `d01998a3b385027c9594b2de2a3633e1920060f0`（本地对象库中不存在，见「已知限制」） |

改动范围：`js/app.js`、`css/style.css`、`sw.js`、`scripts/run_tests.py`、`package.json`，以及 3 个新增测试文件。没有新建第二套索引系统，没有改动任何生成器产物的数据格式（`js/data.js`、`data/search-index.json`、`js/courses.js`、`js/course-notes.js`、`js/papers.js` 均保持原契约）。

---

## 1. 原有搜索结构与发现的问题

### 原有结构

- `renderGlobalSearch(query)`：分别用 `String.prototype.toLowerCase().includes()` 过滤文章（`title/excerpt/tags/content`）、课程（`name/category/description` + 笔记正文）、论文（`title/authors/abstract`）、学习资料（`name/subcategory`），直接按数据文件原顺序分四组拼 HTML。
- `applyGlobalSearch(val)`：先 `app.innerHTML = renderHome()`，再用 `Promise.all([loadData('courses'), loadData('papers'), loadData('notes'), ensureSearchDocs().catch(...)])` 补数据，回调里又一次全量 `innerHTML = renderHome()` 并重新 `bindLiveSearch` + `input.focus()`。
- `ensureSearchDocs()`：首次搜索才请求 `data/search-index.json`，把正文挂回内存中的文章对象。
- `highlightMatch()`：先 `escapeHtml` 文本，再对转义后的查询做正则替换，插入 `<mark class="search-hit">`。
- `noteSearchHit()`：课程笔记正文首命中附近切片，单独做 Markdown 清洗与高亮。
- `papersDeepLink()` / `paperTargetKey()` / `materialTargetKey()`：Batch 7B-2 的论文 itemID、资料持久 ID（`lm-xxxxxx`）与 `lgx:` 兼容深链。
- `loadData()` + `_dataPromises` / `_dataFailures`、`_routeToken`、`bindLiveSearch()` 的 `compositionstart/end` 防抖、`readEntrySearch()` / `rememberEntryState()` 的前进后退恢复。

### 发现的问题

1. **没有统一结果模型**：四类数据各自 `filter` + 各自拼模板，无法做统一评分、排序和片段策略，也无法稳定复用安全渲染。
2. **没有相关性**：结果顺序完全等于数据文件顺序；标题完全匹配不会排在「只有正文提到关键词」的长文前面。
3. **失败不可见、可恢复性差**：`loadData()` 的 `catch` 吞掉错误且不 rethrow，调用方无法区分「加载失败」与「确实没数据」；`Promise.all` 里只有 `ensureSearchDocs()` 带 catch，任一遗漏都会产生未处理的 Promise rejection；失败源没有状态展示与重试入口。
4. **临时零结果被当成最终结论**：首次搜索时课程/论文/正文语料尚未加载，页面立刻显示「没有找到相关内容」。
5. **异步补齐代价偏高**：全量重建 `#app`、重新绑定监听并强制 `input.focus()`，在中文输入法组合期间有打断风险；快速连续输入只靠 `searchQuery.trim()` 比对，没有独立查询序号。
6. **展示信息不足**：文章正文命中无片段、论文无作者/摘要片段、学习资料名称与类别不高亮、类别只显示 `subcategory`；四类的片段/转义逻辑各写一份。
7. **潜在属性注入面**：结果容器的 `data-query` 若直接放原始用户输入，转义文本在 HTML 序列化回读时会把 `&lt;` 还原成属性内的 `<`，虽不构成执行但不够干净。
8. **重复计算**：每次输入都对全部文章正文重新 `toLowerCase()`，没有跨查询的轻量缓存。

---

## 2. 统一搜索结果模型

新增 `collectSearchResults(query)` 作为唯一的内存中间层，把四类数据整理成同一结构后交给渲染层；原始生成数据一字未改。

| 字段 | 含义 |
| --- | --- |
| `type` | `post` / `course` / `paper` / `material` |
| `id` | 现有稳定标识：文章 `post.id`、课程 `course.id`、论文 `paper.id`（Zotero itemID）、资料 `lm-xxxxxx` 或 `lgx:` 三元组键 |
| `title` | 纯文本标题（渲染时统一转义） |
| `description` | 摘要 / 作者 / 课程类别 / 资料类别等纯文本副标题 |
| `matchedFields` | 实际命中的字段名数组 |
| `score` | 确定性整数评分 |
| `targetUrl` | 原有有效路由，直接用于 `href` / `data-href` |
| `snippet` | `{ text, source, count, html }`，`html` 已转义并安全高亮；无片段时为 `null` |

辅助字段 `order`（数据原顺序）与 `hits`（各字段命中次数）只用于稳定排序与 UI 计数。

- 保留四类分组展示，组内按 `score` 降序排序。
- 深链仍由 `papersDeepLink('paper', paperTargetKey(p))` / `papersDeepLink('material', materialTargetKey(m))` 生成；**任何排序、筛选、数组重排都不会改变 ID**（`test39` 对 `LEARNING_MATERIALS.reverse()` 做了回归验证）。
- 渲染层拆成 `buildGlobalSearchHtml()`（纯字符串生成）与 `paintSearchResults()`（DOM 落地），所有文本统一经 `escapeHtml()` 或 `highlightMatch()`，`data-href` 一律 `escapeHtml()`，点击仍走原有 `[data-href]` 事件委托。

---

## 3. 相关性评分设计

评分 = `rank × 1000 + 有界次级分`，确定性整数，无随机数、无外部依赖。

### 主等级（严格优先级）

| 等级 | 命中方式 | `rank` | 主分 |
| --- | --- | --- | --- |
| 1 | 标题完整匹配（归一化后完全相等） | 6 | 6000 |
| 2 | 标题前缀匹配 | 5 | 5000 |
| 3 | 标题部分匹配（含中英混合多词同标题） | 4 | 4000 |
| 4 | 标签 / 作者 / 课程类别 / 资料类别 | 3 | 3000 |
| 5 | 摘要 / 描述 | 2 | 2000 |
| 6 | Markdown 正文 / 课程笔记 / 论文 Abstract | 1 | 1000 |

### 次级分（同等级内细分，硬上限）

| 字段等级 | 基础分 | 每次命中加成 | 单字段上限 |
| --- | --- | --- | --- |
| `meta` | 60 | 2 | 66 |
| `desc` | 30 | 1 | 33 |
| `body` | 10 | 1 | 13 |
| 跨字段多词 AND | 5 | 0 | 5 |

- 命中次数按字段 **封顶 3 次**（`SEARCH_HIT_CAP`），次级分总和再 `Math.min(bonus, 999)`，因此长文重复出现关键词既不会无限加分，也**绝不会跨等级反超**标题命中。
- 主分取所有命中字段中的最高等级；次级分只影响同等级内的相对顺序。
- `compareSearchResults()`：`score` → `order`（数据原顺序）→ `type` → `id`，同分结果稳定且可复现。
- 大小写：所有匹配在 `toLowerCase()` 后的字符串上做 `indexOf`，英文大小写不敏感；中文不参与大小写转换，直接子串匹配。
- 中英文混合：查询按空白与常见分隔符切成至多 8 个 token；完整串匹配优先，其次「同一字段包含全部 token」（AND），最后「关键词分散在不同字段」（跨字段 AND，`rank=1` + 5 分，最低优先级）。
- 查询长度截断 120 字符，正则元字符全部转义；未引入任何搜索库或网络搜索 API。
- 实测样例（`test39`）：`6000 > 5000 > 4000 > 3062 > 2031 > 1013`，对应「标题完整 / 前缀 / 部分 / 标签 / 摘要 / 正文」。

---

## 4. 多数据源加载与失败恢复

### 状态模型

`searchSourceStatus()` 汇总 5 类：`posts`（首屏 `js/data.js`，恒 `ready`）、`courses`、`notes`、`papers`、`docs`（`data/search-index.json`），每类状态为 `ready / loading / error / idle`。

结果页顶部固定显示 `.search-sources-status`：

- `已加载 N/5 类：…` 明确列出已完成的类别；
- 每个类别一个 badge（`✓ 已加载` / `⏳ 加载中` / `⚠ 加载失败` / `· 待加载`）；
- 失败类别带 `data-retry-search-source="<key>"` 的「重试」链接。

### 加载与故障隔离

- 复用 `loadData()` 的 `_dataPromises` 缓存、`ensureSearchDocs()` 的 `_searchDocsPromise` 缓存，并增加 `_searchLoadPromise`：正在加载的资源不会被重复请求。
- `loadSearchSource(key)` 把每个源的 Promise 先 settle 成 `{key, ok, error?}`，再用 `Promise.all` 汇合：**任何单源失败都不会 reject 整批**，也不存在未处理的 Promise rejection；`ok` 用真实就绪状态判断，避免 `loadData()` 静默吞错导致「假 ready」。
- 失败源不会在每次敲键时被反复请求，由状态条的「重试」显式恢复；`resetSearchSource(key)` 清除失败缓存后重新发起（`loadData` 保留 `_dataFailures` 以生成带 `retry=N` 的绕缓存 URL）。
- 只补齐「未就绪且未失败」的源；首次搜索仍按需加载，`focusin` 预热策略保留。
- 数据未到齐导致 `total === 0` 时显示「还有数据源尚未加载完成，暂时无法确定是否有结果…」，**不显示最终「无结果」**；数据到齐后自动补全结果。

### 竞态、输入法与历史

- `_searchSeq`：每次查询递增，异步回调只接受最新序号（`快速输入只显示最新查询`）。
- `_routeToken` + `isHomeRoute()` + `searchQuery.trim()`：路由切换后旧请求不重绘新页面。
- `_searchComposing`：捕获阶段的 `compositionstart/end` 监听；组合期间不重绘结果区、不重建也不重新聚焦输入框，组合结束补一次重绘。
- 搜索框在 `#searchBar` 内、结果区在 `#app` 内；`paintSearchResults()` 命中 `[data-search-root]` 时只更新容器内部，避免整页 DOM 重建。
- `rememberEntryState()` / `readEntrySearch()` 原样保留，浏览器前进后退可恢复关键词与结果。

---

## 5. 搜索结果展示优化

- 文章：标题高亮、标签高亮、摘要命中显示上下文片段、正文命中显示带 `正文命中` 标签的简短片段。
- 课程：标题 / 类别高亮、笔记状态与「笔记命中 N 处」、笔记正文或课程简介命中片段。
- 论文：标题 / 作者高亮、Abstract 命中上下文片段。
- 学习资料：名称 / 类别 / 子类高亮，明确显示 `category · subcategory`。
- 统一安全逻辑：所有文本经 `escapeHtml()`；`highlightMatch()` 在**已转义文本**上用「同样转义过并转义正则元字符」的查询替换，只插入 `<mark class="search-hit">`；片段由同一个 `makeSearchSnippet()` 生成（先取命中窗口再清洗 Markdown，输出限长 160 字符）。
- `data-query` 改为 `encodeURIComponent(query)`，属性值不含原始用户输入；`data-href` / `href` 全部 `escapeHtml()`，点击仍用 `#/post/<id>`、`#/course/<id>` 与 Batch 7B-2 深链。
- CSS 新增状态条 / badge / 片段标签样式，窄屏 `flex-wrap` + `overflow-wrap:anywhere`，390×844 视口实测 `scrollWidth == innerWidth == 390`。

---

## 6. 搜索性能

| 优化 | 说明 |
| --- | --- |
| 小写化缓存 | `_searchTextCache = new WeakMap()`，以原始数据对象 + 字段为键缓存 `{raw, lower}`；`raw` 变化（编辑器更新 / 用户文章合并）自动失效，兼顾一致性与速度 |
| 不解析整篇 Markdown | 只在字段命中后截取「命中前 36 / 后 84 字符」的小窗口做清洗与高亮，片段上限 160 字符 |
| 计算与渲染分离 | `collectSearchResults()` 纯计算 → `buildGlobalSearchHtml()` 生成字符串 → `paintSearchResults()` 局部落地 |
| 避免全量 DOM 重建 | 结果容器 `[data-search-root]` 存在时只 `root.innerHTML = ...`，不重建 `#app` 更不重建输入框 |
| 按需加载不变 | 首屏只依赖 `js/data.js`；`courses/notes/papers/search-index` 仍首次搜索（或聚焦预热）才请求，无新增后端、无新依赖 |

实测（本机，公开数据）：

- jsdom：100 次 `collectSearchResults('机器人')` = **32–71 ms**。
- Chromium：100 次 = **66 ms**；首屏 `domContentLoadedEventEnd` = **397 ms**（无回归）。
- 移动端 390×844：无横向溢出；状态条与 22 个片段正常渲染。

---

## 7. 新增测试

全部使用公开数据或合成 Fixture，未访问私人 Zotero 数据库 / 私人 Registry；已纳入 `scripts/run_tests.py`（并同步 `package.json` 的 `test:js` / `test:browser`）。

| 文件 | 类型 | 项数 | 主要覆盖 |
| --- | --- | --- | --- |
| `tests/test39_search_ranking.js` | jsdom | 37 | 统一模型字段、四类命中、六级优先级、评分严格递减、同分稳定、长文封顶、中文 / 大小写 / 中英混合、正文 / 笔记 / 摘要 / 类别搜索、XSS 与转义、四类深链与持久 ID、重排后 ID 不变、计算性能 |
| `tests/test40_search_sources.js` | jsdom | 35 | 按需加载、不重复请求、单源/多源失败不阻断、状态条与重试、无未处理 rejection、临时零结果、加载后补全、快速输入竞态、路由切换、IME 组合、前进后退恢复、深链非下标 |
| `tests/browser/search-ux.spec.js` | Chromium | 30 | 四类结果、标题高亮、摘要/正文片段、作者与资料类别、恶意查询与恶意标题净化、深链点击、历史恢复、竞态、中文输入法、数据源失败与重试、移动端无横向溢出、首屏/搜索计算性能、`CACHE_VERSION` 升级 |

对应任务列出的 20 项要求：1–10 由 `test39` + `test40` 覆盖；11–16、19 由 `test40` + 浏览器用例覆盖；17–18 由 `test39` + `test40` + 浏览器用例覆盖；20 由浏览器用例的首屏 DCL / 100 次计算耗时 / 移动端溢出检查覆盖。

**没有删除或弱化任何原有断言**；对注入故障产生的 jsdom 资源加载报错采用「仅豁免明确注入路径 + 断言豁免数量 + 其余错误一律计入失败」的精确处理。

---

## 8. 完整回归结果

先执行新增定点测试（统一入口 `--only test39 test40 search-ux`）：`PASS 3 / FAIL 0`，共 102 项全通过。

再执行一次完整回归：

```
python scripts/run_tests.py
== 汇总 ==
  PASS 48 / FAIL 0 / SKIP 0 / BLOCKED 0
  结论: PASS
```

- 原有 45 套测试全部保持通过（含 `audit`、`test6`–`test38`、`split-check`、`content-check`、`feed-check` 及原浏览器套件）。
- `Batch 7B` 稳定深链：`papers-deeplink` PASS（63/63）、`test21`/`test22` PASS。
- `Batch 8A/8B` 编辑器、导入器、历史恢复：`test32`–`test38`、`editor-ux`(66/66)、`editor-history`(39/39) 全 PASS。
- Service Worker：`browser`(37/37)、`sw-consistency`(35/35)、`sw-upgrade`(25/25) 全 PASS；`js/app.js` 与 `css/style.css` 均在 SW 预缓存清单内，`CACHE_VERSION` 由 `2026-11-13-2` 递增为 `2026-11-13-3`，缓存升级由 `editor-ux` / `editor-history` / `search-ux` 的版本断言共同验证。
- Chromium 套件共 9 套全部 PASS；报告输出 `tests/reports/last-run.md`。

---

## 9. 已知限制

1. 任务给出的 `main` 提交 `d01998a3…` 在本地对象库中不存在；本地 `main` 为 `0f727be`，而包含 Batch 8B-3 的最新工作树是 `feature/batch8b3-draft-history` 的 `df9f390`。本次以该最新工作树为分支基点，未 fetch、未 push，也未改动 `main`。
2. 评分是确定性规则式打分，不是语义/向量检索；不做中文分词、同义词、拼音或模糊拼写容错，中文长句依赖子串匹配。
3. 四类结果仍分组展示、组内排序；本轮未重做整个搜索结果页，也未做跨类型统一排序或分页。
4. 失败数据源不会自动退避重试（避免每次敲键重复发请求），需点击状态条「重试」或刷新页面。
5. 正文检索仍依赖整份 `data/search-index.json`（约 107KB），没有倒排索引或分片；数据量再增长时需另行优化。
6. 片段只展示首个命中窗口且上限 160 字符；`noteSearchHit()` 在课程页仍做全文命中计数（本轮只统一了片段生成与安全高亮）。
7. 浏览器测试默认 `chrome` 通道（`PW_CHANNEL` 可切换），环境无浏览器时按既有约定返回退出码 2（BLOCKED）。

---

## 10. 下一步建议

1. 若内容规模继续增长，在 `scripts/split_posts.py` / 内容构建阶段生成轻量倒排索引（保持现有生成器权威契约），把每次查询从全量扫描降到候选集。
2. 引入中文分词与同义词/拼音映射，提升「机器人学」「机械臂控制」等变体召回。
3. 结果数量大时增加分页或虚拟列表，避免一次性渲染上百个片段。
4. 为失败数据源加指数退避自动重试与 `sessionStorage` 状态持久化，减少人工点击。
5. 把权重表抽成配置，并用真实点击/停留数据离线校准排序（不改变确定性评分的测试方式）。
6. 后续可把四类结果改为「综合排序 + 类型筛选」视图，但需保留现有分组与深链契约。

---

## 11. 交付状态

- 本地 Commit：已创建（见 `git log -1`）。
- 未 Push、未创建 PR、未合并 `main`、未部署。
- 结论：`B8C1_LOCAL_READY`
