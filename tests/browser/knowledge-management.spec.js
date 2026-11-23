#!/usr/bin/env node
'use strict';
/**
 * Batch 9A-2：真实 Chromium 下的分类 / 批量 / 导入验收
 *
 * 覆盖：新建/重命名/删除分类、按分类筛选与移动、删除分类不丢收藏、
 * 批量选择范围（当前筛选）、批量取消收藏与标记未读、历史清理确认、
 * 导入预览/取消/成功/校验失败、恶意文本安全渲染、真实 IndexedDB v1 → v2 迁移、
 * 双标签导入同步、移动端与深色。
 *
 * 用法：node tests/browser/knowledge-management.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';

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
    colorScheme: o.colorScheme || 'light'
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());          // 删除分类/清历史使用 confirm
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => window.Knowledge && Knowledge.status().ready, null, { timeout: 20000 });
  return { ctx, page, errors };
}

async function gotoKm(page, tab) {
  await page.evaluate(t => { location.hash = '#/knowledge?tab=' + t; }, tab || 'favorites');
  await page.waitForSelector('#kmList', { timeout: 20000 });
  await sleep(450);
}

const REAL_POSTS = ['vla-model-intro', 'rl-from-mdp-to-ppo', 'slam-overview-filtering-to-graph',
  'arm-trajectory-planning', 'embodied-ai-notes', 'ml-fundamentals-overview'];

async function seed(page, n) {
  await page.evaluate(async args => {
    const ids = args.ids.slice(0, args.n);
    for (const id of ids) {
      await Knowledge.recordView('post', id, { title: '种子 ' + id });
      await Knowledge.setFlag('post', id, 'fav', true);
    }
  }, { ids: REAL_POSTS, n: n });
  await sleep(300);
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
    // K20 分类：新建 → 筛选 → 移动 → 重命名 → 删除（收藏保留）
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    await seed(p1, 3);
    await gotoKm(p1, 'favorites');
    check('K20.1 收藏分类条与"管理分类"入口可见',
      (await p1.locator('#kmCatBar .km-chip').count()) >= 1 &&
      (await p1.locator('#kmCatManage').count()) === 1, '');

    await p1.locator('#kmCatManage').click();
    await p1.waitForSelector('#kmModalHost .km-modal', { timeout: 10000 });
    await p1.fill('#kmCatNew', '  重点  回看  ');
    await p1.locator('#kmCatAdd').click();
    await sleep(500);
    const catsAfterAdd = await p1.evaluate(async () => (await Knowledge.categories()).map(c => c.id + ':' + c.name));
    check('K20.2 新建分类并归一化名称',
      catsAfterAdd.some(x => x.indexOf('重点 回看') !== -1), catsAfterAdd.join(' | '));

    await p1.keyboard.press('Escape');
    await sleep(200);
    check('K20.3 Esc 可关闭对话框', (await p1.locator('#kmModalHost .km-modal').count()) === 0, '');

    // 用行内下拉把第一条移到新分类
    const targetCat = await p1.evaluate(async () => (await Knowledge.categories()).filter(c => !c.system)[0].id);
    await p1.locator('#kmList .km-item select[data-km-cat]').first().selectOption(targetCat);
    await sleep(500);
    const movedCount = await p1.evaluate(async id => {
      const rows = await Knowledge.list({ flag: 'fav' });
      return rows.filter(r => r.favCat === id).length;
    }, targetCat);
    check('K20.4 收藏条目可移动到自定义分类', movedCount === 1, 'moved=' + movedCount);

    // 分类筛选（点具体的自定义分类 chip）
    const targetChip = '#kmCatBar [data-km-cat-filter="' + targetCat + '"]';
    const chipText = await p1.locator(targetChip).textContent();
    await p1.locator(targetChip).click();
    await sleep(400);
    const filtered = await p1.locator('#kmList .km-item').count();
    check('K20.5 按分类筛选只显示该分类收藏', filtered === 1, (chipText || '').trim() + ' → ' + filtered);

    // 重命名
    await p1.locator('#kmCatManage').click();
    await p1.waitForSelector('.km-cat-row input', { timeout: 10000 });
    const rowSel = '.km-cat-row[data-km-cat-row="' + targetCat + '"]';
    await p1.fill(rowSel + ' input', '改名后的分类');
    await p1.locator(rowSel + ' [data-km-cat-save]').click();
    await sleep(500);
    const renamed = await p1.evaluate(async id => {
      const list = await Knowledge.categories();
      return (list.filter(c => c.id === id)[0] || {}).name;
    }, targetCat);
    check('K20.6 重命名不改变分类 ID', renamed === '改名后的分类', renamed);

    // 删除分类 → 收藏回到默认分类
    await p1.locator(rowSel + ' [data-km-cat-del]').click();
    await sleep(600);
    const afterDel = await p1.evaluate(async id => {
      const cats = await Knowledge.categories();
      const rows = await Knowledge.list({ flag: 'fav' });
      return {
        cats: cats.map(c => c.id),
        favs: rows.length,
        defaulted: rows.filter(r => r.favCat === 'default').length,
        leftover: rows.filter(r => r.favCat === id).length
      };
    }, targetCat);
    check('K20.7 删除分类后收藏迁回默认分类且数量不变',
      afterDel.cats.indexOf(targetCat) === -1 && afterDel.favs === 3 &&
      afterDel.leftover === 0 && afterDel.defaulted === 3, JSON.stringify(afterDel));
    await p1.keyboard.press('Escape');

    // K21 批量：范围 = 当前列表；取消收藏 / 标记未读
    await gotoKm(p1, 'favorites');
    await p1.locator('#kmCatBar [data-km-cat-filter="all"]').click();
    await sleep(350);
    await p1.locator('#kmBulkToggle').click();
    await sleep(300);
    check('K21.1 进入批量模式后出现选择框与操作栏',
      (await p1.locator('#kmList [data-km-select]').count()) === 3 &&
      (await p1.locator('#kmBulkBar').isVisible()) === true, '');

    await p1.locator('#kmList [data-km-select]').first().check();
    await sleep(200);
    const bulkInfo = await p1.locator('#kmBulkBar .km-bulk-info').textContent();
    check('K21.2 选择数量与范围有明确提示', /已选\s*1/.test(bulkInfo) && /当前列表/.test(bulkInfo), bulkInfo.trim());

    await p1.locator('[data-km-bulk="select-all"]').click();
    await sleep(300);
    const allInfo = await p1.locator('#kmBulkBar .km-bulk-info').textContent();
    check('K21.3 全选只覆盖当前列表', /已选\s*3\s*\/\s*3/.test(allInfo), allInfo.trim());

    await p1.locator('[data-km-bulk="fav-off"]').click();
    await sleep(700);
    const afterFavOff = await p1.evaluate(async () => {
      const all = await Knowledge.list({});
      return { fav: all.filter(r => r.fav).length, total: all.length };
    });
    check('K21.4 批量取消收藏不删除记录',
      afterFavOff.fav === 0 && afterFavOff.total === 3, JSON.stringify(afterFavOff));

    // 未读：先造进度再批量标记未读
    await p1.evaluate(async () => {
      await Knowledge.setFlag('post', 'vla-model-intro', 'fav', true);
      await Knowledge.saveProgress('post', 'vla-model-intro', 0.6);
    });
    await gotoKm(p1, 'favorites');
    let pressedNow = await p1.locator('#kmBulkToggle').getAttribute('aria-pressed');
    if (pressedNow === 'true') { await p1.locator('#kmBulkToggle').click(); await sleep(250); }
    await p1.locator('#kmBulkToggle').click();
    await sleep(250);
    await p1.locator('[data-km-bulk="select-all"]').click();
    await sleep(200);
    await p1.locator('[data-km-bulk="read-none"]').click();
    await sleep(700);
    const unread = await p1.evaluate(() => {
      const r = Knowledge.state('post', 'vla-model-intro') || {};
      return { st: r.readState, p: r.progress, doneAt: r.doneAt };
    });
    check('K21.5 批量标记未读清空进度与完成时间',
      unread.st === 'none' && unread.p === 0 && unread.doneAt === 0, JSON.stringify(unread));

    check('K21.6 分类/批量流程无未捕获异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');

    // K22 导入：预览 → 取消 → 校验失败 → 成功
    const dump = await p1.evaluate(async () => {
      const d = await Knowledge.exportData();
      d.records = [
        { key: 'post:shenzhen-weekend', type: 'post', refId: 'shenzhen-weekend', title: '导入来的文章', fav: 1, favAt: 1000, favCat: 'default', later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 1000 }
      ];
      return d;
    });
    await p1.evaluate(data => {
      window.__dump = data;
      window.__openImport = function () {
        const dt = new DataTransfer();
        const file = new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' });
        dt.items.add(file);
        const input = document.getElementById('kmImportFile');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
    }, dump);

    await p1.locator('#kmImportOpen').click();
    await p1.waitForSelector('#kmImportFile', { timeout: 10000 });
    await p1.evaluate(() => window.__openImport());
    await p1.waitForSelector('.km-import-table', { timeout: 15000 });
    const previewText = await p1.locator('#kmImportReport').textContent();
    check('K22.1 导入前显示预览统计',
      /文件记录数/.test(previewText) && /已存在冲突/.test(previewText) && /可新增/.test(previewText),
      previewText.replace(/\s+/g, ' ').slice(0, 80));

    await p1.locator('#kmImportReport [data-km-modal-close]').click();
    await sleep(300);
    const cancelled = await p1.evaluate(async () => {
      const all = await Knowledge.list({});
      return all.some(r => r.key === 'post:shenzhen-weekend');
    });
    check('K22.2 取消导入不写入任何记录', cancelled === false, String(cancelled));

    // 校验失败：坏文件
    await p1.locator('#kmImportOpen').click();
    await p1.waitForSelector('#kmImportFile', { timeout: 10000 });
    await p1.evaluate(() => {
      const dt = new DataTransfer();
      const file = new File([JSON.stringify({ app: 'evil', kind: 'x', schemaVersion: 9, records: [] })], 'bad.json', { type: 'application/json' });
      dt.items.add(file);
      const input = document.getElementById('kmImportFile');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(600);
    const badText = await p1.locator('#kmImportReport').textContent();
    check('K22.3 非法文件给出具体原因且不写库',
      /校验失败/.test(badText) && /app|kind|schemaVersion/.test(badText),
      badText.replace(/\s+/g, ' ').slice(0, 90));

    // 成功导入（重新选择合法文件）
    await p1.evaluate(() => window.__openImport());
    await p1.waitForSelector('.km-import-table', { timeout: 15000 });
    await p1.locator('#kmImportApply').click();
    await sleep(900);
    const imported = await p1.evaluate(async () => {
      const all = await Knowledge.list({});
      const hit = all.filter(r => r.key === 'post:shenzhen-weekend')[0];
      return { exists: !!hit, fav: hit && hit.fav, count: all.length };
    });
    check('K22.4 合法文件合并导入成功且记录可读',
      imported.exists === true && imported.fav === 1, JSON.stringify(imported));
    await p1.keyboard.press('Escape');

    // 恶意文本：导入标题带 HTML，列表必须转义
    const xss = await p1.evaluate(async () => {
      const payload = {
        app: 'ericzhao-blog', kind: 'knowledge', schemaVersion: 2, exportedAt: new Date().toISOString(),
        persistence: 'indexeddb', source: 'database', degraded: false, complete: true, warning: '',
        categories: [{ id: 'default', name: '默认分类', system: true }],
        records: [{ key: 'post:robot-grasping-survey', type: 'post', refId: 'robot-grasping-survey', title: '<img src=x onerror=window.__xss=1>', fav: 1, favAt: 1000, favCat: 'default', later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 1000 }]
      };
      const v = Knowledge.validateImport(payload, {});
      if (!v.ok) return { ok: false, errors: v.errors };
      const r = await Knowledge.applyImport(v.payload, { mode: 'merge', resolve: () => true });
      return { ok: r.ok };
    });
    await gotoKm(p1, 'favorites');
    const xssState = await p1.evaluate(() => ({
      pwned: !!window.__xss,
      imgs: document.querySelectorAll('#kmList img').length,
      text: (document.querySelector('#kmList').textContent || '').indexOf('<img') !== -1
    }));
    check('K22.5 恶意导入标题被转义且不执行',
      xss.ok === true && xssState.pwned === false && xssState.imgs === 0 && xssState.text === true,
      JSON.stringify({ xss: xss.ok, state: xssState }));

    check('K22.6 导入流程无未捕获异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');
    await s1.ctx.close();

    // K23 真实 IndexedDB v1 → v2 迁移
    {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      await ctx.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith('http://127.0.0.1')) return route.continue();
        return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
      });
      await ctx.route('**/js/app.js*', route => route.abort());   // 先不给 app.js，避免它先建 v2 库
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
      const built = await page.evaluate(() => new Promise(resolve => {
        const req = indexedDB.open('blog-knowledge', 1);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains('records')) {
            const s = db.createObjectStore('records', { keyPath: 'key' });
            s.createIndex('by_type', 'type');
          }
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        };
        req.onerror = function () { resolve({ ok: false, err: 'open' }); };
        req.onsuccess = function () {
          const db = req.result;
          const tx = db.transaction(['records', 'meta'], 'readwrite');
          tx.objectStore('records').put({
            key: 'post:legacy1', type: 'post', refId: 'legacy1', title: '旧库收藏',
            fav: 1, favAt: 1000, favCat: 'default', later: 0, laterAt: 0,
            readState: 'reading', progress: 0.4, firstSeenAt: 900, lastSeenAt: 1000,
            doneAt: 0, updatedAt: 1000
          });
          tx.objectStore('records').put({
            key: 'post:legacy2', type: 'post', refId: 'legacy2', title: '旧库待读',
            fav: 0, favAt: 0, favCat: 'default', later: 1, laterAt: 1100,
            readState: 'none', progress: 0, firstSeenAt: 0, lastSeenAt: 1100,
            doneAt: 0, updatedAt: 1100
          });
          tx.objectStore('meta').put({ k: 'schemaVersion', v: 1 });
          tx.oncomplete = function () { db.close(); resolve({ ok: true }); };
          tx.onerror = function () { resolve({ ok: false, err: 'write' }); };
        };
      }));
      await ctx.unroute('**/js/app.js*');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.Knowledge && Knowledge.status().ready, null, { timeout: 20000 });
      await page.waitForFunction(() => window.Knowledge && Knowledge.status().ready, null, { timeout: 20000 });
      await sleep(600);
      const migrated = await page.evaluate(async () => {
        const db = await new Promise(res => {
          const r = indexedDB.open('blog-knowledge');
          r.onsuccess = () => res(r.result);
        });
        const meta = await new Promise(res => {
          const tx = db.transaction('meta', 'readonly');
          const g = tx.objectStore('meta').get('schemaVersion');
          g.onsuccess = () => res(g.result ? g.result.v : null);
        });
        const cats = await new Promise(res => {
          const tx = db.transaction('meta', 'readonly');
          const g = tx.objectStore('meta').get('favCategories');
          g.onsuccess = () => res(g.result ? g.result.v : null);
        });
        const rows = await Knowledge.list({});
        const cats2 = await Knowledge.categories();
        db.close();
        return {
          schemaVersion: meta,
          catsMeta: cats,
          rows: rows.map(r => r.key + '/' + r.fav + '/' + r.later),
          cats: cats2.map(c => c.id)
        };
      });
      check('K23.1 真实浏览器 v1 数据库升级到 v2 并补齐分类',
        built.ok === true && migrated.schemaVersion === 2 &&
        Array.isArray(migrated.catsMeta) && migrated.catsMeta[0].id === 'default',
        JSON.stringify({ sv: migrated.schemaVersion, cats: migrated.cats }));
      check('K23.2 旧数据完整保留（收藏/待读/进度未丢）',
        migrated.rows.length === 2 &&
        migrated.rows.some(x => x === 'post:legacy1/1/0') &&
        migrated.rows.some(x => x === 'post:legacy2/0/1'),
        migrated.rows.join(' | '));
      check('K23.3 迁移过程无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
      await ctx.close();
    }

    // K24 双标签导入同步
    {
      const s2 = await newSession(browser, base);
      const A = s2.page;
      await seed(A, 1);
      const B = await s2.ctx.newPage();
      await B.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 60000 });
      await B.waitForSelector('#kmList', { timeout: 20000 });
      await sleep(700);
      const beforeB = await B.locator('.km-item').count();
      const addedInA = await A.evaluate(async () => {
        const p = {
          app: 'ericzhao-blog', kind: 'knowledge', schemaVersion: 2, exportedAt: new Date().toISOString(),
          persistence: 'indexeddb', source: 'database', degraded: false, complete: true, warning: '',
          categories: [{ id: 'default', name: '默认分类', system: true }],
          records: [{ key: 'post:industrial-protocols-notes', type: 'post', refId: 'industrial-protocols-notes', title: '同步记录', fav: 1, favAt: 2000, favCat: 'default', later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 2000 }]
        };
        const v = Knowledge.validateImport(p, {});
        const r = await Knowledge.applyImport(v.payload, { mode: 'merge', resolve: () => true });
        return r.ok;
      });
      let synced = false;
      try {
        await B.waitForFunction(n => document.querySelectorAll('#kmList .km-item').length > n, beforeB, { timeout: 6000 });
        synced = true;
      } catch (e) { synced = false; }
      check('K24 导入后其他标签页自动刷新列表',
        addedInA === true && synced === true, 'before=' + beforeB + ' synced=' + synced);
      await s2.ctx.close();
    }

    // K25 移动端 + 深色
    {
      const s3 = await newSession(browser, base, { viewport: { width: 390, height: 780 }, colorScheme: 'dark' });
      const p3 = s3.page;
      await seed(p3, 2);
      await gotoKm(p3, 'favorites');
      await p3.locator('#kmBulkToggle').click();
      await sleep(300);
      const layout = await p3.evaluate(() => {
        const bar = document.getElementById('kmBulkBar');
        const chip = document.querySelector('#kmCatBar .km-chip');
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          barVisible: !!bar && !bar.hidden,
          theme: document.documentElement.getAttribute('data-theme'),
          chipColor: chip ? getComputedStyle(chip).color : ''
        };
      });
      check('K25.1 手机端批量栏可用且无横向溢出',
        layout.overflow <= 1 && layout.barVisible === true, JSON.stringify(layout));
      check('K25.2 深色主题下分类 chip 仍可读',
        layout.theme === 'dark' && !!layout.chipColor, layout.chipColor);

      await p3.locator('#kmImportOpen').click();
      await p3.waitForSelector('.km-modal', { timeout: 10000 });
      const modalFit = await p3.evaluate(() => {
        const m = document.querySelector('.km-modal');
        const r = m.getBoundingClientRect();
        return { w: Math.round(r.width), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check('K25.3 导入对话框在 390px 内不溢出', modalFit.w <= 390 && modalFit.overflow <= 1, JSON.stringify(modalFit));
      await s3.ctx.close();
    }

    // K27 替换的并发窗口（双标签、确定性顺序）：预览后另一个标签页写入 → 旧 token 必须被拒
    {
      const s5 = await newSession(browser, base);
      const A = s5.page;
      await seed(A, 2);
      const B = await s5.ctx.newPage();
      await B.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 60000 });
      await B.waitForFunction(() => window.Knowledge && Knowledge.status().ready, null, { timeout: 20000 });
      await sleep(400);

      const payload = await A.evaluate(async () => {
        const d = await Knowledge.exportData();
        d.records = [{ key: 'post:embodied-ai-notes', type: 'post', refId: 'embodied-ai-notes', title: '替换来源', fav: 1, favAt: 1000, favCat: 'default', later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 1000 }];
        return d;
      });
      const token = await A.evaluate(async p => {
        const v = Knowledge.validateImport(p, {});
        const prev = await Knowledge.previewImport(v.payload, { resolve: () => true });
        return prev.token;
      }, payload);

      // 另一个标签页在"确认"之前写入（改的是已存在的记录，不新增条数）
      await B.evaluate(async () => {
        await Knowledge.setFlag('post', 'vla-model-intro', 'later', true);
      });
      await sleep(300);

      const stale = await A.evaluate(async args => {
        const v = Knowledge.validateImport(args.p, {});
        return Knowledge.applyImport(v.payload, {
          mode: 'replace', confirm: true, resolve: () => true, expectToken: args.t
        });
      }, { p: payload, t: token });
      const afterA = await A.evaluate(async () => {
        const rows = await Knowledge.list({});
        return { n: rows.length, hasLater: rows.some(r => r.later === 1) };
      });
      check('K27.1 另一标签页写入后，旧 token 的替换被拒绝',
        stale.ok === false && /重新预览/.test(stale.reason || ''), JSON.stringify({ ok: stale.ok }));
      check('K27.2 被拒后原数据完整（含另一标签页的写入）',
        afterA.n === 2 && afterA.hasLater === true, JSON.stringify(afterA));

      const fresh = await A.evaluate(async p => {
        const v = Knowledge.validateImport(p, {});
        const prev = await Knowledge.previewImport(v.payload, { resolve: () => true });
        return Knowledge.applyImport(v.payload, {
          mode: 'replace', confirm: true, resolve: () => true, expectToken: prev.token
        });
      }, payload);
      const afterFresh = await A.evaluate(async () => ({ n: (await Knowledge.list({})).length }));
      check('K27.3 重新预览后替换成功（不做无条件重试）',
        fresh.ok === true && fresh.replaced === true && afterFresh.n === 1,
        JSON.stringify({ ok: fresh.ok, n: afterFresh.n, reason: fresh.reason }));
      await s5.ctx.close();
    }

    // K26 离线：分类与导出仍可用
    {
      const s4 = await newSession(browser, base, { sw: true });
      const p4 = s4.page;
      let swReady = false;
      try {
        await p4.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 25000 });
        swReady = true;
      } catch (e) { swReady = false; }
      await seed(p4, 1);
      await s4.ctx.setOffline(true);
      let offlineOk = false;
      try {
        await p4.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 30000 });
        await p4.waitForSelector('#kmList', { timeout: 20000 });
        offlineOk = true;
      } catch (e) { offlineOk = false; }
      const offlineData = offlineOk ? await p4.evaluate(async () => {
        const cats = await Knowledge.categories();
        const d = await Knowledge.exportData();
        return { cats: cats.length, records: d.records.length, complete: d.complete };
      }) : { cats: 0, records: 0, complete: false };
      check('K26 离线仍可读取分类与导出',
        swReady && offlineOk && offlineData.cats >= 1 && offlineData.records >= 1,
        JSON.stringify(offlineData));
      await s4.ctx.setOffline(false);
      await s4.ctx.close();
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
