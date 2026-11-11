# -*- coding: utf-8 -*-
"""Batch 7C-3B：候选 PR 与工作流契约测试。

两部分：
  A. scripts/candidate_pr.py —— 用**本地 mock GitHub API**（http.server）验证：
     W1  正常创建 PR（base=main、head=候选分支）
     W2  同一 head 已有 open PR → 复用，不重复创建
     W3  Token 权限不足（403）→ 失败且不创建
     W4  422（例如没有 diff）→ 明确失败
     W5  候选基于旧 main（main 已更新）→ 拒绝，不创建
     W6  --dry-run 不发任何请求
     W7  正文包含来源 SHA / 队列条目 / 校验结果
  B. .github/workflows/content-pipeline.yml —— 静态契约：
     W8  全局 permissions 为空，按 job 最小授权
     W9  只有 candidate job 有 contents: write，只有 open-pr 有 pull-requests: write
     W10 触发含 workflow_dispatch 与 push(content/queue)，且没有 merge/部署步骤
  C. 候选完整性：
     W11 候选缺派生文件 → build_content --check 失败（不会被当成可发布）
     W12 候选目录里篡改 feed → --check 失败
全程不联网（除 127.0.0.1）、不用真实 Token、不创建真实 PR。
"""
import http.server
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PR = os.path.join(ROOT, 'scripts', 'candidate_pr.py')
WF = os.path.join(ROOT, '.github', 'workflows', 'content-pipeline.yml')
TMP = tempfile.mkdtemp(prefix='b7c3b_pr_')

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def read(p):
    return io.open(p, encoding='utf-8').read()


# ------------------------------------------------------------------ mock API
class State:
    def __init__(self):
        self.existing = []
        self.create_status = 201
        self.list_status = 200
        self.created = []
        self.requests = []


def make_server(state):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            state.requests.append(('GET', self.path))
            if self.path.startswith('/repos/') and '/pulls?' in self.path:
                if state.list_status != 200:
                    return self._send(state.list_status, {'message': 'forbidden'})
                return self._send(200, state.existing)
            return self._send(404, {'message': 'Not Found'})

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}')
            state.requests.append(('POST', self.path, body))
            if state.create_status not in (200, 201):
                return self._send(state.create_status, {'message': 'Validation Failed'})
            state.created.append(body)
            return self._send(201, {'number': 42, 'html_url': 'http://127.0.0.1/pr/42'})

    return H


def serve(state):
    srv = http.server.HTTPServer(('127.0.0.1', 0), make_server(state))
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, 'http://127.0.0.1:%d' % srv.server_address[1]


