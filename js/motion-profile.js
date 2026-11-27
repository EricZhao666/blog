/* 梯形与七段 S 曲线运动轨迹规划 —— 纯计算模块（无 DOM、无 IO、确定性、可 Node require）
 *
 * 范围：单轴点对点（Rest-to-Rest，v0 = v1 = 0, a0 = a1 = 0）运动轨迹规划。
 *   1. 三段梯形速度规划（Trapezoidal）：加速度有界 |a| <= aMax，速度有界 |v| <= vMax；
 *      位移不足时自动退化为二段三角形（Tv = 0）。非零位移终点存在理想加速度阶跃，
 *      因此区分“终点加速度左极限”与“结束后静止状态”，jPeak 为 null（理想冲激）。
 *   2. 七段对称 S 曲线规划（7-Segment S-Curve）：加加速度有界 |j| <= jMax，
 *      加速度有界 |a| <= aMax，速度有界 |v| <= vMax；
 *      采用尺度相关相对容差 REL_EPS = 1e-12 判定退化条件，避免固定绝对容差掩盖小位移。
 *
 * 数值与采样契约：
 *   - 分段边界状态 (t_k, p_k, v_k, a_k) 由上一段闭式积分精确递推。
 *   - 终点状态 rawEndPos / rawEndVel / rawEndAcc 直接由分段公式求值，不做强制归零或夹取。
 *   - evaluateProfile(profile, t)：在 [0, T) 内对内部阶段边界取右极限；在 t = T 取左极限；
 *     在 t > T 进入静止保持状态（q = q1, v = 0, a = 0, j = 0, finished = true）。
 *   - sampleProfile(profile, opts)：必包含所有有效阶段边界与终点 T，总点数上限 MAX_SAMPLES = 2000。
 */
