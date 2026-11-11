# Batch 7C-2：统一文章数据构建器与发布完整性保护

分支：`feature/batch7c-publishing-pipeline`
基线：`8256680`（Batch 7C-1 审计）
本轮：只新增/调整构建器与测试，**未触碰**任何真实文章、产物、学习资料与 Registry。

| 项 | 结果 |
|---|---|
| 新增 | `scripts/build_content.py`、`tests/test23_content_build.py` |
| 修改 | `scripts/run_tests.py`（+5 行：接入 `test23` 与 `content-check`） |
| 未修改 | `js/data.js`、`data/posts/*`、`data/search-index.json`、`data/posts/manifest.json`、`feed.xml`、`js/user-posts.js`、`js/app.js`、`sw.js`、`sitemap.xml` |
| 回归 | **PASS 28 / FAIL 0 / SKIP 0 / BLOCKED 0**（原 26 套 + 新增 2 套） |
| 真实仓库校验 | `python scripts/build_content.py --check` → OK（18 篇 / 66 495 字符 / 4 份产物全一致） |

---

## 1. 新旧数据源差异

| 维度 | 7C-1（改前） | 7C-2（改后） |
|---|---|---|
| 权威源 | 两套互不隶属：`data.js + md` 与 `js/user-posts.js` | **同一套契约下的两个输入**：`data.js + md` 为主，`user-posts.js` 为**兼容期输入** |
| 身份集合 | 内置 18 篇与编辑器文章各自为政，重复 ID 无检测 | **全集合 id 唯一**，跨源重复直接失败 |
| 搜索语料 | 只含内置正文（编辑器文章搜不到正文） | 含全部有效文章（内置 md 正文 + 兼容期内联正文） |
| Manifest | 只描述内置 md | 描述全部有效文章；兼容期条目带 `origin` / `file: null` / `legacyUserPosts` 计数 |
| RSS | `gen_feed.py` 独立读两个源、重复 ID 只警告 | 由统一构建器产出，**重复 ID 失败**，条目集合 = 身份集合 |
| 生成入口 | `split_posts.py` + `gen_feed.py` 两个入口，顺序靠人记 | **`scripts/build_content.py` 单一入口**，一条命令重建/校验全部 5 份产物 |
| 失败语义 | 各自原子写，但跨产物无统一判定 | 计算全在内存 → 全量校验 → 才允许写；任一阶段失败零写入 |

> 兼容期不改变"谁是真源"：`js/data.js` 仍是唯一元数据源，md 仍是唯一正文源；`user-posts.js` 只被**读取**，构建器从不写它（C18c：旧文章不会被写进 `js/data.js`）。

---

## 2. 实际修改文件

```
A  scripts/build_content.py            +499 行   统一构建器（--check / --dry-run / --sync / --root）
A  tests/test23_content_build.py       +417 行   数据生命周期测试（38 项断言）
M  scripts/run_tests.py                +5 行     接入 test23 与 content-check（26 → 28 套）
```

复用了既有的两套已验证实现，**没有重写 Batch 6 的任何逻辑**：

- `scripts/split_posts.py`：`parse_js_file` / `load_body` / `normalize_meta` / `reading_minutes` / `meta_canonical` / `sha256_bytes` / `build` / `SAFE_ID` / `DATE_RE`
- `gen_feed.py`：`find_assignment` / `_skip_balanced`（结构化 JS 扫描，不 eval）、`build_feed`、`parse_now`

---

## 3. 统一文章契约

