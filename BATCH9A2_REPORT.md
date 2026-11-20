# Batch 9A-2 报告：知识库分类、批量管理与安全数据迁移

- 状态：**B9A2_PR_READY**（本地专项 + 三引擎 + 受影响回归全部通过；未合并、未部署）
- 基线：`main = 15ca37d`（Batch 9D 已合并，CI 69 PASS）
- 分支：`feat/batch9a2-knowledge-management`（创建于 2026-11-20 15:30:00 +0800）
- 版本：`CACHE_VERSION 2026-11-20-3 → 2026-11-20-4`；`REQUIRED_ASSETS`/`FIRST_SCREEN_ASSETS` **未变**（8/7 项，
  本轮没有新增脚本文件，只改 `js/knowledge.js`、`js/app.js`、`css/style.css` 的内容）
- 数据版本：`schemaVersion 1 → 2`；**IDB 结构版本仍为 1**（没有新增 object store）
- 范围：在既有 `blog-knowledge` 知识库上补分类、批量、显式状态、导出完整性与安全导入；
  未做云同步、账户、多级目录、统计仪表盘

## 1. 实际分类模型（Phase B）

```js
meta.favCategories = [
  { id: 'default', name: '默认分类', system: true },
  { id: 'cat-mabc123-x9y2', name: '论文', system: false }
]
records[i].favCat = 'cat-mabc123-x9y2'     // 未收藏的记录该字段无意义
```

| 规则 | 实现 |
| --- | --- |
| 分类稳定 ID | `cat-<base36 时间>-<随机后缀>`；重命名只改 `name`，ID 不变（单测 K7） |
| 默认分类 | `id='default'`，恒存在、排第一、`system:true`、删除请求直接拒绝（K2） |
| 名称清洗 | 去首尾空白 + 连续空白压一个空格 + 长度 ≤ 40；空名/超长/重名拒绝（K3–K6） |
| 重名校验 | 大小写 + 空白归一后比较，`论文 阅读` 与 `  论文  阅读 ` 视为同名 |
| 上限 | 200 个分类 |
| 删除分类 | 分类定义与"收藏归属"在**同一 readwrite 事务**里改：`favCat` → `default`，收藏记录不删（K9） |
| 事务失败 | 注入 `runAtomic` 失败后，分类与归属都保持原状（K11） |
| 多标签页 | 分类变更走 `notify([])` → 其他标签页 `handleRemote` 重读分类与记录 |

单级分类，没有父子层级；分类定义不参与 `records` 的索引（`favCat` 只是普通字段，筛选在内存做，
当前规模 2000 条上限下成本可忽略）。

## 2. 批量事务边界（Phase C）

| 项 | 实现 |
| --- | --- |
| 入口 | 知识页"批量管理"按钮；按 tab 呈现不同动作集 |
| 选择范围 | 只对**当前 tab + 当前分类筛选**渲染出的行生效（`#kmList [data-km-select]`） |
| 全选 | "全选当前列表"只选当前可见 key，不碰其他分类/其他 tab（浏览器 K21.3：3/3 而不是全库） |
| 切 tab/换分类 | `fillKnowledgeTab` 用可见 key 白名单裁剪 `_kmSel`，隐藏项自动移出选择（避免误删） |
| 数量提示 | `已选 N / M 项 · 范围：当前列表（收藏）/ 当前分类（论文）`（K21.2） |
| 危险操作 | 清理历史前 `confirm`，文案明确"收藏/待读/阅读状态保留，仅剩历史的记录会被删除" |
| 写入方式 | 一次 `backend.mutateMany(keys, updater)`，**同一个 readwrite 事务**；不使用逐条 await |
| 回滚 | 任一 updater 抛错或 request 失败 → `tx.abort()`，整批不落盘（单测 B7、K11） |
| 提交后 | `_writeGen++` → `refreshCache()` → `notify(keys)` |
| 语义 | `fav-off` 只清 `fav/favAt`，保留 `favCat` 与整条记录（B2）；`history-clear` 对纯历史记录才整条删除（B6） |

支持动作：`fav-on/fav-off/later-on/later-off/cat/read-done/read-none/history-clear`。

