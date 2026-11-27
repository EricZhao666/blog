#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2C：A* 与 Dijkstra 路径规划数学专项（直接 require js/path-planning.js）
 *
 * 期望值来源：
 *   1. 手工推导的小地图（无障碍四/八邻域、穿角限制、加权绕行、不可达、起终点重合）；
 *   2. 独立参考实现：无权地图用 BFS（边数最少），加权地图用 Bellman-Ford（全边松弛）；
 *   3. 固定种子的多组随机地图性质测试。
 *
 * 关键立场：A* 与 Dijkstra 互相比较**不能**证明两者都正确，因此 §P6 的判据是与
 * 独立的 BFS / Bellman-Ford 比对，而不是两个算法互相比对。
 *
 * 用法：node tests/test63_path_planning_math.js
 */
const path = require('path');
const P = require(path.resolve(__dirname, '..', 'js', 'path-planning.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-12 : eps);
const idx = (g, r, c) => r * g.cols + c;

function gridOf(lines) {
  const r = P.parseMap(lines);
  if (!r.ok) throw new Error('parse failed: ' + r.error);
  return r.grid;
}

/** 数值规格建图：0=障碍，1=普通地面，>1=地形权重（用于表示权重 ≥10 的地图）。 */
function gridFromSpec(spec) {
  const rows = spec.length, cols = spec[0].length;
  const g = P.makeGrid(rows, cols).grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = spec[r][c], i = r * cols + c;
      if (v === 0) g.blocked[i] = 1;
      else g.weights[i] = v;
    }
  }
  P.refreshMinWeight(g);
  return g;
}
function runD(g, opts) { return P.runDijkstra(g, opts); }
function runA(g, opts) { return P.runAStar(g, opts); }

// ================================================================ 独立参考实现
// 下面的邻居枚举与 Bellman-Ford 完全按规格重写，不调用被测模块的搜索函数。
const DIR4 = [[-1, 0], [0, 1], [1, 0], [0, -1]];
const DIR8 = DIR4.concat([[-1, 1], [1, 1], [1, -1], [-1, -1]]);

function refEdges(grid, nbh) {
  const dirs = nbh === 8 ? DIR8 : DIR4;
  const edges = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const u = r * grid.cols + c;
      if (grid.blocked[u]) continue;
      for (let k = 0; k < dirs.length; k++) {
        const dr = dirs[k][0], dc = dirs[k][1];
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) continue;
        const v = nr * grid.cols + nc;
        if (grid.blocked[v]) continue;
        const diagonal = dr !== 0 && dc !== 0;
        if (diagonal) {
          if (grid.blocked[r * grid.cols + nc]) continue;
          if (grid.blocked[nr * grid.cols + c]) continue;
        }
        edges.push({ u: u, v: v, w: (diagonal ? Math.SQRT2 : 1) * grid.weights[v] });
      }
    }
  }
  return edges;
}

function bellmanFord(grid, start, goal, nbh) {
  const N = grid.size;
  const dist = new Float64Array(N);
  for (let i = 0; i < N; i++) dist[i] = Infinity;
  dist[start] = 0;
  const edges = refEdges(grid, nbh);
  for (let it = 0; it < N - 1; it++) {
    let changed = false;
    for (let e = 0; e < edges.length; e++) {
      const ed = edges[e];
      if (dist[ed.u] === Infinity) continue;
      const nd = dist[ed.u] + ed.w;
      if (nd < dist[ed.v]) { dist[ed.v] = nd; changed = true; }
    }
    if (!changed) break;
  }
  return { dist: dist, reachable: dist[goal] !== Infinity, cost: dist[goal] };
}

/** 反向图（用于"到终点的最短距离"，作为启发函数可采纳性的独立上界）。 */
function bellmanFordToGoal(grid, goal, nbh) {
  const N = grid.size;
  const dist = new Float64Array(N);
  for (let i = 0; i < N; i++) dist[i] = Infinity;
  dist[goal] = 0;
  const fwd = refEdges(grid, nbh);
  const rev = fwd.map(e => ({ u: e.v, v: e.u, w: e.w }));
  for (let it = 0; it < N - 1; it++) {
    let changed = false;
    for (let e = 0; e < rev.length; e++) {
      const ed = rev[e];
      if (dist[ed.u] === Infinity) continue;
      const nd = dist[ed.u] + ed.w;
      if (nd < dist[ed.v]) { dist[ed.v] = nd; changed = true; }
    }
    if (!changed) break;
  }
  return dist;
}

function bfsMoves(grid, start, goal) {
  const N = grid.size;
  const dist = new Int32Array(N).fill(-1);
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    if (u === goal) break;
    const r = Math.floor(u / grid.cols), c = u % grid.cols;
    for (let k = 0; k < 4; k++) {
      const nr = r + DIR4[k][0], nc = c + DIR4[k][1];
      if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) continue;
      const v = nr * grid.cols + nc;
      if (grid.blocked[v] || dist[v] !== -1) continue;
      dist[v] = dist[u] + 1;
      queue.push(v);
    }
  }
  return dist[goal];
}

// 固定种子的独立随机地图（只用于构造输入，不参与求解）
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s ^= (s << 13); s >>>= 0;
    s ^= (s >>> 17);
    s ^= (s << 5); s >>>= 0;
    return s / 4294967296;
  };
}

function randomMap(seed, rows, cols, blockedP, weightP) {
  const made = P.makeGrid(rows, cols);
  if (!made.ok) throw new Error('grid failed');
  const g = made.grid;
  const rng = makeRng(seed);
  for (let i = 0; i < g.size; i++) {
    const roll = rng();
    if (roll < blockedP) g.blocked[i] = 1;
    else if (roll < blockedP + weightP) g.weights[i] = 2 + Math.floor(rng() * 5);
  }
  // 保证起点与终点可通行
  g.blocked[0] = 0; g.weights[0] = 1;
  g.blocked[g.size - 1] = 0; g.weights[g.size - 1] = 1;
  P.refreshMinWeight(g);
  return g;
}

