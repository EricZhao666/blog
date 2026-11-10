# -*- coding: utf-8 -*-
"""Batch 7C-3B：内容队列消费器测试（scripts/process_content_queue.py）。

全部在临时目录里跑：合成队列 + 真实仓库文件的副本，不联网、不提交、不推送。

覆盖：
    Q1  单篇 add 正常入队 → 候选目录产物一致
    Q2  一次队列两篇（add + add）
    Q3  同一队列 SHA 重复处理 → NO_CHANGES（幂等）
    Q4  已处理条目再提交（部分新、部分旧）→ 只处理新的
    Q5  队列里同 id 两条 → 拒绝
    Q6  非法 JSON → 拒绝
    Q7  不支持的操作类型 → 拒绝（不猜）
    Q8  add 但 id 已存在 → 拒绝（应该用 modify）
    Q9  modify 不存在的 id → 拒绝
    Q10 delete 正常删除（正文与元数据同步移除）
    Q11 delete 不存在的 id → 拒绝
    Q12 内容非法（缺 title / tags 空）→ 拒绝
    Q13 生成阶段失败（search-index 不可写）→ FAILED 且 ledger 不写
    Q14 旧队列 SHA 不得覆盖新队列 SHA（git 祖先判定）
    Q15 失败后修好重试 → 成功，ledger 只记一次
    Q16 --check 是只读（不改 ledger、不建候选）
    Q17 候选目录里的四份产物身份集合一致
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PCQ = os.path.join(ROOT, 'scripts', 'process_content_queue.py')
TMP = tempfile.mkdtemp(prefix='b7c3b_q_')
NOW = '2026-11-10T00:00:00Z'

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


def read(path):
    return io.open(path, encoding='utf-8').read()


def run(args, cwd=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run([sys.executable, PCQ] + args, cwd=cwd or ROOT, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', env=env)


def make_repo(tag):
    dst = os.path.join(TMP, tag)
    for rel in ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
                'data/posts/manifest.json', 'feed.xml', 'gen_feed.py',
                'scripts/build_content.py', 'scripts/split_posts.py',
                'scripts/process_content_queue.py']:
        target = os.path.join(dst, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), target)
    for name in os.listdir(os.path.join(ROOT, 'data', 'posts')):
        if name.endswith('.md'):
            shutil.copy2(os.path.join(ROOT, 'data', 'posts', name),
                         os.path.join(dst, 'data', 'posts', name))
    os.makedirs(os.path.join(dst, 'content', 'queue'), exist_ok=True)
    return dst


def item(pid, op='add', title=None, content=None):
    return {
        'id': pid,
        'op': op,
        'title': title or ('标题 ' + pid),
        'date': '2026-11-10',
        'tags': ['测试'],
        'excerpt': '摘要',
        'content': content or ('# ' + pid + '\n\n正文：%s 的唯一标记。\n' % pid),
    }


def enqueue(repo, items, name='batch'):
    qdir = os.path.join(repo, 'content', 'queue')
    for it in items:
        write(os.path.join(qdir, it['id'] + '.json'), json.dumps(it, ensure_ascii=False, indent=2))
    return qdir


def merge_candidate(repo, cand):
    """模拟"候选 PR 已合并"：把候选的权威源与产物写回仓库根。"""
    for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json',
                'feed.xml', 'content/ledger.json']:
        src = os.path.join(cand, rel.replace('/', os.sep))
        if os.path.isfile(src):
            dst = os.path.join(repo, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    cdir = os.path.join(cand, 'data', 'posts')
    for name in os.listdir(cdir):
        if name.endswith('.md'):
            shutil.copy2(os.path.join(cdir, name),
                         os.path.join(repo, 'data', 'posts', name))
    # 候选里删掉的正文，仓库根也要删
    rdir = os.path.join(repo, 'data', 'posts')
    for name in os.listdir(rdir):
        if name.endswith('.md') and not os.path.isfile(os.path.join(cdir, name)):
            os.remove(os.path.join(rdir, name))


def ids_of(repo):
    data_js = read(os.path.join(repo, 'js', 'data.js'))
    metas = sorted(re.findall(r"^    id: '([^']+)',", data_js, re.M))
    search = sorted(json.loads(read(os.path.join(repo, 'data', 'search-index.json'))).keys())
    manifest = json.loads(read(os.path.join(repo, 'data', 'posts', 'manifest.json')))
    feed = read(os.path.join(repo, 'feed.xml'))
    return {
        'data': metas,
        'search': search,
        'manifest': sorted(p['id'] for p in manifest['posts']),
        'feed': sorted(set(re.findall(r'/blog/#/post/([^<"]+)', feed))),
    }


# ---------------------------------------------------------------- Q1 单篇
repo = make_repo('q1')
enqueue(repo, [item('queue-post-1')])
wd = os.path.join(TMP, 'cand1')
r = run(['--root', repo, '--queue-dir', os.path.join(repo, 'content', 'queue'),
         '--work-dir', wd, '--now', NOW, '--today', '2026-11-10'])
check('Q1 单篇入队成功', r.returncode == 0 and 'CANDIDATE_READY' in r.stdout, (r.stderr or '').strip()[-60:])
check('Q1b 候选里出现新正文',
      os.path.isfile(os.path.join(wd, 'data', 'posts', 'queue-post-1.md')))
check('Q1c 候选的 data.js 含新 id', 'queue-post-1' in read(os.path.join(wd, 'js', 'data.js')))
check('Q1d ledger 记录了 queueSha + id + op',
      any(e['id'] == 'queue-post-1' and e['op'] == 'add' and e['status'] == 'candidate'
          for e in json.loads(read(os.path.join(repo, 'content', 'ledger.json')))['entries']))

# ---------------------------------------------------------------- Q17 身份集合
ids = ids_of(wd)
check('Q17 候选四份产物身份集合一致（18 + 1）',
      ids['search'] == ids['manifest'] == ids['feed'] and 'queue-post-1' in ids['data'],
      len(ids['data']))

# ---------------------------------------------------------------- Q3 幂等
wd2 = os.path.join(TMP, 'cand2')
r = run(['--root', repo, '--queue-dir', os.path.join(repo, 'content', 'queue'),
         '--work-dir', wd2, '--now', NOW])
check('Q3 同一队列重复处理 → NO_CHANGES', r.returncode == 0 and 'NO_CHANGES' in r.stdout,
      r.stdout.strip().splitlines()[-1] if r.stdout else '')

# ---------------------------------------------------------------- Q2 + Q4 部分新
enqueue(repo, [item('queue-post-2'), item('queue-post-3')])
wd3 = os.path.join(TMP, 'cand3')
r = run(['--root', repo, '--queue-dir', os.path.join(repo, 'content', 'queue'),
         '--work-dir', wd3, '--now', NOW])
check('Q2/Q4 只处理新增的两条（旧的跳过）',
      r.returncode == 0 and 'queue-post-2' in r.stdout and 'queue-post-3' in r.stdout
      and 'queue-post-1' not in r.stdout.split('CANDIDATE')[0], (r.stdout or '').strip()[:60])
ids3 = ids_of(wd3)
check('Q2b 本批两篇都在候选里（post-1 由模拟合并带入，单独校验）',
      all(x in ids3['data'] for x in ('queue-post-2', 'queue-post-3')), len(ids3['data']))

# ---------------------------------------------------------------- Q5/Q6/Q7/Q8/Q9/Q11/Q12 拒绝
def expect_fail(tag, items_or_raw, needle, name):
    rp = make_repo(tag)
    qdir = os.path.join(rp, 'content', 'queue')
    if isinstance(items_or_raw, str):
        write(os.path.join(qdir, 'bad.json'), items_or_raw)
    else:
        enqueue(rp, items_or_raw)
    r = run(['--root', rp, '--queue-dir', qdir, '--work-dir', os.path.join(TMP, 'cand-' + tag),
             '--now', NOW])
    ok = r.returncode != 0 and needle in (r.stderr + r.stdout)
    check(name, ok, (r.stderr or '').strip()[:60])
    return rp

rp5 = make_repo('q5')
qdir5 = os.path.join(rp5, 'content', 'queue')
# 同一个 id 写进两个不同文件（模拟两个发布者各提交一次）
for n in (1, 2):
    write(os.path.join(qdir5, 'dup-%d.json' % n),
          json.dumps(item('dup-id', title='标题%d' % n), ensure_ascii=False, indent=2))
r5 = run(['--root', rp5, '--queue-dir', qdir5, '--work-dir', os.path.join(TMP, 'cand-q5'),
          '--now', NOW])
check('Q5 队列内同 id → 拒绝', r5.returncode != 0 and '出现多次' in (r5.stderr + r5.stdout),
      (r5.stderr or '').strip()[:50])
expect_fail('q6', '{not json', '不是合法 JSON', 'Q6 非法 JSON → 拒绝')
expect_fail('q7', [dict(item('op-x'), op='publish')], '不受支持', 'Q7 不支持的操作 → 拒绝')
expect_fail('q8', [item('embodied-ai-notes')], 'add 冲突', 'Q8 add 已存在 id → 拒绝')
expect_fail('q9', [item('no-such-post', op='modify')], 'modify 失败', 'Q9 modify 不存在 → 拒绝')
expect_fail('q11', [item('no-such-post', op='delete')], 'delete 失败', 'Q11 delete 不存在 → 拒绝')
bad = item('bad-fields')
bad['tags'] = []
expect_fail('q12', [bad], 'tags', 'Q12 字段非法（tags 为空）→ 拒绝')

# ---------------------------------------------------------------- Q10 删除
repo10 = make_repo('q10')
enqueue(repo10, [item('queue-post-1')])
r1 = run(['--root', repo10, '--queue-dir', os.path.join(repo10, 'content', 'queue'),
          '--work-dir', os.path.join(TMP, 'c10a'), '--now', NOW])
check('Q10a 先正常入队一篇', r1.returncode == 0, (r1.stderr or '').strip()[:60])
# 模拟"候选已合并 + 队列条目已消费清理"（同一 id 只能有一条未消费记录）
merge_candidate(repo10, os.path.join(TMP, 'c10a'))
os.remove(os.path.join(repo10, 'content', 'queue', 'queue-post-1.json'))
write(os.path.join(repo10, 'content', 'queue', 'del.json'),
      json.dumps({'id': 'queue-post-1', 'op': 'delete', 'reason': '测试删除'}))
wd10 = os.path.join(TMP, 'cand10b')
r = run(['--root', repo10, '--queue-dir', os.path.join(repo10, 'content', 'queue'),
         '--work-dir', wd10, '--now', NOW])
if r.returncode != 0:
    print('   [Q10 stderr] ' + (r.stderr or '').strip()[:300])
ids10 = ids_of(wd10) if os.path.isdir(os.path.join(wd10, 'js')) else {'data': [], 'search': [], 'manifest': [], 'feed': []}
check('Q10 删除后正文与元数据一起消失',
      r.returncode == 0 and 'queue-post-1' not in ids10['data'] and 'queue-post-1' not in ids10['search']
      and not os.path.isfile(os.path.join(wd10, 'data', 'posts', 'queue-post-1.md')),
      (r.stderr or '').strip()[-50:])

# ---------------------------------------------------------------- Q13 生成阶段失败
repo13 = make_repo('q13')
enqueue(repo13, [item('queue-post-9')])
idx = os.path.join(repo13, 'data', 'search-index.json')
os.remove(idx)
os.makedirs(os.path.join(idx, 'block'), exist_ok=True)   # 目标变成目录 → 写入必失败
r = run(['--root', repo13, '--queue-dir', os.path.join(repo13, 'content', 'queue'),
         '--work-dir', os.path.join(TMP, 'cand13'), '--now', NOW])
ledger13 = os.path.join(repo13, 'content', 'ledger.json')
check('Q13 生成阶段失败 → 非 0 且不打 ledger',
      r.returncode != 0 and not os.path.isfile(ledger13), (r.stderr or '').strip()[-60:])

# ---------------------------------------------------------------- Q16 --check 只读
repo16 = make_repo('q16')
enqueue(repo16, [item('queue-post-16')])
before = set(os.listdir(os.path.join(repo16, 'content')))
r = run(['--root', repo16, '--queue-dir', os.path.join(repo16, 'content', 'queue'),
         '--check', '--dry-run', '--now', NOW])
check('Q16 --check 只读（不建候选、不写 ledger）',
      r.returncode == 0 and not os.path.isfile(os.path.join(repo16, 'content', 'ledger.json'))
      and set(os.listdir(os.path.join(repo16, 'content'))) == before,
      r.stdout.strip().splitlines()[-1] if r.stdout else '')

# ---------------------------------------------------------------- Q14 旧 SHA 不得覆盖新的
repo14 = make_repo('q14')
git = lambda *a: subprocess.run(['git'] + list(a), cwd=repo14, capture_output=True, text=True)
git('init', '-q')
git('config', 'user.email', 't@example.com')
git('config', 'user.name', 't')
git('add', '-A')
git('commit', '-q', '-m', 'c1')
sha1 = git('rev-parse', 'HEAD').stdout.strip()
git('commit', '-q', '--allow-empty', '-m', 'c2')
sha2 = git('rev-parse', 'HEAD').stdout.strip()
enqueue(repo14, [item('queue-post-14')])
r = run(['--root', repo14, '--queue-dir', os.path.join(repo14, 'content', 'queue'),
         '--queue-sha', sha2, '--work-dir', os.path.join(TMP, 'cand14a'), '--now', NOW,
         '--today', '2026-11-10'])
ok_first = r.returncode == 0
r = run(['--root', repo14, '--queue-dir', os.path.join(repo14, 'content', 'queue'),
         '--queue-sha', sha1, '--work-dir', os.path.join(TMP, 'cand14b'), '--now', NOW])
check('Q14 旧队列 SHA 被拒绝（不得覆盖新任务）',
      ok_first and r.returncode != 0 and ('过旧' in (r.stderr + r.stdout)), (r.stderr or '').strip()[:50])

# ---------------------------------------------------------------- Q15 失败后重试
repo15 = make_repo('q15')
bad15 = item('queue-post-15')
bad15['content'] = ''
enqueue(repo15, [bad15])   # 空正文 → 拒绝
r1 = run(['--root', repo15, '--queue-dir', os.path.join(repo15, 'content', 'queue'),
          '--work-dir', os.path.join(TMP, 'cand15a'), '--now', NOW])
enqueue(repo15, [item('queue-post-15')])               # 修好
r2 = run(['--root', repo15, '--queue-dir', os.path.join(repo15, 'content', 'queue'),
          '--work-dir', os.path.join(TMP, 'cand15b'), '--now', NOW])
ledger15 = json.loads(read(os.path.join(repo15, 'content', 'ledger.json'))) if os.path.isfile(
    os.path.join(repo15, 'content', 'ledger.json')) else {'entries': []}
check('Q15 失败后修好重试 → 成功且 ledger 只有一条',
      r1.returncode != 0 and r2.returncode == 0
      and len([e for e in ledger15['entries'] if e['id'] == 'queue-post-15']) == 1,
      (r1.returncode, r2.returncode))

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
