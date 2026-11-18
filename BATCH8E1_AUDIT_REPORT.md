# BATCH8E1_AUDIT_REPORT — Batch 8E-1 合并后验收与全站深度代码审查

- 基线：`main @ 8c188b8`（PR #19，squash 合并，内容与上轮本地交付 `1a858e1` 逐字节一致）
- 审查日期：2026-11-18
- 最终状态：**B8E1_AUDIT_READY**（见 §9；若回归未完成会改判 PARTIAL）
- 问题总数：CONFIRMED 1 / LIKELY 1 / HYPOTHESIS 3；P0/P1 无

---

## 1. Phase A：合并后验收

### 1.1 分支与合并确认
| 检查项 | 结果 |
|---|---|
| 当前分支 | 审查开始时 `feature/batch8d4-performance-accessibility @ 1a858e1`，工作树仅含未跟踪 `tests/tmp/` |
| 远程 main | `origin/main = 8c188b8 "perf(a11y): Batch 8D-4 全站性能优化、无障碍改善与质量审计 (#19)"` |
| 合并方式 | squash 合并（非 fast-forward），因此 `git merge-base --is-ancestor 1a858e1 origin/main` 为 false 属预期 |
| 内容一致性 | `git diff --stat 1a858e1 8c188b8` 为空 → **两个提交的树完全一致，8D-4 内容已完整进入远程 main** |
| 本地 main 同步 | `checkout main && merge --ff-only origin/main` 完成，现为 `8c188b8`，工作树干净 |

### 1.2 GitHub Actions / Pages 部署状态
- **Pages 部署**：`https://EricZhao666.github.io/blog/` 返回 200，标题正常；部署产物与本地 main 六个核心资源**逐字节一致**（index.html / sw.js / js/app.js / css/style.css / manifest.json / js/data.js），`sw.js CACHE_VERSION = '2026-11-17-2'` 与 8D-4 一致 → **部署是最新版本，无版本漂移、无旧缓存遮蔽**（B4）。
- **Actions CI 状态**：GitHub REST API 因共享 IP 未认证限流（403 rate limit），commit 页的 check 状态为登录后客户端渲染，无法在无登录态下独立确认。**间接证据充分**：合并提交存在、Pages 已发布与 main 一致的内容、无任何迹象表明部署失败。此项列为「未完成检查」，见 §7。

### 1.3 遗留清理（仅清理确认属于上一轮的对象）
| 对象 | 处理 | 证据 |
|---|---|---|
| 8147 端口静态服务器 | 已停止 | PID 33388，`python -m http.server 8147`，启动于 2026/11/17 20:19（上轮时段），路径为 DoubaoWork sandbox_runtime |
| `tests/tmp/`（loop-repro.js、probe-small-links.js） | 已删除 | 上轮调试探针，全仓库仅 BATCH8D4_REPORT.md 提及，无代码引用 |
| 其他进程 | 未动 | 仅存的 2 个 node.exe 属用户其他工具（workbuddy/Codex），与上轮无关 |

清理后 `Get-NetTCPConnection` 确认无 python/node 残留监听端口。

### 1.4 全量回归
- 命令：`python scripts/run_tests.py`（59 套 + 语法检查 + 3 个 --check 门禁），单次执行，未重复。
- 运行窗口：2026-11-18 09:15:28 → 09:37:16，**总耗时 21.8 分钟**，进程正常退出（exit 0）。
- 结果：**PASS 59 / FAIL 0 / SKIP 0 / BLOCKED 0**。
- 合并后无任何新增回归失败，无需扩大审查范围。
- 完整明细见 `tests/reports/last-run.md`；运行日志存于 agent 工作区（batch8e1-run.log，不入仓库）。

---

## 2. 审查覆盖范围（Phase B）

