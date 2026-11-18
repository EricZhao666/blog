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
- 发布前置条件：**8E-2 发布前必须递增 `sw.js` 的 `CACHE_VERSION`**（见 §7），否则老访客会继续使用旧缓存中的旧 `app.js`。

## 10. 上一轮审计交付物

`BATCH8E1_AUDIT_REPORT.md`、`BATCH8E1_ISSUES.csv`、`BATCH8E1_NEXT_PLAN.md` 完整保留，并随本次 commit 一同入库（见 §1）。
