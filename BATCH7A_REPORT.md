# Batch 7A 交付报告：移动端静态笔记导航 + 课程 SEO 元数据修复

- 仓库：`E:\work_funnycode\blog`（GitHub `EricZhao666/blog`）
- 分支：`feature/batch7-improvements`（原临时分支名 `feature/batch7a-mobile-seo`，已重命名）
- 基线：`main @ 303d99e`（Fast-forward 自 `32e537d`）
- 回退基线：tag `batch7a-base`、分支 `backup/pre-batch7a-303d99e`（均指向 `303d99e`）
- 修复提交：`182e7fe`
- 本机环境：Node 24.22.1 / Python 3.12.7 / Playwright 1.64.1 / 浏览器通道 `chrome`
  （CI 使用 `PW_CHANNEL=chromium` + `npx playwright install --with-deps chromium`）
- 判定：**BATCH7A_LOCAL_READY**
- 独立复核：本会话在干净工作区上重跑两套新增用例、全量回归与生成器逐字节比对，
  结果与下表一致（见 §5.2）

---

## 0. 验收表

| 项目 | 要求 | 结果 |
|---|---|---|
| 静态笔记手机菜单 | PASS | PASS（375/390/768 视口均可展开、收起） |
| 键盘和无障碍 | PASS | PASS（Tab 可达、Enter/Space 切换、Esc 关闭并回焦、outline 2px solid） |
| 静态笔记导航 | PASS | PASS（静态页 → `#/courses` 14 门、静态页 → `#/` 18 篇） |
| 课程 canonical / og:url | PASS | PASS（指向 `/blog/notes/<slug>.html`，与映射表一致） |
| 异步路由竞态 | PASS | PASS（A→B、A→首页 均不串页，canonical 唯一） |
| 静态 HTML SEO | PASS | PASS（14 页 + 索引：canonical/og:url/JSON-LD/sitemap 全部正确） |
| 原有 21 套回归 | PASS | PASS（23 套合计 PASS 23 / FAIL 0 / SKIP 0 / BLOCKED 0） |
| 新增浏览器测试 | PASS | PASS（mobile-notes 224/224，course-seo 45/45） |
| 数据与生成器一致性 | PASS | PASS（15 页逐字节可复现；sitemap/映射/RSS/文章日期未变） |
| Git 状态 | 干净 | PASS（`git status` 无未提交改动；遗留临时目录 `%TMPBASE%/` 已删除，见 §7 风险 6） |

---

## 1. 问题复现记录（修复前）

复现方法：`git archive 303d99e` 解包到临时目录，把本轮新增的两个用例拷进去，
在**未修改**的代码上运行（`NODE_PATH` 指向仓库 `node_modules`，`PW_CHANNEL=chrome`）。

### 1.1 B7A-01 静态笔记页没有移动端菜单

基线运行结果（含第 9 节新增的主站 SPA 检查）：**共 155 项，PASS 107，FAIL 48**

| 观察点 | 修复前实际值 |
|---|---|
| `notes/*.html` 中 `#menuToggle` | 不存在（15 个页面全部缺失） |
| ≤768px `.nav` 计算样式 | `visibility: hidden; display: flex`（CSS 已隐藏，但没有任何入口打开） |
| 点击汉堡按钮的用例 | `page.click('#menuToggle')` 超时 30 000 ms |
| `aria-expanded` / `aria-controls` | 不存在 |
| 主站 `index.html` 的菜单按钮 | 有按钮但缺 `type` / `aria-expanded` / `aria-controls`；`app.js` 也没有跨断点复位（375 展开 → 1280 → 回 375 会"自动展开"且 aria 仍为 true） |
| 1280px 桌面布局、无横向溢出、主题切换 | 正常（说明差异只在移动端导航入口） |

