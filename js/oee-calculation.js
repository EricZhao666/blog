/**
 * Batch 9C-1C：OEE 工业生产效率与损失分析 —— 纯计算模块（无 IO、无存储、无定时器、确定性）
 *
 * 统一口径（详见 OEE_CALCULATION_MATH.md）：
 *   Planned Production Time（计划生产时间）：已排除不计划生产的时间（休息/计划停机等），
 *     因此停机损失只扣减一次，不得把同一停机重复扣减。
 *   Run Time = Planned − Downtime
 *   Availability = Run Time / Planned
 *   Performance  = Ideal Cycle Time × Total Count / Run Time
 *   Quality      = Good Count / Total Count
 *   OEE          = Availability × Performance × Quality
 *   交叉验证（分母有效时）：OEE = Ideal Cycle Time × Good Count / Planned
 *
 * 单位契约：UI 可用分钟/秒，本模块内部一律换算成秒显式计算：
 *   plannedSec = plannedMin × 60；downtimeSec = downtimeMin × 60。
 *
 * 多穴模具：输入理想机器周期 idealCycleSec（秒/周期）与每周期理论产出件数 cavities，
 *   理想单件周期 idealPartSec = idealCycleSec / cavities。
 *   总产量/合格产量统一使用「件数」而非模次；穴数只在此处除一次，不得重复乘除。
 *
 * 时间等效损失分解（守恒）：
 *   停机损失   = Planned − Run
 *   性能损失   = Run − idealPartSec × Total（Performance>100% 时为负，不截断）
 *   质量损失   = idealPartSec × (Total − Good)
 *   有效生产时间 = idealPartSec × Good
 *   Planned = 停机损失 + 性能损失 + 质量损失 + 有效生产时间（代数恒等，数值验证）
 *
 * 异常口径：
 *   分母为零 → 对应指标 null（UI 显示「不适用」），绝不返回 NaN/Infinity/虚构 100%。
 *   计划时间有效且无合格产出 → OEE 按时间公式 = 0，但 A/P/Q 各自是否可定义分别判断。
 *   运行时间为零却存在产量 → 标记 inconsistent-data，OEE 置 null（数据不可信）。
 *   Performance>100% → 保留真实值并标记 performance-over-100，chartSafe=false，
 *     不渲染误导性的非负损失堆叠图。
 *
 * 改善情景：compareScenarios 做实际输入对比；projectDowntimeReduction 是**假设预测**
 *   （显式假设性能开动率、良品率、理想周期不变），不宣称为已验证生产收益。
 * 可被 Node 直接 require。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MAX_PLANNED_MIN = 1e6;      // 计划时间上限（分钟），防无界/溢出输入
  var MAX_COUNT = 1e9;            // 件数上限
  var MAX_CAVITIES = 1024;
  var MAX_CYCLE_SEC = 86400;
  var REL_EPS = 1e-9;             // 相对数值容差（守恒/交叉验证）

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isNonNegInt(v) {
    return isFiniteNumber(v) && v >= 0 && Math.floor(v) === v;
  }

  /** 参数校验：物理非法一律拒绝（ok:false + 错误码），不产生 NaN/误导性结果。 */
  function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: 'invalid-config', message: '配置必须是对象' };
    }
    if (!isFiniteNumber(cfg.plannedMin) || cfg.plannedMin < 0 || cfg.plannedMin > MAX_PLANNED_MIN) {
      return { ok: false, error: 'invalid-planned', message: '计划生产时间必须是 0–' + MAX_PLANNED_MIN + ' 分钟的有限数字' };
    }
    if (!isFiniteNumber(cfg.downtimeMin) || cfg.downtimeMin < 0) {
      return { ok: false, error: 'invalid-downtime', message: '停机时间必须是非负有限数字' };
    }
    if (cfg.downtimeMin > cfg.plannedMin) {
      return { ok: false, error: 'downtime-exceeds-planned', message: '停机时间不能超过计划生产时间（同一停机不得重复扣减）' };
    }
    if (!isFiniteNumber(cfg.idealCycleSec) || cfg.idealCycleSec <= 0 || cfg.idealCycleSec > MAX_CYCLE_SEC) {
      return { ok: false, error: 'invalid-cycle', message: '理想机器周期必须是 (0, ' + MAX_CYCLE_SEC + '] 秒的有限数字' };
    }
    if (!isNonNegInt(cfg.cavities) || cfg.cavities < 1 || cfg.cavities > MAX_CAVITIES) {
      return { ok: false, error: 'invalid-cavities', message: '每周期产出件数（穴数）必须是 1–' + MAX_CAVITIES + ' 的整数' };
    }
    if (!isNonNegInt(cfg.totalCount) || cfg.totalCount > MAX_COUNT) {
      return { ok: false, error: 'invalid-count', message: '总产量必须是 0–' + MAX_COUNT + ' 的整数（件数，非模次）' };
    }
    if (!isNonNegInt(cfg.goodCount) || cfg.goodCount > MAX_COUNT) {
      return { ok: false, error: 'invalid-count', message: '合格数量必须是 0–' + MAX_COUNT + ' 的整数（件数）' };
    }
    if (cfg.goodCount > cfg.totalCount) {
      return { ok: false, error: 'good-exceeds-total', message: '合格数量不能超过总产量' };
    }
    return {
      ok: true,
      config: {
        plannedMin: cfg.plannedMin,
        downtimeMin: cfg.downtimeMin,
        idealCycleSec: cfg.idealCycleSec,
        cavities: cfg.cavities,
        totalCount: cfg.totalCount,
        goodCount: cfg.goodCount
      }
    };
  }

  /**
   * 主计算。成功返回指标、损失分解、交叉验证与口径标记；
   * 分母为零的指标为 null（不适用），绝不 NaN/Infinity/虚构 100%。
   */
  function compute(cfg) {
    var v = validateConfig(cfg);
    if (!v.ok) return v;
    var c = v.config;

    // 显式单位换算：分钟 → 秒
    var plannedSec = c.plannedMin * 60;
    var downtimeSec = c.downtimeMin * 60;
    var runSec = plannedSec - downtimeSec;
    var idealPartSec = c.idealCycleSec / c.cavities;   // 穴数只除一次

    var flags = [];
    if (c.plannedMin === 0) flags.push('zero-planned');
    if (runSec === 0 && c.plannedMin > 0) flags.push('zero-run-time');
    if (runSec === 0 && c.totalCount > 0) flags.push('inconsistent-data');
    if (c.totalCount === 0 && c.plannedMin > 0) flags.push('no-output');

    var availability = plannedSec > 0 ? runSec / plannedSec : null;
    var performance = runSec > 0 ? idealPartSec * c.totalCount / runSec : null;
    var quality = c.totalCount > 0 ? c.goodCount / c.totalCount : null;

    if (performance !== null && performance > 1 + REL_EPS) flags.push('performance-over-100');

    // 两种 OEE 口径：乘积式与时间式（分母有效时交叉验证）
    var oeeProduct = (availability !== null && performance !== null && quality !== null)
      ? availability * performance * quality : null;
    var oeeTime = plannedSec > 0 ? idealPartSec * c.goodCount / plannedSec : null;
    var inconsistent = flags.indexOf('inconsistent-data') !== -1;
    // 无合格产出但计划时间有效：OEE 按时间公式 = 0；数据不一致时 OEE 不可信 → null
    var oee = inconsistent ? null : (oeeProduct !== null ? oeeProduct : oeeTime);
    var crossDelta = (oeeProduct !== null && oeeTime !== null)
      ? Math.abs(oeeProduct - oeeTime) : null;

    // 理论产能：计划时间口径 / 实际运行时间口径
    var theoreticalPlanned = plannedSec > 0 ? plannedSec / idealPartSec : null;
    var theoreticalRun = runSec > 0 ? runSec / idealPartSec : 0;

    // 时间等效损失（性能损失在 P>100% 时为负，如实保留，不截断）
    var losses = {
      downtimeSec: plannedSec - runSec,
      performanceSec: runSec - idealPartSec * c.totalCount,
      qualitySec: idealPartSec * (c.totalCount - c.goodCount),
      effectiveSec: idealPartSec * c.goodCount
    };
    var sum = losses.downtimeSec + losses.performanceSec + losses.qualitySec + losses.effectiveSec;
    var tol = REL_EPS * Math.max(1, plannedSec);
    var conservationDelta = Math.abs(sum - plannedSec);

    // 堆叠图安全性：负性能损失/不一致数据/零计划时间下不渲染非负堆叠图
    var chartSafe = plannedSec > 0 && !inconsistent &&
      flags.indexOf('performance-over-100') === -1 &&
      losses.performanceSec >= -tol && losses.qualitySec >= -tol;

    return {
      ok: true,
      config: c,
      plannedSec: plannedSec,
      downtimeSec: downtimeSec,
      runSec: runSec,
      idealPartSec: idealPartSec,
      availability: availability,
      performance: performance,
      quality: quality,
      oee: oee,
      oeeProduct: oeeProduct,
      oeeTime: oeeTime,
      crossDelta: crossDelta,
      theoreticalPlanned: theoreticalPlanned,
      theoreticalRun: theoreticalRun,
      rejectCount: c.totalCount - c.goodCount,
      losses: losses,
      conservationDelta: conservationDelta,
      conservationOk: conservationDelta <= tol,
      flags: flags,
      chartSafe: chartSafe
    };
  }

  /** A/B 实际输入对比（不是预测）。任一配置非法则拒绝。 */
  function compareScenarios(cfgA, cfgB) {
    var a = compute(cfgA), b = compute(cfgB);
    if (!a.ok) return { ok: false, error: 'invalid-a', message: '基准情景 A 非法：' + a.message };
    if (!b.ok) return { ok: false, error: 'invalid-b', message: '情景 B 非法：' + b.message };
    function pp(x, y) { return (x !== null && y !== null) ? (y - x) * 100 : null; }
    function dMin(x, y) { return (y - x) / 60; }
    return {
      ok: true,
      a: a,
      b: b,
      deltas: {
        oeePP: pp(a.oee, b.oee),
        availabilityPP: pp(a.availability, b.availability),
        performanceLossDeltaMin: dMin(a.losses.performanceSec, b.losses.performanceSec),
        qualityLossDeltaMin: dMin(a.losses.qualitySec, b.losses.qualitySec),
        downtimeLossDeltaMin: dMin(a.losses.downtimeSec, b.losses.downtimeSec),
        effectiveDeltaMin: dMin(a.losses.effectiveSec, b.losses.effectiveSec),
        goodDelta: b.config.goodCount - a.config.goodCount,
        totalDelta: b.config.totalCount - a.config.totalCount,
        samePlanned: a.config.plannedMin === b.config.plannedMin,
        plannedDeltaMin: b.config.plannedMin - a.config.plannedMin
      }
    };
  }

  /**
   * 假设预测：停机减少到 newDowntimeMin 后的产量投影。
   * 显式假设：性能开动率 P、良品率 Q、理想单件周期保持不变。
   * 这是理论估计（可为小数），不是已验证的生产收益。
   */
  function projectDowntimeReduction(cfg, newDowntimeMin) {
    var base = compute(cfg);
    if (!base.ok) return { ok: false, error: 'invalid-config', message: base.message };
    if (!isFiniteNumber(newDowntimeMin) || newDowntimeMin < 0 || newDowntimeMin > base.config.plannedMin) {
      return { ok: false, error: 'invalid-projection-downtime', message: '假设停机时间必须在 0 到计划生产时间之间' };
    }
    if (base.performance === null || base.quality === null || base.runSec <= 0) {
      return { ok: false, error: 'projection-unavailable', message: '当前数据无法定义性能开动率/良品率（零运行时间或零产量），无法投影' };
    }
    var runB = base.plannedSec - newDowntimeMin * 60;
    var totalB = base.performance * runB / base.idealPartSec;   // P 不变
    var goodB = base.quality * totalB;                          // Q 不变
    return {
      ok: true,
      kind: 'assumption-projection',
      assumptions: ['performance-constant', 'quality-constant', 'ideal-cycle-constant'],
      disclaimer: '假设预测：性能开动率、良品率、理想周期保持不变；非已验证生产收益',
      base: { downtimeMin: base.config.downtimeMin, totalCount: base.config.totalCount, goodCount: base.config.goodCount },
      projected: {
        downtimeMin: newDowntimeMin,
        runMin: runB / 60,
        totalCount: totalB,
        goodCount: goodB,
        oee: base.plannedSec > 0 ? base.idealPartSec * goodB / base.plannedSec : null
      },
      deltaTotal: totalB - base.config.totalCount,
      deltaGood: goodB - base.config.goodCount
    };
  }

  // 教学示例（明确标注为教学情景，不代表任何真实公司生产成果）
  var EXAMPLES = [
    {
      id: 'single', name: '单穴注塑机（教学示例）',
      note: '基础验证样例：450 分钟计划 / 45 分钟停机 / 30 秒单件周期 / 720 件 / 684 件合格',
      config: { plannedMin: 450, downtimeMin: 45, idealCycleSec: 30, cavities: 1, totalCount: 720, goodCount: 684 }
    },
    {
      id: 'multi', name: '多穴注塑机（教学示例）',
      note: '4 穴模具：理想机器周期 20 秒/模 → 理想单件周期 5 秒；产量按件数统计',
      config: { plannedMin: 480, downtimeMin: 60, idealCycleSec: 20, cavities: 4, totalCount: 4200, goodCount: 4095 }
    },
    {
      id: 'line', name: '冲压/自动装配线（教学示例）',
      note: '连续冲压/装配线理想节拍 6 秒/件，单件流（穴数=1）',
      config: { plannedMin: 420, downtimeMin: 30, idealCycleSec: 6, cavities: 1, totalCount: 3600, goodCount: 3564 }
    }
  ];
  var DEFAULTS = EXAMPLES[0].config;

  var api = {
    VERSION: VERSION,
    REL_EPS: REL_EPS,
    MAX_PLANNED_MIN: MAX_PLANNED_MIN,
    MAX_COUNT: MAX_COUNT,
    DEFAULTS: DEFAULTS,
    EXAMPLES: EXAMPLES,
    validateConfig: validateConfig,
    compute: compute,
    compareScenarios: compareScenarios,
    projectDowntimeReduction: projectDowntimeReduction
  };

  global.OeeCalculation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);