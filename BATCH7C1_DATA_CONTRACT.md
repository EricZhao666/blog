# Batch 7C-1：博客发布数据链审计与一致性契约

项目：`<repo>`
分支：`feature/batch7c-publishing-pipeline`（从 `main@9e996a3` 新建）
基线：`9e996a34`（Batch 7B squash 合并后的 main，内容与本地 `b9797a1` 完全一致）
本轮：只审计与取证，不实现最终发布系统，不改 GitHub Pages 设置，不推送。

| 初始快照 | SHA256（前 16 位） | 大小 |
|---|---|---|
| `js/app.js` | `50624ef32618db71` | 126 308 B |
| `js/user-posts.js` | `0db20cfb0a82b32c` | 205 B |
| `js/data.js` | `ae985f24b94171de` | 8 010 B |
| `scripts/split_posts.py` | `90dde590f0723795` | 19 827 B |
| `gen_feed.py` | `9b0bc666d55bddea` | 17 244 B |
| `gen_notes_pages.js` | `af0878326aa122d2` | 18 126 B |
| `sitemap.xml` | `4aaa331d3a1257a9` | 3 242 B |
| `sw.js` | `2a5b5a72dab33ca2` | 19 694 B |
| `feed.xml` | `ba44b3e65e4751e7` | 9 727 B |
| `index.html` | `de2c73831d2520ab` | 5 527 B |

---

## 1. 当前真实数据流

### 1.1 两条互不相交的写路径

```
① 内置文章（历史，人工维护）                 ② 编辑器文章（浏览器发布）
   js/data.js（元数据，手改）                  编辑器表单
   data/posts/<id>.md（正文，手改）              │  publishPost()
          │                                     │  GET  contents/js/user-posts.js
          │  split_posts.py --sync               │  PUT  contents/js/user-posts.js
          ▼                                     ▼
   ┌───────────────────────────┐          js/user-posts.js
   │ js/data.js（规范化覆盖）   │          （元数据 + 正文内联，一个文件）
   │ data/search-index.json    │                │
   │ data/posts/manifest.json  │                │  gen_feed.py（人工/本地执行）
   └───────────────────────────┘                ▼
          │                                feed.xml
          │  gen_feed.py（读 data.js + user-posts.js）▲
          └──────────────────────────────────────────┘

③ 静态页：gen_notes_pages.js → notes/*.html + js/note-slugs.js + sitemap.xml
④ 部署：main 分支根目录 + .nojekyll（GitHub Pages 直接托管，无构建步骤）
```

### 1.2 关键事实（实测）

| 事实 | 证据 |
|---|---|
| 内置文章 18 篇、正文 18 个 `.md`、搜索语料 18 个 key、manifest 18 条、feed 18 条 | `tests/batch7c1/stats.py` |
| `USER_POSTS` 当前为空数组，文件只有 205 B | `js/user-posts.js` |
| 编辑器**只**写 `js/user-posts.js`，只发 1 次 PUT | 复现 P1（`PUT=1 path=js/user-posts.js`） |
| 编辑器文章正文**内联**在 JS 数组里；内置文章正文**按需 fetch** `.md` | `publishPost()` 构造 `content` 字段；`cachedPostContent()` 优先用内存 content |
| 编辑器**没有**更新/删除入口 | `app.js` 无 `DELETE` 请求、无删除 UI（复现 P3） |
| `split_posts.py` 完全不认识 `user-posts.js` | 脚本头部"权威输入"只有 data.js + data/posts |
| `gen_feed.py` **两边都读**，并按 id 去重（data.js 优先） | `parse_posts` + `parse_user_posts` + `dedupe_posts` |
| `sitemap.xml` 由 `gen_notes_pages.js` 生成，只含 home / notes / feed | `gen_notes_pages.js:410-421` |
| GitHub Pages 无构建：`.nojekyll` + 仓库根目录，`main` 的每次 push 即发布 | 无 `_config.yml`、无 `pages` workflow、`.github/workflows/` 只有 `tests.yml` |

---

## 2. 权威数据源列表（A/B/C/D/E 分类）

