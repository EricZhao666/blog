#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2D：梯形与七段 S 曲线运动轨迹规划 —— 纯数学单元测试（无浏览器）
 *
 * 覆盖：
 *   M1  梯形规划：三段梯形、二段三角形退化、临界边界、零位移、反向位移
 *   M2  七段 S 曲线全退化工况：7-seg / 6-seg / 5-seg / 4-seg / 临界边界 / 零位移
 *   M3  分段边界连续性（t_k 处位置、速度、加速度左右极限连续）
 *   M4  运动学约束满足（采样全过程 |v|<=vMax, |a|<=aMax, |j|<=jMax）
 *   M5  未经强制修正的终点残差（|rawEndPos-q1|, |rawEndVel|, |rawEndAcc| <= 1e-9）
 *   M6  独立数值积分交叉验证（Simpson / 细步长积分位置与解析位置一致）
 *   M7  非法输入拒绝（NaN / Infinity / 非正约束 / 越界）与确定性
 */
const MP = require('../js/motion-profile');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

// ---------------------------------------------------------------- M1 梯形规划
{
  // 1.1 三段梯形：D=100, vMax=20, aMax=10 -> lCrit=40, ta=2, tv=3, td=2, T=7
  const t1 = MP.planTrapezoidal({ q0: 0, q1: 100, vMax: 20, aMax: 10 });
  check('M1.1 三段梯形求解成功且形态为 3-seg-trapezoid', t1.ok && t1.regime === '3-seg-trapezoid', t1.regime);
  check('M1.2 三段梯形分段时长精确 ta=2, tv=3, td=2, T=7',
    near(t1.ta, 2) && near(t1.tv, 3) && near(t1.td, 2) && near(t1.totalTime, 7),
    JSON.stringify({ ta: t1.ta, tv: t1.tv, td: t1.td, T: t1.totalTime }));
  check('M1.3 三段梯形终点未修正残差 < 1e-11',
    t1.endPosResidual < 1e-11 && t1.endVelResidual < 1e-11,
    JSON.stringify({ posRes: t1.endPosResidual, velRes: t1.endVelResidual }));

  // 1.2 二段三角形退化：D=25, vMax=20, aMax=10 -> lCrit=40 > 25 -> vPeak=sqrt(250), ta=sqrt(2.5), tv=0
  const t2 = MP.planTrapezoidal({ q0: 0, q1: 25, vMax: 20, aMax: 10 });
  check('M1.4 短行程梯形退化为 2-seg-triangle（Tv=0）',
    t2.ok && t2.regime === '2-seg-triangle' && t2.tv === 0,
    JSON.stringify({ regime: t2.regime, tv: t2.tv }));
  check('M1.5 三角形退化峰值速度 vPeak = sqrt(250) < vMax',
    near(t2.vPeak, Math.sqrt(250)) && t2.vPeak < 20,
    t2.vPeak);
  check('M1.6 三角形退化终点未修正残差 < 1e-11',
    t2.endPosResidual < 1e-11 && t2.endVelResidual < 1e-11);

  // 1.3 临界边界：D = lCrit = 40 -> tv=0, vPeak=20
  const t3 = MP.planTrapezoidal({ q0: 0, q1: 40, vMax: 20, aMax: 10 });
  check('M1.7 梯形临界边界 L=vMax^2/aMax 精确闭合',
    t3.ok && near(t3.tv, 0) && near(t3.vPeak, 20) && t3.endPosResidual < 1e-11);

  // 1.4 零位移
  const t0 = MP.planTrapezoidal({ q0: 15, q1: 15, vMax: 20, aMax: 10 });
  check('M1.8 梯形零位移 T=0 且 q=15', t0.ok && t0.regime === 'zero-distance' && t0.totalTime === 0 && t0.rawEndPos === 15);
}

