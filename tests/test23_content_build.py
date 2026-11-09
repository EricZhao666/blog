# -*- coding: utf-8 -*-
"""Batch 7C-2：统一内容构建器的数据生命周期测试（全部合成 Fixture）。

覆盖（对应任务书 7C2-03 的 16 项）：
    C1  初始构建               C2  幂等（逐字节）
    C3  --check 不写文件       C4  新增文章
    C5  修改正文               C6  修改标题
    C7  修改摘要               C8  修改标签
    C9  修改日期               C10 删除文章（孤儿正文不静默删除）
    C11 修改 ID                C12 重复 ID（内置内部）
    C13 缺少正文               C14 正文损坏（非法 UTF-8）
    C15 非法日期               C16 生成中断（计算期零写入 / 写入期半更新的边界）
    C17 并发构建               C18 旧 USER_POSTS 兼容
    C19 P13b：同 ID 的内置 + 用户文章内容不同 → 必须中止
    C20 四份产物使用同一身份集合
    C21 固定构建时间下逐字节可复现
    C22 --check 对"多余/过期产物"的判定
    C23 内联 content 仍被拒绝（Batch 6 约束不回退）

设计：每个用例都在临时目录里跑**真实的** scripts/build_content.py 子进程，
不触碰真实仓库、不联网。断言只看退出码 + 产物内容 + 文件哈希。
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
BUILD = os.path.join(ROOT, 'scripts', 'build_content.py')
TMP = tempfile.mkdtemp(prefix='b7c2_build_')
FIXED_NOW = '2026-11-09T00:00:00Z'

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def run(root, *args):
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    cmd = [sys.executable, BUILD, '--root', root] + list(args)
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env)


def sync(root, now=FIXED_NOW):
    return run(root, '--sync', '--now', now)


def dry(root, now=FIXED_NOW):
    return run(root, '--dry-run', '--now', now)


def chk(root, now=FIXED_NOW):
    return run(root, '--check', '--now', now)


def write(path, text, mode='w'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if mode == 'wb':
        with open(path, 'wb') as f:
            f.write(text)
    else:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


def read(path):
    return io.open(path, encoding='utf-8').read()


def sha(path):
    if not os.path.isfile(path):
        return None
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


ARTIFACTS = ['js/data.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml']


def snap(root):
    return {rel: sha(os.path.join(root, rel.replace('/', os.sep))) for rel in ARTIFACTS}


DATA_HEAD = """/**
 * Fixture 元数据（测试用）
 */

const POSTS = [
  {
    id: 'post-a',
    title: '第一篇文章',
    date: '2026-01-02',
    tags: ['测试', '甲'],
    excerpt: '甲的摘要'
  },
  {
    id: 'post-b',
    title: '第二篇文章',
    date: '2026-02-03',
    tags: ['测试'],
    excerpt: '乙的摘要'
  }
];