根因：`css/style.css` 在 `@media (max-width: 768px)` 里把 `.nav` 变成需要 `.nav.open` 才显示的覆盖层，
而 `gen_notes_pages.js` 的 `pageShell()` 既没有输出 `.menu-toggle` 按钮，也没有任何展开/收起脚本
（静态页不加载 `js/app.js`）。主站 `index.html` 的按钮与 `app.js` 的监听从未被复用到静态页。

### 1.2 B7A-02 课程页 canonical 在异步加载后不更新

基线运行结果：**共 45 项，PASS 38，FAIL 7**

| 场景 | 期望 | 修复前实际 |
|---|---|---|
| 冷启动 `#/course/本科课程\|机器人与自动化-(CS422)`（`note-slugs.js` 延迟 2.5s） | `https://ericzhao666.github.io/blog/notes/cs422.html` | `https://ericzhao666.github.io/blog/` |
| `og:url` 同上 | 同上 | 站点根 |
| A→B 快速切换 | B 的 `notes/grcnn.html` | 站点根 |
| 3 门课程冷启动 | 各自静态页 | 全部站点根 |

根因（`js/app.js`）：

1. `router()` 的 `/course/:id` 分支只 `await loadData('courses')`，随后立即 `updateMetaForRoute(hash)`；
   此时 `dataReady('notes')` 仍为 `false`，`NOTE_PAGES` 未定义 → `setCanonical(null)` → 站点根。
2. `loadData('notes').then(...)` 回调只做正文重渲染（`renderCourseDetail` + 代码高亮 + 阅读工具），
   **从不重新计算元数据**，所以整次访问 canonical / og:url 都停在站点根。
3. 标题/描述之所以正确，是因为它们只依赖 `COURSES`（先到）；只有 `canonical`/`og:url` 依赖 `NOTE_PAGES`。

---

## 2. 修复内容

### 2.1 B7A-01（静态笔记移动端导航）

| 文件 | 改动 | 原因 |
|---|---|---|
| `gen_notes_pages.js` | `pageShell()` 的 `<nav>` 增加 `id="siteNav"`；新增 `.menu-toggle` 按钮（`type=button`、`aria-label="菜单"`、`aria-expanded="false"`、`aria-controls="siteNav"`）；新增一段内联菜单脚本 | 静态页不加载 `app.js`，必须自带最小交互；复用主站类名与样式 |
| `notes/*.html`（15 个） | 用固定 `--now 2026-10-22` 重新生成（每页 +52/−1） | 产物必须与生成器一致 |
| `css/style.css` | 移动端 `.nav` 增加 `max-height: calc(100dvh - var(--header-height))`、`overflow-y: auto`、`overscroll-behavior: contain`、轻量阴影 | 面板限高并自身滚动，长菜单也不会盖满整屏遮挡正文操作区 |
| `index.html` | 菜单按钮补 `type`、`aria-expanded`、`aria-controls`，`<nav id="siteNav">` | 与静态页保持同一套无障碍契约 |
| `js/app.js` | 抽出 `setMobileMenu(open, focusBtn)`；路由切换统一调用；点击监听改为同步 `aria-expanded`；新增 Esc 收起（仅菜单展开时生效）；补 `matchMedia` + `resize` 跨断点复位 | 一套行为，避免主站与静态页两套实现漂移 |

键盘与焦点：

- 使用原生 `<button>`，Enter / Space 由浏览器触发 `click`，无需自定义 keydown；
- Esc 关闭后 `btn.focus()`，焦点不会丢到 `body`；
- 焦点轮廓沿用全局 `:focus-visible { outline: 2px solid var(--color-primary) }`，实测键盘聚焦时
  `outline-style: solid`、`outline-width: 2px`；
- Tab 顺序：skip-link → logo → 导航链接 → 主题按钮 → 菜单按钮（1280px 下菜单按钮 `display:none` 不参与）。

断点行为（静态页与主站 `js/app.js` 各有一份等价实现）：

