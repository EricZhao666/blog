# Batch 7A-1 报告：Linux CI、真实浏览器与发布前稳定性验收

- 仓库：`E:\work_funnycode\blog`（GitHub `EricZhao666/blog`）
- 分支：`feature/batch7-improvements`
- 正式基线：`main @ 303d99e`
- 本轮验证对象：`d5c2b1a`（Batch 7A 全部本地提交）
- 本机：Windows / Node 24.22.1 / Python 3.12.7 / Playwright 1.64.1 / Chrome 156.0.8078.74
- CI：ubuntu-latest / Node 22 / Python 3.12 / Playwright Chromium 156.0.8078.4
- 判定：**B7A_PR_READY**（详见 §11 与 §14 的未验证项）

---

## 1. 初始 Git 状态

| 项 | 值 |
|---|---|
| 分支 | `feature/batch7-improvements` |
| HEAD（本轮开始时） | `d5c2b1add3815b733dbb3845a7d1e6b75972e560` |
| 工作区 | 干净（`git status --porcelain` 空输出） |
| 本地 `main` | `303d99e48755e2aad9b05b85e665422d46c5285e` |
| `origin/main` | `303d99e48755e2aad9b05b85e665422d46c5285e` |
| 远端 | `git@github.com:EricZhao666/blog.git`（SSH，`ls-remote` 可用） |

Batch 7A 提交完整性（`303d99e..HEAD`）：

```
d5c2b1a 文档：BATCH7A 报告记录新增提交哈希
5cf415a 文档：BATCH7A 报告补充分支名、独立复核结果与风险记录
4ca99dd 修复：主站移动菜单补跨断点复位，用例新增 SPA 断点检查（B7A）
a6a97b6 文档：新增 BATCH7A_REPORT.md
182e7fe 修复：静态笔记页补移动端菜单，课程异步加载后同步 SEO 元数据（B7A）
```

接入与忽略规则检查：

| 检查 | 结果 |
|---|---|
| `scripts/run_tests.py` 含 `mobile-notes` / `course-seo` | 是（`kind: 'browser'`，退出码 2 记为 BLOCKED 并使 job 失败） |
| `.github/workflows/tests.yml` | 存在，`on: push / pull_request / workflow_dispatch`，`npm ci` + `npx playwright install --with-deps chromium` + `python scripts/run_tests.py` |
| `.gitignore` 是否误排除测试 | 否（`git check-ignore` 对 4 个测试/入口文件均无输出；`tests scripts .github` 追踪 85 个文件） |
| 工作区是否干净 | 是 |

---

## 2. 独立克隆验证

```
git clone --branch feature/batch7-improvements --single-branch E:\work_funnycode\blog %TEMP%\blog-b7a1
npm ci            # added 40 packages in 12s，严格按 package-lock.json
npx playwright install chromium
```

| 项 | 结果 |
|---|---|
| 克隆 HEAD | `d5c2b1a`（与工作区一致） |
| 克隆内 `node_modules` | 不存在（未复用原工作区依赖） |
| 旧缓存/遗留产物 | 不存在（`tests/reports`、`tests/browser/artifacts` 均为 gitignore，不会被克隆） |
| 依赖安装 | `npm ci` 成功，40 个包 |
| 版本 | Node 24.22.1（本机）、Python 3.12.7、Playwright 1.64.1、Chromium 156.0.8078.4 |
| 绝对路径/私人目录依赖 | 无：对 `scripts/*.py`、`*.py`、`*.js`、`js/*.js` 检索 `E:\`、`C:\Users`、`/Users/`、`file:///` 均 0 命中 |
| 全量测试 | **PASS 23 / FAIL 0 / SKIP 0 / BLOCKED 0**（报告：`tests/reports/b7a1-clone.md`） |

克隆环境各套件耗时（同机顺序执行，无并行浏览器任务）：

| 套件 | 结果 | 耗时 |
|---|---|---|
| audit | PASS | 13.6s |
| test6 / test7 / test8 | PASS | 7.4s / 7.9s / 5.1s |
| test9 / test10 / test11 | PASS | 11.4s / 9.1s / 13.9s |
| test12 / test13 | PASS 25/25 / 40/40 | 10.3s / 11.9s |
| test14 | PASS | 36.7s |
| test15 / test16 / test17 | PASS 32/32 / 20/20 / 11/11 | 20.0s / 2.9s / 4.7s |
| test18 / split-check | PASS 18/18 / OK | 0.1s / 0.4s |
| test19 / test20 / feed-check | PASS 36/36 / 21/21 / OK | 7.7s / 18.7s / 1.0s |
| browser | PASS 37/37 | 62.6s |
| sw-consistency | PASS 35/35 | 94.0s |
| sw-upgrade | PASS 25/25 | 34.4s |
| **mobile-notes** | **PASS 224/224** | 56.7s |
| **course-seo** | **PASS 45/45** | 37.1s |

