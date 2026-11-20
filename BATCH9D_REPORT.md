# Batch 9D 报告：工程项目展示中心与知识关联

- 状态：**B9D_PR_READY**（本地专项 + 三引擎 + 受影响回归全部通过；未合并、未部署）
- 基线：`main = 8be03fe`（PR #29 "Feat/batch9b1 related content" 已合并，CI tests #108 = 68 PASS）
- 分支：`feat/batch9d-project-portfolio`（创建于 `8be03fe`，2026-11-20 13:53:20 +0800）
- 版本：`CACHE_VERSION 2026-11-20-2 → 2026-11-20-3`；`REQUIRED_ASSETS` 8 项、`FIRST_SCREEN_ASSETS` 7 项**未变**
  （本轮没有新增首屏脚本，只改了 `app.js` / `projects.js` / `style.css` 的内容）
- 范围：项目详情页 + 列表增强 + 知识库/推荐接入；未做后台编辑器、云同步、知识图谱、筛选系统

## 1. 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `#/project/<id>`（新增） | 项目详情 | 直接访问 / 刷新 / 前进后退 / 收藏与待读 / 浏览历史 / 相关阅读 |
| `#/projects` | 项目作品集 | 保留原 6 张卡片布局，新增详情入口、示例徽标、收藏待读按钮 |

详情页结构（自上而下，**没有数据的区块不渲染**）：

```
状态徽标 · 年份 · 示例徽标
🦾 项目标题
[收藏] [待读]           ← 9A-1 的 km-actions，由 kmMount 注入
示例横幅（仅 example: true）
项目概述（description）
技术栈（tech）
功能亮点（示例项目标题后加"（示例文案，未经独立验证）"）
项目背景 / 目标 / 技术方案 / 关键做法 / 时间线 / 结果与指标 / 已知限制 / 参考   ← 可选
技术方向（tags → 可点进 #/tags/<tag>）
项目链接 / 公开仓库（仅 http(s) 且非 private）
🔗 相关阅读（3–5 条，带理由）
← 返回项目作品集
```

路由细节：

- 无效 ID → `renderProjectMissing()`：显示"没有找到这个项目：`<id>`" + 返回全部项目入口；
- `%E0%A4%A` 这类非法编码 → `decodeURIComponent` 失败被捕获，退化为同一未找到页，不抛 `Router error`；
- 导航高亮：`/project/` 与 `/projects` 共用"项目"入口的 `active` 状态；
- 文档标题：`<项目名>（示例项目） · Eric's Notebook`，无效 ID 为"项目未找到"。

## 2. 项目数据兼容性

| 项 | 结论 |
| --- | --- |
| 稳定 ID | 6 个全部保留，未改名、未改 URL 形态 |
| 原有字段 | `id/name/description/tech/tags/icon/link/status/year/highlights` 语义未变 |
| 新增字段 | 只新增 `example: true`（示例身份）与文件头的 `PROJECTS_EXAMPLE_NOTICE` 常量 |
| 可选字段 | `background/objectives/architecture/approach/timeline/results/limitations/references/repository/relatedKeys/visibility/example` 全部**支持但未填** |
| 渲染容错 | 任一可选字段缺失即整块跳过；`timeline` 元素缺 `time/text` 时该格为空；`references` 非 http(s) 降级为纯文本 |

**为什么没有给 6 个项目补背景/结果**：这些字段需要真实资料，凭空编写等于伪造项目经历。
本轮只把"能承载真实数据的结构"建好，并用一个**测试内注入的合成项目**（`zz-fixture-project`）
验证全部区块的渲染路径，真实内容留给项目所有者按 `PROJECT_DATA_GUIDE.md` 填入。

## 3. 示例与真实项目的区分（本轮重点）

| 位置 | 标记 |
| --- | --- |
| 列表页顶部 | `⚠️ 以下项目为示例数据……指标均为占位文案，未经独立验证` |
| 每张列表卡片 | 标题旁 `示例` 徽标 |
| 详情页头部 | `示例` 徽标（`project-demo-badge-lg`） |
| 详情页正文顶部 | `示例项目` 横幅 + 同一段说明 |
| 详情页亮点标题 | `功能亮点（示例文案，未经独立验证）` |
| 推荐卡片 | 候选为示例项目时追加 `示例` 徽标（`Related.recommend` 结果新增 `example` 字段） |
| 文档标题 | 追加"（示例项目）" |
| 离线评估 CSV | 新增 `cand_example` 列（`yes/no`） |

示例里的数字（`< 2mm`、`92%`、`99.2%`、`99.5%`、`< 15ms`、`两条产线`、`20+ 类工件`）**原样保留但全部被标注为未验证**，
既没有删除（会丢失原始占位信息），也没有升级成"成果"。真实项目对照见 `PROJECT_DATA_GUIDE.md` 第 3 节。

