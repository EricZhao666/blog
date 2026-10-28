# VLA模型入门：从RT-1到OpenVLA

Vision-Language-Action（VLA）模型正在重新定义机器人控制范式。本文梳理从Google RT-1到OpenVLA的技术演进路线。

## VLA是什么

VLA模型接收**视觉输入**（摄像头画面）和**语言指令**（"把红色方块放到蓝色碗里"），直接输出**机器人动作**（关节角度或末端执行器位姿）。

它本质上是把三个模态端到端地连在一起：

```
摄像头图像 + 语言指令 → [VLA模型] → 机械臂动作序列
```

## 技术演进路线

### 1. RT-1 (Google, 2022)

RT-1 是第一个在大规模真实机器人数据上训练的Transformer-based VLA模型。

- **架构**: ViT + Tokenizer + Transformer
- **输入**: 图像历史 + 语言指令
- **输出**: 离散化的动作token（11维）
- **数据量**: 13万+ episodes
- **意义**: 证明了端到端VLA在真实机器人上可行

### 2. RT-2 (Google, 2023)

RT-2 的核心创新是**把机器人动作当作语言token**，直接复用大语言模型的推理能力。

```python
# RT-2的核心思路：动作即语言
# 将连续动作离散化为token
action_tokens = tokenize_action(
    arm_action,    # 7维机械臂动作
    gripper_action # 1维夹爪动作
)
# 嵌入到语言模型的词表中
# 模型像"说话"一样输出动作
```

- **优势**: 继承了VLM的常识推理能力
- **突破**: 可以理解复杂指令（"拿那个不太像其他东西的物体"）
- **代价**: 推理速度慢（1-3Hz）

### 3. OpenVLA (Stanford, 2024)

OpenVLA 是开源VLA的里程碑：

- **架构**: 基于Prismatic VLM，Llama 2 7B骨干
- **数据**: Open X-Embodiment数据集（970k episodes）
- **特点**: 完全开源、可微调、支持LoRA
- **性能**: 在多个benchmark上接近甚至超过RT-2

## 关键技术对比

| 模型 | 参数量 | 推理速度 | 开源 | 核心创新 |
|------|--------|---------|------|---------|
| RT-1 | 35M | ~5Hz | 否 | 大规模真实数据训练 |
| RT-2 | 55B | 1-3Hz | 否 | 动作即语言token |
| OpenVLA | 7B | ~6Hz | 是 | 开源+可微调 |

## 实践建议

如果你想入门VLA：

1. **先读Open X-Embodiment论文**，了解数据集和benchmark
2. **跑通OpenVLA的推理demo**，建立直觉
3. **在自己的数据上做LoRA微调**，感受数据质量的重要性
4. **关注sim-to-real**，这是最大的工程挑战

## 总结

VLA模型正在快速演进。从RT-1的可行性验证，到RT-2的推理能力突破，再到OpenVLA的开源 democratization——这个领域每隔几个月就有新进展。

对于做产线智能化的同学来说，值得关注的是：**如何把VLA的通用能力适配到工业场景的精度和可靠性要求**。这中间的gap，就是我们的机会。

## 我的相关实战代码

> 我根据 OpenVLA 的思路手写过一份“迷你 VLA”，把“图像 + 指令 → 动作”端到端跑通。完整代码见 [代码库：pythoncodeplace](#/codelib/pythoncodeplace)。

### 1. 视觉 - 语言 - 动作 token 拼接（核心）

`openvla/models/openvla.py` 里的 `OpenVLAMiniLite`，把视觉特征投影成 token，和语言 token、动作 token 拼到一起喂给 Transformer：

```python
# 1. 视觉编码 -> 投影到 token 空间
v = self.vision_proj(self.vision(image))        # (B, 1, 768)
# 2. 三类 token 拼接（OpenVLA 的核心思想）
tokens = torch.cat([v, lang_embeds, action_embeds], dim=1)
# 3. Transformer 融合
h = self.transformer(tokens, attn_mask)
# 4. 取最后一个 token 预测动作
action = self.action_head(h[:, -1, :])
```

**含义**：这正是 RT-2 / OpenVLA“动作即 token”的思路——图像、语言、动作都被当作同一序列里的 token，让一个 Transformer 统一处理。和文章里“把三个模态端到端连起来”完全对应。

### 2. 动作头（Action Head）

`openvla/models/action_head.py` 是一个极简 MLP，把融合后的 768 维特征映射到 7 维机械臂动作：

```python
class ActionHead(nn.Module):
    def __init__(self, d_model=768, d_action=7):
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 256), nn.GELU(),
            nn.Linear(256, d_action))
    def forward(self, h):
        return self.mlp(h)
```

### 3. 从零训练一个迷你 VLA

`openvla/full_openvla.py` 在 CartPole 环境上完整演示了：用 Gym 自动采集（图像, 指令, 动作）数据 → 字符级文本编码 → CNN + GRU 融合 → CrossEntropy 训练。是理解 VLA 数据流最好的最小可运行样例。

完整源码 → [代码库：pythoncodeplace](#/codelib/pythoncodeplace)

