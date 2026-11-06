#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习资料持久 ID Registry（Batch 7B-2）。

背景
----
js/papers.js 里的学习资料原先只有显示字段（名称 / 类型 / 大小 / 分类 / 子分类），
没有公开身份。任何"从现有字段拼出来"的目标键都会漂移：

    * 数组下标：重排 / 前插 / 删除其他条目后旧链接跳到别的资料（已复现）；
    * 内容指纹：文件大小、显示名、分类任意一项变化，旧链接就失效。

本模块维护一份**独立于元数据**的 ID 分配表：身份来源是资料在学习目录内的相对路径
（操作系统层面的原始身份），公开出去的只有 `lm-000123` 这种不透明序号。

规则
----
1. 新资料首次发现时分配 ID；后续扫描复用（不会被重排 / 改名 / 改分类影响）。
2. 元数据变化不产生新 ID；只有相对路径变化（重命名 / 移动）才需要显式迁移映射。
3. 资料消失后条目转为 ``retired``，ID 永久保留、绝不回收给其他资料。
4. Registry 损坏或出现 ID / 来源冲突时一律中止，绝不静默重建（否则所有旧链接会错位）。
5. 写入前自动备份为 ``<registry>.bak``；``restore_from_backup`` 提供显式恢复。
6. 重命名 / 移动：先看操作系统能否给出确定的文件身份（NTFS/APFS/ext4 的
   ``st_dev:st_ino``）。能确认且候选唯一时自动沿用原 ID 并记入 ``migrations``；
   确认不了就必须用 ``--migrations`` 显式声明，生成器绝不猜。

