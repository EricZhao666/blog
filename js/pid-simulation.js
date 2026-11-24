/**
 * Batch 9C-1B：PID 控制系统交互实验室 —— 纯计算模块（无 IO、无存储、无定时器、确定性）
 *
 * 被控对象（一阶，详见 PID_CONTROL_MATH.md）：
 *   G(s) = K / (τs + 1)  ⇔  dy/dt = (K·u − y) / τ
 *   离散化采用零阶保持（ZOH）精确解：y[k+1] = a·y[k] + K·(1−a)·u[k]，a = exp(−dt/τ)。
 *   对分段常值 u 这是精确积分，不是欧拉近似；u 恒定时与解析阶跃响应 K·u·(1−e^(−t/τ)) 逐点一致。
 *
 * 离散 PID（位置式，可解释实现，不是把理想连续公式直接采样）：
 *   e[k] = r − y[k]
 *   P[k] = Kp·e[k]
 *   D[k] = (τf·D[k−1] − Kd·(y[k] − y[k−1])) / (τf + dt)   —— 对测量值求导（避免设定值突变的微分冲击），
 *          一阶低通滤波，τf = 5·dt（后向欧拉离散）
 *   I[k] = I[k−1] + Ki·e[k]·dt，抗饱和采用条件积分：
 *          若 (P+I_new+D) 超出限幅且 Ki·e 会把积分继续推向饱和方向，则冻结积分（I[k] = I[k−1]）
 *          注意：记录的 I[k] 是用于 u[k] 的积分值（含第 k 拍增量），故 I[0] = Ki·e[0]·dt（未冻结时）。
 *          已知行为：单步积分增量 Ki·e·dt 本身超过限幅幅值时，条件积分会从第一拍就冻结积分
 *          （极端参数下表现为无控制作用）；这是条件积分法的固有特性，演示常用参数范围内不会出现。
 *   u[k] = clamp(P[k] + I[k] + D[k], uMin, uMax)
 *
 * 状态初始化策略：每次 simulate 都是一次全新仿真（t=0，y=y0，I=0，D=0，yPrev=y0）；
 * 切换控制器模式不携带上一模式的积分/微分状态。模块本身无共享可变状态。
 *
 * 指标定义（step = r − y0，band = 2%·max(|r|,|y0|,1e-12)）：
 *   上升时间：归一化响应 (y−y0)/step 从 10% 到 90% 的时间（样本间线性插值）；未达到 90% → null。
 *   超调量：max(0, max((y−y0)/step) − 1)·100%。
 *   调节时间：最后一次离开 ±band 之后的首个采样时刻，且要求末尾 5% 样本全部在带内
 *             （防止持续振荡恰在终点落回带内被误判已稳定）；不满足 → null + settled:false，
 *             绝不编造调节时间。
 *   稳态误差：r − mean(末尾 5% 样本)。
 *
 * 数值契约：非法参数一律拒绝（ok:false），不产生 NaN 曲线；步数上限 MAX_STEPS；
 * 发散保护（|y| 超过 1e6·尺度即截断并标记 diverged）。可被 Node 直接 require。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MAX_STEPS = 20000;          // 单次仿真步数上限（duration/dt），防止无界计算
  var D_FILTER_FACTOR = 5;        // 微分低通时间常数 τf = 5·dt
  var DIVERGE_FACTOR = 1e6;       // 发散判定尺度
  var SETTLE_BAND = 0.02;         // 调节时间判据：±2%
  var MODES = ['none', 'manual', 'P', 'PI', 'PID'];

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 参数校验：全部字段有限且物理合法，否则拒绝（不产生 NaN / 误导性曲线）。 */
  function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: 'invalid-config', message: '配置必须是对象' };
    }
    var gains = { kp: cfg.kp, ki: cfg.ki, kd: cfg.kd };
    for (var g in gains) {
      if (!isFiniteNumber(gains[g]) || gains[g] < 0) {
        return { ok: false, error: 'invalid-gain', message: 'Kp/Ki/Kd 必须是有限的非负数字' };
      }
    }
    if (!isFiniteNumber(cfg.plantK) || cfg.plantK <= 0) {
      return { ok: false, error: 'invalid-plant', message: '对象增益 K 必须是有限正数' };
    }
    if (!isFiniteNumber(cfg.tau) || cfg.tau <= 0) {
      return { ok: false, error: 'invalid-plant', message: '时间常数 τ 必须是有限正数' };
    }
    if (!isFiniteNumber(cfg.setpoint)) {
      return { ok: false, error: 'invalid-setpoint', message: '设定值必须是有限数字' };
    }
    var y0 = cfg.y0 === undefined ? 0 : cfg.y0;
    if (!isFiniteNumber(y0)) {
      return { ok: false, error: 'invalid-y0', message: '初始输出 y0 必须是有限数字' };
    }
    if (!isFiniteNumber(cfg.dt) || cfg.dt <= 0) {
      return { ok: false, error: 'invalid-dt', message: '采样周期 dt 必须是有限正数' };
    }
    if (!isFiniteNumber(cfg.duration) || cfg.duration <= 0) {
      return { ok: false, error: 'invalid-duration', message: '仿真时长必须是有限正数' };
    }
    if (!isFiniteNumber(cfg.uMin) || !isFiniteNumber(cfg.uMax) || cfg.uMin >= cfg.uMax) {
      return { ok: false, error: 'invalid-limits', message: '控制限幅必须有限且 uMin < uMax' };
    }
    var mode = cfg.mode === undefined ? 'PID' : cfg.mode;
    if (MODES.indexOf(mode) === -1) {
      return { ok: false, error: 'invalid-mode', message: '模式必须是 none/manual/P/PI/PID' };
    }
    var u0 = cfg.u0 === undefined ? 0 : cfg.u0;
    if (!isFiniteNumber(u0)) {
      return { ok: false, error: 'invalid-u0', message: 'manual 模式输入 u0 必须是有限数字' };
    }
    var n = Math.round(cfg.duration / cfg.dt);
    if (n < 1) {
      return { ok: false, error: 'duration-too-short', message: '仿真时长至少包含一个采样步' };
    }
    if (n > MAX_STEPS) {
      return { ok: false, error: 'too-many-steps', message: '步数超过上限 ' + MAX_STEPS + '（减小 duration 或增大 dt）' };
    }
    return {
      ok: true,
      config: {
        kp: cfg.kp, ki: cfg.ki, kd: cfg.kd,
        plantK: cfg.plantK, tau: cfg.tau,
        setpoint: cfg.setpoint, y0: y0,
        dt: cfg.dt, duration: cfg.duration, n: n,
        uMin: cfg.uMin, uMax: cfg.uMax,
        mode: mode, u0: u0,
        antiWindup: cfg.antiWindup !== false
      }
    };
  }

  /** ZOH 离散系数 a = e^(−dt/τ)。 */
  function alpha(tau, dt) {
    return Math.exp(-dt / tau);
  }

  /** 一阶对象解析阶跃响应（恒值 u，零初始）：K·u·(1 − e^(−t/τ))。供数值对照。 */
  function analyticalStep(K, tau, u, t) {
    return K * u * (1 - Math.exp(-t / tau));
  }

  /** 仅 P 控制的闭环稳态值（离散平衡点精确解）：K·Kp·r / (1 + K·Kp)。 */
  function pOnlySteadyState(kp, K, r) {
    return K * kp * r / (1 + K * kp);
  }

  /** 时域指标。diverged 时全部为 null；未进入稳定带时 settling=null 且 settled=false。 */
  function computeMetrics(t, y, cfg, diverged) {
    var N = t.length - 1;
    var r = cfg.setpoint, y0 = cfg.y0;
    var step = r - y0;
    var band = SETTLE_BAND * Math.max(Math.abs(r), Math.abs(y0), 1e-12);
    var out = { rise: null, overshoot: null, settling: null, ess: null, settled: false, reason: null };

    if (diverged) {
      out.reason = 'diverged';
      return out;
    }

    // 稳态误差：末尾 5% 样本均值
    var tail = Math.max(1, Math.floor(0.05 * (N + 1)));
    var sum = 0;
    for (var k = N - tail + 1; k <= N; k++) sum += y[k];
    out.ess = r - sum / tail;

    // 调节时间：最后一次离开 ±band 之后的首个采样时刻；
    // 且末尾 5% 样本必须全部在带内（持续振荡即使终点落回带内也判未稳定）
    var lastOutside = -1;
    for (var j = N; j >= 0; j--) {
      if (Math.abs(y[j] - r) > band) { lastOutside = j; break; }
    }
    if (lastOutside === -1) {
      out.settling = 0;
      out.settled = true;
    } else if (lastOutside >= N - tail + 1) {
      out.settled = false;
      out.reason = 'not-settled-within-horizon';
    } else {
      out.settling = t[lastOutside + 1];
      out.settled = true;
    }

    if (Math.abs(step) < 1e-12) {
      out.overshoot = null;
      if (!out.reason) out.reason = 'no-step';
      return out;
    }

    // 超调量与上升时间（归一化响应 frac = (y − y0)/step）
    var fracMax = -Infinity;
    var t10 = null, t90 = null;
    var prevFrac = (y[0] - y0) / step;
    for (var i = 0; i <= N; i++) {
      var frac = (y[i] - y0) / step;
      if (frac > fracMax) fracMax = frac;
      if (t10 === null && frac >= 0.1) {
        t10 = i === 0 ? t[0] : t[i - 1] + (0.1 - prevFrac) / (frac - prevFrac) * (t[i] - t[i - 1]);
      }
      if (t90 === null && frac >= 0.9) {
        t90 = i === 0 ? t[0] : t[i - 1] + (0.9 - prevFrac) / (frac - prevFrac) * (t[i] - t[i - 1]);
      }
      prevFrac = frac;
    }
    out.overshoot = Math.max(0, fracMax - 1) * 100;
    if (t10 !== null && t90 !== null) {
      out.rise = t90 - t10;
    } else if (!out.reason) {
      out.reason = 'never-reached-90';
    }
    return out;
  }

  /**
   * 确定性仿真。成功返回完整采样序列与指标；非法参数返回 { ok:false, error, message }。
   * 序列长度 n+1（t=0..n·dt）；u[k] 为 [t_k, t_k+1) 期间施加的控制量，末点 u[n] 为计算值（不再施加）。
   */
  function simulate(cfg) {
    var v = validateConfig(cfg);
    if (!v.ok) return v;
    var c = v.config;

    var kp = (c.mode === 'P' || c.mode === 'PI' || c.mode === 'PID') ? c.kp : 0;
    var ki = (c.mode === 'PI' || c.mode === 'PID') ? c.ki : 0;
    var kd = (c.mode === 'PID') ? c.kd : 0;

    var a = alpha(c.tau, c.dt);
    var b = c.plantK * (1 - a);
    var tauF = D_FILTER_FACTOR * c.dt;
    var divergeLimit = DIVERGE_FACTOR * Math.max(1, Math.abs(c.setpoint), Math.abs(c.y0));

    var y = c.y0, yPrev = c.y0, I = 0, D = 0;
    var t = [], ys = [], us = [], rs = [], ps = [], is = [], ds = [], sats = [], raws = [];
    var diverged = false;
    var maxU = -Infinity, minU = Infinity, maxI = -Infinity, minI = Infinity;
    var maxD = -Infinity, minD = Infinity, satCount = 0;

    for (var k = 0; k <= c.n; k++) {
      var e = c.setpoint - y;
      var P = kp * e;
      // 对测量值求导 + 一阶低通（后向欧拉）；kd=0 时 D 恒为 0
      D = (tauF * D - kd * (y - yPrev)) / (tauF + c.dt);

      var uRaw, u, sat = false;
      if (c.mode === 'none') {
        uRaw = 0; u = 0;                       // 零控制输入（对象自由响应，测试用）
      } else if (c.mode === 'manual') {
        uRaw = c.u0; u = clamp(c.u0, c.uMin, c.uMax); sat = u !== uRaw;
      } else {
        var iNew = I + ki * e * c.dt;
        var probe = P + iNew + D;
        // 条件积分抗饱和：饱和且误差会把积分继续推向饱和方向时冻结积分
        if (c.antiWindup && ((probe > c.uMax && ki * e > 0) || (probe < c.uMin && ki * e < 0))) {
          iNew = I;
        }
        I = iNew;
        uRaw = P + I + D;
        u = clamp(uRaw, c.uMin, c.uMax);
        sat = uRaw > c.uMax || uRaw < c.uMin;
      }

      t.push(k * c.dt);
      ys.push(y); us.push(u); rs.push(c.setpoint);
      ps.push(P); is.push(I); ds.push(D); sats.push(sat); raws.push(uRaw);
      if (u > maxU) maxU = u;
      if (u < minU) minU = u;
      if (I > maxI) maxI = I;
      if (I < minI) minI = I;
      if (D > maxD) maxD = D;
      if (D < minD) minD = D;
      if (sat) satCount++;

      if (k < c.n) {
        var yNext = a * y + b * u;
        if (!isFinite(yNext) || Math.abs(yNext) > divergeLimit) {
          diverged = true;
          break;
        }
        yPrev = y;
        y = yNext;
      }
    }

    return {
      ok: true,
      config: c,
      n: t.length - 1,
      t: t, y: ys, u: us, r: rs,
      p: ps, i: is, d: ds,
      sat: sats, uRaw: raws,
      diverged: diverged,
      metrics: computeMetrics(t, ys, c, diverged),
      stats: {
        maxU: maxU, minU: minU,
        maxI: maxI, minI: minI,
        maxD: maxD, minD: minD,
        satCount: satCount
      }
    };
  }

  var api = {
    VERSION: VERSION,
    MAX_STEPS: MAX_STEPS,
    D_FILTER_FACTOR: D_FILTER_FACTOR,
    SETTLE_BAND: SETTLE_BAND,
    MODES: MODES,
    validateConfig: validateConfig,
    alpha: alpha,
    analyticalStep: analyticalStep,
    pOnlySteadyState: pOnlySteadyState,
    simulate: simulate
  };

  global.PidSimulation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);