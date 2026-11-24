/**
 * Batch 9C-1B：PID 控制系统交互实验室 —— UI 模块（原生 SVG，无框架、无后端、无持久化）
 *
 * 职责：
 *   - renderPage()：纯字符串渲染页面骨架（可深链、可被路由直接 innerHTML）；
 *   - mount(root)：绑定参数输入 / 模式切换 / 抗饱和开关，全部监听器挂在 root 内部节点上，
 *     路由切换销毁 DOM 即完成清理，不注册任何 window/document 级监听器；
 *   - getState(root)：只读数值快照，供测试做**数值**断言（不依赖曲线是否绘制判断正确性）。
 *
 * 数学全部委托 js/pid-simulation.js（ZOH 精确对象离散 + 可解释离散 PID + 条件积分抗饱和）。
 * 计算有界：输入防抖 120ms；单次仿真步数受 MAX_STEPS 限制；绘图按 ≤800 点抽稀（指标用全量数据）。
 * 每次重算都是 t=0、I=0、D=0 的全新仿真；切换模式不携带上一模式状态。
 * 颜色全部走站点设计令牌（var(--color-*)），深浅主题自动适配。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    kp: 1.2, ki: 0.8, kd: 0.15,
    setpoint: 1, plantK: 1, tau: 1,
    dt: 0.02, duration: 12,
    uMin: -2, uMax: 2,
    mode: 'PID', antiWindup: true
  };
  var FIELDS = [
    { id: 'pidKp', key: 'kp', min: 0, max: 20, range: 'pidKpRange', label: 'Kp' },
    { id: 'pidKi', key: 'ki', min: 0, max: 20, range: 'pidKiRange', label: 'Ki' },
    { id: 'pidKd', key: 'kd', min: 0, max: 10, range: 'pidKdRange', label: 'Kd' },
    { id: 'pidSetpoint', key: 'setpoint', min: -5, max: 5, label: '设定值' },
    { id: 'pidPlantK', key: 'plantK', min: 0.1, max: 10, label: 'K' },
    { id: 'pidTau', key: 'tau', min: 0.1, max: 10, label: 'τ' },
    { id: 'pidUMin', key: 'uMin', min: -10, max: 10, label: 'uMin' },
    { id: 'pidUMax', key: 'uMax', min: -10, max: 10, label: 'uMax' }
  ];
  var DT_OPTIONS = [0.005, 0.01, 0.02, 0.05, 0.1];
  var DURATION_OPTIONS = [6, 12, 20, 30];
  var MAX_DISPLAY_POINTS = 800;
  var DEBOUNCE_MS = 120;
  var MODE_LABELS = { P: 'P', PI: 'PI', PID: 'PID' };

  var YW = 640, YH = 300, UW = 640, UH = 220;
  var ML = 48, MR = 14, MT = 16, MB = 30;

  function PS() { return global.PidSimulation; }

  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    return (Math.abs(v) < Math.pow(10, -d) / 2 ? 0 : v).toFixed(d);
  }

  function fmtSmall(v) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (v === 0) return '0';
    return Math.abs(v) < 1e-4 ? v.toExponential(2) : v.toFixed(4);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cloneConfig(c) {
    var out = {};
    for (var k in DEFAULTS) out[k] = c[k];
    return out;
  }

  // ---------------------------------------------------------------- 页面骨架
  function gainRow(f) {
    return '' +
      '<div class="pid-gain-row">' +
      '<label class="pid-input-label" for="' + f.id + '">' + f.label +
      '<input id="' + f.id + '" type="number" min="' + f.min + '" max="' + f.max + '" step="0.05" value="' + DEFAULTS[f.key] + '" inputmode="decimal"></label>' +
      '<input id="' + f.range + '" class="pid-range" type="range" min="' + f.min + '" max="' + f.max + '" step="0.05" value="' + DEFAULTS[f.key] + '" aria-label="' + f.label + ' 滑杆（' + f.min + '–' + f.max + '）">' +
      '</div>';
  }

  function renderPage() {
    var dtOpts = DT_OPTIONS.map(function (v) {
      return '<option value="' + v + '"' + (v === DEFAULTS.dt ? ' selected' : '') + '>' + v + ' s</option>';
    }).join('');
    var durOpts = DURATION_OPTIONS.map(function (v) {
      return '<option value="' + v + '"' + (v === DEFAULTS.duration ? ' selected' : '') + '>' + v + ' s</option>';
    }).join('');
    return '' +
      '<div class="pid-page" id="pidDemoRoot">' +
      '<h1 class="page-title">PID 控制系统交互实验室</h1>' +
      '<p class="page-desc">一阶被控对象 G(s) = K/(τs+1) 的离散 PID 阶跃响应。微分项对测量值求导并低通滤波（避免设定值突变的微分冲击），' +
      '输出限幅 + 条件积分抗饱和。时间单位：秒；其余为一致单位。每次重算从零状态开始，不承诺 PID 一定优于 PI。</p>' +
      '<div class="pid-layout">' +
      '<div class="pid-charts-card">' +
      '<h2 class="pid-chart-title">输出 y(t) 与设定值</h2>' +
      '<svg id="pidChartY" class="pid-chart" viewBox="0 0 ' + YW + ' ' + YH + '" role="img" aria-label="输出响应曲线"></svg>' +
      '<div class="pid-legend" id="pidLegendY"></div>' +
      '<h2 class="pid-chart-title">控制量 u(t) 与限幅</h2>' +
      '<svg id="pidChartU" class="pid-chart" viewBox="0 0 ' + UW + ' ' + UH + '" role="img" aria-label="控制量曲线"></svg>' +
      '<div class="pid-legend" id="pidLegendU"></div>' +
      '<p class="pid-hint">阴影带 = 设定值 ±2% 稳定带；u(t) 图红色竖带 = 输出饱和区间。曲线显示抽稀至 ≤' + MAX_DISPLAY_POINTS + ' 点，指标按全量采样计算。</p>' +
      '</div>' +
      '<aside class="pid-panel" aria-label="控制面板">' +
      '<div class="pid-field">' +
      '<span class="pid-field-title" id="pidModeLabel">控制器模式</span>' +
      '<div class="pid-modes" role="group" aria-labelledby="pidModeLabel">' +
      '<button type="button" id="pidModeP" aria-pressed="false">P</button>' +
      '<button type="button" id="pidModePI" aria-pressed="false">PI</button>' +
      '<button type="button" id="pidModePID" aria-pressed="true">PID</button>' +
      '<button type="button" id="pidModeCompare" aria-pressed="false">对比</button>' +
      '</div>' +
      '</div>' +
      '<div class="pid-field">' +
      '<span class="pid-field-title">PID 参数</span>' +
      gainRow(FIELDS[0]) + gainRow(FIELDS[1]) + gainRow(FIELDS[2]) +
      '</div>' +
      '<div class="pid-field">' +
      '<span class="pid-field-title">设定值与被控对象</span>' +
      '<div class="pid-field-row3">' +
      '<label class="pid-input-label">r<input id="pidSetpoint" type="number" min="-5" max="5" step="0.1" value="' + DEFAULTS.setpoint + '" inputmode="decimal"></label>' +
      '<label class="pid-input-label">K<input id="pidPlantK" type="number" min="0.1" max="10" step="0.1" value="' + DEFAULTS.plantK + '" inputmode="decimal"></label>' +
      '<label class="pid-input-label">τ<input id="pidTau" type="number" min="0.1" max="10" step="0.1" value="' + DEFAULTS.tau + '" inputmode="decimal"></label>' +
      '</div>' +
      '</div>' +
      '<div class="pid-field">' +
      '<span class="pid-field-title">控制限幅与仿真</span>' +
      '<div class="pid-field-row">' +
      '<label class="pid-input-label">uMin<input id="pidUMin" type="number" min="-10" max="10" step="0.1" value="' + DEFAULTS.uMin + '" inputmode="decimal"></label>' +
      '<label class="pid-input-label">uMax<input id="pidUMax" type="number" min="-10" max="10" step="0.1" value="' + DEFAULTS.uMax + '" inputmode="decimal"></label>' +
      '</div>' +
      '<div class="pid-field-row">' +
      '<label class="pid-input-label">dt<select id="pidDt">' + dtOpts + '</select></label>' +
      '<label class="pid-input-label">时长<select id="pidDuration">' + durOpts + '</select></label>' +
      '</div>' +
      '<label class="pid-check"><input id="pidAntiWindup" type="checkbox" checked>积分抗饱和（限幅时冻结积分）</label>' +
      '</div>' +
      '<p class="pid-error" id="pidError" aria-live="polite"></p>' +
      '<dl class="pid-readout" aria-label="时域指标">' +
      '<dt>上升时间</dt><dd id="pidRise">–</dd>' +
      '<dt>超调量</dt><dd id="pidOvershoot">–</dd>' +
      '<dt>调节时间</dt><dd id="pidSettling">–</dd>' +
      '<dt>稳态误差</dt><dd id="pidEss">–</dd>' +
      '<dt>控制量范围</dt><dd id="pidURange">–</dd>' +
      '<dt>饱和步数</dt><dd id="pidSatCount">–</dd>' +
      '<dt>状态</dt><dd><span id="pidStatus" class="pid-status">–</span></dd>' +
      '</dl>' +
      '<div class="pid-compare-wrap" id="pidCompareWrap" hidden>' +
      '<table class="pid-compare-table"><caption class="pid-visually-hidden">P / PI / PID 指标对比</caption>' +
      '<thead><tr><th scope="col">模式</th><th scope="col">上升时间</th><th scope="col">超调量</th><th scope="col">调节时间</th><th scope="col">稳态误差</th></tr></thead>' +
      '<tbody id="pidCompareBody"></tbody></table>' +
      '</div>' +
      '<button type="button" id="pidReset" class="pid-reset">恢复默认</button>' +
      '<div class="pid-explain">' +
      '<p><strong>Kp</strong> 比例：增大加快响应，但可能超调甚至振荡；仅 P 控制对阶跃存在稳态误差 r/(1+K·Kp)。</p>' +
      '<p><strong>Ki</strong> 积分：闭环稳定且未饱和时消除阶跃稳态误差；过大引起超调与振荡，饱和时可能积分饱和（windup）。</p>' +
      '<p><strong>Kd</strong> 微分：对测量值求导并低通滤波，抑制输出快速变化（减缓上升）。一阶对象的超调主要由积分引起，Kd 不保证减小超调（参数不当时反而增大），不保证优于 PI；对采样噪声敏感。</p>' +
      '<p><strong>抗饱和</strong>：输出限幅且误差继续推向饱和时冻结积分，减轻 windup 造成的过大超调。</p>' +
      '</div>' +
      '<span id="pidLive" class="pid-visually-hidden" aria-live="polite"></span>' +
      '</aside>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 绘图
  function seriesList(state) {
    if (state.compare) {
      return ['P', 'PI', 'PID'].map(function (m) {
        return { mode: m, sim: state.compare[m] };
      });
    }
    return [{ mode: state.config.mode, sim: state.single }];
  }

  function decimate(arr, stride) {
    var out = [];
    for (var i = 0; i < arr.length; i += stride) out.push(arr[i]);
    if ((arr.length - 1) % stride !== 0) out.push(arr[arr.length - 1]);
    return out;
  }

  function rangeOf(vals, padFrac) {
    var lo = Infinity, hi = -Infinity;
    vals.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    var pad = (hi - lo) * (padFrac || 0.08);
    return { lo: lo - pad, hi: hi + pad };
  }

  function polyline(sim, key, xOf, yOf, cls) {
    var len = sim.t.length;
    var stride = Math.max(1, Math.ceil(len / MAX_DISPLAY_POINTS));
    var ts = decimate(sim.t, stride);
    var vs = decimate(sim[key], stride);
    var pts = [];
    for (var i = 0; i < ts.length; i++) {
      pts.push(xOf(ts[i]).toFixed(2) + ',' + yOf(vs[i]).toFixed(2));
    }
    return '<polyline class="pid-curve ' + cls + '" points="' + pts.join(' ') + '"></polyline>';
  }

  function gridAndAxes(W, H, rng, duration, unitLabel) {
    var plotW = W - ML - MR, plotH = H - MT - MB;
    var html = '';
    for (var i = 0; i <= 4; i++) {
      var v = rng.lo + (rng.hi - rng.lo) * i / 4;
      var y = MT + plotH * (1 - i / 4);
      html += '<line class="pid-grid" x1="' + ML + '" y1="' + y.toFixed(2) + '" x2="' + (W - MR) + '" y2="' + y.toFixed(2) + '"></line>';
      html += '<text class="pid-tick" x="' + (ML - 6) + '" y="' + (y + 4).toFixed(2) + '" text-anchor="end">' + fmt(v, 2) + '</text>';
    }
    [0, duration / 2, duration].forEach(function (tv) {
      var x = ML + tv / duration * plotW;
      html += '<text class="pid-tick" x="' + x.toFixed(2) + '" y="' + (H - 8) + '" text-anchor="middle">' + fmt(tv, 1) + '</text>';
    });
    html += '<text class="pid-axis-label" x="' + (W - MR) + '" y="' + (H - 8) + '" text-anchor="end">t/s</text>';
    html += '<text class="pid-axis-label" x="' + ML + '" y="' + (MT - 4) + '">' + esc(unitLabel) + '</text>';
    return html;
  }

  function renderChartY(svg, state) {
    var list = seriesList(state);
    var c = state.config;
    var band = PS().SETTLE_BAND * Math.max(Math.abs(c.setpoint), 1e-12);
    var vals = [c.setpoint - band, c.setpoint + band];
    list.forEach(function (s) {
      vals.push(Math.min.apply(null, s.sim.y), Math.max.apply(null, s.sim.y));
    });
    var rng = rangeOf(vals);
    var plotW = YW - ML - MR, plotH = YH - MT - MB;
    function xOf(t) { return ML + t / c.duration * plotW; }
    function yOf(v) { return MT + (rng.hi - v) / (rng.hi - rng.lo) * plotH; }

    var html = gridAndAxes(YW, YH, rng, c.duration, 'y');
    var bandTop = yOf(c.setpoint + band), bandBot = yOf(c.setpoint - band);
    html += '<rect class="pid-band" x="' + ML + '" y="' + bandTop.toFixed(2) + '" width="' + plotW + '" height="' + Math.max(0, bandBot - bandTop).toFixed(2) + '"></rect>';
    html += '<line class="pid-setpoint" x1="' + ML + '" y1="' + yOf(c.setpoint).toFixed(2) + '" x2="' + (YW - MR) + '" y2="' + yOf(c.setpoint).toFixed(2) + '"></line>';
    list.forEach(function (s) {
      html += polyline(s.sim, 'y', xOf, yOf, 'pid-curve--' + s.mode.toLowerCase());
    });
    svg.innerHTML = html;
    svg.setAttribute('aria-label', '输出响应曲线：设定值 ' + fmt(c.setpoint, 2) + '，末值 ' + fmt(list[list.length - 1].sim.y[list[list.length - 1].sim.y.length - 1], 3));
    svg.setAttribute('data-ymin', String(rng.lo));
    svg.setAttribute('data-ymax', String(rng.hi));
  }

  function renderChartU(svg, state) {
    var list = seriesList(state);
    var c = state.config;
    var vals = [c.uMin, c.uMax];
    list.forEach(function (s) {
      vals.push(s.sim.stats.minU, s.sim.stats.maxU);
    });
    var rng = rangeOf(vals);
    var plotW = UW - ML - MR, plotH = UH - MT - MB;
    function xOf(t) { return ML + t / c.duration * plotW; }
    function yOf(v) { return MT + (rng.hi - v) / (rng.hi - rng.lo) * plotH; }

    var html = gridAndAxes(UW, UH, rng, c.duration, 'u');

    // 饱和区间竖带：合并连续饱和采样；过多时按 150 个时间桶聚合，保证 DOM 有界
    var satSim = list[list.length - 1].sim;
    var runs = [];
    var start = -1;
    for (var k = 0; k < satSim.sat.length; k++) {
      if (satSim.sat[k] && start === -1) start = k;
      if ((!satSim.sat[k] || k === satSim.sat.length - 1) && start !== -1) {
        var end = satSim.sat[k] ? k : k - 1;
        runs.push([start, end]);
        start = -1;
      }
    }
    if (runs.length > 150) {
      var buckets = [];
      for (var b = 0; b < 150; b++) buckets.push(false);
      runs.forEach(function (r) {
        var b0 = Math.floor(r[0] / satSim.sat.length * 150);
        var b1 = Math.floor(r[1] / satSim.sat.length * 150);
        for (var bb = b0; bb <= b1 && bb < 150; bb++) buckets[bb] = true;
      });
      runs = [];
      var bs = -1;
      for (var q = 0; q < 150; q++) {
        if (buckets[q] && bs === -1) bs = q;
        if ((!buckets[q] || q === 149) && bs !== -1) {
          runs.push([Math.floor(bs / 150 * satSim.sat.length), Math.floor((buckets[q] ? q + 1 : q) / 150 * satSim.sat.length) - 1]);
          bs = -1;
        }
      }
    }
    runs.forEach(function (r) {
      var x0 = xOf(satSim.t[r[0]]);
      var x1 = xOf(Math.min(c.duration, satSim.t[r[1]] + c.dt));
      html += '<rect class="pid-sat-band" x="' + x0.toFixed(2) + '" y="' + MT + '" width="' + Math.max(0.5, x1 - x0).toFixed(2) + '" height="' + plotH + '"></rect>';
    });

    html += '<line class="pid-limit" x1="' + ML + '" y1="' + yOf(c.uMax).toFixed(2) + '" x2="' + (UW - MR) + '" y2="' + yOf(c.uMax).toFixed(2) + '"></line>';
    html += '<line class="pid-limit" x1="' + ML + '" y1="' + yOf(c.uMin).toFixed(2) + '" x2="' + (UW - MR) + '" y2="' + yOf(c.uMin).toFixed(2) + '"></line>';
    list.forEach(function (s) {
      html += polyline(s.sim, 'u', xOf, yOf, 'pid-curve--' + s.mode.toLowerCase());
    });
    svg.innerHTML = html;
    svg.setAttribute('aria-label', '控制量曲线：限幅 ' + fmt(c.uMin, 2) + ' 到 ' + fmt(c.uMax, 2) + '，饱和 ' + satSim.stats.satCount + ' 步');
    svg.setAttribute('data-umin', String(rng.lo));
    svg.setAttribute('data-umax', String(rng.hi));
  }

  function renderLegends(root, state) {
    var list = seriesList(state);
    var yHtml = list.map(function (s) {
      return '<span class="pid-legend-item"><span class="pid-chip pid-chip--' + s.mode.toLowerCase() + '"></span>' + MODE_LABELS[s.mode] + ' 输出</span>';
    }).join('');
    yHtml += '<span class="pid-legend-item"><span class="pid-chip pid-chip--setpoint"></span>设定值 ±2% 带</span>';
    root.querySelector('#pidLegendY').innerHTML = yHtml;
    var uHtml = list.map(function (s) {
      return '<span class="pid-legend-item"><span class="pid-chip pid-chip--' + s.mode.toLowerCase() + '"></span>' + MODE_LABELS[s.mode] + ' 控制量</span>';
    }).join('');
    uHtml += '<span class="pid-legend-item"><span class="pid-chip pid-chip--limit"></span>限幅</span>' +
      '<span class="pid-legend-item"><span class="pid-chip pid-chip--sat"></span>饱和区间</span>';
    root.querySelector('#pidLegendU').innerHTML = uHtml;
  }

  // ---------------------------------------------------------------- 读数
  function metricCells(m) {
    return {
      rise: m.rise === null ? '–' : fmt(m.rise, 3) + ' s',
      overshoot: m.overshoot === null ? '–' : fmt(m.overshoot, 2) + ' %',
      settling: m.settled ? fmt(m.settling, 3) + ' s' : '未在仿真时间内稳定',
      ess: fmtSmall(m.ess)
    };
  }

  function renderReadout(root, state) {
    var primary = state.compare ? state.compare.PID : state.single;
    var m = primary.metrics;
    var cells = metricCells(m);
    root.querySelector('#pidRise').textContent = cells.rise;
    root.querySelector('#pidOvershoot').textContent = cells.overshoot;
    root.querySelector('#pidSettling').textContent = cells.settling;
    root.querySelector('#pidEss').textContent = cells.ess;
    root.querySelector('#pidURange').textContent = fmt(primary.stats.minU, 3) + ' … ' + fmt(primary.stats.maxU, 3);
    root.querySelector('#pidSatCount').textContent = primary.stats.satCount + ' 步';

    var badge = root.querySelector('#pidStatus');
    var text, cls;
    if (primary.diverged) { text = '发散（已截断）'; cls = 'pid-status--err'; }
    else {
      text = m.settled ? '已稳定' : '未在仿真时间内稳定';
      if (primary.stats.satCount > 0) text += ' · 输出饱和';
      cls = (!m.settled || primary.stats.satCount > 0) ? 'pid-status--warn' : 'pid-status--ok';
    }
    badge.textContent = text;
    badge.className = 'pid-status ' + cls;

    var wrap = root.querySelector('#pidCompareWrap');
    if (state.compare) {
      wrap.hidden = false;
      var rows = ['P', 'PI', 'PID'].map(function (mo) {
        var cm = metricCells(state.compare[mo].metrics);
        return '<tr><th scope="row">' + mo + '</th><td>' + cm.rise + '</td><td>' + cm.overshoot + '</td><td>' + cm.settling + '</td><td>' + cm.ess + '</td></tr>';
      }).join('');
      root.querySelector('#pidCompareBody').innerHTML = rows;
    } else {
      wrap.hidden = true;
    }
  }

  function announce(root, state) {
    var live = root.querySelector('#pidLive');
    if (!live) return;
    var primary = state.compare ? state.compare.PID : state.single;
    var m = primary.metrics;
    var cells = metricCells(m);
    live.textContent = (state.compare ? '对比模式（表中为 PID 行）；' : '') +
      '上升时间 ' + cells.rise + '，超调量 ' + cells.overshoot + '，调节时间 ' + cells.settling + '，稳态误差 ' + cells.ess;
  }

  // ---------------------------------------------------------------- 计算与挂载
  function compute(state) {
    var ps = PS();
    if (state.config.mode === 'compare') {
      state.compare = {};
      ['P', 'PI', 'PID'].forEach(function (mo) {
        var cfg = cloneConfig(state.config);
        cfg.mode = mo;
        state.compare[mo] = ps.simulate(cfg);
      });
      state.single = null;
    } else {
      state.single = ps.simulate(state.config);
      state.compare = null;
    }
    state.computeCount++;
  }

  function mount(root) {
    if (!root || !PS()) return null;
    var state = {
      config: cloneConfig(DEFAULTS),
      single: null,
      compare: null,
      computeCount: 0,
      invalid: []
    };
    var timer = 0;
    var destroyed = false;
    var chartY = root.querySelector('#pidChartY');
    var chartU = root.querySelector('#pidChartU');

    function refresh() {
      renderChartY(chartY, state);
      renderChartU(chartU, state);
      renderLegends(root, state);
      renderReadout(root, state);
    }

    function runCompute() {
      timer = 0;
      // 防御层：UI 校验之外再经数学模块校验，非法配置不产生曲线
      var v = PS().validateConfig(state.config.mode === 'compare'
        ? Object.assign({}, state.config, { mode: 'PID' }) : state.config);
      if (!v.ok) {
        setError(v.message);
        return;
      }
      compute(state);
      refresh();
      announce(root, state);
    }

    function scheduleCompute() {
      if (timer) return;
      timer = global.setTimeout(runCompute, DEBOUNCE_MS);
    }

    function setError(msg) {
      root.querySelector('#pidError').textContent = msg || '';
    }

    function markInvalid(keys) {
      FIELDS.forEach(function (f) {
        var el = root.querySelector('#' + f.id);
        el.setAttribute('aria-invalid', keys.indexOf(f.key) !== -1 ? 'true' : 'false');
      });
      state.invalid = keys.slice();
    }

    /** 读取并校验全部输入；非法时保持上一组有效参数。 */
    function readInputs(restoreOnBad) {
      var bad = [];
      var next = cloneConfig(state.config);
      FIELDS.forEach(function (f) {
        var el = root.querySelector('#' + f.id);
        var v = Number(el.value);
        if (el.value.trim() === '' || !isFinite(v) || v < f.min || v > f.max) {
          bad.push(f.key);
          if (restoreOnBad) el.value = String(state.config[f.key]);
        } else {
          next[f.key] = v;
        }
      });
      if (bad.indexOf('uMin') === -1 && bad.indexOf('uMax') === -1 && next.uMin >= next.uMax) {
        bad.push('uMin', 'uMax');
        if (restoreOnBad) {
          root.querySelector('#pidUMin').value = String(state.config.uMin);
          root.querySelector('#pidUMax').value = String(state.config.uMax);
        }
      }
      if (bad.length) {
        var names = bad.map(function (k) {
          var f = FIELDS.filter(function (x) { return x.key === k; })[0];
          return f ? f.label : k;
        });
        setError(names.join(' / ') + ' 非法（需在各自范围内且 uMin < uMax），已保持上一组有效参数');
        markInvalid(bad);
        return null;
      }
      setError('');
      markInvalid([]);
      next.dt = Number(root.querySelector('#pidDt').value);
      next.duration = Number(root.querySelector('#pidDuration').value);
      next.antiWindup = root.querySelector('#pidAntiWindup').checked;
      return next;
    }

    function syncPair(f, value) {
      var num = root.querySelector('#' + f.id);
      var rng = root.querySelector('#' + f.range);
      var active = root.ownerDocument ? root.ownerDocument.activeElement : null;
      if (num !== active) num.value = String(value);
      if (rng && rng !== active) rng.value = String(value);
    }

    function onParamInput(f, fromRange) {
      var el = root.querySelector('#' + (fromRange ? f.range : f.id));
      var v = Number(el.value);
      var crossBad = (f.key === 'uMin' && v >= state.config.uMax) ||
        (f.key === 'uMax' && v <= state.config.uMin);
      if (el.value.trim() === '' || !isFinite(v) || v < f.min || v > f.max || crossBad) {
        // 输入中途可能非法（含 uMin<uMax 交叉约束）：只提示，不重算、不改状态
        setError(crossBad
          ? '需保持 uMin < uMax，已保持上一组有效参数'
          : f.label + ' 需为 ' + f.min + '–' + f.max + ' 之间的数字');
        root.querySelector('#' + f.id).setAttribute('aria-invalid', 'true');
        state.invalid = [f.key];
        return;
      }
      state.config[f.key] = v;
      syncPair(f, v);
      setError('');
      markInvalid([]);
      scheduleCompute();
    }

    function onParamChange() {
      var next = readInputs(true);
      if (!next) return;
      state.config = next;
      FIELDS.forEach(function (f) { if (f.range) syncPair(f, next[f.key]); });
      runCompute();
    }

    function setMode(mode) {
      state.config.mode = mode;
      ['P', 'PI', 'PID', 'Compare'].forEach(function (m) {
        var key = m === 'Compare' ? 'compare' : m;
        root.querySelector('#pidMode' + m).setAttribute('aria-pressed', String(mode === key));
      });
      runCompute();
    }

    function onReset() {
      state.config = cloneConfig(DEFAULTS);
      FIELDS.forEach(function (f) {
        root.querySelector('#' + f.id).value = String(DEFAULTS[f.key]);
        if (f.range) root.querySelector('#' + f.range).value = String(DEFAULTS[f.key]);
      });
      root.querySelector('#pidDt').value = String(DEFAULTS.dt);
      root.querySelector('#pidDuration').value = String(DEFAULTS.duration);
      root.querySelector('#pidAntiWindup').checked = DEFAULTS.antiWindup;
      ['P', 'PI', 'PID', 'Compare'].forEach(function (m) {
        var key = m === 'Compare' ? 'compare' : m;
        root.querySelector('#pidMode' + m).setAttribute('aria-pressed', String(DEFAULTS.mode === key));
      });
      setError('');
      markInvalid([]);
      runCompute();
    }

    var listeners = [];
    FIELDS.forEach(function (f) {
      var num = root.querySelector('#' + f.id);
      listeners.push([num, 'input', function () { onParamInput(f, false); }]);
      listeners.push([num, 'change', onParamChange]);
      if (f.range) {
        var rng = root.querySelector('#' + f.range);
        listeners.push([rng, 'input', function () { onParamInput(f, true); }]);
        listeners.push([rng, 'change', onParamChange]);
      }
    });
    listeners.push([root.querySelector('#pidDt'), 'change', onParamChange]);
    listeners.push([root.querySelector('#pidDuration'), 'change', onParamChange]);
    listeners.push([root.querySelector('#pidAntiWindup'), 'change', onParamChange]);
    listeners.push([root.querySelector('#pidModeP'), 'click', function () { setMode('P'); }]);
    listeners.push([root.querySelector('#pidModePI'), 'click', function () { setMode('PI'); }]);
    listeners.push([root.querySelector('#pidModePID'), 'click', function () { setMode('PID'); }]);
    listeners.push([root.querySelector('#pidModeCompare'), 'click', function () { setMode('compare'); }]);
    listeners.push([root.querySelector('#pidReset'), 'click', onReset]);
    listeners.forEach(function (l) { l[0].addEventListener(l[1], l[2]); });

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
    root.__pidHandle = handle;
    return handle;
  }

  function summarize(sim) {
    return {
      metrics: sim.metrics,
      diverged: sim.diverged,
      yFinal: sim.y[sim.y.length - 1],
      uFinal: sim.u[sim.u.length - 1],
      n: sim.n,
      stats: {
        maxU: sim.stats.maxU, minU: sim.stats.minU,
        maxI: sim.stats.maxI, minI: sim.stats.minI,
        maxD: sim.stats.maxD, minD: sim.stats.minD,
        satCount: sim.stats.satCount
      }
    };
  }

  function snapshot(state) {
    var primary = state.compare ? state.compare.PID : state.single;
    var s = summarize(primary);
    return {
      config: cloneConfig(state.config),
      mode: state.config.mode,
      antiWindup: state.config.antiWindup,
      computeCount: state.computeCount,
      invalid: state.invalid.slice(),
      metrics: s.metrics,
      diverged: s.diverged,
      settled: s.metrics.settled,
      reason: s.metrics.reason,
      yFinal: s.yFinal,
      uFinal: s.uFinal,
      n: s.n,
      stats: s.stats,
      compare: state.compare ? {
        P: summarize(state.compare.P),
        PI: summarize(state.compare.PI),
        PID: summarize(state.compare.PID)
      } : null
    };
  }

  function getState(root) {
    return root && root.__pidHandle ? root.__pidHandle.getState() : null;
  }

  var api = {
    VERSION: 1,
    DEFAULTS: DEFAULTS,
    DT_OPTIONS: DT_OPTIONS,
    DURATION_OPTIONS: DURATION_OPTIONS,
    MAX_DISPLAY_POINTS: MAX_DISPLAY_POINTS,
    DEBOUNCE_MS: DEBOUNCE_MS,
    renderPage: renderPage,
    mount: mount,
    getState: getState
  };

  global.PidDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);