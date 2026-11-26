/* 二维栅格路径规划 —— 交互 UI（SVG，无第三方图形库）
 *
 * 设计要点：
 *   1. 计算与回放解耦：按下"开始规划"时一次性算完两个算法并记录搜索轨迹，
 *      播放只推进光标、重绘状态，绝不参与算法计算，因此播放速度不影响结果与耗时。
 *   2. 地图编辑（障碍/地形/起终点）一律先使旧结果失效并停止回放，避免展示过期路径。
 *   3. 路由离开时销毁定时器、事件监听与拖动状态（unmount/destroy 幂等）。
 *   4. 颜色不是唯一信息通道：障碍物有斜纹、高代价地形有点阵与权重数字、
 *      Open/Closed 用空心/实心区分、起终点带 S/G 字母。
 */
(function (global) {
  'use strict';

  var PP = null;
  var _current = null;     // 当前挂载的实例，供路由离开时统一清理

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var d = digits === undefined ? 3 : digits;
    return Number(v).toFixed(d);
  }

  function toolLabel(tool) {
    if (tool === 'block') return '障碍物';
    if (tool === 'cost') return '高代价地形';
    if (tool === 'start') return '起点';
    if (tool === 'goal') return '终点';
    return '清除';
  }

  function renderPage() {
    var P = global.PathPlanning;
    var scenarios = P.scenarioList();
    return '<div id="ppDemoRoot">' +
      '<p class="spc-mode-line"><strong id="ppModeLabel">二维栅格路径规划</strong>' +
      '<span class="spc-mode-hint">（全局静态规划：Dijkstra 与 A* 在同一地图、同一运动约束、同一代价模型下比较；全部计算在本机完成）</span></p>' +
      '<p class="spc-error" id="ppError" aria-live="polite"></p>' +
      '<div class="spc-layout">' +
      '<div class="spc-main">' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">栅格地图与搜索过程</h2>' +
      '<div class="pp-grid-wrap"><svg id="ppGrid" class="pp-grid" tabindex="0" role="application" ' +
      'aria-describedby="ppGridHelp" aria-label="可编辑栅格地图：方向键移动光标，回车或空格应用当前工具"></svg></div>' +
      '<p class="spc-visually-hidden" id="ppGridHelp">这是一个二维栅格地图编辑器。用方向键移动光标，' +
      '回车或空格应用左侧选中的工具；也可以用鼠标或手指点击、拖动绘制。行列坐标以左上角为第 0 行第 0 列。</p>' +
      '<div class="pp-legend" id="ppLegend"></div>' +
      '<p class="spc-chart-note" id="ppStatus" aria-live="polite"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">当前步（回放，不参与计算）</h2>' +
      '<dl class="spc-stats" id="ppStepBody"></dl>' +
      '<p class="spc-hint" id="ppStepNote"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">算法对比：同一地图 / 同一代价模型</h2>' +
      '<div class="spc-table-wrap"><table class="spc-cap-table">' +
      '<caption class="spc-visually-hidden">Dijkstra 与 A* 在同一地图上的搜索指标</caption>' +
      '<thead><tr><th scope="col">指标</th><th scope="col">Dijkstra</th><th scope="col">A*</th></tr></thead>' +
      '<tbody id="ppCompareBody"></tbody></table></div>' +
      '<p class="spc-cap-note" id="ppCompareNote"></p>' +
      '</section>' +

      '<section class="spc-card">' +
      '<h2 class="spc-card-title">路径（行,列）与代价复核</h2>' +
      '<p class="pp-path-text" id="ppPathText"></p>' +
      '<p class="spc-cap-note" id="ppPathNote"></p>' +
      '</section>' +

      '</div>' +
      '<aside class="spc-panel">' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">地图工具</span>' +
      '<div class="spc-modes" role="radiogroup" aria-label="地图编辑工具">' +
      '<label class="spc-radio"><input type="radio" name="ppTool" id="ppToolBlock" value="block" checked><span>障碍物</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppTool" id="ppToolCost" value="cost"><span>高代价地形</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppTool" id="ppToolStart" value="start"><span>起点</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppTool" id="ppToolGoal" value="goal"><span>终点</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppTool" id="ppToolErase" value="erase"><span>清除该格</span></label>' +
      '</div>' +
      '<label class="spc-input-label" for="ppWeight">地形权重（≥ 1）<input id="ppWeight" type="number" min="1" max="1000000" step="1" value="5"></label>' +
      '<p class="spc-hint" id="ppWeightNote">权重是有限正数且不小于 1；非法值会被拒绝，不会静默夹取。</p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">运动模型与启发函数</span>' +
      '<div class="spc-modes" role="radiogroup" aria-label="运动模型">' +
      '<label class="spc-radio"><input type="radio" name="ppNbh" id="ppNbh4" value="4"><span>四邻域（正交，代价 1）</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppNbh" id="ppNbh8" value="8" checked><span>八邻域（对角代价 √2）</span></label>' +
      '</div>' +
      '<label class="spc-input-label" for="ppHeuristic">A* 启发函数<select id="ppHeuristic"></select></label>' +
      '<p class="spc-hint" id="ppHeuristicNote"></p>' +
      '<p class="spc-hint">八邻域下禁用 Manhattan：对角实际代价 √2 而 Manhattan 记 2，会高估而失去最优性。</p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">算法</span>' +
      '<div class="spc-modes" role="radiogroup" aria-label="规划算法">' +
      '<label class="spc-radio"><input type="radio" name="ppAlgo" id="ppAlgoD" value="dijkstra"><span>Dijkstra（零启发，按 g 扩展）</span></label>' +
      '<label class="spc-radio"><input type="radio" name="ppAlgo" id="ppAlgoA" value="astar" checked><span>A*（f = g + h）</span></label>' +
      '</div>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">推进</span>' +
      '<button type="button" id="ppRun" class="spc-btn">开始规划</button>' +
      '<div class="spc-btn-row"><button type="button" id="ppStep" class="spc-btn">单步搜索</button>' +
      '<button type="button" id="ppReset" class="spc-btn">重置搜索</button></div>' +
      '<div class="spc-btn-row"><button type="button" id="ppPlay" class="spc-btn">自动播放</button>' +
      '<button type="button" id="ppPause" class="spc-btn">暂停</button></div>' +
      '<label class="spc-input-label" for="ppSpeed">播放速度（1 慢 – 10 快）<input id="ppSpeed" type="range" min="1" max="10" step="1" value="5"></label>' +
      '<p class="spc-baseline-state" id="ppProgress">0 / 0 步</p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">地图</span>' +
      '<div class="spc-btn-row"><button type="button" id="ppClear" class="spc-btn">清空地图</button>' +
      '<button type="button" id="ppDefault" class="spc-btn">恢复默认</button></div>' +
      '<div class="spc-btn-row"><button type="button" id="ppRandom" class="spc-btn">随机地图</button>' +
      '<label class="spc-input-label" for="ppSeed">种子<input id="ppSeed" type="number" step="1" value="20261126"></label></div>' +
      '<p class="spc-hint">随机地图使用固定种子，可复现。地图上限 80×80。</p>' +
      '</div>' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">教学场景（合成数据）</span>' +
      '<label class="spc-input-label" for="ppScene">场景<select id="ppScene">' +
      scenarios.map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
      }).join('') +
      '</select></label>' +
      '<p class="spc-example-note" id="ppSceneNote"></p>' +
      '</div>' +

      '<div class="spc-explain">' +
      '<p><strong>代价</strong>：cost(u,v) = 基础距离 × 目标格权重；基础距离为 1（正交）或 √2（对角）。</p>' +
      '<p><strong>运动</strong>：四邻域 / 八邻域；对角移动要求两个正交伴随格都可通行。</p>' +
      '<p><strong>启发</strong>：h = metric × 最小可通行权重，因此可采纳且一致。</p>' +
      '<p><strong>限制</strong>：只做全局静态规划，不含动态避障、SLAM、多机器人调度；地图全部是合成教学数据。</p>' +
      '</div>' +

      '</aside></div>' +
      '<p class="spc-visually-hidden" id="ppLive" aria-live="polite"></p>' +
      '</div>';
  }

  function mount(root) {
    var P = global.PathPlanning;
    if (!root || !P) return null;
    PP = P;

    var state = {
      grid: null,
      rows: 0,
      cols: 0,
      cell: 20,
      start: 0,
      goal: 0,
      neighborhood: 8,
      heuristic: 'octile',
      algorithm: 'astar',
      tool: 'block',
      weight: P.DEFAULT_WEIGHT,
      scenarioId: P.DEFAULT_SCENARIO,
      cursor: 0,
      playing: false,
      compare: null,
      invalid: '',
      planCount: 0,
      computeCount: 0,
      mapVersion: 0,
      cursorCell: 0,
      destroyed: false
    };

    var listeners = [];
    var playTimer = 0;
    var dragging = false;
    var dragCell = -1;
    var overlay = {};          // idx -> SVG 元素
    var overlayCount = 0;
    var cellState = null;      // Uint8Array 0/1/2
    var appliedCursor = 0;     // 已应用到视图的光标位置
    var els = {};

    function $(id) { return root.querySelector('#' + id); }
    function on(el, ev, fn) {
      if (!el) return;
      el.addEventListener(ev, fn);
      listeners.push([el, ev, fn]);
    }
    function setError(msg) {
      var el = $('ppError');
      if (el) el.textContent = msg || '';
      if (msg) setLive(msg);
    }
    function setLive(msg) {
      var el = $('ppLive');
      if (el) el.textContent = msg;
    }
    function setStatus(msg) {
      var el = $('ppStatus');
      if (el) el.textContent = msg || '';
    }
    function setProgress() {
      var el = $('ppProgress');
      if (!el) return;
      var total = state.compare ? active().trace.length : 0;
      el.textContent = state.cursor + ' / ' + total + ' 步';
    }
    function active() {
      return state.algorithm === 'dijkstra' ? state.compare.dijkstra : state.compare.astar;
    }

    function readWeight() {
      var el = $('ppWeight');
      if (!el) return { ok: false, error: 'invalid-weight' };
      var raw = String(el.value).trim();
      var v = raw === '' ? NaN : Number(raw);
      if (!isFinite(v) || v < 1 || v > P.LIMITS.maxWeight) {
        el.setAttribute('aria-invalid', 'true');
        return { ok: false, error: 'invalid-weight' };
      }
      el.removeAttribute('aria-invalid');
      return { ok: true, value: v };
    }

    // ------------------------------------------------------------ 地图渲染

    function cellSizeFor(rows, cols) {
      var span = Math.max(rows, cols);
      var size = Math.floor(560 / span);
      return Math.max(12, Math.min(34, size));
    }

    function renderMap() {
      var svg = els.svg;
      if (!svg) return;
      var rows = state.rows, cols = state.cols, cell = state.cell;
      var w = cols * cell, h = rows * cell;
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      svg.setAttribute('aria-label',
        '可编辑栅格地图，' + rows + ' 行 ' + cols + ' 列。方向键移动光标，回车或空格应用当前工具。');

      var parts = [];
      parts.push('<defs>' +
        '<pattern id="ppHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
        '<line class="pp-hatch-line" x1="0" y1="0" x2="0" y2="8"></line></pattern>' +
        '<pattern id="ppDot" width="7" height="7" patternUnits="userSpaceOnUse">' +
        '<circle class="pp-dot-dot" cx="3.5" cy="3.5" r="1.1"></circle></pattern>' +
        '</defs>');

      parts.push('<g id="ppCellLayer">');
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var idx = r * cols + c;
          var cls = 'pp-cell';
          if (state.grid.blocked[idx]) cls += ' pp-cell--blocked';
          else if (state.grid.weights[idx] > 1) cls += ' pp-cell--cost';
          parts.push('<rect class="' + cls + '" x="' + (c * cell) + '" y="' + (r * cell) +
            '" width="' + cell + '" height="' + cell + '" data-i="' + idx + '"></rect>');
          if (cell >= 18 && !state.grid.blocked[idx] && state.grid.weights[idx] > 1) {
            parts.push('<text class="pp-cost-label" x="' + (c * cell + cell / 2) +
              '" y="' + (r * cell + cell / 2) + '" text-anchor="middle" dominant-baseline="central" ' +
              'font-size="' + Math.round(cell * 0.42) + '">' + esc(String(state.grid.weights[idx])) + '</text>');
          }
        }
      }
      parts.push('</g>');
      parts.push('<g id="ppStateLayer"></g>');
      parts.push('<g id="ppPathLayer"></g>');
      parts.push('<g id="ppMarkerLayer"></g>');
      parts.push('<g id="ppCursorLayer"></g>');
      svg.innerHTML = parts.join('');

      els.stateLayer = svg.querySelector('#ppStateLayer');
      els.pathLayer = svg.querySelector('#ppPathLayer');
      els.markerLayer = svg.querySelector('#ppMarkerLayer');
      els.cursorLayer = svg.querySelector('#ppCursorLayer');

      overlay = {};
      overlayCount = 0;
      cellState = new Uint8Array(rows * cols);
      appliedCursor = 0;
      state.mapVersion++;
      renderMarkers();
      renderCursorCell();
      renderLegend();
    }

    function renderLegend() {
      var host = $('ppLegend');
      if (!host) return;
      host.innerHTML =
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--block"></span>障碍物（斜纹）</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--cost"></span>高代价地形（点阵 + 权重数字）</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--open"></span>Open Set（已发现待扩展，空心）</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--closed"></span>Closed Set（已扩展，实心）</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--current"></span>当前扩展节点</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--path"></span>最终路径</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--start"></span>起点 S</span>' +
        '<span class="pp-legend-item"><span class="pp-swatch pp-swatch--goal"></span>终点 G</span>';
    }

    function centerOf(idx) {
      var cell = state.cell;
      return {
        x: (idx % state.cols) * cell + cell / 2,
        y: Math.floor(idx / state.cols) * cell + cell / 2
      };
    }

    function renderMarkers() {
      var layer = els.markerLayer;
      if (!layer) return;
      var cell = state.cell;
      var s = centerOf(state.start);
      var g = centerOf(state.goal);
      var out = [];
      out.push('<circle class="pp-start" cx="' + s.x + '" cy="' + s.y + '" r="' + (cell * 0.3) + '"></circle>');
      out.push('<text class="pp-marker-text" x="' + s.x + '" y="' + s.y + '" text-anchor="middle" ' +
        'dominant-baseline="central" font-size="' + Math.round(cell * 0.42) + '">S</text>');
      out.push('<circle class="pp-goal" cx="' + g.x + '" cy="' + g.y + '" r="' + (cell * 0.3) + '"></circle>');
      out.push('<text class="pp-marker-text" x="' + g.x + '" y="' + g.y + '" text-anchor="middle" ' +
        'dominant-baseline="central" font-size="' + Math.round(cell * 0.42) + '">G</text>');
      layer.innerHTML = out.join('');
    }

    function renderCursorCell() {
      var layer = els.cursorLayer;
      if (!layer) return;
      var cell = state.cell;
      var idx = state.cursorCell;
      var r = Math.floor(idx / state.cols), c = idx % state.cols;
      layer.innerHTML = '<rect class="pp-cursor" x="' + (c * cell + 1) + '" y="' + (r * cell + 1) +
        '" width="' + (cell - 2) + '" height="' + (cell - 2) + '"></rect>';
    }

    // ------------------------------------------------------------ 回放增量渲染

    function nsEl(tag) {
      return document.createElementNS('http://www.w3.org/2000/svg', tag);
    }

    function ensureOverlay(idx, kind) {
      var el = overlay[idx];
      if (!el) {
        el = nsEl('rect');
        el.setAttribute('class', 'pp-state');
        el.setAttribute('data-s', String(idx));
        els.stateLayer.appendChild(el);
        overlay[idx] = el;
        overlayCount++;
      }
      var cell = state.cell;
      var inset = kind === 'open' ? cell * 0.26 : cell * 0.18;
      var x = (idx % state.cols) * cell + inset;
      var y = Math.floor(idx / state.cols) * cell + inset;
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('width', String(cell - inset * 2));
      el.setAttribute('height', String(cell - inset * 2));
      el.setAttribute('class', 'pp-state ' + (kind === 'open' ? 'pp-state--open' : 'pp-state--closed'));
      return el;
    }

    function removeOverlay(idx) {
      var el = overlay[idx];
      if (!el) return;
      if (el.parentNode) el.parentNode.removeChild(el);
      delete overlay[idx];
      overlayCount--;
    }

    function applyStepForward(step) {
      cellState[step.node] = 2;
      ensureOverlay(step.node, 'closed');
      for (var i = 0; i < step.pushes.length; i++) {
        var p = step.pushes[i];
        if (cellState[p] === 2) continue;
        cellState[p] = 1;
        ensureOverlay(p, 'open');
      }
      ensureCurrent(step.node);
    }

    function ensureCurrent(idx) {
      var cell = state.cell;
      var existing = els.stateLayer.querySelector('.pp-current');
      if (!existing) {
        existing = nsEl('rect');
        existing.setAttribute('class', 'pp-current');
        els.stateLayer.appendChild(existing);
      }
      var r = Math.floor(idx / state.cols), c = idx % state.cols;
      existing.setAttribute('x', String(c * cell + 2));
      existing.setAttribute('y', String(r * cell + 2));
      existing.setAttribute('width', String(cell - 4));
      existing.setAttribute('height', String(cell - 4));
    }

    function resetReplayView() {
      for (var k in overlay) {
        if (Object.prototype.hasOwnProperty.call(overlay, k)) removeOverlay(Number(k));
      }
      overlay = {};
      overlayCount = 0;
      if (cellState) cellState.fill(0);
      appliedCursor = 0;
      if (els.stateLayer) els.stateLayer.innerHTML = '';
      if (els.pathLayer) els.pathLayer.innerHTML = '';
    }

    /* 只前进时逐条应用增量；需要后退时整体重放（代价小，语义清晰）。 */
    function renderTo(target) {
      var res = state.compare ? active() : null;
      if (!res) { resetReplayView(); return; }
      var trace = res.trace;
      if (target < appliedCursor) {
        resetReplayView();
      }
      for (var i = appliedCursor; i < target && i < trace.length; i++) {
        applyStepForward(trace[i]);
      }
      if (target === 0) {
        resetReplayView();
      }
      appliedCursor = Math.min(target, trace.length);
      renderPathLayer(target);
    }

    function renderPathLayer(target) {
      var layer = els.pathLayer;
      if (!layer) return;
      var res = state.compare ? active() : null;
      layer.innerHTML = '';
      if (!res || !res.found) return;
      if (target < res.trace.length) return;   // 搜索未结束前不揭示最终路径
      if (!res.path || res.path.length < 2) return;
      var pts = [];
      for (var i = 0; i < res.path.length; i++) {
        var p = centerOf(res.path[i]);
        pts.push(p.x + ',' + p.y);
      }
      var d = pts.join(' ');
      layer.innerHTML =
        '<polyline class="pp-path-halo" points="' + d + '"></polyline>' +
        '<polyline class="pp-path" points="' + d + '"></polyline>';
    }

    // ------------------------------------------------------------ 指标与文案

    function renderStepInfo() {
      var host = $('ppStepBody');
      var note = $('ppStepNote');
      if (!host) return;
      var res = state.compare ? active() : null;
      if (!res) {
        host.innerHTML = '<dt>状态</dt><dd>尚未规划（地图或参数变化后需要重新规划）</dd>';
        if (note) note.textContent = '';
        return;
      }
      if (state.cursor === 0) {
        host.innerHTML = '<dt>状态</dt><dd>已规划，回放在起点（点击「单步搜索」或「自动播放」）</dd>' +
          '<dt>目标算法</dt><dd>' + esc(state.algorithm === 'dijkstra' ? 'Dijkstra' : 'A*（' + res.heuristic + '）') + '</dd>';
        if (note) note.textContent = '';
        return;
      }
      var i = Math.min(state.cursor, res.trace.length) - 1;
      var st = res.trace[i];
      var r = Math.floor(st.node / state.cols), c = st.node % state.cols;
      var rows = [
        ['第几步', (i + 1) + ' / ' + res.trace.length],
        ['扩展节点', '第 ' + r + ' 行，第 ' + c + ' 列（索引 ' + st.node + '）'],
        ['累计代价 g', fmt(st.g, 6)],
        ['启发值 h', res.algorithm === 'dijkstra' ? '0（Dijkstra 无启发）' : fmt(st.h, 6)],
        ['优先级 f = g + h', fmt(st.f, 6)],
        ['Open Set 大小', String(st.openSize)],
        ['Closed Set 大小', String(st.closedSize)],
        ['本步入队/更新', String(st.pushes.length)]
      ];
      host.innerHTML = rows.map(function (row) {
        return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
      }).join('');
      if (note) {
        note.textContent = res.algorithm === 'dijkstra'
          ? 'Dijkstra 的优先级只有 g，等价于零启发函数；它在终点以最小 g 出队时结束。'
          : 'A* 的优先级是 f = g + h；h 按最小可通行权重缩放，保证不高估。';
      }
    }

    function renderCompare() {
      var body = $('ppCompareBody');
      var note = $('ppCompareNote');
      if (!body) return;
      var rows;
      if (!state.compare) {
        body.innerHTML = '<tr><td colspan="3">尚未规划</td></tr>';
        if (note) note.textContent = '';
        return;
      }
      var d = state.compare.dijkstra;
      var a = state.compare.astar;
      function cell(res, key, digits) {
        if (!res) return '—';
        if (key === 'found') return res.found ? '是' : '否（不可达）';
        if (key === 'heuristic') return res.algorithm === 'dijkstra' ? '无（零启发）' : (res.heuristic || '—');
        var v = res[key];
        if (v === null || v === undefined) return '—';
        return typeof v === 'number' ? fmt(v, digits === undefined ? 3 : digits) : String(v);
      }
      rows = [
        ['是否找到路径', cell(d, 'found'), cell(a, 'found')],
        ['路径总代价（加权）', cell(d, 'cost', 6), cell(a, 'cost', 6)],
        ['几何路径长度（不含权重）', cell(d, 'geometricLength', 6), cell(a, 'geometricLength', 6)],
        ['路径节点数量', cell(d, 'pathNodes'), cell(a, 'pathNodes')],
        ['扩展节点数量', cell(d, 'expandedNodes'), cell(a, 'expandedNodes')],
        ['唯一发现节点数量', cell(d, 'discoveredNodes'), cell(a, 'discoveredNodes')],
        ['入队/松弛次数', cell(d, 'relaxedEdges'), cell(a, 'relaxedEdges')],
        ['峰值 Open Set', cell(d, 'maxOpen'), cell(a, 'maxOpen')],
        ['运行时间（ms，仅搜索）', cell(d, 'timeMs', 3), cell(a, 'timeMs', 3)],
        ['启发函数', cell(d, 'heuristic'), cell(a, 'heuristic')]
      ];
      body.innerHTML = rows.map(function (row) {
        return '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + esc(row[1]) + '</td><td>' + esc(row[2]) + '</td></tr>';
      }).join('');
      if (note) {
        var truncated = !!(d && d.traceTruncated) || !!(a && a.traceTruncated);
        note.textContent = '扩展节点 = 从优先队列出队并处理的节点；发现节点 = 曾获得有限 g 的节点（含尚未扩展）。' +
          '运行时间只统计搜索循环，不含 DOM 绘制与回放等待。' +
          (truncated ? ' 回放记录已裁剪到上限（不影响最终路径与扩展节点统计）。' : '') +
          (state.compare.dijkstra.found && state.compare.astar.found
            ? (state.compare.sameCost
              ? ' 两个算法的最优代价一致（同一地图与代价模型），路径形状可以不同。'
              : ' 警告：两个算法代价不一致，属于实现错误。')
            : '') +
          ' 单次耗时只代表当前地图与设备，不能据此推断普遍加速倍数。';
      }
    }

    function renderPathText() {
      var el = $('ppPathText');
      var note = $('ppPathNote');
      if (!el) return;
      var res = state.compare ? active() : null;
      if (!res) {
        el.textContent = '尚未规划。';
        if (note) note.textContent = '';
        return;
      }
      if (!res.found) {
        el.textContent = '终点不可达：搜索已扩展全部可达区域，没有可用路径。';
        if (note) note.textContent = '不可达时不会绘制半截路径；扩展节点数仍完整记录。';
        return;
      }
      var parts = [];
      for (var i = 0; i < res.path.length; i++) {
        parts.push('(' + Math.floor(res.path[i] / state.cols) + ',' + (res.path[i] % state.cols) + ')');
      }
      el.textContent = parts.length > 60
        ? parts.slice(0, 60).join(' → ') + ' → …（共 ' + parts.length + ' 个节点）'
        : parts.join(' → ');
      if (note) {
        note.textContent = '独立重算的路径代价 = ' + fmt(P.pathCost(state.grid, res.path), 6) +
          '；搜索返回的累计代价 = ' + fmt(res.cost, 6) +
          '；几何长度 = ' + fmt(res.geometricLength, 6) + '（几何长度不含地形权重）。';
      }
    }

    // ------------------------------------------------------------ 规划与失效

    function stopPlay() {
      state.playing = false;
      if (playTimer) { clearTimeout(playTimer); playTimer = 0; }
    }

    function invalidate(reason) {
      stopPlay();
      state.compare = null;
      state.invalid = reason || '结果已失效';
      state.cursor = 0;
      resetReplayView();
      renderStepInfo();
      renderCompare();
      renderPathText();
      setProgress();
      setStatus(state.invalid + '：请点击「开始规划」重新计算。');
    }

    function plan() {
      stopPlay();
      setError('');
      var res = P.compare(state.grid, {
        start: state.start,
        goal: state.goal,
        neighborhood: state.neighborhood,
        heuristic: state.heuristic
      });
      if (!res.ok) {
        state.compare = null;
        state.cursor = 0;
        resetReplayView();
        renderStepInfo();
        renderCompare();
        renderPathText();
        setProgress();
        setStatus('');
        setError(res.message || '规划失败');
        return false;
      }
      state.compare = res;
      state.invalid = '';
      state.planCount++;
      state.computeCount++;
      var act = active();
      state.cursor = act.trace.length;
      resetReplayView();
      renderTo(state.cursor);
      renderStepInfo();
      renderCompare();
      renderPathText();
      setProgress();
      var d = res.dijkstra, a = res.astar;
      if (!d.found) {
        setStatus('规划完成：终点不可达。可达区域已全部扩展（' + d.expandedNodes + ' 个节点），没有路径可显示。');
      } else if (d.pathNodes === 1) {
        setStatus('规划完成：起点与终点相同，代价 0，无需搜索。');
      } else {
        setStatus('规划完成：最优代价 ' + fmt(d.cost, 6) + '（两个算法一致）；路径 ' +
          d.pathNodes + ' 个节点。扩展节点 Dijkstra ' + d.expandedNodes + ' / A* ' + a.expandedNodes +
          '。点击「重置搜索」可从第 0 步重放。');
      }
      return true;
    }

    function recompute(reason) {
      invalidate(reason);
      plan();
    }

    // ------------------------------------------------------------ 编辑

    function setStart(idx) {
      if (state.grid.blocked[idx]) {
        setError('起点不能设在障碍物上。');
        return false;
      }
      if (idx === state.goal) {
        setError('起点与终点不能是同一个格子。');
        return false;
      }
      state.start = idx;
      state.cursorCell = idx;
      renderMarkers();
      renderCursorCell();
      invalidate('起点已修改');
      setLive('起点设为第 ' + Math.floor(idx / state.cols) + ' 行第 ' + (idx % state.cols) + ' 列。');
      return true;
    }

    function setGoal(idx) {
      if (state.grid.blocked[idx]) {
        setError('终点不能设在障碍物上。');
        return false;
      }
      if (idx === state.start) {
        setError('起点与终点不能是同一个格子。');
        return false;
      }
      state.goal = idx;
      state.cursorCell = idx;
      renderMarkers();
      renderCursorCell();
      invalidate('终点已修改');
      setLive('终点设为第 ' + Math.floor(idx / state.cols) + ' 行第 ' + (idx % state.cols) + ' 列。');
      return true;
    }

    function applyTool(idx) {
      if (idx < 0 || idx >= state.grid.size) return;
      state.cursorCell = idx;
      renderCursorCell();
      var tool = state.tool;
      if (tool === 'start') { setStart(idx); return; }
      if (tool === 'goal') { setGoal(idx); return; }
      if (tool === 'block') {
        if (idx === state.start || idx === state.goal) {
          setError('不能把起点或终点改成障碍物。');
          return;
        }
        if (state.grid.blocked[idx]) return;   // 拖动时避免重复处理
        P.setBlocked(state.grid, idx, true);
        setError('');
        renderMapCellsOnly();
        invalidate('地图已修改');
        return;
      }
      if (tool === 'cost') {
        var w = readWeight();
        if (!w.ok) {
          // 非法权重不修改地图，也不产生新结果；旧结果仍然对应未改动的地图
          setError(P.ERROR_TEXT['invalid-weight']);
          return;
        }
        state.weight = w.value;
        if (state.grid.blocked[idx]) {
          setError('障碍物上不能设置地形权重，请先清除该格。');
          return;
        }
        P.setWeight(state.grid, idx, w.value);
        setError('');
        renderMapCellsOnly();
        invalidate('地图已修改');
        return;
      }
      // erase
      P.clearCell(state.grid, idx);
      setError('');
      renderMapCellsOnly();
      invalidate('地图已修改');
    }

    /* 只更新格子外观与权重数字：不需要重建整个 SVG（避免拖动时闪烁与重排）。 */
    function renderMapCellsOnly() {
      var svg = els.svg;
      if (!svg) return;
      var rects = svg.querySelectorAll('.pp-cell');
      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        var idx = Number(rect.getAttribute('data-i'));
        var cls = 'pp-cell';
        if (state.grid.blocked[idx]) cls += ' pp-cell--blocked';
        else if (state.grid.weights[idx] > 1) cls += ' pp-cell--cost';
        if (rect.getAttribute('class') !== cls) rect.setAttribute('class', cls);
      }
      // 权重数字：整层重绘（数量有限）
      var labels = svg.querySelectorAll('.pp-cost-label');
      for (var k = 0; k < labels.length; k++) {
        if (labels[k].parentNode) labels[k].parentNode.removeChild(labels[k]);
      }
      if (state.cell >= 18) {
        var layer = svg.querySelector('#ppCellLayer');
        var cell = state.cell;
        for (var j = 0; j < state.grid.size; j++) {
          if (state.grid.blocked[j] || state.grid.weights[j] <= 1) continue;
          var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('class', 'pp-cost-label');
          t.setAttribute('x', String((j % state.cols) * cell + cell / 2));
          t.setAttribute('y', String(Math.floor(j / state.cols) * cell + cell / 2));
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('dominant-baseline', 'central');
          t.setAttribute('font-size', String(Math.round(cell * 0.42)));
          t.textContent = String(state.grid.weights[j]);
          layer.appendChild(t);
        }
      }
      state.mapVersion++;
    }

    function cellFromEvent(ev) {
      var svg = els.svg;
      if (!svg) return -1;
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      var x = (ev.clientX - rect.left) / rect.width * state.cols;
      var y = (ev.clientY - rect.top) / rect.height * state.rows;
      var c = Math.floor(x), r = Math.floor(y);
      if (r < 0 || c < 0 || r >= state.rows || c >= state.cols) return -1;
      return r * state.cols + c;
    }

    // ------------------------------------------------------------ 场景与整图操作

    function loadScenarioInto(id) {
      var s = P.loadScenario(id);
      if (!s.ok) { setError(s.message || '场景加载失败'); return; }
      state.scenarioId = s.id;
      state.grid = s.grid;
      state.rows = s.grid.rows;
      state.cols = s.grid.cols;
      state.cell = cellSizeFor(state.rows, state.cols);
      state.start = s.start;
      state.goal = s.goal;
      state.neighborhood = s.neighborhood;
      state.heuristic = s.heuristic;
      state.cursorCell = s.start;
      syncControlsFromState();
      renderMap();
      var note = $('ppSceneNote');
      if (note) note.textContent = s.note;
      setError('');
      plan();
    }

    function loadRandom() {
      var seedEl = $('ppSeed');
      var seed = seedEl ? Number(String(seedEl.value).trim()) : 20261126;
      if (!isFinite(seed) || Math.floor(seed) !== seed || seed < 1) {
        setError('随机种子必须是正整数。');
        if (seedEl) seedEl.setAttribute('aria-invalid', 'true');
        return;
      }
      if (seedEl) seedEl.removeAttribute('aria-invalid');
      var r = P.randomGrid(seed, 14, 14);
      if (!r.ok) { setError(r.message || '随机地图生成失败'); return; }
      state.scenarioId = '';
      state.grid = r.grid;
      state.rows = 14;
      state.cols = 14;
      state.cell = cellSizeFor(14, 14);
      state.start = r.start;
      state.goal = r.goal;
      state.cursorCell = r.start;
      var note = $('ppSceneNote');
      if (note) note.textContent = '固定种子 ' + (seed >>> 0) + ' 的随机地图（14×14，障碍 22%、高代价地形 14%），可复现；与真实产线无关。';
      var sel = $('ppScene');
      if (sel) sel.value = '';
      setError('');
      renderMap();
      plan();
    }

    function clearMap() {
      P.clearGrid(state.grid);
      setError('');
      renderMap();
      invalidate('地图已清空');
    }

    function restoreDefault() {
      var sel = $('ppScene');
      if (sel) sel.value = P.DEFAULT_SCENARIO;
      loadScenarioInto(P.DEFAULT_SCENARIO);
    }

    // ------------------------------------------------------------ 控件同步

    function heuristicOptions(nbh) {
      var all = P.heuristicList();
      return all.filter(function (name) { return P.heuristicAllowed(name, nbh); });
    }

    function syncControlsFromState() {
      var sel = $('ppHeuristic');
      if (sel) {
        var names = heuristicOptions(state.neighborhood);
        if (names.indexOf(state.heuristic) === -1) state.heuristic = P.HEURISTIC_RECOMMENDED[state.neighborhood];
        sel.innerHTML = names.map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(P.HEURISTIC_LABEL[n] || n) + '</option>';
        }).join('');
        sel.value = state.heuristic;
      }
      var r4 = $('ppNbh4'), r8 = $('ppNbh8');
      if (r4) r4.checked = state.neighborhood === 4;
      if (r8) r8.checked = state.neighborhood === 8;
      var ad = $('ppAlgoD'), aa = $('ppAlgoA');
      if (ad) ad.checked = state.algorithm === 'dijkstra';
      if (aa) aa.checked = state.algorithm === 'astar';
      var note = $('ppHeuristicNote');
      if (note) {
        note.textContent = state.neighborhood === 4
          ? '四邻域推荐 Manhattan（此时它与实际最少步数完全一致）。'
          : '八邻域推荐 Octile；Euclidean 是可采纳的低估，零启发等价于 Dijkstra。';
      }
    }

    // ------------------------------------------------------------ 播放

    function intervalMs() {
      var el = $('ppSpeed');
      var v = el ? Number(el.value) : P.DEFAULT_SPEED;
      if (!isFinite(v) || v < 1) v = 1;
      if (v > 10) v = 10;
      return Math.round(620 / v);
    }

    function stepOnce() {
      if (!state.compare) {
        if (!plan()) return false;
      }
      var res = active();
      if (res.trace.length === 0) {
        setStatus('起点与终点相同：代价 0，没有需要扩展的节点。');
        return false;
      }
      if (state.cursor >= res.trace.length) {
        // 已播完：单步视为从头重放一步，避免按钮无响应
        state.cursor = 0;
        resetReplayView();
      }
      state.cursor++;
      renderTo(state.cursor);
      renderStepInfo();
      setProgress();
      var st = res.trace[state.cursor - 1];
      setLive('第 ' + state.cursor + ' 步：扩展第 ' + Math.floor(st.node / state.cols) + ' 行第 ' +
        (st.node % state.cols) + ' 列，累计代价 ' + fmt(st.g, 3) + '。');
      return true;
    }

    function tick() {
      if (state.destroyed || !state.playing) return;
      var res = state.compare ? active() : null;
      if (!res) { stopPlay(); return; }
      if (state.cursor >= res.trace.length) { finishPlay(); return; }
      stepOnce();
      playTimer = setTimeout(tick, intervalMs());
    }

    function finishPlay() {
      stopPlay();
      setProgress();
      var res = state.compare ? active() : null;
      if (res && !res.found) setStatus('回放结束：终点不可达。');
      else setStatus('回放结束：最终路径已显示。');
      renderStepInfo();
    }

    function play() {
      if (!state.compare) {
        if (!plan()) return;
      } else if (state.cursor >= active().trace.length) {
        // 播完后再点播放：从头重放
        state.cursor = 0;
        renderTo(0);
        renderStepInfo();
        setProgress();
      }
      stopPlay();
      state.playing = true;
      tick();
    }

    // ------------------------------------------------------------ 事件绑定

    function readNbh() {
      var r8 = $('ppNbh8');
      return r8 && r8.checked ? 8 : 4;
    }

    function onNeighborhoodChange() {
      var nbh = readNbh();
      if (nbh === state.neighborhood) return;
      stopPlay();
      state.neighborhood = nbh;
      if (!P.heuristicAllowed(state.heuristic, nbh)) {
        state.heuristic = P.HEURISTIC_RECOMMENDED[nbh];
      }
      syncControlsFromState();
      recompute('运动模型已切换');
    }

    function onHeuristicChange() {
      var sel = $('ppHeuristic');
      if (!sel) return;
      var val = sel.value;
      if (!P.heuristicAllowed(val, state.neighborhood)) {
        setError(P.ERROR_TEXT['heuristic-overestimates']);
        sel.value = state.heuristic;
        return;
      }
      setError('');
      state.heuristic = val;
      recompute('启发函数已切换');
    }

    function onAlgorithmChange() {
      var aa = $('ppAlgoA');
      var next = aa && aa.checked ? 'astar' : 'dijkstra';
      if (next === state.algorithm) return;
      stopPlay();
      state.algorithm = next;
      // 旧回放作废：停止播放、清空视图，再按新算法重新规划
      state.cursor = 0;
      resetReplayView();
      recompute('算法已切换');
    }

    function onKeyDown(ev) {
      var rows = state.rows, cols = state.cols;
      var r = Math.floor(state.cursorCell / cols), c = state.cursorCell % cols;
      var handled = true;
      if (ev.key === 'ArrowUp') r = Math.max(0, r - 1);
      else if (ev.key === 'ArrowDown') r = Math.min(rows - 1, r + 1);
      else if (ev.key === 'ArrowLeft') c = Math.max(0, c - 1);
      else if (ev.key === 'ArrowRight') c = Math.min(cols - 1, c + 1);
      else if (ev.key === 'Home') { r = Math.floor(state.start / cols); c = state.start % cols; }
      else if (ev.key === 'End') { r = Math.floor(state.goal / cols); c = state.goal % cols; }
      else if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        applyTool(state.cursorCell);
        setLive('已应用工具：' + toolLabel(state.tool) + '。');
        ev.preventDefault();
        return;
      } else handled = false;
      if (!handled) return;
      ev.preventDefault();
      state.cursorCell = r * cols + c;
      renderCursorCell();
      var idx = state.cursorCell;
      var desc;
      if (idx === state.start) desc = '起点';
      else if (idx === state.goal) desc = '终点';
      else if (state.grid.blocked[idx]) desc = '障碍物';
      else if (state.grid.weights[idx] > 1) desc = '高代价地形，权重 ' + state.grid.weights[idx];
      else desc = '普通地面';
      setLive('第 ' + r + ' 行第 ' + c + ' 列：' + desc + '。当前工具：' + toolLabel(state.tool) + '。');
    }

    function onPointerDown(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      dragging = true;
      dragCell = -1;
      if (els.svg.setPointerCapture && ev.pointerId !== undefined) {
        try { els.svg.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      }
      handlePointer(ev);
      ev.preventDefault();
    }

    function handlePointer(ev) {
      var idx = cellFromEvent(ev);
      if (idx < 0 || idx === dragCell) return;
      dragCell = idx;
      applyTool(idx);
    }

    function onPointerMove(ev) {
      if (!dragging) return;
      handlePointer(ev);
      ev.preventDefault();
    }

    function onPointerUp() {
      dragging = false;
      dragCell = -1;
    }

    // ------------------------------------------------------------ 初始化

    els.svg = $('ppGrid');
    if (!els.svg) return null;

    var speed = $('ppSpeed');
    if (speed) speed.value = String(P.DEFAULT_SPEED);
    var wEl = $('ppWeight');
    if (wEl) wEl.value = String(P.DEFAULT_WEIGHT);

    var sceneSel = $('ppScene');
    if (sceneSel) sceneSel.value = P.DEFAULT_SCENARIO;

    var s0 = P.loadScenario(P.DEFAULT_SCENARIO);
    state.scenarioId = s0.id;
    state.grid = s0.grid;
    state.rows = s0.grid.rows;
    state.cols = s0.grid.cols;
    state.cell = cellSizeFor(state.rows, state.cols);
    state.start = s0.start;
    state.goal = s0.goal;
    state.neighborhood = s0.neighborhood;
    state.heuristic = s0.heuristic;
    state.cursorCell = s0.start;
    state.weight = P.DEFAULT_WEIGHT;
    syncControlsFromState();
    renderMap();
    var sn = $('ppSceneNote');
    if (sn) sn.textContent = s0.note;

    on(els.svg, 'pointerdown', onPointerDown);
    on(els.svg, 'pointermove', onPointerMove);
    on(els.svg, 'pointerup', onPointerUp);
    on(els.svg, 'pointercancel', onPointerUp);
    on(els.svg, 'keydown', onKeyDown);

    on($('ppToolBlock'), 'change', function () { state.tool = 'block'; });
    on($('ppToolCost'), 'change', function () { state.tool = 'cost'; });
    on($('ppToolStart'), 'change', function () { state.tool = 'start'; });
    on($('ppToolGoal'), 'change', function () { state.tool = 'goal'; });
    on($('ppToolErase'), 'change', function () { state.tool = 'erase'; });
    on($('ppWeight'), 'change', function () { readWeight(); });

    on($('ppNbh4'), 'change', onNeighborhoodChange);
    on($('ppNbh8'), 'change', onNeighborhoodChange);
    on($('ppHeuristic'), 'change', onHeuristicChange);
    on($('ppAlgoD'), 'change', onAlgorithmChange);
    on($('ppAlgoA'), 'change', onAlgorithmChange);

    on($('ppRun'), 'click', function () { plan(); });
    on($('ppStep'), 'click', function () { stopPlay(); stepOnce(); });
    on($('ppPlay'), 'click', function () { play(); });
    on($('ppPause'), 'click', function () { stopPlay(); setStatus('已暂停（回放不参与计算）。'); });
    on($('ppReset'), 'click', function () {
      stopPlay();
      if (!state.compare) { plan(); }
      state.cursor = 0;
      renderTo(0);
      renderStepInfo();
      setProgress();
      setStatus('搜索状态已重置：点击「单步搜索」或「自动播放」从第 0 步重放。');
    });
    on($('ppClear'), 'click', clearMap);
    on($('ppDefault'), 'click', restoreDefault);
    on($('ppRandom'), 'click', loadRandom);
    on($('ppScene'), 'change', function () {
      var sel = $('ppScene');
      if (sel && sel.value) loadScenarioInto(sel.value);
    });

    plan();

    var handle = {
      getState: function () { return snapshot(); },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        stopPlay();
        dragging = false;
        dragCell = -1;
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners = [];
        overlay = {};
        overlayCount = 0;
      }
    };
    root.__ppHandle = handle;
    _current = handle;
    return handle;

    function snapshot() {
      var res = state.compare ? active() : null;
      var d = state.compare ? state.compare.dijkstra : null;
      var a = state.compare ? state.compare.astar : null;
      var blockedCount = 0, costlyCount = 0;
      for (var gi = 0; gi < state.grid.size; gi++) {
        if (state.grid.blocked[gi]) blockedCount++;
        else if (state.grid.weights[gi] > 1) costlyCount++;
      }
      function brief(r) {
        if (!r) return null;
        return {
          found: !!r.found,
          status: r.status,
          cost: r.found ? r.cost : null,
          geometricLength: r.found ? r.geometricLength : null,
          pathNodes: r.pathNodes,
          expandedNodes: r.expandedNodes,
          discoveredNodes: r.discoveredNodes,
          relaxedEdges: r.relaxedEdges,
          maxOpen: r.maxOpen,
          timeMs: r.timeMs,
          heuristic: r.heuristic,
          traceLength: r.trace.length
        };
      }
      return {
        ready: true,
        rows: state.rows,
        cols: state.cols,
        neighborhood: state.neighborhood,
        heuristic: state.heuristic,
        algorithm: state.algorithm,
        scenarioId: state.scenarioId,
        tool: state.tool,
        weight: state.weight,
        start: state.start,
        goal: state.goal,
        startCoord: [Math.floor(state.start / state.cols), state.start % state.cols],
        goalCoord: [Math.floor(state.goal / state.cols), state.goal % state.cols],
        blockedCount: blockedCount,
        costlyCount: costlyCount,
        cursor: state.cursor,
        traceLength: res ? res.trace.length : 0,
        playing: state.playing,
        speed: intervalMs(),
        planCount: state.planCount,
        computeCount: state.computeCount,
        mapVersion: state.mapVersion,
        invalidated: !state.compare,
        invalidReason: state.invalid,
        status: res ? res.status : 'stale',
        cost: res && res.found ? res.cost : null,
        geometricLength: res && res.found ? res.geometricLength : null,
        pathNodes: res ? res.pathNodes : 0,
        expanded: res ? res.expandedNodes : 0,
        discovered: res ? res.discoveredNodes : 0,
        timeMs: res ? res.timeMs : null,
        path: res && res.found ? res.path.slice() : [],
        overlayCount: overlayCount,
        pathDrawn: !!(els.pathLayer && els.pathLayer.querySelector('.pp-path')),
        ab: state.compare ? {
          dijkstra: brief(d),
          astar: brief(a),
          sameCost: state.compare.sameCost,
          costDelta: state.compare.costDelta
        } : null,
        error: ($('ppError') || {}).textContent || ''
      };
    }
  }

  function getState(root) {
    if (!root) return null;
    var h = root.__ppHandle;
    return h ? h.getState() : null;
  }

  /* 路由离开 / 重新挂载前调用：清定时器、监听器与拖动状态（幂等）。 */
  function unmount() {
    if (_current) {
      try { _current.destroy(); } catch (e) { /* 忽略 */ }
      _current = null;
    }
  }

  var api = { renderPage: renderPage, mount: mount, getState: getState, unmount: unmount };
  global.PathPlanningDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
