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
- `BATCH9A2_TEST_MATRIX.csv`（90 行测试矩阵，含 §13 修订的 A-73~A-90）
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

## 13. 最终数据契约修订（2026-11-23）

CI tests #116 通过后复查三个数据完整性边界，结论与修改如下。

### 13.1 人工阅读状态的导出/导入往返（已修）

**问题（RED）**：`publicRecord()` 只输出固定 14 个字段，`validateRecord()` 也只白名单这 14 个，
`stateSource` / `manualStateAt` 在导出时被丢弃，导入时被忽略。所以"手动标记已读/未读"这条信息
一旦导出再导入就退化成普通记录，后续滚动进度会把状态改回去。

| 位置 | 修改 |
| --- | --- |
| `publicRecord()` | 有值时附带 `stateSource` / `manualStateAt`；缺省不写，保持旧文件形状 |
| `validateRecord()` | `stateSource ∈ {manual, auto}`、`manualStateAt` 走 `isTs()`（非负、不超前 1 天）；非法即整份拒绝；合法则原样返回 |
| 版本 | **仍为 schemaVersion=2**，两个字段都是可选项；v1 与早期 v2 备份（无这两个字段）继续可导入 |

**GREEN 证据**（`test53` T1.1–T1.7）：
- T1.1 导出两条人工记录 → `stateSource='manual'`、`manualStateAt>0` 均在；
- T1.2 校验后字段类型与数值不变；
- T1.3 合并到新库 + 重新 init（模拟重开数据库）后 `readState='done'` 且 `stateSource='manual'` 仍有效；
- T1.4 导入后写入 0.2 / 0.8 的滚动进度，`done` 不被改回、人工未读仍是 `none` 且 `progress=0`；
- T1.5/T1.6 缺字段的 v2、v1 文件照常导入；
- T1.7 `stateSource='robot'`、`manualStateAt=-5` 被拒。
`readState / progress / doneAt` 语义未改。

### 13.2 替换的并发检查（已修）

**问题（RED）**：`expectToken` 只在 `replaceAll` 之前用 `readSnapshot()` 比一次；
另一个标签页若在这之后、`clear()` 之前写入，替换会静默覆盖它。
另外旧 token = `条数 + 最大 updatedAt + 分类串`，**同一毫秒内写入或等量替换会碰撞**（单测 T2.1 用合成行证明）。

| 位置 | 修改 |
| --- | --- |
| `tokenOf()` | 改为对每条记录的 `key/updatedAt/fav/later/favCat/readState/progress/doneAt/manualStateAt/lastSeenAt` 排序后做 FNV-1a 哈希，再拼分类串；任一条变化都会变 |
| IDB `replaceAll(rows, cats, expect)` | 在**同一个 readwrite 事务内**先 `getAll()` + `get(meta)` 算出当前指纹，与 `expect` 一致才 `clear()` + `put`；不一致 → `tx.abort()` 并 resolve `{ok:false, conflict:true}` |
| 内存后端 `replaceAll` | 在串行队列内做同样的检查（顺序等价于单事务） |
| `applyImport` | 预检查保留（快速失败、提示友好），真正的权威判断交给事务内；收到 `conflict` 返回"请重新预览"，不写任何数据 |

**GREEN 证据**：
- 单测 T2.1 指纹能区分"同条数、同最大 `updatedAt`"的内容差异；
- T2.2 预览拿 token → 另一实例写入 → 直接调 `backend.replaceAll(..., staleToken)` → `{ok:false, conflict:true}`，3 条记录原样；
- T2.3 走 `applyImport(mode:'replace', expectToken)` 同样被拒，4 条记录未变；
- T2.4 token 未变时替换正常完成（**没有无条件重试**）；
- 浏览器 K27.1–K27.3 用两个真实标签页复现同一窗口：B 写入后 A 的旧 token 被拒、原数据完整、重新预览后替换成功。

保留：二次确认、`complete/source/persistence` 完整备份限制、事务失败回滚（P1/P2/P5 仍绿）。

### 13.3 迁移异常的可见性（已修）

**问题（RED）**：`migrateMeta()` 末尾 `.catch(function () { return null; })` 把一切迁移错误吞掉，
`init()` 照常 resolve，UI 认为迁移成功；`schemaVersion` 未升级时也不会重试提示。
部分状态确实存在：`meta.favCategories` 可能已写、记录修正失败（T3.3 复现）。

| 位置 | 修改 |
| --- | --- |
| `migrateMeta()` | 改为记录 `migrationState{ok, failed, future, from, to, fixed, reason}`；失败时 `console.warn` 并**不**写 schemaVersion（下次 init 幂等重试） |
| `status()` | 新增 `migration` 字段，UI 可读 |
| 写保护 | `migrationState.future === true` 时 `addCategory/renameCategory/removeCategory/assignCategory/bulk/applyImport` 一律拒绝，避免旧代码覆盖更新版本的数据 |
| `app.js` | `knowledge:status` 与首次 `init()` 回调各加一次（去重）toast，迁移失败/未来版本不再静默 |

**GREEN 证据**：
- T3.1 v1 库 + 注入 `setMeta` 失败 → `status().migration.failed=true`、`schemaVersion` 仍为 1；
- T3.2 解除注入后重新 init → `schemaVersion=2`、默认分类补齐（可安全恢复）；
- T3.3 分类已写、记录修正失败 → 状态可见且脏记录 `favCat` 未被半修改；
- T3.4 重试后悬空分类修回 `default`；
- T3.5 未来版本（schemaVersion=9）→ 版本不变、两个分类原样、`addCategory` 与 `applyImport` 都被拒（不降级覆盖）。
未重建数据库、未改 IDB 结构。

