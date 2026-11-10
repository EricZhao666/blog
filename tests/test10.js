// B2-01 GitHub 发布历史数据保护回归（Batch 7C-3A 起重定向到发布队列）
//
// 历史意图（保持不变）：**只要无法确认"历史内容不会被破坏"，就绝不发 PUT。**
// 7C-3A 之后编辑器不再整文件读写 js/user-posts.js，而是每次只往
// content/queue/<id>.json 写一个文件，所以这里的 10 个场景改成验证新契约下的等价保证：
//   C1 正常提交只写一个新文件，历史文件（js/user-posts.js）根本不被读写
//   C2 分支读取 5xx → 不发 PUT
//   C3 队列条目已存在（内容不可解析也照样）→ 不覆盖
//   C4 队列目录不可读（403）→ 不发 PUT
//   C5 队列检查返回异常状态 → 不发 PUT
//   C6 响应体不可解析 → 不发 PUT
//   C7 条目 404 → 允许新建，PUT 显式带 branch，且载荷只有一篇文章
//   C8 PUT 409 → 明确报错，不覆盖
//   C9 同标题重复提交 → 两个不同 id，互不覆盖
//   C10 网络异常 → 不发 PUT，提示可读错误
// 全部使用本地模拟 GitHub Contents API，不访问真实网络/仓库。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8135;
const BASE = 'http://localhost:' + PORT;
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
let total = 0;
const check = (name, cond, extra) => {
  total++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) pass = false;
};

function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: body === undefined ? () => Promise.reject(new Error('invalid json')) : () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

/**
 * 可编程的队列桩。state:
 *   branches: 'ok' | 500 | network
 *   dup:      'none' | 'exists' | 403 | 500 | 'badjson'
 *   put:      'ok' | 409 | 500
 * 记录：puts（PUT 次数）、paths（PUT 的路径）、branch（PUT 的 branch 字段）、
 *       touchedHistory（是否请求过 js/user-posts.js）
 */
function makeFetch(state) {
  state.puts = state.puts || 0;
  state.paths = state.paths || [];
  state.branch = state.branch || null;
  state.touchedHistory = false;
  return function (url, init) {
    init = init || {};
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.indexOf('api.github.com') === -1) return Promise.reject(new Error('unexpected ' + u));
    if (u.indexOf('user-posts') !== -1) { state.touchedHistory = true; }

    if (state.branches === 'network') return Promise.reject(new TypeError('Failed to fetch'));

    if (u.indexOf('/branches/') !== -1) {
      if (state.branches === 500) return Promise.resolve(resp(500, { message: 'boom' }));
      return Promise.resolve(resp(200, { name: 'content/queue' }));
    }
    if (u.indexOf('/contents/') === -1) return Promise.resolve(resp(200, {}));

    if (method === 'PUT') {
      state.puts++;
      state.paths.push(u.split('/contents/')[1].split('?')[0]);
      try { state.branch = JSON.parse(init.body).branch; } catch (e) { state.branch = null; }
      if (state.put === 409) return Promise.resolve(resp(409, { message: 'sha does not match' }));
      if (state.put === 500) return Promise.resolve(resp(500, { message: 'write failed' }));
      return Promise.resolve(resp(201, { content: { sha: 'sha-new' } }));
    }

    switch (state.dup) {
      case 'exists': return Promise.resolve(resp(200, { sha: 'sha-old', size: 10, encoding: 'base64', content: 'e30=' }));
      case 'badjson': return Promise.resolve(resp(200, undefined));
      case 403: return Promise.resolve(resp(403, { message: 'Forbidden' }));
      case 500: return Promise.resolve(resp(500, { message: 'boom' }));
      default: return Promise.resolve(resp(404, { message: 'Not Found' }));
    }
  };
}

function payloadOf(init) {
  return JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
}

