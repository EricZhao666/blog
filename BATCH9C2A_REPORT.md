# Batch 9C-2A 报告：SPC 统计过程控制与过程能力分析实验室

- 分支：`feat/batch9c2a-spc-capability-lab`（基于 main `0a30c14`）
- 模型：按任务书 DeepSeek V4.1 Flash（Agent 无法自核平台模型路由，如实记录）
- 范围：新增无后端 SPC 实验 `#/lab/spc-analysis`；不改既有 2R / PID / OEE 数学算法；
  不改内容构建、知识库 schema、推荐权重与知识图谱算法。
- 最终状态：**B9C2A_PR_READY** — 实现、测试、交付物齐备；分支已推送并创建 PR，
  等待 CI 与人工审核，不合并、不部署。

## 1. 基线核验

| 项 | 结果 | 证据 |
| --- | --- | --- |
| PR #38（9B-2）已合并 | ✅ 合并提交 `0a30c14` | `git log --oneline origin/main` |
| 本地 main 同步 | ✅ `08aa7ba → 0a30c14` 快进 | `git pull --ff-only origin main` |
| 默认回归基线 | ✅ full = **84 套** | `python scripts/run_tests.py --list-groups` |
| 线上 Pages 部署 | ✅ 可访问，`sw.js` 实时抓取正常 | `curl https://ericzhao666.github.io/blog/sw.js` |
| 线上 SW 版本 | ✅ `CACHE_VERSION = '2026-11-24-3'` 与 main 一致 | 同上，抓取行 14 |

未重复全站审计；本轮只做与新增实验相关的定向核查。

## 2. 范围与入口

- 新路由 `#/lab/spc-analysis`；`#/lab` 实验列表扩为四卡（2R / PID / OEE / SPC）。
- 四个既有实验的深链接与导航 href **保持不变**（导航「实验」仍指向 `#/lab/robot-2r`）。
- 实验互链由 4 项扩为 5 项（列表 + 四个实验），当前页用 `aria-current="page"` 标注。
- 全部计算在浏览器本地完成：无上传、无后端、无账户、无云存储、无持久化写入
  （不写 localStorage / IndexedDB，不进学习统计与浏览历史）。
- 未连接真实工厂数据库；四个教学示例全部标注为**合成数据**。

## 3. 数学模型与统计口径（摘要，详见 `SPC_CAPABILITY_MATH.md`）

- **I-MR 图**（移动极差长度 2）：
  \(MR_i=|x_i-x_{i-1}|\)，\(\overline{MR}\) 为全部相邻差分均值，
  \(\hat\sigma_{within}=\overline{MR}/1.128\)；
  I 图 \(CL=\bar x\)、\(UCL/LCL=\bar x\pm3\hat\sigma_{within}\)；
  MR 图 \(CL=\overline{MR}\)、\(UCL=3.267\overline{MR}\)、\(LCL=0\)。
- **过程能力**：Cp/Cpu/Cpl/Cpk 用 \(\hat\sigma_{within}\)（短期），
  Pp/Ppk 用样本标准差 \(s\)（整体，n−1）。两者口径不同，不可互换。
- **负值保留**：均值在规格外时 Cpk / Ppk 为负，如实显示并标记 `mean-outside-spec`，不截断为 0。
- **规格无效拒绝**：LSL ≥ USL 或缺失任一边界时，六项指数全部 `null` + `no-spec`。
- **零波动**：\(\hat\sigma_{within}=0\) 时 Cp 族不适用、\(s=0\) 时 Pp 族不适用，
  文案说明「样本未观测到波动」，**不宣称能力无限好**。
- **实测超规比例**：严格 \(x<LSL\) 或 \(x>USL\) 才计数，等于界限算合格；
  与正态拟合 PPM（模型估计）分开显示。
- **独立数值验证**：基础样例（8 值）与四个示例的期望值均由 Python 标准库独立核算后硬编码，
  测试运行时不调用被测算法生成期望。示例①：\(\bar x=10.001\)、\(s=0.013138119\)、
  \(C_p=2.582537835\)、\(C_{pk}=2.556712456\)、\(P_p=2.537146563\)、\(P_{pk}=2.511775097\)。

### 3.1 控制界限与规格界限的区别（页面与文档同时说明）

