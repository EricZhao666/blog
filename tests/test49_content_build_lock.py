# -*- coding: utf-8 -*-
"""Batch 8E-3B-R：内容构建器锁生命周期与异常清理专项测试。

全部使用临时合成 fixture，不触碰真实仓库、不联网。

覆盖：
    L1  持锁时 --sync 在读取权威源/比较产物前退出 3
    L2  write_artifacts 的 os.replace 失败时清理全部 staged 临时文件
    L3  输入非法时构建锁被释放
    L4  不同 root 的并发构建互不阻塞
    L5  --check / --dry-run 保持只读，不创建构建锁
    L6  --lock-timeout 的有限等待与立即失败契约
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, 'scripts')
BUILD = os.path.join(SCRIPTS, 'build_content.py')
TMP = tempfile.mkdtemp(prefix='b8e3br_lock_')
FIXED_NOW = '2026-11-09T00:00:00Z'

passed = [0]
failed = [0]

sys.path.insert(0, SCRIPTS)
import build_content as bc  # noqa: E402


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def run(root, *args, timeout=25):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    cmd = [sys.executable, BUILD, '--root', root] + list(args)
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env, timeout=timeout)


def make_fixture(tag, missing_body=False):
    root = os.path.join(TMP, tag)
    write(os.path.join(root, 'js', 'data.js'), DATA_HEAD)
    if not missing_body:
        write(os.path.join(root, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词。\n')
    write(os.path.join(root, 'data', 'posts', 'post-b.md'), '# 乙\n\n正文乙：贝塔词。\n')
    write(os.path.join(root, 'js', 'user-posts.js'), 'const USER_POSTS = [];\n')
    return root


def write(path, text, mode='w'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if mode == 'wb':
        with open(path, 'wb') as f:
            f.write(text)
    else:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


def lock_path(root):
    return os.path.join(root, '.content-build.lock')


def parts(root):
    found = []
    for base, _dirs, names in os.walk(root):
        for name in names:
            if name.startswith('.tmp-build-') and name.endswith('.part'):
                found.append(os.path.join(base, name))
    return found


def full_output(r):
    return ((r.stdout or '') + (r.stderr or '')).strip()


DATA_HEAD = """/**
 * Fixture 元数据（测试用）
 */

const POSTS = [
  {
    id: 'post-a',
    title: '第一篇文章',
    date: '2026-01-02',
    tags: ['测试', '甲'],
    excerpt: '甲的摘要'
  },
  {
    id: 'post-b',
    title: '第二篇文章',
    date: '2026-02-03',
    tags: ['测试'],
    excerpt: '乙的摘要'
  }
];

