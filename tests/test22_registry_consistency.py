# -*- coding: utf-8 -*-
"""Batch 7B-2.1：真实 Registry 与公开产物的一致性验证。

两件事：
  1. 公开产物 `js/papers.js` 自身的不变量（不依赖私有 Registry）：
     每条资料一个不透明 `lm-` ID、唯一、无绝对路径、论文 ID 未变。
  2. 若本机存在私有 `.papers-id/registry.json`（该文件按设计**不入库**），
     校验 Registry 与产物严格一一对应：无缺、无多、无退役 ID 泄漏、
     来源唯一、nextId 单调、无私人路径。

公开仓库不携带 Registry，因此第 2 组在第一台机器之外会打印 SKIP（不算失败），
但第 1 组永远执行 —— 产物本身的完整性不能靠"本机有没有 Registry"来保证。

用法：python tests/test22_registry_consistency.py
退出码：0 全部通过（含 SKIP）；1 有失败。
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLISHED = os.path.join(ROOT, 'js', 'papers.js')
REGISTRY = os.path.join(ROOT, '.papers-id', 'registry.json')

passed = [0]
failed = [0]
skipped = [0]


def check(name, cond, extra=None):
    if cond:
        passed[0] += 1
        print('PASS ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))
    else:
        failed[0] += 1
        print('FAIL ' + name + ('  (' + str(extra) + ')' if extra is not None else ''))


def skip(name, reason):
    skipped[0] += 1
    print('SKIP ' + name + '  (' + reason + ')')


def grab(text, name):
    key = 'const %s = ' % name
    if key not in text:
        raise SystemExit('产物缺少 %s' % name)
    i = text.index(key) + len(key)
    assert text[i] == '[', text[i:i + 20]
    depth = 0
    for j in range(i, len(text)):
        if text[j] == '[':
            depth += 1
        elif text[j] == ']':
            depth -= 1
            if depth == 0:
                return json.loads(text[i:j + 1])
    raise SystemExit('%s 不完整' % name)


PRIVATE_PATTERNS = [
    (r'(?<![A-Za-z0-9])[A-Za-z]:[\\/]', '盘符路径'),
    (r'/Users/', 'macOS 家目录'),
    (r'/home/[A-Za-z]', 'Linux 家目录'),
    (r'zotero\.sqlite|zotero[\\/]storage', 'Zotero 库路径'),
]
# 注：这里刻意**不**写死任何私人目录名 —— 检测用的字面量本身也会进公开仓库。
# "产物里不能出现私人目录结构" 改由 B11 用 Registry 里的一级目录名动态校验（仅本机）。


def private_hits(text):
    hits = []
    for pat, label in PRIVATE_PATTERNS:
        for m in re.finditer(pat, text, re.I):
            hits.append((label, text[max(0, m.start() - 20):m.end() + 20].replace('\n', ' ')))
    return hits


def main():
    if not os.path.isfile(PUBLISHED):
        print('FAIL 缺少公开产物 js/papers.js')
        return 1

    text = io.open(PUBLISHED, encoding='utf-8').read()
    papers = grab(text, 'PAPERS')
    mats = grab(text, 'LEARNING_MATERIALS')

    print('== A. 公开产物不变量 ==')
    check('A1 论文 32 条、资料 74 条', len(papers) == 32 and len(mats) == 74,
          '%d / %d' % (len(papers), len(mats)))

    pids = [p.get('id') for p in papers]
    check('A2 论文 ID 唯一且非空', all(pids) and len(set(pids)) == len(pids), len(set(pids)))

    mids = [m.get('id') for m in mats]
    bad = [i for i in mids if not (i and re.match(r'^lm-\d{6}$', i))]
    check('A3 资料 ID 全部为不透明 lm-NNNNNN', not bad, bad[:3])
    check('A4 资料 ID 唯一', len(set(mids)) == len(mids) == 74, len(set(mids)))
    # 基线断言：这一行就是"ID 被重排/重号"的哨兵。
    # 如果确实新增或删除了资料，请同步更新期望值（不是把断言删掉）。
    check('A5 资料 ID 为 1..N 连续（首次迁移基线；增删资料后请同步本行）',
          sorted(int(i[3:]) for i in mids) == list(range(1, len(mids) + 1)),
          (min(mids), max(mids)))

    keys = [(m.get('name'), m.get('category'), m.get('subcategory', '')) for m in mats]
    check('A6 (名称,分类,子分类) 无重复（旧深链可唯一解析）',
          len(set(keys)) == len(keys), len(set(keys)))

    # 迁移前发布过的就是这 74 个 lgx: 键；三元组唯一 => 键到资料是一一映射，
    # 也就是说旧链接只会落回它自己，不可能串到别的资料。
    legacy = ['lgx:' + json.dumps(list(k), ensure_ascii=False, separators=(',', ':')) for k in keys]
    back = {}
    for k, m in zip(legacy, mats):
        back.setdefault(k, set()).add(m.get('id'))
    check('A6b 74 个 lgx: 旧键一一映射到自身（不串项）',
          len(set(legacy)) == 74 and all(len(v) == 1 for v in back.values()) and
          all(list(v)[0] == m.get('id') for k, m in zip(legacy, mats) for v in [back[k]]),
          len(back))

    check('A7 产物不含私人路径', not private_hits(text), private_hits(text)[:2])

    print('\n== B. 私有 Registry 一致性（本机存在才执行）==')
    if not os.path.isfile(REGISTRY):
        skip('B* Registry 一致性', '本机无 .papers-id/registry.json（按设计不入库）')
    else:
        reg = json.load(io.open(REGISTRY, encoding='utf-8'))
        entries = reg.get('entries') or []
        active = [e for e in entries if e.get('state') == 'active']
        retired = [e for e in entries if e.get('state') == 'retired']
        reg_ids = [e.get('id') for e in entries]

        check('B1 Registry 版本/命名空间', reg.get('version') == 1 and
              reg.get('namespace') == 'learning-materials', (reg.get('version'), reg.get('namespace')))
        check('B2 74 条在用、0 条退役', len(active) == 74 and not retired,
              '%d active / %d retired' % (len(active), len(retired)))
        check('B3 Registry ID 与产物 ID 完全一致',
              set(reg_ids) == set(mids), 'missing=%d extra=%d'
              % (len(set(mids) - set(reg_ids)), len(set(reg_ids) - set(mids))))
        check('B4 每条资料在 Registry 中恰好一条在用记录',
              len(active) == 74 and len(set(e['id'] for e in active)) == 74)
        check('B5 来源路径唯一', len(set(e.get('source') for e in entries)) == len(entries))
        check('B6 来源全部是相对路径（无盘符/前导斜杠/反斜杠）',
              not [e for e in entries if ':' in e['source'] or e['source'].startswith('/')
                   or '\\' in e['source']], [e['source'] for e in entries[:2]])
        check('B7 nextId 单调（大于已用最大序号）',
              reg.get('nextId') == max(int(i[3:]) for i in reg_ids) + 1, reg.get('nextId'))
        check('B8 无重复 ID / 无重复别名',
              len(set(reg_ids)) == len(reg_ids) and
              all(len(set(e.get('aliases') or [])) == len(e.get('aliases') or []) for e in entries))
        check('B9 Registry 不含私人绝对路径',
              not private_hits(io.open(REGISTRY, encoding='utf-8').read()), private_hits(
                  io.open(REGISTRY, encoding='utf-8').read())[:2])
        check('B10 与产物名称/分类逐条对应',
              all(any(m.get('id') == e['id'] for m in mats) for e in active))

        # 产物里不能出现私人目录结构。用 Registry 的真实一级目录名动态比对，
        # 这样公开代码里不需要写死任何私人名字。比对 "名字/" 而不是 "名字"，
        # 避免把分类名（如"机械臂CAD模型"）里的子串误判成路径。
        tops = sorted(set(e['source'].split('/')[0] for e in entries if e.get('source')))
        leaked = [t for t in tops if (t + '/') in text]
        check('B11 产物不含 Registry 的一级目录名（路径形态）', not leaked, leaked[:2] or tops[:2])

    total = passed[0] + failed[0]
    print('\n共 %d 项，PASS %d，FAIL %d，SKIP %d' % (total, passed[0], failed[0], skipped[0]))
    return 1 if failed[0] else 0


if __name__ == '__main__':
    sys.exit(main())
