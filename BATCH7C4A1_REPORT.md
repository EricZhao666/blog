# Batch 7C-4A.1：发布工作流最终安全复核

分支：`feature/batch7c-publishing-pipeline`
本轮 HEAD：`67999c3`（已推送）
正式 main：`9e996a3`（未改动）

本轮只修工作流安全，不加业务功能。**未创建正式队列、未开仓库写入变量、未改 main/Pages、未发布文章。**

| 项 | 结果 |
|---|---|
| 本地回归 | **PASS 35 / FAIL 0 / SKIP 0 / BLOCKED 0** |
| 云端 CI | run **`42775714614`** · `node-22 / python-3.12` · **succeeded** |
| 新增 | `tests/test30_workflow_gating.py`（16 项，含 8 组合真值表） |
| 修改 | `content-pipeline.yml`（门控/候选回归/SHA 绑定/时间戳）、`run_tests.py`（34 → 35） |

---

## 1. 任务一：dry-run 严格门控

### 1.1 修复前的漏洞

`candidate` job 只判断"是否授权"，**不看 dry_run**：

```yaml
# 修复前
if: needs.validate.outputs.items != '' && (allow_write == 'true' || vars.CONTENT_PIPELINE_WRITE == 'enabled')
```

⇒ `dry_run=true` + `allow_write=true` 仍会推候选分支；仓库变量设为 enabled 后，显式 dry-run 也会被绕过。

### 1.2 修复后

```yaml
if: >-
  github.event.inputs.dry_run != 'true'
  && needs.validate.outputs.items != ''
  && (github.event.inputs.allow_write == 'true' || vars.CONTENT_PIPELINE_WRITE == 'enabled')
```

`dry_run` 是**第一优先级**：任何 allow_write / 仓库变量组合都不能放行。

### 1.3 组合真值表（test30 G1-G3 实际求值，不是文字断言）

| dry_run | allow_write | CONTENT_PIPELINE_WRITE | candidate 是否执行（= 是否可能写） |
|---|---|---|---|
| true | true | enabled | **否** |
| true | true | off | **否** |
| true | false | enabled | **否** |
| true | false | off | **否** |
| false | true | enabled | 是 |
| false | true | off | 是 |
| false | false | enabled | 是 |
| false | false | off | **否**（只读） |

### 1.4 自动触发 vs 手动触发

| 触发 | 默认 | 写入条件 |
|---|---|---|
| `push` 到 `content/queue` | 只读 | 需仓库变量 `CONTENT_PIPELINE_WRITE=enabled`（人工设置） |
| `workflow_dispatch` | 只读（dry_run 默认 true） | 需显式 `dry_run=false` **且** `allow_write=true` |

写入前会打印：`模式: WRITE  main=<sha>  queue=<sha>  feedNow=<iso>`（G13）。

`open-pr` 额外要求：`needs.candidate.outputs.head != '' && dry_run != 'true'`。

## 2. 任务二：候选副本完整回归

修复前 `run_tests.py --only content-check split-check feed-check test23 test26` 在 **main 工作区**执行，
既不覆盖 Chromium，也没跑全量。

现在候选 job 的步骤顺序（PyYAML 实测）：

```
记录来源 SHA → 取队列内容 → 生成候选 → 候选自检
→ 候选目录安装依赖（npm ci + playwright install --with-deps chromium）
→ 候选目录完整回归（python scripts/run_tests.py，PW_CHANNEL=chromium）
→ 候选产物哈希留档（sha256sum → candidate-hashes.txt）
→ 推送前确认 main 未变化
→ 从 main 切候选分支并提交
```

- 两步都用 `working-directory: ${{ runner.temp }}/candidate`，**真的在候选副本里跑**（G5/G6/G6b）。
- 只有候选自身全绿才会往下走到 push；任何一步失败都不会产生分支。
- 哈希留档便于人工核对"PR 里的产物 = 跑过测试的产物"（G7）。

## 3. 任务三：main SHA 与队列 SHA 绑定

