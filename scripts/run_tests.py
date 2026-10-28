#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一测试入口：环境检查 → 语法检查 → 全站巡检 → 回归测试 → 汇总报告。

用法：
    python scripts/run_tests.py             # 全部
    python scripts/run_tests.py --only test9 audit
    python scripts/run_tests.py --skip-syntax
    python scripts/run_tests.py --report tests/reports/last-run.md

退出码：
    0  全部通过
    1  有测试失败
    2  环境缺失 / 必要依赖缺失（阻塞，不算失败但也不能算通过）

约定：
    - 不修改任何业务文件；
    - 不访问仓库外的私人目录；
    - 不执行 git 写操作、不 push、不部署。
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REPORT = os.path.join(ROOT, 'tests', 'reports', 'last-run.md')
TIMEOUT = 240
# 浏览器套件（真实 Chromium + 本地服务器）在 2 核 CI 上耗时远高于开发机：
# 本机 sw-consistency 约 90 s，负载高时可到 260 s，因此单独放宽而不是压缩用例。
BROWSER_TIMEOUT = 600

# ---------------------------------------------------------------- 测试清单
# kind: 'jsdom' 需要 node + jsdom；'python' 需要 python
TESTS = [
    {'name': 'audit', 'file': 'tests/audit.js', 'kind': 'jsdom',
     'desc': '全站巡检：路由渲染、死链、静态页一致性、404 资源',
     'pass_marker': '未发现问题'},
    {'name': 'test6', 'file': 'tests/test6.js', 'kind': 'jsdom', 'desc': '课程区：笔记视图、分类切换、搜索'},
    {'name': 'test7', 'file': 'tests/test7.js', 'kind': 'jsdom', 'desc': '搜索/主题/静态页/SW/RSS'},
    {'name': 'test8', 'file': 'tests/test8.js', 'kind': 'jsdom', 'desc': '编辑器 GitHub Token 存储策略'},
    {'name': 'test9', 'file': 'tests/test9.js', 'kind': 'jsdom', 'desc': 'Batch 1：路由/搜索/懒加载'},
    {'name': 'test10', 'file': 'tests/test10.js', 'kind': 'jsdom', 'desc': 'Batch 2：发布数据完整性'},
    {'name': 'test11', 'file': 'tests/test11.js', 'kind': 'jsdom', 'desc': 'Batch 2：草稿自动保存竞态'},
    {'name': 'test12', 'file': 'tests/test12.py', 'kind': 'python', 'desc': 'Batch 2：代码库描述保护'},
    {'name': 'test13', 'file': 'tests/test13.py', 'kind': 'python', 'desc': 'Batch 3：RSS 结构化解析与产物安全'},
    {'name': 'test14', 'file': 'tests/test14.js', 'kind': 'jsdom', 'desc': 'Batch 3：排序一致性 + 日期时区'},
    {'name': 'test15', 'file': 'tests/test15.py', 'kind': 'python', 'desc': 'Batch 3.5：生成器合成 Fixture 可复现性'},
    {'name': 'test16', 'file': 'tests/test16.js', 'kind': 'jsdom', 'desc': 'B5：Markdown 净化与动态事件编码'},
    {'name': 'test17', 'file': 'tests/test17.py', 'kind': 'python', 'desc': 'B5：静态笔记页 JSON-LD 与正文安全'},
    {'name': 'test18', 'file': 'tests/test18.js', 'kind': 'jsdom',
     'desc': 'B6B2：文章数据拆分完整性（元数据/正文/搜索语料/哈希）'},
    {'name': 'split-check', 'file': 'scripts/split_posts.py', 'kind': 'python',
     'desc': 'B6B2：文章数据产物校验（--check）', 'pass_marker': 'OK:'},
    {'name': 'test19', 'file': 'tests/test19_data_lifecycle.py', 'kind': 'python',
     'desc': 'B6C：文章数据生命周期（改/增/删/改 id/损坏）'},
    {'name': 'test20', 'file': 'tests/test20_publish_search.js', 'kind': 'jsdom',
     'desc': 'B6C：发布与搜索一致性（含按需加载与快速切换）'},
    {'name': 'feed-check', 'file': 'gen_feed.py', 'kind': 'python', 'args': ['--check'],
     'desc': 'B6C：RSS 产物与数据一致（--check）', 'pass_marker': 'OK:'},
    {'name': 'browser', 'file': 'tests/browser/sw.spec.js', 'kind': 'browser',
     'desc': 'B4：真实 Chromium 下的 SW 安装 / 离线 / 更新 / 容量'},
    {'name': 'sw-consistency', 'file': 'tests/browser/sw-consistency.spec.js', 'kind': 'browser',
     'desc': 'B6B1.1：版本一致性 / 慢网 / 离线 / HTTP 错误 / SW 重启'},
    {'name': 'sw-upgrade', 'file': 'tests/browser/sw-upgrade.spec.js', 'kind': 'browser',
     'desc': 'B6C：旧版安装 → 新版部署 / 安装失败回退 / 多标签页 / 混部'},
]

