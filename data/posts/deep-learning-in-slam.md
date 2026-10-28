# 深度学习在SLAM中的应用

传统SLAM是纯几何方法——特征提取靠手工算子，优化靠非线性最小二乘。深度学习能帮上什么忙？

## 深度学习在SLAM中的角色

```
传统SLAM:  传感器 → [手工前端] → [几何后端] → 轨迹+地图
深度SLAM:  传感器 → [学习前端] → [几何后端] → 轨迹+地图
                    ↑ 替换部分模块

端到端SLAM: 传感器 → [神经网络] → 轨迹+地图
             ↑ 全部用神经网络替代
```

实践证明：**用深度学习替换SLAM的特定模块（前端）效果最好**，端到端方案目前还不够成熟。

## 应用一：深度特征提取

### SuperPoint

用自监督学习训练的特征检测器。

```python
class SuperPoint(nn.Module):
    """SuperPoint: 共享backbone + 两个头"""
    def __init__(self):
        super().__init__()
        # 共享特征提取（VGG-style）
        self.encoder = VGGEncoder()  # 输出: [B, 128, H/8, W/8]
        
        # 检测头：每个像素是否为关键点
        self.detector = nn.Conv2d(128, 65, 1)  # 65 = 8x8 + 1(无关键点)
        
        # 描述头：每个像素256维描述子
        self.descriptor = nn.Conv2d(128, 256, 1)
    
    def forward(self, img):
        feat = self.encoder(img)
        scores = torch.softmax(self.detector(feat), dim=1)
        descs = F.normalize(self.descriptor(feat), dim=1)
        return scores, descs
```

**训练方法**：
1. 先在合成数据（几何形状）上训练检测器
2. 再用同形变换（Homographic Adaptation）在真实图像上自监督训练
3. 描述子用对比学习训练

### vs ORB

| 指标 | ORB | SuperPoint |
|------|-----|-----------|
| 速度 | 10ms | 30ms (GPU) |
| 重复性 | 中 | 高 |
| 纹理稀缺场景 | 差 | 好 |
| 需要 GPU | 否 | 是 |
| 可解释性 | 高 | 低 |

## 应用二：深度特征匹配

### SuperGlue

```python
class SuperGlue(nn.Module):
    """图神经网络匹配"""
    def __init__(self, n_layers=9):
        super().__init__()
        self.keypoint_encoder = MLP(2 + 1 + 256, 256)  # 坐标+分数+描述子
        self.gnn = nn.ModuleList([
            AttentionLayer(256) for _ in range(n_layers)
        ])
        self.final_proj = nn.Linear(256, 256)
    
    def forward(self, kp1, desc1, kp2, desc2):
        # 1. 编码关键点（位置+描述子融合）
        emb1 = self.keypoint_encoder(cat(kp1, desc1))
        emb2 = self.keypoint_encoder(cat(kp2, desc2))
        
        # 2. 交替Self-Attention和Cross-Attention
        for layer in self.gnn:
            emb1, emb2 = layer(emb1, emb2)
        
        # 3. 计算匹配分数矩阵
        scores = self.final_proj(emb1) @ self.final_proj(emb2).T
        
        # 4. Sinkhorn算法（最优传输，考虑一一匹配约束）
        scores = sinkhorn_algorithm(scores)
        
        return scores  # [N1, N2] 匹配概率
```

SuperGlue 的关键洞察：**匹配不是一个独立的决策，而是全局优化问题**——一个点的匹配会影响其他点的匹配。注意力机制正好能建模这种全局依赖。

### LightGlue（2023）

SuperGlue 的改进版，核心改进是**自适应计算量**：

```python
class LightGlue(nn.Module):
    def forward(self, kp1, desc1, kp2, desc2):
        emb1, emb2 = self.encode(kp1, desc1), self.encode(kp2, desc2)
        
        for i, layer in enumerate(self.layers):
            emb1, emb2 = layer(emb1, emb2)
            
            # 早停：如果已经高置信度匹配，提前退出
            if self.confidence(emb1, emb2) > threshold:
                # 只跑前i层就够了
                return self.match(emb1, emb2)
        
        return self.match(emb1, emb2)
```

容易匹配的图像对少跑几层，困难的图像对多跑几层——动态分配计算资源。

## 应用三：深度位姿估计

### 直接回归位姿

```python
class PoseNet(nn.Module):
    """从单张图像直接回归相机位姿"""
    def __init__(self):
        super().__init__()
        self.backbone = ResNet18(pretrained=True)
        self.pose_head = nn.Linear(512, 7)  # 3平移 + 4旋转(四元数)
    
    def forward(self, img):
        feat = self.backbone(img)
        pose = self.pose_head(feat)
        
        # 分离平移和旋转
        t = pose[:, :3]
        q = F.normalize(pose[:, 3:], dim=-1)  # 四元数归一化
        
        return t, q
```

**问题**：泛化能力差，在新环境中完全不可用。只能在训练环境内工作。

### 相对位姿估计（更实用）

```python
class RelPoseNet(nn.Module):
    """估计两帧之间的相对位姿"""
    def forward(self, img1, img2):
        feat1 = self.backbone(img1)
        feat2 = self.backbone(img2)
        
        # 融合两帧特征
        fused = torch.cat([feat1, feat2, feat1 * feat2], dim=1)
        
        # 回归相对位姿
        R = self.rotation_head(fused)   # 旋转
        t = self.translation_head(fused)  # 平移方向（无尺度）
        
        return R, t
```

## 应用四：深度深度估计

### Monodepth2：单目深度估计

