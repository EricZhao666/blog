# Batch 8E-3B-R：C17 内容构建并发缺陷修复

- 日期：2026-11-19
- 仓库：`E:\work_funnycode\blog`
- 合并后基线：`1e6da65`（PR #22 squash 合并，`Batch 8E-3B-1: test isolation (#22)`）
- 分支：`fix/batch8e3br-content-build-concurrency`
- 范围：只修复 C17 已确认的内容构建并发缺陷，以及 `write_artifacts` 的异常清理；未修改 UI/CSS、路由、搜索、正式内容、`sw.js`、`CACHE_VERSION`、CI/发布工作流，未实现 `--workers` 调度器。
- 最终状态：`B8E3BR_LOCAL_READY`

## 1. 基线与范围确认

- `origin/main` 已同步到 `1e6da65`；PR #22 已由用户 squash 合并，8E-3B-1 的端口隔离与资源隔离进入 main。
- 本轮从最新 main 创建 `fix/batch8e3br-content-build-concurrency`，未在旧分支上重写历史。
- 历史 CI 基线：`content-gate #16` PASS；`tests #77` 62 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED；`test23` 41/41；`port-isolation` 12/12。
- 本轮没有重新执行全站审查，也没有重新读取整个 `app.js`；只使用 C17 诊断、`build_content.py`、`test23`、`import_post`、`process_content_queue`、`release_candidate` 的相关区段。
- 修改前工作树干净；本轮变更范围见第 7 节。

## 2. 已确认根因

来自 `BATCH8E3B1_C17_DIAGNOSTIC.md`，级别 CONFIRMED / P2：

- 20 次合成 fixture 采样：`[0,0]` 14 次、`[0,3]` 4 次、`[0,1]` 2 次。
- 失败样本 A：`diff_artifacts` 的 `open(path, 'rb')` 对 `data/search-index.json` 抛 `PermissionError`。
- 失败样本 B：`write_artifacts` 的 `os.replace(tmp, target)` 对 `js/data.js` 抛 `[WinError 5] 拒绝访问`。
- 失败 trial 前后产物哈希一致、`--check` 返回 0、无残留锁；说明构建进程异常退出，不是产物内容损坏。
- 根因：两个 `--sync` 进程都在 `BuildLock` 外读取权威源、生成产物并比较磁盘旧产物；另一个进程在锁内逐文件 `os.replace`。Windows 文件共享语义使“锁外读取”和“锁内替换”发生竞争。
- `[0,3]` 是正常 `LockBusy` 竞争路径，不是缺陷；修复后仍允许。

## 3. 修改前后的锁保护范围

### 修改前

`main()` 的顺序是：

1. `collect(p)`（读取 `js/data.js`、正文、`js/user-posts.js`、`split_posts.collect`）；
2. 孤儿检查；
3. `resolve_source_info(p, state['source_info'])`（读取磁盘 `manifest.json`）；
4. `build_artifacts(p, state, source_info)`；
5. `diff_artifacts(root, artifacts)`（读取当前磁盘产物）；
6. 仅 `--sync` 的最后一步 `with BuildLock(...): write_artifacts(root, artifacts)`。

因此锁只保护写盘，不保护“读取权威源 → 计算 → 比较旧产物”这一整段临界区。

### 修改后

新增 `_build_bundle(p, args)`，只负责读取与计算，不写盘。`main()`：

- `--check` / `--dry-run`：保持原有只读契约，**不取 BuildLock**，`_build_bundle` + `diff_artifacts`，不写任何文件；
- `--sync`：
  1. `with BuildLock(p['lock'], args.lock_timeout):`
  2. 锁内 `_build_bundle(p, args)`（重新读取权威源与 manifest，不复用锁外结果）；
  3. 锁内 `diff_artifacts(root, artifacts)`；
  4. 锁内 `write_artifacts(root, artifacts)`；
  5. 锁内完成既有回读校验；退出 `with` 后释放锁。

`--sync` 的读取、计算、diff、写入和回读现在都在同一把锁内；另一个 sync 不能再在锁外读取并发的半更新状态，也不能在两个 sync 之间穿插 `os.replace`。