| | 控制界限 | 规格界限 |
| --- | --- | --- |
| 来源 | 过程自身短期波动（移动极差） | 工程 / 客户要求 |
| 用途 | 判断过程是否稳定（统计信号） | 判断产品是否合格（符合性） |
| 变化 | 随数据重算，或冻结为基线值 | 由规格给定，不随数据变化 |
| 图形 | 点划线 + 主色 + 标签 `UCL/CL/LCL` | 长虚线 + 警告色 + 标签 `USL/LSL` |
| 常见误用 | 用 ±3σ 当公差 | 用规格线代替控制界限判断失控 |

页面图例写明「规格界限（工程要求，不可替代控制界限）」；
稳定不等于合格，合格也不等于稳定（示例②③分别演示这两种情况）。

### 3.2 冻结基线规则

- 取指定 1-based 样本段（含端点，至少 2 个样本）计算基准均值、基准 \(\overline{MR}\)
  与冻结界限；全部样本随后按**固定界限**检测。
- 基线区间在 I/MR 图中以浅色带标出；能力指数改用基线段估计（`basis='baseline'`），
  监测段不参与能力估计，并给出监测段均值相对基线的偏移。
- 支持清除基线（回到全部样本估计）与重新建立；**不删除任何样本**，
  不会因为新增异常而重算界限把异常吸收掉。
- 1 个样本、范围颠倒或越界时拒绝建立，不给出虚假界限。

### 3.3 异常检测定义（四项，明确不是全部 Nelson 规则）

| 规则 | 严格定义 | 边界处理 |
| --- | --- | --- |
| R1 单点超出 3σ 控制界限 | \(x_i>UCL\) 或 \(x_i<LCL\) | 等于界限不算；容差 \(10^{-12}\times\)量级 |
| R2 连续 8 点同侧 | 连续 8 点严格 \(>CL\) 或 \(<CL\) | 等于 CL 的点中断运行 |
| R3 连续 6 点单调 | 严格递增或严格递减 | 出现相等值即中断 |
| R4 MR 超出上控制界限 | \(MR_i>UCL_{MR}\) | MR 非负，不做下侧判定 |

不使用严格 `===` 判断「等于中心线」：均值浮点表示会让 `10.0098` 被判成「小于」，
从而把运行段错误延长；改为相对容差判定，且容差不影响「超出」的严格性。

## 4. 工程实现

| 文件 | 变更 |
| --- | --- |
| `js/spc-calculation.js` | 新增 41.6KB：纯函数计算模块（解析、描述统计、I-MR 界限、四项规则、冻结基线、能力、直方图、正态拟合、四例合成数据） |
| `js/spc-demo.js` | 新增 61.0KB：原生 SVG UI（`renderPage` / `mount` / `getState`），双模式、三图、异常列表、基线冻结；监听器全挂 root 内部，防抖 150ms |
| `js/app.js` | `STATIC_META` 增 `/lab/spc-analysis` 并更新 `/lab` 描述；`loadSpcLab`（缓存 Promise、失败清除）；互链 5 项；实验列表四卡；router 分支（按需加载 + 降级 + token 防串页） |
| `css/style.css` | 追加 `.spc-*` 段 589 行 / +10.1KB：全设计令牌；900px 单列、480 紧凑；触控 ≥40px；`focus-visible`；小屏图表容器内横向滚动 |
| `sw.js` | `CACHE_VERSION` `2026-11-24-3 → 2026-11-25-1`；`OPTIONAL_ASSETS` += 两个 SPC 脚本；REQUIRED 8 / FIRST_SCREEN 7 / 缓存策略不变 |
| `scripts/run_tests.py` | 注册 `spc-math` / `spc-analysis`；lab 组 6→8 套、browser 组 18→19 套；**full = 86 套** |
| `tests/browser/pid-control.spec.js` | 互链断言 4→5 项、实验列表 3→4 卡；390px 触摸先 `scrollIntoViewIfNeeded` 再取坐标（避免新增互链把按钮推出视口后点到旧坐标） |
| `tests/browser/oee-analysis.spec.js` | 同上，互链与实验列表断言更新为含 SPC |
| `index.html` | 零改动（导航 href 不变） |

UI 结构：左侧「状态与口径提示 / 样本统计 / I 图 / MR 图 / 分布 / 能力 / 异常列表」，
右侧「模式单选（radiogroup）/ 数据输入 / 规格与单位 / 冻结基线 / 公式与口径说明」。

## 5. 测试（本地实跑）

