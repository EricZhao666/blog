# Batch 9B-1 报告：可解释的内容关联与相关推荐

- 状态：**B9B1_PR_READY**（本地专项、三引擎与受影响回归全部通过；PR CI tests #108 = 68 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED；未合并、未部署）
- 提交：`a907424`（功能）、`54d99d8`（报告口径修订）、本次"理由优先级修复 + 报告补充"提交；PR：
  https://github.com/EricZhao666/blog/pull/new/feat/batch9b1-related-content
  （本机没有 `gh` CLI，无法自动建 PR，按 push 输出给出链接）
- 线上仍为上一发布版本 `2026-11-20-1`（实测 `https://ericzhao666.github.io/blog/sw.js`），
  因此候选 `CACHE_VERSION` 保持 `2026-11-20-2`
- 基线：`main = 5257948`（PR #28 "Feat/batch9a1 knowledge center" 已合并，仓库 `EricZhao666/blog`）
- 分支：`feat/batch9b1-related-content`（创建于 `5257948`，2026-11-20 11:34:45 +0800）
- 版本：`CACHE_VERSION 2026-11-20-1 → 2026-11-20-2`（新增一个首屏脚本，属发布契约要求的递增）
- 范围：只做"确定性、可解释、纯前端"的相关推荐；未进入 9B-2（双向链接/图谱）、9D（项目详情页）、9A-2

## 1. 实现清单

| 项目 | 交付 |
| --- | --- |
| 算法模块 | 新增 `js/related.js`（纯函数，无 DOM/无网络/无存储，11.6KB 未压缩） |
| 渲染与编排 | `js/app.js` 新增 `relatedSlotHtml / relatedItems / relatedSourceText / relatedPaint / relatedApply`（约 140 行），路由末尾统一挂载 |
| 页面入口 | 文章详情页、课程详情页各一个"相关阅读"区块（3–5 项，不足按实际展示） |
| 样式 | `css/style.css` 追加 `.related-reading*` / `.related-card*`（仅用现有设计令牌，深浅色自动继承） |
| SW | `js/related.js` 进入 `REQUIRED_ASSETS`（7→8 项）与 `FIRST_SCREEN_ASSETS`（6→7 项）；`CACHE_VERSION` 递增 |
| 测试 | 新增 `tests/test52_related_content.js`（39 项）与 `tests/browser/related-content.spec.js`（22 项）；`cross-browser.spec.js` 新增 K2 场景 |
| 评估 | 新增 `scripts/eval_related.js`（可复现生成 `BATCH9B1_RECOMMENDATION_EVAL.csv`） |

替换的旧实现：`renderPostNav` 里"共享标签计数 + 日期排序"的 3 条相关文章、`renderCourseNoteNav` 里"同分类前 4 条"，
都被统一区块取代（避免同一页出现两份"相关"列表）。上一篇/下一篇导航保持不变。

## 2. 现有数据适配（Phase B 结果）

统一输入结构（`Related.buildIndex`）：`{ type, refId, title, tags[], category, series, tech[], text }`，
稳定键沿用 9A-1 的 `type:refId`。

| 类型 | 数量 | ID | 标题 | 标签 | 分类 | 系列 | 摘要 | 技术栈 | 真实路由 | 纳入候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| post 文章 | 18 | `id` | `title` | `tags`（17 个不同标签） | — | `series`/`seriesOrder`（2 个系列） | `excerpt` | — | `#/post/<id>` | 是 |
| course 课程 | 45 | `id`（含中文与 `|`） | `name` | **无** | `category`（8 类） | — | `description` | — | `#/course/<enc(id)>` | 是 |
| paper 论文 | 32 | `id` | `title` | `collections`（用户自建文件夹，按标签使用） | `category` | — | `abstract` | — | `#/papers?kind=paper&target=<id>` | 是 |
| material 学习资料 | 74 | `id` | `name` | **无** | `category` + `subcategory` | — | 无（用 subcategory 当文本） | — | `#/papers?kind=material&target=<id>` | 是 |
| lib 代码库 | 6 | `id` | `name` | **无** | `category` | — | `description` | — | `#/codelib/<id>` | 是 |
| project 项目 | 6 | `id` | `name` | `tags` | — | — | `description` | `tech` | **无**（仅 `#/projects` 列表页） | **否** |
| note 静态笔记页 | 14 | slug | 派生自课程 | — | — | — | — | — | `notes/*.html` | 否（课程路由已覆盖） |

