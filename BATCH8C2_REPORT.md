# Batch 8C-2：全站搜索交互增强

## 0. 基线与开工检查

| 项目 | 值 |
| --- | --- |
| 项目路径 | `E:\work_funnycode\blog` |
| 正式基线 | `main@f2be74ec1ce4b19960d5f33e7aef1741d389139a`（B8C-1 合并提交，PR #13） |
| 开发分支 | `feature/batch8c2-search-interaction`（基于 `f2be74e` 创建） |

开工步骤与结论：

1. **保护未提交改动**：目标仓库工作区 `git status --short` 为空。本地 `feature/batch8c1-search-quality`（`7f96a2f`）及其 `origin/feature/batch8c1-search-quality` 引用均保留未动；该本地提交与 main 的 squash 合并提交哈希不同，属正常合并形态。另有一次命令因 shell 解析差异落在 IDE 工作区 `e:/JE_analysis`，只执行了只读 `git` 查询、**未修改任何文件**；该工作区原有未提交改动全程未触碰。
2. **更新本地 main**：`git fetch origin main:main`，本地 `main` 由 `0f727be` 快进到 `f2be74e`，`origin/main` 由 `d01998a` 同步到 `f2be74e`。
3. **确认基线**：`f2be74ec1ce4b19960d5f33e7aef1741d389139a` 存在且 `git rev-parse main` 与之完全一致。
4. **创建分支**：`git checkout -b feature/batch8c2-search-interaction main`，工作区干净。
5. **核查 B8C-1 合并后 CI**（GitHub Actions 公开 API，提交 `f2be74e`）：
   - `deploy` → `success`
   - `report-build-status` → `success`
   - `build` → `success`
   - `tests` workflow run `43821737978`（`tests.yml`，run_number 51，`push` on `main`）→ `status=completed`，`conclusion=success`（07:08:57Z → 07:15:44Z）
   
   首次查询时该 job 显示 `in_progress`，复查确认最终为 `success`。**无失败项，无需报告失败原因，也未忽略任何检查**。

本轮只完善搜索交互，未重写搜索引擎；`collectSearchResults()`、`buildSearchResult()`、`compareSearchResults()`、`searchSourceStatus()`、`loadSearchSources()`、`paintSearchResults()`、`applyGlobalSearch()` 七个保留函数及中文输入法/异步竞态保护均保持原有语义。

---

## 1. 分类筛选实现

- 结果顶部新增五个原生 `<button>`（`role="group"` + `aria-pressed`）：`全部 / 文章 / 课程 / 论文 / 学习资料`，默认 `全部`。
- 各分类数量直接取 **筛选之前** 的 `collectSearchResults().groups`（以及 `total`），与当前筛选无关：`全部 (25) | 文章 (11) | 课程 (10) | 论文 (2) | 学习资料 (2)` 实测正确。
- 切换分类只改轻量 UI 状态 `_searchFilterType` 并调用 `repaintSearchInteraction()` → `paintSearchResults()` 局部重绘 `[data-search-root]` 内部；**不调用 `loadSearchSources()`、不发起任何网络请求**（`test41` F5、浏览器 A9 用服务端命中计数验证）。
- 关键词变化保留当前筛选；切换分类重置展开状态，避免旧状态污染。
- 选中分类 0 命中时显示「当前分类「X」没有匹配结果」并提供「查看全部结果」按钮；数据源未就绪时改显示「该分类的数据源尚未加载完成，暂时无法确定是否有结果…」，**不把临时零结果当最终零结果**。
- 渲染仍逐条使用 `r.targetUrl`，筛选/排序/折叠都不改变文章 `#/post/<id>`、课程 `#/course/<id>` 与 Batch 7B-2 的论文/资料持久深链。
- 未新建第二套搜索数据结构：`bundle` 仍是唯一中间结果。

## 2. 排序规则

`<select id="searchSortSelect">` 三个选项，默认「相关性」：