// ================================================================ P1 地图与验证
{
  const made = P.makeGrid(3, 4);
  check('P1.1 3×4 地图创建：size=12，索引 r*cols+c（行 1 列 2 → 6）',
    made.ok && made.grid.size === 12 && P.indexOf(made.grid, 1, 2) === 6);
  check('P1.2 行列方向：rowOf(6)=1、colOf(6)=2（r 向下、c 向右，不互换）',
    P.rowOf(made.grid, 6) === 1 && P.colOf(made.grid, 6) === 2);
  check('P1.3 越界索引返回 -1', P.indexOf(made.grid, 3, 0) === -1 && P.indexOf(made.grid, -1, 0) === -1);

  check('P1.4 非法地图尺寸被拒绝（0 行 / 81 行 / 非整数）',
    P.makeGrid(0, 5).error === 'invalid-size' &&
    P.makeGrid(81, 5).error === 'invalid-size' &&
    P.makeGrid(2.5, 5).error === 'invalid-size');
  check('P1.5 地图上限 80×80 可用',
    P.makeGrid(80, 80).ok === true && P.LIMITS.maxRows === 80 && P.LIMITS.maxCols === 80);

  const bad = P.parseMap(['...', '..']);
  check('P1.6 字符地图行宽不一致被拒绝', !bad.ok && bad.error === 'invalid-cells');
  const badChar = P.parseMap(['..a']);
  check('P1.7 字符地图非法字符被拒绝', !badChar.ok && badChar.error === 'invalid-cells');

  const g = gridOf(['.#2', '...']);
  check('P1.8 字符地图解析：障碍物、权重 2、普通地面',
    g.blocked[idx(g, 0, 1)] === 1 && g.weights[idx(g, 0, 2)] === 2 && g.weights[idx(g, 1, 0)] === 1);
  check('P1.9 minWeight 取可通行格最小值（含权重 2 的地图 → 1）', g.minWeight === 1);

  const g2 = gridOf(['333', '333']);
  check('P1.10 全高代价地图 minWeight=3（取可通行格的最小权重）', g2.minWeight === 3);
}

// ================================================================ P2 地形权重与代价定义
{
  const g = gridOf(['.5.']);
  const d = runD(g, { start: 0, goal: 2, neighborhood: 4 });
  check('P2.1 cost(u,v)=base×weight(目标格)：进入权重 5 的格子记 5，合计 6',
    d.ok && near(d.cost, 6), d.cost);
  check('P2.2 独立重算路径代价与搜索累计值一致', near(P.pathCost(g, d.path), 6));
  check('P2.3 几何长度不含权重：2 步', near(d.geometricLength, 2));

  const g2 = gridOf(['.5.']);
  const back = runD(g2, { start: 2, goal: 0, neighborhood: 4 });
  check('P2.4 代价只由目标格决定，因此代价是可逆但不对称的：反向合计 5+1=6',
    near(back.cost, 6), back.cost);

  check('P2.5 权重 <1 被拒绝（不允许零代价或负代价）',
    P.setWeight(g2, 1, 0.5).error === 'invalid-weight');
  check('P2.6 非有限权重被拒绝（NaN / Infinity）',
    P.setWeight(g2, 1, NaN).error === 'invalid-weight' &&
    P.setWeight(g2, 1, Infinity).error === 'invalid-weight');
  check('P2.7 权重恰好为 1 允许，等价普通地面',
    P.setWeight(g2, 1, 1).ok === true && near(P.pathCost(g2, [0, 1]), 1));
  check('P2.8 障碍物不携带地形权重（置障后权重回到 1）',
    P.setBlocked(g2, 1, true).ok && g2.weights[1] === 1 && g2.blocked[1] === 1);

  // 负权边不存在：所有权重 ≥1，因此任意边的代价 > 0
  const g3 = randomMap(7, 6, 6, 0.25, 0.35);
  const edges = refEdges(g3, 8);
  check('P2.9 图上不存在非正权边（禁止负权）',
    edges.every(e => e.w > 0), 'edges=' + edges.length);
}

// ================================================================ P3 Dijkstra 手算用例
{
  const g = gridOf(['...', '...', '...']);
  const d = runD(g, { start: 0, goal: 8, neighborhood: 4 });
  check('P3.1 3×3 无障碍四邻域：最优代价 4、路径 5 个节点',
    d.status === 'found' && near(d.cost, 4) && d.pathNodes === 5 && d.path.length === 5);
  check('P3.2 无障碍地图上 Dijkstra 扩展全部 9 个节点（零信息优先队列）',
    d.expandedNodes === 9, 'expanded=' + d.expandedNodes);
  check('P3.3 发现节点数 = 可达节点数',
    d.discoveredNodes === 9, 'discovered=' + d.discoveredNodes);
  check('P3.4 记录完整搜索过程：trace 长度 = 扩展节点数',
    d.trace.length === d.expandedNodes && d.traceTruncated === false);
  check('P3.5 最后一步扩展的正是终点（以最小 g 出队才结束）',
    d.trace[d.trace.length - 1].node === 8);

  const g2 = gridOf(['.....']);
  const d2 = runD(g2, { start: 0, goal: 4, neighborhood: 4 });
  check('P3.6 1×5 直线：代价 4、路径唯一', near(d2.cost, 4) && d2.path.join(',') === '0,1,2,3,4');

  const g3 = gridOf(['.#...']);
  const d3 = runD(g3, { start: 0, goal: 4, neighborhood: 4 });
  check('P3.7 1×5 中间阻断：明确返回不可达状态，代价为空',
    d3.ok && d3.found === false && d3.status === 'unreachable' && d3.cost === null && d3.path.length === 0);
  check('P3.8 不可达时仍报告扩展与发现节点数（1×5 中起点被障碍封死：1/1）',
    d3.expandedNodes === 1 && d3.discoveredNodes === 1,
    d3.expandedNodes + '/' + d3.discoveredNodes);

  const g4 = gridOf(['..', '..']);
  const d4 = runD(g4, { start: 0, goal: 3, neighborhood: 4 });
  check('P3.9 同分路径按线性索引小者优先：0→1→3',
    d4.path.join(',') === '0,1,3', d4.path.join(','));

  const g5 = gridOf(['...', '...']);
  const d5 = runD(g5, { start: 4, goal: 4, neighborhood: 8 });
  check('P3.10 起点等于终点：代价 0、单节点路径、无扩展',
    d5.status === 'found' && d5.cost === 0 && d5.path.length === 1 &&
    d5.path[0] === 4 && d5.expandedNodes === 0 && d5.trace.length === 0);

  check('P3.11 起点被障碍物占据被拒绝', runD(g5, { start: 4, goal: 0, neighborhood: 4 }).error === 'start-blocked' ||
    (() => { P.setBlocked(g5, 4, true); const r = runD(g5, { start: 4, goal: 0, neighborhood: 4 }); P.setBlocked(g5, 4, false); return r.error === 'start-blocked'; })());

  const g6 = gridOf(['..#']);
  check('P3.12 终点被障碍物占据被拒绝',
    runD(g6, { start: 0, goal: 2, neighborhood: 4 }).error === 'goal-blocked');
  check('P3.13 起点/终点越界被拒绝',
    runD(g6, { start: -1, goal: 1, neighborhood: 4 }).error === 'invalid-start' &&
    runD(g6, { start: 0, goal: 99, neighborhood: 4 }).error === 'invalid-goal');
  check('P3.14 非法邻域被拒绝',
    runD(g6, { start: 0, goal: 1, neighborhood: 6 }).error === 'invalid-neighborhood');
}

