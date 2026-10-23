// B3-04 / B3-05 回归测试：首页排序一致性 + 日期时区安全
// 分别以 Asia/Shanghai、America/New_York、Europe/London 三个 TZ 各跑一遍。
// 父进程只负责按 TZ 自我复制并汇总子进程结果。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.B3_PORT || 8137);
const TZS = ['Asia/Shanghai', 'America/New_York', 'Europe/London'];

// ---------- 父进程：按 TZ 自我复制 ----------
if (!process.env.B3_TZ) {
  let fail = 0;
  let total = 0;
  TZS.forEach((tz, idx) => {
    const r = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { TZ: tz, B3_TZ: tz, B3_PORT: String(PORT + idx) }),
      encoding: 'utf8'
    });
    const out = (r.stdout || '').trim();
    out.split(/\r?\n/).filter(Boolean).forEach(line => {
      if (/^(PASS|FAIL) /.test(line)) total++;
      if (/^FAIL /.test(line)) fail++;
      console.log('[' + tz + '] ' + line);
    });
    if (r.status !== 0 && !/HAS FAILURES/.test(out)) {
      fail++;
      console.log('[' + tz + '] FAIL 子进程异常退出 ' + r.status + ' ' + (r.stderr || '').slice(0, 200));
    }
  });
  console.log('\n共 ' + total + ' 项，' + (fail ? 'HAS FAILURES (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
}

// ---------- 子进程：固定 TZ 下执行断言 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = true;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) pass = false;
};

server.listen(PORT, async () => {
  try {
    const vc = new VirtualConsole();
    const errors = [];
    vc.on('jsdomError', e => {
      if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
    });
    const dom = await JSDOM.fromURL('http://localhost:' + PORT + '/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    await new Promise(r => window.addEventListener('load', r));
    await wait(400);

    // ---------- B3-05 日期时区 ----------
    const fmt = window.eval(`(function(){
      return {
        d1: formatDate('2026-08-09'),
        d2: formatDate('2026-01-01'),
        d3: formatDate('2026-12-31'),
        ts: formatDate('2026-08-09T23:30:00'),
        tsUtc: formatDate('2026-08-09T23:30:00Z')
      };
    })()`);
    // 站点既有格式为「2026年八月9日」（月份用中文名，日不补零）
    check('D1 2026-08-09 显示为 八月9日', fmt.d1 === '2026年八月9日', fmt.d1);
    check('D2 2026-01-01 跨年边界不偏移', fmt.d2 === '2026年一月1日', fmt.d2);
    check('D3 2026-12-31 显示为 十二月31日', fmt.d3 === '2026年十二月31日', fmt.d3);
    check('D4 本地时间戳语义保持不变', fmt.ts === '2026年八月9日', fmt.ts);
    // 带 Z 的完整时间戳仍按既有语义（本地时区换算），因此只校验不抛错且日期合法
    check('D5 UTC 时间戳仍走本地换算', /^2026年(八月|九月)(9|10)日$/.test(fmt.tsUtc), fmt.tsUtc);

    // ---------- B3-04 排序一致性 ----------
    const order = window.eval(`(function(){
      var all = getAllPosts();
      var dates = all.map(function(p){ return p.date; });
      var homeHtml = renderHome();
      var tmp = document.createElement('div');
      tmp.innerHTML = homeHtml;
      var homeIds = Array.prototype.map.call(tmp.querySelectorAll('.article-card'),
        function(el){ return el.getAttribute('data-href').replace('#/post/', ''); });
      var arch = document.createElement('div');
      arch.innerHTML = renderArchive();
      var archiveIds = Array.prototype.map.call(arch.querySelectorAll('.archive-title'),
        function(a){ return a.getAttribute('href').replace('#/post/', ''); });
      return {
        dates: dates,
        ids: all.map(function(p){ return p.id; }),
        homeIds: homeIds,
        archiveIds: archiveIds
      };
    })()`);

    const nonIncreasing = order.dates.every((d, i) => i === 0 || order.dates[i - 1] >= d);
    check('O1 getAllPosts 按日期倒序', nonIncreasing, order.dates.slice(0, 3).join(','));

    check('O2 首页顺序与归档一致',
      order.homeIds.join('|') === order.archiveIds.join('|'),
      'home=' + order.homeIds.slice(0, 3).join(',') + ' / archive=' + order.archiveIds.slice(0, 3).join(','));

    check('O3 首页覆盖全部文章', order.homeIds.length === order.ids.length,
      order.homeIds.length + '/' + order.ids.length);

    // 同日文章保持数据源原顺序（稳定排序）
    const tie = window.eval(`(function(){
      var raw = (typeof USER_POSTS !== 'undefined') ? POSTS.concat(USER_POSTS) : POSTS.slice();
      var byDate = {};
      raw.forEach(function(p){ (byDate[p.date] = byDate[p.date] || []).push(p.id); });
      var dup = Object.keys(byDate).filter(function(k){ return byDate[k].length > 1; });
      if (!dup.length) return { ok: true, note: 'no ties' };
      var d = dup[0];
      var sorted = getAllPosts().filter(function(p){ return p.date === d; }).map(function(p){ return p.id; });
      return { ok: sorted.join('|') === byDate[d].join('|'), note: d + ': ' + sorted.join(',') + ' vs ' + byDate[d].join(',') };
    })()`);
    check('O4 同日文章顺序稳定', tie.ok, tie.note);

    // 上下篇导航与日期顺序一致
    const nav = window.eval(`(function(){
      var all = getAllPosts();
      if (all.length < 3) return { ok: true, note: 'too few posts' };
      var mid = all[1];
      var html = renderPostNav(mid);
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var links = Array.prototype.map.call(tmp.querySelectorAll('.post-nav-item[href]'),
        function(a){ return a.getAttribute('href').replace('#/post/', ''); });
      return { ok: links[0] === all[0].id && links[1] === all[2].id,
               note: 'prev=' + links[0] + ' next=' + links[1] + ' expect=' + all[0].id + ',' + all[2].id };
    })()`);
    check('O5 上一篇/下一篇按日期顺序', nav.ok, nav.note);

    const before = window.eval('POSTS.length');
    window.eval('renderHome(); renderArchive(); getAllPosts();');
    const after = window.eval('POSTS.length');
    check('O6 不修改原始文章数组', before === after, before + ' -> ' + after);

    // app.js 是 SW 预缓存资源：改动后必须递增缓存版本，否则老访客拿不到修复
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const verMatch = /const CACHE_VERSION = '([^']+)'/.exec(swSrc);
    check('S1 SW 缓存版本已随 app.js 递增',
      !!verMatch && verMatch[1] >= '2026-10-23-3', verMatch && verMatch[1]);
    check('S2 app.js 仍在预缓存清单内',
      /\.\/js\/app\.js/.test(swSrc));

    check('O7 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    dom.window.close();
  } catch (e) {
    console.error('SMOKE ERROR:', e && e.stack || e);
    pass = false;
  }

  console.log(pass ? 'ALL PASS' : 'HAS FAILURES');
  server.close();
  process.exit(pass ? 0 : 1);
});
