# Batch 7C-3A：文章发布队列与 CI 构建验证

分支：`feature/batch7c-publishing-pipeline`
基线：`c47b671`（Batch 7C-2）
本轮：把编辑器从"直推 main"改成"提交到受控队列分支"，并把完整文章集合的门禁统一到同一套实现；
新增隔离构建闸门与两个专项测试。**未改 GitHub Pages 设置、未推送、未合并、未部署。**

| 项 | 结果 |
|---|---|
| 新增 | `tests/test24_publish_queue.js`、`tests/test25_release_pipeline.py`、`scripts/release_candidate.py`、`.github/workflows/content-gate.yml` |
| 修改 | `js/app.js`（发布流程）、`scripts/split_posts.py`（兼容期文章进统一集合）、`scripts/build_content.py`（改为委派）、`scripts/run_tests.py`（30 套 + UTF-8 输出）、`tests/test10.js`、`tests/test11.js`、`tests/test20_publish_search.js`、`tests/test23_content_build.py` |
| 未修改 | `js/data.js`、`data/posts/*`、`data/search-index.json`、`data/posts/manifest.json`、`feed.xml`、`js/user-posts.js`、`sw.js`、`sitemap.xml`、`js/papers.js`（74 条资料） |
| 回归 | **PASS 30 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 真实数据 | 零改动（`git diff` 不含任何数据/产物文件） |

---

## 1. 编辑器新旧发布流程

### 旧（7C-2 之前）

```
编辑器 → GET  js/user-posts.js（整文件，必须能完整解析，否则中止）
       → 把新文章 unshift 进去
       → PUT  js/user-posts.js（写回 main，带 sha）
       → 内存 USER_POSTS.unshift → 跳首页，提示"发布成功"
```

问题：一次发布要**重写整个历史文件**；只写一个文件却想表达"改了文章库"；`main` 立即上线，
RSS/搜索语料/清单要人工补；解析失败或 404 误判会清空历史。

### 新（本轮）

```
编辑器 → 本地校验（标题/正文/id 合法/不与已发布文章撞 id）
       → GET  /repos/{o}/{r}/branches/content/queue        （分支必须已存在）
       → GET  /repos/{o}/{r}/contents/content/queue/<id>.json（已存在则拒绝，不覆盖）
       → PUT  /repos/{o}/{r}/contents/content/queue/<id>.json
              { message, content(base64 JSON), branch: "content/queue" }
       → 提示"已提交到发布队列（尚未上线）"，不跳转
```

要点对照任务书 12 条：

| # | 要求 | 实现 |
|---|---|---|
| 1 | 明确指定目标分支 | PUT body 里恒有 `branch: 'content/queue'`（Q1 断言） |
| 2 | 不默认写 main | 代码里没有任何 `branch: 'main'` 或缺省分支路径 |
| 3 | 分支不存在时明确提示、不静默创建 | 404 → "发布队列分支 content/queue 不存在…请先创建"（Q2） |
| 4 | 保留 SHA 冲突保护 | PUT 不带 sha（新建文件）；冲突由 409/422 拦截 |
| 5 | 409/422 不覆盖 | 明确提示"未覆盖任何内容"（Q5/Q6） |
| 6 | 网络失败保留草稿 | `flushDraft(true)`（Q8/Q8b） |
| 7 | 404 区分资源不存在与仓库访问异常 | 分支 404 时再探 `GET /repos/{o}/{r}`：能读=分支缺失，读不到=仓库/权限问题（Q2/Q3） |
| 8 | 提交前检测合法 ID、空正文、明显错误 | `validateNewPost()`：标题/正文/id 正则/日期/标签/id 冲突（Q10-Q12，零请求） |
| 9 | 同 ID 不静默覆盖 | 队列已存在同 id → 拒绝（Q4）；本地已有同 id → 拒绝（Q12） |
| 10 | 区分"已提交队列"与"已上线" | 成功文案含"已提交到发布队列…（尚未上线）"，且不跳首页（Q13/Q13b） |
| 11 | 不泄露 Token | 只在 `Authorization` 头；URL 与页面文本零出现（Q15/Q15b） |
| 12 | 不改 Markdown 净化与 Token 清除 | 未触碰 `renderMarkdown` / DOMPurify / `clearEditorToken` |

> 单文件写入才是真原子：Contents API 一次只能写一个文件，本轮**不**用多次 PUT 假装"一次提交"。

---

## 2. 队列分支设计

- 分支：`content/queue`（**受控**，不进 Pages；Pages 仍从 `main` 根目录发布）。
- 条目：`content/queue/<id>.json`，schema：
  ```json
  { "id": "post-xxxx", "title": "...", "date": "2026-11-10",
    "tags": ["..."], "excerpt": "...", "content": "# Markdown..." }
  ```