// ================================================================ P4 八邻域与穿角规则
{
  const g = gridOf(['..', '..']);
  const d = runD(g, { start: 0, goal: 3, neighborhood: 8 });
  check('P4.1 2×2 八邻域：对角代价 √2 ≈ 1.41421356',
    near(d.cost, Math.SQRT2) && d.pathNodes === 2, d.cost);
  check('P4.2 八邻域几何长度与代价一致（权重全 1）',
    near(d.geometricLength, Math.SQRT2) && near(d.geometricLength, d.cost));

  const g2 = gridOf(['.#', '..']);
  const d2 = runD(g2, { start: 0, goal: 3, neighborhood: 8 });
  check('P4.3 禁止对角穿角：相邻正交格 (0,1) 被阻挡时对角边不存在，代价退回 2',
    near(d2.cost, 2) && d2.path.join(',') === '0,2,3', d2.cost + ' / ' + d2.path.join(','));

  const g3 = gridOf(['#.', '..']);
  const d3 = runD(g3, { start: 1, goal: 2, neighborhood: 8 });
  check('P4.4 另一侧正交格被阻挡同样禁止对角穿角',
    near(d3.cost, 2), d3.cost);

  const g4 = gridOf(['...', '...', '...']);
  const d4 = runD(g4, { start: 0, goal: 8, neighborhood: 8 });
  check('P4.5 3×3 八邻域：对角直达代价 2√2 ≈ 2.828、3 个节点',
    near(d4.cost, 2 * Math.SQRT2) && d4.pathNodes === 3, d4.cost);

  const blocked = gridOf(['..#.', '..#.', '..#.']);
  const r = runD(blocked, { start: 0, goal: 3, neighborhood: 8 });
  check('P4.6 整列阻挡时八邻域也不能穿墙', r.status === 'unreachable');
}

// ================================================================ P5 启发函数几何与适用条件
{
  check('P5.1 Manhattan(3,4)=7', P.manhattan(3, 4) === 7 && near(P.heuristicMetric('manhattan', 3, 4), 7));
  check('P5.2 Euclidean(3,4)=5', near(P.heuristicMetric('euclidean', 3, 4), 5));
  check('P5.3 Octile(3,4)=1+3√2 ≈ 5.24264069',
    near(P.heuristicMetric('octile', 3, 4), 1 + 3 * Math.SQRT2), P.heuristicMetric('octile', 3, 4));
  check('P5.4 零启发恒为 0', P.heuristicMetric('zero', 5, 7) === 0);

  check('P5.5 适用性：四邻域允许全部四种',
    P.heuristicAllowed('manhattan', 4) && P.heuristicAllowed('euclidean', 4) &&
    P.heuristicAllowed('octile', 4) && P.heuristicAllowed('zero', 4));
  check('P5.6 适用性：八邻域禁止 Manhattan（对角会高估）',
    P.heuristicAllowed('manhattan', 8) === false &&
    P.heuristicAllowed('octile', 8) && P.heuristicAllowed('euclidean', 8));

  const g = gridOf(['...', '...', '...']);
  const bad = runA(g, { start: 0, goal: 8, neighborhood: 8, heuristic: 'manhattan' });
  check('P5.7 八邻域直接使用 Manhattan 被拒绝，而不是给出次优解',
    !bad.ok && bad.error === 'heuristic-overestimates');
  check('P5.8 非法启发函数名被拒绝',
    runA(g, { start: 0, goal: 8, neighborhood: 4, heuristic: 'chebyshev' }).error === 'invalid-heuristic');

  // 可采纳性：h(n) ≤ 到终点的真实最短代价（参考值来自反向 Bellman-Ford）
  const maps = [
    gridOf(['....', '.##.', '....']),
    gridOf(['.2.3', '##4.', '..5.']),
    randomMap(11, 6, 7, 0.2, 0.4)
  ];
  let admOk = true, admDetail = '';
  for (const gm of maps) {
    for (const nbh of [4, 8]) {
      const goalIdx = gm.size - 1;
      const ref = bellmanFordToGoal(gm, goalIdx, nbh);
      const names = nbh === 4 ? ['manhattan', 'euclidean', 'octile', 'zero'] : ['octile', 'euclidean', 'zero'];
      for (const nm of names) {
        for (let i = 0; i < gm.size; i++) {
          if (gm.blocked[i] || ref[i] === Infinity) continue;
          const h = P.heuristicValue(nm, gm, i, goalIdx);
          if (h > ref[i] + 1e-9) {
            admOk = false;
            admDetail = nm + '/nbh' + nbh + '@' + i + ' h=' + h + ' ref=' + ref[i];
          }
        }
      }
    }
  }
  check('P5.9 可采纳性：所有允许组合的 h(n) ≤ 真实剩余代价（独立参考）', admOk, admDetail);

  // 一致性：h(u) ≤ cost(u,v) + h(v)，对每条边
  let consOk = true, consDetail = '';
  for (const gm of maps) {
    for (const nbh of [4, 8]) {
      const goalIdx = gm.size - 1;
      const names = nbh === 4 ? ['manhattan', 'euclidean', 'octile', 'zero'] : ['octile', 'euclidean', 'zero'];
      const edges = refEdges(gm, nbh);
      for (const nm of names) {
        for (const e of edges) {
          const hu = P.heuristicValue(nm, gm, e.u, goalIdx);
          const hv = P.heuristicValue(nm, gm, e.v, goalIdx);
          if (hu > e.w + hv + 1e-9) {
            consOk = false;
            consDetail = nm + '/nbh' + nbh + ' edge ' + e.u + '->' + e.v;
          }
        }
      }
    }
  }
  check('P5.10 一致性：h(u) ≤ cost(u,v)+h(v)（加权地形下按 minWeight 缩放的直接检验）', consOk, consDetail);

  // 加权地形缩放下界：minWeight=3 的地图上 h 应放大 3 倍
  const w3 = gridOf(['333', '333']);
  check('P5.11 加权缩放下界：minWeight=3 时 h 按 3 倍缩放（Manhattan 3 → 9）',
    near(P.heuristicValue('manhattan', w3, 0, 5), 9), P.heuristicValue('manhattan', w3, 0, 5));
}

