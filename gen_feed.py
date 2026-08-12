#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 RSS feed.xml（RSS 2.0）。
运行: python gen_feed.py
说明: 从 js/data.js 提取文章元数据，生成根目录 feed.xml。
      新增/修改文章后重新运行即可更新订阅源。
"""
import re
import datetime

SITE = 'https://ericzhao666.github.io/blog'


def xml(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def parse_posts(path):
    with open(path, encoding='utf-8') as f:
        content = f.read()
    posts = []
    cur = {}
    for line in content.split('\n'):
        m = re.match(r"\s*id:\s*'([^']+)'", line)
        if m:
            cur = {'id': m.group(1)}
        m = re.match(r"\s*title:\s*'([^']*)'", line)
        if m and 'id' in cur:
            cur['title'] = m.group(1)
        m = re.match(r"\s*date:\s*'([^']+)'", line)
        if m and 'id' in cur:
            cur['date'] = m.group(1)
        m = re.match(r"\s*excerpt:\s*'(.*)'", line)
        if m and 'id' in cur and 'excerpt' not in cur:
            cur['excerpt'] = m.group(1).rstrip(',').strip()
        if line.strip() == '},' and cur.get('id'):
            posts.append(cur)
            cur = {}
    if cur.get('id'):
        posts.append(cur)
    return posts


def build_feed(posts):
    items = []
    for p in posts:
        try:
            dt = datetime.datetime.strptime(p['date'], '%Y-%m-%d')
            pub = dt.strftime('%a, %d %b %Y 00:00:00 +0000')
        except Exception:
            pub = datetime.datetime.utcnow().strftime('%a, %d %b %Y 00:00:00 +0000')
        link = '%s/#/post/%s' % (SITE, p['id'])
        desc = xml(p.get('excerpt', p.get('title', '')))
        items.append(
            '    <item>\n'
            '      <title>%s</title>\n'
            '      <link>%s</link>\n'
            '      <guid>%s</guid>\n'
            '      <pubDate>%s</pubDate>\n'
            '      <description>%s</description>\n'
            '    </item>' % (xml(p.get('title', '')), link, link, pub, desc)
        )
    feed = (
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
    ) % (SITE, datetime.datetime.utcnow().strftime('%a, %d %b %Y %H:%M:%S +0000'), '\n'.join(items))
    return feed


def main():
    posts = parse_posts('js/data.js')
    # 按日期倒序
    posts.sort(key=lambda p: p.get('date', ''), reverse=True)
    feed = build_feed(posts)
    with open('feed.xml', 'w', encoding='utf-8') as f:
        f.write(feed)
    print('feed.xml generated: %d posts' % len(posts))


if __name__ == '__main__':
    main()
