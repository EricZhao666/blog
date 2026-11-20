# Batch 9 架构设计：本地知识层

- 范围：Batch 9A–9G 共用的数据基础、模块边界、持久化、迁移与降级
- 前提：纯静态站点；无后端/账户/云同步；沿用现有 `app.js` 路由与渲染方式
- 目标：一次设计，后续 9B/9E/9F 只读不重建

## 1. 设计原则

1. **复用优先**：已有 `escapeHtml`、`renderLoading/renderLoadError`、`localStorage` 偏好、IndexedDB 访问模式（`DraftHistory`）直接复用，不引入新抽象层。
2. **单一事实源**：一篇内容的收藏/待读/阅读状态都在同一条记录里，避免 9A/9E/9F 各存一份。
3. **可丢弃优先**：除收藏/待读/分类外，其余统计与"继续阅读"都可从记录重建。
4. **失败可见**：存储不可用时降级到内存并显示提示，不静默丢数据。
5. **不做乐观假设**：导入数据、被删内容、异常 ID 都按不可信处理。

## 2. 存储选型

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 纯 localStorage | 同步 API、实现最简 | 5MB 上限、无索引、排序需全量解析、多标签写覆盖风险高 | 不适合历史与进度 |
| B. 纯 IndexedDB | 索引/事务/容量好 | 首次打开异步、启动阶段不能同步读主题 | 作为主存储 |
| C. 混合 | IDB 存记录，localStorage 存偏好 | 需要明确边界与同步规则 | **采用** |

最终：

- **IndexedDB**：收藏、待读、浏览历史、阅读进度/状态、自定义分类。
- **localStorage**：主题（沿用 `theme`）、知识库偏好（`blog.km.prefs.v1`）、多标签心跳（`blog.km.ping.v1`）、搜索历史（沿用 `blog.searchHistory.v1`，不动）。
- 不新增第二个 IDB 库给编辑器；`blog-draft-history` 与 `blog-knowledge` 完全隔离。

## 3. IndexedDB schema（v1）

> Batch 9A-2 确认：物理结构**未变**（仍 v1），只在 `meta` 里增加 `favCategories` 键，
> 数据版本升到 2。因此不需要新 store，也不需要升 IDB version。

```
DB: blog-knowledge (version 1)
├─ records  (keyPath: 'key')
│    indexes: by_type(type), by_fav(fav), by_later(later),
│             by_lastSeen(lastSeenAt), by_state(readState)
└─ meta     (keyPath: 'k')
     { k: 'schemaVersion', v: 2 }
     { k: 'favCategories', v: [{ id, name, system }] }   // 9A-2
```

记录（`records`）字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | `type:refId`，唯一主键，如 `post:vla-model-intro` |
| `type` | enum | `post` / `course` / `paper` / `material` / `lib` / `project` / `note` |
| `refId` | string | 原始 id（课程 id 可含中文与 `\|`，原样保存） |
| `title` | string | 初次收藏时的标题快照，仅用于内容被删后的占位展示 |
| `fav` | 0\|1 | 是否收藏 |
| `favAt` | number | 收藏时间戳（0 表示未收藏） |
| `favCat` | string | 分类，默认 `default`（9A-2） |
| `later` | 0\|1 | 是否待读 |
| `laterAt` | number | 加入待读时间戳 |
| `readState` | enum | `none` / `reading` / `done` |
| `progress` | number | 0–1，仅 `post`/`note` 有意义 |
| `firstSeenAt` | number | 首次浏览 |
| `lastSeenAt` | number | 最近浏览（历史与"继续阅读"排序依据） |
| `doneAt` | number | 标记完成时间 |
| `updatedAt` | number | 最后一次写入，用于多标签合并 |

示例：

```json
{
  "key": "post:vla-model-intro",
  "type": "post",
  "refId": "vla-model-intro",
  "title": "VLA 模型入门：从 RT-1 到 OpenVLA",
  "fav": 1, "favAt": 1763500000000, "favCat": "default",
  "later": 0, "laterAt": 0,
  "readState": "reading", "progress": 0.42,
  "firstSeenAt": 1763490000000, "lastSeenAt": 1763500000000,
  "doneAt": 0, "updatedAt": 1763500000000
}
```

## 4. 稳定标识