合计约 468 s（不含语法检查）。语法检查 22 个 JS + 13 个 Python 文件全部 OK。

---

## 3. 本地全量测试结果

工作区（Windows，`PW_CHANNEL=chrome`）：

| 命令 | 结果 |
|---|---|
| `python scripts/run_tests.py` | **PASS 23 / FAIL 0 / SKIP 0 / BLOCKED 0**（连续两次） |
| `node tests/browser/mobile-notes.spec.js` | 224/224 |
| `node tests/browser/course-seo.spec.js` | 45/45 |
| `node tests/browser/article-ui.spec.js`（既有独立用例） | 16/16 |

已知噪声：Batch 7A 期间一次全量运行中 `sw-consistency` T2 在机器有其他浏览器进程时测到 976 ms（断言 <600 ms）而 FAIL；同机单独复跑 243 ms PASS，随后全量复跑全绿。本轮专项统计见 §7。

---

## 4. Linux CI 真实执行结果

推送：`git push -u origin feature/batch7-improvements`（普通推送，无 force；未改 `main`、无部署提交、未合并）。

| 项 | 值 |
|---|---|
| Workflow | `tests`（`.github/workflows/tests.yml`） |
| Run ID | **41775852450** |
| Run URL | https://github.com/EricZhao666/blog/actions/runs/41775852450 |
| 事件 / 分支 | `push` / `feature/batch7-improvements` |
| Commit SHA | `d5c2b1add3815b733dbb3845a7d1e6b75972e560` |
| 状态 / 结论 | `completed` / **`success`**（attempt 1） |
| 耗时 | 04:52:59Z → 04:57:19Z（约 4 分 20 秒） |
| Job | `node-22 / python-3.12` → `success` |

Job 内步骤（来自 `GET /repos/.../actions/runs/41775852450/jobs`，非仅凭徽章）：

| # | 步骤 | 结论 |
|---|---|---|
| 1 | Set up job | success |
| 2 | 检出代码 | success |
| 3 | 安装 Node.js 22 | success |
| 4 | 安装 Python 3.12 | success |
| 5 | 安装依赖（`npm ci`） | success |
| 6 | 安装 Chromium（`npx playwright install --with-deps chromium`） | success |
| 7 | 运行时版本 | success |
| 8 | **运行测试**（`python scripts/run_tests.py ...`） | **success** |
| 9 | **上传测试报告**（`test-report`） | **success** |

Artifact：`test-report`，1 230 426 字节，未过期（ID 13296937206）。

浏览器测试**确实执行**的证据链（日志与 artifact 内容需要仓库权限，未获取，见 §14）：

1. `scripts/run_tests.py` 对 browser 套件把退出码 2 判定为 BLOCKED → `ok=False` → 汇总 FAIL → 进程退出码 1；`tests.yml` 对非 0 退出码即失败。步骤 8 为 success ⇒ 5 个 browser 套件（browser / sw-consistency / sw-upgrade / mobile-notes / course-seo）全部 exit 0，且 spec 只有在 `fail === 0` 时才返回 0。
2. 步骤 6 `playwright install --with-deps chromium` success，说明 CI 上确有匹配 Chromium。
3. Artifact 体积对照：本地 `tests/reports`（0.03 MB）+ `tests/browser/artifacts`（1.17 MB，含 17 张 PNG）= 1.20 MB，CI 为 1.23 MB，量级一致；纯 markdown/JSON 报告不可能达到该体积。

未解释的失败套件：**无**。

---

## 5. 移动端导航专项（真实 Chromium）

在**隔离克隆**中执行，服务端把仓库挂到 `/blog/` 子路径，`serviceWorkers: 'block'`，非 `127.0.0.1` 请求一律 204（隔离 giscus 等第三方）。

### 5.1 既有用例 `tests/browser/mobile-notes.spec.js`：224/224 PASS

覆盖 375×812 / 390×844 / 768×1024 / 1280×800，静态笔记首页 + 普通笔记 + 长文笔记（`mech7010.html`）与主站 SPA：

