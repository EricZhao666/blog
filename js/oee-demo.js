/**
 * Batch 9C-1C：OEE 工业生产效率与损失分析实验室 —— UI 模块（原生 SVG，无框架、无后端、无持久化）
 *
 * 职责：
 *   - renderPage()：纯字符串渲染页面骨架（可深链、可被路由直接 innerHTML）；
 *   - mount(root)：绑定参数输入 / 示例切换 / A-B 情景 / 假设投影，全部监听器挂在 root 内部节点上，
 *     路由切换销毁 DOM 即完成清理，不注册任何 window/document 级监听器；
 *   - getState(root)：只读数值快照，供测试做**数值**断言（不依赖图形是否绘制判断正确性）。
 *
 * 数学全部委托 js/oee-calculation.js（统一口径、显式单位换算、多穴理想单件周期、
 * 损失守恒、异常标记、A/B 对比与假设投影）。计算 O(1)，输入防抖 120ms。
 * 图形不是唯一信息表达：损失堆叠图始终伴随数值表；异常情景隐藏堆叠图并给出检查清单。
 * 演示参数仅当前会话有效，不写任何存储、不进学习统计/浏览历史。
 * 颜色全部走站点设计令牌（var(--color-*)），深浅主题自动适配。
 */
(function (global) {
  'use strict';

  var FIELDS = [
    { id: 'oeePlanned', key: 'plannedMin', min: 0, max: 100000, step: 1, int: false, label: '计划生产时间（分钟）' },
    { id: 'oeeDowntime', key: 'downtimeMin', min: 0, max: 100000, step: 1, int: false, label: '停机时间（分钟）' },
    { id: 'oeeIdealCycle', key: 'idealCycleSec', min: 0.01, max: 86400, step: 0.1, int: false, label: '理想机器周期（秒/周期）' },
    { id: 'oeeCavities', key: 'cavities', min: 1, max: 1024, step: 1, int: true, label: '每周期产出件数（穴数）' },
    { id: 'oeeTotal', key: 'totalCount', min: 0, max: 1000000000, step: 1, int: true, label: '总产量（件）' },
    { id: 'oeeGood', key: 'goodCount', min: 0, max: 1000000000, step: 1, int: true, label: '合格数量（件）' }
  ];
  var DEBOUNCE_MS = 120;
  var CW = 640, CH = 120, BX = 8, BW = 624, BY = 26, BH = 40;

  function OC() { return global.OeeCalculation; }

  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    return (Math.abs(v) < Math.pow(10, -d) / 2 ? 0 : v).toFixed(d);
  }

  function pct(v, d) {
    return v === null || v === undefined || !isFinite(v) ? '不适用' : fmt(v * 100, d === undefined ? 2 : d) + '%';
  }

  function signed(v, d, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '不适用';
    var s = fmt(Math.abs(v), d);
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + s + (unit || '');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cloneConfig(c) {
    var out = {};
    FIELDS.forEach(function (f) { out[f.key] = c[f.key]; });
    return out;
  }

  function defaults() { return cloneConfig(OC().DEFAULTS); }

  // ---------------------------------------------------------------- 页面骨架
  function fieldRow(f) {
    return '<label class="oee-input-label" for="' + f.id + '">' + f.label +
      '<input id="' + f.id + '" type="number" min="' + f.min + '" max="' + f.max + '" step="' + f.step +
      '" value="' + OC().DEFAULTS[f.key] + '" inputmode="' + (f.int ? 'numeric' : 'decimal') + '"></label>';
  }

  function renderPage() {
    var exOpts = OC().EXAMPLES.map(function (ex) {
      return '<option value="' + ex.id + '">' + esc(ex.name) + '</option>';
    }).join('') + '<option value="custom">自定义参数</option>';
    return '' +
      '<div class="oee-page" id="oeeDemoRoot">' +
      '<h1 class="page-title">OEE 工业生产效率与损失分析实验室</h1>' +
      '<p class="page-desc">设备综合效率 OEE = Availability × Performance × Quality，并把计划生产时间分解为' +
      '停机损失、性能损失、质量损失与有效生产时间（时间等效，守恒可验证）。计划生产时间已排除不计划生产的时间，' +
      '同一停机不重复扣减；产量统一按件数（非模次）。教学工具：不连接真实工厂数据。</p>' +
      '<div class="oee-layout">' +
      '<div class="oee-main">' +
      '<section class="oee-card" aria-labelledby="oeeOverviewTitle">' +
      '<h2 class="oee-card-title" id="oeeOverviewTitle">OEE 总览</h2>' +
      '<div class="oee-overview">' +
      '<div class="oee-big"><span class="oee-big-value" id="oeeValue">–</span><span class="oee-big-label">OEE</span></div>' +
      '<dl class="oee-apq">' +
      '<dt>Availability 时间开动率</dt><dd id="oeeA">–</dd>' +
      '<dt>Performance 性能开动率</dt><dd id="oeeP">–</dd>' +
      '<dt>Quality 良品率</dt><dd id="oeeQ">–</dd>' +
      '<dt>实际运行时间</dt><dd id="oeeRunTime">–</dd>' +
      '</dl>' +
      '</div>' +
      '<p class="oee-cross" id="oeeCross">–</p>' +
      '<p class="oee-status-line">状态：<span id="oeeStatus" class="oee-status">–</span></p>' +
      '</section>' +
      '<section class="oee-card" aria-labelledby="oeeCountTitle">' +
      '<h2 class="oee-card-title" id="oeeCountTitle">理论产能与实际产量</h2>' +
      '<dl class="oee-counts">' +
      '<dt>理论产能（计划时间口径）</dt><dd id="oeeTheoPlanned">–</dd>' +
      '<dt>理论产能（运行时间口径）</dt><dd id="oeeTheoRun">–</dd>' +
      '<dt>实际总产量</dt><dd id="oeeTotalOut">–</dd>' +
      '<dt>合格产量</dt><dd id="oeeGoodOut">–</dd>' +
      '<dt>不合格数量</dt><dd id="oeeRejectOut">–</dd>' +
      '<dt>理想单件周期</dt><dd id="oeeIdealPart">–</dd>' +
      '</dl>' +
      '</section>' +
      '<section class="oee-card" aria-labelledby="oeeLossTitle">' +
      '<h2 class="oee-card-title" id="oeeLossTitle">时间损失分解（分钟）</h2>' +
      '<svg id="oeeLossChart" class="oee-chart" viewBox="0 0 ' + CW + ' ' + CH + '" role="img" aria-label="时间损失堆叠图"></svg>' +
      '<div class="oee-legend" id="oeeLegend"></div>' +
      '<p class="oee-chart-note" id="oeeChartNote" hidden></p>' +
      '<table class="oee-loss-table"><caption class="oee-visually-hidden">时间损失分解数值（图形对应的数值表达）</caption>' +
      '<thead><tr><th scope="col">项目</th><th scope="col">分钟</th><th scope="col">占计划时间</th></tr></thead>' +
      '<tbody id="oeeLossBody"></tbody></table>' +
      '<p class="oee-hint" id="oeeConservation">–</p>' +
      '</section>' +
      '<section class="oee-card" aria-labelledby="oeeWarnTitle">' +
      '<h2 class="oee-card-title" id="oeeWarnTitle">数据口径与异常提示</h2>' +
      '<p class="oee-error" id="oeeError" aria-live="polite"></p>' +
      '<ul class="oee-warnings" id="oeeWarnings" aria-live="polite"></ul>' +
      '</section>' +
      '</div>' +
      '<aside class="oee-panel" aria-label="参数与情景面板">' +
      '<div class="oee-field">' +
      '<label class="oee-input-label" for="oeeExample">示例生产场景（教学示例，非真实公司数据）' +
      '<select id="oeeExample">' + exOpts + '</select></label>' +
      '<p class="oee-example-note" id="oeeExampleNote"></p>' +
      '</div>' +
      '<div class="oee-field">' +
      '<span class="oee-field-title">生产参数</span>' +
      FIELDS.map(fieldRow).join('') +
      '</div>' +
      '<div class="oee-field">' +
      '<span class="oee-field-title">改善情景 A/B（仅当前会话）</span>' +
      '<button type="button" id="oeeSaveA" class="oee-btn">保存当前为基准 A</button>' +
      '<p class="oee-a-state" id="oeeAState">未保存基准 A</p>' +
      '<div class="oee-compare-wrap" id="oeeCompareWrap" hidden>' +
      '<table class="oee-compare-table"><caption class="oee-visually-hidden">基准 A 与当前情景 B 的实际输入对比</caption>' +
      '<thead><tr><th scope="col">指标</th><th scope="col">基准 A</th><th scope="col">情景 B（当前）</th><th scope="col">变化</th></tr></thead>' +
      '<tbody id="oeeCompareBody"></tbody></table>' +
      '<p class="oee-hint" id="oeeCompareNote"></p>' +
      '</div>' +
      '<label class="oee-input-label" for="oeeProjDowntime">假设预测：停机减少到（分钟）' +
      '<input id="oeeProjDowntime" type="number" min="0" step="1" value="' + OC().DEFAULTS.downtimeMin + '" inputmode="decimal"></label>' +
      '<p class="oee-projection" id="oeeProjection">–</p>' +
      '</div>' +
      '<button type="button" id="oeeReset" class="oee-btn oee-reset">恢复默认参数</button>' +
      '<div class="oee-explain">' +
      '<p><strong>公式</strong>：Run = Planned − Downtime；A = Run/Planned；P = 理想单件周期×总件数/Run；' +
      'Q = 合格件数/总件数；OEE = A×P×Q。交叉验证：OEE = 理想单件周期×合格件数/Planned。</p>' +
      '<p><strong>多穴模具</strong>：理想单件周期 = 理想机器周期 ÷ 每周期件数（穴数只除一次）；产量按件数统计，不按模次。</p>' +
      '<p><strong>损失分解</strong>：停机损失 = Planned − Run；性能损失 = Run − 理想单件周期×总件数；' +
      '质量损失 = 理想单件周期×不合格件数；有效生产时间 = 理想单件周期×合格件数。四项之和恒等于计划生产时间。</p>' +
      '<p><strong>口径</strong>：分母为零显示「不适用」；Performance&gt;100% 不截断并提示核对理想周期/单位/穴数/统计窗口；' +
      'A/B 为实际输入对比，停机投影是假设预测（P、Q、理想周期不变），不是已验证收益。</p>' +
      '</div>' +
      '<span id="oeeLive" class="oee-visually-hidden" aria-live="polite"></span>' +
      '</aside>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 损失堆叠图
  var SEGS = [
    { key: 'downtimeSec', cls: 'oee-seg--downtime', chip: 'oee-chip--downtime', name: '停机损失' },
    { key: 'performanceSec', cls: 'oee-seg--performance', chip: 'oee-chip--performance', name: '性能损失' },
    { key: 'qualitySec', cls: 'oee-seg--quality', chip: 'oee-chip--quality', name: '质量损失' },
    { key: 'effectiveSec', cls: 'oee-seg--effective', chip: 'oee-chip--effective', name: '有效生产时间' }
  ];

  function renderLossChart(svg, note, legend, r) {
    if (!r.chartSafe) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      legend.innerHTML = '';
      note.hidden = false;
      note.textContent = r.flags.indexOf('inconsistent-data') !== -1
        ? '数据不一致（零运行时间却有产量）：不渲染损失堆叠图，请先核对数据。下方数值表仍按公式如实给出（含负值）。'
        : (r.flags.indexOf('performance-over-100') !== -1
          ? 'Performance 超过 100%，性能损失为负：不渲染误导性的非负堆叠图。请核对理想周期、单位、穴数与统计窗口。下方数值表如实给出符号。'
          : '计划生产时间为 0：损失分解不适用。');
      return;
    }
    svg.removeAttribute('hidden');
    note.hidden = true;
    note.textContent = '';
    var html = '';
    var x = BX;
    var aria = [];
    SEGS.forEach(function (s) {
      var v = Math.max(0, r.losses[s.key]);
      var w = r.plannedSec > 0 ? v / r.plannedSec * BW : 0;
      if (w > 0.25) {
        html += '<rect class="oee-seg ' + s.cls + '" x="' + x.toFixed(2) + '" y="' + BY + '" width="' + w.toFixed(2) + '" height="' + BH + '"></rect>';
        if (w > 86) {
          html += '<text class="oee-seg-label" x="' + (x + w / 2).toFixed(2) + '" y="' + (BY + BH / 2 + 4) + '" text-anchor="middle">' +
            s.name + ' ' + fmt(v / 60, 1) + '</text>';
        }
      }
      aria.push(s.name + ' ' + fmt(v / 60, 2) + ' 分钟');
      x += w;
    });
    html += '<text class="oee-axis-label" x="' + BX + '" y="' + (BY + BH + 22) + '">0</text>' +
      '<text class="oee-axis-label" x="' + (BX + BW) + '" y="' + (BY + BH + 22) + '" text-anchor="end">' + fmt(r.plannedSec / 60, 1) + ' 分钟（计划生产时间）</text>';
    svg.innerHTML = html;
    svg.setAttribute('aria-label', '时间损失堆叠图：' + aria.join('，'));
    legend.innerHTML = SEGS.map(function (s) {
      return '<span class="oee-legend-item"><span class="oee-chip ' + s.chip + '"></span>' + s.name + '</span>';
    }).join('');
  }

  // ---------------------------------------------------------------- 读数
  function flagMessage(f) {
    switch (f) {
      case 'zero-planned': return '计划生产时间为 0：Availability 与 OEE 的分母为零，显示「不适用」，不返回 NaN 或虚构 100%。';
      case 'zero-run-time': return '实际运行时间为 0（停机 = 计划时间）：Performance 分母为零，显示「不适用」。';
      case 'inconsistent-data': return '不一致数据：运行时间为 0 却存在生产数量。OEE 置为「不适用」，请核对产量与时间的统计窗口。';
      case 'no-output': return '计划时间有效但总产量为 0：OEE 按有效生产时间公式 = 0；Quality 分母为零显示「不适用」，各组成指标分别判断。';
      case 'performance-over-100': return 'Performance 超过 100%（如实保留，未截断）。请依次检查：① 理想周期是否错误；② 单位是否错误（秒/分钟混用）；③ 模具穴数是否重复计入；④ 产量与时间统计窗口是否一致。';
      default: return f;
    }
  }

  function renderReadout(root, state, r) {
    root.querySelector('#oeeValue').textContent = pct(r.oee);
    root.querySelector('#oeeA').textContent = pct(r.availability);
    root.querySelector('#oeeP').textContent = pct(r.performance);
    root.querySelector('#oeeQ').textContent = pct(r.quality);
    root.querySelector('#oeeRunTime').textContent = fmt(r.runSec / 60, 2) + ' 分钟';
    root.querySelector('#oeeCross').textContent = r.oeeTime === null
      ? '交叉验证（时间公式 OEE = 理想单件周期×合格件数/计划时间）：不适用'
      : '交叉验证：时间公式 OEE = ' + pct(r.oeeTime, 4) +
        (r.crossDelta !== null ? '，与乘积式偏差 ' + r.crossDelta.toExponential(2) : '（乘积式部分指标不适用，未交叉）');

    root.querySelector('#oeeTheoPlanned').textContent = r.theoreticalPlanned === null ? '不适用' : fmt(r.theoreticalPlanned, 1) + ' 件';
    root.querySelector('#oeeTheoRun').textContent = fmt(r.theoreticalRun, 1) + ' 件';
    root.querySelector('#oeeTotalOut').textContent = r.config.totalCount + ' 件';
    root.querySelector('#oeeGoodOut').textContent = r.config.goodCount + ' 件';
    root.querySelector('#oeeRejectOut').textContent = r.rejectCount + ' 件';
    root.querySelector('#oeeIdealPart').textContent = fmt(r.idealPartSec, 4) + ' 秒/件（= ' + r.config.idealCycleSec + ' 秒 ÷ ' + r.config.cavities + ' 件/周期）';

    // 损失数值表（始终存在：图形不是唯一信息表达）
    var rows = SEGS.map(function (s) {
      var v = r.losses[s.key] / 60;
      var share = r.plannedSec > 0 ? pct(r.losses[s.key] / r.plannedSec, 1) : '不适用';
      return '<tr><th scope="row">' + s.name + '</th><td>' + fmt(v, 2) + '</td><td>' + share + '</td></tr>';
    }).join('');
    root.querySelector('#oeeLossBody').innerHTML = rows;
    root.querySelector('#oeeConservation').textContent =
      '守恒验证：停机 + 性能 + 质量 + 有效 = ' + fmt((r.losses.downtimeSec + r.losses.performanceSec + r.losses.qualitySec + r.losses.effectiveSec) / 60, 2) +
      ' 分钟，计划 = ' + fmt(r.plannedSec / 60, 2) + ' 分钟，偏差 ' + r.conservationDelta.toExponential(2) + ' 秒（' + (r.conservationOk ? '通过' : '异常') + '）';

    // 状态徽章
    var badge = root.querySelector('#oeeStatus');
    var text, cls;
    if (r.flags.indexOf('inconsistent-data') !== -1) { text = '数据不一致'; cls = 'oee-status--err'; }
    else if (r.flags.indexOf('performance-over-100') !== -1) { text = '性能超 100%（口径异常）'; cls = 'oee-status--err'; }
    else if (r.flags.length) { text = '部分指标不适用'; cls = 'oee-status--warn'; }
    else { text = '口径正常'; cls = 'oee-status--ok'; }
    badge.textContent = text;
    badge.className = 'oee-status ' + cls;

    // 异常提示列表
    var warns = root.querySelector('#oeeWarnings');
    warns.innerHTML = r.flags.map(function (f) { return '<li>' + esc(flagMessage(f)) + '</li>'; }).join('');
  }

  function renderCompare(root, state) {
    var wrap = root.querySelector('#oeeCompareWrap');
    var aState = root.querySelector('#oeeAState');
    if (!state.baselineA) {
      wrap.hidden = true;
      aState.textContent = '未保存基准 A';
      return;
    }
    var cmp = OC().compareScenarios(state.baselineA.config, state.config);
    state.compare = cmp.ok ? cmp.deltas : null;
    if (!cmp.ok) {
      wrap.hidden = true;
      aState.textContent = '基准 A 已保存，但当前参数非法，无法对比';
      return;
    }
    wrap.hidden = false;
    aState.textContent = '已保存基准 A：OEE ' + pct(cmp.a.oee) + '（计划 ' + cmp.a.config.plannedMin + ' 分钟）';
    var a = cmp.a, b = cmp.b, d = cmp.deltas;
    function row(name, va, vb, delta) {
      return '<tr><th scope="row">' + name + '</th><td>' + va + '</td><td>' + vb + '</td><td>' + delta + '</td></tr>';
    }
    root.querySelector('#oeeCompareBody').innerHTML =
      row('OEE', pct(a.oee), pct(b.oee), signed(d.oeePP, 2, ' 百分点')) +
      row('Availability', pct(a.availability), pct(b.availability), signed(d.availabilityPP, 2, ' 百分点')) +
      row('停机损失', fmt(a.losses.downtimeSec / 60, 2), fmt(b.losses.downtimeSec / 60, 2), signed(d.downtimeLossDeltaMin, 2, ' 分钟')) +
      row('性能损失', fmt(a.losses.performanceSec / 60, 2), fmt(b.losses.performanceSec / 60, 2), signed(d.performanceLossDeltaMin, 2, ' 分钟')) +
      row('质量损失', fmt(a.losses.qualitySec / 60, 2), fmt(b.losses.qualitySec / 60, 2), signed(d.qualityLossDeltaMin, 2, ' 分钟')) +
      row('有效生产时间', fmt(a.losses.effectiveSec / 60, 2), fmt(b.losses.effectiveSec / 60, 2), signed(d.effectiveDeltaMin, 2, ' 分钟')) +
      row('合格产量', a.config.goodCount + ' 件', b.config.goodCount + ' 件', signed(d.goodDelta, 0, ' 件'));
    root.querySelector('#oeeCompareNote').textContent = d.samePlanned
      ? 'A/B 计划生产时间相同，以上为实际输入对比（非预测）。'
      : '注意：A/B 计划生产时间不同（差 ' + fmt(d.plannedDeltaMin, 2) + ' 分钟），合格产量变化包含计划时间因素。以上为实际输入对比（非预测）。';
  }

  function renderProjection(root, state) {
    var el = root.querySelector('#oeeProjDowntime');
    var out = root.querySelector('#oeeProjection');
    var v = Number(el.value);
    var proj = OC().projectDowntimeReduction(state.config, v);
    state.projection = proj.ok ? proj : { ok: false, error: proj.error };
    if (!proj.ok) {
      out.textContent = '假设预测不可用：' + proj.message;
      return;
    }
    out.textContent = proj.disclaimer + '。停机 ' + fmt(proj.base.downtimeMin, 2) + ' → ' + fmt(proj.projected.downtimeMin, 2) +
      ' 分钟：预计总产量 ' + fmt(proj.projected.totalCount, 1) + ' 件（' + signed(proj.deltaTotal, 1, ' 件') +
      '），合格 ' + fmt(proj.projected.goodCount, 1) + ' 件（' + signed(proj.deltaGood, 1, ' 件') +
      '），OEE ' + pct(proj.projected.oee) + '。理论估计值可为小数。';
  }

  function announce(root, state, r) {
    var live = root.querySelector('#oeeLive');
    if (!live) return;
    live.textContent = 'OEE ' + pct(r.oee) + '，时间开动率 ' + pct(r.availability) +
      '，性能开动率 ' + pct(r.performance) + '，良品率 ' + pct(r.quality) +
      (r.flags.length ? '。存在口径提示 ' + r.flags.length + ' 条' : '');
  }

  // ---------------------------------------------------------------- 计算与挂载
  function mount(root) {
    if (!root || !OC()) return null;
    var state = {
      config: defaults(),
      example: 'single',
      result: null,
      baselineA: null,
      compare: null,
      projection: null,
      computeCount: 0,
      invalid: []
    };
    var timer = 0;
    var destroyed = false;

    function refresh() {
      var r = state.result;
      renderLossChart(root.querySelector('#oeeLossChart'), root.querySelector('#oeeChartNote'), root.querySelector('#oeeLegend'), r);
      renderReadout(root, state, r);
      renderCompare(root, state);
      renderProjection(root, state);
    }

    function runCompute() {
      timer = 0;
      // 防御层：UI 校验之外再经数学模块校验
      var r = OC().compute(state.config);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      state.result = r;
      state.computeCount++;
      setError('');
      refresh();
      announce(root, state, r);
    }

    function scheduleCompute() {
      if (timer) return;
      timer = global.setTimeout(runCompute, DEBOUNCE_MS);
    }

    function setError(msg) {
      root.querySelector('#oeeError').textContent = msg || '';
    }

    function markInvalid(keys) {
      FIELDS.forEach(function (f) {
        root.querySelector('#' + f.id).setAttribute('aria-invalid', keys.indexOf(f.key) !== -1 ? 'true' : 'false');
      });
      state.invalid = keys.slice();
    }

    function fieldError(f, v) {
      if (!isFinite(v) || v < f.min || v > f.max) return f.label + ' 需为 ' + f.min + '–' + f.max + ' 的数字';
      if (f.int && Math.floor(v) !== v) return f.label + ' 需为整数（件数/穴数不为小数）';
      return null;
    }

    function crossError(next) {
      if (next.downtimeMin > next.plannedMin) return '停机时间不能超过计划生产时间';
      if (next.goodCount > next.totalCount) return '合格数量不能超过总产量';
      return null;
    }

    /** 读取并校验全部输入；非法时保持上一组有效参数。 */
    function readInputs(restoreOnBad) {
      var bad = [];
      var next = cloneConfig(state.config);
      FIELDS.forEach(function (f) {
        var el = root.querySelector('#' + f.id);
        var v = Number(el.value);
        if (el.value.trim() === '' || fieldError(f, v)) {
          bad.push(f.key);
          if (restoreOnBad) el.value = String(state.config[f.key]);
        } else {
          next[f.key] = v;
        }
      });
      var cross = crossError(next);
      if (cross && bad.length === 0) {
        bad.push('downtimeMin', 'goodCount');
        if (restoreOnBad) {
          root.querySelector('#oeeDowntime').value = String(state.config.downtimeMin);
          root.querySelector('#oeeGood').value = String(state.config.goodCount);
        }
      }
      if (bad.length) {
        setError(cross && bad.indexOf('downtimeMin') !== -1 ? cross + '，已保持上一组有效参数' : '输入非法（范围/整数/交叉约束），已保持上一组有效参数');
        markInvalid(bad);
        return null;
      }
      setError('');
      markInvalid([]);
      return next;
    }

    function onParamInput(f) {
      var el = root.querySelector('#' + f.id);
      var v = Number(el.value);
      var err = el.value.trim() === '' ? f.label + ' 不能为空' : fieldError(f, v);
      var next = cloneConfig(state.config);
      if (!err) {
        next[f.key] = v;
        err = crossError(next);
      }
      if (err) {
        // 输入中途可能非法：只提示，不重算、不改状态
        setError(err + '（已保持上一组有效参数）');
        el.setAttribute('aria-invalid', 'true');
        state.invalid = [f.key];
        return;
      }
      state.config[f.key] = v;
      state.example = 'custom';
      root.querySelector('#oeeExample').value = 'custom';
      setError('');
      markInvalid([]);
      scheduleCompute();
    }

    function onParamChange() {
      var next = readInputs(true);
      if (!next) return;
      state.config = next;
      runCompute();
    }

    function loadExample(id) {
      var ex = OC().EXAMPLES.filter(function (e) { return e.id === id; })[0];
      if (!ex) return;
      state.config = cloneConfig(ex.config);
      state.example = id;
      FIELDS.forEach(function (f) { root.querySelector('#' + f.id).value = String(ex.config[f.key]); });
      root.querySelector('#oeeExample').value = id;
      root.querySelector('#oeeExampleNote').textContent = ex.note;
      root.querySelector('#oeeProjDowntime').value = String(ex.config.downtimeMin);
      setError('');
      markInvalid([]);
      runCompute();
    }

    function onExampleChange() {
      var id = root.querySelector('#oeeExample').value;
      if (id === 'custom') {
        root.querySelector('#oeeExampleNote').textContent = '自定义参数：当前输入即情景参数。';
        return;
      }
      loadExample(id);
    }

    function onSaveA() {
      state.baselineA = { config: cloneConfig(state.config), oee: state.result ? state.result.oee : null };
      renderCompare(root, state);
      var live = root.querySelector('#oeeLive');
      if (live) live.textContent = '已保存基准 A：OEE ' + pct(state.baselineA.oee);
    }

    function onProjectionInput() {
      renderProjection(root, state);
    }

    function onReset() {
      state.config = defaults();
      state.example = 'single';
      state.baselineA = null;
      state.compare = null;
      FIELDS.forEach(function (f) { root.querySelector('#' + f.id).value = String(OC().DEFAULTS[f.key]); });
      root.querySelector('#oeeExample').value = 'single';
      root.querySelector('#oeeExampleNote').textContent = OC().EXAMPLES[0].note;
      root.querySelector('#oeeProjDowntime').value = String(OC().DEFAULTS.downtimeMin);
      setError('');
      markInvalid([]);
      runCompute();
    }

    var listeners = [];
    FIELDS.forEach(function (f) {
      var el = root.querySelector('#' + f.id);
      listeners.push([el, 'input', function () { onParamInput(f); }]);
      listeners.push([el, 'change', onParamChange]);
    });
    listeners.push([root.querySelector('#oeeExample'), 'change', onExampleChange]);
    listeners.push([root.querySelector('#oeeSaveA'), 'click', onSaveA]);
    listeners.push([root.querySelector('#oeeProjDowntime'), 'input', onProjectionInput]);
    listeners.push([root.querySelector('#oeeProjDowntime'), 'change', onProjectionInput]);
    listeners.push([root.querySelector('#oeeReset'), 'click', onReset]);
    listeners.forEach(function (l) { l[0].addEventListener(l[1], l[2]); });

    root.querySelector('#oeeExampleNote').textContent = OC().EXAMPLES[0].note;
    runCompute();

    var handle = {
      getState: function () { return snapshot(state); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        if (timer) global.clearTimeout(timer);
      }
    };
    root.__oeeHandle = handle;
    return handle;
  }

  function snapshot(state) {
    var r = state.result || {};
    return {
      config: cloneConfig(state.config),
      example: state.example,
      computeCount: state.computeCount,
      invalid: state.invalid.slice(),
      availability: r.availability,
      performance: r.performance,
      quality: r.quality,
      oee: r.oee,
      oeeProduct: r.oeeProduct,
      oeeTime: r.oeeTime,
      crossDelta: r.crossDelta,
      runMin: r.runSec !== undefined ? r.runSec / 60 : null,
      idealPartSec: r.idealPartSec,
      theoreticalPlanned: r.theoreticalPlanned,
      theoreticalRun: r.theoreticalRun,
      rejectCount: r.rejectCount,
      lossesMin: r.losses ? {
        downtime: r.losses.downtimeSec / 60,
        performance: r.losses.performanceSec / 60,
        quality: r.losses.qualitySec / 60,
        effective: r.losses.effectiveSec / 60
      } : null,
      conservationDelta: r.conservationDelta,
      conservationOk: r.conservationOk,
      flags: r.flags ? r.flags.slice() : [],
      chartSafe: r.chartSafe,
      baselineA: state.baselineA ? { config: cloneConfig(state.baselineA.config), oee: state.baselineA.oee } : null,
      compare: state.compare,
      projection: state.projection
    };
  }

  function getState(root) {
    return root && root.__oeeHandle ? root.__oeeHandle.getState() : null;
  }

  var api = {
    VERSION: 1,
    DEBOUNCE_MS: DEBOUNCE_MS,
    FIELDS: FIELDS,
    renderPage: renderPage,
    mount: mount,
    getState: getState
  };

  global.OeeDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);