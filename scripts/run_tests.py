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
import signal
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REPORT = os.path.join(ROOT, 'tests', 'reports', 'last-run.md')
TIMEOUT = 240
# 浏览器套件（真实 Chromium + 本地服务器）在 2 核 CI 上耗时远高于开发机：
# 本机 sw-consistency 约 90 s，负载高时可到 260 s，因此单独放宽而不是压缩用例。
BROWSER_TIMEOUT = 600
HEARTBEAT_SECONDS = 30      # 长套件低频心跳：只在超过 30s 后每 30s 一行

# 开发辅助分组：用于局部调试，**不代表发布验收**。
# 发布/CI 默认仍是 full（不传 --group 即 full），避免把快速测试当成全量门禁。
GROUPS = {
    'smoke': [
        'audit', 'test6', 'test7', 'test9', 'test18', 'inline-handlers',
        'image-check', 'content-check', 'feed-check',
    ],
    'editor': [
        'test8', 'test10', 'test11', 'test24', 'test32', 'test35',
        'test36', 'test37', 'test38', 'editor-ux', 'editor-history',
    ],
    'search': [
        'test7', 'test20', 'test39', 'test40', 'test41', 'test42',
        'search-ux', 'search-interaction',
    ],
    'content': [
        'test12', 'test13', 'test14', 'test15', 'test17', 'test19',
        'test21', 'test22', 'test23', 'test25', 'test26', 'test27',
        'test28', 'test29', 'test30', 'test31', 'test33', 'test34',
        'test45', 'split-check', 'image-check', 'content-check', 'feed-check',
    ],
    'sw': ['test7', 'browser', 'sw-consistency', 'sw-upgrade'],
    'browser': [
        'browser', 'sw-consistency', 'sw-upgrade', 'mobile-notes', 'course-seo',
        'papers-deeplink', 'editor-ux', 'editor-history', 'search-ux',
        'search-interaction', 'reading-experience', 'image-lightbox',
        'ui-refresh', 'performance-accessibility',
    ],
    'full': [],
}