关键判断（都不猜测、不改写内容）：

1. **项目不进候选**：仓库里没有 `#/project/<id>` 路由，卡片也没有锚点，唯一可达目标是列表页。
   按"不创建虚假详情路由 / 优先推荐能够正常定位的内容"的要求排除；`tech` 字段仍被算法支持，
   等 9D 提供真实详情路由后只需给它一条 `href` 就能参与（见第 8 节）。
2. **笔记静态页不进候选**：笔记是课程的衍生产物，推荐课程详情页更准确，避免同一内容两条入口。
3. **论文的 `collections` 当标签用**：它是用户手工维护的文件夹（双足机器人/具身智能/软体机器人…），
   属于真实标注，不是推断出来的字段。
4. **显式关联来自正文内链**：`data/posts/*.md` 里真实存在 5 处 `#/codelib/...` 链接
   （`rl-from-mdp-to-ppo`、`ml-fundamentals-overview`、`robotics-textbook-notes`、`vla-model-intro`、
   `slam-overview-filtering-to-graph`），课程侧来自 `COURSE_NOTES[id].notes`。
   只解析当前页已加载的正文，不新增网络请求，也不扫描全站。
5. **标签稀疏/跨主题内容**：只有 `随笔/生活/深圳` 的 `shenzhen-weekend` 属于此类，
   评测中它只拿到 2 条低分推荐（同标签随笔 + 内容提及"深圳"的代码库），没有硬凑到 5 条。

## 3. 算法（Phase C）

加权可解释打分，全部为固定常数，无学习参数：

| 信号 | 权重 | 说明 |
| --- | --- | --- |
| 显式关联 | **4.0** | 正文内链指向的候选，最高优先 |
| 同系列 | **3.0** | `series` 相同（文章特有） |
| 共同标签 | `1.0 + ln(N/df)` 每个，封顶 4.0 | `df` = 含该标签的内容数，`N` = 有标签的内容数 |
| 泛标签降权 | 0.5 | `df >= 4` 且 `df/N >= 0.4`（如"技术笔记"12/18）只给 0.5 |
| 跨类型桥接 | 1.8 × 命中数，封顶 2.6 | 源标签出现在候选标题/摘要中（课程/论文/代码库没有标签）；泛标签不算 |
| 同分类 | 1.2 → **1.8** | 课程/论文/资料/代码库的主要依据 |
| 技术栈重合 | `0.6 + 0.4·ln(N/df)` 每个，封顶 2.0 | 当前只有项目有 `tech`，规则已实现并被单测覆盖 |
| 标题词重合 | `1.2 × 重叠系数`，封顶 1.2 | 拉丁词（`VLA`/`ROS2`/`C++`）+ 中文二元组；至少 2 个共同 token，或 1 个 ≥4 字符缩写 |
| 阈值 | `MIN_SCORE = 1.6` | 低于阈值不展示；宁缺勿滥 |
| 上限 | 5 条 | 排序 `score desc`，同分按 `key` 码元序 |

### 3.1 合并前修复：理由优先级 0 被当成"缺失"

`formatReasons()` 原来用 `REASON_RANK[kind] || 9` 排序。`explicit` 的 rank 恰好是 **0**，
被 `||` 判成缺失后抬到 9，结果"正文已关联此内容"在同时存在 3 条以上理由时排到最后，
截断到 2 条时甚至会被整条挤掉（例：`vla-model-intro` 曾显示 `内容涉及：VLA · 正文已关联此内容`）。

修复：改为显式的空值判断（等价于 `?? 9`，用严格 `undefined/null` 比较以保持文件既有 ES5 风格），
并对同级别理由保留生成顺序，不依赖引擎 `sort` 的稳定性。修复后显示为
`正文已关联此内容 · 内容涉及：VLA`。**只影响理由的展示顺序，不改变任何分数、候选集合与权重。**

可解释性与确定性约束：

- 每条结果附带 `reasons[]`，按 显式 > 系列 > 标签 > 主题 > 分类 > 技术栈 > 标题 排序，卡片最多显示 2 条。
- 不用 `Date` / `Math.random` / `localeCompare`；同分用 `key` 的 `<`/`>` 比较，跨引擎结果一致
  （K2 场景实测三引擎推荐顺序完全相同）。
