#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-2A：真实浏览器下的 SPC 统计过程控制与过程能力实验室验收
 *
 * 覆盖：入口与实验互链（2R / PID / OEE 深链接不破坏）、默认示例数值一致性
 * （getState + 页内独立重算）、粘贴自定义数据、非法数据定位与不继续计算、
 * 示例切换、规格修改、冻结基线（建立/固定界限/监测段/清除）、异常位置列表、
 * 防抖有界计算、390px / 768px / 1440px 布局、深色主题、键盘与无障碍、
 * 离线、脚本失败降级、快速路由切换、Firefox/WebKit 代表性场景。
 *
 * 正确性判据全部是数值断言（示例①：Cp 2.582538 / Cpk 2.556712，独立核算），
 * 不凭图形是否绘制判断。
 *
 * 用法：node tests/browser/spc-analysis.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/spc-analysis';

// 与 tests/test61_spc_math.js 相同的独立硬编码期望（Python 标准库独立核算）
const BASE_TEXT = '10.0, 10.2, 9.8, 10.1, 9.9, 10.3, 9.7, 10.0';
const BASE_SPEC = { lsl: 9.5, usl: 10.5 };
const BASE_EXPECT = { cp: 0.5483333333333337, cpk: 0.5483333333333337, pp: 0.8333333333333334 };

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
  await waitSpc(page);
  return { ctx, page, errors };
}

