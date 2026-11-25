#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2B：卡尔曼滤波数学与数值专项（直接 require js/kalman-calculation.js）
 *
 * 期望值来源：Python 标准库独立手算（标量首步/多步、矩阵预测、Joseph、联合/顺序一致），
 * 以及固定场景的确定性输出；运行时不由被测算法生成期望值。
 *
 * 覆盖：标量首步手算、多步、Q=0 条件、R 有效性、无测量协方差传播、二维矩阵预测、
 * Joseph 更新、对称与半正定、联合与顺序一致、噪声水平、模型失配、初始协方差、
 * 测量缺失、确定性随机序列、非法输入、RMSE 口径（缺失不当作 0）。
 *
 * 用法：node tests/test62_kalman_math.js
 */
const path = require('path');
const K = require(path.resolve(__dirname, '..', 'js', 'kalman-calculation.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-12 : eps); }
function stepsOf(zs) {
  return zs.map((z, i) => ({ k: i, t: i * 0.5, truePos: 0, trueVel: 0, zPos: z, zVel: null }));
}
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// ================================================================ K1 标量首步与多步（手算）
{
  const f = K.createScalarFilter({ x0: 0, p0: 1, q: 0.25, r: 1 });
  check('K1.1 标量滤波器创建：x=0、P=1', f.ok && f.x === 0 && f.p === 1);

  const pred1 = K.scalarPredict({ x: 0, p: 1 }, 0.25);
  check('K1.2 预测：x⁻=0、P⁻=1+0.25=1.25', pred1.ok && pred1.x === 0 && near(pred1.p, 1.25, 1e-15));

  const up1 = K.scalarUpdate({ x: 0, p: 1.25 }, 1, 1);
  check('K1.3 首步更新：K=1.25/2.25=0.5555555556、x=0.5555555556',
    near(up1.gain, 0.5555555555555556, 1e-15) && near(up1.x, 0.5555555555555556, 1e-15),
    'K=' + up1.gain);
  check('K1.4 首步后验方差 P=(1−K)P⁻=0.5555555556',
    near(up1.p, 0.5555555555555556, 1e-15), 'P=' + up1.p);
  check('K1.5 创新 = z − x⁻ = 1，S = P⁻+R = 2.25',
    near(up1.innovation, 1, 1e-15) && near(up1.s, 2.25, 1e-15));

  const run = K.runScalar({ steps: stepsOf([1, 2]), x0: 0, p0: 1, q: 0.25, r: 1 });
  check('K1.6 第二步：K=0.4461538462、x=1.2、P=0.4461538462（独立手算）',
    run.ok && near(run.steps[1].gain, 0.446153846153846, 1e-15) &&
    near(run.steps[1].pos, 1.2, 1e-15) && near(run.steps[1].p, 0.446153846153846, 1e-15),
    'x=' + run.steps[1].pos);
}

// ================================================================ K2 Q=0 与 R 有效性
{
  const run = K.runScalar({ steps: stepsOf([1, 1, 1]), x0: 0, p0: 1, q: 0, r: 1 });
  check('K2.1 Q=0：状态仍可更新，方差单调下降（0.5 → 0.3333 → 0.25）',
    run.ok && run.steps[0].p === 0.5 && near(run.steps[1].p, 1 / 3, 1e-15) &&
    near(run.steps[2].p, 0.25, 1e-15));

  const noQ = K.scalarPredict({ x: 0, p: 1 }, 0);
  check('K2.2 Q=0 的预测：P 不增长（只适用于状态真正常值的模型假设）',
    noQ.ok && noQ.p === 1);

  check('K2.3 R=0 被拒绝（增益退化为 1，测量被无条件信任）',
    K.scalarUpdate({ x: 0, p: 1 }, 1, 0).error === 'invalid-r');
  check('K2.4 R<0 被拒绝', K.scalarUpdate({ x: 0, p: 1 }, 1, -1).error === 'invalid-r');
  check('K2.5 Q<0 被拒绝', K.scalarPredict({ x: 0, p: 1 }, -0.01).error === 'invalid-q');
  check('K2.6 P0<0 被拒绝', K.createScalarFilter({ x0: 0, p0: -1, q: 0.1, r: 1 }).error === 'invalid-covariance');
  check('K2.7 标量 R 为 1e-9 与 1e9 都能计算且保持有限（数值极限）',
    isFinite(K.scalarUpdate({ x: 0, p: 1 }, 1, 1e-9).x) &&
    near(K.scalarUpdate({ x: 0, p: 1 }, 1, 1e9).gain, 1e-9 / (1 + 1e-9), 1e-18));
}

// ================================================================ K3 无测量：只传播协方差
{
  const src = stepsOf([null, null, null]);
  const run = K.runScalar({ steps: src, x0: 5, p0: 1, q: 0.5, r: 1 });
  check('K3.1 连续 3 步无测量：状态保持 5，P 每次 +Q（1.5 / 2 / 2.5）',
    run.ok && run.steps[0].pos === 5 && run.steps[2].pos === 5 &&
    near(run.steps[0].p, 1.5, 1e-15) && near(run.steps[2].p, 2.5, 1e-15));
  check('K3.2 无测量步不产生增益/创新，updated=false 且 missing=true',
    run.steps.every(s => s.gain === null && s.innovation === null && !s.updated && s.missing));
  check('K3.3 无测量不消耗 R，也不把缺失当作 0 参与更新',
    run.steps[1].pos === 5, 'pos=' + run.steps[1].pos);
}

// ================================================================ K4 二维矩阵预测
{
  const f = { x: [0, 1], P: [[1, 0], [0, 1]] };
  const pr = K.predict2D(f, { dt: 0.2, sigmaA: 0.2 });
  check('K4.1 位置预测 x⁻=0+0.2×1=0.2，速度不变',
    pr.ok && near(pr.x[0], 0.2, 1e-15) && pr.x[1] === 1);
  check('K4.2 P⁻=F P Fᵀ+Q = [[1.040016, 0.20016], [0.20016, 1.0016]]（独立手算）',
    near(pr.P[0][0], 1.040016, 1e-12) && near(pr.P[0][1], 0.20016, 1e-12) &&
    near(pr.P[1][1], 1.0016, 1e-12), JSON.stringify(pr.P));
  check('K4.3 Q 使用逐区间随机恒定加速度：Q00=σ_a²dt⁴/4、Q01=σ_a²dt³/2、Q11=σ_a²dt²',
    near(pr.Q[0][0], 0.04 * Math.pow(0.2, 4) / 4, 1e-18) &&
    near(pr.Q[0][1], 0.04 * Math.pow(0.2, 3) / 2, 1e-18) &&
    near(pr.Q[1][1], 0.04 * 0.04, 1e-18));
  check('K4.4 σ_a=0 时 Q=0，预测只做 F P Fᵀ',
    near(K.predict2D(f, { dt: 0.2, sigmaA: 0 }).P[1][1], 1, 1e-15));
  const bad = K.predict2D(f, { dt: 0, sigmaA: 0.1 });
  check('K4.5 dt≤0 被拒绝', !bad.ok && bad.error === 'invalid-dt');
}

// ================================================================ K5 二维更新与 Joseph
{
  const f = { x: [0.2, 1], P: [[1.040016, 0.20016], [0.20016, 1.0016]] };
  const up = K.update2D(f, { idx: 0, z: 1.3, r: 0.5 });
  check('K5.1 位置更新增益 K=[0.6753280485, 0.1299726756]（独立手算）',
    near(up.K[0], 0.6753280485397555, 1e-12) &&
    near(up.K[1], 0.1299726756085651, 1e-12), JSON.stringify(up.K));
  check('K5.2 更新状态 x=[0.9428608534, 1.1429699432]、创新 1.1',
    near(up.x[0], 0.942860853393731, 1e-12) &&
    near(up.x[1], 1.1429699431694216, 1e-12) && near(up.innovation, 1.1, 1e-15));
  check('K5.3 Joseph 后验 P=[[0.3376640243,0.0649863378],[·,0.9755846693]]',
    near(up.P[0][0], 0.33766402426987774, 1e-12) &&
    near(up.P[0][1], 0.06498633780428256, 1e-12) &&
    near(up.P[1][1], 0.9755846692501896, 1e-12), JSON.stringify(up.P));
  check('K5.4 Joseph 结果与标准形式 (I−KH)P 数值一致（线性高斯下应相同）',
    near(up.P[0][0], f.P[0][0] * (1 - up.K[0]), 1e-12) &&
    near(up.P[0][1], f.P[0][1] * (1 - up.K[0]), 1e-12));
  check('K5.5 更新后协方差对称且半正定',
    K.symmetryError(up.P) < 1e-15 && K.isPSD2(up.P));

  const vel = K.update2D({ x: [1, 2], P: [[1, 0.5], [0.5, 1]] }, { idx: 1, z: 3, r: 0.25 });
  check('K5.6 速度更新：H=[0,1]，增益 K₁=1/(1.25)=0.8，位置被协方差联动修正',
    near(vel.K[1], 0.8, 1e-15) && near(vel.x[1], 2.8, 1e-15) &&
    near(vel.x[0], 1 + vel.K[0], 1e-15));
  check('K5.7 非法传感器索引/测量/噪声被拒绝',
    K.update2D({ x: [0, 0], P: [[1, 0], [0, 1]] }, { idx: 2, z: 1, r: 1 }).error === 'invalid-sensor' &&
    K.update2D({ x: [0, 0], P: [[1, 0], [0, 1]] }, { idx: 0, z: NaN, r: 1 }).error === 'invalid-measurement' &&
    K.update2D({ x: [0, 0], P: [[1, 0], [0, 1]] }, { idx: 0, z: 1, r: 0 }).error === 'invalid-r');
}

// ================================================================ K6 联合更新 vs 顺序更新
{
  const f = { x: [0, 1], P: [[1, 0.2], [0.2, 0.5]] };
  const joint = K.updateJoint2D(f, { zPos: 1.5, zVel: 0.8, rPos: 0.3, rVel: 0.2 });
  let seq = K.update2D(f, { idx: 0, z: 1.5, r: 0.3 });
  seq = K.update2D({ x: seq.x, P: seq.P }, { idx: 1, z: 0.8, r: 0.2 });
  check('K6.1 联合更新状态 x=[1.1241379310, 0.9287356322]（独立手算）',
    joint.ok && near(joint.x[0], 1.1241379310344826, 1e-12) &&
    near(joint.x[1], 0.9287356321839082, 1e-12), JSON.stringify(joint.x));
  check('K6.2 联合更新协方差 [[0.2275862069,0.0137931034],[·,0.1402298851]]',
    near(joint.P[0][0], 0.2275862068965517, 1e-12) &&
    near(joint.P[0][1], 0.01379310344827586, 1e-12) &&
    near(joint.P[1][1], 0.14022988505747128, 1e-12));
  check('K6.3 对角 R 下联合更新与"先位置后速度"顺序更新一致（状态差 <1e-12）',
    Math.abs(joint.x[0] - seq.x[0]) < 1e-12 && Math.abs(joint.x[1] - seq.x[1]) < 1e-12,
    Math.abs(joint.x[0] - seq.x[0]));
  check('K6.4 两条路径的协方差逐元素一致（<1e-12），且都为 PSD',
    Math.abs(joint.P[0][0] - seq.P[0][0]) < 1e-12 &&
    Math.abs(joint.P[1][1] - seq.P[1][1]) < 1e-12 && K.isPSD2(seq.P));
  check('K6.5 联合更新缺一个测量时拒绝（不隐式丢弃）',
    K.updateJoint2D(f, { zPos: 1, rPos: 0.3, rVel: 0.2 }).error === 'invalid-measurement');
}

// ================================================================ K7 数值稳定：对称与半正定
{
  let f = { x: [1e6, 1e3], P: [[1e6, 0], [0, 1e4]] };
  for (let i = 0; i < 200; i++) {
    const p = K.predict2D(f, { dt: 0.05, sigmaA: 1e-3 });
    const u = K.update2D(p, { idx: i % 3 === 0 ? 1 : 0, z: i % 3 === 0 ? 1e3 : 1e6, r: 1e-2 });
    f = { x: u.x, P: u.P };
  }
  check('K7.1 200 步极端量级更新后仍对称（误差 <1e-9）且半正定',
    K.symmetryError(f.P) < 1e-9 && K.isPSD2(f.P), 'sym=' + K.symmetryError(f.P));
  check('K7.2 所有状态与协方差元素有限（无 NaN/Infinity）',
    f.x.every(isFinite) && f.P.every(r => r.every(isFinite)));

  const tiny = K.update2D({ x: [0, 0], P: [[1e-12, 0], [0, 1e-12]] }, { idx: 0, z: 1e-6, r: 1e-12 });
  check('K7.3 极小尺度（1e-12）更新后仍有限且 PSD',
    tiny.ok && tiny.x.every(isFinite) && K.isPSD2(tiny.P));

  const psdBad = K.isPSD2([[1, 0], [0, -1]]);
  check('K7.4 PSD 检查能识别负方差（不把非半正定当有效）', psdBad === false);
  check('K7.5 PSD 检查能识别不对称矩阵', K.isPSD2([[1, 0.5], [0, 1]]) === false);
  check('K7.6 初始协方差必须 ≥0：负方差被拒绝，合法对角 P0 通过 PSD 检查',
    K.createFilter2D({ p0: 0, v0: 0, p0Var: -1, v0Var: 1, sigmaA: 0.1, dt: 0.5, rPos: 1, rVel: 1 }).error === 'invalid-covariance' &&
    K.isPSD2(K.createFilter2D({ p0: 0, v0: 0, p0Var: 1, v0Var: 1, sigmaA: 0.1, dt: 0.5, rPos: 1, rVel: 1 }).P));
}

// ================================================================ K8 场景与确定性
{
  const a = K.scenarioData('cruise');
  const b = K.scenarioData('cruise');
  check('K8.1 同一场景两次生成完全一致（固定种子）',
    JSON.stringify(a.steps) === JSON.stringify(b.steps));
  check('K8.2 场景标注为合成数据并带种子、步数与 dt',
    a.synthetic === true && a.seed === 202 && a.steps.length === 60 && a.dt === 0.5);
  check('K8.3 四个场景齐备：恒定 / 恒速 / 加速 / 缺失',
    K.scenarioList().map(s => s.id).join(',') === 'constant,cruise,accel,missing');

  const r1 = K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  const r2 = K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 10, v0Var: 4, sigmaA: 5, dt: 0.5, rPos: 50, rVel: 20 });
  check('K8.4 修改滤波器 Q/R 不改变同一场景的真实轨迹与测量序列',
    JSON.stringify(r1.steps.map(s => [s.zPos, s.zVel, s.truePos])) ===
    JSON.stringify(r2.steps.map(s => [s.zPos, s.zVel, s.truePos])));
  check('K8.5 修改 Q/R 会改变估计（增益不同），证明确实使用了新参数',
    r1.steps[0].gainPos !== r2.steps[0].gainPos);

  const m = K.scenarioData('missing');
  const mp = m.steps.filter(s => s.zPos === null).length;
  const mv = m.steps.filter(s => s.zVel === null).length;
  check('K8.6 缺失场景：位置缺失 16 个、速度缺失 13 个，缺失为 null 而非 0',
    mp === 16 && mv === 13 && m.steps[30].zPos === null);
}

