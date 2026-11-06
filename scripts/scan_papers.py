#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫描 Zotero 数据库与学习资料目录，生成 js/papers.js。

用法：
    python scripts/scan_papers.py
    python scripts/scan_papers.py --zotero-db /tmp/zotero.sqlite --learn-dir /tmp/learn --out out.js

身份与 ID（Batch 7B-2）：
    - 论文 ID 复用 Zotero 自己的 itemID（`paper-<itemID>`），与标题/作者/分类解耦；
    - 学习资料 ID 来自持久 Registry（scripts/papers_id_registry.py），
      身份来源是资料在学习目录内的相对路径，公开出去的只有 `lm-000123`；
    - Registry 损坏 / 冲突时一律中止，绝不静默重建（否则所有旧链接会错位）；
    - 重命名或移动文件必须用 --migrations 显式声明，生成器不猜。

说明：
    - 默认路径是本机私人目录，仓库中不含任何私人数据；换机器后用参数指定。
    - Zotero 数据库不存在时直接中止（不会新建空库），
      一篇论文都没解析到时同样中止，避免覆盖已有产物。
    - js/papers.js 只写公开字段，绝不写入绝对路径。
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
import papers_id_registry as idreg  # noqa: E402

# 默认路径（仅本机可用；测试请用参数覆盖）
ZOTERO_DB = "D:/zotero/zotero.sqlite"
ZOTERO_STORAGE = "D:/zotero/storage"
LEARN_DIR = "E:/杂项/个人资料/学习"
OUTPUT = os.path.join(BASE_DIR, 'js', 'papers.js')
# Registry 默认位置：仓库根的 .papers-id/（点目录不会进入 Jekyll/Pages 产物）
DEFAULT_REGISTRY = os.path.join(BASE_DIR, '.papers-id', 'registry.json')


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description='扫描 Zotero + 学习资料目录，生成 papers.js')
    ap.add_argument('--zotero-db', help='zotero.sqlite 路径')
    ap.add_argument('--zotero-storage', help='Zotero storage 目录')
    ap.add_argument('--learn-dir', help='学习资料目录（可不存在）')
    ap.add_argument('--out', default=OUTPUT)
    ap.add_argument('--registry', help='学习资料 ID Registry 路径'
                                       '（默认 <仓库>/.papers-id/registry.json；'
                                       '自定义 --out 时默认放在 --out 同目录）')
    ap.add_argument('--migrations', help='显式重命名/移动映射 JSON：[{"from": 旧路径, "to": 新路径}]')
    ap.add_argument('--restore-registry', action='store_true',
                    help='从 <registry>.bak 恢复后再生成（显式恢复机制）')
    ap.add_argument('--force-new-registry', action='store_true',
                    help='已发布过资料 ID 但 Registry 丢失时，仍允许重新起号（会先备份旧产物）')
    ap.add_argument('--allow-missing-learn-dir', action='store_true',
                    help='学习资料目录不存在时仍然生成（会把全部资料标记为 retired）')
    ap.add_argument('--allow-empty-materials', action='store_true',
                    help='扫描到 0 个资料时仍然生成（默认中止，避免把 Registry 全部退役）')
    ap.add_argument('--allow-mass-retire', action='store_true',
                    help='同一次扫描新增 ID 超过在用数量的一半时仍然生成'
                         '（默认中止：通常意味着网盘未挂载 / 文件系统身份失效）')
    ap.add_argument('--today', help='首次分配/退役日期（YYYY-MM-DD，默认今天；测试用）')
    ap.add_argument('--dry-run', action='store_true', help='只打印将要发生的变更，不写任何文件')
    ap.add_argument('--report', help='把本次迁移结果写成 JSON 报告')
    return ap.parse_args(argv)


_args = _parse_args()
ZOTERO_DB = _args.zotero_db or ZOTERO_DB
ZOTERO_STORAGE = _args.zotero_storage or ZOTERO_STORAGE
LEARN_DIR = _args.learn_dir or LEARN_DIR
OUTPUT = _args.out
if _args.registry:
    REGISTRY = _args.registry
elif os.path.abspath(OUTPUT) == os.path.abspath(os.path.join(BASE_DIR, 'js', 'papers.js')):
    REGISTRY = DEFAULT_REGISTRY
