/* 二维栅格路径规划 —— 纯计算模块（无 DOM、无 IO、确定性、可 Node require）
 *
 * 范围：全局静态路径规划。Dijkstra 与 A* 在同一地图、同一运动约束、同一代价模型下求解。
 * 明确不实现：动态避障、SLAM、多机器人冲突、AGV 调度、真实机器人控制、车辆运动学、
 *            D* Lite / RRT / Hybrid A* 等扩展算法。
 *
 * 坐标系与索引（渲染与计算共用同一套定义，不做行列互换）：
 *   - 栅格为 rows × cols；行号 r 自上而下（r=0 在最上方），列号 c 自左向右（c=0 在最左）。
 *   - 线性索引 idx = r * cols + c。
 *   - 四邻域：上(-1,0)、右(0,1)、下(1,0)、左(0,-1)，基础距离 1。
 *   - 八邻域：四邻域 + 四个对角，对角基础距离 √2。
 *   - 默认禁止对角穿角：u=(r,c) 到对角 v=(r+dr,c+dc) 时，若 (r+dr,c) 或 (r,c+dc) 被阻挡，
 *     该对角移动不存在（不是"更贵"，而是不可通行）。
 *
 * 代价定义（两个算法完全一致）：
 *   cost(u, v) = baseDist(u, v) × weight(v)
 *   baseDist ∈ {1, √2}；weight(v) 是**目标栅格**的地形权重，有限且 ≥ 1；
 *   阻挡格不能作为移动目标。权重必须为有限正数且 ≥ 1，非法值直接拒绝而不是静默夹取。
 *
 * 启发函数：
 *   h(n) = metric(n, goal) × minWeight
 *   minWeight = 所有可通行格权重的最小值（≥ 1），因此 h 可采纳（不高估）且一致
 *   （满足 h(u) ≤ cost(u,v) + h(v)）：cost ≥ baseDist × minWeight，
 *   而 metric 满足三角不等式、相邻格 metric ≤ baseDist。
 *   八邻域禁止 Manhattan：对角 base=√2 而 Manhattan 记 2，会高估 → 直接拒绝。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MAX_ROWS = 80;
  var MAX_COLS = 80;
  var MAX_TRACE = 8000;        // 回放记录上限（80×80 的最坏扩展数 6400 < 上限）
  var MAX_WEIGHT = 1e6;
  var MIN_WEIGHT = 1;
  var SQRT2 = Math.SQRT2;
  var COST_EPS = 1e-9;

  var ERROR_TEXT = {
    'invalid-size': '地图尺寸非法：行数与列数必须是 1–80 的整数。',
    'invalid-cells': '地图数据非法：格子数量与行×列不一致。',
    'invalid-weight': '地形权重非法：必须是有限正数且不小于 1。',
    'invalid-start': '起点越界：起点坐标必须落在地图内。',
    'invalid-goal': '终点越界：终点坐标必须落在地图内。',
    'start-blocked': '起点被障碍物占据，无法从起点出发。',
    'goal-blocked': '终点被障碍物占据，无法到达。',
    'invalid-neighborhood': '运动模型非法：只支持四邻域或八邻域。',
    'invalid-heuristic': '启发函数非法：可选 zero / manhattan / euclidean / octile。',
    'heuristic-overestimates': '该启发函数与所选运动模型不匹配：八邻域下 Manhattan 会高估实际代价。',
    'invalid-grid': '地图对象非法。',
    'parent-cycle': '父节点回溯出现循环（内部一致性错误）。',
    'invalid-path': '路径非法：包含越界、阻挡或不相邻的节点。',
    'no-path': '没有路径。'
  };

  var HEURISTIC_LABEL = {
    zero: '零启发（等价 Dijkstra）',
    manhattan: 'Manhattan',
    euclidean: 'Euclidean',
    octile: 'Octile'
  };

  // 每种启发函数允许的运动模型。八邻域禁止 Manhattan（会高估）。
  var HEURISTIC_FITS = {
    zero: [4, 8],
    manhattan: [4],
    euclidean: [4, 8],
    octile: [4, 8]
  };

  // 推荐组合：四邻域 Manhattan，八邻域 Octile。
  var HEURISTIC_RECOMMENDED = { 4: 'manhattan', 8: 'octile' };

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isInt(v) {
    return isNum(v) && Math.floor(v) === v;
  }

  function round6(v) {
    return Math.round(v * 1e6) / 1e6;
  }

  function error(code, extra) {
    var out = { ok: false, error: code, message: ERROR_TEXT[code] || code };
    if (extra) out.detail = extra;
    return out;
  }

  // ---------------------------------------------------------------- 地图

  /* 栅格用两条 TypedArray 表示：blocked（0/1）与 weights（浮点）。
   * minWeight 缓存"可通行格的最小权重"，供启发函数缩放下界使用。 */
  function makeGrid(rows, cols) {
    if (!isInt(rows) || !isInt(cols) || rows < 1 || cols < 1 || rows > MAX_ROWS || cols > MAX_COLS) {
      return error('invalid-size', { rows: rows, cols: cols });
    }
    var size = rows * cols;
    var grid = {
      rows: rows,
      cols: cols,
      size: size,
      blocked: new Uint8Array(size),
      weights: new Float64Array(size),
      minWeight: MIN_WEIGHT
    };
    for (var i = 0; i < size; i++) grid.weights[i] = 1;
    return { ok: true, grid: grid };
  }

  function refreshMinWeight(grid) {
    var min = Infinity;
    for (var i = 0; i < grid.size; i++) {
      if (!grid.blocked[i] && grid.weights[i] < min) min = grid.weights[i];
    }
    grid.minWeight = isFinite(min) ? min : MIN_WEIGHT;
    return grid.minWeight;
  }

  function cloneGrid(grid) {
    var out = {
      rows: grid.rows,
      cols: grid.cols,
      size: grid.size,
      blocked: new Uint8Array(grid.blocked),
      weights: new Float64Array(grid.weights),
      minWeight: grid.minWeight
    };
    return out;
  }

  function indexOf(grid, r, c) {
    if (!isInt(r) || !isInt(c) || r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) return -1;
    return r * grid.cols + c;
  }

  function rowOf(grid, idx) {
    return Math.floor(idx / grid.cols);
  }

  function colOf(grid, idx) {
    return idx % grid.cols;
  }

  function validateGrid(grid) {
    if (!grid || typeof grid !== 'object') return 'invalid-grid';
    if (!isInt(grid.rows) || !isInt(grid.cols)) return 'invalid-size';
    if (grid.rows < 1 || grid.cols < 1 || grid.rows > MAX_ROWS || grid.cols > MAX_COLS) return 'invalid-size';
    var size = grid.rows * grid.cols;
    if (grid.size !== size) return 'invalid-cells';
    if (!grid.blocked || !grid.weights) return 'invalid-grid';
    if (grid.blocked.length !== size || grid.weights.length !== size) return 'invalid-cells';
    for (var i = 0; i < size; i++) {
      var w = grid.weights[i];
      if (!isNum(w) || w < MIN_WEIGHT || w > MAX_WEIGHT) return 'invalid-weight';
    }
    return null;
  }

  /* 字符地图：'.' 普通地面(1)，'#' 障碍物，'2'–'9' 高代价地形权重。 */
  function parseMap(lines) {
    if (!lines || !lines.length) return error('invalid-size');
    var rows = lines.length;
    var cols = String(lines[0]).length;
    var made = makeGrid(rows, cols);
    if (!made.ok) return made;
    var grid = made.grid;
    for (var r = 0; r < rows; r++) {
      var line = String(lines[r]);
      if (line.length !== cols) return error('invalid-cells', { row: r });
      for (var c = 0; c < cols; c++) {
        var ch = line.charAt(c);
        var idx = r * cols + c;
        if (ch === '#') {
          grid.blocked[idx] = 1;
        } else if (ch === '.') {
          grid.weights[idx] = 1;
        } else if (ch >= '2' && ch <= '9') {
          grid.weights[idx] = Number(ch);
        } else {
          return error('invalid-cells', { row: r, col: c, char: ch });
        }
      }
    }
    refreshMinWeight(grid);
    return { ok: true, grid: grid };
  }

  /* 编辑接口：返回值区分成功/失败，调用方负责提示，不静默夹取非法值。 */
  function setBlocked(grid, idx, blocked) {
    if (!grid || !isInt(idx) || idx < 0 || idx >= grid.size) return error('invalid-grid');
    grid.blocked[idx] = blocked ? 1 : 0;
    if (blocked) grid.weights[idx] = 1;   // 障碍物不再携带地形权重
    refreshMinWeight(grid);
    return { ok: true };
  }

  function setWeight(grid, idx, weight) {
    if (!grid || !isInt(idx) || idx < 0 || idx >= grid.size) return error('invalid-weight');
    if (!isNum(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) return error('invalid-weight');
    if (grid.blocked[idx]) return error('invalid-weight');  // 障碍物不参与地形权重
    grid.weights[idx] = weight;
    refreshMinWeight(grid);
    return { ok: true };
  }

  function clearCell(grid, idx) {
    if (!grid || !isInt(idx) || idx < 0 || idx >= grid.size) return error('invalid-grid');
    grid.blocked[idx] = 0;
    grid.weights[idx] = 1;
    refreshMinWeight(grid);
    return { ok: true };
  }

  function clearGrid(grid) {
    for (var i = 0; i < grid.size; i++) {
      grid.blocked[i] = 0;
      grid.weights[i] = 1;
    }
    grid.minWeight = MIN_WEIGHT;
    return { ok: true };
  }

  // ---------------------------------------------------------------- 运动模型

  var ORTHO = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  var DIAG = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

  function neighborList(neighborhood) {
    if (neighborhood === 4) return ORTHO;
    if (neighborhood === 8) return ORTHO.concat(DIAG);
    return null;
  }

  /* 遍历合法相邻格。对角移动前检查两个正交伴随格，避免"贴角穿过障碍物"。 */
  function forEachNeighbor(grid, idx, neighborhood, fn) {
    var cols = grid.cols;
    var r = Math.floor(idx / cols);
    var c = idx % cols;
    var dirs = neighborList(neighborhood);
    if (!dirs) return 0;
    var count = 0;
    for (var k = 0; k < dirs.length; k++) {
      var dr = dirs[k][0], dc = dirs[k][1];
      var nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= grid.rows || nc >= grid.cols) continue;
      var diagonal = dr !== 0 && dc !== 0;
      if (diagonal) {
        if (grid.blocked[r * cols + nc]) continue;     // (r+0, c+dc)
        if (grid.blocked[nr * cols + c]) continue;     // (r+dr, c+0)
      }
      var ni = nr * cols + nc;
      if (grid.blocked[ni]) continue;
      fn(ni, diagonal ? SQRT2 : 1, dr, dc);
      count++;
    }
    return count;
  }

  function moveCost(grid, toIdx, baseDist) {
    return baseDist * grid.weights[toIdx];
  }

  // ---------------------------------------------------------------- 启发函数

  function manhattan(dr, dc) {
    return Math.abs(dr) + Math.abs(dc);
  }

  function euclidean(dr, dc) {
    return Math.sqrt(dr * dr + dc * dc);
  }

  function octile(dr, dc) {
    var a = Math.abs(dr), b = Math.abs(dc);
    var lo = a < b ? a : b;
    var hi = a < b ? b : a;
    return (hi - lo) + SQRT2 * lo;
  }

  function heuristicMetric(name, dr, dc) {
    if (name === 'manhattan') return manhattan(dr, dc);
    if (name === 'euclidean') return euclidean(dr, dc);
    if (name === 'octile') return octile(dr, dc);
    return 0;   // zero
  }

  function heuristicAllowed(name, neighborhood) {
    var fits = HEURISTIC_FITS[name];
    return !!fits && fits.indexOf(neighborhood) !== -1;
  }

  /* 缩放后的启发值：乘最小可通行权重，保证在加权地形上仍不高估。 */
  function heuristicValue(name, grid, fromIdx, goalIdx) {
    if (name === 'zero') return 0;
    var dr = Math.floor(fromIdx / grid.cols) - Math.floor(goalIdx / grid.cols);
    var dc = (fromIdx % grid.cols) - (goalIdx % grid.cols);
    return heuristicMetric(name, dr, dc) * grid.minWeight;
  }

  function heuristicList() {
    return ['zero', 'manhattan', 'euclidean', 'octile'];
  }

  // ---------------------------------------------------------------- 二叉最小堆

  /* 惰性删除：重复入队，出队时按"是否已关闭"过滤，不额外维护索引表。
   * less(a, b) 必须给出全序（含确定性同分规则），否则回放不可复现。 */
  function Heap(less) {
    this.items = [];
    this.less = less;
  }

  Heap.prototype.size = function () {
    return this.items.length;
  };

  Heap.prototype.push = function (value) {
    var a = this.items;
    a.push(value);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      var t = a[i]; a[i] = a[p]; a[p] = t;
      i = p;
    }
  };

  Heap.prototype.pop = function () {
    var a = this.items;
    var n = a.length;
    if (!n) return -1;
    var top = a[0];
    var last = a.pop();
    if (n > 1) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        var t = a[i]; a[i] = a[m]; a[m] = t;
        i = m;
      }
    }
    return top;
  };

  // ---------------------------------------------------------------- 公共校验

  function validateRequest(grid, opts, algorithm) {
    var gErr = validateGrid(grid);
    if (gErr) return error(gErr);
    opts = opts || {};
    var start = opts.start;
    var goal = opts.goal;
    if (!isInt(start) || start < 0 || start >= grid.size) return error('invalid-start');
    if (!isInt(goal) || goal < 0 || goal >= grid.size) return error('invalid-goal');
    if (grid.blocked[start]) return error('start-blocked');
    if (grid.blocked[goal]) return error('goal-blocked');
    var nbh = opts.neighborhood === undefined ? 4 : opts.neighborhood;
    if (nbh !== 4 && nbh !== 8) return error('invalid-neighborhood');
    var heur = algorithm === 'astar' ? (opts.heuristic || HEURISTIC_RECOMMENDED[nbh]) : null;
    if (algorithm === 'astar' && heuristicList().indexOf(heur) === -1) return error('invalid-heuristic');
    if (algorithm === 'astar' && !heuristicAllowed(heur, nbh)) return error('heuristic-overestimates');
    return { ok: true, start: start, goal: goal, neighborhood: nbh, heuristic: heur };
  }

  function reconstruct(grid, parent, start, goal) {
    var path = [];
    var cur = goal;
    var guard = grid.size + 1;
    while (cur !== -1 && guard-- > 0) {
      path.push(cur);
      if (cur === start) break;
      cur = parent[cur];
    }
    if (guard <= 0) return null;
    if (path[path.length - 1] !== start) return null;
    path.reverse();
    return path;
  }

  function geometricLength(grid, path) {
    var total = 0;
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i];
      var dr = Math.abs(Math.floor(a / grid.cols) - Math.floor(b / grid.cols));
      var dc = Math.abs((a % grid.cols) - (b % grid.cols));
      total += (dr && dc) ? SQRT2 : 1;
    }
    return total;
  }

  /* 独立重算路径代价：不读取搜索内部累计值，用于交叉校验。 */
  function pathCost(grid, path) {
    if (!path || path.length < 2) return 0;
    var total = 0;
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i];
      var dr = Math.abs(Math.floor(a / grid.cols) - Math.floor(b / grid.cols));
      var dc = Math.abs((a % grid.cols) - (b % grid.cols));
      if (dr > 1 || dc > 1 || (dr === 0 && dc === 0)) return NaN;
      total += (dr && dc ? SQRT2 : 1) * grid.weights[b];
    }
    return total;
  }

  /* 路径合法性：相邻、不越界、不穿障碍、遵守对角穿角规则、无重复节点。 */
  function validatePath(grid, path, opts) {
    opts = opts || {};
    var nbh = opts.neighborhood === undefined ? 4 : opts.neighborhood;
    if (!path || !path.length) return { ok: false, errors: ['empty'] };
    var errors = [];
    var seen = {};
    for (var i = 0; i < path.length; i++) {
      var idx = path[i];
      if (!isInt(idx) || idx < 0 || idx >= grid.size) { errors.push('out-of-range'); continue; }
      if (grid.blocked[idx]) errors.push('blocked');
      if (seen[idx]) errors.push('duplicate');
      seen[idx] = 1;
    }
    if (opts.start !== undefined && path[0] !== opts.start) errors.push('bad-start');
    if (opts.goal !== undefined && path[path.length - 1] !== opts.goal) errors.push('bad-goal');
    for (var k = 1; k < path.length; k++) {
      var a = path[k - 1], b = path[k];
      if (!isInt(a) || !isInt(b) || a < 0 || b < 0 || a >= grid.size || b >= grid.size) continue;
      var ar = Math.floor(a / grid.cols), ac = a % grid.cols;
      var br = Math.floor(b / grid.cols), bc = b % grid.cols;
      var dr = br - ar, dc = bc - ac;
      if (Math.abs(dr) > 1 || Math.abs(dc) > 1 || (dr === 0 && dc === 0)) {
        errors.push('not-adjacent');
        continue;
      }
      var diagonal = dr !== 0 && dc !== 0;
      if (diagonal) {
        if (nbh !== 8) errors.push('diagonal-not-allowed');
        if (grid.blocked[ar * grid.cols + bc] || grid.blocked[br * grid.cols + ac]) {
          errors.push('corner-cut');
        }
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------------------------------------------------------------- Dijkstra

  /* Dijkstra：优先队列（二叉最小堆）+ 惰性删除。
   * 仅在**终点以最小 g 出队**时结束（不是首次被发现）。
   * 同分规则：g 小者优先；g 相同按线性索引小者优先（确定性）。 */
  function runDijkstra(grid, opts) {
    var v = validateRequest(grid, opts, 'dijkstra');
    if (!v.ok) return v;
    var start = v.start, goal = v.goal, nbh = v.neighborhood;
    var size = grid.size;

    if (start === goal) {
      return {
        ok: true, found: true, status: 'found', algorithm: 'dijkstra',
        heuristic: null, neighborhood: nbh, start: start, goal: goal,
        cost: 0, geometricLength: 0, path: [start], pathNodes: 1,
        expandedNodes: 0, discoveredNodes: 1, relaxedEdges: 0, maxOpen: 0,
        timeMs: 0, trace: [], traceTruncated: false
      };
    }

    // 计时口径（两个算法一致）：从数组分配、填初值、初始入队到搜索结束。
    // 不含 DOM 绘制、回放等待，也不含 compare() 里另一个算法的时间。
    var t0 = nowMs();

    var dist = new Float64Array(size);
    for (var i = 0; i < size; i++) dist[i] = Infinity;
    var parent = new Int32Array(size);
    for (i = 0; i < size; i++) parent[i] = -1;
    var state = new Uint8Array(size);   // 0=未发现 1=open 2=closed

    /* 堆条目必须是不可变快照 {node, g}：比较器只读条目自身，不读外部可变的 dist。
     * 若比较器读 dist，松弛改变代价后旧条目的键会"悄悄变小"，而堆结构并未执行
     * decrease-key，出队最小性会被破坏（9C-2C 修订已用确定性反例验证：
     * 5×6 加权八邻域地图上 A* 曾返回 13.0710678 而最优为 12.8284271）。 */
    var heap = new Heap(function (a, b) {
      if (a.g !== b.g) return a.g < b.g;
      return a.node < b.node;
    });

    dist[start] = 0;
    parent[start] = -1;
    state[start] = 1;
    heap.push({ node: start, g: 0 });

    var discovered = 1;
    var expanded = 0;
    var relaxed = 0;
    var openCount = 1;
    var closedCount = 0;
    var maxOpen = 1;
    var trace = [];
    var truncated = false;
    var found = false;

    while (heap.size()) {
      var entry = heap.pop();
      var u = entry.node;
      if (state[u] === 2) continue;            // 该节点已关闭（同一节点的旧条目）
      if (entry.g > dist[u]) continue;         // 过期条目：入堆后键已被更小的值取代
      state[u] = 2;
      openCount--;
      closedCount++;
      expanded++;

      var g = dist[u];
      var pushes = [];

      if (trace.length < MAX_TRACE) {
        trace.push({ node: u, g: g, h: 0, f: g, openSize: openCount, closedSize: closedCount, pushes: pushes });
      } else {
        truncated = true;
      }

      if (u === goal) { found = true; break; }

      forEachNeighbor(grid, u, nbh, function (ni, base) {
        var nd = g + moveCost(grid, ni, base);
        relaxed++;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          parent[ni] = u;
          if (state[ni] === 0) {
            state[ni] = 1;
            openCount++;
            discovered++;
            if (openCount > maxOpen) maxOpen = openCount;
          } else if (state[ni] === 2) {
            // 正权边下 Dijkstra 不会出现，保留分支以便被测试观察到意外
            state[ni] = 1;
            closedCount--;
            openCount++;
          }
          heap.push({ node: ni, g: nd });
          pushes.push(ni);
        }
      });
    }

    var elapsed = nowMs() - t0;
    if (!found) {
      return {
        ok: true, found: false, status: 'unreachable', algorithm: 'dijkstra',
        heuristic: null, neighborhood: nbh, start: start, goal: goal,
        cost: null, geometricLength: null, path: [], pathNodes: 0,
        expandedNodes: expanded, discoveredNodes: discovered, relaxedEdges: relaxed,
        maxOpen: maxOpen, timeMs: elapsed, trace: trace, traceTruncated: truncated
      };
    }

    var path = reconstruct(grid, parent, start, goal);
    if (!path) {
      return error('parent-cycle');
    }
    return {
      ok: true, found: true, status: 'found', algorithm: 'dijkstra',
      heuristic: null, neighborhood: nbh, start: start, goal: goal,
      cost: dist[goal], geometricLength: geometricLength(grid, path),
      path: path, pathNodes: path.length,
      expandedNodes: expanded, discoveredNodes: discovered, relaxedEdges: relaxed,
      maxOpen: maxOpen, timeMs: elapsed, trace: trace, traceTruncated: truncated
    };
  }

  // ---------------------------------------------------------------- A*

  /* A*：f = g + h。h 由启发函数族给出并按 minWeight 缩放。
   * 同分规则：f 小者优先 → h 小者优先（更靠近终点）→ 线性索引小者优先。
   * 与 Dijkstra 一样在**终点以最小 f 出队**时结束；h 一致时 f 序即 g 序。
   * 记录完整搜索过程，但回放状态不参与任何计算。 */
  function runAStar(grid, opts) {
    var v = validateRequest(grid, opts, 'astar');
    if (!v.ok) return v;
    var start = v.start, goal = v.goal, nbh = v.neighborhood, heur = v.heuristic;
    var size = grid.size;

    if (start === goal) {
      return {
        ok: true, found: true, status: 'found', algorithm: 'astar',
        heuristic: heur, neighborhood: nbh, start: start, goal: goal,
        cost: 0, geometricLength: 0, path: [start], pathNodes: 1,
        expandedNodes: 0, discoveredNodes: 1, relaxedEdges: 0, maxOpen: 0,
        timeMs: 0, trace: [], traceTruncated: false
      };
    }

    // 计时口径与 Dijkstra 一致：包含本算法自身的初始化（hScore 预计算、gScore 填值、
    // 初始入队）与搜索循环，不含 DOM 绘制与回放等待。
    var t0 = nowMs();

    var hScore = new Float64Array(size);
    for (var i = 0; i < size; i++) hScore[i] = heuristicValue(heur, grid, i, goal);

    var gScore = new Float64Array(size);
    for (i = 0; i < size; i++) gScore[i] = Infinity;
    var parent = new Int32Array(size);
    for (i = 0; i < size; i++) parent[i] = -1;
    var state = new Uint8Array(size);

    /* 条目是 {node, g, h, f} 快照：比较器只读条目，不读可变的 gScore/hScore，
     * 因此堆序与入堆时的键严格一致，不存在"旧条目键变小"导致的非最小出队。 */
    var heap = new Heap(function (a, b) {
      if (a.f !== b.f) return a.f < b.f;
      if (a.h !== b.h) return a.h < b.h;
      return a.node < b.node;
    });

    gScore[start] = 0;
    parent[start] = -1;
    state[start] = 1;
    heap.push({ node: start, g: 0, h: hScore[start], f: hScore[start] });

    var discovered = 1;
    var expanded = 0;
    var relaxed = 0;
    var openCount = 1;
    var closedCount = 0;
    var maxOpen = 1;
    var trace = [];
    var truncated = false;
    var found = false;

    while (heap.size()) {
      var entry = heap.pop();
      var u = entry.node;
      if (state[u] === 2) continue;          // 该节点已关闭（同一节点的旧条目）
      if (entry.g > gScore[u]) continue;     // 过期条目：入堆后键已被更小的值取代
      state[u] = 2;
      openCount--;
      closedCount++;
      expanded++;

      var g = gScore[u];
      var pushes = [];
      if (trace.length < MAX_TRACE) {
        trace.push({
          node: u, g: g, h: hScore[u], f: g + hScore[u],
          openSize: openCount, closedSize: closedCount, pushes: pushes
        });
      } else {
        truncated = true;
      }

      if (u === goal) { found = true; break; }

      forEachNeighbor(grid, u, nbh, function (ni, base) {
        var nd = g + moveCost(grid, ni, base);
        relaxed++;
        if (nd < gScore[ni]) {
          gScore[ni] = nd;
          parent[ni] = u;
          if (state[ni] === 0) {
            state[ni] = 1;
            openCount++;
            discovered++;
            if (openCount > maxOpen) maxOpen = openCount;
          } else if (state[ni] === 2) {
            // 一致启发函数下不会发生；保留重开分支以免静默给出次优解
            state[ni] = 1;
            closedCount--;
            openCount++;
          }
          heap.push({ node: ni, g: nd, h: hScore[ni], f: nd + hScore[ni] });
          pushes.push(ni);
        }
      });
    }

    var elapsed = nowMs() - t0;
    if (!found) {
      return {
        ok: true, found: false, status: 'unreachable', algorithm: 'astar',
        heuristic: heur, neighborhood: nbh, start: start, goal: goal,
        cost: null, geometricLength: null, path: [], pathNodes: 0,
        expandedNodes: expanded, discoveredNodes: discovered, relaxedEdges: relaxed,
        maxOpen: maxOpen, timeMs: elapsed, trace: trace, traceTruncated: truncated
      };
    }

    var path = reconstruct(grid, parent, start, goal);
    if (!path) return error('parent-cycle');
    return {
      ok: true, found: true, status: 'found', algorithm: 'astar',
      heuristic: heur, neighborhood: nbh, start: start, goal: goal,
      cost: gScore[goal], geometricLength: geometricLength(grid, path),
      path: path, pathNodes: path.length,
      expandedNodes: expanded, discoveredNodes: discovered, relaxedEdges: relaxed,
      maxOpen: maxOpen, timeMs: elapsed, trace: trace, traceTruncated: truncated
    };
  }

  // ---------------------------------------------------------------- 对比

  function sameCost(a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    var scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= COST_EPS * scale;
  }

  /* 同一地图、同一运动模型、同一代价模型下运行两个算法。
   * 只返回结果，不比较"谁更快"之外的任何结论：单次耗时不能推广为普遍加速倍数。 */
  function compare(grid, opts) {
    opts = opts || {};
    var nbh = opts.neighborhood === undefined ? 4 : opts.neighborhood;
    var heur = opts.heuristic || HEURISTIC_RECOMMENDED[nbh];
    var d = runDijkstra(grid, { start: opts.start, goal: opts.goal, neighborhood: nbh });
    var a = runAStar(grid, { start: opts.start, goal: opts.goal, neighborhood: nbh, heuristic: heur });
    if (!d.ok) return { ok: false, error: d.error, message: d.message, dijkstra: d, astar: a };
    if (!a.ok) return { ok: false, error: a.error, message: a.message, dijkstra: d, astar: a };
    return {
      ok: true,
      neighborhood: nbh,
      heuristic: heur,
      dijkstra: d,
      astar: a,
      sameCost: d.found && a.found ? sameCost(d.cost, a.cost) : d.found === a.found,
      costDelta: d.found && a.found ? Math.abs(d.cost - a.cost) : null
    };
  }

  // ---------------------------------------------------------------- 教学场景

  /* 全部为合成教学地图：与任何真实企业车间布局、生产数据无关。
   * expect 只描述可观察现象，不预设"A* 一定更快"之类结论。 */
  var SCENARIOS = [
    {
      id: 'open-field',
      name: '① 无障碍开放地图',
      note: '12×12 全空。八邻域 + Octile 时最短路径是一条对角直线，代价 11√2 ≈ 15.556；' +
        '四邻域时没有对角，代价 22。可观察：开阔地图上 A* 与 Dijkstra 的路径代价相同，' +
        '扩展节点数差距明显。',
      lines: [
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............',
        '............'
      ],
      start: [0, 0],
      goal: [11, 11],
      neighborhood: 8,
      heuristic: 'octile'
    },
    {
      id: 'walls',
      name: '② 墙体与狭窄通道',
      note: '14×11 地图，第 6 列有一道墙，只在底部两行留出通道。' +
        '四邻域下最短代价 19：必须下到通道、横穿、再折返。可观察：墙体让路径代价由 11 增加到 19，' +
        '两个算法仍给出同一代价。',
      lines: [
        '..............',
        '......#.......',
        '......#.......',
        '......#.......',
        '......#.......',
        '......#.......',
        '......#.......',
        '......#.......',
        '......#.......',
        '..............',
        '..............'
      ],
      start: [5, 1],
      goal: [5, 12],
      neighborhood: 4,
      heuristic: 'manhattan'
    },
    {
      id: 'costly',
      name: '③ 高代价地形绕行',
      note: '11×11 地图，中央 3 列 × 7 行是高代价地形（权重 9）。' +
        '直穿只需 10 步但代价 34；绕开走 18 步，代价 18。可观察：几何最短 ≠ 代价最低，' +
        '算法选择的是加权代价最小的路径。',
      lines: [
        '...........',
        '...........',
        '....999....',
        '....999....',
        '....999....',
        '....999....',
        '....999....',
        '....999....',
        '....999....',
        '...........',
        '...........'
      ],
      start: [5, 0],
      goal: [5, 10],
      neighborhood: 4,
      heuristic: 'manhattan'
    },
    {
      id: 'unreachable',
      name: '④ 终点不可达',
      note: '终点被 8 个障碍物完整包围，没有可通行的相邻格。可观察：两个算法都会把可达区域扩展完，' +
        '返回"不可达"状态，代价为空；路径区域保持空白，不会画出半截路径。',
      lines: [
        '...........',
        '...........',
        '....###....',
        '....#.#....',
        '....###....',
        '...........',
        '...........',
        '...........',
        '...........'
      ],
      start: [0, 0],
      goal: [3, 5],
      neighborhood: 8,
      heuristic: 'octile'
    },
    {
      id: 'corner',
      name: '⑤ 对角拐角阻挡',
      note: '八邻域默认禁止贴角穿越：起点与终点虽在对角方向，但相邻正交格 (2,3) 是障碍物，' +
        '所以那条对角边不存在。可观察：路径代价为 2（两步正交），而不是允许穿角时的 √2 ≈ 1.414。',
      lines: [
        '......',
        '......',
        '...#..',
        '......',
        '......'
      ],
      start: [2, 2],
      goal: [3, 3],
      neighborhood: 8,
      heuristic: 'octile'
    }
  ];

  function scenarioList() {
    return SCENARIOS.map(function (s) {
      return { id: s.id, name: s.name, note: s.note };
    });
  }

  function getScenario(id) {
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) return SCENARIOS[i];
    return null;
  }

  /* 场景载入：返回全新的 grid，调用方可以随意编辑而不影响场景定义。 */
  function loadScenario(id) {
    var s = getScenario(id);
    if (!s) return error('invalid-grid');
    var parsed = parseMap(s.lines);
    if (!parsed.ok) return parsed;
    var grid = parsed.grid;
    var start = indexOf(grid, s.start[0], s.start[1]);
    var goal = indexOf(grid, s.goal[0], s.goal[1]);
    return {
      ok: true,
      id: s.id,
      name: s.name,
      note: s.note,
      grid: grid,
      start: start,
      goal: goal,
      neighborhood: s.neighborhood,
      heuristic: s.heuristic
    };
  }

  // ---------------------------------------------------------------- 随机地图

  /* xorshift32：只用整数位移与异或，跨引擎结果完全一致（不依赖 Math.random）。 */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5); s >>>= 0;
      return s / 4294967296;
    };
  }

  /* 固定种子随机地图：障碍物与高代价地形比例固定，起点/终点固定，保证可复现。 */
  function randomGrid(seed, rows, cols) {
    rows = rows || 14;
    cols = cols || 14;
    var made = makeGrid(rows, cols);
    if (!made.ok) return made;
    var grid = made.grid;
    var rng = makeRng(seed);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        var roll = rng();
        if (roll < 0.22) {
          grid.blocked[idx] = 1;
        } else if (roll < 0.36) {
          grid.weights[idx] = 2 + Math.floor(rng() * 6);   // 2–7
        }
      }
    }
    // 起终点与它们的一圈邻格保持可通行，避免地图天然退化
    var corners = [[1, 1], [rows - 2, cols - 2]];
    for (var k = 0; k < corners.length; k++) {
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          var rr = corners[k][0] + dr, cc = corners[k][1] + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          var ii = rr * cols + cc;
          grid.blocked[ii] = 0;
          grid.weights[ii] = 1;
        }
      }
    }
    refreshMinWeight(grid);
    return {
      ok: true,
      grid: grid,
      start: 1 * cols + 1,
      goal: (rows - 2) * cols + (cols - 2),
      seed: seed >>> 0
    };
  }

  var DEFAULT_SCENARIO = 'walls';
  var DEFAULT_WEIGHT = 5;
  var DEFAULT_SPEED = 5;

  var api = {
    VERSION: VERSION,
    LIMITS: {
      maxRows: MAX_ROWS,
      maxCols: MAX_COLS,
      maxTrace: MAX_TRACE,
      maxWeight: MAX_WEIGHT,
      minWeight: MIN_WEIGHT
    },
    DEFAULT_SCENARIO: DEFAULT_SCENARIO,
    DEFAULT_WEIGHT: DEFAULT_WEIGHT,
    DEFAULT_SPEED: DEFAULT_SPEED,
    SQRT2: SQRT2,
    ERROR_TEXT: ERROR_TEXT,
    HEURISTIC_LABEL: HEURISTIC_LABEL,
    HEURISTIC_FITS: HEURISTIC_FITS,
    HEURISTIC_RECOMMENDED: HEURISTIC_RECOMMENDED,

    makeGrid: makeGrid,
    cloneGrid: cloneGrid,
    parseMap: parseMap,
    validateGrid: validateGrid,
    refreshMinWeight: refreshMinWeight,
    indexOf: indexOf,
    rowOf: rowOf,
    colOf: colOf,
    setBlocked: setBlocked,
    setWeight: setWeight,
    clearCell: clearCell,
    clearGrid: clearGrid,

    neighborList: neighborList,
    forEachNeighbor: forEachNeighbor,
    moveCost: moveCost,
    geometricLength: geometricLength,

    heuristicList: heuristicList,
    heuristicMetric: heuristicMetric,
    heuristicValue: heuristicValue,
    heuristicAllowed: heuristicAllowed,
    manhattan: manhattan,
    euclidean: euclidean,
    octile: octile,

    runDijkstra: runDijkstra,
    runAStar: runAStar,
    compare: compare,
    sameCost: sameCost,
    pathCost: pathCost,
    validatePath: validatePath,
    reconstruct: reconstruct,

    scenarioList: scenarioList,
    getScenario: getScenario,
    loadScenario: loadScenario,
    randomGrid: randomGrid,
    makeRng: makeRng
  };

  global.PathPlanning = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
