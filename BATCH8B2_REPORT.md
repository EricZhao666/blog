# Batch 8B-2 交付报告：Markdown 编辑器 2.0

- 基线：`main@04a6aef802e6603a308329b76871fcc2a69c0b6a`
- 分支：`feature/batch8b2-editor-ux`
- 结论：**本地完成，专项 + 全量回归全绿**（未 push、未建 PR、未合并、未部署）
- 改动范围：仅前端编辑体验（`js/app.js`、`css/style.css`、`sw.js` 版本号）+ 测试 + 文档；
  **未改** `scripts/import_post.py`、`scripts/build_content.py`、文章元数据格式、工作流、部署配置

---

## 1. 工具栏实现说明

### 1.1 分层

```
按钮 / 快捷键（DOM 层）
    ↓ 只传 action 名
runMarkdownAction(action, textarea)
    ↓ 纯函数：text + 选区 → {start, end, replacement, selStart, selEnd}
MDEditor  （无 DOM 依赖，可单测）
    ↓
applyMarkdownEdit(textarea, edit)   ← 唯一写回点（execCommand 优先）
```

`MDEditor` 暴露在 `window.MDEditor`，纯函数签名统一为 `(text, start, end, …)`：

| 能力 | 函数 | 说明 |
| --- | --- | --- |
| 行内包裹 | `toggleInline / bold / italic / inlineCode` | 选区两侧已有标记 → 取消；选区自带标记 → 剥离；否则包裹 |
| 标题 | `setHeading(level)` | 先剥掉已有 `#{1,6} ` 再按目标级别加；同级再点 = 取消 |
| 列表 | `toggleUnorderedList / toggleOrderedList` | 逐行处理，有序列表按行编号 |
| 引用 | `toggleQuote` | 逐行 `> `，可取消 |
| 代码块 | `codeBlock(lang)` | 围栏独立成行；支持语言标记；可取消（含"选区在围栏内部"的情况） |
| 链接 / 图片 | `link / image` | 链接目标含 `()` 时用 `<…>` 包裹；alt 过滤 `[]` 与换行 |
| 表格 / 分割线 | `table / hr` | 不在行首时自动补换行，保证独立成块 |
| 缩进 | `indent(outdent)` | Tab = 2 空格；多行选区整体缩进/反缩进 |

工具栏有 14 个按钮 + 1 个代码块语言下拉（`#editorCodeLang`：无 / python / javascript / bash / json /
html / css / sql / yaml / text）。按钮是 `type="button"`，通过 `data-md="<action>"` 由一个委托监听统一处理，
不写 14 份重复逻辑，也不引入任何编辑器框架。

### 1.2 选中、占位、焦点

- **有选区**：包裹/替换选区，操作后选区仍落在原文字上（`**hello**` 里选中 `hello`）。
- **无选区**：插入占位文本并**选中占位内容**（`加粗文字` / `斜体文字` / `代码` / `链接文字` / `列 1`），
  用户可以直接打字覆盖，或再点一次按钮取消。
- **焦点**：工具栏在 `mousedown` 时 `preventDefault()`，按钮不会抢走 textarea 焦点与选区；
  操作后主动 `focus()` + 恢复选区。
- 所有插入都只是 **Markdown 文本**，不拼 HTML；预览依旧走 `renderMarkdown()` + DOMPurify。

---

## 2. 快捷键和光标管理

| 快捷键 | 行为 | 备注 |
| --- | --- | --- |
| `Ctrl/Cmd + B` | 加粗 | `preventDefault()` |
| `Ctrl/Cmd + I` | 斜体 | 同上 |
| `Ctrl/Cmd + K` | 链接 | 选区作文本 → 选中 URL 段；无选区 → 插入占位并选中文本 |
| `Tab` | 缩进 2 空格（多行整体缩进） | 不移动焦点 |
| `Shift + Tab` | 取消一级缩进 | 行首不足 2 空格时按剩余数量剥 |
| `Ctrl/Cmd + Z` | **不拦截** | 交还浏览器原生撤销 |
| `Ctrl/Cmd + Shift + Z` | **不拦截** | 交还浏览器原生重做 |

