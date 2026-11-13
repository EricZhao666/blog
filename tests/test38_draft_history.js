/**
 * Batch 8B-3：草稿历史与安全恢复契约测试（jsdom）
 *
 * jsdom 没有 IndexedDB → DraftHistory 会自动退化到内存后端，正好可以验证
 * "IndexedDB 不可用 / 隐私模式" 这条降级路径；真实 IndexedDB 由
 * tests/browser/editor-history.spec.js 在 Chromium 里覆盖。
 *
 * 覆盖：
 *   H1  创建快照：字段齐全、只含白名单字段
 *   H2  相同内容去重
 *   H3  自动快照 5 分钟节流 + 内容变化判断
 *   H4  手动快照不受节流限制
 *   H5  新增/编辑、不同文章 id 之间完全隔离
 *   H6  配额：每篇最多 10 条，优先淘汰最旧的自动版本，手动版本保留
 *   H7  删除单条 / 清理当前文章（不影响其它 scope）
 *   H8  轻量 diff：字数、行增删、变化摘要
 *   H9  损坏记录隔离（坏记录被丢弃，正常记录仍可用）
 *   H10 存储空间不足 / 写入失败：返回失败且不影响草稿
 *   H11 IndexedDB 不可用时 init 降级
 *   H12 面板：保存 / 列表 / 安全预览（DOMPurify）
 *   H13 恢复：先备份当前内容，再覆盖；状态栏只承诺本地
 *   H14 恢复中断：备份失败则绝不覆盖
 *   H15 编辑模式恢复后 _editCtx 原文章快照不变
 *   H16 多标签页：storage 事件只提示、不覆盖
 *   H17 刷新后草稿仍在（localStorage 未被动过）
 *   H18 导出契约不变
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8183;
const BASE = 'http://localhost:' + PORT;
const TARGET = 'embodied-ai-notes';
const T0 = 1700000000000;          // 固定基准时间，保证断言可复现
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
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 120) + ')' : ''));
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
  await wait(400);
  w.localStorage.removeItem('blog_draft');
  return { dom, window: w, doc: w.document, errors };
}

const state = (over) => Object.assign({
  title: '标题 A', date: '2026-11-13', tags: ['测试'],
  excerpt: '摘要', content: '# 正文 A\n\n内容。\n'
}, over || {});

function memoryBackend(store) {
  const mem = store || [];
  return {
    name: 'fake',
    listAll: () => Promise.resolve(mem.slice()),
    put: rec => { mem.push(rec); return Promise.resolve(true); },
    remove: id => { const i = mem.findIndex(r => r.id === id); if (i >= 0) mem.splice(i, 1); return Promise.resolve(true); },
    clear: () => { mem.length = 0; return Promise.resolve(true); },
    _mem: mem
  };
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try {
    // ------------------------------------------------ H1/H2 基本 + 去重
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'new', postId: '' });

      const r1 = await DH.snapshot(DH.KINDS.MANUAL, state(), T0);
      check('H1 首次快照成功', r1.ok === true && r1.saved === true, JSON.stringify(r1));
      check('H1 记录数 = 1', r1.count === 1, r1.count);

      const list = await DH.list();
      const rec = list[0];
      check('H1 只保存白名单字段',
        ['id', 'scopeKey', 'scope', 'postId', 'kind', 'savedAt', 'savedAtISO',
          'title', 'date', 'tags', 'excerpt', 'content', 'chars', 'hash', 'tabId']
          .filter(k => !(k in rec)).length === 0,
        Object.keys(rec).join(','));
      check('H1 不含 Token/密码等无关字段',
        !/token|password|secret|auth/i.test(Object.keys(rec).join(',')));
      check('H1 记录内容正确', rec.title === '标题 A' && rec.tags[0] === '测试' && rec.kind === 'manual');
      check('H1 记录带 scopeKey', rec.scopeKey === 'new', rec.scopeKey);
      check('H1 记录带字数', rec.chars > 0, rec.chars);

      const r2 = await DH.snapshot(DH.KINDS.MANUAL, state(), T0 + 1000);
      check('H2 相同内容不重复保存', r2.ok === true && r2.saved === false && r2.skipped === 'duplicate', JSON.stringify(r2));
      check('H2 记录数仍为 1', (await DH.list()).length === 1);

      const r3 = await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# 正文 B\n' }), T0 + 2000);
      check('H2 内容变了就保存', r3.ok === true && r3.saved === true && r3.count === 2, JSON.stringify(r3));
      dom.window.close();
    }

    // ------------------------------------------------ H3/H4 自动节流
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'new', postId: '' });

      const a1 = await DH.maybeAuto(state(), T0);
      check('H3 首次自动快照', a1.ok === true && a1.saved === true, JSON.stringify(a1));
      check('H3 自动记录 kind=auto', (await DH.list())[0].kind === 'auto');

      const a2 = await DH.maybeAuto(state({ content: '# 正文 A2\n' }), T0 + 60 * 1000);
      check('H3 5 分钟内不产生新快照（节流）',
        a2.ok === true && a2.saved === false && a2.skipped === 'throttled', JSON.stringify(a2));

      const a3 = await DH.maybeAuto(state({ content: '# 正文 A3\n' }), T0 + 3 * 60 * 1000);
      check('H3 3 分钟后仍节流', a3.saved === false && a3.skipped === 'throttled');

      const a4 = await DH.maybeAuto(state({ content: '# 正文 A3\n' }), T0 + 6 * 60 * 1000);
      check('H3 超过 5 分钟才保存', a4.ok === true && a4.saved === true, JSON.stringify(a4));

      const a5 = await DH.maybeAuto(state({ content: '# 正文 A3\n' }), T0 + 12 * 60 * 1000);
      check('H3 内容未变仍去重', a5.saved === false && a5.skipped === 'duplicate', JSON.stringify(a5));

      const m1 = await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# 手动\n' }), T0 + 7 * 60 * 1000);
      check('H4 手动保存不受节流限制', m1.ok === true && m1.saved === true, JSON.stringify(m1));
      dom.window.close();
    }

    // ------------------------------------------------ H5 隔离
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());

      DH.configure({ scope: 'new', postId: '' });
      await DH.snapshot(DH.KINDS.MANUAL, state({ title: '新增稿' }), T0);
      const newList = await DH.list();

      DH.configure({ scope: 'edit', postId: 'post-a' });
      await DH.snapshot(DH.KINDS.MANUAL, state({ title: '文章 A' }), T0 + 10);
      const aList = await DH.list();

      DH.configure({ scope: 'edit', postId: 'post-b' });
      const bList = await DH.list();

      check('H5 新增模式与编辑模式互相隔离', newList.length === 1 && aList.length === 1 &&
        newList[0].title === '新增稿' && aList[0].title === '文章 A');
      check('H5 不同文章 id 互相隔离', bList.length === 0, bList.length);
      check('H5 scopeKey 命名可读', newList[0].scopeKey === 'new' && aList[0].scopeKey === 'edit:post-a',
        aList[0].scopeKey);

      DH.configure({ scope: 'edit', postId: 'post-a' });
      check('H5 切回文章 A 仍能看到自己的历史', (await DH.list()).length === 1);
      dom.window.close();
    }

    // ------------------------------------------------ H6 配额
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'new', postId: '' });

      await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# 手动基线\n', title: '手动基线' }), T0);
      for (let i = 0; i < 14; i++) {
        await DH.snapshot(DH.KINDS.AUTO, state({ content: '# 自动 ' + i + '\n' }), T0 + 1000 * (i + 1));
      }
      const list = await DH.list();
      check('H6 超过上限时被裁剪到 10 条', list.length === 10, list.length);
      check('H6 手动版本优先保留', list.some(r => r.kind === 'manual' && r.title === '手动基线'));
      check('H6 被清理的是最旧的自动版本',
        !list.some(r => r.content === '# 自动 0\n') && list.some(r => r.content === '# 自动 13\n'));
      dom.window.close();
    }

    // ------------------------------------------------ H7 删除 / 清理
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());

      DH.configure({ scope: 'new', postId: '' });
      await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# 1\n' }), T0);
      await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# 2\n' }), T0 + 10);

      DH.configure({ scope: 'edit', postId: 'post-a' });
      await DH.snapshot(DH.KINDS.MANUAL, state({ content: '# A\n' }), T0 + 20);

      DH.configure({ scope: 'new', postId: '' });
      const rows = await DH.list();
      const del = await DH.remove(rows[0].id);
      check('H7 删除单条成功', del.ok === true && del.count === 1, JSON.stringify(del));

      const cleared = await DH.clear();
      check('H7 清理当前 scope', cleared.ok === true && (await DH.list()).length === 0);

      DH.configure({ scope: 'edit', postId: 'post-a' });
      check('H7 清理不影响其它 scope', (await DH.list()).length === 1);
      dom.window.close();
    }

    // ------------------------------------------------ H8 diff
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      const oldRec = { content: 'a\nb\nc\n', title: '旧标题', tags: ['x'], excerpt: 'e' };
      const d = DH.diff(oldRec, { content: 'a\nb\nd\ne\n', title: '新标题', tags: ['y'], excerpt: 'e' });

      check('H8 字数对比', d.charsOld === 3 && d.charsNew === 4, d.charsOld + '→' + d.charsNew);
      check('H8 行变化统计', d.addedLines === 2 && d.removedLines === 1, d.addedLines + '/' + d.removedLines);
      check('H8 摘要包含字数与标题变化',
        /字数/.test(d.summary) && /标题/.test(d.summary) && /标签/.test(d.summary), d.summary);
      dom.window.close();
    }

    // ------------------------------------------------ H9 损坏记录
    {
      const { dom, window } = await openEditor();
      const DH = window.DraftHistory;
      const be = memoryBackend([
        { id: 'bad-1', scopeKey: 'new', savedAt: T0 },                       // 缺 content/title
        { id: 'bad-2', scopeKey: 'new', savedAt: 'not-a-number', content: '' },
        null,
        { id: 'ok-1', scopeKey: 'new', scope: 'new', postId: '', kind: 'manual',
          savedAt: T0, title: '好的', date: '2026-11-13', tags: [], excerpt: '',
          content: '# ok\n', chars: 3, hash: 'h' }
      ]);
      DH._resetForTests(be);
      DH.configure({ scope: 'new', postId: '' });
      const rows = await DH.list();
      check('H9 损坏记录被隔离，正常记录仍可见', rows.length === 1 && rows[0].id === 'ok-1', rows.length);
      const snap = await DH.snapshot(DH.KINDS.MANUAL, state(), T0 + 1000);
      check('H9 损坏记录不影响新写入', snap.ok === true && snap.saved === true, JSON.stringify(snap));
      dom.window.close();
    }

    // ------------------------------------------------ H10/H11 存储失败与降级
    {
      const { dom, window, doc } = await openEditor();
      const DH = window.DraftHistory;
      const quotaErr = new Error('quota exceeded');
      quotaErr.name = 'QuotaExceededError';
      const failing = {
        name: 'fake-quota',
        listAll: () => Promise.resolve([]),
        put: () => Promise.reject(quotaErr),
        remove: () => Promise.resolve(true),
        clear: () => Promise.resolve(true)
      };
      DH._resetForTests(failing);
      DH.configure({ scope: 'new', postId: '' });

      const r = await DH.snapshot(DH.KINDS.MANUAL, state(), T0);
      check('H10 空间不足时返回失败', r.ok === false && /空间不足/.test(r.error), r.error);

      const init = await DH.init();
      check('H11 IndexedDB 不可用时降级为内存后端', init.degraded === true && init.backend !== 'idb',
        init.backend + '/' + init.reason);

      // 草稿（localStorage）完全不受影响
      const ta = doc.getElementById('editorContent');
      doc.getElementById('editorTitle').value = '草稿不受影响';
      ta.value = '# 草稿\n';
      window.saveDraft();
      const draft = JSON.parse(window.localStorage.getItem('blog_draft') || 'null');
      check('H10 历史失败不影响本地草稿', !!draft && draft.title === '草稿不受影响', draft && draft.title);
      dom.window.close();
    }

    // ------------------------------------------------ H12 面板 + 安全预览
    {
      const { dom, window, doc } = await openEditor();
      doc.getElementById('editorTitle').value = '面板测试';
      doc.getElementById('editorContent').value = '# 面板\n\n<img src=x onerror="window.__h=1">\n<script>window.__h=2</script>\n';
      window.DraftHistory._resetForTests(memoryBackend());
      window.DraftHistory.configure({ scope: 'new', postId: '' });

      doc.querySelector('button[onclick="saveHistoryVersion()"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(150);

      doc.querySelector('button[onclick="toggleHistoryPanel()"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(150);

      check('H12 面板打开', !doc.getElementById('editorHistoryPanel').hasAttribute('hidden'));
      const items = doc.querySelectorAll('#editorHistoryList .editor-history-item');
      check('H12 列表出现历史条目', items.length === 1, items.length);
      check('H12 列表显示时间/类型/标题/字数',
        /2026-|手动/.test(items[0].textContent) && /面板测试/.test(items[0].textContent) &&
        /\d+ 字/.test(items[0].textContent), items[0].textContent.slice(0, 60));

      const previewBtn = items[0].querySelector('[data-hist="preview"]');
      previewBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(120);

      check('H12 预览面板出现', !doc.getElementById('editorHistoryPreview').hasAttribute('hidden'));
      const html = doc.getElementById('editorHistoryBody').innerHTML;
      check('H12 预览经过净化（无 script / onerror）',
        html.indexOf('<script') === -1 && html.indexOf('onerror') === -1, html.slice(0, 80));
      check('H12 注入脚本未执行', window.__h === undefined);
      check('H12 显示 diff 摘要', /字数/.test(doc.getElementById('editorHistoryDiff').textContent),
        doc.getElementById('editorHistoryDiff').textContent);

      check('H12 面板含"不是云端备份"提示',
        /不是云端备份/.test(doc.getElementById('editorHistoryPanel').textContent));
      dom.window.close();
    }

    // ------------------------------------------------ H13/H14 恢复
    {
      const { dom, window, doc } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'new', postId: '' });
      await DH.snapshot(DH.KINDS.MANUAL,
        state({ title: '历史标题', content: '# 历史正文\n', excerpt: '历史摘要' }), T0);

      doc.getElementById('editorTitle').value = '当前标题';
      doc.getElementById('editorContent').value = '# 当前正文\n';

      window.toggleHistoryPanel(true);
      await wait(120);
      doc.querySelector('#editorHistoryList [data-hist="preview"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(80);
      doc.querySelector('#editorHistoryPreview [data-hist="restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      check('H13 恢复前需要二次确认',
        !doc.getElementById('editorHistoryConfirm').hasAttribute('hidden'));

      const before = (await DH.list()).length;
      doc.querySelector('#editorHistoryConfirm [data-hist="confirm-restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(200);

      check('H13 恢复后标题/正文被替换',
        doc.getElementById('editorTitle').value === '历史标题' &&
        doc.getElementById('editorContent').value === '# 历史正文\n',
        doc.getElementById('editorTitle').value);
      check('H13 恢复后摘要也被替换', doc.getElementById('editorExcerpt').value === '历史摘要');

      const after = await DH.list();
      // 恢复会先写一条 restore-backup；随后的草稿保存还可能再补一条 auto（内容已不同）
      const backup = after.filter(r => r.kind === 'restore-backup')[0];
      check('H13 恢复前自动备份了当前内容',
        !!backup && backup.content === '# 当前正文\n' && after.length > before,
        after.length + '/' + (backup && backup.content));

      const draft = JSON.parse(window.localStorage.getItem('blog_draft') || 'null');
      check('H13 恢复后当前草稿已更新', draft && draft.title === '历史标题', draft && draft.title);
      check('H13 状态栏说明尚未导出/发布',
        /尚未导出|尚未发布/.test(doc.getElementById('editorStatus').textContent) &&
        !/已上线/.test(doc.getElementById('editorStatus').textContent),
        doc.getElementById('editorStatus').textContent);
      dom.window.close();
    }

    // H14 备份失败 → 绝不覆盖
    {
      const { dom, window, doc } = await openEditor();
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'new', postId: '' });
      await DH.snapshot(DH.KINDS.MANUAL, state({ title: '要恢复的', content: '# 历史\n' }), T0);

      doc.getElementById('editorTitle').value = '当前不能被覆盖';
      doc.getElementById('editorContent').value = '# 当前\n';

      // 让备份写入失败（只有 restore-backup 触发 put 时失败）。
      // 注意：listAll 必须返回固定快照，不能回调 DH.list()（会无限递归）。
      const rowsSnapshot = await DH.list();
      const failing = {
        name: 'fake-fail',
        listAll: () => Promise.resolve(rowsSnapshot.slice()),
        put: rec => (rec.kind === 'restore-backup'
          ? Promise.reject(Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }))
          : Promise.resolve(true)),
        remove: () => Promise.resolve(true),
        clear: () => Promise.resolve(true)
      };
      DH._injectBackend(failing);

      window.toggleHistoryPanel(true);
      await wait(150);
      doc.querySelector('#editorHistoryList [data-hist="preview"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(80);
      doc.querySelector('#editorHistoryPreview [data-hist="restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      doc.querySelector('#editorHistoryConfirm [data-hist="confirm-restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(150);

      check('H14 备份失败时内容不被覆盖',
        doc.getElementById('editorTitle').value === '当前不能被覆盖' &&
        doc.getElementById('editorContent').value === '# 当前\n',
        doc.getElementById('editorTitle').value);
      check('H14 明确提示已取消恢复',
        /取消恢复/.test(doc.getElementById('editorStatus').textContent),
        doc.getElementById('editorStatus').textContent);
      dom.window.close();
    }

    // ------------------------------------------------ H15 编辑模式快照不变
    {
      const { dom, window, doc } = await openEditor('#/editor/' + TARGET);
      const DH = window.DraftHistory;
      DH._resetForTests(memoryBackend());
      DH.configure({ scope: 'edit', postId: TARGET });
      const diskBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', TARGET + '.md'), 'utf8');
      await DH.snapshot(DH.KINDS.MANUAL, state({ title: '历史版', content: '# 历史版\n' }), T0);

      doc.getElementById('editorContent').value = '# 当前修改\n';
      window.toggleHistoryPanel(true);
      await wait(120);
      doc.querySelector('#editorHistoryList [data-hist="preview"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(60);
      doc.querySelector('#editorHistoryPreview [data-hist="restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      doc.querySelector('#editorHistoryConfirm [data-hist="confirm-restore"]')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(200);

      check('H15 恢复后正文变成历史版本', doc.getElementById('editorContent').value === '# 历史版\n',
        doc.getElementById('editorContent').value.slice(0, 20));
      const payload = window.buildUpdatePayload();
      check('H15 仍是编辑模式且 id 不变',
        window.editorContext().mode === 'edit' && payload.ok && payload.payload.id === TARGET);
      check('H15 _editCtx 原文章快照未被恢复操作改动',
        payload.payload.original.content === diskBody);
      dom.window.close();
    }

    // ------------------------------------------------ H16 多标签页提示
    {
      const { dom, window, doc } = await openEditor();
      doc.getElementById('editorTitle').value = '本页内容';
      window.saveDraft();

      const ev = new window.StorageEvent('storage', {
        key: 'blog_draft',
        oldValue: '{}',
        newValue: JSON.stringify({ mode: 'new', title: '别的标签页', content: 'x' }),
        storageArea: window.localStorage
      });
      window.dispatchEvent(ev);
      await wait(80);

      const notice = doc.getElementById('editorHistoryNotice');
      check('H16 其它标签页写入时给出提示', !notice.hasAttribute('hidden') &&
        /另一个标签页/.test(notice.textContent), notice.textContent.slice(0, 40));
      check('H16 不自动覆盖本页内容', doc.getElementById('editorTitle').value === '本页内容');
      dom.window.close();
    }

    // ------------------------------------------------ H17 草稿仍在 + H18 导出契约
    {
      const { dom, window, doc } = await openEditor();
      doc.getElementById('editorTitle').value = '刷新后还在';
      doc.getElementById('editorTags').value = '测试';
      doc.getElementById('editorContent').value = '# 刷新\n\n正文。\n';
      window.DraftHistory._resetForTests(memoryBackend());
      window.DraftHistory.configure({ scope: 'new', postId: '' });
      window.saveDraft();
      await wait(100);

      const raw = window.localStorage.getItem('blog_draft');
      check('H17 历史模块不影响 localStorage 草稿', !!raw && /刷新后还在/.test(raw));

      const p = window.buildExportPayload();
      check('H18 导出仍是六字段',
        p.ok && Object.keys(p.post).join(',') === 'id,title,date,tags,excerpt,content',
        p.ok && Object.keys(p.post).join(','));
      check('H18 正文不含历史元数据',
        p.ok && p.post.content.indexOf('restore-backup') === -1 && p.post.content.indexOf('hash') === -1);
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
