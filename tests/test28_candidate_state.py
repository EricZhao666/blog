# -*- coding: utf-8 -*-
"""Batch 7C-3B.1：候选状态机测试（scripts/content_state.py + ledger 生命周期）。

覆盖任务书第三阶段的 11 项：
    S1  candidate 创建（基线与 baseSha）
    S2  重复提交同一队列项 → 不重复消费
    S3  PR 创建失败 → failed → 重试恢复为 candidate
    S4  PR 关闭但不合并 → closed（不是 published）
    S5  合并 → published（记录 mergeSha）
    S6  状态更新失败 → 文件不变、返回非 0
    S7  删除后重新添加相同内容 → 能再次处理
    S8  非法状态转换 → 拒绝
    S9  ledger 损坏 → 拒绝
    S10 main 更新使候选过期 → 判定 stale
    S11 已合并但部署失败 → published + deploy.failed 分开记录
    S12 同一份内容不能既 published 又 candidate
    S13 候选基线与当前 main 不一致时不允许沿用
全程本地，不联网、不调用真实 GitHub。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CS = os.path.join(ROOT, 'scripts', 'content_state.py')
PCQ = os.path.join(ROOT, 'scripts', 'process_content_queue.py')
TMP = tempfile.mkdtemp(prefix='b7c31_state_')
NOW = '2026-11-10T00:00:00Z'
BASE = 'a' * 40

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


def run(*args, cwd=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run([sys.executable] + list(args), cwd=cwd or ROOT, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', env=env)


def make_repo(tag):
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
    os.makedirs(os.path.join(dst, 'content', 'queue'), exist_ok=True)
    return dst


def item(pid, op='add', title=None, content=None):
    base = {
        'id': pid, 'op': op,
        'title': title or ('标题 ' + pid),
        'date': '2026-11-10',
        'tags': ['测试'],
        'excerpt': '摘要',
        'content': '# %s\n\n正文。\n' % pid,
    }
    if content is not None:
        base['content'] = content
    return base


def merge_back(repo, cand):
    """模拟候选 PR 已合并：把候选的权威源与产物写回仓库根。"""
    for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json',
                'feed.xml', 'content/ledger.json']:
        src = os.path.join(cand, rel.replace('/', os.sep))
        if os.path.isfile(src):
            dst = os.path.join(repo, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    cdir = os.path.join(cand, 'data', 'posts')
    rdir = os.path.join(repo, 'data', 'posts')
    if os.path.isdir(cdir):
        for name in os.listdir(cdir):
            if name.endswith('.md'):
                shutil.copy2(os.path.join(cdir, name), os.path.join(rdir, name))
        for name in os.listdir(rdir):
            if name.endswith('.md') and not os.path.isfile(os.path.join(cdir, name)):
                os.remove(os.path.join(rdir, name))


def ledger_of(repo):
    p = os.path.join(repo, 'content', 'ledger.json')
    return json.loads(read(p)) if os.path.isfile(p) else None


def cs(*args):
    return run(CS, *args)


# ---------------------------------------------------------------- 准备一个含候选的 ledger
repo = make_repo('main')
write(os.path.join(repo, 'content', 'queue', 'post-x.json'),
      json.dumps(item('post-x'), ensure_ascii=False, indent=2))
r = run(PCQ, '--root', repo, '--queue-dir', os.path.join(repo, 'content', 'queue'),
        '--work-dir', os.path.join(TMP, 'cand1'), '--now', NOW, '--base-sha', BASE,
        '--today', '2026-11-10')
check('S1 首次消费生成 candidate 记录', r.returncode == 0, (r.stderr or '').strip()[-60:])
led = ledger_of(repo)
entry = (led or {}).get('entries', [{}])[-1]
check('S1b 记录含 candidate 状态与 baseSha',
      entry.get('status') == 'candidate' and entry.get('baseSha') == BASE,
      (entry.get('status'), str(entry.get('baseSha'))[:8]))
ledger = os.path.join(repo, 'content', 'ledger.json')

# S2 重复消费
r = run(PCQ, '--root', repo, '--queue-dir', os.path.join(repo, 'content', 'queue'),
        '--work-dir', os.path.join(TMP, 'cand2'), '--now', NOW, '--base-sha', BASE)
check('S2 同一队列项重复提交 → 不重复消费',
      r.returncode == 0 and 'NO_CHANGES' in r.stdout and len(ledger_of(repo)['entries']) == 1,
      len(ledger_of(repo)['entries']))

# S3 失败 → 重试
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'failed')
check('S3 candidate → failed（PR/构建失败）', r.returncode == 0, (r.stderr or '').strip()[:50])
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'candidate')
check('S3b failed → candidate（重试恢复）', r.returncode == 0, (r.stderr or '').strip()[:50])

# S8 非法转换
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'pending')
check('S8 非法状态转换被拒绝（candidate → pending）',
      r.returncode != 0 and '不允许' in (r.stderr + r.stdout), (r.stderr or '').strip()[:40])

# S4 PR 关闭但不合并
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'closed')
st = json.loads(read(ledger))['entries'][-1]
check('S4 PR 关闭 → closed，且没有 merge/deploy 记录',
      r.returncode == 0 and st['status'] == 'closed'
      and not st.get('merge') and not st.get('deploy'), (st['status'], st.get('merge')))
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'candidate')
check('S4b closed → candidate（重新开候选）', r.returncode == 0)

# S5 合并
r = cs('--ledger', ledger, '--id', 'post-x', '--to', 'published', '--merge-sha', BASE[:12])
st = json.loads(read(ledger))['entries'][-1]
check('S5 合并 → published 且记录 mergeSha',
      r.returncode == 0 and st['status'] == 'published'
      and st['merge']['sha'] == BASE[:12], st.get('merge'))
check('S5b 合并本身不写 deploy（部署是另一件事）', not st.get('deploy'))

# S11 合并但部署失败
r = cs('--ledger', ledger, '--id', 'post-x', '--deploy', 'failed', '--deploy-run', '4242')
st = json.loads(read(ledger))['entries'][-1]
check('S11 合并后部署失败 → status 仍是 published，deploy=failed 单独记录',
      r.returncode == 0 and st['status'] == 'published'
      and st['deploy']['status'] == 'failed' and st['deploy']['runId'] == '4242',
      st.get('deploy'))
r = cs('--ledger', ledger, '--id', 'post-x', '--deploy', 'success', '--deploy-run', '4243')
st = json.loads(read(ledger))['entries'][-1]
check('S11b 部署成功后 deploy=success（可重试恢复）',
      r.returncode == 0 and st['deploy']['status'] == 'success')

# S12 同一份内容不能既 published 又 candidate
bad = json.loads(read(ledger))
clone = dict(bad['entries'][-1])
clone['status'] = 'candidate'
bad['entries'].append(clone)
write(os.path.join(TMP, 'bad-ledger.json'), json.dumps(bad, ensure_ascii=False, indent=2))
r = cs('--ledger', os.path.join(TMP, 'bad-ledger.json'), '--check')
check('S12 同一内容既 published 又 candidate → validate 拒绝',
      r.returncode != 0 and '既已发布' in (r.stderr + r.stdout), (r.stderr or '').strip()[:40])

# S9 ledger 损坏
write(os.path.join(TMP, 'broken.json'), '{oops')
r = cs('--ledger', os.path.join(TMP, 'broken.json'), '--check')
check('S9 ledger 不是合法 JSON → 拒绝', r.returncode != 0 and 'JSON' in (r.stderr + r.stdout))

# S6 状态更新失败（目标文件不可替换）
lockdir = os.path.join(TMP, 'readonly')
os.makedirs(lockdir, exist_ok=True)
target = os.path.join(lockdir, 'ledger.json')
shutil.copy2(ledger, target)
before = read(target)
ro = os.path.join(lockdir, 'ledger.json.tmp')
os.makedirs(ro, exist_ok=True)          # 让 os.replace 的目标 .tmp 变成目录 → 写入必失败
r = cs('--ledger', target, '--id', 'post-x', '--deploy', 'failed')
check('S6 状态写入失败 → 非 0 且原文件不变',
      r.returncode != 0 and read(target) == before, (r.stderr or '').strip()[:50])
shutil.rmtree(ro, ignore_errors=True)

# S10 候选过期（需要一条 candidate 记录；post-x 此时已 published）
led10 = json.loads(read(ledger))
cand = dict([e for e in led10['entries'] if e['id'] == 'post-x'][-1])
cand['status'] = 'candidate'
cand['baseSha'] = 'a' * 40
cand['itemSha'] = 'y' * 8   # 与已发布那条区分，否则会触发 S12 的"既发布又候选"校验
led10['entries'].append(cand)
p10 = os.path.join(TMP, 'ledger10.json')
write(p10, json.dumps(led10, ensure_ascii=False, indent=2))
r = cs('--ledger', p10, '--check-main', 'b' * 40)
check('S10 候选基于旧 main → 判定 STALE 并返回非 0',
      r.returncode != 0 and 'STALE' in (r.stderr + r.stdout), (r.stderr or '').strip()[:60])
r = cs('--ledger', p10, '--check-main', 'a' * 40)
check('S10b 基线一致时不报过期', r.returncode == 0, (r.stdout or '').strip()[:30])

# S7 删除后重新添加相同内容
repo7 = make_repo('readd')
q = os.path.join(repo7, 'content', 'queue')
write(os.path.join(q, 'post-y.json'), json.dumps(item('post-y'), ensure_ascii=False, indent=2))
run(PCQ, '--root', repo7, '--queue-dir', q, '--work-dir', os.path.join(TMP, 'c7a'),
    '--now', NOW, '--base-sha', BASE, '--today', '2026-11-10')
# 模拟合并 + 队列清理
led7 = os.path.join(repo7, 'content', 'ledger.json')
merge_back(repo7, os.path.join(TMP, 'c7a'))   # 模拟候选已合并，根目录才有 post-y
cs('--ledger', led7, '--id', 'post-y', '--to', 'published', '--merge-sha', BASE[:12])
os.remove(os.path.join(q, 'post-y.json'))
# 删除
write(os.path.join(q, 'del-y.json'), json.dumps({'id': 'post-y', 'op': 'delete'}))
r1 = run(PCQ, '--root', repo7, '--queue-dir', q, '--work-dir', os.path.join(TMP, 'c7b'),
         '--now', NOW, '--base-sha', BASE, '--today', '2026-11-10')
merge_back(repo7, os.path.join(TMP, 'c7b'))   # 删除候选已合并
cs('--ledger', led7, '--id', 'post-y', '--op', 'delete', '--to', 'published', '--merge-sha', BASE[:12])
os.remove(os.path.join(q, 'del-y.json'))
# 重新添加**完全相同**的内容
write(os.path.join(q, 'post-y2.json'), json.dumps(item('post-y'), ensure_ascii=False, indent=2))
r2 = run(PCQ, '--root', repo7, '--queue-dir', q, '--work-dir', os.path.join(TMP, 'c7c'),
         '--now', NOW, '--base-sha', BASE, '--today', '2026-11-11')
if r1.returncode != 0:
    print('   [S7 stderr] ' + (r1.stderr or '').strip()[:200])
check('S7 删除后重新添加相同内容 → 能再次生成候选（不被误判重复）',
      r1.returncode == 0 and r2.returncode == 0 and 'CANDIDATE_READY' in r2.stdout,
      (r1.returncode, r2.returncode))

# S13 多个候选同时存在且基线都过期 → 一次全部报出
stale_led = {'version': 1, 'entries': [], 'lastQueueSha': None}
for pid in ('post-m1', 'post-m2'):
    stale_led['entries'].append({
        'id': pid, 'op': 'add', 'itemSha': 'x' * 8, 'status': 'candidate',
        'queueSha': 'q' * 8, 'baseSha': 'c' * 40, 'at': '2026-11-10',
    })
write(os.path.join(TMP, 'stale.json'), json.dumps(stale_led, ensure_ascii=False, indent=2))
r = cs('--ledger', os.path.join(TMP, 'stale.json'), '--check-main', 'd' * 40)
check('S13 多个候选同时存在且基线过期 → 一次全部报出',
      r.returncode != 0 and (r.stderr or '').count('STALE') == 2,
      (r.stderr or '').count('STALE'))

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
