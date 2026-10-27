#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 6C：文章数据生命周期验证（在临时副本上跑，不碰仓库真实产物）

覆盖：
  1) 修改一篇正文            → --sync 后搜索语料/校验清单更新，元数据不被改写
  2) 修改标题/标签/日期       → --sync 后以手改为准，清单元数据哈希更新
  3) 新增一篇                → 数量 +1，正文/语料/清单同步
  4) 删除一篇                → 有孤儿正文时拒绝；--prune 后清理
  5) 修改文章 id             → 元数据与正文一起改名后仍一致
  6) 损坏 / 中途失败          → 非 0 退出，且**不覆盖**已有有效产物
  7) 可重复执行              → 连续两次 --sync，第二次 0 变更

用法：python tests/test19_data_lifecycle.py
退出码：0 全通过；1 有失败。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import split_posts as sp  # 复用解析/渲染，构造"作者手改后的元数据"

GENERATOR = os.path.join(ROOT, 'scripts', 'split_posts.py')
# Windows 控制台默认 GBK：统一成 UTF-8 并容错，避免中文/替换字符导致测试自身崩溃
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
SUBPROCESS_ENV = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
FIXTURE_ID = 'embodied-ai-notes'

passed = 0
failed = []


def check(name, cond, extra=None):
    global passed
    ok = bool(cond)
    if ok:
        passed += 1
    else:
        failed.append(name)
    print(('PASS ' if ok else 'FAIL ') + name + ('' if extra is None else '  (' + str(extra) + ')'))


def make_workspace():
    tmp = tempfile.mkdtemp(prefix='blog-lifecycle-')
    os.makedirs(os.path.join(tmp, 'js'))
    os.makedirs(os.path.join(tmp, 'data', 'posts'))
    shutil.copy2(os.path.join(ROOT, 'js', 'data.js'), os.path.join(tmp, 'js', 'data.js'))
    shutil.copy2(os.path.join(ROOT, 'data', 'search-index.json'), os.path.join(tmp, 'data', 'search-index.json'))
    src = os.path.join(ROOT, 'data', 'posts')
    for name in os.listdir(src):
        if name.endswith('.md') or name == 'manifest.json':
            shutil.copy2(os.path.join(src, name), os.path.join(tmp, 'data', 'posts', name))
    return tmp


def run(tmp, *args):
    p = subprocess.run([sys.executable, GENERATOR, '--root', tmp] + list(args),
                       capture_output=True, text=True, encoding='utf-8', errors='replace',
                       env=SUBPROCESS_ENV)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def artifact_path(tmp, rel):
    return os.path.join(tmp, rel.replace('/', os.sep))


def derived_digest(tmp):
    """只覆盖"派生数据 + 正文"：失败场景里 js/data.js 本身就是被改坏的输入，不参与比较。"""
    h = hashlib.sha256()
    for rel in ['data/search-index.json', 'data/posts/manifest.json']:
        with open(artifact_path(tmp, rel), 'rb') as f:
            h.update(f.read())
    posts_dir = os.path.join(tmp, 'data', 'posts')
    for name in sorted(os.listdir(posts_dir)):
        if name.endswith('.md'):
            h.update(name.encode('utf-8'))
            with open(os.path.join(posts_dir, name), 'rb') as f:
                h.update(f.read())
    return h.hexdigest()


def read(tmp, rel):
    with open(artifact_path(tmp, rel), encoding='utf-8') as f:
        return f.read()


