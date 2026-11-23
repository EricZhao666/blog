# 知识库数据格式与迁移契约（KNOWLEDGE_DATA_FORMAT）

> 适用范围：`js/knowledge.js`（IndexedDB `blog-knowledge`）、导出 JSON、导入校验与合并/替换规则。
> 本文只描述**已实现并验证**的行为，不含规划内容。

## 1. 三层版本号（不要混淆）

| 版本 | 位置 | 当前值 | 含义 | 变更方式 |
| --- | --- | --- | --- | --- |
| IndexedDB 结构版本 | `DB_VERSION` | `1` | object store / index 的物理结构 | 只在需要新 store/index 时 +1（9A-2 未变） |
| 知识数据版本 | `SCHEMA_VERSION` / `meta.schemaVersion` | `2` | 记录与分类定义的数据语义 | 迁移函数补齐并写入 |
| 导入导出格式版本 | JSON 里的 `schemaVersion` | `2` | 导出文件格式 | 导入端只接受 `[1, 2]` |

9A-2 只把**数据版本**从 1 升到 2，物理结构没动：
分类定义存在 `meta` store 的 `favCategories` 键里，记录继续用 `favCat` 引用，不新建 store。

## 2. 数据库结构

```
blog-knowledge (v1)
├── records   keyPath: 'key'
│   索引: by_type(type) / by_fav(fav) / by_later(later) / by_lastSeen(lastSeenAt) / by_state(readState)
└── meta      keyPath: 'k'
    键: schemaVersion  → 2
    键: favCategories  → [{ id, name, system }]
```

### 2.1 记录（records）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | **主键**，`type:refId`；type ∈ post/course/paper/material/lib/project/note |
| `type` / `refId` | string | 与 `key` 冗余，便于索引 |
| `title` | string | 展示标题（≤300 字符，纯文本） |
| `fav` / `favAt` | 0\|1 / ts | 收藏状态与时间 |
| `favCat` | string | 所属收藏分类 ID，默认 `default` |
| `later` / `laterAt` | 0\|1 / ts | 待读状态与时间 |
| `readState` | `none`\|`reading`\|`done` | 阅读状态 |
| `progress` | number | 0–1，自动滚动写入；手动"已读"不会伪造为 1 |
| `stateSource` | `manual`\|`auto`（可选） | 状态来源；`manual` 表示人工设置过，自动进度不再改状态 |
| `manualStateAt` | ts（可选） | 人工状态时间，用于压过更早的滚动采样 |
| `firstSeenAt` / `lastSeenAt` | ts | 浏览历史；`lastSeenAt=0` 表示已清理 |
| `doneAt` | ts | 完成时间；标记未读时清 0 |
| `updatedAt` | ts | 最近一次写入时间（记录级，不是字段级） |

### 2.2 分类（meta.favCategories）

```json
[{ "id": "default", "name": "默认分类", "system": true },
 { "id": "cat-abc123", "name": "论文", "system": false }]
```

- `id` 稳定且唯一；重命名只改 `name`。
- 默认分类（`id=default`）**恒存在**、排第一、不可删除（可重命名）。
- 名称：去首尾空白、连续空白压成一个空格、长度 ≤ 40、同名校验大小写不敏感。
- 上限 200 个分类。

## 3. 迁移（v1 → v2）

`migrateMeta()` 在 `init()` 内执行，幂等：

1. 读 `meta.schemaVersion`；若 `> 2` → 直接跳过（不破坏性写入未来版本）。
2. 归一化 `meta.favCategories` 并写回（缺失时补默认分类）。
3. 扫描记录：`fav=1` 且 `favCat` 指向不存在分类的，改回 `default`（同一批量事务）。
4. 写 `meta.schemaVersion = 2`。

保证：不删库、不动 `blog-draft-history`、不重建 store、失败时原数据不变（写操作在事务内）。

**失败可见性**：迁移结果记录在 `status().migration`：

```js
{ ok, failed, future, from, to, fixed, reason }
```

- 失败时**不写** `schemaVersion`，`reason` 直接用于 UI 提示（toast），下次 `init()` 幂等重试；
- 部分状态（分类已写入、记录修正失败）可通过重新 init 修复，不会留下半改记录（单测 T3.3/T3.4）；
- `schemaVersion > 2`（未来版本）→ `future=true`，一个字节都不写，并拒绝
  `addCategory/renameCategory/removeCategory/assignCategory/bulk/applyImport`（T3.5）。

**统一写入闸门**：`future` 或 `failed` 时，`mutateWithOutcome()` 会拒绝**所有**记录写入
（浏览历史、收藏、待读、阅读进度、删除、历史清理），返回 `{ ok:false, blocked:true, reason }`。
只读查询与导出完全不受影响；不清空数据库、不切换到内存降级，因此不会"看起来写成功"。
闸门原因可通过 `Knowledge.writeBlockedReason()` 读取（空串表示可写），UI 用它给出明确提示。
真实 IndexedDB 回归见 `knowledge-management.spec.js` K28：11 类写入全部被拒，
`records` 序列化结果与 `meta.schemaVersion` 字节级不变。

**自动裁剪同样受闸门保护**：`pruneHistory()` / `enforceHistoryLimit()` 在闸门命中时不启动、
执行前再查一次、事务内 updater 再查一次；只有真正写进去才计入裁剪数。
正常 v2 库不受影响（仍按 500 上限裁剪）；`migrateMeta()` 的修复写入走 backend 直连，不被闸门阻断。
**真实浏览器验证**：先建 v1 库（仅 `schemaVersion=1`，两条记录），再加载新代码，见
`tests/browser/knowledge-management.spec.js` 的 K23（K23.1/K23.2/K23.3）。

