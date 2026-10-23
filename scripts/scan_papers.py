#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫描 Zotero 数据库与学习资料目录，生成 js/papers.js。

用法：
    python scripts/scan_papers.py
    python scripts/scan_papers.py --zotero-db /tmp/zotero.sqlite --learn-dir /tmp/learn --out out.js

说明：
    - 默认路径是本机私人目录，仓库中不含任何私人数据；换机器后用参数指定。
    - Zotero 数据库不存在时直接中止（不会新建空库），
      一篇论文都没解析到时同样中止，避免覆盖已有产物。
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 默认路径（仅本机可用；测试请用参数覆盖）
ZOTERO_DB = "D:/zotero/zotero.sqlite"
ZOTERO_STORAGE = "D:/zotero/storage"
LEARN_DIR = "E:/杂项/个人资料/学习"
OUTPUT = os.path.join(BASE_DIR, 'js', 'papers.js')


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description='扫描 Zotero + 学习资料目录，生成 papers.js')
    ap.add_argument('--zotero-db', help='zotero.sqlite 路径')
    ap.add_argument('--zotero-storage', help='Zotero storage 目录')
    ap.add_argument('--learn-dir', help='学习资料目录（可不存在）')
    ap.add_argument('--out', default=OUTPUT)
    return ap.parse_args(argv)


_args = _parse_args()
ZOTERO_DB = _args.zotero_db or ZOTERO_DB
ZOTERO_STORAGE = _args.zotero_storage or ZOTERO_STORAGE
LEARN_DIR = _args.learn_dir or LEARN_DIR
OUTPUT = _args.out

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
learning_materials = []

if os.path.exists(LEARN_DIR):
    for root, dirs, files in os.walk(LEARN_DIR):
        if should_exclude(root):
            continue
        for f in files:
            full_path = os.path.join(root, f)
            if should_exclude(full_path):
                continue
            
            rel_path = os.path.relpath(full_path, LEARN_DIR).replace('\\', '/')
            file_size = os.path.getsize(full_path)
            file_type = get_file_type(f)
            
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

            learning_materials.append({
                'name': f,
                'type': file_type,
                'size': file_size,
                'sizeFormatted': format_size(file_size),
                'category': category,
                'subcategory': subcategory if 'subcategory' in dir() else '',
            })

# Sort learning materials by category then name
learning_materials.sort(key=lambda x: (x['category'], x.get('subcategory', ''), x['name']))
print(f"Scanned {len(learning_materials)} learning material files")

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

out_dir = os.path.dirname(os.path.abspath(OUTPUT))
if out_dir and not os.path.isdir(out_dir):
    os.makedirs(out_dir, exist_ok=True)
tmp_path = OUTPUT + '.tmp'
with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(output)
os.replace(tmp_path, OUTPUT)

print(f"\nGenerated {OUTPUT}")
print(f"  Papers: {len(papers)}")
print(f"  Learning materials: {len(learning_materials)} files")
print(f"\nPaper categories:")
for cat, info in sorted(paper_categories.items()):
    print(f"  {cat}: {info['count']} papers")
print(f"\nLearning material categories:")
for cat, info in sorted(learn_categories.items()):
    print(f"  {cat}: {info['count']} files")
