/**
 * graph-demo.js — Batch 9B-2 知识图谱交互层（原生 SVG，无第三方图可视化框架）。
 *
 * 契约：
 *  - mount(root, index, {Related, isCurrent}) 挂载；unmount() 幂等清理
 *    （rAF / 定时器 / window 级监听器 / 拖动状态 / 失效异步），路由退出时由 router 调用。
 *  - 所有节点标题、关系理由、搜索文本按不可信数据处理：一律 textContent / escapeHtml，
 *    跳转链接仅允许 '#/' 站内路由或 'notes/*.html' 静态笔记页，杜绝 javascript: 等协议。
 *  - 布局确定性（knowledge-graph.js），无连续力导向迭代；rAF 仅用于拖动节流。
 *  - 默认可见边裁剪只作用于推断边，且如实标注裁剪数量；真实引用/系列关系永不隐藏。
 */
(function () {
  'use strict';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let active = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeHref(href) {
    const h = String(href || '');
    if (h.indexOf('#/') === 0) return h;
    if (/^notes\/[a-z0-9-]+\.html$/.test(h)) return h;
    return '';
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function unmount() {
    if (active) { const a = active; active = null; a.destroy(); }
  }

  function mount(root, index, opts) {
    unmount();
    const KG = window.KnowledgeGraph;
    const Related = opts && opts.Related;
    const isCurrent = (opts && opts.isCurrent) || function () { return true; };
    const t0 = performance.now();
    const model = KG.buildModel(index, Related, {});
    const t1 = performance.now();
    const lay = KG.layout(model, {});
    const t2 = performance.now();

    const state = {
      filters: { types: [], kinds: [], query: '' },
      selected: '', localMode: false, listMode: false,
      view: { x: -lay.world.width / 2, y: -lay.world.height / 2, w: lay.world.width, h: lay.world.height },
      hover: '', raf: 0, pointers: new Map(), drag: null, pinch: null, destroyed: false
    };
    const typeLabels = (Related && Related.TYPE_LABELS) || {};
    // 孤立口径与构建索引一致：无显式引用且无同系列（推断关联不计入孤立判定）
    const isolatedSet = new Set(model.isolatedKeys || []);

    // ---------- DOM 骨架 ----------
    root.innerHTML = '';
    root.classList.add('graph-mounted');
    const toolbar = el('div', 'graph-toolbar');
    const typeBar = el('div', 'graph-chips');
    typeBar.setAttribute('role', 'group');
    typeBar.setAttribute('aria-label', '按内容类型筛选');
    const kindBar = el('div', 'graph-chips');
    kindBar.setAttribute('role', 'group');
    kindBar.setAttribute('aria-label', '按关系类型筛选');
    const searchWrap = el('div', 'graph-search');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'graph-search-input';
    search.placeholder = '搜索节点标题 / ID…';
    search.setAttribute('aria-label', '搜索图谱节点');
    searchWrap.appendChild(search);
    const actions = el('div', 'graph-actions');
    const btnLocal = el('button', 'editor-btn', '一跳邻居');
    btnLocal.type = 'button'; btnLocal.disabled = true;
    btnLocal.setAttribute('aria-pressed', 'false');
    const btnReset = el('button', 'editor-btn', '重置视图');
    btnReset.type = 'button';
    const btnList = el('button', 'editor-btn', '列表视图');
    btnList.type = 'button';
    btnList.setAttribute('aria-pressed', 'false');
    actions.appendChild(btnLocal); actions.appendChild(btnReset); actions.appendChild(btnList);
    toolbar.appendChild(typeBar); toolbar.appendChild(kindBar);
    toolbar.appendChild(searchWrap); toolbar.appendChild(actions);

    const notice = el('div', 'graph-notice');
    notice.setAttribute('role', 'status');
    const statsLine = el('div', 'graph-stats');
    const stage = el('div', 'graph-stage');
    const svg = svgEl('svg', { class: 'graph-svg', role: 'img', 'aria-label': '知识图谱画布：节点与关系' });
    svg.style.touchAction = 'none';
    const defs = svgEl('defs', {});
    const marker = svgEl('marker', { id: 'graphArrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'graph-arrow-head' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    const gEdges = svgEl('g', { class: 'graph-edges' });
    const gNodes = svgEl('g', { class: 'graph-nodes' });
    svg.appendChild(gEdges); svg.appendChild(gNodes);
    stage.appendChild(svg);
    const listBox = el('div', 'graph-list');
    listBox.hidden = true;
    listBox.setAttribute('role', 'list');
    listBox.setAttribute('aria-label', '图谱节点列表（键盘可用）');
    stage.appendChild(listBox);
    const detail = el('aside', 'graph-detail');
    detail.hidden = true;
    detail.setAttribute('aria-label', '选中节点详情');
    stage.appendChild(detail);
    root.appendChild(toolbar); root.appendChild(notice); root.appendChild(statsLine); root.appendChild(stage);

    // ---------- 筛选 chips ----------
    const typeCounts = {};
    model.nodes.forEach(function (n) { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
    KG.TYPE_ORDER.forEach(function (t) {
      if (!typeCounts[t]) return;
      const b = el('button', 'graph-chip graph-chip-' + t, (typeLabels[t] || t) + ' ' + typeCounts[t]);
      b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.dataset.type = t;
      b.addEventListener('click', function () {
        const i = state.filters.types.indexOf(t);
        if (i === -1) state.filters.types.push(t); else state.filters.types.splice(i, 1);
        b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        b.classList.toggle('on', i === -1);
        render();
      });
      typeBar.appendChild(b);
    });
    const kindMeta = { explicit: '显式引用', series: '同系列', inferred: '推断关联' };
    KG.KIND_ORDER.forEach(function (k) {
      const b = el('button', 'graph-chip graph-chip-kind-' + k, kindMeta[k]);
      b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.dataset.kind = k;
      b.addEventListener('click', function () {
        const i = state.filters.kinds.indexOf(k);
        if (i === -1) state.filters.kinds.push(k); else state.filters.kinds.splice(i, 1);
        b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        b.classList.toggle('on', i === -1);
        render();
      });
      kindBar.appendChild(b);
    });

    // ---------- 视图 ----------
    function applyView() {
      svg.setAttribute('viewBox', state.view.x + ' ' + state.view.y + ' ' + state.view.w + ' ' + state.view.h);
    }
    function resetView() {
      state.view = { x: -lay.world.width / 2, y: -lay.world.height / 2, w: lay.world.width, h: lay.world.height };
      applyView(); updateLabels();
    }
    function centerOn(key, w) {
      const p = lay.positions[key];
      if (!p) return;
      const width = w || Math.min(state.view.w, 420);
      state.view = { x: p.x - width / 2, y: p.y - width / 2, w: width, h: width };
      applyView(); updateLabels();
    }
    function clientToWorld(cx, cy) {
      const r = svg.getBoundingClientRect();
      return {
        x: state.view.x + (cx - r.left) / r.width * state.view.w,
        y: state.view.y + (cy - r.top) / r.height * state.view.h
      };
    }
    function zoomAt(cx, cy, factor) {
      const before = clientToWorld(cx, cy);
      const w = Math.max(60, Math.min(lay.world.width * 2.5, state.view.w * factor));
      const scale = w / state.view.w;
      state.view = { x: before.x - (before.x - state.view.x) * scale, y: before.y - (before.y - state.view.y) * scale, w: w, h: w };
      applyView(); updateLabels();
    }

    // ---------- 渲染 ----------
    let labelEls = [];
    function currentSubgraph() {
      let base;
      if (state.localMode && state.selected && model.byKey[state.selected]) {
        base = KG.oneHop(model, state.selected);
      } else {
        base = { nodes: model.nodes, edges: model.edges };
      }
      const types = state.filters.types.length ? new Set(state.filters.types) : null;
      const kinds = state.filters.kinds.length ? new Set(state.filters.kinds) : null;
      const nodes = base.nodes.filter(function (n) { return !types || types.has(n.type); });
      const vis = new Set(nodes.map(function (n) { return n.key; }));
      const edges = base.edges.filter(function (e) { return (!kinds || kinds.has(e.kind)) && vis.has(e.a) && vis.has(e.b); });
      const sub = { nodes: nodes, edges: edges, byKey: model.byKey, adjacency: model.adjacency };
      const capped = KG.capEdges(sub, KG.DEFAULT_EDGE_CAP);
      return { nodes: nodes, edges: capped.edges, trimmed: capped.trimmedInferred, totalInferred: capped.totalInferred };
    }

    function render() {
      if (state.destroyed || !isCurrent()) return;
      const g = currentSubgraph();
      const q = state.filters.query.trim().toLowerCase();
      const matchSet = new Set(q ? g.nodes.filter(function (n) {
        return n.title.toLowerCase().indexOf(q) !== -1 || n.refId.toLowerCase().indexOf(q) !== -1;
      }).map(function (n) { return n.key; }) : []);

      // 边
      gEdges.textContent = '';
      const r = 7;
      g.edges.forEach(function (e) {
        const pa = lay.positions[e.a], pb = lay.positions[e.b];
        if (!pa || !pb) return;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        const line = svgEl('line', {
          x1: pa.x + ux * r, y1: pa.y + uy * r,
          x2: pb.x - ux * (r + (e.kind === 'explicit' ? 4 : 0)), y2: pb.y - uy * (r + (e.kind === 'explicit' ? 4 : 0)),
          class: 'graph-edge graph-edge-' + e.kind
        });
        if (e.kind === 'explicit') line.setAttribute('marker-end', 'url(#graphArrow)');
        const title = svgEl('title', {});
        title.textContent = e.kind === 'explicit' ? '显式引用（' + (e.via === 'wikilink' ? 'WikiLink' : '正文链接') + '）'
          : e.kind === 'series' ? '同系列：' + e.series
          : '推断关联（算法推荐，非正文引用）' + (e.reasons && e.reasons.length ? '：' + e.reasons.join('；') : '');
        line.appendChild(title);
        gEdges.appendChild(line);
      });

      // 节点
      gNodes.textContent = '';
      labelEls = [];
      g.nodes.forEach(function (n) {
        const p = lay.positions[n.key];
        if (!p) return;
        const grp = svgEl('g', { class: 'graph-node graph-node-' + n.type, 'data-key': n.key });
        const circle = svgEl('circle', { cx: p.x, cy: p.y, r: n.type === 'post' ? 7 : 5.5, class: 'graph-dot' });
        if (n.example) circle.setAttribute('stroke-dasharray', '2 2');
        if (n.key === state.selected) grp.classList.add('selected');
        if (matchSet.has(n.key)) grp.classList.add('match');
        if (isolatedSet.has(n.key)) grp.classList.add('isolated');
        const title = svgEl('title', {});
        title.textContent = n.title + '（' + (typeLabels[n.type] || n.type) + (n.example ? ' · 示例' : '') + '）';
        grp.appendChild(title);
        grp.appendChild(circle);
        const label = svgEl('text', { x: p.x, y: p.y - 10, class: 'graph-label' });
        label.textContent = n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title;
        grp.appendChild(label);
        labelEls.push({ key: n.key, el: label });
        grp.addEventListener('click', function (ev) {
          ev.stopPropagation();
          select(n.key);
        });
        grp.addEventListener('pointerenter', function () { state.hover = n.key; updateLabels(); });
        grp.addEventListener('pointerleave', function () { if (state.hover === n.key) { state.hover = ''; updateLabels(); } });
        gNodes.appendChild(grp);
      });

      // 裁剪与统计提示（如实标注）
      notice.textContent = g.trimmed > 0
        ? '已裁剪 ' + g.trimmed + ' 条低分推断边（推断边共 ' + g.totalInferred + ' 条）；显式引用与同系列关系全部显示。裁剪仅为展示层限制，被裁剪的关系依然存在。'
        : '';
      notice.hidden = !g.trimmed;
      const s = model.stats;
      statsLine.textContent = '节点 ' + s.nodes + ' · 显式引用 ' + s.explicit + ' · 同系列 ' + s.series +
        ' · 推断关联 ' + s.inferred + ' · 孤立节点 ' + s.isolated +
        (s.unresolved ? ' · 未解析引用 ' + s.unresolved : '') +
        (state.localMode && state.selected ? ' · 当前：一跳局部视图' : '');
      btnLocal.disabled = !state.selected;
      renderList(g.nodes);
      updateLabels();
      applyView();
    }

    function updateLabels() {
      const zoomed = state.view.w < 380;
      let shown = 0;
      labelEls.forEach(function (it) {
        const on = it.key === state.selected || it.key === state.hover ||
          (zoomed && shown < 60) ||
          (state.filters.query && it.el.parentNode && it.el.parentNode.classList.contains('match'));
        it.el.style.display = on ? '' : 'none';
        if (on) shown++;
      });
    }

    function renderList(nodes) {
      listBox.textContent = '';
      nodes.forEach(function (n) {
        const item = el('button', 'graph-list-item');
        item.type = 'button';
        item.setAttribute('role', 'listitem');
        item.dataset.key = n.key;
        const t = el('span', 'graph-list-title', n.title);
        const meta = el('span', 'graph-list-meta', (typeLabels[n.type] || n.type) +
          (n.example ? ' · 示例' : '') +
          (isolatedSet.has(n.key) ? ' · 孤立节点' : ''));
        item.appendChild(t); item.appendChild(meta);
        if (n.key === state.selected) item.classList.add('selected');
        item.addEventListener('click', function () { select(n.key); centerOn(n.key); });
        listBox.appendChild(item);
      });
    }

    // ---------- 选中与详情 ----------
    function select(key) {
      state.selected = key || '';
      if (!state.selected) { state.localMode = false; btnLocal.setAttribute('aria-pressed', 'false'); }
      renderDetail();
      render();
    }
    function renderDetail() {
      detail.textContent = '';
      if (!state.selected || !model.byKey[state.selected]) { detail.hidden = true; return; }
      const n = model.byKey[state.selected];
      detail.hidden = false;
      const head = el('div', 'graph-detail-head');
      head.appendChild(el('h3', 'graph-detail-title', n.title));
      const close = el('button', 'graph-detail-close', '✕');
      close.type = 'button'; close.setAttribute('aria-label', '关闭详情');
      close.addEventListener('click', function () { select(''); });
      head.appendChild(close);
      detail.appendChild(head);
      const meta = el('div', 'graph-detail-meta', (typeLabels[n.type] || n.type) + (n.example ? ' · 示例项目（文案未经独立验证）' : ''));
      detail.appendChild(meta);
      const href = safeHref(n.href);
      if (href) {
        const a = el('a', 'graph-detail-link', '打开内容 →');
        a.href = href;
        detail.appendChild(a);
      } else {
        detail.appendChild(el('div', 'graph-detail-nohref', '该节点暂无有效跳转目标'));
      }
      const rels = KG.nodeRelations(model, state.selected);
      if (!rels.length) {
        detail.appendChild(el('p', 'graph-detail-empty', '该节点暂无任何关联（显式引用 / 同系列 / 推断关联）。'));
      } else {
        const ul = el('ul', 'graph-detail-rels');
        rels.forEach(function (r) {
          const li = el('li', 'graph-detail-rel');
          const btn = el('button', 'graph-rel-btn', r.label + ' ' + (r.other ? r.other.title : r.edge.b));
          btn.type = 'button';
          btn.addEventListener('click', function () { if (r.other) { select(r.other.key); centerOn(r.other.key); } });
          li.appendChild(btn);
          li.appendChild(el('div', 'graph-rel-note', r.note));
          ul.appendChild(li);
        });
        detail.appendChild(ul);
      }
    }

    // ---------- 交互事件 ----------
    function onWheel(ev) {
      ev.preventDefault();
      zoomAt(ev.clientX, ev.clientY, Math.pow(1.15, ev.deltaY > 0 ? 1 : -1));
    }
    function onPointerDown(ev) {
      if (ev.target.closest && ev.target.closest('.graph-node')) return;
      svg.setPointerCapture && svg.setPointerCapture(ev.pointerId);
      state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.pointers.size === 1) {
        state.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y };
      } else if (state.pointers.size === 2) {
        const pts = Array.from(state.pointers.values());
        state.pinch = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), w: state.view.w };
        state.drag = null;
      }
    }
    function onPointerMove(ev) {
      if (!state.pointers.has(ev.pointerId)) return;
      state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.pinch && state.pointers.size === 2) {
        const pts = Array.from(state.pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const targetW = Math.max(60, Math.min(lay.world.width * 2.5, state.pinch.w * state.pinch.dist / dist));
        zoomAt(mid.x, mid.y, targetW / state.view.w);
        return;
      }
      if (state.drag && ev.pointerId === state.drag.id) {
        const d = state.drag;
        const rect = svg.getBoundingClientRect();
        const dx = (ev.clientX - d.x) / rect.width * state.view.w;
        const dy = (ev.clientY - d.y) / rect.height * state.view.h;
        state.view.x = d.vx - dx;
        state.view.y = d.vy - dy;
        if (!state.raf) {
          state.raf = requestAnimationFrame(function () {
            state.raf = 0;
            if (!state.destroyed) applyView();
          });
        }
      }
    }
    function onPointerUp(ev) {
      state.pointers.delete(ev.pointerId);
      if (state.pointers.size < 2) state.pinch = null;
      if (state.drag && state.drag.id === ev.pointerId) state.drag = null;
    }
    function onSearchInput() {
      state.filters.query = search.value || '';
      render();
    }
    function onSearchKey(ev) {
      if (ev.key !== 'Enter') return;
      const q = state.filters.query.trim().toLowerCase();
      if (!q) return;
      const hit = model.nodes.find(function (n) {
        return n.title.toLowerCase().indexOf(q) !== -1 || n.refId.toLowerCase().indexOf(q) !== -1;
      });
      if (hit) { select(hit.key); centerOn(hit.key); }
    }
    function onListKey(ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const items = Array.from(listBox.querySelectorAll('.graph-list-item'));
      const i = items.indexOf(document.activeElement);
      if (i === -1) return;
      ev.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
      if (next) next.focus();
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    search.addEventListener('input', onSearchInput);
    search.addEventListener('keydown', onSearchKey);
    listBox.addEventListener('keydown', onListKey);
    btnReset.addEventListener('click', resetView);
    btnLocal.addEventListener('click', function () {
      if (!state.selected) return;
      state.localMode = !state.localMode;
      btnLocal.setAttribute('aria-pressed', state.localMode ? 'true' : 'false');
      btnLocal.classList.toggle('on', state.localMode);
      render();
      if (state.localMode) centerOn(state.selected, 500);
    });
    btnList.addEventListener('click', function () {
      state.listMode = !state.listMode;
      btnList.setAttribute('aria-pressed', state.listMode ? 'true' : 'false');
      btnList.classList.toggle('on', state.listMode);
      listBox.hidden = !state.listMode;
      svg.style.display = state.listMode ? 'none' : '';
      if (state.listMode) { const first = listBox.querySelector('.graph-list-item'); if (first) first.focus(); }
    });

    function destroy() {
      state.destroyed = true;
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      state.pointers.clear();
      state.drag = null;
      state.pinch = null;
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      search.removeEventListener('input', onSearchInput);
      search.removeEventListener('keydown', onSearchKey);
      listBox.removeEventListener('keydown', onListKey);
      root.innerHTML = '';
      root.classList.remove('graph-mounted');
    }

    resetView();
    render();
    window.__graphPerf = {
      modelMs: Math.round(t1 - t0), layoutMs: Math.round(t2 - t1),
      nodes: model.nodes.length, edges: model.edges.length,
      visibleEdges: currentSubgraph().edges.length
    };
    const instance = { destroy: destroy, state: state, model: model, select: select, centerOn: centerOn, resetView: resetView };
    active = instance;
    return instance;
  }

  window.GraphDemo = { mount: mount, unmount: unmount };
})();