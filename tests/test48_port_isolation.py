# -*- coding: utf-8 -*-
"""Batch 8E-3B-1: 动态端口 / 显式覆盖 / 端口释放的 fixture 专项。

不启动任何固定端口。fixture 服务器默认 listen(0)，由操作系统分配端口；
TEST_PORT 仅用于显式覆盖与启动失败验证。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node')
FIXTURE = os.path.join(ROOT, 'tests', 'helpers', 'port-fixture-server.js')
TMP = tempfile.mkdtemp(prefix='b8e3b1_port_')
pass_count = [0]
fail_count = [0]


def check(name, cond, extra=None):
    if cond:
        pass_count[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        fail_count[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def http_get(port, path='/'):
    with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=3) as r:
        return r.status, r.read().decode('utf-8', 'replace')


def start(extra_env=None):
    port_file = os.path.join(TMP, 'port-%d.txt' % (len(os.listdir(TMP)) + 1))
    env = dict(os.environ)
    env.pop('TEST_PORT', None)
    env['PORT_FILE'] = port_file
    if extra_env:
        env.update(extra_env)
    p = subprocess.Popen([NODE, FIXTURE], cwd=ROOT, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding='utf-8', errors='replace')
    deadline = time.time() + 5
    while time.time() < deadline:
        if os.path.isfile(port_file):
            with open(port_file, encoding='utf-8') as f:
                lines = f.read().splitlines()
            if len(lines) >= 1 and lines[0].strip().isdigit():
                return p, int(lines[0].strip()), port_file
        if p.poll() is not None:
            out, err = p.communicate()
            raise RuntimeError('fixture exited %s: %s %s' % (p.returncode, out, err))
        time.sleep(0.05)
    p.terminate()
    raise RuntimeError('fixture did not report a port within 5s')


def stop(p):
    if p.poll() is None:
        p.terminate()
    try:
        out, err = p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
    return p.returncode, out, err


def wait_for_exit(p, timeout=3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        code = p.poll()
        if code is not None:
            return code
        time.sleep(0.05)
    return None


def expect_failure(extra_env):
    env = dict(os.environ)
    env.pop('TEST_PORT', None)
    env.update(extra_env)
    p = subprocess.Popen([NODE, FIXTURE], cwd=ROOT, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding='utf-8', errors='replace')
    try:
        out, err = p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
    return p.returncode, out, err


def main():
    if not NODE:
        print('SKIP node not available')
        return 2
    if not os.path.isfile(FIXTURE):
        print('FAIL fixture missing: ' + FIXTURE)
        return 1

    p1 = p2 = p3 = None
    try:
        print('== D1 两个独立实例：OS 动态分配 ==')
        p1, port1, _ = start()
        p2, port2, _ = start()
        check('D1a 两个实例都成功监听', port1 > 0 and port2 > 0, (port1, port2))
        check('D1b 两个实例端口不同', port1 != port2, (port1, port2))
        st1, body1 = http_get(port1)
        st2, body2 = http_get(port2)
        check('D1c 实例 1 返回自身真实端口', st1 == 200 and json.loads(body1)['port'] == port1, body1)
        check('D1d 实例 2 返回自身真实端口', st2 == 200 and json.loads(body2)['port'] == port2, body2)

        print('== D2 正常退出并释放端口 ==')
        st, body = http_get(port1, '/__shutdown')
        check('D2a shutdown 请求成功', st == 200 and body == 'bye', (st, body))
        code = wait_for_exit(p1)
        out = err = ''
        if code is None:
            code, out, err = stop(p1)
        p1 = None
        check('D2b 正常退出码为 0', code == 0, (code, err.strip()[:120]))
        p3, port3, _ = start({'TEST_PORT': str(port1)})
        check('D2c 退出后端口可被重新绑定', port3 == port1, (port1, port3))
        check('D2d 重新绑定后服务可用', http_get(port3)[0] == 200, port3)
        http_get(port3, '/__shutdown')
        stop(p3)
        p3 = None

        print('== D3 显式 TEST_PORT 被占用：启动失败 ==')
        code, out, err = expect_failure({'TEST_PORT': str(port2)})
        check('D3a 被占用时非 0 退出', code != 0, code)
        check('D3b 错误信息包含 EADDRINUSE', 'EADDRINUSE' in (err or ''), (err or '').strip()[:160])

        print('== D4 非法 TEST_PORT：快速失败 ==')
        code, out, err = expect_failure({'TEST_PORT': 'not-a-port'})
        check('D4a 非法覆盖值非 0 退出', code != 0, code)
        check('D4b 错误信息指出 TEST_PORT', 'TEST_PORT' in (err or ''), (err or '').strip()[:160])
    finally:
        for p in (p1, p2, p3):
            if p is not None:
                stop(p)

    print('\n共 %d 项，PASS %d，FAIL %d' % (pass_count[0] + fail_count[0], pass_count[0], fail_count[0]))
    return 0 if fail_count[0] == 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
