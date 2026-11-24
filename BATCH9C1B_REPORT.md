# Batch 9C-1B 报告：PID 控制系统交互实验室

- 日期：2026-11-24（Asia/Shanghai）
- 模型：按任务书记录为 **Qwen 4 Max**（执行 Agent 无法自核底层模型标识，如实注明）；本轮不使用 DeepSeek Flash，不做模型对比实验。
- 分支：`feat/batch9c1b-pid-control-lab`（基于 main `5c618b1`）
- 最终状态：**B9C1B_PR_READY**（见 §9）

## 1. 基线核验

| 项 | 结果 | 证据 |
| --- | --- | --- |
| PR #35（9C-1A）已合并 | ✅ squash 合入 main，merge commit `5c618b1` | https://github.com/EricZhao666/blog/pull/35 （Merged，3 checks passed） |
| main CI 最终通过 | ✅ 3 checks passed | 同上 |
| Pages 部署 | ✅ pages-build-deployment #62 completed successfully（Nov 24） | https://github.com/EricZhao666/blog/actions/workflows/pages/pages-build-deployment |
| 线上 SW 与 main 一致 | ✅ 实测 `CACHE_VERSION='2026-11-23-3'` | https://ericzhao666.github.io/blog/sw.js?cb=20261124095600 |

说明：直接抓取线上 `sw.js` 一度返回旧版 `-2`，为 CDN 边缘缓存；加缓存破坏参数实时抓取确认已是 `-3`，与 main 一致。
本地 main 快进到 `5c618b1` 后创建本轮分支。**未修改已有 2R 运动学算法**（`js/robot-kinematics.js` 零改动；`js/robot-demo.js` 零改动）。

## 2. 范围与入口

- 新路由 `#/lab/pid-control`（STATIC_META 已注册标题/描述）；新实验列表 `#/lab`（两张卡片，纯静态）。
- 复用既有「实验」导航：`index.html` 导航项 href 保持 `#/lab/robot-2r` 不变（不破坏现有深链接与既有测试契约）；
  两个演示页顶部增加统一互链（实验列表 / 二连杆运动学 / PID 控制，当前页 aria-current），由 app.js 渲染，不改动演示模块本身。
- 功能：Kp/Ki/Kd 滑杆+数字输入、设定值 r、对象 K/τ、限幅 uMin/uMax、dt/时长选择、P/PI/PID/对比模式、
  积分抗饱和开关、恢复默认、y(t)+设定值±2%带曲线、u(t)+限幅+饱和竖带曲线、上升时间/超调量/调节时间/稳态误差读数、
  参数简洁说明（含「Kd 不保证减小超调、不承诺 PID 优于 PI」的如实结论）。
- 未触碰：知识库 schema、推荐算法、学习统计口径、项目数据；无后端、无控制硬件接口、无大型仿真框架、无新持久化。

## 3. 数学模型与离散化（摘要，详见 PID_CONTROL_MATH.md）

- 对象 G(s)=K/(τs+1)，ZOH 精确离散 y[k+1]=a·y[k]+K(1−a)·u[k]，a=e^(−dt/τ)；恒值 u 下与解析阶跃逐点一致（实测最大误差 1.14e-14）。
- 离散 PID：P=Kp·e；D 对测量值求导 + 一阶低通 τf=5·dt（后向欧拉），避免设定值微分冲击；
  I 条件积分抗饱和（饱和且误差推向饱和方向时冻结）；u 严格限幅。
- 每次重算零状态（t=0，I=D=0）；模式切换不携带状态。非法参数拒绝，步数上限 20000，发散防御截断。
- 指标定义明确：上升 10%→90%（插值）、超调 max(0,峰值归一化−1)、调节 ±2% 带 + 末尾 5% 全在带内、稳态误差末尾 5% 均值；
  未稳定如实显示「未在仿真时间内稳定」，不编造数值。

## 4. 工程实现

- `js/pid-simulation.js`：纯数学模块（IIFE + global.PidSimulation + module.exports，仿 robot-kinematics）。
- `js/pid-demo.js`：原生 SVG 绘图与交互（renderPage/mount/getState）；监听器全部挂 root 内部节点，路由销毁即清理；
  输入防抖 120ms（快速输入不触发无界计算）；绘图抽稀 ≤800 点（指标用全量数据）；饱和竖带合并/桶聚合保证 DOM 有界；
  颜色全走设计令牌，深浅主题自动适配；390px 单列、触控 ≥40px、focus-visible、aria-live 读数播报。
