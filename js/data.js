/**
 * Blog Posts Data（元数据）
 *
 * 该文件由 scripts/split_posts.py 生成，请勿手工编辑：
 *   - 正文在 data/posts/<id>.md，按需加载（首次进入文章时）
 *   - 全文搜索语料在 data/search-index.json，首次搜索时加载
 *   - 完整性锚点在 data/posts/manifest.json
 *
 * 每篇文章包含: id, title, date, tags, excerpt, readingMinutes（正文由 id 索引）
 */

const POSTS = [
  {
    id: 'embodied-ai-notes',
    title: '具身智能：让AI真正"住进"物理世界',
    date: '2026-08-09',
    tags: ['具身智能', 'AI', '机器人'],
    excerpt: '当大语言模型学会了推理与对话，下一步是什么？具身智能（Embodied AI）试图回答这个问题——让AI不仅能思考，还能在物理世界中感知、交互和行动。',
    readingMinutes: 2
  },
  {
    id: 'vla-model-intro',
    title: 'VLA模型入门：从RT-1到OpenVLA',
    date: '2026-07-28',
    tags: ['VLA', '深度学习', '机器人'],
    excerpt: 'Vision-Language-Action模型正在重新定义机器人控制范式。本文梳理从Google RT-1到OpenVLA的技术演进路线，帮助你快速建立对这个领域的认知框架。',
    readingMinutes: 4
  },
  {
    id: 'arm-trajectory-planning',
    title: '机械臂轨迹规划简述：从多项式到优化方法',
    date: '2026-07-15',
    tags: ['机械臂', '运动控制', '技术笔记'],
    excerpt: '机械臂的运动控制中，轨迹规划是核心环节之一。本文从最基础的多项式插值讲起，到现代优化方法，梳理一条清晰的学习路径。',
    readingMinutes: 3
  },
  {
    id: 'smart-production-line',
    title: '从传统产线到智能产线：我做产线智能化三年的总结',
    date: '2026-06-20',
    tags: ['智能制造', '产线', '随笔'],
    excerpt: '在产线智能化这个领域摸爬滚打了三年，踩过不少坑，也有一些自己的思考。这篇文章不是技术教程，更像是一份"经验沉淀"。',
    readingMinutes: 3
  },
  {
    id: 'shenzhen-weekend',
    title: '深圳周末好去处：我的私藏清单',
    date: '2026-06-08',
    tags: ['生活', '深圳', '随笔'],
    excerpt: '工作日在香港，周末回深圳。这半年探索了不少深圳周边的好地方，整理成一份清单，既是记录，也分享给同样在深港两地跑的朋友。',
    readingMinutes: 2
  },
  {
    id: 'robotics-textbook-notes',
    title: '读书笔记：《机器人学导论》前三章重点梳理',
    date: '2026-05-30',
    tags: ['读书笔记', '机器人', '技术笔记'],
    excerpt: 'Craig的《Introduction to Robotics》是机器人领域的经典教材。最近重新翻了一遍前三章，把核心概念和公式整理成笔记，方便查阅。',
    readingMinutes: 4
  },
  {
    id: 'sim-to-real-gap',
    title: 'Sim-to-Real Gap：具身智能落地的最后一公里',
    date: '2026-08-05',
    tags: ['具身智能', '深度学习', '技术笔记'],
    excerpt: '仿真环境里百战百胜的机器人策略，一到真实世界就拉胯。Sim-to-Real Gap是具身智能最硬的工程骨头之一，本文梳理主流的跨越方法。',
    readingMinutes: 3
  },
  {
    id: 'vla-industrial-challenges',
    title: 'VLA模型在工业场景的落地挑战与思考',
    date: '2026-07-25',
    tags: ['VLA', '智能制造', '产线'],
    excerpt: 'VLA模型在实验室里已经能倒水、收衣服了，但放到产线上做装配、检测、上下料？还差得远。本文聊聊VLA落地工业场景的几道硬坎。',
    readingMinutes: 3
  },
  {
    id: 'robot-grasping-survey',
    title: '机械臂抓取技术：从解析法到学习方法',
    date: '2026-07-10',
    tags: ['机械臂', '深度学习', '技术笔记'],
    excerpt: '抓取是机械臂最基础也最难的技能之一。从经典的力闭合分析到现在的端到端学习，本文梳理抓取技术的完整演进脉络。',
    readingMinutes: 3
  },
  {
    id: 'industrial-protocols-notes',
    title: '工业通信协议实战笔记：OPC UA、Modbus与Profinet',
    date: '2026-06-15',
    tags: ['智能制造', '产线', '技术笔记'],
    excerpt: '做产线智能化，绕不开设备通信。这篇整理我在实际项目中用过的三种主流工业协议——OPC UA、Modbus、Profinet的实战经验。',
    readingMinutes: 4
  },
  {
    id: 'force-compliance-control',
    title: '机械臂力控与柔顺控制：从阻抗控制到导纳控制',
    date: '2026-06-01',
    tags: ['机械臂', '运动控制', '技术笔记'],
    excerpt: '纯位置控制在接触任务中会"硬碰硬"——力控与柔顺控制让机械臂学会"温柔"。本文梳理阻抗控制、导纳控制和混合力位控制的核心原理。',
    readingMinutes: 4
  },
  {
    id: 'digital-twin-manufacturing',
    title: '数字孪生在产线中的应用：不只是好看的3D',
    date: '2026-05-15',
    tags: ['智能制造', '产线', '技术笔记'],
    excerpt: '数字孪生被炒得很热，但大部分项目最后只做出了一个"好看的3D看板"。本文聊聊数字孪生在产线中真正有价值的几个应用场景。',
    readingMinutes: 4
  },
  {
    id: 'ml-fundamentals-overview',
    title: '机器学习入门：从线性回归到深度学习',
    date: '2026-08-10',
    tags: ['机器学习', '深度学习', '技术笔记'],
    excerpt: '机器学习的概念满天飞，但底层逻辑其实很朴素。本文从一个线性回归讲起，一步步到深度学习，帮你建立完整的认知框架。',
    readingMinutes: 6
  },
  {
    id: 'rl-from-mdp-to-ppo',
    title: '强化学习入门：从MDP到PPO',
    date: '2026-08-03',
    tags: ['强化学习', '机器学习', '技术笔记'],
    excerpt: '强化学习是让AI学会"做决策"的框架。本文从马尔可夫决策过程讲起，一步步到当前最主流的PPO算法，帮你建立完整认知。',
    series: '强化学习系列',
    seriesOrder: 1,
    readingMinutes: 6
  },
  {
    id: 'slam-overview-filtering-to-graph',
    title: 'SLAM技术全景：从滤波到图优化',
    date: '2026-07-28',
    tags: ['SLAM', '机器人', '技术笔记'],
    excerpt: 'SLAM（同时定位与建图）是移动机器人的核心技术。本文从贝叶斯滤波讲到因子图优化，梳理SLAM的完整技术脉络。',
    series: 'SLAM 技术系列',
    seriesOrder: 1,
    readingMinutes: 8
  },
  {
    id: 'rl-robot-control',
    title: '强化学习在机器人控制中的应用',
    date: '2026-07-20',
    tags: ['强化学习', '机器人', '技术笔记'],
    excerpt: '强化学习让机器人不需要精确的动力学模型就能学会复杂技能。本文梳理RL在机器人控制中的应用实践，从仿真训练到真实部署。',
    series: '强化学习系列',
    seriesOrder: 2,
    readingMinutes: 6
  },
  {
    id: 'visual-slam-frontend',
    title: '视觉SLAM前端：特征提取与匹配',
    date: '2026-07-05',
    tags: ['SLAM', '深度学习', '技术笔记'],
    excerpt: '视觉SLAM的前端决定了系统的鲁棒性。本文从ORB特征讲到SuperPoint+SuperGlue，梳理特征提取与匹配的完整技术链路。',
    series: 'SLAM 技术系列',
    seriesOrder: 2,
    readingMinutes: 6
  },
  {
    id: 'deep-learning-in-slam',
    title: '深度学习在SLAM中的应用',
    date: '2026-06-25',
    tags: ['SLAM', '深度学习', '机器学习'],
    excerpt: '传统SLAM的瓶颈在哪？深度学习能解决什么？本文梳理深度学习在SLAM各个环节中的应用现状与落地挑战。',
    series: 'SLAM 技术系列',
    seriesOrder: 3,
    readingMinutes: 7
  }
];

// 标签信息（自动从文章中提取，这里用于排序）
const TAG_ORDER = ['具身智能', 'VLA', '机械臂', '智能制造', '机器人', '深度学习', '机器学习', '强化学习', 'SLAM', '运动控制', '读书笔记', '技术笔记', '随笔', '生活', '深圳', '产线'];
