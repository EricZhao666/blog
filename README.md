# Eric's Notebook

纯静态个人技术博客：原生 JS 单页应用（hash 路由）+ 预渲染的课程笔记静态页，部署在 GitHub Pages（`/blog/` 子路径）。无后端、无构建工具链，所有数据都是仓库内的 `.js` 数据文件。

---

## 1. 项目结构

```
blog/
├── index.html                # 唯一入口（SPA）
├── 404.html                  # 子路径深链回退页
├── manifest.json             # PWA 清单
├── sw.js                     # Service Worker（预缓存 + 运行期缓存）
├── robots.txt / sitemap.xml / feed.xml
│
├── css/style.css             # 全站样式（含深色模式）
├── vendor/                   # marked / highlight.js / 代码高亮主题（本地副本，无 CDN）
├── icons/                    # PWA 图标
│
├── js/
│   ├── app.js                # 路由、渲染、搜索、编辑器、草稿、导出（核心逻辑）
│   ├── data.js               # 文章元数据（生成器渲染，勿手改）
│   ├── user-posts.js         # 兼容期旧编辑器文章（JSON 数组，可留空）
│   ├── courses.js            # 课程索引（脚本生成）
│   ├── course-notes.js       # 课程笔记正文（手写维护）
│   ├── note-slugs.js         # 课程 id → 静态页路径（脚本生成）
│   ├── papers.js             # 论文与学习资料（脚本生成）
│   ├── codefiles.js          # 代码库索引（脚本生成）
│   └── projects.js           # 项目卡片（手写维护）
│
├── data/
│   ├── posts/<id>.md         # 文章正文（权威源，按需加载）
│   ├── posts/manifest.json   # 完整性锚点（哈希/字节/字符数，生成）
│   ├── search-index.json     # 全文搜索语料（生成）
│   └── course_descriptions.json  # 课程描述唯一真源（人工撰写，按课程名匹配）
│
├── notes/                    # 预渲染的课程笔记静态页（脚本生成）+ index.html
│
├── tests/                    # 回归测试（见第 5 节）
│   ├── audit.js              # 全站巡检
│   ├── test6.js ~ test11.js  # 前端/编辑器回归
│   ├── test12.py ~ test15.py # 生成器与产物回归
│   └── reports/              # 最近一次测试报告（.gitignore）
│
└── scripts/
    ├── run_tests.py          # 统一测试入口
    ├── build_content.py      # 统一内容构建（元数据/正文/搜索语料/清单/RSS）
    ├── import_post.py        # 编辑器导出的 JSON → data/posts/<id>.md（只新增）
    ├── scan_courses.py       # 课程目录 → js/courses.js
    ├── scan_papers.py        # Zotero + 学习资料 → js/papers.js
    └── add_descriptions.js   # 人工描述 → data/course_descriptions.json
```

根目录另外三个生成器：`scan_codefiles.py`、`gen_feed.py`、`gen_notes_pages.js`（见第 4 节）。

---

## 2. 环境要求

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 18（实测 24.22.1） | 生成器、测试（jsdom） |
| Python | ≥ 3.10（实测 3.12.7） | 生成器、测试入口 |

```bash
npm ci               # 严格按 package-lock.json 安装（推荐；CI 用同一条命令）
# 或：npm install     # 首次开发 / 需要更新锁文件时
```

> 仓库不含 `node_modules/`（已 gitignore）。没装 jsdom 时 `run_tests.py` 会明确报 `BLOCKED`，不会假装通过。

---

## 3. 本地运行

没有任何构建步骤，起一个静态服务器即可（`file://` 打开会导致 Service Worker、相对路径与懒加载失效）：

```bash
# 任选其一
python -m http.server 8000
npx serve .
```

然后访问 `http://localhost:8000/`（子路径部署相关逻辑按 `location.pathname` 自适应，本地根路径也能跑）。

---

## 4. 生成器一览

> 除 `gen_feed.py` 外，生成器都会**覆盖**对应产物文件；失败时会中止而不是写半成品。