async function waitSpc(page, timeout) {
  await page.waitForSelector('#spcStatsBody dt', { state: 'visible', timeout: timeout || 30000 });
  await page.waitForFunction(() => {
    const s = window.SpcDemo && window.SpcDemo.getState(document.getElementById('spcDemoRoot'));
    return !!s && s.computeCount > 0;
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => window.SpcDemo.getState(document.getElementById('spcDemoRoot')));
}

/** 页内独立重算：正确性判据是数值，不是图形。 */
function verifyInPage(page) {
  return page.evaluate(() => {
    const st = window.SpcDemo.getState(document.getElementById('spcDemoRoot'));
    const mod = window.SpcCalculation;
    if (st.mode === 'theoretical') {
      const r = mod.computeTheoretical({ mean: st.mean, sd: st.s, lsl: st.spec.lsl, usl: st.spec.usl });
      return {
        st,
        cpDelta: Math.abs(r.capability.cp - st.cp),
        cpkDelta: Math.abs(r.capability.cpk - st.cpk),
        finite: [st.cp, st.cpk, st.pp, st.ppk].every(v => v === null || Number.isFinite(v))
      };
    }
    const parsed = mod.parseMeasurements(document.getElementById('spcData').value);
    const r = mod.computeMeasured({
      values: parsed.values,
      spec: { lsl: st.spec.lsl, usl: st.spec.usl, target: st.spec.target, unit: st.spec.unit },
      baseline: st.baseline ? { start: st.baseline.start, end: st.baseline.end } : null
    });
    return {
      st,
      cpDelta: Math.abs(r.capability.cp - st.cp),
      cpkDelta: Math.abs(r.capability.cpk - st.cpk),
      sampleDelta: r.n - st.sampleCount,
      finite: [st.cp, st.cpk, st.pp, st.ppk, st.mean, st.s, st.sigmaWithin]
        .every(v => v === null || Number.isFinite(v))
    };
  });
}

/**
 * 写入数据并等待**本次**输入对应的结果。
 * 不能只等 `s.error`：上一条非法输入留下的错误会让等待提前返回，读到旧状态。
 */
async function setData(page, text, opts) {
  const o = opts || {};
  const before = await page.evaluate(() =>
    window.SpcDemo.getState(document.getElementById('spcDemoRoot')).computeCount);
  await page.evaluate(t => {
    const el = document.getElementById('spcData');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  if (o.expectError) {
    await page.waitForFunction(b => {
      const s = window.SpcDemo.getState(document.getElementById('spcDemoRoot'));
      return s && s.computeCount === b && !!s.error;
    }, before, { timeout: 15000 });
  } else {
    await page.waitForFunction(b => {
      const s = window.SpcDemo.getState(document.getElementById('spcDemoRoot'));
      return s && s.computeCount > b && !s.error;
    }, before, { timeout: 15000 });
  }
  await sleep(60);
}

async function setValue(page, sel, value) {
  await page.evaluate(([q, v]) => {
    const el = document.querySelector(q);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [sel, String(value)]);
  await sleep(160);
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
      const ids = ['spcData', 'spcChartI', 'spcChartMR', 'spcChartHist', 'spcCapBody',
        'spcViolList', 'spcBaselineStart', 'spcFreeze', 'spcClearBaseline', 'spcModeTheory'];
      return {
        navHref: link && link.getAttribute('href'),
        active: !!link && link.classList.contains('active'),
        title: document.title,
        allCards: ids.every(id => !!document.getElementById(id)),
        labLinks: Array.from(document.querySelectorAll('.lab-links a')).map(a => a.getAttribute('href')),
        current: (() => {
          const el = document.querySelector('.lab-links a[aria-current="page"]');
          return el ? el.getAttribute('href') : null;
        })()
      };
    });
    check('R1.1 导航「实验」保持原 href（#/lab/robot-2r）并激活，标题正确',
      entry.navHref === '#/lab/robot-2r' && entry.active && /SPC 统计过程控制与过程能力实验室/.test(entry.title),
      JSON.stringify({ href: entry.navHref, title: entry.title }));
    check('R1.2 数据输入/三图/能力/异常/基线控件齐全，互链 5 项且当前页标注',
      entry.allCards &&
      entry.labLinks.join(',') === '#/lab,#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis' &&
      entry.current === '#/lab/spc-analysis');

    await p1.evaluate(() => { location.hash = '#/lab'; });
    await p1.waitForSelector('.lab-hub', { timeout: 20000 });
    const hub = await p1.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('.lab-hub-card')).map(a => a.getAttribute('href')),
      title: document.title
    }));
    check('R1.3 #/lab 实验列表四张卡片：2R / PID / OEE / SPC 均可深链',
      hub.cards.join(',') === '#/lab/robot-2r,#/lab/pid-control,#/lab/oee-analysis,#/lab/spc-analysis' &&
      /实验室/.test(hub.title), JSON.stringify(hub));

    await p1.evaluate(() => { location.hash = '#/lab/robot-2r'; });
    await p1.waitForSelector('#robotStage', { timeout: 20000 });
    const robotOk = await p1.evaluate(() => ({
      spcLink: !!document.querySelector('.lab-links a[href="#/lab/spc-analysis"]'),
      status: document.getElementById('robotStatus').textContent
    }));
    check('R1.4 2R 深链接不破坏，且互链提供 SPC 入口', robotOk.spcLink && robotOk.status !== '–');

    await p1.evaluate(() => { location.hash = '#/lab/pid-control'; });
    await p1.waitForSelector('#pidChartY', { timeout: 20000 });
    const pidOk = await p1.evaluate(() => ({
      spcLink: !!document.querySelector('.lab-links a[href="#/lab/spc-analysis"]'),
      status: document.getElementById('pidStatus').textContent
    }));
    check('R1.5 PID 深链接不破坏，且互链提供 SPC 入口', pidOk.spcLink && pidOk.status !== '–');

    await p1.evaluate(() => { location.hash = '#/lab/oee-analysis'; });
    await p1.waitForSelector('#oeeValue', { timeout: 20000 });
    const oeeOk = await p1.evaluate(() => ({
      spcLink: !!document.querySelector('.lab-links a[href="#/lab/spc-analysis"]'),
      oee: document.getElementById('oeeValue').textContent
    }));
    check('R1.6 OEE 深链接不破坏（仍为 76.00%），且互链提供 SPC 入口',
      oeeOk.spcLink && oeeOk.oee === '76.00%', oeeOk.oee);

    await p1.evaluate(() => { location.hash = '#/lab/spc-analysis'; });
    await waitSpc(p1);

    // ---------------------------------------------------------------- R2 默认示例数值
    const st0 = await getState(p1);
    check('R2.1 默认示例①（60 个合成样本）：n=60、均值 10.001、s 0.013138',
      st0.sampleCount === 60 && near(st0.mean, 10.001, 1e-9) && near(st0.s, 0.013138119, 1e-9),
      JSON.stringify({ n: st0.sampleCount, mean: st0.mean, s: st0.s }));
    check('R2.2 Cp 2.582538 / Cpk 2.556712 / Pp 2.537147 / Ppk 2.511775（独立核算）',
      near(st0.cp, 2.582537835, 1e-8) && near(st0.cpk, 2.556712456, 1e-8) &&
      near(st0.pp, 2.537146563, 1e-8) && near(st0.ppk, 2.511775097, 1e-8),
      'Cp=' + st0.cp + ' Cpk=' + st0.cpk);
    check('R2.3 默认示例无任何规则命中、无超规（0/60），控制图已建立',
      Object.values(st0.violationCounts).every(v => v === 0) &&
      st0.outOfSpecCount === 0 && st0.limits.i.ucl > st0.limits.i.cl,
      JSON.stringify(st0.violationCounts));
    const v0 = await verifyInPage(p1);
    check('R2.4 页内独立重算与 getState 一致（Cp/Cpk 偏差 <1e-12），指标全部有限',
      v0.cpDelta < 1e-12 && v0.cpkDelta < 1e-12 && v0.sampleDelta === 0 && v0.finite);

    const charts0 = await p1.evaluate(() => ({
      iSeries: !!document.querySelector('#spcChartI .spc-series'),
      mrSeries: !!document.querySelector('#spcChartMR .spc-series'),
      bars: document.querySelectorAll('#spcChartHist .spc-bar').length,
      specLines: document.querySelectorAll('#spcChartI .spc-line--spec').length,
      limitLines: document.querySelectorAll('#spcChartI .spc-line--limit').length,
      clLines: document.querySelectorAll('#spcChartI .spc-line--cl').length,
      capRows: document.querySelectorAll('#spcCapBody tr').length,
      legend: document.getElementById('spcLegendI').textContent,
      limitRows: document.querySelectorAll('tbody.spc-limit-body[data-chart="i"] tr').length
    }));
    check('R2.5 I 图同时绘制控制界限（2 条）、规格界限（2 条）与中心线（1 条），语义可区分',
      charts0.iSeries && charts0.limitLines === 2 && charts0.specLines === 2 && charts0.clLines === 1,
      JSON.stringify({ limit: charts0.limitLines, spec: charts0.specLines, cl: charts0.clLines }));
    check('R2.6 MR 图与直方图已绘制，能力表 6 行，I 图界限数值表 5 行，图例区分统计/规格',
      charts0.mrSeries && charts0.bars >= 5 && charts0.capRows === 6 && charts0.limitRows === 5 &&
      /控制界限/.test(charts0.legend) && /规格界限/.test(charts0.legend),
      JSON.stringify({ bars: charts0.bars, cap: charts0.capRows }));

    // ---------------------------------------------------------------- R3 粘贴数据与校验
    await setData(p1, BASE_TEXT);
    const pasted = await getState(p1);
    check('R3.1 粘贴 8 个自定义值：n=8，均值 10，s=0.2（与硬编码期望一致）',
      pasted.sampleCount === 8 && near(pasted.mean, 10, 1e-12) && near(pasted.s, 0.2, 1e-12),
      JSON.stringify({ n: pasted.sampleCount, mean: pasted.mean, s: pasted.s }));
    check('R3.2 自定义数据未自动套用示例规格前，Cp 由当前 LSL/USL 计算且有限',
      Number.isFinite(pasted.cp) && Number.isFinite(pasted.cpk),
      'Cp=' + pasted.cp);

    await setValue(p1, '#spcLsl', 9.5);
    await setValue(p1, '#spcUsl', 10.5);
    const specApplied = await getState(p1);
    check('R3.3 规格改为 9.5/10.5：Cp = Cpk = 0.548333（独立硬编码），Pp=Ppk=0.833333',
      near(specApplied.cp, BASE_EXPECT.cp, 1e-12) &&
      near(specApplied.cpk, BASE_EXPECT.cpk, 1e-12) &&
      near(specApplied.pp, BASE_EXPECT.pp, 1e-12) &&
      near(specApplied.ppk, BASE_EXPECT.pp, 1e-12),
      'Cp=' + specApplied.cp);
    const v1 = await verifyInPage(p1);
    check('R3.4 页内独立重算与页面一致（自定义数据 + 自定义规格）',
      v1.cpDelta < 1e-12 && v1.cpkDelta < 1e-12 && v1.sampleDelta === 0);

    await setData(p1, '10.0\n10.2\nabc\n10.1', { expectError: true });
    const bad = await p1.evaluate(() => ({
      err: document.getElementById('spcError').textContent,
      st: window.SpcDemo.getState(document.getElementById('spcDemoRoot')),
      hasUcl: document.querySelectorAll('#spcChartI .spc-line--limit').length,
      statsText: document.getElementById('spcStatsBody').textContent,
      warningsEmpty: document.getElementById('spcWarnings').textContent.trim() === ''
    }));
    check('R3.5 非法数据指出「第 3 行第 1 个」，不静默删除后继续计算',
      /第 3 行第 1 个/.test(bad.err) && /abc/.test(bad.err) && bad.st.parseError === 'invalid-number');
    check('R3.6 解析失败时结果被清空（无控制界限、指标显示未计算），不用旧结果冒充新输入',
      bad.hasUcl === 0 && bad.st.sampleCount === 0 && bad.st.cp === null &&
      /未进行任何计算|未完成/.test(bad.statsText), bad.statsText.slice(0, 40));

    await setData(p1, '10,10,10,10');
    const dup = await getState(p1);
    check('R3.7 重复值保留为独立样本（4 个相同值）：s=0、σ_within=0，Cp 不返回 Infinity',
      dup.sampleCount === 4 && dup.duplicateCount === 3 && dup.s === 0 &&
      dup.cp === null && dup.capStatus.cp === 'zero-within-variation',
      JSON.stringify({ n: dup.sampleCount, dup: dup.duplicateCount, s: dup.s, cp: dup.cp }));
    const zeroText = await p1.evaluate(() => document.getElementById('spcCapBody').textContent);
    check('R3.8 零波动文案说明「未观测到波动」而不是宣称能力无限好',
      /未观测到波动|不适用/.test(zeroText) && !/无限|∞|Infinity/.test(zeroText));

    await setData(p1, '10\n10');
    const two = await getState(p1);
    check('R3.9 仅 2 个样本：界限可估计但明确提示样本过少，不宣称稳定',
      two.sampleCount === 2 && Number.isFinite(two.sigmaWithin) &&
      /样本量仅 2 个/.test(await p1.evaluate(() => document.getElementById('spcWarnings').textContent)));

    // ---------------------------------------------------------------- R4 示例切换
    const s2 = await newSession(browser, base);
    const p2 = s2.page;
    await p2.selectOption('#spcExample', 'shifted');
    await sleep(300);
    const shifted = await getState(p2);
    check('R4.1 示例②：Cp 2.240808 但 Cpk 0.847025（高 Cp 掩盖不了不居中）',
      near(shifted.cp, 2.240808081, 1e-8) && near(shifted.cpk, 0.847025455, 1e-8) &&
      shifted.cpk < shifted.cp * 0.5,
      'Cp=' + shifted.cp + ' Cpk=' + shifted.cpk);
    await p2.selectOption('#spcExample', 'drift');
    await sleep(300);
    const drift = await getState(p2);
    check('R4.2 示例③持续漂移：Cpk 2.505651 仍很高，但命中 3 点越界 + 39 点同侧 + 6 点趋势',
      near(drift.cpk, 2.505650670, 1e-8) &&
      drift.violationCounts['i-beyond-limits'] === 3 &&
      drift.violationCounts['i-run-same-side'] === 39 &&
      drift.violationCounts['i-trend'] === 6,
      JSON.stringify(drift.violationCounts));
    check('R4.3 示例③无超规样本：规格内仍失控（教学要点在页面上成立）',
      drift.outOfSpecCount === 0 && drift.violationCounts['mr-beyond-limits'] === 2);
    await p2.selectOption('#spcExample', 'spike');
    await sleep(300);
    const spike = await getState(p2);
    const spikeWhere = await p2.evaluate(() =>
      document.querySelector('.spc-violation--hit .spc-violation-where').textContent);
    check('R4.4 示例④突发异常：超规 3 个（第 31–33 个），异常列表给出具体位置',
      spike.outOfSpecCount === 3 &&
      spike.outOfSpecCount === spike.violationCounts['i-beyond-limits'] &&
      /第 31 个/.test(spikeWhere) && /第 33 个/.test(spikeWhere),
      spikeWhere.slice(0, 60));
    await setData(p2, BASE_TEXT);
    check('R4.5 手动编辑数据后示例下拉变为「自定义数据」',
      (await p2.evaluate(() => document.getElementById('spcExample').value)) === 'custom');

    // ---------------------------------------------------------------- R5 理论参数模式
    const s3 = await newSession(browser, base);
    const p3 = s3.page;
    await p3.evaluate(() => {
      const el = document.getElementById('spcModeTheory');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(250);
    const th = await getState(p3);
    check('R5.1 理论模式：Cp = Cpk = 1.666667（用输入的 μ/σ），Pp/Ppk 明确不适用',
      th.mode === 'theoretical' && near(th.cp, 1.6666666666666667, 1e-12) &&
      near(th.cpk, 1.6666666666666667, 1e-12) && th.pp === null &&
      th.capStatus.pp === 'not-applicable-theoretical',
      'Cp=' + th.cp + ' Pp=' + th.pp);
    const thView = await p3.evaluate(() => ({
      iHidden: document.getElementById('spcICard').hidden,
      mrHidden: document.getElementById('spcMrCard').hidden,
      violHidden: document.getElementById('spcViolCard').hidden,
      baselineHidden: document.getElementById('spcBaselineField').hidden,
      measuredHidden: document.getElementById('spcMeasuredFields').hidden,
      note: document.getElementById('spcNoteHist').textContent,
      facts: document.getElementById('spcDistFacts').textContent
    }));
    check('R5.2 理论模式隐藏控制图/异常/基线输入，并明确「没有样本、不做控制图」',
      thView.iHidden && thView.mrHidden && thView.violHidden &&
      thView.baselineHidden && thView.measuredHidden &&
      /没有样本|理论参数模式/.test(thView.note) &&
      /理论不良率/.test(thView.facts), thView.note.slice(0, 40));
    check('R5.3 理论 PPM = 0.573303（2×Φ(−5)×1e6 的模型估计），与实测不良率分开显示',
      near(th.ppmTheoreticalTotal, 0.5733031437583891, 1e-4),
      String(th.ppmTheoreticalTotal));

    await setValue(p3, '#spcMean', 10.06);
    const shiftedTheory = await getState(p3);
    check('R5.4 理论均值偏到 10.06：Cpu 0.666667、Cpk 0.666667（规格上限方向受限）',
      near(shiftedTheory.cpu, (10.1 - 10.06) / (3 * 0.02), 1e-12) &&
      near(shiftedTheory.cpk, 0.6666666666666666, 1e-12),
      'Cpk=' + shiftedTheory.cpk);

    await setValue(p3, '#spcSd', 0);
    const zeroSd = await p3.evaluate(() => ({
      st: window.SpcDemo.getState(document.getElementById('spcDemoRoot')),
      err: document.getElementById('spcError').textContent
    }));
    check('R5.5 σ=0 被拒绝并给出原因，不返回 Infinity 能力',
      /大于 0/.test(zeroSd.err) && zeroSd.st.cp === null, zeroSd.err.slice(0, 40));
    await s3.ctx.close();

    // ---------------------------------------------------------------- R6 冻结基线
    const s4 = await newSession(browser, base);
    const p4 = s4.page;
    await p4.selectOption('#spcExample', 'drift');
    await sleep(300);
    const beforeFreeze = await getState(p4);
    await setValue(p4, '#spcBaselineStart', 1);
    await setValue(p4, '#spcBaselineEnd', 20);
    await p4.click('#spcFreeze');
    await sleep(300);
    const frozen = await getState(p4);
    check('R6.1 冻结基线（第 1–20 个）：limitsFrozen=true，CL 等于基线段均值',
      frozen.limitsFrozen === true && frozen.limitsBasis === 'baseline' &&
      frozen.baseline.count === 20 && frozen.baseline.mean === frozen.limits.i.cl,
      'CL=' + frozen.limits.i.cl);
    check('R6.2 冻结后控制界限不再随全部样本漂移（与冻结前 CL 明显不同）',
      Math.abs(frozen.limits.i.cl - beforeFreeze.limits.i.cl) > 1e-6,
      beforeFreeze.limits.i.cl + ' → ' + frozen.limits.i.cl);
    check('R6.3 监测段（第 21–60 个）按固定界限检测：越界与连续同侧信号保留',
      frozen.monitoring.count === 40 && frozen.monitoring.start === 21 &&
      frozen.violationCounts['i-beyond-limits'] > 0,
      JSON.stringify(frozen.violationCounts));
    const baselineUi = await p4.evaluate(() => ({
      state: document.getElementById('spcBaselineState').textContent,
      band: document.querySelectorAll('#spcChartI .spc-band').length,
      capNote: document.getElementById('spcCapNote').textContent
    }));
    check('R6.4 界面显示基准段与监测段，能力指数注明基于冻结基线段',
      /已冻结基线/.test(baselineUi.state) && /第 21 个样本起|监测段/.test(baselineUi.capNote) &&
      baselineUi.band === 1, baselineUi.capNote.slice(0, 50));

    await p4.click('#spcClearBaseline');
    await sleep(300);
    const cleared = await getState(p4);
    check('R6.5 清除基准：界限回到全部样本估计，状态文案恢复',
      cleared.limitsFrozen === false && cleared.baseline === null &&
      /未建立基准/.test(await p4.evaluate(() => document.getElementById('spcBaselineState').textContent)));

    await setValue(p4, '#spcBaselineEnd', 1);
    await p4.click('#spcFreeze');
    await sleep(200);
    const badBaseline = await p4.evaluate(() => ({
      err: document.getElementById('spcError').textContent,
      st: window.SpcDemo.getState(document.getElementById('spcDemoRoot'))
    }));
    check('R6.6 基线只有 1 个样本时拒绝建立并说明原因（不给出虚假界限）',
      /至少需要 2 个样本/.test(badBaseline.err) && badBaseline.st.baseline === null,
      badBaseline.err.slice(0, 40));
    await s4.ctx.close();

    // ---------------------------------------------------------------- R7 防抖
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    const burst = await p5.evaluate(() => {
      const root = document.getElementById('spcDemoRoot');
      const el = document.getElementById('spcData');
      const c0 = window.SpcDemo.getState(root).computeCount;
      const lines = [];
      for (let i = 0; i < 40; i++) lines.push((10 + (i % 7) * 0.01).toFixed(3));
      el.value = lines.join('\n');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const c1 = window.SpcDemo.getState(root).computeCount;
      return { c0, c1 };
    });
    await sleep(400);
    const afterBurst = await getState(p5);
    check('R7.1 一次粘贴 40 个值：同步期间不重算，防抖后恰好计算一次',
      burst.c1 === burst.c0 && afterBurst.computeCount === burst.c0 + 1 &&
      afterBurst.sampleCount === 40,
      JSON.stringify(burst) + ' → ' + afterBurst.computeCount + '/' + afterBurst.sampleCount);
    check('R7.2 大段粘贴全程无运行时异常', s5.errors.length === 0, s5.errors.slice(0, 2).join(' | ') || 'none');
    await s5.ctx.close();

    // ---------------------------------------------------------------- R8 390px
    const s6 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p6 = s6.page;
    const mobile = await p6.evaluate(() => {
      const main = document.querySelector('.spc-main').getBoundingClientRect();
      const panel = document.querySelector('.spc-panel').getBoundingClientRect();
      const input = document.getElementById('spcLsl').getBoundingClientRect();
      const btn = document.getElementById('spcFreeze').getBoundingClientRect();
      const wrap = document.querySelector('.spc-chart-wrap');
      return {
        docOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        mainW: main.width,
        panelBelow: panel.top >= main.bottom - 1,
        inputH: input.height,
        btnH: btn.height,
        chartInnerScroll: wrap.scrollWidth > wrap.clientWidth,
        wrapOverflowHidden: getComputedStyle(wrap).overflowX
      };
    });
    check('R8.1 390px 无页面横向溢出、主区/面板单列、触控高度 ≥40px',
      mobile.docOverflow && mobile.mainW > 300 && mobile.panelBelow &&
      mobile.inputH >= 40 && mobile.btnH >= 40, JSON.stringify(mobile));
    check('R8.2 小屏图表在自身容器内横向滚动（文字不被压缩到不可读），不影响页面宽度',
      mobile.chartInnerScroll && /auto|scroll/.test(mobile.wrapOverflowHidden));
    await p6.locator('#spcFreeze').scrollIntoViewIfNeeded();
    const btnBox = await p6.locator('#spcFreeze').boundingBox();
    await p6.touchscreen.tap(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await sleep(250);
    check('R8.3 触摸点按「建立/更新基准」生效且无异常',
      (await getState(p6)).baseline !== null && s6.errors.length === 0);
    await s6.ctx.close();

    // ---------------------------------------------------------------- R9 768px / 1440px
    const s7 = await newSession(browser, base, { viewport: { width: 768, height: 1024 } });
    const p7 = s7.page;
    const tablet = await p7.evaluate(() => {
      const main = document.querySelector('.spc-main').getBoundingClientRect();
      const panel = document.querySelector('.spc-panel').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        stacked: panel.top >= main.bottom - 1
      };
    });
    check('R9.1 768px：单列堆叠、无横向溢出', tablet.overflow && tablet.stacked, JSON.stringify(tablet));
    await s7.ctx.close();

    const s8 = await newSession(browser, base, { viewport: { width: 1440, height: 900 } });
    const p8 = s8.page;
    const desktop = await p8.evaluate(() => {
      const main = document.querySelector('.spc-main').getBoundingClientRect();
      const panel = document.querySelector('.spc-panel').getBoundingClientRect();
      return {
        sideBySide: panel.left >= main.right - 1,
        mainW: main.width,
        panelW: panel.width,
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
      };
    });
    check('R9.2 1440px：主区与参数面板并排（面板 380px、主区 >550px），无溢出',
      desktop.sideBySide && desktop.mainW > 550 && desktop.panelW > 320 && desktop.overflow,
      JSON.stringify(desktop));
    await s8.ctx.close();

    // ---------------------------------------------------------------- R10 深色主题
    const s9 = await newSession(browser, base);
    const p9 = s9.page;
    const lightStroke = await p9.evaluate(() =>
      getComputedStyle(document.querySelector('#spcChartI .spc-line--limit')).stroke);
    const lightSpec = await p9.evaluate(() =>
      getComputedStyle(document.querySelector('#spcChartI .spc-line--spec')).stroke);
    await p9.click('#themeToggle');
    await sleep(350);
    const darkTheme = await p9.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      limit: getComputedStyle(document.querySelector('#spcChartI .spc-line--limit')).stroke,
      spec: getComputedStyle(document.querySelector('#spcChartI .spc-line--spec')).stroke,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    check('R10.1 深色主题：控制界限与规格界限颜色随设计令牌切换，且两者仍不相同',
      darkTheme.theme === 'dark' && darkTheme.limit !== lightStroke &&
      darkTheme.spec !== lightSpec && darkTheme.limit !== darkTheme.spec && darkTheme.overflow,
      lightStroke + ' → ' + darkTheme.limit + ' / spec ' + darkTheme.spec);
    const darkV = await verifyInPage(p9);
    check('R10.2 深色下数值正确性不受影响', darkV.cpDelta < 1e-12 && s9.errors.length === 0);
    await s9.ctx.close();

    // ---------------------------------------------------------------- R11 键盘与无障碍
    const s10 = await newSession(browser, base);
    const p10 = s10.page;
    const kb0 = await getState(p10);
    await p10.locator('#spcLsl').focus();
    await p10.keyboard.press('ArrowUp');
    await sleep(250);
    const kb1 = await getState(p10);
    check('R11.1 键盘 ArrowUp 修改规格下限 → 立即重算（Cp 变化）',
      kb1.spec.lsl > kb0.spec.lsl && kb1.computeCount > kb0.computeCount,
      kb0.spec.lsl + ' → ' + kb1.spec.lsl);
    await p10.locator('#spcModeMeasured').focus();
    await p10.keyboard.press('ArrowDown');
    await sleep(300);
    const kb2 = await getState(p10);
    check('R11.2 键盘方向键在模式单选组内切换 → 进入理论参数模式',
      kb2.mode === 'theoretical' &&
      (await p10.evaluate(() => document.getElementById('spcModeTheory').checked)),
      kb2.mode);
    await p10.locator('#spcModeTheory').focus();
    await p10.keyboard.press('ArrowUp');
    await sleep(300);
    const backToMeasured = await getState(p10);
    check('R11.3 方向键切回实测模式，页面恢复样本计算',
      backToMeasured.mode === 'measured' && backToMeasured.sampleCount > 0,
      backToMeasured.mode + '/n=' + backToMeasured.sampleCount);

    const a11y = await p10.evaluate(() => {
      const svg = document.getElementById('spcChartI');
      const live = document.getElementById('spcLive');
      const label = document.querySelector('label[for="spcLsl"]');
      const groups = document.querySelector('.spc-modes');
      return {
        role: svg.getAttribute('role'),
        aria: (svg.getAttribute('aria-label') || '').length > 10,
        live: live.getAttribute('aria-live') === 'polite' && live.textContent.length > 0,
        label: label ? label.textContent.trim() : '',
        radiogroup: groups && groups.getAttribute('role') === 'radiogroup',
        captions: document.querySelectorAll('.spc-limit-table caption, .spc-cap-table caption').length,
        errorLive: document.getElementById('spcError').getAttribute('aria-live') === 'polite',
        dataHelp: document.getElementById('spcData').getAttribute('aria-describedby') === 'spcDataHelp'
      };
    });
    check('R11.4 无障碍：图表 role/aria-label、live region、单选组语义、表格 caption、错误 aria-live',
      a11y.role === 'img' && a11y.aria && a11y.live && /规格下限/.test(a11y.label) &&
      a11y.radiogroup && a11y.captions === 3 && a11y.errorLive && a11y.dataHelp,
      JSON.stringify(a11y));
    check('R11.5 键盘与无障碍操作全程无运行时异常', s10.errors.length === 0,
      s10.errors.slice(0, 2).join(' | ') || 'none');
    await s10.ctx.close();

    // ---------------------------------------------------------------- R12 离线
    const s11 = await newSession(browser, base, { sw: true });
    const p11 = s11.page;
    await p11.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p11.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p11.evaluate(() => { location.hash = '#/lab/spc-analysis'; });
    await waitSpc(p11);
    const cached = await p11.evaluate(async () => {
      const a = await caches.match('/blog/js/spc-calculation.js');
      const b = await caches.match('/blog/js/spc-demo.js');
      return { math: !!a, ui: !!b };
    });
    check('R12.1 在线访问后两个 SPC 脚本进入 SW 缓存（OPTIONAL 预热）',
      cached.math && cached.ui, JSON.stringify(cached));
    await sleep(500);
    await s11.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p11.reload({ waitUntil: 'load', timeout: 30000 });
      await waitSpc(p11, 20000);
      await setData(p11, BASE_TEXT);
      const v = await verifyInPage(p11);
      offlineInfo = { n: v.st.sampleCount, cp: v.st.cp, delta: v.cpDelta };
      offlineOk = v.st.sampleCount === 8 && v.cpDelta < 1e-12 && near(v.st.s, 0.2, 1e-12);
    } catch (e) { offlineOk = false; offlineInfo = String(e.message).split('\n')[0]; }
    check('R12.2 离线重载：页面可渲染、可粘贴新数据并独立重算（s=0.2）',
      offlineOk, JSON.stringify(offlineInfo));
    await s11.ctx.setOffline(false);
    await s11.ctx.close();

    // ---------------------------------------------------------------- R13 脚本失败降级
    for (const block of ['spc-demo.js', 'spc-calculation.js']) {
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

    // ---------------------------------------------------------------- R14 快速路由
    const s12 = await newSession(browser, base);
    const p12 = s12.page;
    for (const h of ['#/', '#/lab/spc-analysis', '#/lab/oee-analysis', '#/lab/spc-analysis', '#/lab/pid-control', '#/lab/spc-analysis']) {
      await p12.evaluate(hh => { location.hash = hh; }, h);
      await sleep(40);
    }
    await waitSpc(p12);
    const fast = await p12.evaluate(() => ({
      roots: document.querySelectorAll('#spcDemoRoot').length,
      oee: document.querySelectorAll('#oeeDemoRoot').length,
      pid: document.querySelectorAll('#pidChartY').length
    }));
    const fastV = await verifyInPage(p12);
    check('R14.1 快速切换 6 次路由：单实例、无串页、数值正确、无异常',
      fast.roots === 1 && fast.oee === 0 && fast.pid === 0 &&
      fastV.cpDelta < 1e-12 && s12.errors.length === 0,
      JSON.stringify(fast) + ' errors=' + s12.errors.length);
    await s12.ctx.close();

    // ---------------------------------------------------------------- R15 三引擎
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
        await waitSpc(page);
        await page.selectOption('#spcExample', 'spike');
        await sleep(350);
        const r = await page.evaluate(() => {
          const st = window.SpcDemo.getState(document.getElementById('spcDemoRoot'));
          const parsed = window.SpcCalculation.parseMeasurements(document.getElementById('spcData').value);
          const calc = window.SpcCalculation.computeMeasured({
            values: parsed.values,
            spec: { lsl: st.spec.lsl, usl: st.spec.usl }
          });
          return {
            n: st.sampleCount,
            cpk: st.cpk,
            cpkDelta: Math.abs(calc.capability.cpk - st.cpk),
            oos: st.outOfSpecCount,
            bars: document.querySelectorAll('#spcChartHist .spc-bar').length,
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
          };
        });
        check('R15.1 ' + eng.name + ' 390px：示例④渲染、Cpk 2.206171、超规 3 个、独立重算一致',
          r.n === 60 && near(r.cpk, 2.206170673, 1e-8) && r.cpkDelta < 1e-12 &&
          r.oos === 3 && r.bars >= 2 && r.overflow, JSON.stringify(r));
        check('R15.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('R15.1 ' + eng.name + ' 390px：示例④渲染、Cpk 2.206171、超规 3 个、独立重算一致', false,
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
