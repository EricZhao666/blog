# Batch 9E 指标口径定义（BATCH9E_METRIC_DEFINITIONS）

> 适用范围：`js/learning-stats.js`（纯计算）、`js/app.js` 的 `#/knowledge?tab=stats` 视图、`window.kmLearningAnalytics()`。
> 本文只描述**已实现并验证**的口径，不含规划内容。所有口径均由 `tests/test54_learning_stats.js` 与
> `tests/browser/learning-analytics.spec.js` 覆盖。

## 1. 输入契约（三类，全部只读）

### 1.1 知识记录（`Knowledge.snapshot().rows`）

来源：IndexedDB `blog-knowledge` / `records`，经 `js/knowledge.js` 归一化。

| 字段 | 类型 | 统计用途 |
| --- | --- | --- |
| `type` / `refId` | string | 拼成唯一键 `type:refId`（去重依据） |
| `title` | string | 展示标题（缺失时回落到内容元数据标题） |
| `fav` / `later` | 0\|1 | 收藏 / 待读计数 |
| `favCat` | string | 收藏分类（缺省按 `default`） |
| `readState` | `none`\|`reading`\|`done` | 阅读中 / 已完成 |
| `progress` | 0–1 | 仅用于展示与"继续阅读"判定，不单独等价于已完成 |
| `stateSource` | `manual`\|`auto` | 区分人工标记与自动阈值（`doneManual` / `doneAuto`） |
| `lastSeenAt` | ts | 已浏览判定（`> 0`）与最近浏览排序 |
| `doneAt` / `updatedAt` | ts | 仅用于去重时的取舍（`updatedAt` 较大者保留） |

### 1.2 分类定义（`Knowledge.categories()`）

来源：`meta.favCategories`，元素 `{ id, name, system }`。统计只读，不新增分类、不移动收藏。

### 1.3 内容元数据（按类型可选）

| 类型 | 来源 | 读取字段 |
| --- | --- | --- |
| `post` | `js/data.js` + `js/user-posts.js`（首屏已加载） | `title`、`tags` |
| `course` | `js/courses.js`（按需加载） | `name`、`category` |
| `paper` / `material` | `js/papers.js`（按需加载） | `title`、`category`、`collections` |
| `lib` | `js/codefiles.js`（仅在存在 `lib` 记录时按需加载） | `name`、`category` |
| `project` | `js/projects.js`（首屏已加载） | `name`、`tags`、`tech` |
| `note` | 无稳定映射 | 不提供（按"元数据未知"处理） |

三种解析状态：`exists`（已加载且存在）、`missing`（类型已加载但找不到 ID）、`unknown`（该类型元数据未加载）。

## 2. 去重与基础口径

| 规则 | 实现 |
| --- | --- |
| 唯一键 | `type + ':' + refId`。**不使用** `key` 字段作为统计键；`key` 只作兼容 |
| 重复记录 | 同一唯一键出现多次时只计 1 条，`updatedAt` 较大者保留，`totals.duplicates` 记录被合并的条数 |
| 跨类型同 ID | `post:x` 与 `project:x` 是两条不同内容，不合并 |
| 非法记录 | 缺 `type` 或 `refId` 的对象直接忽略（不抛错） |
| 统计层写入 | 无。所有函数只读输入，返回新对象（单测 K14） |

## 3. 指标逐条定义