设计要点：

- 监听**只绑定在 `#editorContent`** 上（`setupEditorShortcuts`），标题/标签/摘要等输入框完全不参与；
- `e.isComposing === true` 或 `keyCode === 229`（输入法组合中）时**直接返回**，不打断候选词上屏；
- 带 `Alt` 的组合键一律不处理（避免吞掉 AltGr 等系统级输入）；
- **不自己实现历史栈**：`applyMarkdownEdit` 优先调用
  `document.execCommand('insertText', false, replacement)`，这是唯一能同时保住
  "原生 Undo/Redo" 和 "原生 input 事件" 的写入方式；只有环境不支持时才退化为
  `setRangeText` + 手动派发 `input`（jsdom 走这条路径）。
- 真实 Chromium 已验证：工具栏加粗后 `Ctrl+Z` 能撤销、`Ctrl+Shift+Z` 能重做（`editor-ux` E1）。

---

## 3. 图片引用与本地资源处理

### 3.1 现状调查（先看约定，再定路径）

仓库里**没有**文章图片目录：只有 `icons/`（PWA 图标，被 `manifest.json` / `index.html` 引用），
`data/posts/*.md` 中也没有任何 `![` 引用，`notes/` 是静态页。因此本轮**不新造复杂结构**，采用
最小约定：仓库根目录 `images/`（与 `icons/` 同级），Markdown 里写相对路径 `images/<file>`。
SPA 的文档地址是 `/blog/index.html`，相对路径会解析成 `/blog/images/<file>`，与 GitHub Pages 子路径一致。

### 3.2 方式 A：图片链接

- 白名单：`https://…` 绝对地址，或站内相对路径（`images/x.png`、`/images/x.png`）；
- 拒绝：`http://`（混合内容）、`javascript:`、`data:`、`blob:`、`file:`、`vbscript:`、协议相对地址 `//…`、
  含空格/尖括号/反引号/反斜杠、含 `..`（跳出站点根）、含控制字符；
- 目标含 `()` 时用 `![alt](<images/a(1).png>)` 包裹，避免 Markdown 提前闭合；
- 校验失败**不写入正文**，面板上用 `#editorImageError` 明确报错；
- 预览仍是 `marked → DOMPurify`，`javascript:` 之类在渲染层再挡一次（双层防御）。

### 3.3 方式 B：本地图片

| 步骤 | 行为 |
| --- | --- |
| 类型校验 | 只允许 PNG / JPEG / WebP / GIF（MIME 优先，扩展名兜底） |
| 大小校验 | ≤ 2 MB，空文件拒绝 |
| 本地预览 | `URL.createObjectURL` 生成缩略图，关闭面板时 `revokeObjectURL` |
| 安全文件名 | `images/<slug>-<hash6>.<ext>`：slug 只保留 `[a-z0-9-]`（≤40 字符），hash6 由 `(文件名, 大小, 修改时间)` 做 FNV-1a，同名不同图不会互相覆盖 |
| 插入内容 | 只写 `![描述](images/xxx.png)` 这一个路径引用 |
| 明确告知 | 面板常驻黄色警告 + 插入后状态栏写「**仅本地预览，图片尚未加入仓库**，请把原图放到 `images/…` 并与文章一起提交」 |

**硬性约束（已用测试守住）**：

- 绝不把图片转成 base64 写进正文或文章 JSON（test37 I6 断言 `base64` 不出现）；
- 绝不写入 `blob:` / `file:` / 本机绝对路径；
- 不发起任何上传请求、不需要 GitHub Token（test24 仍然断言编辑器零网络写入）；
- 不会假装"已可发布"：状态栏不含"已发布/已上线/可以发布"字样。

---

## 4. 桌面端和移动端交互

| 断点 | 布局 | 行为 |
| --- | --- | --- |
| > 768px（1280 实测） | 双栏（编辑 + 预览）同屏 | 视图切换器 `display:none`；工具栏换行排列 |
| ≤ 768px（768 / 390 / 375 实测） | 单栏 + 「✏️ 编辑 / 👁 预览」开关 | 只切 `#editorSplit[data-view]` 的 CSS，**DOM 不重建**，内容与选区不丢 |
| ≤ 420px | 同上 | 工具栏按钮 44×44，触控区域加大 |

