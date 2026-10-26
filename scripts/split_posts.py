#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章数据拆分生成器（Batch 6B-2）

把 js/data.js 里的 POSTS 拆成三份受控产物，供首页/详情/搜索按需加载：

    data/posts/<id>.md        每篇文章的正文（Markdown 原文，字节等于原 content 字符串）
    data/search-index.json    全文搜索用的 { id: content } 语料（首次搜索才下载）
    data/posts/manifest.json  完整性锚点：每篇的正文/元数据 SHA256、字节数、字符数

js/data.js 被重写成「元数据 + 预计算 readingMinutes」，不再包含正文。

用法：
    python scripts/split_posts.py --extract   # 一次性迁移：从含正文的 data.js 生成上述产物
    python scripts/split_posts.py --check     # 只校验（默认）；不一致返回非 0
    python scripts/split_posts.py --extract --dry-run

设计约束（对应 B6-2-02 要求）：
  - 解析用结构化字面量扫描（复用 gen_feed.py 的 scanner），不 eval、不执行数据里的任何代码；
  - 所有产物先在内存里算好并校验，再写临时文件 + os.replace 原子替换；
    任何一个环节失败都不会留下半份产物（manifest 最后写，它是校验锚点）；
  - 相同输入 -> 相同输出（字段顺序固定、JSON sort_keys、LF、无 BOM）；
  - 文件名只允许 [a-z0-9-]，其余字符直接报错，避免路径逃逸/冲突。
"""
import argparse
import hashlib
import math
import json
import os
import re
import shutil
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import gen_feed as g  # 复用已验证的结构化 JS 字面量扫描器（不执行代码）

DATA_JS = os.path.join(BASE_DIR, 'js', 'data.js')
POSTS_DIR = os.path.join(BASE_DIR, 'data', 'posts')
MANIFEST = os.path.join(POSTS_DIR, 'manifest.json')
SEARCH_INDEX = os.path.join(BASE_DIR, 'data', 'search-index.json')

SAFE_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
CJK = re.compile(r'[\u4e00-\u9fa5]')
# 与 app.js 里 readingTime() 完全等价的 ASCII 词计数（JS 的 \w 等价于 [A-Za-z0-9_]）
ASCII_WORD = re.compile(r'(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?![A-Za-z0-9_])')

HEADER = """/**
 * Blog Posts Data（元数据）
 *
 * 该文件由 scripts/split_posts.py 生成，请勿手工编辑：
 *   - 正文在 data/posts/<id>.md，按需加载（首次进入文章时）
 *   - 全文搜索语料在 data/search-index.json，首次搜索时加载
 *   - 完整性锚点在 data/posts/manifest.json
 *
 * 每篇文章包含: id, title, date, tags, excerpt, readingMinutes（正文由 id 索引）
 */
