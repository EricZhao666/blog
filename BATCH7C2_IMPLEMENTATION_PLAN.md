# Batch 7C-2 实施计划：发布一致性（单源 + 原子发布）

前置：`BATCH7C1_DATA_CONTRACT.md`（契约）、`BATCH7C1_REPRODUCTION.md`（16 个场景证据）
目标分支：`feature/batch7c-publishing-pipeline`
本轮**不实现**，本文件只给可直接执行的改动清单。

---

## 1. 目标与非目标

### 目标（按优先级）

1. **单一权威源**：文章正文只存在于 `data/posts/<id>.md`，元数据只存在于 `js/data.js`。
2. **派生可重建且覆盖完整**：一条命令产出 search-index / manifest / feed；`--check` 覆盖全部权威源。
3. **发布原子化**：任何一次"发布"都是一次可回滚的 commit，main 上不存在中间状态。
4. **身份唯一**：id 全局唯一，重复即失败（不是警告）。
5. **编辑器不降级**：现有"填表 → 发布"的体验保留，只是落到受控分支。

### 非目标

- 不重构 Batch 6 的数据拆分、SW 快照、Markdown 净化（只在其上加一层）。
- 不改 GitHub Pages 发布方式（仍是 main 根目录直出）。
- 不做服务端（不引入 OAuth App / 后端代理）；Token 仍在浏览器。
- 不做文章静态化（`posts/<id>.html`）——单列为可选工作项 7C-3。

---

## 2. 阶段划分

| 阶段 | 内容 | 可独立合并 | 风险 |
|---|---|---|---|
| **7C-2a** 数据层收口 | 迁移脚本 + 统一构建入口 + id 唯一性硬失败 | 是 | 低（不动 UI） |
| **7C-2b** 发布流改造 | 编辑器改为写 `content/queue/<id>.json`（受控分支） | 是 | 中（改发布路径） |
| **7C-2c** 门禁与自动化 | CI 增加 content-check；队列 → PR（Git Data API 多文件原子提交） | 是 | 中高（涉及写权限与 Actions） |

每个阶段都可以单独回退（见第 6 节）。

---

## 3. 精确修改文件清单

### 3.1 新增

| 文件 | 用途 | 关键约束 |
|---|---|---|
| `scripts/import_user_posts.py` | 把 `js/user-posts.js` 的条目转成 `data/posts/<id>.md` + 在 `js/data.js` 插入元数据 | `--dry-run` 默认；`--check` 只报告差异；冲突（id 已存在且正文不同）必须非 0；幂等（重复跑无 diff） |
| `scripts/build_content.py` | **单一构建入口**：依次跑 `split_posts --sync` → `gen_feed` → 最终一致性校验 | 任一步失败即非 0 且不留半成品；`--check` 模式只校验不写；支持 `--root` 以便测试 |
| `scripts/content_queue.py` | 读取/校验 `content/queue/*.json`（发布队列），可转成"待导入"结构 | 严格 schema 校验；坏条目单独报错不阻塞其他条目 |
| `tests/test23_publish_contract.js` | 新契约的 jsdom 契约测试：发布 target 分支、id 查重、单文件载荷 | 全 mock，不联网 |
| `tests/test24_build_pipeline.py` | `build_content.py` 的幂等/原子性/`--check` 测试（tmp 里的 Fixture） | 全部临时目录，不碰真实数据 |

### 3.2 修改

| 文件 | 改动点 | 说明 |
|---|---|---|
| `js/app.js` · `publishPost()`（约 L2327–2450） | ① 目标分支改为 `content/queue`；② 写入路径改为 `content/queue/<id>.json`；③ 提交前用 `getAllPosts()` 查重 id；④ 成功文案改为"已进入待发布队列" | 保留现有 GET 保护（解析失败/1MB/409/5xx 一律中止）与草稿逻辑 |
| `js/app.js` · `generatePostId()`（L2141） | 改为 `slug + '-' + 6 位随机`，并新增 `ensureUniquePostId()` | 消除同毫秒冲突（P4） |
| `js/app.js` · `getAllPosts()`（L113，排序在 L116） | 增加开发期断言：同 id 重复时 `console.error` 并只保留一条（按 POSTS 优先） | 让 P13b 的"两边不一致"在客户端显性化 |
| `gen_feed.py` · `main()` / `dedupe_posts`（L346、L448） | 重复 id 从 `[WARN]` 改为 `[ABORT]` + 返回 1 | 契约 G6 |
| `scripts/split_posts.py` · 入参与校验 | ① 新增 `--from-user-posts`（把 user posts 正文并入 `search-index.json`，过渡期用）；② `--check` 增加"search-index keys 必须等于元数据 id 集合" | 契约 G7 |
| `.github/workflows/tests.yml` | 新增 step：`python scripts/build_content.py --check`、`python scripts/import_user_posts.py --check` | 只读校验，不自动提交（避免循环） |
| `scripts/run_tests.py` | 追加 `test23`、`test24` | 26 → 28 套 |
| `sw.js` | `CACHE_VERSION` 递增 | 发布路径与首屏数据都变了 |
| `.gitignore` | 增加 `tests/batch7c1/evidence/`、`content/queue/*.tmp` | 本地证据不入库 |
| `js/user-posts.js` | 迁移完成后改为 `const USER_POSTS = [];`（保留文件避免 SW 首屏清单变化） | 迁移脚本产物 |
| `README.md` | 增补"发布流程"一节：编辑器 → 队列 → `build_content.py` → 一次 commit | 让流程可照做 |