| 脚本 | 输入 | 输出 | 需要私人数据 | 命令 |
| --- | --- | --- | --- | --- |
| `scripts/scan_courses.py` | 课程目录（默认本机路径，可 `--roots` 覆盖） | `js/courses.js` | 是（或合成 fixture） | `python scripts/scan_courses.py` |
| `scripts/scan_papers.py` | `zotero.sqlite` + 学习资料目录 | `js/papers.js` | 是（或合成 fixture） | `python scripts/scan_papers.py` |
| `scripts/add_descriptions.js` | `js/courses.js` 的课程名 + 脚本内置文案 | `data/course_descriptions.json` | 否 | `node scripts/add_descriptions.js` |
| `scan_codefiles.py` | 本机代码目录（可 `--roots`） | `js/codefiles.js` | 是（或合成 fixture） | `python scan_codefiles.py` |
| `gen_feed.py` | `js/data.js` + `js/user-posts.js` | `feed.xml` | 否 | `python gen_feed.py` |
| `gen_notes_pages.js` | `js/course-notes.js` + `js/courses.js` | `notes/*.html`、`notes/index.html`、`js/note-slugs.js`、`sitemap.xml` | 否 | `node gen_notes_pages.js` |

### 4.1 课程索引

```bash
# 用默认私人目录（不存在会自动跳过）
python scripts/scan_courses.py

# 指定扫描根与输出（测试/换机）
python scripts/scan_courses.py --roots roots.json --out /tmp/courses.js \
       --descriptions data/course_descriptions.json
# roots.json: [{"path": "D:/课程", "drive": "D"}, {"path": "E:/杂项/学习", "drive": "E"}]
```

- `drive` 只影响分类规则（`D` = 港大/设计课程，`E` = 本科课程）。
- 人工 `description` 从 `data/course_descriptions.json` 按**课程名**回填，重扫不会丢；未匹配到的会打印 `WARN`。
- **一门课都没扫到时会中止**（退出码 1），不覆盖已有 `js/courses.js`。

### 4.2 论文与学习资料

```bash
python scripts/scan_papers.py \
  --zotero-db "D:/zotero/zotero.sqlite" \
  --zotero-storage "D:/zotero/storage" \
  --learn-dir "E:/杂项/个人资料/学习" \
  --out js/papers.js
```

- Zotero 里 `date` 字段常见的重复串（`2023-05-29 2023-5-29`）与 `00` 占位（`2024-00-00`）会被规范化为 `2023-05-29` / `2024`。
- 数据库不存在直接中止（不会新建空库）；解析到 0 篇论文也会中止。

### 4.3 代码库索引

```bash
python scan_codefiles.py                       # 默认 js/codefiles.js
python scan_codefiles.py --out /tmp/cf.js --roots roots.json
# roots.json: [{"path": "E:/codeplace", "id": "codeplace", "category": "综合代码仓库"}]
```

重新扫描会按 `id` **保留人工 `description` 与 `guide`**；既有产物无法解析时中止，不会清空文案。

### 4.4 RSS

```bash
python gen_feed.py                                  # 写 feed.xml
python gen_feed.py --out /tmp/feed.xml --now 2026-10-23T00:00:00Z   # 可重复生成
```

`gen_feed.py` 用结构化 JS 字面量扫描解析 `data.js`（不 eval、不逐行正则），正文里的 `id:`、`},`、代码块、模板字符串不会污染元数据；`user-posts.js` 走「括号配对 + 严格 JSON」。任何读不懂的情况都会中止且**不覆盖**已有 `feed.xml`。

### 4.5 笔记静态页

```bash
node gen_notes_pages.js
```

会在 `notes/*.html` 的 JSON-LD 里写入日期（`dateModified`）与 `sitemap.xml` 的 `lastmod`，默认取当天，**跨天重跑会产生 diff**；需要可重复构建时固定时间并指到临时目录：

```bash
node gen_notes_pages.js --now 2026-10-22 --out-dir /tmp/notes-out
```

`--now` 必须是合法的 `YYYY-MM-DD`（非法值直接失败）。产物均为「先写 `.tmp` 再改名」的原子写入，中途失败不会写坏已发布文件。