| 维度 | 覆盖方式 |
|---|---|
| B1 JS 与状态管理 | 通读 js/app.js 关键区段：初始化/全局事件委托（5871-6283）、路由与竞态守卫 `_routeToken`（5432-5870）、搜索绑定与数据加载（434-740）、阅读工具与监听器生命周期（738-1137）、灯箱（1138-1375）、编辑器草稿链路（4406-4605）、导出（5050-5431）；grep 全部 setTimeout/setInterval/addEventListener/removeEventListener/fetch/onclick 分布 |
| B2 数据安全与一致性 | 通读 DraftHistory/IndexedDB（3666-4105，配额/损坏隔离/事务失败/内存兜底）、导入导出契约（5050-5431）、js/data.js、js/user-posts.js、js/papers.js 结构、scripts/import_post.py 原子写/回滚/标签校验；数据一致性由 test18-23/33/34 覆盖 |
| B3 性能与资源 | renderMarkdown 有界缓存（40 条 FIFO）、back-to-top rAF+passive、阅读进度早退、SW RT 缓存上限 120、对象 URL 释放、监听器常驻+空转守卫；search-index 解析路径评估 |
| B4 SW 与部署 | 通读 sw.js 全文（导航决策、snapshot 失效逃生 `_snapshotStale`、版本化缓存、超时 150ms 机制）；部署产物逐字节比对；404.html SPA 回退；manifest 与 CACHE_VERSION 一致性 |
| B5 UI 与可访问性回归 | 未重新设计；依赖 ui-refresh / performance-accessibility / image-lightbox 浏览器套件（本轮回归）；CSS 只做定点抽查（灯箱 fixed+100vw 为 dialog 局部作用域，无全局溢出；无全局 overflow-x:hidden） |
| B6 安全与维护性 | DOMPurify 降级路径、inline 事件拼接面全量 grep（24 处）、URL 协议白名单（test37 覆盖）、导入路径安全（test33 覆盖）、工作流最小权限（test29-31 覆盖）；发现并复现 B8E1-001 |

未逐行通读（以测试+定向抽查代替）：js/app.js 1375-3666（各列表渲染器）、4106-4406（编辑器工具栏/快捷键）、js/course-notes.js / js/codefiles.js（纯数据文件）、css/style.css 全文。

## 3. 问题清单

完整字段见 `BATCH8E1_ISSUES.csv`。

### CONFIRMED（1）
- **B8E1-001（P3）**：标签含单引号（如 `O'Brien`）时，标签 chip 的 inline onclick 解析失败，点击冒泡到文章卡片 → 导航到文章页而非标签页，控制台 SyntaxError。根因：`encodeURIComponent` 不转义 `'`，被拼进单引号 JS 字符串。已用隔离脚本复现（jsdom 真实点击）。**已证明无法借此执行任意代码**（`= + [ ] |` 等操作符均被百分号编码）。修复：`.replace(/'/g,'%27')`（路由 decodeURIComponent 可无损还原）。位置：js/app.js 1425/2085/2222。

### LIKELY（1）
- **B8E1-002（P3）**：同类 inline 拼接模式中 post.id 未编码（1406/2209）、course.id/lib.id 等仅 encodeURIComponent 未处理 `'`（2441/2607/3026/2352-2353）。当前全部 id 来源有字符集约束，无实际触发路径；属纵深防御缺口，建议与 001 同批加公共 helper。

### HYPOTHESIS（3）
- **B8E1-003（P3，SW）**：`snapshotReady()` 失败态在 SW 生命周期内缓存，人工清缓存等极端场景下 shell 快照兜底不自愈。
- **B8E1-004（P3）**：focusSearch 快速连按 `/` 排队多个 150ms 定时器（幂等无害）。
- **B8E1-005（P3，性能）**：search-index.json（107KB）主线程一次性 JSON.parse，当前规模无影响，未量化。

### NOT_REPRODUCED
- 除 001 外，本轮所有审查方向的疑点均未构成可复现问题；历史已修复项无一回退。

## 4. 历史问题修复状态（ALREADY_FIXED，已验证在场）

