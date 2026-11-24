/**
 * Batch 9C-1A：二连杆机器人运动学交互演示 —— UI 模块（原生 SVG，无框架、无后端、无持久化）
 *
 * 职责：
 *   - renderPage()：纯字符串渲染页面骨架（可深链、可被路由直接 innerHTML）；
 *   - mount(root)：绑定指针拖动 / 键盘 / 输入 / 分支切换，全部监听器都挂在 root 内部节点上，
 *     路由切换销毁 DOM 即完成清理，不注册任何 window/document 级监听器；
 *   - getState(root)：只读数值快照，供测试与调试做**数值**断言（不依赖图形位置判断正确性）。
 *
 * 数学全部委托 js/robot-kinematics.js（FK / 解析 IK / 双分支 / 奇异与数值保护）。
 * 不可达目标：机械臂保持上一姿态，显示真实残差与不可达状态，绝不截断目标伪造可达解。
 * 颜色全部走站点设计令牌（var(--color-*)），深浅主题自动适配。
 */
(function (global) {
  'use strict';

  var VIEW = 640;          // SVG viewBox 边长
  var PAD = 48;            // 工作空间外留白
  var DEFAULTS = { L1: 120, L2: 90, branch: 'elbow-up', target: { x: 150, y: 90 } };
  var LIMITS = { min: 10, max: 300 };   // UI 输入范围（数学模块本身接受任意正有限长度）
  var KEY_STEP = 1;
  var KEY_STEP_FAST = 10;

  function RK() { return global.RobotKinematics; }

  function fmt(v, d) {
    return (Math.abs(v) < Math.pow(10, -d) / 2 ? 0 : v).toFixed(d);
  }

  function fmtResidual(r) {
    if (r === 0) return '0';
    return r < 1e-4 ? r.toExponential(2) : r.toFixed(3);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- 页面骨架
  function renderPage() {
    return '' +
      '<div class="robot-page" id="robotDemoRoot">' +
      '<h1 class="page-title">二连杆机器人运动学演示</h1>' +
      '<p class="page-desc">平面 2R 机械臂交互演示：拖动目标点求解析逆运动学，支持肘上 / 肘下分支切换。' +
      '坐标系以基座为原点，x 向右、y 向上，角度逆时针为正；长度单位为任意一致单位。</p>' +
      '<div class="robot-layout">' +
      '<div class="robot-stage-card">' +
      '<svg id="robotStage" class="robot-stage" viewBox="0 0 ' + VIEW + ' ' + VIEW + '" ' +
      'role="application" aria-roledescription="二维机械臂工作区" tabindex="0" ' +
      'aria-label="机械臂工作区：方向键移动目标点，Shift 加速，Home 恢复默认目标；也可在控制面板输入目标坐标"></svg>' +
      '<p class="robot-hint">拖动十字标记设定目标：绿色 = 可达，红色 = 不可达。键盘：聚焦工作区后方向键移动目标（Shift ×10）。</p>' +
      '</div>' +
      '<aside class="robot-panel" aria-label="控制面板">' +
      '<div class="robot-field">' +
      '<span class="robot-field-title" id="robotLenLabel">连杆长度（10–300）</span>' +
      '<div class="robot-field-row" role="group" aria-labelledby="robotLenLabel">' +
      '<label class="robot-input-label">L1<input id="robotL1" type="number" min="' + LIMITS.min + '" max="' + LIMITS.max + '" step="1" value="' + DEFAULTS.L1 + '" inputmode="decimal"></label>' +
      '<label class="robot-input-label">L2<input id="robotL2" type="number" min="' + LIMITS.min + '" max="' + LIMITS.max + '" step="1" value="' + DEFAULTS.L2 + '" inputmode="decimal"></label>' +
      '</div>' +
      '<p class="robot-error" id="robotLenError" aria-live="polite"></p>' +
      '</div>' +
      '<div class="robot-field">' +
      '<span class="robot-field-title" id="robotTargetLabel">目标位置</span>' +
      '<div class="robot-field-row" role="group" aria-labelledby="robotTargetLabel">' +
      '<label class="robot-input-label">X<input id="robotTX" type="number" step="1" value="' + DEFAULTS.target.x + '" inputmode="decimal"></label>' +
      '<label class="robot-input-label">Y<input id="robotTY" type="number" step="1" value="' + DEFAULTS.target.y + '" inputmode="decimal"></label>' +
      '</div>' +
      '<p class="robot-error" id="robotTargetError" aria-live="polite"></p>' +
      '</div>' +
      '<div class="robot-field">' +
      '<span class="robot-field-title" id="robotBranchLabel">逆解分支</span>' +
      '<div class="robot-branch" role="group" aria-labelledby="robotBranchLabel">' +
      '<button type="button" id="robotBranchUp" aria-pressed="true">肘上</button>' +
      '<button type="button" id="robotBranchDown" aria-pressed="false">肘下</button>' +
      '</div>' +
      '</div>' +
      '<dl class="robot-readout" aria-label="运动学读数">' +
      '<dt>θ1</dt><dd id="robotT1">–</dd>' +
      '<dt>θ2</dt><dd id="robotT2">–</dd>' +
      '<dt>目标位置</dt><dd id="robotTargetPos">–</dd>' +
      '<dt>实际末端</dt><dd id="robotEndPos">–</dd>' +
      '<dt>定位残差</dt><dd id="robotResidual">–</dd>' +
      '<dt>工作空间</dt><dd id="robotWorkspace">–</dd>' +
      '<dt>状态</dt><dd><span id="robotStatus" class="robot-status">–</span></dd>' +
      '</dl>' +
      '<button type="button" id="robotReset" class="robot-reset">恢复默认</button>' +
      '<p class="robot-hint">不可达时机械臂保持上一姿态；残差为目标与实际末端的真实距离，不做截断伪造。</p>' +
      '<span id="robotLive" class="robot-visually-hidden" aria-live="polite"></span>' +
      '</aside>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 场景几何
  function geom(state) {
    var rMax = state.L1 + state.L2;
    var s = (VIEW / 2 - PAD) / rMax;
    return { s: s, cx: VIEW / 2, cy: VIEW / 2, rMax: rMax, rMin: Math.abs(state.L1 - state.L2) };
  }

  function sx(g, x) { return g.cx + x * g.s; }
  function sy(g, y) { return g.cy - y * g.s; }

  function arcPath(g, ox, oy, radius, from, delta) {
    // 数学角（逆时针为正）→ SVG（y 向下）：逆时针视觉方向对应 sweep=0
    var x1 = ox + radius * Math.cos(from);
    var y1 = oy - radius * Math.sin(from);
    var to = from + delta;
    var x2 = ox + radius * Math.cos(to);
    var y2 = oy - radius * Math.sin(to);
    var sweep = delta >= 0 ? 0 : 1;
    var large = Math.abs(delta) > Math.PI ? 1 : 0;
    return 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
      ' A ' + radius + ' ' + radius + ' 0 ' + large + ' ' + sweep + ' ' +
      x2.toFixed(2) + ' ' + y2.toFixed(2);
  }

  function buildStatic(svg, state) {
    var g = geom(state);
    svg.setAttribute('viewBox', '0 0 ' + VIEW + ' ' + VIEW);
    svg.setAttribute('data-scale', String(g.s));
    svg.setAttribute('data-cx', String(g.cx));
    svg.setAttribute('data-cy', String(g.cy));
    var outerR = (g.rMax * g.s).toFixed(2);
    var innerR = (g.rMin * g.s).toFixed(2);
    var html = '' +
      '<circle class="robot-ws-outer" cx="' + g.cx + '" cy="' + g.cy + '" r="' + outerR + '"></circle>' +
      (g.rMin > 0
        ? '<circle class="robot-ws-inner" cx="' + g.cx + '" cy="' + g.cy + '" r="' + innerR + '"></circle>'
        : '') +
      '<line class="robot-axis" x1="' + PAD / 2 + '" y1="' + g.cy + '" x2="' + (VIEW - PAD / 2) + '" y2="' + g.cy + '"></line>' +
      '<line class="robot-axis" x1="' + g.cx + '" y1="' + PAD / 2 + '" x2="' + g.cx + '" y2="' + (VIEW - PAD / 2) + '"></line>' +
      '<text class="robot-axis-label" x="' + (VIEW - PAD / 2 - 4) + '" y="' + (g.cy - 8) + '">+x</text>' +
      '<text class="robot-axis-label" x="' + (g.cx + 8) + '" y="' + (PAD / 2 + 12) + '">+y</text>' +
      '<line id="robotResidualLine" class="robot-residual" x1="0" y1="0" x2="0" y2="0" visibility="hidden"></line>' +
      '<line id="robotLink1" class="robot-link1" x1="' + g.cx + '" y1="' + g.cy + '" x2="' + g.cx + '" y2="' + g.cy + '"></line>' +
      '<line id="robotLink2" class="robot-link2" x1="' + g.cx + '" y1="' + g.cy + '" x2="' + g.cx + '" y2="' + g.cy + '"></line>' +
      '<path id="robotArc1" class="robot-arc" d=""></path>' +
      '<text id="robotArc1Label" class="robot-arc-label" x="0" y="0"></text>' +
      '<path id="robotArc2" class="robot-arc" d=""></path>' +
      '<text id="robotArc2Label" class="robot-arc-label" x="0" y="0"></text>' +
      '<circle class="robot-joint-base" cx="' + g.cx + '" cy="' + g.cy + '" r="9"></circle>' +
      '<circle id="robotElbow" class="robot-joint-elbow" cx="' + g.cx + '" cy="' + g.cy + '" r="7"></circle>' +
      '<circle id="robotEnd" class="robot-joint-end" cx="' + g.cx + '" cy="' + g.cy + '" r="6"></circle>' +
      '<g id="robotTarget" class="robot-target" transform="translate(' + g.cx + ',' + g.cy + ')">' +
      '<circle class="robot-target-hit" r="22"></circle>' +
      '<circle class="robot-target-ring" r="13"></circle>' +
      '<line class="robot-target-cross" x1="-7" y1="0" x2="7" y2="0"></line>' +
      '<line class="robot-target-cross" x1="0" y1="-7" x2="0" y2="7"></line>' +
      '</g>';
    svg.innerHTML = html;
  }

  function updateDynamic(svg, state) {
    var g = geom(state);
    var pose = state.pose;
    var bx = g.cx, by = g.cy;
    var ex = sx(g, pose.elbow.x), ey = sy(g, pose.elbow.y);
    var tx = sx(g, pose.end.x), ty = sy(g, pose.end.y);
    var gx = sx(g, state.target.x), gy = sy(g, state.target.y);

    svg.setAttribute('data-reach', state.reachable ? '1' : '0');
    var l1 = svg.querySelector('#robotLink1');
    l1.setAttribute('x2', ex.toFixed(2)); l1.setAttribute('y2', ey.toFixed(2));
    var l2 = svg.querySelector('#robotLink2');
    l2.setAttribute('x1', ex.toFixed(2)); l2.setAttribute('y1', ey.toFixed(2));
    l2.setAttribute('x2', tx.toFixed(2)); l2.setAttribute('y2', ty.toFixed(2));
    var elbow = svg.querySelector('#robotElbow');
    elbow.setAttribute('cx', ex.toFixed(2)); elbow.setAttribute('cy', ey.toFixed(2));
    var end = svg.querySelector('#robotEnd');
    end.setAttribute('cx', tx.toFixed(2)); end.setAttribute('cy', ty.toFixed(2));
    svg.querySelector('#robotTarget').setAttribute('transform', 'translate(' + gx.toFixed(2) + ',' + gy.toFixed(2) + ')');

    var residualLine = svg.querySelector('#robotResidualLine');
    if (state.residual > 1e-9 * (state.L1 + state.L2)) {
      residualLine.setAttribute('visibility', 'visible');
      residualLine.setAttribute('x1', tx.toFixed(2)); residualLine.setAttribute('y1', ty.toFixed(2));
      residualLine.setAttribute('x2', gx.toFixed(2)); residualLine.setAttribute('y2', gy.toFixed(2));
    } else {
      residualLine.setAttribute('visibility', 'hidden');
    }

    // 角度弧：θ1 在基座（相对 +x），θ2 在肘部（相对连杆 1 方向）
    var arc1 = svg.querySelector('#robotArc1');
    var arc1Label = svg.querySelector('#robotArc1Label');
    if (Math.abs(state.t1) > 0.02) {
      arc1.setAttribute('d', arcPath(g, bx, by, 30, 0, state.t1));
      arc1.setAttribute('visibility', 'visible');
      var m1 = state.t1 / 2;
      arc1Label.setAttribute('x', (bx + 46 * Math.cos(m1)).toFixed(2));
      arc1Label.setAttribute('y', (by - 46 * Math.sin(m1) + 4).toFixed(2));
      arc1Label.textContent = 'θ1 ' + fmt(RK().deg(state.t1), 1) + '°';
      arc1Label.setAttribute('visibility', 'visible');
    } else {
      arc1.setAttribute('visibility', 'hidden');
      arc1Label.setAttribute('visibility', 'hidden');
    }
    var arc2 = svg.querySelector('#robotArc2');
    var arc2Label = svg.querySelector('#robotArc2Label');
    if (Math.abs(state.t2) > 0.02) {
      arc2.setAttribute('d', arcPath(g, ex, ey, 24, state.t1, state.t2));
      arc2.setAttribute('visibility', 'visible');
      var m2 = state.t1 + state.t2 / 2;
      arc2Label.setAttribute('x', (ex + 40 * Math.cos(m2)).toFixed(2));
      arc2Label.setAttribute('y', (ey - 40 * Math.sin(m2) + 4).toFixed(2));
      arc2Label.textContent = 'θ2 ' + fmt(RK().deg(state.t2), 1) + '°';
      arc2Label.setAttribute('visibility', 'visible');
    } else {
      arc2.setAttribute('visibility', 'hidden');
      arc2Label.setAttribute('visibility', 'hidden');
    }
  }

  // ---------------------------------------------------------------- 状态与求解
  function freshState() {
    var state = {
      L1: DEFAULTS.L1, L2: DEFAULTS.L2,
      branch: DEFAULTS.branch,
      target: { x: DEFAULTS.target.x, y: DEFAULTS.target.y },
      t1: 0, t2: 0,
      pose: null,
      residual: 0,
      reachable: true,
      singular: null,
      reason: null
    };
    solve(state);
    return state;
  }

  function solve(state) {
    var rk = RK();
    var sol = rk.ik(state.L1, state.L2, state.target.x, state.target.y, state.branch);
    if (sol.ok) {
      state.t1 = sol.t1;
      state.t2 = sol.t2;
      state.pose = rk.fk(state.L1, state.L2, state.t1, state.t2);
      state.residual = sol.residual;
      state.reachable = true;
      state.singular = sol.singular;
      state.reason = null;
    } else if (sol.reachable === false) {
      // 不可达：保持上一关节角，用当前杆长 FK 得到真实末端；残差如实计算
      state.pose = rk.fk(state.L1, state.L2, state.t1, state.t2);
      state.residual = Math.hypot(state.pose.end.x - state.target.x, state.pose.end.y - state.target.y);
      state.reachable = false;
      state.singular = null;
      state.reason = sol.reason;
    }
    // 其余 ok:false（非法输入）在调用前已被 UI 校验拦截，不会进入这里
  }

  function statusText(state) {
    if (!state.reachable) {
      return state.reason === 'inside-inner' ? '不可达 · 内边界以内' : '不可达 · 超出外边界';
    }
    if (state.singular === 'extended') return '可达 · 奇异（完全伸直）';
    if (state.singular === 'folded') return '可达 · 奇异（完全折叠）';
    return '可达';
  }

  function updateReadout(root, state) {
    var rk = RK();
    var ws = rk.workspace(state.L1, state.L2);
    root.querySelector('#robotT1').textContent = fmt(rk.deg(state.t1), 2) + '°';
    root.querySelector('#robotT2').textContent = fmt(rk.deg(state.t2), 2) + '°';
    root.querySelector('#robotTargetPos').textContent = '(' + fmt(state.target.x, 1) + ', ' + fmt(state.target.y, 1) + ')';
    root.querySelector('#robotEndPos').textContent = '(' + fmt(state.pose.end.x, 2) + ', ' + fmt(state.pose.end.y, 2) + ')';
    root.querySelector('#robotResidual').textContent = fmtResidual(state.residual);
    root.querySelector('#robotWorkspace').textContent = fmt(ws.rMin, 1) + ' ≤ r ≤ ' + fmt(ws.rMax, 1);
    var badge = root.querySelector('#robotStatus');
    badge.textContent = statusText(state);
    badge.className = 'robot-status ' + (
      !state.reachable ? 'robot-status--err'
        : state.singular ? 'robot-status--warn'
          : 'robot-status--ok'
    );
  }

  function announce(root, state) {
    var live = root.querySelector('#robotLive');
    if (live) {
      live.textContent = statusText(state) + '；θ1 ' + fmt(RK().deg(state.t1), 1) +
        ' 度，θ2 ' + fmt(RK().deg(state.t2), 1) + ' 度；残差 ' + fmtResidual(state.residual);
    }
  }

  function syncTargetInputs(root, state) {
    var tx = root.querySelector('#robotTX');
    var ty = root.querySelector('#robotTY');
    var active = root.ownerDocument ? root.ownerDocument.activeElement : null;
    if (tx !== active) tx.value = String(Math.round(state.target.x * 10) / 10);
    if (ty !== active) ty.value = String(Math.round(state.target.y * 10) / 10);
  }

  // ---------------------------------------------------------------- 挂载
  function mount(root) {
    if (!root || !RK()) return null;
    var svg = root.querySelector('#robotStage');
    var state = freshState();
    var dragging = false;
    var rafId = 0;
    var pendingPoint = null;
    var destroyed = false;

    buildStatic(svg, state);
    updateDynamic(svg, state);
    updateReadout(root, state);

    function refresh() {
      updateDynamic(svg, state);
      updateReadout(root, state);
    }

    function applyPending() {
      rafId = 0;
      if (!pendingPoint) return;
      var p = pendingPoint;
      pendingPoint = null;
      state.target.x = p.x;
      state.target.y = p.y;
      solve(state);
      refresh();
      syncTargetInputs(root, state);
    }

    function queuePoint(p) {
      pendingPoint = p;
      if (rafId) return;
      if (typeof global.requestAnimationFrame === 'function') {
        rafId = global.requestAnimationFrame(applyPending);
      } else {
        applyPending();
      }
    }

    function clientToWorld(e) {
      var rect = svg.getBoundingClientRect();
      var g = geom(state);
      var px = (e.clientX - rect.left) / rect.width * VIEW;
      var py = (e.clientY - rect.top) / rect.height * VIEW;
      return { x: (px - g.cx) / g.s, y: (g.cy - py) / g.s };
    }

    function onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
      dragging = true;
      queuePoint(clientToWorld(e));
    }

    function onPointerMove(e) {
      if (!dragging) return;
      e.preventDefault();
      queuePoint(clientToWorld(e));
    }

    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (rafId && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(rafId);
      applyPending();
      announce(root, state);
    }

    function onKeyDown(e) {
      var step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = step;
      else if (e.key === 'ArrowDown') dy = -step;
      else if (e.key === 'Home') {
        e.preventDefault();
        state.target.x = DEFAULTS.target.x;
        state.target.y = DEFAULTS.target.y;
        solve(state); refresh(); syncTargetInputs(root, state); announce(root, state);
        return;
      } else return;
      e.preventDefault();
      state.target.x += dx;
      state.target.y += dy;
      solve(state); refresh(); syncTargetInputs(root, state); announce(root, state);
    }

    function setError(id, msg) {
      var el = root.querySelector(id);
      el.textContent = msg || '';
    }

    function onLengthChange() {
      var i1 = root.querySelector('#robotL1');
      var i2 = root.querySelector('#robotL2');
      var v1 = Number(i1.value);
      var v2 = Number(i2.value);
      var bad = [];
      if (i1.value.trim() === '' || !isFinite(v1) || v1 < LIMITS.min || v1 > LIMITS.max) bad.push('L1');
      if (i2.value.trim() === '' || !isFinite(v2) || v2 < LIMITS.min || v2 > LIMITS.max) bad.push('L2');
      if (bad.length) {
        setError('#robotLenError', bad.join(' / ') + ' 需为 ' + LIMITS.min + '–' + LIMITS.max + ' 之间的数字，已保持上一组有效长度');
        i1.setAttribute('aria-invalid', bad.indexOf('L1') !== -1 ? 'true' : 'false');
        i2.setAttribute('aria-invalid', bad.indexOf('L2') !== -1 ? 'true' : 'false');
        return;
      }
      setError('#robotLenError', '');
      i1.setAttribute('aria-invalid', 'false');
      i2.setAttribute('aria-invalid', 'false');
      state.L1 = v1;
      state.L2 = v2;
      buildStatic(svg, state);   // 工作空间边界随杆长重建
      solve(state);
      refresh();
      announce(root, state);
    }

    function onTargetChange() {
      var ix = root.querySelector('#robotTX');
      var iy = root.querySelector('#robotTY');
      var x = Number(ix.value);
      var y = Number(iy.value);
      if (ix.value.trim() === '' || iy.value.trim() === '' || !isFinite(x) || !isFinite(y)) {
        setError('#robotTargetError', '目标坐标需为有限数字，已保持上一个有效目标');
        ix.setAttribute('aria-invalid', 'true');
        iy.setAttribute('aria-invalid', 'true');
        return;
      }
      setError('#robotTargetError', '');
      ix.setAttribute('aria-invalid', 'false');
      iy.setAttribute('aria-invalid', 'false');
      state.target.x = x;
      state.target.y = y;
      solve(state);
      refresh();
      announce(root, state);
    }

    function setBranch(branch) {
      state.branch = branch;
      root.querySelector('#robotBranchUp').setAttribute('aria-pressed', String(branch === 'elbow-up'));
      root.querySelector('#robotBranchDown').setAttribute('aria-pressed', String(branch === 'elbow-down'));
      solve(state);
      refresh();
      announce(root, state);
    }

    function onReset() {
      state.L1 = DEFAULTS.L1;
      state.L2 = DEFAULTS.L2;
      state.branch = DEFAULTS.branch;
      state.target.x = DEFAULTS.target.x;
      state.target.y = DEFAULTS.target.y;
      root.querySelector('#robotL1').value = String(DEFAULTS.L1);
      root.querySelector('#robotL2').value = String(DEFAULTS.L2);
      root.querySelector('#robotTX').value = String(DEFAULTS.target.x);
      root.querySelector('#robotTY').value = String(DEFAULTS.target.y);
      root.querySelector('#robotBranchUp').setAttribute('aria-pressed', 'true');
      root.querySelector('#robotBranchDown').setAttribute('aria-pressed', 'false');
      setError('#robotLenError', '');
      setError('#robotTargetError', '');
      buildStatic(svg, state);
      solve(state);
      refresh();
      announce(root, state);
    }

    var listeners = [
      [svg, 'pointerdown', onPointerDown],
      [svg, 'pointermove', onPointerMove],
      [svg, 'pointerup', onPointerUp],
      [svg, 'pointercancel', onPointerUp],
      [svg, 'keydown', onKeyDown],
      [root.querySelector('#robotL1'), 'change', onLengthChange],
      [root.querySelector('#robotL2'), 'change', onLengthChange],
      [root.querySelector('#robotTX'), 'change', onTargetChange],
      [root.querySelector('#robotTY'), 'change', onTargetChange],
      [root.querySelector('#robotBranchUp'), 'click', function () { setBranch('elbow-up'); }],
      [root.querySelector('#robotBranchDown'), 'click', function () { setBranch('elbow-down'); }],
      [root.querySelector('#robotReset'), 'click', onReset]
    ];
    listeners.forEach(function (l) { l[0].addEventListener(l[1], l[2]); });

    var handle = {
      getState: function () { return snapshot(state); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        if (rafId && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(rafId);
      }
    };
    root.__robotHandle = handle;
    return handle;
  }

  function snapshot(state) {
    var ws = RK().workspace(state.L1, state.L2);
    return {
      L1: state.L1, L2: state.L2,
      branch: state.branch,
      target: { x: state.target.x, y: state.target.y },
      t1: state.t1, t2: state.t2,
      elbow: { x: state.pose.elbow.x, y: state.pose.elbow.y },
      end: { x: state.pose.end.x, y: state.pose.end.y },
      residual: state.residual,
      reachable: state.reachable,
      singular: state.singular,
      reason: state.reason,
      rMin: ws.rMin, rMax: ws.rMax
    };
  }

  function getState(root) {
    return root && root.__robotHandle ? root.__robotHandle.getState() : null;
  }

  var api = {
    VERSION: 1,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    VIEW: VIEW,
    PAD: PAD,
    renderPage: renderPage,
    mount: mount,
    getState: getState
  };

  global.RobotDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);