// ================================================================ P6 独立最优性验证（BFS / Bellman-Ford）
{
  // 无权四邻域：与 BFS 的最少步数一致
  let bfsOk = true, bfsDetail = '';
  for (let seed = 1; seed <= 8; seed++) {
    const g = randomMap(seed, 6, 6, 0.28, 0);   // 只放障碍，权重全 1
    const start = 0, goal = g.size - 1;
    const ref = bfsMoves(g, start, goal);
    const d = runD(g, { start: start, goal: goal, neighborhood: 4 });
    if (ref === -1) {
      if (d.status !== 'unreachable') { bfsOk = false; bfsDetail = 'seed' + seed + ' 期望不可达'; }
    } else if (!near(d.cost, ref)) {
      bfsOk = false; bfsDetail = 'seed' + seed + ' dijkstra=' + d.cost + ' bfs=' + ref;
    }
  }
  check('P6.1 无权地图：Dijkstra 代价 = 独立 BFS 最少步数（8 组固定种子）', bfsOk, bfsDetail);

  // 加权地图：与 Bellman-Ford 一致（四邻域与八邻域各测）
  let bfOk = true, bfDetail = '';
  for (let seed = 21; seed <= 28; seed++) {
    const g = randomMap(seed, 7, 7, 0.22, 0.4);
    const start = 0, goal = g.size - 1;
    for (const nbh of [4, 8]) {
      const ref = bellmanFord(g, start, goal, nbh);
      const d = runD(g, { start: start, goal: goal, neighborhood: nbh });
      const a = runA(g, { start: start, goal: goal, neighborhood: nbh });
      if (!ref.reachable) {
        if (d.status !== 'unreachable' || a.status !== 'unreachable') {
          bfOk = false; bfDetail = 'seed' + seed + '/nbh' + nbh + ' 期望不可达';
        }
      } else if (!near(d.cost, ref.cost, 1e-9) || !near(a.cost, ref.cost, 1e-9)) {
        bfOk = false;
        bfDetail = 'seed' + seed + '/nbh' + nbh + ' bf=' + ref.cost + ' d=' + d.cost + ' a=' + a.cost;
      }
    }
  }
  check('P6.2 加权地图：Dijkstra 与 A* 的代价都等于独立 Bellman-Ford（8 种子 × 2 运动模型）', bfOk, bfDetail);

  // 手工加权用例：几何最短 ≠ 代价最低
  const costly = P.loadScenario('costly');
  const direct = runD(costly.grid, { start: costly.start, goal: costly.goal, neighborhood: 4 });
  check('P6.3 高代价地形：最优代价 18（绕行 18 步），直穿 10 步需 34',
    near(direct.cost, 18) && near(direct.geometricLength, 18) && direct.pathNodes === 19,
    'cost=' + direct.cost + ' geo=' + direct.geometricLength);
  const straightCost = 1 * 3 + 9 * 3 + 1 * 4;
  check('P6.4 直穿代价独立手算 = 3×1 + 3×9 + 4×1 = 34，确实高于绕行',
    straightCost === 34 && direct.cost < straightCost);

  // 与 BFS 的对照：八邻域无权地图上 Bellman-Ford 与 Dijkstra 一致（交叉验证参考实现本身）
  const g8 = randomMap(33, 6, 6, 0.25, 0);
  let crossOk = true;
  for (const nbh of [4, 8]) {
    const bf = bellmanFord(g8, 0, g8.size - 1, nbh);
    const d = runD(g8, { start: 0, goal: g8.size - 1, neighborhood: nbh });
    if (bf.reachable !== d.found) crossOk = false;
    if (bf.reachable && !near(bf.cost, d.cost, 1e-9)) crossOk = false;
  }
  check('P6.5 参考实现自检：无权地图上 Bellman-Ford 与 Dijkstra 一致', crossOk);
}

