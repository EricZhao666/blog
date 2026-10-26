# Sim-to-Real Gap：具身智能落地的最后一公里

仿真环境里百战百胜的机器人策略，一到真实世界就拉胯——这就是 Sim-to-Real Gap。

## 问题根源

仿真和现实的差异来自多个层面：

| 差异来源 | 仿真 | 现实 |
|---------|------|------|
| 物理参数 | 精确已知 | 摩擦/质量/惯量有偏差 |
| 传感器 | 理想化 | 噪声、遮挡、光照变化 |
| 接触动力学 | 近似模型 | 复杂的形变和摩擦 |
| 延迟 | 零延迟 | 通讯+计算延迟 |

## 主流方法

### 1. Domain Randomization

在仿真中大量随机化物理参数和视觉外观，让策略对各种条件都具有鲁棒性。

```python
# 每次reset时随机化物理参数
def randomize_env(env):
    env.friction = np.random.uniform(0.3, 1.2)
    env.mass = np.random.uniform(0.5, 2.0)
    env.restitution = np.random.uniform(0.0, 0.5)
    # 随机化视觉纹理
    env.texture = random_texture_from_pool()
    return env
```

**核心思想**：如果策略在 N 种随机参数下都能成功，那真实世界大概率落在分布内。

### 2. System Identification

反方向——先测量真实世界的参数，再在仿真中拟合。

```python
# 收集真实数据，拟合物理参数
from scipy.optimize import minimize

def loss(params):
    sim_data = simulate(params)
    return np.sum((sim_data - real_data) ** 2)

real_params = minimize(loss, initial_guess)
```

精度高，但只适用于参数可观测的场景。

### 3. Domain Adaptation

用对抗训练减小仿真和现实的特征分布差异。

```
仿真图像 → [编码器] → 特征 → [判别器] 判断来源
                      → [策略网络] → 动作
```

判别器试图区分"仿真特征"和"真实特征"，编码器试图骗过判别器——最终学到的特征对两个域都适用。

### 4. 渐进式迁移（Curriculum）

从仿真起步，逐步混入真实数据：

1. 阶段一：100% 仿真数据训练
2. 阶段二：70% 仿真 + 30% 真实数据微调
3. 阶段三：在真实环境中继续微调

## 工业场景的特殊挑战

在产线上，Sim-to-Real 的难度更高：

- **精度要求极高**：装配公差 0.05mm，仿真里的微小偏差都会导致失败
- **接触丰富**：插装、拧螺丝等任务涉及复杂接触动力学
- **安全约束**：不能像实验室那样随意试错

我的实践经验：**在工业场景，System Identification + 少量真实数据微调**是最靠谱的组合。Domain Randomization 适合通用机器人，但在高精度场景反而引入过多方差。

## 工具推荐

| 工具 | 特点 | 适用场景 |
|------|------|---------|
| Isaac Sim | GPU并行，物理精度高 | 大规模训练 |
| MuJoCo | 接触模型优秀 | 灵巧手、抓取 |
| PyBullet | 轻量，易上手 | 原型验证 |
| Genesis | 新生代，多后端 | 快速迭代 |

## 总结

Sim-to-Real 不是一个单独的技术，而是一套组合拳。理解每种方法的适用场景，根据任务特点组合使用，才能跨越这"最后一公里"。