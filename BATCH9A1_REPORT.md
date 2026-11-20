# Batch 9A-1 报告：个人知识管理中心 MVP

> **修订（Batch 9A-1R）**：本轮修复了历史裁剪误删已完成/有进度记录、已有按钮跨标签不同步、
> 运行中降级提示、继续阅读恢复竞态、失效内容可点击等问题。最新数据契约、测试数字（20/27）
> 与剩余风险以 `BATCH9A1R_REPORT.md` 为准；下文保留 9A-1 首次交付时的记录。


- 状态：**B9A1_PR_READY**（本地专项、跨引擎与 66 套完整回归全部通过）
- 基线：`main = ca25043`（PR #27 已合并）
- 分支：`feat/batch9a1-knowledge-center`
- 版本：`CACHE_VERSION 2026-11-19-1 → 2026-11-20-1`
- 规划文档：5 份已于 `docs: define Batch 9 product plan and knowledge architecture` 单独提交

## 1. 实现功能清单

| 编号 | 功能 | 状态 |
| --- | --- | --- |
| FR-1 | 收藏 / 取消收藏（文章、课程、论文、资料） | 完成 |
| FR-2 | 待读 / 移出待读（同上） | 完成 |
| FR-3 | 浏览历史自动记录（30s 去重、上限 500、保护规则） | 完成 |
| FR-4 | 阅读进度持久化（5s 节流 + 路由切换/隐藏时落盘）与继续阅读 | 完成 |
| FR-5 | `#/knowledge` 四个 tab + 统计 + 空状态 + 内容缺失提示 | 完成 |
| FR-6 | 详情页操作条、卡片/搜索结果个人操作、键盘 `f`/`r` | 完成 |
| FR-7 | JSON 导出（只导出，不导入） | 完成 |
| FR-8 | 存储降级与可见提示 | 完成 |
| FR-9 | 多标签同步（BroadcastChannel + storage 兜底） | 完成 |

未实现（按任务范围）：自定义分类、批量管理、导入、统计页、推荐、图谱、个性化首页、项目详情、交互演示、后端/账户/云同步。

## 2. 实际存储 schema

IndexedDB `blog-knowledge` v1，与 `blog-draft-history` 完全隔离：

```
records (keyPath: key)
  by_type(type) / by_fav(fav) / by_later(later) / by_lastSeen(lastSeenAt) / by_state(readState)
meta (keyPath: k)  → { k:'schemaVersion', v:1 }
```

记录字段：`key`（`type:refId`）、`type`、`refId`、`title`（快照，≤300 字符）、`fav`、`favAt`、`favCat`、
`later`、`laterAt`、`readState`、`progress`、`firstSeenAt`、`lastSeenAt`、`doneAt`、`updatedAt`。

- 课程 ID（中文/空格/`|`）原样保存在 `refId`，仅路由边界 `encodeURIComponent`；专项 T2/K8 覆盖。
- 记录总量上限 2000（超出不新增历史），历史条数上限 500，二者分别计数。

## 3. 路由与 UI 入口

| 项目 | 实现 |
| --- | --- |
| 路由 | `#/knowledge?tab=continue\|favorites\|readlater\|history`，非法 tab 回退 `continue` |
| 导航 | 顶部导航"归档"后新增"知识库"，`data-route="/knowledge"`，active 状态与 `aria-current` 复用现有规则 |
| 详情页 | 文章 `.article-detail-header`、课程 `.course-detail-header` 注入操作条（aria-pressed 同步） |
| 卡片/搜索 | 运行时增强现有 `[data-href]` 卡片与搜索结果，追加收藏/待读按钮；捕获阶段拦截，不触发卡片导航（K6/K7） |
| 知识页 | 统计行 + 四 tab + 分组列表；行内取消收藏/移出待读/删除历史/继续阅读 |
| 键盘 | 详情页 `f` 收藏、`r` 待读；tab 为标准链接，可 Tab/Enter 操作 |
| 主题/响应式 | 仅用现有令牌；390/768/1440 无横向溢出；深色主题 K11 覆盖 |

