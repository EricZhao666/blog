# Batch 8A 交付报告：博客手动 PR 发布流程简化

- 基线：`main@56e1e9e`（Batch 7C 已合并）
- 分支：`feature/batch8a-manual-publishing`
- 结论：**本地完成，测试全绿，可手动开 PR**（未 push、未建 PR、未合并 main、未部署）
- 依赖安装：`npm ci` 被本机安全删除守卫拦截（见第 6.2 节），改用 `npm install --no-audit --no-fund`，版本与 `package.json` 一致

---

## 1. 新旧发布流程对比

### 1.1 流程对照

| 阶段 | 旧流程（Batch 7C） | 新流程（Batch 8A） |
| --- | --- | --- |
| 入口 | 编辑器「🚀 发布到 GitHub」 | 编辑器「📤 导出文章」→ 本地 `scripts/import_post.py` |
| 认证 | 浏览器保存 GitHub PAT（session/localStorage） | 不需要任何 Token |
| 网络 | 浏览器直连 `api.github.com`（Contents API） | 编辑器零网络请求 |
| 写入点 | `content/queue/<id>.json`（`content/queue` 分支） | 本地 `data/posts/<id>.md` + `js/data.js` |
| 中间态 | 队列 → CI 消费 → 候选分支 → 候选 PR | 无（本地一次性完成，失败回滚） |
| 自动触发 | `push: content/queue` 自动建候选分支并开 PR | **已删除**（`content-pipeline.yml` 只保留 `workflow_dispatch`） |
| 上线判定 | 合并候选 PR 后由 Pages 部署 | 手动 PR 合并后由 Pages 部署（原有方式不变） |
| 失败表现 | 队列里留半个条目 / 状态不可见 | 拒绝并回滚，仓库零变化 |
| 历史文章保护 | 单文件写队列，但仍依赖 CI 正确消费 | 导入器拒绝覆盖 + 生成器重渲染 + 全量 `--check` |

### 1.2 新流程时序（本地）

```
网页编辑器（#/editor）
  ├─ 写 Markdown / 预览（DOMPurify 净化）/ 草稿自动保存
  └─ 点「导出文章」→ <id>.json（UTF-8，六字段）
        ↓ 人工下载到本机
python scripts/import_post.py --file <id>.json --dry-run   # 只看计划，不写盘
python scripts/import_post.py --file <id>.json --apply     # 写正文 + 元数据 + 派生数据
        ↓
python scripts/build_content.py --check                    # 一致性门禁（CI 同款）
python scripts/run_tests.py                                # 完整回归
        ↓
git add / commit / push feature 分支 → 手动开 PR → 人工确认合并
```

### 1.3 明确保留的能力

- Markdown 编辑、DOMPurify 安全预览、自动保存草稿、手动保存草稿、代码块与表格渲染；
- `scripts/build_content.py`（唯一构建入口）、`split_posts.py`、`gen_feed.py` 的行为与产物格式；
- `js/user-posts.js`（`USER_POSTS`）兼容读取：导入器与构建器都继续识别它，只是不再写入；
- GitHub Pages 现有部署方式（push/merge 到 main 触发）；
- 内容一致性校验（`content-gate.yml`）与完整 CI（`tests.yml`）。

---

## 2. 修改文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `js/app.js` | 改 | 删除 GitHub Token 设置、Contents API 直写、`publishPost`；新增 `buildExportPayload` / `exportPost` / `__downloadText`；`generatePostId` 改为确定性（标题 → id，冲突加 `-2`）；日期改本地时区；保留 `clearLegacyPublishData`（兼容别名 `clearEditorToken`） |
| `scripts/import_post.py` | 新增 | 本地导入器：严格校验 → 冲突检查 → 计划 → 原子落盘 → 派生重建 → `--check` → 失败回滚 |
| `scripts/build_content.py` | 改 | 抽出 `assemble()` / `resolve_source_info()` 供导入器复用（同一套装配与派生逻辑，不重写搜索索引/RSS） |
| `scripts/run_tests.py` | 改 | 新增 `test32` / `test33`；更新 `test8` / `test10` / `test24` 描述 |
| `package.json` | 改 | `test:js` 纳入 `test32_editor_export.js` |
| `.github/workflows/content-pipeline.yml` | 改 | 删除 `on.push: content/queue`（自动候选 PR 生产链），保留 `workflow_dispatch` 与只读校验 |
| `scripts/process_content_queue.py` | 改 | 增加「历史/停用」说明头（不改行为） |
| `scripts/candidate_pr.py` | 改 | 同上 |
| `scripts/content_state.py` | 改 | 同上 |
| `tests/test8.js` | 重写 | 由「Token 存储策略」改为「不收集/不存储 Token + 旧 Token 可清除」 |
| `tests/test10.js` | 重写 | 由「模拟 Contents API 10 分支」改为「零网络 + 零历史写入 + 草稿保留」 |
| `tests/test11.js` | 改 | S6/S7 由「发布成功清稿/失败保稿」改为「导出后保稿/导出失败保稿」 |
| `tests/test20_publish_search.js` | 改 | P1/P4 改走导出契约（删除 GitHub/队列 mock） |
| `tests/test24_publish_queue.js` | 重写 | 旧队列契约退役 → 断言「入口确实不存在」（零网络/零队列/零 Token） |
| `tests/test32_editor_export.js` | 新增 | 导出契约 42 项 |
| `tests/test33_import_post.py` | 新增 | 导入器契约 68 项 |
| `tests/batch7c1/publish_scenarios.js` | 改 | 标注为历史取证脚本（`publishPost` 已删除，A 部分不可再运行） |
| `README.md` | 改 | 结构树、测试清单、发布流程（第 7 节）、Token 边界（第 10.1 节）同步新契约 |

