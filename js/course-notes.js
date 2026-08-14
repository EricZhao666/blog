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
  // "香港大学|MECH7010-机器人学": {
  //   summary: "……",
  //   notes: `# MECH7010 机器人学\n\n……`
  // },
};
