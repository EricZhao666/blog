#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章数据生成器（Batch 6B-2 拆分 / Batch 6C 增量维护）

权威输入（两者共同构成"真源"，缺一不可）：
    js/data.js                每篇文章的元数据（id/title/date/tags/excerpt/series…）
    data/posts/<id>.md        每篇文章的 Markdown 正文

派生产物（都由本脚本生成，请勿手改）：
    js/data.js                规范化后的元数据（补 readingMinutes、字段顺序固定）
    data/search-index.json    全文搜索语料 { id: 正文 }（首次搜索才下载）
    data/posts/manifest.json  完整性锚点（正文/元数据的 SHA256、字节、字符数）

用法：
    python scripts/split_posts.py --check             # 只校验（默认）
    python scripts/split_posts.py --sync              # 按当前元数据 + 正文重建全部派生产物
    python scripts/split_posts.py --sync --prune      # 同时删除没有元数据引用的正文文件
    python scripts/split_posts.py --extract           # 一次性迁移：从仍含 content 的 data.js 拆出正文
    python scripts/split_posts.py --check --root DIR  # 在别的目录上工作（测试用）

维护流程（发布/修改/删除）：
    1) 改 data/posts/<id>.md            → 跑 --sync（重算 readingMinutes / 搜索语料 / 校验清单）
    2) 改 js/data.js 里的标题/标签/日期 → 跑 --sync（只重算派生字段，标题等以手改为准）
    3) 新增文章：加一条元数据 + 放好 .md → 跑 --sync
    4) 删除文章：删元数据 → 跑 --sync --prune（正文孤儿会被清理）
    5) 改 id：改元数据 id + 重命名 .md → 跑 --sync
    6) 任何时候都可以跑 --check 验证；CI 会跑它

设计约束：
  - 解析用结构化字面量扫描（复用 gen_feed.py 的 scanner），不 eval、不执行数据里的任何代码；
  - 全部产物先在内存里算好并校验，再写临时文件 + os.replace 原子替换；失败不覆盖已有产物；
  - 相同输入 -> 相同输出（字段顺序固定、JSON sort_keys、LF、无 BOM）；
  - 文件名只允许 [a-z0-9-]，其余字符直接报错，避免路径逃逸/冲突。
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, REPO_DIR)

import gen_feed as g  # 复用已验证的结构化 JS 字面量扫描器（不执行代码）

SAFE_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
CJK = re.compile(r'[\u4e00-\u9fa5]')
# 与 app.js 里 readingTime() 完全等价的 ASCII 词计数（JS 的 \w 等价于 [A-Za-z0-9_]）
ASCII_WORD = re.compile(r'(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?![A-Za-z0-9_])')

STANDARD_KEYS = ['id', 'title', 'date', 'tags', 'excerpt', 'series', 'seriesOrder']
REQUIRED_KEYS = ['id', 'title', 'date', 'tags', 'excerpt']

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


def paths(root):
    return {
        'root': root,
        'data_js': os.path.join(root, 'js', 'data.js'),
        'posts_dir': os.path.join(root, 'data', 'posts'),
        'manifest': os.path.join(root, 'data', 'posts', 'manifest.json'),
        'search_index': os.path.join(root, 'data', 'search-index.json'),
    }


# ---------------------------------------------------------------- 解析
def read_text(path):
    with open(path, encoding='utf-8') as f:
        return f.read().lstrip('\ufeff')


def parse_js_file(path):
    """读取 js/data.js → (原文, POSTS, TAG_ORDER)。"""
    text = read_text(path)
    start = g.find_assignment(text, 'POSTS')
    posts, _ = g._read_value(text, start)
    if not isinstance(posts, list):
        raise SplitError('POSTS 不是数组')
    tag_start = g.find_assignment(text, 'TAG_ORDER')
    tag_order, _ = g._read_value(text, tag_start)
    if not isinstance(tag_order, list):
        raise SplitError('TAG_ORDER 不是数组')
    return text, posts, tag_order


def reading_minutes(content):
    """与 js/app.js 的 readingTime() 逐一等价：中文 400 字/分、英文 200 词/分，向上取整且至少 1。"""
    chinese = len(CJK.findall(content))
    english = len(ASCII_WORD.findall(CJK.sub('', content)))
    return max(1, int(math.ceil(chinese / 400.0 + english / 200.0)))


