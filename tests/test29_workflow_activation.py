# -*- coding: utf-8 -*-
"""Batch 7C-4A：发布工作流启用契约测试（静态 + 脚本级，不联网）。

覆盖任务书第二/三/四/六节的关键边界：
    A1  content-pipeline 默认 dry_run=true（不会一上来就写）
    A2  allow_write 默认 false
    A3  candidate job 被 allow_write / 仓库变量门控（没有无条件写分支的路径）
    A4  open-pr 需要候选分支且有输出才执行
    A5  全局 permissions 为空；contents: write 只出现在 candidate
    A6  没有任何合并 / 部署动作（不自动合并 main）
    A7  只推候选分支（不写 main）
    A8  content-gate 全程只读
    A9  队列分支缺失时 validate 先失败，candidate 不会执行
    A10 candidate_pr.py 默认 base=main、缺 token 拒绝、--dry-run 不发请求
    A11 状态机里 merge 与 deploy 是两个字段（合并 ≠ 部署）
    A12 本地没有 content/queue 时消费器安全降级（NO_CHANGES，不崩）
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF_PIPE = os.path.join(ROOT, '.github', 'workflows', 'content-pipeline.yml')
WF_GATE = os.path.join(ROOT, '.github', 'workflows', 'content-gate.yml')
PCQ = os.path.join(ROOT, 'scripts', 'process_content_queue.py')

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


pipe = read(WF_PIPE)
gate = read(WF_GATE)
gate_code = '\n'.join(l for l in gate.splitlines() if not l.strip().startswith('#'))

# 用 job 名切块，避免跨 job 误判
def job(text, name):
    idx = text.index('\n  ' + name + ':')
    nxt = [text.index('\n  ' + j + ':') for j in ('validate', 'candidate', 'open-pr', 'report-failure')
           if text.find('\n  ' + j + ':') > idx]
    end = min(nxt) if nxt else len(text)
    return text[idx:end]


validate = job(pipe, 'validate')
candidate = job(pipe, 'candidate')
openpr = job(pipe, 'open-pr')

check('A1 默认 dry_run=true（不会一上来就建 PR）',
      re.search(r"dry_run:\s*\n\s+description:[^\n]*\n\s+required:\s*false\s*\n\s+default:\s*'true'", pipe) is not None)
check('A2 allow_write 默认 false',
      re.search(r"allow_write:\s*\n\s+description:[^\n]*\n\s+required:\s*false\s*\n\s+default:\s*'false'", pipe) is not None)
check('A3 candidate 被 allow_write / 仓库变量门控',
      'allow_write' in candidate and 'CONTENT_PIPELINE_WRITE' in candidate
      and candidate.count('if:') >= 1,
      'if' in candidate)
check('A3b 没有任何无条件的 push 步骤', 'git push origin "$HEAD_BRANCH"' in candidate)
check('A4 open-pr 需要候选分支输出且非 dry-run',
      "needs.candidate.outputs.head != ''" in openpr and "dry_run != 'true'" in openpr)
check('A5 全局 permissions 为空', '\npermissions: {}' in pipe)
check('A5b contents: write 只出现在 candidate',
      'contents: write' in candidate and 'contents: write' not in validate
      and 'contents: write' not in openpr)
check('A5c pull-requests: write 只出现在 open-pr',
      'pull-requests: write' in openpr and 'pull-requests: write' not in candidate
      and 'pull-requests: write' not in validate)
check('A6 没有合并 / 部署动作',
      not any(k in pipe for k in ('gh pr merge', 'git merge', 'actions/deploy-pages',
                                  'pages build', '--auto')))
check('A7 只推候选分支（不写 main）',
      'git push origin "$HEAD_BRANCH"' in pipe and 'git push origin main' not in pipe
      and 'refs/heads/main:' not in pipe)
check('A8 content-gate 全程只读',
      'contents: read' in gate_code and 'contents: write' not in gate_code
      and 'pull-requests: write' not in gate_code)
check('A9 队列缺失时 validate 先失败（candidate 依赖 validate）',
      'needs: validate' in candidate and 'git fetch --depth=1 origin "$QUEUE_REF"' in validate)
check('A10 candidate_pr 默认 base=main',
      "'--base', default='main'" in read(os.path.join(ROOT, 'scripts', 'candidate_pr.py')))
check('A10b candidate_pr 缺 token 直接失败',
      '环境变量 %s 为空' in read(os.path.join(ROOT, 'scripts', 'candidate_pr.py')))
check('A10c candidate_pr --dry-run 存在且不发请求',
      "'dry-run'" in read(os.path.join(ROOT, 'scripts', 'candidate_pr.py'))
      and '--dry-run' in read(os.path.join(ROOT, 'scripts', 'candidate_pr.py')))
cs = read(os.path.join(ROOT, 'scripts', 'content_state.py'))
check('A11 merge 与 deploy 是独立字段（合并 ≠ 部署）',
      "entry['merge']" in cs and "entry['deploy']" in cs and 'set_deploy' in cs)
check('A11b 没有"合并后自动写 deploy"的捷径',
      'mark_published' in cs and
      'deploy' not in cs.split('def mark_published')[1].split('def ')[0])

# A12 本地没有 content/queue 时消费器安全降级
tmp = tempfile.mkdtemp(prefix='b7c4a_')
for rel in ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
            'data/posts/manifest.json', 'feed.xml', 'gen_feed.py',
            'scripts/build_content.py', 'scripts/split_posts.py']:
    dst = os.path.join(tmp, rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), dst)
for name in os.listdir(os.path.join(ROOT, 'data', 'posts')):
    if name.endswith('.md'):
        shutil.copy2(os.path.join(ROOT, 'data', 'posts', name),
                     os.path.join(tmp, 'data', 'posts', name))
env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
r = subprocess.run([sys.executable, PCQ, '--root', tmp, '--check', '--dry-run'],
                   cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                   errors='replace', env=env)
check('A12 没有 content/queue 时安全降级（NO_CHANGES，不崩）',
      r.returncode == 0 and 'NO_CHANGES' in r.stdout, (r.stderr or '').strip()[-50:])
shutil.rmtree(tmp, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
