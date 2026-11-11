# Batch 7C-4A：发布工作流启用与安全验证

分支：`feature/batch7c-publishing-pipeline`
远端 HEAD：`564393a1dde788ba7830eb0816ac3a220add5e50`
正式 main：`9e996a3`（**未改动**）

本轮只做"安全启用准备 + 授权范围内的云端验证"：**未创建 `content/queue`、未合并 main、
未发布文章、未改 Pages 来源、未改任何仓库设置。**

| 项 | 结果 |
|---|---|
| 云端 CI | run **`42768235329`** · `node-22 / python-3.12` · **succeeded** |
| 本地回归 | **PASS 34 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 新增 | `tests/test29_workflow_activation.py`（18 项激活契约） |
| 修改 | `content-pipeline.yml`（默认只读 + 写开关门控）、`run_tests.py`（33 → 34） |

状态标记：`B7C4A_LOCAL_READY` + `B7C4A_CLOUD_READY`（两者都有实测证据）；
**`B7C4A_ACTIVATION_BLOCKED`** —— 队列分支与分支保护需要人工授权，见第 7 节。

---

## 1. 工作流启用方案

### 1.1 现状（三个工作流）

| 工作流 | 触发 | 写权限 | 现状 |
|---|---|---|---|
| `tests.yml` | `push`（所有分支）+ `pull_request` | 无（默认只读） | **已稳定运行**，本轮 run 42768235329 |
| `content-gate.yml` | `pull_request`（路径过滤）+ `workflow_dispatch` | `contents: read` | 未触发：无 PR，且工作流不在默认分支 |
| `content-pipeline.yml` | `push: content/queue` + `workflow_dispatch` | 按 job 授予 | 未触发：`content/queue` 不存在 |

### 1.2 本轮加固（关键改动）

原来 `dry_run` 默认 `false`，且 `candidate` job **不受 dry_run 门控** —— 意味着只要队列有动作就会推候选分支。
现在改为**默认只读**：

```yaml
dry_run:      default: 'true'    # 默认不建 PR
allow_write:  default: 'false'   # 默认不写
candidate.if: needs.validate.outputs.items != '' &&
              (inputs.allow_write == 'true' || vars.CONTENT_PIPELINE_WRITE == 'enabled')
```

- 人工 `workflow_dispatch` 必须显式勾 `allow_write=true` 才会写分支；
- `push` 到 `content/queue` 的自动运行在仓库变量 `CONTENT_PIPELINE_WRITE` 设为 `enabled` 之前**一律只读**；
- validate job 会打印本次模式（`READ-ONLY` / `WRITE`），日志可审计（A3/A4/A5 断言）。

### 1.3 拆分建议（不强制切生产入口）

当前特性分支同时含：生成器（7C-2）、队列消费（7C-3B）、状态机（7C-3B.1）、工作流（7C-3A/3B/4A）。
建议按以下顺序分 PR，**基础设施先合、编辑器后合**：

1. **PR-A（基础设施，可先合）**：`scripts/build_content.py`、`split_posts.py` 扩展、`release_candidate.py`、`tests/test23/25`。
2. **PR-B（队列与状态机，可先合）**：`process_content_queue.py`、`content_state.py`、`candidate_pr.py`、`tests/test26/28`。
3. **PR-C（工作流，默认只读）**：`content-gate.yml`、`content-pipeline.yml`（dry_run=true）。
4. **PR-D（编辑器切换）**：`js/app.js` 改成写队列 —— **必须等 A/B/C 合并且 `content/queue` 建好**。

这样即使 PR-A/B/C 全合，正式发布入口仍是原来的 `main` 直推，不受影响。

## 2. 队列初始化结果

**未初始化**（`git ls-remote --heads origin` 只有 main + 6 个 feature 分支）。

设计（等待授权后执行，均为一次性操作）：

```bash
# 1) 从受信任的 main 建分支（不带任何历史文章）
git fetch origin main
git switch -c content/queue origin/main
# 2) 只放占位文件，证明分支可读、且不会被自动合并
mkdir -p content/queue
printf '{\n  "note": "content queue placeholder; 真实条目由编辑器写入"\n}\n' > content/queue/.keep.json
git add content/queue/.keep.json
git commit -m "chore(content): 初始化发布队列分支"
git push origin content/queue
```

- 占位文件不含任何真实文章；`process_content_queue.py` 会把它当非法条目**拒绝**（缺 id），
  因此它只会让流水线红一次，**不可能自动发布任何内容**（A12：队列缺失/无有效条目时安全降级为 `NO_CHANGES`）。
- 并发策略：一个文章一个文件 ⇒ 不同文章互不覆盖；同一 id 由"已存在即拒绝"保护；
  分支本身不做保护（它是入队缓冲），保护放在 main。

## 3. 真实触发证据

| 项 | 值 |
|---|---|
| Run ID | `42768235329` |
| 触发事件 | `push`（到 `feature/batch7c-publishing-pipeline`） |
| Job | `node-22 / python-3.12` |
| 结论 | **succeeded**（提交检查页 `This job succeeded`） |
| 对应提交 | `564393a1dde788ba7830eb0816ac3a220add5e50` |
| 上一轮 Run | `42766386472`（`3f784e7`，同样 succeeded，留作对照） |

**未触发的部分（如实记录）**：

- `content-gate.yml`：需要 PR，或工作流在默认分支上（本轮两者都不满足）。
- `content-pipeline.yml`：需要 `content/queue` 分支（未授权创建）。
- 因此"队列 → 候选 → PR"的**云端全链路仍是 PENDING**，不能声称已验收。

