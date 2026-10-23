#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫描课程目录，生成 js/courses.js（课程索引）。

用法：
    python scripts/scan_courses.py
    python scripts/scan_courses.py --out /tmp/courses.js --roots roots.json
    python scripts/scan_courses.py --descriptions data/course_descriptions.json

说明：
    - 默认扫描根是本机的私人目录，换机器后不存在会自动跳过；
      需要其它位置时用 --roots 传 JSON：[{"path": "...", "drive": "D"}]
    - 人工撰写的 description 存放在 data/course_descriptions.json（按课程名匹配），
      重新扫描不会清空；一门课都没扫到时直接中止，不覆盖已有产物。
"""
import argparse
import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 默认扫描根（仅本机可用；不存在会被跳过，测试请用 --roots）
DIRS = [
    ("D:/课程", "D"),
    ("E:/杂项/学习", "E"),
]

def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description='扫描课程目录，生成 courses.js')
    ap.add_argument('--roots', help='JSON 文件，自定义扫描根：[{"path": "...", "drive": "D"}]')
    ap.add_argument('--out', default=os.path.join(BASE_DIR, 'js', 'courses.js'))
    ap.add_argument('--descriptions',
                    default=os.path.join(BASE_DIR, 'data', 'course_descriptions.json'))
    return ap.parse_args(argv)


_args = _parse_args()
DIRS = _args.roots and [(r['path'], r['drive'])
                        for r in json.load(open(_args.roots, encoding='utf-8'))] or DIRS
output_path = _args.out
desc_path = _args.descriptions

# Exclude patterns
EXCLUDE_PATTERNS = [
    r'\.git',
    r'__pycache__',
    r'\.idea',
    r'4 6 级',  # Exclude inappropriate content
    r'inspectionProfiles',
    r'\.pyc$',
    r'class\.scc',
    r'\.scc$',
]

def should_exclude(path):
    for pattern in EXCLUDE_PATTERNS:
        if re.search(pattern, path, re.IGNORECASE):
            return True
    return False

def get_file_type(filename):
    ext = os.path.splitext(filename)[1].lower()
    type_map = {
        '.pdf': 'PDF文档',
        '.ppt': 'PPT课件',
        '.pptx': 'PPT课件',
        '.doc': 'Word文档',
        '.docx': 'Word文档',
        '.py': 'Python代码',
        '.ipynb': 'Jupyter Notebook',
        '.m': 'MATLAB代码',
        '.c': 'C代码',
        '.cpp': 'C++代码',
        '.h': '头文件',
        '.java': 'Java代码',
        '.xlsx': 'Excel表格',
        '.xls': 'Excel表格',
        '.txt': '文本文件',
        '.md': 'Markdown',
        '.zip': '压缩包',
        '.rar': '压缩包',
        '.7z': '压缩包',
        '.jpg': '图片',
        '.jpeg': '图片',
        '.png': '图片',
        '.gif': '图片',
        '.mp4': '视频',
        '.avi': '视频',
        '.psd': 'PSD文件',
        '.ai': 'AI文件',
        '.ttf': '字体',
        '.otf': '字体',
        '.urdf': 'URDF模型',
        '.launch': 'ROS启动文件',
        '.yaml': 'YAML配置',
        '.yml': 'YAML配置',
        '.json': 'JSON配置',
        '.xml': 'XML文件',
        '.html': 'HTML文件',
        '.css': 'CSS文件',
        '.js': 'JavaScript文件',
        '.slx': 'Simulink模型',
        '.torrent': '种子文件',
    }
    return type_map.get(ext, '其他')

# Category mapping based on directory paths
def categorize_course(rel_path, base_dir):
    """Determine course category and name from directory path."""
    parts = rel_path.replace('\\', '/').split('/')
    category = None
    course_name = None
    source = None
    year = None

    if base_dir == 'D':
        source = '香港大学/设计课程'
        if '香港大学课程' in rel_path:
            source = '香港大学'
            if '机器人大使' in rel_path:
                category = '机器人与自动化'
                course_name = '机器人大使 (Robotic Ambassador)'
            elif '7215python' in rel_path.lower() or '7215' in rel_path:
                category = '人工智能与机器学习'
                course_name = 'IDAT 7215 Python与机器学习'
            elif '7216' in rel_path:
                category = '计算机科学'
                course_name = 'IDAT 7216'
            elif 'uav' in rel_path.lower():
                category = '机器人与自动化'
                course_name = '无人机系统 (UAV)'
            elif '机器人' in rel_path and '已结束' in rel_path:
                category = '机器人与自动化'
                course_name = 'MECH7010 机器人学'
            elif '微系统' in rel_path:
                category = '电子与硬件'
                course_name = '微系统'
            elif '材料' in rel_path:
                category = '其他课程'
                course_name = '材料科学'
            elif '铁路' in rel_path:
                category = '其他课程'
                course_name = '铁路工程'
            elif 'capd' in rel_path.lower():
                category = '其他课程'
                course_name = '计算机辅助产品设计 (CAPD)'
            elif '7212' in rel_path:
                category = '其他课程'
                course_name = 'IDAT 7212'
            elif 'GRCNN' in rel_path:
                category = '机器人与自动化'
                course_name = 'GRCNN 抓取检测'
            elif 'ROS机械臂' in rel_path:
                category = '机器人与自动化'
                course_name = 'ROS机械臂开发视频教程'
            elif '机器人学' in rel_path and '国立交通' in rel_path:
                category = '机器人与自动化'
                course_name = '机器人学 (国立交通大学·杨谷洋)'
            elif '附加材料' in rel_path:
                category = '机器人与自动化'
                course_name = '附加材料'
        elif '设计课程' in rel_path:
            source = '设计课程'
            if 'ps技巧' in rel_path.lower():
                category = '设计'
                course_name = 'PS技巧'
            elif '广告设计' in rel_path:
                category = '设计'
                course_name = '广告设计'
            elif '网页设计html' in rel_path:
                category = '设计'
                course_name = '网页设计 (HTML)'
            elif '网页设计' in rel_path:
                category = '设计'
                course_name = '网页设计'
            elif '提升' in rel_path:
                category = '设计'
                course_name = 'PS提升课程'
            elif '精通' in rel_path:
                category = '设计'
                course_name = 'PS精通课程'
            elif '笔记' in rel_path:
                category = '设计'
                course_name = '设计笔记'
    elif base_dir == 'E':
        source = '本科课程'
        if '大一' in parts or '学校课程' in parts:
            year = '大一'
            if '工程数学' in rel_path:
                category = '数理基础'
                course_name = '工程数学 (EE106/EE112)'
            elif '工程物理' in rel_path:
                category = '数理基础'
                course_name = '工程物理 (EE104/EE110)'
            elif '数字系统' in rel_path:
                category = '电子与硬件'
                course_name = '数字系统'
            elif '电子工程基础' in rel_path:
                category = '电子与硬件'
                course_name = '电子工程基础'
            elif '系统与控制导论' in rel_path:
                category = '信号与控制'
                course_name = '系统与控制导论'
            elif '计算机科学导论' in rel_path:
                category = '计算机科学'
                course_name = '计算机科学导论'
            elif '英语' in rel_path:
                category = '其他课程'
                course_name = '英语'
            elif '心理健康' in rel_path:
                category = '其他课程'
                course_name = '大学生心理健康'
            elif '期末考' in rel_path:
                category = '其他课程'
                course_name = '期末考试'
        elif '大二' in parts:
            year = '大二'
            if '信号处理导论' in rel_path:
                category = '信号与控制'
                course_name = '信号处理导论 (EE213)'
            elif '工程计算' in rel_path:
                category = '计算机科学'
                course_name = '工程计算 (EE108, C语言)'
            elif '微分方程' in rel_path:
                category = '数理基础'
                course_name = '微分方程及其变换 (EE206)'
            elif '模拟电子' in rel_path:
                category = '电子与硬件'
                course_name = '模拟电子 (EE204)'
            elif '现代智能' in rel_path:
                category = '人工智能与机器学习'
                course_name = '现代智能与互联机器 (EE220)'
            elif '算法与数据结构' in rel_path:
                category = '计算机科学'
                course_name = '算法与数据结构'
            elif '英语' in rel_path:
                category = '其他课程'
                course_name = '英语'
        elif '大三' in parts:
            year = '大三'
            if '信号与系统' in rel_path:
                category = '信号与控制'
                course_name = '信号与系统'
            elif '控制系统设计' in rel_path:
                category = '信号与控制'
                course_name = '控制系统设计 (EE311)'
            elif '机器人与自动化' in rel_path:
                category = '机器人与自动化'
                course_name = '机器人与自动化 (CS422)'
            elif '概率论' in rel_path:
                category = '数理基础'
                course_name = '概率论 (EE304)'
        elif '大四' in parts:
            year = '大四'
            if '数字信号处理' in rel_path:
                category = '信号与控制'
                course_name = '数字信号处理'
            elif '机器学习' in rel_path:
                category = '人工智能与机器学习'
                course_name = '机器学习与神经网络'
            elif '机器运动' in rel_path:
                category = '机器人与自动化'
                course_name = '机器运动与传感 (EE413)'
            elif '自主移动机器人' in rel_path:
                category = '机器人与自动化'
                course_name = '自主移动机器人'
            elif '计算机与通信网络' in rel_path:
                category = '计算机科学'
                course_name = '计算机与通信网络'
            elif '计算机图形学' in rel_path:
                category = '计算机科学'
                course_name = '计算机图形学 (CS428)'

    return category, course_name, source, year

# Scan all files
all_files = []
for dir_path, drive in DIRS:
    if not os.path.exists(dir_path):
        continue
    for root, dirs, files in os.walk(dir_path):
        for f in files:
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, dir_path)

            if should_exclude(full_path) or should_exclude(rel_path):
                continue

            category, course_name, source, year = categorize_course(rel_path, drive)

            if category is None:
                continue

            file_size = os.path.getsize(full_path)
            file_type = get_file_type(f)

            all_files.append({
                'name': f,
                'category': category,
                'course': course_name,
                'source': source,
                'year': year,
                'type': file_type,
                'size': file_size,
            })

# Aggregate by course
courses = {}
for f in all_files:
    key = f"{f['source']}|{f['course']}"
    if key not in courses:
        courses[key] = {
            'id': key.replace(' ', '-').replace('/', '-'),
            'name': f['course'],
            'category': f['category'],
            'source': f['source'],
            'year': f['year'],
            'fileCount': 0,
            'totalSize': 0,
            'files': [],
        }
    courses[key]['fileCount'] += 1
    courses[key]['totalSize'] += f['size']
    courses[key]['files'].append({
        'name': f['name'],
        'type': f['type'],
        'size': f['size'],
    })

# Convert to list and sort
course_list = list(courses.values())

# Sort by category, then source, then year, then name
category_order = ['机器人与自动化', '人工智能与机器学习', '信号与控制', '计算机科学', '电子与硬件', '数理基础', '设计', '其他课程']
year_order = {'大一': 1, '大二': 2, '大三': 3, '大四': 4, None: 5}

course_list.sort(key=lambda c: (
    category_order.index(c['category']) if c['category'] in category_order else 99,
    year_order.get(c['year'], 5),
    c['source'],
    c['name'],
))

# Get categories summary
categories_summary = {}
for c in course_list:
    cat = c['category']
    if cat not in categories_summary:
        categories_summary[cat] = {'count': 0}
    categories_summary[cat]['count'] += 1

# Preserve hand-written description fields from the canonical source
# (data/course_descriptions.json), keyed by course name.
# 描述是人工撰写的文案，无法从磁盘扫描推导；单独存放可避免重新扫描时丢失。
GENERATED = len(course_list) > 0
existing_descriptions = {}
if os.path.exists(desc_path):
    try:
        with open(desc_path, encoding='utf-8') as f:
            existing_descriptions = json.load(f)
    except Exception as e:
        print(f'WARN: could not read {desc_path}: {e}')
else:
    print(f'WARN: descriptions source missing: {desc_path}')

# 站点课程区只展示笔记，不渲染文件清单；只输出实际用到的字段，
# 避免每门课的全量文件列表把 courses.js 撑到 300KB+。
missing_desc = []
for c in course_list:
    if c['name'] in existing_descriptions:
        c['description'] = existing_descriptions[c['name']]
    else:
        missing_desc.append(c['name'])

slim = [{k: c[k] for k in ('id', 'name', 'category', 'year', 'description')
         if c.get(k) not in (None, '')} for c in course_list]

# Generate JS file
output = f"""/**
 * Course Materials Data
 * 由 scan_courses.py 生成（文件清单字段已剥离，站点课程区只展示笔记）
 * description 为人工撰写，重新扫描时会自动保留
 * Total: {len(slim)} courses
 */

