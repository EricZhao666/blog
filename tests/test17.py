# -*- coding: utf-8 -*-
"""B5-03：静态笔记页输出安全（JSON-LD 转义、正文净化、可重复生成）。

只读取仓库数据并输出到临时目录，不修改任何已提交产物。
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
TMP = tempfile.mkdtemp(prefix='b5_notes_')
passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def sha(path):
    return hashlib.sha256(io.open(path, 'rb').read()).hexdigest() if os.path.isfile(path) else ''


def run(args):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run(['node', os.path.join(ROOT, 'gen_notes_pages.js')] + args,
                          cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


try:
    repo_notes = os.path.join(ROOT, 'notes')
    before = {f: sha(os.path.join(repo_notes, f)) for f in os.listdir(repo_notes)}

    out1 = os.path.join(TMP, 'run1')
    r = run(['--out-dir', out1, '--now', '2026-10-22'])
    check('N1 生成成功', r.returncode == 0, (r.stderr or '').strip()[-100:])

    notes_dir = os.path.join(out1, 'notes')
    files = sorted(os.listdir(notes_dir)) if os.path.isdir(notes_dir) else []
    pages = [f for f in files if f.endswith('.html') and f != 'index.html']
    check('N2 生成 14 个笔记页 + 索引', len(pages) == 14 and 'index.html' in files, len(pages))

    check('N3 note-slugs.js 与仓库一致',
          sha(os.path.join(out1, 'js', 'note-slugs.js')) == sha(os.path.join(ROOT, 'js', 'note-slugs.js')))
    check('N4 sitemap 与仓库一致',
          sha(os.path.join(out1, 'sitemap.xml')) == sha(os.path.join(ROOT, 'sitemap.xml')))

    # ---------- JSON-LD 安全 ----------
    ld_ok, json_ok, esc_ok = True, True, True
    for f in pages:
        text = io.open(os.path.join(notes_dir, f), encoding='utf-8').read()
        blocks = re.findall(r'<script type="application/ld\+json">([\s\S]*?)</script>', text)
        if len(blocks) != 1:
            ld_ok = False
            continue
        block = blocks[0]
        if '<' in block or '>' in block:
            esc_ok = False
        try:
            data = json.loads(block)
            if data.get('@type') != 'Article' or not data.get('headline'):
                json_ok = False
        except ValueError:
            json_ok = False
    check('N5 每页恰好一个 JSON-LD 块', ld_ok)
    check('N6 JSON-LD 可被解析且语义正确', json_ok)
    check('N7 JSON-LD 内无原始尖括号（防 </script> 突破）', esc_ok)

    # ---------- 正文净化 ----------
    bad = []
    for f in pages:
        text = io.open(os.path.join(notes_dir, f), encoding='utf-8').read()
        for pat in [r'onerror\s*=', r'onclick\s*=', r'javascript:', r'<iframe', r'<object', r'<embed']:
            if re.search(pat, text, re.I):
                bad.append(f + ':' + pat)
    check('N8 静态页无危险属性/协议/元素', not bad, bad[:3])

    ext = []
    for f in pages:
        text = io.open(os.path.join(notes_dir, f), encoding='utf-8').read()
        if re.search(r'<script[^>]+src=["\']https?://', text, re.I):
            ext.append(f)
    check('N9 静态页不引用外部脚本', not ext, ext[:3])

    # ---------- 可重复 + 不影响仓库 ----------
    out2 = os.path.join(TMP, 'run2')
    run(['--out-dir', out2, '--now', '2026-10-22'])
    same = all(
        sha(os.path.join(out1, 'notes', f)) == sha(os.path.join(out2, 'notes', f))
        for f in files
    )
    check('N10 固定时间下两次生成一致', same)

    after = {f: sha(os.path.join(repo_notes, f)) for f in os.listdir(repo_notes)}
    check('N11 未修改仓库内已提交产物', before == after)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(0 if failed[0] == 0 else 1)
