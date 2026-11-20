# Batch 9A-1 任务书：个人知识库 MVP（可直接实施）

- 上游：Batch 9A-0 规划（本文件为唯一实施依据）
- 基线：`main = ca25043`，`CACHE_VERSION = 2026-11-19-1`，默认 64 套回归全绿
- 目标：用最小改动交付"收藏 / 待读 / 浏览历史 / 继续阅读 / 独立管理页 / 本地持久化"
- 工期预估：**4 人日**（数据层 1d、集成 0.5d、页面 1d、测试 1d、回归与文档 0.5d）

## 1. 范围

### 1.1 纳入 MVP

| 编号 | 功能 | 类型范围 |
| --- | --- | --- |
| FR-1 | 收藏 / 取消收藏 | 文章、课程、论文、学习资料 |
| FR-2 | 待读 / 移出待读 | 同上 |
| FR-3 | 浏览历史自动记录 | 文章、课程、论文、学习资料 |
| FR-4 | 阅读进度持久化 + 继续阅读 | 文章（课程/论文无正文滚动，不记录进度） |
| FR-5 | 独立知识管理页 `#/knowledge` | 4 个 tab：收藏 / 待读 / 最近浏览 / 继续阅读 |
| FR-6 | 详情页操作条、搜索结果收藏标识 | 文章详情、课程详情、搜索结果行 |
| FR-7 | 本地 JSON 导出（只导出） | 全部记录 |
| FR-8 | 存储降级与错误提示 | 全局 |
| FR-9 | 多标签页同步 | 全局 |

### 1.2 明确不纳入（9A-2 及以后）

自定义分类、批量选择、导入、已读手动标记、代码库/项目/笔记收藏、首页个性化模块、相关推荐、统计页、演示组件。

## 2. 路由与页面入口

| 项目 | 定义 |
| --- | --- |
| 路由 | `#/knowledge`（默认 tab=favorites） |
| 查询参数 | `?tab=favorites\|readlater\|history\|continue`，非法值回退 `favorites` |
| 导航 | 顶部导航"归档"之后新增 `<a href="#/knowledge" class="nav-link" data-route="/knowledge">知识</a>` |
| 直达 | `#/knowledge?tab=readlater` 需可直接打开（深链接，刷新后保持） |
| 移动端 | 复用现有 `#menuToggle` 折叠菜单，无需新控件 |
| 标题 | `document.title = '知识库 · Eric\'s Notebook'`（与现有页面标题策略一致） |

## 3. 功能需求与行为

### FR-1/FR-2 收藏与待读

- 详情页标题下方操作条：`[★ 收藏] [⏱ 待读]`，`aria-pressed` 反映状态，已选时文案为"已收藏 / 已加入待读"。
- 点击：立即乐观更新 UI，写入 IDB；写入失败 → 回滚 UI + 顶部错误条（3s 自动消失）+ `aria-live` 播报。
- 幂等：重复点击只切换一次；快速连点以最后一次意图为准（内部按 `updatedAt` 写）。
- 搜索结果行：只显示只读状态标记（★ / ⏱，`aria-label` 含完整说明），操作入口在详情页。
- 快捷键：详情页非输入态按 `f` 切换收藏、`r` 切换待读；输入框/编辑器内不拦截。

### FR-3 浏览历史

- 打开文章/课程详情、论文/资料详情时写入 `recordView`，`lastSeenAt = Date.now()`。
- 同一内容 30s 内重复访问不重复写（避免刷新刷屏）。
- 历史上限 500 条；超限裁剪规则见架构文档第 5 节。
- 历史页展示：类型徽标、标题、相对时间（"3 分钟前 / 昨天 / 2026-11-02"）、进度（文章）。

### FR-4 进度与继续阅读

- 复用 `updateReadingUi` 的滚动计算，额外做持久化：
  - 节流 5s 写一次；`visibilitychange`（hidden）与 `pagehide` 立即写；
  - `progress = readingProgressPercent(...) / 100`，保留两位小数；
  - `progress ≥ 0.95` → `readState='done'`；`0.02 < progress < 0.95` → `reading`；否则 `none`。
- 打开文章时若存在 `progress ∈ [0.05, 0.95]` 且 `readState='reading'`，滚动到对应位置（`bodyTop + progress * bodyHeight`），并在顶部显示"已恢复到上次阅读位置"轻提示（`aria-live`）。
- 继续阅读列表：`readState='reading'` 且 `progress ∈ [0.05, 0.95]`，按 `lastSeenAt` 倒序，最多 6 条。

### FR-5 知识管理页

