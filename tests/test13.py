# -*- coding: utf-8 -*-
"""B3-01 / B3-02 / B3-03 回归测试：RSS 生成器的解析正确性、失败策略与路径可控性。

默认测试仓库中的 gen_feed.py；可用环境变量 GEN_FEED 指向其它实现（用于对比修复前行为）。
所有输入均为临时目录中的合成数据，不访问真实私人目录、不联网。
"""
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.environ.get('GEN_FEED') or os.path.join(REPO, 'gen_feed.py')
TMP = tempfile.mkdtemp(prefix='b3_test13_')

passed = [0]
failed = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def load_mod():
    spec = importlib.util.spec_from_file_location('gen_feed_under_test', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MOD = load_mod()
HAS_NEW_API = hasattr(MOD, 'parse_posts_js')


def wfile(name, text):
    p = os.path.join(TMP, name)
    io.open(p, 'w', encoding='utf-8').write(text)
    return p


def parse_data(text):
    """兼容旧实现（只接受路径）与新实现（接受文本）。"""
    if HAS_NEW_API:
        return MOD.parse_posts_js(text)
    return MOD.parse_posts(wfile('_tmp_data.js', text))


def parse_user(text, name='_tmp_user.js'):
    return MOD.parse_user_posts(wfile(name, text))


def raises(fn):
    try:
        fn()
        return False, None
    except Exception as e:          # noqa: BLE001 - 测试需要捕获任意解析异常
        return True, '%s: %s' % (type(e).__name__, e)


def run(args, cwd=None):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run([sys.executable, SCRIPT] + args,
                          capture_output=True, text=True, encoding='utf-8',
                          errors='replace', env=env, cwd=cwd or TMP)


def sha(path):
    if not os.path.isfile(path):
        return ''
    return hashlib.sha256(io.open(path, 'rb').read()).hexdigest()


def get0(lst):
    """取首元素；空列表时返回空字典，避免旧实现直接 IndexError。"""
    return lst[0] if lst else {}


def feed_items(path):
    if not os.path.isfile(path):
        return []
    root = ET.parse(path).getroot()
    items = []
    for it in root.iter('item'):
        items.append({
            'title': it.findtext('title'),
            'link': it.findtext('link'),
            'pubDate': it.findtext('pubDate'),
            'description': it.findtext('description'),
        })
    return items


# ==========================================================================
# B3-01 data.js 结构化解析
# ==========================================================================
print('== B3-01 data.js ==')

D_BASE = """const POSTS = [
  {
    id: 'a',
    title: 'A',
    date: '2026-01-02',
    excerpt: 'ea',
    content: `%s`
  },
  {
    id: 'b',
    title: 'B',
    date: '2026-01-01',
    excerpt: 'eb',
    content: 'x'
  }
];
"""

p = parse_data(D_BASE % "配置示例:\n    id: 'evil'\n    title: '被污染'\n")
check('T1 正文中的 id:/title: 不污染元数据',
      [x['id'] for x in p] == ['a', 'b'] and [x['title'] for x in p] == ['A', 'B'],
      [(x['id'], x['title']) for x in p])

p = parse_data(D_BASE % "function f() {\n}\n},\n继续")
check('T2 正文中的 "}," 不截断文章', len(p) == 2 and [x['id'] for x in p] == ['a', 'b'], len(p))

p = parse_data("""const POSTS = [
  { id: 'a', title: 'Eric\\'s Notebook', date: '2026-01-02', excerpt: 'e', content: 'x' }
];""")
check('T3 标题含转义单引号', get0(p).get('title') == "Eric's Notebook", get0(p).get('title'))

p = parse_data("""const POSTS = [
  { id: 'a', title: 'A', date: '2026-01-02', excerpt: '第一行\\n第二行', content: 'x' }
];""")
check('T4 摘要中的转义换行被正确解码',
      get0(p).get('excerpt') == '第一行\n第二行', repr(get0(p).get('excerpt')))

ok, err = raises(lambda: parse_data("""const POSTS = [
  { id: 'a', title: 'A', date: '2026-01-02', excerpt: '第一行
第二行', content: 'x' }
];"""))
check('T4b 非法跨行字符串明确报错', ok, err)

p = parse_data("""const POSTS = [
  { id: 'a', title: 'A', date: '2026-01-02', excerpt: '含,逗号 "引号" 与\\'单引号', content: 'x' }
];""")
check('T5 摘要含逗号/引号', get0(p).get('excerpt') == '含,逗号 "引号" 与\'单引号', repr(get0(p).get('excerpt')))

# 模板插值：只跳过、不执行（若被执行，${1 + 1} 会变成 2）
p = parse_data(D_BASE % "结果: ${1 + 1}")
check('T6 模板插值被跳过且不执行',
      len(p) == 2 and get0(p).get('id') == 'a' and get0(p).get('title') == 'A', len(p))

# 正文中的代码块：反引号在真实 data.js 里写作 \`（转义）
p = parse_data(D_BASE % "代码:\n\\`\\`\\`js\nconst s = \\`\\${x}\\`;\n\\`\\`\\`")
check('T6b 转义反引号的代码块可解析', len(p) == 2 and get0(p).get('id') == 'a', len(p))

p = parse_data(D_BASE % "数组: a[0];\nb")
check('T7 正文含 "];" 不影响解析', len(p) == 2 and get0(p).get('id') == 'a', len(p))

p = parse_data("""// 注释里的 id: 'fake'
const POSTS = [
  /* title: 'also fake' */
  { id: 'a', title: 'A', date: '2026-01-02', excerpt: 'e', content: 'x' }
];""")
check('T8 注释中的伪字段被忽略', len(p) == 1 and get0(p).get('id') == 'a' and get0(p).get('title') == 'A')

ok, err = raises(lambda: parse_data('const NOT_POSTS = [];'))
check('T9 找不到 POSTS 时明确报错', ok, err)

ok, err = raises(lambda: parse_data("""const POSTS = [
  { id: 'a', title: 'A', excerpt: 'e', content: 'x' }
];"""))
check('T10 缺少 date 时明确报错', ok, err)

ok, err = raises(lambda: parse_data("""const POSTS = [
  { id: 'a', title: 'A', date: '2026-13-40', excerpt: 'e', content: 'x' }
];"""))
check('T11 非法日期明确报错', ok, err)

# ==========================================================================
# B3-02 user-posts.js
# ==========================================================================
print('\n== B3-02 user-posts.js ==')

UP_OK = ('const USER_POSTS = ' + json.dumps([
    {'id': 'u1', 'title': 'T1', 'date': '2026-03-03', 'excerpt': 'e1', 'content': 'c1'},
    {'id': 'u2', 'title': 'T2', 'date': '2026-03-02', 'excerpt': 'e2', 'content': 'c2'},
    {'id': 'u3', 'title': 'T3', 'date': '2026-03-01', 'excerpt': 'e3', 'content': 'c3'},
], ensure_ascii=False) + ';\n')

posts = parse_user(UP_OK)
check('T12 正常 3 篇', len(posts) == 3 and [x['id'] for x in posts] == ['u1', 'u2', 'u3'], len(posts))
check('T12b 标题/日期完整保留', get0(posts).get('title') == 'T1' and get0(posts).get('date') == '2026-03-03',
      (get0(posts).get('title'), get0(posts).get('date')))

check('T13 空数组返回 0 篇', parse_user('const USER_POSTS = [];\n') == [])

UP_BRACKET = ('const USER_POSTS = ' + json.dumps([
    {'id': 'u1', 'title': 'T1', 'date': '2026-03-03', 'excerpt': 'e1', 'content': 'a[0];\nb'},
], ensure_ascii=False) + ';\n')
check('T14 正文含 "];" 仍能解析', len(parse_user(UP_BRACKET)) == 1, len(parse_user(UP_BRACKET)))

UP_UNI = ('const USER_POSTS = ' + json.dumps([
    {'id': 'u1', 'title': '标题🦐 “引号” — dash', 'date': '2026-03-03', 'excerpt': 'émoji 🚀', 'content': 'x'},
], ensure_ascii=False) + ';\n')
check('T15 特殊 Unicode 保留', get0(parse_user(UP_UNI)).get('title') == '标题🦐 “引号” — dash')

ok, err = raises(lambda: parse_user('const USER_POSTS = [{oops}];\n'))
check('T16 非法 JSON 明确报错', ok, err)

ok, err = raises(lambda: parse_user('const USER_POSTS = [{"title":"无 id"}];\n'))
check('T17 缺 id 明确报错', ok, err)

ok, err = raises(lambda: parse_user('const USER_POSTS = [{"id":"a","date":"2026-01-01"}];\n'))
check('T18 缺 title 明确报错', ok, err)

ok, err = raises(lambda: parse_user('const USER_POSTS = [{"id":"a","title":"A"}];\n'))
check('T19 缺 date 明确报错', ok, err)

check('T20 user-posts 文件不存在视为 0 篇',
      MOD.parse_user_posts(os.path.join(TMP, 'not-exist.js')) == [])

# 重复 id：确定性 first-wins
data_f = wfile('dup_data.js', """const POSTS = [
  { id: 'dup', title: '来自 data.js', date: '2026-05-01', excerpt: 'e', content: 'x' },
  { id: 'b', title: 'B', date: '2026-04-01', excerpt: 'e', content: 'x' }
];""")
dup_user_text = 'const USER_POSTS = ' + json.dumps(
    [{'id': 'dup', 'title': '来自 user-posts', 'date': '2026-05-02', 'excerpt': 'e', 'content': 'x'}],
    ensure_ascii=False) + ';\n'
user_f = wfile('dup_user.js', dup_user_text)
out_f = os.path.join(TMP, 'dup_feed.xml')
r = run(['--data', data_f, '--user-posts', user_f, '--out', out_f, '--now', '2026-10-23T00:00:00Z'])
items = feed_items(out_f) if os.path.exists(out_f) else []
dup_titles = [it['title'] for it in items if '/post/dup' in (it['link'] or '')]
check('T21 重复 id 只保留一条（先出现者优先）', dup_titles == ['来自 data.js'], dup_titles)
check('T21b 重复 id 有告警', '重复文章 id' in (r.stderr or ''), (r.stderr or '').strip()[:60])

# ==========================================================================
# B3-03 路径 / 可重复 / 失败不覆盖
# ==========================================================================
print('\n== B3-03 路径与产物安全 ==')

data_ok = wfile('ok_data.js', D_BASE % '正文')
# 1) 不依赖 cwd：从一个无关目录运行
other_cwd = os.path.join(TMP, 'cwd_elsewhere')
os.makedirs(other_cwd, exist_ok=True)
out1 = os.path.join(TMP, 'feed1.xml')
r = run(['--data', data_ok, '--out', out1, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
check('T22 可从任意工作目录运行', r.returncode == 0 and os.path.exists(out1),
      (r.returncode, (r.stderr or '').strip()[:60]))

# 2) 固定 --now 时两次生成字节一致
out2 = os.path.join(TMP, 'feed2.xml')
run(['--data', data_ok, '--out', out2, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
check('T23 --now 固定时输出可重复',
      os.path.exists(out1) and os.path.exists(out2) and sha(out1) == sha(out2))

# 3) XML 可解析
try:
    items = feed_items(out1)
    xml_ok = True
except ET.ParseError as e:
    items, xml_ok = [], False
    print('    XML 解析错误:', e)
check('T24 输出可被 XML 解析器读取', xml_ok and len(items) == 2, len(items))

# 4) 输入缺失 -> 非 0 且不创建输出
out_missing = os.path.join(TMP, 'feed_missing.xml')
r = run(['--data', os.path.join(TMP, 'no-such.js'), '--out', out_missing,
         '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
check('T25 输入缺失时中止', r.returncode != 0, r.returncode)
check('T25b 输入缺失时不创建输出', not os.path.exists(out_missing))

# 5) 非法 user-posts -> 非 0 且不覆盖已有合法产物
out_keep = os.path.join(TMP, 'feed_keep.xml')
run(['--data', data_ok, '--out', out_keep, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
before_hash = sha(out_keep)
before_items = len(feed_items(out_keep))
bad_user = wfile('bad_user.js', 'const USER_POSTS = [{oops}];\n')
r = run(['--data', data_ok, '--user-posts', bad_user, '--out', out_keep,
         '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
check('T26 非法 JSON 时中止', r.returncode != 0, r.returncode)
check('T26b 非法 JSON 时不覆盖已有 feed', os.path.exists(out_keep) and sha(out_keep) == before_hash,
      before_items)

# 6) 0 篇文章 -> 中止，不覆盖
empty_data = wfile('empty_data.js', 'const POSTS = [];\n')
out_empty = os.path.join(TMP, 'feed_empty.xml')
run(['--data', data_ok, '--out', out_empty, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
empty_hash = sha(out_empty)
r = run(['--data', empty_data, '--user-posts', os.path.join(TMP, 'not-exist.js'),
         '--out', out_empty, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
check('T27 解析到 0 篇时中止', r.returncode != 0, r.returncode)
check('T27b 0 篇时不覆盖已有 feed',
      os.path.isfile(out_empty) and sha(out_empty) == empty_hash)

# 7) RSS 条目与数据源一致 + 日期倒序
data_sorted = wfile('sorted_data.js', """const POSTS = [
  { id: 'old', title: 'Old', date: '2026-01-01', excerpt: 'eo', content: 'x' },
  { id: 'new', title: 'New', date: '2026-03-01', excerpt: 'en', content: 'x' },
  { id: 'mid', title: 'Mid', date: '2026-02-01', excerpt: 'em', content: 'x' }
];""")
out_sorted = os.path.join(TMP, 'feed_sorted.xml')
run(['--data', data_sorted, '--out', out_sorted, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
items = feed_items(out_sorted)
ids = [it['link'].rsplit('/', 1)[-1] for it in items]
check('T28 RSS 按日期倒序', ids == ['new', 'mid', 'old'], ids)
check('T28b RSS 标题与数据源一致', [it['title'] for it in items] == ['New', 'Mid', 'Old'])
import datetime as _dt
_exp_pub = _dt.datetime.strptime('2026-03-01', '%Y-%m-%d').strftime('%a, %d %b %Y 00:00:00 +0000')
check('T28c RSS pubDate 与数据源日期一致',
      get0(items).get('pubDate') == _exp_pub, get0(items).get('pubDate'))

# 8) 真实数据：18 篇且 id 集合一致（输出到临时目录，不动仓库产物）
real_out = os.path.join(TMP, 'feed_real.xml')
r = run(['--data', os.path.join(REPO, 'js', 'data.js'),
         '--user-posts', os.path.join(REPO, 'js', 'user-posts.js'),
         '--out', real_out, '--now', '2026-10-23T00:00:00Z'], cwd=other_cwd)
real_items = feed_items(real_out) if os.path.exists(real_out) else []
real_ids = [it['link'].rsplit('/', 1)[-1] for it in real_items]
src = parse_data(io.open(os.path.join(REPO, 'js', 'data.js'), encoding='utf-8').read())
check('T29 真实数据生成 18 条', r.returncode == 0 and len(real_items) == 18, len(real_items))
check('T29b RSS id 与数据源完全一致',
      sorted(real_ids) == sorted([x['id'] for x in src]),
      len(real_ids))
from email.utils import parsedate_to_datetime

_real_dates = [parsedate_to_datetime(it['pubDate']) for it in real_items]
check('T29c 真实 RSS 日期倒序',
      all(_real_dates[i - 1] >= _real_dates[i] for i in range(1, len(_real_dates))),
      len(_real_dates))

print('\n共 %d 项，PASS %d，FAIL %d' % (passed[0] + failed[0], passed[0], failed[0]))
sys.exit(0 if failed[0] == 0 else 1)
