# Batch 8B-3 交付报告：Markdown 编辑器草稿历史与安全恢复

- 基线：`main@0f727be2b77f135bbc0838f733aeb5c1db23659f`
- 分支：`feature/batch8b3-draft-history`
- 结论：**本地完成，专项 + 全量回归全绿**（未 push、未建 PR、未合并、未部署）
- 改动范围：`js/app.js`（新增 `DraftHistory` 模块 + 编辑器面板）、`css/style.css`、`sw.js` 版本号、
  测试与文档；**未改**文章数据契约、`scripts/import_post.py`、`scripts/build_content.py`、工作流、部署配置

---

## 1. 历史版本存储结构

### 1.1 分工：草稿仍在 localStorage，历史另存 IndexedDB

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 当前草稿 | `localStorage`：`blog_draft` / `blog_draft_edit::<id>` | **完全沿用** 8A/8B-1/8B-2 的行为，一个字没改 |
| 历史快照 | `IndexedDB`：`blog-draft-history`（DB v1）/ store `snapshots` | 每条一个对象，`id` 为主键，`byScope` 索引 |
| 历史不可用时 | 进程内内存数组 | 只在当前标签页可见，UI 明确提示"已降级" |

`_draftState`、`writeDraft()`、`flushDraft()`、`scheduleDraftSave()` 全部保留原语义：
历史模块只是在 `writeDraft()` 成功之后**追加一次**非阻塞调用，失败不影响草稿。

### 1.2 记录结构与隔离键

```js
{
  id: 'edit:embodied-ai-notes|1700000000000|ab12c',   // 主键：scopeKey|时间戳|随机
  scopeKey: 'edit:embodied-ai-notes',                 // 隔离键（见下）
  scope: 'edit' | 'new',
  postId: 'embodied-ai-notes' | '',
  kind: 'manual' | 'auto' | 'restore-backup',
  savedAt: 1700000000000, savedAtISO: '2023-11-14T22:13:20.000Z',
  title, date, tags: [...], excerpt, content,         // 六个白名单字段
  chars: 1234,                                        // 正文非空白字符数
  hash: 'k3j9x2',                                     // 内容指纹（去重）
  tabId: 'ab12cd'                                     // 写入它的标签页
}
```

隔离规则：

| 场景 | scopeKey | 结果 |
| --- | --- | --- |
| 新增文章 | `new` | 与所有编辑模式文章隔离 |
| 编辑文章 X | `edit:<X>` | 与新增模式、与其它 id 都隔离 |

`configure()` 切换 scope 时会清空内存镜像、重置"已加载"标记与自动节流时间，
因此**不同文章之间不可能互相覆盖**（test38 H5 用三个 scope 交叉验证）。

只写白名单字段：`pickState()` 显式挑 `title/date/tags/excerpt/content`，
**Token、密码、任何草稿以外的状态都不会进历史**（test38 H1 断言键集合）。

---

## 2. 自动快照机制

```
输入 → scheduleDraftSave()（2 秒防抖，原有逻辑不变）
     → writeDraft()（写 localStorage，原有逻辑不变）
     → DraftHistory.maybeAuto(payload)   ← 新增，非阻塞、异常吞掉
           ├─ 未加载过？先 loadScope()（只重入一次，用 scopeLoaded 标记防死循环）
           ├─ lastAutoAt 存在且 now - lastAutoAt < 5 分钟 → 直接跳过（throttled）
           ├─ 内容指纹与已有快照相同 → 跳过（duplicate）
           └─ 否则写入一条 kind='auto'
```

- **不新增任何周期定时器**：判定发生在已有的草稿保存触发点上（`writeDraft`），
  因此 test11 的"只有一个待触发定时器"契约不受影响。
- 5 分钟窗口由"该 scope 最新一条 auto 的 `savedAt`"推导，跨刷新依然有效（从 IndexedDB 读回来）。
- 手动保存（`saveHistoryVersion()`）**不受节流限制**，立即写入 `kind='manual'`。
- 空白/不完整状态不入库：`content` 与 `title` 都为空时直接返回
  `{ok:false, error:'空白内容不保存为历史版本'}`。
- 首次自动快照会立即产生一条（作为基线），之后按 5 分钟节流。

---

## 3. 恢复前备份机制（本轮最关键）

```
用户：预览 → 点「恢复该版本」→ 二次确认 → 点「确认恢复」
   ↓
confirmRestoreHistory()
   ├─ 1) DraftHistory.snapshot('restore-backup', 当前 DOM 内容)
   │       失败（空间不足 / 写入异常）→ 提示"已取消恢复"，**一个字都不改**
   └─ 2) 成功后才 applyHistoryRecord(rec)
           ├─ 覆盖 title / tags / excerpt / content（编辑模式还有 date）
           ├─ updateEditorPreview() + updateEditorStats()（预览与状态栏同步）
           ├─ flushDraft(true)  ← 更新现有草稿存储
           └─ 状态栏："已恢复历史版本 …… 这只是编辑器内容，尚未导出、尚未发布"
```

