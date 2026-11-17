#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布前图片资源检查（Batch 8D-2B）。

背景：编辑器只把图片引用写进 Markdown（`images/<slug>-<hash>.png`），
**不会**把原图放进仓库；`scripts/build_content.py --check` 校验的是元数据/正文/
搜索语料/完整性清单/RSS 的一致性，不检查图片文件是否存在。本脚本补上这一步，
让"文章引用了仓库里没有的图片"在 PR 之前就失败。

用法：
    python scripts/check_images.py --check
    python scripts/check_images.py --check --root DIR
    python scripts/check_images.py --check --base-path /blog/

检查对象：`data/posts/*.md`（已发布文章的正文；不含 manifest.json）。

一、支持的图片语法
    * 行内：![alt](images/a.png)、![alt](<images/a b.png> "可选标题")
    * 参考式：![alt][label]、![alt][]（用 alt 当 label）、![alt] + [label]: images/a.png
    * 原始 HTML：<img src="images/a.png" alt="…">
    以下内容不会被当成图片引用（视为代码/纯文本）：
    * 围栏代码块（``` 或 ~~~）与四空格缩进代码块
    * 行内代码 `![a](b.png)`
    * 转义写法 !\\[a\\](b.png)
    参考式定义缺失、HTML <img> 缺 src 只报 WARNING（渲染后是文本，不会 404）。

二、路径分类（站点部署在 GitHub Pages 项目站 https://ericzhao666.github.io/blog/）
    * 仓库内相对：images/a.png、./images/a.png
      —— 相对的是**站点根目录**（= 仓库根），**不是** `data/posts/` 所在目录：
         文章由 index.html 的 SPA 渲染，base URL 是 /blog/ 而不是 /blog/data/posts/。
    * 站点绝对：/blog/images/a.png —— 去掉 /blog/ 前缀后按仓库路径检查。
    * /images/a.png —— 指向 https://ericzhao666.github.io/images/a.png，
      不属于本博客，**不能**当成仓库里的 images/ → ERROR。
    * https://… —— 外部图片，只检查格式，不联网请求，也不声称一定可访问。
    * data:image/* —— 内联 Data URI，不落仓库文件，只提示不可校验。
    * javascript:/file:/ftp:/C:\\… —— 非法或不支持的协议 → ERROR。
    * 含 `..` 的路径一律 ERROR（不允许跳出站点根目录）。

三、错误分级
    ERROR（退出码 1，CI 必须失败）
        * 引用的本地图片不存在
        * 路径逃逸（含 ..、绝对路径写到磁盘、反斜杠/控制字符）
        * 本地引用指向目录（或不是普通文件）
        * 符号链接指向仓库外部 / 链接已断
        * 文件名大小写与磁盘不一致（Windows 正常、Linux/GitHub Pages 404）
        * 站内绝对路径不在 /blog/ 子路径下（/images/a.png）
        * 非法协议、空的图片地址
    WARNING（不失败）
        * 图片没有有效 alt
        * 图片体积超过编辑器建议上限（2 MiB）
        * 外部图片依赖风险 / http:// 会被混合内容拦截 / 协议相对地址 //…
        * 图片格式不适合当前使用场景（svg / bmp / tiff / heic…）
        * 内联 Data URI、参考式图片定义缺失

只读保证：本脚本不复制、不删除、不重命名任何文件，也不会创建 `images/` 目录。

退出码：
    0  通过（无 ERROR；没有任何图片引用也算通过）
    1  有 ERROR
    2  仓库结构不可用（--root 不存在 / 缺 data/posts）
"""
import argparse
import os
import re
import sys
from urllib.parse import unquote

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)

POSTS_REL = 'data/posts'
DEFAULT_BASE_PATH = '/blog/'
IMAGE_DIR = 'images'                       # 与 js/app.js 的 MD_IMAGE_DIR 一致
MAX_IMAGE_BYTES = 2 * 1024 * 1024          # 与 js/app.js 的 MD_IMAGE_MAX_BYTES 一致

SUPPORTED_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.gif')     # 编辑器白名单
OTHER_EXTS = ('.svg', '.avif', '.bmp', '.tif', '.tiff', '.ico', '.heic', '.heif')

ERROR = 'ERROR'
WARNING = 'WARNING'

CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')
SCHEME_RE = re.compile(r'^([A-Za-z][A-Za-z0-9+.\-]*):')
DATA_URI_RE = re.compile(r'^data:image/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]\S', re.I)
FENCE_RE = re.compile(r'^ {0,3}(`{3,}|~{3,})(.*)$')
LIST_ITEM_RE = re.compile(r'^ {0,3}(?:[-*+]|\d{1,9}[.)])\s')
REF_DEF_RE = re.compile(r'^ {0,3}\[((?:\\.|[^\[\]\\])+)\]:[ \t]*(<[^>]*>|\S+)'
                        r'(?:[ \t]+(?:"[^"]*"|\'[^\']*\'|\([^)]*\)))?[ \t]*$')
