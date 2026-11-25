#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2A：SPC 统计过程控制与过程能力数学专项（无浏览器，直接 require 真实 js/spc-calculation.js）
 *
 * 覆盖：
 *   - 单列数据解析（多种分隔符 / 非法位置定位 / NaN / Infinity / 十六进制 / 溢出 /
 *     重复值 / 5000 上限 / 极端值 / 精度 / 原始顺序保留）
 *   - 描述统计与移动极差（期望值全部由 Python 标准库独立核算并硬编码，不由被测算法生成）
 *   - I / MR 控制界限（含 d2=1.128、D4=3.267、D3=0 与退化情形）
 *   - 四项异常规则及严格不等式边界
 *   - 冻结基线（基准段界限固定、监测段偏移、拒绝非法范围）
 *   - Cp/Cpu/Cpl/Cpk 与 Pp/Ppk（含均值偏移、负 Cpk 不截断、零波动、非法规格）
 *   - 顺序变化对移动极差的影响
 *   - 教学示例（合成数据固定种子，四项规则的教学性质）
 *   - 全部样本统计与图表抽样分离
 *   - 大数值 + 微小波动的数值稳定性
 *   - 理论参数模式（不混入样本估计）
 *   - 5000 样本性能
 *
 * 用法：node tests/test61_spc_math.js
 */
