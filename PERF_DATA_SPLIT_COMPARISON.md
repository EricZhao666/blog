# Batch 6B-2：文章数据按需加载与冷启动优化

- **结论：`B6B2_ACCEPTED`（保留数据拆分）**
- 分支：`feature/batch6b2-data-split`（从性能基线 `c87b39b` 切出；`feature/batch6-performance` 原样保留）
- 基线对照：`c87b39b` 的站点完整导出到 `tests/perf/tmp/baseline-site/`（不入库），用**同一套测量工具**跑同样 5 次
- 交付：生成器 `scripts/split_posts.py`、按需加载改造 `js/app.js`、完整性用例 `tests/test18.js`、浏览器用例 S15–S17、本报告
- 本轮未 push、未合并、未部署；未触碰 main 与任何 Benchmark 目录

**一句话结论**：首屏必须传输的文章数据从 **111 306 B 降到 8 010 B（−92.8%）**，首屏资源总量 **345 166 → 250 084 B（−27.6%）**；移动端冷启动 **load −4.1%、DCL −3.8%、文章卡片可见 −381 ms**；代价是首次打开文章多下 10.6 KB（+50 ms）、首次全文搜索多下 107 KB（完整结果 +470 ms），重复搜索与离线阅读无退化。

---

## 1. Git 准备

```bash
git status                 # 干净
git log -1 --oneline       # c87b39b 修复：SW 首屏缓存的版本一致性…
git checkout -b feature/batch6b2-data-split
```

| 项 | 状态 |
| --- | --- |
| 原性能基线分支 | `feature/batch6-performance` 保留（未改动） |
| 本轮分支 | `feature/batch6b2-data-split` |
| 基线站点副本 | `tests/perf/tmp/baseline-site/`（`git archive c87b39b` 导出，`.gitignore` 内，不入库） |
| main | 未触碰 |

---

## 2. B6-2-01 数据依赖清单

拆分前 `js/data.js` = 18 篇 × `{id,title,date,tags,excerpt,content}` + `TAG_ORDER`，共 111 306 B。
`content` 的直接/间接使用点（`js/app.js`）：

| 功能 | 位置 | 依赖字段 | 拆分后如何满足 |
| --- | --- | --- | --- |
| 首页卡片摘要 | `renderHome` → `getExcerpt` | `excerpt`（缺失时回退正文） | 元数据自带 `excerpt`；回退分支改为"有正文才截断"，不抛错 |
| 首页卡片阅读时长 | `renderHome` | `readingTime(content)` | 构建期预算 `readingMinutes`（与 `readingTime` 逐字等价，test18 逐篇比对） |
| 文章详情 | `renderPost` → `renderMarkdown` | `content` | 进入路由时按 id 拉 `data/posts/<id>.md` |
| 全文搜索（首页搜索框） | `renderGlobalSearch` | `content` | 首次搜索加载 `data/search-index.json`，把正文挂回内存对象后沿用原匹配逻辑 |
| 列表过滤 | `filterPosts(posts, query, tag)` | `title/excerpt/tags/content` | 同上（正文语料到齐后结果不变） |
| 标签筛选 | `renderTags` → `filterPosts` | `tags` | 元数据自带，无变化 |
| 相关文章 | `renderPostNav` | `tags/date` | 元数据自带，无变化 |
| 上一篇/下一篇 | `renderPostNav` | `date` | 元数据自带，无变化 |
| 文章系列导航 | `renderSeriesNav` | `series/seriesOrder` | 元数据保留这两个字段 |
| 用户发布文章 | 编辑器 → `USER_POSTS` | 内联 `content` | 用户文章仍自带正文（`cachedPostContent` 优先取内存），不触发请求 |
| 归档 | `renderArchive` | `date/title` | 元数据自带 |
| RSS | `gen_feed.py` | `id/title/date/excerpt` | **不需要改**：生成器只读这 4 个字段，正文从未进入 RSS |
| 全站巡检 | `tests/audit.js` | `id`（枚举路由） | 巡检前预拉全部正文，语义从"逐篇访问"改为"先缓存再巡检" |
| 性能工具 | `perf.spec.js` | `post.content` 长度 | 改为"元数据 + 正文文件"联合判断最长文章（保证与 6A/6B 选同一篇） |