| 类 | 文件 | 归属 | 谁写 | 谁读 |
|---|---|---|---|---|
| **A 权威（人工）** | `js/data.js` 里的元数据字段（title/date/tags/excerpt/series/seriesOrder） | 版本库 | 人（手改）→ 被 `split_posts.py --sync` 规范化覆盖（只补 `readingMinutes`、固定字段顺序） | `app.js`、`split_posts.py`、`gen_feed.py` |
| **A 权威（人工）** | `data/posts/<id>.md` 正文 | 版本库 | 人 | `split_posts.py`、`app.js`（运行时按需） |
| **A 权威（浏览器）** | `js/user-posts.js`（元数据 + **正文内联**） | 版本库 | `publishPost()` 直接 PUT 到 main | `app.js`（首屏加载）、`gen_feed.py` |
| **B 派生** | `js/data.js`（规范化后的整份文件） | 版本库 | `split_posts.py --sync` | 同 A |
| **B 派生** | `data/search-index.json` | 版本库 | `split_posts.py --sync` | `app.js`（首次全文搜索） |
| **B 派生** | `data/posts/manifest.json` | 版本库 | `split_posts.py --sync` | CI（`--check`）、审计 |
| **B 派生** | `feed.xml` | 版本库 | `gen_feed.py` | 订阅者、`sw.js` 之外的静态资源 |
| **B 派生** | `sitemap.xml`、`notes/*.html`、`js/note-slugs.js` | 版本库 | `gen_notes_pages.js` | 搜索引擎 |
| **C 运行时组合** | `POSTS.concat(USER_POSTS)` → `getAllPosts()`（按日期倒序） | 浏览器内存 | `app.js` | 首页/标签/搜索/归档/上下篇 |
| **C 运行时组合** | 搜索 = 内存元数据（标题/摘要/标签）+ `search-index.json` 正文 + `USER_POSTS` 内联正文 | 浏览器内存 | `app.js` | 搜索页 |
| **D 静态发布产物** | `main` 根目录整棵树（无构建） | GitHub Pages | push | 访客 |
| **E 仅校验** | `data/posts/manifest.json` | 版本库 | `split_posts.py` | `--check`、CI |

> **结论：A 类实际有两个互不隶属的权威来源**（版本库里的 `data.js+md` vs 浏览器直推的 `user-posts.js`），而 B 类派生数据只认前者。这就是本轮所有缺陷的根源。

---

## 3. 派生文件依赖矩阵

| 派生文件 | 依赖 | 生成者 | 触发方式 | 过期后的后果 |
|---|---|---|---|---|
| `js/data.js`（规范化） | `js/data.js` 原字段 + `data/posts/*.md`（算 readingMinutes） | `split_posts.py --sync` | 人工 | `--check` 失败；CI 红 |
| `data/search-index.json` | `data/posts/*.md` | 同上 | 人工 | **全文搜索命中旧正文**（复现 P14）；`--check` 失败 |
| `data/posts/manifest.json` | `data.js` + `*.md` 的哈希 | 同上 | 人工 | `--check` 失败；无法发现正文被改 |
| `feed.xml` | `js/data.js` **+ `js/user-posts.js`** | `gen_feed.py` | 人工 | `feed-check` 失败；订阅者看不到新文章 |
| `sitemap.xml` | 课程笔记数据 | `gen_notes_pages.js` | 人工 | 新笔记不被收录（**与文章无关**） |
| `js/note-slugs.js` | 课程笔记 | 同上 | 人工 | 静态页链接失效 |
| 浏览器可见内容 | `data.js` + `user-posts.js` + `search-index.json` + `data/posts/*.md` | 运行时 | 页面加载 | 见第 4 节 P16 |

**关键不对称**：`user-posts.js` 同时是"权威源"和"派生链路的输入之一"，却既不在 `split_posts.py` 的输入里，也不在任何 `--check` 的比对范围内——只有 `gen_feed.py` 认它。于是"浏览器发布"能影响 RSS，却影响不到搜索语料和完整性清单。

---

## 4. 统一发布契约（10 个问题的决策）

> 决策原则：**单一权威源 + 派生可重建 + 发布原子化**。以下为建议契约，7C-2 按其实现。

### 4.1 是否继续保持两个权威来源？

**否。** 目标形态：`data/posts/<id>.md`（正文）+ `js/data.js`（元数据）是唯一权威；`js/user-posts.js` 退化为**只读兼容层**（继续加载，但只用于展示尚未迁移的旧文章），长期删除。

### 4.2 编辑器文章是否迁移为独立 Markdown？

**是。** 一次性迁移：把 `USER_POSTS[i].content` 写成 `data/posts/<id>.md`，把元数据并入 `data.js`，再从 `user-posts.js` 移除。迁移后编辑器发布改为"生成同一份 md + 元数据的变更集"，不再写内联正文。