else:
    REGISTRY = os.path.join(os.path.dirname(os.path.abspath(OUTPUT)), 'papers-id-registry.json')

if not os.path.isfile(ZOTERO_DB):
    sys.exit('[ABORT] 找不到 Zotero 数据库: %s（用 --zotero-db 指定）' % ZOTERO_DB)

EXCLUDE_PATTERNS = [r'\.git', r'__pycache__', r'\.idea', r'报销']  # skip personal financial docs

def should_exclude(path):
    for p in EXCLUDE_PATTERNS:
        if re.search(p, path, re.IGNORECASE):
            return True
    return False

def get_file_type(filename):
    ext = os.path.splitext(filename)[1].lower()
    m = {
        '.pdf': 'PDF', '.doc': 'Word', '.docx': 'Word', '.ppt': 'PPT', '.pptx': 'PPT',
        '.xls': 'Excel', '.xlsx': 'Excel', '.sldprt': 'SolidWorks零件',
        '.sldasm': 'SolidWorks装配体', '.x_t': 'Parasolid模型',
        '.jpg': '图片', '.jpeg': '图片', '.png': '图片',
        '.ino': 'Arduino代码', '.py': 'Python代码',
        '.lnk': '快捷方式',
    }
    return m.get(ext, '其他')

def format_size(size):
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    elif size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    else:
        return f"{size / (1024 * 1024 * 1024):.2f} GB"

# ========================================
# 1. Extract Zotero papers
# ========================================
conn = sqlite3.connect(ZOTERO_DB)
c = conn.cursor()

# Build collection map: itemID -> [collection names]
c.execute("""
    SELECT ci.itemID, col.collectionName
    FROM collectionItems ci
    JOIN collections col ON ci.collectionID = col.collectionID
""")
item_collections = {}
for item_id, col_name in c.fetchall():
    item_collections.setdefault(item_id, []).append(col_name)

# Build author map
c.execute("""
    SELECT ic.itemID, creators.lastName, creators.firstName
    FROM itemCreators ic
    JOIN creators ON ic.creatorID = creators.creatorID
    ORDER BY ic.orderIndex
""")
item_authors = {}
for item_id, last, first in c.fetchall():
    name = f"{last} {first}".strip() if first else last
    item_authors.setdefault(item_id, []).append(name)

# Build attachment map: parentItemID -> storage folder + filename
c.execute("""
    SELECT ia.parentItemID, ia.path, ia.itemID
    FROM itemAttachments ia
    WHERE ia.path LIKE 'storage:%'
""")
item_attachments = {}
for parent_id, path, attach_id in c.fetchall():
    filename = path.replace("storage:", "")
    full_path = os.path.join(ZOTERO_STORAGE, str(attach_id), filename)
    if parent_id:
        item_attachments.setdefault(parent_id, []).append({
            'filename': filename,
            'fullPath': full_path.replace('\\', '/'),
        })

# Get all paper items with metadata
c.execute("""
    SELECT i.itemID, it.typeName,
           MAX(CASE WHEN f.fieldName='title' THEN idv.value END) as title,
           MAX(CASE WHEN f.fieldName='date' THEN idv.value END) as date,
           MAX(CASE WHEN f.fieldName='publicationName' THEN idv.value END) as pub,
           MAX(CASE WHEN f.fieldName='abstractNote' THEN idv.value END) as abstract,
           MAX(CASE WHEN f.fieldName='url' THEN idv.value END) as url
    FROM items i
    JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
    LEFT JOIN itemData id ON i.itemID = id.itemID
    LEFT JOIN itemDataValues idv ON id.valueID = idv.valueID
    LEFT JOIN fields f ON id.fieldID = f.fieldID
    WHERE it.typeName NOT IN ('attachment', 'note')
    GROUP BY i.itemID
    ORDER BY i.itemID
""")
rows = c.fetchall()
conn.close()

def normalize_date(raw):
    """Zotero 的 date 字段形如 '2023-05-29 2023-5-29'（SQL 日期 + 原始日期），
    取第一段规范日期即可，避免页面上出现重复拼接的日期。
    Zotero 用 00 表示未知日/月（2023-12-00 / 2024-00-00），此时逐级降级为 年-月 / 年。"""
    if not raw:
        return ''
    head = raw.strip().split()[0]
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', head)
    if not m:
        return head
    year, month, day = m.group(1), m.group(2), m.group(3)
    if month == '00':
        return year
    if day == '00':
        return f'{year}-{month}'
    return head


