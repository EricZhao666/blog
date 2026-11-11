#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布候选构建闸门（Batch 7C-3A，第三阶段：隔离构建）。

在**隔离目录**里用**同一个源码版本**重建全部派生数据，然后再校验一遍：

    1. git archive <sha> → 解包到临时目录（固定输入版本，绝不就地改工作区）
    2. python scripts/build_content.py --sync   （在隔离目录里生成）
    3. python scripts/build_content.py --check  （生成后必须自洽）
    4. python scripts/split_posts.py  --check   （Batch 6 的结构/哈希/正文校验仍然生效）
    5. 比较"生成前后"的产物哈希：只要 --sync 改动了任何一个文件，
       就说明**仓库里的派生数据与源不一致** → 判定失败（不是"修好"而是"数据过期"）
    6. 可选 --with-tests：在隔离目录里跑完整回归（需要该目录有 node_modules）
    7. 全部通过才写 .release-candidate.json（"可部署标记"），并打印 CANDIDATE_READY

边界（必须明确）：
  * 多文件写入成功 ≠ Git 提交成功。本脚本只证明"这棵树自洽"，不提交、不推送；
  * 隔离目录里的写入不会回写工作区；失败一律不留标记；
  * 同一输入 + 同一 --now → 逐字节相同（--check 会验证）。

用法：
    python scripts/release_candidate.py --sha HEAD
    python scripts/release_candidate.py --sha HEAD --with-tests
    python scripts/release_candidate.py --from-worktree --work-dir D:/tmp/rc   # 本地验证未提交改动
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

import build_content as bc   # noqa: E402

MARKER = '.release-candidate.json'
ARTIFACTS = ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml']


STAMP_RE = __import__('re').compile(r'<lastBuildDate>[^<]*</lastBuildDate>')


def sha256_file(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def digest(path, rel):
    """feed 的 lastBuildDate 由 --now 决定，不算"内容变化"，比较时归一化掉。"""
    if not os.path.isfile(path):
        return None
    if rel == 'feed.xml':
        with open(path, encoding='utf-8', errors='replace') as f:
            body = STAMP_RE.sub('<lastBuildDate/>', f.read())
        return hashlib.sha256(body.encode('utf-8')).hexdigest()
    return sha256_file(path)


def run(cmd, cwd, env=None):
    e = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    if env:
        e.update(env)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=e)


def git(args, cwd):
    return run(['git'] + args, cwd)


def export_tree(sha, dest):
    """git archive --format=zip <sha> → dest（不触碰工作区）。"""
    zp = dest + '.zip'
    r = git(['archive', '--format=zip', '-o', zp, sha], REPO_DIR)
    if r.returncode != 0:
        raise RuntimeError('git archive 失败：%s' % (r.stderr.strip() or r.stdout.strip()))
    with zipfile.ZipFile(zp) as z:
        z.extractall(dest)
    os.remove(zp)


def copy_worktree(dest, source_dir=None):
    """--from-worktree：把当前工作区（除 .git/node_modules）复制一份，用于验证未提交改动。"""
    skip = {'.git', 'node_modules', '.papers-id', 'tests/reports', 'tests/browser/artifacts'}
    for name in os.listdir(source_dir or REPO_DIR):
        if name in skip:
            continue
        src = os.path.join(source_dir or REPO_DIR, name)
        dst = os.path.join(dest, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(*skip))
        else:
            shutil.copy2(src, dst)