- 统一键：`type + ':' + refId`，跨类型不会冲突（`post:paper-4` ≠ `paper:paper-4`）。
- 路由仍使用现有形式，构造链接时统一 `encodeURIComponent(refId)`；键本身不做 URL 编码。
- 不引入内容哈希做 ID（内容更新会导致收藏漂移）。
- 笔记静态页：`note:<slug>`（slug 来自 `js/note-slugs.js`），只用于历史与收藏，无进度。
- 编辑器草稿 id（`blog_draft_edit::<id>`）继续独立命名，新模块不读写该前缀。

## 5. 生命周期与保留策略

| 数据 | 保留 | 说明 |
| --- | --- | --- |
| 收藏 / 待读 / 分类 | 长期 | 永不自动清理，除非用户删除或导入覆盖 |
| 阅读状态 / 进度 | 长期 | 每篇一条，最多与内容条数同阶 |
| 浏览历史 | 可重建、可裁剪 | 上限 500 条；超出时优先删除 `fav=0 && later=0 && readState!='reading'` 的最旧记录 |
| 继续阅读 | 可重建 | 由 `readState='reading'` + `progress` 派生，不单独存储 |
| 统计 | 可重建 | 每次打开统计页聚合计算，缓存 60s |
| 偏好 | 长期 | `localStorage`，损坏时回退默认并重写 |

## 6. 模块边界与 API

新增单文件 `js/knowledge.js`（暴露 `window.Knowledge`），不修改 `DraftHistory`：

> Batch 9A-2 已按**实际导出**校正（此前文档里的 `get` / `importData` / `clearAll` 并不存在）。

```js
Knowledge.init()                                 // -> Promise<{ok, degraded, reason}>
Knowledge.recordView(type, refId, meta)          // 浏览即记（30s 去重）
Knowledge.setFlag(type, refId, flag, on, meta)   // flag: 'fav' | 'later'
Knowledge.toggleFlag(type, refId, flag, meta)
Knowledge.saveProgress(type, refId, p)           // 立即写（自动进度）
Knowledge.scheduleProgress(type, refId, p)       // 节流写（5s / flush）
Knowledge.flushProgress()
Knowledge.setReadState(type, refId, state, p)    // 人工状态，优先级高于自动进度
Knowledge.clearHistory(key) / clearAllHistory()
Knowledge.remove(key)                            // -> {ok, deleted, changed}
Knowledge.list({type, flag, cat, limit, offset, sort})
Knowledge.counts()                               // -> {fav, later, reading, done, history}
Knowledge.state(type, refId)                     // -> 缓存中的 record | null
Knowledge.exportData()                           // -> {schemaVersion:2, categories, records, complete, ...}
Knowledge.subscribe(fn)
Knowledge.refresh() / status() / relativeTime() / toast()

// ---- Batch 9A-2 新增 ----
Knowledge.categories()                           // -> [{id, name, system}]
Knowledge.addCategory(name)                      // -> {ok, category, reason?}
Knowledge.renameCategory(id, name)               // 保留 id
Knowledge.removeCategory(id)                     // 原子迁移收藏回 default
Knowledge.assignCategory(key, catId)
Knowledge.bulk(keys, action, opts)               // 单事务；action 见下
Knowledge.validateImport(data, {bytes})          // 纯校验，不写库
Knowledge.previewImport(payload, {resolve})      // 统计 + token
Knowledge.applyImport(payload, {mode, confirm, expectToken, resolve})
```

`bulk` 动作：`fav-on` / `fav-off` / `later-on` / `later-off` / `cat` / `read-done` / `read-none` / `history-clear`。

约束：

- 所有方法返回 Promise；内部串行写队列，避免并发事务冲突。
- 未 `init` 完成时调用 → 进入内存队列，`init` 成功后回放（最多 50 条）。
- 任何方法不得抛异常给调用方（`app.js` 渲染路径不能被存储错误打断）。
- 不做通用 ORM，不新增构建步骤。

`app.js` 集成点（只加调用，不改既有逻辑）：

| 位置 | 改动 |
| --- | --- |
| `routeHash()` 分发 | 新增 `/knowledge` 分支 → `renderKnowledge()` |
| `renderPostView` / 文章详情挂载后 | `recordView('post', id)`、按 `progress` 恢复滚动、注入操作条 |
| `renderCourseDetail` | `recordView('course', id)` + 操作条 |
| `renderSearchPostResult` 等 4 个渲染器 | 结果行加"已收藏/待读"标识（9A-1.1） |
| 导航 | 新增"知识"入口（在"归档"之后） |
| `init()` 启动 | `DOMContentLoaded` 后 `requestIdleCallback` 初始化，更新徽标 |
| 滚动监听 | 复用 `updateReadingUi`，追加节流持久化 |

## 7. 多标签页同步

