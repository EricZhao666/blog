# -*- coding: utf-8 -*-
"""Batch 8D-2B：发布前图片资源检查器（scripts/check_images.py）契约测试。

全部在隔离临时目录里用合成 Markdown Fixture 跑：不修改真实文章、不联网、不建占位图。

覆盖（对应任务书第七节的 20 项，另加 2 组补充断言）：
    I1  正常图片路径（仓库内相对路径 images/a.png）
    I2  图片不存在 → ERROR + 行号/原始引用/建议 + 退出码 1
    I3  空 images 目录（存在但没有任何图片）
    I4  图片目录尚未创建且文章没有引用 → 仍然通过，且检查器不创建 images/
    I5  中文文件名 + URL 编码（%XX、字面空格 + <…> 包裹）
    I6  Windows/Linux 大小写差异 → 必失败
    I7  URL 查询参数与片段
    I8  <路径> 形式的 Markdown URL 与标题
    I9  路径逃逸（../、images/../../、/blog/../）
    I10 符号链接逃逸 / 断链（无权限时用目录联接降级）
    I11 围栏代码块中的示例图片被忽略
    I12 行内代码中的图片语法被忽略（含跨行代码）
    I13 外部 HTTPS 图片：只 WARNING，不失败
    I14 非法协议（javascript:/file:/ftp:/Windows 盘符）
    I15 alt 缺失只 WARNING
    I16 文件超过 2 MiB 建议上限只 WARNING
    I17 多篇文章引用同一图片
    I18 README 等非文章 Markdown 不被当成文章图片
    I19 GitHub Pages 子路径：/blog/… 合法、/images/… 报错、/blog/ 指向目录报错
    I20 检查过程零写入（通过/失败两种情形都逐字节不变）
    I21 支持范围：HTML <img> 与参考式图片（含缺失定义）
    I22 输出字段完整（文件、行号、原始引用、建议）+ --root / 结构不可用退出码
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_DIR = os.path.join(ROOT, 'scripts')
CHECKER = os.path.join(SCRIPT_DIR, 'check_images.py')

sys.path.insert(0, ROOT)
sys.path.insert(0, SCRIPT_DIR)

import check_images as ci   # noqa: E402

passed = [0]
failed = [0]
skipped = [0]

ENV = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 128
TMP_DIRS = []


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra)[:90] + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra)[:90] + ')' if extra is not None else ''))


def skip(name, why):
    skipped[0] += 1
    print('SKIP ' + name + '  (' + why + ')')


# ---------------------------------------------------------------- 临时仓库
def mkdtemp(prefix, parent=None):
    d = tempfile.mkdtemp(prefix=prefix, dir=parent)
    TMP_DIRS.append(d)
    return d


def write_file(root, rel, data):
    path = os.path.join(root, rel.replace('/', os.sep))
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if isinstance(data, bytes):
        with open(path, 'wb') as f:
            f.write(data)
    else:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(data)
    return path


def make_root(posts, files=None):
    root = mkdtemp('b8d2b_img_')
    os.makedirs(os.path.join(root, 'data', 'posts'), exist_ok=True)
    for rel, data in (files or {}).items():
        write_file(root, rel, data)
    for name, text in posts.items():
        write_file(root, 'data/posts/' + name, text)
    return root


def findings_of(root):
    findings, stats, _posts = ci.collect_findings(root)
    return findings, stats


def errors_of(root):
    findings, _stats = findings_of(root)
    return [f for f in findings if f['sev'] == ci.ERROR]


def run_cli(root, extra=None):
    args = [sys.executable, CHECKER, '--check', '--root', root] + list(extra or [])
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def tree(root):
    """root 下所有条目（目录/文件/大小/mtime/哈希），用于证明"零写入"。"""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for d in sorted(dirnames):
            full = os.path.join(dirpath, d)
            out[os.path.relpath(full, root).replace(os.sep, '/') + '/'] = 'dir'
        for n in sorted(filenames):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            st = os.lstat(full)
            with open(full, 'rb') as f:
                out[rel] = (st.st_size, st.st_mtime_ns, hashlib.sha256(f.read()).hexdigest())
    return out


def try_symlink(target, link):
    try:
        os.symlink(target, link)
        return True
    except (OSError, NotImplementedError, AttributeError):
        return False


def try_junction(target_dir, link):
    if os.name != 'nt':
        return False
    try:
        subprocess.run(['cmd', '/c', 'mklink', '/J', link, target_dir],
                       capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return False
    return os.path.isdir(link)


try:
    # ============================================================== I1 正常路径
    root = make_root({'ok.md': '# 标题\n\n![焊接面宏观照片](images/a.png)\n'},
                     {'images/a.png': PNG})
    findings, stats = findings_of(root)
    check('I1 正常图片路径零 finding', not findings, findings)
    check('I1 统计：1 个引用且算作仓库内资源',
          stats['refs'] == 1 and stats['repo'] == 1 and stats['posts'] == 1, stats)
    rc, out = run_cli(root)
    check('I1 CLI 退出码 0 且带 OK: 通过标记', rc == 0 and 'OK:' in out, rc)
    check('I1 CLI 说明检查范围是 data/posts/*.md', 'data/posts/*.md' in out)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I2 图片不存在
    root = make_root({'miss.md': '第一段\n\n![缺失图](images/nope.png)\n'})
    errs = errors_of(root)
    check('I2 缺失图片报 1 个 ERROR', len(errs) == 1, errs)
    check('I2 错误信息说明"不存在"', errs and '不存在' in errs[0]['msg'], errs and errs[0]['msg'])
    check('I2 定位到 Markdown 行号 3', errs and errs[0]['line'] == 3, errs and errs[0]['line'])
    check('I2 带原始引用', errs and 'images/nope.png' in errs[0]['raw'], errs and errs[0]['raw'])
    check('I2 带建议处理方式', errs and 'images/nope.png' in errs[0]['fix'], errs and errs[0]['fix'])
    rc, out = run_cli(root)
    check('I2 CLI 退出码 1', rc == 1, rc)
    check('I2 失败时不打印 OK: 通过标记', 'OK:' not in out)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I3 空 images 目录
    root = make_root({'text-only.md': '只有文字，没有任何图片。\n'})
    os.makedirs(os.path.join(root, 'images'))
    findings, stats = findings_of(root)
    check('I3 空 images 目录 + 无引用 → 通过', not findings and stats['refs'] == 0, findings)
    rc, out = run_cli(root)
    check('I3 CLI 退出码 0', rc == 0 and 'OK:' in out, rc)
    check('I3 空目录不会被删除', os.path.isdir(os.path.join(root, 'images')))
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I4 目录未创建
    root = make_root({'no-images-dir.md': '没有 images 目录也没有引用。\n'})
    findings, stats = findings_of(root)
    check('I4 图片目录未创建也通过', not findings and stats['refs'] == 0, findings)
    rc, out = run_cli(root)
    check('I4 CLI 退出码 0', rc == 0, rc)
    check('I4 检查器不自动创建 images/ 目录（不生成占位图）',
          not os.path.exists(os.path.join(root, 'images')))
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I5 中文 + URL 编码
    root = make_root(
        {'cn.md': '![编码](images/%E4%B8%AD%E6%96%87-%E5%9B%BE.png)\n\n'
                  '![空格](<images/中文 图.png>)\n'},
        {'images/中文-图.png': PNG, 'images/中文 图.png': PNG})
    findings, stats = findings_of(root)
    check('I5 中文文件名（%XX 编码）可通过', not [f for f in findings if f['sev'] == ci.ERROR],
          findings)
    check('I5 尖括号包裹的中文空格路径可通过',
          not [f for f in findings if '中文 图' in (f['raw'] or '')], findings)
    check('I5 统计：2 个仓库内引用', stats['repo'] == 2, stats)

    root = make_root({'cn-miss.md': '![编码](images/%E4%B8%AD%E6%96%87.png)\n'})
    errs = errors_of(root)
    check('I5 编码路径不存在时按解码后的文件名报错',
          len(errs) == 1 and '中文.png' in errs[0]['msg'], errs and errs[0]['msg'])
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I6 大小写差异
    root = make_root({'case.md': '![大小写](images/photo.png)\n'},
                     {'images/Photo.PNG': PNG})
    errs = errors_of(root)
    check('I6 大小写不一致报 ERROR（Windows 能开、Linux 404）',
          len(errs) == 1 and '大小写' in errs[0]['msg'], errs and errs[0]['msg'])
    check('I6 错误里给出磁盘上的真实文件名',
          errs and 'Photo.PNG' in errs[0]['msg'], errs and errs[0]['msg'])
    rc, out = run_cli(root)
    check('I6 CLI 退出码 1', rc == 1, rc)

    root = make_root({'case2.md': '![目录大小写](Images/a.png)\n'},
                     {'images/a.png': PNG})
    errs = errors_of(root)
    check('I6 目录名大小写不一致同样报 ERROR',
          len(errs) == 1 and '大小写' in errs[0]['msg'], errs and errs[0]['msg'])
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I7 查询串/片段
    root = make_root({'query.md': '![a](images/a.png?v=2)\n\n'
                                  '![b](images/a.png#part)\n\n'
                                  '![c](images/a.png?v=2#part)\n'},
                     {'images/a.png': PNG})
    findings, stats = findings_of(root)
    check('I7 查询参数与片段不影响存在性判断',
          not [f for f in findings if f['sev'] == ci.ERROR], findings)
    check('I7 统计：3 个引用', stats['refs'] == 3 and stats['repo'] == 3, stats)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I8 <路径> 语法
    root = make_root(
        {'angle.md': '![空 格](<images/a b.png>)\n\n'
                     '![带标题](images/a.png "标题")\n\n'
                     '![尖括号带标题](<images/a b.png> "标题 (v2)")\n'},
        {'images/a b.png': PNG, 'images/a.png': PNG})
    findings, stats = findings_of(root)
    check('I8 <路径> + 标题语法可正确解析',
          not [f for f in findings if f['sev'] == ci.ERROR], findings)
    check('I8 统计：3 个引用都被识别', stats['refs'] == 3, stats)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I9 路径逃逸
    root = make_root({'escape.md': '![a](../private/a.png)\n\n'
                                   '![b](images/../../x.png)\n\n'
                                   '![c](/blog/../images/a.png)\n'})
    errs = errors_of(root)
    check('I9 ../ 逃逸报 3 个 ERROR', len(errs) == 3, errs)
    check('I9 错误信息指出 .. / 跳出站点根目录',
          all('..' in e['msg'] for e in errs), [e['msg'] for e in errs])
    rc, out = run_cli(root)
    check('I9 CLI 退出码 1', rc == 1, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I10 符号链接
    outside = mkdtemp('b8d2b_outside_')
    write_file(outside, 'secret.png', PNG)
    root = make_root({'link.md': '![x](images/link.png)\n'})
    os.makedirs(os.path.join(root, 'images'), exist_ok=True)
    link_path = os.path.join(root, 'images', 'link.png')
    if try_symlink(os.path.join(outside, 'secret.png'), link_path):
        errs = errors_of(root)
        check('I10 符号链接指向仓库外 → ERROR',
              len(errs) == 1 and ('符号链接' in errs[0]['msg'] or '仓库外部' in errs[0]['msg']),
              errs and errs[0]['msg'])
    elif try_junction(outside, os.path.join(root, 'images', 'linkdir')):
        write_file(root, 'data/posts/link.md', '![x](images/linkdir/secret.png)\n')
        errs = errors_of(root)
        check('I10 目录联接（符号链接等价）指向仓库外 → ERROR',
              len(errs) == 1 and ('符号链接' in errs[0]['msg'] or '仓库外部' in errs[0]['msg']),
              errs and errs[0]['msg'])
    else:
        skip('I10 符号链接逃逸', '当前平台不允许创建符号链接/联接')

    broken = os.path.join(root, 'images', 'broken.png')
    if try_symlink(os.path.join(root, 'images', 'not-there.png'), broken):
        write_file(root, 'data/posts/link.md', '![x](images/broken.png)\n')
        errs = errors_of(root)
        check('I10 断链符号链接 → ERROR',
              len(errs) == 1 and ('断' in errs[0]['msg'] or '不存在' in errs[0]['msg']),
              errs and errs[0]['msg'])
    else:
        skip('I10 断链符号链接', '当前平台不允许创建符号链接')
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(outside, ignore_errors=True)

    # ============================================================== I11 围栏代码块
    root = make_root({'fence.md': '正文\n\n'
                                  '```markdown\n'
                                  '![示例](images/missing-1.png)\n'
                                  '```\n\n'
                                  '~~~~\n'
                                  '![示例2](images/missing-2.png)\n'
                                  '~~~~\n\n'
                                  '```\n'
                                  '![示例3](images/missing-3.png)\n'
                                  '```\n'})
    findings, stats = findings_of(root)
    check('I11 代码块里的图片示例不算真实引用',
          not findings and stats['refs'] == 0, findings)
    rc, out = run_cli(root)
    check('I11 CLI 退出码 0', rc == 0 and 'OK:' in out, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I12 行内代码
    root = make_root({'inline.md': '用它时写 `![示例](images/missing-1.png)` 即可。\n\n'
                                   '``\n![跨行代码](images/missing-2.png)\n``\n'})
    findings, stats = findings_of(root)
    check('I12 行内代码（含跨行）里的图片语法不算引用',
          not findings and stats['refs'] == 0, findings)

    root = make_root({'escaped.md': '转义写法 \\![不是图片](images/missing.png)\n'})
    findings, stats = findings_of(root)
    check('I12 转义的 \\!\\[…\\](…) 不算图片引用', not findings and stats['refs'] == 0, findings)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I13 外部 HTTPS
    root = make_root({'ext.md': '![外链](https://example.com/a.png)\n'})
    findings, stats = findings_of(root)
    check('I13 外部 HTTPS 只报 WARNING',
          len(findings) == 1 and findings[0]['sev'] == ci.WARNING, findings)
    check('I13 说明只检查格式、不保证可访问',
          findings and '外部图片' in findings[0]['msg'], findings and findings[0]['msg'])
    rc, out = run_cli(root)
    check('I13 WARNING 不影响退出码', rc == 0 and 'OK:' in out, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I14 非法协议
    root = make_root({'proto.md': '![js](javascript:alert(1))\n\n'
                                  '![file](file:///C:/secret.png)\n\n'
                                  '![ftp](ftp://example.com/a.png)\n\n'
                                  '![win](C:\\Users\\me\\a.png)\n'})
    errs = errors_of(root)
    check('I14 非法协议全部报 ERROR', len(errs) == 4, errs)
    check('I14 错误里点名协议或被拒绝的原因',
          all(('协议' in e['msg']) or ('不安全' in e['msg']) for e in errs),
          [e['msg'] for e in errs])
    rc, out = run_cli(root)
    check('I14 CLI 退出码 1', rc == 1, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I15 alt 缺失
    root = make_root({'noalt.md': '![](images/a.png)\n\n![   ](images/a.png)\n'},
                     {'images/a.png': PNG})
    findings, stats = findings_of(root)
    check('I15 alt 为空只报 WARNING', len(findings) == 2
          and all(f['sev'] == ci.WARNING for f in findings), findings)
    check('I15 提示补充描述', all('alt' in f['msg'] for f in findings),
          [f['msg'] for f in findings])
    rc, out = run_cli(root)
    check('I15 CLI 退出码 0', rc == 0, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I16 体积超限
    big = b'\x89PNG\r\n\x1a\n' + b'0' * (2 * 1024 * 1024)
    root = make_root({'big.md': '![大图](images/big.png)\n'}, {'images/big.png': big})
    findings, stats = findings_of(root)
    check('I16 超过 2 MiB 只报 WARNING', len(findings) == 1
          and findings[0]['sev'] == ci.WARNING, findings)
    check('I16 提示超过编辑器上限', findings and '2 MiB' in findings[0]['msg'],
          findings and findings[0]['msg'])
    rc, out = run_cli(root)
    check('I16 CLI 退出码 0', rc == 0, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I17 多篇共享图片
    root = make_root({'a.md': '![a](images/shared.png)\n',
                      'b.md': '![b](images/shared.png)\n'},
                     {'images/shared.png': PNG})
    findings, stats = findings_of(root)
    check('I17 两篇文章引用同一张图片都不报错', not findings, findings)
    check('I17 统计：2 个引用 / 2 篇文章',
          stats['refs'] == 2 and stats['posts'] == 2, stats)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I18 README 示例
    root = make_root({'post.md': '# 没有图片的文章\n'},
                     {'README.md': '示例：![截图](images/not-exist.png)\n',
                      'docs/README.md': '示例：![截图](images/not-exist.png)\n',
                      'images/README.md': '示例：![截图](images/not-exist.png)\n'})
    findings, stats = findings_of(root)
    check('I18 README 里的示例图片被忽略', not findings and stats['refs'] == 0, findings)
    rc, out = run_cli(root)
    check('I18 CLI 退出码 0', rc == 0 and 'OK:' in out, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I19 Pages 子路径
    root = make_root({'site.md': '![子路径](/blog/images/a.png)\n'}, {'images/a.png': PNG})
    findings, stats = findings_of(root)
    check('I19 /blog/images/a.png 可解析到仓库内图片',
          not [f for f in findings if f['sev'] == ci.ERROR], findings)
    check('I19 统计：算作站内绝对路径', stats['site'] == 1, stats)

    root = make_root({'bad-site.md': '![站点根](/images/a.png)\n'})
    errs = errors_of(root)
    check('I19 /images/a.png 报 ERROR（不在 /blog/ 子路径下）',
          len(errs) == 1 and '/blog/' in errs[0]['msg'], errs and errs[0]['msg'])
    check('I19 建议里保留子路径写法', errs and '/blog/' in errs[0]['fix'],
          errs and errs[0]['fix'])

    root = make_root({'dir-site.md': '![目录](/blog/)\n'})
    errs = errors_of(root)
    check('I19 /blog/ 指向目录 → ERROR',
          len(errs) == 1 and '目录' in errs[0]['msg'], errs and errs[0]['msg'])

    root = make_root({'abs.md': '![绝对](/blog/images/a.png)\n'}, {'images/a.png': PNG})
    rc, out = run_cli(root)
    check('I19 子路径合法时 CLI 退出码 0', rc == 0 and 'OK:' in out, rc)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I20 零写入
    root_ok = make_root({'ok.md': '![a](images/a.png)\n'}, {'images/a.png': PNG})
    root_bad = make_root({'bad.md': '![b](images/missing.png)\n'})
    before_ok, before_bad = tree(root_ok), tree(root_bad)
    rc_ok, _out = run_cli(root_ok)
    findings_of(root_ok)
    rc_bad, _out2 = run_cli(root_bad)
    findings_of(root_bad)
    after_ok, after_bad = tree(root_ok), tree(root_bad)
    check('I20 通过场景检查后目录逐字节不变', before_ok == after_ok,
          sorted(set(before_ok) ^ set(after_ok)))
    check('I20 失败场景检查后目录逐字节不变', before_bad == after_bad,
          sorted(set(before_bad) ^ set(after_bad)))
    check('I20 退出码仍是 0 / 1', (rc_ok, rc_bad) == (0, 1), (rc_ok, rc_bad))
    check('I20 没有留下 .tmp / .part 临时文件',
          not [n for n in list(after_ok) + list(after_bad)
               if '.tmp' in n or n.endswith('.part')])
    shutil.rmtree(root_ok, ignore_errors=True)
    shutil.rmtree(root_bad, ignore_errors=True)

    # 真实仓库：检查器只读，不产生 images/ 目录
    real_images = os.path.join(ROOT, 'images')
    had_real_images = os.path.exists(real_images)
    rc_real, out_real = run_cli(ROOT)
    check('I20 真实仓库检查通过且退出码 0', rc_real == 0 and 'OK:' in out_real, rc_real)
    if not had_real_images:
        check('I20 真实仓库检查不会创建 images/ 目录', not os.path.exists(real_images))

    # ============================================================== I21 支持范围
    root = make_root({'mixed.md': '参考式示例\n\n'
                                  '![参考图][fig]\n\n'
                                  '[fig]: images/ref.png\n\n'
                                  '<img src="images/html.png" alt="HTML 图">\n\n'
                                  '<img src="images/missing-html.png" alt="缺失">\n\n'
                                  '![未定义][nope]\n'},
                     {'images/ref.png': PNG, 'images/html.png': PNG})
    findings, stats = findings_of(root)
    errs = [f for f in findings if f['sev'] == ci.ERROR]
    warns = [f for f in findings if f['sev'] == ci.WARNING]
    check('I21 参考式与 HTML <img> 都被识别（共 4 个引用）', stats['refs'] == 4, stats)
    check('I21 只有 HTML 缺失图报 ERROR',
          len(errs) == 1 and 'missing-html.png' in errs[0]['raw'], errs)
    check('I21 参考式定义缺失只报 WARNING',
          len(warns) == 1 and '参考式' in warns[0]['msg'], warns)
    shutil.rmtree(root, ignore_errors=True)

    # ============================================================== I22 输出与结构
    root = make_root({'bad.md': '第一段\n\n![缺失](images/gone.png)\n'})
    rc, out = run_cli(root)
    check('I22 输出含 文件:行号', 'data/posts/bad.md:3' in out, out.strip()[:120])
    check('I22 输出含 原始引用', '引用:' in out and 'images/gone.png' in out)
    check('I22 输出含 建议处理方式', '建议:' in out)
    check('I22 输出含 ERROR/WARNING 汇总', 'ERROR 1' in out and 'WARNING' in out, out.strip()[-120:])
    rc, out = run_cli(parent_without_posts := mkdtemp('b8d2b_nopost_'))
    check('I22 缺少 data/posts 时返回 2（结构不可用，不算通过）', rc == 2, rc)
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(parent_without_posts, ignore_errors=True)

finally:
    for d in TMP_DIRS:
        shutil.rmtree(d, ignore_errors=True)

print('\n共 %d 项，PASS %d，FAIL %d（SKIP %d）'
      % (passed[0] + failed[0], passed[0], failed[0], skipped[0]))
sys.exit(1 if failed[0] else 0)