// ---------------------------------------------------------------- M2 七段 S 曲线及全部退化条件
const scurveCases = [
  { id: '7-seg-full', params: { q0: 0, q1: 120, vMax: 40, aMax: 80, jMax: 400 }, expectRegime: '7-seg-full', expectTcPos: true, expectTvPos: true, expectHitV: true, expectHitA: true },
  { id: '6-seg-no-cruise', params: { q0: 0, q1: 20, vMax: 40, aMax: 80, jMax: 400 }, expectRegime: '6-seg-no-cruise', expectTcPos: true, expectTvPos: false, expectHitV: false, expectHitA: true },
  { id: '5-seg-no-const-acc', params: { q0: 0, q1: 100, vMax: 20, aMax: 100, jMax: 200 }, expectRegime: '5-seg-no-const-acc', expectTcPos: false, expectTvPos: true, expectHitV: true, expectHitA: false },
  { id: '4-seg-jerk-only', params: { q0: 0, q1: 2, vMax: 40, aMax: 80, jMax: 200 }, expectRegime: '4-seg-jerk-only', expectTcPos: false, expectTvPos: false, expectHitV: false, expectHitA: false },
  { id: 'reverse-7seg', params: { q0: 50, q1: -30, vMax: 35, aMax: 70, jMax: 350 }, expectRegime: '7-seg-full', expectTcPos: true, expectTvPos: true, expectHitV: true, expectHitA: true },
  { id: 'reverse-4seg', params: { q0: 10, q1: 8.5, vMax: 40, aMax: 80, jMax: 200 }, expectRegime: '4-seg-jerk-only', expectTcPos: false, expectTvPos: false, expectHitV: false, expectHitA: false }
];

for (const c of scurveCases) {
  const res = MP.planSCurve(c.params);
  check('M2.' + c.id + ' 工况识别正确 (' + c.expectRegime + ')',
    res.ok && res.regime === c.expectRegime,
    JSON.stringify({ regime: res.regime, tj: res.tj, tc: res.tc, tv: res.tv }));
  check('M2.' + c.id + ' 退化时长标志准确',
    (c.expectTcPos ? res.tc > 1e-9 : near(res.tc, 0)) &&
    (c.expectTvPos ? res.tv > 1e-9 : near(res.tv, 0)),
    JSON.stringify({ tc: res.tc, tv: res.tv }));
  check('M2.' + c.id + ' 峰值速度与峰值加速度符合退化预期',
    (c.expectHitV ? near(res.vPeak, c.params.vMax, 1e-9) : res.vPeak < c.params.vMax - 1e-6) &&
    (c.expectHitA ? near(res.aPeak, c.params.aMax, 1e-9) : res.aPeak < c.params.aMax - 1e-6),
    JSON.stringify({ vPeak: res.vPeak, aPeak: res.aPeak }));

  // M3 分段边界连续性（q, v, a 左右极限一致）
  let contOk = true;
  let maxContErr = 0;
  for (let i = 0; i < res.segments.length - 1; i++) {
    const sA = res.segments[i];
    const sB = res.segments[i + 1];
    const pEnd = sA.p0 + sA.v0 * sA.dt + 0.5 * sA.a0 * sA.dt * sA.dt + (1 / 6) * sA.j * sA.dt * sA.dt * sA.dt;
    const vEnd = sA.v0 + sA.a0 * sA.dt + 0.5 * sA.j * sA.dt * sA.dt;
    const aEnd = sA.a0 + sA.j * sA.dt;
    const e = Math.max(Math.abs(pEnd - sB.p0), Math.abs(vEnd - sB.v0), Math.abs(aEnd - sB.a0));
    if (e > maxContErr) maxContErr = e;
    if (e > 1e-10) contOk = false;
  }
  check('M3.' + c.id + ' 分段边界位置/速度/加速度连续 (maxErr=' + maxContErr.toExponential(2) + ')', contOk);

  // M4 全过程采样约束满足 + 单调性（正向单调增，反向单调减）
  const pts = MP.sampleProfile(res, 400);
  const dir = res.dir;
  let boundOk = true;
  let monoOk = true;
  for (let k = 0; k < pts.length; k++) {
    const pt = pts[k];
    if (Math.abs(pt.v) > c.params.vMax + 1e-9 ||
        Math.abs(pt.a) > c.params.aMax + 1e-9 ||
        Math.abs(pt.j) > c.params.jMax + 1e-9) {
      boundOk = false;
    }
    if (k > 0) {
      if (dir > 0 && pt.q < pts[k - 1].q - 1e-10) monoOk = false;
      if (dir < 0 && pt.q > pts[k - 1].q + 1e-10) monoOk = false;
    }
  }
  check('M4.' + c.id + ' 采样全程满足 |v|<=vMax, |a|<=aMax, |j|<=jMax 且位置单调', boundOk && monoOk);

  // M5 未经强制修正的终点残差
  check('M5.' + c.id + ' 未修正终点位置/速度/加速度残差 <= 1e-9',
    res.endPosResidual <= 1e-9 && res.endVelResidual <= 1e-9 && res.endAccResidual <= 1e-9,
    JSON.stringify({ pos: res.endPosResidual, vel: res.endVelResidual, acc: res.endAccResidual }));

  // M6 独立数值积分（梯形法 N=4000 积分 v(t) 与 q(T)-q(0) 对照）
  const N = 4000;
  const h = res.totalTime / N;
  let integralV = 0;
  let prevV = MP.evaluateProfile(res, 0).v;
  for (let s = 1; s <= N; s++) {
    const curV = MP.evaluateProfile(res, s * h).v;
    integralV += 0.5 * (prevV + curV) * h;
    prevV = curV;
  }
  const expectedD = c.params.q1 - c.params.q0;
  check('M6.' + c.id + ' 独立速度积分与目标位移一致 (|err| < 1e-5)',
    Math.abs(integralV - expectedD) < 1e-5,
    'err=' + Math.abs(integralV - expectedD).toExponential(2));
}

