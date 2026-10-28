# 强化学习在机器人控制中的应用

传统机器人控制依赖精确的动力学模型——但现实中的模型总有误差。强化学习提供了一条不同的路：让机器人自己学。

## 为什么用RL做机器人控制

传统控制的困境：

```
模型基控制 (MPC/LQR):
  优点: 有理论保证、可解释
  缺点: 需要精确动力学模型 → 建模误差 → 性能下降

RL控制:
  优点: 不需要模型、能处理高度非线性
  缺点: 训练成本高、安全无保证、黑盒
```

实际中最好的策略是**两者结合**：RL做高层决策，传统控制做底层执行。

## RL 机器人控制的问题建模

```python
# 标准的机器人RL环境定义
class RobotEnv:
    def __init__(self):
        self.robot = RobotArm()  # 7-DOF
        self.target = random_pose()
    
    def reset(self):
        self.robot.reset()
        self.target = random_pose()
        return self._get_obs()
    
    def _get_obs(self):
        """状态设计——最关键的部分"""
        return np.concatenate([
            self.robot.joint_pos,       # 关节角度 (7)
            self.robot.joint_vel,       # 关节速度 (7)
            self.robot.ee_pose,         # 末端位姿 (7: 3位置+4姿态)
            self.target,                # 目标位姿 (7)
            self.target - self.robot.ee_pose  # 相对位姿 (7)
        ])
    
    def step(self, action):
        """动作执行"""
        self.robot.apply_torque(action)
        obs = self._get_obs()
        reward = self._compute_reward(obs)
        done = self._check_done(obs)
        return obs, reward, done, {}
    
    def _compute_reward(self, obs):
        """奖励设计——RL的灵魂"""
        ee_pos = obs[14:17]
        target_pos = obs[21:24]
        
        # 1. 距离奖励（稠密奖励）
        dist = np.linalg.norm(ee_pos - target_pos)
        r = -dist  # 越近越好
        
        # 2. 到达奖励（稀疏奖励）
        if dist < 0.05:
            r += 10.0
        
        # 3. 能耗惩罚
        r -= 0.001 * np.sum(self.robot.joint_torque ** 2)
        
        # 4. 平滑性惩罚
        r -= 0.01 * np.sum(np.diff(self.robot.joint_pos) ** 2)
        
        return r
```

## 奖励设计的艺术

RL 中**奖励设计比算法选择更重要**。一个好的奖励函数应该：

1. **稠密**：每一步都有反馈，不是只有终点才有
2. **引导性**：梯度方向指向目标
3. **不过度约束**：给智能体留探索空间

```
不好的奖励:  只有抓到物体才+1 → 稀疏奖励，训练极慢
好的奖励:    距离越近+越多 + 抓到+10 + 稳定握住+持续奖励
```

### 常见的奖励 shaping 技巧

```python
def shaped_reward(env, action):
    r = 0
    
    # 1. 势能函数（potential-based shaping）
    # 保证最优策略不变的前提下加速学习
    phi_old = potential(env.prev_state)
    phi_new = potential(env.current_state)
    r += gamma * phi_new - phi_old
    
    # 2. 课程学习——逐步提高难度
    if env.difficulty == 'easy':
        r += reach_bonus(large_threshold)
    elif env.difficulty == 'hard':
        r += reach_bonus(small_threshold)
    
    return r
```

## 仿真训练：大规模并行

真实机器人训练太慢太危险。在仿真中训练，再迁移到真实。

```python
# Isaac Gym 大规模并行训练
# 一个GPU上同时跑4096个机器人
import isaacgym

env = IsaacVecEnv(
    task='FrankaReach',
    num_envs=4096,        # 4096个并行环境
    gpu_id=0,
    sim_dt=1/120,
    control_dt=1/30       # 30Hz控制
)

# PPO 训练
model = PPO(
    policy=MlpPolicy,
    env=env,
    learning_rate=3e-4,
    n_steps=256,
    batch_size=4096,
    gamma=0.8,            # 机器人任务通常用较小gamma
    gae_lambda=0.9
)

model.learn(total_timesteps=10_000_000)
# 4096个并行环境 × 30Hz × 几小时 = 上亿步经验
```

### Isaac Gym vs MuJoCo

| 特性 | Isaac Gym | MuJoCo |
|------|-----------|--------|
| 并行性 | GPU大规模并行 | CPU并行 |
| 物理精度 | 中 | 高 |
| 接触模型 | GPU仿真 | 精确 |
| 速度 | 极快(4096并行) | 中等 |
| 适用 | 大规模RL训练 | 精细接触任务 |

