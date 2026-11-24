#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1A：2R 机械臂运动学数学专项（无浏览器，直接 require 真实 js/robot-kinematics.js）
 *
 * 覆盖：FK 已知值 / FK-IK 回代 / 肘上肘下双分支与肘部侧向 / 可达与不可达 /
 * 内外边界及容差两侧 / 完全伸直与完全折叠奇异 / 零长度与非法输入 /
 * 数值精度与尺度不变性 / 连续拖动路径的姿态连续性与分支单调性。
 *
 * 正确性判据全部是数值断言（残差、角度、坐标），不依赖任何图形位置。
 * 随机用例使用固定种子 PRNG，可复现。
 *
 * 用法：node tests/test56_robot_kinematics.js
 */
const path = require('path');
const RK = require(path.resolve(__dirname, '..', 'js', 'robot-kinematics.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const PI = Math.PI;
const L1 = 120, L2 = 90;
const SCALE = L1 + L2;                 // 210
const RMIN = Math.abs(L1 - L2);        // 30
const RMAX = L1 + L2;                  // 210
const TOL = RK.REACH_TOL_FACTOR * SCALE;

function near(a, b, eps) { return Math.abs(a - b) <= eps; }
function hypot(dx, dy) { return Math.hypot(dx, dy); }

// 固定种子 PRNG（mulberry32）：随机用例可复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ================================================================ M1 FK 已知值
{
  const a = RK.fk(L1, L2, 0, 0);
  check('M1.1 零位 FK：末端 (L1+L2, 0)，肘部 (L1, 0)',
    a.ok && near(a.end.x, RMAX, 1e-9) && near(a.end.y, 0, 1e-9) &&
    near(a.elbow.x, L1, 1e-9) && near(a.elbow.y, 0, 1e-9),
    JSON.stringify(a.end));

  const b = RK.fk(L1, L2, PI / 2, 0);
  check('M1.2 θ1=90° 伸直：末端 (0, L1+L2)',
    b.ok && near(b.end.x, 0, 1e-9) && near(b.end.y, RMAX, 1e-9));

  const c = RK.fk(L1, L2, 0, PI / 2);
  check('M1.3 θ1=0 θ2=90°：末端 (L1, L2)',
    c.ok && near(c.end.x, L1, 1e-9) && near(c.end.y, L2, 1e-9));

  const d = RK.fk(100, 100, PI / 3, -PI / 3);
  check('M1.4 θ1=60° θ2=−60°：末端 (150, 50√3)',
    d.ok && near(d.end.x, 150, 1e-9) && near(d.end.y, 50 * Math.sqrt(3), 1e-9));

  const e = RK.fk(L1, L2, 3 * PI, -3 * PI / 2);
  check('M1.5 大角度输入归一化到 (−π, π] 且 FK 有限',
    e.ok && near(e.t1, PI, 1e-12) && near(e.t2, PI / 2, 1e-12) &&
    isFinite(e.end.x) && isFinite(e.end.y));

  check('M1.6 normalizeAngle 边界：−π → π，π → π，0 → 0',
    near(RK.normalizeAngle(-PI), PI, 1e-12) && near(RK.normalizeAngle(PI), PI, 1e-12) &&
    RK.normalizeAngle(0) === 0 && Number.isNaN(RK.normalizeAngle(NaN)));
}

// ================================================================ M2 FK/IK 回代 + 双分支（随机网格）
{
  const rnd = mulberry32(20261123);
  let n = 0, maxRes = 0, branchSignOk = true, sideOk = true, bothOk = true;
  for (let i = 0; i < 400; i++) {
    // 在环形工作空间内采样（避开边界容差带，边界另有专项）
    const r = RMIN + 2 * TOL + rnd() * (RMAX - RMIN - 4 * TOL);
    const phi = (rnd() * 2 - 1) * PI;
    const x = r * Math.cos(phi), y = r * Math.sin(phi);
    const both = RK.ikBoth(L1, L2, x, y);
    if (!both.ok || !both.reachable) { bothOk = false; continue; }
    for (const sol of [both.up, both.down]) {
      n++;
      maxRes = Math.max(maxRes, sol.residual);
      const back = RK.fk(L1, L2, sol.t1, sol.t2);
      if (hypot(back.end.x - x, back.end.y - y) > 1e-9 * SCALE) bothOk = false;
      if (sol.branch === 'elbow-up' && sol.t2 > 1e-12) branchSignOk = false;
      if (sol.branch === 'elbow-down' && sol.t2 < -1e-12) branchSignOk = false;
      // 肘部侧向：cross(target, elbow) —— 肘上在基座→目标有向线段左侧（≥0），肘下右侧（≤0）
      const cross = x * sol.elbow.y - y * sol.elbow.x;
      if (sol.branch === 'elbow-up' && cross < -1e-6 * SCALE * SCALE) sideOk = false;
      if (sol.branch === 'elbow-down' && cross > 1e-6 * SCALE * SCALE) sideOk = false;
    }
  }
  check('M2.1 400 个随机可达目标 × 双分支全部有解且 FK 回代通过', bothOk && n === 800, 'n=' + n);
  check('M2.2 全部回代残差 < 1e-9×杆长和', maxRes < 1e-9 * SCALE, 'maxResidual=' + maxRes.toExponential(3));
  check('M2.3 分支符号约定：肘上 θ2≤0，肘下 θ2≥0', branchSignOk);
  check('M2.4 肘部侧向约定：肘上在左（cross≥0），肘下在右（cross≤0）', sideOk);

  // 一般目标两分支必须不同（非奇异）
  const g = RK.ikBoth(L1, L2, 150, 90);
  check('M2.5 非奇异目标两分支姿态不同',
    g.ok && hypot(g.up.elbow.x - g.down.elbow.x, g.up.elbow.y - g.down.elbow.y) > 1,
    'elbowDist=' + hypot(g.up.elbow.x - g.down.elbow.x, g.up.elbow.y - g.down.elbow.y).toFixed(2));
  check('M2.6 ikBoth 与单分支 ik 完全一致',
    g.up.t1 === RK.ik(L1, L2, 150, 90, 'elbow-up').t1 &&
    g.down.t2 === RK.ik(L1, L2, 150, 90, 'elbow-down').t2);
}

// ================================================================ M3 可达 / 不可达
{
  const out = RK.ik(L1, L2, RMAX + 1, 0, 'elbow-up');
  check('M3.1 超出外边界：ok=false、reachable=false、reason=beyond-outer',
    out.ok === false && out.reachable === false && out.reason === 'beyond-outer');
  check('M3.2 不可达结果不含任何角度/坐标解（不截断伪造）',
    !('t1' in out) && !('t2' in out) && !('end' in out) && !('elbow' in out));

  const inn = RK.ik(L1, L2, 10, 0, 'elbow-down');
  check('M3.3 内边界以内（r<rMin）：reason=inside-inner 且无解',
    inn.ok === false && inn.reason === 'inside-inner' && !('t1' in inn));

  const diag = RK.ik(L1, L2, 200, 200, 'elbow-up');   // r≈282.8 > 210
  check('M3.4 斜向不可达目标同样拒绝', diag.ok === false && diag.reachable === false);

  const ws = RK.workspace(L1, L2);
  check('M3.5 工作空间 rMin=|L1−L2|, rMax=L1+L2', ws.ok && ws.rMin === RMIN && ws.rMax === RMAX);
  const wsEq = RK.workspace(100, 100);
  check('M3.6 等长杆工作空间退化为圆盘 rMin=0', wsEq.ok && wsEq.rMin === 0 && wsEq.rMax === 200);

  const nanT = RK.ik(L1, L2, NaN, 0, 'elbow-up');
  check('M3.7 非有限目标坐标：error=invalid-target，不抛错', nanT.ok === false && nanT.error === 'invalid-target');
  const infT = RK.reachability(L1, L2, 0, Infinity);
  check('M3.8 Infinity 目标同样拒绝', infT.ok === false && infT.error === 'invalid-target');
}

// ================================================================ M4 内外边界（容差两侧）
{
  const outer = RK.ikBoth(L1, L2, RMAX, 0);
  check('M4.1 恰好外边界：可达、奇异=extended、|θ2|≈0',
    outer.ok && outer.up.singular === 'extended' && Math.abs(outer.up.t2) < 1e-6 &&
    outer.up.residual < 1e-9 * SCALE);

  const inner = RK.ik(L1, L2, RMIN, 0, 'elbow-up');
  check('M4.2 恰好内边界（L1>L2）：奇异=folded、|θ2|≈π、θ1≈0',
    inner.ok && inner.singular === 'folded' && near(Math.abs(inner.t2), PI, 1e-6) &&
    near(inner.t1, 0, 1e-6) && inner.residual < 1e-9 * SCALE);

  const innerRev = RK.ik(90, 120, 30, 0, 'elbow-down');   // L2>L1：折叠时 θ1≈π
  check('M4.3 内边界（L2>L1）：折叠位形 θ1≈π 且回代通过',
    innerRev.ok && near(Math.abs(innerRev.t1), PI, 1e-6) && innerRev.residual < 1e-9 * SCALE);

  const justIn = RK.ik(L1, L2, RMAX - 1e-6 * SCALE, 0, 'elbow-up');
  check('M4.4 外边界内侧 1e-6×scale：可达且非奇异', justIn.ok && justIn.singular === null);
  const justOut = RK.ik(L1, L2, RMAX + 1e-6 * SCALE, 0, 'elbow-up');
  check('M4.5 外边界外侧 1e-6×scale：不可达（不放宽）', justOut.ok === false && justOut.reachable === false);

  const inIn = RK.ik(L1, L2, RMIN + 1e-6 * SCALE, 0, 'elbow-up');
  check('M4.6 内边界外侧 1e-6×scale：可达', inIn.ok === true);
  const inOut = RK.ik(L1, L2, RMIN - 1e-6 * SCALE, 0, 'elbow-up');
  check('M4.7 内边界内侧 1e-6×scale：不可达', inOut.ok === false && inOut.reason === 'inside-inner');

  const tolOut = RK.ik(L1, L2, RMAX + 0.5 * TOL, 0, 'elbow-up');
  check('M4.8 容差带内（0.5×tol）越界：判可达但 clamped=true 且残差如实报告',
    tolOut.ok && tolOut.clamped === true && tolOut.boundary === 'outer' &&
    tolOut.residual <= RK.VERIFY_TOL_FACTOR * SCALE && tolOut.residual > 0,
    'residual=' + tolOut.residual.toExponential(3));

  const diagBoundary = RK.ik(L1, L2, RMAX * Math.cos(0.7), RMAX * Math.sin(0.7), 'elbow-down');
  check('M4.9 斜向外边界同样判奇异且回代通过',
    diagBoundary.ok && diagBoundary.singular === 'extended' && diagBoundary.residual < 1e-9 * SCALE);
}

// ================================================================ M5 奇异点与近奇异稳定性
{
  const ext = RK.ikBoth(L1, L2, RMAX, 0);
  check('M5.1 完全伸直：两分支重合（肘部/末端一致）',
    hypot(ext.up.elbow.x - ext.down.elbow.x, ext.up.elbow.y - ext.down.elbow.y) < 1e-6 &&
    hypot(ext.up.end.x - ext.down.end.x, ext.up.end.y - ext.down.end.y) < 1e-6);

  const fold = RK.ikBoth(L1, L2, RMIN, 0);
  check('M5.2 完全折叠：两分支重合',
    fold.ok && hypot(fold.up.elbow.x - fold.down.elbow.x, fold.up.elbow.y - fold.down.elbow.y) < 1e-6);

  const origin = RK.ikBoth(100, 100, 0, 0);
  check('M5.3 等长杆目标在原点：可达、folded、回代残差≈0（解不唯一但确定）',
    origin.ok && origin.up.singular === 'folded' && origin.up.residual < 1e-9 * 200 &&
    origin.down.residual < 1e-9 * 200);

  const nearExt = RK.ikBoth(L1, L2, RMAX * (1 - 1e-12), 0);
  check('M5.4 近伸直（1−1e-12）×rMax：角度有限、回代通过',
    nearExt.ok && isFinite(nearExt.up.t1) && isFinite(nearExt.up.t2) &&
    nearExt.up.residual < RK.VERIFY_TOL_FACTOR * SCALE);

  const nearFold = RK.ikBoth(L1, L2, RMIN + 1e-12 * SCALE, 0);
  check('M5.5 近折叠 rMin+1e-12×scale：角度有限、回代通过',
    nearFold.ok && isFinite(nearFold.up.t1) && isFinite(nearFold.down.t2) &&
    nearFold.up.residual < RK.VERIFY_TOL_FACTOR * SCALE);

  const nearOrigin = RK.ik(100, 100, 1e-9, 0, 'elbow-up');
  check('M5.6 等长杆近原点目标：数值稳定', nearOrigin.ok && isFinite(nearOrigin.t1) && nearOrigin.residual < 1e-6);

  // 病态余弦输入：构造略超 1 的 c2（容差带内），夹取后仍必须 FK 验证通过
  const guard = RK.ik(L1, L2, RMAX + 0.9 * TOL, 0, 'elbow-down');
  check('M5.7 acos 输入保护：c2>1 被夹取且解仍通过回代',
    guard.ok && guard.clamped === true && Math.abs(guard.t2) < 1e-6);
}

// ================================================================ M6 零长度 / 非法输入
{
  const bad = [
    [0, 90], [120, 0], [-5, 90], [120, -1], [NaN, 90], [120, Infinity],
    ['120', 90], [null, 90], [undefined, undefined]
  ];
  let allRejected = true, noThrow = true;
  for (const [a, b] of bad) {
    try {
      const v = RK.validateLengths(a, b);
      const s = RK.ik(a, b, 100, 0, 'elbow-up');
      const f = RK.fk(a, b, 0, 0);
      const w = RK.workspace(a, b);
      if (v.ok || s.ok || f.ok || w.ok) allRejected = false;
    } catch (e) { noThrow = false; }
  }
  check('M6.1 零/负/NaN/Infinity/非数字长度全部拒绝（validate/ik/fk/workspace）', allRejected);
  check('M6.2 非法输入不抛异常', noThrow);

  const zero = RK.ik(0, 0, 0, 0, 'elbow-up');
  check('M6.3 双零长度：error=non-positive-length', zero.ok === false && zero.error === 'non-positive-length');

  const badBranch = RK.ik(L1, L2, 150, 90, 'sideways');
  check('M6.4 非法分支名：error=invalid-branch', badBranch.ok === false && badBranch.error === 'invalid-branch');

  const badAngle = RK.fk(L1, L2, NaN, 0);
  check('M6.5 非有限关节角：error=invalid-angle', badAngle.ok === false && badAngle.error === 'invalid-angle');
}

// ================================================================ M7 数值精度与尺度不变性
{
  const rnd = mulberry32(99);
  let maxRes = 0;
  for (let i = 0; i < 300; i++) {
    const r = RMIN + rnd() * (RMAX - RMIN);
    const phi = (rnd() * 2 - 1) * PI;
    for (const br of ['elbow-up', 'elbow-down']) {
      const s = RK.ik(L1, L2, r * Math.cos(phi), r * Math.sin(phi), br);
      if (s.ok) maxRes = Math.max(maxRes, s.residual);
    }
  }
  check('M7.1 300 随机目标×双分支最大残差 < 1e-10×scale（含边界采样）',
    maxRes < 1e-10 * SCALE, 'maxResidual=' + maxRes.toExponential(3));

  let scaleOk = true;
  for (const k of [1e6, 1e-6, 0.001, 1000]) {
    const s0 = RK.ik(L1, L2, 150, 90, 'elbow-up');
    const sk = RK.ik(L1 * k, L2 * k, 150 * k, 90 * k, 'elbow-up');
    if (!sk.ok || !near(sk.t1, s0.t1, 1e-9) || !near(sk.t2, s0.t2, 1e-9) ||
      !near(sk.end.x, s0.end.x * k, 1e-6 * k * SCALE) || sk.residual > RK.VERIFY_TOL_FACTOR * SCALE * k) scaleOk = false;
  }
  check('M7.2 尺度不变性：k=1e±6 角度不变、坐标按 k 缩放、相对残差达标', scaleOk);

  const tiny = RK.ikBoth(1e-6, 2e-6, 1.5e-6, 1e-6);
  const huge = RK.ikBoth(1e6, 2e6, 1.5e6, 1e6);
  check('M7.3 极小/极大杆长（1e-6 / 1e6 量级）回代均通过',
    tiny.ok && huge.ok && tiny.up.residual < RK.VERIFY_TOL_FACTOR * 3e-6 &&
    huge.up.residual < RK.VERIFY_TOL_FACTOR * 3e6);
}

// ================================================================ M8 连续拖动：姿态连续性与分支稳定性
{
  // 圆周路径（完全在环内）：相邻步姿态变化有界、无 NaN、无分支跳变
  const r = (RMIN + RMAX) / 2;
  const steps = 720;
  let contOk = true, maxStep = 0;
  for (const br of ['elbow-up', 'elbow-down']) {
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const phi = -PI + (2 * PI * i) / steps;
      const s = RK.ik(L1, L2, r * Math.cos(phi), r * Math.sin(phi), br);
      if (!s.ok || !isFinite(s.t1) || !isFinite(s.t2)) { contOk = false; break; }
      if (prev) {
        const dEnd = hypot(s.end.x - prev.end.x, s.end.y - prev.end.y);
        const dElbow = hypot(s.elbow.x - prev.elbow.x, s.elbow.y - prev.elbow.y);
        maxStep = Math.max(maxStep, dEnd, dElbow);
        if (dEnd > 0.02 * SCALE || dElbow > 0.02 * SCALE) { contOk = false; break; }
      }
      prev = s;
    }
  }
  check('M8.1 圆周连续拖动 720 步×双分支：姿态连续（相邻步 < 0.02×scale）且无 NaN',
    contOk, 'maxStep=' + maxStep.toFixed(4));

  // 径向拖动：从近外边界到近内边界，肘上分支 θ2 单调递减（不翻分支）
  let monoOk = true, finiteOk = true;
  let prevT2 = null;
  for (let i = 0; i <= 400; i++) {
    const rr = (RMAX - 1e-6 * SCALE) - ((RMAX - RMIN - 2e-6 * SCALE) * i) / 400;
    const s = RK.ik(L1, L2, rr, 0, 'elbow-up');
    if (!s.ok || !isFinite(s.t2)) { finiteOk = false; break; }
    if (prevT2 !== null && s.t2 > prevT2 + 1e-9) monoOk = false;
    prevT2 = s.t2;
  }
  check('M8.2 径向拖动 400 步：肘上 θ2 从 ≈0 单调降到 ≈−π（分支连续不翻转）', monoOk && finiteOk);

  // 穿越 −π/π 表示割线：姿态（坐标）仍连续
  let cutOk = true;
  let prevEnd = null;
  for (let i = 0; i <= 60; i++) {
    const phi = PI - 0.3 + (0.6 * i) / 60;   // 跨过 ±π
    const s = RK.ik(L1, L2, r * Math.cos(phi), r * Math.sin(phi), 'elbow-down');
    if (!s.ok) { cutOk = false; break; }
    if (prevEnd && hypot(s.end.x - prevEnd.x, s.end.y - prevEnd.y) > 0.02 * SCALE) cutOk = false;
    prevEnd = s.end;
  }
  check('M8.3 角度表示跨 ±π 割线时末端坐标仍连续（归一化不破坏姿态）', cutOk);
}

// ================================================================ M9 API 契约
{
  check('M9.1 VERSION=1 且导出完整 API',
    RK.VERSION === 1 && typeof RK.fk === 'function' && typeof RK.ik === 'function' &&
    typeof RK.ikBoth === 'function' && typeof RK.workspace === 'function' &&
    typeof RK.reachability === 'function' && typeof RK.validateLengths === 'function');

  const u = RK.ikBoth(L1, L2, RMAX + 5, 0);
  check('M9.2 ikBoth 不可达时 ok=false 且两分支均无解',
    u.ok === false && u.reachable === false && u.up.ok === false && u.down.ok === false);

  const degOk = near(RK.deg(PI / 2), 90, 1e-12) && near(RK.rad(180), PI, 1e-12);
  check('M9.3 度/弧度换算正确', degOk);
}

console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);