def snapshot(root):
    out = {}
    for rel in ARTIFACTS:
        out[rel] = digest(os.path.join(root, rel.replace('/', os.sep)), rel)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='发布候选：隔离目录重建 + 全量校验')
    ap.add_argument('--sha', default='HEAD', help='固定输入提交（默认 HEAD）')
    ap.add_argument('--from-worktree', action='store_true', help='用当前工作区（含未提交改动）作输入')
    ap.add_argument('--source-dir', help='配合 --from-worktree：从这个目录复制（默认仓库根，测试用）')
    ap.add_argument('--work-dir', help='隔离目录（默认临时目录）')
    ap.add_argument('--now', default='2026-11-10T00:00:00Z', help='固定 feed 时间戳，保证可重复')
    ap.add_argument('--with-tests', action='store_true', help='在隔离目录里再跑完整回归')
    ap.add_argument('--keep', action='store_true', help='保留隔离目录（默认成功后也保留，失败必保留）')
    args = ap.parse_args(argv)

    tmp = args.work_dir or tempfile.mkdtemp(prefix='b7c3a_rc_')
    os.makedirs(tmp, exist_ok=True)
    print('隔离目录: ' + tmp)

    try:
        if args.from_worktree:
            copy_worktree(tmp, os.path.abspath(args.source_dir) if args.source_dir else None)
            head = git(['rev-parse', 'HEAD'], REPO_DIR).stdout.strip()
            source = {'mode': 'worktree', 'baseSha': head}
        else:
            export_tree(args.sha, tmp)
            head = git(['rev-parse', args.sha], REPO_DIR).stdout.strip()
            source = {'mode': 'git-archive', 'sha': head}
    except Exception as e:
        print('[FAIL] 导出源码失败：%s' % e, file=sys.stderr)
        return 1
    print('输入版本: ' + json.dumps(source, ensure_ascii=False))

    build = os.path.join(tmp, 'scripts', 'build_content.py')
    if not os.path.isfile(build):
        print('[FAIL] 隔离目录里没有 scripts/build_content.py', file=sys.stderr)
        return 1

    # 先记下"仓库自带"的产物哈希，用来判断它们是新是旧
    before = snapshot(tmp)

    r = run([sys.executable, build, '--root', tmp, '--sync', '--now', args.now], tmp)
    print('--sync  rc=%d' % r.returncode)
    if r.stdout.strip():
        print('   ' + r.stdout.strip().replace('\n', '\n   '))
    if r.returncode != 0:
        print('[FAIL] 隔离构建失败：' + (r.stderr.strip() or r.stdout.strip()), file=sys.stderr)
        return 1

    r = run([sys.executable, build, '--root', tmp, '--check', '--now', args.now], tmp)
    print('--check rc=%d' % r.returncode)
    if r.returncode != 0:
        print('[FAIL] 生成后自检失败：' + (r.stdout.strip() or r.stderr.strip()), file=sys.stderr)
        return 1

    split = os.path.join(tmp, 'scripts', 'split_posts.py')
    r = run([sys.executable, split, '--check', '--root', tmp], tmp)
    print('split_posts --check rc=%d' % r.returncode)
    if r.returncode != 0:
        print('[FAIL] split_posts 校验失败：' + (r.stdout.strip() or r.stderr.strip()), file=sys.stderr)
        return 1

    after = snapshot(tmp)
    drift = [k for k in ARTIFACTS if before.get(k) != after.get(k)]
    if drift:
        print('[FAIL] 仓库里的派生数据与源码不一致（--sync 改动了）：' + '、'.join(drift), file=sys.stderr)
        print('        这表示提交里带的是过期产物；请在本地跑 --sync 后与源一起提交。', file=sys.stderr)
        return 1

    # 可重复性：同一输入再建一次，产物哈希必须完全一致
    again = snapshot(tmp)
    r = run([sys.executable, build, '--root', tmp, '--sync', '--now', args.now], tmp)
    if r.returncode != 0 or snapshot(tmp) != again:
        print('[FAIL] 同一输入重复构建得到不同输出（不确定）', file=sys.stderr)
        return 1
    print('可重复性: OK（两次构建产物逐字节相同）')

    if args.with_tests:
        runner = os.path.join(tmp, 'scripts', 'run_tests.py')
        if not os.path.isdir(os.path.join(tmp, 'node_modules')):
            print('[BLOCKED] --with-tests 需要隔离目录里的 node_modules（先在隔离目录 npm ci）',
                  file=sys.stderr)
            return 2
        r = run([sys.executable, runner], tmp)
        print('run_tests rc=%d' % r.returncode)
        tail = (r.stdout or '').strip().splitlines()[-3:]
        for line in tail:
            print('   ' + line)
        if r.returncode != 0:
            print('[FAIL] 完整回归未通过', file=sys.stderr)
            return 1

    marker = os.path.join(tmp, MARKER)
    with open(marker, 'w', encoding='utf-8') as f:
        json.dump({
            'status': 'ready',
            'source': source,
            'now': args.now,
            'artifacts': after,
            'note': '隔离目录自洽 ≠ 已提交；本标记只表示这棵树可以进入提交/PR 环节',
        }, f, ensure_ascii=False, indent=2, sort_keys=True)
    print('标记: ' + marker)
    print('CANDIDATE_READY')
    if not args.keep and not args.work_dir:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