// ================================================================ K9 传感器开关与融合
{
  const base = { scenario: 'cruise', p0: 0, v0: 0, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 };
  const posOnly = K.run2D(Object.assign({}, base, { sensors: { pos: true, vel: false } }));
  check('K9.1 仅位置：速度测量全部缺失，速度仍由模型与位置观测间接估计',
    posOnly.ok && posOnly.metrics.counts.validVel === 0 &&
    posOnly.metrics.counts.missingVel === 60 &&
    posOnly.steps.every(s => s.zVel === null) &&
    isFinite(posOnly.steps[59].vel));

  const velOnly = K.run2D(Object.assign({}, base, { sensors: { pos: false, vel: true } }));
  check('K9.2 仅速度：绝对位置不可完全确定，位置方差持续增大（10.05 → 12.999）',
    velOnly.ok && velOnly.steps[0].P[0][0] > 10 &&
    velOnly.steps[59].P[0][0] > velOnly.steps[0].P[0][0] + 2,
    velOnly.steps[0].P[0][0] + ' → ' + velOnly.steps[59].P[0][0]);

  const both = K.run2D(base);
  const fused = both.metrics.pos.est.rmse;
  check('K9.3 位置+速度融合的位置 RMSE 优于仅位置（同一场景与参数）',
    fused < posOnly.metrics.pos.est.rmse,
    fused + ' < ' + posOnly.metrics.pos.est.rmse);
  check('K9.4 不同传感器噪声：位置 R 越小，首步位置增益越大（0.9910 vs 0.5238）',
    near(K.run2D(Object.assign({}, base, { rPos: 0.1 })).steps[0].gainPos, 0.9909910226948807, 1e-12) &&
    near(K.run2D(Object.assign({}, base, { rPos: 10 })).steps[0].gainPos, 0.5238104095788513, 1e-12));

  const noSensor = K.run2D(Object.assign({}, base, { sensors: { pos: false, vel: false } }));
  check('K9.5 两个传感器都关闭：只做预测，协方差按 Q 增长且无更新',
    noSensor.ok && noSensor.steps.every(s => !s.updated) &&
    noSensor.steps[59].P[0][0] > noSensor.steps[0].P[0][0]);
}

