/**
 * Batch 9A-1：个人知识库数据层
 *
 * 职责：
 *   - IndexedDB（blog-knowledge）持久化收藏、待读、浏览历史、阅读进度/状态；
 *   - 字段级并发合并（读-改-写都在同一个 readwrite 事务内完成）；
 *   - 历史条数上限与保护规则；
 *   - 多标签通知（BroadcastChannel，失败回退 storage 事件，再失败静默）；
 *   - 导出快照；存储不可用时降级内存并提供可见状态。
 *
 * 边界：
 *   - 不读写 blog-draft-history、编辑器草稿键、搜索历史、主题；
 *   - 不负责路由与 DOM 渲染，只提供状态查询与变更（app.js 负责 UI）。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'blog-knowledge';
  var DB_VERSION = 1;
  var SCHEMA_VERSION = 1;
  var STORE = 'records';
  var META = 'meta';
  var HISTORY_LIMIT = 500;
  var RECORD_LIMIT = 2000;
  var PING_KEY = 'blog.km.ping.v1';
  var VIEW_DEDUPE_MS = 30000;
  var TYPES = ['post', 'course', 'paper', 'material', 'lib', 'project', 'note'];

  var backend = null;
  var usingMemory = false;
  var degraded = false;
  var degradeReason = '';
  var readyPromise = null;
  var cache = new Map();
  var listeners = [];
  var channel = null;
  var now = function () { return Date.now(); };
  var progressPending = new Map();
  var progressTimer = 0;

  // ---------------------------------------------------------------- 工具
  function nowMs() { try { return now(); } catch (e) { return Date.now(); } }

  function isKnownType(type) { return TYPES.indexOf(type) !== -1; }

  function makeKey(type, refId) {
    if (!isKnownType(type)) throw new Error('unknown type: ' + type);
    var id = String(refId == null ? '' : refId);
    if (!id) throw new Error('empty refId');
    return type + ':' + id;
  }

  function splitKey(key) {
    var i = String(key).indexOf(':');
    if (i <= 0) return null;
    return { type: String(key).slice(0, i), refId: String(key).slice(i + 1) };
  }

  function clone(rec) {
    var out = {};
    Object.keys(rec).forEach(function (k) { out[k] = rec[k]; });
    return out;
  }

  function blankRecord(type, refId) {
    var t = nowMs();
    return {
      key: makeKey(type, refId),
      type: type,
      refId: String(refId),
      title: '',
      fav: 0, favAt: 0, favCat: 'default',
      later: 0, laterAt: 0,
      readState: 'none', progress: 0,
      firstSeenAt: 0, lastSeenAt: 0, doneAt: 0,
      updatedAt: t
    };
  }

  // 长期状态：只要存在任意一项，就不得因为清理浏览历史而删除整条记录
  function hasPersonalState(rec) {
    return !!(rec && (rec.fav || rec.later || rec.readState !== 'none' ||
      (rec.progress || 0) > 0 || rec.doneAt));
  }

  function isProtected(rec) {
    return hasPersonalState(rec);
  }

  function sanitizeTitle(v) {
    return String(v == null ? '' : v).slice(0, 300);
  }

  function isQuotaError(err) {
    if (!err) return false;
    var name = String(err.name || '');
    var msg = String(err.message || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota/i.test(msg);
  }

  // ---------------------------------------------------------------- 内存后端
  function createMemoryBackend() {
    var map = new Map();
    var meta = new Map();
    var chain = Promise.resolve();
    function enqueue(fn) {
      var p = chain.then(fn, fn);
      chain = p.catch(function () { });
      return p;
    }
    return {
      kind: 'memory',
      get: function (key) { return Promise.resolve(map.has(key) ? clone(map.get(key)) : null); },
      getAll: function () { return Promise.resolve(Array.from(map.values()).map(clone)); },
      getMeta: function (k) { return Promise.resolve(meta.has(k) ? meta.get(k) : null); },
      setMeta: function (k, v) { meta.set(k, v); return Promise.resolve(); },
      mutate: function (key, updater) {
        return enqueue(function () {
          var cur = map.has(key) ? clone(map.get(key)) : null;
          var next = updater(cur);
          if (next === null) map.delete(key);
          else if (next !== undefined) map.set(key, clone(next));
          return next === undefined ? (cur ? clone(cur) : null) : (next ? clone(next) : null);
        });
      },
      clear: function () { map.clear(); return Promise.resolve(); }
    };
  }

  // ---------------------------------------------------------------- IndexedDB 后端
  function openIdb() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('by_type', 'type', { unique: false });
          s.createIndex('by_fav', 'fav', { unique: false });
          s.createIndex('by_later', 'later', { unique: false });
          s.createIndex('by_lastSeen', 'lastSeenAt', { unique: false });
          s.createIndex('by_state', 'readState', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open failed')); };
      req.onblocked = function () { reject(new Error('blocked by another tab')); };
    });
  }

  function createIdbBackend(db) {
    try {
      db.onversionchange = function () { try { db.close(); } catch (e) { } };
    } catch (e) { }
    return {
      kind: 'idb',
      get: function (key) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readonly');
          var r = tx.objectStore(STORE).get(key);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { reject(r.error || new Error('read failed')); };
        });
      },
      getAll: function () {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, 'readonly');
          var r = tx.objectStore(STORE).getAll();
          r.onsuccess = function () { resolve(r.result || []); };
          r.onerror = function () { reject(r.error || new Error('read failed')); };
        });
      },
      getMeta: function (k) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(META, 'readonly');
          var r = tx.objectStore(META).get(k);
          r.onsuccess = function () { resolve(r.result ? r.result.v : null); };
          r.onerror = function () { reject(r.error || new Error('meta read failed')); };
        });
      },
      setMeta: function (k, v) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(META, 'readwrite');
          tx.objectStore(META).put({ k: k, v: v });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('meta write failed')); };
        });
      },
      // 关键：读取、字段合并、写入都在同一个 readwrite 事务内完成，
      // 不会出现“先读旧对象、异步等待、再整体覆盖”的丢字段问题。
      mutate: function (key, updater) {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction(STORE, 'readwrite'); }
          catch (e) { reject(e); return; }
          var store = tx.objectStore(STORE);
          var out = null;
          var failed = false;
          var getReq = store.get(key);
          getReq.onsuccess = function () {
            var next;
            try { next = updater(getReq.result || null); }
            catch (e) { failed = true; try { tx.abort(); } catch (x) { } reject(e); return; }
            try {
              if (next === null) store.delete(key);
              else if (next !== undefined) store.put(next);
            } catch (e) { failed = true; try { tx.abort(); } catch (x) { } reject(e); return; }
            out = next === undefined ? (getReq.result || null) : next;
          };
          getReq.onerror = function () { failed = true; reject(getReq.error || new Error('read failed')); };
          tx.oncomplete = function () { if (!failed) resolve(out); };
          tx.onerror = function () { if (!failed) reject(tx.error || new Error('tx failed')); };
          tx.onabort = function () { if (!failed) reject(tx.error || new Error('tx aborted')); };
        });
      },
      clear: function () {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([STORE, META], 'readwrite');
          tx.objectStore(STORE).clear();
          tx.objectStore(META).clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('clear failed')); };
        });
      }
    };
  }

  // ---------------------------------------------------------------- 状态与通知
  function emit(keys) {
    var detail = { keys: keys || [] };
    listeners.slice().forEach(function (fn) {
      try { fn(detail); } catch (e) { /* 订阅方异常不影响数据层 */ }
    });
    try {
      if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('knowledge:changed', { detail: detail }));
      }
    } catch (e) { /* 忽略 */ }
  }

  function notify(keys) {
    emit(keys);
    // 只有数据库提交成功后才通知其他标签；通知失败不影响数据
    try {
      if (channel) channel.postMessage({ keys: keys, at: nowMs() });
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PING_KEY, JSON.stringify({ keys: keys, at: nowMs() }));
      }
    } catch (e) { /* localStorage 不可用：仅本标签生效 */ }
  }

  function handleRemote(keys) {
    refreshCache().then(function () { emit(keys || []); }).catch(function () { emit(keys || []); });
  }

  function setupChannel() {
    try {
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel('blog-km');
        channel.onmessage = function (e) {
          var d = (e && e.data) || {};
          handleRemote(d.keys || []);
        };
      }
    } catch (e) { channel = null; }
    try {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('storage', function (e) {
          if (!e || e.key !== PING_KEY || !e.newValue) return;
          try { handleRemote((JSON.parse(e.newValue) || {}).keys || []); }
          catch (err) { /* 损坏的 ping 直接忽略 */ }
        });
      }
    } catch (e) { /* storage 事件不可用 */ }
  }

  var _writeGen = 0;

  function refreshCache() {
    if (!backend) return Promise.resolve();
    var gen = _writeGen;
    return backend.getAll().then(function (all) {
      // 读取期间若有本地写入，快照可能早于最新状态：重读一次，避免缓存回退
      if (gen !== _writeGen) return refreshCache();
      cache = new Map();
      (all || []).forEach(function (r) { if (r && r.key) cache.set(r.key, r); });
    });
  }

  function emitStatus() {
    try {
      if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('knowledge:status', { detail: status() }));
      }
    } catch (e) { /* 忽略 */ }
  }

  function switchToMemory(reason) {
    if (usingMemory) return;
    var seed = createMemoryBackend();
    cache.forEach(function (rec, key) { seed.mutate(key, function () { return clone(rec); }); });
    backend = seed;
    usingMemory = true;
    degraded = true;
    degradeReason = String(reason || 'persistence unavailable');
    emitStatus();
  }

  // ---------------------------------------------------------------- 写入
  function mutateRecord(key, updater) {
    if (!backend) return Promise.resolve(null);
    return backend.mutate(key, updater).then(function (rec) {
      _writeGen++;
      if (rec) cache.set(key, rec);
      else cache.delete(key);
      return rec;
    });
  }

  function safeMutate(key, updater, noteKey) {
    // init 尚未完成时排队，避免首访详情页的浏览/收藏被静默丢弃
    if (!backend) return ensureReady().then(function () { return safeMutate(key, updater, noteKey); });
    return mutateRecord(key, updater).then(function (rec) {
      if (rec) notify(noteKey ? [key] : [key]);
      return rec;
    }).catch(function (err) {
      if (isQuotaError(err)) {
        // 配额异常：最多一次符合保护规则的裁剪，然后重试一次
        return pruneHistory(20).then(function () {
          return mutateRecord(key, updater).then(function (rec) {
            if (rec) notify([key]);
            return rec;
          });
        }).catch(function (err2) {
          switchToMemory('quota: ' + (err2 && err2.message || err2));
          emit([]);
          return null;
        });
      }
      switchToMemory('write failed: ' + (err && err.message || err));
      emit([]);
      return null;
    });
  }

  // 历史裁剪：只裁剪"历史字段"；任何长期个人状态都必须保留。
  // 候选在事务外选出，但最终决定在事务内用最新记录重新判断：
  //   - 事务内发现已被收藏/待读/有进度/已完成 → 跳过；
  //   - 事务内发现 lastSeenAt 已变化（另一个标签页刚访问过）→ 跳过，避免误删新历史；
  //   - 没有任何长期状态时才整条删除。
  // 契约：历史硬上限 500；受保护记录会突破上限（软上限例外，优先保证数据不丢失）。
  function pruneHistory(target) {
    return backend.getAll().then(function (all) {
      var list = (all || []).filter(function (r) { return r && r.lastSeenAt > 0 && !isProtected(r); });
      list.sort(function (a, b) { return (a.lastSeenAt || 0) - (b.lastSeenAt || 0); });
      var overflow = list.length + (all || []).filter(function (r) { return r && r.lastSeenAt > 0 && isProtected(r); }).length
        - HISTORY_LIMIT + (target || 0);
      if (overflow <= 0) return 0;
      var seq = Promise.resolve();
      var changed = [];
      list.slice(0, overflow).forEach(function (cand) {
        seq = seq.then(function () {
          return backend.mutate(cand.key, function (cur) {
            if (!cur) return null;
            if (cur.lastSeenAt !== cand.lastSeenAt) return undefined;  // 过期候选：不误删新历史
            if (isProtected(cur)) return undefined;                    // 事务内重新检查保护状态
            var next = clone(cur);
            next.firstSeenAt = 0;
            next.lastSeenAt = 0;
            next.updatedAt = nowMs();
            if (!hasPersonalState(next)) return null;                  // 纯历史记录才整条删除
            return next;
          }).then(function (rec) {
            changed.push(cand.key);
            if (rec) cache.set(cand.key, rec);
            else cache.delete(cand.key);
          });
        });
      });
      return seq.then(function () {
        return refreshCache().then(function () {
          if (changed.length) notify(changed);      // 删除纯历史也要通知其他标签页
          return changed.length;
        });
      });
    });
  }

  // ---------------------------------------------------------------- 公开 API
  function statusResult() { return { ok: !degraded, degraded: degraded, reason: degradeReason }; }

  function migrateMeta() {
    return backend.getMeta('schemaVersion').then(function (v) {
      var from = Number(v) || 0;
      if (from === SCHEMA_VERSION || from > SCHEMA_VERSION) return null;
      // v0（首次创建）→ v1：结构由 DB_VERSION 建立，这里只记录数据版本
      return backend.setMeta('schemaVersion', SCHEMA_VERSION);
    });
  }

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = Promise.resolve().then(function () {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        switchToMemory('indexedDB unavailable');
        setupChannel();
        return refreshCache().then(statusResult);
      }
      return openIdb().then(function (db) {
        backend = createIdbBackend(db);
        usingMemory = false;
        degraded = false;
        degradeReason = '';
        return migrateMeta().then(refreshCache);
      }).catch(function (err) {
        switchToMemory('open failed: ' + (err && err.message || err));
        return refreshCache();
      }).then(function () {
        setupChannel();
        return statusResult();
      });
    });
    return readyPromise;
  }

  function recordView(type, refId, meta) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    var title = sanitizeTitle(meta && meta.title);
    return safeMutate(key, function (cur) {
      var t = nowMs();
      if (!cur) {
        if (cache.size >= RECORD_LIMIT) return undefined;   // 达到总量上限：不新增
        var rec = blankRecord(type, refId);
        rec.title = title;
        rec.firstSeenAt = t;
        rec.lastSeenAt = t;
        rec.updatedAt = t;
        return rec;
      }
      if (cur.lastSeenAt && t - cur.lastSeenAt < VIEW_DEDUPE_MS) return undefined; // 30s 去重
      var next = clone(cur);
      if (title) next.title = title;
      if (!next.firstSeenAt) next.firstSeenAt = t;
      next.lastSeenAt = t;
      next.updatedAt = t;
      return next;
    }).then(function (rec) {
      if (rec) enforceHistoryLimit();
      return rec;
    });
  }

  function enforceHistoryLimit() {
    if (!backend) return;
    backend.getAll().then(function (all) {
      var n = (all || []).filter(function (r) { return r && r.lastSeenAt > 0; }).length;
      if (n > HISTORY_LIMIT) return pruneHistory(0).then(function () { return refreshCache(); });
      return null;
    }).catch(function () { /* 裁剪失败不影响主流程 */ });
  }

  function setFlag(type, refId, flag, on, meta) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    if (flag !== 'fav' && flag !== 'later') return Promise.resolve(null);
    var title = sanitizeTitle(meta && meta.title);
    return safeMutate(key, function (cur) {
      var rec = cur ? clone(cur) : blankRecord(type, refId);
      var t = nowMs();
      if (!rec.title && title) rec.title = title;
      if (flag === 'fav') {
        rec.fav = on ? 1 : 0;
        rec.favAt = on ? t : 0;
        if (!rec.favCat) rec.favCat = 'default';
      } else {
        rec.later = on ? 1 : 0;
        rec.laterAt = on ? t : 0;
      }
      rec.updatedAt = t;
      if (!rec.firstSeenAt && (on || rec.lastSeenAt)) rec.firstSeenAt = t;
      return rec;
    });
  }

  function toggleFlag(type, refId, flag, meta) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    return safeMutate(key, function (cur) {
      var rec = cur ? clone(cur) : blankRecord(type, refId);
      var t = nowMs();
      var on = flag === 'fav' ? !rec.fav : !rec.later;
      if (flag === 'fav') { rec.fav = on ? 1 : 0; rec.favAt = on ? t : 0; }
      else { rec.later = on ? 1 : 0; rec.laterAt = on ? t : 0; }
      if (!rec.title && meta && meta.title) rec.title = sanitizeTitle(meta.title);
      rec.updatedAt = t;
      return rec;
    });
  }

  function deriveState(progress) {
    if (progress >= 0.95) return 'done';
    if (progress > 0.02) return 'reading';
    return 'none';
  }

  function saveProgress(type, refId, progress) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    var p = Math.max(0, Math.min(1, Number(progress) || 0));
    return safeMutate(key, function (cur) {
      if (!cur) return undefined;              // 未浏览过的内容不因进度写入而创建
      var next = clone(cur);
      var t = nowMs();
      next.progress = Math.round(p * 100) / 100;
      var st = deriveState(p);
      if (next.readState !== 'done') next.readState = st;
      if (st === 'done' && !next.doneAt) next.doneAt = t;
      next.updatedAt = t;
      return next;
    });
  }

  function setReadState(type, refId, state, progress) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    if (['none', 'reading', 'done'].indexOf(state) === -1) return Promise.resolve(null);
    return safeMutate(key, function (cur) {
      if (!cur) return undefined;
      var next = clone(cur);
      next.readState = state;
      if (typeof progress === 'number') next.progress = Math.max(0, Math.min(1, progress));
      if (state === 'done') next.doneAt = nowMs();
      next.updatedAt = nowMs();
      return next;
    });
  }

  // 进度节流：滚动期间只更新内存，5s 落盘一次；flushProgress 用于路由切换/页面隐藏
  function scheduleProgress(type, refId, progress) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return; }
    progressPending.set(key, Math.max(0, Math.min(1, Number(progress) || 0)));
    if (progressTimer) return;
    progressTimer = setTimeout(function () {
      progressTimer = 0;
      flushProgress();
    }, 5000);
    if (progressTimer && progressTimer.unref) { try { progressTimer.unref(); } catch (e) { } }
  }

  function flushProgress() {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = 0; }
    var entries = Array.from(progressPending.entries());
    progressPending.clear();
    if (!entries.length) return Promise.resolve();
    var seq = Promise.resolve();
    entries.forEach(function (pair) {
      seq = seq.then(function () { return saveProgressByKey(pair[0], pair[1]); });
    });
    return seq;
  }

  function saveProgressByKey(key, p) {
    return safeMutate(key, function (cur) {
      if (!cur) return undefined;
      var next = clone(cur);
      var t = nowMs();
      next.progress = Math.round(p * 100) / 100;
      var st = deriveState(p);
      if (next.readState !== 'done') next.readState = st;
      if (st === 'done' && !next.doneAt) next.doneAt = t;
      next.updatedAt = t;
      return next;
    });
  }

  function clearHistory(key) {
    return safeMutate(key, function (cur) {
      if (!cur) return null;
      var next = clone(cur);
      next.firstSeenAt = 0;
      next.lastSeenAt = 0;
      next.updatedAt = nowMs();
      // 只删历史字段；若没有其他个人状态则整条删除
      if (!next.fav && !next.later && next.readState !== 'reading' && !next.progress) return null;
      return next;
    });
  }

  function clearAllHistory() {
    return backend.getAll().then(function (all) {
      var seq = Promise.resolve();
      (all || []).forEach(function (r) {
        if (!r || !r.lastSeenAt) return;
        seq = seq.then(function () { return clearHistory(r.key); });
      });
      return seq;
    }).then(function () { return refreshCache(); }).then(function () { notify([]); });
  }

  function ensureReady() {
    if (backend) return Promise.resolve();
    var p = init();
    return p ? p.then(function () { return null; }) : Promise.resolve();
  }

  function getAllSafe() {
    if (!backend) return ensureReady().then(getAllSafe);
    return backend.getAll().catch(function () { return Array.from(cache.values()); });
  }

  function remove(key) {
    if (!key) return Promise.resolve(null);
    return safeMutate(key, function () { return null; });
  }

  function list(opts) {
    var o = opts || {};
    return getAllSafe().then(function (all) {
      var rows = (all || []).slice();
      if (o.type) rows = rows.filter(function (r) { return r.type === o.type; });
      if (o.flag === 'fav') rows = rows.filter(function (r) { return !!r.fav; });
      if (o.flag === 'later') rows = rows.filter(function (r) { return !!r.later; });
      if (o.flag === 'history') rows = rows.filter(function (r) { return r.lastSeenAt > 0; });
      if (o.flag === 'continue') {
        rows = rows.filter(function (r) {
          return r.readState === 'reading' && r.progress >= 0.05 && r.progress < 0.95;
        });
      }
      var sort = o.sort || 'recent';
      rows.sort(function (a, b) {
        if (sort === 'fav') return (b.favAt || 0) - (a.favAt || 0);
        if (sort === 'later') return (b.laterAt || 0) - (a.laterAt || 0);
        if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      });
      var offset = o.offset || 0;
      var limit = o.limit || rows.length;
      return rows.slice(offset, offset + limit);
    });
  }

  function counts() {
    return getAllSafe().then(function (all) {
      var c = { fav: 0, later: 0, reading: 0, done: 0, history: 0 };
      (all || []).forEach(function (r) {
        if (r.fav) c.fav++;
        if (r.later) c.later++;
        if (r.readState === 'reading') c.reading++;
        if (r.readState === 'done') c.done++;
        if (r.lastSeenAt > 0) c.history++;
      });
      return c;
    });
  }

  function publicRecord(r) {
    return {
      key: r.key, type: r.type, refId: r.refId, title: r.title || '',
      fav: r.fav ? 1 : 0, favAt: r.favAt || 0, favCat: r.favCat || 'default',
      later: r.later ? 1 : 0, laterAt: r.laterAt || 0,
      readState: r.readState || 'none', progress: r.progress || 0,
      firstSeenAt: r.firstSeenAt || 0, lastSeenAt: r.lastSeenAt || 0,
      doneAt: r.doneAt || 0, updatedAt: r.updatedAt || 0
    };
  }

  function exportData() {
    return getAllSafe().then(function (all) {
      return {
        app: 'ericzhao-blog',
        kind: 'knowledge',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        // 降级时导出的是"当前可用数据"，不宣称是完整持久化备份
        persistence: degraded ? 'memory' : 'indexeddb',
        degraded: !!degraded,
        complete: !degraded,
        records: (all || []).map(publicRecord)
      };
    });
  }

  function stateOf(type, refId) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return null; }
    return cache.get(key) || null;
  }

  function status() {
    return { degraded: degraded, usingMemory: usingMemory, reason: degradeReason, ready: !!backend };
  }

  function relativeTime(ts, ref) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var base = Number(ref) || Date.now();
    var diff = Math.max(0, base - t);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
    var d = new Date(t);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function toast(message, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    var el = document.getElementById('kmToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kmToast';
      el.className = 'km-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = String(message == null ? '' : message);
    el.setAttribute('data-kind', kind || 'info');
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  var api = {
    init: init,
    recordView: recordView,
    setFlag: setFlag,
    toggleFlag: toggleFlag,
    saveProgress: saveProgress,
    scheduleProgress: scheduleProgress,
    flushProgress: flushProgress,
    setReadState: setReadState,
    clearHistory: clearHistory,
    clearAllHistory: clearAllHistory,
    remove: remove,
    list: list,
    counts: counts,
    exportData: exportData,
    state: stateOf,
    status: status,
    relativeTime: relativeTime,
    toast: toast,
    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () { };
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },
    refresh: refreshCache,
    makeKey: makeKey,
    splitKey: splitKey,
    // 测试专用
    _setNow: function (fn) { now = typeof fn === 'function' ? fn : function () { return Date.now(); }; },
    _injectBackend: function (b) {
      backend = b;
      usingMemory = b && b.kind === 'memory';
      readyPromise = Promise.resolve({ ok: true, degraded: false, reason: '' });
      setupChannel();
      return migrateMeta().catch(function () { return null; }).then(refreshCache);
    },
    _resetForTest: function () {
      backend = null; usingMemory = false; degraded = false; degradeReason = '';
      readyPromise = null; cache = new Map(); listeners = [];
      progressPending = new Map(); if (progressTimer) { clearTimeout(progressTimer); progressTimer = 0; }
    }
  };

  global.Knowledge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