// ================================================================ P7 A* 契约
{
  const g = gridOf(['...', '...', '...']);
  const d = runD(g, { start: 0, goal: 8, neighborhood: 4 });
  const a = runA(g, { start: 0, goal: 8, neighborhood: 4, heuristic: 'manhattan' });
  check('P7.1 3×3 四邻域 Manhattan：A* 与 Dijkstra 代价同为 4',
    a.status === 'found' && near(a.cost, 4) && near(a.cost, d.cost));
  check('P7.2 A* 扩展节点数不多于 Dijkstra（h=Manhattan 在无障碍地图上恰好精确）',
    a.expandedNodes <= d.expandedNodes, a.expandedNodes + ' vs ' + d.expandedNodes);

  const open = P.loadScenario('open-field');
  const ad = runD(open.grid, { start: open.start, goal: open.goal, neighborhood: 8 });
  const aa = runA(open.grid, { start: open.start, goal: open.goal, neighborhood: 8, heuristic: 'octile' });
  check('P7.3 12×12 无障碍八邻域：代价 11√2 ≈ 15.5563，两者一致',
    near(ad.cost, 11 * Math.SQRT2) && near(aa.cost, ad.cost), aa.cost);
  check('P7.4 Octile 在对角直线地图上精确：A* 只扩展路径上的 12 个节点（11 步对角）',
    aa.expandedNodes === 12 && aa.pathNodes === 12 && aa.expandedNodes < ad.expandedNodes,
    'astar=' + aa.expandedNodes + ' dijkstra=' + ad.expandedNodes);

  const zero = runA(open.grid, { start: open.start, goal: open.goal, neighborhood: 8, heuristic: 'zero' });
  check('P7.5 零启发函数与 Dijkstra 完全等价：代价、扩展数、发现数逐一相同',
    near(zero.cost, ad.cost) && zero.expandedNodes === ad.expandedNodes &&
    zero.discoveredNodes === ad.discoveredNodes && zero.path.join(',') === ad.path.join(','),
    zero.expandedNodes + '/' + ad.expandedNodes);

  const eu = runA(open.grid, { start: open.start, goal: open.goal, neighborhood: 8, heuristic: 'euclidean' });
  check('P7.6 Euclidean 在八邻域下是可采纳的低估启发函数，代价仍最优',
    near(eu.cost, ad.cost) && eu.expandedNodes >= aa.expandedNodes);

  const oct4 = runA(open.grid, { start: open.start, goal: open.goal, neighborhood: 4, heuristic: 'octile' });
  const d4 = runD(open.grid, { start: open.start, goal: open.goal, neighborhood: 4 });
  check('P7.7 四邻域下 Octile 是允许的低估，代价与 Dijkstra 一致（22）',
    near(oct4.cost, 22) && near(oct4.cost, d4.cost), oct4.cost);
}

// ================================================================ P8 A*/Dijkstra 最优代价一致性（多地图）
{
  let sameOk = true, detail = '';
  const cases = [P.loadScenario('open-field'), P.loadScenario('walls'), P.loadScenario('corner')];
  for (const s of cases) {
    for (const nbh of [4, 8]) {
      const heur = nbh === 8 ? 'octile' : 'manhattan';
      const c = P.compare(s.grid, { start: s.start, goal: s.goal, neighborhood: nbh, heuristic: heur });
      if (!c.ok || !c.sameCost) { sameOk = false; detail = s.id + '/nbh' + nbh; }
    }
  }
  for (let seed = 41; seed <= 48; seed++) {
    const g = randomMap(seed, 8, 8, 0.2, 0.3);
    for (const nbh of [4, 8]) {
      const c = P.compare(g, { start: 0, goal: g.size - 1, neighborhood: nbh });
      if (!c.ok) continue;
      if (c.dijkstra.found && !c.sameCost) { sameOk = false; detail = 'seed' + seed + '/nbh' + nbh; }
      if (c.dijkstra.found !== c.astar.found) { sameOk = false; detail = 'seed' + seed + '/nbh' + nbh + ' 可达性不一致'; }
    }
  }
  check('P8.1 同地图同约束：A* 与 Dijkstra 最优代价一致（5 场景 + 8 随机地图 × 2 模型）', sameOk, detail);

  const c = P.compare(P.loadScenario('unreachable').grid,
    { start: P.loadScenario('unreachable').start, goal: P.loadScenario('unreachable').goal, neighborhood: 8 });
  check('P8.2 不可达时两个算法都返回不可达，且一致',
    c.ok && c.dijkstra.status === 'unreachable' && c.astar.status === 'unreachable' && c.sameCost === true);
  check('P8.3 不可达时也记录完整搜索过程（trace 非空）',
    c.dijkstra.trace.length > 0 && c.astar.trace.length > 0);

  const err = P.compare(gridOf(['..#']), { start: 0, goal: 2, neighborhood: 4 });
  check('P8.4 输入非法时 compare 返回失败而不是伪造结果',
    !err.ok && err.error === 'goal-blocked' && err.dijkstra && err.dijkstra.ok === false);
}

