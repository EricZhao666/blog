/* 梯形与七段 S 曲线运动轨迹规划 —— 纯计算模块（无 DOM、无 IO、确定性、可 Node require）
 *
 * 范围：单轴点对点（Rest-to-Rest，v0 = v1 = 0, a0 = a1 = 0）运动轨迹规划。
 *   1. 三段梯形速度规划（Trapezoidal）：加速度有界 |a| <= aMax，速度有界 |v| <= vMax；
 *      位移不足时自动退化为二段三角形（Tv = 0）。
 *   2. 七段对称 S 曲线规划（7-Segment S-Curve）：加加速度有界 |j| <= jMax，
 *      加速度有界 |a| <= aMax，速度有界 |v| <= vMax；
 *      严格覆盖全部退化工况：
 *        - zero-distance（D = 0）
 *        - 7-seg（达 vMax 且达 aMax，Tv > 0, Tc > 0）
 *        - 6-seg（未达 vMax 但达 aMax，Tv = 0, Tc > 0）
 *        - 5-seg（达 vMax 但未达 aMax，Tv >= 0, Tc = 0）
 *        - 4-seg（未达 vMax 且未达 aMax，Tv = 0, Tc = 0）
 *
 * 数值契约：
 *   - 分段边界状态 (t_k, p_k, v_k, a_k) 由上一段闭式积分精确递推。
 *   - 终点状态 rawEndPos / rawEndVel / rawEndAcc 直接由分段公式求值，不做强制归零或夹取，
 *     以便外部观测真实的未修正数值残差。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var EPS = 1e-12;
  var MAX_ABS_VAL = 1e9;

  var ERROR_TEXT = {
    'invalid-distance': '位移参数非法：起点、终点或位移必须是有限数值，且绝对值不超过 1e9。',
    'invalid-vmax': '最大速度 vMax 非法：必须是大于 0 的有限数值。',
    'invalid-amax': '最大加速度 aMax 非法：必须是大于 0 的有限数值。',
    'invalid-jmax': '最大加加速度 jMax 非法：必须是大于 0 的有限数值。'
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

    if (!isFiniteNum(q0) || !isFiniteNum(q1) || Math.abs(q1 - q0) > MAX_ABS_VAL || Math.abs(q0) > MAX_ABS_VAL || Math.abs(q1) > MAX_ABS_VAL) {
      return err('invalid-distance');
    }
    if (!isFiniteNum(vMax) || vMax <= 0 || vMax > MAX_ABS_VAL) {
      return err('invalid-vmax');
    }
    if (!isFiniteNum(aMax) || aMax <= 0 || aMax > MAX_ABS_VAL) {
      return err('invalid-amax');
    }
    if (requireJerk && (!isFiniteNum(jMax) || jMax <= 0 || jMax > MAX_ABS_VAL)) {
      return err('invalid-jmax');
    }
    return {
      ok: true,
      q0: q0,
      q1: q1,
      distance: q1 - q0,
      absDistance: Math.abs(q1 - q0),
      dir: (q1 - q0) >= 0 ? 1 : -1,
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
      } else {
        a = aStart;
      }
    }
    return {
      segments: segments,
      totalTime: t,
      rawEndPos: q0 + dir * p,
      rawEndVel: dir * v,
      rawEndAcc: dir * a
    };
  }

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
        segmentLabel: '零位移'
      };
    }

    var tc = Number(t);
    if (!isFinite(tc) || tc < 0) tc = 0;
    if (tc > T) tc = T;

    var seg = segs[segs.length - 1];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].dt > 0 && tc <= segs[i].t1 + EPS) {
        seg = segs[i];
        break;
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
      segmentLabel: seg.label
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
        jMax: Infinity,
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

    var lCrit = (vMax * vMax) / aMax;
    var ta, tv, td, vPeak, regime, regimeLabel;

    if (L >= lCrit - EPS) {
      ta = vMax / aMax;
      td = ta;
      tv = Math.max(0, (L - lCrit) / vMax);
      vPeak = vMax;
      regime = tv > EPS ? '3-seg-trapezoid' : '2-seg-triangle-boundary';
      regimeLabel = tv > EPS ? '三段梯形（达最大速度）' : '临界三角形（恰好达最大速度）';
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
      jMax: Infinity,
      ta: ta,
      tv: tv,
      td: td,
      totalTime: built.totalTime,
      vPeak: vPeak,
      aPeak: aMax,
      jPeak: Infinity,
      segments: built.segments,
      rawEndPos: built.rawEndPos,
      rawEndVel: built.rawEndVel,
      rawEndAcc: built.rawEndAcc,
      endPosResidual: Math.abs(built.rawEndPos - p.q1),
      endVelResidual: Math.abs(built.rawEndVel),
      endAccResidual: 0
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

    var hitsAMaxForVMax = vMax * jMax >= aMax * aMax - EPS;
    var lFull = hitsAMaxForVMax
      ? vMax * (vMax / aMax + aMax / jMax)
      : 2 * vMax * Math.sqrt(vMax / jMax);

    var tj, tc, tv, aPeak, vPeak, regime, regimeLabel;

    if (L >= lFull - EPS) {
      // 巡航段存在（或恰处于 Tv=0 边界）：达到 vMax
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

      if (tc > EPS && tv > EPS) {
        regime = '7-seg-full';
        regimeLabel = '完整七段 S 曲线（达 vMax 与 aMax）';
      } else if (tc <= EPS && tv > EPS) {
        regime = '5-seg-no-const-acc';
        regimeLabel = '五段退化（达 vMax，未达 aMax）';
      } else if (tc > EPS && tv <= EPS) {
        regime = '6-seg-boundary';
        regimeLabel = '六段临界（恰好达 vMax 与 aMax，无巡航）';
      } else {
        regime = '4-seg-boundary';
        regimeLabel = '四段临界（恰好达 vMax，未达 aMax，无巡航）';
      }
    } else {
      // 无巡航段（Tv = 0）：未达到 vMax
      tv = 0;
      var lAThresh = (2 * aMax * aMax * aMax) / (jMax * jMax);
      if (L >= lAThresh - EPS) {
        // 达到 aMax 但未达到 vMax -> 6 段
        tj = aMax / jMax;
        var disc = tj * tj + (4 * L) / aMax;
        var u = 0.5 * (-tj + Math.sqrt(Math.max(0, disc)));
        tc = Math.max(0, u - tj);
        aPeak = aMax;
        vPeak = aMax * (tj + tc);
        regime = tc > EPS ? '6-seg-no-cruise' : '4-seg-a-boundary';
        regimeLabel = tc > EPS ? '六段退化（达 aMax，未达 vMax，无巡航）' : '四段临界（恰好达 aMax，无匀加与巡航）';
      } else {
        // 既未达到 aMax 也未达到 vMax -> 4 段
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

  function sampleProfile(profile, count) {
    if (!profile || !profile.ok) return [];
    var n = Math.max(2, Math.min(2000, Math.floor(count || 200)));
    var T = profile.totalTime;
    var pts = [];
    if (T <= 0) {
      pts.push(evaluateProfile(profile, 0));
      pts.push(evaluateProfile(profile, 0));
      return pts;
    }
    for (var i = 0; i <= n; i++) {
      var t = (T * i) / n;
      pts.push(evaluateProfile(profile, t));
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
        id: 'reverse-motion',
        name: '反向负位移（q0 > q1）',
        note: '从 50 运动到 -30（D = -80），检验符号方向与终点残差。',
        params: { q0: 50, q1: -30, vMax: 35, aMax: 70, jMax: 350 }
      }
    ];
  }

  var api = {
    VERSION: VERSION,
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