## 4. 最小权限矩阵

| Job | contents | pull-requests | 说明 |
|---|---|---|---|
| `validate` | read | — | 只校验，不写 |
| `candidate` | **write** | — | 仅推 `content/candidate-*` 分支 |
| `open-pr` | read | **write** | 仅创建/复用 PR |
| `report-failure` | read | — | 失败时说明 main 未变 |
| 全局 | `permissions: {}` | | 禁止全局写权限 |

`content-gate.yml` 全程 `contents: read`，不含任何写权限（按代码行断言，排除注释）。

## 5. PR 审批流程

1. 候选 PR 由 `GITHUB_TOKEN` 创建 → **不会自动触发** `pull_request` 工作流（GitHub 既定行为）。
2. 因此 `content-pipeline` 在**推候选分支之前**已完成：`build_content --check`、`split_posts --check`、
   `gen_feed --check`、`run_tests --only content-check split-check feed-check test23 test26`。
3. PR 上仍需人工点 **"Approve and run"** 才会跑 `content-gate`（若已进默认分支）；这一步是人工闸门，不是自动放行。
4. 合并不在流水线里（无 `gh pr merge` / `--auto`，A6 断言），必须人工操作。

## 6. main 分支保护现状

| 项 | 状态 |
|---|---|
| Branch protection API | **403**（未认证/非管理员）→ **无法读取，不能假定已开启** |
| Rulesets API | **403** → 同上 |
| 结论 | 当前 `main` 是否受保护**未知**；从"push 即发布"的事实看，至少没有强制 PR 检查 |

建议配置（等待授权后由仓库管理员执行）：

| 设置 | 值 |
|---|---|
| Require a pull request before merging | ✅（至少 1 个批准） |
| Require status checks | ✅ `tests`（已稳定）+ `content-gate`（合入默认分支后） |
| Require branches to be up to date | ✅（防止用过期 CI 合并） |
| Block force pushes | ✅ |
| Restrict deletions | ✅ |
| Allow specified actors to bypass | ❌ 不建议（管理员也不绕过） |

## 7. 尚未授权的 GitHub 设置（BLOCKED 项）

| # | 操作 | 为什么需要授权 | 风险 |
|---|---|---|---|
| B1 | 创建 `content/queue` 分支 | 会新增远端分支（用户可见变更） | 低（只是缓冲分支，无自动发布） |
| B2 | 开启 main 分支保护 | 改变仓库合并规则 | 中（会影响所有协作者） |
| B3 | 设置仓库变量 `CONTENT_PIPELINE_WRITE=enabled` | 会让 push 自动写候选分支 | 中（开启后流水线才真正会写） |
| B4 | 把工作流合入默认分支 | `workflow_dispatch` 才能用 | 中（见 PR-A/B/C 拆分） |
| B5 | 用无害 Fixture 跑一次真实 `content-pipeline` | 需要 B1 + B3 | 低（Fixture 不含真实文章） |

**这些操作本轮一律未执行。**

## 8. 完整回归

```
python scripts/run_tests.py
→ PASS 34 / FAIL 0 / SKIP 0 / BLOCKED 0
```

| 套件 | 结果 |
|---|---|
| **`test29`（新增）** | 18/18（默认只读、写开关、最小权限、无合并动作、只推候选分支、队列缺失降级） |
| `test28`（状态机） | 19/19 |
| `test26/27`（队列/PR） | 21 / 19 |
| 其余 30 套 | 全绿（含 `test10/11/20/23/24/25`、6 套 Chromium） |

未删除任何断言；BLOCKED 不计入 PASS。

## 9. 下一阶段 Pages 部署切换方案

1. 先让 `content-pipeline` 在 Fixture 上跑通（B5）。
2. 把 Pages 来源从 "Deploy from a branch" 改为 **GitHub Actions**，新增 `deploy.yml`：
   `needs: [tests, content-gate, content-pipeline]`，只有三者全绿才部署同一 commit。
3. 部署 job 只拿 `pages: write` + `id-token: write`，不拿 `contents: write`。
4. 部署后用 `content_state.py --deploy success --deploy-run <id>` 回写状态（部署状态与合并状态分开）。
5. 保留"从分支发布"作为回退路径 24 小时，确认无回归后再删除。

## 10. 回退步骤

| 场景 | 操作 |
|---|---|
| 回退本轮 | `git revert --no-edit 564393a`（只改 workflow 默认值与测试，运行时无影响） |
| 关闭自动写 | 删除仓库变量 `CONTENT_PIPELINE_WRITE`，或在 dispatch 时保持 `allow_write=false` |
| 回退队列分支 | `git push origin --delete content/queue`（分支上只有占位文件） |
| 回退候选分支 | 删除 `content/candidate-*` 分支；对应 PR 关闭即可，main 不受影响 |
| 候选 PR 已合并但有问题 | `git revert <merge-sha>` + push；同时 `content_state.py --to failed` 标记条目 |

---

## 结论

- **本地**：34 套全绿，激活契约 18 项覆盖"默认只读 / 最小权限 / 不合并 / 队列缺失降级"。
- **云端**：`tests` 工作流在真实 Linux 上 succeeded（run `42768235329`，提交 `564393a`）。
- **未完成（需授权）**：`content/queue` 初始化、分支保护、写开关、工作流进默认分支、真实候选 PR 全链路。

```
B7C4A_LOCAL_READY
B7C4A_CLOUD_READY
B7C4A_ACTIVATION_BLOCKED
```
