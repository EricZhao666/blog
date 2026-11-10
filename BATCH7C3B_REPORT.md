# Batch 7C-3B：内容队列消费、候选构建与 PR 门禁

分支：`feature/batch7c-publishing-pipeline`
基线：`1fa69c9`（Batch 7C-3A）
本轮只连接"队列 → 候选 → PR"链路，不重写构建器、不改线上设置。

| 项 | 结果 |
|---|---|
| 新增 | `scripts/process_content_queue.py`、`scripts/candidate_pr.py`、`.github/workflows/content-pipeline.yml`、`tests/test26_queue_processor.py`、`tests/test27_content_workflow.py` |
| 修改 | `scripts/run_tests.py`（30 → 32 套） |
| 未修改 | `js/app.js`、`scripts/build_content.py`、`scripts/split_posts.py`、任何文章数据与产物 |
| 回归 | **PASS 32 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 云端验证 | **未执行**（只跑本地；不宣称 CI_READY / PR_READY） |

结论标记：`B7C3B_LOCAL_READY`

---

## 1. 队列消费架构

```
content/queue/<id>.json  ──┐
                           ├─ process_content_queue.py ──► 候选目录（main 的副本）
content/ledger.json    ──┘        │  apply_ops：add / modify / delete
                                  │  build_content --sync（19 篇 → 派生数据）
                                  │  build_content --check（自检）
                                  ▼
                        content/ledger.json 追加 candidate 记录
                                  ▼
                   workflow：从 main 切 content/candidate-<queue8> → commit → push
                                  ▼
                          candidate_pr.py：查重 → 创建 PR（base=main）
```

- **固定队列 Commit SHA**：`--queue-sha` 记录在 ledger 与 PR 正文；workflow 用 `git fetch --depth=1` 取到确定的 `FETCH_HEAD`。
- **不写工作区**：所有变更发生在 `--work-dir`（候选目录），工作区只有 workflow 里那一次显式提交。
- **状态可追踪**：ledger 条目状态 `pending / candidate / published / failed`；本轮只写 `candidate`，合并后才由人工/后续流程转 `published`（构建成功 ≠ 已上线）。

## 2. 内容规范化规则

