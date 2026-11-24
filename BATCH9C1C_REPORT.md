# Batch 9C-1C 报告：OEE 工业生产效率与损失分析实验室

- 分支：`feat/batch9c1c-oee-analysis-lab`（基于 main `79190b3`）
- 模型：按任务书 Qwen 4 Max（Agent 无法自核平台模型路由，如实记录）
- 范围：新增无后端 OEE 分析实验 `#/lab/oee-analysis`；PID 教学口径小修订（不重写算法）；不进入 9B-2 / 9C-2 / OEE 之外的模块。
- 最终状态：**B9C1C_PR_READY**（见 §9）

## 1. 基线核验

| 项 | 结果 | 证据 |
| --- | --- | --- |
| PR #36（9C-1B）已合并 | ✅ Merged，3 checks passed | https://github.com/EricZhao666/blog/pull/36 |
| 当前 main | ✅ `79190b3`（与任务书一致） | `git rev-parse origin/main` |
| main CI #143 | ✅ tests #143 completed successfully（12m29s，79190b3） | https://github.com/EricZhao666/blog/actions/workflows/tests.yml?query=branch%3Amain |
| PR #36 CI | ✅ 3 checks passed（任务书口径 79 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED） | PR #36 页 checks |
| 线上部署 | ✅ Pages #63 completed successfully | https://github.com/EricZhao666/blog/actions/workflows/pages/pages-build-deployment |
| 线上 SW 版本 | ✅ `CACHE_VERSION = '2026-11-24-1'` 与 main 一致 | https://ericzhao666.github.io/blog/sw.js?cb=20261124115300（缓存破坏参数实时抓取） |

本地 main 快进到 `79190b3` 后创建功能分支。未重新开展全站审查。

## 2. 范围与入口

- 新路由 `#/lab/oee-analysis`；`#/lab` 实验列表扩为三卡（2R / PID / OEE），三个实验均可独立深链接访问。
- 两个既有演示页顶部互链增加 OEE 入口；**导航「实验」href 保持 `#/lab/robot-2r` 不变**，既有深链接与导航断言不破坏。
- 功能：生产参数输入（计划/停机分钟、理想机器周期秒、穴数、总/合格件数）、A/P/Q/OEE 自动计算、理论产能（计划/运行两口径）与实际产量、时间损失守恒分解（SVG 堆叠图 + 数值表）、有效生产时间、A/B 改善情景（实际输入对比）、停机减少假设投影（显式假设）、3 个教学示例、恢复默认、公式/口径说明与异常提示。
- 不连接真实工厂数据库、不读取企业内部生产数据；演示参数仅当前会话有效，不进学习统计/浏览历史。
- 2R 运动学算法零改动（`js/robot-kinematics.js` / `js/robot-demo.js` 未触碰）；知识库 schema / 推荐算法 / 学习统计 / 项目数据未触碰。

## 3. 数学模型与口径（摘要，详见 OEE_CALCULATION_MATH.md）

- 统一口径：Run = Planned − Downtime；A = Run/Planned；P = c×N/Run；Q = G/N；OEE = A×P×Q；交叉验证 OEE = c×G/Planned（分母有效时恒等，实测偏差 1.11e-16）。
- 计划生产时间已排除不计划生产时间，同一停机不重复扣减；产量统一件数（非模次）。
- 单位显式换算：UI 分钟/秒 → 模块内部一律秒（plannedSec = plannedMin×60）。
- 多穴：理想单件周期 = 理想机器周期 ÷ 穴数，**只除一次**；4 穴 20 秒/模与等价单穴 5 秒/件逐字段一致（偏差 0）。
- 损失守恒：停机 + 性能 + 质量 + 有效 = 计划时间（代数恒等，100 组随机输入相对误差 <1e-9）。
- Performance>100% 不截断（实测 10/9=111.11% 如实显示），负性能损失如实保留，隐藏非负堆叠图并给出四项检查清单（理想周期/单位/穴数/统计窗口）。
- 分母为零 → 「不适用」（null），绝不 NaN/Infinity/虚构 100%；计划有效且零合格产出 → OEE 按时间公式 = 0，A/P/Q 分别判断；零运行时间却有产量 → 不一致数据，OEE 置 null。
- 基础验证样例（独立硬编码期望，非被测算法生成）：450/45/30s/720/684 → A=90%、P=88.888889%、Q=95%、OEE=76%；损失 45/45/18/342 分钟。全部精确命中。
- A/B 为实际输入对比；停机投影显式假设 P/Q/理想周期不变，标注「假设预测，非已验证生产收益」；教学要点：只减停机不改产量时 OEE 不变（损失从停机转移到性能）。

