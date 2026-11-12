#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地文章导入器（Batch 8A 新增 / Batch 8B-1 更新）。

把网页编辑器导出的 JSON 安全地落成仓库里的文章：

    权威源（A 类，导入器只写这两个）
        data/posts/<id>.md     正文（Markdown）
        js/data.js             元数据（由生成器重新渲染整份文件）
    派生产物（B 类，复用 scripts/build_content.py 重建）
        data/search-index.json / data/posts/manifest.json / feed.xml

两种操作：

    add（Batch 8A，默认）
        python scripts/import_post.py --file article.json --dry-run
        python scripts/import_post.py --file article.json --apply
        * 只新增；同 id 已存在 → 拒绝（绝不覆盖历史正文）。

    update（Batch 8B-1）
        python scripts/import_post.py --file article.update.json --mode update --dry-run
        python scripts/import_post.py --file article.update.json --mode update --apply
        * 按 id 精确定位已有文章；
        * 必须携带 original 快照（原正文 + 原元数据），与**当前仓库**逐字段比对，
          不一致即视为"过期更新稿" → 拒绝（不静默覆盖别人的修改）；
        * 只能改标题/日期/标签/摘要/正文，id 与文件名不变；
        * 更新前后校验文章 id 集合完全一致（不会误删/误增）。

    --mode auto（默认）：按文件里的 "op" 字段自动判定，缺省视为 add。
    --mode add / --mode update：额外的显式保险，与实际类型不符时直接失败。

安全设计（对应 BATCH8A_REPORT.md / BATCH8B1_REPORT.md）：
    1. 只吃 JSON：json.loads + 重复键/NaN 拦截，不执行任何 JavaScript，不做字符串拼接；
    2. id 必须匹配 ^[a-z0-9][a-z0-9-]*$（同时挡掉路径逃逸与 Windows 保留设备名）；
    3. js/data.js 必须**当前就是生成器输出**，否则要求先跑 build_content.py --sync；
       重写时用 split_posts.render_data_js 渲染整份文件，注释头/字段顺序/其他文章由生成器保证；
    4. update 在**锁内**重新读取仓库并再次校验原版本（消除 TOCTOU），任何不一致立即失败；
    5. 写盘用「临时文件 + os.replace」；任一步失败（含 Ctrl-C）按备份字节回滚，并再跑一次 --check；
    6. 全程复用 build_content / split_posts / gen_feed，不另写搜索索引或 RSS 生成器。

退出码：
    0  成功（--dry-run 也算成功）
    1  输入不合法 / IO 或构建失败（已回滚）
    2  冲突：同 id 已存在（add）/ 文章不存在 / 原版本已变化（update）——未做任何写入
    3  另一个构建进程正在工作（锁被占用）
