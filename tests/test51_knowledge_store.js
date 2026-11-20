#!/usr/bin/env node
'use strict';
/**
 * Batch 9A-1：知识库数据层专项（无浏览器）
 *
 * 通过 vm 加载真实 js/knowledge.js，注入可控后端，覆盖：
 *   稳定键 / 特殊字符 ID / 幂等 / 字段级并发 / 历史裁剪保护 / 进度与状态 /
 *   30s 去重 / 导出结构 / 配额重试 / 写入失败降级 / 多标签通知 / schemaVersion。
 *
 * 用法：node tests/test51_knowledge_store.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'knowledge.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

// 共享后端：读-改-写在队列内完成，语义与 IDB readwrite 事务一致
function makeBackend() {
  const map = new Map();
  const meta = new Map();
  const state = { failMode: '', matchFail: '', setTimeout: null };
  let chain = Promise.resolve();
  function enqueue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(function () { });
    return p;
  }
  return {
    state: state,
    map: map,
    kind: 'memory',
    get(key) { return Promise.resolve(map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null); },
    getAll() { return Promise.resolve(Array.from(map.values()).map(function (r) { return JSON.parse(JSON.stringify(r)); })); },
    getMeta(k) { return Promise.resolve(meta.has(k) ? meta.get(k) : null); },
    setMeta(k, v) { meta.set(k, v); return Promise.resolve(); },
    mutate(key, updater) {
      return enqueue(function () {
        if (state.failMode === 'throw') throw new Error('injected tx failure');
        const cur = map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
        const next = updater(cur);
        if (next === null) map.delete(key);
        else if (next !== undefined) map.set(key, JSON.parse(JSON.stringify(next)));
        return next === undefined ? cur : next;
      });
    },
    clear() { map.clear(); return Promise.resolve(); }
  };
}

// 多标签：同名 channel 之间互相投递
const channels = [];
function makeChannelClass() {
  return class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
    postMessage(data) {
      channels.forEach(function (c) {
        if (c !== this && c.name === this.name && typeof c.onmessage === 'function') {
          setTimeout(function () { c.onmessage({ data: data }); }, 0);
        }
      }, this);
    }
    close() { }
  };
}

function loadModule(backend) {
  const listeners = {};
  const store = new Map();
  const sandbox = {
    window: null,
    console: console,
    Promise: Promise,
    Map: Map,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Error: Error,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    BroadcastChannel: makeChannelClass()
  };
  sandbox.window = {
    addEventListener: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
    localStorage: {
      getItem: function (k) { return store.has(k) ? store.get(k) : null; },
      setItem: function (k, v) { store.set(k, String(v)); },
      removeItem: function (k) { store.delete(k); }
    }
  };
  sandbox.localStorage = sandbox.window.localStorage;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: 'js/knowledge.js' });
  const api = sandbox.window.Knowledge;
  if (backend) api._injectBackend(backend);
  return { api: api, store: store, listeners: listeners };
}

function seed(backend, n, extra) {
  let seq = Promise.resolve();
  for (let i = 0; i < n; i++) {
    const rec = Object.assign({
      key: 'post:seed-' + i, type: 'post', refId: 'seed-' + i, title: 'S' + i,
      fav: 0, favAt: 0, favCat: 'default', later: 0, laterAt: 0,
      readState: 'none', progress: 0,
      firstSeenAt: i + 1, lastSeenAt: i + 1, doneAt: 0, updatedAt: i + 1
    }, extra || {});
    seq = seq.then(function () { return backend.mutate(rec.key, function () { return rec; }); });
  }
  return seq;
}

(async function main() {
  // T1 无 IndexedDB：降级内存，状态可见，不抛异常
  const m1 = loadModule(null);
  const st1 = await m1.api.init();
  check('T1 无 IndexedDB 时降级内存并返回 degraded', st1.degraded === true && m1.api.status().usingMemory === true,
    JSON.stringify(st1));

  // T2 稳定键：特殊字符课程 ID 原样保存
  const b2 = makeBackend();
  const m2 = loadModule(b2);
  await m2.api.init();
  const courseId = '本科课程|机器人与自动化 (CS422)';
  await m2.api.setFlag('course', courseId, 'fav', true, { title: '机器人与自动化' });
  const rec2 = b2.map.get('course:' + courseId);
  check('T2 特殊字符 ID 使用 type:refId 原样保存',
    !!rec2 && rec2.refId === courseId && rec2.fav === 1, rec2 && rec2.key);

  // T3 收藏/待读幂等且相互独立
  const b3 = makeBackend();
  const m3 = loadModule(b3);
  await m3.api.init();
  await m3.api.setFlag('post', 'p1', 'fav', true, { title: 'P1' });
  await m3.api.setFlag('post', 'p1', 'fav', true, { title: 'P1' });
  await m3.api.setFlag('post', 'p1', 'later', true, { title: 'P1' });
  const r3 = b3.map.get('post:p1');
  check('T3 重复收藏幂等且与待读互不影响', r3.fav === 1 && r3.later === 1, JSON.stringify({ fav: r3.fav, later: r3.later }));

  // T4 字段级并发：收藏与进度同时更新，两个字段都保留
  const b4 = makeBackend();
  const m4 = loadModule(b4);
  await m4.api.init();
  await m4.api.recordView('post', 'p2', { title: 'P2' });
  await Promise.all([
    m4.api.setFlag('post', 'p2', 'fav', true),
    m4.api.saveProgress('post', 'p2', 0.42)
  ]);
  const r4 = b4.map.get('post:p2');
  check('T4 并发写入保留独立字段（fav + progress）', r4.fav === 1 && r4.progress === 0.42,
    JSON.stringify({ fav: r4.fav, progress: r4.progress }));

  // T5 进度阈值 → 阅读状态
  const b5 = makeBackend();
  const m5 = loadModule(b5);
  await m5.api.init();
  await m5.api.recordView('post', 'p3', { title: 'P3' });
  await m5.api.saveProgress('post', 'p3', 0.5);
  const stateReading = b5.map.get('post:p3').readState;
  await m5.api.saveProgress('post', 'p3', 0.99);
  const stateDone = b5.map.get('post:p3').readState;
  check('T5 进度阈值映射 reading / done', stateReading === 'reading' && stateDone === 'done',
    stateReading + '/' + stateDone);

  // T6 30s 内重复访问不更新时间
  const b6 = makeBackend();
  const m6 = loadModule(b6);
  await m6.api.init();
  let clock = 1000000;
  m6.api._setNow(function () { return clock; });
  await m6.api.recordView('post', 'p4', { title: 'P4' });
  const t1 = b6.map.get('post:p4').lastSeenAt;
  clock += 5000;
  await m6.api.recordView('post', 'p4', { title: 'P4' });
  const t2 = b6.map.get('post:p4').lastSeenAt;
  clock += 40000;
  await m6.api.recordView('post', 'p4', { title: 'P4' });
  const t3 = b6.map.get('post:p4').lastSeenAt;
  check('T6 30s 去重生效，超过后更新', t1 === t2 && t3 > t2, t1 + '/' + t2 + '/' + t3);

  // T7 历史裁剪：只清历史字段，受保护记录不丢
  const b7 = makeBackend();
  const m7 = loadModule(b7);
  await m7.api.init();
  await seed(b7, 505, { readState: 'none' });
  b7.map.get('post:seed-0').fav = 1;
  b7.map.get('post:seed-1').later = 1;
  b7.map.get('post:seed-2').readState = 'reading';
  let c7 = 10000000;
  m7.api._setNow(function () { return c7++; });
  await m7.api.recordView('post', 'fresh', { title: 'fresh' });
  await new Promise(function (r) { setTimeout(r, 120); });
  const total7 = b7.map.size;
  const hist7 = Array.from(b7.map.values()).filter(function (r) { return r.lastSeenAt > 0; }).length;
  check('T7 历史裁剪到 500 且受保护记录保留',
    hist7 <= 500 && b7.map.has('post:seed-0') && b7.map.has('post:seed-1') && b7.map.has('post:seed-2'),
    'total=' + total7 + ' history=' + hist7);

  // T8 删除历史不删除收藏/待读；无其他状态则整条删除
  const b8 = makeBackend();
  const m8 = loadModule(b8);
  await m8.api.init();
  await m8.api.recordView('post', 'plain', { title: 'plain' });
  await m8.api.recordView('post', 'kept', { title: 'kept' });
  await m8.api.setFlag('post', 'kept', 'fav', true);
  await m8.api.clearHistory('post:plain');
  await m8.api.clearHistory('post:kept');
  check('T8 清历史保留收藏记录、删除纯历史记录',
    !b8.map.has('post:plain') && b8.map.has('post:kept') && b8.map.get('post:kept').lastSeenAt === 0,
    JSON.stringify(Array.from(b8.map.keys())));

  // T9 配额异常：裁剪一次后重试成功
  const b9 = makeBackend();
  const m9 = loadModule(b9);
  await m9.api.init();
  await seed(b9, 520, {});
  let first = true;
  const realMutate = b9.mutate;
  b9.mutate = function (key, updater) {
    if (first && key === 'post:quota-probe') {
      first = false;
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      return Promise.reject(err);
    }
    return realMutate.call(b9, key, updater);
  };
  const r9 = await m9.api.setFlag('post', 'quota-probe', 'fav', true, { title: 'Q' });
  check('T9 配额异常裁剪重试后写入成功', !!r9 && b9.map.has('post:quota-probe'), r9 ? 'saved' : 'lost');

  // T10 写入事务失败 → 降级内存 + 不抛出，UI 可感知
  const b10 = makeBackend();
  const m10 = loadModule(b10);
  await m10.api.init();
  b10.state.failMode = 'throw';
  let threw = false;
  let r10 = null;
  try { r10 = await m10.api.setFlag('post', 'x', 'fav', true); } catch (e) { threw = true; }
  check('T10 写入失败不抛出并降级为内存', threw === false && r10 === null && m10.api.status().usingMemory === true,
    JSON.stringify(m10.api.status()));

  // T11 导出：结构、kind、schemaVersion、不含草稿/令牌字段
  const b11 = makeBackend();
  const m11 = loadModule(b11);
  await m11.api.init();
  await m11.api.recordView('post', 'e1', { title: '导出标题' });
  await m11.api.setFlag('post', 'e1', 'fav', true);
  const dump = await m11.api.exportData();
  const keys = Object.keys(dump).sort().join(',');
  const rec = dump.records[0] || {};
  check('T11 导出结构完整且不含敏感字段',
    dump.kind === 'knowledge' && dump.schemaVersion === 1 && !!dump.exportedAt &&
    Array.isArray(dump.records) && rec.key === 'post:e1' &&
    !('gh_token' in rec) && !('content' in rec),
    keys);

  // T12 多标签：A 写入后 B 收到通知并读到最新数据（同一后端）
  const b12 = makeBackend();
  const mA = loadModule(b12);
  const mB = loadModule(b12);
  await mA.api.init();
  await mB.api.init();
  let notified = 0;
  mB.api.subscribe(function () { notified++; });
  await mA.api.setFlag('post', 'shared', 'fav', true, { title: '共享' });
  await new Promise(function (r) { setTimeout(r, 80); });
  const seen = mB.api.state('post', 'shared');
  check('T12 多标签通知后对方读到最新状态', notified > 0 && !!seen && seen.fav === 1,
    'notified=' + notified + ' seen=' + (seen ? seen.fav : 'null'));

  // T13 schemaVersion 写入 meta
  const b13 = makeBackend();
  const m13 = loadModule(b13);
  await m13.api.init();
  check('T13 数据库记录 schemaVersion=1', (await b13.getMeta('schemaVersion')) === 1,
    String(await b13.getMeta('schemaVersion')));

  // T14 不触碰编辑器/主题类键（只写自己的 ping）
  const b14 = makeBackend();
  const m14 = loadModule(b14);
  m14.store.set('blog_draft', '{"title":"draft"}');
  m14.store.set('theme', 'dark');
  await m14.api.init();
  await m14.api.setFlag('post', 'k', 'fav', true);
  check('T14 不修改草稿与主题键',
    m14.store.get('blog_draft') === '{"title":"draft"}' && m14.store.get('theme') === 'dark',
    Array.from(m14.store.keys()).join(','));

  // T15 记录总量上限：达到 2000 后不再新增
  const b15 = makeBackend();
  const m15 = loadModule(b15);
  await m15.api.init();
  await seed(b15, 2000, { lastSeenAt: 0, firstSeenAt: 0 });
  await m15.api.refresh();
  let t15 = 20000000;
  m15.api._setNow(function () { return t15++; });
  await m15.api.recordView('post', 'overflow', { title: 'overflow' });
  check('T15 记录总量达到上限后不新增', !b15.map.has('post:overflow'), 'size=' + b15.map.size);

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('SPEC ERROR:', e && e.stack || e);
  process.exit(1);
});