`js/user-posts.js` 与 `gen_feed.py` 的解析方式（结构化字面量扫描）保持不变；SW 的资源清单不需要新增条目（见 §7）。

---

## 3. B6-2-02 构建期数据拆分

### 3.1 产物与映射

| 旧结构（`js/data.js`，111 306 B） | 新结构 | 体积 |
| --- | --- | --- |
| `POSTS[i].content`（模板字符串） | `data/posts/<id>.md`（18 个文件，UTF-8 无 BOM，LF） | 合计 102 938 B |
| `POSTS[i].{id,title,date,tags,excerpt,series,seriesOrder}` | `js/data.js` 元数据（字段顺序固定） | **8 010 B** |
| —（原来随页面一起下载） | `data/search-index.json`（`{id: 正文}`，仅首次搜索加载） | 106 904 B |
| — | `data/posts/manifest.json`（完整性锚点） | 7 379 B |

`readingMinutes` 为新增的派生字段（其余字段逐字节保持不变），避免首页为算阅读时长而下载正文。

### 3.2 生成器

```bash
python scripts/split_posts.py --extract      # 一次性迁移：从含正文的 data.js 生成产物
python scripts/split_posts.py --check        # 只校验（默认）：返回 0/1
python scripts/split_posts.py --extract --dry-run   # 只打印将写出的文件
```

| 参数 | 作用 |
| --- | --- |
| `--extract` | 从 `js/data.js` 读取 POSTS（必须仍含 `content`），生成/覆盖全部产物 |
| `--check` | 不写盘，校验元数据 / 正文 / 搜索语料 / manifest 四者一致 |
| `--dry-run` | 与 `--extract` 配合，只打印文件清单与体积 |

实现要点（对应 B6-2-02 的 10 条要求）：

1. **不执行数据**：解析复用 `gen_feed.py` 的结构化字面量扫描器（自己处理字符串/模板/注释/括号配对），全程不 `eval`、不 `new Function`。
2. **正文等价**：`content` 字符串按 UTF-8 原样写入 `.md`，逐篇记录 `contentSha256`、字节数、字符数。
3. **元数据不变**：每篇额外记录 `metaSha256 = sha256(canonical(去 content 后的对象))`，拆分后可证明"除 content 外一个字节都没变"。
4. **Unicode / 模板字符串 / 特殊字符**：产物全部走 UTF-8 + JSON（`ensure_ascii=False`）；`js/data.js` 用单引号转义（`\\`、`\'`、控制字符、U+2028/2029）。
5. **文件名安全**：id 必须匹配 `^[a-z0-9][a-z0-9-]*$`，重复 id、非法 id 直接报错退出。
6. **确定性**：字段顺序固定、JSON `sort_keys`、LF、无 BOM；实测"同一输入连跑两次"产物逐字节相同（`ae985f24b94171de`）。
7. **失败不覆盖**：全部产物先算好、校验通过后才写；写入用同目录临时文件 + `os.replace`，异常时清理临时文件；manifest 最后写（它是校验锚点）。
8. **完整性验证**：manifest 提供 SHA256；`--check` 与 `tests/test18.js` 双层校验。
9. **无可信执行 / 无运行时服务器**：纯静态文件 + `fetch`，GitHub Pages 直接可用。
10. **不引入新依赖**：只用 Python 标准库。

### 3.3 完整性验证结果

`python scripts/split_posts.py --check`：

```
校验对象: 18 篇文章，正文 66495 字符
OK: 元数据 / 正文 / 搜索索引 / 哈希 全部一致
```

`node tests/test18.js`（15 项全通过）：

| 断言 | 结果 |
| --- | --- |
| 文章数量 18、id 与 manifest 顺序一致、id 唯一且安全 | 通过 |
| 元数据里不再包含正文 | 通过 |
| 每篇正文的哈希 / 字节数 / 字符数一致 | 18/18 |
| 每篇元数据（含 tags/series）规范化哈希一致 | 18/18 |
| 正文总字符数 66 495 与拆分前一致 | 通过 |
| `readingMinutes` 与 `app.js` 的 `readingTime(正文)` 逐篇相等 | 18/18 |
| 搜索语料覆盖全部文章且与正文逐字一致 | 18/18 |
| 无孤儿正文文件、`TAG_ORDER` 与 manifest 一致 | 通过 |

