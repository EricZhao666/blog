#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 RSS feed.xml（RSS 2.0）。

运行：
    python gen_feed.py
    python gen_feed.py --data js/data.js --user-posts js/user-posts.js --out feed.xml
    python gen_feed.py --now 2026-10-23T00:00:00Z     # 固定 lastBuildDate，便于可重复生成/测试

解析策略：
    - js/data.js 用结构化 JS 字面量扫描（自己处理字符串/模板/注释/括号配对），
      不再逐行正则，因此正文里的 `id:`、`},`、代码块、模板字符串都不会污染元数据；
    - js/user-posts.js 先按括号配对截取数组，再做严格 JSON 解析；
    - 全程不执行文章内容（不 eval / 不 vm），也不依赖第三方解析器。

失败策略：
    任何一步读不懂（文件缺失、JSON 非法、字段缺失、日期非法）都会中止并返回非 0，
    且不写任何文件——避免用不完整的数据覆盖已有的合法 feed.xml。
"""
import argparse
import datetime
import json
import os
import sys

SITE = 'https://ericzhao666.github.io/blog'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_DATA = os.path.join(BASE_DIR, 'js', 'data.js')
DEFAULT_USER_POSTS = os.path.join(BASE_DIR, 'js', 'user-posts.js')
DEFAULT_OUT = os.path.join(BASE_DIR, 'feed.xml')

_IDENT_START = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$')
_IDENT_CHARS = _IDENT_START | set('0123456789')
_HEX = set('0123456789abcdefABCDEF')


class FeedError(Exception):
    """数据源无法被可信解析时抛出（必须中止，不能当成 0 篇文章）。"""


# --------------------------------------------------------------------------
# 极简 JS 字面量扫描器（只解析数据，不执行代码）
# --------------------------------------------------------------------------
def _skip_ws(s, i):
    """跳过空白、// 行注释与 /* */ 块注释。"""
    n = len(s)
    while i < n:
        c = s[i]
        if c in ' \t\r\n\ufeff':
            i += 1
        elif c == '/' and i + 1 < n and s[i + 1] == '/':
            j = s.find('\n', i + 2)
            i = n if j < 0 else j + 1
        elif c == '/' and i + 1 < n and s[i + 1] == '*':
            j = s.find('*/', i + 2)
            if j < 0:
                raise FeedError('存在未闭合的块注释')
            i = j + 2
        else:
            break
    return i


def _skip_balanced(s, i):
    """s[i] 为 '{' 或 '['，返回与之配对的右括号之后的位置（字符串/注释安全）。"""
    opener = s[i]
    closer = '}' if opener == '{' else ']'
    depth = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in '\'"`':
            _, i = _read_string(s, i)
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            j = s.find('\n', i + 2)
            i = n if j < 0 else j + 1
            continue
        if c == '/' and i + 1 < n and s[i + 1] == '*':
            j = s.find('*/', i + 2)
            if j < 0:
                raise FeedError('存在未闭合的块注释')
            i = j + 2
            continue
        if c == opener:
            depth += 1
        elif c == closer:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise FeedError('括号不匹配（可能缺少 %s）' % closer)


def _read_string(s, i):
    """读取一个 '...' / \"...\" / `...` 字面量，返回 (解码后的值, 结束位置)。"""
    quote = s[i]
    n = len(s)
    i += 1
    out = []
    while i < n:
        c = s[i]
        if c == '\\':
            i += 1
            if i >= n:
                raise FeedError('字符串未正常结束')
            e = s[i]
            if e == 'n':
                out.append('\n')
            elif e == 't':
                out.append('\t')
            elif e == 'r':
                out.append('\r')
            elif e == 'b':
                out.append('\b')
            elif e == 'f':
                out.append('\f')
            elif e == 'v':
                out.append('\v')
            elif e == '0':
                out.append('\0')
            elif e == 'u':
                hexs = s[i + 1:i + 5]
                if len(hexs) < 4 or any(ch not in _HEX for ch in hexs):
                    raise FeedError('非法的 \\u 转义')
                out.append(chr(int(hexs, 16)))
                i += 4
            elif e == 'x':
                hexs = s[i + 1:i + 3]
                if len(hexs) < 2 or any(ch not in _HEX for ch in hexs):
                    raise FeedError('非法的 \\x 转义')
                out.append(chr(int(hexs, 16)))
                i += 2
            elif e == '\r':
                if i + 1 < n and s[i + 1] == '\n':
                    i += 1
            elif e == '\n':
                pass  # 续行
            else:
                out.append(e)
            i += 1
        elif c == quote:
            return ''.join(out), i + 1
        elif quote == '`' and c == '$' and i + 1 < n and s[i + 1] == '{':
            # 模板插值：按原文整体保留，不执行、不插值
            end = _skip_balanced(s, i + 1)
            out.append(s[i:end])
            i = end
        elif c == '\n' and quote != '`':
            raise FeedError('字符串中出现未转义的换行')
        else:
            out.append(c)
            i += 1
    raise FeedError('字符串未正常结束')


