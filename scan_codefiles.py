# -*- coding: utf-8 -*-
"""
Scan local code/file directories and generate js/codefiles.js for the blog.

Only metadata (name, type, size, path, relPath) is stored — the actual files
stay on disk (zero duplication). Filtering drops dependency/cache/binary junk
so the generated JS stays sane in size.
"""
import argparse
import json
import os
import re
import sys

BLOG_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(BLOG_DIR, 'js', 'codefiles.js')

# (root_path, id, category_label)
ROOTS = [
    ("E:/codeplace",                     "codeplace",         "综合代码仓库"),
    ("E:/pythoncodeplace",               "pythoncodeplace",   "Python 代码"),
    ("E:/reinforce_learning",            "reinforce_learning","强化学习"),
    ("E:/成品/数学建模上传文件夹",          "math_modeling",     "数学建模"),
    ("E:/学习",                           "study",             "学习资料"),
    ("E:/杂项/matlab备份",                 "matlab_backup",     "MATLAB 备份"),
]

# Directories that should never be scanned (deps / caches / VCS / IDE)
EXCLUDE_DIRS = {
    '.git', 'node_modules', '__pycache__', 'venv', '.venv', 'env', 'dist',
    'build', '.idea', '.vscode', 'target', 'bin', 'obj', '.svn', '.gradle',
    'out', 'release', '.pytest_cache', '.mypy_cache', 'site-packages', '.tox',
    '.settings', '.ipynb_checkpoints', 'node_modules_copy',
    # environment / non-code directories (Premiere, IDE, MATLAB runtime, venv Lib)
    'pr', 'registry', 'win64', 'm3iregistry', 'lib',
}

# Directory-name prefixes that signal an environment / tool / IDE artifact
ENV_PREFIX = (
    'intellij idea', 'pycharm', 'sqlYog', 'adobe', 'premiere',
    'visual studio', 'webstorm', 'eclipse', 'anaconda', 'conda',
)

# Top-level folders to skip for specific libraries (defensive; user-requested)
ROOT_DROP_TOP = {
    'study': {'其他', '学术Seminar'},
}

# MATLAB installation-level runtime files — never project code, always drop
RUNTIME_BASENAMES = {
    'deploytool.bat', 'mbuild.bat', 'mcc.bat', 'mex.bat', 'mexext.bat',
    'mw_mpiexec.bat', 'worker.bat',
    'lcdata.xml', 'lcdata.xsd', 'lcdata_utf8.xml',
    'mex.pl', 'mexsetup.pm', 'mexutils.pm',
}


def is_env_dir(name):
    """True for environment / tool / IDE / runtime directories."""
    n = name.lower()
    if n in EXCLUDE_DIRS:
        return True
    for p in ENV_PREFIX:
        if n.startswith(p):
            return True
    return False

# File extensions with no browsing value / that bloat the data file
EXCLUDE_EXT = {
    # caches / build artifacts
    '.pyc', '.pyo', '.log', '.tmp', '.temp', '.cache', '.bak', '.swp', '.swo',
    '.class', '.o', '.obj', '.pdb', '.ilk', '.exp', '.ncb', '.opt', '.pyd',
    # binaries / libs / executables
    '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
    # archives
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.iso',
    '.img', '.bin', '.dat',
    # media (no browsing value in a code library)
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.webp',
    '.svg', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
    '.wav', '.aac', '.psd', '.ai', '.eps', '.ttf', '.otf', '.woff', '.woff2',
    '.eot', '.db', '.sqlite', '.sqlite3',
}

MAX_PER_LIB = 8000
MAX_FILE_SIZE = 30 * 1024 * 1024  # skip files larger than 30 MB