## 4. 工程实现

| 文件 | 变更 |
| --- | --- |
| `js/oee-calculation.js` | 新增：纯函数计算模块（IIFE + global + module.exports，可 Node require），校验/计算/对比/投影/示例 |
| `js/oee-demo.js` | 新增：原生 SVG UI（renderPage/mount/getState，监听器全挂 root 内部，`__oeeHandle` 数值快照），防抖 120ms，计算 O(1) 无无界循环 |
| `js/app.js` | STATIC_META 增 `/lab/oee-analysis`、`loadOeeLab`（缓存 Promise 失败清除）、互链/列表三卡、router 分支（按需加载 + 降级 + token 防串页） |
| `css/style.css` | 追加 `.oee-*` 段（全设计令牌；900px 单列、480 紧凑、触控 ≥40px、focus-visible）；`.pid-panel`/`.oee-panel` 增 `min-width:0`、新增 `.pid-ess-note` |
| `sw.js` | `CACHE_VERSION` 2026-11-24-1 → **2026-11-24-2**；`OPTIONAL_ASSETS` += 两个 OEE 脚本；REQUIRED 8 项 / FIRST_SCREEN 7 项 / 缓存策略不变 |
| `scripts/run_tests.py` | 注册 oee-math / oee-analysis；lab 组 6 套、browser 组 17 套；**full = 81 套** |
| `js/pid-demo.js` / `js/pid-simulation.js` | PID 口径小修订（§5.3），算法零改动 |
| `index.html` | 零改动（导航 href 不变） |

## 5. 测试（本地实跑）

### 5.1 新增专项

| 套件 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| oee-math（tests/test58_oee_math.js） | **56/56 PASS** | 0.1s | 公式/交叉验证/多穴/单位/守恒/边界/异常/P>100%/非法输入/A-B/投影/确定性/随机性质/极大数值；期望值独立硬编码 |
| oee-analysis（tests/browser/oee-analysis.spec.js） | **47/47 PASS** | 24.5s | chrome 158 + firefox/webkit 390px；数值一致/示例/多穴/A-B/投影/异常提示/非法输入/防抖/390px 触摸/深色/键盘无障碍/离线/降级/快速路由 |
| sw-snapshot-unit | **15/15 PASS** | <1s | 版本格式与递增（2026-11-24-2）；首屏 7 / REQUIRED 8 不变 |

### 5.2 受影响回归（14 套，串行实跑）

**PASS 14 / FAIL 0 / SKIP 0 / BLOCKED 0**，总耗时 379.9s（修复 PID 390px 断行回归后重跑的干净记录；正式报告 `tests/reports/b9c1c-affected.md/.json`）。

| 套件 | 结果 | 耗时 |
| --- | --- | --- |
| audit（全站巡检：路由/死链/静态页/404 资源） | PASS | 23.0s |
| test7（搜索/主题/静态页/SW/RSS） | PASS | 16.9s |
| sw-consistency | PASS 37/37 | 93.0s |
| sw-upgrade | PASS 25/25 | 29.3s |
| ui-refresh（导航单行/入口/视觉契约） | PASS 59/59 | 39.0s |
| performance-accessibility | PASS 59/59 | 56.4s |
| personalized-home | PASS 58/58 | 12.8s |
| home-experience | PASS 41/41 | 30.4s |
| robot-math（2R 算法零改动） | PASS 50/50 | 0.1s |
| robot-kinematics | PASS 44/44 | 21.9s |
| pid-math（含新增 M3.6） | PASS 53/53 | 0.2s |
| pid-control（含末段平均误差标注） | PASS 45/45 | 25.7s |
| oee-math | PASS 56/56 | 0.1s |
| oee-analysis | PASS 47/47 | 24.1s |

