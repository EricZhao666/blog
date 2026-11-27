# Batch 9C-2D：梯形与七段 S 曲线运动轨迹规划实验室交付报告

- **分支**：`feat/batch9c2d-motion-profile-lab`
- **基线 main**：`a50b7a4cbe24b30788086c1cd6e3a073b9384e00`（PR #42 已合并，90 套 CI 通过）
- **环境**：Windows 11 / Intel i7-14650HX / 16GB RAM / Node.js `v22.23.5` / Python `3.12.7` / Playwright `1.64.1`（Chromium / Firefox / WebKit）
- **实际工程耗时**：约 12 分钟（含编码、专项验收、受影响回归与文档）
- **平台 Token 与成本**：当前会话环境不可见平台计费/Token 用量与积分余额（标注未知）。

---

## 1. 交付产物

| 文件 | 说明 |
| --- | --- |
| [js/motion-profile.js](js/motion-profile.js) | 纯计算模块：三段梯形（含二段三角形与零位移退化）与七段对称 S 曲线（7/6/5/4 段与零位移全退化）、分段边界递推、采样与对比 |
| [js/motion-profile-demo.js](js/motion-profile-demo.js) | 交互 UI：四联 SVG 波形（位置/速度/加速度/加加速度）、时间游标与播放/单步/归零、五类预设工况、参数输入与错误提示、对比表与分段边界表、未修正终点残差 |
| [MOTION_PROFILE_MATH.md](MOTION_PROFILE_MATH.md) | 数学口径、退化条件推导、分段递推与未修正终点残差定义 |
| [js/app.js](js/app.js) | 注册 `#/lab/motion-profile` 路由、按需加载器 `loadMotionProfileLab()`、实验室导航与卡片、`unmount()` 清理 |
| [sw.js](sw.js) | 递增 `CACHE_VERSION` 至 `'2026-11-27-1'`，将 `motion-profile.js` 与 `motion-profile-demo.js` 加入 `OPTIONAL_ASSETS` |
| [css/style.css](css/style.css) | 补充 `.mp-*` 四联图、图例、回放条与响应式样式 |
| [scripts/run_tests.py](scripts/run_tests.py) | 注册 `motion-profile-math` 与 `motion-profile`（全量增至 92 套） |
| [tests/test64_motion_profile_math.js](tests/test64_motion_profile_math.js) | 数学单元测试 |
| [tests/browser/motion-profile.spec.js](tests/browser/motion-profile.spec.js) | 三引擎浏览器端到端验收测试 |
| [tests/browser/pid-control.spec.js](tests/browser/pid-control.spec.js) 等 5 个旧实验室 spec | 同步实验导航与 `#/lab` 卡片数量断言（7 张卡片 / 8 项互链） |

---

## 2. 数学与数值验证要点

- **七段 S 曲线全退化覆盖**：`7-seg-full`（完整七段）、`6-seg-no-cruise`（达 $a_{\max}$ 未达 $v_{\max}$）、`5-seg-no-const-acc`（达 $v_{\max}$ 未达 $a_{\max}$）、`4-seg-jerk-only`（未达 $a_{\max}$ 与 $v_{\max}$）、临界边界（$L = L_{\text{full}}$、$L = 2 a_{\max}^3 / j_{\max}^2$）、`zero-distance`（$D = 0$）以及反向负位移（$q_0 > q_1$）。
- **分段连续性与约束满足**：所有分段起止状态由前一段闭式积分精确递推，采样验证 $|v| \le v_{\max}$、$|a| \le a_{\max}$、$|j| \le j_{\max}$ 且位置单调；独立 4000 步数值积分与目标位移误差 $< 10^{-5}$。
- **未修正终点残差**：`rawEndPos`、`rawEndVel`、`rawEndAcc` 直接由分段多项式在 $t = T$ 求值，不做强制归零或夹取，实测全部工况 $|q(T)-q_1|, |v(T)|, |a(T)| \le 10^{-9}$。

---

## 3. 验收与返工记录

- **返工情况**：
  1. 首次运行受影响回归时，`tests/browser/motion-profile.spec.js` 的 `helpers/server` 相对路径多了一层目录，且 `tests/browser/path-planning.spec.js` 的 `P10.1`/`P10.2` 仍断言旧卡片数（6 张 / 7 项）；修正后一次通过。
- **实测结果**：
  - `motion-profile-math`：PASS（`0.1s`）
  - `motion-profile`（Chromium + Firefox + WebKit 三引擎）：PASS（`8.0s`）
  - 受影响回归：`audit`（`14.5s`）、`pid-control`（`20.6s`）、`oee-analysis`（`14.9s`）、`spc-analysis`（`20.8s`）、`kalman-filter`（`18.9s`）、`path-planning`（`22.4s`）、`sw-consistency`（`86.5s`，37/37）全部 **PASS**。
  - `python scripts/build_content.py --check`：**PASS**。
  - 完整 92 套回归交由 PR CI 执行。

