#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2C：A* 与 Dijkstra 路径规划实验室验收（真实浏览器）
 *
 * 覆盖：实验路由与导航、地图编辑（障碍/地形/起终点/清除）、地形权重、
 * 算法切换、路径结果更新、单步搜索、播放与暂停、地图修改使旧结果失效、
 * 不可达状态、非法参数、快速路由切换、脚本加载失败与降级、
 * 390/768/1440、深色主题、键盘与无障碍、离线、三引擎。
 *
 * 正确性判据是数值（默认地图代价 19、开放地图 11√2≈15.5563、高代价地形 18、
 * 穿角场景 2），不是"看起来像一条路"。
 *
 * 用法：node tests/browser/path-planning.spec.js
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/path-planning';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

async function newSession(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    serviceWorkers: o.sw ? 'allow' : 'block',
    colorScheme: o.colorScheme || 'light',
    hasTouch: !!o.hasTouch
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 60000 });
  await waitReady(page);
  return { ctx, page, errors };
}

async function waitReady(page, timeout) {
  await page.waitForFunction(() => {
    const root = document.getElementById('ppDemoRoot');
    const s = window.PathPlanningDemo && root && window.PathPlanningDemo.getState(root);
    return !!s && s.planCount > 0;
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('ppDemoRoot');
    return window.PathPlanningDemo ? window.PathPlanningDemo.getState(root) : null;
  });
}

async function click(page, id) {
  await page.click('#' + id);
  await sleep(140);
}