IMG_TAG_RE = re.compile(r'<img\b([^>]*)>', re.I)
SRC_ATTR_RE = re.compile(r'''\bsrc[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))''', re.I)
ALT_ATTR_RE = re.compile(r'''\balt[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))''', re.I)


# --------------------------------------------------------------------- 结果模型
def finding(sev, path, line, raw, msg, fix):
    return {'sev': sev, 'path': path, 'line': line, 'raw': raw, 'msg': msg, 'fix': fix}


def _clip(text, limit=160):
    s = re.sub(r'\s+', ' ', str(text or '')).strip()
    return s if len(s) <= limit else s[:limit - 1] + '…'


# --------------------------------------------------------------------- 代码块/行内代码
def _indent_width(line):
    col = 0
    for ch in line:
        if ch == ' ':
            col += 1
        elif ch == '\t':
            col += 4 - (col % 4)
        else:
            break
    return col


def _is_indented_code(line, prev_block):
    """四空格缩进代码块（保守判定：列表项内的缩进内容仍按正文检查）。

    宁可把"列表里缩进的图片"当正文检查（多查一次），也不要把真图片当成代码放过。
    """
    if not line.strip():
        return False
    if _indent_width(line) < 4:
        return False
    if prev_block and LIST_ITEM_RE.match(prev_block):
        return False
    return True


def iter_scan_lines(lines):
    """返回 (可扫描的 [(行号, 行文本)], 是否有未闭合围栏)。代码块整段丢弃。"""
    out = []
    fence = None                 # (字符, 长度)
    prev_block = ''              # 最近一条"正文行"（用于判定缩进代码 / 列表续行）
    for no, line in enumerate(lines, 1):
        if fence is not None:
            m = FENCE_RE.match(line)
            if (m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]
                    and not m.group(2).strip()):
                fence = None
                prev_block = ''
            continue
        m = FENCE_RE.match(line)
        if m and not (m.group(1)[0] == '`' and '`' in m.group(2)):
            fence = (m.group(1)[0], len(m.group(1)))
            prev_block = ''
            continue
        if _is_indented_code(line, prev_block):
            continue
        out.append((no, line))
        if line.strip():
            prev_block = line
    return out, fence is not None


def blank_inline_code(text):
    """把行内代码（` ` / `` `` ``）替换成等长空格，保留换行与偏移。"""
    out = list(text)
    n = len(text)
    i = 0
    while i < n:
        if text[i] != '`':
            i += 1
            continue
        j = i
        while j < n and text[j] == '`':
            j += 1
        run = j - i
        k = j
        close_end = -1
        while k < n:
            if text[k] == '`':
                m = k
                while m < n and text[m] == '`':
                    m += 1
                if m - k == run:
                    close_end = m
                    break
                k = m
            else:
                k += 1
        if close_end < 0:
            i = j
            continue
        for p in range(i, close_end):
            if out[p] != '\n':
                out[p] = ' '
        i = close_end
    return ''.join(out)


