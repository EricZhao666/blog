# 机器学习入门：从线性回归到深度学习

机器学习的概念满天飞，但底层逻辑其实很朴素——从数据中学习规律，然后用规律做预测。

## 核心思想

传统编程：你写规则，计算机执行。
机器学习：你给数据，计算机自己找规则。

```
传统编程:  数据 + 规则 → 答案
机器学习:  数据 + 答案 → 规则
```

## 学习范式分类

| 范式 | 训练数据 | 目标 | 典型算法 |
|------|---------|------|---------|
| 监督学习 | (x, y) 标签对 | 学习 x→y 映射 | 线性回归、SVM、CNN |
| 无监督学习 | 只有 x | 发现数据结构 | K-Means、PCA、自编码器 |
| 自监督学习 | x 自造标签 | 学习表征 | MAE、SimCLR、GPT |
| 强化学习 | 状态+奖励序列 | 学习最优策略 | Q-Learning、PPO |

## 从线性回归说起

最小二乘法——最古老的机器学习算法。

```python
import numpy as np

# 生成数据: y = 2x + 1 + noise
X = np.random.randn(100, 1)
y = 2 * X + 1 + 0.1 * np.random.randn(100, 1)

# 闭式解: w = (X^T X)^{-1} X^T y
X_b = np.c_[np.ones((100, 1)), X]  # 加偏置项
w = np.linalg.inv(X_b.T @ X_b) @ X_b.T @ y
print(f"w = {w}")  # ≈ [1, 2]
```

线性回归的三个核心要素，也是所有机器学习的三要素：
1. **模型**（假设空间）：y = wx + b
2. **损失函数**：均方误差 MSE
3. **优化方法**：梯度下降（或闭式解）

## 梯度下降：优化的引擎

```python
def gradient_descent(X, y, lr=0.01, epochs=1000):
    """梯度下降法训练线性回归"""
    w = np.zeros(X.shape[1])
    b = 0
    
    for epoch in range(epochs):
        # 前向传播
        y_pred = X @ w + b
        
        # 计算梯度
        dw = 2 * X.T @ (y_pred - y) / len(y)
        db = 2 * np.mean(y_pred - y)
        
        # 参数更新
        w -= lr * dw
        b -= lr * db
    
    return w, b
```

梯度下降的变体：

| 方法 | 每次用多少数据 | 特点 |
|------|--------------|------|
| BGD | 全部 | 稳定但慢 |
| SGD | 1个 | 快但不稳定 |
| Mini-batch | 32~256 | 实际最常用 |

## 从线性模型到神经网络

线性模型的局限：无法拟合非线性关系。加一个非线性激活函数就行。

```
线性:  y = Wx + b
MLP:   y = W2 * sigmoid(W1 * x + b1) + b2
```

```python
import torch
import torch.nn as nn

class MLP(nn.Module):
    def __init__(self, in_dim, hidden_dim, out_dim):
        super().__init__()
        self.fc1 = nn.Linear(in_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, out_dim)
        self.relu = nn.ReLU()
    
    def forward(self, x):
        x = self.relu(self.fc1(x))
        return self.fc2(x)

# 训练循环
model = MLP(10, 64, 1)
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
criterion = nn.MSELoss()

for epoch in range(100):
    pred = model(X_train)
    loss = criterion(pred, y_train)
    optimizer.zero_grad()
    loss.backward()  # 自动求导
    optimizer.step()
```

**反向传播**本质就是链式法则——从输出层往回逐层计算梯度。PyTorch 的 `autograd` 把这件事自动化了。

## 深度学习的三板斧

### 1. CNN（卷积神经网络）

处理图像的标准武器。核心是卷积核——一个在图像上滑动的小窗口，提取局部特征。

```python
class SimpleCNN(nn.Module):
    def __init__(self, num_classes=10):
        super().__init__()
        self.conv1 = nn.Conv2d(3, 32, 3, padding=1)  # 3通道→32通道
        self.conv2 = nn.Conv2d(32, 64, 3, padding=1)
        self.pool = nn.MaxPool2d(2)
        self.fc = nn.Linear(64 * 8 * 8, num_classes)
    
    def forward(self, x):
        x = self.pool(torch.relu(self.conv1(x)))  # 32x32→16x16
        x = self.pool(torch.relu(self.conv2(x)))  # 16x16→8x8
        x = x.view(x.size(0), -1)
        return self.fc(x)
```

### 2. RNN / Transformer