### 5.1 新增专项

| 套件 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| `spc-math`（`tests/test61_spc_math.js`） | **92/92 PASS** | 0.2s | 解析与定位、统计与移动极差、I/MR 界限、能力与负值、零波动、四规则边界、冻结基线、顺序影响、四例合成数据、抽样分离、数值稳定、理论模式、直方图、确定性、5000 样本性能 |
| `spc-analysis`（`tests/browser/spc-analysis.spec.js`） | **62/62 PASS** | 27.6s | chrome 158 + firefox/webkit 390px；数值一致、粘贴与校验、示例切换、理论模式、基线冻结、防抖、390/768/1440、深色、键盘无障碍、离线、降级、快速路由 |
| `sw-snapshot-unit`（未注册进 86 套） | 15/15 PASS | <1s | 版本 `2026-11-25-1` 递增合法；首屏仍 7 项 |

### 5.2 受影响回归（串行实跑）

| 批次 | 套件 | 结果 | 耗时 |
| --- | --- | --- | --- |
| lab 组 | robot-math / robot-kinematics / pid-math / pid-control / oee-math / oee-analysis / spc-math / spc-analysis | **8/8 PASS** | 100.9s（spc-analysis 27.6s 最慢） |
| 结构 | audit / test7 | PASS / PASS | 16.3s / 10.2s |
| SW | browser 37/37 · sw-consistency 37/37 · sw-upgrade 25/25 | **3/3 PASS** | 154.9s |
| UI / 无障碍 | ui-refresh 59/59 · performance-accessibility 59/59 | **2/2 PASS** | 92.2s |
| 构建门禁 | `build_content.py --check` · `check_images.py --check` · `gen_feed.py --check` | 均 OK（ERROR 0 / WARNING 0） | <5s |

受影响回归合计：**PASS 15 / FAIL 0 / SKIP 0 / BLOCKED 0**；报告见
`tests/reports/b9c2a-lab-math.md`、`b9c2a-lab-browser.md`、`b9c2a-sw.md`、
`b9c2a-ui-a11y.md`、`b9c2a-lab-group.md`。

完整 86 套默认串行回归交 PR CI，本地未跑全量（按任务书要求）。

### 5.3 测试过程中发现并修复的问题

1. **R2 边界浮点误判**：严格 `===` 判断「等于中心线」导致运行段被错误延长
   （示例④ R2 由 31 点误算为 27 点）。改为相对容差判定，并用 Python 独立实现复核一致。
2. **示例③教学性质不足**：初版漂移幅度 0.10 时 37 个点越界，信号过强；
   调整为 0.04、噪声 0.012 后 3 点越界 + 39 点同侧 + 6 点趋势 + 2 个 MR 越界，
   且 0 超规，更清楚地展示「高 Cpk 不等于过程受控」。
3. **`histogram` / `normalFit` 规格参数健壮性**：直接传 `{lsl,usl}` 时 `spec.ok`
   为 `undefined`，规格线不参与视图范围。新增 `normalizeSpec` 内部校验。
4. **测试等待条件竞态**：`setData` 只等 `error` 非空，会被上一条错误提前满足。
   改为「等本次输入对应的 computeCount 增加」或「等本次错误出现」。
5. **既有 PID 测试 390px 触摸失败**：新增互链使页面更长，按钮移出视口后
   `boundingBox()` 坐标失效；补 `scrollIntoViewIfNeeded`（测试稳健性，不改业务）。

## 6. 性能

| 场景 | 结果 |
| --- | --- |
| 5000 样本完整计算（统计 + 界限 + 四规则 + 能力 + 直方图 + 抽样） | **104.9–123.6ms**（Node 24 / Windows，阈值 500ms） |
| 复杂度 | 中位数排序 \(O(n\log n)\) 主导，其余 \(O(n)\)；无无界循环、无定时器 |
| 输入防抖 | 150ms；一次粘贴 40 个值只触发 1 次计算（R7.1） |
| 图表抽样 | `step=ceil(n/400)`，5000 样本约 386 个常规点；异常点强制绘制 |
| 新增传输体积 | 两脚本 102.6KB（源码未压缩）+ CSS 10.1KB + app.js ≈1.6KB |
| SW 预缓存增量 | 两脚本进入 `OPTIONAL_ASSETS`（随 `warmOptionalAssets` 预热）；首屏必需资源仍 8 项 / 首屏 7 项 |
| 平台成本 | **零新增**：纯静态文件，无后端、无数据库、无函数计算、无第三方图表库 |

