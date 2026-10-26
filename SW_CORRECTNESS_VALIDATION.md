# Batch 6B-1.1：SW 性能优化正确性复核

- **结论：`B6B1_ACCEPTED`（带明确适用边界）**
- 分支：`feature/batch6-performance`；复核起点 `f27b169`（6B-1 交付）
- 复核时间：2026-10-26；真实 Chrome 156.0.8078.48（headless）+ 本地 HTTP 服务器 + 合成版本化站点
- 新增用例：`tests/browser/sw-consistency.spec.js`（**35 项，35 PASS**），已并入 `python scripts/run_tests.py`
- 全量回归：**15/15 PASS**（含 `browser` 28/28、`sw-consistency` 35/35）
- 本轮改动：`sw.js`（修复 3 个缺陷 + 1 处竞态）、测试与工具；**未 push、未合并、未部署**

**一句话结论**：6B-1 交付的实现**并没有真正生效**——它声称的"同一导航统一决策"因为用错 `clientId` 从未建立起关联，实际行为退化为"逐资源超时回退"，因此**能复现同页混版**（`html/js/css=v3 + data.js=v2`）。修复后（安装期快照 + `e.clientId` 关联 + 到达时刻判定）35 项一致性用例全部通过，移动热启动 **394 ms**（原方案 2 705 ms），且热启动网络字节从 357 KB 降到 **95 KB**。

---

## 1. 复核对象与既有实现

| 文件 | 复核关注点 |
| --- | --- |
| `sw.js` | 150 ms 超时回退、导航统一决策、后台回填、预取集合、安装失败保护、离线兜底 |
| `PERF_SW_COMPARISON.md` | 6B-1 的结论与测量口径（本轮发现其中两条结论不成立，见 §3） |
| `tests/browser/sw.spec.js` | Batch 4 的 S1–S14（安装/离线/更新/容量/预取契约） |
| `tests/perf/perf.spec.js` | 6A 采集工具 + 6B 的候选注入与逐请求记账 |
| `tests/perf/sw-candidates/` | 可切换 `prefetch`/`hotStart` 的实验副本与生成器 |

复核前先固化三个对照版本（按提交原样导出，字节数与原文件一致）：

| 代号 | 文件 | 来源 | 字节 |
| --- | --- | --- | --- |
| A | `tests/perf/sw-candidates/sw-a77bd07-network-first.js` | 6A 基线（全部 network-first） | 8 938 |
| B | `tests/perf/sw-candidates/sw-f27b169-rt.js` | 6B-1 交付（RT 回填 + 逐资源超时） | 15 567 |
| C | 仓库 `sw.js` | 本轮修复后 | 见 §7 |

---

## 2. 复核方法

### 2.1 合成版本化站点（新增）

`tests/browser/fixtures/swsite/` + `tests/browser/helpers/version-server.js`：

- 站点由 `index.html` / `css/style.css` / `js/app.js` / `js/data.js` / `js/user-posts.js` / `js/projects.js` 组成，每个文件都带 `{{ver}}` 版本标记；
- 页面把"本页实际用到的六份资源版本"写进 `window.__versions`，因此**同页混版可以直接观测**，不需要靠推断；
- 服务器支持：全局/逐路径首字节延迟（300/600/800/1200/2000 ms、以及"外壳 250 ms + data.js 2000 ms"的真实形状）、逐路径故障注入（500 / 断流，且遵守延迟）、`CACHE_VERSION` 改写（模拟发布新 SW）；
- `/blog/sw.js` 直接读仓库（或 `SW_FILE` 指定的）真实脚本，因此测的是生产代码而不是替身。

### 2.2 用例矩阵（35 项）

