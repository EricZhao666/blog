# 机械臂力控与柔顺控制：从阻抗控制到导纳控制

纯位置控制在接触任务中会"硬碰硬"——力控与柔顺控制让机械臂学会"温柔"。

## 为什么需要力控

想象机械臂执行"擦玻璃"任务：

- **纯位置控制**：规划一条贴着玻璃的轨迹。但如果玻璃有微小倾斜，机械臂要么压碎玻璃，要么根本没接触上。
- **力控**：保持一个恒定的接触力，机械臂自动适应玻璃的倾斜和曲率。

在工业场景中，以下任务**必须**用力控：

- 研磨/抛光（恒定接触力）
- 装配（轴孔配合）
- 柔性材料处理
- 人机协作（安全力限制）

## 阻抗控制（Impedance Control）

核心思想：让机械臂表现为一个**质量-阻尼-弹簧系统**。

```
M * ẍ + B * ẋ + K * x = F_ext
```

其中 M、B、K 是你设定的虚拟质量、阻尼和刚度，F_ext 是外部力。

```python
class ImpedanceController:
    def __init__(self, M, B, K):
        self.M = M  # 虚拟质量 (对角矩阵)
        self.B = B  # 阻尼系数
        self.K = K  # 刚度系数
        self.x = 0  # 当前偏差
        self.v = 0  # 速度
        
    def compute(self, x_desired, F_ext, dt):
        """计算控制力矩"""
        # 误差
        error = x_desired - self.x
        
        # 阻抗动力学: M*ẍ + B*ẋ + K*e = F_ext
        a = (F_ext + self.K @ error - self.B @ self.v) / self.M
        
        # 积分更新
        self.v += a * dt
        self.x += self.v * dt
        
        # 输出期望力矩（送给底层力矩控制器）
        tau = self.K @ error + self.B @ self.v
        return tau
```

**关键特点**：
- 不需要精确的环境模型
- 通过调 M/B/K 可以改变"柔软程度"
- K 大 → 刚性跟踪位置；K 小 → 柔顺跟随外力

### 参数调试经验

| 参数 | 大 | 小 |
|------|---|---|
| K (刚度) | 位置跟踪好，但接触力大 | 柔顺，但位置偏差大 |
| B (阻尼) | 稳定但迟钝 | 响应快但可能振荡 |
| M (惯量) | 响应慢 | 响应快但对噪声敏感 |

实用调参顺序：**先调 K 满足位置精度 → 再调 B 消除振荡 → 最后调 M 优化响应速度**。

## 导纳控制（Admittance Control）

阻抗控制需要底层支持力矩控制。如果机械臂只接受位置指令（大多数工业机器人），就要用**导纳控制**。

思路：测量外部力 → 通过虚拟动力学计算位置偏移 → 输出修正后的位置指令。

```python
class AdmittanceController:
    def __init__(self, M, B, K):
        self.M = M
        self.B = B
        self.K = K
        self.x_offset = 0  # 位置偏移
        self.v_offset = 0  # 偏移速度
        
    def compute(self, x_desired, F_ext, dt):
        """输入期望位置和外力，输出修正后的位置"""
        # 虚拟动力学
        a = (F_ext - self.B * self.v_offset - self.K * self.x_offset) / self.M
        self.v_offset += a * dt
        self.x_offset += self.v_offset * dt
        
        # 修正后的目标位置
        x_actual = x_desired + self.x_offset
        return x_actual
```

**导纳控制 = 力传感器 + 位置修正**，对机械臂要求低，工业上用得最多。

## 混合力/位控制

某些任务需要：某些方向控位置，某些方向控力。

经典案例——**轴孔装配**：

```
Z轴（插入方向）→ 力控：保持恒定下压力
XY平面（对中方向）→ 位置控：沿螺旋搜索
绕Z旋转 → 力控：检测卡阻
```

```python
def hybrid_force_position_control(F_ext, x_desired, S):
    """
    S: 选择矩阵 (6x6对角)
    S[i][i] = 1 → 该方向位置控制
    S[i][i] = 0 → 该方向力控制
    """
    # 位置控制方向
    tau_position = S @ position_controller(x_desired)
    
    # 力控制方向
    F_desired = np.array([0, 0, -10, 0, 0, 0])  # Z方向 -10N
    tau_force = (1 - S) @ force_controller(F_desired, F_ext)
    
    return tau_position + tau_force
```

## 被动柔顺 vs 主动柔顺

| 类型 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 被动柔顺 | 机械弹性元件（如 RCC） | 简单、快速、便宜 | 不可调、单一行为 |
| 主动柔顺 | 力传感器+控制算法 | 可编程、灵活 | 复杂、有延迟 |

**最佳实践**：被动+主动混合。用 RCC 处理高频扰动，用主动力控处理低频调整。

## 实际部署建议

1. **力传感器安装位置**：越靠近末端执行器越好，但要考虑碰撞防护
2. **噪声滤波**：力传感器噪声大，一阶低通滤波通常够用
3. **安全限幅**：无论算法输出什么力矩，都必须硬限幅在安全范围内
4. **从导纳控制开始**：如果你不确定用哪种，先上导纳控制——它对硬件要求最低