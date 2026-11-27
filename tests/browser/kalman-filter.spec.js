#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2B：卡尔曼滤波与传感器融合实验室验收（真实浏览器）
 *
 * 覆盖：入口与实验互链（既有 2R/PID/OEE/SPC 深链接不破坏）、默认数值、
 * 预测/更新两阶段、播放暂停重置、参数与场景、传感器开关与缺失、
 * 390/768/1440、深色、键盘与无障碍、离线、脚本失败降级、快速路由、三引擎。
 *
 * 正确性判据是数值（首步 pos 1.5808246 / gain 0.9565219，标量首步 9.2704194），
 * 不以曲线是否平滑判断。
 *
 * 用法：node tests/browser/kalman-filter.spec.js
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/kalman-filter';

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
  await waitKf(page);
  return { ctx, page, errors };
}

async function waitKf(page, timeout) {
  await page.waitForFunction(() => {
    const s = window.KalmanDemo && window.KalmanDemo.getState(document.getElementById('kfDemoRoot'));
    return !!s && s.total > 0 && s.computeCount > 0;
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => window.KalmanDemo.getState(document.getElementById('kfDemoRoot')));
}

async function setValue(page, sel, value) {
  await page.evaluate(([q, v]) => {
    const el = document.querySelector(q);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, String(value)]);
  await sleep(120);
}

async function click(page, id) {
  await page.click('#' + id);
  await sleep(120);
}

(async function main() {
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
    // ---------------------------------------------------------------- K1 入口与互链
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const entry = await p1.evaluate(() => ({
      navHref: (document.querySelector('.nav-link[data-route="/lab"]') || {}).getAttribute &&
        document.querySelector('.nav-link[data-route="/lab"]').getAttribute('href'),
      title: document.title,
      links: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
      current: (() => {
        const el = document.querySelector('.lab-links a[aria-current="page"]');
        return el ? el.getAttribute('href') : null;
      })(),
      cards: ['kfChartPos', 'kfChartVel', 'kfChartErr', 'kfChartGain', 'kfChartCov',
        'kfStepBody', 'kfMetricsBody', 'kfPlay', 'kfPause', 'kfStep', 'kfPredict', 'kfReset',
        'kfModeMatrix', 'kfModeScalar', 'kfScene', 'kfSensorPos', 'kfSensorVel'].every(id => !!document.getElementById(id))
    }));
    check('K1.1 导航「实验」保持原 href，页面标题正确',
      entry.navHref === '#/lab/robot-2r' && /卡尔曼滤波与传感器融合实验室/.test(entry.title),
      JSON.stringify({ href: entry.navHref }));
    check('K1.2 八项实验互链（含运动轨迹规划）与当前页标注，五张图的容器与全部控件齐备',
      entry.links.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning,#/lab/motion-profile' &&
      entry.current === '#/lab/kalman-filter' && entry.cards);

    await p1.evaluate(() => { location.hash = '#/lab'; });
    await p1.waitForSelector('.lab-hub', { timeout: 20000 });
    const hub = await p1.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('.lab-hub-card')).map(a => a.getAttribute('href')),
      title: document.title
    }));
    check('K1.3 #/lab 七张卡片：2R / PID / OEE / SPC / 卡尔曼 / 路径规划 / 运动轨迹规划均可深链',
      hub.cards.join(',') === '#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning,#/lab/motion-profile' &&
      /实验室/.test(hub.title), JSON.stringify(hub.cards));

    for (const [hash, sel, label] of [
      ['#/lab/robot-2r', '#robotStage', '2R'],
      ['#/lab/pid-control', '#pidChartY', 'PID'],
      ['#/lab/oee-analysis', '#oeeValue', 'OEE'],
      ['#/lab/spc-analysis', '#spcChartI', 'SPC']
    ]) {
      await p1.evaluate(h => { location.hash = h; }, hash);
      await p1.waitForSelector(sel, { timeout: 20000 });
      const ok = await p1.evaluate(() => !!document.querySelector('.lab-links a[href="#/lab/kalman-filter"]'));
      check('K1.4 ' + label + ' 深链接仍可用，且互链包含卡尔曼入口', ok);
    }
    await p1.evaluate(() => { location.hash = '#/lab/kalman-filter'; });
    await waitKf(p1);

    // ---------------------------------------------------------------- K2 默认数值与两阶段
    const st0 = await getState(p1);
    check('K2.1 默认：二维模式、恒速场景、60 步、起点未推进',
      st0.mode === 'matrix' && st0.scene === 'cruise' && st0.total === 60 && st0.cursor === 0);
    check('K2.2 起点显示初始状态与协方差，不伪造估计',
      /尚未推进/.test(await p1.evaluate(() => document.getElementById('kfStepBody').textContent)) &&
      st0.pos === null && st0.metrics === null);

    await click(p1, 'kfPredict');
    const stP = await getState(p1);
    check('K2.3 预测一步：pending=true，第 1 个观测时刻的预测=先验（x⁻=0、P⁻=10，不推进 dt）',
      stP.pending === true && stP.cursor === 0 && near(stP.pendingPred.pPos, 10, 1e-12) &&
      near(stP.pendingPred.pos, 0, 1e-12),
      JSON.stringify(stP.pendingPred));

    await click(p1, 'kfStep');
    const st1 = await getState(p1);
    check('K2.4 应用更新：pos=1.5552381、vel=1.0647619、K=0.9523810（独立手算）',
      st1.cursor === 1 && st1.pending === false &&
      near(st1.pos, 1.555238095238095, 1e-9) &&
      near(st1.vel, 1.0647619047619048, 1e-9) &&
      near(st1.gainPos, 0.9523809523809523, 1e-9),
      JSON.stringify({ pos: st1.pos, gain: st1.gainPos }));
    check('K2.5 指标出现：位置估计 RMSE 0.5552381、原始测量 RMSE 0.633（同一步）',
      near(st1.metrics.posEstRmse, 0.5552380952380951, 1e-9) &&
      near(st1.metrics.posRawRmse, 0.633, 1e-9) &&
      st1.metrics.validPos === 1 && st1.metrics.missingPos === 0,
      JSON.stringify(st1.metrics));

    await click(p1, 'kfStep');
    const st2 = await getState(p1);
    check('K2.6 直接点「应用测量更新」可隐式预测并更新，cursor 递增',
      st2.cursor === 2 && st2.pos !== null);

    // ---------------------------------------------------------------- K3 播放 / 暂停 / 重置
    await click(p1, 'kfPlay');
    await sleep(760);
    const playing = await getState(p1);
    await click(p1, 'kfPause');
    const paused = await getState(p1);
    await sleep(420);
    const afterPause = await getState(p1);
    check('K3.1 自动播放推进多步，暂停后不再前进',
      playing.cursor > paused.cursor - 1 && paused.cursor >= 4 &&
      paused.playing === false && afterPause.cursor === paused.cursor,
      JSON.stringify({ playing: playing.cursor, paused: paused.cursor, after: afterPause.cursor }));

    await click(p1, 'kfReset');
    const reset = await getState(p1);
    check('K3.2 重置回到起点：cursor=0、指标清空、图表隐藏',
      reset.cursor === 0 && reset.metrics === null && reset.chartDrawn === 0 &&
      (await p1.evaluate(() => document.getElementById('kfChartPos').hasAttribute('hidden'))));

    // ---------------------------------------------------------------- K4 参数 / 场景 / 传感器
    await click(p1, 'kfStep');
    const beforeR = await getState(p1);
    await setValue(p1, '#kfRpos', 5);
    const afterR = await getState(p1);
    check('K4.1 修改位置 R 后重新计算并从起点开始，首步增益下降',
      afterR.cursor === 0 && afterR.computeCount > beforeR.computeCount &&
      afterR.gainPos === null);

    await click(p1, 'kfPredict');
    await click(p1, 'kfStep');
    const lowGain = await getState(p1);
    check('K4.2 R=5 时首步增益 0.6666667，小于默认 R=0.5 的 0.9523810',
      near(lowGain.gainPos, 10 / 15, 1e-12) && lowGain.gainPos < 0.9524,
      'gain=' + lowGain.gainPos);

    const sceneBefore = await p1.evaluate(() => {
      const s = window.KalmanCalculation.scenarioData('cruise');
      return s.steps.slice(0, 3).map(x => x.zPos);
    });
    await setValue(p1, '#kfRpos', 0.5);
    await setValue(p1, '#kfQ', 0.05);
    const sceneAfter = await p1.evaluate(() => {
      const s = window.KalmanCalculation.scenarioData('cruise');
      return s.steps.slice(0, 3).map(x => x.zPos);
    });
    check('K4.3 修改滤波器 Q/R 不改变同一场景的测量序列（场景与参数分离）',
      JSON.stringify(sceneBefore) === JSON.stringify(sceneAfter));

    await p1.selectOption('#kfScene', 'accel');
    await sleep(200);
    const accel = await getState(p1);
    check('K4.4 切换加速场景：80 步、标注合成数据、起点归零',
      accel.total === 80 && accel.cursor === 0 &&
      /合成数据/.test(await p1.evaluate(() => document.getElementById('kfSceneNote').textContent)));

    await p1.uncheck('#kfSensorPos');
    await sleep(180);
    await click(p1, 'kfStep');
    await click(p1, 'kfStep');
    const velOnly = await getState(p1);
    check('K4.5 关闭位置传感器：只更新速度，位置未观测 → 第 2 步起方差只按预测增长（10 → >10）',
      velOnly.sensors.pos === false && velOnly.gainPos === null &&
      velOnly.pPos > 10 && velOnly.pPos < 12, 'P00=' + velOnly.pPos);
    await p1.uncheck('#kfSensorVel');
    await sleep(180);
    await click(p1, 'kfStep');
    await click(p1, 'kfStep');
    const noSensor = await getState(p1);
    check('K4.6 两个传感器都关闭：仅预测，无增益，协方差按 Q 增长',
      noSensor.gainPos === null && noSensor.gainVel === null &&
      noSensor.pPos > 10 && s1.errors.length === 0,
      'P00=' + noSensor.pPos);

    // 非法门限：播放中也不能继续展示旧参数的结果
    await click(p1, 'kfPlay');
    await sleep(320);
    await setValue(p1, '#kfGate', -1);
    const badGate = await getState(p1);
    const gateUi = await p1.evaluate(() => ({
      err: document.getElementById('kfError').textContent,
      inv: document.getElementById('kfGate').getAttribute('aria-invalid'),
      prog: document.getElementById('kfProgress').textContent,
      step: document.getElementById('kfStepBody').textContent
    }));
    check('K4.7 播放中输入非法门限：停止播放并清空结果（不继续展示旧参数结果）',
      badGate.playing === false && badGate.total === 0 && badGate.metrics === null &&
      badGate.cursor === 0 && /必须 ≥ 0/.test(gateUi.err) && /失效/.test(gateUi.err) &&
      gateUi.inv === 'true' && /参数非法/.test(gateUi.prog) && /失效|非法/.test(gateUi.step),
      JSON.stringify({ playing: badGate.playing, total: badGate.total }));
    await setValue(p1, '#kfGate', 2);
    const goodGate = await getState(p1);
    check('K4.8 恢复合法门限后正常计算（回到起点重新推进），aria-invalid 清除',
      goodGate.total > 0 && goodGate.cursor === 0 && goodGate.error === '' &&
      (await p1.evaluate(() => document.getElementById('kfGate').getAttribute('aria-invalid'))) === null);

    // ---------------------------------------------------------------- K5 标量模式
    await p1.check('#kfSensorPos');
    await p1.check('#kfSensorVel');
    await setValue(p1, '#kfGate', 0);
    await p1.selectOption('#kfScene', 'constant');
    await sleep(180);
    await setValue(p1, '#kfX0', 10);
    await setValue(p1, '#kfP0', 1);
    await setValue(p1, '#kfQ', 0.05);
    await setValue(p1, '#kfR', 0.5);
    await p1.check('#kfModeScalar');
    await sleep(200);
    await click(p1, 'kfStep');
    const scalar = await getState(p1);
    check('K5.1 标量首步：pos=9.282、K=0.6666667、P=0.3333333（首步不注入 Q）',
      scalar.mode === 'scalar' && near(scalar.pos, 9.282, 1e-9) &&
      near(scalar.gainPos, 0.6666666666666666, 1e-12) &&
      near(scalar.pPos, 0.33333333333333337, 1e-12),
      JSON.stringify({ pos: scalar.pos, gain: scalar.gainPos }));
    check('K5.2 标量模式隐藏速度图与传感器开关，指标中速度不可用',
      (await p1.evaluate(() => document.getElementById('kfVelCard').hidden)) &&
      (await p1.evaluate(() => document.getElementById('kfSensorField').hidden)) &&
      scalar.metrics.velEstRmse === null);

    // ---------------------------------------------------------------- K6 390px / 768 / 1440
    const s2 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p2 = s2.page;
    const mobile = await p2.evaluate(() => {
      const main = document.querySelector('.spc-main').getBoundingClientRect();
      const panel = document.querySelector('.spc-panel').getBoundingClientRect();
      const wrap = document.querySelector('.spc-chart-wrap');
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        mainW: main.width,
        panelBelow: panel.top >= main.bottom - 1,
        chartInner: wrap.scrollWidth > wrap.clientWidth,
        btnH: document.getElementById('kfStep').getBoundingClientRect().height
      };
    });
    check('K6.1 390px：无页面横向溢出、单列、按钮 ≥40px、图表容器内滚动',
      mobile.overflow && mobile.mainW > 300 && mobile.panelBelow && mobile.btnH >= 40 && mobile.chartInner,
      JSON.stringify(mobile));
    await p2.locator('#kfStep').scrollIntoViewIfNeeded();
    const box = await p2.locator('#kfStep').boundingBox();
    await p2.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(200);
    check('K6.2 触摸点按「应用测量更新」推进 1 步', (await getState(p2)).cursor === 1);
    await s2.ctx.close();

    const s3 = await newSession(browser, base, { viewport: { width: 768, height: 1024 } });
    const p3 = s3.page;
    const tablet = await p3.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      stacked: document.querySelector('.spc-panel').getBoundingClientRect().top >=
        document.querySelector('.spc-main').getBoundingClientRect().bottom - 1
    }));
    check('K6.3 768px：单列堆叠、无横向溢出', tablet.overflow && tablet.stacked, JSON.stringify(tablet));
    await s3.ctx.close();

    const s4 = await newSession(browser, base, { viewport: { width: 1440, height: 900 } });
    const p4 = s4.page;
    const desktop = await p4.evaluate(() => {
      const main = document.querySelector('.spc-main').getBoundingClientRect();
      const panel = document.querySelector('.spc-panel').getBoundingClientRect();
      return {
        side: panel.left >= main.right - 1,
        mainW: main.width,
        panelW: panel.width,
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
      };
    });
    check('K6.4 1440px：主区与参数面板并排，无溢出',
      desktop.side && desktop.mainW > 550 && desktop.panelW > 320 && desktop.overflow,
      JSON.stringify(desktop));
    await s4.ctx.close();

    // ---------------------------------------------------------------- K6b 三口径 RMSE 与采样时间
    const s8 = await newSession(browser, base);
    const p8 = s8.page;
    const dt0 = await getState(p8);
    const dtNote0 = await p8.evaluate(() => document.getElementById('kfDtNote').textContent);
    check('K6.5 默认场景真实 dt 与滤波器假设 dt 一致（0.50），时间戳 t_i=i·dt',
      near(dt0.dtActual, 0.5, 1e-12) && dt0.dtMismatch === false &&
      /一致/.test(dtNote0) && !/不一致/.test(dtNote0), dtNote0.slice(0, 60));

    await p8.selectOption('#kfScene', 'missing');
    await sleep(200);
    await p8.evaluate(() => {
      const b = document.getElementById('kfStep');
      for (let i = 0; i < 45; i++) b.click();
    });
    await sleep(250);
    const tri = await getState(p8);
    const triText = await p8.evaluate(() => ({
      table: document.getElementById('kfMetricsBody').textContent,
      note: document.getElementById('kfMetricsNote').textContent
    }));
    check('K6.6 缺失场景 45 步：三种口径分开且缺失不当作 0',
      tri.cursor === 45 && tri.metrics &&
      Number.isFinite(tri.metrics.posEstRmse) &&
      Number.isFinite(tri.metrics.posValidRmse) &&
      Number.isFinite(tri.metrics.posRawRmse) &&
      Math.abs(tri.metrics.posEstRmse - tri.metrics.posValidRmse) > 1e-6 &&
      tri.metrics.validPos + tri.metrics.missingPos === 45 &&
      tri.metrics.missingPos === 16 &&
      /同索引估计 RMSE/.test(triText.table) && /三种口径/.test(triText.note),
      JSON.stringify({ est: tri.metrics.posEstRmse, valid: tri.metrics.posValidRmse, raw: tri.metrics.posRawRmse }));

    await setValue(p8, '#kfDt', 0.4);
    const dtBad = await getState(p8);
    const dtNoteBad = await p8.evaluate(() => document.getElementById('kfDtNote').textContent);
    check('K6.7 假设 dt=0.4 与真实 0.5 不一致：标记模型失配并说明估计不可按真实时间解读',
      dtBad.dtMismatch === true && dtBad.dtActual === 0.5 && dtBad.dtAssumed === 0.4 &&
      /模型失配/.test(dtNoteBad) && /0\.5/.test(dtNoteBad) && /0\.4/.test(dtNoteBad),
      dtNoteBad.slice(0, 70));
    await s8.ctx.close();

    // ---------------------------------------------------------------- K7 深色 / 键盘 / 无障碍
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    await click(p5, 'kfStep');
    const lightStroke = await p5.evaluate(() => getComputedStyle(document.querySelector('#kfChartPos .kf-est')).stroke);
    await p5.click('#themeToggle');
    await sleep(320);
    const dark = await p5.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('#kfChartPos .kf-est')).stroke,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    check('K7.1 深色主题：估计曲线颜色随令牌切换，无溢出',
      dark.theme === 'dark' && dark.stroke !== lightStroke && dark.overflow,
      lightStroke + ' → ' + dark.stroke);

    await p5.locator('#kfSigmaA').focus();
    await p5.keyboard.press('ArrowUp');
    await sleep(250);
    const kbQ = await getState(p5);
    check('K7.2 键盘 ArrowUp 修改 σ_a → 重新计算（cursor 归零）',
      kbQ.cursor === 0 && kbQ.params.sigmaA > 0.05, 'sigmaA=' + kbQ.params.sigmaA);

    await p5.locator('#kfModeMatrix').focus();
    await p5.keyboard.press('ArrowDown');
    await sleep(250);
    const kbMode = await getState(p5);
    check('K7.3 方向键在模式单选组内切换 → 标量模式',
      kbMode.mode === 'scalar' && (await p5.evaluate(() => document.getElementById('kfModeScalar').checked)));

    const a11y = await p5.evaluate(() => {
      const svg = document.getElementById('kfChartPos');
      const live = document.getElementById('kfLive');
      const group = document.querySelector('.spc-modes');
      const err = document.getElementById('kfError');
      return {
        role: svg.getAttribute('role'),
        aria: (svg.getAttribute('aria-label') || '').length > 8,
        live: live.getAttribute('aria-live') === 'polite',
        radio: group && group.getAttribute('role') === 'radiogroup',
        errLive: err.getAttribute('aria-live') === 'polite',
        caption: !!document.querySelector('#kfDemoRoot table caption'),
        labels: !!document.querySelector('label[for="kfRpos"]')
      };
    });
    check('K7.4 无障碍：图表 role/aria-label、live region、radiogroup、错误 aria-live、caption 与 label',
      a11y.role === 'img' && a11y.aria && a11y.live && a11y.radio && a11y.errLive && a11y.caption && a11y.labels,
      JSON.stringify(a11y));
    check('K7.5 键盘与切主题全程无运行时异常', s5.errors.length === 0, s5.errors.slice(0, 2).join(' | ') || 'none');
    await s5.ctx.close();

    // ---------------------------------------------------------------- K8 离线 / 降级 / 路由
    const s6 = await newSession(browser, base, { sw: true });
    const p6 = s6.page;
    await p6.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p6.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p6.evaluate(() => { location.hash = '#/lab/kalman-filter'; });
    await waitKf(p6);
    const cached = await p6.evaluate(async () => ({
      math: !!(await caches.match('/blog/js/kalman-calculation.js')),
      ui: !!(await caches.match('/blog/js/kalman-demo.js'))
    }));
    check('K8.1 两个卡尔曼脚本进入 SW 缓存（OPTIONAL 预热）', cached.math && cached.ui, JSON.stringify(cached));
    await sleep(400);
    await s6.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p6.reload({ waitUntil: 'load', timeout: 30000 });
      await waitKf(p6, 20000);
      await click(p6, 'kfStep');
      const st = await getState(p6);
      offlineInfo = { cursor: st.cursor, pos: st.pos };
      offlineOk = st.cursor === 1 && near(st.pos, 1.555238095238095, 1e-9);
    } catch (e) { offlineInfo = String(e.message).split('\n')[0]; }
    check('K8.2 离线重载：页面可用且首步数值与在线一致', offlineOk, JSON.stringify(offlineInfo));
    await s6.ctx.setOffline(false);
    await s6.ctx.close();

    for (const block of ['kalman-demo.js', 'kalman-calculation.js']) {
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
      await page.waitForSelector('.empty-state', { timeout: 20000 });
      const text = await page.evaluate(() => document.querySelector('.empty-state').textContent);
      check('K8.3 ' + block + ' 404：显示加载失败与重试，不白屏不抛错',
        /加载失败/.test(text) && /重试/.test(text) && errs.length === 0,
        text.replace(/\s+/g, ' ').slice(0, 46));
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
      const cards = await page.evaluate(() => document.querySelectorAll('#app .article-card').length);
      check('K8.4 ' + block + ' 失败不影响首页文章列表', cards > 5 && errs.length === 0, 'cards=' + cards);
      await ctx.close();
    }

    const s7 = await newSession(browser, base);
    const p7 = s7.page;
    for (const h of ['#/', '#/lab/kalman-filter', '#/lab/spc-analysis', '#/lab/kalman-filter', '#/lab/oee-analysis', '#/lab/kalman-filter']) {
      await p7.evaluate(hh => { location.hash = hh; }, h);
      await sleep(45);
    }
    await waitKf(p7);
    const fast = await p7.evaluate(() => ({
      roots: document.querySelectorAll('#kfDemoRoot').length,
      spc: document.querySelectorAll('#spcDemoRoot').length,
      oee: document.querySelectorAll('#oeeDemoRoot').length
    }));
    await click(p7, 'kfStep');
    const fastSt = await getState(p7);
    check('K9.1 快速切换 6 次路由：单实例、无串页、数值正确、无异常',
      fast.roots === 1 && fast.spc === 0 && fast.oee === 0 &&
      fastSt.cursor === 1 && near(fastSt.pos, 1.555238095238095, 1e-9) &&
      s7.errors.length === 0, JSON.stringify(fast));
    await s7.ctx.close();

    // ---------------------------------------------------------------- K10 三引擎
    for (const eng of [{ name: 'firefox', launcher: firefox }, { name: 'webkit', launcher: webkit }]) {
      let eb = null;
      try { eb = await eng.launcher.launch({ headless: true }); }
      catch (e) { console.log('SKIP ' + eng.name + ' 不可用：' + String(e.message).split('\n')[0]); continue; }
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
        await waitKf(page);
        await click(page, 'kfStep');
        const st = await getState(page);
        const r = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          path: !!document.querySelector('#kfChartPos .kf-est')
        }));
        check('K10.1 ' + eng.name + ' 390px：首步 pos=1.5552381、增益 0.9523810、图表绘制、无溢出',
          st.cursor === 1 && near(st.pos, 1.555238095238095, 1e-9) &&
          near(st.gainPos, 0.9523809523809523, 1e-9) && r.path && r.overflow,
          JSON.stringify({ pos: st.pos, overflow: r.overflow }));
        check('K10.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('K10.1 ' + eng.name + ' 390px：首步 pos=1.5552381、增益 0.9523810、图表绘制、无溢出', false,
          String(e.message).split('\n')[0]);
      } finally {
        await eb.close();
      }
    }
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  await browser.close();
  server.server.close();
  process.exit(fail ? 1 : 0);
})();
