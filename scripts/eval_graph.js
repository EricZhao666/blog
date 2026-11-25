#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-2：图谱性能与规模评估（生成 BATCH9B2_GRAPH_EVAL.csv 的 Node 侧实测数据）。
 * 全部为真实测量，不虚构性能改善。浏览器侧数据见 graph-experience 专项输出（R1.6）。
 *
 * 用法：node scripts/eval_graph.js [输出csv路径]
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const KG = require(path.resolve(__dirname, '..', 'js', 'knowledge-graph.js'));
const Related = require(path.resolve(__dirname, '..', 'js', 'related.js'));
const ROOT = path.resolve(__dirname, '..');
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'content-links.json'), 'utf8'));

const rows = [['metric', 'scope', 'value', 'unit', 'note']];
function add(metric, scope, value, unit, note) { rows.push([metric, scope, value, unit, note || '']); }

// 索引体积
const bytes = fs.statSync(path.join(ROOT, 'data', 'content-links.json')).size;
add('index_size', 'real', bytes, 'bytes', 'data/content-links.json');
add('nodes', 'real', INDEX.stats.nodes, 'count', '');
add('explicit_edges', 'real', INDEX.stats.explicitEdges, 'count', '有向');
add('series_edges', 'real', INDEX.stats.seriesEdges, 'count', '无向');
add('isolated_nodes', 'real', INDEX.stats.isolated, 'count', '无显式/系列（推断不计）');
add('unresolved_refs', 'real', INDEX.stats.unresolved, 'count', '');

// 构建耗时（--sync，含全部产物；固定 --now 排除 feed 时间戳影响）
const t0 = performance.now();
execFileSync('python', [path.join(ROOT, 'scripts', 'build_content.py'), '--sync', '--now', '2026-11-24T00:00:00+08:00'],
  { cwd: ROOT, encoding: 'utf8' });
add('build_sync_time', 'real', Math.round(performance.now() - t0), 'ms', '全产物 --sync（含索引生成）');

// 模型与布局（真实数据）
function measure(idx, label) {
  const a = performance.now();
  const m = KG.buildModel(idx, Related, {});
  const b = performance.now();
  const lay = KG.layout(m, {});
  const c = performance.now();
  const cap = KG.capEdges(m, 300);
  add('model_time', label, Math.round(b - a), 'ms', 'Related.recommend 全候选池');
  add('layout_time', label, Math.round(c - b), 'ms', '确定性 O(N) 类型簇螺旋');
  add('edges_total', label, m.edges.length, 'count', '');
  add('inferred_edges', label, m.stats.inferred, 'count', '无向去重后');
  add('visible_edges_cap300', label, cap.edges.length, 'count', '展示层裁剪');
  add('trimmed_inferred', label, cap.trimmedInferred, 'count', '如实标注');
  return m;
}
measure(INDEX, 'real');

// 合成扩展
function synthetic(n) {
  const types = KG.TYPE_ORDER;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const t = types[i % types.length];
    nodes.push({ key: t + ':syn-' + i, type: t, refId: 'syn-' + i, title: '合成节点 ' + i,
      href: '#/post/syn-' + i, tags: ['标签' + (i % 12), '公共标签'], category: '分类' + (i % 5),
      text: '合成节点 ' + i + ' 摘要文本。' });
  }
  const explicit = [];
  for (let i = 0; i + 1 < n; i += 7) explicit.push({ source: nodes[i].key, target: nodes[i + 1].key, via: 'markdown' });
  return { schemaVersion: 1, nodes, explicit, series: [], bySource: {}, byTarget: {}, diagnostics: [], stats: { isolatedKeys: [] } };
}
measure(synthetic(500), 'synthetic500');
measure(synthetic(1000), 'synthetic1000');

const out = process.argv[2] || path.join(ROOT, 'BATCH9B2_GRAPH_EVAL.csv');
fs.writeFileSync(out, '\uFEFF' + rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n', 'utf8');
console.log('已写入 ' + out + '（' + (rows.length - 1) + ' 行实测数据）');