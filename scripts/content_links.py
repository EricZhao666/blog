#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 9B-2：内容引用契约与构建期反向索引（纯函数、确定性、不执行任何 JS 代码）。

语法契约（与 js/content-links.js 共享，详见 CONTENT_LINK_FORMAT.md）：
  WikiLink v1 仅支持 post 类型：
      [[post:<id>]]            id 必须匹配 ^[a-z0-9][a-z0-9-]*$（与文章 id 契约一致）
      [[post:<id>|<显示文本>]]  显示文本 1–200 字符，不含 [ ] | 与换行
  post id 不含竖线，因此第一个竖线无歧义地作为显示文本分隔符。
  课程 id 本身含竖线（如 本科课程|机器人与自动化-(CS422)），v1 不扩展其他类型，
  避免「第一个竖线」歧义；其他类型的 [[...]] 保留原文并记录诊断。

保护语义（构建索引与浏览器渲染共享）：
  1. 围栏代码块（``` / ~~~，行首 ≤3 空格）内不解析；
  2. 行内代码（反引号串，按相同长度闭合）内不解析；
  3. 反斜杠转义（\\[ 等）不解析；
  4. HTML 标签 <...> 内不解析；
  5. Markdown 链接目标 ](...) 内不解析 WikiLink（链接本身照常抽取）。

普通 Markdown 站内链接抽取与 js/related.js extractLinks 同构（四类路由 + papers 查询），
但**额外施加上述保护**：代码围栏里的示例链接不构成真实引用（9B-1 运行时算法保持原样不改）。

索引由正式权威内容源生成（js/data.js、data/posts/*.md、js/user-posts.js、js/courses.js、
js/course-notes.js、js/papers.js、js/codefiles.js、js/projects.js、js/note-slugs.js）。
不读取任何测试注入、个人收藏或浏览历史数据。相同输入 → 字节级一致输出（无时间戳）。
"""
import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)
import gen_feed as g  # noqa: E402  结构化 JS 字面量扫描器（不执行代码）

SCHEMA_VERSION = 1
GENERATOR = 'scripts/content_links.py'
POST_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]*$')
WIKILINK_RE = re.compile(r'\[\[post:([a-z0-9][a-z0-9-]*)(?:\|([^\[\]|\n]{1,200}))?\]\]')
WIKILINK_OPEN_RE = re.compile(r'\[\[([a-z]+):')
FENCE_RE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
# 与 js/related.js LINK_PATTERNS 同构
LINK_PATTERNS = [
    ('post', re.compile(r'^#/post/([^?#\s"\'<>]+)')),
    ('course', re.compile(r'^#/course/([^?#\s"\'<>]+)')),
    ('lib', re.compile(r'^#/codelib/([^?#\s"\'<>]+)')),
    ('project', re.compile(r'^#/project/([^?#\s"\'<>]+)')),
]
PAPERS_LINK_RE = re.compile(r'^#/papers\?([^#\s"\'<>]+)')
MD_LINK_RE = re.compile(r'\]\(((?:[^\s()]|\([^\s()]*\))+)\)|href="([^"]+)"')
HTML_TAG_RE = re.compile(r'<[A-Za-z/!][^<>]*>')
ESCAPABLE = set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')


def _mask_spans(text, spans):
    """把保护区间替换为等长空格（保留位置，便于后续正则）。"""
    if not spans:
        return text
    buf = list(text)
    for a, b in spans:
        for i in range(a, min(b, len(buf))):
            if buf[i] != '\n':
                buf[i] = ' '
    return ''.join(buf)


def protected_spans(text, include_html=True):
    """围栏 / 行内代码 / 转义（必选）+ HTML 标签（可选）的保护区间。

    include_html=False 用于站内链接抽取：href="..." 本身就是合法链接来源，
    不能被 HTML 标签保护遮罩；WikiLink 扫描则必须包含 HTML 保护。
    """
    spans = []
    lines = text.split('\n')
    offset = 0
    fence = None  # (char, len)
    for line in lines:
        m = FENCE_RE.match(line)
        if m:
            mark = m.group(1)
            if fence is None:
                fence = (mark[0], len(mark))
                spans.append((offset, offset + len(line)))
            elif mark[0] == fence[0] and len(mark) >= fence[1] and line.strip() == mark:
                fence = None
                spans.append((offset, offset + len(line)))
            else:
                spans.append((offset, offset + len(line)))
        elif fence is not None:
            spans.append((offset, offset + len(line)))
        offset += len(line) + 1
    # 行内逐字符扫描（跳过已整行保护的围栏区域）
    masked_lines = _mask_spans(text, spans)
    i, n = 0, len(text)
    while i < n:
        if masked_lines[i] == ' ' and text[i] != ' ':
            i += 1
            continue
        c = text[i]
        if c == '\\' and i + 1 < n and text[i + 1] in ESCAPABLE:
            spans.append((i, i + 2))
            i += 2
            continue
        if c == '`':
            j = i
            while j < n and text[j] == '`':
                j += 1
            run = j - i
            k = text.find('`' * run, j)
            while k != -1:
                k2 = k
                while k2 < n and text[k2] == '`':
                    k2 += 1
                if k2 - k == run:
                    break
                k = text.find('`' * run, k2)
            if k != -1:
                spans.append((i, k + run))
                i = k + run
                continue
            i = j
            continue
        if c == '<' and include_html:
            m = HTML_TAG_RE.match(text, i)
            if m:
                spans.append((i, m.end()))
                i = m.end()
                continue
        i += 1
    return spans