- `matchMedia('(max-width: 768px)')` 的 `change` 事件 + `resize` 兜底：跨到 769px 时移除 `.open`、
  复位 `aria-expanded="false"`，避免"按钮隐藏但 aria 仍为 true"的状态残留；
- 主站（`index.html` + `app.js`）原实现没有断点复位，复核时实测存在残留：375px 展开 → 1280px →
  回 375px 后菜单自动展开且 `aria-expanded` 仍为 `true`。本轮已补齐等价实现，
  复测结果为 `open=false`、`aria-expanded=false`。

修复前后行为对比：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 375/390/768 打开静态页 | 无菜单入口，导航不可见 | 汉堡按钮可见，导航默认收起 |
| 点击汉堡按钮 | 无按钮，超时 | 面板展开（`open=true`、`aria-expanded=true`） |
| Esc | 无行为 | 收起并把焦点还给按钮 |
| 点击正文 | — | 收起菜单（面板限高 212px / 视口 812px，仅覆盖顶部） |
| 768→769 缩放 | — | 按钮隐藏、导航内联常显、`open` 与 aria 复位 |
| 1280 桌面 | 正常 | 正常（按钮 `display:none`，导航内联） |
| 深色模式 | 正常 | 正常（面板 `rgb(26,29,35)`，头部 `rgb(22,24,29)`） |
| 主题切换 / Logo / skip-link | 正常 | 正常（未改动） |

### 2.2 B7A-02（课程 SEO 元数据）

`js/app.js` 的课程分支异步回调：

```js
if (!notesReady) {
  loadData('notes').then(function () {
    if (token !== _routeToken) return;                 // 路由已切换：不覆盖新页面
    if ((location.hash.slice(1) || '/') !== hash) return;
    app.innerHTML = renderCourseDetail(id);
    enhanceCodeBlocks(app);
    highlightIn(app);
    buildReadingTools();
    updateMetaForRoute(hash);   // ← 笔记映射到位后重算 title/description/canonical/og:*
  });
}
```

需求逐条对应：

1. **当前路由仍为对应课程**：`_routeToken` + `location.hash` 双重校验；
2. **`_routeToken` 未失效**：token 与 router 自增计数比较，旧 Promise 直接 return；
3. **映射加载失败不产生错误 canonical**：`loadData()` 内部 `catch` 后 `NOTE_PAGES` 仍未定义，
   `updateMetaForRoute` 走 `setCanonical(null)` → 站点根，实测 T4 通过；
4. **无静态映射的课程保持既定回退规则**：31 门无笔记课程仍回退站点根，标题仍为课程标题（T5）；
5. **快速切换路由不串页**：A→B、A→首页 两种时序均验证（T2、T3）；
6. **不重复添加 canonical**：`setCanonical()` 只更新已存在的 `<link rel="canonical">`，所有场景
   `canonicalCount === 1`；
7. **URL 始终包含 `/blog/`**：`SITE_ORIGIN = 'https://ericzhao666.github.io/blog/'`，并断言不出现
   `/blog/blog/`。

没有引入新的 SEO 状态机：仍由 `updateMetaForRoute()` 单一入口负责，只是多一次（受控的）调用。

### 2.3 Service Worker 版本

`sw.js`：`CACHE_VERSION` `2026-10-27-1` → `2026-10-30-1`。

理由：`index.html`、`css/style.css`、`js/app.js` 都在 `REQUIRED_ASSETS`（安装期整版本预缓存）里，
不递增版本会让老客户端在网络超时回退时拿到"新 HTML + 旧脚本"。递增后 Batch 6 的整版本策略不变：
`CACHE` / `CACHE_RT` 都带版本号，安装即整份替换。

验证：`browser`（37/37）、`sw-consistency`（35/35）、`sw-upgrade`（25/25，含旧版→新版部署、
安装失败回退、多标签页、混部）全部通过。

---

## 3. 浏览器测试结果