def write(tmp, rel, text):
    path = artifact_path(tmp, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def load_meta(tmp):
    _, posts, tags = sp.parse_js_file(artifact_path(tmp, 'js/data.js'))
    return posts, tags


def save_meta(tmp, posts, tags):
    write(tmp, 'js/data.js', sp.render_data_js(posts, tags))


def search_index(tmp):
    return json.loads(read(tmp, 'data/search-index.json'))


def manifest(tmp):
    return json.loads(read(tmp, 'data/posts/manifest.json'))


def main():
    tmp = make_workspace()
    try:
        check('初始状态 --check 通过', run(tmp, '--check')[0] == 0)
        posts, tags = load_meta(tmp)
        base_posts = len(posts)
        base_data = read(tmp, 'js/data.js')
        base_meta_sha = next(x for x in manifest(tmp)['posts'] if x['id'] == FIXTURE_ID)['metaSha256']

        # ---------------- 1) 修改正文
        body_rel = 'data/posts/%s.md' % FIXTURE_ID
        body = read(tmp, body_rel)
        marker = '\n\n## 生命周期测试标记\n\n这段文字只应出现在正文与搜索语料里。\n'
        write(tmp, body_rel, body + marker)
        rc, out = run(tmp, '--sync')
        check('修改正文后 --sync 成功', rc == 0, out.strip().splitlines()[-1] if out.strip() else '')
        check('修改正文后搜索语料包含新内容', '生命周期测试标记' in search_index(tmp)[FIXTURE_ID])
        check('修改正文后元数据不被改写', read(tmp, 'js/data.js') == base_data)
        check('修改正文后 --check 通过', run(tmp, '--check')[0] == 0)
        rec = next(x for x in manifest(tmp)['posts'] if x['id'] == FIXTURE_ID)
        check('修改正文后内容哈希已更新',
              rec['contentSha256'] == hashlib.sha256((body + marker).encode('utf-8')).hexdigest())

        # ---------------- 7) 可重复执行
        rc, out = run(tmp, '--sync')
        check('连续两次 --sync 第二次 0 变更', rc == 0 and '待更新 0 个文件' in out)

        # ---------------- 2) 修改标题 / 标签 / 日期
        data2 = read(tmp, 'js/data.js')
        data2 = data2.replace("title: '具身智能", "title: '【改名】具身智能", 1)
        data2 = data2.replace("tags: ['具身智能', 'AI', '机器人']", "tags: ['具身智能', 'AI', '机器人', '测试标签']", 1)
        data2 = data2.replace("date: '2026-08-09'", "date: '2026-08-10'", 1)
        write(tmp, 'js/data.js', data2)
        rc, _ = run(tmp, '--sync')
        data3 = read(tmp, 'js/data.js')
        check('修改标题/标签/日期后 --sync 成功', rc == 0)
        check('修改标题被保留', '【改名】具身智能' in data3)
        check('修改标签被保留', "'测试标签'" in data3)
        check('修改日期被保留', "date: '2026-08-10'" in data3)
        check('修改元数据后 --check 通过', run(tmp, '--check')[0] == 0)
        rec = next(x for x in manifest(tmp)['posts'] if x['id'] == FIXTURE_ID)
        check('修改元数据后元数据哈希已更新', rec['metaSha256'] != base_meta_sha)
        check('修改元数据不影响搜索语料', search_index(tmp)[FIXTURE_ID] == body + marker)

        # ---------------- 3) 新增一篇
        new_id = 'lifecycle-test-post'
        new_body = '# 新增测试文章\n\n这是一篇用于验证生成流程的文章。\n'
        write(tmp, 'data/posts/%s.md' % new_id, new_body)
        posts, tags = load_meta(tmp)
        posts.append({
            'id': new_id,
            'title': '新增测试文章',
            'date': '2026-10-27',
            'tags': ['测试'],
            'excerpt': '用于验证新增流程的摘要。',
        })
        save_meta(tmp, posts, tags)          # 手写的元数据里没有 readingMinutes，--sync 会补
        rc, out = run(tmp, '--sync')
        check('新增文章后 --sync 成功', rc == 0, out.strip().splitlines()[-1] if out.strip() else '')
        posts_after, _ = load_meta(tmp)
        check('新增后文章数为 %d' % (base_posts + 1), len(posts_after) == base_posts + 1, len(posts_after))
        check('新增文章进入搜索语料', search_index(tmp).get(new_id) == new_body)
        check('新增文章进入完整性清单', any(x['id'] == new_id for x in manifest(tmp)['posts']))
        check('新增后 readingMinutes 已补齐',
              next(x for x in posts_after if x['id'] == new_id).get('readingMinutes') == sp.reading_minutes(new_body))
        check('新增后 --check 通过', run(tmp, '--check')[0] == 0)

        # ---------------- 4) 删除一篇（先造孤儿正文）
        posts, tags = load_meta(tmp)
        save_meta(tmp, [p for p in posts if p['id'] != new_id], tags)
        before = derived_digest(tmp)
        rc, out = run(tmp, '--sync')
        check('删除文章但正文仍在时拒绝执行', rc != 0 and '没有元数据引用' in out, out.strip().splitlines()[0] if out.strip() else '')
        check('拒绝执行时不改动任何产物', derived_digest(tmp) == before)
        rc, out = run(tmp, '--sync', '--prune')
        check('--prune 后删除成功', rc == 0 and not os.path.exists(artifact_path(tmp, 'data/posts/%s.md' % new_id)))
        posts_after, _ = load_meta(tmp)
        check('删除后文章数回到 %d' % base_posts, len(posts_after) == base_posts, len(posts_after))
        check('删除后搜索语料不再包含该文', new_id not in search_index(tmp))
        check('删除后 --check 通过', run(tmp, '--check')[0] == 0)

        # ---------------- 5) 修改 id
        old_id, new_ident = 'shenzhen-weekend', 'shenzhen-weekend-renamed'
        posts, tags = load_meta(tmp)
        for p in posts:
            if p['id'] == old_id:
                p['id'] = new_ident
        save_meta(tmp, posts, tags)
        os.rename(artifact_path(tmp, 'data/posts/%s.md' % old_id),
                  artifact_path(tmp, 'data/posts/%s.md' % new_ident))
        rc, out = run(tmp, '--sync')
        idx = search_index(tmp)
        check('修改 id 后 --sync 成功', rc == 0, out.strip().splitlines()[-1] if out.strip() else '')
        check('修改 id 后搜索语料用新 id 且正文不变', new_ident in idx and old_id not in idx)
        check('修改 id 后 --check 通过', run(tmp, '--check')[0] == 0)

        # ---------------- 6) 损坏 / 中途失败
        before = derived_digest(tmp)
        broken = read(tmp, 'js/data.js')
        write(tmp, 'js/data.js', broken[:len(broken) // 2])   # 截断：POSTS 数组不完整
        rc, out = run(tmp, '--sync')
        check('元数据语法损坏（截断）时失败', rc != 0, out.strip().splitlines()[0] if out.strip() else '')
        check('语法损坏时不覆盖产物', derived_digest(tmp) == before)

        write(tmp, 'js/data.js', broken)
        target = 'data/posts/%s.md' % FIXTURE_ID
        good_body = read(tmp, target)
        with open(artifact_path(tmp, target), 'wb') as f:
            f.write(b'\xff\xfe\x00bad')
        before = derived_digest(tmp)
        rc, out = run(tmp, '--sync')
        check('正文非 UTF-8 时失败且提示清楚', rc != 0 and 'UTF-8' in out, out.strip().splitlines()[0] if out.strip() else '')
        check('正文损坏时不覆盖产物', derived_digest(tmp) == before)

        os.unlink(artifact_path(tmp, target))
        before = derived_digest(tmp)
        rc, out = run(tmp, '--sync')
        check('正文文件缺失时失败', rc != 0 and '缺少正文文件' in out, out.strip().splitlines()[0] if out.strip() else '')
        check('正文缺失时不覆盖产物', derived_digest(tmp) == before)

        write(tmp, target, good_body)
        check('恢复后 --check 重新通过', run(tmp, '--check')[0] == 0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n共 %d 项，PASS %d，FAIL %d' % (passed + len(failed), passed, len(failed)))
    if failed:
        print('失败项：\n  - ' + '\n  - '.join(failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
