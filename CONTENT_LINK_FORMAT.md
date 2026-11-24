# CONTENT_LINK_FORMAT.md — 内容引用语法契约（Batch 9B-2）

本文件是 WikiLink 与站内引用抽取的**唯一语法契约**。构建期索引（`scripts/content_links.py`）
与浏览器渲染（`js/content-links.js` + marked 扩展）实现同一契约，并由共享测试样例
`tests/fixtures/wikilink-contract.json`（32 例）锁定两侧行为一致。

## 1. WikiLink v1

### 1.1 语法

```
[[post:<id>]]
[[post:<id>|<显示文本>]]
```

- `<id>` 必须匹配 `^[a-z0-9][a-z0-9-]*$`（与文章稳定 id 契约完全一致）。
- 显示文本可选，1–200 字符，不得包含 `[`、`]`、`|` 与换行；两侧空白会被裁剪。
- 显示文本缺省时渲染目标文章标题；目标不存在时渲染 id 原文并标注未解析。

### 1.2 为什么首版只支持 post

部分课程 id 本身含竖线（如 `本科课程|机器人与自动化-(CS422)`）。若把「第一个竖线」
一律当作显示文本分隔符，课程目标会被无歧义地截断成错误 id。post id 契约不含竖线，
因此 `[[post:...]]` 的第一个竖线**无歧义**。其他类型（course/paper/material/lib/project/note）
的 `[[...]]` 在 v1 保留原文，并记录 `unsupported-type` 诊断。

未来扩展路径（本轮不实现）：为含竖线 id 的类型引入显式分隔符（如 `[[course::<id>::<显示文本>]]`
或 URL 编码 id），必须先修订本契约与共享 fixture，再同步两侧实现。

### 1.3 渲染语义

| 情形 | 渲染结果 |
|---|---|
| 合法语法 + 目标存在 | `<a href="#/post/<encodeURIComponent(id)>" class="wikilink" data-wikilink="post:<id>">显示文本或标题</a>` |
| 合法语法 + 目标不存在 | `<span class="wikilink-unresolved" data-wikilink-unresolved="post:<id>" title="引用目标不存在：…">显示文本或 id</span>`，**不产生链接、不跳转、不自动创建文章** |
| 非法语法 / 不支持类型 | 保留原文（marked 不识别为扩展 token），构建期记录诊断 |

目标解析只允许**公开权威数据**：构建索引节点优先，回退内置 `POSTS`。
不读取个人收藏（IndexedDB）、浏览历史或 `USER_POSTS`，保证渲染与构建索引同一口径。

### 1.4 保护语义（两侧一致）

以下上下文中的 `[[...]]` **不解析**：

1. 围栏代码块（``` 或 ~~~，行首 ≤3 空格；闭合围栏须同字符且不少于 opening 长度）；
2. 行内代码（反引号串按相同长度闭合）；
3. 反斜杠转义（`\[\[` 等，CommonMark 可转义标点）；
4. HTML 标签内部（`<a title="[[post:x]]">`）；
5. Markdown 链接目标 `](...)` 内部（链接文本内的 WikiLink 照常解析，与 marked 内联递归一致）。

marked 自身在 token 化阶段天然保证 1–3（扩展只在普通文本位置被调用）；
`scanText()` / Python 镜像用等长遮罩实现同一语义，供构建索引与测试使用。

### 1.5 安全

- 显示文本、目标标题一律 `escapeHtml` 后输出；不产生任意 HTML。
- 链接 href 只可能是 `#/post/<编码 id>`；不存在 `javascript:` 等协议通道。
- 输出继续经过现有 `DOMPurify.sanitize(SANITIZE_CONFIG)` 契约，不新增白名单。
- 不动态执行正文字符串；不修改普通 Markdown 链接语义。

## 2. 站内 Markdown 引用抽取

与 `js/related.js extractLinks` 同构：识别 `#/post/`、`#/course/`、`#/codelib/`、`#/project/`
四类路由与 `#/papers?kind=paper|material&target=…` 查询；id 经 `decodeURIComponent`；
另识别 `href="…"` 形式。按目标 key 去重。

**与 9B-1 运行时算法的唯一差异**：构建索引额外施加 §1.4 保护（代码围栏里的示例链接
不构成真实引用）。`Related.extractLinks` 本身保持原样，推荐算法不改。

## 3. 构建期索引 `data/content-links.json`

由 `scripts/build_content.py` 的 `build_artifacts` 生成（`scripts/content_links.py` 实现），
自动纳入 `diff_artifacts / write_artifacts / --check / --dry-run / --sync` 与完整性门禁。

```jsonc
{
  "schemaVersion": 1,
  "generator": "scripts/content_links.py",
  "nodes": [ { "key", "type", "refId", "title", "href", "tags?", "category?", "series?", "text?", "example?" } ],
  "explicit": [ { "source", "target", "via": "markdown" | "wikilink" } ],
  "series":   [ { "a", "b", "series" } ],
  "bySource": { "<key>": ["<targetKey>", …] },
  "byTarget": { "<key>": ["<sourceKey>", …] },
  "diagnostics": [ { "source", "raw", "reason": "unresolved-target" | "invalid-wikilink" | "unsupported-type" } ],
  "stats": { "nodes", "explicitEdges", "seriesEdges", "unresolved", "invalidWikilinks", "isolated", "isolatedKeys", "byType" }
}
```

契约要点：

- **权威源**：`js/data.js`、`data/posts/*.md`、`js/user-posts.js`（legacy 公开内容）、
  `js/courses.js`、`js/course-notes.js`、`js/papers.js`、`js/codefiles.js`、`js/projects.js`、
  `js/note-slugs.js`。不读取测试注入、个人收藏或浏览历史。
- **确定性**：`json.dumps(sort_keys=True, ensure_ascii=False, separators=(',',':'))` + LF，
  无时间戳；相同输入字节级一致（两次无变化构建已验证）。
- **节点**：复用 `type:refId` 稳定键，不改任何现有 id；note 节点仅当 `NOTE_PAGES`
  提供真实 slug 与真实静态页跳转时纳入；示例项目保留 `example: true`。
- **边**：显式引用有向；自环排除；重复引用按 (source,target,via) 去重；真实循环引用保留。
  同系列边来自真实 `series` 字段（无向，码元序），不等同于正文引用。
- **临界区**：`build_artifacts` 本身无锁；`--sync` 与 `import_post` 的写入路径在
  `BuildLock` 完整临界区内调用它（8E-3 生命周期契约不变，无嵌套锁）。
  `--check/--dry-run` 保持只读无锁。逐文件原子替换，不宣称多文件事务。

## 4. 验收方式

本轮**不批量改写正式文章**。新增关系的验收使用隔离 fixture：

- `tests/test59_content_links.js`：临时 root + `import_post --apply` 导入两篇互相引用的
  夹具文章，验证 WikiLink 边、去重、自环、循环、诊断、`--check`、BuildLock 并发。
- `tests/browser/graph-experience.spec.js`：HTTP 层 override 注入夹具正文/索引，
  仓库正式文件零改动。
## 5. 与发布体系的关系（9B-2R 修订）

`data/content-links.json` 是**完整派生产物**之一：与 `js/data.js`、`data/search-index.json`、
`data/posts/manifest.json`、`feed.xml` 同级。它的清单只在一处定义
（`scripts/build_content.py::DERIVED_ARTIFACTS`），导入备份/回滚、发布候选快照与过期检测、
CI 候选哈希留档都复用它。因此"索引过期"和"data.js 过期"在发布闸门里是同一等级的失败：
候选只篡改索引也必须被拒绝，不允许自动重建后宣称可部署。