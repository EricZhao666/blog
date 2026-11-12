# -*- coding: utf-8 -*-
"""Batch 8A：本地文章导入器（scripts/import_post.py）契约测试。

全部在临时副本上跑，不修改真实仓库、不联网。

覆盖（对应任务书第五节 + 第八节）：
    I1  正常导入：正文落盘 + 元数据插入 + 派生数据重建 + --check 通过
    I2  中文标题 / 代码块 / 特殊字符：正文逐字一致，搜索索引与 RSS 同步更新
    I3  空正文 / 空标题：拒绝，仓库一个字节都不变
    I4  重复 id：拒绝（退出码 2），历史正文不被覆盖
    I5  重复导入：第二次拒绝，且仍然没有覆盖
    I6  文件名/路径异常：文件不存在、指向目录、空文件、非 UTF-8、超大文件
    I7  非法 JSON / JS 对象字面量 / 重复键 / NaN：拒绝，不执行任何 JavaScript
    I8  恶意路径 id（../、绝对路径、保留设备名）：拒绝且不产生文件
    I9  导入中断（写 data.js 失败）：自动回滚，仓库与导入前逐字节一致
    I10 正文与元数据一致性：manifest 哈希/字节/字符数与磁盘一致
    I11 导入器不覆盖其他文章：其余 18 篇的元数据与正文完全不变
    I12 未知字段 / 非规范 data.js：拒绝并给出可操作提示
    I13 USER_POSTS 兼容：同 id 冲突，且 js/user-posts.js 不被修改
    I14 --dry-run 不写盘；--apply 与 --dry-run 互斥
    I15 导入后 build_content --check / split_posts --check / gen_feed --check 全部通过
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
IMPORTER = os.path.join(ROOT, 'scripts', 'import_post.py')
SCRIPT_DIR = os.path.join(ROOT, 'scripts')

sys.path.insert(0, ROOT)
sys.path.insert(0, SCRIPT_DIR)

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


# ---------------------------------------------------------------- 临时仓库
REPO_FILES = ['js/data.js', 'js/user-posts.js', 'data/search-index.json',
              'data/posts/manifest.json', 'feed.xml', 'gen_feed.py',
              'scripts/build_content.py', 'scripts/split_posts.py', 'scripts/import_post.py']


def make_repo():
    root = os.path.join(tempfile.mkdtemp(prefix='b8a_import_'), 'repo')
    for rel in REPO_FILES:
        dst = os.path.join(root, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace('/', os.sep)), dst)
    shutil.copytree(os.path.join(ROOT, 'data', 'posts'), os.path.join(root, 'data', 'posts'),
                    dirs_exist_ok=True)
    return root


def snapshot(root):
    """root 下所有文件的 {rel: sha256}，用于证明"没有半成品"。"""
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            with open(full, 'rb') as f:
                out[rel] = hashlib.sha256(f.read()).hexdigest()
    return out


def write_json(dirpath, name, payload, encoding='utf-8'):
    path = os.path.join(dirpath, name)
    with open(path, 'wb') as f:
        f.write(json.dumps(payload, ensure_ascii=False, indent=2).encode(encoding) + b'\n')
    return path


def run_cli(args):
    r = subprocess.run([sys.executable, IMPORTER] + args, cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


ARTICLE = {
    'id': 'batch8a-import-ok',
    'title': '中文标题：导入器契约验证',
    'date': '2026-11-12',
    'tags': ['测试', '技术笔记'],
    'excerpt': '摘要含 <>& 与 "引号"',
    'content': ('# 中文标题\n\n'
                '正文含特殊字符 <>&"\'` 与 emoji 🚀。\n\n'
                '```python\n'
                'def hello(name):\n'
                '    # 中文注释\n'
                '    print("你好, " + name)\n'
                '```\n\n'
                '最后一段。\n'),
}

tmpdir = tempfile.mkdtemp(prefix='b8a_json_')
try:
    # ================================================================ I1 正常导入
    root = make_repo()
    before = snapshot(root)
    f1 = write_json(tmpdir, 'batch8a-import-ok.json', ARTICLE)

    rc, out = run_cli(['--file', f1, '--dry-run', '--root', root])
    check('I14 --dry-run 退出码 0', rc == 0, out.strip()[-60:])
    check('I14 --dry-run 不写任何文件', snapshot(root) == before)
    check('I14 --dry-run 说明未来会更新 4 个派生文件', '待更新 4 个' in out, out.strip()[-80:])

    rc, out = run_cli(['--file', f1, '--apply', '--root', root])
    check('I1 --apply 退出码 0', rc == 0, out.strip()[-120:])
    body_path = os.path.join(root, 'data', 'posts', ARTICLE['id'] + '.md')
    check('I1 正文写入 data/posts/<id>.md', os.path.isfile(body_path))
    if os.path.isfile(body_path):
        with io.open(body_path, encoding='utf-8') as f:
            check('I2 正文逐字一致（中文/代码块/特殊字符）', f.read() == ARTICLE['content'])

    with io.open(os.path.join(root, 'js', 'data.js'), encoding='utf-8') as f:
        data_js = f.read()
    check('I1 元数据写入 js/data.js', "id: '%s'" % ARTICLE['id'] in data_js)
    check('I1 新文章插在 POSTS 首位', data_js.index("id: '%s'" % ARTICLE['id']) < data_js.index("id: 'embodied-ai-notes'"))
    check('I1 生成器注释头保留', data_js.startswith('/**\n * Blog Posts Data（元数据）'))
    check('I2 TAG_ORDER 追加了新标签', "'测试'" in data_js.split('TAG_ORDER = [')[1])

    with io.open(os.path.join(root, 'data', 'search-index.json'), encoding='utf-8') as f:
        search = json.load(f)
    check('I2 搜索索引包含新文章且正文一致', search.get(ARTICLE['id']) == ARTICLE['content'])

    with io.open(os.path.join(root, 'feed.xml'), encoding='utf-8') as f:
        feed = f.read()
    check('I2 RSS 包含新文章标题', ARTICLE['title'] in feed)
    check('I2 RSS 包含新文章链接', '/#/post/%s' % ARTICLE['id'] in feed)

    with io.open(os.path.join(root, 'data', 'posts', 'manifest.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    rec = next((x for x in manifest['posts'] if x['id'] == ARTICLE['id']), None)
    check('I10 manifest 记录新文章', rec is not None)
    if rec:
        raw = ARTICLE['content'].encode('utf-8')
        check('I10 contentSha256 与正文一致', rec['contentSha256'] == hashlib.sha256(raw).hexdigest())
        check('I10 contentBytes 与正文一致', rec['contentBytes'] == len(raw))
        check('I10 contentChars 与正文一致', rec['contentChars'] == len(ARTICLE['content']))
        check('I10 file 指向新正文', rec['file'] == 'data/posts/%s.md' % ARTICLE['id'])
    check('I10 manifest 文章数 +1', len(manifest['posts']) == 19, len(manifest['posts']))

    # I11 其余文章完全不变
    import split_posts as sp
    p = sp.paths(root)
    metas_after, _bodies, _tag_order, _src, _orph, _legacy = sp.collect(p, 'check')
    _orig_text, orig_posts, _orig_tags = sp.parse_js_file(os.path.join(ROOT, 'js', 'data.js'))
    after_by_id = {m['id']: m for m in metas_after}
    changed = []
    for post in orig_posts:
        before_meta = {k: v for k, v in post.items()}
        after = dict(after_by_id.get(post['id'], {}))
        before_meta.pop('readingMinutes', None)
        after.pop('readingMinutes', None)
        if before_meta != after:
            changed.append(post['id'])
    check('I11 原有 18 篇元数据完全不变', changed == [], changed)
    md_changed = [n for n in os.listdir(os.path.join(ROOT, 'data', 'posts'))
                  if n.endswith('.md') and snapshot(root).get('data/posts/' + n) != before.get('data/posts/' + n)]
    check('I11 原有正文文件一个都没变', md_changed == [], md_changed)

    # I15 三个官方校验全部通过
    for name, script, extra in [('build_content', 'scripts/build_content.py', ['--check']),
                                ('split_posts', 'scripts/split_posts.py', ['--check']),
                                ('gen_feed', 'gen_feed.py', ['--check'])]:
        r = subprocess.run([sys.executable, os.path.join(root, script.replace('/', os.sep))] + extra,
                           cwd=root, capture_output=True, text=True, encoding='utf-8',
                           errors='replace', env=ENV)
        check('I15 %s --check 通过' % name, r.returncode == 0,
              (r.stdout or r.stderr or '').strip()[-80:])

    # ================================================================ I5 重复导入
    mid = snapshot(root)
    rc, out = run_cli(['--file', f1, '--apply', '--root', root])
    check('I5 第二次导入退出码 2（冲突）', rc == 2, out.strip()[-80:])
    check('I5 提示不会覆盖历史正文', '不会覆盖历史正文' in out, out.strip()[-80:])
    check('I5 重复导入后仓库零变化', snapshot(root) == mid)

    # ================================================================ I4 同 id / 不同正文
    clash = dict(ARTICLE, content='# 覆盖尝试\n\n这段内容不应写进仓库。\n')
    f_clash = write_json(tmpdir, 'clash.json', clash)
    rc, _out = run_cli(['--file', f_clash, '--apply', '--root', root])
    with io.open(body_path, encoding='utf-8') as f:
        still = f.read()
    check('I4 同 id 不同正文被拒绝', rc == 2 and still == ARTICLE['content'])
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ I3 空正文/空标题
    root = make_repo()
    before = snapshot(root)
    for name, payload, expect in [
        ('no-content', dict(ARTICLE, id='empty-body', content='   \n\t'), '正文不能为空'),
        ('no-title', dict(ARTICLE, id='empty-title', title='   '), '标题不能为空'),
    ]:
        path = write_json(tmpdir, name + '.json', payload)
        rc, out = run_cli(['--file', path, '--apply', '--root', root])
        check('I3 %s 被拒绝' % name, rc == 1 and expect in out, out.strip()[-60:])
    check('I3 空字段不会留下任何文件', snapshot(root) == before)

    # ================================================================ I8 恶意 id
    for bad_id in ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'a/b', 'manifest', 'aux', 'CON']:
        path = write_json(tmpdir, 'bad-id.json', dict(ARTICLE, id=bad_id))
        rc, out = run_cli(['--file', path, '--apply', '--root', root])
        check('I8 拒绝危险 id %r' % bad_id, rc == 1 and ('id' in out), out.strip()[-50:])
    check('I8 恶意 id 没有写出任何文件', snapshot(root) == before)
    check('I8 没有在仓库外产生文件', not os.path.exists(os.path.join(os.path.dirname(root), 'etc')))

    # ================================================================ I6 文件异常
    rc, out = run_cli(['--file', os.path.join(tmpdir, 'not-exists.json'), '--dry-run', '--root', root])
    check('I6 文件不存在 → 退出码 1', rc == 1 and '找不到导入文件' in out, out.strip()[-50:])

    rc, out = run_cli(['--file', tmpdir, '--dry-run', '--root', root])
    check('I6 指向目录 → 明确拒绝', rc == 1 and '目录' in out, out.strip()[-50:])

    empty_path = os.path.join(tmpdir, 'empty.json')
    open(empty_path, 'wb').close()
    rc, out = run_cli(['--file', empty_path, '--dry-run', '--root', root])
    check('I6 空文件 → 明确拒绝', rc == 1 and '为空' in out, out.strip()[-50:])

    utf16_path = os.path.join(tmpdir, 'utf16.json')
    with open(utf16_path, 'wb') as f:
        f.write(json.dumps(ARTICLE, ensure_ascii=False).encode('utf-16'))
    rc, out = run_cli(['--file', utf16_path, '--dry-run', '--root', root])
    check('I6 UTF-16 文件 → 提示用 UTF-8 导出', rc == 1 and 'UTF-16' in out, out.strip()[-60:])

    gbk_path = os.path.join(tmpdir, 'gbk.json')
    gbk_payload = dict(ARTICLE, id='gbk-encoded', title='GBK 编码的中文标题', content='# GBK\n\n正文。\n')
    with open(gbk_path, 'wb') as f:
        f.write(json.dumps(gbk_payload, ensure_ascii=False).encode('gbk'))
    rc, out = run_cli(['--file', gbk_path, '--dry-run', '--root', root])
    check('I6 非 UTF-8 文件 → 明确拒绝', rc == 1 and 'UTF-8' in out, out.strip()[-60:])

    # 阈值跟随模块常量：Batch 8B-1 把上限从 1 MiB 提到 4 MiB（更新稿要内联原正文快照），
    # 断言本身不变 —— 超限文件必须被拒绝，只是夹具按新上限来构造。
    import import_post as _ip
    big_path = os.path.join(tmpdir, 'big.json')
    with open(big_path, 'wb') as f:
        f.write(b'{"id":"big","pad":"' + b'a' * (_ip.MAX_FILE_BYTES + 10) + b'"}')
    rc, out = run_cli(['--file', big_path, '--dry-run', '--root', root])
    check('I6 超大文件 → 拒绝（防止误喂大文件）', rc == 1 and '过大' in out, out.strip()[-50:])

    # 合法但名字奇怪（无扩展名）仍应被接受：内容才是权威
    odd_path = os.path.join(tmpdir, 'article-no-ext')
    with io.open(odd_path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(dict(ARTICLE, id='odd-name-ok'), ensure_ascii=False))
    rc, out = run_cli(['--file', odd_path, '--dry-run', '--root', root])
    check('I6 文件名异常但内容是合法 JSON → 允许（以内容为准）', rc == 0, out.strip()[-60:])

    # ================================================================ I7 非法 JSON
    cases = [
        ('not-json', 'this is not json'),
        ('js-object', "const post = {id: 'x', title: 'y'};"),
        ('single-quote', "{'id': 'x', 'title': 'y'}"),
        ('dup-key', '{"id":"a","id":"b"}'),
        ('nan', '{"id":"nan-test","title":"t","date":"2026-01-01","tags":["a"],"excerpt":"","content":"x","seriesOrder":NaN}'),
        ('truncated', '{"id":"a","title":'),
    ]
    for name, raw in cases:
        path = os.path.join(tmpdir, name + '.json')
        with io.open(path, 'w', encoding='utf-8') as f:
            f.write(raw)
        rc, out = run_cli(['--file', path, '--dry-run', '--root', root])
        check('I7 非法输入 %s 被拒绝（不执行 JS）' % name, rc == 1, out.strip()[-50:])
    check('I7 非法输入没有产生任何文件', snapshot(root) == before)

    # ================================================================ I12 未知字段/非规范 data.js
    unknown = dict(ARTICLE, id='unknown-field', evil='<script>alert(1)</script>')
    path = write_json(tmpdir, 'unknown.json', unknown)
    rc, out = run_cli(['--file', path, '--apply', '--root', root])
    check('I12 未知字段被拒绝', rc == 1 and '不支持的字段' in out, out.strip()[-60:])

    broken = make_repo()
    with io.open(os.path.join(broken, 'js', 'data.js'), 'a', encoding='utf-8') as f:
        f.write('\n// 手改注释：让文件不再是生成器输出\n')
    path = write_json(tmpdir, 'canonical.json', dict(ARTICLE, id='needs-sync'))
    rc, out = run_cli(['--file', path, '--apply', '--root', broken])
    check('I12 非规范 data.js → 要求先 --sync', rc == 1 and 'build_content.py --sync' in out, out.strip()[-80:])
    with io.open(os.path.join(broken, 'js', 'data.js'), encoding='utf-8') as f:
        check('I12 非规范 data.js 未被改写', '// 手改注释' in f.read())
    shutil.rmtree(broken, ignore_errors=True)

    # ================================================================ I13 USER_POSTS 兼容
    legacy_root = make_repo()
    legacy_body = '# 旧编辑器文章\n\n正文。\n'
    with io.open(os.path.join(legacy_root, 'js', 'user-posts.js'), 'w', encoding='utf-8') as f:
        f.write("const USER_POSTS = " + json.dumps([{
            'id': 'legacy-post', 'title': '旧文章', 'date': '2026-10-01',
            'tags': ['测试'], 'excerpt': '摘要', 'content': legacy_body,
        }], ensure_ascii=False) + ';\n')
    legacy_before = snapshot(legacy_root)
    path = write_json(tmpdir, 'legacy-clash.json', dict(ARTICLE, id='legacy-post'))
    rc, out = run_cli(['--file', path, '--apply', '--root', legacy_root])
    check('I13 与 USER_POSTS 同 id → 冲突', rc == 2 and 'js/user-posts.js' in out, out.strip()[-80:])

    path = write_json(tmpdir, 'legacy-ok.json', dict(ARTICLE, id='after-legacy'))
    rc, out = run_cli(['--file', path, '--apply', '--root', legacy_root])
    check('I13 USER_POSTS 存在时仍可新增内置文章', rc == 0, out.strip()[-80:])
    check('I13 js/user-posts.js 完全没被修改',
          snapshot(legacy_root).get('js/user-posts.js') == legacy_before.get('js/user-posts.js'))
    with io.open(os.path.join(legacy_root, 'data', 'posts', 'manifest.json'), encoding='utf-8') as f:
        m2 = json.load(f)
    check('I13 manifest 同时记录内置与兼容期文章', len(m2['posts']) == 20, len(m2['posts']))
    shutil.rmtree(legacy_root, ignore_errors=True)

    # ================================================================ I9 导入中断 → 回滚
    import contextlib
    import import_post as ip

    root = make_repo()
    before = snapshot(root)
    path = write_json(tmpdir, 'interrupt.json', dict(ARTICLE, id='interrupted-write'))
    buf_out, buf_err = io.StringIO(), io.StringIO()
    original = ip.write_data_js

    def boom(*a, **k):
        raise OSError('simulated disk full')

    ip.write_data_js = boom
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            rc = ip.main(['--file', path, '--apply', '--root', root])
    finally:
        ip.write_data_js = original

    check('I9 中断后返回非零', rc == 1, rc)
    check('I9 中断后提示已回滚', '已回滚' in (buf_err.getvalue() + buf_out.getvalue()),
          (buf_err.getvalue() or buf_out.getvalue()).strip()[-60:])
    check('I9 中断后仓库逐字节复原（无半成品）', snapshot(root) == before)
    check('I9 中断后没有残留 .tmp 临时文件',
          not [n for n in os.listdir(os.path.join(root, 'data', 'posts')) if n.startswith('.tmp')])
    check('I9 中断后没有留下孤儿正文', not os.path.exists(
        os.path.join(root, 'data', 'posts', 'interrupted-write.md')))

    # 中断后仍能正常导入（回滚没有把仓库带坏）
    rc, out = run_cli(['--file', path, '--apply', '--root', root])
    check('I9 回滚后可以重新导入成功', rc == 0, out.strip()[-80:])
    shutil.rmtree(root, ignore_errors=True)

    # ================================================================ I14 参数互斥
    rc, out = run_cli(['--file', f1, '--apply', '--dry-run', '--root', tmpdir])
    check('I14 --apply 与 --dry-run 互斥', rc != 0, rc)
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