| 编号 | 场景 | 对应要求 |
| --- | --- | --- |
| T1 | 首次导航（无缓存） | 安装/接管/首访可用 |
| T2 | 有缓存 + 发布新版本 + 800 ms 延迟 | 不混版、走缓存、load 明显快于网络 |
| T3 | 后台回填期间连续刷新 3 次 | 不混版、最终可达新版本 |
| T4 | 快链路发布新版本 | 刷新即更新 |
| T5 | 逐路径延迟（外壳 250 / app 600 / data 2000 ms） | 回填窗口内再刷新也不混版 |
| T6 | 单资源 500（data.js） | 不崩、不混版、恢复后收敛 |
| T7 | 离线（有缓存） | 离线可用、版本自洽 |
| T8 | 离线且无缓存 | 明确离线兜底页（不是空白/不是首页） |
| T9 | SW 被 `ServiceWorker.stopAllWorkers` 终止后重启 | 重启后仍自洽 |
| T10 | 双标签页 + 新 SW 版本 | 新版本生效、旧缓存清理、两页自洽 |
| T11 | 导航 5xx（快/慢链路） | 快链路原样返回、慢链路缓存兜底、5xx 不入缓存 |
| T12 | 300 ms / 2000 ms 延迟档位 | 阈值边界行为 |
| T13 | 无缓存 + 1200 ms 延迟首次访问 | 慢链路首访不被空白缓存顶替 |
| T14 | SW 换代后离线 | 更新后离线资源仍可用 |

运行方式：

```bash
node tests/browser/sw-consistency.spec.js
SW_FILE=tests/perf/sw-candidates/sw-f27b169-rt.js node tests/browser/sw-consistency.spec.js   # 对照上一轮实现
```

---

## 3. 复核发现（4 个缺陷，均已修复）

### 缺陷 1（严重）：`clientId` 用错，"同一导航统一决策"从未生效

6B-1 用 `request.clientId` 把导航决策与子资源关联：

```js
function getNavMode(req) { if (!req.clientId) return null; ... }
```

插桩结果（Chrome 156，合成站点）：

```
[dbg] nav finish source=cache resulting="6e71a96e-..." eClient="152d7d97-..."
[dbg] pending /blog/css/style.css eClient="6e71a96e-..." reqClient=undefined
```

- 子资源请求的 **`request.clientId` 恒为 `undefined`**；
- 真正的关联键是 **`FetchEvent.clientId`**，它与导航事件的 `resultingClientId` 完全一致。

也就是说：6B-1 的缓存模式对子资源**根本没有下发**，每个资源各自走 `timeoutFirst`（150 ms 后回退缓存）。这解释了 6B-1 为什么会出现"外壳是新版、data.js 是旧版"——各资源各自超时、各自命中不同版本的缓存。

服务端命中计数进一步印证了这一点（T2，慢链路 + 有缓存，B 与 C 的对照）：

| 首屏资源 | B（6B-1）服务端命中 | C（修复后） |
| --- | --- | --- |
| `css/style.css` | 1 | **0** |
| `js/app.js` | 1 | **0** |
| `js/data.js` | 1 | **0** |
| `js/user-posts.js` | 1 | **0** |
| `js/projects.js` | 1 | **0** |

B 虽然把"较旧的那一份"给了页面，但**每个资源仍然完整回源一次**（逐资源超时链里网络请求并未取消），这也是 6B-1 热启动仍有 348 KB 流量的原因。

### 缺陷 2（严重）：缓存模式读的是"逐个回填"的 `CACHE_RT` → 可复现混版

`CACHE_RT` 是各资源按完成先后逐个写入的，而 `CACHE`（安装期）是整个 SW 版本一次性写入的。用 B（6B-1）跑同一套用例：

| 用例 | B（6B-1）结果 | 说明 |
| --- | --- | --- |
| T5 回填窗口内再刷新 | **html=3, css=3, js=3, data=2** | 外壳/app/样式已回填到 v3，`data.js` 还是 v2 → **同页混版** |
| T6 故障恢复后再刷新 | **html=2, css=2, js=2, data=1** | `data.js` 因 500 未被回填，其余已是 v2 → 混版 |
| T4 快链路刷新 | html=2（期望 3） | 上一轮后台回填占满连接，导航自身被拖过 150 ms → 落回缓存模式 |
| T12 300 ms 延迟 | 377 ms（C 为 219 ms） | 逐资源超时 150 ms × 2 段串行叠加，与"一次决策"应有的耗时不符 |

