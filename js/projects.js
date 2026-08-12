// ============================================
// 项目作品集数据
// 每个项目包含: id, name, description, tech[], tags[], icon, link, status, year, highlights[]
// 说明: 这是示例数据，你可以替换成自己真实的项目。
// ============================================

const PROJECTS = [
  {
    id: 'arm-visual-grasping',
    name: '六轴机械臂视觉抓取系统',
    description: '基于 ROS2 + PyTorch 的机械臂视觉抓取方案，融合 YOLO 检测与 6D 位姿估计，实现无序工件分拣。整套系统部署在真实产线进行验证。',
    tech: ['ROS2', 'PyTorch', 'OpenCV', 'MoveIt2', 'Python'],
    tags: ['机械臂', '计算机视觉', '深度学习'],
    icon: '🦾',
    link: '',
    status: '已完成',
    year: '2025',
    highlights: ['6D 位姿估计精度 < 2mm', '单件抓取周期 < 3s', '支持 20+ 类工件无序分拣']
  },
  {
    id: 'digital-twin-line',
    name: '产线数字孪生平台',
    description: '面向电子组装产线的数字孪生系统，实时同步设备状态、产量与良率，支持工艺参数仿真与异常预警，已在两条产线落地。',
    tech: ['Three.js', 'WebSocket', 'Python', 'OPC UA', '时序数据库'],
    tags: ['智能制造', '数字孪生', '数据可视化'],
    icon: '🏭',
    link: '',
    status: '已完成',
    year: '2025',
    highlights: ['设备状态刷新延迟 < 200ms', '支持 What-if 工艺仿真', '异常预警准确率 92%']
  },
  {
    id: 'slam-agv',
    name: 'AGV 视觉 SLAM 导航',
    description: '面向厂房环境的 AGV 自主导航方案，融合激光与视觉 SLAM，解决动态人流干扰下的定位漂移问题。',
    tech: ['C++', 'ROS', 'ORB-SLAM3', 'Cartographer', 'Linux'],
    tags: ['SLAM', '机器人', '导航'],
    icon: '🚚',
    link: '',
    status: '进行中',
    year: '2026',
    highlights: ['动态环境定位漂移 < 5cm', '重定位耗时 < 1s', '支持多车协同']
  },
  {
    id: 'vla-industrial',
    name: '工业场景 VLA 操作模型',
    description: '探索 Vision-Language-Action 模型在柔性装配中的落地，用合成数据 + 真实微调的方式训练指令驱动的操作策略。',
    tech: ['PyTorch', 'Transformers', 'Isaac Gym', 'Python'],
    tags: ['VLA', '具身智能', '智能制造'],
    icon: '🤖',
    link: '',
    status: '进行中',
    year: '2026',
    highlights: ['合成数据自动生成 pipeline', 'sim-to-real 微调策略', '自然语言切换装配任务']
  },
  {
    id: 'force-assembly',
    name: '力控柔顺装配工位',
    description: '基于六维力传感器的轴孔柔顺装配方案，结合阻抗控制与搜索策略，解决精密零件过盈配合难题。',
    tech: ['C++', 'EtherCAT', 'ROS2', '阻抗控制'],
    tags: ['机械臂', '力控', '运动控制'],
    icon: '🔧',
    link: '',
    status: '已完成',
    year: '2024',
    highlights: ['装配成功率达 99.2%', '接触力自适应调节', '换型时间 < 5min']
  },
  {
    id: 'defect-inspection',
    name: '产线缺陷在线检测',
    description: '基于深度学习的表面缺陷检测系统，部署在产线边缘设备，实时识别划痕、凹坑、脏污等缺陷并触发分拣。',
    tech: ['PyTorch', 'TensorRT', 'OpenCV', 'Jetson', 'Python'],
    tags: ['深度学习', '智能制造', '边缘计算'],
    icon: '🔍',
    link: '',
    status: '已完成',
    year: '2024',
    highlights: ['检出率 99.5%', '单帧推理 < 15ms', '误报率 < 0.3%']
  }
];
