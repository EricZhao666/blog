# 机械臂轨迹规划简述：从多项式到优化方法

机械臂的运动控制中，轨迹规划是核心环节。好的轨迹不仅要"到达目标"，还要平滑、高效、不碰撞。

## 基本概念

**路径（Path）**：空间中的几何曲线，只关心"经过哪些点"。
**轨迹（Trajectory）**：路径 + 时间律，关心"什么时候在什么位置"。

```
路径:  q(s),  s ∈ [0, 1]      ← 纯几何
轨迹:  q(t),  t ∈ [t0, tf]    ← 几何 + 时间
```

## 1. 多项式插值

最简单的轨迹规划方法。给定起点和终点（及可选的中间点），用多项式拟合。

### 三次多项式（Cubic）

约束：起止位置 + 起止速度 = 4个条件 → 三次多项式

```python
import numpy as np

def cubic_trajectory(q0, qf, v0, vf, T):
    """三次多项式轨迹"""
    t = np.linspace(0, T, 100)
    a0 = q0
    a1 = v0
    a2 = (3*(qf-q0) - (2*v0+vf)*T) / T**2
    a3 = (2*(q0-qf) + (v0+vf)*T) / T**3

    q = a0 + a1*t + a2*t**2 + a3*t**3
    qd = a1 + 2*a2*t + 3*a3*t**2      # 速度
    qdd = 2*a2 + 6*a3*t               # 加速度
    return q, qd, qdd
```

### 五次多项式（Quintic）

约束：起止位置 + 速度 + 加速度 = 6个条件 → 五次多项式

比三次多项式多了加速度连续的约束，**更适合需要平滑加减速的场景**。

## 2. B样条轨迹

B样条的优势：

- **局部可控性**：移动一个控制点只影响局部轨迹
- **凸包性**：轨迹被限制在控制点的凸包内
- **可微分性**：n次B样条有n-1阶连续导数

```python
from scipy.interpolate import BSpline

# 通过控制点生成平滑轨迹
control_points = np.array([[0, 0], [1, 2], [3, 1], [4, 3], [5, 0]])
tck, u = splprep(control_points.T, s=0, k=3)  # k=3: 三次B样条
```

## 3. 最优控制方法（CHOP / TOPP）

**Time-Optimal Path Parameterization (TOPP)** 是工业界广泛使用的方法：

核心思想：在满足速度、加速度约束的前提下，**沿给定路径以最短时间运动**。

```
minimize  T (总时间)
subject to:
  |q'(s)| ≤ v_max    (速度约束)
  |q''(s)| ≤ a_max   (加速度约束)
  碰撞约束
  关节限位约束
```

## 4. 优化方法（现代方法）

基于数值优化的轨迹规划，可以同时处理多种约束：

```python
# 伪代码：基于优化的轨迹规划
problem = TrajectoryOptimization(
    cost = sum((q_ref - q)^2) + lambda * sum(qdd^2),  # 跟踪误差 + 平滑性
    constraints = [
        joint_limits,        # 关节限位
        velocity_limits,     # 速度限制
        collision_free,      # 无碰撞
        boundary_conditions  # 起止条件
    ]
)
trajectory = problem.solve()
```

常见框架：
- **CasADi**：通用优化求解
- **TrajOpt**：凸优化的轨迹规划
- **CHOMP**：协变哈密顿优化
- **STOMP**：随机轨迹优化

## 实践选择指南

| 场景 | 推荐方法 | 原因 |
|------|---------|------|
| 简单点到点运动 | 三次/五次多项式 | 简单可靠 |
| 多中间点路径 | B样条 | 平滑且局部可控 |
| 高速 pick&place | TOPP | 时间最优 |
| 避障规划 | 优化方法 | 可加入碰撞约束 |
| 在线重规划 | STOMP | 不需要梯度 |

## 总结

轨迹规划没有银弹。理解每种方法的适用场景，根据实际需求选择（或组合使用），才是工程上的正确做法。