// ================================================================ P9 过期条目、同分与确定性
{
  // 构造"先以对角线 14.14 发现、后被正交 11 改进"的过期条目场景
  const g = gridOf(['..', '.9']);
  const d = runD(g, { start: 0, goal: 3, neighborhood: 8 });
  check('P9.1 过期条目被正确处理：目标先以 √2×9=12.7279 入队，后被 1+9=10 改进',
    near(d.cost, 10) && d.expandedNodes === 4, 'cost=' + d.cost + ' expanded=' + d.expandedNodes);
  check('P9.2 改进后父节点指向更优来源（0→1→3）', d.path.join(',') === '0,1,3', d.path.join(','));
  check('P9.3 松弛次数大于发现节点数（说明确实发生过重复入队）',
    d.relaxedEdges > d.discoveredNodes, d.relaxedEdges + ' / ' + d.discoveredNodes);
  check('P9.4 每个节点最多被扩展一次（扩展数 ≤ 发现数）',
    d.expandedNodes <= d.discoveredNodes && d.expandedNodes === 4);

  const g2 = gridOf(['.', '.']);
  const tie = runD(g2, { start: 0, goal: 1, neighborhood: 4 });
  check('P9.5 同分路径确定性：1×2 直线唯一解', tie.path.join(',') === '0,1');

  const run1 = runD(g, { start: 0, goal: 3, neighborhood: 8 });
  const run2 = runD(g, { start: 0, goal: 3, neighborhood: 8 });
  check('P9.6 同一输入重复运行结果完全一致（路径、代价、扩展数、trace 长度）',
    run1.path.join(',') === run2.path.join(',') && run1.cost === run2.cost &&
    run1.expandedNodes === run2.expandedNodes && run1.trace.length === run2.trace.length);
  check('P9.7 同一输入多次 A* 运行结果一致',
    (() => {
      const a1 = runA(g, { start: 0, goal: 3, neighborhood: 8, heuristic: 'octile' });
      const a2 = runA(g, { start: 0, goal: 3, neighborhood: 8, heuristic: 'octile' });
      return a1.path.join(',') === a2.path.join(',') && a1.cost === a2.cost;
    })());

  // 同分选择：两条等长路径时取索引小的分支
  const g3 = gridOf(['...', '...', '...']);
  const d3 = runD(g3, { start: 0, goal: 8, neighborhood: 4 });
  check('P9.8 同分按索引优先得到稳定的路径形状（0,1,2,5,8）',
    d3.path.join(',') === '0,1,2,5,8', d3.path.join(','));
}

// ================================================================ P10 搜索过程记录与统计语义
{
  const g = gridOf(['....', '.##.', '....']);
  for (const nbh of [4, 8]) {
    const d = runD(g, { start: 0, goal: g.size - 1, neighborhood: nbh });
    const open = new Set([0]);
    const closed = new Set();
    let traceOk = true, why = '';
    for (let i = 0; i < d.trace.length; i++) {
      const st = d.trace[i];
      if (closed.has(st.node)) { traceOk = false; why = 'step' + i + ' 重复扩展'; }
      open.delete(st.node);
      closed.add(st.node);
      if (st.openSize !== open.size) { traceOk = false; why = 'step' + i + ' open ' + st.openSize + '≠' + open.size; }
      if (st.closedSize !== closed.size) { traceOk = false; why = 'step' + i + ' closed ' + st.closedSize + '≠' + closed.size; }
      for (const p of st.pushes) open.add(p);
    }
    check('P10.' + (nbh === 4 ? '1' : '2') + ' 回放记录自洽：逐步重放得到的 open/closed 数量与记录一致（' + nbh + ' 邻域）',
      traceOk, why);
  }

  const d = runD(g, { start: 0, goal: g.size - 1, neighborhood: 8 });
  check('P10.3 扩展节点 = 出队并处理；发现节点 = 曾获得有限 g（发现数 ≥ 扩展数）',
    d.discoveredNodes >= d.expandedNodes && d.discoveredNodes <= g.size);
  check('P10.4 峰值 open 集合大小不超过发现节点数',
    d.maxOpen <= d.discoveredNodes && d.maxOpen >= 1);
  check('P10.5 路径节点数等于 path 长度，且与 geometricLength 口径分开',
    d.pathNodes === d.path.length && near(d.geometricLength, P.geometricLength(g, d.path)));
  check('P10.6 运行时间非负且为有限数（单次测量，不代表普遍加速）',
    isFinite(d.timeMs) && d.timeMs >= 0);
  check('P10.7 回放记录上限为 8000，且当前地图未触发裁剪',
    P.LIMITS.maxTrace === 8000 && d.traceTruncated === false);
}

// ================================================================ P11 路径合法性校验
{
  const g = gridOf(['...', '.5.', '...']);
  const d = runD(g, { start: 0, goal: 8, neighborhood: 8 });
  check('P11.1 合法路径校验通过', P.validatePath(g, d.path, { start: 0, goal: 8, neighborhood: 8 }).ok);

  const skip = [0, 8];
  check('P11.2 跳过中间节点被识别为不相邻',
    P.validatePath(g, skip, { start: 0, goal: 8, neighborhood: 4 }).errors.indexOf('not-adjacent') !== -1);

  const g2 = gridOf(['.#.', '...', '...']);
  check('P11.3 路径穿过障碍物被识别',
    P.validatePath(g2, [1, 0, 3], { start: 1, goal: 3, neighborhood: 8 }).errors.indexOf('blocked') !== -1);

  const g3 = gridOf(['...', '...', '...']);
  check('P11.4 四邻域路径里出现对角步被识别',
    P.validatePath(g3, [0, 4], { start: 0, goal: 4, neighborhood: 4 }).errors.indexOf('diagonal-not-allowed') !== -1);

  const g4 = gridOf(['.#', '..']);
  check('P11.5 穿角对角步被识别（即使两端都是可通行格）',
    P.validatePath(g4, [0, 3], { start: 0, goal: 3, neighborhood: 8 }).errors.indexOf('corner-cut') !== -1);

  check('P11.6 重复节点被识别',
    P.validatePath(g3, [0, 1, 0], { start: 0, goal: 0, neighborhood: 4 }).errors.indexOf('duplicate') !== -1);

  check('P11.7 起终点不符被识别',
    P.validatePath(g3, [0, 1, 2], { start: 0, goal: 8, neighborhood: 4 }).errors.indexOf('bad-goal') !== -1);

  // 路径代价独立重算：对随机地图也成立
  let recOk = true, recDetail = '';
  for (let seed = 61; seed <= 66; seed++) {
    const gm = randomMap(seed, 7, 7, 0.2, 0.35);
    const r = runD(gm, { start: 0, goal: gm.size - 1, neighborhood: 8 });
    if (!r.found) continue;
    if (!near(P.pathCost(gm, r.path), r.cost, 1e-9)) {
      recOk = false; recDetail = 'seed' + seed + ' path=' + P.pathCost(gm, r.path) + ' cost=' + r.cost;
    }
  }
  check('P11.8 路径代价独立重算 = 搜索累计代价（6 组随机地图）', recOk, recDetail);

  // 父节点回溯无循环：正常地图上路径无重复；人为构造的循环父指针必须被拒绝
  check('P11.9 父节点回溯：正常路径无重复节点，首尾等于起终点', (() => {
    const gm = randomMap(77, 8, 8, 0.15, 0.3);
    const r = runD(gm, { start: 0, goal: gm.size - 1, neighborhood: 8 });
    if (!r.found) return true;
    const set = new Set(r.path);
    return set.size === r.path.length && r.path[0] === 0 && r.path[r.path.length - 1] === gm.size - 1;
  })());
  check('P11.10 父指针成环时 reconstruct 返回 null（不会死循环）', (() => {
    const g = gridOf(['...']);
    const parent = new Int32Array([-1, 2, 1]);   // 1 ↔ 2 互为父节点
    return P.reconstruct(g, parent, 0, 2) === null;
  })());
}

