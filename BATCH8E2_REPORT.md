# BATCH8E2_REPORT — Batch 8E-2 已确认功能缺陷修复与事件编码加固

- 基线 commit：`8c188b8`（origin/main，PR #19）
- 分支：`fix/batch8e2-inline-handlers`
- 执行日期：2026-11-18
- 状态码：**B8E2_LOCAL_READY**（本地 commit 完成，未 push / 未 PR / 未部署）

---

## 1. 修改文件清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `js/app.js` | +16 / -5 | 新增 `jsInline` helper；5 处 inline 拼接点改用它 |
| `tests/test46_inline_handlers.js` | 新增 | 17 项断言（jsdom，合成 USER_POSTS 夹具） |
| `scripts/run_tests.py` | +2 | 注册 `inline-handlers` 套件（59 → 60） |
| `BATCH8E2_REPORT.md` | 新增 | 本报告 |
| `BATCH8E1_AUDIT_REPORT.md` / `BATCH8E1_ISSUES.csv` / `BATCH8E1_NEXT_PLAN.md` | 保留 | 上轮审计交付物，纳入本次本地 commit |

未修改：路由与稳定 ID、搜索评分、正式内容数据、IndexedDB 结构、导入/构建脚本、`sw.js`（含 CACHE_VERSION）、UI/CSS。

## 2. 修复位置与根因

### B8E1-001（CONFIRMED）— 修复完成
根因：`encodeURIComponent` 不会编码单引号（`'` 属于 RFC 3986 unreserved 保留集），而标签 chip 的 `onclick` 把标签值拼进**单引号 JS 字符串**。标签含 `'`（如 `O'Brien`）时 handler 编译失败，点击抛 SyntaxError、`event.stopPropagation()` 未执行，事件冒泡到文章卡片，错误跳转至文章详情页而非标签页。

| 位置（修复后行号） | 函数 | 变更 |
|---|---|---|
| `js/app.js:1434` | `renderHome` 卡片标签 chip | `encodeURIComponent(t)` → `jsInline(t)` |
| `js/app.js:2094` | `renderPostView` 文章页标签 chip | 同上 |
| `js/app.js:2231` | `renderTags` 标签页文章卡片 chip | 同上 |

### B8E1-002（LIKELY）— 按契约加固完成
| 位置（修复后行号） | 函数 | 变更 | 契约核对 |
|---|---|---|---|
| `js/app.js:2450` | `renderCourses` 课程卡片 | `location.hash='#/course/${jsInline(course.id)}'` | `/course/` 路由 `decodeURIComponent(hash.slice(...))`（app.js:5556），`%27` 无损还原 |
| `js/app.js:2616` | `renderCode` 代码库卡片 | `location.hash='#/codelib/${jsInline(lib.id)}'` | `/codelib/` 路由同样 decode（app.js:5643） |

**核对后保留原逻辑的位置及原因（未盲目统一替换）**：

| 位置 | 内容 | 保留原因 |
|---|---|---|
| `js/app.js:1415` / `2218` | 文章卡片 `onclick="location.hash = '#/post/${post.id}'"` | `/post/` 路由**不做 decode**（`hash.slice('/post/'.length)`，app.js:5517）；对 id 编码会改变路由查找语义。id 在导入器（`^[a-z0-9][a-z0-9-]*$`）、编辑器校验、生成脚本三处均有字符集约束，`'` 不可能出现 |
| `js/app.js:2352-2353`（约） | 课程「有笔记/全部课程」chip | `setNotesOnly(true/false)` 为静态参数，无动态值 |
| `js/app.js:2687` / `2734` / `2755` | 代码项目折叠、加载更多 | 参数为循环数字索引/计数，非字符串 |
| `js/app.js:3026` | 论文卡片 `togglePaperCard(this)` | 无动态参数（`data-paper-key` 走 HTML 属性 + `escapeHtml`） |
| `js/app.js:6254` | 标签云点击（事件委托） | `location.hash = '#/tags/' + encodeURIComponent(...)` 为表达式拼接，不在单引号字符串内，无同类风险（测试 T10 覆盖） |

## 3. 公共 helper 的适用边界