### `write_artifacts` 异常清理

`write_artifacts` 仍是“逐文件临时文件 + `os.replace`”，**不是多文件事务**。本轮新增：

- `os.replace` 或回读校验抛出异常时，遍历本次 `staged` 列表，删除所有仍存在的 `.tmp-build-*.part`；
- 已成功替换的目标保持现状，不尝试跨文件回滚；
- 暂存阶段的原有异常清理保持不变。

## 4. 调用契约与嵌套锁检查

- `scripts/import_post.py` 的 `apply_add_plan` / `apply_update_plan` 已持有 `bc.BuildLock(p['lock'])`，内部调用 `bc.collect`、`bc.write_artifacts`、`run_check`；`write_artifacts` 不自行取锁，因此不会形成嵌套锁或死锁。
- `import_post._rebuild_and_write` 直接调用 `bc.write_artifacts`，不调用 `bc.main(['--sync'])`；当前调用链没有 BuildLock 嵌套。
- `scripts/process_content_queue.py` 使用独立的 `.queue-process.lock`，并在隔离复制目录中用子进程执行 `build_content.py --sync` / `--check`；不与主仓库锁共享。
- `scripts/release_candidate.py` 同样在隔离目录调用 `--sync` / `--check`；按 root 独立。
- `tests/test34_post_update.py` 的 U22 仍验证：外部占用 `.content-build.lock` 时导入器退出 3、零写入、不删除别人的锁。
- 结论：本轮只把 `--sync` 入口的锁范围前移；没有给 `write_artifacts` 增加内部取锁，也没有改变 `import_post` 的锁契约。

## 5. RED/GREEN 证据

### 5.1 确定性故障注入测试

新增 `tests/test49_content_build_lock.py`，注册为 `build-lock`。测试全部使用临时合成 fixture：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| L1 持锁时 `--sync` 在读取/比较产物前退出 3 | FAIL：返回 1，锁外 `diff` 读到目录触发 `PermissionError` | PASS：先返回 `[BUSY]`，退出 3，不删除他人锁 |
| L2 `write_artifacts` 的 `os.replace` 失败后清理 staged 临时文件 | FAIL：残留 2 个 `.tmp-build-*.part` | PASS：无残留 |
| L3 输入非法时释放构建锁 | PASS | PASS |
| L4 不同 root 并发构建 | PASS | PASS |
| L5 `--check`/`--dry-run` 只读 | PASS | PASS |
| L6 `--lock-timeout=0` 立即失败 / 有限等待 | FAIL：旧实现先做完整计算，锁在计算期间释放，返回 0 | PASS：立即返回 3；有限等待后成功 |

修复前运行结果：**21 PASS / 4 FAIL**（L1a、L1b、L2b、L6c）。
修复后运行结果：**25 PASS / 0 FAIL**。

L1 的探针不是直接改测试断言：把 `data/search-index.json` 换成非空目录，使“锁外 diff”必然抛错；同时预置新鲜锁。旧实现返回 1，新实现返回 3。这是锁范围前移的直接 RED/GREEN 证据。
L2 直接调用 `write_artifacts`，目标是非空目录，绕过 `diff`，专门验证 `os.replace` 失败后的清理。
L6c 的旧实现先计算、后取锁；辅助进程只持有 0.8s，旧实现计算完成后锁已释放，因此错误地返回 0。新实现先取锁，`timeout=0` 立即返回 3。

### 5.2 C17 并发采样

`BATCH8E3BR_C17_RESULTS.csv` 保留修复后 20 次定向采样：

- `[0,0]`：0 次（本轮启动几乎同时，通常一方先拿到锁）。
- `[0,3]`：20 次。
- `[0,1]`：0 次。
- 其他异常：0 次。
- 每次采样后 `--check` 均为 0；无锁残留、无 `.tmp-build-*.part`；产物身份集合一致。
- 单次采样 wall：约 479–1124ms；20 次总耗时在 10 分钟预算内。

