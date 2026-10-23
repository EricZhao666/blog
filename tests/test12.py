# -*- coding: utf-8 -*-
"""B2-03 代码库数据生成器回归测试（合成目录，绝不扫描真实私人目录）。

验证：
  - 6 个已有代码库的人工 description 重扫后保持不变
  - 人工 guide 同样保留
  - 新增代码库正常生成且默认为空描述
  - 删除代码库后数据结构仍有效
  - 连续运行两次产物字节一致（幂等）
  - 文件数量与实际扫描结果一致
  - 既有产物损坏时中止且不覆盖
  - 真实 js/codefiles.js 的元数据可被无损提取（只读，不重扫真实目录）
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

BLOG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(BLOG, 'scan_codefiles.py')
REAL_PRODUCT = os.path.join(BLOG, 'js', 'codefiles.js')

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def read_libs(path):
    text = io.open(path, encoding='utf-8').read()
    m = re.search(r'const\s+CODE_LIBS\s*=\s*(\[[\s\S]*?\]);', text)
    return json.loads(m.group(1))


def build_fixture(base, n):
    """在临时目录里造 n 个合成代码库：root_i 内含 i 个 .py + README.md + 一个应被过滤的 .zip。"""
    for i in range(1, n + 1):
        d = os.path.join(base, 'root_%d' % i)
        os.makedirs(d, exist_ok=True)
        for j in range(1, i + 1):
            io.open(os.path.join(d, 'mod_%d.py' % j), 'w', encoding='utf-8').write('# fixture %d-%d\n' % (i, j))
        io.open(os.path.join(d, 'README.md'), 'w', encoding='utf-8').write('# lib %d\n' % i)
        io.open(os.path.join(d, 'blob.zip'), 'w', encoding='utf-8').write('ignored\n')


def make_roots(base, n):
    return [{'path': os.path.join(base, 'root_%d' % i).replace('\\', '/'),
             'id': 'lib_%d' % i,
             'category': '分类%d' % i} for i in range(1, n + 1)]


def run(args, cwd=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run([sys.executable, SCRIPT] + args,
                          capture_output=True, text=True, encoding='utf-8',
                          errors='replace', env=env, cwd=cwd)


tmp = tempfile.mkdtemp(prefix='b2_codefiles_')
try:
    build_fixture(tmp, 7)
    out = os.path.join(tmp, 'codefiles.js')
    roots_file = os.path.join(tmp, 'roots.json')

    # ---------- 1. 首次生成（无既有产物） ----------
    io.open(roots_file, 'w', encoding='utf-8').write(json.dumps(make_roots(tmp, 6), ensure_ascii=False))
    r1 = run(['--out', out, '--roots', roots_file])
    check('T1 首次生成成功', r1.returncode == 0, (r1.stderr or r1.stdout).strip().splitlines()[-1:] or '')
    libs1 = read_libs(out) if os.path.exists(out) else []
    check('T1 生成 6 个代码库', len(libs1) == 6, len(libs1))
    check('T1 新库描述默认为空', all(l.get('description') == '' for l in libs1))
    expect_counts = [i + 1 for i in range(1, 7)]   # mod_1..mod_i + README.md（blob.zip 被过滤）
    check('T1 文件数量与扫描结果一致', [l['fileCount'] for l in libs1] == expect_counts,
          [l['fileCount'] for l in libs1])

    # ---------- 2. 写入人工描述 / 导读后重扫（模拟人工编辑产物） ----------
    text = io.open(out, encoding='utf-8').read()
    libs_edit = read_libs(out)
    for lib in libs_edit:
        lib['description'] = '人工描述-' + lib['id'].split('_')[1]
    libs_edit[2]['guide'] = '人工导读-3'
    text = re.sub(r'const\s+CODE_LIBS\s*=\s*\[[\s\S]*?\];',
                  'const CODE_LIBS = ' + json.dumps(libs_edit, ensure_ascii=False, indent=2) + ';',
                  text, count=1)
    io.open(out, 'w', encoding='utf-8').write(text)

    r2 = run(['--out', out, '--roots', roots_file])
    libs2 = read_libs(out)
    check('T2 重扫成功', r2.returncode == 0, r2.returncode)
    check('T2 6 条人工描述保持不变',
          [l.get('description') for l in libs2] == ['人工描述-%d' % i for i in range(1, 7)],
          [l.get('description') for l in libs2])
    check('T2 人工导读保持不变', libs2[2].get('guide') == '人工导读-3', libs2[2].get('guide'))
    check('T2 文件数量仍与扫描一致', [l['fileCount'] for l in libs2] == expect_counts,
          [l['fileCount'] for l in libs2])
    check('T2 输出提示保留数量', 'descriptions preserved: 6/6' in r2.stdout,
          [ln for ln in r2.stdout.splitlines() if 'descriptions preserved' in ln])

    # ---------- 3. 幂等：再跑一次字节一致 ----------
    before_bytes = io.open(out, 'rb').read()
    r3 = run(['--out', out, '--roots', roots_file])
    after_bytes = io.open(out, 'rb').read()
    check('T3 连续运行产物字节一致', before_bytes == after_bytes, len(before_bytes))
    check('T3 第三次运行成功', r3.returncode == 0, r3.returncode)

    # ---------- 4. 新增代码库 ----------
    roots7 = make_roots(tmp, 7)
    roots7[6]['id'] = 'lib_new'
    roots7[6]['category'] = '分类7'
    io.open(roots_file, 'w', encoding='utf-8').write(json.dumps(roots7, ensure_ascii=False))
    run(['--out', out, '--roots', roots_file])
    libs4 = read_libs(out)
    new_lib = [l for l in libs4 if l['id'] == 'lib_new']
    check('T4 新增代码库被生成', len(new_lib) == 1, len(new_lib))
    check('T4 新增库描述为空', new_lib and new_lib[0].get('description') == '',
          new_lib[0].get('description') if new_lib else None)
    check('T4 旧库描述不受影响',
          [l.get('description') for l in libs4 if l.get('description')]
          == ['人工描述-%d' % i for i in range(1, 7)])

    # ---------- 5. 删除代码库 ----------
    io.open(roots_file, 'w', encoding='utf-8').write(json.dumps(make_roots(tmp, 5), ensure_ascii=False))
    run(['--out', out, '--roots', roots_file])
    libs5 = read_libs(out)
    check('T5 删除后不再出现该库', all(l['id'] != 'lib_6' for l in libs5), [l['id'] for l in libs5])
    check('T5 剩余库结构完整',
          all(set(['id', 'name', 'category', 'fileCount', 'totalSize', 'description', 'files']) <= set(l.keys())
              for l in libs5))
    check('T5 剩余描述仍保留', [l.get('description') for l in libs5] == ['人工描述-%d' % i for i in range(1, 6)])

    # ---------- 6. 既有产物损坏 -> 中止且不覆盖 ----------
    bad = os.path.join(tmp, 'bad.js')
    io.open(bad, 'w', encoding='utf-8').write('const CODE_LIBS = [ {oops\n')
    bad_before = io.open(bad, 'rb').read()
    r6 = run(['--out', bad, '--roots', roots_file])
    check('T6 既有产物损坏时中止', r6.returncode != 0, r6.returncode)
    check('T6 中止时不覆盖原文件', io.open(bad, 'rb').read() == bad_before)
    check('T6 错误信息明确', 'ABORT' in (r6.stderr + r6.stdout), (r6.stderr or r6.stdout).strip()[:60])

    # ---------- 7. 真实产物的元数据可无损提取（只读副本） ----------
    real_copy = os.path.join(tmp, 'real_copy.js')
    shutil.copyfile(REAL_PRODUCT, real_copy)
    sys.path.insert(0, BLOG)
    import importlib.util
    spec = importlib.util.spec_from_file_location('sc_cf', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    meta = mod.load_previous_meta(real_copy)
    check('T7 真实产物解析出 6 个代码库', len(meta) == 6, sorted(meta.keys()))
    check('T7 真实人工描述数 = 6',
          sum(1 for v in meta.values() if v.get('description')) == 6)
    check('T7 真实人工导读数 = 3',
          sum(1 for v in meta.values() if v.get('guide')) == 3,
          [k for k, v in meta.items() if v.get('guide')])

    # ---------- 8. 未触碰真实目录 / 产物 ----------
    check('T8 真实 js/codefiles.js 未被测试修改',
          io.open(REAL_PRODUCT, 'rb').read() == io.open(real_copy, 'rb').read())
    check('T8 未在仓库内留下临时文件',
          not [f for f in os.listdir(os.path.join(BLOG, 'js')) if f.endswith('.tmp')])

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(0 if failed[0] == 0 else 1)
