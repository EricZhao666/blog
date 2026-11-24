# BATCH9B2_REPORT.md — Batch 9B-2：双向链接、反向索引与知识图谱

状态：**B9B2_PR_READY**（本地专项与定向回归全通过；完整 84 套交 PR CI；不自动合并、不部署）

分支：`feat/batch9b2-knowledge-graph`
基线：`main = 08aa7ba`（PR #37 squash 合并；任务书候选 HEAD 4b07a69 为分支 tip，以合并后实际 main 为准）。
基线核验：PR #37 页面 Merged + 3 checks passed（81 套 PR CI 通过）；线上 SW 实测
`CACHE_VERSION='2026-11-24-2'`（Pages 部署已生效）；main tests #148 核验时仍在运行（合并后重跑，如实记录，不等待）。

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `scripts/content_links.py` | 引用契约 Python 镜像 + 确定性索引生成（17.7KB） |
| `js/content-links.js` | 浏览器共享契约 + marked 扩展工厂（8.4KB，按需加载） |
| `js/knowledge-graph.js` | 图谱纯计算：模型/布局/筛选/一跳/裁剪（10.5KB，按需） |
| `js/graph-demo.js` | 原生 SVG 交互层：缩放/平移/触摸/键盘列表/清理（22.2KB，按需） |
| `data/content-links.json` | 构建期引用索引（76,230 B，确定性，无时间戳） |
| `tests/fixtures/wikilink-contract.json` | JS/Python 共享语法契约样例（32 例） |
| `tests/test59_content_links.js` | content-links 专项（97 项） |
| `tests/test60_knowledge_graph.js` | knowledge-graph 专项（39 项） |
| `tests/browser/graph-experience.spec.js` | graph-experience 浏览器专项（54 项，三引擎） |
| `scripts/eval_graph.js` | 性能评估脚本（生成 GRAPH_EVAL.csv，全部实测） |
| `CONTENT_LINK_FORMAT.md` / `KNOWLEDGE_GRAPH_SPEC.md` | 语法契约 / 图谱规格 |
| `BATCH9B2_TEST_MATRIX.csv` / `BATCH9B2_GRAPH_EVAL.csv` | 测试矩阵 / 性能实测 |

改动：`scripts/build_content.py`（索引接入 build_artifacts）、`js/app.js`（按需加载器/
WikiLink 注册/反向链接区/图谱路由/清理钩子/知识库入口）、`css/style.css`（9B-2 样式块）、
`sw.js`（CACHE_VERSION + OPTIONAL 4 项）、`scripts/run_tests.py`（注册 3 专项，81→84）。
**未改**：9B-1 推荐权重、个人知识库 schema、实验室数学、测试调度器、CI 默认命令、正式文章内容。

## 2. 真实数据规模（当前数据版本，如实记录）

- 节点 **195**：post 18 / course 45 / paper 32 / material 74 / lib 6 / project 6 / note 14。
  全部复用 `type:refId` 稳定键；note 节点仅纳入 NOTE_PAGES 真实静态页；示例项目保留 example 标记。
- 显式引用边 **6**（全部 post→lib，via=markdown）；同系列边 **4**（SLAM 技术系列 3 + 强化学习系列 1）；
  推断关联边 **514**（Related.recommend 全候选池，无向去重后）；未解析引用 **0**。
- 孤立节点 **183**（口径：无显式引用且无同系列；推断关联不计入孤立判定）。
- 覆盖率：显式引用源 5/18 篇文章（27.8%），目标 4/6 个代码库（66.7%）；同系列覆盖 5 篇文章。
  课程/论文/资料/项目/笔记当前无正文显式入边——**真实关联稀疏，如实记录，未编造任何链接**。
- 工程实验（lab）未纳入首版：无稳定内容 id 与明确关联依据（规格 §2 记录为可选扩展）。

## 3. 构建契约与索引一致性

- 索引由 `build_artifacts` 生成，自动进入 `diff_artifacts / write_artifacts / --check / --dry-run / --sync`
  与完整性门禁；`import_post` 复用同一 `build_artifacts`（持锁调用链，无嵌套锁）。
- **两次无变化构建**：`--sync` → `--check` OK → 再 `--sync` 写入 0 文件 → `--check` OK；索引字节级一致。
- 篡改索引后 `--check` 失败（专项 D7）；最小 fixture root（无课程等 JS）兼容（可选权威源存在性守卫）。
- BuildLock：占锁时 `--sync` 退出码 3、索引不被改动；释放后恢复且字节不变（D19–D20）。
  `build_artifacts` 本身无锁，临界区由 `--sync` / `import_post` 调用方保证（8E-3 契约不变）。
  逐文件原子替换，未宣称多文件事务。
- 确定性序列化：sort_keys + 紧凑分隔符 + LF + 无 BOM + 无时间戳。
- 全产物 `--sync` 实测 **1111ms**（含索引生成；Node 侧模型 91ms / 布局 1ms）。

## 4. WikiLink 语法契约（详见 CONTENT_LINK_FORMAT.md）

- v1 仅 `[[post:<id>]]` / `[[post:<id>|显示文本]]`；post id 不含竖线 → 第一个竖线无歧义。
  课程 id 含竖线，其他类型本轮不扩展，保留原文并记录 `unsupported-type` 诊断；扩展路径已文档化。
