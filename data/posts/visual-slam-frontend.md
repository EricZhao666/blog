# 视觉SLAM前端：特征提取与匹配

视觉SLAM的前端负责逐帧处理——"这一帧相对于上一帧移动了多少？"。这是整个SLAM系统的基础，前端不稳，后端再强也白搭。

## 前端的任务

```
输入: 连续的图像帧
输出: 相机位姿变化（R, t）+ 特征点对应的3D位置

步骤: 
  1. 特征提取 —— 找到图像中的关键点
  2. 特征描述 —— 给每个关键点一个"指纹"
  3. 特征匹配 —— 找到两帧之间的对应点
  4. 运动估计 —— 从对应点计算相机运动
```

## 1. 特征提取

### 什么是好特征

好的特征点应该具备：
- **可重复性**：不同图像中同一个点都能被检测到
- **可区分性**：不同点的描述子差异大
- **高效性**：计算速度快

### ORB特征（最常用）

ORB = Oriented FAST + Rotated BRIEF

```python
import cv2

# ORB特征提取
orb = cv2.ORB_create(nfeatures=2000)

# 检测关键点 + 计算描述子
kp1, des1 = orb.detectAndCompute(img1, None)
kp2, des2 = orb.detectAndCompute(img2, None)

# 特征点坐标
points1 = np.array([kp.pt for kp in kp1])  # [N, 2]
```

FAST 检测速度快但没方向，ORB加了方向估计；BRIEF 描述子快但没旋转不变性，ORB加了旋转。

**ORB 的优势**：速度快（实时）、有旋转不变性、有尺度不变性（金字塔）、专利免费。

### SIFT / SURF

```python
sift = cv2.SIFT_create()
kp, des = sift.detectAndCompute(img, None)
```

精度更高但计算量大。SIFT 专利已过期，现在可以自由使用。

### 特征提取对比

| 特征 | 速度 | 精度 | 旋转不变 | 尺度不变 | 专利 |
|------|------|------|---------|---------|------|
| ORB | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ✓ | ✓ | 免费 |
| SIFT | ⭐⭐ | ⭐⭐⭐⭐⭐ | ✓ | ✓ | 已过期 |
| SURF | ⭐⭐⭐ | ⭐⭐⭐⭐ | ✓ | ✓ | 有 |
| BRISK | ⭐⭐⭐⭐ | ⭐⭐⭐ | ✓ | ✓ | 免费 |

## 2. 特征匹配

### 暴力匹配

```python
# FLANN匹配器（近似最近邻，比暴力匹配快）
flann = cv2.FlannBasedMatcher(
    dict(algorithm=6, table_number=6, key_size=12, multi_probe_level=1),  # LSH for ORB
    dict(checks=50)
)

matches = flann.knnMatch(des1, des2, k=2)

# Lowe's ratio test：过滤不好的匹配
good_matches = []
for m, n in matches:
    if m.distance < 0.7 * n.distance:  # 比率阈值
        good_matches.append(m)

print(f"匹配: {len(good_matches)}/{len(matches)}")
```

### 深度学习匹配：SuperPoint + SuperGlue

```python
# SuperPoint: 学习型特征检测+描述
class SuperPoint:
    def __init__(self):
        self.net = load_pretrained()
    
    def detect_and_describe(self, img):
        # 共享 backbone
        features = self.net.backbone(img)
        
        # 检测头：关键点概率图
        scores = self.net.detector_head(features)
        keypoints = nms(scores > 0.7)  # 非极大值抑制
        
        # 描述头：每个像素的描述子
        descriptors = self.net.descriptor_head(features)
        descs = sample_descriptors(descriptors, keypoints)
        
        return keypoints, descs

# SuperGlue: 图神经网络匹配
class SuperGlue:
    def __init__(self):
        self.gnn = AttentionGNN()
    
    def match(self, kp1, des1, kp2, des2):
        # 1. 位置编码（关键点坐标+描述子）
        emb1 = self.encode(kp1, des1)
        emb2 = self.encode(kp2, des2)
        
        # 2. 交替自注意力 + 交叉注意力
        for layer in self.gnn.layers:
            emb1, emb2 = layer(emb1, emb2)
        
        # 3. 匹配概率矩阵（Sinkhorn最优传输）
        scores = emb1 @ emb2.T
        match_prob = sinkhorn(torch.softmax(scores, dim=-1))
        
        return mutual_nearest_neighbor(match_prob)
```

SuperGlue 的核心创新是用**图神经网络 + 注意力机制**做匹配，比传统暴力匹配鲁棒得多——能处理大视角变化和遮挡。

### 匹配方法对比

| 方法 | 速度 | 鲁棒性 | 大视角变化 | 需要 GPU |
|------|------|--------|-----------|---------|
| FLANN | ⭐⭐⭐⭐ | ⭐⭐ | 差 | 否 |
| BF | ⭐⭐ | ⭐⭐ | 差 | 否 |
| SuperGlue | ⭐⭐ | ⭐⭐⭐⭐⭐ | 好 | 是 |
| LightGlue | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 好 | 是 |

## 3. 运动估计

有了匹配点对，怎么算相机运动？取决于传感器配置。

