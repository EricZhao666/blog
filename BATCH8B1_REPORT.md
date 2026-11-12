# Batch 8B-1 交付报告：已有文章的编辑与安全更新

- 基线：`main@1e050b837ec71374d09cabbc290d0eb7601eb152`（PR #8 合并后）
- 分支：`feature/batch8b1-post-editing`
- 结论：**本地完成，专项 + 完整回归全绿，可手动开 PR**（未 push、未建 PR、未合并、未部署）
- 正式文章数据：**零改动**（`git status` 只有代码/测试/文档）

---

## 1. 新增与更新模式的设计

### 1.1 模式对照

| 维度 | 新增模式（Batch 8A） | 编辑模式（Batch 8B-1） |
| --- | --- | --- |
| 入口 | `#/editor` | `#/editor/<id>`（下拉选择或直接访问深链） |
| 页面标题 | ✏️ 新建文章 | 📝 编辑文章 + `id: <id>（固定）` 徽标 |
| id 来源 | 标题 → 确定性 slug（冲突加 `-2`） | **原文章 id，永不改变** |
| 日期 | 自动取今天（无输入框） | 回填原日期；只有用户改它才会变 |
| 导出按钮 | 📤 导出文章 | 📤 导出更新稿 |
| 文件名 | `<id>.json` | `<id>.update.json` |
| 载荷 | `id/title/date/tags/excerpt/content` | `op/id/original/post` |
| 草稿键 | `blog_draft` | `blog_draft_edit::<id>`（每篇独立） |
| 落地方式 | `import_post.py`（默认 add） | `import_post.py --mode update` |

### 1.2 编辑器侧实现要点

```
路由：#/editor            → renderEditor(null)      → _editorMode = 'new'
      #/editor/<id>       → prepareEditorEdit(id)   → _editorMode = 'edit'
                             ├─ 找不到          → 'blocked' 兜底页（文章不存在）
                             ├─ 兼容期文章       → 'blocked' 兜底页（只读，明确说明原因）
                             ├─ 正文请求失败     → 'blocked' 兜底页（**不动任何草稿**）
                             └─ 成功            → 记录 _editCtx 原文快照并渲染表单
```

- `_editCtx` = `{ id, title, date, tags[], excerpt, content }`，其中 `content` 是**磁盘上原封不动的正文**（不 trim、不改行尾），它是更新稿 `original` 快照的来源；
- 标题、标签、摘要、日期、正文全部可改；**id 与链接不变**（`#/post/<id>`、`data/posts/<id>.md` 都不动）；
- 预览继续走 `renderMarkdown()` → `marked` + `DOMPurify.sanitize()`，未引入任何新的 HTML 注入路径；
- 切模式 / 切文章 / 离开编辑器时先 `flushDraft(true)`，两种草稿各写各的键，互不覆盖；
- `blocked` 模式下 `draftStorageKey()` 返回 `null`，`writeDraft()` 直接返回 false —— 加载失败的页面**不可能**写坏已有草稿；
- 兼容期文章（`js/user-posts.js`）在编辑器里是只读的：正文内联在 JSON 数组里，导入器不写该文件，因此不提供编辑表单，并明确提示"请先迁移到 `data/posts/<id>.md`"。

### 1.3 兼容期数据结构调查（`js/user-posts.js`）

```js
const USER_POSTS = [ { id, title, date, tags[], excerpt, content } ];   // 正文内联
```

- 它是**单一 JS 数组字面量**，不是逐文件结构；改写它意味着整文件重写，
  与 8A「只写 A 类权威源（`data/posts/<id>.md` + `js/data.js`）」的边界冲突；
- `split_posts.build()` 对这批文章的产出只有搜索语料 + manifest 条目（`file: null`），
  不会生成 md；
- 因此本轮判定：**只读**。编辑器明确提示，导入器对这批 id 的 update 请求返回退出码 2，
  两者都不写 `js/user-posts.js`（test34 U19 / test35 E11 双向验证）。

---