```js
// app.js:235-243
function jsInline(value) {
  return encodeURIComponent(String(value == null ? '' : value)).replace(/'/g, '%27');
}
```

- **适用**：仅限「URI 片段 + inline onclick/onkeydown 单引号字符串」拼接场景。
- **不适用**：不是通用 HTML/JS 净化函数，不能替代 `escapeHtml`/DOMPurify，不得用于 HTML 属性、文本节点、URL 查询参数等场景。
- **配套约定**：使用该 helper 的路由必须由 `decodeURIComponent` 解析（`%27` 才能还原为 `'`）；URL 属性（`href`/`data-href`）继续使用 `encodeURIComponent`（属性为双引号上下文，`'` 无注入风险）。

## 4. RED / GREEN 测试证据

新增 `tests/test46_inline_handlers.js`（17 项断言，jsdom + 本地静态服务器 8148，合成 `USER_POSTS` 夹具，未触碰正式文章数据；所有点击为真实 DOM 事件）：

**RED（修复前，batch8e2-red2.log）**：`共 17 项，PASS 14，FAIL 3`
- `FAIL T4 首页标签导航（单引号）`：点击 `O'Brien` chip 后 hash = `#/post/b8e2-inline-fixture`（错误跳文章页）
- `FAIL T8 文章详情标签 chip（单引号）`：同上
- `FAIL T16 全部标签 chip 的 inline handler 可编译`：`home=false detail=false tagPage=false`

**GREEN（修复后，batch8e2-green.log）**：`共 17 项，PASS 17，FAIL 0`
- `PASS T4`：hash = `#/tags/O%27Brien`，页面标题 `标签: O'Brien`
- `PASS T8`：同上（文章详情入口）
- `PASS T16`：`home=true detail=true tagPage=true`

说明：在 `JSDOM.fromURL` + VirtualConsole 组合下，jsdom 未把 inline handler 的 SyntaxError 作为 `jsdomError` 上报（T15 计数为 0），因此额外增加 T16——直接对页面中全部 `.tag[onclick]` 的 handler 源码执行 `new Function` 编译，作为「无 SyntaxError」的硬证据（修复前 false，修复后 true）。

## 5. 特殊字符与路由编码验证（修复后实测）

| 标签 | 点击后 hash（片段） | 路由还原 | 页面标题 |
|---|---|---|---|
| `Robotics` | `#/tags/Robotics` | Robotics | 标签: Robotics |
| `机械臂` | `#/tags/%E6%9C%BA%E6%A2%B0%E8%87%82` | 机械臂 | 标签: 机械臂 |
| `Computer Vision` | `#/tags/Computer%20Vision` | Computer Vision | 标签: Computer Vision |
| `O'Brien` | `#/tags/O%27Brien` | O'Brien | 标签: O'Brien |
| `He said "hi"` | `#/tags/He%20said%20%22hi%22` | He said "hi" | 标签: He said "hi" |
| `100% #1 & more?` | `#/tags/100%25%20%231%20%26%20more%3F` | 100% #1 & more? | 标签: 100% #1 & more? |

- 无双解码：`%25`/`%23`/`%26` 均单次解码后原样呈现（T6 标题逐字符相等）。
- 事件传播：正常标签点击仍在 chip 内 `stopPropagation`，不冒泡至卡片（T1-T6 均未跳文章页）；文章/课程/代码库卡片点击导航不变（T12/T13/T14）。

## 6. 全量回归结果与耗时

- 命令：`python scripts/run_tests.py`（单次执行）
- 结果：**PASS 60 / FAIL 0 / SKIP 0 / BLOCKED 0**（原 59 套 + 新增 `inline-handlers`）
- 耗时：2026-11-18 10:10:01 → 10:32:32，**22.5 分钟**（含 15 个真实 Chromium 套件；新增套件 18.8s / 17 项，在 180s 套件预算内）
- 原 59 套全部保持 PASS，无覆盖率下降。

## 7. SW 发布兼容性检查（只读，未修改）

结论：**app.js 变更后、发布前必须递增 `CACHE_VERSION`，属发布阻塞前置条件。**

