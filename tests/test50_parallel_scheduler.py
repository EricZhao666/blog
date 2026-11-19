#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Batch 8E-3B-2：可选的 2-worker 安全调度器专项（轻量 fixture，不启动 Chromium）。

覆盖调度计划、真实双进程重叠、独占串行屏障、--only/--group、失败/阻塞/超时
聚合、超时进程树、主线程中断清理、非法 workers 和显式端口环境回退。
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
        print('PASS ' + name + ('' if extra is None else '  (' + str(extra)[:240] + ')'))
    else:
        FAIL += 1
        FAILURES.append(name)
        print('FAIL ' + name + ('' if extra is None else '  (' + str(extra)[:240] + ')'))


def load_runner():
    spec = importlib.util.spec_from_file_location('run_tests_under_test', RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_script(dirpath, name, body):
    path = os.path.join(dirpath, name)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    return path


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


def read_pid(path, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read().strip()
            if text:
                return int(text)
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    return None


def make_fakes(mod, tmp):
    def sleeper(name, seconds, exit_code=0, fail_line=False, kind='python'):
        body = (
            "import sys, time\n"
            "time.sleep(%s)\n"
            "print('共 3 项，PASS 3，FAIL 0')\n"
            % seconds
        )
        if fail_line:
            body = (
                "import sys, time\n"
                "time.sleep(%s)\n"
                "print('共 2 项，PASS 1，FAIL 1')\n"
                "print('FAIL demo')\n"
                "sys.exit(%s)\n"
                % (seconds, exit_code)
            )
        elif exit_code:
            body = (
                "import sys, time\n"
                "time.sleep(%s)\n"
                "print('环境不可用')\n"
                "sys.exit(%s)\n"
                % (seconds, exit_code)
            )
        return write_script(tmp, name + '.py', body)

    a = sleeper('fake_a', 0.9)
    b = sleeper('fake_b', 0.35)
    c = sleeper('fake_c', 0.35)
    d = sleeper('fake_d', 0.35)
    failing = sleeper('fake_fail', 0.35, exit_code=1, fail_line=True)
    blocked = sleeper('fake_blocked', 0.35, exit_code=2)
    timeout = write_script(tmp, 'fake_timeout.py',
                           "import time\ntime.sleep(30)\n")

    def tree(name, env_name):
        return write_script(tmp, name + '.py', (
            "import os, subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-u', '-c', "
            "'import time; time.sleep(60)'])\n"
            "open(os.environ[%r], 'w').write(str(child.pid))\n"
            "time.sleep(30)\n" % env_name
        ))

    tree_a = tree('fake_tree_a', 'B8E3B2_CHILD_A')
    tree_b = tree('fake_tree_b', 'B8E3B2_CHILD_B')

    tests = [
        {'name': 'fake-a', 'file': a, 'kind': 'python', 'desc': 'sleep 0.9'},
        {'name': 'fake-fail', 'file': failing, 'kind': 'python', 'desc': 'failure fixture'},
        {'name': 'fake-blocked', 'file': blocked, 'kind': 'python', 'desc': 'blocked fixture'},
        {'name': 'fake-timeout', 'file': timeout, 'kind': 'python',
         'desc': 'timeout fixture', 'timeout': 2},
        {'name': 'fake-tree-a', 'file': tree_a, 'kind': 'python',
         'desc': 'tree fixture a', 'timeout': 2},
        {'name': 'fake-b', 'file': b, 'kind': 'python', 'desc': 'sleep 0.35'},
        {'name': 'fake-tree-b', 'file': tree_b, 'kind': 'python',
         'desc': 'tree fixture b', 'timeout': 2},
        {'name': 'fake-c', 'file': c, 'kind': 'python', 'desc': 'unverified c'},
        {'name': 'fake-d', 'file': d, 'kind': 'python', 'desc': 'unverified d'},
        {'name': 'fake-browser', 'file': a, 'kind': 'browser', 'desc': 'exclusive browser-like'},
    ]
    return tests


def main():
    mod = load_runner()
    tmp = tempfile.mkdtemp(prefix='b8e3b2_sched_')
    mod.TESTS = make_fakes(mod, tmp)
    mod.GROUPS['fakegroup'] = ['fake-a', 'fake-b', 'fake-c', 'fake-d']

    # 仅测试专用许可；生产许可仍只来自已实测配对。
    for pair in (('fake-a', 'fake-b'), ('fake-fail', 'fake-b'),
                 ('fake-timeout', 'fake-b'), ('fake-tree-a', 'fake-tree-b')):
        mod.PAIR_LICENSES[frozenset(pair)] = {'evidence': 'test50 synthetic fixture'}

    selected, _ = mod.select_tests(['fake-a', 'fake-b'], 'full')
    jobs, pairs, serial, _ = mod.plan_execution(selected, 2)
    check('P1 精确配对进入并行单元',
          len(jobs) == 1 and jobs[0]['mode'] == 'parallel'
          and pairs == ['fake-a+fake-b'], jobs)

    selected2, _ = mod.select_tests(['fake-a', 'fake-b', 'fake-c'], 'full')
    jobs2, pairs2, serial2, _ = mod.plan_execution(selected2, 2)
    check('P2 配对后接未验证套件：一个并行单元 + 一个串行单元',
          [j['mode'] for j in jobs2] == ['parallel', 'serial']
          and serial2 == ['fake-c'], [j['mode'] for j in jobs2])

    selected3, _ = mod.select_tests(['fake-a', 'fake-browser'], 'full')
    jobs3, pairs3, serial3, _ = mod.plan_execution(selected3, 2)
    check('P3 浏览器套件独占串行，不进入并行单元',
          [j['mode'] for j in jobs3] == ['serial', 'serial']
          and pairs3 == [], serial3)

    # 默认串行兼容
    rep = os.path.join(tmp, 'report.md')
    js = os.path.join(tmp, 'result.json')
    code, out = run_main(mod, ['--only', 'fake-a', 'fake-b', '--skip-syntax',
                               '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('P4 默认 workers=1 保留串行行为',
          code == 0 and 'PASS 2 / FAIL 0' in out
          and payload['requested_workers'] == 1
          and payload['parallel_pairs'] == [] and payload['effective_workers'] == 1,
          'exit=%s' % code)

    # 真实双进程重叠
    code, out = run_main(mod, ['--only', 'fake-a', 'fake-b', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    intervals = {x['name']: x for x in payload['parallel_intervals']}
    overlap = (min(intervals['fake-a']['end'], intervals['fake-b']['end'])
               - max(intervals['fake-a']['start'], intervals['fake-b']['start']))
    check('P5 workers=2 实际启动两个安全任务',
          code == 0 and payload['parallel_pairs'] == ['fake-a+fake-b']
          and payload['peak_active_suites'] == 2
          and payload['effective_workers'] == 2,
          'pairs=%s' % payload['parallel_pairs'])
    check('P6 两个套件产生真实时间重叠',
          overlap > 0.15 and payload['summed_suite_seconds'] > payload['test_wall_seconds'],
          'overlap=%.2f sum=%.2f wall=%.2f' % (overlap,
                                              payload['summed_suite_seconds'],
                                              payload['test_wall_seconds']))
    check('P7 结果按注册顺序，不按完成顺序',
          [r['name'] for r in payload['results']] == ['fake-a', 'fake-b']
          and set(payload['suite_execution_order']) == {'fake-a', 'fake-b'},
          [r['name'] for r in payload['results']])
    check('P8 每个套件恰好执行一次且无残留活动进程',
          len(payload['results']) == 2 and len({r['name'] for r in payload['results']}) == 2
          and not mod._ACTIVE_PROCS,
          mod._ACTIVE_PROCS)

    # --group 选择
    code, out = run_main(mod, ['--group', 'fakegroup', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('P9 --group 选择正确，配对的 a+b 与串行 c/d 均只执行一次',
          code == 0 and [r['name'] for r in payload['results']] ==
          ['fake-a', 'fake-b', 'fake-c', 'fake-d']
          and payload['parallel_pairs'] == ['fake-a+fake-b']
          and set(payload['suite_execution_order']) ==
          {'fake-a', 'fake-b', 'fake-c', 'fake-d'}, payload['suite_execution_order'])

    # 未验证组合必须串行
    code, out = run_main(mod, ['--only', 'fake-c', 'fake-d', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('P10 未验证组合不得并行',
          code == 0 and payload['parallel_pairs'] == []
          and payload['effective_workers'] == 1
          and payload['suite_execution_order'] == ['fake-c', 'fake-d'],
          payload.get('serial_fallback_reasons'))

    # 失败不遗漏后续；配对内部失败也继续
    code, out = run_main(mod, ['--only', 'fake-fail', 'fake-b', 'fake-c', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    names = [r['name'] for r in payload['results']]
    check('P11 单任务失败不遗漏剩余任务',
          code == 1 and payload['fail'] == 1 and names == ['fake-fail', 'fake-b', 'fake-c']
          and payload['results'][2]['ok'] is True, 'exit=%s' % code)

    # BLOCKED 汇总
    code, out = run_main(mod, ['--only', 'fake-blocked', 'fake-b', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    check('P12 BLOCKED 与并行结果同时进入汇总',
          code == 2 and payload['blocked_total'] == 1 and payload['pass'] == 1
          and payload['verdict'] == 'BLOCKED', payload.get('blocked_tests'))

    # 超时只清理对应任务，另一个结果保留
    code, out = run_main(mod, ['--only', 'fake-timeout', 'fake-b', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    payload = json.load(open(js, encoding='utf-8'))
    by_name = {r['name']: r for r in payload['results']}
    check('P13 超时任务 exit 124，另一个任务结果不丢失',
          code == 1 and by_name['fake-timeout']['timeout'] is True
          and by_name['fake-b']['ok'] is True and payload['timeouts'],
          payload.get('timeouts'))

    # 两个并行任务都产生孙进程，超时后两个进程树均清理
    pid_a = os.path.join(tmp, 'child_a.pid')
    pid_b = os.path.join(tmp, 'child_b.pid')
    os.environ['B8E3B2_CHILD_A'] = pid_a
    os.environ['B8E3B2_CHILD_B'] = pid_b
    code, out = run_main(mod, ['--only', 'fake-tree-a', 'fake-tree-b', '--workers', '2',
                               '--skip-syntax', '--report', rep, '--json', js])
    ca = read_pid(pid_a)
    cb = read_pid(pid_b)
    time.sleep(0.2)
    check('P14 并行超时清理两个孙进程',
          code == 1 and ca and cb and not pid_alive(ca) and not pid_alive(cb),
          'child_a=%s alive=%s child_b=%s alive=%s'
          % (ca, pid_alive(ca) if ca else None, cb, pid_alive(cb) if cb else None))
    check('P15 超时清理后无本运行器活动进程',
          not mod._ACTIVE_PROCS, list(mod._ACTIVE_PROCS))

    # 主线程中断：启动两个真实进程树后抛 KeyboardInterrupt，验证活动表清理
    old_run_test = mod.run_test
    interrupt_pids = []

    def interrupt_run_test(t, log_prefix=''):
        # 模拟主线程中断时同时仍有两个本任务进程树在运行；只启动一次。
        if not interrupt_pids:
            scripts = [('fake-tree-a', os.path.join(tmp, 'fake_tree_a.py'), 'B8E3B2_CHILD_A'),
                       ('fake-tree-b', os.path.join(tmp, 'fake_tree_b.py'), 'B8E3B2_CHILD_B')]
            for name, script, env_name in scripts:
                env = dict(os.environ, **{env_name: os.path.join(tmp, name + '.pid')})
                popen_kwargs = {'env': env}
                if os.name == 'nt':
                    popen_kwargs['creationflags'] = getattr(
                        subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
                else:
                    popen_kwargs['start_new_session'] = True
                proc = subprocess.Popen([sys.executable, script], **popen_kwargs)
                mod._register_proc(proc)
                interrupt_pids.append(proc)
            # 等待两个 fixture 都完成孙进程创建，确保中断时确有两条活动进程树。
            path_a = os.path.join(tmp, 'fake-tree-a.pid')
            path_b = os.path.join(tmp, 'fake-tree-b.pid')
            end = time.monotonic() + 3.0
            while time.monotonic() < end and not (os.path.exists(path_a) and os.path.exists(path_b)):
                time.sleep(0.05)
        time.sleep(0.1)
        raise KeyboardInterrupt()

    mod.run_test = interrupt_run_test
    try:
        selected_int, _ = mod.select_tests(['fake-tree-a', 'fake-tree-b'], 'full')
        jobs_int, _, _, _ = mod.plan_execution(selected_int, 1)
        results_int, meta_int = mod.execute_jobs(jobs_int, 2, selected_int)
    finally:
        mod.run_test = old_run_test
    child_int_a = read_pid(os.path.join(tmp, 'fake-tree-a.pid'))
    child_int_b = read_pid(os.path.join(tmp, 'fake-tree-b.pid'))
    time.sleep(0.2)
    interrupt_detail = {
        'polls': [p.poll() for p in interrupt_pids],
        'pids': [p.pid for p in interrupt_pids],
        'child_a': child_int_a, 'child_a_alive': pid_alive(child_int_a) if child_int_a else None,
        'child_b': child_int_b, 'child_b_alive': pid_alive(child_int_b) if child_int_b else None,
        'active': list(mod._ACTIVE_PROCS),
    }
    check('P16 主线程中断返回可识别结果并清理全部活动进程树',
          meta_int.get('interrupted') is True
          and all(r['exit'] == 130 for r in results_int)
          and not any(p.poll() is None for p in interrupt_pids)
          and child_int_a and child_int_b
          and not pid_alive(child_int_a) and not pid_alive(child_int_b),
          interrupt_detail)

    # 显式端口环境变量安全回退
    old_port = os.environ.get('TEST_PORT')
    os.environ['TEST_PORT'] = '65531'
    try:
        selected_port, _ = mod.select_tests(['fake-a', 'fake-b'], 'full')
        jobs_port, pairs_port, _, reasons_port = mod.plan_execution(selected_port, 2)
        check('P17 显式 TEST_PORT 禁止配对并安全回退',
              all(j['mode'] == 'serial' for j in jobs_port) and pairs_port == []
              and any('port_env_explicit' in x for x in reasons_port),
              reasons_port)
    finally:
        if old_port is None:
            os.environ.pop('TEST_PORT', None)
        else:
            os.environ['TEST_PORT'] = old_port

    # 非法 workers
    for value in ('0', '3', 'abc'):
        try:
            run_main(mod, ['--only', 'fake-a', '--workers', value, '--skip-syntax',
                           '--report', rep])
            bad_exit = 0
        except SystemExit as e:
            bad_exit = e.code
        check('P18 非法 workers=%s 被拒绝' % value, bad_exit == 2, bad_exit)

    print('')
    print('共 %d 项，PASS %d，FAIL %d' % (PASS + FAIL, PASS, FAIL))
    if FAIL:
        print('FAILURES: ' + ', '.join(FAILURES))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