| 字段 | 必填 | 规则 | 失败信息 |
|---|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]*$`；**跨全部来源唯一** | `文章 id 重复：'x' 同时出现在 <A> 与 <B>（不会静默丢弃任何一边…）` |
| `title` | ✅ | 非空字符串 | `…的 title 不能为空` |
| `date` | ✅ | `YYYY-MM-DD` 且真实日期 | `…的 date 不是真实日期：'2026-13-45'` |
| `tags` | ✅ | 非空字符串数组 | `…的 tags 必须是非空字符串数组` |
| `excerpt` | ✅ | 字符串（可为空串） | `…的 excerpt 必须是字符串` |
| `content` | ✅ | 内置= `data/posts/<id>.md`；兼容期= `USER_POSTS[i].content`；非空 | `缺少正文文件: data/posts/x.md` / `…缺少正文 content` |
| `readingMinutes` | 派生 | 由正文算出（与 `app.js` 的 `readingTime()` 等价） | — |
| `series`/`seriesOrder`/未知字段 | 可选 | 原样保留（不吃掉未来新增的元数据） | — |

**边界划分**

| 层 | 内容 | 谁可以写 |
|---|---|---|
| 权威（A） | `js/data.js` 元数据、`data/posts/*.md` 正文、`js/user-posts.js`（兼容期） | 人 / 7C-3 的队列导入 |
| 派生（B） | `js/data.js`（规范化）、`search-index.json`、`manifest.json`、`feed.xml` | **只有** `build_content.py --sync` |
| 运行时（C） | `POSTS ∪ USER_POSTS` 的内存视图、搜索、渲染 | 浏览器（只读，不落盘） |

**拒绝的输入**（全部非 0 退出、零写入）：缺 id / 非法 id / id 重复 / 缺标题 / 非法日期 / tags 非法 / excerpt 非字符串 / 缺正文 / 正文非 UTF-8 / 孤儿正文 / `js/data.js` 里仍带内联 `content`（C12–C15、C23）。

---

## 4. 生成器架构

```
collect()                      # 读全部权威源
  ├─ sp.parse_js_file(data.js) → 原始元数据 + TAG_ORDER
  ├─ sp.load_body(<id>.md)     → 正文（缺文件/非法 UTF-8 立刻失败）
  ├─ load_user_posts(user-posts.js) → 兼容期条目（含内联 content，严格校验）
  └─ 全局 id 唯一性检查（跨源 + 跨条目）
build_artifacts()              # 全量计算，全在内存
  ├─ js/data.js                ← sp.build()（Batch 6 的规范化 + 固定字段顺序）
  ├─ data/search-index.json    ← { id: 正文 }（内置 + 兼容期），sort_keys
  ├─ data/posts/manifest.json  ← sp.build() 的 manifest + 兼容期条目 + legacyUserPosts
  └─ feed.xml                  ← g.build_feed(按日期倒序的合并集合, --now)
diff_artifacts()               # 与磁盘逐字节比较（feed 只忽略 lastBuildDate）
write_artifacts()              # 同目录临时文件 → fsync → 逐个 os.replace → 回读校验
```

模式语义：

| 模式 | 计算 | 比较 | 写盘 | 退出码 |
|---|---|---|---|---|
| `--check`（默认） | ✅ | ✅ | ❌ | 0 一致 / 1 不一致或输入非法 |
| `--dry-run` | ✅ | ✅ | ❌ | 0（列出将变更的文件） / 1 输入非法 |
| `--sync` | ✅ | ✅ | ✅（持锁） | 0 / 1 失败 / 3 并发占用 |

确定性：同一输入 + 同一 `--now` → 五份产物**逐字节相同**（C2、C21）。`--now` 只影响 `<lastBuildDate>`，比较时被归一化（与 `gen_feed.py --check` 同策略）。

**与既有生成器的关系（重要）**

`build_content.py` 不是第三个平行实现：内置部分的序列化完全走 `split_posts.build()`，因此 **`USER_POSTS` 为空时它的三份产物与 `split_posts.py --sync` 逐字节一致**，`feed.xml` 与 `gen_feed.py` 一致。实测：真实仓库上三者同时 `--check` 全绿，且 `--dry-run` 报告"待更新 0 个文件"。

---

## 5. 失败原子性边界

明确区分三件事：

| 边界 | 保证 | 证据 |
|---|---|---|
| **输入/计算失败** | **零写入**（产物一个字节都不变） | C12/C13/C14/C15（重复 id、缺正文、非法 UTF-8、非法日期）、C16（计算期失败后四份产物哈希不变） |
| **单文件写入** | 临时文件 + `fsync` + `os.replace` + 回读校验 | `write_artifacts()` |
| **整个文件集合** | ❌ **不是事务**。中途崩溃/失败可能留下"新的 data.js + 旧的 search-index" | C16b：把 `search-index.json` 换成不可替换的目录 → `--sync` 非 0；随后 `--check` 也非 0，**半成品不会被判定为可发布** |

因此发布门禁必须同时跑 `--check`：只有当"磁盘 == 重新计算结果"时才允许合并。这也是本轮把它接进 `run_tests.py`（`content-check`）的原因。

并发：`--sync` 持 `.content-build.lock`（`O_CREAT|O_EXCL` + pid），冲突时返回 **3**；陈旧锁按**年龄**（>10 分钟）回收。刻意不用 `os.kill(pid, 0)` 探测存活——Windows 上 `os.kill` 会把 0 当成退出码去 `TerminateProcess`，等于杀掉另一个正在构建的进程。

---

## 6. 正文与搜索索引一致性

- 语料键集合 == 有效文章 id 集合（`--check` 与 `verify` 双向校验；C1c/C4b/C18/C20）。
- 语料值 == 该文章正文（内置读 md，兼容期读 `content`）。
- 改正文 → 语料立即变化、feed 不变（C5/C5c）；改摘要 → feed 变、语料不变（C7）；改标签 → 元数据变、feed 不变（C8）。
- 删除文章：元数据移除后正文成为孤儿 → **失败**并列出路径，不删除任何文件（C10/C10c）；人工清掉正文后才允许同步（C10d）。

---

## 7. RSS 生成验证

| 场景 | 结果 |
|---|---|
| 与 `gen_feed.py --check` 一致 | 真实仓库：两者都 OK（18 条） |
| 条目集合 == 身份集合 | C1c/C4b/C18（含兼容期条目） |
| 顺序 | 按 `date` 倒序、同日保持数据源顺序（C9 改日期后 `post-a` 排首位） |
| 正文变更是否影响 RSS | 否（C5c：改 md 后 feed 哈希不变） |
| 重复 id | **中止**（C19：同 id 的内置 + 用户文章 → 非 0，且四份产物字节不变；不再"只警告然后各自选一边"） |
| 构建时间 | 只影响 `<lastBuildDate>`；`--check` 归一化后比较，允许时间变化、不允许内容无故变化 |

---

## 8. 并发处理测试

```
Popen(build --sync) × 2   → 退出码 [0, 3]
```

- 一个拿到锁写入，另一个立即 `[BUSY]` 退出 3（`--lock-timeout` 可等待）。
- 之后 `--check` 通过、四份产物可解析、身份集合一致、锁文件无残留（C17/C17b/C17c）。
- 注：锁是**协作式**的（只约束本构建器）；对 NFS/共享盘不做承诺。

---

## 9. 完整回归

```
npm ci                                  # 未重新安装（node_modules 未变），依赖仍按 package-lock
python scripts/run_tests.py
```

| 项 | 结果 |
|---|---|
| 套件 | **PASS 28 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 原 26 套 | 全部 PASS，未改任何断言/阈值/跳过 |
| 新增 `test23` | **38/38**（C1–C23） |
| 新增 `content-check` | PASS（真实仓库五份产物一致） |
| 真实 Chromium | `browser` 37/37、`sw-consistency` 35/35、`sw-upgrade` 25/25、`mobile-notes` 224/224、`course-seo` 45/45、`papers-deeplink` 63/63 |
| SW 缓存一致性 | 保持（`CACHE_VERSION` 未变，本轮不改首屏资源） |
| 18 篇文章标题/正文/顺序 | **未变**（`git diff` 为空） |
| 74 条学习资料与 Registry | **未变**（`test22` 19/19；本机 `.papers-id` 未触碰） |

B7C-1 的取证脚本 `tests/batch7c1/publish_scenarios.js` **原样保留**（它记录的是旧缺陷，不能当修复后的正向测试）；修复后的正确性由独立的 `test23` 断言，两者互不替代。

---

## 10. 剩余风险

| # | 风险 | 说明 / 缓解 |
|---|---|---|
| R1 | 编辑器仍写 `js/user-posts.js`（内联正文） | 本轮按要求不改编辑器；7C-3 改为写队列 → 导入 md |
| R2 | 兼容期 `user-posts.js` 非空时，`split_posts.py --check` 会与 `build_content --check` 判定不同 | 前者不认识 user posts。这是**迁移信号**：先把旧文章导入 md，再删 `legacyUserPosts` |
| R3 | 多文件集合不是事务 | 见第 5 节；靠 `--check` 门禁兜底，不假装原子 |
| R4 | 浏览器持有 `Contents: write` Token | 未变；需要服务端代理才能根治（7C-3 可选项） |
| R5 | Contents API 单文件 1 MB 上限 | 未变；迁移到独立 md 后单文件远小于上限 |
| R6 | `--allow-orphans` 是逃生阀 | 只影响能否同步，**永不删除**文件；CI 不启用 |
| R7 | 无分支保护时可直接 push main 绕过门禁 | 建议开启 main 保护（不改仓库设置） |
| R8 | 构建锁只约束本工具 | 其他脚本（如 `split_posts.py --sync`）不持锁，混用时仍可能竞争 |

---

## 11. Git Commit

```
336982d   构建：统一内容构建器与发布完整性保护（B7C2）
8256680   审计：发布数据链契约与 16 个场景取证（B7C1）   ← 本轮基线
9e996a3   main（Batch 7B squash 合并）
```

本轮只做本地提交：**不 push、不合并、不部署、不改 main**。

回退：

```bash
git revert --no-edit 336982d        # 只回退构建器与测试，运行时行为不变
```

因为 `js/data.js`、`data/posts/*`、`feed.xml` 一个字节都没改，回退不影响线上任何页面与订阅。

---

## 12. 7C-3 的具体工作流方案

**目标**：让"发布一篇文章"= 一次可回滚的 commit，且不需要人在本地补跑生成器。

```
浏览器（编辑器）
   │  PUT contents/content/queue/<id>.json      ← 单文件、只写非受控分支
   ▼
content/queue（受控分支，不进 Pages）
   │  CI: python scripts/content_queue.py --check
   ▼
scripts/import_user_posts.py  ← 队列 → data/posts/<id>.md + js/data.js 元数据
   │  （--dry-run 默认；冲突/id 重复/缺字段一律失败）
   ▼
python scripts/build_content.py --sync        ← 本轮成果：一条命令产出 5 份产物
   │
   ▼
一个 commit（源 + 派生同 commit）→ PR → CI: build_content --check + 28 套 → 人工合并 → Pages 发布
```

具体改动清单（下一阶段）：

| 文件 | 改动 |
|---|---|
| `scripts/content_queue.py`（新） | 校验 `content/queue/*.json` 的 schema（id/title/date/tags/excerpt/content），坏条目单独报错不阻塞其他条目 |
| `scripts/import_user_posts.py`（新） | 队列/`USER_POSTS` → md + 元数据；`--dry-run` / `--check`；id 冲突失败；幂等 |
| `js/app.js` `publishPost()` | 目标分支与路径改为 `content/queue/<id>.json`；PUT 前用 `getAllPosts()` 查重 id；成功文案改为"已进入待发布队列" |
| `js/app.js` `generatePostId()` | `slug + '-' + 6 位随机`，并查重 |
| `.github/workflows/tests.yml` | 新增 `build_content.py --check` + `content_queue.py --check`（只读，不自动提交） |
| `scripts/split_posts.py` | `--check` 增加"索引键集合 == 元数据 id 集合"（本轮已在 build_content 内实现，可下沉复用） |
| 文档 | README 增补发布流程 |

验收：队列条目 → PR → CI 绿 → 合并后 Pages 一次原子发布；`legacyUserPosts` 归零（`USER_POSTS` 清空、`CACHE_VERSION` 递增）。

```
B7C2_LOCAL_READY
```
