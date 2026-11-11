# Batch 7C-4B.1：发布基础设施安全激活（门禁收尾）

分支：`feature/batch7c-publishing-pipeline`
本轮 HEAD：`f7526dd`（已推送）
正式 main：`9e996a3`（未改动）

**未开启自动写入、未初始化远端队列、未创建正式 PR、未合并 main、未改 Pages 来源。**

| 项 | 结果 |
|---|---|
| 本地回归 | **PASS 36 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| `test31` | **24/24**（新增 7 项门禁失败语义） |
| Linux CI | run **`42973271078`** · 提交 `f7526dd` · `node-22 / python-3.12` · **succeeded** |

---

## 1. 第一阶段：门禁风险修复

### 1.1 删掉吞掉 diff 错误的 `|| true`

```diff
-          CHANGED=$(git diff --name-only "origin/$BASE...HEAD" || true)
+          if ! CHANGED=$(git diff --name-only "origin/$BASE...HEAD"); then
+            echo "无法计算 diff（base=$BASE）：按失败处理，不跳过任何检查"
+            exit 1
+          fi
```

原写法在 base 分支改名、浅克隆异常、网络抖动时会把"算不出来"当成"没有相关变更"，
于是静默跳过全部检查并让 job 变绿 —— 这是 required check 最危险的失效模式。

### 1.2 路径判定改为"白名单之外一律检查"

原来是**黑名单**（只认 `js/data.js|data/|scripts/|content/|feed.xml`），漏掉的路径会被静默跳过：

- `gen_feed.py`（根目录生成器，影响 RSS）
- `gen_notes_pages.js`（影响 sitemap / notes 静态页）
- `.github/workflows/content-*.yml`（改门禁本身）
- `tests/test23/25/26/28/31`（内容管道测试）

现在反过来：只有明确"可忽略"的路径（文档、样式、`vendor/`、与派生数据无关的前端脚本、
`tests/browser/`、`notes/` 等）才跳过；**任何未知路径都会触发重活**。
新增文件不需要维护名单，忘记登记不会被静默放行（test31 R2e–R2g）。

### 1.3 必需检查策略（普通 PR vs 自动候选 PR）

| PR 类型 | 必需检查 | 谁产生 | 说明 |
|---|---|---|---|
| 普通 PR（人手动开） | `tests` + `content`（content-gate 的 job 名） | `tests.yml` / `content-gate.yml` 的 `pull_request` | 两者都对所有 PR 触发，不会挂起 |
| 自动候选 PR（`GITHUB_TOKEN` 创建） | `tests` + `content` + `content-candidate` | 前两者：需要人工 "Approve and run"；`content-candidate`：由 `content-pipeline` 用 commit status API 挂在候选 SHA | **不能**把 `content-candidate` 设为所有 PR 的必需检查 —— 普通 PR 没有这个 context，会永久 Pending |

结论：`content-candidate` 只在候选流程里产生（test31 R2h），因此它只能作为**候选分支专属**的
required context（GitHub 的 required checks 是按分支规则配置的，可对 `content/candidate-*` 单独设规则）。

## 2. 第二阶段：基础设施 PR

- 分支已推送（`f7526dd`），完整回归与云端 CI 均绿。
- **PR 未创建**：任务要求"不自动合并"，且本轮未获授权创建正式 PR；`gh` 未认证，未使用 PAT。
- 拆分结论（与上一轮一致）：基础设施脚本 + 只读工作流可以独立于编辑器切换先行合入；
  编辑器切换（`js/app.js` 写队列）必须等 `content/queue` 就绪，否则会得到一个不可用的生产入口。
- 建议 PR 标题/正文见 `BATCH7C4B_ACTIVATION_REPORT.md` 第 3 节（可直接使用）。

## 3. 第三阶段：main 保护配置（人工执行，尚未生效）

Settings → Branches → Add branch protection rule（或 Rulesets），目标 `main`：

| 设置 | 值 |
|---|---|
| Require a pull request before merging | ✅ Required approvals: 1 |
| Dismiss stale approvals | ✅ |
| Require status checks to pass | ✅ `tests`、`content`（**只选已经实际出现过来源的**；`content-candidate` 留给候选分支规则） |
| Require branches to be up to date | ✅ |
| Do not allow bypassing | ✅（管理员也不绕过） |
| Restrict who can push | ✅（只留 bot/维护者） |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