## 3. 显式阅读状态契约（Phase D）

| 操作 | 结果 |
| --- | --- |
| 标记未读 | `readState='none'`、`progress=0`、`doneAt=0`、`stateSource='manual'`、`manualStateAt=now` |
| 标记已读 | `readState='done'`、`doneAt=now`、**不改 progress**（不伪造 100%）、`stateSource='manual'` |
| 再次打开页面 | `recordView` 只更新 `lastSeenAt`，不动 `readState`（R6：done 不会退回未读） |
| 自动滚动 | `saveProgressByKey` 在 `stateSource==='manual'` 时**只写 progress，不改状态**；手动未读时直接跳过（R3/R4） |
| 过期节流任务 | `scheduleProgress` 记录采样时刻；落盘时若 `manualStateAt > 采样时刻` → 丢弃（R5） |
| 多标签页 | 另一个标签页的人工操作会让本地待写任务的 `manualStateAt` 判定失效 |

**明确优先级**：人工 > 自动；同毫秒冲突按"后调用者"处理（`>` 而非 `>=`），并在
`KNOWLEDGE_DATA_FORMAT.md` 记录该边界。

## 4. 导出（Phase E）

- `readSnapshot()` 返回 `{ rows, source, complete, warning }`，**完整性跟随本次读取**；
  删除了共享变量 `_lastReadOk`。单测 E2 同时发起"必失败"和"必成功"两次导出，
  结果互不影响（bad.complete=false / good.complete=true）。
- 导出新增 `categories`，与 `records` 由**同一个只读事务**（`readAll()`）读出。
- 结构：`app / kind / schemaVersion(2) / exportedAt / records / categories / persistence / source / degraded / complete / warning`。
- 仍不导出 token、密钥、草稿历史、其他站点数据（单测断言记录里没有 `gh_token` / `content`）。

## 5. 导入（Phase F）

### 5.1 校验（纯函数，不写库）

见 `KNOWLEDGE_DATA_FORMAT.md` 第 5.1 节：大小 / JSON / app / kind / 版本 / 数量 / key 一致性 /
长度 / 枚举 / 数值范围 / 时间戳 / 重复键 / 分类重复 / 原型污染 / 嵌套深度。
单测覆盖 I1–I10，**10 项全部为"拒绝"路径**，且每次拒绝后 `Knowledge.list()` 数量不变。

### 5.2 预览

`previewImport()` 返回：`total / incoming / conflicts / stale / missingCategoryRefs /
newCategories / categoryConflicts / source / persistence / complete / token / canReplace`。
UI 以表格展示前 6 项 + 数据来源与完整性（浏览器 K22.1）。

### 5.3 合并（默认）

- 只插入本地缺失的记录；本地已有 `key` 一律保留（M3：冲突记录标题仍为空，未被导入覆盖）。
- 分类按 id 取并集，本地名称优先（M4）。
- 导入记录引用不存在的分类 → 落到 `default`（M8）。
- 不删除本地多出的记录（M7）。
- **不做整条覆盖**：v2 只有记录级 `updatedAt`，没有字段级时间戳，整条覆盖会静默丢字段。

### 5.4 替换

- 前置：`complete===true && source==='database' && persistence==='indexeddb'`（P1 拒绝不完整备份）；
  必须 `confirm`（P2）；UI 还要求先勾选"我已导出当前数据备份"。
- 实现：`replaceAll(rows, cats)` → **单个 readwrite 事务**内 `records.clear()` + 批量 `put` + 写 `favCategories`；
  不使用 `deleteDatabase`，不清空整个 `meta`。
- 原子性证据：注入 `replaceAll` 失败后，原有记录仍在（P5：`post:safe1` 未丢）。
- 并发：确认时携带 `expectToken`，确认期间任何写入导致 token 变化 → 拒绝并提示重新预览（P6）。

### 5.5 降级

内存降级模式下 `applyImport` 直接返回失败（R8），UI 显示"本地数据库不可用…不能导入"，
不会出现"看起来保存成功、刷新即丢"。预览阶段也会显示 `canReplace=false`。

## 6. Schema 与迁移（Phase G）