本地 HTTP Server 把仓库挂到 `/blog/` 子路径，`serviceWorkers: 'block'` 隔离 SW，
所有非 `127.0.0.1` 请求一律 `fulfill 204`（避免 CI 访问 giscus.app 造成抖动）。

### 3.1 `tests/browser/mobile-notes.spec.js`：**224/224 PASS**

覆盖矩阵：

| 维度 | 取值 |
|---|---|
| 视口 | 375×812、390×844、768×1024、1280×800 |
| 页面 | `notes/index.html`、普通笔记 `notes/materials.html`、长文笔记（自动取最大文件，实测 `mech7010.html`） |
| 冷启动 | 每个视口都用新 context 直接 `goto`，无 referrer、无历史 |
| 交互 | 点击展开/收起、Esc、点击正文关闭、Tab 聚焦、Enter、Space |
| 断点 | 768 展开 → 769 收起并复位 → 768 再次收起；另加主站 SPA 375↔1280 双向复位 |
| 主题 | 浅色 / 深色（`localStorage.theme=dark`）、主题切换按钮 |
| 导航 | 静态页 → `#/courses`（14 门课程卡）、静态页 → `#/`（18 篇文章） |
| 布局 | `scrollWidth - innerWidth = 0`（全部 12 个页面×视口组合，展开后仍为 0） |
| 控制台 | 全部场景 `console.error` / `pageerror` 为空 |

关键实测值：面板高度 212 px（375×812）、218 px（768×1024），`navBottom` 276/282，均远小于视口高度；
展开后正文仍可见、可点击（点击正文即收起）。

### 3.2 `tests/browser/course-seo.spec.js`：**45/45 PASS**

| 用例 | 内容 | 结果 |
|---|---|---|
| T1 | 冷启动 + `note-slugs.js` 延迟 2.5 s：中间态 canonical=站点根；映射到位后变为 `/blog/notes/cs422.html`，og:url 同步 | PASS |
| T2 | `course-notes.js` 800 ms / `note-slugs.js` 2.2 s，加载期间 A→B：最终元数据全部属于 B | PASS |
| T3 | 加载期间 A→首页：旧 Promise 不覆盖首页标题/canonical | PASS |
| T4 | `note-slugs.js` 404：canonical/og:url 回退站点根，标题仍为课程标题，无假静态页 URL | PASS |
| T5 | 31 门无笔记课程：回退站点根（既定规则） | PASS |
| T6 | 14 页 + 索引的**服务器原始响应**（不执行 JS）：canonical、og:url、og:title、description、JSON-LD、sitemap 全部正确 | PASS |
| T7 | 用仓库内 JSON-LD 的 `dateModified`（`2026-10-22`）重新生成到临时目录，15 页 + sitemap + 映射逐字节一致 | PASS |
| T8 | 深色模式不改变标题/canonical/og:url，canonical 仍唯一 | PASS |
| T9 | 3 门课程独立冷启动，canonical 均正确且唯一 | PASS |

修复前后对比：`45 项 / PASS 38 / FAIL 7` → `45 项 / PASS 45 / FAIL 0`。

证据文件（已 gitignore，不入库）：`tests/browser/artifacts/mobile-notes.json`、
`tests/browser/artifacts/course-seo.json`、`tests/browser/artifacts/batch7a-*.png`。

---

## 4. 静态页面生成产物校验

| 检查 | 结果 |
|---|---|
| 生成命令 | `node gen_notes_pages.js --now 2026-10-22`（与仓库既有产物同日期） |
| 改动页面数 | 15（14 篇笔记 + `notes/index.html`），每页 +52/−1 |
| 差异范围 | 仅 `<nav id>`、`.menu-toggle` 按钮、内联菜单脚本；正文、日期、上下篇、JSON-LD 未变 |
| `sitemap.xml` | 未改动（`lastmod` 仍为 2026-10-22） |
| `js/note-slugs.js` | 未改动 |
| `feed.xml` / `data/` | 未改动 |
| 可重复生成 | T7 逐字节对比通过；`tests/test17.py` 11/11（含 N3/N4 哈希一致、N10 两次生成一致） |
| 安全机制 | DOMPurify 净化与 JSON-LD `< > &` 转义未触碰（test17 N5–N9 通过） |

