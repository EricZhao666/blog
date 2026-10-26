/**
 * Blog App - Router & Rendering Logic
 */

// ============================================
// Config
// ============================================
// 代码高亮改为渲染后按需处理（highlight.js 懒加载，见 ensureHighlight / highlightIn）：
// 无代码块的页面（首页/课程列表/论文…）不再下载 55KB 的高亮库，
// 且不再对无语言标记的代码块做 highlightAuto（长代码块下很慢）。
try {
  marked.setOptions({
    breaks: true,
    gfm: true
  });
} catch (e) {
  console.warn('marked init failed:', e);
}

// ============================================
// State
// ============================================
let searchQuery = '';
let activeTag = null;
let activeCategory = null;
let courseSearchQuery = '';
let courseNotesOnly = true;
let paperTab = 'papers';
let paperSearchQuery = '';
let activePaperCategory = null;
let codeLibSearchQuery = '';
const CODE_PROJECT_FILE_CAP = 300;
let currentCodeProjects = [];

// Giscus 评论配置（基于 GitHub Discussions，免费）
// 启用步骤：1) 在 https://giscus.app 用 GitHub 登录并配置本仓库
//          2) 在仓库 Settings 开启 Discussions 功能
//          3) 把下面 repoId / categoryId 填上，enabled 改为 true
const GISCUS_CONFIG = {
  enabled: true,
  repo: 'EricZhao666/blog',
  repoId: 'R_kgDOT07xhQ',          // 从 giscus.app 获取
  category: 'Announcements',
  categoryId: 'DIC_kwDOT07xhc4DDLr3'       // 从 giscus.app 获取
};

function loadGiscus(term) {
  if (!GISCUS_CONFIG.enabled) return;
  const container = document.getElementById('giscus-container');
  if (!container) return;
  container.innerHTML = '';
  const s = document.createElement('script');
  s.src = 'https://giscus.app/client.js';
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.setAttribute('data-repo', GISCUS_CONFIG.repo);
  s.setAttribute('data-repo-id', GISCUS_CONFIG.repoId);
  s.setAttribute('data-category', GISCUS_CONFIG.category);
  s.setAttribute('data-category-id', GISCUS_CONFIG.categoryId);
  s.setAttribute('data-mapping', 'specific');
  s.setAttribute('data-term', term);
  s.setAttribute('data-reactions-enabled', '1');
  s.setAttribute('data-emit-metadata', '0');
  s.setAttribute('data-input-position', 'bottom');
  s.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  s.setAttribute('data-lang', 'zh-CN');
  s.setAttribute('data-loading', 'lazy');
  container.appendChild(s);
}

// 文件以清单形式展示，不暴露、不打开本地路径（已移除 data-fidx 点击打开逻辑与路径弹窗）

// ============================================
// Utilities
// ============================================

// Merge built-in posts with user-published posts
// ============================================
// Markdown → 安全 HTML（唯一渲染入口）
// ============================================
// marked 只负责「Markdown → HTML」，不做信任判断；
// 所有不可信来源（文章正文、课程笔记、代码库导读、编辑器预览）都必须过 DOMPurify。
// 允许规则与静态笔记生成器（gen_notes_pages.js）保持一致。
const SANITIZE_CONFIG = {
  ADD_ATTR: ['target', 'rel', 'data-lang', 'id', 'class'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'srcset', 'formaction']
};

if (typeof DOMPurify !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      var href = node.getAttribute('href');
      // 站外链接：新窗口打开并切断 window.opener
      if (/^https?:/i.test(href) && href.indexOf(location.host) === -1) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

function renderMarkdown(src) {
  const raw = marked.parse(src || '');
  if (typeof DOMPurify === 'undefined') {
    // 净化库没加载时不冒险渲染原始 HTML（宁可显示转义文本）
    console.warn('[security] DOMPurify 未加载，Markdown 输出已降级为纯文本');
    return '<pre class="markdown-fallback">' + escapeHtml(String(src || '')) + '</pre>';
  }
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG);
}

function getAllPosts() {
  // 统一按日期倒序（稳定排序：同日保持数据源原顺序），
  // 使首页 / 标签页 / 搜索结果与归档、上下篇、RSS 使用同一套顺序
  const all = (typeof USER_POSTS !== 'undefined') ? POSTS.concat(USER_POSTS) : POSTS.slice();
  return all.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'];

function formatDate(dateStr) {
  // `YYYY-MM-DD` 表示“日历日期”而非时间点：直接取年月日字段，
  // 避免 new Date('2026-08-09') 按 UTC 解析后再用本地 getDate() 造成跨时区偏移
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return `${+m[1]}年${MONTH_NAMES[+m[2] - 1]}${+m[3]}日`;
  }
  // 其它（完整时间戳等）保持原有语义：按本地时区换算
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${MONTH_NAMES[d.getMonth()]}${d.getDate()}日`;
}

function readingTime(content) {
  // 中文按字符算，大约 400字/分钟；英文按词算
  const chineseChars = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (content.replace(/[\u4e00-\u9fa5]/g, '').match(/\b\w+\b/g) || []).length;
  const minutes = Math.ceil(chineseChars / 400 + englishWords / 200);
  return Math.max(1, minutes);
}

function getExcerpt(post) {
  return post.excerpt || post.content.replace(/[#*`>\-\[\]]/g, '').slice(0, 120) + '...';
}

function getAllTags() {
  const tagMap = {};
  getAllPosts().forEach(post => {
    post.tags.forEach(tag => {
      tagMap[tag] = (tagMap[tag] || 0) + 1;
    });
  });
  // Sort by TAG_ORDER, then by count
  return Object.entries(tagMap)
    .sort((a, b) => {
      const ia = TAG_ORDER.indexOf(a[0]);
      const ib = TAG_ORDER.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return b[1] - a[1];
    })
    .map(([name, count]) => ({ name, count }));
}

function filterPosts(posts, query, tag) {
  let result = posts;
  if (tag) {
    result = result.filter(p => (p.tags || []).includes(tag));
  }
  if (query) {
    const q = query.toLowerCase();
    result = result.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.excerpt || '').toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (p.content || '').toLowerCase().includes(q)
    );
  }
  return result;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- 标题与描述（浏览器标签、历史记录、分享）----
const SITE_NAME = "Eric's Notebook";
const SITE_DESC = 'Eric 的个人技术随笔 — 智能制造、机器人、具身智能与生活思考';

function setMeta(title, desc) {
  const fullTitle = title ? title + ' · ' + SITE_NAME : SITE_NAME;
  document.title = fullTitle;
  const d = desc || SITE_DESC;
  [['meta[name="description"]', d],
   ['meta[property="og:title"]', fullTitle],
   ['meta[property="og:description"]', d],
   ['meta[name="twitter:title"]', fullTitle],
   ['meta[name="twitter:description"]', d]].forEach(function (pair) {
    const el = document.querySelector(pair[0]);
    if (el) el.setAttribute('content', pair[1]);
  });
}

const STATIC_META = {
  '/courses': ['课程笔记', '香港大学与本科阶段课程的核心笔记，按学科方向整理'],
  '/papers': ['论文与学习资料', '机器人、具身智能、控制与制造方向的论文与课件收藏'],
  '/code': ['代码与文件库', '项目代码、部署脚本与工程文件的整理'],
  '/tags': ['标签', '按主题浏览所有文章'],
  '/archive': ['归档', '按年份浏览全部文章'],
  '/projects': ['项目', '正在进行与已完成的项目'],
  '/about': ['关于', '关于 Eric 与这个博客'],
  '/links': ['友情链接', '志同道合的技术博客与工具'],
  '/editor': ['编辑器', '在线撰写并发布文章']
};

const SITE_ORIGIN = 'https://ericzhao666.github.io/blog/';

// 更新 canonical / og:url：课程笔记指向可被收录的静态页，其余回到站点根
function setCanonical(path) {
  const href = path ? SITE_ORIGIN + path : SITE_ORIGIN;
  const link = document.querySelector('link[rel="canonical"]');
  if (link) link.setAttribute('href', href);
  const og = document.querySelector('meta[property="og:url"]');
  if (og) og.setAttribute('content', href);
}

function updateMetaForRoute(hash) {
  if (hash.indexOf('/post/') === 0) {
    const id = hash.slice(6);
    const post = getAllPosts().find(p => p.id === id);
    if (post) {
      setMeta(post.title, getExcerpt(post));
      setCanonical(null);
      return;
    }
  }
  if (hash.indexOf('/course/') === 0 && dataReady('courses')) {
    const id = decodeURIComponent(hash.slice(8));
    const course = COURSES.find(c => c.id === id);
    if (course) {
      setMeta(course.name + ' 课程笔记', course.description || (course.name + ' 课程资料与核心笔记'));
      setCanonical(typeof NOTE_PAGES !== 'undefined' && NOTE_PAGES[id] ? NOTE_PAGES[id] : null);
      return;
    }
  }
  const m = STATIC_META[hash];
  if (m) setMeta(m[0], m[1]);
  else setMeta('', '');
  setCanonical(null);
}

// 搜索关键词高亮：先转义再包裹 <mark>，避免 XSS
function highlightMatch(text, query) {
  const safe = escapeHtml(text || '');
  if (!query) return safe;
  const eq = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(eq, 'gi'), function (m) {
      return '<mark class="search-hit">' + m + '</mark>';
    });
  } catch (e) {
    return safe;
  }
}

// 通用实时搜索绑定：
//   1) 防抖，避免每次敲键就重建整页 DOM
//   2) 中文输入法组合期间不重绘（否则候选框会被打断）
//   3) 重绘后自动恢复焦点与光标位置
function bindLiveSearch(inputId, applyValue, delay) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.liveSearch === '1') return;
  input.dataset.liveSearch = '1';

  let composing = false;
  let timer = null;

  function commit() {
    if (document.getElementById(inputId) !== input) return;
    const val = input.value;
    const selStart = input.selectionStart;
    const selEnd = input.selectionEnd;
    applyValue(val);
    const next = document.getElementById(inputId);
    if (next && next !== input) {
      // 重绘会销毁旧输入框，必须给新输入框重新绑定，否则后续输入不再生效
      bindLiveSearch(inputId, applyValue, delay);
      next.focus();
      try { next.setSelectionRange(selStart, selEnd); } catch (e) {}
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(commit, delay || 180);
  }

  input.addEventListener('compositionstart', function () { composing = true; });
  input.addEventListener('compositionend', function () {
    composing = false;
    schedule();
  });
  input.addEventListener('input', function () {
    if (composing) return;
    schedule();
  });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      clearTimeout(timer);
      commit();
    }
  });
}

// ============================================
// 按需加载：数据脚本 + 代码高亮
// ============================================
// 数据脚本体积较大（课程 382KB / 代码库 380KB / 笔记 101KB / 论文 41KB），
// 只在访问对应路由时加载；首页只需要 data.js。
const DATA_FILES = {
  courses: ['js/courses.js'],
  // note-slugs.js 由 gen_notes_pages.js 生成，用于跳转预渲染静态页
  notes: ['js/course-notes.js', 'js/note-slugs.js'],
  papers: ['js/papers.js'],
  codefiles: ['js/codefiles.js']
};
const DATA_GLOBALS = {
  courses: 'COURSES',
  notes: 'COURSE_NOTES',
  papers: 'PAPERS',
  codefiles: 'CODE_LIBS'
};
const _dataPromises = {};
let _routeToken = 0;

// 顶层 const 不会挂到 window 上，用 eval 检测同名全局绑定是否存在
function dataReady(key) {
  try {
    return eval('typeof ' + DATA_GLOBALS[key]) !== 'undefined';
  } catch (e) {
    return false;
  }
}

function loadScriptOnce(src) {
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('加载失败: ' + src)); };
    document.head.appendChild(s);
  });
}