- 保护语义：围栏 / 行内代码 / 反斜杠转义 / HTML 标签 / 链接目标内不解析；链接文本内照常（与 marked 一致）。
- 构建索引与浏览器渲染共享 32 例 fixture，JS 与 Python 两侧逐例一致（专项 A/B 共 65 项）。
- 合法目标 → 真实站内链接；不存在 → `.wikilink-unresolved` 明确标注，不跳转、不自动建文章。
- 显示文本/标题一律转义；无 `javascript:` 通道；marked + DOMPurify 安全契约不变。
- 编辑器预览与正式文章共用同一 marked 扩展；预览不写正式索引（静态文件，网络层零写入）。
- 本轮未批量改写正式文章；验收用隔离 fixture（临时 root 导入 / HTTP 层 override）。

## 5. 反向链接与图谱

- 详情页「🔗 引用本文的内容」独立区（post/course/project），只展示 byTarget 真实显式引用，
  标注来源类型与 via；与相关阅读完全分离；无入边隐藏；索引缺失局部降级不阻塞正文（实测 R11/R12）。
- `#/graph`：类型/关系筛选、搜索定位（中文可用）、选中详情（标题/类型/示例标记/有效跳转/关系来源）、
  一跳局部、滚轮缩放、拖动平移、双指捏合、重置视图、键盘列表等价视图（↑/↓/Enter）、孤立节点半透明+徽标。
- 显式引用有向箭头；推断关联橙色虚线并标注「算法推荐，非正文引用」；同系列灰色实线独立说明。
- 默认可见边上限 300：只裁低分推断边（当前裁 224/514），真实关系永不隐藏，裁剪如实标注「依然存在」。
- 推断候选池固定为索引全部节点：同数据版本图谱确定，与用户浏览历史无关（专项 G29 字节级验证）。
- 布局确定性 O(N) 类型簇螺旋，无力导向迭代；rAF 仅拖动节流，路由退出即清理（R14 实测）。

## 6. 性能实测（BATCH9B2_GRAPH_EVAL.csv，不虚构改善）

| 指标 | 真实数据 | 合成 500 | 合成 1000 |
|---|---|---|---|
| 模型构建 | 91ms（Node）/ 76ms（浏览器） | 955ms | 3292ms |
| 布局 | 1ms | <1ms | 1ms |
| 边总数 | 524 | 1672 | 4243 |
| 可见边（cap 300） | 300 | 300 | 300 |

- 浏览器首次图谱加载（脚本+索引 fetch+挂载，本地服务器）：**436ms**。
- 索引体积 76,230 B；新增按需 JS 合计 ~41KB。
- **首页首屏零新增请求**（R15 实测：4 个图谱资源 hits 为 0）。
- 路由离开后画布移除、window 监听器卸载、rAF 取消（R14）；快速切换 6 次无串页无异常。

## 7. 安全与离线

- 节点标题/关系理由/显示文本/搜索文本按不可信数据处理（textContent/escapeHtml）；
  跳转白名单 `#/` 与 `notes/*.html`；XSS 夹具实测无注入（R9.4）。
- SW `CACHE_VERSION` → **2026-11-24-3**；OPTIONAL +4（content-links.js / knowledge-graph.js /
  graph-demo.js / data/content-links.json），随 warmOptionalAssets 预热；
  REQUIRED 8 / FIRST_SCREEN 7 不变，缓存策略不变，不清空 IndexedDB。
- 离线实测：在线访问后 4 资源入缓存；离线重载图谱完整渲染 195 节点（R13）。
- 索引/脚本缺失：明确降级提示，首页与正文不受影响（R12）。

## 8. 测试结果（实际）

- 注册 **81 → 84 套**（content-links / knowledge-graph / graph-experience）。
- 新专项：content-links **97/97**、knowledge-graph **39/39**、graph-experience **54/54**
  （Chromium + Firefox + WebKit 代表性场景，390/768 隐含于移动视口与 chips 断点、1440 桌面）。
- 定向回归 **21/21 PASS**（456s）：content-check / feed-check / split-check / test23 / test31 /
  build-lock / test7 / related-content / related-reading / knowledge-store / knowledge-center /
  knowledge-management / personalized-home / home-experience / editor-ux / test24 / ui-refresh /
  sw-consistency / browser / content-links / knowledge-graph。
- 过程中修复的真实集成问题（均已回归验证）：
  1. 最小 fixture root 缺课程等 JS → 可选权威源存在性守卫（test23/build-lock 恢复）；
  2. jsdom 无 fetch → 索引加载防御降级（test7/personalized-home 恢复）；
  3. HTML 标签保护误遮罩 href → 保护集合分层（契约 fixture 锁定）；
  4. assemble 投影不含 series → 从权威 metas 读取（系列边 0→4）。
- 本地不重复完整 84 套，**最终交 PR CI**；未改测试并行调度器与 CI 默认命令。

## 9. 剩余限制

- 真实显式引用稀疏（6 条），183 节点无真实关系；本轮不批量改写正式文章，关系数量以真实数据为准。
- WikiLink v1 仅 post；含竖线 id 的类型需先修订契约再扩展。
- 推断关联质量沿用 9B-1 上限，未调参；图谱不改变首页推荐与搜索排序。
- 合成 1000 节点模型 ~3.3s 为一次性同步计算（预算内），未做 Worker/增量优化。
- 768px 档未单列断言（chips 换行与 640/900 断点覆盖移动/桌面过渡）；如需可后补。

## 10. 提交

- 提交信息：`feat: Batch 9B-2 add backlinks and knowledge graph`
- 允许 push 并创建 PR；不自动合并、不部署。完成后停止，不进入 9C-2。