# ---- file type classification (Chinese labels, aligned with app.js) ----
def classify(path):
    ext = os.path.splitext(path)[1].lower()
    base = os.path.basename(path).lower()
    table = {
        '.pdf': 'PDF文档', '.doc': 'Word文档', '.docx': 'Word文档',
        '.ppt': 'PPT课件', '.pptx': 'PPT课件',
        '.xls': 'Excel表格', '.xlsx': 'Excel表格', '.csv': 'Excel表格',
        '.py': 'Python代码', '.ipynb': 'Jupyter Notebook',
        '.m': 'MATLAB代码', '.mlx': 'MATLAB代码', '.slx': 'Simulink模型',
        '.c': 'C代码', '.h': '头文件', '.cpp': 'C++代码', '.cc': 'C++代码',
        '.cxx': 'C++代码', '.hpp': '头文件', '.cu': 'C++代码',
        '.java': 'Java代码',
        '.js': 'JavaScript文件', '.jsx': 'JavaScript文件',
        '.ts': 'JavaScript文件', '.tsx': 'JavaScript文件',
        '.html': 'HTML文件', '.htm': 'HTML文件',
        '.css': 'CSS文件', '.scss': 'CSS文件', '.less': 'CSS文件',
        '.json': 'YAML配置', '.yml': 'YAML配置', '.yaml': 'YAML配置',
        '.xml': 'YAML配置', '.toml': 'YAML配置', '.ini': 'YAML配置',
        '.cfg': 'YAML配置', '.conf': 'YAML配置',
        '.md': '文档', '.txt': '文档', '.rst': '文档', '.tex': '文档',
        '.go': 'Go代码', '.rs': 'Rust代码', '.rb': 'Ruby代码', '.php': 'PHP代码',
        '.sh': 'Shell脚本', '.bat': 'Shell脚本', '.ps1': 'Shell脚本',
        '.sql': '文档',
        '.urdf': 'URDF模型', '.xacro': 'URDF模型', '.launch': 'ROS启动文件',
    }
    # filename-based overrides
    if base == 'dockerfile' or base.startswith('dockerfile'):
        return '其他'
    if base.endswith('.urdf') or base.endswith('.xacro'):
        return 'URDF模型'
    if ext in table:
        return table[ext]
    return '其他'

def fmt_size(n):
    if n < 1024:
        return f"{n} B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    elif n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    else:
        return f"{n / 1024 / 1024 / 1024:.2f} GB"

def scan_root(root_path, root_id, category):
    files = []
    truncated = False
    scanned_dirs = 0
    drop_top = ROOT_DROP_TOP.get(root_id, set())
    for dirpath, dirnames, filenames in os.walk(root_path):
        # prune excluded / hidden / environment directories in place (top-down)
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith('.') and not is_env_dir(d) and d not in drop_top
        ]
        scanned_dirs += 1
        for fn in filenames:
            if len(files) >= MAX_PER_LIB:
                truncated = True
                break
            ext = os.path.splitext(fn)[1].lower()
            if ext in EXCLUDE_EXT:
                continue
            if fn.lower() in RUNTIME_BASENAMES:
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            size = st.st_size
            if size > MAX_FILE_SIZE:
                continue
            rel = os.path.relpath(full, root_path).replace('\\', '/')
            # Extract project name (first-level directory); empty for root-level files
            parts = rel.split('/')
            project = parts[0] if len(parts) > 1 else ''
            files.append({
                "name": fn,
                "type": classify(full),
                "size": size,
                "project": project,
                "sizeFormatted": fmt_size(size),
            })
        if truncated:
            break
    return files, truncated, scanned_dirs

def load_previous_meta(path):
    """读取既有产物中的人工字段（description / guide），供重扫时保留。

    文件不存在 -> 返回空映射（等价于首次生成）。
    文件存在但读不懂 -> 直接中止：宁可报错，也不要把人工描述清空。
    """
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except OSError as e:
        raise SystemExit(f"[ABORT] 既有产物无法读取，可能丢失人工描述: {path} ({e})")
    m = re.search(r'const\s+CODE_LIBS\s*=\s*(\[[\s\S]*?\]);', text)
    if not m:
        raise SystemExit(f"[ABORT] 既有产物中没有 CODE_LIBS，无法确认人工描述: {path}")
    try:
        libs = json.loads(m.group(1))
    except ValueError as e:
        raise SystemExit(f"[ABORT] 既有产物解析失败，已中止以免覆盖人工描述: {e}")
    meta = {}
    for lib in libs:
        if not isinstance(lib, dict):
            continue
        lid = lib.get('id')
        if not lid:
            continue
        meta[lid] = {
            'description': lib.get('description') or '',
            'guide': lib.get('guide') or '',
        }
    return meta


