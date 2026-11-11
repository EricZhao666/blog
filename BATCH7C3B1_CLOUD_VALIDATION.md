# Batch 7C-3B.1：云端 CI 与发布候选状态机验收

分支：`feature/batch7c-publishing-pipeline`
本轮：把本地实现推到真实 GitHub CI，补候选状态机（candidate / merge / deploy 三者分离）并加测试。
**未合并 main、未发布文章、未切换 Pages 来源、未初始化生产 `content/queue`。**

| 项 | 结果 |
|---|---|
| 远端 HEAD | `3f784e7d4334aac50cdd51683cccb8b1ede48be1` |
| Linux CI | run **`42766386472`** · job `node-22 / python-3.12` · **succeeded**（约 5 分钟） |
| 本地回归 | **PASS 33 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 新增 | `scripts/content_state.py`、`tests/test28_candidate_state.py`（19 项） |
| 修正 | `process_content_queue.py` 幂等判定（支持"删除后重新添加同内容"）+ 记录 `baseSha` |

---

## 1. 实际 Git 状态

```
3f784e7  发布：候选状态机与幂等消费修正（B7C3B.1）        ← 已推送
8683bd0  文档：B7C3B 报告记录提交哈希
e5d579b  发布：内容队列消费与候选 PR 门禁（B7C3B）
1fa69c9  文档：B7C3A 报告记录提交哈希
c47b671  文档：B7C2 报告记录提交哈希
336982d  构建：统一内容构建器与发布完整性保护（B7C2）
8256680  审计：发布数据链契约与 16 个场景取证（B7C1）
9e996a3  origin/main（Batch 7B squash 合并）
```

- 工作区干净；本地 `main` 与 `origin/main` 一致（未改动）。
- 相对 main 共 7 个提交，**全部为新增脚本/测试/文档**，无文章数据改动。
- 推送方式：`git push -u origin feature/batch7c-publishing-pipeline`（普通推送，无 force）。

## 2. 远端提交

```
$ git ls-remote origin refs/heads/feature/batch7c-publishing-pipeline
3f784e7d4334aac50cdd51683cccb8b1ede48be1
```

与本地 `HEAD` 逐字符一致（`git rev-parse HEAD` = 同一 SHA），说明推送没有触发任何改写。

## 3. Linux CI 结果

| 项 | 值 |
|---|---|
| Workflow | `tests`（`.github/workflows/tests.yml`，`on: push` + `pull_request`） |
| Run ID | **42766386472** |
| Job | `node-22 / python-3.12` |
| 结论 | **succeeded**（提交检查页 `This job succeeded`） |
| 耗时 | 约 5 分 8 秒（页面显示 5m8s / 5m4s / 655s 同一次运行的阶段计时） |
| 触发方式 | push 到特性分支 |

> 说明：本轮 GitHub API 对未认证请求限流，Run ID 与耗时取自 Actions 页面/提交检查页；
> 结论以页面上的 `This job succeeded` 为准，未仅凭 YAML 推断。

## 4. 真实触发链证据

| 问题 | 实测/规则 |
|---|---|
| `tests.yml` 在特性分支上会跑吗 | **会**（`on: push` 无分支过滤）→ run 42766386472 |
| `content-gate.yml`（`pull_request` + `workflow_dispatch`）跑了吗 | **没有**。没有 PR，且 `workflow_dispatch` 只对**默认分支上存在**的工作流生效；该文件目前只在特性分支 |
| `content-pipeline.yml`（`push: content/queue`）跑了吗 | **没有**。`content/queue` 分支尚不存在（按任务要求未初始化） |
| `GITHUB_TOKEN` 创建的 PR 会自动触发 `pull_request` 工作流吗 | **不会**（GitHub 既定行为，需人工 "Approve and run" 或 App/PAT）→ 7C-3B 已让 pipeline 在候选分支上自跑校验 |
| `GITHUB_TOKEN` 推送的分支会再次触发 `push` 工作流吗 | **不会** → 候选分支 push 不会造成循环 |
| 循环触发风险 | 本仓库无自动提交回写步骤；`concurrency` 已按分支分组 |
| 只读 Job 能否访问所需文件 | 能：`contents: read` 足够读取队列与脚本；写权限只在 candidate / open-pr job |

**结论**：新工作流处于 **PENDING**（需要先合并到默认分支，或先建 `content/queue` 分支 + 人工批准），本轮不做未经授权的初始化。

## 5. 候选状态机

三件事分开记录，互不冒充：

| 维度 | 字段 | 含义 |
|---|---|---|
| 候选 | `status ∈ pending/candidate/published/closed/failed` | PR 生命周期 |
| 合并 | `merge.sha` / `merge.at` | Git 上确实合并了 |
| 部署 | `deploy.status ∈ unknown/pending/success/failed` + `runId` | 线上确实生效了 |

`merge` 有值 ≠ `deploy` 成功；`published` 也不代表已部署到 Pages。