def iter_blocks(scannable):
    """按空行切块：行内代码跨行时才需要整块处理。"""
    cur = []
    for no, line in scannable:
        if not line.strip():
            if cur:
                yield cur
                cur = []
        else:
            cur.append((no, line))
    if cur:
        yield cur


# --------------------------------------------------------------------- Markdown 解析
def _is_escaped(text, idx):
    back = 0
    i = idx - 1
    while i >= 0 and text[i] == '\\':
        back += 1
        i -= 1
    return back % 2 == 1


def _skip_ws(text, i):
    n = len(text)
    while i < n and text[i] in ' \t\n':
        i += 1
    return i


def _match_bracket(text, i):
    """text[i:] 是 `[` 之后的内容，返回匹配 `]` 的下标；没有则 None。"""
    depth = 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '\\':
            i += 2
            continue
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _parse_destination(text, i):
    """解析 `](…)` 里的目标（含 <…> 与可选标题），返回 (dest, 结束后下标) 或 (None, i)。"""
    n = len(text)
    i = _skip_ws(text, i)
    if i >= n:
        return None, i
    buf = []
    if text[i] == '<':
        j = i + 1
        closed = False
        while j < n:
            ch = text[j]
            if ch == '\\' and j + 1 < n:
                buf.append(text[j + 1])
                j += 2
                continue
            if ch == '>':
                closed = True
                j += 1
                break
            if ch == '\n':
                return None, i
            buf.append(ch)
            j += 1
        if not closed:
            return None, i
    else:
        j = i
        depth = 0
        while j < n:
            ch = text[j]
            if ch == '\\' and j + 1 < n:
                buf.append(text[j + 1])
                j += 2
                continue
            if ch in ' \t\n':
                break
            if ch == '(':
                depth += 1
            elif ch == ')':
                if depth == 0:
                    break
                depth -= 1
            buf.append(ch)
            j += 1
    dest = ''.join(buf)

    k = _skip_ws(text, j)
    if k < n and text[k] in '"\'(':
        close = ')' if text[k] == '(' else text[k]
        m = k + 1
        end = -1
        while m < n:
            if text[m] == '\\':
                m += 2
                continue
            if text[m] == close:
                end = m + 1
                break
            m += 1
        if end < 0:
            return None, i
        k = _skip_ws(text, end)
    if k < n and text[k] == ')':
        return dest, k + 1
    return None, i


def _parse_image_at(text, idx):
    """`![` 起始处解析一张图片，返回 dict 或 None。"""
    alt_start = idx + 2
    alt_end = _match_bracket(text, alt_start)
    if alt_end is None:
        return None
    alt = text[alt_start:alt_end]
    k = alt_end + 1
    if k >= len(text):
        return None
    ch = text[k]
    base = {'offset': idx, 'alt': alt}
    if ch == '(':
        dest, end = _parse_destination(text, k + 1)
        if dest is None:
            return None
        base.update({'style': 'inline', 'dest': dest, 'raw': text[idx:end], 'end': end})
        return base
    if ch == '[':
        label_end = _match_bracket(text, k + 1)
        if label_end is None:
            return None
        label = text[k + 1:label_end].strip() or alt.strip()
        base.update({'style': 'reference', 'dest': None, 'label': _norm_label(label),
                     'raw': text[idx:label_end + 1], 'end': label_end + 1})
        return base
    label = alt.strip()
    if not label:
        return None
    base.update({'style': 'shortcut', 'dest': None, 'label': _norm_label(label),
                 'raw': text[idx:alt_end + 1], 'end': alt_end + 1})
    return base


def _norm_label(label):
    return re.sub(r'\s+', ' ', str(label or '')).strip().casefold()