- 主通道：`BroadcastChannel('blog-km')`，写入后广播 `{type:'changed', keys:[...]}`。
- 兜底：写 `localStorage['blog.km.ping.v1'] = Date.now()`，监听 `storage` 事件（同源其他标签触发）。
- 合并策略：字段级 last-write-wins，比较 `updatedAt`；收藏/待读的"取消"同样带时间戳，避免旧标签把取消覆盖回收藏。
- 只广播键名，不广播完整记录；接收方按需重读，减少复制。

## 8. schemaVersion 与迁移

> **Batch 9A-2 已确认版本**（与实现一致，详见 `KNOWLEDGE_DATA_FORMAT.md`）

| 版本 | 当前值 | 位置 | 何时变更 |
| --- | --- | --- | --- |
| IDB 结构版本 `DB_VERSION` | 1 | `indexedDB.open(name, version)` | 仅在新增 store/index 时 +1；9A-2 未变 |
| 数据版本 `SCHEMA_VERSION` | **2** | `meta.schemaVersion` | 数据语义变化（9A-2 引入收藏分类） |
| 导入导出格式版本 | **2** | 导出 JSON 的 `schemaVersion` | 文件格式变化；导入端接受 `[1,2]` |

- 启动流程：open → `migrateMeta()`（幂等）→ 写回 `schemaVersion` → `refreshCache()`。
  迁移**不是**独立的 migrations 表，而是"补齐 + 修复"两类动作：
  1. 归一化并写回 `meta.favCategories`（缺失补默认分类）；
  2. `fav=1` 但 `favCat` 指向不存在分类的记录 → 批量改回 `default`；
  3. `schemaVersion > 2` 时**直接跳过**（不对未来版本做破坏性写入）。
- 迁移失败：保留原库（所有写操作在事务内），不自动删库、不影响 `blog-draft-history`。
- 验证方式：真实浏览器先建 v1 库再加载新代码（`knowledge-management.spec.js` K23），
  不只依赖模拟后端。

## 9. 导入 / 导出

> **Batch 9A-2 已确认契约**（与实现一致）

导出格式：

```json
{
  "app": "ericzhao-blog",
  "kind": "knowledge",
  "schemaVersion": 2,
  "exportedAt": "2026-11-20T07:00:00.000Z",
  "persistence": "indexeddb",
  "source": "database",
  "degraded": false,
  "complete": true,
  "warning": "",
  "categories": [ { "id": "default", "name": "默认分类", "system": true } ],
  "records": [ { "...": "同 records 字段" } ]
}
```

- `records` 与 `categories` 由**同一个只读事务**读出（`readAll`），避免"记录新、分类旧"。
- `complete` 跟随本次读取结果（`{rows, source, complete, warning}`），不再用共享变量；
  并发导出互不影响。

校验规则（任一不满足则整份拒绝，不写库）：

- 文件 ≤ 2MB、记录 ≤ 5000 条、分类 ≤ 200 个、嵌套深度 ≤ 6；
- `app === 'ericzhao-blog'`、`kind === 'knowledge'`、`schemaVersion ∈ [1,2]`（更高版本明确拒绝）；
- 每条：`key` 必须是 `type:refId`，type ∈ 7 类枚举，`refId ≤ 200`，且 `type/refId` 与 key 一致；
- 标题 ≤ 300、分类名 ≤ 40、`favCat` ≤ 64；
- 枚举：`fav/later ∈ {0,1}`、`readState ∈ {none,reading,done}`；`progress` 有限且 0–1；时间戳非负且不超前 1 天；
- 重复 `key`、重复分类 id / 名称 → 整份拒绝；
- 拒绝 `__proto__` / `constructor` / `prototype` 字段（原型污染）。

导入模式（**与规划不同的地方，已按数据完整性优先调整**）：

| 模式 | 实现 | 与规划差异及原因 |
| --- | --- | --- |
| `merge`（默认） | 只插入本地缺失且目标仍存在的记录；本地记录原样保留；分类按 id 取并集、本地名称优先 | 规划写"按 `updatedAt` 取新"，但 v1/v2 只有记录级 `updatedAt`，无法做字段级 last-write-wins，整条覆盖会静默丢字段 → 改为保守合并 |
| `replace`（显式） | 仅接受 `complete=true && source=database && persistence=indexeddb` 的完整备份；二次确认 + 先导出备份；**单事务** clear + put + 写分类；失败整体回滚 | 规划写"先清空再写"，那会留下"已清空但没写入"的窗口 → 改为同一事务 |

