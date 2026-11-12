/**
 * Batch 7C-3A：发布队列（content/queue）契约测试
 * Batch 8A ：**契约已退役**，本文件改写为「队列入口下线」契约测试。
 *
 * 历史用途（保留记录，不删断言而是换契约）：
 *   7C-3A 时编辑器把文章 PUT 到 content/queue/<id>.json，由 CI 消费成候选 PR；
 *   那时这里覆盖 Q1–Q15：分支必须存在、同 id 不得覆盖、Token 不外泄、草稿保留…
 *
 * 为什么换：8A 决定不再使用自动内容队列 / 自动候选 PR，编辑器只导出本地 JSON。
 * 旧断言（例如"PUT 到 content/queue"）在新架构下**不可能成立**，留着只会逼着代码保留
 * 一条已被判定为高风险的直写通道。因此改为断言"这条通道确实不存在了"，
 * 并且把原来 Q8/Q10/Q13/Q14/Q15 想保护的东西（草稿、提示语义、Token 不外泄、零越权）
 * 用更强的形式保留下来：
 *
 *   N1  js/app.js 里不再有 content/queue、api.github.com、publishPost、Authorization
 *   N2  导出全程零网络请求（fetch 全 reject 也能成功导出）
 *   N3  导出不依赖 content/queue 分支/目录存在
 *   N4  旧 Token 不会进入导出物，也不会被读取
 *   N5  导出物结构可被 scripts/import_post.py 直接接受（六字段）
 *   N6  导出失败不留下"看起来有效"的文件（不调用下载）
 *   N7  提示语义：只承诺本地导出，绝不出现"已提交队列/已上线"
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
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 100) + ')' : ''));
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

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

function fill(doc, title, content) {
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorExcerpt').value = '摘要';
  doc.getElementById('editorContent').value = content;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ N1 静态：直写通道已被移除
    const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    check('N1 不再出现 content/queue', appSrc.indexOf('content/queue') === -1);
    check('N1 不再出现 api.github.com', appSrc.indexOf('api.github.com') === -1);
    check('N1 不再出现 publishPost', appSrc.indexOf('publishPost') === -1);
    check('N1 不再带 Authorization 头（无 Token 提交）', !/Authorization/.test(appSrc));
    check('N1 不再有 base64 上传辅助函数', appSrc.indexOf('utf8ToBase64') === -1);
    check('N1 仍然保留导出实现', appSrc.indexOf('exportPost') !== -1 && appSrc.indexOf('buildExportPayload') !== -1);

    // ------------------------------------------------ N2/N3/N4/N5/N7 运行时
    {
      const { dom, window, doc, errors } = await openEditor();
      const state = { net: 0, downloads: [] };
      window.fetch = function (url) {
        state.net++;
        return Promise.reject(new TypeError('Failed to fetch (content/queue 已不存在)'));
      };
      window.__downloadText = function (text, filename) {
        state.downloads.push({ text: text, filename: filename });
      };
      // 旧用户残留 Token：必须既不参与导出，也不出现在导出物里
      window.localStorage.setItem('gh_token', 'ghp_legacy_should_not_leak');
      window.sessionStorage.setItem('gh_token', 'ghp_legacy_session');

      fill(doc, '队列下线验证文章', '# 队列下线\n\n正文。\n');
      const ok = window.exportPost();
      await wait(60);

      check('N2 导出成功（不依赖任何远端分支）', ok === true);
      check('N2 全程零网络请求', state.net === 0, state.net);
      check('N3 不需要 content/queue 分支就能导出', state.downloads.length === 1);

      const raw = (state.downloads[0] || {}).text || '';
      check('N4 导出物不含旧 Token', raw.indexOf('ghp_legacy') === -1);
      check('N4 导出物不含仓库 owner/repo 配置', raw.indexOf('gh_owner') === -1 && raw.indexOf('gh_repo') === -1);

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {}
      check('N5 导出物是合法 JSON', parsed !== null);
      check('N5 六字段齐全（导入器可直接消费）',
        parsed && ['id', 'title', 'date', 'tags', 'excerpt', 'content'].every(k => k in parsed),
        parsed && Object.keys(parsed).join(','));
      check('N5 id 满足导入器 SAFE_ID', parsed && /^[a-z0-9][a-z0-9-]*$/.test(parsed.id), parsed && parsed.id);

      const status = doc.getElementById('editorStatus').textContent;
      check('N7 提示只承诺本地导出', /已导出/.test(status) && /尚未上线/.test(status), status.slice(0, 50));
      check('N7 不再出现"已提交队列/已提交到发布队列"', !/发布队列|已提交到/.test(status), status.slice(0, 50));
      check('N7 页面不再出现"发布到 GitHub"按钮',
        doc.querySelector('button[onclick="publishPost()"]') === null);
      check('N2 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }

    // ------------------------------------------------ N6 失败不留下半成品
    {
      const { dom, window, doc } = await openEditor();
      const state = { net: 0, downloads: 0 };
      window.fetch = function () { state.net++; return Promise.reject(new TypeError('offline')); };
      window.__downloadText = function () { state.downloads++; throw new Error('write failed'); };

      fill(doc, '写盘失败', '# 会失败的导出\n');
      const ok = window.exportPost();
      await wait(60);
      check('N6 导出失败返回 false', ok === false);
      check('N6 失败时只尝试一次写入（不重试、不写第二份）', state.downloads === 1, state.downloads);
      check('N6 失败时不产生任何网络请求', state.net === 0, state.net);
      check('N6 失败后草稿仍在（可重试）',
        /会失败的导出/.test(window.localStorage.getItem('blog_draft') || ''));
      dom.window.close();
    }
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  server.close();
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