## 2. 修改文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `js/app.js` | 改 | 新增编辑模式：`#/editor/<id>` 路由、`prepareEditorEdit()`、`renderEditorBlocked()`、`buildUpdatePayload()`、`readEditForm()`/`isRealDate()`/`editHasChanges()`；草稿按模式/文章分键（`blog_draft` / `blog_draft_edit::<id>`）；`exportPost()` 按模式分派；新增 `openEditorPost()` / `exitEditorEdit()` / `editorContext()` |
| `css/style.css` | 改 | 模式栏、文章下拉、模式徽标、日期行的样式（全部用主题变量，深色模式可用） |
| `scripts/import_post.py` | 改 | 新增 update 模式：`op_of()`/`validate_update()`/`find_target_index()`/`verify_original()`/`build_update_plan()`/`apply_update_plan()`；新增 `--mode auto\|add\|update`；新增锁占用退出码 3；新增"更新前一致性预检"；回滚覆盖正文 |
| `tests/test34_post_update.py` | 新增 | 更新模式契约 67 项 |
| `tests/test35_editor_update.js` | 新增 | 编辑器编辑模式 78 项 |
| `tests/test33_import_post.py` | 改 | 文件体量上限从 1 MiB 提到 4 MiB 后，超大文件夹具改为读取模块常量（**断言不变**：超限必须拒绝） |
| `scripts/run_tests.py` | 改 | 注册 `test34` / `test35` |
| `package.json` | 改 | `test:js` 纳入 `test35_editor_update.js` |
| `README.md` | 改 | 发布流程加"改已有文章"、测试清单、兼容期文章只读说明 |
| `BATCH8B1_REPORT.md` | 新增 | 本文件 |

未改动：`js/data.js`、`data/posts/*.md`、`data/search-index.json`、`data/posts/manifest.json`、
`feed.xml`、`js/user-posts.js`、`.github/workflows/*`、`scripts/build_content.py`、`scripts/split_posts.py`。

---

## 3. JSON 更新稿格式

```json
{
  "op": "update",
  "id": "embodied-ai-notes",
  "original": {
    "title": "具身智能：让AI真正\"住进\"物理世界",
    "date": "2026-08-09",
    "tags": ["具身智能", "AI", "机器人"],
    "excerpt": "……原摘要……",
    "content": "# 具身智能……\n\n（**导出时**磁盘上的完整原文）\n"
  },
  "post": {
    "id": "embodied-ai-notes",
    "title": "改后的标题",
    "date": "2026-08-09",
    "tags": ["具身智能", "AI", "机器人"],
    "excerpt": "改后的摘要",
    "content": "# 改后的正文\n\n……\n"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `op` | string | 固定 `"update"`；缺省视为 `add`（8A 兼容） |
| `id` | string | 目标文章 id，必须已存在且为 `data/posts/<id>.md` |
| `original` | object | **原版本快照**（版本校验依据），五个字段缺一不可 |
| `original.content` | string | 导出时的完整原文（不 trim、不改行尾），用于与磁盘逐字节比对 |
| `post` | object | 修改后的完整文章数据，字段同 8A；`post.id` 必须等于顶层 `id` |
| 可选 `post.series` / `post.seriesOrder` | string/int | 显式改系列信息；缺省时**继承**现有值（不会因为改标题而丢掉系列） |

**规范化规则（浏览器与 Python 完全一致）**：正文比较时只把 `\r\n`、`\r` 统一成 `\n`，
**不裁剪首尾空白**；导出后的 `post.content` 才按 8A 的规则去掉首尾空白。
两侧都不做 Unicode NFC/NFD 归一化（JSON 往返保留码点），因此比对是逐字节严格的。

**可复现性**：字段顺序固定、不含时间戳，同样的修改重复导出 → 字节完全一致（test35 E8）。

---

## 4. 版本冲突保护方法

### 4.1 三道闸（按顺序）

| # | 检查 | 触发条件 | 退出码 |
| --- | --- | --- | --- |
| 1 | `ensure_canonical` | `js/data.js` 不是生成器当前的输出（有人手改/别的工具写过） | 1 |
| 2 | `ensure_repo_consistent` | `build_content.py --check` 不通过（正文被手改却没重建、产物过期等） | 1 |
| 3 | `verify_original` | `original` 快照与**当前磁盘**的正文/标题/日期/标签/摘要不一致 | 2 |

第 3 道闸前后各执行一次：**计划阶段**（给用户看 dry-run 结果）+ **锁内**（真正写之前）。
锁内那次是为了消除 TOCTOU：拿到锁之后重新 `collect()` 整个仓库，再验一遍。

### 4.2 为什么用"快照"而不是"哈希"

- 需求允许"哈希或等效快照"；这里选**快照**，因为它不依赖任何 JS 侧的哈希实现：
  浏览器只需要把加载到的原文原样带上，Python 用同一套规范化规则（仅统一行尾）逐字节比对即可，
  天然满足"浏览器导出与 Python 导入使用相同规范化规则"这条硬要求；
- 也不依赖 `data/posts/manifest.json` 的哈希（避免"manifest 陈旧 → 误放行"或
  "manifest 缺失 → 无法编辑"两种情况）；
- 代价是更新稿体积约为正文的两倍（实测 `embodied-ai-notes` 更新稿 3.6 KB），
  因此把导入文件上限从 1 MiB 提到 4 MiB。

### 4.3 冲突时的行为

- 一律**直接失败**，不提供 `--force`、不做三方合并、不"尽量应用能应用的字段"；
- 报错信息包含**当前值**，例如：
  `原版本校验失败：正文已变化（当前 142 字符 / 快照 1425 字符）—— 这份更新稿基于旧版本，请重新打开编辑器加载最新版本后再改。`
- 拒绝时零写入（test34 U7/U8a/U8b 都用逐字节快照证明）。

---

## 5. 原子写入和回滚策略

### 5.1 写入顺序（全部在 `.content-build.lock` 内）

```
[锁外] 读 JSON → 校验字段 → 读仓库 → 规范检查 → 一致性预检 → 定位文章 → 版本校验 → 计算产物与 diff
[锁内] 1) 重新 collect() 整个仓库，复核 id 集合 / data.js 规范性 / 原版本   ← 消除 TOCTOU
       2) 备份：4 个派生文件 + 目标正文
       3) 覆盖 data/posts/<id>.md（临时文件 + os.replace）
       4) 覆盖 js/data.js（整份由 render_data_js 渲染，顺序/注释/其他文章由生成器保证）
       5) 从磁盘重新 collect() → build_artifacts() → write_artifacts()（搜索语料/清单/feed）
       6) 断言文章 id 集合与计划完全一致 → 跑官方 build_content --check
