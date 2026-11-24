# BATCH9B2R_REPORT.md — Batch 9B-2R：知识索引构建与发布契约兼容修复

状态：**B9B2R_PR_READY**（六套 CI 失败套件本地 RED→GREEN；生产代码遗漏真修；D1–D5 专项写入既有套件；最终以**最新提交**的 PR #38 CI 为准，不自动合并、不部署、不进入 9C-2）

分支：`feat/batch9b2-knowledge-graph`（沿用 PR #38，不新建分支）
修复前 HEAD：`c9b80e9`（B9B2_PR_READY，CI tests #149/#150 = 78 PASS / 6 FAIL）
修复提交：见 PR #38 最新提交（`fix(content): integrate link index into import rollback and release pipeline`）
main 基线：`08aa7ba`
未改动：SW `CACHE_VERSION=2026-11-24-3`、图谱 UI/可视化、WikiLink v1 语法、9B-1 推荐权重、知识库 schema、实验室数学、正式文章正文、测试调度器、`tests.yml` 默认命令。
未执行：生产内容导入、部署、合并、站内任何正式文章改写。

## 1. 六个 CI 失败套件的根因（两类，不是六种）

CI tests #149（push）与 #150（pull_request）稳定复现同一组失败，本地定向复现一致（RED 日志：`tests/reports/b9b2r-red-run1.txt`）。

| 套件 | CI/本地失败项 | 直接原因 | 根因类别 |
|---|---|---|---|
| test25 | R1 / R1b / R2 / R5 | 隔离 fixture 的 `scripts/` 只复制 build_content/split_posts/gen_feed | **A：fixture 未复制 `content_links.py`** → `ModuleNotFoundError`，隔离构建必失败 |
| test26 | Q1（连带 Q1d ledger 缺失） | 同上 | A |
| test27 | W11（完整候选 `--check`） | 同上：候选目录缺 content_links.py，check 直接报错 | A |
| test28 | S1 / S1b | 同上：队列消费在 fixture 内 `--sync` 失败 → 无 candidate 记录 | A |
| test33 | I14（断言"更新 4 个"）、I15（`--check`） | fixture 缺 content_links.py **且**缺索引本身；dry-run 变化集合断言写死 4 | A + **C：旧断言写死四产物** |
| test34 | U1（dry-run/apply） | 同 A | A |

补充：test25 R1c 仍断言标记里 `len(artifacts)==4`；test26 `merge_candidate` / test28 `merge_back` 的候选→仓库同步列表没有 `data/content-links.json`（候选同步会丢索引）。

**结论**：6 套失败不是 6 个独立缺陷，而是 9B-2 只把索引接进 `build_artifacts`，没有接进旧内容发布体系的派生契约 + 隔离 fixture 未带新模块。

## 2. 真实生产代码遗漏（必须真修，禁止只改测试断言）

| 位置 | 原状 | 影响 | 修复 |
|---|---|---|---|
| `scripts/import_post.py:85` | `DERIVED_FILES` = 4 项 | 导入前备份与失败回滚不含索引 → 回滚后索引可能停在"半新半旧" | `DERIVED_FILES = bc.DERIVED_ARTIFACTS`（5 项） |
| `scripts/release_candidate.py:43` | `ARTIFACTS` = 4 项 | 快照/过期漂移/可重复性/`.release-candidate.json` 都不含索引 → **索引过期也能拿到 CANDIDATE_READY** | `ARTIFACTS = list(bc.DERIVED_ARTIFACTS)` |
| `.github/workflows/content-pipeline.yml:222` | 哈希循环 4 文件 | 候选哈希留档不覆盖索引 | 循环 5 项（与 Python 清单一致） |
| `.github/workflows/content-pipeline.yml:225` | `cut -c1-300` | **4 条时已约 350 字符 → 尾部被截掉**，等于宣称"完整清单"却少一项；加第 5 项更严重 | 去掉字符截断，改为完整逗号串（5 条约 460 字符，远低于单值上限） |
| `.github/workflows/content-pipeline.yml:246` | `git add -A js/data.js data feed.xml content/ledger.json` | `data` 通配虽已覆盖索引，但清单不可读、易误删 | 显式列出 `data/content-links.json` |

**统一常量（最小改动，不做框架重构）**：`scripts/build_content.py` 新增 `DERIVED_ARTIFACTS`（`js/data.js`、`data/search-index.json`、`data/posts/manifest.json`、`feed.xml`、`data/content-links.json`），
`import_post` 与 `release_candidate` 复用（二者本来就 `import build_content as bc`），工作流用 `test27 W13` 静态校验两者不得分叉。没有新增抽象层，没有改 `write_artifacts` / `diff_artifacts` / `BuildLock` 语义。

## 3. 完整派生产物契约（修复后逐条对齐）