移动端细节：

- 工具栏 `flex-wrap: nowrap; overflow-x: auto` → 横向滚动，不挤压换行；
- 正文 `max-height: 55vh` 且自身滚动，**不使用 fixed 定位**，键盘弹出时不会遮住保存/导出按钮；
- 预览内 `pre` / `table` 各自 `overflow-x:auto`，长代码块与宽表格只在局部滚动，不撑破页面；
- 375 / 390 / 768 / 1280 四个视口实测 `scrollWidth - innerWidth <= 1`（无横向溢出）。

状态栏（`#editorStats`）：字数（非空白字符）、英文词数、预计阅读时间（复用 `readingTime()`）、
模式（新增/编辑）、编辑模式下的文章 id、以及**本地草稿**状态。
草稿状态直接复用 8A/8B-1 的保存流程（`writeDraft` 成功后回调更新文案），**没有第二套状态机**；
文案始终以「本地草稿：」开头，不会让人误以为已发布。

---

## 5. 新增测试

| 文件 | 类型 | 项数 | 覆盖 |
| --- | --- | --- | --- |
| `tests/test36_editor_toolbar.js` | jsdom | 87 | 工具栏渲染、加粗/斜体/行内代码的包裹与取消、占位选中、H1–H3、有序/无序列表、引用、代码块（语言/多行/取消）、表格、分割线、链接、中英混排、焦点与选区、input 联动、快捷键、原生撤销不拦截、输入法、其它输入框不受影响、execCommand 优先、状态栏 |
| `tests/test37_editor_images.js` | jsdom | 66 | URL 白名单（https/相对/危险协议/空格/`..`）、`<>` 包裹、alt 清理、本地文件类型与大小、建议路径安全性与唯一性、只写路径不写 base64/blob/file、仅预览与需提交的提示、XSS 净化、面板开关与 tab、编辑模式快照不变、视图切换不丢内容、导出契约不变 |
| `tests/browser/editor-ux.spec.js` | Chromium | 66 | 桌面工具栏 + **原生 Ctrl+Z / Ctrl+Shift+Z**、快捷键、Tab、图片面板、四个视口布局与无溢出、移动切换不丢内容、工具栏横滚与触控尺寸、路由切换恢复草稿、SW 新版本缓存清理、无 console error |

三者均已注册进 `scripts/run_tests.py`（`test36` / `test37` / `editor-ux`），`package.json` 的 `test:js` 也同步加入。

关键断言举例：

- 原生撤销：`点击加粗 → Ctrl+Z → 值回到 hello world`（真实浏览器，jsdom 无法模拟）；
- 输入法：`isComposing: true` / `keyCode: 229` 时按 `Ctrl+B` 不产生任何写入；
- 卡片式：`Tab` 在正文里插入 2 空格且焦点不跳走；标题框里 `Ctrl+B` 不被拦截；
- 图片：`javascript:alert(1)` 既不进正文也不进预览。

---

## 6. 全量测试结果

`python scripts/run_tests.py` → **PASS 43 / FAIL 0 / SKIP 0 / BLOCKED 0**

| 分组 | 结果 |
| --- | --- |
| 语法检查 | 全 OK（含新增 3 个测试文件） |
| 原有 40 套 | 全 PASS（未删除/放宽任何断言） |
| B8B2 新增 | `test36` 87/87、`test37` 66/66、`editor-ux` 66/66 |
| 真实 Chromium | `browser` 37/37、`sw-consistency` 35/35、`sw-upgrade` 25/25、`editor-ux` 66/66 |
| 移动端 / SEO / 深链 | `mobile-notes` 224/224、`course-seo` 45/45、`papers-deeplink` 63/63 |
| 搜索 / RSS / Manifest | `content-check`、`feed-check`、`split-check`、`test18/19/23` 全 PASS |
| 导入器 | `test33` 68/68、`test34` 67/67（Python 侧零改动） |
| 文章数据 | `git status` 无 `data/`、`js/data.js`、`feed.xml` 变化 |