| 选项 | 规则 | 说明 |
| --- | --- | --- |
| 相关性（默认） | 直接返回 `collectSearchResults()` 已按 `compareSearchResults()` 排好的数组 | **完全复用 B8C-1 的 `score`，不改评分公式、不改 `compareSearchResults`** |
| 标题 A–Z | `title.localeCompare(other, 'zh-Hans-CN', {sensitivity:'base'})`，相等时回退 `compareSearchResults` | 中文按拼音/字符序；同分确定 |
| 最新文章优先 | 仅对 `type === 'post'` 且日期匹配 `^\d{4}-\d{2}-\d{2}` 的结果按日期降序 | 课程/论文/学习资料**没有可靠发布时间，绝不伪造**，保持相关性排序；UI 明确提示「只对有可靠发布日期的文章生效」 |

- 缺少可靠日期的文章排在有日期文章之后，组内回退到 `compareSearchResults`（score → order → type → id），稳定可复现。
- 所有排序都在 `list.slice()` 副本上进行，**不修改原始数据数组**（`test41` S8）。
- 排序与分类筛选共同生效；切换排序同样不触发网络请求（`test41` S9）。

## 3. 搜索历史数据结构

```
localStorage['blog.searchHistory.v1'] = ["最新关键词", "次新关键词", ...]   // string[]，最多 10 条
```

- 只存 trim 后的关键词字符串（截断 120 字符），**不含文章正文、草稿或任何隐私数据**；与 Batch 8B-3 的草稿 IndexedDB / `blog_draft*` 完全隔离。
- 去重（精确匹配）、最近使用排最前、上限 10 条；可单条删除、一键清空、点击历史词重新搜索。
- **只在用户确认搜索时记录**：`Enter`、点击结果、点击历史关键词；逐字输入与快速输入不写历史（`test42` H1、H14b）。
- `localStorage` 完全不可用时降级为内存数组 `_searchHistoryCache`（仅当前会话），面板显示「当前浏览器无法写入本地存储，历史仅保留到本次页面关闭」，搜索本身不受影响（`test42` H9、浏览器 B1–B3）。
- 面板固定文案「最近搜索（仅保存在此浏览器）」，处于普通文档流（`position: static`），不遮挡内容。
- 清空使用 `removeItem` 并把内存缓存置空，后续重绘**不会自动写回旧记录**（`test42` H8/H8b）。
- 不覆盖 `history.state` 的搜索回退恢复逻辑（`rememberEntryState()` / `readEntrySearch()` 未改，前进/后退仍可恢复关键词与结果）。
- 安全性修复：历史 chip 的 `data-search-history*` 属性改存 `encodeURIComponent(term)`，关键词本身只作为 `escapeHtml` 后的文本节点；避免转义文本在 `innerHTML` 序列化回读时把 `<` 回显到属性里（与 B8C-1 的 `data-query` 同类问题）。
- 为让「整个 localStorage 不可用」时全站无未捕获异常，给既有 `initTheme()` / `toggleTheme()` 的 localStorage 访问补了 `try/catch`（主题在存储失败时仍在当前页生效，正常路径行为不变）。

## 4. 折叠

- 每组默认渲染前 **6** 条（`SEARCH_VISIBLE_LIMIT`），分组标题显示「显示 6 / 共 11」；超出显示「展开更多 (N)」，展开后显示「收起」并带 `aria-expanded`。
- **只限制渲染**，不截断 `collectSearchResults()` 的计算结果（`test41` C6）。
- 展开前保持当前排序规则的前 N 条；关键词变化（`applyGlobalSearch` 检测 `_lastSearchQuery`）与切换分类都会重置展开状态。
- 每个可见结果节点带唯一 `id="search-result-N"`、`data-search-result`、`data-result-index`、`aria-selected`；切换类型不产生重复条目/重复 id，DOM 数量明显少于无条件全量渲染。

## 5. 键盘导航与无障碍

- 采用 **document 捕获阶段** 的单个 `keydown` 委托（先于 `bindLiveSearch` 的 Enter 提交），不引入键盘框架：
  - `↓` / `↑`：在**当前可见** `[data-search-result]` 间移动（折叠/筛选后自动按新 DOM 计算）；
  - `Enter`：有选中项且查询已提交时打开该节点的 `data-href`，与鼠标点击走同一目标链接；无结果时不跳转；
  - `Esc`：有选中项时只退出选择（保留关键词与焦点），无选中项时沿用原有「清空搜索并 blur」逻辑。