[失败] 还原备份字节（正文按备份还原，不删除）；再跑一次 --check
       若回滚本身失败：打印 [ROLLBACK-INCOMPLETE] 并列出需要人工核对的文件
```

- 单文件写入用"同目录临时文件 + `os.replace`"，不会写出半个文件；
- 多文件不是数据库事务，因此靠"锁 + 备份 + 失败还原 + 事后 `--check`"来保证不会留下被误认有效的半成品；
- `js/data.js` 只做**原位替换**（该文章在 `POSTS` 中的下标不变），所以 diff 只包含这一篇；
- `TAG_ORDER` 只追加新标签、从不删除（删标签后旧的排序项留在表里，不渲染、无副作用）。

### 5.2 回滚覆盖范围

| 场景 | 回滚内容 |
| --- | --- |
| 写正文失败 | 派生文件按备份还原；正文未变 |
| 写 data.js 失败（含 Ctrl-C） | 正文还原为旧字节 + 派生文件还原 |
| 重建派生数据失败 | 同上 |
| `--check` 不通过 | 同上（保证仓库回到"可重新生成"的状态） |
| 回滚后仍不一致 | `[ROLLBACK-INCOMPLETE]` + 具体文件清单，人工介入 |

test34 U13 用"注入写 data.js 异常"验证：退出码 1、提示已回滚、仓库逐字节复原、
无 `.tmp` 残留、正文仍是原内容，之后可以重新更新成功。

### 5.3 并发

- 构建锁 `.content-build.lock` 覆盖整个"复核 + 写入"窗口；
- 锁被占用 → 退出码 **3**，零写入且**不删除**别人的锁（test34 U22）；
- 锁内重读 + 重新校验，因此"计划和写入之间被别人改了"会以退出码 2 失败，而不是静默覆盖。

---

## 6. 新增测试及结果

### 6.1 `tests/test34_post_update.py`（67 项，PASS 67）

| 组 | 覆盖 |
| --- | --- |
| U1–U6 | 正常改正文 / 标题 / 标签+摘要 / 中文·特殊字符·代码块 / id 不变 / 日期默认不变与显式修改 |
| U7–U8 | 同一更新稿重复导入 → 拒绝；原正文已被他人更改 → 拒绝；手改未重建 → 预检拦截 |
| U9–U12 | 缺 original / 缺 original.content / 文章不存在 / 非法 JSON / 路径逃逸 / 顶层 id 与 post.id 不一致 |
| U13 | 写入中断 → 回滚后逐字节一致，且可重新更新成功 |
| U14–U16 | 搜索索引 / Manifest / RSS 更新；其他文章完全不变；新增模式（8A）无回归 |
| U17 | 导入器不 import 任何网络库，也没有 `git push`/`curl` 调用 |
| U18–U20 | `--mode` 与稿件类型不符 → 拒绝；兼容期文章 → 拒绝；非规范 data.js → 拒绝 |
| U21–U23 | id 集合与顺序不变；锁被占用 → 退出码 3 零写入；dry-run 零字节变化 |

### 6.2 `tests/test35_editor_update.js`（78 项，PASS 78）

| 组 | 覆盖 |
| --- | --- |
| E1–E5 | 选择器列全部文章 / 打开已有文章回填五字段 / 改标题不动 id / 日期默认与校验 / 预览被 DOMPurify 净化 |
| E6–E9 | 未修改 → 明确提示且不出文件；更新稿结构与文件名；重复导出字节一致；成功文案只说"本地文件，站点尚未更新" |
| E10–E12 | 正文加载失败不清草稿（且模式变 blocked）；兼容期文章只读且无表单；两种模式草稿互不覆盖 |
| E13 | 浏览器后退回到编辑模式并恢复草稿；前进离开编辑器不残留表单 |
| E14 | 不存在的 id → 提示且无表单 |
| E15 | 全程零非 GET 请求、无跨站请求、无 GitHub API 请求 |
| E16–E17 | `POSTS`/`USER_POSTS` 未被编辑器改动；`#/post/<id>` 深链与 id 保持不变 |