### 缺陷 3（中）：过期检测因"交付后再 clone"而静默失效

原实现在 `finish(cached)` 之后才对同一个 `Response` 调 `clone().text()`：

```
[SW] snapshot check skipped: Failed to execute 'clone' on 'Response': Response body is already used
```

异常被空 `catch` 吞掉，导致"发现新发布就升级为网络模式"这条逃生通道**从未触发**——慢链路下会一直给快照版本。

### 缺陷 4（中）：150 ms 定时器与网络首字节在赛跑，决策在同一链路上随机翻转

插桩（移动整形 150 ms 链路，同一份代码连跑 3 次）：

```
rep1: timer 153 → ready 154 → cache 154 | network 164   → 缓存（344 ms）
rep2: timer 152 → ready 155 → cache 156 | network 158   → 缓存（423 ms）
rep3: timer 155 →            network 158 | cache 160    → 网络（2671 ms）
```

- 定时器在 150 ms 触发后还要做两次 CacheStorage IPC（+3~8 ms），而整形链路的首字节就在 158 ms 到达，**相差 2~3 ms 就会翻转**；
- 结果：同一站点 5 次热启动里 3 次走网络（2 668~2 737 ms）、2 次走缓存（395~433 ms），性能不可复现。

---

## 4. 修复内容（`sw.js`）

1. **关联键改用 `FetchEvent.clientId`**（回退到 `request.clientId`），并加注释说明实测结论。
2. **缓存模式只读 `CACHE`（安装期快照）**：外壳 + 5 份首屏资源在同一个 SW 版本里一次性写入，天然同版本；同时在导航时校验快照完整性（缺一个就整份文档不用缓存模式）。
3. **取消缓存模式下的后台回填**：既消除了"回填到一半"的混版窗口，也让热启动的网络字节从 348 KB 降到 ~95 KB。
4. **过期逃生**：把这次网络取回的外壳与快照文本对比（交付前先克隆），不同即判定"服务器已有新发布"，本次 SW 生命周期内不再使用缓存模式（宁可慢也不给旧内容）。
5. **决策改为按"网络到达时刻"判定**：快照在导航开始时就并行读出（含文本），网络结果回来后用 `arrivalMs <= NAV_TIMEOUT_MS` 裁决，不再依赖定时器与 IPC 的先后。
6. `CACHE_VERSION` → `2026-10-26-2`（行为变更必须换代）。

关键代码（`sw.js`）：

```js
// 快照提前读出；文本必须在使用前取好（交付后 body 会被消费）
const snapshot = snapshotReady().then(ready => ready ? matchCore('./index.html').then(cached =>
  cached.clone().text().then(text => ({ resp: cached, text }))) : null);

// 到达时刻判定：<=150ms 用网络（新鲜），否则本次用快照并做一次过期检测
net.then(resp => {
  const arrivalMs = Date.now() - t0;
  if (arrivalMs <= NAV_TIMEOUT_MS) return finish(resp, 'network');
  snapshot.then(snap => { finish(snap.resp, 'cache'); compareSnapshot(resp, snap.text); });
});
```

---

## 5. 版本一致性证据

同一套 35 项用例分别跑 A（6A 原方案）/ B（6B-1）/ C（本轮修复后）：