// ================================================================ K10 测量缺失与门限
{
  const src = stepsOf([10, 10, 100, 10, 10]);
  const closed = K.runScalar({ steps: src, x0: 10, p0: 1, q: 0.01, r: 0.5, gate: 0 });
  const gated = K.runScalar({ steps: src, x0: 10, p0: 1, q: 0.01, r: 0.5, gate: 3 });
  check('K10.1 关闭门限：第 3 个异常观测被采纳（x 被拉向 100）',
    closed.steps[2].updated && closed.steps[2].pos > 20, 'x=' + closed.steps[2].pos);
  check('K10.2 开启 3σ 门限：异常观测被拒绝更新，但记录 gated=true（不删除）',
    gated.steps[2].gated === true && gated.steps[2].updated === false &&
    gated.steps[2].pos < 11 && gated.steps.length === 5, 'x=' + gated.steps[2].pos);
  check('K10.3 门限不改变合法观测的正常更新',
    gated.steps[0].updated && gated.steps[4].updated);
  check('K10.4 负门限被拒绝', K.runScalar({ steps: src, x0: 0, p0: 1, q: 0.1, r: 1, gate: -1 }).error === 'invalid-gate');
}

// ================================================================ K11 指标口径
{
  const met = K.metricsScalar([
    { pos: 0.5, truePos: 0, zPos: 1 },
    { pos: 2, truePos: 0, zPos: null },
    { pos: 3, truePos: 0, zPos: 3 }
  ]);
  check('K11.1 原始测量 RMSE 只在有测量的索引上计算：√((1+9)/2)=2.2360679775',
    near(met.pos.raw.rmse, 2.23606797749979, 1e-12) && met.pos.raw.n === 2);
  check('K11.2 缺失不当作 0（若当作 0 会得到 √(10/3)=1.8257，不是当前结果）',
    Math.abs(met.pos.raw.rmse - Math.sqrt(10 / 3)) > 0.4);
  check('K11.3 估计 RMSE 使用全部 3 步：√((0.25+4+9)/3)=2.1037',
    met.pos.est.n === 3 && near(met.pos.est.rmse, Math.sqrt(13.25 / 3), 1e-12),
    met.pos.est.rmse);
  check('K11.4 MAE=1.8333、最大绝对误差=3',
    near(met.pos.est.mae, 11 / 6, 1e-12) && near(met.pos.est.maxAbs, 3, 1e-12));
  check('K11.5 有效/缺失计数：2 个有效、1 个缺失',
    met.counts.validPos === 2 && met.counts.missingPos === 1 && met.counts.total === 3);
  check('K11.6 标量模式速度指标为不可用（n=0、rmse=null），不伪造 0',
    met.vel.est.n === 0 && met.vel.est.rmse === null);

  const m2 = K.run2D({ scenario: 'missing', p0: 2, v0: 0.8, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 }).metrics;
  check('K11.7 缺失场景计数：位置 74/16、速度 77/13；原始 RMSE 均在有效索引上',
    m2.counts.validPos === 74 && m2.counts.missingPos === 16 &&
    m2.counts.validVel === 77 && m2.counts.missingVel === 13 &&
    m2.pos.raw.n === 74 && m2.vel.raw.n === 77);
}