def iter_image_refs(text):
    """行内 / 参考式 / 快捷参考式图片，按出现顺序产出。"""
    i = 0
    n = len(text)
    while i < n:
        idx = text.find('![', i)
        if idx < 0:
            return
        i = idx + 2
        if _is_escaped(text, idx):
            continue
        parsed = _parse_image_at(text, idx)
        if parsed:
            yield parsed


def iter_html_images(text):
    for m in IMG_TAG_RE.finditer(text):
        attrs = m.group(1)
        src_m = SRC_ATTR_RE.search(attrs)
        alt_m = ALT_ATTR_RE.search(attrs)
        src = None
        if src_m:
            src = src_m.group(1) if src_m.group(1) is not None else (
                src_m.group(2) if src_m.group(2) is not None else src_m.group(3))
        alt = None
        if alt_m:
            alt = alt_m.group(1) if alt_m.group(1) is not None else (
                alt_m.group(2) if alt_m.group(2) is not None else alt_m.group(3))
        yield {
            'offset': m.start(), 'end': m.end(), 'style': 'html', 'raw': m.group(0),
            'dest': src, 'alt': alt if alt is not None else '',
            'label': None,
        }


def _unquote_url(value):
    raw = value.strip()
    if raw.startswith('<') and raw.endswith('>'):
        raw = raw[1:-1]
    return raw


def collect_definitions(scannable):
    """收集参考式定义 `[label]: url`（只认块首行，与 CommonMark 对齐）。"""
    defs = {}
    prev = None
    for _no, line in scannable:
        if not line.strip():
            prev = None
            continue
        m = REF_DEF_RE.match(line)
        if m and (prev is None or REF_DEF_RE.match(prev)):
            label = _norm_label(m.group(1))
            dest = _unquote_url(m.group(2))
            defs.setdefault(label, dest)
        prev = line
    return defs


# --------------------------------------------------------------------- 路径分类
def classify_target(raw, base_path=DEFAULT_BASE_PATH):
    """返回 (kind, value, note)。kind 见下方文档。"""
    s = str(raw or '').strip()
    if not s:
        return 'empty', None, None
    if CTRL_RE.search(s):
        return 'unsafe', None, '地址里包含控制字符'
    if s.startswith('#'):
        return 'anchor', None, None
    if '\\' in s and not SCHEME_RE.match(s):
        return 'unsafe', None, '路径里有反斜杠（URL 必须用 /）'
    m = SCHEME_RE.match(s)
    if m:
        proto = m.group(1).lower()
        if proto == 'https':
            return 'external', s, None
        if proto == 'http':
            return 'external_http', s, None
        if proto == 'data':
            if DATA_URI_RE.match(s):
                return 'data', s, None
            return 'data_invalid', None, None
        return 'bad_scheme', proto, None
    if s.startswith('//'):
        return 'protocol_relative', s, None

    base = base_path if base_path.endswith('/') else base_path + '/'
    if s.startswith('/'):
        if s == base or s + '/' == base:
            return 'site_dir', None, None
        if s.startswith(base):
            return 'site', s[len(base):], None
        return 'site_outside', s, None
    return 'repo', s, None


def normalize_repo_path(path):
    """把 URL 路径变成仓库内 posix 相对路径，返回 (rel, error)。"""
    p = str(path or '')
    if CTRL_RE.search(p):
        return None, '路径里包含控制字符'
    if '\\' in p:
        return None, '路径里有反斜杠（URL 必须用 /）'
    cut = len(p)
    for ch in ('?', '#'):
        pos = p.find(ch)
        if pos >= 0:
            cut = min(cut, pos)
    p = p[:cut]
    try:
        p = unquote(p, encoding='utf-8', errors='strict')
    except UnicodeDecodeError:
        return None, 'URL 编码不是合法 UTF-8'
    if CTRL_RE.search(p):
        return None, '解码后包含控制字符'
    if '\\' in p:
        return None, '解码后包含反斜杠'
    parts = []
    for seg in p.split('/'):
        if seg in ('', '.'):
            continue
        if seg == '..':
            return None, '路径含 ..（会跳出站点根目录）'
        parts.append(seg)
    if not parts:
        return None, '地址指向目录而不是文件'
    return '/'.join(parts), None