| 版本 | 值 | 是否变化 |
| --- | --- | --- |
| `DB_VERSION`（IDB 结构） | 1 | 未变（复用 `meta`） |
| `SCHEMA_VERSION`（数据） | 1 → **2** | 变化：分类定义 + `favCat` 语义 |
| 导入导出格式 | 2 | 新增 `categories`，兼容接受 v1 文件 |

`migrateMeta()` 幂等四步：跳过未来版本 → 归一化/补 `favCategories` → 修悬空 `favCat` →
写 `schemaVersion=2`。**真实浏览器验证**：K23 先用 `indexedDB.open(...,1)` 建 v1 库（2 条记录 +
`schemaVersion=1`），屏蔽 `app.js` 加载，写入后再放开刷新 → `schemaVersion` 变 2、补默认分类、
两条旧记录（收藏/待读）完整保留。不删库、不影响 `blog-draft-history`。

## 7. UI（Phase H）

| 新增 | 说明 |
| --- | --- |
| 分类筛选条 | "全部 N / 分类名 N …" chips + "管理分类"；只在收藏 tab 出现 |
| 分类管理对话框 | 逐行改名/删除 + 新建；默认分类删除按钮 `disabled`；Esc 关闭；焦点回到触发按钮 |
| 行内分类下拉 | 收藏行直接 `select` 改分类（无需进批量模式） |
| 批量栏 | 计数 + 范围提示 + 动作按钮；危险动作二次确认 |
| 导入对话框 | 文件选择 → 预览表格 → 合并/替换 → 结果提示；`aria-live` 报告区 |
| 导出按钮 | 沿用 9A-1，提示文案随 `complete` 变化 |

- 所有分类名、标题、导入错误信息都走 `escapeHtml`（K22.5 注入 `<img onerror>` 后 `__xss=false`、`img=0`）。
- 390px：批量栏换行、对话框 `width:min(560px,92vw)`，实测 `overflow=0`（K25.1/K25.3）。
- 深色：分类 chip 用设计令牌，实测 `rgb(91,140,255)` 可读（K25.2）。
- 键盘：模态内首个控件自动聚焦、Esc 关闭、关闭后焦点回到触发元素。
- **修复的既有映射问题**：`kmResolve` 对 `unknown`（元数据未加载）与 `missing`（确实不存在）已区分；
  本轮把导入预览/应用的失效判定从 `state==='exists'` 改为 `state!=='missing'`，
  避免"论文/资料元数据还没加载就把导入记录误判为失效而丢弃"（数据完整性优先）。

## 8. 测试（Phase I）

| 套件 | 结果 |
| --- | --- |
| `knowledge-import`（**新增**，node，55 项） | 55/55 PASS |
| `knowledge-management`（**新增**，Chromium，27 项） | 27/27 PASS |
| `knowledge-store`（回归，25 项） | 25/25 PASS（T11/T13 按 v2 契约更新） |
| `knowledge-center`（回归，29 项） | 29/29 PASS（K9 断言升到 v2 + categories） |
| 跨引擎 K4（Chromium/Firefox/WebKit） | 12/12 PASS（4 项 × 3 引擎） |
| `project-detail` / `related-reading` / `reading-experience` | 40/40、22/22、47/47 PASS |
| `sw-snapshot-unit` / `sw-consistency` | 15/15、37/37 PASS（版本 2026-11-20-4） |
| `audit` | 未发现问题 |

套件总数：**69 → 71**（新增 `knowledge-import`、`knowledge-management`）。
`scripts/run_tests.py` 只追加两条清单与 `knowledge` 分组，未改并行调度器/配对许可/CI 命令。
本地未跑 71 套全量，由 PR CI 执行。

RED/GREEN 证据（本轮真实修过的缺陷）：

1. **删除分类的 UI 流程无效**：`kmOpenCatManager()` 内部重开对话框时直接调 `kmOpenModal()`，
   新 DOM 没有重新绑定事件 → 第一次操作后所有按钮失效（RED：`dialogs=0`、分类未删）。
   改为递归调用自身（重渲染 + 重绑），并让提示信息按 id 现查（GREEN：K20.2–K20.7）。
