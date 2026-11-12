/**
 * Batch 8A：编辑器「导出文章」契约测试
 *
 * 契约（见 BATCH8A_REPORT.md「导出文件规范」）：
 *   导出物是一份 UTF-8 JSON，字段固定为 id/title/date/tags/excerpt/content；
 *   编辑器**不联网**、不写仓库、不碰历史文章；导出 ≠ 上线。
 *
 * 覆盖：
 *   E1  正常文章：字段齐全、顺序固定、可被 JSON.parse 与导入器接受
 *   E2  中文标题：UTF-8 不损坏（正文/标题/标签逐字一致）
 *   E3  Markdown 代码块原样保留（不转义、不丢反引号与语言标记）
 *   E4  特殊字符：<>&"'`\ 与 emoji 原样往返
 *   E5  空标题 / 空正文：拒绝导出，且草稿保留
 *   E6  非法 id（路径逃逸）/ 超长 id：拒绝导出
 *   E7  重复 id：与已有文章冲突时拒绝导出
 *   E8  文件名规范：<id>.json，且不含路径分隔符
 *   E9  导出成功文案必须写"尚未上线"，不得出现"已上线/发布成功"
 *   E10 导出后草稿保留，用户可继续编辑并再次导出（内容跟着更新）
 *   E11 导出失败（下载抛错）→ 明确报错 + 草稿保留
 *   E12 导出全程零网络请求（fetch 计数为 0）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8151;
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
  if (p.endsWith('/')) p += 'index.html';
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
  vc.on('error', (...a) => errors.push(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html#/editor', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(400);
  return { dom, window: dom.window, doc: dom.window.document, errors };
}

function fill(doc, title, content, tags, excerpt) {
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorTags').value = tags === undefined ? '测试, 技术笔记' : tags;
  doc.getElementById('editorExcerpt').value = excerpt === undefined ? '摘要' : excerpt;
  doc.getElementById('editorContent').value = content;
}

function statusText(doc) {
  return doc.getElementById('editorStatus').textContent;
}

function readDraft(window) {
  try { return JSON.parse(window.localStorage.getItem('blog_draft') || 'null'); } catch (e) { return null; }
}

const CODE_BLOCK = '```python\n' +
  'def hello(name):\n' +
  '    # 中文注释：打印 <hello> & "world"\n' +
  '    print("你好, " + name)\n' +
  '```\n';

const SPECIAL = '行内 `code` 与 <b>标签</b>、引号 "双" 与 \'单\'、反斜杠 \\、& 与 emoji 🚀🇨🇳。';

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ E1/E2/E3/E4 正常导出
    {
      const { dom, window, doc, errors } = await openEditor();
      const downloads = [];
      window.__downloadText = (text, filename) => downloads.push({ text, filename });
      let fetched = 0;
      const realFetch = window.fetch;
      window.fetch = function () { fetched++; return realFetch.apply(this, arguments); };

      // 代码块放在中间：编辑器会 trim 正文首尾空白（末尾换行不算内容）
      fill(doc, '中文标题：Batch 8A 导出契约',
        '# 一级标题\n\n' + SPECIAL + '\n\n' + CODE_BLOCK + '\n结尾段落。\n',
        '中文标签, 技术笔记');
      const payload = window.buildExportPayload();

      check('E1 导出计划成功', payload.ok === true, payload.error);
      check('E1 字段集合固定', payload.ok &&
        Object.keys(payload.post).join(',') === 'id,title,date,tags,excerpt,content', payload.ok && Object.keys(payload.post).join(','));
      check('E1 文本是合法 JSON', (() => {
        try { JSON.parse(payload.text); return true; } catch (e) { return false; }
      })());
      check('E1 文本以单换行结尾（文件型 JSON）', /[^\n]\n$/.test(payload.text || ''));
      check('E1 id 合法（导入器的 SAFE_ID）', /^[a-z0-9][a-z0-9-]*$/.test(payload.post.id), payload.post.id);
      check('E1 date 是真实日期格式', /^\d{4}-\d{2}-\d{2}$/.test(payload.post.date), payload.post.date);
      check('E1 tags 已按逗号切分', payload.post.tags.join('|') === '中文标签|技术笔记', payload.post.tags.join('|'));

      check('E2 中文标题逐字保留', payload.post.title === '中文标题：Batch 8A 导出契约', payload.post.title);
      check('E2 字节层是 UTF-8（不解码成乱码）',
        Buffer.from(payload.text, 'utf8').toString('utf8') === payload.text);
      check('E3 代码块原样保留（含语言标记与反引号）',
        payload.post.content.indexOf(CODE_BLOCK) !== -1);
      check('E3 代码块没有被 HTML 转义', payload.post.content.indexOf('&lt;') === -1);
      check('E4 特殊字符逐字保留', payload.post.content.indexOf(SPECIAL) !== -1);
      check('E4 emoji 保留', payload.post.content.indexOf('🚀') !== -1);

      // 真正走一次导出，捕获下载内容
      const ok = window.exportPost();
      await wait(60);
      check('E1 exportPost 返回成功', ok === true);
      check('E1 只触发一次下载', downloads.length === 1, downloads.length);
      check('E1 下载内容与 buildExportPayload 一致', downloads[0] && downloads[0].text === payload.text);
      check('E8 文件名是 <id>.json 且无路径分隔符',
        downloads[0] && downloads[0].filename === payload.post.id + '.json' &&
        !/[\\/]/.test(downloads[0].filename), downloads[0] && downloads[0].filename);

      check('E9 成功文案写明尚未上线', /尚未上线/.test(statusText(doc)), statusText(doc).slice(0, 60));
      check('E9 成功文案不谎称已上线/发布成功',
        !/已上线|发布成功|已发布/.test(statusText(doc)), statusText(doc).slice(0, 60));
      check('E10 导出后草稿保留', readDraft(window) !== null);
      check('E10 草稿里有完整正文（草稿保留原始输入，导出内容按 trim 规范）',
        ((readDraft(window) || {}).content || '').trim() === payload.post.content);

      check('E12 导出全程零网络请求', fetched === 0, fetched);
      check('E1 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }

    // ------------------------------------------------ E10 导出后可继续编辑并再次导出
    {
      const { dom, window, doc } = await openEditor();
      const downloads = [];
      window.__downloadText = (text, filename) => downloads.push({ text, filename });
      fill(doc, '导出后继续编辑', '# 第一版\n');
      const first = window.buildExportPayload();
      window.exportPost();
      await wait(40);

      // 用户接着改正文（含重新生成 id 的情况由标题决定，这里改正文）
      doc.getElementById('editorContent').value = '# 第二版\n\n改过的正文。\n';
      const second = window.buildExportPayload();
      window.exportPost();
      await wait(40);

      check('E10 再次导出内容已更新',
        second.ok && second.post.content.indexOf('第二版') !== -1 && downloads.length === 2, downloads.length);
      check('E10 两次导出使用同一 id（可覆盖同一文件）',
        first.ok && second.ok && first.post.id === second.post.id, first.post.id + ' / ' + second.post.id);
      check('E10 草稿更新为最新内容',
        (readDraft(window) || {}).content === '# 第二版\n\n改过的正文。\n');
      dom.window.close();
    }

    // ------------------------------------------------ E5 空标题 / 空正文
    {
      const { dom, window, doc } = await openEditor();
      const downloads = [];
      window.__downloadText = (text, filename) => downloads.push({ text, filename });

      fill(doc, '', '# 有正文\n');
      const noTitle = window.buildExportPayload();
      const okTitle = window.exportPost();
      await wait(40);
      check('E5 空标题拒绝导出', noTitle.ok === false && /标题不能为空/.test(noTitle.error), noTitle.error);
      check('E5 空标题不产生下载', downloads.length === 0 && okTitle === false);
      check('E5 空标题有明确提示', /标题不能为空/.test(statusText(doc)), statusText(doc).slice(0, 40));

      fill(doc, '有标题没正文', '   \n  ');
      const noBody = window.buildExportPayload();
      const okBody = window.exportPost();
      await wait(40);
      check('E5 空正文拒绝导出', noBody.ok === false && /正文不能为空/.test(noBody.error), noBody.error);
      check('E5 空正文不产生下载', downloads.length === 0 && okBody === false);
      check('E5 空正文提示草稿已保留', /草稿已保留/.test(statusText(doc)), statusText(doc).slice(0, 50));
      dom.window.close();
    }

    // ------------------------------------------------ E6 非法 id / 超长 id
    {
      const { dom, window, doc } = await openEditor();
      const downloads = [];
      window.__downloadText = (text, filename) => downloads.push({ text, filename });

      window.eval("generatePostId = function () { return '../../etc/passwd'; };");
      fill(doc, '路径逃逸', '# x\n');
      const bad = window.buildExportPayload();
      check('E6 路径逃逸 id 被拒绝', bad.ok === false && /id 非法/.test(bad.error), bad.error);
      check('E6 路径逃逸不产生下载', window.exportPost() === false && downloads.length === 0);

      window.eval("generatePostId = function () { return 'a'.repeat(80); };");
      fill(doc, '超长 id', '# x\n');
      const longId = window.buildExportPayload();
      check('E6 超长 id 被拒绝', longId.ok === false && /过长/.test(longId.error), longId.error);

      window.eval("generatePostId = function () { return 'UPPER_CASE'; };");
      fill(doc, '大写 id', '# x\n');
      const upper = window.buildExportPayload();
      check('E6 大写/下划线 id 被拒绝', upper.ok === false && /id 非法/.test(upper.error), upper.error);
      dom.window.close();
    }

    // ------------------------------------------------ E7 与已有文章重复 id
    {
      const { dom, window, doc } = await openEditor();
      const downloads = [];
      window.__downloadText = (text, filename) => downloads.push({ text, filename });
      const existing = doc.getElementById('app').ownerDocument.defaultView.eval('POSTS[0].id');
      window.eval("generatePostId = function () { return '" + existing + "'; };");
      fill(doc, '撞已有 id', '# x\n');
      const dup = window.buildExportPayload();
      check('E7 重复 id 被本地拦截', dup.ok === false && /id 冲突/.test(dup.error), dup.error);
      check('E7 重复 id 不产生下载', window.exportPost() === false && downloads.length === 0);
      dom.window.close();
    }

    // ------------------------------------------------ E11 导出失败（下载抛错）
    {
      const { dom, window, doc } = await openEditor();
      window.__downloadText = function () { throw new Error('disk full'); };
      fill(doc, '下载会失败的文章', '# 不能丢的草稿\n\n正文。\n');
      const ok = window.exportPost();
      await wait(40);
      check('E11 导出失败返回 false', ok === false);
      check('E11 导出失败有明确提示', /导出失败/.test(statusText(doc)) && /disk full/.test(statusText(doc)),
        statusText(doc).slice(0, 60));
      check('E11 导出失败不平白谎称上线', !/已上线|发布成功/.test(statusText(doc)));
      check('E11 导出失败草稿保留',
        (readDraft(window) || '').content !== undefined &&
        /不能丢的草稿/.test((readDraft(window) || {}).content || ''),
        JSON.stringify(readDraft(window)).slice(0, 60));
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
