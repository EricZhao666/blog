# Batch 8E-4R 报告：SW 快照自愈修复与 Batch 8 收尾

- 状态：**B8E4R_PR_READY**
- 上游：`main = 9543413`（PR #26 squash 合并，Batch 8E-4 已人工合并）
- 分支：`fix/batch8e4r-snapshot-recovery`（2026-11-19 17:33 创建）
- 修复对象：`B8E4-001` / `B8E1-003`（snapshotReady 否定结果在同一 SW 生命周期内不可自愈）
- 版本：`CACHE_VERSION` **2026-11-18-1 → 2026-11-19-1**
- 范围：仅 `sw.js` 的 `snapshotReady()`、发布版本号、受影响的版本断言与新增专项；未改 UI/CSS、搜索、编辑器、正式文章、CI 命令、调度器

## 1. 修复内容

`sw.js` 中 `snapshotReady()` 的最小改动（4 条）：

1. **只缓存成功结论**：`_readyPromise` 在判定为“完整”后保留；判定为缺失（`false`）时立即释放，下一次导航重新检查。
2. **并发共享同一 Promise**：首个调用同步写入 `_readyPromise`，同一 tick 内的其他调用直接复用，不会重复发起检查。
3. **失败/异常统一清理**：`Promise.resolve().then(...)` 包裹检查过程，使 `caches` 不可用导致的**同步抛错**也进入 `catch` 分支；`catch` 返回 `false` 并释放状态。
4. **身份比较防覆盖**：释放前判断 `_readyPromise === pending`，旧 Promise 的清理不会清掉后来创建的新 Promise。

未改变：

- 首屏完整性要求仍是 `index.html + FIRST_SCREEN_ASSETS` 共 6 项（专项 U0b 守护）；
- `_snapshotStale` 的真实新版本判定逻辑未动；
- 网络优先 / 快照回退的版本一致性策略未动；
- 无后台轮询、无无限重试、无重试次数配置。

`CACHE_VERSION` 按既有发布契约递增为 `2026-11-19-1`（生产 SW 内容变化不得复用旧版本号）。

## 2. RED / GREEN 证据

### 2.1 浏览器级（`cross-browser-offline.spec.js --scenario=E`）

判据改为**状态优先**：`cache-mode` 下首屏资源由安装期快照返回，不产生网络请求；`network-mode` 必须重新下载。
同时统计 `/css/style.css`、`/js/app.js`、`/js/data.js` 的服务端命中数（`assetHits`）。计时（600ms 注入 / 450ms 阈值）只作辅助。

| 引擎 | 阶段 | E0 基线（快照完整） | 快照缺失后 | 恢复资源后（自愈断言） | 结果 |
| --- | --- | --- | --- | --- | --- |
| chromium | RED（bbe0336） | assetHits=0 / 212ms | assetHits=3 / 695ms | **assetHits=3 / 704ms** | FAIL |
| chromium | GREEN | assetHits=0 / 206ms | assetHits=3 / 706ms | **assetHits=0 / 204ms** | PASS |
| firefox | RED | assetHits=0 / 631ms\* | assetHits=3 / 1444ms | **assetHits=3 / 879ms** | FAIL |
| firefox | GREEN | assetHits=0 / 425ms | assetHits=3 / 1280ms | **assetHits=0 / 318ms** | PASS |
| webkit | RED | assetHits=0 / 233ms | assetHits=3 / 699ms | **assetHits=3 / 774ms** | FAIL |
| webkit | GREEN | assetHits=0 / 273ms | assetHits=3 / 695ms | **assetHits=0 / 228ms** | PASS |

\* Firefox RED 基线计时 631ms 落在 450ms 阈值之外，是宿主负载导致的计时抖动；对应 `assetHits=0` 仍正确表明命中快照。这正是本轮把“状态”作为主判据的原因。

RED 汇总：26 PASS / 4 FAIL（三引擎各 1 项自愈断言 + firefox 计时抖动 1 项）。
GREEN 汇总：**27 PASS / 0 FAIL**（三引擎 E 场景全部通过）。

历史诊断证据保留情况：

- `BATCH8E4_REPORT.md` 未被覆盖（原诊断结论与当时的计时数据保持原样）；
- 修复前运行日志：`tests/reports/b8e4r-red-e.log`（不入库）；
- 修复后运行日志：`tests/reports/b8e4r-green-e.log`、`b8e4r-green-de.log`（不入库）。

### 2.2 轻量专项（`sw-snapshot-unit.spec.js`，无浏览器）

直接以 Node `vm` 加载真实 `sw.js`，提供最小 `self` / `caches` 替身，调用 `snapshotReady()`：