| 生命周期 | 是否覆盖 `content-links.json` | 证据 |
|---|---|---|
| `build --sync` 生成 | 是（`build_artifacts` 内） | test23 / content-check / test33 I15 |
| `build --check` 缺失与过期 | 是 | test27 W11c（删索引 → 失败）；test33 I15 |
| `--dry-run` 变化报告 | 是（`diff_artifacts` 按 artifacts 字典） | test33 I14（"待更新 5 个" + 五个文件名全在输出里） |
| `import_post` 新增 / 更新文章 | 是（`write_artifacts` 全量写） | test33 I1/I15、test34 U1/U14 |
| 导入前备份 / 失败回滚 | 是（5 项全备份，`_read_bytes` 缺文件记 None） | **D1 / D2 字节级恢复** |
| `release_candidate` 快照 | 是（`snapshot(ARTIFACTS)`） | test25 R1c（标记 5 个键）、R6/R7 |
| 候选过期产物检测 | 是（`--sync` 改动任一产物即 FAIL） | **D3：只篡改索引 → 拒绝** |
| 重复构建确定性 | 是（`snapshot` 相等） | test25 R7、D1/D2、D4 |
| 队列消费 / 候选目录同步 | 是（`process_content_queue` 走 `write_artifacts`；测试 `merge_candidate`/`merge_back` 已补索引） | test26 Q1/Q17/Q10、test28 S1、D4 |
| 候选哈希留档（CI） | 是（5 项，无截断） | test27 W13 / W13b / W13c |

## 4. 隔离测试与权威源一致性（Task C）

修复原则：**不复制站点整份索引**，而是让 fixture 同时携带索引的生成器和全部权威源，使 fixture 内索引与 fixture 自身内容严格一致（既有 fixture 用仓库产物做"自洽基线"，这样也保留了"提交产物必须可由提交源重建"的检测能力）。

每个 fixture 增补：`scripts/content_links.py`、`data/content-links.json`、`js/courses.js`、`js/course-notes.js`、`js/papers.js`、`js/codefiles.js`、`js/projects.js`、`js/note-slugs.js`。

断言修订（不删断言、不无条件通过）：

- `test33 I14`：`'待更新 4 个'` → `'待更新 5 个'`，并新增 I14b **断言五个产物名全部出现在 dry-run 输出**（真实变化集合，而不是写死数字了事）。
- `test25 R1c`：`len(artifacts)==4` → `sorted(keys)==DERIVED`（断言真实键集合）。
- `test25 R6/R7` 的快照列表 → 5 项。
- `test27 W11`：保留"删 search-index → 失败"；新增 **W11c 删 `data/content-links.json` → 必须失败**。
- `test26/Q17` 的"四份产物身份集合一致"保留原语义（比对 search/manifest/feed 身份集合，不是数量断言），未改成空断言。

## 5. D1–D5 专项验证（写入既有套件，避免新增套件影响 CI 矩阵）

| 编号 | 场景 | 注入点 | 关键断言 | 结果 |
|---|---|---|---|---|
| D1 | 新增文章失败回滚（test33） | `run_check` 在"索引已替换、最终校验前"被替换为抛错（且仅在索引字节已变化时触发，证明注入点有效性） | 新正文不存在；`snapshot` 里 5 个派生产物**逐字节**等于导入前；`content-links.json` 字节级恢复；`build_content --check` 通过；回滚时锁文件仍在（`lock_at_rollback == [True]`） | PASS |
| D2 | 更新文章失败回滚（test34） | 同上；更新稿含 WikiLink + 显式内链，索引 `bySource` 真实变化 | 原正文逐字节恢复；元数据/索引/全部产物逐字节恢复；`--check` 通过；回滚在锁内 | PASS |
| D3 | 发布候选过期索引（test25 R2c） | 只把 `data/content-links.json` 里一个节点标题改掉，其余 4 个产物保持原样 | 闸门 FAIL 且输出点名 `data/content-links.json`；不写标记；不写回源目录（源索引仍是过期字节）；未"自动重建后宣称可部署" | PASS |
| D4 | 正常内容生命周期（test26） | 隔离目录新增带 WikiLink 的文章 → 候选；再用 `modify` 移除引用 | 节点增加；显式边增加（wikilink + markdown 两条不同 via）；`byTarget` 记录新来源；同一候选目录 `--sync` 两次索引字节级一致；其他正文零改动；移除后边与反向索引同步收缩；其他文章 6 条显式边不变；候选 `--check` 通过 | PASS |
| D5 | BuildLock 临界区 | 与 D1 同一次注入 | 回滚发生在**同一把锁内**（不再"锁外备份 + 释放锁后回滚"）；失败后锁已释放；随后可正常完成下一次导入 | PASS |