理由（可量化）：`user-posts.js` 是**首屏资源**（`FIRST_SCREEN_ASSETS`），内联正文会随文章数线性增长首屏体积；而 md 走按需加载 + 运行期缓存。当前 18 篇 md 合计 102 938 B，若改成内联就是每次首屏多 100 KB。

### 4.3 若短期保留两套来源，如何保证统一 ID 与搜索语义？

短期（7C-2a 之前）必须补三条最小约束：

1. **ID 全局唯一**：`publishPost()` 在 PUT 前用 `getAllPosts()` 查重，命中即拒绝（现在完全没有查重，见 P4/P13）。
2. **搜索语料合并**：`split_posts.py` 增加 `--user-posts`，把 `USER_POSTS` 的正文并入 `search-index.json`（或单独一个 `user_search_index.json`），否则"编辑器文章只能搜到标题/摘要"。
3. **RSS 重复 ID 视为错误**：`gen_feed.py` 现在只 `[WARN]` 然后继续（见 P13），应改为非 0 退出。

### 4.4 RSS 应在什么时机生成？

在**构建阶段**（本地 `python gen_feed.py` 或 7C-2 的统一构建脚本），与源变更**同一个 commit** 提交；CI 用 `--check` 做门禁。**不应**由浏览器发布时生成（浏览器无法原子提交多文件，见 4.8）。

### 4.5 修改或删除文章时怎样更新派生数据？

| 操作 | 权威动作 | 派生动作 |
|---|---|---|
| 新增 | 加元数据 + 放 `.md` | `split_posts --sync` + `gen_feed.py` |
| 改正文 | 改 `.md` | `split_posts --sync` + `gen_feed.py` |
| 改标题/标签/日期/摘要 | 改 `data.js` | `split_posts --sync` + `gen_feed.py` |
| 改 id | 改元数据 id + 重命名 `.md` | 同上 + 旧链接 404 提示 |
| 删除 | 删元数据 | `split_posts --sync --prune` + `gen_feed.py` |

当前编辑器只能做"新增"，其余全部需要手工改仓库——这是 P2/P3 的根因。

### 4.6 sitemap 当前管理哪些静态 URL？

`gen_notes_pages.js` 生成，共 18 条：`/`、`/notes/`、15 个 `/notes/<slug>.html`、`/feed.xml`。**不含任何文章页**。

### 4.7 `#/post/:id` 是否有可索引的静态替代页？

**没有。** 文章是纯 hash 路由，服务器只收到 `/blog/`，爬虫拿不到独立 URL。

合法替代方案（择一，7C-2 再定）：

- **（推荐）生成静态壳** `posts/<id>.html`：真实 URL + `<link rel="canonical">` + og 标签 + 正文文本（供抓取），页内脚本再跳到 `#/post/<id>`。代价：内容重复、需要 SW 与 canonical 规则配合。
- **不做**：只保留 RSS 分发。可以接受——但必须明确"文章不被搜索引擎索引"是产品选择，而不是缺陷。

**禁止**把 `https://…/blog/#/post/<id>` 直接写进 `sitemap.xml`：`#` 之后不会被发送到服务器，Google 明确不索引带 fragment 的独立页面，写进去只会制造无效条目。

### 4.8 如何保证生成器失败时不发布不一致的文件集合？

三层保护（现状已有两层，缺第三层）：

1. **原子写**：`split_posts.py` 全部产物先算好、再 `tempfile + os.replace`（已验证：P12 中途失败时 `search-index.json`/`manifest.json` 字节不变）。
2. **失败即非 0**：生成器失败不写文件（P11 已验证 feed 不被覆盖）。
3. **发布原子性（缺）**：目前"源 + 派生"靠人肉在同一个 commit 里提交。浏览器路径**无法**做到——Contents API 的 `PUT /contents/{path}` 一次只能提交一个文件，要同时更新 md + 元数据 + 搜索语料 + manifest + feed 需要 5 次请求，任一次失败就是半更新。**这是策略 A 的结构性缺陷，不是实现细节。**

### 4.9 如何避免 Actions 自动提交导致无限循环？