function loadData(key) {
  if (dataReady(key)) return Promise.resolve();
  if (_dataPromises[key]) return _dataPromises[key];
  const files = DATA_FILES[key];
  const chain = (Array.isArray(files) ? files : [files]).reduce(function (p, src) {
    return p.then(function () { return loadScriptOnce(src); });
  }, Promise.resolve());
  _dataPromises[key] = chain.catch(function (err) {
    console.warn(err.message);
    delete _dataPromises[key];
  });
  return _dataPromises[key];
}

function renderLoading(label) {
  return '<div class="empty-state"><div class="empty-state-icon">⏳</div><p>正在加载' + label + '…</p></div>';
}

// 按需脚本加载失败时给出可重试的提示，避免继续渲染导致 ReferenceError
function renderLoadError(label) {
  return '<div class="empty-state"><div class="empty-state-icon">⚠️</div>' +
    '<p>' + escapeHtml(label) + '数据加载失败，请检查网络后重试</p>' +
    '<p><a href="#" onclick="location.reload();return false;">点击重试</a></p></div>';
}

// ---- 代码高亮（懒加载，只在出现代码块时下载 55KB 精简包）----
let _hljsPromise = null;
function ensureHighlight() {
  if (typeof hljs !== 'undefined') return Promise.resolve();
  if (!_hljsPromise) {
    _hljsPromise = loadScriptOnce('vendor/highlight.min.js').catch(function (err) {
      console.warn('高亮库加载失败:', err.message);
    });
  }
  return _hljsPromise;
}