**D5 对应的真实缺陷**：`apply_add_plan` 原本在 `with BuildLock` **之前**取备份、在 `with` **之后**回滚。竞态：A 锁外备份 → A 持锁写入失败 → 释放锁 → B 持锁成功提交 → A 才回滚，把 B 刚提交的字节覆盖回旧值。修复：备份与回滚都移入同一临界区；`_rollback` 内部的 `run_check` 走 `--check`（只读、无锁），**没有嵌套同一把锁**。`apply_update_plan` 同步收紧。

## 6. RED / GREEN 证据

RED（`tests/reports/b9b2r-red-run1.txt`，c9b80e9，本地定向）：

```
test25 FAIL 8/12   test26 FAIL   test27 FAIL 18/19
test28 FAIL        test33 FAIL 66/68   test34 FAIL 38/67
汇总 PASS 0 / FAIL 6      总耗时 61.7s
```

GREEN（`tests/reports/b9b2r-green-run1.txt`，本轮修复后）：

```
test25 PASS 17/17   test26 PASS 32/32   test27 PASS 23/23
test28 PASS 19/19   test33 PASS 78/78   test34 PASS 74/74
汇总 PASS 6 / FAIL 0      总耗时 117.0s（六套累计 243 项）
```

受影响专项（`tests/reports/b9b2r-affected-run1.txt`）：`build-lock`、`test23`、`test29`、`test30`、`test31`、`content-check`、`split-check`、`feed-check`、`content-links`、`knowledge-graph` = **PASS 10 / FAIL 0**（46.5s）。
浏览器专项（`tests/reports/b9b2r-graph-run1.txt`）：`graph-experience` **PASS**（37.1s，54 项三引擎未回归）。

真实仓库自检：`python scripts/build_content.py --check` → rc=0（文章 18 篇，元数据/正文/搜索语料/清单/feed/索引一致且可由当前输入重建）；`git diff --check` 干净。

## 7. 范围与边界（本轮未做的事）

- 未改图谱可视化/UI 布局（`js/graph-demo.js`、`css/style.css` 零改动）。
- 未改 WikiLink v1 语法（未发现与之直接相关的已复现缺陷）。
- 未改 9B-1 推荐权重、知识库 schema、实验室数学、正式文章正文。
- 未改 `sw.js` 与 `CACHE_VERSION`（`2026-11-24-3` 保持）。
- 未改 `scripts/run_tests.py` 的调度器与 `.github/workflows/tests.yml` 默认命令；**没有新增套件**（D1–D5 全部落在既有六套里，CI 矩阵不变）。
- 工作流权限、触发、写入门控、候选过期检查、禁止自动合并机制**均未放宽**；未触发任何真实内容发布。
- 未做全站代码审计，只改与被复制/被哈希/被回滚/被同步的派生契约直接相关的点。

## 8. 剩余风险

1. **CI 最终结论未回填**：本轮以最新提交的 PR #38 CI 为准；在 CI 跑完前不宣称 84 套全绿，也不引用 `c9b80e9` 的旧结果。
2. **fixture 依赖"索引权威源清单"**：六个 fixture 现在显式带上 6 个 js 源文件。若将来新增参与索引生成的权威源（如新的 `js/*.js`），fixture 需要同步补一行，否则会表现为"索引与 fixture 不一致"的失败（**失败是安全方向**，不会静默放过）。
3. **`test25` / `test26` 依赖 PATH 里的 `git`**：本地未把 `C:\Program Files\Git\cmd` 加进 PATH 时，会出现 `WinError 2`（`git archive` / `rev-parse` 不可用），这是本机环境问题，不是代码回归；CI Ubuntu 自带 git，不受影响。本轮本地验证前已显式把 git 加入 PATH。
4. **工作流哈希留档仍是"每行 sha + 路径"的逗号串**：已去掉截断，但未改成 JSON；`hashes` 输出目前只有留档作用（PR 正文未消费），改动风险最小。
5. **`--check` 只校验"能否由当前输入重建"**，不证明"这份索引曾被人工审阅"；内容质量仍是评审责任。

## 9. 耗时与平台成本（实测口径）

| 阶段 | 墙钟 |
|---|---|
| Task A 定向 RED 复现（六套，后台） | 61.7s（含环境/语法 10.1s） |
| Task B 生产代码契约修复（含读码定位） | ≈12 min |
| Task C 六套 fixture + 断言修订 + 逐套迭代 | ≈14 min |
| Task D D1–D5 编写与调试 | ≈8 min |
| Task E 六套 GREEN + 受影响 10 专项 + 浏览器专项 | 117.0 + 46.5 + 37.1 = 200.6s |
| 文档与提交 | ≈5 min |
| **合计** | **≈40 min 墙钟**（超过 30 min 检查点；优先保证了构建与发布正确性，未压缩验证） |

平台成本：全程本地 Windows + 本地 Python/Node，未调用外部付费模型；CI 仅 `content-gate #42` PASS 记录，本轮未新增云端构建。测试资源占用：六套 110.1s（串行，峰值 1 worker）、受影响专项 38.8s、浏览器专项 29.9s。