// ---------------------------------------------------------------- M2.B 临界退化边界精确测试
{
  // L_full 边界（vMax*jMax >= aMax^2）：vMax=40, aMax=80, jMax=400 -> lFull = 40*(0.5+0.2) = 28
  const b1 = MP.planSCurve({ q0: 0, q1: 28, vMax: 40, aMax: 80, jMax: 400 });
  check('M2.B1 临界边界 L=L_full 时 Tv=0 且 vPeak=vMax',
    b1.ok && near(b1.tv, 0, 1e-9) && near(b1.vPeak, 40, 1e-9) && b1.endPosResidual < 1e-10);

  // L_a_thresh 边界：2 * aMax^3 / jMax^2 = 2 * 512000 / 160000 = 6.4
  const b2 = MP.planSCurve({ q0: 0, q1: 6.4, vMax: 40, aMax: 80, jMax: 400 });
  check('M2.B2 临界边界 L=2*aMax^3/jMax^2 时 Tc=0, Tv=0 且 aPeak=aMax',
    b2.ok && near(b2.tc, 0, 1e-9) && near(b2.tv, 0, 1e-9) && near(b2.aPeak, 80, 1e-9) && b2.endPosResidual < 1e-10);

  // 零位移
  const b0 = MP.planSCurve({ q0: -12, q1: -12, vMax: 40, aMax: 80, jMax: 400 });
  const e0 = MP.evaluateProfile(b0, 0);
  check('M2.B3 S 曲线零位移 T=0, q=-12, v=0, a=0, j=0',
    b0.ok && b0.regime === 'zero-distance' && b0.totalTime === 0 && e0.q === -12 && e0.v === 0 && e0.a === 0);

  // S 曲线耗时 >= 梯形耗时（同一约束下加加速度有限必定不快于无限加加速度）
  const cmp = MP.compareProfiles({ q0: 0, q1: 120, vMax: 40, aMax: 80, jMax: 400 });
  check('M2.B4 同一约束下 S 曲线总耗时 >= 梯形总耗时', cmp.ok && cmp.timeDelta >= -1e-12 && cmp.scurve.totalTime > cmp.trapezoidal.totalTime);
}