## 4. 知识库联动

| 环节 | 实现 |
| --- | --- |
| 详情操作条 | `kmMount()` 新增 `/project/<id>` 分支 → `Knowledge.recordView('project', id, {title})` + `kmInjectBar('project', ...)` |
| 收藏 / 待读 | 复用 `kmActionBarHtml`，无新按钮、无新事件；捕获阶段拦截保证不触发卡片导航 |
| 浏览历史 | 每次成功进入详情写入 `project:<id>`（与文章/课程同一套 500 条裁剪与保护规则） |
| 知识页 | `kmHrefFor('project')` 由 `#/projects` 改为 `#/project/<id>`；`kmParseHref`/`kmTitleOf`/`kmResolve` 增加 project 分支；类型标签显示"项目" |
| 回跳 | 知识页行内 `a.km-item-main` → 同一项目详情（实测 `#/project/slam-agv`） |
| 阅读进度 | **不写 progress**：项目不是长文阅读场景，不伪造百分比；因此不会出现在"继续阅读"tab，只出现在收藏/待读/历史 |
| Schema | 未修改。`Knowledge` 数据层的 `TYPES` 本就包含 `project`，`project:<id>` 沿用 `type:refId` |

文章/课程/论文/资料/代码库的个人数据行为未变（`knowledge-store` 25/25、`knowledge-center` 29/29 全通过）。

## 5. 推荐接入

改动（**权重、阈值、上限一个都没动**）：

1. `Related.hrefFor('project', id)` → `#/project/<id>`（此前返回空串，项目被排除在候选外）。
2. `LINK_PATTERNS` 增加 `#/project/<id>`，正文里写项目链接即可形成显式关联。
3. `buildIndex` / `recommend` 透传 `example`，UI 据此加"示例"徽标。
4. `relatedItems()` 纳入 `PROJECTS`：`tags` → 共同标签、`tech` → 技术栈重合、`description+highlights` → 内容桥接。
5. `relatedSourceText('project')` + `relatedExplicitKeys()`：项目的 `relatedKeys` 与文本内链一起作为显式关联。
6. 项目详情页复用 `relatedSlotHtml('project', id)` + `relatedApply(hash)`，无第二套渲染。

结果（`BATCH9D_PROJECT_RECOMMENDATION_EVAL.csv`，27 个源 = 18 文章 + 3 课程 + 6 项目，候选 181 条）：

| 方向 | 条数 | 说明 |
| --- | --- | --- |
| 文章 → 项目 | 16 | 例如 `vla-model-intro` → `vla-industrial`（共同标签 VLA/智能制造） |
| 项目 → 文章 | 18 | 每个项目 2–5 条，理由含"共同标签 / 技术栈重合 / 内容涉及" |
| 项目 → 项目 | 11 | 同技术方向，全部带 `示例` 徽标 |
| 项目 → 其他类型 | 1 | `vla-industrial` → 论文（具身智能） |
| 项目 → 课程 / 资料 / 代码库 | 0 | 无可靠依据，**不硬凑** |

补充：

- 卡片级样本 129 条，`0` 无理由、`0` 无效链接、`0` 重复链接、`0` 空结果源；
- 文章→项目没有"因为新上线就置顶"：实测 `vla-model-intro` 的项目排在第 3 位，
  `arm-trajectory-planning` 的推荐里项目不在首位（2 条项目候选均带示例徽标）；
- 示例项目在文章页也可能出现，但一律带徽标，不会被误当成真实工程成果。

## 6. 安全与性能

- **转义**：`name/description/highlights/tech/tags/icon/background/...` 全部走 `escapeHtml`；
  实测注入 `<img onerror>` / `<script>` / `<svg onload>` 五种载荷，`window.__pwned*` 全为 `false`，
  DOM 内 `img=0 / script=0`。
- **协议校验**：`safeExternalUrl()` 只放行 `^https?://`；`javascript:`、`data:text/html` 一律不生成按钮、
  不进入 `href`（实测 `badHrefs=0`）。
- **不执行数据**：没有 `eval` / `new Function` / `innerHTML = 数据字段`；也没有开放 Markdown 渲染
  （项目字段按纯文本处理，比"引入 marked + DOMPurify"更保守）。
- **性能**：详情页是同步字符串拼接，无额外请求；推荐沿用 9B-1 的两次计算时机（路由挂载 + 元数据补齐），
  没有新增滚动/观察器。`projects.js` 本来就是首屏资源，离线可用。
- **离线**：SW 缓存名升到 `blog-2026-11-20-3`；实测断网后 `#/project/defect-inspection` 仍可打开。

## 7. 三引擎验证

`node tests/browser/cross-browser.spec.js --scenario=K3 --engines=chromium,firefox,webkit`

