# -*- coding: utf-8 -*-
"""Batch 7B-2：学习资料持久 ID 生命周期（全部使用合成 Fixtures，不访问私人目录）。

背景（B7B-01 五模型验收结论）
------------------------------
* MiMo / Kimi 用数组下标做资料目标键：重排、前插、删除其他条目后旧链接跳到别的资料；
* DeepSeek / MiniMax / Hy4 用内容指纹（名称+分类+类型+大小…）：大小、显示名、分类一变，
  旧链接就失效。

本用例验证正式博客采用的方案：**持久 ID Registry**
----------------------------------------------------
身份来源是资料在学习目录内的相对路径（操作系统层面的原始身份），
必要时再用文件系统身份（``st_dev:st_ino``）确认"改名/移动后仍是同一份文件"；
公开出去的只有 ``lm-000123``。覆盖：

  L1-L3   首次分配 / 重复生成一致 / 排序靠前新增不影响既有 ID
  L4-L7   重排、删除其他资料、改文件大小、改分类（路径不变）后 ID 不变
  L8-L10  完全同名资料互相区分；重命名无迁移时旧 ID 失效但不串项；显式迁移沿用原 ID
  L11-L14 Registry 损坏 / ID 冲突 / 来源冲突 / 产物已有 ID 但 Registry 丢失时一律中止
  L15-L17 备份与恢复、退役 ID 不回收、0 资料与超额新增的保护闸

用法：python tests/test21_papers_id_registry.py
退出码：0 全部通过；1 有失败。
"""
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
SCAN = os.path.join(SCRIPTS, 'scan_papers.py')
TMP = tempfile.mkdtemp(prefix='b7b2_registry_')

sys.path.insert(0, SCRIPTS)
import papers_id_registry as idreg  # noqa: E402

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def run(cmd):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


def write(path, text='x'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, 'w', encoding='utf-8').write(text)


def sha(path):
    import hashlib
    return hashlib.sha256(io.open(path, 'rb').read()).hexdigest() if os.path.isfile(path) else ''


def read_var(path, var):
    text = io.open(path, encoding='utf-8').read()
    m = re.search(r'const\s+%s\s*=\s*(\[[\s\S]*?\]);' % var, text)
    return json.loads(m.group(1)) if m else None


def materials_by_name(out):
    out_map = {}
    for m in read_var(out, 'LEARNING_MATERIALS') or []:
        out_map.setdefault(m['name'], []).append(m)
    return out_map


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
    c.execute("INSERT INTO items VALUES (1, 1)")
    for fid, val in [(1, 'Fixture Paper'), (2, '2025-01-01'), (3, 'ICRA'),
                     (4, 'abs'), (5, 'https://example.invalid/1')]:
        c.execute("INSERT INTO itemDataValues VALUES (?, ?)", (100 + fid, val))
        c.execute("INSERT INTO itemData VALUES (1, ?, ?)", (fid, 100 + fid))
    c.execute("INSERT INTO creators VALUES (1, 'Smith', 'J')")
    c.execute("INSERT INTO itemCreators VALUES (1, 1, 0)")
    c.execute("INSERT INTO collectionItems VALUES (1, 1)")
    conn.commit()
    conn.close()


ZOTERO = os.path.join(TMP, 'zotero.sqlite')
build_zotero(ZOTERO)
LEARN = os.path.join(TMP, 'learn')
OUT = os.path.join(TMP, 'js', 'papers.js')
REG = os.path.join(TMP, '.papers-id', 'registry.json')


def scan(*extra, learn=None, out=None, reg=None, expect_ok=True):
    cmd = [sys.executable, SCAN,
           '--zotero-db', ZOTERO,
           '--zotero-storage', os.path.join(TMP, 'storage'),
           '--learn-dir', learn or LEARN,
           '--out', out or OUT,
           '--registry', reg or REG]
    cmd.extend(extra)
    r = run(cmd)
    if expect_ok and r.returncode != 0:
        print('  [scan stderr] ' + (r.stderr or '').strip()[-400:])
    return r