| # | 指标 | 计算定义 | 字段来源 | 分母 / 去重 | 边界 |
| --- | --- | --- | --- | --- | --- |
| 1 | 已浏览的不同内容数 | `count(unique type:refId where lastSeenAt > 0)` | `lastSeenAt` | 按唯一键去重 | 清理过历史（`lastSeenAt=0`）不计入 |
| 2 | 收藏数量 | `count(unique where fav=1)` | `fav` | 唯一键 | 与待读可重叠 |
| 3 | 待读数量 | `count(unique where later=1)` | `later` | 唯一键 | 与收藏可重叠；`favLater` 单独给出重叠数 |
| 4 | 阅读中数量 | `count(unique where readState='reading')` | `readState` | 唯一键 | 只认状态，不按进度猜 |
| 5 | 已完成数量 | `count(unique where readState='done')` | `readState` | 唯一键 | `progress=100%` 但状态非 done 时**不**计为完成 |
| 6 | 各内容类型分布 | `count(unique) group by type`，同时给出 `viewed` 子计数 | `type` | 唯一键（全部记录） | 未收录类型回落到原始 type 字符串 |
| 7 | 收藏分类分布 | `count(fav=1) group by favCat`，映射到分类名 | `favCat` + `meta.favCategories` | 收藏总数 | 已定义分类全部列出（含 0）；指向已删除分类的归入"未知分类" |
| 8 | 最近浏览内容 | 已浏览记录按 `lastSeenAt` 降序取前 8 条（同时间按 key 升序稳定） | `lastSeenAt` / `progress` / `readState` | 唯一键 | 每条带 `metaState`，可区分"内容已删除" |
| 9 | 最近接触的技术方向 | 最近 30 天内浏览过的记录，按第 4 节规则归类后计数 | `lastSeenAt` + 内容元数据 | 唯一键 + 时间窗口 | 窗口内无浏览 → 空结果，不回落成全量 |
| 10 | 有效内容的阅读完成率 | `rate = done_posts / viewed_posts`，保留 3 位小数 | `readState` + `lastSeenAt` + `type='post'` | **分母 = 已浏览文章** | 分母为 0 时 `rate=0`（不产生 NaN）；课程/论文/资料/代码库/项目/笔记不进入分母 |

### 3.1 指标 10 的补充口径

- **"有效内容"= 已浏览文章**（`type='post'` 且 `lastSeenAt>0`）。理由：全站只有文章在滚动时写入 `progress`
  （`Knowledge.scheduleProgress('post', ...)`），其它类型没有可靠的逐段进度。
- `progressOnly`：`progress>0` 但 `lastSeenAt=0`（历史被清理）的文章数，单独统计并写入说明文案，**不补进分母**。
- `doneManual` / `doneAuto`：`stateSource='manual'` 与其它（自动阈值 ≥0.95）分开计数，避免"人工已读"和"滚到底"
  被混成同一种语义。
- `markedDoneOther`：非文章内容被标记已读的条数。只作信息展示，不参与完成率。

## 4. 方向归属规则（Phase C）

### 4.1 规则来源

只使用内容自带的元数据字段，**不读标题**：

| 类型 | 参与匹配的字段 |
| --- | --- |
| 文章 | `tags` |
| 课程 | `category` |
| 论文 / 资料 | `category`、`collections` |
| 代码库 | `category` |
| 项目 | `tags`、`tech` |

### 4.2 匹配算法（`LearningStats.classify` / `hasKeyword`）

- 纯 ASCII 关键词（含 `+`、`#`）：按词边界匹配，`(^|[^a-z0-9])kw($|[^a-z0-9])`，大小写不敏感。
  - 例：`AI` 命中标签 `AI`，**不**命中 `Training`；`C++` 命中 `C++`；`Python` 命中分类 `Python 代码`。
- 中文关键词：子串匹配（中文无词边界）。
- 一条内容可命中多个方向；未命中任何方向 → `unknown`（未分类）。
- 通用标签（`技术笔记`、`随笔`、`生活`、`深圳`、`读书笔记` 等）不在任何规则里，因此不会被强行归类。

### 4.3 五个方向与关键词