def _is_within(child, parent):
    try:
        c = os.path.normcase(os.path.abspath(child))
        p = os.path.normcase(os.path.abspath(parent))
        return os.path.commonpath([c, p]) == p
    except ValueError:
        return False


def inspect_file(root, rel):
    """逐段核对磁盘（大小写严格比对），返回状态字典。"""
    root_real = os.path.realpath(root)
    cur = root_real
    parts = rel.split('/')
    case_hits = []
    actual_parts = []
    for i, part in enumerate(parts):
        try:
            with os.scandir(cur) as it:
                names = [e.name for e in it]
        except OSError:
            return {'status': 'unreadable', 'detail': '目录无法读取: %s' % cur}
        actual = part if part in names else None
        if actual is None:
            cands = sorted(n for n in names if n.casefold() == part.casefold())
            if not cands:
                return {'status': 'missing', 'detail': part}
            actual = cands[0]
            case_hits.append((part, cands))
        actual_parts.append(actual)
        cur = os.path.join(cur, actual)
        if i < len(parts) - 1:
            if os.path.islink(cur) and not os.path.exists(cur):
                return {'status': 'symlink_broken', 'detail': actual}
            if not os.path.isdir(cur):
                return {'status': 'missing', 'detail': '%s 不是目录' % actual}
    rel_actual = '/'.join(actual_parts)

    if os.path.islink(cur) and not os.path.exists(cur):
        return {'status': 'symlink_broken', 'detail': parts[-1]}
    real = os.path.realpath(cur)
    if not _is_within(real, root_real):
        return {'status': 'symlink_out', 'detail': real}
    if os.path.isdir(cur):
        return {'status': 'dir', 'detail': parts[-1]}
    if not os.path.isfile(cur):
        return {'status': 'not_file', 'detail': parts[-1]}
    if case_hits:
        # 文件在（Windows 的大小写不敏感）目录里找得到，但名字与 Markdown 不一致
        return {'status': 'case', 'size': os.path.getsize(cur), 'path': rel_actual,
                'case': case_hits}
    return {'status': 'ok', 'size': os.path.getsize(cur), 'path': rel_actual,
            'case': []}


# --------------------------------------------------------------------- 检查
def check_text(text, rel_source, root, base_path=DEFAULT_BASE_PATH, stats=None):
    """检查一篇 Markdown 正文，返回 findings 列表。"""
    stats = stats if stats is not None else new_stats()
    findings = []
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    scannable, _unclosed = iter_scan_lines(text.split('\n'))
    defs = collect_definitions(scannable)

    for block in iter_blocks(scannable):
        base_no = block[0][0]
        joined = '\n'.join(line for _no, line in block)
        cleaned = blank_inline_code(joined)
        refs = list(iter_image_refs(cleaned)) + list(iter_html_images(cleaned))
        refs.sort(key=lambda r: r['offset'])
        for ref in refs:
            line_no = base_no + cleaned.count('\n', 0, ref['offset'])
            _handle_ref(ref, line_no, rel_source, root, base_path, defs, findings, stats)
    return findings


