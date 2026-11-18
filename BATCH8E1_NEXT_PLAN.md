# Batch 8E-2 修复计划（BATCH8E1_NEXT_PLAN）

> 依据：BATCH8E1_AUDIT_REPORT.md 与 BATCH8E1_ISSUES.csv。
> 原则：只修本轮审计确认的问题，不混入无关方向；先低风险独立修复，再评估低价值项。

## 修复任务（按依赖与影响排序）

### Task 1：inline 事件处理单引号转义（B8E1-001 + B8E1-002 合并修复）
- **内容**：
  1. 在 js/app.js 增加公共 helper：`function jsInline(value){ return encodeURIComponent(String(value)).replace(/'/g,'%27'); }`（或等价内联写法）。
  2. 替换三处标签 chip（renderHome ~1425、renderPostView ~2085、renderTags ~2222）与卡片 id 类拼接（1406/2209/2352-2353/2441/2607/3026 等所有 inline handler 中的动态值），统一走 helper。
  3. 新增 jsdom 回归用例（如 tests/test46_inline_handlers.js）：标签含 `O'Brien` 时点击 chip 导航至 `#/tags/O'Brien` 且无 SyntaxError；含 `'` 的 tag 在标签页正确回显。
  4. 注册到 scripts/run_tests.py（59 → 60 套），跑全量回归。
- **禁止**：改动路由、稳定 ID、搜索评分、数据、导入脚本、SW、UI 样式。
- **验收**：新用例通过；全量回归 60 套 PASS；行为不变（正常标签导航与现有测试全部通过）。
- **风险**：低。%27 在标签路由的 decodeURIComponent 处还原，路由行为不变。
- **预估工作量**：小（~30 行 + 1 个测试套件）。

### Task 2：focusSearch 定时器句柄清理（B8E1-004，可选顺手项）
- **内容**：`_focusSearchTimer` 模块级变量，重排时 clearTimeout。
- **验收**：现有测试不回归；无新增测试要求。
- **风险**：极低。可与 Task 1 同 PR，但不阻塞 Task 1 独立交付。

### 明确不做（本轮范围外，记录备查）
- B8E1-003（sw.js snapshotReady 自愈）：留给后续 SW 版本迭代（如 CACHE_VERSION 升级时顺带），避免为极端人工清缓存场景改动已稳定的导航决策逻辑。
- B8E1-005（search-index 分片/流式解析）：当前数据规模下无量化收益，避免无意义微优化。
- 静态笔记页双 H1（8D-4 已知遗留）：仍属生成流水线禁止修改范围，维持 8D-4 结论。
- iOS Safari 真机、软键盘弹出布局：需真机验证，不属代码修复任务。

## 提交与发布节奏
- 按既有流程：独立分支 → 本地全量回归 → PR（squash）→ 合并后下一批验收。
- 本轮审计不承诺具体批次排期，Task 1/2 是否合入同一 PR 由 8E-2 执行时决定。