def run_pr(args, token='fake-token'):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1', GITHUB_TOKEN=token)
    return subprocess.run([sys.executable, PR] + args, cwd=ROOT, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', env=env)


def base_args(api):
    return ['--head', 'content/candidate-abc12345', '--base', 'main',
            '--title', '内容候选：add/queue-post-1', '--repo', 'demo/demo-blog',
            '--api-base', api, '--main-sha', 'a' * 40, '--queue-sha', 'b' * 40,
            '--candidate-sha', 'c' * 40, '--items', 'add/queue-post-1']


# ------------------------------------------------------------------ A. PR
st = State()
srv, api = serve(st)
try:
    r = run_pr(base_args(api))
    ok = r.returncode == 0 and 'PR_CREATED' in r.stdout
    check('W1 正常创建 PR', ok, (r.stderr or '').strip()[-60:])
    body = st.created[0] if st.created else {}
    check('W1b base=main、head=候选分支',
          body.get('base') == 'main' and body.get('head') == 'content/candidate-abc12345',
          (body.get('base'), body.get('head')))
    check('W7 正文包含来源 SHA / 条目 / 校验结果',
          all(k in (body.get('body') or '') for k in ('a' * 40, 'b' * 40, 'c' * 40, 'queue-post-1', 'PASS')),
          (body.get('body') or '')[:40].replace('\n', ' '))

    st.existing = [{'number': 7, 'html_url': 'http://127.0.0.1/pr/7'}]
    before = len(st.created)
    r = run_pr(base_args(api))
    check('W2 已有同 head 的 open PR → 复用不重复创建',
          r.returncode == 0 and 'PR_EXISTS' in r.stdout and len(st.created) == before,
          (r.stdout or '').strip().splitlines()[-1] if r.stdout else '')
    st.existing = []

    st.create_status = 403
    r = run_pr(base_args(api))
    check('W3 权限不足（403）→ 失败且不创建', r.returncode != 0 and '权限' in (r.stderr + r.stdout),
          (r.stderr or '').strip()[:40])
    st.create_status = 422
    r = run_pr(base_args(api))
    check('W4 422 → 明确失败', r.returncode != 0 and '422' in (r.stderr + r.stdout),
          (r.stderr or '').strip()[:40])
    st.create_status = 201

    r = run_pr(base_args(api) + ['--require-main-sha', 'old-main', '--current-main-sha', 'new-main'])
    check('W5 候选基于旧 main → 拒绝（不沿用过期 CI）',
          r.returncode == 2 and 'STALE' in (r.stderr + r.stdout), (r.stderr or '').strip()[:40])

    before = len(st.requests)
    r = run_pr(base_args(api) + ['--dry-run'])
    check('W6 --dry-run 不发请求', r.returncode == 0 and 'DRY_RUN_OK' in r.stdout
          and len(st.requests) == before, len(st.requests) - before)

    r = run_pr(base_args(api), token='')
    check('W3b 无 Token（本地）→ 失败', r.returncode != 0 and '为空' in (r.stderr + r.stdout),
          (r.stderr or '').strip()[:30])
finally:
    srv.shutdown()

# ------------------------------------------------------------------ B. workflow 静态契约
wf = read(WF)
jobs = wf.split('\njobs:')[1] if '\njobs:' in wf else ''
validate = jobs.split('candidate:')[0]
candidate = jobs.split('candidate:')[1].split('open-pr:')[0]
openpr = jobs.split('open-pr:')[1].split('report-failure:')[0]

check('W8 全局 permissions 为空（按 job 授权）', '\npermissions: {}' in wf)
check('W9 validate 只读', 'permissions:\n      contents: read' in validate)
check('W9b 只有 candidate 能写 contents', 'contents: write' in candidate
      and 'contents: write' not in validate and 'contents: write' not in openpr)
check('W9c 只有 open-pr 有 pull-requests: write', 'pull-requests: write' in openpr
      and 'pull-requests: write' not in validate and 'pull-requests: write' not in candidate)
check('W10 触发含 workflow_dispatch 与 content/queue push',
      'workflow_dispatch:' in wf and 'content/queue' in wf and 'push:' in wf)
check('W10b 不含合并/部署动作',
      not any(k in wf for k in ('gh pr merge', 'git merge', 'actions/deploy-pages', 'pages build')))
check('W10c 候选基于 main 切分支（不是直接 merge 队列分支）',
      'checkout' in wf and 'ref: main' in wf)

# ------------------------------------------------------------------ C. 候选完整性
def make_cand(tag):
    dst = os.path.join(TMP, tag)
    for rel in ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
                'data/posts/manifest.json', 'feed.xml', 'gen_feed.py',
                'scripts/build_content.py', 'scripts/split_posts.py']:
        target = os.path.join(dst, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), target)
    for name in os.listdir(os.path.join(ROOT, 'data', 'posts')):
        if name.endswith('.md'):
            shutil.copy2(os.path.join(ROOT, 'data', 'posts', name),
                         os.path.join(dst, 'data', 'posts', name))
    return dst


def bc_check(root):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run([sys.executable, os.path.join(root, 'scripts', 'build_content.py'),
                           '--root', root, '--check', '--now', '2026-11-10T00:00:00Z'],
                          cwd=root, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', env=env)


c1 = make_cand('cand1')
check('W11 完整候选可以通过 --check', bc_check(c1).returncode == 0)
os.remove(os.path.join(c1, 'data', 'search-index.json'))
r = bc_check(c1)
check('W11b 候选缺派生文件 → --check 失败（不完整不得发布）', r.returncode != 0,
      (r.stderr or r.stdout).strip()[:50])

c2 = make_cand('cand2')
feed = os.path.join(c2, 'feed.xml')
io.open(feed, 'w', encoding='utf-8', newline='\n').write('<rss></rss>\n')
r = bc_check(c2)
check('W12 候选 feed 被篡改 → --check 失败', r.returncode != 0, (r.stderr or r.stdout).strip()[:50])

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
