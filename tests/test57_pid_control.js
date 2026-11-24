#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1B：PID 离散仿真数学专项（无浏览器，直接 require 真实 js/pid-simulation.js）
 *
 * 覆盖：参数校验 / 零控制输入与对象解析对照（ZOH 精确离散）/ 仅 P 稳态误差精确解 /
 * PI 消除阶跃误差及其适用条件（饱和时不成立）/ PID 参数效应 / 控制饱和限幅 /
 * 有无抗饱和对比 / 不同采样周期收敛性 / 指标定义（上升/超调/调节/稳态误差）/
 * 未稳定与无阶跃处理 / 确定性与模式切换状态初始化 / 数值保护与尺度不变性。
 *
 * 正确性判据全部是数值断言（解析对照、精确稳态解、不等式关系），不依赖任何图形。
 *
 * 用法：node tests/test57_pid_control.js
 */
const path = require('path');
const P = require(path.resolve(__dirname, '..', 'js', 'pid-simulation.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function near(a, b, eps) { return Math.abs(a - b) <= eps; }
const BASE = {
  kp: 1.2, ki: 0.8, kd: 0.15,
  plantK: 1, tau: 1, setpoint: 1, y0: 0,
  dt: 0.02, duration: 12, uMin: -2, uMax: 2,
  mode: 'PID', antiWindup: true
};
function cfg(over) { return Object.assign({}, BASE, over || {}); }
function sim(over) { return P.simulate(cfg(over)); }
function last(a) { return a[a.length - 1]; }
function allFinite(arr) { return arr.every(Number.isFinite); }

// ================================================================ M1 参数校验
{
  const bad = [
    [{ kp: NaN }, 'invalid-gain'],
    [{ ki: -1 }, 'invalid-gain'],
    [{ kd: Infinity }, 'invalid-gain'],
    [{ plantK: 0 }, 'invalid-plant'],
    [{ plantK: -2 }, 'invalid-plant'],
    [{ tau: 0 }, 'invalid-plant'],
    [{ tau: -1 }, 'invalid-plant'],
    [{ setpoint: NaN }, 'invalid-setpoint'],
    [{ y0: Infinity }, 'invalid-y0'],
    [{ dt: 0 }, 'invalid-dt'],
    [{ dt: -0.01 }, 'invalid-dt'],
    [{ duration: 0 }, 'invalid-duration'],
    [{ uMin: 2, uMax: 2 }, 'invalid-limits'],
    [{ uMin: 3, uMax: 2 }, 'invalid-limits'],
    [{ uMax: NaN }, 'invalid-limits'],
    [{ mode: 'PD' }, 'invalid-mode'],
    [{ u0: NaN }, 'invalid-u0'],
    [{ dt: 0.0001, duration: 30 }, 'too-many-steps'],
    [{ dt: 1, duration: 0.4 }, 'duration-too-short']
  ];
  let allRejected = true, detail = '';
  for (const [over, err] of bad) {
    const r = sim(over);
    if (r.ok !== false || r.error !== err) { allRejected = false; detail = JSON.stringify(over) + '→' + (r.error || 'ok'); break; }
  }
  check('M1.1 19 组非法参数全部拒绝且错误码正确', allRejected, detail || 'all rejected');
  check('M1.2 非对象配置拒绝', P.simulate(null).ok === false && P.simulate(42).error === 'invalid-config');
  const zeroGains = sim({ kp: 0, ki: 0, kd: 0, mode: 'PID' });
  check('M1.3 零增益合法：u≡0，y≡0（零初始）',
    zeroGains.ok && zeroGains.u.every(v => v === 0) && zeroGains.y.every(v => v === 0));
  const v = P.validateConfig(cfg());
  check('M1.4 默认配置校验通过且 n=duration/dt', v.ok && v.config.n === 600 && v.config.antiWindup === true);
}

// ================================================================ M2 对象离散与零输入
{
  const z = sim({ mode: 'none', y0: 0 });
  check('M2.1 零控制输入 + 零初始：y≡0，u≡0', z.ok && z.y.every(v => v === 0) && z.u.every(v => v === 0));

  const decay = sim({ mode: 'none', y0: 2, duration: 10 });
  let dErr = 0;
  for (let k = 0; k < decay.t.length; k++) dErr = Math.max(dErr, Math.abs(decay.y[k] - 2 * Math.exp(-decay.t[k])));
  check('M2.2 零输入自由响应 = y0·e^(−t/τ)（ZOH 精确，误差 <1e-12）', dErr < 1e-12, 'maxErr=' + dErr.toExponential(2));

  const step = sim({ mode: 'manual', u0: 1, duration: 20, dt: 0.001 });
  let sErr = 0;
  for (let k = 0; k < step.t.length; k++) sErr = Math.max(sErr, Math.abs(step.y[k] - P.analyticalStep(1, 1, 1, step.t[k])));
  check('M2.3 恒值 u=1 阶跃：逐点匹配解析解 K·u·(1−e^(−t/τ))（<1e-12）', sErr < 1e-12, 'maxErr=' + sErr.toExponential(2));

  const step2 = sim({ mode: 'manual', u0: 0.7, plantK: 2, tau: 0.5, duration: 8, dt: 0.002 });
  let s2Err = 0;
  for (let k = 0; k < step2.t.length; k++) s2Err = Math.max(s2Err, Math.abs(step2.y[k] - P.analyticalStep(2, 0.5, 0.7, step2.t[k])));
  check('M2.4 不同 K/τ/u0 组合仍逐点匹配解析解', s2Err < 1e-12, 'maxErr=' + s2Err.toExponential(2));

  const clamped = sim({ mode: 'manual', u0: 5, uMax: 2 });
  check('M2.5 manual 输入超限被限幅：u≡2', clamped.u.every(v => v === 2));

  const one = sim({ mode: 'manual', u0: 1, y0: 0.3, dt: 0.05, duration: 1 });
  const a = Math.exp(-0.05);
  check('M2.6 单步递推 y[1]=a·y0+K(1−a)·u0 精确成立',
    near(one.y[1], a * 0.3 + (1 - a) * 1, 1e-14) && near(P.alpha(1, 0.05), a, 1e-15));
}

// ================================================================ M3 仅 P 控制
{
  const p = sim({ mode: 'P', kp: 2, ki: 0, kd: 0, duration: 60 });
  check('M3.1 P 稳态误差 = r/(1+K·Kp) = 1/3（离散平衡点精确解，<1e-9）',
    near(p.metrics.ess, 1 / 3, 1e-9), 'ess=' + p.metrics.ess);
  check('M3.2 P 稳态值 = K·Kp·r/(1+K·Kp)',
    near(last(p.y), P.pOnlySteadyState(2, 1, 1), 1e-9));

  const p2 = sim({ mode: 'P', kp: 0.5, plantK: 3, setpoint: 2, duration: 60 });
  check('M3.3 不同 K/r：ess = 2/(1+3·0.5) = 0.8', near(p2.metrics.ess, 0.8, 1e-9), 'ess=' + p2.metrics.ess);

  let mono = true;
  for (let k = 1; k < p.y.length; k++) if (p.y[k] < p.y[k - 1] - 1e-12) mono = false;
  check('M3.4 一阶对象 + P：响应单调无超调；ess=1/3 超出 ±2% 带 → 按定义未稳定（不编造调节时间）',
    mono && p.metrics.overshoot === 0 && p.metrics.settled === false &&
    p.metrics.settling === null && p.metrics.reason === 'not-settled-within-horizon');
  const pHigh = sim({ mode: 'P', kp: 60, ki: 0, kd: 0, dt: 0.005, duration: 10 });
  check('M3.5 高增益 P（ess=1/61≈0.016<2% 带，细采样单调）：已稳定且上升时间有定义',
    pHigh.metrics.settled && pHigh.metrics.rise !== null && pHigh.metrics.rise > 0,
    'rise=' + pHigh.metrics.rise);
}

// ================================================================ M4 PI 控制
{
  const pi = sim({ mode: 'PI', kp: 1, ki: 0.5, kd: 0, duration: 60 });
  check('M4.1 PI（闭环稳定、未饱和）消除阶跃稳态误差：|ess|<1e-6',
    Math.abs(pi.metrics.ess) < 1e-6 && pi.metrics.settled, 'ess=' + pi.metrics.ess.toExponential(2));
  check('M4.2 PI 稳态控制量 u = r/K = 1', near(last(pi.u), 1, 1e-6), 'uF=' + last(pi.u));

  const piSat = sim({ mode: 'PI', kp: 1, ki: 0.5, kd: 0, uMax: 0.5, uMin: -0.5, duration: 60 });
  check('M4.3 PI 适用条件反例：持续饱和（uMax=0.5<r/K）时误差无法消除，ess≈0.5',
    near(piSat.metrics.ess, 0.5, 1e-6) && near(last(piSat.y), 0.5, 1e-6), 'ess=' + piSat.metrics.ess);

  const piNeg = sim({ mode: 'PI', kp: 1, ki: 0.5, kd: 0, setpoint: -1, duration: 60 });
  check('M4.4 负设定值：yFinal≈−1，ess≈0，控制量为负且在限幅内',
    near(last(piNeg.y), -1, 1e-6) && Math.abs(piNeg.metrics.ess) < 1e-6 && last(piNeg.u) < 0 &&
    piNeg.stats.minU >= -2 - 1e-12);
}

// ================================================================ M5 PID 参数效应与分项
{
  // 快对象（τ=0.1）+ 积分主导回路：Kd 减缓上升（对测量值求导，上升段 D<0 压低控制量）
  const FB = { plantK: 1, tau: 0.1, setpoint: 1, y0: 0, dt: 0.005, duration: 5, uMin: -10, uMax: 10, kp: 1, ki: 20 };
  const noD = P.simulate(Object.assign({}, FB, { kd: 0 }));
  const withD = P.simulate(Object.assign({}, FB, { kd: 0.3 }));
  check('M5.1 Kd 减缓上升：rise(kd=0.3) > rise(kd=0)',
    withD.metrics.rise > noD.metrics.rise,
    noD.metrics.rise.toFixed(3) + ' → ' + withD.metrics.rise.toFixed(3));
  check('M5.2 积分主导回路中 Kd 可增大超调（上升变慢→积分积累更多）：不承诺 PID 优于 PI',
    withD.metrics.overshoot > noD.metrics.overshoot && noD.metrics.overshoot > 0,
    noD.metrics.overshoot.toFixed(2) + '% → ' + withD.metrics.overshoot.toFixed(2) + '%');

  const slow = sim({ mode: 'P', kp: 20, ki: 0, kd: 0, duration: 5, uMin: -50, uMax: 50 });
  const fast = sim({ mode: 'P', kp: 40, ki: 0, kd: 0, duration: 5, uMin: -50, uMax: 50 });
  check('M5.3 未饱和高增益 P：增大 Kp 加快上升 rise(kp=40) < rise(kp=20)',
    slow.metrics.rise !== null && fast.metrics.rise !== null && fast.metrics.rise < slow.metrics.rise,
    slow.metrics.rise.toFixed(4) + ' → ' + fast.metrics.rise.toFixed(4));

  check('M5.4 kd=0 → D 恒为 0；ki=0 → I 恒为 0',
    noD.d.every(v => v === 0) && sim({ ki: 0 }).i.every(v => v === 0));
  const pOnly = sim({ mode: 'P' });
  check('M5.5 模式 P：I≡0 且 D≡0（Ki/Kd 被模式屏蔽）',
    pOnly.i.every(v => v === 0) && pOnly.d.every(v => v === 0));
}

// ================================================================ M6 控制饱和
{
  const s = sim({ kp: 5, ki: 2, uMax: 0.5, uMin: -0.5, duration: 30 });
  check('M6.1 饱和时输出始终在限幅内',
    s.stats.maxU <= 0.5 + 1e-12 && s.stats.minU >= -0.5 - 1e-12,
    '[' + s.stats.minU + ', ' + s.stats.maxU + ']');
  let satConsistent = true;
  for (let k = 0; k < s.sat.length; k++) {
    const expect = s.uRaw[k] > 0.5 || s.uRaw[k] < -0.5;
    if (s.sat[k] !== expect) satConsistent = false;
  }
  check('M6.2 饱和标记与 uRaw 越限逐点一致，satCount>0', satConsistent && s.stats.satCount > 0, 'satCount=' + s.stats.satCount);
  check('M6.3 饱和下输出上界：yFinal ≤ K·uMax', last(s.y) <= 0.5 + 1e-9, 'yF=' + last(s.y));
}

// ================================================================ M7 积分抗饱和对比
{
  const AW = { kp: 8, ki: 4, kd: 0, uMax: 1.2, uMin: -1.2, duration: 30 };
  const on = sim(Object.assign({}, AW, { antiWindup: true }));
  const off = sim(Object.assign({}, AW, { antiWindup: false }));
  check('M7.1 抗饱和减小超调：overshoot(on) < overshoot(off)',
    on.metrics.overshoot < off.metrics.overshoot,
    on.metrics.overshoot.toFixed(2) + '% vs ' + off.metrics.overshoot.toFixed(2) + '%');
  check('M7.2 抗饱和限制积分幅值：maxI(on) < maxI(off)，且 off 出现 windup（maxI>uMax）',
    on.stats.maxI < off.stats.maxI && off.stats.maxI > 1.2,
    on.stats.maxI.toFixed(3) + ' vs ' + off.stats.maxI.toFixed(3));
  check('M7.3 抗饱和加快调节：settling(on) < settling(off)',
    on.metrics.settled && off.metrics.settled && on.metrics.settling < off.metrics.settling,
    on.metrics.settling + 's vs ' + off.metrics.settling + 's');
  check('M7.4 两种设置输出都严格限幅',
    on.stats.maxU <= 1.2 + 1e-12 && off.stats.maxU <= 1.2 + 1e-12);
}

// ================================================================ M8 采样周期收敛性
{
  const PI = { mode: 'PI', kp: 1, ki: 0.5, kd: 0, duration: 12 };
  const coarse = sim(Object.assign({}, PI, { dt: 0.1 }));
  const mid = sim(Object.assign({}, PI, { dt: 0.02 }));
  const fine = sim(Object.assign({}, PI, { dt: 0.005 }));
  let err1 = 0, err2 = 0;
  for (let k = 0; k < coarse.t.length; k++) {
    const t = coarse.t[k];
    const j = Math.round(t / 0.02), q = Math.round(t / 0.005);
    err1 = Math.max(err1, Math.abs(coarse.y[k] - mid.y[j]));
    err2 = Math.max(err2, Math.abs(mid.y[j] - fine.y[q]));
  }
  check('M8.1 dt 加密误差收缩：err(0.02→0.005) < 0.5·err(0.1→0.02)',
    err1 > 0 && err2 < 0.5 * err1, err1.toExponential(2) + ' → ' + err2.toExponential(2));
  check('M8.2 细网格误差绝对值 < 0.02', err2 < 0.02, err2.toExponential(2));
  const co60 = sim(Object.assign({}, PI, { dt: 0.1, duration: 60 }));
  const fi60 = sim(Object.assign({}, PI, { dt: 0.005, duration: 60 }));
  check('M8.3 充分长时间（60s）后不同 dt 的稳态值一致（<1e-6）',
    near(last(co60.y), last(fi60.y), 1e-6), last(co60.y) + ' vs ' + last(fi60.y));
}

// ================================================================ M9 确定性与状态初始化
{
  const a = sim(), b = sim();
  let identical = a.t.length === b.t.length;
  if (identical) {
    for (let k = 0; k < a.t.length && identical; k++) {
      identical = a.y[k] === b.y[k] && a.u[k] === b.u[k] && a.i[k] === b.i[k] && a.d[k] === b.d[k];
    }
  }
  check('M9.1 同参数两次仿真逐点完全一致（确定性）', identical);

  sim({ mode: 'PID', kp: 8, ki: 4, duration: 30 });
  const pAfter = sim({ mode: 'P', kp: 2, ki: 0, kd: 0, duration: 60 });
  const pFresh = sim({ mode: 'P', kp: 2, ki: 0, kd: 0, duration: 60 });
  check('M9.2 模式切换不携带状态：PID 之后的 P 与全新 P 逐点一致',
    pAfter.y.every((v, k) => v === pFresh.y[k]) && pAfter.i.every(v => v === 0));
  check('M9.3 首拍 convention：D[0]=0；I[0]=Ki·e[0]·dt（记录的是用于 u[0] 的积分值）',
    a.d[0] === 0 && near(a.i[0], BASE.ki * BASE.setpoint * BASE.dt, 1e-15), 'I0=' + a.i[0]);
}

// ================================================================ M10 指标定义
{
  const ol = sim({ mode: 'manual', u0: 1, duration: 20, dt: 0.001 });
  check('M10.1 开环上升时间（10%→90%）= ln9·τ ≈ 2.1972（±0.005）',
    near(ol.metrics.rise, Math.log(9), 0.005), 'rise=' + ol.metrics.rise);
  check('M10.2 开环无超调，调节时间（±2%）≈ −ln0.02·τ ≈ 3.912（±0.005，样本粒度）',
    ol.metrics.overshoot === 0 && near(ol.metrics.settling, -Math.log(0.02), 0.005),
    'settling=' + ol.metrics.settling);
  check('M10.3 开环 20s 稳态误差 <1e-6', Math.abs(ol.metrics.ess) < 1e-6, 'ess=' + ol.metrics.ess.toExponential(2));

  const short = sim({ mode: 'manual', u0: 1, duration: 0.5 });
  check('M10.4 仿真时长不足：settled=false，settling=null，不编造调节时间',
    short.metrics.settled === false && short.metrics.settling === null &&
    short.metrics.reason === 'not-settled-within-horizon');

  const osc = sim({ kp: 0, ki: 100, kd: 0, dt: 0.2, duration: 10, antiWindup: false });
  check('M10.5 持续振荡（未达稳态）：settled=false，settling=null，输出仍有限',
    osc.metrics.settled === false && osc.metrics.settling === null && allFinite(osc.y) && allFinite(osc.u),
    'reason=' + osc.metrics.reason);
  const osc2 = sim({ kp: 0, ki: 50, kd: 0, dt: 0.2, duration: 10, antiWindup: false });
  check('M10.5b 尾带判据：振荡即使末点落回带内，末尾 5% 不全在带内 → 仍判未稳定',
    osc2.metrics.settled === false && osc2.metrics.settling === null,
    'tail=' + osc2.y.slice(-3).map(v => v.toFixed(3)).join(','));

  const noStep = sim({ setpoint: 0, y0: 0 });
  check('M10.6 无阶跃（r=y0=0）：reason=no-step，rise=null，ess=0，settling=0',
    noStep.metrics.reason === 'no-step' && noStep.metrics.rise === null &&
    noStep.metrics.ess === 0 && noStep.metrics.settling === 0);

  const tiny = sim({ mode: 'P', kp: 0.01, ki: 0, kd: 0, duration: 5 });
  check('M10.7 未达到 90%：rise=null（不编造上升时间）', tiny.metrics.rise === null);
}

// ================================================================ M11 数值保护
{
  const fastPlant = sim({ tau: 1e-6, dt: 0.02, mode: 'manual', u0: 1 });
  check('M11.1 极小 τ（a≈0）：数值稳定，y[k≥1]≈K·u',
    allFinite(fastPlant.y) && fastPlant.y.slice(1).every(v => near(v, 1, 1e-9)));

  const hugeKp = sim({ kp: 1e6, ki: 0, kd: 0 });
  check('M11.2 极大 Kp：输出被限幅、全程有限、无 NaN',
    allFinite(hugeKp.y) && allFinite(hugeKp.u) && hugeKp.stats.maxU <= 2 + 1e-12);

  // 固定种子随机合法配置：全部有限、限幅成立
  let seed = 20261124;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  let randomOk = true, maxUviol = 0;
  for (let i = 0; i < 60; i++) {
    const c = cfg({
      kp: rnd() * 10, ki: rnd() * 10, kd: rnd() * 5,
      plantK: 0.2 + rnd() * 5, tau: 0.2 + rnd() * 5,
      setpoint: (rnd() * 2 - 1) * 4,
      uMin: -3, uMax: 3,
      dt: [0.005, 0.02, 0.05][i % 3], duration: 8,
      mode: ['P', 'PI', 'PID'][i % 3],
      antiWindup: i % 2 === 0
    });
    const r = P.simulate(c);
    if (!r.ok || !allFinite(r.y) || !allFinite(r.u) || !allFinite(r.i) || !allFinite(r.d)) { randomOk = false; break; }
    maxUviol = Math.max(maxUviol, r.stats.maxU - 3, -3 - r.stats.minU);
  }
  check('M11.3 60 组随机合法配置：全部有限且严格限幅', randomOk && maxUviol <= 1e-12, 'maxViol=' + maxUviol.toExponential(2));
  check('M11.4 I/D 统计范围有限且与序列一致',
    near(sim().stats.maxI, Math.max.apply(null, sim().i), 0) && allFinite([sim().stats.maxD, sim().stats.minD]));
}

// ================================================================ M12 线性与非零初始
{
  // 固定对象与增益，设定值/限幅同倍放大 → 闭环线性：y/u 逐点同倍（饱和模式也一致）
  const s1 = sim({ kp: 2, ki: 1, kd: 0.2, setpoint: 1, uMin: -2, uMax: 2, duration: 15 });
  const s2 = sim({ kp: 2, ki: 1, kd: 0.2, setpoint: 2, uMin: -4, uMax: 4, duration: 15 });
  let scaleOk = true;
  for (let k = 0; k < s1.t.length; k++) {
    if (!near(s2.y[k], 2 * s1.y[k], 1e-9) || !near(s2.u[k], 2 * s1.u[k], 1e-9)) scaleOk = false;
  }
  check('M12.1 闭环线性：r/限幅同倍放大（对象与增益不变）→ y/u 逐点同倍', scaleOk);

  const y0 = sim({ y0: 0.5, mode: 'PI', kp: 1, ki: 0.5, kd: 0, duration: 60 });
  check('M12.2 非零初始 y0=0.5：PI 仍收敛到 r（60s，|ess|<1e-6），上升时间有定义',
    near(last(y0.y), 1, 1e-6) && Math.abs(y0.metrics.ess) < 1e-6 &&
    Number.isFinite(y0.metrics.rise) && y0.metrics.rise > 0, 'ess=' + y0.metrics.ess.toExponential(2));

  // 独立重算上升时间（按定义 (y−y0)/(r−y0) 的 10%→90% 线性插值），与模块结果一致
  let t10 = null, t90 = null;
  for (let k = 1; k < y0.t.length; k++) {
    const f0 = (y0.y[k - 1] - 0.5) / 0.5, f1 = (y0.y[k] - 0.5) / 0.5;
    if (t10 === null && f1 >= 0.1) t10 = y0.t[k - 1] + (0.1 - f0) / (f1 - f0) * (y0.t[k] - y0.t[k - 1]);
    if (t90 === null && f1 >= 0.9) t90 = y0.t[k - 1] + (0.9 - f0) / (f1 - f0) * (y0.t[k] - y0.t[k - 1]);
  }
  check('M12.3 上升时间定义独立重算一致（y0≠0 时按步长归一化）',
    t10 !== null && t90 !== null && near(y0.metrics.rise, t90 - t10, 1e-9),
    'module=' + y0.metrics.rise + ' independent=' + (t90 - t10));
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);