---

## 5. 测试

### 5.1 统一入口（推荐）

```bash
python scripts/run_tests.py
```

依次执行：环境检查（node/python/jsdom）→ 语法检查（`js/**`、根目录 `.js`、`scripts/*.py|js`、`tests/*`）→ 全部用例 → 汇总。

```bash
python scripts/run_tests.py --only test12 test13     # 只跑指定用例
python scripts/run_tests.py --skip-syntax            # 跳过语法检查
python scripts/run_tests.py --report /tmp/r.md --json /tmp/r.json
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 全部通过 |
| 1 | 有测试失败（含语法错误） |
| 2 | 环境阻塞（缺 node / 缺 jsdom 等），不能算通过 |

报告默认写到 `tests/reports/last-run.md`（已 gitignore），包含每个用例的结果、项数、耗时与失败原因。

### 5.2 用例清单

| 用例 | 覆盖 |
| --- | --- |
| `audit.js` | 路由渲染、站内死链、重复 id、静态页与 404 资源一致性 |
| `test6.js` | 课程区：笔记视图、分类切换、搜索 |
| `test7.js` | 全文搜索、主题切换、静态笔记页、SW 策略、RSS |
| `test8.js` | B8A：编辑器不再收集/存储 Token，旧 Token 可一键清除 |
| `test9.js` | 路由冷加载、搜索重绘覆盖路由、搜索框重绑、懒加载失败态（`BLOCK=js/courses.js` 另跑一次） |
| `test10.js` | B8A：导出不联网、不写历史文章，失败保留草稿 |
| `test11.js` | 草稿自动保存竞态（Fake Timers，9 组场景） |
| `test24_publish_queue.js` | B8A：旧发布队列入口下线（零网络/零队列/零 Token） |
| `test32_editor_export.js` | B8A：导出契约（UTF-8/代码块/特殊字符/空正文/重复 ID/文件名） |
| `test33_import_post.py` | B8A：本地导入器（冲突/恶意路径/非法 JSON/中断回滚/RSS 与搜索索引） |
| `test34_post_update.py` | B8B1：更新已有文章（原版本校验/锁/回滚/id 不变/其他文章不变） |
| `test35_editor_update.js` | B8B1：编辑器编辑模式（回填/固定 id/更新稿/草稿隔离/前进后退/深链不变） |
| `test36_editor_toolbar.js` | B8B2：工具栏插入/快捷键/焦点与选区/原生撤销/状态栏 |
| `test37_editor_images.js` | B8B2：图片协议白名单/本地文件校验/仅预览提示/XSS 净化 |
| `test38_draft_history.js` | B8B3：草稿历史（快照/去重/5 分钟节流/隔离/配额/损坏/安全恢复） |
| `browser/editor-history.spec.js` | B8B3：真实 IndexedDB 历史、恢复前备份、刷新持久、多标签页、SW 升级 |
| `browser/editor-ux.spec.js` | B8B2：真实 Chromium 下的工具栏、原生 Undo、375/390/768/1280 布局、SW 升级 |
| `test12.py` | `scan_codefiles.py` 描述保护（合成 fixture） |
| `test13.py` | `gen_feed.py` 解析、失败策略、路径（合成 fixture） |
| `test14.js` | 排序一致性 + 日期时区（Asia/Shanghai、America/New_York、Europe/London） |
| `test15.py` | 生成器可复现性（合成 fixture：课程 / 论文 / 描述） |
| `browser/sw.spec.js` | **真实 Chromium**：SW 安装容错、离线导航、版本更新、预取去重、缓存淘汰（14 项） |

单独运行：

```bash
node tests/audit.js
python tests/test13.py
```

> `test9.js` 的懒加载失败分支需要环境变量：`BLOCK=js/courses.js node tests/test9.js`。

### 5.3 真实浏览器测试（Playwright + Chromium）

```bash
npm i -D playwright@1.64.1 && npx playwright install chromium   # 首次
node tests/browser/sw.spec.js            # 本地默认用系统 Chrome（channel: chrome）
PW_CHANNEL=chromium node tests/browser/sw.spec.js   # 用 Playwright 自带 Chromium（CI 同款）
```

覆盖：安装容错（必需/可选资源）、在线刷新取新版、离线首页与已缓存笔记、**未缓存笔记返回 503 离线页而不是首页**、在线 404 原样返回、预取去重、运行期缓存上限 120 与 FIFO 淘汰。失败截图落在 `tests/browser/artifacts/`（已 gitignore）。

### 5.4 用 Fixtures 验证扫描器（不碰私人目录）

`test15.py` 会自建临时目录与一个合成 `zotero.sqlite`，覆盖：分类规则、人工描述保留、重复生成字节一致、0 结果不覆盖产物、缺库中止。直接跑：

```bash
python tests/test15.py
```

---

## 6. 更新 Service Worker 版本

`js/app.js`、`css/style.css`、`index.html` 等都在 `sw.js` 的预缓存清单里。**改动这些文件后必须递增版本**，否则老访客会继续用旧缓存：

```js
// sw.js
const CACHE_VERSION = '2026-10-23-3';   // 改成新日期-序号
```

`activate` 会删除所有不等于当前版本的 `blog-*` 缓存。`test14.js` 的 `S1` 会校验版本号不低于 `2026-10-23-3`（随每次发布上调即可）。

**缓存策略要点（B4 后）**

| 行为 | 说明 |
| --- | --- |
| 安装 | `index.html`/`css`/`app.js`/`data.js` 为**必需**，任一失败则 install 失败 → 浏览器继续用旧 SW；图标/manifest/vendor 为**可选**，失败只降级 |
| `skipWaiting()` + `clients.claim()` | 新 SW 装好即刻接管，已打开页面会在下一次请求切到新版本；因为资源 URL 不带哈希，极端情况下老页面可能加载到新 JS。这是现有取巧点，若要完全避免需改为「提示用户刷新」（未在本轮实施） |
| 缓存查找 | 先查运行期缓存（较新），再查安装期缓存，避免 CORE 里的旧副本长期命中 |
| 离线导航 | 首页回退 `index.html`；**未缓存的其它页面返回 503 离线提示页**，不会拿首页冒充 |
| 预取 | `activate` 与首次导航触发，已缓存则跳过；全部用 `waitUntil` 跟踪，SW 回收不会半途而废 |
| 运行期上限 | 120 条，串行写入 + FIFO 淘汰，只删自己 `blog-rt-*` 缓存里的条目 |

---

## 7. 提交与发布

写文章走「编辑器导出 → 本地导入 → 手动 PR」（Batch 8A 起，不再有自动队列/自动 PR）：

```bash
# 1) 网页编辑器（#/editor）写完 → 点「📤 导出文章」得到 <id>.json
# 2) 本地校验并导入（只新增，不覆盖历史正文）
python scripts/import_post.py --file <id>.json --dry-run
python scripts/import_post.py --file <id>.json --apply
# 3) 重建派生数据并自检
python scripts/build_content.py --check
python scripts/run_tests.py
# 4) 手动提交 + 手动开 PR
git checkout -b feature/post-<id>
git add data/posts/<id>.md js/data.js data/search-index.json data/posts/manifest.json feed.xml
git commit -m "post: <标题>"
git push -u origin feature/post-<id>
```

改已有文章走「编辑器打开 → 导出更新稿 → 本地更新 → 手动 PR」（Batch 8B-1）：

```bash
# 1) 编辑器里用「打开已有文章」下拉选择（或直接访问 #/editor/<id>）
#    id 固定、文章链接不变；改完点「📤 导出更新稿」得到 <id>.update.json
# 2) 本地校验并更新（会核对原版本，过期稿件直接拒绝）
python scripts/import_post.py --file <id>.update.json --mode update --dry-run
python scripts/import_post.py --file <id>.update.json --mode update --apply
# 3) 同上：--check → 完整测试 → 手动提交 PR
```

> 更新稿里带 `original` 原版本快照（原文全文 + 原元数据）；导入器把它与仓库当前内容逐字段比对，
> 不一致就拒绝（退出码 2），不会把旧版本覆盖到别人的新改动上。

**编辑器用法（Batch 8B-2）**

- 工具栏：H1–H3、加粗、斜体、行内代码、代码块（可选语言）、有序/无序列表、引用、链接、图片、表格、分割线；再点一次取消简单格式。
- 快捷键：`Ctrl/Cmd+B` 加粗、`Ctrl/Cmd+I` 斜体、`Ctrl/Cmd+K` 链接、`Tab` / `Shift+Tab` 缩进与反缩进；`Ctrl/Cmd+Z` 与撤销/重做**交给浏览器原生行为**（不接管）。
- 图片：链接只接受 `https://` 或站内相对路径；本地图片只做**类型/大小校验 + 本地缩略图**，插入的是仓库内路径（默认 `images/`），
  **不会**写 base64、不上传、不需要 Token —— 原图需要你自己放进仓库并与文章一起提交。
