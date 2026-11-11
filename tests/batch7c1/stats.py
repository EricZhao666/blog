# -*- coding: utf-8 -*-
"""Batch 7C-1：采集发布链路的规模数据（只读）。"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def size(rel):
    p = os.path.join(ROOT, rel)
    return os.path.getsize(p) if os.path.isfile(p) else -1


def read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


data_js = read('js/data.js')
posts = data_js.count("    id: '")
md = sorted(f for f in os.listdir(os.path.join(ROOT, 'data', 'posts')) if f.endswith('.md'))
idx = json.load(io.open(os.path.join(ROOT, 'data', 'search-index.json'), encoding='utf-8'))
man = json.load(io.open(os.path.join(ROOT, 'data', 'posts', 'manifest.json'), encoding='utf-8'))
feed = read('feed.xml')

print('POSTS 条目          :', posts)
print('data/posts/*.md     :', len(md))
print('search-index keys   :', len(idx))
print('manifest posts      :', len(man['posts']))
print('manifest version    :', man.get('version'))
print('feed <item>         :', feed.count('<item>'))
print()
for rel in ['js/data.js', 'js/user-posts.js', 'js/app.js', 'data/search-index.json',
            'data/posts/manifest.json', 'feed.xml', 'sitemap.xml', 'index.html', 'sw.js']:
    print('%-28s %8d B' % (rel, size(rel)))
print()
print('md 文件总字节       :', sum(size(os.path.join('data', 'posts', f)) for f in md))
print('search-index 覆盖 id:', 'ok' if set(idx.keys()) == set(p['id'] for p in man['posts']) else 'MISMATCH')
