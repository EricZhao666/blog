#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1C：真实浏览器下的 OEE 生产效率分析实验室验收
 *
 * 覆盖：入口与实验互链（三个实验深链接不破坏）、默认基准样例数值一致性（getState + 页内独立重算）、
 * 参数变更即时计算、示例切换、多穴输入、A/B 实际对比与假设投影、Performance>100% 与不一致数据提示、
 * 非法输入拒绝、恢复默认、防抖有界计算、390px 移动布局与触摸、深色主题、键盘与无障碍、
 * 离线、脚本失败降级、快速路由切换、Firefox/WebKit 代表性场景。
 *
 * 正确性判据全部是数值断言（独立硬编码期望：90%/88.888889%/95%/76%，损失 45/45/18/342 分钟），
 * 不凭图形是否绘制判断。
 *
 * 用法：node tests/browser/oee-analysis.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/oee-analysis';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) <= eps;

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
  await waitOee(page);
  return { ctx, page, errors };
}

async function waitOee(page, timeout) {
  await page.waitForSelector('#oeeValue', { state: 'visible', timeout: timeout || 30000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('oeeStatus');
    return !!s && s.textContent !== '–';
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => window.OeeDemo.getState(document.getElementById('oeeDemoRoot')));
}

// 页内独立重算：正确性判据是数值，不是图形
function verifyInPage(page) {
  return page.evaluate(() => {
    const st = window.OeeDemo.getState(document.getElementById('oeeDemoRoot'));
    const r = window.OeeCalculation.compute(st.config);
    return {
      st,
      oeeDelta: (r.oee === null || st.oee === null) ? (r.oee === st.oee ? 0 : 1) : Math.abs(r.oee - st.oee),
      lossDelta: Math.abs(r.losses.effectiveSec / 60 - st.lossesMin.effective),
      finite: [st.oee, st.availability, st.performance, st.quality].every(v => v === null || Number.isFinite(v))
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
        cards: ['oeeValue', 'oeeA', 'oeeP', 'oeeQ', 'oeeLossChart', 'oeeLossBody', 'oeeCompareWrap', 'oeeProjection']
          .every(id => !!document.getElementById(id)),
        labLinks: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
        currentHref: (() => {
          const el = document.querySelector('.lab-links a[aria-current="page"]');
          return el ? el.getAttribute('href') : null;
        })()
      };
    });
    check('R1.1 导航「实验」入口保持原 href、当前页激活、标题正确',
      entry.navHref === '#/lab/robot-2r' && entry.active && /OEE 工业生产效率与损失分析实验室/.test(entry.title),
      JSON.stringify({ href: entry.navHref, title: entry.title }));
    check('R1.2 总览/损失/情景要素渲染；实验互链含列表/2R/PID/OEE/SPC/卡尔曼/路径规划且当前页标注',
      entry.cards &&
      entry.labLinks.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis,#/lab/kalman-filter,#/lab/path-planning' &&
      entry.currentHref === '#/lab/oee-analysis');

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
    const robotOk = await p1.evaluate(() => ({
      oeeLink: !!document.querySelector('.lab-links a[href="#/lab/oee-analysis"]'),
      status: document.getElementById('robotStatus').textContent
    }));
    check('R1.4 2R 深链接不破坏：页面正常且互链提供 OEE 入口', robotOk.oeeLink && robotOk.status !== '–');
    await p1.evaluate(() => { location.hash = '#/lab/pid-control'; });
    await p1.waitForSelector('#pidChartY', { timeout: 20000 });
    const pidOk = await p1.evaluate(() => ({
      oeeLink: !!document.querySelector('.lab-links a[href="#/lab/oee-analysis"]'),
      status: document.getElementById('pidStatus').textContent
    }));
    check('R1.5 PID 深链接不破坏：页面正常且互链提供 OEE 入口', pidOk.oeeLink && pidOk.status !== '–');
    await p1.evaluate(() => { location.hash = '#/lab/oee-analysis'; });
    await waitOee(p1);

    // ---------------------------------------------------------------- R2 默认基准样例数值一致性
    const st0 = await getState(p1);
    check('R2.1 默认 = 基础验证样例：A=90%、P=88.888889%、Q=95%、OEE=76%（独立硬编码期望）',
      near(st0.availability, 0.9, 1e-12) && near(st0.performance, 8 / 9, 1e-12) &&
      near(st0.quality, 0.95, 1e-12) && near(st0.oee, 0.76, 1e-12),
      'OEE=' + st0.oee);
    check('R2.2 损失分解 45/45/18/342 分钟、守恒通过、交叉偏差 <1e-12',
      near(st0.lossesMin.downtime, 45, 1e-9) && near(st0.lossesMin.performance, 45, 1e-9) &&
      near(st0.lossesMin.quality, 18, 1e-9) && near(st0.lossesMin.effective, 342, 1e-9) &&
      st0.conservationOk && st0.crossDelta < 1e-12);
    const v0 = await verifyInPage(p1);
    check('R2.3 页内独立重算与 getState 一致（OEE/有效时间 <1e-9）',
      v0.oeeDelta < 1e-9 && v0.lossDelta < 1e-9 && v0.finite);
    const chart0 = await p1.evaluate(() => ({
      segs: document.querySelectorAll('#oeeLossChart .oee-seg').length,
      rows: document.querySelectorAll('#oeeLossBody tr').length,
      hidden: document.getElementById('oeeLossChart').hasAttribute('hidden'),
      valueText: document.getElementById('oeeValue').textContent,
      lossText: document.getElementById('oeeLossBody').textContent
    }));
    check('R2.4 堆叠图 4 段 + 数值表 4 行（图形不是唯一表达），OEE 显示 76.00%',
      chart0.segs === 4 && chart0.rows === 4 && !chart0.hidden &&
      chart0.valueText === '76.00%' && /342/.test(chart0.lossText), JSON.stringify(chart0));

    // ---------------------------------------------------------------- R3 参数变更即时计算
    await setInput(p1, '#oeeDowntime', 30);
    const afterDt = await getState(p1);
    check('R3.1 停机 45→30（产量不变）：A=93.3333%，OEE 仍 76%（时间公式，损失转移）',
      near(afterDt.availability, 14 / 15, 1e-12) && near(afterDt.oee, 0.76, 1e-12) &&
      near(afterDt.lossesMin.performance, 60, 1e-9), 'A=' + afterDt.availability);
    await setInput(p1, '#oeeTotal', 840);
    await setInput(p1, '#oeeGood', 798);
    const afterCount = await getState(p1);
    check('R3.2 总产量 840/合格 798：P=100%、OEE=88.6667%',
      near(afterCount.performance, 1, 1e-12) && near(afterCount.oee, (14 / 15) * 0.95, 1e-12),
      'OEE=' + afterCount.oee);
    await setInput(p1, '#oeeCavities', 4);
    await setInput(p1, '#oeeIdealCycle', 20);
    const afterCav = await getState(p1);
    check('R3.3 多穴输入：理想单件周期 = 20/4 = 5 秒（穴数只除一次）',
      near(afterCav.idealPartSec, 5, 1e-12) && afterCav.config.cavities === 4);
    await s1.ctx.close();

    // ---------------------------------------------------------------- R4 示例切换
    const s2 = await newSession(browser, base);
    const p2 = s2.page;
    await p2.selectOption('#oeeExample', 'multi');
    await sleep(200);
    const multi = await getState(p2);
    check('R4.1 多穴注塑示例：config 与 EXAMPLES 一致、OEE=71.09375%',
      multi.example === 'multi' && multi.config.cavities === 4 && multi.config.totalCount === 4200 &&
      near(multi.oee, 0.7109375, 1e-12), 'OEE=' + multi.oee);
    await p2.selectOption('#oeeExample', 'line');
    await sleep(200);
    const line = await getState(p2);
    check('R4.2 冲压/装配线示例：OEE=21384/25200≈84.857%',
      line.example === 'line' && near(line.oee, 21384 / 25200, 1e-12));
    await setInput(p2, '#oeeDowntime', 40);
    const custom = await getState(p2);
    check('R4.3 手动修改参数后示例标记为 custom', custom.example === 'custom' && custom.config.downtimeMin === 40);
    await s2.ctx.close();

    // ---------------------------------------------------------------- R5 A/B 对比与假设投影
    const s3 = await newSession(browser, base);
    const p3 = s3.page;
    await p3.click('#oeeSaveA');
    await sleep(150);
    const saved = await getState(p3);
    check('R5.1 保存基准 A：baselineA.config=默认、OEE 76%',
      saved.baselineA && near(saved.baselineA.oee, 0.76, 1e-12) && saved.baselineA.config.plannedMin === 450);
    await setInput(p3, '#oeeDowntime', 30);
    await setInput(p3, '#oeeTotal', 840);
    await setInput(p3, '#oeeGood', 798);
    const cmp = await p3.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      rows: document.querySelectorAll('#oeeCompareBody tr').length,
      visible: !document.getElementById('oeeCompareWrap').hidden,
      note: document.getElementById('oeeCompareNote').textContent
    }));
    check('R5.2 A/B 对比表 7 行：OEE +12.6667 百分点、合格 +114 件（实际输入对比）',
      cmp.visible && cmp.rows === 7 && near(cmp.st.compare.oeePP, 12.666666666, 1e-6) &&
      cmp.st.compare.goodDelta === 114 && /实际输入对比/.test(cmp.note),
      'ΔOEE=' + cmp.st.compare.oeePP);
    await setInput(p3, '#oeeProjDowntime', 15);
    const proj = await p3.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      text: document.getElementById('oeeProjection').textContent
    }));
    check('R5.3 假设投影（停机→15 分钟，P=1/Q=0.95 不变）：合格 826.5 件（+28.5），明确标注假设与非已验证收益',
      proj.st.projection && proj.st.projection.ok &&
      near(proj.st.projection.projected.goodCount, 826.5, 1e-9) &&
      near(proj.st.projection.deltaGood, 28.5, 1e-9) &&
      /假设预测/.test(proj.text) && /非已验证/.test(proj.text),
      'good=' + (proj.st.projection && proj.st.projection.projected.goodCount));
    await s3.ctx.close();

    // ---------------------------------------------------------------- R6 异常口径提示
    const s4 = await newSession(browser, base);
    const p4 = s4.page;
    await setInput(p4, '#oeeTotal', 900);
    await setInput(p4, '#oeeGood', 855);
    const over = await p4.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      hidden: document.getElementById('oeeLossChart').hasAttribute('hidden'),
      note: document.getElementById('oeeChartNote').textContent,
      warns: document.getElementById('oeeWarnings').textContent,
      status: document.getElementById('oeeStatus').textContent,
      pText: document.getElementById('oeeP').textContent
    }));
    check('R6.1 Performance>100%：如实显示 111.11%（不截断）、堆叠图隐藏、检查清单提示',
      near(over.st.performance, 10 / 9, 1e-12) && over.st.chartSafe === false && over.hidden &&
      /理想周期/.test(over.warns) && /单位/.test(over.warns) && /穴数/.test(over.warns) && /统计窗口/.test(over.warns) &&
      over.pText === '111.11%' && /口径异常/.test(over.status), over.pText);
    await setInput(p4, '#oeeDowntime', 450);
    const inc = await p4.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      value: document.getElementById('oeeValue').textContent,
      warns: document.getElementById('oeeWarnings').textContent
    }));
    check('R6.2 零运行时间却有产量：inconsistent-data、OEE 显示「不适用」、不编造数值',
      inc.st.flags.indexOf('inconsistent-data') !== -1 && inc.st.oee === null &&
      inc.value === '不适用' && /不一致/.test(inc.warns));
    await setInput(p4, '#oeeGood', 0);
    await setInput(p4, '#oeeTotal', 0);
    await setInput(p4, '#oeeDowntime', 0);
    await setInput(p4, '#oeePlanned', 0);
    const zero = await p4.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      aText: document.getElementById('oeeA').textContent,
      value: document.getElementById('oeeValue').textContent
    }));
    check('R6.3 计划时间为零：A/OEE 显示「不适用」，无 NaN/Infinity/虚构 100%',
      zero.st.availability === null && zero.st.oee === null &&
      zero.aText === '不适用' && zero.value === '不适用');
    check('R6.4 异常全程无运行时异常', s4.errors.length === 0, s4.errors.slice(0, 2).join(' | ') || 'none');
    await s4.ctx.close();

    // ---------------------------------------------------------------- R7 非法输入与恢复默认
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    const preBad = await getState(p5);
    await setInput(p5, '#oeeGood', 9999);
    const badGood = await p5.evaluate(() => ({
      err: document.getElementById('oeeError').textContent,
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      invalid: document.getElementById('oeeGood').getAttribute('aria-invalid')
    }));
    check('R7.1 合格>总量被拒绝：保持上一有效值并提示、aria-invalid',
      /合格/.test(badGood.err) && badGood.st.config.goodCount === preBad.config.goodCount &&
      badGood.invalid === 'true' && Number.isFinite(badGood.st.oee));
    await setInput(p5, '#oeeTotal', 1.5);
    const badInt = await getState(p5);
    check('R7.2 非整数产量被拒绝：totalCount 保持 720', badInt.config.totalCount === 720);
    await setInput(p5, '#oeeDowntime', -5);
    const badNeg = await getState(p5);
    check('R7.3 负停机被拒绝：downtimeMin 保持 45', badNeg.config.downtimeMin === 45);
    await p5.click('#oeeReset');
    await sleep(200);
    const reset = await p5.evaluate(() => ({
      st: window.OeeDemo.getState(document.getElementById('oeeDemoRoot')),
      planned: document.getElementById('oeePlanned').value,
      err: document.getElementById('oeeError').textContent,
      aState: document.getElementById('oeeAState').textContent
    }));
    check('R7.4 恢复默认：参数回到基准样例、输入框同步、错误清空、基准 A 清除',
      near(reset.st.oee, 0.76, 1e-12) && reset.planned === '450' && reset.err === '' &&
      reset.st.baselineA === null && /未保存/.test(reset.aState));
    await s5.ctx.close();

    // ---------------------------------------------------------------- R8 防抖有界计算
    const s6 = await newSession(browser, base);
    const p6 = s6.page;
    const burst = await p6.evaluate(() => {
      const root = document.getElementById('oeeDemoRoot');
      const el = document.getElementById('oeeDowntime');
      const c0 = window.OeeDemo.getState(root).computeCount;
      for (let i = 1; i <= 30; i++) {
        el.value = String(i);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const c1 = window.OeeDemo.getState(root).computeCount;
      return { c0, c1 };
    });
    await sleep(300);
    const afterBurst = await getState(p6);
    check('R8.1 30 次快速输入：同步期间零重算（防抖），结束后恰好一次重算到末值',
      burst.c1 === burst.c0 && afterBurst.computeCount === burst.c0 + 1 && afterBurst.config.downtimeMin === 30,
      JSON.stringify(burst) + ' → ' + afterBurst.computeCount);
    check('R8.2 快速输入全程无运行时异常', s6.errors.length === 0, s6.errors.slice(0, 2).join(' | ') || 'none');
    await s6.ctx.close();

    // ---------------------------------------------------------------- R9 390px 移动布局 + 触摸
    const s7 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p7 = s7.page;
    const mobile = await p7.evaluate(() => {
      const main = document.querySelector('.oee-main').getBoundingClientRect();
      const panel = document.querySelector('.oee-panel').getBoundingClientRect();
      const input = document.getElementById('oeePlanned').getBoundingClientRect();
      const btn = document.getElementById('oeeSaveA').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        mainW: main.width,
        panelBelow: panel.top >= main.bottom - 1,
        inputH: input.height, btnH: btn.height
      };
    });
    check('R9.1 390px 无横向溢出、主区/面板单列、触控高度 ≥40px',
      mobile.overflow && mobile.mainW > 300 && mobile.panelBelow &&
      mobile.inputH >= 40 && mobile.btnH >= 40, JSON.stringify(mobile));
    await p7.locator('#oeeSaveA').scrollIntoViewIfNeeded();
    const btnBox = await p7.locator('#oeeSaveA').boundingBox();
    await p7.touchscreen.tap(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await sleep(200);
    const touchA = await getState(p7);
    check('R9.2 触摸点按「保存基准 A」生效且无异常',
      touchA.baselineA !== null && s7.errors.length === 0);
    await s7.ctx.close();

    // ---------------------------------------------------------------- R10 深色主题
    const s8 = await newSession(browser, base);
    const p8 = s8.page;
    const lightFill = await p8.evaluate(() => getComputedStyle(document.querySelector('#oeeLossChart .oee-seg--effective')).fill);
    await p8.click('#themeToggle');
    await sleep(300);
    const dark = await p8.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      fill: getComputedStyle(document.querySelector('#oeeLossChart .oee-seg--effective')).fill,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    check('R10.1 深色主题：损失图颜色随设计令牌切换且无溢出',
      dark.theme === 'dark' && dark.fill !== lightFill && dark.overflow, lightFill + ' → ' + dark.fill);
    const darkV = await verifyInPage(p8);
    check('R10.2 深色下数值正确性不受影响', darkV.oeeDelta < 1e-9 && s8.errors.length === 0);
    await s8.ctx.close();

    // ---------------------------------------------------------------- R11 键盘与无障碍
    const s9 = await newSession(browser, base);
    const p9 = s9.page;
    const kb0 = await getState(p9);
    await p9.locator('#oeePlanned').focus();
    await p9.keyboard.press('ArrowUp');
    await sleep(250);
    const kb1 = await getState(p9);
    check('R11.1 键盘操作数字输入：ArrowUp → 计划时间 +1 并重算',
      kb1.config.plannedMin === kb0.config.plannedMin + 1 && kb1.computeCount > kb0.computeCount,
      kb0.config.plannedMin + ' → ' + kb1.config.plannedMin);
    await p9.locator('#oeeSaveA').focus();
    await p9.keyboard.press('Enter');
    await sleep(200);
    const kbA = await getState(p9);
    check('R11.2 键盘 Enter 激活「保存基准 A」', kbA.baselineA !== null);
    const a11y = await p9.evaluate(() => {
      const chart = document.getElementById('oeeLossChart');
      const live = document.getElementById('oeeLive');
      const lab = document.querySelector('label[for="oeePlanned"]');
      return {
        role: chart.getAttribute('role'),
        ariaLabel: (chart.getAttribute('aria-label') || '').length > 5,
        live: live.getAttribute('aria-live') === 'polite' && live.textContent.length > 0,
        label: lab ? lab.textContent.trim() : '',
        caption: !!document.querySelector('.oee-loss-table caption') && !!document.querySelector('.oee-compare-table caption'),
        warnLive: document.getElementById('oeeWarnings').getAttribute('aria-live') === 'polite'
      };
    });
    check('R11.3 无障碍：图表 role/aria-label、live region、输入标签、表格 caption、异常提示 aria-live',
      a11y.role === 'img' && a11y.ariaLabel && a11y.live && /计划生产时间/.test(a11y.label) && a11y.caption && a11y.warnLive,
      JSON.stringify(a11y));
    check('R11.4 键盘操作全程无运行时异常', s9.errors.length === 0, s9.errors.slice(0, 2).join(' | ') || 'none');
    await s9.ctx.close();

    // ---------------------------------------------------------------- R12 离线
    const s10 = await newSession(browser, base, { sw: true });
    const p10 = s10.page;
    await p10.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p10.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p10.evaluate(() => { location.hash = '#/lab/oee-analysis'; });
    await waitOee(p10);
    const cached = await p10.evaluate(async () => {
      const a = await caches.match('/blog/js/oee-calculation.js');
      const b = await caches.match('/blog/js/oee-demo.js');
      return { math: !!a, ui: !!b };
    });
    check('R12.1 在线访问后两个 OEE 脚本进入 SW 缓存（OPTIONAL 预热）', cached.math && cached.ui, JSON.stringify(cached));
    await sleep(500);
    await s10.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p10.reload({ waitUntil: 'load', timeout: 30000 });
      await waitOee(p10, 20000);
      await setInput(p10, '#oeeDowntime', 30);
      const v = await verifyInPage(p10);
      offlineInfo = { downtime: v.st.config.downtimeMin, oeeDelta: v.oeeDelta, oee: v.st.oee };
      offlineOk = v.st.config.downtimeMin === 30 && v.oeeDelta < 1e-9 && near(v.st.oee, 0.76, 1e-12);
    } catch (e) { offlineOk = false; offlineInfo = String(e.message).split('\n')[0]; }
    check('R12.2 离线重载：页面可渲染、参数可改、独立重算一致（OEE 仍 76%）', offlineOk, JSON.stringify(offlineInfo));
    await s10.ctx.setOffline(false);
    await s10.ctx.close();

    // ---------------------------------------------------------------- R13 脚本失败降级
    for (const block of ['oee-demo.js', 'oee-calculation.js']) {
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
    for (const h of ['#/', '#/lab/robot-2r', '#/lab/oee-analysis', '#/lab/pid-control', '#/lab/oee-analysis']) {
      await p11.evaluate(hh => { location.hash = hh; }, h);
      await sleep(40);
    }
    await waitOee(p11);
    const fast = await p11.evaluate(() => ({
      roots: document.querySelectorAll('#oeeDemoRoot').length,
      stages: document.querySelectorAll('#robotStage').length,
      pidCharts: document.querySelectorAll('#pidChartY').length
    }));
    const fastV = await verifyInPage(p11);
    check('R14.1 快速切换 5 次路由：单实例、无串页、数值正确、无异常',
      fast.roots === 1 && fast.stages === 0 && fast.pidCharts === 0 && fastV.oeeDelta < 1e-9 && s11.errors.length === 0,
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
        await waitOee(page);
        await page.selectOption('#oeeExample', 'multi');
        await sleep(300);
        const r = await page.evaluate(() => {
          const st = window.OeeDemo.getState(document.getElementById('oeeDemoRoot'));
          const calc = window.OeeCalculation.compute(st.config);
          return {
            example: st.example,
            oee: st.oee,
            oeeDelta: Math.abs(calc.oee - st.oee),
            segs: document.querySelectorAll('#oeeLossChart .oee-seg').length,
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
          };
        });
        check('R15.1 ' + eng.name + ' 390px：渲染/多穴示例/独立重算一致且无溢出',
          r.example === 'multi' && near(r.oee, 0.7109375, 1e-12) && r.oeeDelta < 1e-9 && r.segs === 4 && r.overflow,
          JSON.stringify(r));
        check('R15.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('R15.1 ' + eng.name + ' 390px：渲染/多穴示例/独立重算一致且无溢出', false, String(e.message).split('\n')[0]);
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