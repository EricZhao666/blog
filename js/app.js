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
  if (post.excerpt) return post.excerpt;
  // 拆分后正文可能还没加载：此时宁可留空，也不要抛错或显示 undefined
  const content = cachedPostContent(post) || '';
  return content ? content.replace(/[#*`>\-\[\]]/g, '').slice(0, 120) + '...' : '';
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

// 首帧之后再跑非关键增强；路由已切换或节点被替换时直接丢弃，避免污染新页面
function scheduleAfterPaint(fn, token, node) {
  const run = function () {
    if (token != null && token !== _routeToken) return;
    if (node && !node.isConnected) return;
    fn();
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () { whenIdle(run); });
  } else {
    setTimeout(run, 0);
  }
}

function perfMark(name) {
  // 只用于性能诊断（Batch 6C-2）：记录文章渲染各阶段，便于把长任务归因到具体步骤
  try { performance.mark(name); } catch (e) { /* 老浏览器忽略 */ }
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
  // 带查询串的深链（/papers?kind=..&target=..）按路径本身取元数据，
  // 否则标题/描述会被重置成站点默认值
  const metaKey = hash.indexOf('?') === -1 ? hash : hash.slice(0, hash.indexOf('?'));
  const m = STATIC_META[metaKey];
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
const _dataFailures = {};   // key -> 加载失败次数（>0 时重试用带 cache-buster 的 URL）
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
  // 失败后重试要绕开 HTTP 缓存里的坏响应（首次请求仍用规范 URL，保证 SW 快照一致）
  const retry = _dataFailures[key] || 0;
  const chain = (Array.isArray(files) ? files : [files]).reduce(function (p, src) {
    return p.then(function () {
      return loadScriptOnce(retry ? src + (src.indexOf('?') === -1 ? '?' : '&') + 'retry=' + retry : src);
    });
  }, Promise.resolve());
  _dataPromises[key] = chain.catch(function (err) {
    console.warn(err.message);
    _dataFailures[key] = (_dataFailures[key] || 0) + 1;
    delete _dataPromises[key];
  });
  return _dataPromises[key];
}

function renderLoading(label) {
  return '<div class="empty-state"><div class="empty-state-icon">⏳</div><p>正在加载' + label + '…</p></div>';
}

// 按需脚本加载失败时给出可重试的提示，避免继续渲染导致 ReferenceError。
// 带 dataKey 时给一个"原地重试"入口（重新拉取该数据后重跑当前路由），
// 保留"刷新页面"作为兜底；深链场景重试后仍会定位到原目标。
function renderLoadError(label, dataKey) {
  const retry = dataKey
    ? '<p><a href="#" data-retry-data="' + escapeHtml(dataKey) + '">点击重试</a>' +
      ' · <a href="#" onclick="location.reload();return false;">刷新页面</a></p>'
    : '<p><a href="#" onclick="location.reload();return false;">点击重试</a></p>';
  return '<div class="empty-state"><div class="empty-state-icon">⚠️</div>' +
    '<p>' + escapeHtml(label) + '数据加载失败，请检查网络后重试</p>' + retry + '</div>';
}

// ============================================
// 文章正文 / 全文搜索语料：按需加载（Batch 6B-2）
// ============================================
// 首页只需要 js/data.js 里的元数据；正文按 id 单独存放（data/posts/<id>.md），
// 全文搜索语料单独一份（data/search-index.json），都只在真正需要时才请求。
const POST_BODY_DIR = 'data/posts/';
const SEARCH_INDEX_URL = 'data/search-index.json';
const _postBodies = Object.create(null);         // id -> 正文字符串
const _postBodyPromises = Object.create(null);   // id -> 进行中的请求（失败即清除，便于重试）
let _searchDocsPromise = null;
let _searchDocsReady = false;
let _searchDocsError = false;

function postBodyUrl(id) {
  return POST_BODY_DIR + encodeURIComponent(id) + '.md';
}

// 同源文本请求：优先 fetch；jsdom 等没有 fetch 的环境退回 XHR。
// 一律先转成绝对 URL —— 相对地址在 Node 的 fetch 实现里会直接抛 "Failed to parse URL"。
function requestText(url) {
  const href = new URL(url, location.href).href;
  if (typeof fetch === 'function') {
    return fetch(href, { credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.text();
    });
  }
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', href, true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { reject(new Error('network error')); };
    xhr.send();
  });
}

function requestJson(url) {
  return requestText(url).then(function (text) { return JSON.parse(text); });
}

// 内存里已有的正文：用户文章自带 content；其它文章可能来自正文请求或搜索语料
function cachedPostContent(post) {
  if (!post) return null;
  if (typeof post.content === 'string') return post.content;
  return _postBodies[post.id] == null ? null : _postBodies[post.id];
}

function loadPostBody(id) {
  if (_postBodies[id] != null) return Promise.resolve(_postBodies[id]);
  if (_postBodyPromises[id]) return _postBodyPromises[id];
  const task = requestText(postBodyUrl(id))
    .then(function (text) {
      _postBodies[id] = text;
      delete _postBodyPromises[id];
      return text;
    })
    .catch(function (err) {
      delete _postBodyPromises[id];   // 允许再次点击重试
      throw err;
    });
  _postBodyPromises[id] = task;
  return task;
}

// 全文搜索语料：首次搜索才加载（约 107KB），后续搜索复用同一份
function ensureSearchDocs() {
  if (_searchDocsReady) return Promise.resolve();
  if (_searchDocsPromise) return _searchDocsPromise;
  _searchDocsPromise = requestJson(SEARCH_INDEX_URL)
    .then(function (docs) {
      // 把正文挂回内存对象：搜索/渲染逻辑与拆分前保持完全一致
      getAllPosts().forEach(function (post) {
        if (post.content == null && docs && typeof docs[post.id] === 'string') {
          post.content = docs[post.id];
        }
      });
      _searchDocsReady = true;
      _searchDocsError = false;
    })
    .catch(function (err) {
      _searchDocsPromise = null;      // 下次输入会重试
      _searchDocsError = true;
      console.warn('搜索语料加载失败:', err.message);
      throw err;
    });
  return _searchDocsPromise;
}

// 阅读时长：优先用构建期算好的值（与 readingTime 等价），没有正文时也不会算错
function postMinutes(post) {
  if (post && typeof post.readingMinutes === 'number') return post.readingMinutes;
  return readingTime(cachedPostContent(post) || '');
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

// 高亮必须分帧：一篇文章可能有几十个代码块，一次性 highlightElement 在 4× CPU 下
// 会连续占用主线程近 1 秒；这段时间里连"下一次导航"的 fetch 事件都派发不出去
// （实测：文档级打开文章从 ~800ms 恶化到 ~2100ms）。分批 + 让出主线程即可消除。
const HL_BATCH_SIZE = 4;

function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(function () { fn(); }, { timeout: 200 });
  } else {
    setTimeout(fn, 16);
  }
}

