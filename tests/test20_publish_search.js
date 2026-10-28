// Batch 6C：文章发布 / 搜索 / 正文按需加载的一致性回归
//
// 覆盖：
//   P1 正常发布新文章 → 首页与全文搜索都能发现
//   P2 修改文章正文 → 搜索结果跟着更新（旧关键词不再命中）
//   P3 删除文章 → 首页/搜索不再出现（不长期保留过期结果）
//   P4 发布失败 → 编辑内容留在草稿里（不丢稿）
//   P5 静态文章正文按需加载 + 快速切换不显示上一篇
//
// 全程使用模拟的 GitHub Contents API 与本地静态服务器，不访问真实网络/Token。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8136;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};

const state = { delay: {}, faults: {}, hits: {} };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  state.hits[p] = (state.hits[p] || 0) + 1;
  if (state.faults[p]) { res.writeHead(state.faults[p]); res.end('injected'); return; }
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const body = fs.readFileSync(file);
  const send = () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  };
  const delay = state.delay[p] || 0;
  if (delay) setTimeout(send, delay); else send();
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// 只允许本地测试服务器：第三方脚本（giscus）不发真实请求，返回一个空响应。
// 为什么需要它：GISCUS_CONFIG.enabled 为 true，进入文章路由会注入 https://giscus.app/client.js，
// jsdom 会真的去拉；该脚本在 jsdom 里抛 ResizeObserver is not defined，
// 于是 "P5 无脚本错误" 只在能连外网的 Linux CI 上失败、本机拉取失败时不失败。
// 注意：这不是忽略脚本错误——页面自身的同源资源照常加载，真实脚本异常照常收集与断言。
function createResourceRecorder() {
  return { loaded: [], blocked: [] };
}

function resourcesFor(base, recorder) {
  return {
    interceptors: [
      requestInterceptor(async (request) => {
        const url = String(request.url);
        if (url.indexOf(base) === 0) {
          recorder.loaded.push(url);
          return undefined;               // 同源：放行，走真实 HTTP
        }
        recorder.blocked.push(url);
        // 第三方：不发请求，给一个空响应（脚本元素需要 JS MIME，避免被当成解析错误）
        return new Response('/* blocked by test20 */', {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' }
        });
      })
    ]
  };
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
};

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// 只模拟 GitHub API；同源静态资源（正文 .md、搜索语料）仍走真实 XHR，
// 否则会把 data/search-index.json 也 mock 掉，测不出真实的搜索链路。
function xhrGet(window, url) {
  return new Promise((resolve, reject) => {
    const x = new window.XMLHttpRequest();
    x.onload = () => resolve({
      ok: x.status >= 200 && x.status < 300,
      status: x.status,
      text: () => Promise.resolve(x.responseText),
      json: () => Promise.resolve(JSON.parse(x.responseText))
    });
    x.onerror = () => reject(new TypeError('network error: ' + url));
    x.open('GET', url, true);
    x.send();
  });
}

function makeFetch(mock, window) {
  return function (url, init) {
    if (String(url).indexOf('api.github.com') === -1) return xhrGet(window, String(url));
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (mock.getMode === 'http500') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ message: 'boom' }), text: () => Promise.resolve('boom') });
      }
      if (mock.getMode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ sha: 'sha-1', content: b64('const USER_POSTS = ' + JSON.stringify(mock.posts || [], null, 2) + ';\n') }),
        text: () => Promise.resolve('ok')
      });
    }
    mock.puts = mock.puts || [];
    mock.puts.push({ url: url, body: init.body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: { sha: 'sha-2' } }), text: () => Promise.resolve('ok') });
  };
}

