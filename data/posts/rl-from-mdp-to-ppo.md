# 强化学习入门：从MDP到PPO

强化学习（RL）是让智能体通过试错来学习最优策略的框架。AlphaGo、ChatGPT的RLHF、机器人控制——背后都是RL。

## 核心概念

```
环境 ← 状态 s_t → 智能体
环境 ← 奖励 r_t ← 动作 a_t ← 智能体
```

| 概念 | 含义 | 例子（机器人抓取） |
|------|------|-------------------|
| 状态 s | 环境的描述 | 关节角度+物体位置 |
| 动作 a | 智能体的输出 | 关节力矩 |
| 奖励 r | 即时反馈 | 抓住+1，掉落-1 |
| 策略 π | 决策规则 | π(a|s) |
| 价值 V | 长期回报期望 | 当前状态有多"好" |

## 马尔可夫决策过程（MDP）

RL 的数学基础是 MDP，定义为五元组 `(S, A, P, R, γ)`：

- **S**：状态空间
- **A**：动作空间
- **P(s'|s,a)**：转移概率
- **R(s,a)**：奖励函数
- **γ**：折扣因子（0~1），越接近1越看重长远回报

**马尔可夫性**：未来只取决于当前状态，与历史无关。

## 贝尔曼方程：RL 的核心等式

价值函数的递归定义：

```
状态价值:  V(s) = E[r + γ * V(s')]
动作价值:  Q(s,a) = E[r + γ * max_a' Q(s', a')]
```

直觉理解：当前状态的价值 = 即时奖励 + 下一状态价值（折扣后）。

```python
def value_iteration(states, actions, transitions, rewards, gamma=0.9, theta=1e-6):
    """值迭代算法——求解最优价值函数"""
    V = {s: 0 for s in states}
    
    while True:
        delta = 0
        for s in states:
            v = V[s]
            # 对每个动作计算Q值，取最大
            V[s] = max(
                sum(transitions[s][a][s'] * (rewards[s][a] + gamma * V[s'])
                    for s_prime in states)
                for a in actions
            )
            delta = max(delta, abs(v - V[s]))
        
        if delta < theta:
            break
    
    return V
```

## Q-Learning：无模型RL的开端

不需要知道环境模型（转移概率），直接从经验中学习Q值。

```python
import numpy as np

class QLearning:
    def __init__(self, n_states, n_actions, lr=0.1, gamma=0.9, epsilon=0.1):
        self.Q = np.zeros((n_states, n_actions))
        self.lr = lr       # 学习率
        self.gamma = gamma  # 折扣因子
        self.epsilon = epsilon  # 探索率
    
    def act(self, state):
        """ε-greedy 策略"""
        if np.random.random() < self.epsilon:
            return np.random.randint(self.Q.shape[1])  # 探索
        return np.argmax(self.Q[state])  # 利用
    
    def learn(self, s, a, r, s_next, done):
        """Q值更新"""
        target = r + (0 if done else self.gamma * np.max(self.Q[s_next]))
        self.Q[s, a] += self.lr * (target - self.Q[s, a])
```

**ε-greedy** 是RL最核心的权衡——探索（Exploration）vs 利用（Exploitation）。

## Deep Q-Network (DQN)

Q-Learning 用表格存Q值，状态空间一大就炸了。DQN 用神经网络近似Q函数。

```python
import torch
import torch.nn as nn

class DQN(nn.Module):
    def __init__(self, state_dim, action_dim):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_dim, 128),
            nn.ReLU(),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Linear(128, action_dim)
        )
    
    def forward(self, state):
        return self.net(state)  # 输出每个动作的Q值

# DQN 的两个关键技巧:
# 1. Experience Replay: 存经验到buffer，随机采样训练（去相关）
# 2. Target Network: 用延迟更新的target网络计算target（稳定训练）
```

## Policy Gradient：直接优化策略

DQN 学习Q值再间接推出策略。Policy Gradient 直接优化策略本身。

```python
class PolicyNetwork(nn.Module):
    def __init__(self, state_dim, action_dim):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_dim, 128),
            nn.ReLU(),
            nn.Linear(128, action_dim),
            nn.Softmax(dim=-1)  # 输出动作概率
        )
    
    def forward(self, state):
        return self.net(state)

def policy_gradient_loss(log_probs, rewards, gamma=0.9):
    """REINFORCE 算法的损失函数"""
    # 计算折扣累积奖励
    returns = []
    R = 0
    for r in reversed(rewards):
        R = r + gamma * R
        returns.insert(0, R)
    returns = torch.tensor(returns)
    returns = (returns - returns.mean()) / (returns.std() + 1e-8)  # 标准化
    
    # 损失 = -log(π(a|s)) * G_t
    loss = -torch.stack(log_probs) * returns
    return loss.sum()
```

核心思想：**好的动作（高回报）增大其概率，差的动作（低回报）减小其概率**。

## PPO：当前工业级RL的标准选择

Proximal Policy Optimization（PPO）是 OpenAI 的默认算法，也是 ChatGPT RLHF 使用的算法。

解决了 Policy Gradient 的两个问题：
1. **训练不稳定**：策略更新太大导致崩溃
2. **样本效率低**：on-policy 方法数据用一次就扔

```python
def ppo_loss(old_log_probs, new_log_probs, advantages, epsilon=0.2):
    """PPO 的 Clipped Surrogate Loss"""
    # 重要性采样比率
    ratio = torch.exp(new_log_probs - old_log_probs)
    
    # 裁剪：限制策略更新幅度
    surr1 = ratio * advantages
    surr2 = torch.clamp(ratio, 1 - epsilon, 1 + epsilon) * advantages
    
    # 取较小值 = 悲观更新
    loss = -torch.min(surr1, surr2).mean()
    return loss
```

PPO 的精妙之处在于：用一个简单的 clip 操作，就实现了"信任区域"的效果——不让策略更新太激进。

## RL 算法演进总结

| 算法 | 类型 | 核心创新 | 适用场景 |
|------|------|---------|---------|
| Q-Learning | Value-based | 无模型Q值迭代 | 离散动作 |
| DQN | Value-based | 神经网络+Replay | 离散动作 |
| DDPG | Actor-Critic | 确定性策略梯度 | 连续动作 |
| SAC | Actor-Critic | 最大熵RL | 连续动作 |
| PPO | Policy-based | 裁剪目标函数 | 通用 |

## RL 在机器人中的应用

这也是我最关心的方向。RL 在机器人控制中有独特优势——不需要精确的动力学模型。

```python
# 机器人RL训练的典型设置
env = RobotEnv()  # 仿真环境 (Isaac Gym / MuJoCo)

# 1. 定义奖励函数（最关键的部分）
def reward(state, action, next_state):
    r = 0
    r += distance_bonus(state, next_state)    # 接近目标+奖励
    r -= action_penalty(action)               # 动作幅度惩罚
    r -= energy_cost(action)                  # 能耗惩罚
    if task_success(next_state):
        r += 10  # 成功大奖励
    return r

# 2. Domain Randomization（sim-to-real关键）
env.randomize(
    friction=(0.3, 1.2),
    mass=(0.8, 1.2),
    gravity=(9.6, 10.0)
)

# 3. 训练
model = PPO('MlpPolicy', env, verbose=1)
model.learn(total_timesteps=1_000_000)
```

但 RL 在工业机器人的落地还有很长的路：
- **安全约束**：RL 的探索天性在产线上不可接受
- **训练成本**：仿真到真实的迁移仍是难题
- **可解释性**：策略网络是黑盒

## 学习资源推荐

```
入门: OpenAI Spinning Up → David Silver RL 课
进阶: 《Reinforcement Learning: An Introduction》(Sutton & Barto)
实战: Stable-Baselines3 → Isaac Gym
论文: PPO → SAC → Dreamer 系列
```

强化学习的学习曲线很陡，但一旦理解了"智能体通过试错优化策略"这个框架，后面的算法都是在这个框架上的改进。

## 我的相关实战代码

> 下面是我早年练手强化学习时真实写过的代码，和上文的算法一一对应。完整文件可在 [代码库：强化学习](#/codelib/reinforce_learning) 浏览。

### 1. PPO 的 Clipped Surrogate Loss（PyTorch）

文件 `PPO-PyTorch/PPO.py` 里，最关键的不是网络结构，而是这段“裁剪损失”——它正是文章里讲的 PPO 核心：

```python
# 重要性采样比率：新策略 / 旧策略
ratios = torch.exp(logprobs - old_logprobs.detach())
# 优势函数
advantages = rewards - state_values.detach()
surr1 = ratios * advantages
# 裁剪：把更新幅度限制在 [1-eps, 1+eps]
surr2 = torch.clamp(ratios, 1 - self.eps_clip, 1 + self.eps_clip) * advantages
# 取较小值 = 悲观更新，防止一步更新太激进
loss = -torch.min(surr1, surr2) + 0.5 * self.MseLoss(state_values, rewards) - 0.01 * dist_entropy
```

**含义**：`ratios` 衡量新策略相对旧策略偏离了多少；`clamp` 把它“削”在 0.8~1.2 之间，避免一次更新把策略带崩。`-0.01 * dist_entropy` 是熵正则，鼓励策略保持探索。整个 `ActorCritic` 是一个共享 backbone 的双头网络：actor 输出动作概率，critic 输出状态价值。

### 2. 连续动作版本

同目录的 `PPO_continuous.py` 把离散 `Softmax` 换成高斯分布（输出动作均值 + 对数标准差），用 `Normal` 分布采样，适配机械臂这类连续控制任务。训练循环跑在 `LunarLander-v2` 等 Gym 环境上。

想直接看源码？→ [代码库：强化学习](#/codelib/reinforce_learning)

