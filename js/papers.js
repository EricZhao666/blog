/**
 * Papers & Learning Materials Data
 * Auto-generated from Zotero database and E:\杂项\个人资料\学习
 * Papers: 32 | Learning materials: 102 files
 */

const PAPERS = [
  {
    "id": "paper-4",
    "title": "Benchmarking Potential Based Rewards for Learning Humanoid Locomotion",
    "authors": "Jeon Se Hwan, Heim Steve, Khazoom Charles, et al.",
    "type": "conferencePaper",
    "date": "2023-05-29 2023-5-29",
    "venue": "",
    "abstract": "The main challenge in developing effective reinforcement learning (RL) pipelines is often the design and tuning the reward functions. Well-designed shaping reward can lead to significantly faster learning. Naively formulated rewards, however, can conflict with the desired behavior and result in overfitting or even erratic performance if not properly tuned. In theory, the broad class of potential based reward shaping (PBRS) can help guide the learning process without affecting the optimal policy.",
    "url": "https://ieeexplore.ieee.org/document/10160885/",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/1/Jeon 等 - 2023 - Benchmarking Potential Based Rewards for Learning Humanoid Locomotion.pdf"
  },
  {
    "id": "paper-5",
    "title": "Integrating Model-Based Footstep Planning with Model-Free Reinforcement Learning for Dynamic Legged Locomotion",
    "authors": "Lee Ho Jae, Hong Seungwoo, Kim Sangbae",
    "type": "preprint",
    "date": "2024-08-05 2024-08-05",
    "venue": "",
    "abstract": "In this work, we introduce a control framework that combines model-based footstep planning with Reinforcement Learning (RL), leveraging desired footstep patterns derived from the Linear Inverted Pendulum (LIP) dynamics. Utilizing the LIP model, our method forward predicts robot states and determines the desired foot placement given the velocity commands. We then train an RL policy to track the foot placements without following the full reference motions derived from the LIP model. This partial g",
    "url": "http://arxiv.org/abs/2408.02662",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/2/Lee 等 - 2024 - Integrating Model-Based Footstep Planning with Model-Free Reinforcement Learning for Dynamic Legged.pdf"
  },
  {
    "id": "paper-7",
    "title": "Advancing Humanoid Locomotion: Mastering Challenging Terrains with Denoising World Model Learning",
    "authors": "Gu Xinyang, Wang Yen-Jen, Zhu Xiang, et al.",
    "type": "conferencePaper",
    "date": "2024-07-15 2024-07-15",
    "venue": "",
    "abstract": "",
    "url": "http://www.roboticsproceedings.org/rss20/p058.pdf",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/3/Gu 等 - 2024 - Advancing Humanoid Locomotion Mastering Challenging Terrains with Denoising World Model Learning.pdf"
  },
  {
    "id": "paper-13",
    "title": "FT-Net: Learning Failure Recovery and Fault-Tolerant Locomotion for Quadruped Robots",
    "authors": "Luo Zeren, Xiao Erdong, Lu Peng",
    "type": "journalArticle",
    "date": "2023-12-00 12/2023",
    "venue": "",
    "abstract": "Quadruped robots, in recent years, have been increasingly used in extremely harsh and dangerous conditions. Consequently, diverse severe hardware failures may occur at any time during the working cycle of the robots. In this work, we propose a fault-tolerant (FT) control pipeline based on model-free reinforcement learning – FT-Net, which is guided by a variable-height inverted pendulum model and support polygon. This pipeline allows the robot to dynamically and autonomously adapt to both partial",
    "url": "https://ieeexplore.ieee.org/document/10305254/",
    "category": "港大教授论文",
    "collections": [
      "港大教授机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/8/Luo 等 - 2023 - FT-Net Learning Failure Recovery and Fault-Tolerant Locomotion for Quadruped Robots.pdf"
  },
  {
    "id": "paper-14",
    "title": "BiKC: Keypose-Conditioned Consistency Policy for Bimanual Robotic Manipulation",
    "authors": "Yu Dongjie, Xu Hang, Chen Yizhou, et al.",
    "type": "preprint",
    "date": "2024-09-04 2024-09-04",
    "venue": "",
    "abstract": "Bimanual manipulation tasks typically involve multiple stages which require efficient interactions between two arms, posing step-wise and stage-wise challenges for imitation learning systems. Specifically, failure and delay of one step will broadcast through time, hinder success and efficiency of each sub-stage task, and thereby overall task performance. Although recent works have made strides in addressing certain challenges, few approaches explicitly consider the multi-stage nature of bimanual",
    "url": "http://arxiv.org/abs/2406.10093",
    "category": "港大教授论文",
    "collections": [
      "港大教授机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/9/Yu 等 - 2024 - BiKC Keypose-Conditioned Consistency Policy for Bimanual Robotic Manipulation.pdf"
  },
  {
    "id": "paper-16",
    "title": "Mobile Robot Collision Avoidance Based on Deep Reinforcement Learning with Motion Constraints",
    "authors": "Tao Yuting, Li Mingyang, Cao Xiao, et al.",
    "type": "journalArticle",
    "date": "2024-00-00 2024",
    "venue": "",
    "abstract": "Deep reinforcement learning (DRL), which integrates neural networks with reinforcement learning algorithms, plays a crucial role in enhancing autonomous robot collision avoidance and navigation in various environments, including industrial warehouses, hospitals, urban pedestrian zones, and airport terminals. However, existing research has encountered limitations, such as reliance on conventional algorithms, the need for multi-sensor data fusion, and application in overly simplified or non-random",
    "url": "https://ieeexplore.ieee.org/document/10638222/",
    "category": "港大教授论文",
    "collections": [
      "港大教授机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/10/Tao 等 - 2024 - Mobile Robot Collision Avoidance Based on Deep Reinforcement Learning with Motion Constraints.pdf"
  },
  {
    "id": "paper-17",
    "title": "MorAL: Learning Morphologically Adaptive Locomotion Controller for Quadrupedal Robots on Challenging Terrains",
    "authors": "Luo Zeren, Dong Yinzhao, Li Xinqi, et al.",
    "type": "journalArticle",
    "date": "2024-05-00 5/2024",
    "venue": "",
    "abstract": "Due to the rapid development of the quadruped robot industry in the past decade, various commercial quadruped robots have emerged with distinct physical attributes. Different from the previous work in which the designed controller is robot-speciﬁc, this article proposes a learning-based control framework – MorAL, which is adaptive to different morphologies of quadruped robots and challenging terrains. Our framework concurrently trains the control policy and an adaptive module, which considers th",
    "url": "https://ieeexplore.ieee.org/document/10463132/",
    "category": "港大教授论文",
    "collections": [
      "港大教授机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/11/Luo 等 - 2024 - MorAL Learning Morphologically Adaptive Locomotion Controller for Quadrupedal Robots on Challenging.pdf"
  },
  {
    "id": "paper-18",
    "title": "A Tendon-Driven Continuum Manipulator With Robust Shape Estimation by Multiple IMUs",
    "authors": "Peng Rui, Wang Yu, Lu Peng",
    "type": "journalArticle",
    "date": "2024-04-00 4/2024",
    "venue": "",
    "abstract": "In this letter, a tendon-driven continuum robotic manipulator with three individual continuum sections is developed and manufactured. The main contribution is that we propose a robust and accurate shape estimation method based on the fusion of multi-IMUs for the manipulator, under the PCC (Piecewise Constant Curvature) assumption. To intuitively present the robot’s conﬁguration space, we develop a visualization environment to showcase the real-time continuum shape. To validate the proposed syste",
    "url": "https://ieeexplore.ieee.org/document/10427985/",
    "category": "港大教授论文",
    "collections": [
      "港大教授机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/12/Peng 等 - 2024 - A Tendon-Driven Continuum Manipulator With Robust Shape Estimation by Multiple IMUs.pdf"
  },
  {
    "id": "paper-25",
    "title": "Highly Automated Vehicles and Self-Driving Cars [Industry Tutorial]",
    "authors": "Takacs Arpad, Rudas Imre, Bosl Dominik, et al.",
    "type": "journalArticle",
    "date": "2018-12-00 12/2018",
    "venue": "",
    "abstract": "",
    "url": "https://ieeexplore.ieee.org/document/8574003/",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/19/Takacs 等 - 2018 - Highly Automated Vehicles and Self-Driving Cars [Industry Tutorial].pdf"
  },
  {
    "id": "paper-26",
    "title": "Multirotor Aerial Vehicles: Modeling, Estimation, and Control of Quadrotor",
    "authors": "Mahony Robert, Kumar Vijay, Corke Peter",
    "type": "journalArticle",
    "date": "2012-09-00 9/2012",
    "venue": "",
    "abstract": "",
    "url": "https://ieeexplore.ieee.org/document/6289431/",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/20/Mahony 等 - 2012 - Multirotor Aerial Vehicles Modeling, Estimation, and Control of Quadrotor.pdf"
  },
  {
    "id": "paper-27",
    "title": "Propeller Performance Data at Low Reynolds Numbers",
    "authors": "Brandt John, Selig Michael",
    "type": "conferencePaper",
    "date": "2011-01-04 2011-01-04",
    "venue": "",
    "abstract": "",
    "url": "https://arc.aiaa.org/doi/10.2514/6.2011-1255",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/21/Brandt和Selig - 2011 - Propeller Performance Data at Low Reynolds Numbers.pdf"
  },
  {
    "id": "paper-28",
    "title": "The social implications of using drones for biodiversity conservation",
    "authors": "Sandbrook Chris",
    "type": "journalArticle",
    "date": "2015-11-00 11/2015",
    "venue": "",
    "abstract": "Unmanned aerial vehicles, or ‘drones’, appear to offer a ﬂexible, accurate and affordable solution to some of the technical challenges of nature conservation monitoring and law enforcement. However, little attention has been given to their possible social impacts. In this paper, I review the possible social impacts of using drones for conservation, including on safety, privacy, psychological wellbeing, data security and the wider understanding of conservation problems. I argue that negative soci",
    "url": "http://link.springer.com/10.1007/s13280-015-0714-0",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/22/Sandbrook - 2015 - The social implications of using drones for biodiversity conservation.pdf"
  },
  {
    "id": "paper-29",
    "title": "The AEROARMS Project: Aerial Robots with Advanced Manipulation Capabilities for Inspection and Maintenance",
    "authors": "Ollero Anibal, Cortes Juan, Santamaria-Navarro Angel, et al.",
    "type": "journalArticle",
    "date": "2018-12-00 12/2018",
    "venue": "",
    "abstract": "",
    "url": "https://ieeexplore.ieee.org/document/8435987/",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/23/Ollero 等 - 2018 - The AEROARMS Project Aerial Robots with Advanced Manipulation Capabilities for Inspection and Maint.pdf"
  },
  {
    "id": "paper-30",
    "title": "Comprehensive Simulation of Quadrotor UAVs Using ROS and Gazebo",
    "authors": "Hutchison David, Kanade Takeo, Kittler Josef, et al.",
    "type": "bookSection",
    "date": "2012-00-00 2012",
    "venue": "",
    "abstract": "Quadrotor UAVs have successfully been used both in research and for commercial applications in recent years and there has been signiﬁcant progress in the design of robust control software and hardware. Nevertheless, testing of prototype UAV systems still means risk of damage due to failures. Motivated by this, a system for the comprehensive simulation of quadrotor UAVs is presented in this paper. Unlike existing solutions, the presented system is integrated with ROS and the Gazebo simulator. Thi",
    "url": "http://link.springer.com/10.1007/978-3-642-34327-8_36",
    "category": "已读论文",
    "collections": [
      "已读"
    ],
    "pdfPath": "D:/zotero/storage/24/Meyer 等 - 2012 - Comprehensive Simulation of Quadrotor UAVs Using ROS and Gazebo.pdf"
  },
  {
    "id": "paper-38",
    "title": "FAST-LIO2: Fast Direct LiDAR-inertial Odometry",
    "authors": "Xu Wei, Cai Yixi, He Dongjiao, et al.",
    "type": "preprint",
    "date": "2021-07-14 2021-07-14",
    "venue": "",
    "abstract": "This paper presents FAST-LIO2: a fast, robust, and versatile LiDAR-inertial odometry framework. Building on a highly efﬁcient tightly-coupled iterated Kalman ﬁlter, FASTLIO2 has two key novelties that allow fast, robust, and accurate LiDAR navigation (and mapping). The ﬁrst one is directly registering raw points to the map (and subsequently update the map, i.e., mapping) without extracting features. This enables the exploitation of subtle features in the environment and hence increases the accur",
    "url": "http://arxiv.org/abs/2107.06829",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/31/Xu 等 - 2021 - FAST-LIO2 Fast Direct LiDAR-inertial Odometry.pdf"
  },
  {
    "id": "paper-39",
    "title": "Geometric tracking control of a quadrotor UAV on SE(3)",
    "authors": "Lee Taeyoung, Leok Melvin, McClamroch N. Harris",
    "type": "conferencePaper",
    "date": "2010-12-00 12/2010",
    "venue": "",
    "abstract": "This paper provides new results for the tracking control of a quadrotor unmanned aerial vehicle (UAV). The UAV has four input degrees of freedom, namely the magnitudes of the four rotor thrusts, that are used to control the six translational and rotational degrees of freedom, and to achieve asymptotic tracking of four outputs, namely, three position variables for the vehicle center of mass and the direction of one vehicle body-ﬁxed axis. A globally deﬁned model of the quadrotor UAV rigid body dy",
    "url": "http://ieeexplore.ieee.org/document/5717652/",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/32/Lee 等 - 2010 - Geometric tracking control of a quadrotor UAV on SE(3).pdf"
  },
  {
    "id": "paper-40",
    "title": "IMU-Based Attitude Estimation in the Presence of Narrow-Band Noise",
    "authors": "Lu Guozheng, Zhang Fu",
    "type": "journalArticle",
    "date": "2019-04-00 4/2019",
    "venue": "",
    "abstract": "",
    "url": "https://ieeexplore.ieee.org/document/8629979/",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/33/Lu和Zhang - 2019 - IMU-Based Attitude Estimation in the Presence of Narrow-Band Noise.pdf"
  },
  {
    "id": "paper-41",
    "title": "ORB-SLAM: A Versatile and Accurate Monocular SLAM System",
    "authors": "Mur-Artal Raul, Montiel J. M. M., Tardos Juan D.",
    "type": "journalArticle",
    "date": "2015-10-00 10/2015",
    "venue": "",
    "abstract": "This paper presents ORB-SLAM, a feature-based monocular simultaneous localization and mapping (SLAM) system that operates in real time, in small and large indoor and outdoor environments. The system is robust to severe motion clutter, allows wide baseline loop closing and relocalization, and includes full automatic initialization. Building on excellent algorithms of recent years, we designed from scratch a novel system that uses the same features for all SLAM tasks: tracking, mapping, relocaliza",
    "url": "https://ieeexplore.ieee.org/document/7219438/",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/34/Mur-Artal 等 - 2015 - ORB-SLAM A Versatile and Accurate Monocular SLAM System.pdf"
  },
  {
    "id": "paper-42",
    "title": "VINS-Mono: A Robust and Versatile Monocular Visual-Inertial State Estimator",
    "authors": "Qin Tong, Li Peiliang, Shen Shaojie",
    "type": "journalArticle",
    "date": "2018-08-00 8/2018",
    "venue": "",
    "abstract": "One camera and one low-cost inertial measurement unit (IMU) form a monocular visual-inertial system (VINS), which is the minimum sensor suite (in size, weight, and power) for the metric six degrees-of-freedom (DOF) state estimation. In this paper, we present VINS-Mono: a robust and versatile monocular visual-inertial state estimator. Our approach starts with a robust procedure for estimator initialization. A tightly coupled, nonlinear optimization-based method is used to obtain highly accurate v",
    "url": "https://ieeexplore.ieee.org/document/8421746/",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/35/Qin 等 - 2018 - VINS-Mono A Robust and Versatile Monocular Visual-Inertial State Estimator.pdf"
  },
  {
    "id": "paper-43",
    "title": "A Multi-State Constraint Kalman Filter for Vision-aided Inertial Navigation",
    "authors": "Mourikis Anastasios I., Roumeliotis Stergios I.",
    "type": "conferencePaper",
    "date": "2007-04-00 04/2007",
    "venue": "",
    "abstract": "In this paper, we present an Extended Kalman Filter (EKF)-based algorithm for real-time vision-aided inertial navigation. The primary contribution of this work is the derivation of a measurement model that is able to express the geometric constraints that arise when a static feature is observed from multiple camera poses. This measurement model does not require including the 3D feature position in the state vector of the EKF and is optimal, up to linearization errors. The vision-aided inertial n",
    "url": "http://ieeexplore.ieee.org/document/4209642/",
    "category": "课程论文",
    "collections": [
      "课程机器人论文"
    ],
    "pdfPath": "D:/zotero/storage/36/Mourikis和Roumeliotis - 2007 - A Multi-State Constraint Kalman Filter for Vision-aided Inertial Navigation.pdf"
  },
  {
    "id": "paper-45",
    "title": "Mechanical design and balance control of a Humanoid Waist Joint",
    "authors": "Xu Wei, Huang Qiang, Jing Li, et al.",
    "type": "conferencePaper",
    "date": "2010-08-00 08/2010",
    "venue": "",
    "abstract": "A waist joint is designed for a humanoid robot in this paper, which has the characteristics of a large range of motion and high mechanical strength. A new method of balance control based on waist joints is also provided. It can effectively increase the stability margin during single support phase. We have been developing BHR, which has 38 DOF (degree of freedom). Each arm of BHR has 11 DOF in total that amounts to 3 DOF/shoulder, 2 DOF/elbow, 5 DOF/hand and 1 DOF/wrist. Each leg constitutes 6 DO",
    "url": "http://ieeexplore.ieee.org/document/5585290/",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/44/Xu 等 - 2010 - Mechanical design and balance control of a Humanoid Waist Joint.pdf"
  },
  {
    "id": "paper-49",
    "title": "Verticalized-Tip Trajectory Tracking of a 3D-Printable Soft Continuum Robot: Enabling Surgical Blood Suction Automation",
    "authors": "Lai Jiewen, Huang Kaicheng, Lu Bo, et al.",
    "type": "journalArticle",
    "date": "2022-06-00 6/2022",
    "venue": "",
    "abstract": "Soft-bodied robotic manipulators have great potential for use in minimally invasive surgery, owing to their advantages of high ﬂexibility with inﬁnite degrees of freedom (DOF). One of the potential applications is to perform blood suctioning, which is inevitable during the surgery. To attain higher efﬁciency in suctioning, the robotic tip should remain vertical while moving along on the work surface. Motivated by this application, this article presents a novel soft robot design and its control s",
    "url": "https://ieeexplore.ieee.org/document/9462388/",
    "category": "软体机器人",
    "collections": [
      "软体机器人"
    ],
    "pdfPath": "D:/zotero/storage/47/Lai 等 - 2022 - Verticalized-Tip Trajectory Tracking of a 3D-Printable Soft Continuum Robot Enabling Surgical Blood.pdf"
  },
  {
    "id": "paper-50",
    "title": "Constrained Motion Planning of a Cable-Driven Soft Robot With Compressible Curvature Modeling",
    "authors": "Lai Jiewen, Lu Bo, Zhao Qingxiang, et al.",
    "type": "journalArticle",
    "date": "2022-04-00 4/2022",
    "venue": "",
    "abstract": "A cable-driven soft robot with redundancy can perform the tip trajectory tracking task and in the meanwhile fulﬁll some extra constraints, such as tracking with a designated tip orientation, or avoiding obstacles in the environment. These constraints require proper motion planning of the soft material-based body that can be axially compressed. In this letter, we derive the compressible curvature kinematics of a cable-driven soft robot which takes the undesirable axial compression caused by the c",
    "url": "https://ieeexplore.ieee.org/document/9716747/",
    "category": "软体机器人",
    "collections": [
      "软体机器人"
    ],
    "pdfPath": "D:/zotero/storage/48/Lai 等 - 2022 - Constrained Motion Planning of a Cable-Driven Soft Robot With Compressible Curvature Modeling.pdf"
  },
  {
    "id": "paper-53",
    "title": "Robust Ladder Climbing with a Quadrupedal Robot",
    "authors": "Vogel Dylan, Baines Robert, Church Joseph, et al.",
    "type": "preprint",
    "date": "2024-09-26 2024-09-26",
    "venue": "",
    "abstract": "Quadruped robots are proliferating in industrial environments where they carry sensor suites and serve as autonomous inspection platforms. Despite the advantages of legged robots over their wheeled counterparts on rough and uneven terrain, they are still yet to be able to reliably negotiate ubiquitous features of industrial infrastructure: ladders. Inability to traverse ladders prevents quadrupeds from inspecting dangerous locations, puts humans in harm’s way, and reduces industrial site product",
    "url": "http://arxiv.org/abs/2409.17731",
    "category": "其他机器人",
    "collections": [
      "其他机器人"
    ],
    "pdfPath": "D:/zotero/storage/51/Vogel 等 - 2024 - Robust Ladder Climbing with a Quadrupedal Robot.pdf"
  },
  {
    "id": "paper-55",
    "title": "Action Planning for Packing Long Linear Elastic Objects Into Compact Boxes With Bimanual Robotic Manipulation",
    "authors": "Ma Wanyu, Zhang Bin, Han Lijun, et al.",
    "type": "journalArticle",
    "date": "2023-06-00 6/2023",
    "venue": "",
    "abstract": "In this article, we propose a new action planning approach to automatically pack long linear elastic objects into common-size boxes with a bimanual robotic system. For that, we developed a hybrid geometric model to handle large-scale occlusions combining an online visionbased method and an ofﬂine reference template. Then, a reference point generator is introduced to automatically plan the reference poses for the predesigned action primitives. Finally, an action planner integrates these component",
    "url": "https://ieeexplore.ieee.org/document/9969173/",
    "category": "其他机器人",
    "collections": [
      "其他机器人"
    ],
    "pdfPath": "D:/zotero/storage/52/Ma 等 - 2023 - Action Planning for Packing Long Linear Elastic Objects Into Compact Boxes With Bimanual Robotic Man.pdf"
  },
  {
    "id": "paper-60",
    "title": "Humanoid-Gym: Reinforcement Learning for Humanoid Robot with Zero-Shot Sim2Real Transfer",
    "authors": "Gu Xinyang, Wang Yen-Jen, Chen Jianyu",
    "type": "preprint",
    "date": "2024-05-18 2024-05-18",
    "venue": "",
    "abstract": "Humanoid-Gym is an easy-to-use reinforcement learning (RL) framework based on Nvidia Isaac Gym, designed to train locomotion skills for humanoid robots, emphasizing zero-shot transfer from simulation to the realworld environment. Humanoid-Gym also integrates a sim-tosim framework from Isaac Gym to Mujoco that allows users to verify the trained policies in different physical simulations to ensure the robustness and generalization of the policies. This framework is verified by RobotEra’s XBot-S (1",
    "url": "http://arxiv.org/abs/2404.05695",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/56/Gu 等 - 2024 - Humanoid-Gym Reinforcement Learning for Humanoid Robot with Zero-Shot Sim2Real Transfer.pdf"
  },
  {
    "id": "paper-61",
    "title": "FLD: Fourier Latent Dynamics for Structured Motion Representation and Learning",
    "authors": "Li Chenhao, Stanger-Jones Elijah, Heim Steve, et al.",
    "type": "preprint",
    "date": "2024-02-21 2024-02-21",
    "venue": "",
    "abstract": "Motion trajectories offer reliable references for physics-based motion learning but suffer from sparsity, particularly in regions that lack sufficient data coverage. To address this challenge, we introduce a self-supervised, structured representation and generation method that extracts spatial-temporal relationships in periodic or quasi-periodic motions. The motion dynamics in a continuously parameterized latent space enable our method to enhance the interpolation and generalization capabilities",
    "url": "http://arxiv.org/abs/2402.13820",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/57/Li 等 - 2024 - FLD Fourier Latent Dynamics for Structured Motion Representation and Learning.pdf"
  },
  {
    "id": "paper-62",
    "title": "Expressive Whole-Body Control for Humanoid Robots",
    "authors": "Cheng Xuxin, Ji Yandong, Chen Junming, et al.",
    "type": "preprint",
    "date": "2024-03-05 2024-03-05",
    "venue": "",
    "abstract": "Can we enable humanoid robots to generate rich, diverse, and expressive motions in the real world? We propose to learn a whole-body control policy on a human-sized robot to mimic human motions as realistic as possible. To train such a policy, we leverage the large-scale human motion capture data from the graphics community in a Reinforcement Learning framework. However, directly performing imitation learning with the motion capture dataset would not work on the real humanoid robot, given the lar",
    "url": "http://arxiv.org/abs/2402.16796",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/58/Cheng 等 - 2024 - Expressive Whole-Body Control for Humanoid Robots.pdf"
  },
  {
    "id": "paper-64",
    "title": "HumanPlus: Humanoid Shadowing and Imitation from Humans",
    "authors": "Fu Zipeng, Zhao Qingqing, Wu Qi, et al.",
    "type": "journalArticle",
    "date": "",
    "venue": "",
    "abstract": "",
    "url": "",
    "category": "双足机器人",
    "collections": [
      "双足机器人"
    ],
    "pdfPath": "D:/zotero/storage/59/Fu 等 - HumanPlus Humanoid Shadowing and Imitation from Humans.pdf"
  },
  {
    "id": "paper-68",
    "title": "Neural Network and Jacobian Method for Solving the Inverse Statics of a Cable-Driven Soft Arm With Nonconstant Curvature",
    "authors": "Giorelli Michele, Renda Federico, Calisti Marcello, et al.",
    "type": "journalArticle",
    "date": "2015-08-00 8/2015",
    "venue": "",
    "abstract": "The solution of the inverse kinematics problem of soft manipulators is essential to generate paths in the task space. The inverse kinematics problem of constant curvature or piecewise constant curvature manipulators has already been solved by using different methods, which include closed-form analytical approaches and iterative methods based on the Jacobian method. On the other hand, the inverse kinematics problem of nonconstant curvature manipulators remains unsolved. This study represents one ",
    "url": "http://ieeexplore.ieee.org/document/7112506/",
    "category": "软体机器人",
    "collections": [
      "软体机器人"
    ],
    "pdfPath": "D:/zotero/storage/67/Giorelli 等 - 2015 - Neural Network and Jacobian Method for Solving the Inverse Statics of a Cable-Driven Soft Arm With N.pdf"
  },
  {
    "id": "paper-72",
    "title": "Nonparametric Online Learning Control for Soft Continuum Robot: An Enabling Technique for Effective Endoscopic Navigation",
    "authors": "Lee Kit-Hang, Fu Denny K.C., Leong Martin C.W., et al.",
    "type": "journalArticle",
    "date": "2017-12-00 12/2017",
    "venue": "",
    "abstract": "Bioinspired robotic structures comprising soft actuation units have attracted increasing research interest. Taking advantage of its inherent compliance, soft robots can assure safe interaction with external environments, provided that precise and effective manipulation could be achieved. Endoscopy is a typical application. However, previous model-based control approaches often require simpliﬁed geometric assumptions on the soft manipulator, but which could be very inaccurate in the presence of u",
    "url": "https://www.liebertpub.com/doi/10.1089/soro.2016.0065",
    "category": "软体机器人",
    "collections": [
      "软体机器人"
    ],
    "pdfPath": "D:/zotero/storage/71/Lee 等 - 2017 - Nonparametric Online Learning Control for Soft Continuum Robot An Enabling Technique for Effective.pdf"
  },
  {
    "id": "paper-74",
    "title": "OpenVLA: An Open-Source Vision-Language-Action Model",
    "authors": "Kim Moo Jin, Pertsch Karl, Karamcheti Siddharth, et al.",
    "type": "preprint",
    "date": "2024-09-05 2024-09-05",
    "venue": "",
    "abstract": "Large policies pretrained on a combination of Internet-scale vision-language data and diverse robot demonstrations have the potential to change how we teach robots new skills: rather than training new behaviors from scratch, we can fine-tune such vision-language-action (VLA) models to obtain robust, generalizable policies for visuomotor control. Yet, widespread adoption of VLAs for robotics has been challenging as 1) existing VLAs are largely closed and inaccessible to the public, and 2) prior w",
    "url": "http://arxiv.org/abs/2406.09246",
    "category": "具身智能",
    "collections": [
      "具身智能"
    ],
    "pdfPath": "D:/zotero/storage/73/Kim 等 - 2024 - OpenVLA An Open-Source Vision-Language-Action Model.pdf"
  }
];

const PAPER_CATEGORIES = {
  "双足机器人": {
    "count": 8,
    "types": [
      "conferencePaper",
      "journalArticle",
      "preprint"
    ]
  },
  "港大教授论文": {
    "count": 5,
    "types": [
      "journalArticle",
      "preprint"
    ]
  },
  "已读论文": {
    "count": 6,
    "types": [
      "bookSection",
      "conferencePaper",
      "journalArticle"
    ]
  },
  "课程论文": {
    "count": 6,
    "types": [
      "conferencePaper",
      "journalArticle",
      "preprint"
    ]
  },
  "软体机器人": {
    "count": 4,
    "types": [
      "journalArticle"
    ]
  },
  "其他机器人": {
    "count": 2,
    "types": [
      "journalArticle",
      "preprint"
    ]
  },
  "具身智能": {
    "count": 1,
    "types": [
      "preprint"
    ]
  }
};

const LEARNING_MATERIALS = [
  {
    "name": "带孔矩形板.x_t",
    "type": "Parasolid模型",
    "size": 5997,
    "sizeFormatted": "5.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第一课/几何模型/带孔矩形板.x_t",
    "relPath": "ANSYS学习素材/第一课/几何模型/带孔矩形板.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第一课"
  },
  {
    "name": "第一课.pdf",
    "type": "PDF",
    "size": 1625850,
    "sizeFormatted": "1.6 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第一课/PPT/第一课.pdf",
    "relPath": "ANSYS学习素材/第一课/PPT/第一课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第一课"
  },
  {
    "name": "第七课.pdf",
    "type": "PDF",
    "size": 1162080,
    "sizeFormatted": "1.1 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第七课/PPT/第七课.pdf",
    "relPath": "ANSYS学习素材/第七课/PPT/第七课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第七课"
  },
  {
    "name": "虎钳.x_t",
    "type": "Parasolid模型",
    "size": 34681,
    "sizeFormatted": "33.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第七课/几何模型/虎钳.x_t",
    "relPath": "ANSYS学习素材/第七课/几何模型/虎钳.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第七课"
  },
  {
    "name": "L bracket无圆角.x_t",
    "type": "Parasolid模型",
    "size": 7415,
    "sizeFormatted": "7.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第三课/几何模型/L bracket无圆角.x_t",
    "relPath": "ANSYS学习素材/第三课/几何模型/L bracket无圆角.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第三课"
  },
  {
    "name": "第三课.pdf",
    "type": "PDF",
    "size": 995278,
    "sizeFormatted": "972.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第三课/PPT/第三课.pdf",
    "relPath": "ANSYS学习素材/第三课/PPT/第三课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第三课"
  },
  {
    "name": "第九课.pdf",
    "type": "PDF",
    "size": 1277041,
    "sizeFormatted": "1.2 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第九课/PPT/第九课.pdf",
    "relPath": "ANSYS学习素材/第九课/PPT/第九课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第九课"
  },
  {
    "name": "虎钳.x_t",
    "type": "Parasolid模型",
    "size": 34681,
    "sizeFormatted": "33.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第九课/几何模型/虎钳.x_t",
    "relPath": "ANSYS学习素材/第九课/几何模型/虎钳.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第九课"
  },
  {
    "name": "梁完整.SLDPRT.x_t",
    "type": "Parasolid模型",
    "size": 18677,
    "sizeFormatted": "18.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十一课/梁完整.SLDPRT.x_t",
    "relPath": "ANSYS学习素材/第二十一课/梁完整.SLDPRT.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十一课"
  },
  {
    "name": "第二十一课.pdf",
    "type": "PDF",
    "size": 1115976,
    "sizeFormatted": "1.1 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十一课/第二十一课.pdf",
    "relPath": "ANSYS学习素材/第二十一课/第二十一课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十一课"
  },
  {
    "name": "直齿轮装配原始.x_t",
    "type": "Parasolid模型",
    "size": 771114,
    "sizeFormatted": "753.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课/直齿轮装配原始.x_t",
    "relPath": "ANSYS学习素材/第二十七课/直齿轮装配原始.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课"
  },
  {
    "name": "直齿轮装配已分割.x_t",
    "type": "Parasolid模型",
    "size": 791540,
    "sizeFormatted": "773.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课/直齿轮装配已分割.x_t",
    "relPath": "ANSYS学习素材/第二十七课/直齿轮装配已分割.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课"
  },
  {
    "name": "第二十七课.pdf",
    "type": "PDF",
    "size": 4519816,
    "sizeFormatted": "4.3 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课/第二十七课.pdf",
    "relPath": "ANSYS学习素材/第二十七课/第二十七课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课"
  },
  {
    "name": "直齿轮装配原始.x_t",
    "type": "Parasolid模型",
    "size": 771114,
    "sizeFormatted": "753.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课(1)/直齿轮装配原始.x_t",
    "relPath": "ANSYS学习素材/第二十七课(1)/直齿轮装配原始.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课(1)"
  },
  {
    "name": "直齿轮装配已分割.x_t",
    "type": "Parasolid模型",
    "size": 791540,
    "sizeFormatted": "773.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课(1)/直齿轮装配已分割.x_t",
    "relPath": "ANSYS学习素材/第二十七课(1)/直齿轮装配已分割.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课(1)"
  },
  {
    "name": "第二十七课.pdf",
    "type": "PDF",
    "size": 4519816,
    "sizeFormatted": "4.3 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十七课(1)/第二十七课.pdf",
    "relPath": "ANSYS学习素材/第二十七课(1)/第二十七课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十七课(1)"
  },
  {
    "name": "第二十三课.pdf",
    "type": "PDF",
    "size": 840521,
    "sizeFormatted": "820.8 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十三课/第二十三课.pdf",
    "relPath": "ANSYS学习素材/第二十三课/第二十三课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十三课"
  },
  {
    "name": "第二十二课.pdf",
    "type": "PDF",
    "size": 925343,
    "sizeFormatted": "903.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十二课/第二十二课.pdf",
    "relPath": "ANSYS学习素材/第二十二课/第二十二课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十二课"
  },
  {
    "name": "平面接触无间隙.x_t",
    "type": "Parasolid模型",
    "size": 11495,
    "sizeFormatted": "11.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十五课/平面接触无间隙.x_t",
    "relPath": "ANSYS学习素材/第二十五课/平面接触无间隙.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十五课"
  },
  {
    "name": "平面接触有间隙.x_t",
    "type": "Parasolid模型",
    "size": 11513,
    "sizeFormatted": "11.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十五课/平面接触有间隙.x_t",
    "relPath": "ANSYS学习素材/第二十五课/平面接触有间隙.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十五课"
  },
  {
    "name": "曲面接触.x_t",
    "type": "Parasolid模型",
    "size": 9277,
    "sizeFormatted": "9.1 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十五课/曲面接触.x_t",
    "relPath": "ANSYS学习素材/第二十五课/曲面接触.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十五课"
  },
  {
    "name": "第二十五课.pdf",
    "type": "PDF",
    "size": 1120615,
    "sizeFormatted": "1.1 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十五课/第二十五课.pdf",
    "relPath": "ANSYS学习素材/第二十五课/第二十五课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十五课"
  },
  {
    "name": "第二十六课.pdf",
    "type": "PDF",
    "size": 1096620,
    "sizeFormatted": "1.0 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十六课/第二十六课.pdf",
    "relPath": "ANSYS学习素材/第二十六课/第二十六课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十六课"
  },
  {
    "name": "赫兹接触.x_t",
    "type": "Parasolid模型",
    "size": 11340,
    "sizeFormatted": "11.1 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十六课/赫兹接触.x_t",
    "relPath": "ANSYS学习素材/第二十六课/赫兹接触.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十六课"
  },
  {
    "name": "梁.x_t",
    "type": "Parasolid模型",
    "size": 12478,
    "sizeFormatted": "12.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十四课/梁.x_t",
    "relPath": "ANSYS学习素材/第二十四课/梁.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十四课"
  },
  {
    "name": "第二十四课.pdf",
    "type": "PDF",
    "size": 751489,
    "sizeFormatted": "733.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十四课/第二十四课.pdf",
    "relPath": "ANSYS学习素材/第二十四课/第二十四课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十四课"
  },
  {
    "name": "桌子小物体.x_t",
    "type": "Parasolid模型",
    "size": 28412,
    "sizeFormatted": "27.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十课/几何模型/桌子小物体.x_t",
    "relPath": "ANSYS学习素材/第二十课/几何模型/桌子小物体.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二十课"
  },
  {
    "name": "第二十课.pdf",
    "type": "PDF",
    "size": 1015691,
    "sizeFormatted": "991.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二十课/PPT/第二十课.pdf",
    "relPath": "ANSYS学习素材/第二十课/PPT/第二十课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二十课"
  },
  {
    "name": "L bracket无圆角.x_t",
    "type": "Parasolid模型",
    "size": 7415,
    "sizeFormatted": "7.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二课/几何模型/L bracket无圆角.x_t",
    "relPath": "ANSYS学习素材/第二课/几何模型/L bracket无圆角.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第二课"
  },
  {
    "name": "第二课.pdf",
    "type": "PDF",
    "size": 1058142,
    "sizeFormatted": "1.0 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第二课/PPT/第二课.pdf",
    "relPath": "ANSYS学习素材/第二课/PPT/第二课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第二课"
  },
  {
    "name": "第五课.pdf",
    "type": "PDF",
    "size": 894001,
    "sizeFormatted": "873.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第五课/第五课.pdf",
    "relPath": "ANSYS学习素材/第五课/第五课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第五课"
  },
  {
    "name": "带孔矩形板.x_t",
    "type": "Parasolid模型",
    "size": 5997,
    "sizeFormatted": "5.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第八课/几何模型/带孔矩形板.x_t",
    "relPath": "ANSYS学习素材/第八课/几何模型/带孔矩形板.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第八课"
  },
  {
    "name": "第八课.pdf",
    "type": "PDF",
    "size": 913113,
    "sizeFormatted": "891.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第八课/PPT/第八课.pdf",
    "relPath": "ANSYS学习素材/第八课/PPT/第八课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第八课"
  },
  {
    "name": "支架.x_t",
    "type": "Parasolid模型",
    "size": 49478,
    "sizeFormatted": "48.3 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第六课/几何模型/支架.x_t",
    "relPath": "ANSYS学习素材/第六课/几何模型/支架.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第六课"
  },
  {
    "name": "第六课.pdf",
    "type": "PDF",
    "size": 833139,
    "sizeFormatted": "813.6 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第六课/PPT/第六课.pdf",
    "relPath": "ANSYS学习素材/第六课/PPT/第六课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第六课"
  },
  {
    "name": "L型支架装配.x_t",
    "type": "Parasolid模型",
    "size": 28104,
    "sizeFormatted": "27.4 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十一课/几何模型/L型支架装配.x_t",
    "relPath": "ANSYS学习素材/第十一课/几何模型/L型支架装配.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十一课"
  },
  {
    "name": "带孔矩形板圣维南原理.x_t",
    "type": "Parasolid模型",
    "size": 23450,
    "sizeFormatted": "22.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十一课/几何模型/带孔矩形板圣维南原理.x_t",
    "relPath": "ANSYS学习素材/第十一课/几何模型/带孔矩形板圣维南原理.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十一课"
  },
  {
    "name": "第十一课.pdf",
    "type": "PDF",
    "size": 985611,
    "sizeFormatted": "962.5 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十一课/PPT/第十一课.pdf",
    "relPath": "ANSYS学习素材/第十一课/PPT/第十一课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十一课"
  },
  {
    "name": "水杯带桌面.x_t",
    "type": "Parasolid模型",
    "size": 9337,
    "sizeFormatted": "9.1 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十三课/几何模型/水杯带桌面.x_t",
    "relPath": "ANSYS学习素材/第十三课/几何模型/水杯带桌面.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十三课"
  },
  {
    "name": "第十三课.pdf",
    "type": "PDF",
    "size": 946565,
    "sizeFormatted": "924.4 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十三课/PPT/第十三课.pdf",
    "relPath": "ANSYS学习素材/第十三课/PPT/第十三课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十三课"
  },
  {
    "name": "桌子小物体.x_t",
    "type": "Parasolid模型",
    "size": 28412,
    "sizeFormatted": "27.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十九课/几何模型/桌子小物体.x_t",
    "relPath": "ANSYS学习素材/第十九课/几何模型/桌子小物体.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十九课"
  },
  {
    "name": "第十九课.pdf",
    "type": "PDF",
    "size": 2790827,
    "sizeFormatted": "2.7 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十九课/PPT/第十九课.pdf",
    "relPath": "ANSYS学习素材/第十九课/PPT/第十九课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十九课"
  },
  {
    "name": "水杯带桌面.x_t",
    "type": "Parasolid模型",
    "size": 9337,
    "sizeFormatted": "9.1 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十五课/几何模型/水杯带桌面.x_t",
    "relPath": "ANSYS学习素材/第十五课/几何模型/水杯带桌面.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十五课"
  },
  {
    "name": "第十五课.pdf",
    "type": "PDF",
    "size": 928692,
    "sizeFormatted": "906.9 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十五课/PPT/第十五课.pdf",
    "relPath": "ANSYS学习素材/第十五课/PPT/第十五课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十五课"
  },
  {
    "name": "桌子小物体.x_t",
    "type": "Parasolid模型",
    "size": 28412,
    "sizeFormatted": "27.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十八课/几何模型/桌子小物体.x_t",
    "relPath": "ANSYS学习素材/第十八课/几何模型/桌子小物体.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十八课"
  },
  {
    "name": "第十八课.pdf",
    "type": "PDF",
    "size": 895712,
    "sizeFormatted": "874.7 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十八课/PPT/第十八课.pdf",
    "relPath": "ANSYS学习素材/第十八课/PPT/第十八课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十八课"
  },
  {
    "name": "L bracket圆角.x_t",
    "type": "Parasolid模型",
    "size": 8423,
    "sizeFormatted": "8.2 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十六课/几何模型/L bracket圆角.x_t",
    "relPath": "ANSYS学习素材/第十六课/几何模型/L bracket圆角.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十六课"
  },
  {
    "name": "带孔矩形板二分之一.x_t",
    "type": "Parasolid模型",
    "size": 7216,
    "sizeFormatted": "7.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十六课/几何模型/带孔矩形板二分之一.x_t",
    "relPath": "ANSYS学习素材/第十六课/几何模型/带孔矩形板二分之一.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十六课"
  },
  {
    "name": "第十六课.pdf",
    "type": "PDF",
    "size": 1089110,
    "sizeFormatted": "1.0 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十六课/PPT/第十六课.pdf",
    "relPath": "ANSYS学习素材/第十六课/PPT/第十六课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十六课"
  },
  {
    "name": "水杯带桌面.x_t",
    "type": "Parasolid模型",
    "size": 9337,
    "sizeFormatted": "9.1 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十四课/几何模型/水杯带桌面.x_t",
    "relPath": "ANSYS学习素材/第十四课/几何模型/水杯带桌面.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十四课"
  },
  {
    "name": "第十四课.pdf",
    "type": "PDF",
    "size": 977316,
    "sizeFormatted": "954.4 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十四课/PPT/第十四课.pdf",
    "relPath": "ANSYS学习素材/第十四课/PPT/第十四课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十四课"
  },
  {
    "name": "L型支架装配.x_t",
    "type": "Parasolid模型",
    "size": 28104,
    "sizeFormatted": "27.4 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十课/几何模型/L型支架装配.x_t",
    "relPath": "ANSYS学习素材/第十课/几何模型/L型支架装配.x_t",
    "category": "ANSYS仿真",
    "subcategory": "第十课"
  },
  {
    "name": "第十课.pdf",
    "type": "PDF",
    "size": 1278487,
    "sizeFormatted": "1.2 MB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第十课/PPT/第十课.pdf",
    "relPath": "ANSYS学习素材/第十课/PPT/第十课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第十课"
  },
  {
    "name": "第四课.pdf",
    "type": "PDF",
    "size": 973809,
    "sizeFormatted": "951.0 KB",
    "path": "E:/杂项/个人资料/学习/ANSYS学习素材/第四课/PPT/第四课.pdf",
    "relPath": "ANSYS学习素材/第四课/PPT/第四课.pdf",
    "category": "ANSYS仿真",
    "subcategory": "第四课"
  },
  {
    "name": "小抽屉.SLDPRT",
    "type": "SolidWorks零件",
    "size": 52751,
    "sizeFormatted": "51.5 KB",
    "path": "E:/杂项/个人资料/学习/抽屉/小抽屉.SLDPRT",
    "relPath": "抽屉/小抽屉.SLDPRT",
    "category": "CAD建模",
    "subcategory": "SolidWorks"
  },
  {
    "name": "底座.SLDPRT",
    "type": "SolidWorks零件",
    "size": 101387,
    "sizeFormatted": "99.0 KB",
    "path": "E:/杂项/个人资料/学习/风扇/底座.SLDPRT",
    "relPath": "风扇/底座.SLDPRT",
    "category": "CAD建模",
    "subcategory": "SolidWorks"
  },
  {
    "name": "抽屉.SLDPRT",
    "type": "SolidWorks零件",
    "size": 178856,
    "sizeFormatted": "174.7 KB",
    "path": "E:/杂项/个人资料/学习/抽屉/抽屉.SLDPRT",
    "relPath": "抽屉/抽屉.SLDPRT",
    "category": "CAD建模",
    "subcategory": "SolidWorks"
  },
  {
    "name": "桌下抽屉.SLDASM",
    "type": "SolidWorks装配体",
    "size": 103787,
    "sizeFormatted": "101.4 KB",
    "path": "E:/杂项/个人资料/学习/抽屉/桌下抽屉.SLDASM",
    "relPath": "抽屉/桌下抽屉.SLDASM",
    "category": "CAD建模",
    "subcategory": "SolidWorks"
  },
  {
    "name": "零件2.SLDPRT",
    "type": "SolidWorks零件",
    "size": 60047,
    "sizeFormatted": "58.6 KB",
    "path": "E:/杂项/个人资料/学习/抽屉/零件2.SLDPRT",
    "relPath": "抽屉/零件2.SLDPRT",
    "category": "CAD建模",
    "subcategory": "SolidWorks"
  },
  {
    "name": "031-赵睿-1203.pptx",
    "type": "PPT",
    "size": 6890187,
    "sizeFormatted": "6.6 MB",
    "path": "E:/杂项/个人资料/学习/031-赵睿-1203.pptx",
    "relPath": "031-赵睿-1203.pptx",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "031号-赵睿-1203.pdf",
    "type": "PDF",
    "size": 979938,
    "sizeFormatted": "957.0 KB",
    "path": "E:/杂项/个人资料/学习/031号-赵睿-1203.pdf",
    "relPath": "031号-赵睿-1203.pdf",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "LIDAR sensor.pptx",
    "type": "PPT",
    "size": 1673923,
    "sizeFormatted": "1.6 MB",
    "path": "E:/杂项/个人资料/学习/LIDAR sensor.pptx",
    "relPath": "LIDAR sensor.pptx",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "Latency-Tolerant Cloud-Edge.pdf",
    "type": "PDF",
    "size": 5573191,
    "sizeFormatted": "5.3 MB",
    "path": "E:/杂项/个人资料/学习/Latency-Tolerant Cloud-Edge.pdf",
    "relPath": "Latency-Tolerant Cloud-Edge.pdf",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "OpenVLA.pdf",
    "type": "PDF",
    "size": 13240309,
    "sizeFormatted": "12.6 MB",
    "path": "E:/杂项/个人资料/学习/OpenVLA.pdf",
    "relPath": "OpenVLA.pdf",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "ZhaoRui_R&D.pptx",
    "type": "PPT",
    "size": 4069000,
    "sizeFormatted": "3.9 MB",
    "path": "E:/杂项/个人资料/学习/ZhaoRui_R&D.pptx",
    "relPath": "ZhaoRui_R&D.pptx",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "pi07.pdf",
    "type": "PDF",
    "size": 5357105,
    "sizeFormatted": "5.1 MB",
    "path": "E:/杂项/个人资料/学习/pi07.pdf",
    "relPath": "pi07.pdf",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "华为笔试.docx",
    "type": "Word",
    "size": 103622,
    "sizeFormatted": "101.2 KB",
    "path": "E:/杂项/个人资料/学习/华为笔试.docx",
    "relPath": "华为笔试.docx",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "厦门航空地面岗位应聘报名表.doc",
    "type": "Word",
    "size": 78336,
    "sizeFormatted": "76.5 KB",
    "path": "E:/杂项/个人资料/学习/厦门航空地面岗位应聘报名表.doc",
    "relPath": "厦门航空地面岗位应聘报名表.doc",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "手机支架.SLDPRT",
    "type": "SolidWorks零件",
    "size": 351291,
    "sizeFormatted": "343.1 KB",
    "path": "E:/杂项/个人资料/学习/手机支架.SLDPRT",
    "relPath": "手机支架.SLDPRT",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "机械臂.SLDPRT",
    "type": "SolidWorks零件",
    "size": 88633,
    "sizeFormatted": "86.6 KB",
    "path": "E:/杂项/个人资料/学习/机械臂.SLDPRT",
    "relPath": "机械臂.SLDPRT",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "赵睿 part E.docx",
    "type": "Word",
    "size": 237277,
    "sizeFormatted": "231.7 KB",
    "path": "E:/杂项/个人资料/学习/赵睿 part E.docx",
    "relPath": "赵睿 part E.docx",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "香港大学课程.lnk",
    "type": "快捷方式",
    "size": 793,
    "sizeFormatted": "793 B",
    "path": "E:/杂项/个人资料/学习/香港大学课程.lnk",
    "relPath": "香港大学课程.lnk",
    "category": "其他",
    "subcategory": ""
  },
  {
    "name": "IMG_20241009_144527.jpg",
    "type": "图片",
    "size": 2632049,
    "sizeFormatted": "2.5 MB",
    "path": "E:/杂项/个人资料/学习/seminar/IMG_20241009_144527.jpg",
    "relPath": "seminar/IMG_20241009_144527.jpg",
    "category": "学术Seminar",
    "subcategory": "seminar"
  },
  {
    "name": "Report Template for Entrepreneurship Seminars.docx",
    "type": "Word",
    "size": 2648347,
    "sizeFormatted": "2.5 MB",
    "path": "E:/杂项/个人资料/学习/seminar/Report Template for Entrepreneurship Seminars.docx",
    "relPath": "seminar/Report Template for Entrepreneurship Seminars.docx",
    "category": "学术Seminar",
    "subcategory": "seminar"
  },
  {
    "name": "Report Template for Technical Visit (Company visit).docx",
    "type": "Word",
    "size": 16315,
    "sizeFormatted": "15.9 KB",
    "path": "E:/杂项/个人资料/学习/seminar/Report Template for Technical Visit (Company visit).docx",
    "relPath": "seminar/Report Template for Technical Visit (Company visit).docx",
    "category": "学术Seminar",
    "subcategory": "seminar"
  },
  {
    "name": "Report Template for Academic Seminars_webinar .docx",
    "type": "Word",
    "size": 283815,
    "sizeFormatted": "277.2 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术1/Report Template for Academic Seminars_webinar .docx",
    "relPath": "seminar/学术/学术1/Report Template for Academic Seminars_webinar .docx",
    "category": "学术Seminar",
    "subcategory": "学术1"
  },
  {
    "name": "Seminar - Prof Qi Ge SUSTech (2).pdf",
    "type": "PDF",
    "size": 308552,
    "sizeFormatted": "301.3 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术1/Seminar - Prof Qi Ge SUSTech (2).pdf",
    "relPath": "seminar/学术/学术1/Seminar - Prof Qi Ge SUSTech (2).pdf",
    "category": "学术Seminar",
    "subcategory": "学术1"
  },
  {
    "name": "屏幕截图 2024-10-09 104151.jpg",
    "type": "图片",
    "size": 265690,
    "sizeFormatted": "259.5 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术1/屏幕截图 2024-10-09 104151.jpg",
    "relPath": "seminar/学术/学术1/屏幕截图 2024-10-09 104151.jpg",
    "category": "学术Seminar",
    "subcategory": "学术1"
  },
  {
    "name": "Report  for Academic Seminars_webinar.docx",
    "type": "Word",
    "size": 162404,
    "sizeFormatted": "158.6 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术2/Report  for Academic Seminars_webinar.docx",
    "relPath": "seminar/学术/学术2/Report  for Academic Seminars_webinar.docx",
    "category": "学术Seminar",
    "subcategory": "学术2"
  },
  {
    "name": "mmexport1739944833177.jpg",
    "type": "图片",
    "size": 6366119,
    "sizeFormatted": "6.1 MB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术2/mmexport1739944833177.jpg",
    "relPath": "seminar/学术/学术2/mmexport1739944833177.jpg",
    "category": "学术Seminar",
    "subcategory": "学术2"
  },
  {
    "name": "屏幕截图 2025-02-20 100506.jpg",
    "type": "图片",
    "size": 144499,
    "sizeFormatted": "141.1 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术2/屏幕截图 2025-02-20 100506.jpg",
    "relPath": "seminar/学术/学术2/屏幕截图 2025-02-20 100506.jpg",
    "category": "学术Seminar",
    "subcategory": "学术2"
  },
  {
    "name": "IMG_20250306_152543.jpg",
    "type": "图片",
    "size": 2416318,
    "sizeFormatted": "2.3 MB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术3/IMG_20250306_152543.jpg",
    "relPath": "seminar/学术/学术3/IMG_20250306_152543.jpg",
    "category": "学术Seminar",
    "subcategory": "学术3"
  },
  {
    "name": "IMG_20250306_152945.jpg",
    "type": "图片",
    "size": 3198401,
    "sizeFormatted": "3.1 MB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术3/IMG_20250306_152945.jpg",
    "relPath": "seminar/学术/学术3/IMG_20250306_152945.jpg",
    "category": "学术Seminar",
    "subcategory": "学术3"
  },
  {
    "name": "Report  for Academic Seminars_webinar.docx",
    "type": "Word",
    "size": 5633296,
    "sizeFormatted": "5.4 MB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术3/Report  for Academic Seminars_webinar.docx",
    "relPath": "seminar/学术/学术3/Report  for Academic Seminars_webinar.docx",
    "category": "学术Seminar",
    "subcategory": "学术3"
  },
  {
    "name": "mmexport1740046191473.jpg",
    "type": "图片",
    "size": 202857,
    "sizeFormatted": "198.1 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术3/mmexport1740046191473.jpg",
    "relPath": "seminar/学术/学术3/mmexport1740046191473.jpg",
    "category": "学术Seminar",
    "subcategory": "学术3"
  },
  {
    "name": "Report  for Academic Seminars_webinar.docx",
    "type": "Word",
    "size": 304384,
    "sizeFormatted": "297.2 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术4/Report  for Academic Seminars_webinar.docx",
    "relPath": "seminar/学术/学术4/Report  for Academic Seminars_webinar.docx",
    "category": "学术Seminar",
    "subcategory": "学术4"
  },
  {
    "name": "屏幕截图 2025-04-10 163256.jpg",
    "type": "图片",
    "size": 286106,
    "sizeFormatted": "279.4 KB",
    "path": "E:/杂项/个人资料/学习/seminar/学术/学术4/屏幕截图 2025-04-10 163256.jpg",
    "relPath": "seminar/学术/学术4/屏幕截图 2025-04-10 163256.jpg",
    "category": "学术Seminar",
    "subcategory": "学术4"
  },
  {
    "name": "Assem1.JPG",
    "type": "图片",
    "size": 156287,
    "sizeFormatted": "152.6 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/Assem1.JPG",
    "relPath": "机械臂/Assem1.JPG",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "Assem1.SLDASM",
    "type": "SolidWorks装配体",
    "size": 900851,
    "sizeFormatted": "879.7 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/Assem1.SLDASM",
    "relPath": "机械臂/Assem1.SLDASM",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "BASE.SLDPRT",
    "type": "SolidWorks零件",
    "size": 911492,
    "sizeFormatted": "890.1 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/BASE.SLDPRT",
    "relPath": "机械臂/BASE.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "BigHorn.SLDPRT",
    "type": "SolidWorks零件",
    "size": 122345,
    "sizeFormatted": "119.5 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/BigHorn.SLDPRT",
    "relPath": "机械臂/BigHorn.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "BigServo.SLDPRT",
    "type": "SolidWorks零件",
    "size": 277186,
    "sizeFormatted": "270.7 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/BigServo.SLDPRT",
    "relPath": "机械臂/BigServo.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "GripArm.SLDPRT",
    "type": "SolidWorks零件",
    "size": 663103,
    "sizeFormatted": "647.6 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/GripArm.SLDPRT",
    "relPath": "机械臂/GripArm.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "Gripper.SLDPRT",
    "type": "SolidWorks零件",
    "size": 70598,
    "sizeFormatted": "68.9 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/Gripper.SLDPRT",
    "relPath": "机械臂/Gripper.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "ISO.jpg",
    "type": "图片",
    "size": 1771296,
    "sizeFormatted": "1.7 MB",
    "path": "E:/杂项/个人资料/学习/机械臂/ISO.jpg",
    "relPath": "机械臂/ISO.jpg",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "ISO2.jpg",
    "type": "图片",
    "size": 1600932,
    "sizeFormatted": "1.5 MB",
    "path": "E:/杂项/个人资料/学习/机械臂/ISO2.jpg",
    "relPath": "机械臂/ISO2.jpg",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "ISO3.jpg",
    "type": "图片",
    "size": 1676423,
    "sizeFormatted": "1.6 MB",
    "path": "E:/杂项/个人资料/学习/机械臂/ISO3.jpg",
    "relPath": "机械臂/ISO3.jpg",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "Project_Mass_and_Volume.JPG",
    "type": "图片",
    "size": 198296,
    "sizeFormatted": "193.6 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/Project_Mass_and_Volume.JPG",
    "relPath": "机械臂/Project_Mass_and_Volume.JPG",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "Robot_Arm.ino",
    "type": "Arduino代码",
    "size": 3281,
    "sizeFormatted": "3.2 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/Robot_Arm.ino",
    "relPath": "机械臂/Robot_Arm.ino",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "S3114_servo_CAD_Model.SLDPRT",
    "type": "SolidWorks零件",
    "size": 63274,
    "sizeFormatted": "61.8 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/S3114_servo_CAD_Model.SLDPRT",
    "relPath": "机械臂/S3114_servo_CAD_Model.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "SecondArm.SLDPRT",
    "type": "SolidWorks零件",
    "size": 747131,
    "sizeFormatted": "729.6 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/SecondArm.SLDPRT",
    "relPath": "机械臂/SecondArm.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  },
  {
    "name": "baseArm.SLDPRT",
    "type": "SolidWorks零件",
    "size": 398451,
    "sizeFormatted": "389.1 KB",
    "path": "E:/杂项/个人资料/学习/机械臂/baseArm.SLDPRT",
    "relPath": "机械臂/baseArm.SLDPRT",
    "category": "机械臂CAD模型",
    "subcategory": "SolidWorks"
  }
];

const LEARN_CATEGORIES = {
  "ANSYS仿真": {
    "count": 54,
    "files": 54
  },
  "CAD建模": {
    "count": 5,
    "files": 5
  },
  "其他": {
    "count": 13,
    "files": 13
  },
  "学术Seminar": {
    "count": 15,
    "files": 15
  },
  "机械臂CAD模型": {
    "count": 15,
    "files": 15
  }
};
