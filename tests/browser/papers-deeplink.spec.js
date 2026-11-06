#!/usr/bin/env node
'use strict';
/**
 * Batch 7B-2：论文 / 学习资料搜索深链（真实 Chromium + 本地 HTTP Server）
 *
 * 复现的缺陷（B7B-01 五模型验收结论）：
 *   1) 搜索结果点击后只跳到 #/papers，没有任何目标信息，无法定位到具体条目；
 *   2) 用数组下标做目标键（MiMo / Kimi）时，重排/前插/删除其他条目会错跳到别的资料；
 *   3) 用内容指纹做目标键（DeepSeek / MiniMax / Hy4）时，大小、显示名、分类一变旧链接就失效；
 *   4) 从文章返回首页时旧搜索词残留（冻结 S01），而浏览器后退又拿不回原搜索上下文；
 *   5) 目标没有进入视口、没有键盘焦点、论文不会自动展开；
 *   6) 目标缺失 / 数据加载失败 / 非法 URL 编码没有明确降级。
 *
 * 覆盖（S = 稳定身份，D = 深链，F = 降级，R = 路由竞争，V = 视口，H = 历史，W = SW）：
 *   S1-S5   有 ID 的资料/论文：重排、前插、删除其他条目、改大小/名称/分类后旧链接仍命中同一对象
 *   D1-D8   论文与资料深链：定位、视口、焦点、高亮、自动展开、刷新、复制链接
 *   F1-F5   目标不存在 / 目标被删除 / 非法编码 / 非法 kind / 数据加载失败后重试
 *   R1-R3   慢网下快速切换路由：旧结果不得覆盖当前页面
 *   V1-V4   390×844 与 1280×800：目标进入视口
 *   H1-H4   前进/后退：深链可复原；返回搜索页恢复原上下文；主动点首页清空搜索词
 *   W1-W2   SW 接管后深链仍精确；慢网 SW 升级后新代码生效且深链仍命中
 *
 * 用法：
 *   node tests/browser/papers-deeplink.spec.js
 *   PW_CHANNEL=chromium node tests/browser/papers-deeplink.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
// 允许把同一批用例跑在"未修复版本"的副本上（建立修复前证据）：
//   set B7B2_SITE_ROOT=<baseline 副本>
//   set B7B2_EVIDENCE=papers-deeplink-baseline.json
const SITE_ROOT = process.env.B7B2_SITE_ROOT ? path.resolve(process.env.B7B2_SITE_ROOT) : ROOT;
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const SHOTS = path.join(__dirname, 'artifacts');
const EVIDENCE = path.join(SHOTS, process.env.B7B2_EVIDENCE || 'papers-deeplink.json');

let pass = 0, fail = 0;
const results = [];
const evidence = {};

function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, extra: extra === undefined ? null : extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 合成数据
// 只在这里定义数据集：仓库里的 js/papers.js 是真实产物，用例不得改动它。
// 一部分资料带持久 ID（lm-0000NN），一部分故意不带 ID，用来验证旧数据的兼容解析。
function fixture() {
  const papers = [
    { id: 'paper-alpha', title: '深链论文 Alpha', category: '具身智能', authors: 'Alpha Author', type: 'preprint', abstract: 'Alpha 摘要', url: 'https://example.invalid/a', date: '2024-01-01' },
    { id: 'paper-beta', title: '深链论文 Beta', category: '双足机器人', authors: 'Beta Author', type: 'preprint', abstract: 'Beta 摘要', url: 'https://example.invalid/b', date: '2024-02-02' },
    { id: 'paper 中文 & # ? % / + \' " 😀', title: '特殊字符 论文 <img src=x onerror=alert(1)>', category: '未分类', authors: 'Special Author', type: 'preprint', abstract: '特殊摘要', url: 'https://example.invalid/c', date: '2024-03-03' }
  ];
  for (let i = 0; i < 18; i++) {
    papers.push({
      id: 'paper-filler-' + i,
      title: '填充论文 ' + i,
      category: '具身智能',
      authors: 'Filler',
      type: 'preprint',
      abstract: 'filler',
      url: '',
      date: '2023-01-01'
    });
  }
  const materials = [
    { id: 'lm-000001', name: '资料 Alpha.pdf', category: 'ANSYS仿真', subcategory: '第1课', type: 'PDF', size: 10, sizeFormatted: '10 B' },
    { id: 'lm-000002', name: '资料 Beta.pdf', category: 'CAD建模', subcategory: 'SolidWorks', type: 'SolidWorks零件', size: 20, sizeFormatted: '20 B' },
    { id: 'lm-000003', name: 'same-name.pdf', category: 'ANSYS仿真', subcategory: 'left', type: 'PDF', size: 30, sizeFormatted: '30 B' },
    { name: 'same-name.pdf', category: 'CAD建模', subcategory: 'right', type: 'PDF', size: 40, sizeFormatted: '40 B' },
    { id: 'lm-000005', name: '特殊 资料 & # % 😀.pdf', category: 'CAD建模', subcategory: 'special', type: 'PDF', size: 50, sizeFormatted: '50 B' },
    { id: 'lm-000006', name: '身份稳定.pdf', category: 'CAD建模', subcategory: 'reorder', type: 'PDF', size: 60, sizeFormatted: '60 B' }
  ];
  for (let i = 0; i < 18; i++) {
    materials.push({ id: 'lm-0001' + String(10 + i), name: '填充资料 ' + i + '.pdf', category: 'ANSYS仿真', subcategory: '第2课', type: 'PDF', size: 100 + i, sizeFormatted: '100 B' });
  }
  return { papers, materials };
}

function papersJs(data) {
  const counts = {};
  for (const p of data.papers) {
    if (!counts[p.category]) counts[p.category] = { count: 0, types: ['preprint'] };
    counts[p.category].count++;
  }
  return 'const PAPERS=' + JSON.stringify(data.papers) + ';\n' +
    'const PAPER_CATEGORIES=' + JSON.stringify(counts) + ';\n' +
    'const LEARNING_MATERIALS=' + JSON.stringify(data.materials) + ';\n' +
    'const LEARN_CATEGORIES={};\n';
}

// ---------------------------------------------------------------- 断言探针
// 在页面里判断"目标是否被正确定位"，一次取回全部证据，避免多条断言互相等待
function probe(page, kind, key) {
  return page.evaluate(({ kind, key }) => {
    const sel = kind === 'material' ? '.file-item' : '.paper-card';
    const attr = kind === 'material' ? 'data-material-key' : 'data-paper-key';
    const nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    const keyed = key == null ? [] : nodes.filter(n => n.getAttribute(attr) === key);
    const marked = nodes.filter(n => /target|highlight|selected|focused/.test(n.className || '') ||
      n.getAttribute('aria-current') === 'true');
    const el = keyed[0] || null;
    const rect = el ? el.getBoundingClientRect() : null;
    const cs = el ? getComputedStyle(el) : null;
    const abs = el ? el.querySelector('.paper-abstract') : null;
    return {
      total: nodes.length,
      hasKeyAttr: nodes.length ? nodes[0].hasAttribute(attr) : null,
      keyMatched: keyed.length,
      markedCount: marked.length,
      markedKey: marked.length === 1 ? marked[0].getAttribute(attr) : null,
      visible: !!(rect && rect.top >= 0 && rect.top < innerHeight && rect.bottom > 0 && rect.width > 0),
      rect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null,
      focused: !!(el && (document.activeElement === el || el.contains(document.activeElement))),
      outlineStyle: cs ? cs.outlineStyle : null,
      outlineWidth: cs ? parseFloat(cs.outlineWidth || '0') : 0,
      expanded: el ? el.classList.contains('expanded') : null,
      abstractHeight: abs ? Math.round(abs.getBoundingClientRect().height) : null,
      hash: location.hash,
      scrollY: Math.round(window.scrollY),
      notices: Array.prototype.map.call(document.querySelectorAll('[role="status"]'), n => n.textContent.trim()),
      papersPage: !!document.querySelector('.papers-page'),
      activeTab: (document.querySelector('.paper-tab.active') || {}).textContent || ''
    };
  }, { kind, key });
}

function parseTarget(href) {
  const i = href.indexOf('?');
  if (i === -1) return null;
  const params = new URLSearchParams(href.slice(i + 1));
  return { kind: params.get('kind'), target: params.get('target') };
}

function getTarget(page, kind) {
  const attr = kind === 'material' ? 'data-material-key' : 'data-paper-key';
  return page.evaluate((a) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('.file-item[' + a + '], .paper-card[' + a + ']'));
    const marked = nodes.filter(n => /target|highlight|selected|focused/.test(n.className || '') ||
      n.getAttribute('aria-current') === 'true');
    const el = marked[0] || nodes[0];
    return el ? el.getAttribute(a) : null;
  }, attr);
}

// 取某个 .file-item 的 .file-path（子分类），用于区分完全同名的条目
function subcategoryOf(page, kind, key) {
  const attr = kind === 'material' ? 'data-material-key' : 'data-paper-key';
  return page.evaluate(({ attr, key }) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('.file-item, .paper-card'));
    const el = nodes.filter(n => n.getAttribute(attr) === key)[0];
    const sub = el && el.querySelector('.file-path');
    return sub ? sub.textContent : null;
  }, { attr, key });
}

// 从首页搜索、点击结果进入深链，返回生成的 URL（用于"复制链接"断言）
async function searchAndClick(page, base, text, nth) {
  if (!page.url().endsWith('#/')) {
    await page.goto(base + PREFIX + '/#/');
    await page.waitForTimeout(300);
  }
  await page.locator('#searchInput').fill(text);
  await page.waitForFunction(q => document.querySelector('#app') &&
    document.querySelector('#app').textContent.includes(q), text, { timeout: 6000 });
  await page.waitForTimeout(250);
  const rows = page.locator('.search-paper-item').filter({
    has: page.locator('.search-item-title').filter({ hasText: text })
  });
  await rows.nth(nth || 0).waitFor({ timeout: 5000 });
  const before = rows.nth(nth || 0).getAttribute('data-href');
  await rows.nth(nth || 0).click();
  await page.waitForTimeout(400);
  return { href: page.url(), dataHref: before };
}

async function newSession(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 800 },
    serviceWorkers: o.sw ? 'allow' : 'block'
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  return { ctx, page, errors, dialogs };
}

async function waitController(page, timeout) {
  const limit = timeout || 25000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    const controlled = await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
    if (controlled) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fixture();
  const { server, state } = createServer(SITE_ROOT, PREFIX);
  state.overrides['/js/papers.js'] = papersJs(data);
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port;
  const deep = u => base + PREFIX + '/#' + u;

  const launchOpts = { headless: true };
  if (CHANNEL !== 'chromium') launchOpts.channel = CHANNEL;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）：' + String(e.message).split('\n')[0]);
    server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());

  const SPECIAL_PAPER = data.papers[2].id;
  const SPECIAL_MATERIAL = data.materials[4].id;

  try {
    // ============================================================ S 身份稳定
    {
      const { ctx, page, errors } = await newSession(browser);
      const st = await searchAndClick(page, base, '身份稳定.pdf', 0);
      const target = parseTarget(st.href);
      check('S1 资料搜索结果带 kind/target 参数', !!target && target.kind === 'material' && !!target.target,
        st.href.replace(base + PREFIX + '/', ''));
      const keyBefore = target ? target.target : null;
      let p = await probe(page, 'material', keyBefore);
      check('S1 旧链接命中目标资料', p.keyMatched === 1 && p.markedCount === 1, JSON.stringify({ keyMatched: p.keyMatched, marked: p.markedCount }));

      // 重排 + 前插 + 删除其他条目：身份必须仍是同一对象
      const reordered = JSON.parse(JSON.stringify(data));
      reordered.materials.reverse();
      reordered.materials.unshift({ id: 'lm-000900', name: '前插资料.pdf', category: 'CAD建模', subcategory: 'new', type: 'PDF', size: 1, sizeFormatted: '1 B' });
      reordered.materials = reordered.materials.filter(m => m.name !== '资料 Alpha.pdf');
      state.overrides['/js/papers.js'] = papersJs(reordered);
      await page.reload();
      await page.waitForTimeout(500);
      p = await probe(page, 'material', keyBefore);
      check('S2 重排/前插/删除其他条目后旧链接仍命中同一资料',
        p.keyMatched === 1 && p.markedKey === keyBefore, JSON.stringify({ keyMatched: p.keyMatched, markedKey: p.markedKey }));

      // 改大小 + 显示名 + 分类：元数据变化不得让链接失效（ID 不变）
      const mutated = JSON.parse(JSON.stringify(reordered));
      const m = mutated.materials.find(x => x.id === keyBefore);
      if (m) { m.size = 999; m.sizeFormatted = '999 B'; m.subcategory = 'reorder-renamed'; }
      state.overrides['/js/papers.js'] = papersJs(mutated);
      await page.reload();
      await page.waitForTimeout(500);
      p = await probe(page, 'material', keyBefore);
      check('S3 修改大小/子分类后旧链接仍命中同一资料', p.keyMatched === 1 && p.markedKey === keyBefore,
        JSON.stringify({ keyMatched: p.keyMatched, size: m && m.size }));

      // 删除目标本身：旧链接失效但不能串到别的资料
      const removed = JSON.parse(JSON.stringify(mutated));
      removed.materials = removed.materials.filter(x => x.id !== keyBefore);
      state.overrides['/js/papers.js'] = papersJs(removed);
      await page.reload();
      await page.waitForTimeout(600);
      p = await probe(page, 'material', keyBefore);
      check('S4 删除目标后旧链接不串项（无选中 + 有提示）',
        p.keyMatched === 0 && p.markedCount === 0 && p.notices.length > 0,
        JSON.stringify({ keyMatched: p.keyMatched, marked: p.markedCount, notices: p.notices.length }));

      // 恢复数据，论文侧同样验证一次"重排后仍命中"
      state.overrides['/js/papers.js'] = papersJs(data);
      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.waitForTimeout(500);
      const keyPaper = await getTarget(page, 'paper');
      const shuffled = JSON.parse(JSON.stringify(data));
      shuffled.papers.reverse();
      state.overrides['/js/papers.js'] = papersJs(shuffled);
      await page.reload();
      await page.waitForTimeout(500);
      p = await probe(page, 'paper', keyPaper);
      check('S5 论文重排后旧链接仍命中同一论文', !!keyPaper && p.keyMatched === 1 && p.markedKey === keyPaper,
        JSON.stringify({ keyPaper, keyMatched: p.keyMatched }));
      check('S6 全流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      state.overrides['/js/papers.js'] = papersJs(data);
      await ctx.close();
    }

    // ============================================================ D 深链基础
    {
      const { ctx, page, errors } = await newSession(browser);
      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.waitForTimeout(600);
      let p = await probe(page, 'paper', 'paper-beta');
      check('D1 论文深链精确命中', p.keyMatched === 1, JSON.stringify({ keyMatched: p.keyMatched, total: p.total }));
      check('D2 论文目标进入视口', p.visible, JSON.stringify(p.rect));
      check('D3 论文目标获得键盘焦点', p.focused, JSON.stringify({ focused: p.focused }));
      check('D4 论文目标高亮清晰', p.outlineStyle !== 'none' && p.outlineWidth >= 2,
        JSON.stringify({ style: p.outlineStyle, width: p.outlineWidth }));
      check('D5 论文自动展开', p.expanded === true && p.abstractHeight > 0,
        JSON.stringify({ expanded: p.expanded, h: p.abstractHeight }));
      check('D6 深链 hash 未被改写', p.hash.indexOf('target=paper-beta') !== -1, p.hash);

      await page.reload();
      await page.waitForTimeout(600);
      p = await probe(page, 'paper', 'paper-beta');
      check('D7 刷新后仍命中同一论文', p.keyMatched === 1 && p.visible && p.focused,
        JSON.stringify({ keyMatched: p.keyMatched, visible: p.visible, focused: p.focused }));

      await page.goto(deep('/papers?kind=material&target=lm-000002'));
      await page.waitForTimeout(600);
      p = await probe(page, 'material', 'lm-000002');
      check('D8 资料深链精确命中并切到资料页签',
        p.keyMatched === 1 && p.activeTab.indexOf('学习资料') !== -1,
        JSON.stringify({ keyMatched: p.keyMatched, tab: p.activeTab.trim() }));
      check('D9 资料目标进入视口且获得焦点', p.visible && p.focused,
        JSON.stringify({ visible: p.visible, focused: p.focused }));
      check('D10 资料目标高亮清晰', p.outlineStyle !== 'none' && p.outlineWidth >= 2,
        JSON.stringify({ style: p.outlineStyle, width: p.outlineWidth }));
      check('D11 深链流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ============================================================ 重名与特殊字符
    {
      const { ctx, page, errors, dialogs } = await newSession(browser);
      // 带 ID 的 same-name.pdf（left）
      await page.goto(deep('/papers?kind=material&target=lm-000003'));
      await page.waitForTimeout(500);
      let left = await page.evaluate(() => {
        const el = document.querySelector('.file-item[data-material-key="lm-000003"]');
        return el ? (el.querySelector('.file-path') || {}).textContent : null;
      });
      check('N1 带 ID 的重名资料命中正确条目', left === 'left', left);

      // 旧数据（无 ID）走兼容解析：从搜索结果点击，不能靠猜
      const st = await searchAndClick(page, base, 'same-name.pdf', 1);
      const legacyKey = await getTarget(page, 'material');
      const right = await subcategoryOf(page, 'material', legacyKey);
      check('N2 旧数据（无 ID）重名资料命中 right 而不是 left', right === 'right', JSON.stringify({ legacyKey: String(legacyKey).slice(0, 40), right }));
      check('N3 无 ID 数据的深链也带 target 参数', !!parseTarget(st.href) && !!parseTarget(st.href).target,
        st.href.replace(base + PREFIX + '/', ''));

      // 中文 + 特殊字符 + XSS 载荷
      await page.goto(deep('/papers?kind=paper&target=' + encodeURIComponent(SPECIAL_PAPER)));
      await page.waitForTimeout(600);
      const sp = await probe(page, 'paper', SPECIAL_PAPER);
      check('N4 特殊字符论文 id 精确命中', sp.keyMatched === 1 && sp.visible, JSON.stringify({ m: sp.keyMatched }));
      check('N5 特殊字符标题未被解析为 HTML',
        (await page.locator('#app img[src="x"]').count()) === 0);
      check('N6 特殊字符流程无脚本异常/弹窗', errors.length === 0 && dialogs.length === 0,
        JSON.stringify({ errors: errors.slice(0, 2), dialogs }));

      await page.goto(deep('/papers?kind=material&target=' + encodeURIComponent(SPECIAL_MATERIAL)));
      await page.waitForTimeout(600);
      const sm = await probe(page, 'material', SPECIAL_MATERIAL);
      check('N7 特殊字符资料 id 精确命中', sm.keyMatched === 1 && sm.visible, JSON.stringify({ m: sm.keyMatched }));
      await ctx.close();
    }

    // ============================================================ F 降级
    {
      const { ctx, page, errors } = await newSession(browser);
      await page.goto(deep('/papers?kind=paper&target=missing-target'));
      await page.waitForTimeout(700);
      let p = await probe(page, 'paper', 'missing-target');
      check('F1 目标不存在时有提示', p.notices.length > 0, p.notices.join(' | ').slice(0, 120));
      check('F2 目标不存在时不误选任何条目', p.markedCount === 0, p.markedCount);
      check('F3 目标不存在时列表仍可浏览', p.total > 0 && p.papersPage, p.total);

      await page.goto(deep('/papers?kind=paper&target=%E0%A4%A'));
      await page.waitForTimeout(700);
      p = await probe(page, 'paper', null);
      check('F4 非法 URL 编码不抛异常且有提示', errors.length === 0 && p.notices.length > 0,
        JSON.stringify({ errors: errors.slice(0, 2), notices: p.notices.length }));

      await page.goto(deep('/papers?kind=%ZZ&target=paper-alpha'));
      await page.waitForTimeout(600);
      p = await probe(page, 'paper', 'paper-alpha');
      check('F5 非法 kind 不影响按 target 解析', p.keyMatched === 1, JSON.stringify({ m: p.keyMatched }));

      // 旧路由兼容
      await page.goto(deep('/papers'));
      await page.waitForTimeout(500);
      p = await probe(page, 'paper', null);
      check('F6 旧 #/papers 路由仍正常且无高亮', p.total > 0 && p.markedCount === 0 && p.notices.length === 0,
        JSON.stringify({ total: p.total, marked: p.markedCount }));

      // 数据加载失败 → 重试
      // 必须先落在一个正常页面再 reload：同文档 hash 切换不会重新请求 papers.js，
      // 只有新文档才会走到"按需加载失败"的分支。
      state.faults['/js/papers.js'] = 500;
      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.reload();
      await page.waitForTimeout(900);
      const failText = await page.locator('#app').innerText();
      check('F7 数据加载失败有明确提示', /加载失败|重试/.test(failText), failText.replace(/\s+/g, ' ').slice(0, 100));
      state.faults = {};
      const retry = page.locator('[data-retry-data]');
      const hasRetry = await retry.count();
      if (hasRetry) await retry.first().click();
      else await page.reload();
      await page.waitForTimeout(1200);
      p = await probe(page, 'paper', 'paper-beta');
      check('F8 故障恢复后可重试并正确定位', p.keyMatched === 1 && p.markedCount === 1,
        JSON.stringify({ keyMatched: p.keyMatched, hasRetry }));
      check('F9 降级流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ============================================================ R 路由竞争
    {
      const { ctx, page, errors } = await newSession(browser);
      state.delays['/js/papers.js'] = 1200;
      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.waitForTimeout(120);
      await page.evaluate(() => { location.hash = '#/courses'; });
      await page.waitForTimeout(1800);
      const r1 = await page.evaluate(() => ({
        hash: location.hash,
        papers: !!document.querySelector('.papers-page'),
        courses: !!document.querySelector('#app').textContent.match(/课程/)
      }));
      check('R1 慢网下切走路由后旧渲染不得覆盖当前页', !r1.papers && r1.hash === '#/courses', JSON.stringify(r1));

      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.waitForTimeout(120);
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForTimeout(1800);
      const r2 = await page.evaluate(() => ({
        hash: location.hash,
        papers: !!document.querySelector('.papers-page'),
        home: !!document.querySelector('#app .article-list, #app .article-card')
      }));
      check('R2 慢网下回首页后旧深链不得覆盖首页', !r2.papers && r2.hash === '#/', JSON.stringify(r2));

      // 两个深链快速切换：最终只能是后者
      await page.goto(deep('/papers?kind=material&target=lm-000001'));
      await page.waitForTimeout(100);
      await page.evaluate(() => { location.hash = '#/papers?kind=material&target=lm-000002'; });
      await page.waitForTimeout(2000);
      const r3 = await probe(page, 'material', 'lm-000002');
      const oldMarked = await page.evaluate(() =>
        !!document.querySelector('.file-item[data-material-key="lm-000001"]:not([aria-current="true"])') &&
        !!document.querySelector('.file-item[data-material-key="lm-000001"]').className.match(/target|highlight|selected|focused/));
      check('R3 快速切换深链只有最后一个目标被标记', r3.keyMatched === 1 && r3.markedKey === 'lm-000002' && !oldMarked,
        JSON.stringify({ marked: r3.markedKey, oldMarked }));
      check('R4 路由竞争流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      state.delays = {};
      await ctx.close();
    }

    // ============================================================ V 视口
    for (const vp of [{ name: '390x844', width: 390, height: 844 }, { name: '1280x800', width: 1280, height: 800 }]) {
      const { ctx, page } = await newSession(browser, { viewport: { width: vp.width, height: vp.height } });
      await page.goto(deep('/papers?kind=paper&target=paper-beta'));
      await page.waitForTimeout(700);
      let p = await probe(page, 'paper', 'paper-beta');
      check('V1 ' + vp.name + ' 论文目标进入视口并聚焦', p.visible && p.focused,
        JSON.stringify({ visible: p.visible, focused: p.focused, rect: p.rect }));

      // 目标在长列表深处（填充论文把目标推到下方）→ 必须真实滚动
      await page.goto(deep('/papers?kind=material&target=lm-000002'));
      await page.waitForTimeout(700);
      p = await probe(page, 'material', 'lm-000002');
      check('V2 ' + vp.name + ' 资料目标进入视口并聚焦', p.visible && p.focused,
        JSON.stringify({ visible: p.visible, focused: p.focused, scrollY: p.scrollY }));
      await ctx.close();
    }

    // 长列表：目标位于资料区深处
    {
      const longData = JSON.parse(JSON.stringify(data));
      longData.materials.push(Object.assign({}, longData.materials[1], { id: 'lm-000777', name: '深处资料.pdf', subcategory: 'deep' }));
      longData.materials.reverse();
      state.overrides['/js/papers.js'] = papersJs(longData);
      const { ctx, page } = await newSession(browser);
      await page.goto(deep('/papers?kind=material&target=lm-000777'));
      await page.waitForTimeout(700);
      const p = await probe(page, 'material', 'lm-000777');
      check('V3 长列表深处目标被真实滚动进视口', p.keyMatched === 1 && p.visible && p.scrollY > 0,
        JSON.stringify({ visible: p.visible, scrollY: p.scrollY, rect: p.rect }));
      await ctx.close();
      state.overrides['/js/papers.js'] = papersJs(data);
    }

    // ============================================================ H 历史 / 搜索状态
    {
      const { ctx, page, errors } = await newSession(browser);
      const st = await searchAndClick(page, base, '深链论文 Beta', 0);
      const t = parseTarget(st.href);
      check('H1 搜索结果生成的链接符合公开契约', !!t && t.kind === 'paper' && t.target === 'paper-beta',
        st.href.replace(base + PREFIX + '/', ''));

      // 复制链接：换一个全新上下文直接导航
      const { ctx: ctx2, page: page2 } = await newSession(browser);
      await page2.goto(st.href);
      await page2.waitForTimeout(600);
      const copy = await probe(page2, 'paper', 'paper-beta');
      check('H2 复制的深链在新会话中仍精确命中', copy.keyMatched === 1 && copy.visible && copy.focused,
        JSON.stringify({ m: copy.keyMatched, focused: copy.focused }));
      await ctx2.close();

      // 后退到首页 → 恢复原搜索上下文
      await page.goBack();
      await page.waitForTimeout(700);
      const back = await page.evaluate(() => ({
        hash: location.hash,
        value: (document.getElementById('searchInput') || {}).value,
        results: document.querySelectorAll('.search-results-count').length
      }));
      check('H3 后退返回搜索页并恢复原搜索词', back.value === '深链论文 Beta' && back.results === 1,
        JSON.stringify(back));

      // 前进回到深链
      await page.goForward();
      await page.waitForTimeout(700);
      const fwd = await probe(page, 'paper', 'paper-beta');
      check('H4 前进回到深链并重新定位', fwd.keyMatched === 1 && fwd.markedKey === 'paper-beta',
        JSON.stringify({ m: fwd.keyMatched, marked: fwd.markedKey }));

      // 深链页点导航“首页”= 主动开始新浏览 → 清空搜索词
      await page.click('.nav-link[data-route="/"]');
      await page.waitForTimeout(700);
      const home = await page.evaluate(() => ({
        hash: location.hash,
        value: (document.getElementById('searchInput') || {}).value,
        results: document.querySelectorAll('.search-results-count').length,
        cards: document.querySelectorAll('#app .article-card').length
      }));
      check('H5 主动点首页清空搜索词且无旧结果', home.value === '' && home.results === 0 && home.hash === '#/',
        JSON.stringify(home));
      check('H6 历史导航流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // 旧异步搜索回调不得覆盖当前路由
    {
      const { ctx, page, errors } = await newSession(browser);
      state.delays['/js/papers.js'] = 1000;
      await page.goto(base + PREFIX + '/#/');
      await page.waitForTimeout(300);
      await page.locator('#searchInput').fill('切页');
      await page.waitForTimeout(200);
      await page.evaluate(() => { location.hash = '#/courses'; });
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => ({
        hash: location.hash,
        results: document.querySelectorAll('.search-results-count').length,
        papers: !!document.querySelector('.papers-page')
      }));
      check('H7 慢网下旧搜索回调不覆盖当前路由', st.hash === '#/courses' && st.results === 0 && !st.papers,
        JSON.stringify(st));
      check('H8 搜索竞争流程无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
      state.delays = {};
      await ctx.close();
    }

    // ============================================================ W Service Worker
    {
      const { ctx, page, errors } = await newSession(browser, { sw: true });
      await page.goto(deep('/papers?kind=paper&target=paper-beta'), { waitUntil: 'load', timeout: 60000 });
      const controlled = await waitController(page);
      await sleep(1200);
      await page.goto(deep('/papers?kind=material&target=lm-000002'), { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(800);
      const p = await probe(page, 'material', 'lm-000002');
      check('W1 SW 接管后资料深链仍精确命中', controlled && p.keyMatched === 1 && p.markedKey === 'lm-000002',
        JSON.stringify({ controlled, marked: p.markedKey }));

      // 慢网 SW 升级：新版本代码必须真正生效，深链仍要命中
      const appSrc = fs.readFileSync(path.join(SITE_ROOT, 'js', 'app.js'), 'utf8');
      state.overrides['/js/app.js'] = appSrc + '\nwindow.__b7b2Build = "v2";\n';
      state.swBump = true;
      state.delays['/js/app.js'] = 700;
      state.delays['/index.html'] = 250;
      await page.goto(deep('/papers?kind=paper&target=paper-beta'), { waitUntil: 'load', timeout: 60000 });
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r && r.update && r.update()));
      await sleep(3000);
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(900);
      const up = await page.evaluate(() => ({
        build: window.__b7b2Build || null,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
      }));
      const upProbe = await probe(page, 'paper', 'paper-beta');
      check('W2 慢网 SW 升级后新代码生效', up.controlled && up.build === 'v2', JSON.stringify(up));
      check('W3 升级后深链仍精确命中', upProbe.keyMatched === 1 && upProbe.markedKey === 'paper-beta',
        JSON.stringify({ matched: upProbe.keyMatched, marked: upProbe.markedKey }));
      check('W4 SW 场景无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));

      delete state.overrides['/js/app.js'];
      state.swBump = false;
      state.delays = {};
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({
    results, evidence,
    meta: { channel: CHANNEL, viewports: ['1280x800', '390x844'], generatedAt: new Date().toISOString() }
  }, null, 2), 'utf8');

  const failed = results.filter(r => !r.ok);
  console.log('\n共 ' + results.length + ' 项，PASS ' + pass + '，FAIL ' + fail);
  console.log('证据: ' + path.relative(ROOT, EVIDENCE));
  if (failed.length) {
    console.log('失败项：\n  - ' + failed.map(f => f.name + (f.extra ? '  (' + f.extra + ')' : '')).join('\n  - '));
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SPEC ERROR:', e); process.exit(1); });