```python
class Monodepth2(nn.Module):
    """自监督单目深度估计"""
    def __init__(self):
        self.depth_encoder = ResNet18()
        self.depth_decoder = DepthDecoder()
        
        # 额外的位姿网络（用于自监督训练）
        self.pose_encoder = ResNet18()
        self.pose_decoder = PoseDecoder()
    
    def forward(self, img1, img2):
        # 预测深度
        depth1 = self.depth_decoder(self.depth_encoder(img1))
        
        # 预测位姿
        pose = self.pose_decoder(self.pose_encoder(cat(img1, img2)))
        
        # 自监督损失：用预测的深度和位姿重建img2
        img2_recon = warp(img1, depth1, pose, intrinsics)
        loss = photometric_loss(img2, img2_recon) + smoothness_loss(depth1)
        
        return depth1, loss
```

单目深度估计**没有绝对尺度**——这是单目SLAM的固有缺陷。要获得真实尺度需要双目、RGB-D或IMU。

## 应用五：语义SLAM

把语义信息（物体类别）融入SLAM，实现语义建图。

```python
class SemanticSLAM:
    def __init__(self):
        self.slam = ORBSLAM3()
        self.detector = YOLOv8()  # 目标检测
        self.semantic_map = {}
    
    def process_frame(self, img):
        # 1. 传统SLAM定位
        pose = self.slam.track(img)
        if pose is None:
            return
        
        # 2. 语义检测
        detections = self.detector(img)
        
        # 3. 把检测结果投到3D地图
        for det in detections:
            # 检测框对应的3D点
            mask = box_to_mask(det.bbox)
            points_3d = self.slam.get_map_points_in_region(mask)
            
            if points_3d is not None:
                # 更新语义地图
                obj_id = det.class_id
                if obj_id not in self.semantic_map:
                    self.semantic_map[obj_id] = []
                self.semantic_map[obj_id].append({
                    'pose': pose,
                    'points': points_3d,
                    'bbox': det.bbox
                })
```

语义SLAM的价值：
- **数据关联更鲁棒**：用语义信息辅助闭环检测
- **动态物体剔除**：识别行人/车辆，排除其干扰
- **高级地图**：不只是点云，还有"桌子""椅子""门"

## 应用六：学习型闭环检测

```python
class NetVLAD(nn.Module):
    """基于深度学习的全局描述子，用于位置识别"""
    def __init__(self, num_clusters=64, dim=512):
        super().__init__()
        self.backbone = ResNet18()
        self.clusters = nn.Parameter(torch.randn(num_clusters, dim))
        self.fc = nn.Linear(dim * num_clusters, 4096)
    
    def forward(self, img):
        # 1. 提取局部特征
        feat = self.backbone(img)  # [B, C, H, W]
        feat = feat.flatten(2).transpose(1, 2)  # [B, HW, C]
        
        # 2. 计算软分配到各聚类
        soft_assign = torch.softmax(feat @ self.clusters.T, dim=-1)  # [B, HW, K]
        
        # 3. VLAD聚合
        residual = feat.unsqueeze(2) - self.clusters  # [B, HW, K, C]
        vlad = (soft_assign.unsqueeze(-1) * residual).sum(1)  # [B, K, C]
        vlad = F.normalize(vlad.flatten(1), dim=-1)  # [B, K*C]
        
        # 4. 降维
        return F.normalize(self.fc(vlad), dim=-1)  # [B, 4096]
```

NetVLAD 用可学习的聚类替代手工词袋（DBoW），在光照变化和视角变化下更鲁棒。

## 端到端SLAM：DROID-SLAM

```python
class DROIDSLAM:
    """端到端视觉SLAM"""
    def __init__(self):
        self.corr_fn = CorrBlock()  # 学习型相关性
        self.update_net = GRUUpdate()  # GRU更新
        
    def track(self, frames):
        # 1. 初始化
        poses = [identity()]
        depths = [predict_depth(frames[0])]
        
        for i in range(1, len(frames)):
            # 2. 构建相关性体（学习型匹配）
            corr = self.corr_fn(frames[i-1], frames[i])
            
            # 3. GRU迭代更新位姿和深度
            for _ in range(n_iters):
                delta_pose, delta_depth = self.update_net(corr, poses[i], depths[i])
                poses[i] = update_pose(poses[i], delta_pose)
                depths[i] = update_depth(depths[i], delta_depth)
        
        # 4. 全局优化
        poses = self.global_optimize(poses, depths, frames)
        
        return poses, depths
```

DROID-SLAM 在多个benchmark上超越传统方法，但：
- 计算量大（需要GPU）
- 泛化到训练集外场景有退化
- 难以调试和解释

## 落地现状与建议

| 模块 | 传统方法 | 深度学习 | 建议 |
|------|---------|---------|------|
| 特征提取 | ORB/SIFT | SuperPoint | 纹理差用SuperPoint |
| 特征匹配 | FLANN/BF | SuperGlue | 大视角变化用SuperGlue |
| 深度估计 | 双目/RGB-D | Monodepth | 没有深度传感器时用 |
| 闭环检测 | DBoW2 | NetVLAD | 光照变化大用NetVLAD |
| 位姿估计 | PnP+RANSAC | 端到端回归 | 老老实实用PnP |
| 后端优化 | g2o/GTSAM | - | 还没有深度学习的优势 |

**实用建议**：不要追求"全深度学习SLAM"。传统SLAM + 选择性地在某些环节用深度学习增强，是当前最务实的方案。

## 总结

深度学习在SLAM中的最大价值不是替代几何方法，而是**解决几何方法的短板**——纹理缺乏、大视角变化、光照变化、语义理解。理解传统方法的瓶颈在哪，再有针对性地用深度学习去补，才是正确的工程思路。