---

## 3. 导出文件规范

编辑器导出的文件是**纯 JSON**（不是 JS、不含注释），UTF-8 编码、无 BOM、以单个 `\n` 结尾：

```json
{
  "id": "batch-8a",
  "title": "中文标题：Batch 8A 导出契约",
  "date": "2026-11-12",
  "tags": ["中文标签", "技术笔记"],
  "excerpt": "摘要（可为空串）",
  "content": "# 一级标题\n\n正文……\n"
}
```

| 字段 | 类型 | 规则（编辑器侧 / 导入器侧） |
| --- | --- | --- |
| `id` | string | 必须匹配 `^[a-z0-9][a-z0-9-]*$`，≤64 字符；不能是 `manifest`；不能是 Windows 设备名（`con/aux/nul/com1…`）；不能与现有文章（`data/posts/*.md`、`js/data.js`、`js/user-posts.js`）重复 |
| `title` | string | 去空白后非空，≤200 字符，不允许换行与控制字符 |
| `date` | string | `YYYY-MM-DD` 且必须是真实日期；编辑器取**本机时区**日期（避免 UTC 跨日） |
| `tags` | string[] | 非空数组，≤30 个，每个 ≤40 字符；导入器去重但保序；新标签自动追加到 `TAG_ORDER` |
| `excerpt` | string | 可为空串，≤2000 字符；为空时 RSS 用标题兜底 |
| `content` | string | 去空白后非空，≤200000 字符；不允许 NUL；导入时 `\r\n`/`\r` 统一为 `\n` |
| 可选 `series` + `seriesOrder` | string / int | 必须成对出现，`seriesOrder` 为非负整数（导出界面不产生，供手工补写） |

**文件名**：`<id>.json`（导出时由 id 决定，不含路径分隔符）。导入器以 JSON 内的 `id` 为准，文件名不是权威。

**导出成功提示**固定包含「本地文件，尚未上线」，并给出下一步命令；**不会**出现「已上线 / 发布成功」字样。

---

## 4. 导入器安全设计

### 4.1 威胁 → 控制

| 风险 | 控制 | 证据 |
| --- | --- | --- |
| 不可信 JSON 里夹带代码 | 只用 `json.loads`（`object_pairs_hook` 拦重复键、`parse_constant` 拦 NaN/Infinity），**从不执行 JS / 不做字符串拼接** | `parse_json()`；test33 I7（`const post = {}`、单引号、截断、重复键、NaN 全部拒绝） |
| 路径逃逸 | id 必须过 `SAFE_ID`；额外拦保留名与 Windows 设备名；文件名由 id 拼 `data/posts/<id>.md` | test33 I8（`../../etc/passwd`、绝对路径、`a/b`、`manifest`、`aux` 全部拒绝且零写入） |
| 覆盖历史正文 | 正文文件存在即冲突（退出码 2）；写前再检查一次 | test33 I4/I5（第二次导入零变化） |
| 破坏 `js/data.js` 其他文章 | 先要求「当前 data.js 就是生成器输出」（否则要求 `build_content.py --sync`），再用 `split_posts.render_data_js` 整份重渲染；只有新条目与 `TAG_ORDER` 变化 | test33 I11（18 篇元数据与正文逐字不变）、I12（手改过的 data.js 被拒绝） |
| 半成品 / 误以为成功 | 计划阶段全部内存计算；写盘顺序「正文 → data.js → 派生数据」；任一步失败（含 Ctrl-C）按备份字节回滚，并再跑一次 `--check` | test33 I9（模拟写 data.js 失败：仓库逐字节复原、无 `.tmp`、无孤儿正文，之后可重新导入成功） |
| 绕过构建器另写搜索索引/RSS | 复用 `build_content.assemble/build_artifacts/write_artifacts`，写后从磁盘重读再构建 | test33 I1/I2/I15（搜索索引、RSS、manifest 全部由统一构建器产出并自检） |
| `USER_POSTS` 兼容被破坏 | 冲突检测覆盖 `js/user-posts.js`；该文件导入前后字节一致 | test33 I13（同 id 冲突；共存时可新增；`user-posts.js` 零改动） |

