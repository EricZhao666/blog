/**
 * content-links.js — Batch 9B-2 内容引用契约（浏览器端，与 scripts/content_links.py 共享语法）。
 *
 * WikiLink v1（详见 CONTENT_LINK_FORMAT.md）：
 *   [[post:<id>]]           id 匹配 ^[a-z0-9][a-z0-9-]*$
 *   [[post:<id>|显示文本]]   显示文本 1–200 字符，不含 [ ] | 与换行
 * post id 不含竖线 → 第一个竖线无歧义。课程 id 含竖线，v1 不扩展其他类型。
 *
 * 本模块是纯函数 + marked 扩展工厂，不依赖 DOM，可在 Node 中 require 做契约测试。
 * 渲染输出全部经过 escapeHtml；解析结果只产生站内 #/ 链接，绝不产生 javascript: 等协议。
 * marked 自身保证围栏代码 / 行内代码 / 反斜杠转义内的 [[...]] 不进入扩展；
 * scanText() 为构建索引镜像实现同样的保护语义（共享 fixture 锁定两侧一致）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ContentLinks = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const POST_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  const WIKILINK_RE = /\[\[post:([a-z0-9][a-z0-9-]*)(?:\|([^\[\]|\n]{1,200}))?\]\]/g;
  const WIKILINK_HEAD_RE = /^\[\[post:([a-z0-9][a-z0-9-]*)(?:\|([^\[\]|\n]{1,200}))?\]\]/;
  const WIKILINK_OPEN_RE = /\[\[([a-z]+):/g;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  const MD_LINK_RE = /\]\(((?:[^\s()]|\([^\s()]*\))+)\)|href="([^"]+)"/g;
  const HTML_TAG_RE = /^<[A-Za-z/!][^<>]*>/;
  const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const LINK_PATTERNS = [
    ['post', /^#\/post\/([^?#\s"'<>]+)/],
    ['course', /^#\/course\/([^?#\s"'<>]+)/],
    ['lib', /^#\/codelib\/([^?#\s"'<>]+)/],
    ['project', /^#\/project\/([^?#\s"'<>]+)/]
  ];
  const PAPERS_LINK_RE = /^#\/papers\?([^#\s"'<>]+)/;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function maskSpans(text, spans) {
    if (!spans.length) return text;
    const buf = text.split('');
    for (const [a, b] of spans) {
      for (let i = a; i < Math.min(b, buf.length); i++) if (buf[i] !== '\n') buf[i] = ' ';
    }
    return buf.join('');
  }

  /** 保护区间：围栏 / 行内代码 / 转义（必选）+ HTML 标签（可选，与 Python 镜像同构）。
   *  includeHtml=false 用于站内链接抽取（href 本身是合法链接来源）。 */
  function protectedSpans(text, includeHtml = true) {
    const spans = [];
    const lines = text.split('\n');
    let offset = 0, fence = null;
    for (const line of lines) {
      const m = FENCE_RE.exec(line);
      if (m) {
        const mark = m[1];
        if (!fence) { fence = [mark[0], mark.length]; spans.push([offset, offset + line.length]); }
        else if (mark[0] === fence[0] && mark.length >= fence[1] && line.trim() === mark) {
          fence = null; spans.push([offset, offset + line.length]);
        } else spans.push([offset, offset + line.length]);
      } else if (fence) spans.push([offset, offset + line.length]);
      offset += line.length + 1;
    }
    const maskedLines = maskSpans(text, spans);
    let i = 0; const n = text.length;
    while (i < n) {
      if (maskedLines[i] === ' ' && text[i] !== ' ') { i++; continue; }
      const c = text[i];
      if (c === '\\' && i + 1 < n && ESCAPABLE.indexOf(text[i + 1]) !== -1) { spans.push([i, i + 2]); i += 2; continue; }
      if (c === '`') {
        let j = i; while (j < n && text[j] === '`') j++;
        const run = j - i;
        let k = text.indexOf('`'.repeat(run), j);
        while (k !== -1) {
          let k2 = k; while (k2 < n && text[k2] === '`') k2++;
          if (k2 - k === run) break;
          k = text.indexOf('`'.repeat(run), k2);
        }
        if (k !== -1) { spans.push([i, k + run]); i = k + run; continue; }
        i = j; continue;
      }
      if (c === '<' && includeHtml) {
        const m = HTML_TAG_RE.exec(text.slice(i));
        if (m) { spans.push([i, i + m[0].length]); i += m[0].length; continue; }
      }
      i++;
    }
    return spans;
  }

  function decodeId(raw) { try { return decodeURIComponent(raw); } catch (e) { return raw; } }

  /** 站内真实 Markdown 链接（保护语义；与 related.js extractLinks 同构但排除代码区示例）。 */
  function extractMarkdownLinks(text) {
    const masked = maskSpans(text, protectedSpans(text, false));
    const out = [], seen = new Set();
    MD_LINK_RE.lastIndex = 0;
    let m;
    while ((m = MD_LINK_RE.exec(masked))) {
      const url = m[1] || m[2] || '';
      if (!url.startsWith('#/')) continue;
      let hit = null;
      for (const [type, re] of LINK_PATTERNS) {
        const mm = re.exec(url);
        if (mm) { hit = { type, refId: decodeId(mm[1]) }; break; }
      }
      if (!hit) {
        const pm = PAPERS_LINK_RE.exec(url);
        if (pm) {
          const qs = new URLSearchParams(pm[1]);
          const kind = qs.get('kind'), target = qs.get('target');
          if (target && (kind === 'paper' || kind === 'material')) hit = { type: kind, refId: target };
        }
      }
      if (!hit) continue;
      const key = hit.type + ':' + hit.refId;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, type: hit.type, refId: hit.refId, raw: url });
    }
    return out;
  }

  /** WikiLink 扫描（构建索引镜像）。返回 {links, diagnostics}。 */
  function scanText(text) {
    const masked = maskSpans(text, protectedSpans(text));
    const destSpans = [];
    MD_LINK_RE.lastIndex = 0;
    let m;
    const linkMasked = maskSpans(text, protectedSpans(text, false));
    while ((m = MD_LINK_RE.exec(linkMasked))) if (m[1]) destSpans.push([m.index + 2, m.index + 2 + m[1].length]);
    const masked2 = maskSpans(masked, destSpans);
    const links = [], diagnostics = [], seen = new Set(), validSpans = [];
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(masked2))) {
      validSpans.push([m.index, m.index + m[0].length]);
      const key = 'post:' + m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ key, type: 'post', refId: m[1], display: (m[2] || '').trim(), raw: text.slice(m.index, m.index + m[0].length) });
    }
    WIKILINK_OPEN_RE.lastIndex = 0;
    while ((m = WIKILINK_OPEN_RE.exec(masked2))) {
      if (validSpans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const end = text.indexOf(']]', m.index);
      const raw = (end !== -1 && end - m.index < 240) ? text.slice(m.index, end + 2) : text.slice(m.index, m.index + 60);
      diagnostics.push({ raw, reason: m[1] !== 'post' ? 'unsupported-type' : 'invalid-wikilink' });
    }
    return { links, diagnostics };
  }

  /**
   * marked 扩展工厂。resolver(key) → {title} | null（只允许公开权威数据）。
   * 合法且可解析 → 真实站内链接；合法但不存在 → 明确未解析状态（不跳转、不建文章）。
   */
  function markedExtension(resolver) {
    return {
      extensions: [{
        name: 'wikilink',
        level: 'inline',
        start(src) { const i = src.indexOf('[[post:'); return i === -1 ? undefined : i; },
        tokenizer(src) {
          const m = WIKILINK_HEAD_RE.exec(src);
          if (!m) return undefined;
          return { type: 'wikilink', raw: m[0], refId: m[1], display: (m[2] || '').trim() };
        },
        renderer(token) {
          const key = 'post:' + token.refId;
          const label = token.display || token.refId;
          let target = null;
          try { target = resolver ? resolver(key) : null; } catch (e) { target = null; }
          if (target && typeof target.title === 'string') {
            const text = token.display || target.title;
            return '<a href="#/post/' + encodeURIComponent(token.refId) + '" class="wikilink" data-wikilink="' +
              escapeHtml(key) + '">' + escapeHtml(text) + '</a>';
          }
          return '<span class="wikilink-unresolved" data-wikilink-unresolved="' + escapeHtml(key) +
            '" title="引用目标不存在：' + escapeHtml(key) + '">' + escapeHtml(label) + '</span>';
        }
      }]
    };
  }

  return {
    SCHEMA_VERSION, POST_ID_RE, escapeHtml,
    protectedSpans, extractMarkdownLinks, scanText, markedExtension
  };
});