| 用例 | A 原方案 | B 6B-1 | C 修复后 |
| --- | --- | --- | --- |
| T2 慢链路同页不混版 | 通过（本来就无缓存模式） | 通过 | **通过** |
| T2 慢链路走缓存（首屏不回源） | **失败**（1 698 ms，5 个资源全部回源） | **失败**（377~387 ms，5 个资源各回源 1 次 = 348 KB） | **通过（223 ms，回源 0 次）** |
| T3 回填期间连续刷新 / 收敛 | 通过 | 通过 | 通过 |
| T4 快链路刷新即更新 | 通过 | **失败**（返回旧版本） | **通过** |
| T5 回填窗口内不混版 | 通过 | **失败（html/js/css=v3 + data=v2）** | **通过** |
| T6 单资源 500 不混版 | 通过 | **失败（html=2 + data=1）** | **通过** |
| T7 离线（有缓存） | 通过 | 通过 | 通过 |
| T8 清空缓存后离线 | **失败（`net::ERR_FAILED`）** | 通过 | **通过（503 离线页）** |
| T9 SW 重启后自洽 | 通过 | 通过 | 通过 |
| T11 慢链路 5xx 用缓存兜底 | **失败**（500 直接透出） | 通过 | **通过** |
| T12 300 ms 延迟（首屏不回源） | **失败**（676 ms，全部回源） | **失败**（377 ms，全部回源） | **通过（219 ms，回源 0 次）** |
| 合计（35 项） | **30/35** | **30/35** | **35/35** |

> 三列失败的性质不同：A 的失败项是"压根没有缓存模式"（T2/T11/T12 属策略差异），但 **T8 是 A 自身的真实缺陷**——清空 CacheStorage 后离线导航首页时，`respondWith(null)` 让浏览器直接报 `ERR_FAILED`，而不是给离线页；C 用 `offlineResponse()` 兜底后恢复正常。B 的失败项是 §3 的两个混版缺陷 + "回源而非用快照"的额外流量。

C 的关键实测（`tests/browser/artifacts/sw-consistency.json`）：

- **T2**：`html=css=js=data=user=projects=1`，223 ms；**服务端对 5 个首屏资源的命中全部为 0**（`{"style.css":0,"app.js":0,"data.js":0,"user-posts.js":0,"projects.js":0}`），页面侧 `duration 5~7 ms` → 五份资源确实来自同一份快照；
- **T5**：第一次导航全 v2（快照）→ 回填窗口内再刷新全 v3（已判定过期，走网络）→ 最终全 v3；
- **T6**：`data.js` 500 期间整页仍是 v1（含 data.js，来自快照，**没有出现 data 缺失或半新半旧**）；恢复后全 v2；
- **T12**：300 ms → 219 ms（快照，0 次回源）；判定过期后 2000 ms → 4 068 ms（网络，全 v2）；
- **T13**：无缓存 + 1 200 ms 延迟首访 2 506 ms，全 v1（没有拿空白缓存顶替）。

### 5.1 `resultingClientId` / `clientId` 机制结论（可直接引用）

| 观察 | 结论 |
| --- | --- |
| 导航事件 `request.clientId` | `undefined`（顶层导航没有发起方） |
| 导航事件 `event.resultingClientId` | 新文档的 client id（如 `6e71a96e-…`） |
| 子资源事件 `event.clientId` | **等于**该文档的 `resultingClientId` |
| 子资源事件 `request.clientId` | `undefined` |
| 决策只在 SW 内存里 | SW 重启后丢失；重启后的导航会重新决策，同文档内首屏资源已在此前请求完毕，因此不产生混版（T9 实测同文档取值一致） |

---

## 6. 离线行为与预取契约

| 场景 | 结果（C） | 证据 |
| --- | --- | --- |
| 首访后离线打开首页 | 200 + 正常渲染，版本自洽 | T7 |
| 首访后离线访问未预取的代码库 | 离线兜底页（503 `data-offline=1`），不冒充首页 | Batch 4 S7 + 6B S13 |
| 在线访问 `/code` 后再离线 | 代码库数据可用（`codefiles.js` 已进运行期缓存） | S13（4 项） |
| SW 换代后离线 | 200 + 新版本页面，版本自洽 | T14 |
| 安装失败 / 回滚 | 新版本安装失败时旧 SW 继续服务、旧缓存不删、失败版本缓存清理 | S2 / S11 / S12 |
| 运行期缓存上限 | 120 条，超限淘汰最旧 | S10 |

预取契约（6B-1 变更，本轮**未**回退）：