完整默认串行回归（81 套）按任务书交 PR CI，不重复本地全量。

### 5.3 PID 教学口径小修订（不重写算法）

1. **末段平均误差标注**：仿真未收敛时，末尾 5% 样本均值计算的误差在 UI 明确标注为「末段平均误差」（单模式 dt 标签切换；对比模式逐行块级标注），不冒充真实稳态误差；`pid-simulation.js` 仅注释澄清，`metrics.ess` 数值契约不变。
2. **文档修正**：`PID_CONTROL_MATH.md` 删除「一阶对象仅 P 控制永不超调」的无条件表述，改为：连续理想 P 单调；**离散 P 的稳定性与超调取决于采样周期与闭环极点** p = a − b·Kp，p<0 时振荡收敛并超调。
3. **新增数值测试 M3.6**：τ=1、dt=1、Kp=2 → 闭环极点 **−0.8964**，y[1]=**1.2642**>1，超调 **26.42%**，未收敛如实判未稳定。pid-math 52 → **53 项，53/53 PASS**。
4. 修订过程中发现并修复一处真实 UI 回归：对比表「数值+（末段平均）」被 UAX14 视为不可断行块，在 firefox/webkit 390px 撑宽网格（scrollWidth 417>390）；标注改为块级 span 独立成行 + 面板 `min-width:0`，pid-control 恢复 **45/45 PASS**。
5. 既有 pid-control 专项 R1.2/R1.3 的互链/列表期望**保持严格相等断言**，仅按新事实扩展 OEE 条目（不削弱覆盖）。

## 6. 发布契约

- `CACHE_VERSION`：2026-11-24-1 → **2026-11-24-2**（递增契约）。
- 两个 OEE 脚本进入既有 `OPTIONAL_ASSETS`，复用 warmOptionalAssets 预热与离线加载机制；实测在线访问后两脚本入缓存、离线重载可渲染可改参且独立重算一致（R12）。
- 预热失败/脚本 404 正确降级为「加载失败 + 重试」，首页不受影响（R13）。
- 既有机器人及 PID 实验不受影响（R1.4/R1.5 + robot-kinematics/pid-control 回归全绿）。
- 首屏资源集合无扩张（FIRST_SCREEN 7 项、REQUIRED 8 项不变）；SW 缓存一致性策略不变（sw-consistency/sw-upgrade 回归验证）。

## 7. 剩余限制

- 单设备/单线 OEE 口径；不含多设备线体平衡、换型细分、停机分类统计。
- 性能损失为时间等效模型，不区分小停机与速度损失物理来源。
- 假设投影保持 P/Q/理想周期不变，不含 ramp-up、质量-速度耦合等效应；不宣称已验证收益。
- 不做排产优化/离散事件仿真；演示状态不持久化、不接真实工厂数据。
- PID 修订仅限教学口径与一处 UI 断行修复；未新增二阶对象或抗饱和算法。

## 8. 平台计量（如实记录）

| 项 | 值 | 口径 |
| --- | --- | --- |
| 墙钟时间 | 约 45 分钟（2026-11-24 11:52:23 开始，结束时刻见 git log） | shell/系统时间戳；含基线核验、实现、专项、两轮回归（首轮发现并修复 PID 390px 断行回归）、文档、提交与 PR |
| Token | 未知 | 平台未向 Agent 暴露 |
| 积分 | 未知 | 平台未向 Agent 暴露 |
| 模型 | Qwen 4 Max（任务书指定） | Agent 无法自核平台路由；本轮未做模型对比 |

预算检查点 45 分钟：未通过减少数值验证降低验收标准（数学 56 项 + 浏览器 47 项 + 14 套受影响回归全部实跑）。

## 9. 提交与 PR

- 分支：`feat/batch9c1c-oee-analysis-lab`（基于 `79190b3`）
- 提交：`feat: Batch 9C-1C add OEE analysis and production loss lab`（提交号见 git log；PR 链接创建后补记）
- PR：本轮允许 push 与创建 PR（base = `main`）；**不自动合并、不部署**，完整 81 套回归由 PR CI 验证。
- 完成后停止，不自行进入 9B-2 或 9C-2。