1. 首次加载（新 context、无 referrer、无历史）。
2. 点击展开 / 收起。
3. Escape 关闭并把焦点还给按钮。
4. Tab 可达、`:focus-visible` 轮廓 2px、Enter / Space 切换。
5. 768→769 断点复位；主站 375↔1280 双向复位。
6. 路由切换时菜单复位（静态页 → `#/courses`；SPA 内部路由）。
7. 点击正文区域收起。
8. 深色模式（`rgb(26,29,35)`）与主题切换按钮。
9. 静态笔记首页与全部 14 篇笔记（长文页自动取最大文件）。
10. 无横向溢出（`scrollWidth - innerWidth = 0`，展开后仍为 0）。
11. console.error / pageerror 全空。

### 5.2 跨断点复位竞态专项（一次性探针，9/9 PASS）

针对本轮新增的复位逻辑做压力验证（Chromium 156，仓库真实产物）：

| 场景 | 结果 |
|---|---|
| 静态页：展开动画途中立刻放大到 1280，再缩回 375，重复 10 轮 | 10/10 全部复位（`open=false`、`aria-expanded=false`、导航不可见、`overflowX=0`） |
| 静态页：12 次极速 375↔1280 抖动（无等待） | 抖动后处于收起态；随后菜单仍可正常展开；无横向溢出 |
| SPA：同样 10 轮「展开→放大→缩回」 | 10/10 复位 |
| SPA：展开菜单后同时切路由 + 放大 + 缩回 | 最终 `open=false`、`aria-expanded=false` |
| 以上场景 console 异常 | 0 |

结论：`matchMedia('change')` 与 `resize` 双通道触发 `setOpen(false)` / `setMobileMenu(false)` 是幂等操作，**未观察到竞态**；无需修改代码。

---

## 6. SEO 元数据专项（场景 A–H，29/29 PASS）

独立探针在克隆中运行（真实 HTTP + 真实 Chromium；`note-slugs.js` 通过路由延迟/中断注入故障）：

| 场景 | 断言 | 结果 |
|---|---|---|
| A 首次直达有静态笔记的课程（CS422） | canonical=`/blog/notes/cs422.html`、og:url 一致、canonical 唯一、title/og:title/description/og:description 齐全 | PASS |
| B 首次直达无静态笔记的课程（EE413） | canonical 回退站点根、标题仍为课程标题、canonical 唯一 | PASS |
| C `note-slugs.js` 延迟 2.5 s | 中间态为站点根；到位后 canonical/og:url 正确；唯一 | PASS |
| D `note-slugs.js` 加载失败 | 回退站点根、不产生假静态页 URL、标题仍为课程标题 | PASS |
| E A 未完成时切到 B | 最终属于 B、未被 A 的旧回调覆盖 | PASS |
| F 加载期间切到首页 | canonical 与标题回到首页语义、canonical 唯一 | PASS |
| G 课程详情刷新 | canonical 仍正确、未重复插入、og:url 同步 | PASS |
| H 静态笔记 HTML 独立访问（不执行 JS） | canonical 自指、og:url 自指、含 JSON-LD、canonical 仅 1 次 | PASS |

原有 45 项 `course-seo` 断言全部保留并通过（克隆与 CI 均 45/45），未删除或放宽。

---

## 7. SW T2 稳定性统计

对象：`tests/browser/sw-consistency.spec.js` 的 T2（"有缓存 + 发布新版本 + 800 ms 慢链路"，断言 `elapsedMs < 600`，对应"远快于 800 ms 网络")。

方法：干净克隆、顺序执行、无其他浏览器测试并行；每次运行**完整 spec**（35 项），仅提取 T2 的 `elapsedMs`。

| 轮次 | T2 耗时 | 整轮结论 |
|---|---|---|
| 1 | 218 ms | 35/35 PASS |
| 2 | 205 ms | 35/35 PASS |
| 3 | 205 ms | 35/35 PASS |
| 4 | 215 ms | 35/35 PASS |
| 5 | 217 ms | 35/35 PASS |
| 6 | 214 ms | 35/35 PASS |
| 7 | 218 ms | 35/35 PASS |
| 8 | 212 ms | 35/35 PASS |
| 9 | 205 ms | 35/35 PASS |
| 10 | 213 ms | 35/35 PASS |

统计：min **205 ms**、median **213.5 ms**、p90 **218 ms**、max **218 ms**；10/10 PASS，全部低于阈值 600 ms（约为阈值的 34–36%）。