def _decode_id(raw):
    try:
        from urllib.parse import unquote
        return unquote(raw)
    except Exception:
        return raw


def extract_markdown_links(text):
    """站内真实链接（施加保护语义）。返回 [{type, refId, key, raw}]，按出现顺序去重。"""
    masked = _mask_spans(text, protected_spans(text, include_html=False))
    out, seen = [], set()
    for m in MD_LINK_RE.finditer(masked):
        url = m.group(1) or m.group(2) or ''
        if not url.startswith('#/'):
            continue
        hit = None
        for typ, rex in LINK_PATTERNS:
            mm = rex.match(url)
            if mm:
                hit = {'type': typ, 'refId': _decode_id(mm.group(1))}
                break
        if hit is None:
            pm = PAPERS_LINK_RE.match(url)
            if pm:
                from urllib.parse import parse_qs
                qs = parse_qs(pm.group(1))
                kind = (qs.get('kind') or [''])[0]
                target = (qs.get('target') or [''])[0]
                if target and kind in ('paper', 'material'):
                    hit = {'type': kind, 'refId': target}
        if hit is None:
            continue
        key = hit['type'] + ':' + hit['refId']
        if key in seen:
            continue
        seen.add(key)
        hit['key'] = key
        hit['raw'] = url
        out.append(hit)
    return out


def extract_wikilinks(text):
    """WikiLink 与诊断。返回 (links, diagnostics)；links 含 {key, refId, display, raw}。"""
    spans = protected_spans(text)
    masked = _mask_spans(text, spans)
    # 链接目标内不解析 WikiLink：先抽普通链接（与 extract_markdown_links 同一保护集），再遮罩目标区间
    dest_spans = []
    for m in MD_LINK_RE.finditer(_mask_spans(text, protected_spans(text, include_html=False))):
        if m.group(1):
            dest_spans.append((m.start(1), m.end(1)))
    masked2 = _mask_spans(masked, dest_spans)
    links, diags, seen = [], [], set()
    for m in WIKILINK_RE.finditer(masked2):
        ref_id, display = m.group(1), m.group(2)
        key = 'post:' + ref_id
        raw = text[m.start():m.end()]
        if key in seen:
            continue
        seen.add(key)
        links.append({'key': key, 'type': 'post', 'refId': ref_id,
                      'display': (display or '').strip(), 'raw': raw})
    # 诊断：形似 WikiLink 但未被合法解析的片段（不支持的类型 / 非法 id / 非法显示文本）
    valid_spans = [(m.start(), m.end()) for m in WIKILINK_RE.finditer(masked2)]
    for m in WIKILINK_OPEN_RE.finditer(masked2):
        if any(a <= m.start() < b for a, b in valid_spans):
            continue
        end = text.find(']]', m.start())
        raw = text[m.start():end + 2] if end != -1 and end - m.start() < 240 else text[m.start():m.start() + 60]
        typ = m.group(1)
        reason = 'unsupported-type' if typ != 'post' else 'invalid-wikilink'
        diags.append({'raw': raw, 'reason': reason})
    return links, diags


# --------------------------------------------------------------------- 节点注册表
def _read_js_literal(path, name):
    with open(path, 'rb') as f:
        text = f.read().decode('utf-8').lstrip('\ufeff')
    start = g.find_assignment(text, name)
    value, _ = g._read_value(text, start)
    return value