function highlightIn(root) {
  if (!root) return;
  const blocks = Array.prototype.slice.call(root.querySelectorAll('pre code'));
  if (!blocks.length) return;
  ensureHighlight().then(function () {
    if (typeof hljs === 'undefined') return;
    let i = 0;
    const step = function () {
      const end = Math.min(i + HL_BATCH_SIZE, blocks.length);
      for (; i < end; i++) {
        const el = blocks[i];
        if (!el.isConnected || el.dataset.highlighted === 'yes') continue;
        const m = (el.className || '').match(/language-([\w+#-]+)/);
        if (m && !hljs.getLanguage(m[1])) {
          el.className = el.className.replace(/language-[\w+#-]+/, '').trim();
        }
        try { hljs.highlightElement(el); } catch (e) {}
      }
      if (i < blocks.length) whenIdle(step);
    };
    step();
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
          ${postMinutes(post)} 分钟阅读
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
  // 正文语料是首次搜索才加载的：明确告诉用户当前结果只覆盖标题/摘要/标签
  if (!_searchDocsReady) {
    html += '<div class="search-hint">' + (_searchDocsError
      ? '正文检索暂不可用（当前只匹配标题 / 摘要 / 标签），重新输入可重试'
      : '正在加载正文检索语料，结果会随后补全…') + '</div>';
  }

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
      <div class="search-paper-item" data-href="${escapeHtml(papersDeepLink('paper', paperTargetKey(p)))}" tabindex="0" role="link">
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
      <div class="search-paper-item" data-href="${escapeHtml(papersDeepLink('material', materialTargetKey(m)))}" tabindex="0" role="link">
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

function renderPostMissing() {
  return `
      <div class="empty-state">
        <div class="empty-state-icon">📄</div>
        <p>文章不存在</p>
        <p><a href="#/">返回首页</a></p>
      </div>
    `;
}

// 正文还没到：先给出标题与明确的加载态，避免空白页
function renderPostLoading(post) {
  const title = post ? `<h1 class="article-detail-title">${escapeHtml(post.title)}</h1>` : '';
  return `
      <div class="article-loading">
        ${title}
        <div class="empty-state">
          <div class="empty-state-icon">⏳</div>
          <p>正在加载文章正文…</p>
        </div>
      </div>
    `;
}

// 正文加载失败：给出可重试的入口（重试按钮走事件委托）
function renderPostError(id) {
  return `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p>文章正文加载失败，请检查网络后重试</p>
        <p><button type="button" class="retry-btn" data-retry-post="${escapeHtml(id)}">重新加载</button>
           <a href="#/">返回首页</a></p>
      </div>
    `;
}

// 有正文之后的文章详情渲染（原 renderPost 的主体）
function renderPostView(post, content) {
  perfMark('art:md-start');
  const html = renderMarkdown(content);
  perfMark('art:md-end');

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
            ${postMinutes(post)} 分钟阅读
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

// 同步版本：正文已在内存里就直接出完整页面，否则给加载态（路由会异步补上）
function renderPost(id) {
  const post = getAllPosts().find(p => p.id === id);
  if (!post) return renderPostMissing();
  const content = cachedPostContent(post);
  if (content == null) return renderPostLoading(post);
  return renderPostView(post, content);
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
// 论文 / 学习资料深链（Batch 7B-2）
// ============================================
// 公开契约：#/papers?kind=paper|material&target=<目标键>
//   - 论文目标键 = PAPERS[i].id（Zotero itemID，与标题/作者/分类无关）
//   - 资料目标键 = LEARNING_MATERIALS[i].id（持久 ID Registry，形如 lm-000123）
//   - 还没有 Registry ID 的旧数据回退到 lgx:<JSON 三元组>，只做精确匹配、绝不猜测
// 旧路由 #/papers（不带参数）保持原样：普通列表页。
const PAPERS_ROUTE = '/papers';
const MATERIAL_LEGACY_PREFIX = 'lgx:';
const TARGET_MAX_LEN = 2048;

function paperTargetKey(paper) {
  return paper && paper.id ? String(paper.id) : '';
}

function materialTargetKey(m) {
  if (!m) return '';
  if (m.id) return String(m.id);
  return MATERIAL_LEGACY_PREFIX + JSON.stringify([m.name || '', m.category || '', m.subcategory || '']);
}

// 生成可复制/可刷新的原生链接（URLSearchParams 负责百分号编码，避免裸 & 截断）
function papersDeepLink(kind, key) {
  const k = kind === 'material' ? 'material' : 'paper';
  const target = String(key == null ? '' : key);
  try {
    if (typeof URLSearchParams === 'function') {
      return '#/papers?' + new URLSearchParams({ kind: k, target: target }).toString();
    }
  } catch (e) { /* 退回手写编码 */ }
  return '#/papers?kind=' + encodeURIComponent(k) + '&target=' + encodeURIComponent(target);
}

// 非法百分号编码不能让脚本崩溃：URLSearchParams 容错解析 + try/catch 兜底
function parsePapersRoute(hash) {
  const q = hash.indexOf('?');
  const pathPart = q === -1 ? hash : hash.slice(0, q);
  if (pathPart !== PAPERS_ROUTE) return null;
  const out = { kind: '', target: '' };
  if (q === -1) return out;
  try {
    const params = new URLSearchParams(hash.slice(q + 1));
    const kind = params.get('kind') || '';
    out.kind = (kind === 'paper' || kind === 'material') ? kind : '';
    out.target = params.get('target') || '';
  } catch (e) {
    out.kind = '';
    out.target = '';
  }
  if (out.target.length > TARGET_MAX_LEN) out.target = '';
  return out;
}

function findPaperByTarget(target) {
  if (!target || typeof PAPERS === 'undefined') return null;
  for (let i = 0; i < PAPERS.length; i++) {
    if (paperTargetKey(PAPERS[i]) === target) return PAPERS[i];
  }
  return null;
}

function findMaterialByTarget(target) {
  if (!target || typeof LEARNING_MATERIALS === 'undefined') return null;
  for (let i = 0; i < LEARNING_MATERIALS.length; i++) {
    const m = LEARNING_MATERIALS[i];
    if (m.id && String(m.id) === target) return m;
  }
  if (target.indexOf(MATERIAL_LEGACY_PREFIX) !== 0) return null;
  let parts;
  try {
    parts = JSON.parse(target.slice(MATERIAL_LEGACY_PREFIX.length));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== 3) return null;
  for (let i = 0; i < LEARNING_MATERIALS.length; i++) {
    const m = LEARNING_MATERIALS[i];
    if ((m.name || '') === parts[0] && (m.category || '') === parts[1] &&
        (m.subcategory || '') === parts[2]) return m;
  }
  return null;
}

// 只给了 target 时：先按论文 ID 匹配，再按资料 ID 匹配（两个 ID 空间互不重叠）
function resolvePapersTarget(deep) {
  const target = deep ? deep.target : '';
  if (!target) return null;
  if (deep.kind === 'material') {
    const m = findMaterialByTarget(target);
    return m ? { kind: 'material', item: m } : null;
  }
  if (deep.kind === 'paper') {
    const p = findPaperByTarget(target);
    return p ? { kind: 'paper', item: p } : null;
  }
  const p = findPaperByTarget(target);
  if (p) return { kind: 'paper', item: p };
  const m = findMaterialByTarget(target);
  return m ? { kind: 'material', item: m } : null;
}

function deeplinkMissingHtml(kind) {
  const what = kind === 'material' ? '学习资料' : '论文';
  return '<div class="deeplink-notice" role="status">' +
    '🔗 找不到这条' + what + '：链接可能来自已删除或已重命名的条目。下面为你显示完整列表。' +
    '</div>';
}

// 高亮 + 滚动进视口 + 键盘焦点；返回是否真的定位到节点
function locatePapersTarget(app, kind, item, token) {
  if (!app || !app.isConnected || token !== _routeToken) return false;
  const isMaterial = kind === 'material';
  const attr = isMaterial ? 'data-material-key' : 'data-paper-key';
  const key = isMaterial ? materialTargetKey(item) : paperTargetKey(item);
  if (!key) return false;
  const nodes = app.querySelectorAll(isMaterial ? '.file-item' : '.paper-card');
  let node = null;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute(attr) === key) { node = nodes[i]; break; }
  }
  if (!node) return false;
  node.classList.add('deeplink-target');
  node.setAttribute('aria-current', 'true');
  node.setAttribute('tabindex', '-1');
  if (!isMaterial) node.classList.add('expanded');   // 论文自动展开摘要
  if (typeof node.scrollIntoView === 'function') {
    // 深链要"落点即到位"：优先 instant，避免 CSS scroll-behavior:smooth 的动画
    // 让目标和视口最多差几百毫秒（截图/可访问性检查都会看到"没进视口"）。
    try {
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {
      node.scrollIntoView({ block: 'center' });
    }
  }
  try {
    node.focus({ preventScroll: true });
  } catch (e) {
    try { node.focus(); } catch (e2) { /* 极老浏览器忽略 */ }
  }
  return true;
}

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
          <div class="paper-card" data-paper-key="${escapeHtml(paperTargetKey(paper))}" onclick="this.classList.toggle('expanded')">
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
          <div class="file-item" data-material-key="${escapeHtml(materialTargetKey(m))}">
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
// Batch 8A   ：编辑器只导出本地 JSON（不联网、不写仓库、不需要 Token）
// Batch 8B-1 ：新增「编辑已有文章」模式（id 固定、链接不变、导出更新稿）
// ============================================

var EDIT_DRAFT_PREFIX = 'blog_draft_edit::';
var _editorMode = 'new';      // 'new' | 'edit'
var _editCtx = null;          // 编辑模式的原文快照 { id, title, date, tags, excerpt, content }

function isEditorRoute(hash) {
  return hash === '/editor' || String(hash || '').indexOf('/editor/') === 0;
}

// 兼容期文章（js/user-posts.js）正文内联在 JSON 数组里，导入器不会写这个文件，
// 因此它们在编辑器里是**只读**的：绝不假装能改，也绝不覆盖。
function isLegacyPost(post) {
  if (!post || typeof USER_POSTS === 'undefined') return false;
  return USER_POSTS.some(function (u) { return u.id === post.id; });
}

function editorPostOptions(selectedId) {
  return getAllPosts().map(function (p) {
    var legacy = isLegacyPost(p);
    var label = p.title + '（' + p.date + '）' + (legacy ? ' · 只读' : '');
    return '<option value="' + escapeHtml(p.id) + '"' +
      (p.id === selectedId ? ' selected' : '') +
      (legacy ? ' data-legacy="1"' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

// ============================================
// Markdown 编辑内核（Batch 8B-2）
// 设计原则：
//   1. 纯函数：输入 (text, start, end, …) → 输出 {start, end, replacement, selStart, selEnd}，
//      不碰 DOM，便于单元测试；按钮与快捷键共用同一套实现；
//   2. 应用层只做一件事：把结果交回 textarea（优先 document.execCommand('insertText')，
//      走浏览器原生编辑管线 → 原生 Undo/Redo 与 input 事件都不会被破坏）；
//   3. 所有插入都经过 escapeHtml 之外的 **Markdown 文本** 处理，不拼 HTML。
// ============================================

var MD_INDENT = '  ';                       // Tab 缩进 = 2 空格（GitHub 习惯）
var MD_IMAGE_DIR = 'images';                // 站内图片目录（仓库根，与 icons/ 同级）
var MD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;   // 单张图片上限 2 MiB（本地校验，不上传）
var MD_PLACEHOLDER = {
  bold: '加粗文字',
  italic: '斜体文字',
  code: '代码',
  codeBody: '在这里写代码',
  linkText: '链接文字',
  imageAlt: '图片描述',
  tableCell: '列 1'
};

var MDEditor = (function () {
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function lineStartOf(text, i) {
    if (i <= 0) return 0;                       // 注意：不能从 i-1 之外的位置搜，否则开头就是 \n 时会偏一行
    var idx = text.lastIndexOf('\n', i - 1);
    return idx === -1 ? 0 : idx + 1;
  }

  function lineEndOf(text, i) {                       // 该行结尾（不含 \n）
    var idx = text.indexOf('\n', i);
    return idx === -1 ? text.length : idx;
  }

  // 选区覆盖的整块行范围。选区末尾正好落在行首时，不多算下一行。
  function blockRange(text, start, end) {
    var last = (end > start) ? end - 1 : start;
    return { start: lineStartOf(text, start), end: lineEndOf(text, last) };
  }

  function edit(start, end, replacement, selStart, selEnd) {
    var ss = (selStart == null) ? start : selStart;
    var se = (selEnd == null) ? ss : selEnd;
    return { start: start, end: end, replacement: replacement, selStart: ss, selEnd: se };
  }

  // ---- 行级编辑 ----
  function applyLines(text, start, end, transform) {
    var r = blockRange(text, start, end);
    var lines = text.slice(r.start, r.end).split('\n');
    var out = transform(lines, r);
    var block = out.join('\n');
    return edit(r.start, r.end, block, r.start, r.start + block.length);
  }

  function toggleLinePrefix(text, start, end, prefix, re) {
    return applyLines(text, start, end, function (lines) {
      var filled = lines.filter(function (l) { return l !== ''; });
      var all = filled.length > 0 && filled.every(function (l) { return re.test(l); });
      return lines.map(function (l) {
        if (all) return l.replace(re, '');
        var bare = l.replace(re, '');
        return prefix + bare;
      });
    });
  }

  function setHeading(text, start, end, level) {
    var want = new Array(level + 1).join('#') + ' ';
    var sameRe = new RegExp('^#{' + level + '} ');
    var anyRe = /^#{1,6} /;
    return applyLines(text, start, end, function (lines) {
      var filled = lines.filter(function (l) { return l !== ''; });
      var same = filled.length > 0 && filled.every(function (l) { return sameRe.test(l); });
      return lines.map(function (l) {
        if (same) return l.replace(sameRe, '');
        return want + l.replace(anyRe, '');
      });
    });
  }

  function toggleQuote(text, start, end) {
    return toggleLinePrefix(text, start, end, '> ', /^> ?/);
  }

  function toggleUnorderedList(text, start, end) {
    return toggleLinePrefix(text, start, end, '- ', /^(?:[-*+] )/);
  }

  function toggleOrderedList(text, start, end) {
    return applyLines(text, start, end, function (lines) {
      var filled = lines.filter(function (l) { return l !== ''; });
      var all = filled.length > 0 && filled.every(function (l) { return /^\d+\. /.test(l); });
      var n = 0;
      return lines.map(function (l) {
        var bare = l.replace(/^\d+\. /, '');
        if (all) return bare;
        n += 1;
        return n + '. ' + bare;
      });
    });
  }

  function indent(text, start, end, outdent) {
    var r = blockRange(text, start, end);
    var multiline = start !== end && text.slice(start, end).indexOf('\n') !== -1;
    if (!multiline && !outdent) {
      // 单点 Tab：插入一级缩进（2 空格）。不做"到下一个制表位"的对齐，
      // 因为 Markdown 里按 Tab 的预期就是"缩进一格"，对齐会让结果随列号跳变。
      return edit(start, end, MD_INDENT, start + MD_INDENT.length, start + MD_INDENT.length);
    }
    return applyLines(text, start, end, function (lines) {
      if (!outdent) return lines.map(function (l) { return l === '' ? l : MD_INDENT + l; });
      return lines.map(function (l) {
        if (l.slice(0, MD_INDENT.length) === MD_INDENT) return l.slice(MD_INDENT.length);
        return l.replace(/^ {1,2}/, '');
      });
    });
  }

  // ---- 行内包裹 ----
  function toggleInline(text, start, end, marker, placeholder) {
    var len = marker.length;
    if (start !== end) {
      var sel = text.slice(start, end);
      // 选区两侧已经有 marker → 取消格式
      if (text.slice(start - len, start) === marker && text.slice(end, end + len) === marker) {
        return edit(start - len, end + len, sel, start - len, end - len);
      }
      // 选区自身带着 marker（用户选中了 **粗体**）→ 取消格式
      if (sel.length >= 2 * len && sel.slice(0, len) === marker && sel.slice(-len) === marker &&
          sel.slice(len, -len).length) {
        var inner = sel.slice(len, sel.length - len);
        return edit(start, end, inner, start, start + inner.length);
      }
      return edit(start, end, marker + sel + marker, start + len, end + len);
    }
    var body = placeholder || '';
    return edit(start, end, marker + body + marker,
                start + len, start + len + body.length);
  }

  function bold(text, s, e) { return toggleInline(text, s, e, '**', MD_PLACEHOLDER.bold); }
  function italic(text, s, e) { return toggleInline(text, s, e, '*', MD_PLACEHOLDER.italic); }
  function inlineCode(text, s, e) { return toggleInline(text, s, e, '`', MD_PLACEHOLDER.code); }

  // ---- 代码块：正确处理换行与语言标记 ----
  function codeBlock(text, start, end, lang) {
    var r = blockRange(text, start, end);
    var blockText = text.slice(r.start, r.end);
    var m = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(blockText);
    if (m) {                                       // 选区本身就是围栏块 → 取消
      var inner0 = m[1];
      return edit(r.start, r.end, inner0, r.start, r.start + inner0.length);
    }
    // 选区在围栏**内部**（上一次插入后选中的正是代码内容）→ 把上下两行围栏一起去掉
    if (r.start > 0) {
      var prevStart = lineStartOf(text, r.start - 1);
      var prevLine = text.slice(prevStart, r.start - 1);
      var afterStart = r.end + 1;
      if (/^```/.test(prevLine) && afterStart <= text.length) {
        var afterLine = text.slice(afterStart, lineEndOf(text, afterStart));
        if (/^```\s*$/.test(afterLine)) {
          return edit(prevStart, afterStart + afterLine.length, blockText,
                      prevStart, prevStart + blockText.length);
        }
      }
    }
    var inner = blockText;
    if (start === end && !inner) inner = MD_PLACEHOLDER.codeBody;
    var fence = '```' + (lang || '');
    var out = fence + '\n' + inner + '\n```';
    var innerStart = r.start + fence.length + 1;
    return edit(r.start, r.end, out, innerStart, innerStart + inner.length);
  }

  // ---- 链接 / 图片 ----
  function link(text, start, end, url) {
    var sel = text.slice(start, end);
    var isUrl = /^https?:\/\/\S+$/i.test(sel.trim());
    var fromSelection = !!sel && !isUrl;
    var label = fromSelection ? sel : MD_PLACEHOLDER.linkText;
    var target = isUrl ? sel.trim() : (url || 'https://');
    var snippet = '[' + label + '](' + mdUrl(target) + ')';
    // 选区已是文字 → 选中 URL 段（下一步就是粘贴地址）；否则选中占位文字
    var open = snippet.lastIndexOf('(') + 1;
    var close = snippet.length - 1;
    if (fromSelection) return edit(start, end, snippet, start + open, start + close);
    return edit(start, end, snippet, start + 1, start + 1 + label.length);
  }

  function image(alt, url) {
    var snippet = '![' + sanitizeAlt(alt) + '](' + mdUrl(url) + ')';
    return { snippet: snippet };
  }

  function table(text, start, end) {
    var head = '| 列 1 | 列 2 | 列 3 |';
    var sep = '| --- | --- | --- |';
    var row = '|  |  |  |';
    var block = head + '\n' + sep + '\n' + row;
    // 不在行首 → 先换行，保证表格独立成块
    var pre = (start !== 0 && text.charAt(start - 1) !== '\n') ? '\n' : '';
    var snippet = pre + block;
    var cellStart = start + pre.length + 2;          // '| ' 之后
    return edit(start, end, snippet, cellStart, cellStart + MD_PLACEHOLDER.tableCell.length);
  }

  function hr(text, start, end) {
    var pre = (start !== 0 && text[start - 1] !== '\n') ? '\n' : '';
    var snippet = pre + '---\n';
    return edit(start, end, snippet, start + snippet.length, start + snippet.length);
  }

  // ---- 文本安全 ----
  function sanitizeAlt(alt) {
    return String(alt == null ? '' : alt)
      .replace(/[\r\n]+/g, ' ')
      .replace(/[[\]]/g, '')
      .trim()
      .slice(0, 120) || MD_PLACEHOLDER.imageAlt;
  }

  // Markdown 链接目标：含括号/尖括号时用 <…> 包起来，避免提前闭合
  function mdUrl(url) {
    var u = String(url == null ? '' : url).trim();
    if (/[()<>\s]/.test(u)) return '<' + u.replace(/[<>]/g, '') + '>';
    return u;
  }

  // 图片地址白名单：https 绝对地址，或站内相对路径（拒绝 javascript:/data:/http: 等）
  function validateImageUrl(raw) {
    var url = String(raw == null ? '' : raw).trim();
    if (!url) return { ok: false, error: '请输入图片地址' };
    if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, error: '地址里包含控制字符' };
    if (/\s/.test(url)) return { ok: false, error: '地址里不能有空格（请用 %20 或改用无空格路径）' };
    if (/[<>"`\\]/.test(url)) return { ok: false, error: '地址里不能出现 < > " ` \\ 这些字符' };

    var scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(url);
    if (scheme) {
      var s = scheme[1].toLowerCase();
      if (s === 'https') return { ok: true, url: url, kind: 'remote' };
      if (s === 'http') {
        return { ok: false, error: '只支持 https:// 或站内相对路径（http 会被浏览器按混合内容拦截）' };
      }
      return { ok: false, error: '不支持的协议 ' + s + ':（只允许 https://）' };
    }
    if (url.indexOf('//') === 0) {
      return { ok: false, error: '协议相对地址（//…）不安全，请写完整的 https://' };
    }
    if (url.charAt(0) === '#') return { ok: false, error: '这不是图片地址' };
    if (url.split('/').indexOf('..') !== -1) {
      return { ok: false, error: '站内路径不能包含 ..（会跳出站点根目录）' };
    }
    return { ok: true, url: url, kind: 'relative' };
  }

  var MIME_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  var EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                   '.webp': 'image/webp', '.gif': 'image/gif' };

  function checkImageFile(file) {
    if (!file) return { ok: false, error: '请选择一张本地图片' };
    var name = String(file.name || '');
    var ext = (/\.[^.]+$/.exec(name) || [''])[0].toLowerCase();
    var type = String(file.type || '').toLowerCase();
    if (!MIME_EXT[type] && !EXT_MIME[ext]) {
      return { ok: false, error: '只支持 PNG / JPEG / WebP / GIF' };
    }
    var size = Number(file.size || 0);
    if (size <= 0) return { ok: false, error: '这个文件是空的' };
    if (size > MD_IMAGE_MAX_BYTES) {
      return { ok: false, error: '图片过大（' + (size / 1024 / 1024).toFixed(1) + ' MB > 2 MB 上限）' };
    }
    return { ok: true, ext: MIME_EXT[type] || ext.replace('.jpeg', '.jpg'), mime: type || EXT_MIME[ext] };
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }

  // 安全文件名：ASCII slug + 基于 (文件名, 大小, 修改时间) 的短哈希 → 同名不同图不会互相覆盖
  function suggestImagePath(file) {
    var check = checkImageFile(file);
    if (!check.ok) return check;
    var name = String(file.name || 'image');
    var base = name.replace(/\.[^.]+$/, '');
    var slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    var hash = fnv1a(base + '|' + (file.size || 0) + '|' + (file.lastModified || 0)).toString(36).slice(0, 6);
    return { ok: true, path: MD_IMAGE_DIR + '/' + slug + '-' + hash + check.ext };
  }

  function stats(text) {
    var t = String(text == null ? '' : text);
    var chars = t.replace(/\s/g, '').length;
    var cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (t.replace(/[\u4e00-\u9fa5]/g, '').match(/\b\w+\b/g) || []).length;
    return { chars: chars, cjk: cjk, words: words, minutes: readingTime(t) };
  }

  return {
    bold: bold, italic: italic, inlineCode: inlineCode,
    setHeading: setHeading, codeBlock: codeBlock,
    toggleQuote: toggleQuote, toggleUnorderedList: toggleUnorderedList,
    toggleOrderedList: toggleOrderedList,
    link: link, image: image, table: table, hr: hr, indent: indent,
    toggleInline: toggleInline, toggleLinePrefix: toggleLinePrefix,
    sanitizeAlt: sanitizeAlt, mdUrl: mdUrl, validateImageUrl: validateImageUrl,
    checkImageFile: checkImageFile, suggestImagePath: suggestImagePath,
    stats: stats, linesOf: blockRange, clamp: clamp
  };
})();
window.MDEditor = MDEditor;

// 把一次编辑写回 textarea。
// 优先 execCommand('insertText')：它走浏览器原生编辑管线，**原生 Undo/Redo 与 input 事件都保留**；
// 只有环境不支持时才退化为 setRangeText + 手动派发 input（jsdom 等）。
function applyMarkdownEdit(textarea, ed) {
  if (!textarea || !ed) return false;
  textarea.focus();
  textarea.setSelectionRange(ed.start, ed.end);

  var done = false;
  if (typeof document.execCommand === 'function') {
    try { done = document.execCommand('insertText', false, ed.replacement); } catch (e) { done = false; }
  }
  if (!done) {
    if (typeof textarea.setRangeText === 'function') {
      textarea.setRangeText(ed.replacement, ed.start, ed.end, 'end');
    } else {
      textarea.value = textarea.value.slice(0, ed.start) + ed.replacement + textarea.value.slice(ed.end);
    }
    // execCommand 路径会自动触发 input；退化路径需要手动补，保证草稿与预览都更新
    var ev;
    try {
      ev = new Event('input', { bubbles: true });
    } catch (e) {
      ev = document.createEvent('Event');
      ev.initEvent('input', true, false);
    }
    textarea.dispatchEvent(ev);
  }

  var value = textarea.value;
  var s = MDEditor.clamp(ed.selStart, 0, value.length);
  var e2 = MDEditor.clamp(ed.selEnd, s, value.length);
  textarea.setSelectionRange(s, e2);
  textarea.focus();
  return true;
}

// 工具栏动作表：id → 纯函数（按钮与快捷键共用）
function runMarkdownAction(action, textarea) {
  if (!textarea) return false;
  var text = textarea.value;
  var s = textarea.selectionStart;
  var e = textarea.selectionEnd;
  var langEl = document.getElementById('editorCodeLang');
  var ed = null;

  switch (action) {
    case 'h1': ed = MDEditor.setHeading(text, s, e, 1); break;
    case 'h2': ed = MDEditor.setHeading(text, s, e, 2); break;
    case 'h3': ed = MDEditor.setHeading(text, s, e, 3); break;
    case 'bold': ed = MDEditor.bold(text, s, e); break;
    case 'italic': ed = MDEditor.italic(text, s, e); break;
    case 'code': ed = MDEditor.inlineCode(text, s, e); break;
    case 'codeblock': ed = MDEditor.codeBlock(text, s, e, langEl ? langEl.value : ''); break;
    case 'ul': ed = MDEditor.toggleUnorderedList(text, s, e); break;
    case 'ol': ed = MDEditor.toggleOrderedList(text, s, e); break;
    case 'quote': ed = MDEditor.toggleQuote(text, s, e); break;
    case 'link': ed = MDEditor.link(text, s, e); break;
    case 'table': ed = MDEditor.table(text, s, e); break;
    case 'hr': ed = MDEditor.hr(text, s, e); break;
    case 'indent': ed = MDEditor.indent(text, s, e, false); break;
    case 'outdent': ed = MDEditor.indent(text, s, e, true); break;
    default: return false;
  }
  return ed ? applyMarkdownEdit(textarea, ed) : false;
}
window.runMarkdownAction = runMarkdownAction;

// ============================================
// DraftHistory（Batch 8B-3）：草稿历史快照
//
// 设计约束（对应 BATCH8B3_REPORT.md「历史版本存储结构」）：
//   1. 现有 localStorage 草稿（blog_draft / blog_draft_edit::<id>）**保持不动**，
//      历史快照另存 IndexedDB；IndexedDB 不可用时退化为进程内内存（只有当前标签页可见）。
//   2. 隔离：scopeKey = 'new' 或 'edit:<文章 id>'，两者、以及不同 id 之间永不互相覆盖。
//   3. 去重：内容指纹（标题/日期/标签/摘要/正文 的 FNV-1a）相同则不重复写入。
//   4. 配额：每个 scopeKey 最多 10 条；先淘汰最旧的 auto，再淘汰最旧的"受保护"记录。
//   5. 只保存 6 个白名单字段，绝不写入 Token/密码等无关数据，也不发起任何网络请求。
//   6. 所有方法都返回 Promise<结果对象>，**从不 reject**：历史模块故障不能影响草稿与导出。
// ============================================
var DraftHistory = (function () {
  var DB_NAME = 'blog-draft-history';
  var DB_VERSION = 1;
  var STORE = 'snapshots';
  var MAX_PER_SCOPE = 10;
  var AUTO_INTERVAL_MS = 5 * 60 * 1000;      // 自动快照最小间隔（约 5 分钟）
  var PREVIEW_CHARS = 80;

  var KIND_MANUAL = 'manual';
  var KIND_AUTO = 'auto';
  var KIND_BACKUP = 'restore-backup';

  var cfg = { scope: 'new', postId: '', now: null };
  var backend = null;            // { name, listAll, put, remove, clear }
  var degradeReason = '';
  var cache = [];                // 当前 scope 的记录（内存镜像，按 savedAt 倒序）
  var lastAutoAt = 0;
  var scopeLoaded = false;       // 是否已经把该 scope 的历史读进内存（防重入）
  var readyPromise = null;
  var tabId = Math.random().toString(36).slice(2, 8);

  function nowMs(at) {
    if (typeof at === 'number' && isFinite(at)) return at;
    if (cfg.now) return cfg.now();
    return Date.now();
  }

  function scopeKey() {
    return cfg.scope === 'edit' ? 'edit:' + (cfg.postId || '') : 'new';
  }

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
  }

  // 只取白名单字段：历史里绝不允许出现 token / password / 其它状态
  function pickState(state) {
    var s = state || {};
    var tags = s.tags;
    if (typeof tags === 'string') {
      tags = tags.split(/[,，]/).map(function (t) { return t.trim(); })
        .filter(function (t) { return t; });
    }
    if (!Array.isArray(tags)) tags = [];
    return {
      title: String(s.title == null ? '' : s.title),
      date: String(s.date == null ? '' : s.date).slice(0, 10),
      tags: tags.slice(0, 30).map(function (t) { return String(t).slice(0, 40); }),
      excerpt: String(s.excerpt == null ? '' : s.excerpt).slice(0, 2000),
      content: String(s.content == null ? '' : s.content)
    };
  }

  function fingerprint(snap) {
    return hash([snap.title, snap.date, snap.tags.join('\u0001'), snap.excerpt, snap.content].join('\u0000'));
  }

  function sortDesc(list) {
    return list.slice().sort(function (a, b) {
      if (b.savedAt !== a.savedAt) return b.savedAt - a.savedAt;
      return String(b.id) < String(a.id) ? -1 : 1;
    });
  }

  // ---------------------------------------------------------------- 后端
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('byScope', 'scopeKey', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开 IndexedDB 失败')); };
      req.onblocked = function () { reject(new Error('IndexedDB 被其它标签页阻塞')); };
    });
  }

  function makeIdbBackend(db) {
    function txDone(tx, resolve, reject) {
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
    }
    return {
      name: 'idb',
      listAll: function () {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readonly');
          var req = tx.objectStore(STORE).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error || new Error('读取历史失败')); };
        });
      },
      put: function (rec) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(rec);
          txDone(tx, resolve, reject);
        });
      },
      remove: function (id) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(id);
          txDone(tx, resolve, reject);
        });
      },
      clear: function () {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          txDone(tx, resolve, reject);
        });
      }
    };
  }

  function makeMemoryBackend(reason) {
    var mem = [];
    return {
      name: 'memory',
      listAll: function () { return Promise.resolve(mem.slice()); },
      put: function (rec) {
        var i = mem.findIndex(function (r) { return r.id === rec.id; });
        if (i >= 0) mem[i] = rec; else mem.push(rec);
        return Promise.resolve(true);
      },
      remove: function (id) {
        var i = mem.findIndex(function (r) { return r.id === id; });
        if (i >= 0) mem.splice(i, 1);
        return Promise.resolve(true);
      },
      clear: function () {
        mem = mem.filter(function (r) { return r.scopeKey !== scopeKey(); });
        return Promise.resolve(true);
      },
      reason: reason || ''
    };
  }

  function ensureBackend() {
    if (backend) return Promise.resolve(backend);
    return openDb().then(function (db) {
      backend = makeIdbBackend(db);
      return backend;
    }).catch(function (err) {
      degradeReason = (err && err.message) || String(err);
      backend = makeMemoryBackend(degradeReason);
      return backend;
    });
  }

  // ---------------------------------------------------------------- 查询
  function loadScope() {
    return ensureBackend().then(function (be) { return be.listAll(); }).then(function (all) {
      var key = scopeKey();
      // 损坏记录（缺字段/类型不对）单独丢弃，不能连累同 scope 的其它正常版本
      var mine = sortDesc((all || []).filter(function (r) {
        return r && r.scopeKey === key && typeof r.id === 'string' &&
          typeof r.savedAt === 'number' && isFinite(r.savedAt) &&
          typeof r.content === 'string' && typeof r.title === 'string';
      }));
      cache = mine;
      lastAutoAt = 0;
      mine.forEach(function (r) {
        if (r.kind === KIND_AUTO && r.savedAt > lastAutoAt) lastAutoAt = r.savedAt;
      });
      scopeLoaded = true;
      return mine;
    }).catch(function (err) {
      degradeReason = degradeReason || ((err && err.message) || String(err));
      cache = cache || [];
      scopeLoaded = true;
      return cache;
    });
  }

  // ---------------------------------------------------------------- 写入
  function buildRecord(kind, snap, at) {
    var fp = fingerprint(snap);
    return {
      id: scopeKey() + '|' + at + '|' + Math.random().toString(36).slice(2, 7),
      scopeKey: scopeKey(),
      scope: cfg.scope,
      postId: cfg.postId || '',
      kind: kind,
      savedAt: at,
      savedAtISO: new Date(at).toISOString(),
      title: snap.title,
      date: snap.date,
      tags: snap.tags.slice(),
      excerpt: snap.excerpt,
      content: snap.content,
      chars: snap.content.replace(/\s/g, '').length,
      hash: fp,
      tabId: tabId
    };
  }

  // 配额：先删最旧的 auto，再删最旧的受保护记录；手动版本优先保留
  function prune(list, be) {
    if (list.length <= MAX_PER_SCOPE) return Promise.resolve({ trimmed: 0, list: list });
    var keep = list.slice();
    var removed = 0;
    var over = keep.length - MAX_PER_SCOPE;
    // 1) 从最旧的 auto 开始
    for (var i = keep.length - 1; i >= 0 && removed < over; i--) {
      if (keep[i].kind === KIND_AUTO) { keep.splice(i, 1); removed++; }
    }
    // 2) 仍超限：动最旧的受保护记录（restore-backup 先于 manual）
    for (var j = keep.length - 1; j >= 0 && removed < over; j--) {
      if (keep[j].kind !== KIND_MANUAL) { keep.splice(j, 1); removed++; }
    }
    for (var k = keep.length - 1; k >= 0 && removed < over; k--) {
      keep.splice(k, 1); removed++;
    }
    var drop = list.filter(function (r) { return keep.indexOf(r) === -1; });
    return Promise.all(drop.map(function (r) {
      return be.remove(r.id).catch(function () { return false; });
    })).then(function () {
      cache = sortDesc(keep);
      return { trimmed: removed, list: cache };
    });
  }

  function snapshot(kind, state, atMs) {
    var at = nowMs(atMs);
    var snap = pickState(state);
    try {
      if (!snap.content.trim() && !snap.title.trim()) {
        return Promise.resolve({ ok: false, saved: false, error: '空白内容不保存为历史版本' });
      }
      return ensureBackend().then(function (be) {
        return be.listAll().then(function (all) {
          var mine = sortDesc((all || []).filter(function (r) {
            return r && r.scopeKey === scopeKey();
          }));
          var fp = fingerprint(snap);
          var dup = mine.some(function (r) { return r.hash === fp; });   // 同内容不重复
          if (dup) {
            cache = mine;
            return { ok: true, saved: false, skipped: 'duplicate', count: mine.length };
          }
          var rec = buildRecord(kind || KIND_MANUAL, snap, at);
          return be.put(rec).then(function () {
            var next = sortDesc([rec].concat(mine));
            if (kind === KIND_AUTO) lastAutoAt = Math.max(lastAutoAt, at);
            return prune(next, be).then(function (p) {
              return { ok: true, saved: true, record: rec, count: p.list.length,
                       trimmed: p.trimmed, backend: be.name };
            });
          });
        });
      }).catch(function (err) {
        var msg = (err && err.message) || String(err);
        var name = (err && err.name) || '';
        if (/quota/i.test(name) || /QuotaExceeded|quota/i.test(msg)) {
          return { ok: false, saved: false, error: '浏览器存储空间不足，无法保存历史版本' };
        }
        return { ok: false, saved: false, error: '历史版本写入失败：' + msg };
      });
    } catch (e) {
      return Promise.resolve({ ok: false, saved: false, error: '历史版本模块异常：' + ((e && e.message) || e) });
    }
  }

  function maybeAuto(state, atMs) {
    var at = nowMs(atMs);
    if (!scopeLoaded) {
      // 第一次进来先读一遍该 scope 的历史（只重入一次；用 scopeLoaded 而不是 lastAutoAt 判断，
      // 否则"还没有任何自动版本"时会无限递归）
      return loadScope().then(function () {
        if (lastAutoAt && at - lastAutoAt < AUTO_INTERVAL_MS) {
          return { ok: true, saved: false, skipped: 'throttled' };
        }
        return snapshot(KIND_AUTO, state, at);
      });
    }
    if (lastAutoAt && at - lastAutoAt < AUTO_INTERVAL_MS) {
      return Promise.resolve({ ok: true, saved: false, skipped: 'throttled' });
    }
    return snapshot(KIND_AUTO, state, at);
  }

  // ---------------------------------------------------------------- 差异
  function diff(oldRec, state) {
    var cur = pickState(state);
    var oldText = String((oldRec && oldRec.content) || '');
    var newText = cur.content;
    function lines(t) {
      return String(t || '').split('\n').filter(function (l) { return l.trim() !== ''; });
    }
    var a = lines(oldText), b = lines(newText);
    var counts = Object.create(null);
    a.forEach(function (l) { counts[l] = (counts[l] || 0) + 1; });
    var matched = 0;
    b.forEach(function (l) {
      if (counts[l] > 0) { counts[l]--; matched++; }
    });
    var charsOld = oldText.replace(/\s/g, '').length;
    var charsNew = newText.replace(/\s/g, '').length;
    var added = b.length - matched;
    var removed = a.length - matched;
    var bits = ['字数 ' + charsOld + ' → ' + charsNew + '（' + (charsNew - charsOld >= 0 ? '+' : '') + (charsNew - charsOld) + '）'];
    if (added || removed) bits.push('行 ' + (added ? '+' + added : '±0') + ' / ' + (removed ? '−' + removed : '−0'));
    if ((oldRec && oldRec.title) !== cur.title) bits.push('标题已改');
    if (JSON.stringify((oldRec && oldRec.tags) || []) !== JSON.stringify(cur.tags)) bits.push('标签已改');
    if ((oldRec && oldRec.excerpt) !== cur.excerpt) bits.push('摘要已改');
    return { charsOld: charsOld, charsNew: charsNew, addedLines: added, removedLines: removed,
             summary: bits.join('；') };
  }

  // ---------------------------------------------------------------- 公开 API
  return {
    KINDS: { MANUAL: KIND_MANUAL, AUTO: KIND_AUTO, BACKUP: KIND_BACKUP },
    MAX_PER_SCOPE: MAX_PER_SCOPE,
    AUTO_INTERVAL_MS: AUTO_INTERVAL_MS,
    PREVIEW_CHARS: PREVIEW_CHARS,

    configure: function (opts) {
      var o = opts || {};
      var nextScope = o.scope === 'edit' ? 'edit' : 'new';
      var nextId = nextScope === 'edit' ? String(o.postId || '') : '';
      if (nextScope !== cfg.scope || nextId !== cfg.postId) {
        cfg.scope = nextScope;
        cfg.postId = nextId;
        cache = [];
        lastAutoAt = 0;
        scopeLoaded = false;
        readyPromise = null;
      }
      if (typeof o.now === 'function') cfg.now = o.now;
      return scopeKey();
    },
    scopeKey: scopeKey,
    init: function () {
      if (!readyPromise) {
        readyPromise = ensureBackend().then(function (be) {
          return loadScope().then(function (list) {
            return { ok: true, backend: be.name, count: list.length,
                     degraded: be.name !== 'idb', reason: degradeReason || '' };
          });
        }).catch(function (err) {
          return { ok: false, backend: 'none', count: 0, degraded: true,
                   reason: (err && err.message) || String(err) };
        });
      }
      return readyPromise;
    },
    list: function () {
      return loadScope().catch(function () { return cache.slice(); });
    },
    snapshot: snapshot,
    maybeAuto: maybeAuto,
    remove: function (id) {
      if (!id) return Promise.resolve({ ok: false, error: '缺少记录 id' });
      return ensureBackend().then(function (be) {
        return be.remove(id).then(function () {
          cache = cache.filter(function (r) { return r.id !== id; });
          return { ok: true, count: cache.length };
        });
      }).catch(function (err) {
        return { ok: false, error: '删除失败：' + ((err && err.message) || err) };
      });
    },
    clear: function () {
      return ensureBackend().then(function (be) {
        return be.listAll().then(function (all) {
          var mine = (all || []).filter(function (r) { return r && r.scopeKey === scopeKey(); });
          return Promise.all(mine.map(function (r) {
            return be.remove(r.id).catch(function () { return false; });
          })).then(function () {
            cache = [];
            lastAutoAt = 0;
            return { ok: true, count: 0 };
          });
        });
      }).catch(function (err) {
        return { ok: false, error: '清理失败：' + ((err && err.message) || err) };
      });
    },
    stats: function () {
      return { scopeKey: scopeKey(), count: cache.length, lastAutoAt: lastAutoAt,
               backend: backend ? backend.name : 'none', tabId: tabId };
    },
    pickState: pickState,
    fingerprint: function (state) { return fingerprint(pickState(state)); },
    diff: diff,
    // 测试专用：重置后端与缓存（不影响 localStorage 草稿）
    _resetForTests: function (overrideBackend, opts) {
      backend = overrideBackend || null;
      cache = [];
      lastAutoAt = 0;
      scopeLoaded = false;
      readyPromise = null;
      degradeReason = (opts && opts.reason) || '';
      cfg = { scope: 'new', postId: '', now: null };
      tabId = 'testtab';
    },
    _injectBackend: function (be) {
      backend = be;
      readyPromise = null;
      cache = [];
      lastAutoAt = 0;
      scopeLoaded = false;
    }
  };
})();
if (typeof window !== 'undefined') window.DraftHistory = DraftHistory;

function editorToolbarHtml() {
  function btn(action, label, title) {
    return '<button type="button" class="editor-tool-btn" data-md="' + action +
      '" title="' + title + '" aria-label="' + title + '">' + label + '</button>';
  }
  var langs = ['', 'python', 'javascript', 'bash', 'json', 'html', 'css', 'sql', 'yaml', 'text'];
  var langSelect = '<select id="editorCodeLang" class="editor-lang" title="代码块语言" ' +
    'aria-label="代码块语言">' + langs.map(function (l) {
      return '<option value="' + l + '">' + (l || '无语言') + '</option>';
    }).join('') + '</select>';

  return '<div class="editor-toolbar" id="editorToolbar" role="toolbar" aria-label="Markdown 工具栏">' +
    btn('h1', 'H1', '一级标题') + btn('h2', 'H2', '二级标题') + btn('h3', 'H3', '三级标题') +
    '<span class="editor-tool-sep" aria-hidden="true"></span>' +
    btn('bold', '<b>B</b>', '加粗 (Ctrl+B)') +
    btn('italic', '<i>I</i>', '斜体 (Ctrl+I)') +
    btn('code', '&lt;/&gt;', '行内代码') +
    btn('codeblock', '```', '多行代码块') + langSelect +
    '<span class="editor-tool-sep" aria-hidden="true"></span>' +
    btn('ul', '• 列表', '无序列表') +
    btn('ol', '1. 列表', '有序列表') +
    btn('quote', '❝ 引用', '引用') +
    '<span class="editor-tool-sep" aria-hidden="true"></span>' +
    btn('link', '🔗 链接', '插入链接 (Ctrl+K)') +
    btn('image', '🖼 图片', '插入图片') +
    btn('table', '▦ 表格', '插入表格') +
    btn('hr', '—', '分割线') +
    '</div>';
}

function editorImagePanelHtml() {
  return '' +
    '<div class="editor-image-panel" id="editorImagePanel" hidden>' +
    '  <div class="editor-image-head">' +
    '    <strong>插入图片</strong>' +
    '    <button type="button" class="editor-tool-btn" data-img="close" title="关闭" aria-label="关闭">\u2716</button>' +
    '  </div>' +
    '  <div class="editor-image-tabs" role="tablist">' +
    '    <button type="button" class="editor-tab active" data-img-tab="url" role="tab" aria-selected="true">图片链接</button>' +
    '    <button type="button" class="editor-tab" data-img-tab="file" role="tab" aria-selected="false">本地图片</button>' +
    '  </div>' +
    '  <div class="editor-image-alt">' +
    '    <label class="editor-image-label" for="editorImageAlt">图片描述（alt，可选）</label>' +
    '    <input type="text" id="editorImageAlt" class="editor-input" placeholder="图片描述">' +
    '  </div>' +
    '  <div class="editor-image-pane" data-img-pane="url">' +
    '    <label class="editor-image-label" for="editorImageUrl">图片地址</label>' +
    '    <input type="text" id="editorImageUrl" class="editor-input" placeholder="https://… 或 images/example.png">' +
    '    <p class="editor-image-hint">只接受 <code>https://</code> 绝对地址或站内相对路径（如 <code>images/x.png</code>）。' +
    '      预览统一经过 DOMPurify，<code>javascript:</code> 之类的协议会被拒绝。</p>' +
    '    <button type="button" class="editor-btn editor-btn-primary" data-img="insert-url">插入链接图片</button>' +
    '  </div>' +
    '  <div class="editor-image-pane" data-img-pane="file" hidden>' +
    '    <label class="editor-image-label" for="editorImageFile">选择本地图片（PNG / JPEG / WebP / GIF，\u2264 2 MB）</label>' +
    '    <input type="file" id="editorImageFile" class="editor-input editor-file" ' +
    'accept="image/png,image/jpeg,image/webp,image/gif">' +
    '    <div class="editor-image-preview"><img id="editorImagePreview" alt="本地预览" hidden></div>' +
    '    <p class="editor-image-path" id="editorImagePath" hidden></p>' +
    '    <p class="editor-image-warn" id="editorImageWarn" hidden>\u26A0\uFE0F <b>仅本地预览</b>：' +
    '      这张图还没放进仓库，文章里的引用在提交前会显示为坏图。' +
    '      请把原图按上面的路径放进仓库，并与文章一起提交 PR。</p>' +
    '    <button type="button" class="editor-btn editor-btn-primary" data-img="insert-file" disabled>插入图片引用</button>' +
    '  </div>' +
    '  <div class="editor-image-error" id="editorImageError" role="alert"></div>' +
    '</div>';
}

function editorStatsHtml() {
  var isEdit = _editorMode === 'edit' && !!_editCtx;
  return '<div class="editor-stats" id="editorStats" data-stat-mode="' + (isEdit ? 'edit' : 'new') + '">' +
    '<span data-stat="chars">0 字</span>' +
    '<span data-stat="words">0 个英文词</span>' +
    '<span data-stat="minutes">\u2248 1 分钟</span>' +
    '<span data-stat="mode">' + (isEdit ? '\u7F16\u8F91\u6A21\u5F0F' : '\u65B0\u589E\u6A21\u5F0F') + '</span>' +
    '<span data-stat="id"' + (isEdit ? '' : ' hidden') + '>id: ' +
    escapeHtml(isEdit ? _editCtx.id : '') + '</span>' +
    '<span data-stat="draft" data-state="empty">\u672C\u5730\u8349\u7A3F\uFF1A\u672A\u4FDD\u5B58</span>' +
    '</div>';
}

function renderEditor(editId) {
  var isEdit = !!editId;
  _editorMode = isEdit ? 'edit' : 'new';
  if (!isEdit) _editCtx = null;

  // 两种模式各有独立草稿（新增 = blog_draft；编辑 = blog_draft_edit::<id>），互不覆盖
  var state = isEdit ? loadEditDraftState(editId) : loadNewDraftState();
  var dateValue = isEdit ? (state.date || '') : '';

  return '' +
    '<div class="editor-page">' +
    (isEdit
      ? '  <h1 class="page-title">\u{1F4DD} \u7F16\u8F91\u6587\u7AE0</h1>' +
        '  <p class="page-desc">\u6B63\u5728\u7F16\u8F91\u5DF2\u53D1\u5E03\u7684\u6587\u7AE0\uFF08id \u56FA\u5B9A\uFF0C\u94FE\u63A5\u4E0D\u53D8\uFF09\u3002\u6539\u5B8C\u5BFC\u51FA<b>\u66F4\u65B0\u7A3F JSON</b>\uFF0C\u518D\u7528 <code>scripts/import_post.py --mode update</code> \u66F4\u65B0\u672C\u5730\u4ED3\u5E93\uFF1B\u7F16\u8F91\u5668\u4E0D\u4F1A\u76F4\u63A5\u6539\u7AD9\u70B9\u3002</p>'
      : '  <h1 class="page-title">\u270F\uFE0F \u65B0\u5EFA\u6587\u7AE0</h1>' +
        '  <p class="page-desc">\u5728\u6D4F\u89C8\u5668\u91CC\u5199 Markdown \u5E76\u5B9E\u65F6\u9884\u89C8\uFF0C\u7136\u540E<b>\u5BFC\u51FA\u6587\u7AE0 JSON</b>\uFF1B\u53D1\u5E03\u8D70\u672C\u5730\u5BFC\u5165\u811A\u672C + \u624B\u52A8 PR\uFF0C\u7F16\u8F91\u5668\u4E0D\u518D\u76F4\u63A5\u5199\u5165\u4ED3\u5E93\u3002</p>') +
    '  <div class="editor-form">' +
    '    <div class="editor-mode-bar">' +
    '      <label class="editor-mode-label" for="editorPostPicker">\u6253\u5F00\u5DF2\u6709\u6587\u7AE0</label>' +
    '      <select id="editorPostPicker" class="editor-input editor-post-select" onchange="openEditorPost(this.value)">' +
    '        <option value="">\u2014 \u9009\u62E9\u4E00\u7BC7\u5DF2\u53D1\u5E03\u6587\u7AE0 \u2014</option>' +
    editorPostOptions(isEdit ? editId : '') +
    '      </select>' +
    (isEdit
      ? '<span class="editor-badge editor-badge-edit">\u7F16\u8F91\u6A21\u5F0F \u00B7 id: <code>' + escapeHtml(editId) + '</code>\uFF08\u56FA\u5B9A\uFF09</span>' +
        '<button class="editor-btn editor-btn-ghost" onclick="exitEditorEdit()">\u2716 \u9000\u51FA\u7F16\u8F91</button>'
      : '<span class="editor-badge">\u65B0\u589E\u6A21\u5F0F</span>') +
    '    </div>' +
    '    <input type="text" id="editorTitle" class="editor-input editor-input-title" placeholder="\u6587\u7AE0\u6807\u9898" value="' + escapeHtml(state.title || '') + '">' +
    '    <input type="text" id="editorTags" class="editor-input editor-input-tags" placeholder="\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09\uFF0C\u5982\uFF1A\u673A\u68B0\u81C2, VLA, \u6280\u672F\u7B14\u8BB0" value="' + escapeHtml(state.tags || '') + '">' +
    '    <textarea id="editorExcerpt" class="editor-input editor-textarea-excerpt" placeholder="\u6458\u8981\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u81EA\u52A8\u751F\u6210\uFF09" rows="2">' + escapeHtml(state.excerpt || '') + '</textarea>' +
    (isEdit
      ? '    <div class="editor-date-row">' +
        '      <span>\u53D1\u5E03\u65E5\u671F</span>' +
        '      <input type="text" id="editorDate" class="editor-input editor-input-date" value="' + escapeHtml(dateValue) + '" placeholder="YYYY-MM-DD">' +
        '      <span class="editor-date-hint">\u9ED8\u8BA4\u4FDD\u7559\u539F\u6587\u7AE0\u65E5\u671F\uFF0C\u4E0D\u6539\u5C31\u4E0D\u4F1A\u53D8</span>' +
        '    </div>'
      : '') +
    editorToolbarHtml() +
    '    <div class="editor-view-toggle" id="editorViewToggle" role="tablist" aria-label="编辑 / 预览切换">' +
    '      <button type="button" class="editor-view-btn active" data-view="edit" role="tab" aria-selected="true">\u270F\uFE0F \u7F16\u8F91</button>' +
    '      <button type="button" class="editor-view-btn" data-view="preview" role="tab" aria-selected="false">\u{1F441} \u9884\u89C8</button>' +
    '    </div>' +
    '    <div class="editor-split" id="editorSplit" data-view="edit">' +
    '      <div class="editor-pane editor-pane-edit">' +
    '        <div class="editor-pane-label">Markdown \u7F16\u8F91</div>' +
    '        <textarea id="editorContent" class="editor-textarea-content" placeholder="\u5728\u8FD9\u91CC\u8F93\u5165 Markdown \u5185\u5BB9...\n\n# \u6807\u9898\n\n\u6B63\u6587...\n\n```python\nprint(\"hello\")\n```">' + escapeHtml(state.content || '') + '</textarea>' +
    '      </div>' +
    '      <div class="editor-pane editor-pane-preview">' +
    '        <div class="editor-pane-label">\u5B9E\u65F6\u9884\u89C8</div>' +
    '        <div id="editorPreview" class="editor-preview markdown-body"></div>' +
    '      </div>' +
    '    </div>' +
    editorImagePanelHtml() +
    editorStatsHtml() +
    '    <div class="editor-actions">' +
    '      <button class="editor-btn editor-btn-secondary" onclick="saveDraft()">\u{1F4BE} \u4FDD\u5B58\u8349\u7A3F</button>' +
    '      <button class="editor-btn editor-btn-secondary" onclick="saveHistoryVersion()">\u{1F5C2}\uFE0F \u4FDD\u5B58\u5386\u53F2\u7248\u672C</button>' +
    '      <button class="editor-btn editor-btn-ghost" onclick="toggleHistoryPanel()">\u{1F558} \u5386\u53F2\u7248\u672C ' +
    '<span id="editorHistoryCount" class="editor-history-count">0</span></button>' +
    '      <button class="editor-btn editor-btn-primary" onclick="exportPost()">' +
    (isEdit ? '\u{1F4E4} \u5BFC\u51FA\u66F4\u65B0\u7A3F' : '\u{1F4E4} \u5BFC\u51FA\u6587\u7AE0') + '</button>' +
    '      <button class="editor-btn editor-btn-ghost" onclick="toggleEditorSettings()">\u2699\uFE0F \u8BBE\u7F6E</button>' +
    '    </div>' +
    '    <div id="editorStatus" class="editor-status"></div>' +
    '    <div class="editor-history-panel" id="editorHistoryPanel" hidden>' +
    '      <div class="editor-history-head">' +
    '        <strong>\u{1F558} \u5386\u53F2\u7248\u672C</strong>' +
    '        <button type="button" class="editor-tool-btn" data-hist="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">\u2716</button>' +
    '      </div>' +
    '      <div class="editor-history-actions">' +
    '        <button type="button" class="editor-btn editor-btn-secondary" data-hist="snapshot">\u{1F5C2}\uFE0F \u4FDD\u5B58\u5F53\u524D\u4E3A\u5386\u53F2\u7248\u672C</button>' +
    '        <button type="button" class="editor-btn editor-btn-ghost" data-hist="refresh">\u21BB \u5237\u65B0</button>' +
    '        <button type="button" class="editor-btn editor-btn-ghost" data-hist="clear">\u{1F9F9} \u6E05\u7406\u8BE5\u6587\u7AE0\u5386\u53F2</button>' +
    '      </div>' +
    '      <p class="editor-history-note">\u5386\u53F2\u53EA\u4FDD\u5B58\u5728\u672C\u673A\u6D4F\u89C8\u5668' +
    '\uFF08IndexedDB\uFF09\uFF0C<b>\u4E0D\u662F\u4E91\u7AEF\u5907\u4EFD</b>\uFF1A\u6E05\u9664\u7AD9\u70B9\u6570\u636E\u4F1A\u4E00\u5E76\u4E22\u5931\u3002' +
    '\u6062\u590D\u5386\u53F2\u7248\u672C\u4E0D\u7B49\u4E8E\u53D1\u5E03\uFF0C\u4E5F\u4E0D\u4F1A\u4FEE\u6539\u4ED3\u5E93\u3002</p>' +
    '      <p class="editor-history-notice" id="editorHistoryNotice" hidden></p>' +
    '      <ul class="editor-history-list" id="editorHistoryList"></ul>' +
    '      <div class="editor-history-preview" id="editorHistoryPreview" hidden>' +
    '        <div class="editor-history-preview-head">' +
    '          <span class="editor-history-preview-title" id="editorHistoryPreviewTitle"></span>' +
    '          <button type="button" class="editor-tool-btn" data-hist="close-preview" title="\u5173\u95ED\u9884\u89C8" aria-label="\u5173\u95ED\u9884\u89C8">\u2716</button>' +
    '        </div>' +
    '        <div class="editor-history-diff" id="editorHistoryDiff"></div>' +
    '        <div class="editor-history-body markdown-body" id="editorHistoryBody"></div>' +
    '        <button type="button" class="editor-btn editor-btn-primary" data-hist="restore">\u267B\uFE0F \u6062\u590D\u8BE5\u7248\u672C</button>' +
    '        <div class="editor-history-confirm" id="editorHistoryConfirm" hidden>' +
    '          <p>\u786E\u8BA4\u7528\u8BE5\u7248\u672C\u8986\u76D6\u5F53\u524D\u7F16\u8F91\u5185\u5BB9\uFF1F' +
    '\u6062\u590D\u524D\u4F1A\u5148\u7ED9\u5F53\u524D\u5185\u5BB9\u5B58\u4E00\u4EFD\u5B89\u5168\u5FEB\u7167\uFF1B\u5FEB\u7167\u5931\u8D25\u5219\u4E0D\u4F1A\u6062\u590D\u3002</p>' +
    '          <button type="button" class="editor-btn editor-btn-primary" data-hist="confirm-restore">\u786E\u8BA4\u6062\u590D</button>' +
    '          <button type="button" class="editor-btn editor-btn-ghost" data-hist="cancel-restore">\u53D6\u6D88</button>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '    <div id="editorSettings" class="editor-settings" style="display:none;">' +
    '      <h3>\u65E7\u7248\u53D1\u5E03\u8BBE\u7F6E\uFF08\u5DF2\u505C\u7528\uFF09</h3>' +
    '      <div class="editor-settings-hint">' +
    '        <p>\u7F16\u8F91\u5668\u73B0\u5728\u53EA\u8D1F\u8D23\u300C\u5BFC\u51FA\u300D\uFF1A\u4E0D\u518D\u5411 GitHub \u63D0\u4EA4\uFF0C\u4E5F\u4E0D\u518D\u9700\u8981 GitHub Token\u3002</p>' +
    '        <p>\u65B0\u589E\uFF1A\u5BFC\u51FA JSON \u2192 <code>python scripts/import_post.py --file &lt;id&gt;.json --dry-run</code> \u2192 <code>--apply</code>\u3002</p>' +
    '        <p>\u66F4\u65B0\uFF1A\u5BFC\u51FA\u66F4\u65B0\u7A3F \u2192 <code>python scripts/import_post.py --file &lt;id&gt;.update.json --mode update --dry-run</code> \u2192 <code>--apply</code>\u3002</p>' +
    '        <p>\u82E5\u4F60\u4EE5\u524D\u5728\u672C\u673A\u4FDD\u5B58\u8FC7 GitHub Token\uFF0C\u53EF\u4EE5\u5728\u8FD9\u91CC\u4E00\u6B21\u6027\u6E05\u9664\uFF08\u4E0D\u4F1A\u518D\u88AB\u4EFB\u4F55\u4EE3\u7801\u4F7F\u7528\uFF09\u3002</p>' +
    '        <p id="legacyPublishState">' + legacyPublishStateText() + '</p>' +
    '      </div>' +
    '      <button class="editor-btn editor-btn-ghost" onclick="clearLegacyPublishData()">\u{1F9F9} \u6E05\u9664\u65E7\u7248 GitHub Token</button>' +
    '    </div>' +
    '  </div>' +
    '</div>';
}

// 加载/只读/不存在的兜底页：只提示，不碰任何草稿
function renderEditorBlocked(editId, prepared) {
  _editorMode = 'blocked';     // 没有可用表单：draftStorageKey() 返回 null，任何情况下都不写草稿
  _editCtx = null;
  var title, detail;
  if (prepared.kind === 'missing') {
    title = '\u6587\u7AE0\u4E0D\u5B58\u5728';
    detail = '\u4ED3\u5E93\u91CC\u6CA1\u6709 id \u4E3A <code>' + escapeHtml(editId) +
      '</code> \u7684\u6587\u7AE0\uFF08\u53EF\u80FD\u5DF2\u88AB\u91CD\u547D\u540D\u6216\u5220\u9664\uFF09\u3002';
  } else if (prepared.kind === 'legacy') {
    title = '\u8BE5\u6587\u7AE0\u4E3A\u53EA\u8BFB\u6765\u6E90';
    detail = '\u8FD9\u7BC7\u6587\u7AE0\u6765\u81EA\u517C\u5BB9\u671F\u7684 <code>js/user-posts.js</code>' +
      '\uFF08\u6B63\u6587\u5185\u8054\u5728 JSON \u6570\u7EC4\u91CC\uFF09\u3002\u5BFC\u5165\u5668\u4E0D\u4F1A\u5199\u8FD9\u4E2A\u6587\u4EF6\uFF0C' +
      '\u56E0\u6B64\u7F16\u8F91\u5668\u4E0D\u63D0\u4F9B\u5728\u7EBF\u7F16\u8F91\uFF0C\u4E5F\u4E0D\u4F1A\u8986\u76D6\u5B83\u3002' +
      '\u5982\u9700\u4FEE\u6539\uFF0C\u8BF7\u5148\u628A\u5B83\u8FC1\u79FB\u5230 <code>data/posts/' + escapeHtml(editId) + '.md</code>' +
      '\uFF08\u53C2\u89C1 BATCH8B1_REPORT.md\u300C\u5DF2\u77E5\u9650\u5236\u300D\uFF09\u3002';
  } else {
    title = '\u6B63\u6587\u52A0\u8F7D\u5931\u8D25';
    detail = '\u65E0\u6CD5\u8BFB\u53D6 <code>data/posts/' + escapeHtml(editId) + '.md</code>\uFF1A' +
      escapeHtml(prepared.message || '\u672A\u77E5\u9519\u8BEF') +
      '\u3002\u5F53\u524D\u8349\u7A3F\u88AB\u4FDD\u7559\uFF0C\u672A\u88AB\u6E05\u9664\u3002';
  }
  return '' +
    '<div class="editor-page">' +
    '  <h1 class="page-title">\u26A0\uFE0F ' + title + '</h1>' +
    '  <p class="page-desc">' + detail + '</p>' +
    '  <p>' +
    '    <a class="editor-btn editor-btn-ghost" href="#/editor">\u2190 \u56DE\u5230\u7F16\u8F91\u5668</a>' +
    (prepared.kind === 'missing' ? '' : ' <a class="editor-btn editor-btn-ghost" href="#/post/' + escapeHtml(editId) + '">\u67E5\u770B\u6587\u7AE0</a>') +
    '  </p>' +
    '</div>';
}

// 进入编辑模式前的准备：定位文章 + 取回正文，失败时**不动**任何草稿
async function prepareEditorEdit(id) {
  var post = getAllPosts().find(function (p) { return p.id === id; });
  if (!post) return { ok: false, kind: 'missing' };
  if (isLegacyPost(post)) return { ok: false, kind: 'legacy' };
  if (_editCtx && _editCtx.id === id) return { ok: true, cached: true };

  var body;
  try {
    body = await loadPostBody(id);
  } catch (err) {
    return { ok: false, kind: 'load-failed', message: (err && err.message) || String(err) };
  }
  if (typeof body !== 'string') return { ok: false, kind: 'load-failed', message: 'body is not text' };

  _editCtx = {
    id: id,
    title: post.title || '',
    date: post.date || '',
    tags: (post.tags || []).slice(),
    excerpt: post.excerpt || '',
    content: body                       // 原文快照：导出更新稿时原样带上，供导入器做版本校验
  };
  return { ok: true };
}

window.openEditorPost = function (id) {
  if (!id) return;
  flushDraft(true);                       // 先把当前模式的草稿落盘，再切换（两个草稿互不覆盖）
  location.hash = '#/editor/' + encodeURIComponent(id);
};

window.exitEditorEdit = function () {
  flushDraft(true);
  location.hash = '#/editor';
};

// 供测试与调试使用：当前是哪个模式、编辑的是哪一篇
window.editorContext = function () {
  return { mode: _editorMode, id: _editCtx ? _editCtx.id : null };
};

// 供测试与调试使用：历史版本面板的当前状态（只读快照）
window.editorHistory = function () {
  return {
    scope: historyScope(),
    records: _historyUi.records.slice(),
    selected: _historyUi.selectedId,
    backend: DraftHistory.stats().backend
  };
};

// --- 文章 id 生成 ---
// 只用 ASCII 字符，保证与 scripts/split_posts.py 的 SAFE_ID（^[a-z0-9][a-z0-9-]*$）一致。
// 刻意做成**确定性**的（标题 → id，冲突时加 -2/-3）：
//   * 同一篇文章改完正文再导出，文件名与 id 不变，不会在 data/posts 里留下两份；
//   * 中文标题无法生成 slug 时退化成 post / post-2 / post-3…（导入器会原样当作文件名）。
function generatePostId(title) {
  var slug = String(title || '').toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  var base = slug.length > 3 ? slug : 'post';
  var taken = {};
  getAllPosts().forEach(function (p) { taken[p.id] = true; });
  var id = base;
  var n = 1;
  while (taken[id]) {
    n += 1;
    id = base + '-' + n;
  }
  return id;
}

// --- Draft management ---
// 编辑器随时可能被路由重绘销毁，所以草稿维护两份状态：
//   _draftState：最新内容的内存快照（DOM 已卸载时仍可落盘）
//   localStorage：真正持久化的草稿
var _draftTimer = null;
var _draftState = null;
var _currentRoute = null;

function readEditorForm() {
  var t = document.getElementById('editorTitle');
  var g = document.getElementById('editorTags');
  var e = document.getElementById('editorExcerpt');
  var c = document.getElementById('editorContent');
  var d = document.getElementById('editorDate');     // 只有编辑模式才有日期输入
  if (!t || !g || !e || !c) return null;   // 编辑器已卸载，不能再读 DOM
  return { title: t.value, tags: g.value, excerpt: e.value, content: c.value,
           date: d ? d.value : '' };
}

function hasDraftContent(state) {
  if (!state) return false;
  return !!(state.title || state.tags || state.excerpt || state.content);
}

function readDraftJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}

// 新增模式草稿：沿用 8A 的 blog_draft（老草稿没有 mode 字段，视为新增模式）
function loadNewDraftState() {
  var d = readDraftJson('blog_draft');
  var usable = d && (!d.mode || d.mode === 'new') &&
    (d.title || d.tags || d.excerpt || d.content);
  _draftState = usable
    ? { title: d.title || '', tags: d.tags || '', excerpt: d.excerpt || '',
        content: d.content || '', date: '' }
    : null;
  return _draftState || { title: '', tags: '', excerpt: '', content: '', date: '' };
}

// 编辑模式草稿：每篇文章一个键，和新增模式完全分开（互不覆盖）
function loadEditDraftState(id) {
  var base = {
    title: (_editCtx && _editCtx.title) || '',
    date: (_editCtx && _editCtx.date) || '',
    tags: ((_editCtx && _editCtx.tags) || []).join(', '),
    excerpt: (_editCtx && _editCtx.excerpt) || '',
    content: (_editCtx && _editCtx.content) || ''
  };
  var d = readDraftJson(EDIT_DRAFT_PREFIX + id);
  var usable = d && d.id === id && d.mode === 'edit' &&
    (d.title || d.tags || d.excerpt || d.content || d.date);
  _draftState = usable
    ? {
        title: d.title == null ? base.title : d.title,
        date: d.date || base.date,
        tags: d.tags == null ? base.tags : d.tags,
        excerpt: d.excerpt == null ? base.excerpt : d.excerpt,
        content: d.content == null ? base.content : d.content
      }
    : base;
  return _draftState;
}

function draftStorageKey() {
  if (_editorMode === 'edit' && _editCtx) return EDIT_DRAFT_PREFIX + _editCtx.id;
  if (_editorMode === 'new') return 'blog_draft';
  return null;              // blocked：没有表单，不写任何草稿键
}

function writeDraft(state, silent) {
  if (!hasDraftContent(state) && _editorMode !== 'edit') return false;
  if (!state) return false;
  var key = draftStorageKey();
  if (!key) return false;
  var payload = {
    mode: _editorMode,
    id: (_editorMode === 'edit' && _editCtx) ? _editCtx.id : '',
    title: state.title || '',
    date: state.date || '',
    tags: state.tags || '',
    excerpt: state.excerpt || '',
    content: state.content || '',
    savedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    return false;
  }
  _draftState = payload;
  setDraftStat('saved');          // 状态栏只承诺"本地草稿已保存"，不代表已导出/已发布
  if (!silent) showEditorStatus('\u{1F4BE} \u8349\u7A3F\u5DF2\u4FDD\u5B58', 'success');

  // 历史快照：复用同一个保存触发点，内部做「内容去重 + 5 分钟节流」；
  // 任何失败都只影响历史，绝不影响刚写好的草稿（Promise 全部 resolve）。
  try {
    DraftHistory.maybeAuto(payload).then(function (r) {
      if (r && r.saved) updateHistoryBadge(r.count);
    });
  } catch (e) { /* 历史模块异常必须静默吞掉 */ }
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

// --- 旧版 GitHub 发布数据清理（Batch 8A 迁移能力）---
// 8A 之前编辑器会把 GitHub PAT 写进 sessionStorage/localStorage，并记住 owner/repo。
// 现在整条链路已下线：代码不再读取这些键（只允许清除），旧用户仍可一键删干净。
var LEGACY_PUBLISH_KEYS = ['gh_token', 'gh_owner', 'gh_repo'];

function readStorage(store, key) {
  try { return store.getItem(key); } catch (e) { return null; }
}

function hasLegacyPublishData() {
  return LEGACY_PUBLISH_KEYS.some(function (key) {
    return readStorage(sessionStorage, key) !== null || readStorage(localStorage, key) !== null;
  });
}

function legacyPublishStateText() {
  if (!hasLegacyPublishData()) return '本机没有发现旧版发布数据。';
  var hasToken = readStorage(sessionStorage, 'gh_token') !== null ||
    readStorage(localStorage, 'gh_token') !== null;
  return hasToken
    ? '本机仍残留旧版 GitHub Token（本次不会被读取），建议立即清除。'
    : '本机仍残留旧版仓库设置（owner/repo），可以清除。';
}

function updateLegacyPublishState() {
  var el = document.getElementById('legacyPublishState');
  if (el) el.textContent = legacyPublishStateText();
}

// 只删键、不回显：任何情况下都不把 Token 写进 DOM
window.clearLegacyPublishData = function() {
  LEGACY_PUBLISH_KEYS.forEach(function (key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
    try { localStorage.removeItem(key); } catch (e) {}
  });
  updateLegacyPublishState();
  showEditorStatus('🔒 已清除本机保存的旧版 GitHub 发布数据（含 Token）', 'success');
};

// 兼容旧页面/旧测试里的入口名，行为完全一致（仅清理，不再保存）
window.clearEditorToken = window.clearLegacyPublishData;

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

// --- 状态栏（Batch 8B-2）---
// 统计随输入同步更新：这里只做一次字符串扫描，比同一事件里已有的 marked 渲染便宜得多，
// 因此**不新增定时器**（现有草稿防抖定时器是唯一的计时器，测试也依赖这个契约）。
function updateEditorStats() {
  var box = document.getElementById('editorStats');
  var ta = document.getElementById('editorContent');
  if (!box || !ta) return;
  var s = MDEditor.stats(ta.value);
  var get = function (key) { return box.querySelector('[data-stat="' + key + '"]'); };
  if (get('chars')) get('chars').textContent = s.chars + ' \u5B57';
  if (get('words')) get('words').textContent = s.words + ' \u4E2A\u82F1\u6587\u8BCD';
  if (get('minutes')) get('minutes').textContent = '\u2248 ' + s.minutes + ' \u5206\u949F';
  if (get('mode')) get('mode').textContent = (_editorMode === 'edit') ? '\u7F16\u8F91\u6A21\u5F0F' : '\u65B0\u589E\u6A21\u5F0F';
  var idEl = get('id');
  if (idEl) {
    if (_editorMode === 'edit' && _editCtx) {
      idEl.textContent = 'id: ' + _editCtx.id;
      idEl.removeAttribute('hidden');
    } else {
      idEl.textContent = '';
      idEl.setAttribute('hidden', '');
    }
  }
  box.setAttribute('data-stat-mode', _editorMode === 'edit' ? 'edit' : 'new');
}

// 草稿状态：只反映**本地草稿**（沿用 8A/8B1 的同一套保存流程，不引入第二套状态机）
function setDraftStat(state) {
  var el = document.querySelector('#editorStats [data-stat="draft"]');
  if (!el) return;
  el.setAttribute('data-state', state);
  if (state === 'dirty') {
    el.textContent = '\u672C\u5730\u8349\u7A3F\uFF1A\u5F85\u4FDD\u5B58\u2026';
  } else if (state === 'saved') {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    el.textContent = '\u672C\u5730\u8349\u7A3F\uFF1A\u5DF2\u4FDD\u5B58 ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '\uFF08\u4EC5\u672C\u5730\uFF09';
  } else if (state === 'restored') {
    el.textContent = '\u672C\u5730\u8349\u7A3F\uFF1A\u5DF2\u6062\u590D\uFF08\u5C1A\u672A\u5BFC\u51FA\uFF09';
  } else {
    el.textContent = '\u672C\u5730\u8349\u7A3F\uFF1A\u672A\u4FDD\u5B58';
  }
}

// --- 工具栏 ---
function setupEditorToolbar() {
  var bar = document.getElementById('editorToolbar');
  var ta = document.getElementById('editorContent');
  if (!bar || !ta || bar.dataset.bound === '1') return;
  bar.dataset.bound = '1';

  // 按下就阻止默认行为：按钮不抢焦点，textarea 的选区与光标保持不变
  bar.addEventListener('mousedown', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-md]') : null;
    if (btn) e.preventDefault();
  });
  bar.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-md]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-md');
    if (action === 'image') { toggleEditorImagePanel(true); return; }
    runMarkdownAction(action, ta);
  });
}

// --- 快捷键 ---
// 只绑在正文 textarea 上：标题/标签/摘要等其它输入框完全不受影响。
function handleEditorKeydown(e) {
  // 中文输入法组合期间一律不处理（否则会打断候选词上屏）
  if (e.isComposing || e.keyCode === 229) return;

  var ta = e.currentTarget || document.getElementById('editorContent');
  var mod = e.ctrlKey || e.metaKey;

  if (mod && !e.altKey) {
    var k = String(e.key || '').toLowerCase();
    if (k === 'b') { e.preventDefault(); runMarkdownAction('bold', ta); return; }
    if (k === 'i') { e.preventDefault(); runMarkdownAction('italic', ta); return; }
    if (k === 'k') { e.preventDefault(); runMarkdownAction('link', ta); return; }
    // Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y：明确放行，交给浏览器原生 Undo/Redo。
    // 自研历史栈会和输入法、拖拽、拼写检查抢状态，这里坚持不接管。
    if (k === 'z' || k === 'y') return;
  }

  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    runMarkdownAction(e.shiftKey ? 'outdent' : 'indent', ta);
  }
}

function setupEditorShortcuts() {
  var ta = document.getElementById('editorContent');
  if (!ta || ta.dataset.keysBound === '1') return;
  ta.dataset.keysBound = '1';
  ta.addEventListener('keydown', handleEditorKeydown);
}

// --- 编辑 / 预览视图切换（仅移动端可见）---
// 只切 data-view 属性，DOM 完全不动 → 切换后内容与选区都还在
function setupEditorViewToggle() {
  var box = document.getElementById('editorViewToggle');
  var split = document.getElementById('editorSplit');
  if (!box || !split || box.dataset.bound === '1') return;
  box.dataset.bound = '1';
  box.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (!btn) return;
    var view = btn.getAttribute('data-view');
    split.setAttribute('data-view', view);
    Array.prototype.forEach.call(box.querySelectorAll('[data-view]'), function (b) {
      var on = (b === btn);
      if (on) b.classList.add('active'); else b.classList.remove('active');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (view === 'preview') updateEditorPreview();
  });
}

// --- 图片面板 ---
var _imagePanel = { objectUrl: null, path: null };

function showImageError(msg) {
  var el = document.getElementById('editorImageError');
  if (!el) return;
  el.textContent = msg || '';
  if (msg) el.setAttribute('data-error', '1'); else el.removeAttribute('data-error');
}

function switchImageTab(name) {
  var panel = document.getElementById('editorImagePanel');
  if (!panel) return;
  Array.prototype.forEach.call(panel.querySelectorAll('[data-img-tab]'), function (b) {
    var on = (b.getAttribute('data-img-tab') === name);
    if (on) b.classList.add('active'); else b.classList.remove('active');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  Array.prototype.forEach.call(panel.querySelectorAll('[data-img-pane]'), function (p) {
    if (p.getAttribute('data-img-pane') === name) p.removeAttribute('hidden');
    else p.setAttribute('hidden', '');
  });
}

function resetEditorImagePanel() {
  if (_imagePanel.objectUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try { URL.revokeObjectURL(_imagePanel.objectUrl); } catch (e) {}
  }
  _imagePanel.objectUrl = null;
  _imagePanel.path = null;
  var urlEl = document.getElementById('editorImageUrl');
  if (urlEl) urlEl.value = '';
  var img = document.getElementById('editorImagePreview');
  if (img) { img.removeAttribute('src'); img.setAttribute('hidden', ''); }
  var pathEl = document.getElementById('editorImagePath');
  if (pathEl) { pathEl.textContent = ''; pathEl.setAttribute('hidden', ''); }
  var warnEl = document.getElementById('editorImageWarn');
  if (warnEl) warnEl.setAttribute('hidden', '');
  var btn = document.querySelector('[data-img="insert-file"]');
  if (btn) btn.disabled = true;
  showImageError('');
}

function toggleEditorImagePanel(show) {
  var panel = document.getElementById('editorImagePanel');
  if (!panel) return;
  var next = (show == null) ? panel.hasAttribute('hidden') : !!show;
  if (next) {
    panel.removeAttribute('hidden');
    switchImageTab('url');
    var urlEl = document.getElementById('editorImageUrl');
    if (urlEl) urlEl.focus();
  } else {
    panel.setAttribute('hidden', '');
    resetEditorImagePanel();
    var ta = document.getElementById('editorContent');
    if (ta) ta.focus();
  }
}
window.toggleEditorImagePanel = toggleEditorImagePanel;

// 插入图片引用：只写 Markdown 文本，绝不写 base64、绝不发请求
function insertImageReference(url, alt) {
  var ta = document.getElementById('editorContent');
  if (!ta) return false;
  var snippet = MDEditor.image(alt, url).snippet;
  var at = ta.selectionStart;
  applyMarkdownEdit(ta, {
    start: at, end: ta.selectionEnd, replacement: snippet,
    selStart: at + snippet.length, selEnd: at + snippet.length
  });
  return true;
}

function insertImageFromUrl() {
  var urlEl = document.getElementById('editorImageUrl');
  var altEl = document.getElementById('editorImageAlt');
  var check = MDEditor.validateImageUrl(urlEl ? urlEl.value : '');
  if (!check.ok) { showImageError(check.error); return false; }
  showImageError('');
  insertImageReference(check.url, altEl ? altEl.value : '');
  showEditorStatus('\u{1F5BC} \u5DF2\u63D2\u5165\u56FE\u7247\u5F15\u7528\uFF08' +
    (check.kind === 'remote' ? '\u5916\u90E8\u94FE\u63A5' : '\u7AD9\u5185\u76F8\u5BF9\u8DEF\u5F84') + '\uFF09', 'success');
  toggleEditorImagePanel(false);
  return true;
}

function insertImageFromFile() {
  var path = _imagePanel.path;
  if (!path) { showImageError('\u8BF7\u5148\u9009\u62E9\u4E00\u5F20\u672C\u5730\u56FE\u7247'); return false; }
  var altEl = document.getElementById('editorImageAlt');
  insertImageReference(path, altEl ? altEl.value : '');
  // 如实告知：这张图还没进仓库
  showEditorStatus('\u{1F5BC} \u5DF2\u63D2\u5165 <code>' + escapeHtml(path) + '</code>' +
    '\uFF08<b>\u4EC5\u672C\u5730\u9884\u89C8\uFF0C\u56FE\u7247\u5C1A\u672A\u52A0\u5165\u4ED3\u5E93</b>\uFF09' +
    '\u3002\u8BF7\u628A\u539F\u56FE\u653E\u5230 <code>' + escapeHtml(path) +
    '</code> \u5E76\u4E0E\u6587\u7AE0\u4E00\u8D77\u63D0\u4EA4\u3002', 'loading');
  toggleEditorImagePanel(false);
  return true;
}

function onImageFileChosen(e) {
  var file = e.target.files && e.target.files[0];
  var img = document.getElementById('editorImagePreview');
  var pathEl = document.getElementById('editorImagePath');
  var warnEl = document.getElementById('editorImageWarn');
  var btn = document.querySelector('[data-img="insert-file"]');

  if (_imagePanel.objectUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try { URL.revokeObjectURL(_imagePanel.objectUrl); } catch (err) {}
  }
  _imagePanel.objectUrl = null;
  _imagePanel.path = null;
  if (img) { img.removeAttribute('src'); img.setAttribute('hidden', ''); }
  if (pathEl) { pathEl.textContent = ''; pathEl.setAttribute('hidden', ''); }
  if (warnEl) warnEl.setAttribute('hidden', '');
  if (btn) btn.disabled = true;

  if (!file) return;
  var check = MDEditor.checkImageFile(file);
  if (!check.ok) { showImageError(check.error); return; }
  var sug = MDEditor.suggestImagePath(file);
  if (!sug.ok) { showImageError(sug.error); return; }

  showImageError('');
  _imagePanel.path = sug.path;
  if (img && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      _imagePanel.objectUrl = URL.createObjectURL(file);
      img.src = _imagePanel.objectUrl;
      img.removeAttribute('hidden');
    } catch (err) { /* 预览失败不影响插入引用 */ }
  }
  if (pathEl) {
    pathEl.textContent = '\u5EFA\u8BAE\u8DEF\u5F84\uFF1A' + sug.path +
      '\uFF08\u4ED3\u5E93\u6839\u76EE\u5F55\uFF1B\u4E0D\u5B58\u5728\u65F6\u9700\u8981\u65B0\u5EFA images/ \u76EE\u5F55\uFF09';
    pathEl.removeAttribute('hidden');
  }
  if (warnEl) warnEl.removeAttribute('hidden');
  if (btn) btn.disabled = false;
}

function setupEditorImagePanel() {
  var panel = document.getElementById('editorImagePanel');
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  panel.addEventListener('click', function (e) {
    var tab = e.target && e.target.closest ? e.target.closest('[data-img-tab]') : null;
    if (tab) { switchImageTab(tab.getAttribute('data-img-tab')); return; }
    var act = e.target && e.target.closest ? e.target.closest('[data-img]') : null;
    if (!act) return;
    var a = act.getAttribute('data-img');
    if (a === 'close') toggleEditorImagePanel(false);
    else if (a === 'insert-url') insertImageFromUrl();
    else if (a === 'insert-file') insertImageFromFile();
  });
  var fileEl = document.getElementById('editorImageFile');
  if (fileEl) fileEl.addEventListener('change', onImageFileChosen);
}

// --- 历史版本面板（Batch 8B-3）---
// 只是草稿的本地快照：恢复 ≠ 发布，也不会碰仓库里的任何文件。
var _historyUi = { records: [], selectedId: '', pendingRestore: null, loaded: false };

function historyScope() {
  return {
    scope: _editorMode === 'edit' ? 'edit' : 'new',
    postId: (_editorMode === 'edit' && _editCtx) ? _editCtx.id : ''
  };
}

function historyKindLabel(kind) {
  if (kind === DraftHistory.KINDS.MANUAL) return '手动';
  if (kind === DraftHistory.KINDS.AUTO) return '自动';
  if (kind === DraftHistory.KINDS.BACKUP) return '恢复前备份';
  return '历史';
}

function formatHistoryTime(ms) {
  var d = new Date(ms);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function updateHistoryBadge(n) {
  var el = document.getElementById('editorHistoryCount');
  if (el) el.textContent = String(n == null ? 0 : n);
}

function setHistoryNotice(msg) {
  var el = document.getElementById('editorHistoryNotice');
  if (!el) return;
  if (msg) { el.textContent = msg; el.removeAttribute('hidden'); }
  else { el.textContent = ''; el.setAttribute('hidden', ''); }
}

function historyPreviewText(rec) {
  var t = String(rec.content || '').replace(/[#*`>\-\[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > DraftHistory.PREVIEW_CHARS) t = t.slice(0, DraftHistory.PREVIEW_CHARS) + '…';
  return t || '（正文为空）';
}

// 历史模块初始化：失败只提示，不影响草稿
function setupDraftHistory() {
  var sc = historyScope();
  DraftHistory.configure(sc);
  DraftHistory.init().then(function (info) {
    _historyUi.loaded = true;
    updateHistoryBadge(info.count || 0);
    if (info.degraded) {
      setHistoryNotice('\u26A0\uFE0F 历史版本已降级：' + (info.reason || 'IndexedDB 不可用') +
        '\u3002草稿仍会正常保存，但历史只存在于当前标签页。');
    }
  });
}

function renderHistoryList() {
  var listEl = document.getElementById('editorHistoryList');
  if (!listEl) return;
  var rows = _historyUi.records;
  updateHistoryBadge(rows.length);
  if (!rows.length) {
    listEl.innerHTML = '<li class="editor-history-empty">\u8FD8\u6CA1\u6709\u5386\u53F2\u7248\u672C\u3002' +
      '\u70B9\u300C\u4FDD\u5B58\u5386\u53F2\u7248\u672C\u300D\u624B\u52A8\u5B58\u4E00\u4EFD\uFF0C' +
      '\u7F16\u8F91\u65F6\u4E5F\u4F1A\u6BCF 5 \u5206\u949F\u81EA\u52A8\u4FDD\u5B58\u4E00\u4EFD\u3002</li>';
    return;
  }
  listEl.innerHTML = rows.map(function (r) {
    return '<li class="editor-history-item' + (r.id === _historyUi.selectedId ? ' active' : '') +
      '" data-hist-id="' + escapeHtml(r.id) + '">' +
      '<div class="editor-history-row">' +
      '  <span class="editor-history-time">' + escapeHtml(formatHistoryTime(r.savedAt)) + '</span>' +
      '  <span class="editor-history-kind kind-' + escapeHtml(r.kind) + '">' + historyKindLabel(r.kind) + '</span>' +
      '  <span class="editor-history-chars">' + (r.chars || 0) + ' \u5B57</span>' +
      '</div>' +
      '<div class="editor-history-title">' + escapeHtml(r.title || '\uFF08\u65E0\u6807\u9898\uFF09') + '</div>' +
      '<div class="editor-history-snippet">' + escapeHtml(historyPreviewText(r)) + '</div>' +
      '<div class="editor-history-btns">' +
      '  <button type="button" class="editor-btn editor-btn-ghost" data-hist="preview" data-id="' + escapeHtml(r.id) + '">\u9884\u89C8</button>' +
      '  <button type="button" class="editor-btn editor-btn-ghost" data-hist="delete" data-id="' + escapeHtml(r.id) + '">\u5220\u9664</button>' +
      '</div>' +
      '</li>';
  }).join('');
}

function refreshHistoryList(selectId) {
  return DraftHistory.list().then(function (rows) {
    _historyUi.records = rows || [];
    if (selectId) _historyUi.selectedId = selectId;
    renderHistoryList();
    return _historyUi.records;
  });
}

window.toggleHistoryPanel = function (show) {
  var panel = document.getElementById('editorHistoryPanel');
  if (!panel) return;
  var next = (show == null) ? panel.hasAttribute('hidden') : !!show;
  if (!next) {
    panel.setAttribute('hidden', '');
    closeHistoryPreview();
    return;
  }
  panel.removeAttribute('hidden');
  refreshHistoryList();
};

function closeHistoryPreview() {
  var box = document.getElementById('editorHistoryPreview');
  if (box) box.setAttribute('hidden', '');
  _historyUi.pendingRestore = null;
  var confirmBox = document.getElementById('editorHistoryConfirm');
  if (confirmBox) confirmBox.setAttribute('hidden', '');
}

window.saveHistoryVersion = function () {
  var state = readEditorForm() || _draftState;
  if (!state) {
    showEditorStatus('\u26A0\uFE0F 没有可保存的内容', 'error');
    return false;
  }
  DraftHistory.snapshot(DraftHistory.KINDS.MANUAL, state).then(function (r) {
    if (!r.ok) {
      showEditorStatus('\u26A0\uFE0F 历史版本保存失败：' + escapeHtml(r.error || '未知错误') +
        '\uFF08\u5F53\u524D\u8349\u7A3F\u672A\u53D7\u5F71\u54CD\uFF09', 'error');
      return;
    }
    if (r.saved) {
      showEditorStatus('\u{1F5C2}\uFE0F 已保存历史版本（' + historyKindLabel(DraftHistory.KINDS.MANUAL) +
        '\uFF0C\u5171 ' + r.count + ' \u4E2A\uFF09', 'success');
    } else {
      showEditorStatus('\u2139\uFE0F 内容与已有历史版本相同，未重复保存', 'loading');
    }
    refreshHistoryList();
  });
  return true;
};

function previewHistoryRecord(rec) {
  if (!rec) return;
  _historyUi.selectedId = rec.id;
  _historyUi.pendingRestore = rec;
  renderHistoryList();

  var box = document.getElementById('editorHistoryPreview');
  var titleEl = document.getElementById('editorHistoryPreviewTitle');
  var bodyEl = document.getElementById('editorHistoryBody');
  var diffEl = document.getElementById('editorHistoryDiff');
  if (!box || !bodyEl) return;

  var cur = readEditorForm() || _draftState || {};
  var d = DraftHistory.diff(rec, cur);

  if (titleEl) {
    titleEl.textContent = formatHistoryTime(rec.savedAt) + ' · ' + historyKindLabel(rec.kind) +
      (rec.title ? ' · ' + rec.title : '');
  }
  if (diffEl) diffEl.textContent = (typeof d.summary === 'string') ? d.summary : '';
  // 历史正文同样走 marked → DOMPurify，绝不相信存档里的任何 HTML
  bodyEl.innerHTML = renderMarkdown(rec.content || '');
  box.removeAttribute('hidden');

  var confirmBox = document.getElementById('editorHistoryConfirm');
  if (confirmBox) confirmBox.setAttribute('hidden', '');
}

function requestRestoreHistory() {
  if (!_historyUi.pendingRestore) return;
  var confirmBox = document.getElementById('editorHistoryConfirm');
  if (confirmBox) confirmBox.removeAttribute('hidden');
}

function applyHistoryRecord(rec) {
  var set = function (id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val == null ? '' : val;
  };
  set('editorTitle', rec.title);
  set('editorTags', (rec.tags || []).join(', '));
  set('editorExcerpt', rec.excerpt);
  set('editorContent', rec.content);
  set('editorDate', rec.date);        // 新增模式没有日期输入框 → set 是空操作

  // 编辑模式下 _editCtx（原文章快照）保持不变：导出的更新稿仍基于仓库里的原版本
  updateEditorPreview();
  updateEditorStats();
  var saved = flushDraft(true);
  setDraftStat('saved');
  showEditorStatus('\u267B\uFE0F 已恢复历史版本（' + escapeHtml(formatHistoryTime(rec.savedAt)) +
    '\uFF09\u3002\u8FD9\u53EA\u662F\u7F16\u8F91\u5668\u5185\u5BB9\uFF0C' +
    (saved ? '\u5DF2\u5199\u5165\u672C\u5730\u8349\u7A3F\uFF1B' : '\u8349\u7A3F\u5199\u5165\u5931\u8D25\uFF1B') +
    '\u5C1A\u672A\u5BFC\u51FA\u3001\u5C1A\u672A\u53D1\u5E03\u3002', saved ? 'success' : 'error');
  return saved;
}

function confirmRestoreHistory() {
  var rec = _historyUi.pendingRestore;
  if (!rec) return Promise.resolve(false);
  var current = readEditorForm() || _draftState || {};

  // 关键：先给"当前内容"存一份安全快照；存不下来就绝不覆盖
  return DraftHistory.snapshot(DraftHistory.KINDS.BACKUP, current).then(function (r) {
    if (!r.ok) {
      showEditorStatus('\u274C \u65E0\u6CD5\u4E3A\u5F53\u524D\u5185\u5BB9\u4FDD\u5B58\u5B89\u5168\u5FEB\u7167\uFF08' +
        escapeHtml(r.error || '\u672A\u77E5\u539F\u56E0') + '\uFF09\uFF0C\u5DF2\u53D6\u6D88\u6062\u590D\u3002' +
        '\u5F53\u524D\u8349\u7A3F\u672A\u88AB\u6539\u52A8\u3002', 'error');
      return false;
    }
    var ok = applyHistoryRecord(rec);
    closeHistoryPreview();
    refreshHistoryList();
    return ok;
  });
}

function deleteHistoryRecord(id) {
  return DraftHistory.remove(id).then(function (r) {
    if (!r.ok) {
      showEditorStatus('\u26A0\uFE0F ' + escapeHtml(r.error || '删除失败'), 'error');
      return false;
    }
    if (_historyUi.selectedId === id) closeHistoryPreview();
    return refreshHistoryList().then(function () { return true; });
  });
}

function clearHistoryRecords() {
  return DraftHistory.clear().then(function (r) {
    if (!r.ok) {
      showEditorStatus('\u26A0\uFE0F ' + escapeHtml(r.error || '清理失败'), 'error');
      return false;
    }
    closeHistoryPreview();
    return refreshHistoryList().then(function () {
      showEditorStatus('\u{1F9F9} 已清理该文章的历史版本', 'success');
      return true;
    });
  });
}

function setupHistoryPanelHandlers() {
  var panel = document.getElementById('editorHistoryPanel');
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  panel.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-hist]') : null;
    if (!el) return;
    var action = el.getAttribute('data-hist');
    var id = el.getAttribute('data-id');
    if (action === 'close') { toggleHistoryPanel(false); return; }
    if (action === 'close-preview') { closeHistoryPreview(); return; }
    if (action === 'snapshot') { window.saveHistoryVersion(); return; }
    if (action === 'clear') { clearHistoryRecords(); return; }
    if (action === 'refresh') { refreshHistoryList(); return; }
    if (action === 'preview' && id) {
      var rec = _historyUi.records.filter(function (r) { return r.id === id; })[0];
      if (rec) previewHistoryRecord(rec);
      return;
    }
    if (action === 'delete' && id) { deleteHistoryRecord(id); return; }
    if (action === 'restore') { requestRestoreHistory(); return; }
    if (action === 'confirm-restore') { confirmRestoreHistory(); return; }
    if (action === 'cancel-restore') {
      var box = document.getElementById('editorHistoryConfirm');
      if (box) box.setAttribute('hidden', '');
    }
  });
}

// 多标签页：别的标签页写了同一份草稿时只做提示，绝不自动覆盖当前编辑
function setupCrossTabDraftWatch() {
  if (window.__draftCrossTabBound) return;
  window.__draftCrossTabBound = true;
  window.addEventListener('storage', function (e) {
    if (!e || !e.key) return;
    if (e.key !== 'blog_draft' && e.key.indexOf(EDIT_DRAFT_PREFIX) !== 0) return;
    var cur = draftStorageKey();
    if (cur && e.key !== cur) return;
    if (!e.newValue || e.newValue === e.oldValue) return;
    setHistoryNotice('\u26A0\uFE0F 另一个标签页刚保存了同一份草稿；本页内容没有被自动覆盖。' +
      '\u5982\u9700\u540C\u6B65\uFF0C\u8BF7\u5148\u5BFC\u51FA\u5F53\u524D\u5185\u5BB9\u3002');
  });
}

// --- Auto-save draft on input ---
// 标题/标签/摘要/正文共用同一套防抖保存策略，避免只改标题时草稿不更新
function setupEditorListeners() {
  ['editorTitle', 'editorTags', 'editorExcerpt', 'editorContent'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || el.dataset.draftBound === '1') return;
    el.dataset.draftBound = '1';
    el.addEventListener('input', function() {
      if (id === 'editorContent') {
        updateEditorPreview();
        updateEditorStats();
      }
      setDraftStat('dirty');
      scheduleDraftSave();
    });
  });

  setupEditorToolbar();
  setupEditorShortcuts();
  setupEditorViewToggle();
  setupEditorImagePanel();
  setupHistoryPanelHandlers();     // Batch 8B-3：历史版本面板（恢复/删除/清理）
  setupDraftHistory();             // 初始化 IndexedDB（失败只降级，不影响草稿）
  setupCrossTabDraftWatch();

  // Initial preview + stats（草稿状态按磁盘上的实际情况显示，不新增状态）
  updateEditorPreview();
  updateEditorStats();
  var hasDraft = false;
  try { hasDraft = !!localStorage.getItem(draftStorageKey()); } catch (e) {}
  setDraftStat(hasDraft ? 'restored' : 'empty');
}

// --- 导出文章（Batch 8A）---
// 编辑器是**纯本地**的：不读 Token、不调用 GitHub API、不写任何分支。
// 导出物是一份 UTF-8 JSON，交给 scripts/import_post.py 在本地校验并落盘，
// 之后由人手动提交、手动开 PR（见 BATCH8A_REPORT.md「手动 PR 操作说明」）。
// 目的：彻底消灭“网页一键直写仓库”这条会把历史文章一起覆盖的高风险路径。
function todayLocalISO() {
  var d = new Date();
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd);
}

function collectEditorInput() {
  var title = document.getElementById('editorTitle').value.trim();
  var tagsStr = document.getElementById('editorTags').value.trim();
  var excerpt = document.getElementById('editorExcerpt').value.trim();
  var content = document.getElementById('editorContent').value.trim();
  var tags = tagsStr.split(/[,，]/).map(function(t) { return t.trim(); }).filter(function(t) { return t; });
  var id = generatePostId(title);
  return {
    id: id,
    title: title,
    // 用本机时区的日期：toISOString() 是 UTC，东八区早上 8 点前会写成"昨天"
    date: todayLocalISO(),
    tags: tags.length ? tags : ['未分类'],
    excerpt: excerpt || content.replace(/[#*`>\-\[\]]/g, '').slice(0, 120) + '...',
    content: content
  };
}

// 导出前的本地校验：明显的数据错误不产出文件（真正的强校验在导入器里，不可绕过）
function validateNewPost(post) {
  if (!post.title) return '标题不能为空';
  if (!post.content) return '正文不能为空';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(post.id || '')) return '生成的 id 非法（只允许小写字母/数字/连字符）';
  if (post.id.length > 64) return '生成的 id 过长（最多 64 字符）';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date || '')) return '日期格式非法';
  if (!Array.isArray(post.tags) || !post.tags.length) return '至少需要一个标签';
  var exists = getAllPosts().some(function(p) { return p.id === post.id; });
  if (exists) return 'id 冲突：已存在同 id 的文章（' + post.id + '），请换一个标题';
  return '';
}

// 导出物：纯数据，不联网、不执行任何远端脚本
// 字段顺序固定为 id/title/date/tags/excerpt/content，与导入器的逐字段校验一一对应
function buildExportPayload() {
  var post = collectEditorInput();
  var problem = validateNewPost(post);
  if (problem) return { ok: false, error: problem };

  var payload = {
    id: post.id,
    title: post.title,
    date: post.date,
    tags: post.tags,
    excerpt: post.excerpt,
    content: post.content
  };
  return {
    ok: true,
    post: payload,
    filename: post.id + '.json',
    // 不写 BOM：BOM 会让部分工具（含 Python json）直接解析失败；UTF-8 本身就够表达中文
    text: JSON.stringify(payload, null, 2) + '\n'
  };
}
window.buildExportPayload = buildExportPayload;

// --- 编辑模式：更新稿（Batch 8B-1）---
// 更新稿 = 修改后的完整文章 + 原文快照（original）。快照用于让导入器确认
// "这份更新稿基于仓库里的哪一版"：Python 侧把快照与磁盘上的当前文章逐字段比对，
// 不一致就拒绝（不会把旧版本覆盖到别人的新修改上）。
// 规范化规则与 scripts/import_post.py 保持一致：只统一换行为 LF，**不**裁剪空白。
function normalizeBodyText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function readEditForm() {
  var title = document.getElementById('editorTitle').value.trim();
  var tagsStr = document.getElementById('editorTags').value.trim();
  var excerpt = document.getElementById('editorExcerpt').value.trim();
  var content = document.getElementById('editorContent').value.trim();
  var dateEl = document.getElementById('editorDate');
  var date = (dateEl && dateEl.value ? dateEl.value : '').trim();
  var tags = tagsStr.split(/[,，]/).map(function (t) { return t.trim(); })
    .filter(function (t) { return t; });
  return {
    id: (_editCtx && _editCtx.id) || '',
    title: title,
    date: date,
    tags: tags,
    excerpt: excerpt,
    content: content
  };
}

function isRealDate(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return false;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

function validateUpdatePost(cur) {
  if (_editorMode !== 'edit' || !_editCtx) return '当前不是编辑模式';
  if (!cur.title) return '标题不能为空';
  if (!cur.content) return '正文不能为空';
  if (!isRealDate(cur.date)) return '日期必须是合法的 YYYY-MM-DD';
  if (!cur.tags.length) return '至少需要一个标签';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cur.id)) return 'id 非法（只允许小写字母/数字/连字符）';
  var exists = getAllPosts().some(function (p) { return p.id === cur.id; });
  if (!exists) return '找不到 id 为 ' + cur.id + ' 的文章（更新稿不允许当作新增）';
  return '';
}

function editHasChanges(cur) {
  if (!_editCtx) return false;
  var o = _editCtx;
  if (cur.title !== String(o.title || '').trim()) return true;
  if (cur.date !== String(o.date || '').trim()) return true;
  if (cur.excerpt !== String(o.excerpt || '').trim()) return true;
  if (cur.content !== normalizeBodyText(o.content).trim()) return true;
  return cur.tags.join('\u0000') !== (o.tags || []).join('\u0000');
}

// 字段顺序固定 → 同样的修改重复导出，得到的字节完全一致（可 diff、可复现）
function buildUpdatePayload() {
  if (_editorMode !== 'edit' || !_editCtx) return { ok: false, error: '当前不是编辑模式' };

  var cur = readEditForm();
  var problem = validateUpdatePost(cur);
  if (problem) return { ok: false, error: problem };
  if (!editHasChanges(cur)) {
    return { ok: false, unchanged: true, error: '内容没有变化（与线上版本一致），无需导出更新稿' };
  }

  var payload = {
    op: 'update',
    id: _editCtx.id,
    original: {
      title: _editCtx.title,
      date: _editCtx.date,
      tags: (_editCtx.tags || []).slice(),
      excerpt: _editCtx.excerpt || '',
      content: _editCtx.content
    },
    post: {
      id: _editCtx.id,
      title: cur.title,
      date: cur.date,
      tags: cur.tags,
      excerpt: cur.excerpt,
      content: cur.content
    }
  };
  return {
    ok: true,
    post: payload.post,
    payload: payload,
    filename: _editCtx.id + '.update.json',
    text: JSON.stringify(payload, null, 2) + '\n'
  };
}
window.buildUpdatePayload = buildUpdatePayload;

// 真正触发下载。测试通过替换 window.__downloadText 拿到内容，避免依赖真实浏览器下载行为。
function downloadText(text, filename) {
  var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  var url = (typeof URL !== 'undefined' && URL.createObjectURL)
    ? URL.createObjectURL(blob)
    : 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立即 revoke 会让部分浏览器的下载中断，推迟到下一个事件循环
  if (url.indexOf('blob:') === 0 && typeof URL.revokeObjectURL === 'function') {
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 0);
  }
}
window.__downloadText = downloadText;

window.exportPost = function() {
  var mode = _editorMode;
  var payload = (mode === 'edit') ? buildUpdatePayload() : buildExportPayload();

  if (!payload.ok) {
    // 校验不通过：不产出文件，但草稿必须留下
    if (payload.unchanged) {
      showEditorStatus('\u26A0\uFE0F ' + escapeHtml(payload.error) + '\uFF08\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF09', 'loading');
    } else {
      showEditorStatus('\u274C \u65E0\u6CD5\u5BFC\u51FA\uFF1A' + escapeHtml(payload.error) + '\uFF08\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF09', 'error');
    }
    flushDraft(true);
    return false;
  }

  try {
    window.__downloadText(payload.text, payload.filename);
  } catch (err) {
    var failMsg = (err && err.message) || String(err);
    showEditorStatus('\u274C \u5BFC\u51FA\u5931\u8D25: ' + escapeHtml(failMsg)
      + '\uFF08\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF0C\u53EF\u91CD\u8BD5\uFF09', 'error');
    flushDraft(true);
    return false;
  }

  // 导出成功 ≠ 文章已上线：草稿继续保留，方便接着改、再导出
  flushDraft(true);
  if (mode === 'edit') {
    showEditorStatus('\u2705 \u5DF2\u5BFC\u51FA\u66F4\u65B0\u7A3F <b>' + escapeHtml(payload.filename)
      + '</b>\uFF08\u672C\u5730\u6587\u4EF6\uFF0C<b>\u7AD9\u70B9\u5C1A\u672A\u66F4\u65B0</b>\uFF09\u3002\u4E0B\u4E00\u6B65\uFF1A'
      + '<code>python scripts/import_post.py --file ' + escapeHtml(payload.filename) + ' --mode update --dry-run</code>'
      + '\u68C0\u67E5\uFF0C\u518D <code>--apply</code>\uFF0C\u6700\u540E\u624B\u52A8\u63D0\u4EA4 PR\u3002', 'success');
  } else {
    showEditorStatus('\u2705 \u5DF2\u5BFC\u51FA <b>' + escapeHtml(payload.filename)
      + '</b>\uFF08\u672C\u5730\u6587\u4EF6\uFF0C<b>\u5C1A\u672A\u4E0A\u7EBF</b>\uFF09\u3002\u4E0B\u4E00\u6B65\uFF1A\u5728\u4ED3\u5E93\u6839\u76EE\u5F55\u8FD0\u884C '
      + '<code>python scripts/import_post.py --file ' + escapeHtml(payload.filename) + ' --dry-run</code>'
      + '\u68C0\u67E5\uFF0C\u518D <code>--apply</code>\uFF0C\u6700\u540E\u624B\u52A8\u63D0\u4EA4 PR\u3002', 'success');
  }
  return true;
};

// ============================================
// Router
// ============================================
async function router() {
  const token = ++_routeToken;
  const hash = location.hash.slice(1) || '/';
  const app = document.getElementById('app');
  const searchBar = document.getElementById('searchBar');
  // 深链命中时要"落点即到位"，绝不能再用 scrollTo(0,0)：
  // CSS 的 scroll-behavior:smooth 会让回顶动画在随后的 scrollIntoView 之后
  // 继续跑到 0，把目标又甩出视口（B7B2 已复现）。
  let hasDeepLinkTarget = false;

  // 离开编辑器：把待保存内容立即落盘（只 clearTimeout 会丢内容）
  // Batch 8B-1：编辑模式与新增模式各有草稿键，切换文章 / 退出编辑同样要先落盘
  if (isEditorRoute(_currentRoute) && _currentRoute !== hash) {
    flushDraft(true);
  }
  _currentRoute = hash;

  // 搜索状态契约（Batch 7B-2，见 BATCH7B2_REPORT.md）：
  //   1) 浏览器前进/后退 → 该历史条目记过关键词就恢复（后退能拿回原搜索上下文）；
  //   2) 主动导航（点首页/导航、改地址栏）→ 新条目没有记录，关键词清空，避免旧结果残留；
  //   3) 冻结 S01 的"回首页必须清空查询/结果"由第 2 条满足（它是一次新的导航）。
  const savedSearch = readEntrySearch(hash);
  if (savedSearch != null) searchQuery = savedSearch;
  else if (hash === '/') searchQuery = '';

  // 上一个页面遗留的目录/进度条
  removeReadingTools();

  // Close mobile menu（路由切换必定收起，aria 状态同步复位）
  setMobileMenu(false);

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
      // 后退恢复的搜索结果可能还缺跨区数据（课程/论文/正文语料）：补齐后再重绘一次
      if (searchQuery.trim()) applyGlobalSearch(searchQuery);
    } else if (hash.startsWith('/post/')) {
      const id = hash.slice('/post/'.length);
      const post = getAllPosts().find(p => p.id === id);
      if (!post || cachedPostContent(post) != null) {
        app.innerHTML = renderPost(id);
      } else {
        // 正文按需加载：先给加载态，到齐后再渲染；期间路由若已切走则丢弃结果
        app.innerHTML = renderPostLoading(post);
        let bodyFailed = false;
        try {
          await loadPostBody(id);
        } catch (err) {
          bodyFailed = true;
          console.warn('文章正文加载失败:', err && err.message);
        }
        if (token !== _routeToken) return;    // 快速切换路由：不要显示上一篇文章
        app.innerHTML = bodyFailed ? renderPostError(id) : renderPost(id);
      }
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
          app.innerHTML = renderLoadError('课程笔记', 'courses');
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
          app.innerHTML = renderLoadError('课程资料', 'courses');
          return;
        }
      }
      const notesReady = dataReady('notes');
      app.innerHTML = renderCourseDetail(id);
      if (!notesReady) {
        loadData('notes').then(function () {
          if (token !== _routeToken) return;                 // 路由已切换：不覆盖新页面
          if ((location.hash.slice(1) || '/') !== hash) return;
          app.innerHTML = renderCourseDetail(id);
          enhanceCodeBlocks(app);
          highlightIn(app);
          buildReadingTools();
          // 笔记映射（NOTE_PAGES）此时才到位：canonical / og:url 必须跟着重算，
          // 否则首访课程页整次会话都指向站点根（见 Batch 7A-02）。
          updateMetaForRoute(hash);
        });
      }
    } else if (hash === PAPERS_ROUTE || hash.indexOf(PAPERS_ROUTE + '?') === 0) {
      // /papers 与深链共用同一条渲染路径：深链只是多了"定位目标"这一步
      const deep = parsePapersRoute(hash);
      const wantTarget = deep && deep.target ? deep.target : '';
      let resolved = null;
      if (!dataReady('papers')) {
        app.innerHTML = renderLoading('论文与学习资料');
        await loadData('papers');
        if (token !== _routeToken) return;
        if (!dataReady('papers')) {
          app.innerHTML = renderLoadError('论文与学习资料', 'papers');
          return;
        }
      }
      if (wantTarget) {
        resolved = resolvePapersTarget(deep);
        // 深链进入时清掉页内筛选，否则目标可能被过滤器藏起来（P02 场景）
        paperTab = (resolved ? resolved.kind : (deep.kind || 'paper')) === 'material' ? 'materials' : 'papers';
        paperSearchQuery = '';
        activePaperCategory = null;
      }
      app.innerHTML = renderPapers();
      if (wantTarget && !resolved) {
        app.insertAdjacentHTML('afterbegin', deeplinkMissingHtml(deep.kind));
      }
      if (resolved) {
        hasDeepLinkTarget = true;
        // 先同步落位（首帧就在目标处），首帧之后再校正一次：
        // 字体/图片在首帧后才撑开布局，晚一步的校正能避免目标被挤出去。
        locatePapersTarget(app, resolved.kind, resolved.item, token);
        scheduleAfterPaint(function () {
          locatePapersTarget(app, resolved.kind, resolved.item, token);
        }, token, app);
      }
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
          app.innerHTML = renderLoadError('代码与文件库', 'codefiles');
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
          app.innerHTML = renderLoadError('代码与文件库', 'codefiles');
          return;
        }
      }
      app.innerHTML = renderCodeDetail(id);
    } else if (hash === '/links') {
      app.innerHTML = renderLinks();
    } else if (hash === '/editor') {
      app.innerHTML = renderEditor(null);
      setupEditorListeners();
    } else if (hash.indexOf('/editor/') === 0) {
      // 编辑已有文章：#/editor/<id>（可深链、可用浏览器前进后退）
      const editId = decodeURIComponent(hash.slice('/editor/'.length));
      const prepared = await prepareEditorEdit(editId);
      if (token !== _routeToken) return;        // 快速切换路由：丢弃过期结果
      if (!prepared.ok) {
        app.innerHTML = renderEditorBlocked(editId, prepared);
      } else {
        app.innerHTML = renderEditor(editId);
        setupEditorListeners();
      }
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

  // 标题/描述同步更新（便宜）；代码工具条/目录/高亮都属于"非首屏必需"，
  // 延后到首帧之后执行：先让第一段文字画出来，再做这些同步 DOM 重建。
  updateMetaForRoute(hash);
  // 记录本条历史条目对应的关键词：后退回来时据此恢复搜索上下文
  rememberEntryState(hash);
  perfMark('art:html-end');
  scheduleAfterPaint(function () {
    perfMark('art:post-start');
    enhanceCodeBlocks(app);
    buildReadingTools();
    highlightIn(app);
    perfMark('art:post-end');
  }, token, app);

  // 普通导航回顶；深链命中时滚动位置由 locatePapersTarget 决定，不能再回顶
  if (!hasDeepLinkTarget) window.scrollTo(0, 0);
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

// 当前 hash 去掉 '#' 后的路径（和 router 里的 hash 完全同构）
function routeHash() {
  return location.hash.slice(1) || '/';
}

// 读取本条历史条目记录的关键词；没有记录返回 null（= 新导航，不是后退）
// 用 history.state 而不是 popstate 事件：不依赖 popstate/hashchange 的触发顺序，
// jsdom 等环境也不会因为 replaceState 抛错而中断路由。
function readEntrySearch(hash) {
  try {
    const st = history.state;
    if (st && typeof st === 'object' && st.blogHash === hash && typeof st.search === 'string') {
      return st.search;
    }
  } catch (e) { /* 隐私模式 / 老浏览器：当作新导航 */ }
  return null;
}

function rememberEntryState(hash) {
  try {
    history.replaceState({ blogHash: hash, search: searchQuery }, '');
  } catch (e) { /* 仅影响后退恢复体验，不影响当前页面 */ }
}

function applyGlobalSearch(val) {
  searchQuery = val;
  if (!isHomeRoute()) return;
  document.getElementById('app').innerHTML = renderHome();
  rememberEntryState(routeHash());

  const target = val.trim();
  if (!target) return;
  const needData = !dataReady('courses') || !dataReady('papers') || !dataReady('notes');
  const needBodies = !_searchDocsReady;
  if (!needData && !needBodies) return;
  const token = _routeToken;   // 异步回调回来时路由若已切换，直接丢弃

  // 正文语料加载失败时降级为"仅标题/摘要/标签命中"，不阻断搜索
  Promise.all([
    loadData('courses'), loadData('papers'), loadData('notes'),
    ensureSearchDocs().catch(function () { return null; })
  ]).then(function () {
    if (token !== _routeToken) return;          // 路由已切换过：旧回调一律丢弃
    if (!isHomeRoute()) return;                 // 已经离开首页：不能覆盖当前路由
    if (searchQuery.trim() !== target) return;  // 输入已变化：丢弃过时的异步结果
    const box = document.getElementById('app');
    if (!box || !box.isConnected) return;
    box.innerHTML = renderHome();
    // 重绘会换掉输入框，必须重新绑定，否则后续输入不再生效
    bindLiveSearch('searchInput', applyGlobalSearch, 180);
    const input = document.getElementById('searchInput');
    if (input) { input.value = searchQuery; input.focus(); }
  });
}

bindLiveSearch('searchInput', applyGlobalSearch);

// 用户一旦聚焦搜索框（点/按 /），就把搜索需要的数据全部预热：
// 首个搜索的耗时几乎全在"课程/论文/笔记 157KB + 正文语料 107KB"上，
// 而"点开搜索框"到"真正敲字"通常有几百毫秒，用来并行拉取正好。
// 失败不影响任何功能（下次输入仍会重试）。
document.addEventListener('focusin', function (e) {
  if (!e.target || e.target.id !== 'searchInput') return;
  loadData('courses');
  loadData('papers');
  loadData('notes');
  ensureSearchDocs().catch(function () { return null; });
});

// 正文加载失败后的"重新加载"：事件委托，避免把 id 拼进内联事件
document.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-retry-post]') : null;
  if (!btn) return;
  e.preventDefault();
  const id = btn.getAttribute('data-retry-post');
  delete _postBodyPromises[id];
  router();
});