- **不改变编辑模式与文章 ID**：`_editorMode`、`_editCtx` 全程不动；
- **8B-1 的原文章快照不受影响**：`_editCtx.content` 仍是仓库里的原文，
  恢复后再导出更新稿，`original` 依旧是原版本，冲突校验照常（test38 H15、editor-history B4）；
- 恢复前后都不会写仓库、不发请求，也不改变"已发布"的语义。

---

## 4. 新旧版本隔离

| 维度 | 处理 |
| --- | --- |
| 当前草稿 vs 历史 | 两套存储（localStorage / IndexedDB），互不写入 |
| 新增模式 vs 编辑模式 | `scopeKey = 'new'` vs `'edit:<id>'` |
| 不同文章 | `scopeKey` 含文章 id，列表查询按 scopeKey 过滤 |
| 历史 vs 导出契约 | 导出只读 DOM 与 `_editCtx`，历史记录不参与任何导出字段 |
| 损坏记录 | 缺字段/类型不对的记录在读取时被单独丢弃，不影响同 scope 的正常记录 |

---

## 5. 异常与回滚策略

| 异常 | 表现 | 处理 |
| --- | --- | --- |
| IndexedDB 不可用（隐私模式 / 老浏览器） | `init()` 返回 `backend:'memory'`、`degraded:true` | 面板顶部提示"已降级"，草稿与导出不受影响 |
| 存储空间不足（QuotaExceededError） | `snapshot()` 返回 `{ok:false, error:'浏览器存储空间不足…'}` | 手动保存时红字提示；**不静默清除当前草稿**；恢复流程因此中止 |
| 写入中断 / 事务失败 | 同上传入错误信息 | 只影响这一次快照，内存镜像不变 |
| 读历史失败 | `list()` 回退到内存镜像 | 面板可能显示"上次已知"的列表，草稿照常 |
| 历史记录损坏 | 过滤掉坏记录，其它版本仍可见 | test38 H9 用 3 条坏记录 + 1 条好记录验证 |
| 配额超限 | 插入后裁剪：先删**最旧的 auto**，再删最旧的 `restore-backup`，最后才动 `manual` | 每篇上限 10 条；手动版本优先保留（test38 H6） |
| 多标签页同时编辑 | `storage` 事件只做提示，不自动同步/覆盖 | 提示"另一个标签页刚保存了同一份草稿"（test38 H16 / B8） |
| 历史模块任何未预期异常 | `writeDraft` 外层 `try/catch` + Promise 全部 resolve | 草稿写入成功即返回，历史失败静默 |

> 面板与文档都明确写了：**浏览器本地历史不是永久备份**，清除站点数据会一并丢失。

---

## 6. 界面与交互

- 编辑器操作区新增两个按钮：「🗂️ 保存历史版本」与「🕘 历史版本 N」（N 为当前条数徽标）。
- 面板（`#editorHistoryPanel`）包含：
  - 顶部说明 + 降级/多标签页提示位；
  - 「保存当前为历史版本」「刷新」「清理该文章历史」；
  - 列表项：保存时间、类型徽标（手动 / 自动 / 恢复前备份）、标题、字数、内容摘要（前 80 字）、预览/删除按钮；
  - 预览区：diff 摘要 + 安全渲染的正文 + 「恢复该版本」+ 行内二次确认。
- 预览渲染仍走 `renderMarkdown()`（marked → **DOMPurify**）；历史正文里的 `<script>`、`onerror`
  在预览中都被剥离（test38 H12 实测注入无效果）。
- 移动端（≤768px）：面板全宽、列表限高滚动、按钮 ≥40px 触控高度；375 宽实测无横向溢出。
- 所有渲染文本都过 `escapeHtml()`，列表项用 `data-hist` 属性委托，不拼内联事件。

---

## 7. 轻量历史对比

`DraftHistory.diff(旧记录, 当前状态)` 返回：

| 字段 | 含义 |
| --- | --- |
| `charsOld` / `charsNew` | 旧/新正文的非空白字符数 |
| `addedLines` / `removedLines` | **粗粒度行变化**：按行做多重集差分（忽略空白行），不做 LCS |
| `summary` | 一行摘要，例：`字数 9 → 9（+0）；行 +2 / −2；标题已改` |

刻意不引入 diff 库：几十行的多重集差分足够回答"改了多少"，完整逐行 diff 留到下一阶段。

---

## 8. 新增测试与结果

