#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1B：真实浏览器下的 PID 控制实验室验收
 *
 * 覆盖：入口与实验互链（深链接不破坏）、默认数值一致性（getState + 页内独立重算 + 曲线端点反算）、
 * 参数/设定值/对象调节、P/PI/PID/对比模式、饱和可视化与抗饱和对比、非法输入拒绝、恢复默认、
 * 防抖有界计算、未稳定如实显示、390px 移动布局与触摸、深色主题、键盘与无障碍、离线、
 * 脚本失败降级、快速路由切换、Firefox/WebKit 代表性场景。
 *
 * 正确性判据全部是数值断言，不凭曲线是否绘制判断。
 *
 * 用法：node tests/browser/pid-control.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/pid-control';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  await waitPid(page);
  return { ctx, page, errors };
}

async function waitPid(page, timeout) {
  await page.waitForSelector('#pidChartY', { state: 'visible', timeout: timeout || 30000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('pidStatus');
    return !!s && s.textContent !== '–';
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => window.PidDemo.getState(document.getElementById('pidDemoRoot')));
}

// 页内独立重算：正确性判据是数值，不是曲线
function verifyInPage(page) {
  return page.evaluate(() => {
    const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
    const cfg = Object.assign({}, st.config);
    if (cfg.mode === 'compare') cfg.mode = 'PID';
    const r = window.PidSimulation.simulate(cfg);
    return {
      st,
      yDelta: Math.abs(r.y[r.y.length - 1] - st.yFinal),
      essDelta: Math.abs(r.metrics.ess - st.metrics.ess),
      finite: [st.yFinal, st.uFinal, st.metrics.ess].every(v => v === null || Number.isFinite(v))
    };
  });
}

async function setInput(page, sel, value) {
  const s = String(value);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    await page.fill(sel, s);
    await page.locator(sel).press('Enter');
  } else {
    await page.evaluate(([q, v]) => {
      const el = document.querySelector(q);
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, [sel, s]);
  }
  await sleep(80);
}

async function setSlider(page, sel, value) {
  await page.evaluate(([q, v]) => {
    const el = document.querySelector(q);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [sel, value]);
  await sleep(250);
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
    // ---------------------------------------------------------------- R1 入口与互链
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const entry = await p1.evaluate(() => {
      const link = document.querySelector('.nav-link[data-route="/lab"]');
      return {
        navHref: link && link.getAttribute('href'),
        active: !!link && link.classList.contains('active'),
        title: document.title,
        charts: !!document.getElementById('pidChartY') && !!document.getElementById('pidChartU'),
        readout: ['pidRise', 'pidOvershoot', 'pidSettling', 'pidEss', 'pidURange', 'pidSatCount', 'pidStatus']
          .every(id => !!document.getElementById(id)),
        labLinks: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
        currentHref: (() => {
          const el = document.querySelector('.lab-links a[aria-current="page"]');
          return el ? el.getAttribute('href') : null;
        })()
      };
    });
    check('R1.1 导航「实验」入口保持原 href、当前页激活、标题正确',
      entry.navHref === '#/lab/robot-2r' && entry.active && /PID 控制系统交互实验室/.test(entry.title),
      JSON.stringify({ href: entry.navHref, title: entry.title }));
    check('R1.2 双图表与全部读数项渲染；实验互链含列表/2R/PID/OEE/SPC/卡尔曼/路径规划且当前页标注',
      entry.charts && entry.readout &&
      entry.labLinks.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning' &&
      entry.currentHref === '#/lab/pid-control');

    await p1.evaluate(() => { location.hash = '#/lab'; });
    await p1.waitForSelector('.lab-hub', { timeout: 20000 });
    const hub = await p1.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('.lab-hub-card')).map(a => a.getAttribute('href')),
      title: document.title
    }));
    check('R1.3 #/lab 实验列表：六张卡片分别深链 2R、PID、OEE、SPC、卡尔曼与路径规划',
      hub.cards.join(',') === '#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning' &&
      /实验室/.test(hub.title), JSON.stringify(hub));

    await p1.evaluate(() => { location.hash = '#/lab/robot-2r'; });
    await p1.waitForSelector('#robotStage', { timeout: 20000 });
    const robotLinks = await p1.evaluate(() => ({
      pidLink: !!document.querySelector('.lab-links a[href="#/lab/pid-control"]'),
      stage: !!document.getElementById('robotStage'),
      status: document.getElementById('robotStatus').textContent
    }));
    check('R1.4 2R 深链接不破坏：页面正常且互链提供 PID 入口',
      robotLinks.pidLink && robotLinks.stage && robotLinks.status !== '–');
    await p1.evaluate(() => { location.hash = '#/lab/pid-control'; });
    await waitPid(p1);

    // ---------------------------------------------------------------- R2 默认数值一致性
    const st0 = await getState(p1);
    const D = await p1.evaluate(() => window.PidDemo.DEFAULTS);
    const cfgMatch = Object.keys(D).every(k => st0.config[k] === D[k]);
    check('R2.1 默认配置与 DEFAULTS 一致、已稳定、yFinal≈1、数值有限',
      cfgMatch && st0.settled && Math.abs(st0.yFinal - 1) < 0.01 && st0.n === 600,
      'yFinal=' + st0.yFinal.toFixed(4));
    const v0 = await verifyInPage(p1);
    check('R2.2 页内独立重算与 getState 一致（yFinal/ess <1e-9）',
      v0.yDelta < 1e-9 && v0.essDelta < 1e-9 && v0.finite,
      'yΔ=' + v0.yDelta.toExponential(2));
    const curve = await p1.evaluate(() => {
      const svg = document.getElementById('pidChartY');
      const pl = svg.querySelector('.pid-curve--pid');
      const pts = pl.getAttribute('points').trim().split(/\s+/);
      const last = pts[pts.length - 1].split(',').map(Number);
      const ymin = Number(svg.getAttribute('data-ymin')), ymax = Number(svg.getAttribute('data-ymax'));
      const v = ymax - (last[1] - 16) / 254 * (ymax - ymin);
      const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
      return { v, yFinal: st.yFinal, x: last[0], count: pts.length };
    });
    check('R2.3 曲线末点反算数值 = yFinal（显示抽稀 ≤800 点，端点保留）',
      Math.abs(curve.v - curve.yFinal) < 0.01 && curve.x === 626 && curve.count <= 801,
      JSON.stringify(curve));

    // ---------------------------------------------------------------- R3 参数调节
    const before = await getState(p1);
    await setInput(p1, '#pidKp', 3);
    const afterKp = await getState(p1);
    check('R3.1 Kp 输入生效：config.kp=3，指标变化，重算计数增加',
      afterKp.config.kp === 3 && afterKp.computeCount > before.computeCount &&
      afterKp.metrics.rise !== before.metrics.rise);
    await p1.evaluate(() => document.getElementById('pidKp').blur());
    await setSlider(p1, '#pidKpRange', 5);
    const afterSlider = await p1.evaluate(() => ({
      kp: window.PidDemo.getState(document.getElementById('pidDemoRoot')).config.kp,
      num: document.getElementById('pidKp').value
    }));
    check('R3.2 滑杆拖动同步数字输入并重算：kp=5', afterSlider.kp === 5 && afterSlider.num === '5', JSON.stringify(afterSlider));

    await p1.selectOption('#pidDuration', '20');
    await sleep(200);
    await setInput(p1, '#pidSetpoint', 1.5);
    const afterR = await getState(p1);
    check('R3.3 设定值 1.5（20s 仿真）：yFinal≈1.5（未饱和）', Math.abs(afterR.yFinal - 1.5) < 0.02, 'yFinal=' + afterR.yFinal.toFixed(4));
    await setInput(p1, '#pidPlantK', 2);
    const afterK = await getState(p1);
    check('R3.4 对象增益 K=2：稳态控制量 u≈r/K=0.75', Math.abs(afterK.uFinal - 0.75) < 0.02, 'uFinal=' + afterK.uFinal.toFixed(4));
    await s1.ctx.close();

    // ---------------------------------------------------------------- R4 模式与对比
    const s2 = await newSession(browser, base);
    const p2 = s2.page;
    await p2.click('#pidModeP');
    await sleep(150);
    const pMode = await getState(p2);
    check('R4.1 P 模式：ess≈r/(1+K·Kp)=1/2.2，积分恒为零',
      Math.abs(pMode.metrics.ess - 1 / 2.2) < 1e-3 && pMode.stats.maxI === 0 && pMode.stats.minI === 0,
      'ess=' + pMode.metrics.ess.toFixed(4));
    await p2.click('#pidModePI');
    await sleep(150);
    const piMode = await getState(p2);
    check('R4.2 PI 模式：阶跃稳态误差基本消除（|ess|<0.01）',
      Math.abs(piMode.metrics.ess) < 0.01 && piMode.stats.maxD === 0, 'ess=' + piMode.metrics.ess.toExponential(2));
    await p2.click('#pidModeCompare');
    await sleep(250);
    const cmp = await p2.evaluate(() => {
      const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
      return {
        st,
        curves: document.querySelectorAll('#pidChartY .pid-curve').length,
        rows: document.querySelectorAll('#pidCompareBody tr').length,
        wrapVisible: !document.getElementById('pidCompareWrap').hidden
      };
    });
    check('R4.3 对比模式：三条曲线 + 三行指标表，P/PI/PID 数值齐全',
      cmp.curves === 3 && cmp.rows === 3 && cmp.wrapVisible &&
      cmp.st.compare && Math.abs(cmp.st.compare.P.metrics.ess - 1 / 2.2) < 1e-3 &&
      Math.abs(cmp.st.compare.PI.yFinal - 1) < 0.02,
      JSON.stringify({ curves: cmp.curves, rows: cmp.rows }));
    check('R4.4 对比中 P 分支无积分状态（模式屏蔽 Ki/Kd）',
      cmp.st.compare.P.stats.maxI === 0 && cmp.st.compare.P.stats.maxD === 0);
    await s2.ctx.close();

    // ---------------------------------------------------------------- R5 饱和与抗饱和
    const s3 = await newSession(browser, base);
    const p3 = s3.page;
    await setInput(p3, '#pidUMax', 0.5);
    await setInput(p3, '#pidUMin', -0.5);
    const sat = await p3.evaluate(() => {
      const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
      return {
        st,
        bands: document.querySelectorAll('#pidChartU .pid-sat-band').length,
        status: document.getElementById('pidStatus').textContent
      };
    });
    check('R5.1 限幅 0.5：输出严格限幅、饱和步数>0、红色饱和竖带渲染、状态提示饱和',
      sat.st.stats.maxU <= 0.5 + 1e-12 && sat.st.stats.satCount > 0 && sat.bands > 0 &&
      /饱和/.test(sat.status) && sat.st.yFinal <= 0.5 + 1e-6,
    JSON.stringify({ maxU: sat.st.stats.maxU, satCount: sat.st.stats.satCount, bands: sat.bands }));

    // 抗饱和规范验证组：kp=8 ki=4 kd=0 uMax=1.2 duration=30
    await setInput(p3, '#pidKp', 8);
    await setInput(p3, '#pidKi', 4);
    await setInput(p3, '#pidKd', 0);
    await setInput(p3, '#pidUMax', 1.2);
    await setInput(p3, '#pidUMin', -1.2);
    await p3.selectOption('#pidDuration', '30');
    await sleep(200);
    const awOn = await getState(p3);
    await p3.evaluate(() => {
      const el = document.getElementById('pidAntiWindup');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(200);
    const awOff = await getState(p3);
    check('R5.2 抗饱和对比（页内数值）：开启时超调显著更小',
      awOn.antiWindup === true && awOff.antiWindup === false &&
      awOn.metrics.overshoot < awOff.metrics.overshoot,
      awOn.metrics.overshoot.toFixed(2) + '% vs ' + awOff.metrics.overshoot.toFixed(2) + '%');
    check('R5.3 抗饱和限制积分幅值：maxI(on) < maxI(off)',
      awOn.stats.maxI < awOff.stats.maxI, awOn.stats.maxI.toFixed(3) + ' vs ' + awOff.stats.maxI.toFixed(3));
    await setInput(p3, '#pidUMin', 3);
    const badLimits = await p3.evaluate(() => ({
      err: document.getElementById('pidError').textContent,
      uMin: window.PidDemo.getState(document.getElementById('pidDemoRoot')).config.uMin,
      invalid: document.getElementById('pidUMin').getAttribute('aria-invalid')
    }));
    check('R5.4 uMin≥uMax 被拒绝：保持上一有效值并提示',
      /uMin/.test(badLimits.err) && badLimits.uMin === -1.2 && badLimits.invalid === 'true', badLimits.err);
    await s3.ctx.close();

    // ---------------------------------------------------------------- R6 非法输入与恢复默认
    const s4 = await newSession(browser, base);
    const p4 = s4.page;
    const preBad = await getState(p4);
    await setInput(p4, '#pidKp', 'abc');
    const badKp = await p4.evaluate(() => ({
      err: document.getElementById('pidError').textContent,
      st: window.PidDemo.getState(document.getElementById('pidDemoRoot')),
      invalid: document.getElementById('pidKp').getAttribute('aria-invalid')
    }));
    check('R6.1 非数字 Kp 被拒绝：config 不变、无 NaN、aria-invalid',
      /Kp/.test(badKp.err) && badKp.st.config.kp === preBad.config.kp &&
      badKp.invalid === 'true' && Number.isFinite(badKp.st.yFinal));
    await setInput(p4, '#pidTau', -1);
    const badTau = await getState(p4);
    check('R6.2 负 τ 被拒绝：config.tau 保持 1', badTau.config.tau === 1);
    await p4.click('#pidReset');
    await sleep(200);
    const reset = await p4.evaluate(() => {
      const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
      return {
        st,
        kp: document.getElementById('pidKp').value,
        tau: document.getElementById('pidTau').value,
        err: document.getElementById('pidError').textContent
      };
    });
    const D2 = await p4.evaluate(() => window.PidDemo.DEFAULTS);
    check('R6.3 恢复默认：全部参数回到 DEFAULTS、输入框同步、错误清空',
      Object.keys(D2).every(k => reset.st.config[k] === D2[k]) && reset.kp === '1.2' && reset.tau === '1' && reset.err === '');
    check('R6.4 全程无运行时异常', s4.errors.length === 0, s4.errors.slice(0, 2).join(' | ') || 'none');
    await s4.ctx.close();

    // ---------------------------------------------------------------- R7 有界计算
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    const burst = await p5.evaluate(() => {
      const root = document.getElementById('pidDemoRoot');
      const el = document.getElementById('pidKpRange');
      const c0 = window.PidDemo.getState(root).computeCount;
      for (let i = 1; i <= 30; i++) {
        el.value = String(i * 0.5);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const c1 = window.PidDemo.getState(root).computeCount;
      return { c0, c1, kp: window.PidDemo.getState(root).config.kp };
    });
    await sleep(300);
    const afterBurst = await getState(p5);
    check('R7.1 30 次快速滑杆输入：同步期间零重算（防抖），结束后恰好一次重算到末值',
      burst.c1 === burst.c0 && afterBurst.computeCount === burst.c0 + 1 && afterBurst.config.kp === 15,
    JSON.stringify(burst) + ' → ' + afterBurst.computeCount);
    await p5.selectOption('#pidDt', '0.005');
    await p5.selectOption('#pidDuration', '30');
    await sleep(300);
    const big = await getState(p5);
    check('R7.2 最细网格 dt=0.005×30s：n=6000 有界、指标有限、无异常',
      big.n === 6000 && Number.isFinite(big.yFinal) && s5.errors.length === 0, 'n=' + big.n);
    await s5.ctx.close();

    // ---------------------------------------------------------------- R8 未稳定如实显示
    const s6 = await newSession(browser, base);
    const p6 = s6.page;
    // 慢对象 τ=10 + 仿真时长 6s：响应远未进入 ±2% 带（持续振荡场景由数学专项 M10.5 覆盖）
    await setInput(p6, '#pidTau', 10);
    await p6.selectOption('#pidDuration', '6');
    await sleep(250);
    const unstable = await p6.evaluate(() => ({
      st: window.PidDemo.getState(document.getElementById('pidDemoRoot')),
      text: document.getElementById('pidSettling').textContent,
      status: document.getElementById('pidStatus').textContent
    }));
    check('R8.1 仿真时间内未稳定：显示「未在仿真时间内稳定」，settling=null，不编造数值',
      unstable.st.settled === false && unstable.st.metrics.settling === null &&
      /未在仿真时间内稳定/.test(unstable.text) && /未在仿真时间内稳定/.test(unstable.status), unstable.text);
    await s6.ctx.close();

    // ---------------------------------------------------------------- R9 390px 移动布局 + 触摸
    const s7 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p7 = s7.page;
    const mobile = await p7.evaluate(() => {
      const charts = document.querySelector('.pid-charts-card').getBoundingClientRect();
      const panel = document.querySelector('.pid-panel').getBoundingClientRect();
      const input = document.getElementById('pidKp').getBoundingClientRect();
      const btn = document.getElementById('pidModePI').getBoundingClientRect();
      const range = document.getElementById('pidKpRange').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        chartsW: charts.width,
        panelBelow: panel.top >= charts.bottom - 1,
        inputH: input.height, btnH: btn.height, rangeH: range.height
      };
    });
    check('R9.1 390px 无横向溢出、图表面板单列、触控高度 ≥40px',
      mobile.overflow && mobile.chartsW > 300 && mobile.panelBelow &&
      mobile.inputH >= 40 && mobile.btnH >= 40 && mobile.rangeH >= 40, JSON.stringify(mobile));
    // 实验互链增加后页面更长，先滚动到按钮再取坐标，避免点在视口外的旧坐标上
    await p7.locator('#pidModePI').scrollIntoViewIfNeeded();
    const btnBox = await p7.locator('#pidModePI').boundingBox();
    await p7.touchscreen.tap(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await sleep(200);
    const touchMode = await getState(p7);
    check('R9.2 触摸点按切换 PI 模式生效且无异常',
      touchMode.mode === 'PI' && s7.errors.length === 0, touchMode.mode);
    await s7.ctx.close();

    // ---------------------------------------------------------------- R10 深色主题
    const s8 = await newSession(browser, base);
    const p8 = s8.page;
    const lightStroke = await p8.evaluate(() => getComputedStyle(document.querySelector('#pidChartY .pid-curve--pid')).stroke);
    await p8.click('#themeToggle');
    await sleep(300);
    const dark = await p8.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('#pidChartY .pid-curve--pid')).stroke,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    check('R10.1 深色主题：曲线颜色随设计令牌切换且无溢出',
      dark.theme === 'dark' && dark.stroke !== lightStroke && dark.overflow, lightStroke + ' → ' + dark.stroke);
    const darkV = await verifyInPage(p8);
    check('R10.2 深色下数值正确性不受影响', darkV.yDelta < 1e-9 && s8.errors.length === 0);
    await s8.ctx.close();

    // ---------------------------------------------------------------- R11 键盘与无障碍
    const s9 = await newSession(browser, base);
    const p9 = s9.page;
    const kb0 = await getState(p9);
    await p9.locator('#pidKpRange').focus();
    await p9.keyboard.press('ArrowRight');
    await sleep(250);
    const kb1 = await getState(p9);
    check('R11.1 键盘操作滑杆：ArrowRight → Kp +0.05 并重算',
      Math.abs(kb1.config.kp - kb0.config.kp - 0.05) < 1e-9, kb0.config.kp + ' → ' + kb1.config.kp);
    await p9.locator('#pidModePI').focus();
    await p9.keyboard.press('Enter');
    await sleep(200);
    const kbMode = await getState(p9);
    check('R11.2 键盘 Enter 激活模式按钮', kbMode.mode === 'PI');
    const a11y = await p9.evaluate(() => {
      const cy = document.getElementById('pidChartY');
      const live = document.getElementById('pidLive');
      const lab = document.getElementById('pidKp').closest('label');
      return {
        role: cy.getAttribute('role'),
        ariaLabel: (cy.getAttribute('aria-label') || '').length > 5,
        live: live.getAttribute('aria-live') === 'polite' && live.textContent.length > 0,
        kpLabel: lab ? lab.textContent.trim() : '',
        group: !!document.querySelector('.pid-modes[role="group"][aria-labelledby]'),
        tableCaption: !!document.querySelector('.pid-compare-table caption')
      };
    });
    check('R11.3 无障碍：图表 role/aria-label、live region、输入标签、模式组标签',
      a11y.role === 'img' && a11y.ariaLabel && a11y.live && /Kp/.test(a11y.kpLabel) && a11y.group,
      JSON.stringify(a11y));
    check('R11.4 键盘操作全程无运行时异常', s9.errors.length === 0, s9.errors.slice(0, 2).join(' | ') || 'none');
    await s9.ctx.close();

    // ---------------------------------------------------------------- R12 离线
    const s10 = await newSession(browser, base, { sw: true });
    const p10 = s10.page;
    await p10.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p10.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p10.evaluate(() => { location.hash = '#/lab/pid-control'; });
    await waitPid(p10);
    const cached = await p10.evaluate(async () => {
      const a = await caches.match('/blog/js/pid-simulation.js');
      const b = await caches.match('/blog/js/pid-demo.js');
      return { math: !!a, ui: !!b };
    });
    check('R12.1 在线访问后两个 PID 脚本进入 SW 缓存', cached.math && cached.ui, JSON.stringify(cached));
    await sleep(500);
    await s10.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p10.reload({ waitUntil: 'load', timeout: 30000 });
      await waitPid(p10, 20000);
      await setInput(p10, '#pidKp', 2);
      const v = await verifyInPage(p10);
      offlineInfo = { kp: v.st.config.kp, yDelta: v.yDelta };
      offlineOk = v.st.config.kp === 2 && v.yDelta < 1e-9;
    } catch (e) { offlineOk = false; offlineInfo = String(e.message).split('\n')[0]; }
    check('R12.2 离线重载：页面可渲染、参数可改、独立重算一致', offlineOk, JSON.stringify(offlineInfo));
    await s10.ctx.setOffline(false);
    await s10.ctx.close();

    // ---------------------------------------------------------------- R13 脚本失败降级
    for (const block of ['pid-demo.js', 'pid-simulation.js']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      await ctx.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
        return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
      });
      await ctx.route('**/js/' + block + '*', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForSelector('.empty-state', { timeout: 20000 });
      const text = await page.evaluate(() => document.querySelector('.empty-state').textContent);
      check('R13 ' + block + ' 404：显示加载失败与重试入口，不白屏不抛错',
        /加载失败/.test(text) && /重试/.test(text) && errs.length === 0,
        text.replace(/\s+/g, ' ').slice(0, 50));
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
      const cards = await page.evaluate(() => document.querySelectorAll('#app .article-card').length);
      check('R13 ' + block + ' 失败不影响首页文章列表', cards > 5 && errs.length === 0, 'cards=' + cards);
      await ctx.close();
    }

    // ---------------------------------------------------------------- R14 快速路由切换
    const s11 = await newSession(browser, base);
    const p11 = s11.page;
    for (const h of ['#/', '#/lab/robot-2r', '#/lab/pid-control', '#/projects', '#/lab/pid-control']) {
      await p11.evaluate(hh => { location.hash = hh; }, h);
      await sleep(40);
    }
    await waitPid(p11);
    const fast = await p11.evaluate(() => ({
      roots: document.querySelectorAll('#pidDemoRoot').length,
      stages: document.querySelectorAll('#robotStage').length
    }));
    const fastV = await verifyInPage(p11);
    check('R14.1 快速切换 5 次路由：单实例、无串页、数值正确、无异常',
      fast.roots === 1 && fast.stages === 0 && fastV.yDelta < 1e-9 && s11.errors.length === 0,
      JSON.stringify(fast) + ' errors=' + s11.errors.length);
    await s11.ctx.close();

    // ---------------------------------------------------------------- R15 三引擎代表性场景
    for (const eng of [{ name: 'firefox', launcher: firefox }, { name: 'webkit', launcher: webkit }]) {
      let eb = null;
      try {
        eb = await eng.launcher.launch({ headless: true });
      } catch (e) {
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
        await waitPid(page);
        await page.click('#pidModeCompare');
        await sleep(300);
        const r = await page.evaluate(() => {
          const st = window.PidDemo.getState(document.getElementById('pidDemoRoot'));
          const cfg = Object.assign({}, st.config, { mode: 'PID' });
          const sim = window.PidSimulation.simulate(cfg);
          return {
            mode: st.mode,
            curves: document.querySelectorAll('#pidChartY .pid-curve').length,
            yDelta: Math.abs(sim.y[sim.y.length - 1] - st.compare.PID.yFinal),
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
          };
        });
        check('R15.1 ' + eng.name + ' 390px：渲染/对比模式/独立重算一致且无溢出',
          r.mode === 'compare' && r.curves === 3 && r.yDelta < 1e-9 && r.overflow, JSON.stringify(r));
        check('R15.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('R15.1 ' + eng.name + ' 390px：渲染/对比模式/独立重算一致且无溢出', false, String(e.message).split('\n')[0]);
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