papers = []
for row in rows:
    item_id, item_type, title, date, pub, abstract, url = row
    if not title:
        continue
    date = normalize_date(date)

    # Determine category from collections
    cols = item_collections.get(item_id, [])
    if '具身智能' in cols:
        category = '具身智能'
    elif '双足机器人' in cols:
        category = '双足机器人'
    elif '轮足机器人' in cols:
        category = '轮足机器人'
    elif '软体机器人' in cols:
        category = '软体机器人'
    elif '港大教授机器人论文' in cols:
        category = '港大教授论文'
    elif '课程机器人论文' in cols:
        category = '课程论文'
    elif '其他机器人' in cols:
        category = '其他机器人'
    elif '已读' in cols:
        category = '已读论文'
    else:
        category = '未分类'
    
    # Get authors
    authors = item_authors.get(item_id, [])
    # Format: "Smith J, Wang L, et al." if more than 3
    if len(authors) > 3:
        author_str = f"{authors[0]}, {authors[1]}, {authors[2]}, et al."
    elif authors:
        author_str = ", ".join(authors)
    else:
        author_str = "Unknown"
    
    # Get PDF path
    pdfs = item_attachments.get(item_id, [])
    pdf_path = pdfs[0]['fullPath'] if pdfs else None
    
    papers.append({
        'id': f'paper-{item_id}',
        'title': title,
        'authors': author_str,
        'type': item_type,
        'date': date or '',
        'venue': pub or '',
        'abstract': (abstract or '')[:500],
        'url': url or '',
        'category': category,
        'collections': cols,
    })

print(f"Extracted {len(papers)} papers from Zotero")

# ========================================
# 2. Scan E:\杂项\个人资料\学习
# ========================================
# 每条资料同时保留"身份来源"（相对路径）与"公开记录"（进入 papers.js 的字段）。
# 相对路径只用于 Registry 对账，绝不写进 js/papers.js。
scanned_materials = []

if not os.path.exists(LEARN_DIR):
    if not _args.allow_missing_learn_dir:
        sys.exit('[ABORT] 找不到学习资料目录: %s（用 --learn-dir 指定；'
                 '确认要清空资料列表请加 --allow-missing-learn-dir）' % LEARN_DIR)
else:
    for root, dirs, files in os.walk(LEARN_DIR):
        if should_exclude(root):
            continue
        for f in files:
            full_path = os.path.join(root, f)
            if should_exclude(full_path):
                continue

            rel_path = os.path.relpath(full_path, LEARN_DIR).replace('\\', '/')
            try:
                st = os.stat(full_path)
            except OSError:
                continue
            file_size = st.st_size
            file_type = get_file_type(f)
            # 文件系统身份提示（NTFS 文件索引等）：只有它能在改名/移动后
            # 由操作系统"确认"是同一份文件；拿不到就留空（不猜）。
            file_hint = ''
            if getattr(st, 'st_ino', 0):
                file_hint = '%d:%d' % (st.st_dev, st.st_ino)

            # Determine category
            parts = rel_path.split('/')
            if 'ANSYS学习素材' in parts:
                category = 'ANSYS仿真'
                # Extract lesson number
                for p in parts:
                    if '课' in p:
                        subcategory = p
                        break
                else:
                    subcategory = 'ANSYS'
            elif 'seminar' in parts:
                category = '学术Seminar'
                subcategory = parts[-2] if len(parts) > 1 else 'seminar'
            elif '机械臂' in parts:
                category = '机械臂CAD模型'
                subcategory = 'SolidWorks'
            elif '风扇' in parts:
                category = 'CAD建模'
                subcategory = 'SolidWorks'
            elif '抽屉' in parts:
                category = 'CAD建模'
                subcategory = 'SolidWorks'
            else:
                category = '其他'
                subcategory = ''

            # Skip categories that should not be published (local-only / non-content)
            if category in ('其他', '学术Seminar'):
                continue

            scanned_materials.append({
                'source': rel_path,
                'hint': file_hint,
                'record': {
                    'id': None,              # 由 Registry 对账后填入
                    'name': f,
                    'type': file_type,
                    'size': file_size,
                    'sizeFormatted': format_size(file_size),
                    'category': category,
                    'subcategory': subcategory,
                },
            })