| 规则 | 行为 |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]*$`，**全局唯一**（队列内 + 与 `data/posts` 内建文章） |
| `op` | 只接受 `add` / `modify` / `delete`；缺省 = `add`（兼容 7C-3A 编辑器载荷）；其他一律拒绝 |
| 必填 | `add/modify`：`title/date/tags/excerpt/content`；`delete`：只需 `id` |
| `date` | `YYYY-MM-DD` 且必须是真实日期 |
| `tags` | 非空字符串数组（空数组合法但会被拒：队列条目至少一个标签） |
| `content` | 非空 Markdown；写入 `data/posts/<id>.md` |
| 幂等键 | `(id, op, sha256(条目内容))` —— **不用 queueSha**，否则编辑器每加一篇都会重放全部历史 |
| 同一 id 两条未消费记录 | 拒绝（不猜先后），已消费的条目应在合并后清理 |

不改变既有 18 篇：候选从 main 复制，只对队列涉及的 id 增删改；`USER_POSTS` 兼容逻辑（7C-3A 的实现）原样保留。

## 3. GitHub Actions 设计

`.github/workflows/content-pipeline.yml`，三个 job 串行：

| job | 权限 | 做什么 | 失败后果 |
|---|---|---|---|
| `validate` | `contents: read` | 队列校验（--check）、现有产物一致性、上传报告 | 不进入候选 |
| `candidate` | `contents: write` | 生成候选、候选自检、从 main 切分支提交并 push | 不创建 PR |
| `open-pr` | `contents: read` + `pull-requests: write` | 查重/创建 PR（**不合并**） | 分支保留，可重跑 |
| `report-failure` | `contents: read` | 失败时明确"main 与生产未改动" | 流水线红 |

触发：`workflow_dispatch`（可指定队列分支）+ `push` 到 `content/queue`。

## 4. 权限矩阵

| 能力 | validate | candidate | open-pr | 全局 |
|---|---|---|---|---|
| `contents: read` | ✅ | ✅ | ✅ | — |
| `contents: write` | ❌ | ✅ | ❌ | — |
| `pull-requests: write` | ❌ | ❌ | ✅ | — |
| 默认权限 | `permissions: {}`（全空，按 job 显式授予） | | | |

静态断言（test27 W8-W9c）保证：全局为空、`contents: write` 只出现在 candidate、`pull-requests: write` 只出现在 open-pr。

## 5. 候选分支与 PR 管理

- 候选分支：`content/candidate-<queueSha8>`，从**当前 main** 切出（不是把 `content/queue` 合并进来），因此 PR 里只有"内容变更 + 派生数据"，不带队列历史。
- PR：base=`main`，head=候选分支；标题带批次信息；正文含来源 main/队列/候选三个 SHA、条目列表、三道校验结论。
- 查重：同 head 已有 open PR → **复用**，不重复创建。
- 过期：`--require-main-sha` 与 `--current-main-sha` 不一致 → 退出码 2（`[STALE]`），必须重新生成候选，不沿用旧 CI。
- 不合并、不部署：workflow 里没有任何 merge / deploy 步骤（静态断言 W10b）。

## 6. 触发链实际验证

| 问题 | 结论 |
|---|---|
| `GITHUB_TOKEN` 推送的分支会再触发 push workflow 吗 | **不会**（GitHub 既定行为）→ 候选分支 push 不会引起二次运行 |
| `GITHUB_TOKEN` 创建的 PR 会自动触发 `pull_request` workflow 吗 | **不会**（需人工 "Approve and run" 或 App/PAT）→ 本工作流在候选分支上自己跑完校验，不依赖 PR 触发的 workflow |
| 是否用个人 PAT 绕过 | 否 |
| 本地实测 | 仅验证了 `candidate_pr.py` 对 mock API 的行为（创建/复用/403/422/过期/dry-run），**未连真实 GitHub** |

## 7. 故障注入

| 场景 | 期望 | 实测 |
|---|---|---|
| 非法 JSON / 不支持的操作 / 字段非法 | 拒绝 | Q6 / Q7 / Q12 ✅ |
| 队列内同 id 两条 | 拒绝 | Q5 ✅ |
| add 已存在 / modify 不存在 / delete 不存在 | 拒绝（不猜） | Q8 / Q9 / Q11 ✅ |
| 生成阶段失败（search-index 不可写） | 非 0 且不写 ledger | Q13 ✅ |
| 旧队列 SHA 覆盖新任务 | 拒绝（git 祖先判定） | Q14 ✅ |
| 失败后修好重试 | 成功，ledger 仅一条 | Q15 ✅ |
| `--check` 只读 | 不建候选、不写 ledger | Q16 ✅ |
| 候选缺派生文件 / feed 被篡改 | `--check` 失败 | W11 / W12 ✅ |
| 候选基于旧 main | `[STALE]` 拒绝 | W5 ✅ |
| PR 权限不足 / 422 / 无 token | 明确失败、不创建 | W3 / W4 / W3b ✅ |
| 同 head 已有 PR | 复用 | W2 ✅ |

## 8. 全量回归

`python scripts/run_tests.py` → **PASS 32 / FAIL 0 / SKIP 0 / BLOCKED 0**

| 套件 | 结果 |
|---|---|
| `test10` / `test11` / `test20` | 19 / 17 / 22 |
| `test23` / `test24` / `test25` | 41 / 29 / 13 |
| **`test26`（新增）** | 21 |
| **`test27`（新增）** | 19 |
| `content-check` / `split-check` / `feed-check` | PASS |
| Chromium：`browser` / `sw-consistency` / `sw-upgrade` / `mobile-notes` / `course-seo` / `papers-deeplink` | 37 / 35 / 25 / 224 / 45 / 63 全 PASS |

未删除任何断言；BLOCKED 不计入 PASS（`test25` R5 仍显式返回 2）。数据零改动（`git diff` 不含 `js/data.js`、`data/posts/*`、`feed.xml`）。

## 9. Linux CI 实际结果

**本轮未推送、未运行云端 CI**（按任务书"第一阶段只在本地验证"）。
因此**不声明** `B7C3B_CI_READY` / `B7C3B_PR_READY`。

## 10. 未解决的 GitHub 权限或设置问题（PENDING）

| # | 事项 | 状态 |
|---|---|---|
| P1 | `content/queue` 分支是否存在 | **PENDING**（需人工创建一次） |
| P2 | `main` 分支保护（必须 CI 绿才能合并） | **PENDING**（仓库设置，本轮不动） |
| P3 | `GITHUB_TOKEN` 创建的 PR 需要人工批准才跑 CI | 已知限制，工作流已自行跑校验 |
| P4 | Pages 仍从 `main` 根目录发布（无部署门禁） | 按要求本轮不切换 |
| P5 | 真实 PR 创建权限未验证（无云端执行） | **PENDING** |

## 11. 修改文件和提交清单

```
A scripts/process_content_queue.py     队列消费（schema/幂等/增删改/陈旧/候选）
A scripts/candidate_pr.py              候选 PR（查重/创建/过期/不合并）
A .github/workflows/content-pipeline.yml  三 job、最小权限、无 merge/deploy
A tests/test26_queue_processor.py      21 项
A tests/test27_content_workflow.py     19 项
M scripts/run_tests.py                 30 → 32 套
```

提交：`<commit> 发布：内容队列消费与候选 PR 门禁（B7C3B）`（本地，未 push）。

## 12. Batch 7C-4 上线门禁方案

1. 人工创建 `content/queue` 分支；开 `main` 分支保护，要求 `tests` + `content-gate` + `content-pipeline` 绿。
2. 首次真实运行 `content-pipeline`（`workflow_dispatch`，`dry_run=true`）验证权限与产物，再开 dry_run=false。
3. 若 `GITHUB_TOKEN` 无法在 PR 上触发必要检查：改用 GitHub App（最小权限）或要求 reviewer 手动 "Approve and run"，**不引入个人 PAT**。
4. 把 Pages 来源切到 GitHub Actions 的 deploy job（`needs: [tests, content-gate, content-pipeline]`），使"部署"也受门禁保护——这是唯一能消除"直推 main 即上线"的办法。
5. 合并后自动清理已消费的队列条目（删除 `content/queue/<id>.json`），保持"同一 id 只有一条未消费记录"。
6. 增加 `published` 状态回写：由合并事件把 ledger 条目从 `candidate` 转 `published`，形成完整审计链。

```
B7C3B_LOCAL_READY
```