## Sim-to-Real 迁移

### Domain Randomization

```python
def randomize_env(env):
    """每次reset随机化物理参数"""
    env.friction = np.random.uniform(0.3, 1.5)
    env.density = np.random.uniform(0.8, 1.2)
    env.gravity = np.random.uniform(9.6, 10.0, 3)
    
    # 视觉随机化
    env.light_color = random_color()
    env.texture = random_from_texture_pool()
    
    # 动作延迟随机化
    env.action_delay = np.random.uniform(0, 0.05)
    
    return env
```

### Teacher-Student 蒸馏

```
Teacher (特权信息):  真实物理参数 → 训练出强策略
Student (只有传感器): 模仿Teacher → 部署到真实机器人
```

```python
# Teacher: 用真实参数训练（仿真中知道真值）
teacher_policy = train_rl(
    obs=full_state,  # 包含真实摩擦、质量等
    env=sim_with_true_params
)

# Student: 只有传感器数据
# 通过模仿学习从Teacher蒸馏
for batch in dataloader:
    sensor_obs = batch['sensor']        # 只有传感器
    teacher_action = teacher_policy(batch['privileged'])
    
    student_action = student_policy(sensor_obs)
    loss = F.mse_loss(student_action, teacher_action)
    loss.backward()
```

## 实际案例：机械臂抓取的RL

```python
class GraspEnv:
    """RL训练机械臂抓取"""
    def __init__(self):
        self.robot = FrankaPanda()
        self.object = random_object()
        self.camera = SimCamera()
    
    def _get_obs(self):
        # 视觉 + 本体感觉
        return {
            'image': self.camera.render(),      # [H, W, 3]
            'state': np.concatenate([
                self.robot.joint_pos,            # 7
                self.robot.joint_vel,            # 7
                self.robot.gripper_pos,          # 1
            ])
        }
    
    def _compute_reward(self):
        r = 0
        # 1. 接近物体
        r -= np.linalg.norm(self.robot.ee_pos - self.object.pos)
        
        # 2. 抓取成功
        if self.object.is_grasped(self.robot):
            r += 5.0
            
            # 3. 抬起
            if self.object.pos[2] > 0.3:
                r += 10.0
                
                # 4. 放到目标位置
                r -= np.linalg.norm(self.object.pos - self.target_pos)
                if np.linalg.norm(self.object.pos - self.target_pos) < 0.1:
                    r += 20.0
                    return r, True  # 任务完成
        
        # 5. 物体掉落
        if self.object.pos[2] < 0:
            return -10.0, True
        
        return r, False
```

训练技巧：
1. **课程学习**：先学抓固定位置的球，再学抓随机位置的物体
2. **多物体预训练**：在大量物体上预训练，提升泛化能力
3. **物体集合随机化**：每次reset换不同的物体形状和大小

## RL vs 传统控制：什么时候用什么

| 场景 | 推荐方法 | 原因 |
|------|---------|------|
| 轨迹跟踪 | PID/MPC | 精确、可靠、可解释 |
| 抓取未知物体 | RL + 传统控制兜底 | RL负责策略，传统控制保安全 |
| 灵巧手操作 | RL | 自由度太高，传统方法建模困难 |
| 步态控制（足式） | RL + 模型预测 | RL出步态，MPC做平衡 |
| 产线固定任务 | 传统控制 | 不需要泛化，稳定性第一 |

## 部署到真实机器人

```python
# 部署流程
class RLController:
    def __init__(self, policy_path):
        self.policy = torch.jit.load(policy_path)  # TorchScript加速
        self.safety = SafetyMonitor()
    
    def compute_action(self, obs):
        # 1. 安全检查
        if self.safety.is_unsafe(obs):
            return self.safety.safe_action(obs)
        
        # 2. RL策略推理
        with torch.no_grad():
            action = self.policy(obs)
        
        # 3. 动作限幅
        action = np.clip(action, self.safe_min, self.safe_max)
        
        return action
```

部署时的关键注意事项：
1. **推理延迟**：策略网络要轻量（<10ms推理）
2. **安全监控**：独立的安全模块，不依赖RL策略
3. **异常恢复**：策略输出异常时切回安全模式
4. **在线适应**：部署后持续微调（fine-tune）

## 总结

RL 在机器人控制中的价值不在于替代传统控制，而在于**解决传统控制搞不定的问题**——未知环境、复杂接触、灵巧操作。理解 RL 的优势和边界，在合适的场景用合适的方法，才是工程上的正确做法。