目录选择
--------
默认落在仓库根的 ``.papers-id/registry.json``：以点开头的目录不会被 Jekyll /
GitHub Pages 发布，且没有任何页面引用它。Registry 内只保存**相对路径**
（不含盘符、用户名、绝对路径），公开产物 js/papers.js 只写 ID。
"""
import copy
import datetime
import json
import os
import re
import sys

VERSION = 1
NAMESPACE = 'learning-materials'
ID_RE = re.compile(r'^lm-(\d{6})$')
# 文件系统身份提示：<st_dev>:<st_ino>，两者都是不透明整数（NTFS 文件索引等）
FILE_HINT_RE = re.compile(r'^\d+:\d+$')
ACTIVE = 'active'
RETIRED = 'retired'


class RegistryError(Exception):
    """Registry 相关错误的基类。"""


class RegistryCorrupt(RegistryError):
    """Registry 结构损坏 / 不可解析。必须中止，不得重建。"""


class RegistryConflict(RegistryError):
    """Registry 内部冲突（重复 ID / 重复来源 / 迁移目标被占用）。"""


# --------------------------------------------------------------------- 基础
def new_registry():
    return {
        'version': VERSION,
        'namespace': NAMESPACE,
        'nextId': 1,
        'entries': [],
        'migrations': [],
    }


def today_str(today=None):
    if today:
        return today
    return datetime.date.today().isoformat()


def normalize_source(source):
    """把相对路径规范化为正斜杠形式，并拒绝绝对路径 / 上跳路径。"""
    if not isinstance(source, str) or not source.strip():
        raise RegistryCorrupt('资料路径为空')
    s = source.replace('\\', '/').strip()
    while s.startswith('./'):
        s = s[2:]
    if s.startswith('/'):
        raise RegistryCorrupt('资料路径不能是绝对路径: %s' % source)
    if re.match(r'^[A-Za-z]:', s):
        raise RegistryCorrupt('资料路径不能包含盘符: %s' % source)
    if ':' in s:
        raise RegistryCorrupt('资料路径不能包含冒号: %s' % source)
    parts = [p for p in s.split('/') if p]
    if any(p == '..' for p in parts):
        raise RegistryCorrupt('资料路径不能包含上跳目录: %s' % source)
    if not parts:
        raise RegistryCorrupt('资料路径无效: %s' % source)
    return '/'.join(parts)


def make_id(seq):
    if seq < 1 or seq > 999999:
        raise RegistryError('ID 序号超出范围: %s' % seq)
    return 'lm-%06d' % seq


def id_seq(entry_id):
    m = ID_RE.match(entry_id or '')
    if not m:
        raise RegistryCorrupt('非法 ID（应形如 lm-000123）: %r' % (entry_id,))
    return int(m.group(1))


# --------------------------------------------------------------------- 校验
def validate(reg):
    """结构 + 唯一性校验；任何问题都抛异常（调用方必须中止，不得重建）。"""
    if not isinstance(reg, dict):
        raise RegistryCorrupt('Registry 顶层必须是对象')
    if reg.get('version') != VERSION:
        raise RegistryCorrupt('Registry 版本不支持: %r（期望 %d）' % (reg.get('version'), VERSION))
    if reg.get('namespace') != NAMESPACE:
        raise RegistryCorrupt('Registry 命名空间不匹配: %r' % (reg.get('namespace'),))

    next_id = reg.get('nextId')
    if not isinstance(next_id, int) or isinstance(next_id, bool) or next_id < 1:
        raise RegistryCorrupt('nextId 非法: %r' % (next_id,))

    entries = reg.get('entries')
    if not isinstance(entries, list):
        raise RegistryCorrupt('entries 必须是数组')

    ids = {}
    sources = {}
    max_seq = 0
    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            raise RegistryCorrupt('entries[%d] 不是对象' % i)
        eid = e.get('id')
        if not isinstance(eid, str):
            raise RegistryCorrupt('entries[%d].id 缺失' % i)
        seq = id_seq(eid)
        max_seq = max(max_seq, seq)
        if eid in ids:
            raise RegistryConflict('ID 冲突：%s 被多条记录占用' % eid)
        ids[eid] = e

        if e.get('state') not in (ACTIVE, RETIRED):
            raise RegistryCorrupt('entries[%d].state 非法: %r' % (i, e.get('state')))
        src = normalize_source(e.get('source'))
        if src != e.get('source'):
            raise RegistryCorrupt('entries[%d].source 未规范化: %r' % (i, e.get('source')))
        if src in sources:
            raise RegistryConflict('来源冲突：%s 同时指向 %s 与 %s' % (src, sources[src], eid))
        sources[src] = eid

        aliases = e.get('aliases') or []
        if not isinstance(aliases, list):
            raise RegistryCorrupt('entries[%d].aliases 必须是数组' % i)
        for a in aliases:
            na = normalize_source(a)
            if na in sources:
                raise RegistryConflict('来源冲突：别名 %s 已被 %s 占用' % (na, sources[na]))
            sources[na] = eid

        first = e.get('firstSeen')
        if not isinstance(first, str) or not first:
            raise RegistryCorrupt('entries[%d].firstSeen 非法: %r' % (i, first))
        if e['state'] == RETIRED and not isinstance(e.get('retiredAt'), str):
            raise RegistryCorrupt('entries[%d] 已 retired 但缺少 retiredAt' % i)
        hint = e.get('fileHint', '')
        if hint and not FILE_HINT_RE.match(hint):
            raise RegistryCorrupt('entries[%d].fileHint 非法: %r' % (i, hint))

    if next_id <= max_seq:
        raise RegistryConflict('nextId(%d) 必须大于已用最大序号(%d)' % (next_id, max_seq))

    mig = reg.get('migrations')
    if not isinstance(mig, list):
        raise RegistryCorrupt('migrations 必须是数组')
    for i, m in enumerate(mig):
        if not isinstance(m, dict) or 'from' not in m or 'to' not in m:
            raise RegistryCorrupt('migrations[%d] 结构非法' % i)
        normalize_source(m['from'])
        normalize_source(m['to'])

    return reg


# --------------------------------------------------------------------- 读写
def load(path, allow_missing=True):
    """读取并校验 Registry。

    ``allow_missing`` 只影响"文件不存在"；文件存在但损坏一律抛 RegistryCorrupt，
    绝不返回空表（避免静默重建所有 ID）。
    """
    if not os.path.isfile(path):
        if allow_missing:
            return None
        raise RegistryCorrupt('找不到 Registry: %s' % path)
    try:
        with open(path, encoding='utf-8') as fh:
            raw = fh.read()
    except OSError as e:
        raise RegistryCorrupt('Registry 读取失败: %s (%s)' % (path, e))
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise RegistryCorrupt('Registry 不是合法 JSON: %s (%s)' % (path, e))
    return validate(data)


def _dump(reg):
    return json.dumps(reg, ensure_ascii=False, indent=2, sort_keys=False) + '\n'


def save(path, reg, backup=True):
    """原子写入；内容有变化时先把旧文件备份为 <path>.bak。"""
    validate(reg)
    text = _dump(reg)
    out_dir = os.path.dirname(os.path.abspath(path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    old = None
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as fh:
            old = fh.read()
    if backup and old is not None and old != text:
        bak = path + '.bak'
        tmp_bak = bak + '.tmp'
        with open(tmp_bak, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(old)
        os.replace(tmp_bak, bak)

    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    os.replace(tmp, path)
    return path


def restore_from_backup(path):
    """从 <path>.bak 显式恢复；备份本身也要通过完整校验。"""
    bak = path + '.bak'
    if not os.path.isfile(bak):
        raise RegistryCorrupt('找不到备份: %s' % bak)
    reg = load(bak, allow_missing=False)
    os.replace(bak, path)
    return reg


# --------------------------------------------------------------------- 迁移
def apply_migrations(reg, migrations, today=None):
    """应用显式重命名 / 移动映射：[{'from': 旧相对路径, 'to': 新相对路径}]。

    不猜测：``from`` 找不到、``to`` 已被其他资料占用都直接报错。
    """
    if not migrations:
        return []
    validate(reg)
    day = today_str(today)
    applied = []
    for m in migrations:
        if not isinstance(m, dict) or 'from' not in m or 'to' not in m:
            raise RegistryConflict('迁移映射缺少 from/to: %r' % (m,))
        src = normalize_source(m['from'])
        dst = normalize_source(m['to'])
        if src == dst:
            continue
        entry = _entry_by_source(reg, src)
        if entry is None:
            raise RegistryConflict('迁移来源不在 Registry 中，拒绝猜测: %s' % src)
        if entry['state'] != ACTIVE:
            raise RegistryConflict('迁移来源已退役: %s' % src)
        other = _entry_by_source(reg, dst)
        if other is not None and other['id'] != entry['id']:
            raise RegistryConflict('迁移目标 %s 已被 %s 占用' % (dst, other['id']))
        entry['source'] = dst
        aliases = entry.setdefault('aliases', [])
        if src not in aliases:
            aliases.append(src)
        reg.setdefault('migrations', []).append({'from': src, 'to': dst, 'at': day})
        applied.append({'id': entry['id'], 'from': src, 'to': dst})
    validate(reg)
    return applied


def _entry_by_source(reg, source):
    for e in reg['entries']:
        if e['source'] == source:
            return e
        for a in e.get('aliases') or []:
            if a == source:
                return e
    return None


# --------------------------------------------------------------------- 对账
def _touch_hint(entry, hint):
    """记录文件系统身份提示；空提示不覆盖已有值（不同文件系统不保证给出）。"""
    if hint and entry.get('fileHint') != hint:
        entry['fileHint'] = hint


def _entry_by_file_hint(reg, hint, scanned, used_ids):
    """按文件系统身份找"唯一且确定"的原条目；否则返回 None（绝不猜）。"""
    if not hint:
        return None
    cands = [e for e in reg['entries']
             if e.get('fileHint') == hint
             and e['id'] not in used_ids
             and e['source'] not in scanned]
    return cands[0] if len(cands) == 1 else None


def reconcile(reg, items, today=None):
    """把一次扫描结果对账到 Registry。

    ``items`` 是本次实际扫描到的条目：相对路径字符串，
    或 ``(相对路径, 文件系统身份提示)`` 二元组。
    返回::

        {'ids': {source: id},
         'created': [...], 'revived': [...], 'retired': [...],
         'auto_migrations': [{'id','from','to','reason'}]}
    """
    validate(reg)
    day = today_str(today)

    pairs = []
    for it in items:
        if isinstance(it, (tuple, list)):
            src, hint = it[0], (it[1] or '')
        else:
            src, hint = it, ''
        hint = hint if isinstance(hint, str) and FILE_HINT_RE.match(hint) else ''
        pairs.append((normalize_source(src), hint))
    pairs.sort()
    scanned = set(s for s, _ in pairs)

    ids = {}
    created, revived, auto = [], [], []

    # 1) 路径（含历史别名）匹配：元数据怎么变都不影响身份
    pending = []
    for src, hint in pairs:
        entry = _entry_by_source(reg, src)
        if entry is None:
            pending.append((src, hint))
            continue
        if entry['state'] != ACTIVE:
            entry['state'] = ACTIVE
            entry.pop('retiredAt', None)
            revived.append(entry['id'])
        _touch_hint(entry, hint)
        ids[src] = entry['id']

    # 2) 路径变了：只有操作系统能确认是同一份文件时才沿用原 ID
    used = set(ids.values())
    for src, hint in pending:
        entry = _entry_by_file_hint(reg, hint, scanned, used)
        if entry is not None:
            old = entry['source']
            aliases = entry.setdefault('aliases', [])
            if old != src and old not in aliases:
                aliases.append(old)
            entry['source'] = src
            entry['state'] = ACTIVE
            entry.pop('retiredAt', None)
            _touch_hint(entry, hint)
            reg.setdefault('migrations', []).append(
                {'from': old, 'to': src, 'at': day, 'auto': 'fileId'})
            auto.append({'id': entry['id'], 'from': old, 'to': src, 'reason': 'fileId'})
            ids[src] = entry['id']
            used.add(entry['id'])
            continue

        seq = reg['nextId']
        entry = {
            'id': make_id(seq),
            'source': src,
            'state': ACTIVE,
            'firstSeen': day,
            'aliases': [],
        }
        if hint:
            entry['fileHint'] = hint
        reg['nextId'] = seq + 1
        reg['entries'].append(entry)
        created.append(entry['id'])
        ids[src] = entry['id']
        used.add(entry['id'])

    retired = []
    for entry in reg['entries']:
        if entry['state'] == ACTIVE and entry['id'] not in used:
            entry['state'] = RETIRED
            entry['retiredAt'] = day
            retired.append(entry['id'])

    validate(reg)
    return {
        'ids': ids,
        'created': created,
        'revived': revived,
        'retired': retired,
        'auto_migrations': auto,
    }


def snapshot(reg):
    return copy.deepcopy(reg)


def ids_in_js(text):
    """从已生成的 papers.js 文本里收集资料 ID（用于判断"已发布过 ID"）。"""
    return set(re.findall(r'"id":\s*"(lm-\d{6})"', text or ''))


def describe(reg):
    active = [e for e in reg['entries'] if e['state'] == ACTIVE]
    retired = [e for e in reg['entries'] if e['state'] == RETIRED]
    return 'active=%d retired=%d nextId=%s' % (len(active), len(retired), reg['nextId'])


if __name__ == '__main__':  # 便于手工排查：python scripts/papers_id_registry.py <path>
    p = sys.argv[1] if len(sys.argv) > 1 else '.papers-id/registry.json'
    try:
        reg = load(p, allow_missing=False)
        print('OK %s  %s' % (p, describe(reg)))
    except RegistryError as e:
        print('FAIL %s: %s' % (p, e))
        sys.exit(1)