### 4.2 写盘与回滚顺序

```
[只读阶段] 读 JSON → 校验字段 → 读仓库 → data.js 规范性检查 → 冲突检查 → 计算 artifacts + diff
[写入阶段] 1) data/posts/<id>.md   （新建，存在即中止）
           2) js/data.js           （临时文件 + os.replace）
           3) 重新 bc.collect() → bc.build_artifacts() → bc.write_artifacts()（4 个派生文件）
           4) bc.main --check      （官方一致性门禁）
[失败阶段] 删新正文 → 还原 4 个派生文件 → bc.main --check
           若仍失败：打印 [ROLLBACK-INCOMPLETE] 并列出需要人工核对的文件
```

### 4.3 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（`--dry-run` 也算成功） |
| 1 | 输入不合法 / IO 失败 / 构建失败（已回滚） |
| 2 | 冲突：同 id 已存在（**未做任何写入**） |

### 4.4 明确拒绝的操作

- **修改**已有文章：退出码 2，提示「导入器只支持新增」；
- **删除**文章：无此入口，需手动删元数据并 `build_content.py --sync`（本轮不做，不猜意图）；
- 改 id：等同「新增 + 删除」，同样不支持。

---

## 5. 数据一致性测试

| 断言 | 用例 |
| --- | --- |
| 正文与导出 JSON 逐字一致（中文 / 代码块 / 特殊字符 / emoji） | test32 E2–E4；test33 I2 |
| 元数据被插入 `POSTS` 首位且字段顺序/注释头由生成器保证 | test33 I1 |
| `data/search-index.json` 覆盖新 id 且内容等于正文 | test33 I2（+ `build_content --check`） |
| `feed.xml` 出现新文章标题与深链 | test33 I2（+ `gen_feed --check`） |
| `manifest.json` 的 `contentSha256/contentBytes/contentChars/metaSha256/readingMinutes` 与磁盘一致 | test33 I10（+ `split_posts --check`） |
| 无重复 id（跨 `data/posts`、`data.js`、`user-posts.js`） | test33 I4/I5/I13；`build_content --check` |
| 旧文章完全保留（元数据 + 正文逐字不变） | test33 I11 |
| 导入后三个官方门禁全部通过 | test33 I15 |
| 导出侧不与历史文章冲突、不静默改 `POSTS/USER_POSTS` | test10 C9；test32 E7 |

**没有新增任何独立的搜索索引 / RSS 生成器**：导入器只调用 `scripts/build_content.py` 里已有的装配与派生函数。

---

## 6. 完整回归结果

### 6.1 `python scripts/run_tests.py`

结论：**PASS 38 / FAIL 0 / SKIP 0 / BLOCKED 0**（2026-11-12，本机 Node 24.22.1 + Python 3.12.7，真实 Chromium）

| 分组 | 用例 | 结果 |
| --- | --- | --- |
| 语法 | 56 个 js/py 文件 | 全 OK |
| 前端/编辑器 | audit, test6, test7, **test8**, test9, **test10**, test11, test14, test16, **test20**, **test24**, **test32** | 全 PASS（test20 24/24、test24 22/22、test32 42/42） |
| 生成器/内容 | test12, test13, test15, test17, test18, split-check, test19, test21, test22, test23, **test33**, content-check, feed-check | 全 PASS（test33 68/68） |
| 历史自动化（已停用但仍有代码） | test25, test26, test27, test28, test29, test30, test31 | 全 PASS（未删除任何断言） |
| 真实 Chromium | browser 37/37、sw-consistency 35/35、sw-upgrade 25/25、mobile-notes 224/224、course-seo 45/45、papers-deeplink 63/63 | 全 PASS |

批次要求逐条对应：