def _href_for(typ, ref_id):
    from urllib.parse import quote
    eid = quote(ref_id, safe='')
    if typ == 'post':
        return '#/post/' + eid
    if typ == 'course':
        return '#/course/' + eid
    if typ == 'lib':
        return '#/codelib/' + eid
    if typ == 'paper':
        return '#/papers?kind=paper&target=' + eid
    if typ == 'material':
        return '#/papers?kind=material&target=' + eid
    if typ == 'project':
        return '#/project/' + eid
    return ''


def build_nodes(p, state):
    """从正式权威源建立节点（复用 type:refId 稳定键；不改任何现有 ID）。"""
    nodes = {}

    def add(typ, ref_id, title, tags=None, category='', series='', text='', example=False, href=None):
        if not isinstance(ref_id, str) or not ref_id or not isinstance(title, str) or not title:
            return
        key = typ + ':' + ref_id
        if key in nodes:
            return
        nodes[key] = {
            'key': key, 'type': typ, 'refId': ref_id, 'title': title,
            'href': href if href is not None else _href_for(typ, ref_id),
            'tags': [t for t in (tags or []) if isinstance(t, str) and t],
            'category': category or '', 'series': series or '', 'text': text or '',
            'example': bool(example),
        }

    # series 从权威元数据读取：assemble 的统一视图投影不含 series（不改 assemble，
    # 避免影响其他消费方）；旧编辑器内联文章若自带 series 则原样沿用。
    series_by_id = {m['id']: m.get('series', '') for m in state['metas'] if isinstance(m.get('series'), str)}
    for post in state['all']:
        series = series_by_id.get(post['id']) or post.get('series', '') or ''
        add('post', post['id'], post['title'], post.get('tags'), '',
            series, post.get('excerpt', ''))

    root = os.path.dirname(p['data_js'])  # js/

    def read_optional(rel, name):
        """可选权威源：文件不存在时返回空列表（兼容最小 fixture root 契约）。
        正式仓库中这些文件都在；缺失只影响对应类型节点，不阻断构建。
        返回值保持原解析类型（COURSES 等为列表，NOTE_PAGES 为字典）。"""
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            return []
        return _read_js_literal(path, name)

    courses = read_optional('courses.js', 'COURSES')
    for c in courses:
        add('course', c.get('id'), c.get('name'), None, c.get('category', ''), '', c.get('description', ''))
    papers = read_optional('papers.js', 'PAPERS')
    for x in papers:
        add('paper', x.get('id'), x.get('title'), x.get('collections'), x.get('category', ''), '', x.get('abstract', ''))
    materials = read_optional('papers.js', 'LEARNING_MATERIALS')
    for x in materials:
        add('material', x.get('id'), x.get('name'), None, x.get('category', ''), '', x.get('subcategory', ''))
    libs = read_optional('codefiles.js', 'CODE_LIBS')
    for x in libs:
        add('lib', x.get('id'), x.get('name'), None, x.get('category', ''), '', x.get('description', ''))
    projects = read_optional('projects.js', 'PROJECTS')
    for x in projects:
        text = ' '.join([x.get('description', '')] + [h for h in (x.get('highlights') or []) if isinstance(h, str)])
        add('project', x.get('id'), x.get('name'), x.get('tags'), '', '', text.strip(), x.get('example'))
    # 静态笔记页：仅当 NOTE_PAGES 提供真实 slug 与真实跳转目标时纳入
    note_pages_raw = read_optional('note-slugs.js', 'NOTE_PAGES')
    note_pages = note_pages_raw if isinstance(note_pages_raw, dict) else {}
    course_titles = {c.get('id'): c.get('name') for c in courses}
    for cid, rel in sorted(note_pages.items()):
        if not isinstance(rel, str) or not rel.startswith('notes/') or not rel.endswith('.html'):
            continue
        slug = rel[len('notes/'):-len('.html')]
        if not slug:
            continue
        title = (course_titles.get(cid) or cid) + '（笔记页）'
        add('note', slug, title, None, '', '', '', False, href=rel)
    return nodes