- 一个文章一个文件 ⇒ 天然避免"并发写同一个文件"；同名/同 id 由"已存在即拒绝"保证。
- 编辑器**不**自动建分支：分支缺失要说人先初始化（避免"静默创建不确定的分支"）。
- 规范化步骤（7C-3B 实现）：`content/queue/<id>.json` → `data/posts/<id>.md` + `js/data.js` 元数据 →
  `build_content.py --sync` → 同一个 commit。

**为什么不在浏览器里直接写 md + 元数据**：那是 2 个以上文件，Contents API 无法原子提交；
一旦第二个 PUT 失败就会留下"有正文没元数据"的半成品。队列用单文件承载"一篇待发布文章"，
把多文件问题推迟到 CI 侧（那里可以用一个 commit 提交全部变更）。

---

## 3. 非空 USER_POSTS 的数据一致性

这是 7C-2 遗留的已知问题：`split_posts.py --check` 不认识 `js/user-posts.js`，
一旦兼容期文章存在，它和 `build_content --check` 会给出相反结论。

本轮的处理（不删旧门禁）：

1. `scripts/split_posts.py` 增加兼容期支持（**加法**，不改 Batch 6 的序列化）：
   - `paths()` 增加 `user_posts`；`load_legacy()` / `normalize_legacy()` 严格解析 `USER_POSTS`
   - `collect()` 返回 `legacy`，并做**跨源 id 唯一性检查**
   - `build(..., legacy=None)`：兼容期文章只进 **search-index** 与 **manifest**（`file: null` +
     `origin` + `legacyUserPosts` 计数），**不写进 `js/data.js`、不生成 md**
   - `verify()`：搜索键集合 = 内置 ∪ 兼容期；manifest 条数 = 两者之和
2. `scripts/build_content.py` 改为**委派**：不再自己拼 manifest/搜索语料，直接调
   `split_posts.collect/build`，只额外补 `feed.xml`、锁、三种模式与差异比较。

⇒ 两个门禁从"两套实现"变成"一套实现 + 一层 feed/锁"，**结构上不可能再分叉**。

一致性证据（`test23` C24）：

| 状态 | `split_posts --check` | `build_content --check` |
|---|---|---|
| 空 `USER_POSTS` | 0 | 0 |
| 新增旧文章、未同步 | 1 | 1 |
| 同步之后 | 0 | 0 |

---

## 4. CI 构建与校验边界

### 4.1 三道只读门禁（都可直接进 CI）

| 门禁 | 覆盖 | 写文件 |
|---|---|---|
| `build_content.py --check` | 元数据 / 正文 / 搜索语料 / manifest / feed | 否 |
| `split_posts.py --check` | 结构、逐文件哈希、正文一致性、孤儿检测 | 否 |
| `gen_feed.py --check` | RSS 与数据源一致 | 否 |

职责交接说明：`split-check` **没有**被删除或降级，它继续负责"结构/哈希/正文"；
`content-check` 在它之上补 feed 与构建器语义。两者都进 `run_tests.py`。

### 4.2 隔离构建闸门 `scripts/release_candidate.py`

```
1. git archive <sha> → 临时目录（固定输入版本，不动工作区）
2. build_content --sync   （在隔离目录里重建）
3. build_content --check  （重建后必须自洽）
4. split_posts  --check   （结构/哈希/正文仍要过）
5. 比较"重建前/后"的产物哈希：任何变动 = 仓库里的派生数据过期 → 失败
6. 再 sync 一次：必须逐字节相同（确定性）
7. 可选 --with-tests：在隔离目录跑完整回归（缺 node_modules 则 BLOCKED，退出码 2）
8. 全部通过才写 .release-candidate.json 并打印 CANDIDATE_READY
```

边界（不夸大）：

- **多文件写入成功 ≠ Git 提交成功**：本脚本只证明"这棵树自洽"，不 commit、不 push；
- 写入用"同目录临时文件 + `os.replace`"做到**单文件原子**，整个集合**不是事务**；
  半成品由第 3/5 步检出，失败一律不写标记；
- 隔离目录不写回工作区（R6 断言源目录哈希不变）。

---

## 5. 完整测试结果

```
npm ci                               # node_modules 未变，依赖仍按 package-lock
python scripts/run_tests.py
```

