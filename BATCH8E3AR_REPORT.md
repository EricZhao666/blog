# Batch 8E-3A-R S12 时序稳定性修复报告

- 日期：2026-11-18
- 分支：`perf/batch8e3a-test-infrastructure`
- 基线：`ce27b46`（main）+ `50bb398`（8E-3A 本地 commit）
- 范围：仅 `tests/browser/sw.spec.js` 的 S12 等待方式；不修改业务代码、SW、CI、其他测试行为
- 最终状态：B8E3AR_PR_READY

## 1. 基线确认

| 项 | 值 |
| --- | --- |
| main | `ce27b46` |
| 8E-3A commit | `50bb398 perf(test): Batch 8E-3A improve runner reliability and observability` |
| 工作树起点 | 干净（仅 8E-3A 文档存在一处格式差异，随本批一并提交） |
| 8E-3A 全量 | 60 PASS / 1 FAIL / 0 SKIP / 0 BLOCKED，1270.4s |
| 已知失败 | `browser` S12（36/37）；单独复现 37/37 PASS |

## 2. 根因分析

### 2.1 旧实现

```js
await waitController(t1);
const oldNames = Object.keys(await cacheKeys(t1));
state.swBump = true;
const t2 = await ctx.newPage();
await gotoApp(t2, base);
const ok2 = await waitController(t2);
await sleep(2500);                          // 固定窗口
const newCache = names.find(n => ...endsWith('-t2'));  // 任意 -t2
check('S12 新版本在第二个标签页安装并生效', ok2 && !!newCache, ...);
```

三个问题叠加：

1. `waitController(t2)` 只判断 `navigator.serviceWorker.controller` 是否存在，**不区分新旧版本**；t2 首次加载可能已被旧 SW 控制，返回 true 不代表新版本安装。
2. 固定 `sleep(2500)` 把“安装 + 激活 + clients.claim”压缩进一个没有依据的时间窗口；全量后段负载下，SW 更新检查/安装可能超过 2.5s。
3. 只检查任意以 `-t2` 结尾的 core 缓存，**没有验证预期版本**，也没有证明新 SW 已激活并接管旧标签页。

这与 8E-3A 的实际失败证据一致：断言时缓存列表仅 `blog-2026-11-18-1,blog-rt-2026-11-18-1`；同一 S12 的后续检查（旧缓存清理、旧标签页被接管）却通过——说明新版本最终确实激活，只是固定窗口内未完成。

### 2.2 可控复现（RED）

为验证根因，使用 `git show 50bb398:tests/browser/sw.spec.js` 生成隔离临时副本，仅在 S12 发布前注入测试服务器已有的延迟机制：

```js
state.delays['/sw.js'] = 3000;   // 延迟新版本发布发现 3s
```

结果（`b8e3ar-verify-old_delay.log`）：

- `browser` 37 项：**36 PASS / 1 FAIL**；
- `S12 新版本在第二个标签页安装并生效` FAIL，断言时缓存仍为旧版本；
- 同一 S12 的“旧版本缓存被清理”“旧标签页被接管”随后 PASS。

这与 8E-3A 全量失败的形态一致，证明“固定 2.5s 窗口 + 只看任意 controller/任意 `-t2`”可以在可控延迟下稳定复现，而非运行器改造引起。

> 说明：原始全量故障无法在不注入延迟的情况下稳定复现；RED 证据来自等价代码路径的可控延迟，不是伪造的原始日志。

## 3. 修复方案

### 3.1 预期版本 core cache

新增 `fetchSwVersion(base)`：从测试服务器 **Node 直连**读取当前发布的 `/blog/sw.js`，解析 `CACHE_VERSION`，构造预期 core cache：

```js
const expectedCore = 'blog-' + newVersion;   // e.g. blog-2026-11-18-1-t2
```

不在页面内 `fetch`，避免被旧 SW 的缓存策略截获而读到旧版本。`newVersion` 由测试服务器的 `state.swBump` 决定，能覆盖默认 SW 与候选 SW（探针）两种模式。

### 3.2 有界状态等待

新增 `waitForUpgrade(t1, expectedCore, 10000)`，每 100ms 读取一次，满足全部条件才成功：

- `caches.has(expectedCore)` 为 true（预期版本 core cache 已安装）；
- `registration.active.state === 'activated'`；
- 无 `waiting` / `installing`；
- t1 的 `controllerchange` 计数 > 0（旧标签页已被新 SW 接管）。

`caches.has` / `caches.keys` 均为无副作用读取；S12 不再通过 `caches.open` 列举缓存，避免意外创建不存在缓存。

### 3.3 旧缓存清理与诊断

- `waitCacheGone(t1, oldCache, 5000)`：有界轮询，保留“旧版本缓存必须被清理”的原断言；
- 超时失败时断言 `extra` 输出：`expectedCore / elapsedMs / names / activeState / waiting / installing / t1Controller / controllerChanges / t2Controller`；
- 保留 `controlled1`（t1 初始被旧 SW 控制）与 `ok2`（t2 controller 存在）作为前置验证；
- 保留旧标签页正常渲染检查。

### 3.4 断言保持

