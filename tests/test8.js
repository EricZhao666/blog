// 编辑器 GitHub Token 契约（Batch 8A 重写）
//
// 历史（Batch 2 起）：编辑器需要 PAT 才能直连 GitHub Contents API，因此测试
// sessionStorage/localStorage 的存储策略（默认 session + 记住我 → localStorage）。
//
// Batch 8A 起：编辑器只做「导出文章」这一件事，**不联网、不读 Token**。
// 所以这里断言的是**更强**的新契约，而不是删掉旧断言：
//   T1 页面上不再有 Token 输入框 / “记住我” / 仓库 owner+repo 设置
//   T2 代码里不再提供 getStoredToken / saveEditorSettings（不会再写入 Token）
//   T3 打开编辑器不会创建 gh_token（新旧存储都不写）
//   T4 旧用户残留的 gh_token / gh_owner / gh_repo 仍能被一键清除（安全迁移能力）
//   T5 Token 值不会出现在页面文本里（原先会回填到 input.value）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8133;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8'
};
const LEGACY = ['gh_token', 'gh_owner', 'gh_repo'];

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
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));

  try {
    const dom = await JSDOM.fromURL(BASE + '/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    const doc = window.document;
    await new Promise(r => window.addEventListener('load', r));
    await wait(400);

    // 模拟 8A 之前的老用户：两个存储里都留下 PAT 与仓库设置
    window.localStorage.setItem('gh_token', 'ghp_legacy_should_be_purged');
    window.sessionStorage.setItem('gh_token', 'ghp_legacy_session');

    window.location.hash = '#/editor';
    await wait(700);

    // ---------------------------------------------- T1 页面不再有 Token 设置
    check('T1 不再渲染 Token 输入框', doc.getElementById('ghToken') === null);
    check('T1 不再渲染“记住我”复选框', doc.getElementById('ghRemember') === null);
    check('T1 不再渲染仓库 owner/repo 输入', doc.getElementById('ghOwner') === null && doc.getElementById('ghRepo') === null);
    check('T1 仍然提供“导出文章”入口', !!doc.querySelector('button[onclick="exportPost()"]'));
    check('T1 不再提供“发布到 GitHub”入口', doc.querySelector('button[onclick="publishPost()"]') === null);
    check('T1 提供“清除旧版 Token”入口', !!doc.querySelector('button[onclick="clearLegacyPublishData()"]'));

    // ---------------------------------------------- T2 不再暴露写入 Token 的接口
    check('T2 不再提供 getStoredToken（不会再读 Token）', typeof window.getStoredToken === 'undefined');
    check('T2 不再提供 saveEditorSettings（不会再写 Token）', typeof window.saveEditorSettings === 'undefined');
    check('T2 不再提供 publishPost（不会直连 GitHub）', typeof window.publishPost === 'undefined');
    check('T2 仍提供 clearLegacyPublishData', typeof window.clearLegacyPublishData === 'function');
    check('T2 保留 clearEditorToken 兼容别名', typeof window.clearEditorToken === 'function');

    // ---------------------------------------------- T3 打开编辑器不写 Token
    check('T3 打开编辑器不会新建 localStorage Token', window.localStorage.getItem('gh_token') === 'ghp_legacy_should_be_purged');

    // ---------------------------------------------- T4 旧 Token 可一键清除
    const stateBefore = (doc.getElementById('legacyPublishState') || {}).textContent || '';
    check('T4 设置面板会提示本机仍残留旧 Token', /仍残留旧版 GitHub Token/.test(stateBefore), stateBefore.slice(0, 40));

    window.clearLegacyPublishData();
    await wait(120);
    check('T4 清除后 sessionStorage 无 Token', window.sessionStorage.getItem('gh_token') === null);
    check('T4 清除后 localStorage 无 Token', window.localStorage.getItem('gh_token') === null);
    const left = LEGACY.filter(k => window.localStorage.getItem(k) !== null || window.sessionStorage.getItem(k) !== null);
    check('T4 清除后 gh_token/gh_owner/gh_repo 全部消失', left.length === 0, left.join(','));
    const stateAfter = (doc.getElementById('legacyPublishState') || {}).textContent || '';
    check('T4 清除后状态文案更新', /没有发现旧版发布数据/.test(stateAfter), stateAfter.slice(0, 40));
    check('T4 清除有可见反馈', /已清除/.test(doc.getElementById('editorStatus').textContent),
      doc.getElementById('editorStatus').textContent.slice(0, 40));

    // 兼容别名行为一致：只删不写
    window.localStorage.setItem('gh_token', 'ghp_alias_test');
    window.clearEditorToken();
    await wait(80);
    check('T4 clearEditorToken 别名同样只做清除', window.localStorage.getItem('gh_token') === null);

    // ---------------------------------------------- T5 Token 不回显到页面
    window.localStorage.setItem('gh_token', 'ghp_never_render_me');
    window.location.hash = '#/';
    await wait(250);
    window.location.hash = '#/editor';
    await wait(500);
    check('T5 重新进入编辑器后 Token 值不出现在页面文本里',
      doc.body.textContent.indexOf('ghp_never_render_me') === -1);
    check('T5 重新进入编辑器后仍无 Token 输入框', doc.getElementById('ghToken') === null);

    const filtered = errors.filter(m => !/Not implemented/i.test(m));
    check('无脚本运行错误', filtered.length === 0, filtered.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  } finally {
    console.log(pass ? 'ALL PASS' : 'HAS FAILURES');
    server.close();
    process.exit(pass ? 0 : 1);
  }
});