COUNT_RE = re.compile(r'共\s*(\d+)\s*项[，,]\s*PASS\s*(\d+)[，,]\s*FAIL\s*(\d+)')
FAILED_RE = re.compile(r'^FAIL\s+(.*)$', re.M)


def which(cmd):
    return shutil.which(cmd)


def run(cmd, cwd=ROOT, timeout=TIMEOUT, extra_env=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    if extra_env:
        env.update(extra_env)
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env=env, timeout=timeout)
        out, code = (p.stdout or '') + (p.stderr or ''), p.returncode
    except subprocess.TimeoutExpired:
        out, code = 'TIMEOUT after %ds' % timeout, 124
    except OSError as e:
        out, code = 'OSError: %s' % e, 125
    return code, out, time.time() - t0


def collect_files(pattern_dirs, exts):
    files = []
    for d in pattern_dirs:
        base = os.path.join(ROOT, d) if d else ROOT
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if os.path.isfile(os.path.join(base, name)) and name.endswith(exts):
                files.append(os.path.join(base, name))
    return files


def syntax_checks():
    """返回 (ok, details)。语法错误一律算失败。"""
    details = []
    ok = True

    js_files = collect_files(['js', '', 'tests', 'scripts'], '.js')
    for f in js_files:
        if not which('node'):
            return False, ['未找到 node，无法做 JavaScript 语法检查']
        code, out, _ = run(['node', '--check', f])
        rel = os.path.relpath(f, ROOT)
        details.append((rel, code == 0, (out or '').strip().splitlines()[:2]))
        ok = ok and code == 0

    py_files = collect_files(['', 'tests', 'scripts'], '.py')
    for f in py_files:
        rel = os.path.relpath(f, ROOT)
        try:
            with open(f, encoding='utf-8') as fh:
                compile(fh.read(), f, 'exec')
            details.append((rel, True, []))
        except SyntaxError as e:
            details.append((rel, False, ['%s: %s' % (e.__class__.__name__, e)]))
            ok = False
    return ok, details


def check_env(selected):
    """返回 (blocked_reasons, notes)。"""
    blocked, notes = [], []
    kinds = set(t['kind'] for t in selected)
    if 'python' in kinds:
        notes.append('Python %s (%s)' % (sys.version.split()[0], sys.executable))
    if 'jsdom' in kinds:
        if not which('node'):
            blocked.append('未找到 node，可执行 JavaScript 测试无法运行')
        else:
            code, out, _ = run(['node', '--version'])
            notes.append('Node %s (%s)' % (out.strip().lstrip('v'), which('node')))
            code, out, _ = run(['node', '-e', "require.resolve('jsdom')"])
            if code != 0:
                blocked.append('缺少 jsdom 依赖：请在仓库根目录执行 `npm install`')
            else:
                notes.append('jsdom 已就绪')
    if 'browser' in kinds:
        if not which('node'):
            blocked.append('未找到 node，无法运行浏览器测试')
        else:
            code, out, _ = run(['node', '-e', "require.resolve('playwright')"])
            if code != 0:
                blocked.append('缺少 playwright 依赖：请在仓库根目录执行 npm ci')
            else:
                notes.append('playwright 已就绪（浏览器通道: %s）'
                             % os.environ.get('PW_CHANNEL', 'chrome'))
    return blocked, notes


def run_test(t):
    cmd = ([sys.executable] if t['kind'] == 'python' else ['node']) + [t['file']] + list(t.get('args') or [])
    timeout = t.get('timeout') or (BROWSER_TIMEOUT if t['kind'] == 'browser' else TIMEOUT)
    code, out, dur = run(cmd, timeout=timeout)
    # 浏览器用例用退出码 2 表示"环境不可用"，必须显式标记为阻塞而不是失败/通过
    blocked = (t['kind'] == 'browser' and code == 2)
    marker = t.get('pass_marker')
    if blocked:
        ok = False
    elif marker:
        ok = marker in out and code == 0
    else:
        ok = code == 0
    if not ok:
        head = [ln.strip() for ln in out.splitlines() if ln.strip().startswith('FAIL')][:5]
        print('    [FAIL] %s (exit %s) %s' % (t['name'], code, ('; '.join(head))[:400]))
    m = COUNT_RE.search(out)
    counts = None
    if m:
        counts = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    fails = [s.strip() for s in FAILED_RE.findall(out)][:5]
    return {
        'name': t['name'], 'file': t['file'], 'desc': t['desc'], 'ok': ok,
        'blocked': blocked, 'exit': code, 'dur': dur, 'counts': counts, 'fails': fails,
        'tail': '\n'.join(out.strip().splitlines()[-12:]),
    }