- 移动端（≤768px）：编辑与预览用开关切换，只切 CSS 不重建 DOM；工具栏可横向滚动。
- 状态栏显示字数、英文词数、预计阅读时间、模式/文章 id 与**本地草稿**保存状态（"已保存"仅指本地草稿）。
- 历史版本（Batch 8B-3）：手点「🗂️ 保存历史版本」立即存一份；编辑过程中每约 5 分钟自动存一份（内容没变不重复存）。
  每篇文章最多保留 10 份（优先清理最旧的自动版本，手动版本优先保留），恢复前会**先给当前内容存一份安全快照**，
  快照失败就不恢复。历史只存在本机 IndexedDB，**不是云端备份**，清除站点数据会一并丢失。

合并到 `main` 后 GitHub Pages 自动构建（约 30 秒 ~ 2 分钟）。

发布后可按下面方式自检（注意加 cache-buster，边缘缓存会有延迟）：

- `https://ericzhao666.github.io/blog/sw.js?cb=1` → `CACHE_VERSION` 是否为新版本
- `https://ericzhao666.github.io/blog/feed.xml?cb=1` → `lastBuildDate` 与条目数

---

### 7.1 持续集成（GitHub Actions）

`.github/workflows/tests.yml`：`push` / `pull_request` / 手动触发，`ubuntu-latest` + Node 22 + Python 3.12，`npm ci` 装依赖后跑 `python scripts/run_tests.py`，报告作为 Artifact 上传，失败即 job 失败。权限仅 `contents: read`，不需要任何 Secrets。