导入在内存降级模式下**一律拒绝**。导入成功后刷新缓存、广播通知其他标签页；确认期间快照 token 变化则拒绝。

## 10. 降级与异常

| 场景 | 行为 |
| --- | --- |
| `indexedDB` 不存在/被禁用 | 内存存储 + 顶部提示"本次会话可用，刷新后丢失"；导出按钮可用（导出内存数据） |
| `open` 被其他标签阻塞 | 等待 3s 后降级内存，监听 `versionchange` 提示刷新 |
| 写入 `QuotaExceededError` | 先裁剪历史至 200 条并重试一次；仍失败 → 只读模式 + 提示导出 |
| 读事务失败 | 返回空结果 + 记一次 `console.warn`，不阻断渲染 |
| 数据库损坏（open error 非版本冲突） | 降级内存 + 提示"重置本地知识数据"（用户确认后才 `deleteDatabase`） |
| 导入数据非法 | 拒绝并显示具体原因；现有数据不变 |
| 内容被删除/改名 | 按 `key` 找不到元数据 → 显示标题快照 + "内容已删除或迁移" + 单条移除/一键清理 |

## 11. 与现有数据的隔离

- 不改 `blog_draft`、`blog_draft_edit::<id>`、`blog.searchHistory.v1`、`theme`。
- 不打开、不升级 `blog-draft-history`；新增库独立。
- 编辑器"清除站点数据"类操作（若有）不得隐式清空知识库；知识库清空必须单独确认。
- 测试中用独立 DB 名（`blog-knowledge-test-<rand>`）避免污染真实数据。

## 12. Service Worker 与离线

- 知识数据在 IndexedDB，SW 不缓存、不清除；离线时读写均可用。
- `js/knowledge.js` 需要被离线缓存：加入 `FIRST_SCREEN_ASSETS`（详情页操作条与导航徽标需要它）→ 必须递增 `CACHE_VERSION`。
- 新增 CSS 合入 `css/style.css`（避免新增首屏请求）。
- 知识页为 SPA 路由，`index.html` 已在安装期快照内，离线直接可用。
- 若后续把演示脚本拆成按需文件，放入 `OPTIONAL_ASSETS`，不阻塞首屏。

## 13. 安全

- 所有来自存储/导入的字符串在插入 DOM 前必须 `escapeHtml`；分类名、标题快照、导入文件名都按不可信处理。
- 不使用 `innerHTML` 拼接用户数据；列表统一用 `createElement + textContent` 或转义后的模板。
- 不 `eval`、不 `new Function`、不执行导入数据中的任何字符串。
- 导出文件仅本地生成，不上传；不含任何令牌/环境信息。
- 交互式演示（9C）使用白名单渲染器：Markdown 中只允许 `demo` 代码块 + JSON 配置，经 schema 校验后调用已注册的渲染函数；DOMPurify 之后不再解析任意 HTML。

## 14. 性能预算

| 项目 | 预算 |
| --- | --- |
| `knowledge.js` 体积 | ≤ 25KB（未压缩） |
| 初始化 | 不阻塞首屏；`requestIdleCallback` 后 ≤ 80ms（本地） |
| 单次写入 | ≤ 5ms（单条 put） |
| 历史裁剪 | 只在写入超限时执行，≤ 20ms |
| 知识页首屏 | ≤ 300ms（18 篇文章规模，本地） |
| 滚动进度写入 | 节流 5s + `pagehide`，每页最多约 20 次写 |

## 15. 测试映射

| 层次 | 文件（计划） | 覆盖 |
| --- | --- | --- |
| jsdom 单元 | `tests/test51_knowledge_store.js` | 记录读写、去抖、裁剪、schema 迁移、导入校验、降级、多实例共享 |
| Chromium 端到端 | `tests/browser/knowledge-center.spec.js`（注册名 `knowledge-center`） | 详情页收藏/待读、刷新恢复、知识页 tabs、空状态、错误提示、键盘操作 |
| 跨浏览器 | 在 `cross-browser.spec.js` 新增 K1 场景 | 三引擎一致的操作与渲染 |
| 离线 | 在 `cross-browser-offline.spec.js` 新增 K2 场景 | 离线打开知识页、离线收藏、恢复后仍存在 |
| 版本 | 现有 `ui-refresh` U11.1 / `sw-snapshot-unit` U0 | 只校验格式与相对上一版递增 |

默认套件数将从 64 增至 66（新增 `knowledge-store` 与 `knowledge-center`）；CI 命令与运行器行为不变。
