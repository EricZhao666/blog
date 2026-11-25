/* 卡尔曼滤波与传感器融合实验室 UI（原生 SVG，数学全部委托 kalman-calculation.js）
 *
 * 两种模式：
 *   scalar —— 一维随机游走（状态维数 1）
 *   matrix —— 位置+速度（状态维数 2、空间维数 1）
 *
 * 交互：预测一步 / 应用更新 / 自动播放 / 暂停 / 重置；参数、场景、传感器开关。
 * 生命周期：destroy() 清理定时器与全部事件监听；路由切换时由 app.js 调用。
 */
(function (global) {
  'use strict';

  var MAX_DRAW_POINTS = 400;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var n = d === undefined ? 3 : d;
    return Number(v).toFixed(n);
  }

  function fmtSmart(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    if (a >= 0.001) return v.toFixed(4);
    return v.toExponential(2);
  }

  function drawChart(svg, cfg) {
    if (!svg) return 0;
    var W = 760, H = 220, L = 66, R = 12, T = 14, B = 28;
    var n = cfg.length;
    if (!n) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      return 0;
    }
    svg.removeAttribute('hidden');

    var all = [];
    (cfg.series || []).forEach(function (s) {
      s.values.forEach(function (v) { if (v !== null && v !== undefined && isFinite(v)) all.push(v); });
    });
    if (cfg.band) {
      cfg.band.lower.concat(cfg.band.upper).forEach(function (v) {
        if (v !== null && isFinite(v)) all.push(v);
      });
    }
    if (!all.length) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      return 0;
    }
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    if (max - min < 1e-9) { min -= 0.5; max += 0.5; }
    var pad = (max - min) * 0.08;
    min -= pad; max += pad;
    var plotW = W - L - R, plotH = H - T - B;
    function xOf(i) { return n === 1 ? L + plotW / 2 : L + plotW * (i / (n - 1)); }
    function yOf(v) { return T + (max - v) / (max - min) * plotH; }

    var html = '';
    for (var g = 0; g <= 4; g++) {
      var vy = min + (max - min) * g / 4;
      var yy = yOf(vy);
      html += '<line class="spc-grid" x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '"></line>';
      html += '<text class="spc-tick" x="' + (L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + fmtSmart(vy) + '</text>';
    }
    html += '<line class="spc-axis" x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '"></line>';
    html += '<line class="spc-axis" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '"></line>';

    var xs = [0, Math.floor((n - 1) / 2), n - 1];
    xs.forEach(function (i) {
      html += '<text class="spc-tick" x="' + xOf(i).toFixed(1) + '" y="' + (H - B + 15) + '" text-anchor="middle">' +
        (cfg.xLabel ? cfg.xLabel(i) : String(i)) + '</text>';
    });

    // 置信带
    if (cfg.band) {
      var segs = [], cur = [];
      for (var i = 0; i < n; i++) {
        if (cfg.band.lower[i] !== null && cfg.band.upper[i] !== null &&
            isFinite(cfg.band.lower[i]) && isFinite(cfg.band.upper[i])) {
          cur.push(i);
        } else if (cur.length) { segs.push(cur); cur = []; }
      }
      if (cur.length) segs.push(cur);
      segs.forEach(function (seg) {
        if (seg.length < 2) return;
        var up = '', dn = '';
        seg.forEach(function (i) {
          up += (i === seg[0] ? 'M' : 'L') + xOf(i).toFixed(1) + ' ' + yOf(cfg.band.upper[i]).toFixed(1) + ' ';
        });
        for (var q = seg.length - 1; q >= 0; q--) {
          dn += 'L' + xOf(seg[q]).toFixed(1) + ' ' + yOf(cfg.band.lower[seg[q]]).toFixed(1) + ' ';
        }
        html += '<path class="kf-band" d="' + up + dn + 'Z"></path>';
      });
    }

    (cfg.series || []).forEach(function (s) {
      if (s.type === 'dots') {
        for (var i = 0; i < n; i++) {
          var v = s.values[i];
          if (v === null || v === undefined || !isFinite(v)) continue;
          html += '<circle class="' + s.cls + '" cx="' + xOf(i).toFixed(1) + '" cy="' + yOf(v).toFixed(1) + '" r="2.4"></circle>';
        }
        return;
      }
      var d = '', pen = false;
      for (var j = 0; j < n; j++) {
        var v2 = s.values[j];
        if (v2 === null || v2 === undefined || !isFinite(v2)) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + xOf(j).toFixed(1) + ' ' + yOf(v2).toFixed(1) + ' ';
        pen = true;
      }
      if (d) html += '<path class="' + s.cls + '" d="' + d + '"></path>';
    });
    svg.innerHTML = html;
    return n;
  }

  function renderPage() {
    var scenes = global.KalmanCalculation.scenarioList();
    return '<div id="kfDemoRoot">' +
      '<p class="spc-mode-line"><strong id="kfModeLabel">二维位置—速度 + 传感器融合</strong>' +
      '<span class="spc-mode-hint" id="kfModeHint">（状态维数 2、空间维数 1；全部计算在本机完成）</span></p>' +
      '<p class="spc-error" id="kfError" aria-live="polite"></p>' +
      '<div class="spc-layout">' +
      '<div class="spc-main">' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">当前步：预测 / 创新 / 增益 / 更新</h2>' +
      '<dl class="spc-stats" id="kfStepBody"></dl>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">位置：真实轨迹 / 原始测量 / 滤波估计</h2>' +
      '<div class="spc-chart-wrap"><svg id="kfChartPos" class="spc-chart" viewBox="0 0 760 220" role="img" aria-label="位置曲线：真实轨迹、原始测量与滤波估计"></svg></div>' +
      '<div class="spc-legend" id="kfLegendPos"></div>' +
      '<p class="spc-chart-note" id="kfNotePos"></p>' +
      '</section>' +

      '<section class="spc-card" id="kfVelCard">' +
      '<h2 class="spc-card-title">速度：真实 / 测量 / 估计</h2>' +
      '<div class="spc-chart-wrap"><svg id="kfChartVel" class="spc-chart" viewBox="0 0 760 220" role="img" aria-label="速度曲线：真实、测量与估计"></svg></div>' +
      '<div class="spc-legend" id="kfLegendVel"></div>' +
      '<p class="spc-chart-note" id="kfNoteVel"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">估计误差（估计 − 真实）</h2>' +
      '<div class="spc-chart-wrap"><svg id="kfChartErr" class="spc-chart" viewBox="0 0 760 220" role="img" aria-label="位置与速度估计误差"></svg></div>' +
      '<div class="spc-legend" id="kfLegendErr"></div>' +
      '<p class="spc-chart-note">误差为 0 的横线用于判断系统性偏差；模型失配时误差会出现持续同号。</p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">卡尔曼增益</h2>' +
      '<div class="spc-chart-wrap"><svg id="kfChartGain" class="spc-chart" viewBox="0 0 760 220" role="img" aria-label="卡尔曼增益随时间变化"></svg></div>' +
      '<div class="spc-legend" id="kfLegendGain"></div>' +
      '<p class="spc-chart-note">增益由协方差与 R 的比值决定，不是手调参数；Q/R 改变会改变增益稳态。</p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">协方差（标准差 √P）</h2>' +
      '<div class="spc-chart-wrap"><svg id="kfChartCov" class="spc-chart" viewBox="0 0 760 220" role="img" aria-label="位置与速度协方差随时间变化"></svg></div>' +
      '<div class="spc-legend" id="kfLegendCov"></div>' +
      '<p class="spc-chart-note">测量缺失时只做预测，协方差增大；恢复测量后下降。</p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">指标</h2>' +
      '<div class="spc-table-wrap"><table class="spc-cap-table">' +
      '<caption class="spc-visually-hidden">滤波估计与原始测量的误差指标</caption>' +
      '<thead><tr><th scope="col">指标</th><th scope="col">位置</th><th scope="col">速度</th></tr></thead>' +
      '<tbody id="kfMetricsBody"></tbody></table></div>' +
      '<p class="spc-cap-note" id="kfMetricsNote"></p>' +
      '</section>' +

      '</div>' +
      '<aside class="spc-panel">' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">实验模式</span>' +
      '<div class="spc-modes" role="radiogroup" aria-label="卡尔曼实验模式">' +
      '<label class="spc-radio"><input type="radio" name="kfMode" id="kfModeMatrix" value="matrix" checked><span>位置—速度（二维状态）</span></label>' +
      '<label class="spc-radio"><input type="radio" name="kfMode" id="kfModeScalar" value="scalar"><span>标量随机游走（一维状态）</span></label>' +
      '</div>' +
      '<p class="spc-mode-desc" id="kfModeDesc"></p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">场景（合成教学数据）</span>' +
      '<label class="spc-input-label" for="kfScene">场景<select id="kfScene">' +
      scenes.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') +
      '</select></label>' +
      '<p class="spc-example-note" id="kfSceneNote"></p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">推进</span>' +
      '<div class="spc-btn-row"><button type="button" id="kfPlay" class="spc-btn">自动播放</button>' +
      '<button type="button" id="kfPause" class="spc-btn">暂停</button></div>' +
      '<div class="spc-btn-row"><button type="button" id="kfPredict" class="spc-btn">预测一步</button>' +
      '<button type="button" id="kfStep" class="spc-btn">应用测量更新</button></div>' +
      '<button type="button" id="kfReset" class="spc-btn">重置到起点</button>' +
      '<p class="spc-baseline-state" id="kfProgress">0 / 0 步</p>' +
      '</div>' +

      '<div class="spc-field" id="kfScalarParams" hidden>' +
      '<span class="spc-field-title">标量参数（Q/R 为方差）</span>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfX0">初始状态 x₀<input id="kfX0" type="number" step="0.1"></label>' +
      '<label class="spc-input-label" for="kfP0">初始协方差 P₀<input id="kfP0" type="number" min="0" step="0.1"></label>' +
      '</div>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfQ">过程噪声方差 Q<input id="kfQ" type="number" min="0" step="0.01"></label>' +
      '<label class="spc-input-label" for="kfR">测量噪声方差 R<input id="kfR" type="number" min="0.001" step="0.1"></label>' +
      '</div>' +
      '</div>' +

      '<div class="spc-field" id="kfMatrixParams">' +
      '<span class="spc-field-title">二维参数（方差与 σ_a）</span>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfP0pos">初始位置<input id="kfP0pos" type="number" step="0.1"></label>' +
      '<label class="spc-input-label" for="kfV0">初始速度<input id="kfV0" type="number" step="0.1"></label>' +
      '</div>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfP0var">位置方差 P₀(0,0)<input id="kfP0var" type="number" min="0" step="0.5"></label>' +
      '<label class="spc-input-label" for="kfV0var">速度方差 P₀(1,1)<input id="kfV0var" type="number" min="0" step="0.5"></label>' +
      '</div>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfSigmaA">加速度 σ_a<input id="kfSigmaA" type="number" min="0" step="0.01"></label>' +
      '<label class="spc-input-label" for="kfDt">采样周期 dt<input id="kfDt" type="number" min="0.01" step="0.05"></label>' +
      '</div>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="kfRpos">位置 R<input id="kfRpos" type="number" min="0.001" step="0.1"></label>' +
      '<label class="spc-input-label" for="kfRvel">速度 R<input id="kfRvel" type="number" min="0.001" step="0.1"></label>' +
      '</div>' +
      '<p class="spc-hint">Q = σ_a²·G·Gᵀ，G=[dt²/2, dt]ᵀ（逐区间独立随机恒定加速度）。</p>' +
      '</div>' +

      '<div class="spc-field" id="kfSensorField">' +
      '<span class="spc-field-title">传感器与门限</span>' +
      '<label class="spc-radio"><input type="checkbox" id="kfSensorPos" checked><span>位置传感器</span></label>' +
      '<label class="spc-radio"><input type="checkbox" id="kfSensorVel" checked><span>速度传感器</span></label>' +
      '<label class="spc-input-label" for="kfGate">创新门限（σ 倍数，0=关闭）<input id="kfGate" type="number" min="0" step="0.5"></label>' +
      '<p class="spc-hint">不同传感器的测量噪声默认相互独立；门限只是可选的异常处理，不会静默删除观测。</p>' +
      '</div>' +

      '<div class="spc-explain">' +
      '<p><strong>标量</strong>：x⁺=x⁻，P⁺=P⁻+Q；K=P⁺/(P⁺+R)；x=x⁺+K(z−x⁺)；P=(1−K)P⁺。</p>' +
      '<p><strong>二维</strong>：F=[[1,dt],[0,1]]；H_pos=[1,0]，H_vel=[0,1]；协方差用 Joseph 形式更新。</p>' +
      '<p><strong>限制</strong>：仅速度测量时绝对位置不可观测；置信带基于线性高斯假设，不保证覆盖真实值。</p>' +
      '</div>' +

      '</aside></div>' +
      '<p class="spc-visually-hidden" id="kfLive" aria-live="polite"></p>' +
      '</div>';
  }

  function mount(root) {
    var KC = global.KalmanCalculation;
    if (!root || !KC) return null;

    var state = {
      mode: 'matrix',
      sceneId: 'cruise',
      params: {
        scalar: { x0: KC.DEFAULTS.scalar.x0, p0: KC.DEFAULTS.scalar.p0, q: KC.DEFAULTS.scalar.q, r: KC.DEFAULTS.scalar.r },
        matrix: {
          p0: KC.DEFAULTS.matrix.p0, v0: KC.DEFAULTS.matrix.v0,
          p0Var: KC.DEFAULTS.matrix.p0Var, v0Var: KC.DEFAULTS.matrix.v0Var,
          sigmaA: KC.DEFAULTS.matrix.sigmaA, dt: KC.DEFAULTS.matrix.dt,
          rPos: KC.DEFAULTS.matrix.rPos, rVel: KC.DEFAULTS.matrix.rVel
        }
      },
      sensors: { pos: true, vel: true },
      gate: 0,
      cursor: 0,
      pending: false,
      playing: false,
      result: null,
      error: '',
      computeCount: 0,
      chartDrawn: 0
    };

    var listeners = [];
    var playTimer = 0;
    var destroyed = false;

    function $(id) { return root.querySelector('#' + id); }
    function setError(msg) {
      state.error = msg || '';
      var el = $('kfError');
      if (el) el.textContent = state.error;
    }
    function setLive(msg) {
      var el = $('kfLive');
      if (el) el.textContent = msg;
    }
    function on(el, ev, fn) {
      if (!el) return;
      el.addEventListener(ev, fn);
      listeners.push([el, ev, fn]);
    }
    function readNum(id) {
      var el = $(id);
      if (!el) return null;
      var raw = String(el.value).trim();
      if (raw === '') return null;
      var v = Number(raw);
      return isFinite(v) ? v : NaN;
    }

    function readParams() {
      if (state.mode === 'scalar') {
        return {
          x0: readNum('kfX0'), p0: readNum('kfP0'),
          q: readNum('kfQ'), r: readNum('kfR')
        };
      }
      return {
        p0: readNum('kfP0pos'), v0: readNum('kfV0'),
        p0Var: readNum('kfP0var'), v0Var: readNum('kfV0var'),
        sigmaA: readNum('kfSigmaA'), dt: readNum('kfDt'),
        rPos: readNum('kfRpos'), rVel: readNum('kfRvel')
      };
    }

    function compute() {
      state.result = null;
      state.cursor = 0;
      state.pending = false;
      stopPlay();
      var scene = state.sceneId;
      var r;
      if (state.mode === 'scalar') {
        var ps = readParams();
        state.params.scalar = ps;
        r = KC.runScalar({
          scenario: scene, x0: ps.x0, p0: ps.p0, q: ps.q, r: ps.r,
          gate: state.gate
        });
      } else {
        var pm = readParams();
        state.params.matrix = pm;
        r = KC.run2D({
          scenario: scene, p0: pm.p0, v0: pm.v0,
          p0Var: pm.p0Var, v0Var: pm.v0Var, sigmaA: pm.sigmaA, dt: pm.dt,
          rPos: pm.rPos, rVel: pm.rVel, sensors: state.sensors, gate: state.gate
        });
      }
      if (!r.ok) {
        setError(r.message);
        renderEmpty(r.message);
        return;
      }
      setError('');
      state.result = r;
      state.computeCount++;
      render();
    }

    function currentSteps() {
      return state.result ? state.result.steps.slice(0, state.cursor) : [];
    }

    function partialMetrics() {
      var s = currentSteps();
      if (!s.length) return null;
      return state.mode === 'scalar' ? KC.metricsScalar(s) : KC.metrics2D(s);
    }

    function renderEmpty(message) {
      $('kfStepBody').innerHTML = '<dt>状态</dt><dd>' + esc(message) + '</dd>';
      ['kfChartPos', 'kfChartVel', 'kfChartErr', 'kfChartGain', 'kfChartCov'].forEach(function (id) {
        var svg = $(id);
        if (svg) { svg.innerHTML = ''; svg.setAttribute('hidden', ''); }
      });
      $('kfMetricsBody').innerHTML = '<tr><td colspan="3" class="spc-na">' + esc(message) + '</td></tr>';
      $('kfMetricsNote').textContent = '';
      $('kfProgress').textContent = '0 / 0 步';
    }

    function renderStep() {
      var steps = currentSteps();
      var body = $('kfStepBody');
      var rows = [];
      var n = state.result.steps.length;
      var last = steps.length ? steps[steps.length - 1] : null;
      var next = state.cursor < n ? state.result.steps[state.cursor] : null;
      var m = state.mode === 'scalar';
      if (state.pending && next) {
        rows.push(['阶段', '第 ' + (next.k + 1) + ' 步已预测，等待测量更新']);
        rows.push(['预测位置 x⁻', fmtSmart(next.predPos)]);
        if (!m) rows.push(['预测速度 v⁻', fmtSmart(next.predVel)]);
        rows.push(['观测 z', next.zPos === null || next.zPos === undefined ? '缺失（不可更新）' : fmtSmart(next.zPos)]);
        if (!m && next.zVel !== null && next.zVel !== undefined) rows.push(['速度观测', fmtSmart(next.zVel)]);
        rows.push(['创新 z − Hx⁻', next.zPos === null || next.zPos === undefined ? '—' : fmtSmart(next.zPos - next.predPos)]);
        rows.push(['预测方差 P⁻', m ? fmtSmart(next.predP) : fmtSmart(next.predP00) + ' / ' + fmtSmart(next.predP11)]);
      } else if (last) {
        rows.push(['阶段', '第 ' + (last.k + 1) + ' 步已更新']);
        rows.push(['预测位置 x⁻', fmtSmart(last.predPos)]);
        if (!m) rows.push(['预测速度 v⁻', fmtSmart(last.predVel)]);
        rows.push(['观测 z', last.zPos === null || last.zPos === undefined ? '缺失' : fmtSmart(last.zPos)]);
        rows.push(['创新 z − Hx⁻', last.innovationPos === null ? '—' : fmtSmart(last.innovationPos)]);
        rows.push(['增益 K', m ? (last.gain === null ? '—' : fmtSmart(last.gain))
          : (last.gainPos === null ? '—' : fmtSmart(last.gainPos)) + ' / ' + (last.gainVel === null ? '—' : fmtSmart(last.gainVel))]);
        rows.push(['更新位置', fmtSmart(last.pos)]);
        if (!m) rows.push(['更新速度', fmtSmart(last.vel)]);
        rows.push(['更新后方差', m ? fmtSmart(last.p) : fmtSmart(last.P[0][0]) + ' / ' + fmtSmart(last.P[1][1])]);
        if (last.gatedPos || last.gatedVel) rows.push(['门限', '本步存在被门限拒绝的观测（未删除，已记录）']);
      } else {
        rows.push(['阶段', '起点：尚未推进']);
        rows.push(['初始状态', m ? fmtSmart(state.params.scalar.x0) : fmtSmart(state.params.matrix.p0) + ' / ' + fmtSmart(state.params.matrix.v0)]);
        rows.push(['初始协方差', m ? fmtSmart(state.params.scalar.p0)
          : fmtSmart(state.params.matrix.p0Var) + ' / ' + fmtSmart(state.params.matrix.v0Var)]);
      }
      body.innerHTML = rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
      }).join('');
    }

    function renderCharts() {
      var steps = currentSteps();
      var m = state.mode === 'scalar';
      var len = steps.length;
      var posTruth = steps.map(function (s) { return s.truePos; });
      var posMeas = steps.map(function (s) { return s.zPos; });
      var posEst = steps.map(function (s) { return s.pos; });
      var band = steps.map(function (s) {
        var v = m ? s.p : s.P[0][0];
        var b = KC.confidenceBand(s.pos, v, 1.96);
        return b.ok ? b : { lower: null, upper: null };
      });

      var drawn = 0;
      drawn = Math.max(drawn, drawChart($('kfChartPos'), {
        length: len,
        series: [
          { values: posTruth, cls: 'kf-truth', type: 'line' },
          { values: posMeas, cls: 'kf-meas', type: 'dots' },
          { values: posEst, cls: 'kf-est', type: 'line' }
        ],
        band: { lower: band.map(function (b) { return b.lower; }), upper: band.map(function (b) { return b.upper; }) },
        xLabel: function (i) { return steps.length ? String(steps[i].k + 1) : String(i + 1); }
      }));

      $('kfLegendPos').innerHTML =
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--truth"></i>真实轨迹</span>' +
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--meas"></i>原始测量</span>' +
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--est"></i>滤波估计</span>' +
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--band"></i>±1.96√P（模型置信带）</span>';
      $('kfNotePos').textContent = len
        ? '横轴为生产/采样顺序（1-based）。置信带只反映模型方差，基于线性高斯假设，不保证覆盖真实值。'
        : '尚未推进：点击「预测一步」或「应用测量更新」。';

      var velCard = $('kfVelCard');
      if (m) {
        velCard.hidden = true;
      } else {
        velCard.hidden = false;
        var velTruth = steps.map(function (s) { return s.trueVel; });
        var velMeas = steps.map(function (s) { return s.zVel; });
        var velEst = steps.map(function (s) { return s.vel; });
        var vb = steps.map(function (s) {
          var b = KC.confidenceBand(s.vel, s.P[1][1], 1.96);
          return b.ok ? b : { lower: null, upper: null };
        });
        drawn = Math.max(drawn, drawChart($('kfChartVel'), {
          length: len,
          series: [
            { values: velTruth, cls: 'kf-truth', type: 'line' },
            { values: velMeas, cls: 'kf-meas', type: 'dots' },
            { values: velEst, cls: 'kf-est', type: 'line' }
          ],
          band: { lower: vb.map(function (b) { return b.lower; }), upper: vb.map(function (b) { return b.upper; }) },
          xLabel: function (i) { return steps.length ? String(steps[i].k + 1) : String(i + 1); }
        }));
        $('kfLegendVel').innerHTML =
          '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--truth"></i>真实速度</span>' +
          '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--meas"></i>速度测量</span>' +
          '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--est"></i>速度估计</span>' +
          '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--band"></i>±1.96√P₁₁</span>';
        $('kfNoteVel').textContent = '仅速度测量时，绝对位置不可由速度积分唯一确定，位置方差会持续增大。';
      }

      // 误差
      var ePos = steps.map(function (s) { return s.pos - s.truePos; });
      var eVel = m ? [] : steps.map(function (s) { return s.vel - s.trueVel; });
      drawn = Math.max(drawn, drawChart($('kfChartErr'), {
        length: len,
        series: m ? [{ values: ePos, cls: 'kf-err-pos', type: 'line' }]
          : [{ values: ePos, cls: 'kf-err-pos', type: 'line' }, { values: eVel, cls: 'kf-err-vel', type: 'line' }],
        xLabel: function (i) { return steps.length ? String(steps[i].k + 1) : String(i + 1); }
      }));
      $('kfLegendErr').innerHTML =
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--errpos"></i>位置误差</span>' +
        (m ? '' : '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--errvel"></i>速度误差</span>');

      // 增益
      var gp = steps.map(function (s) { return m ? s.gain : s.gainPos; });
      var gv = m ? [] : steps.map(function (s) { return s.gainVel; });
      drawn = Math.max(drawn, drawChart($('kfChartGain'), {
        length: len,
        series: m ? [{ values: gp, cls: 'kf-gain-pos', type: 'line' }]
          : [{ values: gp, cls: 'kf-gain-pos', type: 'line' }, { values: gv, cls: 'kf-gain-vel', type: 'line' }],
        xLabel: function (i) { return steps.length ? String(steps[i].k + 1) : String(i + 1); }
      }));
      $('kfLegendGain').innerHTML =
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--gainpos"></i>位置增益 K₀</span>' +
        (m ? '' : '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--gainvel"></i>速度增益 K₁</span>');

      // 协方差（标准差）
      var sp = steps.map(function (s) { return Math.sqrt(Math.max(0, m ? s.p : s.P[0][0])); });
      var sv = m ? [] : steps.map(function (s) { return Math.sqrt(Math.max(0, s.P[1][1])); });
      drawn = Math.max(drawn, drawChart($('kfChartCov'), {
        length: len,
        series: m ? [{ values: sp, cls: 'kf-cov-pos', type: 'line' }]
          : [{ values: sp, cls: 'kf-cov-pos', type: 'line' }, { values: sv, cls: 'kf-cov-vel', type: 'line' }],
        xLabel: function (i) { return steps.length ? String(steps[i].k + 1) : String(i + 1); }
      }));
      $('kfLegendCov').innerHTML =
        '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--covpos"></i>√P 位置</span>' +
        (m ? '' : '<span class="spc-legend-item"><i class="kf-swatch kf-swatch--covvel"></i>√P 速度</span>');

      state.chartDrawn = drawn;
    }

    function renderMetrics() {
      var met = partialMetrics();
      var body = $('kfMetricsBody');
      if (!met) {
        body.innerHTML = '<tr><td colspan="3" class="spc-na">尚未推进，暂无误差指标。</td></tr>';
        $('kfMetricsNote').textContent = '';
        return;
      }
      function cell(v) { return v === null || v === undefined ? '—' : fmtSmart(v); }
      body.innerHTML =
        '<tr><th scope="row">估计 RMSE</th><td>' + cell(met.pos.est.rmse) + '</td><td>' + cell(met.vel.est.rmse) + '</td></tr>' +
        '<tr><th scope="row">原始测量 RMSE</th><td>' + cell(met.pos.raw.rmse) + '</td><td>' + cell(met.vel.raw.rmse) + '</td></tr>' +
        '<tr><th scope="row">平均绝对误差</th><td>' + cell(met.pos.est.mae) + '</td><td>' + cell(met.vel.est.mae) + '</td></tr>' +
        '<tr><th scope="row">最大绝对误差</th><td>' + cell(met.pos.est.maxAbs) + '</td><td>' + cell(met.vel.est.maxAbs) + '</td></tr>' +
        '<tr><th scope="row">有效测量数</th><td>' + met.counts.validPos + '</td><td>' + met.counts.validVel + '</td></tr>' +
        '<tr><th scope="row">缺失数</th><td>' + met.counts.missingPos + '</td><td>' + met.counts.missingVel + '</td></tr>';
      $('kfMetricsNote').textContent = '原始测量 RMSE 只在有测量的时间索引上计算（缺失不当作 0）；' +
        '估计 RMSE 使用已推进的全部步。共 ' + met.counts.total + ' 步。';
    }

    function render() {
      var m = state.mode === 'scalar';
      $('kfModeLabel').textContent = m ? '标量随机游走卡尔曼滤波' : '位置—速度二维卡尔曼滤波与传感器融合';
      $('kfModeHint').textContent = m
        ? '（状态维数 1、空间维数 1；x 为被估计的单一坐标）'
        : '（状态维数 2 = 位置+速度、空间维数 1；全部计算在本机完成）';
      $('kfModeDesc').textContent = m
        ? '随机游走模型：x(k)=x(k−1)+w，z(k)=x(k)+v。速度不建模，因此不适合明显趋势数据。'
        : '恒速模型：F=[[1,dt],[0,1]]，过程噪声由 σ_a 经 G=[dt²/2,dt]ᵀ 注入；位置与速度是两个状态分量。';
      $('kfScalarParams').hidden = !m;
      $('kfMatrixParams').hidden = m;
      $('kfSensorField').hidden = m;

      var scene = KC.scenarioData(state.sceneId);
      if (!scene) { renderEmpty('场景不存在。'); return; }
      $('kfSceneNote').textContent = scene.note + '（合成数据，种子 ' + scene.seed + '）';

      renderStep();
      renderCharts();
      renderMetrics();
      $('kfProgress').textContent = state.cursor + ' / ' + (state.result ? state.result.steps.length : 0) + ' 步' +
        (state.pending ? '（已预测待更新）' : '');
      setLive('第 ' + state.cursor + ' 步' + (state.pending ? '，已预测待更新' : '') +
        (state.result ? '，共 ' + state.result.steps.length + ' 步' : ''));
    }

    function hasNext() {
      return !!state.result && state.cursor < state.result.steps.length;
    }

    function doPredict() {
      if (!state.result) return;
      if (!hasNext()) { setLive('已到序列末尾，先重置。'); return; }
      state.pending = true;
      render();
      setLive('已预测第 ' + (state.result.steps[state.cursor].k + 1) + ' 步，等待测量更新');
    }

    function doUpdate() {
      if (!state.result) return;
      if (!hasNext()) { setLive('已到序列末尾，先重置。'); stopPlay(); return; }
      var wasPending = state.pending;
      state.cursor++;
      state.pending = false;
      render();
      setLive(wasPending ? '已应用测量更新，第 ' + state.cursor + ' 步完成'
        : '已预测并更新，第 ' + state.cursor + ' 步完成');
      if (!hasNext()) stopPlay();
    }

    function stopPlay() {
      state.playing = false;
      if (playTimer) { global.clearInterval(playTimer); playTimer = 0; }
    }

    function startPlay() {
      if (!state.result || !hasNext()) return;
      if (playTimer) return;
      state.playing = true;
      playTimer = global.setInterval(function () {
        if (destroyed) { stopPlay(); return; }
        if (!hasNext()) { stopPlay(); return; }
        doUpdate();
      }, 220);
      setLive('自动播放中');
    }

    function resetRun() {
      stopPlay();
      state.cursor = 0;
      state.pending = false;
      render();
      setLive('已重置到起点');
    }

    function onModeChange() {
      var el = $('kfModeMatrix').checked ? 'matrix' : 'scalar';
      if (el === state.mode) return;
      state.mode = el;
      compute();
    }

    function onSceneChange() {
      state.sceneId = $('kfScene').value;
      compute();
    }

    function onSensorsChange() {
      state.sensors = { pos: $('kfSensorPos').checked, vel: $('kfSensorVel').checked };
      compute();
      if (!state.sensors.pos && !state.sensors.vel) {
        setLive('两个传感器都关闭：只执行预测，协方差按 Q 增长');
      }
    }

    function onGateChange() {
      var g = readNum('kfGate');
      state.gate = g === null ? 0 : g;
      if (state.gate < 0 || !isFinite(state.gate)) {
        setError('创新门限必须 ≥ 0（0 表示关闭）。');
        return;
      }
      compute();
    }

    function onParamChange() {
      compute();
    }

    // 初始化控件
    var ps = state.params.scalar, pm = state.params.matrix;
    $('kfX0').value = String(ps.x0);
    $('kfP0').value = String(ps.p0);
    $('kfQ').value = String(ps.q);
    $('kfR').value = String(ps.r);
    $('kfP0pos').value = String(pm.p0);
    $('kfV0').value = String(pm.v0);
    $('kfP0var').value = String(pm.p0Var);
    $('kfV0var').value = String(pm.v0Var);
    $('kfSigmaA').value = String(pm.sigmaA);
    $('kfDt').value = String(pm.dt);
    $('kfRpos').value = String(pm.rPos);
    $('kfRvel').value = String(pm.rVel);
    $('kfGate').value = '0';
    $('kfScene').value = state.sceneId;

    on($('kfModeMatrix'), 'change', onModeChange);
    on($('kfModeScalar'), 'change', onModeChange);
    on($('kfScene'), 'change', onSceneChange);
    on($('kfSensorPos'), 'change', onSensorsChange);
    on($('kfSensorVel'), 'change', onSensorsChange);
    on($('kfGate'), 'change', onGateChange);
    ['kfX0', 'kfP0', 'kfQ', 'kfR', 'kfP0pos', 'kfV0', 'kfP0var', 'kfV0var', 'kfSigmaA', 'kfDt', 'kfRpos', 'kfRvel']
      .forEach(function (id) { on($(id), 'change', onParamChange); });
    on($('kfPlay'), 'click', startPlay);
    on($('kfPause'), 'click', function () { stopPlay(); render(); setLive('已暂停'); });
    on($('kfPredict'), 'click', doPredict);
    on($('kfStep'), 'click', doUpdate);
    on($('kfReset'), 'click', resetRun);

    compute();

    var handle = {
      getState: function () { return snapshot(); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        stopPlay();
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners = [];
      }
    };
    root.__kfHandle = handle;
    return handle;

    function snapshot() {
      var r = state.result;
      var steps = r ? r.steps.slice(0, state.cursor) : [];
      var last = steps.length ? steps[steps.length - 1] : null;
      var met = partialMetrics();
      var next = r && state.cursor < r.steps.length ? r.steps[state.cursor] : null;
      var m = state.mode === 'scalar';
      return {
        mode: state.mode,
        scene: state.sceneId,
        cursor: state.cursor,
        total: r ? r.steps.length : 0,
        pending: state.pending,
        playing: state.playing,
        sensors: { pos: state.sensors.pos, vel: state.sensors.vel },
        gate: state.gate,
        params: m ? Object.assign({}, state.params.scalar) : Object.assign({}, state.params.matrix),
        error: state.error,
        computeCount: state.computeCount,
        chartDrawn: state.chartDrawn,
        pos: last ? last.pos : null,
        vel: last ? last.vel : null,
        pPos: last ? (m ? last.p : last.P[0][0]) : null,
        pVel: last ? (m ? null : last.P[1][1]) : null,
        gainPos: last ? (m ? last.gain : last.gainPos) : null,
        gainVel: last ? (m ? null : last.gainVel) : null,
        innovationPos: last ? last.innovationPos : null,
        innovationVel: last ? last.innovationVel : null,
        pendingPred: state.pending && next ? {
          pos: next.predPos, vel: m ? null : next.predVel,
          pPos: m ? next.predP : next.predP00
        } : null,
        metrics: met ? {
          posEstRmse: met.pos.est.rmse, posRawRmse: met.pos.raw.rmse,
          posMae: met.pos.est.mae, posMaxAbs: met.pos.est.maxAbs,
          velEstRmse: met.vel.est.rmse, velRawRmse: met.vel.raw.rmse,
          velMae: met.vel.est.mae, velMaxAbs: met.vel.est.maxAbs,
          validPos: met.counts.validPos, missingPos: met.counts.missingPos,
          validVel: met.counts.validVel, missingVel: met.counts.missingVel,
          total: met.counts.total
        } : null
      };
    }
  }

  function getState(root) {
    if (!root) return null;
    var h = root.__kfHandle;
    return h ? h.getState() : null;
  }

  var api = { renderPage: renderPage, mount: mount, getState: getState };
  global.KalmanDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
