/**
 * Batch 9C-1A：二维平面二连杆（2R）机械臂运动学 —— 纯计算模块
 *
 * 坐标系与单位约定（详见 ROBOT_KINEMATICS_MATH.md）：
 *   - 世界坐标系原点位于基座关节 J0；x 向右，y 向上（数学坐标系，非屏幕坐标）；
 *   - θ1：连杆 1 相对 +x 轴的绝对角，逆时针为正；
 *   - θ2：连杆 2 相对连杆 1 的关节角（相对角），逆时针为正；
 *   - 角度内部一律弧度，UI 展示换算为度；长度为任意一致单位（无量纲）。
 *
 * 分支约定：
 *   - elbow-up（肘上）：θ2 = −acos(c2) ≤ 0，肘部位于「基座→目标」有向线段的左侧（逆时针侧）；
 *   - elbow-down（肘下）：θ2 = +acos(c2) ≥ 0，肘部位于右侧；
 *   - 完全伸直（θ2=0）与完全折叠（|θ2|=π）为奇异位形，两分支在该处重合。
 *
 * 数值契约：
 *   - 不可达目标**绝不**截断到工作空间边界伪造可达解：ik 返回 ok:false 且不含解；
 *   - acos 输入夹取到 [−1,1] 仅用于吸收已通过可达性判定（容差内）的浮点舍入，
 *     夹取是否发生通过 clamped 字段显式暴露；
 *   - 每个 ik 解都经 fk 回代验证，残差超过验证容差即判失败；
 *   - 不做 IO、不写存储、不注册定时器、不改输入，可被 Node 直接 require。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var TAU = Math.PI * 2;

  // 可达性判定与边界分类容差：相对连杆总长的 1e-9 倍（双精度舍入量级之上留足余量）
  var REACH_TOL_FACTOR = 1e-9;
  // FK 回代验证容差：相对连杆总长的 1e-7 倍；实际残差通常在 1e-13 量级
  var VERIFY_TOL_FACTOR = 1e-7;

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function scaleOf(L1, L2) {
    return L1 + L2;
  }

  function reachTol(L1, L2) {
    return REACH_TOL_FACTOR * scaleOf(L1, L2);
  }

  function verifyTol(L1, L2) {
    return VERIFY_TOL_FACTOR * scaleOf(L1, L2);
  }

  /** 角度归一化到 (−π, π]。非有限输入返回 NaN，不抛错。 */
  function normalizeAngle(a) {
    if (!isFiniteNumber(a)) return NaN;
    var r = a % TAU;
    if (r > Math.PI) r -= TAU;
    if (r <= -Math.PI) r += TAU;
    return r;
  }

  function deg(rad) { return rad * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }

  /** 长度校验：必须是有限正数。0 / 负数 / NaN / Infinity / 非数字一律拒绝。 */
  function validateLengths(L1, L2) {
    if (!isFiniteNumber(L1) || !isFiniteNumber(L2)) {
      return { ok: false, error: 'invalid-length', message: '连杆长度必须是有限数字' };
    }
    if (L1 <= 0 || L2 <= 0) {
      return { ok: false, error: 'non-positive-length', message: '连杆长度必须大于 0' };
    }
    return { ok: true, L1: L1, L2: L2 };
  }

  /** 工作空间：环形区域 rMin ≤ r ≤ rMax；L1 = L2 时 rMin = 0（退化为圆盘）。 */
  function workspace(L1, L2) {
    var v = validateLengths(L1, L2);
    if (!v.ok) return v;
    return { ok: true, rMin: Math.abs(L1 - L2), rMax: L1 + L2 };
  }

  /**
   * 可达性判定（不做任何截断）。
   * boundary: 'outer'（外边界附近）/ 'inner'（内边界附近）/ null。
   * reason: 'beyond-outer' / 'inside-inner' / null。
   */
  function reachability(L1, L2, x, y) {
    var v = validateLengths(L1, L2);
    if (!v.ok) return v;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      return { ok: false, error: 'invalid-target', message: '目标坐标必须是有限数字' };
    }
    var r = Math.hypot(x, y);
    var rMin = Math.abs(L1 - L2);
    var rMax = L1 + L2;
    var tol = reachTol(L1, L2);
    var reachable = r >= rMin - tol && r <= rMax + tol;
    var boundary = null;
    if (Math.abs(r - rMax) <= tol) boundary = 'outer';
    else if (Math.abs(r - rMin) <= tol) boundary = 'inner';
    return {
      ok: true,
      reachable: reachable,
      r: r, rMin: rMin, rMax: rMax,
      boundary: boundary,
      reason: reachable ? null : (r > rMax ? 'beyond-outer' : 'inside-inner')
    };
  }

  /** 正运动学：输入弧度角，返回肘部与末端世界坐标。 */
  function fk(L1, L2, t1, t2) {
    var v = validateLengths(L1, L2);
    if (!v.ok) return v;
    if (!isFiniteNumber(t1) || !isFiniteNumber(t2)) {
      return { ok: false, error: 'invalid-angle', message: '关节角必须是有限数字' };
    }
    var ex = L1 * Math.cos(t1);
    var ey = L1 * Math.sin(t1);
    var a = t1 + t2;
    return {
      ok: true,
      t1: normalizeAngle(t1),
      t2: normalizeAngle(t2),
      elbow: { x: ex, y: ey },
      end: { x: ex + L2 * Math.cos(a), y: ey + L2 * Math.sin(a) }
    };
  }

  /**
   * 解析逆运动学（单分支）。
   * branch: 'elbow-up' | 'elbow-down'。
   * 成功：{ ok:true, reachable:true, t1, t2, elbow, end, residual, singular, boundary, clamped, ... }
   * 不可达：{ ok:false, reachable:false, reason, r, rMin, rMax } —— 不含任何角度解。
   * 非法输入：{ ok:false, error, message }。
   * singular: 'extended'（完全伸直）/ 'folded'（完全折叠）/ null。
   */
  function ik(L1, L2, x, y, branch) {
    var reach = reachability(L1, L2, x, y);
    if (!reach.ok) return reach;
    if (branch !== 'elbow-up' && branch !== 'elbow-down') {
      return { ok: false, error: 'invalid-branch', message: '分支必须是 elbow-up 或 elbow-down' };
    }
    if (!reach.reachable) {
      return {
        ok: false, reachable: false,
        reason: reach.reason,
        r: reach.r, rMin: reach.rMin, rMax: reach.rMax,
        boundary: reach.boundary
      };
    }

    // 余弦定理求 θ2；夹取仅吸收容差内的浮点舍入（clamped 显式暴露）
    var c2 = (x * x + y * y - L1 * L1 - L2 * L2) / (2 * L1 * L2);
    var c2c = Math.min(1, Math.max(-1, c2));
    var t2 = branch === 'elbow-up' ? -Math.acos(c2c) : Math.acos(c2c);

    // θ1 = 目标方位角 − 连杆2相对基座→目标连线的偏角
    var phi = Math.atan2(y, x);
    var t1 = phi - Math.atan2(L2 * Math.sin(t2), L1 + L2 * Math.cos(t2));
    t1 = normalizeAngle(t1);
    t2 = normalizeAngle(t2);

    // 每个解必须通过 FK 回代验证
    var check = fk(L1, L2, t1, t2);
    var residual = Math.hypot(check.end.x - x, check.end.y - y);
    var verified = residual <= verifyTol(L1, L2);

    var singular = null;
    if (reach.boundary === 'outer') singular = 'extended';
    else if (reach.boundary === 'inner') singular = 'folded';

    return {
      ok: verified,
      reachable: true,
      branch: branch,
      t1: t1, t2: t2,
      elbow: check.elbow,
      end: check.end,
      residual: residual,
      singular: singular,
      boundary: reach.boundary,
      clamped: c2 !== c2c,
      r: reach.r, rMin: reach.rMin, rMax: reach.rMax,
      error: verified ? null : 'fk-verification-failed'
    };
  }

  /** 同时给出两个分支的解（各自独立 FK 回代验证）。不可达时两分支均无解。 */
  function ikBoth(L1, L2, x, y) {
    var up = ik(L1, L2, x, y, 'elbow-up');
    var down = ik(L1, L2, x, y, 'elbow-down');
    return {
      ok: up.ok && down.ok,
      reachable: !!(up.reachable && down.reachable),
      up: up,
      down: down
    };
  }

  var api = {
    VERSION: VERSION,
    REACH_TOL_FACTOR: REACH_TOL_FACTOR,
    VERIFY_TOL_FACTOR: VERIFY_TOL_FACTOR,
    normalizeAngle: normalizeAngle,
    deg: deg,
    rad: rad,
    validateLengths: validateLengths,
    workspace: workspace,
    reachability: reachability,
    fk: fk,
    ik: ik,
    ikBoth: ikBoth
  };

  global.RobotKinematics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);