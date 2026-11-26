/* 卡尔曼滤波与传感器融合 —— 纯计算模块（无 DOM、无 IO、确定性、可 Node require）
 *
 * 范围：
 *   A. 一维标量随机游走模型（状态维数 1、空间维数 1）
 *   B. 二维位置—速度恒速模型（状态维数 2、空间维数 1：单个位置坐标）
 *
 * 明确不实现 EKF / UKF / SLAM / 三维仿真。
 *
 * 约定：
 *   - Q、R 一律为**方差**，不是标准差；σ_a 为加速度标准差（方差 = σ_a²）。
 *   - 标量：x⁺=x⁻，P⁺=P⁻+Q；K=P⁺/(P⁺+R)；x=x⁺+K(z−x⁺)；P=(1−K)P⁺。
 *   - 二维：F=[[1,dt],[0,1]]，G=[dt²/2, dt]ᵀ，Q=σ_a²·G·Gᵀ（逐区间独立随机恒定加速度）。
 *     不使用连续白噪声加速度的 Q=σ²[[dt³/3, dt²/2],[dt²/2, dt]]，两者不可混用。
 *   - 协方差更新使用 Joseph 形式：P=(I−KH)P(I−KH)ᵀ+KRKᵀ。
 *     不做"遇到不对称就强行对称化/截断"的掩盖式修补。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MAX_STEPS = 2000;
  var MAX_ABS = 1e12;

  var DEFAULTS = {
    scalar: { x0: 1, p0: 1, q: 0.05, r: 0.5 },
    matrix: { p0: 0, v0: 0, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2, gate: 0 }
  };

  // ---------------------------------------------------------------- 工具

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  /** xorshift32：只用位移与异或，跨引擎结果完全一致。 */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5); s >>>= 0;
      return s / 4294967296;
    };
  }

  /** Box–Muller 标准正态；不缓存 spare，保证调用顺序即序列。 */
  function gaussian(rng) {
    var u1 = Math.max(rng(), 1e-12);
    var u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function mul2(A, B) {
    return [
      [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
      [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]
    ];
  }

  function add2(A, B) {
    return [
      [A[0][0] + B[0][0], A[0][1] + B[0][1]],
      [A[1][0] + B[1][0], A[1][1] + B[1][1]]
    ];
  }

  function transpose2(A) {
    return [[A[0][0], A[1][0]], [A[0][1], A[1][1]]];
  }

  function symmetryError(P) {
    return Math.abs(P[0][1] - P[1][0]);
  }

  /** 2×2 半正定 + 对称检查（相对容差 1e-10，这是检验而不是修补）。 */
  function isPSD2(P) {
    if (!P || !isNum(P[0][0]) || !isNum(P[0][1]) || !isNum(P[1][0]) || !isNum(P[1][1])) return false;
    var scale = Math.max(1, Math.abs(P[0][0]), Math.abs(P[1][1]), Math.abs(P[0][1]));
    if (symmetryError(P) > 1e-10 * scale) return false;
    var tr = P[0][0] + P[1][1];
    var det = P[0][0] * P[1][1] - P[0][1] * P[1][0];
    return tr >= -1e-10 * scale && det >= -1e-10 * scale * scale;
  }

  // ---------------------------------------------------------------- 教学场景（合成数据）

  var SCENARIO_SPECS = [
    {
      id: 'constant', name: '恒定状态', dt: 0.5, steps: 60, seed: 101,
      sigmaPos: 0.4, sigmaVel: 0.2, missingPos: null, missingVel: null,
      truth: function () { return { pos: 10, vel: 0 }; },
      note: '真实状态恒为 10.000，速度 0。仅用于观察噪声与协方差收敛，过程本身没有动态。'
    },
    {
      id: 'cruise', name: '恒速运动', dt: 0.5, steps: 60, seed: 202,
      sigmaPos: 0.5, sigmaVel: 0.25, missingPos: null, missingVel: null,
      truth: function (t) { return { pos: 1 + 1.2 * t, vel: 1.2 }; },
      note: '位置 = 1.000 + 1.200·t，速度恒为 1.200。二维模型应明显优于标量随机游走。'
    },
    {
      id: 'accel', name: '加速（模型失配）', dt: 0.5, steps: 80, seed: 303,
      sigmaPos: 0.4, sigmaVel: 0.2, missingPos: null, missingVel: null,
      truth: function (t) {
        var t0 = 8;
        if (t <= t0) return { pos: 0.5 + 1.0 * t, vel: 1.0 };
        var d = t - t0;
        return { pos: 0.5 + 1.0 * t + 0.5 * 0.4 * d * d, vel: 1.0 + 0.4 * d };
      },
      note: '第 8 秒起以 0.4 m/s² 加速。恒速模型出现持续滞后，误差与创新均值同时变大（模型失配）。'
    },
    {
      id: 'missing', name: '测量缺失与恢复', dt: 0.5, steps: 90, seed: 404,
      sigmaPos: 0.4, sigmaVel: 0.2, missingPos: [25, 40], missingVel: [50, 62],
      truth: function (t) { return { pos: 2 + 0.8 * t, vel: 0.8 }; },
      note: '位置测量在第 25–40 步缺失、速度测量在第 50–62 步缺失。缺失期间只做预测，协方差持续增大。'
    }
  ];

  var SCENARIO_CACHE = {};

  function inWindow(k, w) {
    return !!w && k >= w[0] && k <= w[1];
  }

  /**
   * 生成（并缓存）固定场景：真实轨迹 + 测量噪声序列。
   * 测量只由场景种子决定，**与滤波器 Q/R 无关**：
   * 修改滤波器参数不会改变同一场景的真实轨迹与测量序列。
   */
  function scenarioData(id) {
    if (SCENARIO_CACHE[id]) return SCENARIO_CACHE[id];
    var spec = null;
    for (var i = 0; i < SCENARIO_SPECS.length; i++) {
      if (SCENARIO_SPECS[i].id === id) spec = SCENARIO_SPECS[i];
    }
    if (!spec) return null;
    var rng = makeRng(spec.seed);
    var steps = [];
    for (var k = 0; k < spec.steps; k++) {
      var t = round3(k * spec.dt);
      var tr = spec.truth(t);
      var missP = inWindow(k, spec.missingPos);
      var missV = inWindow(k, spec.missingVel);
      steps.push({
        k: k,
        t: t,
        truePos: tr.pos,
        trueVel: tr.vel,
        zPos: missP ? null : round3(tr.pos + spec.sigmaPos * gaussian(rng)),
        zVel: missV ? null : round3(tr.vel + spec.sigmaVel * gaussian(rng)),
        missingPos: missP,
        missingVel: missV
      });
    }
    var data = {
      id: spec.id, name: spec.name, note: spec.note,
      dt: spec.dt, steps: steps,
      sigmaPos: spec.sigmaPos, sigmaVel: spec.sigmaVel,
      synthetic: true,
      seed: spec.seed
    };
    SCENARIO_CACHE[id] = data;
    return data;
  }

  function scenarioList() {
    return SCENARIO_SPECS.map(function (s) {
      return { id: s.id, name: s.name, note: s.note, steps: s.steps, dt: s.dt, synthetic: true };
    });
  }

  // ---------------------------------------------------------------- 一维标量（随机游走）

  function validateScalar(cfg) {
    if (!cfg) return { ok: false, error: 'invalid-config', message: '缺少标量滤波参数。' };
    if (!isNum(cfg.x0)) return { ok: false, error: 'invalid-state', message: '初始状态必须是有限数字。' };
    if (!isNum(cfg.p0) || cfg.p0 < 0) return { ok: false, error: 'invalid-covariance', message: '初始协方差 P0 必须是 ≥ 0 的有限数字。' };
    if (!isNum(cfg.q) || cfg.q < 0) return { ok: false, error: 'invalid-q', message: '过程噪声方差 Q 必须是 ≥ 0 的有限数字（不是标准差）。' };
    if (!isNum(cfg.r) || cfg.r <= 0) return { ok: false, error: 'invalid-r', message: '测量噪声方差 R 必须 > 0（不是标准差）；R=0 时增益退化为 1，测量被无条件信任。' };
    if (Math.abs(cfg.x0) > MAX_ABS || cfg.p0 > MAX_ABS || cfg.q > MAX_ABS || cfg.r > MAX_ABS) {
      return { ok: false, error: 'out-of-range', message: '参数绝对值超过 1e12，已拒绝计算。' };
    }
    return { ok: true };
  }

  function createScalarFilter(cfg) {
    var v = validateScalar(cfg);
    if (!v.ok) return v;
    return { ok: true, x: cfg.x0, p: cfg.p0 };
  }

  function scalarPredict(f, q) {
    if (!f || !isNum(f.x) || !isNum(f.p)) return { ok: false, error: 'invalid-filter', message: '滤波器状态无效。' };
    if (!isNum(q) || q < 0) return { ok: false, error: 'invalid-q', message: 'Q 必须是 ≥ 0 的有限数字。' };
    return { ok: true, x: f.x, p: f.p + q };
  }

  function scalarUpdate(f, z, r) {
    if (!f || !isNum(f.x) || !isNum(f.p)) return { ok: false, error: 'invalid-filter', message: '滤波器状态无效。' };
    if (!isNum(r) || r <= 0) return { ok: false, error: 'invalid-r', message: 'R 必须 > 0。' };
    var s = f.p + r;
    var k = f.p / s;
    var innovation = z - f.x;
    var x = f.x + k * innovation;
    var p = (1 - k) * f.p;
    return { ok: true, x: x, p: p, gain: k, innovation: innovation, s: s };
  }

  /**
   * 标量序列：每一步 预测 →（有测量则）更新。
   * opts: {scenario|steps, x0,p0,q,r, gate}
   */
  function runScalar(opts) {
    var o = opts || {};
    var v = validateScalar({ x0: o.x0, p0: o.p0, q: o.q, r: o.r });
    if (!v.ok) return v;
    var src = o.steps || (o.scenario ? scenarioData(o.scenario).steps : null);
    if (!src || !src.length) return { ok: false, error: 'invalid-data', message: '缺少测量序列。' };
    if (src.length > MAX_STEPS) return { ok: false, error: 'too-many-steps', message: '样本数超过上限 ' + MAX_STEPS + '。' };
    var gate = o.gate === undefined ? 0 : o.gate;
    if (!isNum(gate) || gate < 0) return { ok: false, error: 'invalid-gate', message: '创新门限必须 ≥ 0（0 表示关闭）。' };

    var x = o.x0, p = o.p0;
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      // 初始状态与首个观测处于同一时刻 t0：第 0 步不注入过程噪声，
      // 从第 1 步（t0+dt）开始才做 x⁻=x、P⁻=P+Q 的预测。
      var xPred = x, pPred = i === 0 ? p : p + o.q;
      var z = s.zPos;
      var rec = {
        k: s.k, t: s.t,
        truePos: s.truePos, trueVel: null,
        zPos: z, zVel: null,
        predPos: xPred, predP: pPred,
        pos: xPred, p: pPred,
        gain: null, innovation: null, s: null,
        updated: false, gated: false, missing: z === null || z === undefined
      };
      if (!rec.missing) {
        var inn = z - xPred;
        var ss = pPred + o.r;
        if (gate > 0 && Math.abs(inn) > gate * Math.sqrt(ss)) {
          rec.gated = true;
        } else {
          var k = pPred / ss;
          xPred = xPred + k * inn;
          pPred = (1 - k) * pPred;
          rec.gain = k;
          rec.innovation = inn;
          rec.innovationPos = inn;
          rec.s = ss;
          rec.sPos = ss;
          rec.updated = true;
        }
      }
      x = xPred; p = pPred;
      rec.pos = x; rec.p = p;
      out.push(rec);
    }
    var sceneMetaS = o.scenario ? scenarioData(o.scenario) : null;
    return {
      ok: true, steps: out, metrics: metricsScalar(out), mode: 'scalar',
      dtActual: sceneMetaS ? sceneMetaS.dt : null,
      dtAssumed: null,
      dtMismatch: false,
      warnings: []
    };
  }

  // ---------------------------------------------------------------- 二维位置—速度

  function validateMatrix(cfg) {
    if (!cfg) return { ok: false, error: 'invalid-config', message: '缺少二维滤波参数。' };
    var keys = ['p0', 'v0', 'p0Var', 'v0Var', 'sigmaA', 'dt', 'rPos', 'rVel'];
    for (var i = 0; i < keys.length; i++) {
      if (!isNum(cfg[keys[i]])) {
        return { ok: false, error: 'invalid-param', message: keys[i] + ' 必须是有限数字。' };
      }
    }
    if (!(cfg.dt > 0)) return { ok: false, error: 'invalid-dt', message: '采样周期 dt 必须 > 0。' };
    if (cfg.p0Var < 0 || cfg.v0Var < 0) return { ok: false, error: 'invalid-covariance', message: '初始协方差必须 ≥ 0。' };
    if (cfg.sigmaA < 0) return { ok: false, error: 'invalid-q', message: '加速度标准差 σ_a 必须 ≥ 0（过程噪声方差 = σ_a²）。' };
    if (cfg.rPos <= 0 || cfg.rVel <= 0) return { ok: false, error: 'invalid-r', message: '位置/速度测量噪声方差必须 > 0。' };
    if (Math.abs(cfg.p0) > MAX_ABS || Math.abs(cfg.v0) > MAX_ABS ||
        cfg.p0Var > MAX_ABS || cfg.v0Var > MAX_ABS || cfg.sigmaA > 1e6 || cfg.dt > 1e6 ||
        cfg.rPos > MAX_ABS || cfg.rVel > MAX_ABS) {
      return { ok: false, error: 'out-of-range', message: '参数超出允许范围。' };
    }
    return { ok: true };
  }

  function createFilter2D(cfg) {
    var v = validateMatrix(cfg);
    if (!v.ok) return v;
    var P = [[cfg.p0Var, 0], [0, cfg.v0Var]];
    if (!isPSD2(P)) return { ok: false, error: 'invalid-covariance', message: '初始协方差必须是半正定对称矩阵。' };
    return { ok: true, x: [cfg.p0, cfg.v0], P: P };
  }

  /** 恒速预测：x←F x，P←F P Fᵀ + σ_a²·G·Gᵀ。 */
  function predict2D(f, cfg) {
    if (!f || !Array.isArray(f.x) || !Array.isArray(f.P)) {
      return { ok: false, error: 'invalid-filter', message: '滤波器状态无效。' };
    }
    if (!isNum(cfg.dt) || cfg.dt <= 0) return { ok: false, error: 'invalid-dt', message: 'dt 必须 > 0。' };
    if (!isNum(cfg.sigmaA) || cfg.sigmaA < 0) return { ok: false, error: 'invalid-q', message: 'σ_a 必须 ≥ 0。' };
    var dt = cfg.dt;
    var F = [[1, dt], [0, 1]];
    var G = [dt * dt / 2, dt];
    var qa = cfg.sigmaA * cfg.sigmaA;
    var Q = [
      [qa * G[0] * G[0], qa * G[0] * G[1]],
      [qa * G[1] * G[0], qa * G[1] * G[1]]
    ];
    var nx = [f.x[0] + dt * f.x[1], f.x[1]];
    var FP = mul2(F, f.P);
    var nP = add2(mul2(FP, transpose2(F)), Q);
    return { ok: true, x: nx, P: nP, F: F, G: G, Q: Q };
  }

  /** 单传感器更新（Joseph 形式）。idx: 0=位置, 1=速度。 */
  function update2D(f, cfg) {
    if (!f || !Array.isArray(f.x) || !Array.isArray(f.P)) {
      return { ok: false, error: 'invalid-filter', message: '滤波器状态无效。' };
    }
    var idx = cfg.idx;
    if (idx !== 0 && idx !== 1) return { ok: false, error: 'invalid-sensor', message: '传感器索引必须是 0（位置）或 1（速度）。' };
    if (!isNum(cfg.z)) return { ok: false, error: 'invalid-measurement', message: '测量值必须是有限数字。' };
    if (!isNum(cfg.r) || cfg.r <= 0) return { ok: false, error: 'invalid-r', message: '测量噪声方差必须 > 0。' };
    var h = idx === 0 ? [1, 0] : [0, 1];
    var P = f.P, x = f.x;
    var PHt = [
      P[0][0] * h[0] + P[0][1] * h[1],
      P[1][0] * h[0] + P[1][1] * h[1]
    ];
    var s = h[0] * PHt[0] + h[1] * PHt[1] + cfg.r;
    var K = [PHt[0] / s, PHt[1] / s];
    var innovation = cfg.z - (h[0] * x[0] + h[1] * x[1]);
    var nx = [x[0] + K[0] * innovation, x[1] + K[1] * innovation];
    // Joseph: P = (I−KH)P(I−KH)ᵀ + K R Kᵀ
    var A = [[1 - K[0] * h[0], -K[0] * h[1]], [-K[1] * h[0], 1 - K[1] * h[1]]];
    var APA = mul2(mul2(A, P), transpose2(A));
    var KRK = [
      [K[0] * cfg.r * K[0], K[0] * cfg.r * K[1]],
      [K[1] * cfg.r * K[0], K[1] * cfg.r * K[1]]
    ];
    return { ok: true, x: nx, P: add2(APA, KRK), K: K, innovation: innovation, s: s };
  }

  /** 联合更新（位置+速度同时到达）：H=I、R=diag(rPos,rVel)，仍用 Joseph。 */
  function updateJoint2D(f, cfg) {
    if (!f || !Array.isArray(f.x) || !Array.isArray(f.P)) {
      return { ok: false, error: 'invalid-filter', message: '滤波器状态无效。' };
    }
    if (!isNum(cfg.zPos) || !isNum(cfg.zVel)) return { ok: false, error: 'invalid-measurement', message: '联合更新需要位置与速度两个测量。' };
    if (!isNum(cfg.rPos) || cfg.rPos <= 0 || !isNum(cfg.rVel) || cfg.rVel <= 0) {
      return { ok: false, error: 'invalid-r', message: '测量噪声方差必须 > 0。' };
    }
    var P = f.P;
    var S = [[P[0][0] + cfg.rPos, P[0][1]], [P[1][0], P[1][1] + cfg.rVel]];
    var det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (Math.abs(det) < 1e-300) return { ok: false, error: 'singular', message: '联合更新协方差矩阵奇异。' };
    var Si = [[S[1][1] / det, -S[0][1] / det], [-S[1][0] / det, S[0][0] / det]];
    var K = mul2(P, Si);
    var innov = [cfg.zPos - f.x[0], cfg.zVel - f.x[1]];
    var nx = [
      f.x[0] + K[0][0] * innov[0] + K[0][1] * innov[1],
      f.x[1] + K[1][0] * innov[0] + K[1][1] * innov[1]
    ];
    var A = [[1 - K[0][0], -K[0][1]], [-K[1][0], 1 - K[1][1]]];
    var APA = mul2(mul2(A, P), transpose2(A));
    var rp = cfg.rPos, rv = cfg.rVel;
    var KRK = [
      [K[0][0] * rp * K[0][0] + K[0][1] * rv * K[0][1], K[0][0] * rp * K[1][0] + K[0][1] * rv * K[1][1]],
      [K[1][0] * rp * K[0][0] + K[1][1] * rv * K[0][1], K[1][0] * rp * K[1][0] + K[1][1] * rv * K[1][1]]
    ];
    return { ok: true, x: nx, P: add2(APA, KRK), K: K, innovation: innov, S: S };
  }

  /**
   * 二维序列。sensors 可单独开关；同一时刻两个测量默认**顺序更新**（先位置后速度），
   * 对角 R 下与联合更新数值等价（测试 M10.x 验证）。
   */
  function run2D(opts) {
    var o = opts || {};
    var v = validateMatrix({
      p0: o.p0, v0: o.v0, p0Var: o.p0Var, v0Var: o.v0Var,
      sigmaA: o.sigmaA, dt: o.dt, rPos: o.rPos, rVel: o.rVel
    });
    if (!v.ok) return v;
    var src = o.steps || (o.scenario ? scenarioData(o.scenario).steps : null);
    if (!src || !src.length) return { ok: false, error: 'invalid-data', message: '缺少测量序列。' };
    if (src.length > MAX_STEPS) return { ok: false, error: 'too-many-steps', message: '样本数超过上限 ' + MAX_STEPS + '。' };
    var sensors = o.sensors || { pos: true, vel: true };
    var gate = o.gate === undefined ? 0 : o.gate;
    if (!isNum(gate) || gate < 0) return { ok: false, error: 'invalid-gate', message: '创新门限必须 ≥ 0。' };

    var x = [o.p0, o.v0];
    var P = [[o.p0Var, 0], [0, o.v0Var]];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      var dt = o.dt;
      var F = [[1, dt], [0, 1]];
      var qa = o.sigmaA * o.sigmaA;
      var Q = [
        [qa * Math.pow(dt, 4) / 4, qa * Math.pow(dt, 3) / 2],
        [qa * Math.pow(dt, 3) / 2, qa * dt * dt]
      ];
      // 第 0 步：初始状态与首个观测同在 t0，直接以先验做更新（不推进 dt）。
      // 第 1..n-1 步：先从 t(k-1) 预测到 t(k)=t(k-1)+dt，再更新。
      var xPred, PPred;
      if (i === 0) {
        xPred = [x[0], x[1]];
        PPred = [[P[0][0], P[0][1]], [P[1][0], P[1][1]]];
      } else {
        xPred = [x[0] + dt * x[1], x[1]];
        PPred = add2(mul2(mul2(F, P), transpose2(F)), Q);
      }

      var rec = {
        k: s.k, t: s.t,
        truePos: s.truePos, trueVel: s.trueVel,
        zPos: sensors.pos ? s.zPos : null,
        zVel: sensors.vel ? s.zVel : null,
        predPos: xPred[0], predVel: xPred[1],
        predP00: PPred[0][0], predP11: PPred[1][1],
        pos: xPred[0], vel: xPred[1], P: PPred,
        gainPos: null, gainVel: null,
        innovationPos: null, innovationVel: null,
        sPos: null, sVel: null,
        updatedPos: false, updatedVel: false,
        gatedPos: false, gatedVel: false,
        missingPos: !sensors.pos || s.zPos === null || s.zPos === undefined,
        missingVel: !sensors.vel || s.zVel === null || s.zVel === undefined
      };

      var cur = { x: xPred, P: PPred };
      // 位置
      if (!rec.missingPos) {
        var innP = s.zPos - cur.x[0];
        var sP = cur.P[0][0] + o.rPos;
        if (gate > 0 && Math.abs(innP) > gate * Math.sqrt(sP)) {
          rec.gatedPos = true;
        } else {
          var upP = update2D(cur, { idx: 0, z: s.zPos, r: o.rPos });
          if (!upP.ok) return upP;
          cur = { x: upP.x, P: upP.P };
          rec.gainPos = upP.K[0];
          rec.kGainVelFromPos = upP.K[1];
          rec.innovationPos = upP.innovation;
          rec.sPos = upP.s;
          rec.updatedPos = true;
        }
      }
      // 速度
      if (!rec.missingVel) {
        var innV = s.zVel - cur.x[1];
        var sV = cur.P[1][1] + o.rVel;
        if (gate > 0 && Math.abs(innV) > gate * Math.sqrt(sV)) {
          rec.gatedVel = true;
        } else {
          var upV = update2D(cur, { idx: 1, z: s.zVel, r: o.rVel });
          if (!upV.ok) return upV;
          cur = { x: upV.x, P: upV.P };
          rec.gainVel = upV.K[1];
          rec.innovationVel = upV.innovation;
          rec.sVel = upV.s;
          rec.updatedVel = true;
        }
      }
      x = cur.x; P = cur.P;
      rec.pos = x[0]; rec.vel = x[1]; rec.P = P;
      rec.updated = rec.updatedPos || rec.updatedVel;
      out.push(rec);
    }
    var sceneMeta = o.scenario ? scenarioData(o.scenario) : null;
    var dtActual = sceneMeta ? sceneMeta.dt : null;
    var dtMismatch = !!sceneMeta && Math.abs(sceneMeta.dt - o.dt) > 1e-12;
    var warnings = [];
    if (dtMismatch) {
      warnings.push('采样时间不一致：场景真实 dt=' + dtActual + '，滤波器假设 dt=' + o.dt +
        '。这属于模型失配，估计与协方差不可按真实时间解读。');
    }
    return {
      ok: true, steps: out, metrics: metrics2D(out), mode: 'matrix',
      dtActual: dtActual, dtAssumed: o.dt, dtMismatch: dtMismatch, warnings: warnings
    };
  }

  // ---------------------------------------------------------------- 指标

  function errStats(errs) {
    if (!errs.length) return { n: 0, rmse: null, mae: null, maxAbs: null };
    var se = 0, ae = 0, mx = 0;
    for (var i = 0; i < errs.length; i++) {
      var e = errs[i];
      se += e * e;
      ae += Math.abs(e);
      if (Math.abs(e) > mx) mx = Math.abs(e);
    }
    return {
      n: errs.length,
      rmse: Math.sqrt(se / errs.length),
      mae: ae / errs.length,
      maxAbs: mx
    };
  }

  function metricsScalar(steps) {
    var posErr = [], posErrValid = [], raw = [], valid = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      posErr.push(s.pos - s.truePos);
      if (s.zPos !== null && s.zPos !== undefined) {
        valid++;
        raw.push(s.zPos - s.truePos);              // 只用有测量的索引，缺失不当作 0
        posErrValid.push(s.pos - s.truePos);       // 与 raw 同索引的估计误差
      }
    }
    return {
      pos: { est: errStats(posErr), estValid: errStats(posErrValid), raw: errStats(raw) },
      vel: {
        est: { n: 0, rmse: null, mae: null, maxAbs: null },
        estValid: { n: 0, rmse: null, mae: null, maxAbs: null },
        raw: { n: 0, rmse: null, mae: null, maxAbs: null }
      },
      counts: { total: steps.length, validPos: valid, missingPos: steps.length - valid, validVel: 0, missingVel: steps.length }
    };
  }

  function metrics2D(steps) {
    var posErr = [], velErr = [], rawP = [], rawV = [], estPValid = [], estVValid = [];
    var validP = 0, validV = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      posErr.push(s.pos - s.truePos);
      velErr.push(s.vel - s.trueVel);
      if (s.zPos !== null && s.zPos !== undefined) {
        validP++; rawP.push(s.zPos - s.truePos); estPValid.push(s.pos - s.truePos);
      }
      if (s.zVel !== null && s.zVel !== undefined) {
        validV++; rawV.push(s.zVel - s.trueVel); estVValid.push(s.vel - s.trueVel);
      }
    }
    return {
      pos: { est: errStats(posErr), estValid: errStats(estPValid), raw: errStats(rawP) },
      vel: { est: errStats(velErr), estValid: errStats(estVValid), raw: errStats(rawV) },
      counts: {
        total: steps.length,
        validPos: validP, missingPos: steps.length - validP,
        validVel: validV, missingVel: steps.length - validV
      }
    };
  }

  /**
   * 置信带：均值 ± z·sqrt(P)。
   * 这是**模型置信区间**（线性高斯假设），不保证覆盖真实值。
   */
  function confidenceBand(mean, variance, z) {
    if (!isNum(mean) || !isNum(variance) || variance < 0) return { ok: false, lower: null, upper: null };
    var zz = isNum(z) ? z : 1.96;
    var half = zz * Math.sqrt(variance);
    return { ok: true, lower: mean - half, upper: mean + half, z: zz };
  }

  var api = {
    VERSION: VERSION,
    MAX_STEPS: MAX_STEPS,
    DEFAULTS: DEFAULTS,
    scenarioList: scenarioList,
    scenarioData: scenarioData,
    validateScalar: validateScalar,
    createScalarFilter: createScalarFilter,
    scalarPredict: scalarPredict,
    scalarUpdate: scalarUpdate,
    runScalar: runScalar,
    validateMatrix: validateMatrix,
    createFilter2D: createFilter2D,
    predict2D: predict2D,
    update2D: update2D,
    updateJoint2D: updateJoint2D,
    run2D: run2D,
    metricsScalar: metricsScalar,
    metrics2D: metrics2D,
    confidenceBand: confidenceBand,
    symmetryError: symmetryError,
    isPSD2: isPSD2
  };

  global.KalmanCalculation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
