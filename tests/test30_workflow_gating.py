# -*- coding: utf-8 -*-
"""Batch 7C-4A.1：发布工作流写入门控与候选完整性测试（纯静态解析，不联网）。

覆盖：
    G1  candidate 的 if 条件在 dry_run=true 时**任何** allow_write / 仓库变量组合都不放行
    G2  dry_run=false + 授权（allow_write 或仓库变量）才放行
    G3  dry_run=false + 无授权 → 只读（不推送）
    G4  open-pr 额外要求有候选分支且非 dry-run
    G5  完整回归确实在候选目录执行（working-directory = runner.temp/candidate）
    G6  候选目录会装依赖与 Chromium、跑全量 run_tests.py
    G7  候选产物哈希留档
    G8  推送前重新确认 main 未变化
    G9  validate 与 candidate 使用同一个 queue SHA（绑定校验）
    G10 PR 创建前重新确认 main，并把过期参数传给 candidate_pr
    G11 FEED_NOW 不再写死历史日期，改由队列提交时间决定
    G12 仍然没有合并 / 部署 / 自动 approve
"""
import io
import itertools
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, '.github', 'workflows', 'content-pipeline.yml')

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


text = io.open(WF, encoding='utf-8').read()


def job(name):
    idx = text.index('\n  ' + name + ':')
    names = ['validate', 'candidate', 'open-pr', 'report-failure']
    nxt = [text.index('\n  ' + j + ':') for j in names if text.find('\n  ' + j + ':') > idx]
    return text[idx:min(nxt) if nxt else len(text)]


cand = job('candidate')
opr = job('open-pr')

# ---------------------------------------------------------------- G1-G3 组合求值
m = re.search(r"\n    if: >-\n((?:      .*\n)+)", cand)
cond_src = m.group(1) if m else ''
expr = cond_src.replace('\n', ' ')
expr = re.sub(r'\s+', ' ', expr).strip()
expr = (expr.replace('github.event.inputs.dry_run', 'dry_run')
            .replace('github.event.inputs.allow_write', 'allow_write')
            .replace('needs.validate.outputs.items', 'items')
            .replace('vars.CONTENT_PIPELINE_WRITE', 'repo_var')
            .replace('&&', ' and ').replace('||', ' or '))
check('G0 能解析出 candidate 的 if 条件', bool(expr), expr[:60])

combos = []
for dry, allow, var in itertools.product(['true', 'false'], ['true', 'false'], ['enabled', 'off']):
    env = {'dry_run': dry, 'allow_write': allow, 'repo_var': var, 'items': 'add/post-x'}
    try:
        got = bool(eval(expr, {'__builtins__': {}}, env))
    except Exception as e:                      # 解析失败也算失败
        got = 'ERR:%s' % e
    combos.append((dry, allow, var, got))

dry_true = [c for c in combos if c[0] == 'true']
check('G1 dry_run=true 时任何组合都不放行（不会 push / 建 PR）',
      all(c[3] is False for c in dry_true), [(c[1], c[2], c[3]) for c in dry_true])

authorized = [c for c in combos if c[0] == 'false' and (c[1] == 'true' or c[2] == 'enabled')]
check('G2 dry_run=false + 已授权 → 放行',
      len(authorized) == 3 and all(c[3] is True for c in authorized), [c[3] for c in authorized])

readonly = [c for c in combos if c[0] == 'false' and c[1] == 'false' and c[2] == 'off']
check('G3 dry_run=false 但未授权 → 只读（不放行）',
      len(readonly) == 1 and readonly[0][3] is False, readonly[0][3])

check('G4 open-pr 要求候选分支且非 dry-run',
      "needs.candidate.outputs.head != ''" in opr and "dry_run != 'true'" in opr)

# ---------------------------------------------------------------- G5-G7 候选目录回归
check('G5 回归在候选目录执行（working-directory = runner.temp/candidate）',
      cand.count('working-directory: ${{ runner.temp }}/candidate') >= 2,
      cand.count('working-directory: ${{ runner.temp }}/candidate'))
check('G6 候选目录装依赖 + Chromium',
      'npm ci' in cand and 'playwright install' in cand and 'chromium' in cand)
check('G6b 候选目录跑完整 run_tests.py（不是 --only 子集）',
      'python scripts/run_tests.py' in cand and '--only' not in cand)
check('G7 候选产物哈希留档', 'sha256sum' in cand and 'candidate-hashes' in cand)

# ---------------------------------------------------------------- G8-G10 SHA 绑定
push_pos = cand.index('git push origin "$HEAD_BRANCH"')
recheck_pos = cand.index('git ls-remote origin refs/heads/main')
check('G8 推送前重新确认 main 未变化', recheck_pos < push_pos,
      (recheck_pos, push_pos))
check('G9 validate 与 candidate 的队列 SHA 绑定校验',
      'needs.validate.outputs.queue_sha' in cand and '队列 SHA 不一致' in cand)
check('G10 PR 前重新确认 main + 传过期参数',
      'git ls-remote origin refs/heads/main' in opr
      and '--require-main-sha' in opr and '--current-main-sha' in opr)

# ---------------------------------------------------------------- G11 时间戳
check('G11 FEED_NOW 不再写死', "FEED_NOW: '2026-" not in text)
check('G11b 由队列提交时间决定（可复现且不过期）',
      'git show -s --format=%cI FETCH_HEAD' in cand and 'FEED_NOW=' in cand)

# ---------------------------------------------------------------- G12 无自动合并
check('G12 仍无合并 / 部署 / 自动 approve',
      not any(k in text for k in ('gh pr merge', 'git merge', 'actions/deploy-pages',
                                  '--auto', 'gh pr review --approve')))

# ---------------------------------------------------------------- 写前模式日志
check('G13 写入前打印模式与来源 SHA',
      '模式: WRITE' in cand and 'main=' in cand and 'queue=' in cand)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
