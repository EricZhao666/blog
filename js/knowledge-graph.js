/**
 * knowledge-graph.js — Batch 9B-2 知识图谱纯计算模块（无 DOM，可在 Node 单测）。
 *
 * 输入：构建期引用索引 data/content-links.json（schemaVersion 1）+ Related（9B-1 算法，原样复用）。
 * 关系严格三分：
 *   explicit  正文显式引用（站内 Markdown 链接 / WikiLink），有向 source → target；
 *   series    真实 series 字段推导的同系列关系（无向，不等同于正文引用）；
 *   inferred  Related.recommend() 推断关联（算法推荐，绝不伪装成作者显式引用）。
 *
 * 推断候选池固定为索引内全部节点（同一数据版本 → 同一图谱，与用户浏览历史无关）。
 * 布局为确定性 O(N) 类型簇螺旋（黄金角 phyllotaxis），无随机、无力导向迭代、无 Date。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnowledgeGraph = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const TYPE_ORDER = ['post', 'course', 'paper', 'material', 'lib', 'project', 'note'];
  const KIND_ORDER = ['explicit', 'series', 'inferred'];
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const DEFAULT_INFERRED_LIMIT = 5;     // 与 9B-1 MAX_RESULTS 一致
  const DEFAULT_EDGE_CAP = 300;         // 展示层裁剪上限（只裁推断边；真实关系永不隐藏）

  function typeRank(t) { const i = TYPE_ORDER.indexOf(t); return i === -1 ? TYPE_ORDER.length : i; }

  /**
   * 构建图谱模型。index 为引用索引；Related 为 9B-1 模块（buildIndex/recommend）。
   * 返回 {nodes, edges, byKey, adjacency, stats, isolatedKeys}。全部确定性。
   */
  function buildModel(index, Related, opts) {
    opts = opts || {};
    const limit = opts.inferredLimit || DEFAULT_INFERRED_LIMIT;
    const nodes = (index.nodes || []).map(function (n) {
      return {
        key: n.key, type: n.type, refId: n.refId, title: n.title, href: n.href || '',
        tags: n.tags || [], category: n.category || '', series: n.series || '',
        text: n.text || '', example: !!n.example
      };
    });
    const byKey = Object.create(null);
    nodes.forEach(function (n) { byKey[n.key] = n; });

    const edges = [];
    const edgeSeen = new Set();
    function pushEdge(e) {
      const sig = e.kind + '|' + e.a + '|' + e.b + '|' + (e.via || e.series || '');
      if (edgeSeen.has(sig)) return;
      edgeSeen.add(sig);
      edges.push(e);
    }
    // 显式引用（有向；允许真实循环引用；自环已在构建期排除）
    (index.explicit || []).forEach(function (e) {
      if (!byKey[e.source] || !byKey[e.target] || e.source === e.target) return;
      pushEdge({ kind: 'explicit', a: e.source, b: e.target, via: e.via || 'markdown', directed: true });
    });
    // 同系列（无向）
    (index.series || []).forEach(function (e) {
      if (!byKey[e.a] || !byKey[e.b] || e.a === e.b) return;
      pushEdge({ kind: 'series', a: e.a, b: e.b, series: e.series || '', directed: false });
    });
    // 推断关联：固定候选池 = 索引全部节点；无向去重（取双向中较高分），保留推荐理由
    if (Related && typeof Related.buildIndex === 'function' && typeof Related.recommend === 'function') {
      const relIndex = Related.buildIndex(nodes);
      const inferredMap = new Map();
      nodes.forEach(function (n) {
        let recs = [];
        try { recs = Related.recommend(relIndex, n.key, { limit: limit }) || []; } catch (e) { recs = []; }
        recs.forEach(function (r) {
          if (!byKey[r.key] || r.key === n.key) return;
          const pair = n.key < r.key ? [n.key, r.key] : [r.key, n.key];
          const sig = pair[0] + '|' + pair[1];
          const prev = inferredMap.get(sig);
          if (!prev || r.score > prev.score) {
            inferredMap.set(sig, { kind: 'inferred', a: pair[0], b: pair[1], score: r.score, reasons: r.reasons || [], directed: false });
          }
        });
      });
      Array.from(inferredMap.keys()).sort().forEach(function (sig) { pushEdge(inferredMap.get(sig)); });
    }

    const adjacency = Object.create(null);
    nodes.forEach(function (n) { adjacency[n.key] = []; });
    edges.forEach(function (e, i) {
      if (adjacency[e.a]) adjacency[e.a].push(i);
      if (adjacency[e.b]) adjacency[e.b].push(i);
    });
    const isolatedKeys = (index.stats && index.stats.isolatedKeys) ||
      nodes.filter(function (n) { return !adjacency[n.key].length; }).map(function (n) { return n.key; }).sort();
    const stats = {
      nodes: nodes.length,
      explicit: edges.filter(function (e) { return e.kind === 'explicit'; }).length,
      series: edges.filter(function (e) { return e.kind === 'series'; }).length,
      inferred: edges.filter(function (e) { return e.kind === 'inferred'; }).length,
      isolated: isolatedKeys.length,
      unresolved: (index.diagnostics || []).filter(function (d) { return d.reason === 'unresolved-target'; }).length
    };
    return { nodes: nodes, edges: edges, byKey: byKey, adjacency: adjacency, stats: stats, isolatedKeys: isolatedKeys };
  }

  /**
   * 确定性布局：7 个类型簇均匀分布在圆周上，簇内黄金角螺旋。O(N)，无迭代收敛问题。
   * 返回 {positions: {key: {x, y}}, world: {width, height}}（世界坐标，中心为原点）。
   */
  function layout(model, opts) {
    opts = opts || {};
    const clusterRadius = opts.clusterRadius || 430;
    const spread = opts.spread || 26;
    const groups = Object.create(null);
    TYPE_ORDER.forEach(function (t) { groups[t] = []; });
    model.nodes.forEach(function (n) { (groups[n.type] || (groups[n.type] = [])).push(n.key); });
    const types = Object.keys(groups).sort(function (a, b) { return typeRank(a) - typeRank(b) || (a < b ? -1 : 1); });
    const positions = Object.create(null);
    let maxR = 0;
    types.forEach(function (t, ti) {
      const angle = (ti / types.length) * Math.PI * 2 - Math.PI / 2;
      const cx = Math.cos(angle) * clusterRadius;
      const cy = Math.sin(angle) * clusterRadius;
      const keys = groups[t];   // 节点顺序 = 索引顺序（已按 key 码元序），确定性
      keys.forEach(function (key, i) {
        const r = spread * Math.sqrt(i + 0.5);
        const a = i * GOLDEN_ANGLE;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        positions[key] = { x: x, y: y };
        const d = Math.sqrt(x * x + y * y);
        if (d > maxR) maxR = d;
      });
    });
    const size = Math.ceil((maxR + 60) * 2);
    return { positions: positions, world: { width: size, height: size } };
  }

  /** 展示层边裁剪：真实关系（explicit/series）永不隐藏；推断边按分数降序截断。
   *  返回 {edges, trimmedInferred, totalInferred}。trimmedInferred>0 时 UI 必须如实标注。 */
  function capEdges(model, cap) {
    cap = cap || DEFAULT_EDGE_CAP;
    const real = model.edges.filter(function (e) { return e.kind !== 'inferred'; });
    const inferred = model.edges.filter(function (e) { return e.kind === 'inferred'; })
      .sort(function (a, b) { return b.score - a.score || (a.a + '|' + a.b < b.a + '|' + b.b ? -1 : 1); });
    const room = Math.max(0, cap - real.length);
    const kept = inferred.slice(0, room);
    return { edges: real.concat(kept), trimmedInferred: inferred.length - kept.length, totalInferred: inferred.length };
  }

  /** 类型 / 关系筛选 + 文本搜索（title/refId，大小写不敏感）。返回 {nodes, edges, matches}。 */
  function filterModel(model, filters) {
    filters = filters || {};
    const types = filters.types && filters.types.length ? new Set(filters.types) : null;
    const kinds = filters.kinds && filters.kinds.length ? new Set(filters.kinds) : null;
    const q = String(filters.query || '').trim().toLowerCase();
    const nodeOk = function (n) { return !types || types.has(n.type); };
    const nodes = model.nodes.filter(nodeOk);
    const visible = new Set(nodes.map(function (n) { return n.key; }));
    const edges = model.edges.filter(function (e) {
      return (!kinds || kinds.has(e.kind)) && visible.has(e.a) && visible.has(e.b);
    });
    const matches = q ? nodes.filter(function (n) {
      return n.title.toLowerCase().indexOf(q) !== -1 || n.refId.toLowerCase().indexOf(q) !== -1;
    }).map(function (n) { return n.key; }) : [];
    return { nodes: nodes, edges: edges, matches: matches };
  }

  /** 一跳局部视图：选中节点 + 直接邻居 + 连接边。 */
  function oneHop(model, key) {
    const idxs = model.adjacency[key] || [];
    const neighborKeys = new Set([key]);
    const edges = [];
    idxs.forEach(function (i) {
      const e = model.edges[i];
      if (!e) return;
      edges.push(e);
      neighborKeys.add(e.a);
      neighborKeys.add(e.b);
    });
    const nodes = model.nodes.filter(function (n) { return neighborKeys.has(n.key); });
    return { nodes: nodes, edges: edges, center: key };
  }

  /** 节点详情：关联关系列表（含来源说明与有效跳转）。 */
  function nodeRelations(model, key) {
    const idxs = model.adjacency[key] || [];
    return idxs.map(function (i) {
      const e = model.edges[i];
      const otherKey = e.a === key ? e.b : e.a;
      const other = model.byKey[otherKey];
      let label, note;
      if (e.kind === 'explicit') {
        const outgoing = e.a === key;
        label = outgoing ? '本文引用 →' : '← 引用本文';
        note = e.via === 'wikilink' ? 'WikiLink 显式引用' : '正文站内链接';
      } else if (e.kind === 'series') {
        label = '同系列';
        note = '系列：' + e.series + '（非正文引用）';
      } else {
        label = '推断关联';
        note = (e.reasons && e.reasons.length ? e.reasons.join('；') : '元数据相似') + '（算法推荐，非正文引用）';
      }
      return { edge: e, other: other, label: label, note: note };
    }).sort(function (a, b) {
      const rank = { explicit: 0, series: 1, inferred: 2 };
      return rank[a.edge.kind] - rank[b.edge.kind] || (a.other.key < b.other.key ? -1 : 1);
    });
  }

  return {
    TYPE_ORDER: TYPE_ORDER, KIND_ORDER: KIND_ORDER,
    DEFAULT_EDGE_CAP: DEFAULT_EDGE_CAP, DEFAULT_INFERRED_LIMIT: DEFAULT_INFERRED_LIMIT,
    buildModel: buildModel, layout: layout, capEdges: capEdges,
    filterModel: filterModel, oneHop: oneHop, nodeRelations: nodeRelations
  };
});