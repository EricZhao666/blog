# -*- coding: utf-8 -*-
"""Batch 7C-3A：发布候选闸门（隔离构建）测试。

被测对象：scripts/release_candidate.py
覆盖：
    R1 正常：隔离目录重建 → --check → split 校验 → 可重复 → 写标记 CANDIDATE_READY
    R2 源改了但派生没更新 → 判定"仓库产物过期"并失败（不写标记）
    R3 生成器失败（正文损坏）→ 失败（不写标记）
    R4 缺少 split_posts.py（结构校验不可用）→ 失败（不写标记）
    R5 --with-tests 但隔离目录没有 node_modules → BLOCKED（退出码 2）
    R6 隔离构建不写回源目录（前后哈希一致）
    R7 同一 SHA 两次构建产物一致（确定性）
全部使用临时目录，不联网、不提交、不推送。
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RC = os.path.join(ROOT, 'scripts', 'release_candidate.py')
TMP = tempfile.mkdtemp(prefix='b7c3a_rc_')

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def run(args, timeout=180):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run([sys.executable, RC] + args, cwd=ROOT, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', env=env,
                          timeout=timeout)


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def make_copy(tag):
    """复制一份精简仓库（够 build_content 用）。"""
    dst = os.path.join(TMP, tag)
    for rel in ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
                'data/posts/manifest.json', 'feed.xml',
                'scripts/build_content.py', 'scripts/split_posts.py', 'gen_feed.py']:
        target = os.path.join(dst, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), target)
    for name in os.listdir(os.path.join(ROOT, 'data', 'posts')):
        if name.endswith('.md'):
            shutil.copy2(os.path.join(ROOT, 'data', 'posts', name),
                         os.path.join(dst, 'data', 'posts', name))
    return dst


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


# ------------------------------------------------------------------ R1 正常路径
src = make_copy('good')
wd = os.path.join(TMP, 'wd1')
r = run(['--from-worktree', '--source-dir', src, '--work-dir', wd])
ok = r.returncode == 0 and 'CANDIDATE_READY' in r.stdout
marker = os.path.join(wd, '.release-candidate.json')
check('R1 隔离构建通过并输出 CANDIDATE_READY', ok, (r.stderr or '').strip()[-70:])
check('R1b 只在全部通过后才写可部署标记', ok and os.path.isfile(marker))
if os.path.isfile(marker):
    data = json.load(io.open(marker, encoding='utf-8'))
    check('R1c 标记记录了输入版本与产物哈希',
          data.get('status') == 'ready' and 'source' in data and len(data.get('artifacts', {})) == 4,
          list(data.get('artifacts', {}).keys()))

# ------------------------------------------------------------------ R6 不写回源
before = {rel: sha(os.path.join(src, rel.replace('/', os.sep)))
          for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml']}
r = run(['--from-worktree', '--source-dir', src, '--work-dir', os.path.join(TMP, 'wd2')])
after = {rel: sha(os.path.join(src, rel.replace('/', os.sep))) for rel in before}
check('R6 隔离构建不写回源目录', before == after)

# ------------------------------------------------------------------ R7 确定性
wd3, wd4 = os.path.join(TMP, 'wd3'), os.path.join(TMP, 'wd4')
run(['--from-worktree', '--source-dir', src, '--work-dir', wd3])
run(['--from-worktree', '--source-dir', src, '--work-dir', wd4])
def snaps(wd):
    return {rel: sha(os.path.join(wd, rel.replace('/', os.sep)))
            for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json']}
check('R7 同一输入两次构建产物一致（确定性）', snaps(wd3) == snaps(wd4))

# ------------------------------------------------------------------ R2 源变了、派生没更新
src2 = make_copy('stale')
p = os.path.join(src2, 'js', 'data.js')
text = io.open(p, encoding='utf-8').read().replace("title: '具身智能", "title: '改过标题：具身智能", 1)
write(p, text)
wd5 = os.path.join(TMP, 'wd5')
r = run(['--from-worktree', '--source-dir', src2, '--work-dir', wd5])
check('R2 源与派生不一致 → 判定失败', r.returncode != 0 and '不一致' in (r.stderr + r.stdout),
      (r.stderr or '').strip()[-60:])
check('R2b 失败时不写可部署标记', not os.path.isfile(os.path.join(wd5, '.release-candidate.json')))

# ------------------------------------------------------------------ R3 生成器失败（正文损坏）
src3 = make_copy('broken')
with open(os.path.join(src3, 'data', 'posts', 'embodied-ai-notes.md'), 'wb') as f:
    f.write(b'# \xff\xfe bad\n')
wd6 = os.path.join(TMP, 'wd6')
r = run(['--from-worktree', '--source-dir', src3, '--work-dir', wd6])
check('R3 正文非法 UTF-8 → 构建失败', r.returncode != 0, (r.stderr or r.stdout).strip()[-60:])
check('R3b 失败时无标记', not os.path.isfile(os.path.join(wd6, '.release-candidate.json')))

# ------------------------------------------------------------------ R4 结构校验不可用
src4 = make_copy('nosplit')
os.remove(os.path.join(src4, 'scripts', 'split_posts.py'))
wd7 = os.path.join(TMP, 'wd7')
r = run(['--from-worktree', '--source-dir', src4, '--work-dir', wd7])
check('R4 缺少 split_posts.py → 闸门失败（不允许跳过结构校验）',
      r.returncode != 0, (r.stderr or r.stdout).strip()[-60:])
check('R4b 失败时无标记', not os.path.isfile(os.path.join(wd7, '.release-candidate.json')))

# ------------------------------------------------------------------ R5 --with-tests 无依赖
wd8 = os.path.join(TMP, 'wd8')
r = run(['--from-worktree', '--source-dir', src, '--work-dir', wd8, '--with-tests'])
check('R5 隔离目录缺 node_modules → BLOCKED（退出码 2）', r.returncode == 2,
      'rc=%d %s' % (r.returncode, (r.stderr or '').strip()[-40:]))
check('R5b BLOCKED 时不写标记', not os.path.isfile(os.path.join(wd8, '.release-candidate.json')))

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