- 归一化（NFKC + 小写 + 空白压缩）只影响匹配；展示永远用原始串（单测 T13.1：显示为 `Machine Learning`）。
- 不做同义词/别名映射（`AI` 与 `人工智能` 不互通），不做个性化（不读浏览历史）。
- 不修改全文搜索的评分与排序（`renderSearch*`、`countSearchHits`、`SEARCH_*` 均未触碰）。

### 3.2 权重依据（用真实数据验证，不是拍脑袋）

用于校验的实测样本（`BATCH9B1_RECOMMENDATION_EVAL.csv`）：

| 现象 | 未调权前 | 调整后 |
| --- | --- | --- |
| 摘要词重合把"本文/梳理"当理由 | 每页都有"标题/摘要相近：本文、文梳"，且挤掉所有高分项 | 摘要退出计分（只用于标签桥接），噪声理由消失 |
| "技术笔记"独占 12/18 篇，单标签就能进榜 | 只共享"技术笔记"的弱关联排到 3.68 分 | 泛标签降权 0.5 → 这类候选 0.5 分被阈值挡掉 |
| 课程页整页无推荐（GRCNN 等 8 门同分类课程全被挡） | 同分类 1.2 < 1.6 | 同分类提到 1.8，课程页稳定出 5 条同方向课程 |
| 文章页没有跨类型推荐 | 课程/论文/代码库拿不到分数 | 新增标签桥接（`force-compliance-control` → CS422 得 1.8，理由是"内容涉及：运动控制"）；代码库靠显式内链登顶，论文靠 `collections` 标签进榜（实测 10 条跨类型） |

其余（显式 4.0 / 系列 3.0）按"显式与同系列必须压过普通标签"设定，
实测 `slam-overview-filtering-to-graph` 的前两名是同系列（7.15 / 7.13），第三名是正文链接的代码库（6.6），
普通标签项排在 4.0 以下，符合预期优先级。

## 4. 展示（Phase D）

| 页面 | 位置 | 内容 |
| --- | --- | --- |
| `#/post/<id>` | 系列导航之后、上一篇/下一篇之前 | `🔗 相关阅读` + 说明行 + 3–5 张卡片 |
| `#/course/<id>` | 笔记之后、上一篇/下一篇之前 | 同上（多为同分类课程） |

卡片结构：`类型徽标` + `标题（可点击）` + `关联理由`。
链接只用真实路由：`#/post/…`、`#/course/…`、`#/codelib/…`、`#/papers?kind=…&target=…`。

- 卡片是 `<article data-href>` + 内部 `<a>`，与首页文章卡片同一套约定：
  点击标题走原生跳转，点击空白走 `data-href` 事件委托。
- 卡片自动获得 9A-1 的收藏/待读按钮（复用 `kmEnhance` 的 `[data-href]:not([data-km-ready])` 扫描），
  **没有新增按钮、没有新增事件监听**；捕获阶段的拦截保证点收藏不会触发导航（R2.2/R2.3）。
- 不自动把推荐加入收藏或待读。
- 无有效关联时整个区块 `hidden`，不留空框；元数据未就绪时不显示占位骨架。

## 5. 性能、安全与离线（Phase E）

- **计算时机只有两处**：路由挂载、元数据补齐后各一次。没有 MutationObserver、没有滚动监听，
  收藏/待读变化也不会重算（`Knowledge.subscribe` 只触发 9A-1 的原路径）。
- **不阻塞正文**：区块先占位隐藏，正文渲染完成后同帧内计算（175 条元数据，单次 < 3ms）；
  首次访问文章页时才异步补 `js/courses.js`（15KB），代码库元数据（380KB）只在正文确实链接了
  `#/codelib/…` 时才加载（18 篇里 5 篇）。
- **路由生命周期**：`relatedApply` 记录 `_routeToken` 快照，回调里同时校验
  `token === _routeToken`、节点仍连接、`data-related` 仍是当前源内容，三者任一不满足就丢弃结果。
  课程页因笔记异步到达会整页重绘，重绘后显式再挂一次（`relatedApply(hash)`）。