### 6.3 端到端联调（一次性验证，未提交脚本）

在临时仓库副本上，用**真实浏览器导出的更新稿**（jsdom 中点击导出得到
`embodied-ai-notes.update.json`，3 643 字节）跑 `import_post.py --mode update`：

```
操作    : 更新（update）
文章 id : embodied-ai-notes（不变，URL 不变）
正文    : 已修改（1425 → 1462 字符）
OK: 已更新 embodied-ai-notes（文章 18 篇）
$ python scripts/build_content.py --check
OK: 元数据 / 正文 / 搜索语料 / 完整性清单 / feed 一致，且可由当前输入重新生成
```

结论：浏览器侧与 Python 侧的规范化规则确实一致（否则第一步就会被版本校验拦住）。

---

## 7. 完整回归结果

`python scripts/run_tests.py` → **PASS 40 / FAIL 0 / SKIP 0 / BLOCKED 0**

| 分组 | 结果 |
| --- | --- |
| 语法检查（56 个 js/py 文件） | 全 OK |
| Batch 8A 的 38 套 | 全 PASS（`test32` 42/42、`test33` 68/68 未回归） |
| Batch 8B-1 新增 2 套 | `test34` 67/67、`test35` 78/78 |
| 真实 Chromium | `browser` 37/37、`sw-consistency` 35/35、`sw-upgrade` 25/25 |
| Batch 7A 移动端 / SEO | `mobile-notes` 224/224、`course-seo` 45/45 |
| Batch 7B 深链 / 持久 ID | `papers-deeplink` 63/63、`test21` 42/42、`test22` 19/19 |
| 搜索 / RSS / Manifest 一致 | `content-check`、`feed-check`、`split-check`、`test18`、`test19`、`test23` 全 PASS |
| 正式文章数据未被修改 | `git status` 中没有 `data/`、`js/data.js`、`feed.xml` |

对既有测试的唯一改动是 `test33` 的超大文件夹具（阈值常量 1 MiB → 4 MiB），
断言本身保持"超限必须被拒绝"，没有删除任何检查项。

---

## 8. 实际操作步骤

```bash
cd E:\work_funnycode\blog
git checkout main && git pull --ff-only        # 基线 1e050b8
git checkout feature/batch8b1-post-editing

# 1) 打开编辑器，从「打开已有文章」里选一篇（或直接访问 #/editor/<id>）
#    —— id 与链接固定；日期默认保留原值；预览实时且经过 DOMPurify
# 2) 改完后点「📤 导出更新稿」→ 下载 <id>.update.json

# 3) 先预演（不写任何文件）
python scripts/import_post.py --file "%USERPROFILE%\Downloads\<id>.update.json" --mode update --dry-run

# 4) 确认无误后更新（会自动重建搜索索引 / manifest / feed 并跑 --check）
python scripts/import_post.py --file "%USERPROFILE%\Downloads\<id>.update.json" --mode update --apply

# 5) 复核：只应有 1 个被改的 md + 4 个派生文件
git status --short
git --no-pager diff --stat

# 6) 门禁 + 完整回归
python scripts/build_content.py --check
python scripts/run_tests.py

# 7) 提交分支 + 手动开 PR（不推 main、不自动合并）
git checkout -b feature/post-update-<id>
git add data/posts/<id>.md js/data.js data/search-index.json data/posts/manifest.json feed.xml
git commit -m "post: 更新《标题》"
git push -u origin feature/post-update-<id>
#    GitHub 网页手动 Create pull request（base: main）→ 等 content-gate / tests 绿 → 人工合并
```

