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
