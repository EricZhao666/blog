#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-2：知识图谱纯计算专项（无浏览器，直接 require 真实模块与真实索引）。
 *
 * 覆盖：节点去重 / 有向显式边 / 显式-系列-推断三类关系严格区分 / 孤立节点 / 示例标记 /
 * 类型与关系筛选 / 中文搜索 / 一跳局部 / 节点关系来源说明 / 展示层边裁剪如实标注 /
 * 确定性（同数据版本两次构建字节一致，与用户历史无关）/ 真实循环引用 /
 * 合成 500 与 1000 节点扩展能力（有限计算预算，实测计时输出供 GRAPH_EVAL 引用）。
 *
 * 用法：node tests/test60_knowledge_graph.js
 */
const path = require('path');
const fs = require('fs');
const KG = require(path.resolve(__dirname, '..', 'js', 'knowledge-graph.js'));
const Related = require(path.resolve(__dirname, '..', 'js', 'related.js'));
const INDEX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'content-links.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const model = KG.buildModel(INDEX, Related, {});

// ================================================================ 节点与关系
{
  const keys = model.nodes.map(n => n.key);
  check('G1 节点按稳定键去重（无重复 key）', new Set(keys).size === keys.length);
  check('G2 节点数与索引一致（195，含 7 类）', model.nodes.length === INDEX.nodes.length &&
    new Set(model.nodes.map(n => n.type)).size === 7, model.nodes.length);
  check('G3 显式边全部有向且与索引一致', model.edges.filter(e => e.kind === 'explicit').every(e => e.directed === true) &&
    model.stats.explicit === INDEX.stats.explicitEdges, model.stats.explicit);
  check('G4 同系列边与索引一致且无向', model.stats.series === INDEX.stats.seriesEdges &&
    model.edges.filter(e => e.kind === 'series').every(e => !e.directed && e.series));
  check('G5 推断关联 > 0 且全部标注非正文引用来源', model.stats.inferred > 0 &&
    model.edges.filter(e => e.kind === 'inferred').every(e => Array.isArray(e.reasons) && typeof e.score === 'number'));
  check('G6 无自环', !model.edges.some(e => e.a === e.b));
  const sigs = model.edges.map(e => e.kind + '|' + e.a + '|' + e.b + '|' + (e.via || e.series || ''));
  check('G7 关系确定性去重（无重复签名）', new Set(sigs).size === sigs.length);
  check('G8 推断边无向去重（a|b 码元序规范化）', model.edges.filter(e => e.kind === 'inferred').every(e => e.a < e.b));
  const exampleNodes = model.nodes.filter(n => n.example);
  check('G9 示例项目标记保留（6 个 example 项目）', exampleNodes.length === 6 && exampleNodes.every(n => n.type === 'project'), exampleNodes.length);
  check('G10 孤立节点如实统计（183）', model.stats.isolated === INDEX.stats.isolated && model.isolatedKeys.length === model.stats.isolated, model.stats.isolated);
  const iso = model.isolatedKeys[0];
  const isoRealEdges = (model.adjacency[iso] || []).filter(i => model.edges[i].kind !== 'inferred');
  check('G11 孤立节点仍在图谱中且无真实关系（孤立口径=无显式/系列，推断不计）',
    !!model.byKey[iso] && isoRealEdges.length === 0 && model.isolatedKeys.indexOf(iso) !== -1);
  check('G12 未解析引用计入统计但不生成节点', model.stats.unresolved === INDEX.stats.unresolved);
}

// ================================================================ 关系来源说明
{
  const rels = KG.nodeRelations(model, 'lib:matlab_backup');
  const incoming = rels.filter(r => r.edge.kind === 'explicit');
  check('G13 反向关系方向标注正确（← 引用本文）', incoming.length === 2 && incoming.every(r => r.label === '← 引用本文' && r.note === '正文站内链接'));
  const postRels = KG.nodeRelations(model, 'post:rl-from-mdp-to-ppo');
  const seriesRel = postRels.find(r => r.edge.kind === 'series');
  check('G14 同系列关系独立说明（非正文引用）', !!seriesRel && /系列：强化学习系列/.test(seriesRel.note) && /非正文引用/.test(seriesRel.note));
  const inferredRel = postRels.find(r => r.edge.kind === 'inferred');
  check('G15 推断关联明确标注算法推荐非正文引用', !!inferredRel && /算法推荐，非正文引用/.test(inferredRel.note));
  const out = KG.nodeRelations(model, 'post:robotics-textbook-notes').find(r => r.edge.kind === 'explicit');
  check('G16 正向引用标注（本文引用 →）', !!out && out.label === '本文引用 →');
}

// ================================================================ 筛选 / 搜索 / 一跳
{
  const f1 = KG.filterModel(model, { types: ['post'] });
  check('G17 类型筛选：仅 post 节点且边两端可见', f1.nodes.length === 18 && f1.nodes.every(n => n.type === 'post') &&
    f1.edges.every(e => model.byKey[e.a].type === 'post' && model.byKey[e.b].type === 'post'));
  const f2 = KG.filterModel(model, { kinds: ['explicit'] });
  check('G18 关系筛选：仅显式边', f2.edges.length === model.stats.explicit && f2.edges.every(e => e.kind === 'explicit'));
  const f3 = KG.filterModel(model, { kinds: ['inferred'] });
  check('G19 关系筛选：仅推断边', f3.edges.every(e => e.kind === 'inferred') && f3.edges.length === model.stats.inferred);
  const f4 = KG.filterModel(model, { query: 'SLAM' });
  check('G20 搜索命中（大小写不敏感，标题/ID）', f4.matches.length > 0 && f4.matches.every(k => /slam/i.test(model.byKey[k].title + model.byKey[k].refId)));
  const f5 = KG.filterModel(model, { query: '机器人' });
  check('G21 中文搜索命中', f5.matches.length > 0);
  const oh = KG.oneHop(model, 'post:rl-from-mdp-to-ppo');
  check('G22 一跳局部：中心 + 直接邻居', oh.center === 'post:rl-from-mdp-to-ppo' && oh.nodes.some(n => n.key === oh.center) &&
    oh.edges.every(e => e.a === oh.center || e.b === oh.center));
  const ohKeys = new Set(oh.nodes.map(n => n.key));
  check('G23 一跳邻居闭合（边的端点都在子图内）', oh.edges.every(e => ohKeys.has(e.a) && ohKeys.has(e.b)));
}

