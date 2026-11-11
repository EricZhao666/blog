# Batch 7C-4B：GitHub 发布基础设施分阶段启用

分支：`feature/batch7c-publishing-pipeline`
本轮 HEAD：`3c3edf6`（已推送）
正式 main：`9e996a3`（未改动）

**未初始化远端队列、未创建 PR、未合并 main、未改 Pages 来源、未开启自动写入。**

| 项 | 结果 |
|---|---|
| 本地回归 | **PASS 36 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| Linux CI | run **`42934243943`** · 提交 `3c3edf6` · `node-22 / python-3.12` · **succeeded**（5m20s） |
| 新增 | `tests/test31_gate_contract.py`（17 项） |
| 修改 | `content-gate.yml`（去 paths 过滤）、`content-pipeline.yml`（候选 commit status）、`run_tests.py` |

状态：`B7C4B_LOCAL_READY` + **`B7C4B_ACTIVATION_BLOCKED`**
（`B7C4B_CLOUD_READY` **不声明**：真实 `workflow_dispatch` dry-run 无法执行，见第 5 节。）

---

## 1. 当前 GitHub 设置与可验证证据

| 项 | 证据 | 结论 |
|---|---|---|
| Pages 状态 | `GET https://ericzhao666.github.io/blog/` → **HTTP 200**（5 040 B） | Pages 已启用 |
| Pages 来源 | 仓库无 `pages` 工作流、有 `.nojekyll`、无 `_config.yml` | **"Deploy from a branch"（main 根目录）**：任何 push 到 main 即发布 |
| main 分支保护 | `GET /branches/main/protection` → **403** | **不可读，状态未知**；不能假定已开启 |
| Rulesets | `GET /rulesets` → **403** | 同上 |
| Actions workflow permissions | 工作流内显式声明 | 见第 8 节矩阵 |
| `content/queue` 分支 | `git ls-remote --heads origin` 只有 main + 6 个 feature 分支 | **不存在**（未创建） |

## 2. 工作流启用状态

| 工作流 | 触发 | 本分支上是否可执行 | 说明 |
|---|---|---|---|
| `tests.yml` | `push` / `pull_request` | ✅ 已跑（run 42934243943） | 稳定 |
| `content-gate.yml` | `pull_request` / `workflow_dispatch` | ⏳ 需 PR 或进入默认分支 | 本次已修好"永久 Pending"隐患 |
| `content-pipeline.yml` | `push: content/queue` / `workflow_dispatch` | ⏳ 队列分支不存在 + 未进默认分支 | 默认只读 |

### 本轮发现并修复的两个真问题

**问题 1（会导致 required check 永久挂起）**：`content-gate.yml` 原来在 `pull_request` 上带 `paths:` 过滤。
一旦把它设为 required check，只改无关文件的 PR **不会创建 check run** → 永远 "Expected — Waiting"。
修复：去掉 workflow 级 paths 过滤，改为**每次都跑**，内部用 `git diff --name-only origin/$BASE...HEAD` 判定，
无关变更走明确的 skip 分支并让 job 成功（test31 R1/R2）。

**问题 2（候选 PR 拿不到正式状态）**：`GITHUB_TOKEN` 创建的 PR 不会触发 `pull_request` 工作流，
所以候选 PR 上的 required check 永远不会有结论。
修复：`content-pipeline` 在自己跑完全量回归后，用 **commit status API** 在候选 SHA 上发布
`context=content-candidate, state=success`（test31 R4/R5）。Branch Protection 可以要求这个 context，
不必依赖无法触发的下游工作流。

## 3. 基础设施 PR

**未创建**（任务明确要求"未经单独授权不创建正式 PR"）。已准备好可直接使用的 PR 描述：

```
标题：feat(publish): 内容构建器 + 队列消费 + 候选状态机 + 只读工作流

内容：scripts/{build_content,split_posts,process_content_queue,candidate_pr,content_state,release_candidate}.py
     tests/test23/25/26/28/29/30/31
     .github/workflows/{content-gate,content-pipeline}.yml（默认只读）
     BATCH7C*.md

不含：js/data.js、data/、feed.xml、.papers-id/、任何凭证
合并后仍需人工：建 content/queue、设仓库变量、开 main 保护（见第 9 节）
```

拆分依赖顺序（不得颠倒）：**基础设施脚本 → 工作流（只读）→ 队列分支 → 编辑器切换**。
在 `content/queue` 就绪之前，编辑器仍写 `js/user-posts.js`，生产发布入口不变。

## 4. 队列初始化

**未执行**（需单独授权）。已验证的初始化命令：

```bash
git fetch origin main
git switch -c content/queue origin/main
mkdir -p content/queue
printf '{\n  "note": "content queue placeholder; 真实条目由编辑器写入"\n}\n' > content/queue/.keep.json
git add content/queue/.keep.json
git commit -m "chore(content): 初始化发布队列分支"
git push origin content/queue
```

