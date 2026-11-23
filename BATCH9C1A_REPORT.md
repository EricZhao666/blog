# Batch 9C-1A 报告：二连杆机器人运动学交互演示

- 状态：**B9C1A_PR_READY**（新增专项 + 受影响回归全部通过；允许 push 与创建 PR，不自动合并、不部署）
- 基线：`origin/main = 2ca2258`（Batch 9F PR #34 已 squash 合并，merged_at 2026-11-23 17:44:05 +0800；PR 页面 **3 checks passed**；线上 `sw.js` 实测为 `2026-11-23-2`，部署正常）
- 分支：`feat/batch9c1a-robot-kinematics`（创建于同步后的 main `2ca2258`）
- 版本：`CACHE_VERSION 2026-11-23-2 → 2026-11-23-3`（`js/app.js`、`css/style.css`、`index.html` 有变更）
- 首屏清单：`REQUIRED_ASSETS`（8 项）/ `FIRST_SCREEN_ASSETS`（7 项）**未变**；两个演示脚本加入 `OPTIONAL_ASSETS` 预热集合
- 数据契约：知识库结构 / 推荐算法 / 学习统计口径 **完全未触碰**；演示页不写 Knowledge、不产生任何个人数据、无持久化
- 测试套件：75 → **77**（新增 `robot-math`、`robot-kinematics`）
- 模型：按任务书指定 **Qwen 4 Max**，不使用 DeepSeek Flash，未进行任何模型对比实验（平台侧路由配置，Agent 无法独立核验底层模型标识，如实记录）

## 1. 交付内容

### 1.1 新增

| 文件 | 作用 | 体积 |
| --- | --- | --- |
| `js/robot-kinematics.js` | 纯计算数学模块：FK / 解析 IK / 双分支 / 工作空间 / 奇异与数值保护（UMD，可 Node require） | 7.8 KB |
| `js/robot-demo.js` | SVG UI 模块：渲染 / 拖动 / 键盘 / 输入 / 分支切换 / 读数（无框架、无全局监听器） | 23.7 KB |
| `tests/test56_robot_kinematics.js` | 数学专项 50 项（固定种子 PRNG，可复现） | 16.7 KB |
| `tests/browser/robot-kinematics.spec.js` | 真实浏览器专项 44 项（含 firefox/webkit 代表场景） | 28.8 KB |
| `ROBOT_KINEMATICS_MATH.md` | 坐标系 / 公式 / 分支约定 / 容差策略 / 奇异处理 / 验证方法与实测误差 | — |
| `BATCH9C1A_REPORT.md` / `BATCH9C1A_TEST_MATRIX.csv` | 本批交付物 | — |

### 1.2 修改

| 文件 | 变更 | 是否触及持久化契约 |
| --- | --- | --- |
| `js/app.js` | `STATIC_META` 新增路由元数据；导航激活态支持 `/lab`；router 新增 `/lab/robot-2r` 分支（按需加载 + 路由 token 防串页 + 失败降级）；`loadRobotLab()` 缓存加载 Promise | 否 |
| `index.html` | 导航新增「实验」入口（`#/lab/robot-2r`，位于「项目」之后） | 否 |
| `css/style.css` | `.robot-*` 样式段（全部走设计令牌，双主题自动适配；900px 折叠单列、480px 紧凑内边距） | 否 |
| `sw.js` | `CACHE_VERSION` 递增；`OPTIONAL_ASSETS` 追加两个演示脚本（<32KB，随 warmOptionalAssets 预热保证离线） | 否（网络/快照策略未改） |
| `scripts/run_tests.py` | 注册 2 个新套件；新增 `lab` 调试分组；`browser` 分组补入 `robot-kinematics` | 否（调度器与 CI 默认执行未改） |

## 2. 功能覆盖（对照任务书）

| 要求 | 实现 | 验证 |
| --- | --- | --- |
| 输入 L1 / L2 | 数字输入（UI 范围 10–300；数学模块接受任意正有限值），非法值拒绝并保留上一组有效值 | R4.1–R4.4 / M6 |
| 拖动末端目标点 | Pointer Events（鼠标 + 触摸），rAF 节流，`touch-action:none`；键盘方向键（Shift×10、Home 复位）与目标 X/Y 输入等效 | R2 / R6 / R7.3 / R9 |
| 显示当前姿态 | SVG 连杆 / 关节 / 角度弧标注 + θ1、θ2 读数 | R1.2–R1.4 |
| 正运动学 FK | `fk()`，标准 2R 模型 | M1 / 页内独立回代 R1.3 |
| 解析逆运动学 IK | 余弦定理 + atan2，每解 FK 回代验证 | M2 / M7 |
| 肘上 / 肘下切换 | 按钮（aria-pressed）+ 键盘；侧向用 cross 积数值定义 | R3 / M2.3–M2.4 |
| 不可达状态 | 红色标记 + 徽标文案 + 真实残差线；**不截断目标伪造解** | R2.2 / R5.4–R5.5 / M3.1–M3.2 |
| 关节角 / 目标 / 实际末端 / 残差 | 读数面板全部显示，残差小时用科学计数 | R1.4 / R2.2 |
| 工作空间边界 | 外圆 rMax 虚线 + 内圆 rMin（rMin=0 时不画） | R4.1 / R4.4 / M3.5–M3.6 |
| 手机 / 桌面适配 | 900px 单列、390px 无溢出、触控目标 ≥40px | R7 / ui-refresh / performance-accessibility 回归 |

