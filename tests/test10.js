// B2-01 GitHub 发布历史数据保护回归测试
// 全部使用模拟的 GitHub Contents API，不访问真实网络/仓库。
//
// 判定原则：只要 GET 阶段无法确认“历史文章完整”，就不得发出 PUT；
// 只有明确 404（文件本不存在）才允许按新建处理。
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

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const enc = obj => b64(typeof obj === 'string' ? obj : JSON.stringify(obj));

function existingFile(posts) {
  return { sha: 'sha-old', size: 800, encoding: 'base64', content: enc('const USER_POSTS = ' + JSON.stringify(posts, null, 2) + ';\n') };
}
function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

// 可编程的 GitHub 桩：记录所有 PUT，便于断言“历史是否被覆盖”
function makeFetch(state) {
  return function (url, init) {
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      state.getCount++;
      if (state.getMode === 'network_error') return Promise.reject(new TypeError('Failed to fetch'));
      if (state.getMode === 'http500') return Promise.resolve(resp(500, { message: 'Internal Server Error' }));
      if (state.getMode === '404') return Promise.resolve(resp(404, { message: 'Not Found' }));
      return Promise.resolve(resp(200, state.file));
    }
    state.puts.push(JSON.parse(init.body));
    if (state.putMode === 'conflict') return Promise.resolve(resp(409, { message: 'sha does not match' }));
    if (state.putMode === 'http500') return Promise.resolve(resp(500, { message: 'write failed' }));
    return Promise.resolve(resp(200, { content: { sha: 'sha-new' } }));
  };
}

function decodePut(body) {
  const text = Buffer.from(body.content, 'base64').toString('utf8');
  const m = text.match(/const USER_POSTS = (\[[\s\S]*\]);/);
  if (!m) throw new Error('PUT 内容不是合法 USER_POSTS 文件');
  return JSON.parse(m[1]);
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

function fillEditor(doc, title, content) {
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorContent').value = content;
}

// 场景执行器
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
  fillEditor(doc, title, '# 正文\n\n内容');
  window.fetch = makeFetch(state);
  await window.publishPost();
  await wait(50);
  opts.assert(state, errors, window, doc);
  dom.window.close();
}

const OLD = [
  { id: 'p1', title: '旧文一', date: '2026-01-01', tags: ['a'], excerpt: 'e1', content: 'c1' },
  { id: 'p2', title: '旧文二', date: '2026-02-02', tags: ['b'], excerpt: 'e2', content: 'c2' }
];

server.listen(PORT, async () => {
  try {
    // 1) 正常发布：历史 2 篇必须保留
    await runCase('C1 正常发布保留历史', { getMode: 'ok', file: existingFile(OLD), puts: [] }, '新文章A', {
      assert: (s) => {
        check('C1 · 发出 PUT', s.puts.length === 1, s.puts.length + ' 次');
        if (s.puts.length === 1) {
          const posts = decodePut(s.puts[0]);
          check('C1 · 历史文章完整保留', posts.length === 3 && posts[1].id === 'p1' && posts[2].id === 'p2',
            posts.map(p => p.id).join(','));
        } else {
          check('C1 · 历史文章完整保留', false, '未 PUT');
        }
      }
    });

    // 2) GET 500：不得 PUT
    await runCase('C2 GET 500 中止发布', { getMode: 'http500', file: null, puts: [] }, '新文章B', {
      assert: (s, errs, w, d) => {
        check('C2 · 未发出 PUT', s.puts.length === 0, s.puts.length + ' 次');
        check('C2 · 提示发布失败', /发布失败/.test(d.getElementById('editorStatus').textContent));
      }
    });

    // 3) GET 200 但文件 JSON 损坏
    await runCase('C3 原文件 JSON 损坏', {
      getMode: 'ok', puts: [],
      file: { sha: 'sha-x', size: 120, encoding: 'base64', content: enc('const USER_POSTS = [{ id: "p1", title: "旧" }, {oops}];') }
    }, '新文章C', {
      assert: (s, errs, w, d) => {
        check('C3 · 解析失败时不 PUT（避免覆盖）', s.puts.length === 0, s.puts.length + ' 次');
        check('C3 · 提示发布失败', /发布失败/.test(d.getElementById('editorStatus').textContent));
      }
    });

    // 4) GET 200 但 content 为空（模拟 >1MB / encoding=none）
    await runCase('C4 空 content（超限文件）', {
      getMode: 'ok', puts: [],
      file: { sha: 'sha-big', size: 1300000, encoding: 'none', content: '' }
    }, '新文章D', {
      assert: (s) => {
        check('C4 · 不 PUT（避免覆盖）', s.puts.length === 0, s.puts.length + ' 次');
      }
    });

    // 5) 原文件格式不符合预期（变量名/结构变了）
    await runCase('C5 原文件格式不符', {
      getMode: 'ok', puts: [],
      file: { sha: 'sha-y', size: 90, encoding: 'base64', content: enc('const LEGACY_POSTS = [{ id: "p1" }];\n') }
    }, '新文章E', {
      assert: (s) => {
        check('C5 · 不 PUT（避免覆盖）', s.puts.length === 0, s.puts.length + ' 次');
      }
    });

    // 6) Base64 无效
    await runCase('C6 Base64 无效', {
      getMode: 'ok', puts: [],
      file: { sha: 'sha-z', size: 20, encoding: 'base64', content: '!!!not-base64!!!' }
    }, '新文章F', {
      assert: (s) => {
        check('C6 · 不 PUT（避免覆盖）', s.puts.length === 0, s.puts.length + ' 次');
      }
    });

    // 7) 目标文件确不存在（404）→ 允许新建
    await runCase('C7 404 新建文件', { getMode: '404', file: null, puts: [] }, '首篇文章', {
      assert: (s) => {
        check('C7 · 允许新建并 PUT', s.puts.length === 1, s.puts.length + ' 次');
        if (s.puts.length === 1) {
          check('C7 · 新建时不带 sha', !('sha' in s.puts[0]) || s.puts[0].sha === undefined,
            JSON.stringify(s.puts[0].sha));
          const posts = decodePut(s.puts[0]);
          check('C7 · 新文件只有一篇文章', posts.length === 1, posts.length + ' 篇');
        }
      }
    });

    // 8) PUT 版本冲突
    await runCase('C8 PUT 409 冲突', {
      getMode: 'ok', file: existingFile(OLD), puts: [], putMode: 'conflict'
    }, '新文章G', {
      assert: (s, errs, w, d) => {
        check('C8 · 冲突时给出明确错误', /发布失败/.test(d.getElementById('editorStatus').textContent),
          d.getElementById('editorStatus').textContent.trim().slice(0, 40));
      }
    });

    // 9) 同一标题重复发布：不得丢历史，只新增
    await runCase('C9 重复发布同标题', { getMode: 'ok', file: existingFile(OLD), puts: [] }, '重复标题', {
      assert: (s) => {
        if (s.puts.length === 1) {
          const posts = decodePut(s.puts[0]);
          check('C9 · 重复发布不丢历史', posts.length === 3, posts.map(p => p.id).join(','));
        } else {
          check('C9 · 重复发布不丢历史', false, '未 PUT');
        }
      }
    });

    // 10) 网络异常（fetch reject）
    await runCase('C10 网络异常', { getMode: 'network_error', file: null, puts: [] }, '新文章H', {
      assert: (s, errs, w, d) => {
        check('C10 · 未发出 PUT', s.puts.length === 0, s.puts.length + ' 次');
        check('C10 · 提示可读错误', /发布失败/.test(d.getElementById('editorStatus').textContent));
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