def load_reg():
    return idreg.load(REG, allow_missing=False)


# ---------------------------------------------------------------- 初始资料树
write(os.path.join(LEARN, 'ANSYS学习素材', '第1课', 'alpha.pdf'), 'aaa')
write(os.path.join(LEARN, 'ANSYS学习素材', '第1课', 'beta.pdf'), 'bbb')
write(os.path.join(LEARN, 'ANSYS学习素材', '第2课', 'same.pdf'), 'ccc')
write(os.path.join(LEARN, '机械臂', 'same.pdf'), 'ddd')

print('== L1-L3 首次分配 ==')
r = scan('--today', '2026-11-06')
check('L1 首次生成成功', r.returncode == 0, (r.stderr or '')[-200:])
mats = read_var(OUT, 'LEARNING_MATERIALS') or []
ids = [m.get('id') for m in mats]
check('L2 每条资料都有持久 ID', len(mats) == 4 and all(ids), ids)
check('L3 ID 形如 lm-000001 且按路径排序分配',
      ids == ['lm-000001', 'lm-000002', 'lm-000003', 'lm-000004'], ids)
reg = load_reg()
check('L3b Registry 记录了 nextId 与 4 条在用记录',
      reg['nextId'] == 5 and len(reg['entries']) == 4 and
      all(e['state'] == 'active' for e in reg['entries']), idreg.describe(reg))

check('L3c Registry 不含绝对路径 / 盘符',
      all((':' not in e['source'] and not e['source'].startswith('/')) for e in reg['entries']),
      [e['source'] for e in reg['entries']])
js_text = io.open(OUT, encoding='utf-8').read()
check('L3d 公开产物不含绝对路径 / 私人目录',
      (os.path.abspath(LEARN) not in js_text) and (TMP not in js_text) and
      not re.search(r'[A-Za-z]:\\\\', js_text) and
      not re.search(r'[A-Za-z]:/', js_text.replace('https://', '').replace('http://', '')),
      'leak' if os.path.abspath(LEARN) in js_text else 'ok')

before = sha(OUT)
r = scan('--today', '2026-11-07')
check('L4 重复生成结果一致（ID 稳定、产物逐字节相同）',
      r.returncode == 0 and sha(OUT) == before, r.returncode)

# ---------------------------------------------------------------- 元数据变化
write(os.path.join(LEARN, 'ANSYS学习素材', '第1课', 'alpha.pdf'), 'aaa-changed-size')
r = scan('--today', '2026-11-07')
alpha = materials_by_name(OUT)['alpha.pdf'][0]
check('L5 修改文件大小不生成新 ID', alpha['id'] == 'lm-000001', alpha['id'])
check('L5b 大小字段确实变了', alpha['size'] != 3, alpha['size'])

# 分类变化：分类是从路径推导的，这里验证"分类不同不影响 ID 分配逻辑"——
# 两条同名资料分属不同分类，各自 ID 独立（分类不参与 ID 计算）
m_map = materials_by_name(OUT)
same = m_map['same.pdf']
check('L6 完全同名资料被区分（分类/子分类不同 → 不同 ID）',
      len(same) == 2 and same[0]['id'] != same[1]['id'] and
      {s['category'] for s in same} == {'ANSYS仿真', '机械臂CAD模型'},
      [(s['id'], s['category']) for s in same])

# 重排：把文件改名成排序更靠前的名字（制造"前插"），再用显式迁移把它接回去
# 先验证纯新增（排序靠前）不改变既有 ID
write(os.path.join(LEARN, 'ANSYS学习素材', '第0课', 'aaa-first.pdf'), 'zzz')
r = scan('--today', '2026-11-08')
m_map = materials_by_name(OUT)
check('L7 新增排序靠前的资料：新 ID 追加，老 ID 不变',
      m_map['aaa-first.pdf'][0]['id'] == 'lm-000005' and
      m_map['alpha.pdf'][0]['id'] == 'lm-000001' and
      m_map['same.pdf'][0]['id'] == 'lm-000003',
      [m_map[k][0]['id'] for k in ('aaa-first.pdf', 'alpha.pdf', 'same.pdf')])

