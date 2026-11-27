# 梯形与七段 S 曲线运动轨迹规划数学说明（Batch 9C-2D）

本文件记录 [js/motion-profile.js](js/motion-profile.js) 所实现的单轴点对点（Rest-to-Rest：$v_0 = v_1 = 0,\; a_0 = a_1 = 0$）运动轨迹规划数学模型、退化条件与数值残差口径。

---

## 1. 参数与符号约定

- 起点 $q_0$、终点 $q_1$，有向位移 $D = q_1 - q_0$，路程 $L = |D|$，方向 $s = \operatorname{sign}(D) \in \{+1, -1\}$。
- 运动学约束（均为有限正实数）：
  - 最大速度 $v_{\max} > 0$
  - 最大加速度 $a_{\max} > 0$
  - 最大加加速度（Jerk）$j_{\max} > 0$（仅 S 曲线使用；梯形规划加加速度为理想冲激）
- 当 $L = 0$ 时，返回零位移退化状态（$T = 0,\; q(t) \equiv q_0,\; v(t) \equiv 0,\; a(t) \equiv 0$）。

---

## 2. 三段梯形速度规划（Trapezoidal）

临界位移：
$$L_{\text{crit}} = \frac{v_{\max}^2}{a_{\max}}$$

1. **三段梯形（$L \ge L_{\text{crit}}$）**：
   $$T_a = T_d = \frac{v_{\max}}{a_{\max}}, \qquad T_v = \frac{L - L_{\text{crit}}}{v_{\max}}, \qquad v_{\text{peak}} = v_{\max}$$
2. **二段三角形退化（$L < L_{\text{crit}}$）**：
   $$v_{\text{peak}} = \sqrt{L \cdot a_{\max}} < v_{\max}, \qquad T_a = T_d = \frac{v_{\text{peak}}}{a_{\max}}, \qquad T_v = 0$$

总时长 $T = T_a + T_v + T_d$。

---

## 3. 七段对称 S 曲线规划（7-Segment S-Curve）

对称七段由加加速（$+j_{\max}$，时长 $T_j$）、匀加速（$0$，时长 $T_c$）、减加速（$-j_{\max}$，时长 $T_j$）、匀速巡航（$0$，时长 $T_v$）以及对称的减速三段组成。

### 3.1 达到 $v_{\max}$ 的临界判断

- 若 $v_{\max} j_{\max} \ge a_{\max}^2$，达到 $v_{\max}$ 前必然先达到 $a_{\max}$：
  $$L_{\text{full}} = v_{\max}\left(\frac{v_{\max}}{a_{\max}} + \frac{a_{\max}}{j_{\max}}\right)$$
- 若 $v_{\max} j_{\max} < a_{\max}^2$，达到 $v_{\max}$ 时仍未达到 $a_{\max}$（$T_c = 0$）：
  $$L_{\text{full}} = 2 v_{\max} \sqrt{\frac{v_{\max}}{j_{\max}}}$$

### 3.2 全退化工况分类

1. **工况 A：$L \ge L_{\text{full}}$（达到 $v_{\max}$）**：
   - 若 $v_{\max} j_{\max} \ge a_{\max}^2$：$T_j = \frac{a_{\max}}{j_{\max}}$，$T_c = \frac{v_{\max}}{a_{\max}} - T_j$，$T_v = \frac{L - L_{\text{full}}}{v_{\max}}$。
     - $T_c > 0,\; T_v > 0 \implies$ **完整七段**（`7-seg-full`）
     - $T_c > 0,\; T_v = 0 \implies$ **六段临界**（`6-seg-boundary`）
   - 若 $v_{\max} j_{\max} < a_{\max}^2$：$T_j = \sqrt{\frac{v_{\max}}{j_{\max}}}$，$T_c = 0$，$T_v = \frac{L - L_{\text{full}}}{v_{\max}}$。
     - $T_v > 0 \implies$ **五段退化**（`5-seg-no-const-acc`）
     - $T_v = 0 \implies$ **四段临界**（`4-seg-boundary`）

2. **工况 B：$L < L_{\text{full}}$（无巡航段，$T_v = 0$，未达 $v_{\max}$）**：
   达到 $a_{\max}$ 的最小位移阈值为：
   $$L_{a,\text{thresh}} = \frac{2 a_{\max}^3}{j_{\max}^2}$$
   - **六段退化（$L \ge L_{a,\text{thresh}}$，`6-seg-no-cruise`）**：
     $T_j = \frac{a_{\max}}{j_{\max}}$，令 $u = T_j + T_c$，由对称面积 $L = a_{\max} u (u + T_j)$ 解得：
     $$u = \frac{-T_j + \sqrt{T_j^2 + \frac{4L}{a_{\max}}}}{2}, \qquad T_c = u - T_j \ge 0$$
     $a_{\text{peak}} = a_{\max}$，$v_{\text{peak}} = a_{\max} u < v_{\max}$。
   - **四段退化（$L < L_{a,\text{thresh}}$，`4-seg-jerk-only`）**：
     既未达 $a_{\max}$ 也未达 $v_{\max}$，$T_c = 0,\; T_v = 0$，由 $L = 2 j_{\max} T_j^3$ 得：
     $$T_j = \left(\frac{L}{2 j_{\max}}\right)^{1/3}, \qquad a_{\text{peak}} = j_{\max} T_j < a_{\max}, \qquad v_{\text{peak}} = j_{\max} T_j^2 < v_{\max}$$

---

## 4. 分段递推与未修正终点残差

各段起点状态 $(t_k, p_k, v_k, a_k)$ 由前一段闭式多项式精确递推：
$$a(\tau) = a_k + J_k \tau, \quad v(\tau) = v_k + a_k \tau + \frac{1}{2} J_k \tau^2, \quad p(\tau) = p_k + v_k \tau + \frac{1}{2} a_k \tau^2 + \frac{1}{6} J_k \tau^3$$
终点处 `rawEndPos = q0 + s * p(T)`、`rawEndVel = s * v(T)`、`rawEndAcc = s * a(T)` **不做任何强制归零或夹取**，直接记录并展示真实数值残差：
$$\varepsilon_q = |q_{\text{raw}}(T) - q_1|, \qquad \varepsilon_v = |v_{\text{raw}}(T)|, \qquad \varepsilon_a = |a_{\text{raw}}(T)|$$