`sw.js` 的 `CACHE_VERSION` 从 `2026-11-06-1` 升到 `2026-11-13-1`；
`editor-ux` 在真实浏览器里验证：只保留 `blog-2026-11-13-1` / `blog-rt-2026-11-13-1`，
旧版本缓存名不再出现（SW 的 `activate` 清理逻辑生效）。

---

## 7. 已知限制

1. **`images/` 是新引入的约定**：仓库此前没有文章图片。目录需要用户自己创建，图片需要自己 commit；
   本轮不提供自动上传/自动复制。
2. **本地图片只做客户端校验**（MIME/扩展名/大小），不解析图片内容，也不做压缩/改尺寸/生成多分辨率。
3. **图片探测未做**：编辑器不会去 HEAD 检查该路径是否已在仓库里，因此统一提示"尚未加入仓库"（保守但诚实）。
4. **表格固定 3×3 骨架**，不支持列对齐语法（`|:---:|`）与自定义列数。
5. **代码块语言是固定下拉**（10 项），其它语言需要手写围栏标记。
6. **Undo 依赖浏览器原生栈**：`execCommand` 被禁用的环境会退化成 `setRangeText`，
   撤销粒度可能变成"整段替换"；已在测试里覆盖退化路径（手动派发 input）。
7. **移动端键盘遮挡**通过"不用 fixed + 内部滚动"规避，未接入 `VisualViewport` API；
   极端小屏（< 320px）未专门适配。
8. **状态栏同步计算**：每次 input 做一次字符串扫描（比同事件里的 marked 渲染便宜），
   刻意不引入新定时器，以免破坏现有"只有一个草稿防抖定时器"的契约（test11 依赖它）。
9. 预览里的图片仍受 SW 运行时缓存策略影响（最多 120 条），大图过多时会被 FIFO 淘汰。

---

## 8. Token / 测试效率方面的改进

- **先定点、后全量**：先跑 12 套相关用例（约 2 分钟）确认无回归，最后只跑一次全量（约 7 分钟）。
- **纯函数优先**：工具栏/快捷键的核心逻辑抽成 `MDEditor` 纯函数，大部分断言不启浏览器、
  甚至不启页面即可覆盖（`validateImageUrl`、`suggestImagePath`、`stats` 等）。
- **浏览器用例只跑必要的组合**：4 个视口 × 3 个页面级别，共 66 项，而不是像 mobile-notes 那样
  铺开到 224 项；桌面端点一次工具栏 + 一次原生撤销即可证明关键路径。
- **不做全仓扫描**：只读取 `js/app.js` 编辑器段、`css/style.css` 编辑器段、`sw.js` 版本行，
  以及 3 个历史测试的断言方式，避免无谓的上下文开销。
- **没有引入新依赖**：不装富文本库、不装 markdown 编辑框架，`npm` 依赖未变。
- **不新增中间报告**：除本文件外不产生额外文档。

---

## 9. 下一阶段建议

1. **8B-3：图片资源入库闭环** —— 导入器可选支持 `--images <dir>`：校验 JSON 里引用的图片是否存在、
   可选复制到 `images/`，缺图时明确报错（仍然不联网、不上传）。这样"文章 + 图片"可以一次提交。
2. **删除文章**（8B-1 遗留的 update 反面）：引用检查 → 备份 → 删除 → 重建 → 回滚。
3. **编辑器内变化摘要**：导出前展示"标题/标签/摘要/正文各改了哪些"，减少人工 diff。
4. **表格增强**：列数选择 + 对齐语法；代码块语言支持自定义输入。
5. **移动端增强**：接入 `VisualViewport` 处理键盘遮挡，工具栏支持"常用/更多"折叠。
6. **状态栏增强**：显示"距上次导出"的时间戳（仅本地，不上传）。

---

## 附：本轮未做的事

- 未改 Python 导入器与统一构建器；未改文章元数据格式与导出/更新稿 JSON 契约；
- 未改 GitHub Actions、Pages 部署、自动 PR/发布策略；
- 未引入富文本编辑器或新框架，未新增任何 npm 依赖；
- 未自动上传图片、未使用任何 Token、未对仓库发起写请求。