> 现状：`GET /branches/main/protection` 与 `/rulesets` 均返回 **403**（未认证/非管理员），
> 因此**无法验证当前是否有保护**，上述配置一律标记为未生效。

## 4. 第四阶段：初始化队列（BLOCKED）

前置条件未满足：基础设施尚未进入默认分支、main 保护未配置。

准备好的一次性命令（需授权后执行）：

```bash
git fetch origin main && git switch -c content/queue origin/main
mkdir -p content/queue
printf '{\n  "note": "content queue placeholder; 真实条目由编辑器写入"\n}\n' > content/queue/.keep.json
git add content/queue/.keep.json && git commit -m "chore(content): 初始化发布队列分支"
git push origin content/queue
```

本地已验证（test31 R9）：空队列 → `NO_CHANGES`，不写 ledger、不建候选、不产生分支或 PR。
占位文件缺 `id`，会被消费器判为非法条目，不可能被当成文章发布。

## 5. 第五阶段：真实 dry-run（BLOCKED）

`workflow_dispatch` 只对**默认分支上存在**的工作流可见，而 `content-pipeline.yml` 仍在特性分支；
`content/queue` 也不存在。故本轮**没有** Run ID 可记录。

预期结果（由 test30 的 8 组合真值表静态证明，非运行结果）：

| Job | dry_run=true 时的行为 |
|---|---|
| validate | 执行（只读） |
| candidate | **跳过**（条件首项即 `dry_run != 'true'`） |
| open-pr | **跳过**（需要候选分支输出） |
| 远端写入 | 无 |
| PR | 无 |
| Pages | 无 |

## 6. 第六阶段：下一轮无害 Fixture 演练方案（仅设计）

1. 在 `content/queue` 上放一条**合成条目**：`queue-fixture-1`，内容为 `# fixture`，
   明确标注"测试用，勿发布"。
2. 用 `workflow_dispatch` 跑：`dry_run=false` + `allow_write=true`（仓库变量仍关闭）。
3. 预期产出：`content/candidate-<queue8>` 分支 + 候选 PR（**不合并**）+ 候选 SHA 上的
   `content-candidate=success` 状态。
4. 核对：main 未变、Pages 未变、PR 数量 +1。
5. 清理：关闭 PR、删除候选分支与队列里的 fixture 条目。
6. **仍然不做**：合并、部署、切换 Pages 来源、开启 `CONTENT_PIPELINE_WRITE`。

## 7. 回归与云端 CI

| 项 | 值 |
|---|---|
| `python scripts/run_tests.py` | **PASS 36 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| `test31` | 24/24（R1–R9，含 R2c–R2i 新增 7 项） |
| 云端 Run | **42973271078**（`f7526dd`，`node-22 / python-3.12`，succeeded） |
| 未运行 | `content-pipeline` dry-run、`content-gate` 的 PR 触发、候选 PR 全链路 → **PENDING** |

## 8. 权限矩阵（本轮不变）

| Job | contents | pull-requests | statuses |
|---|---|---|---|
| tests | read | — | — |
| content-gate.gate | read | — | — |
| content-pipeline.validate | read | — | — |
| content-pipeline.candidate | **write** | — | **write** |
| content-pipeline.open-pr | read | **write** | — |
| 全局 | `permissions: {}` | | |

## 9. 需要授权的远端操作清单

1. 创建 `content/queue`（第 4 节命令）。
2. 合并基础设施 PR 到默认分支（`workflow_dispatch` 才会出现）。
3. 配置 main 分支保护（第 3 节）。
4. 首次 `workflow_dispatch` dry-run（dry_run=true / allow_write=false）。
5. 首次 Fixture 候选演练（第 6 节）。

## 10. 回退

| 场景 | 操作 |
|---|---|
| 回退本轮 | `git revert --no-edit f7526dd`（只改门禁与测试） |
| 门禁误红 | 用 `release_candidate.py --work-dir` 本地复现，禁止直接加 `|| true` 或放宽断言 |
| 队列分支误建 | `git push origin --delete content/queue`（只有占位文件） |
| 候选分支/PR | 关闭 PR、删除分支；main 不受影响 |

---

```
B7C4B1_LOCAL_READY
B7C4B1_ACTIVATION_BLOCKED
```

> `CLOUD_READY` **不声明**：真实只读的 `content-pipeline` dry-run 未能执行（工作流不在默认分支）。
> `tests` 工作流在云端 succeeded（run 42973271078），但它是既有回归工作流，不等价于发布流水线 dry-run。
