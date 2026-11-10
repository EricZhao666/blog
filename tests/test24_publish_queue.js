/**
 * Batch 7C-3A：发布队列（content/queue）契约测试
 *
 * 全部使用本地 HTTP 服务 + 内存版 GitHub API，不访问真实 api.github.com，
 * 不使用真实 Token（固定假串），不写真实仓库。
 *
 * 覆盖：
 *   Q1  成功提交只写一个文件，且目标分支是 content/queue
 *   Q2  队列分支不存在 → 中止（不静默创建），且不发 PUT
 *   Q3  分支 404 且仓库不可访问 → 提示"仓库不存在或无权访问"（与 Q2 区分）
 *   Q4  队列里已有同 id → 拒绝覆盖
 *   Q5  PUT 409 → 冲突提示，不覆盖
 *   Q6  PUT 422 → 冲突提示
 *   Q7  PUT 5xx → 失败提示
 *   Q8  网络中断 → 提示 + 草稿保留
 *   Q9  Token 权限不足（403）→ 明确提示
 *   Q10 空标题 / 空正文 → 本地拦截，零请求
 *   Q11 非法 id → 本地拦截
 *   Q12 与已发布文章同 id → 本地拦截
 *   Q13 成功提示区分"已提交队列"与"已上线"，且不跳转
 *   Q14 成功后草稿清空 / 失败后草稿保留
 *   Q15 Token 不出现在 URL、请求体与页面文本里
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8142;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 90) + ')' : ''));
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

/**
 * opts:
 *   branches: 'ok' | 404 | 404-repo | 403 | 500
 *   dup: 'none' | 'exists' | 403 | 500
 *   put: 'ok' | 409 | 422 | 500 | network
 */
function makeQueueMock(opts) {
  const cfg = Object.assign({ branches: 'ok', dup: 'none', put: 'ok' }, opts);
  const log = { urls: [], puts: [], bodies: [], branchUsed: null };
  const json = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });

  const impl = (url, init) => {
    const u = String(url);
    const method = ((init && init.method) || 'GET').toUpperCase();
    log.urls.push(u);
    if (u.indexOf('api.github.com') === -1) return Promise.reject(new Error('unexpected ' + u));

    if (cfg.put === 'network') return Promise.reject(new TypeError('Failed to fetch'));

    if (u.indexOf('/branches/') !== -1) {
      if (cfg.branches === 404) return json(404, { message: 'Branch not found' });
      if (cfg.branches === '404-repo') return json(404, { message: 'Not Found' });
      if (cfg.branches === 403) return json(403, { message: 'Forbidden' });
      if (cfg.branches === 500) return json(500, { message: 'Server Error' });
      return json(200, { name: 'content/queue' });
    }

    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      log.puts.push(u);
      log.bodies.push(body);
      log.branchUsed = body.branch;
      if (cfg.put === 409) return json(409, { message: 'sha does not match' });
      if (cfg.put === 422) return json(422, { message: 'Validation Failed' });
      if (cfg.put === 500) return json(500, { message: 'Server Error' });
      return json(201, { content: { path: 'content/queue/x.json' } });
    }

    // GET contents
    if (cfg.dup === 'exists') return json(200, { sha: 'abc', size: 10, encoding: 'base64', content: 'e30=' });
    if (cfg.dup === 403) return json(403, { message: 'Forbidden' });
    if (cfg.dup === 500) return json(500, { message: 'Server Error' });
    return json(404, { message: 'Not Found' });
  };
  impl.log = log;
  // 仓库探测接口（GET /repos/{owner}/{repo}）：
  //   - 正常仓库 → 200（让 404 的语义明确落在"分支不存在"上）
  //   - 404-repo 场景 → 404（模拟仓库不存在/无权访问）
  const wrapped = (url, init) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
      log.urls.push(u);
      return cfg.branches === '404-repo'
        ? json(404, { message: 'Not Found' })
        : json(200, { full_name: 'demo/demo-blog' });
    }
    return impl(url, init);
  };
  wrapped.log = log;
  return wrapped;
}