// 按需数据加载失败后的"原地重试"：清掉失败缓存后重跑当前路由，
// 深链会因此重新走到"加载 → 定位"的完整流程（不必整页刷新）。
document.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-retry-data]') : null;
  if (!btn) return;
  e.preventDefault();
  const key = btn.getAttribute('data-retry-data');
  if (key) delete _dataPromises[key];
  router();
});

// 卡片 / 搜索结果的原生跳转统一走 data-href 事件委托：
// 不把 URL 拼进内联 onclick，目标键里的引号、&、中文都不会变成代码。
document.addEventListener('click', function (e) {
  const el = e.target && e.target.closest ? e.target.closest('[data-href]') : null;
  if (!el) return;
  const tag = el.tagName;
  // 带 href 的 <a> 用浏览器原生跳转（可复制、可新窗口打开）
  if ((tag === 'A' && el.hasAttribute('href')) || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  const href = el.getAttribute('data-href');
  if (!href) return;
  e.preventDefault();
  if (location.hash === href) return;
  location.hash = href;
});

// Mobile menu toggle
// 与静态笔记页共用同一套约定：.nav.open + .menu-toggle.active + aria-expanded
function setMobileMenu(open, focusBtn) {
  const nav = document.querySelector('.nav');
  const btn = document.getElementById('menuToggle');
  if (!nav || !btn) return;
  nav.classList.toggle('open', open);
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open && focusBtn) btn.focus();
}