- 首访预取 5 个（highlight / courses / course-notes / note-slugs / papers），`codefiles.js`（380 667 B）改为访问 `/code` 时按需加载；
- 首访 15 s 窗口流量：1 403 766 → 1 023 099 B（−27.1%）【实测，Batch 6B-1，未变】；
- 未访问过 `/code` 的用户离线打不开代码库——这是**有意的契约变更**，已在 S13 中明确断言，未放宽任何原有断言。

> 本轮 S14 的断言按新契约改写了：原断言（"首屏脚本慢于阈值时必须回退缓存并在 900 ms 内完成"）描述的是被取消的逐资源超时行为；新断言验证真正要保护的目标——**页面正常渲染 + 慢脚本加载后仍是新版本（没有塞回旧缓存）**，并额外要求 `fetch('./js/app.js')` 能取到 `build:v2`。断言数量从 1 条增加到 2 条，强度提高而非削弱。

---

## 7. 150 ms 策略的适用边界

| 外壳 TTFB | 决策 | 用户看到 | 代价 |
| --- | --- | --- | --- |
| < 150 ms（桌面回环、好 5G） | 网络模式 | 永远是最新版本 | 无（本来就快） |
| ≈ 150–200 ms（典型 4G；本项目整形链路 158 ms） | **本次修复后稳定落入缓存模式** | 安装期快照版本，218~394 ms 可交互 | 发版后的第一次导航可能落后一版 |
| > 阈值（慢链路 300/800/2000 ms） | 缓存模式 | 快照版本，不等网络 | 同上；流量最低（只取外壳 5.4 KB） |
| 已检测到新发布 | 强制网络模式 | 新版本，最慢（2 000 ms 链路下 4.1 s） | 慢但一致、且不无限期旧 |

边界结论：

1. **阈值语义 = "一次网络往返内拿不到外壳，就用快照"**，适合本项目（外壳 5.4 KB，链路 TTFB 150 ms 起）。
2. 阈值判定的是**外壳**的到达时间，而真正贵的是 `data.js`/`app.js`（114/103 KB）。所以"外壳快但带宽差"的网络（TTFB 120 ms + 1 Mbps）会落到网络模式并付出 3 s 级加载；这是有意的取舍（宁新不旧），并非缺陷。
3. 修复前该阈值与整形链路的首字节几乎重合（158 ms vs 150 ms），导致同一站点在 395 ms 与 2 671 ms 之间随机跳变（5 次里 2 次缓存 / 3 次网络）；修复后 5/5 稳定走缓存，正式复测 load 394.4 ms [368.5~457.1]。
4. **仍需遵守的发版纪律**：任何资源变更都要递增 `CACHE_VERSION`（`test14` 已强制校验）。若只改 `app.js`/`data.js` 而不 bump，缓存模式用户会一直停留在旧快照——这是本方案唯一未被自动化解的残留风险（见 §10）。

---

## 8. 性能复测对照（沿用 Batch 6A 环境，5 次/格）

同一台机器、同一 Chrome、同一整形参数（1638.4 kbps / 150 ms / 4× CPU）、同一观测探针；只替换被测 SW。

### 8.1 首页热启动

| 指标（中位数 [最小~最大]） | A 原方案 | B 6B-1 | **C 6B-1.1** |
| --- | --- | --- | --- |
| 移动 load | 2 704.5 [2 682~2 750] | 516 [482~589] | **394.4 [368.5~457.1]** |
| 移动 DOMContentLoaded | 2 642.5 [2 640~2 700] | 458 [445~508] | **343.2 [327.4~399.4]** |
| 移动 FCP / LCP | 436 [436~512] | 420 [404~460] | **312 [296~424]** |
| 移动 TBT 近似 | 37 | 33 | 36 |
| 桌面 load | 103.4 [93.4~108.6] | 117.7 [99.2~123.6] | **90.2 [81.4~96.3]** |
| 桌面 FCP | 64 | 76 | 60 |
| **移动导航窗口网络字节** | 357 381 | 348 443 | **94 735（−73.5%）** |
| 移动服务器请求数 | 9 | 9 | **4** |
| 桌面网络字节 | 357 381 | 364 010 | 367 151 |

