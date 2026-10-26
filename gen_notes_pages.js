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

// ---- 命令行参数：便于测试与可重复构建 ----
function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT_DIR = path.resolve(argValue('--out-dir', ROOT));
const TODAY = argValue('--now', new Date().toISOString().slice(0, 10));
const _todayDate = new Date(TODAY + 'T00:00:00Z');
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY) ||
    isNaN(_todayDate.getTime()) ||
    _todayDate.toISOString().slice(0, 10) !== TODAY) {
  console.error('[ABORT] --now 需要合法的 YYYY-MM-DD 日期，收到: ' + TODAY);
  process.exit(1);
}

// 先写临时文件再改名，避免中途失败把已有产物写坏
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

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
  <script>
    // 尽早套用主题，避免深色模式下白屏闪烁（与主站一致）
    (function () {
      try {
        var t = localStorage.getItem('theme');
        if (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
        if (t) document.documentElement.setAttribute('data-theme', t);
      } catch (e) {}
    })();
  </script>
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
  <a class="skip-link" href="#app">跳到主要内容</a>
  <header class="site-header">
    <div class="container header-inner">
      <a href="../#/" class="logo"><span class="logo-icon">🦐</span><span class="logo-text">Eric's Notebook</span></a>
      <nav class="nav">
        <a class="nav-link" href="../#/">首页</a>
        <a class="nav-link" href="../#/courses">课程</a>
        <a class="nav-link" href="../#/papers">论文</a>
        <a class="nav-link" href="../#/code">代码</a>
      </nav>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="切换深色模式">🌙</button>
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
  <script>
    // 静态页主题切换（与主站共用 localStorage 的 theme 键）
    (function () {
      var btn = document.getElementById('themeToggle');
      function sync() {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (btn) {
          btn.textContent = dark ? '☀️' : '🌙';
          btn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
          btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
        }
      }
      sync();
      if (btn) btn.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
        sync();
      });
    })();
  </script>
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

// 与主站一致的净化规则：marked 只负责转换，DOMPurify 负责信任边界
function createSanitizer() {
  const createDOMPurify = require('dompurify');
  const { JSDOM } = require('jsdom');
  const purify = createDOMPurify(new JSDOM('').window);
  return function sanitize(html) {
    return purify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'data-lang', 'id', 'class'],
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'srcset', 'formaction']
    });
  };
}

