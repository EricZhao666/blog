#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-2：内容引用契约与构建期反向索引专项（无浏览器）。
 *
 * 覆盖：
 *  A. JS 扫描器与共享 fixture 逐例一致（tests/fixtures/wikilink-contract.json）
 *  B. Python 镜像扫描器与同一 fixture 逐例一致（子进程，两侧字节级同契约）
 *  C. marked 扩展渲染：合法→真实站内链接 / 不存在→明确未解析 / 显示文本 XSS 转义 /
 *     围栏、行内代码、转义不解析 / 普通 Markdown 链接语义不变
 *  D. 临时 root 全链路：--sync 生成索引 / 两次无变化构建字节一致 / --check / --dry-run /
 *     篡改索引后 --check 失败 / import_post 导入隔离 fixture（WikiLink 边、未解析诊断、
 *     自环排除、真实循环保留、重复去重）/ BuildLock 并发（锁占用时 --sync 退出码 3）
 *
 * 用法：node tests/test59_content_links.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const CL = require(path.resolve(__dirname, '..', 'js', 'content-links.js'));

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wikilink-contract.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])]));
  return x;
}
function jsResult(text) {
  const r = CL.scanText(text);
  const md = CL.extractMarkdownLinks(text);
  return sortKeys({
    w: r.links.map(x => ({ key: x.key, display: x.display })),
    m: md.map(x => ({ key: x.key, raw: x.raw })),
    d: r.diagnostics.map(x => x.reason)
  });
}
function expected(c) {
  return sortKeys({ w: c.wikilinks || [], m: c.markdown || [], d: c.diagnostics || [] });
}

// ================================================================ A. JS fixture
FIXTURE.cases.forEach(c => {
  check('A JS 契约 ' + c.name, JSON.stringify(jsResult(c.text)) === JSON.stringify(expected(c)));
});