- **加载失败**：`loadData` 内部吞掉异常并返回已 settle 的 Promise，区块退化为"仅文章间推荐"，
  页面无未捕获异常（R5.1/R5.2）。`Related` 不存在时 `relatedApply` 直接返回，阅读不受影响。
- **安全**：标题/理由/类型全部经 `escapeHtml` 转义；`href` 由 `hrefFor` 生成，只输出四类站内路由，
  不做 `javascript:`/外链；`extractLinks` 只认 `#/` 开头的已知路由，外链与 `javascript:` 被忽略（T16.1）；
  不使用 `eval` / `new Function`；算法层原样传出恶意标题，转义责任在渲染层（T19 覆盖数据侧）。
- **SW**：`js/related.js` 加入 `REQUIRED_ASSETS` + `FIRST_SCREEN_ASSETS`，并补了合成站点夹具
  `tests/browser/fixtures/swsite/js/related.js`（否则 REQUIRED 资源缺失会让一致性套件连锁失败）。
  离线时：推荐完全来自已缓存脚本 + 内存/已缓存元数据，不需要网络（R7.1 实测离线仍出 5 条）。
  `data/posts/*.md` 仍由既有运行期缓存负责，**不承诺每个推荐目标都已离线缓存**。

## 6. 推荐质量评估（Phase F）

样本：**18 篇文章全部 + 3 门代表课程 = 21 个源内容**，规则产出一张卡片级明细表
（`BATCH9B1_RECOMMENDATION_EVAL.csv`，116 行，含被截断的说明行）。

| 指标 | 数值 |
| --- | --- |
| 有推荐输出的源 | 21 / 21（0 个空结果） |
| 卡片级样本 | 98 条（另有 18 行"仅记录被截断"的说明行） |
| 无理由 / 无效链接 / 重复链接 | 0 / 0 / 0 |
| 候选类型构成 | 文章→文章 76、文章→代码库 8、文章→论文 2、课程→课程 12 |
| 跨类型推荐 | **10 条**（文章→代码库 8、文章→论文 2）；文章→课程 **0 条**（见第 8 节限制 2） |
| 每源展示数 | 5 条 ×18、4 条 ×1、2 条 ×2 |

覆盖方向（至少 10 个代表性源已满足）：

- 机器人与具身智能：`embodied-ai-notes`、`vla-model-intro`、`sim-to-real-gap`、`slam-overview-filtering-to-graph` 等 10 篇
- 工业自动化与智能制造：`smart-production-line`、`vla-industrial-challenges`、`industrial-protocols-notes`、`digital-twin-manufacturing`
- 人工智能与机器学习：`ml-fundamentals-overview`、`rl-from-mdp-to-ppo`、`rl-robot-control`
- 课程与基础技术：`本科课程|机器人与自动化-(CS422)`、`robotics-textbook-notes`、`香港大学|GRCNN-抓取检测`
- 标签稀疏/跨主题：`shenzhen-weekend`

定性审查样例（人工逐条看理由是否成立）：

| 源 | 首条推荐 | 理由 | 审查 |
| --- | --- | --- | --- |
| `vla-model-intro` | 代码库 `pythoncodeplace` | 内容涉及：VLA · 正文已关联此内容 | 通过（正文确有该链接） |
| `rl-from-mdp-to-ppo` | `rl-robot-control` | 同系列「强化学习系列」· 共同标签 | 通过（系列内互相引用是期望行为） |
| `slam-overview-filtering-to-graph` | `deep-learning-in-slam` | 同系列「SLAM 技术系列」· 共同标签：SLAM | 通过 |
| `force-compliance-control` | `arm-trajectory-planning` | 共同标签：机械臂、运动控制 | 通过（同类技术主题） |
| `embodied-ai-notes` | `sim-to-real-gap` | 共同标签：具身智能 + 标题主题相近 | 通过 |
| `本科课程\|机器人与自动化-(CS422)` | `香港大学\|MECH7010-机器人学` | 同分类：机器人与自动化 | 通过（同方向课程） |
| `shenzhen-weekend` | `smart-production-line` | 共同标签：随笔 | **保留但记录为弱关联**（仅体裁相同） |

明确限制：**没有人工相关性标注数据集**，因此本表只证明"规则一致性 + 定性合理"，
不计算准确率 / 召回 / NDCG，也不宣称这些数字。弱关联（仅共享"随笔"）在前 5 条里出现，
是"标签稀有度"这类通用规则的可解释副产物，已如实记录，不做掩盖。

