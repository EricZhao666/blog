// 汇总当前文档实际用到的各个资源版本，用于判断是否发生了"混版"
(function () {
  var el = document.getElementById('app');
  var css = '';
  try {
    css = getComputedStyle(el).getPropertyValue('--ver').trim();
  } catch (e) { /* ignore */ }
  window.__versions = {
    html: document.documentElement.getAttribute('data-ver'),
    css: css,
    js: '{{ver}}',
    data: window.DATA_VER || null,
    user: window.USER_POSTS_VER || null,
    projects: window.PROJECTS_VER || null
  };
  window.__rendered = true;
  el.textContent = 'rendered v' + window.__versions.html;
})();