- **中文输入法**：`e.isComposing || e.keyCode === 229 || _searchComposing` 时直接放行；`Ctrl/Meta/Alt/Shift` 组合键一律放行，不拦截系统快捷键，也不影响 `Ctrl/Cmd+K` 与 `/` 聚焦。
- 无障碍：输入框动态设置 `role="combobox"`、`aria-controls="searchResults"`、`aria-autocomplete="list"`、`aria-expanded`、`aria-activedescendant`；选中节点 `aria-selected="true"` 与 `.search-result-active` 明显描边；筛选按钮 `aria-pressed`，排序 `aria-label`，展开按钮 `aria-expanded`。
- 每次 `paintSearchResults()` 后 `resetSearchActive()` + `syncSearchActive()`，**不会保留指向已删除 DOM 的焦点引用**。

## 6. 移动端与交互样式

`css/style.css` 新增 `.search-controls` / `.search-filter-bar` / `.search-filter-btn` / `.search-sort-wrap` / `.search-history*` / `.search-expand-btn` / `.search-result-active` 等样式，保持原有设计语言（全部使用站点 CSS 变量，深浅色自动适配）。

| 视口 | 实测 `scrollWidth / innerWidth` | 控件 |
| --- | --- | --- |
| 375 | 375 / 375 | 筛选按钮 40px、排序框 40px、`font-size:16px` |
| 390 | 390 / 390 | 同上，`selectOption` 可用 |
| 768 | 768 / 768 | 按钮 38px、排序框 36px |
| 1280 | 1280 / 1280 | 按钮 38px、排序框 36px |

- 筛选控件 `flex-wrap` 换行（不产生全页横向滚动），窄屏控件拉伸整行；历史面板 `position: static`，四种视口下 `top` 均在文档流内。
- 长论文标题 / 文件名 `overflow-wrap:anywhere; word-break:break-word`；`:focus-visible` 统一描边；`aria-pressed="true"` 按钮高亮。
- 深色模式实测筛选按钮文字 `rgb(255,255,255)`、选中态底色 `rgb(37,99,235)`，浅色同样清晰。
- `CACHE_VERSION` 由 `2026-11-13-3` 递增为 `2026-11-16-1`；`js/app.js`、`css/style.css` 仍在 SW 预缓存清单内，浏览器 E2/E3 与 `sw.spec.js` / `sw-consistency` / `sw-upgrade` 共同验证新版本生效、旧缓存清理。

## 7. 工程约束

- **未改**：`scripts/import_post.py`、`scripts/build_content.py`、论文/课程原始数据、私人 Zotero Registry、GitHub Actions 发布逻辑、GitHub Pages 部署方式。
- **未引入**：后端、新数据库、大型第三方搜索依赖、账号同步、远端日志。
- 修改文件：`js/app.js`、`css/style.css`、`sw.js`、`scripts/run_tests.py`、`package.json`、`tests/browser/search-ux.spec.js`（仅一处断言期望值）+ 3 个新增测试文件 + 本报告。
- `tests/browser/search-ux.spec.js` 的 U15 由硬编码 `ver === '2026-11-13-3'` 更新为 `ver > '2026-11-13-3'`，用于验证本轮版本递增；**原有断言未删除、未放宽**（仍检查 `js/app.js` 与 `css/style.css` 在预缓存清单中）。

## 8. 新增测试结果

已纳入 `scripts/run_tests.py`（并同步 `package.json` 的 `test:js` / `test:browser`）。

| 文件 | 类型 | 项数 | 覆盖 |
| --- | --- | --- | --- |
| `tests/test41_search_filters.js` | jsdom | 44 | 四类筛选与筛选前数量、局部刷新与无额外请求、相关性/标题/日期排序、日期适用范围与稳定回退、不改原数组、折叠/展开/收起与关键词重置、↑↓ Enter Esc、IME 与系统快捷键、无结果 Enter、重绘后 aria 引用、XSS、持久深链 |
| `tests/test42_search_history.js` | jsdom | 29 | 逐字输入不记录、Enter/点击结果才记录、去重/最近最前/上限 10、单条删除、清空不写回、点击历史重搜、localStorage 不可用降级、草稿隔离、`history.state` 前进后退、历史 XSS、部分失败与重试、快速输入竞态、无未处理 rejection |
| `tests/browser/search-interaction.spec.js` | Chromium | 56 | 真机筛选/排序/折叠、键盘导航、IME、搜索历史与降级、稳定深链、前进后退、375/390/768/1280 布局、深浅色、XSS、SW 缓存升级 |