入口：顶部导航「实验」→ `#/lab/robot-2r`（可深链、可前进后退）。`kmMount` / `relatedApply` 按既有正则只作用于内容页，演示页**不进入**知识库浏览记录与学习统计口径。

## 3. 数学正确性（详见 ROBOT_KINEMATICS_MATH.md）

- 坐标系：基座原点，x 右 y 上，逆时针为正；θ1 绝对角、θ2 相对角；内部弧度、显示度；SVG 层显式 y 翻转。
- 工作空间：|L1−L2| ≤ r ≤ L1+L2；等长退化为圆盘。
- 奇异：完全伸直（θ2=0）与完全折叠（|θ2|=π）两分支重合，UI 黄色徽标标注；等长杆原点解不唯一，给出确定解并明示。
- 数值保护：acos 夹取**仅**发生在容差带内可达判定之后，`clamped` 显式暴露；容差带外不可达直接无解。
- 容差：可达性 1e-9×(L1+L2)，回代验证 1e-7×(L1+L2)，全部相对缩放（1e-6~1e6 杆长验证通过）。
- 连续性：固定分支非奇异区连续；圆周 720 步相邻位移 <0.02×scale；径向 400 步肘上 θ2 单调；±π 割线只是表示跳变。
- **正确性判据全部为数值断言**（残差 / 角度 / cross 侧向 / 单调性 / 页内独立 FK 回代），不凭图形位置判断。

实测误差：

| 指标 | 实测 | 阈值 |
| --- | --- | --- |
| 400 随机目标×双分支最大回代残差 | 9.954e-14 | <2.1e-7 |
| 300 随机目标（含边界）×双分支最大残差 | 9.099e-14 | <2.1e-8 |
| 浏览器拖动 / 触摸 / 离线残差 | 7.1e-15 ~ 1.8e-14 | <1e-6×scale |

## 4. 测试结果

### 4.1 新增专项（本地实跑）

| 套件 | 类型 | 项数 | 结果 | 耗时 |
| --- | --- | --- | --- | --- |
| `robot-math` | jsdom（纯 Node） | 50 | **PASS 50 / FAIL 0** | 0.2s |
| `robot-kinematics` | browser（chromium 主验收 + firefox/webkit） | 44 | **PASS 44 / FAIL 0** | 34.0s |
| `sw-snapshot-unit`（未注册专项） | node-vm | 15 | **PASS 15 / FAIL 0** | <1s |

浏览器专项覆盖：数值一致性、拖动（可达/不可达/恢复）、双分支、杆长与目标非法输入、边界与奇异状态、连续拖动 25 步、390px 触摸布局、深色主题、键盘与无障碍（role/tabindex/aria-label/live region/标签）、离线重载、脚本 404 降级、快速路由 5 连切、firefox/webkit 390px 代表场景。

过程中修正的两个测试实现问题（非业务缺陷）：
1. Playwright `fill` 不能向 `input[type=number]` 键入非数字文本（浏览器净化为空串）→ 非法输入用例改为 JS 赋值 + change 事件模拟真实净化路径；
2. 脚本失败降级用例必须在**首次进入路由前**拦截，否则已加载全局走缓存路径 → 改为独立上下文先拦截再导航。

### 4.2 受影响回归（本地实跑，未改任何既有断言）

`python scripts/run_tests.py --only robot-math robot-kinematics audit test7 test9 test18 ui-refresh performance-accessibility browser sw-consistency sw-upgrade personalized-home home-experience knowledge-center`

**PASS 14 / FAIL 0 / SKIP 0 / BLOCKED 0，总耗时 596.0s**（明细见 `tests/reports/b9c1a-affected.md` / `.json`）：