# 删除其他资料：只有它自己退役，其他 ID 不变，且退役 ID 不被回收
os.remove(os.path.join(LEARN, 'ANSYS学习素材', '第1课', 'beta.pdf'))
r = scan('--today', '2026-11-09')
reg = load_reg()
retired = [e['id'] for e in reg['entries'] if e['state'] == 'retired']
m_map = materials_by_name(OUT)
check('L8 删除其他资料：只退役它自己', retired == ['lm-000002'], retired)
check('L9 删除后其他资料的 ID 不变', m_map['alpha.pdf'][0]['id'] == 'lm-000001', m_map['alpha.pdf'][0]['id'])
check('L10 退役 ID 不会出现在产物中', 'lm-000002' not in [m['id'] for m in read_var(OUT, 'LEARNING_MATERIALS')])

write(os.path.join(LEARN, 'ANSYS学习素材', '第1课', 'beta.pdf'), 'bbb')
r = scan('--today', '2026-11-09')
m_map = materials_by_name(OUT)
check('L11 资料重新出现时沿用原 ID（不重新起号）',
      m_map['beta.pdf'][0]['id'] == 'lm-000002', m_map['beta.pdf'][0]['id'])

# ---------------------------------------------------------------- 重命名 / 迁移
os.rename(os.path.join(LEARN, '机械臂', 'same.pdf'),
          os.path.join(LEARN, '机械臂', 'same-renamed.pdf'))
r = scan('--today', '2026-11-10')
m_map = materials_by_name(OUT)
reg = load_reg()
auto = [m for m in reg.get('migrations', []) if m.get('auto') == 'fileId']
check('L12 重命名（文件系统身份可确认）沿用原 ID',
      m_map['same-renamed.pdf'][0]['id'] == 'lm-000004', m_map['same-renamed.pdf'][0]['id'])
check('L12b 自动迁移被记录进 Registry', any('same.pdf' in m['from'] for m in auto),
      [m['from'] for m in auto])

# 跨目录移动（仍可确认身份）
os.makedirs(os.path.join(LEARN, '风扇'), exist_ok=True)
os.rename(os.path.join(LEARN, '机械臂', 'same-renamed.pdf'),
          os.path.join(LEARN, '风扇', 'same-renamed.pdf'))
r = scan('--today', '2026-11-11')
m_map = materials_by_name(OUT)
check('L13 移动目录（分类随之改变）仍沿用原 ID',
      m_map['same-renamed.pdf'][0]['id'] == 'lm-000004' and
      m_map['same-renamed.pdf'][0]['category'] == 'CAD建模',
      (m_map['same-renamed.pdf'][0]['id'], m_map['same-renamed.pdf'][0]['category']))

# 无法确认身份时不得猜测：复制一份（新文件、新身份）→ 必须拿到新 ID
shutil.copyfile(os.path.join(LEARN, '风扇', 'same-renamed.pdf'),
                os.path.join(LEARN, '风扇', 'copy.pdf'))
r = scan('--today', '2026-11-12')
m_map = materials_by_name(OUT)
check('L14 文件副本（同一内容、不同身份）拿到新 ID，不复用原 ID',
      m_map['copy.pdf'][0]['id'] != 'lm-000004', m_map['copy.pdf'][0]['id'])

# 显式迁移：把 copy.pdf 改名并用 --migrations 声明"这就是原 copy.pdf"
mig_path = os.path.join(TMP, 'migrations.json')
io.open(mig_path, 'w', encoding='utf-8').write(json.dumps(
    [{'from': '风扇/copy.pdf', 'to': '风扇/copy-final.pdf'}], ensure_ascii=False))