依据：
- `js/app.js` 位于 `APP_SHELL` install 期必需预缓存清单（sw.js:32），缓存名按版本命名（`blog-<CACHE_VERSION>`，sw.js:17）。
- install 只在 `sw.js` 内容变化时触发；本轮未修改 `sw.js`，已安装旧 SW 的浏览器不会重新 install，在线请求会继续命中旧 CACHE 中的旧 `js/app.js`（`sw.js:71-89`），导致修复对老访客不生效。
- `sw.js:13` 注释明确「每次发布请递增 CACHE_VERSION」。

因此：8E-2 发版时必须单独提交 `sw.js` 的 CACHE_VERSION 递增（如 `2026-11-18-1`），并跑一次 SW 相关回归（`sw-consistency`/`sw-upgrade`/`browser`）。本轮按范围限制**不擅自修改**。

## 8. 未修复问题及原因（按 8E-1 NEXT_PLAN 范围）

| 问题 | 状态 | 原因 |
|---|---|---|
| B8E1-003（sw.js snapshotReady 失败态不自愈） | 未修 | 计划明确留给后续 SW 迭代；本轮仅做事件编码 |
| B8E1-004（focusSearch 定时器冗余） | 未修 | 可选顺手项，本轮范围外 |
| B8E1-005（search-index 解析） | 未修 | 当前规模无量化收益，避免微优化 |
| 静态笔记页双 H1 | 未动 | 生成流水线禁改范围（8D-4 结论） |
| post.id inline 拼接 | 保留 | 路由不 decode，编码会改变语义；id 有字符集校验（见 §2） |

## 9. 残留进程与工作树

- 本轮启动的静态服务器（test46 内 8148 端口）随测试退出自动关闭；未启动 Chromium（jsdom）。
- 回归后复查：无 python/node 残留监听端口、无残留浏览器进程。
- 工作树：`fix/batch8e2-inline-handlers`，仅包含 §1 所列文件；运行日志与 RED/GREEN 日志均保存在 agent 工作区，不入仓库。
- 本地 commit：本分支 HEAD，提交说明 `fix: Batch 8E-2 harden inline handler encoding`（未 push / 未 PR / 未合并 / 未部署）。
- 发布前置条件：**8E-2 发布前必须递增 `sw.js` 的 `CACHE_VERSION`**（见 §7），否则老访客会继续使用旧缓存中的旧 `app.js`。**该条件已由 Batch 8E-2R 解除（见 §11）。**

## 10. 上一轮审计交付物

`BATCH8E1_AUDIT_REPORT.md`、`BATCH8E1_ISSUES.csv`、`BATCH8E1_NEXT_PLAN.md` 完整保留，并随本次 commit 一同入库（见 §1）。

## 11. Batch 8E-2R：SW 发布门禁解除与 PR 准备

### 11.1 基线确认

- 分支 `fix/batch8e2-inline-handlers`，HEAD `cd6f150`（`fix: Batch 8E-2 harden inline handler encoding`）。
- `git fetch origin main` 复核：`origin/main` 仍为 `8c188b8`，未变化；本地 ahead 1 / behind 0。
- 8E-1 三件审计交付物、`tests/test46_inline_handlers.js`、`scripts/run_tests.py` 注册项均完整保留。

### 11.2 CACHE_VERSION 变更

| 位置 | 变更前 | 变更后 |
|---|---|---|
| `sw.js:14` | `2026-11-17-2` | `2026-11-18-1` |

- 仅递增版本号；SW 导航决策、缓存策略、离线机制、生命周期全部未改（`install` 的 skipWaiting、`activate` 清理 `blog-*` 旧缓存 + `clients.claim` 均保持原样）。
- 确有依赖的测试期望同步（2 处，均为版本断言，未放宽强度）：
  - `tests/browser/image-lightbox.spec.js:322`：R4 精确相等 → `'2026-11-18-1'`。
  - `tests/browser/ui-refresh.spec.js:732`：U11.1 日期前缀正则 → `/^2026-11-18-\d+$/`。
- 其余版本引用经核对均为动态读取或 `>` 比较（`sw.spec` / `sw-consistency` / `sw-upgrade` / `search-ux` / `reading-experience` / `editor-*` / `test14 S1` 的 `>= '2026-10-23-3'`），无需改动。

### 11.3 SW 升级验证

现有测试基础设施（单次运行，日志在 agent 工作区）：