const TAG_ORDER = ['测试', '甲'];
"""


def test_lock_scope():
    """锁定状态下的 sync 必须在读取/比较产物之前退出 3。

    用非空目录替换 search-index.json 作为“锁外 diff 必然出错”的探针：
    旧实现会在锁外 diff 时抛出 IsADirectoryError；新实现先看锁，直接 BUSY。
    """
    root = make_fixture('scope')
    r = run(root, '--sync', '--now', FIXED_NOW)
    check('L1 初始化 fixture 成功', r.returncode == 0, full_output(r)[-80:])

    idx = os.path.join(root, 'data', 'search-index.json')
    os.remove(idx)
    os.makedirs(os.path.join(idx, 'keep'), exist_ok=True)
    write(lock_path(root), '12345\n')

    r = run(root, '--sync', '--now', FIXED_NOW, '--lock-timeout', '0')
    out = full_output(r)
    check('L1a 持锁时 --sync 退出 3', r.returncode == 3, r.returncode)
    check('L1b 持锁时先返回 BUSY，而不是锁外读取产物', '[BUSY]' in out and '检索' not in out, out[-140:])
    check('L1c 不删除其他进程的锁文件', os.path.exists(lock_path(root)))
    check('L1d 锁外竞争期间没有 staged 临时文件', parts(root) == [], parts(root))
    check('L1e 探针目录未被构建器改写', os.path.isdir(idx))


def test_replace_cleanup():
    """os.replace 中途失败时，所有尚未替换的 staged .part 必须清理。"""
    root = make_fixture('replace')
    idx = os.path.join(root, 'data', 'search-index.json')
    os.makedirs(os.path.join(idx, 'keep'), exist_ok=True)
    try:
        bc.write_artifacts(root, {
            'data/search-index.json': b'{"bad": true}\n',
            'js/data.js': b'const X = 1;\n',
        })
        raised = False
    except OSError:
        raised = True
    check('L2a 替换目录目标时抛出 OSError', raised)
    remaining = parts(root)
    check('L2b 替换失败后无残留 .tmp-build-*.part', remaining == [], remaining)


def test_invalid_input_releases_lock():
    root = make_fixture('invalid', missing_body=True)
    r = run(root, '--sync', '--now', FIXED_NOW)
    check('L3a 缺少正文时返回非 0', r.returncode != 0, r.returncode)
    check('L3b 异常退出后构建锁被释放', not os.path.exists(lock_path(root)))
    check('L3c 异常退出后无 staged 临时文件', parts(root) == [], parts(root))


def test_different_roots_concurrent():
    roots = [make_fixture('root-a'), make_fixture('root-b')]
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    procs = [subprocess.Popen([sys.executable, BUILD, '--root', root, '--sync', '--now', FIXED_NOW],
                              cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding='utf-8', errors='replace', env=env)
             for root in roots]
    results = []
    for proc in procs:
        try:
            out, err = proc.communicate(timeout=25)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            results.append((None, out, err))
        else:
            results.append((proc.returncode, out, err))
    check('L4a 两个不同 root 的并发 sync 都成功', [r[0] for r in results] == [0, 0],
          [r[0] for r in results])
    checks = [run(root, '--check', '--now', FIXED_NOW).returncode for root in roots]
    check('L4b 两个 root 构建后 --check 都通过', checks == [0, 0], checks)


def test_read_only_modes():
    root = make_fixture('readonly')
    r = run(root, '--sync', '--now', FIXED_NOW)
    check('L5a 初始化 sync 成功', r.returncode == 0, full_output(r)[-80:])
    before = {}
    for rel in ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml']:
        path = os.path.join(root, rel.replace('/', os.sep))
        before[rel] = open(path, 'rb').read()
    for mode in ('--check', '--dry-run'):
        r = run(root, mode, '--now', FIXED_NOW)
        check('L5b %s 返回 0' % mode, r.returncode == 0, full_output(r)[-100:])
        check('L5c %s 不创建构建锁' % mode, not os.path.exists(lock_path(root)))
        after = {}
        for rel in before:
            path = os.path.join(root, rel.replace('/', os.sep))
            after[rel] = open(path, 'rb').read()
        check('L5d %s 不改写任何产物' % mode, before == after)


def test_lock_timeout():
    root = make_fixture('timeout')
    r = run(root, '--sync', '--now', FIXED_NOW)
    check('L6a 初始化 sync 成功', r.returncode == 0, full_output(r)[-80:])
    code = (
        "import sys,time\n"
        "sys.path.insert(0, %r)\n"
        "import build_content as bc\n"
        "p=bc.paths(%r)\n"
        "l=bc.BuildLock(p['lock'])\n"
        "l.__enter__()\n"
        "print('LOCKED', flush=True)\n"
        "time.sleep(0.8)\n"
        "l.__exit__()\n"
    ) % (SCRIPTS, root)
    holder = subprocess.Popen([sys.executable, '-c', code], cwd=ROOT,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding='utf-8', errors='replace')
    try:
        deadline = time.time() + 5
        while time.time() < deadline and not os.path.exists(lock_path(root)):
            time.sleep(0.05)
        check('L6b 辅助进程成功持有构建锁', os.path.exists(lock_path(root)))
        r0 = run(root, '--sync', '--now', FIXED_NOW, '--lock-timeout', '0')
        check('L6c timeout=0 时立即返回 3', r0.returncode == 3, full_output(r0)[-100:])
        r1 = run(root, '--sync', '--now', FIXED_NOW, '--lock-timeout', '1.5')
        check('L6d 有限等待后获得锁并成功', r1.returncode == 0, full_output(r1)[-100:])
    finally:
        try:
            holder.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.communicate()
    check('L6e 等待结束后锁文件被释放', not os.path.exists(lock_path(root)))


def main():
    try:
        test_lock_scope()
        test_replace_cleanup()
        test_invalid_input_releases_lock()
        test_different_roots_concurrent()
        test_read_only_modes()
        test_lock_timeout()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
    return 1 if failed[0] else 0


if __name__ == '__main__':
    sys.exit(main())
