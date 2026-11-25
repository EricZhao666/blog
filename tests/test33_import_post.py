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
              'data/posts/manifest.json', 'feed.xml', 'data/content-links.json',
              'gen_feed.py', 'scripts/content_links.py',
              'scripts/build_content.py', 'scripts/split_posts.py', 'scripts/import_post.py',
              'js/courses.js', 'js/course-notes.js', 'js/papers.js',
              'js/codefiles.js', 'js/projects.js', 'js/note-slugs.js']
# 引用索引的权威源：fixture 必须齐全，否则索引会与 fixture 自身漂移
DERIVED = ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json',
           'feed.xml', 'data/content-links.json']


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
    check('I14 --dry-run 说明未来会更新 5 个派生文件', '待更新 5 个' in out, out.strip()[-80:])
    check('I14b dry-run 列出真实变化的全部产物（新增文章会同时改动索引）',
          all(rel in out for rel in DERIVED), out.strip()[-200:])

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

    # ================================================================ D1 新增文章失败回滚（含索引）
    # 注入点：索引已替换完成、最终 run_check 之前 → 必须字节级恢复 content-links.json。
    d1_root = make_repo()
    d1_before = snapshot(d1_root)
    d1_idx_before = io.open(os.path.join(d1_root, 'data', 'content-links.json'), 'rb').read()
    d1_article = dict(ARTICLE, id='d1-rollback', content=(
        '# D1 回滚验证\n\n'
        '引用已有文章 [[post:embodied-ai-notes]] 与草稿 [[post:d1-not-exist]]。\n\n'
        '显式站内链接：[回到笔记](#/post/embodied-ai-notes)\n'))
    f_d1 = write_json(tmpdir, 'd1.json', d1_article)

    calls = {'check': 0}
    fired = [False]
    idx_at_failure = []
    lock_at_rollback = []
    orig_check, orig_rollback = ip.run_check, ip._rollback

    def fail_check(root_arg):
        calls['check'] += 1
        idxp = os.path.join(root_arg, 'data', 'content-links.json')
        cur = io.open(idxp, 'rb').read() if os.path.exists(idxp) else b''
        if cur != d1_idx_before and not fired[0]:
            fired[0] = True
            idx_at_failure.append(cur)
            raise ip.ImportFailure('simulated failure after index replacement')
        return orig_check(root_arg)

    def spy_rollback(root_arg, backup, body_rel, delete_body):
        lock_at_rollback.append(os.path.exists(os.path.join(root_arg, ip.bc.LOCK_NAME)))
        return orig_rollback(root_arg, backup, body_rel, delete_body)

    ip.run_check, ip._rollback = fail_check, spy_rollback
    buf_out, buf_err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            rc = ip.main(['--file', f_d1, '--apply', '--root', d1_root])
    finally:
        ip.run_check, ip._rollback = orig_check, orig_rollback

    check('D1 注入失败后返回 1', rc == 1, rc)
    check('D1 失败发生在索引写入之后（注入点有效）',
          idx_at_failure and idx_at_failure[0] != d1_idx_before,
          len(idx_at_failure[0]) if idx_at_failure else 'no-capture')
    check('D1 新文章正文不存在',
          not os.path.exists(os.path.join(d1_root, 'data', 'posts', 'd1-rollback.md')))
    d1_after = snapshot(d1_root)
    diff = sorted(rel for rel in d1_before if d1_before[rel] != d1_after.get(rel))
    check('D1 全部派生产物逐字节恢复（含 content-links.json）', diff == [], diff)
    check('D1 content-links.json 字节级恢复',
          io.open(os.path.join(d1_root, 'data', 'content-links.json'), 'rb').read() == d1_idx_before)
    r_check = subprocess.run([sys.executable, os.path.join(d1_root, 'scripts', 'build_content.py'),
                              '--root', d1_root, '--check'], cwd=d1_root, capture_output=True,
                             text=True, encoding='utf-8', errors='replace', env=ENV)
    check('D1 回滚后 build_content --check 通过', r_check.returncode == 0,
          (r_check.stdout or r_check.stderr).strip()[-70:])

    # ---------------------------------------------------------------- D5 BuildLock 临界区
    check('D5 回滚发生在同一个构建锁内（不是释放锁后再回滚）',
          lock_at_rollback == [True], lock_at_rollback)
    check('D5 失败后锁已释放（没有把临界区留在占用状态）',
          not os.path.exists(os.path.join(d1_root, ip.bc.LOCK_NAME)))
    ok_article = dict(ARTICLE, id='d1-after-rollback', content='# 回滚后\n\n正文。\n')
    rc, out = run_cli(['--file', write_json(tmpdir, 'd1-ok.json', ok_article),
                       '--apply', '--root', d1_root])
    check('D5 回滚后可正常开始下一次导入（无残留锁）', rc == 0, out.strip()[-70:])
    shutil.rmtree(d1_root, ignore_errors=True)

    # ================================================================ I16 并发：两个计划都基于同一初始状态
    # 构造：A、B 两个新增计划都从同一份初始状态生成 → B 先提交 → 再执行 A。
    # A 的计划此时已过期：必须拒绝且**零写入**，尤其不能删除 B 刚写入的正文。
    def concurrent_case(id_a, id_b):
        root_ = make_repo()
        p_ = ip.bc.paths(root_)
        state0 = ip.bc.collect(p_)

        def post(pid, body):
            return {'id': pid, 'title': '并发 ' + pid, 'date': '2026-11-11',
                    'tags': ['测试'], 'excerpt': pid + ' 摘要', 'content': body}

        plan_a = ip.build_add_plan(root_, p_, state0, post(id_a, '# A\n\nA 正文。\n'))
        plan_b = ip.build_add_plan(root_, p_, state0, post(id_b, '# B\n\nB 正文。\n'))
        ip.apply_add_plan(root_, p_, plan_b)          # B 先提交成功
        before_a = snapshot(root_)
        conflict = None
        try:
            ip.apply_add_plan(root_, p_, plan_a)      # A 已过期
        except ip.ImportConflict as e:
            conflict = str(e)
        return root_, before_a, conflict

    for tag, id_a, id_b in [('同 id', 'conc-same', 'conc-same'), ('不同 id', 'conc-a', 'conc-b')]:
        croot, cbefore, cconflict = concurrent_case(id_a, id_b)
        b_body = os.path.join(croot, 'data', 'posts', id_b + '.md')
        check('I16 %s：A 的计划过期 → 冲突拒绝' % tag, cconflict is not None, cconflict)
        check('I16 %s：B 已提交正文仍然存在且内容完整' % tag,
              os.path.isfile(b_body) and io.open(b_body, encoding='utf-8').read() == '# B\n\nB 正文。\n')
        check('I16 %s：B 的元数据未被覆盖' % tag,
              "id: '%s'" % id_b in io.open(os.path.join(croot, 'js', 'data.js'),
                                           encoding='utf-8').read())
        if id_a != id_b:
            check('I16 %s：A 的正文没有被"成功"写进来' % tag,
                  not os.path.exists(os.path.join(croot, 'data', 'posts', id_a + '.md')))
        check('I16 %s：拒绝是零写入（B 提交后的五项产物逐字节不变）' % tag,
              snapshot(croot) == cbefore,
              sorted(r for r in DERIVED if cbefore.get(r) != snapshot(croot).get(r)))
        r_check = subprocess.run([sys.executable, os.path.join(croot, 'scripts', 'build_content.py'),
                                  '--root', croot, '--check'], cwd=croot, capture_output=True,
                                 text=True, encoding='utf-8', errors='replace', env=ENV)
        check('I16 %s：仓库仍自洽（--check 通过）' % tag, r_check.returncode == 0,
              (r_check.stdout or r_check.stderr).strip()[-60:])
        shutil.rmtree(croot, ignore_errors=True)

    # ================================================================ I17 B 改了"另一篇"的元数据（id 列表不变）
    # 新增计划会整份重写 js/data.js：若 A 在锁内不校验"完整内容版本"，
    # 就会把 B 刚提交的标题/标签等元数据静默覆盖回旧值（且 --check 仍然自洽，不易发现）。
    def bump_meta(root_, p_, pid, new_title):
        st = ip.bc.collect(p_)
        idx = ip.find_target_index(st, pid)
        cur = st['metas'][idx]
        ups = {'op': 'update', 'id': pid,
               'original': {'title': cur['title'], 'date': cur['date'], 'tags': list(cur['tags']),
                            'excerpt': cur['excerpt'], 'content': st['bodies'][pid]},
               'post': {'id': pid, 'title': new_title, 'date': cur['date'],
                        'tags': list(cur['tags']), 'excerpt': cur['excerpt'],
                        'content': st['bodies'][pid]}}
        ip.apply_update_plan(root_, p_, ip.build_update_plan(root_, p_, st, ups, idx))

    i17_root = make_repo()
    p17 = ip.bc.paths(i17_root)
    st17 = ip.bc.collect(p17)
    plan17 = ip.build_add_plan(i17_root, p17, st17, {
        'id': 'i17-new', 'title': 'I17 新文章', 'date': '2026-11-12', 'tags': ['测试'],
        'excerpt': 'I17', 'content': '# I17\n\n正文。\n'})
    bump_meta(i17_root, p17, 'embodied-ai-notes', '被 B 改过的标题')
    after_b = snapshot(i17_root)
    data_js_b = io.open(os.path.join(i17_root, 'js', 'data.js'), encoding='utf-8').read()
    check('I17 前置：B 的元数据修改确实生效', '被 B 改过的标题' in data_js_b)
    conflict17 = None
    try:
        ip.apply_add_plan(i17_root, p17, plan17)
    except ip.ImportConflict as e:
        conflict17 = str(e)
    check('I17 其它文章元数据被改 → A 的旧新增计划被拒绝', conflict17 is not None, conflict17)
    check('I17 B 的标题修改仍在（未被 plan 里的 data.js 覆盖）',
          '被 B 改过的标题' in io.open(os.path.join(i17_root, 'js', 'data.js'),
                                       encoding='utf-8').read())
    check('I17 B 修改后五项产物逐字节不变', snapshot(i17_root) == after_b,
          sorted(r for r in DERIVED if after_b.get(r) != snapshot(i17_root).get(r)))
    check('I17 A 的正文没有被写进来',
          not os.path.exists(os.path.join(i17_root, 'data', 'posts', 'i17-new.md')))
    r17 = subprocess.run([sys.executable, os.path.join(i17_root, 'scripts', 'build_content.py'),
                          '--root', i17_root, '--check'], cwd=i17_root, capture_output=True,
                         text=True, encoding='utf-8', errors='replace', env=ENV)
    check('I17 仓库仍自洽（--check 通过）', r17.returncode == 0,
          (r17.stdout or r17.stderr).strip()[-60:])
    shutil.rmtree(i17_root, ignore_errors=True)

    # ================================================================ I14 参数互斥
    rc, out = run_cli(['--file', f1, '--apply', '--dry-run', '--root', tmpdir])
    check('I14 --apply 与 --dry-run 互斥', rc != 0, rc)
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