- 现状没有任何自动提交 job，**当前不存在循环风险**。
- 若将来加自动生成：**不要**在 `push` 里 commit 回同一分支。可行做法：
  1. 只在 `pull_request` 上跑 `--check`（只读，不写）；
  2. 若必须自动修复，用 `paths-ignore` 排除派生产物 + commit message 带 `[skip ci]`；
  3. 用默认 `GITHUB_TOKEN` 推送的提交**不会**再触发新的 workflow（GitHub 的既定行为），但用 PAT 推送会——所以自动化只能用内置 token。

### 4.10 如何确保失败后能安全回滚？

- 源与派生在**同一个 commit**里 → 回滚 = `git revert <sha>`，一步回到一致状态。
- GitHub Pages 从 `main` 的某个 commit 出整棵树 → 不存在"部分文件已部署"的中间态（部署原子性由平台保证）。
- 文章历史不删除：删除操作只是"从元数据移除 + prune 正文"，正文在 git 历史里仍可找回。
- 浏览器发布路径（策略 A）**没有**这个性质：一次失败的 PUT 可能已经改了 `user-posts.js`，而 RSS 未更新 → 回滚需要人工判断改了哪几个文件。

---

## 5. 生成器保护要求（对 7C-2 的硬性要求）

| # | 要求 | 现状 |
|---|---|---|
| G1 | 原子写（临时文件 + `os.replace`），失败不覆盖 | ✅ 已有（split_posts、gen_notes_pages） |
| G2 | 失败非 0 退出，且不写任何文件 | ✅ 已有（gen_feed / split_posts） |
| G3 | 相同输入 → 相同输出（可幂等重跑） | ✅ 已有（`--now` 固定时间戳） |
| G4 | `--check` 只读校验，供 CI 门禁 | ✅ 已有 |
| G5 | 不执行内容（不 eval / 不 vm） | ✅ 已有（结构化字面量扫描） |
| G6 | **id 唯一性必须是错误，不是警告** | ❌ 缺（P13：`[WARN]` 后继续） |
| G7 | **派生文件必须覆盖全部权威源**（含 user-posts.js） | ❌ 缺（搜索语料/清单不含编辑器文章） |
| G8 | **单一构建入口**（一条命令产出全部派生数据） | ❌ 缺（split_posts + gen_feed + gen_notes_pages 三个入口，顺序靠人记） |
| G9 | 产物与源同 commit 提交的机制（禁止半更新） | ❌ 缺（浏览器路径无法做到） |

---

## 6. CI/CD 方案比较

### 方案 A：保持浏览器直推 main（现状 + 事后生成）

| 维度 | 评价 |
|---|---|
| 编辑器改动量 | 0 |
| GitHub 权限 | fine-grained PAT：`Contents: Read and write`（有写权限的 Token 存在于浏览器） |
| 触发时序 | PUT 成功 → Pages 立刻发布（秒级）→ CI 随后跑，**失败时内容已经在线上** |
| 发布中间状态 | **有**：文章可见但 RSS/搜索语料/清单未更新（P10 已复现：`feed --check` 失败） |
| 半更新风险 | **结构性存在**：Contents API 单次只写一个文件 |
| 文章丢失风险 | 中：GET 解析失败时已中止（P5/P7），但 404 误判会按"新建"覆盖（P6） |
| 失败恢复 | 差：需要人工判断改了哪几个文件 |
| 长期维护 | 差：每次发布都要人工补跑生成器 |

### 方案 B：受控分支 + 构建后统一发布（推荐）

| 维度 | 评价 |
|---|---|
| 编辑器改动量 | 中：提交目标从 `main` 改为 `content/queue` 分支（或直接开 PR），并附上 md + 元数据两份载荷 |
| GitHub 权限 | 同上（`Contents: Read and write`），但写的是非受保护分支 |
| 触发时序 | 提交 → CI 校验（`--check` + 测试）→ 人工合并 → Pages 从 main 发布（一次性、原子） |
| 发布中间状态 | 无：main 上永远是"源 + 派生"一致的树 |
| 半更新风险 | 低：合并前由 CI 校验；构建在合并前完成 |
| 文章丢失风险 | 低：内容在分支上，合并失败不影响线上 |
| 失败恢复 | 好：删分支即可；main 未被污染 |
| 长期维护 | 好：单一入口 + 门禁 |

### 推荐

**方案 B**，分两步落地：