### 6.1 评估口径 ≠ 首访运行时口径（必须区分）

| | `scripts/eval_related.js`（本表） | 真实首访 |
| --- | --- | --- |
| 元数据 | **全量**：18 文章 + 45 课程 + 32 论文 + 74 资料 + 6 代码库 = 175 条 | 只含**当前已加载**的元数据：文章必到；课程在首次进入详情页后异步补齐；论文/资料/代码库默认未加载 |
| 显式关联 | 直接读 `data/posts/*.md` 全部正文 | 只读当前页正文（未缓存过就为空） |
| `df` / `N` | 以 175 条为分母 | 以本次实际加载的条数为分母 |

因此**首访时的推荐可能与全量表不同**（数量更少、`idf` 略有差异、跨类型候选更少），
刷新或二次访问（元数据已缓存）后会收敛到接近全量的结果。
本轮不重构加载策略（按需加载是既有的性能契约），只在此声明口径差异：
**第 6 节的数字代表"全量元数据下界"，不是首屏首访的保证值**。

## 7. 新增测试（Phase G）

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `related-content`（新增，jsdom/node，45 项） | **45/45 PASS** | 排除自身、同系列优先、显式关联优先、泛标签降权、专指标签、同分类、标签桥接、技术栈、标题词、空关联、空/异常输入、重复去重、确定性（重复调用 + 乱序输入 + 同分码元序）、中英文归一化与原始显示、跨类型 ID 冲突、无效目标过滤、四类内链抽取、外链/`javascript:` 忽略、理由顺序、上限与分数格式、恶意标题原样输出、**T20 组：4 种理由乱序输入时显式关联仍第一 / 截到 2 条不被挤掉 / 截到 1 条就是显式 / 三理由候选端到端 / 未知类型排最后** |
| `related-reading`（新增，Chromium，22 项） | **22/22 PASS** | 文章页渲染 1–5 条、类型/标题/理由齐全、链接全部为真实路由、排除自身、显式关联**理由排在最前（位置断言，可捕获 `|| 9` 回归）**、每卡 2 个知识管理按钮、点收藏不导航且 aria 同步、点标题跳转、快速切换不残留、课程页同分类、元数据加载失败降级、正文与操作条不受影响、390 宽无溢出、深色可读、离线仍渲染 |
| 跨引擎 K2（Chromium/Firefox/WebKit） | **15/15 PASS** | 区块渲染、理由可读、点击跳转、换文章后跟随；三引擎输出完全一致 |
| `knowledge-center`（回归） | 29/29 PASS | 新增卡片未破坏收藏/待读/双标签/继续阅读 |
| `reading-experience`（回归） | 47/47 PASS | 文章页新增区块未影响目录/进度/复制/视口/SW |
| `sw-snapshot-unit`（回归） | 15/15 PASS | 首屏清单 6→7 项（含 `js/related.js`） |
| `sw-consistency`（回归） | 37/37 PASS | 首屏 7 条路径全部来自快照、不混版 |
| `test7` / `test18` / `test9` / `audit` / `inline-handlers` | PASS | 静态页/数据拆分/路由/全站巡检/内联事件 |

`test7` 的"详情页有同方向推荐"断言按新契约改为校验 `[data-related] .related-reading-item`
（旧 `.related-posts` 块已被统一区块取代，属于本轮有意变更，已在第 1 节说明）。

套件总数：**66 → 68**（新增 `related-content`、`related-reading`）。`scripts/run_tests.py`
只追加了两个清单条目与 `knowledge` 分组，未改并行调度器、配对许可、CI 命令与超时。

本地未跑 68 套全量（约 17–20 分钟）：改动集中在推荐模块、两个详情页挂载点与 SW 清单，
已按"受影响的套件全部本地验证、全量交 PR CI 串行"的要求执行。
PR CI **tests #108 已通过：68 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED**。

合并前的理由优先级修复只定向重跑了两套：
`related-content` 45/45、`related-reading` 22/22（加上 `git diff --check` 干净），
未再跑全量，68 套完整验收由新的 PR CI 执行。

## 8. 剩余限制