### 3.3 迁移脚本的执行顺序（7C-2a 首次运行）

```
1) python scripts/import_user_posts.py --dry-run     # 只报告，不改文件
2) 人工确认清单（id/标题/日期/标签）
3) python scripts/import_user_posts.py               # 写 md + 元数据（user-posts.js 暂不清空）
4) python scripts/build_content.py                   # 重算 search-index / manifest / feed
5) python scripts/import_user_posts.py --check       # 必须 0
6) python scripts/build_content.py --check           # 必须 0
7) python scripts/run_tests.py                       # 28/28
8) 单独一个 commit：内容迁移（源+派生同 commit）
9) 再一个 commit：js/user-posts.js 清空 + CACHE_VERSION 递增
```

当前 `USER_POSTS` 为空数组 → 首次迁移是**空操作**，可以先用"造一条假的 user post"在临时目录验证脚本，再对真实仓库跑 `--dry-run`。这让 7C-2a 可以在零风险下先合并。

---

## 4. 每个改动的验收标准

| 改动 | 验收（可执行） |
|---|---|
| 编辑器官网发布 → 队列 | mock API 下 `PUT` 路径必须是 `content/queue/<id>.json`，且**只写一个文件**；`main` 分支不被触碰 |
| id 查重 | 构造与 `POSTS` 同 id 的发布 → UI 明确拒绝，且不发 PUT |
| 重复 id 硬失败 | `gen_feed.py` 在重复 id 时 `rc != 0`，且 `feed.xml` 不变 |
| 统一构建入口 | 改一篇 md → `build_content.py` → `search-index`/`manifest`/`feed` 三者同时更新；再跑一次无 diff |
| 原子性 | 中途删一个 md → `rc != 0` 且三个产物哈希都不变 |
| CI 门禁 | 故意只改 `data.js` 不重生成 → `build_content.py --check` 让 job 失败 |
| 无循环 | `tests.yml` 只有 `--check` 步骤，工作流内无 `git commit/push` |

---

## 5. 测试计划

| 套件 | 覆盖 | 是否进门禁 |
|---|---|---|
| `test23_publish_contract.js`（新） | 队列路径、单文件、id 查重、GET 损坏/404/1MB/409/5xx 的全部中止行为 | 是 |
| `test24_build_pipeline.py`（新） | `build_content.py` 幂等、`--check`、失败不落盘、并发一次 | 是 |
| `test20_publish_search.js`（改） | "发布 → 首页/搜索可见"改为"队列 → 导入 → 可见" | 是（同步修改，不允许删断言） |
| `tests/batch7c1/publish_scenarios.js` | 16 个场景的**取证**脚本 | **否**（期望值=现状，会常红） |
| 既有 26 套 | 全部保留 | 是 |

要求：不允许通过"放宽阈值/删除断言/跳过套件"让新契约通过；`test20` 的断言应改为**更严**的语义（例如"发布后 `data/posts` 下必然出现新 md"）。

---

## 6. 回退点

| 阶段 | 回退方式 | 残留 |
|---|---|---|
| 7C-2a（迁移） | `git revert <迁移commit>`（源+派生在同一 commit） | `user-posts.js` 若已清空需一并 revert |
| 7C-2b（发布流） | revert 该 commit；浏览器旧版 `app.js` 由 SW 缓存兜底，但**必须**同时把 `CACHE_VERSION` 回退或再递增一次 | 队列分支上的待处理条目仍在（无害） |
| 7C-2c（CI） | 删除 workflow step / 关闭队列 job | 已开的 PR 需手动关闭 |
| 线上事故 | `git revert` + push（Pages 单 commit 发布，1–2 分钟生效） | SW 缓存的旧外壳需要版本号变化才会换 |

---

## 7. 风险与前置条件

| 项 | 说明 |
|---|---|
| 写权限 Token 仍在浏览器 | 方案 B 降低但不消除风险；彻底解决需要服务端代理（7C-3 可选） |
| 队列分支无人处理 | 需要提示/定时检查（可先用 CI 在 main 上跑"队列非空"的提醒 job，只提醒不阻断） |
| 迁移脚本误判 | 必须 `--dry-run` 优先 + 冲突即失败 + 迁移前打 tag |
| `test20` 语义变更 | 属于"契约升级"，需要在 PR 描述里明确说明，不能被视为"改测试掩盖问题" |
| Pages 无构建 | 任何直推 main 都会绕过门禁 → 建议开启 main 分支保护（本阶段只建议，不改仓库设置） |

---

## 8. 交付清单（7C-2 完成时应存在）

1. `scripts/import_user_posts.py`、`scripts/build_content.py`、`scripts/content_queue.py`
2. `tests/test23_publish_contract.js`、`tests/test24_build_pipeline.py`
3. `js/app.js`（队列发布 + id 唯一）、`gen_feed.py`（硬失败）、`scripts/split_posts.py`（覆盖校验）
4. `.github/workflows/tests.yml`（content-check step，无自动提交）
5. `scripts/run_tests.py` 28 套全绿
6. `BATCH7C2_REPORT.md`：迁移前后文章数、id 映射、CI 运行 ID、回退验证