function highlightIn(root) {
  if (!root) return;
  const blocks = root.querySelectorAll('pre code');
  if (!blocks.length) return;
  ensureHighlight().then(function () {
    if (typeof hljs === 'undefined') return;
    blocks.forEach(function (el) {
      if (el.dataset.highlighted === 'yes') return;
      const m = (el.className || '').match(/language-([\w+#-]+)/);
      if (m && !hljs.getLanguage(m[1])) {
        el.className = el.className.replace(/language-[\w+#-]+/, '').trim();
      }
      try { hljs.highlightElement(el); } catch (e) {}
    });
  });
}

// ============================================
// 阅读工具：目录 TOC + 阅读进度 + 代码块复制
// ============================================
function removeReadingTools() {
  const toc = document.getElementById('tocPanel');
  if (toc) toc.remove();
  const bar = document.getElementById('readingProgress');
  if (bar) bar.remove();
}

function findArticleBody() {
  return document.querySelector('.article-detail-body, .course-notes .markdown-body');
}

// 从正文的 h2/h3 生成目录（宽屏侧边栏 + 顶部进度条）
function buildReadingTools() {
  const body = findArticleBody();
  if (!body) { removeReadingTools(); return; }
  const heads = Array.prototype.slice.call(body.querySelectorAll('h2, h3'));
  if (heads.length < 3) { removeReadingTools(); return; }

  // 清掉旧目录，避免重复
  removeReadingTools();

  let tocLinks = '';
  heads.forEach(function (h, i) {
    h.id = 'heading-' + i;
    tocLinks += '<a class="toc-link ' + (h.tagName === 'H3' ? 'toc-h3' : '') + '" data-target="heading-' + i + '" tabindex="0">' + escapeHtml(h.textContent) + '</a>';
  });

  document.body.insertAdjacentHTML('beforeend',
    '<div class="toc-panel" id="tocPanel"><div class="toc-title">目录</div><nav class="toc-nav">' + tocLinks + '</nav></div>' +
    '<div class="reading-progress" id="readingProgress"><i></i></div>'
  );
  bindScrollSpy();
}

let _scrollSpyBound = false;
function bindScrollSpy() {
  if (_scrollSpyBound) return;
  _scrollSpyBound = true;
  window.addEventListener('scroll', function () {
    const bar = document.querySelector('#readingProgress i');
    if (bar) {
      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      const pct = total > 0 ? Math.min(100, Math.max(0, window.scrollY / total * 100)) : 0;
      bar.style.width = pct + '%';
    }
    const links = document.querySelectorAll('#tocPanel .toc-link');
    if (links.length) {
      const heads = Array.prototype.slice.call(findArticleBody() ? findArticleBody().querySelectorAll('h2, h3') : []);
      let active = 0;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].getBoundingClientRect().top <= 90) active = i;
      }
      links.forEach(function (a, i) { a.classList.toggle('active', i === active); });
    }
  }, { passive: true });
}

function scrollToHeading(id) {
  const el = document.getElementById(id);
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// 目录点击/回车滚动到标题（hash 路由下不能用锚点，会触发整页跳转）
document.addEventListener('click', function (e) {
  const t = e.target.closest ? e.target.closest('[data-target]') : null;
  if (!t) return;
  scrollToHeading(t.getAttribute('data-target'));
});

// 键盘无障碍：Enter/Space 触发 data-href（卡片类可点击元素）与 data-target（目录）
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest ? e.target.closest('[data-href],[data-target]') : null;
  if (!t) return;
  const tag = t.tagName;
  // 无 href 的 <a>（目录项）需要由这里接管回车；有 href 的原生跳转即可
  if ((tag === 'A' && t.hasAttribute('href')) || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  if (t.hasAttribute('data-target')) {
    scrollToHeading(t.getAttribute('data-target'));
  } else {
    location.hash = t.getAttribute('data-href');
  }
});

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  document.body.removeChild(ta);
}

function copyText(text, btn) {
  const done = function () {
    btn.textContent = '已复制 ✓';
    setTimeout(function () { btn.textContent = '复制'; }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}

// 给代码块加「语言标签 + 复制按钮」悬浮工具条
function enhanceCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach(function (pre) {
    if (pre.dataset.enhanced === '1') return;
    const code = pre.querySelector('code');
    if (!code) return;
    pre.dataset.enhanced = '1';
    const m = (code.className || '').match(/language-([\w+#-]+)/);
    const bar = document.createElement('div');
    bar.className = 'code-toolbar';
    bar.innerHTML =
      (m ? '<span class="code-lang">' + escapeHtml(m[1]) + '</span>' : '') +
      '<button class="copy-btn" type="button">复制</button>';
    pre.appendChild(bar);
    bar.querySelector('.copy-btn').addEventListener('click', function () {
      copyText(code.innerText || code.textContent || '', this);
    });
  });
}

// ============================================
// Page Renderers
// ============================================

function renderHome() {
  if (searchQuery.trim()) {
    return renderGlobalSearch(searchQuery.trim());
  }
  const filtered = filterPosts(getAllPosts(), '', null);

  if (filtered.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <p>没有找到相关文章</p>
      </div>
    `;
  }

  const cards = filtered.map(post => `
    <article class="article-card" data-href="#/post/${post.id}" tabindex="0" role="link" onclick="location.hash = '#/post/${post.id}'">
      <h2 class="article-card-title">
        <a href="#/post/${post.id}">${escapeHtml(post.title)}</a>
      </h2>
      <p class="article-card-excerpt">${escapeHtml(getExcerpt(post))}</p>
      <div class="article-card-meta">
        <span class="meta-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          ${formatDate(post.date)}
        </span>
        <span class="meta-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          ${readingTime(post.content)} 分钟阅读
        </span>
        <div class="article-card-tags">
          ${post.tags.map(t => `<span class="tag" onclick="event.stopPropagation(); location.hash='#/tags/${encodeURIComponent(t)}'">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
    </article>
  `).join('');

  return `<div class="article-list">${cards}</div>`;
}

function renderGlobalSearch(query) {
  const q = query.toLowerCase();
  const posts = getAllPosts().filter(p =>
    (p.title || '').toLowerCase().includes(q) ||
    (p.excerpt || '').toLowerCase().includes(q) ||
    (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (p.content || '').toLowerCase().includes(q)
  );
  const notesLoaded = typeof COURSE_NOTES !== 'undefined';
  const courses = (typeof COURSES !== 'undefined') ? COURSES.filter(c => {
    if (c.name.toLowerCase().includes(q) ||
        (c.category || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)) return true;
    // 笔记正文也参与搜索（课程区现在只有笔记）
    if (notesLoaded && COURSE_NOTES[c.id]) {
      const entry = COURSE_NOTES[c.id];
      return ((entry.summary || '') + (entry.notes || '')).toLowerCase().includes(q);
    }
    return false;
  }) : [];
  const papers = (typeof PAPERS !== 'undefined') ? PAPERS.filter(p =>
    (p.title || '').toLowerCase().includes(q) ||
    (p.authors || '').toLowerCase().includes(q) ||
    (p.abstract || '').toLowerCase().includes(q)
  ) : [];
  const materials = (typeof LEARNING_MATERIALS !== 'undefined') ? LEARNING_MATERIALS.filter(m =>
    (m.name || '').toLowerCase().includes(q) ||
    (m.subcategory || '').toLowerCase().includes(q)
  ) : [];

  const total = posts.length + courses.length + papers.length + materials.length;
  let html = `<div class="search-results-count">找到 ${total} 条与 “${escapeHtml(query)}” 相关的结果</div>`;

  if (posts.length) {
    html += `<div class="search-section-title">📝 文章 (${posts.length})</div>`;
    html += `<div class="article-list">` + posts.map(post => `
      <article class="article-card" data-href="#/post/${post.id}" tabindex="0" role="link" onclick="location.hash = '#/post/${post.id}'">
        <h2 class="article-card-title"><a href="#/post/${post.id}">${highlightMatch(post.title, query)}</a></h2>
        <p class="article-card-excerpt">${highlightMatch(getExcerpt(post), query)}</p>
        <div class="article-card-meta">
          <span class="meta-item">${formatDate(post.date)}</span>
          <div class="article-card-tags">${post.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </article>`).join('') + `</div>`;
  }
  if (courses.length) {
    html += `<div class="search-section-title">📚 课程 (${courses.length})</div>`;
    html += courses.map(c => {
      // 命中来自笔记正文时，直接给出上下文，省去再点进去确认
      const hit = (notesLoaded && COURSE_NOTES[c.id]) ? noteSearchHit(COURSE_NOTES[c.id], query) : null;
      return `
      <div class="search-course-item" data-href="#/course/${encodeURIComponent(c.id)}" tabindex="0" role="link" onclick="location.hash='#/course/${encodeURIComponent(c.id)}'">
        <span class="search-item-icon">📚</span>
        <div class="search-item-main">
          <div class="search-item-title">${highlightMatch(c.name, query)}</div>
          <div class="search-item-sub">${escapeHtml(c.category)} · ${notesLoaded && COURSE_NOTES[c.id] ? '📝 有笔记' : '暂无笔记'}${hit ? ' · 笔记命中 ' + hit.count + ' 处' : ''}</div>
          ${hit ? `<div class="search-item-snippet">${hit.html}</div>` : ''}
        </div>
        <span class="search-item-meta">查看 →</span>
      </div>`;
    }).join('');
  }
  if (papers.length) {
    html += `<div class="search-section-title">📄 论文 (${papers.length})</div>`;
    html += papers.map(p => `
      <div class="search-paper-item" data-href="#/papers" tabindex="0" role="link" onclick="location.hash='#/papers'">
        <span class="search-item-icon">📄</span>
        <div class="search-item-main">
          <div class="search-item-title">${highlightMatch(p.title, query)}</div>
          <div class="search-item-sub">${escapeHtml(p.authors || '')}</div>
        </div>
        <span class="search-item-meta">查看 →</span>
      </div>`).join('');
  }
  if (materials.length) {
    html += `<div class="search-section-title">📎 学习资料 (${materials.length})</div>`;
    html += materials.map(m => `
      <div class="search-paper-item" data-href="#/papers" tabindex="0" role="link" onclick="location.hash='#/papers'">
        <span class="search-item-icon">📎</span>
        <div class="search-item-main">
          <div class="search-item-title">${escapeHtml(m.name || '')}</div>
          <div class="search-item-sub">${escapeHtml(m.subcategory || '')}</div>
        </div>
        <span class="search-item-meta">查看 →</span>
      </div>`).join('');
  }
  if (total === 0) {
    html += `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>没有找到相关内容，换个关键词试试</p></div>`;
  }
  return html;
}

function renderPost(id) {
  const post = getAllPosts().find(p => p.id === id);
  if (!post) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📄</div>
        <p>文章不存在</p>
        <p><a href="#/">返回首页</a></p>
      </div>
    `;
  }

  const html = renderMarkdown(post.content);

  return `
    <a href="#/" class="article-back">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      返回首页
    </a>
    <article class="article-detail fade-in">
      <div class="article-detail-header">
        <h1 class="article-detail-title">${escapeHtml(post.title)}</h1>
        <div class="article-detail-meta">
          <span class="meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            ${formatDate(post.date)}
          </span>
          <span class="meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${readingTime(post.content)} 分钟阅读
          </span>
          <div class="article-card-tags">
            ${post.tags.map(t => `<span class="tag" onclick="location.hash='#/tags/${encodeURIComponent(t)}'">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="article-detail-body markdown-body">
        ${html}
      </div>
    </article>
    ${renderSeriesNav(post)}
    ${renderPostNav(post)}
    <div class="giscus-wrap">
      <h3 class="giscus-wrap-title">💬 评论与讨论</h3>
      <div id="giscus-container"></div>
      ${GISCUS_CONFIG.enabled ? '' : '<div class="giscus-hint">评论基于 GitHub Discussions（免费）。启用方法：在 <code>js/app.js</code> 顶部的 <code>GISCUS_CONFIG</code> 中填入 <code>repoId</code> 和 <code>categoryId</code>（在 <a href="https://giscus.app" target="_blank" rel="noopener">giscus.app</a> 配置后获取），并把 <code>enabled</code> 改为 <code>true</code>。详见「关于」页说明。</div>'}
    </div>
  `;
}

// 上一篇/下一篇（按日期）+ 基于标签重叠的相关推荐
function renderPostNav(post) {
  const posts = getAllPosts().slice().sort((a, b) => b.date.localeCompare(a.date));
  const idx = posts.findIndex(p => p.id === post.id);
  const newer = idx > 0 ? posts[idx - 1] : null;
  const older = idx >= 0 && idx < posts.length - 1 ? posts[idx + 1] : null;

  let html = '';
  if (newer || older) {
    html += '<nav class="post-nav">';
    html += newer
      ? `<a class="post-nav-item" href="#/post/${newer.id}"><span class="post-nav-label">← 上一篇</span><span class="post-nav-title">${escapeHtml(newer.title)}</span></a>`
      : '<span class="post-nav-item post-nav-empty"></span>';
    html += older
      ? `<a class="post-nav-item post-nav-next" href="#/post/${older.id}"><span class="post-nav-label">下一篇 →</span><span class="post-nav-title">${escapeHtml(older.title)}</span></a>`
      : '<span class="post-nav-item post-nav-empty"></span>';
    html += '</nav>';
  }

  // 相关文章：共享标签越多越相关
  const tags = post.tags || [];
  const related = getAllPosts()
    .filter(p => p.id !== post.id)
    .map(p => ({ post: p, score: (p.tags || []).filter(t => tags.indexOf(t) !== -1).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.post.date.localeCompare(a.post.date))
    .slice(0, 3);

  if (related.length) {
    html += '<section class="related-posts"><h3 class="related-title">相关文章</h3>';
    related.forEach(x => {
      html += `<a class="related-item" href="#/post/${x.post.id}">
        <span class="related-item-title">${escapeHtml(x.post.title)}</span>
        <span class="related-item-meta">${formatDate(x.post.date)}</span>
      </a>`;
    });
    html += '</section>';
  }
  return html;
}

function renderSeriesNav(post) {
  if (!post.series) return '';
  const series = getAllPosts().filter(p => p.series === post.series)
    .sort((a, b) => (a.seriesOrder || 0) - (b.seriesOrder || 0));
  if (series.length < 2) return '';
  const idx = series.findIndex(p => p.id === post.id);
  const prev = idx > 0 ? series[idx - 1] : null;
  const next = idx < series.length - 1 ? series[idx + 1] : null;
  const dots = series.map((p, i) => `<div class="series-dot ${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}"></div>`).join('');
  const list = series.map((p, i) => {
    const cls = `${i < idx ? 'done' : ''} ${i === idx ? 'current' : ''}`.trim();
    const inner = i === idx ? escapeHtml(p.title) : `<a href="#/post/${p.id}">${escapeHtml(p.title)}</a>`;
    return `<li class="${cls}">${inner}</li>`;
  }).join('');
  return `
    <div class="series-nav">
      <span class="series-nav-badge">📚 系列 · ${escapeHtml(post.series)}</span>
      <div class="series-progress">${dots}</div>
      <ol class="series-list">${list}</ol>
      <div class="series-prev-next">
        <span>${prev ? `<a href="#/post/${prev.id}">← ${escapeHtml(prev.title)}</a>` : '<span class="disabled">已是第一篇</span>'}</span>
        <span>${next ? `<a href="#/post/${next.id}">${escapeHtml(next.title)} →</a>` : '<span class="disabled">已是最后一篇</span>'}</span>
      </div>
    </div>`;
}

function renderTags(tag) {
  const allTags = getAllTags();

  let tagCloud = allTags.map(t => `
    <span class="tag-cloud-item ${tag === t.name ? 'active' : ''}"
          data-tag-link="${escapeHtml(t.name)}" role="button" tabindex="0">
      ${escapeHtml(t.name)}
      <span class="tag-count">(${t.count})</span>
    </span>
  `).join('');

  let content = '';

  if (tag) {
    const filtered = filterPosts(getAllPosts(), null, tag);
    content = `
      <h1 class="page-title">标签: ${escapeHtml(tag)}</h1>
      <p class="page-desc">共 ${filtered.length} 篇文章</p>
    `;

    if (filtered.length === 0) {
      content += `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>该标签下暂无文章</p>
        </div>
      `;
    } else {
      content += `<div class="article-list">`;
      content += filtered.map(post => `
        <article class="article-card" onclick="location.hash = '#/post/${post.id}'">
          <h2 class="article-card-title">
            <a href="#/post/${post.id}">${escapeHtml(post.title)}</a>
          </h2>
          <p class="article-card-excerpt">${escapeHtml(getExcerpt(post))}</p>
          <div class="article-card-meta">
            <span class="meta-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              ${formatDate(post.date)}
            </span>
            <div class="article-card-tags">
              ${post.tags.map(t => `<span class="tag" onclick="event.stopPropagation(); location.hash='#/tags/${encodeURIComponent(t)}'">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
        </article>
      `).join('');
      content += `</div>`;
    }
  } else {
    content = `
      <h1 class="page-title">所有标签</h1>
      <p class="page-desc">点击标签查看相关文章</p>
    `;
  }

  return `
    <div class="tags-cloud">${tagCloud}</div>
    ${content}
  `;
}

// ============================================
// Courses Renderers
// ============================================

function getFileTypeClass(type) {
  const map = {
    'PDF文档': 'pdf', 'PPT课件': 'ppt', 'Word文档': 'word',
    'Python代码': 'code', 'Jupyter Notebook': 'code', 'MATLAB代码': 'code',
    'C代码': 'code', 'C++代码': 'code', '头文件': 'code', 'Java代码': 'code',
    'Excel表格': 'excel', '图片': 'image', '视频': 'video',
    '压缩包': 'archive', '字体': 'font', 'HTML文件': 'code',
    'CSS文件': 'code', 'JavaScript文件': 'code', 'URDF模型': 'code',
    'ROS启动文件': 'code', 'YAML配置': 'other', 'Simulink模型': 'code',
  };
  return map[type] || 'other';
}

function getCategoryIcon(cat) {
  const icons = {
    '机器人与自动化': '🤖',
    '人工智能与机器学习': '🧠',
    '信号与控制': '📡',
    '计算机科学': '💻',
    '电子与硬件': '🔌',
    '数理基础': '📐',
    '设计': '🎨',
    '其他课程': '📚',
  };
  return icons[cat] || '📖';
}

// 课程分类的展示顺序（列表与详情页导航共用）
const COURSE_CATEGORY_ORDER = ['机器人与自动化', '人工智能与机器学习', '信号与控制', '计算机科学', '电子与硬件', '数理基础', '设计', '其他课程'];

// 笔记纯文本（摘要 + 正文），用于统计与全文搜索
function noteText(entry) {
  if (!entry) return '';
  return (entry.summary || '') + '\n' + (entry.notes || '');
}

// 笔记规模：字数与预计阅读时长
function noteStats(courseId) {
  if (typeof COURSE_NOTES === 'undefined' || !COURSE_NOTES[courseId]) return null;
  const text = noteText(COURSE_NOTES[courseId]);
  const chars = text.replace(/\s+/g, '').length;
  return {
    chars: chars,
    charsLabel: chars >= 1000 ? (chars / 1000).toFixed(1) + ' 千字' : chars + ' 字',
    minutes: readingTime(text)
  };
}

// 笔记全文命中：返回高亮片段与命中次数；未命中返回 null
function noteSearchHit(entry, query) {
  const raw = noteText(entry);
  const q = (query || '').toLowerCase();
  if (!raw || !q) return null;
  const lower = raw.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return null;
  let count = 0, from = 0;
  while (true) {
    const at = lower.indexOf(q, from);
    if (at === -1) break;
    count++;
    from = at + q.length;
  }
  const start = Math.max(0, idx - 36);
  const end = Math.min(raw.length, idx + q.length + 64);
  const snippet = raw.slice(start, end)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[#>*`_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    count: count,
    html: (start > 0 ? '…' : '') + highlightMatch(snippet, query) + (end < raw.length ? '…' : '')
  };
}

// 已整理笔记的课程，按 分类顺序 + 课程名 排序
function getNoteCourses() {
  if (typeof COURSES === 'undefined' || typeof COURSE_NOTES === 'undefined') return [];
  return COURSES.filter(c => COURSE_NOTES[c.id]).sort((a, b) => {
    const ia = COURSE_CATEGORY_ORDER.indexOf(a.category);
    const ib = COURSE_CATEGORY_ORDER.indexOf(b.category);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

function renderCourses() {
  const notesReady = typeof COURSE_NOTES !== 'undefined';
  const noteCount = notesReady ? Object.keys(COURSE_NOTES).length : 0;

  // Stats bar
  let html = `
    <div class="courses-page">
      <h1 class="page-title">📚 课程笔记</h1>
      <p class="page-desc">本科到研究生的课程核心笔记，按学科方向分类整理 · <a href="notes/index.html">静态笔记合集 →</a></p>
      <div class="courses-stats">
        <div class="stat-card">
          <div class="stat-value">${noteCount}</div>
          <div class="stat-label">篇笔记</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${COURSES.length}</div>
          <div class="stat-label">门课程</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${Object.keys(COURSE_CATEGORIES).length}</div>
          <div class="stat-label">个分类</div>
        </div>
      </div>
  `;

  // 视图切换：只看有笔记 / 全部课程
  html += '<div class="category-filter">';
  html += `<span class="category-chip ${courseNotesOnly ? 'active' : ''}" onclick="setNotesOnly(true)">📝 有笔记 <span class="chip-count">${noteCount}</span></span>`;
  html += `<span class="category-chip ${!courseNotesOnly ? 'active' : ''}" onclick="setNotesOnly(false)">📚 全部课程 <span class="chip-count">${COURSES.length}</span></span>`;
  html += '</div>';

  // 基础集合：默认只保留已整理笔记的课程
  let base = COURSES;
  if (courseNotesOnly && notesReady) {
    base = base.filter(c => COURSE_NOTES[c.id]);
  }

  // Category filter
  const categoryOrder = COURSE_CATEGORY_ORDER;
  html += '<div class="category-filter">';
  html += `<span class="category-chip ${!activeCategory ? 'active' : ''}" data-category="" role="button" tabindex="0">全部</span>`;
  for (const cat of categoryOrder) {
    const count = base.filter(c => c.category === cat).length;
    if (count > 0) {
      html += `<span class="category-chip ${activeCategory === cat ? 'active' : ''}" data-category="${escapeHtml(cat)}" role="button" tabindex="0">
        ${getCategoryIcon(cat)} ${escapeHtml(cat)}
        <span class="chip-count">${count}</span>
      </span>`;
    }
  }
  html += '</div>';

  // Course search
  html += `
    <div class="search-wrap" style="margin-bottom: 24px;">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" id="courseSearchInput" placeholder="搜索课程..." class="search-input" value="${escapeHtml(courseSearchQuery)}">
    </div>
  `;

  // Filter courses
  let filtered = base;
  if (activeCategory) {
    filtered = filtered.filter(c => c.category === activeCategory);
  }
  if (courseSearchQuery) {
    const q = courseSearchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q) ||
      (c.year || '').toLowerCase().includes(q) ||
      // 笔记正文同样参与搜索：课程区只展示笔记，正文才是主要内容
      (notesReady && COURSE_NOTES[c.id] && noteText(COURSE_NOTES[c.id]).toLowerCase().includes(q))
    );
  }

  // Group by category
  const grouped = {};
  filtered.forEach(c => {
    if (!grouped[c.category]) grouped[c.category] = [];
    grouped[c.category].push(c);
  });

  if (filtered.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <p>没有找到匹配的课程</p>
      </div>
    `;
  } else {
    for (const cat of categoryOrder) {
      if (!grouped[cat]) continue;
      const courses = grouped[cat].slice().sort((a, b) => {
        const na = notesReady && COURSE_NOTES[a.id] ? 1 : 0;
        const nb = notesReady && COURSE_NOTES[b.id] ? 1 : 0;
        return nb - na || a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      html += `
        <div class="course-section">
          <h2 class="course-section-title">
            ${getCategoryIcon(cat)} ${cat}
            <span class="section-count">${courses.length} 门课程</span>
          </h2>
          <div class="course-grid">
      `;
      for (const course of courses) {
        const hasNotes = notesReady && !!COURSE_NOTES[course.id];
        const stats = hasNotes ? noteStats(course.id) : null;
        const hit = (hasNotes && courseSearchQuery.trim()) ? noteSearchHit(COURSE_NOTES[course.id], courseSearchQuery.trim()) : null;
        const yearBadge = course.year ? `<span class="course-card-year">${course.year}</span>` : '';
        const statsBadge = stats ? `<span class="meta-item">📝 ${stats.charsLabel} · 约 ${stats.minutes} 分钟</span>` : '';
        html += `
          <div class="course-card${hasNotes ? '' : ' course-card-muted'}" data-course-id="${escapeHtml(course.id)}" data-href="#/course/${encodeURIComponent(course.id)}" tabindex="0" role="link" onclick="location.hash='#/course/${encodeURIComponent(course.id)}'">
            <div class="course-card-header">
              <div class="course-card-title">${escapeHtml(course.name)}</div>
              ${hasNotes ? '<span class="note-badge">📝笔记</span>' : ''}
            </div>
            ${course.description ? `<div class="course-card-desc">${escapeHtml(course.description)}</div>` : ''}
            ${hit ? `<div class="course-card-hit"><div class="course-card-hit-text">${hit.html}</div><span class="hit-count">笔记命中 ${hit.count} 处</span></div>` : ''}
            <div class="course-card-meta">
              ${hasNotes ? statsBadge : '<span class="meta-item">暂无笔记</span>'}
              ${yearBadge}
            </div>
          </div>
        `;
      }
      html += '</div></div>';
    }
  }

  html += '</div>';
  return html;
}

function renderCourseDetail(courseId) {
  const course = COURSES.find(c => c.id === courseId);
  if (!course) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <p>课程不存在</p>
        <p><a href="#/courses">返回课程列表</a></p>
      </div>
    `;
  }

  const notesHtml = renderCourseNotes(course.id);
  const stats = noteStats(course.id);

  return `
    <a href="#/courses" class="article-back">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      返回课程列表
    </a>
    <div class="course-detail">
      <div class="course-detail-header">
        <h1 class="course-detail-title">${escapeHtml(course.name)}</h1>
        <div class="course-detail-meta">
          <span class="meta-item">📂 ${escapeHtml(course.category)}</span>
          ${course.year ? `<span class="meta-item">📅 ${course.year}</span>` : ''}
          ${stats ? `<span class="meta-item">📝 ${stats.charsLabel} · 约 ${stats.minutes} 分钟</span>` : ''}
        </div>
      </div>
      ${course.description ? `<div class="course-description">${escapeHtml(course.description)}</div>` : ''}
      ${notesHtml || `
        <div class="empty-state">
          <div class="empty-state-icon">📝</div>
          <p>这门课还没有整理笔记</p>
          <p><a href="#/courses">返回课程列表</a></p>
        </div>
      `}
      ${renderCourseNoteNav(course)}
    </div>
  `;
}

// 笔记页底部：上一篇/下一篇 + 同方向的其他笔记（内链，便于连续阅读）
function renderCourseNoteNav(course) {
  if (typeof COURSE_NOTES === 'undefined' || !COURSE_NOTES[course.id]) return '';
  const list = getNoteCourses();
  const idx = list.findIndex(c => c.id === course.id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  let html = '';
  if (prev || next) {
    html += '<nav class="post-nav note-nav">';
    html += prev
      ? `<a class="post-nav-item" href="#/course/${encodeURIComponent(prev.id)}"><span class="post-nav-label">← 上一篇笔记</span><span class="post-nav-title">${escapeHtml(prev.name)}</span></a>`
      : '<span class="post-nav-item post-nav-empty"></span>';
    html += next
      ? `<a class="post-nav-item post-nav-next" href="#/course/${encodeURIComponent(next.id)}"><span class="post-nav-label">下一篇笔记 →</span><span class="post-nav-title">${escapeHtml(next.name)}</span></a>`
      : '<span class="post-nav-item post-nav-empty"></span>';
    html += '</nav>';
  }

  const related = list.filter(c => c.id !== course.id && c.category === course.category).slice(0, 4);
  if (related.length) {
    html += '<section class="related-posts"><h3 class="related-title">同方向的其他笔记</h3>';
    related.forEach(c => {
      const s = noteStats(c.id);
      html += `<a class="related-item" href="#/course/${encodeURIComponent(c.id)}">
        <span class="related-item-title">${escapeHtml(c.name)}</span>
        <span class="related-item-meta">${s ? s.charsLabel : ''}</span>
      </a>`;
    });
    html += '</section>';
  }
  return html;
}

// Render course notes (Markdown) from course-notes.js, keyed by course id.
// Returns '' when no notes exist for this course, so the page is untouched.
function renderCourseNotes(courseId) {
  if (typeof COURSE_NOTES === 'undefined' || !COURSE_NOTES[courseId]) return '';
  const entry = COURSE_NOTES[courseId];
  const summary = entry.summary ? `<p class="course-notes-summary">${escapeHtml(entry.summary)}</p>` : '';
  const body = entry.notes ? `<div class="markdown-body">${renderMarkdown(entry.notes)}</div>` : '';
  const staticPage = (typeof NOTE_PAGES !== 'undefined' && NOTE_PAGES[courseId]) ? NOTE_PAGES[courseId] : null;
  const permalink = staticPage
    ? `<a class="notes-permalink" href="${staticPage}" title="可被搜索引擎收录、便于分享的静态版本">🔗 静态页</a>`
    : '';
  return `
    <section class="course-notes">
      <div class="course-notes-head">📝 课程笔记 ${permalink}</div>
      ${summary}
      ${body}
    </section>
  `;
}

// ============================================
// Code & File Library Renderers
// ============================================
function renderCode() {
  const totalFiles = CODE_LIBS.reduce((sum, l) => sum + l.fileCount, 0);
  const totalSize = CODE_LIBS.reduce((sum, l) => sum + l.totalSize, 0);

  let html = `
    <div class="courses-page">
      <h1 class="page-title">💻 代码与文件库</h1>
      <p class="page-desc">我历年写过/收集的代码与文件，按来源目录整理（文件保留在原始磁盘，未做任何复制）</p>
      <div class="courses-stats">
        <div class="stat-card"><div class="stat-value">${CODE_LIBS.length}</div><div class="stat-label">个代码库</div></div>
        <div class="stat-card"><div class="stat-value">${totalFiles}</div><div class="stat-label">个文件</div></div>
        <div class="stat-card"><div class="stat-value">${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB</div><div class="stat-label">总大小</div></div>
        <div class="stat-card"><div class="stat-value">${Object.keys(CODE_CATEGORIES).length}</div><div class="stat-label">个分类</div></div>
      </div>
  `;

  html += `
    <div class="search-wrap" style="margin-bottom: 24px;">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" id="codeLibSearchInput" placeholder="搜索代码库或文件名..." class="search-input" value="${escapeHtml(codeLibSearchQuery)}">
    </div>
  `;

  let filtered = CODE_LIBS;
  if (codeLibSearchQuery) {
    const q = codeLibSearchQuery.toLowerCase();
    filtered = filtered.filter(l =>
      (l.name || '').toLowerCase().includes(q) ||
      (l.category || '').toLowerCase().includes(q) ||
      (l.source || '').toLowerCase().includes(q) ||
      l.files.some(f => (f.name || '').toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>没有找到匹配的代码库</p></div>`;
  } else {
    html += '<div class="course-grid">';
    for (const lib of filtered) {
      html += `
        <div class="course-card" data-href="#/codelib/${encodeURIComponent(lib.id)}" tabindex="0" role="link" onclick="location.hash='#/codelib/${encodeURIComponent(lib.id)}'">
          <div class="course-card-header">
            <div class="course-card-title">${escapeHtml(lib.name)}</div>
            <span class="course-card-source">${escapeHtml(lib.category)}</span>
          </div>
          <div class="course-card-meta">
            ${lib.source ? `<span class="meta-item">📂 ${escapeHtml(lib.source)}</span>` : ''}
            <span class="meta-item">📁 ${lib.fileCount} 个文件</span>
            <span class="meta-item">💾 ${lib.totalSizeFormatted}</span>
          </div>
          ${lib.description ? `<div class="course-card-desc">${escapeHtml(lib.description)}</div>` : ''}
          ${lib.guide ? `<div class="course-card-badge-row"><span class="course-card-badge">📖 有导读</span></div>` : ''}
        </div>
      `;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderCodeDetail(libId) {
  const lib = CODE_LIBS.find(l => l.id === libId);
  if (!lib) {
    return `<div class="empty-state"><div class="empty-state-icon">💻</div><p>代码库不存在</p><p><a href="#/code">返回代码库列表</a></p></div>`;
  }


  let html = `
    <a href="#/code" class="article-back">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      返回代码库列表
    </a>
    <div class="course-detail">
      <div class="course-detail-header">
        <h1 class="course-detail-title">${escapeHtml(lib.name)}</h1>
        <div class="course-detail-meta">
          <span class="meta-item">📂 ${escapeHtml(lib.category)}</span>
          ${lib.source ? `<span class="meta-item">📍 ${escapeHtml(lib.source)}</span>` : ''}
          <span class="meta-item">📁 ${lib.fileCount} 个文件</span>
          <span class="meta-item">💾 ${lib.totalSizeFormatted}</span>
        </div>
        ${lib.description ? `<div class="course-description">${escapeHtml(lib.description)}</div>` : ''}
        ${lib.guide ? `<div class="code-lib-guide"><div class="code-lib-guide-title">📖 代码库导读</div>${renderMarkdown(lib.guide)}</div>` : ''}
      </div>
  `;

  // 按项目(第一级目录)分组；默认折叠，点击项目名展开
  const _groups = {};
  const _root = [];
  for (const f of lib.files) {
    if (f.project) {
      (_groups[f.project] = _groups[f.project] || []).push(f);
    } else {
      _root.push(f);
    }
  }
  currentCodeProjects = Object.keys(_groups)
    .sort((a, b) => _groups[b].length - _groups[a].length)
    .map(k => ({ name: k, files: _groups[k] }));
  const _rootHtml = _root.map(f => renderCodeFileItem(f)).join('');

  html += `
      <div class="file-list">
        <div class="file-list-header">按项目分类（${currentCodeProjects.length} 个项目${_root.length ? '，另有 ' + _root.length + ' 个根目录文件' : ''}）— 点击项目名展开</div>
        <div id="code-project-container">
          ${currentCodeProjects.map((proj, pi) => `
            <div class="code-project">
              <div class="code-project-header" id="code-proj-hdr-${pi}" onclick="toggleCodeProject(${pi})">
                <span class="code-project-name">📁 ${escapeHtml(proj.name)}</span>
                <span class="code-project-count">${proj.files.length} 个文件 ▾</span>
              </div>
              <div class="code-project-body" id="code-proj-body-${pi}" style="display:none"></div>
            </div>
          `).join('')}
          ${_rootHtml}
        </div>
      </div>
      <div style="margin-top: 20px; padding: 12px 16px; background: var(--color-bg); border-radius: var(--radius-sm); font-size: 0.82rem; color: var(--color-text-muted);">
        💡 文件保留在原始磁盘，未做任何复制，此处仅展示文件清单。
      </div>
    </div>
  `;

  return html;
}

function renderCodeFileItem(file) {
  const typeClass = getFileTypeClass(file.type);
  return `
      <div class="file-item">
        <span class="file-type-badge ${typeClass}">${escapeHtml(file.type)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-size">${file.sizeFormatted}</span>
      </div>
  `;
}

window.toggleCodeProject = function(pi) {
  const proj = currentCodeProjects[pi];
  if (!proj) return;
  const body = document.getElementById('code-proj-body-' + pi);
  if (!body) return;
  const hidden = body.style.display === 'none' || body.style.display === '';
  if (body.dataset.loaded === '1') {
    body.style.display = hidden ? 'block' : 'none';
    const hdr = document.getElementById('code-proj-hdr-' + pi);
    if (hdr) hdr.querySelector('.code-project-count').textContent = proj.files.length + ' 个文件 ' + (hidden ? '▴' : '▾');
    return;
  }
  let html = '';
  const files = proj.files;
  const limit = Math.min(files.length, CODE_PROJECT_FILE_CAP);
  for (let i = 0; i < limit; i++) html += renderCodeFileItem(files[i]);
  if (files.length > limit) {
    html += `<div class="code-more" onclick="loadMoreProjFiles(${pi}, ${limit})">展开剩余 ${files.length - limit} 个文件</div>`;
  }
  body.innerHTML = html;
  body.dataset.loaded = '1';
  body.style.display = 'block';
  const hdr = document.getElementById('code-proj-hdr-' + pi);
  if (hdr) hdr.querySelector('.code-project-count').textContent = proj.files.length + ' 个文件 ▴';
};

window.loadMoreProjFiles = function(pi, from) {
  const proj = currentCodeProjects[pi];
  if (!proj) return;
  const body = document.getElementById('code-proj-body-' + pi);
  if (!body) return;
  let html = '';
  const files = proj.files;
  const limit = Math.min(files.length, from + CODE_PROJECT_FILE_CAP);
  for (let i = from; i < limit; i++) html += renderCodeFileItem(files[i]);
  const more = body.querySelector('.code-more');
  if (more) more.remove();
  if (files.length > limit) {
    html += `<div class="code-more" onclick="loadMoreProjFiles(${pi}, ${limit})">展开剩余 ${files.length - limit} 个文件</div>`;
  }
  body.insertAdjacentHTML('beforeend', html);
};

// ============================================
// Papers & Learning Materials Renderers
// ============================================

function getPaperCategoryIcon(cat) {
  const icons = {
    '具身智能': '🧠',
    '双足机器人': '🦿',
    '轮足机器人': '🦼',
    '软体机器人': '🪱',
    '港大教授论文': '🎓',
    '课程论文': '📖',
    '已读论文': '✅',
    '其他机器人': '🤖',
    '未分类': '📄',
  };
  return icons[cat] || '📄';
}

function renderPapers() {
  let html = `
    <div class="papers-page">
      <h1 class="page-title">📄 论文与学习资料</h1>
      <p class="page-desc">Zotero 论文库 + 个人学习资料整理</p>
      <div class="paper-tabs">
        <button class="paper-tab ${paperTab === 'papers' ? 'active' : ''}" onclick="setPaperTab('papers')">
          📄 论文 (${PAPERS.length})
        </button>
        <button class="paper-tab ${paperTab === 'materials' ? 'active' : ''}" onclick="setPaperTab('materials')">
          📚 学习资料 (${LEARNING_MATERIALS.length})
        </button>
      </div>
  `;

  if (paperTab === 'papers') {
    html += renderPapersTab();
  } else {
    html += renderMaterialsTab();
  }

  html += '</div>';
  return html;
}

function renderPapersTab() {
  const categoryOrder = ['具身智能', '双足机器人', '轮足机器人', '软体机器人', '港大教授论文', '课程论文', '已读论文', '其他机器人', '未分类'];

  let html = `
    <div class="search-wrap" style="margin-bottom: 20px;">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" id="paperSearchInput" placeholder="搜索论文标题/作者/摘要..." class="search-input" value="${escapeHtml(paperSearchQuery)}">
    </div>
    <div class="category-filter">
      <span class="category-chip ${!activePaperCategory ? 'active' : ''}" data-paper-category="" role="button" tabindex="0">全部</span>
  `;

  for (const cat of categoryOrder) {
    if (PAPER_CATEGORIES[cat]) {
      html += `<span class="category-chip ${activePaperCategory === cat ? 'active' : ''}" data-paper-category="${escapeHtml(cat)}" role="button" tabindex="0">
        ${getPaperCategoryIcon(cat)} ${escapeHtml(cat)}
        <span class="chip-count">${PAPER_CATEGORIES[cat].count}</span>
      </span>`;
    }
  }
  html += '</div>';

  let filtered = PAPERS;
  if (activePaperCategory) {
    filtered = filtered.filter(p => p.category === activePaperCategory);
  }
  if (paperSearchQuery) {
    const q = paperSearchQuery.toLowerCase();
    filtered = filtered.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.authors || '').toLowerCase().includes(q) ||
      (p.abstract || '').toLowerCase().includes(q) ||
      (p.venue || '').toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>没有找到匹配的论文</p></div>`;
  } else {
    const grouped = {};
    filtered.forEach(p => {
      if (!grouped[p.category]) grouped[p.category] = [];
      grouped[p.category].push(p);
    });

    for (const cat of categoryOrder) {
      if (!grouped[cat]) continue;
      html += `
        <div class="course-section">
          <h2 class="course-section-title">
            ${getPaperCategoryIcon(cat)} ${cat}
            <span class="section-count">${grouped[cat].length} 篇</span>
          </h2>
      `;
      for (const paper of grouped[cat]) {
        const typeClass = paper.type || 'other';
        let pdfLink = '';
        if (paper.url) {
          pdfLink = `<a class="paper-pdf-link" href="${escapeHtml(paper.url)}" target="_blank" rel="noopener">🔗 PDF</a>`;
        }
        const venue = paper.venue ? `<span class="meta-item">📰 ${escapeHtml(paper.venue)}</span>` : '';
        const date = paper.date ? `<span class="meta-item">📅 ${escapeHtml(paper.date)}</span>` : '';

        html += `
          <div class="paper-card" onclick="this.classList.toggle('expanded')">
            <div class="paper-card-title">${escapeHtml(paper.title)}</div>
            <div class="paper-card-authors">${escapeHtml(paper.authors)}</div>
            <div class="paper-card-meta">
              <span class="paper-type-badge ${typeClass}">${escapeHtml(paper.type)}</span>
              ${venue}
              ${date}
              ${pdfLink}
            </div>
            ${paper.abstract ? `<div class="paper-abstract">${escapeHtml(paper.abstract)}</div>` : ''}
          </div>
        `;
      }
      html += '</div>';
    }
  }

  return html;
}

function renderMaterialsTab() {
  let html = `
    <div class="search-wrap" style="margin-bottom: 20px;">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="text" id="paperSearchInput" placeholder="搜索学习资料..." class="search-input" value="${escapeHtml(paperSearchQuery)}">
    </div>
  `;

  let filtered = LEARNING_MATERIALS;
  if (paperSearchQuery) {
    const q = paperSearchQuery.toLowerCase();
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q) ||
      (m.subcategory || '').toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>没有找到匹配的资料</p></div>`;
  } else {
    const grouped = {};
    filtered.forEach(m => {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(m);
    });

    const catIcons = { 'ANSYS仿真': '🔧', '机械臂CAD模型': '🦾', 'CAD建模': '📐' };

    for (const [cat, materials] of Object.entries(grouped)) {
      html += `
        <div class="course-section">
          <h2 class="course-section-title">
            ${catIcons[cat] || '📁'} ${cat}
            <span class="section-count">${materials.length} 个文件</span>
          </h2>
          <div class="file-list">
            <div class="file-list-header">文件列表 (${materials.length})</div>
      `;
      for (const m of materials) {
        const typeClass = getFileTypeClass(m.type);
        html += `
          <div class="file-item">
            <span class="file-type-badge ${typeClass}">${escapeHtml(m.type)}</span>
            <span class="file-name">${escapeHtml(m.name)}</span>
            ${m.subcategory ? `<span class="file-path">${escapeHtml(m.subcategory)}</span>` : ''}
            <span class="file-size">${m.sizeFormatted}</span>
          </div>
        `;
      }
      html += '</div></div>';
    }
  }

  return html;
}

function renderAbout() {
  return `
    <div class="about-page fade-in">
      <div class="about-header">
        <div class="about-avatar">🦐</div>
        <h1 class="about-name">Eric</h1>
        <p class="about-bio">产线智能化工程师 / 机器人爱好者 / 周末城市探索者</p>
      </div>

      <div class="markdown-body">
        <p>你好，我是 Eric，在深圳工作生活。白天搞产线智能化和机器人，晚上偶尔写写技术笔记。</p>
        <p>这个博客记录我在以下领域的探索和思考：</p>
        <ul>
          <li><strong>智能制造</strong>：产线数字化、智能检测、工艺优化</li>
          <li><strong>机器人</strong>：机械臂控制、轨迹规划、具身智能</li>
          <li><strong>VLA模型</strong>：Vision-Language-Action 架构的实践与思考</li>
          <li><strong>生活随笔</strong>：深圳周边探索、读书笔记</li>
        </ul>
      </div>

      <div class="about-section">
        <h3>📍 坐标</h3>
        <p>深圳 / 香港（工作日在香港，周末回深圳）</p>
      </div>

      <div class="about-section">
        <h3>🔧 技术栈</h3>
        <p>Python / C++ / ROS2 / PyTorch / PLC / OPC UA</p>
      </div>

      <div class="about-section">
        <h3>📚 关注方向</h3>
        <p>具身智能 · VLA模型 · 机械臂控制 · 产线智能化 · 柔性制造</p>
      </div>

      <div class="about-section">
        <h3>🌐 联系我</h3>
        <div class="about-links">
          <a href="#/" class="about-link">📝 博客首页</a>
          <a href="#/courses" class="about-link">📚 课程资料库</a>
          <a href="#/papers" class="about-link">📄 论文与资料</a>
          <a href="#/tags" class="about-link">🏷️ 按标签浏览</a>
          <a href="#/projects" class="about-link">🛠️ 项目作品</a>
          <a href="#/archive" class="about-link">🗓️ 文章归档</a>
          <a href="#/links" class="about-link">🔗 友情链接</a>
        </div>
      </div>

      <div class="about-section">
        <h3>💡 关于这个博客</h3>
        <p>纯前端实现，零后端依赖，Markdown 渲染。</p>
        <p>博客文章存储在 data.js，课程资料索引存储在 courses.js，部署简单到只需一个静态服务器。</p>
        <p>📚 <a href="#/courses">课程笔记</a> 整理了本科到研究生阶段的课程笔记${typeof COURSES !== 'undefined' ? `，覆盖 ${COURSES.length} 门课程中的 ${typeof COURSE_NOTES !== 'undefined' ? Object.keys(COURSE_NOTES).length : 0} 门` : ''}，按 8 个学科方向分类归档。</p>
      </div>
    </div>
  `;
}

function renderProjects() {
  const grid = PROJECTS.map(p => `
    <article class="project-card">
      <div class="project-card-head">
        <span class="project-card-icon">${p.icon || '📦'}</span>
        <span class="project-card-name">${escapeHtml(p.name)}</span>
        <span class="project-card-status ${p.status === '已完成' ? 'done' : 'doing'}">${escapeHtml(p.status)}</span>
      </div>
      <p class="project-card-desc">${escapeHtml(p.description)}</p>
      ${p.highlights && p.highlights.length ? `
        <ul class="project-card-highlights">
          ${p.highlights.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
        </ul>` : ''}
      <div class="project-card-tech">
        ${p.tech.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="project-card-year">${escapeHtml(p.year || '')} · ${p.tags.map(t => escapeHtml(t)).join(' / ')}</div>
    </article>
  `).join('');

  return `
    <div class="fade-in">
      <h1 class="page-title">项目作品集</h1>
      <p class="page-intro">这里记录我做过的工程实践与项目。部分项目因保密要求未公开细节，仅作能力展示。</p>
      <div class="projects-grid">${grid}</div>
    </div>
  `;
}

function renderArchive() {
  const posts = getAllPosts().slice().sort((a, b) => b.date.localeCompare(a.date));
  const byYear = {};
  posts.forEach(p => {
    const y = p.date.slice(0, 4);
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(p);
  });
  const years = Object.keys(byYear).sort((a, b) => b - a);
  let html = `<h1 class="page-title">文章归档</h1><p class="page-desc">共 ${posts.length} 篇文章</p>`;
  years.forEach(y => {
    html += `<div class="archive-year">${y} 年 (${byYear[y].length})</div>`;
    byYear[y].forEach(p => {
      const mm = p.date.slice(5, 7);
      const dd = p.date.slice(8, 10);
      html += `
        <div class="archive-item">
          <span class="archive-date">${mm}-${dd}</span>
          <a href="#/post/${p.id}" class="archive-title">${escapeHtml(p.title)}</a>
        </div>`;
    });
  });
  return html;
}

function renderLinks() {
  const links = [
    { name: 'WorkBuddy', desc: '我使用的 AI 工作助手', url: 'https://workbuddy.cn', icon: '🤖' },
    { name: 'GitHub', desc: '我的代码与博客源码', url: 'https://github.com/EricZhao666', icon: '🐙' },
    { name: '交换友链', desc: '想要互换链接？在「关于」页联系我', url: '#/about', icon: '🔗' }
  ];
  const cards = links.map(l => `
    <a class="link-card" href="${l.url}" ${l.url.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}>
      <span class="link-card-avatar">${l.icon}</span>
      <span>
        <div class="link-card-name">${escapeHtml(l.name)}</div>
        <div class="link-card-desc">${escapeHtml(l.desc)}</div>
      </span>
    </a>`).join('');
  return `
    <div class="fade-in">
      <h1 class="page-title">友情链接</h1>
      <p class="page-intro">志同道合的技术博客与工具。欢迎交换友链。</p>
      <div class="links-grid">${cards}</div>
    </div>
  `;
}

// ============================================
// Editor
// ============================================

function renderEditor() {
  var draft = {};
  try { draft = JSON.parse(localStorage.getItem('blog_draft') || '{}'); } catch (e) {}
  // 重新进入编辑器：恢复可自动保存状态，并以已存草稿作为内存快照起点
  _draftSuppressed = false;
  _draftState = (draft && (draft.title || draft.tags || draft.excerpt || draft.content))
    ? { title: draft.title || '', tags: draft.tags || '', excerpt: draft.excerpt || '', content: draft.content || '' }
    : null;
  var token = getStoredToken();
  var remember = !!localStorage.getItem('gh_token');
  var owner = localStorage.getItem('gh_owner') || 'EricZhao666';
  var repo = localStorage.getItem('gh_repo') || 'blog';

  return '' +
    '<div class="editor-page">' +
    '  <h1 class="page-title">\u270F\uFE0F \u65B0\u5EFA\u6587\u7AE0</h1>' +
    '  <p class="page-desc">\u5728\u6D4F\u89C8\u5668\u4E2D\u7F16\u5199 Markdown\uFF0C\u4E00\u952E\u53D1\u5E03\u5230 GitHub\uFF0CGitHub Pages \u81EA\u52A8\u66F4\u65B0</p>' +
    '  <div class="editor-form">' +
    '    <input type="text" id="editorTitle" class="editor-input editor-input-title" placeholder="\u6587\u7AE0\u6807\u9898" value="' + escapeHtml(draft.title || '') + '">' +
    '    <input type="text" id="editorTags" class="editor-input editor-input-tags" placeholder="\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09\uFF0C\u5982\uFF1A\u673A\u68B0\u81C2, VLA, \u6280\u672F\u7B14\u8BB0" value="' + escapeHtml(draft.tags || '') + '">' +
    '    <textarea id="editorExcerpt" class="editor-input editor-textarea-excerpt" placeholder="\u6458\u8981\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u81EA\u52A8\u751F\u6210\uFF09" rows="2">' + escapeHtml(draft.excerpt || '') + '</textarea>' +
    '    <div class="editor-split">' +
    '      <div class="editor-pane">' +
    '        <div class="editor-pane-label">Markdown \u7F16\u8F91</div>' +
    '        <textarea id="editorContent" class="editor-textarea-content" placeholder="\u5728\u8FD9\u91CC\u8F93\u5165 Markdown \u5185\u5BB9...\n\n# \u6807\u9898\n\n\u6B63\u6587...\n\n```python\nprint(\"hello\")\n```">' + escapeHtml(draft.content || '') + '</textarea>' +
    '      </div>' +
    '      <div class="editor-pane">' +
    '        <div class="editor-pane-label">\u5B9E\u65F6\u9884\u89C8</div>' +
    '        <div id="editorPreview" class="editor-preview markdown-body"></div>' +
    '      </div>' +
    '    </div>' +
    '    <div class="editor-actions">' +
    '      <button class="editor-btn editor-btn-secondary" onclick="saveDraft()">\u{1F4BE} \u4FDD\u5B58\u8349\u7A3F</button>' +
    '      <button class="editor-btn editor-btn-primary" onclick="publishPost()">\u{1F680} \u53D1\u5E03\u5230 GitHub</button>' +
    '      <button class="editor-btn editor-btn-ghost" onclick="toggleEditorSettings()">\u2699\uFE0F \u8BBE\u7F6E</button>' +
    '    </div>' +
    '    <div id="editorStatus" class="editor-status"></div>' +
    '    <div id="editorSettings" class="editor-settings" style="display:none;">' +
    '      <h3>GitHub \u53D1\u5E03\u8BBE\u7F6E</h3>' +
    '      <div class="editor-settings-hint">' +
    '        <p>\u9700\u8981\u5728 GitHub \u521B\u5EFA Personal Access Token\uFF1A</p>' +
    '        <p>1. \u8FDB\u5165 GitHub \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens \u2192 Fine-grained tokens</p>' +
    '        <p>2. \u65B0\u5EFA token\uFF0C\u9009\u62E9\u4ED3\u5E93 blog\uFF0C\u6743\u9650\u9009 Contents: Read and Write</p>' +
    '        <p>3. \u590D\u5236 token \u7C98\u8D34\u5230\u4E0B\u65B9\u8F93\u5165\u6846\uFF08\u9ED8\u8BA4\u4EC5\u4FDD\u7559\u5728\u5F53\u524D\u6807\u7B7E\u9875\u7684 sessionStorage\uFF0C\u5173\u95ED\u9875\u9762\u5373\u5931\u6548\uFF1B\u82E5\u52FE\u9009\u201C\u8BB0\u4F4F\u6211\u201D\u5219\u540C\u65F6\u5199\u5165 localStorage\uFF09</p>' +
    '      </div>' +
    '      <label class="editor-label">GitHub Token</label>' +
    '      <input type="password" id="ghToken" class="editor-input" placeholder="github_pat_..." value="' + escapeHtml(token) + '">' +
    '      <label class="editor-label checkbox-label">' +
    '        <input type="checkbox" id="ghRemember" ' + (remember ? 'checked' : '') + '> ' +
    '        \u8BB0\u4F4F\u6211\uff08\u957F\u671F\u4FDD\u5B58\u5230\u672C\u673A localStorage\uff0C\u8BF7\u52FF\u5728\u516C\u5171\u7535\u8111\u4E0A\u52FE\u9009\uff09' +
    '      </label>' +
    '      <button class="editor-btn editor-btn-ghost" onclick="clearEditorToken()">\u{1F512} \u6E05\u9664 Token</button>' +
    '      <label class="editor-label">\u4ED3\u5E93\u6240\u6709\u8005</label>' +
    '      <input type="text" id="ghOwner" class="editor-input" value="' + escapeHtml(owner) + '">' +
    '      <label class="editor-label">\u4ED3\u5E93\u540D\u79F0</label>' +
    '      <input type="text" id="ghRepo" class="editor-input" value="' + escapeHtml(repo) + '">' +
    '      <button class="editor-btn editor-btn-primary" onclick="saveEditorSettings()">\u4FDD\u5B58\u8BBE\u7F6E</button>' +
    '    </div>' +
    '  </div>' +
    '</div>';
}

// --- Base64 helpers (UTF-8 safe) ---
function utf8ToBase64(str) {
  var bytes = new TextEncoder().encode(str);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  var binary = atob(b64.replace(/\s/g, ''));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function generatePostId(title) {
  var slug = title.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  var base = slug.length > 3 ? slug : 'post';
  return base + '-' + Date.now().toString(36);
}

// --- Draft management ---
// 编辑器随时可能被路由重绘销毁，所以草稿维护两份状态：
//   _draftState：最新内容的内存快照（DOM 已卸载时仍可落盘）
//   localStorage：真正持久化的草稿
var _draftTimer = null;
var _draftState = null;
var _draftSuppressed = false;   // 发布成功后抑制“离开时保存”，避免产生幽灵草稿
var _currentRoute = null;

function readEditorForm() {
  var t = document.getElementById('editorTitle');
  var g = document.getElementById('editorTags');
  var e = document.getElementById('editorExcerpt');
  var c = document.getElementById('editorContent');
  if (!t || !g || !e || !c) return null;   // 编辑器已卸载，不能再读 DOM
  return { title: t.value, tags: g.value, excerpt: e.value, content: c.value };
}

function hasDraftContent(state) {
  if (!state) return false;
  return !!(state.title || state.tags || state.excerpt || state.content);
}

function writeDraft(state, silent) {
  if (!hasDraftContent(state)) return false;
  var payload = {
    title: state.title || '',
    tags: state.tags || '',
    excerpt: state.excerpt || '',
    content: state.content || '',
    savedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem('blog_draft', JSON.stringify(payload));
  } catch (err) {
    return false;
  }
  _draftState = payload;
  if (!silent) showEditorStatus('\u{1F4BE} \u8349\u7A3F\u5DF2\u4FDD\u5B58', 'success');
  return true;
}

// 立即落盘：DOM 在就抓 DOM，已卸载则回退到内存快照
function flushDraft(silent) {
  if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
  var state = readEditorForm() || _draftState;
  if (!state) return false;
  return writeDraft(state, silent);
}

// 输入时调用：先更新内存快照，再重置防抖定时器
function scheduleDraftSave() {
  // 刚发布成功、页面即将跳转：不再产生新草稿
  if (_draftSuppressed) return;
  var state = readEditorForm();
  if (state) _draftState = state;
  if (_draftTimer) clearTimeout(_draftTimer);
  _draftTimer = setTimeout(function() {
    _draftTimer = null;
    // 定时器触发时编辑器可能已被销毁：优先内存快照，绝不读已卸载的 DOM
    var snap = readEditorForm() || _draftState;
    if (snap) writeDraft(snap, true);
  }, 2000);
}

window.saveDraft = function() {
  if (!flushDraft(false)) showEditorStatus('\u26A0\uFE0F \u6CA1\u6709\u53EF\u4FDD\u5B58\u7684\u5185\u5BB9', 'error');
};

function clearDraft() {
  localStorage.removeItem('blog_draft');
  _draftState = null;
}

function showEditorStatus(msg, type) {
  var el = document.getElementById('editorStatus');
  if (el) {
    el.className = 'editor-status editor-status-' + type;
    el.innerHTML = msg;
  }
}

window.toggleEditorSettings = function() {
  var el = document.getElementById('editorSettings');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// --- GitHub Token 存储策略 ---
// 默认只存在 sessionStorage（关闭标签页即失效），避免长期驻留在磁盘；
// 显式勾选「记住我」才落到 localStorage。
function getStoredToken() {
  return sessionStorage.getItem('gh_token') || localStorage.getItem('gh_token') || '';
}
function storeToken(token, remember) {
  sessionStorage.setItem('gh_token', token);
  if (remember) localStorage.setItem('gh_token', token);
  else localStorage.removeItem('gh_token');
}
window.getStoredToken = getStoredToken;

window.saveEditorSettings = function() {
  var token = document.getElementById('ghToken').value.trim();
  var remember = document.getElementById('ghRemember') && document.getElementById('ghRemember').checked;
  storeToken(token, remember);
  localStorage.setItem('gh_owner', document.getElementById('ghOwner').value.trim());
  localStorage.setItem('gh_repo', document.getElementById('ghRepo').value.trim());
  showEditorStatus(remember
    ? '✅ 设置已保存（Token 已记住到本机）'
    : '✅ 设置已保存（Token 仅保留到关闭本标签页）', 'success');
};

window.clearEditorToken = function() {
  sessionStorage.removeItem('gh_token');
  localStorage.removeItem('gh_token');
  var input = document.getElementById('ghToken');
  if (input) input.value = '';
  var remember = document.getElementById('ghRemember');
  if (remember) remember.checked = false;
  showEditorStatus('🔒 Token 已从浏览器中清除', 'success');
};

function updateEditorPreview() {
  var content = document.getElementById('editorContent');
  var preview = document.getElementById('editorPreview');
  if (!content || !preview) return;
  var text = content.value || '';
  try {
    preview.innerHTML = renderMarkdown(text);
    enhanceCodeBlocks(preview);
    highlightIn(preview);
  } catch (e) {
    preview.innerHTML = '<p style="color:#e53e3e">\u9884\u89C8\u9519\u8BEF</p>';
  }
}

// --- Auto-save draft on input ---
// 标题/标签/摘要/正文共用同一套防抖保存策略，避免只改标题时草稿不更新
function setupEditorListeners() {
  ['editorTitle', 'editorTags', 'editorExcerpt', 'editorContent'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || el.dataset.draftBound === '1') return;
    el.dataset.draftBound = '1';
    el.addEventListener('input', function() {
      if (id === 'editorContent') updateEditorPreview();
      scheduleDraftSave();
    });
  });
  // Initial preview
  updateEditorPreview();
}

// --- Publish to GitHub via Contents API ---
// 解析远端 user-posts.js：任何“读不懂”的情况都必须失败。
// 绝不能退化成空数组，否则一次发布会把历史文章整体覆盖。
function parseUserPostsText(text) {
  if (typeof text !== 'string') return { ok: false, reason: '文件内容无法读取' };
  var trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { ok: true, posts: [] };
  var match = trimmed.match(/(?:const|let|var)\s+USER_POSTS\s*=\s*(\[[\s\S]*\])\s*;?/);
  if (!match) return { ok: false, reason: '未找到 USER_POSTS 数据段，文件格式可能已变更' };
  var posts;
  try {
    posts = JSON.parse(match[1]);
  } catch (e) {
    return { ok: false, reason: 'USER_POSTS 不是合法 JSON' };
  }
  if (!Array.isArray(posts)) return { ok: false, reason: 'USER_POSTS 不是数组' };
  for (var i = 0; i < posts.length; i++) {
    var p = posts[i];
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.id !== 'string' || !p.id) {
      return { ok: false, reason: '第 ' + (i + 1) + ' 篇文章缺少有效 id' };
    }
  }
  return { ok: true, posts: posts };
}

window.publishPost = async function() {
  var title = document.getElementById('editorTitle').value.trim();
  var tagsStr = document.getElementById('editorTags').value.trim();
  var excerpt = document.getElementById('editorExcerpt').value.trim();
  var content = document.getElementById('editorContent').value.trim();

  if (!title) { showEditorStatus('\u274C \u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A', 'error'); return; }
  if (!content) { showEditorStatus('\u274C \u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A', 'error'); return; }

  var token = getStoredToken();
  if (!token) {
    showEditorStatus('\u274C \u8BF7\u5148\u70B9\u51FB\u201C\u8BBE\u7F6E\u201D\u914D\u7F6E GitHub Token', 'error');
    toggleEditorSettings();
    return;
  }

  var owner = localStorage.getItem('gh_owner') || 'EricZhao666';
  var repo = localStorage.getItem('gh_repo') || 'blog';
  var filePath = 'js/user-posts.js';
  var apiUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + filePath;

  showEditorStatus('\u23F3 \u6B63\u5728\u53D1\u5E03...', 'loading');

  try {
    // 1. 读取远端文件：必须能完整还原历史文章，否则一律中止（避免覆盖）
    var sha = null;
    var currentPosts = [];

    var getResp = await fetch(apiUrl, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }
    });

    if (getResp.status === 200) {
      var data = await getResp.json().catch(function() { return null; });
      if (!data || typeof data !== 'object') throw new Error('无法解析 GitHub 返回的文件信息，已中止发布');
      if (!data.sha) throw new Error('GitHub 未返回文件版本号（sha），已中止发布');
      sha = data.sha;
      // Contents API 对 >1MB 文件返回 encoding=none / content 为空，此时无法确认历史内容
      if (data.encoding === 'none' || typeof data.content !== 'string' ||
          (data.content === '' && Number(data.size) > 0)) {
        throw new Error('现有文章文件无法完整读取（可能超过 Contents API 1MB 限制），已中止发布以免覆盖历史文章');
      }
      var decoded;
      try {
        decoded = base64ToUtf8(data.content);
      } catch (e) {
        throw new Error('现有文章文件 Base64 解码失败，已中止发布以免覆盖历史文章');
      }
      var parsed = parseUserPostsText(decoded);
      if (!parsed.ok) {
        throw new Error('现有文章文件解析失败（' + parsed.reason + '），已中止发布以免覆盖历史文章');
      }
      currentPosts = parsed.posts;
    } else if (getResp.status === 404) {
      // 只有明确 404 才允许按“新建文件”处理
      sha = null;
      currentPosts = [];
    } else {
      var errBody = await getResp.json().catch(function() { return {}; });
      throw new Error('GitHub API: ' + ((errBody && errBody.message) || 'HTTP ' + getResp.status));
    }

    // 2. Build new post object
    var tags = tagsStr.split(/[,，]/).map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    var newPost = {
      id: generatePostId(title),
      title: title,
      date: new Date().toISOString().slice(0, 10),
      tags: tags.length ? tags : ['未分类'],
      excerpt: excerpt || content.replace(/[#*`>\-\[\]]/g, '').slice(0, 120) + '...',
      content: content
    };

    // Prepend (newest first)
    currentPosts.unshift(newPost);

    // 3. Generate new file content
    var newFileContent = 'const USER_POSTS = ' + JSON.stringify(currentPosts, null, 2) + ';\n';
    var base64Content = utf8ToBase64(newFileContent);

    // 4. Commit via PUT（保留 sha 版本校验；新建文件不发送 sha）
    var payload = { message: 'Add post: ' + title, content: base64Content };
    if (sha) payload.sha = sha;
    var putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!putResp.ok) {
      var putErr = await putResp.json().catch(function() { return {}; });
      if (putResp.status === 409) {
        throw new Error('文件已被其他人修改（版本冲突），请刷新后重试；历史文章未被改动');
      }
      throw new Error((putErr && putErr.message) || ('HTTP ' + putResp.status));
    }

    // 5. Update in-memory array
    if (typeof USER_POSTS !== 'undefined') {
      USER_POSTS.unshift(newPost);
    }

    // 6. 清空草稿：同时清掉待触发的自动保存，避免旧内容被写回
    clearDraft();
    if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
    _draftSuppressed = true;

    showEditorStatus('\u2705 \u53D1\u5E03\u6210\u529F\uFF01GitHub Pages \u5C06\u5728 1-2 \u5206\u949F\u5185\u66F4\u65B0\uFF0C\u5373\u5C06\u8DF3\u8F6C\u5230\u9996\u9875...', 'success');

    // Redirect to home after 2 seconds
    setTimeout(function() { location.hash = '#/'; }, 2000);

  } catch (err) {
    var failMsg = (err && err.message) || String(err);
    if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(failMsg)) {
      failMsg = '网络请求失败，请检查网络后重试（历史文章未被改动）';
    }
    showEditorStatus('\u274C \u53D1\u5E03\u5931\u8D25: ' + escapeHtml(failMsg), 'error');
    // 失败时把当前编辑内容落盘，刷新或离开后仍可恢复
    flushDraft(true);
  }
};

// ============================================
// Router
// ============================================
async function router() {
  const token = ++_routeToken;
  const hash = location.hash.slice(1) || '/';
  const app = document.getElementById('app');
  const searchBar = document.getElementById('searchBar');

  // 离开编辑器：把待保存内容立即落盘（只 clearTimeout 会丢内容）
  if (_currentRoute === '/editor' && hash !== '/editor' && !_draftSuppressed) {
    flushDraft(true);
  }
  _currentRoute = hash;

  // 上一个页面遗留的目录/进度条
  removeReadingTools();

  // Close mobile menu
  document.querySelector('.nav').classList.remove('open');
  document.getElementById('menuToggle').classList.remove('active');

  // Show/hide search bar (only on home)
  if (hash === '/') {
    searchBar.classList.remove('hidden');
  } else {
    searchBar.classList.add('hidden');
  }

  // 输入框与状态保持同步：从文章返回首页时回填上次的关键词
  const globalSearch = document.getElementById('searchInput');
  if (globalSearch) {
    const want = hash === '/' ? searchQuery : '';
    if (globalSearch.value !== want) globalSearch.value = want;
  }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(link => {
    const route = link.getAttribute('data-route');
    link.classList.remove('active');
    link.removeAttribute('aria-current');
    if (hash === route || (route === '/' && hash.startsWith('/post'))) {
      link.classList.add('active');
    }
    if (route === '/tags' && hash.startsWith('/tags')) {
      link.classList.add('active');
    }
    if (route === '/courses' && (hash.startsWith('/courses') || hash.startsWith('/course'))) {
      link.classList.add('active');
    }
    if (route === '/papers' && hash.startsWith('/papers')) {
      link.classList.add('active');
    }
    if (route === '/editor' && hash.startsWith('/editor')) {
      link.classList.add('active');
    }
    if (route === '/projects' && hash.startsWith('/projects')) {
      link.classList.add('active');
    }
    if (route === '/code' && (hash.startsWith('/code') || hash.startsWith('/codelib'))) {
      link.classList.add('active');
    }
    if (route === '/archive' && hash.startsWith('/archive')) {
      link.classList.add('active');
    }
    if (link.classList.contains('active')) link.setAttribute('aria-current', 'page');
  });

  // Parse route
  try {
    if (hash === '/' || hash === '') {
      app.innerHTML = renderHome();
    } else if (hash.startsWith('/post/')) {
      const id = hash.slice('/post/'.length);
      app.innerHTML = renderPost(id);
      loadGiscus(id);
    } else if (hash.startsWith('/tags')) {
      const parts = hash.split('/');
      const tag = parts.length > 2 ? decodeURIComponent(parts[2]) : null;
      app.innerHTML = renderTags(tag);
    } else if (hash === '/courses') {
      // 默认只展示已整理笔记的课程，因此笔记数据也需就绪
      if (!dataReady('courses') || !dataReady('notes')) {
        app.innerHTML = renderLoading('课程笔记');
        await Promise.all([loadData('courses'), loadData('notes')]);
        if (token !== _routeToken) return;
        if (!dataReady('courses') || !dataReady('notes')) {
          app.innerHTML = renderLoadError('课程笔记');
          return;
        }
      }
      app.innerHTML = renderCourses();
      bindLiveSearch('courseSearchInput', (val) => {
        courseSearchQuery = val;
        app.innerHTML = renderCourses();
      });
    } else if (hash.startsWith('/course/')) {
      const id = decodeURIComponent(hash.slice('/course/'.length));
      if (!dataReady('courses')) {
        app.innerHTML = renderLoading('课程资料');
        await loadData('courses');
        if (token !== _routeToken) return;
        if (!dataReady('courses')) {
          app.innerHTML = renderLoadError('课程资料');
          return;
        }
      }
      const notesReady = dataReady('notes');
      app.innerHTML = renderCourseDetail(id);
      if (!notesReady) {
        loadData('notes').then(function () {
          if (token === _routeToken) {
            app.innerHTML = renderCourseDetail(id);
            enhanceCodeBlocks(app);
            highlightIn(app);
            buildReadingTools();
          }
        });
      }
    } else if (hash === '/papers') {
      if (!dataReady('papers')) {
        app.innerHTML = renderLoading('论文与学习资料');
        await loadData('papers');
        if (token !== _routeToken) return;
        if (!dataReady('papers')) {
          app.innerHTML = renderLoadError('论文与学习资料');
          return;
        }
      }
      app.innerHTML = renderPapers();
      bindLiveSearch('paperSearchInput', (val) => {
        paperSearchQuery = val;
        app.innerHTML = renderPapers();
      });
    } else if (hash === '/about') {
      app.innerHTML = renderAbout();
    } else if (hash === '/projects') {
      app.innerHTML = renderProjects();
    } else if (hash === '/archive') {
      app.innerHTML = renderArchive();
    } else if (hash === '/code') {
      if (!dataReady('codefiles')) {
        app.innerHTML = renderLoading('代码与文件库');
        await loadData('codefiles');
        if (token !== _routeToken) return;
        if (!dataReady('codefiles')) {
          app.innerHTML = renderLoadError('代码与文件库');
          return;
        }
      }
      app.innerHTML = renderCode();
      bindLiveSearch('codeLibSearchInput', (val) => {
        codeLibSearchQuery = val;
        app.innerHTML = renderCode();
      });
    } else if (hash.startsWith('/codelib/')) {
      const id = decodeURIComponent(hash.slice('/codelib/'.length));
      if (!dataReady('codefiles')) {
        app.innerHTML = renderLoading('代码与文件库');
        await loadData('codefiles');
        if (token !== _routeToken) return;
        if (!dataReady('codefiles')) {
          app.innerHTML = renderLoadError('代码与文件库');
          return;
        }
      }
      app.innerHTML = renderCodeDetail(id);
    } else if (hash === '/links') {
      app.innerHTML = renderLinks();
    } else if (hash === '/editor') {
      app.innerHTML = renderEditor();
      setupEditorListeners();
    } else {
      app.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🤔</div>
          <p>页面不存在</p>
          <p><a href="#/">返回首页</a></p>
        </div>
      `;
    }
  } catch (err) {
    console.error('Router error:', err);
    app.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p>页面渲染出错: ${escapeHtml(err.message)}</p>
        <p><a href="#/">返回首页</a></p>
      </div>
    `;
  }

  // 标题/描述、代码工具条（复制/语言标签）、阅读目录与进度、按需高亮
  updateMetaForRoute(hash);
  enhanceCodeBlocks(app);
  buildReadingTools();
  highlightIn(app);

  // Scroll to top on navigation
  window.scrollTo(0, 0);
}

// ============================================
// Event Listeners
// ============================================

// Category filter for courses
window.setCategory = function(cat) {
  activeCategory = cat;
  const app = document.getElementById('app');
  app.innerHTML = renderCourses();
  bindLiveSearch('courseSearchInput', (val) => {
    courseSearchQuery = val;
    app.innerHTML = renderCourses();
  });
};

// 课程视图切换：只看有笔记 / 全部课程
window.setNotesOnly = function(only) {
  courseNotesOnly = !!only;
  activeCategory = null;
  const app = document.getElementById('app');
  app.innerHTML = renderCourses();
  bindLiveSearch('courseSearchInput', (val) => {
    courseSearchQuery = val;
    app.innerHTML = renderCourses();
  });
};

window.setPaperTab = function(tab) {
  paperTab = tab;
  paperSearchQuery = '';
  activePaperCategory = null;
  const app = document.getElementById('app');
  app.innerHTML = renderPapers();
  bindLiveSearch('paperSearchInput', (val) => {
    paperSearchQuery = val;
    app.innerHTML = renderPapers();
  });
};

window.setPaperCategory = function(cat) {
  activePaperCategory = cat;
  const app = document.getElementById('app');
  app.innerHTML = renderPapers();
  bindLiveSearch('paperSearchInput', (val) => {
    paperSearchQuery = val;
    app.innerHTML = renderPapers();
  });
};

// Search
// 全局搜索会跨文章/课程/论文，后两者数据按需加载：
// 首次输入关键词时并行拉取，到齐后补一次结果重绘。
// 搜索框只属于首页：离开首页后，防抖/异步回调不得再重绘 app
function isHomeRoute() {
  const h = location.hash;
  return h === '' || h === '#' || h === '#/';
}

bindLiveSearch('searchInput', (val) => {
  searchQuery = val;
  if (!isHomeRoute()) return;
  document.getElementById('app').innerHTML = renderHome();
  if (val.trim() && (!dataReady('courses') || !dataReady('papers') || !dataReady('notes'))) {
    const target = val.trim();
    Promise.all([loadData('courses'), loadData('papers'), loadData('notes')]).then(function () {
      if (!isHomeRoute()) return;
      if (searchQuery.trim() === target) {
        document.getElementById('app').innerHTML = renderHome();
      }
    });
  }
});

// Mobile menu toggle
document.getElementById('menuToggle').addEventListener('click', function () {
  document.querySelector('.nav').classList.toggle('open');
  this.classList.toggle('active');
});

// Back to top
const backToTopBtn = document.getElementById('backToTop');
window.addEventListener('scroll', () => {
  if (window.scrollY > 300) {
    backToTopBtn.classList.add('visible');
  } else {
    backToTopBtn.classList.remove('visible');
  }
});
backToTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Hash change
window.addEventListener('hashchange', router);

// 关闭/刷新页面前把编辑器内容落盘
window.addEventListener('beforeunload', function () {
  if (_currentRoute === '/editor' && !_draftSuppressed) flushDraft(true);
});

// ============================================
// Theme (dark mode)
// ============================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // 同步浏览器地址栏/系统主题色，避免深色模式下仍显示亮蓝
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#2563eb');
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', cur);
  applyTheme(cur);
  if (GISCUS_CONFIG.enabled && location.hash.indexOf('/post/') === 0) {
    loadGiscus(location.hash.slice('/post/'.length));
  }
}
window.toggleTheme = toggleTheme;

// 未手动切换过主题时，跟随系统深浅色变化
(function initTheme() {
  let theme = localStorage.getItem('theme');
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (!theme && mq) theme = mq.matches ? 'dark' : 'light';
  applyTheme(theme || 'light');
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function (e) {
      if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light');
    });
  }
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', toggleTheme);
})();

// ============================================
// 键盘快捷键：/ 或 Ctrl(⌘)+K 聚焦搜索，Esc 清空，t 切换主题
// ============================================
(function initShortcuts() {
  function focusSearch() {
    if (location.hash && location.hash !== '#/' && location.hash !== '#') {
      location.hash = '#/';
      setTimeout(focusSearch, 150);
      return;
    }
    const input = document.getElementById('searchInput');
    if (input) {
      input.focus();
      try { input.select(); } catch (e) {}
    }
  }

  document.addEventListener('keydown', function (e) {
    const el = e.target || {};
    const tag = (el.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;

    if (typing) {
      if (e.key === 'Escape' && el.id === 'searchInput') {
        el.value = '';
        searchQuery = '';
        document.getElementById('app').innerHTML = renderHome();
        el.blur();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key === 'Escape' && searchQuery) {
      searchQuery = '';
      const input = document.getElementById('searchInput');
      if (input) input.value = '';
      if (location.hash === '#/' || !location.hash) document.getElementById('app').innerHTML = renderHome();
      return;
    }
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleTheme();
    }
  });
})();

// ============================================
// PWA: register service worker for offline
// ============================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('SW register failed:', err);
    });
  });
}

// Skip link：跳到主内容（不能用 #app 锚点，会被 hash 路由当成页面路由）
// ============================================
// 分类 / 标签点击：事件委托，不再把数据拼进内联 onclick
// ============================================
(function initDelegatedNav() {
  function pick(target) {
    if (!target || !target.closest) return null;
    return target.closest('[data-category],[data-paper-category],[data-tag-link]');
  }
  document.addEventListener('click', function (e) {
    const el = pick(e.target);
    if (!el) return;
    if (el.hasAttribute('data-category')) {
      if (typeof setCategory === 'function') setCategory(el.getAttribute('data-category') || null);
    } else if (el.hasAttribute('data-paper-category')) {
      if (typeof setPaperCategory === 'function') setPaperCategory(el.getAttribute('data-paper-category') || null);
    } else {
      location.hash = '#/tags/' + encodeURIComponent(el.getAttribute('data-tag-link') || '');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = pick(e.target);
    if (!el) return;
    e.preventDefault();
    el.click();
  });
})();

(function initSkipLink() {
  const skip = document.getElementById('skipLink');
  if (!skip) return;
  skip.addEventListener('click', function (e) {
    e.preventDefault();
    const app = document.getElementById('app');
    if (!app) return;
    app.setAttribute('tabindex', '-1');
    try { app.focus({ preventScroll: true }); } catch (err) { app.focus(); }
    if (typeof app.scrollIntoView === 'function') {
      app.scrollIntoView();
    }
  });
})();

// Initial render
router();