| 引擎 | 结果 | 关键证据 |
| --- | --- | --- |
| Chromium 156 | 6/6 PASS | 详情可开、示例徽标 1 个、缺省区块未渲染、收藏、知识页"项目"、推荐 5 条 |
| Firefox 157 | 6/6 PASS | 同上，输出完全一致 |
| WebKit 27.2 | 6/6 PASS | 同上 |

三引擎在 `data-project-id`、区块列表 `技术栈|功能亮点（示例文案，未经独立验证）|技术方向`、
知识页 `href=#/project/arm-visual-grasping` 上完全一致。
（WebKit ≠ 真实 Safari/iOS，此处只代表 WebKit 引擎。）

## 8. 测试结果

| 套件 | 结果 |
| --- | --- |
| `project-detail`（**新增**，Chromium，40 项） | 40/40 PASS |
| `related-content`（回归 + 新增 T21，50 项） | 50/50 PASS |
| `related-reading`（回归） | 22/22 PASS |
| `knowledge-store` / `knowledge-center`（回归） | 25/25、29/29 PASS |
| `sw-snapshot-unit` / `sw-consistency`（回归） | 15/15、37/37 PASS |
| `test7` / `test9` / `test18` / `inline-handlers` / `audit` | 全部 PASS |
| 跨引擎 K3 | 18/18 PASS（6 项 × 3 引擎） |

套件总数：**68 → 69**（新增 `project-detail`）。`scripts/run_tests.py` 只加了清单条目与
`knowledge`/`projects` 分组，未改并行调度器、配对许可、CI 命令与超时。
本地未跑 69 套全量，全量由 PR CI 串行执行。

`tests/audit.js` 因新增路由需要同步白名单：加入 `/project/<id>` 的取值校验与死链判定
（否则 6 条项目链接会被判为"未知路由"）。

## 9. 剩余限制

1. **6 个项目仍是示例**：背景/目标/架构/时间线/结果/限制/参考/仓库全部为空，详情页只有
   概述、技术栈、亮点、技术方向、相关阅读 —— 这是**有意的**，等真实资料按指南填入。
2. **亮点里的数字未经核实**：已在 UI 与文档中三处标注，但数据本身仍是占位文案。
3. **没有项目独立的后台/编辑器**：录入靠手改 `js/projects.js` 并提交。
4. **项目不进"继续阅读"**：没有阅读进度概念（`project:<id>` 只有 fav/later/history）。
5. **项目 → 课程/资料/代码库 目前 0 条**：课程无标签、资料无摘要，桥接面太窄；
   加权重或配额会破坏 9B-1 的可解释性，本轮不做。
6. **不支持项目 Markdown**：字段是纯文本；若将来要支持，必须走现有 marked + DOMPurify 链路并重新评估 XSS。
7. 未做项目筛选/排序/统计仪表盘（6 个项目不值得引入复杂度）。

## 10. 交付物

- `BATCH9D_REPORT.md`（本文件）
- `BATCH9D_TEST_MATRIX.csv`（42 行测试矩阵）
- `BATCH9D_PROJECT_RECOMMENDATION_EVAL.csv`（27 源 / 154 行，含 `cand_example` 列）
- `PROJECT_DATA_GUIDE.md`（真实项目录入模板 + 公开边界 + 指标出处要求）
- `BATCH9B1_RECOMMENDATION_EVAL.csv` 保持原样未被覆盖（`git status` 无该文件改动）

## 11. 复现命令

```powershell
node tests/browser/project-detail.spec.js
node tests/test52_related_content.js
node tests/browser/related-content.spec.js
node tests/test51_knowledge_store.js
node tests/browser/knowledge-center.spec.js
node tests/browser/sw-snapshot-unit.spec.js
node tests/browser/sw-consistency.spec.js
node tests/browser/cross-browser.spec.js --scenario=K3 --engines=chromium,firefox,webkit
node tests/audit.js
node scripts/eval_related.js --projects     # 生成 9D 评估表（不覆盖 9B-1 基线）
python scripts/run_tests.py --only project-detail related-content related-reading knowledge-store knowledge-center
```

## 12. 实际耗时与成本

- 分支创建（2026-11-20 13:53:20）→ 文档与本地验收完成（14:07）= **约 14 分钟**，
  含 Phase A–H、三引擎验证、SW 一致性与三份文档。
- 工具调用约 **55 次**；改动文件 **16 个**（新增 5、修改 11）。
- 本地测试耗时：`project-detail` 约 55 秒；跨引擎 K3 约 12 秒；`sw-consistency` 约 2 分 40 秒；
  `related-reading` 约 35 秒；`knowledge-center` 约 70 秒。
- 平台未提供服务积分口径，**未编造数值**；未新增依赖、未访问外部服务、未上传任何数据。
