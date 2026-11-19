# Batch 8E-4 报告：跨浏览器兼容性与离线可靠性验证

- 状态：**B8E4_PR_READY**（本地三引擎验收完成；PR 待创建，见第 10 节环境限制）
- 基线：`origin/main = afc3646`（PR #25 squash 合并：`perf(test): enable validated adjacent pairs and finalize test infrastructure`）
- 分支：`test/batch8e4-cross-browser-reliability`（2026-11-19 16:10 从 `afc3646` 创建）
- 范围：只在测试侧新增跨浏览器入口与离线验证，不修改业务代码、UI/CSS、路由、正式内容、`sw.js`、`CACHE_VERSION`、CI 默认命令
- 既有 64 套回归：本轮**未改动、未重复本地全量**，由 PR 默认串行 CI 承担；新入口不注册进 `scripts/run_tests.py`

## 1. Phase A：基线确认

| 项目 | 结果 |
| --- | --- |
| PR #25 合并状态 | 已合并；`origin/main` 顶部提交 `afc3646`（squash），`git branch -r --contains b572bf3` 仅含原特性分支，符合 squash 合并特征 |
| main 同步 | `b3f88ed → afc3646` 快进成功（9 个文件，+1491/−97） |
| 工作树 | 同步后干净；本轮结束时仅有 3 个新增测试文件未跟踪（提交前） |
| 分支 | `test/batch8e4-cross-browser-reliability`，基线 `afc3646` |
| 残留测试进程 | 无 Playwright / Chromium / Firefox / WebKit 子进程；仅 IDE 运行时 node 进程（非本任务启动） |
| Pages 部署版本 | 线上 `/blog/sw.js` 与本地 `sw.js` 规范化换行后**完全一致**；`CACHE_VERSION=2026-11-18-1`；`Last-Modified: 2026-11-19 07:58 GMT` |
| Pages 构建 API | `api.github.com/.../pages/builds/latest` 返回 404（见 `B8E4-006`，环境限制，未据此推断部署版本） |
| Playwright | 1.64.1（`package-lock.json` 锁定，未升级） |
| 浏览器 | Chromium 156.0.8078.4（自带，已安装）；Firefox 157.0、WebKit 27.2 **本轮按需安装**（`npx playwright install firefox webkit`，未改动 npm 依赖） |
| 运行环境 | Windows / Node v24.22.1 / Python 3.12.7 |

## 2. Phase B：跨浏览器测试架构

新增（3 个文件，均不进入默认回归清单）：

- `tests/browser/helpers/cross-browser.js`
  - 引擎选择：`--engines=chromium,firefox,webkit`（默认三引擎串行）；
  - 每个引擎独立浏览器进程 + 每个场景独立 `BrowserContext`；
  - 统一结果格式：`PASS / FAIL / SKIP / BLOCKED`，写 `tests/reports/b8e4/<spec>-<engine>.json`；
  - 独立 artifact 目录 `tests/browser/artifacts/b8e4/<engine>/`；
  - 启动失败记 `BLOCKED` 并以退出码 2 结束，**不伪造通过**。
- `tests/browser/cross-browser.spec.js`：C1–C5 核心功能矩阵，`--scenario=C1..C5`。
- `tests/browser/cross-browser-offline.spec.js`：D（离线/升级）+ E（B8E1-003 定向），`--scenario=D|E`。

约定：

- 端口全部动态（`server.listen(0)`），不占用固定端口；
- 第三方请求（giscus/CDN）统一 204，避免外网影响判定；
- 只使用合成文章（`USER_POSTS.push`）验证编辑器与阅读体验，**不改动正式文章数据**；
- 默认 64 套入口、`npm test`、`.github/workflows/tests.yml` 均未改动；
- 本轮全部串行，未启用 `--workers 2`。

引擎差异的显式识别：

- Playwright WebKit **只代表 WebKit 引擎**，不等同 macOS Safari / iOS Safari 设备验收；
- Firefox 的 `context.setOffline` 会直接中断导航（`NS_ERROR_OFFLINE`），无法用于 SW 离线兜底验证 → 离线断言改为“本地服务器对所有路径立即断流”，等价于网络不可达（`B8E4-002`）；
- 中文输入法只验证合成键盘事件与组合期守卫，真实 IME 计 SKIP（`B8E4-007`）。

