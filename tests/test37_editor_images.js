/**
 * Batch 8B-2：图片插入与预览契约测试（jsdom）
 *
 * 覆盖：
 *   I1  链接校验：https / 站内相对路径通过；http、javascript:、data:、file: 等拒绝
 *   I2  插入格式：![alt](url)；含括号/空格的地址用 <…> 包裹；alt 里的方括号被清理
 *   I3  危险地址不插入（正文不变 + 明确报错）
 *   I4  本地文件：类型 / 大小校验
 *   I5  本地文件：安全文件名 + 建议路径（images/<slug>-<hash>.<ext>）
 *   I6  本地文件：只写路径引用，绝不写 base64 / blob: / file:
 *   I7  本地文件：明确告知"仅本地预览、尚未加入仓库"
 *   I8  XSS：alt 与 url 里的注入在预览中被 DOMPurify 净化
 *   I9  面板交互：打开 / 切 tab / 关闭后状态清理
 *   I10 编辑模式：插入图片不影响更新稿 original 快照与 id
 *   I11 移动视图切换：只切 data-view，不重建编辑器，内容不丢
 *   I12 导出契约不变（六字段）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8182;
const BASE = 'http://localhost:' + PORT;
const TARGET = 'embodied-ai-notes';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 110) + ')' : ''));
};

async function openEditor(hash) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll|navigation)/.test(e.message)) {
      errors.push(e.message);
    }
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html' + (hash || '#/editor'), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await wait(450);
  w.localStorage.removeItem('blog_draft');
  return { dom, window: w, doc: w.document, errors };
}

const taOf = doc => doc.getElementById('editorContent');

function makeFile(window, name, type, bytes) {
  const data = new Uint8Array(bytes == null ? 64 : bytes);   // 注意 0 是有效值（空文件用例）
  for (let i = 0; i < data.length; i++) data[i] = 0x89;
  return new window.File([data], name, { type: type, lastModified: 1700000000000 });
}

function chooseFile(window, doc, file) {
  const input = doc.getElementById('editorImageFile');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const clickImg = (window, doc, sel) => {
  const btn = doc.querySelector(sel);
  if (!btn) throw new Error('no element ' + sel);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ I1 URL 校验（纯函数）
    {
      const { dom, window } = await openEditor();
      const v = window.MDEditor.validateImageUrl;

      check('I1 https 通过', v('https://cdn.example.com/a.png').ok === true);
      check('I1 https 带查询串通过', v('https://x.test/a.png?w=1&h=2').ok === true);
      check('I1 站内相对路径通过', v('images/a.png').ok === true && v('images/a.png').kind === 'relative');
      check('I1 根路径通过', v('/images/a.png').ok === true);
      check('I1 空值拒绝', v('   ').ok === false && /请输入/.test(v('').error));
      check('I1 http 拒绝', v('http://x.com/a.png').ok === false && /https/.test(v('http://x.com/a.png').error));
      check('I1 javascript: 拒绝', v('javascript:alert(1)').ok === false);
      check('I1 data: 拒绝', v('data:image/png;base64,AAAA').ok === false);
      check('I1 file: 拒绝', v('file:///C:/a.png').ok === false);
      check('I1 blob: 拒绝', v('blob:http://localhost/abc').ok === false);
      check('I1 vbscript: 拒绝', v('vbscript:msgbox(1)').ok === false);
      check('I1 协议相对地址拒绝', v('//evil.com/a.png').ok === false);
      check('I1 含空格拒绝', v('images/a b.png').ok === false);
      check('I1 含尖括号拒绝', v('images/<a>.png').ok === false);
      check('I1 .. 逃逸拒绝', v('../secret/a.png').ok === false && /\.\./.test(v('../secret/a.png').error));
      check('I1 控制字符拒绝', v('images/a\u0001.png').ok === false);

      check('I1 alt 里的方括号被清理', window.MDEditor.sanitizeAlt('a[b]c') === 'abc');
      check('I1 alt 换行压成空格', window.MDEditor.sanitizeAlt('a\nb') === 'a b');
      check('I1 alt 为空时用默认值', window.MDEditor.sanitizeAlt('') === '图片描述');
      check('I1 含括号的地址被 <> 包裹', window.MDEditor.mdUrl('images/a(1).png') === '<images/a(1).png>');
      dom.window.close();
    }

    // ------------------------------------------------ I2/I3 链接插入
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      check('I9 点「图片」打开面板', !doc.getElementById('editorImagePanel').hasAttribute('hidden'));
      check('I9 默认停在链接 tab',
        doc.querySelector('[data-img-pane="url"]').hasAttribute('hidden') === false);

      doc.getElementById('editorImageUrl').value = 'https://cdn.example.com/a.png';
      doc.getElementById('editorImageAlt').value = '架构图';
      ta.value = '';
      ta.focus();
      ta.setSelectionRange(0, 0);
      clickImg(window, doc, '[data-img="insert-url"]');
      check('I2 插入标准图片语法', ta.value === '![架构图](https://cdn.example.com/a.png)', ta.value);
      check('I9 插入后面板关闭', doc.getElementById('editorImagePanel').hasAttribute('hidden'));

      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      doc.getElementById('editorImageUrl').value = 'images/a(1).png';
      doc.getElementById('editorImageAlt').value = '';
      ta.setSelectionRange(ta.value.length, ta.value.length);
      clickImg(window, doc, '[data-img="insert-url"]');
      check('I2 含括号的相对路径用 <> 包裹', /!\[图片描述\]\(<images\/a\(1\)\.png>\)$/.test(ta.value), ta.value);

      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      doc.getElementById('editorImageUrl').value = 'javascript:alert(1)';
      const before = ta.value;
      clickImg(window, doc, '[data-img="insert-url"]');
      check('I3 危险地址不插入', ta.value === before);
      check('I3 明确报错', /只允许 https|\u534F\u8BAE/.test(doc.getElementById('editorImageError').textContent),
        doc.getElementById('editorImageError').textContent);

      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      doc.getElementById('editorImageUrl').value = 'http://x.com/a.png';
      clickImg(window, doc, '[data-img="insert-url"]');
      check('I3 http 被拒绝并提示', ta.value === before &&
        /http/.test(doc.getElementById('editorImageError').textContent),
        doc.getElementById('editorImageError').textContent);
      dom.window.close();
    }

    // ------------------------------------------------ I4/I5/I6/I7 本地图片
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      check('I4 类型校验：svg 拒绝', window.MDEditor.checkImageFile(
        makeFile(window, 'a.svg', 'image/svg+xml')).ok === false);
      check('I4 类型校验：png 通过', window.MDEditor.checkImageFile(
        makeFile(window, 'a.png', 'image/png')).ok === true);
      check('I4 大小校验：超过 2MB 拒绝',
        window.MDEditor.checkImageFile(makeFile(window, 'a.png', 'image/png', 2 * 1024 * 1024 + 1)).ok === false);
      check('I4 空文件拒绝', window.MDEditor.checkImageFile(
        makeFile(window, 'a.png', 'image/png', 0)).ok === false);

      const sug = window.MDEditor.suggestImagePath(makeFile(window, 'My Photo 01.PNG', 'image/png'));
      check('I5 建议路径在 images/ 下', sug.ok && sug.path.indexOf('images/') === 0, sug.path);
      check('I5 文件名是安全 ASCII（无空格/大写/中文）',
        /^images\/[a-z0-9-]+-[a-z0-9]{6}\.png$/.test(sug.path), sug.path);
      check('I5 同名不同内容不会撞车',
        window.MDEditor.suggestImagePath(makeFile(window, 'a.png', 'image/png', 10)).path !==
        window.MDEditor.suggestImagePath(makeFile(window, 'a.png', 'image/png', 11)).path);

      // 走完整面板流程
      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      clickImg(window, doc, '[data-img-tab="file"]');
      check('I9 切到本地图片 tab',
        doc.querySelector('[data-img-pane="file"]').hasAttribute('hidden') === false &&
        doc.querySelector('[data-img-pane="url"]').hasAttribute('hidden') === true);

      const file = makeFile(window, 'shot 01.png', 'image/png', 128);
      chooseFile(window, doc, file);
      const pathText = doc.getElementById('editorImagePath').textContent;
      check('I5 面板显示建议路径', /images\/shot-01-[a-z0-9]{6}\.png/.test(pathText), pathText);
      check('I7 面板明确提示仅本地预览', /仅本地预览/.test(doc.getElementById('editorImageWarn').textContent) &&
        !doc.getElementById('editorImageWarn').hasAttribute('hidden'));
      check('I7 提示需要把原图放进仓库', /一起提交|放进仓库/.test(doc.getElementById('editorImageWarn').textContent));

      ta.value = '';
      ta.focus();
      ta.setSelectionRange(0, 0);
      doc.getElementById('editorImageAlt').value = '截图';
      clickImg(window, doc, '[data-img="insert-file"]');

      check('I6 只插入站内路径引用', /^!\[截图\]\(images\/shot-01-[a-z0-9]{6}\.png\)$/.test(ta.value), ta.value);
      check('I6 绝不写入 base64', ta.value.indexOf('base64') === -1);
      check('I6 绝不写入 blob:/file: 本地路径',
        ta.value.indexOf('blob:') === -1 && ta.value.indexOf('file:') === -1 && ta.value.indexOf('C:\\') === -1);
      const statusHtml = doc.getElementById('editorStatus').innerHTML;
      check('I7 状态栏如实说明尚未加入仓库', /尚未加入仓库|仅本地预览/.test(statusHtml), statusHtml.slice(0, 80));
      check('I7 状态栏告诉用户需要提交图片', /一起提交|放到/.test(statusHtml));
      check('I7 不谎称已可发布', !/已发布|已上线|可以发布/.test(statusHtml));
      dom.window.close();
    }

    // ------------------------------------------------ I8 XSS 净化
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      ta.value = '![" onerror="window.__x=1](javascript:alert(1))\n\n' +
        '![x](https://ok.example/a.png)\n\n' +
        '<img src=x onerror="window.__x=2">\n';
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(120);

      const preview = doc.getElementById('editorPreview');
      check('I8 预览中没有 onerror 内联事件', preview.innerHTML.indexOf('onerror') === -1,
        preview.innerHTML.slice(0, 80));
      check('I8 预览中没有 javascript: 链接', preview.innerHTML.indexOf('javascript:') === -1);
      check('I8 注入脚本未执行', window.__x === undefined);
      check('I8 合法图片仍然渲染', preview.innerHTML.indexOf('ok.example') !== -1);
      dom.window.close();
    }

    // ------------------------------------------------ I9 关闭后状态清理
    {
      const { dom, window, doc } = await openEditor();
      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      doc.getElementById('editorImageUrl').value = 'javascript:1';
      clickImg(window, doc, '[data-img="insert-url"]');
      check('I9 出错有提示', doc.getElementById('editorImageError').textContent.length > 0);
      clickImg(window, doc, '[data-img="close"]');
      check('I9 关闭后面板隐藏', doc.getElementById('editorImagePanel').hasAttribute('hidden'));
      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      check('I9 重新打开会清空上次的地址与错误',
        doc.getElementById('editorImageUrl').value === '' &&
        doc.getElementById('editorImageError').textContent === '');
      dom.window.close();
    }

    // ------------------------------------------------ I10 编辑模式不受影响
    {
      const { dom, window, doc } = await openEditor('#/editor/' + TARGET);
      const ta = taOf(doc);
      const diskBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', TARGET + '.md'), 'utf8');
      ta.focus();
      ta.setSelectionRange(3, 3);
      clickImg(window, doc, '#editorToolbar [data-md="image"]');
      doc.getElementById('editorImageUrl').value = 'images/added.png';
      clickImg(window, doc, '[data-img="insert-url"]');

      const payload = window.buildUpdatePayload();
      check('I10 插入图片后仍可生成更新稿', payload.ok === true, payload.error);
      check('I10 original 快照未被图片操作改动', payload.payload.original.content === diskBody);
      check('I10 更新稿 id 不变', payload.payload.id === TARGET);
      check('I10 新正文里包含图片引用', payload.payload.post.content.indexOf('images/added.png') !== -1);
      dom.window.close();
    }

    // ------------------------------------------------ I11 视图切换不丢内容
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      const split = doc.getElementById('editorSplit');
      ta.value = '# 标题\n\n内容 content';
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));

      const nodeBefore = ta;
      clickImg(window, doc, '#editorViewToggle [data-view="preview"]');
      check('I11 切到预览视图', split.getAttribute('data-view') === 'preview');
      check('I11 预览按钮高亮',
        doc.querySelector('#editorViewToggle [data-view="preview"]').classList.contains('active'));
      check('I11 正文内容未丢失', ta.value === '# 标题\n\n内容 content');
      check('I11 没有重建 textarea（同一 DOM 节点）', taOf(doc) === nodeBefore);
      check('I11 预览内容已渲染', /标题/.test(doc.getElementById('editorPreview').textContent));

      clickImg(window, doc, '#editorViewToggle [data-view="edit"]');
      check('I11 切回编辑视图', split.getAttribute('data-view') === 'edit');
      check('I11 切回后内容仍在', ta.value === '# 标题\n\n内容 content');
      dom.window.close();
    }

    // ------------------------------------------------ I12 导出契约不变
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      doc.getElementById('editorTitle').value = '图片契约测试';
      doc.getElementById('editorTags').value = '测试';
      ta.value = '![a](images/x.png)\n\n正文。\n';
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));

      const p = window.buildExportPayload();
      check('I12 导出成功', p.ok === true, p.error);
      check('I12 字段顺序仍为六字段',
        p.ok && Object.keys(p.post).join(',') === 'id,title,date,tags,excerpt,content',
        p.ok && Object.keys(p.post).join(','));
      check('I12 图片语法原样进入 content', p.ok && p.post.content.indexOf('![a](images/x.png)') !== -1);
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