> `readingTime` 的校验不是抄一份实现：测试从 `js/app.js` 源码里截取该函数体再执行，保证校验的是线上算法本身。

### 3.4 RSS 一致性

`python gen_feed.py` 重跑后与仓库 `feed.xml` 的差异**只有 `<lastBuildDate>` 一行**（时间戳），18 条 item 的标题/链接/描述完全一致 —— 正文从未进入 RSS，拆分无影响。

---

## 4. B6-2-03 文章详情按需加载

| 要求 | 实现 |
| --- | --- |
| 首页不再下载正文 | 首页只加载 `js/data.js`（8 010 B）；S15 断言"首访不请求任何 `data/posts/*.md`" |
| 明确的加载状态 | 路由先渲染 `renderPostLoading(post)`：显示文章标题 + "正在加载文章正文…" |
| 加载失败可重试 | `renderPostError()` 给出"重新加载"按钮（事件委托 `[data-retry-post]`），点击后重跑路由；S17 覆盖"离线失败 → 恢复网络 → 重试成功" |
| 快速切换路由不显示旧文章 | 路由令牌 `_routeToken`：`await` 之后 `if (token !== _routeToken) return`，晚到的正文不会覆盖新路由 |
| 重复进入复用缓存 | 内存 `_postBodies` + Service Worker 运行期缓存（S16 断言正文进入 RT 缓存，离线重开命中） |
| TOC / 阅读进度 / 代码高亮 / 复制按钮 | 这些增强在路由完成渲染后统一执行（`buildReadingTools` / `enhanceCodeBlocks` / `highlightIn`），异步渲染的位置与同步渲染一致 |
| Markdown 净化 | 仍走 `renderMarkdown` → `DOMPurify.sanitize(SANITIZE_CONFIG)`（Batch 5 契约未变，test16 20/20 通过） |
| 发布 / 草稿 / 编辑器 | 未改动；用户文章自带 `content`，`cachedPostContent` 直接命中，不发请求（test10/test11 通过） |
| 导航 / 标签 / 相关文章 | 全部基于元数据，不需要正文（test7/test14/audit 通过） |

同步兼容：`renderPost(id)` 仍保留——正文在内存里就返回完整页面，否则返回加载态；诊断探针（`perf.spec.js` 的微基准）先调 `loadPostBody()` 再测，避免把加载态当成渲染耗时。

---

## 5. B6-2-04 全文搜索

### 5.1 三个方案的取舍

| 方案 | 做法 | 首次搜索额外字节 | 结果一致性 | 复杂度 |
| --- | --- | --- | --- | --- |
| A 现状（拆分前） | 首页直接带全部正文 | 0（但每次首访都下 111 KB） | — | 低 |
| **B 首次搜索加载全文语料（选用）** | `data/search-index.json`（`{id: content}`） | +106 904 B | **完全一致**（同一份正文） | 低 |
| C 构建期倒排索引 | 中文需自行分词/二元切分，`includes()` 的子串语义会变 | 更小 | 需要重新定义"命中" | 高 |

选 B：搜索代码一行未改（仍是对 `post.content` 做 `includes`），因此"关键词命中结果保持一致"是结构性保证而不是靠调参；不引入分词与索引格式的兼容风险。

### 5.2 行为

1. **元数据结果先出**：输入后 180 ms 防抖到点即渲染标题/摘要/标签命中（与拆分前同样的首帧耗时：移动 203.6 ms vs 198.8 ms）。
2. **正文语料到齐后补全**：`ensureSearchDocs()` 完成 → 校验"仍在首页 + 查询词未变" → 重绘；重绘后重新绑定输入框并恢复焦点。
3. **不做无谓重绘**：语料已加载（`_searchDocsReady`）且课程/论文/笔记已就绪时，不再触发异步重绘。
4. **过时结果不覆盖**：`searchQuery.trim() !== target` 或已离开首页 → 直接丢弃（test9 B1/B2 覆盖）。
5. **降级与重试**：语料加载失败 → 记录 `_searchDocsError`，结果页提示"正文检索暂不可用（当前只匹配标题/摘要/标签），重新输入可重试"；下一次输入会重新发起（失败时清空 promise）。
6. **跨数据源不变**：课程笔记 / 论文 / 学习资料三段逻辑未改。
7. **不重复**：搜索仍是"文章一次 + 课程一次 + 论文一次"，按 id 去重逻辑未变（test7/test9 通过）。
8. **不破坏路由**：异步回调先判断 `isHomeRoute()`（test9 B1/B2 通过）。
9. **预热**：聚焦搜索框（点击或按 `/`）即开始拉取语料，把 180 ms 防抖 + 输入时间利用起来。