// ---------------------------------------------------------------- M7 非法输入与确定性
{
  check('M7.1 vMax <= 0 被拒绝', !MP.planSCurve({ q0: 0, q1: 10, vMax: 0, aMax: 10, jMax: 10 }).ok);
  check('M7.2 aMax < 0 被拒绝', !MP.planSCurve({ q0: 0, q1: 10, vMax: 10, aMax: -5, jMax: 10 }).ok);
  check('M7.3 jMax <= 0 被拒绝', !MP.planSCurve({ q0: 0, q1: 10, vMax: 10, aMax: 10, jMax: 0 }).ok);
  check('M7.4 NaN 位移被拒绝', !MP.planSCurve({ q0: 0, q1: NaN, vMax: 10, aMax: 10, jMax: 10 }).ok);
  check('M7.5 Infinity 约束被拒绝', !MP.planSCurve({ q0: 0, q1: 10, vMax: Infinity, aMax: 10, jMax: 10 }).ok);
  const rA = MP.compareProfiles({ q0: 0, q1: 75, vMax: 30, aMax: 60, jMax: 300 });
  const rB = MP.compareProfiles({ q0: 0, q1: 75, vMax: 30, aMax: 60, jMax: 300 });
  check('M7.6 确定性：同输入两次求解结果完全一致', JSON.stringify(rA) === JSON.stringify(rB));
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);