## 7. 三引擎与离线

- **Chromium**（chrome 158）：全部 62 项浏览器断言。
- **Firefox / WebKit**：390px 代表性场景（示例④渲染、Cpk 2.206171、超规 3 个、
  页内独立重算偏差 0、无溢出、无运行时异常）均 PASS。
- **离线**：SW 安装后两脚本进入缓存（`caches.match` 命中）；断网重载可渲染、
  可粘贴新数据并独立重算（s=0.2），数值与在线一致。
- **降级**：`spc-demo.js` 或 `spc-calculation.js` 任一 404 → 显示「加载失败 + 重试」，
  不白屏、不抛错，首页 18 篇文章不受影响；恢复后重试可正常加载。

## 8. 样本不足与分布假设限制（页面可见）

1. \(n<2\)：无法估计移动极差，I 图上下界限为 `null`，提示「未建立控制界限」。
2. \(n<10\)：提示界限估计不可靠；\(n<30\)：标记能力指数不确定性（常见实践，非硬标准）。
3. 零波动：明确「样本未观测到波动」，拒绝能力指数，不宣称无限能力。
4. 直方图叠加的正态曲线是**模型假设**（均值=样本均值、σ=样本标准差），
   不做正态性检验；理论 PPM 与实测超规比例分开显示。
5. 只实现四项规则，不声称覆盖全部 Nelson / Western Electric 规则。
6. I-MR 假设相邻观测近似独立，不做自相关修正；明显自相关时 \(\hat\sigma_{within}\) 会偏小。
7. 不替代企业正式 SPC 系统、质量放行或客户验收流程（页脚说明）。

## 9. 理论与实测模式的区分（实现层面）

| 检查点 | 理论参数模式 | 实测数据分析模式 |
| --- | --- | --- |
| 输入控件 | 显示 μ/σ 输入，隐藏数据输入与基线 | 显示数据输入与基线，隐藏 μ/σ |
| 统计卡 | 显示 μ/σ 与规格，标注「不适用（理论参数模式）」 | 显示 n/均值/中位数/s/MR/σ_within/超规 |
| 控制图 | 整段隐藏（不渲染） | I 图 + MR 图 |
| 异常列表 | 固定文案「理论参数模式没有实测样本，不做异常检测」 | 四项规则命中位置 |
| 能力卡 | Cp 族 + 「理论模式不适用」的 Pp/Ppk | Cp 族（σ_within）与 Pp 族（s） |
| 分布图 | 理论正态密度曲线 + 理论 PPM | 实测直方图 + 实测超规比例 + 可选拟合曲线 |
| 计算入口 | `computeTheoretical`（不读取任何样本） | `computeMeasured`（唯一使用样本估计的入口） |

## 10. 实际耗时与平台成本

| 项 | 记录 |
| --- | --- |
| 基线核验与定向阅读 | 约 8 分钟（PR #38、SW 版本、OEE 实验室架构、测试骨架） |
| 实现（数学 + UI + 路由 + 样式 + SW） | 约 12 分钟 |
| 测试编写与 5 处修复 | 约 12 分钟 |
| 定向回归（15 套 + 门禁） | 约 10 分钟（串行；SW 与 UI 套件占 4 分钟） |
| 交付物文档 | 约 10 分钟 |
| 合计 | 约 50 分钟（未触发 45 分钟预算检查点里的"削减测试"分支；测试项数按覆盖要求保留） |
| 平台成本 | 仅本地 CPU 与浏览器内核；无云端资源。CI 侧新增 2 套测试（约 +28s 串行） |

## 11. 交付物清单

- `js/spc-calculation.js`、`js/spc-demo.js`（新增）
- `js/app.js`、`css/style.css`、`sw.js`、`scripts/run_tests.py`（修改）
- `tests/test61_spc_math.js`、`tests/browser/spc-analysis.spec.js`（新增）
- `tests/browser/pid-control.spec.js`、`tests/browser/oee-analysis.spec.js`（互链断言更新）
- `SPC_CAPABILITY_MATH.md`、`BATCH9C2A_TEST_MATRIX.csv`、本报告

## 12. 状态

**B9C2A_PR_READY**：实现与测试完成，分支已推送，PR 待审核；未合并、未部署，
未进入 9C-2B。
