# -*- coding: utf-8 -*-
"""Batch 3.5：生成器可复现性测试（全部使用合成 Fixtures，不访问私人目录）。

覆盖：
    scripts/scan_courses.py   —— 扫描/分类/描述保留/空结果不覆盖/重复生成一致
    scripts/scan_papers.py    —— 合成 Zotero 库、日期规范化、缺失库中止、重复生成一致
    scripts/add_descriptions.js —— 描述真源写出、孤儿描述告警
"""
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, 'scripts')
TMP = tempfile.mkdtemp(prefix='b35_gen_')

passed = [0]
failed = [0]
skipped = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def skip(name, why):
    skipped[0] += 1
    print('SKIP ' + name + '  (' + why + ')')


def run(cmd, cwd=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run(cmd, cwd=cwd or ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


def sha(path):
    return hashlib.sha256(io.open(path, 'rb').read()).hexdigest() if os.path.isfile(path) else ''


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, 'w', encoding='utf-8').write(text)


def read_json_var(path, var):
    text = io.open(path, encoding='utf-8').read()
    m = re.search(r'const\s+%s\s*=\s*(\[[\s\S]*?\]);' % var, text)
    return json.loads(m.group(1)) if m else None


# ============================================================ courses fixture
def build_course_fixture():
    d_root = os.path.join(TMP, 'd_root')
    e_root = os.path.join(TMP, 'e_root')
    # D 盘侧：必须命中 "香港大学课程" 或 "设计课程"
    write(os.path.join(d_root, '香港大学课程', 'IDAT-7215-python', 'lecture01.pdf'), 'x')
    write(os.path.join(d_root, '香港大学课程', 'IDAT-7215-python', 'hw.py'), 'print(1)\n')
    write(os.path.join(d_root, '设计课程', 'PS技巧', 'tip.psd'), 'x')
    # E 盘侧：路径里出现 "学校课程" 会归到「大一」分支，故大二用独立层级
    write(os.path.join(e_root, '大一', '学校课程', '工程数学', 'notes.pdf'), 'x')
    write(os.path.join(e_root, '大二', '工程计算', 'lab.c'), 'int main(){}\n')
    # 被排除的类型与目录
    write(os.path.join(e_root, '大一', '学校课程', '工程数学', '.git', 'config'), 'x')
    write(os.path.join(e_root, '大一', '学校课程', '工程数学', 'cache.pyc'), 'x')
    roots = [
        {'path': d_root.replace('\\', '/'), 'drive': 'D'},
        {'path': e_root.replace('\\', '/'), 'drive': 'E'},
    ]
    return roots


print('== scan_courses.py ==')
roots = build_course_fixture()
roots_file = os.path.join(TMP, 'roots.json')
io.open(roots_file, 'w', encoding='utf-8').write(json.dumps(roots, ensure_ascii=False))
desc_file = os.path.join(TMP, 'descs.json')
io.open(desc_file, 'w', encoding='utf-8').write(json.dumps({
    'IDAT 7215 Python与机器学习': '人工描述-7215',
    '工程数学 (EE106/EE112)': '人工描述-工程数学',
}, ensure_ascii=False))
out_courses = os.path.join(TMP, 'courses.js')

r = run([sys.executable, os.path.join(SCRIPTS, 'scan_courses.py'),
         '--roots', roots_file, '--out', out_courses, '--descriptions', desc_file])
check('C1 课程生成器可运行', r.returncode == 0, (r.stderr or r.stdout).strip()[-120:])
courses = read_json_var(out_courses, 'COURSES') or []
names = [c['name'] for c in courses]
check('C2 生成 4 门课程', len(courses) == 4, names)
check('C3 分类正确',
      sorted(c['category'] for c in courses) == sorted(
          ['人工智能与机器学习', '设计', '数理基础', '计算机科学']),
      [c['category'] for c in courses])
idat = [c for c in courses if c['name'] == 'IDAT 7215 Python与机器学习']
check('C4 人工描述被写入', idat and idat[0].get('description') == '人工描述-7215',
      idat[0].get('description') if idat else None)
check('C5 无描述的课程不写空 description 字段',
      'description' not in [c for c in courses if c['name'] == 'PS技巧'][0])
check('C5b 产物不含文件清单字段',
      'files' not in io.open(out_courses, encoding='utf-8').read())

before = sha(out_courses)
r = run([sys.executable, os.path.join(SCRIPTS, 'scan_courses.py'),
         '--roots', roots_file, '--out', out_courses, '--descriptions', desc_file])
check('C6 连续两次生成结果一致', r.returncode == 0 and sha(out_courses) == before)

# 空结果不覆盖
empty_src = os.path.join(TMP, 'empty_src')
os.makedirs(empty_src, exist_ok=True)
empty_roots = os.path.join(TMP, 'empty_roots.json')
io.open(empty_roots, 'w', encoding='utf-8').write(
    json.dumps([{'path': empty_src.replace('\\', '/'), 'drive': 'D'}]))
guard_out = os.path.join(TMP, 'guard_courses.js')
write(guard_out, '/* 已有有效产物 */\n')
guard_before = sha(guard_out)
r = run([sys.executable, os.path.join(SCRIPTS, 'scan_courses.py'),
         '--roots', empty_roots, '--out', guard_out, '--descriptions', desc_file])
check('C7 零结果时中止', r.returncode != 0, r.returncode)
check('C8 零结果时不覆盖已有产物', sha(guard_out) == guard_before)

# ============================================================= papers fixture
print('\n== scan_papers.py ==')


def build_zotero(path):
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER);
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER);
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, lastName TEXT, firstName TEXT);
        CREATE TABLE itemCreators (itemID INTEGER, creatorID INTEGER, orderIndex INTEGER);
        CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT);
        CREATE TABLE collectionItems (itemID INTEGER, collectionID INTEGER);
        CREATE TABLE itemAttachments (itemID INTEGER, parentItemID INTEGER, path TEXT);
    """)
    c.execute("INSERT INTO itemTypes VALUES (1, 'journalArticle')")
    for fid, name in enumerate(['title', 'date', 'publicationName', 'abstractNote', 'url'], 1):
        c.execute("INSERT INTO fields VALUES (?, ?)", (fid, name))
    c.execute("INSERT INTO collections VALUES (1, '具身智能')")
    papers = [
        # (itemID, title, date, venue, abstract, url, creator)
        (1, 'Paper One', '2023-05-29 2023-5-29', 'ICRA', 'abs1', 'https://example.com/1', ('Smith', 'J')),
        (2, 'Paper Two', '2024-00-00', 'IROS', 'abs2', '', ('Wang', 'L')),
    ]
    for iid, title, date, venue, abstract, url, (last, first) in papers:
        c.execute("INSERT INTO items VALUES (?, 1)", (iid,))
        for fid, val in [(1, title), (2, date), (3, venue), (4, abstract), (5, url)]:
            c.execute("INSERT INTO itemDataValues VALUES (?, ?)", (100 * iid + fid, val))
            c.execute("INSERT INTO itemData VALUES (?, ?, ?)", (iid, fid, 100 * iid + fid))
        c.execute("INSERT INTO creators VALUES (?, ?, ?)", (iid, last, first))
        c.execute("INSERT INTO itemCreators VALUES (?, ?, 0)", (iid, iid))
        c.execute("INSERT INTO collectionItems VALUES (?, 1)", (iid,))
    conn.commit()
    conn.close()


zotero_db = os.path.join(TMP, 'zotero.sqlite')
build_zotero(zotero_db)
learn_dir = os.path.join(TMP, 'learn')
write(os.path.join(learn_dir, 'ANSYS学习素材', '第1课', 'lesson.txt'), 'x')
out_papers = os.path.join(TMP, 'papers.js')

r = run([sys.executable, os.path.join(SCRIPTS, 'scan_papers.py'),
         '--zotero-db', zotero_db, '--zotero-storage', os.path.join(TMP, 'storage'),
         '--learn-dir', learn_dir, '--out', out_papers])
check('P1 论文生成器可运行', r.returncode == 0, (r.stderr or r.stdout).strip()[-120:])
papers = read_json_var(out_papers, 'PAPERS') or []
check('P2 解析出 2 篇论文', len(papers) == 2, [p['id'] for p in papers])
check('P3 id 规则为 paper-<itemID>', [p['id'] for p in papers] == ['paper-1', 'paper-2'])
check('P4 标题/作者保留',
      papers[0]['title'] == 'Paper One' and papers[0]['authors'].startswith('Smith'),
      (papers[0]['title'], papers[0]['authors']))
check('P5 重复日期串被规范化', papers[0]['date'] == '2023-05-29', papers[0]['date'])
check('P6 Zotero 的 00 月日被规范化', papers[1]['date'] == '2024', papers[1]['date'])
check('P7 分类取自 collection', papers[0]['category'] == '具身智能', papers[0]['category'])
materials = read_json_var(out_papers, 'LEARNING_MATERIALS') or []
check('P8 学习资料被扫描', len(materials) == 1 and materials[0]['category'] == 'ANSYS仿真',
      [m['category'] for m in materials])

before = sha(out_papers)
r = run([sys.executable, os.path.join(SCRIPTS, 'scan_papers.py'),
         '--zotero-db', zotero_db, '--zotero-storage', os.path.join(TMP, 'storage'),
         '--learn-dir', learn_dir, '--out', out_papers])
check('P9 连续两次生成结果一致', r.returncode == 0 and sha(out_papers) == before)

missing_out = os.path.join(TMP, 'papers_missing.js')
r = run([sys.executable, os.path.join(SCRIPTS, 'scan_papers.py'),
         '--zotero-db', os.path.join(TMP, 'no-such.sqlite'), '--out', missing_out])
check('P10 数据库缺失时中止', r.returncode != 0, r.returncode)
check('P11 数据库缺失时不创建产物', not os.path.exists(missing_out))
check('P12 数据库缺失时不会新建空库',
      not os.path.exists(os.path.join(TMP, 'no-such.sqlite')))

# ==================================================== add_descriptions.js
print('\n== add_descriptions.js ==')
node = shutil.which('node')
if not node:
    skip('D1 描述真源生成', '未找到 node')
else:
    fake_courses = os.path.join(TMP, 'fake_courses.js')
    write(fake_courses, 'const COURSES = ' + json.dumps(
        [{'id': 'a', 'name': 'IDAT 7215 Python与机器学习'},
         {'id': 'b', 'name': '工程数学 (EE106/EE112)'}], ensure_ascii=False) + ';\n')
    desc_out = os.path.join(TMP, 'out_descs.json')
    # add_descriptions.js 读取 repo 内的 js/courses.js，这里改用临时 out 校验写出行为
    r = run([node, os.path.join(SCRIPTS, 'add_descriptions.js'), desc_out])
    ok = r.returncode == 0 and os.path.isfile(desc_out)
    check('D1 描述真源可生成', ok, (r.stderr or r.stdout).strip()[-120:])
    if ok:
        data = json.loads(io.open(desc_out, encoding='utf-8').read())
        check('D2 描述条目数 = 45', len(data) == 45, len(data))
        check('D3 内容与已知课程匹配', 'IDAT 7215 Python与机器学习' in data)
        # 用仓库真实 courses.js 的课程名反查：不应存在无对应课程的孤儿描述
        real_courses = read_json_var(os.path.join(ROOT, 'js', 'courses.js'), 'COURSES') or []
        names = set(c['name'] for c in real_courses)
        orphan = [k for k in data if k not in names]
        check('D4 描述与课程名一一对应', orphan == [], orphan)

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d，SKIP %d'
      % (passed[0] + failed[0] + skipped[0], passed[0], failed[0], skipped[0]))
sys.exit(0 if failed[0] == 0 else 1)
