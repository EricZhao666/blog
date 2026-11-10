#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内容队列消费器（Batch 7C-3B）。

把 `content/queue/<id>.json` 规范化成统一权威格式（`data/posts/<id>.md` + `js/data.js` 元数据），
再调用 `build_content.py --sync` 生成派生数据 —— 全程在**隔离目录**里做，不动工作区。

队列条目 schema（严格）
----------------------
    {
      "id":      "post-xxxx",           必填，^[a-z0-9][a-z0-9-]*$
      "op":      "add|modify|delete",   可选，缺省 = "add"（向后兼容编辑器的既有载荷）
      "title":   "...",                 add/modify 必填
      "date":    "YYYY-MM-DD",          add/modify 必填
      "tags":    ["..."],               add/modify 必填
      "excerpt": "...",                 add/modify 必填
      "content": "# Markdown...",       add/modify 必填
      "reason":  "..."                  delete 可选
    }

未支持的操作（`op` 不在三者之内）直接拒绝；不做任何"猜你想干什么"的推断。

消费游标 / 幂等
---------------
`content/ledger.json` 记录已消费过的 `(queueSha, id, op)`；再次处理同一个队列 SHA 时，
已记录的条目直接跳过（幂等），新条目按状态 `candidate` 写入，随候选提交一起进仓库，
合并后才算 `published`。同一个 id 在一个队列里出现两次 → 直接失败。

并发与陈旧
----------
* `--root` 下用锁文件互斥（同一台机器/同一个 CI job 内生效）；
* ledger 记 `lastQueueSha`；若本次队列 SHA 是它的祖先（旧任务），拒绝执行，避免旧任务覆盖新任务。

用法：
    python scripts/process_content_queue.py --queue-dir content/queue --check
    python scripts/process_content_queue.py --queue-dir content/queue --work-dir D:/tmp/cand
    python scripts/process_content_queue.py --queue-ref origin/content/queue --work-dir D:/tmp/cand
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, REPO_DIR)
sys.path.insert(0, SCRIPT_DIR)

import split_posts as sp      # noqa: E402
import build_content as bc    # noqa: E402

LEDGER = 'content/ledger.json'
QUEUE_DIR = 'content/queue'
LOCK_NAME = '.queue-process.lock'
OPS = ('add', 'modify', 'delete')
STATUS = ('pending', 'candidate', 'published', 'failed')


class QueueError(Exception):
    """队列内容不合法 / 状态冲突：必须中止，且不产生候选。"""


# --------------------------------------------------------------------- 工具
def read_json(path, what):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except ValueError as e:
        raise QueueError('%s 不是合法 JSON：%s' % (what, e))


