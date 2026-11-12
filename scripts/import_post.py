#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地文章导入器（Batch 8A）。

把网页编辑器导出的 `<id>.json` 安全地落成一个新文章：

    权威源（A 类，导入器只写这两个）
        data/posts/<id>.md     正文（Markdown，新建文件，绝不覆盖）
        js/data.js             新文章的一条元数据（由生成器重新渲染整份文件）
    派生产物（B 类，复用 scripts/build_content.py 重建）
        data/search-index.json / data/posts/manifest.json / feed.xml / js/data.js

用法：
    python scripts/import_post.py --file article.json --dry-run   # 只检查，不写盘（默认）
    python scripts/import_post.py --file article.json --apply     # 真正导入
    python scripts/import_post.py --file article.json --dry-run --root DIR

只支持「新增」：
    * 已存在同 id（正文文件 / data.js / js/user-posts.js 任一处命中）→ 拒绝，绝不覆盖；
    * 修改、删除 → 明确拒绝（本轮不做，也不猜用户意图；请手动编辑并跑 --sync）。

安全设计（对应 BATCH8A_REPORT.md「导入器安全设计」）：
    1. 只吃 JSON：json.loads + 重复键/NaN 拦截，不执行任何 JavaScript，不做字符串拼接；
    2. id 必须匹配 ^[a-z0-9][a-z0-9-]*$（同时挡掉路径逃逸与 Windows 保留设备名）；
    3. js/data.js 必须**当前就是生成器输出**，否则要求先跑 build_content.py --sync；
       重写时用 split_posts.render_data_js 渲染整份文件，注释头/字段顺序/其他文章由生成器保证；
    4. 正文文件用「独占创建」写入，data.js 与派生数据用「临时文件 + os.replace」；
    5. 任一步失败（含 Ctrl-C）→ 回滚到导入前的字节，并再跑一次 --check 确认没有半成品；
    6. 全程复用 build_content / split_posts / gen_feed，不另写搜索索引或 RSS 生成器。

退出码：
    0  成功（--dry-run 也算成功）
    1  输入不合法 / IO 或构建失败（已回滚）
    2  冲突：同 id 已存在（未做任何写入）