def body_path(p, pid):
    return os.path.join(p['posts_dir'], pid + '.md')


def load_body(p, pid):
    path = body_path(p, pid)
    if not os.path.exists(path):
        raise SplitError('缺少正文文件: data/posts/%s.md' % pid)
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError as e:
        raise SplitError('正文不是合法 UTF-8: data/posts/%s.md（%s）' % (pid, e))


def normalize_meta(post, content):
    """去 content、补 readingMinutes、保留未知字段；返回字段顺序固定的 dict。"""
    pid = post.get('id')
    if not isinstance(pid, str) or not SAFE_ID.match(pid):
        raise SplitError('非法文章 id（只允许 [a-z0-9-]）: %r' % pid)
    for key in REQUIRED_KEYS:
        if key not in post:
            raise SplitError('%s 缺少字段 %s' % (pid, key))
    if not isinstance(post['title'], str) or not post['title'].strip():
        raise SplitError('%s 的 title 不能为空' % pid)
    if not DATE_RE.match(str(post['date'])):
        raise SplitError('%s 的 date 必须是 YYYY-MM-DD: %r' % (pid, post['date']))
    if not isinstance(post['tags'], list) or not all(isinstance(t, str) and t for t in post['tags']):
        raise SplitError('%s 的 tags 必须是非空字符串数组' % pid)
    if not isinstance(post['excerpt'], str):
        raise SplitError('%s 的 excerpt 必须是字符串' % pid)

    meta = {k: post[k] for k in STANDARD_KEYS if k in post}
    # 未知字段原样保留（避免维护脚本吃掉未来新增的元数据）
    extras = [(k, v) for k, v in post.items() if k not in STANDARD_KEYS and k != 'content']
    meta['readingMinutes'] = reading_minutes(content)
    for k, v in extras:
        meta[k] = v
    return meta


