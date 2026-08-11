/**
 * Blog App - Router & Rendering Logic
 */

// ============================================
// Config
// ============================================
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (e) {}
    }
    return hljs.highlightAuto(code).value;
  }
});

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

// ============================================
// Utilities
// ============================================
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
  POSTS.forEach(post => {
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
  const filtered = filterPosts(POSTS, searchQuery, null);

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

function renderPost(id) {
  const post = POSTS.find(p => p.id === id);
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
  `;
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
    const filtered = filterPosts(POSTS, null, tag);
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
              <span class="course-card-source">${escapeHtml(course.source)}</span>
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
          <span class="meta-item">📚 ${escapeHtml(course.source)}</span>
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
  for (const file of visibleFiles) {
    const typeClass = getFileTypeClass(file.type);
    const filePath = (file.path || '').replace(/\\/g, '/');
    const relPath = file.relPath || file.path || '';
    html += `
      <div class="file-item file-item-link" data-filepath="${escapeHtml(filePath)}" title="点击打开: ${escapeHtml(file.path || '')}">
        <span class="file-type-badge ${typeClass}">${escapeHtml(file.type)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-path">${escapeHtml(relPath)}</span>
        <span class="file-size">${file.sizeFormatted}</span>
        <span class="file-open-icon" title="本地打开">🔗</span>
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
        💡 点击任意文件可在本地打开，文件保留在原始目录，未做任何复制
      </div>
    </div>
  `;

  return html;
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
        const pdfLink = paper.pdfPath
          ? `<span class="paper-pdf-link" data-filepath="${escapeHtml(paper.pdfPath.replace(/\\/g, '/'))}" onclick="event.stopPropagation(); window.open('file:///' + encodeURI(this.getAttribute('data-filepath')), '_blank');">🔗 PDF</span>`
          : '';
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

    const catIcons = { 'ANSYS仿真': '🔧', '机械臂CAD模型': '🦾', 'CAD建模': '📐', '学术Seminar': '🎤', '其他': '📦' };

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
        const filePath = (m.path || '').replace(/\\/g, '/');
        html += `
          <div class="file-item file-item-link" data-filepath="${escapeHtml(filePath)}" title="${escapeHtml(m.path || '')}">
            <span class="file-type-badge ${typeClass}">${escapeHtml(m.type)}</span>
            <span class="file-name">${escapeHtml(m.name)}</span>
            ${m.subcategory ? `<span class="file-path">${escapeHtml(m.subcategory)}</span>` : ''}
            <span class="file-size">${m.sizeFormatted}</span>
            <span class="file-open-icon">🔗</span>
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
  });

  // Parse route
  if (hash === '/' || hash === '') {
    app.innerHTML = renderHome();
  } else if (hash.startsWith('/post/')) {
    const id = hash.slice('/post/'.length);
    app.innerHTML = renderPost(id);
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
    attachFileOpenHandlers();
  } else if (hash === '/papers') {
    app.innerHTML = renderPapers();
    attachFileOpenHandlers();
    const paperSearchInput = document.getElementById('paperSearchInput');
    if (paperSearchInput) {
      paperSearchInput.addEventListener('input', (e) => {
        paperSearchQuery = e.target.value;
        app.innerHTML = renderPapers();
        attachFileOpenHandlers();
        const newInput = document.getElementById('paperSearchInput');
        if (newInput) {
          newInput.focus();
          newInput.setSelectionRange(newInput.value.length, newInput.value.length);
        }
      });
    }
  } else if (hash === '/about') {
    app.innerHTML = renderAbout();
  } else {
    app.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🤔</div>
        <p>页面不存在</p>
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

window.attachFileOpenHandlers = function() {
  document.querySelectorAll('.file-item-link[data-filepath]').forEach(el => {
    if (el._fileHandlerAttached) return;
    el._fileHandlerAttached = true;
    el.addEventListener('click', function() {
      const fp = this.getAttribute('data-filepath');
      if (fp) {
        window.open('file:///' + encodeURI(fp), '_blank');
      }
    });
  });
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
    const filePath = (file.path || '').replace(/\\/g, '/');
    const relPath = file.relPath || file.path || '';
    html += `
      <div class="file-item file-item-link" data-filepath="${escapeHtml(filePath)}" title="点击打开: ${escapeHtml(file.path || '')}">
        <span class="file-type-badge ${typeClass}">${escapeHtml(file.type)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-path">${escapeHtml(relPath)}</span>
        <span class="file-size">${file.sizeFormatted}</span>
        <span class="file-open-icon" title="本地打开">🔗</span>
      </div>
    `;
  }
  container.insertAdjacentHTML('beforeend', html);
  attachFileOpenHandlers();

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

// Initial render
router();