### 5.3 结果一致性验证

| 验证 | 方法 | 结果 |
| --- | --- | --- |
| 既有测试关键词 `机器人` | test7（500 ms 内出结果）、test9 B1 | 通过 |
| 仅正文命中的关键词 `卡尔曼` | test9 B2（须触发懒加载且不覆盖路由） | 通过 |
| 语料完整性 | test18：`{id: 正文}` 与 18 篇正文逐字一致 | 18/18 |
| 命中数一致性 | 搜索逻辑未改，语料与拆分前同源（SHA256 锚定） | 结构性一致 |

---

## 6. B6-2-05 Service Worker 与离线

**结论：SW 无需修改。** 复核如下：

| 检查项 | 结论 |
| --- | --- |
| 新元数据是否属于安装期必需资源 | 是。`js/data.js` 仍是 `REQUIRED_ASSETS`，安装期快照机制不变 |
| 正文按需加载的缓存行为 | `data/posts/*.md` 走"其他同源资源"分支：network-first + 运行期缓存（≤120 条） |
| 首次进入未缓存文章 + 离线 | 请求失败 → `renderPostError`（明确提示 + 重试），S17 覆盖 |
| 已访问文章的离线阅读 | 正文进运行期缓存，离线重开命中，S16 覆盖（含文档级 reload） |
| 搜索语料首次加载与离线重访 | 与正文同一条分支；失败降级为元数据搜索，不阻塞 |
| 更新版本后的新旧资源兼容 | `CACHE_VERSION` 未变（本轮不涉及 SW 逻辑）；发布新资源时应按惯例递增，正文/语料同样随版本快照失效重建 |
| 多标签页与刷新 | 未改 SW，S12 仍通过 |
| 150 ms 回退与整版本一致性 | 未改；35 项一致性用例全通过 |

新增浏览器用例（`tests/browser/sw.spec.js`，37 项全通过）：

| 用例 | 断言 |
| --- | --- |
| S15 | 首访不请求任何 `data/posts/*.md`、不请求 `search-index.json`，首页列表仍完整渲染 |
| S16 | 进入文章正文渲染完成 → 正文进入运行期缓存 → 离线 reload 仍可阅读 |
| S17 | 未缓存文章离线时显示"加载失败 + 重新加载"、不出现空白或其它文章 → 恢复网络后点击重试可读到正文 |

---

## 7. B6-2-06 性能对照（同一环境、同一工具、各 5 次）

环境：Chrome 156 headless；桌面 1440×900 无限速；移动 Pixel 7 + 4× CPU + 下行 1638.4 kbps / 首字节 150 ms；两版都用观测探针链路（`--sw-file`），因此字节口径一致。

### 7.1 首页冷启动

| 指标（中位数 [最小~最大]） | 基线 `c87b39b` | 拆分后 | 变化 |
| --- | --- | --- | --- |
| **首屏资源编码字节（9 个请求）** | **345 166** | **250 084** | **−95 082（−27.6%）** |
| 其中 `js/data.js` | 111 306 | **8 010** | −103 296（−92.8%） |
| 移动 load | 3 558.9 [3 510.8~3 724.4] | 3 412.8 [3 217.2~3 587.8] | −146.1 ms（−4.1%） |
| 移动 DOMContentLoaded | 2 977.8 [2 949.7~3 005.7] | 2 864.8 [2 541.3~2 896.1] | −113.0 ms（−3.8%） |
| 移动 FCP / LCP | 1 422 [1 384~1 568] | 1 814 [1 556~1 876] | **+392 ms（见 §7.5 的口径冲突）** |
| 桌面 load | 333.3 [315.5~403.5] | 384.9 [327.5~435.4] | +51.6 ms（区间重叠，判噪声） |
| 桌面 networkBytes（含 SW 安装预取） | 980 652 | 791 174 | −189 478（−19.3%） |
| 移动 networkBytes（load+2.5 s 窗口） | 704 435 | 572 499 | −131 936（−18.7%） |
| 请求数 | 9 | 9 | 0 |

