#!/usr/bin/env node
'use strict';
/**
 * Batch 6B-2：文章数据拆分的完整性验证（纯 Node，不需要浏览器）
 *
 * 保护的业务语义：
 *   1) 文章数量、id、标题、日期、标签、摘要、系列字段与拆分前完全一致；
 *   2) 每篇正文的字节与拆分前完全一致（按 manifest 里的 SHA256）；
 *   3) 全文搜索语料覆盖全部文章，且与正文逐字一致；
 *   4) 首页用的 readingMinutes 与 app.js 的 readingTime(正文) 完全相等；
 *   5) 没有孤儿正文文件、没有重复 id、文件名安全。
 *
 * 用法：node tests/test18.js
 * 退出码：0 全部通过；1 有失败；2 产物缺失（需要先跑 scripts/split_posts.py --extract）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_JS = path.join(ROOT, 'js', 'data.js');
const MANIFEST = path.join(ROOT, 'data', 'posts', 'manifest.json');
const SEARCH_INDEX = path.join(ROOT, 'data', 'search-index.json');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : '  (' + extra + ')'));
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// 与 scripts/split_posts.py 相同的规范化：键排序 + 紧凑分隔符 + 不转义非 ASCII
function canonical(obj) {
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(obj[k])).join(',') + '}';
}

// 直接从 app.js 源码里取出 readingTime 的实现，保证验证的是真实算法而不是复制品
function loadReadingTime() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const m = /function readingTime\(content\) \{([\s\S]*?)\n\}/.exec(src);
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return new Function('content', m[1]);
}

function main() {
  for (const f of [DATA_JS, MANIFEST, SEARCH_INDEX]) {
    if (!fs.existsSync(f)) {
      console.error('缺少产物：' + path.relative(ROOT, f) + '（先运行 python scripts/split_posts.py --extract）');
      process.exit(2);
    }
  }

  const ctx = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(DATA_JS, 'utf8'), ctx, { filename: 'js/data.js' });
  const POSTS = vm.runInContext('POSTS', ctx);
  const TAG_ORDER = vm.runInContext('TAG_ORDER', ctx);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const search = JSON.parse(fs.readFileSync(SEARCH_INDEX, 'utf8'));
  const readingTime = loadReadingTime();

  check('元数据文件可解析且为数组', Array.isArray(POSTS), POSTS && POSTS.length);
  check('文章数量与拆分前一致', POSTS.length === manifest.source.posts && manifest.posts.length === POSTS.length,
    POSTS.length + ' vs ' + manifest.source.posts);
  check('全部文章 id 与 manifest 顺序一致',
    POSTS.every((p, i) => p.id === manifest.posts[i].id));
  check('id 唯一且文件名安全',
    new Set(POSTS.map(p => p.id)).size === POSTS.length && POSTS.every(p => /^[a-z0-9][a-z0-9-]*$/.test(p.id)));
  check('元数据里不再包含正文', POSTS.every(p => !('content' in p)));

  check('TAG_ORDER 与 manifest 一致',
    JSON.stringify(TAG_ORDER) === JSON.stringify(manifest.tagOrder), TAG_ORDER.length + ' 个标签');

  const byId = new Map(manifest.posts.map(p => [p.id, p]));
  let bodyOk = 0, metaOk = 0, minutesOk = 0, missing = 0;
  let totalChars = 0;
  for (const post of POSTS) {
    const rec = byId.get(post.id);
    if (!rec) { missing++; continue; }
    const file = path.join(ROOT, rec.file);
    if (!fs.existsSync(file)) { missing++; continue; }
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    totalChars += text.length;
    if (sha256(buf) === rec.contentSha256 && buf.length === rec.contentBytes && text.length === rec.contentChars) bodyOk++;

    const meta = { id: post.id, title: post.title, date: post.date, tags: post.tags.slice(), excerpt: post.excerpt };
    if ('series' in post) meta.series = post.series;
    if ('seriesOrder' in post) meta.seriesOrder = post.seriesOrder;
    meta.readingMinutes = post.readingMinutes;
    if (sha256(Buffer.from(canonical(meta), 'utf8')) === rec.metaSha256) metaOk++;

    if (readingTime && post.readingMinutes === readingTime(text)) minutesOk++;
  }

  check('18 篇正文的字节/字符数与哈希全部一致', bodyOk === POSTS.length && missing === 0, bodyOk + '/' + POSTS.length);
  check('全部元数据字段（含 tags / series）哈希一致', metaOk === POSTS.length, metaOk + '/' + POSTS.length);
  check('正文总字符数与拆分前一致', totalChars === manifest.source.contentChars,
    totalChars + ' vs ' + manifest.source.contentChars);
  check('readingMinutes 与 app.js readingTime(正文) 完全相等', minutesOk === POSTS.length, minutesOk + '/' + POSTS.length);

  const searchIds = Object.keys(search).sort();
  check('搜索语料覆盖全部文章', JSON.stringify(searchIds) === JSON.stringify(POSTS.map(p => p.id).sort()),
    searchIds.length + ' 篇');
  let searchOk = 0;
  for (const id of searchIds) {
    const rec = byId.get(id);
    if (rec && search[id] === fs.readFileSync(path.join(ROOT, rec.file), 'utf8')) searchOk++;
  }
  check('搜索语料与正文逐字一致（全文搜索不会丢命中）', searchOk === searchIds.length, searchOk + '/' + searchIds.length);
  check('搜索语料文件哈希与 manifest 一致',
    sha256(fs.readFileSync(SEARCH_INDEX)) === manifest.searchIndex.sha256);

  const known = new Set(POSTS.map(p => p.id));
  const orphans = fs.readdirSync(path.join(ROOT, 'data', 'posts'))
    .filter(f => f.endsWith('.md') && !known.has(f.slice(0, -3)));
  check('没有多余/孤儿正文文件', orphans.length === 0, orphans.join(',') || '0');

  const tags = new Set();
  POSTS.forEach(p => (p.tags || []).forEach(t => tags.add(t)));
  check('每篇文章都有标题/日期/摘要/标签',
    POSTS.every(p => p.title && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.excerpt && p.tags.length > 0),
    tags.size + ' 个不同标签');

  // ---- 部署完整性：SW 里声明的首屏/必需资源必须真的存在（防止"忘了部署某个文件"）
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listOf = (name) => {
    const m = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(swSrc);
    // 清单里两种写法都有：'./index.html'（相对 SW 脚本）与 'css/style.css'（相对 scope）
    return m ? (m[1].match(/['"]([^'"]+)['"]/g) || []).map(s => s.replace(/['"]/g, '')) : [];
  };
  const required = listOf('REQUIRED_ASSETS');
  const firstScreen = listOf('FIRST_SCREEN_ASSETS');
  const missingAssets = required.filter(rel => !fs.existsSync(path.join(ROOT, rel.replace(/^\.\//, ''))));
  check('SW 安装期必需资源全部存在', required.length >= 6 && missingAssets.length === 0,
    required.length + ' 项 / 缺失: ' + (missingAssets.join(',') || '0'));
  check('SW 首屏资源全部存在', firstScreen.length >= 5 &&
    firstScreen.every(rel => fs.existsSync(path.join(ROOT, rel))), firstScreen.join(','));

  // ---- RSS 必须覆盖全部文章（新增/删除文章后忘记重新生成会在这里暴露）
  const feed = fs.readFileSync(path.join(ROOT, 'feed.xml'), 'utf8');
  const feedItems = (feed.match(/<item>/g) || []).length;
  const missingInFeed = POSTS.filter(p => feed.indexOf('/#/post/' + p.id) === -1).map(p => p.id);
  check('RSS 条目数与文章数一致且每篇都有链接',
    feedItems === POSTS.length && missingInFeed.length === 0,
    feedItems + ' 条 / 缺失: ' + (missingInFeed.join(',') || '0'));

  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  return fail ? 1 : 0;
}

process.exit(main());