处理序列数据。RNN 有记忆，但梯度消失严重。Transformer 用注意力机制替代了循环结构，成为了当今大模型的基石。

```python
# 自注意力机制（简化版）
def self_attention(Q, K, V):
    """Q, K, V: [batch, seq_len, dim]"""
    d_k = K.size(-1)
    scores = Q @ K.transpose(-2, -1) / np.sqrt(d_k)  # [batch, seq, seq]
    attn = torch.softmax(scores, dim=-1)
    return attn @ V  # [batch, seq, dim]
```

### 3. 生成模型

GAN（对抗生成）、VAE（变分自编码器）、Diffusion（扩散模型）——从判别到生成的跨越。

## 过拟合与正则化

机器学习最核心的矛盾：**拟合训练数据 vs 泛化到新数据**。

```
欠拟合: 训练误差高，测试误差高 → 模型太简单
刚好:   训练误差低，测试误差低
过拟合: 训练误差低，测试误差高 → 模型太复杂
```

常用正则化手段：

| 方法 | 原理 | 适用场景 |
|------|------|---------|
| L2 正则 | 惩罚大权重 | 通用 |
| Dropout | 随机丢弃神经元 | 深层网络 |
| 数据增强 | 扩充训练数据 | 图像、语音 |
| 早停 | 验证集变差就停 | 所有场景 |
| BatchNorm | 归一化中间层 | 深层网络 |

## 工业场景的 ML 实践建议

1. **从简单模型开始**：线性回归/随机森林能解决 80% 的问题，别一上来就深度学习
2. **数据 > 模型**：花 70% 时间在数据清洗和特征工程上
3. **可解释性**：产线上模型必须可解释——出了问题要知道为什么
4. **在线学习**：产线数据分布会漂移，模型需要持续更新
5. **部署成本**：大模型推理慢，边缘端用蒸馏/量化后的轻量模型

## 学习路径建议

```
入门: 吴恩达 Machine Learning → 手写线性回归/逻辑回归
进阶: 《动手学深度学习》(d2l.ai) → PyTorch 实战
深入: 读论文 (ResNet, Transformer, BERT) → 复现
应用: Kaggle 比赛 → 自己的项目
```

机器学习的核心不是调包，而是理解"数据→特征→模型→评估"这条链路。工具会变，但这条链路不会变。

## 我的相关实战代码

> 这些是我在课程 / 项目中真实写过的机器学习代码：一个轻量图像分类模型，和一个用聚类做魔方颜色识别的 CV 小项目。

### 1. MobileNetV2（轻量图像分类）

`predict/predict/model_v2.py` 实现了 MobileNetV2 的核心——**倒置残差块（Inverted Residual）**，用“逐通道卷积 + 1×1 升维 / 降维”把计算量压到极低，适合边缘部署：

```python
class InvertedResidual(nn.Module):
    def __init__(self, in_channel, out_channel, stride, expand_ratio):
        hidden = in_channel * expand_ratio
        layers = []
        if expand_ratio != 1:
            layers.append(ConvBNReLU(in_channel, hidden, 1))              # 1x1 升维
        layers.append(ConvBNReLU(hidden, hidden, stride, groups=hidden))  # 3x3 逐通道
        layers.append(nn.Conv2d(hidden, out_channel, 1, bias=False))      # 1x1 降维
        self.conv = nn.Sequential(*layers)
    def forward(self, x):
        return x + self.conv(x) if self.use_shortcut else self.conv(x)
```

**含义**：和普通残差块相反，它先“膨胀”通道再做深度可分离卷积，最后“压缩”回去——这正是 MobileNet 能在手机上实时推理的关键，也呼应文章里“边缘端用蒸馏 / 量化后的轻量模型”。

### 2. K-Means 做魔方颜色识别（无监督）

`学习/机器学习/代码/cube_robot/kmeans.py` 用 K-Means 把魔方某个小面的像素聚成 3 类，输出颜色占比直方图，从而判断每个块是什么颜色：

```python
image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).reshape(-1, 3)
clt = KMeans(n_clusters=3); clt.fit(image)
hist, _ = np.histogram(clt.labels_, bins=len(np.unique(clt.labels_)) + 1)
hist = hist.astype("float") / hist.sum()   # 每类颜色占比
```

**含义**：完全没用标签，仅靠“颜色相近的像素聚在一起”就把魔方色块分出来了——这就是文章里“无监督学习：发现数据结构”的活例子。

完整源码 → [代码库：pythoncodeplace](#/codelib/pythoncodeplace) · [代码库：学习](#/codelib/study)