async function openPage(hash) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  const loader = createResourceRecorder();
  const dom = await JSDOM.fromURL(BASE + '/index.html' + (hash || ''), {
    runScripts: 'dangerously', resources: resourcesFor(BASE, loader), pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(400);
  return { dom, window: dom.window, doc: dom.window.document, errors, loader };
}

function fillEditor(doc, title, content) {
  doc.getElementById('editorTitle').value = title;
  // 摘要单独给固定值：让"正文关键词"只能通过 content 命中，便于判断修改正文后结果是否更新
  doc.getElementById('editorExcerpt').value = '摘要：与正文关键词无关。';
  doc.getElementById('editorContent').value = content;
}

async function publish(window, doc, title, content) {
  // 模拟"已配置 Token"：不访问真实 GitHub
  window.sessionStorage.setItem('gh_token', 'fake-token');
  window.localStorage.setItem('gh_owner', 'demo');
  window.localStorage.setItem('gh_repo', 'demo-blog');
  window.location.hash = '#/editor';
  await wait(300);
  fillEditor(doc, title, content);
  await window.publishPost();
  await wait(120);
}

function appText(doc) { return doc.getElementById('app').textContent; }

// 搜索框每次重绘都会被替换，必须现取现用
async function typeSearch(doc, window, text, waitMs) {
  const input = doc.getElementById('searchInput');
  input.focus();
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(waitMs || 900);
}

(function main() {
  server.listen(PORT, async () => {
    try {
      // ------------------------------------------------ P1/P2/P3 发布 → 搜索 → 修改 → 删除
      {
        const mock = { getMode: 'ok', posts: [], puts: [] };
        const { dom, window, doc, errors, loader } = await openPage('#/editor');
        window.fetch = makeFetch(mock, window);

        await publish(window, doc, '发布一致性测试文章', '# 发布一致性测试\n\n正文里有唯一词：蓝鲸螺栓校准。\n');
        check('P1 发布后 USER_POSTS 增加一篇', window.eval('USER_POSTS.length') === 1, window.eval('USER_POSTS.length'));
        check('P1 发布请求只 PUT 一次', (mock.puts || []).length === 1);

        window.location.hash = '#/';
        await wait(300);
        check('P1 首页出现新文章标题', /发布一致性测试文章/.test(appText(doc)));

        // 全文搜索：首次搜索会加载 search-index.json（静态文章正文语料）
        await typeSearch(doc, window, '蓝鲸螺栓校准', 1200);
        check('P1 全文搜索能找到新文章（用户文章正文可搜）', /发布一致性测试文章/.test(appText(doc)), appText(doc).trim().slice(0, 60));

        await typeSearch(doc, window, '卡尔曼', 900);
        check('P1 静态文章正文检索未被破坏（卡尔曼仍命中）', /找到\s*[1-9]\d*\s*条/.test(appText(doc)), appText(doc).trim().slice(0, 40));

        // P2 修改正文 → 旧关键词失效、新关键词命中
        window.eval("USER_POSTS[0].content = '# 发布一致性测试\\n\\n正文里有唯一词：海豚垫片复位。\\n'");
        await typeSearch(doc, window, '蓝鲸螺栓校准', 800);
        check('P2 修改后旧关键词不再命中', !/发布一致性测试文章/.test(appText(doc)), appText(doc).trim().slice(0, 40));

        await typeSearch(doc, window, '海豚垫片复位', 800);
        check('P2 修改后新关键词命中', /发布一致性测试文章/.test(appText(doc)), appText(doc).trim().slice(0, 40));

        // P3 删除 → 首页与搜索都不再出现
        window.eval('USER_POSTS.splice(0, 1)');
        await typeSearch(doc, window, '海豚垫片复位', 800);
        check('P3 删除后搜索不再返回该文', !/发布一致性测试文章/.test(appText(doc)), appText(doc).trim().slice(0, 40));
        const esc = doc.getElementById('searchInput');
        if (esc) esc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(300);
        check('P3 删除后首页列表不再出现', !/发布一致性测试文章/.test(appText(doc)));

        const extLoaded = loader.loaded.filter(u => u.indexOf(BASE) !== 0);
        check('P1–P3 未加载任何第三方资源', extLoaded.length === 0, extLoaded.slice(0, 2).join(',') || '0 个');
        check('P1–P3 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
        dom.window.close();
      }

      // ------------------------------------------------ P4 发布失败保留草稿
      {
        const mock = { getMode: 'http500', posts: [], puts: [] };
        const { dom, window, doc } = await openPage('#/editor');
        window.fetch = makeFetch(mock, window);
        await publish(window, doc, '会失败的发布', '# 失败也要保住草稿\n\n这段内容不能丢。\n');
        const draftRaw = window.localStorage.getItem('blog_draft');
        check('P4 发布失败时未发出 PUT', (mock.puts || []).length === 0);
        check('P4 发布失败后草稿仍在', !!draftRaw && /失败也要保住草稿/.test(draftRaw || ''), draftRaw ? draftRaw.slice(0, 40) : 'null');
        check('P4 发布失败提示可见', /发布失败/.test(doc.getElementById('editorStatus').textContent));
        dom.window.close();
      }

      // ------------------------------------------------ P5 正文按需加载 + 快速切换
      {
        const first = 'embodied-ai-notes';
        const second = 'vla-model-intro';
        const firstBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', first + '.md'), 'utf8');
        const secondBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', second + '.md'), 'utf8');
        const pickMark = (body) => {
          const mid = Math.floor(body.length / 2);
          return body.slice(mid, mid + 24).replace(/\s+/g, '');
        };
        const firstMark = pickMark(firstBody);
        const secondMark = pickMark(secondBody);

        state.delay['/data/posts/' + first + '.md'] = 600;   // 第一篇慢
        const { dom, window, doc, errors, loader } = await openPage('#/');
        window.location.hash = '#/post/' + first;
        await wait(120);                                      // 还在加载第一篇
        const loadingShown = /正在加载文章正文/.test(appText(doc));
        window.location.hash = '#/post/' + second;            // 立刻切到第二篇
        await wait(1200);

        const text = appText(doc).replace(/\s+/g, '');
        check('P5 首次进入文章时先显示加载态', loadingShown);
        check('P5 慢文章未加载完时切走，最终显示的是第二篇', text.indexOf(secondMark) !== -1 && text.indexOf(firstMark) === -1,
          text.slice(0, 60));
        check('P5 第一篇正文请求确实发生（延迟生效）', (state.hits['/data/posts/' + first + '.md'] || 0) >= 1,
          state.hits['/data/posts/' + first + '.md'] || 0);

        delete state.delay['/data/posts/' + first + '.md'];
        window.location.hash = '#/post/' + first;
        await wait(900);
        const text2 = appText(doc).replace(/\s+/g, '');
        check('P5 再进入第一篇仍能正常渲染', text2.indexOf(firstMark) !== -1, text2.slice(0, 60));
        const extLoaded5 = loader.loaded.filter(u => u.indexOf(BASE) !== 0);
        const nonGiscus = loader.blocked.filter(u => u.indexOf('https://giscus.app/') !== 0);
        check('P5 未加载任何第三方资源（全部同源）', extLoaded5.length === 0, extLoaded5.slice(0, 2).join(',') || '0 个');
        check('P5 被拦截的外部请求只来自 giscus（保留因果链证据）',
          nonGiscus.length === 0, '拦截 ' + loader.blocked.length + ' 个: ' + loader.blocked.slice(0, 2).join(', '));
        check('P5 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
        dom.window.close();
      }
    } catch (e) {
      console.error('SPEC ERROR:', e && e.stack || e);
      fail++;
    } finally {
      server.close();
      console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
      if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
      process.exit(fail ? 1 : 0);
    }
  });
})();