本地已验证（test31 R9，真实执行）：**空队列 → `NO_CHANGES`，不写 ledger、不建候选目录**。
占位文件缺 `id`，会被消费器当非法条目拒绝，不可能被当成文章发布。

## 5. 真实 dry-run

**未执行 → PENDING**。原因：`workflow_dispatch` 只对**默认分支上存在**的工作流可见；
`content-pipeline.yml` 目前只在特性分支，且 `content/queue` 不存在。

执行条件满足后，命令与预期：

```bash
gh workflow run content-pipeline.yml \
  -f queue_ref=content/queue -f dry_run=true -f allow_write=false
```

预期：`validate` 执行、`candidate` 跳过（`dry_run != 'true'` 为假）、`open-pr` 跳过、
无分支写入、无 PR、无 Pages 部署。这些由 test30 的 8 组合真值表静态证明（dry_run=true 时 0/4 放行），
但**没有云端 run ID**，因此不声明 CLOUD_READY。

## 6. 自动候选 PR 的检查触发设计

```
编辑器 → content/queue（单文件）
   → content-pipeline.validate（只读，校验队列 schema / 现有产物）
   → content-pipeline.candidate（默认只读；授权后）：
        生成候选 → 候选自检 → 候选目录内 npm ci + Chromium + 全量 run_tests.py
        → 哈希留档 → 确认 main 未变 → 推 content/candidate-<sha8>
        → POST /statuses/<candidateSha> {context: content-candidate, state: success}
   → content-pipeline.open-pr（授权后）：确认 main 未变 → 创建/复用 PR
   → 人工 Approve and run content-gate（默认分支就位后）
```

要点：
- 候选 PR 的正式 Status Check = `content-candidate`（commit status），**不是**流水线日志里的 PASS；
- `content-gate` 去掉 paths 过滤后，required check 不会因"没碰内容"而永久 Pending；
- main 更新后，候选的 `base_main_sha` 与当前 main 不一致 → 推送前 / 开 PR 前都会中止（test30 G8/G10）。

## 7. 必需检查与分支保护配置（建议，未生效）

| 设置 | 值 | 现状 |
|---|---|---|
| Require a pull request before merging | 开启（1 个批准） | 未知（API 403） |
| Require status checks | `tests` + `content-candidate`（+ `content` gate 合入默认分支后） | 未配置 |
| Require branches to be up to date | 开启 | 未配置 |
| Block force pushes / 删除 | 开启 | 未配置 |
| Bypass list | 空 | 未配置 |

## 8. 最小权限矩阵（本轮不变）

| Job | contents | pull-requests | statuses | 其他 |
|---|---|---|---|---|
| tests | read | — | — | — |
| content-gate.gate | read | — | — | — |
| content-pipeline.validate | read | — | — | — |
| content-pipeline.candidate | **write** | — | **write**（仅候选 SHA 状态） | — |
| content-pipeline.open-pr | read | **write** | — | — |
| 全局 | `permissions: {}` | | | |

无个人 PAT、无自动合并、无 Pages 改写（test31 R7 按正则断言）。

## 9. 剩余人工授权事项

| # | 事项 | 需要谁 |
|---|---|---|
| 1 | 创建 `content/queue`（占位文件） | 仓库维护者 |
| 2 | 工作流合入默认分支（`workflow_dispatch` 才会出现） | 维护者（PR 合并） |
| 3 | main 分支保护 + required checks（`tests`、`content-candidate`） | 仓库管理员 |
| 4 | 仓库变量 `CONTENT_PIPELINE_WRITE=enabled`（开启后才自动写） | 维护者 |
| 5 | 首次 dry-run `workflow_dispatch`（dry_run=true / allow_write=false） | 维护者 |
| 6 | 首次真实候选 PR（无害 Fixture） | 维护者 |

## 10. 失败回退

| 场景 | 操作 |
|---|---|
| 回退本轮 | `git revert --no-edit 3c3edf6` |
| 候选分支出错 | 删除 `content/candidate-*`，关闭对应 PR；main 不受影响 |
| 门禁误报 | 用 `release_candidate.py --work-dir` 复现，禁止直接放宽断言 |
| 队列里出现坏条目 | 消费器会拒绝并给出文件名；删掉该文件即可，不影响其他条目 |
| 已合并的候选有问题 | `git revert <merge-sha>`；并把 ledger 条目 `content_state.py --to failed` |

## 11. 下一阶段（7C-5）：正式部署门禁

1. Pages 来源切到 **GitHub Actions**，新增 `deploy.yml`：`needs: [tests, content-gate, content-pipeline]`。
2. 部署 job 只拿 `pages: write` + `id-token: write`。
3. 部署后回写 `content_state.py --deploy success --deploy-run <id>`（合并状态与部署状态分离）。
4. 保留"从分支发布"作为 24 小时回退路径。
5. 用无害 Fixture 走完整链路：队列 → 候选 → PR → 合并 → 部署 → 状态回写。

---

```
B7C4B_LOCAL_READY
B7C4B_ACTIVATION_BLOCKED
```