// JSON 放进 <script> 里必须转义尖括号与 &，防止提前闭合标签
function safeJsonLd(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function main() {
  const marked = require('./vendor/marked.min.js');
  const parseRaw = typeof marked === 'function' ? marked : (marked.parse || marked.marked.parse);
  const sanitize = createSanitizer();
  const parse = function (md) { return sanitize(parseRaw(md || '')); };

  const { notes, courses } = loadGlobals();
  const notesDir = path.join(OUT_DIR, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  const used = {};
  const courseMap = {};
  (courses || []).forEach(c => { courseMap[c.id] = c; });

  // 与站内笔记列表保持同一顺序（分类顺序 + 课程名），供「上一篇 / 下一篇」使用
  const CAT_ORDER = ['机器人与自动化', '人工智能与机器学习', '信号与控制', '计算机科学', '电子与硬件', '数理基础', '设计', '其他课程'];
  const ids = Object.keys(notes).sort((a, b) => {
    const ca = courseMap[a] || {}, cb = courseMap[b] || {};
    const ia = CAT_ORDER.indexOf(ca.category), ib = CAT_ORDER.indexOf(cb.category);
    const ka = ia === -1 ? 99 : ia, kb = ib === -1 ? 99 : ib;
    if (ka !== kb) return ka - kb;
    return String(ca.name || a).localeCompare(String(cb.name || b), 'zh-Hans-CN');
  });

  const pages = ids.map(id => {
    const entry = notes[id] || {};
    const course = courseMap[id] || {};
    const md = entry.notes || '';
    const slug = slugFor(id, used);
    return {
      id: id,
      name: course.name || id.split('|').pop(),
      category: course.category || '其他课程',
      year: course.year || '',
      slug: slug,
      rel: 'notes/' + slug + '.html',
      summary: (entry.summary || '').trim(),
      chars: md.length,
      md: md
    };
  });

  pages.forEach((p, i) => {
    const prev = i > 0 ? pages[i - 1] : null;
    const next = i < pages.length - 1 ? pages[i + 1] : null;
    const html = parse(p.md);
    const h1 = p.name + ' 课程笔记';
    const title = h1 + " · Eric's Notebook";
    const desc = p.summary || (p.name + ' 课程核心笔记');

    // JSON-LD 位于 <script> 上下文：必须转义 < > & ，
    // 否则标题/摘要里的 "</script>" 会提前闭合脚本，把 JSON 变成可执行的 HTML。
    const ld = `<script type="application/ld+json">${safeJsonLd({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: h1,
      description: desc.slice(0, 160),
      inLanguage: 'zh-CN',
      dateModified: TODAY,
      author: { '@type': 'Person', name: 'Eric Zhao' },
      mainEntityOfPage: SITE + '/' + p.rel
    })}</script>`;

    const nav = (prev || next) ? `
    <nav class="post-nav note-nav">
      ${prev ? `<a class="post-nav-item" href="${prev.slug}.html"><span class="post-nav-label">← 上一篇</span><span class="post-nav-title">${esc(prev.name)}</span></a>` : '<span class="post-nav-item post-nav-empty"></span>'}
      ${next ? `<a class="post-nav-item post-nav-next" href="${next.slug}.html"><span class="post-nav-label">下一篇 →</span><span class="post-nav-title">${esc(next.name)}</span></a>` : '<span class="post-nav-item post-nav-empty"></span>'}
    </nav>` : '';

    const body = `    <a class="article-back" href="../#/course/${encodeURIComponent(p.id)}">← 在站点中查看交互版</a>
    <article class="article-detail">
      <div class="article-detail-header">
        <h1 class="article-detail-title">${esc(h1)}</h1>
        <div class="article-detail-meta">
          <span class="meta-item">📂 ${esc(p.category)}</span>
          ${p.year ? `<span class="meta-item">📅 ${esc(p.year)}</span>` : ''}
          <span class="meta-item">📝 ${p.chars.toLocaleString()} 字</span>
        </div>
        ${p.summary ? `<p class="course-notes-summary">${esc(p.summary)}</p>` : ''}
      </div>
      <div class="article-detail-body markdown-body">
${html}
      </div>
    </article>
${nav}
    <p class="notes-static-hint">本页为静态版本，便于搜索引擎收录与分享；
      <a href="../#/course/${encodeURIComponent(p.id)}">交互版（支持全文搜索）→</a> ·
      <a href="index.html">全部课程笔记</a>
    </p>`;

    writeFileAtomic(path.join(notesDir, p.slug + '.html'),
      pageShell({ title, description: desc, canonical: SITE + '/' + p.rel, body, extraHead: ld }));
  });

  // 笔记索引页：按学科方向分组
  const grouped = {};
  pages.forEach(p => {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  });
  const totalChars = pages.reduce((s, p) => s + p.chars, 0);

  let listHtml = '';
  Object.keys(grouped).sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  }).forEach(cat => {
    listHtml += `      <h2 class="course-section-title">${esc(cat)} <span class="section-count">${grouped[cat].length} 门</span></h2>
      <div class="related-posts">
`;
    grouped[cat].forEach(p => {
      listHtml += `        <a class="related-item" href="${p.slug}.html">
          <span class="related-item-title">${esc(p.name)}</span>
          <span class="related-item-meta">${p.chars.toLocaleString()} 字</span>
        </a>
`;
    });
    listHtml += '      </div>\n';
  });

  const indexBody = `    <a class="article-back" href="../#/courses">← 返回课程笔记</a>
    <article class="article-detail">
      <div class="article-detail-header">
        <h1 class="article-detail-title">课程笔记合集</h1>
        <div class="article-detail-meta">
          <span class="meta-item">📚 ${pages.length} 门课程</span>
          <span class="meta-item">📝 共 ${totalChars.toLocaleString()} 字</span>
        </div>
        <p class="course-notes-summary">本科到研究生的课程核心笔记静态版，可按学科方向顺序阅读，也便于搜索引擎收录与分享。</p>
      </div>
${listHtml}    </article>`;

  writeFileAtomic(path.join(notesDir, 'index.html'), pageShell({
    title: "课程笔记合集 · Eric's Notebook",
    description: '香港大学与本科阶段 ' + pages.length + ' 门课程的核心笔记合集：机器人学、机器学习、材料、铁路、MEMS、产品设计等。',
    canonical: SITE + '/notes/',
    body: indexBody
  }));

  // 供单页应用跳转的映射表（与笔记数据同时加载）
  const mapLines = pages.map(p => `  ${JSON.stringify(p.id)}: ${JSON.stringify(p.rel)}`).join(',\n');
  writeFileAtomic(path.join(OUT_DIR, 'js/note-slugs.js'),
    '// 自动生成：node gen_notes_pages.js\nconst NOTE_PAGES = {\n' + mapLines + '\n};\n');

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
  writeFileAtomic(path.join(OUT_DIR, 'sitemap.xml'), sitemap);

  console.log('生成静态页: ' + pages.length + ' 个');
  pages.forEach(p => console.log('  ' + p.rel + '  ← ' + p.id));
  console.log('索引页: notes/index.html');
  console.log('映射表: js/note-slugs.js');
  console.log('sitemap: ' + urls.length + ' 条');
}

main();