document.getElementById('menuToggle').addEventListener('click', function () {
  const nav = document.querySelector('.nav');
  setMobileMenu(!(nav && nav.classList.contains('open')));
});

// Esc 关闭菜单（只在菜单展开时生效，不影响搜索框已有的 Esc 行为）
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  const nav = document.querySelector('.nav');
  if (nav && nav.classList.contains('open')) setMobileMenu(false, true);
});

// 跨断点复位：≥769px 导航本就内联常显，残留的 .open 会让回到窄屏时"自动展开"、
// aria-expanded 与可见性不一致（静态笔记页用同一套处理，两端行为保持一致）
const mobileNavQuery = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;
function resetMenuOnDesktop() {
  if (mobileNavQuery && mobileNavQuery.matches) return;
  const nav = document.querySelector('.nav');
  if (nav && nav.classList.contains('open')) setMobileMenu(false);
}
if (mobileNavQuery) {
  if (mobileNavQuery.addEventListener) mobileNavQuery.addEventListener('change', resetMenuOnDesktop);
  else if (mobileNavQuery.addListener) mobileNavQuery.addListener(resetMenuOnDesktop);
}
window.addEventListener('resize', resetMenuOnDesktop);

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
  if (isEditorRoute(_currentRoute)) flushDraft(true);
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