def build_lib(root_path, root_id, category, previous_meta):
    """扫描单个根目录并合并人工字段（description / guide）。"""
    files, truncated, ndirs = scan_root(root_path, root_id, category)
    total = sum(f['size'] for f in files)
    prev = previous_meta.get(root_id) or {}
    lib = {
        "id": root_id,
        "name": os.path.basename(root_path.rstrip('/\\')) or root_id,
        "category": category,
        "fileCount": len(files),
        "totalSize": total,
        "totalSizeFormatted": fmt_size(total),
        # 人工撰写的描述：重扫时保留，新库默认为空
        "description": prev.get('description', ''),
    }
    if prev.get('guide'):
        lib["guide"] = prev['guide']
    lib["files"] = files
    return lib, truncated, ndirs


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='扫描代码库目录并生成 codefiles.js')
    parser.add_argument('--out', help='输出文件路径（默认 js/codefiles.js）')
    parser.add_argument('--roots', help='JSON 文件，自定义扫描根（[{path,id,category}]），供测试使用')
    return parser.parse_args(argv)


def main(roots=None, out_path=None):
    roots = list(ROOTS if roots is None else roots)
    out_file = out_path or OUT_FILE
    previous_meta = load_previous_meta(out_file)

    libs = []
    total_files = 0
    total_size = 0
    print("Scanning code/file directories...\n")
    for root_path, root_id, category in roots:
        if not os.path.isdir(root_path):
            print(f"  [SKIP] not found: {root_path}")
            continue
        lib, truncated, ndirs = build_lib(root_path, root_id, category, previous_meta)
        files = lib['files']
        total = lib['totalSize']
        libs.append(lib)
        total_files += len(files)
        total_size += total
        note = f" (TRUNCATED at {MAX_PER_LIB})" if truncated else ""
        print(f"  [OK] {category} ({root_id}): {len(files)} files, "
              f"{fmt_size(total)}, {ndirs} dirs scanned{note}")

    libs.sort(key=lambda x: x['category'])

    # Emit JS
    out = []
    out.append("/**")
    out.append(" * Code & File Library Data")
    out.append(" * Auto-generated by scan_codefiles.py")
    out.append(f" * Total: {len(libs)} libraries, {total_files} files")
    out.append(" */")
    out.append("")
    out.append("const CODE_LIBS = " + json.dumps(libs, ensure_ascii=False, indent=2) + ";")
    out.append("")
    out.append("// Compute CODE_CATEGORIES from CODE_LIBS array")
    out.append("const CODE_CATEGORIES = {};")
    out.append("CODE_LIBS.forEach(function (l) {")
    out.append("  if (!CODE_CATEGORIES[l.category]) {")
    out.append("    CODE_CATEGORIES[l.category] = { count: 0 };")
    out.append("  }")
    out.append("  CODE_CATEGORIES[l.category].count++;")
    out.append("});")

    out_dir = os.path.dirname(os.path.abspath(out_file))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(out_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')

    size_kb = os.path.getsize(out_file) / 1024
    kept_desc = sum(1 for l in libs if l.get('description'))
    kept_guide = sum(1 for l in libs if l.get('guide'))
    print(f"\nGenerated: {out_file}")
    print(f"  libraries: {len(libs)}")
    print(f"  descriptions preserved: {kept_desc}/{len(libs)}")
    print(f"  guides preserved: {kept_guide}/{len(libs)}")
    print(f"  total files (after filtering): {total_files}")
    print(f"  total size: {fmt_size(total_size)}")
    print(f"  JS file size: {size_kb:.1f} KB")

if __name__ == '__main__':
    args = parse_args()
    custom_roots = None
    if args.roots:
        try:
            with open(args.roots, encoding='utf-8') as f:
                raw_roots = json.load(f)
            custom_roots = [(r['path'], r['id'], r['category']) for r in raw_roots]
        except (OSError, ValueError, KeyError) as e:
            sys.exit(f"[ABORT] --roots 文件无效: {e}")
    main(roots=custom_roots, out_path=args.out)