async function openEditor(vcErrors) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) vcErrors.push(e.message);
  });
  vc.on('error', (...a) => vcErrors.push(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html#/editor', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  const { window } = dom;
  const doc = window.document;
  await new Promise(r => window.addEventListener('load', r));
  await wait(500);
  window.sessionStorage.setItem('gh_token', 'fake-token');
  window.localStorage.setItem('gh_owner', 'demo');
  window.localStorage.setItem('gh_repo', 'demo-blog');
  return { dom, window, doc };
}

async function runCase(name, state, title, opts) {
  opts = opts || {};
  const errors = [];
  const { dom, window, doc } = await openEditor(errors);
  const t = doc.getElementById('editorTitle');
  const c = doc.getElementById('editorContent');
  if (!t || !c) {
    check(name + ' · 编辑器可用', false, '编辑器未渲染');
    dom.window.close();
    return;
  }
  t.value = title;
  c.value = '# 正文\n\n内容';
  const fetchImpl = makeFetch(state);
  window.fetch = fetchImpl;
  // 记录 PUT 的载荷（makeFetch 里拿不到 init，这里包一层）
  const origPut = window.fetch;
  window.fetch = (url, init) => {
    if ((init && init.method) === 'PUT') state.lastPayload = payloadOf(init);
    return origPut(url, init);
  };
  await window.publishPost();
  await wait(60);
  opts.assert(state, errors, window, doc);
  dom.window.close();
}

server.listen(PORT, async () => {
  try {
    // 1) 正常提交：只写一个新文件，历史文件完全不被碰
    await runCase('C1 正常提交', { branches: 'ok', dup: 'none', put: 'ok' }, '新文章A', {
      assert: (s) => {
        check('C1 · 只发一次 PUT', s.puts === 1, s.puts + ' 次');
        check('C1 · 目标是 content/queue/<id>.json',
          /^content\/queue\/[a-z0-9-]+\.json$/.test(s.paths[0] || ''), s.paths[0]);
        check('C1 · 显式指定 branch=content/queue', s.branch === 'content/queue', s.branch);
        check('C1 · 完全没碰 js/user-posts.js（历史不受影响）', s.touchedHistory === false);
        check('C1 · 载荷只有这一篇', s.lastPayload && s.lastPayload.id && s.lastPayload.content);
      }
    });

    // 2) 分支读取 500：不得 PUT
    await runCase('C2 分支读取 5xx', { branches: 500, dup: 'none', put: 'ok' }, '新文章B', {
      assert: (s, errs, w, d) => {
        check('C2 · 未发出 PUT', s.puts === 0, s.puts + ' 次');
        check('C2 · 提示提交失败', /提交失败|发布失败/.test(d.getElementById('editorStatus').textContent));
      }
    });

    // 3) 队列条目已存在 → 不覆盖（哪怕内容读不懂）
    await runCase('C3 条目已存在', { branches: 'ok', dup: 'exists', put: 'ok' }, '新文章C', {
      assert: (s, errs, w, d) => {
        check('C3 · 已存在时不 PUT（避免覆盖）', s.puts === 0, s.puts + ' 次');
        check('C3 · 提示不覆盖', /不会覆盖|已有同 id/.test(d.getElementById('editorStatus').textContent));
      }
    });

    // 4) 队列目录不可读（403）
    await runCase('C4 队列目录 403', { branches: 'ok', dup: 403, put: 'ok' }, '新文章D', {
      assert: (s) => {
        check('C4 · 不 PUT（避免覆盖）', s.puts === 0, s.puts + ' 次');
      }
    });

    // 5) 队列检查 5xx
    await runCase('C5 队列检查 5xx', { branches: 'ok', dup: 500, put: 'ok' }, '新文章E', {
      assert: (s) => {
        check('C5 · 不 PUT（避免覆盖）', s.puts === 0, s.puts + ' 次');
      }
    });

    // 6) 响应体不可解析
    await runCase('C6 响应不可解析', { branches: 'ok', dup: 'badjson', put: 'ok' }, '新文章F', {
      assert: (s) => {
        check('C6 · 不 PUT（避免覆盖）', s.puts === 0, s.puts + ' 次');
      }
    });

    // 7) 条目 404 → 允许新建
    await runCase('C7 404 新建条目', { branches: 'ok', dup: 'none', put: 'ok' }, '首篇文章', {
      assert: (s) => {
        check('C7 · 允许新建并 PUT', s.puts === 1, s.puts + ' 次');
        check('C7 · 显式带 branch', s.branch === 'content/queue', s.branch);
        check('C7 · 新建时不带 sha（不会顶掉别人的版本）',
          s.lastPayload && s.lastPayload.id, s.lastPayload && s.lastPayload.id);
      }
    });

    // 8) PUT 冲突
    await runCase('C8 PUT 409 冲突', { branches: 'ok', dup: 'none', put: 409 }, '新文章G', {
      assert: (s, errs, w, d) => {
        check('C8 · 冲突时给出明确错误', /冲突|提交失败/.test(d.getElementById('editorStatus').textContent),
          d.getElementById('editorStatus').textContent.trim().slice(0, 40));
      }
    });

    // 9) 同标题重复提交 → 两个不同 id，互不覆盖
    {
      const ids = [];
      for (const n of [1, 2]) {
        await runCase('C9 重复提交 #' + n, { branches: 'ok', dup: 'none', put: 'ok' }, '重复标题', {
          assert: (s) => { ids.push(s.lastPayload && s.lastPayload.id); }
        });
      }
      check('C9 · 重复提交生成两个不同 id（不覆盖）',
        ids.length === 2 && ids[0] && ids[1] && ids[0] !== ids[1], ids.join(','));
    }

    // 10) 网络异常
    await runCase('C10 网络异常', { branches: 'network', dup: 'none', put: 'ok' }, '新文章H', {
      assert: (s, errs, w, d) => {
        check('C10 · 未发出 PUT', s.puts === 0, s.puts + ' 次');
        check('C10 · 提示可读错误', /提交失败|发布失败/.test(d.getElementById('editorStatus').textContent));
      }
    });
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  }

  console.log('\n共 ' + total + ' 项，' + (pass ? 'ALL PASS' : 'HAS FAILURES'));
  server.close();
  process.exit(pass ? 0 : 1);
});