// ================================================================ 展示层裁剪
{
  const cap = KG.capEdges(model, 300);
  const realCount = model.stats.explicit + model.stats.series;
  check('G24 裁剪上限生效（可见边 ≤ 300）', cap.edges.length <= 300, cap.edges.length);
  check('G25 真实关系永不裁剪（显式+系列全在）', cap.edges.filter(e => e.kind !== 'inferred').length === realCount);
  check('G26 裁剪数量如实报告', cap.trimmedInferred === model.stats.inferred - cap.edges.filter(e => e.kind === 'inferred').length &&
    cap.totalInferred === model.stats.inferred);
  const capBig = KG.capEdges(model, 100000);
  check('G27 上限足够大时不裁剪', capBig.trimmedInferred === 0 && capBig.edges.length === model.edges.length);
  const tiny = KG.capEdges(model, 3);
  check('G28 极小上限仍保留全部真实关系（不宣称隐藏关系不存在）', tiny.edges.filter(e => e.kind !== 'inferred').length === realCount);
}

// ================================================================ 确定性与循环
{
  const m2 = KG.buildModel(INDEX, Related, {});
  check('G29 同数据版本两次构建 JSON 字节一致（与用户历史无关）', JSON.stringify(m2) === JSON.stringify(model));
  const l1 = KG.layout(model, {});
  const l2 = KG.layout(m2, {});
  check('G30 布局确定性（坐标完全一致）', JSON.stringify(l1) === JSON.stringify(l2));
  check('G31 布局覆盖全部节点', model.nodes.every(n => l1.positions[n.key] && isFinite(l1.positions[n.key].x) && isFinite(l1.positions[n.key].y)));
  const cyc = {
    schemaVersion: 1,
    nodes: [
      { key: 'post:x', type: 'post', refId: 'x', title: 'X', href: '#/post/x' },
      { key: 'post:y', type: 'post', refId: 'y', title: 'Y', href: '#/post/y' }
    ],
    explicit: [{ source: 'post:x', target: 'post:y', via: 'wikilink' }, { source: 'post:y', target: 'post:x', via: 'wikilink' }],
    series: [], bySource: {}, byTarget: {}, diagnostics: [],
    stats: { isolatedKeys: [] }
  };
  const cm = KG.buildModel(cyc, Related, {});
  check('G32 真实循环引用保留为两条有向边', cm.edges.filter(e => e.kind === 'explicit').length === 2);
  const noRel = KG.buildModel(INDEX, null, {});
  check('G33 Related 缺失时显式/系列仍在、推断为空（降级不误判无关联）', noRel.stats.explicit === model.stats.explicit && noRel.stats.inferred === 0);
}

// ================================================================ 合成扩展（500 / 1000）
function synthetic(n) {
  const types = KG.TYPE_ORDER;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const t = types[i % types.length];
    nodes.push({
      key: t + ':syn-' + i, type: t, refId: 'syn-' + i, title: '合成节点 ' + i + ' 号',
      href: '#/post/syn-' + i, tags: ['标签' + (i % 12), '公共标签'], category: '分类' + (i % 5),
      text: '这是合成节点 ' + i + ' 的摘要文本，用于扩展能力测量。'
    });
  }
  const explicit = [];
  for (let i = 0; i + 1 < n; i += 7) explicit.push({ source: nodes[i].key, target: nodes[i + 1].key, via: 'markdown' });
  return { schemaVersion: 1, nodes, explicit, series: [], bySource: {}, byTarget: {}, diagnostics: [], stats: { isolatedKeys: [] } };
}
[500, 1000].forEach(n => {
  const idx = synthetic(n);
  const t0 = performance.now();
  const m = KG.buildModel(idx, Related, {});
  const t1 = performance.now();
  const lay = KG.layout(m, {});
  const t2 = performance.now();
  const cap = KG.capEdges(m, 300);
  check('G-S' + n + '.1 合成 ' + n + ' 节点模型完整（节点/边/布局）', m.nodes.length === n && m.edges.length > 0 &&
    m.nodes.every(nd => lay.positions[nd.key]));
  check('G-S' + n + '.2 计算预算有限（模型+布局 < 5000ms）', (t2 - t0) < 5000, 'model=' + Math.round(t1 - t0) + 'ms layout=' + Math.round(t2 - t1) + 'ms');
  check('G-S' + n + '.3 展示裁剪生效（可见边 ≤ 300）', cap.edges.length <= 300, cap.edges.length);
  console.log('PERF synthetic ' + n + ': modelMs=' + Math.round(t1 - t0) + ' layoutMs=' + Math.round(t2 - t1) +
    ' edges=' + m.edges.length + ' inferred=' + m.stats.inferred + ' visible=' + cap.edges.length);
});

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);