## 3. Phase C：核心功能兼容性矩阵（结果）

三个引擎执行**完全相同的场景集合**，每引擎 59 项（58 PASS + 1 SKIP）：

| 场景 | chromium | firefox | webkit |
| --- | --- | --- | --- |
| C1 页面与导航（13 项） | 13/13 | 13/13 | 13/13 |
| C2 搜索体验（10 项，含 1 SKIP） | 9 + 1 SKIP | 9 + 1 SKIP | 9 + 1 SKIP |
| C3 编辑器（10 项） | 10/10 | 10/10 | 10/10 |
| C4 阅读体验（9 项） | 9/9 | 9/9 | 9/9 |
| C5 响应式与主题（17 项） | 17/17 | 17/17 | 17/17 |
| 合计 | **58 PASS / 0 FAIL / 1 SKIP** | 同左 | 同左 |

关键实测：

- C1：首页 18 张卡片；文章正文 4871 字符；含 `O'Brien`、`中文 标签`、`a&b` 的标签 chip 点击进入 `#/tags/O'Brien` 且未冒泡到文章；课程 14 张、代码库 6 张卡片；深链接 `#/post/ml-fundamentals-overview` 直接访问正常；后退/前进/刷新均保持渲染；`pageerror` 计数 0。
- C2：中文查询（取自真实标题前 3 字）+ 英文查询均返回结果；`模型` 一次命中 3 类（文章/课程/学习资料）；分类筛选 `aria-pressed=true`；ArrowDown 选中 `#/post/vla-model-intro`、Enter 打开、鼠标点击跳转一致。
- C3：预览渲染 `h1/strong/li/pre code`；工具栏加粗生成 `**…**`、H2 生成 `## `；草稿写入 `blog_draft` 并在刷新后恢复；`blog-draft-history` IndexedDB 创建成功（三引擎均支持 `indexedDB.databases()`）；导出 JSON 中文未乱码、文件名 `.json`（用 `window.__downloadText` 钩子取内容，不依赖各引擎下载事件）；2884 字长文本 + emoji/引号预览正常。
- C4：目录 8 项、点击后 `scrollY=947`；进度条 100%；复制反馈 `data-copy-state=ok`（三引擎）；灯箱打开、Esc 关闭、焦点回到 `IMG.zoomable-image`；静态笔记页 `notes/capd.html` 可读（3756 字符）。
- C5：390/768/1440 三档 `scrollWidth == innerWidth`（无横向溢出）；390px 下菜单按钮可展开（`#siteNav.open`）并可导航；主题 `light→dark` 且刷新后保持；每档正文可读（≥1053 字符，字号 15–16px）。

未覆盖：真实设备触控手势、真实 IME、Safari 专有 CSS 行为。

## 4. Phase D：Service Worker 与离线可靠性（结果）

三个引擎各 25 项全部 PASS（`tests/reports/b8e4/cross-browser-offline-*.json`）：

| 编号 | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| D1 | 首次在线访问、注册、安装、激活、接管 | PASS ×3 | `active=true`、`scriptURL=/blog/sw.js`、`controller` 存在 |
| D2 | 安装期缓存包含外壳与首屏资源 | PASS ×3 | `blog-2026-11-18-1` 共 12 条，含 index.html / app.js / style.css |
| D3 | 已缓存首页离线访问 | PASS ×3 | 离线 reload 后 18 条文章链接 |
| D4 | 已缓存文章离线读取 | PASS ×3 | 在线 4837–4923 字符，离线同量（差异 0–1.7%） |
| D5 | 尚未缓存资源的降级 | PASS ×3 | 目标路径确认未被缓存；离线返回 503 + `body[data-offline=1]`，`fromServiceWorker=true` |
| D6 | 网络恢复后重新访问 | PASS ×3 | 恢复后 reload 正常 |
| D7 | 新版本发布后的缓存切换 | PASS ×3 | 新缓存 `blog-…-t2` / `blog-rt-…-t2`；旧缓存清理耗时 531–554ms；`controllerchange=1` |
| D8 | 新版本安装失败时旧版回退 | PASS ×3 | 注入 `/js/app.js` 500；无 `-t2` 半成品缓存；`active` 仍为旧 `sw.js`；离线仍由旧版兜底 |
| D9 | 多标签页升级 | PASS ×3 | 两个标签页均 `controller` 存在，升级后均可刷新 |
| D10 | IndexedDB / CacheStorage 不可用 | PASS ×3 | 首页 18 卡片、编辑器可编辑、localStorage 草稿仍写入 |

