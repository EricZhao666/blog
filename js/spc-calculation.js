/**
 * Batch 9C-2A：SPC 统计过程控制与过程能力 —— 纯计算模块
 * （无 IO、无存储、无定时器、无随机数：示例数据由固定种子生成，结果确定）
 *
 * 口径（详见 SPC_CAPABILITY_MATH.md，参考 NIST/SEMATECH e-Handbook
 * 6.3.2.1 Individuals Control Charts 与 6.1.6 Process Capability）：
 *
 *   单值—移动极差（I-MR）图，移动极差长度 2：
 *     MR_i = |x_i − x_(i−1)|                （保留生产顺序，绝不先排序）
 *     MR均值 = mean(MR)
 *     σ_within = MR均值 / d2，d2(2) = 1.128
 *     I 图：CL = 样本均值，UCL = CL + 3σ_within，LCL = CL − 3σ_within
 *     MR 图：CL = MR均值，UCL = D4(2) × MR均值 = 3.267 × MR均值，LCL = D3(2) × MR均值 = 0
 *
 *   过程能力（短期用 σ_within，整体用样本标准差 s，n−1）：
 *     Cp  = (USL − LSL) / (6σ_within)
 *     Cpu = (USL − mean) / (3σ_within)
 *     Cpl = (mean − LSL) / (3σ_within)
 *     Cpk = min(Cpu, Cpl)                    （负数如实保留，不截断为 0）
 *     Pp  = (USL − LSL) / (6s)
 *     Ppk = min((USL − mean)/(3s), (mean − LSL)/(3s))
 *
 * 异常判定（仅四类，不声称实现全部 Nelson / Western Electric 规则）：
 *   R1 单点超出 3σ 控制界限（严格 x > UCL 或 x < LCL；等于界限不算）
 *   R2 连续 8 点在中心线同一侧（严格 x > CL 或 x < CL；等于 CL 的点中断运行）
 *   R3 连续 6 点严格递增或严格递减（相等即中断）
 *   R4 移动极差超出 MR 上控制界限（严格 MR > UCL_MR）
 *
 * 异常口径：
 *   不可定义的量返回 null + status（'insufficient-samples' / 'zero-variation' /
 *   'zero-within-variation' / 'no-spec'），绝不返回 NaN / Infinity 冒充有效指标。
 *   零标准差说明「样本未观测到波动」，不据此宣称过程能力无限好。
 *
 * 数值稳定：
 *   均值与离差平方和采用「先减去首个样本的偏移量 + Kahan 补偿求和」的两遍算法，
 *   避免大数值基准（如 1e9 mm）下平方和相消；移动极差直接对相邻原始值作差。
 *
 * 可被 Node 直接 require。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MAX_SAMPLES = 5000;          // 单列样本上限（超出必须报错，不截断）
  var MAX_ABS_VALUE = 1e12;        // 单值绝对值上限，防溢出与无界输入
  var D2 = 1.128;                  // n = 2 的 d2（移动极差长度 2）
  var D4 = 3.267;                  // n = 2 的 D4
  var D3 = 0;                      // n = 2 的 D3
  var RULE_RUN_LENGTH = 8;         // 连续同侧点数
  var RULE_TREND_LENGTH = 6;       // 连续单调点数
  var SMALL_SAMPLE_LIMIT = 10;     // 少于 10 个样本：控制界限可靠性提示
  var CAPABILITY_SAMPLE_HINT = 30; // 少于 30 个样本：能力指数不确定性提示（常见实践，非硬标准）
  var REL_EPS = 1e-12;

  // ---------------------------------------------------------------- 基础工具

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function kahanSum(values) {
    var sum = 0;
    var c = 0;
    for (var i = 0; i < values.length; i++) {
      var y = values[i] - c;
      var t = sum + y;
      c = (t - sum) - y;
      sum = t;
    }
    return sum;
  }

  /** 数值稳定的均值：以首样本为偏移参考，避免大基准下的相消。 */
  function stableMean(values) {
    if (!values.length) return null;
    var shift = values[0];
    var parts = new Array(values.length);
    for (var i = 0; i < values.length; i++) parts[i] = values[i] - shift;
    return shift + kahanSum(parts) / values.length;
  }

  /**
   * 数值稳定的样本标准差（n−1）与离差平方和。
   * 两遍算法 + 偏移参考：先求 (x − shift) 的均值，再对 (x − shift − meanShift) 求平方和。
   */
  function stableVariance(values, mean) {
    var n = values.length;
    if (n < 2) return { variance: null, sumSq: null };
    var shift = values[0];
    var meanShift = mean - shift;
    var parts = new Array(n);
    for (var i = 0; i < n; i++) {
      var d = (values[i] - shift) - meanShift;
      parts[i] = d * d;
    }
    var ss = kahanSum(parts);
    if (!(ss >= 0)) ss = 0;          // 舍入保护：平方和不可能为负
    return { variance: ss / (n - 1), sumSq: ss };
  }

  function sortNumeric(values) {
    return values.slice().sort(function (a, b) { return a - b; });
  }

  /** 中位数：偶数个取中间两数的平均值（不修改原数组）。 */
  function median(values) {
    var n = values.length;
    if (!n) return null;
    var s = sortNumeric(values);
    var mid = Math.floor(n / 2);
    return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ---------------------------------------------------------------- 规格校验

  /**
   * 规格上下限校验：只接受有限数字，且要求 LSL < USL（严格）。
   * 单边规格首版不支持能力指数（公式要求双边）。
   */
  function validateSpec(spec) {
    var s = spec || {};
    var out = {
      lsl: null, usl: null, target: null, unit: '',
      ok: false, error: null, message: '', flags: []
    };
    if (isFiniteNumber(s.lsl)) out.lsl = s.lsl;
    if (isFiniteNumber(s.usl)) out.usl = s.usl;
    if (isFiniteNumber(s.target)) out.target = s.target;
    if (typeof s.unit === 'string') out.unit = s.unit.slice(0, 12);

    var missing = !isFiniteNumber(out.lsl) || !isFiniteNumber(out.usl);
    if (missing) {
      out.error = 'missing-spec';
      out.message = '需要同时提供规格下限 LSL 与上限 USL（有限数字）才能计算能力指数。';
      return out;
    }
    if (Math.abs(out.lsl) > MAX_ABS_VALUE || Math.abs(out.usl) > MAX_ABS_VALUE) {
      out.error = 'spec-out-of-range';
      out.message = '规格界限绝对值不能超过 ' + MAX_ABS_VALUE + '。';
      return out;
    }
    if (!(out.lsl < out.usl)) {
      out.error = 'invalid-spec-range';
      out.message = '规格下限 LSL（' + out.lsl + '）必须严格小于上限 USL（' + out.usl + '）。';
      return out;
    }
    if (out.target !== null) {
      if (Math.abs(out.target) > MAX_ABS_VALUE) {
        out.error = 'target-out-of-range';
        out.message = '目标值绝对值不能超过 ' + MAX_ABS_VALUE + '。';
        return out;
      }
      if (out.target < out.lsl || out.target > out.usl) {
        out.flags.push('target-outside-spec');
      }
    }
    out.ok = true;
    return out;
  }

  /** 允许调用方直接传 {lsl, usl}：不是 validateSpec 的输出时重新校验一次。 */
  function normalizeSpec(spec) {
    if (spec && spec.ok === true) return spec;
    return validateSpec(spec);
  }

  // ---------------------------------------------------------------- 数据解析

  var NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  var SEP_RE = /[ \t\u3000,;，；]+/;

  function fail(error, message, extra) {
    var out = { ok: false, error: error, message: message };
    if (extra) {
      if (extra.line !== undefined) out.line = extra.line;
      if (extra.column !== undefined) out.column = extra.column;
      if (extra.token !== undefined) out.token = extra.token;
      if (extra.index !== undefined) out.index = extra.index;
    }
    return out;
  }

  /**
   * 解析单列测量数据。
   * 明确约定的分隔形式：换行（\n / \r\n / \r）、英文逗号、分号、空白（空格/制表符/全角空格），
   * 以及中文全角逗号、全角分号。不支持把逗号当小数点，也不解析多列生产日志。
   *
   * 任何非法 token 都返回**具体位置**（行号 + 该行第几个数据）并拒绝整份输入，
   * 绝不静默删除非法样本后继续计算。
   */
  function parseMeasurements(text, opts) {
    if (typeof text !== 'string') {
      return fail('invalid-input', '输入必须是文本。');
    }
    var maxSamples = (opts && isFiniteNumber(opts.maxSamples)) ? opts.maxSamples : MAX_SAMPLES;
    var values = [];
    var tokens = [];
    var seen = Object.create(null);
    var duplicateCount = 0;
    var lines = text.split(/\r\n|\n|\r/);

    for (var li = 0; li < lines.length; li++) {
      var parts = lines[li].split(SEP_RE);
      var column = 0;
      for (var pi = 0; pi < parts.length; pi++) {
        var raw = parts[pi];
        if (raw === '') continue;
        column++;

        if (!NUM_RE.test(raw)) {
          return fail('invalid-number',
            '第 ' + (li + 1) + ' 行第 ' + column + ' 个数据「' + raw.slice(0, 24) + '」不是有效数字' +
            '（不支持 NaN、Infinity、千分位逗号或单位后缀）。',
            { line: li + 1, column: column, token: raw.slice(0, 24) });
        }
        var v = Number(raw);
        if (!isFiniteNumber(v)) {
          return fail('non-finite',
            '第 ' + (li + 1) + ' 行第 ' + column + ' 个数据「' + raw.slice(0, 24) + '」不是有限数字。',
            { line: li + 1, column: column, token: raw.slice(0, 24) });
        }
        if (Math.abs(v) > MAX_ABS_VALUE) {
          return fail('value-out-of-range',
            '第 ' + (li + 1) + ' 行第 ' + column + ' 个数据「' + raw.slice(0, 24) + '」超出单值上限 ±' +
            MAX_ABS_VALUE + '，请检查单位（如把微米当毫米）。',
            { line: li + 1, column: column, token: raw.slice(0, 24) });
        }
        if (values.length >= maxSamples) {
          return fail('too-many-samples',
            '第 ' + (li + 1) + ' 行第 ' + column + ' 个数据：样本数超过上限 ' + maxSamples +
            ' 个（当前第 ' + (values.length + 1) + ' 个）。请分段分析或抽取子组。',
            { line: li + 1, column: column, token: raw.slice(0, 24), index: values.length + 1 });
        }
        values.push(v);
        tokens.push({ value: v, line: li + 1, column: column });

        var key = String(v);
        if (seen[key]) duplicateCount++;
        else seen[key] = 1;
      }
    }

    if (!values.length) {
      return fail('empty-input', '没有解析到任何测量数据。请粘贴单列数值，或用「恢复默认示例」载入示例。');
    }
    return {
      ok: true,
      values: values,
      tokens: tokens,
      count: values.length,
      duplicateCount: duplicateCount,
      warnings: duplicateCount > 0
        ? ['检测到 ' + duplicateCount + ' 个重复数值：重复值按独立测量样本保留，不去重、不合并。']
        : []
    };
  }

  // ---------------------------------------------------------------- 描述统计

  /**
   * 描述统计 + 移动极差。保留原始顺序（MR 依赖生产顺序）。
   * 不可定义的量返回 null 并给出 status，不返回 NaN / Infinity。
   */
  function summarize(values) {
    var n = values.length;
    if (!n) {
      return {
        ok: false, n: 0, mean: null, median: null, min: null, max: null, range: null,
        s: null, sStatus: 'insufficient-samples',
        mr: { values: [], mean: null, count: 0, status: 'insufficient-samples' },
        sigmaWithin: null, sigmaStatus: 'insufficient-samples'
      };
    }
    var mean = stableMean(values);
    var min = values[0], max = values[0];
    for (var i = 1; i < n; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var vr = stableVariance(values, mean);
    var s = vr.variance === null ? null : Math.sqrt(vr.variance);
    var sStatus = s === null ? 'insufficient-samples' : (s === 0 ? 'zero-variation' : 'ok');

    var mrValues = [];
    for (var j = 1; j < n; j++) mrValues.push(Math.abs(values[j] - values[j - 1]));
    var mrMean = mrValues.length ? kahanSum(mrValues) / mrValues.length : null;
    var mrStatus = mrMean === null ? 'insufficient-samples' : (mrMean === 0 ? 'zero-variation' : 'ok');
    var sigmaWithin = mrMean === null ? null : mrMean / D2;
    var sigmaStatus = sigmaWithin === null
      ? 'insufficient-samples'
      : (sigmaWithin === 0 ? 'zero-within-variation' : 'ok');

    return {
      ok: true,
      n: n,
      mean: mean,
      median: median(values),
      min: min,
      max: max,
      range: max - min,
      s: s,
      sStatus: sStatus,
      mr: { values: mrValues, mean: mrMean, count: mrValues.length, status: mrStatus },
      sigmaWithin: sigmaWithin,
      sigmaStatus: sigmaStatus
    };
  }

  // ---------------------------------------------------------------- 控制界限

  /**
   * 由均值与平均移动极差构造 I / MR 控制界限。
   * MR 长度固定为 2 → d2 = 1.128、D3 = 0、D4 = 3.267。
   */
  function computeLimits(mean, mrMean) {
    if (!isFiniteNumber(mean)) {
      return {
        ok: false, status: 'insufficient-samples', sigmaWithin: null,
        i: { cl: null, ucl: null, lcl: null },
        mr: { cl: null, ucl: null, lcl: null }
      };
    }
    var sigmaWithin = isFiniteNumber(mrMean) ? mrMean / D2 : null;
    var out = {
      ok: sigmaWithin !== null,
      status: sigmaWithin === null
        ? 'insufficient-samples'
        : (sigmaWithin === 0 ? 'zero-within-variation' : 'ok'),
      sigmaWithin: sigmaWithin,
      d2: D2, d3: D3, d4: D4,
      i: {
        cl: mean,
        ucl: sigmaWithin === null ? null : mean + 3 * sigmaWithin,
        lcl: sigmaWithin === null ? null : mean - 3 * sigmaWithin
      },
      mr: {
        cl: isFiniteNumber(mrMean) ? mrMean : null,
        ucl: isFiniteNumber(mrMean) ? D4 * mrMean : null,
        lcl: isFiniteNumber(mrMean) ? D3 * mrMean : 0
      }
    };
    return out;
  }

  // ---------------------------------------------------------------- 异常检测

  var RULES = {
    'i-beyond-limits': {
      id: 'i-beyond-limits',
      name: '单点超出 3σ 控制界限',
      definition: 'x_i > UCL 或 x_i < LCL（严格不等式；恰好等于界限不算失控）'
    },
    'i-run-same-side': {
      id: 'i-run-same-side',
      name: '连续 8 点在中心线同一侧',
      definition: '连续 8 个点严格大于 CL 或严格小于 CL；等于 CL 的点中断该运行'
    },
    'i-trend': {
      id: 'i-trend',
      name: '连续 6 点严格递增或递减',
      definition: '连续 6 个点严格单调；出现相等值即中断'
    },
    'mr-beyond-limits': {
      id: 'mr-beyond-limits',
      name: '移动极差超出上控制界限',
      definition: 'MR_i > UCL_MR（严格不等式；MR 下界为 0，不做下侧判定）'
    }
  };

  /**
   * 四项规则检测。index 一律为 1-based 样本序号，对应原始生产顺序。
   * 界限为 null 时对应规则不执行（不伪造命中）。
   *
   * 「等于中心线 / 恰好等于控制界限」用相对容差判定（1e-12 × 量级）：
   * 均值来自浮点求和，若用严格 `===` 判断"等于 CL"，10.0098 这样的样本
   * 会因为均值表示为 10.009800000000001 被判成"小于中心线"，把规则 2 的
   * 运行段错误延长。容差只影响边界判定，不改变超过界限的严格性。
   */
  function detectViolations(values, limits) {
    var n = values.length;
    var hits = [];
    var pointRules = [];
    for (var p = 0; p < n; p++) pointRules.push([]);

    var iLim = (limits && limits.i) || {};
    var mrLim = (limits && limits.mr) || {};
    var hasI = isFiniteNumber(iLim.ucl) && isFiniteNumber(iLim.lcl) && isFiniteNumber(iLim.cl);
    var hasMr = isFiniteNumber(mrLim.ucl) && isFiniteNumber(mrLim.cl);
    var tolI = hasI ? Math.max(Math.abs(iLim.cl), Math.abs(iLim.ucl), Math.abs(iLim.lcl), 1) * REL_EPS : 0;
    var tolMr = hasMr ? Math.max(Math.abs(mrLim.ucl), Math.abs(mrLim.cl), 1) * REL_EPS : 0;

    function sideOf(v) {
      var d = v - iLim.cl;
      if (Math.abs(d) <= tolI) return 0;
      return d > 0 ? 1 : -1;
    }

    // R1 单点超出 3σ 控制界限
    if (hasI) {
      var idx1 = [];
      for (var i = 0; i < n; i++) {
        if (values[i] > iLim.ucl + tolI || values[i] < iLim.lcl - tolI) {
          idx1.push(i + 1);
          pointRules[i].push('i-beyond-limits');
        }
      }
      if (idx1.length) hits.push(buildHit('i-beyond-limits', idx1, values, iLim));
    }

    // R2 连续 8 点同侧（等于 CL 中断）
    if (hasI) {
      var runs = [];
      var cursor = 0;
      while (cursor < n) {
        var side = sideOf(values[cursor]);
        if (side === 0) { cursor++; continue; }
        var end = cursor + 1;
        while (end < n && sideOf(values[end]) === side) end++;
        if (end - cursor >= RULE_RUN_LENGTH) {
          var runIdx = [];
          for (var k = cursor; k < end; k++) {
            runIdx.push(k + 1);
            pointRules[k].push('i-run-same-side');
          }
          runs.push({ side: side, indexes: runIdx });
        }
        cursor = end;
      }
      if (runs.length) {
        var allIdx = [];
        runs.forEach(function (r) { allIdx = allIdx.concat(r.indexes); });
        var hit2 = buildHit('i-run-same-side', allIdx, values, iLim);
        hit2.runs = runs.map(function (r) {
          return { side: r.side > 0 ? 'above' : 'below', indexes: r.indexes };
        });
        hits.push(hit2);
      }
    }

    // R3 连续 6 点严格单调
    var trendIdx = [];
    if (n >= RULE_TREND_LENGTH) {
      var dir = 0, runStart = 0;
      for (var t = 1; t < n; t++) {
        var d = sign(values[t] - values[t - 1]);
        if (d !== 0 && d === dir) {
          if (t - runStart + 1 >= RULE_TREND_LENGTH) {
            for (var q = runStart; q <= t; q++) {
              if (trendIdx.indexOf(q + 1) === -1) trendIdx.push(q + 1);
              if (pointRules[q].indexOf('i-trend') === -1) pointRules[q].push('i-trend');
            }
          }
        } else if (d !== 0) {
          dir = d;
          runStart = t - 1;
        } else {
          dir = 0;
          runStart = t;
        }
      }
      if (trendIdx.length) {
        trendIdx.sort(function (a, b) { return a - b; });
        var hit3 = buildHit('i-trend', trendIdx, values, iLim);
        hit3.points = null;
        hits.push(hit3);
      }
    }

    // R4 移动极差超出上控制界限
    if (hasMr) {
      var idx4 = [];
      for (var m = 1; m < n; m++) {
        var mr = Math.abs(values[m] - values[m - 1]);
        if (mr > mrLim.ucl + tolMr) {
          idx4.push(m + 1);          // MR_i 的序号对应第 i 个样本（i = m+1，1-based）
          if (pointRules[m].indexOf('mr-beyond-limits') === -1) pointRules[m].push('mr-beyond-limits');
        }
      }
      if (idx4.length) hits.push(buildHit('mr-beyond-limits', idx4, values, mrLim));
    }

    var counts = { 'i-beyond-limits': 0, 'i-run-same-side': 0, 'i-trend': 0, 'mr-beyond-limits': 0 };
    hits.forEach(function (h) { counts[h.rule] = h.indexes.length; });

    return { violations: hits, pointRules: pointRules, counts: counts };
  }

  function sign(v) {
    if (v > 0) return 1;
    if (v < 0) return -1;
    return 0;
  }

  function buildHit(rule, indexes, values, lim) {
    var ruleDef = RULES[rule];
    return {
      rule: rule,
      name: ruleDef.name,
      definition: ruleDef.definition,
      indexes: indexes.slice(),
      firstIndex: indexes[0],
      count: indexes.length,
      points: indexes.map(function (i) { return values[i - 1]; }),
      limit: lim && isFiniteNumber(lim.ucl)
        ? { cl: lim.cl, ucl: lim.ucl, lcl: lim.lcl }
        : null
    };
  }

  // ---------------------------------------------------------------- 过程能力

  /**
   * 过程能力指数。
   * @param {Object} p {mean, sigmaWithin, s, lsl, usl, n}
   * 规格无效 / 波动估计不可用 / 零波动 → 对应指数 null + status，不返回 Infinity。
   * Cpk / Ppk 允许负值（均值在规格外），不截断为 0。
   */
  function capability(p) {
    var spec = validateSpec({ lsl: p.lsl, usl: p.usl });
    var mean = p.mean;
    var sw = p.sigmaWithin;
    var s = p.s;
    var out = {
      cp: null, cpu: null, cpl: null, cpk: null,
      pp: null, ppk: null,
      status: { cp: 'ok', cpu: 'ok', cpl: 'ok', cpk: 'ok', pp: 'ok', ppk: 'ok' },
      flags: [],
      basis: p.basis || 'all-samples'
    };
    if (!spec.ok) {
      ['cp', 'cpu', 'cpl', 'cpk', 'pp', 'ppk'].forEach(function (k) { out.status[k] = 'no-spec'; });
      out.specError = spec.error;
      return out;
    }
    if (!isFiniteNumber(mean)) {
      ['cp', 'cpu', 'cpl', 'cpk', 'pp', 'ppk'].forEach(function (k) { out.status[k] = 'insufficient-samples'; });
      return out;
    }

    var width = spec.usl - spec.lsl;
    var shortStatus = !isFiniteNumber(sw)
      ? 'insufficient-samples'
      : (sw === 0 ? 'zero-within-variation' : 'ok');
    if (shortStatus !== 'ok') {
      ['cp', 'cpu', 'cpl', 'cpk'].forEach(function (k) { out.status[k] = shortStatus; });
      out.flags.push(shortStatus);
    } else {
      out.cp = width / (6 * sw);
      out.cpu = (spec.usl - mean) / (3 * sw);
      out.cpl = (mean - spec.lsl) / (3 * sw);
      out.cpk = Math.min(out.cpu, out.cpl);      // 负值保留
    }

    var longStatus = !isFiniteNumber(s)
      ? 'insufficient-samples'
      : (s === 0 ? 'zero-variation' : 'ok');
    if (longStatus !== 'ok') {
      ['pp', 'ppk'].forEach(function (k) { out.status[k] = longStatus; });
      out.flags.push(longStatus);
    } else {
      out.pp = width / (6 * s);
      out.ppk = Math.min((spec.usl - mean) / (3 * s), (mean - spec.lsl) / (3 * s));
    }

    if (isFiniteNumber(p.n) && p.n < CAPABILITY_SAMPLE_HINT) out.flags.push('small-sample-capability');
    if (isFiniteNumber(out.cpk) && out.cpk < 0) out.flags.push('mean-outside-spec');
    if (isFiniteNumber(out.cpk) && out.cpk < 1) out.flags.push('cpk-below-1');
    return out;
  }

  // ---------------------------------------------------------------- 分布与不良率

  /** Numerical Recipes erfc 有理近似，|相对误差| < 1.2e-7（足够教学与 PPM 量级判断）。 */
  function erfc(x) {
    var z = Math.abs(x);
    var t = 1 / (1 + 0.5 * z);
    var ans = t * Math.exp(-z * z - 1.26551223 +
      t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
      t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? ans : 2 - ans;
  }

  function normalTailBelow(z) { return 0.5 * erfc(-z / Math.SQRT2); }
  function normalTailAbove(z) { return 0.5 * erfc(z / Math.SQRT2); }

  /**
   * 样本正态拟合（均值 = 样本均值，σ = 样本标准差 s）。
   * 理论不良率/ PPM 是**模型估计**，与实测超规比例分开返回。
   */
  function normalFit(values, stats, spec) {
    var st = stats || summarize(values);
    var sp = normalizeSpec(spec);
    var mean = st.mean;
    var s = st.s;
    var out = {
      ok: false,
      basis: 'sample-mean-and-sample-sd',
      mean: mean,
      s: s,
      ppmBelow: null,
      ppmAbove: null,
      ppmTotal: null,
      assumption: '正态分布拟合（均值=样本均值，σ=样本标准差 s），仅用于教学对照'
    };
    if (!isFiniteNumber(mean) || !isFiniteNumber(s)) return out;
    if (s === 0) {
      out.status = 'zero-variation';
      return out;
    }
    out.ok = true;
    out.status = 'ok';
    if (sp.ok) {
      out.ppmBelow = normalTailBelow((sp.lsl - mean) / s) * 1e6;
      out.ppmAbove = normalTailAbove((sp.usl - mean) / s) * 1e6;
      out.ppmTotal = out.ppmBelow + out.ppmAbove;
    }
    return out;
  }

  /**
   * 直方图分箱（Sturges 近似：k ≈ ceil(sqrt(n))，5–40 之间）。
   * 视图范围覆盖数据与规格界限；分箱从数据最小值开始，不改变数值本身。
   */
  function histogram(values, spec) {
    var n = values.length;
    if (!n) return null;
    var sp = normalizeSpec(spec);
    var min = values[0], max = values[0];
    for (var i = 1; i < n; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var k = Math.max(5, Math.min(40, Math.ceil(Math.sqrt(n))));
    var lo = min, hi = max;
    if (sp.ok) {
      lo = Math.min(lo, sp.lsl);
      hi = Math.max(hi, sp.usl);
    }
    if (hi - lo <= 0) {
      var pad = Math.abs(lo) * 0.01 || 1;
      lo -= pad / 2;
      hi += pad / 2;
    }
    var pad2 = (hi - lo) * 0.02;
    var dataLo = min, dataHi = max;
    var binWidth = (dataHi - dataLo) / k;
    if (!(binWidth > 0)) {
      // 全部数值相同：单个非零宽箱（不制造虚构波动）
      return {
        k: 1, binWidth: 0, dataMin: min, dataMax: max,
        viewMin: lo - pad2, viewMax: hi + pad2,
        bins: [{ x0: min, x1: min, count: n }]
      };
    }
    var bins = [];
    for (var b = 0; b < k; b++) bins.push({ x0: dataLo + b * binWidth, x1: dataLo + (b + 1) * binWidth, count: 0 });
    for (var j = 0; j < n; j++) {
      var idx = Math.floor((values[j] - dataLo) / binWidth);
      if (idx >= k) idx = k - 1;
      if (idx < 0) idx = 0;
      bins[idx].count++;
    }
    return {
      k: k,
      binWidth: binWidth,
      dataMin: min,
      dataMax: max,
      viewMin: lo - pad2,
      viewMax: hi + pad2,
      bins: bins
    };
  }

  // ---------------------------------------------------------------- 冻结基线

  /**
   * 由指定样本段（1-based，含端点）建立冻结基线。
   * 基线至少 2 个样本才能估计移动极差；样本不足时拒绝建立，不给出虚假界限。
   */
  function buildBaseline(values, start, end) {
    var n = values.length;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) ||
        Math.floor(start) !== start || Math.floor(end) !== end) {
      return { ok: false, error: 'invalid-range', message: '基线起止序号必须是整数。' };
    }
    if (start < 1 || end > n || start > end) {
      return {
        ok: false, error: 'invalid-range',
        message: '基线范围必须在 1–' + n + ' 之间，且起始序号不大于结束序号（当前 ' + start + '–' + end + '）。'
      };
    }
    var count = end - start + 1;
    if (count < 2) {
      return {
        ok: false, error: 'insufficient-baseline',
        message: '基线至少需要 2 个样本才能估计移动极差（当前 ' + count + ' 个）。'
      };
    }
    var seg = values.slice(start - 1, end);
    var st = summarize(seg);
    var lim = computeLimits(st.mean, st.mr.mean);
    if (!lim.ok) {
      return { ok: false, error: 'insufficient-baseline', message: '基线样本不足以估计控制界限。' };
    }
    return {
      ok: true,
      start: start,
      end: end,
      count: count,
      mean: st.mean,
      s: st.s,
      sStatus: st.sStatus,
      mrMean: st.mr.mean,
      sigmaWithin: lim.sigmaWithin,
      limits: { i: lim.i, mr: lim.mr },
      frozen: true,
      status: lim.status
    };
  }

  // ---------------------------------------------------------------- 图表抽样

  /**
   * 大样本绘图抽样：只影响**绘制**，统计与异常检测始终使用全部原始样本。
   * 异常点强制保留，避免图形遗漏真实异常记录。
   */
  function chartSample(values, pointRules, maxPoints) {
    var n = values.length;
    var cap = maxPoints || 400;
    var step = Math.max(1, Math.ceil(n / cap));
    var indexes = [];
    for (var i = 0; i < n; i += step) indexes.push(i);
    if (indexes[indexes.length - 1] !== n - 1) indexes.push(n - 1);
    var forced = [];
    for (var p = 0; p < n; p++) {
      if (pointRules && pointRules[p] && pointRules[p].length) {
        if (indexes.indexOf(p) === -1) forced.push(p);
      }
    }
    forced.sort(function (a, b) { return a - b; });
    return {
      step: step,
      drawn: indexes.length + forced.length,
      total: n,
      sampled: step > 1,
      indexes: indexes,
      forced: forced
    };
  }

  // ---------------------------------------------------------------- 实测模式一站式

  /**
   * 实测数据分析（唯一允许把样本统计当作过程估计的模式）。
   * @param {Object} input {values, spec:{lsl,usl,target,unit}, baseline:{start,end}|null}
   */
  function computeMeasured(input) {
    var values = (input && input.values) || [];
    if (!values.length) {
      return { ok: false, mode: 'measured', error: 'empty-input', message: '没有测量数据。' };
    }
    for (var i = 0; i < values.length; i++) {
      if (!isFiniteNumber(values[i]) || Math.abs(values[i]) > MAX_ABS_VALUE) {
        return {
          ok: false, mode: 'measured', error: 'invalid-value',
          message: '第 ' + (i + 1) + ' 个样本不是有效有限数字。'
        };
      }
    }
    var spec = validateSpec(input && input.spec);
    var stats = summarize(values);
    var flags = [];
    var warnings = [];

    if (stats.n < 2) {
      flags.push('insufficient-samples');
      warnings.push('只有 1 个样本：无法估计移动极差与短期波动，I/MR 控制界限不可建立。');
    } else if (stats.n < SMALL_SAMPLE_LIMIT) {
      flags.push('small-sample');
      warnings.push('样本量仅 ' + stats.n + ' 个：控制界限估计不确定性很大，不宣称已建立稳定控制界限。');
    }
    if (stats.sigmaStatus === 'zero-within-variation') {
      flags.push('zero-within-variation');
      warnings.push('相邻样本完全一致，未观测到短期波动：σ_within = 0，Cp/Cpk 不适用。' +
        '这表示当前数据没有提供波动信息，不表示过程能力无限好。');
    }
    if (stats.sStatus === 'zero-variation' && stats.n >= 2) {
      flags.push('zero-variation');
      warnings.push('全部样本相同，样本标准差 s = 0：Pp/Ppk 不适用，也不表示过程受控。');
    }
    if (!spec.ok) {
      flags.push('spec-invalid');
      warnings.push(spec.message + ' 控制图仍可显示，但能力指数与超规比例不计算。');
    }
    if (spec.ok && spec.flags.indexOf('target-outside-spec') !== -1) {
      warnings.push('目标值 ' + spec.target + ' 落在规格界限之外，请核对该参数。');
    }

    // 冻结基线：界限固定为基线段估计值，后续样本只做监测
    var baseline = null;
    var limits;
    var basis;
    if (input && input.baseline) {
      var b = buildBaseline(values, input.baseline.start, input.baseline.end);
      if (!b.ok) {
        return { ok: false, mode: 'measured', error: b.error, message: b.message };
      }
      baseline = b;
      limits = {
        i: { cl: b.limits.i.cl, ucl: b.limits.i.ucl, lcl: b.limits.i.lcl },
        mr: { cl: b.limits.mr.cl, ucl: b.limits.mr.ucl, lcl: b.limits.mr.lcl },
        sigmaWithin: b.sigmaWithin,
        status: b.status,
        frozen: true
      };
      basis = 'baseline';
      flags.push('baseline-frozen');
      warnings.push('已冻结基线（第 ' + b.start + '–' + b.end + ' 个样本，共 ' + b.count +
        ' 个）：控制界限固定，后续样本按固定界限检测，不会因为新增异常数据而重新计算界限。');
    } else {
      var live = computeLimits(stats.mean, stats.mr.mean);
      limits = {
        i: live.i, mr: live.mr, sigmaWithin: live.sigmaWithin,
        status: live.status, frozen: false
      };
      basis = 'all-samples';
    }

    var det = detectViolations(values, limits);
    if (det.counts['i-beyond-limits'] > 0 ||
        det.counts['i-run-same-side'] > 0 ||
        det.counts['i-trend'] > 0 ||
        det.counts['mr-beyond-limits'] > 0) {
      flags.push('signals-present');
    }

    var capBasis;
    if (baseline) {
      capBasis = capability({
        mean: baseline.mean, sigmaWithin: baseline.sigmaWithin, s: baseline.s,
        lsl: spec.lsl, usl: spec.usl, n: baseline.count, basis: 'baseline'
      });
    } else {
      capBasis = capability({
        mean: stats.mean, sigmaWithin: stats.sigmaWithin, s: stats.s,
        lsl: spec.lsl, usl: spec.usl, n: stats.n, basis: 'all-samples'
      });
    }

    var outOfSpec = null;
    if (spec.ok) {
      var bad = [];
      for (var k = 0; k < values.length; k++) {
        if (values[k] < spec.lsl || values[k] > spec.usl) {
          bad.push(k + 1);
        }
      }
      outOfSpec = {
        count: bad.length,
        ratio: bad.length / values.length,
        indexes: bad
      };
    } else {
      outOfSpec = { count: null, ratio: null, indexes: [], status: 'no-spec' };
    }

    // 监测段（基线之后的样本）与基线均值的偏移：用于提示"界限未漂移"
    var monitoring = null;
    if (baseline) {
      var post = values.slice(baseline.end);
      if (post.length) {
        monitoring = {
          count: post.length,
          start: baseline.end + 1,
          end: values.length,
          mean: stableMean(post),
          meanShift: stableMean(post) - baseline.mean,
          outsideControlLimits: det.pointRules.slice(baseline.end).filter(function (r) { return r.length; }).length
        };
      }
    }

    var fit = normalFit(values, stats, spec);
    var hist = histogram(values, spec);

    return {
      ok: true,
      mode: 'measured',
      n: stats.n,
      values: values,              // 原始顺序引用（图表使用；统计与异常检测均已基于全部样本）
      stats: stats,
      spec: spec,
      limits: limits,
      limitsBasis: basis,
      baseline: baseline,
      monitoring: monitoring,
      violations: det.violations,
      violationCounts: det.counts,
      pointRules: det.pointRules,
      capability: capBasis,
      outOfSpec: outOfSpec,
      fit: fit,
      histogram: hist,
      chartSample: chartSample(values, det.pointRules, 400),
      flags: flags,
      warnings: warnings
    };
  }

  // ---------------------------------------------------------------- 理论模式

  /**
   * 理论参数模式：均值与标准差由用户直接输入（总体参数），
   * 不混入任何实测样本估计，因此不产生控制图、不产生 Pp/Ppk。
   */
  function computeTheoretical(input) {
    var mean = input && input.mean;
    var sd = input && input.sd;
    if (!isFiniteNumber(mean) || Math.abs(mean) > MAX_ABS_VALUE) {
      return { ok: false, mode: 'theoretical', error: 'invalid-mean', message: '过程均值必须是绝对值不超过 ' + MAX_ABS_VALUE + ' 的有限数字。' };
    }
    if (!isFiniteNumber(sd) || sd <= 0 || sd > MAX_ABS_VALUE) {
      return { ok: false, mode: 'theoretical', error: 'invalid-sd', message: '过程标准差必须是大于 0 的有限数字（理论模式不使用样本估计）。' };
    }
    var spec = validateSpec(input);
    var flags = ['theoretical-parameters'];
    if (!spec.ok) flags.push('spec-invalid');
    var cap = capability({
      mean: mean, sigmaWithin: sd, s: null,
      lsl: spec.lsl, usl: spec.usl, n: null, basis: 'theoretical'
    });
    // 理论模式只声明短期能力（σ 由用户给定），Pp/Ppk 明确不适用
    cap.pp = null;
    cap.ppk = null;
    cap.status.pp = 'not-applicable-theoretical';
    cap.status.ppk = 'not-applicable-theoretical';
    cap.flags = cap.flags.filter(function (f) {
      return f !== 'insufficient-samples' && f !== 'small-sample-capability';
    });
    var ppm = null;
    if (spec.ok) {
      ppm = {
        below: normalTailBelow((spec.lsl - mean) / sd) * 1e6,
        above: normalTailAbove((spec.usl - mean) / sd) * 1e6,
        total: null
      };
      ppm.total = ppm.below + ppm.above;
    }
    return {
      ok: true,
      mode: 'theoretical',
      mean: mean,
      sd: sd,
      spec: spec,
      capability: cap,
      ppm: ppm,
      flags: flags,
      warnings: ['理论参数模式：均值与标准差由你直接输入，图表是总体正态分布，不是实测数据。'],
      chartSample: null,
      violations: [],
      violationCounts: { 'i-beyond-limits': 0, 'i-run-same-side': 0, 'i-trend': 0, 'mr-beyond-limits': 0 }
    };
  }

  // ---------------------------------------------------------------- 教学示例

  /**
   * 固定种子的确定性伪随机（xorshift32：只用位移与异或，跨引擎精确一致）。
   * 例：seed 1 → 前几个 [0.7556, 0.2858, ...]（见 SPC_CAPABILITY_MATH.md）。
   */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5); s >>>= 0;
      return s / 4294967296;
    };
  }

  /** Box–Muller 正态抽样（只用第一个分量），结果圆整到 0.001 保证跨引擎一致。 */
  function normalSampler(seed) {
    var rnd = makeRng(seed);
    return function (mu, sigma) {
      var u1 = Math.max(rnd(), 1e-12);
      var u2 = rnd();
      var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.round((mu + sigma * z) * 1000) / 1000;
    };
  }

  function buildCentered() {
    // 种子 10：60 个样本内四项规则均无命中、无超规（示例 ① 的教学前提）
    var g = normalSampler(10);
    var out = [];
    for (var i = 0; i < 60; i++) out.push(g(10.0, 0.015));
    return out;
  }

  function buildShifted() {
    var g = normalSampler(23);
    var out = [];
    for (var i = 0; i < 60; i++) out.push(g(10.062, 0.015));
    return out;
  }

  function buildDrift() {
    var g = normalSampler(37);
    var out = [];
    for (var i = 0; i < 60; i++) {
      // 前 20 点稳定，之后随生产顺序线性漂移 +0.04（模拟刀具磨损/温度爬升）。
      // 漂移总量约 3.5σ_within：越界点不多，但连续同侧、越界与局部趋势同时出现，
      // 正好展示"Cp/Cpk 仍很高，过程却已经不稳定"。
      var drift = i < 20 ? 0 : (i - 19) * (0.04 / 40);
      out.push(g(10.0 + drift, 0.012));
    }
    return out;
  }

  function buildSpike() {
    var g = normalSampler(53);
    var out = [];
    for (var i = 0; i < 60; i++) {
      var v = g(10.0, 0.010);
      if (i === 30) v = 10.182;
      if (i === 31) v = 10.191;
      if (i === 32) v = 10.176;
      out.push(v);
    }
    return out;
  }

  function textOf(arr) {
    var lines = [];
    for (var i = 0; i < arr.length; i += 6) lines.push(arr.slice(i, i + 6).join(', '));
    return lines.join('\n');
  }

  var EXAMPLE_DEFS = [
    {
      id: 'centered',
      name: '① 过程居中、波动较小（合成数据）',
      note: '注塑尺寸教学背景：均值接近目标值、短期波动小。观察 Cp 与 Cpk 接近，且控制图无信号。',
      spec: { lsl: 9.9, usl: 10.1, target: 10.0, unit: 'mm' },
      build: buildCentered
    },
    {
      id: 'shifted',
      name: '② 均值偏移、短期波动仍小（合成数据）',
      note: '均值整体偏向规格上限：Cp 仍较高，但 Cpk 明显更低——只看 Cp 会误判过程能力。',
      spec: { lsl: 9.9, usl: 10.1, target: 10.0, unit: 'mm' },
      build: buildShifted
    },
    {
      id: 'drift',
      name: '③ 随生产顺序持续漂移（合成数据）',
      note: '模拟刀具磨损/温度爬升：前 20 点稳定，之后均值线性上移。I 图出现连续同侧、越界与局部趋势信号；Cpk 仍可能很高，但过程已经不稳定——冻结基线后仍按固定界限报警。',
      spec: { lsl: 9.9, usl: 10.1, target: 10.0, unit: 'mm' },
      build: buildDrift
    },
    {
      id: 'spike',
      name: '④ 突发异常并恢复（合成数据）',
      note: '焊接拉力教学背景（合成数值）：第 31–33 点突发抬升并超出规格，随后恢复。观察超规样本、MR 尖峰与冻结基线的区别。',
      spec: { lsl: 9.9, usl: 10.1, target: 10.0, unit: 'mm' },
      build: buildSpike
    }
  ];

  var EXAMPLE_CACHE = {};
  var EXAMPLES = EXAMPLE_DEFS.map(function (d) {
    EXAMPLE_CACHE[d.id] = null;
    return {
      id: d.id,
      name: d.name,
      note: d.note,
      spec: { lsl: d.spec.lsl, usl: d.spec.usl, target: d.spec.target, unit: d.spec.unit },
      synthetic: true
    };
  });

  /** 按需生成示例文本（首次生成后缓存，保证同一会话内完全一致）。 */
  function exampleValues(id) {
    var def = EXAMPLE_DEFS.filter(function (d) { return d.id === id; })[0];
    if (!def) return null;
    if (!EXAMPLE_CACHE[id]) EXAMPLE_CACHE[id] = def.build();
    return EXAMPLE_CACHE[id].slice();
  }

  function exampleText(id) {
    var v = exampleValues(id);
    return v ? textOf(v) : '';
  }

  var DEFAULTS = {
    mode: 'measured',
    example: 'centered',
    lsl: 9.9,
    usl: 10.1,
    target: 10.0,
    unit: 'mm',
    mean: 10.0,
    sd: 0.02
  };

  // ---------------------------------------------------------------- 导出

  var api = {
    VERSION: VERSION,
    MAX_SAMPLES: MAX_SAMPLES,
    MAX_ABS_VALUE: MAX_ABS_VALUE,
    CONSTANTS: { d2: D2, d3: D3, d4: D4, runLength: RULE_RUN_LENGTH, trendLength: RULE_TREND_LENGTH },
    DEFAULTS: DEFAULTS,
    EXAMPLES: EXAMPLES,
    RULES: RULES,
    exampleValues: exampleValues,
    exampleText: exampleText,
    validateSpec: validateSpec,
    parseMeasurements: parseMeasurements,
    summarize: summarize,
    computeLimits: computeLimits,
    detectViolations: detectViolations,
    capability: capability,
    normalFit: normalFit,
    normalTailBelow: normalTailBelow,
    normalTailAbove: normalTailAbove,
    histogram: histogram,
    buildBaseline: buildBaseline,
    chartSample: chartSample,
    computeMeasured: computeMeasured,
    computeTheoretical: computeTheoretical
  };

  global.SpcCalculation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