const TAG_ORDER = ['测试', '甲'];
"""


def make_fixture(tag):
    root = os.path.join(TMP, tag)
    write(os.path.join(root, 'js', 'data.js'), DATA_HEAD)
    write(os.path.join(root, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词。\n')
    write(os.path.join(root, 'data', 'posts', 'post-b.md'), '# 乙\n\n正文乙：贝塔词。\n')
    write(os.path.join(root, 'js', 'user-posts.js'), 'const USER_POSTS = [];\n')
    return root


def ids_of(root):
    """四份产物各自的 id 集合（用于"同一身份集合"的断言）。"""
    data_js = read(os.path.join(root, 'js', 'data.js'))
    metas = re.findall(r"^    id: '([^']+)',", data_js, re.M)
    search = json.loads(read(os.path.join(root, 'data', 'search-index.json')))
    manifest = json.loads(read(os.path.join(root, 'data', 'posts', 'manifest.json')))
    feed = read(os.path.join(root, 'feed.xml'))
    feed_ids = re.findall(r'/blog/#/post/([^<"]+)', feed)
    return {
        'data': sorted(metas),
        'search': sorted(search.keys()),
        'manifest': sorted(p['id'] for p in manifest['posts']),
        'feed': sorted(set(feed_ids)),
    }


def all_same(root):
    """派生三件（search/manifest/feed）必须同一身份集合，内置元数据是其子集。

    （兼容期允许 user-posts.js 里的旧文章只出现在派生数据里，不写进 js/data.js。）
    """
    s = ids_of(root)
    ok = s['search'] == s['manifest'] == s['feed']
    ok = ok and set(s['data']) <= set(s['search'])
    return ok, s


def add_meta(root, pid, title, date, excerpt, tags=('测试',)):
    """在规范化后的 js/data.js 里追加一条元数据（POSTS 数组末尾）。"""
    path = os.path.join(root, 'js', 'data.js')
    src = read(path)
    start = src.index('const POSTS')
    end = src.index('\n];', start)
    block = ("  {\n"
             "    id: '%s',\n"
             "    title: '%s',\n"
             "    date: '%s',\n"
             "    tags: [%s],\n"
             "    excerpt: '%s'\n"
             "  }") % (pid, title, date,
                       ', '.join("'%s'" % t for t in tags), excerpt)
    write(path, src[:end] + ',\n' + block + src[end:])


# ===================================================================== 用例
print('== C1-C3 初始构建 / 幂等 / 只读校验 ==')
root = make_fixture('main')
r = sync(root)
check('C1 首次 --sync 成功', r.returncode == 0, (r.stderr or r.stdout).strip()[:80])
check('C1b 四份产物齐全', all(os.path.isfile(os.path.join(root, a.replace('/', os.sep))) for a in ARTIFACTS))
same, detail = all_same(root)
check('C1c 四份产物使用同一身份集合', same, detail)

s1 = snap(root)
r = sync(root)
check('C2 重复 --sync 逐字节相同（幂等）', r.returncode == 0 and snap(root) == s1)

before = snap(root)
r = chk(root)
check('C3 --check 通过且不写文件', r.returncode == 0 and snap(root) == before, (r.stdout or '').strip()[-40:])
r = dry(root)
check('C3b --dry-run 报告 0 个待更新文件', r.returncode == 0 and '待更新 0 个文件' in r.stdout,
      (r.stdout or '').strip().splitlines()[-1] if r.stdout else '')

print('\n== C4-C9 内容变更（每次先 --check 应失败，--sync 后同步）==')
# C4 新增：加一份正文 + 一条元数据
write(os.path.join(root, 'data', 'posts', 'post-c.md'), '# 丙\n\n正文丙：伽马词。\n')
add_meta(root, 'post-c', '第三篇文章', '2026-03-04', '丙的摘要')
r = chk(root)
check('C4 新增文章后 --check 失败（派生未更新）', r.returncode != 0, r.returncode)
r = sync(root)
same, detail = all_same(root)
check('C4b --sync 后四份产物同时包含新文章', r.returncode == 0 and same and 'post-c' in detail['search'],
      detail['feed'])

# C5 修改正文
write(os.path.join(root, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词改。\n')
r = chk(root)
check('C5 修改正文后 --check 失败', r.returncode != 0, r.returncode)
feed_before = sha(os.path.join(root, 'feed.xml'))
r = sync(root)
search = json.loads(read(os.path.join(root, 'data', 'search-index.json')))
check('C5b 搜索语料跟着更新', '阿尔法词改' in search['post-a'] and '阿尔法词。' not in search['post-a'],
      search['post-a'].strip()[:16])
check('C5c feed 不含正文，改正文不影响 feed', sha(os.path.join(root, 'feed.xml')) == feed_before)

# C6 修改标题
src = read(os.path.join(root, 'js', 'data.js')).replace("title: '第一篇文章'", "title: '第一篇文章（改名）'")
write(os.path.join(root, 'js', 'data.js'), src)
r = sync(root)
check('C6 修改标题后 data.js 与 feed 同步',
      r.returncode == 0 and '（改名）' in read(os.path.join(root, 'js', 'data.js'))
      and '（改名）' in read(os.path.join(root, 'feed.xml')))

# C7 修改摘要
src = read(os.path.join(root, 'js', 'data.js')).replace("excerpt: '甲的摘要'", "excerpt: '甲的摘要改'")
write(os.path.join(root, 'js', 'data.js'), src)
search_before = sha(os.path.join(root, 'data', 'search-index.json'))
r = sync(root)
check('C7 修改摘要后 feed 更新、搜索语料不变',
      r.returncode == 0 and '甲的摘要改' in read(os.path.join(root, 'feed.xml'))
      and sha(os.path.join(root, 'data', 'search-index.json')) == search_before)

# C8 修改标签
src = read(os.path.join(root, 'js', 'data.js')).replace("tags: ['测试', '甲']", "tags: ['测试', '乙标签']")
write(os.path.join(root, 'js', 'data.js'), src)
feed_before = sha(os.path.join(root, 'feed.xml'))
r = sync(root)
check('C8 修改标签后 data.js 更新、feed 不变（RSS 不含标签）',
      r.returncode == 0 and '乙标签' in read(os.path.join(root, 'js', 'data.js'))
      and sha(os.path.join(root, 'feed.xml')) == feed_before)

# C9 修改日期（影响顺序）
src = read(os.path.join(root, 'js', 'data.js')).replace("date: '2026-01-02'", "date: '2026-12-31'")
write(os.path.join(root, 'js', 'data.js'), src)
r = sync(root)
feed = read(os.path.join(root, 'feed.xml'))
order = []
for pid in re.findall(r'/blog/#/post/([^<"]+)', feed):
    if pid not in order:
        order.append(pid)          # 每条 item 里 link 与 guid 各出现一次，去重保序
check('C9 修改日期后 feed 顺序按新日期倒序', r.returncode == 0 and order[0] == 'post-a', order[:3])

print('\n== C10-C11 删除 / 改 ID ==')
# C10 删除文章：删元数据 + 留 md → 孤儿必须报错且不删除
src = read(os.path.join(root, 'js', 'data.js'))
src = re.sub(r",\n  \{\n    id: 'post-c',[\s\S]*?\n  \}", '', src, count=1)
write(os.path.join(root, 'js', 'data.js'), src)
before = snap(root)
r = sync(root)
check('C10 删除元数据后 --sync 失败（孤儿正文，不静默删除）',
      r.returncode != 0 and '没有元数据引用的正文' in (r.stderr or '') + (r.stdout or ''),
      (r.stderr or '').strip()[:60])
check('C10b 失败时产物未被改写', snap(root) == before)
check('C10c 孤儿正文仍存在（生成器不删历史）',
      os.path.isfile(os.path.join(root, 'data', 'posts', 'post-c.md')))
os.remove(os.path.join(root, 'data', 'posts', 'post-c.md'))
r = sync(root)
same, detail = all_same(root)
check('C10d 手工清掉正文后 --sync 成功，四份产物各少一条',
      r.returncode == 0 and same and 'post-c' not in detail['search'], detail['manifest'])

# C11 修改 ID
src = read(os.path.join(root, 'js', 'data.js')).replace("id: 'post-b'", "id: 'post-b2'")
write(os.path.join(root, 'js', 'data.js'), src)
os.rename(os.path.join(root, 'data', 'posts', 'post-b.md'), os.path.join(root, 'data', 'posts', 'post-b2.md'))
r = sync(root)
same, detail = all_same(root)
check('C11 改 id（含重命名正文）后四份产物同步切换',
      r.returncode == 0 and same and 'post-b2' in detail['search'] and 'post-b' not in detail['search'],
      detail['search'])

print('\n== C12-C15 非法输入（必须非 0 且零写入）==')
# C12 重复 ID（内置内部）
root2 = make_fixture('dup')
src = read(os.path.join(root2, 'js', 'data.js')).replace("id: 'post-b'", "id: 'post-a'")
write(os.path.join(root2, 'js', 'data.js'), src)
before = snap(root2)
r = sync(root2)
check('C12 内置文章 id 重复 → 失败且不写盘',
      r.returncode != 0 and 'id' in (r.stderr or '') and snap(root2) == before,
      (r.stderr or '').strip()[:60])

# C13 缺少正文
root3 = make_fixture('missing')
os.remove(os.path.join(root3, 'data', 'posts', 'post-b.md'))
before = snap(root3)
r = sync(root3)
check('C13 缺少正文 → 失败并明确报错',
      r.returncode != 0 and '缺少正文' in (r.stderr or '') and snap(root3) == before,
      (r.stderr or '').strip()[:60])

# C14 正文损坏（非法 UTF-8）
root4 = make_fixture('badutf8')
write(os.path.join(root4, 'data', 'posts', 'post-a.md'), b'# \xff\xfe bad\n', mode='wb')
before = snap(root4)
r = sync(root4)
check('C14 正文非法 UTF-8 → 失败并明确报错',
      r.returncode != 0 and 'UTF-8' in (r.stderr or '') and snap(root4) == before,
      (r.stderr or '').strip()[:60])

# C15 非法日期
root5 = make_fixture('baddate')
src = read(os.path.join(root5, 'js', 'data.js')).replace("date: '2026-01-02'", "date: '2026-13-45'")
write(os.path.join(root5, 'js', 'data.js'), src)
before = snap(root5)
r = sync(root5)
check('C15 非法日期 → 失败且不写盘',
      r.returncode != 0 and 'date' in (r.stderr or '') and snap(root5) == before,
      (r.stderr or '').strip()[:60])

print('\n== C16 生成中断的边界 ==')
root6 = make_fixture('interrupt')
sync(root6)
before = snap(root6)
# 计算期失败：把一篇正文改成非法 UTF-8
write(os.path.join(root6, 'data', 'posts', 'post-a.md'), b'\xff\xfe', mode='wb')
r = sync(root6)
check('C16 计算期失败 → 零写入（四份产物字节不变）',
      r.returncode != 0 and snap(root6) == before)
write(os.path.join(root6, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词。\n')

# 写入期失败：把 data/search-index.json 变成目录，替换必然失败
idx = os.path.join(root6, 'data', 'search-index.json')
os.remove(idx)
os.makedirs(idx)
os.makedirs(os.path.join(idx, 'keep'), exist_ok=True)   # 非空目录，replace 一定失败
r = sync(root6)
partial = chk(root6)
check('C16b 写入期失败 → 非 0 退出，且不会被误判为"可发布"',
      r.returncode != 0 and partial.returncode != 0,
      'sync=%d check=%d' % (r.returncode, partial.returncode))
shutil.rmtree(idx)
os.remove(os.path.join(root6, 'data', 'posts', 'post-a.md'))
write(os.path.join(root6, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词。\n')
r = sync(root6)
check('C16c 恢复目标后可重新同步成功', r.returncode == 0, r.returncode)

print('\n== C17 并发构建 ==')
root7 = make_fixture('race')
sync(root7)
env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
cmd = [sys.executable, BUILD, '--root', root7, '--sync', '--now', FIXED_NOW]
p1 = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                      text=True, encoding='utf-8', errors='replace', env=env)
p2 = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                      text=True, encoding='utf-8', errors='replace', env=env)
o1, e1 = p1.communicate()
o2, e2 = p2.communicate()
codes = sorted([p1.returncode, p2.returncode])
check('C17 并发时不会出现两个都半途而废（0/0 或 0/3）', codes in ([0, 0], [0, 3]), codes)
check('C17b 并发后产物仍可解析且身份集合一致', all_same(root7)[0] and chk(root7).returncode == 0)
check('C17c 锁文件没有残留', not os.path.exists(os.path.join(root7, '.content-build.lock')))

def user_posts_js(items):
    return 'const USER_POSTS = ' + json.dumps(items, ensure_ascii=False, indent=2) + ';\n'


print('\n== C18-C19 旧 USER_POSTS 兼容 ==')
root8 = make_fixture('legacy')
write(os.path.join(root8, 'js', 'user-posts.js'), user_posts_js(
    [{'id': 'legacy-1', 'title': '旧文章', 'date': '2026-10-10',
      'tags': ['旧'], 'excerpt': '旧摘要', 'content': '# 旧\n\n旧正文：德尔塔词。\n'}]))
r = sync(root8)
same, detail = all_same(root8)
check('C18 旧 USER_POSTS 进入统一身份集合（search/manifest/feed 都有）',
      r.returncode == 0 and same and 'legacy-1' in detail['search'], detail)
manifest = json.loads(read(os.path.join(root8, 'data', 'posts', 'manifest.json')))
check('C18b manifest 标注兼容期条目与计数',
      manifest.get('legacyUserPosts', {}).get('count') == 1
      and any(p['id'] == 'legacy-1' and p.get('file') is None for p in manifest['posts']))
check('C18c 旧文章不会被写进内置元数据 js/data.js',
      'legacy-1' not in read(os.path.join(root8, 'js', 'data.js')))

# C19 = 旧报告里的 P13b：同 id、不同内容 → 必须中止
root9 = make_fixture('p13b')
write(os.path.join(root9, 'js', 'user-posts.js'), user_posts_js(
    [{'id': 'post-a', 'title': '冒名文章', 'date': '2026-12-12',
      'tags': ['x'], 'excerpt': 'e', 'content': '# 冒名\n\n完全不同的正文。\n'}]))
before = snap(root9)
r = sync(root9)
check('C19 同 ID 的内置文章与用户文章内容不同 → 中止（不各自选一边）',
      r.returncode != 0 and '重复' in (r.stderr or '') and snap(root9) == before,
      (r.stderr or '').strip()[:70])

print('\n== C20-C23 ==')
same, detail = all_same(root)
check('C20 四份产物身份集合一致（内置 2 篇）', same and len(detail['search']) == 2, detail['search'])

root10 = make_fixture('repro')
r1 = sync(root10)
s_a = snap(root10)
shutil.rmtree(os.path.join(root10, 'data'))
shutil.rmtree(os.path.join(root10, 'js'))
write(os.path.join(root10, 'js', 'data.js'), DATA_HEAD)
write(os.path.join(root10, 'data', 'posts', 'post-a.md'), '# 甲\n\n正文甲：阿尔法词。\n')
write(os.path.join(root10, 'data', 'posts', 'post-b.md'), '# 乙\n\n正文乙：贝塔词。\n')
write(os.path.join(root10, 'js', 'user-posts.js'), 'const USER_POSTS = [];\n')
r2 = sync(root10)
check('C21 相同输入 + 固定构建时间 → 逐字节可复现（含 feed）',
      r1.returncode == 0 and r2.returncode == 0 and snap(root10) == s_a)

r = chk(root10)
check('C22 重建后 --check 返回 0（同一条命令可直接作 CI 门禁）',
      r.returncode == 0, r.stdout.strip()[-30:])

# C23：内联 content 仍被拒绝
root11 = make_fixture('inline')
src = read(os.path.join(root11, 'js', 'data.js')).replace(
    "excerpt: '甲的摘要'", "excerpt: '甲的摘要',\n    content: '# 内联正文'")
write(os.path.join(root11, 'js', 'data.js'), src)
r = sync(root11)
check('C23 js/data.js 里仍有内联 content → 拒绝（Batch 6 约束不回退）',
      r.returncode != 0 and 'content' in (r.stderr or ''), (r.stderr or '').strip()[:60])

shutil.rmtree(TMP, ignore_errors=True)
print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(1 if failed[0] else 0)