def _read_number(s, i):
    n = len(s)
    j = i
    if j < n and s[j] in '+-':
        j += 1
    while j < n and (s[j].isdigit() or s[j] in '.eE+-'):
        j += 1
    token = s[i:j]
    try:
        return (float(token) if any(ch in token for ch in '.eE') else int(token)), j
    except ValueError:
        raise FeedError('无法解析的数字: %r' % token)


def _read_value(s, i):
    """读取一个 JS 字面量（对象/数组/字符串/数字/布尔/null），返回 (值, 结束位置)。"""
    i = _skip_ws(s, i)
    if i >= len(s):
        raise FeedError('数据意外结束')
    c = s[i]

    if c in '\'"`':
        return _read_string(s, i)

    if c == '[':
        i += 1
        arr = []
        while True:
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == ']':
                return arr, i + 1
            val, i = _read_value(s, i)
            arr.append(val)
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == ',':
                i += 1
                continue
            if i < len(s) and s[i] == ']':
                return arr, i + 1
            raise FeedError('数组缺少逗号或右括号')

    if c == '{':
        i += 1
        obj = {}
        while True:
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == '}':
                return obj, i + 1
            if i < len(s) and s[i] in '\'"':
                key, i = _read_string(s, i)
            else:
                j = i
                while j < len(s) and s[j] in _IDENT_CHARS:
                    j += 1
                if j == i:
                    raise FeedError('对象键名非法，位置 %d' % i)
                key = s[i:j]
                i = j
            i = _skip_ws(s, i)
            if i >= len(s) or s[i] != ':':
                raise FeedError('对象字段 %r 缺少冒号' % key)
            i += 1
            val, i = _read_value(s, i)
            obj[key] = val
            i = _skip_ws(s, i)
            if i < len(s) and s[i] == ',':
                i += 1
                continue
            if i < len(s) and s[i] == '}':
                return obj, i + 1
            raise FeedError('对象缺少逗号或右括号')

    if c.isdigit() or (c in '+-' and i + 1 < len(s) and s[i + 1].isdigit()):
        return _read_number(s, i)

    j = i
    while j < len(s) and s[j] in _IDENT_CHARS:
        j += 1
    token = s[i:j]
    if token == 'true':
        return True, j
    if token == 'false':
        return False, j
    if token == 'null':
        return None, j
    raise FeedError('无法识别的字面量: %r' % (token or s[i]))


def find_assignment(text, name):
    """找到 `name = <值>` 中值开始的位置（跳过字符串、模板与注释）。"""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in '\'"`':
            _, i = _read_string(text, i)
            continue
        if c == '/' and i + 1 < n and text[i + 1] in '/*':
            i = _skip_ws(text, i)
            continue
        if c in _IDENT_START:
            j = i
            while j < n and text[j] in _IDENT_CHARS:
                j += 1
            if text[i:j] == name:
                k = _skip_ws(text, j)
                if k < n and text[k] == '=' and not (k + 1 < n and text[k + 1] == '='):
                    return _skip_ws(text, k + 1)
            i = j
            continue
        i += 1
    raise FeedError('未找到 %s 的赋值语句' % name)


# --------------------------------------------------------------------------
# 数据解析
# --------------------------------------------------------------------------
_DATE_LEN = 10


def _normalize_post(raw, source, index):
    """字段校验与归一化；任何必要字段缺失都中止，不静默跳过。"""
    if not isinstance(raw, dict):
        raise FeedError('%s 第 %d 条不是对象' % (source, index + 1))
    pid = raw.get('id')
    title = raw.get('title')
    date = raw.get('date')
    excerpt = raw.get('excerpt')
    if not isinstance(pid, str) or not pid.strip():
        raise FeedError('%s 第 %d 条缺少有效 id' % (source, index + 1))
    if not isinstance(title, str) or not title.strip():
        raise FeedError('%s 第 %d 条（%s）缺少标题' % (source, index + 1, pid))
    if not isinstance(date, str) or not date.strip():
        raise FeedError('%s 第 %d 条（%s）缺少日期' % (source, index + 1, pid))
    date = date.strip()[:_DATE_LEN]
    try:
        datetime.datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise FeedError('%s 第 %d 条（%s）日期格式非法: %r' % (source, index + 1, pid, date))
    return {
        'id': pid.strip(),
        'title': title,
        'date': date,
        'excerpt': excerpt if isinstance(excerpt, str) else '',
        'source': source,
    }


def parse_posts_js(text, source='data.js'):
    """解析 js/data.js 的 POSTS 数组（结构化扫描，非逐行正则）。"""
    start = find_assignment(text, 'POSTS')
    value, _ = _read_value(text, start)
    if not isinstance(value, list):
        raise FeedError('%s 中的 POSTS 不是数组' % source)
    return [_normalize_post(item, source, i) for i, item in enumerate(value)]