### 2D-2D：对极几何（单目）

```python
# 从像素对应点恢复相机运动
E, mask = cv2.findEssentialMat(
    points1, points2, 
    camera_matrix=K,
    method=cv2.RANSAC,
    prob=0.999,
    threshold=1.0
)

# 分解本质矩阵 → R, t
_, R, t, mask = cv2.recoverPose(E, points1, points2, K)
```

**本质矩阵 E** 编码了两个视角之间的相对位姿。从 E 分解出 R, t 有4个解，需要三角化验证选正确的。

### 3D-2D：PnP（已知3D点）

```python
# 如果上一帧的3D点已知，用PnP求当前位姿
retval, rvec, tvec, inliers = cv2.solvePnPRansac(
    object_points_3d,  # 3D点（上一帧三角化的）
    image_points_2d,   # 当前帧的2D投影
    K, None
)
R, _ = cv2.Rodrigues(rvec)
```

PnP 比 2D-2D 更稳定——3D-2D约束比纯2D约束信息量更大。

### 3D-3D：ICP（已知两组3D点）

```python
def icp(source_3d, target_3d):
    """点到点ICP"""
    # 1. 计算质心
    centroid_s = np.mean(source_3d, axis=0)
    centroid_t = np.mean(target_3d, axis=0)
    
    # 2. 去质心
    s = source_3d - centroid_s
    t = target_3d - centroid_t
    
    # 3. SVD求旋转
    H = s.T @ t
    U, S, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    
    # 4. 求平移
    t = centroid_t - R @ centroid_s
    
    return R, t
```

### RANSAC：异常值剔除

```python
def ransac_pose(points1, points2, K, n_iters=1000, threshold=2.0):
    """RANSAC估计位姿"""
    best_inliers = 0
    best_R, best_t = None, None
    
    for _ in range(n_iters):
        # 1. 随机采样最小点集（5点 for 2D-2D, 4点 for PnP）
        idx = np.random.choice(len(points1), 5, replace=False)
        
        # 2. 求解位姿
        E, _ = cv2.findEssentialMat(
            points1[idx], points2[idx], K
        )
        _, R, t = cv2.recoverPose(E, points1, points2, K)
        
        # 3. 计算内点数
        inliers = count_inliers(points1, points2, K, R, t, threshold)
        
        if inliers > best_inliers:
            best_inliers = inliers
            best_R, best_t = R, t
    
    return best_R, best_t, best_inliers
```

RANSAC 是SLAM前端的标配——没有它，一个错误匹配就会搞崩运动估计。

## 三角化：恢复3D点

```python
def triangulate(P1, P2, pts1, pts2):
    """三角化：从两个视角的2D点恢复3D点"""
    points_3d = []
    for p1, p2 in zip(pts1, pts2):
        # 线性三角化: Ax=0
        A = np.array([
            p1[0] * P1[2] - P1[0],
            p1[1] * P1[2] - P1[1],
            p2[0] * P2[2] - P2[0],
            p2[1] * P2[2] - P2[1]
        ])
        _, _, Vt = np.linalg.svd(A)
        X = Vt[-1, :3] / Vt[-1, 3]  # 齐次→非齐次
        points_3d.append(X)
    return np.array(points_3d)
```

## 关键帧选择

不是每帧都要做SLAM——选择信息量大的"关键帧"。

```python
def need_new_keyframe(current_frame, last_keyframe):
    """判断是否需要插入新关键帧"""
    # 1. 距离上次关键帧的运动量
    R, t = relative_pose(current_frame, last_keyframe)
    translation = np.linalg.norm(t)
    rotation = np.arccos((np.trace(R) - 1) / 2)
    
    # 2. 特征点跟踪率下降
    tracking_ratio = current_frame.matched / last_keyframe.features
    
    # 3. 插入条件
    if translation > 0.1 or rotation > 0.2 or tracking_ratio < 0.7:
        return True
    return False
```

## ORB-SLAM 前端流程

```
新帧到达
  → ORB特征提取（金字塔各层）
  → 与上一帧的BoW匹配（恒速运动模型预测搜索区域）
  → 2D-2D或3D-2D位姿估计（RANSAC + PnP）
  → 三角化新3D点
  → 局部地图跟踪（匹配局部地图点）
  → 判断是否插入关键帧
```

## 实际问题与解法

| 问题 | 原因 | 解法 |
|------|------|------|
| 跟踪丢失 | 快速运动/模糊/遮挡 | IMU预积分辅助、重定位 |
| 纹理缺失 | 白墙、走廊 | 增加直接法成分、加LiDAR |
| 光照变化 | 日夜/室内外 | 特征归一化、学习型特征 |
| 重复纹理 | 走廊/对称建筑 | 几何验证、IMU辅助 |
| 动态物体 | 人/车 | 几何一致性检查剔除动态点 |

## 总结

视觉SLAM前端的演进方向：从手工特征（ORB/SIFT）到学习特征（SuperPoint），从暴力匹配到图神经网络匹配（SuperGlue）。但在工程实践中，ORB + FLANN 仍然是性价比最高的选择——简单、快速、不需要GPU。学习型方法在极端条件下更鲁棒，但部署成本也更高。