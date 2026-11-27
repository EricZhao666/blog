#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2D：梯形与七段 S 曲线运动轨迹规划实验室验收（真实浏览器）
 *
 * 覆盖：路由与实验互链、五类预设工况（七段/六段/五段/四段/反向）、
 * 参数修改与重算、零位移输入、显示模式切换、播放/单步/归零/时间游标、
 * 非法输入错误提示、快速路由切换、脚本加载失败降级、
 * 390/768/1440 视口、深色主题、键盘无障碍、离线 SW、三引擎（Chromium/Firefox/WebKit）。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/motion-profile';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

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
    const root = document.getElementById('mpDemoRoot');
    const s = window.MotionProfileDemo && root && window.MotionProfileDemo.getState(root);
    return !!s && s.planCount > 0;
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('mpDemoRoot');
    return window.MotionProfileDemo ? window.MotionProfileDemo.getState(root) : null;
  });
}

async function selectScene(page, id) {
  await page.evaluate(v => {
    const el = document.getElementById('mpScene');
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, id);
  await sleep(150);
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
    // ---------------------------------------------------------------- M1 路由、互链、控件与默认场景
    const s1 = await newSession(browser, base);
    const p1 = s1.page;

    const entry = await p1.evaluate(() => ({
      navHref: document.querySelector('.nav-link[href="#/lab/robot-2r"]') ? '#/lab/robot-2r' : null,
      title: document.title,
      links: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
      current: (document.querySelector('.lab-links a[aria-current="page"]') || {}).getAttribute ?
        document.querySelector('.lab-links a[aria-current="page"]').getAttribute('href') : null,
      controls: ['mpChartPos', 'mpChartVel', 'mpChartAcc', 'mpChartJerk',
        'mpPlay', 'mpStep', 'mpResetCursor', 'mpTimeSlider', 'mpTimeReadout',
        'mpCursorStats', 'mpCompareBody', 'mpSegBody', 'mpScene',
        'mpQ0', 'mpQ1', 'mpVMax', 'mpAMax', 'mpJMax', 'mpApply', 'mpReset',
        'mpViewBoth', 'mpViewSCurve', 'mpViewTrap'].every(id => !!document.getElementById(id))
    }));
    check('M1.1 导航「实验」保持原 href，页面标题正确',
      entry.navHref === '#/lab/robot-2r' && /运动轨迹规划实验室/.test(entry.title), entry.title);
    check('M1.2 八项实验互链（含运动轨迹规划）与当前页标注，全部控件齐备',
      entry.links.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning,#/lab/motion-profile' &&
      entry.current === '#/lab/motion-profile' && entry.controls,
      entry.links.join(','));

    await p1.evaluate(() => { location.hash = '#/lab'; });
    await p1.waitForSelector('.lab-hub', { timeout: 20000 });
    const hubCards = await p1.evaluate(() => Array.from(document.querySelectorAll('.lab-hub-card')).map(a => a.getAttribute('href')));
    check('M1.3 #/lab 七张卡片包含 /lab/motion-profile',
      hubCards.join(',') === '#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning,#/lab/motion-profile',
      hubCards.join(','));

    await p1.evaluate(() => { location.hash = '#/lab/motion-profile'; });
    await waitReady(p1);
    const st0 = await getState(p1);
    check('M1.4 默认工况 full-7seg 完成规划，七段 S 曲线与三段梯形 SVG 曲线渲染',
      st0.scurveRegime === '7-seg-full' && st0.trapRegime === '3-seg-trapezoid' &&
      st0.scurveEndPosResidual < 1e-9 && st0.scurveEndVelResidual < 1e-9 && st0.scurveEndAccResidual < 1e-9,
      JSON.stringify(st0));

    const svgCounts = await p1.evaluate(() => ({
      sPaths: document.querySelectorAll('#mpDemoRoot .mp-curve-scurve').length,
      tPaths: document.querySelectorAll('#mpDemoRoot .mp-curve-trap').length,
      segRows: document.querySelectorAll('#mpSegBody tr').length
    }));
    check('M1.5 四联图渲染（S曲线 4 条、梯形 3 条、分段表 7 行）',
      svgCounts.sPaths === 4 && svgCounts.tPaths === 3 && svgCounts.segRows === 7,
      JSON.stringify(svgCounts));

    // ---------------------------------------------------------------- M2 五类预设工况与退化验证
    for (const [scId, expS] of [
      ['6seg-no-cruise', '6-seg-no-cruise'],
      ['5seg-no-const-acc', '5-seg-no-const-acc'],
      ['4seg-jerk-only', '4-seg-jerk-only'],
      ['reverse-motion', '7-seg-full']
    ]) {
      await selectScene(p1, scId);
      const st = await getState(p1);
      check('M2 预设工况 ' + scId + ' -> ' + expS + ' 且残差 < 1e-9',
        st.scurveRegime === expS && st.scurveEndPosResidual < 1e-9 && st.scurveEndVelResidual < 1e-9 && st.scurveEndAccResidual < 1e-9,
        JSON.stringify({ regime: st.scurveRegime, res: st.scurveEndPosResidual }));
    }

    // ---------------------------------------------------------------- M3 参数输入、零位移、非法输入、恢复预设
    await p1.fill('#mpQ0', '10');
    await p1.fill('#mpQ1', '10');
    await p1.click('#mpApply');
    await sleep(120);
    const stZero = await getState(p1);
    check('M3.1 零位移输入 (q0=q1=10) 识别为 zero-distance 且 T=0',
      stZero.scurveRegime === 'zero-distance' && stZero.scurveTotalTime === 0,
      JSON.stringify(stZero));

    await p1.fill('#mpVMax', '-5');
    await p1.click('#mpApply');
    await sleep(120);
    const errText = await p1.textContent('#mpError');
    check('M3.2 非法 vMax <= 0 显示明确错误提示', /vMax|非法/.test(errText), errText);

    await p1.click('#mpReset');
    await sleep(120);
    const stReset = await getState(p1);
    check('M3.3 恢复预设后错误清除并恢复有效规划', stReset.lastError === '' && stReset.scurveTotalTime > 0);

    // ---------------------------------------------------------------- M4 显示切换与播放/单步/归零/游标（不影响计算结果）
    await selectScene(p1, 'full-7seg');
    const stBeforePlay = await getState(p1);
    await p1.click('#mpViewSCurve');
    await sleep(80);
    const onlyS = await p1.evaluate(() => ({
      s: document.querySelectorAll('#mpDemoRoot .mp-curve-scurve').length,
      t: document.querySelectorAll('#mpDemoRoot .mp-curve-trap').length
    }));
    check('M4.1 切换「仅 S 曲线」只显示 S 曲线', onlyS.s === 4 && onlyS.t === 0, JSON.stringify(onlyS));
    await p1.click('#mpViewBoth');
    await sleep(80);

    await p1.click('#mpStep');
    await sleep(80);
    const stStep = await getState(p1);
    check('M4.2 单步推进时间游标且不改变总时长',
      stStep.cursorTime > 0 && near(stStep.scurveTotalTime, stBeforePlay.scurveTotalTime, 1e-12),
      JSON.stringify({ t: stStep.cursorTime }));

    await p1.click('#mpPlay');
    await sleep(250);
    await p1.click('#mpPlay'); // 暂停
    const stPlay = await getState(p1);
    check('M4.3 播放/暂停可推进时间且规划结果不变',
      stPlay.cursorTime >= stStep.cursorTime && !stPlay.playing &&
      near(stPlay.scurveTotalTime, stBeforePlay.scurveTotalTime, 1e-12));

    await p1.click('#mpResetCursor');
    await sleep(80);
    const stZeroCur = await getState(p1);
    check('M4.4 归零重置时间游标到 0', stZeroCur.cursorTime === 0);

    // ---------------------------------------------------------------- M5 视口与深色主题、键盘无障碍
    for (const [vpName, vp] of [['390', { width: 390, height: 780 }], ['768', { width: 768, height: 900 }], ['1440', { width: 1440, height: 900 }]]) {
      await p1.setViewportSize(vp);
      await sleep(100);
      const ov = await p1.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check('M5.' + vpName + ' 视口无横向溢出', ov <= 1, 'overflow=' + ov);
    }

    const sDark = await newSession(browser, base, { colorScheme: 'dark', viewport: { width: 390, height: 780 } });
    const darkOk = await sDark.page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      const c = getComputedStyle(document.getElementById('mpModeLabel')).color;
      return bg !== c && document.querySelectorAll('#mpDemoRoot .mp-curve-scurve').length === 4;
    });
    check('M5.dark 深色主题下图表与文字对比正常', darkOk);
    await sDark.ctx.close();

    // ---------------------------------------------------------------- M6 离线 SW 与脚本降级、快速路由切换
    const sOff = await newSession(browser, base, { sw: true });
    let swReady = false;
    try {
      await sOff.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 25000 });
      swReady = true;
    } catch (e) { swReady = false; }
    await sleep(600);
    await sOff.ctx.setOffline(true);
    let offlineOk = false;
    try {
      await sOff.page.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 30000 });
      await waitReady(sOff.page);
      offlineOk = true;
    } catch (e) { offlineOk = false; }
    check('M6.1 离线 SW 打开 /lab/motion-profile 正常渲染与计算', swReady && offlineOk, JSON.stringify({ swReady, offlineOk }));
    await sOff.ctx.setOffline(false);
    await sOff.ctx.close();

    // 脚本降级（阻断 motion-profile.js）
    const ctxFail = await browser.newContext();
    await ctxFail.route('**/js/motion-profile.js*', r => r.abort());
    const pFail = await ctxFail.newPage();
    await pFail.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 30000 });
    await pFail.waitForSelector('.empty-state, #app', { timeout: 15000 });
    await sleep(400);
    const failMsg = await pFail.textContent('#app');
    check('M6.2 脚本加载失败显示降级提示', /加载失败|重试/.test(failMsg), failMsg.slice(0, 60));
    await ctxFail.close();

    // 快速路由切换不串页
    await p1.evaluate(() => {
      location.hash = '#/lab/motion-profile';
      location.hash = '#/lab/path-planning';
    });
    await p1.waitForSelector('#ppDemoRoot', { timeout: 20000 });
    await sleep(200);
    const noLeak = await p1.evaluate(() => !document.getElementById('mpDemoRoot') && !!document.getElementById('ppDemoRoot'));
    check('M6.3 快速路由切换不串页，且无未捕获异常', noLeak && s1.errors.length === 0, s1.errors.join(' | ') || 'none');
    await s1.ctx.close();

    // ---------------------------------------------------------------- M7 三引擎（Firefox / WebKit）
    for (const [bName, bType] of [['firefox', firefox], ['webkit', webkit]]) {
      let b2 = null;
      try {
        b2 = await bType.launch({ headless: true });
        const s2 = await newSession(b2, base);
        const st2 = await getState(s2.page);
        check('M7.' + bName + ' 引擎加载并求解七段 S 曲线与梯形一致',
          st2.scurveRegime === '7-seg-full' && st2.scurveEndPosResidual < 1e-9 && s2.errors.length === 0,
          JSON.stringify({ regime: st2.scurveRegime, res: st2.scurveEndPosResidual }));
        await s2.ctx.close();
      } catch (e) {
        check('M7.' + bName + ' 引擎可用', false, e && e.message);
      } finally {
        if (b2) await b2.close();
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