def parse_posts(path):
    """读取并解析 data.js（保留旧接口名）。"""
    if not os.path.isfile(path):
        raise FeedError('找不到数据文件: %s' % path)
    with open(path, encoding='utf-8') as f:
        return parse_posts_js(f.read(), os.path.basename(path))


def parse_user_posts(path, source='user-posts.js'):
    """解析 js/user-posts.js；文件不存在等价于“没有用户文章”。

    数组按括号配对截取（字符串内的 '];' 不会截断），再做严格 JSON 解析。
    """
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8') as f:
        text = f.read()
    start = find_assignment(text, 'USER_POSTS')
    if start >= len(text) or text[start] != '[':
        raise FeedError('%s 中的 USER_POSTS 不是数组字面量' % source)
    end = _skip_balanced(text, start)
    snippet = text[start:end]
    try:
        data = json.loads(snippet)
    except ValueError as e:
        raise FeedError('%s 不是合法 JSON: %s' % (source, e))
    if not isinstance(data, list):
        raise FeedError('%s 中的 USER_POSTS 不是数组' % source)
    return [_normalize_post(item, source, i) for i, item in enumerate(data)]


def dedupe_posts(posts):
    """按 id 去重：保留先出现的（data.js 优先于 user-posts.js），顺序确定。"""
    seen = set()
    unique = []
    duplicates = []
    for p in posts:
        if p['id'] in seen:
            duplicates.append(p['id'])
            continue
        seen.add(p['id'])
        unique.append(p)
    return unique, duplicates


# --------------------------------------------------------------------------
# RSS 生成
# --------------------------------------------------------------------------
def xml(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def _pub_date(date_str):
    dt = datetime.datetime.strptime(date_str, '%Y-%m-%d')
    return dt.strftime('%a, %d %b %Y 00:00:00 +0000')


def build_feed(posts, now=None):
    items = []
    for p in posts:
        link = '%s/#/post/%s' % (SITE, p['id'])
        desc = xml(p.get('excerpt') or p.get('title', ''))
        items.append(
            '    <item>\n'
            '      <title>%s</title>\n'
            '      <link>%s</link>\n'
            '      <guid>%s</guid>\n'
            '      <pubDate>%s</pubDate>\n'
            '      <description>%s</description>\n'
            '    </item>' % (xml(p['title']), link, link, _pub_date(p['date']), desc)
        )
    now = now or datetime.datetime.now(datetime.timezone.utc)
    build_stamp = now.astimezone(datetime.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0">\n'
        '  <channel>\n'
        '    <title>Eric\'s Notebook</title>\n'
        '    <link>%s</link>\n'
        '    <description>Eric 的个人技术随笔 — 智能制造、机器人、具身智能与生活思考</description>\n'
        '    <language>zh-CN</language>\n'
        '    <lastBuildDate>%s</lastBuildDate>\n'
        '%s\n'
        '  </channel>\n'
        '</rss>\n'
    ) % (SITE, build_stamp, '\n'.join(items))


def parse_now(value):
    if not value:
        return datetime.datetime.now(datetime.timezone.utc)
    raw = value.strip()
    if raw.endswith('Z'):
        raw = raw[:-1] + '+00:00'
    try:
        dt = datetime.datetime.fromisoformat(raw)
    except ValueError:
        raise FeedError('--now 不是合法的 ISO8601 时间: %r' % value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def write_atomic(path, text):
    """先写临时文件再替换，避免中途失败把合法 feed 写坏。"""
    out_dir = os.path.dirname(os.path.abspath(path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='从 js/data.js + js/user-posts.js 生成 RSS feed.xml')
    ap.add_argument('--data', default=DEFAULT_DATA, help='data.js 路径（默认脚本同目录 js/data.js）')
    ap.add_argument('--user-posts', default=DEFAULT_USER_POSTS, help='user-posts.js 路径')
    ap.add_argument('--out', default=DEFAULT_OUT, help='输出 feed.xml 路径')
    ap.add_argument('--now', help='固定 lastBuildDate（ISO8601），用于可重复生成')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        posts = parse_posts(args.data)
        posts += parse_user_posts(args.user_posts)
        posts, duplicates = dedupe_posts(posts)
        if not posts:
            raise FeedError('未解析到任何文章，已中止（不覆盖现有 feed.xml）')
        posts.sort(key=lambda p: p['date'], reverse=True)  # 稳定排序：同日保持数据源顺序
        feed = build_feed(posts, parse_now(args.now))
    except FeedError as e:
        print('[ABORT] %s' % e, file=sys.stderr)
        return 1

    for pid in duplicates:
        print('[WARN] 重复文章 id 已忽略后出现的那条: %s' % pid, file=sys.stderr)

    write_atomic(args.out, feed)
    print('feed.xml generated: %d posts -> %s' % (len(posts), args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