// ================================================================ P12 浮点比较
{
  check('P12.1 同代价浮点比较容差：√2 与 11 位小数近似视为相等',
    P.sameCost(Math.SQRT2, 1.41421356237) === true);
  check('P12.2 明显不同的代价不视为相等', P.sameCost(1, 1.001) === false);
  check('P12.3 空值比较：都为空算一致，一空一非空算不一致',
    P.sameCost(null, null) === true && P.sameCost(null, 3) === false);
  check('P12.4 八邻域路径代价与逐步求和一致（√2 累加不漂移到 1e-9 以上）', (() => {
    const g = gridOf(['.....', '.....', '.....']);
    const d = runD(g, { start: 0, goal: 14, neighborhood: 8 });
    let manual = 0;
    for (let i = 1; i < d.path.length; i++) {
      const a = d.path[i - 1], b = d.path[i];
      const dr = Math.abs(Math.floor(a / 5) - Math.floor(b / 5));
      const dc = Math.abs((a % 5) - (b % 5));
      manual += (dr && dc ? Math.SQRT2 : 1);
    }
    return near(manual, d.cost, 1e-12);
  })());
}

// ================================================================ P13 教学场景
{
  const list = P.scenarioList();
  check('P13.1 至少 5 个确定性教学场景，id 唯一', list.length >= 5 &&
    new Set(list.map(s => s.id)).size === list.length, 'n=' + list.length);
  check('P13.2 每个场景都有预期观察说明（不预设算法优劣结论）',
    list.every(s => typeof s.note === 'string' && s.note.length > 10));

  const ids = list.map(s => s.id);
  check('P13.3 覆盖：开放地图 / 墙体通道 / 高代价地形 / 不可达 / 对角穿角',
    ['open-field', 'walls', 'costly', 'unreachable', 'corner'].every(id => ids.indexOf(id) !== -1));

  const open = P.loadScenario('open-field');
  check('P13.4 场景载入返回独立副本（编辑不影响场景定义）', (() => {
    P.setBlocked(open.grid, 5, true);
    const again = P.loadScenario('open-field');
    return again.grid.blocked[5] === 0;
  })());

  const walls = P.loadScenario('walls');
  const wd = runD(walls.grid, { start: walls.start, goal: walls.goal, neighborhood: 4 });
  check('P13.5 墙体场景：必须绕到通道，四邻域代价 19', near(wd.cost, 19), wd.cost);

  const un = P.loadScenario('unreachable');
  const ud = runD(un.grid, { start: un.start, goal: un.goal, neighborhood: 8 });
  check('P13.6 不可达场景：八邻域也无法进入封闭区（穿角规则同样生效）',
    ud.status === 'unreachable');

  const corner = P.loadScenario('corner');
  const cd = runD(corner.grid, { start: corner.start, goal: corner.goal, neighborhood: 8 });
  check('P13.7 穿角场景：代价 2 而非 √2，路径含 3 个节点',
    near(cd.cost, 2) && cd.pathNodes === 3, cd.cost);

  check('P13.8 未知场景 id 返回错误', P.loadScenario('nope').error === 'invalid-grid');

  const r1 = P.randomGrid(12345, 14, 14);
  const r2 = P.randomGrid(12345, 14, 14);
  check('P13.9 固定种子随机地图可复现：障碍与权重逐格一致',
    r1.ok && r2.ok && r1.grid.blocked.join(',') === r2.grid.blocked.join(',') &&
    r1.grid.weights.join(',') === r2.grid.weights.join(','));
  const r3 = P.randomGrid(999, 14, 14);
  check('P13.10 不同种子生成不同地图',
    r1.grid.blocked.join(',') !== r3.grid.blocked.join(','));
  check('P13.11 随机地图的起终点可通行',
    r1.grid.blocked[r1.start] === 0 && r1.grid.blocked[r1.goal] === 0);
}

// ================================================================ P14 规模上限与性能
{
  const big = P.makeGrid(80, 80);
  check('P14.1 80×80 地图可创建（6400 格）', big.ok && big.grid.size === 6400);

  const g = big.grid;
  const t0 = Date.now();
  const d = runD(g, { start: 0, goal: g.size - 1, neighborhood: 8 });
  const elapsed = Date.now() - t0;
  check('P14.2 80×80 八邻域最坏情况一次求解在 5 秒内完成',
    d.status === 'found' && near(d.cost, 79 * Math.SQRT2, 1e-9) && elapsed < 5000,
    elapsed + 'ms / cost=' + d.cost.toFixed(6));
  check('P14.3 80×80 记录未触发裁剪上限（6400 < 8000）', d.traceTruncated === false);
}