- Batch 6 SW 缓存与性能：`browser` / `sw-consistency` / `sw-upgrade` 全绿；
- Batch 7A 移动导航与 SEO：`mobile-notes` / `course-seo` 全绿；
- Batch 7B 持久 ID 与深链：`papers-deeplink` / `test21` / `test22` 全绿；
- Batch 7C 内容完整性保护：`test23` / `content-check` / `test33` 全绿。

### 6.2 关于 `npm ci`

本机执行 `npm ci` 被环境的安全删除守卫拦截（重建 `node_modules` 需一次删除 526 个文件，超过 500 的阈值）：

```
npm error [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":526,"threshold":500,...}
```

该守卫不区分命令意图，且不能用审批绕过。处理方式：

1. `npm install --no-audit --no-fund` 恢复被中断的依赖（`npm ls --depth=0` → `dompurify@3.4.17`、`jsdom@30.1.3`、`playwright@1.64.1`，与 `package.json` 一致）；
2. `package-lock.json` **未被修改**（`git status` 无该项）；
3. 完整回归在此依赖树上全部通过，说明依赖无缺失。

> CI（`tests.yml`）在干净的 `ubuntu-latest` 上仍会正常执行 `npm ci`，不受本机守卫影响。

### 6.3 旧队列测试的处理（不删断言）

| 用例 | 处理 |
| --- | --- |
| `test10.js` | 原「模拟 GitHub Contents API 10 分支」在新架构下不可能成立 → 重写为**更强**的保证（零网络、零历史写入、草稿保留、id 幂等），历史意图写在文件头 |
| `test24_publish_queue.js` | 原队列契约退役 → 重写为「入口确实不存在」（静态符号 + 运行时零请求），保留原 Q 组想保护的四件事 |
| `test8.js` | Token 存储策略随功能下线 → 重写为「不收集/不存储 + 旧 Token 可清除」，比原来更严 |
| `test20` / `test11` | 只替换动作（publish → export），其余断言与场景保持 |
| `test25`–`test31` | 后端自动化代码未删除，测试**原样保留并全绿**（见第 7 节） |
| `tests/batch7c1/publish_scenarios.js` | 从未被 `run_tests.py` 收录，标注为历史取证脚本 |

---

## 7. 不再使用的自动化代码处理方式

| 对象 | 处理 | 理由 |
| --- | --- | --- |
| `content-pipeline.yml` 的 `on.push: content/queue` | **删除** | 这是自动候选 PR 的唯一生产触发器；删除后不会再有「入队即建候选分支/开 PR」 |
| `content-pipeline.yml` 其余部分（validate/candidate/open-pr） | **保留**，仅 `workflow_dispatch`，文件头写明已停用 | 内容校验仍有价值；确认无人依赖前不整体删除 |
| `content-gate.yml` | **保留不动** | 对手动 PR 有价值（required check、只读、无 paths 过滤），`test31` 覆盖 |
| `tests.yml` | 保留不动 | 完整 CI |
| `scripts/process_content_queue.py` | 保留，加「历史/停用」说明头 | 仍被 test26/test29/test31 覆盖；删除需单独决策 |
| `scripts/candidate_pr.py` | 保留，加说明头 | 同上（test27） |
| `scripts/content_state.py` | 保留，加说明头 | 同上（test28） |
| `scripts/release_candidate.py` | **保留且仍在用** | `content-gate.yml` 的隔离重建步骤依赖它 |
| `content/queue` 目录 | 无需存在 | 本地仓库没有该目录；新流程不依赖它（test24 N3 验证导出时不查分支） |
| `tests/batch7c1/publish_scenarios.js` | 标注历史用途 | 取证材料，保留可追溯性 |

**后续如需彻底移除**（建议单独批次）：删除 `content-pipeline.yml` + `candidate_pr.py` + `content_state.py` + `process_content_queue.py` + `tests/test25–test29`，并把 `content-gate.yml` 的隔离重建改为直接调 `build_content.py`。

---

## 8. 剩余风险