1. **项目不参与推荐**：缺 `#/project/<id>` 路由；这是 9D 的前置条件，不是本轮的取舍余地。
2. **文章页当前没有课程推荐（实测 0 条）**：课程与文章之间的桥接分最高 1.8（标签出现在课程描述里），
   而文章→文章普遍在 2.4–7.5，前 5 名被文章占满。这是"单一排序 + 硬上限 5 条"的必然结果：
   本轮选择保留纯排序（不给任何类型预留名额），以免为了多样性展示弱关联。
   若后续需要跨类型曝光，最小改动是在 `recommend()` 增加"每类型最多 N 条"或"至少 1 条非文章"
   的可选参数（见第 9 节接口），而不是调整权重。
3. **学习资料（74 个）几乎不出现**：没有标签、没有摘要，只有 `category`/`subcategory`，
   与文章的桥接面太窄；它们主要在论文页内部互相推荐。
4. **显式关联是单向的**（正文 → 目标），没有反向索引；反向要在 9B-2 的构建期做。
5. **不做同义词映射**：`AI` 与 `人工智能`、`机械臂` 与 `机器人` 不互通，跨主题召回有限。
6. **弱关联下限**：仅共享"随笔/生活"这类体裁标签时仍可能进榜（记录在评测表最后一行），
   是否进一步收紧需要真实用户反馈，当前不擅自加参数。
7. Playwright WebKit ≠ 真实 Safari/iOS；未覆盖真实触控与超大数据量（>2000 条元数据）表现。

## 9. 与 9B-2 / 9D 的接口

| 扩展 | 现有接口 | 需要的改动 |
| --- | --- | --- |
| 双向链接 `[[post:id]]` | `Related.extractLinks(text)` 已能解析四类内链；`recommend(index, key, { explicit })` 已接受显式键列表 | 构建期生成反向索引 → 合并进 `explicit` 数组，算法与 UI 无需改动 |
| 项目详情（9D） | 归一化结构已支持 `type:'project'` 与 `tech[]`；`hrefFor('project', id)` 目前返回 `''` 使项目被过滤 | 补一条 `#/project/<id>` 分支即可自动进入候选（单测 T7 已覆盖 `tech` 打分） |
| 知识图谱（9B-2） | `buildIndex` 返回 `items/byKey/tagDf/techDf` | 直接复用同一份索引，不需要第二套相似度 |
| 按类型配额 / 更多条数 | `recommend(..., { limit, minScore })` | 传参即可，无需改默认值 |
| 学习统计（9E） | 推荐结果已带 `key/type/score/reasons` | 可记录"从推荐点进来的"来源，但仍不做个性化排序（本轮明确不做） |

## 10. 复现命令

```powershell
node tests/test52_related_content.js
node tests/browser/related-content.spec.js
node tests/browser/cross-browser.spec.js --scenario=K2 --engines=chromium,firefox,webkit
node tests/browser/sw-snapshot-unit.spec.js
node tests/browser/reading-experience.spec.js
node tests/browser/knowledge-center.spec.js
node tests/browser/sw-consistency.spec.js
node tests/test7.js ; node tests/test18.js ; node tests/test9.js ; node tests/audit.js
node scripts/eval_related.js            # 重新生成 BATCH9B1_RECOMMENDATION_EVAL.csv
python scripts/run_tests.py --only related-content related-reading knowledge-store knowledge-center
```

## 11. 实际执行耗时与平台成本

- 分支创建（2026-11-20 11:34:45 +0800）→ 提交 `a907424`（11:54:18）= **19.6 分钟**，
  含 Phase A–G 全部工作与三引擎、SW 一致性回归。
- 工具调用约 **66 次**；首轮改动文件 **17 个**（新增 8、修改 9）。
- 合并前修复轮：改 4 个文件（`js/related.js`、两套测试、报告/矩阵），定向测试 2 套
  （`related-content` 45 项 <1s、`related-reading` 22 项约 35s）+ `git diff --check`；未跑全量。
- 测试耗时：算法专项 <1s；浏览器专项 34s；三引擎 K2 12.4s；`sw-consistency` 约 2 分 40 秒；
  `reading-experience` 约 1 分 20 秒；`knowledge-center` 约 1 分 10 秒。
- 平台未提供积分/token 计费口径，**未编造数值**；未新增依赖、未访问外部服务、未上传任何数据。