---

## 5. 全量回归

命令：`set "PW_CHANNEL=chrome" && python scripts/run_tests.py --report tests/reports/batch7a.md --json tests/reports/batch7a.json`

| # | 用例 | 结果 | 项数 | 耗时 |
|---|---|---|---|---|
| 1 | audit（全站巡检） | PASS | — | 12.8s |
| 2 | test6（课程区） | PASS | — | 7.4s |
| 3 | test7（搜索/主题/静态页/SW/RSS） | PASS | — | 8.2s |
| 4 | test8（Token 存储） | PASS | — | 5.5s |
| 5 | test9（路由/搜索/懒加载） | PASS | — | 11.7s |
| 6 | test10（发布数据完整性） | PASS | — | 9.0s |
| 7 | test11（草稿竞态） | PASS | — | 10.8s |
| 8 | test12（代码库描述保护） | PASS | 25/25 | 2.9s |
| 9 | test13（RSS 解析） | PASS | 40/40 | 4.0s |
| 10 | test14（排序/时区） | PASS | — | 11.1s |
| 11 | test15（生成器 Fixture 可复现） | PASS | 32/32 | 10.3s |
| 12 | test16（Markdown 净化） | PASS | 20/20 | 3.2s |
| 13 | test17（静态页 JSON-LD/正文安全） | PASS | 11/11 | 5.6s |
| 14 | test18（数据拆分完整性） | PASS | 18/18 | 0.1s |
| 15 | split-check（数据产物校验） | PASS | — | 0.3s |
| 16 | test19（数据生命周期） | PASS | 36/36 | 7.3s |
| 17 | test20（发布与搜索一致性） | PASS | 21/21 | 12.7s |
| 18 | feed-check（RSS 一致性） | PASS | — | 0.4s |
| 19 | browser（SW 安装/离线/更新） | PASS | 37/37 | 35.3s |
| 20 | sw-consistency（版本一致性/慢网） | PASS | 35/35 | 86.4s |
| 21 | sw-upgrade（跨版本升级/回退） | PASS | 25/25 | 25.9s |
| 22 | **mobile-notes（新增）** | PASS | 224/224 | 30.2s |
| 23 | **course-seo（新增）** | PASS | 45/45 | 21.4s |

汇总：**PASS 23 / FAIL 0 / SKIP 0 / BLOCKED 0**；语法检查 25 个 JS + 11 个 Python 文件全部 OK。
新增两套用例在 Linux CI 中由同一入口真实执行（`kind: 'browser'`），浏览器不可用时按既有约定
退出码 2 记为 BLOCKED 并使 job 失败，不会"跳过但仍报通过"。

### 5.2 独立复核（本会话复跑，工作区无改动）

| 复核项 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `python scripts/run_tests.py --report tests/reports/batch7a-verify.md` | PASS 23 / FAIL 0 / SKIP 0 / BLOCKED 0 |
| 移动端用例 | `node tests/browser/mobile-notes.spec.js` | 共 224 项，PASS 224，FAIL 0 |
| SEO 用例 | `node tests/browser/course-seo.spec.js` | 共 45 项，PASS 45，FAIL 0 |
| 修复前复现 | `git archive 303d99e` 解包到临时目录，拷入两套用例后运行 | mobile-notes 155 项 48 FAIL；course-seo 45 项 7 FAIL |
| 断点复位定点验证 | 临时回退 `js/app.js` 的 `resetMenuOnDesktop` 后重跑 | 仅 `SPA 375→1280 残留 open 状态已清理`、`SPA 1280→375 回到收起状态` 2 项 FAIL（224→222 PASS），恢复后全绿 |
| 产物一致性 | `node gen_notes_pages.js --out-dir <tmp> --now 2026-10-22` 后逐文件 SHA256 比对 | 15 页 + `sitemap.xml` + `js/note-slugs.js` 差异数 0 |
| 时序抖动 | 一次全量运行（本机同时有其他浏览器进程） | `sw-consistency` T2「load 明显快于 800ms 网络」实测 976 ms → FAIL；同机单独复跑 243 ms PASS，随后全量复跑 PASS 23 / FAIL 0。**未修改阈值、未改用例**，按 Batch 6 约定保留原断言 |