> 冷启动 networkBytes 的降幅大于首屏编码字节，是因为 `data.js` 在冷启动会被下载两次（页面一次 + SW 安装预取一次），拆分后两次都变小。移动端窗口在预取完成前就结束，所以只体现了一部分。

### 7.2 首页热启动

| 指标 | 基线 | 拆分后 | 变化 |
| --- | --- | --- | --- |
| 移动 load | 356.2 [347.9~373.2] | 348.6 [337.3~380.7] | −7.6 ms（噪声内） |
| 桌面 load | 99.2 [91.6~103.6] | 99.2 [91.8~101.6] | 0 |
| 桌面 networkBytes | 363 874 | 268 419 | −95 455 |
| 移动 networkBytes | 94 735 | 94 735 | 0（缓存模式不校验首屏） |

### 7.3 文章详情（首次 / 重复 / 离线）

| 指标 | 基线 | 拆分后 | 变化 |
| --- | --- | --- | --- |
| 移动 首次正文可读 | 1 235.9 [1 115.5~1 350.2] | 1 286.1 [1 230.6~1 383.9] | **+50.2 ms（+4.1%）** |
| 移动 首次绘制完成（双 rAF） | 1 514.5 | 1 585.3 | +70.8 ms |
| 移动 正文传输字节 | 0（正文随首页下发） | 10 647（只这一篇） | +10 647 |
| 移动 首次打开的服务端请求 | 1（懒加载高亮库） | 2（+正文） | +1 |
| 移动 重复打开正文可读 | 179.5 [174.2~192.5] | 168.8 [155.6~181.0] | −10.7 ms |
| 移动 离线重开正文可读 | 77 [74~141] | 85 [70~129] | 噪声内（5/5 可读） |
| 桌面 首次正文可读 | 262.9 [239.7~279.8] | 239.9 [57.1~252.2] | 中位数 −23 ms（双峰，见 §7.5） |

### 7.4 全文搜索

| 指标 | 基线 | 拆分后 | 变化 |
| --- | --- | --- | --- |
| 移动 首个结果（含 180 ms 防抖） | 198.8 [198.3~203.2] | 207.1 [204.2~209.4] | +8.3 ms |
| **移动 完整结果** | **1 582.5 [1 579.3~1 589]** | **2 052.6 [2 043.8~2 056.6]** | **+470.1 ms（+29.7%）** |
| 移动 首次搜索额外字节 | 157 381 | 265 717 | +108 336（正文语料） |
| 移动 重复输入 | 278.4 [241.6~362.2] | 217.0 [199.5~326.6] | −61.4 ms |
| 桌面 完整结果 | 246.4 [242.6~248.1] | 252.8 [245.9~257.2] | +6.4 ms |
| 桌面 首次搜索额外字节 | 157 381 | 265 717 | +108 336 |

> 拆分后先测到 2 251.1 ms；加入"聚焦搜索框即预热"后降到 2 052.6 ms（−198 ms），首个结果时间不变。

### 7.5 口径说明（必须一起看）

- **FCP/LCP 在首页只反映页头**（6A §8.3 已记录：卡片 `opacity:0 + fadeInUp` 不入 LCP 候选）。本轮出现两套互相矛盾的读数：同环境 8 次测量 FCP 为 1 814 ms（拆分）vs 1 422 ms（基线），而专项探针 5 次为 1 384 ms vs 1 428 ms。**两套读数方向相反，因此不把 FCP 作为结论依据**；能对齐的是 DCL（−3.8%）、load（−4.1%）与"文章卡片首次可见"（见下）。
- 专项探针（`tests/perf/tmp/first-card.js`，移动整形 + 4× CPU，5 次中位）：**首张文章卡片可见 3 517 ms → 3 136 ms（−381 ms）**，同一次测量里 FCP 1 428 → 1 384、DCL 2 960 → 2 467。这组数据与"数据变小→app.js 更早拿到→列表更早渲染"的预期一致。
- 桌面首次打开文章出现双峰（57~67 ms / 240~252 ms），中位数与基线持平；分档原因未拆分（渲染帧/CPU 调度），不影响移动端结论。