const path = require('path');
const S = require(path.resolve(__dirname, '..', 'js', 'spc-calculation.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-12 : eps); }
function rule(r, id) { return r.violations.filter(v => v.rule === id)[0] || null; }
function med(list) { const s = list.slice().sort((a, b) => a - b); return s.length; }

// 基础样例：8 个值，均值精确 10，样本标准差精确 0.2
const BASE = [10.0, 10.2, 9.8, 10.1, 9.9, 10.3, 9.7, 10.0];
const SPEC = { lsl: 9.5, usl: 10.5, target: 10.0, unit: 'mm' };

// ================================================================ P 解析
{
  const empty = S.parseMeasurements('');
  check('P1.1 空输入被拒绝并给出可操作提示（不静默返回 0 个样本）',
    !empty.ok && empty.error === 'empty-input' && /示例/.test(empty.message));

  const multi = S.parseMeasurements('10.1, 10.2;10.3\n10.4\t10.5 10.6');
  check('P1.2 逗号/分号/换行/制表符/空格混合分隔 → 6 个样本且顺序保留',
    multi.ok && multi.count === 6 && multi.values.join(',') === '10.1,10.2,10.3,10.4,10.5,10.6');

  const cn = S.parseMeasurements('10.1，10.2；10.3\u300010.4');
  check('P1.3 全角逗号/分号/全角空格同样支持 → 4 个样本',
    cn.ok && cn.count === 4, cn.message);

  const bad = S.parseMeasurements('10.1\n10.2\nabc\n10.4');
  check('P1.4 非法数字指出行号与该行第几个数据（第 3 行第 1 个）',
    !bad.ok && bad.error === 'invalid-number' && bad.line === 3 && bad.column === 1 && /abc/.test(bad.message),
    bad.message);

  const nan = S.parseMeasurements('10\nNaN\n10');
  const inf = S.parseMeasurements('10\nInfinity\n10');
  const hex = S.parseMeasurements('10\n0x10\n10');
  const overflow = S.parseMeasurements('10\n1e400\n10');
  check('P1.5 NaN / Infinity / 十六进制 / 溢出科学计数全部拒绝（不当作 0 或跳过）',
    !nan.ok && !inf.ok && !hex.ok && !overflow.ok &&
    overflow.error === 'non-finite', overflow.error);

  const dup = S.parseMeasurements('10.5, 10.5, 10.5');
  check('P1.6 重复值按独立样本保留（count=3、duplicateCount=2），不去重不合并',
    dup.ok && dup.count === 3 && dup.duplicateCount === 2 && dup.warnings.length === 1,
    JSON.stringify({ count: dup.count, dup: dup.duplicateCount }));

  const many = [];
  for (let i = 0; i < 5001; i++) many.push('10');
  const over = S.parseMeasurements(many.join(','));
  check('P1.7 超过 5000 个样本直接拒绝，指出第 5001 个的位置（不截断后继续）',
    !over.ok && over.error === 'too-many-samples' && over.index === 5001, over.message);

  const extreme = S.parseMeasurements('10\n1000000000000000');
  check('P1.8 单值超过 ±1e12 被拒绝并提示检查单位',
    !extreme.ok && extreme.error === 'value-out-of-range' && /单位/.test(extreme.message));

  const precision = S.parseMeasurements('0.1\n0.2\n0.30000000000000004');
  check('P1.9 精度按 IEEE-754 双精度保留（0.1 / 0.2 / 0.30000000000000004 原样）',
    precision.ok && precision.values[0] === 0.1 && precision.values[1] === 0.2 &&
    precision.values[2] === 0.30000000000000004);

  const ordered = S.parseMeasurements('5\n1\n9\n3');
  check('P1.10 原始输入顺序保留（不排序）', ordered.ok && ordered.values.join(',') === '5,1,9,3');
}

// ================================================================ S 描述统计
{
  const st = S.summarize(BASE);
  check('S2.1 n=8、均值=10（精确）', st.n === 8 && near(st.mean, 10, 1e-15), 'mean=' + st.mean);
  check('S2.2 中位数 = (10.0+10.0)/2 = 10', near(st.median, 10, 1e-15));
  check('S2.3 最小值 9.7 / 最大值 10.3 / 极差 0.6',
    near(st.min, 9.7, 1e-12) && near(st.max, 10.3, 1e-12) && near(st.range, 0.6, 1e-12));
  check('S2.4 样本标准差 s（n−1）= 0.2（独立核算：√(0.28/7)）',
    near(st.s, 0.2, 1e-12) && st.sStatus === 'ok', 's=' + st.s);
  check('S2.5 7 个相邻移动极差，平均 MR = 2.4/7 ≈ 0.342857142857',
    st.mr.count === 7 && near(st.mr.mean, 0.3428571428571429, 1e-12), 'mr=' + st.mr.mean);
  check('S2.6 σ_within = MR均值 / 1.128 ≈ 0.3039513678',
    near(st.sigmaWithin, 0.3039513677811549, 1e-12), 'sw=' + st.sigmaWithin);

  const empty = S.summarize([]);
  check('S2.7 空数组返回 null + insufficient-samples（绝不 NaN/Infinity）',
    empty.ok === false && empty.mean === null && empty.s === null &&
    empty.sigmaWithin === null && empty.sStatus === 'insufficient-samples');

  const one = S.summarize([10]);
  check('S2.8 单样本：s 与 MR 不可定义 → null + insufficient-samples',
    one.ok && one.mean === 10 && one.s === null && one.mr.mean === null &&
    one.mr.status === 'insufficient-samples' && one.sigmaStatus === 'insufficient-samples');
}

// ================================================================ L 控制界限
{
  const st = S.summarize(BASE);
  const lim = S.computeLimits(st.mean, st.mr.mean);
  check('L3.1 I 图：CL=10、UCL=10.9118541033、LCL=9.0881458967（独立硬编码）',
    near(lim.i.cl, 10, 1e-15) && near(lim.i.ucl, 10.911854103343465, 1e-9) &&
    near(lim.i.lcl, 9.088145896656535, 1e-9),
    lim.i.ucl + ' / ' + lim.i.lcl);
  check('L3.2 MR 图：CL=0.342857142857、UCL=1.120114285714（3.267×CL）、LCL=0',
    near(lim.mr.cl, 0.3428571428571429, 1e-12) &&
    near(lim.mr.ucl, 1.1201142857142857, 1e-12) && lim.mr.lcl === 0);
  check('L3.3 常数对应移动极差长度 2：d2=1.128、D4=3.267、D3=0',
    S.CONSTANTS.d2 === 1.128 && S.CONSTANTS.d4 === 3.267 && S.CONSTANTS.d3 === 0);

  const one = S.computeLimits(10, null);
  check('L3.4 无移动极差时 I 图上/下界限为 null（不伪造界限）',
    one.ok === false && one.i.ucl === null && one.i.lcl === null &&
    one.status === 'insufficient-samples');

  const zero = S.computeLimits(10, 0);
  check('L3.5 MR均值=0：σ_within=0、UCL=LCL=CL、状态 zero-within-variation（不宣称能力无限好）',
    zero.sigmaWithin === 0 && zero.i.ucl === 10 && zero.i.lcl === 10 &&
    zero.status === 'zero-within-variation');
}

// ================================================================ C 过程能力
{
  const st = S.summarize(BASE);
  const cap = S.capability({
    mean: st.mean, sigmaWithin: st.sigmaWithin, s: st.s, lsl: 9.5, usl: 10.5, n: 8
  });
  check('C4.1 Cp = 1/(6×0.3039513678) = 0.5483333333（独立硬编码）',
    near(cap.cp, 0.5483333333333337, 1e-12), 'Cp=' + cap.cp);
  check('C4.2 Cpu = Cpl = 0.5483333333（均值居中），Cpk 相同',
    near(cap.cpu, 0.5483333333333337, 1e-12) &&
    near(cap.cpl, 0.5483333333333337, 1e-12) && near(cap.cpk, 0.5483333333333337, 1e-12));
  check('C4.3 Pp = 1/(6×0.2) = 0.8333333333；Ppk = 0.5/(3×0.2) = 0.8333333333',
    near(cap.pp, 1 / 1.2, 1e-12) && near(cap.ppk, 0.5 / 0.6, 1e-12));
  check('C4.4 样本 8 个 < 30：标记 small-sample-capability（可靠性提示）',
    cap.flags.indexOf('small-sample-capability') !== -1);

  // 均值整体偏移 +0.4：Cp 不变、Cpk 显著下降
  const shifted = BASE.map(v => v + 0.4);
  const st2 = S.summarize(shifted);
  const cap2 = S.capability({
    mean: st2.mean, sigmaWithin: st2.sigmaWithin, s: st2.s, lsl: 9.5, usl: 10.5, n: 8
  });
  check('C4.5 均值偏移 +0.4：Cp 不变 0.548333、Cpu=0.109667、Cpk=0.109667（Cp 高但 Cpk 低）',
    near(cap2.cp, 0.5483333333333337, 1e-12) &&
    near(cap2.cpu, 0.1 / (3 * st2.sigmaWithin), 1e-12) &&
    near(cap2.cpk, 0.1 / (3 * st2.sigmaWithin), 1e-12),
    'Cp=' + cap2.cp + ' Cpk=' + cap2.cpk);

  // 均值超出规格上限：负 Cpk 如实保留
  const outside = BASE.map(v => v + 0.8);
  const st3 = S.summarize(outside);
  const cap3 = S.capability({
    mean: st3.mean, sigmaWithin: st3.sigmaWithin, s: st3.s, lsl: 9.5, usl: 10.5, n: 8
  });
  check('C4.6 均值在规格外：Cpk = −0.3/(3σ_within) = −0.329000（负值保留，不截断为 0）',
    cap3.cpk < 0 && near(cap3.cpk, -0.3 / (3 * st3.sigmaWithin), 1e-12),
    'Cpk=' + cap3.cpk);
  check('C4.7 负 Cpk 同时标记 mean-outside-spec', cap3.flags.indexOf('mean-outside-spec') !== -1);
  check('C4.8 Ppk 同样保留负值：(10.5−10.8)/(3×0.2) = −0.5', near(cap3.ppk, -0.5, 1e-12), 'Ppk=' + cap3.ppk);

  const zero = S.capability({ mean: 10, sigmaWithin: 0, s: 0, lsl: 9.5, usl: 10.5, n: 20 });
  check('C4.9 零波动：Cp/Cpk/Pp/Ppk 全部 null 且状态为 zero-*（不返回 Infinity）',
    zero.cp === null && zero.cpk === null && zero.pp === null && zero.ppk === null &&
    zero.status.cp === 'zero-within-variation' && zero.status.pp === 'zero-variation');

  const noSpec = S.capability({ mean: 10, sigmaWithin: 0.3, s: 0.3, lsl: 10.5, usl: 9.5, n: 50 });
  check('C4.10 LSL ≥ USL：拒绝计算，全部 no-spec（不给出负宽度能力）',
    noSpec.cp === null && noSpec.cpk === null && noSpec.status.cp === 'no-spec' &&
    noSpec.specError === 'invalid-spec-range');

  const boundary = S.computeMeasured({
    values: [9.5, 10.5, 9.5, 10.5, 10.0, 10.0],
    spec: { lsl: 9.5, usl: 10.5 }
  });
  check('C4.11 测量值恰好等于规格界限算合格（严格 <LSL / >USL 才计超规）',
    boundary.ok && boundary.outOfSpec.count === 0, 'oos=' + boundary.outOfSpec.count);

  const outsideOne = S.computeMeasured({
    values: [9.49, 10.51, 10.0, 10.0],
    spec: { lsl: 9.5, usl: 10.5 }
  });
  check('C4.12 超出规格界限 0.01 即计入超规（2/4），比例 0.5',
    outsideOne.ok && outsideOne.outOfSpec.count === 2 &&
    near(outsideOne.outOfSpec.ratio, 0.5, 1e-12) &&
    outsideOne.outOfSpec.indexes.join(',') === '1,2');
}

// ================================================================ R 异常规则
{
  const I_LIM = { i: { cl: 10, ucl: 11, lcl: 9 }, mr: { cl: 0.5, ucl: 1.5, lcl: 0 } };

  const eq = S.detectViolations([11, 9, 10.9999, 9.0001], I_LIM);
  check('R5.1 R1 严格不等式：恰好等于 UCL/LCL 不命中，向内 1e-4 也不命中',
    rule(eq, 'i-beyond-limits') === null);

  const beyond = S.detectViolations([11.0001, 8.9999, 10], I_LIM);
  check('R5.2 R1 超出即命中，位置为 1-based 样本序号 1、2',
    !!rule(beyond, 'i-beyond-limits') &&
    rule(beyond, 'i-beyond-limits').indexes.join(',') === '1,2');

  const eight = S.detectViolations([10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1], I_LIM);
  check('R5.3 R2 连续 8 点在同一侧 → 命中 8 个位置',
    !!rule(eight, 'i-run-same-side') && rule(eight, 'i-run-same-side').indexes.length === 8);

  const seven = S.detectViolations([10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1], I_LIM);
  check('R5.4 R2 只有 7 点 → 不命中（不提前报警）', rule(seven, 'i-run-same-side') === null);

  const withCenter = S.detectViolations(
    [10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10, 10.1], I_LIM);
  check('R5.5 R2 等于中心线的点中断运行（7 上 + CL + 1 上 不构成 8 点连续同侧）',
    rule(withCenter, 'i-run-same-side') === null);

  const six = S.detectViolations([1, 2, 3, 4, 5, 6], { i: { cl: 0, ucl: 100, lcl: -100 }, mr: { cl: 1, ucl: 100, lcl: 0 } });
  check('R5.6 R3 连续 6 点严格递增 → 命中 6 个位置',
    !!rule(six, 'i-trend') && rule(six, 'i-trend').indexes.length === 6);

  const five = S.detectViolations([1, 2, 3, 4, 5], { i: { cl: 0, ucl: 100, lcl: -100 }, mr: { cl: 1, ucl: 100, lcl: 0 } });
  check('R5.7 R3 只有 5 点 → 不命中', rule(five, 'i-trend') === null);

  const equalBreak = S.detectViolations([1, 2, 3, 3, 4, 5, 6], { i: { cl: 0, ucl: 100, lcl: -100 }, mr: { cl: 1, ucl: 100, lcl: 0 } });
  check('R5.8 R3 相同数值中断单调（1,2,3,3,4,5,6 不构成 6 点连续递增）',
    rule(equalBreak, 'i-trend') === null);

  const mrEq = S.detectViolations([10, 10.5, 10], I_LIM);
  check('R5.9 R4 严格不等式：MR = UCL_MR = 0.5 不命中', rule(mrEq, 'mr-beyond-limits') === null);

  const mrOver = S.detectViolations([10, 12, 10], I_LIM);
  check('R5.10 R4 MR 超过 UCL_MR 命中，位置对应后一个样本序号 2、3',
    !!rule(mrOver, 'mr-beyond-limits') &&
    rule(mrOver, 'mr-beyond-limits').indexes.join(',') === '2,3');

  check('R5.11 四条规则都有明确的名称与严格定义，且不声称覆盖全部 Nelson 规则',
    ['i-beyond-limits', 'i-run-same-side', 'i-trend', 'mr-beyond-limits'].every(id => {
      const r = S.RULES[id];
      return r && r.name && r.definition && /严格/.test(r.definition);
    }) && !/nelson|western/i.test(Object.keys(S.RULES).join(',')));
}

// ================================================================ B 冻结基线
{
  const values = [10.0, 10.2, 9.8, 10.1, 9.9, 10.3, 9.7, 10.0, 10.9, 11.1, 10.8];
  const b = S.buildBaseline(values, 1, 4);
  const bSt = S.summarize(values.slice(0, 4));
  check('B6.1 基线（第 1–4 个）均值 = 10.025、MR均值 = 0.9/3 = 0.3、σ_within = 0.2659574468',
    b.ok && near(b.mean, 10.025, 1e-12) &&
    near(b.mrMean, 0.3, 1e-12) && near(b.sigmaWithin, 0.3 / 1.128, 1e-12),
    'mean=' + b.mean + ' mr=' + b.mrMean);
  check('B6.2 基线 I 界限：CL=10.025、UCL=10.8228723404、LCL=9.2271276596',
    near(b.limits.i.cl, 10.025, 1e-12) &&
    near(b.limits.i.ucl, 10.025 + 3 * 0.3 / 1.128, 1e-9) &&
    near(b.limits.i.lcl, 10.025 - 3 * 0.3 / 1.128, 1e-9));
  check('B6.3 基线 MR 界限：CL=0.3、UCL=3.267×0.3=0.9801、LCL=0',
    near(b.limits.mr.cl, 0.3, 1e-12) && near(b.limits.mr.ucl, 0.9801, 1e-12) &&
    b.limits.mr.lcl === 0);

  const frozen = S.computeMeasured({ values, spec: SPEC, baseline: { start: 1, end: 4 } });
  check('B6.4 冻结后 limits.frozen=true、limitsBasis=baseline、界限等于基线估计',
    frozen.ok && frozen.limits.frozen === true && frozen.limitsBasis === 'baseline' &&
    near(frozen.limits.i.ucl, b.limits.i.ucl, 1e-12) &&
    near(frozen.limits.i.cl, b.mean, 1e-12));

  const live = S.computeMeasured({ values, spec: SPEC });
  check('B6.5 未冻结时界限由全部样本估计，与冻结界限不同（不掩盖后续偏移）',
    live.limits.frozen === false && live.limitsBasis === 'all-samples' &&
    !near(live.limits.i.cl, frozen.limits.i.cl, 1e-9),
    'live=' + live.limits.i.cl + ' frozen=' + frozen.limits.i.cl);

  check('B6.6 冻结后监测段（第 5–11 个）仍按固定界限检测到越界/同侧信号',
    frozen.violationCounts['i-beyond-limits'] > 0 ||
    frozen.violationCounts['i-run-same-side'] > 0,
    JSON.stringify(frozen.violationCounts));

  check('B6.7 冻结基线不改变样本本身：n=11、全部样本都参与异常检测',
    frozen.n === 11 && frozen.chartSample.total === 11 &&
    frozen.monitoring.count === 7 && frozen.monitoring.start === 5);

  const tooFew = S.buildBaseline(values, 3, 3);
  check('B6.8 基线只有 1 个样本 → 拒绝（insufficient-baseline）',
    !tooFew.ok && tooFew.error === 'insufficient-baseline');

  const badRange = S.buildBaseline(values, 5, 3);
  check('B6.9 起止序号颠倒/越界 → 拒绝并说明范围',
    !badRange.ok && badRange.error === 'invalid-range' && /1–11/.test(badRange.message));

  const frac = S.buildBaseline(values, 1.5, 4);
  check('B6.10 非整数序号 → 拒绝（不做隐式取整）',
    !frac.ok && frac.error === 'invalid-range');
}

// ================================================================ B7 真冻结基线（统计快照）
{
  const values = [10.0, 10.2, 9.8, 10.1, 9.9, 10.3, 9.7, 10.0, 10.9, 11.1, 10.8];
  const snap = S.buildBaseline(values, 1, 4);
  check('B7.1 基线快照包含均值/MR均值/σ/s/控制界限/样本身份指纹',
    snap.ok && typeof snap.fingerprint === 'string' && snap.fingerprint.length === 8 &&
    near(snap.mean, 10.025, 1e-12) && near(snap.mrMean, 0.3, 1e-12) &&
    near(snap.s, S.summarize(values.slice(0, 4)).s, 1e-15) &&
    near(snap.sigmaWithin, 0.3 / 1.128, 1e-12) &&
    near(snap.limits.i.ucl, 10.025 + 3 * 0.3 / 1.128, 1e-9));

  const frozen = S.computeMeasured({ values, spec: SPEC, baseline: snap });
  const ucl = frozen.limits.i.ucl;
  const cl = frozen.limits.i.cl;
  const mrucl = frozen.limits.mr.ucl;
  check('B7.2 传入快照：baselineState=frozen，界限直接来自快照（不重算）',
    frozen.baselineState === 'frozen' && frozen.limits.frozen === true &&
    near(cl, snap.mean, 1e-15) && near(ucl, snap.limits.i.ucl, 1e-15));

  const appended = values.concat([10.4, 10.6]);
  const after = S.computeMeasured({ values: appended, spec: SPEC, baseline: snap });
  check('B7.3 追加监测样本：I/MR 界限逐位不变，监测段计数增加',
    after.baselineState === 'frozen' && after.limits.i.ucl === ucl &&
    after.limits.i.cl === cl && after.limits.mr.ucl === mrucl &&
    after.monitoring.count === 9);

  const modified = values.slice();
  modified[0] = 10.5;
  const bad = S.computeMeasured({ values: modified, spec: SPEC, baseline: snap });
  check('B7.4 修改基线样本：baselineState=invalid 且 limitsFrozen=false（不再标冻结）',
    bad.ok && bad.baselineState === 'invalid' && bad.limits.frozen === false &&
    bad.limitsBasis === 'all-samples');
  check('B7.5 失效原因=baseline-modified，并明确要求重新建立基线',
    bad.baselineIssue && bad.baselineIssue.kind === 'baseline-modified' &&
    /重新建立基线/.test(bad.baselineIssue.message));

  const removed = S.computeMeasured({ values: values.slice(0, 3), spec: SPEC, baseline: snap });
  check('B7.6 样本被删除导致基线范围不存在：baseline-missing + invalid',
    removed.ok && removed.baselineState === 'invalid' &&
    removed.baselineIssue.kind === 'baseline-missing');

  const reordered = values.slice();
  const tmp = reordered[1]; reordered[1] = reordered[2]; reordered[2] = tmp;
  const re = S.computeMeasured({ values: reordered, spec: SPEC, baseline: snap });
  check('B7.7 基线样本重排：身份指纹变化 → baseline-modified（顺序也是身份的一部分）',
    re.baselineState === 'invalid' && re.baselineIssue.kind === 'baseline-modified');

  const monReordered = values.slice();
  const tmp2 = monReordered[5]; monReordered[5] = monReordered[6]; monReordered[6] = tmp2;
  const monRe = S.computeMeasured({ values: monReordered, spec: SPEC, baseline: snap });
  check('B7.8 只重排监测段：基线仍有效，界限保持冻结',
    monRe.baselineState === 'frozen' && monRe.limits.i.ucl === ucl);

  check('B7.9 基线失效后能力指数改用全部样本口径，不沿用旧基线能力',
    bad.capability.basis === 'all-samples' && bad.capability.cp !== frozen.capability.cp,
    'cp ' + frozen.capability.cp + ' → ' + bad.capability.cp);

  const cleared = S.computeMeasured({ values, spec: SPEC, baseline: null });
  check('B7.10 清除基线：baselineState=none，界限为全样本实时估计',
    cleared.baselineState === 'none' && cleared.limits.frozen === false &&
    cleared.baseline === null && cleared.baselineIssue === null);
}

// ================================================================ T 浮点容差口径
{
  const lim1e9 = { i: { cl: 1e9, ucl: 1e9 + 0.01, lcl: 1e9 - 0.01 }, mr: { cl: 0.001, ucl: 0.003, lcl: 0 } };
  const eightNear = [];
  for (let i = 0; i < 8; i++) eightNear.push(1e9 + 0.0004);   // 偏离 CL 4e-4，远小于旧的 1e-3 容差
  check('T1.1 1e9 基准 + 4e-4 偏移的 8 点仍判同侧（旧 1e-12×量级容差会漏报）',
    S.detectViolations(eightNear, lim1e9).counts['i-run-same-side'] === 8);

  check('T1.2 冻结界限下真实越过 UCL 8e-4 被判 R1（旧容差视作"等于界限"）',
    S.detectViolations([1e9 + 0.0038],
      { i: { cl: 1e9, ucl: 1e9 + 0.003, lcl: 1e9 - 0.003 }, mr: { cl: 1, ucl: 2, lcl: 0 } })
      .counts['i-beyond-limits'] === 1);
  check('T1.3 恰好等于 UCL 不误报（容差不能变成工程死区，也不能消失）',
    S.detectViolations([1e9 + 0.003],
      { i: { cl: 1e9, ucl: 1e9 + 0.003, lcl: 1e9 - 0.003 }, mr: { cl: 1, ucl: 2, lcl: 0 } })
      .counts['i-beyond-limits'] === 0);

  const clSmall = S.summarize([0.1, 0.2]).mean;   // 0.15000000000000002（舍入边界）
  const limSmall = { i: { cl: clSmall, ucl: 0.3, lcl: 0 }, mr: { cl: 0.1, ucl: 0.2, lcl: 0 } };
  const eightRound = [];
  for (let i = 0; i < 8; i++) eightRound.push(0.15);
  check('T1.4 普通小数舍入边界：0.15 与 0.1/0.2 的均值视为相等，不制造 8 点同侧假警报',
    S.detectViolations(eightRound, limSmall).counts['i-run-same-side'] === 0);
  const eightReal = [];
  for (let i = 0; i < 8; i++) eightReal.push(0.1500001);
  check('T1.5 1e-7 的真实偏移仍判同侧（容差不吞掉可测量差异）',
    S.detectViolations(eightReal, limSmall).counts['i-run-same-side'] === 8);

  check('T1.6 极小尺度 1e-9：越界 4e-13 仍判 R1（旧下限 1 → 容差 1e-12 会漏报）',
    S.detectViolations([1.0009e-9],
      { i: { cl: 1e-9, ucl: 1.0005e-9, lcl: 0.9995e-9 }, mr: { cl: 1e-12, ucl: 1.5e-12, lcl: 0 } })
      .counts['i-beyond-limits'] === 1);
  check('T1.7 极小尺度：恰好等于界限不误报',
    S.detectViolations([1.0005e-9],
      { i: { cl: 1e-9, ucl: 1.0005e-9, lcl: 0.9995e-9 }, mr: { cl: 1e-12, ucl: 1.5e-12, lcl: 0 } })
      .counts['i-beyond-limits'] === 0);

  check('T1.8 零波动边界：全 0 数据不产生任何规则命中（MR=0、UCL=0，严格大于不成立）',
    Object.values(S.detectViolations([0, 0, 0, 0, 0, 0, 0, 0],
      { i: { cl: 0, ucl: 0, lcl: 0 }, mr: { cl: 0, ucl: 0, lcl: 0 } }).counts).every(v => v === 0));

  check('T1.9 MR 容差：MR 恰等于 UCL 不命中，超过 0.001 即命中',
    S.detectViolations([0, 0.002],
      { i: { cl: 0, ucl: 1, lcl: -1 }, mr: { cl: 0.001, ucl: 0.002, lcl: 0 } })
      .counts['mr-beyond-limits'] === 0 &&
    S.detectViolations([0, 0.003],
      { i: { cl: 0, ucl: 1, lcl: -1 }, mr: { cl: 0.001, ucl: 0.002, lcl: 0 } })
      .counts['mr-beyond-limits'] === 1);

  check('T1.10 容差随量级缩放且远小于工程波动：tol(1e9)≈1.8e-6、tol(1e-9)≈1.8e-24',
    S.boundaryTolerance(1e9) > 1e-7 && S.boundaryTolerance(1e9) < 1e-5 &&
    S.boundaryTolerance(1e-9) < 1e-20 && S.CONSTANTS.relEps < 1e-14,
    'tol(1e9)=' + S.boundaryTolerance(1e9));
}

// ================================================================ O 顺序影响
{
  const a = S.summarize([10.0, 10.1, 10.3]);
  const b2 = S.summarize([10.0, 10.3, 10.1]);
  check('O7.1 顺序变化改变移动极差均值：0.15 → 0.25（均值/标准差不变）',
    near(a.mr.mean, 0.15, 1e-12) && near(b2.mr.mean, 0.25, 1e-12) &&
    near(a.mean, b2.mean, 1e-15) && near(a.s, b2.s, 1e-15),
    a.mr.mean + ' → ' + b2.mr.mean);
  check('O7.2 σ_within 随之改变：0.1329787 → 0.2216312（控制界限依赖生产顺序）',
    near(a.sigmaWithin, 0.15 / 1.128, 1e-12) &&
    near(b2.sigmaWithin, 0.25 / 1.128, 1e-12));
}

// ================================================================ D 教学示例
{
  const ex = S.EXAMPLES;
  check('D8.1 四个教学示例齐备且全部标注为合成数据',
    ex.length === 4 && ex.every(e => e.synthetic === true) &&
    ex.map(e => e.id).join(',') === 'centered,shifted,drift,spike');

  const centered = S.computeMeasured({ values: S.exampleValues('centered'), spec: ex[0].spec });
  check('D8.2 示例①居中：均值 10.001000、s 0.013138119、Cp 2.582538、Cpk 2.556712（独立核算）',
    near(centered.stats.mean, 10.001, 1e-9) &&
    near(centered.stats.s, 0.013138119, 1e-9) &&
    near(centered.capability.cp, 2.582537835, 1e-8) &&
    near(centered.capability.cpk, 2.556712456, 1e-8),
    'Cp=' + centered.capability.cp + ' Cpk=' + centered.capability.cpk);
  check('D8.3 示例①四项规则全部无命中、无超规（教学前提：稳定且居中）',
    Object.values(centered.violationCounts).every(v => v === 0) &&
    centered.outOfSpec.count === 0);

  const shifted = S.computeMeasured({ values: S.exampleValues('shifted'), spec: ex[1].spec });
  check('D8.4 示例②均值偏移：Cp 2.240808 但 Cpk 0.847025（高 Cp 掩盖不了不居中）',
    near(shifted.capability.cp, 2.240808081, 1e-8) &&
    near(shifted.capability.cpk, 0.847025455, 1e-8) &&
    shifted.capability.cpk < shifted.capability.cp * 0.5,
    'Cp=' + shifted.capability.cp + ' Cpk=' + shifted.capability.cpk);
  check('D8.5 示例②控制图仍无信号（规格内不等于过程受控，控制图也不等于规格判定）',
    Object.values(shifted.violationCounts).every(v => v === 0));

  const drift = S.computeMeasured({ values: S.exampleValues('drift'), spec: ex[2].spec });
  check('D8.6 示例③持续漂移：Cpk 2.505651 很高，但 I 图命中 3 点越界与 39 点同侧',
    near(drift.capability.cpk, 2.505650670, 1e-8) &&
    drift.violationCounts['i-beyond-limits'] === 3 &&
    drift.violationCounts['i-run-same-side'] === 39,
    JSON.stringify(drift.violationCounts));
  check('D8.7 示例③同时命中趋势规则（6 点）与 MR 越界（2 点）',
    drift.violationCounts['i-trend'] === 6 && drift.violationCounts['mr-beyond-limits'] === 2);
  check('D8.8 示例③无超规样本：全部在规格内却已明显失控（教学要点成立）',
    drift.outOfSpec.count === 0);

  const spike = S.computeMeasured({ values: S.exampleValues('spike'), spec: ex[3].spec });
  check('D8.9 示例④突发异常：超规 3 个（第 31–33 个），R1 命中同样位置',
    spike.outOfSpec.count === 3 &&
    spike.outOfSpec.indexes.join(',') === '31,32,33' &&
    rule(spike, 'i-beyond-limits').indexes.join(',') === '31,32,33');
  check('D8.10 示例④MR 图在突变上升/下降处命中 2 个越界点',
    spike.violationCounts['mr-beyond-limits'] === 2);
  check('D8.11 示例④恢复后出现连续同侧信号（离群点抬高中心线，后续样本落到下侧）',
    spike.violationCounts['i-run-same-side'] === 31);

  const again = S.exampleValues('centered');
  const first = S.exampleValues('centered');
  check('D8.12 示例数据可复现：两次生成的 60 个值完全相同（固定种子，非真实工厂数据）',
    again.length === 60 && again.join(',') === first.join(','));
}

// ================================================================ G 抽样与全量分离
{
  const values = new Array(5000).fill(10);
  values[1234] = 15;                      // 未抽样位置上的真实异常
  const r = S.computeMeasured({ values, spec: { lsl: 9.5, usl: 10.5 } });
  check('G9.1 5000 样本：统计基于全部样本（n=5000、超规 1 个）',
    r.n === 5000 && r.outOfSpec.count === 1 && r.outOfSpec.indexes.join(',') === '1235');
  check('G9.2 图表抽样 step>1，异常点不在常规抽样序列中（1222 与 1235 之间跳过 1234）',
    r.chartSample.step > 1 && r.chartSample.indexes.indexOf(1234) === -1 &&
    r.chartSample.sampled === true, 'step=' + r.chartSample.step);
  check('G9.3 异常点被强制加入绘制集合，且异常列表仍记录第 1235 个（抽样不遗漏异常）',
    r.chartSample.forced.indexOf(1234) !== -1 &&
    !!rule(r, 'i-beyond-limits') && rule(r, 'i-beyond-limits').indexes.indexOf(1235) !== -1);
  check('G9.4 抽样确实生效：常规抽样序列只保留约 1/13 的点（386 个 < 1000）',
    r.chartSample.total === 5000 && r.chartSample.indexes.length < 1000,
    JSON.stringify({ idx: r.chartSample.indexes.length, forced: r.chartSample.forced.length }));
  const drawnSet = new Set(r.chartSample.indexes.concat(r.chartSample.forced));
  const flagged = [];
  for (let p = 0; p < 5000; p++) if (r.pointRules[p].length) flagged.push(p);
  check('G9.5 所有命中规则的点都进入绘制集合（少量样本全等时强制绘制会接近全量，但不丢异常）',
    flagged.length > 0 && flagged.every(p => drawnSet.has(p)),
    'flagged=' + flagged.length + ' drawn=' + drawnSet.size);
}

// ================================================================ N 数值稳定
{
  const values = [];
  for (let i = 0; i < 20; i++) values.push(1e9 + (i % 2 ? 0.001 : -0.001));
  const st = S.summarize(values);
  check('N10.1 1e9 基准 + ±0.001 波动：均值精确回到 1e9（偏移算法避免相消）',
    near(st.mean, 1e9, 1e-6), 'mean=' + st.mean);
  // 1e9 处 double 的 ulp ≈ 1.19e-7，±0.001 的输入本身只能表示为接近值，
  // 因此容差取 1e-6 量级：验证的是算法没有相消，而不是输入能精确表示 0.001。
  check('N10.2 样本标准差 ≈ 0.001026（0.001×√(20/19) 的 double 可表示值，误差 < 1e-6）',
    near(st.s, 0.001 * Math.sqrt(20 / 19), 1e-6), 's=' + st.s);
  check('N10.3 移动极差均值 ≈ 0.002（受 1e9 处 ulp 限制，误差 < 1e-7）',
    near(st.mr.mean, 0.002, 1e-7), 'mr=' + st.mr.mean);

  const tiny = S.summarize([1e-9, 2e-9, 3e-9, 4e-9]);
  check('N10.4 极小量级（1e-9）：均值 2.5e-9、s ≈ 1.290994e-9（不塌缩为 0）',
    near(tiny.mean, 2.5e-9, 1e-20) && near(tiny.s, 1.2909944487358056e-9, 1e-20),
    's=' + tiny.s);
}

// ================================================================ E 理论参数模式
{
  const th = S.computeTheoretical({ mean: 10, sd: 0.02, lsl: 9.9, usl: 10.1, unit: 'mm' });
  check('E11.1 理论模式：Cp = Cpk = 0.2/(6×0.02) = 1.666667（用输入 σ，不用样本）',
    th.ok && near(th.capability.cp, 1.6666666666666667, 1e-12) &&
    near(th.capability.cpk, 1.6666666666666667, 1e-12));
  check('E11.2 理论模式 Pp/Ppk 明确不适用（不伪造整体波动指标）',
    th.capability.pp === null && th.capability.ppk === null &&
    th.capability.status.pp === 'not-applicable-theoretical');
  check('E11.3 理论不良率 PPM = 2×0.5×erfc(5/√2)×1e6 ≈ 0.573303（模型估计，容差 1e-4）',
    near(th.ppm.total, 0.5733031437583891, 1e-4), 'ppm=' + th.ppm.total);
  check('E11.4 理论模式不产生控制图与异常命中，flags 标注 theoretical-parameters',
    th.chartSample === null && th.violations.length === 0 &&
    th.flags.indexOf('theoretical-parameters') !== -1);

  const badSd = S.computeTheoretical({ mean: 10, sd: 0, lsl: 9.9, usl: 10.1 });
  check('E11.5 σ ≤ 0 拒绝（不允许零方差冒充无限能力）',
    !badSd.ok && badSd.error === 'invalid-sd');
  const badWidth = S.computeTheoretical({ mean: 10, sd: 0.02, lsl: 10.1, usl: 9.9 });
  check('E11.6 理论模式规格颠倒：仍返回参数但能力与 PPM 不适用',
    badWidth.ok && badWidth.capability.cp === null && badWidth.ppm === null &&
    badWidth.flags.indexOf('spec-invalid') !== -1);
}

// ================================================================ H 直方图
{
  const hist = S.histogram(BASE, SPEC);
  const total = hist.bins.reduce((a, b) => a + b.count, 0);
  check('H12.1 分箱计数之和等于样本数（不丢样本、不重复计数）', total === 8 && hist.k === 5);
  check('H12.2 视图范围覆盖规格界限，便于同时显示 LSL/USL',
    hist.viewMin <= 9.5 && hist.viewMax >= 10.5);
  const flat = S.histogram([10, 10, 10], null);
  check('H12.3 全部数值相同：只生成 1 个零宽箱，不制造虚构波动',
    flat.bins.length === 1 && flat.bins[0].count === 3 && flat.binWidth === 0);
}

// ================================================================ X 确定性
{
  const r1 = S.computeMeasured({ values: BASE, spec: SPEC });
  const r2 = S.computeMeasured({ values: BASE, spec: SPEC });
  check('X13.1 相同输入两次计算完全一致（无隐藏随机/时间依赖）',
    JSON.stringify(r1.stats) === JSON.stringify(r2.stats) &&
    JSON.stringify(r1.violationCounts) === JSON.stringify(r2.violationCounts) &&
    r1.capability.cp === r2.capability.cp);
  const inputCopy = BASE.slice();
  S.computeMeasured({ values: BASE, spec: SPEC });
  check('X13.2 计算不修改调用方传入的数组（顺序与数值保持原样）',
    BASE.join(',') === inputCopy.join(','));
}

// ================================================================ F 性能
{
  const values = [];
  for (let i = 0; i < 5000; i++) {
    const v = 10 + Math.sin(i / 7) * 0.02 + (i % 97 === 0 ? 0.4 : 0);
    values.push(Math.round(v * 1000) / 1000);
  }
  const t0 = process.hrtime.bigint();
  const r = S.computeMeasured({ values, spec: { lsl: 9.9, usl: 10.1 } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('F14.1 5000 样本完整计算（统计+控制界限+四项规则+能力+直方图）< 500ms',
    r.ok && r.n === 5000 && ms < 500, ms.toFixed(1) + 'ms');
  const bigHit = rule(r, 'i-beyond-limits');
  check('F14.2 5000 样本：越界命中数与明细一致，且索引都在 1–5000 的全量范围内',
    bigHit && bigHit.indexes.length === r.violationCounts['i-beyond-limits'] &&
    bigHit.indexes.every(i => i >= 1 && i <= 5000),
    bigHit ? 'hits=' + bigHit.indexes.length : 'none');
  console.log('   [性能] 5000 样本 computeMeasured 实测 ' + ms.toFixed(1) + 'ms');
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);
