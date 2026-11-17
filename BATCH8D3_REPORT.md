# Batch 8D-3：博客全站 UI 2.0 与响应式视觉升级

- 分支：`feature/batch8d3-ui-refresh`
- 基线：`main@30848a78f183efc97c86caba6adcc927484866db`
- 范围：视觉与交互样式（`css/style.css` 为主，`index.html` 未改，`js/app.js` 仅做结构/可访问性所需的局部改动）
- 约束：未改路由、稳定 ID、文章/课程/论文/项目数据、搜索评分、导入/构建/图片检查脚本、IndexedDB、Actions 发布方式；未 push / PR / 合并 / 部署

---

## 1. 结论

全站视觉统一为简洁克制的技术博客风格：中性灰底 + 白/深灰卡片 + 单一蓝色强调色，深浅双主题完整，五档视口无横向溢出，桌面导航不再塌陷，关于页卡片恢复，代码库导读块恢复可读性。新增 `tests/browser/ui-refresh.spec.js`（59 项真实 Chromium 断言）并注册进 `scripts/run_tests.py`。完整回归结果见第 8 节。

---

## 2. 阶段一：实测到的原有视觉问题

以下均来自真实 Chromium 截图与 DOM 探针（`tests/browser/artifacts/b8d3/before/`），不是假设：

| # | 问题 | 证据 |
|---|------|------|
| 1 | 桌面导航在 1280/1440 下塌陷，导航文字逐字竖排（"首/页""课/程"） | before `01-home-1440-light.png`；9 个 `.nav-link` + logo + 主题按钮在 760px 容器内放不下 |
| 2 | 首页没有页面标题层级，直接从卡片开始 | `renderHome` 只返回 `.article-list`，无 `h1`、无篇数 |
| 3 | `.about-page` 整条规则被 CSS 解析器丢弃，关于页没有卡片底板 | 文件里一行落单的 `*/` 使后续选择器无效；计算样式 `background: transparent`、`padding-top: 0` |
| 4 | `main` 的上下内边距从未生效，内容紧贴 64px 头部 | 元素选择器 `main` 被类选择器 `.container` 覆盖，`#app` 计算 `padding-top: 0px` |
| 5 | 代码库导读块浅色模式"浅底浅字"不可读 | `.code-lib-guide pre` 背景 `#f1f3f5` + 文字 `#e6e6e6`，对比度约 1.1:1 |
| 6 | 论文类型徽标直接外露英文枚举 | 页面显示 `preprint / conferencePaper / journalArticle` |
| 7 | 论文页 PDF 链接 3.95:1、类型徽标 3.32:1，低于 AA 4.5 | 改造前对比度实测 |
| 8 | 标签页标题被标签云压在下面 | `renderTags` 先输出 `.tags-cloud` 再输出标题 |
| 9 | 七彩噪音：文件类型 10 种彩色底、论文类型 6 种彩色底、课程"笔记"实心亮蓝、PDF 链接红色 | before 截图 |
| 10 | `.load-more-btn:hover` 使用遗留紫色 `#5849bb` | CSS 中的 `--color-primary-dark` fallback |
| 11 | 深色模式 `img { opacity: .92 }` 把技术配图整体压暗 | 计算样式与截图 |
| 12 | 卡片 hover 用 `border-color: transparent` + 位移，深色下阴影不可见 → hover 丢边界 | CSS 规则 |
| 13 | 480px 下 header 额外 12px 内边距，logo 与正文不对齐 | `.header-inner { padding: 0 12px }` 叠加容器 16px |
| 14 | 论文卡片、标签筛选后的文章卡片没有 `tabindex`，键盘不可达 | DOM 探针 |
| 15 | 逐卡入场动画（`opacity:0` + nth-child 延迟）有首屏不可见风险 | CSS 规则 |
| 16 | `formatDate` 输出"2026年八月10日"（中文月名 + 阿拉伯日） | 被 `tests/test14.js` 显式锁定，本轮不动（见已知限制） |

---

## 3. 设计规范（令牌层）

在 `:root` **原地重写**现有变量名，不建立第二套主题系统；深色 `[data-theme="dark"]` 原地改值。

