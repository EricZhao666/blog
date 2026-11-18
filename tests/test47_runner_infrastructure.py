#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 8E-3A：scripts/run_tests.py 运行器级回归（不启动真实 Chromium）。

覆盖：
- --only 的注册名 / 文件名 / 相对路径匹配；
- 套件退出码 2 → BLOCKED 进入汇总与 JSON；
- 失败、超时、环境缺失的退出码契约；
- 超时终止进程树（含孙进程）；
- KeyboardInterrupt 路径清理（模拟 Popen）；
- node 缺失时 syntax_checks 结构一致（三态，不崩溃）；
- 报告接受 SKIP 语法项；
- 分组选择与 --list-groups；
- 进度输出（序号/总数/耗时）与耗时字段（wall/by_kind/slowest）。
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER_PATH = os.path.join(ROOT, 'scripts', 'run_tests.py')

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('PASS ' + name + ('' if extra is None else '  (' + str(extra)[:200] + ')'))
    else:
        FAIL += 1
        FAILURES.append(name)
        print('FAIL ' + name + ('' if extra is None else '  (' + str(extra)[:200] + ')'))


def load_runner():
    spec = importlib.util.spec_from_file_location('run_tests_under_test', RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_script(dirpath, name, body):
    filepath = os.path.join(dirpath, name)
    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    return filepath


def pid_alive(pid):
    if os.name == 'nt':
        out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
                             capture_output=True, text=True, errors='replace').stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def run_main(mod, args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = mod.main(args)
    return code, buf.getvalue()


def make_fakes(mod):
    tmp = tempfile.mkdtemp(prefix='b8e3a_runner_')
    normal = write_script(tmp, 'fake_normal.py',
                          "print('共 3 项，PASS 3，FAIL 0')\n")
    failing = write_script(tmp, 'fake_fail.py',
                           "import sys\nprint('共 2 项，PASS 1，FAIL 1')\nprint('FAIL demo')\nsys.exit(1)\n")
    blocked = write_script(tmp, 'fake_blocked.py',
                           "import sys\nprint('环境不可用')\nsys.exit(2)\n")
    slow = write_script(tmp, 'fake_slow.py',
                        "import time\ntime.sleep(30)\n")
    tree = write_script(tmp, 'fake_tree.py', (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-u', '-c', 'import time; time.sleep(60)'])\n"
        "open(os.environ['B8E3A_CHILD_PID'], 'w').write(str(child.pid))\n"
        "time.sleep(30)\n"
    ))
    mod.TESTS = [
        {'name': 'fake-normal', 'file': normal, 'kind': 'python', 'desc': '正常 fixture'},
        {'name': 'fake-fail', 'file': failing, 'kind': 'python', 'desc': '失败 fixture'},
        {'name': 'fake-blocked', 'file': blocked, 'kind': 'python', 'desc': '阻塞 fixture'},
        {'name': 'fake-timeout', 'file': slow, 'kind': 'python', 'desc': '超时 fixture', 'timeout': 2},
        {'name': 'fake-tree', 'file': tree, 'kind': 'python', 'desc': '进程树 fixture', 'timeout': 2},
    ]
    return tmp


def main():
    real = load_runner()
    all_names = {t['name'] for t in real.TESTS}

    # G：分组选择
    full, _ = real.select_tests(None, 'full')
    check('G1 full 分组 = 全部注册套件', len(full) == len(real.TESTS),
          '%d/%d' % (len(full), len(real.TESTS)))
    smoke, _ = real.select_tests(None, 'smoke')
    check('G2 smoke 为子集且注册名有效',
          bool(smoke) and all(t['name'] in all_names for t in smoke),
          ','.join(t['name'] for t in smoke))
    sel_file, _ = real.select_tests(['test9.js'])
    check('G3 --only 支持文件名（可省扩展名）', [t['name'] for t in sel_file] == ['test9'],
          [t['name'] for t in sel_file])

    mod = real
    tmp = make_fakes(mod)
    rep = os.path.join(tmp, 'report.md')
    js = os.path.join(tmp, 'result.json')

    # R1 正常路径 + 进度输出
    code, out = run_main(mod, ['--only', 'fake-normal', '--skip-syntax',
                               '--report', rep, '--json', js])
    check('R1 正常套件 exit 0 / PASS 统计', code == 0 and 'PASS 1 / FAIL 0' in out,
          'exit=%s' % code)
    check('R2 进度输出含序号与总数', '[1/1]' in out and '开始' in out, out.strip().splitlines()[-1][:80])
    payload = json.load(open(js, encoding='utf-8'))
    check('R3 JSON 保留旧字段并新增耗时字段',
          all(k in payload for k in ('started', 'verdict', 'pass', 'fail', 'skip', 'blocked',
                                     'syntax', 'results', 'wall_seconds', 'by_kind',
                                     'slowest', 'timeouts', 'blocked_tests')),
          sorted(payload.keys()))
    check('R4 wall/by_kind/slowest 统计有效',
          payload['wall_seconds'] > 0 and payload['by_kind'].get('python', 0) > 0
          and payload['slowest'][0]['name'] == 'fake-normal',
          payload.get('wall_seconds'))

    # R5 文件名匹配
    code, out = run_main(mod, ['--only', 'fake-normal.py', '--skip-syntax',
                               '--report', rep, '--json', js])
    check('R5 --only 文件名（带 .py）可匹配', code == 0 and 'PASS 1' in out, 'exit=%s' % code)

    # R6 未知用例
    code, out = run_main(mod, ['--only', 'does-not-exist', '--skip-syntax', '--report', rep])
    check('R6 未知用例 exit 2 且提示', code == 2 and '未知用例' in out, 'exit=%s' % code)

    # R7 退出码 2 → BLOCKED 进入汇总
    code, out = run_main(mod, ['--only', 'fake-blocked', '--skip-syntax',
                               '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('R7 套件级 BLOCKED 进入汇总', code == 2 and 'BLOCKED 1' in out
          and payload['verdict'] == 'BLOCKED' and payload['blocked_tests']
          and payload['blocked_tests'][0]['name'] == 'fake-blocked',
          'exit=%s blocked=%s' % (code, payload.get('blocked_total')))

    # R8 失败路径
    code, out = run_main(mod, ['--only', 'fake-fail', '--skip-syntax',
                               '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('R8 失败套件 exit 1 / FAIL 统计', code == 1 and payload['fail'] == 1
          and payload['verdict'] == 'FAIL', 'exit=%s' % code)

    # R9 超时路径
    code, out = run_main(mod, ['--only', 'fake-timeout', '--skip-syntax',
                               '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('R9 超时 exit 1 且记录原因', code == 1 and payload['timeouts']
          and 'timeout' in payload['timeouts'][0]['reason'],
          payload.get('timeouts'))

    # R10 超时清理孙进程
    pidfile = os.path.join(tmp, 'child.pid')
    os.environ['B8E3A_CHILD_PID'] = pidfile
    try:
        code, out = run_main(mod, ['--only', 'fake-tree', '--skip-syntax',
                                   '--report', rep, '--json', js])
        time.sleep(0.5)
        child_alive = False
        if os.path.exists(pidfile):
            try:
                child_alive = pid_alive(int(open(pidfile).read().strip()))
            except Exception:
                child_alive = False
        check('R10 超时后孙进程已被清理', code == 1 and not child_alive,
              'pidfile=%s alive=%s' % (os.path.exists(pidfile), child_alive))
    finally:
        os.environ.pop('B8E3A_CHILD_PID', None)

    # R11 KeyboardInterrupt 路径调用清理
    orig_popen, orig_term = mod.subprocess.Popen, mod._terminate_tree
    calls = {'n': 0}

    class FakeProc(object):
        pid = 999999

        def communicate(self, timeout=None):
            raise KeyboardInterrupt

        def poll(self):
            return None

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

    def fake_term(proc):
        calls['n'] += 1
        return True

    mod.subprocess.Popen = lambda *a, **k: FakeProc()
    mod._terminate_tree = fake_term
    raised = False
    try:
        mod.run(['fake'], timeout=1, label='fake-interrupt')
    except KeyboardInterrupt:
        raised = True
    finally:
        mod.subprocess.Popen, mod._terminate_tree = orig_popen, orig_term
    check('R11 中断路径终止进程树并向上抛出', raised and calls['n'] == 1, calls['n'])

    # R12 node 缺失时 syntax_checks 结构一致
    orig_which = mod.which
    mod.which = lambda cmd: None
    try:
        ok, details = mod.syntax_checks()
        shape_ok = all(isinstance(d, tuple) and len(d) == 3 for d in details)
        js_skips = [d for d in details if d[0].endswith('.js') and d[1] is None]
        check('R12 node 缺失时语法项为三态结构（SKIP）', shape_ok and js_skips,
              '%d details / %d JS SKIP' % (len(details), len(js_skips)))
    finally:
        mod.which = orig_which

    # R13 报告接受 SKIP 语法项
    skip_report = os.path.join(tmp, 'skip-report.md')
    mod.write_report(skip_report, {
        'started': '2026-11-18 15:00:00', 'verdict': 'PASS', 'pass': 0, 'fail': 0,
        'skip': 1, 'blocked': [], 'blocked_total': 0, 'blocked_tests': [],
        'syntax': [('x.js', None, ['SKIP: node missing'])], 'results': [],
        'wall_seconds': 1.0, 'env_seconds': 0.1, 'syntax_seconds': 0.2,
        'by_kind': {}, 'slowest': [], 'timeouts': [], 'group': 'full',
    })
    text = open(skip_report, encoding='utf-8').read()
    check('R13 报告包含 SKIP 且不崩溃', '| `x.js` | SKIP |' in text, 'SKIP' in text)

    # R14 环境缺失（check_env blocked）时 SKIP 全部套件
    orig_env = mod.check_env
    mod.check_env = lambda selected: (['缺少 node / jsdom'], [])
    try:
        code, out = run_main(mod, ['--only', 'fake-normal', '--skip-syntax',
                                   '--report', rep, '--json', js])
        payload = json.load(open(js, encoding='utf-8'))
        check('R14 环境阻塞 exit 2 且 SKIP = 套件数', code == 2 and payload['skip'] == 1
              and payload['verdict'] == 'BLOCKED', 'skip=%s' % payload.get('skip'))
    finally:
        mod.check_env = orig_env

    # R15 --list-groups
    code, out = run_main(mod, ['--list-groups'])
    check('R15 --list-groups 输出分组', code == 0 and 'full' in out and 'smoke' in out,
          out.splitlines()[:2])

    print('\n共 %d 项，PASS %d，FAIL %d' % (PASS + FAIL, PASS, FAIL))
    if FAILURES:
        print('失败项：' + ' / '.join(FAILURES))
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