- 移动端相对原方案 **−85.4%**（2 704.5 → 394.4 ms），相对 6B-1 **−23.6%**。
- **字节变化是真实的**：C 在缓存模式下只取外壳（5 440 B）+ vendor 后台校验（70 587 B）+ `sw.js` 更新检查，**不再重下 348 KB 首屏资源**；B 仍每次导航后台重下 9 个资源。
- 桌面没有整形延迟，外壳 5~15 ms 到达 → 走网络模式，因此桌面数值≈原方案（差异在噪声区间）。

### 8.2 首访（冷启动）

| 指标 | A 原方案 | B 6B-1 | C 6B-1.1 |
| --- | --- | --- | --- |
| 移动 load | 3 604.1 [3 580.9~3 767.4] | 3 672.9 [3 554.8~3 733.1] | 3 561.7 [3 522~3 632.3] |
| 移动 FCP | 1 468 [1 448~1 516] | 1 536 [1 488~1 576] | 1 544 [1 468~1 664] |
| 桌面 load | 454.5 [391.7~525.4] | 439 [397.8~455.6] | 414.7 [355.7~551.9] |
| 桌面窗口字节 | 1 399 438 | 985 497 | 988 638 |

首访无变化（预取仍在 `load` 之后启动，且 `Codefiles` 已移出预取集合——两项与 6B-1 相同）。首访 15 s 窗口流量沿用 6B-1 的实测：1 403 766 → 1 023 099 B。

### 8.3 后台校验 / 新鲜度 / 错误率

| 项 | A 原方案 | B 6B-1 | C 6B-1.1 |
| --- | --- | --- | --- |
| 首屏资源后台重下 | 无（前台同步下载） | **每次导航 348 443 B** | **无** |
| 后台校验链路占用【计算】 | — | ≈1.70 s（348 443 B ÷ 204.8 KB/s） | ≈27 ms（仅外壳 5 440 B） |
| 版本一致性（35 项） | — | **30/35（含 2 处混版）** | **35/35** |
| 最终资源新鲜度 | 每次导航最新 | 后台回填后最新（但回填窗口内可混版） | 快链路立即最新；慢链路落后 1 次导航后切网络模式 |
| 样本错误数 | 20/20 无错误 | 20/20 无错误 | 20/20 无错误 |

> 探针记录的是"服务器侧响应完成时刻"，在整形链路下会低估客户端完成时间（`firstScreenNetEndMs` 移动端 421 ms 而页面 load 2 704 ms）。因此"后台校验链路占用"用字节量【计算】给出，不用探针时刻。

---

## 9. 全量回归

```
python scripts/run_tests.py
```

| 用例 | 结果 |
| --- | --- |
| 语法检查（30 个文件） | 全部 OK |
| `audit` / `test6` / `test7` / `test8` / `test9` / `test10` / `test11` / `test14` | PASS |
| `test12` 25/25、`test13` 40/40、`test15` 32/32、`test16` 20/20、`test17` 11/11 | PASS |
| `browser`（Batch 4，S1–S14） | **28/28 PASS** |
| `sw-consistency`（本轮新增，T1–T14） | **35/35 PASS** |
| 汇总 | **PASS 15 / FAIL 0 / SKIP 0 / BLOCKED 0** |

`test7` 的源码级断言（`SW 只把入口页写成 index.html 缓存`）在 6B-1 已按新实现改写并保留原意图；本轮 `sw.js` 结构变化没有影响该断言（仍通过）。

---

## 10. 结论、残留风险与后续

### 判定：`B6B1_ACCEPTED`

理由：
1. 同页混版的两个成因（`clientId` 用错、读可变 RT 缓存）都已消除，35 项一致性用例全绿；
2. 版本更新、双标签页、SW 重启、离线、5xx、部分资源失败均有实测覆盖，没有削弱任何 Batch 4 断言；
3. 性能收益比 6B-1 更大且**不再依赖"读旧缓存"**：热启动字节同时下降 73.5%；
4. 回退路径（A 原方案）也做过同口径复测，收益归因清楚。

### 残留风险（已量化，不阻塞）