- 背景 / 表面：`--color-bg #f6f7f9`、`--color-bg-soft #f0f2f5`、`--color-surface #fff`；深色 `#0f1115 / #16181d / #1a1d23`
- 文字：`--color-text #16181d`、`--color-text-secondary #4a5261`、`--color-text-muted #626b7a`（深色 muted `#8b94a4`）
- 边框：`--color-border #e2e6ec`、`--color-border-strong #c9d0da`
- 强调色：`--color-primary #2563eb`、`--color-primary-light #e7efff`、`--color-primary-dark #1d4ed8`、`--color-accent #0f766e`
- 语义色：success / warning / danger 及 soft 变体；`--color-focus`
- 阴影：`--shadow-xs / sm / md`（深色单独一套）
- 圆角：`--radius-xs 6px`、`--radius-sm 8px`、`--radius 10px`、`--radius-lg 16px`、`--radius-pill`
- 尺度：`--container-max 1040px`、`--measure-wide 880px`、`--max-width 760px`、`--header-height 64px`
- 字号：`--text-xs..--text-xl`；过渡 `--transition .18s ease`

排版规则：列表页 `.page-title` 1.75rem/700/-0.02em；卡片标题 1.22rem/600；正文 1rem/1.85；次要信息 0.75–0.85rem muted；所有长标题与长技术词允许 `overflow-wrap`。

交互规则：hover 只改边框/底色/文字色，不做位移；active 用浅底 + 强调边框（移动端亦然）；focus-visible 统一 2px 强调色 outline；`prefers-reduced-motion` 下压缩过渡与滚动动画。

---

## 4. 各页面优化内容

- **顶部导航**：sticky + 1px hairline；`.nav-link` 7px/11px 内边距、nowrap、当前页 2px 下划线（不再填充色块）；769–1024 紧凑档；≤768 固定下拉面板（translateY + opacity 过渡、`max-height: calc(100dvh - 64px)` 内部滚动、48px 触控高度、Esc 关闭并归还焦点）。
- **首页**：新增 `home-head`（`h1 文章` + 站点描述 + `共 N 篇 · 更新至 YYYY-MM`）；≥900px 两列网格，单卡行宽舒适；摘要两行截断；日期/阅读时间/标签统一为 0.78rem 行内 meta；标签改 ghost 小圆角；去掉逐卡入场动画。
- **搜索入口**：44px 高输入框、surface 底、shadow-xs，focus 用 16% 强调色光环；搜索页筛选 chip 统一 34–40px、active 浅底强调；窄屏按内容宽度换行，避免落单项被拉满整行。
- **文章详情 / Markdown**：760px 阅读列、40/44 内边距、12px 圆角；标题 1.8rem/700/1.32、正文 1.85 行高；blockquote 改浅底 + 3px 强调左边；代码块浅底 + 边框 + 0.84rem/1.7；表头浅底；返回链接与卡片左缘对齐。
- **课程页**：统计条由三张浮卡改为一条分格条（1px 分隔、tabular-nums）；筛选 chip 统一 34px、active 浅底强调；课程网格 `minmax(300px,1fr)`；"有笔记"徽标改浅底小 chip；`course-card-muted` 不再降透明度，改虚线边框 + 次要标题色；移动端 3 项统计三等分（避免半格空位）。
- **论文与学习资料**：tab 改胶囊分段控件；卡片 16/20 内边距、8px 圆角、hover 只改边框/阴影；类型徽标中文化 + 5px 语义色圆点；PDF 链接改 ghost chip；摘要展开可滚动；论文卡片支持 Enter/Space 展开并同步 `aria-expanded`。
- **项目页**：统一卡片 20/22、图标 34×34 中性底托、状态 chip 用 success/warning soft 底、highlights 前缀改 `–`、技术标签 ghost、年份加 hairline 上分割线。
- **归档 / 标签 / 关于**：归档年份 0.9rem/600 + tabular、条目 9/6 padding + hairline；标签页顺序改为"标题 → 标签云 → 列表"，标签项 34px 圆角 chip；关于页修复被丢弃的 `.about-page` 规则（760px 卡片、40/44 padding、头像 76px 中性底）。
- **代码页 / 文件列表**：10 种彩色文件徽标合并为中性徽标；文件名允许换行（`white-space: normal; overflow-wrap: anywhere`）；代码库导读 `pre` 改浅底 + 正文色 + 边框（对比度由 ~1.1:1 提升到正文级）；`.load-more-btn:hover` 去掉紫色 fallback。
- **编辑器 / 静态笔记页**：编辑器保持左右分栏与移动端布局契约；静态课程笔记页继续共享 `css/style.css`，用 `:has(.course-notes-summary)` 精确修正分组标题与列表间距，不影响文章页"相关阅读"块。
- **响应式**：375 / 390 / 768 / 1024 / 1440 全部无全页横向溢出；未新增全局 `overflow-x: hidden`；480px 以下收紧卡片/详情内边距、统计与筛选控件保留 ≥38px 触控高度。
- **深色模式**：锁定测试依赖的 `#16181d / #0f1115 / #1a1d23` 三个精确值；卡片边框、输入框、按钮在深色下均有清晰边界；移除 `img{opacity:.92}`；深色行内 code 改回正文色。