def build_index(p, state):
    """确定性引用索引：显式引用（正文内链 + WikiLink）+ 同系列 + 诊断。"""
    nodes = build_nodes(p, state)
    explicit, diagnostics = [], []
    seen_edges = set()

    def add_edge(source_key, target_key, via, raw):
        if source_key == target_key:
            return  # 排除自环
        if target_key not in nodes:
            diagnostics.append({'source': source_key, 'raw': raw, 'reason': 'unresolved-target'})
            return
        sig = (source_key, target_key, via)
        if sig in seen_edges:
            return  # 确定性去重（重复引用只记一条）
        seen_edges.add(sig)
        explicit.append({'source': source_key, 'target': target_key, 'via': via})

    def scan_body(source_key, text):
        if source_key not in nodes or not isinstance(text, str):
            return
        for hit in extract_markdown_links(text):
            add_edge(source_key, hit['key'], 'markdown', hit['raw'])
        links, diags = extract_wikilinks(text)
        for hit in links:
            add_edge(source_key, hit['key'], 'wikilink', hit['raw'])
        for d in diags:
            diagnostics.append({'source': source_key, 'raw': d['raw'], 'reason': d['reason']})

    # 文章正文（权威源：data/posts/*.md 与旧编辑器内联正文）
    for post in state['all']:
        scan_body('post:' + post['id'], post.get('content', ''))
    # 课程笔记（权威源：js/course-notes.js）
    root = os.path.dirname(p['data_js'])
    notes_path = os.path.join(root, 'course-notes.js')
    if os.path.exists(notes_path):
        notes = _read_js_literal(notes_path, 'COURSE_NOTES')
        if isinstance(notes, dict):
            for cid in sorted(notes):
                entry = notes[cid]
                body = entry.get('notes') if isinstance(entry, dict) else None
                if isinstance(body, str):
                    scan_body('course:' + cid, body)

    explicit.sort(key=lambda e: (e['source'], e['target'], e['via']))
    diagnostics.sort(key=lambda d: (d['source'], d['reason'], d['raw']))

    # 同系列关系（真实 series 字段；无向，码元序去重；不等同于正文引用）
    series_groups = {}
    for key in sorted(nodes):
        n = nodes[key]
        if n['type'] == 'post' and n['series']:
            series_groups.setdefault(n['series'], []).append(key)
    series_edges = []
    for series in sorted(series_groups):
        keys = series_groups[series]
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                series_edges.append({'a': keys[i], 'b': keys[j], 'series': series})

    by_source, by_target = {}, {}
    for e in explicit:
        by_source.setdefault(e['source'], []).append(e['target'])
        by_target.setdefault(e['target'], []).append(e['source'])
    for k in by_source:
        by_source[k] = sorted(set(by_source[k]))
    for k in by_target:
        by_target[k] = sorted(set(by_target[k]))

    linked = set(by_source) | set(by_target)
    for e in series_edges:
        linked.add(e['a'])
        linked.add(e['b'])
    isolated = sorted(k for k in nodes if k not in linked)
    by_type = {}
    for n in nodes.values():
        by_type[n['type']] = by_type.get(n['type'], 0) + 1

    node_list = []
    for key in sorted(nodes):
        n = nodes[key]
        item = {'key': key, 'type': n['type'], 'refId': n['refId'], 'title': n['title'], 'href': n['href']}
        if n['tags']:
            item['tags'] = n['tags']
        if n['category']:
            item['category'] = n['category']
        if n['series']:
            item['series'] = n['series']
        if n['text']:
            item['text'] = n['text']
        if n['example']:
            item['example'] = True
        node_list.append(item)

    return {
        'schemaVersion': SCHEMA_VERSION,
        'generator': GENERATOR,
        'nodes': node_list,
        'explicit': explicit,
        'series': series_edges,
        'bySource': by_source,
        'byTarget': by_target,
        'diagnostics': diagnostics,
        'stats': {
            'nodes': len(node_list),
            'explicitEdges': len(explicit),
            'seriesEdges': len(series_edges),
            'unresolved': sum(1 for d in diagnostics if d['reason'] == 'unresolved-target'),
            'invalidWikilinks': sum(1 for d in diagnostics if d['reason'] != 'unresolved-target'),
            'isolated': len(isolated),
            'isolatedKeys': isolated,
            'byType': by_type,
        },
    }


def render_index(index):
    """字节级确定性序列化：sort_keys + 紧凑分隔符 + LF + 无 BOM + 无时间戳。"""
    return (json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def build_artifact(p, state):
    return render_index(build_index(p, state))