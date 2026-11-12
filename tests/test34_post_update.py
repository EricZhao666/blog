# -*- coding: utf-8 -*-
"""Batch 8B-1：本地导入器的「更新已有文章」模式契约测试。

全部在临时副本上跑：不修改真实仓库、不联网。

覆盖（对应任务书第 6 节）：
    U1  正常修改正文（dry-run 不写盘；apply 后正文更新、位置不变）
    U2  正常修改标题（id 与 URL 不变）
    U3  修改标签与摘要（TAG_ORDER 追加新标签）
    U4  中文 / 特殊字符 / Markdown 代码块逐字保留
    U5  原 ID 不变（文件名不变 → 深链 /#/post/<id> 不变）
    U6  日期默认保持不变；显式修改才变
    U7  同一更新稿重复导入 → 第二次被拒绝（版本已过期）
    U8  原版本已变化（有人在导入前改了正文/标题）→ 拒绝且零写入
    U9  缺少原版本信息 → 拒绝
    U10 文章不存在 → 拒绝（不会被当成新增）
    U11 JSON 非法 → 拒绝
    U12 路径逃逸 / 保留文件名 → 拒绝
    U13 写入过程中断 → 回滚，仓库逐字节一致（含正文）
    U14 搜索索引 / Manifest / RSS 同步更新
    U15 其他文章完全不变
    U16 新增模式（Batch 8A）无回归
    U17 不存在任何网络写入（静态检查 import）
    U18 --mode add / --mode update 与实际稿件类型不符 → 拒绝
    U19 兼容期文章（js/user-posts.js）→ 明确拒绝，且该文件不被修改
    U20 非规范 js/data.js → 拒绝（不静默重排）
    U21 更新前后文章 id 集合完全一致
    U22 构建锁被占用 → 退出码 3，零写入
    U23 dry-run 不产生任何字节变化
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
IMPORTER = os.path.join(ROOT, 'scripts', 'import_post.py')
SCRIPT_DIR = os.path.join(ROOT, 'scripts')

sys.path.insert(0, ROOT)
sys.path.insert(0, SCRIPT_DIR)

import split_posts as sp  # noqa: E402

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra)[:90] + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra)[:90] + ')' if extra is not None else ''))


ENV = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')

REPO_FILES = ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
              'data/posts/manifest.json', 'feed.xml', 'gen_feed.py',
              'scripts/build_content.py', 'scripts/split_posts.py', 'scripts/import_post.py']

TARGET = 'embodied-ai-notes'      # 真实批次里存在的内置文章（副本上操作，不动真实仓库）


def make_repo():
    root = os.path.join(tempfile.mkdtemp(prefix='b8b1_'), 'repo')
    for rel in REPO_FILES:
        dst = os.path.join(root, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), dst)
    shutil.copytree(os.path.join(ROOT, 'data', 'posts'), os.path.join(root, 'data', 'posts'),
                    dirs_exist_ok=True)
    return root


def snapshot(root):
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            with open(full, 'rb') as f:
                out[rel] = hashlib.sha256(f.read()).hexdigest()
    return out


def read_post(root, pid):
    p = sp.paths(root)
    metas, bodies, tag_order, _src, _orph, _legacy = sp.collect(p, 'check')
    meta = next(m for m in metas if m['id'] == pid)
    return meta, bodies[pid], tag_order


def data_js_state(root):
    _text, posts, tags = sp.parse_js_file(os.path.join(root, 'js', 'data.js'))
    return [p['id'] for p in posts], tags


def make_update(root, pid, **changes):
    """按仓库当前内容生成一份合法的更新稿（original 快照 = 现在的样子）。"""
    meta, body, _tags = read_post(root, pid)
    post = {
        'id': pid,
        'title': meta['title'],
        'date': meta['date'],
        'tags': list(meta['tags']),
        'excerpt': meta['excerpt'],
        'content': body,
    }
    post.update(changes)
    return {
        'op': 'update',
        'id': pid,
        'original': {
            'title': meta['title'],
            'date': meta['date'],
            'tags': list(meta['tags']),
            'excerpt': meta['excerpt'],
            'content': body,
        },
        'post': post,
    }


def write_json(dirpath, name, payload):
    path = os.path.join(dirpath, name)
    with open(path, 'wb') as f:
        f.write(json.dumps(payload, ensure_ascii=False, indent=2).encode('utf-8') + b'\n')
    return path


def run_cli(args):
    r = subprocess.run([sys.executable, IMPORTER] + args, cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


tmpdir = tempfile.mkdtemp(prefix='b8b1_json_')
try:
    # ================================================================ U1 正文更新
    root = make_repo()
    before = snapshot(root)
    ids_before, tags_before = data_js_state(root)
    meta_before, body_before, _ = read_post(root, TARGET)
    metas_orig = {m['id']: m for m in sp.collect(sp.paths(root), 'check')[0]}

    new_body = ('# 具身智能（已更新）\n\n'
                '这是一段全新的正文，含中文标点：。、《》——"引号"（括号）。\n\n'
                '```python\n'
                'def hello(name):\n'
                '    # 注释里也有中文\n'
                '    print("你好, " + name)\n'
                '```\n\n'
                '特殊字符：<>&"\'` \\ 与 emoji 🚀。\n')
    ups = make_update(root, TARGET, content=new_body)
    f_update = write_json(tmpdir, 'u1.json', ups)

    rc, out = run_cli(['--file', f_update, '--mode', 'update', '--dry-run', '--root', root])
    check('U1 更新稿 dry-run 退出码 0', rc == 0, out.strip()[-80:])
    check('U1 dry-run 打印"更新（update）"', '更新（update）' in out)
    check('U1 dry-run 说明 id 不变 / URL 不变', '不变，URL 不变' in out)
    check('U23 dry-run 不写任何文件', snapshot(root) == before)

    rc, out = run_cli(['--file', f_update, '--mode', 'update', '--apply', '--root', root])
    check('U1 apply 退出码 0', rc == 0, out.strip()[-100:])
    _meta_after, body_after, _ = read_post(root, TARGET)
    check('U1 正文已更新', body_after == new_body, body_after[:40])
    with io.open(os.path.join(root, 'data', 'posts', TARGET + '.md'), encoding='utf-8') as f:
        check('U4 正文里中文/代码块/特殊字符逐字一致', f.read() == new_body)
    ids_after, _tags = data_js_state(root)
    check('U21 文章 id 集合与顺序完全不变', ids_after == ids_before, len(ids_after))
    check('U5 正文文件名未变（深链 /#/post/<id> 不变）',
          os.path.isfile(os.path.join(root, 'data', 'posts', TARGET + '.md')))
    check('U2 id 未变', _meta_after['id'] == TARGET)

    # ================================================================ U14 派生数据
    with io.open(os.path.join(root, 'data', 'search-index.json'), encoding='utf-8') as f:
        search = json.load(f)
    check('U14 搜索索引中的正文已更新', search[TARGET] == new_body)
    with io.open(os.path.join(root, 'feed.xml'), encoding='utf-8') as f:
        feed = f.read()
    check('U14 RSS 仍包含这篇文章', '/#/post/%s' % TARGET in feed)
    with io.open(os.path.join(root, 'data', 'posts', 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    rec = next(x for x in manifest['posts'] if x['id'] == TARGET)
    check('U14 manifest 的 contentSha256 与正文一致',
          rec['contentSha256'] == hashlib.sha256(new_body.encode('utf-8')).hexdigest())
    check('U14 manifest 文章数不变', len(manifest['posts']) == len(ids_before), len(manifest['posts']))

    # ================================================================ U15 其他文章不变
    after = snapshot(root)
    changed_md = [rel for rel in before
                  if rel.startswith('data/posts/') and rel.endswith('.md') and before[rel] != after.get(rel)]
    check('U15 只有目标正文被改（其它 md 一个字节都没动）',
          changed_md == ['data/posts/%s.md' % TARGET], changed_md)
    metas_after = sp.collect(sp.paths(root), 'check')[0]
    diff = [m['id'] for m in metas_after
            if m['id'] != TARGET and m != metas_orig.get(m['id'])]
    check('U15 其它文章的元数据完全不变', diff == [], diff)

    # ================================================================ U7 重复导入
    mid = snapshot(root)
    rc, out = run_cli(['--file', f_update, '--mode', 'update', '--apply', '--root', root])
    check('U7 同一更新稿第二次导入被拒绝（退出码 2）', rc == 2, out.strip()[-80:])
    check('U7 拒绝原因写明原版本校验失败', '原版本校验失败' in out, out.strip()[-80:])
    check('U7 第二次导入零写入', snapshot(root) == mid)
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U2/U3/U6 元数据更新
    root = make_repo()
    ids_before, tags_before = data_js_state(root)
    meta_before, body_before, _ = read_post(root, TARGET)

    rc, out = run_cli(['--file', write_json(tmpdir, 'title.json',
                                            make_update(root, TARGET, title='全新的标题（改过）')),
                       '--mode', 'update', '--apply', '--root', root])
    meta_after, body_after, _ = read_post(root, TARGET)
    check('U2 修改标题成功', rc == 0, out.strip()[-60:])
    check('U2 data.js 里的标题已更新', meta_after['title'] == '全新的标题（改过）')
    check('U2 id 未变', meta_after['id'] == TARGET)
    check('U2 正文未变', body_after == body_before)
    check('U6 日期默认保持不变', meta_after['date'] == meta_before['date'])
    ids_now, tags_now = data_js_state(root)
    check('U21 修改标题后 id 集合与顺序仍不变', ids_now == ids_before)
    check('U2 标题改动没有插入新文章', len(ids_now) == len(ids_before))

    rc, out = run_cli(['--file', write_json(tmpdir, 'meta.json',
                                            make_update(root, TARGET,
                                                        tags=['测试标签', '技术笔记'],
                                                        excerpt='改写后的摘要：含 <>& 与中文。')),
                       '--mode', 'update', '--apply', '--root', root])
    meta_after2, _body2, _ = read_post(root, TARGET)
    check('U3 修改标签与摘要成功', rc == 0, out.strip()[-60:])
    check('U3 标签已更新', meta_after2['tags'] == ['测试标签', '技术笔记'], meta_after2['tags'])
    check('U3 摘要已更新', meta_after2['excerpt'] == '改写后的摘要：含 <>& 与中文。')
    _ids3, tags3 = data_js_state(root)
    check('U3 TAG_ORDER 追加了新标签', '测试标签' in tags3 and '技术笔记' in tags3)
    check('U3 原有标签顺序未被改动',
          [t for t in tags3 if t in tags_before] == list(tags_before))

    rc, out = run_cli(['--file', write_json(tmpdir, 'date.json',
                                            make_update(root, TARGET, date='2025-01-02')),
                       '--mode', 'update', '--apply', '--root', root])
    meta_after3, _b3, _ = read_post(root, TARGET)
    check('U6 显式改日期才会变', rc == 0 and meta_after3['date'] == '2025-01-02', meta_after3['date'])
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U8 原版本变化
    # U8a：别人正常更新过（仓库是一致的）→ 版本校验必须拦住过期稿件
    root = make_repo()
    f_stale = write_json(tmpdir, 'stale.json', make_update(root, TARGET, content='# 基于旧版本的修改\n'))
    rc, _out = run_cli(['--file', write_json(tmpdir, 'other.json',
                                             make_update(root, TARGET, content='# 别人先改的正文\n')),
                        '--mode', 'update', '--apply', '--root', root])
    check('U8 前置：别人先更新成功（仓库保持一致）', rc == 0, rc)
    stale_before = snapshot(root)
    rc, out = run_cli(['--file', f_stale, '--mode', 'update', '--apply', '--root', root])
    check('U8a 原正文已变化 → 拒绝（退出码 2）', rc == 2, out.strip()[-80:])
    check('U8a 提示正文已变化', '正文已变化' in out, out.strip()[-80:])
    check('U8a 拒绝时零写入', snapshot(root) == stale_before)

    # U8b：有人手改了正文但没重建 → 更早的一道闸（仓库不一致）先拦住
    root_hand = make_repo()
    f_hand = write_json(tmpdir, 'hand.json', make_update(root_hand, TARGET, content='# 基于旧版本\n'))
    with io.open(os.path.join(root_hand, 'data', 'posts', TARGET + '.md'), 'a', encoding='utf-8') as f:
        f.write('\n后来又有人手改了这句。\n')
    hand_before = snapshot(root_hand)
    rc, out = run_cli(['--file', f_hand, '--mode', 'update', '--apply', '--root', root_hand])
    check('U8b 仓库不一致 → 拒绝并提示先 --sync', rc == 1 and 'build_content.py' in out, out.strip()[-70:])
    check('U8b 拒绝时零写入', snapshot(root_hand) == hand_before)
    shutil.rmtree(root_hand, ignore_errors=True)

    # 元数据变化同样要拦
    root2 = make_repo()
    ups = make_update(root2, TARGET, content='# 基于旧元数据的修改\n')
    f_stale2 = write_json(tmpdir, 'stale2.json', ups)
    data_js_path = os.path.join(root2, 'js', 'data.js')
    with io.open(data_js_path, encoding='utf-8') as f:
        text = f.read()
    meta_before2, _b, _ = read_post(root2, TARGET)
    text2 = text.replace("title: '%s'" % meta_before2['title'], "title: '被人改过的标题'", 1)
    with io.open(data_js_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text2)
    # data.js 被手改 → 先要求 --sync（这是更早的一道闸）
    rc, out = run_cli(['--file', f_stale2, '--mode', 'update', '--apply', '--root', root2])
    check('U20 手改过的 data.js → 拒绝并提示先 --sync',
          rc == 1 and 'build_content.py --sync' in out, out.strip()[-80:])
    shutil.rmtree(root2, ignore_errors=True)
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U9/U10/U11/U12 输入非法
    root = make_repo()
    base = snapshot(root)
    meta, body, _ = read_post(root, TARGET)

    ups = make_update(root, TARGET, content='# x\n')
    del ups['original']
    rc, out = run_cli(['--file', write_json(tmpdir, 'no-original.json', ups),
                       '--mode', 'update', '--dry-run', '--root', root])
    check('U9 缺少 original 字段 → 拒绝', rc == 1 and 'original' in out, out.strip()[-70:])

    ups = make_update(root, TARGET, content='# x\n')
    del ups['original']['content']
    rc, out = run_cli(['--file', write_json(tmpdir, 'no-original-content.json', ups),
                       '--mode', 'update', '--dry-run', '--root', root])
    check('U9 original 缺少正文快照 → 拒绝', rc == 1, out.strip()[-70:])

    f_missing = write_json(tmpdir, 'missing.json',
                           {'op': 'update', 'id': 'no-such-post',
                            'original': {'title': 't', 'date': '2026-01-01', 'tags': ['a'],
                                         'excerpt': '', 'content': 'x'},
                            'post': {'id': 'no-such-post', 'title': 't', 'date': '2026-01-01',
                                     'tags': ['a'], 'excerpt': '', 'content': 'x'}})
    rc, out = run_cli(['--file', f_missing, '--mode', 'update', '--dry-run', '--root', root])
    check('U10 文章不存在 → 拒绝（退出码 2）', rc == 2, out.strip()[-70:])
    check('U10 明确提示不会被当成新增', '新增文章请去掉' in out, out.strip()[-70:])

    bad = os.path.join(tmpdir, 'bad.json')
    with io.open(bad, 'w', encoding='utf-8') as f:
        f.write("const post = {op: 'update'};")
    rc, out = run_cli(['--file', bad, '--mode', 'update', '--dry-run', '--root', root])
    check('U11 非法 JSON（JS 对象字面量）→ 拒绝', rc == 1 and '合法 JSON' in out, out.strip()[-60:])

    ups = make_update(root, TARGET, content='# x\n')
    ups['id'] = '../../../etc/passwd'
    ups['post']['id'] = ups['id']
    rc, out = run_cli(['--file', write_json(tmpdir, 'escape.json', ups),
                       '--mode', 'update', '--dry-run', '--root', root])
    check('U12 路径逃逸 id → 拒绝', rc == 1 and 'id 非法' in out, out.strip()[-60:])

    ups = make_update(root, TARGET, content='# x\n')
    ups['post']['id'] = 'someone-else'
    rc, out = run_cli(['--file', write_json(tmpdir, 'id-mismatch.json', ups),
                       '--mode', 'update', '--dry-run', '--root', root])
    check('U12 顶层 id 与 post.id 不一致 → 拒绝', rc == 1 and 'id 不一致' in out, out.strip()[-60:])

    check('U9–U12 全程零写入', snapshot(root) == base)

    # ================================================================ U18 模式错配
    add_payload = {'id': 'batch8b1-add', 'title': '新增冒烟', 'date': '2026-11-12',
                   'tags': ['测试'], 'excerpt': '摘要', 'content': '# 新增\n\n正文。\n'}
    f_add = write_json(tmpdir, 'add.json', add_payload)
    rc, out = run_cli(['--file', f_add, '--mode', 'update', '--dry-run', '--root', root])
    check('U18 新增稿用 --mode update → 拒绝', rc == 1 and '要求的是 update 稿' in out, out.strip()[-70:])

    f_upd = write_json(tmpdir, 'u-mode.json', make_update(root, TARGET, content='# y\n'))
    rc, out = run_cli(['--file', f_upd, '--mode', 'add', '--dry-run', '--root', root])
    check('U18 更新稿用 --mode add → 拒绝', rc == 1 and '要求的是 add 稿' in out, out.strip()[-70:])

    # ================================================================ U16 新增模式回归
    rc, out = run_cli(['--file', f_add, '--dry-run', '--root', root])
    check('U16 新增稿不带 --mode 仍可用（8A 兼容）', rc == 0 and '新增（add）' in out, out.strip()[-60:])
    count_before = len(data_js_state(root)[0])
    rc, out = run_cli(['--file', f_add, '--apply', '--root', root])
    check('U16 新增 apply 成功', rc == 0, out.strip()[-60:])
    check('U16 新增后文章数 +1', len(data_js_state(root)[0]) == count_before + 1,
          len(data_js_state(root)[0]))

    # 更新稿不带 --mode 也能被 auto 识别
    root3 = make_repo()
    rc, out = run_cli(['--file', write_json(tmpdir, 'auto.json',
                                            make_update(root3, TARGET, content='# auto\n\n正文。\n')),
                       '--dry-run', '--root', root3])
    check('U16 --mode 默认 auto 可识别更新稿', rc == 0 and '更新（update）' in out, out.strip()[-60:])
    shutil.rmtree(root3, ignore_errors=True)
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U19 兼容期文章
    root = make_repo()
    legacy_body = '# 旧编辑器文章\n\n正文。\n'
    with io.open(os.path.join(root, 'js', 'user-posts.js'), 'w', encoding='utf-8') as f:
        f.write('const USER_POSTS = ' + json.dumps([{
            'id': 'legacy-post', 'title': '旧文章', 'date': '2026-10-01',
            'tags': ['测试'], 'excerpt': '摘要', 'content': legacy_body,
        }], ensure_ascii=False) + ';\n')
    subprocess.run([sys.executable, os.path.join(root, 'scripts', 'build_content.py'),
                    '--sync', '--root', root], cwd=root, capture_output=True, env=ENV)
    legacy_before = snapshot(root)
    ups = {'op': 'update', 'id': 'legacy-post',
           'original': {'title': '旧文章', 'date': '2026-10-01', 'tags': ['测试'],
                        'excerpt': '摘要', 'content': legacy_body},
           'post': {'id': 'legacy-post', 'title': '旧文章（改）', 'date': '2026-10-01',
                    'tags': ['测试'], 'excerpt': '摘要', 'content': '# 改\n\n正文。\n'}}
    rc, out = run_cli(['--file', write_json(tmpdir, 'legacy.json', ups),
                       '--mode', 'update', '--apply', '--root', root])
    check('U19 兼容期文章拒绝更新（退出码 2）', rc == 2, out.strip()[-80:])
    check('U19 提示是只读来源 / 需先迁移', '不支持在线更新' in out and 'user-posts.js' in out, out.strip()[-80:])
    check('U19 拒绝时零写入', snapshot(root) == legacy_before)
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U13 中断回滚
    import contextlib
    import import_post as ip

    root = make_repo()
    before = snapshot(root)
    f_crash = write_json(tmpdir, 'crash.json', make_update(root, TARGET, content='# 会中断的更新\n'))
    original = ip.write_data_js

    def boom(*a, **k):
        raise OSError('simulated disk full')

    buf_out, buf_err = io.StringIO(), io.StringIO()
    ip.write_data_js = boom
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            rc = ip.main(['--file', f_crash, '--mode', 'update', '--apply', '--root', root])
    finally:
        ip.write_data_js = original

    merged = buf_out.getvalue() + buf_err.getvalue()
    check('U13 中断后返回 1', rc == 1, rc)
    check('U13 中断后提示已回滚', '已回滚' in merged, merged.strip()[-60:])
    check('U13 中断后仓库逐字节复原（正文也还原）', snapshot(root) == before)
    check('U13 中断后没有残留临时文件',
          not [n for n in os.listdir(os.path.join(root, 'data', 'posts')) if n.startswith('.tmp')])
    with io.open(os.path.join(root, 'data', 'posts', TARGET + '.md'), encoding='utf-8') as f:
        check('U13 中断后正文仍是原内容', '会中断的更新' not in f.read())

    rc, out = run_cli(['--file', f_crash, '--mode', 'update', '--apply', '--root', root])
    check('U13 回滚后可以重新更新成功', rc == 0, out.strip()[-70:])
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U22 锁被占用
    root = make_repo()
    lock = os.path.join(root, '.content-build.lock')
    with open(lock, 'w') as f:
        f.write('12345\n')
    before = snapshot(root)          # 连同锁文件一起做基线：不允许出现任何新写入
    rc, out = run_cli(['--file', write_json(tmpdir, 'locked.json',
                                            make_update(root, TARGET, content='# lock\n')),
                       '--mode', 'update', '--apply', '--root', root])
    lock_touched = os.path.exists(lock)
    check('U22 构建锁被占用 → 退出码 3', rc == 3, (rc, out.strip()[-60:]))
    check('U22 锁被占用时零写入', snapshot(root) == before)
    check('U22 没有删掉别人的锁文件', lock_touched)
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ U17 无网络写入
    with io.open(IMPORTER, encoding='utf-8') as f:
        src = f.read()
    import_lines = [l.strip() for l in src.splitlines()
                    if l.strip().startswith('import ') or l.strip().startswith('from ')]
    net = [l for l in import_lines
           if re.search(r'\b(urllib|http|socket|requests|ftplib|smtplib|telnetlib)\b', l)]
    check('U17 导入器不 import 任何网络库', net == [], net)
    check('U17 导入器没有 git push / curl 之类的调用',
          not re.search(r'git\s+push|curl\s|Invoke-WebRequest', src))
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