转换表（白名单，越界即拒绝）：

```
pending   → candidate, failed
candidate → published, closed, failed
failed    → candidate, closed
closed    → candidate
published → （终态）
```

| 场景 | 结果 |
|---|---|
| S1 candidate 创建 + `baseSha` | ✔ 记录候选基线 |
| S2 重复提交同一队列项 | ✔ `NO_CHANGES`，ledger 不新增 |
| S3 PR/构建失败 → 重试 | ✔ `failed → candidate` |
| S4 PR 关闭不合并 | ✔ `closed`，无 merge/deploy 字段 |
| S5 合并 | ✔ `published` + `merge.sha` |
| S6 状态写入失败 | ✔ 非 0 且原文件字节不变 |
| S7 删除后重新添加相同内容 | ✔ 可再次生成候选（幂等键改为"该 id 的最后一条记录"） |
| S8 非法转换 | ✔ `candidate → pending` 被拒绝 |
| S9 ledger 损坏 | ✔ 拒绝并说明 JSON 错误 |
| S10 main 更新使候选过期 | ✔ `[STALE]` + 非 0 |
| S11 已合并但部署失败 | ✔ `published` + `deploy.failed(runId)` 并存 |
| S12 同一内容既发布又候选 | ✔ `validate` 拒绝 |
| S13 多个候选同时过期 | ✔ 一次全部报出 |

测试：`tests/test28_candidate_state.py` **19/19 PASS**（本地，无网络）。

## 6. 剩余 GitHub 权限要求

| # | 需要什么 | 用途 | 状态 |
|---|---|---|---|
| P1 | 创建 `content/queue` 分支 | 编辑器发布目标 | **PENDING**（需显式授权） |
| P2 | `contents: write`（candidate job） | 推候选分支 | 已在 workflow 内声明，云端未实测 |
| P3 | `pull-requests: write`（open-pr job） | 建 PR | 同上 |
| P4 | 新工作流进入默认分支 | `workflow_dispatch` 可用 | **PENDING**（需先合并） |
| P5 | PR 上 "Approve and run" | `GITHUB_TOKEN` 建的 PR 需人工批准 | 流程约定 |
| P6 | 分支保护（main） | 强制 CI 绿才能合并 | **PENDING**（仓库设置，本轮不动） |

## 7. 分支保护建议

1. `main`：Require PR + Require status checks（`tests` / `content-gate` / `content-pipeline`）+ 禁止 force push + 禁止直推。
2. `content/queue`：只允许编辑器/Bot 推送，不设保护（它只是入队缓冲）。
3. 候选分支 `content/candidate-*`：允许 Bot 推送与删除；合并后自动清理。
4. 标签保护：给发布提交打 tag（`release/<date>`），便于回滚定位。

## 8. 发布门禁切换前的检查清单

- [ ] `content/queue` 已由人工创建，且 `.gitignore`/保护规则符合预期
- [ ] 新工作流在默认分支上可见，`workflow_dispatch` 能手动触发
- [ ] 用**无害 Fixture** 跑一次 dry-run（不产生真实文章）
- [ ] `content-pipeline` 的三 job 在真实环境跑通（validate → candidate → open-pr）
- [ ] 候选 PR 的 body 含 main/队列/候选三个 SHA，且 reviewer 能核对
- [ ] `main` 分支保护生效，直推被拒绝
- [ ] 回滚演练：`git revert` 一个候选合并提交，Pages 在 1–2 分钟内回到上一版
- [ ] `CACHE_VERSION` 递增策略确认（改 `js/papers.js`/首屏资源时必须递增）
- [ ] Pages 来源是否切到 Actions 部署（**7C-4 再决定**）

## 9. 回退方案

| 场景 | 操作 |
|---|---|
| 回退本轮 | `git revert --no-edit 3f784e7`（只含状态机与测试，运行时行为不变） |
| 撤销远端分支 | `git push origin --delete feature/batch7c-publishing-pipeline` |
| 本地重置 | `git switch main && git branch -D feature/batch7c-publishing-pipeline` |
| 候选 PR 已合并但内容有问题 | `git revert <merge-sha>` 并 push；同时把 ledger 对应条目标 `failed`（`content_state.py --to failed`），不要手改 JSON |
| 已合并但部署失败 | 保持 `status=published`、`deploy=failed`；修复后重跑部署并把 `--deploy success` 写回（两者必须分开记录） |

---

## 结论

- 云端 CI（`tests` 工作流）在真实 Linux 上 **succeeded**，Run ID `42766386472`，提交 `3f784e7`。
- 新增的 `content-gate` / `content-pipeline` 因"工作流不在默认分支 / 队列分支未建"**无法在本轮触发**，已如实标为 PENDING，未做任何未授权初始化。
- 候选状态机已实现并覆盖 13 个场景（19 项断言），本地回归 **33/33**。

```
B7C3B_CI_READY
```