> **Action 运行时**：三个工作流统一使用 Node.js 24 运行时的 Action 版本 ——
> `actions/checkout@v5`、`actions/setup-node@v5`、`actions/setup-python@v6`、`actions/upload-artifact@v6`
> （v4/v5 系列仍声明 `node20`，会触发 `Node.js 20 is deprecated` 警告）。
> 注意区分：**Action 自身的运行时**是 Node 24，**被测项目**仍在 Node 22 + Python 3.12 上运行。

> **注意**：CI 只是“事后检查”，不能阻止直接推 `main` 触发 Pages 发布。若要真正拦截，需要：
> 1. 仓库 Settings → Branches 给 `main` 加保护：Require a pull request before merging + Require status checks to pass（勾选 `tests`）；
> 2. 日常改动走 `feature/*` 分支 → PR → 绿了再合并；
> 3. 如仍要允许直推，可加一条 pre-push hook 或本地 `python scripts/run_tests.py` 习惯。
>
> 这些属于仓库设置，代码侧不做改动。

## 8. 会覆盖产物的脚本

| 脚本 | 覆盖的文件 | 失败时 |
| --- | --- | --- |
| `scripts/scan_courses.py` | `js/courses.js` | 0 门课时中止，不写 |
| `scripts/scan_papers.py` | `js/papers.js` | 缺库 / 0 篇时中止，不写 |
| `scan_codefiles.py` | `js/codefiles.js` | 既有产物不可解析时中止，不写 |
| `gen_feed.py` | `feed.xml` | 先构建后原子替换，异常不写 |
| `scripts/build_content.py --sync` | `js/data.js`、`data/search-index.json`、`data/posts/manifest.json`、`feed.xml` | 全量校验后才写，异常不写 |
| `scripts/import_post.py --apply` | 上述 4 个派生文件 + 新增 `data/posts/<id>.md` | 冲突即拒绝；失败自动回滚 |
| `gen_notes_pages.js` | `notes/*.html`、`notes/index.html`、`js/note-slugs.js`、`sitemap.xml` | 直接覆盖（无守卫） |
| `scripts/add_descriptions.js` | `data/course_descriptions.json` | 直接覆盖 |