| key | 展示名 | 关键词（子集示例，完整表见 `LearningStats.RULES`） |
| --- | --- | --- |
| `robotics` | 机器人与具身智能 | 机器人、机械臂、具身智能、VLA、SLAM、抓取、运动控制、力控、阻抗控制、导航、无人机、双足、软体机器人、ROS、ROS2、MoveIt2、Isaac Gym、ORB-SLAM3、Cartographer、机器人与自动化、AGV |
| `industrial` | 工业自动化与智能制造 | 智能制造、产线、工业、数字孪生、OPC UA、Modbus、Profinet、EtherCAT、PLC、注塑、焊接、边缘计算、Jetson、信号与控制、电子与硬件、时序数据库 |
| `ai` | 人工智能与机器学习 | 人工智能、机器学习、深度学习、强化学习、神经网络、AI、PyTorch、TensorRT、Transformers、计算机视觉、YOLO、人工智能与机器学习 |
| `software` | 软件开发与其他技术 | 软件开发、前端、后端、计算机科学、综合代码仓库、Python、C++、Linux、Three.js、WebSocket、MATLAB |
| `unknown` | 未分类 | 未命中以上任意规则（含元数据未加载/内容已删除） |

### 4.4 与真实分类值的对照（当前仓库）

- 课程 `category`：机器人与自动化 / 设计 / 其他课程 / 计算机科学 / 信号与控制 / 电子与硬件 / 数理基础 / 人工智能与机器学习。
  → `设计`、`数理基础`、`其他课程` 不入方向（保持未分类），不做猜测。
- 论文 `category` 与 `collections`：双足机器人 / 已读论文 / 课程论文 / 港大教授论文 / 软体机器人 / 其他机器人 / 具身智能 / 已读。
  → `已读`、`已读论文`、`课程论文` 不入方向（它们是状态/来源，不是技术方向）。
- 代码库 `category`：MATLAB 备份 / Python 代码 / 学习资料 / 强化学习 / 数学建模 / 综合代码仓库。
  → `学习资料`、`数学建模` 不入方向；`学习资料` 不会因为含"学习"字被当成机器学习。

### 4.5 三类"分类"不混用

| 维度 | 来源 | 用途 | 输出字段 |
| --- | --- | --- | --- |
| 内容原始标签 | 文章 `tags` / 项目 `tags`+`tech` / 论文 `collections` | 方向归属的输入 | 不单独输出 |
| 用户收藏分类 | `meta.favCategories` + `records.favCat` | 收藏分类分布 | `favCategories` |
| 技术方向 | 本节规则 | 方向分布 | `directions` / `recentDirections` |

## 5. 明确不提供的统计项

由 `LearningStats.UNSUPPORTED` 与统计页"数据范围与统计说明"同时呈现：

| key | 名称 | 原因 |
| --- | --- | --- |
| `visits` | 总访问次数 | 没有逐次浏览事件日志；每条记录只有一个 `lastSeenAt` |
| `timeSpent` | 阅读时长 | 没有计时采样，`progress` 只是滚动百分比 |
| `dailyMinutes` | 每天在线分钟数 | 同上，无在线时长数据 |
| `streak` | 连续学习天数 | 历史会被裁剪（上限 500 条）；导入数据的日期来自文件，不代表真实学习日期 |
| `frequency` | 精确历史阅读频率 | 只有首次/最近浏览时间，没有中间浏览序列 |

## 6. 精度与舍入

- `completion.rate`：三位小数（`Math.round(x*1000)/1000`）；UI 展示为整数百分比。
- 条形图百分比：一位小数（`Math.round(x*1000)/10`，占该组合计）；条形长度按组内最大值归一并设 3% 下限。
- 时间窗口：`30 × 86400000` 毫秒，起点 `since = now - 30d`，边界含等于。
- `now` 可注入（测试固定时间），缺省 `Date.now()`。

## 7. 9F 复用要点

1. 直接调用 `LearningStats.summarize({ records, categories, content, now })`，不要在前端重算口径。
2. 需要"完整性/降级/写入闸门"信息时用 `kmLearningAnalytics()`，它返回
   `{ ok, summary, continueItems, status, complete, warning }`；读取失败时 **reject**，不返回旧结果。
3. `summary.unsupported` 是"不提供哪些指标"的唯一事实源，9F 不要另造访问次数/连续天数。
4. 方向计数之和允许大于唯一内容数（多方向），展示时必须说明。
