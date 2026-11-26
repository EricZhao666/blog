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

# 已由 Batch 8E-3B-1 / 8E-3B-R 实测过的非浏览器配对。
# 只允许精确配对，不能把“每个成员曾与别处并行”推导成任意组合安全。
PAIR_LICENSES = {
    frozenset(('test11', 'test20')): {
        'evidence': 'BATCH8E3B1_PARALLEL_RESULTS.csv + B8E3B2: test11 exit 0 / test20 24/24；105.7s→28.9s',
    },
    frozenset(('test24', 'test40')): {
        'evidence': 'BATCH8E3B1_PARALLEL_RESULTS.csv + B8E3B2: 22/22、35/35；54.2s→35.7s',
    },
    frozenset(('test16', 'test43')): {
        'evidence': 'BATCH8E3A_PARALLEL_RESULTS.csv / B8E3B2: 20/20、40/40；44.4s→28.2s',
    },
    # Batch 8E-3B-3：注册顺序相邻的非浏览器组合，串行/2-worker 对照通过。
    frozenset(('audit', 'test6')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: audit exit 0 / test6 exit 0；parallel overlap 29.4s',
    },
    frozenset(('test8', 'test9')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: exit 0/0；overlap 22.0s',
    },
    frozenset(('test10', 'test11')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: exit 0/0；overlap 22.1s',
    },
    frozenset(('test14', 'test15')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: test15 32/32、exit 0/0；overlap 70.5s',
    },
    frozenset(('test16', 'test17')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 20/20、11/11；exit 0/0；overlap 24.2s',
    },
    frozenset(('test25', 'test26')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 13/13、21/21；exit 0/0；overlap 21.6s',
    },
    frozenset(('test32', 'test33')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 42/42、68/68；exit 0/0；overlap 22.6s',
    },
    frozenset(('test34', 'test35')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 67/67、78/78；exit 0/0；overlap 16.5s',
    },
    frozenset(('test37', 'test38')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 66/66、59/59；exit 0/0；overlap 21.4s',
    },
    frozenset(('test40', 'test41')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 35/35、44/44；exit 0/0；overlap 22.2s',
    },
    frozenset(('test42', 'test43')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv: 29/29、40/40；exit 0/0；overlap 28.9s',
    },
    # 浏览器配对必须显式允许；默认仍全部串行。
    frozenset(('editor-ux', 'editor-history')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv / browser run1+run2: 66/66、39/39；两次并发通过',
        'browser_pair': True,
    },
    frozenset(('reading-experience', 'image-lightbox')): {
        'evidence': 'BATCH8E3B3_PARALLEL_RESULTS.csv / browser run1+run2: 47/47、34/34；两次并发通过',
        'browser_pair': True,
    },
}