"""
import argparse
import datetime
import json
import os
import re
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, REPO_DIR)
sys.path.insert(0, SCRIPT_DIR)

import build_content as bc     # noqa: E402  统一构建器（派生数据的唯一生成入口）
import split_posts as sp       # noqa: E402  元数据规范/渲染（与生成器同一套规则）

IMPORT_KEYS = ('id', 'title', 'date', 'tags', 'excerpt', 'content')
OPTIONAL_KEYS = ('series', 'seriesOrder')
ALLOWED_KEYS = IMPORT_KEYS + OPTIONAL_KEYS

MAX_FILE_BYTES = 1024 * 1024       # 1 MiB：一篇文章的 JSON 远小于此
MAX_ID_CHARS = 64
MAX_TITLE_CHARS = 200
MAX_EXCERPT_CHARS = 2000
MAX_CONTENT_CHARS = 200 * 1000
MAX_TAGS = 30
MAX_TAG_CHARS = 40
MAX_SERIES_CHARS = 80

# data/posts/manifest.json 是完整性锚点，不能有同名正文
RESERVED_IDS = {'manifest'}
# Windows 设备名（data/posts/aux.md 这类文件在 Windows 上无法正常创建/读取）
WINDOWS_RESERVED = ({'con', 'prn', 'aux', 'nul'} |
                    {'com%d' % i for i in range(1, 10)} |
                    {'lpt%d' % i for i in range(1, 10)})

# 导入会改动的派生文件（回滚时按这份清单还原字节）
DERIVED_FILES = ('js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml')

CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


class ImportFailure(Exception):
    """输入不合法 / 构建失败：必须中止，且不得留下半成品。"""


class ImportConflict(ImportFailure):
    """同 id 已存在：明确拒绝，不做任何写入。"""


# --------------------------------------------------------------------- 读取输入
def _describe_encoding(raw):
    if raw.startswith(b'\xff\xfe') or raw.startswith(b'\xfe\xff'):
        return '文件是 UTF-16 编码，请用 UTF-8 重新导出'
    return '文件不是合法 UTF-8，请确认编辑器导出的 JSON 未被其它工具转码'


def read_import_file(path):
    """读取并解码导出的 JSON（只按字节读，不做任何代码执行）。"""
    if not path:
        raise ImportFailure('必须用 --file 指定导出文件')
    full = os.path.abspath(os.path.expanduser(path))
    if os.path.isdir(full):
        raise ImportFailure('--file 指向的是目录：%s' % full)
    if not os.path.exists(full):
        raise ImportFailure('找不到导入文件：%s' % full)
    if not os.path.isfile(full):
        raise ImportFailure('--file 不是普通文件：%s' % full)

    size = os.path.getsize(full)
    if size == 0:
        raise ImportFailure('导入文件为空：%s' % full)
    if size > MAX_FILE_BYTES:
        raise ImportFailure('导入文件过大（%d 字节 > %d 字节上限）' % (size, MAX_FILE_BYTES))

    with open(full, 'rb') as f:
        raw = f.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ImportFailure(_describe_encoding(raw))
    return full, text.lstrip('\ufeff')


def _reject_dup_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ImportFailure('JSON 中存在重复键：%r（拒绝猜测以哪个为准）' % key)
        obj[key] = value
    return obj


def _reject_constants(name):
    raise ImportFailure('JSON 中出现非法常量 %s（标准 JSON 不支持 NaN/Infinity）' % name)


def parse_json(text, where):
    try:
        return json.loads(text, object_pairs_hook=_reject_dup_keys, parse_constant=_reject_constants)
    except ImportFailure:
        raise
    except ValueError as e:
        raise ImportFailure('%s 不是合法 JSON（%s）。导入器只接受 JSON，'
                            '不会执行 JavaScript（不要传 .js / 带单引号的对象字面量）' % (where, e))


# --------------------------------------------------------------------- 字段校验
def _require_str(pid, key, value, max_chars, allow_newline=False):
    if not isinstance(value, str):
        raise ImportFailure('%s 的 %s 必须是字符串' % (pid, key))
    if len(value) > max_chars:
        raise ImportFailure('%s 的 %s 过长（%d > %d 字符）' % (pid, key, len(value), max_chars))
    if CONTROL_CHARS.search(value):
        raise ImportFailure('%s 的 %s 含有控制字符，拒绝导入' % (pid, key))
    if not allow_newline and ('\n' in value or '\r' in value):
        raise ImportFailure('%s 的 %s 不能包含换行' % (pid, key))
    return value


def normalize_content(content, pid):
    """统一换行为 LF：Windows 编辑器可能带 \\r\\n，混进来会让正文与哈希难以复现。"""
    if not isinstance(content, str):
        raise ImportFailure('%s 的 content 必须是字符串' % pid)
    if len(content) > MAX_CONTENT_CHARS:
        raise ImportFailure('%s 的正文过长（%d > %d 字符）' % (pid, len(content), MAX_CONTENT_CHARS))
    if '\x00' in content:
        raise ImportFailure('%s 的正文含有 NUL 字符，拒绝导入' % pid)
    if not content.strip():
        raise ImportFailure('正文不能为空')
    return content.replace('\r\n', '\n').replace('\r', '\n')


def validate_post(data, where):
    """逐字段校验导出的 JSON，返回规范化后的文章字典。"""
    if not isinstance(data, dict):
        raise ImportFailure('%s 的顶层必须是 JSON 对象' % where)

    unknown = [k for k in sorted(set(data)) if k not in ALLOWED_KEYS]
    if unknown:
        raise ImportFailure('存在不支持的字段：%s（导出格式固定为 %s，可选 %s）'
                            % (', '.join(unknown), '/'.join(IMPORT_KEYS), '/'.join(OPTIONAL_KEYS)))
    missing = [k for k in IMPORT_KEYS if k not in data]
    if missing:
        raise ImportFailure('缺少必填字段：%s' % ', '.join(missing))

    pid = data['id']
    if not isinstance(pid, str) or not sp.SAFE_ID.match(pid):
        raise ImportFailure('id 非法：%r（只允许 [a-z0-9-]，且必须以字母或数字开头）' % (pid,))
    if len(pid) > MAX_ID_CHARS:
        raise ImportFailure('id 过长：%d > %d 字符' % (len(pid), MAX_ID_CHARS))
    if pid in RESERVED_IDS:
        raise ImportFailure('id %r 是保留名（会撞 data/posts/manifest.json）' % pid)
    if pid.lower() in WINDOWS_RESERVED:
        raise ImportFailure('id %r 是 Windows 保留设备名，无法作为文件名' % pid)

    title = _require_str(pid, 'title', data['title'], MAX_TITLE_CHARS).strip()
    if not title:
        raise ImportFailure('标题不能为空')

    date = _require_str(pid, 'date', data['date'], 10)
    date = date.strip()
    if not sp.DATE_RE.match(date):
        raise ImportFailure('%s 的 date 必须是 YYYY-MM-DD：%r' % (pid, data['date']))
    try:
        datetime.datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise ImportFailure('%s 的 date 不是真实日期：%r' % (pid, date))

    tags = data['tags']
    if not isinstance(tags, list) or not tags:
        raise ImportFailure('%s 的 tags 必须是非空字符串数组' % pid)
    if len(tags) > MAX_TAGS:
        raise ImportFailure('%s 的标签过多（%d > %d）' % (pid, len(tags), MAX_TAGS))
    clean_tags = []
    for i, tag in enumerate(tags):
        if not isinstance(tag, str):
            raise ImportFailure('%s 的第 %d 个标签不是字符串' % (pid, i + 1))
        tag = _require_str(pid, 'tags[%d]' % i, tag, MAX_TAG_CHARS).strip()
        if not tag:
            raise ImportFailure('%s 的第 %d 个标签为空' % (pid, i + 1))
        if tag not in clean_tags:      # 去重但保留顺序：重复标签只会在标签页里重复计数
            clean_tags.append(tag)

    excerpt = _require_str(pid, 'excerpt', data['excerpt'], MAX_EXCERPT_CHARS, allow_newline=True)

    content = normalize_content(data['content'], pid)

    post = {
        'id': pid,
        'title': title,
        'date': date,
        'tags': clean_tags,
        'excerpt': excerpt,
        'content': content,
    }

    if 'series' in data:
        series = _require_str(pid, 'series', data['series'], MAX_SERIES_CHARS).strip()
        if not series:
            raise ImportFailure('%s 的 series 不能为空字符串（不需要就删掉这个字段）' % pid)
        post['series'] = series
    if 'seriesOrder' in data:
        order = data['seriesOrder']
        if isinstance(order, bool) or not isinstance(order, int) or order < 0:
            raise ImportFailure('%s 的 seriesOrder 必须是非负整数：%r' % (pid, order))
        post['seriesOrder'] = order
    if ('series' in post) != ('seriesOrder' in post):
        raise ImportFailure('%s 的 series 与 seriesOrder 必须同时提供' % pid)

    return post


# --------------------------------------------------------------------- 现有数据
def load_repo(root):
    """读取权威源；现有数据本身不合法时直接中止（不替用户修复）。"""
    p = bc.paths(root)
    try:
        state = bc.collect(p)
    except bc.BuildError as e:
        raise ImportFailure('现有内容无法解析，请先修复（%s）' % e)
    if state.get('orphans'):
        # 孤儿正文说明仓库已经处于不一致状态，导入会放大问题
        raise ImportFailure('data/posts 中存在没有元数据引用的正文：%s'
                            '（请先处理这些文件，导入器不会替你删除）'
                            % '、'.join(state['orphans']))
    return p, state


def ensure_canonical(p, state):
    """js/data.js 必须是生成器当前的输出，否则拒绝编辑。

    为什么要这条：data.js 由 split_posts.render_data_js 统一渲染（注释头、字段顺序、
    readingMinutes）。如果磁盘上的文件和生成器不一致，说明有人手改过/别的工具写过，
    此时整份重写会连带改动其他文章 —— 那正是 8A 要避免的"看不见的历史改动"。
    """
    with open(p['data_js'], 'rb') as f:
        current = f.read()
    expected = sp.render_data_js(state['metas'], state['tag_order']).encode('utf-8')
    if current != expected:
        raise ImportFailure('js/data.js 与生成器输出不一致：请先运行 '
                            'python scripts/build_content.py --sync 让它回到规范格式，再重新导入')


def ensure_no_conflict(p, state, pid):
    """同 id 出现在任何来源都算冲突：导入器只新增，绝不覆盖。"""
    body = sp.body_path(p, pid)
    if os.path.exists(body):
        raise ImportConflict('data/posts/%s.md 已存在：导入器不会覆盖历史正文' % pid)
    if any(m['id'] == pid for m in state['metas']):
        raise ImportConflict('js/data.js 已有同 id 元数据（%s）：导入器只支持新增，不修改历史文章' % pid)
    if any(post['id'] == pid for post in state['legacy']):
        raise ImportConflict('js/user-posts.js 已有同 id 文章（%s）：请先迁移或换一个 id' % pid)


# --------------------------------------------------------------------- 计划
def build_plan(root, p, state, post):
    """在内存里算出「新正文 + 新元数据 + 全部派生产物」，不写任何文件。"""
    pid = post['id']
    meta = sp.normalize_meta(post, post['content'])      # 与生成器同一套字段顺序/readingMinutes

    metas = [meta] + list(state['metas'])                # 插到首位：同日期时新文章排在最前
    bodies = dict(state['bodies'])
    bodies[pid] = post['content']
    tag_order = list(state['tag_order'])
    for tag in post['tags']:
        if tag not in tag_order:
            tag_order.append(tag)

    merged = bc.assemble(metas, bodies, tag_order, state['legacy'])
    source_info = bc.resolve_source_info(p, state['source_info'])
    try:
        artifacts, manifest = bc.build_artifacts(p, merged, source_info)
    except (bc.BuildError, sp.SplitError) as e:
        raise ImportFailure('生成派生数据失败：%s' % e)

    if 'js/data.js' not in artifacts:
        raise ImportFailure('内部错误：构建结果里没有 js/data.js')

    return {
        'id': pid,
        'meta': meta,
        'body': post['content'],
        'artifacts': artifacts,
        'manifest': manifest,
        'changes': bc.diff_artifacts(root, artifacts),
        'tag_order': tag_order,
    }


# --------------------------------------------------------------------- 写盘
def _read_bytes(path):
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as f:
        return f.read()


def _atomic_write(path, data):
    target_dir = os.path.dirname(path)
    os.makedirs(target_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target_dir, prefix='.tmp-import-', suffix='.part')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_body(path, content):
    """新建正文文件：先确认不存在，再原子替换（绝不覆盖历史正文）。"""
    if os.path.exists(path):
        raise ImportConflict('data/posts/%s.md 在导入过程中被创建，已中止' % os.path.basename(path))
    _atomic_write(path, content.encode('utf-8'))


def write_data_js(path, data):
    _atomic_write(path, data)


def apply_plan(root, p, plan):
    """真正落盘：正文 → 元数据 → 派生数据 → 回读校验；失败即回滚。"""
    pid = plan['id']
    body_path = sp.body_path(p, pid)
    data_js_path = p['data_js']

    backup = {rel: _read_bytes(os.path.join(root, rel.replace('/', os.sep))) for rel in DERIVED_FILES}
    body_written = False

    try:
        write_body(body_path, plan['body'])
        body_written = True
        write_data_js(data_js_path, plan['artifacts']['js/data.js'])

        # 不信任内存里的中间结果：从磁盘重新读一遍，再交给统一构建器生成派生数据
        state_now = bc.collect(p)
        try:
            artifacts_now, _ = bc.build_artifacts(
                p, state_now, bc.resolve_source_info(p, state_now['source_info']))
        except (bc.BuildError, sp.SplitError) as e:
            raise ImportFailure('写入后重建派生数据失败：%s' % e)

        with bc.BuildLock(p['lock']):
            bc.write_artifacts(root, artifacts_now)

        if bc.main(['--check', '--root', root]) != 0:
            raise ImportFailure('导入后一致性校验未通过（正文/元数据/搜索语料/清单/feed 不一致）')
    except BaseException:
        problems = _rollback(root, p, backup, body_path, body_written)
        if problems:
            print('[ROLLBACK-INCOMPLETE] 自动回滚未完全成功，请手工核对：' + '；'.join(problems),
                  file=sys.stderr)
        raise


def _rollback(root, p, backup, body_path, body_written):
    problems = []
    if body_written and os.path.exists(body_path):
        try:
            os.unlink(body_path)          # 先删正文，避免回滚后变成孤儿
        except OSError as e:
            problems.append('删除 data/posts/%s.md 失败: %s' % (os.path.basename(body_path), e))
    for rel, buf in backup.items():
        path = os.path.join(root, rel.replace('/', os.sep))
        try:
            if buf is None:
                if os.path.exists(path):
                    os.unlink(path)
            else:
                _atomic_write(path, buf)
        except OSError as e:
            problems.append('还原 %s 失败: %s' % (rel, e))
    if not problems and bc.main(['--check', '--root', root]) != 0:
        problems.append('回滚后 --check 仍失败')
    return problems


# --------------------------------------------------------------------- CLI
def parse_args(argv):
    ap = argparse.ArgumentParser(description='本地文章导入器（只新增，不覆盖历史文章）')
    ap.add_argument('--file', required=False, help='编辑器导出的 JSON 文件路径')
    ap.add_argument('--dry-run', action='store_true', help='只检查并打印计划（默认）')
    ap.add_argument('--apply', action='store_true', help='真正写入并重建派生数据')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（默认脚本所在仓库）')
    args = ap.parse_args(argv)
    if args.apply and args.dry_run:
        ap.error('--apply 与 --dry-run 只能选一个')
    args.mode = 'apply' if args.apply else 'dry-run'
    return args


def _print_plan(plan, where):
    meta = plan['meta']
    print('导入文件: %s' % where)
    print('文章 id : %s' % meta['id'])
    print('标题    : %s' % meta['title'])
    print('日期    : %s' % meta['date'])
    print('标签    : %s' % ', '.join(meta['tags']))
    if 'series' in meta:
        print('系列    : %s（第 %s 篇）' % (meta['series'], meta.get('seriesOrder')))
    print('正文    : %d 字符 → data/posts/%s.md（新建）' % (len(plan['body']), meta['id']))
    print('元数据  : 插入 js/data.js 的 POSTS 首位（readingMinutes=%d）' % meta['readingMinutes'])
    print('派生文件: 待更新 %d 个' % len(plan['changes']))
    for rel, old, new in plan['changes']:
        state = '新建' if old is None else '更新'
        print('    %-30s %s  %8d B' % (rel, state, len(new)))


def main(argv=None):
    args = parse_args(argv)
    root = os.path.abspath(args.root)

    try:
        where, text = read_import_file(args.file)
        data = parse_json(text, os.path.basename(where))
        post = validate_post(data, os.path.basename(where))

        p, state = load_repo(root)
        ensure_canonical(p, state)
        ensure_no_conflict(p, state, post['id'])
        plan = build_plan(root, p, state, post)
    except ImportConflict as e:
        print('[CONFLICT] %s' % e, file=sys.stderr)
        return 2
    except ImportFailure as e:
        print('[FAIL] %s' % e, file=sys.stderr)
        return 1

    _print_plan(plan, where)

    if args.mode == 'dry-run':
        print('（--dry-run：未写入任何文件。确认无误后加 --apply）')
        return 0

    try:
        apply_plan(root, p, plan)
    except ImportConflict as e:
        print('[CONFLICT] %s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 2
    except ImportFailure as e:
        print('[FAIL] %s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('[ABORT] 已中断（已回滚，仓库未改变）', file=sys.stderr)
        return 1
    except OSError as e:
        print('[FAIL] IO 错误：%s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 1

    print('OK: 已导入 %s（文章 %d 篇）' % (post['id'], len(plan['manifest']['posts'])))
    print('下一步：')
    print('  1) git diff 复核（只应出现 1 个新 md + 4 个派生文件）')
    print('  2) python scripts/build_content.py --check')
    print('  3) 提交分支并手动开 PR（见 BATCH8A_REPORT.md「手动 PR 操作说明」）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
