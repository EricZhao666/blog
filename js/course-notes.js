/**
 * Course Notes (Markdown)
 * --------------------------------------------------------------
 * 每门课的笔记，按 courses.js 里的 course.id 索引。
 * 与 courses.js 刻意分离：scan_courses.py 重新扫描生成 courses.js 时，
 * 不会覆盖这里的手写笔记。
 *
 * 用法：给某门课加一条记录即可，notes 字段是标准 Markdown。
 *   COURSE_NOTES["<course.id>"] = {
 *     summary: "一句话简介（可选）",
 *     notes:   "Markdown 正文……"
 *   }
 */

const COURSE_NOTES = {
  // ===== 样板课：机器人与自动化 (CS422) =====
  // 这是结构示范骨架。把你的真实课堂要点发给我，我替换正文即可。
  "本科课程|机器人与自动化-(CS422)": {
    summary: "机器人学基础：从坐标变换、正/逆运动学到速度运动学（雅可比）与轨迹/路径规划，建立描述与控制机器人运动的数学方法。",
    notes: `# 机器人与自动化 (CS422) 核心笔记

> 内容据课程 8 份课件（CS422_1, cs422-2, CS422-3~8, CS422-7-2）整理。课程由 Maynooth University（Dr. Charles Markham / Dr. John McDonald / Siyuan Zhan 博士）讲授，教材 *Introduction to Robotics: Analysis, Systems, Applications* (Saeed B. Niku)。

## 0. 课程概览
- **目标**：建立描述和控制机器人系统运动的数学方法（"它/它在哪、怎么动、怎么稳、怎么走"）。
- **结构**：机器人导论 → 简单机械与自由度（Gruebler）→ 空间描述与变换 → 正/逆运动学（DH 矩阵）→ 速度运动学（雅可比）→ 轨迹与路径规划 → ROS / 传感器与执行器 / 移动机器人（后续模块）。
- **考核**（以课件为准）：CA 25%（4 次作业 20% + 测验 5%）+ 考试 75%（2 小时，10 题做 8）。

## 1. 机器人定义与组成
- 经典定义（Robot Institute of America, 1979）：*可重复编程、多功能的机械手，通过编程运动搬运物料/工具以完成多种任务*。
- 典型解剖：**机械臂(Manipulator) + 末端执行器(End effector) + 执行器(Actuators) + 传感器(Sensors) + 控制器(Controller) + 处理器(Processor) + 软件(Software)**。
- 关键特性指标：**Payload（负载）**、**Reach（可达距离）**、**Precision（绝对精度）**、**Repeatability（重复定位精度）**、**Workspace（工作空间）**。
- 参考坐标系：World / Joint / Tool 三种参考系决定了运动指令的解释方式。

## 2. 简单机械与自由度（Number Synthesis）
- **机构(mechanism)**：由刚体(links)经关节(joints/pairs)连接，用于传输/约束相对运动；**机器(machine)** 由基本机构组成。
- **关节类型**：R(旋转, DOF=1)、P(移动, DOF=1)、S(球副, DOF=3)、C(圆柱, DOF=3)、H(螺旋, DOF=1)、E(平面, DOF=3)。
- **Gruebler / Kutzbach 公式**（自由度/活动度 M）：
  - 通式：3D 为 \`M = 6(N-1) - Σ(6-fi)\`，2D 为 \`M = 3(N-1) - Σ(3-fi)\`（\`N\`=含机架的杆数，\`fi\`=第 i 个关节的自由度数）。
  - 平面低副（R/P，fi=1）特例：\`M = 3(N-1) - 2G\`（G 为低副数）。
  - **Kutzbach 准则**：要完全控制一个机构，输入运动数必须等于机构自由度。
  - **过约束机构(overconstrained)**：公式给出 M≤0 却仍能运动（如 Sarrus、Bennett 机构）——公式失效的典型案例。

## 3. 空间描述与变换（Spatial Descriptions & Transformations）
- **位置/姿态描述**：点用位置向量 \`p\`，姿态用旋转矩阵 \`R\`（3×3 正交阵，\`RᵀR=I, det R=1\`）。
- **旋转矩阵三大用途**：① 坐标变换（同一点在两坐标系下的坐标）② 表示坐标系姿态 ③ 作为算子旋转向量。
- 基本旋转矩阵（绕 x/y/z）：
  \`\`\`text
  Rx(θ) = [1   0      0   ]
          [0  cosθ  -sinθ ]
          [0  sinθ   cosθ ]
  Ry(θ), Rz(θ) 同理（循环置换）
  \`\`\`
- **复合旋转**：绕"当前坐标系"用右乘 \`R20 = R10·R21\`；绕"固定坐标系"用左乘 \`R20 = R·R10\`。
- **欧拉角 / Roll-Pitch-Yaw**：用 3 个角参数化任意姿态（DOF=3）。
- **齐次变换(Homogeneous Transform)**：把旋转+平移统一为 4×4 矩阵，是本课贯穿始终的核心工具：
  \`\`\`text
  H = [ R   d ]      P0 = H10 · P1
      [ 0   1 ]
  复合：H20 = H10 · H21
  \`\`\`

## 4. 正运动学（Forward Kinematics）
- 给定关节变量 \`q\`（旋转 θ / 移动 d）→ 求末端位姿 \`x\`。
- 用齐次变换链式法则：\`H₀ⁿ = H₀¹ · H₁² · … · Hₙ₋₁ⁿ\`。
- 机器人构型分类（按关节组合）：RRR(铰接)、RRP(球坐标)、RPP(圆柱)、外加 SCARA(RRP+腕)。

## 5. DH 参数与正运动学建模
- **D-H 约定**：用 4 个参数（\`θ, d, a, α\`）表征相邻连杆坐标系，把每个齐次变换拆成 4 个基本变换之积。
- **Standard DH** vs **Modified DH** 的坐标系附着规则不同（z 轴对齐关节、x 轴取公垂线），用时务必选其一并统一。
- 经典案例：平面肘形臂(Planar Elbow)、圆柱/球坐标腕、Stanford 机械臂、SCARA、Puma 560。

## 6. 逆运动学（Inverse Kinematics）
- 给定末端位姿 \`(R, o)\` → 求关节变量。一般难解；**6 DOF 且后 3 关节交于一点**时可解耦。
- **解耦法(decoupling)**：先求腕心(wrist centre) \`o_c = o - d₆·R·[0,0,1]ᵀ\`（即位置逆解），再用 \`R = R₀³·R₃⁶\` 求姿态逆解。
- **几何法**：多数简单机构直接在平面投影上几何求解；闭式解未必存在，且常有多解（左臂/右臂构型）。

## 7. 速度运动学（Velocity Kinematics / Jacobian）
- 末端速度与关节速度的微分关系：\`ẋ = J(q)·q̇\`，\`J\` 为**雅可比矩阵**。
- 雅可比分块：**线性速度雅可比**（移动副取 z 轴方向，旋转副取 \`zᵢ₋₁×r\`）与**角速度雅可比**。
- **奇异位形(Singularities)**：\`det J = 0\`，此时末端丧失某些方向的运动能力——腕奇异、肘奇异、SCARA 奇异等。轨迹规划需避开。

## 8. 轨迹与路径规划（Path & Trajectory Planning）
- **构型(configuration) \`q\`** 与 **构型空间 C-space \`Q\`**：二维平面刚体 \`q=(x,y,θ)\`；Puma \`q=(θ₁…θ₆)\`。
- **碰撞约束**：\`Q_free = Q \ Q_obstacle\`，路径需在自由空间内。
- **人工势场法(Artificial Potential Field)**：
  \`\`\`text
  U(q) = U_att(q) + U_rep(q)
  F(q) = -∇U(q) = -∇U_att - ∇U_rep
  \`\`\`
  目标吸引 + 障碍排斥，沿负梯度搜索（易陷局部极小）。
- **多项式法**（如三次多项式）用于平滑插值关节轨迹，满足起点/终点位置与速度边界。

## 9. 复盘要点
1. **齐次变换 H** 是贯穿全课的数学主线（位姿、正运动学、速度、变换算术都靠它）。
2. **DH 参数** 是把任意开链机械臂写成可计算正运动学模型的标准化手段，Standard/Modified 别混用。
3. 逆运动学优先用**解耦 + 几何法**求闭式解；数值法（雅可比伪逆）用于无闭式或冗余臂。
4. 工程中务必注意**奇异点、冗余自由度、左/右臂多解**——仿真（如 MATLAB Robotics Toolbox、ROS）先验证再上实物。
`
  },

  // ===== 在这里继续添加其他课程，例如： =====
  "香港大学|MECH7010-机器人学": {
    summary: "香港大学 MECH7010 当代机器人学（张富 + 陈永华）：移动机器人（建模 / 状态估计 / 控制）与软体机器人两条主线，覆盖 SO(3) 姿态、EKF、RRT*、四旋翼级联控制与气动执行器。",
    notes: `# MECH7010 当代机器人学 (Contemporary Robotics) 核心笔记

> 内容据 2023 学期课件（Intro / Robotic system / Modeling / Estimation / Control / Soft Robotics 系列）与 EKF 大作业说明整理。课程由香港大学机械工程系 **张富（Fu ZHANG）** 教授（移动机器人部分）与 **陈永华（Yonghua CHEN）** 教授（软体机器人部分）共同讲授。

## 0. 课程概览
- **两条主线**：① 移动机器人（张富）——建模 Modeling / 状态估计 Estimation / 控制 Control 的闭环；② 软体机器人（陈永华）——从刚体到软体的演化、软体执行器与刚度调制。
- **成绩**：个人大作业 30%（状态估计 MATLAB 编程，reading week 前后发布，严禁抄袭）+ 期末考试 70%（4 题选做，2 小时）。
- **参考教材**：Thrun et al. *Probabilistic Robotics*；Murray *A Mathematical Introduction to Robotic Manipulation*；Corke *Robotics, Vision and Control*；Lynch & Park *Modern Robotics*（课件内容与其高度吻合）。
- **特点**：数学 + MATLAB 编程并重；涉及 SLAM / 视觉惯性导航等前沿。

## 1. 机器人系统模型（Robotic System）
- **定义**：Robot = 自动或遥控操作的机器；Robotics = 研究机器人的科学技术。
- **通用模型**：执行器(Actuator) → 机构(Mechanism) → 传感器(Sensing) → 测量 → 回到状态。
- **两个互相纠缠的问题**：**估计 Estimation**（知道机器人在哪）+ **控制 Control**（驱动机器人到达目标）。建模是连接二者的桥梁（给定输入，预测机器人如何响应）。
- **跨学科**：控制、估计、计算机视觉、传感器、机电、软件工程等高度集成。

## 2. 建模 Modeling（张富）
### 2.1 刚体运动与坐标变换
- **刚体**：任意两点距离不随时间改变。
- **坐标系**：World frame（惯性，NED：北-东-下）+ Body frame（固连机体，x 前 / y 右 / z 下 = roll / pitch / yaw 轴）。
- **旋转矩阵 R ∈ SO(3)**：\`SO(3) = { R∈ℝ³ˣ³ | RᵀR=I, det R=1 }\`。
- **坐标变换**：\`v_W = R·v_B\`；\`q_W = R·q_B + p_W\`。
- **Hat/Vee 映射**：\`(a×b) = â·b\`，\`â\` 为反对称阵（skew-symmetric）。
- **姿态运动学**：\`Ṙ = R·(ω_B)^∧\`（\`ω_B\` 为机体角速度）。
- **Rodrigues 公式**：\`e^(âθ) = I + sinθ·â + (1−cosθ)·â²\`（绕单位轴 a 转 θ）。
- **矩阵对数**：由 R 反解旋转向量 \`(log R)^∨ = âθ\`，且 \`tr(R) = 1 + 2cosθ\`。

### 2.2 欧拉角与奇异性
- **Z-Y-X 欧拉角**（yaw ψ, pitch θ, roll φ）：\`R = Rz(ψ)·Ry(θ)·Rx(φ)\`。
- **互转**：\`ψ=atan2(r21,r11), θ=asin(−r31), φ=atan2(r32,r33)\`。
- **雅可比**：\`ξ̇ = J(ξ)·ω_B\`，\`J(ξ) = [1, sinφ·tanθ, cosφ·tanθ; 0, cosφ, −sinφ; 0, sinφ/cosθ, cosφ/cosθ]\`。
- **万向锁 Gimbal lock**：\`θ=±π/2\` 时 \`r21=r11=0\`、\`r32=r33=0\`，ψ、φ 不可解（只能确定 ψ−φ）。几何上失去一个自由度。

### 2.3 平面运动建模（三类地面车）
- **Ackermann 转向**：\`ṗx = V·cosθ, ṗy = V·sinθ, θ̇ = ω = V/L·tanφ\`。
- **差速轮**：由左右轮速 \`Ωl, Ωr\` 推出 \`V, ω\`。
- **Mecanum 轮**：\`[vx, vy, ω]ᵀ = H·[Ω1..Ω4]ᵀ\`（全向移动）。

### 2.4 刚体动力学（Newton-Euler）
- 平移：\`m·dv_W/dt = F_W\`；旋转：\`I·ω̇_B + ω_B×(I·ω_B) = τ_B\`。
- **四旋翼实例**：螺旋桨 \`T = c_t·Ω², Q = c_q·Ω² = κT\`；总推力 \`T_t = ΣTi\`，力矩 \`τx = L(T2+T3−T1−T4)\` 等（mixing 矩阵）；结合前向/旋转运动学与力映射得到完整 UAV 模型（可用 R 或欧拉角表达）。

## 3. 状态估计 Estimation（张富）
### 3.1 数学基础
- 高斯向量 \`X ~ N(μ, Σ)\`；**线性变换仍为高斯**；**条件高斯**公式（已知测量 y 时 x 的后验均值/协方差）。

### 3.2 传感器模型
- **编码器**：\`Ω_m = Ω + n_e\`（含打滑噪声）。
- **GNSS**：\`p_m = p + n_p\`（NED 下位置）。
- **IMU（陀螺 + 加速度计 + 磁力计）**：
  - 陀螺：\`ω_m = ω_B + b_g + n_g\`，偏置随机游走 \`ḃ_g = n_bg\`。
  - 加速度计测"比力"：\`a_m = Rᵀ(a_W − g) + b_a + n_a\`，\`ḃ_a = n_ba\`。
  - 磁力计：\`m_m = Rᵀ·m_W + n_m\`。

### 3.3 状态空间与离散化
- 连续：\`ẋ = f(x,u,w), y = h(x)+v\`；离散（欧拉）：\`x_{k+1} = x_k + Δt·f(x_k, u_k, w_k)\`。
- UAV 状态：\`x = [p_W, v_W, ξ, b_a, b_g]ᵀ\`，输入 \`u = [a_m, ω_m]ᵀ\`（由 IMU 驱动，无需 m/I 等动力学参数）。

### 3.4 扩展卡尔曼滤波 EKF
- **预测**：\`x̂_{k+1|k} = f_d(x̂_{k|k}, u_k, 0)\`，\`P_{k+1|k} = F_x·P·F_xᵀ + F_w·Q·F_wᵀ\`。
- **更新**：\`K_k = P·Hᵀ·(H·P·Hᵀ + R)⁻¹\`，\`x̂_{k|k} = x̂_{k|k−1} + K_k·(y_k − h(x̂_{k|k−1}))\`，\`P = (I − K·H)·P\`。
- **核心假设**：对非线性系统做一阶线性化；线性时最优，非线性时次优（大非线性会发散）。替代：UKF（无导数、二阶精度）。
- **机器人中的应用**：GPS/IMU 组合导航、视觉惯性导航（VINS-Mono、MSCKF）、LiDAR SLAM（ORB-SLAM、FAST-LIO2）。

## 4. 控制 Control（张富）
### 4.1 轨迹规划
- **C-space（构型空间）**：把机器人按最大尺寸膨胀为点，障碍转为 C-obstacle，路径在自由空间内。
- **方法**：PRM、RRT 及其变种、**RRT\\***（rewire 到更优父节点，渐近最优）、A* 等。
- **平滑**：路径 → 安全走廊 → 走廊内优化平滑轨迹（注意平滑后可能重新碰撞）。

### 4.2 PID 与级联控制
- **PID**：\`u = Kp·e + Ki·∫e + Kd·ḋe + u_ff\`。P 镇定、I 消除稳态误差、D 抑制超调；前馈 \`u_ff\` 减小跟踪时变轨迹的误差。
- **抗扰**：常值扰动下 P 留稳态误差，加 I 可消除；二阶以上系统需 D 阻尼。
- **纯跟踪 Pure Pursuit**：\`φ = atan2(L·sinα, l_d)\`（\`l_d\` 为预瞄距离）。
- **级联控制 Cascade**：对链式动态（如四旋翼）逐级设计——位置环(P) → 速度环(PID) → 姿态环 → 角速度环(PID)，内外环分离、分别调参。

### 4.3 四旋翼控制架构（经典 4 环）
- 位置/速度控制 → **力反解 Force Inverse**（由期望加速度 \`a_d\` 解算总推力 \`T_t = m·|a_d − g 方向|\` 与期望姿态 \`R_d\`）→ 姿态控制 → 角速度控制 → 混控得 4 个桨的转速。
- **姿态控制：欧拉角 vs SO(3)**：
  - 欧拉角：\`ω_d = J(ξ)⁻¹·Kp(ξ_d − ξ)\`，但路径抖动且在 \`θ=π/2\` 奇异。
  - **SO(3) 几何控制**：姿态误差 \`R_e = RᵀR_d\`，轴角 \`e_R = (log R_e)^∨\`，\`ω_d = Kp·e_R\`，闭环 \`ḋe_R = −Kp·e_R\`——最短路径、无奇异。这是更优方案（Lee et al. SE(3) 几何跟踪）。

## 5. 软体机器人 Soft Robotics（陈永华）
### 5.1 从刚体到软体
- **范式转变**：Machine-centric（工厂、围栏隔离）→ Human-centric（与人协作/可穿戴/体内，强调安全与柔顺）。
- **串联弹性执行器 SEA**（1993 MIT）：在刚性传动中串入弹性元件，把力控制转化为位移控制（\`F = k·ΔX\`），牺牲带宽/刚度换稳定柔顺力控；协作机器人（Baxter、UR）基于此。
- **演化链**：6-DOF 刚性臂 → 超冗余臂（>6 DOF）→ 连续体机器人（无限 DOF、无关节、可任意点弯曲）→ 软连续体（无硬质骨架）。
- **软度定义**：结构柔顺 + 材料柔顺；软体机器人 = 用可控柔顺度构建感知/执行/机体/控制子系统（2010 年 "soft robotics" 一词确立）。

### 5.2 气动人工肌肉 PAMs（McKibben）
- 由橡胶内胆 + 不可伸长的编织网构成，充气收缩；功率重量比高达 **400:1**（远超气缸/电机 ~16:1），工作压力 0–70 psi。
- **静特性**：等压线 \`F\` vs 收缩率 ε（压力为比例因子）；拮抗肌对（agonist/antagonist）实现双向运动，平衡点由两肌压力比决定。
- 优点：轻、强、直接连接、柔顺安全、自阻尼；缺点：单向收缩、效率低、位移小(20–30%)、迟滞大。

### 5.3 软体气动执行器 SPA / PneuNets
- SPA = 弹性腔体 + 约束层（不可伸长的织物/纤维），充气产生各向异性变形；**差分应变 (differential strain)** 实现弯曲。
- **PneuNets**：一系列气室在弹性体内互推产生弯曲；半圆腔最易弯曲。
- **纤维增强**：螺旋纤维约束控制伸长/弯曲；3D 打印或硅橡胶模塑制造。
- **五类软执行器**：① 介电弹性体 DEA（电压驱动，应变 200–300%，需高压）② 形状记忆合金 SMA ③ 形状记忆聚合物 SMP ④ 流体弹性体 FEA（即 SPA）⑤ 电磁 E/MA。

### 5.4 刚度调制 Stiffness Modulation
- 软体低刚度带来环境适应，高刚度用于传力/承载——**可变刚度**是核心需求。
- 调制原理：热刺激、磁/电刺激、几何法、气压刺激等。

## 6. 期末大作业（EKF 状态估计 MATLAB）
- **任务**：用 IMU 数据作输入、位置作测量，实现 EKF 预测/更新，估计无人机 (drone) 位姿。
- **三个目标**：① 欧拉角→旋转矩阵、欧拉角时间导数（J(ξ)）② 基于 UAV 状态方程的 IMU 传播 ③ EKF 预测 + 更新，并解释**奇异数据**的影响。
- **状态**：\`x = [p_W, v_W, ξ, b_a, b_g]ᵀ\`，离散传播 \`x_{k+1} = x_k + Δt·f(x_k, u_k, w_k)\`。
- 提交：完整 MATLAB 工程 + PPT（含代码截图与结果分析），Moodle 提交。

## 7. 参考资源
- 教材：*Probabilistic Robotics* (Thrun), *Modern Robotics* (Lynch & Park), *Robotics Vision and Control* (Corke)。
- SLAM：ORB-SLAM、VINS-Mono、FAST-LIO2（LiDAR 惯性）。
- 软体：*Soft Robotics* 期刊、Soft Robotics Toolkit (softroboticstoolkit.com)。
- 控制：Lee et al. *Geometric tracking control of a quadrotor UAV on SE(3)* (CDC 2010)。
`
  },
};