# 这些套件即使出现在配对清单旁边，也必须独占串行；浏览器套件一律独占。
EXPLICIT_SERIAL = {'test23', 'build-lock', 'runner-infrastructure'}
PORT_ENV_NAMES = ('TEST_PORT', 'B3_PORT')

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_PROCS = {}


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
        'content-links',
    ],
    'sw': ['test7', 'browser', 'sw-consistency', 'sw-upgrade'],
    'browser': [
        'browser', 'sw-consistency', 'sw-upgrade', 'mobile-notes', 'course-seo',
        'papers-deeplink', 'editor-ux', 'editor-history', 'search-ux',
        'search-interaction', 'reading-experience', 'image-lightbox',
        'ui-refresh', 'performance-accessibility', 'robot-kinematics', 'pid-control',
        'oee-analysis', 'spc-analysis', 'kalman-filter', 'graph-experience',
    ],
    'lab': ['robot-math', 'robot-kinematics', 'pid-math', 'pid-control', 'oee-math', 'oee-analysis',
            'spc-math', 'spc-analysis', 'kalman-math', 'kalman-filter'],
    'knowledge': ['knowledge-store', 'knowledge-center', 'knowledge-import', 'knowledge-management',
                  'learning-stats', 'learning-analytics',
                  'personalized-home', 'home-experience',
                  'related-content', 'related-reading', 'project-detail',
                  'content-links', 'knowledge-graph', 'graph-experience'],
    'projects': ['project-detail', 'related-content', 'related-reading'],
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
    {'name': 'parallel-scheduler', 'file': 'tests/test50_parallel_scheduler.py', 'kind': 'python',
     'desc': 'B8E3B2：可选 2-worker 安全调度 / 配对许可 / 中断与进程树清理'},
    {'name': 'knowledge-store', 'file': 'tests/test51_knowledge_store.js', 'kind': 'jsdom',
     'desc': 'B9A1：知识库数据层（稳定键/字段级并发/历史裁剪/降级/导出）'},
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
    {'name': 'knowledge-center', 'file': 'tests/browser/knowledge-center.spec.js', 'kind': 'browser',
     'desc': 'B9A1：知识中心（收藏/待读/历史/继续阅读/导出/降级/移动端/键盘）'},
    {'name': 'related-content', 'file': 'tests/test52_related_content.js', 'kind': 'jsdom',
     'desc': 'B9B1：相关推荐算法（标签区分度/显式关联/系列/分类/技术栈/标题/稳定排序/去重/无效链接）'},
    {'name': 'related-reading', 'file': 'tests/browser/related-content.spec.js', 'kind': 'browser',
     'desc': 'B9B1：相关阅读（文章与课程页渲染/理由/跳转/知识管理按钮/快速切换/降级/移动端/深色/离线）'},
    {'name': 'project-detail', 'file': 'tests/browser/project-detail.spec.js', 'kind': 'browser',
     'desc': 'B9D：项目作品集（6 个详情/列表跳转/刷新前进后退/无效 ID/可选字段/示例标记/外链过滤/转义/视口/知识库联动/推荐联动/离线）'},
    {'name': 'knowledge-import', 'file': 'tests/test53_knowledge_management.js', 'kind': 'jsdom',
     'desc': 'B9A2：分类/批量事务/显式已读未读/导出完整性/安全导入与替换（55 项，无浏览器）'},
    {'name': 'knowledge-management', 'file': 'tests/browser/knowledge-management.spec.js', 'kind': 'browser',
     'desc': 'B9A2：分类筛选与迁移/批量范围/导入预览与校验/真实 IDB v1→v2 迁移/双标签同步/移动端深色/离线'},
    {'name': 'learning-stats', 'file': 'tests/test54_learning_stats.js', 'kind': 'jsdom',
     'desc': 'B9E：学习统计口径（去重/已浏览/完成率分母/多方向/分类/规模/输入不可变/不支持项）'},
    {'name': 'learning-analytics', 'file': 'tests/browser/learning-analytics.spec.js', 'kind': 'browser',
     'desc': 'B9E：统计页（空库/指标一致/分布与方向/指标跳转/自动刷新/多标签/导入/三档视口/降级/未来版本/离线）'},
    {'name': 'personalized-home', 'file': 'tests/test55_personalized_home.js', 'kind': 'jsdom',
     'desc': 'B9F：首页个人模块（无数据/组合顺序/偏好读写与损坏/隐藏恢复/失效内容/失败降级/搜索交替）'},
    {'name': 'home-experience', 'file': 'tests/browser/home-experience.spec.js', 'kind': 'browser',
     'desc': 'B9F：首页验收（模块顺序/继续阅读恢复/搜索交替/键盘焦点/多标签/快速路由/视口主题/降级/离线/三引擎）'},
    {'name': 'robot-math', 'file': 'tests/test56_robot_kinematics.js', 'kind': 'jsdom',
     'desc': 'B9C1A：2R 运动学数学（FK/IK 回代/双分支/内外边界/奇异/非法输入/精度/连续性）'},
    {'name': 'robot-kinematics', 'file': 'tests/browser/robot-kinematics.spec.js', 'kind': 'browser',
     'desc': 'B9C1A：机器人演示验收（数值一致/拖动/分支/边界奇异/390px 触摸/深色/键盘无障碍/离线/三引擎）'},
    {'name': 'pid-math', 'file': 'tests/test57_pid_control.js', 'kind': 'jsdom',
     'desc': 'B9C1B：PID 离散仿真数学（对象解析对照/零输入/P/PI/PID/饱和与抗饱和/dt 收敛/指标定义/非法输入/确定性）'},
    {'name': 'pid-control', 'file': 'tests/browser/pid-control.spec.js', 'kind': 'browser',
     'desc': 'B9C1B：PID 实验室验收（数值一致/参数与模式/饱和可视化/抗饱和对比/390px/深色/键盘无障碍/离线/三引擎）'},
    {'name': 'oee-math', 'file': 'tests/test58_oee_math.js', 'kind': 'jsdom',
     'desc': 'B9C1C：OEE 数学与数据口径（统一口径/多穴/单位换算/损失守恒/边界与异常/Performance>100%/A-B 对比与假设投影/确定性）'},
    {'name': 'oee-analysis', 'file': 'tests/browser/oee-analysis.spec.js', 'kind': 'browser',
     'desc': 'B9C1C：OEE 实验室验收（数值一致/示例切换/多穴/A-B 对比/异常提示/390px/深色/键盘无障碍/离线/三引擎）'},
    {'name': 'spc-math', 'file': 'tests/test61_spc_math.js', 'kind': 'jsdom',
     'desc': 'B9C2A：SPC 数学与统计口径（解析定位/描述统计/移动极差/I-MR 界限/四条规则边界/冻结基线/能力指数/负 Cpk/零波动/顺序影响/抽样分离/数值稳定/5000 样本）'},
    {'name': 'spc-analysis', 'file': 'tests/browser/spc-analysis.spec.js', 'kind': 'browser',
     'desc': 'B9C2A：SPC 实验室验收（数值一致/粘贴与校验/示例切换/理论模式/基线冻结/异常定位/390-768-1440/深色/键盘无障碍/离线/降级/快速路由/三引擎）'},
    {'name': 'kalman-math', 'file': 'tests/test62_kalman_math.js', 'kind': 'jsdom',
     'desc': 'B9C2B：卡尔曼数学（标量首步手算/多步/Q=0/R 有效性/无测量传播/矩阵预测/Joseph/PSD/联合与顺序一致/噪声与失配/初始协方差/缺失/确定性/非法输入/RMSE 口径）'},
    {'name': 'kalman-filter', 'file': 'tests/browser/kalman-filter.spec.js', 'kind': 'browser',
     'desc': 'B9C2B：卡尔曼实验室验收（数值一致/预测更新分离/播放暂停重置/参数与场景/传感器开关/390-768-1440/深色/键盘/离线/降级/快速路由/三引擎）'},
    {'name': 'content-links', 'file': 'tests/test59_content_links.js', 'kind': 'jsdom',
     'desc': 'B9B2：引用契约与构建索引（JS/Python 共享 fixture/marked 扩展安全/确定性两次构建/--check/--dry-run/--sync/诊断/自环循环去重）'},
    {'name': 'knowledge-graph', 'file': 'tests/test60_knowledge_graph.js', 'kind': 'jsdom',
     'desc': 'B9B2：图谱纯计算（节点去重/有向显式边/三类关系区分/孤立/筛选搜索/一跳/示例标记/确定性/合成500与1000节点扩展）'},
    {'name': 'graph-experience', 'file': 'tests/browser/graph-experience.spec.js', 'kind': 'browser',
     'desc': 'B9B2：图谱与反向链接浏览器验收（WikiLink 渲染/未解析/反向链接/筛选搜索/缩放平移/键盘列表/390px/深色/离线/降级/快速路由/三引擎）'},
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