| 校验 | 实现 |
|---|---|
| validate 与 candidate 用同一个 queue SHA | candidate 里 `QUEUE_SHA != needs.validate.outputs.queue_sha` → 直接退出（G9） |
| candidate 与 PR 用同一个 base main SHA | candidate 输出 `base_main_sha`，open-pr 用它比对当前 main |
| 推送前确认 main 未变 | `git ls-remote origin refs/heads/main` 与 `MAIN_SHA` 比较，不一致则放弃推送（G8 校验位置在 push 之前） |
| PR 前确认 main 未变 | open-pr 里再查一次，不一致则 `exit 1`（G10） |
| 过期参数传给 candidate_pr | `--require-main-sha` + `--current-main-sha`（脚本里不一致返回 **2 / STALE**） |
| 候选基线与当前 main 不一致 | 安全中止，不沿用旧候选（不自动重试，避免"用旧 CI 合并"） |

顺带修正：原来 PR 正文里的 `--main-sha` 传的是**队列 SHA**（错的），现在传真实 main SHA。

## 4. 任务四：时间戳与触发链

### 4.1 FEED_NOW

- 修复前：`FEED_NOW: '2026-11-10T00:00:00Z'` 写死在 workflow 里 → 长期运行会让 RSS 的 `lastBuildDate` 停在历史日期。
- 修复后：`FEED_NOW=$(git show -s --format=%cI FETCH_HEAD)`。
  - **确定性**：同一个队列 SHA → 同一个时间戳，重复构建逐字节一致；
  - **不过期**：新批次自动带新时间戳。

### 4.2 触发链

| 问题 | 结论 |
|---|---|
| `GITHUB_TOKEN` 推的候选分支会再次触发工作流吗 | 不会（GitHub 既定行为）→ 无循环 |
| `GITHUB_TOKEN` 创建的 PR 会自动跑 `pull_request` 工作流吗 | 不会；因此候选的完整校验由 `content-pipeline` **自己在推分支前**完成，不依赖 PR 触发的另一条流水线 |
| 谁覆盖"PR 上的最终检查" | 人工 Approve and run `content-gate`（默认分支就位后） |
| 是否需要 PAT | 不需要，也不使用 |

## 5. 测试

| 套件 | 结果 |
|---|---|
| `test30`（新增） | **16/16**：8 组合真值表、候选目录回归位置、依赖与 Chromium、哈希留档、推送前 recheck、队列 SHA 绑定、PR 过期参数、FEED_NOW 非写死、无合并/部署 |
| `test29`（启用契约） | 18/18（未被本次改动破坏） |
| 全量 | **PASS 35 / FAIL 0 / SKIP 0 / BLOCKED 0** |

## 6. Linux CI

| 项 | 值 |
|---|---|
| Run ID | **42775714614** |
| Job | `node-22 / python-3.12` |
| 提交 | `67999c3` |
| 结论 | **succeeded** |

（上一轮 42768235329 / 上上轮 42766386472 均可对照。）

## 7. 仍未授权 / 未执行

| # | 项 | 状态 |
|---|---|---|
| 1 | 创建 `content/queue` | 未执行（需授权） |
| 2 | 仓库变量 `CONTENT_PIPELINE_WRITE` | 未设置（保持默认只读） |
| 3 | main 分支保护 / Rulesets | 未修改（API 403，状态未知） |
| 4 | 工作流进入默认分支 | 未做（仍在特性分支，`workflow_dispatch` 不可用） |
| 5 | 用 Fixture 跑真实 pipeline | 未做（依赖 1+2+4） |

## 8. 回退

| 场景 | 操作 |
|---|---|
| 回退本轮 | `git revert --no-edit 67999c3`（只改 workflow 与测试） |
| 只回退门控 | 把 candidate 的 `if:` 恢复为两条件版本（不推荐，会重新引入漏洞） |
| 关闭写入 | 保持 `allow_write=false` 且不设置仓库变量即可 |

---

```
B7C4A1_CI_READY
```