// ================================================================ P15 优先队列不变式（9C-2C 合并前修订）
//
// 缺陷形态：堆条目只保存节点索引，比较器读外部可变的 dist/gScore。松弛把某个节点的
// 代价改小以后，它在堆里的**旧条目**键也跟着变小，但堆结构没有执行 decrease-key，
// 于是"父键 ≤ 子键"被破坏，出队可能不是当前最小值。
// 下面两个地图是修复前由实际模块跑出的确定性反例（A* 返回次优代价）。
{
  // 反例一：5×6 全高代价地形，八邻域；修复前 A* 返回 13.071067811865477
  const gA = gridOf(['..7.93', '27348.', '.748.9', '9.4.2.', '7.9.3.']);
  const dA = runD(gA, { start: 0, goal: gA.size - 1, neighborhood: 8 });
  const aA = runA(gA, { start: 0, goal: gA.size - 1, neighborhood: 8 });
  check('P15.1 堆序反例一（5×6 加权八邻域）：A* 与 Dijkstra 同为 12.828427124746192（修复前 A* 曾为 13.0710678）',
    near(dA.cost, 12.828427124746192, 1e-12) && near(aA.cost, dA.cost, 1e-12), aA.cost);
  check('P15.2 反例一的路径代价可被独立重算，且等于 Bellman-Ford 参考值',
    near(P.pathCost(gA, aA.path), aA.cost, 1e-9) &&
    near(bellmanFord(gA, 0, gA.size - 1, 8).cost, aA.cost, 1e-9));

  // 反例二：含权重 10（单字符地图无法表示，用数值规格）；修复前 A* 返回 10.485281374238571
  const gB = gridFromSpec([
    [1, 3, 6, 0, 2, 0],
    [4, 1, 7, 2, 3, 1],
    [1, 10, 3, 1, 1, 4],
    [1, 0, 1, 1, 0, 4],
    [1, 1, 1, 1, 10, 1],
    [0, 1, 0, 7, 1, 1]
  ]);
  const dB = runD(gB, { start: 0, goal: gB.size - 1, neighborhood: 8 });
  const aB = runA(gB, { start: 0, goal: gB.size - 1, neighborhood: 8 });
  check('P15.3 堆序反例二（含权重 10 的 6×6）：A* 与 Dijkstra 同为 10.242640687119286（修复前 A* 曾为 10.4852814）',
    near(dB.cost, 10.242640687119286, 1e-12) && near(aB.cost, dB.cost, 1e-12), aB.cost);

  // 堆序不变式：出队的键必须单调不减（Dijkstra 看 g，A* 看 f）。
  // 容差 1e-12 只吸收"同分路径浮点求和顺序"带来的 1 ULP 级差异。
  let monoD = true, monoA = true, whyD = '', whyA = '';
  const badReexpand = [];
  for (let seed = 101; seed <= 220; seed++) {
    const gm = randomMap(seed, 10, 10, 0.12, 0.5);
    for (const nbh of [4, 8]) {
      const d = runD(gm, { start: 0, goal: gm.size - 1, neighborhood: nbh });
      const a = runA(gm, { start: 0, goal: gm.size - 1, neighborhood: nbh });
      let prev = -Infinity;
      for (const st of d.trace) {
        if (st.g < prev - 1e-12) { monoD = false; whyD = 'seed' + seed + '/nbh' + nbh; }
        prev = st.g;
      }
      prev = -Infinity;
      for (const st of a.trace) {
        if (st.f < prev - 1e-12) { monoA = false; whyA = 'seed' + seed + '/nbh' + nbh; }
        prev = st.f;
      }
      // 同一节点再次扩展必须是"更小的 g"，绝不能是相同或更差的键
      for (const res of [d, a]) {
        const seen = new Map();
        for (const st of res.trace) {
          if (seen.has(st.node) && !(st.g < seen.get(st.node))) {
            badReexpand.push('seed' + seed + '/nbh' + nbh + '/节点' + st.node);
          }
          seen.set(st.node, st.g);
        }
      }
    }
  }
  check('P15.4 Dijkstra 出队键 g 单调不减（120 张随机加权地图 × 2 运动模型）', monoD, whyD);
  check('P15.5 A* 出队键 f 单调不减（一致启发函数下的最小出队判据）', monoA, whyA);
  check('P15.6 同一节点被再次扩展时一定是更小的 g（否则即非最小出队）',
    badReexpand.length === 0, badReexpand.slice(0, 2).join(' | '));

  // 堆序正确性之外，最终代价仍要与独立参考一致（两类判据分开，互不替代）
  let costOk = true, costWhy = '';
  for (let seed = 101; seed <= 180; seed++) {
    const gm = randomMap(seed, 9, 9, 0.15, 0.45);
    for (const nbh of [4, 8]) {
      const ref = bellmanFord(gm, 0, gm.size - 1, nbh);
      const d = runD(gm, { start: 0, goal: gm.size - 1, neighborhood: nbh });
      const a = runA(gm, { start: 0, goal: gm.size - 1, neighborhood: nbh });
      if (ref.reachable) {
        if (!near(d.cost, ref.cost, 1e-9) || !near(a.cost, ref.cost, 1e-9)) {
          costOk = false; costWhy = 'seed' + seed + '/nbh' + nbh;
        }
      } else if (d.found || a.found) {
        costOk = false; costWhy = 'seed' + seed + '/nbh' + nbh + ' 可达性';
      }
    }
  }
  check('P15.7 同一批地图上最终代价仍等于独立 Bellman-Ford（80 张 × 2 模型）', costOk, costWhy);

  // 统计口径未被修复改变
  check('P15.8 修复后统计口径不变：扩展 ≤ 发现、松弛 ≥ 发现−1、trace 长度 = 扩展数',
    dA.expandedNodes <= dA.discoveredNodes && dA.relaxedEdges >= dA.discoveredNodes - 1 &&
    dA.trace.length === dA.expandedNodes &&
    aA.expandedNodes <= aA.discoveredNodes && aA.trace.length === aA.expandedNodes,
    JSON.stringify({ de: dA.expandedNodes, dd: dA.discoveredNodes, ae: aA.expandedNodes }));
}

// ================================================================ 汇总
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(' | ')));
console.log('total=' + (pass + fail) + ' pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