说明：

- 版本切换使用 `helpers/server.js` 的内存改写（仅对测试响应把 `CACHE_VERSION` 追加 `-t2`），**未修改生产 `sw.js` 与 `CACHE_VERSION`**；
- 未使用 CDP；全部走 Playwright 公共 API + HTTP 层故障注入；
- 未缓存页面用仓库中不存在的同源路径（`/notes/b8e4-never-cached.html`），避免预取/缓存匹配差异导致前提不成立。

## 5. Phase E：历史风险定向验证（B8E1-003）

**结论：仍存在（CONFIRMED，P3），非发布阻塞。**

判据（引擎无关）：给 `/index.html` 注入 600ms 延迟。快照可用时 `shellNavigate` 在 `NAV_TIMEOUT_MS=150ms` 后交付快照，导航 <450ms；快照不可用时只能等网络 ≥600ms。

| 引擎 | E0 基线（快照完整） | E1 注入缺失后 | 回写资源、快照 12 条完整后 | 判定 |
| --- | ---: | ---: | ---: | --- |
| chromium | 202ms（cache-mode） | 730ms（network-mode） | 687ms（network-mode） | 未自愈 |
| firefox | 304ms | 789ms | 773ms | 未自愈 |
| webkit | 213ms | 726ms | 701ms | 未自愈 |

状态变化链（可复核）：

1. `waitSwActive` 确认激活并接管（`controller` 存在）；
2. 从 `CACHE` 删除 `FIRST_SCREEN_ASSETS` 中的 `/js/projects.js`；
3. 首次受控导航 → `snapshotReady()` 判为 `false` 并写入 `_readyPromise`；
4. 通过 `fetch + cache.put` 把该资源回写到同一 `CACHE`，校验 6 个首屏条目齐全；
5. 再次导航仍为 network-mode → **同一 SW 生命周期内不重新判定**；
6. 该状态下断网导航仍由 `matchCore('./index.html')` 兜底成功（18 条文章链接）→ 影响限于慢链路加速与“外壳已更新”判定，不造成离线不可用。

未做：SW 重启后是否恢复（需要跨浏览器实例的持久化 profile，本轮不作为交付）；临时 `caches` API 异常注入（无法向 SW 注入 init script）。因此只按“生命周期内不自愈”下结论，不外推到其他场景。

## 6. Phase F：问题清单与分级

完整清单见 `BATCH8E4_ISSUES.csv`（8 条）：

| 编号 | 级别 | 分类 | 说明 | 状态 |
| --- | --- | --- | --- | --- |
| B8E4-001 | P3 | CONFIRMED_PRODUCT_BUG | B8E1-003 `snapshotReady` 否定结果不可自愈（三引擎复现） | OPEN（本轮不改 SW） |
| B8E4-002 | P3 | AUTOMATION_LIMITATION | Firefox `setOffline` 直接中断导航，不能验证 SW 兜底 | 已在测试侧规避 |
| B8E4-003 | P3 | CONFIRMED_TEST_BUG | 场景间重置把断网 Proxy 替换掉，导致非首个引擎未断网 | 已修复 |
| B8E4-004 | P3 | CONFIRMED_TEST_BUG | WebKit `#/code` 按需加载时序导致卡片计数为 0 | 已修复（有界轮询） |
| B8E4-005 | P3 | CONFIRMED_TEST_BUG | Firefox `waitForFunction` Promise 断言提前返回，误判升级清理 | 已修复（手动有界轮询） |
| B8E4-006 | P3 | BLOCKED_BY_ENVIRONMENT | Pages 构建 API 404，无法读取部署 commit | OPEN（以产物一致性替代） |
| B8E4-007 | P3 | BLOCKED_BY_ENVIRONMENT | 真实 Safari/iOS 与真实 IME 未验证 | 范围限制，不计 PASS |
| B8E4-008 | P3 | NOT_REPRODUCED | 三引擎核心功能未复现产品差异 | 信息性 |

