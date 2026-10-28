# SLAM技术全景：从滤波到图优化

SLAM（Simultaneous Localization and Mapping）——机器人在未知环境中一边建图一边定位自己的技术。这是自动驾驶、扫地机器人、AGV 的基础能力。

## 问题定义

给定：
- 传感器观测（激光/相机/IMU）
- 控制输入（里程计/速度）

求：
- 机器人轨迹：x_1, x_2, ..., x_n
- 地图：m

```
SLAM = 定位（我在哪？）+ 建图（周围长什么样？）
```

这是一个**鸡生蛋蛋生鸡**的问题：定位需要地图，建图需要定位。

## SLAM 的传感器分类

| 传感器 | 类型 | 优势 | 劣势 |
|--------|------|------|------|
| 激光雷达 (LiDAR) | 主动 | 精度高、不受光照影响 | 贵、结构化场景退化 |
| 单目相机 | 被动 | 便宜、信息丰富 | 尺度不确定 |
| 双目相机 | 被动 | 有深度 | 受光照影响 |
| RGB-D | 主动 | 直接出深度 | 距离有限、受光照影响 |
| IMU | 惯性 | 高频、不受环境干扰 | 长期漂移 |
| 轮式里程计 | 惯性 | 便宜 | 打滑、累积误差 |

实际系统通常是**多传感器融合**：相机+IMU（VIO）、LiDAR+IMU（LIO）。

## 第一阶段：基于滤波的SLAM

### 贝叶斯滤波框架

SLAM 本质是一个**状态估计**问题。贝叶斯滤波是其数学基础：

```
预测:  p(x_t | z_{1:t-1}) = ∫ p(x_t | x_{t-1}) p(x_{t-1} | z_{1:t-1}) dx_{t-1}
更新:  p(x_t | z_{1:t}) ∝ p(z_t | x_t) p(x_t | z_{1:t-1})
```

### EKF-SLAM（扩展卡尔曼滤波）

最经典的SLAM算法。用高斯分布近似状态，通过线性化处理非线性问题。

```python
import numpy as np

class EKF_SLAM:
    def __init__(self, n_landmarks):
        # 状态: [x, y, θ, m1x, m1y, ..., mnx, mny]
        self.mu = np.zeros(3 + 2 * n_landmarks)
        self.Sigma = np.eye(3 + 2 * n_landmarks) * 1e6  # 初始不确定度大
        self.n = n_landmarks
    
    def predict(self, u, dt):
        """运动模型预测"""
        x, y, theta = self.mu[:3]
        v, omega = u
        
        # 运动模型
        self.mu[0] += v * np.cos(theta) * dt
        self.mu[1] += v * np.sin(theta) * dt
        self.mu[2] += omega * dt
        
        # 雅可比矩阵
        G = np.eye(len(self.mu))
        G[0, 2] = -v * np.sin(theta) * dt
        G[1, 2] = v * np.cos(theta) * dt
        
        # 运动噪声
        R = np.diag([0.1, 0.1, 0.01])
        
        # 协方差更新
        Gx = G[:, :3]
        self.Sigma = G @ self.Sigma @ G.T
        self.Sigma[:3, :3] += R
    
    def update(self, z, landmark_idx):
        """观测更新"""
        # z = [距离, 角度]
        x, y, theta = self.mu[:3]
        mx, my = self.mu[3 + 2*landmark_idx : 3 + 2*landmark_idx + 2]
        
        # 预测观测
        dx = mx - x
        dy = my - y
        q = dx**2 + dy**2
        z_pred = np.array([np.sqrt(q), np.arctan2(dy, dx) - theta])
        
        # 雅可比
        H = np.zeros((2, len(self.mu)))
        H[0, 0] = -dx / np.sqrt(q)
        H[0, 1] = -dy / np.sqrt(q)
        H[0, 3+2*landmark_idx] = dx / np.sqrt(q)
        H[0, 4+2*landmark_idx] = dy / np.sqrt(q)
        H[1, 0] = dy / q
        H[1, 1] = -dx / q
        H[1, 2] = -1
        H[1, 3+2*landmark_idx] = -dy / q
        H[1, 4+2*landmark_idx] = dx / q
        
        # 卡尔曼增益
        Q = np.diag([0.1, 0.01])  # 观测噪声
        K = self.Sigma @ H.T @ np.linalg.inv(H @ self.Sigma @ H.T + Q)
        
        # 状态更新
        self.mu += K @ (z - z_pred)
        self.Sigma = (np.eye(len(self.mu)) - K @ H) @ self.Sigma
```