- S12 仍是 3 项断言，名称不变，`browser` 总数仍为 **37**；
- “新版本在第二个标签页安装并生效”由 `ok2 && 任意 -t2` 收紧为 `controlled1 && ok2 && 预期版本缓存 + activated + controllerchange`，**只增强不弱化**；
- 未删除断言、未增加自动重试、未延长固定 sleep、未强制刷新/重注册 SW、未修改生产 SW 的 `skipWaiting` / `clients.claim` / 缓存策略。

### 3.5 资源释放

- t1 的 `controllerchange` 监听器随 BrowserContext 关闭释放，无跨场景泄漏；
- 所有等待均有明确上限（10s / 5s），轮询间隔 100ms，无无限等待；
- `ctx.close()`、`finally` 中的 `browser.close()`、`server.close()`、`probe.server.close()` 保持不变。

## 4. 稳定性验证

| 检查 | 结果 |
| --- | --- |
| `node --check tests/browser/sw.spec.js` | PASS |
| `browser` 连续 3 次 | **37/37 × 3**；42.3s / 42.0s / 41.4s |
| S12 实际等待（3 次） | 3604ms / 3630ms / 3699ms |
| 预期 core cache（3 次） | 均为 `blog-2026-11-18-1-t2` |
| 延迟 3s 下旧实现（RED） | 36/37；S12 FAIL（旧缓存仍在） |
| 延迟 3s 下新实现（GREEN） | **37/37**；S12 PASS，等待 6687ms |
| 负向：不发布新版本 | **FAIL**；S12 超时 10069ms，`controllerChanges=0`，缓存仍为旧版本 |
| `runner-infrastructure` | **18/18 PASS**，8.1s |
| `sw-consistency` | **37/37 PASS**，95.6s |
| `sw-upgrade` | **25/25 PASS**，31.1s |
| 最终代码 `browser`（专项复跑） | **37/37 PASS**，48.1s |
| 全量回归（61 套） | 两次：首次 60/1（仅 `test23` C17 `[0,1]`）；第二次 **61/61 PASS**，1256.0s |

负向验证说明：当新版本未发布时，`waitForUpgrade` 在 10s 上限后失败并输出诊断，不会因旧缓存/旧 controller 存在而误判 PASS；同时“旧版本缓存被清理”也按预期失败。

**结论边界**：连续 3 次 + 最终 full 通过是稳定性采样，不等于统计证明 S12 永不再发生时序失败；后续仍应保留该套件在 full 中运行。

## 5. 全量回归

为保留首次失败证据，两次 full 使用独立报告文件，未覆盖：

| 次序 | 结果 | wall | `browser` | `test23` | 证据 |
| --- | --- | --- | --- | --- | --- |
| 第一次 | 60 PASS / 1 FAIL / 0 SKIP / 0 BLOCKED | 1263.9s | 37/37 PASS | 40/41，C17 `[0,1]`（允许 `[0,0]`/`[0,3]`） | `tests/reports/last-run.md` / `b8e3ar-full.json` |
| 第二次 | **61 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED** | 1256.0s | 37/37 PASS | 41/41 PASS | `tests/reports/b8e3ar-full2.md` / `b8e3ar-full2.json` |

- 第一次 full 的 `browser` S12 已通过；唯一失败是既有的 `test23` 并发构建用例 C17，返回码组合 `[0,1]`。
- `test23` 单独复跑：**41/41 PASS**，C17 返回 `[0,0]`（17.3s）；未修改该测试，未降低断言。
- 第二次 full：所有 61 套通过，包括 `test23` 与 `browser`。
- 结论边界：两次 full 通过（第二次全绿）不等于统计证明所有时序波动永久消失；首次 `test23` 波动与本批 S12 修改无关，保留为独立风险记录。

## 6. 变更文件

| 文件 | 变更 |
| --- | --- |
| `tests/browser/sw.spec.js` | S12 改为预期版本缓存 + activated + controllerchange 的有界状态等待；新增 S12 专用只读辅助函数 |
| `BATCH8E3A_REPORT.md` | 标注 S12 已由 8E-3A-R 修复、全量恢复 61/61 |
| `BATCH8E3B_NEXT_PLAN.md` | Task 0 标记完成，后续任务序号与前置条件更新 |
| `BATCH8E3AR_REPORT.md` | 本报告 |

未修改：业务代码、UI、正式内容、`sw.js`、`CACHE_VERSION`、CI 配置、其他测试。

## 7. 进程与工作树

- 临时 RED/GREEN/负向副本已删除，未入库；
- 全量结束后检查固定端口 8130–8183 无监听，无本任务遗留 Node/Chromium 子进程；
- 工作树：提交后 clean（本批 commit 含 `tests/browser/sw.spec.js` 与 4 份文档）。

## 8. 提交与 PR

- 本地 commit：`test(sw): stabilize multi-tab service worker upgrade verification`（本批新增，保留 `50bb398`）
- 远程分支/PR：`perf/batch8e3a-test-infrastructure`；push 后创建 PR，URL 见最终回复与 GitHub

## 9. 最终状态

**B8E3AR_PR_READY**

- 单次 full 61/61 是发布门禁通过，不代表 S12 的时序问题已被统计性消除；
- 未自行合并或部署，等待 CI 与人工审核。
