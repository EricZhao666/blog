// 验证编辑器 GitHub Token 存储策略：默认 sessionStorage + 显式“记住我”写入 localStorage + 一键清除
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = true;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) pass = false;
};

server.listen(8133, async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));

  try {
    const dom = await JSDOM.fromURL('http://localhost:8133/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    const doc = window.document;
    await new Promise(r => window.addEventListener('load', r));
    await wait(400);

    window.location.hash = '#/editor';
    await wait(800);

    const tokenInput = doc.getElementById('ghToken');
    const rememberBox = doc.getElementById('ghRemember');
    check('编辑器渲染 Token 输入框', !!tokenInput);
    check('编辑器渲染“记住我”复选框', !!rememberBox);
    check('默认不勾选“记住我”', rememberBox && !rememberBox.checked);
    check('存在“清除 Token”按钮', !!doc.querySelector('button[onclick="clearEditorToken()"]'));
    check('提供 getStoredToken 接口', typeof window.getStoredToken === 'function');

    // 1) 不勾选“记住我” -> 只写 sessionStorage
    tokenInput.value = 'pat_test_session';
    rememberBox.checked = false;
    window.saveEditorSettings();
    await wait(100);
    const s1 = window.sessionStorage.getItem('gh_token');
    const l1 = window.localStorage.getItem('gh_token');
    check('未勾选时 Token 存入 sessionStorage', s1 === 'pat_test_session', s1);
    check('未勾选时 localStorage 无 Token', l1 === null, String(l1));
    check('getStoredToken 读到 sessionStorage', window.getStoredToken() === 'pat_test_session');

    // 2) 勾选“记住我” -> 同时写 localStorage
    tokenInput.value = 'pat_test_remember';
    rememberBox.checked = true;
    window.saveEditorSettings();
    await wait(100);
    const s2 = window.sessionStorage.getItem('gh_token');
    const l2 = window.localStorage.getItem('gh_token');
    check('勾选后 sessionStorage 更新', s2 === 'pat_test_remember', s2);
    check('勾选后 localStorage 同步保存', l2 === 'pat_test_remember', l2);

    // 3) 取消勾选并保存 -> localStorage 中的旧 Token 被清除
    rememberBox.checked = false;
    window.saveEditorSettings();
    await wait(100);
    check('取消勾选后 localStorage 被清理', window.localStorage.getItem('gh_token') === null,
      String(window.localStorage.getItem('gh_token')));
    check('取消勾选后 sessionStorage 仍可用', window.getStoredToken() === 'pat_test_remember');

    // 4) 一键清除
    tokenInput.value = 'pat_test_remember';
    rememberBox.checked = true;
    window.saveEditorSettings();
    await wait(100);
    window.clearEditorToken();
    await wait(100);
    check('清除后 sessionStorage 为空', window.sessionStorage.getItem('gh_token') === null);
    check('清除后 localStorage 为空', window.localStorage.getItem('gh_token') === null);
    check('清除后输入框已置空', doc.getElementById('ghToken').value === '');
    check('清除后“记住我”已取消勾选', doc.getElementById('ghRemember').checked === false);

    // 5) 重新进入编辑器时不残留 Token
    window.location.hash = '#/';
    await wait(300);
    window.location.hash = '#/editor';
    await wait(600);
    check('重新进入编辑器 Token 为空', doc.getElementById('ghToken').value === '');

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
