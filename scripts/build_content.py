#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一内容构建器（Batch 7C-2）。

一条命令把"权威源"编译成"派生数据"，并在**全量计算 + 全量校验之后**才写盘：

    权威源（A 类）
        js/data.js            文章元数据（id/title/date/tags/excerpt/series…）
        data/posts/<id>.md    正文（Markdown）
        js/user-posts.js      旧编辑器文章（元数据 + 正文内联）—— 兼容期输入，可为空
    派生产物（B 类）
        js/data.js                    规范化后的元数据（只补 readingMinutes、固定字段顺序）
        data/search-index.json        全文搜索语料（内置 + 旧编辑器文章，同一个 id 集合）
        data/posts/manifest.json      完整性锚点（哈希/字节/字符数）
        feed.xml                      RSS 2.0

统一文章契约（id 全局唯一，缺一即失败）
----------------------------------------
    id      必填，^[a-z0-9][a-z0-9-]*$，跨**全部来源**唯一
    title   必填，非空字符串
    date    必填，YYYY-MM-DD 且必须是真实日期
    tags    必填，非空字符串数组
    excerpt 必填，字符串（可为空串）
    content 必填，对应 data/posts/<id>.md（旧编辑器文章为内联 content），必须非空
    其余字段（series / seriesOrder / 未来新增）原样保留

失败策略（与 split_posts.py / gen_feed.py 保持一致）
--------------------------------------------------
  * 任何校验失败都在写盘前抛出，已有产物**一个字节都不会变**；
  * 非法数据返回非零退出码，绝不静默跳过、绝不静默删除历史文章；
  * 逐文件写临时文件 + os.replace —— 这是**单文件原子**，
    **不宣称**整个文件集合是一次事务：中途崩溃可能留下"部分新、部分旧"，
    这种情况由下一次 `--check` 检出并由 CI 拦下（见报告"失败原子性边界"）。

用法：
    python scripts/build_content.py --check              # 只校验（默认，不写任何文件）
    python scripts/build_content.py --dry-run            # 只报告将变更哪些文件
    python scripts/build_content.py --sync               # 重建全部派生产物
    python scripts/build_content.py --sync --root DIR    # 在临时副本上工作（测试用）
    python scripts/build_content.py --check --now 2026-11-09T00:00:00Z   # 固定 feed 时间戳