与上一轮 20 次（`[0,0]` 14、`[0,3]` 4、`[0,1]` 2）对比，修复后未再出现非预期 `[0,1]`。有限次无失败不等于已证明并发故障永不发生；这是一个有界采样结论。

### 5.3 test23 / test34

- `tests/test23_content_build.py`：**41/41 PASS**。C17 保留原断言，只增加失败时的完整 stdout/stderr、锁状态、产物状态和 staged 临时文件诊断保存（`tests/reports/c17-diagnostic-<timestamp>.txt`）。
- `tests/test34_post_update.py`：**67/67 PASS**，包括 U22 持锁退出 3、零写入、不删除他人锁。
- `build-lock` 专项：**25/25 PASS**，7.7s。

## 6. 特殊字符、路由与只读契约

### 6.1 特殊字符与路由

本轮不修改任何路由、稳定 ID、Markdown 渲染或 inline handler 编码，因此不重新执行 8E-2 的 `test46_inline_handlers.js` 全套；该套件在 8E-2/8E-3B-1 的全量基线中已 PASS。C17 修复只改变 `--sync` 的锁时序和临时文件清理，不改变产物字节生成逻辑；`feed.xml` 的 `lastBuildDate` 归一化、搜索索引、manifest 身份集合仍由原有 `build_artifacts` 生成。

### 6.2 `--check` / `--dry-run` 与 `--sync` 并发

- 当前 `--check` / `--dry-run` 不取 `BuildLock`，不写文件，也不创建锁（test49 L5 验证）。
- 因此它们与 `--sync` 并发时不是原子快照：可能在逐文件 `os.replace` 之间读到旧产物或半更新集合，`--check` 可能返回 1，`--sync` 的 `os.replace` 也可能因 `--check` 短暂持有目标文件而失败。
- 本轮**没有**改变只读模式的行为，也没有为了消除该竞争而让 `--check` 取写锁或写锁文件；这是有意的门禁契约保持。该风险独立记录，不在本轮扩大修复范围。

### 6.3 无变化时重复替换

已用临时 fixture 验证：连续两次 `--sync` 且 `changes=[]` 时，`write_artifacts` 仍替换全部 4 个产物（4/4 mtime 变化）。这是已知的额外文件竞争与 I/O，本轮只记录，不做性能重构。

### 6.4 `_lock_is_stale()` 检查

`_lock_is_stale` 当前对 `os.path.getmtime` 的任意 `OSError` 返回 `True`；理论上暂时的权限异常可能被误判为陈旧锁，随后 `BuildLock` 会尝试删除锁。当前环境没有真实可复现的权限异常样本，因此本轮不修改该函数，仅记录为残余风险。锁文件的 mtime 没有心跳，活跃构建超过 600s 也有被误判陈旧的潜在风险；同样未在本轮修改。

## 7. 修改文件清单

| 文件 | 变更 |
|---|---|
| `scripts/build_content.py` | 新增 `_build_bundle`；`--sync` 的 BuildLock 覆盖读取/计算/diff/写入/回读；`write_artifacts` 在 replace/回读失败时清理 staged 临时文件 |
| `tests/test49_content_build_lock.py` | 新增 25 项专项：锁范围、replace 清理、异常释放、不同 root 并发、只读契约、锁超时 |
| `scripts/run_tests.py` | 注册 `build-lock`，full 由 62 套变为 63 套 |
| `tests/test23_content_build.py` | C17 失败诊断保存；保留原 C17 断言 |
| `BATCH8E3A_PARALLEL_MATRIX.csv` | `test23` 更新为 `NEED_ISOLATION`；新增 `build-lock` 行 |
| `BATCH8E3B_NEXT_PLAN.md` | 增加 Batch 8E-3B-R 状态与后续边界 |
| `BATCH8E3BR_C17_RESULTS.csv` | 20 次修复后采样及上一轮基线摘要 |
| `BATCH8E3BR_REPORT.md` | 本报告 |