---

## 5. 修改文件

| 文件 | 变更 |
|------|------|
| `css/style.css` | 826 insertions / 452 deletions（令牌层、头部导航、搜索、首页、正文/Markdown、课程、论文、项目、归档、标签、关于、代码、编辑器、响应式、深色、动效；含 `main.container` 优先级修复与 `.about-page` 注释修复） |
| `js/app.js` | 53 insertions / 18 deletions：`renderHome` 标题区；`PAPER_TYPE_LABELS`/`paperTypeLabel`；`togglePaperCard` + 论文卡片键盘支持；`renderTags` 结构重排 + 标签筛选卡片键盘可达；课程页"有笔记/全部课程" chip 的 `role/tabindex/aria-pressed` 与 Enter/Space |
| `sw.js` | `CACHE_VERSION` `2026-11-16-3` → `2026-11-17-1` |
| `scripts/run_tests.py` | 注册 `ui-refresh` 套件（+2 行） |
| `tests/browser/ui-refresh.spec.js` | 新增，779 行 / 59 项断言 |
| `tests/browser/image-lightbox.spec.js` | 1 行：R4 的 CACHE_VERSION 精确断言随本次发布从 `2026-11-16-3` 同步为 `2026-11-17-1`（仍为精确相等断言，未放宽） |
| `BATCH8D3_REPORT.md` | 本报告 |

未改：`scripts/import_post.py`、`scripts/build_content.py`、`scripts/check_images.py`、搜索评分、导出契约、IndexedDB、路由与稳定 ID、Actions、`data/posts/*.md`、`js/papers.js`/`js/courses.js`/`js/projects.js` 等数据文件、`notes/*.html`。

---

## 6. 改造前后截图索引

截图均由真实 Chromium 采集，输出在 `tests/browser/artifacts/b8d3/`（该目录被 `.gitignore` 忽略，仅本地留存，不进入提交）。

- `before/`：基线 `30848a78` 的 32 张页面截图 + 6 个附加场景（搜索、移动菜单、键盘焦点、静态笔记、代码页、关于页等）
- `after/`：同一套路由 × 视口 × 主题的改造后截图（最后一轮修复后重新采集）
- `compare/`：并排对照图（左 BEFORE / 右 AFTER）
  - `compare/home-desktop-light.png` 桌面首页 · 浅色 1440
  - `compare/home-mobile-light.png` 手机首页 · 浅色 390
  - `compare/courses-desktop-light.png` 课程页 · 浅色 1440
  - `compare/papers-desktop-light.png` 论文与学习资料 · 浅色 1440
  - `compare/home-desktop-dark.png` 桌面首页 · 深色 1440
  - `compare/post-desktop-light.png` 文章详情 · 浅色 1440

单页文件命名：`NN-page-WIDTH-theme.png`（如 `01-home-1440-light.png`、`04-papers-390-dark.png`）。

---

## 7. 新增测试：`tests/browser/ui-refresh.spec.js`

真实 Chromium（Playwright 1.64.1），59 项，全部 PASS。覆盖：

1. 主要页面渲染与标题层级：首页/文章/课程/论文/项目/归档/标签/关于/代码/编辑器（含课程统计条、论文中文类型徽标、关于页卡片底板）。
2. 导航：1440 单行不换行、1024 紧凑档、当前页下划线指示；390 汉堡菜单开合、48px 触控项、Esc 关闭与焦点归还。
3. 双主题：浅/深底色契约、卡片边界、正文/次要文字/论文徽标/PDF 链接对比度 ≥ 4.5、深色输入框边界。
4. 五档视口（375/390/768/1024/1440）× 四个主页面：无横向溢出，且 html/body 未用 `overflow-x: hidden` 掩盖。
5. 长标题、长标签、长技术词在卡片/正文页换行且不越界（含合成文章 fixture）。
6. 键盘：导航与筛选 chip 焦点可见、论文卡片 Enter 展开并同步 aria、文章卡片 Enter 进入详情。
7. 阅读目录点击真实滚动、图片灯箱打开/锁定滚动/Esc 关闭（合成文章 fixture）。
8. 搜索命中、筛选激活态、375 无溢出。
9. 编辑器 1440 双栏、390 无溢出。
10. 静态课程笔记页深色主题、移动菜单、1440 导航单行、无溢出。
11. SW 缓存版本已递增且 `css/style.css` 在必需资源中；设计令牌为单一主题系统。
12. `prefers-reduced-motion` 下过渡压缩、滚动即时。
13. 全流程无新增 Console Error / PageError。