// ================================================================ B. Python 镜像
{
  const py = `
import sys, json
sys.path.insert(0, 'scripts')
import content_links as cl
fx = json.load(open('tests/fixtures/wikilink-contract.json', encoding='utf-8'))
out = []
for c in fx['cases']:
    links, diags = cl.extract_wikilinks(c['text'])
    md = cl.extract_markdown_links(c['text'])
    out.append({'name': c['name'],
                'w': [{'key': x['key'], 'display': x['display']} for x in links],
                'm': [{'key': x['key'], 'raw': x['raw']} for x in md],
                'd': [x['reason'] for x in diags]})
print(json.dumps(out, ensure_ascii=False))
`;
  let pyOut = null;
  try {
    pyOut = execFileSync('python', ['-c', py], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    console.log('python 子进程失败: ' + (e.message || e));
  }
  check('B0 Python 镜像可运行', !!pyOut);
  if (pyOut) {
    const rows = JSON.parse(pyOut.trim().split('\n').pop());
    rows.forEach(row => {
      const c = FIXTURE.cases.find(x => x.name === row.name);
      const got = sortKeys({ w: row.w, m: row.m, d: row.d });
      check('B PY 契约 ' + row.name, !!c && JSON.stringify(got) === JSON.stringify(expected(c)));
    });
  }
}

// ================================================================ C. marked 扩展
{
  const markedMod = require(path.join(ROOT, 'vendor', 'marked.min.js'));
  const Marked = markedMod.Marked;
  const resolver = key => key === 'post:real-target' ? { title: '真实目标文章' } : null;
  const m2 = new Marked();
  m2.use(CL.markedExtension(resolver));
  const render = src => m2.parse(src);

  const okHtml = render('见 [[post:real-target]]。');
  check('C1 合法目标渲染为真实站内链接', /<a href="#\/post\/real-target" class="wikilink"/.test(okHtml) && /真实目标文章<\/a>/.test(okHtml), okHtml);
  const dispHtml = render('[[post:real-target|自定义显示]]');
  check('C2 显示文本优先于标题', /自定义显示<\/a>/.test(dispHtml));
  const badHtml = render('[[post:does-not-exist]]');
  check('C3 不存在目标显示明确未解析状态且不产生链接', /wikilink-unresolved/.test(badHtml) && /data-wikilink-unresolved="post:does-not-exist"/.test(badHtml) && !/<a /.test(badHtml), badHtml);
  const xss = render('[[post:real-target|<img src=x onerror=alert(1)>]]');
  check('C4 显示文本按不可信数据转义（无 HTML 注入）', xss.indexOf('<img') === -1 && /&lt;img/.test(xss), xss);
  const xssTitle = render('[[post:real-target]]');
  check('C5 标题转义通道存在（escapeHtml）', CL.escapeHtml('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;');
  const fence = render('```\n[[post:real-target]]\n```\n[[post:real-target]]');
  check('C6 围栏代码内不解析', (fence.match(/class="wikilink"/g) || []).length === 1 && /\[\[post:real-target\]\]/.test(fence));
  const inline = render('`[[post:real-target]]` 与 [[post:real-target]]');
  check('C7 行内代码内不解析', (inline.match(/class="wikilink"/g) || []).length === 1);
  const esc = render('\\[\\[post:real-target]]');
  check('C8 转义文本不解析', esc.indexOf('class="wikilink"') === -1, esc);
  const plain = render('[普通链接](#/post/real-target)');
  check('C9 普通 Markdown 链接语义不变', /<a href="#\/post\/real-target">普通链接<\/a>/.test(plain), plain);
  const course = render('[[course:本科课程|机器人与自动化-(CS422)]]');
  check('C10 非 post 类型 v1 保留原文（课程 id 含竖线不歧义解析）', course.indexOf('[[course:') !== -1 && course.indexOf('wikilink') === -1, course);
  check('C11 渲染输出不含 javascript: 协议', render('[[post:real-target|javascript:alert(1)]]').indexOf('javascript:') === -1 || !/href="javascript/.test(render('[[post:real-target|javascript:alert(1)]]')));
}

// ================================================================ D. 临时 root 全链路
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b9b2-links-'));
  const skip = new Set(['.git', 'node_modules', 'reports', '.content-build.lock']);
  fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  const run = (args, opts) => {
    try {
      const out = execFileSync('python', [path.join(tmp, 'scripts', 'build_content.py')].concat(args),
        Object.assign({ cwd: tmp, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, opts || {}));
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };
  const indexPath = path.join(tmp, 'data', 'content-links.json');

  const s1 = run(['--sync', '--now', '2026-11-24T00:00:00+08:00']);
  check('D1 --sync 成功且生成 content-links.json', s1.code === 0 && fs.existsSync(indexPath), s1.out.slice(-200));
  const bytes1 = fs.readFileSync(indexPath);
  const idx1 = JSON.parse(bytes1.toString('utf8'));
  check('D2 索引 schemaVersion=1 且含 nodes/explicit/series/bySource/byTarget/diagnostics/stats',
    idx1.schemaVersion === 1 && Array.isArray(idx1.nodes) && Array.isArray(idx1.explicit) &&
    Array.isArray(idx1.series) && idx1.bySource && idx1.byTarget && Array.isArray(idx1.diagnostics) && idx1.stats);
  check('D3 索引无时间戳字段（确定性契约）', !('generatedAt' in idx1) && !('timestamp' in idx1) && !('buildTime' in idx1));

  const s2 = run(['--sync', '--now', '2026-11-24T00:00:00+08:00']);
  const bytes2 = fs.readFileSync(indexPath);
  check('D4 两次无变化构建：索引字节级一致', s2.code === 0 && bytes1.equals(bytes2));
  const chk = run(['--check']);
  check('D5 --check 通过', chk.code === 0, chk.out.slice(-200));
  const dry = run(['--dry-run']);
  check('D6 --dry-run 报告无待更新', dry.code === 0 && /待更新 0 个|无待更新|已是最新/.test(dry.out), dry.out.slice(-200));

  fs.writeFileSync(indexPath, '{"tampered":true}');
  const chkBad = run(['--check']);
  check('D7 篡改索引后 --check 失败', chkBad.code !== 0);
  run(['--sync', '--now', '2026-11-24T00:00:00+08:00']);

  // 隔离 fixture：通过正式导入链新增两篇互相引用的文章（不改动仓库正式文章）
  const mkPost = (id, title, content) => ({
    id, title, date: '2026-11-24', tags: ['测试夹具'], excerpt: '隔离 fixture，仅用于验收。', content
  });
  const bodyA = '# 夹具 A\n\n指向 [[post:zz-fixture-b]] 与 [[post:zz-fixture-b|别名]]（重复引用）。\n' +
    '自环 [[post:zz-fixture-a]] 应排除。\n失效 [[post:zz-not-exist]] 应诊断。\n' +
    '代码围栏不解析：\n```\n[[post:zz-fixture-b]]\n```\n普通链接 [B](#/post/zz-fixture-b)。\n';
  const bodyB = '# 夹具 B\n\n回指 [[post:zz-fixture-a]]（真实循环引用）。\n';
  const fileA = path.join(tmp, 'fixture-a.json');
  const fileB = path.join(tmp, 'fixture-b.json');
  fs.writeFileSync(fileA, JSON.stringify(mkPost('zz-fixture-a', '夹具 A', bodyA)));
  fs.writeFileSync(fileB, JSON.stringify(mkPost('zz-fixture-b', '夹具 B', bodyB)));
  const imp = (file) => {
    try {
      const out = execFileSync('python', [path.join(tmp, 'scripts', 'import_post.py'), '--file', file, '--apply', '--mode', 'add', '--root', tmp],
        { cwd: tmp, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, out };
    } catch (e) { return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  const ia = imp(fileA);
  const ib = imp(fileB);
  check('D8 import_post 导入链成功（持锁调用，无嵌套锁死锁）', ia.code === 0 && ib.code === 0, (ia.out + ib.out).slice(-300));
  const idx2 = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const edges = idx2.explicit;
  const has = (s, t, via) => edges.some(e => e.source === s && e.target === t && e.via === via);
  check('D9 WikiLink 显式边 a→b 生成', has('post:zz-fixture-a', 'post:zz-fixture-b', 'wikilink'));
  check('D10 重复 WikiLink 确定性去重（a→b wikilink 仅一条）',
    edges.filter(e => e.source === 'post:zz-fixture-a' && e.target === 'post:zz-fixture-b' && e.via === 'wikilink').length === 1);
  check('D11 普通 Markdown 边与 WikiLink 边按 via 区分共存', has('post:zz-fixture-a', 'post:zz-fixture-b', 'markdown'));
  check('D12 自环排除', !edges.some(e => e.source === e.target));
  check('D13 真实循环引用保留（b→a）', has('post:zz-fixture-b', 'post:zz-fixture-a', 'wikilink'));
  check('D14 失效目标进入诊断且不生成虚假节点/边',
    idx2.diagnostics.some(d => d.source === 'post:zz-fixture-a' && d.reason === 'unresolved-target' && /zz-not-exist/.test(d.raw)) &&
    !idx2.nodes.some(n => n.key === 'post:zz-not-exist') && !edges.some(e => e.target === 'post:zz-not-exist'));
  check('D15 围栏内 WikiLink 不构成边（a→b 合计恰 2 条：wikilink+markdown）',
    edges.filter(e => e.source === 'post:zz-fixture-a' && e.target === 'post:zz-fixture-b').length === 2);
  check('D16 byTarget 反向索引正确（b 的来源含 a）', (idx2.byTarget['post:zz-fixture-b'] || []).indexOf('post:zz-fixture-a') !== -1);
  check('D17 bySource 正向索引正确', (idx2.bySource['post:zz-fixture-a'] || []).indexOf('post:zz-fixture-b') !== -1);
  const chk2 = run(['--check']);
  check('D18 导入后 --check 通过（索引纳入完整性门禁）', chk2.code === 0, chk2.out.slice(-200));
  const bytesAfterImport = fs.readFileSync(indexPath);

  // BuildLock 并发：手工占锁后 --sync 必须立即失败（退出码 3），不得锁外写产物
  const lockPath = path.join(tmp, '.content-build.lock');
  fs.writeFileSync(lockPath, String(process.pid));
  const busy = run(['--sync']);
  check('D19 锁占用时 --sync 退出码 3（LockBusy，不写产物）', busy.code === 3, 'code=' + busy.code);
  check('D19b 锁占用期间索引未被改动', fs.readFileSync(indexPath).equals(bytesAfterImport));
  fs.unlinkSync(lockPath);
  const after = run(['--sync', '--now', '2026-11-24T00:00:00+08:00']);
  check('D20 释放锁后 --sync 恢复且索引字节不变', after.code === 0 && fs.readFileSync(indexPath).equals(bytesAfterImport));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);