# ---------------------------------------------------------------- 测试清单
# kind: 'jsdom' 需要 node + jsdom；'python' 需要 python
TESTS = [
    {'name': 'audit', 'file': 'tests/audit.js', 'kind': 'jsdom',
     'desc': '全站巡检：路由渲染、死链、静态页一致性、404 资源',
     'pass_marker': '未发现问题'},
    {'name': 'test6', 'file': 'tests/test6.js', 'kind': 'jsdom', 'desc': '课程区：笔记视图、分类切换、搜索'},
    {'name': 'test7', 'file': 'tests/test7.js', 'kind': 'jsdom', 'desc': '搜索/主题/静态页/SW/RSS'},
    {'name': 'test8', 'file': 'tests/test8.js', 'kind': 'jsdom',
     'desc': 'B8A：编辑器不再收藏 Token（旧 Token 可一键清除）'},
    {'name': 'test9', 'file': 'tests/test9.js', 'kind': 'jsdom', 'desc': 'Batch 1：路由/搜索/懒加载'},
    {'name': 'test10', 'file': 'tests/test10.js', 'kind': 'jsdom',
     'desc': 'B8A：导出不联网/不写历史，失败保留草稿'},
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
    {'name': 'test21', 'file': 'tests/test21_papers_id_registry.py', 'kind': 'python',
     'desc': 'B7B2：学习资料持久 ID Registry 生命周期（重排/删除/改名/迁移/损坏/冲突）'},
    {'name': 'test22', 'file': 'tests/test22_registry_consistency.py', 'kind': 'python',
     'desc': 'B7B2.1：真实 Registry 与 js/papers.js 一致性（74 条 / 无私人路径）'},
    {'name': 'test23', 'file': 'tests/test23_content_build.py', 'kind': 'python',
     'desc': 'B7C2：统一内容构建生命周期（增删改/重复 ID/并发/原子性/兼容）'},
    # 旧队列契约已退役（Batch 8A），本用例改为验证"直写队列的入口确实不存在"
    {'name': 'test24', 'file': 'tests/test24_publish_queue.js', 'kind': 'jsdom',
     'desc': 'B8A：发布队列入口下线（编辑器零网络/零队列/零 Token）'},
    {'name': 'test25', 'file': 'tests/test25_release_pipeline.py', 'kind': 'python',
     'desc': 'B7C3A：发布候选闸门（隔离重建 / 过期产物 / 失败即无标记）'},
    {'name': 'test26', 'file': 'tests/test26_queue_processor.py', 'kind': 'python',
     'desc': 'B7C3B：内容队列消费（schema/幂等/增删改/陈旧/失败恢复）'},
    {'name': 'test27', 'file': 'tests/test27_content_workflow.py', 'kind': 'python',
     'desc': 'B7C3B：候选 PR 与工作流契约（权限/复用/过期/完整性）'},
    {'name': 'test28', 'file': 'tests/test28_candidate_state.py', 'kind': 'python',
     'desc': 'B7C3B.1：候选状态机（candidate/merge/deploy 分离、幂等、过期、失败恢复）'},
    {'name': 'test29', 'file': 'tests/test29_workflow_activation.py', 'kind': 'python',
     'desc': 'B7C4A：发布工作流启用契约（默认只读/最小权限/不合并/队列缺失降级）'},
    {'name': 'test30', 'file': 'tests/test30_workflow_gating.py', 'kind': 'python',
     'desc': 'B7C4A.1：写入门控组合（dry_run×allow_write×仓库变量）+ 候选目录回归'},
    {'name': 'test31', 'file': 'tests/test31_gate_contract.py', 'kind': 'python',
     'desc': 'B7C4B：门禁触发契约（无 paths 过滤/内部判定/候选 commit status/最小权限）'},
    {'name': 'test32', 'file': 'tests/test32_editor_export.js', 'kind': 'jsdom',
     'desc': 'B8A：编辑器导出契约（UTF-8/代码块/特殊字符/空正文/重复 ID）'},
    {'name': 'test33', 'file': 'tests/test33_import_post.py', 'kind': 'python',
     'desc': 'B8A：本地导入器（冲突/恶意路径/中断回滚/一致性/RSS/搜索索引）'},
    {'name': 'test34', 'file': 'tests/test34_post_update.py', 'kind': 'python',
     'desc': 'B8B1：已有文章更新（版本校验/锁定/回滚/id 不变/其他文章不变）'},
    {'name': 'test35', 'file': 'tests/test35_editor_update.js', 'kind': 'jsdom',
     'desc': 'B8B1：编辑器编辑模式（回填/固定 id/更新稿/草稿隔离/前进后退）'},
    {'name': 'test36', 'file': 'tests/test36_editor_toolbar.js', 'kind': 'jsdom',
     'desc': 'B8B2：Markdown 工具栏 / 快捷键 / 原生撤销 / 状态栏'},
    {'name': 'test37', 'file': 'tests/test37_editor_images.js', 'kind': 'jsdom',
     'desc': 'B8B2：图片插入与预览（协议白名单/本地文件/仅预览提示/净化）'},
    {'name': 'test38', 'file': 'tests/test38_draft_history.js', 'kind': 'jsdom',
     'desc': 'B8B3：草稿历史（快照/去重/节流/隔离/配额/损坏/安全恢复）'},
    {'name': 'test39', 'file': 'tests/test39_search_ranking.js', 'kind': 'jsdom',
     'desc': 'B8C1：统一结果模型 / 相关性评分 / 中文混合 / XSS / 稳定深链'},
    {'name': 'test40', 'file': 'tests/test40_search_sources.js', 'kind': 'jsdom',
     'desc': 'B8C1：多数据源按需加载 / 失败恢复 / 竞态 / IME / 历史恢复'},
    {'name': 'test41', 'file': 'tests/test41_search_filters.js', 'kind': 'jsdom',
     'desc': 'B8C2：分类筛选 / 排序 / 折叠 / 键盘导航 / 安全与稳定深链'},
    {'name': 'test42', 'file': 'tests/test42_search_history.js', 'kind': 'jsdom',
     'desc': 'B8C2：最近搜索历史 / localStorage 降级 / 竞态 / 部分失败'},
    {'name': 'test43', 'file': 'tests/test43_reading_tools.js', 'kind': 'jsdom',
     'desc': 'B8D1：目录 / 正文阅读进度 / 代码复制降级 / 表格局部滚动'},
    {'name': 'test44', 'file': 'tests/test44_image_lightbox.js', 'kind': 'jsdom',
     'desc': 'B8D2A：图片放大 / 说明 / 焦点恢复 / 安全协议 / 路由清理'},
    {'name': 'test45', 'file': 'tests/test45_image_assets.py', 'kind': 'python',
     'desc': 'B8D2B：图片资源存在性 / 路径安全 / 大小写 / Pages 子路径'},
    {'name': 'inline-handlers', 'file': 'tests/test46_inline_handlers.js', 'kind': 'jsdom',
     'desc': 'B8E2：inline 事件编码（单引号/双引号/百分号/空格标签 chip 导航与还原、卡片导航不变、handler 可编译）'},
    {'name': 'runner-infrastructure', 'file': 'tests/test47_runner_infrastructure.py', 'kind': 'python',
     'desc': 'B8E3A：测试运行器（选择/BLOCKED 汇总/超时进程树/中断清理/耗时报告）'},
    {'name': 'port-isolation', 'file': 'tests/test48_port_isolation.py', 'kind': 'python',
     'desc': 'B8E3B1：动态端口分配 / TEST_PORT 覆盖 / 端口释放与启动失败'},
    {'name': 'build-lock', 'file': 'tests/test49_content_build_lock.py', 'kind': 'python',
     'desc': 'B8E3BR：构建锁覆盖完整 sync 临界区 / replace 失败临时文件清理 / 只读契约 / 锁超时'},
    {'name': 'image-check', 'file': 'scripts/check_images.py', 'kind': 'python', 'args': ['--check'],
     'desc': 'B8D2B：发布前图片资源门禁（缺失图片必须失败，不允许降级为 SKIP/WARNING）',
     'pass_marker': 'OK:'},
    {'name': 'content-check', 'file': 'scripts/build_content.py', 'kind': 'python', 'args': ['--check'],
     'desc': 'B7C2：发布前内容一致性门禁（元数据/正文/搜索语料/清单/RSS）',
     'pass_marker': 'OK:'},
    {'name': 'feed-check', 'file': 'gen_feed.py', 'kind': 'python', 'args': ['--check'],
     'desc': 'B6C：RSS 产物与数据一致（--check）', 'pass_marker': 'OK:'},
    {'name': 'browser', 'file': 'tests/browser/sw.spec.js', 'kind': 'browser',
     'desc': 'B4：真实 Chromium 下的 SW 安装 / 离线 / 更新 / 容量'},
    {'name': 'sw-consistency', 'file': 'tests/browser/sw-consistency.spec.js', 'kind': 'browser',
     'desc': 'B6B1.1：版本一致性 / 慢网 / 离线 / HTTP 错误 / SW 重启'},
    {'name': 'sw-upgrade', 'file': 'tests/browser/sw-upgrade.spec.js', 'kind': 'browser',
     'desc': 'B6C：旧版安装 → 新版部署 / 安装失败回退 / 多标签页 / 混部'},
    {'name': 'mobile-notes', 'file': 'tests/browser/mobile-notes.spec.js', 'kind': 'browser',
     'desc': 'B7A：静态笔记移动端菜单 / 键盘 / 断点 / 深色 / 无溢出'},
    {'name': 'course-seo', 'file': 'tests/browser/course-seo.spec.js', 'kind': 'browser',
     'desc': 'B7A：课程 canonical / og:url / 异步竞态 / 静态 HTML SEO'},
    {'name': 'papers-deeplink', 'file': 'tests/browser/papers-deeplink.spec.js', 'kind': 'browser',
     'desc': 'B7B2：论文/学习资料深链（身份稳定/焦点/滚动/历史/降级/视口/慢网 SW）'},
    {'name': 'editor-ux', 'file': 'tests/browser/editor-ux.spec.js', 'kind': 'browser',
     'desc': 'B8B2：真实 Chromium 下的工具栏/快捷键/原生撤销/移动端切换/无溢出/SW 升级'},
    {'name': 'editor-history', 'file': 'tests/browser/editor-history.spec.js', 'kind': 'browser',
     'desc': 'B8B3：真实 IndexedDB 历史/恢复备份/刷新持久/多标签页/移动端/SW 升级'},
    {'name': 'search-ux', 'file': 'tests/browser/search-ux.spec.js', 'kind': 'browser',
     'desc': 'B8C1：真实 Chromium 下四类命中 / XSS / 稳定深链 / 竞态 / 移动端 / 性能'},
    {'name': 'search-interaction', 'file': 'tests/browser/search-interaction.spec.js', 'kind': 'browser',
     'desc': 'B8C2：真实 Chromium 下筛选/排序/折叠/键盘/历史/多视口/SW 升级'},
    {'name': 'reading-experience', 'file': 'tests/browser/reading-experience.spec.js', 'kind': 'browser',
     'desc': 'B8D1：真实 Chromium 下目录/进度/复制/移动端/动态高度/深链与 SW'},
    {'name': 'image-lightbox', 'file': 'tests/browser/image-lightbox.spec.js', 'kind': 'browser',
     'desc': 'B8D2A：真实 Chromium 下图片放大 / 焦点 / 滚动锁定 / 移动端 / SW'},
    {'name': 'ui-refresh', 'file': 'tests/browser/ui-refresh.spec.js', 'kind': 'browser',
     'desc': 'B8D3：全站 UI 2.0（页面渲染/导航/双主题/五档视口/长文本/键盘/目录与灯箱/编辑器/静态笔记）'},
    {'name': 'performance-accessibility', 'file': 'tests/browser/performance-accessibility.spec.js', 'kind': 'browser',
     'desc': 'B8D4：性能与无障碍（chips aria-pressed/编辑器与搜索框可访问名称/浅色高亮对比度/键盘与 skip link/触控目标/六档视口+缩放+横屏/路由循环资源清理/passive 滚动/回归冒烟）'},
]

