#!/usr/bin/env node
'use strict';
/**
 * Batch 8E-4R：snapshotReady 轻量专项（无浏览器）
 *
 * 目的：
 *   - 快照完整时缓存成功结果，重复调用不再重复检查；
 *   - 同时发起的检查共享同一个 Promise（不会创建多余任务）；
 *   - 快照缺失 / 检查异常时，后续调用必须重新判断（失败状态不得永久缓存）；
 *   - 首屏资源完整性清单保持不变。
 *
 * 做法：把真实 sw.js 载入 Node vm 上下文，提供最小 self / caches 替身，
 *       直接调用 snapshotReady()。不改动生产代码，不依赖 Chromium CDP。
 * 注意：本文件**不注册**进 scripts/run_tests.py（默认 64 套与 CI 命令保持不变）。
 *
 * 用法：node tests/browser/sw-snapshot-unit.spec.js
 * 退出码：0 通过；1 失败。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const VERSION = (/CACHE_VERSION = '([^']+)'/.exec(SRC) || [])[1];
const PREV_VERSION = '2026-11-18-1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function makeHarness() {
  const present = new Set();
  const stats = { matchCalls: 0 };
  const listeners = {};
  let mode = 'ok';

  const cacheObj = {
    add: function (u) { present.add(String(u)); return Promise.resolve(); },
    put: function (req) { present.add(String(req && req.url ? req.url : req)); return Promise.resolve(); },
    keys: function () { return Promise.resolve(Array.from(present).map(function (u) { return { url: u }; })); },
    delete: function () { return Promise.resolve(true); },
    match: function (req) {
      const u = String(req && req.url ? req.url : req);
      return Promise.resolve(present.has(u) ? { ok: true } : undefined);
    }
  };

  const sandbox = {
    self: {
      addEventListener: function (t, f) { listeners[t] = f; },
      location: { href: 'https://example.test/blog/sw.js' },
      registration: { scope: 'https://example.test/blog/' },
      clients: { claim: function () { return Promise.resolve(); } },
      skipWaiting: function () { return Promise.resolve(); }
    },
    caches: {
      match: function (url) {
        stats.matchCalls++;
        if (mode === 'reject') return Promise.reject(new Error('injected caches.match rejection'));
        if (mode === 'throw') throw new Error('injected caches.match throw');
        return Promise.resolve(present.has(String(url)) ? { ok: true } : undefined);
      },
      open: function () { return Promise.resolve(cacheObj); },
      keys: function () { return Promise.resolve(Array.from(present)); },
      delete: function () { return Promise.resolve(true); }
    },
    console: console,
    URL: URL,
    Promise: Promise,
    Map: Map,
    Date: Date,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Response: function () { this.ok = false; },
    Request: function (u) { this.url = String(u); },
    fetch: function () { return Promise.resolve({ ok: true, clone: function () { return this; } }); }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    SRC + '\n;globalThis.__snapshotReady = snapshotReady;' +
    '\n;globalThis.__cacheVersion = CACHE_VERSION;' +
    '\n;globalThis.__firstScreen = FIRST_SCREEN_ASSETS.slice();',
    ctx,
    { filename: 'sw.js' }
  );

  return {
    snapshotReady: ctx.__snapshotReady,
    version: ctx.__cacheVersion,
    firstScreen: ctx.__firstScreen,
    stats: stats,
    present: present,
    allKeys: ['https://example.test/blog/index.html'].concat(
      ctx.__firstScreen.map(function (k) { return new URL(k, 'https://example.test/blog/sw.js').href; })
    ),
    setMode: function (m) { mode = m; }
  };
}

function fillAll(h) { h.allKeys.forEach(function (u) { h.present.add(u); }); }

(async function main() {
  // U0：版本号必须是“相对上一版递增”的发布契约（不把日期写死在断言里）
  check('U0 CACHE_VERSION 满足 YYYY-MM-DD-N 且已递增',
    /^\d{4}-\d{2}-\d{2}-\d+$/.test(VERSION || '') && VERSION > PREV_VERSION,
    VERSION);

  // U0b：首屏完整性清单未被改动（本轮不允许放宽快照门槛）
  const h0 = makeHarness();
  check('U0b 首屏资源清单保持 7 项（含知识库与相关推荐模块）',
    h0.firstScreen.length === 7 &&
    h0.firstScreen.indexOf('js/app.js') !== -1 &&
    h0.firstScreen.indexOf('js/knowledge.js') !== -1 &&
    h0.firstScreen.indexOf('js/related.js') !== -1 &&
    h0.firstScreen.indexOf('js/projects.js') !== -1,
    h0.firstScreen.join(','));

  // U1：并发调用共享同一 Promise，且只检查一次；成功后结果被缓存
  const h1 = makeHarness();
  fillAll(h1);
  const before1 = h1.stats.matchCalls;
  const p1 = h1.snapshotReady();
  const p2 = h1.snapshotReady();
  const samePromise = p1 === p2;
  const r1 = await p1;
  await p2;
  const calls1 = h1.stats.matchCalls - before1;
  check('U1a 并发的完整性检查共享同一 Promise', samePromise);
  check('U1b 并发检查只创建一轮检查任务', calls1 === h1.allKeys.length, 'matchCalls=' + calls1);
  check('U1c 快照完整时返回 true', r1 === true, String(r1));
  const p3 = h1.snapshotReady();
  const calls2 = h1.stats.matchCalls - before1;
  check('U1d 成功结果被缓存（同一 Promise、无额外检查）', p3 === p1 && calls2 === h1.allKeys.length, 'matchCalls=' + calls2);

  // U2：快照缺失 → false；再次调用仍必须重新检查；恢复后同生命周期返回 true
  const h2 = makeHarness();
  fillAll(h2);
  const probe = h2.allKeys[2];
  h2.present.delete(probe);                 // 首次判定时就缺一条：模拟安装期缓存异常
  const before2 = h2.stats.matchCalls;
  const r2 = await h2.snapshotReady();
  const calls3 = h2.stats.matchCalls - before2;
  check('U2a 快照缺失时返回 false', r2 === false, String(r2));
  check('U2b 缺失时确实执行了一轮检查', calls3 === h2.allKeys.length, 'matchCalls=' + calls3);

  const before3 = h2.stats.matchCalls;
  const r2b = await h2.snapshotReady();
  const calls4 = h2.stats.matchCalls - before3;
  check('U2c 失败状态未被缓存：再次调用会重新检查',
    calls4 === h2.allKeys.length && r2b === false, 'matchCalls=' + calls4 + ' result=' + r2b);

  h2.present.add(probe);
  const r3 = await h2.snapshotReady();
  check('U2d 恢复资源后同一生命周期重新判定为 true（自愈）', r3 === true, String(r3));

  const before4 = h2.stats.matchCalls;
  const r4 = await h2.snapshotReady();
  check('U2e 自愈后成功结果重新被缓存',
    r4 === true && h2.stats.matchCalls - before4 === 0, 'matchCalls=' + (h2.stats.matchCalls - before4));

  // U3：检查异常（Promise reject / 同步抛错）后可重新判断
  const h3 = makeHarness();
  fillAll(h3);
  h3.setMode('reject');
  const rReject = await h3.snapshotReady();
  h3.setMode('ok');
  const rAfterReject = await h3.snapshotReady();
  check('U3a 检查 reject 时返回 false', rReject === false, String(rReject));
  check('U3b reject 解除后重新判断为 true', rAfterReject === true, String(rAfterReject));

  const h4 = makeHarness();
  fillAll(h4);
  h4.setMode('throw');
  let rThrow = null;
  let throwEscaped = false;
  try { rThrow = await h4.snapshotReady(); } catch (e) { throwEscaped = true; }
  h4.setMode('ok');
  const rAfterThrow = await h4.snapshotReady();
  check('U3c 同步抛错被吞掉并返回 false', throwEscaped === false && rThrow === false, 'escaped=' + throwEscaped);
  check('U3d 抛错解除后重新判断为 true', rAfterThrow === true, String(rAfterThrow));

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('SPEC ERROR:', e && e.stack || e);
  process.exit(1);
});