| 文件 | 类型 | 项数 | 覆盖 |
| --- | --- | --- | --- |
| `tests/test38_draft_history.js` | jsdom | 59 | 快照字段白名单、去重、5 分钟节流、手动不受限、新增/编辑/不同 id 隔离、配额裁剪（手动优先）、删除/清理、diff、损坏记录隔离、空间不足、IDB 降级、面板保存与安全预览、恢复前备份、恢复中断不覆盖、编辑模式快照不变、多标签页提示、草稿与导出契约不回归 |
| `tests/browser/editor-history.spec.js` | Chromium | 39 | **真实 IndexedDB** 写入与持久化、去重提示、自动节流（显式时间戳）、二次确认恢复 + 备份记录、刷新后历史与草稿都在、删除/清理、375 移动端可用与无溢出、双标签页提示、SW 新版本缓存清理、工具栏/原生撤销/导出契约回归 |

两者均已注册进 `scripts/run_tests.py`（`test38` / `editor-history`），`package.json` 的 `test:js` 同步加入。

---

## 9. 全量测试结果

`python scripts/run_tests.py` → **PASS 45 / FAIL 0 / SKIP 0 / BLOCKED 0**
（原 43 套 + `test38` + `editor-history`）

| 分组 | 结果 |
| --- | --- |
| 原有 43 套 | 全 PASS（未删除/放宽任何断言） |
| 新增 | `test38` 59/59、`editor-history` 39/39 |
| 真实 Chromium | `browser` 37/37、`sw-consistency` 35/35、`sw-upgrade` 25/25、`editor-ux` 66/66、`editor-history` 39/39 |
| 移动端 / SEO / 深链 | `mobile-notes` 224/224、`course-seo` 45/45、`papers-deeplink` 63/63 |
| 内容与导入器 | `content-check`、`feed-check`、`split-check`、`test18/19/23`、`test33` 68/68、`test34` 67/67 全 PASS |
| 文章数据 | `git status` 无 `data/`、`js/data.js`、`feed.xml` 变化 |

`sw.js` 的 `CACHE_VERSION` 从 `2026-11-13-1` 升到 `2026-11-13-2`；
`editor-history` 在真实浏览器里确认只保留 `blog-2026-11-13-2` / `blog-rt-2026-11-13-2`，旧缓存已清理。

---

## 10. 已知限制

1. **不是备份**：历史存于浏览器 IndexedDB，清站点数据/换设备/换浏览器都会丢失；面板内已明示。
2. **降级模式下不可跨刷新**：IndexedDB 不可用时退化为内存，刷新即丢（草稿仍在 localStorage）。
3. **行变化是粗粒度**：多重集差分，不体现在同位置的改动；复杂逐行 diff 留待下一阶段。
4. **配额策略是"每篇 10 条"**，不按字节计算；单条正文很大时（如几百 KB）可能先撞到浏览器配额，
   此时提示"存储空间不足"，不会静默删当前草稿。
5. **自动快照只在"有编辑并触发草稿保存"时判定**：长时间只打开不输入不会产生新快照。
6. **多标签页不做同步**：只提示，避免两个标签页互相覆盖；如需同步请先导出。
7. **恢复只作用于编辑器 DOM 与本地草稿**，不会写仓库、不会改已发布文章；
   要真正更新线上内容仍需导出更新稿 + 本地导入 + 手动 PR。
8. **历史预览的代码高亮不额外加载**：预览只做 marked + DOMPurify，不触发 highlight.js 懒加载。

---

## 11. 测试效率说明（Token / 时间）

- 只读编辑器相关代码（`writeDraft`/`flushDraft`/`renderEditor` 段）、`sw.js` 版本行与既有编辑器测试，
  没有全仓扫描。
- 先用 11 套定点用例（约 2 分钟）确认无回归，最后只跑一次全量。
- `DraftHistory` 的纯逻辑（指纹、配额、diff、白名单）都在 jsdom 里用**注入后端 + 显式时间戳**验证，
  不需要等待真实的 5 分钟，也不需要起浏览器。
- 真实 IndexedDB 只在 `editor-history` 一个浏览器用例里跑（39 项），避免重复劳动。

---

## 12. 后续建议

1. **历史加密/可选导出**：把某条历史导出成 `.md` 与文章一起提交，绕开"浏览器清数据即丢失"。
2. **按字节配额**：除条数上限外，再加总量上限（如 2 MB/篇），并在面板显示占用。
3. **完整逐行 diff**：引入 20 行级的 LCS（自写，不引库），高亮改动行。
4. **多标签页软同步**：广播"正在编辑"心跳，冲突时提示"另一标签页有更新，是否载入"。
5. **导入器联动**：`import_post.py` 可选读取历史目录（导出文件），把"恢复过的版本"也纳入可追溯记录。

---

## 附：本轮未做的事

- 未改文章数据契约、导出/更新稿 JSON、`scripts/import_post.py`、`scripts/build_content.py`；
- 未改 GitHub Actions、Pages 部署、自动 PR/发布策略；
- 未新增任何 npm 依赖、未引入第三方数据库或云服务；
- 未修改任何正式文章内容。
