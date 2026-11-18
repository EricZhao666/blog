'use strict';
/**
 * Batch 8D-4：性能与无障碍前后对比数据生成器
 *
 * 输入：
 *   tests/perf/reports/batch8d4-perf-before.json   （优化前基线，同一机器/同一网络整形/同一 Chromium）
 *   tests/perf/reports/batch8d4-perf-after.json    （优化后采集）
 *   tests/perf/reports/batch8d4-a11y-before.json   （优化前无障碍审计）
 *   tests/perf/reports/batch8d4-a11y-after.json    （优化后无障碍审计）
 *
 * 输出：
 *   tests/perf/reports/batch8d4-comparison.csv   （scenario,device,metric 逐指标对比 + 无障碍逐页对比）
 *   tests/perf/reports/batch8d4-comparison.json  （同内容结构化版本）
 *
 * 统计口径：
 *   - median / min / max 均来自 5 次采样的中位数与极差（summary.median 已由 perf.spec.js 计算，
 *     极差由本脚本从 samples 重新计算，用于「波动范围」列）；
 *   - delta = after - before（百分比相对 before）；无障碍为问题数差值；
 *   - 前后两组在同一环境采集，禁用不同网络/缓存/设备条件（任务硬约束）。
 */
const fs = require('fs');
const path = require('path');

const REPORTS = path.join(__dirname, 'reports');
const round = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : v;
const fmt = (v) => (v === undefined || v === null) ? '' : String(v);

function readJson(name) {
  const p = path.join(REPORTS, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 从样本数组提取某指标的 min/max（兼容 metrics 子对象与顶层字段两种样本形态）
function spreadOf(samples, metric) {
  const vals = [];
  for (const s of samples || []) {
    if (!s || s.ok === false) continue;
    const v = s.metrics ? s.metrics[metric] : s[metric];
    if (typeof v === 'number' && isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { min: null, max: null };
  return { min: round(Math.min(...vals)), max: round(Math.max(...vals)) };
}

function main() {
  const before = readJson('batch8d4-perf-before.json');
  const after = readJson('batch8d4-perf-after.json');
  const a11yBefore = readJson('batch8d4-a11y-before.json');
  const a11yAfter = readJson('batch8d4-a11y-after.json');
  if (!before) { console.error('缺少 before 基线'); process.exit(2); }
  if (!after) { console.error('缺少 after 数据'); process.exit(2); }

  const scenarios = Object.keys(before.scenarios || {});
  const rows = [];

  // 指标全集：before/after summary 键的并集（每键为 {median,min,max,unavailable,...}）
  const allKeys = new Set();
  for (const sc of scenarios) {
    for (const dev of ['desktop', 'mobile']) {
      const b = before.scenarios[sc] && before.scenarios[sc][dev];
      const a = after.scenarios[sc] && after.scenarios[sc][dev];
      for (const src of [b, a]) {
        if (src && src.summary) {
          for (const k of Object.keys(src.summary)) allKeys.add(k);
        }
      }
    }
  }

  for (const sc of scenarios) {
    for (const dev of ['desktop', 'mobile']) {
      const b = before.scenarios[sc] && before.scenarios[sc][dev];
      const a = after.scenarios[sc] && after.scenarios[sc][dev];
      if (!b) continue;
      const avail = !!(a && a.summary);
      for (const m of allKeys) {
        const sb = b.summary && b.summary[m];
        const sa = avail && a.summary && a.summary[m];
        const hasB = !!(sb && sb.unavailable !== true && typeof sb.median === 'number');
        const hasA = !!(sa && sa.unavailable !== true && typeof sa.median === 'number');
        if (!hasB && !hasA) continue;
        const bs = hasB ? { min: round(sb.min), max: round(sb.max) } : spreadOf(b.samples, m);
        const as = hasA ? { min: round(sa.min), max: round(sa.max) } : { min: null, max: null };
        const bMed = hasB ? round(sb.median) : null;
        const aMed = hasA ? round(sa.median) : null;
        const delta = (bMed !== null && aMed !== null && bMed !== 0)
          ? round(((aMed - bMed) / Math.abs(bMed)) * 100) : null;
        rows.push({
          kind: 'perf', scenario: sc, device: dev, metric: m,
          beforeMedian: bMed, beforeMin: bs.min, beforeMax: bs.max,
          afterMedian: aMed, afterMin: as.min, afterMax: as.max,
          deltaAbs: (bMed !== null && aMed !== null) ? round(aMed - bMed) : null,
          deltaPct: delta,
          note: avail ? '' : 'after 未采集'
        });
      }
      // 路由循环等所有 loop* 指标已包含在上面的并集遍历中，无需特殊处理
    }
  }

  // 无障碍对比（问题计数）
  const a11yRows = [];
  if (a11yBefore && a11yAfter) {
    const pages = Object.keys(a11yBefore.perPage || a11yBefore.pages || {});
    const beforePer = a11yBefore.perPage || {};
    const afterPer = a11yAfter.perPage || {};
    for (const p of pages) {
      const b = beforePer[p], a = afterPer[p];
      a11yRows.push({ kind: 'a11y', page: p, beforeIssues: b, afterIssues: a, delta: (b !== undefined && a !== undefined) ? a - b : null });
    }
    a11yRows.push({ kind: 'a11y', page: 'TOTAL', beforeIssues: a11yBefore.issueCountTotal, afterIssues: a11yAfter.issueCountTotal,
      delta: (a11yAfter.issueCountTotal || 0) - (a11yBefore.issueCountTotal || 0) });
  }

  // CSV
  const csvLines = [];
  csvLines.push('kind,scenario/device,metric,beforeMedian,beforeMin,beforeMax,afterMedian,afterMin,afterMax,deltaAbs,deltaPct,note');
  for (const r of rows) {
    csvLines.push([r.kind, r.scenario + '/' + r.device, r.metric,
      fmt(r.beforeMedian), fmt(r.beforeMin), fmt(r.beforeMax),
      fmt(r.afterMedian), fmt(r.afterMin), fmt(r.afterMax),
      fmt(r.deltaAbs), fmt(r.deltaPct), r.note].join(','));
  }
  for (const r of a11yRows) {
    csvLines.push([r.kind, r.page, 'issueCount',
      fmt(r.beforeIssues), '', '', fmt(r.afterIssues), '', '', fmt(r.delta), '', ''].join(','));
  }
  fs.writeFileSync(path.join(REPORTS, 'batch8d4-comparison.csv'), csvLines.join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(REPORTS, 'batch8d4-comparison.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), perfRows: rows, a11yRows }, null, 2), 'utf8');

  console.log('perf 对比行: ' + rows.length + '，a11y 对比行: ' + a11yRows.length);
  console.log('输出: tests/perf/reports/batch8d4-comparison.csv / .json');
}

main();