2. **删除分类在真实 IDB 下失败**：`runAtomic` 的 meta 读取与记录写入顺序有误时事务提前结束。
   修复后真实浏览器 `del.ok=true, moved=1`（GREEN：K20.7 与单测 K9 双证）。
3. **导入验证把缺省字段当非法**：`scanUnsafe` 把 `undefined` 判为"非法类型"，
   导致 v1 导出（无 `categories`）被拒（RED：I9）。放行 `undefined` 后通过（GREEN）。
4. **`_injectBackend` 与迁移竞态**：`init()` 在分类 meta 落盘前就 resolve，测试读到 `null`
   （RED：T13）。让 `readyPromise` 覆盖迁移链后通过（GREEN）。

## 9. SW 与发布（Phase J）

- `CACHE_VERSION 2026-11-20-3 → 2026-11-20-4`（高于上一版；同序号数值比较由 `sw-snapshot-unit` U0 校验）。
- 无新增首屏脚本 → `REQUIRED_ASSETS`（8）与 `FIRST_SCREEN_ASSETS`（7）不变，`index.html` 不变。
- SW 升级只换缓存，不触碰 IndexedDB：`knowledge-management` K26 验证离线仍能读分类与导出。

## 10. 剩余限制

1. **合并是记录级、保守的**：不做字段级 last-write-wins，因此"只改标题"这类冲突不会被导入；
   这是刻意的（v2 缺字段级时间戳，覆盖会丢数据）。
2. **替换只接受完整备份**：`complete=false` 的文件只能合并。
3. **删除分类的并发边界**：迁移只覆盖当前缓存里的 key；另一标签页恰好在删除瞬间给同一分类新增收藏，
   会留下悬空 `favCat`，由**下次 init 的迁移**修回 `default`（数据不丢，归属修正延迟一步）。
4. **导入失效判定依赖已加载元数据**：`kmResolve` 对未加载类型返回 `unknown`，按"不判失效"处理，
   所以预览里的"失效内容数"可能偏小。
5. **分类不参与推荐**：推荐仍用 `tags/tech/series`，分类只是个人组织维度（不改 9B-1 权重）。
6. 未做云同步/账户/多级目录/统计仪表盘；项目仍无阅读进度（沿用 9D 决定）。

## 11. 交付物

- `BATCH9A2_REPORT.md`（本文件）
- `BATCH9A2_TEST_MATRIX.csv`（72 行测试矩阵）
- `KNOWLEDGE_DATA_FORMAT.md`（三层版本、记录/分类字段、迁移、导入导出契约）
- `knowledge-import-sample.json`（无真实个人数据的示例，2 记录 + 2 分类）
- 更新 `BATCH9_ARCHITECTURE.md` 第 3/6/8/9 节为已确认契约（含与规划的三处差异及原因）

## 12. 复现命令

```powershell
node tests/test53_knowledge_management.js
node tests/browser/knowledge-management.spec.js
node tests/test51_knowledge_store.js
node tests/browser/knowledge-center.spec.js
node tests/browser/cross-browser.spec.js --scenario=K4 --engines=chromium,firefox,webkit
node tests/browser/project-detail.spec.js
node tests/browser/related-content.spec.js
node tests/browser/reading-experience.spec.js
node tests/browser/sw-snapshot-unit.spec.js
node tests/browser/sw-consistency.spec.js
python scripts/run_tests.py --only knowledge-import knowledge-management knowledge-store knowledge-center
```

## 13. 实际耗时与平台成本

- 分支创建（2026-11-20 15:30:00）→ 本地验收与文档完成 = **约 50 分钟**（含数据层重写、UI、真实 IDB 迁移与三引擎）。
- 工具调用约 **70 次**；改动文件 15 个（新增 5、修改 8、删除 0，另含 2 个调试临时文件已清理）。
- 本地测试耗时：`knowledge-import` <1s；`knowledge-management` 约 65 秒；`knowledge-center` 约 70 秒；
  三引擎 K4 约 9 秒；`sw-consistency` 约 2 分 40 秒；`reading-experience` 约 80 秒。
- 平台未提供服务积分口径，**未编造数值**；未新增依赖、未访问外部服务、未上传任何数据。
