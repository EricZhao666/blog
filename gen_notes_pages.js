#!/usr/bin/env node
/**
 * 把 js/course-notes.js 里的课程笔记预渲染成静态页 notes/<slug>.html
 * 目的：hash 路由的单页应用无法被搜索引擎单独收录，静态页可索引、可分享。
 *
 * 用法：node gen_notes_pages.js
 * 产物：notes/<slug>.html、notes/index.html、js/note-slugs.js、sitemap.xml
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = __dirname;
const SITE = 'https://ericzhao666.github.io/blog';
const TODAY = new Date().toISOString().slice(0, 10);

// 纯中文名的课程给出可读 slug（其余自动从 ASCII 片段推导）
const SLUG_OVERRIDES = {
  '香港大学|材料科学': 'materials',
  '香港大学|铁路工程': 'railway',
  '香港大学|微系统': 'mems',
  '香港大学|机器人学-(国立交通大学·杨谷洋)': 'nctu-robotics',
  '香港大学|机器人大使-(Robotic-Ambassador)': 'robotic-ambassador',
  '香港大学|GRCNN-抓取检测': 'grcnn',
  '香港大学|ROS机械臂开发视频教程': 'ros-moveit',
  '香港大学|MECH7010-机器人学': 'mech7010',
  '香港大学|IDAT-7215-Python与机器学习': 'idat7215',
  '香港大学|无人机系统-(UAV)': 'uav',
  '香港大学|IDAT-7216': 'idat7216',
  '香港大学|计算机辅助产品设计-(CAPD)': 'capd',
  '香港大学|IDAT-7212': 'idat7212',
  '本科课程|机器人与自动化-(CS422)': 'cs422'
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadGlobals() {
  const ctx = vm.createContext({ console });
  ['js/course-notes.js', 'js/courses.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return {
    notes: vm.runInContext('COURSE_NOTES', ctx),
    courses: vm.runInContext('COURSES', ctx)
  };
}

function slugFor(id, used) {
  let base = SLUG_OVERRIDES[id];
  if (!base) {
    const ascii = (id.match(/[A-Za-z0-9]+/g) || []).join('-').toLowerCase().replace(/^-+|-+$/g, '');
    base = ascii.length >= 3 ? ascii : 'note-' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  }
  let slug = base, n = 2;
  while (used[slug]) slug = base + '-' + n++;
  used[slug] = true;
  return slug;
}

function pageShell(opts) {
  const { title, description, canonical, body, extraHead } = opts;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${esc(description)}">
  <title>${esc(title)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦐</text></svg>">
  <link rel="apple-touch-icon" href="../icons/apple-touch-icon.png">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" type="application/rss+xml" title="Eric's Notebook RSS" href="../feed.xml">
  <link rel="stylesheet" href="../css/style.css">
  <link rel="stylesheet" href="../vendor/atom-one-light.min.css">
  <meta name="theme-color" content="#2563eb">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Eric's Notebook">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/icons/icon-512.png">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${SITE}/icons/icon-512.png">
${extraHead || ''}
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a href="../#/" class="logo"><span class="logo-icon">🦐</span><span class="logo-text">Eric's Notebook</span></a>
      <nav class="nav">
        <a class="nav-link" href="../#/">首页</a>
        <a class="nav-link" href="../#/courses">课程</a>
        <a class="nav-link" href="../#/papers">论文</a>
        <a class="nav-link" href="../#/code">代码</a>
      </nav>
    </div>
  </header>
  <main class="container" id="app">
${body}
  </main>
  <footer class="site-footer">
    <div class="container">
      <p>&copy; 2024-2026 Eric's Notebook · 用文字记录思考</p>
      <p class="footer-sub">Powered by vanilla JS &amp; Markdown</p>
    </div>
  </footer>
  <script src="../vendor/highlight.min.js"></script>
  <script>
    (function () {
      if (!window.hljs) return;
      var blocks = document.querySelectorAll('pre code');
      for (var i = 0; i < blocks.length; i++) {
        var el = blocks[i];
        var cls = el.className || '';
        var pos = cls.indexOf('language-');
        // 未知语言（如 language-text）先去掉 class，否则 highlightElement 会抛错
        if (pos !== -1) {
          var lang = cls.slice(pos + 9).split(' ')[0];
          if (!hljs.getLanguage(lang)) {
            el.className = cls.replace('language-' + lang, '').trim();
          }
        }
        try { hljs.highlightElement(el); } catch (e) {}
      }
    })();
  </script>
</body>
</html>
`;
}

function main() {
  const marked = require('./vendor/marked.min.js');
  const parse = typeof marked === 'function' ? marked : (marked.parse || marked.marked.parse);

  const { notes, courses } = loadGlobals();
  const notesDir = path.join(ROOT, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  const used = {};
  const pages = [];
  const courseMap = {};
  (courses || []).forEach(c => { courseMap[c.id] = c; });

  Object.keys(notes).forEach(id => {
    const entry = notes[id];
    const course = courseMap[id] || {};
    const name = course.name || id.split('|').pop();
    const slug = slugFor(id, used);
    const rel = 'notes/' + slug + '.html';
    const summary = (entry.summary || '').trim();
    const desc = summary || (name + ' 课程核心笔记');
    const md = entry.notes || '';
    const html = parse(md);
    const h1 = name + ' 课程笔记';
    const title = h1 + " · Eric's Notebook";

    const ld = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: h1,
      description: desc.slice(0, 160),
      inLanguage: 'zh-CN',
      dateModified: TODAY,
      author: { '@type': 'Person', name: 'Eric Zhao' },
      mainEntityOfPage: SITE + '/' + rel
    })}</script>`;

    const body = `    <a class="article-back" href="../#/course/${encodeURIComponent(id)}">← 在站点中查看（含课程文件清单）</a>
    <article class="article-detail">
      <div class="article-detail-header">
        <h1 class="article-detail-title">${esc(h1)}</h1>
        <div class="article-detail-meta">
          ${course.category ? `<span class="meta-item">📂 ${esc(course.category)}</span>` : ''}
          ${course.year ? `<span class="meta-item">📅 ${esc(course.year)}</span>` : ''}
          <span class="meta-item">📝 ${md.length.toLocaleString()} 字</span>
        </div>
        ${summary ? `<p class="course-notes-summary">${esc(summary)}</p>` : ''}
      </div>
      <div class="article-detail-body markdown-body">
${html}
      </div>
    </article>
    <p class="notes-static-hint">本页为静态版本，便于搜索引擎收录与分享；
      <a href="../#/course/${encodeURIComponent(id)}">交互版（含文件清单与搜索）→</a> ·
      <a href="index.html">全部课程笔记</a>
    </p>`;

    fs.writeFileSync(path.join(notesDir, slug + '.html'),
      pageShell({ title, description: desc, canonical: SITE + '/' + rel, body, extraHead: ld }),
      'utf8');

    pages.push({ id, name, slug, rel, summary, chars: md.length });
  });

  // 笔记索引页
  const listHtml = pages.map(p => `      <a class="related-item" href="${p.slug}.html">
        <span class="related-item-title">${esc(p.name)}</span>
        <span class="related-item-meta">${p.chars.toLocaleString()} 字</span>
      </a>`).join('\n');

  const indexBody = `    <a class="article-back" href="../#/courses">← 返回课程资料库</a>
    <article class="article-detail">
      <div class="article-detail-header">
        <h1 class="article-detail-title">课程笔记合集</h1>
        <div class="article-detail-meta"><span class="meta-item">📚 ${pages.length} 门课程</span></div>
      </div>
      <div class="related-posts">
${listHtml}
      </div>
    </article>`;

  fs.writeFileSync(path.join(notesDir, 'index.html'), pageShell({
    title: "课程笔记合集 · Eric's Notebook",
    description: '香港大学与本科阶段 ' + pages.length + ' 门课程的核心笔记合集：机器人学、机器学习、材料、铁路、MEMS、产品设计等。',
    canonical: SITE + '/notes/',
    body: indexBody
  }), 'utf8');

  // 供单页应用跳转的映射表（与笔记数据同时加载）
  const mapLines = pages.map(p => `  ${JSON.stringify(p.id)}: ${JSON.stringify(p.rel)}`).join(',\n');
  fs.writeFileSync(path.join(ROOT, 'js/note-slugs.js'),
    '// 自动生成：node gen_notes_pages.js\nconst NOTE_PAGES = {\n' + mapLines + '\n};\n', 'utf8');

  // sitemap
  const urls = [
    { loc: SITE + '/', priority: '1.0', freq: 'weekly' },
    { loc: SITE + '/notes/', priority: '0.9', freq: 'monthly' }
  ].concat(pages.map(p => ({ loc: SITE + '/' + p.rel, priority: '0.8', freq: 'monthly' })))
    .concat([{ loc: SITE + '/feed.xml', priority: '0.5', freq: 'weekly' }]);

  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
    '\n</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap, 'utf8');

  console.log('生成静态页: ' + pages.length + ' 个');
  pages.forEach(p => console.log('  ' + p.rel + '  ← ' + p.id));
  console.log('索引页: notes/index.html');
  console.log('映射表: js/note-slugs.js');
  console.log('sitemap: ' + urls.length + ' 条');
}

main();