| 风险 | 现状 | 缓解 |
| --- | --- | --- |
| 只改资源、忘 bump `CACHE_VERSION` | 缓存模式用户会停留在旧快照，直到下一次 SW 更新 | `test14` 强制要求 bump；上线流程复核 |
| 慢链路 + 已有新发布 | 落后 1 次导航（之后切网络模式，2000 ms 链路下 4.1 s） | 有意的取舍：一致性优先 |
| SW 在"外壳返回"与"子资源请求"之间被杀 | 理论上会丢失决策，子资源退回网络优先（可能较新） | 窗口 <50 ms 且 Chrome 空闲 30 s 才回收；T9 覆盖"重启后重新导航" |
| vendor 资源仍走 SWR | 每次热启动仍校验 ~70 KB | 属 Batch 4 契约，本轮不改 |

### 建议的后续（不在本轮范围）

1. **构建期版本标记**：在 `index.html` 里内联一个 `buildId`（或对 `data.js` 用内容哈希命名），即可把"资源变更但没 bump SW"的残留风险降到 0，也能替代"比对外壳文本"的过期检测。
2. 预取与安装期重复下载（约 308 KB/首访）仍待处理。

---

## 11. 变更文件与 Git Diff

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `sw.js` | 改 | 快照只读 `CACHE`、`e.clientId` 关联、到达时刻判定、过期升级；`CACHE_VERSION` → `2026-10-26-2` |
| `tests/browser/sw-consistency.spec.js` | 新增 | 35 项一致性/边界用例（支持 `SW_FILE` 对照任意版本） |
| `tests/browser/helpers/version-server.js` | 新增 | 合成版本化站点服务器（延迟/故障/版本切换/SW 换代） |
| `tests/browser/fixtures/swsite/**` | 新增 | 带版本标记的合成站点（9 个文件） |
| `tests/browser/sw.spec.js` | 改 | S14 按新契约改写（2 条断言，强度提高） |
| `tests/perf/perf.spec.js` | 改 | 新增 `firstScreenNetEndMs`（首屏后台请求完成时刻） |
| `tests/perf/sw-candidates/sw-a77bd07-network-first.js` | 新增 | 6A 原方案快照（对照用，按提交原样导出） |
| `tests/perf/sw-candidates/sw-f27b169-rt.js` | 新增 | 6B-1 交付快照（对照用） |
| `tests/perf/reports/batch6b11/*.json` | 新增 | 三方案性能复测原始数据 |
| `scripts/run_tests.py` | 改 | 新用例并入统一入口 |
| `PERF_SW_COMPARISON.md` | 改 | 顶部加复核结论与勘误指针 |

```bash
git diff f27b169 -- sw.js            # 本轮 SW 改动
git diff f27b169 --stat              # 全部改动
git log --oneline -3
```

## 附录：复现命令

```bash
# 一致性（当前实现）
node tests/browser/sw-consistency.spec.js

# 一致性（对照 6B-1）
SW_FILE=tests/perf/sw-candidates/sw-f27b169-rt.js node tests/browser/sw-consistency.spec.js

# 性能复测（三方案，冷/热启动 × 桌面/移动 × 5 次）
node tests/perf/perf.spec.js --scenarios cold-home,warm-home --configs desktop,mobile --repeat 5 --no-diagnostics \
     --sw-file tests/perf/sw-candidates/sw-a77bd07-network-first.js --out tests/perf/reports/batch6b11/perf-network-first.json
node tests/perf/perf.spec.js --scenarios cold-home,warm-home --configs desktop,mobile --repeat 5 --no-diagnostics \
     --sw-file tests/perf/sw-candidates/sw-f27b169-rt.js --out tests/perf/reports/batch6b11/perf-f27b169.json
node tests/perf/perf.spec.js --scenarios cold-home,warm-home --configs desktop,mobile --repeat 5 --no-diagnostics \
     --sw-file sw.js --out tests/perf/reports/batch6b11/perf-6b11.json

# 全量回归
python scripts/run_tests.py
```
