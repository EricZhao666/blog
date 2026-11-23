#!/usr/bin/env node
'use strict';
/**
 * Batch 9C-1A：真实浏览器下的二连杆运动学演示验收
 *
 * 覆盖：入口与渲染、数值一致性（getState + 页内独立 FK 回代，不凭图形位置判断）、
 * 指针拖动（可达/不可达/恢复）、肘上肘下切换、杆长输入与非法值、目标输入与边界/奇异状态、
 * 连续拖动、390px 移动布局与触摸、深色主题、键盘与无障碍、离线、脚本失败降级、
 * 快速路由切换、Firefox/WebKit 代表性场景。
 *
 * 用法：node tests/browser/robot-kinematics.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const ROUTE = '/lab/robot-2r';

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
  await waitRobot(page);
  return { ctx, page, errors };
}

async function waitRobot(page, timeout) {
  await page.waitForSelector('#robotStage', { state: 'visible', timeout: timeout || 30000 });
  await page.waitForFunction(() => {
    const s = document.getElementById('robotStatus');
    return !!s && s.textContent !== '–';
  }, null, { timeout: timeout || 30000 });
}

function getState(page) {
  return page.evaluate(() => window.RobotDemo.getState(document.getElementById('robotDemoRoot')));
}

// 页内独立 FK 回代：正确性判据是数值，不是图形位置
function verifyInPage(page) {
  return page.evaluate(() => {
    const st = window.RobotDemo.getState(document.getElementById('robotDemoRoot'));
    const f = window.RobotKinematics.fk(st.L1, st.L2, st.t1, st.t2);
    return {
      st,
      fkEndDelta: Math.hypot(f.end.x - st.end.x, f.end.y - st.end.y),
      targetDelta: Math.hypot(f.end.x - st.target.x, f.end.y - st.target.y),
      finite: [st.t1, st.t2, st.end.x, st.end.y, st.residual].every(Number.isFinite)
    };
  });
}

async function worldToClient(page, x, y) {
  return page.evaluate(([x, y]) => {
    const svg = document.getElementById('robotStage');
    const r = svg.getBoundingClientRect();
    const s = Number(svg.getAttribute('data-scale'));
    const cx = Number(svg.getAttribute('data-cx'));
    const cy = Number(svg.getAttribute('data-cy'));
    return {
      x: r.left + (cx + x * s) / 640 * r.width,
      y: r.top + (cy - y * s) / 640 * r.height
    };
  }, [x, y]);
}

async function dragTo(page, x, y, steps) {
  const p = await worldToClient(page, x, y);
  await page.mouse.move(p.x, p.y, { steps: steps || 5 });
  await page.mouse.down();
  await page.mouse.up();
  await sleep(120);
}

async function setInput(page, sel, value) {
  const s = String(value);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    await page.fill(sel, s);
    await page.locator(sel).press('Enter');
  } else {
    // input[type=number] 会把非数字文本净化为空串（浏览器行为）：
    // 用 JS 赋值 + change 事件模拟这条非法输入路径
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
    // ---------------------------------------------------------------- R1 入口与渲染
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const entry = await p1.evaluate(() => {
      const link = document.querySelector('.nav-link[data-route="/lab"]');
      return {
        link: !!link && link.getAttribute('href') === '#/lab/robot-2r',
        active: !!link && link.classList.contains('active'),
        stage: !!document.getElementById('robotStage'),
        readout: ['robotT1', 'robotT2', 'robotTargetPos', 'robotEndPos', 'robotResidual', 'robotWorkspace', 'robotStatus']
          .every(id => !!document.getElementById(id)),
        title: document.title
      };
    });
    check('R1.1 导航「实验」入口存在、当前页激活、页面标题正确',
      entry.link && entry.active && /二连杆机器人运动学演示/.test(entry.title), JSON.stringify(entry));
    check('R1.2 SVG 工作区与全部读数项渲染', entry.stage && entry.readout);

    const v1 = await verifyInPage(p1);
    check('R1.3 默认姿态数值一致：getState 末端 = 页内独立 FK 回代，残差≈0',
      v1.finite && v1.fkEndDelta < 1e-9 && v1.st.residual < 1e-9 * 210 && v1.st.reachable === true,
      'fkΔ=' + v1.fkEndDelta.toExponential(2) + ' residual=' + v1.st.residual.toExponential(2));

    const readoutSync = await p1.evaluate(() => {
      const st = window.RobotDemo.getState(document.getElementById('robotDemoRoot'));
      const t1 = parseFloat(document.getElementById('robotT1').textContent);
      const t2 = parseFloat(document.getElementById('robotT2').textContent);
      const ws = document.getElementById('robotWorkspace').textContent;
      return {
        t1ok: Math.abs(t1 - st.t1 * 180 / Math.PI) < 0.011,
        t2ok: Math.abs(t2 - st.t2 * 180 / Math.PI) < 0.011,
        ws: ws
      };
    });
    check('R1.4 DOM 读数与状态数值一致，工作空间显示 30–210',
      readoutSync.t1ok && readoutSync.t2ok && /30\.0 ≤ r ≤ 210\.0/.test(readoutSync.ws), readoutSync.ws);

    // ---------------------------------------------------------------- R2 指针拖动
    await dragTo(p1, 60, 140);
    const v2 = await verifyInPage(p1);
    check('R2.1 拖动到可达点 (60,140)：目标跟随、FK 回代残差≈0',
      v2.st.reachable && Math.hypot(v2.st.target.x - 60, v2.st.target.y - 140) < 2 &&
      v2.targetDelta < 1e-6 * 210,
      'target=(' + v2.st.target.x.toFixed(1) + ',' + v2.st.target.y.toFixed(1) + ') residual=' + v2.st.residual.toExponential(2));

    await dragTo(p1, 240, 0);   // r=240 > 210，仍在视口内
    const v3 = await verifyInPage(p1);
    const unreachableUi = await p1.evaluate(() => ({
      status: document.getElementById('robotStatus').textContent,
      reach: document.getElementById('robotStage').getAttribute('data-reach'),
      residualLine: document.getElementById('robotResidualLine').getAttribute('visibility')
    }));
    check('R2.2 拖到不可达点 (240,0)：状态不可达、目标不被截断、残差为真实距离',
      v3.st.reachable === false && v3.st.reason === 'beyond-outer' &&
      Math.abs(v3.st.target.x - 240) < 2 && v3.st.residual > 1 &&
      Math.abs(v3.st.residual - Math.hypot(v3.st.target.x - v3.st.end.x, v3.st.target.y - v3.st.end.y)) < 1e-9 &&
      /不可达/.test(unreachableUi.status) && unreachableUi.reach === '0' && unreachableUi.residualLine === 'visible',
    JSON.stringify(unreachableUi) + ' residual=' + v3.st.residual.toFixed(2));

    await dragTo(p1, 100, 60);
    const v4 = await verifyInPage(p1);
    check('R2.3 拖回可达区域：状态恢复、残差重新≈0',
      v4.st.reachable === true && v4.st.residual < 1e-6 * 210);
    check('R2.4 拖动全程无运行时异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');

    // ---------------------------------------------------------------- R3 分支切换
    await p1.click('#robotBranchDown');
    await sleep(100);
    const vDown = await verifyInPage(p1);
    const pressed = await p1.evaluate(() => ({
      up: document.getElementById('robotBranchUp').getAttribute('aria-pressed'),
      down: document.getElementById('robotBranchDown').getAttribute('aria-pressed')
    }));
    check('R3.1 切到肘下：θ2≥0、aria-pressed 同步、FK 回代通过',
      vDown.st.branch === 'elbow-down' && vDown.st.t2 >= 0 && vDown.fkEndDelta < 1e-9 &&
      pressed.up === 'false' && pressed.down === 'true', JSON.stringify(pressed));

    const side = await p1.evaluate(() => {
      const st = window.RobotDemo.getState(document.getElementById('robotDemoRoot'));
      return st.target.x * st.elbow.y - st.target.y * st.elbow.x;
    });
    check('R3.2 肘下分支肘部在基座→目标右侧（cross≤0，数值判据）', side <= 1e-6, 'cross=' + side.toFixed(2));

    await p1.locator('#robotBranchUp').focus();
    await p1.keyboard.press('Enter');
    await sleep(100);
    const vUp = await verifyInPage(p1);
    check('R3.3 键盘 Enter 切回肘上：θ2≤0 且回代通过',
      vUp.st.branch === 'elbow-up' && vUp.st.t2 <= 0 && vUp.fkEndDelta < 1e-9);

    // ---------------------------------------------------------------- R4 杆长输入
    await setInput(p1, '#robotL1', 150);
    await setInput(p1, '#robotL2', 100);
    const lenState = await getState(p1);
    const wsGeom = await p1.evaluate(() => {
      const svg = document.getElementById('robotStage');
      const outer = svg.querySelector('.robot-ws-outer');
      return {
        s: Number(svg.getAttribute('data-scale')),
        r: Number(outer.getAttribute('r')),
        ws: document.getElementById('robotWorkspace').textContent
      };
    });
    check('R4.1 改 L1=150 L2=100：状态更新、工作空间圆半径 = rMax×scale（数值一致）',
      lenState.L1 === 150 && lenState.L2 === 100 &&
      Math.abs(wsGeom.r - 250 * wsGeom.s) < 0.01 && /50\.0 ≤ r ≤ 250\.0/.test(wsGeom.ws),
    wsGeom.ws);

    await setInput(p1, '#robotL1', 0);
    const badLen = await p1.evaluate(() => ({
      err: document.getElementById('robotLenError').textContent,
      invalid: document.getElementById('robotL1').getAttribute('aria-invalid'),
      L1: window.RobotDemo.getState(document.getElementById('robotDemoRoot')).L1
    }));
    check('R4.2 L1=0 被拒绝：错误提示、aria-invalid、保持上一组有效长度',
      /需为/.test(badLen.err) && badLen.invalid === 'true' && badLen.L1 === 150, JSON.stringify(badLen));

    await setInput(p1, '#robotL2', 'abc');
    const badLen2 = await p1.evaluate(() => ({
      err: document.getElementById('robotLenError').textContent,
      L2: window.RobotDemo.getState(document.getElementById('robotDemoRoot')).L2
    }));
    check('R4.3 非数字/空输入被拒绝且不崩溃（number 输入净化为空串路径）', /需为/.test(badLen2.err) && badLen2.L2 === 100);

    await setInput(p1, '#robotL1', 150);
    await setInput(p1, '#robotL2', 100);
    await setInput(p1, '#robotL1', 100);
    const eqLen = await p1.evaluate(() => ({
      inner: !!document.querySelector('.robot-ws-inner'),
      ws: document.getElementById('robotWorkspace').textContent,
      err: document.getElementById('robotLenError').textContent
    }));
    check('R4.4 等长杆 L1=L2=100：内边界圆消失（rMin=0）、错误清除',
      !eqLen.inner && /0\.0 ≤ r ≤ 200\.0/.test(eqLen.ws) && eqLen.err === '', JSON.stringify(eqLen));

    // ---------------------------------------------------------------- R5 目标输入 / 边界 / 奇异
    await setInput(p1, '#robotTX', 0);
    await setInput(p1, '#robotTY', 0);
    const originState = await verifyInPage(p1);
    const originStatus = await p1.locator('#robotStatus').textContent();
    check('R5.1 等长杆目标 (0,0)：可达·奇异（完全折叠）且残差≈0',
      originState.st.reachable && originState.st.singular === 'folded' &&
      originState.st.residual < 1e-6 && /完全折叠/.test(originStatus), originStatus);

    await setInput(p1, '#robotL1', 120);
    await setInput(p1, '#robotL2', 90);
    await setInput(p1, '#robotTX', 210);
    await setInput(p1, '#robotTY', 0);
    const extState = await verifyInPage(p1);
    const extStatus = await p1.locator('#robotStatus').textContent();
    check('R5.2 目标 (210,0)=rMax：奇异（完全伸直）、|θ2|≈0、回代通过',
      extState.st.singular === 'extended' && Math.abs(extState.st.t2) < 1e-6 &&
      extState.fkEndDelta < 1e-9 && /完全伸直/.test(extStatus), extStatus);

    await setInput(p1, '#robotTX', 30);
    const foldState = await verifyInPage(p1);
    const foldStatus = await p1.locator('#robotStatus').textContent();
    check('R5.3 目标 (30,0)=rMin：奇异（完全折叠）、|θ2|≈π',
      foldState.st.singular === 'folded' && Math.abs(Math.abs(foldState.st.t2) - Math.PI) < 1e-6 &&
      /完全折叠/.test(foldStatus), foldStatus);

    await setInput(p1, '#robotTX', 250);
    const outState = await getState(p1);
    const outStatus = await p1.locator('#robotStatus').textContent();
    check('R5.4 目标 250>rMax：不可达·超出外边界，目标保持 250 不截断',
      outState.reachable === false && outState.target.x === 250 && /超出外边界/.test(outStatus), outStatus);

    await setInput(p1, '#robotTX', 10);
    const inState = await getState(p1);
    const inStatus = await p1.locator('#robotStatus').textContent();
    check('R5.5 目标 10<rMin：不可达·内边界以内',
      inState.reachable === false && inState.reason === 'inside-inner' && /内边界以内/.test(inStatus), inStatus);

    await setInput(p1, '#robotTX', 'abc');
    const badTarget = await p1.evaluate(() => ({
      err: document.getElementById('robotTargetError').textContent,
      x: window.RobotDemo.getState(document.getElementById('robotDemoRoot')).target.x
    }));
    check('R5.6 非法/空目标输入被拒绝并保持上一有效目标', /有限数字/.test(badTarget.err) && badTarget.x === 10);

    await setInput(p1, '#robotTX', 150);
    await setInput(p1, '#robotTY', 90);
    check('R5.7 恢复可达目标后无运行时异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');
    await s1.ctx.close();

    // ---------------------------------------------------------------- R6 连续拖动
    const s2 = await newSession(browser, base);
    const p2 = s2.page;
    let contOk = true, maxStep = 0, prevEnd = null, allReachable = true;
    for (let i = 0; i <= 24; i++) {
      const phi = (20 + (80 * i) / 24) * Math.PI / 180;
      const wx = 120 * Math.cos(phi), wy = 120 * Math.sin(phi);
      const cp = await worldToClient(p2, wx, wy);
      if (i === 0) { await page_mouseDown(p2, cp); }
      await p2.mouse.move(cp.x, cp.y);
      await sleep(30);
      const st = await getState(p2);
      if (!st.reachable || ![st.t1, st.t2, st.end.x, st.end.y].every(Number.isFinite)) allReachable = false;
      if (prevEnd) {
        const d = Math.hypot(st.end.x - prevEnd.x, st.end.y - prevEnd.y);
        maxStep = Math.max(maxStep, d);
        if (d > 15) contOk = false;
      }
      prevEnd = st.end;
    }
    await p2.mouse.up();
    await sleep(120);
    const finalV = await verifyInPage(p2);
    check('R6.1 连续拖动 25 步：全程可达、角度有限、相邻末端步长有界（<15 单位）',
      contOk && allReachable, 'maxStep=' + maxStep.toFixed(2));
    check('R6.2 连续拖动结束：残差≈0 且无运行时异常',
      finalV.st.residual < 1e-6 * 210 && s2.errors.length === 0,
      'residual=' + finalV.st.residual.toExponential(2));
    await s2.ctx.close();

    // ---------------------------------------------------------------- R7 390px 移动布局 + 触摸
    const s3 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p3 = s3.page;
    const mobile = await p3.evaluate(() => {
      const stage = document.getElementById('robotStage').getBoundingClientRect();
      const panel = document.querySelector('.robot-panel').getBoundingClientRect();
      const input = document.getElementById('robotL1').getBoundingClientRect();
      const btn = document.getElementById('robotBranchUp').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        stageW: stage.width,
        panelBelow: panel.top >= stage.bottom - 1,
        inputH: input.height,
        btnH: btn.height
      };
    });
    check('R7.1 390px 无横向溢出、工作区完整、面板移到下方',
      mobile.overflow && mobile.stageW > 300 && mobile.panelBelow, JSON.stringify(mobile));
    check('R7.2 390px 输入框与分支按钮触控高度 ≥40px',
      mobile.inputH >= 40 && mobile.btnH >= 40, JSON.stringify(mobile));

    const tp = await worldToClient(p3, 80, 120);
    await p3.touchscreen.tap(tp.x, tp.y);
    await sleep(150);
    const touchState = await verifyInPage(p3);
    check('R7.3 触摸点按设定目标：可达且回代残差≈0',
      touchState.st.reachable && Math.hypot(touchState.st.target.x - 80, touchState.st.target.y - 120) < 3 &&
      touchState.st.residual < 1e-6 * 210,
      'target=(' + touchState.st.target.x.toFixed(1) + ',' + touchState.st.target.y.toFixed(1) + ')');
    check('R7.4 移动端无运行时异常', s3.errors.length === 0, s3.errors.slice(0, 2).join(' | ') || 'none');
    await s3.ctx.close();

    // ---------------------------------------------------------------- R8 深色主题
    const s4 = await newSession(browser, base);
    const p4 = s4.page;
    const lightStroke = await p4.evaluate(() => getComputedStyle(document.getElementById('robotLink1')).stroke);
    await p4.click('#themeToggle');
    await sleep(300);
    const dark = await p4.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.getElementById('robotLink1')).stroke,
      wsFill: getComputedStyle(document.querySelector('.robot-ws-outer')).fill,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      statusBg: getComputedStyle(document.getElementById('robotStatus')).backgroundColor
    }));
    check('R8.1 深色主题：SVG 颜色随设计令牌切换且无溢出',
      dark.theme === 'dark' && dark.stroke !== lightStroke && dark.overflow,
      lightStroke + ' → ' + dark.stroke);
    const darkDrag = await (async () => { await dragTo(p4, 90, 110); return verifyInPage(p4); })();
    check('R8.2 深色下拖动与数值正确性不受影响',
      darkDrag.st.reachable && darkDrag.st.residual < 1e-6 * 210 && s4.errors.length === 0);
    await s4.ctx.close();

    // ---------------------------------------------------------------- R9 键盘与无障碍
    const s5 = await newSession(browser, base);
    const p5 = s5.page;
    await p5.locator('#robotStage').focus();
    const before = await getState(p5);
    await p5.keyboard.press('ArrowRight');
    await sleep(60);
    const afterRight = await getState(p5);
    check('R9.1 方向键移动目标：ArrowRight → x+1',
      Math.abs(afterRight.target.x - before.target.x - 1) < 1e-9 &&
      Math.abs(afterRight.target.y - before.target.y) < 1e-9);

    await p5.keyboard.press('Shift+ArrowUp');
    await sleep(60);
    const afterShift = await getState(p5);
    check('R9.2 Shift+ArrowUp → y+10',
      Math.abs(afterShift.target.y - afterRight.target.y - 10) < 1e-9);

    await p5.keyboard.press('Home');
    await sleep(60);
    const afterHome = await getState(p5);
    check('R9.3 Home 恢复默认目标 (150,90)',
      afterHome.target.x === 150 && afterHome.target.y === 90);

    const a11y = await p5.evaluate(() => {
      const svg = document.getElementById('robotStage');
      const live = document.getElementById('robotLive');
      const labelFor = id => {
        const el = document.getElementById(id);
        const lab = el.closest('label');
        return lab ? lab.textContent.trim() : '';
      };
      return {
        role: svg.getAttribute('role'),
        tabindex: svg.getAttribute('tabindex'),
        ariaLabel: (svg.getAttribute('aria-label') || '').length > 10,
        live: live.getAttribute('aria-live') === 'polite' && live.textContent.length > 0,
        l1Label: labelFor('robotL1'),
        txLabel: labelFor('robotTX'),
        upName: document.getElementById('robotBranchUp').textContent.trim(),
        groupLabel: !!document.querySelector('.robot-branch[role="group"][aria-labelledby]')
      };
    });
    check('R9.4 无障碍：工作区 role/tabindex/aria-label、live region、输入标签、分支组标签',
      a11y.role === 'application' && a11y.tabindex === '0' && a11y.ariaLabel && a11y.live &&
      /L1/.test(a11y.l1Label) && /X/.test(a11y.txLabel) && a11y.upName === '肘上' && a11y.groupLabel,
    JSON.stringify(a11y));
    check('R9.5 键盘操作全程无运行时异常', s5.errors.length === 0, s5.errors.slice(0, 2).join(' | ') || 'none');
    await s5.ctx.close();

    // ---------------------------------------------------------------- R10 离线
    const s6 = await newSession(browser, base, { sw: true });
    const p6 = s6.page;
    await p6.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p6.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p6.evaluate(() => { location.hash = '#/lab/robot-2r'; });
    await waitRobot(p6);
    const cached = await p6.evaluate(async () => {
      const a = await caches.match('/blog/js/robot-kinematics.js');
      const b = await caches.match('/blog/js/robot-demo.js');
      return { math: !!a, ui: !!b };
    });
    check('R10.1 在线访问后两个演示脚本进入 SW 缓存', cached.math && cached.ui, JSON.stringify(cached));
    await sleep(500);
    await s6.ctx.setOffline(true);
    let offlineOk = false, offlineState = null;
    try {
      await p6.reload({ waitUntil: 'load', timeout: 30000 });
      await waitRobot(p6, 20000);
      await dragTo(p6, 70, 130);
      const v = await verifyInPage(p6);
      offlineState = { reachable: v.st.reachable, residual: v.st.residual };
      offlineOk = v.st.reachable && v.st.residual < 1e-6 * 210;
    } catch (e) { offlineOk = false; offlineState = String(e.message).split('\n')[0]; }
    check('R10.2 离线重载：演示可渲染、可拖动、IK 数值正确', offlineOk, JSON.stringify(offlineState));
    await s6.ctx.setOffline(false);
    await s6.ctx.close();

    // ---------------------------------------------------------------- R11 脚本失败降级
    // 必须在首次进入路由前就拦截 UI 脚本，否则已加载的全局会走缓存路径
    const ctx7 = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await ctx7.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
      return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
    });
    await ctx7.route('**/js/robot-demo.js*', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
    const p7 = await ctx7.newPage();
    const errs7 = [];
    p7.on('pageerror', e => errs7.push(e.message));
    await p7.goto(base + PREFIX + '/index.html#' + ROUTE, { waitUntil: 'load', timeout: 60000 });
    await p7.waitForSelector('.empty-state', { timeout: 20000 });
    const degraded = await p7.evaluate(() => ({
      text: document.querySelector('.empty-state').textContent
    }));
    check('R11.1 UI 脚本 404：显示加载失败与重试入口，不白屏不抛错',
      /加载失败/.test(degraded.text) && /重试/.test(degraded.text) && errs7.length === 0,
      degraded.text.replace(/\s+/g, ' ').slice(0, 60));
    await p7.evaluate(() => { location.hash = '#/'; });
    await p7.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    const homeAfterFail = await p7.evaluate(() => document.querySelectorAll('#app .article-card').length);
    check('R11.2 演示脚本失败不影响首页文章列表', homeAfterFail > 5 && errs7.length === 0, 'cards=' + homeAfterFail);
    await ctx7.close();

    // ---------------------------------------------------------------- R12 快速路由切换
    const s8 = await newSession(browser, base);
    const p8 = s8.page;
    for (const h of ['#/', '#/projects', '#/lab/robot-2r', '#/about', '#/lab/robot-2r']) {
      await p8.evaluate(hh => { location.hash = hh; }, h);
      await sleep(40);
    }
    await waitRobot(p8);
    const fast = await p8.evaluate(() => ({
      stages: document.querySelectorAll('#robotStage').length,
      roots: document.querySelectorAll('#robotDemoRoot').length
    }));
    const fastV = await verifyInPage(p8);
    check('R12.1 快速切换 5 次路由：单实例、无串页、数值正确、无异常',
      fast.stages === 1 && fast.roots === 1 && fastV.fkEndDelta < 1e-9 && s8.errors.length === 0,
      JSON.stringify(fast) + ' errors=' + s8.errors.length);
    await s8.ctx.close();

    // ---------------------------------------------------------------- R13 三引擎代表性场景
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
        await waitRobot(page);
        await dragTo(page, 80, 120);
        await page.click('#robotBranchDown');
        await sleep(120);
        const r = await page.evaluate(() => {
          const st = window.RobotDemo.getState(document.getElementById('robotDemoRoot'));
          const f = window.RobotKinematics.fk(st.L1, st.L2, st.t1, st.t2);
          return {
            branch: st.branch,
            reachable: st.reachable,
            fkDelta: Math.hypot(f.end.x - st.end.x, f.end.y - st.end.y),
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
          };
        });
        check('R13.1 ' + eng.name + ' 390px：渲染/拖动/分支切换正常且无溢出',
          r.branch === 'elbow-down' && r.reachable && r.fkDelta < 1e-9 && r.overflow, JSON.stringify(r));
        check('R13.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('R13.1 ' + eng.name + ' 390px：渲染/拖动/分支切换正常且无溢出', false, String(e.message).split('\n')[0]);
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

async function page_mouseDown(page, cp) {
  await page.mouse.move(cp.x, cp.y);
  await page.mouse.down();
}