def _handle_ref(ref, line_no, rel_source, root, base_path, defs, findings, stats):
    stats['refs'] += 1
    raw = _clip(ref.get('raw'))
    dest = ref.get('dest')
    alt = ref.get('alt')

    if ref.get('style') == 'html' and dest is None:
        findings.append(finding(WARNING, rel_source, line_no, raw,
                                'HTML <img> 没有 src，渲染后是空图',
                                '补上 src="images/x.png" 或用 Markdown 图片语法'))
        _warn_alt(alt, rel_source, line_no, raw, findings)
        return

    if ref.get('style') in ('reference', 'shortcut'):
        label = ref.get('label')
        if label and label in defs:
            dest = defs[label]
        else:
            stats['invalid'] += 1
            findings.append(finding(
                WARNING, rel_source, line_no, raw,
                '参考式图片缺少定义 `[%s]: <url>`（渲染后会显示为文本，不会 404）' % (label or ''),
                '补一行参考式定义，或改成行内写法 `![alt](images/x.png)`'))
            _warn_alt(alt, rel_source, line_no, raw, findings)
            return

    kind, value, note = classify_target(dest, base_path)
    rel = None
    info = None
    if kind in ('repo', 'site'):
        rel, err = normalize_repo_path(value)
        if err:
            kind, note = 'unsafe_path', err
        else:
            info = inspect_file(root, rel)

    if kind in ('external', 'external_http', 'protocol_relative'):
        stats['external'] += 1
    elif kind == 'data':
        stats['data'] += 1
    elif kind in ('site', 'site_dir', 'site_outside'):
        stats['site'] += 1
    elif kind == 'repo':
        stats['repo'] += 1
    else:
        stats['invalid'] += 1

    if kind == 'empty':
        findings.append(finding(ERROR, rel_source, line_no, raw, '图片地址为空',
                                '补上仓库内路径（如 images/x.png）或 https:// 地址'))
    elif kind == 'anchor':
        findings.append(finding(ERROR, rel_source, line_no, raw, '`#…` 不是图片地址',
                                '图片必须指向文件，锚点请用普通链接 [文字](#锚点)'))
    elif kind == 'unsafe':
        findings.append(finding(ERROR, rel_source, line_no, raw, '路径解析不安全：%s' % note,
                                '改用仓库内相对路径 images/x.png 或 https:// 地址'))
    elif kind == 'unsafe_path':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '本地图片路径非法：%s' % note,
                                '只用仓库内相对路径（images/x.png），不要用 .. / 反斜杠'))
    elif kind == 'bad_scheme':
        findings.append(finding(
            ERROR, rel_source, line_no, raw,
            '不支持的协议 %s:（只允许 https:// 或仓库内相对路径）' % (value or ''),
            '本地图片请放进仓库并用 images/x.png 引用；%s: 在浏览器里不会加载' % (value or '')))
    elif kind == 'data_invalid':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                'data URI 不是图片（只允许 data:image/*）',
                                '换成真实图片文件，或使用 data:image/png;base64,…'))
    elif kind == 'protocol_relative':
        findings.append(finding(WARNING, rel_source, line_no, raw,
                                '协议相对地址（//…），实际协议随页面（https）而变',
                                '写成完整的 https://… 便于审计'))
    elif kind == 'external_http':
        findings.append(finding(WARNING, rel_source, line_no, raw,
                                'http:// 外部图片：GitHub Pages 是 https，会被混合内容拦截（线上坏图）',
                                '改成 https://，或把图片放进仓库 images/'))
    elif kind == 'external':
        findings.append(finding(WARNING, rel_source, line_no, raw,
                                '外部图片：只检查格式，不联网校验，也不保证长期可访问',
                                '重要配图建议放进仓库 images/ 与文章一起提交'))
    elif kind == 'data':
        findings.append(finding(WARNING, rel_source, line_no, raw,
                                '内联 Data URI：不落仓库文件，检查器无法确认内容，也会把正文撑大',
                                '建议改为仓库内图片文件后引用 images/x.png'))
    elif kind == 'site_dir':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '站内绝对路径指向站点目录而不是图片文件',
                                '写成 /%s/x.png 或 images/x.png' % IMAGE_DIR))
    elif kind == 'site_outside':
        findings.append(finding(
            ERROR, rel_source, line_no, raw,
            '站点绝对路径 %s 不在博客子路径 %s 下（会解析到站点根，GitHub Pages 上 404）'
            % (value, base_path),
            '改写成 /%s/…（保留子路径）或相对路径 images/x.png' % base_path.strip('/')))
    elif kind in ('repo', 'site'):
        _check_local(rel, info, ref, line_no, rel_source, findings)

    _warn_alt(alt, rel_source, line_no, raw, findings)


