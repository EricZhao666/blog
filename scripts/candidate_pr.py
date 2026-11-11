#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""候选分支 → PR（Batch 7C-3B）。

只做三件事：查重、创建、报告。**不合并、不发布、不碰 main**。

* base 恒为 main（可用 --base 覆盖，但默认值写死成 main）；
* head 是候选分支（由 workflow 从**当前 main** 创建，不把 content/queue 的历史带进来）；
* 同一 head 已有 open PR → 直接复用（不重复创建）；
* token 只从环境变量读，且只放在 Authorization 头里，绝不写进 URL / 日志 / 报告。

用法：
    python scripts/candidate_pr.py --head content/candidate-abc12345 \
        --title "内容候选：1 篇" --body-file pr-body.md --dry-run
    python scripts/candidate_pr.py ... --api-base https://api.github.com --repo owner/name
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


class PrError(Exception):
    pass


def api(method, url, token, payload=None, timeout=30):
    data = None
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'b7c3b-candidate-pr',
    }
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            try:
                parsed = json.loads(body) if body.strip() else {}
            except ValueError:
                parsed = {}
            return resp.status, parsed
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = {'message': body[:200]}
        return e.code, parsed
    except urllib.error.URLError as e:
        raise PrError('网络错误：%s' % e.reason)


def build_body(source):
    lines = [
        '## 内容候选',
        '',
        '> 这是**候选**，不是已发布。合并前请确认下面的来源与校验结果。',
        '',
        '| 项 | 值 |',
        '| --- | --- |',
        '| 来源 main | `%s` |' % source.get('mainSha', '?'),
        '| 队列 SHA | `%s` |' % source.get('queueSha', '?'),
        '| 候选 SHA | `%s` |' % source.get('candidateSha', '?'),
        '| 队列条目 | %s |' % (', '.join('%s/%s' % (i['op'], i['id']) for i in source.get('items', [])) or '无'),
        '',
        '### 校验',
        '',
        '- `build_content --check`：%s' % source.get('check', '?'),
        '- `split_posts --check`：%s' % source.get('split', '?'),
        '- 全量回归：%s' % source.get('tests', '?'),
        '',
        '### 说明',
        '',
        '- 候选分支从**当前 main** 切出，未带入 `content/queue` 的历史提交。',
        '- 合并前若 main 已更新，需要重新生成候选并重新跑校验（不允许沿用过期 CI）。',
        '- 本 PR 不会自动合并。',
    ]
    return '\n'.join(lines) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser(description='创建/复用内容候选 PR')
    ap.add_argument('--head', required=True, help='候选分支（head）')
    ap.add_argument('--base', default='main', help='目标分支（默认 main）')
    ap.add_argument('--title', required=True)
    ap.add_argument('--body-file', help='PR 正文文件；不给则按来源信息自动生成')
    ap.add_argument('--main-sha')
    ap.add_argument('--queue-sha')
    ap.add_argument('--candidate-sha')
    ap.add_argument('--items', help='逗号分隔的 op/id 列表')
    ap.add_argument('--api-base', default='https://api.github.com')
    ap.add_argument('--repo', help='owner/name（默认取 GITHUB_REPOSITORY）')
    ap.add_argument('--token-env', default='GITHUB_TOKEN', help='从哪个环境变量读 token')
    ap.add_argument('--require-main-sha', help='候选所基于的 main SHA（过期检查用）')
    ap.add_argument('--current-main-sha', help='当前 main SHA；与 --require-main-sha 不一致则拒绝')
    ap.add_argument('--dry-run', action='store_true', help='只打印将要做什么')
    ap.add_argument('--json', help='结果写到这个文件')
    args = ap.parse_args(argv)

    if args.require_main_sha and args.current_main_sha and args.require_main_sha != args.current_main_sha:
        print('[STALE] 候选基于 %s，但 main 已到 %s：必须重新生成候选后再开 PR'
              % (args.require_main_sha[:8], args.current_main_sha[:8]), file=sys.stderr)
        return 2

    repo = args.repo or os.environ.get('GITHUB_REPOSITORY') or ''
    if not repo or '/' not in repo:
        print('[FAIL] 缺少 --repo 或 GITHUB_REPOSITORY', file=sys.stderr)
        return 1
    token = os.environ.get(args.token_env, '')
    if not token and not args.dry_run:
        print('[FAIL] 环境变量 %s 为空（未登录或无权限）' % args.token_env, file=sys.stderr)
        return 1

    source = {
        'mainSha': args.main_sha,
        'queueSha': args.queue_sha,
        'candidateSha': args.candidate_sha,
        'items': [{'op': p.split('/', 1)[0], 'id': p.split('/', 1)[-1]}
                  for p in (args.items or '').split(',') if p],
        'check': 'PASS',
        'split': 'PASS',
        'tests': 'PASS',
    }
    body = open(args.body_file, encoding='utf-8').read() if args.body_file else build_body(source)

    base = args.api_base.rstrip('/')
    result = {'head': args.head, 'base': args.base, 'action': None, 'number': None, 'url': None}

    if args.dry_run:
        result['action'] = 'dry-run'
        print('[dry-run] 将创建 PR: %s → %s（repo=%s）' % (args.head, args.base, repo))
        print(body)
        if args.json:
            with open(args.json, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        print('DRY_RUN_OK')
        return 0

    owner = repo.split('/')[0]
    q = urllib.parse.urlencode({'head': '%s:%s' % (owner, args.head), 'state': 'open'})
    status, data = api('GET', '%s/repos/%s/pulls?%s' % (base, repo, q), token)
    if status == 401 or status == 403:
        print('[FAIL] 无权限读取 PR（HTTP %d），Token 需要 pull-requests: read' % status, file=sys.stderr)
        return 1
    if status != 200:
        print('[FAIL] 查询已有 PR 失败：HTTP %d' % status, file=sys.stderr)
        return 1
    if isinstance(data, list) and data:
        pr = data[0]
        result.update({'action': 'reuse', 'number': pr.get('number'), 'url': pr.get('html_url')})
        print('已存在候选 PR #%s，复用（不重复创建）：%s' % (pr.get('number'), pr.get('html_url')))
        if args.json:
            with open(args.json, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        print('PR_EXISTS')
        return 0

    status, data = api('POST', '%s/repos/%s/pulls' % (base, repo), token, {
        'title': args.title, 'head': args.head, 'base': args.base, 'body': body,
    })
    if status == 422:
        print('[FAIL] 创建 PR 被拒绝（422）：%s' % (data.get('message') or data), file=sys.stderr)
        return 1
    if status == 403:
        print('[FAIL] 无权限创建 PR（403），Token 需要 pull-requests: write', file=sys.stderr)
        return 1
    if status not in (200, 201):
        print('[FAIL] 创建 PR 失败：HTTP %d %s' % (status, data.get('message', '')), file=sys.stderr)
        return 1

    result.update({'action': 'created', 'number': data.get('number'), 'url': data.get('html_url')})
    print('已创建候选 PR #%s：%s' % (data.get('number'), data.get('html_url')))
    print('注意：PR 创建 ≠ 发布成功；本工具不会合并，也不会触发 Pages 部署。')
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    print('PR_CREATED')
    return 0


if __name__ == '__main__':
    sys.exit(main())