### 13.4 统一写入闸门（合并前补充）

**问题**：`writeBlockedReason()` 之前只检查 `migrationState.future`，且普通写入（`mutateWithOutcome`）
没有检查——未来版本或迁移失败时，浏览历史、收藏、待读、进度、删除仍会写入，等于可能覆盖新版数据。

| 位置 | 修改 |
| --- | --- |
| `writeBlockedReason()` | 同时覆盖 `future` 与 `failed`（失败时带上迁移原因） |
| `mutateWithOutcome()` | **所有**记录写入的统一闸门：命中时返回 `{ok:false, blocked:true, reason}`，不写库、不降级内存、不清库 |
| 既有分类/批量/导入闸门 | 复用同一函数（行为不变，只是失败态也生效） |
| 只读路径 | `list/counts/state/exportData/previewImport/validateImport/categories` 不受影响 |
| UI 提示 | `Knowledge.writeBlockedReason()` 透出真实原因；`kmWriteFailText()` 用它替换笼统的"保存失败"（无布局改动） |

**GREEN 证据**：
- 单元 T4.1–T4.2：未来版本（真实迁移路径置位）下 `recordView/setFlag/setReadState/saveProgress/
  clearHistory/remove/bulk/addCategory/assignCategory/applyImport` 全部被拒，记录 JSON 前后**完全一致**，
  `schemaVersion` 仍为 9，只读查询与导出（`complete=true`）正常；
- T4.3–T4.5：迁移失败态同样全部被拒、`degraded=false`（未降级）、`exportData().source='database'`，
  解除闸门后写入恢复；
- 浏览器 K28.1–K28.3：**真实 IndexedDB** v2 库 + `schemaVersion=9`，11 类写入全部被拒，
  `getAll()` 序列化结果与 meta 版本号字节级不变；
- K28.4：迁移失败态（注入）下同样全拒、原数据不变、解除后 `setFlag` 成功。

### 13.5 自动历史裁剪的闸门（发布前补充）

**问题**：`pruneHistory()` 直接调 `backend.mutate()`，绕过了 `mutateWithOutcome` 的写入闸门；
`enforceHistoryLimit()` 也不看闸门状态。未来版本/迁移失败时，自动裁剪仍可能**删掉本地历史记录**。

| 位置 | 修改 |
| --- | --- |
| `pruneHistory()` 入口 | `writeBlockedReason()` 命中时直接返回 0（不读、不算、不写） |
| 每个候选的执行前 | 队列真正执行时再查一次；事务内 updater 第一行**再查一次**（最权威） |
| `enforceHistoryLimit()` | 闸门命中时不安排裁剪 |
| 计数语义 | 只有 `applied=true` 才计入 `changed`（跳过/被拦不再虚报裁剪数） |

不受影响：正常 v2 数据库照常按 500 上限裁剪（T5.3：520 → 500，删 20）；
`migrateMeta()` 走 `backend.setMeta/mutateMany` 直连，**不经过闸门**（T5.5 仍能修悬空分类）。

**GREEN 证据**（单元 T5.1–T5.5）：
- T5.1 未来版本：`_pruneHistory` 返回 0，520 条记录 JSON 前后完全一致，`schemaVersion` 仍 9；
- T5.2 迁移失败态：同样 0 删除、记录不变；
- T5.3 正常 v2：520 → 500，`removed=20`，受保护记录不误删；
- T5.4 已排队裁剪：在"取到候选、尚未写入"时关闭闸门 → `removed=0`，520 条一条不删；
- T5.5 迁移修复不被闸门阻断（悬空 `favCat` 仍修回 default，版本升到 2）。

真实 IndexedDB 侧由既有 K28 覆盖（11 类写入被拒、`getAll()` 序列化与 meta 字节级不变），
本轮未再新增 500 条规模的浏览器用例，以免把专项拖成分钟级。

### 13.6 本轮新增/调整的测试

`knowledge-import` 55 → **81 项**（新增 T1.1–T1.7、T2.1–T2.4、T3.1–T3.5、T4.1–T4.5、T5.1–T5.5 共 26 项）；
`knowledge-management` 27 → **30 项**（新增 K27.1–K27.3 双标签替换窗口）。
其余套件未改动，本地只跑受影响的三套 + `git diff --check`，71 套全量由 PR CI 执行。
`CACHE_VERSION`、SW 策略、UI 布局、推荐模块、CI 配置均未改动。

## 14. 实际耗时与平台成本

- 分支创建（2026-11-20 15:30:00）→ 本地验收与文档完成 = **约 50 分钟**（含数据层重写、UI、真实 IDB 迁移与三引擎）。
- 工具调用约 **70 次**；改动文件 15 个（新增 5、修改 8、删除 0，另含 2 个调试临时文件已清理）。
- 本地测试耗时：`knowledge-import` <1s；`knowledge-management` 约 65 秒；`knowledge-center` 约 70 秒；
  三引擎 K4 约 9 秒；`sw-consistency` 约 2 分 40 秒；`reading-experience` 约 80 秒。
- 平台未提供服务积分口径，**未编造数值**；未新增依赖、未访问外部服务、未上传任何数据。