| 套件 | 结果 | 耗时 |
| --- | --- | --- |
| audit | PASS | 65.7s |
| test7 | PASS | 21.8s |
| test9 | PASS | 27.3s |
| test18（18/18） | PASS | 0.6s |
| browser（37/37） | PASS | 54.5s |
| sw-consistency（37/37） | PASS | 100.9s |
| sw-upgrade（25/25） | PASS | 40.8s |
| ui-refresh（59/59） | PASS | 54.1s |
| performance-accessibility（59/59） | PASS | 64.3s |
| knowledge-center | PASS | 58.5s |
| personalized-home | PASS | 21.1s |
| home-experience | PASS | 41.7s |
| robot-math（50/50） | PASS | 0.2s |
| robot-kinematics（44/44） | PASS | 34.0s |

完整默认 **77 套**串行回归交 PR CI 执行，本地未跑全量（任务书约定）。

## 5. 发布契约与离线

- `CACHE_VERSION` 2026-11-23-2 → **2026-11-23-3**；`sw-snapshot-unit` U0/U0b 验证格式与递增、首屏清单仍 7 项。
- 两个演示脚本加入 `OPTIONAL_ASSETS`：activate / 每次导航时 `warmOptionalAssets` 预热，**首次离线访问演示页也可用**（R10.2 实测：离线重载后渲染、拖动、IK 残差 1.4e-14）。
- 未改 SW 导航决策、快照一致性、缓存策略与生命周期；`sw-consistency` / `sw-upgrade` / `browser` 三套回归全绿。
- 脚本加载失败（404）→ 既有 `renderLoadError` 降级（重试入口），首页不受影响（R11）。

## 6. 三引擎

| 引擎 | 结果 |
| --- | --- |
| Chromium 157（channel=chrome，主验收） | 44/44 通过（含视口/主题/键盘/触摸/离线/快速路由） |
| Firefox（playwright 内置） | 390px 渲染/拖动/分支切换正常，FK 回代 Δ=0，无溢出无异常 |
| WebKit（playwright 内置） | 同上 |

## 7. 剩余限制

1. 首版仅平面 2R：无动力学、无关节限位、无碰撞检测、**不扩展六轴仿真**（任务书范围）。
2. 等长杆原点目标位形不唯一；奇异点逆解不连续为模型固有性质，UI 只标注不做奇异回避规划。
3. 容差带（1e-9×scale）内贴边目标按可达处理并如实显示残差与 clamped 标记（数值容差语义，非截断伪造）。
4. 演示状态不持久化，刷新回默认；不写 localStorage / IndexedDB。
5. UI 杆长范围 10–300 为显示合理性约束；数学模块本身无此限制。
6. 导航新增「实验」后共 11 项：1440/1024 单行无换行已由 ui-refresh 回归验证；更窄桌面档（769–900）沿用既有紧凑样式，未单独加断言。
7. Token / 积分计量平台未向 Agent 暴露，无法读取（见 §8）。

## 8. 平台耗时 / Token / 积分

| 项 | 值 | 说明 |
| --- | --- | --- |
| 墙钟时间 | 约 30 分钟（2026-11-23 17:44:55 开始，18:12 完成本地验证与文档，随后提交/PR） | 含基线核验、实现、两轮浏览器专项与 596s 受影响回归 |
| 本地测试耗时 | 数学 0.2s + 浏览器专项 34.0s（runner 记录；首轮含调试约 3 分钟）+ 受影响回归 596.0s + sw-unit <1s ≈ 11 分钟 | `tests/reports/b9c1a-affected.md` 有逐套件明细 |
| Token | **未知** | 平台未向 Agent 暴露本次会话 token 计量，无法读取，不提供估算 |
| 积分 | **未知** | 计费/积分由平台侧统计，Agent 不可见 |
| 模型 | 任务书指定 Qwen 4 Max | 未做模型对比实验；底层模型标识 Agent 侧不可见，以平台路由为准 |

## 9. 提交与 PR

- 分支：`feat/batch9c1a-robot-kinematics`（基于 `2ca2258`）
- 提交：`8d48831` `feat: Batch 9C-1A add 2R robot kinematics interactive demo`（12 文件，+2385/−4；代码 + 测试 + 三份交付物）；PR 链接补记提交见 git log
- PR：**https://github.com/EricZhao666/blog/pull/35**（base = `main`，经浏览器创建，仓库环境无 gh CLI）
- **不自动合并、不部署**；完整 77 套回归由 PR CI 验证（创建时 CI 已触发，结果待验收）。
- 完成后停止，不进入 PID / OEE 模块。

## 10. 最终状态

**B9C1A_PR_READY** — 2R 运动学演示（数学模块 + SVG UI + 站点入口 + SW 发布契约）齐备；
数学专项 50/50、浏览器专项 44/44、SW 快照专项 15/15、受影响回归 14/14 全部通过；
PR #35 已创建（https://github.com/EricZhao666/blog/pull/35），等待 CI 与人工审核，不合并、不部署。