// ---------------------------------------------------------------- M8 Batch 9C-2D-R：数值尺度反例、极端参数、采样边界、静止保持与梯形口径
{
  // 反例 A：小位移梯形不被 1e-12 绝对容差掩盖
  const exA = MP.planTrapezoidal({ q0: 0, q1: 1e-15, vMax: 1e-7, aMax: 0.1 });
  check('M8.1 反例 A：planTrapezoidal(1e-15) 正确进入 2-seg-triangle',
    exA.ok && exA.regime === '2-seg-triangle', JSON.stringify({ regime: exA.regime, rawEndPos: exA.rawEndPos }));
  check('M8.2 反例 A：尺度相关位置残差 <= 1e-12 * |D|',
    exA.endPosResidual <= 1e-12 * 1e-15, 'posRes=' + exA.endPosResidual);

  // 反例 B：极小位移 S 曲线不被 1e-12 绝对容差掩盖
  const exB = MP.planSCurve({ q0: 0, q1: 1e-16, vMax: 1e-10, aMax: 1, jMax: 1 });
  check('M8.3 反例 B：planSCurve(1e-16) 正确进入 4-seg-jerk-only',
    exB.ok && exB.regime === '4-seg-jerk-only', JSON.stringify({ regime: exB.regime, rawEndPos: exB.rawEndPos }));
  check('M8.4 反例 B：尺度相关位置残差 <= 1e-12 * |D|',
    exB.endPosResidual <= 1e-12 * 1e-16, 'posRes=' + exB.endPosResidual);

  // 极端尺度拒绝
  check('M8.5 极端小位移 1e-25 被拒绝', !MP.planSCurve({ q0: 0, q1: 1e-25, vMax: 1, aMax: 1, jMax: 1 }).ok);
  check('M8.6 极端小约束 1e-25 被拒绝', !MP.planSCurve({ q0: 0, q1: 1, vMax: 1e-25, aMax: 1, jMax: 1 }).ok);
  check('M8.7 超大位移 1e12 被拒绝', !MP.planTrapezoidal({ q0: 0, q1: 1e12, vMax: 10, aMax: 10 }).ok);

  // 梯形终点口径与零位移口径
  const trNZ = MP.planTrapezoidal({ q0: 0, q1: 120, vMax: 40, aMax: 80 });
  const trZ = MP.planTrapezoidal({ q0: 5, q1: 5, vMax: 40, aMax: 80 });
  check('M8.8 非零位移梯形 jPeak=null, endAccResidual=null, endAccLeftLimit=-80',
    trNZ.jPeak === null && trNZ.endAccResidual === null && near(trNZ.endAccLeftLimit, -80));
  check('M8.9 零位移梯形 jPeak=0, endAccResidual=0, endAccLeftLimit=0',
    trZ.jPeak === 0 && trZ.endAccResidual === 0 && trZ.endAccLeftLimit === 0);

  // 采样必须包含所有有效阶段边界及终点，且受 MAX_SAMPLES 上限保护
  const scFull = MP.planSCurve({ q0: 0, q1: 120, vMax: 40, aMax: 80, jMax: 400 });
  const pts = MP.sampleProfile(scFull, { count: 25 });
  const boundaryHit = scFull.segments.every(s => pts.some(p => Math.abs(p.t - s.t1) <= scFull.totalTime * 1e-12));
  check('M8.10 sampleProfile 包含全部有效阶段边界与终点 T', boundaryHit && pts[pts.length - 1].t === scFull.totalTime);
  const capped = MP.sampleProfile(scFull, { dt: 1e-6 });
  check('M8.11 sampleProfile 点数受 MAX_SAMPLES 上限保护', capped.length <= MP.MAX_SAMPLES && capped.length > 100);

  // 边界极限语义与 t > T 静止保持状态
  const tSeg1End = scFull.segments[0].t1;
  const evInternal = MP.evaluateProfile(scFull, tSeg1End);
  const evEnd = MP.evaluateProfile(trNZ, trNZ.totalTime);
  const evHold = MP.evaluateProfile(trNZ, trNZ.totalTime + 0.5);
  check('M8.12 内部边界采用右极限（段1末切入段2 j=0）', evInternal.segmentIndex === 2 && evInternal.j === 0);
  check('M8.13 终点 t=T 取左极限（梯形末端 a=-80），t>T 进入静止保持（v=0, a=0, finished=true）',
    near(evEnd.a, -80) && evHold.finished === true && near(evHold.q, 120) && evHold.v === 0 && evHold.a === 0 && evHold.j === 0);

  // 固定种子随机性质测试（多尺度、四类退化、临界两侧、正反向）
  let seed = 20261127;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let propOk = true;
  let propFailInfo = '';
  const scales = [1e-6, 1e-2, 1, 1e3];
  for (let i = 0; i < 60; i++) {
    const sc = scales[i % scales.length];
    const dir = (i % 3 === 0) ? -1 : 1;
    const q0 = (rnd() - 0.5) * 10 * sc;
    const L = (i % 10 === 0) ? 0 : (0.05 + rnd() * 20) * sc;
    const q1 = q0 + dir * L;
    const vMax = (0.5 + rnd() * 5) * sc;
    const aMax = (0.5 + rnd() * 10) * sc;
    const jMax = (0.5 + rnd() * 20) * sc;
    const res = MP.planSCurve({ q0, q1, vMax, aMax, jMax });
    if (!res.ok) { propOk = false; propFailInfo = 'not ok at i=' + i; break; }
    const posTol = Math.max(1e-12 * Math.max(1, Math.abs(q0), Math.abs(q1)), 1e-12 * L);
    const velTol = 1e-11 * vMax;
    const accTol = 1e-11 * aMax;
    if (res.endPosResidual > posTol || res.endVelResidual > velTol || res.endAccResidual > accTol) {
      propOk = false; propFailInfo = 'residual at i=' + i + ' pos=' + res.endPosResidual; break;
    }
    if (res.vPeak > vMax * (1 + 1e-12) || res.aPeak > aMax * (1 + 1e-12)) {
      propOk = false; propFailInfo = 'bound exceeded at i=' + i; break;
    }
  }
  check('M8.14 固定种子 60 组多尺度随机性质测试（残差/约束/全工况）', propOk, propFailInfo || '60/60');
}

console.log('\n[9C-2D-R] 扩展后合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('扩展失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);