---

## 8. 验收清单

| 要求 | 证据 | 结果 |
| --- | --- | --- |
| 文章数量一致 | test18：18 篇 | ✅ |
| 全部元数据一致 | test18：18/18 `metaSha256` 命中（含 tags/series） | ✅ |
| 全部正文完整 | test18：18/18 字节/字符/SHA256 一致，总字符 66 495 | ✅ |
| 首页列表、标签、归档正常 | audit（全站巡检）+ test7 + test14 | ✅ |
| 文章导航（上/下篇、相关、系列） | test14（顺序/上下篇）+ 手工核对 `renderPostNav`/`renderSeriesNav` 只用元数据 | ✅ |
| 全文搜索结果不丢失 | test18 语料逐字一致 + test7/test9 关键词（`机器人`、`卡尔曼`） | ✅ |
| 编辑器发布模拟 | test10（发布/冲突/编码）+ test11（草稿竞态） | ✅ |
| Markdown 净化仍生效 | test16（20/20） | ✅ |
| RSS 内容一致 | `gen_feed.py` 重跑仅 `lastBuildDate` 变化 | ✅ |
| 已缓存文章可离线访问 | S16（正文进 RT 缓存 + 离线 reload 可读） | ✅ |
| SW 版本一致性 | `sw-consistency` 35/35（未改 SW） | ✅ |

---

## 9. 测试结果

`python scripts/run_tests.py` → **PASS 17 / FAIL 0 / SKIP 0 / BLOCKED 0**

| 用例 | 结果 |
| --- | --- |
| 语法检查（31 个文件，含 `scripts/split_posts.py`） | 全 OK |
| `audit` / `test6` / `test7` / `test8` / `test9` / `test10` / `test11` / `test14` | PASS |
| `test12` 25/25、`test13` 40/40、`test15` 32/32、`test16` 20/20、`test17` 11/11 | PASS |
| **`test18`（新增）** | **15/15** |
| **`split-check`（新增）** | PASS |
| **`browser`（含新增 S15–S17）** | **37/37** |
| `sw-consistency` | 35/35 |

**关于旧测试的调整**：只有两处数据入口变化，**没有删除或放宽任何断言**——
`tests/audit.js` 在巡检前 `await Promise.all(POSTS.map(p => loadPostBody(p.id)))`（把"逐篇访问"等价改写成"先取齐再巡检"，断言语义不变）；
`tests/perf/perf.spec.js` 的 `longestPostId()` 在正文被拆出后从 `data/posts/*.md` 读长度（保证新旧两版仍选同一篇文章）。
其余用例（test6/7/9/10/11/14/16/17、sw.spec 原有 28 项）源码未改。

实现提交：`705ec71`（分支 `feature/batch6b2-data-split`）。

---

## 10. 收益判断与保留决定

### 保留：是

| 参考目标 | 实测 | 判定 |
| --- | --- | --- |
| 首页冷启动传输量下降 ≥20% | 首屏资源 −27.6%；冷启动总字节 −18.7%~−19.3% | ✅（首屏口径达成） |
| 移动端冷启动 load 或 LCP 有稳定改善 | load −4.1%、DCL −3.8%、卡片可见 −381 ms；**FCP 读数矛盾** | ✅（以 load/DCL/卡片为准，FCP 不下结论） |
| 首次文章加载额外延迟可接受 | +50 ms（+4.1%），只多传 10.6 KB | ✅ |
| 全文搜索无明显退化 | 首个结果 +8 ms；**完整结果 +470 ms（+29.7%）** | ⚠️ 有可见代价，见下 |
| 安全 / 离线 / 数据完整性无回归 | test16/test17/S15–S17/sw-consistency 全通过 | ✅ |