def _warn_alt(alt, rel_source, line_no, raw, findings):
    if alt is not None and str(alt).strip():
        return
    findings.append(finding(WARNING, rel_source, line_no, raw,
                            '图片没有有效 alt（读屏与图片加载失败时看不到说明）',
                            '补上描述，如 ![焊接面宏观照片](images/x.png)'))


def _check_local(rel, info, ref, line_no, rel_source, findings):
    raw = _clip(ref.get('raw'))
    status = info['status']
    if status == 'ok':
        _warn_size_format(rel_source, line_no, raw, rel, info, findings)
    elif status == 'case':
        pairs = '；'.join('%s → 磁盘上实际是 %s' % (want, '/'.join(actual))
                         for want, actual in info['case'])
        findings.append(finding(
            ERROR, rel_source, line_no, raw,
            '文件名大小写不一致（%s）。Windows 上能打开，Linux/GitHub Pages 会 404' % pairs,
            '把 Markdown 里的路径改成与磁盘完全一致的大小写（git mv 也行）'))
    elif status == 'missing':
        detail = info.get('detail')
        extra = '（路径中 %s 不存在或不是目录）' % detail if detail else ''
        findings.append(finding(
            ERROR, rel_source, line_no, raw,
            '本地图片不存在：%s%s' % (rel, extra),
            '把原图保存到 %s（与文章一起提交），或修正引用路径' % rel))
    elif status == 'dir':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '本地引用指向目录：%s' % rel,
                                '把路径写到具体文件（如 %s/x.png）' % rel))
    elif status == 'symlink_out':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '路径经符号链接指向仓库外部：%s' % info.get('detail'),
                                '把图片复制进仓库，或改成仓库内的真实路径'))
    elif status == 'symlink_broken':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '符号链接已断（目标不存在）：%s' % info.get('detail'),
                                '修复或替换该链接指向的文件'))
    elif status == 'not_file':
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '路径不是普通文件：%s' % rel,
                                '确认这是真的图片文件（不是目录/设备/管道）'))
    else:
        findings.append(finding(ERROR, rel_source, line_no, raw,
                                '无法检查该路径：%s' % info.get('detail'),
                                '确认路径拼写与大小写'))


def _warn_size_format(rel_source, line_no, raw, rel, info, findings):
    size = info.get('size') or 0
    if size > MAX_IMAGE_BYTES:
        findings.append(finding(
            WARNING, rel_source, line_no, raw,
            '图片体积 %.1f MiB 超过编辑器建议上限 2 MiB' % (size / 1024.0 / 1024.0),
            '压缩后再提交（编辑器只接受 ≤2 MiB 的 PNG/JPEG/WebP/GIF）'))
    ext = os.path.splitext(rel)[1].lower()
    if ext in SUPPORTED_EXTS:
        return
    if ext in OTHER_EXTS:
        findings.append(finding(
            WARNING, rel_source, line_no, raw,
            '图片格式 %s 不在编辑器白名单（PNG/JPEG/WebP/GIF）内' % (ext or '无扩展名'),
            '转成 PNG/WebP 再提交，避免某些浏览器或流程不支持'))
    else:
        findings.append(finding(
            WARNING, rel_source, line_no, raw,
            '图片扩展名 %s 无法确认是图片' % (ext or '（无扩展名）'),
            '用 PNG/JPEG/WebP/GIF，并保证扩展名与实际格式一致'))


def new_stats():
    return {'posts': 0, 'refs': 0, 'repo': 0, 'site': 0, 'external': 0,
            'data': 0, 'invalid': 0, 'errors': 0, 'warnings': 0}