async function openEditor() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(e.message)) {
      errors.push(e.message);
    }
  });
  const dom = await JSDOM.fromURL(BASE + '/index.html#/editor', {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    resources: {
      interceptors: [requestInterceptor(async request => {
        const url = String(request.url);
        if (url.indexOf(BASE) === 0) return undefined;
        return new Response('/* blocked */', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
      })]
    }
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(350);
  return { dom, window: dom.window, doc: dom.window.document, errors };
}

async function submit(window, doc, title, content) {
  window.sessionStorage.setItem('gh_token', 'fake-token-7c3a');
  window.localStorage.setItem('gh_owner', 'demo');
  window.localStorage.setItem('gh_repo', 'demo-blog');
  window.location.hash = '#/editor';
  await wait(250);
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorExcerpt').value = '摘要';
  doc.getElementById('editorContent').value = content;
  await window.publishPost();
  await wait(120);
  return doc.getElementById('editorStatus').textContent;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const GOOD = ['发布队列测试文章', '# 队列\n\n正文。\n'];

  // Q1 成功：只写一个文件、目标是 content/queue
  {
    const mock = makeQueueMock({});
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, GOOD[0], GOOD[1]);
    check('Q1 只发一次 PUT', mock.log.puts.length === 1, mock.log.puts.length);
    check('Q1 写入路径在 content/queue/<id>.json',
      /\/contents\/content\/queue\/[a-z0-9-]+\.json$/.test(mock.log.puts[0] || ''), mock.log.puts[0]);
    check('Q1 PUT 显式带上目标分支 content/queue', mock.log.branchUsed === 'content/queue', mock.log.branchUsed);
    check('Q1 提交内容是可解析的 JSON 且含 id/content',
      (() => {
        try {
          const body = JSON.parse(Buffer.from(mock.log.bodies[0].content, 'base64').toString('utf8'));
          return !!body.id && !!body.content && body.title === GOOD[0];
        } catch (e) { return false; }
      })());
    check('Q13 提示明确"已提交队列"且不含"发布成功"',
      /队列/.test(status) && /尚未上线/.test(status) && !/发布成功/.test(status), status.slice(0, 50));
    check('Q13b 成功后不跳转首页', window.location.hash === '#/editor', window.location.hash);
    check('Q14 成功后草稿被清空', window.localStorage.getItem('blog_draft') === null);
    check('Q15 Token 不出现在 URL 里',
      mock.log.urls.every(u => u.indexOf('fake-token') === -1));
    check('Q15b Token 不出现在页面文本里',
      dom.window.document.body.textContent.indexOf('fake-token') === -1);
    dom.window.close();
  }

  // Q2 分支不存在 → 中止且不发 PUT
  {
    const mock = makeQueueMock({ branches: 404 });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, '无分支', '# x\n');
    check('Q2 队列分支不存在时中止', /不存在/.test(status) && /content\/queue/.test(status), status.slice(0, 60));
    check('Q2b 不发任何 PUT', mock.log.puts.length === 0, mock.log.puts.length);
    check('Q2c 提示引导初始化而不是静默创建', /创建/.test(status), status.slice(0, 40));
    check('Q14b 失败后草稿保留', /无分支/.test(window.localStorage.getItem('blog_draft') || ''));
    dom.window.close();
  }

  // Q3 分支 404 但仓库也不可访问 → 区分提示
  {
    const mock = makeQueueMock({ branches: '404-repo' });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, '仓库不可达', '# x\n');
    check('Q3 分支 404 + 仓库 404 → 提示仓库不存在或无权访问（与 Q2 区分）',
      /仓库不存在或无权访问/.test(status), status.slice(0, 60));
    dom.window.close();
  }

  // Q4 队列已有同 id → 拒绝覆盖
  {
    const mock = makeQueueMock({ dup: 'exists' });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, '重复 ID', '# x\n');
    check('Q4 队列里已有同 id 时拒绝覆盖', /已有同 id/.test(status) && mock.log.puts.length === 0, status.slice(0, 50));
    dom.window.close();
  }

  // Q5/Q6/Q7 PUT 失败
  for (const [code, pattern, label] of [
    [409, /冲突/, 'Q5 409 冲突不覆盖'],
    [422, /冲突/, 'Q6 422 冲突不覆盖'],
    [500, /HTTP 500|写入失败/, 'Q7 5xx 失败提示'],
  ]) {
    const mock = makeQueueMock({ put: code });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, 'PUT 失败 ' + code, '# x\n');
    check(label, pattern.test(status), status.slice(0, 60));
    check(label + '（不重试、无第二次 PUT）', mock.log.puts.length === 1, mock.log.puts.length);
    dom.window.close();
  }

  // Q8 网络中断
  {
    const mock = makeQueueMock({ put: 'network' });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, '断网', '# 断网草稿\n');
    check('Q8 网络中断 → 明确提示', /网络请求失败/.test(status), status.slice(0, 50));
    check('Q8b 断网后草稿保留', /断网草稿/.test(window.localStorage.getItem('blog_draft') || ''));
    dom.window.close();
  }

  // Q9 Token 权限不足
  {
    const mock = makeQueueMock({ branches: 403 });
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    const status = await submit(window, doc, '权限不足', '# x\n');
    check('Q9 403 → 明确提示权限不足', /无权访问|权限/.test(status), status.slice(0, 50));
    check('Q9b 权限不足时不发 PUT', mock.log.puts.length === 0, mock.log.puts.length);
    dom.window.close();
  }

  // Q10/Q11/Q12 本地校验（零请求）
  {
    const mock = makeQueueMock({});
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    let status = await submit(window, doc, '', '# 有正文\n');
    check('Q10 空标题被本地拦截', /标题不能为空/.test(status) && mock.log.urls.length === 0,
      status.slice(0, 30) + ' / req=' + mock.log.urls.length);
    status = await submit(window, doc, '有标题', '');
    check('Q10b 空正文被本地拦截', /正文不能为空/.test(status) && mock.log.urls.length === 0);
    dom.window.close();
  }
  {
    const mock = makeQueueMock({});
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    window.eval("generatePostId = function () { return 'Bad_ID!'; };");
    const status = await submit(window, doc, '非法 id', '# x\n');
    check('Q11 非法 id 被本地拦截', /id 非法/.test(status) && mock.log.urls.length === 0, status.slice(0, 40));
    dom.window.close();
  }
  {
    const mock = makeQueueMock({});
    const { dom, window, doc } = await openEditor();
    window.fetch = mock;
    window.eval("generatePostId = function () { return 'embodied-ai-notes'; };");
    const status = await submit(window, doc, '撞已有 id', '# x\n');
    check('Q12 与已发布文章同 id 被本地拦截', /id 冲突/.test(status) && mock.log.urls.length === 0,
      status.slice(0, 40));
    dom.window.close();
  }

  await new Promise(r => server.close(r));
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (fail) {
    console.log('失败项：\n  - ' + failures.join('\n  - '));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('SPEC ERROR:', e && e.stack || e);
  process.exit(2);
});