- tab 顺序：收藏 / 待读 / 最近浏览 / 继续阅读；URL query 与 tab 双向同步（点击更新 hash，`hashchange` 回填选中态）。
- 顶部统计行：`收藏 N · 待读 N · 阅读中 N · 已完成 N`（来自 `Knowledge.counts()`）。
- 分组：按类型分区（文章/课程/论文/资料），每区标题含数量；空分区不渲染。
- 行操作：打开（整行可点/Enter）、取消收藏、移出待读；操作后局部重渲染，不整页刷新。
- 空状态：每个 tab 独立文案 + "去首页看看"链接。
- 加载态：复用 `renderLoading('知识库')`；错误态：`renderLoadError('知识库')` 不适用时用内联提示条。

### FR-6 详情页/搜索集成

- `renderPostView` 挂载后：`recordView('post', id, {title})` + 注入操作条 + 恢复滚动。
- `renderCourseDetail` 挂载后：`recordView('course', id, {title})` + 注入操作条（无进度）。
- 搜索结果四类渲染器：若该条已收藏/待读，追加只读标记；渲染期间不得发起额外写事务（查询用内存缓存）。

### FR-7 导出

- 知识页右上"导出"按钮；导出内容见架构文档第 9 节（`kind:'knowledge'`）。
- 复用 `window.__downloadText`（编辑器已有）写文件，文件名 `knowledge-YYYY-MM-DD.json`。
- 仅在用户点击时生成；不自动上传。

### FR-8 降级

- 与架构文档第 10 节一致；MVP 至少覆盖：IDB 不可用、写入配额失败、数据库损坏、单条记录 JSON 损坏。
- 降级时知识页与操作条仍可用（内存），顶部常驻提示条，不阻断阅读。

### FR-9 多标签同步

- 任一处写入后广播；另一个标签的知识页在 300ms 内刷新列表与计数（去抖）。
- 不做冲突弹窗；字段级 last-write-wins。

## 4. 数据模型（v1）

与 `BATCH9_ARCHITECTURE.md` 第 3 节一致，字段固定为：
`key, type, refId, title, fav, favAt, favCat, later, laterAt, readState, progress, firstSeenAt, lastSeenAt, doneAt, updatedAt`。

MVP 额外约束：

- `favCat` 恒为 `'default'`；
- `type` 仅允许 `post | course | paper | material`（其余类型数据层可写但 UI 不展示，为 9A-2 预留）；
- 记录总数上限 2000（超出时拒绝新增历史，仅更新已有记录）。

## 5. 代码模块与改动清单

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `js/knowledge.js` | **新增**（≤ 25KB） | 数据层 + 视图模型 + 同步 + 导出；暴露 `window.Knowledge` |
| `js/app.js` | 增量修改 | 路由分支、导航项、`renderKnowledge`、三处渲染集成、快捷键、启动初始化 |
| `css/style.css` | 追加 Batch 9 区块 | 操作条、知识页、标记、提示条；仅用现有变量 |
| `sw.js` | 仅两处 | `FIRST_SCREEN_ASSETS` 增加 `js/knowledge.js`；`CACHE_VERSION` 递增 |
| `index.html` | 仅一处 | 导航新增"知识"链接（无内联脚本） |
| `scripts/run_tests.py` | 注册 2 个套件 | `knowledge-store`（jsdom）、`knowledge-center`（browser） |
| `tests/test51_knowledge_store.js` | **新增** | 见第 7 节 |
| `tests/browser/knowledge-center.spec.js` | **新增** | 见第 8 节 |
| `tests/browser/cross-browser.spec.js` | 新增 K1 场景 | 三引擎 |
| `tests/browser/cross-browser-offline.spec.js` | 新增 K2 场景 | 离线读写 |

默认套件数：**64 → 66**（新增 `knowledge-store`、`knowledge-center`）。CI 命令、并行许可清单不变。

## 6. UI 行为细节

| 场景 | 期望 |
| --- | --- |
| 首次访问（无数据） | 操作条为未选中态；知识页显示空状态，不闪烁 |
| 收藏成功 | 按钮 `aria-pressed=true`、文案"已收藏"、live 区播报"已收藏" |
| 收藏失败 | UI 回滚到原状态 + 错误条"收藏未保存：<原因>" |
| 刷新页面 | 收藏/待读/进度保持；文章恢复滚动位置并提示一次 |
| 内容已删除 | 知识页条目显示标题快照 + "内容已删除或迁移" + "移除" |
| 存储降级 | 顶部常驻提示"本地存储不可用，本次会话数据不会保留" |
| 深色模式 | 所有新增元素使用令牌，无硬编码颜色 |
| 390px | 操作条换行、知识页单列、tab 横向滚动且可键盘切换 |

## 7. 单元测试（`tests/test51_knowledge_store.js`，jsdom）

后端注入沿用现有测试风格（`Knowledge._injectBackend(fakeBackend)`），不依赖真实 IDB：

