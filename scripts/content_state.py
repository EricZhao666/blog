#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内容候选状态机（Batch 7C-3B.1）。

把三件**不同**的事分开记录，任何一件都不能冒充另一件：

    candidate : 候选提交/PR 的状态（pending → candidate → published / closed / failed）
    merge     : Git 上是否真的合并了（mergeSha）
    deploy    : 线上是否真的部署成功（deploy.status）

因此 `merged=true` 不等于 `deployed=true`；`candidate` 也不等于"已上线"。

ledger 条目（由 process_content_queue.py 创建）形如::

    {"id": "...", "op": "add", "itemSha": "...", "status": "candidate",
     "queueSha": "...", "baseSha": "...", "at": "...",
     "pr": {"number": 12, "url": "..."},           # 可选
     "merge": {"sha": "...", "at": "..."},         # 合并后才有
     "deploy": {"status": "failed", "runId": "...", "at": "..."}}

状态转换表是白名单：不在表里的转换一律拒绝（不猜、不自动纠正）。

用法：
    python scripts/content_state.py --ledger content/ledger.json --check
    python scripts/content_state.py --ledger ... --id post-x --op add --to published --merge-sha abc123
    python scripts/content_state.py --ledger ... --id post-x --deploy failed --deploy-run 42 --deploy-sha abc123
    python scripts/content_state.py --ledger ... --check-main $(git rev-parse main)
"""
import argparse
import datetime
import json
import os
import sys

STATES = ('pending', 'candidate', 'published', 'closed', 'failed')
DEPLOY = ('unknown', 'pending', 'success', 'failed')

TRANSITIONS = {
    'pending':   {'candidate', 'failed'},
    'candidate': {'published', 'closed', 'failed'},
    'failed':    {'candidate', 'closed'},
    'closed':    {'candidate'},
    'published': set(),          # 终态：再发同一篇请新建条目
}


class StateError(Exception):
    pass


def load(path):
    if not os.path.isfile(path):
        raise StateError('找不到 ledger: %s' % path)
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except ValueError as e:
        raise StateError('ledger 不是合法 JSON：%s' % e)
    if not isinstance(data, dict) or not isinstance(data.get('entries'), list):
        raise StateError('ledger 结构非法')
    return data


def save(path, ledger):
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(ledger, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write('\n')
        os.replace(tmp, path)
    except OSError as e:
        # 写入失败必须保持原文件不变
        raise StateError('无法写入 ledger：%s' % e)


def today():
    return datetime.date.today().isoformat()


def find(ledger, pid, op=None):
    hits = [e for e in ledger['entries'] if e.get('id') == pid and (op is None or e.get('op') == op)]
    if not hits:
        raise StateError('ledger 里没有条目：%s/%s' % (pid, op or '*'))
    return hits[-1]


def check_entry(entry, index):
    pid = entry.get('id')
    if not isinstance(pid, str) or not pid:
        raise StateError('entries[%d] 缺少 id' % index)
    if entry.get('op') not in ('add', 'modify', 'delete'):
        raise StateError('entries[%d]（%s）的 op 非法：%r' % (index, pid, entry.get('op')))
    if entry.get('status') not in STATES:
        raise StateError('entries[%d]（%s）的 status 非法：%r' % (index, pid, entry.get('status')))
    deploy = entry.get('deploy')
    if deploy is not None:
        if not isinstance(deploy, dict) or deploy.get('status') not in DEPLOY:
            raise StateError('entries[%d]（%s）的 deploy 非法' % (index, pid))
    merge = entry.get('merge')
    if merge is not None and not (isinstance(merge, dict) and isinstance(merge.get('sha'), str)):
        raise StateError('entries[%d]（%s）的 merge 非法' % (index, pid))


def validate(ledger):
    seen = {}
    for i, e in enumerate(ledger['entries']):
        check_entry(e, i)
        seen.setdefault(e['id'], []).append(e)
    # 同一 id 允许多条（删除后重新添加），但同一 (op,itemSha) 不能既 published 又 candidate
    for pid, items in seen.items():
        pubs = {e.get('itemSha') for e in items if e['status'] == 'published'}
        cands = {e.get('itemSha') for e in items if e['status'] == 'candidate'}
        if pubs & cands:
            raise StateError('%s 的同一份内容既已发布又在候选状态' % pid)
    return True


def transition(entry, to, at=None):
    cur = entry.get('status')
    if to not in STATES:
        raise StateError('未知目标状态：%r' % to)
    if to not in TRANSITIONS.get(cur, set()):
        raise StateError('不允许的状态转换：%s → %s（%s）' % (cur, to, entry.get('id')))
    entry['status'] = to
    entry['statusAt'] = at or today()
    return entry


def mark_published(entry, merge_sha, at=None):
    if not isinstance(merge_sha, str) or len(merge_sha) < 7:
        raise StateError('--merge-sha 必填且至少 7 位')
    transition(entry, 'published', at)
    entry['merge'] = {'sha': merge_sha, 'at': at or today()}
    return entry


def set_deploy(entry, status, run_id=None, sha=None, at=None):
    """部署状态独立记录：合并成功不代表部署成功。"""
    if status not in DEPLOY:
        raise StateError('未知部署状态：%r' % status)
    entry['deploy'] = {'status': status, 'at': at or today()}
    if run_id:
        entry['deploy']['runId'] = str(run_id)
    if sha:
        entry['deploy']['sha'] = sha
    return entry


def stale_entries(ledger, current_main):
    """候选基于的 main 已经不是当前 main → 候选过期，必须重建。"""
    out = []
    for e in ledger['entries']:
        base = e.get('baseSha')
        if e.get('status') == 'candidate' and base and base != current_main:
            out.append(e)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='内容候选状态机')
    ap.add_argument('--ledger', required=True)
    ap.add_argument('--id')
    ap.add_argument('--op')
    ap.add_argument('--to', choices=STATES)
    ap.add_argument('--merge-sha')
    ap.add_argument('--deploy', choices=DEPLOY)
    ap.add_argument('--deploy-run')
    ap.add_argument('--deploy-sha')
    ap.add_argument('--check-main', help='当前 main SHA；候选若基于其它提交则判定过期')
    ap.add_argument('--check', action='store_true', help='只校验 ledger 结构')
    ap.add_argument('--json')
    args = ap.parse_args(argv)

    try:
        ledger = load(args.ledger)
        validate(ledger)
        if args.check and not args.id:
            print('OK: ledger 合法（%d 条）' % len(ledger['entries']))
            return 0

        if args.check_main:
            stale = stale_entries(ledger, args.check_main)
            if stale:
                for e in stale:
                    print('[STALE] %s 的候选基于 %s，当前 main 是 %s'
                          % (e['id'], str(e.get('baseSha'))[:8], args.check_main[:8]),
                          file=sys.stderr)
                return 1
            print('OK: 没有过期候选')

        if args.id:
            entry = find(ledger, args.id, args.op)
            if args.to:
                if args.to == 'published':
                    mark_published(entry, args.merge_sha)
                else:
                    transition(entry, args.to)
            if args.deploy:
                set_deploy(entry, args.deploy, args.deploy_run, args.deploy_sha)
            validate(ledger)
            save(args.ledger, ledger)
            print('OK: %s → %s%s' % (entry['id'], entry['status'],
                                     '（deploy=%s）' % entry['deploy']['status'] if entry.get('deploy') else ''))
        if args.json:
            with open(args.json, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(ledger, f, ensure_ascii=False, indent=2, sort_keys=True)
        return 0
    except StateError as e:
        print('[FAIL] ' + str(e), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