const COURSES = {json.dumps(slim, ensure_ascii=False, indent=2)};

// Compute COURSE_CATEGORIES from COURSES array
const COURSE_CATEGORIES = {{}};
COURSES.forEach(function(c) {{
  if (!COURSE_CATEGORIES[c.category]) {{
    COURSE_CATEGORIES[c.category] = {{ count: 0 }};
  }}
  COURSE_CATEGORIES[c.category].count++;
}});
"""

# Write to file
if not GENERATED:
    print('[ABORT] 未扫描到任何课程，已中止（不覆盖 %s）' % output_path, file=sys.stderr)
    sys.exit(1)

out_dir = os.path.dirname(os.path.abspath(output_path))
if out_dir and not os.path.isdir(out_dir):
    os.makedirs(out_dir, exist_ok=True)
tmp_path = output_path + '.tmp'
with open(tmp_path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(output)
os.replace(tmp_path, output_path)

print(f"Generated courses.js: {len(slim)} courses -> {output_path}")
print(f"\nCategories summary:")
for cat, info in sorted(categories_summary.items(), key=lambda x: category_order.index(x[0]) if x[0] in category_order else 99):
    print(f"  {cat}: {info['count']} courses")
if missing_desc:
    print(f"\nWARN: {len(missing_desc)} courses have no description in data/course_descriptions.json:")
    for n in missing_desc:
        print(f"  - {n}")
print(f"\nCourses:")
for c in slim:
    year_str = f" [{c['year']}]" if c.get('year') else ""
    desc_flag = " (有 description)" if c.get('description') else ""
    print(f"  [{c['category']}] {c['name']}{year_str}{desc_flag}")