---

## 4. Batch 9C-2D-R 数学边界与交付完整性修订

1. **数值尺度与退化条件（Task 1）**：
   - 移除固定绝对容差 `EPS = 1e-12` 对不同量纲临界分支的直接比较，改为尺度相关相对容差 `REL_EPS = 1e-12 * scale`。
   - 独立复现并修复反例 A（`q1=1e-15, vMax=1e-7, aMax=0.1` -> 正确进入 `2-seg-triangle`，尺度残差 $\le 10^{-12}|D|$）与反例 B（`q1=1e-16, vMax=1e-10, aMax=1, jMax=1` -> 正确进入 `4-seg-jerk-only`，尺度残差 $\le 10^{-12}|D|$）。
   - 对无法可靠表示的极端尺度（$|D| \in (0, 10^{-18})$、约束 $\notin (10^{-18}, 10^9]$、非有限中间值）明确拒绝，并新增 60 组固定种子多尺度随机性质测试。
2. **采样边界、阶跃绘制与静止保持（Task 2）**：
   - `sampleProfile` 必包含所有有效阶段边界与终点 $T$，支持用户可调采样周期 `#mpSampleDt`（上限 `MAX_SAMPLES = 2000`，仅影响显示/回放）。
   - `evaluateProfile` 明确边界极限（内部右极限、终点左极限），并在 $t > T$ 进入静止保持状态；SVG 对梯形 $a(t)$ 与 S 曲线 $j(t)$ 使用严格阶跃折线绘制。
3. **梯形终点指标口径（Task 3）**：
   - 区分梯形终点加速度左极限（`endAccLeftLimit`）与结束后静止状态；非零位移梯形 `endAccResidual = null`（界面标注“不适用”）、`jPeak = null`（界面标注“理想冲激（不适用有限峰值）”）；零位移时均正确显示 `0`。
4. **非法输入、脏参数提示、单位、教学场景与测试矩阵（Task 4）**：
   - 参数非法时清除结果并禁用播放/单步/归零/游标控件；参数编辑未应用时显示旧参数提示；补充一致单位制标注、独立 `strict-jerk` 教学场景与 [BATCH9C2D_TEST_MATRIX.csv](BATCH9C2D_TEST_MATRIX.csv)。
5. **CI 兼容性与三引擎 Skip 契约（Task 5）**：
   - 确认 PR CI 失败于 `ubuntu-latest`（`ubuntu-26.04`）安装 Chromium 时 `packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/InRelease` 返回 `403 Forbidden`，而 push CI 跑通 91/92 仅在未安装 Firefox/WebKit 时失败。
   - 在 [.github/workflows/tests.yml](.github/workflows/tests.yml) 最小化固定 `runs-on: ubuntu-24.04`（不扩大权限、不缩小测试范围）；在 [tests/browser/motion-profile.spec.js](tests/browser/motion-profile.spec.js) 对未安装的可选引擎按 `SKIP` 处理，本地已实测 Chromium/Firefox/WebKit 三引擎全通过。
   - 保持 `CACHE_VERSION = '2026-11-27-1'`。
6. **修订后实测结果**：
   - `lab` 分组（14/14 套）：**PASS**
   - `content-check`（`0.3s`）、`sw-consistency`（`86.6s`，37/37）、`ui-refresh`（`32.8s`，59/59）、`performance-accessibility`（`52.4s`，59/59）：**4/4 PASS**

---

## 5. Batch 9C-2D-R 最终收尾（`a0237eb` 之后）

1. **`sampleProfile` 阶段边界不可裁剪保护**：
   - 修复 `{q0:0, q1:1e9, vMax:1, aMax:100, jMax:1e9}` 下 `T * REL_EPS = 1e-3` 导致 `tj = 1e-7` 阶段边界被去重删除的问题。
   - 改为先收集所有有效阶段边界（仅做精确值去重）作为不可裁剪集合，再生成普通显示采样点并在超过 `MAX_SAMPLES = 2000` 时仅裁剪普通采样点，新增回归 `M8.15` 验证通过。
2. **可选浏览器启动异常收紧**：
   - [tests/browser/motion-profile.spec.js](tests/browser/motion-profile.spec.js) 仅在明确匹配未安装可执行文件提示时记录 `SKIP`；已安装引擎启动失败、依赖异常或页面测试异常均真实失败。