# ========================================
# 2b. 持久 ID 对账（学习资料）
# ========================================
def _load_migrations(path):
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit('[ABORT] 迁移映射无法解析: %s (%s)' % (path, e))
    if isinstance(data, dict):
        data = data.get('migrations', [])
    if not isinstance(data, list):
        sys.exit('[ABORT] --migrations 必须是数组：[{"from": 旧路径, "to": 新路径}]')
    return data


def _read_published_ids(path):
    if not os.path.isfile(path):
        return set()
    with open(path, encoding='utf-8') as fh:
        return idreg.ids_in_js(fh.read())


reg = None
if _args.restore_registry:
    try:
        reg = idreg.restore_from_backup(REGISTRY)
    except idreg.RegistryCorrupt as e:
        sys.exit('[ABORT] 无法从备份恢复 Registry：%s' % e)

try:
    if reg is None:
        reg = idreg.load(REGISTRY)
except idreg.RegistryError as e:
    sys.exit('[ABORT] ID Registry 损坏，已中止（js/papers.js 未被改写）：%s' % e)

published = _read_published_ids(OUTPUT)
if reg is None:
    if published and not _args.force_new_registry:
        sys.exit('[ABORT] 找不到 ID Registry（%s），但已有产物包含 %d 个资料 ID。\n'
                 '        重新起号会让所有旧链接指向错误资料；请先恢复 Registry '
                 '（--restore-registry 或从版本库取回），确认要重新分配请加 --force-new-registry。'
                 % (REGISTRY, len(published)))
    reg = idreg.new_registry()

active_before = len([e for e in reg['entries'] if e['state'] == idreg.ACTIVE])
if not scanned_materials and active_before and not _args.allow_empty_materials:
    sys.exit('[ABORT] 本次扫描到 0 个资料，但 Registry 仍有 %d 个在用 ID。\n'
             '        这会把全部资料退役并使旧链接失效；目录被卸载/清空时请先检查，'
             '确认无误再加 --allow-empty-materials。' % active_before)

applied_migrations = []
if _args.migrations:
    try:
        applied_migrations = idreg.apply_migrations(reg, _load_migrations(_args.migrations), _args.today)
    except idreg.RegistryError as e:
        sys.exit('[ABORT] 迁移映射无法应用：%s' % e)

try:
    reconcile = idreg.reconcile(
        reg, [(m['source'], m['hint']) for m in scanned_materials], _args.today)
except idreg.RegistryError as e:
    sys.exit('[ABORT] Registry 对账失败：%s' % e)