> `gen_notes_pages.js` 与 `add_descriptions.js` 没有“失败不覆盖”保护：前者是纯静态渲染（输入不对会直接报错），后者是常量表。改动前建议先提交或备份。

---

## 9. 安全恢复历史版本

- **单文件回滚**：`git log --oneline -- <file>` 找到改动提交，`git revert <sha>` 或 `git checkout <sha> -- <file>`。
- **整站回滚**：`git revert <sha1> <sha2> ...` 后重新 push；不要用 `git reset --hard` + 强推覆盖远端历史。
- **本地快照**：本项目在关键批次前保留过整站备份目录（含 `.git`），可直接覆盖回滚。

---

## 10. 私人数据说明

仓库**只包含**站点本身与生成器代码，不含：

- Zotero 数据库与附件目录、个人学习资料目录；
- 课程资料原始目录、本机代码仓库目录；
- 任何 GitHub Token（Batch 8A 起编辑器根本不接触 Token，见 10.1）；
- 测试用的真实扫描结果（测试一律使用合成 fixture）。

`scan_courses.py` / `scan_papers.py` / `scan_codefiles.py` 里的绝对路径只是**本机默认值**，目录不存在会自动跳过；换机器请用 `--roots` / `--zotero-db` / `--learn-dir` 指定，测试则完全走合成 fixture。

### 10.1 编辑器不再接触 Token（Batch 8A）

- 编辑器只做「导出文章」：不调用 GitHub API，也没有 Token 输入框；导出物是本地 JSON，不发往任何服务器。
- 8A 之前保存过 Token 的老用户：编辑器「⚙️ 设置 → 🧹 清除旧版 GitHub Token」可一次性删掉 `gh_token` / `gh_owner` / `gh_repo`（代码只允许删除，不再读取或写入）。
- 发布改由本地 `scripts/import_post.py` 完成：只接受 JSON，新增不覆盖历史正文、更新要过原版本校验，失败自动回滚。
- Batch 8B-1 起编辑器可以打开**已有文章**改标题/标签/摘要/正文，但 id 与链接固定，且只导出「更新稿」，仍然不写仓库。
- **兼容期文章（`js/user-posts.js`）在编辑器里是只读的**：正文内联在 JSON 数组里、导入器不写该文件，所以不提供在线编辑；要用编辑器改，先把它们迁移到 `data/posts/<id>.md`。
- **这不等于 XSS 防护**：Markdown 输出统一过 DOMPurify、动态内容不拼内联事件，仍然是为「别让不可信内容变成脚本」。

---

## 11. 已知限制

- `gen_notes_pages.js` 默认时间仍是“当天”，跨天重跑会产生 diff；需要可重复构建时用 `--now` + `--out-dir`（见 4.5）。
- 未在真实 Linux 上本地跑过完整套件：CI 首次运行结果才是 Linux 环境的最终验证（见 7.1）。
- 生成器的**真实端到端扫描**需要本机存在私人源目录，仓库内只保证合成 fixture 可跑（`test15.py`）。
- 测试基于 jsdom，不覆盖真实浏览器的 Service Worker 生命周期与跨域行为。
- `tests/` 与 `scripts/` 之外，根目录仍保留 `scan_codefiles.py`、`gen_feed.py`、`gen_notes_pages.js`（保持既有调用路径不变）。
