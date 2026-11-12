/**
 * Batch 8B-1：编辑器「编辑已有文章」契约测试（jsdom）
 *
 * 契约（见 BATCH8B1_REPORT.md）：
 *   #/editor          新增模式（8A 行为不变）
 *   #/editor/<id>     编辑模式：id 固定、链接不变、导出「更新稿」JSON
 *
 * 覆盖：
 *   E1  文章选择器列出全部文章（兼容期来源标为只读）
 *   E2  打开已有文章：标题 / 日期 / 标签 / 摘要 / 正文全部回填，模式=edit
 *   E3  改标题不产生新 id（id 来自原文章，不由标题生成）
 *   E4  日期默认沿用原日期；改日期才变；非法日期被拦截
 *   E5  预览继续走 DOMPurify（脚本标签与内联事件都被净化）
 *   E6  未修改 → 明确提示"内容没有变化"，不产生文件
 *   E7  修改正文 → 更新稿结构正确（op/id/original/post）、文件名规范
 *   E8  重复导出同样的修改 → 字节完全一致（可复现）
 *   E9  导出成功只承诺"本地文件，站点尚未更新"
 *   E10 正文加载失败 → 提示错误，且**不清除**当前草稿
 *   E11 兼容期文章（js/user-posts.js）→ 明确只读，不提供编辑表单
 *   E12 新增模式与编辑模式草稿互不覆盖
 *   E13 浏览器前进 / 后退能回到编辑模式且内容正确
 *   E14 不存在的 id → 明确提示文章不存在
 *   E15 全程零写入请求（只允许同源 GET 静态文件）
 *   E16 POSTS / USER_POSTS 在编辑与导出前后完全不变
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8161;
const BASE = 'http://localhost:' + PORT;
const TARGET = 'embodied-ai-notes';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml'
};

const log = [];              // { method, url }
const blocked = new Set();   // 需要模拟 404 的路径

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  log.push({ method: req.method, url: p });
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (blocked.has(p) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 110) + ')' : ''));
};

async function openPage(hash) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(e.message)) {
      errors.push(e.message);
    }
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html' + (hash || ''), {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  const { window } = dom;
  await new Promise(r => window.addEventListener('load', r));
  await wait(400);
  window.__downloads = [];
  window.__downloadText = function (text, filename) {
    window.__downloads.push({ text: text, filename: filename });
  };
  return { dom, window, doc: window.document, errors };
}

async function go(window, hash, ms) {
  window.location.hash = hash;
  await wait(ms || 500);
}

const draftJson = (window, key) => {
  try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (e) { return null; }
};

const postMeta = (window, id) =>
  JSON.parse(window.eval('JSON.stringify(POSTS.find(function (p) { return p.id === "' + id + '"; }) || null)'));

const bodyOf = id => fs.readFileSync(path.join(ROOT, 'data', 'posts', id + '.md'), 'utf8');

const ctxOf = window => window.editorContext();

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ E1/E2/E3/E4/E5
    {
      const { dom, window, doc, errors } = await openPage('#/editor');
      const meta = postMeta(window, TARGET);
      const body = bodyOf(TARGET);
      log.length = 0;

      const picker = doc.getElementById('editorPostPicker');
      check('E1 编辑器提供文章选择器', !!picker);
      check('E1 选择器列出了全部文章', picker && picker.options.length === window.eval('getAllPosts().length') + 1,
        picker && picker.options.length);
      check('E1 选项里带标题与日期', picker && picker.options[1].textContent.indexOf('（') !== -1,
        picker && picker.options[1] && picker.options[1].textContent);
      check('E1 新增模式默认不选中任何文章', picker && picker.value === '');
      check('E1 新增模式没有日期输入框', doc.getElementById('editorDate') === null);
      check('E1 新增模式标为"新增模式"', /新增模式/.test(doc.body.textContent));

      // 通过选择器进入编辑模式（等价于用户下拉选择）
      picker.value = TARGET;
      picker.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(700);

      check('E2 路由切到 #/editor/<id>', window.location.hash === '#/editor/' + TARGET, window.location.hash);
      check('E2 模式为 edit 且 id 正确',
        ctxOf(window).mode === 'edit' && ctxOf(window).id === TARGET, JSON.stringify(ctxOf(window)));
      check('E2 标题已回填', doc.getElementById('editorTitle').value === meta.title, doc.getElementById('editorTitle').value);
      check('E2 标签已回填（逗号分隔）', doc.getElementById('editorTags').value === meta.tags.join(', '),
        doc.getElementById('editorTags').value);
      check('E2 摘要已回填', doc.getElementById('editorExcerpt').value === meta.excerpt);
      check('E2 正文已回填（与磁盘一致）', doc.getElementById('editorContent').value === body,
        doc.getElementById('editorContent').value.slice(0, 30));
      check('E2 日期已回填', doc.getElementById('editorDate').value === meta.date, doc.getElementById('editorDate').value);
      check('E2 标题区显示"编辑文章"', /编辑文章/.test(doc.querySelector('.page-title').textContent));
      check('E2 显示固定的 id 徽标', /id:/.test(doc.querySelector('.editor-badge-edit').textContent) &&
        doc.querySelector('.editor-badge-edit').textContent.indexOf(TARGET) !== -1);
      check('E2 导出按钮文案变为"导出更新稿"', /导出更新稿/.test(doc.querySelector('button[onclick="exportPost()"]').textContent));

      // E3：改标题
      doc.getElementById('editorTitle').value = '改过的标题不会改 id';
      const p3 = window.buildUpdatePayload();
      check('E3 改标题后 id 仍然不变', p3.ok && p3.payload.id === TARGET, p3.ok && p3.payload.id);
      check('E3 post.id 与顶层 id 一致', p3.ok && p3.payload.post.id === p3.payload.id);
      check('E3 original 里保留原标题', p3.ok && p3.payload.original.title === meta.title);

      // E4：日期
      doc.getElementById('editorTitle').value = meta.title;
      const p4 = window.buildUpdatePayload();
      check('E4 未改任何字段时识别为"没有变化"', p4.ok === false && p4.unchanged === true, p4.error);

      doc.getElementById('editorDate').value = '2026-02-30';
      doc.getElementById('editorContent').value = body + '\n补充一句。\n';
      const p4bad = window.buildUpdatePayload();
      check('E4 非法日期被拦截', p4bad.ok === false && /日期必须/.test(p4bad.error), p4bad.error);

      doc.getElementById('editorDate').value = '2026-03-04';
      const p4ok = window.buildUpdatePayload();
      check('E4 改成合法日期后可以导出', p4ok.ok === true && p4ok.payload.post.date === '2026-03-04',
        p4ok.ok && p4ok.payload.post.date);
      check('E4 original 里的日期仍是原值', p4ok.payload.original.date === meta.date);

      // E5：预览净化
      doc.getElementById('editorDate').value = meta.date;
      const content = doc.getElementById('editorContent');
      content.value = '# 标题\n\n<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>\n';
      content.dispatchEvent(new window.Event('input', { bubbles: true }));
      await wait(120);
      const preview = doc.getElementById('editorPreview');
      check('E5 预览里没有 script 标签', preview.querySelectorAll('script').length === 0);
      check('E5 预览里没有 onerror 内联事件', preview.innerHTML.indexOf('onerror') === -1, preview.innerHTML.slice(0, 60));
      check('E5 注入的脚本没有被执行', window.__pwned === undefined);

      check('E1–E5 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }

    // ------------------------------------------------ E6/E7/E8/E9/E16
    {
      const { dom, window, doc } = await openPage('#/editor/' + TARGET);
      const meta = postMeta(window, TARGET);
      const body = bodyOf(TARGET);
      const before = window.eval('JSON.stringify({ p: POSTS.map(function (x) { return x.id; }), u: USER_POSTS.length })');

      check('E6 未修改时导出被拒绝', window.exportPost() === false);
      check('E6 未修改时不产生文件', window.__downloads.length === 0);
      check('E6 明确提示"内容没有变化"', /内容没有变化/.test(doc.getElementById('editorStatus').textContent),
        doc.getElementById('editorStatus').textContent.slice(0, 40));

      doc.getElementById('editorContent').value = body + '\n\n这是新增的一段：中文 + `code` + 🚀。\n';
      const p7 = window.buildUpdatePayload();
      check('E7 修改后可以生成更新稿', p7.ok === true, p7.error);
      check('E7 文件名是 <id>.update.json', p7.filename === TARGET + '.update.json', p7.filename);
      check('E7 顶层字段固定为 op/id/original/post',
        Object.keys(p7.payload).join(',') === 'op,id,original,post', Object.keys(p7.payload).join(','));
      check('E7 op 是 update', p7.payload.op === 'update');
      check('E7 original 是完整原版本快照',
        p7.payload.original.content === body &&
        p7.payload.original.title === meta.title &&
        p7.payload.original.date === meta.date &&
        p7.payload.original.tags.join('|') === meta.tags.join('|') &&
        p7.payload.original.excerpt === meta.excerpt);
      check('E7 post.content 是修改后的正文', /这是新增的一段/.test(p7.payload.post.content));
      check('E7 post 不含 original 字段', p7.payload.post.original === undefined);

      check('E7 exportPost 成功', window.exportPost() === true);
      await wait(60);
      check('E7 只产生一个下载', window.__downloads.length === 1, window.__downloads.length);
      check('E7 下载内容就是更新稿', window.__downloads[0] && window.__downloads[0].text === p7.text);
      check('E7 下载内容可被 JSON.parse',
        (function () { try { JSON.parse(window.__downloads[0].text); return true; } catch (e) { return false; } })());

      const p8 = window.buildUpdatePayload();
      check('E8 重复导出同样的修改 → 字节完全一致', p8.text === p7.text);

      const status = doc.getElementById('editorStatus').textContent;
      check('E9 成功文案写明"站点尚未更新"', /站点尚未更新/.test(status), status.slice(0, 50));
      check('E9 不谎称已上线/已更新完成', !/已上线|更新成功/.test(status), status.slice(0, 50));
      check('E9 文案给出 --mode update 命令', /--mode update/.test(doc.getElementById('editorStatus').innerHTML));
      check('E16 POSTS / USER_POSTS 未被编辑器改动',
        window.eval('JSON.stringify({ p: POSTS.map(function (x) { return x.id; }), u: USER_POSTS.length })') === before);
      dom.window.close();
    }

    // ------------------------------------------------ E10 加载失败保草稿
    {
      const { dom, window, doc } = await openPage('#/editor/' + TARGET);
      doc.getElementById('editorTitle').value = '还没保存的编辑稿';
      doc.getElementById('editorContent').value = bodyOf(TARGET) + '\n草稿内容不能丢。\n';
      window.saveDraft();
      const draftBefore = draftJson(window, 'blog_draft_edit::' + TARGET);
      check('E10 前置：编辑草稿已保存', !!draftBefore && /不能丢/.test(draftBefore.content));

      const other = window.eval('POSTS.filter(function (p) { return p.id !== "' + TARGET + '"; })[0].id');
      blocked.add('/data/posts/' + other + '.md');
      await go(window, '#/editor/' + other, 800);
      blocked.delete('/data/posts/' + other + '.md');

      check('E10 加载失败有明确提示', /加载失败/.test(doc.body.textContent), doc.body.textContent.slice(0, 40));
      check('E10 打开失败的文章不产生编辑表单', doc.getElementById('editorContent') === null);
      check('E10 加载失败后原草稿仍在', (draftJson(window, 'blog_draft_edit::' + TARGET) || {}).content ===
        draftBefore.content);
      check('E10 模式被标记为 blocked', ctxOf(window).mode === 'blocked', JSON.stringify(ctxOf(window)));
      dom.window.close();
    }

    // ------------------------------------------------ E11 兼容期文章只读
    {
      const { dom, window, doc } = await openPage('#/editor');
      window.eval("USER_POSTS.push({ id: 'legacy-demo', title: '旧编辑器文章', date: '2026-10-01', tags: ['测试'], excerpt: '摘要', content: '# 旧\\n\\n正文。\\n' });");
      await go(window, '#/editor/legacy-demo', 600);
      const text = doc.body.textContent;
      check('E11 兼容期文章明确提示只读', /只读/.test(text) && /user-posts\.js/.test(doc.body.innerHTML), text.slice(0, 40));
      check('E11 不提供编辑表单（不会被覆盖）', doc.getElementById('editorContent') === null);
      check('E11 提示需先迁移到 data/posts', /data\/posts\/legacy-demo\.md/.test(doc.body.innerHTML));
      await go(window, '#/editor', 500);
      const opt = Array.prototype.slice.call(doc.querySelectorAll('#editorPostPicker option'))
        .filter(o => o.value === 'legacy-demo')[0];
      check('E11 选择器标注"只读"', !!opt && /只读/.test(opt.textContent), opt && opt.textContent);
      dom.window.close();
    }

    // ------------------------------------------------ E12 草稿互不覆盖
    {
      const { dom, window, doc } = await openPage('#/editor/' + TARGET);
      const meta = postMeta(window, TARGET);
      doc.getElementById('editorTitle').value = '编辑模式的草稿标题';
      window.saveDraft();
      check('E12 编辑草稿写入独立键', !!draftJson(window, 'blog_draft_edit::' + TARGET));

      await go(window, '#/editor', 500);
      check('E12 回到新增模式时标题为空（不串稿）', doc.getElementById('editorTitle').value === '',
        doc.getElementById('editorTitle').value);
      doc.getElementById('editorTitle').value = '新增模式的草稿标题';
      doc.getElementById('editorContent').value = '# 新增\n\n正文。\n';
      window.saveDraft();
      const newDraft = draftJson(window, 'blog_draft');
      check('E12 新增草稿写入 blog_draft', newDraft && newDraft.mode === 'new' && newDraft.title === '新增模式的草稿标题');

      await go(window, '#/editor/' + TARGET, 600);
      check('E12 切回编辑模式恢复的是编辑草稿',
        doc.getElementById('editorTitle').value === '编辑模式的草稿标题', doc.getElementById('editorTitle').value);
      check('E12 新增草稿未被覆盖', (draftJson(window, 'blog_draft') || {}).title === '新增模式的草稿标题');
      check('E12 编辑草稿未被新增模式覆盖',
        (draftJson(window, 'blog_draft_edit::' + TARGET) || {}).title === '编辑模式的草稿标题');
      check('E12 原日期没有被草稿流程改掉', doc.getElementById('editorDate').value === meta.date);
      dom.window.close();
    }

    // ------------------------------------------------ E13 前进 / 后退
    {
      const { dom, window, doc } = await openPage('#/editor/' + TARGET);
      const meta = postMeta(window, TARGET);
      doc.getElementById('editorContent').value = bodyOf(TARGET) + '\n后退测试补充。\n';
      window.saveDraft();

      await go(window, '#/', 400);
      check('E13 离开编辑器后回到首页', /文章|arXiv|最新/.test(doc.body.textContent));
      window.history.back();
      await wait(700);
      check('E13 后退回到编辑模式', ctxOf(window).mode === 'edit' && ctxOf(window).id === TARGET,
        JSON.stringify(ctxOf(window)));
      check('E13 后退后正文是草稿内容', /后退测试补充/.test(doc.getElementById('editorContent').value));
      check('E13 后退后仍显示原标题', doc.getElementById('editorTitle').value === meta.title);

      window.history.forward();
      await wait(600);
      check('E13 前进离开编辑器（编辑器 DOM 已卸载，不残留编辑表单）',
        doc.getElementById('editorContent') === null, window.location.hash);
      check('E13 前进后当前路由不是编辑器', (window.location.hash || '').indexOf('#/editor') !== 0,
        window.location.hash);
      dom.window.close();
    }

    // ------------------------------------------------ E17 文章链接不变
    {
      const { dom, window, doc } = await openPage('#/post/' + TARGET);
      const meta = postMeta(window, TARGET);
      check('E17 文章深链仍是 #/post/<id>', window.location.hash === '#/post/' + TARGET, window.location.hash);
      check('E17 深链能渲染出这篇文章', doc.body.textContent.indexOf(meta.title) !== -1, meta.title);
      check('E17 深链的 id 与原文章一致', window.eval('getAllPosts().filter(function (p) { return p.id === "' +
        TARGET + '"; }).length') === 1);
      dom.window.close();
    }

    // ------------------------------------------------ E14 不存在的 id
    {
      const { dom, window, doc } = await openPage('#/editor/no-such-post');
      check('E14 提示文章不存在', /文章不存在/.test(doc.body.textContent), doc.body.textContent.slice(0, 40));
      check('E14 不提供编辑表单', doc.getElementById('editorContent') === null);
      check('E14 提供返回编辑器的入口', /#\/editor/.test(doc.body.innerHTML));
      dom.window.close();
    }

    // ------------------------------------------------ E15 零写入请求
    {
      const nonGet = log.filter(r => r.method !== 'GET');
      check('E15 全程没有非 GET 请求（没有写操作）', nonGet.length === 0,
        nonGet.slice(0, 2).map(r => r.method + ' ' + r.url).join(','));
      const offsite = log.filter(r => String(r.url).indexOf('/') !== 0);
      check('E15 所有请求都是同源绝对路径', offsite.length === 0, offsite.slice(0, 2).map(r => r.url).join(','));
      const bodies = log.filter(r => r.url.indexOf('/data/posts/') === 0 && /\.md$/.test(r.url));
      check('E15 编辑模式确实按需读取过正文', bodies.length > 0, bodies.length);
      check('E15 没有任何 GitHub / API 请求',
        log.every(r => !/api\.github\.com|github\.com\/repos|github\.com\/usercontent/.test(r.url)));
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