1. `recordView` 创建记录：字段完整、`firstSeenAt/lastSeenAt` 正确；
2. 30s 内重复访问不更新时间；
3. `setFlag('fav'|'later')` 幂等切换，时间戳正确；
4. 进度阈值：0.02/0.5/0.96 → `none/reading/done`；
5. 历史裁剪：写入 501 条后总数为 500，优先删最旧的非收藏非待读记录；
6. `list` 过滤（type/flag）、排序（`favAt` 降序）、分页（limit/offset）；
7. `counts` 与记录一致；
8. `exportData` 结构与 `schemaVersion`；
9. 后端写入抛错 → 不抛出给调用方，`degraded=true`；
10. 后端不可用 → 内存模式可读可写，导出包含内存数据；
11. 两个实例（模拟两标签）通过 fake BroadcastChannel 同步；
12. 非法记录（缺 key/未知 type）被忽略且不影响其他记录。

## 8. 浏览器测试（`tests/browser/knowledge-center.spec.js`，Chromium）

1. 文章详情收藏 → `aria-pressed` 切换 → 刷新后仍为已收藏；
2. 待读加入 → 知识页"待读"tab 出现该文；
3. 访问文章后"最近浏览"出现，相对时间文案非空；
4. 滚动到 45% → 刷新后恢复位置（允许 ±5% 误差）→"继续阅读"出现；
5. 滚动到 99% → 状态变为已完成，不再出现在继续阅读；
6. 知识页 4 个 tab 切换、统计数字正确、`←/→` 可切换；
7. 空上下文显示空状态，无 `pageerror`；
8. 搜索结果已收藏条目显示 ★ 标记；
9. 删除/改名模拟：注入不存在 id 的记录 → 显示"内容已删除或迁移"；
10. 禁用 IndexedDB（init script）→ 顶部提示条 + 收藏仍可在会话内生效；
11. 导出：替换 `window.__downloadText` 捕获，校验 `kind/schemaVersion/records` 结构；
12. 深色模式下操作条与知识页无样式缺失（计算样式断言前景/背景非透明）。

## 9. 跨浏览器与离线

- 跨浏览器 K1（`cross-browser.spec.js`）：三引擎各执行"收藏文章 → 刷新 → 知识页出现 → 取消收藏 → 空状态"，断言一致。
- 离线 K2（`cross-browser-offline.spec.js`）：在线收藏 → 断网（服务端断流）→ 打开 `#/knowledge` 与文章 → 数据仍在、可取消收藏 → 恢复网络后一致。
- 三引擎串行执行，不并入默认 CI job。

## 10. 版本与发布

- 触发条件：`js/knowledge.js`、`js/app.js`、`css/style.css`、`index.html` 任一变化 → **必须递增 `CACHE_VERSION`**（实施日取 `YYYY-MM-DD-1`）。
- 测试断言：只允许"格式 `^\d{4}-\d{2}-\d{2}-\d+$`" + "`ver > 上一版`"；**禁止硬编码当前发布日期**（Batch 8E-4R CI #97 教训）。
- 新增 `js/knowledge.js` 必须进入 `FIRST_SCREEN_ASSETS`，否则离线详情页操作条会缺失。
- 上线后人工抽查：在线收藏 → 断网刷新 → 知识页仍可见；Cache Storage 仅保留新版本缓存。

## 11. 验收标准

1. 上述 FR-1…FR-9 全部可演示，无 `pageerror`；
2. `python scripts/run_tests.py --only knowledge-store knowledge-center` 全绿；
3. `node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit --scenario=K1` 全绿；
4. `node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit --scenario=K2` 全绿；
5. `python scripts/run_tests.py --group sw` 与 `--only image-lightbox`、`--only ui-refresh` 全绿（版本断言未回归）；
6. 默认 66 套由 PR CI 完成最终验收（本地不重复全量）；
7. `git diff --check` 无空白错误；
8. 390 / 768 / 1440 三档无横向溢出，深浅色主题无硬编码颜色。

## 12. 禁止修改范围

- 不修改搜索评分、路由规则、既有稳定 ID、正式文章与 `js/data.js` 元数据；
- 不修改编辑器草稿键、`blog-draft-history` schema、导出格式；
- 不修改 `sw.js` 缓存策略（除资源清单与版本号）；
- 不引入第三方依赖、不新增构建步骤、不新增网络请求；
- 不降低既有断言强度、不自动重试；
- 不在本批次实现 9A-2 及以后功能（分类/批量/导入/统计/推荐/首页模块）；
- 不修改 CI 默认命令与工作流。

## 13. 子任务拆分（建议提交顺序）

1. `js/knowledge.js` 数据层 + `tests/test51_knowledge_store.js`（可独立验证）；
2. `app.js` 路由/导航/启动初始化 + 知识页骨架（无数据也可渲染空状态）；
3. 详情页操作条 + 进度持久化 + 搜索结果标记；
4. `css/style.css` Batch 9 区块 + 移动端/深色断言；
5. 浏览器套件 + 跨浏览器 K1 + 离线 K2；
6. `sw.js` 资源清单与版本递增、注册套件、文档与最终回归。