| 套件 | 结果 |
|---|---|
| 总计 | **PASS 30 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| `test10`（发布历史保护，已重定向到队列契约） | 19/19 |
| `test11`（草稿自动保存） | 17/17 |
| `test20`（发布→搜索一致性） | 22/22 |
| `test23`（内容构建生命周期，含 C24） | 41/41 |
| `test24`（**新增**：发布队列） | 29/29 |
| `test25`（**新增**：发布候选闸门） | 13/13 |
| `content-check` / `split-check` / `feed-check` | 全 PASS |
| 真实 Chromium 套件 | `browser` 37、`sw-consistency` 35、`sw-upgrade` 25、`mobile-notes` 224、`course-seo` 45、`papers-deeplink` 63 —— 全 PASS |

**关于旧断言的改写（必须明说）**：`test10` 的 10 个场景原本验证"整文件读 `user-posts.js` 失败时不得 PUT"。
该代码路径已不存在，因此这 10 个场景被**重定向**到新契约的等价（且更强）保证：
"不确定就不写""已存在就不覆盖""只写一个文件""历史文件完全不被触碰"。没有任何断言被删除或放宽；
`test20` 的 P1 由"发布后 USER_POSTS +1"改为"提交队列后 USER_POSTS 不变（尚未上线）"——
这是契约反转，不是放宽，并新增了"提示区分队列/上线"的断言。

未被削弱的保护项：文章正文加载与全文搜索、编辑器草稿（test11）、RSS（feed-check）、
SW 缓存（sw-consistency/sw-upgrade）、Markdown DOMPurify（test16）、74 条资料 ID（test22）、
Batch 7A 移动端与 SEO（mobile-notes/course-seo）、Batch 7B 深链（papers-deeplink）全部 PASS。

---

## 6. 失败注入结果

| 场景 | 期望 | 实测 |
|---|---|---|
| 队列分支不存在 | 中止、不 PUT、提示初始化 | Q2/Q2b/Q2c ✔ |
| 分支 404 但仓库也不可访问 | 提示"仓库不存在或无权访问"（与上一条区分） | Q3 ✔ |
| 队列已存在同 id | 拒绝覆盖 | Q4 ✔ |
| PUT 409 / 422 | 冲突提示、不重试、无第二次 PUT | Q5/Q6 ✔ |
| PUT 5xx | 失败提示、无重试 | Q7 ✔ |
| 网络中断 | 提示 + 草稿保留 | Q8/Q8b ✔ |
| Token 权限不足（403） | 明确提示、不 PUT | Q9/Q9b ✔ |
| 空标题 / 空正文 / 非法 id / 撞已有 id | 本地拦截、**零请求** | Q10-Q12 ✔ |
| Token 泄露 | URL/页面文本零出现 | Q15/Q15b ✔ |
| 源改了但派生没更新 | 闸门失败、无标记 | test25 R2 ✔ |
| 正文非法 UTF-8 | 构建失败、无标记 | R3 ✔ |
| 缺少 `split_posts.py`（结构校验不可用） | 闸门失败（不允许跳过） | R4 ✔ |
| `--with-tests` 缺依赖 | BLOCKED（退出码 2）、无标记 | R5 ✔ |
| 两个发布者同时提交 | 后到者看到"已存在/409"，两边都不覆盖 | Q4 + C8（模拟） ✔ |
| 非空 USER_POSTS 时两个门禁 | 同进同退 | C24 ✔ |

---

## 7. GitHub Actions 权限与触发分析

| 问题 | 结论 |
|---|---|
| **1. 用什么权限** | 本轮草案 `content-gate.yml` 只用 `permissions: contents: read`；不写文件、不提 PR |
| **2. 是否需要 GitHub App / 单独授权** | 只读校验不需要。要做"队列 → 自动 PR"才需要 `contents: write` + `pull-requests: write`（用内置 `GITHUB_TOKEN` 就够） |
| **3. `GITHUB_TOKEN` 产生的提交/PR 能否触发后续工作流** | **不会**。GitHub 的既定行为：用仓库内置 token 推送的提交不会再次触发 `push` 类工作流（需要 `workflow_run` 或 PAT 才能链式触发）。这正好是防循环的基础 |
| **4. 如何避免循环触发** | 三条并用：①自动提交只在 `pull_request`/`workflow_dispatch` 上做，绝不在 `push` 上回写；②提交信息带 `[skip ci]`；③用内置 token（见上条） |
| **5. 并发提交如何避免覆盖** | Git 层面靠分支 + sha 校验（409），应用层面靠"同 id 已存在即拒绝"；Actions 层用 `concurrency: group` 取消同分支旧任务 |
| **6. 如何避免同一来源产生多个冲突 PR** | 队列条目 id 唯一 + "一个 id 只允许一个 PR 分支（`content/queue/<id>`）"；CI 检测已存在的 PR 分支则复用而不是新建（7C-3B 实现） |
| **7. 如何防止无效内容触发 Pages 部署** | Pages 从 `main` 根目录发布 ⇒ 唯一防线是"main 上的内容必须过门禁"。当前**没有**分支保护，因此本轮只能"建议开启 main 保护 + 必须 CI 绿才能合并"；`content-gate` 为 PR 提供该信号 |
| **8. 已提交队列但构建失败的文章怎么办** | 队列条目留在分支上，PR 保持红；作者修好后重新提交同 id（覆盖自己的队列文件）或关闭 PR。`main` 完全不受影响 |
| **9. 如何回滚已部署的不一致版本** | Pages 从单个 commit 出整棵树 → `git revert <sha>` 并 push 即可；SW 缓存的旧外壳需要 `CACHE_VERSION` 递增才会换 |
| **10. 是否需要把 Pages 来源改成 GitHub Actions** | **建议将来改**（可加"部署前必须过 content-gate"的强约束），但本轮按要求**不动**线上设置 |