全部使用公开仓库数据或合成 Fixture。定点测试先分别执行：**44 + 29 + 56 = 129 项全通过**。

## 9. 完整回归结果

```
python scripts/run_tests.py
== 汇总 ==
  PASS 51 / FAIL 0 / SKIP 0 / BLOCKED 0
  结论: PASS
```

- 原有 **48 套**全部保持通过（含 `audit`、`test6`–`test40`、`split-check`、`content-check`、`feed-check` 及原浏览器套件）；新增 3 套全部通过，合计 51 套（≥ 51）。
- Batch 7B 稳定深链 `papers-deeplink` 63/63、Batch 8A/8B 编辑器/导入器/历史 `test32`–`test38` + `editor-ux` 66/66 + `editor-history` 39/39 全 PASS。
- Service Worker：`browser` 37/37、`sw-consistency` 35/35、`sw-upgrade` 25/25、`search-ux` 30/30、`search-interaction` 56/56 全 PASS；`CACHE_VERSION = 2026-11-16-1`。
- Chromium 套件 10 套全部通过；报告输出 `tests/reports/last-run.md`。
- 未删除任何原有断言，未修改真实文章数据。

## 10. 已知限制

1. 筛选、排序、展开状态是本页内存 UI 状态，刷新页面或前进/后退会回到默认值；原有**搜索关键词**的历史恢复保持不变。
2. 「最新文章优先」只对有可靠 `YYYY-MM-DD` 日期的文章生效；课程/论文/学习资料没有发布时间，保持相关性排序（避免伪造日期造成混合类型歧义）。
3. 标题排序依赖浏览器 `Intl` / `localeCompare('zh-Hans-CN')`，不同浏览器的拼音排序可能有细微差异；同分一律回退 `compareSearchResults` 保证确定性。
4. 折叠上限固定为每组 6 条；未在 URL 中暴露「筛选 + 排序 + 展开」状态，暂不支持分享带筛选条件的搜索链接。
5. 搜索历史最多 10 条、仅当前浏览器；localStorage 不可用时只在当前会话内存中保留，不做账号同步或远端日志。
6. 键盘导航作用域为「搜索框聚焦时」；焦点在筛选/展开按钮上时不接管方向键，避免干扰原生控件与其它快捷键。`Ctrl/Cmd+K` 在搜索框已聚焦时沿用既有行为。
7. 本地 `feature/batch8c1-search-quality`（`7f96a2f`）与对应远程分支仍存在，未删除、未合并、未改动；它和 main 的 squash 合并提交 `f2be74e` 内容一致但哈希不同。
8. B8C-1 合并后的 CI 在第一次查询时 `tests` job 仍 `in_progress`，复查确认最终 `success`；本轮未在本地重跑 GitHub Actions（仅按公开 API 核查结果）。

## 11. 下阶段建议

1. 把筛选 / 排序 / 展开状态写入 `history.state`（或 URL 查询参数），让前进后退与分享链接也能复原完整交互状态。
2. 结果量继续增长时引入分页或虚拟列表，配合现有的 6 条折叠进一步降低 DOM 数量。
3. 键盘导航补充 `Home` / `End` / `PageUp` / `PageDown`，以及结果区的 `aria-live` 播报。
4. 搜索历史可增加「常用关键词加权」与跨设备可选导出，但仍保持纯本地、不引入账号体系。
5. 若论文数据补充可靠的发表日期字段，可把「最新优先」扩展到论文分组，并继续用 `compareSearchResults` 兜底。
6. 对 `localeCompare` 的中文排序做一次跨浏览器基线比对，必要时改为构建期生成排序键。

---

## 12. 交付状态

- 本地 Commit：已创建于开发分支 `feature/batch8c2-search-interaction`（见 `git log -1`）。
- **不 Push、不创建 PR、不合并 main、不部署。**
- 结论：`B8C2_LOCAL_READY`