环境负载：开始 CPU 8% / 可用内存 2845 MB，结束 CPU 22% / 可用内存 2892 MB；无并行浏览器任务，SW 状态每轮由用例自身 `reset()` 重建。

归因：

| 可能原因 | 判定 | 依据 |
|---|---|---|
| 产品真实性能退化 | 否 | 10 轮稳定在 205–218 ms，与 Batch 6 基线同量级；同分支代码仅增加菜单与元数据逻辑，未改 SW 缓存策略 |
| CI Runner 性能波动 | 是（历史 976 ms 的来源） | 该次失败发生时本机同时运行其他浏览器进程；单独复跑 243 ms |
| 测试计时方式不合理 | 部分（边界敏感但可用） | 计时覆盖 `page.reload()` 全链路（HTML+CSS+JS+首屏渲染）；600 ms 阈值对 205–243 ms 的真实值有约 2.5× 余量，仅在高负载下才会触碰 |
| 浏览器/SW 启动开销 | 否 | 每轮均为已受控的 SW + 已预热缓存，未观察到首轮偏慢 |

处置：**未修改阈值、未改用例、未加重试**。T2 保持原行为约束；若 CI 未来偶发失败，应先读日志中的实测毫秒数并按负载解释，而不是放宽断言。

---

## 8. 生成器与数据完整性

在克隆中执行 `node gen_notes_pages.js --out-dir <tmp> --now 2026-10-22` 后逐文件 SHA256 比对：

| 检查 | 结果 |
|---|---|
| 静态笔记 HTML | 15 个，差异数 **0** |
| `sitemap.xml` | 差异数 0（lastmod 仍为 2026-10-22） |
| `js/note-slugs.js` | 差异数 0 |
| 生成文件数 | 17（15 页 + sitemap + 映射） |
| 与基线 `303d99e` 的差异 | `data/`、`feed.xml`、`sitemap.xml`、`js/data.js`、`js/user-posts.js`、`js/note-slugs.js` **全部为 0 差异** |
| 文章 | `data/posts/*.md` = 18；`manifest.json` posts = 18，declared = 18，无"有文件无条目" |
| 搜索索引 | `data/search-index.json` 顶层 18 条，与 18 篇文章一一对应 |
| RSS | `feed-check`、`test13`（40/40）、`test20`（21/21）通过 |
| 人工描述 | `test12`（25/25）通过，代码库描述未被覆盖 |
| 额外生成文件进入 Git | 无（`git status --porcelain` 为空；生成均在临时目录） |
| 无关文章日期 | 未变（`data/` 零差异） |

---

## 9. 修改文件清单

本轮**未修改任何产品代码、测试断言或生成器**：

| 文件 | 类型 | 说明 |
|---|---|---|
| `BATCH7A1_CI_VALIDATION.md` | 新增 | 本报告 |

一次性探针与统计日志全部位于 gitignore 目录（`tests/browser/artifacts/`、克隆目录 `%TEMP%\blog-b7a1`），未进入提交。

---

## 10. 发现的新问题与修复证据

| 编号 | 现象 | 根因 | 处置 | 证据 |
|---|---|---|---|---|
| P1 | T2 曾测到 976 ms（>600 ms） | 本机同时运行其他浏览器进程，Runner 负载导致的计时抖动 | 不改代码、不改阈值；10 轮统计 + 负载记录 | §7：10/10 PASS，205–218 ms |
| P2 | 无（竞态未复现） | — | — | §5.2：20 轮抖动/交错场景 9/9 PASS |
| P3 | 无（SEO 场景 A–H 全部符合预期） | — | — | §6：29/29 PASS |

未发现需要修复的产品缺陷；因此本轮不存在"修改后回归"的代码差异。

---

## 11. Git 与远端

| 项 | 值 |
|---|---|
| 远端分支 | `origin/feature/batch7-improvements`（首次推送创建，未 force） |
| 推送内容 | `182e7fe`、`a6a97b6`、`4ca99dd`、`5cf415a`、`d5c2b1a` |
| CI Run（代码提交） | 41775852450 @ `d5c2b1a` → success |
| CI Run（本报告提交） | 见 GitHub 最新一次 `tests` 运行（仅新增 markdown，不含代码/测试变更） |
| `main` | 未改动，仍为 `303d99e` |
| PR 链接 | https://github.com/EricZhao666/blog/pull/new/feature/batch7-improvements |