def write_report(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = []
    lines.append('# 测试报告')
    lines.append('')
    lines.append('- 时间：%s' % payload['started'])
    lines.append('- 仓库：%s' % ROOT)
    lines.append('- 结论：**%s**' % payload['verdict'])
    lines.append('- 汇总：PASS %d / FAIL %d / SKIP %d / BLOCKED %d'
                 % (payload['pass'], payload['fail'], payload['skip'], len(payload['blocked'])))
    lines.append('')
    if payload['blocked']:
        lines.append('## 阻塞项')
        for b in payload['blocked']:
            lines.append('- %s' % b)
        lines.append('')
    lines.append('## 语法检查')
    lines.append('')
    lines.append('| 文件 | 结果 |')
    lines.append('| --- | --- |')
    for rel, ok, errs in payload['syntax']:
        lines.append('| `%s` | %s |' % (rel, 'OK' if ok else 'FAIL: ' + '; '.join(errs)))
    lines.append('')
    lines.append('## 测试')
    lines.append('')
    lines.append('| 用例 | 说明 | 结果 | 项数 | 耗时 |')
    lines.append('| --- | --- | --- | --- | --- |')
    for r in payload['results']:
        cnt = ('%d/%d PASS, %d FAIL' % (r['counts'][1], r['counts'][0], r['counts'][2])
               if r['counts'] else '—')
        st = 'BLOCKED' if r.get('blocked') else ('PASS' if r['ok'] else 'FAIL')
        lines.append('| `%s` | %s | %s | %s | %.1fs |'
                     % (r['name'], r['desc'], st, cnt, r['dur']))
    lines.append('')
    bad = [r for r in payload['results'] if not r['ok']]
    if bad:
        lines.append('## 失败详情')
        for r in bad:
            lines.append('')
            lines.append('### %s（exit %s）' % (r['name'], r['exit']))
            if r['fails']:
                for f in r['fails']:
                    lines.append('- %s' % f)
            lines.append('')
            lines.append('```')
            lines.append(r['tail'])
            lines.append('```')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description='博客统一测试入口')
    ap.add_argument('--only', nargs='+', help='只跑指定用例（名称或文件名）')
    ap.add_argument('--skip-syntax', action='store_true', help='跳过语法检查')
    ap.add_argument('--report', default=DEFAULT_REPORT, help='报告输出路径')
    ap.add_argument('--json', help='额外输出一份 JSON 结果')
    args = ap.parse_args(argv)

    selected = TESTS
    if args.only:
        want = set(x.lower().replace('.js', '').replace('.py', '') for x in args.only)
        selected = [t for t in TESTS if t['name'].lower() in want]
        missing = want - set(t['name'].lower() for t in TESTS)
        if missing:
            print('未知用例: %s' % ', '.join(sorted(missing)))
            return 2

    started = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    blocked, notes = check_env(selected)
    print('== 环境 ==')
    for n in notes:
        print('  ' + n)
    if blocked:
        for b in blocked:
            print('  [BLOCKED] ' + b)

    syntax = []
    if args.skip_syntax:
        print('\n== 语法检查 == 已跳过')
    else:
        print('\n== 语法检查 ==')
        ok, syntax = syntax_checks()
        for rel, good, errs in syntax:
            print('  %-28s %s' % (rel, 'OK' if good else 'FAIL'))
            for e in errs:
                print('      ' + str(e))

    results = []
    if not blocked:
        print('\n== 测试 ==')
        for t in selected:
            r = run_test(t)
            results.append(r)
            cnt = ''
            if r['counts']:
                cnt = ' (%d/%d)' % (r['counts'][1], r['counts'][0])
            status = 'BLOCK' if r.get('blocked') else ('PASS' if r['ok'] else 'FAIL')
            print('  %-10s %-5s %5.1fs%s  %s'
                  % (r['name'], status, r['dur'], cnt, r['desc']))
            if not r['ok']:
                for f in r['fails']:
                    print('        - ' + f)

    n_blocked_tests = len([r for r in results if r.get('blocked')])
    n_fail = len([r for r in results if not r['ok'] and not r.get('blocked')])
    n_pass = len([r for r in results if r['ok']])
    n_skip = len(selected) - len(results)
    if blocked or n_blocked_tests:
        verdict = 'BLOCKED'
        exit_code = 2
    elif n_fail or (not args.skip_syntax and not all(s[1] for s in syntax)):
        verdict = 'FAIL'
        exit_code = 1
    else:
        verdict = 'PASS'
        exit_code = 0

    print('\n== 汇总 ==')
    print('  PASS %d / FAIL %d / SKIP %d / BLOCKED %d'
          % (n_pass, n_fail, n_skip, len(blocked)))
    print('  结论: %s' % verdict)

    payload = {
        'started': started, 'verdict': verdict, 'pass': n_pass, 'fail': n_fail,
        'skip': n_skip, 'blocked': blocked, 'syntax': syntax, 'results': results,
    }
    write_report(args.report, payload)
    print('  报告: %s' % os.path.relpath(args.report, ROOT))

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print('  JSON: %s' % os.path.relpath(args.json, ROOT))

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