未修改：`js/app.js`、UI/CSS、正式文章/内容数据、路由/稳定 ID、搜索评分、IndexedDB、`sw.js`、`CACHE_VERSION`、CI/发布工作流、生产导入/队列/发布脚本（`import_post.py` / `process_content_queue.py` / `release_candidate.py` 未改）。

## 8. 验证结果

### 8.1 定向验证

- `python -m py_compile scripts/build_content.py tests/test23_content_build.py tests/test49_content_build_lock.py scripts/run_tests.py`：通过。
- `git diff --check`：通过。
- `test23`：41/41 PASS。
- `test34`：67/67 PASS。
- `build-lock`：25/25 PASS。
- 关联 8 套（`test15`、`split-check`、`test19`、`test25`、`test33`、`build-lock`、`content-check`、`feed-check`）：**8/8 PASS**，总耗时 178.8s。
- C17 定向采样：20/20 无异常，详见 CSV。

### 8.2 全量回归

命令：

```powershell
python scripts/run_tests.py --json tests/reports/b8e3br-full.json
```

结果：

- `PASS 63 / FAIL 0 / SKIP 0 / BLOCKED 0`
- 套件总数：**63**（原 62 套全部保留 + 新增 `build-lock`）
- 总耗时：**1616.6s**
- 语法/环境准备：见运行器报告 `tests/reports/last-run.md`
- 本次只执行一次 full；未通过反复重跑隐藏不稳定性。

## 9. SW 与发布兼容性

- 本轮未修改 `sw.js`、导航/缓存策略、`CACHE_VERSION` 或发布工作流。
- `build_content.py` 是内容构建器，不属于 SW install 预缓存资源；本轮改动不需要独立的 SW 版本递增。
- 因此本批没有新增 SW 发布阻塞条件。若后续同时修改 `js/app.js` 等预缓存资源，仍需按既有发布门禁更新 `CACHE_VERSION`。

## 10. 未修复问题与残余风险

1. `--check` / `--dry-run` 仍无锁只读，与 `--sync` 并发时可能读到中间/旧产物，或短暂阻塞 `os.replace`。本轮保持门禁契约，不改写行为。
2. `write_artifacts` 是逐文件原子替换，不是多文件事务；replace 中途失败时可能留下部分新、部分旧的目标集合；已替换的目标不回滚，仅清理 staged 临时文件。
3. 无变化时仍替换全部产物，造成不必要的替换竞争与 I/O；只记录，未优化。
4. `_lock_is_stale` 对 `OSError` 的“陈旧”判断过宽，且锁无心跳；无真实可复现权限异常证据，未修改。
5. `test23` 虽已修复 C17，但仍未与其他套件做组合并发验证；矩阵保持 `NEED_ISOLATION`，不得标记 `PARALLEL_SAFE`。
6. 本轮未证明“任意测试组合并发安全”；只证明两个 `--sync` 进程在同一 root 上的 C17 场景不再出现 `[0,1]`。

## 11. 进程、锁与临时文件清理

- 全量回归完成后检查本任务启动的 Python / Node / Chromium 子进程，以及 `.content-build.lock`、`.tmp-build-*.part` 残留。
- C17 采样和 test49 的临时目录均在测试结束时删除；未改动用户其他进程。
- 结果：**无 `.content-build.lock` / `.tmp-build-*.part`；无本任务 Python/Node/Chromium 子进程；8130–8183 无监听端口；其他用户浏览器进程未终止。**

## 12. Git 工作树与提交

- 当前分支：`fix/batch8e3br-content-build-concurrency`
- 计划提交信息：`fix(content): protect full sync lifecycle with build lock`
- 工作树：见第 13 节最终状态
- 保留 8E-3B-1 的 `594917a` 与 PR #22 合并历史，不重写历史。
- 按 8E-3B-R 补充要求，在 full 通过后创建本地 commit 并 push/创建 PR，由 GitHub CI 做最终验收；不自动合并、不部署。若最新口径要求仅本地交付，则以本地 commit 为准，不创建 PR。

## 13. 最终状态

`B8E3BR_LOCAL_READY`

本地全量 63/63 通过；提交与 PR 状态以本报告第 12 节和最终回复为准。