# 大批新增通常意味着"目录没挂载 / 文件系统身份整体失效"，
# 继续生成会把几乎所有旧 ID 退役，先停下让人确认。
mass_limit = max(5, active_before // 2)
if active_before and len(reconcile['created']) > mass_limit and not _args.allow_mass_retire:
    sys.exit('[ABORT] 本次新增 %d 个资料 ID（在用 %d 个），超过安全阈值 %d。\n'
             '        这通常说明目录未挂载或文件系统身份整体变化；'
             '确认无误请加 --allow-mass-retire。'
             % (len(reconcile['created']), active_before, mass_limit))

learning_materials = []
for item in scanned_materials:
    item['record']['id'] = reconcile['ids'][item['source']]
    learning_materials.append(item['record'])

# 排序带上 ID 作为最终键：同分类同子分类同名时也保持确定顺序（可复现生成）
learning_materials.sort(key=lambda x: (x['category'], x.get('subcategory', ''), x['name'], x['id']))
print(f"Scanned {len(learning_materials)} learning material files")
print(f"ID Registry: {REGISTRY} ({idreg.describe(reg)})")
if reconcile['created']:
    print('  新分配 ID: %d 个（%s%s）' % (
        len(reconcile['created']), ', '.join(reconcile['created'][:5]),
        ' …' if len(reconcile['created']) > 5 else ''))
if reconcile['revived']:
    print('  恢复使用: %s' % ', '.join(reconcile['revived'][:10]))
if reconcile['retired']:
    print('  标记退役（旧 ID 保留、不再分配）: %s' % ', '.join(reconcile['retired'][:10]))
if reconcile.get('auto_migrations'):
    for m in reconcile['auto_migrations']:
        print('  自动迁移（文件系统身份可确认）: %s  %s -> %s' % (m['id'], m['from'], m['to']))
if applied_migrations:
    for m in applied_migrations:
        print('  显式迁移: %s  %s -> %s' % (m['id'], m['from'], m['to']))
if reconcile['created'] and reconcile['retired']:
    print('  [WARN] 同一次扫描里既有新增又有退役：如果是重命名/移动，'
          '请用 --migrations 显式声明，否则旧链接会失效（不会串项）。')

# ========================================
# 3. Generate JS
# ========================================
# Paper categories summary
paper_categories = {}
for p in papers:
    cat = p['category']
    if cat not in paper_categories:
        paper_categories[cat] = {'count': 0, 'types': set()}
    paper_categories[cat]['count'] += 1
    paper_categories[cat]['types'].add(p['type'])
for cat in paper_categories:
    paper_categories[cat]['types'] = sorted(list(paper_categories[cat]['types']))

# Learning material categories summary
learn_categories = {}
for m in learning_materials:
    cat = m['category']
    if cat not in learn_categories:
        learn_categories[cat] = {'count': 0, 'files': 0}
    learn_categories[cat]['count'] += 1
    learn_categories[cat]['files'] += 1

output = f"""/**
 * Papers & Learning Materials Data
 * Auto-generated by scripts/scan_papers.py（数据源为本机 Zotero 库，不入仓库）
 * Papers: {len(papers)} | Learning materials: {len(learning_materials)} files
 */

const PAPERS = {json.dumps(papers, ensure_ascii=False, indent=2)};

const PAPER_CATEGORIES = {json.dumps({k: {'count': v['count'], 'types': v['types']} for k, v in paper_categories.items()}, ensure_ascii=False, indent=2)};

const LEARNING_MATERIALS = {json.dumps(learning_materials, ensure_ascii=False, indent=2)};

const LEARN_CATEGORIES = {json.dumps(learn_categories, ensure_ascii=False, indent=2)};
"""

if not papers:
    sys.exit('[ABORT] 未从 Zotero 解析到任何论文，已中止（不覆盖 %s）' % OUTPUT)

summary = {
    'papers': len(papers),
    'materials': len(learning_materials),
    'registry': os.path.abspath(REGISTRY),
    'output': os.path.abspath(OUTPUT),
    'created': reconcile['created'],
    'revived': reconcile['revived'],
    'retired': reconcile['retired'],
    'migrations': applied_migrations,
    'autoMigrations': reconcile.get('auto_migrations', []),
    'dryRun': bool(_args.dry_run),
}

if _args.dry_run:
    print('\n[DRY-RUN] 未写入任何文件：')
    print('  Registry: %s (%s)' % (REGISTRY, idreg.describe(reg)))
    print('  Output:   %s' % OUTPUT)
    if _args.report:
        with open(_args.report, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    sys.exit(0)

# 顺序很重要：先落 Registry，再落 papers.js。
# 反过来一旦中途失败，产物里会出现 Registry 中不存在的 ID（旧链接永久失配）。
idreg.save(REGISTRY, reg)

out_dir = os.path.dirname(os.path.abspath(OUTPUT))
if out_dir and not os.path.isdir(out_dir):
    os.makedirs(out_dir, exist_ok=True)

if published and _args.force_new_registry:
    # 重新起号是破坏性操作：旧产物先备份，便于人工核对/回滚
    backup_out = OUTPUT + '.bak'
    if os.path.isfile(OUTPUT):
        with open(OUTPUT, encoding='utf-8') as src, \
                open(backup_out, 'w', encoding='utf-8', newline='\n') as dst:
            dst.write(src.read())
        print('[WARN] 已重新起号，旧产物备份到 %s（旧链接将失效）' % backup_out)

tmp_path = OUTPUT + '.tmp'
with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(output)
os.replace(tmp_path, OUTPUT)

if _args.report:
    with open(_args.report, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')

print(f"\nGenerated {OUTPUT}")
print(f"  Papers: {len(papers)}")
print(f"  Learning materials: {len(learning_materials)} files")
print(f"\nPaper categories:")
for cat, info in sorted(paper_categories.items()):
    print(f"  {cat}: {info['count']} papers")
print(f"\nLearning material categories:")
for cat, info in sorted(learn_categories.items()):
    print(f"  {cat}: {info['count']} files")