- 无 P0/P1；无生产代码改动；无断言放宽、无自动重试。
- 产品侧唯一确认项 `B8E4-001` 的建议修复（下批次评估）：`snapshotReady()` 不缓存 `false`，或在缓存被写入/删除后重置 `_readyPromise`；不得放宽快照完整性门槛。

## 7. Phase G：验收执行

| 步骤 | 结果 |
| --- | --- |
| 1. 新增文件语法检查 | `node --check` ×3 全部通过 |
| 2. 跨浏览器专项（C1–C5，三引擎串行） | 174 PASS / 0 FAIL / 3 SKIP / 0 BLOCKED；编排 wall 76–78s |
| 3. SW 定向回归（D/E，三引擎串行） | 75 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED；wall 73.1s |
| 4. 受影响的原有测试 | 无（未修改生产代码与既有测试；无既有套件依赖新文件） |
| 5. `git diff --check` | 退出码 0，无空白错误 |
| 6. 本地 64 套全量 | 未重复执行，由 PR 默认串行 CI 承担（符合本轮约束） |

测试耗时（引擎串行、逐场景串行）：

| 引擎 | C1–C5 | D/E |
| --- | ---: | ---: |
| chromium | 21.0s | 20.0s |
| firefox | 36.3s | 35.5s |
| webkit | 21.0s | 17.6s |
| 合计 | 78.3s | 73.1s |

## 8. 未验证与环境阻塞范围

1. 真实 macOS Safari、iOS Safari、真实触控设备：未验证（`B8E4-007`）。
2. 真实操作系统中文输入法：未验证，仅合成事件与组合期守卫。
3. GitHub Pages 部署 commit：API 404，仅以线上 `sw.js` 与 main 内容一致作为间接证据。
4. CI 不安装 Firefox/WebKit（`.github/workflows/tests.yml` 只装 chromium）：本入口当前为本地/手动执行，未接入 CI（禁止修改 CI 默认入口）。
5. SW 重启后的快照自愈、`caches` API 临时异常注入：未验证（工具限制）。
6. 未做 Lighthouse、未做全站视觉比对（不符合本轮范围）。

## 9. 后续修复优先级

1. **P3 / 下批次**：`snapshotReady` 否定结果自愈（低风险，1 处函数 + 定向回归）。
2. **P3 / 可选**：为跨浏览器入口增加独立 CI job（仅在需要时安装 firefox/webkit），避免影响默认 64 套串行 job。
3. **P3 / 文档**：把“Firefox `setOffline` 与 SW 不兼容”“WebKit ≠ Safari”写入测试指南，避免后续批次重复踩坑。
4. 其余 P3 均为本轮已修复的测试自身问题，无需后续动作。

## 10. 成本、清理与交付

- 实际执行时间：分支创建 16:10:18 → 完成 16:45，约 **35 分钟**；含前置基线阅读与文档梳理，整轮约 **50 分钟**（非计费口径）。
- 模型调用：本轮共约 **45 次工具调用**（含 3 次全量/专项测试编排、2 次浏览器组件安装、1 次临时诊断脚本）；平台 token 消耗未在本环境暴露，未伪造具体数值。
- 测试耗时：见第 7 节（新增测试纯执行 151.4s，三引擎串行）。
- 浏览器组件：新增下载 Firefox 123.8 MiB、WebKit 60.2 MiB（仅本轮验证需要，未升级 npm 依赖）。
- 进程清理：运行结束后无 Playwright/Chromium/Firefox/WebKit 残留；临时诊断脚本 `tests/reports/b8e4-ff-sw-probe.js` 已删除；`tests/reports/` 与 `tests/browser/artifacts/` 均在 `.gitignore` 内。
- PR 创建：`gh` CLI 在本机不可用，无法自动创建 PR。分支将 push 到 `origin`，PR 链接需人工点击：
  `https://github.com/EricZhao666/blog/compare/main...test/batch8e4-cross-browser-reliability`
- 未自动合并、未部署、未进入 Batch 9。

## 11. 复现命令

```powershell
# 三引擎核心功能矩阵（串行）
node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit

# 单引擎 / 单场景
node tests/browser/cross-browser.spec.js --engines=webkit --scenario=C3

# 离线与升级（D）+ B8E1-003 定向（E）
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit
node tests/browser/cross-browser-offline.spec.js --engines=firefox --scenario=E

# 既有 64 套（行为未变）
python scripts/run_tests.py
```