"""
import argparse
import datetime
import errno
import json
import os
import re
import sys
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, REPO_DIR)
sys.path.insert(0, SCRIPT_DIR)

import gen_feed as g          # noqa: E402  结构化 JS 字面量扫描 + RSS 渲染
import split_posts as sp      # noqa: E402  元数据/正文解析 + 序列化（Batch 6 已验证）

GENERATOR = 'scripts/build_content.py'
LOCK_NAME = '.content-build.lock'
FEED_STAMP_RE = re.compile(r'<lastBuildDate>[^<]*</lastBuildDate>')
USER_POSTS_LABEL = 'js/user-posts.js'


class BuildError(Exception):
    """输入不合法 / 契约被破坏：必须中止，且不得写盘。"""


class LockBusy(Exception):
    """另一个构建进程正在同一个 root 上工作。"""


# --------------------------------------------------------------------- 路径
def paths(root):
    p = sp.paths(root)
    p['user_posts'] = os.path.join(root, 'js', 'user-posts.js')
    p['feed'] = os.path.join(root, 'feed.xml')
    p['lock'] = os.path.join(root, LOCK_NAME)
    return p


# --------------------------------------------------------------------- 读取
def _read_text(path):
    try:
        with open(path, 'rb') as f:
            raw = f.read()
    except OSError as e:
        raise BuildError('无法读取 %s：%s' % (path, e))
    try:
        return raw.decode('utf-8').lstrip('\ufeff')
    except UnicodeDecodeError as e:
        raise BuildError('不是合法 UTF-8：%s（%s）' % (path, e))


def load_user_posts(path):
    """读取旧编辑器的 js/user-posts.js（可为空数组；文件不存在等价于空）。"""
    if not os.path.isfile(path):
        return []
    text = _read_text(path)
    try:
        start = g.find_assignment(text, 'USER_POSTS')
    except Exception as e:                     # gen_feed 的扫描器抛的是 FeedError
        raise BuildError('%s 中找不到 USER_POSTS：%s' % (USER_POSTS_LABEL, e))
    if start >= len(text) or text[start] != '[':
        raise BuildError('%s 中的 USER_POSTS 不是数组字面量' % USER_POSTS_LABEL)
    end = g._skip_balanced(text, start)
    try:
        raw = json.loads(text[start:end])
    except ValueError as e:
        raise BuildError('%s 不是合法 JSON：%s' % (USER_POSTS_LABEL, e))
    if not isinstance(raw, list):
        raise BuildError('%s 中的 USER_POSTS 不是数组' % USER_POSTS_LABEL)
    return [_legacy_post(item, i) for i, item in enumerate(raw)]


def _legacy_post(raw, index):
    """校验旧编辑器文章（含内联 content）。任何缺字段都直接失败，不静默跳过。"""
    where = '%s 第 %d 条' % (USER_POSTS_LABEL, index + 1)
    if not isinstance(raw, dict):
        raise BuildError('%s 不是对象' % where)
    pid = raw.get('id')
    if not isinstance(pid, str) or not sp.SAFE_ID.match(pid or ''):
        raise BuildError('%s 的 id 非法（只允许 [a-z0-9-]）：%r' % (where, pid))
    post = _validate_fields(raw, where, pid)
    content = raw.get('content')
    if not isinstance(content, str) or not content.strip():
        raise BuildError('%s（%s）缺少正文 content' % (where, pid))
    post['content'] = content
    post['origin'] = USER_POSTS_LABEL
    post['readingMinutes'] = sp.reading_minutes(content)
    return post


def _validate_fields(raw, where, pid):
    """title / date / tags / excerpt 的统一校验（内置与旧编辑器文章共用）。"""
    title = raw.get('title')
    if not isinstance(title, str) or not title.strip():
        raise BuildError('%s（%s）的 title 不能为空' % (where, pid))
    date = raw.get('date')
    if not isinstance(date, str) or not sp.DATE_RE.match(date.strip()):
        raise BuildError('%s（%s）的 date 必须是 YYYY-MM-DD：%r' % (where, pid, date))
    date = date.strip()
    try:
        datetime.datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise BuildError('%s（%s）的 date 不是真实日期：%r' % (where, pid, date))
    tags = raw.get('tags')
    if not isinstance(tags, list) or not all(isinstance(t, str) and t for t in tags):
        raise BuildError('%s（%s）的 tags 必须是非空字符串数组' % (where, pid))
    excerpt = raw.get('excerpt')
    if not isinstance(excerpt, str):
        raise BuildError('%s（%s）的 excerpt 必须是字符串' % (where, pid))
    post = {
        'id': pid,
        'title': title,
        'date': date,
        'tags': list(tags),
        'excerpt': excerpt,
    }
    for key in sp.STANDARD_KEYS:
        if key in ('id', 'title', 'date', 'tags', 'excerpt'):
            continue
        if key in raw:
            post[key] = raw[key]
    for key, val in raw.items():
        if key in sp.STANDARD_KEYS or key in ('content', 'readingMinutes', 'origin', 'source'):
            continue
        post[key] = val
    return post


# --------------------------------------------------------------------- 装配
def collect(p):
    """读取全部权威源，返回生效文章集合（内置优先，随后旧编辑器文章）。"""
    try:
        data_text, raw_posts, tag_order = sp.parse_js_file(p['data_js'])
    except sp.SplitError as e:
        raise BuildError(str(e))
    except Exception as e:
        raise BuildError('解析 js/data.js 失败：%s' % e)
    if not isinstance(tag_order, list):
        raise BuildError('TAG_ORDER 不是数组')

    built_in, bodies = [], {}
    for raw in raw_posts:
        pid = raw.get('id')
        where = 'js/data.js'
        if not isinstance(pid, str) or not sp.SAFE_ID.match(pid or ''):
            raise BuildError('%s 中存在非法 id（只允许 [a-z0-9-]）：%r' % (where, pid))
        if 'content' in raw:
            raise BuildError('%s（%s）仍带内联 content：请把正文放到 data/posts/%s.md'
                             % (where, pid, pid))
        try:
            body = sp.load_body(p, pid)          # 缺正文 / 非法 UTF-8 都在这里报错
        except sp.SplitError as e:
            raise BuildError(str(e))
        post = _validate_fields(raw, where, pid)
        post['content'] = body
        post['origin'] = 'data/posts/%s.md' % pid
        post['readingMinutes'] = sp.reading_minutes(body)
        built_in.append(post)
        bodies[pid] = body

    legacy = load_user_posts(p['user_posts'])

    # 全局唯一：内置 ↔ 旧编辑器、旧编辑器内部，任何重复都直接失败（P13b）
    seen = {}
    for post in built_in + legacy:
        pid = post['id']
        if pid in seen:
            raise BuildError(
                '文章 id 重复：%r 同时出现在 %s 与 %s（不会静默丢弃任何一边，'
                '请先合并或改 id）' % (pid, seen[pid], post['origin']))
        seen[pid] = post['origin']

    return {
        'built_in': built_in,
        'legacy': legacy,
        'all': built_in + legacy,
        'bodies': bodies,
        'tag_order': tag_order,
        'data_text': data_text,
    }


def check_orphans(p, built_in_ids):
    """正文文件必须在元数据里有引用；孤儿只报告、绝不自动删除。"""
    if not os.path.isdir(p['posts_dir']):
        return []
    return sorted(n[:-3] for n in os.listdir(p['posts_dir'])
                  if n.endswith('.md') and n[:-3] not in built_in_ids)


# --------------------------------------------------------------------- 生成
def build_artifacts(p, state, source_info):
    built_in = state['built_in']
    legacy = state['legacy']
    bodies = state['bodies']

    # 只把"元数据字段"交给 normalize_meta；content/origin/readingMinutes 不是元数据，
    # 带进去会被当作未知字段原样写进 js/data.js。
    metas = [sp.normalize_meta(
        {k: v for k, v in post.items() if k not in ('content', 'origin', 'readingMinutes')},
        post['content']) for post in built_in]
    artifacts, manifest = sp.build(p, metas, bodies, state['tag_order'], source_info)

    # 搜索语料：内置 + 旧编辑器文章，同一个 id 集合
    search = {m['id']: bodies[m['id']] for m in metas}
    for post in legacy:
        search[post['id']] = post['content']
    search_json = json.dumps(search, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':')).encode('utf-8')
    artifacts['data/search-index.json'] = search_json

    manifest = dict(manifest)
    manifest['searchIndex'] = {
        'path': 'data/search-index.json',
        'sha256': sp.sha256_bytes(search_json),
        'bytes': len(search_json),
    }
    if legacy:
        manifest['posts'] = list(manifest['posts']) + [{
            'id': post['id'],
            'file': None,
            'origin': post['origin'],
            'contentSha256': sp.sha256_bytes(post['content'].encode('utf-8')),
            'contentBytes': len(post['content'].encode('utf-8')),
            'contentChars': len(post['content']),
            'metaSha256': sp.sha256_bytes(sp.meta_canonical(
                {k: post[k] for k in ('id', 'title', 'date', 'tags', 'excerpt', 'readingMinutes')}
            ).encode('utf-8')),
            'readingMinutes': post['readingMinutes'],
        } for post in legacy]
        # 兼容期标记：告诉下游"还有多少篇没迁到 data/posts/*.md"
        manifest['legacyUserPosts'] = {
            'path': USER_POSTS_LABEL,
            'count': len(legacy),
            'ids': sorted(post['id'] for post in legacy),
        }
    artifacts['data/posts/manifest.json'] = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, indent=2).encode('utf-8') + b'\n'

    # 供 sp.build 的 data.js 之外，把 md 正文从 artifacts 里剔除（我们不重写 md）
    for post in built_in:
        artifacts.pop('data/posts/%s.md' % post['id'], None)

    feed_posts = sorted(
        ({'id': post['id'], 'title': post['title'], 'date': post['date'],
          'excerpt': post['excerpt']} for post in state['all']),
        key=lambda x: x['date'], reverse=True)
    artifacts['feed.xml'] = g.build_feed(feed_posts, _parse_now(p)).encode('utf-8')

    return artifacts, manifest


def _parse_now(p):
    return p.get('now')


# --------------------------------------------------------------------- 落盘
def diff_artifacts(root, artifacts):
    """返回 [(rel, old_bytes|None, new_bytes)]，顺序稳定。"""
    out = []
    for rel in sorted(artifacts):
        path = os.path.join(root, rel.replace('/', os.sep))
        old = None
        if os.path.exists(path):
            with open(path, 'rb') as f:
                old = f.read()
        new = artifacts[rel]
        same = old is not None and _same_bytes(rel, old, new)
        if not same:
            out.append((rel, old, new))
    return out


def _same_bytes(rel, old, new):
    if rel != 'feed.xml':
        return old == new
    # feed 的 lastBuildDate 允许变化（构建时间戳不是内容）
    return (FEED_STAMP_RE.sub('<lastBuildDate/>', old.decode('utf-8', 'replace')) ==
            FEED_STAMP_RE.sub('<lastBuildDate/>', new.decode('utf-8', 'replace')))


def write_artifacts(root, artifacts):
    """逐文件临时文件 + os.replace（单文件原子；不是多文件事务）。"""
    staged = []
    try:
        for rel in sorted(artifacts):
            target = os.path.join(root, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix='.tmp-build-', suffix='.part')
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(artifacts[rel])
                    f.flush()
                    os.fsync(f.fileno())
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            staged.append((tmp, target))
    except BaseException:
        for tmp, _ in staged:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise
    for tmp, target in staged:
        os.replace(tmp, target)
    # 回读校验：写进去的必须和算出来的一致
    for rel in sorted(artifacts):
        path = os.path.join(root, rel.replace('/', os.sep))
        with open(path, 'rb') as f:
            if f.read() != artifacts[rel]:
                raise BuildError('写入后校验失败：%s' % rel)


# --------------------------------------------------------------------- 锁
class BuildLock(object):
    """同 root 上只允许一个 --sync；陈旧锁（进程已死 / 超过 10 分钟）自动清理。"""

    def __init__(self, path, timeout=0):
        self.path = path
        self.timeout = timeout
        self.fd = None

    def __enter__(self):
        deadline = time.time() + max(0, self.timeout)
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, ('%d\n' % os.getpid()).encode('ascii'))
                return self
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
                if _lock_is_stale(self.path):
                    try:
                        os.unlink(self.path)
                    except OSError:
                        pass
                    continue
                if time.time() >= deadline:
                    raise LockBusy('另一个构建进程正在工作（锁文件 %s）' % self.path)
                time.sleep(0.1)

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None
        try:
            os.unlink(self.path)
        except OSError:
            pass
        return False


def _lock_is_stale(path, max_age=600):
    """只按年龄判定陈旧。

    刻意**不**用 os.kill(pid, 0) 做存活探测：Windows 上 os.kill 会把 0 当成
    退出码去 TerminateProcess，等于把另一个正在构建的进程杀掉。
    """
    try:
        return time.time() - os.path.getmtime(path) > max_age
    except OSError:
        return True


# --------------------------------------------------------------------- CLI
def parse_args(argv):
    ap = argparse.ArgumentParser(description='统一内容构建器：权威源 → 派生数据')
    ap.add_argument('--check', action='store_true', help='只校验（默认），不写任何文件')
    ap.add_argument('--dry-run', action='store_true', help='只报告将变更的文件，不落盘')
    ap.add_argument('--sync', action='store_true', help='重建全部派生产物')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（默认脚本所在仓库）')
    ap.add_argument('--now', help='固定 feed 的 lastBuildDate（ISO8601），用于可重复构建')
    ap.add_argument('--lock-timeout', type=float, default=0, help='等待构建锁的秒数（默认不等）')
    ap.add_argument('--allow-orphans', action='store_true',
                    help='允许存在没有元数据引用的正文（默认视为错误；不会删除任何文件）')
    args = ap.parse_args(argv)
    modes = [m for m, on in (('check', args.check), ('dry-run', args.dry_run), ('sync', args.sync)) if on]
    if len(modes) > 1:
        ap.error('--check / --dry-run / --sync 只能选一个')
    args.mode = modes[0] if modes else 'check'
    return args


def main(argv=None):
    args = parse_args(argv)
    root = os.path.abspath(args.root)
    p = paths(root)
    p['now'] = g.parse_now(args.now) if args.now else None

    try:
        state = collect(p)
    except BuildError as e:
        print('[FAIL] ' + str(e), file=sys.stderr)
        return 1

    orphans = check_orphans(p, set(post['id'] for post in state['built_in']))
    if orphans and not args.allow_orphans:
        print('[FAIL] 存在没有元数据引用的正文文件（不会被自动删除）：' +
              '、'.join('data/posts/%s.md' % o for o in orphans), file=sys.stderr)
        return 1

    # source 块：沿用磁盘上的那份（与 split_posts 保持一致，避免"改过 data.js 但没 --sync"时
    # 产生与 split-check 不一致的判定）
    source_info = {
        'mode': 'build_content',
        'path': 'js/data.js',
        'sha256': sp.sha256_bytes(state['data_text'].encode('utf-8')),
        'bytes': len(state['data_text'].encode('utf-8')),
        'posts': len(state['built_in']),
        'contentChars': sum(len(state['bodies'][m['id']]) for m in state['built_in']),
    }
    if os.path.exists(p['manifest']):
        try:
            disk = json.loads(_read_text(p['manifest']))
            if isinstance(disk.get('source'), dict):
                source_info = disk['source']
        except Exception:
            pass

    try:
        artifacts, manifest = build_artifacts(p, state, source_info)
    except (BuildError, sp.SplitError, g.FeedError) as e:
        print('[FAIL] ' + str(e), file=sys.stderr)
        return 1

    ids = [post['id'] for post in state['all']]
    summary = ('文章 %d 篇（内置 %d + 旧编辑器 %d），正文 %d 字符'
               % (len(ids), len(state['built_in']), len(state['legacy']),
                  sum(len(post['content']) for post in state['all'])))

    if args.mode == 'check':
        changes = diff_artifacts(root, artifacts)
        if changes:
            print('校验对象: ' + summary)
            for rel, _old, _new in changes:
                print('  [FAIL] 产物与当前输入不一致（请跑 --sync）：' + rel)
            return 1
        print('校验对象: ' + summary)
        print('OK: 元数据 / 正文 / 搜索语料 / 完整性清单 / feed 一致，且可由当前输入重新生成')
        return 0

    changes = diff_artifacts(root, artifacts)
    print('%s：%s' % ('预演' if args.mode == 'dry-run' else '重建', summary))
    print('  待更新 %d 个文件' % len(changes))
    for rel, _old, new in changes:
        print('    %-32s %8d B' % (rel, len(new)))
    if args.mode == 'dry-run':
        print('（--dry-run，未写入）')
        return 0

    try:
        with BuildLock(p['lock'], args.lock_timeout):
            write_artifacts(root, artifacts)
    except LockBusy as e:
        print('[BUSY] ' + str(e), file=sys.stderr)
        return 3
    except (BuildError, OSError) as e:
        print('[FAIL] 写入失败：%s' % e, file=sys.stderr)
        return 1

    if not changes:
        print('  产物已是最新，无写入')
    print('OK: 已写入 %d 个文件（id 集合 %d 篇，feed %d 条）'
          % (len(changes), len(manifest['posts']), len(ids)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
