/**
 * Batch 8B-2：Markdown 工具栏 / 快捷键 / 状态栏契约测试（jsdom）
 *
 * 覆盖：
 *   T1  工具栏渲染（按钮齐全 + 语言选择器）
 *   T2  加粗：有选区包裹、再点取消、选中已加粗文本也能取消
 *   T3  无选区：插入占位并选中占位内容
 *   T4  斜体 / 行内代码
 *   T5  一到三级标题（多行 + 切换 + 不改动正文内容）
 *   T6  有序 / 无序列表（多行编号、切换、内容不丢）
 *   T7  引用（多行）
 *   T8  代码块（语言标记、多行选区、换行正确、不丢内容）
 *   T9  表格 / 分割线（独立成块）
 *   T10 链接（选区作文本、URL 占位被选中；Ctrl+K 同效）
 *   T11 中英文混排
 *   T12 焦点与选区保持（mousedown 不抢焦点）
 *   T13 编辑会触发 input → 草稿保存 + 预览更新 + 状态栏更新
 *   T14 快捷键 Ctrl/Cmd+B / I / K、Tab / Shift+Tab
 *   T15 Ctrl+Z / Ctrl+Shift+Z 明确交还浏览器原生行为（不 preventDefault）
 *   T16 中文输入法组合期间不处理快捷键
 *   T17 其它输入框不受快捷键影响
 *   T18 优先走 document.execCommand（原生编辑管线 → 原生 Undo 可用）
 *   T19 状态栏：字数 / 英文词数 / 阅读时间 / 模式 / id
 *   T20 编辑模式：id 与原文快照不变
 *   T21 草稿状态只承诺"本地草稿"
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8181;
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

function setSel(ta, s, e) {
  ta.focus();
  ta.setSelectionRange(s, e == null ? s : e);
}

function clickMd(window, doc, action) {
  const btn = doc.querySelector('#editorToolbar [data-md="' + action + '"]');
  if (!btn) throw new Error('no toolbar button: ' + action);
  btn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  btn.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function key(window, ta, opts) {
  const e = new window.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts));
  ta.dispatchEvent(e);
  return e;
}

const selOf = ta => ta.value.slice(ta.selectionStart, ta.selectionEnd);

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ T1 工具栏渲染
    {
      const { dom, window, doc, errors } = await openEditor('#/editor');
      const btns = doc.querySelectorAll('#editorToolbar [data-md]');
      check('T1 工具栏存在', !!doc.getElementById('editorToolbar'));
      check('T1 按钮数量覆盖全部动作', btns.length === 14, btns.length);
      const actions = Array.prototype.map.call(btns, b => b.getAttribute('data-md'));
      ['h1', 'h2', 'h3', 'bold', 'italic', 'code', 'codeblock', 'ul', 'ol', 'quote',
        'link', 'image', 'table', 'hr'].forEach(a => {
        check('T1 有按钮 ' + a, actions.indexOf(a) !== -1, actions.join(','));
      });
      check('T1 有代码块语言选择器', !!doc.getElementById('editorCodeLang'));
      check('T1 语言选择器含 python', doc.getElementById('editorCodeLang').value === '' &&
        /python/.test(doc.getElementById('editorCodeLang').innerHTML));
      check('T1 按钮不提交表单（type=button）', btns[0].getAttribute('type') === 'button');
      check('T1 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }

    // ------------------------------------------------ T2/T3/T4 行内格式
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = 'hello world';
      setSel(ta, 0, 5);
      clickMd(window, doc, 'bold');
      check('T2 加粗包裹选区', ta.value === '**hello** world', ta.value);
      check('T2 格式化后选区仍在文字上', selOf(ta) === 'hello', selOf(ta));

      clickMd(window, doc, 'bold');
      check('T2 再次点击取消加粗', ta.value === 'hello world', ta.value);

      ta.value = '**already**';
      setSel(ta, 2, 9);
      clickMd(window, doc, 'bold');
      check('T2 选中已加粗文本再点击 = 取消', ta.value === 'already', ta.value);

      ta.value = '';
      setSel(ta, 0, 0);
      clickMd(window, doc, 'bold');
      check('T3 无选区插入占位', ta.value === '**加粗文字**', ta.value);
      check('T3 占位内容被选中', selOf(ta) === '加粗文字', selOf(ta));
      clickMd(window, doc, 'bold');
      check('T3 再次点击还原为纯文本', ta.value === '加粗文字', ta.value);

      ta.value = 'italic';
      setSel(ta, 0, 6);
      clickMd(window, doc, 'italic');
      check('T4 斜体包裹', ta.value === '*italic*', ta.value);

      ta.value = 'code here';
      setSel(ta, 0, 4);
      clickMd(window, doc, 'code');
      check('T4 行内代码包裹', ta.value === '`code` here', ta.value);
      dom.window.close();
    }

    // ------------------------------------------------ T5 标题
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = '第一行\n第二行';
      setSel(ta, 0, ta.value.length);
      clickMd(window, doc, 'h2');
      check('T5 多行二级标题', ta.value === '## 第一行\n## 第二行', JSON.stringify(ta.value));

      clickMd(window, doc, 'h1');
      check('T5 切换为一级标题（替换而非叠加）', ta.value === '# 第一行\n# 第二行', JSON.stringify(ta.value));

      clickMd(window, doc, 'h1');
      check('T5 再点一次取消标题', ta.value === '第一行\n第二行', JSON.stringify(ta.value));

      ta.value = '正文';
      setSel(ta, 0, 0);
      clickMd(window, doc, 'h3');
      check('T5 空选区加三级标题', ta.value === '### 正文', ta.value);
      dom.window.close();
    }

    // ------------------------------------------------ T6 列表 / T7 引用
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = '甲\n乙\n丙';
      setSel(ta, 0, ta.value.length);
      clickMd(window, doc, 'ul');
      check('T6 无序列表多行', ta.value === '- 甲\n- 乙\n- 丙', JSON.stringify(ta.value));
      clickMd(window, doc, 'ul');
      check('T6 无序列表可取消且内容不丢', ta.value === '甲\n乙\n丙', JSON.stringify(ta.value));

      clickMd(window, doc, 'ol');
      check('T6 有序列表按行编号', ta.value === '1. 甲\n2. 乙\n3. 丙', JSON.stringify(ta.value));
      clickMd(window, doc, 'ol');
      check('T6 有序列表可取消', ta.value === '甲\n乙\n丙', JSON.stringify(ta.value));

      clickMd(window, doc, 'quote');
      check('T7 引用多行', ta.value === '> 甲\n> 乙\n> 丙', JSON.stringify(ta.value));
      clickMd(window, doc, 'quote');
      check('T7 引用可取消', ta.value === '甲\n乙\n丙', JSON.stringify(ta.value));
      dom.window.close();
    }

    // ------------------------------------------------ T8 代码块
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      const lang = doc.getElementById('editorCodeLang');

      ta.value = '';
      setSel(ta, 0, 0);
      lang.value = 'python';
      clickMd(window, doc, 'codeblock');
      check('T8 空选区插入带语言的代码块',
        ta.value === '```python\n在这里写代码\n```', JSON.stringify(ta.value));
      check('T8 占位代码被选中', selOf(ta) === '在这里写代码', selOf(ta));

      ta.value = '第一行\n第二行\n第三行';
      setSel(ta, 0, ta.value.length);
      lang.value = '';
      clickMd(window, doc, 'codeblock');
      check('T8 多行选区整体包进代码块，换行与内容不丢',
        ta.value === '```\n第一行\n第二行\n第三行\n```', JSON.stringify(ta.value));

      clickMd(window, doc, 'codeblock');
      check('T8 代码块可取消（去掉围栏）', ta.value === '第一行\n第二行\n第三行', JSON.stringify(ta.value));

      // 只选中第二行的中间：整行被包住，不能丢字符
      ta.value = 'a\nbcdef\nc';
      setSel(ta, 3, 5);
      clickMd(window, doc, 'codeblock');
      check('T8 行内选区按整行加围栏且不丢内容',
        ta.value === 'a\n```\nbcdef\n```\nc', JSON.stringify(ta.value));
      dom.window.close();
    }

    // ------------------------------------------------ T9 表格 / 分割线
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = '';
      setSel(ta, 0, 0);
      clickMd(window, doc, 'table');
      check('T9 表格三行结构',
        ta.value === '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |', JSON.stringify(ta.value));
      check('T9 选中第一个表头单元格占位', selOf(ta) === '列 1', selOf(ta));

      ta.value = 'abc';
      setSel(ta, 3, 3);
      clickMd(window, doc, 'hr');
      check('T9 分割线独立成行', ta.value === 'abc\n---\n', JSON.stringify(ta.value));
      dom.window.close();
    }

    // ------------------------------------------------ T10 链接 / T11 混排
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = '点这里';
      setSel(ta, 0, 3);
      clickMd(window, doc, 'link');
      check('T10 选区作为链接文本', ta.value === '[点这里](https://)', ta.value);
      check('T10 URL 段被选中（下一步就是粘贴地址）', selOf(ta) === 'https://', selOf(ta));

      ta.value = '';
      setSel(ta, 0, 0);
      clickMd(window, doc, 'link');
      check('T10 无选区：占位文字为链接文本', ta.value === '[链接文字](https://)', ta.value);
      check('T10 无选区：选中占位文字', selOf(ta) === '链接文字', selOf(ta));

      ta.value = '中文 and English 混排';
      setSel(ta, 0, ta.value.length);
      clickMd(window, doc, 'bold');
      check('T11 中英混排加粗不破坏内容',
        ta.value === '**中文 and English 混排**' && selOf(ta) === '中文 and English 混排',
        JSON.stringify(ta.value));

      ta.value = 'https://example.com/a_b?c=1';
      setSel(ta, 0, ta.value.length);
      clickMd(window, doc, 'link');
      check('T10 选区是 URL 时用作目标地址，文本用占位',
        ta.value === '[链接文字](https://example.com/a_b?c=1)', ta.value);
      dom.window.close();
    }

    // ------------------------------------------------ T12 焦点保持
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      ta.value = 'focus test';
      setSel(ta, 0, 5);

      const btn = doc.querySelector('#editorToolbar [data-md="bold"]');
      const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
      btn.dispatchEvent(down);
      check('T12 工具栏 mousedown 被阻止默认（不抢焦点）', down.defaultPrevented === true);
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      check('T12 操作后焦点仍在 textarea', doc.activeElement === ta, doc.activeElement && doc.activeElement.id);
      check('T12 操作后选区正确', selOf(ta) === 'focus', selOf(ta));
      dom.window.close();
    }

    // ------------------------------------------------ T13 输入联动
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      ta.value = 'x';
      setSel(ta, 0, 1);

      const before = doc.getElementById('editorPreview').textContent;
      let inputCount = 0;
      ta.addEventListener('input', () => { inputCount++; });

      clickMd(window, doc, 'bold');
      check('T13 工具栏操作派发了 input 事件', inputCount === 1, inputCount);
      check('T13 预览已更新', doc.getElementById('editorPreview').textContent !== before ||
        /x/.test(doc.getElementById('editorPreview').innerHTML));

      window.saveDraft();
      const draft = JSON.parse(window.localStorage.getItem('blog_draft') || 'null');
      check('T13 草稿已保存（含格式化后的正文）', !!draft && draft.content === '**x**', draft && draft.content);
      check('T13 状态栏显示本地草稿已保存',
        /本地草稿：已保存/.test(doc.querySelector('[data-stat="draft"]').textContent),
        doc.querySelector('[data-stat="draft"]').textContent);
      dom.window.close();
    }

    // ------------------------------------------------ T14/T15/T16/T17 快捷键
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);

      ta.value = 'abc';
      setSel(ta, 0, 3);
      let e = key(window, ta, { key: 'b', ctrlKey: true });
      check('T14 Ctrl+B 加粗', ta.value === '**abc**' && e.defaultPrevented, ta.value);

      ta.value = 'abc';
      setSel(ta, 0, 3);
      key(window, ta, { key: 'i', ctrlKey: true });
      check('T14 Ctrl+I 斜体', ta.value === '*abc*', ta.value);

      ta.value = 'abc';
      setSel(ta, 0, 3);
      key(window, ta, { key: 'k', ctrlKey: true });
      check('T14 Ctrl+K 链接', ta.value === '[abc](https://)', ta.value);

      ta.value = 'x';
      setSel(ta, 0, 1);
      e = key(window, ta, { key: 'b', metaKey: true });
      check('T14 Cmd+B（macOS）同样生效', ta.value === '**x**', ta.value);

      ta.value = 'a\nb';
      setSel(ta, 2, 2);
      e = key(window, ta, { key: 'Tab' });
      check('T14 Tab 插入 2 空格缩进', ta.value === 'a\n  b', JSON.stringify(ta.value));
      check('T14 Tab 被处理（不跳焦点）', e.defaultPrevented === true);

      setSel(ta, 2, ta.value.length);
      key(window, ta, { key: 'Tab', shiftKey: true });
      check('T14 Shift+Tab 取消缩进', ta.value === 'a\nb', JSON.stringify(ta.value));

      e = key(window, ta, { key: 'z', ctrlKey: true });
      check('T15 Ctrl+Z 不拦截（保留原生撤销）', e.defaultPrevented === false);
      e = key(window, ta, { key: 'z', ctrlKey: true, shiftKey: true });
      check('T15 Ctrl+Shift+Z 不拦截（保留原生重做）', e.defaultPrevented === false);

      ta.value = 'ime';
      setSel(ta, 0, 3);
      e = key(window, ta, { key: 'b', ctrlKey: true, isComposing: true });
      check('T16 输入法组合期间不处理快捷键', ta.value === 'ime' && e.defaultPrevented === false, ta.value);
      e = key(window, ta, { key: 'b', ctrlKey: true, keyCode: 229 });
      check('T16 keyCode 229 同样跳过', ta.value === 'ime' && e.defaultPrevented === false, ta.value);

      // 其它输入框：快捷键监听只绑定在正文上
      const title = doc.getElementById('editorTitle');
      title.value = 'title';
      title.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
      title.dispatchEvent(ev);
      check('T17 标题框的 Ctrl+B 不被拦截', ev.defaultPrevented === false);
      check('T17 标题框输入不影响正文', ta.value === 'ime', ta.value);
      dom.window.close();
    }

    // ------------------------------------------------ T18 execCommand 优先
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      ta.value = 'abc';
      setSel(ta, 0, 3);

      const calls = [];
      doc.execCommand = function (cmd, ui, val) {
        calls.push([cmd, val]);
        // 模拟浏览器：替换当前选区
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + val + ta.value.slice(e);
        ta.setSelectionRange(s + String(val).length, s + String(val).length);
        return true;
      };
      let manualInput = 0;
      ta.addEventListener('input', () => { manualInput++; });

      clickMd(window, doc, 'bold');
      check('T18 优先调用 execCommand(insertText)', calls.length === 1 && calls[0][0] === 'insertText', JSON.stringify(calls));
      check('T18 execCommand 收到完整替换文本', calls[0][1] === '**abc**', calls[0][1]);
      check('T18 execCommand 路径不重复派发 input（浏览器会自己发）', manualInput === 0, manualInput);
      dom.window.close();
    }

    // ------------------------------------------------ T19 状态栏
    {
      const { dom, window, doc } = await openEditor();
      const ta = taOf(doc);
      ta.value = '中文四个字 hello world foo';
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));

      const stat = k => doc.querySelector('[data-stat="' + k + '"]');
      check('T19 字数统计（非空白字符）', /^18 字$/.test(stat('chars').textContent), stat('chars').textContent);
      check('T19 英文词数', /3 个英文词/.test(stat('words').textContent), stat('words').textContent);
      check('T19 阅读时间', /≈ 1 分钟/.test(stat('minutes').textContent), stat('minutes').textContent);
      check('T19 显示新增模式', stat('mode').textContent === '新增模式', stat('mode').textContent);
      check('T19 新增模式隐藏文章 id', stat('id').hasAttribute('hidden'));
      check('T19 草稿状态明确写"本地草稿"', /本地草稿/.test(stat('draft').textContent), stat('draft').textContent);
      dom.window.close();
    }

    // ------------------------------------------------ T20 编辑模式
    {
      const { dom, window, doc } = await openEditor('#/editor/' + TARGET);
      const ta = taOf(doc);
      const diskBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', TARGET + '.md'), 'utf8');

      check('T20 编辑模式标题正确', doc.querySelector('[data-stat="mode"]').textContent === '编辑模式',
        doc.querySelector('[data-stat="mode"]').textContent);
      check('T20 显示文章 id', !doc.querySelector('[data-stat="id"]').hasAttribute('hidden') &&
        doc.querySelector('[data-stat="id"]').textContent.indexOf(TARGET) !== -1,
        doc.querySelector('[data-stat="id"]').textContent);

      setSel(ta, 0, 0);
      clickMd(window, doc, 'bold');
      const payload = window.buildUpdatePayload();
      check('T20 编辑后仍能生成更新稿', payload.ok === true, payload.error);
      check('T20 original 快照未受影响（仍是磁盘原文）', payload.payload.original.content === diskBody);
      check('T20 更新稿 id 保持原文章', payload.payload.id === TARGET);
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