def meta_canonical(meta):
    return json.dumps(meta, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_bytes(buf):
    return hashlib.sha256(buf).hexdigest()


# ---------------------------------------------------------------- 序列化
def js_string(value):
    """Python 字符串 → JS 单引号字符串字面量。"""
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


def js_literal(value):
    if isinstance(value, str):
        return js_string(value)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return 'null'
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return '[' + ', '.join(js_literal(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{ ' + ', '.join('%s: %s' % (js_string(k), js_literal(v)) for k, v in value.items()) + ' }'
    raise SplitError('无法序列化的元数据字段类型: %r' % (value,))


def render_data_js(metas, tag_order):
    lines = [HEADER.rstrip('\n'), '', 'const POSTS = [']
    for i, m in enumerate(metas):
        lines.append('  {')
        fields = []
        for key in STANDARD_KEYS + ['readingMinutes']:
            if key not in m:
                continue
            val = m[key]
            if key == 'readingMinutes':
                fields.append('    readingMinutes: %d' % val)
            elif key == 'seriesOrder':
                fields.append('    seriesOrder: %d' % val)
            elif key == 'tags':
                fields.append('    tags: [%s]' % ', '.join(js_string(t) for t in val))
            else:
                fields.append('    %s: %s' % (key, js_string(val)))
        for key, val in m.items():
            if key in STANDARD_KEYS or key == 'readingMinutes':
                continue
            fields.append('    %s: %s' % (key, js_literal(val)))
        lines.append(',\n'.join(fields))
        lines.append('  }' + (',' if i < len(metas) - 1 else ''))
    lines.append('];')
    lines.append('')
    lines.append('// 标签信息（自动从文章中提取，这里用于排序）')
    lines.append('const TAG_ORDER = [%s];' % ', '.join(js_string(t) for t in tag_order))
    lines.append('')
    return '\n'.join(lines)


# ---------------------------------------------------------------- 构建
def build(p, metas, bodies, tag_order, source_info):
    """返回 ({相对路径: bytes}, manifest)。所有校验失败都在写盘前抛出。"""
    data_js = render_data_js(metas, tag_order).encode('utf-8')

    search = {m['id']: bodies[m['id']] for m in metas}
    search_json = json.dumps(search, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')

    manifest = {
        'version': 2,
        'generator': 'scripts/split_posts.py',
        'source': source_info,
        'readingMinutesRule': 'app.js readingTime(): ceil(中文/400 + 英文/200)，至少 1',
        'tagOrder': list(tag_order),
        'searchIndex': {'path': 'data/search-index.json', 'sha256': sha256_bytes(search_json), 'bytes': len(search_json)},
        'posts': [{
            'id': m['id'],
            'file': 'data/posts/%s.md' % m['id'],
            'contentSha256': sha256_bytes(bodies[m['id']].encode('utf-8')),
            'contentBytes': len(bodies[m['id']].encode('utf-8')),
            'contentChars': len(bodies[m['id']]),
            'metaSha256': sha256_bytes(meta_canonical(m).encode('utf-8')),
            'readingMinutes': m['readingMinutes'],
        } for m in metas],
    }
    manifest_json = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode('utf-8') + b'\n'

    artifacts = {'js/data.js': data_js, 'data/search-index.json': search_json, 'data/posts/manifest.json': manifest_json}
    for m in metas:
        artifacts['data/posts/%s.md' % m['id']] = bodies[m['id']].encode('utf-8')
    return artifacts, manifest


def atomic_write(root, artifacts, only=None):
    """先写同目录临时文件，再逐个 os.replace；写完回读校验。"""
    written = []
    keys = [k for k in sorted(artifacts) if only is None or k in only]
    try:
        for rel in keys:
            buf = artifacts[rel]
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
    for rel in keys:
        with open(os.path.join(root, rel.replace('/', os.sep)), 'rb') as f:
            if f.read() != artifacts[rel]:
                raise SplitError('写入后校验失败: %s' % rel)


# ---------------------------------------------------------------- 输入装配
def collect(p, mode):
    """读取当前元数据 + 正文，返回 (metas, bodies, tag_order, source_info, orphans)。"""
    data_text, posts, tag_order = parse_js_file(p['data_js'])
    metas, bodies = [], {}
    seen = set()
    for post in posts:
        pid = post.get('id')
        if 'content' in post:
            if mode == 'extract':
                content = post['content']
            else:
                raise SplitError('%s 仍带 content：请先跑 --extract，或删除该字段（正文应放在 data/posts/%s.md）' % (pid, pid))
        else:
            content = load_body(p, pid)
        if pid in seen:
            raise SplitError('重复文章 id: %s' % pid)
        seen.add(pid)
        metas.append(normalize_meta(post, content))
        bodies[pid] = content

    orphans = []
    if os.path.isdir(p['posts_dir']):
        orphans = sorted(n[:-3] for n in os.listdir(p['posts_dir'])
                         if n.endswith('.md') and n[:-3] not in seen)
    source_info = {
        'mode': mode,
        'path': 'js/data.js',
        'sha256': sha256_bytes(data_text.encode('utf-8')),
        'bytes': len(data_text.encode('utf-8')),
        'posts': len(metas),
        'contentChars': sum(len(bodies[m['id']]) for m in metas),
    }
    return metas, bodies, tag_order, source_info, orphans


def describe_orphans(orphans):
    return '、'.join('data/posts/%s.md' % o for o in orphans)


# ---------------------------------------------------------------- 校验
def verify(p):
    """只读校验：产物必须能被重新生成出来，且与磁盘逐字节一致。"""
    problems = []
    if not os.path.exists(p['manifest']):
        return None, ['缺少 data/posts/manifest.json（先跑 --sync 或 --extract）']
    manifest_disk = json.loads(read_text(p['manifest']))

    try:
        metas, bodies, tag_order, source_info, orphans = collect(p, 'check')
    except SplitError as e:
        return manifest_disk, [str(e)]

    if orphans:
        problems.append('存在没有元数据引用的正文文件: ' + describe_orphans(orphans))

    # 用当前输入重建：既验证"生成器可重复执行"，也验证磁盘产物没有手改过。
    # source 块记录的是"当初由哪次输入生成"（extract 时是含正文的旧文件），
    # 无法由当前输入还原，因此沿用磁盘上的那份再比较其余部分。
    source_info = manifest_disk.get('source', source_info)
    expected, manifest_expected = build(p, metas, bodies, tag_order, source_info)

    for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json']:
        path = os.path.join(p['root'], rel.replace('/', os.sep))
        if not os.path.exists(path):
            problems.append('产物缺失: ' + rel)
            continue
        with open(path, 'rb') as f:
            if f.read() != expected[rel]:
                problems.append('产物与重新生成的结果不一致（请跑 --sync）: ' + rel)

    for post in manifest_expected['posts']:
        rec = next((x for x in manifest_disk.get('posts', []) if x['id'] == post['id']), None)
        if not rec:
            problems.append('manifest 缺少文章: ' + post['id'])
            continue
        for key in ['contentSha256', 'contentBytes', 'contentChars', 'metaSha256', 'readingMinutes', 'file']:
            if rec.get(key) != post.get(key):
                problems.append('manifest.%s 与正文不一致: %s' % (key, post['id']))
    if len(manifest_disk.get('posts', [])) != len(metas):
        problems.append('manifest 文章数 %d 与元数据 %d 不一致' % (len(manifest_disk.get('posts', [])), len(metas)))

    # 搜索语料必须覆盖全部文章且与正文逐字一致（重建已保证，这里再给出显式证据）
    with open(p['search_index'], 'rb') as f:
        search = json.loads(f.read().decode('utf-8'))
    if sorted(search.keys()) != sorted(m['id'] for m in metas):
        problems.append('搜索索引覆盖的文章集合与元数据不一致')
    for m in metas:
        if search.get(m['id']) != bodies[m['id']]:
            problems.append('搜索索引与正文不一致: ' + m['id'])

    return manifest_expected, problems


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description='文章数据生成器（元数据 + 正文 → 派生产物）')
    ap.add_argument('--extract', action='store_true', help='一次性迁移：从仍含 content 的 js/data.js 拆出正文')
    ap.add_argument('--sync', action='store_true', help='按当前元数据 + 正文重建派生产物')
    ap.add_argument('--check', action='store_true', help='只校验（默认）')
    ap.add_argument('--prune', action='store_true', help='--sync 时删除没有元数据引用的正文文件')
    ap.add_argument('--dry-run', action='store_true', help='只打印将写出/删除的文件，不落盘')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（默认脚本所在仓库，测试可指向临时副本）')
    args = ap.parse_args(argv)

    p = paths(os.path.abspath(args.root))
    mode = 'extract' if args.extract else ('sync' if args.sync else 'check')

    if mode == 'check':
        manifest, problems = verify(p)
        if manifest is None:
            for msg in problems:
                print('  [FAIL] ' + msg)
            return 1
        print('校验对象: %d 篇文章，正文 %d 字符' % (len(manifest['posts']), manifest['source']['contentChars']))
        if problems:
            for msg in problems:
                print('  [FAIL] ' + msg)
            return 1
        print('OK: 元数据 / 正文 / 搜索索引 / 完整性清单 一致，且可由当前输入重新生成')
        return 0

    try:
        metas, bodies, tag_order, source_info, orphans = collect(p, mode)
    except SplitError as e:
        print('[FAIL] ' + str(e))
        return 1

    if orphans and not args.prune:
        print('[FAIL] 存在没有元数据引用的正文文件（确认要删除请加 --prune）: ' + describe_orphans(orphans))
        return 1

    artifacts, manifest = build(p, metas, bodies, tag_order, source_info)
    changed = []
    for rel, buf in sorted(artifacts.items()):
        path = os.path.join(p['root'], rel.replace('/', os.sep))
        old = None
        if os.path.exists(path):
            with open(path, 'rb') as f:
                old = f.read()
        if old != buf:
            changed.append(rel)

    print('%s：%d 篇文章，正文 %d 字符' % ('迁移' if mode == 'extract' else '重建', len(metas), source_info['contentChars']))
    print('  待更新 %d 个文件' % len(changed))
    for rel in changed:
        print('    %-40s %7d B' % (rel, len(artifacts[rel])))
    if orphans:
        print('  将删除 %d 个孤儿正文文件' % len(orphans))
        for o in orphans:
            print('    data/posts/%s.md' % o)
    if args.dry_run:
        print('（--dry-run，未写入）')
        return 0

    atomic_write(p['root'], artifacts)
    for o in orphans:
        os.unlink(body_path(p, o))

    _, problems = verify(p)
    if problems:
        for msg in problems:
            print('  [FAIL] ' + msg)
        return 1
    print('OK: 已写入并通过回读校验')
    return 0


if __name__ == '__main__':
    sys.exit(main())