| 套件 | 结果 | 耗时 |
|---|---|---|
| `tests/browser/sw.spec.js` | 首次 36/37（S12 时序抖动）；单独重跑 **37/37 PASS** | 45.2s / 41.0s |
| `tests/browser/sw-consistency.spec.js` | **37/37 PASS** | 94.6s |
| `tests/browser/sw-upgrade.spec.js` | **25/25 PASS** | 32.1s |
| `tests/browser/image-lightbox.spec.js` | **34/34 PASS**（R4/R5/R6 全部通过） | 17.6s |
| `tests/browser/ui-refresh.spec.js` | **ALL PASS**（U11.1 通过） | 44.0s |
| `tests/test46_inline_handlers.js` | **17/17 PASS** | 21.6s |

S12 说明：首次失败瞬间 `cacheKeys(t1)` 仍显示旧版本名，但紧随其后的检查已观测到 `blog-2026-11-18-1-t2`，即「模拟发布 + 换代」实际完成，仅 2500ms 采样早于安装/激活完成；重跑全绿，非版本回归。

**隔离升级验证**（一次性脚本 `b8e2r-upgrade-check.js`，位于 agent 工作区，不入仓库）：构造旧部署 = `git show 8c188b8:js/app.js` + `sw.js` 版本回写 `2026-11-17-2`，客户端安装旧 SW 并接管；随后切换到真实当前仓库文件模拟发版。**结果 14/14 PASS**：

- 旧客户端：`blog-2026-11-17-2` 缓存存在；`typeof window.jsInline === 'undefined'`；点击 `O'Brien` → `#/post/b8e2r-upgrade-fixture`（缺陷重现）。
- 升级后：新缓存 `blog-2026-11-18-1` 写入；旧版本缓存被清理（仅剩 `blog-2026-11-18-1` / `blog-rt-2026-11-18-1`）；新 SW 接管页面；`window.jsInline === 'function'`；服务端 `app.js`（238081B）含 `function jsInline`；新缓存内的 `app.js` 为修复版。
- 升级后点击 `O'Brien` → `#/tags/O%27Brien`，页面标题 `标签: O'Brien`（不再进入文章详情）；无新增脚本错误；离线仍可打开首页。

**旧客户端更新行为**：下次导航/刷新时浏览器获取新 `sw.js` → install（skipWaiting）→ activate 删除旧 `blog-*` 缓存并 `clients.claim`。S12 与隔离脚本均证实：旧标签页被新 SW 接管、旧缓存消失，升级后不会继续从旧缓存加载旧 `app.js`。

### 11.4 门禁与测试策略

- `node --check sw.js` / `image-lightbox.spec.js` / `ui-refresh.spec.js`：全部 0；`git diff --check`：0。
- 静态资源门禁：`check_images.py --check` OK（ERROR 0 / WARNING 0）、`build_content.py --check` OK（18 篇 / 66495 字符）、`gen_feed.py --check` OK（18 条）。
- 本轮**未重复本地全量回归**：`.github/workflows/tests.yml` 的 PR job 统一执行 `python scripts/run_tests.py --report ... --json ...`（全量 60 套，含 Playwright Chromium），可承担最终全量验收；本地改动仅为版本号与两处期望值，相关专项均已全绿。
- **PR CI 状态：待创建 PR 后由 CI 执行**；在 CI 完成前不声称已满足全部合并条件。

### 11.5 发布阻塞状态

- 原唯一发布阻塞条件「`js/app.js` 变更未递增 `CACHE_VERSION`」**已解除**。
- 合并前仍需 PR CI 全量 60 套通过；本轮不合并、不部署。

### 11.6 工作树、残留进程与提交

- 工作树仅含 `sw.js`、`tests/browser/image-lightbox.spec.js`、`tests/browser/ui-refresh.spec.js` 及本报告；临时脚本与日志均在 agent 工作区，未入库。
- 残留进程复查：`tests/tmp/loop-repro.js` 不存在；8147/8148 端口无监听；无本任务启动的 Chromium/node 子进程残留。
- 本报告随本轮 `chore: bump service worker cache version for Batch 8E-2` commit 提交（保留 `cd6f150` 历史，不重写）。
