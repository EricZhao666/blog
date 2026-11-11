# -*- coding: utf-8 -*-
"""Batch 7C-4B：门禁与候选状态发布契约（静态 + 本地模拟，不联网）。

覆盖：
    R1  content-gate **不再**在 workflow 层做 paths 过滤（required check 不会永久 Pending）
    R2  content-gate 内部按路径判定，无关变更时明确跳过且 job 仍成功
    R3  content-gate 只读（无 contents: write / pull-requests: write）
    R4  content-pipeline 给候选 SHA 发布 commit status（不依赖 PR 自动触发）
    R5  statuses: write 只出现在 candidate job
    R6  队列为空时 candidate / open-pr 都不会执行（零写入前提）
    R7  全仓库没有个人 PAT / 自动合并 / Pages 改写
    R8  权限矩阵保持：全局空、validate 只读、open-pr 只加 pull-requests
    R9  队列为空时 process_content_queue 返回 NO_CHANGES（真实执行，非文字断言）
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(ROOT, '.github', 'workflows', 'content-gate.yml')
PIPE = os.path.join(ROOT, '.github', 'workflows', 'content-pipeline.yml')
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


gate = read(GATE)
pipe = read(PIPE)
gate_code = '\n'.join(l for l in gate.splitlines() if not l.strip().startswith('#'))
pipe_code = '\n'.join(l for l in pipe.splitlines() if not l.strip().startswith('#'))


def job(text, name):
    idx = text.index('\n  ' + name + ':')
    names = ['validate', 'candidate', 'open-pr', 'report-failure']
    nxt = [text.index('\n  ' + j + ':') for j in names if text.find('\n  ' + j + ':') > idx]
    return text[idx:min(nxt) if nxt else len(text)]


cand = job(pipe_code, 'candidate')
opr = job(pipe_code, 'open-pr')
val = job(pipe_code, 'validate')

# R1：on.pull_request 下面不能有 paths 过滤
on_block = gate_code.split('on:')[1].split('permissions:')[0]
check('R1 content-gate 不再用 paths 过滤（required check 不会永久 Pending）',
      'paths:' not in on_block, on_block.strip().replace('\n', ' | ')[:60])
check('R1b 仍然由 pull_request 触发', 'pull_request:' in on_block)

# R2：内部判定 + 跳过分支
check('R2 内部按路径判定并显式跳过',
      'steps.scope.outputs.relevant' in gate and '无内容变更' in gate)
check('R2b 重活都有 relevant 条件',
      gate.count("if: steps.scope.outputs.relevant == 'true'") >= 4,
      gate.count("if: steps.scope.outputs.relevant == 'true'"))

# R3：只读
check('R3 content-gate 只读', 'contents: read' in gate_code
      and 'contents: write' not in gate_code
      and 'pull-requests: write' not in gate_code)

# R4/R5：候选状态发布
check('R4 候选 SHA 会收到正式 commit status',
      '/statuses/' in pipe and 'content-candidate' in pipe)
check('R4b 状态发布只在候选 SHA 存在时执行',
      "if: steps.push.outputs.candidate_sha != ''" in pipe)
check('R5 statuses: write 只在 candidate job',
      'statuses: write' in cand and 'statuses: write' not in val
      and 'statuses: write' not in opr)

# R6：空队列不进入写路径
check('R6 空队列时 candidate 不执行（items 为空即跳过）',
      "needs.validate.outputs.items != ''" in cand)
check('R6b open-pr 需要候选分支输出', "needs.candidate.outputs.head != ''" in opr)

# R7：无 PAT / 自动合并 / Pages 改写
for name, pat in [('个人 PAT', r'secrets\.PAT|GH_PAT|personal_access_token'),
                  ('自动合并', r'gh pr merge|--auto\b'),
                  ('改 Pages 来源', r'pages build|actions/deploy-pages|enable_pages')]:
    check('R7 无' + name, re.search(pat, pipe) is None)

# R8：权限矩阵
check('R8 全局 permissions 为空', '\npermissions: {}' in pipe)
check('R8b validate 只读', 'contents: read' in val and 'contents: write' not in val)
check('R8c open-pr 只多 pull-requests: write',
      'pull-requests: write' in opr and 'contents: write' not in opr)

# R9：空队列真实执行
tmp = tempfile.mkdtemp(prefix='b7c4b_')
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
os.makedirs(os.path.join(tmp, 'content', 'queue'), exist_ok=True)
env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
r = subprocess.run([sys.executable, PCQ, '--root', tmp, '--check', '--dry-run'],
                   cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                   errors='replace', env=env)
check('R9 空队列 → NO_CHANGES（零写入，不建候选）',
      r.returncode == 0 and 'NO_CHANGES' in r.stdout and
      not os.path.exists(os.path.join(tmp, 'content', 'ledger.json')),
      (r.stderr or '').strip()[-40:])
shutil.rmtree(tmp, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