复核用浏览器：`chrome 156.0.8078.74`。CI 端通道为 `chromium`，两者均由 Playwright 真实驱动。

---

## 6. SEO 边界说明

必须区分两类元数据：

1. **SPA（`index.html` + hash 路由）**：`document.title`、`meta description`、`canonical`、`og:*`
   全部由 `updateMetaForRoute()` 在运行时写入。本轮修复保证"值算得对、不会被旧 Promise 覆盖"，
   但这只是**对执行 JS 的爬虫/工具**有效；hash 片段本身也不会被当作独立 URL 抓取。
   因此本报告不声称"仅靠 JS 元数据就能保证收录"。
2. **静态 HTML（`notes/<slug>.html`）**：canonical、og:url、og:title、JSON-LD 直接写在服务器返回的
   源码里。T6 用**原始 HTTP 响应字节**（不执行 JS）逐页校验，T7 校验产物与生成器逐字节一致。
   这部分才是搜索引擎可稳定依赖的入口。

`index.html` 自身的 canonical / og:url 仍指向 `https://ericzhao666.github.io/blog/`（站点根），未改动。

---

## 7. 已知风险与回退

### 风险

1. **SPA 元数据依赖 JS**：不执行 JS 的爬虫只会看到 `index.html` 的站点级元数据；课程内容收录依赖
   `notes/*.html` 静态页（已有 sitemap 覆盖）。
2. **31 门无笔记课程**仍回退站点根 canonical（既定规则，未在本轮扩展），这类深链在 SEO 上等价于首页。
3. **首个中间态**：冷启动且 `note-slugs.js` 较慢时，canonical 会有几百毫秒停留在站点根，随后被修正。
   这是异步加载的固有形态；映射脚本本身已在 `OPTIONAL_ASSETS` 预取列表中，正常网络下极短。
4. **CACHE_VERSION 递增**会触发客户端一次性重新预缓存（`CACHE` 整版本替换），首访流量略增。
5. **移动菜单仍是下拉覆盖层**（与主站一致），不是全屏抽屉；已通过限高、外部点击、Esc、链接跳转关闭
   来控制遮挡，但展开时仍会覆盖正文顶部约 210 px。
6. **工作区残留（已处理）**：一次 shell 引号处理失误在仓库根目录创建过未跟踪目录 `%TMPBASE%/`。
   经 `git hash-object` 比对确认其 `gen_notes_pages.js` / `js/app.js` / `css/style.css` / `sw.js`
   与 `303d99e` 完全一致（即基线副本，无独有数据），已在本地删除；该目录从未被 `git add`。
7. **时序敏感用例**：`sw-consistency` 的 T2 用 800 ms 断言"缓存 load 明显更快"，机器有其他负载时
   可能测到 900 ms+ 而报 FAIL。本轮实测出现过一次（976 ms），单独复跑 243 ms 通过。
   这是既有用例的固有特性，本轮未放宽阈值；CI 上偶发失败应先看机器负载再判断回退。

### 回退

```bash
# 查看基线
git log --oneline -3
# 方式一：整体回到基线
git checkout batch7a-base        # 或 backup/pre-batch7a-303d99e
# 方式二：只回退本轮提交（保留分支）
git revert 182e7fe
# 方式三：只回退静态页产物
git checkout batch7a-base -- notes gen_notes_pages.js
```