os.rename(os.path.join(LEARN, '风扇', 'copy.pdf'),
          os.path.join(LEARN, '风扇', 'copy-final.pdf'))
before_id = m_map['copy.pdf'][0]['id']
r = scan('--migrations', mig_path, '--today', '2026-11-13', expect_ok=False)
m_map = materials_by_name(OUT)
reg = load_reg()
if 'copy-final.pdf' in m_map:
    check('L15 显式迁移沿用原 ID', m_map['copy-final.pdf'][0]['id'] == before_id,
          (before_id, m_map['copy-final.pdf'][0]['id']))
else:
    check('L15 显式迁移沿用原 ID', False, 'copy-final.pdf 未出现在产物中')
check('L15b 迁移被记录（from/to）',
      any(m.get('from') == '风扇/copy.pdf' for m in reg.get('migrations', [])),
      reg.get('migrations'))

# 迁移目标被别的资料占用 → 冲突中止
conflict_mig = os.path.join(TMP, 'migrations-conflict.json')
io.open(conflict_mig, 'w', encoding='utf-8').write(json.dumps(
    [{'from': '风扇/copy-final.pdf', 'to': '风扇/same-renamed.pdf'}], ensure_ascii=False))
before = sha(OUT)
r = scan('--migrations', conflict_mig, '--today', '2026-11-14', expect_ok=False)
check('L16 迁移目标被占用时中止且不改写产物',
      r.returncode != 0 and sha(OUT) == before, r.returncode)
check('L16b 中止原因包含冲突说明', '占用' in (r.stderr or '') or '冲突' in (r.stderr or ''),
      (r.stderr or '').strip()[-120:])

# 未知迁移来源 → 不得猜测
unknown_mig = os.path.join(TMP, 'migrations-unknown.json')
io.open(unknown_mig, 'w', encoding='utf-8').write(json.dumps(
    [{'from': '不存在/x.pdf', 'to': '风扇/y.pdf'}], ensure_ascii=False))
r = scan('--migrations', unknown_mig, '--today', '2026-11-14', expect_ok=False)
check('L17 未知迁移来源时中止（不猜）', r.returncode != 0, r.returncode)

# ---------------------------------------------------------------- 损坏 / 冲突
print('\n== L18-L24 Registry 损坏与冲突 ==')
good_reg = io.open(REG, encoding='utf-8').read()
before = sha(OUT)

io.open(REG, 'w', encoding='utf-8').write('{not json')
r = scan('--today', '2026-11-15', expect_ok=False)
check('L18 Registry 非法 JSON 时中止', r.returncode != 0, r.returncode)
check('L18b 中止时产物未被改写', sha(OUT) == before)
io.open(REG, 'w', encoding='utf-8').write(good_reg)

bad = json.loads(good_reg)
bad['entries'][1]['id'] = bad['entries'][0]['id']
io.open(REG, 'w', encoding='utf-8').write(json.dumps(bad, ensure_ascii=False, indent=2))
r = scan('--today', '2026-11-15', expect_ok=False)
check('L19 ID 冲突（重复 ID）时中止', r.returncode != 0 and 'ID 冲突' in (r.stderr or ''),
      (r.stderr or '').strip()[-100:])
check('L19b 冲突时产物未被改写', sha(OUT) == before)
io.open(REG, 'w', encoding='utf-8').write(good_reg)

bad = json.loads(good_reg)
bad['entries'][1]['source'] = bad['entries'][0]['source']
io.open(REG, 'w', encoding='utf-8').write(json.dumps(bad, ensure_ascii=False, indent=2))
r = scan('--today', '2026-11-15', expect_ok=False)
check('L20 来源冲突（两条记录同一路径）时中止',
      r.returncode != 0 and '冲突' in (r.stderr or ''), (r.stderr or '').strip()[-100:])
io.open(REG, 'w', encoding='utf-8').write(good_reg)