"""
import argparse
import datetime
import json
import os
import re
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, REPO_DIR)
sys.path.insert(0, SCRIPT_DIR)

import build_content as bc     # noqa: E402  统一构建器（派生数据的唯一生成入口）
import split_posts as sp       # noqa: E402  元数据规范/渲染（与生成器同一套规则）

POST_KEYS = ('id', 'title', 'date', 'tags', 'excerpt', 'content')
OPTIONAL_KEYS = ('series', 'seriesOrder')
ALLOWED_KEYS = POST_KEYS + OPTIONAL_KEYS
UPDATE_TOP_KEYS = ('op', 'id', 'original', 'post')
ORIGINAL_KEYS = ('title', 'date', 'tags', 'excerpt', 'content')

MAX_FILE_BYTES = 4 * 1024 * 1024     # 4 MiB：更新稿会内联原文快照，比 8A 的新增稿大
MAX_ID_CHARS = 64
MAX_TITLE_CHARS = 200
MAX_EXCERPT_CHARS = 2000
MAX_CONTENT_CHARS = 400 * 1000
MAX_TAGS = 30
MAX_TAG_CHARS = 40
MAX_SERIES_CHARS = 80

RESERVED_IDS = {'manifest'}
WINDOWS_RESERVED = ({'con', 'prn', 'aux', 'nul'} |
                    {'com%d' % i for i in range(1, 10)} |
                    {'lpt%d' % i for i in range(1, 10)})

DERIVED_FILES = ('js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml')

CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


class ImportFailure(Exception):
    """输入不合法 / 构建失败：必须中止，且不得留下半成品。"""


class ImportConflict(ImportFailure):
    """与仓库当前状态冲突：明确拒绝，不做任何写入。"""


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


def op_of(data, where):
    """判定稿件类型：add（Batch 8A 格式，无 op 字段）/ update（Batch 8B-1）。"""
    if not isinstance(data, dict):
        raise ImportFailure('%s 的顶层必须是 JSON 对象' % where)
    op = data.get('op', 'add')
    if op not in ('add', 'update'):
        raise ImportFailure('%s 的 op 只能是 add / update：%r' % (where, op))
    return op


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


def normalize_body(text, pid):
    """原版本比对用的规范化：只统一换行，**不**裁剪空白（要与磁盘字节严格对应）。"""
    if not isinstance(text, str):
        raise ImportFailure('%s 的 original.content 必须是字符串' % pid)
    if '\x00' in text:
        raise ImportFailure('%s 的 original.content 含有 NUL 字符' % pid)
    return text.replace('\r\n', '\n').replace('\r', '\n')


def _validate_id(pid):
    if not isinstance(pid, str) or not sp.SAFE_ID.match(pid):
        raise ImportFailure('id 非法：%r（只允许 [a-z0-9-]，且必须以字母或数字开头）' % (pid,))
    if len(pid) > MAX_ID_CHARS:
        raise ImportFailure('id 过长：%d > %d 字符' % (len(pid), MAX_ID_CHARS))
    if pid in RESERVED_IDS:
        raise ImportFailure('id %r 是保留名（会撞 data/posts/manifest.json）' % pid)
    if pid.lower() in WINDOWS_RESERVED:
        raise ImportFailure('id %r 是 Windows 保留设备名，无法作为文件名' % pid)
    return pid


def _validate_date(pid, date):
    date = _require_str(pid, 'date', date, 10).strip()
    if not sp.DATE_RE.match(date):
        raise ImportFailure('%s 的 date 必须是 YYYY-MM-DD：%r' % (pid, date))
    try:
        datetime.datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise ImportFailure('%s 的 date 不是真实日期：%r' % (pid, date))
    return date


def _validate_tags(pid, tags):
    if not isinstance(tags, list) or not tags:
        raise ImportFailure('%s 的 tags 必须是非空字符串数组' % pid)
    if len(tags) > MAX_TAGS:
        raise ImportFailure('%s 的标签过多（%d > %d）' % (pid, len(tags), MAX_TAGS))
    clean = []
    for i, tag in enumerate(tags):
        if not isinstance(tag, str):
            raise ImportFailure('%s 的第 %d 个标签不是字符串' % (pid, i + 1))
        tag = _require_str(pid, 'tags[%d]' % i, tag, MAX_TAG_CHARS).strip()
        if not tag:
            raise ImportFailure('%s 的第 %d 个标签为空' % (pid, i + 1))
        if tag not in clean:      # 去重但保序：重复标签只会在标签页里重复计数
            clean.append(tag)
    return clean


def validate_post_fields(raw, where):
    """校验一份「完整文章数据」，返回规范化后的字典（add 与 update 共用）。"""
    if not isinstance(raw, dict):
        raise ImportFailure('%s 必须是 JSON 对象' % where)

    unknown = [k for k in sorted(set(raw)) if k not in ALLOWED_KEYS]
    if unknown:
        raise ImportFailure('存在不支持的字段：%s（导出格式固定为 %s，可选 %s）'
                            % (', '.join(unknown), '/'.join(POST_KEYS), '/'.join(OPTIONAL_KEYS)))
    missing = [k for k in POST_KEYS if k not in raw]
    if missing:
        raise ImportFailure('缺少必填字段：%s' % ', '.join(missing))

    pid = _validate_id(raw['id'])
    title = _require_str(pid, 'title', raw['title'], MAX_TITLE_CHARS).strip()
    if not title:
        raise ImportFailure('标题不能为空')

    post = {
        'id': pid,
        'title': title,
        'date': _validate_date(pid, raw['date']),
        'tags': _validate_tags(pid, raw['tags']),
        'excerpt': _require_str(pid, 'excerpt', raw['excerpt'], MAX_EXCERPT_CHARS, allow_newline=True),
        'content': normalize_content(raw['content'], pid),
    }

    if 'series' in raw:
        series = _require_str(pid, 'series', raw['series'], MAX_SERIES_CHARS).strip()
        if not series:
            raise ImportFailure('%s 的 series 不能为空字符串（不需要就删掉这个字段）' % pid)
        post['series'] = series
    if 'seriesOrder' in raw:
        order = raw['seriesOrder']
        if isinstance(order, bool) or not isinstance(order, int) or order < 0:
            raise ImportFailure('%s 的 seriesOrder 必须是非负整数：%r' % (pid, order))
        post['seriesOrder'] = order
    if ('series' in post) != ('seriesOrder' in post):
        raise ImportFailure('%s 的 series 与 seriesOrder 必须同时提供' % pid)

    try:
        post['content'].encode('utf-8')
    except UnicodeEncodeError:
        raise ImportFailure('%s 的正文含无法编码的字符（孤立代理项？），拒绝导入' % pid)
    return post


def validate_update(data, where):
    """校验更新稿，返回 {id, original, post}。

    original 是**导出时**的原文快照（正文全文 + 元数据字段），
    用于确认"这份更新稿基于仓库里的哪一版"，避免把旧版覆盖到新版上。
    """
    unknown = [k for k in sorted(set(data)) if k not in UPDATE_TOP_KEYS]
    if unknown:
        raise ImportFailure('%s 存在不支持的字段：%s（更新稿固定为 op/id/original/post）'
                            % (where, ', '.join(unknown)))
    for key in UPDATE_TOP_KEYS:
        if key not in data:
            raise ImportFailure('%s 缺少必填字段：%s' % (where, key))
    if data['op'] != 'update':
        raise ImportFailure('%s 的 op 不是 update：%r' % (where, data['op']))

    pid = _validate_id(data['id'])

    post = validate_post_fields(data['post'], '%s 的 post' % where)
    if post['id'] != pid:
        raise ImportFailure('id 不一致：顶层是 %r，post.id 是 %r' % (pid, post['id']))

    original = data['original']
    if not isinstance(original, dict):
        raise ImportFailure('%s 的 original 必须是 JSON 对象' % where)
    unknown = [k for k in sorted(set(original)) if k not in ORIGINAL_KEYS]
    if unknown:
        raise ImportFailure('%s 的 original 存在不支持的字段：%s' % (where, ', '.join(unknown)))
    missing = [k for k in ORIGINAL_KEYS if k not in original]
    if missing:
        raise ImportFailure('%s 的 original 缺少原版本信息：%s（请重新打开编辑器导出）'
                            % (where, ', '.join(missing)))

    snapshot = {
        'title': _require_str(pid, 'original.title', original['title'], MAX_TITLE_CHARS * 4),
        'date': _require_str(pid, 'original.date', original['date'], 40),
        'tags': original['tags'],
        'excerpt': _require_str(pid, 'original.excerpt', original['excerpt'],
                                MAX_EXCERPT_CHARS * 4, allow_newline=True),
        'content': normalize_body(original['content'], pid),
    }
    if not isinstance(snapshot['tags'], list) or not all(isinstance(t, str) for t in snapshot['tags']):
        raise ImportFailure('%s 的 original.tags 必须是字符串数组' % where)

    return {'id': pid, 'original': snapshot, 'post': post}


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


def run_check(root):
    """静默执行官方一致性校验，返回 (rc, 输出)。"""
    buf = StringIO()
    with redirect_stdout(buf):
        rc = bc.main(['--check', '--root', root])
    return rc, buf.getvalue().strip()


def ensure_repo_consistent(root, why):
    """更新前必须确认"当前仓库 = 可重新生成的产物"，否则拒绝在不确定的基线上改动。"""
    rc, out = run_check(root)
    if rc != 0:
        raise ImportFailure('%s前的一致性校验未通过（请先运行 python scripts/build_content.py '
                            '--sync 并提交）：\n%s' % (why, out))


def ensure_no_conflict(p, state, pid):
    """同 id 出现在任何来源都算冲突：add 只新增，绝不覆盖。"""
    body = sp.body_path(p, pid)
    if os.path.exists(body):
        raise ImportConflict('data/posts/%s.md 已存在：导入器不会覆盖历史正文' % pid)
    if any(m['id'] == pid for m in state['metas']):
        raise ImportConflict('js/data.js 已有同 id 元数据（%s）：导入器只支持新增，不修改历史文章' % pid)
    if any(post['id'] == pid for post in state['legacy']):
        raise ImportConflict('js/user-posts.js 已有同 id 文章（%s）：请先迁移或换一个 id' % pid)


def find_target_index(state, pid):
    """返回 id 在 metas 中的下标；不存在则抛冲突（区分"兼容期文章"这种只读来源）。"""
    for i, meta in enumerate(state['metas']):
        if meta['id'] == pid:
            return i
    if any(post['id'] == pid for post in state['legacy']):
        raise ImportConflict('文章 %s 来自兼容期 js/user-posts.js（正文内联），'
                             '本轮不支持在线更新：请先把它迁移到 data/posts/%s.md'
                             % (pid, pid))
    raise ImportConflict('文章不存在：data/posts/%s.md 与 js/data.js 中都没有 %s。'
                         '新增文章请去掉 op/original（或加 --mode add）' % (pid, pid))


def verify_original(state, p, ups, index):
    """把更新稿里的原版本快照与**当前仓库**逐字段比对，不一致即拒绝。"""
    pid = ups['id']
    current_meta = state['metas'][index]
    current_body = state['bodies'][pid]
    original = ups['original']

    problems = []
    if normalize_body(current_body, pid) != original['content']:
        problems.append('正文已变化（当前 %d 字符 / 快照 %d 字符）'
                        % (len(current_body), len(original['content'])))
    for key in ('title', 'date', 'tags', 'excerpt'):
        if original[key] != current_meta.get(key):
            problems.append('%s 已变化（当前：%r）' % (key, current_meta.get(key)))
    if problems:
        raise ImportConflict('原版本校验失败：%s —— 这份更新稿基于旧版本，'
                             '请重新打开编辑器加载最新版本后再改。' % '；'.join(problems))


# --------------------------------------------------------------------- 计划
def _assemble_state(p, state, metas, bodies, tag_order):
    merged = bc.assemble(metas, bodies, tag_order, state['legacy'])
    source_info = bc.resolve_source_info(p, state['source_info'])
    try:
        artifacts, manifest = bc.build_artifacts(p, merged, source_info)
    except (bc.BuildError, sp.SplitError) as e:
        raise ImportFailure('生成派生数据失败：%s' % e)
    if 'js/data.js' not in artifacts:
        raise ImportFailure('内部错误：构建结果里没有 js/data.js')
    return artifacts, manifest


def _extend_tag_order(tag_order, tags):
    out = list(tag_order)
    for tag in tags:
        if tag not in out:
            out.append(tag)
    return out


def build_add_plan(root, p, state, post):
    """在内存里算出「新正文 + 新元数据 + 全部派生产物」，不写任何文件。"""
    pid = post['id']
    meta = sp.normalize_meta(post, post['content'])      # 与生成器同一套字段顺序/readingMinutes

    metas = [meta] + list(state['metas'])                # 插到首位：同日期时新文章排在最前
    bodies = dict(state['bodies'])
    bodies[pid] = post['content']
    tag_order = _extend_tag_order(state['tag_order'], post['tags'])

    artifacts, manifest = _assemble_state(p, state, metas, bodies, tag_order)
    return {
        'op': 'add',
        'id': pid,
        'meta': meta,
        'body': post['content'],
        'artifacts': artifacts,
        'manifest': manifest,
        'changes': bc.diff_artifacts(root, artifacts),
        'tag_order': tag_order,
        'ids': [m['id'] for m in metas],
    }


def build_update_plan(root, p, state, ups, index):
    """更新稿的计划：位置不变、id 不变，只替换这一篇的元数据与正文。"""
    pid = ups['id']
    post = ups['post']
    current_meta = state['metas'][index]

    # 新元数据：显式字段来自更新稿；其余（series/seriesOrder 等）从现有元数据继承，
    # 避免"改个标题顺手把系列信息删掉"。
    merged_post = {
        'id': pid,
        'title': post['title'],
        'date': post['date'],
        'tags': list(post['tags']),
        'excerpt': post['excerpt'],
    }
    for key, value in current_meta.items():
        if key in sp.STANDARD_KEYS or key == 'readingMinutes':
            continue
        merged_post.setdefault(key, value)
    for key in OPTIONAL_KEYS:
        if key in post:
            merged_post[key] = post[key]

    meta = sp.normalize_meta(merged_post, post['content'])
    metas = list(state['metas'])
    metas[index] = meta
    bodies = dict(state['bodies'])
    bodies[pid] = post['content']
    tag_order = _extend_tag_order(state['tag_order'], post['tags'])

    artifacts, manifest = _assemble_state(p, state, metas, bodies, tag_order)
    return {
        'op': 'update',
        'id': pid,
        'meta': meta,
        'previous': current_meta,
        'body': post['content'],
        'artifacts': artifacts,
        'manifest': manifest,
        'changes': bc.diff_artifacts(root, artifacts),
        'tag_order': tag_order,
        'ids': [m['id'] for m in metas],
        'update': ups,
        'index': index,
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


def write_new_body(path, content):
    """新建正文文件：先确认不存在，再原子替换（绝不覆盖历史正文）。"""
    if os.path.exists(path):
        raise ImportConflict('data/posts/%s.md 在导入过程中被创建，已中止' % os.path.basename(path))
    _atomic_write(path, content.encode('utf-8'))


def write_body(path, content):
    """覆盖已存在的正文：由调用方保证版本已校验、且处于构建锁内。"""
    if not os.path.exists(path):
        raise ImportConflict('data/posts/%s.md 在更新过程中被删除，已中止' % os.path.basename(path))
    _atomic_write(path, content.encode('utf-8'))


def write_data_js(path, data):
    """写 js/data.js（单独成函数：测试用它模拟"写到一半失败"以验证回滚）。"""
    _atomic_write(path, data)


def _backup(root, p, pid, with_body):
    backup = {rel: _read_bytes(os.path.join(root, rel.replace('/', os.sep))) for rel in DERIVED_FILES}
    body_rel = 'data/posts/%s.md' % pid
    if with_body:
        backup[body_rel] = _read_bytes(sp.body_path(p, pid))
    return backup


def _rollback(root, backup, body_rel, delete_body):
    """按备份还原；返回无法还原的说明。

    delete_body=True 表示"导入前这篇正文不存在"，回滚时要删掉它（先删，避免留下孤儿）。
    """
    problems = []
    if delete_body:
        path = os.path.join(root, body_rel.replace('/', os.sep))
        if os.path.exists(path):
            try:
                os.unlink(path)
            except OSError as e:
                problems.append('删除 %s 失败: %s' % (body_rel, e))
    for rel in sorted(backup):
        if rel == body_rel and delete_body:
            continue
        buf = backup[rel]
        path = os.path.join(root, rel.replace('/', os.sep))
        try:
            if buf is None:
                if os.path.exists(path):
                    os.unlink(path)
            else:
                _atomic_write(path, buf)
        except OSError as e:
            problems.append('还原 %s 失败: %s' % (rel, e))
    if not problems:
        rc, out = run_check(root)
        if rc != 0:
            problems.append('回滚后 --check 仍失败：%s' % out.replace('\n', ' '))
    return problems


def _rebuild_and_write(root, p, state, plan):
    """用磁盘上的真实内容重建派生数据并落盘，最后跑官方 --check。"""
    artifacts_now, _manifest = _assemble_state(
        p, state, state['metas'], state['bodies'], state['tag_order'])
    bc.write_artifacts(root, artifacts_now)
    if [m['id'] for m in state['metas']] != plan['ids']:
        raise ImportFailure('文章 id 集合在写入过程中发生变化（疑似并发修改），已中止')
    rc, out = run_check(root)
    if rc != 0:
        raise ImportFailure('导入后一致性校验未通过：%s' % out.replace('\n', ' '))


def apply_add_plan(root, p, plan):
    """真正落盘：正文 → 元数据 → 派生数据 → 回读校验；失败即回滚。"""
    pid = plan['id']
    body_rel = 'data/posts/%s.md' % pid
    backup = _backup(root, p, pid, with_body=False)
    try:
        with bc.BuildLock(p['lock']):
            write_new_body(sp.body_path(p, pid), plan['body'])
            write_data_js(p['data_js'], plan['artifacts']['js/data.js'])
            # 不信任内存里的中间结果：从磁盘重新读一遍，再交给统一构建器生成派生数据
            state_now = bc.collect(p)
            _rebuild_and_write(root, p, state_now, plan)
    except BaseException:
        problems = _rollback(root, backup, body_rel, delete_body=True)
        if problems:
            print('[ROLLBACK-INCOMPLETE] 自动回滚未完全成功，请手工核对：' + '；'.join(problems),
                  file=sys.stderr)
        raise


def apply_update_plan(root, p, plan):
    """更新落盘：整个"复核 → 写入 → 校验"都在构建锁内，防止并发覆盖。"""
    pid = plan['id']
    body_rel = 'data/posts/%s.md' % pid
    ups = plan['update']

    with bc.BuildLock(p['lock']):
        # 锁内重新读取：拿到的必须是"现在"的仓库，而不是计划阶段的快照
        state_now = bc.collect(p)
        if [m['id'] for m in state_now['metas']] != plan['ids']:
            raise ImportConflict('文章列表在导入过程中发生变化（可能有其他进程在改），已中止')
        ensure_canonical(p, state_now)
        index_now = find_target_index(state_now, pid)
        verify_original(state_now, p, ups, index_now)

        backup = _backup(root, p, pid, with_body=True)
        try:
            write_body(sp.body_path(p, pid), plan['body'])
            write_data_js(p['data_js'], plan['artifacts']['js/data.js'])
            state_after = bc.collect(p)
            if [m['id'] for m in state_after['metas']] != plan['ids']:
                raise ImportFailure('更新后文章 id 集合发生变化（拒绝写入，防误删）')
            _rebuild_and_write(root, p, state_after, plan)
        except BaseException:
            problems = _rollback(root, backup, body_rel, delete_body=False)
            if problems:
                print('[ROLLBACK-INCOMPLETE] 自动回滚未完全成功，请手工核对：' + '；'.join(problems),
                      file=sys.stderr)
            raise


# --------------------------------------------------------------------- CLI
def parse_args(argv):
    ap = argparse.ArgumentParser(description='本地文章导入器（新增 / 更新已有文章）')
    ap.add_argument('--file', required=False, help='编辑器导出的 JSON 文件路径')
    ap.add_argument('--dry-run', action='store_true', help='只检查并打印计划（默认）')
    ap.add_argument('--apply', action='store_true', help='真正写入并重建派生数据')
    ap.add_argument('--mode', choices=['auto', 'add', 'update'], default='auto',
                    help='稿件类型（默认 auto：按文件里的 op 字段判定）')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（默认脚本所在仓库）')
    args = ap.parse_args(argv)
    if args.apply and args.dry_run:
        ap.error('--apply 与 --dry-run 只能选一个')
    args.action = 'apply' if args.apply else 'dry-run'
    return args


def _print_changes(plan):
    print('派生文件: 待更新 %d 个' % len(plan['changes']))
    for rel, old, new in plan['changes']:
        state = '新建' if old is None else '更新'
        print('    %-30s %s  %8d B' % (rel, state, len(new)))


def _print_add_plan(plan, where):
    meta = plan['meta']
    print('导入文件: %s' % where)
    print('操作    : 新增（add）')
    print('文章 id : %s' % meta['id'])
    print('标题    : %s' % meta['title'])
    print('日期    : %s' % meta['date'])
    print('标签    : %s' % ', '.join(meta['tags']))
    if 'series' in meta:
        print('系列    : %s（第 %s 篇）' % (meta['series'], meta.get('seriesOrder')))
    print('正文    : %d 字符 → data/posts/%s.md（新建）' % (len(plan['body']), meta['id']))
    print('元数据  : 插入 js/data.js 的 POSTS 首位（readingMinutes=%d）' % meta['readingMinutes'])
    _print_changes(plan)


def _diff_summary(previous, meta):
    rows = []
    if previous.get('title') != meta['title']:
        rows.append('标题: %r → %r' % (previous.get('title'), meta['title']))
    if previous.get('date') != meta['date']:
        rows.append('日期: %s → %s' % (previous.get('date'), meta['date']))
    if list(previous.get('tags') or []) != list(meta['tags']):
        rows.append('标签: %s → %s' % (', '.join(previous.get('tags') or []) or '（空）',
                                       ', '.join(meta['tags']) or '（空）'))
    if previous.get('excerpt') != meta['excerpt']:
        rows.append('摘要: 已修改（%d → %d 字符）' % (len(previous.get('excerpt') or ''), len(meta['excerpt'])))
    if previous.get('readingMinutes') != meta['readingMinutes']:
        rows.append('阅读时长: %s → %s 分钟' % (previous.get('readingMinutes'), meta['readingMinutes']))
    return rows


def _print_update_plan(plan, where, body_changed):
    meta = plan['meta']
    previous = plan['previous']
    print('导入文件: %s' % where)
    print('操作    : 更新（update）')
    print('文章 id : %s（不变，URL 不变）' % meta['id'])
    print('标题    : %s' % meta['title'])
    print('日期    : %s' % meta['date'])
    print('标签    : %s' % ', '.join(meta['tags']))
    if body_changed:
        print('正文    : 已修改（%d → %d 字符）→ data/posts/%s.md（覆盖）'
              % (len(plan.get('previous_body') or ''), len(plan['body']), meta['id']))
    else:
        print('正文    : 未修改 → data/posts/%s.md（内容保持原样）' % meta['id'])
    rows = _diff_summary(previous, meta)
    if rows:
        print('元数据  :')
        for row in rows:
            print('    - ' + row)
    else:
        print('元数据  : 未修改')
    _print_changes(plan)


def main(argv=None):
    args = parse_args(argv)
    root = os.path.abspath(args.root)

    try:
        where, text = read_import_file(args.file)
        name = os.path.basename(where)
        data = parse_json(text, name)
        op = op_of(data, name)
        if args.mode != 'auto' and args.mode != op:
            raise ImportFailure('这份文件是 %s 稿，但 --mode %s 要求的是 %s 稿（拒绝猜测）'
                                % (op, args.mode, args.mode))

        if op == 'update':
            ups = validate_update(data, name)
            p, state = load_repo(root)
            ensure_canonical(p, state)
            ensure_repo_consistent(root, '更新')
            index = find_target_index(state, ups['id'])
            verify_original(state, p, ups, index)
            plan = build_update_plan(root, p, state, ups, index)
            plan['previous_body'] = state['bodies'][ups['id']]
        else:
            post = validate_post_fields(data, name)
            p, state = load_repo(root)
            ensure_canonical(p, state)
            ensure_no_conflict(p, state, post['id'])
            plan = build_add_plan(root, p, state, post)
    except ImportConflict as e:
        print('[CONFLICT] %s' % e, file=sys.stderr)
        return 2
    except ImportFailure as e:
        print('[FAIL] %s' % e, file=sys.stderr)
        return 1
    except bc.LockBusy as e:
        print('[BUSY] %s' % e, file=sys.stderr)
        return 3

    if plan['op'] == 'update':
        _print_update_plan(plan, where, ups['post']['content'] != plan['previous_body'])
        if ups['post']['content'] == plan['previous_body'] and plan['previous'] == plan['meta']:
            print('注意    : 更新稿与当前版本完全一致（没有实际改动），导入后不会产生任何差异')
    else:
        _print_add_plan(plan, where)

    if args.action == 'dry-run':
        print('（--dry-run：未写入任何文件。确认无误后加 --apply）')
        return 0

    try:
        if plan['op'] == 'update':
            apply_update_plan(root, p, plan)
        else:
            apply_add_plan(root, p, plan)
    except ImportConflict as e:
        print('[CONFLICT] %s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 2
    except ImportFailure as e:
        print('[FAIL] %s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 1
    except bc.LockBusy as e:
        print('[BUSY] %s（未做任何写入）' % e, file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print('[ABORT] 已中断（已回滚，仓库未改变）', file=sys.stderr)
        return 1
    except OSError as e:
        print('[FAIL] IO 错误：%s（已回滚，仓库未改变）' % e, file=sys.stderr)
        return 1

    print('OK: 已%s %s（文章 %d 篇）' % ('导入' if plan['op'] == 'add' else '更新',
                                    plan['id'], len(plan['manifest']['posts'])))
    print('下一步：')
    if plan['op'] == 'add':
        print('  1) git diff 复核（只应出现 1 个新 md + 4 个派生文件）')
    else:
        print('  1) git diff 复核（只应出现 1 个被改的 md + 4 个派生文件，其它文章不应变化）')
    print('  2) python scripts/build_content.py --check')
    print('  3) 提交分支并手动开 PR（见 BATCH8B1_REPORT.md「实际操作步骤」）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