## 4. 并发一致性证据

- 真实 IDB 写入在**同一 readwrite 事务**内完成 get → 字段合并 → put（`createIdbBackend().mutate`），不存在"读旧对象后整体覆盖"。
- 专项 T4：`setFlag(fav)` 与 `saveProgress(0.42)` 并发后两字段同时保留（`fav=1, progress=0.42`）。
- 专项 T12：A 标签写入后，B 标签收到 BroadcastChannel 通知并读到最新记录（`notified=1, seen=1`）。
- 浏览器 K10：两个标签页同时打开，A 收藏后 B 的列表从 2 条变为 3 条（1.2s 内）。
- 通知只在提交成功后发出；`storage` 兜底不可用时仅影响跨标签刷新，不影响数据库操作（T14 只新增 ping 键）。

## 5. 导出格式

```json
{
  "app": "ericzhao-blog",
  "kind": "knowledge",
  "schemaVersion": 1,
  "exportedAt": "2026-11-20T10:00:00.000Z",
  "records": [ { "key": "post:vla-model-intro", "type": "post", "...": "..." } ]
}
```

- 只含个人知识记录；不含草稿、编辑器历史、Token、主题或其他站点数据（T11/K9 校验字段集合）。
- 仅在用户点击"导出 JSON"时生成，不上传。

## 6. 降级行为

| 场景 | 实现 | 验证 |
| --- | --- | --- |
| IndexedDB 不存在/被禁用 | 内存后端 + 顶部 `.km-banner` 常驻提示 | K12、T1 |
| 写入事务失败 | 切内存后端 + 提示，不向用户宣称已保存 | T10 |
| 配额不足 | 按保护规则裁剪一次后重试一次；仍失败则降级内存 | T9 |
| 数据库打开失败/blocked | 降级内存并记录原因 | 代码路径 + T1 |
| localStorage/BroadcastChannel 不可用 | 静默降级，仅本标签生效 | T14、代码路径 |
| 内容已删除/改名 | 标题快照 + "内容已删除或迁移"占位（记录缺失时列表仍可渲染） | 渲染分支 |
| 记录数/历史超限 | 上限内拒绝新增 / 仅清历史字段，保护收藏、待读、阅读中 | T7、T8、T15 |

不清空整个数据库做恢复；不修改 `blog_draft*` 与 `blog-draft-history`（T14）。

## 7. SW 与离线版本

- `js/knowledge.js` 进入 `index.html`（app.js 之前）、`REQUIRED_ASSETS`、`FIRST_SCREEN_ASSETS`；不重复加入其他预缓存列表。
- 首屏资源由 5 项增至 **6 项**，必需资源由 6 项增至 **7 项**；`CACHE_VERSION = 2026-11-20-1`。
- 受资源清单影响的测试已同步：`sw-snapshot-unit`（清单 6 项、检查次数按实际条目数）、`sw-consistency`（首屏路径数组）、SW 合成站点夹具补充 `js/knowledge.js` 占位（否则 REQUIRED 资源缺失会让一致性套件 12 项连锁失败——本轮已实际发生并修复）。
- 新版本安装失败回退、多标签、免混部仍由 `sw` 分组覆盖（4/4 PASS）。
- SW 不管理 IndexedDB；升级不删除 `blog-knowledge`。K13 验证离线可读取个人记录；不承诺收藏目标内容本身已缓存（App Shell 与按需数据仍按既有策略）。

## 8. 与规划的调整（依据）

