// Batch 8D-2A：Markdown 图片放大查看器（jsdom）
//
// 使用合成 Markdown Fixture，不修改正式文章；每个场景独立页面，导航用 replaceState + router()。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
let PORT = Number(process.env.TEST_PORT || 0);
let BASE = '';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function svgDataUri(w, h, fill) {
  return 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
    '<rect width="' + w + '" height="' + h + '" fill="' + fill + '"/></svg>'
  ).toString('base64');
}
const IMG_A = svgDataUri(120, 80, '#3b82f6');
const IMG_B = svgDataUri(60, 60, '#ef4444');

const CONTENT = [
  '# 图片测试文章',
  '',
  '## 第一节',
  '',
  '![示例说明](' + IMG_A + ')',
  '',
  '![](' + IMG_B + ')',
  '',
  '[![链接图](' + IMG_A + ')](https://example.com/page)',
  '',
  '![危险图](javascript:alert(1))',
  '',
  '## 第二节',
  '',
  '```js',
  'console.log(1);',
  '```',
  '',
  '## 第三节',
  '',
  '结尾。'
].join('\n');

async function newPage() {
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test44 */', {
        status: 200, headers: { 'Content-Type': 'application/javascript' }
      });
    })]
  };
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: resources, pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(150);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://localhost:' + PORT;

  let dom = null;
  let win = null, doc = null;
  const allErrors = [];
  try {
    const ctx = await newPage();
    dom = ctx.dom; win = ctx.win; doc = ctx.doc;
    allErrors.push.apply(allErrors, ctx.errors);

    win.eval('USER_POSTS.push(' + JSON.stringify({
      id: 'b8d2a-images', title: '图片测试', date: '2026-11-16',
      tags: ['测试'], excerpt: '图片测试', content: CONTENT
    }) + ');');
    win.history.replaceState(null, '', '#/post/b8d2a-images');
    win.eval('router()');
    await wait(800);

    if (!doc.querySelector('.article-detail-body img')) {
      console.log('DIAG HTML', doc.querySelector('.article-detail-body').innerHTML.slice(0, 900));
    }
    const imgs = Array.prototype.slice.call(doc.querySelectorAll('.article-detail-body img'));
    const zoomable = imgs.filter(img => img.classList.contains('zoomable-image'));
    check('I1 只标记正文普通图片（链接内 / 危险协议不标记）',
      imgs.length >= 3 && zoomable.length === 2, imgs.length + ' / ' + zoomable.length);
    check('I2 可点击图片具备键盘与语义属性',
      zoomable.every(img => img.getAttribute('tabindex') === '0' && img.getAttribute('role') === 'button'));
    check('I3 alt 写入 aria-label', zoomable[0].getAttribute('aria-label') === '放大图片：示例说明',
      zoomable[0].getAttribute('aria-label'));
    check('I4 空 alt 使用通用 aria-label', zoomable[1].getAttribute('aria-label') === '放大图片',
      zoomable[1].getAttribute('aria-label'));

    const linkImg = imgs.filter(img => img.closest('a'))[0];
    check('I5 链接内图片不被拦截', !!linkImg && !linkImg.classList.contains('zoomable-image') &&
      linkImg.closest('a').getAttribute('href') === 'https://example.com/page');
    check('I6 危险协议图片不被标记',
      imgs.filter(img => /javascript:/i.test(img.getAttribute('src') || ''))
        .every(img => !img.classList.contains('zoomable-image')));

    // 打开 / 说明 / 焦点
    const trigger = zoomable[0];
    trigger.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
    const dialog = doc.getElementById('imageLightbox');
    check('I7 点击打开查看器', !!dialog && dialog.hasAttribute('open') &&
      dialog.getAttribute('aria-modal') === 'true');
    const lightImg = dialog.querySelector('.image-lightbox-img');
    const caption = dialog.querySelector('.image-lightbox-caption');
    check('I8 查看器使用原图 src', lightImg.getAttribute('src') === trigger.getAttribute('src'));
    check('I9 alt 作为说明文本显示',
      caption.textContent === '示例说明' && caption.hidden === false);
    check('I10 打开时锁定背景滚动', doc.documentElement.classList.contains('lightbox-open'));
    check('I11 打开后焦点在关闭按钮',
      doc.activeElement === dialog.querySelector('.image-lightbox-close'));

    // 关闭 + 焦点恢复
    dialog.querySelector('.image-lightbox-close').dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
    check('I12 关闭按钮关闭查看器', !dialog.hasAttribute('open'));
    check('I13 关闭后焦点回到原图片', doc.activeElement === trigger, doc.activeElement && doc.activeElement.tagName);
    check('I14 关闭后恢复背景滚动', !doc.documentElement.classList.contains('lightbox-open'));

    // Esc
    trigger.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(120);
    check('I15 Esc 关闭查看器', !dialog.hasAttribute('open'));
    check('I16 Esc 关闭后焦点回到原图片', doc.activeElement === trigger);

    // 空 alt
    zoomable[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    check('I17 空 alt 不显示无意义说明区域',
      dialog.querySelector('.image-lightbox-caption').hidden === true &&
      dialog.querySelector('.image-lightbox-caption').textContent === '');
    dialog.querySelector('.image-lightbox-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);

    // 键盘打开
    const keyEv = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    zoomable[0].dispatchEvent(keyEv);
    await wait(100);
    check('I18 Enter 键可打开查看器', dialog.hasAttribute('open') && keyEv.defaultPrevented);
    dialog.querySelector('.image-lightbox-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);

    // 图片加载失败
    zoomable[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    dialog.querySelector('.image-lightbox-img').dispatchEvent(new win.Event('error'));
    await wait(60);
    check('I19 图片加载失败给出明确反馈',
      dialog.querySelector('.image-lightbox-error').hidden === false &&
      dialog.querySelector('.image-lightbox-img').hidden === true);
    dialog.querySelector('.image-lightbox-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(80);

    // 滚动位置恢复
    Object.defineProperty(win, 'scrollY', { value: 420, configurable: true });
    const scrollCalls = [];
    win.scrollTo = function (x, y) {
      if (x && typeof x === 'object') scrollCalls.push([x.left || 0, x.top]);
      else scrollCalls.push([x, y]);
    };
    zoomable[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(80);
    Object.defineProperty(win, 'scrollY', { value: 0, configurable: true });
    dialog.querySelector('.image-lightbox-close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await wait(200);
    check('I20 关闭后恢复原滚动位置',
      scrollCalls.some(c => c[0] === 0 && c[1] === 420), JSON.stringify(scrollCalls));

    // XSS：alt 只作文本
    win.eval('USER_POSTS.push(' + JSON.stringify({
      id: 'b8d2a-xss', title: 'XSS', date: '2026-11-15', tags: ['测试'], excerpt: 'x',
      content: '# XSS\n\n## 一\n\n![<img src=x onerror=window.__xss=1>](' + IMG_A + ')\n\n## 二\n\n内容\n\n## 三\n\n内容'
    }) + ');');
    win.history.replaceState(null, '', '#/post/b8d2a-xss');
    win.eval('router()');
    await wait(700);
    const xssImg = doc.querySelector('.article-detail-body img.zoomable-image');
    xssImg.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    const xssCaption = doc.querySelector('.image-lightbox-caption');
    check('I21 alt 中的 HTML 只作为文本显示',
      xssCaption.textContent.indexOf('<img src=x') !== -1 &&
      xssCaption.innerHTML.indexOf('<img') === -1 &&
      doc.querySelectorAll('#imageLightbox img').length === 1,
      xssCaption.innerHTML.slice(0, 40));
    check('I22 alt 不执行事件属性', !win.__xss);

    // 路由切换关闭：先重新打开，再切路由
    win.history.replaceState(null, '', '#/post/b8d2a-images');
    win.eval('router()');
    await wait(700);
    doc.querySelector('.article-detail-body img.zoomable-image').dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    const openBefore = doc.getElementById('imageLightbox').hasAttribute('open');
    win.history.replaceState(null, '', '#/about');
    win.eval('router()');
    await wait(300);
    check('I23 路由切换后关闭并清理查看器',
      openBefore && !doc.getElementById('imageLightbox').hasAttribute('open') &&
      !doc.documentElement.classList.contains('lightbox-open'), openBefore);

    // 不影响阅读工具
    win.history.replaceState(null, '', '#/post/b8d2a-images');
    win.eval('router()');
    await wait(700);
    check('I24 不影响目录 / 阅读进度 / 代码复制',
      !!doc.getElementById('tocPanel') && !!doc.getElementById('readingProgress') &&
      doc.querySelectorAll('.copy-btn').length === 1);
    check('I25 图片仍保留说明文本（不自动写入文章）',
      doc.querySelector('.article-detail-body img.zoomable-image').getAttribute('alt') === '示例说明');

    // 编辑器预览与课程笔记的作用域
    const preview = doc.createElement('div');
    preview.className = 'editor-preview';
    const previewBody = doc.createElement('div');
    previewBody.className = 'markdown-body';
    const previewImg = doc.createElement('img');
    previewImg.setAttribute('src', IMG_A);
    previewImg.setAttribute('alt', '预览');
    previewBody.appendChild(previewImg);
    preview.appendChild(previewBody);
    doc.body.appendChild(preview);
    win.enhanceImages(preview);
    check('I26 不影响编辑器本地图片预览',
      !previewImg.classList.contains('zoomable-image'));

    const notes = doc.createElement('section');
    notes.className = 'course-notes';
    const notesBody = doc.createElement('div');
    notesBody.className = 'markdown-body';
    const notesImg = doc.createElement('img');
    notesImg.setAttribute('src', IMG_B);
    notesImg.setAttribute('alt', '笔记图');
    notesBody.appendChild(notesImg);
    notes.appendChild(notesBody);
    doc.body.appendChild(notes);
    win.enhanceImages(notes);
    check('I27 课程笔记正文图片同样可放大',
      notesImg.classList.contains('zoomable-image') && notesImg.getAttribute('tabindex') === '0');

    // 协议白名单
    check('I28 危险 URL 协议被拒绝',
      win.isSafeImageUrl('javascript:alert(1)') === false &&
      win.isSafeImageUrl('data:text/html,<b>x</b>') === false &&
      win.isSafeImageUrl('data:image/png;base64,AAAA') === true &&
      win.isSafeImageUrl('https://example.com/a.png') === true &&
      win.isSafeImageUrl('images/a.png') === true);
    check('I29 无脚本错误', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));

    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
    if (failures.length) console.log('失败项：' + failures.join(' / '));
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  } finally {
    if (dom) dom.window.close();
    server.close();
    process.exit(fail ? 1 : 0);
  }
})();