---

## 8. 完整回归结果

命令：`python scripts/run_tests.py`（58 套 = 原有 57 套 + 新增 `ui-refresh`）

环境：Python 3.13.18 / Node 22.23.2 / Playwright 1.64.1（浏览器通道 `chrome`）。

结果：**PASS 58 / FAIL 0 / SKIP 0 / BLOCKED 0**，结论 `PASS`。

关键套件：

| 套件 | 结果 |
|------|------|
| 全部 57 套原有测试 | 全部 PASS |
| `ui-refresh`（新增） | 59/59 PASS |
| `browser`（SW 安装/离线/更新/容量） | 37/37 PASS |
| `sw-consistency`（版本一致性/慢网/离线/HTTP 错误/SW 重启） | 37/37 PASS |
| `sw-upgrade`（旧版→新版/回退/多标签页/混部） | 25/25 PASS |
| `mobile-notes`（静态笔记移动端/键盘/断点/深色/无溢出） | 224/224 PASS |
| `papers-deeplink`（深链身份/焦点/滚动/历史/视口） | 63/63 PASS |
| `reading-experience`（目录/进度/复制/移动端） | 47/47 PASS |
| `image-lightbox`（图片放大/焦点/滚动锁定） | 34/34 PASS |
| `editor-ux` / `editor-history` | 66/66 / 39/39 PASS |
| `search-ux` / `search-interaction` | 30/30 / 56/56 PASS |
| `content-check` / `feed-check` / `image-check` | 全部 OK（正式文章数据零修改、图片资源齐全、RSS 一致） |

说明：首轮完整回归曾有 1 项失败——`image-lightbox` 的 `R4` 把 CACHE_VERSION 精确锁定在 `2026-11-16-3`。本轮按发布要求把 `sw.js` 递增到 `2026-11-17-1` 后，该断言同步更新为新的精确版本值（仍为相等断言，未放宽），复跑该套 34/34，随后完整回归 58/58 全绿。工作区仅有 5 个受控修改文件 + 2 个新增文件，`data/posts/*.md` 与 `notes/*.html` 零改动；截图/日志位于被 `.gitignore` 忽略的 `tests/browser/artifacts/`。

---

## 9. 已知限制

1. **日期格式**：`formatDate` 仍输出"2026年八月10日"（中文月名 + 阿拉伯日）。`tests/test14.js` 第 85–91 行把它作为站点既有格式显式锁定，按"不弱化原有断言"要求未改；如需统一为"2026-08-10"需同步调整该断言并由用户授权。
2. **Emoji 单色化**：本机无头 Chromium 不含彩色 emoji 字体，📚/📄/🧠/🤖 等渲染为黑色单色字形（截图可见）。属运行环境字体差异，未删除数据中的 emoji。
3. **关于页无独立 H1**：沿用原页面语义，以头像 + 姓名作为页首；未额外添加"关于"标题，避免与 760px 名片卡片形成双重标题。
4. **论文标题为英文原文**：标题来自真实论文数据，只做了类型徽标中文化；未翻译论文标题。
5. **合成文章 fixture**：正式文章数据均无图片，灯箱/目录用例通过 `USER_POSTS.push(...)` 注入合成文章（与既有 `image-lightbox.spec.js` 同一方式），不修改正式数据。
6. **截图目录不入库**：`tests/browser/artifacts/` 被 `.gitignore` 忽略；截图与对照图仅存在于本地工作区，报告中按路径索引。
7. **静态笔记页共享样式**：`notes/*.html` 由 `gen_notes_pages.js` 生成，本轮未改生成器，仅用 `:has(.course-notes-summary)` 在共享 CSS 中限定修正其分组间距。

---

## 10. 上下文管理情况

- 全程使用关键词定位 + 分段读取：未整读 `js/app.js`（6.2k 行）或 `css/style.css`（4.1k 行）；用 `Grep` 定位选择器/函数后按行号读取。
- 变更检查用 `git diff --stat` 与局部 diff；回归只保留每套的 `共 N 项，PASS/FAIL` 汇总行，未反复载入完整浏览器日志。
- 阶段检查点：阶段一（审查+基线取证）→ 阶段二（令牌+首页+导航）→ 阶段三（课程/论文/项目/标签/归档/关于）→ 阶段四（响应式/深色/宽屏对齐）→ 阶段五（新增测试）→ 阶段六（截图对照）→ 阶段七（完整回归）→ 阶段八（报告+本地 commit）。
- 未因上下文压力删除测试、跳过验证或重写整个文件；所有 CSS 改动为原地重写对应区块。