⚠️ 现状要点：普通测试工作流成功**不代表** Pages 部署受保护——`main` 的每次 push 都会直接上线，
且目前没有分支保护。这是本轮无法在代码里消除的风险（属于仓库设置）。

---

## 8. 下一轮真实 CI 接入的具体方案（7C-3B）

1. **`scripts/content_queue.py`**：校验 `content/queue/*.json` 的 schema（复刻本轮编辑器侧的
   `validateNewPost`），坏条目单独报错不阻塞其他条目。
2. **`scripts/import_user_posts.py`**：队列条目 → `data/posts/<id>.md` + `js/data.js` 元数据；
   `--dry-run` 默认、`--check` 只报告；id 冲突失败；幂等（重复跑无 diff）。
3. **`content-gate.yml` 增补**：`content_queue.py --check` + 隔离目录 `--with-tests`（先 `npm ci`）。
4. **自动 PR（可选，需评审）**：用 Git Data API 在一个 commit 里同时提交
   源（md + data.js）与派生（search-index/manifest/feed），PR 上跑 30 套 + 隔离闸门。
5. **仓库设置（需要人工）**：`main` 分支保护 + 必须 `tests` / `content-gate` 绿才能合并。
6. **队列分支初始化**：`content/queue` 建好后（一次人工操作），编辑器即可使用。

---

## 9. 修改文件和 Commit

```
M  js/app.js                        +196/-  发布改为写 content/queue/<id>.json（本地校验/分支/冲突/文案）
M  scripts/split_posts.py           +130    兼容期 USER_POSTS 进入统一集合（load_legacy/build/verify）
M  scripts/build_content.py         +221/-  改为委派 split_posts，只补 feed/锁/模式
M  scripts/run_tests.py             +18     接入 test24/test25；stdout 改 utf-8（避免 emoji 打印崩溃）
M  tests/test10.js                  +224/-  发布保护场景重定向到队列契约（19 项）
M  tests/test11.js                  +13/-   草稿用例适配新提示与队列桩
M  tests/test20_publish_search.js   +47/-   发布→搜索用例按"提交≠上线"改写（22 项）
M  tests/test23_content_build.py    +26     新增 C24：两个门禁同进同退
A  tests/test24_publish_queue.js            发布队列契约（29 项）
A  tests/test25_release_pipeline.py         发布候选闸门（13 项）
A  scripts/release_candidate.py             隔离构建 + 过期产物检测 + 可部署标记
A  .github/workflows/content-gate.yml       只读门禁草案（不写仓库）
```

提交：`0dd98ff 发布：内容队列与隔离构建闸门（B7C3A）`（本地，未 push）。
基线链：`c47b671`（B7C2）→ `336982d`（B7C2）→ `8256680`（B7C1）→ `9e996a3`（main）。

---

## 10. 回退方式

| 场景 | 操作 |
|---|---|
| 回退本轮全部 | `git revert --no-edit 0dd98ff`（工作区数据零改动，回退不影响线上内容） |
| 只想让编辑器回到"直推 main" | 单独 `git revert` `js/app.js` 那部分改动即可（其余是测试/闸门，不影响运行时） |
| 队列条目已提交但不想发布 | 删除 `content/queue/<id>.json`（或关闭对应 PR）；`main` 与线上完全不受影响 |
| 闸门误报 | 不要改断言；用 `release_candidate.py --work-dir` 复现，定位是"源变了"还是"产物过期" |
| 线上异常（将来） | `git revert` 已合并的发布 commit 并 push；SW 旧外壳需要 `CACHE_VERSION` 递增 |

```
B7C3A_LOCAL_READY
```