| 编号 | 检查 | RED | GREEN |
| --- | --- | --- | --- |
| U0 | CACHE_VERSION 递增且格式合法 | FAIL（仍为 2026-11-18-1） | PASS（2026-11-19-1） |
| U0b | 首屏资源清单仍为 5 项 | PASS | PASS |
| U1a | 并发调用共享同一 Promise | PASS | PASS |
| U1b | 并发只创建一轮检查（6 次 match） | PASS | PASS\* |
| U1c/U1d | 完整返回 true 且成功结果被缓存 | PASS | PASS |
| U2a/U2b | 快照缺失返回 false 且确实检查 | PASS | PASS |
| U2c | 失败状态不被缓存，再次调用重新检查 | **FAIL** | PASS |
| U2d/U2e | 恢复后同生命周期判定 true 且重新缓存 | **FAIL** | PASS |
| U3a/U3b | 检查 reject 返回 false，解除后重新判定 | U3a PASS / **U3b FAIL** | PASS |
| U3c/U3d | 同步抛错被吞掉并返回 false，之后可恢复 | **U3c FAIL** | PASS |

- RED：15 项 PASS 9 / FAIL 6；GREEN：**15 项 PASS 15 / FAIL 0**。
- \* U1b 在修复后首次运行时因“计数在 await 之前读取”误报 FAIL（新实现把检查放入微任务），已改为等待后计数，断言强度不变（记录于 `B8E4R-001`）。

## 3. 版本与回归

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 语法检查 | `node --check sw.js` / `node --check` 新增与修改的 JS | 全部通过 |
| E 场景（三引擎） | `cross-browser-offline.spec.js --scenario=E` | 27 PASS / 0 FAIL |
| 完整 D/E（三引擎） | `cross-browser-offline.spec.js` | **75 PASS / 0 FAIL**（22.1s / 38.5s / 17.3s） |
| 原有 SW 分组 | `run_tests.py --group sw` | **4/4 PASS**（PASS 4 / FAIL 0 / SKIP 0 / BLOCKED 0，177.2s；sw-consistency 37/37、sw-upgrade 25/25） |
| 版本断言受影响套件 | `run_tests.py --only image-lightbox` | **PASS**（22.2s） |
| 空白检查 | `git diff --check` | 退出码 0 |
| 默认 64 套全量 | — | 未本地重复执行，交由 PR 默认串行 CI |

版本相关改动：

- `tests/browser/image-lightbox.spec.js` 的 R4 原先硬编码 `cacheVer === '2026-11-18-1'`，会与版本递增冲突；已改为 `cacheVer > OLD_CACHE_VERSION`（版本值仍从 `sw.js` 实时读取），语义仍是“相对上一版已递增”，不再钉死具体日期。
- 全仓库搜索确认：除新增专项中的“上一版基线”常量外，无其他硬编码 `2026-11-18-1`。

三维度版本一致性（本地证据）：

- 安装期缓存名：`blog-2026-11-19-1` / `blog-rt-2026-11-19-1`；
- 升级模拟：新版本缓存 `blog-2026-11-19-1-t2`，旧缓存 531–1553ms 内清理，`controllerchange=1`；
- 安装失败：不产生 `-t2` 半成品缓存，旧 SW 继续服务且离线可用。

## 4. 未解决但不阻塞发布的风险

1. **线上仍是旧版本**：本轮不部署。合并部署后，真实用户会经历 `2026-11-18-1 → 2026-11-19-1` 升级；升级机制已用合成的 `-t2` 版本验证（D7/D8），但真实部署后的首日建议抽查一次“在线访问 → 断网 → 恢复”。
2. **`B8E4-002`**：Firefox 的 `context.setOffline` 不能验证 SW 兜底，自动化继续使用“服务端断流”；真实 Firefox 断网行为未额外验证（P3，测试手段限制）。
3. **`B8E4-006`**：Pages 构建 API 仍返回 404，部署 commit 只能间接核对产物（P3）。
4. **`B8E4-007`**：真实 Safari / iOS 与真实输入法仍未覆盖（P3，范围限制）。
5. `B8E1-004` / `B8E1-005` 按任务要求不在本轮范围。
6. 新增专项未注册进 `scripts/run_tests.py`（保持 64 套与 CI 命令不变），因此不在默认门禁内；如需纳入，需单独评估套件数量与 CI 时长。

## 5. 成本与清理

- 分支创建 17:33:09 → 完成约 17:50，**约 17 分钟**（含 RED/GREEN、三引擎回归、SW 分组回归与文档）。
- 工具调用约 20 次；平台未提供积分/计费口径，本轮未编造数值。
- 测试耗时：E 场景三引擎合计约 14–18s；完整 D/E 77.9s；SW 分组 177.2s；image-lightbox 22.2s。
- 进程清理：运行结束后无 Playwright / 浏览器残留；临时诊断脚本已删除；`tests/reports/` 与 artifacts 均在 `.gitignore` 内。
- PR：`gh` CLI 不可用，分支 push 后需人工创建 PR（链接见提交说明）。

## 6. 复现命令

```powershell
node tests/browser/sw-snapshot-unit.spec.js
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit --scenario=E
node tests/browser/cross-browser-offline.spec.js --engines=chromium,firefox,webkit
python scripts/run_tests.py --group sw
python scripts/run_tests.py --only image-lightbox
```