(function (global) {
  'use strict';

  var VERSION = 2;
  var REL_EPS = 1e-12;
  var MAX_ABS_VAL = 1e9;
  var MIN_POS_PARAM = 1e-18;
  var MAX_SAMPLES = 2000;

  var ERROR_TEXT = {
    'invalid-distance': '位移参数非法：起点、终点或位移必须是有限数值，且绝对值不超过 1e9。',
    'invalid-vmax': '最大速度 vMax 非法：必须是 (1e-18, 1e9] 范围内的有限正数。',
    'invalid-amax': '最大加速度 aMax 非法：必须是 (1e-18, 1e9] 范围内的有限正数。',
    'invalid-jmax': '最大加加速度 jMax 非法：必须是 (1e-18, 1e9] 范围内的有限正数。',
    'extreme-scale': '参数尺度极端：非零位移或中间时间超出 IEEE 754 可靠表示范围（|D| >= 1e-18 且总时长需有限正数）。'
  };

  function err(code, detail) {
    return {
      ok: false,
      error: code,
      message: ERROR_TEXT[code] || code,
      detail: detail || null
    };
  }

  function isFiniteNum(x) {
    return typeof x === 'number' && isFinite(x);
  }

  function validateParams(opts, requireJerk) {
    var o = opts || {};
    var q0 = o.q0 !== undefined ? Number(o.q0) : 0;
    var q1;
    if (o.q1 !== undefined) {
      q1 = Number(o.q1);
    } else if (o.distance !== undefined) {
      q1 = q0 + Number(o.distance);
    } else {
      q1 = 100;
    }
    var vMax = Number(o.vMax);
    var aMax = Number(o.aMax);
    var jMax = o.jMax !== undefined ? Number(o.jMax) : 100;

    if (!isFiniteNum(q0) || !isFiniteNum(q1) || Math.abs(q0) > MAX_ABS_VAL || Math.abs(q1) > MAX_ABS_VAL) {
      return err('invalid-distance');
    }
    var distance = q1 - q0;
    var absDistance = Math.abs(distance);
    if (!isFiniteNum(distance) || absDistance > MAX_ABS_VAL) {
      return err('invalid-distance');
    }
    if (absDistance > 0 && absDistance < MIN_POS_PARAM) {
      return err('extreme-scale', 'absDistance=' + absDistance);
    }
    if (!isFiniteNum(vMax) || vMax < MIN_POS_PARAM || vMax > MAX_ABS_VAL) {
      return err('invalid-vmax');
    }
    if (!isFiniteNum(aMax) || aMax < MIN_POS_PARAM || aMax > MAX_ABS_VAL) {
      return err('invalid-amax');
    }
    if (requireJerk && (!isFiniteNum(jMax) || jMax < MIN_POS_PARAM || jMax > MAX_ABS_VAL)) {
      return err('invalid-jmax');
    }
    return {
      ok: true,
      q0: q0,
      q1: q1,
      distance: distance,
      absDistance: absDistance,
      dir: distance >= 0 ? 1 : -1,
      vMax: vMax,
      aMax: aMax,
      jMax: jMax
    };
  }

  function buildSegmentsFromSpecs(specs, q0, dir) {
    var segments = [];
    var t = 0;
    var p = 0;
    var v = 0;
    var a = 0;
    for (var i = 0; i < specs.length; i++) {
      var sp = specs[i];
      var dt = sp.dt;
      var j = sp.j;
      var aStart = sp.aFixed !== undefined ? sp.aFixed : a;
      if (!isFiniteNum(dt) || dt < 0 || !isFiniteNum(j) || !isFiniteNum(aStart)) {
        return null;
      }
      segments.push({
        index: i + 1,
        label: sp.label,
        t0: t,
        t1: t + dt,
        dt: dt,
        p0: p,
        v0: v,
        a0: aStart,
        j: j
      });
      if (dt > 0) {
        p = p + v * dt + 0.5 * aStart * dt * dt + (1 / 6) * j * dt * dt * dt;
        v = v + aStart * dt + 0.5 * j * dt * dt;
        a = aStart + j * dt;
        t = t + dt;
        if (!isFiniteNum(p) || !isFiniteNum(v) || !isFiniteNum(a) || !isFiniteNum(t)) {
          return null;
        }
      } else {
        a = aStart;
      }
    }
    var rawEndPos = q0 + dir * p;
    var rawEndVel = dir * v;
    var rawEndAcc = dir * a;
    if (!isFiniteNum(rawEndPos) || !isFiniteNum(rawEndVel) || !isFiniteNum(rawEndAcc)) {
      return null;
    }
    return {
      segments: segments,
      totalTime: t,
      rawEndPos: rawEndPos,
      rawEndVel: rawEndVel,
      rawEndAcc: rawEndAcc
    };
  }

  /**
   * 轨迹求值：
   *   - 0 <= t < T：按右连续语义取分段值（内部边界取后一段的右极限）。
   *   - t === T：取最后有效段的终点左极限（包含梯形末端未修正加速度左极限）。
   *   - t > T：进入运动结束后的静止保持状态（q = q1, v = 0, a = 0, j = 0, finished = true）。
   */
  function evaluateProfile(profile, t) {
    if (!profile || !profile.ok) return null;
    var T = profile.totalTime;
    var segs = profile.segments;
    var q0 = profile.q0;
    var dir = profile.dir;

    if (T <= 0 || !segs.length) {
      return {
        t: 0,
        q: q0,
        v: 0,
        a: 0,
        j: 0,
        segmentIndex: 0,
        segmentLabel: '零位移',
        finished: true
      };
    }

    var tc = Number(t);
    if (!isFinite(tc) || tc < 0) tc = 0;

    if (tc > T) {
      return {
        t: tc,
        q: profile.q1,
        v: 0,
        a: 0,
        j: 0,
        segmentIndex: 0,
        segmentLabel: '运动结束（静止保持）',
        finished: true
      };
    }

    var activeSegs = [];
    for (var k = 0; k < segs.length; k++) {
      if (segs[k].dt > 0) activeSegs.push(segs[k]);
    }
    if (!activeSegs.length) {
      return {
        t: tc,
        q: q0,
        v: 0,
        a: 0,
        j: 0,
        segmentIndex: 0,
        segmentLabel: '零位移',
        finished: true
      };
    }

    var seg = activeSegs[activeSegs.length - 1];
    if (tc < T) {
      for (var i = 0; i < activeSegs.length; i++) {
        if (tc < activeSegs[i].t1) {
          seg = activeSegs[i];
          break;
        }
      }
    }

    var tau = tc - seg.t0;
    if (tau < 0) tau = 0;
    if (tau > seg.dt) tau = seg.dt;

    var p = seg.p0 + seg.v0 * tau + 0.5 * seg.a0 * tau * tau + (1 / 6) * seg.j * tau * tau * tau;
    var v = seg.v0 + seg.a0 * tau + 0.5 * seg.j * tau * tau;
    var a = seg.a0 + seg.j * tau;

    return {
      t: tc,
      q: q0 + dir * p,
      v: dir * v,
      a: dir * a,
      j: dir * seg.j,
      segmentIndex: seg.index,
      segmentLabel: seg.label,
      finished: false
    };
  }

  function planTrapezoidal(opts) {
    var p = validateParams(opts, false);
    if (!p.ok) return p;

    var L = p.absDistance;
    var vMax = p.vMax;
    var aMax = p.aMax;

    if (L === 0) {
      return {
        ok: true,
        algorithm: 'trapezoidal',
        regime: 'zero-distance',
        regimeLabel: '零位移（静止）',
        q0: p.q0,
        q1: p.q1,
        distance: 0,
        absDistance: 0,
        dir: 1,
        vMax: vMax,
        aMax: aMax,
        jMax: null,
        ta: 0,
        tv: 0,
        td: 0,
        totalTime: 0,
        vPeak: 0,
        aPeak: 0,
        jPeak: 0,
        segments: [],
        rawEndPos: p.q0,
        rawEndVel: 0,
        rawEndAcc: 0,
        endAccLeftLimit: 0,
        endPosResidual: 0,
        endVelResidual: 0,
        endAccResidual: 0
      };
    }

    var lCrit = (vMax * vMax) / aMax;
    if (!isFiniteNum(lCrit)) return err('extreme-scale');

    var ta, tv, td, vPeak, regime, regimeLabel;

    if (L >= lCrit * (1 - REL_EPS)) {
      ta = vMax / aMax;
      td = ta;
      tv = Math.max(0, (L - lCrit) / vMax);
      vPeak = vMax;
      var hasCruise = tv > ta * REL_EPS;
      regime = hasCruise ? '3-seg-trapezoid' : '2-seg-triangle-boundary';
      regimeLabel = hasCruise ? '三段梯形（达最大速度）' : '临界三角形（恰好达最大速度）';
    } else {
      vPeak = Math.sqrt(L * aMax);
      ta = vPeak / aMax;
      td = ta;
      tv = 0;
      regime = '2-seg-triangle';
      regimeLabel = '二段三角形（退化：未达最大速度）';
    }

    var built = buildSegmentsFromSpecs([
      { label: '匀加速段', dt: ta, j: 0, aFixed: aMax },
      { label: '匀速巡航段', dt: tv, j: 0, aFixed: 0 },
      { label: '匀减速段', dt: td, j: 0, aFixed: -aMax }
    ], p.q0, p.dir);

    if (!built || built.totalTime <= 0) {
      return err('extreme-scale');
    }

    return {
      ok: true,
      algorithm: 'trapezoidal',
      regime: regime,
      regimeLabel: regimeLabel,
      q0: p.q0,
      q1: p.q1,
      distance: p.distance,
      absDistance: L,
      dir: p.dir,
      vMax: vMax,
      aMax: aMax,
      jMax: null,
      ta: ta,
      tv: tv,
      td: td,
      totalTime: built.totalTime,
      vPeak: vPeak,
      aPeak: aMax,
      jPeak: null, // 非零位移梯形规划在边界处为理想冲激，无有限 jerk 峰值
      segments: built.segments,
      rawEndPos: built.rawEndPos,
      rawEndVel: built.rawEndVel,
      rawEndAcc: built.rawEndAcc,
      endAccLeftLimit: built.rawEndAcc,
      endPosResidual: Math.abs(built.rawEndPos - p.q1),
      endVelResidual: Math.abs(built.rawEndVel),
      endAccResidual: null // 梯形结束处存在理想加速度阶跃，不适用连续性残差
    };
  }

  function planSCurve(opts) {
    var p = validateParams(opts, true);
    if (!p.ok) return p;

    var L = p.absDistance;
    var vMax = p.vMax;
    var aMax = p.aMax;
    var jMax = p.jMax;

    if (L === 0) {
      return {
        ok: true,
        algorithm: 'scurve',
        regime: 'zero-distance',
        regimeLabel: '零位移（静止）',
        q0: p.q0,
        q1: p.q1,
        distance: 0,
        absDistance: 0,
        dir: 1,
        vMax: vMax,
        aMax: aMax,
        jMax: jMax,
        tj: 0,
        tc: 0,
        ta: 0,
        tv: 0,
        td: 0,
        totalTime: 0,
        vPeak: 0,
        aPeak: 0,
        jPeak: 0,
        segments: [],
        rawEndPos: p.q0,
        rawEndVel: 0,
        rawEndAcc: 0,
        endPosResidual: 0,
        endVelResidual: 0,
        endAccResidual: 0
      };
    }

    var vjProd = vMax * jMax;
    var aSq = aMax * aMax;
    if (!isFiniteNum(vjProd) || !isFiniteNum(aSq)) return err('extreme-scale');

    var hitsAMaxForVMax = vjProd >= aSq * (1 - REL_EPS);
    var lFull = hitsAMaxForVMax
      ? vMax * (vMax / aMax + aMax / jMax)
      : 2 * vMax * Math.sqrt(vMax / jMax);
    if (!isFiniteNum(lFull)) return err('extreme-scale');

    var tj, tc, tv, aPeak, vPeak, regime, regimeLabel;

    if (L >= lFull * (1 - REL_EPS)) {
      if (hitsAMaxForVMax) {
        tj = aMax / jMax;
        tc = Math.max(0, vMax / aMax - tj);
        aPeak = aMax;
      } else {
        tj = Math.sqrt(vMax / jMax);
        tc = 0;
        aPeak = jMax * tj;
      }
      vPeak = vMax;
      tv = Math.max(0, (L - lFull) / vMax);

      var timeScaleA = Math.max(tj, tc);
      var hasTc = tc > timeScaleA * REL_EPS;
      var hasTv = tv > Math.max(timeScaleA, tv) * REL_EPS;

      if (hasTc && hasTv) {
        regime = '7-seg-full';
        regimeLabel = '完整七段 S 曲线（达 vMax 与 aMax）';
      } else if (!hasTc && hasTv) {
        regime = '5-seg-no-const-acc';
        regimeLabel = '五段退化（达 vMax，未达 aMax）';
      } else if (hasTc && !hasTv) {
        regime = '6-seg-boundary';
        regimeLabel = '六段临界（恰好达 vMax 与 aMax，无巡航）';
      } else {
        regime = '4-seg-boundary';
        regimeLabel = '四段临界（恰好达 vMax，未达 aMax，无巡航）';
      }
    } else {
      tv = 0;
      var lAThresh = (2 * aMax * aMax * aMax) / (jMax * jMax);
      if (isFiniteNum(lAThresh) && L >= lAThresh * (1 - REL_EPS)) {
        tj = aMax / jMax;
        var disc = tj * tj + (4 * L) / aMax;
        var u = 0.5 * (-tj + Math.sqrt(Math.max(0, disc)));
        tc = Math.max(0, u - tj);
        aPeak = aMax;
        vPeak = aMax * (tj + tc);
        var hasTcNoCruise = tc > tj * REL_EPS;
        regime = hasTcNoCruise ? '6-seg-no-cruise' : '4-seg-a-boundary';
        regimeLabel = hasTcNoCruise ? '六段退化（达 aMax，未达 vMax，无巡航）' : '四段临界（恰好达 aMax，无匀加与巡航）';
      } else {
        tj = Math.cbrt(L / (2 * jMax));
        tc = 0;
        aPeak = jMax * tj;
        vPeak = jMax * tj * tj;
        regime = '4-seg-jerk-only';
        regimeLabel = '四段退化（未达 aMax 与 vMax，纯加/减加速）';
      }
    }

    var ta = 2 * tj + tc;
    var td = ta;
    var built = buildSegmentsFromSpecs([
      { label: '1. 加加速 (+J)', dt: tj, j: jMax },
      { label: '2. 匀加速 (0)', dt: tc, j: 0 },
      { label: '3. 减加速 (-J)', dt: tj, j: -jMax },
      { label: '4. 匀速巡航 (0)', dt: tv, j: 0 },
      { label: '5. 加减速 (-J)', dt: tj, j: -jMax },
      { label: '6. 匀减速 (0)', dt: tc, j: 0 },
      { label: '7. 减减速 (+J)', dt: tj, j: jMax }
    ], p.q0, p.dir);

    if (!built || built.totalTime <= 0) {
      return err('extreme-scale');
    }

    return {
      ok: true,
      algorithm: 'scurve',
      regime: regime,
      regimeLabel: regimeLabel,
      q0: p.q0,
      q1: p.q1,
      distance: p.distance,
      absDistance: L,
      dir: p.dir,
      vMax: vMax,
      aMax: aMax,
      jMax: jMax,
      tj: tj,
      tc: tc,
      ta: ta,
      tv: tv,
      td: td,
      totalTime: built.totalTime,
      vPeak: vPeak,
      aPeak: aPeak,
      jPeak: jMax,
      segments: built.segments,
      rawEndPos: built.rawEndPos,
      rawEndVel: built.rawEndVel,
      rawEndAcc: built.rawEndAcc,
      endPosResidual: Math.abs(built.rawEndPos - p.q1),
      endVelResidual: Math.abs(built.rawEndVel),
      endAccResidual: Math.abs(built.rawEndAcc)
    };
  }

  /**
   * 采样曲线：
   *   - opts 可传入数字（采样数）或对象 { count, dt }。
   *   - 必定包含 t=0、所有有效阶段的边界点 t1 与终点 T。
   *   - 采样总数上限 MAX_SAMPLES = 2000，防止过大数组阻塞渲染。
   */
  function sampleProfile(profile, opts) {
    if (!profile || !profile.ok) return [];
    var T = profile.totalTime;
    if (T <= 0) {
      return [evaluateProfile(profile, 0), evaluateProfile(profile, 0)];
    }

    var count = 200;
    if (typeof opts === 'number') {
      count = opts;
    } else if (opts && typeof opts === 'object') {
      if (opts.dt !== undefined && isFiniteNum(Number(opts.dt)) && Number(opts.dt) > 0) {
        count = Math.ceil(T / Number(opts.dt));
      } else if (opts.count !== undefined) {
        count = Number(opts.count);
      }
    }
    var n = Math.max(2, Math.min(MAX_SAMPLES - 10, Math.floor(count || 200)));

    var times = [0, T];
    var segs = profile.segments || [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].dt > 0) {
        times.push(segs[i].t0);
        times.push(segs[i].t1);
      }
    }
    for (var k = 1; k < n; k++) {
      times.push((T * k) / n);
    }

    times.sort(function (a, b) { return a - b; });
    var unique = [];
    var tol = T * REL_EPS;
    for (var u = 0; u < times.length; u++) {
      if (!unique.length || times[u] - unique[unique.length - 1] > tol) {
        unique.push(times[u]);
      }
    }
    if (unique[unique.length - 1] < T) unique[unique.length - 1] = T;
    if (unique.length > MAX_SAMPLES) {
      unique = unique.slice(0, MAX_SAMPLES - 1).concat([T]);
    }

    var pts = [];
    for (var m = 0; m < unique.length; m++) {
      pts.push(evaluateProfile(profile, unique[m]));
    }
    return pts;
  }

  function compareProfiles(opts) {
    var trap = planTrapezoidal(opts);
    if (!trap.ok) return trap;
    var scurve = planSCurve(opts);
    if (!scurve.ok) return scurve;

    var dt = scurve.totalTime - trap.totalTime;
    var ratio = trap.totalTime > 0 ? scurve.totalTime / trap.totalTime : 1;

    return {
      ok: true,
      q0: scurve.q0,
      q1: scurve.q1,
      distance: scurve.distance,
      vMax: scurve.vMax,
      aMax: scurve.aMax,
      jMax: scurve.jMax,
      trapezoidal: trap,
      scurve: scurve,
      timeDelta: dt,
      timeRatio: ratio
    };
  }

  function scenarioList() {
    return [
      {
        id: 'full-7seg',
        name: '完整七段 S 曲线（长行程）',
        note: '行程足够长，同时达到 vMax 与 aMax，存在匀加速与匀速巡航段。',
        params: { q0: 0, q1: 120, vMax: 40, aMax: 80, jMax: 400 }
      },
      {
        id: '6seg-no-cruise',
        name: '六段退化（无匀速巡航）',
        note: '行程较短，达到 aMax 但未及达到 vMax 即开始减速（Tv = 0）。',
        params: { q0: 0, q1: 20, vMax: 40, aMax: 80, jMax: 400 }
      },
      {
        id: '5seg-no-const-acc',
        name: '五段退化（未达最大加速度）',
        note: 'jMax 较小或 vMax 较低，未达到 aMax 就已达到 vMax（Tc = 0，Tv > 0）。',
        params: { q0: 0, q1: 100, vMax: 20, aMax: 100, jMax: 200 }
      },
      {
        id: '4seg-jerk-only',
        name: '四段退化（短行程纯加减加速）',
        note: '极短行程，既未达到 aMax 也未达到 vMax（Tc = 0，Tv = 0）。',
        params: { q0: 0, q1: 2, vMax: 40, aMax: 80, jMax: 200 }
      },
      {
        id: 'strict-jerk',
        name: '严格 Jerk 限制（超平滑慢启动）',
        note: '受严格 jMax = 25 约束，全程不进入匀加速平台，平滑过渡耗时明显大于梯形规划。',
        params: { q0: 0, q1: 80, vMax: 30, aMax: 60, jMax: 25 }
      },
      {
        id: 'reverse-motion',
        name: '反向负位移（q0 > q1）',
        note: '从 50 运动到 -30（D = -80），检验符号方向与终点残差。',
        params: { q0: 50, q1: -30, vMax: 35, aMax: 70, jMax: 350 }
      }
    ];
  }

  var api = {
    VERSION: VERSION,
    MAX_SAMPLES: MAX_SAMPLES,
    MIN_POS_PARAM: MIN_POS_PARAM,
    MAX_ABS_VAL: MAX_ABS_VAL,
    ERROR_TEXT: ERROR_TEXT,
    validateParams: validateParams,
    planTrapezoidal: planTrapezoidal,
    planSCurve: planSCurve,
    evaluateProfile: evaluateProfile,
    sampleProfile: sampleProfile,
    compareProfiles: compareProfiles,
    scenarioList: scenarioList
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.MotionProfile = api;
})(typeof window !== 'undefined' ? window : globalThis);