未执行 push / PR / 部署。

---

## 8. 提交与 PR 建议

### 提交

| 提交 | 说明 |
|---|---|
| `182e7fe` | 修复：静态笔记页补移动端菜单，课程异步加载后同步 SEO 元数据（B7A） |
| `a6a97b6` | 文档：新增 `BATCH7A_REPORT.md` |
| 本文件最后一次修订所在提交 | 分支重命名说明 + 本会话独立复核结果（`git log -1 --format=%h -- BATCH7A_REPORT.md`） |

基线与分支：

- `main` / `origin/main` = `303d99e`
- 工作分支：`feature/batch7-improvements`（基于 `303d99e`）
- 回退点：tag `batch7a-base`、分支 `backup/pre-batch7a-303d99e`

### PR 标题

```
Batch 7A：修复静态笔记移动端导航与课程页 SEO 元数据
```

### PR 正文

```markdown
## 背景
- 静态笔记页（notes/*.html）在 ≤768px 没有菜单入口：CSS 把 .nav 藏起来，但生成器既没有输出
  .menu-toggle 按钮，也没有展开/收起脚本。
- 冷启动直接访问 #/course/:id 时，canonical / og:url 一直停在站点根：router 在 note-slugs.js
  到位前就调用 updateMetaForRoute()，而 loadData('notes') 的回调只重渲染正文。

## 改动
- gen_notes_pages.js：15 个静态页补菜单按钮（aria-expanded/aria-controls）与展开、收起、Esc、
  点击外部关闭、断点复位脚本，复用主站 .nav.open / .menu-toggle 样式；产物用 --now 2026-10-22 重新生成。
- css/style.css：移动端 .nav 限高 + 自身滚动，避免盖满整屏。
- js/app.js：课程笔记异步回调在 _routeToken / location.hash 校验后重算 title、description、
  canonical、og:*；菜单状态抽成 setMobileMenu 并支持 Esc。
- index.html：菜单按钮补 aria 与 type；sw.js CACHE_VERSION → 2026-10-30-1。
- 新增 tests/browser/mobile-notes.spec.js（213 项）与 tests/browser/course-seo.spec.js（45 项），
  接入 scripts/run_tests.py 与 npm run test:browser。

## 验证
- python scripts/run_tests.py：23 套全通过（原 21 套 + 新增 2 套），0 失败 0 阻塞。
- 修复前对照（`git archive 303d99e`）：移动端用例 155 项 48 失败；SEO 用例 45 项 7 失败。
- 静态产物：sitemap / note-slugs / feed / 文章日期均未变；重新生成逐字节一致。

## 边界
- SPA 元数据由 JS 写入，仅对执行 JS 的爬虫有效；可收录入口仍是 notes/*.html 的静态元数据。
```

---

## 9. 变更文件清单

| 文件 | 类型 | 原因 |
|---|---|---|
| `gen_notes_pages.js` | 修改 | 静态页模板增加菜单按钮与交互脚本 |
| `notes/*.html`（15） | 重新生成 | 与生成器保持一致 |
| `css/style.css` | 修改 | 移动端导航面板限高与滚动 |
| `index.html` | 修改 | 菜单按钮 aria / type、`nav#siteNav` |
| `js/app.js` | 修改 | 菜单状态统一 + Esc + 跨断点复位 + 课程异步元数据同步 |
| `sw.js` | 修改 | `CACHE_VERSION` 递增 |
| `tests/browser/mobile-notes.spec.js` | 新增 | 移动端导航回归 |
| `tests/browser/course-seo.spec.js` | 新增 | 课程 SEO 回归 |
| `scripts/run_tests.py` | 修改 | 接入两套新用例 |
| `package.json` | 修改 | `npm run test:browser` 覆盖新用例 |