1. **`content-pipeline.yml` 仍可被人工 `workflow_dispatch` 触发**：默认 `dry_run=true` + `allow_write=false`，但要彻底杜绝误用，建议按第 7 节末段删除。
2. **回滚的原子性边界**：进程被强杀（SIGKILL/断电）时来不及回滚，可能留下「正文已写、元数据未写」的中间态；下一次 `build_content.py --check` 会以「孤儿正文」报错（不会静默上线），但需要人工处理。写盘使用临时文件 + `os.replace`，单文件不会写坏。
3. **导出文件的 id 稳定性**：id 由标题确定性生成；标题不变则重复导出同名同 id（幂等）。若两篇文章标题完全相同，第二篇会得到 `-2` 后缀；跨会话重复导入同一篇仍会被冲突检查挡住，但「先导出 A、又导出 A 的副本并改名」仍需人工判断。
4. **浏览器下载行为**：`exportPost` 依赖 `<a download>` + Blob；极少数浏览器在「下载被策略禁用」时会抛错，此时提示「导出失败、草稿已保留」，不会静默丢失内容。
5. **旧 Token 不会自动清除**：需要用户点一次「🧹 清除旧版 GitHub Token」。代码已不再读取该键，但留在浏览器里的字符串仍是敏感数据。
6. **导入器只支持新增**：修改/删除必须手工操作（`data/posts/<id>.md` + `build_content.py --sync`），这是刻意的保守选择。
7. **`data.js` 必须处于生成器规范状态**：若有人手改过格式，导入器会先要求 `--sync`（不会替你顺手重排）。

---

## 9. Git 提交与回退方法

```bash
# 本批次提交（本地，未 push）
git log --oneline -3
#   见下节「提交记录」

# 查看改动范围
git --no-pager diff main --stat

# 回退方式一：丢弃本次提交（本地未 push，最干净）
git reset --hard main

# 回退方式二：保留历史，反向提交
git revert <commit>

# 回退方式三：只回退某个文件
git checkout main -- js/app.js

# 回退某个已导入的文章（导入后但未合并）
git rm data/posts/<id>.md
python scripts/build_content.py --sync
```

> 注意：`git reset --hard` 只能在**未 push** 的本地分支使用；本批次遵守「不 push、不建 PR、不合并 main、不部署」。

**提交记录（本地，未 push）**

| 提交 | 内容 |
| --- | --- |
| `a92a8a5` | 功能：编辑器改为导出文章 + 本地导入器（B8A）——18 个文件，+1806 / −886 |
| 紧随其后 | 文档：B8A 交付报告（本文件） |

回退整个批次：`git reset --hard main`（本分支未 push，安全）。

---

## 10. 手动 PR 操作说明

```bash
# 0) 前置：分支已就绪、依赖已装
cd E:\work_funnycode\blog
git checkout feature/batch8a-manual-publishing
npm install            # 或 npm ci（CI 上）

# 1) 写文章
#    浏览器打开 index.html → 「编辑」 → 写 Markdown → 「📤 导出文章」
#    浏览器会下载 <id>.json（默认在「下载」目录）

# 2) 先在本地校验（不写任何文件）
python scripts/import_post.py --file "C:\Users\<你>\Downloads\<id>.json" --dry-run

# 3) 确认无误后导入
python scripts/import_post.py --file "C:\Users\<你>\Downloads\<id>.json" --apply

# 4) 复核改动（应只有 1 个新 md + 4 个派生文件）
git status --short
git --no-pager diff --stat

# 5) 门禁 + 完整回归
python scripts/build_content.py --check
python scripts/run_tests.py

# 6) 提交并推送分支（不推 main）
git checkout -b feature/post-<id>
git add data/posts/<id>.md js/data.js data/search-index.json data/posts/manifest.json feed.xml
git commit -m "post: <标题>"
git push -u origin feature/post-<id>

# 7) 在 GitHub 网页上手动创建 PR（base: main ← compare: feature/post-<id>）
#    等待 content-gate / tests 变绿 → 人工确认 → Merge
#    合并后 GitHub Pages 自动构建（约 30 秒 ~ 2 分钟）

# 8) 发布后自检
#    https://ericzhao666.github.io/blog/feed.xml?cb=1      （条目数与 lastBuildDate）
#    https://ericzhao666.github.io/blog/#/post/<id>        （正文可读）
```

**失败处理**

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 退出码 2 + `已存在 id` | 这篇文章已经导入过 | 换标题得到新 id，或确认是同一篇则不重复导入 |
| 退出码 1 + `请先运行 build_content.py --sync` | `data.js` 不是生成器输出 | 先 `--sync` 并提交该改动，再重新导入 |
| 退出码 1 + `已回滚` | 写盘/构建中途失败 | 仓库未被改动，排查（磁盘/权限/构建）后重试 |
| `[ROLLBACK-INCOMPLETE]` | 回滚本身失败（极少见） | 按提示手工核对，必要时 `git checkout -- js/data.js data feed.xml` |

---

## 附：本批次未做的事（明确边界）

- 未 push、未创建 PR、未合并 main、未部署；
- 未修改 GitHub Pages 部署方式；
- 未删除任何历史自动化脚本或测试断言（只停用自动触发并标注历史用途）；
- 未新增第二套搜索索引 / RSS / 元数据生成器。