验收对照：

| 条件 | 结果 |
|---|---|
| 23 套回归全部 PASS（本地 + 克隆） | 是 |
| mobile-notes 全部 PASS | 是（224/224） |
| course-seo 全部 PASS | 是（45/45，另加 29 项 A–H 专项） |
| Chromium 浏览器测试实际运行 | 是（本机 + 克隆 + CI 步骤链证据） |
| SW 测试无未解释失败 | 是（T2 波动已解释并统计） |
| 生成器数据一致 | 是（差异 0） |
| Linux CI success | 是（41775852450） |
| 敏感文件泄露 | 无（未读取/输出任何 Token；`.gitignore` 覆盖报告与 artifact） |
| 工作区干净 | 是 |
| 改动仅在特性分支 | 是 |

---

## 12. 回滚方法

```bash
# 1) 只删除远端特性分支（未合并，安全）
git push origin --delete feature/batch7-improvements

# 2) 本地回到基线
git checkout main && git branch -D feature/batch7-improvements

# 3) 如需保留分支但回退 Batch 7A 代码
git revert 4ca99dd 182e7fe
```

CI 侧无需清理：workflow 无写权限（`permissions: contents: read`），不产生提交与部署。

---

## 13. PR 建议

标题：

```
Batch 7A：修复静态笔记移动端导航与课程页 SEO 元数据
```

正文：

```markdown
## 背景
- notes/*.html 在 ≤768px 没有菜单入口：CSS 把 .nav 藏起来，但生成器既没有输出
  .menu-toggle，也没有展开/收起脚本。
- 冷启动直接访问 #/course/:id 时 canonical / og:url 一直停在站点根：router 在
  note-slugs.js 到位前就调用 updateMetaForRoute()，其回调只重渲染正文。

## 改动
- gen_notes_pages.js：15 个静态页补菜单按钮（aria-expanded/aria-controls）与展开、收起、
  Esc、点击外部关闭、断点复位脚本；产物用 --now 2026-10-22 重新生成。
- css/style.css：移动端 .nav 限高 + 自身滚动，避免盖满整屏。
- js/app.js：课程异步回调在 _routeToken / location.hash 校验后重算 title、description、
  canonical、og:*；菜单状态抽成 setMobileMenu，支持 Esc 与跨断点复位。
- index.html / sw.js：aria 补齐；CACHE_VERSION → 2026-10-30-1（同一未发布变更集）。
- 新增 tests/browser/mobile-notes.spec.js（224 项）与 course-seo.spec.js（45 项），
  接入 scripts/run_tests.py 与 npm run test:browser。

## 验证
- 本地与独立克隆（npm ci + Playwright Chromium）：23 套全通过，0 失败 0 阻塞。
- 修复前对照（git archive 303d99e）：移动端 155 项 48 失败；SEO 45 项 7 失败。
- 竞态专项 9/9、SEO A–H 专项 29/29、T2 连跑 10 次 205–218 ms。
- 静态产物：sitemap / note-slugs / feed / 文章数据与基线零差异；重新生成逐字节一致。
- GitHub Actions `tests` #41775852450（Linux, Node 22, Chromium）：success。

## 边界
- SPA 元数据由 JS 写入，仅对执行 JS 的爬虫有效；可收录入口仍是 notes/*.html 的静态元数据。
- 31 门无笔记课程仍回退站点根 canonical（既定规则）。
```

---

## 14. 未验证项与剩余风险

1. **CI 日志与 artifact 内容不可读**：`GET /actions/jobs/{id}/logs` 返回 403（需 admin），artifact zip 返回 401（需认证）。本报告用"步骤 success + run_tests 退出码语义 + artifact 体积对照"作为真实执行的证据链，未声称读取过 CI 日志。
2. **Firefox / WebKit 未验证**（UNVERIFIED）：本轮只跑 Chromium（与 CI 一致），跨浏览器归 Batch 7D。
3. **CI 环境差异**：本机 Node 24 vs CI Node 22；本机通道为 `chrome`，CI 为 Playwright `chromium`，两者版本号接近（156.0.8078.74 / 156.0.8078.4）。
4. **T2 仍属时序敏感断言**：阈值未放宽，高负载 Runner 上仍可能偶发失败；届时需人工按 §7 的方法判定，不能直接调阈值。
5. **移动菜单仍是下拉覆盖层**：展开时覆盖正文顶部约 210 px，已用限高/外点/Esc/链接跳转关闭收敛。