- `js/app.js`：STATIC_META + loadPidLab（缓存 Promise、失败清除可重试，与 loadRobotLab 同契约）+ 路由 token 防串页 +
  renderLabLinks/renderLabHub + 加载失败 renderLoadError 降级。
- 计算正确性判据全部为数值断言：页内独立重算对照 getState、曲线端点反算、解析解对照、精确稳态解。

## 5. 测试（本地实跑）

| 套件 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| pid-math（新增，jsdom） | **52/52 PASS** | 0.2s | 解析对照/零输入/P/PI/PID/饱和/抗饱和/dt 收敛/指标定义/非法输入/确定性/数值保护 |
| pid-control（新增，browser） | **45/45 PASS** | 26.2s | chrome 158 主验收 + firefox/webkit 390px 代表场景；数值一致性/模式/饱和可视化/防抖/离线/降级/三引擎 |
| sw-snapshot-unit（未注册专项） | **15/15 PASS** | <1s | CACHE_VERSION 契约、首屏 7 项、REQUIRED 8 项 |
| 受影响回归（11 套） | **PASS 11 / FAIL 0 / SKIP 0 / BLOCKED 0** | 346.3s | 实验路由/导航/SW/首页/无障碍 |

受影响回归明细（tests/reports/b9c1b-affected.md / .json）：

| 套件 | 结果 | 耗时 |
| --- | --- | --- |
| robot-math | PASS 50/50 | 0.1s |
| robot-kinematics | PASS 44/44 | 21.5s |
| pid-math | PASS 52/52 | 0.2s |
| pid-control | PASS 45/45 | 26.2s |
| ui-refresh | PASS 59/59 | 40.1s |
| sw-consistency | PASS 37/37 | 93.6s |
| sw-upgrade | PASS 25/25 | 30.7s |
| test18 | PASS 18/18 | 0.4s |
| personalized-home | PASS 58/58 | 37.3s |
| home-experience | PASS 41/41 | 30.8s |
| performance-accessibility | PASS 59/59 | 56.8s |

正式套件数 77 → **79**（pid-math、pid-control 已注册，lab 分组与 browser 分组同步更新）。
完整默认回归（79 套）按任务书交 PR CI，本地未跑全量。

## 6. 发布契约

- `CACHE_VERSION`：`2026-11-23-3` → **`2026-11-24-1`**（YYYY-MM-DD-N 递增）。
- `OPTIONAL_ASSETS` += `./js/pid-simulation.js`、`./js/pid-demo.js`（随 warmOptionalAssets 预热，保证首次离线访问可用）。
- `REQUIRED_ASSETS`（8 项）/ `FIRST_SCREEN_ASSETS`（7 项）未变；缓存策略本身未改。
- 离线实测：在线访问后两脚本进入 SW 缓存，离线重载可渲染、可改参数、独立重算一致（R12）。

## 7. 剩余限制

- 仅一阶对象；无二阶/延迟/非线性、无扰动/噪声输入。
- 条件积分抗饱和在极端 Ki·dt 下自第一拍冻结积分（固有特性，已文档化）；未实现 back-calculation。
- τf=5·dt 固定比例不可调；无设定值加权、无手自动无扰切换。
- 一阶对象超调由积分驱动，Kd 不保证减小超调（实测反例已记录）；不承诺 PID 优于 PI。
- 演示状态不持久化；指标基于有限仿真时长，未稳定如实标注。

## 8. 平台计量（如实记录）

| 项 | 值 | 口径 |
| --- | --- | --- |
| 模型 | Qwen 4 Max（按任务书） | Agent 无法自核底层模型标识 |
| 墙钟时间 | 约 40 分钟（2026-11-24 09:54:29 开始，含基线核验/实现/两轮专项修正/回归/文档/PR） | shell 时间戳；结束时刻见 git log |
| Token | 未知 | 平台未向执行环境暴露，不提供估算 |
| 积分 | 未知 | 同上 |
| 预算检查点 | 45 分钟 | 未通过减少数值验证降低验收标准：数学 52 项 + 浏览器 45 项全部保留并实跑 |

## 9. 提交与 PR

- 分支：`feat/batch9c1b-pid-control-lab`（基于 `5c618b1`）
- 提交：见 git log（代码 + 测试 + 三份交付物；PR 链接创建后补记）
- PR：本轮允许 push 与创建 PR（base = `main`）；**不自动合并、不部署**，完整 79 套回归由 PR CI 验证。
- 完成后停止，不进入 OEE 计算器模块。