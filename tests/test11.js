// B2-02 编辑器草稿自动保存 / 竞态回归测试
// 使用可编程的 Fake Timers（接管 window.setTimeout/clearTimeout），不依赖真实等待。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8136;
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

// ---- Fake Timers（只接管 window 上的定时器，页面其余部分仍用真实 I/O）----
function installFakeTimers(window) {
  const timers = new Map();
  let nextId = 1;
  let now = 0;
  window.__timerErrors = [];
  window.setTimeout = function (fn, ms) {
    const id = nextId++;
    timers.set(id, { fn: fn, at: now + (ms || 0) });
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.__advance = function (ms) {
    now += ms;
    let guard = 0;
    while (guard++ < 200) {
      const due = Array.from(timers.entries())
        .filter(function (e) { return e[1].at <= now; })
        .sort(function (a, b) { return a[1].at - b[1].at; });
      if (!due.length) break;
      for (const [id, t] of due) {
        timers.delete(id);
        try { t.fn(); } catch (e) { window.__timerErrors.push(String(e && e.message || e)); }
      }
    }
  };
  window.__pending = function () { return timers.size; };
}

async function openEditor() {
  const vcErrors = [];
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
  window.localStorage.removeItem('blog_draft');
  window.sessionStorage.setItem('gh_token', 'fake-token');
  window.localStorage.setItem('gh_owner', 'demo');
  window.localStorage.setItem('gh_repo', 'demo-blog');
  installFakeTimers(window);
  return { dom, window, doc, vcErrors };
}

function type(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function readDraft(window) {
  try { return JSON.parse(window.localStorage.getItem('blog_draft') || 'null'); } catch (e) { return null; }
}

function resp(status, body) {
  return { ok: status >= 200 && status < 300, status: status, json: () => Promise.resolve(body) };
}
function stubGithub(window, mode) {
  window.fetch = function (url, init) {
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (mode === 'fail') return Promise.resolve(resp(500, { message: 'boom' }));
      return Promise.resolve(resp(404, { message: 'Not Found' }));
    }
    return Promise.resolve(resp(200, { content: { sha: 'x' } }));
  };
}

server.listen(PORT, async () => {
  try {
    // S1 修改正文后等待自动保存
    {
      const { dom, window, doc } = await openEditor();
      type(window, doc.getElementById('editorContent'), '# 正文\n\n自动保存测试');
      window.__advance(2000);
      const d = readDraft(window);
      check('S1 正文自动保存', d && d.content.indexOf('自动保存测试') !== -1, d && d.content);
      check('S1 无定时器异常', window.__timerErrors.length === 0, window.__timerErrors.join('|'));
      dom.window.close();
    }

    // S2 只改标题（不动正文）
    {
      const { dom, window, doc } = await openEditor();
      type(window, doc.getElementById('editorTitle'), '只改标题');
      window.__advance(2000);
      const d = readDraft(window);
      check('S2 标题变化会被保存', d && d.title === '只改标题', d && d.title);
      dom.window.close();
    }

    // S3 修改标签与摘要
    {
      const { dom, window, doc } = await openEditor();
      type(window, doc.getElementById('editorTags'), '标签A, 标签B');
      type(window, doc.getElementById('editorExcerpt'), '这是摘要');
      window.__advance(2000);
      const d = readDraft(window);
      check('S3 标签与摘要会被保存',
        d && d.tags === '标签A, 标签B' && d.excerpt === '这是摘要',
        d && (d.tags + ' / ' + d.excerpt));
      dom.window.close();
    }

    // S4 输入后立即切换到首页（防抖尚未触发）
    {
      const { dom, window, doc, vcErrors } = await openEditor();
      type(window, doc.getElementById('editorContent'), '# 离开前未保存的内容');
      window.location.hash = '#/';
      await wait(300);
      window.__advance(3000);
      const d = readDraft(window);
      check('S4 切走首页后草稿不丢失', d && d.content.indexOf('离开前未保存的内容') !== -1, d && d.content);
      check('S4 无未捕获定时器异常', window.__timerErrors.length === 0 && vcErrors.length === 0,
        (window.__timerErrors.concat(vcErrors)).slice(0, 2).join(' | '));
      dom.window.close();
    }

    // S5 输入后立即切换到其他文章
    {
      const { dom, window, doc, vcErrors } = await openEditor();
      type(window, doc.getElementById('editorContent'), '# 切文章前的草稿');
      window.location.hash = '#/post/slam-technology';
      await wait(300);
      window.__advance(3000);
      const d = readDraft(window);
      check('S5 切到文章页后草稿不丢失', d && d.content.indexOf('切文章前的草稿') !== -1, d && d.content);
      check('S5 无未捕获定时器异常', window.__timerErrors.length === 0 && vcErrors.length === 0,
        (window.__timerErrors.concat(vcErrors)).slice(0, 2).join(' | '));
      dom.window.close();
    }

    // S6 发布成功后残留定时器不得写回旧草稿
    {
      const { dom, window, doc } = await openEditor();
      stubGithub(window, 'ok');
      type(window, doc.getElementById('editorContent'), '# 已发布的内容');
      doc.getElementById('editorTitle').value = '已发布文章';
      await window.publishPost();
      await wait(50);
      window.__advance(2500);   // 让 2s 跳转与可能残留的草稿定时器都触发
      await wait(400);
      const d = readDraft(window);
      check('S6 发布成功后不残留旧草稿', d === null, JSON.stringify(d));
      check('S6 无定时器异常', window.__timerErrors.length === 0, window.__timerErrors.join('|'));
      dom.window.close();
    }

    // S7 发布失败后重新进入编辑器，草稿可恢复
    {
      const { dom, window, doc } = await openEditor();
      stubGithub(window, 'fail');
      type(window, doc.getElementById('editorContent'), '# 发布失败要保住的草稿');
      doc.getElementById('editorTitle').value = '失败的文章';
      await window.publishPost();
      await wait(50);
      const status = doc.getElementById('editorStatus').textContent;
      check('S7 发布失败有明确提示', /发布失败/.test(status), status.trim().slice(0, 30));
      window.location.hash = '#/';
      await wait(300);
      window.location.hash = '#/editor';
      await wait(500);
      const restored = doc.getElementById('editorContent');
      check('S7 重新进入编辑器可恢复草稿',
        !!restored && restored.value.indexOf('发布失败要保住的草稿') !== -1,
        restored && restored.value.slice(0, 30));
      check('S7 无定时器异常', window.__timerErrors.length === 0, window.__timerErrors.join('|'));
      dom.window.close();
    }

    // S8 连续快速输入：只保留最新内容，且定时器被替换
    {
      const { dom, window, doc } = await openEditor();
      const c = doc.getElementById('editorContent');
      type(window, c, 'a');
      window.__advance(500);
      type(window, c, 'ab');
      window.__advance(500);
      type(window, c, 'abc');
      check('S8 输入期间只保留一个待触发定时器', window.__pending() === 1, window.__pending());
      window.__advance(2000);
      const d = readDraft(window);
      check('S8 保存的是最新内容', d && d.content === 'abc', d && d.content);
      dom.window.close();
    }

    // S9 正常对照：手动保存 + 再次进入回填
    {
      const { dom, window, doc } = await openEditor();
      doc.getElementById('editorTitle').value = '手动保存标题';
      doc.getElementById('editorContent').value = '# 手动保存正文';
      window.saveDraft();
      const d = readDraft(window);
      check('S9 手动保存草稿', d && d.title === '手动保存标题' && d.content.indexOf('手动保存正文') !== -1);
      window.location.hash = '#/';
      await wait(300);
      window.location.hash = '#/editor';
      await wait(500);
      check('S9 再次进入自动回填',
        doc.getElementById('editorTitle').value === '手动保存标题' &&
        doc.getElementById('editorContent').value.indexOf('手动保存正文') !== -1);
      dom.window.close();
    }
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  }

  console.log('\n共 ' + total + ' 项，' + (pass ? 'ALL PASS' : 'HAS FAILURES'));
  server.close();
  process.exit(pass ? 0 : 1);
});