1. 卡片/搜索入口采用**运行时增强**而非修改 4 处渲染模板：不动既有渲染契约，仍满足"卡片/搜索结果有个人入口"，并天然覆盖后续新增卡片。
2. Tab 首项设为"继续阅读"（UI 规划示例把收藏放在首位）：MVP 任务书与用户流程都以"继续上次阅读"为最高频动作，收藏仍在第二个 tab。
3. 论文/资料通过搜索结果行与知识页操作，不新增详情页（现有产品无独立论文详情路由）。
4. `lib/project/note` 仅数据层支持，UI 入口留待 9A-2；静态笔记页不批量修改（无共享运行时）。
5. 导入、分类、批量未实现，数据模型已预留（`favCat`、通用 `key`）。

## 9. 测试结果

| 项目 | 结果 |
| --- | --- |
| `knowledge-store`（新增，15 项） | **15/15 PASS** |
| `knowledge-center`（新增，21 项） | **21/21 PASS** |
| 跨引擎 K1（Chromium/Firefox/WebKit） | **12/12 PASS** |
| 离线 K2（三引擎） | **15/15 PASS** |
| `sw-snapshot-unit`（语义回归） | **15/15 PASS** |
| `--group sw`（4 套） | **4/4 PASS**（sw-consistency 37/37、sw-upgrade 25/25、browser 37/37、test7） |
| `--only ui-refresh image-lightbox` | **PASS**（ui-refresh 59/59） |
| 默认 66 套（`--workers 2`） | **66 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED** |

完整回归：wall **1000.4s**（测试阶段 994.1s），套件累计 1191.0s，实际并行重叠 196.9s，
`effective_workers=2`、13 组既有配对；新增两套未获并行许可，按串行执行。
`git diff --check` 退出码 0。

## 10. 跨浏览器覆盖与剩余限制

- 三引擎已验证：详情收藏、知识页列表、取消收藏、空状态、离线读写（K1/K2）。真实 IME 等既有范围限制不变。
- Playwright WebKit 不等于真实 Safari/iOS 设备验收。
- 未覆盖：真实移动端触控手势、Safari 专有样式、跨设备同步（本就不做）。
- 未覆盖：超大数据量（>2000 记录）长稳表现、浏览器强制终止页面时的进度丢失窗口（`pagehide` 不保证异步事务完成）。

### 10.1 范围与契约修订（9A-1R 核对）

| 项目 | 实际实现 |
| --- | --- |
| 浏览历史覆盖 | 文章、课程详情（成功渲染后写入）；论文/资料无独立详情页，不产生历史；`lib/project/note` 仅数据层支持，无 UI 入口 |
| 收藏 UI 覆盖 | 文章/课程详情操作条；首页卡片、搜索结果（文章/课程/论文/资料）；lib/project/note 无入口 |
| 历史上限 | 硬上限 500，仅统计历史记录；收藏/待读/阅读中/已完成/非零进度受保护，可能突破软上限（优先不丢数据） |
| 记录总量 2000 | 软阈值，只限制"自动新增历史"；显式收藏/待读不受限 |
| 双标签同步 | BroadcastChannel + storage 兜底；按钮与知识页均更新（K10/K15）；接收方重读数据库 |
| 降级可见性 | 知识页常驻横幅 + 保存时提示"仅本会话生效"；导出含 `persistence/degraded/complete` |
| 展示上限 | 继续阅读 6 条、浏览历史 100 条（与 MVP 约定一致） |

## 11. 耗时与积分

- 实际耗时：分支创建 09:14:36 → 本地验收完成 10:13，约 **59 分钟**（其中 66 套回归 16.7 分钟）。
- 工具调用约 **40 次**；平台未提供积分/token 计费口径，未编造数值。
- 测试耗时：单元 <1s；浏览器专项约 45s；K1/K2 合计约 40s；SW 分组 211s；完整 66 套 1000.4s。

## 12. 复现命令

```powershell
node tests/test51_knowledge_store.js
node tests/browser/knowledge-center.spec.js
node tests/browser/cross-browser.spec.js --engines=chromium,firefox,webkit --scenario=K1
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit --scenario=K2
node tests/browser/sw-snapshot-unit.spec.js
python scripts/run_tests.py --group sw
python scripts/run_tests.py --workers 2
```