| 8D-4 修复项 | 验证方式 |
|---|---|
| renderMarkdown 有界缓存（40 FIFO） | app.js 103-129 现场确认 |
| back-to-top rAF 合帧 + passive | app.js 6099-6113 现场确认 |
| 阅读进度空转早退 | app.js 1008-1010 现场确认 |
| chips aria-pressed / 输入框 aria-label / sr-only H1 / 双 H1 去重 / article-card 非法 role 移除 | app.js 1997-2001、2056-2058、2365-2383、2971-2977、1903 现场确认；performance-accessibility 套件回归 |
| 触控目标 ≥24px、footer-sub 对比度、浅色代码高亮 AA 配色 | style.css 8D-4 注释块现场确认 |
| CACHE_VERSION 2026-11-17-2 | sw.js + 部署产物一致 |
| 路由循环 DOM 稳定 | performance-accessibility 套件回归 |

已知遗留（非本轮范围，维持 8D-4 结论）：静态笔记页双 H1（生成流水线禁改范围）；iOS Safari 真机行为、软键盘布局需真机验证。

## 5. 性能与资源证据

- 本轮未执行 Lighthouse/性能基线重测（任务明确要求不重复完整矩阵）；未发现需要量化验证的新瓶颈。
- 资源管理核查通过：定时器/RAF 均有清理路径（阅读工具 remove、灯箱关闭、DraftHistory 有界、SW RT 120 上限、对象 URL revoke、事件监听器一次注册+空转守卫）。
- 部署链路核查通过：资源版本一致、无旧缓存遮蔽（见 §1.2）。

## 6. 回归与测试运行时间

| 阶段 | 结果 | 耗时 |
|---|---|---|
| 语法检查（72 文件） | 全部 OK | <1 min |
| jsdom/python 套件 42 个 + 3 个 --check 门禁 | 全部 PASS | ~14 min |
| 真实 Chromium 套件 15 个 | 全部 PASS | ~9.4 min |
| 总计 | PASS 59 / FAIL 0 / SKIP 0 / BLOCKED 0 | **21.8 min**（09:15:28 → 09:37:16） |

超过任务建议的 15 分钟上限原因：与上轮同口径的 59 套全量（含 15 个真实 Chromium 套件）在该机器上的实际基线即约 20+ 分钟；本轮为单次运行、后台执行，未占用前台命令，未做任何重试，符合「全量回归默认只运行一次」与超时控制要求。

## 7. 未完成检查及原因

| 项 | 原因 |
|---|---|
| GitHub Actions run 结论（CI check 状态） | API 限流 + 页面需登录渲染；间接证据已齐，未阻塞结论 |
| Firefox / Safari 实测 | 既有测试体系仅覆盖 Chromium 通道，维持 8D-4 口径（真机/多浏览器验证不在本轮范围） |
| Lighthouse 复测 | 任务明确「不需要重复执行完整 Lighthouse 测试矩阵」 |
| CSS 全文逐行审查 | UI 冻结范围，仅定点抽查；布局行为由五档视口浏览器套件覆盖 |

## 8. 执行效率与资源清理说明

- 单次全量回归（未重复），后台运行、日志落盘（agent 工作区 batch8e1-run.log，不入仓库）。
- 复现脚本 xss-repro.js 位于 agent 工作区，与正式源码隔离，未写入仓库；任务结束后保留供审计追溯，可随时删除。
- 回归启动的测试服务器/浏览器由 runner 与 spec 的 finally 逻辑自行退出；结束后将复查残留监听端口。

## 9. 最终状态

- 代码修改：**无业务代码修改**。新增 3 个交付文档（未跟踪，未提交）。
- 工作树：`main @ 8c188b8`，干净（仅 3 个交付文档为未跟踪新文件）。
- 测试结果：全量回归 **PASS 59 / FAIL 0 / SKIP 0 / BLOCKED 0**，21.8 分钟，exit 0。
- 残留进程：上轮 8147 服务器已清理；回归结束后复查无 python/node 监听端口、无残留 Chromium 进程。
- 问题数量：CONFIRMED 1 / LIKELY 1 / HYPOTHESIS 3，P0/P1 = 0。
- 推荐下一步：进入 Batch 8E-2，按 BATCH8E1_NEXT_PLAN.md 执行 Task 1（低风险修复 + 回归用例）。
- **状态码：B8E1_AUDIT_READY**