def collect_findings(root, base_path=DEFAULT_BASE_PATH):
    """返回 (findings, stats, posts)。结构不可用时抛 CheckError。"""
    posts_dir = os.path.join(root, POSTS_REL.replace('/', os.sep))
    if not os.path.isdir(root):
        raise CheckError('仓库根目录不存在：%s' % root)
    if not os.path.isdir(posts_dir):
        raise CheckError('找不到 %s（不是博客仓库根目录？）' % POSTS_REL)

    stats = new_stats()
    findings = []
    names = sorted(n for n in os.listdir(posts_dir)
                   if n.lower().endswith('.md') and os.path.isfile(os.path.join(posts_dir, n)))
    for name in names:
        full = os.path.join(posts_dir, name)
        rel_source = '%s/%s' % (POSTS_REL, name)
        stats['posts'] += 1
        try:
            with open(full, 'rb') as f:
                raw = f.read()
            text = raw.decode('utf-8').lstrip('\ufeff')
        except UnicodeDecodeError:
            findings.append(finding(ERROR, rel_source, 0, '', '正文不是合法 UTF-8，无法检查图片',
                                    '另存为 UTF-8 后重新检查'))
            continue
        findings.extend(check_text(text, rel_source, root, base_path, stats))

    for f in findings:
        if f['sev'] == ERROR:
            stats['errors'] += 1
        else:
            stats['warnings'] += 1
    return findings, stats, len(names)


class CheckError(Exception):
    """仓库结构不可用（不是"图片有问题"，而是根本没法检查）。"""


# --------------------------------------------------------------------- CLI / 输出
def parse_args(argv):
    ap = argparse.ArgumentParser(description='发布前图片资源检查（只读）')
    ap.add_argument('--check', action='store_true', help='检查模式（默认，也是唯一模式）')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（默认脚本所在仓库）')
    ap.add_argument('--base-path', default=DEFAULT_BASE_PATH,
                    help='GitHub Pages 子路径（默认 /blog/）')
    return ap.parse_args(argv)


def render(findings, stats, posts, root, base_path):
    lines = []
    lines.append('检查目录: %s' % root)
    lines.append('站点子路径: %s（GitHub Pages 项目站）' % base_path)
    lines.append('检查范围: %s/*.md（%d 篇）' % (POSTS_REL, posts))
    lines.append('支持语法: 行内 ![](…)、参考式 ![][label]、HTML <img src>；'
                 '代码块与行内代码里的示例会被忽略')
    if not findings:
        lines.append('引用统计: 共 %d 个图片引用' % stats['refs'])
    for f in findings:
        lines.append('')
        lines.append('[%s] %s:%d  %s' % (f['sev'] == ERROR and 'FAIL' or 'WARN',
                                          f['path'], f['line'], f['msg']))
        if f['raw']:
            lines.append('       引用: %s' % f['raw'])
        lines.append('       建议: %s' % f['fix'])
    lines.append('')
    lines.append('汇总: 引用 %d 个（仓库内 %d / 站内绝对 %d / 外部 %d / 内联 %d / 非法 %d）'
                 % (stats['refs'], stats['repo'], stats['site'], stats['external'],
                    stats['data'], stats['invalid']))
    lines.append('      ERROR %d / WARNING %d' % (stats['errors'], stats['warnings']))
    return lines


def main(argv=None):
    args = parse_args(argv)
    root = os.path.abspath(args.root)
    base_path = args.base_path or DEFAULT_BASE_PATH
    if not base_path.startswith('/'):
        base_path = '/' + base_path
    if not base_path.endswith('/'):
        base_path += '/'

    try:
        findings, stats, posts = collect_findings(root, base_path)
    except CheckError as e:
        print('[FAIL] %s' % e, file=sys.stderr)
        return 2

    print('== 图片资源检查 ==')
    for line in render(findings, stats, posts, root, base_path):
        print(line)

    if stats['errors']:
        print('\n[FAIL] 图片资源检查未通过：ERROR %d（WARNING %d 不影响退出码）'
              % (stats['errors'], stats['warnings']))
        return 1
    print('\nOK: 图片资源检查通过（ERROR 0 / WARNING %d，未修改任何文件）' % stats['warnings'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