**EKF-SLAM 的问题**：
- 状态维度随路标数线性增长 → 计算量 O(n²)
- 高斯线性化假设在高度非线性场景不成立
- 对数据关联错误敏感

### 粒子滤波SLAM（FastSLAM）

用粒子滤波表示位姿分布，每个粒子维护自己的地图。

```python
class FastSLAM:
    def __init__(self, n_particles=100):
        self.particles = [Particle() for _ in range(n_particles)]
    
    def update(self, u, z):
        for p in self.particles:
            # 1. 采样新位姿
            p.pose = motion_model(p.pose, u)
            
            # 2. 更新该粒子的地图（EKF per landmark）
            for obs in z:
                p.update_landmark(obs)
            
            # 3. 计算权重
            p.weight = p.likelihood(z)
        
        # 4. 重采样（避免粒子退化）
        self.resample()
```

FastSLAM 把高维状态分解为"位姿（粒子滤波）+ 地图（EKF）"，计算效率更高。

## 第二阶段：基于图优化的SLAM

现代SLAM的主流方法。把SLAM建模为一个**因子图优化**问题。

### 核心思想

```
SLAM → 构建因子图 → 最大后验估计（MAP）→ 非线性最小二乘
```

节点：机器人位姿 + 路标位置
边：约束（运动约束 + 观测约束 + 闭环约束）

```
minimize  Σ ||r_motion(x_{t-1}, x_t, u_t)||²_{Σ_m}
        + Σ ||r_obs(x_t, m_j, z_t)||²_{Σ_o}
        + Σ ||r_loop(x_i, x_j)||²_{Σ_l}
```

### 前端 + 后端架构

```
传感器数据 → [前端] → 初始位姿估计 + 因子图 → [后端] → 优化后的轨迹和地图
             ↑                                        ↑
          逐帧处理                               全局优化
```

**前端**负责数据关联和初始估计：
- 特征提取与匹配（视觉）或扫描匹配（激光）
- 里程计积分

**后端**负责全局优化：
- 因子图构建
- 非线性最小二乘求解

### g2o / GTSAM / Ceres

主流的图优化框架：

```python
# GTSAM 示例 (Python)
from gtsam import NonlinearFactorGraph, Values, Pose2, BetweenFactorPose2

graph = NonlinearFactorGraph()
initial = Values()

# 添加位姿变量
initial.insert(0, Pose2(0, 0, 0))
initial.insert(1, Pose2(1, 0, 0))

# 添加里程计约束（边）
odom_noise = gtsam.noiseModel.Diagonal.Sigmas(np.array([0.1, 0.1, 0.05]))
graph.add(BetweenFactorPose2(0, 1, Pose2(1, 0, 0), odom_noise))

# 添加闭环约束
graph.add(BetweenFactorPose2(0, 1, Pose2(1.05, 0.02, 0.01), odom_noise))

# 求解
optimizer = gtsam.LevenbergMarquardtOptimizer(graph, initial)
result = optimizer.optimize()
```

### 闭环检测（Loop Closure）

闭环检测是SLAM中**最关键也最容易出问题**的环节。

```
没有闭环:  累积误差一直增大 → 地图漂移
有闭环:    检测到回到去过的地方 → 修正累积误差
```

闭环检测的核心是**位置识别**：
- 激光：扫描匹配 + 距离阈值
- 视觉：词袋模型（Bag of Words）→ DBoW2 / NetVLAD

```python
def loop_closure_detection(current_frame, keyframes, threshold=0.8):
    """基于词袋的闭环检测"""
    scores = []
    for kf in keyframes:
        # 计算视觉相似度
        score = bow_similarity(current_frame.bow, kf.bow)
        scores.append((kf.id, score))
    
    # 取相似度最高且超过阈值的
    scores.sort(key=lambda x: x[1], reverse=True)
    if scores[0][1] > threshold:
        return scores[0][0]  # 返回闭环候选帧
    return None
```