常见失败与处理：

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 退出码 2 + `原版本校验失败` | 导出后仓库又被改过（或你在同一会话里改完又导出一次） | 刷新编辑器页面重新加载最新版本，再改再导出 |
| 退出码 1 + `请先 ... --sync` | 仓库本身不一致（有手改未重建） | 先 `python scripts/build_content.py --sync`，提交后再导入 |
| 退出码 2 + `文章不存在` | id 打错，或这篇文章只在 `js/user-posts.js` 里 | 检查 id；兼容期文章需先迁移 |
| 退出码 3 + `另一个构建进程正在工作` | 锁被占用 | 等对方结束；确认无进程后删除 `.content-build.lock` |
| 编辑器显示「该文章为只读来源」 | 兼容期文章 | 先迁移到 `data/posts/<id>.md` |
| 导出时提示「内容没有变化」 | 与线上版本完全一致 | 无需导出；要发版就说明确实没改 |

---

## 9. 已知限制

1. **编辑器不知道"导出之后仓库又变了"**：导出稿始终基于打开编辑器时加载的那一版；
   如果先 apply 再在同一会话里重新导出，导入器会以"原版本校验失败"拦住（fail-closed，安全但不便）。
2. **更新稿体积翻倍**：`original.content` 内联全文，因此导入上限从 1 MiB 提到 4 MiB；
   超大文章（>400 K 字符）仍会被拒绝。
3. **`TAG_ORDER` 只增不删**：把某篇文章的最后一个标签删掉后，标签仍留在排序表里（不渲染、无副作用）。
   彻底清理需要另开批次。
4. **只能改五类字段**：标题 / 日期 / 标签 / 摘要 / 正文（+ 可选 `series`），
   **不能改 id、不能删除文章**（删除需手工 + `--sync`，本轮刻意不做）。
5. **兼容期文章只读**：未提供 `user-posts.js` → `data/posts/*.md` 的迁移工具，
   只能手工迁移（每条：写 md、加元数据、跑 `--sync`、删旧条目）。
6. **浏览器缓存参与版本判定**：编辑器通过 HTTP/SW 缓存取正文；若缓存陈旧而仓库已更新，
   导出稿会被导入器拒绝（安全），需要硬刷新（Ctrl+F5）后重来。
7. **跨机器并发**：`.content-build.lock` 只在同一工作副本内有效；两台机器同时改同一篇文章，
   仍要靠 git 冲突解决（导入器无法察觉）。
8. **日期改动会移动文章位置**：文章按日期排序，改日期后首页/归档/RSS 顺序会变（预期行为），
   PR 的 diff 也会更大。

---

## 10. 下一阶段建议

1. **8B-2：安全删除文章** —— 引用检查（搜索/静态页/深链）→ 备份 → 删 md + 元数据 → 重建 → 回滚；
   同样走 `--mode delete`，并复用本轮的"锁 + 快照 + 回滚"骨架。
2. **兼容期文章迁移工具** —— `scripts/migrate_user_posts.py`：把 `js/user-posts.js` 的每条
   拆成 `data/posts/<id>.md` + 元数据，迁移后清空数组；迁移完即可在编辑器里编辑。
3. **编辑器内"变化摘要"** —— 导出前显示"标题/标签/摘要/正文分别改了哪些"，减少人工 diff 成本。
4. **导出即校验** —— 若将来提供本地小服务（或 `file://` 之外的桥接），可在导出时直接把稿子交给导入器，
   免去"下载 → 复制路径"这一步（仍不联网、不自动提交）。
5. **一条命令跑完发布** —— `scripts/publish_post.py`：`import --apply` + `build_content --check` + `run_tests`，
   并在失败时给出下一步提示（仍然不 push、不建 PR）。
6. **更新稿的基线提示** —— 让导入器在 dry-run 里打印"快照基于的版本 = 当前版本"，
   把"为什么被拒绝"解释得更直观（当前已给出字段级差异）。

---

## 附：本轮未做的事（明确边界）

- 未 push、未创建 PR、未合并 main、未部署；
- 未修改任何正式文章内容（`data/posts/*.md`、`js/data.js`、`feed.xml` 全部零改动）；
- 未引入 GitHub Token 或任何远端写入；
- 未改动 `build_content.py` / `split_posts.py` 的生成逻辑（只复用）；
- 未删除 `js/user-posts.js`，也未迁移其中的文章。