**搜索代价的处理**：正文语料 107 KB 只在"用户真的搜索"时下载，且首个结果仍 200 ms 级（不被阻塞）。若后续认为 2.05 s 仍不可接受，可选路径是构建期倒排索引（§5.1 方案 C），但会改变 `includes` 子串语义，需先定义新的命中规则；本轮不做。

---

## 11. 剩余问题与架构风险

1. **正文与元数据是两份数据源**：新增/修改文章必须走生成器（`--extract` 之后为 `--check` 把关），手工改 `js/data.js` 会被 `test18`/`split-check` 拦下。编辑器发布的用户文章不受影响（仍在 `user-posts.js` 内联）。
2. **搜索语料是正文的第二份副本**（+107 KB 仓库体积 / +107 KB 首次搜索流量）。这是"保持 `includes` 语义不变"的代价；若将来上倒排索引，可回收这部分。
3. **`CACHE_VERSION` 纪律不变**：发布新正文/语料时仍须递增，否则缓存模式用户会看到旧快照（6B-1.1 已记录）。
4. **正文请求不在安装期预缓存**：离线只能读"访问过"的文章，这是本轮的设计前提（首访体积优先）。
5. **FCP 口径问题**：首页 LCP 只反映页头，不能代表列表可见时间（6A §8.3 已提出）；本轮再次遇到两套读数冲突，建议后续统一用"首张卡片可见"作为首页内容指标。
6. **桌面首次打开文章的双峰**未拆分原因，绝对值均 <300 ms，未影响结论。

---

## 12. 修改文件与 Git Diff

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `js/data.js` | 改（生成物） | 元数据 + `readingMinutes`，111 306 → 8 010 B |
| `data/posts/*.md` | 新增（18 个，生成物） | 每篇正文，字节等于原 `content` |
| `data/posts/manifest.json` | 新增（生成物） | 完整性锚点（SHA256 / 字节 / 字符 / 元数据哈希） |
| `data/search-index.json` | 新增（生成物） | 全文搜索语料 |
| `scripts/split_posts.py` | 新增 | 拆分生成器 + `--check` |
| `js/app.js` | 改 | 正文与搜索语料按需加载、加载/失败/重试态、路由令牌、聚焦预热 |
| `css/style.css` | 改 | `.search-hint`、加载态与重试按钮样式（+29 行） |
| `tests/test18.js` | 新增 | 数据完整性 15 项 |
| `tests/audit.js` | 改 | 巡检前预拉正文（保持"逐篇访问"语义） |
| `tests/browser/sw.spec.js` | 改 | 新增 S15–S17（正文按需加载 / 离线复用 / 失败重试） |
| `tests/perf/perf.spec.js` | 改 | 新增 `post-lazy` 场景、正文可读指标、`longestPostId` 兼容拆分后数据 |
| `tests/browser/helpers/server.js` | 改 | 增加 `.md` MIME |
| `scripts/run_tests.py` | 改 | 纳入 `test18` 与 `split-check` |
| `tests/perf/reports/batch6b2/*.json` | 新增 | 4 份对照原始数据 + 2 份 n=8 冷启动复测 |

```bash
git diff c87b39b --stat
git diff c87b39b -- js/app.js
git log --oneline -3
```

## 附录：复现命令

```bash
# 数据产物
python scripts/split_posts.py --check
node tests/test18.js

# 全量回归
python scripts/run_tests.py

# 性能对照（当前分支）
node tests/perf/perf.spec.js --scenarios cold-home,warm-home,post-lazy,search \
     --configs desktop,mobile --repeat 5 --no-diagnostics --sw-file sw.js \
     --out tests/perf/reports/batch6b2/split-desktop.json

# 性能对照（基线）：先导出 c87b39b 站点并放入同一套工具
git archive -o tests/perf/tmp/baseline.tar c87b39b
tar -xf tests/perf/tmp/baseline.tar -C tests/perf/tmp/baseline-site
NODE_PATH=<repo>/node_modules node tests/perf/tmp/baseline-site/tests/perf/perf.spec.js \
     --scenarios cold-home,warm-home,post-lazy,search --configs mobile --repeat 5 \
     --no-diagnostics --sw-file sw.js --out <repo>/tests/perf/reports/batch6b2/baseline-mobile.json
```