def _win_descendant_pids(root_pid):
    """用 Toolhelp32 明确枚举 root_pid 的后代 PID（不按进程名筛选）。

    该快照在终止前获取，用于补偿 Windows taskkill /T 在“父进程先退、子进程
    被孤儿化”时可能漏杀的情况。失败时返回空列表，由调用方保留 taskkill /T
    作为兜底并记录限制。
    """
    if os.name != 'nt':
        return []
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ('dwSize', wintypes.DWORD),
                ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.POINTER(wintypes.ULONG)),
                ('th32ModuleID', wintypes.DWORD),
                ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long),
                ('dwFlags', wintypes.DWORD),
                ('szExeFile', wintypes.WCHAR * 260),
            ]

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32FirstW.argtypes = [ctypes.c_void_p,
                                             ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [ctypes.c_void_p,
                                            ctypes.POINTER(PROCESSENTRY32W)]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        TH32CS_SNAPPROCESS = 0x00000002
        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot in (None, ctypes.c_void_p(-1).value):
            return []
        try:
            entries = []
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                entries.append((int(entry.th32ProcessID),
                                int(entry.th32ParentProcessID)))
                ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel32.CloseHandle(snapshot)

        children = {}
        for pid, ppid in entries:
            children.setdefault(ppid, []).append(pid)
        out = []
        pending = [int(root_pid)]
        seen = set(pending)
        while pending:
            parent = pending.pop(0)
            for child in children.get(parent, []):
                if child in seen:
                    continue
                seen.add(child)
                out.append(child)
                pending.append(child)
        return out
    except Exception:
        return []


def _terminate_tree(proc):
    """只终止该子进程及其后代（不按进程名批量杀）。

    Windows: 先枚举明确的后代 PID，再 taskkill /PID <pid> /T /F；若 taskkill
    因父进程先退出而漏掉孤儿后代，按枚举到的明确 PID 逐个补杀。
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
    descendants = _win_descendant_pids(pid) if os.name == 'nt' else []
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                           capture_output=True, timeout=15)
            for child_pid in descendants:
                if child_pid == pid:
                    continue
                try:
                    subprocess.run(['taskkill', '/PID', str(child_pid), '/T', '/F'],
                                   capture_output=True, timeout=10)
                except Exception:
                    pass
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


def _register_proc(proc):
    if proc is None:
        return
    try:
        with _ACTIVE_LOCK:
            _ACTIVE_PROCS[proc.pid] = proc
    except Exception:
        pass


def _unregister_proc(proc):
    if proc is None:
        return
    try:
        with _ACTIVE_LOCK:
            _ACTIVE_PROCS.pop(proc.pid, None)
    except Exception:
        pass


def _terminate_active():
    """只终止本运行器注册过的子进程树；不按进程名批量杀。"""
    with _ACTIVE_LOCK:
        procs = list(_ACTIVE_PROCS.values())
    for proc in procs:
        _terminate_tree(proc)
    # 清掉已经退出的登记，避免中断后活动表残留导致后续误杀/误报。
    with _ACTIVE_LOCK:
        for pid, proc in list(_ACTIVE_PROCS.items()):
            try:
                if proc.poll() is not None:
                    _ACTIVE_PROCS.pop(pid, None)
            except Exception:
                pass
    return len(procs)


def run(cmd, cwd=ROOT, timeout=TIMEOUT, extra_env=None, label=None, meta=None,
        log_prefix=''):
    """运行子进程，返回 (exit_code, output, wall_seconds)。

    - 超时：终止整个进程树（含孙进程），exit=124；
    - KeyboardInterrupt：先清理进程树，再向上抛出；
    - label 非空时每 HEARTBEAT_SECONDS 打一行低频心跳（只在该套件仍在运行时）。
    - 所有子进程都登记到本运行器的活动表，供主线程中断/并行调度统一清理。
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

    def _emit(message):
        print('%s%s' % (log_prefix, message), flush=True)

    def _beat():
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                if proc is not None and proc.poll() is None:
                    _emit('[heartbeat] %s 仍在运行 %.0fs' %
                          (label, time.monotonic() - t0))
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
            _register_proc(proc)
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
                _emit('[TIMEOUT] %s 超过 %ds，已终止该进程树' %
                      (label or os.path.basename(str(cmd[0])), timeout))
    except KeyboardInterrupt:
        _terminate_tree(proc)
        if meta is not None:
            meta['interrupted'] = True
        raise
    finally:
        stop.set()
        if th is not None:
            th.join(timeout=1)
        _unregister_proc(proc)
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


def run_test(t, log_prefix=''):
    cmd = ([sys.executable] if t['kind'] == 'python' else ['node']) + [t['file']] + list(t.get('args') or [])
    timeout = t.get('timeout') or (BROWSER_TIMEOUT if t['kind'] == 'browser' else TIMEOUT)
    meta = {}
    code, out, dur = run(cmd, timeout=timeout, label=t['name'], meta=meta,
                         log_prefix=log_prefix)
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
        print('%s[FAIL] %s (exit %s) %s' %
              (log_prefix, t['name'], code, ('; '.join(head))[:400]), flush=True)
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


def _pair_license(t1, t2):
    return PAIR_LICENSES.get(frozenset((t1['name'], t2['name'])))


def _pair_kind_allowed(a, b, lic):
    """浏览器套件只能进入显式 browser_pair 许可；其他套件仍按原规则。"""
    browser = a['kind'] == 'browser' or b['kind'] == 'browser'
    if not browser:
        return True
    return bool(lic.get('browser_pair')) and a['kind'] == 'browser' and b['kind'] == 'browser'


def _port_env_conflict():
    found = [name for name in PORT_ENV_NAMES if os.environ.get(name)]
    if found:
        return '显式端口环境变量: %s' % ', '.join(found)
    return ''


def _serial_fallback_reason(t, env_conflict=''):
    if t['kind'] == 'browser':
        return 'browser_exclusive'
    if t['name'] in EXPLICIT_SERIAL:
        return 'explicit_serial'
    if env_conflict:
        return 'port_env_explicit'
    return 'no_verified_adjacent_pair'


def plan_execution(selected, workers):
    """把选中套件拆成执行单元。

    workers=1 时保持旧的逐套串行循环；workers=2 只把“选中顺序中相邻、
    且属于精确配对许可”的两个套件放进同一并行单元。这样不会为了凑并行
    跨过独占串行屏障或依赖阶段，也不会运行同一套件的多个实例。
    """
    if workers == 1:
        return ([{'mode': 'serial', 'tests': [t], 'reason': 'workers=1'}
                for t in selected], [], [], [])

    env_conflict = _port_env_conflict()
    jobs = []
    pairs = []
    serial_suites = []
    serial_reasons = []
    i = 0
    while i < len(selected):
        t = selected[i]
        if i + 1 < len(selected):
            a, b = selected[i], selected[i + 1]
            lic = _pair_license(a, b)
            if (lic and not env_conflict
                    and _pair_kind_allowed(a, b, lic)
                    and a['name'] not in EXPLICIT_SERIAL
                    and b['name'] not in EXPLICIT_SERIAL):
                jobs.append({'mode': 'parallel', 'tests': [a, b], 'license': lic})
                pairs.append('%s+%s' % (a['name'], b['name']))
                i += 2
                continue

        reason = _serial_fallback_reason(t, env_conflict)
        jobs.append({'mode': 'serial', 'tests': [t], 'reason': reason})
        serial_suites.append(t['name'])
        serial_reasons.append('%s: %s' % (t['name'], reason))
        i += 1
    return jobs, pairs, serial_suites, serial_reasons


def _interrupted_result(t, started_offset=0.0):
    return {
        'name': t['name'], 'file': t['file'], 'desc': t['desc'], 'kind': t['kind'],
        'ok': False, 'blocked': False, 'exit': 130, 'dur': 0.0, 'counts': None,
        'fails': ['INTERRUPTED'], 'timeout': False, 'reason': 'interrupted',
        'tail': 'run interrupted before suite completed',
        'start_offset': started_offset, 'end_offset': started_offset,
    }


def execute_jobs(jobs, total, selected):
    """执行执行单元，返回 (按注册顺序排列的结果, 调度元数据)。

    并行单元只由两个独立外部测试进程组成；主线程是唯一的汇总者。
    任何 Ctrl+C 都在主线程捕获，先终止本运行器登记的活动进程树，再生成
    可识别的中断结果，不依赖 worker 线程收到 KeyboardInterrupt。
    """
    execution_start = time.monotonic()
    results_by_name = {}
    suite_execution_order = []
    parallel_pairs = []
    serial_suites = []
    serial_reasons = []
    active = 0
    peak = 0
    lock = threading.Lock()
    interrupted = False

    def _start(name):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            suite_execution_order.append(name)

    def _finish(name):
        nonlocal active
        with lock:
            active = max(0, active - 1)

    def _timed_run(t, prefix):
        start = time.monotonic() - execution_start
        _start(t['name'])
        try:
            r = run_test(t, log_prefix=prefix)
        except Exception as e:
            r = {
                'name': t['name'], 'file': t['file'], 'desc': t['desc'],
                'kind': t['kind'], 'ok': False, 'blocked': False, 'exit': 125,
                'dur': 0.0, 'counts': None, 'fails': ['worker exception: %s' % e],
                'timeout': False, 'reason': 'worker exception', 'tail': str(e),
            }
        finally:
            _finish(t['name'])
        end = time.monotonic() - execution_start
        r['start_offset'] = start
        r['end_offset'] = end
        return r

    def _worker(t, prefix):
        try:
            r = _timed_run(t, prefix)
            with lock:
                results_by_name[t['name']] = r
        except BaseException as e:
            r = {
                'name': t['name'], 'file': t['file'], 'desc': t['desc'],
                'kind': t['kind'], 'ok': False, 'blocked': False, 'exit': 125,
                'dur': 0.0, 'counts': None, 'fails': ['worker exception: %s' % e],
                'timeout': False, 'reason': 'worker exception', 'tail': str(e),
                'start_offset': time.monotonic() - execution_start,
                'end_offset': time.monotonic() - execution_start,
            }
            with lock:
                results_by_name[t['name']] = r

    try:
        done = 0
        for job in jobs:
            job_tests = job['tests']
            if job['mode'] == 'serial':
                t = job_tests[0]
                done += 1
                print('  [%d/%d] %s (%s) 开始 %s' %
                      (done, total, t['name'], t['kind'],
                       datetime.datetime.now().strftime('%H:%M:%S')), flush=True)
                r = _timed_run(t, '')
                results_by_name[t['name']] = r
                serial_suites.append(t['name'])
                serial_reasons.append('%s: %s' % (t['name'], job.get('reason', 'serial')))
                cnt = ' (%d/%d)' % (r['counts'][1], r['counts'][0]) if r['counts'] else ''
                status = 'BLOCK' if r.get('blocked') else ('PASS' if r['ok'] else 'FAIL')
                print('  [%d/%d] %-10s %-5s %6.1fs%s  剩余 %d  %s' %
                      (done, total, r['name'], status, r['dur'], cnt,
                       total - done, r['desc']), flush=True)
                if not r['ok'] and not r.get('blocked'):
                    for f in r['fails']:
                        print('        - ' + f, flush=True)
                continue

            a, b = job_tests
            done += 2
            parallel_pairs.append('%s+%s' % (a['name'], b['name']))
            print('  [%d-%d/%d] %s + %s (parallel) 开始 %s' %
                  (done - 1, done, total, a['name'], b['name'],
                   datetime.datetime.now().strftime('%H:%M:%S')), flush=True)
            threads = [threading.Thread(target=_worker, args=(a, '    [p1] '),
                                        name='suite-' + a['name'], daemon=True),
                       threading.Thread(target=_worker, args=(b, '    [p2] '),
                                        name='suite-' + b['name'], daemon=True)]
            for th in threads:
                th.start()
            while any(th.is_alive() for th in threads):
                try:
                    for th in threads:
                        th.join(timeout=0.5)
                except KeyboardInterrupt:
                    interrupted = True
                    print('\n  [INTERRUPTED] 正在清理本运行器活动进程树...', flush=True)
                    _terminate_active()
                    for th in threads:
                        th.join(timeout=10)
                    break
            for offset, (name, t) in enumerate(((a['name'], a), (b['name'], b)), 1):
                r = results_by_name.get(name)
                if r is None:
                    r = _interrupted_result(t)
                    results_by_name[name] = r
                cnt = ' (%d/%d)' % (r['counts'][1], r['counts'][0]) if r['counts'] else ''
                status = 'BLOCK' if r.get('blocked') else ('PASS' if r['ok'] else 'FAIL')
                print('  [%d/%d] %-10s %-5s %6.1fs%s  %s' %
                      (done - 2 + offset, total, r['name'], status, r['dur'], cnt,
                       r['desc']), flush=True)
                if not r['ok'] and not r.get('blocked'):
                    for f in r['fails']:
                        print('        - ' + f, flush=True)
            if interrupted:
                break
    except KeyboardInterrupt:
        interrupted = True
        print('\n  [INTERRUPTED] 正在清理本运行器活动进程树...', flush=True)
        _terminate_active()
    finally:
        if interrupted:
            _terminate_active()
        # 中断时，未开始的选中套件不会伪造 PASS/FAIL；由 main 计入 SKIP 并标记 INTERRUPTED。
        for t in selected:
            if t['name'] not in results_by_name:
                results_by_name[t['name']] = _interrupted_result(t)

    ordered = [results_by_name[t['name']] for t in selected]
    meta = {
        'parallel_pairs': parallel_pairs,
        'serial_suites': serial_suites,
        'serial_fallback_reasons': serial_reasons,
        'suite_execution_order': suite_execution_order,
        'peak_active_suites': peak,
        'effective_workers': peak,
        'summed_suite_seconds': sum(r['dur'] for r in ordered),
        'test_wall_seconds': time.monotonic() - execution_start,
        'interrupted': interrupted,
        'execution_start': execution_start,
    }
    return ordered, meta


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

    if payload.get('requested_workers') is not None:
        lines.append('## 并行调度')
        lines.append('')
        lines.append('- workers：请求 %s / 实际峰值 %s'
                     % (payload.get('requested_workers', 1),
                        payload.get('effective_workers', 0)))
        lines.append('- 并行配对：%s'
                     % (', '.join(payload.get('parallel_pairs') or []) or '无'))
        lines.append('- 串行套件：%d 套' % len(payload.get('serial_suites') or []))
        reasons = {}
        for item in payload.get('serial_fallback_reasons') or []:
            reason = item.rsplit(': ', 1)[-1]
            reasons[reason] = reasons.get(reason, 0) + 1
        if reasons:
            lines.append('- 串行原因：' + ' / '.join(
                '%s %d' % (k, v) for k, v in sorted(reasons.items())))
        lines.append('- 实测 wall：%.1fs；套件累计：%.1fs；重叠：%.1fs'
                     % (payload.get('test_wall_seconds', 0.0),
                        payload.get('summed_suite_seconds', 0.0),
                        payload.get('parallel_overlap_seconds', 0.0)))
        order = payload.get('suite_execution_order') or []
        if order:
            lines.append('- 实际开始顺序：%s' % ' → '.join(order))
        intervals = payload.get('parallel_intervals') or []
        pair_names = set()
        for pair in payload.get('parallel_pairs') or []:
            pair_names.update(pair.split('+'))
        shown = [x for x in intervals if x['name'] in pair_names]
        if shown:
            lines.append('')
            lines.append('| 配对套件 | 开始(相对) | 结束(相对) | 结果 |')
            lines.append('| --- | --- | --- | --- |')
            for x in shown:
                lines.append('| `%s` | %.2fs | %.2fs | %s |'
                             % (x['name'], x['start'], x['end'],
                                'PASS' if x['ok'] else ('exit %s' % x['exit'])))
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


def _parse_workers(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError('workers 必须是整数 1 或 2')
    if n not in (1, 2):
        raise argparse.ArgumentTypeError('workers 只支持 1 或 2（默认 1，串行）')
    return n


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
    ap.add_argument('--workers', type=_parse_workers, default=1,
                    help='并行 worker 数：默认 1（完全串行）；2 只在已验证的相邻非浏览器配对并行')
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

    jobs, planned_pairs, planned_serial, planned_reasons = plan_execution(selected, args.workers)

    wall_start = time.monotonic()
    started = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    print('== 运行器 ==')
    print('  分组: %s；套件: %d；workers: %d（请求）' %
          (args.group, len(selected), args.workers), flush=True)
    if args.workers == 2 and not planned_pairs:
        print('  并行: 没有相邻的已验证配对，安全回退为串行', flush=True)
    elif planned_pairs:
        print('  并行配对: ' + ', '.join(planned_pairs), flush=True)

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

    total = len(selected)
    if blocked:
        results = []
        sched_meta = {
            'parallel_pairs': [], 'serial_suites': [t['name'] for t in selected],
            'serial_fallback_reasons': ['environment blocked'],
            'suite_execution_order': [], 'peak_active_suites': 0,
            'effective_workers': 0, 'summed_suite_seconds': 0.0,
            'test_wall_seconds': 0.0, 'interrupted': False,
        }
    else:
        print('\n== 测试 == 共 %d 套' % total, flush=True)
        results, sched_meta = execute_jobs(jobs, total, selected)

    interrupted = bool(sched_meta.get('interrupted'))
    n_blocked_tests = len([r for r in results if r.get('blocked')])
    n_fail = len([r for r in results if not r['ok'] and not r.get('blocked')
                  and r.get('exit') != 130])
    n_pass = len([r for r in results if r['ok']])
    n_interrupted = len([r for r in results if r.get('exit') == 130])
    n_skip = total - len([r for r in results if r.get('exit') != 130])
    blocked_total = len(blocked) + n_blocked_tests
    if interrupted:
        verdict = 'INTERRUPTED'
        exit_code = 130
    elif blocked or n_blocked_tests:
        verdict = 'BLOCKED'
        exit_code = 2
    elif n_fail or (not args.skip_syntax and not syntax_ok):
        verdict = 'FAIL'
        exit_code = 1
    else:
        verdict = 'PASS'
        exit_code = 0

    wall_seconds = time.monotonic() - wall_start
    summed_suite_seconds = sum(r['dur'] for r in results)
    test_wall_seconds = sched_meta.get('test_wall_seconds', 0.0)
    parallel_overlap_seconds = max(0.0, summed_suite_seconds - test_wall_seconds)
    by_kind = {}
    for r in results:
        by_kind[r['kind']] = by_kind.get(r['kind'], 0.0) + r['dur']
    slowest = sorted(results, key=lambda r: r['dur'], reverse=True)[:10]
    timeouts = [{'name': r['name'], 'reason': r.get('reason') or 'timeout'}
                for r in results if r.get('timeout')]
    blocked_tests = [{'name': r['name'], 'exit': r['exit'], 'desc': r['desc'],
                      'file': r['file']} for r in results if r.get('blocked')]
    parallel_intervals = [
        {'name': r['name'], 'start': round(r.get('start_offset', 0.0), 3),
         'end': round(r.get('end_offset', 0.0), 3), 'ok': r['ok'],
         'exit': r['exit']}
        for r in results if 'start_offset' in r
    ]

    print('\n== 汇总 ==')
    print('  PASS %d / FAIL %d / SKIP %d / BLOCKED %d%s'
          % (n_pass, n_fail, n_skip, blocked_total,
             (' / INTERRUPTED %d' % n_interrupted) if n_interrupted else ''))
    print('  结论: %s' % verdict)
    print('  总耗时: %.1fs（环境 %.1fs / 语法 %.1fs）'
          % (wall_seconds, env_seconds, syntax_seconds))
    print('  测试阶段 wall: %.1fs；套件累计: %.1fs；并行重叠: %.1fs'
          % (test_wall_seconds, summed_suite_seconds, parallel_overlap_seconds))
    print('  workers: 请求 %d / 实际峰值 %d；并行配对: %s'
          % (args.workers, sched_meta.get('effective_workers', 0),
             ', '.join(sched_meta.get('parallel_pairs') or []) or '无'))
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
        'requested_workers': args.workers,
        'effective_workers': sched_meta.get('effective_workers', 0),
        'parallel_pairs': sched_meta.get('parallel_pairs') or [],
        'serial_suites': sched_meta.get('serial_suites') or [],
        'suite_execution_order': sched_meta.get('suite_execution_order') or [],
        'peak_active_suites': sched_meta.get('peak_active_suites', 0),
        'serial_fallback_reasons': sched_meta.get('serial_fallback_reasons') or [],
        'summed_suite_seconds': summed_suite_seconds,
        'test_wall_seconds': test_wall_seconds,
        'parallel_overlap_seconds': parallel_overlap_seconds,
        'parallel_intervals': parallel_intervals,
        'interrupted': interrupted,
        'interrupted_count': n_interrupted,
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