async function selectScene(page, id) {
  await page.evaluate(v => {
    const el = document.getElementById('ppScene');
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, id);
  await sleep(220);
}

/** 点击栅格中的 (r, c)：坐标按 SVG 的渲染尺寸线性映射，与 viewBox 比例一致。 */
async function clickCell(page, r, c) {
  const st = await getState(page);
  const loc = page.locator('#ppGrid');
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error('grid has no box');
  const x = box.x + (c + 0.5) * box.width / st.cols;
  const y = box.y + (r + 0.5) * box.height / st.rows;
  await page.mouse.click(x, y);
  await sleep(150);
}

async function setInput(page, id, value) {
  await page.evaluate(([q, v]) => {
    const el = document.getElementById(q);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, String(value)]);
}

(function main() { return run(); })();

async function run() {
  const server = createServer(ROOT, PREFIX);
  const port = await listen(server.server, 0);
  const base = 'http://127.0.0.1:' + port;
  let browser;
  try {
    browser = await chromium.launch(Object.assign({ headless: true }, CHANNEL !== 'chromium' ? { channel: CHANNEL } : {}));
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）：' + String(e.message).split('\n')[0]);
    server.server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());

  try {
    // ---------------------------------------------------------------- P1 入口与互链
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const entry = await p1.evaluate(() => ({
      navHref: (document.querySelector('.nav-link[data-route="/lab"]') || {}).getAttribute
        ? document.querySelector('.nav-link[data-route="/lab"]').getAttribute('href') : null,
      title: document.title,
      links: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
      current: (() => {
        const el = document.querySelector('.lab-links a[aria-current="page"]');
        return el ? el.getAttribute('href') : null;
      })(),
      controls: ['ppGrid', 'ppRun', 'ppStep', 'ppPlay', 'ppPause', 'ppReset', 'ppSpeed', 'ppWeight',
        'ppNbh4', 'ppNbh8', 'ppHeuristic', 'ppAlgoD', 'ppAlgoA', 'ppToolBlock', 'ppToolCost',
        'ppToolStart', 'ppToolGoal', 'ppToolErase', 'ppClear', 'ppDefault', 'ppRandom', 'ppSeed',
        'ppScene', 'ppStepBody', 'ppCompareBody', 'ppPathText', 'ppLegend', 'ppLive'].every(id => !!document.getElementById(id))
    }));
    check('P1.1 导航「实验」保持原 href，页面标题正确',
      entry.navHref === '#/lab/robot-2r' && /路径规划实验室/.test(entry.title),
      JSON.stringify({ href: entry.navHref }));
    check('P1.2 七项实验互链（含路径规划）与当前页标注，全部控件齐备',
      entry.links.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning' &&
      entry.current === '#/lab/path-planning' && entry.controls,
      entry.links.join(','));

    const st0 = await getState(p1);
    check('P1.3 默认地图（墙体场景 14×11）自动完成一次规划，光标停在回放末尾',
      st0.rows === 11 && st0.cols === 14 && st0.planCount === 1 &&
      st0.cursor === st0.traceLength && st0.cursor > 0,
      JSON.stringify({ rows: st0.rows, cols: st0.cols, cursor: st0.cursor }));
    check('P1.4 默认四邻域 + Manhattan + A*：最优代价 19、路径 20 个节点',
      st0.neighborhood === 4 && st0.heuristic === 'manhattan' && st0.algorithm === 'astar' &&
      near(st0.cost, 19) && st0.pathNodes === 20, JSON.stringify({ cost: st0.cost, nodes: st0.pathNodes }));
    check('P1.5 默认地图障碍物 8 个（第 6 列第 1–8 行）、高代价格 0 个',
      st0.blockedCount === 8 && st0.costlyCount === 0, JSON.stringify({ b: st0.blockedCount, c: st0.costlyCount }));

    // ---------------------------------------------------------------- P2 算法契约与结果对比
    check('P2.1 A/B 两列都有结果：同一代价 19、sameCost=true、几何长度 19',
      st0.ab && near(st0.ab.dijkstra.cost, 19) && near(st0.ab.astar.cost, 19) &&
      st0.ab.sameCost === true && near(st0.geometricLength, 19),
      JSON.stringify({ d: st0.ab.dijkstra.cost, a: st0.ab.astar.cost }));
    check('P2.2 扩展节点与发现节点是两个口径：发现 ≥ 扩展，且 A* 扩展少于 Dijkstra',
      st0.ab.dijkstra.discoveredNodes >= st0.ab.dijkstra.expandedNodes &&
      st0.ab.astar.discoveredNodes >= st0.ab.astar.expandedNodes &&
      st0.ab.astar.expandedNodes < st0.ab.dijkstra.expandedNodes,
      JSON.stringify({ de: st0.ab.dijkstra.expandedNodes, ae: st0.ab.astar.expandedNodes }));
    check('P2.3 表格逐行展示：是否找到/总代价/几何长度/节点数/扩展/发现/运行时间/启发函数',
      await p1.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#ppCompareBody tr')).map(tr => tr.cells[0].textContent);
        return rows.length === 10 && rows[0].indexOf('是否找到路径') === 0 &&
          rows[1].indexOf('路径总代价') === 0 && rows[2].indexOf('几何路径长度') === 0 &&
          rows[3].indexOf('路径节点数量') === 0 && rows[4].indexOf('扩展节点数量') === 0 &&
          rows[5].indexOf('唯一发现节点数量') === 0 && rows[8].indexOf('运行时间') === 0 &&
          rows[9].indexOf('启发函数') === 0;
      }));
    check('P2.4 页脚明确"单次耗时不能推断普遍加速倍数"且区分扩展/发现',
      await p1.evaluate(() => {
        const t = document.getElementById('ppCompareNote').textContent;
        return /不能据此推断普遍加速倍数/.test(t) && /扩展节点 =/.test(t) && /发现节点 =/.test(t);
      }));

    // 路径合法性：与页面同源的纯函数模块独立复核
    const legality = await p1.evaluate(() => {
      const st = window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot'));
      const P = window.PathPlanning;
      const grid = P.loadScenario('walls').grid;
      const v = P.validatePath(grid, st.path, { start: st.start, goal: st.goal, neighborhood: st.neighborhood });
      return { ok: v.ok, errors: v.errors, recomputed: P.pathCost(grid, st.path), cost: st.cost };
    });
    check('P2.5 页面显示的路径可被独立校验：相邻合法、无穿角、代价重算一致',
      legality.ok && near(legality.recomputed, 19) && near(legality.cost, 19),
      JSON.stringify(legality));

    // ---------------------------------------------------------------- P3 教学场景与代价模型
    await selectScene(p1, 'open-field');
    const open = await getState(p1);
    check('P3.1 开放地图（12×12 八邻域）：代价 11√2 ≈ 15.5563、12 个节点',
      open.rows === 12 && open.cols === 12 && open.neighborhood === 8 && open.heuristic === 'octile' &&
      near(open.cost, 11 * Math.SQRT2, 1e-9) && open.pathNodes === 12,
      JSON.stringify({ cost: open.cost, nodes: open.pathNodes }));
    check('P3.2 无障碍地图上 A* 只扩展路径节点（12），远少于 Dijkstra（144）',
      open.ab.astar.expandedNodes === 12 && open.ab.dijkstra.expandedNodes === 144 &&
      open.ab.sameCost === true,
      JSON.stringify({ a: open.ab.astar.expandedNodes, d: open.ab.dijkstra.expandedNodes }));

    await selectScene(p1, 'costly');
    const costly = await getState(p1);
    check('P3.3 高代价地形：几何最短 ≠ 代价最低，最优代价 18（直穿需 34）',
      near(costly.cost, 18) && near(costly.geometricLength, 18) && costly.costlyCount === 21,
      JSON.stringify({ cost: costly.cost, geo: costly.geometricLength, costly: costly.costlyCount }));

    await selectScene(p1, 'corner');
    const corner = await getState(p1);
    check('P3.4 穿角阻挡：对角边不存在，代价 2 而非 √2',
      near(corner.cost, 2) && corner.pathNodes === 3, JSON.stringify({ cost: corner.cost }));

    await selectScene(p1, 'unreachable');
    const un = await getState(p1);
    check('P3.5 不可达场景：返回不可达、无路径、两个算法一致',
      un.status === 'unreachable' && un.cost === null && un.pathNodes === 0 &&
      un.pathDrawn === false && un.ab.dijkstra.found === false && un.ab.astar.found === false &&
      un.ab.sameCost === true, JSON.stringify({ status: un.status, drawn: un.pathDrawn }));
    check('P3.6 不可达时仍完整记录扩展节点数（区域搜完）且页面有明确文字说明',
      un.ab.dijkstra.expandedNodes > 0 && await p1.evaluate(() =>
        /不可达/.test(document.getElementById('ppPathText').textContent)));

    // ---------------------------------------------------------------- P4 地图编辑与失效
    await selectScene(p1, 'walls');
    const before = await getState(p1);
    await clickCell(p1, 9, 6);   // 走廊唯一通道
    const afterBlock = await getState(p1);
    check('P4.1 添加障碍物后旧结果立即失效：ab=null、回放视图清空、状态标记失效',
      afterBlock.invalidated === true && afterBlock.ab === null &&
      afterBlock.overlayCount === 0 && afterBlock.pathDrawn === false &&
      afterBlock.invalidReason.length > 0 && afterBlock.blockedCount === before.blockedCount + 1,
      JSON.stringify({ invalid: afterBlock.invalidated, blocked: afterBlock.blockedCount }));

    await click(p1, 'ppRun');
    const blockedPlan = await getState(p1);
    check('P4.2 重新规划：通道被封后必须绕到下一行，代价 19 → 21',
      blockedPlan.invalidated === false && near(blockedPlan.cost, 21) &&
      blockedPlan.ab.dijkstra.expandedNodes > 0, JSON.stringify({ cost: blockedPlan.cost }));

    await selectScene(p1, 'walls');
    await p1.click('#ppToolCost');
    await setInput(p1, 'ppWeight', 9);
    await clickCell(p1, 9, 6);
    const terrain = await getState(p1);
    check('P4.3 高代价地形编辑：权重 9 落在通道上后结果失效、且被计为高代价格',
      terrain.invalidated === true && terrain.costlyCount === 1 && terrain.tool === 'cost',
      JSON.stringify({ costly: terrain.costlyCount }));
    await click(p1, 'ppRun');
    const terrainPlan = await getState(p1);
    check('P4.4 权重 9 让直穿通道的代价升至 27，最优解改为绕到下一行（21）',
      near(terrainPlan.cost, 21) && near(terrainPlan.ab.astar.cost, terrainPlan.ab.dijkstra.cost),
      JSON.stringify({ cost: terrainPlan.cost }));

    await p1.click('#ppToolBlock');
    await clickCell(p1, 9, 6);
    const blockedTerrain = await getState(p1);
    check('P4.5 障碍与地形互斥：置障后该格权重回到 1，高代价格计数归零',
      blockedTerrain.costlyCount === 0 && blockedTerrain.blockedCount === 9,
      JSON.stringify({ costly: blockedTerrain.costlyCount, blocked: blockedTerrain.blockedCount }));

    await p1.click('#ppToolErase');
    await clickCell(p1, 9, 6);
    const erased = await getState(p1);
    check('P4.6 清除工具恢复普通地面（障碍 -1、权重 1）',
      erased.blockedCount === 8 && erased.costlyCount === 0, JSON.stringify({ blocked: erased.blockedCount }));

    await p1.click('#ppToolStart');
    await clickCell(p1, 7, 1);
    const moved = await getState(p1);
    check('P4.7 设置起点：坐标更新、旧结果失效', moved.startCoord[0] === 7 && moved.startCoord[1] === 1 &&
      moved.invalidated === true, JSON.stringify(moved.startCoord));
    await click(p1, 'ppRun');
    const movedPlan = await getState(p1);
    check('P4.8 新起点重新规划：代价 17（下 2、横 11、上 4）', near(movedPlan.cost, 17),
      JSON.stringify({ cost: movedPlan.cost }));

    await p1.click('#ppToolGoal');
    await clickCell(p1, 0, 0);
    const movedGoal = await getState(p1);
    check('P4.9 设置终点：坐标更新、旧结果失效', movedGoal.goalCoord[0] === 0 &&
      movedGoal.goalCoord[1] === 0 && movedGoal.invalidated === true,
      JSON.stringify(movedGoal.goalCoord));

    // 起点/终点不允许被改成障碍物
    await p1.click('#ppToolBlock');
    await clickCell(p1, 0, 0);
    const guard = await getState(p1);
    check('P4.10 拒绝把终点改成障碍物：给出提示且地图不变',
      /不能把起点或终点改成障碍物/.test(guard.error) && guard.blockedCount === 8,
      guard.error);

    // ---------------------------------------------------------------- P5 回放：重置 / 单步 / 播放 / 暂停
    await selectScene(p1, 'walls');
    await click(p1, 'ppReset');
    const atZero = await getState(p1);
    check('P5.1 重置搜索：光标回到 0、Open/Closed 视图清空、最终路径不再显示',
      atZero.cursor === 0 && atZero.overlayCount === 0 && atZero.pathDrawn === false &&
      atZero.playing === false, JSON.stringify({ cursor: atZero.cursor, overlay: atZero.overlayCount }));

    await click(p1, 'ppStep');
    const oneStep = await getState(p1);
    check('P5.2 单步搜索：光标 +1，只展开当前步的 Open/Closed',
      oneStep.cursor === 1 && oneStep.overlayCount >= 1 && oneStep.playing === false &&
      oneStep.pathDrawn === false,
      JSON.stringify({ cursor: oneStep.cursor, overlay: oneStep.overlayCount }));

    await p1.evaluate(() => {
      const el = document.getElementById('ppSpeed');
      el.value = '10';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const fastSpeed = await getState(p1);
    check('P5.3 播放速度可调：滑块拉满后间隔缩短到 62ms', fastSpeed.speed === 62,
      String(fastSpeed.speed));

    await click(p1, 'ppPlay');
    const playing = await getState(p1);
    check('P5.4 自动播放：playing=true 且光标持续推进', playing.playing === true &&
      playing.cursor > oneStep.cursor, JSON.stringify({ cursor: playing.cursor }));
    await sleep(300);
    await click(p1, 'ppPause');
    const paused = await getState(p1);
    await sleep(400);
    const stillPaused = await getState(p1);
    check('P5.5 暂停：立即停止推进（400ms 后光标不变）',
      paused.playing === false && stillPaused.cursor === paused.cursor,
      paused.cursor + ' / ' + stillPaused.cursor);

    await selectScene(p1, 'corner');
    await click(p1, 'ppReset');
    await click(p1, 'ppPlay');
    let finished = null;
    try {
      await p1.waitForFunction(() => {
        const s = window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot'));
        return s && s.playing === false && s.cursor === s.traceLength && s.traceLength > 0;
      }, null, { timeout: 15000 });
      finished = await getState(p1);
    } catch (e) { finished = null; }
    check('P5.6 播放到结束：光标落在末尾、最终路径显示、playing 自动复位',
      !!finished && finished.cursor === finished.traceLength && finished.pathDrawn === true &&
      finished.playing === false && near(finished.cost, 2),
      finished ? JSON.stringify({ cursor: finished.cursor, drawn: finished.pathDrawn }) : 'timeout');

    // ---------------------------------------------------------------- P6 算法切换
    await selectScene(p1, 'open-field');
    await p1.click('#ppAlgoD');
    await sleep(220);
    const asDijkstra = await getState(p1);
    check('P6.1 切到 Dijkstra：算法与启发函数显示更新、重新规划、代价不变（同一代价模型）',
      asDijkstra.algorithm === 'dijkstra' && near(asDijkstra.cost, 11 * Math.SQRT2, 1e-9) &&
      asDijkstra.ab.sameCost === true && asDijkstra.invalidated === false,
      JSON.stringify({ algo: asDijkstra.algorithm, cost: asDijkstra.cost }));
    check('P6.2 Dijkstra 的回放记录比 A* 长（零启发的搜索面更大）',
      asDijkstra.ab.dijkstra.expandedNodes > asDijkstra.ab.astar.expandedNodes,
      asDijkstra.ab.dijkstra.expandedNodes + ' vs ' + asDijkstra.ab.astar.expandedNodes);

    await p1.click('#ppAlgoA');
    await sleep(220);
    const backToA = await getState(p1);
    check('P6.3 切回 A*：路径结果随算法更新（节点数/扩展数来自 A* 的回放）',
      backToA.algorithm === 'astar' && backToA.traceLength === backToA.ab.astar.expandedNodes &&
      near(backToA.cost, 11 * Math.SQRT2, 1e-9), JSON.stringify({ trace: backToA.traceLength }));

    // ---------------------------------------------------------------- P7 非法参数
    await selectScene(p1, 'walls');
    const validBefore = await getState(p1);
    await p1.click('#ppToolCost');
    await setInput(p1, 'ppWeight', 0);
    await clickCell(p1, 3, 3);
    const badWeight = await getState(p1);
    const weightInvalid = await p1.evaluate(() => document.getElementById('ppWeight').getAttribute('aria-invalid'));
    check('P7.1 权重 0 被拒绝：给出错误提示、输入标记 aria-invalid、地图不变、旧结果不被伪造',
      /权重非法/.test(badWeight.error) && weightInvalid === 'true' &&
      badWeight.costlyCount === 0 && badWeight.invalidated === false &&
      near(badWeight.cost, validBefore.cost),
      JSON.stringify({ err: badWeight.error, invalid: weightInvalid }));

    await setInput(p1, 'ppWeight', 5);
    await clickCell(p1, 3, 3);
    const goodWeight = await getState(p1);
    check('P7.2 恢复合法权重后可以正常落笔（不再标记 aria-invalid）',
      goodWeight.costlyCount === 1 && goodWeight.error === '' &&
      (await p1.evaluate(() => document.getElementById('ppWeight').getAttribute('aria-invalid'))) === null);

    await setInput(p1, 'ppSeed', -3);
    await click(p1, 'ppRandom');
    const badSeed = await getState(p1);
    check('P7.3 非法随机种子被拒绝并标记输入，不重建地图',
      /种子必须是正整数/.test(badSeed.error) && badSeed.rows === 11 &&
      (await p1.evaluate(() => document.getElementById('ppSeed').getAttribute('aria-invalid'))) === 'true',
      badSeed.error);

    await setInput(p1, 'ppSeed', 20261126);
    await click(p1, 'ppRandom');
    const randomA = await getState(p1);
    await click(p1, 'ppRandom');
    const randomB = await getState(p1);
    check('P7.4 固定种子随机地图可复现：两次生成的地图与代价一致',
      randomA.rows === 14 && randomA.status === 'found' && randomA.costlyCount > 0 &&
      randomA.blockedCount === randomB.blockedCount && near(randomA.cost, randomB.cost),
      JSON.stringify({ b: randomA.blockedCount, cost: randomA.cost }));

    await p1.click('#ppNbh8');
    await sleep(200);
    const nbh8 = await getState(p1);
    const opts8 = await p1.evaluate(() => Array.from(document.querySelectorAll('#ppHeuristic option')).map(o => o.value));
    check('P7.5 八邻域下启发函数列表不含 Manhattan（结构上避免高估）',
      nbh8.neighborhood === 8 && opts8.indexOf('manhattan') === -1 &&
      opts8.indexOf('octile') !== -1, opts8.join(','));
    await p1.click('#ppNbh4');
    await sleep(200);
    const opts4 = await p1.evaluate(() => Array.from(document.querySelectorAll('#ppHeuristic option')).map(o => o.value));
    check('P7.6 四邻域下重新提供 Manhattan',
      opts4.indexOf('manhattan') !== -1 && opts4.length === 4, opts4.join(','));

    // ---------------------------------------------------------------- P8 无障碍 / 图例 / 键盘
    const a11y = await p1.evaluate(() => {
      const svg = document.getElementById('ppGrid');
      const live = document.getElementById('ppLive');
      const err = document.getElementById('ppError');
      const legend = document.getElementById('ppLegend').textContent;
      return {
        role: svg.getAttribute('role'),
        tab: svg.getAttribute('tabindex'),
        aria: (svg.getAttribute('aria-label') || '').length > 8,
        desc: svg.getAttribute('aria-describedby') === 'ppGridHelp',
        live: live.getAttribute('aria-live') === 'polite',
        errLive: err.getAttribute('aria-live') === 'polite',
        caption: !!document.querySelector('#ppDemoRoot table caption'),
        radioGroups: document.querySelectorAll('#ppDemoRoot [role="radiogroup"]').length,
        legendText: /障碍物/.test(legend) && /Open Set/.test(legend) && /Closed Set/.test(legend) &&
          /起点/.test(legend) && /终点/.test(legend),
        labels: !!document.querySelector('label[for="ppWeight"]') && !!document.querySelector('label[for="ppHeuristic"]')
      };
    });
    check('P8.1 无障碍：SVG role/tabindex/aria-label/describedby、live region、caption、radiogroup、label',
      a11y.role === 'application' && a11y.tab === '0' && a11y.aria && a11y.desc &&
      a11y.live && a11y.errLive && a11y.caption && a11y.radioGroups >= 3 && a11y.labels,
      JSON.stringify(a11y));
    check('P8.2 图例用文字说明每一种状态（不依赖颜色作为唯一信息通道）', a11y.legendText);
    check('P8.3 起点/终点有 S/G 字母标记，障碍物有斜纹、高代价格有数字权重',
      await p1.evaluate(() => {
        const marker = Array.from(document.querySelectorAll('#ppMarkerLayer text')).map(t => t.textContent).join('');
        const hatch = !!document.querySelector('#ppHatch');
        const labels = document.querySelectorAll('.pp-cost-label').length;
        return marker === 'SG' && hatch && labels > 0;
      }));

    await selectScene(p1, 'costly');
    await p1.click('#ppToolBlock');
    const kbBefore = await getState(p1);
    await p1.locator('#ppGrid').focus();
    await p1.keyboard.press('End');
    await sleep(120);
    await p1.keyboard.press('ArrowUp');
    await sleep(120);
    await p1.keyboard.press('Enter');
    await sleep(180);
    const kbAfter = await getState(p1);
    check('P8.4 键盘：Home/End 跳到起终点，方向键移动光标，Enter 应用工具（结果失效）',
      kbAfter.invalidated === true && kbAfter.blockedCount === kbBefore.blockedCount + 1 &&
      kbAfter.error === '',
      JSON.stringify({ blocked: kbAfter.blockedCount }));

    const liveText = await p1.evaluate(() => document.getElementById('ppLive').textContent);
    check('P8.5 键盘操作写入 aria-live 区域（可被读屏获取）', liveText.length > 4, liveText.slice(0, 40));

    // ---------------------------------------------------------------- P9 响应式与深色
    const s2 = await newSession(browser, base, { viewport: { width: 768, height: 900 } });
    const mid = await s2.page.evaluate(() => {
      const s = window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot'));
      return { overflow: document.documentElement.scrollWidth <= window.innerWidth + 1, cost: s.cost, drawn: s.pathDrawn };
    });
    check('P9.1 768px：默认地图规划完成、路径绘制、页面无横向溢出',
      mid.overflow && near(mid.cost, 19) && mid.drawn, JSON.stringify(mid));
    await s2.ctx.close();

    const s3 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p3 = s3.page;
    const mobile = await p3.evaluate(() => {
      const s = window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot'));
      const svg = document.getElementById('ppGrid').getBoundingClientRect();
      const btn = document.getElementById('ppRun').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        svgW: Math.round(svg.width), btnH: Math.round(btn.height),
        cost: s.cost, cells: document.querySelectorAll('.pp-cell').length
      };
    });
    check('P9.2 390px：单列布局、栅格自适应、按钮触控高度 ≥ 40px、无溢出',
      mobile.overflow && mobile.svgW > 240 && mobile.btnH >= 40 && mobile.cells === 154,
      JSON.stringify(mobile));

    const lightStroke = await p3.evaluate(() => getComputedStyle(document.querySelector('.pp-path')).stroke);
    await p3.click('#themeToggle');
    await sleep(320);
    const dark = await p3.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('.pp-path')).stroke,
      startFill: getComputedStyle(document.querySelector('.pp-start')).fill,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    check('P9.3 深色主题：路径与标记颜色随设计令牌切换、无溢出',
      dark.theme === 'dark' && dark.stroke !== lightStroke && dark.overflow,
      lightStroke + ' → ' + dark.stroke);

    await clickCell(p3, 0, 0);   // 触摸设备上仍是同一套指针事件
    const touchEdit = await getState(p3);
    check('P9.4 390px 触摸点击可编辑地图（指针事件在移动端可用）',
      touchEdit.blockedCount === 9 && touchEdit.invalidated === true,
      JSON.stringify({ blocked: touchEdit.blockedCount }));
    check('P9.5 移动端 + 深色切换全程无运行时异常', s3.errors.length === 0, s3.errors.slice(0, 2).join(' | ') || 'none');
    await s3.ctx.close();

    // ---------------------------------------------------------------- P10 旧实验与实验中心
    const s4 = await newSession(browser, base);
    const p4 = s4.page;
    const labRoutes = [
      ['#/lab/robot-2r', '#robotStage'],
      ['#/lab/pid-control', '#pidDemoRoot'],
      ['#/lab/oee-analysis', '#oeeDemoRoot'],
      ['#/lab/spc-analysis', '#spcDemoRoot'],
      ['#/lab/kalman-filter', '#kfDemoRoot'],
      ['#/lab/path-planning', '#ppDemoRoot']
    ];
    let oldOk = true, oldDetail = '';
    for (const [hash, sel] of labRoutes) {
      await p4.evaluate(h => { location.hash = h; }, hash);
      try {
        await p4.waitForSelector(sel, { timeout: 25000 });
      } catch (e) { oldOk = false; oldDetail = hash + ' 未渲染 ' + sel; }
    }
    await p4.evaluate(() => { location.hash = '#/lab'; });
    await p4.waitForSelector('.lab-hub', { timeout: 20000 });
    const hub = await p4.evaluate(() => Array.from(document.querySelectorAll('.lab-hub-card')).map(a => a.getAttribute('href')));
    check('P10.1 实验中心六张卡片，五个旧实验与新实验都能深链渲染',
      oldOk && hub.length === 6 && hub[5] === '#/lab/path-planning', oldDetail || hub.join(','));

    await p4.evaluate(() => { location.hash = '#/lab/robot-2r'; });
    await p4.waitForSelector('#robotStage', { timeout: 20000 });
    const linkCount = await p4.evaluate(() => document.querySelectorAll('.lab-links a').length);
    check('P10.2 旧实验页面互链同步为 7 项（不破坏原有深链接）', linkCount === 7, String(linkCount));

    await p4.evaluate(() => { location.hash = '#/'; });
    await p4.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    const home = await p4.evaluate(() => ({
      cards: document.querySelectorAll('article.article-card').length,
      search: !!document.getElementById('searchInput')
    }));
    check('P10.3 返回首页仍正常（文章卡片与搜索框可见）', home.search && home.cards > 0,
      JSON.stringify(home));
    check('P10.4 全流程无运行时异常', s4.errors.length === 0, s4.errors.slice(0, 2).join(' | ') || 'none');
    await s4.ctx.close();

    // ---------------------------------------------------------------- P11 快速路由
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    for (let i = 0; i < 5; i++) {
      await p5.evaluate(n => {
        location.hash = n % 2 === 0 ? '#/lab/path-planning' : '#/lab/spc-analysis';
      }, i);
      await sleep(90);
    }
    await p5.evaluate(() => { location.hash = '#/lab/path-planning'; });
    await waitReady(p5);
    await sleep(250);
    const rapid = await p5.evaluate(() => ({
      roots: document.querySelectorAll('#ppDemoRoot').length,
      spc: document.querySelectorAll('#spcDemoRoot').length,
      kf: document.querySelectorAll('#kfDemoRoot').length,
      cells: document.querySelectorAll('.pp-cell').length
    }));
    const rapidState = await getState(p5);
    check('P11.1 快速切换 6 次路由：单实例、无串页残留、地图与结果正确',
      rapid.roots === 1 && rapid.spc === 0 && rapid.kf === 0 && rapid.cells === 154 &&
      near(rapidState.cost, 19) && s5.errors.length === 0, JSON.stringify(rapid));
    check('P11.2 离开路由后回放定时器被清理（新实例 playing=false）',
      rapidState.playing === false && rapidState.cursor === rapidState.traceLength);
    await s5.ctx.close();

    // ---------------------------------------------------------------- P12 脚本 404 降级
    for (const block of ['path-planning-demo.js', 'path-planning.js']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      await ctx.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith('http://127.0.0.1') || u.startsWith('data:')) return route.continue();
        return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
      });
      await ctx.route('**/js/' + block + '*', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 60000 });
      await sleep(1200);
      const text = await page.evaluate(() => {
        const el = document.querySelector('.empty-state');
        return el ? el.textContent : '';
      });
      check('P12.1 ' + block + ' 404：显示加载失败与重试，不白屏不抛错',
        /加载失败/.test(text) && /重试/.test(text) && errs.length === 0,
        text.replace(/\s+/g, ' ').slice(0, 46));
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
      check('P12.2 ' + block + ' 404 后仍可回到首页正常使用', errs.length === 0);
      await ctx.close();
    }

    // ---------------------------------------------------------------- P13 离线（SW 预热）
    const s6 = await newSession(browser, base, { sw: true });
    const p6 = s6.page;
    await p6.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p6.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p6.evaluate(() => { location.hash = '#/lab/path-planning'; });
    await waitReady(p6);
    const cached = await p6.evaluate(async () => ({
      math: !!(await caches.match('/blog/js/path-planning.js')),
      ui: !!(await caches.match('/blog/js/path-planning-demo.js'))
    }));
    check('P13.1 两个路径规划脚本进入 SW 缓存（OPTIONAL 预热）', cached.math && cached.ui, JSON.stringify(cached));
    await sleep(400);
    await s6.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p6.reload({ waitUntil: 'load', timeout: 30000 });
      await waitReady(p6, 20000);
      await click(p6, 'ppReset');
      await click(p6, 'ppStep');
      const st = await getState(p6);
      offlineInfo = { cursor: st.cursor, cost: st.cost };
      offlineOk = st.cursor === 1 && near(st.cost, 19);
    } catch (e) { offlineInfo = String(e.message).split('\n')[0]; }
    check('P13.2 离线重载：页面可用、可重置与单步、代价与在线一致', offlineOk, JSON.stringify(offlineInfo));
    await s6.ctx.setOffline(false);
    await s6.ctx.close();

    // ---------------------------------------------------------------- P14 三引擎
    for (const eng of [{ name: 'firefox', launcher: firefox }, { name: 'webkit', launcher: webkit }]) {
      let eb = null;
      try { eb = await eng.launcher.launch({ headless: true }); } catch (e) {
        console.log('SKIP ' + eng.name + ' 不可用：' + String(e.message).split('\n')[0]);
        continue;
      }
      try {
        const ctx = await eb.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        await ctx.route('**/*', route => {
          const u = route.request().url();
          if (u.startsWith('http://127.0.0.1') || u.startsWith('data:')) return route.continue();
          return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
        });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        await page.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 60000 });
        await waitReady(page, 40000);
        const r = await page.evaluate(() => {
          const s = window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot'));
          return {
            cost: s.cost, nodes: s.pathNodes, cells: document.querySelectorAll('.pp-cell').length,
            path: !!document.querySelector('.pp-path'),
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
          };
        });
        check('P14.1 ' + eng.name + ' 390px：代价 19、20 节点、路径绘制、无溢出',
          near(r.cost, 19) && r.nodes === 20 && r.cells === 154 && r.path && r.overflow,
          JSON.stringify(r));
        check('P14.2 ' + eng.name + ' 单步回放可用', await (async () => {
          await page.click('#ppReset');
          await sleep(150);
          await page.click('#ppStep');
          await sleep(150);
          const s = await page.evaluate(() =>
            window.PathPlanningDemo.getState(document.getElementById('ppDemoRoot')));
          return s.cursor === 1;
        })(), 'cursor');
        check('P14.3 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('P14.1 ' + eng.name + ' 390px：代价 19、20 节点、路径绘制、无溢出', false,
          String(e.message).split('\n')[0]);
      } finally {
        await eb.close();
      }
    }
  } finally {
    await browser.close();
    server.server.close();
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(' | ')));
  console.log('total=' + (pass + fail) + ' pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