- **B-lite（7C-2a，低风险）**：编辑器仍用 Contents API，但目标分支改为 `content/queue`，且一次提交只写**一个**文件（`content/queue/<id>.json`，含元数据 + 正文）。main 不受影响。人工（或 7C-2b 的 CI）把队列条目转成 `data/posts/<id>.md` + 元数据，跑生成器，一个 commit 合并。
- **B-full（7C-2b）**：队列条目 → 自动开 PR（Git Data API 可做多文件原子提交），PR 上跑 `--check` + 26 套回归，绿了再人工合并。

**剩余风险（必须明说）**：

1. 浏览器仍持有写权限 Token：一旦 Token 泄露，攻击者可以直接推 main。缓解：fine-grained token 只授 `Contents: Read and write` 且限定仓库；更彻底的做法是让浏览器**不再持有**写 Token，改用 GitHub OAuth App / 服务端代理（本轮不实现）。
2. `content/queue/` 分支如果长期不合并，队列会堆积；需要"待处理队列"提示（未来）。
3. B-lite 仍然是"人工合并"，不解决"忘记合并"的问题——但至少线上不会出现不一致。
4. Pages 无构建步骤意味着"发布"= push，因此**任何**直接推 main 的路径都会绕过门禁（包括人工 `git push --force`）。

**不修改 GitHub Pages 设置**（保持"从分支根目录发布"），本轮只读取配置。

---

## 7. 对旧功能的影响分析（7C-2 实施时会碰到的）

| 现有能力 | 影响 | 处理 |
|---|---|---|
| 编辑器发布（P1 路径） | 目标分支改变；返回提示文案要改 | 保持 UI 不变，只改 `filePath`/`branch` 与提示 |
| `USER_POSTS` 内联正文 | 迁移后为空数组 | 保留文件与 `index.html` 的 `<script>`，避免 SW 快照清单变化 |
| 首屏体积（Batch 6 性能） | 迁移后变小（正文不再内联） | 需 `CACHE_VERSION` 递增 |
| 全文搜索（Batch 6C） | 编辑器文章正文将进入 `search-index.json` | 语义变强，但索引体积增长 |
| RSS（Batch 6C） | 仍是 `data.js + user-posts.js` | 迁移后 user-posts 为空，行为不变 |
| SW 快照一致性（Batch 6B1.1） | `user-posts.js` 仍在 `FIRST_SCREEN_ASSETS` | 不改清单，只改内容 → 不触发快照结构变化 |
| `test20`（发布 → 搜索一致性） | 断言"发布只 PUT 一次""内存 USER_POSTS 增加" | 7C-2 需同步更新该用例 |
| `test18` / `split-check` / `feed-check` | 依赖 md 与 manifest 结构 | 迁移产生的 md 必须符合 `SAFE_ID` 与日期格式 |
| Markdown 安全（DOMPurify） | 无影响 | 正文仍走同一渲染管线 |

---

## 8. 回退方案

| 层级 | 操作 |
|---|---|
| 本轮（审计） | 只新增 3 份报告 + 1 个取证脚本 + `.gitignore` 一行；`git revert <sha>` 即完全回退，不影响任何运行时 |
| 7C-2 迁移（未来） | 迁移脚本必须自带 `--export-user-posts`（md → `user-posts.js` 逆向导出），并在迁移 commit 前打 tag（`pre-7c2-content-migration`） |
| 线上异常 | GitHub Pages 从 main 单 commit 发布 → `git revert` 该 commit 并 push，1-2 分钟内回到上一版 |
| SW 缓存 | 任何影响首屏资源的改动都要递增 `CACHE_VERSION`，否则老访客继续用旧快照 |
| 文章内容 | 删除只改元数据 + prune 正文，正文永远在 git 历史里，可 `git show <sha>:data/posts/<id>.md` 找回 |

---

## 9. 结论

1. 当前系统**能正确渲染**，但"发布"不是原子的、派生的覆盖面不完整：编辑器文章进不了 `search-index.json`、`manifest.json`、`data/posts/*.md`，只有 `feed.xml` 认它。
2. 缺陷集中在**两个权威源 + 单一文件写入**这两点，而不是渲染或安全机制（Markdown 净化、SW 快照、按需加载都遵守得很好）。
3. 推荐方案 B（受控分支 + 构建后统一发布），并以"单一构建入口 + id 唯一性硬失败 + 派生覆盖全部权威源"作为 7C-2 的三条验收线。
4. 详细复现见 `BATCH7C1_REPRODUCTION.md`；下一阶段的文件级改动见 `BATCH7C2_IMPLEMENTATION_PLAN.md`。
