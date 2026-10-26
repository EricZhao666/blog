# 机械臂抓取技术：从解析法到学习方法

抓取是机械臂最基础也最难的技能之一。让机器人稳定地抓起一个物体，涉及到感知、规划、控制多个环节。

## 抓取问题的本质

给定一个物体，找到一组**抓取位姿**（夹爪相对于物体的位姿），使得：

1. **力闭合**（Force Closure）：夹爪能抵抗任意方向的外力
2. **形闭合**（Form Closure）：几何约束让物体无法移动
3. **不碰撞**：夹爪不和环境发生碰撞
4. **可到达**：机械臂能运动到该位姿

## 1. 经典解析法

### 力闭合分析

给定夹爪接触点，计算是否能抵抗任意外力旋量。

```python
import numpy as np

def is_force_closure(contact_points, normals, friction_coeff):
    """判断抓取是否满足力闭合"""
    # 构建抓取矩阵 G
    G = build_grasp_matrix(contact_points, normals)
    
    # 摩擦锥线性化（近似为多面体锥）
    cones = friction_cone_approx(normals, friction_coeff, num_edges=8)
    
    # 检查 G 的像空间是否覆盖整个力旋量空间 R^6
    # 线性规划求解：是否存在非负接触力使合力为零
    return check_force_closure_lp(G, cones)
```

**优点**：有理论保证，数学严密
**缺点**：需要物体几何模型，计算复杂，无法处理未知物体

### GraspIt! / SynGrasp

经典工具箱，可以搜索抓取位姿空间：

1. 输入物体 3D 模型
2. 采样可能的抓取位姿
3. 用力闭合分析筛选
4. 按质量指标排序

## 2. 基于检测的方法

不需要精确的物体模型，直接从传感器数据预测抓取。

### Dex-Net 系列

核心思路：在仿真中大规模生成抓取数据，训练深度网络预测抓取成功率。

```
输入：深度图 + 候选抓取位姿
输出：抓取成功率 (0~1)
```

**GQ-CNN**（Grasp Quality CNN）：

```python
class GQCNN(nn.Module):
    def forward(self, depth_image, grasp_pose):
        # 1. 从深度图裁剪抓取区域
        crop = crop_depth(depth_image, grasp_pose)
        
        # 2. 编码
        features = self.encoder(crop)
        
        # 3. 预测成功率
        quality = self.head(features)
        return quality  # 0~1
```

部署时在候选抓取空间中搜索，选成功率最高的执行。

## 3. 端到端学习

直接从图像到抓取动作，不需要显式的抓取位姿采样。

### QT-Opt (Google)

```
输入：摄像头图像 + 机器人状态
输出：连续动作（末端位姿增量）
训练：Q-learning + 大规模离线数据
```

在真实机器人上训练了 580k 次抓取，成功率 96%。

### Grasp Diffusion Policy

最新的扩散模型方法，将抓取建模为去噪过程：

```python
# 扩散策略：从噪声中"生成"抓取动作
def grasp_diffusion(model, image, instruction):
    # 从纯噪声开始
    action = torch.randn_like(target_action)
    
    # 迭代去噪
    for t in reversed(range(T)):
        noise_pred = model(action, image, instruction, t)
        action = remove_noise(action, noise_pred, t)
    
    return action  # 最终的抓取动作
```

优势：可以建模多模态动作分布（同一个物体可能有多种有效抓取方式）。

## 4. 触觉增强

纯视觉抓取在遮挡和透明物体上会失败。加入触觉传感器：

| 传感器类型 | 原理 | 适用场景 |
|-----------|------|---------|
| 电阻式 | 压阻变化 | 简单力检测 |
| 电容式 | 电容变化 | 高分辨率压力分布 |
| 光学式 | 内部成像 | 形变+滑移检测 |
| 磁性式 | 磁场变化 | 柔性触觉 |

```python
def tactile_guided_grasp(vision_grasp, tactile_sensor):
    """视觉引导粗定位 + 触觉微调"""
    # 1. 视觉给出初始抓取位姿
    robot.move_to(vision_grasp)
    
    # 2. 接触后切换为触觉控制
    while not stable_grasp(tactile_sensor):
        pressure = tactile_sensor.read()
        if is_slipping(pressure):
            increase_gripper_force()
        if uneven_contact(pressure):
            adjust_wrist_pose(pressure)
    
    robot.close_gripper()
```

## 工业场景的实用建议

1. **结构化场景用解析法**：已知物体CAD模型，离线规划最优抓取
2. **半结构化场景用检测法**：深度学习预测+力控微调
3. **非结构化场景用端到端**：但务必加安全兜底
4. **透明/反光物体**：必须加触觉，纯视觉不够

## 总结

抓取技术的发展趋势：从"精确建模→搜索最优"到"数据驱动→学习泛化"。但在工业场景，精度和可靠性仍然是底线，学习方法+传统控制+触觉反馈的融合，才是落地的正确姿势。