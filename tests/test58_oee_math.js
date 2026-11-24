#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1C：OEE 数学与数据口径专项（无浏览器，直接 require 真实 js/oee-calculation.js）
 *
 * 覆盖：统一口径 A/P/Q/OEE 公式 / 两种 OEE 计算方式交叉验证 / 单穴与多穴（穴数不重复乘除）/
 * 时间单位显式换算 / 损失分解守恒 / 产量与时间边界（零计划/零运行/零产量/零不合格）/
 * Performance>100% 不截断 / 不一致数据 / 非法输入拒绝 / A-B 实际对比与假设投影 /
 * 确定性与随机合法输入性质 / 极大数值。
 *
 * 基准样例期望值全部是**独立硬编码数值**（450/45/30s/720/684 → 90%/88.888889%/95%/76%，
 * 损失 45/45/18/342 分钟），不由被测算法自身生成。
 *
 * 用法：node tests/test58_oee_math.js
 */
const path = require('path');
const O = require(path.resolve(__dirname, '..', 'js', 'oee-calculation.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
function near(a, b, eps) { return Math.abs(a - b) <= eps; }
const BASE = { plannedMin: 450, downtimeMin: 45, idealCycleSec: 30, cavities: 1, totalCount: 720, goodCount: 684 };
function cfg(over) { return Object.assign({}, BASE, over || {}); }
function calc(over) { return O.compute(cfg(over)); }

// ================================================================ K1 基准样例（独立硬编码期望）
{
  const r = calc();
  check('K1.1 Availability = 405/450 = 90%（精确）', r.ok && near(r.availability, 0.9, 1e-12), 'A=' + r.availability);
  check('K1.2 Performance = 30×720/24300 = 88.888889%（= 8/9）', near(r.performance, 8 / 9, 1e-12), 'P=' + r.performance);
  check('K1.3 Quality = 684/720 = 95%（精确）', near(r.quality, 0.95, 1e-12), 'Q=' + r.quality);
  check('K1.4 OEE = 0.9×(8/9)×0.95 = 76%', near(r.oee, 0.76, 1e-12), 'OEE=' + r.oee);
  check('K1.5 交叉验证：OEE = 30×684/27000 = 76%，偏差 <1e-12',
    near(r.oeeTime, 0.76, 1e-12) && r.crossDelta < 1e-12, 'crossΔ=' + r.crossDelta.toExponential(2));
  check('K1.6 停机损失 45 分钟', near(r.losses.downtimeSec / 60, 45, 1e-9));
  check('K1.7 性能损失 45 分钟', near(r.losses.performanceSec / 60, 45, 1e-9));
  check('K1.8 质量损失 18 分钟', near(r.losses.qualitySec / 60, 18, 1e-9));
  check('K1.9 有效生产时间 342 分钟', near(r.losses.effectiveSec / 60, 342, 1e-9));
  check('K1.10 守恒：45+45+18+342 = 450 分钟（偏差 <1e-9 秒）',
    r.conservationOk && r.conservationDelta < 1e-9, 'Δ=' + r.conservationDelta.toExponential(2));
  check('K1.11 理论产能：计划口径 900 件、运行口径 810 件；不合格 36 件',
    near(r.theoreticalPlanned, 900, 1e-9) && near(r.theoreticalRun, 810, 1e-9) && r.rejectCount === 36);
  check('K1.12 正常数据无口径标记、堆叠图安全', r.flags.length === 0 && r.chartSafe === true);
}

// ================================================================ K2 多穴模具（穴数只除一次）
{
  const multi = calc({ idealCycleSec: 20, cavities: 4, totalCount: 4200, goodCount: 4095, plannedMin: 480, downtimeMin: 60 });
  check('K2.1 理想单件周期 = 20/4 = 5 秒', near(multi.idealPartSec, 5, 1e-12));
  check('K2.2 多穴 P = 5×4200/25200 = 83.3333%（按件数，不重复乘除穴数）',
    near(multi.performance, 21000 / 25200, 1e-12), 'P=' + multi.performance);
  check('K2.3 多穴 OEE = 0.875×(5/6)×0.975 = 71.09375%',
    near(multi.oee, 0.7109375, 1e-12), 'OEE=' + multi.oee);
  // 等价单穴表述：理想单件周期 5 秒、cavities=1 → 全部结果逐字段一致
  const equiv = calc({ idealCycleSec: 5, cavities: 1, totalCount: 4200, goodCount: 4095, plannedMin: 480, downtimeMin: 60 });
  check('K2.4 多穴与等价单穴（5 秒/件）结果完全一致（穴数不重复计入）',
    near(multi.oee, equiv.oee, 0) && near(multi.performance, equiv.performance, 0) &&
    near(multi.losses.performanceSec, equiv.losses.performanceSec, 0) &&
    near(multi.losses.effectiveSec, equiv.losses.effectiveSec, 0));
  const two = calc({ idealCycleSec: 10, cavities: 2 });
  check('K2.5 双穴：理想单件周期 5 秒，P = 5×720/24300 = 14.81%（件数口径）',
    near(two.idealPartSec, 5, 1e-12) && near(two.performance, 3600 / 24300, 1e-12));
}

// ================================================================ K3 单位换算
{
  const r = calc({ plannedMin: 0.1, downtimeMin: 0, idealCycleSec: 1, totalCount: 6, goodCount: 6 });
  check('K3.1 分钟→秒显式换算：0.1 分钟 = 6 秒（相对误差 <1e-9）',
    near(r.plannedSec, 6, 6e-9) && near(r.runSec, 6, 6e-9));
  check('K3.2 秒口径 P = 1×6/6 = 100%', near(r.performance, 1, 1e-9), 'P=' + r.performance);
  const big = calc({ plannedMin: 60, downtimeMin: 0, idealCycleSec: 60, totalCount: 60, goodCount: 60 });
  check('K3.3 60 分钟计划、60 秒周期、60 件：P=100%、OEE=100%（单位一致）',
    near(big.performance, 1, 1e-12) && near(big.oee, 1, 1e-12));
}

// ================================================================ K4 边界：零计划/零运行/零产量/零不合格
{
  const z = calc({ plannedMin: 0, downtimeMin: 0, totalCount: 0, goodCount: 0 });
  check('K4.1 计划时间为零：A/OEE=null（不适用），无 NaN/Infinity/虚构 100%',
    z.ok && z.availability === null && z.oee === null && z.oeeTime === null &&
    z.flags.indexOf('zero-planned') !== -1 && z.chartSafe === false);
  const zr = calc({ downtimeMin: 450, totalCount: 0, goodCount: 0 });
  check('K4.2 停机=计划（运行时间 0、无产量）：A=0、P=null、Q=null、OEE=0（时间公式）',
    zr.availability === 0 && zr.performance === null && zr.quality === null && zr.oee === 0 &&
    zr.flags.indexOf('zero-run-time') !== -1);
  const no = calc({ totalCount: 0, goodCount: 0 });
  check('K4.3 计划有效但零产量：Q=null（不适用）、P=0、OEE=0（按有效生产时间公式），各指标分别判断',
    no.quality === null && no.performance === 0 && no.oee === 0 && no.availability === 0.9 &&
    no.flags.indexOf('no-output') !== -1);
  const allGood = calc({ goodCount: 720 });
  check('K4.4 不合格为零：Q=100%、质量损失 0、OEE=A×P',
    near(allGood.quality, 1, 1e-12) && allGood.losses.qualitySec === 0 &&
    near(allGood.oee, 0.9 * (8 / 9), 1e-12));
  const noneGood = calc({ goodCount: 0 });
  check('K4.5 全部不合格：Q=0、OEE=0、质量损失=理想周期×总件数',
    noneGood.quality === 0 && noneGood.oee === 0 &&
    near(noneGood.losses.qualitySec, 30 * 720, 1e-9));
}

// ================================================================ K5 不一致数据与 Performance>100%
{
  const inc = calc({ downtimeMin: 450, totalCount: 100, goodCount: 90 });
  check('K5.1 运行时间为零却有产量：标记 inconsistent-data，OEE=null（不编造）',
    inc.flags.indexOf('inconsistent-data') !== -1 && inc.oee === null &&
    inc.performance === null && inc.chartSafe === false);
  const over = calc({ totalCount: 900, goodCount: 855 });
  check('K5.2 Performance>100% 如实保留（=10/9），不截断为 100%',
    near(over.performance, 10 / 9, 1e-12) && over.performance > 1, 'P=' + over.performance);
  check('K5.3 性能损失为负（−45 分钟）如实保留，chartSafe=false（不渲染非负堆叠图）',
    near(over.losses.performanceSec / 60, -45, 1e-9) && over.chartSafe === false &&
    over.flags.indexOf('performance-over-100') !== -1);
  check('K5.4 守恒在 P>100% 时仍成立（负损失参与求和）',
    over.conservationOk && over.conservationDelta < 1e-9);
  const edge = calc({ totalCount: 810, goodCount: 769 });
  check('K5.5 恰好满理论产能（810 件）：P=100%、性能损失 0、无超 100% 标记',
    near(edge.performance, 1, 1e-12) && near(edge.losses.performanceSec, 0, 1e-9) &&
    edge.flags.indexOf('performance-over-100') === -1);
}

// ================================================================ K6 非法输入拒绝
{
  const bad = [
    [{ plannedMin: -1 }, 'invalid-planned'],
    [{ plannedMin: NaN }, 'invalid-planned'],
    [{ plannedMin: Infinity }, 'invalid-planned'],
    [{ downtimeMin: -1 }, 'invalid-downtime'],
    [{ downtimeMin: NaN }, 'invalid-downtime'],
    [{ downtimeMin: 451 }, 'downtime-exceeds-planned'],
    [{ idealCycleSec: 0 }, 'invalid-cycle'],
    [{ idealCycleSec: -5 }, 'invalid-cycle'],
    [{ idealCycleSec: NaN }, 'invalid-cycle'],
    [{ idealCycleSec: Infinity }, 'invalid-cycle'],
    [{ cavities: 0 }, 'invalid-cavities'],
    [{ cavities: 1.5 }, 'invalid-cavities'],
    [{ cavities: NaN }, 'invalid-cavities'],
    [{ totalCount: -1 }, 'invalid-count'],
    [{ totalCount: 1.5 }, 'invalid-count'],
    [{ totalCount: NaN }, 'invalid-count'],
    [{ totalCount: Infinity }, 'invalid-count'],
    [{ goodCount: -1 }, 'invalid-count'],
    [{ goodCount: 1.5 }, 'invalid-count'],
    [{ goodCount: 721 }, 'good-exceeds-total'],
    [{ goodCount: NaN }, 'invalid-count']
  ];
  let allRejected = true, detail = '';
  for (const [over, err] of bad) {
    const r = calc(over);
    if (r.ok !== false || r.error !== err) { allRejected = false; detail = JSON.stringify(over) + '→' + (r.error || 'ok'); break; }
  }
  check('K6.1 21 组非法输入全部拒绝且错误码正确（负数/NaN/Infinity/非整数/越界）', allRejected, detail || 'all rejected');
  check('K6.2 非对象配置拒绝', O.compute(null).ok === false && O.compute(42).error === 'invalid-config');
  check('K6.3 零值合法边界：planned=0 与 total=0 是边界而非非法（K4 已验证可计算）',
    O.validateConfig(cfg({ plannedMin: 0, downtimeMin: 0, totalCount: 0, goodCount: 0 })).ok === true);
}

// ================================================================ K7 损失守恒与有效时间（随机性质）
{
  let seed = 20261124;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  let okAll = true, maxCons = 0, detail = '';
  for (let i = 0; i < 100; i++) {
    const plannedMin = 10 + rnd() * 990;
    const downtimeMin = rnd() * plannedMin;
    const idealCycleSec = 0.5 + rnd() * 119.5;
    const cavities = 1 + Math.floor(rnd() * 16);
    const idealPart = idealCycleSec / cavities;
    const runSec = (plannedMin - downtimeMin) * 60;
    const totalCount = Math.floor(runSec / idealPart * (0.5 + rnd() * 0.8));  // 含 P>100% 情景
    const goodCount = Math.floor(totalCount * rnd());
    const r = O.compute({ plannedMin, downtimeMin, idealCycleSec, cavities, totalCount, goodCount });
    if (!r.ok) { okAll = false; detail = 'rejected ' + i; break; }
    const vals = [r.availability, r.performance, r.quality, r.oee, r.oeeTime];
    if (!vals.every(v => v === null || Number.isFinite(v))) { okAll = false; detail = 'non-finite ' + i; break; }
    if (r.availability < 0 || r.availability > 1 + 1e-12 || r.quality < 0 || r.quality > 1 + 1e-12 || r.performance < 0) {
      okAll = false; detail = 'range ' + i; break;
    }
    const tol = 1e-9 * Math.max(1, r.plannedSec);
    maxCons = Math.max(maxCons, r.conservationDelta / Math.max(1, r.plannedSec));
    if (!r.conservationOk || r.conservationDelta > tol) { okAll = false; detail = 'conservation ' + i; break; }
    if (!near(r.losses.effectiveSec, idealPart * goodCount, tol)) { okAll = false; detail = 'effective ' + i; break; }
    if (r.crossDelta !== null && r.crossDelta > 1e-9 * Math.max(1, r.oee)) { okAll = false; detail = 'cross ' + i; break; }
    if (r.chartSafe && (r.losses.performanceSec < -tol || r.losses.qualitySec < -tol)) { okAll = false; detail = 'chartSafe-negative ' + i; break; }
  }
  check('K7.1 100 组随机合法输入：全部有限、A/Q∈[0,1]、守恒、有效时间公式、交叉验证一致',
    okAll, detail || 'maxRelCons=' + maxCons.toExponential(2));
}

// ================================================================ K8 A/B 实际输入对比（硬编码期望）
{
  const B = { plannedMin: 450, downtimeMin: 30, idealCycleSec: 30, cavities: 1, totalCount: 840, goodCount: 798 };
  const cmp = O.compareScenarios(BASE, B);
  check('K8.1 对比合法且 B 的 OEE = (14/15)×1×0.95 = 88.6667%',
    cmp.ok && near(cmp.b.oee, (14 / 15) * 0.95, 1e-12), 'OEE_B=' + cmp.b.oee);
  check('K8.2 OEE 变化 = +12.6667 百分点', near(cmp.deltas.oeePP, ((14 / 15) * 0.95 - 0.76) * 100, 1e-9), 'Δ=' + cmp.deltas.oeePP);
  check('K8.3 Availability 变化 = +3.3333 百分点', near(cmp.deltas.availabilityPP, (14 / 15 - 0.9) * 100, 1e-9));
  check('K8.4 停机损失 −15 分钟、性能损失 −45 分钟、质量损失 +3 分钟、有效时间 +57 分钟',
    near(cmp.deltas.downtimeLossDeltaMin, -15, 1e-9) &&
    near(cmp.deltas.performanceLossDeltaMin, -45, 1e-9) &&
    near(cmp.deltas.qualityLossDeltaMin, 3, 1e-9) &&
    near(cmp.deltas.effectiveDeltaMin, 57, 1e-9));
  check('K8.5 相同计划时间下合格产量变化 = +114 件，samePlanned=true',
    cmp.deltas.goodDelta === 114 && cmp.deltas.samePlanned === true);
  // 只减停机、产量不变：OEE 不变（时间公式），损失从停机转移到性能——教学要点
  const shift = O.compareScenarios(BASE, cfg({ downtimeMin: 30 }));
  check('K8.6 只减停机不改产量：OEE 变化 0 百分点，停机损失 −15、性能损失 +15 分钟（损失转移）',
    near(shift.deltas.oeePP, 0, 1e-9) &&
    near(shift.deltas.downtimeLossDeltaMin, -15, 1e-9) &&
    near(shift.deltas.performanceLossDeltaMin, 15, 1e-9));
  const diffPlanned = O.compareScenarios(BASE, cfg({ plannedMin: 480 }));
  check('K8.7 计划时间不同：samePlanned=false 且给出 plannedDeltaMin=30',
    diffPlanned.deltas.samePlanned === false && near(diffPlanned.deltas.plannedDeltaMin, 30, 1e-12));
  check('K8.8 非法情景拒绝', O.compareScenarios(BASE, cfg({ goodCount: 9999 })).ok === false);
}

// ================================================================ K9 假设投影（显式假设，非已验证收益）
{
  const proj = O.projectDowntimeReduction(BASE, 30);
  check('K9.1 投影合法且标注假设类型与免责说明',
    proj.ok && proj.kind === 'assumption-projection' &&
    proj.assumptions.join(',') === 'performance-constant,quality-constant,ideal-cycle-constant' &&
    /非已验证/.test(proj.disclaimer));
  check('K9.2 停机 45→30：预计总产量 746.667 件、合格 709.333 件（P=8/9、Q=0.95 不变）',
    near(proj.projected.totalCount, (8 / 9) * 25200 / 30, 1e-9) &&
    near(proj.projected.goodCount, 0.95 * (8 / 9) * 25200 / 30, 1e-9),
    'good=' + proj.projected.goodCount);
  check('K9.3 合格增量 = +25.333 件（理论估计，可为小数）',
    near(proj.deltaGood, 0.95 * (8 / 9) * 25200 / 30 - 684, 1e-9));
  check('K9.4 投影 OEE = 理想单件周期×投影合格/计划时间',
    near(proj.projected.oee, 30 * proj.projected.goodCount / 27000, 1e-12));
  const unavail = O.projectDowntimeReduction(cfg({ totalCount: 0, goodCount: 0 }), 30);
  check('K9.5 零产量无法定义 P/Q：投影拒绝（projection-unavailable），不编造预测',
    unavail.ok === false && unavail.error === 'projection-unavailable');
  const badDt = O.projectDowntimeReduction(BASE, 500);
  check('K9.6 假设停机超过计划时间：拒绝', badDt.ok === false && badDt.error === 'invalid-projection-downtime');
  const zeroDt = O.projectDowntimeReduction(BASE, 0);
  check('K9.7 停机降到 0：投影仍合法（运行时间=计划时间）',
    zeroDt.ok && near(zeroDt.projected.runMin, 450, 1e-9));
}

// ================================================================ K10 确定性与极大数值
{
  const a = calc(), b = calc();
  check('K10.1 同参数两次计算完全一致（确定性，纯函数无共享状态）',
    JSON.stringify(a) === JSON.stringify(b));
  const huge = O.compute({ plannedMin: 1e6, downtimeMin: 0, idealCycleSec: 0.01, cavities: 1, totalCount: 1e9, goodCount: 1e9 });
  check('K10.2 极大数值（1e6 分钟/1e9 件/0.01 秒周期）：全部有限、守恒相对误差 <1e-9',
    huge.ok && Number.isFinite(huge.oee) && Number.isFinite(huge.performance) &&
    huge.conservationDelta <= 1e-9 * huge.plannedSec,
    'P=' + huge.performance + ' consΔ=' + huge.conservationDelta.toExponential(2));
  const tiny = O.compute({ plannedMin: 0.001, downtimeMin: 0, idealCycleSec: 0.01, cavities: 1, totalCount: 6, goodCount: 6 });
  check('K10.3 极小计划时间（0.001 分钟=0.06 秒）：P≈100%、数值稳定',
    tiny.ok && near(tiny.performance, 1, 1e-9) && Number.isFinite(tiny.oee));
  const multiHuge = O.compute({ plannedMin: 10000, downtimeMin: 100, idealCycleSec: 0.5, cavities: 64, totalCount: 1e8, goodCount: 99999999 });
  check('K10.4 多穴+极大件数：理想单件周期 0.5/64 秒，结果有限且守恒',
    multiHuge.ok && near(multiHuge.idealPartSec, 0.5 / 64, 1e-15) && multiHuge.conservationOk);
}

// ================================================================ K11 示例与默认
{
  check('K11.1 三个教学示例均可计算且标注教学性质',
    O.EXAMPLES.length === 3 && O.EXAMPLES.every(e => /教学示例/.test(e.name) && O.compute(e.config).ok));
  check('K11.2 默认参数 = 基础验证样例（450/45/30/1/720/684）',
    JSON.stringify(O.DEFAULTS) === JSON.stringify(BASE));
  const line = O.compute(O.EXAMPLES[2].config);
  check('K11.3 冲压线示例：A=13/14、P=12/13、Q=0.99、OEE=21384/25200（独立硬编码）',
    near(line.availability, 13 / 14, 1e-12) && near(line.performance, 12 / 13, 1e-12) &&
    near(line.quality, 0.99, 1e-12) && near(line.oee, 21384 / 25200, 1e-12));
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);