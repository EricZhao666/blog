/* 梯形与七段 S 曲线运动轨迹规划 —— 交互 UI（纯 SVG，无第三方图形库）
 *
 * 设计要点：
 *   1. 计算与回放解耦：参数变更或点击"计算规划"时一次性完成梯形与七段 S 曲线求解，
 *      播放/拖动时间游标仅对已求解轨迹做 evaluateProfile() 求值，绝不改变规划结果。
 *   2. 非法输入（如 vMax <= 0、aMax <= 0、jMax <= 0 或非数值）立即显示明确错误提示，
 *      同时保留上一次有效结果或安全降级，不崩溃、不静默夹取。
 *   3. 路由离开时调用 unmount() 幂等清理动画定时器与全局引用。
 */
(function (global) {
  'use strict';

  var _current = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '∞ / 无界';
    var d = digits === undefined ? 4 : digits;
    return Number(v).toFixed(d);
  }

  function fmtSci(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v === 0) return '0';
    if (Math.abs(v) < 1e-4) return v.toExponential(2);
    return Number(v).toFixed(6);
  }

  function renderPage() {
    var MP = global.MotionProfile;
    var scenes = MP.scenarioList();
    return '<div id="mpDemoRoot">' +
      '<p class="spc-mode-line"><strong id="mpModeLabel">梯形与七段 S 曲线运动轨迹规划</strong>' +
      '<span class="spc-mode-hint">（单轴点对点：同时对比三段梯形速度规划与七段加加速度有界 S 曲线，含全退化工况与未修正终点残差；全部计算在本机完成）</span></p>' +
      '<p class="spc-error" id="mpError" aria-live="polite"></p>' +
      '<div class="spc-layout">' +
      '<div class="spc-main">' +

      '<section class="spc-card">' +
      '<div class="mp-chart-head">' +
      '<h2 class="spc-card-title">运动学四联波形：q(t) / v(t) / a(t) / j(t)</h2>' +
      '<div class="mp-legend" aria-label="图例">' +
      '<span class="mp-legend-item"><span class="mp-swatch mp-swatch-scurve"></span>S 曲线（实线）</span>' +
      '<span class="mp-legend-item"><span class="mp-swatch mp-swatch-trap"></span>梯形规划（虚线）</span>' +
      '<span class="mp-legend-item"><span class="mp-swatch mp-swatch-limit"></span>约束上下界</span>' +
      '</div></div>' +
      '<div class="mp-charts-grid">' +
      '<div class="mp-chart-box"><div class="mp-chart-label">位置 q(t)</div><svg id="mpChartPos" class="mp-svg" viewBox="0 0 560 150" role="img" aria-label="位置随时间变化曲线"></svg></div>' +
      '<div class="mp-chart-box"><div class="mp-chart-label">速度 v(t)</div><svg id="mpChartVel" class="mp-svg" viewBox="0 0 560 150" role="img" aria-label="速度随时间变化曲线"></svg></div>' +
      '<div class="mp-chart-box"><div class="mp-chart-label">加速度 a(t)</div><svg id="mpChartAcc" class="mp-svg" viewBox="0 0 560 150" role="img" aria-label="加速度随时间变化曲线"></svg></div>' +
      '<div class="mp-chart-box"><div class="mp-chart-label">加加速度 j(t)</div><svg id="mpChartJerk" class="mp-svg" viewBox="0 0 560 150" role="img" aria-label="加加速度随时间变化曲线"></svg></div>' +
      '</div>' +
      '<div class="mp-playback-bar">' +
      '<button type="button" class="spc-btn spc-btn-primary" id="mpPlay">播放</button>' +
      '<button type="button" class="spc-btn" id="mpStep">单步</button>' +
      '<button type="button" class="spc-btn" id="mpResetCursor">归零</button>' +
      '<label class="mp-slider-wrap" for="mpTimeSlider"><span>时刻 t</span>' +
      '<input type="range" id="mpTimeSlider" min="0" max="1000" value="0" aria-label="轨迹时间游标"></label>' +
      '<span class="mp-time-readout" id="mpTimeReadout">t = 0.000 s</span>' +
      '</div>' +
      '<dl class="spc-stats" id="mpCursorStats"></dl>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">规划对比与未修正终点残差</h2>' +
      '<div class="mp-table-wrap"><table class="spc-table mp-table">' +
      '<caption class="spc-visually-hidden">梯形与七段 S 曲线指标及终点残差对比</caption>' +
      '<thead><tr><th scope="col">指标</th><th scope="col">七段 S 曲线</th><th scope="col">梯形规划</th></tr></thead>' +
      '<tbody id="mpCompareBody"></tbody>' +
      '</table></div>' +
      '<p class="spc-chart-note" id="mpCompareNote"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">S 曲线分段时长与边界状态</h2>' +
      '<div class="mp-table-wrap"><table class="spc-table mp-table">' +
      '<caption class="spc-visually-hidden">七段 S 曲线各段起止时间与边界运动学状态</caption>' +
      '<thead><tr><th scope="col">段</th><th scope="col">时长 Δt (s)</th><th scope="col">t₀ → t₁ (s)</th><th scope="col">Jerk</th><th scope="col">段末速度 v</th><th scope="col">段末加速度 a</th></tr></thead>' +
      '<tbody id="mpSegBody"></tbody>' +
      '</table></div>' +
      '</section>' +

      '</div>' +
      '<aside class="spc-side">' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">典型工况预设</h2>' +
      '<label class="spc-field-label" for="mpScene">选择预设工况</label>' +
      '<select id="mpScene" class="spc-select">' +
      scenes.map(function (sc) {
        return '<option value="' + esc(sc.id) + '">' + esc(sc.name) + '</option>';
      }).join('') +
      '</select>' +
      '<p class="spc-hint" id="mpSceneNote"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">运动约束参数</h2>' +
      '<div class="mp-form-grid">' +
      '<label class="spc-field-label" for="mpQ0">起点 q₀</label>' +
      '<input id="mpQ0" class="spc-input" type="number" step="any" value="0">' +
      '<label class="spc-field-label" for="mpQ1">终点 q₁</label>' +
      '<input id="mpQ1" class="spc-input" type="number" step="any" value="120">' +
      '<label class="spc-field-label" for="mpVMax">最大速度 vMax (&gt; 0)</label>' +
      '<input id="mpVMax" class="spc-input" type="number" step="any" value="40">' +
      '<label class="spc-field-label" for="mpAMax">最大加速度 aMax (&gt; 0)</label>' +
      '<input id="mpAMax" class="spc-input" type="number" step="any" value="80">' +
      '<label class="spc-field-label" for="mpJMax">最大加加速度 jMax (&gt; 0)</label>' +
      '<input id="mpJMax" class="spc-input" type="number" step="any" value="400">' +
      '</div>' +
      '<div class="mp-btn-row">' +
      '<button type="button" class="spc-btn spc-btn-primary" id="mpApply">计算规划</button>' +
      '<button type="button" class="spc-btn" id="mpReset">恢复预设</button>' +
      '</div>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">曲线显示</h2>' +
      '<div class="mp-radio-group" role="radiogroup" aria-label="曲线显示模式">' +
      '<label class="spc-radio"><input type="radio" name="mpView" id="mpViewBoth" value="both" checked> 同时对比</label>' +
      '<label class="spc-radio"><input type="radio" name="mpView" id="mpViewSCurve" value="scurve"> 仅 S 曲线</label>' +
      '<label class="spc-radio"><input type="radio" name="mpView" id="mpViewTrap" value="trap"> 仅梯形</label>' +
      '</div>' +
      '<p class="spc-hint">梯形规划的加加速度在分段切换处为理想冲激，图表中以分段平台区间参考展示。</p>' +
      '</section>' +

      '</aside>' +
      '</div>' +
      '</div>';
  }

  function mount(root) {
    unmount();
    if (!root) return;
    var MP = global.MotionProfile;
    if (!MP) return;

    var state = {
      root: root,
      sceneId: 'full-7seg',
      viewMode: 'both',
      params: { q0: 0, q1: 120, vMax: 40, aMax: 80, jMax: 400 },
      result: null,
      planCount: 0,
      cursorTime: 0,
      playing: false,
      rafId: 0,
      lastTick: 0,
      destroyed: false,
      lastError: ''
    };

    function $(id) { return root.querySelector('#' + id); }

    function setError(msg) {
      state.lastError = msg || '';
      var el = $('mpError');
      if (el) el.textContent = state.lastError;
    }

    function syncInputsFromParams() {
      $('mpQ0').value = String(state.params.q0);
      $('mpQ1').value = String(state.params.q1);
      $('mpVMax').value = String(state.params.vMax);
      $('mpAMax').value = String(state.params.aMax);
      $('mpJMax').value = String(state.params.jMax);
    }

    function readInputs() {
      var q0 = Number($('mpQ0').value);
      var q1 = Number($('mpQ1').value);
      var vMax = Number($('mpVMax').value);
      var aMax = Number($('mpAMax').value);
      var jMax = Number($('mpJMax').value);
      if ($('mpQ0').value.trim() === '' || $('mpQ1').value.trim() === '' ||
          $('mpVMax').value.trim() === '' || $('mpAMax').value.trim() === '' ||
          $('mpJMax').value.trim() === '') {
        return { ok: false, message: '请填写完整的数值参数，不能为空。' };
      }
      return { ok: true, params: { q0: q0, q1: q1, vMax: vMax, aMax: aMax, jMax: jMax } };
    }

    function stopPlay() {
      state.playing = false;
      if (state.rafId) {
        global.cancelAnimationFrame(state.rafId);
        state.rafId = 0;
      }
      var btn = $('mpPlay');
      if (btn) btn.textContent = '播放';
    }

    function drawChart(svgId, key, sPts, tPts, tMax, limitAbs, showS, showT) {
      var svg = $(svgId);
      if (!svg) return;
      var W = 560, H = 150, padL = 46, padR = 14, padT = 12, padB = 22;
      var plotW = W - padL - padR;
      var plotH = H - padT - padB;

      var vals = [];
      if (showS) sPts.forEach(function (pt) { vals.push(pt[key]); });
      if (showT) tPts.forEach(function (pt) { if (isFinite(pt[key])) vals.push(pt[key]); });
      if (limitAbs !== null && limitAbs !== undefined && isFinite(limitAbs)) {
        vals.push(limitAbs);
        vals.push(-limitAbs);
      }
      vals.push(0);

      var yMin = Math.min.apply(null, vals);
      var yMax = Math.max.apply(null, vals);
      if (Math.abs(yMax - yMin) < 1e-9) {
        yMin -= 1;
        yMax += 1;
      } else {
        var span = yMax - yMin;
        yMin -= span * 0.08;
        yMax += span * 0.08;
      }

      var tx = function (t) {
        if (tMax <= 0) return padL;
        return padL + (Math.min(Math.max(t, 0), tMax) / tMax) * plotW;
      };
      var ty = function (y) {
        return padT + ((yMax - y) / (yMax - yMin)) * plotH;
      };

      var html = '';
      // 零线与网格
      var y0 = ty(0);
      html += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" class="mp-axis"/>';
      html += '<line x1="' + padL + '" y1="' + y0.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y0.toFixed(1) + '" class="mp-axis-zero"/>';

      // 约束上下界
      if (limitAbs !== null && limitAbs !== undefined && isFinite(limitAbs) && limitAbs > 0) {
        var yp = ty(limitAbs).toFixed(1);
        var yn = ty(-limitAbs).toFixed(1);
        html += '<line x1="' + padL + '" y1="' + yp + '" x2="' + (W - padR) + '" y2="' + yp + '" class="mp-limit-line"/>';
        html += '<line x1="' + padL + '" y1="' + yn + '" x2="' + (W - padR) + '" y2="' + yn + '" class="mp-limit-line"/>';
      }

      function buildPath(pts) {
        if (!pts.length) return '';
        return pts.map(function (pt, idx) {
          var v = isFinite(pt[key]) ? pt[key] : 0;
          return (idx === 0 ? 'M' : 'L') + tx(pt.t).toFixed(2) + ',' + ty(v).toFixed(2);
        }).join(' ');
      }

      if (showT && tPts.length && key !== 'j') {
        html += '<path d="' + buildPath(tPts) + '" class="mp-curve-trap" fill="none"/>';
      }
      if (showS && sPts.length) {
        html += '<path d="' + buildPath(sPts) + '" class="mp-curve-scurve" fill="none"/>';
      }

      // 时间游标
      var cx = tx(state.cursorTime).toFixed(2);
      html += '<line x1="' + cx + '" y1="' + padT + '" x2="' + cx + '" y2="' + (H - padB) + '" class="mp-cursor-line"/>';

      // Y 轴刻度标签
      html += '<text x="' + (padL - 5) + '" y="' + (padT + 8) + '" class="mp-tick-y">' + fmt(yMax, 1) + '</text>';
      html += '<text x="' + (padL - 5) + '" y="' + (H - padB) + '" class="mp-tick-y">' + fmt(yMin, 1) + '</text>';
      html += '<text x="' + padL + '" y="' + (H - 6) + '" class="mp-tick-x">0</text>';
      html += '<text x="' + (W - padR) + '" y="' + (H - 6) + '" class="mp-tick-x-end">' + fmt(tMax, 2) + 's</text>';

      svg.innerHTML = html;
    }

    function renderCursorAndCharts() {
      var res = state.result;
      if (!res || !res.ok) return;
      var sc = res.scurve;
      var tr = res.trapezoidal;
      var tMax = Math.max(sc.totalTime, tr.totalTime);

      var sPts = MP.sampleProfile(sc, 220);
      var tPts = MP.sampleProfile(tr, 220);
      var showS = state.viewMode === 'both' || state.viewMode === 'scurve';
      var showT = state.viewMode === 'both' || state.viewMode === 'trap';

      drawChart('mpChartPos', 'q', sPts, tPts, tMax, null, showS, showT);
      drawChart('mpChartVel', 'v', sPts, tPts, tMax, res.vMax, showS, showT);
      drawChart('mpChartAcc', 'a', sPts, tPts, tMax, res.aMax, showS, showT);
      drawChart('mpChartJerk', 'j', sPts, tPts, tMax, res.jMax, showS, false);

      var slider = $('mpTimeSlider');
      if (slider) {
        slider.value = tMax > 0 ? String(Math.round((state.cursorTime / tMax) * 1000)) : '0';
      }
      var readout = $('mpTimeReadout');
      if (readout) {
        readout.textContent = 't = ' + fmt(state.cursorTime, 3) + ' s / ' + fmt(tMax, 3) + ' s';
      }

      var sNow = MP.evaluateProfile(sc, Math.min(state.cursorTime, sc.totalTime));
      var tNow = MP.evaluateProfile(tr, Math.min(state.cursorTime, tr.totalTime));
      var stats = $('mpCursorStats');
      if (stats && sNow && tNow) {
        stats.innerHTML =
          '<div class="spc-stat"><dt>S 曲线当前段</dt><dd>' + esc(sNow.segmentLabel) + '</dd></div>' +
          '<div class="spc-stat"><dt>S 曲线 q / v</dt><dd>' + fmt(sNow.q, 3) + ' / ' + fmt(sNow.v, 3) + '</dd></div>' +
          '<div class="spc-stat"><dt>S 曲线 a / j</dt><dd>' + fmt(sNow.a, 3) + ' / ' + fmt(sNow.j, 1) + '</dd></div>' +
          '<div class="spc-stat"><dt>梯形当前段</dt><dd>' + esc(tNow.segmentLabel) + '</dd></div>' +
          '<div class="spc-stat"><dt>梯形 q / v / a</dt><dd>' + fmt(tNow.q, 3) + ' / ' + fmt(tNow.v, 3) + ' / ' + fmt(tNow.a, 3) + '</dd></div>';
      }
    }

    function renderTables() {
      var res = state.result;
      if (!res || !res.ok) return;
      var sc = res.scurve;
      var tr = res.trapezoidal;

      var tbody = $('mpCompareBody');
      if (tbody) {
        var rows = [
          ['退化形态', sc.regimeLabel, tr.regimeLabel],
          ['总运动时长 T (s)', fmt(sc.totalTime, 4), fmt(tr.totalTime, 4)],
          ['峰值速度 |v|peak', fmt(sc.vPeak, 4), fmt(tr.vPeak, 4)],
          ['峰值加速度 |a|peak', fmt(sc.aPeak, 4), fmt(tr.aPeak, 4)],
          ['峰值加加速度 |j|peak', fmt(sc.jPeak, 2), '∞（分段阶跃）'],
          ['终点位置未修正残差 |q(T)-q₁|', fmtSci(sc.endPosResidual), fmtSci(tr.endPosResidual)],
          ['终点速度未修正残差 |v(T)|', fmtSci(sc.endVelResidual), fmtSci(tr.endVelResidual)],
          ['终点加速度未修正残差 |a(T)|', fmtSci(sc.endAccResidual), fmtSci(tr.endAccResidual)]
        ];
        tbody.innerHTML = rows.map(function (r) {
          return '<tr><th scope="row">' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
        }).join('');
      }

      var note = $('mpCompareNote');
      if (note) {
        note.textContent = 'S 曲线相对梯形增加平滑过渡耗时 ΔT = ' + fmt(res.timeDelta, 4) +
          ' s（比值 ' + fmt(res.timeRatio, 3) + '×），同时消除了加速度突变与无限加加速度冲击。';
      }

      var segBody = $('mpSegBody');
      if (segBody) {
        if (!sc.segments.length) {
          segBody.innerHTML = '<tr><td colspan="6">零位移（D = 0），无运动分段。</td></tr>';
        } else {
          segBody.innerHTML = sc.segments.map(function (seg) {
            var endV = sc.dir * (seg.v0 + seg.a0 * seg.dt + 0.5 * seg.j * seg.dt * seg.dt);
            var endA = sc.dir * (seg.a0 + seg.j * seg.dt);
            return '<tr>' +
              '<th scope="row">' + esc(seg.label) + '</th>' +
              '<td>' + fmt(seg.dt, 4) + '</td>' +
              '<td>' + fmt(seg.t0, 3) + ' → ' + fmt(seg.t1, 3) + '</td>' +
              '<td>' + fmt(sc.dir * seg.j, 1) + '</td>' +
              '<td>' + fmt(endV, 3) + '</td>' +
              '<td>' + fmt(endA, 3) + '</td>' +
              '</tr>';
          }).join('');
        }
      }
    }

    function solveAndRender(params) {
      var res = MP.compareProfiles(params);
      if (!res.ok) {
        stopPlay();
        setError(res.message);
        return false;
      }
      setError('');
      state.params = {
        q0: res.q0,
        q1: res.q1,
        vMax: res.vMax,
        aMax: res.aMax,
        jMax: res.jMax
      };
      state.result = res;
      state.planCount++;
      state.cursorTime = 0;
      stopPlay();
      renderTables();
      renderCursorAndCharts();
      return true;
    }

    function tick(now) {
      if (state.destroyed || !state.playing || !state.result) return;
      var tMax = Math.max(state.result.scurve.totalTime, state.result.trapezoidal.totalTime);
      if (tMax <= 0) {
        stopPlay();
        return;
      }
      if (!state.lastTick) state.lastTick = now;
      var dtSec = Math.min(0.1, (now - state.lastTick) / 1000);
      state.lastTick = now;
      state.cursorTime += dtSec;
      if (state.cursorTime >= tMax) {
        state.cursorTime = tMax;
        renderCursorAndCharts();
        stopPlay();
        return;
      }
      renderCursorAndCharts();
      state.rafId = global.requestAnimationFrame(tick);
    }

    function applyScene(id) {
      var list = MP.scenarioList();
      var found = list.find(function (s) { return s.id === id; }) || list[0];
      state.sceneId = found.id;
      var note = $('mpSceneNote');
      if (note) note.textContent = found.note;
      state.params = Object.assign({}, found.params);
      syncInputsFromParams();
      solveAndRender(state.params);
    }

    $('mpScene').addEventListener('change', function () {
      applyScene($('mpScene').value);
    });

    $('mpApply').addEventListener('click', function () {
      var parsed = readInputs();
      if (!parsed.ok) {
        stopPlay();
        setError(parsed.message);
        return;
      }
      solveAndRender(parsed.params);
    });

    $('mpReset').addEventListener('click', function () {
      applyScene(state.sceneId);
    });

    ['mpViewBoth', 'mpViewSCurve', 'mpViewTrap'].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.addEventListener('change', function () {
          if (el.checked) {
            state.viewMode = el.value;
            renderCursorAndCharts();
          }
        });
      }
    });

    $('mpPlay').addEventListener('click', function () {
      if (!state.result) return;
      if (state.playing) {
        stopPlay();
        return;
      }
      var tMax = Math.max(state.result.scurve.totalTime, state.result.trapezoidal.totalTime);
      if (tMax <= 0) return;
      if (state.cursorTime >= tMax - 1e-6) state.cursorTime = 0;
      state.playing = true;
      state.lastTick = 0;
      $('mpPlay').textContent = '暂停';
      state.rafId = global.requestAnimationFrame(tick);
    });

    $('mpStep').addEventListener('click', function () {
      if (!state.result) return;
      stopPlay();
      var tMax = Math.max(state.result.scurve.totalTime, state.result.trapezoidal.totalTime);
      if (tMax <= 0) return;
      state.cursorTime = Math.min(tMax, state.cursorTime + tMax / 20);
      renderCursorAndCharts();
    });

    $('mpResetCursor').addEventListener('click', function () {
      stopPlay();
      state.cursorTime = 0;
      renderCursorAndCharts();
    });

    $('mpTimeSlider').addEventListener('input', function () {
      if (!state.result) return;
      stopPlay();
      var tMax = Math.max(state.result.scurve.totalTime, state.result.trapezoidal.totalTime);
      state.cursorTime = (Number($('mpTimeSlider').value) / 1000) * tMax;
      renderCursorAndCharts();
    });

    _current = state;
    applyScene('full-7seg');
  }

  function unmount() {
    if (!_current) return;
    _current.destroyed = true;
    if (_current.rafId) {
      global.cancelAnimationFrame(_current.rafId);
      _current.rafId = 0;
    }
    _current.playing = false;
    _current = null;
  }

  function getState(root) {
    if (!_current || (root && _current.root !== root)) return null;
    var r = _current.result;
    return {
      sceneId: _current.sceneId,
      viewMode: _current.viewMode,
      planCount: _current.planCount,
      cursorTime: _current.cursorTime,
      playing: _current.playing,
      lastError: _current.lastError,
      scurveRegime: r && r.ok ? r.scurve.regime : null,
      trapRegime: r && r.ok ? r.trapezoidal.regime : null,
      scurveTotalTime: r && r.ok ? r.scurve.totalTime : null,
      trapTotalTime: r && r.ok ? r.trapezoidal.totalTime : null,
      scurveEndPosResidual: r && r.ok ? r.scurve.endPosResidual : null,
      scurveEndVelResidual: r && r.ok ? r.scurve.endVelResidual : null,
      scurveEndAccResidual: r && r.ok ? r.scurve.endAccResidual : null
    };
  }

  var api = {
    renderPage: renderPage,
    mount: mount,
    unmount: unmount,
    getState: getState
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.MotionProfileDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