## 4. 导出格式

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
  "categories": [ ... ],
  "records": [ ... ]
}
```

- `records` 与 `categories` 来自**同一个只读事务**（`readAll`），不会出现"记录是新分类是旧"。
- `complete` 表示"未降级 + 本次事务读成功"，由**本次读取结果自己携带**，
  不再用共享变量，因此并发导出不会互相污染（单测 E2）。
- 只导出知识数据：不含 token、密钥、草稿历史、编辑器内容、其他站点数据。

9A-1 的旧导出（无 `categories`、`schemaVersion: 1`）仍可导入：缺少分类时按默认分类补齐。

## 5. 导入（安全合并 / 显式替换）

### 5.1 校验（写入前完成，失败不动库）

| 检查 | 规则 |
| --- | --- |
| 文件大小 | ≤ 2MB |
| JSON | 语法错误直接拒绝 |
| 外壳 | `app === 'ericzhao-blog'`、`kind === 'knowledge'` |
| 版本 | `schemaVersion ∈ [1,2]`；更高版本明确拒绝（提示升级） |
| 数量 | `records ≤ 5000`、`categories ≤ 200` |
| 记录键 | `key` 必须是 `type:refId`，type 在已知枚举内，refId ≤ 200，且 `type/refId` 与 key 一致 |
| 长度 | title ≤ 300、分类名 ≤ 40、favCat ≤ 64、分类 id ≤ 64 |
| 枚举 | `fav/later ∈ {0,1}`、`readState ∈ {none,reading,done}` |
| 数值 | `progress` 有限且在 0–1 |
| 时间戳 | 非负、有限、不超过 now+1 天 |
| 重复 | 同一 `key` 出现两次 → 整份拒绝；分类 id / 名称重复 → 整份拒绝 |
| 结构 | 嵌套深度 ≤ 6；拒绝 `__proto__` / `constructor` / `prototype` 字段 |
| 人工状态 | `stateSource ∈ {manual, auto}`（可选）、`manualStateAt` 合法时间戳（可选）；两者缺省时按"无人工状态"处理，兼容 v1 与早期 v2 备份 |

不使用 `eval` / `new Function`，不执行文件里的任何字符串。

### 5.2 预览统计

导入前展示：文件记录数、可新增、已存在冲突、失效内容（目标不存在）、新增分类、
分类冲突、数据来源/完整性。**预览不写库**。

### 5.3 合并（默认，保守）

- 只插入本地**不存在**且目标仍存在的记录；本地已存在的 `key` 一律保留原样。
- 分类：按 `id` 取并集，**本地名称优先**，不覆盖本地归属。
- 导入记录里指向不存在分类的 `favCat` → 落到 `default`。
- 不因为导入文件缺少某条记录而删除本地记录。
- 不做"整条较新的记录覆盖较旧的记录"——v1/v2 只有记录级 `updatedAt`，无法做字段级 last-write-wins。

### 5.4 替换（显式，有前提）

- 仅当 `complete === true` 且 `source === 'database'` 且 `persistence === 'indexeddb'` 时可选；
  不完整备份一律拒绝（单测 P1）。
- 必须二次确认，并在 UI 上先勾选"我已导出当前数据备份"。
- 实现为**单个 readwrite 事务**：先在同一事务内 `getAll()` + `get(meta)` 校验快照指纹，
  一致才 `records.clear()` + 批量 `put` + 写 `favCategories`；任一环节失败整体 abort
  （单测 P5：注入失败后原记录仍在）。
- 不使用 `deleteDatabase`，不清空整个 `meta`。
- 快照指纹（token）= 每条记录的 `key/updatedAt/fav/later/favCat/readState/progress/doneAt/manualStateAt/lastSeenAt`
  排序后哈希 + 分类串。**不是**"条数 + 最大 updatedAt"——后者在同时刻写入或等量替换时会碰撞。
- 确认期间若其他标签页写入导致指纹变化 → 事务内 aborted，拒绝并提示重新预览
  （单测 T2.2/T2.3、浏览器 K27.1/K27.2）；指纹未变时正常完成（T2.4、K27.3），不做无条件重试。

### 5.5 降级与并发

- 内存降级模式（IndexedDB 不可用）**禁止导入**，不宣称保存成功（单测 R8）。
- 导入成功后：刷新本地缓存 → 广播通知 → 其他标签页重读（浏览器 K24 验证）。
- 导入失败不裁剪本地长期数据来"凑成功"。

## 6. 示例文件

`knowledge-import-sample.json`：2 条记录 + 2 个分类，标题均为占位文本，**不含任何真实个人数据**。
可用于验证导入流程；导入后这些记录指向真实内容 ID（`vla-model-intro` / `rl-from-mdp-to-ppo`），
所以在本地会显示为可打开的项目。

## 7. 兼容性一览

| 场景 | 行为 |
| --- | --- |
| 9A-1 数据库（无 `favCategories`） | 迁移补默认分类，记录不变 |
| 9A-1 导出文件（`schemaVersion:1`、无 categories） | 可合并导入，收藏归默认分类 |
| 本站 9A-2 导出文件 | 可原样导回（幂等，合并 0 条） |
| 未来版本文件（`schemaVersion>2`） | 明确拒绝 |
| 非本站 JSON / 任意对象 | 拒绝（app/kind/结构校验） |
| 目标内容已删除的记录 | 预览计入"失效"，不导入 |