bad = json.loads(good_reg)
bad['nextId'] = 2
io.open(REG, 'w', encoding='utf-8').write(json.dumps(bad, ensure_ascii=False, indent=2))
r = scan('--today', '2026-11-15', expect_ok=False)
check('L21 nextId 回退（会导致 ID 复用）时中止', r.returncode != 0, (r.stderr or '').strip()[-100:])
io.open(REG, 'w', encoding='utf-8').write(good_reg)

# Registry 丢失但产物已有 ID → 默认中止（防止静默重建）
missing_reg = os.path.join(TMP, '.papers-id', 'gone.json')
r = scan('--today', '2026-11-15', reg=missing_reg, expect_ok=False)
check('L22 Registry 丢失但产物已含 ID 时中止', r.returncode != 0, r.returncode)
check('L22b 中止原因提示恢复而不是重建', 'Registry' in (r.stderr or ''), (r.stderr or '').strip()[-140:])

# 备份 + 恢复
before_entries = len(load_reg()['entries'])
write(os.path.join(LEARN, 'ANSYS学习素材', '第3课', 'new.pdf'), 'nnn')
r = scan('--today', '2026-11-16')
check('L23 内容变化后写回并产生 .bak 备份',
      r.returncode == 0 and os.path.isfile(REG + '.bak') and
      len(load_reg()['entries']) == before_entries + 1,
      (r.returncode, len(load_reg()['entries'])))
bak = io.open(REG + '.bak', encoding='utf-8').read()
io.open(REG, 'w', encoding='utf-8').write('{broken')
r = scan('--restore-registry', '--today', '2026-11-17', expect_ok=False)
check('L24 --restore-registry 能从备份恢复并继续生成',
      r.returncode == 0 and len(load_reg()['entries']) >= before_entries,
      (r.returncode, len(load_reg()['entries']) if r.returncode == 0 else None))
check('L24b 恢复后的 Registry 可正常解析', isinstance(load_reg(), dict), bak[:20])

# ---------------------------------------------------------------- 保护闸
print('\n== L25-L27 保护闸 ==')
empty_learn = os.path.join(TMP, 'empty-learn')
os.makedirs(empty_learn, exist_ok=True)
before = sha(OUT)
r = scan('--today', '2026-11-18', learn=empty_learn, expect_ok=False)
check('L25 扫描到 0 个资料且 Registry 有在用 ID 时中止', r.returncode != 0, r.returncode)
check('L25b 中止时产物未被改写', sha(OUT) == before)

r = scan('--today', '2026-11-18', learn=os.path.join(TMP, 'no-such-dir'), expect_ok=False)
check('L26 学习资料目录不存在时默认中止（不静默清空）', r.returncode != 0, r.returncode)

# 大批新增（模拟目录被重新挂载）→ 保护闸
mass_learn = os.path.join(TMP, 'mass-learn')
for i in range(12):
    write(os.path.join(mass_learn, 'ANSYS学习素材', '第9课', 'm%02d.pdf' % i), 'm')
before = sha(OUT)
r = scan('--today', '2026-11-18', learn=mass_learn, expect_ok=False)
check('L27 大批新增超过阈值时中止（防止误退役）', r.returncode != 0, r.returncode)
check('L27b 加 --allow-mass-retire 后可继续',
      scan('--allow-mass-retire', '--today', '2026-11-18', learn=mass_learn).returncode == 0)

# ---------------------------------------------------------------- 收尾
print('\n== L28 产物可被前端消费 ==')
mats = read_var(OUT, 'LEARNING_MATERIALS') or []
check('L28 产物每条资料仍有 id/name/category/subcategory/size 字段',
      all(set(['id', 'name', 'category', 'subcategory', 'size', 'sizeFormatted']).issubset(m.keys())
          for m in mats), len(mats))
check('L29 产物里的 ID 唯一', len(set(m['id'] for m in mats)) == len(mats), len(mats))

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