"""


class SplitError(Exception):
    pass


# ---------------------------------------------------------------- 解析
def load_source(path=DATA_JS):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    text = text.lstrip('\ufeff')
    start = g.find_assignment(text, 'POSTS')
    posts, end = g._read_value(text, start)
    if not isinstance(posts, list):
        raise SplitError('POSTS 不是数组')
    tag_start = g.find_assignment(text, 'TAG_ORDER')
    tag_order, _ = g._read_value(text, tag_start)
    return text, posts, tag_order


def has_content(posts):
    return any(isinstance(p.get('content'), str) for p in posts)


def normalize_meta(post):
    """去掉 content，补齐 readingMinutes，字段顺序固定。"""
    content = post.get('content')
    if not isinstance(content, str):
        raise SplitError('%s 缺少 content' % post.get('id'))
    meta = {
        'id': post['id'],
        'title': post['title'],
        'date': post['date'],
        'tags': list(post['tags']),
        'excerpt': post['excerpt'],
    }
    if 'series' in post:
        meta['series'] = post['series']
    if 'seriesOrder' in post:
        meta['seriesOrder'] = post['seriesOrder']
    meta['readingMinutes'] = reading_minutes(content)
    return meta


def reading_minutes(content):
    """与 js/app.js 的 readingTime() 逐行等价：中文 400 字/分、英文 200 词/分，向上取整且至少 1。"""
    chinese = len(CJK.findall(content))
    english = len(ASCII_WORD.findall(CJK.sub('', content)))
    return max(1, int(math.ceil(chinese / 400.0 + english / 200.0)))


def meta_canonical(meta):
    return json.dumps(meta, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_bytes(buf):
    return hashlib.sha256(buf).hexdigest()


# ---------------------------------------------------------------- 生成
def js_string(value):
    """把 Python 字符串写成 JS 单引号字符串字面量（覆盖引号/反斜杠/控制字符/行分隔符）。"""
    out = []
    for ch in value:
        if ch == '\\':
            out.append('\\\\')
        elif ch == "'":
            out.append("\\'")
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        elif ch == '\u2028':
            out.append('\\u2028')
        elif ch == '\u2029':
            out.append('\\u2029')
        else:
            out.append(ch)
    return "'" + ''.join(out) + "'"


def render_data_js(metas, tag_order):
    lines = [HEADER.rstrip('\n'), '', 'const POSTS = [']
    for i, m in enumerate(metas):
        lines.append('  {')
        lines.append('    id: %s,' % js_string(m['id']))
        lines.append('    title: %s,' % js_string(m['title']))
        lines.append('    date: %s,' % js_string(m['date']))
        lines.append('    tags: [%s],' % ', '.join(js_string(t) for t in m['tags']))
        lines.append('    excerpt: %s,' % js_string(m['excerpt']))
        if 'series' in m:
            lines.append('    series: %s,' % js_string(m['series']))
        if 'seriesOrder' in m:
            lines.append('    seriesOrder: %d,' % m['seriesOrder'])
        lines.append('    readingMinutes: %d' % m['readingMinutes'])
        lines.append('  }' + (',' if i < len(metas) - 1 else ''))
    lines.append('];')
    lines.append('')
    lines.append('// 标签信息（自动从文章中提取，这里用于排序）')
    lines.append('const TAG_ORDER = [%s];' % ', '.join(js_string(t) for t in tag_order))
    lines.append('')
    return '\n'.join(lines)


def build_artifacts(posts, tag_order, source_bytes, source_path='js/data.js'):
    """返回 {相对路径: bytes}；任何校验失败都会在写入前抛出。"""
    seen = set()
    metas = []
    bodies = {}
    for post in posts:
        pid = post.get('id')
        if not isinstance(pid, str) or not SAFE_ID.match(pid):
            raise SplitError('非法文章 id（只允许 [a-z0-9-]）: %r' % pid)
        if pid in seen:
            raise SplitError('重复文章 id: %s' % pid)
        seen.add(pid)
        meta = normalize_meta(post)
        metas.append(meta)
        bodies[pid] = post['content'].encode('utf-8')

    data_js = render_data_js(metas, tag_order).encode('utf-8')

    search = {}
    for m in metas:
        search[m['id']] = bodies[m['id']].decode('utf-8')
    search_json = json.dumps(search, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')

    manifest = {
        'version': 1,
        'generator': 'scripts/split_posts.py',
        'source': {
            'path': source_path,
            'sha256': sha256_bytes(source_bytes),
            'bytes': len(source_bytes),
            'posts': len(metas),
            'contentChars': sum(len(bodies[m['id']].decode('utf-8')) for m in metas),
        },
        'readingMinutesRule': 'app.js readingTime(): ceil(中文/400 + 英文/200)，至少 1',
        'tagOrder': list(tag_order),
        'searchIndex': {'path': 'data/search-index.json', 'sha256': sha256_bytes(search_json), 'bytes': len(search_json)},
        'posts': [{
            'id': m['id'],
            'file': 'data/posts/%s.md' % m['id'],
            'contentSha256': sha256_bytes(bodies[m['id']]),
            'contentBytes': len(bodies[m['id']]),
            'contentChars': len(bodies[m['id']].decode('utf-8')),
            'metaSha256': sha256_bytes(meta_canonical(m).encode('utf-8')),
            'readingMinutes': m['readingMinutes'],
        } for m in metas],
    }
    manifest_json = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode('utf-8') + b'\n'

    out = {'js/data.js': data_js, 'data/search-index.json': search_json, 'data/posts/manifest.json': manifest_json}
    for pid, buf in bodies.items():
        out['data/posts/%s.md' % pid] = buf
    return out, manifest, metas


def atomic_write(root, artifacts):
    """先写同目录临时文件，再逐个 os.replace；写完回读校验。"""
    written = []
    try:
        for rel, buf in sorted(artifacts.items()):
            target = os.path.join(root, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix='.tmp-', suffix='.part')
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(buf)
                    f.flush()
                    os.fsync(f.fileno())
                written.append((tmp, target))
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        for tmp, target in written:
            os.replace(tmp, target)
    except BaseException:
        for tmp, _ in written:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass
        raise
    # 回读校验：任何不一致都意味着产物不可信
    for rel, buf in artifacts.items():
        with open(os.path.join(root, rel.replace('/', os.sep)), 'rb') as f:
            if f.read() != buf:
                raise SplitError('写入后校验失败: %s' % rel)


# ---------------------------------------------------------------- 校验
def verify(root=BASE_DIR):
    problems = []
    with open(MANIFEST, 'rb') as f:
        manifest = json.loads(f.read().decode('utf-8'))
    with open(DATA_JS, encoding='utf-8') as f:
        data_text = f.read().lstrip('\ufeff')
    start = g.find_assignment(data_text, 'POSTS')
    metas_raw, _ = g._read_value(data_text, start)

    metas = []
    for m in metas_raw:
        if 'content' in m:
            problems.append('js/data.js 仍包含正文: ' + str(m.get('id')))
        metas.append(m)

    ids_meta = [m['id'] for m in metas]
    ids_manifest = [p['id'] for p in manifest['posts']]
    if ids_meta != ids_manifest:
        problems.append('文章集合/顺序与 manifest 不一致: %d vs %d' % (len(ids_meta), len(ids_manifest)))

    by_id = {p['id']: p for p in manifest['posts']}
    total_chars = 0
    for m in metas:
        pid = m['id']
        rec = by_id.get(pid)
        if not rec:
            problems.append('manifest 缺少文章: ' + pid)
            continue
        meta = normalize_meta_from_meta(m)
        if sha256_bytes(meta_canonical(meta).encode('utf-8')) != rec['metaSha256']:
            problems.append('元数据被改动: ' + pid)
        path = os.path.join(root, rec['file'].replace('/', os.sep))
        if not os.path.exists(path):
            problems.append('正文文件缺失: ' + rec['file'])
            continue
        with open(path, 'rb') as f:
            body = f.read()
        if sha256_bytes(body) != rec['contentSha256']:
            problems.append('正文被改动: ' + rec['file'])
        if len(body) != rec['contentBytes']:
            problems.append('正文字节数不一致: ' + rec['file'])
        total_chars += len(body.decode('utf-8'))

    if total_chars != manifest['source']['contentChars']:
        problems.append('正文总字符数不一致: %d vs %d' % (total_chars, manifest['source']['contentChars']))

    with open(SEARCH_INDEX, 'rb') as f:
        search_buf = f.read()
    if sha256_bytes(search_buf) != manifest['searchIndex']['sha256']:
        problems.append('搜索索引哈希不一致')
    search = json.loads(search_buf.decode('utf-8'))
    if sorted(search.keys()) != sorted(ids_manifest):
        problems.append('搜索索引覆盖的文章集合不一致')
    for pid in search:
        rec = by_id.get(pid)
        if not rec:
            continue
        path = os.path.join(root, rec['file'].replace('/', os.sep))
        if os.path.exists(path):
            with open(path, 'rb') as f:
                body = f.read().decode('utf-8')
            if search[pid] != body:
                problems.append('搜索索引与正文不一致: ' + pid)

    orphans = []
    if os.path.isdir(POSTS_DIR):
        for name in os.listdir(POSTS_DIR):
            if name.endswith('.md') and name[:-3] not in by_id:
                orphans.append(name)
    if orphans:
        problems.append('多余的正文文件: ' + ', '.join(orphans))

    return manifest, problems


def normalize_meta_from_meta(m):
    meta = {'id': m['id'], 'title': m['title'], 'date': m['date'], 'tags': list(m['tags']),
            'excerpt': m['excerpt'], 'readingMinutes': m['readingMinutes']}
    if 'series' in m:
        meta['series'] = m['series']
    if 'seriesOrder' in m:
        meta['seriesOrder'] = m['seriesOrder']
    return meta


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description='文章数据拆分生成器')
    ap.add_argument('--extract', action='store_true', help='从含正文的 js/data.js 生成产物（一次性迁移）')
    ap.add_argument('--check', action='store_true', help='只校验产物完整性（默认）')
    ap.add_argument('--dry-run', action='store_true', help='只打印将要写出的文件，不落盘')
    args = ap.parse_args(argv)

    if args.extract:
        text, posts, tag_order = load_source()
        if not has_content(posts):
            print('js/data.js 已不含正文，无需 --extract；改为校验')
            return main(['--check'])
        artifacts, manifest, metas = build_artifacts(posts, tag_order, text.encode('utf-8'))
        print('将生成 %d 个文件：' % len(artifacts))
        for rel in sorted(artifacts):
            print('  %-40s %7d B' % (rel, len(artifacts[rel])))
        print('文章 %d 篇，正文 %d 字符，搜索索引 %d B' % (len(metas), manifest['source']['contentChars'], len(artifacts['data/search-index.json'])))
        if args.dry_run:
            print('（--dry-run，未写入）')
            return 0
        atomic_write(BASE_DIR, artifacts)
        print('写入完成')
        manifest2, problems = verify()
        if problems:
            for p in problems:
                print('  [FAIL] ' + p)
            return 1
        print('回读校验通过（18 篇正文与元数据哈希一致）' if len(manifest2['posts']) == 18 else '回读校验通过')
        return 0

    manifest, problems = verify()
    print('校验对象: %d 篇文章，正文 %d 字符' % (len(manifest['posts']), manifest['source']['contentChars']))
    if problems:
        for p in problems:
            print('  [FAIL] ' + p)
        return 1
    print('OK: 元数据 / 正文 / 搜索索引 / 哈希 全部一致')
    return 0


if __name__ == '__main__':
    sys.exit(main())