COUNT_RE = re.compile(r'共\s*(\d+)\s*项[，,]\s*PASS\s*(\d+)[，,]\s*FAIL\s*(\d+)')


def _ensure_utf8_stdout():
    """子进程输出里可能带 emoji（❌ 等），GBK 控制台会直接抛 UnicodeEncodeError，
    把"某个用例失败"变成"运行器崩溃"。统一改成 utf-8 + 替换不可编码字符。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


FAILED_RE = re.compile(r'^FAIL\s+(.*)$', re.M)


def which(cmd):
    return shutil.which(cmd)


def _terminate_tree(proc):
    """只终止该子进程及其后代（不按进程名批量杀）。

    Windows: taskkill /PID <pid> /T /F —— 目标是明确的 PID 树；
    POSIX:   killpg(进程组) —— 子进程以 start_new_session 启动，组内只有自己。
    返回是否执行过终止动作（已退出则 False）。
    """
    if proc is None:
        return False
    try:
        if proc.poll() is not None:
            return False
    except Exception:
        return False
    pid = proc.pid
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                           capture_output=True, timeout=15)
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=10)
    except Exception:
        pass
    return True


def run(cmd, cwd=ROOT, timeout=TIMEOUT, extra_env=None, label=None, meta=None):
    """运行子进程，返回 (exit_code, output, wall_seconds)。

    - 超时：终止整个进程树（含孙进程），exit=124；
    - KeyboardInterrupt：先清理进程树，再向上抛出；
    - label 非空时每 HEARTBEAT_SECONDS 打一行低频心跳（只在该套件仍在运行时）。
    """
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    if extra_env:
        env.update(extra_env)

    popen_kwargs = dict(cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding='utf-8', errors='replace', env=env)
    if os.name == 'nt':
        popen_kwargs['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    else:
        popen_kwargs['start_new_session'] = True

    t0 = time.monotonic()
    stop = threading.Event()
    proc = None

    def _beat():
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                if proc is not None and proc.poll() is None:
                    print('    [heartbeat] %s 仍在运行 %.0fs' %
                          (label, time.monotonic() - t0), flush=True)
            except Exception:
                return

    th = None
    if label:
        th = threading.Thread(target=_beat, name='heartbeat-' + str(label), daemon=True)
        th.start()

    try:
        try:
            proc = subprocess.Popen(cmd, **popen_kwargs)
        except OSError as e:
            code = 125
            out = 'OSError: %s' % e
        else:
            try:
                out = proc.communicate(timeout=timeout)[0]
                code = proc.returncode
            except subprocess.TimeoutExpired:
                killed = _terminate_tree(proc)
                try:
                    out = proc.communicate(timeout=5)[0]
                except Exception:
                    out = ''
                code = 124
                if meta is not None:
                    meta['timeout'] = True
                    meta['reason'] = 'timeout after %ds' % timeout
                    meta['tree_terminated'] = killed
                print('    [TIMEOUT] %s 超过 %ds，已终止该进程树' %
                      (label or os.path.basename(str(cmd[0])), timeout), flush=True)
    except KeyboardInterrupt:
        _terminate_tree(proc)
        if meta is not None:
            meta['interrupted'] = True
        raise
    finally:
        stop.set()
        if th is not None:
            th.join(timeout=1)
    if meta is not None:
        meta.setdefault('timeout', False)
    return code, out or '', time.monotonic() - t0


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
    """返回 (ok, details)。details 恒为 [(相对路径, True/False/None, [错误行])]。

    语法错误算失败（ok=False）；node 缺失时 JS 项记为 SKIP（None），
    由 check_env 依据所选套件决定是否把整个运行标记为 BLOCKED。
    """
    details = []
    ok = True

    js_files = collect_files(['js', '', 'tests', 'scripts'], '.js')
    node = which('node')
    for f in js_files:
        rel = os.path.relpath(f, ROOT)
        if not node:
            details.append((rel, None, ['SKIP: 未找到 node，无法执行 JavaScript 语法检查']))
            continue
        code, out, _ = run(['node', '--check', f], timeout=60)
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
    meta = {}
    code, out, dur = run(cmd, timeout=timeout, label=t['name'], meta=meta)
    # 退出码 2 在全部种类里都表示"环境/前置产物不可用"（浏览器缺 Chromium、
    # jsdom 缺产物等），统一标记 BLOCKED，不能混进 FAIL 或静默丢失。
    blocked = (code == 2)
    marker = t.get('pass_marker')
    if blocked:
        ok = False
    elif marker:
        ok = marker in out and code == 0
    else:
        ok = code == 0
    if not ok and not blocked:
        head = [ln.strip() for ln in out.splitlines() if ln.strip().startswith('FAIL')][:5]
        print('    [FAIL] %s (exit %s) %s' % (t['name'], code, ('; '.join(head))[:400]), flush=True)
    m = COUNT_RE.search(out)
    counts = None
    if m:
        counts = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    fails = [s.strip() for s in FAILED_RE.findall(out)][:5]
    return {
        'name': t['name'], 'file': t['file'], 'desc': t['desc'], 'kind': t['kind'],
        'ok': ok, 'blocked': blocked, 'exit': code, 'dur': dur, 'counts': counts,
        'fails': fails, 'timeout': bool(meta.get('timeout')), 'reason': meta.get('reason', ''),
        'tail': '\n'.join(out.strip().splitlines()[-12:]),
    }


def write_report(path, payload):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    lines = []
    lines.append('# 测试报告')
    lines.append('')
    lines.append('- 时间：%s' % payload['started'])
    lines.append('- 仓库：%s' % ROOT)
    lines.append('- 结论：**%s**' % payload['verdict'])
    lines.append('- 汇总：PASS %d / FAIL %d / SKIP %d / BLOCKED %d'
                 % (payload['pass'], payload['fail'], payload['skip'],
                    payload.get('blocked_total', len(payload['blocked']))))
    if payload.get('group'):
        lines.append('- 分组：%s（开发辅助分组不代表发布验收）' % payload['group'])
    lines.append('- 总耗时：%.1f s（单调时钟）' % payload.get('wall_seconds', 0.0))
    lines.append('- 环境准备：%.1f s；语法检查：%.1f s'
                 % (payload.get('env_seconds', 0.0), payload.get('syntax_seconds', 0.0)))
    by_kind = payload.get('by_kind') or {}
    if by_kind:
        lines.append('- 分类耗时：' + ' / '.join(
            '%s %.1f s' % (k, v) for k, v in sorted(by_kind.items())))
    lines.append('')

    if payload['blocked']:
        lines.append('## 阻塞项（环境）')
        for b in payload['blocked']:
            lines.append('- %s' % b)
        lines.append('')

    blocked_tests = payload.get('blocked_tests') or []
    if blocked_tests:
        lines.append('## 阻塞用例（exit 2）')
        lines.append('')
        lines.append('| 用例 | 退出码 | 说明 |')
        lines.append('| --- | --- | --- |')
        for b in blocked_tests:
            lines.append('| `%s` | %s | %s |' % (b['name'], b['exit'], b['desc']))
        lines.append('')

    timeouts = payload.get('timeouts') or []
    if timeouts:
        lines.append('## 超时')
        for t in timeouts:
            lines.append('- `%s`：%s（已终止进程树）' % (t['name'], t.get('reason', 'timeout')))
        lines.append('')

    lines.append('## 语法检查')
    lines.append('')
    lines.append('| 文件 | 结果 |')
    lines.append('| --- | --- |')
    for rel, ok, errs in payload['syntax']:
        if ok is True:
            st = 'OK'
        elif ok is False:
            st = 'FAIL: ' + '; '.join(errs)
        else:
            st = 'SKIP'
        lines.append('| `%s` | %s |' % (rel, st))
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

    slowest = payload.get('slowest') or sorted(
        payload['results'], key=lambda r: r['dur'], reverse=True)[:10]
    if slowest:
        lines.append('## Top 10 最慢套件')
        lines.append('')
        lines.append('| # | 用例 | 类型 | 耗时 |')
        lines.append('| --- | --- | --- | --- |')
        for i, r in enumerate(slowest[:10], 1):
            lines.append('| %d | `%s` | %s | %.1fs |'
                         % (i, r['name'], r.get('kind', '—'), r['dur']))
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


def _safe_rel(path, base=None):
    try:
        return os.path.relpath(path, base or ROOT)
    except ValueError:
        return path


def _norm_token(token):
    s = str(token).strip().lower().replace('\\', '/')
    for ext in ('.js', '.py'):
        if s.endswith(ext):
            s = s[:-len(ext)]
    return s


def _test_tokens(t):
    base = os.path.basename(t['file'])
    candidates = {t['name'].lower(), _norm_token(base), _norm_token(t['file'])}
    try:
        rel = (os.path.relpath(t['file'], ROOT) if os.path.isabs(t['file'])
               else os.path.relpath(os.path.join(ROOT, t['file']), ROOT))
        candidates.add(_norm_token(rel))
    except ValueError:
        # Windows 跨盘符（临时 fixture 在 C:，仓库在 E:）时没有相对路径，忽略即可
        pass
    return candidates


def select_tests(only=None, group='full'):
    """按 --group / --only 选择套件；--only 支持注册名、文件名、相对路径（可省扩展名）。"""
    if group in (None, '', 'full'):
        selected = list(TESTS)
    else:
        names = set(GROUPS.get(group, []))
        selected = [t for t in TESTS if t['name'] in names]

    unknown = []
    if only:
        wanted = list(only)
        normalized = [_norm_token(x) for x in wanted]

        def matched(tok):
            return any(tok in _test_tokens(t) for t in selected)

        unknown = [orig for orig, tok in zip(wanted, normalized) if not matched(tok)]
        selected = [t for t in selected
                    if any(tok in _test_tokens(t) for tok in normalized)]
    return selected, unknown


def main(argv=None):
    _ensure_utf8_stdout()

    ap = argparse.ArgumentParser(description='博客统一测试入口')
    ap.add_argument('--only', nargs='+',
                    help='只跑指定用例：注册名称 / 文件名 / 相对路径均可，可省略 .js/.py')
    ap.add_argument('--group', choices=sorted(GROUPS), default='full',
                    help='按功能分组运行（smoke/editor/search/content/sw/browser/full；'
                         '开发辅助分组不代表发布验收，默认 full）')
    ap.add_argument('--list-groups', action='store_true', help='列出分组及套件数量后退出')
    ap.add_argument('--skip-syntax', action='store_true', help='跳过语法检查')
    ap.add_argument('--report', default=DEFAULT_REPORT, help='报告输出路径')
    ap.add_argument('--json', help='额外输出一份 JSON 结果')
    args = ap.parse_args(argv)

    if args.list_groups:
        names = {t['name'] for t in TESTS}
        for g in sorted(GROUPS):
            if g == 'full':
                print('%-10s %d 套（全部）' % (g, len(TESTS)))
            else:
                missing = [n for n in GROUPS[g] if n not in names]
                print('%-10s %d 套%s' % (g, len(GROUPS[g]),
                                         ('（缺失: %s）' % ','.join(missing)) if missing else ''))
        return 0

    selected, unknown = select_tests(args.only, args.group)
    if unknown:
        print('未知用例: %s' % ', '.join(sorted(unknown)))
        return 2
    if not selected:
        print('未选中任何用例（分组: %s）' % args.group)
        return 2

    wall_start = time.monotonic()
    started = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    print('== 运行器 ==')
    print('  分组: %s；套件: %d' % (args.group, len(selected)), flush=True)

    t0 = time.monotonic()
    blocked, notes = check_env(selected)
    env_seconds = time.monotonic() - t0
    print('== 环境 ==')
    for n in notes:
        print('  ' + n)
    for b in blocked:
        print('  [BLOCKED] ' + b)

    syntax = []
    syntax_ok = True
    t0 = time.monotonic()
    if args.skip_syntax:
        print('\n== 语法检查 == 已跳过')
    else:
        print('\n== 语法检查 ==')
        syntax_ok, syntax = syntax_checks()
        for rel, good, errs in syntax:
            st = 'OK' if good is True else ('SKIP' if good is None else 'FAIL')
            print('  %-28s %s' % (rel, st))
            for e in errs:
                print('      ' + str(e))
    syntax_seconds = time.monotonic() - t0

    results = []
    total = len(selected)
    if not blocked:
        print('\n== 测试 == 共 %d 套' % total, flush=True)
        for i, t in enumerate(selected, 1):
            print('  [%d/%d] %s (%s) 开始 %s' %
                  (i, total, t['name'], t['kind'],
                   datetime.datetime.now().strftime('%H:%M:%S')), flush=True)
            r = run_test(t)
            results.append(r)
            cnt = ''
            if r['counts']:
                cnt = ' (%d/%d)' % (r['counts'][1], r['counts'][0])
            status = 'BLOCK' if r.get('blocked') else ('PASS' if r['ok'] else 'FAIL')
            print('  [%d/%d] %-10s %-5s %6.1fs%s  剩余 %d  %s' %
                  (i, total, r['name'], status, r['dur'], cnt, total - i, r['desc']),
                  flush=True)
            if not r['ok'] and not r.get('blocked'):
                for f in r['fails']:
                    print('        - ' + f, flush=True)

    n_blocked_tests = len([r for r in results if r.get('blocked')])
    n_fail = len([r for r in results if not r['ok'] and not r.get('blocked')])
    n_pass = len([r for r in results if r['ok']])
    n_skip = total - len(results)
    blocked_total = len(blocked) + n_blocked_tests
    if blocked or n_blocked_tests:
        verdict = 'BLOCKED'
        exit_code = 2
    elif n_fail or (not args.skip_syntax and not syntax_ok):
        verdict = 'FAIL'
        exit_code = 1
    else:
        verdict = 'PASS'
        exit_code = 0

    wall_seconds = time.monotonic() - wall_start
    by_kind = {}
    for r in results:
        by_kind[r['kind']] = by_kind.get(r['kind'], 0.0) + r['dur']
    slowest = sorted(results, key=lambda r: r['dur'], reverse=True)[:10]
    timeouts = [{'name': r['name'], 'reason': r.get('reason') or 'timeout'}
                for r in results if r.get('timeout')]
    blocked_tests = [{'name': r['name'], 'exit': r['exit'], 'desc': r['desc'],
                      'file': r['file']} for r in results if r.get('blocked')]

    print('\n== 汇总 ==')
    print('  PASS %d / FAIL %d / SKIP %d / BLOCKED %d'
          % (n_pass, n_fail, n_skip, blocked_total))
    print('  结论: %s' % verdict)
    print('  总耗时: %.1fs（环境 %.1fs / 语法 %.1fs）'
          % (wall_seconds, env_seconds, syntax_seconds))
    if by_kind:
        print('  分类耗时: ' + ' / '.join('%s %.1fs' % (k, v)
                                          for k, v in sorted(by_kind.items())))
    if slowest:
        print('  Top 5 最慢: ' + ', '.join('%s %.1fs' % (r['name'], r['dur'])
                                           for r in slowest[:5]))

    payload = {
        'started': started, 'verdict': verdict, 'pass': n_pass, 'fail': n_fail,
        'skip': n_skip, 'blocked': blocked, 'blocked_total': blocked_total,
        'blocked_tests': blocked_tests, 'syntax': syntax, 'results': results,
        'wall_seconds': wall_seconds, 'env_seconds': env_seconds,
        'syntax_seconds': syntax_seconds, 'by_kind': by_kind,
        'slowest': slowest, 'timeouts': timeouts,
        'group': args.group, 'selection': [t['name'] for t in selected],
    }
    write_report(args.report, payload)
    print('  报告: %s' % _safe_rel(args.report))

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print('  JSON: %s' % _safe_rel(args.json))

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