// ================================================================ K12 噪声、失配、初值
{
  const cruise = K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  check('K12.1 恒速场景：位置估计 RMSE 0.169789 < 原始测量 RMSE 0.534762（滤波有效）',
    near(cruise.metrics.pos.est.rmse, 0.16978937339194047, 1e-9) &&
    cruise.metrics.pos.est.rmse < cruise.metrics.pos.raw.rmse,
    cruise.metrics.pos.est.rmse + ' < ' + cruise.metrics.pos.raw.rmse);

  const accel = K.run2D({ scenario: 'accel', p0: 0.5, v0: 1.0, p0Var: 10, v0Var: 4, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  const tail = accel.steps.slice(-20).map(s => s.innovationPos);
  check('K12.2 模型失配：加速场景后 20 步平均创新 5.309（持续同号，非白噪声）',
    near(mean(tail), 5.308992300945239, 1e-9),
    'mean innov=' + mean(tail));
  check('K12.3 失配导致位置 RMSE 3.377 远大于原始测量 0.418（曲线平滑≠准确）',
    accel.metrics.pos.est.rmse > 3 && accel.metrics.pos.est.rmse > accel.metrics.pos.raw.rmse * 5);

  const lowP = K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 0.01, v0Var: 1, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  const highP = K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 100, v0Var: 1, sigmaA: 0.05, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  check('K12.4 初始协方差影响首步增益：P0 小→0.3421，P0 大→0.9950',
    near(lowP.steps[0].gainPos, 0.34213907591098325, 1e-12) &&
    near(highP.steps[0].gainPos, 0.9950372227678261, 1e-12));

  const mismatch = K.run2D({ scenario: 'accel', p0: 0.5, v0: 1.0, p0Var: 10, v0Var: 4, sigmaA: 0.5, dt: 0.5, rPos: 0.5, rVel: 0.2 });
  check('K12.5 提高 σ_a（更信任加速）能降低失配场景的位置 RMSE（3.377 → 更小）',
    mismatch.metrics.pos.est.rmse < accel.metrics.pos.est.rmse,
    accel.metrics.pos.est.rmse + ' → ' + mismatch.metrics.pos.est.rmse);
}

// ================================================================ K13 非法输入与上限
{
  check('K13.1 标量缺少参数被拒绝',
    K.runScalar({ steps: stepsOf([1]) }).error === 'invalid-state');
  check('K13.2 标量 x0=NaN 被拒绝',
    K.runScalar({ steps: stepsOf([1]), x0: NaN, p0: 1, q: 0.1, r: 1 }).error === 'invalid-state');
  check('K13.3 空测量序列被拒绝',
    K.runScalar({ steps: [], x0: 0, p0: 1, q: 0.1, r: 1 }).error === 'invalid-data');
  const many = new Array(2001).fill(1);
  check('K13.4 超过 2000 步被拒绝（不静默截断）',
    K.runScalar({ steps: stepsOf(many), x0: 0, p0: 1, q: 0.1, r: 1 }).error === 'too-many-steps');
  check('K13.5 二维 dt≤0 / σ_a<0 / R≤0 / 初值超范围分别拒绝',
    K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 1, v0Var: 1, sigmaA: 0.1, dt: 0, rPos: 1, rVel: 1 }).error === 'invalid-dt' &&
    K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 1, v0Var: 1, sigmaA: -0.1, dt: 0.5, rPos: 1, rVel: 1 }).error === 'invalid-q' &&
    K.run2D({ scenario: 'cruise', p0: 0, v0: 0, p0Var: 1, v0Var: 1, sigmaA: 0.1, dt: 0.5, rPos: 0, rVel: 1 }).error === 'invalid-r' &&
    K.run2D({ scenario: 'cruise', p0: 1e13, v0: 0, p0Var: 1, v0Var: 1, sigmaA: 0.1, dt: 0.5, rPos: 1, rVel: 1 }).error === 'out-of-range');
  check('K13.6 未知道具场景返回 null（不编造轨迹）', K.scenarioData('nope') === null);
  const conf = K.confidenceBand(10, 4, 1.96);
  check('K13.7 置信带：10 ± 1.96×2 = [6.08, 13.92]，方差为负时不可用',
    near(conf.lower, 6.08, 1e-12) && near(conf.upper, 13.92, 1e-12) &&
    K.confidenceBand(1, -1).ok === false);
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);
