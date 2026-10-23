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
│   ├── app.js                # 路由、渲染、搜索、编辑器、草稿、发布（核心逻辑）
│   ├── data.js               # 文章数据（手写维护）
│   ├── user-posts.js         # 网页编辑器发布的文章（JSON 数组）
│   ├── courses.js            # 课程索引（脚本生成）
│   ├── course-notes.js       # 课程笔记正文（手写维护）
│   ├── note-slugs.js         # 课程 id → 静态页路径（脚本生成）
│   ├── papers.js             # 论文与学习资料（脚本生成）
│   ├── codefiles.js          # 代码库索引（脚本生成）
│   └── projects.js           # 项目卡片（手写维护）
│
├── data/
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
npm install          # 只装 devDependency: jsdom（跑测试用）
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

会在 `notes/*.html` 的 JSON-LD 里写入当天日期（`dateModified`）与 `sitemap.xml` 的 `lastmod`，因此**跨天重跑一定会产生 diff**，属预期行为。

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
| `test8.js` | 编辑器 GitHub Token 存储策略（sessionStorage / 记住我 / 清除） |
| `test9.js` | 路由冷加载、搜索重绘覆盖路由、搜索框重绑、懒加载失败态（`BLOCK=js/courses.js` 另跑一次） |
| `test10.js` | 发布数据完整性（模拟 Contents API 的 10 种异常分支） |
| `test11.js` | 草稿自动保存竞态（Fake Timers，9 组场景） |
| `test12.py` | `scan_codefiles.py` 描述保护（合成 fixture） |
| `test13.py` | `gen_feed.py` 解析、失败策略、路径（合成 fixture） |
| `test14.js` | 排序一致性 + 日期时区（Asia/Shanghai、America/New_York、Europe/London） |
| `test15.py` | 生成器可复现性（合成 fixture：课程 / 论文 / 描述） |

单独运行：

```bash
node tests/audit.js
python tests/test13.py
```

> `test9.js` 的懒加载失败分支需要环境变量：`BLOCK=js/courses.js node tests/test9.js`。

### 5.3 用 Fixtures 验证扫描器（不碰私人目录）

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

---

## 7. 提交与发布

```bash
git status
git add <files>
git commit -m "..."
git push origin main          # GitHub Pages 自动构建，约 30 秒 ~ 2 分钟
```

发布后可按下面方式自检（注意加 cache-buster，边缘缓存会有延迟）：

- `https://ericzhao666.github.io/blog/sw.js?cb=1` → `CACHE_VERSION` 是否为新版本
- `https://ericzhao666.github.io/blog/feed.xml?cb=1` → `lastBuildDate` 与条目数

---

## 8. 会覆盖产物的脚本

| 脚本 | 覆盖的文件 | 失败时 |
| --- | --- | --- |
| `scripts/scan_courses.py` | `js/courses.js` | 0 门课时中止，不写 |
| `scripts/scan_papers.py` | `js/papers.js` | 缺库 / 0 篇时中止，不写 |
| `scan_codefiles.py` | `js/codefiles.js` | 既有产物不可解析时中止，不写 |
| `gen_feed.py` | `feed.xml` | 先构建后原子替换，异常不写 |
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
- 任何 GitHub Token（编辑器 Token 只存浏览器 `sessionStorage`/`localStorage`，不上传）；
- 测试用的真实扫描结果（测试一律使用合成 fixture）。

`scan_courses.py` / `scan_papers.py` / `scan_codefiles.py` 里的绝对路径只是**本机默认值**，目录不存在会自动跳过；换机器请用 `--roots` / `--zotero-db` / `--learn-dir` 指定，测试则完全走合成 fixture。

---

## 11. 已知限制

- `gen_notes_pages.js` 的 `dateModified` / `sitemap lastmod` 取“当天”，跨天重跑必然产生 diff，暂无 `--now` 参数。
- 生成器的**真实端到端扫描**需要本机存在私人源目录，仓库内只保证合成 fixture 可跑（`test15.py`）。
- 测试基于 jsdom，不覆盖真实浏览器的 Service Worker 生命周期与跨域行为。
- `tests/` 与 `scripts/` 之外，根目录仍保留 `scan_codefiles.py`、`gen_feed.py`、`gen_notes_pages.js`（保持既有调用路径不变）。