def sha256_text(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def run(cmd, cwd):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


def git(args, cwd):
    return run(['git'] + args, cwd)


# --------------------------------------------------------------------- 队列读取
def load_queue(queue_dir):
    """读取 content/queue/*.json（不含 ledger），返回 [(文件名, item)]。"""
    if not os.path.isdir(queue_dir):
        return []
    out = []
    for name in sorted(os.listdir(queue_dir)):
        if not name.endswith('.json') or name == 'ledger.json':
            continue
        path = os.path.join(queue_dir, name)
        raw = read_json(path, '队列条目 ' + name)
        item = normalize_item(raw, name)
        out.append((name, item))
    ids = [it['id'] for _, it in out]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise QueueError('队列里同一 id 出现多次（同一 id 只能有一条未消费记录，已消费的条目请清理）：' + '、'.join(dup))
    return out


def normalize_item(raw, source):
    """严格校验；任何不确定都失败，不猜。"""
    if not isinstance(raw, dict):
        raise QueueError('%s 不是对象' % source)
    pid = raw.get('id')
    if not isinstance(pid, str) or not sp.SAFE_ID.match(pid or ''):
        raise QueueError('%s 的 id 非法（只允许 [a-z0-9-]）：%r' % (source, pid))
    op = raw.get('op', 'add')
    if op not in OPS:
        raise QueueError('%s 的操作 %r 不受支持（只允许 add/modify/delete）' % (source, op))
    item = {'id': pid, 'op': op, 'source': source}
    if op == 'delete':
        item['reason'] = raw.get('reason', '')
        return item
    for key in ('title', 'date', 'tags', 'excerpt', 'content'):
        if key not in raw:
            raise QueueError('%s（%s）缺少字段 %s' % (source, pid, key))
    if not isinstance(raw['title'], str) or not raw['title'].strip():
        raise QueueError('%s（%s）的 title 不能为空' % (source, pid))
    if not isinstance(raw['date'], str) or not sp.DATE_RE.match(raw['date'].strip()):
        raise QueueError('%s（%s）的 date 必须是 YYYY-MM-DD' % (source, pid))
    try:
        datetime.datetime.strptime(raw['date'].strip(), '%Y-%m-%d')
    except ValueError:
        raise QueueError('%s（%s）的 date 不是真实日期：%r' % (source, pid, raw['date']))
    if (not isinstance(raw['tags'], list) or not raw['tags']
            or not all(isinstance(t, str) and t for t in raw['tags'])):
        raise QueueError('%s（%s）的 tags 必须是非空字符串数组' % (source, pid))
    if not isinstance(raw['excerpt'], str):
        raise QueueError('%s（%s）的 excerpt 必须是字符串' % (source, pid))
    if not isinstance(raw['content'], str) or not raw['content'].strip():
        raise QueueError('%s（%s）缺少正文 content' % (source, pid))
    item.update({
        'title': raw['title'],
        'date': raw['date'].strip(),
        'tags': list(raw['tags']),
        'excerpt': raw['excerpt'],
        'content': raw['content'],
    })
    return item


# --------------------------------------------------------------------- ledger
def load_ledger(path):
    if not os.path.isfile(path):
        return {'version': 1, 'entries': [], 'lastQueueSha': None}
    data = read_json(path, 'ledger')
    if not isinstance(data, dict) or not isinstance(data.get('entries'), list):
        raise QueueError('ledger 结构非法')
    return data


def item_sha(item):
    """条目身份 = (id, op, 内容)。

    刻意**不**用 queueSha 当键：编辑器每加一篇都会改变队列分支 SHA，
    那样每次都会把历史条目重放一遍。
    """
    payload = {k: item.get(k) for k in ('id', 'op', 'title', 'date', 'tags', 'excerpt', 'content')}
    return sha256_text(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def ledger_keys(ledger):
    return {(e.get('id'), e.get('op'), e.get('itemSha')) for e in ledger.get('entries', [])}


def append_entries(ledger, queue_sha, items, day):
    for item in items:
        ledger['entries'].append({
            'queueSha': queue_sha,
            'id': item['id'],
            'op': item['op'],
            'itemSha': item_sha(item),
            'status': 'candidate',
            'at': day,
        })
    ledger['lastQueueSha'] = queue_sha
    return ledger


def dump_ledger(ledger):
    return json.dumps(ledger, ensure_ascii=False, indent=2, sort_keys=True) + '\n'


# --------------------------------------------------------------------- 应用
def read_posts(root):
    """返回 (数据文件原文未用, 原始元数据列表, TAG_ORDER)。"""
    _, posts, tag_order = sp.parse_js_file(os.path.join(root, 'js', 'data.js'))
    return posts, tag_order


def apply_ops(root, items):
    """把队列条目落到 root 的权威源（data.js 元数据 + data/posts/*.md）。"""
    posts, tag_order = read_posts(root)
    by_id = {p['id']: p for p in posts}
    touched = []
    for item in items:
        pid = item['id']
        exists = pid in by_id
        if item['op'] == 'add':
            if exists:
                raise QueueError('add 冲突：%s 已存在（要改内容请用 op=modify）' % pid)
            meta = {'id': pid, 'title': item['title'], 'date': item['date'],
                    'tags': item['tags'], 'excerpt': item['excerpt']}
            posts.append(meta)
            by_id[pid] = meta
        elif item['op'] == 'modify':
            if not exists:
                raise QueueError('modify 失败：%s 不存在（新文章请用 op=add）' % pid)
            meta = by_id[pid]
            meta.update({'title': item['title'], 'date': item['date'],
                         'tags': item['tags'], 'excerpt': item['excerpt']})
        else:  # delete
            if not exists:
                raise QueueError('delete 失败：%s 不存在' % pid)
            posts = [p for p in posts if p['id'] != pid]
            by_id.pop(pid, None)
        touched.append(item)

    # 正文
    for item in items:
        path = os.path.join(root, 'data', 'posts', item['id'] + '.md')
        if item['op'] == 'delete':
            if os.path.isfile(path):
                os.remove(path)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(item['content'])

    # 元数据（规范化后重写，交给 build_content 再做一次全量校验）
    metas = []
    for post in posts:
        body = sp.load_body(sp.paths(root), post['id'])
        metas.append(sp.normalize_meta(post, body))
    with open(os.path.join(root, 'js', 'data.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(sp.render_data_js(metas, tag_order) + '\n')
    return touched


def copy_tree(src, dst):
    skip = {'.git', 'node_modules', '.papers-id', 'tests/reports', 'tests/browser/artifacts',
            '.content-build.lock', LOCK_NAME}
    for name in os.listdir(src):
        if name in skip:
            continue
        s, d = os.path.join(src, name), os.path.join(dst, name)
        if os.path.isdir(s):
            shutil.copytree(s, d, ignore=shutil.ignore_patterns(*skip))
        else:
            shutil.copy2(s, d)


# --------------------------------------------------------------------- 主流程
def process(args):
    root = os.path.abspath(args.root)
    queue_dir = os.path.abspath(args.queue_dir) if args.queue_dir else os.path.join(root, QUEUE_DIR)
    queue_sha = args.queue_sha or _dir_sha(queue_dir)
    ledger_path = os.path.join(root, args.ledger)
    ledger = load_ledger(ledger_path)

    if args.queue_sha and ledger.get('lastQueueSha') and args.queue_sha != ledger['lastQueueSha']:
        stale, reason = _is_stale(root, args.queue_sha, ledger['lastQueueSha'])
        if stale:
            raise QueueError('队列版本过旧（%s 是 %s 的祖先），旧任务不得覆盖新任务'
                             % (args.queue_sha[:8], ledger['lastQueueSha'][:8]))

    entries = load_queue(queue_dir)
    done = ledger_keys(ledger)
    pending = [it for _, it in entries if (it['id'], it['op'], item_sha(it)) not in done]
    skipped = len(entries) - len(pending)

    report = {
        'queueSha': queue_sha,
        'queueDir': queue_dir,
        'total': len(entries),
        'skipped': skipped,
        'processed': [{'id': i['id'], 'op': i['op']} for i in pending],
        'status': 'no_changes',
        'candidateDir': None,
        'build': None,
        'ledgerPath': ledger_path,
    }

    if not pending:
        print('队列无新条目（共 %d 条，已处理 %d 条）' % (len(entries), skipped))
        print('NO_CHANGES')
        return 0, report

    work = os.path.abspath(args.work_dir) if args.work_dir else tempfile.mkdtemp(prefix='b7c3b_cand_')
    if os.path.isdir(work) and os.listdir(work):
        raise QueueError('--work-dir 必须是空目录：%s' % work)
    os.makedirs(work, exist_ok=True)
    copy_tree(root, work)
    report['candidateDir'] = work

    try:
        touched = apply_ops(work, pending)
    except sp.SplitError as e:
        raise QueueError(str(e))

    b = os.path.join(work, 'scripts', 'build_content.py')
    r = run([sys.executable, b, '--root', work, '--sync', '--now', args.now], work)
    report['build'] = {'syncRc': r.returncode, 'syncOut': (r.stdout or '').strip()[-400:]}
    if r.returncode != 0:
        report['status'] = 'failed'
        raise QueueError('候选构建失败：%s' % ((r.stderr or r.stdout or '').strip()[-300:]))

    r = run([sys.executable, b, '--root', work, '--check', '--now', args.now], work)
    report['build']['checkRc'] = r.returncode
    if r.returncode != 0:
        report['status'] = 'failed'
        raise QueueError('候选自检失败：%s' % ((r.stdout or r.stderr or '').strip()[-300:]))

    if not args.dry_run:
        append_entries(ledger, queue_sha, touched, args.today or _today())
        os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
        with open(ledger_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(dump_ledger(ledger))
        # 候选目录里的 ledger 也同步，保证"候选提交"自带消费记录
        cand_ledger = os.path.join(work, args.ledger)
        os.makedirs(os.path.dirname(cand_ledger), exist_ok=True)
        shutil.copy2(ledger_path, cand_ledger)

    report['status'] = 'candidate' if not args.dry_run else 'dry_run'
    print('队列 SHA: %s' % queue_sha)
    print('待处理 %d 条（跳过已处理 %d 条）：%s' % (
        len(pending), skipped, '、'.join('%s/%s' % (i['op'], i['id']) for i in pending)))
    for item in touched:
        print('  - %-6s %s' % (item['op'], item['id']))
    print('候选目录: %s' % work)
    print('CANDIDATE_READY' if not args.dry_run else 'DRY_RUN_OK')
    return 0, report


def _today():
    return datetime.date.today().isoformat()


def _dir_sha(path):
    """目录内容的稳定摘要（测试/无 git 场景的"队列版本"）。"""
    h = hashlib.sha256()
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            if name.endswith('.json') and name != 'ledger.json':
                h.update(name.encode('utf-8'))
                with open(os.path.join(path, name), 'rb') as f:
                    h.update(f.read())
    return h.hexdigest()[:16]


def _is_stale(root, new_sha, last_sha):
    r = git(['merge-base', '--is-ancestor', new_sha, last_sha], root)
    if r.returncode == 0:
        return True, 'ancestor'
    return False, 'not-ancestor'


def main(argv=None):
    ap = argparse.ArgumentParser(description='内容队列消费器')
    ap.add_argument('--root', default=REPO_DIR, help='仓库根目录（权威源所在）')
    ap.add_argument('--queue-dir', help='队列目录（默认 <root>/content/queue）')
    ap.add_argument('--queue-sha', help='本次队列提交 SHA（用于幂等/陈旧判定）')
    ap.add_argument('--ledger', default=LEDGER, help='消费记录路径（相对 root）')
    ap.add_argument('--work-dir', help='候选目录（必须是空目录；默认临时目录）')
    ap.add_argument('--now', default='2026-11-10T00:00:00Z', help='固定 feed 时间戳')
    ap.add_argument('--today', help='ledger 里的日期（默认今天，测试可固定）')
    ap.add_argument('--check', action='store_true', help='只读检查（不写 ledger、不建候选）')
    ap.add_argument('--dry-run', action='store_true', help='建候选但不写 ledger')
    ap.add_argument('--json', help='把报告写到这个路径')
    args = ap.parse_args(argv)
    if args.check:
        args.dry_run = True

    try:
        code, report = process(args)
    except QueueError as e:
        print('[FAIL] ' + str(e), file=sys.stderr)
        report = {'status': 'failed', 'error': str(e)}
        code = 1

    if args.json:
        with open(args.json, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(report, f, ensure_ascii=False, indent=2, sort_keys=True)
    if report.get('status') == 'failed':
        print('FAILED')
    return code


if __name__ == '__main__':
    sys.exit(main())