**假阳性闭环**是SLAM的噩梦——一个错误的闭环检测可以让整个地图崩溃。所以必须有几何验证（RANSAC）作为二次确认。

## 第三阶段：学习增强SLAM

传统SLAM的瓶颈在于：前端依赖手工特征，后端是纯几何优化。

### 深度学习在前端

- **特征提取**：SuperPoint / DISK 替代 ORB/SIFT
- **特征匹配**：SuperGlue / LightGlue 替代暴力匹配
- **位置识别**：NetVLAD 替代 DBoW

### 端到端 SLAM

```python
# PoseNet: 直接从图像回归位姿
class PoseNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = models.resnet18(pretrained=True)
        self.backbone.fc = nn.Linear(512, 7)  # 3平移 + 4旋转(四元数)
    
    def forward(self, img):
        return self.backbone(img)
```

端到端方法简洁但泛化能力差，目前还不能替代传统方法。

## SLAM 系统选型

| 系统 | 传感器 | 方法 | 特点 |
|------|--------|------|------|
| ORB-SLAM3 | 单目/双目/RGB-D+IMU | 特征+图优化 | 最成熟的开源VSLAM |
| Cartographer | LiDAR | 子图+图优化 | Google出品，工业级 |
| LIO-SAM | LiDAR+IMU | 紧耦合因子图 | 激光惯导融合标杆 |
| VINS-Fusion | 视觉+IMU | 滑窗优化 | VIO经典 |
| FAST-LIO2 | LiDAR+IMU | 直接法+IEKF | 快速且精度高 |

## 工业场景的SLAM需求

在产线和仓储AGV场景中，SLAM的选型要考虑：

1. **环境特征**：工厂走廊很长、纹理重复 → 视觉SLAM容易丢，LiDAR更稳
2. **动态物体**：产线上有人、叉车、物料 → 需要动态物体过滤
3. **精度要求**：AGV导航一般需要±50mm，精密对接需要±10mm
4. **重定位**：机器人断电重启后要能快速恢复定位

我的经验：**工厂场景优先选 LiDAR+IMU方案（LIO-SAM / FAST-LIO）**，视觉方案在纹理匮乏的工厂环境中不可靠。

## 总结

SLAM 技术从滤波到图优化，从手工特征到深度学习，一直在演进。但核心问题没变——**在不确定性中做最优估计**。理解贝叶斯估计和图优化这两个基础，就能快速上手各种SLAM系统。

## 我的相关实战代码

> 文章里那套 EKF-SLAM 数学，我在 MATLAB 课程作业里手写过一遍可运行的 EKF 融合。完整代码见 [代码库：matlab备份](#/codelib/matlab_backup)。

### 1. 误差卡尔曼滤波（EKF）更新步

`EKF_project_Finish/ekf.m` 维护一个 15 维状态 `[位置, 速度, 欧拉角, 陀螺零偏, 加速度零偏]`，融合 IMU 与位置观测。更新步就是文章里那两行卡尔曼公式的代码版：

```matlab
% 卡尔曼增益
K = P * H' * (H * P * H' + R)^(-1);
% 状态更新
x = x + K * (z - H * x);
% 协方差更新
P = (eye(size(K, 1)) - K * H) * P;
```

**含义**：`H` 把 15 维状态投影到 3 维位置观测；`K` 权衡“模型预测”和“传感器测量”的信任度；`P` 是状态不确定性，每步都被更新。预测步则是 `P = Fx * P * Fx' + Fw * Q * Fw'`（雅可比线性化）。这和文章里 `EKF-SLAM` 的 `predict / update` 完全同构，只是把“路标”换成了“IMU 零偏”。

### 2. IMU 运动模型

同目录 `propagation.m` 负责预测步的状态递推（IMU 积分），两个文件配合就是一套完整的“预测 - 更新”循环。

完整源码 → [代码库：matlab备份](#/codelib/matlab_backup)

