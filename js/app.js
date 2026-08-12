/**
 * Blog App - Router & Rendering Logic
 */

// ============================================
// Config
// ============================================
try {
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: function (code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (e) {}
      }
      if (typeof hljs !== 'undefined') {
        try { return hljs.highlightAuto(code).value; } catch (e) {}
      }
      return code;
    }
  });
} catch (e) {
  console.warn('marked/hljs init failed:', e);
}

// ============================================
// State
// ============================================
let searchQuery = '';
let activeTag = null;
let activeCategory = null;
let courseSearchQuery = '';
let courseFileLimit = 50;
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

// File path cache — paths stored in JS, NOT in HTML attributes
// This prevents browsers from trying to resolve/load file URLs during rendering
var _filePathCache = [];

// Detect if running locally (file:// open only works on localhost)
var _isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';

// 文件以清单形式展示，不暴露、不打开本地路径（已移除 data-fidx 点击打开逻辑与路径弹窗）

// ============================================
// Utilities
// ============================================

// Merge built-in posts with user-published posts
function getAllPosts() {
  return (typeof USER_POSTS !== 'undefined' ? POSTS.concat(USER_POSTS) : POSTS);
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  return `${d.getFullYear()}年${months[d.getMonth()]}${d.getDate()}日`;
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
    result = result.filter(p => p.tags.includes(tag));
  }
  if (query) {
    const q = query.toLowerCase();
    result = result.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.excerpt.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q)) ||
      p.content.toLowerCase().includes(q)
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
    p.title.toLowerCase().includes(q) ||
    (p.excerpt || '').toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q)) ||
    p.content.toLowerCase().includes(q)
  );
  const courses = (typeof COURSES !== 'undefined') ? COURSES.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.category || '').toLowerCase().includes(q) ||
    (c.description || '').toLowerCase().includes(q)
  ) : [];
  const papers = (typeof PAPERS !== 'undefined') ? PAPERS.filter(p =>
    p.title.toLowerCase().includes(q) ||
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
      <article class="article-card" onclick="location.hash = '#/post/${post.id}'">
        <h2 class="article-card-title"><a href="#/post/${post.id}">${escapeHtml(post.title)}</a></h2>
        <p class="article-card-excerpt">${escapeHtml(getExcerpt(post))}</p>
        <div class="article-card-meta">
          <span class="meta-item">${formatDate(post.date)}</span>
          <div class="article-card-tags">${post.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>
      </article>`).join('') + `</div>`;
  }
  if (courses.length) {
    html += `<div class="search-section-title">📚 课程 (${courses.length})</div>`;
    html += courses.map(c => `
      <div class="search-course-item" onclick="location.hash='#/course/${encodeURIComponent(c.id)}'">
        <span class="search-item-icon">📚</span>
        <div class="search-item-main">
          <div class="search-item-title">${escapeHtml(c.name)}</div>
          <div class="search-item-sub">${escapeHtml(c.category)} · ${c.fileCount} 个文件</div>
        </div>
        <span class="search-item-meta">查看 →</span>
      </div>`).join('');
  }
  if (papers.length) {
    html += `<div class="search-section-title">📄 论文 (${papers.length})</div>`;
    html += papers.map(p => `
      <div class="search-paper-item" onclick="location.hash='#/papers'">
        <span class="search-item-icon">📄</span>
        <div class="search-item-main">
          <div class="search-item-title">${escapeHtml(p.title)}</div>
          <div class="search-item-sub">${escapeHtml(p.authors || '')}</div>
        </div>
        <span class="search-item-meta">查看 →</span>
      </div>`).join('');
  }
  if (materials.length) {
    html += `<div class="search-section-title">📎 学习资料 (${materials.length})</div>`;
    html += materials.map(m => `
      <div class="search-paper-item" onclick="location.hash='#/papers'">
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

  const html = marked.parse(post.content);

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
    <div class="giscus-wrap">
      <h3 class="giscus-wrap-title">💬 评论与讨论</h3>
      <div id="giscus-container"></div>
      ${GISCUS_CONFIG.enabled ? '' : '<div class="giscus-hint">评论基于 GitHub Discussions（免费）。启用方法：在 <code>js/app.js</code> 顶部的 <code>GISCUS_CONFIG</code> 中填入 <code>repoId</code> 和 <code>categoryId</code>（在 <a href="https://giscus.app" target="_blank" rel="noopener">giscus.app</a> 配置后获取），并把 <code>enabled</code> 改为 <code>true</code>。详见「关于」页说明。</div>'}
    </div>
  `;
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
          onclick="location.hash='#/tags/${encodeURIComponent(t.name)}'">
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

function renderCourses() {
  const totalFiles = COURSES.reduce((sum, c) => sum + c.fileCount, 0);
  const totalSize = COURSES.reduce((sum, c) => sum + c.totalSize, 0);

  // Stats bar
  let html = `
    <div class="courses-page">
      <h1 class="page-title">📚 课程资料库</h1>
      <p class="page-desc">本科到研究生的全部课程资料，按学科方向分类整理</p>
      <div class="courses-stats">
        <div class="stat-card">
          <div class="stat-value">${COURSES.length}</div>
          <div class="stat-label">门课程</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalFiles}</div>
          <div class="stat-label">个文件</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB</div>
          <div class="stat-label">总大小</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${Object.keys(COURSE_CATEGORIES).length}</div>
          <div class="stat-label">个分类</div>
        </div>
      </div>
  `;

  // Category filter
  const categoryOrder = ['机器人与自动化', '人工智能与机器学习', '信号与控制', '计算机科学', '电子与硬件', '数理基础', '设计', '其他课程'];
  html += '<div class="category-filter">';
  html += `<span class="category-chip ${!activeCategory ? 'active' : ''}" onclick="setCategory(null)">全部</span>`;
  for (const cat of categoryOrder) {
    if (COURSE_CATEGORIES[cat]) {
      html += `<span class="category-chip ${activeCategory === cat ? 'active' : ''}" onclick="setCategory('${cat}')">
        ${getCategoryIcon(cat)} ${cat}
        <span class="chip-count">${COURSE_CATEGORIES[cat].count}</span>
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
  let filtered = COURSES;
  if (activeCategory) {
    filtered = filtered.filter(c => c.category === activeCategory);
  }
  if (courseSearchQuery) {
    const q = courseSearchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.source.toLowerCase().includes(q) ||
      c.files.some(f => f.name.toLowerCase().includes(q))
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
      const courses = grouped[cat];
      html += `
        <div class="course-section">
          <h2 class="course-section-title">
            ${getCategoryIcon(cat)} ${cat}
            <span class="section-count">${courses.length} 门课程</span>
          </h2>
          <div class="course-grid">
      `;
      for (const course of courses) {
        const yearBadge = course.year ? `<span class="course-card-year">${course.year}</span>` : '';
        html += `
          <div class="course-card" onclick="location.hash='#/course/${encodeURIComponent(course.id)}'">
            <div class="course-card-header">
              <div class="course-card-title">${escapeHtml(course.name)}</div>
            </div>
            ${course.description ? `<div class="course-card-desc">${escapeHtml(course.description)}</div>` : ''}
            <div class="course-card-meta">
              <span class="meta-item">📁 ${course.fileCount} 个文件</span>
              <span class="meta-item">💾 ${course.totalSizeFormatted}</span>
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

  // Reset file path cache for this page
  _filePathCache = [];

  let html = `
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
          <span class="meta-item">📁 ${course.fileCount} 个文件</span>
          <span class="meta-item">💾 ${course.totalSizeFormatted}</span>
        </div>
      </div>
      ${course.description ? `<div class="course-description">${escapeHtml(course.description)}</div>` : ''}
      <div class="file-list">
        <div class="file-list-header">文件列表 (${course.files.length})</div>
        <div id="course-file-container">
  `;

  const visibleFiles = course.files.slice(0, courseFileLimit);
  for (let i = 0; i < visibleFiles.length; i++) {
    const file = visibleFiles[i];
    const typeClass = getFileTypeClass(file.type);
    html += `
      <div class="file-item">
        <span class="file-type-badge ${typeClass}">${escapeHtml(file.type)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-size">${file.sizeFormatted}</span>
      </div>
    `;
  }

  html += `</div>`;

  if (course.files.length > courseFileLimit) {
    html += `
      <div id="course-load-more" style="text-align: center; padding: 16px;">
        <button class="load-more-btn" onclick="loadMoreCourseFiles('${escapeHtml(courseId)}')">
          加载更多（剩余 ${course.files.length - courseFileLimit} 个文件）
        </button>
      </div>
    `;
  }

  html += `
      </div>
      <div style="margin-top: 20px; padding: 12px 16px; background: var(--color-bg); border-radius: var(--radius-sm); font-size: 0.82rem; color: var(--color-text-muted);">
        💡 文件保留在原始磁盘，未做任何复制，此处仅展示文件清单。
      </div>
    </div>
  `;

  return html;
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
      l.name.toLowerCase().includes(q) ||
      l.category.toLowerCase().includes(q) ||
      l.source.toLowerCase().includes(q) ||
      l.files.some(f => f.name.toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>没有找到匹配的代码库</p></div>`;
  } else {
    html += '<div class="course-grid">';
    for (const lib of filtered) {
      html += `
        <div class="course-card" onclick="location.hash='#/codelib/${encodeURIComponent(lib.id)}'">
          <div class="course-card-header">
            <div class="course-card-title">${escapeHtml(lib.name)}</div>
            <span class="course-card-source">${escapeHtml(lib.category)}</span>
          </div>
          <div class="course-card-meta">
            <span class="meta-item">📂 ${escapeHtml(lib.source)}</span>
          </div>
          <div class="course-card-meta">
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

  _filePathCache = [];

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
          <span class="meta-item">📍 ${escapeHtml(lib.source)}</span>
          <span class="meta-item">📁 ${lib.fileCount} 个文件</span>
          <span class="meta-item">💾 ${lib.totalSizeFormatted}</span>
        </div>
        ${lib.description ? `<div class="course-description">${escapeHtml(lib.description)}</div>` : ''}
        ${lib.guide ? `<div class="code-lib-guide"><div class="code-lib-guide-title">📖 代码库导读</div>${marked.parse(lib.guide)}</div>` : ''}
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
  _filePathCache = [];
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
      <span class="category-chip ${!activePaperCategory ? 'active' : ''}" onclick="setPaperCategory(null)">全部</span>
  `;

  for (const cat of categoryOrder) {
    if (PAPER_CATEGORIES[cat]) {
      html += `<span class="category-chip ${activePaperCategory === cat ? 'active' : ''}" onclick="setPaperCategory('${cat}')">
        ${getPaperCategoryIcon(cat)} ${cat}
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
      p.title.toLowerCase().includes(q) ||
      p.authors.toLowerCase().includes(q) ||
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
        <p>📚 <a href="#/courses">课程资料库</a> 收录了本科到研究生阶段的全部课程资料，共 45 门课程、2483 个文件，按 8 个学科方向分类整理。</p>
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
  var token = localStorage.getItem('gh_token') || '';
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
    '        <p>3. \u590D\u5236 token \u7C98\u8D34\u5230\u4E0B\u65B9\u8F93\u5165\u6846\uFF08\u4EC5\u5B58\u5728\u6D4F\u89C8\u5668 localStorage\uFF0C\u4E0D\u4F1A\u4E0A\u4F20\u670D\u52A1\u5668\uFF09</p>' +
    '      </div>' +
    '      <label class="editor-label">GitHub Token</label>' +
    '      <input type="password" id="ghToken" class="editor-input" placeholder="github_pat_..." value="' + escapeHtml(token) + '">' +
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
window.saveDraft = function() {
  var draft = {
    title: document.getElementById('editorTitle').value,
    tags: document.getElementById('editorTags').value,
    excerpt: document.getElementById('editorExcerpt').value,
    content: document.getElementById('editorContent').value,
    savedAt: new Date().toISOString()
  };
  localStorage.setItem('blog_draft', JSON.stringify(draft));
  showEditorStatus('\u{1F4BE} \u8349\u7A3F\u5DF2\u4FDD\u5B58', 'success');
};

function clearDraft() {
  localStorage.removeItem('blog_draft');
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

window.saveEditorSettings = function() {
  localStorage.setItem('gh_token', document.getElementById('ghToken').value.trim());
  localStorage.setItem('gh_owner', document.getElementById('ghOwner').value.trim());
  localStorage.setItem('gh_repo', document.getElementById('ghRepo').value.trim());
  showEditorStatus('\u2705 \u8BBE\u7F6E\u5DF2\u4FDD\u5B58', 'success');
};

function updateEditorPreview() {
  var content = document.getElementById('editorContent');
  var preview = document.getElementById('editorPreview');
  if (!content || !preview) return;
  var text = content.value || '';
  try {
    preview.innerHTML = marked.parse(text);
  } catch (e) {
    preview.innerHTML = '<p style="color:#e53e3e">\u9884\u89C8\u9519\u8BEF</p>';
  }
}

// --- Auto-save draft on input ---
var _draftTimer = null;
function setupEditorListeners() {
  var contentEl = document.getElementById('editorContent');
  if (contentEl) {
    contentEl.addEventListener('input', function() {
      updateEditorPreview();
      // Debounced auto-save
      if (_draftTimer) clearTimeout(_draftTimer);
      _draftTimer = setTimeout(function() {
        saveDraft();
      }, 2000);
    });
  }
  // Initial preview
  updateEditorPreview();
}

// --- Publish to GitHub via Contents API ---
window.publishPost = async function() {
  var title = document.getElementById('editorTitle').value.trim();
  var tagsStr = document.getElementById('editorTags').value.trim();
  var excerpt = document.getElementById('editorExcerpt').value.trim();
  var content = document.getElementById('editorContent').value.trim();

  if (!title) { showEditorStatus('\u274C \u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A', 'error'); return; }
  if (!content) { showEditorStatus('\u274C \u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A', 'error'); return; }

  var token = localStorage.getItem('gh_token');
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
    // 1. Fetch current file (get sha + existing posts)
    var sha = null;
    var currentPosts = [];

    var getResp = await fetch(apiUrl, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }
    });

    if (getResp.status === 200) {
      var data = await getResp.json();
      sha = data.sha;
      var decoded = base64ToUtf8(data.content || '');
      var match = decoded.match(/const USER_POSTS = (\[[\s\S]*\]);/);
      if (match) {
        try { currentPosts = JSON.parse(match[1]); } catch (e) { currentPosts = []; }
      }
    } else if (getResp.status !== 404) {
      var errBody = await getResp.json().catch(function() { return {}; });
      throw new Error('GitHub API: ' + (errBody.message || 'HTTP ' + getResp.status));
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

    // 4. Commit via PUT
    var putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Add post: ' + title,
        content: base64Content,
        sha: sha
      })
    });

    if (!putResp.ok) {
      var putErr = await putResp.json().catch(function() { return {}; });
      throw new Error(putErr.message || 'HTTP ' + putResp.status);
    }

    // 5. Update in-memory array
    if (typeof USER_POSTS !== 'undefined') {
      USER_POSTS.unshift(newPost);
    }

    // 6. Clear draft
    clearDraft();

    showEditorStatus('\u2705 \u53D1\u5E03\u6210\u529F\uFF01GitHub Pages \u5C06\u5728 1-2 \u5206\u949F\u5185\u66F4\u65B0\uFF0C\u5373\u5C06\u8DF3\u8F6C\u5230\u9996\u9875...', 'success');

    // Redirect to home after 2 seconds
    setTimeout(function() { location.hash = '#/'; }, 2000);

  } catch (err) {
    showEditorStatus('\u274C \u53D1\u5E03\u5931\u8D25: ' + escapeHtml(err.message), 'error');
  }
};

// ============================================
// Router
// ============================================
function router() {
  const hash = location.hash.slice(1) || '/';
  const app = document.getElementById('app');
  const searchBar = document.getElementById('searchBar');

  // Close mobile menu
  document.querySelector('.nav').classList.remove('open');
  document.getElementById('menuToggle').classList.remove('active');

  // Show/hide search bar (only on home)
  if (hash === '/') {
    searchBar.classList.remove('hidden');
  } else {
    searchBar.classList.add('hidden');
  }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(link => {
    const route = link.getAttribute('data-route');
    link.classList.remove('active');
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
      app.innerHTML = renderCourses();
      // Attach course search listener
      const courseSearchInput = document.getElementById('courseSearchInput');
      if (courseSearchInput) {
        courseSearchInput.addEventListener('input', (e) => {
          courseSearchQuery = e.target.value;
          app.innerHTML = renderCourses();
          const newInput = document.getElementById('courseSearchInput');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(newInput.value.length, newInput.value.length);
          }
        });
      }
    } else if (hash.startsWith('/course/')) {
      courseFileLimit = 50;
      const id = decodeURIComponent(hash.slice('/course/'.length));
      app.innerHTML = renderCourseDetail(id);
    } else if (hash === '/papers') {
      app.innerHTML = renderPapers();
      const paperSearchInput = document.getElementById('paperSearchInput');
      if (paperSearchInput) {
        paperSearchInput.addEventListener('input', (e) => {
          paperSearchQuery = e.target.value;
          app.innerHTML = renderPapers();
          const newInput = document.getElementById('paperSearchInput');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(newInput.value.length, newInput.value.length);
          }
        });
      }
    } else if (hash === '/about') {
      app.innerHTML = renderAbout();
    } else if (hash === '/projects') {
      app.innerHTML = renderProjects();
    } else if (hash === '/archive') {
      app.innerHTML = renderArchive();
    } else if (hash === '/code') {
      app.innerHTML = renderCode();
      const codeLibSearchInput = document.getElementById('codeLibSearchInput');
      if (codeLibSearchInput) {
        codeLibSearchInput.addEventListener('input', (e) => {
          codeLibSearchQuery = e.target.value;
          app.innerHTML = renderCode();
          const newInput = document.getElementById('codeLibSearchInput');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(newInput.value.length, newInput.value.length);
          }
        });
      }
    } else if (hash.startsWith('/codelib/')) {
      codeLibFileLimit = 50;
      const id = decodeURIComponent(hash.slice('/codelib/'.length));
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

  // Scroll to top on navigation
  window.scrollTo(0, 0);
}

// ============================================
// Event Listeners
// ============================================

// Category filter for courses
window.setCategory = function(cat) {
  activeCategory = cat;
  courseFileLimit = 50;
  const app = document.getElementById('app');
  app.innerHTML = renderCourses();
  const courseSearchInput = document.getElementById('courseSearchInput');
  if (courseSearchInput) {
    courseSearchInput.addEventListener('input', (e) => {
      courseSearchQuery = e.target.value;
      app.innerHTML = renderCourses();
      const newInput = document.getElementById('courseSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    });
  }
};

window.loadMoreCourseFiles = function(courseId) {
  const course = COURSES.find(c => c.id === courseId);
  if (!course) return;
  const container = document.getElementById('course-file-container');
  if (!container) return;

  const prevLimit = courseFileLimit;
  courseFileLimit += 50;
  const nextBatch = course.files.slice(prevLimit, courseFileLimit);

  let html = '';
  for (const file of nextBatch) {
    const typeClass = getFileTypeClass(file.type);
    html += `
      <div class="file-item">
        <span class="file-type-badge ${typeClass}">${escapeHtml(file.type)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-size">${file.sizeFormatted}</span>
      </div>
    `;
  }
  container.insertAdjacentHTML('beforeend', html);

  const loadMoreDiv = document.getElementById('course-load-more');
  if (courseFileLimit >= course.files.length) {
    if (loadMoreDiv) loadMoreDiv.remove();
  } else {
    if (loadMoreDiv) {
      loadMoreDiv.innerHTML = `
        <button class="load-more-btn" onclick="loadMoreCourseFiles('${escapeHtml(courseId)}')">
          加载更多（剩余 ${course.files.length - courseFileLimit} 个文件）
        </button>
      `;
    }
  }
};

window.setPaperTab = function(tab) {
  paperTab = tab;
  paperSearchQuery = '';
  activePaperCategory = null;
  document.getElementById('app').innerHTML = renderPapers();
  const input = document.getElementById('paperSearchInput');
  if (input) {
    input.addEventListener('input', (e) => {
      paperSearchQuery = e.target.value;
      document.getElementById('app').innerHTML = renderPapers();
      const newInput = document.getElementById('paperSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    });
  }
};

window.setPaperCategory = function(cat) {
  activePaperCategory = cat;
  document.getElementById('app').innerHTML = renderPapers();
  const input = document.getElementById('paperSearchInput');
  if (input) {
    input.addEventListener('input', (e) => {
      paperSearchQuery = e.target.value;
      document.getElementById('app').innerHTML = renderPapers();
      const newInput = document.getElementById('paperSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    });
  }
};

// Search
document.getElementById('searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  const app = document.getElementById('app');
  app.innerHTML = renderHome();
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

// ============================================
// Theme (dark mode)
// ============================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

(function initTheme() {
  let theme = localStorage.getItem('theme');
  if (!theme && window.matchMedia) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme || 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', function () {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', cur);
      applyTheme(cur);
      if (GISCUS_CONFIG.enabled && location.hash.indexOf('/post/') === 0) {
        loadGiscus(location.hash.slice('/post/'.length));
      }
    });
  }
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

// Initial render
router();
