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
  var DB_VERSION = 1;              // IndexedDB 结构版本：9A-2 不新增 object store，保持 1
  var SCHEMA_VERSION = 2;          // 知识数据版本：v2 增加收藏分类（meta.favCategories）
  var STORE = 'records';
  var META = 'meta';
  var HISTORY_LIMIT = 500;
  var RECORD_LIMIT = 2000;
  var PING_KEY = 'blog.km.ping.v1';
  var VIEW_DEDUPE_MS = 30000;

  // ---- Batch 9A-2 常量 ----
  var CAT_KEY = 'favCategories';
  var CAT_DEFAULT = 'default';
  var CAT_DEFAULT_NAME = '默认分类';
  var CAT_NAME_MAX = 40;
  var CAT_MAX = 200;
  var IMPORT_MAX_BYTES = 2 * 1024 * 1024;
  var IMPORT_MAX_RECORDS = 5000;
  var IMPORT_MAX_DEPTH = 6;
  var IMPORT_APP = 'ericzhao-blog';
  var IMPORT_KIND = 'knowledge';
  var IMPORT_VERSIONS = [1, 2];     // 可接受的历史格式
  var STATE_SOURCES = ['manual', 'auto'];   // 人工/自动状态来源（可选字段）
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
      // 多键原子写：任一 updater 抛错即整体回滚（模拟 IDB 事务 abort）
      mutateMany: function (keys, updater) {
        return enqueue(function () {
          var snapshot = new Map();
          map.forEach(function (v, k) { snapshot.set(k, clone(v)); });
          var out = [];
          try {
            (keys || []).forEach(function (key) {
              var cur = map.has(key) ? clone(map.get(key)) : null;
              var next = updater(cur, key);
              if (next === null) map.delete(key);
              else if (next !== undefined) map.set(key, clone(next));
              out.push(next === undefined ? cur : next);
            });
          } catch (e) {
            map.clear();
            snapshot.forEach(function (v, k) { map.set(k, v); });
            throw e;
          }
          return out;
        });
      },
      // 分类 meta + 一批记录的同事务更新（删除分类时"改归属 + 改定义"必须一起成功）
      runAtomic: function (metaUpdater, keys, recUpdater) {
        return enqueue(function () {
          var snapshot = new Map();
          map.forEach(function (v, k) { snapshot.set(k, clone(v)); });
          var metaSnapshot = meta.has(CAT_KEY) ? meta.get(CAT_KEY) : null;
          try {
            var curMeta = meta.has(CAT_KEY) ? meta.get(CAT_KEY) : null;
            var nextMeta = metaUpdater(curMeta);
            if (nextMeta !== undefined) meta.set(CAT_KEY, nextMeta);
            var out = [];
            (keys || []).forEach(function (key) {
              var cur = map.has(key) ? clone(map.get(key)) : null;
              var next = recUpdater(cur, key);
              if (next === null) map.delete(key);
              else if (next !== undefined) map.set(key, clone(next));
              out.push(next === undefined ? cur : next);
            });
            return { meta: nextMeta === undefined ? curMeta : nextMeta, records: out };
          } catch (e) {
            map.clear();
            snapshot.forEach(function (v, k) { map.set(k, v); });
            if (metaSnapshot === null) meta.delete(CAT_KEY); else meta.set(CAT_KEY, metaSnapshot);
            throw e;
          }
        });
      },
      replaceAll: function (records, cats, expect) {
        return enqueue(function () {
          // 权威冲突检查与清空/写入在同一个"事务"内：先按当前内容算指纹
          if (expect) {
            var curRows = Array.from(map.values());
            var curCats = meta.has(CAT_KEY) ? meta.get(CAT_KEY) : null;
            if (tokenOf({ rows: curRows, cats: curCats }) !== expect) {
              return { ok: false, conflict: true };
            }
          }
          var snapshot = new Map();
          map.forEach(function (v, k) { snapshot.set(k, clone(v)); });
          var metaSnapshot = meta.has(CAT_KEY) ? meta.get(CAT_KEY) : null;
          try {
            map.clear();
            (records || []).forEach(function (r) { if (r && r.key) map.set(r.key, clone(r)); });
            meta.set(CAT_KEY, cats);
          } catch (e) {
            map.clear();
            snapshot.forEach(function (v, k) { map.set(k, v); });
            if (metaSnapshot === null) meta.delete(CAT_KEY); else meta.set(CAT_KEY, metaSnapshot);
            throw e;
          }
          return true;
        });
      },
      readAll: function () {
        return Promise.resolve({
          rows: Array.from(map.values()).map(clone),
          cats: meta.has(CAT_KEY) ? meta.get(CAT_KEY) : null
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
      // 多键原子写：所有 get/put/delete 在同一个 readwrite 事务内顺序执行。
      // 任一 updater 抛错或任一 request 失败 → abort，整批不落盘。
      mutateMany: function (keys, updater) {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction(STORE, 'readwrite'); }
          catch (e) { reject(e); return; }
          var store = tx.objectStore(STORE);
          var out = [];
          var i = 0;
          var settled = false;
          function fail(err) {
            if (settled) return;
            settled = true;
            try { tx.abort(); } catch (x) { }
            reject(err || new Error('bulk failed'));
          }
          function step() {
            if (i >= keys.length) return;               // 交给 tx.oncomplete 收尾
            var key = keys[i++];
            var getReq;
            try { getReq = store.get(key); } catch (e) { fail(e); return; }
            getReq.onerror = function () { fail(getReq.error); };
            getReq.onsuccess = function () {
              var cur = getReq.result || null;
              var next;
              try { next = updater(cur, key); } catch (e) { fail(e); return; }
              try {
                if (next === null) store.delete(key);
                else if (next !== undefined) store.put(next);
              } catch (e) { fail(e); return; }
              out.push(next === undefined ? cur : next);
              step();
            };
          }
          tx.oncomplete = function () { if (!settled) { settled = true; resolve(out); } };
          tx.onerror = function () { fail(tx.error); };
          tx.onabort = function () { fail(tx.error || new Error('bulk aborted')); };
          if (!keys.length) { settled = true; resolve([]); return; }
          step();
        });
      },
      // 分类 meta + 一批记录的同事务更新；任一环节失败整体 abort
      runAtomic: function (metaUpdater, keys, recUpdater) {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction([STORE, META], 'readwrite'); }
          catch (e) { reject(e); return; }
          var rs = tx.objectStore(STORE);
          var ms = tx.objectStore(META);
          var out = [];
          var nextMeta = null;
          var settled = false;
          var i = 0;
          function fail(err) {
            if (settled) return;
            settled = true;
            try { tx.abort(); } catch (x) { }
            reject(err || new Error('atomic failed'));
          }
          var metaReq = ms.get(CAT_KEY);
          metaReq.onerror = function () { fail(metaReq.error); };
          metaReq.onsuccess = function () {
            var curMeta = metaReq.result ? metaReq.result.v : null;
            try {
              var nm = metaUpdater(curMeta);
              if (nm !== undefined) { ms.put({ k: CAT_KEY, v: nm }); nextMeta = nm; }
              else nextMeta = curMeta;
            } catch (e) { fail(e); return; }
            step();
          };
          function step() {
            if (i >= keys.length) return;              // 交给 oncomplete
            var key = keys[i++];
            var getReq;
            try { getReq = rs.get(key); } catch (e) { fail(e); return; }
            getReq.onerror = function () { fail(getReq.error); };
            getReq.onsuccess = function () {
              var cur = getReq.result || null;
              var next;
              try { next = recUpdater(cur, key); } catch (e) { fail(e); return; }
              try {
                if (next === null) rs.delete(key);
                else if (next !== undefined) rs.put(next);
              } catch (e) { fail(e); return; }
              out.push(next === undefined ? cur : next);
              step();
            };
          }
          tx.oncomplete = function () { if (!settled) { settled = true; resolve({ meta: nextMeta, records: out }); } };
          tx.onerror = function () { fail(tx.error); };
          tx.onabort = function () { fail(tx.error || new Error('atomic aborted')); };
        });
      },
      // 替换：清空 records 并写回新集合 + 分类 meta，全部在同一个 readwrite 事务内。
      // 不使用 deleteDatabase，也不 clear 整个 meta（避免丢掉 schemaVersion 之外的键）。
      replaceAll: function (records, cats, expect) {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction([STORE, META], 'readwrite'); }
          catch (e) { reject(e); return; }
          var rs = tx.objectStore(STORE);
          var ms = tx.objectStore(META);
          var settled = false;
          var conflict = false;

          function writeAll() {
            var cleared = rs.clear();
            cleared.onerror = function () { try { tx.abort(); } catch (e) { } };
            cleared.onsuccess = function () {
              try {
                (records || []).forEach(function (r) { if (r && r.key) rs.put(r); });
                ms.put({ k: CAT_KEY, v: cats });
              } catch (e) { try { tx.abort(); } catch (x) { } }
            };
          }

          if (!expect) {
            writeAll();
          } else {
            // 权威检查：在**同一个 readwrite 事务内**先读当前快照并与 expect 比对，
            // 只有指纹一致才 clear + put；不一致直接 abort，不写任何数据。
            var rows0 = null;
            var cats0 = null;
            var pending = 2;
            function ready() {
              pending--;
              if (pending > 0 || settled) return;
              if (tokenOf({ rows: rows0 || [], cats: cats0 }) !== expect) {
                conflict = true;
                try { tx.abort(); } catch (e) { }
                return;
              }
              writeAll();
            }
            var g1 = ms.get(CAT_KEY);
            g1.onsuccess = function () { cats0 = g1.result ? g1.result.v : null; ready(); };
            g1.onerror = function () { try { tx.abort(); } catch (e) { } };
            var g2 = rs.getAll();
            g2.onsuccess = function () { rows0 = g2.result || []; ready(); };
            g2.onerror = function () { try { tx.abort(); } catch (e) { } };
          }

          tx.oncomplete = function () { if (!settled) { settled = true; resolve({ ok: true }); } };
          tx.onerror = function () { if (!settled) { settled = true; reject(tx.error || new Error('replace failed')); } };
          tx.onabort = function () {
            if (settled) return;
            settled = true;
            if (conflict) resolve({ ok: false, conflict: true });
            else reject(tx.error || new Error('replace aborted'));
          };
        });
      },
      // 一次性读出 records + 分类定义（同一个只读事务），供导出使用
      readAll: function () {
        return new Promise(function (resolve, reject) {
          var tx;
          try { tx = db.transaction([STORE, META], 'readonly'); }
          catch (e) { reject(e); return; }
          var rows = null;
          var cats = null;
          var r1 = tx.objectStore(STORE).getAll();
          r1.onsuccess = function () { rows = r1.result || []; };
          r1.onerror = function () { reject(r1.error || new Error('read failed')); };
          var r2 = tx.objectStore(META).get(CAT_KEY);
          r2.onsuccess = function () { cats = r2.result ? r2.result.v : null; };
          r2.onerror = function () { reject(r2.error || new Error('meta read failed')); };
          tx.oncomplete = function () { resolve({ rows: rows || [], cats: cats }); };
          tx.onerror = function () { reject(tx.error || new Error('read tx failed')); };
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
    catCache = null;                                   // 分类定义可能已被其他标签页修改
    loadCategories().catch(function () { return null; }).then(function () {
      return refreshCache();
    }).then(function () { emit(keys || []); }).catch(function () { emit(keys || []); });
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

  // 统一写入结果：ok=已提交 / changed=确实写入或删除 / deleted=整条删除。
  // 删除提交成功也必须通知其他标签页（旧实现只在 rec 非空时通知）。
  function mutateWithOutcome(key, updater, noteKey) {
    // init 尚未完成时排队，避免首访详情页的浏览/收藏被静默丢弃
    if (!backend) return ensureReady().then(function () { return mutateWithOutcome(key, updater, noteKey); });
    // 统一写入闸门：所有记录写入（浏览/收藏/待读/进度/删除）都从这里经过。
    // 迁移失败或未来版本时直接拒绝，不触发内存降级、不清空数据库。
    var blocked = writeBlockedReason();
    if (blocked) {
      return Promise.resolve({
        ok: false, blocked: true, reason: blocked,
        changed: false, deleted: false, record: null
      });
    }
    var flags = { deleted: false, changed: false };
    var wrapped = function (cur) {
      var next = updater(cur);
      if (next === null) {
        // 删除不存在的记录 = 无变化；只有真正删掉了一条才广播
        if (cur) { flags.deleted = true; flags.changed = true; }
      } else if (next !== undefined) {
        flags.changed = true;
      }
      return next;
    };
    function run(isRetry) {
      return mutateRecord(key, wrapped).then(function (rec) {
        if (flags.changed) notify([key]);
        return { ok: true, changed: flags.changed, deleted: flags.deleted, record: rec };
      }).catch(function (err) {
        if (isQuotaError(err) && !isRetry) {
          // 配额异常：最多一次符合保护规则的裁剪，然后重试一次
          return pruneHistory(20).then(function () {
            flags.deleted = false;
            flags.changed = false;
            return run(true);
          }).catch(function (err2) {
            switchToMemory('quota: ' + (err2 && err2.message || err2));
            emit([]);
            return { ok: false, changed: false, deleted: false, record: null };
          });
        }
        if (!isRetry) switchToMemory('write failed: ' + (err && err.message || err));
        emit([]);
        return { ok: false, changed: false, deleted: false, record: null };
      });
    }
    return run(false);
  }

  function safeMutate(key, updater, noteKey) {
    return mutateWithOutcome(key, updater, noteKey).then(function (r) { return r.record; });
  }

  // 历史裁剪：只裁剪"历史字段"；任何长期个人状态都必须保留。
  // 候选在事务外选出，但最终决定在事务内用最新记录重新判断：
  //   - 事务内发现已被收藏/待读/有进度/已完成 → 跳过；
  //   - 事务内发现 lastSeenAt 已变化（另一个标签页刚访问过）→ 跳过，避免误删新历史；
  //   - 没有任何长期状态时才整条删除。
  // 契约：历史硬上限 500；受保护记录会突破上限（软上限例外，优先保证数据不丢失）。
  function pruneHistory(target) {
    if (!backend) return Promise.resolve(0);
    // 闸门：迁移失败/未来版本时，不启动新的自动裁剪（只读统计也不做）
    if (writeBlockedReason()) return Promise.resolve(0);
    return backend.getAll().then(function (all) {
      var list = (all || []).filter(function (r) { return r && r.lastSeenAt > 0 && !isProtected(r); });
      list.sort(function (a, b) { return (a.lastSeenAt || 0) - (b.lastSeenAt || 0); });
      var overflow = list.length + (all || []).filter(function (r) { return r && r.lastSeenAt > 0 && isProtected(r); }).length
        - HISTORY_LIMIT + (target || 0);
      if (overflow <= 0) return 0;
      var seq = Promise.resolve();
      var changed = [];
      list.slice(0, overflow).forEach(function (cand) {
        var applied = false;          // 只有真的写进去才算一次裁剪（跳过/被拦不打点）
        seq = seq.then(function () {
          // 已排队但尚未执行的裁剪：真正写入前再查一次闸门
          if (writeBlockedReason()) return null;
          return backend.mutate(cand.key, function (cur) {
            if (!cur) return null;
            // 事务内最后一道检查：即便上面通过，此刻被闸门拦下也不写
            if (writeBlockedReason()) return undefined;
            if (cur.lastSeenAt !== cand.lastSeenAt) return undefined;  // 过期候选：不误删新历史
            if (isProtected(cur)) return undefined;                    // 事务内重新检查保护状态
            var next = clone(cur);
            next.firstSeenAt = 0;
            next.lastSeenAt = 0;
            next.updatedAt = nowMs();
            applied = true;
            if (!hasPersonalState(next)) return null;                  // 纯历史记录才整条删除
            return next;
          }).then(function (rec) {
            if (!applied) return;
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

  // ---------------------------------------------------------------- 收藏分类（Batch 9A-2）
  // 分类定义只存在 meta.favCategories 一个键里，记录侧继续用 favCat 引用，
  // 因此不需要新的 object store，也不改 DB_VERSION。
  var catCache = null;

  function defaultCategories() {
    return [{ id: CAT_DEFAULT, name: CAT_DEFAULT_NAME, system: true }];
  }

  function sanitizeCatName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, CAT_NAME_MAX);
  }

  // 归一化：去空、去重 id、默认分类恒定存在且排第一
  function normalizeCategories(list) {
    var raw = Array.isArray(list) ? list : [];
    var out = [];
    raw.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var id = typeof c.id === 'string' ? c.id.trim().slice(0, 64) : '';
      var name = sanitizeCatName(c.name);
      if (!id || !name) return;
      if (out.some(function (x) { return x.id === id; })) return;
      out.push({ id: id, name: name, system: id === CAT_DEFAULT });
    });
    var def = null;
    var rest = [];
    out.forEach(function (c) {
      if (c.id === CAT_DEFAULT) def = { id: CAT_DEFAULT, name: c.name || CAT_DEFAULT_NAME, system: true };
      else rest.push(c);
    });
    if (!def) def = { id: CAT_DEFAULT, name: CAT_DEFAULT_NAME, system: true };
    return [def].concat(rest).slice(0, CAT_MAX);
  }

  function loadCategories() {
    if (catCache) return Promise.resolve(catCache);
    if (!backend) return ensureReady().then(loadCategories);
    return backend.getMeta(CAT_KEY).then(function (v) {
      catCache = normalizeCategories(v);
      return catCache;
    }).catch(function () {
      catCache = defaultCategories();
      return catCache;
    });
  }

  function saveCategories(list) {
    var next = normalizeCategories(list);
    return backend.setMeta(CAT_KEY, next).then(function () {
      catCache = next;
      notify([]);                       // 分类变化要同步到其他标签页
      return next;
    });
  }

  function validateCatName(name, list, exceptId) {
    var raw = String(name == null ? '' : name);
    var n = sanitizeCatName(raw);
    if (!n) return { ok: false, reason: '分类名称不能为空' };
    if (raw.replace(/\s+/g, ' ').trim().length > CAT_NAME_MAX) {
      return { ok: false, reason: '分类名称最多 ' + CAT_NAME_MAX + ' 个字符' };
    }
    var dup = (list || []).some(function (c) {
      return c.id !== exceptId && c.name.toLowerCase() === n.toLowerCase();
    });
    if (dup) return { ok: false, reason: '已存在同名分类' };
    return { ok: true, name: n };
  }

  function categories() {
    return loadCategories().then(function (list) { return list.slice(); });
  }

  function addCategory(name) {
    var blocked = writeBlockedReason();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    return loadCategories().then(function (list) {
      var v = validateCatName(name, list);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (list.length >= CAT_MAX) return { ok: false, reason: '分类数量已达上限（' + CAT_MAX + '）' };
      var cat = {
        id: 'cat-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: v.name,
        system: false
      };
      return saveCategories(list.concat([cat])).then(function () {
        return { ok: true, category: cat, changed: true };
      });
    });
  }

  function renameCategory(id, name) {
    var blocked = writeBlockedReason();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    return loadCategories().then(function (list) {
      var cur = list.filter(function (c) { return c.id === id; })[0];
      if (!cur) return { ok: false, reason: '分类不存在' };
      var v = validateCatName(name, list, id);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (v.name === cur.name) return { ok: true, category: cur, changed: false };
      var next = list.map(function (c) {
        return c.id === id ? { id: c.id, name: v.name, system: c.system } : c;
      });
      return saveCategories(next).then(function () {
        return { ok: true, category: next.filter(function (c) { return c.id === id; })[0], changed: true };
      });
    });
  }

  // 删除分类：分类定义与"收藏归属"必须在同一个事务里完成，否则会出现悬空 favCat
  function removeCategory(id) {
    if (id === CAT_DEFAULT) return Promise.resolve({ ok: false, reason: '默认分类不可删除' });
    var blocked = writeBlockedReason();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    return loadCategories().then(function (list) {
      if (!list.some(function (c) { return c.id === id; })) {
        return { ok: false, reason: '分类不存在' };
      }
      var nextCats = list.filter(function (c) { return c.id !== id; });
      var keys = [];
      cache.forEach(function (r) { if (r && r.favCat === id) keys.push(r.key); });
      if (!backend) return { ok: false, reason: '本地数据库不可用' };
      return backend.runAtomic(
        function () { return nextCats; },
        keys,
        function (cur) {
          if (!cur) return undefined;
          var n = clone(cur);
          n.favCat = CAT_DEFAULT;
          n.updatedAt = nowMs();
          return n;
        }
      ).then(function (res) {
        _writeGen++;
        catCache = nextCats;
        return refreshCache().then(function () {
          notify(keys);
          return { ok: true, moved: (res && res.records ? res.records.length : 0), changed: true };
        });
      }).catch(function (e) {
        return { ok: false, reason: '删除分类失败：' + (e && e.message || e) };
      });
    });
  }

  function assignCategory(key, catId) {
    var blocked = writeBlockedReason();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    return loadCategories().then(function (list) {
      if (!list.some(function (c) { return c.id === catId; })) {
        return { ok: false, reason: '分类不存在' };
      }
      return mutateWithOutcome(key, function (cur) {
        if (!cur || !cur.fav) return undefined;      // 未收藏的内容没有分类归属
        if ((cur.favCat || CAT_DEFAULT) === catId) return undefined;
        var n = clone(cur);
        n.favCat = catId;
        n.updatedAt = nowMs();
        return n;
      }).then(function (r) {
        return { ok: r.ok, changed: r.changed };
      });
    });
  }

  // ---------------------------------------------------------------- 批量管理（Batch 9A-2）
  var BULK_ACTIONS = ['fav-on', 'fav-off', 'later-on', 'later-off', 'cat', 'read-done', 'read-none', 'history-clear'];

  function applyBulkToRecord(rec, action, opts) {
    if (!rec) return undefined;                        // 只处理已存在的记录，不凭空创建
    var n = clone(rec);
    var t = nowMs();
    if (action === 'fav-on') {
      if (n.fav && (n.favCat || CAT_DEFAULT) === (opts.catId || n.favCat || CAT_DEFAULT)) return undefined;
      n.fav = 1; n.favAt = t;
      if (opts.catId) n.favCat = opts.catId;
      else if (!n.favCat) n.favCat = CAT_DEFAULT;
    } else if (action === 'fav-off') {
      if (!n.fav) return undefined;
      n.fav = 0; n.favAt = 0;                          // 保留 favCat，便于以后重新收藏回原分类
    } else if (action === 'later-on') {
      if (n.later) return undefined;
      n.later = 1; n.laterAt = t;
    } else if (action === 'later-off') {
      if (!n.later) return undefined;
      n.later = 0; n.laterAt = 0;
    } else if (action === 'cat') {
      if (!n.fav || (n.favCat || CAT_DEFAULT) === opts.catId) return undefined;
      n.favCat = opts.catId;
    } else if (action === 'read-done' || action === 'read-none') {
      if (action === 'read-done') {
        if (n.readState === 'done' && n.manualStateAt) return undefined;
        n.readState = 'done';
        n.doneAt = t;
      } else {
        n.readState = 'none';
        n.progress = 0;                                 // 未读必须清进度，不能留半截百分比
        n.doneAt = 0;
      }
      n.stateSource = 'manual';
      n.manualStateAt = t;
    } else if (action === 'history-clear') {
      if (!n.lastSeenAt && !n.firstSeenAt) return undefined;
      n.firstSeenAt = 0; n.lastSeenAt = 0;
      if (!hasPersonalState(n)) return null;            // 纯历史记录整条删除
    }
    n.updatedAt = t;
    return n;
  }

  // 批量写入：单事务；任一键失败整体回滚；不做"逐条 await 假装原子"
  function bulk(keys, action, opts) {
    var o = opts || {};
    var ks = (Array.isArray(keys) ? keys : []).filter(function (k) {
      return typeof k === 'string' && k.indexOf(':') > 0;
    });
    if (BULK_ACTIONS.indexOf(action) === -1) {
      return Promise.resolve({ ok: false, reason: '未知批量操作', changed: 0, total: 0 });
    }
    if (!ks.length) return Promise.resolve({ ok: true, total: 0, changed: 0, deleted: 0 });
    var blocked = writeBlockedReason();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked, changed: 0, total: ks.length });
    return loadCategories().then(function (list) {
      if (action === 'cat' && !list.some(function (c) { return c.id === o.catId; })) {
        return { ok: false, reason: '分类不存在', changed: 0, total: ks.length };
      }
      return ensureReady().then(function () {
        if (!backend || typeof backend.mutateMany !== 'function') {
          return { ok: false, reason: '当前存储不支持批量事务', changed: 0, total: ks.length };
        }
        return backend.mutateMany(ks, function (cur) {
          return applyBulkToRecord(cur, action, o);
        }).then(function (out) {
          _writeGen++;
          var changed = (out || []).filter(function (v) { return v !== null && v !== undefined; }).length;
          var deleted = (out || []).filter(function (v) { return v === null; }).length;
          return refreshCache().then(function () {
            notify(ks);
            return { ok: true, total: ks.length, changed: changed, deleted: deleted };
          });
        }).catch(function (e) {
          return { ok: false, reason: '批量操作失败（已回滚）：' + (e && e.message || e), changed: 0, total: ks.length };
        });
      });
    });
  }

  // ---------------------------------------------------------------- 公开 API
  function statusResult() { return { ok: !degraded, degraded: degraded, reason: degradeReason }; }

  // 迁移：v1 → v2 只补 meta.favCategories，并把指向不存在分类的收藏归回默认分类。
  // 幂等：重复执行不会改变结果；遇到更高版本直接跳过（不破坏性写入）。
  // Batch 9A-2 修订：迁移结果不再被 catch 吞成 null，而是记录到 migrationState
  // 并透出到 status()，避免"迁移失败却显示成功"。
  var migrationState = { ok: true, failed: false, future: false, from: null, reason: '' };

  function migrateMeta() {
    migrationState = { ok: true, failed: false, future: false, from: null, reason: '' };
    return backend.getMeta('schemaVersion').then(function (v) {
      var from = Number(v) || 0;
      migrationState.from = from;
      if (from > SCHEMA_VERSION) {
        // 未来版本：一个字节都不写，并禁止后续分类/导入写操作，避免降级覆盖
        migrationState.ok = false;
        migrationState.future = true;
        migrationState.reason = '本地数据来自更新版本（schemaVersion=' + from + '），本次未迁移也不会覆盖，请升级站点';
        return { skipped: true };
      }
      var cats = null;
      return backend.getMeta(CAT_KEY).then(function (raw) {
        cats = normalizeCategories(raw);
        return backend.setMeta(CAT_KEY, cats);
      }).then(function () {
        return backend.getAll();
      }).then(function (all) {
        var valid = {};
        cats.forEach(function (c) { valid[c.id] = true; });
        var fixes = [];
        (all || []).forEach(function (r) {
          if (r && r.fav && r.favCat && !valid[r.favCat]) fixes.push(r);
        });
        if (!fixes.length) return null;
        // 复用同一个批量事务修正悬空分类引用
        return backend.mutateMany(fixes.map(function (r) { return r.key; }), function (cur) {
          if (!cur) return undefined;
          var n = clone(cur);
          n.favCat = CAT_DEFAULT;
          return n;
        }).then(function () { migrationState.fixed = fixes.length; });
      }).then(function () {
        catCache = cats;
        if (from === SCHEMA_VERSION) return null;
        return backend.setMeta('schemaVersion', SCHEMA_VERSION);
      }).then(function () { migrationState.to = SCHEMA_VERSION; });
    }).catch(function (e) {
      // 不吞掉：记录失败原因，交由 status()/UI 明确提示；下次 init 会自动重试（幂等）
      migrationState.ok = false;
      migrationState.failed = true;
      migrationState.reason = '迁移未完成：' + (e && e.message || e) + '（可刷新页面重试）';
      try { console.warn('[knowledge] migration failed:', e && e.message || e); } catch (x) { }
      return { failed: true };
    });
  }

  // 未来版本或迁移失败期间，拒绝一切持久化写入（浏览历史/收藏/待读/进度/删除/分类/导入）。
  // 只读查询与导出不受影响；不清库、不降级到内存，避免"看起来写成功"或覆盖已有数据。
  function writeBlockedReason() {
    if (migrationState.future) return migrationState.reason;
    if (migrationState.failed) {
      return migrationState.reason || '本地数据迁移未完成，已暂停写入以保护现有数据';
    }
    return '';
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
    if (writeBlockedReason()) return;          // 闸门：不安排自动裁剪
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
    // "立即写"等价于此刻的采样：只有晚于此刻的人工状态才算更新
    return saveProgressByKey(key, progress, nowMs());
  }

  // 显式阅读状态：manualStateAt 记录"人工操作时间"，用于压过更早的滚动进度任务。
  // 标记已读不伪造进度（不给课程/项目补 100%），只建立 done + doneAt；
  // 标记未读必须清空 progress 与 doneAt，否则"继续阅读"会把已读又算回来。
  function setReadState(type, refId, state, progress) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return Promise.resolve(null); }
    if (['none', 'reading', 'done'].indexOf(state) === -1) return Promise.resolve(null);
    progressPending.delete(key);                       // 未落盘的滚动任务直接作废
    return safeMutate(key, function (cur) {
      if (!cur) return undefined;
      var next = clone(cur);
      var t = nowMs();
      next.readState = state;
      next.stateSource = 'manual';
      next.manualStateAt = t;
      if (state === 'none') {
        next.progress = 0;
        next.doneAt = 0;
      } else if (state === 'done') {
        next.doneAt = next.doneAt || t;
        if (typeof progress === 'number') next.progress = Math.max(0, Math.min(1, progress));
      } else {
        next.doneAt = 0;
        if (typeof progress === 'number') next.progress = Math.max(0, Math.min(1, progress));
      }
      next.updatedAt = t;
      return next;
    });
  }

  // 进度节流：滚动期间只更新内存，5s 落盘一次；flushProgress 用于路由切换/页面隐藏。
  // 每个待写项带上"采样时刻"，落盘时若已被更新的人工状态覆盖则丢弃。
  function scheduleProgress(type, refId, progress) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return; }
    progressPending.set(key, {
      p: Math.max(0, Math.min(1, Number(progress) || 0)),
      at: nowMs()
    });
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
      var v = pair[1];
      var p = (v && typeof v === 'object') ? v.p : v;
      var at = (v && typeof v === 'object') ? v.at : 0;
      seq = seq.then(function () { return saveProgressByKey(pair[0], p, at); });
    });
    return seq;
  }

  function saveProgressByKey(key, p, at) {
    return safeMutate(key, function (cur) {
      if (!cur) return undefined;
      var manual = cur.stateSource === 'manual';
      // 显式标记未读后，自动滚动不得把它重新变回"阅读中"
      if (manual && cur.readState === 'none') return undefined;
      // 人工操作晚于本次采样 → 这是过期任务（含多标签页场景），直接丢弃。
      // 用严格大于：同一毫秒内"先标记、后立即滚动"仍算新采样，状态由 manual 标志保护。
      if (cur.manualStateAt && cur.manualStateAt > (Number(at) || 0)) return undefined;
      var next = clone(cur);
      var t = nowMs();
      next.progress = Math.round(p * 100) / 100;
      var st = deriveState(p);
      // 人工状态优先级更高：只允许"自动爬升到 done"，不允许把 done 退回去
      if (!manual && next.readState !== 'done') next.readState = st;
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
      // 只删历史字段；只有不存在任何长期个人状态时才整条删除
      if (!hasPersonalState(next)) return null;
      return next;
    });
  }

  // 清理全部历史：走批量事务（一次提交 / 失败整体回滚），不再逐条写
  function clearAllHistory() {
    return getAllSafe().then(function (all) {
      var keys = (all || []).filter(function (r) { return r && r.lastSeenAt > 0; })
        .map(function (r) { return r.key; });
      if (!keys.length) return { ok: true, total: 0, changed: 0, deleted: 0 };
      return bulk(keys, 'history-clear');
    });
  }

  function ensureReady() {
    if (backend) return Promise.resolve();
    var p = init();
    return p ? p.then(function () { return null; }) : Promise.resolve();
  }

  // 读取快照：把"这次读取是否成功"跟随结果一起返回，
  // 不再用共享变量判断完整性（否则并发读取会互相改写对方的结论）。
  function readSnapshot() {
    if (!backend) return ensureReady().then(readSnapshot);
    return backend.getAll().then(function (all) {
      return { rows: all || [], source: 'database', complete: !degraded, warning: '' };
    }).catch(function () {
      return {
        rows: Array.from(cache.values()),
        source: 'cache',
        complete: false,
        warning: '读取本地数据库失败，以下内容来自缓存回退，可能不完整'
      };
    });
  }

  function getAllSafe() {
    return readSnapshot().then(function (s) { return s.rows; });
  }

  // 删除记录：成功时返回 { ok, deleted }；无变化返回 deleted=false；失败返回 ok=false
  function remove(key) {
    if (!key) return Promise.resolve({ ok: false, deleted: false, changed: false });
    return mutateWithOutcome(key, function () { return null; }).then(function (r) {
      return { ok: r.ok, deleted: r.deleted, changed: r.changed };
    });
  }

  function list(opts) {
    var o = opts || {};
    return getAllSafe().then(function (all) {
      var rows = (all || []).slice();
      if (o.type) rows = rows.filter(function (r) { return r.type === o.type; });
      if (o.flag === 'fav') rows = rows.filter(function (r) { return !!r.fav; });
      if (o.flag === 'later') rows = rows.filter(function (r) { return !!r.later; });
      if (o.flag === 'history') rows = rows.filter(function (r) { return r.lastSeenAt > 0; });
      // 分类筛选只作用于收藏；未收藏的记录不参与分类维度
      if (o.cat && o.cat !== 'all') {
        rows = rows.filter(function (r) { return !!r.fav && (r.favCat || CAT_DEFAULT) === o.cat; });
      }
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
    var out = {
      key: r.key, type: r.type, refId: r.refId, title: r.title || '',
      fav: r.fav ? 1 : 0, favAt: r.favAt || 0, favCat: r.favCat || 'default',
      later: r.later ? 1 : 0, laterAt: r.laterAt || 0,
      readState: r.readState || 'none', progress: r.progress || 0,
      firstSeenAt: r.firstSeenAt || 0, lastSeenAt: r.lastSeenAt || 0,
      doneAt: r.doneAt || 0, updatedAt: r.updatedAt || 0
    };
    // Batch 9A-2 修订：人工状态的来源与时间必须一起导出，否则"已读/未读"
    // 在往返后会退化成普通进度，被旧滚动任务覆盖。缺省时不写，保持旧文件形状。
    if (r.stateSource) out.stateSource = String(r.stateSource);
    if (r.manualStateAt) out.manualStateAt = Number(r.manualStateAt) || 0;
    return out;
  }

  function exportData() {
    if (!backend) return ensureReady().then(exportData);
    // 导出必须"记录 + 分类"来自同一个只读事务；读取失败则整体回退到缓存并标记不完整。
    var read = (typeof backend.readAll === 'function')
      ? backend.readAll()
      : backend.getAll().then(function (rows) { return { rows: rows, cats: null }; });
    return read.then(function (snap) {
      var rows = (snap && snap.rows) || [];
      var cats = normalizeCategories(snap && snap.cats);
      catCache = cats;
      var complete = !degraded;
      return {
        app: IMPORT_APP,
        kind: IMPORT_KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        // 只有"未降级 + 本次事务读成功"才算完整持久化快照；
        // 内存降级或读取失败时导出的是当前可用数据，必须显式标记为不完整。
        persistence: degraded ? 'memory' : 'indexeddb',
        source: 'database',
        degraded: !!degraded,
        complete: complete,
        warning: complete ? '' : '本地数据库不可用，导出的是本次会话内存数据，刷新后会丢失',
        categories: cats,
        records: rows.map(publicRecord)
      };
    }).catch(function (e) {
      var cats = normalizeCategories(catCache);
      return {
        app: IMPORT_APP,
        kind: IMPORT_KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        persistence: degraded ? 'memory' : 'cache',
        source: 'cache',
        degraded: !!degraded,
        complete: false,
        warning: '读取本地数据库失败（' + (e && e.message || e) + '），导出内容来自缓存回退，可能不完整',
        categories: cats,
        records: Array.from(cache.values()).map(publicRecord)
      };
    });
  }

  // ---------------------------------------------------------------- 安全导入（Batch 9A-2）
  var UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

  // 只接受纯 JSON 结构：深度受限、拒绝原型污染键、拒绝函数/symbol
  function scanUnsafe(v, depth, path) {
    if (depth > IMPORT_MAX_DEPTH) return path + '：嵌套层级过深';
    if (v === undefined) return null;                 // 可选字段缺省不算非法
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return null;
    if (typeof v === 'string') return null;
    if (typeof v !== 'object') return path + '：包含非法类型';
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length && i < 5000; i++) {
        var e = scanUnsafe(v[i], depth + 1, path + '[' + i + ']');
        if (e) return e;
      }
      return null;
    }
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      if (UNSAFE_KEYS.indexOf(keys[k]) !== -1) return path + '：包含不允许的字段 "' + keys[k] + '"';
      var err = scanUnsafe(v[keys[k]], depth + 1, path + '.' + keys[k]);
      if (err) return err;
    }
    return null;
  }

  function isTs(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return false;
    var limit = nowMs() + 86400000;                   // 容忍 1 天时钟漂移
    return v <= limit;
  }

  function validateRecord(raw, index, errors) {
    var at = 'records[' + index + ']';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(at + '：记录必须是对象');
      return null;
    }
    var key = typeof raw.key === 'string' ? raw.key.trim() : '';
    var sp = splitKey(key);
    if (!sp || !isKnownType(sp.type) || !sp.refId) {
      errors.push(at + '：key 不是合法的 type:refId');
      return null;
    }
    if (sp.refId.length > 200) { errors.push(at + '：refId 过长'); return null; }
    if (raw.type && raw.type !== sp.type) { errors.push(at + '：type 与 key 不一致'); return null; }
    if (raw.refId && String(raw.refId) !== sp.refId) { errors.push(at + '：refId 与 key 不一致'); return null; }
    var title = raw.title == null ? '' : raw.title;
    if (typeof title !== 'string' || title.length > 300) { errors.push(at + '：title 非法或过长'); return null; }
    if (raw.fav !== 0 && raw.fav !== 1 && raw.fav !== true && raw.fav !== false && raw.fav !== undefined) {
      errors.push(at + '：fav 只能取 0/1'); return null;
    }
    if (raw.later !== 0 && raw.later !== 1 && raw.later !== true && raw.later !== false && raw.later !== undefined) {
      errors.push(at + '：later 只能取 0/1'); return null;
    }
    var state = raw.readState == null ? 'none' : raw.readState;
    if (['none', 'reading', 'done'].indexOf(state) === -1) { errors.push(at + '：readState 非法'); return null; }
    var progress = raw.progress == null ? 0 : raw.progress;
    if (typeof progress !== 'number' || !isFinite(progress) || progress < 0 || progress > 1) {
      errors.push(at + '：progress 必须在 0–1 之间'); return null;
    }
    var cat = raw.favCat == null ? CAT_DEFAULT : raw.favCat;
    if (typeof cat !== 'string' || !cat || cat.length > 64) { errors.push(at + '：favCat 非法'); return null; }
    var stamps = ['favAt', 'laterAt', 'firstSeenAt', 'lastSeenAt', 'doneAt', 'updatedAt'];
    for (var i = 0; i < stamps.length; i++) {
      var v = raw[stamps[i]];
      if (v === undefined || v === null) continue;
      if (!isTs(v)) { errors.push(at + '：' + stamps[i] + ' 时间戳非法'); return null; }
    }
    // 可选：人工状态来源与时间（v1 / 早期 v2 备份没有这两个字段，缺省即兼容）
    var stateSource = raw.stateSource;
    if (stateSource !== undefined && stateSource !== null) {
      if (typeof stateSource !== 'string' || STATE_SOURCES.indexOf(stateSource) === -1) {
        errors.push(at + '：stateSource 非法');
        return null;
      }
    }
    var manualStateAt = raw.manualStateAt;
    if (manualStateAt !== undefined && manualStateAt !== null) {
      if (!isTs(manualStateAt)) { errors.push(at + '：manualStateAt 时间戳非法'); return null; }
    }
    var rec = {
      key: key, type: sp.type, refId: sp.refId, title: title,
      fav: raw.fav ? 1 : 0, favAt: raw.favAt || 0, favCat: cat,
      later: raw.later ? 1 : 0, laterAt: raw.laterAt || 0,
      readState: state, progress: Math.round(progress * 100) / 100,
      firstSeenAt: raw.firstSeenAt || 0, lastSeenAt: raw.lastSeenAt || 0,
      doneAt: raw.doneAt || 0, updatedAt: raw.updatedAt || 0
    };
    if (stateSource) rec.stateSource = stateSource;
    if (manualStateAt) rec.manualStateAt = manualStateAt;
    return rec;
  }

  function validateImport(payload, opts) {
    var o = opts || {};
    var errors = [];
    if (o.bytes && o.bytes > IMPORT_MAX_BYTES) {
      return { ok: false, errors: ['文件超过 ' + (IMPORT_MAX_BYTES / 1024 / 1024) + 'MB 上限'], payload: null };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, errors: ['文件内容必须是 JSON 对象'], payload: null };
    }
    var unsafe = scanUnsafe(payload, 0, '$');
    if (unsafe) return { ok: false, errors: ['结构不安全：' + unsafe], payload: null };
    if (payload.app !== IMPORT_APP) errors.push('app 必须是 "' + IMPORT_APP + '"');
    if (payload.kind !== IMPORT_KIND) errors.push('kind 必须是 "' + IMPORT_KIND + '"');
    var ver = payload.schemaVersion;
    if (typeof ver !== 'number' || IMPORT_VERSIONS.indexOf(ver) === -1) {
      errors.push(ver > SCHEMA_VERSION
        ? '不支持的未来版本 schemaVersion=' + ver + '，请升级站点后再导入'
        : 'schemaVersion 非法：' + String(ver));
    }
    if (!Array.isArray(payload.records)) errors.push('records 必须是数组');
    if (payload.categories !== undefined && !Array.isArray(payload.categories)) {
      errors.push('categories 必须是数组');
    }
    if (errors.length) return { ok: false, errors: errors, payload: null };

    var recs = payload.records;
    if (recs.length > IMPORT_MAX_RECORDS) errors.push('记录数超过上限（' + IMPORT_MAX_RECORDS + '）');
    var catsRaw = payload.categories || [];
    if (catsRaw.length > CAT_MAX) errors.push('分类数超过上限（' + CAT_MAX + '）');

    var seen = {};
    var out = [];
    recs.forEach(function (r, i) {
      var rec = validateRecord(r, i, errors);
      if (!rec) return;
      if (seen[rec.key]) { errors.push('records[' + i + ']：重复的 key ' + rec.key); return; }
      seen[rec.key] = true;
      out.push(rec);
    });

    var cats = [];
    var catIds = {};
    var catNames = {};
    catsRaw.forEach(function (c, i) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push('categories[' + i + ']：分类必须是对象'); return; }
      var id = typeof c.id === 'string' ? c.id.trim() : '';
      var name = sanitizeCatName(c.name);
      if (!id || id.length > 64) { errors.push('categories[' + i + ']：id 非法'); return; }
      if (!name) { errors.push('categories[' + i + ']：name 不能为空'); return; }
      if (String(c.name).trim().length > CAT_NAME_MAX) { errors.push('categories[' + i + ']：name 过长'); return; }
      if (catIds[id]) { errors.push('categories[' + i + ']：重复的 id ' + id); return; }
      if (catNames[name.toLowerCase()]) { errors.push('categories[' + i + ']：重复的名称 ' + name); return; }
      catIds[id] = true;
      catNames[name.toLowerCase()] = true;
      cats.push({ id: id, name: name, system: id === CAT_DEFAULT });
    });

    if (errors.length) return { ok: false, errors: errors, payload: null };
    return {
      ok: true,
      errors: [],
      payload: {
        schemaVersion: ver,
        records: out,
        categories: normalizeCategories(cats),
        complete: payload.complete === true,
        persistence: String(payload.persistence || ''),
        source: String(payload.source || ''),
        exportedAt: String(payload.exportedAt || ''),
        degraded: !!payload.degraded
      }
    };
  }

  // 快照指纹：不能只用"条数 + 最大 updatedAt"——同一毫秒内写入或等量替换
  // 会得到相同 token，导致替换前的并发检查被绕过。这里对每条记录的关键字段
  // 做排序后哈希，任何一条变化都会改变指纹。
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function tokenOf(snapshot) {
    var rows = (snapshot && snapshot.rows) || [];
    var parts = rows.map(function (r) {
      return [
        r.key, r.updatedAt || 0, r.fav ? 1 : 0, r.later ? 1 : 0,
        r.favCat || '', r.readState || '', Math.round((r.progress || 0) * 100),
        r.doneAt || 0, r.manualStateAt || 0, r.lastSeenAt || 0
      ].join(',');
    }).sort();
    var cats = normalizeCategories(snapshot && snapshot.cats)
      .map(function (c) { return c.id + '=' + c.name; }).join('|');
    return rows.length + '-' + fnv1a(parts.join(';') + '#' + cats);
  }

  function previewImport(payload, opts) {
    var o = opts || {};
    return loadCategories().then(function (cats) {
      return readSnapshot().then(function (snap) {
        var existing = {};
        (snap.rows || []).forEach(function (r) { existing[r.key] = r; });
        var localCats = {};
        cats.forEach(function (c) { localCats[c.id] = c; });
        var newRecs = [];
        var conflicts = 0;
        var stale = 0;
        var missingCat = 0;
        payload.records.forEach(function (r) {
          if (existing[r.key]) { conflicts++; return; }
          var alive = (typeof o.resolve === 'function') ? !!o.resolve(r.type, r.refId) : true;
          if (!alive) { stale++; return; }
          if (!localCats[r.favCat] && !payload.categories.some(function (c) { return c.id === r.favCat; })) missingCat++;
          newRecs.push(r);
        });
        var newCats = [];
        var catConflicts = [];
        payload.categories.forEach(function (c) {
          if (c.id === CAT_DEFAULT) return;             // 默认分类是内置的，不计入冲突
          if (localCats[c.id]) catConflicts.push(c.id);
          else newCats.push(c);
        });
        return {
          ok: true,
          total: payload.records.length,
          incoming: newRecs.length,
          conflicts: conflicts,
          stale: stale,
          missingCategoryRefs: missingCat,
          newCategories: newCats.length,
          categoryConflicts: catConflicts.length,
          categoryConflictIds: catConflicts,
          source: payload.source || '',
          persistence: payload.persistence || '',
          complete: payload.complete === true,
          exportedAt: payload.exportedAt || '',
          token: tokenOf(snap),
          degraded: !!degraded,
          canReplace: payload.complete === true && payload.source === 'database' &&
            payload.persistence === 'indexeddb' && !degraded
        };
      });
    });
  }

  function applyImport(payload, opts) {
    var o = opts || {};
    var mode = o.mode === 'replace' ? 'replace' : 'merge';
    if (degraded || usingMemory || !backend) {
      return Promise.resolve({
        ok: false,
        reason: '本地数据库不可用（当前为内存降级模式），不能导入，避免"看似保存成功"',
        imported: 0, categories: 0, replaced: false
      });
    }
    var blocked = writeBlockedReason();
    if (blocked) {
      return Promise.resolve({ ok: false, reason: blocked, imported: 0, categories: 0, replaced: false });
    }
    if (mode === 'replace') {
      if (o.confirm !== true) return Promise.resolve({ ok: false, reason: '替换需要二次确认', imported: 0, categories: 0, replaced: false });
      if (!(payload.complete === true && payload.source === 'database' && payload.persistence === 'indexeddb')) {
        return Promise.resolve({
          ok: false,
          reason: '该文件不是完整备份（complete/source/persistence 不满足替换契约），只能使用合并导入',
          imported: 0, categories: 0, replaced: false
        });
      }
    }
    return loadCategories().then(function (cats) {
      return readSnapshot().then(function (snap) {
        if (o.expectToken && tokenOf(snap) !== o.expectToken) {
          return {
            ok: false,
            reason: '确认期间本地数据发生了变化，请重新预览后再导入',
            imported: 0, categories: 0, replaced: false
          };
        }
        var existing = {};
        (snap.rows || []).forEach(function (r) { existing[r.key] = r; });
        var localCats = {};
        cats.forEach(function (c) { localCats[c.id] = c; });

        // 合并后的分类：本地优先保留（id 冲突不覆盖本地名称）
        var finalCats = cats.slice();
        payload.categories.forEach(function (c) {
          if (!localCats[c.id]) finalCats.push(c);
        });
        finalCats = normalizeCategories(finalCats);
        var valid = {};
        finalCats.forEach(function (c) { valid[c.id] = true; });

        function fixCat(rec) {
          if (valid[rec.favCat]) return rec;
          var n = clone(rec);
          n.favCat = CAT_DEFAULT;
          return n;
        }

        if (mode === 'replace') {
          var rows = payload.records
            .filter(function (r) { return typeof o.resolve !== 'function' || o.resolve(r.type, r.refId); })
            .map(fixCat);
          // expect 传进事务内做权威比对：预检查只是快速失败，不能作为最终依据
          return backend.replaceAll(rows, finalCats, o.expectToken || null).then(function (res) {
            if (res && res.ok === false && res.conflict) {
              return {
                ok: false,
                reason: '确认期间本地数据发生了变化，请重新预览后再导入',
                imported: 0, categories: 0, replaced: false, conflict: true
              };
            }
            _writeGen++;
            catCache = finalCats;
            return refreshCache().then(function () {
              notify([]);
              return {
                ok: true, replaced: true, imported: rows.length,
                categories: finalCats.length, removed: (snap.rows || []).length,
                changed: true
              };
            });
          }).catch(function (e) {
            return { ok: false, reason: '替换失败，原有数据未改动：' + (e && e.message || e), imported: 0, categories: 0, replaced: false };
          });
        }

        // 合并：只插入本地不存在且内容仍有效的新记录；本地记录一律保留
        var inserts = [];
        payload.records.forEach(function (r) {
          if (existing[r.key]) return;
          if (typeof o.resolve === 'function' && !o.resolve(r.type, r.refId)) return;
          inserts.push(fixCat(r));
        });
        var addCats = finalCats.length - cats.length;
        if (!inserts.length && addCats <= 0) {
          return { ok: true, replaced: false, imported: 0, categories: 0, changed: false };
        }
        var keys = inserts.map(function (r) { return r.key; });
        var byKey = {};
        inserts.forEach(function (r) { byKey[r.key] = r; });
        return backend.runAtomic(
          function () { return finalCats; },
          keys,
          function (cur, key) { return cur ? undefined : byKey[key]; }
        ).then(function (res) {
          _writeGen++;
          catCache = finalCats;
          return refreshCache().then(function () {
            notify(keys);
            var imported = (res && res.records ? res.records.filter(function (v) { return v && v.key; }).length : keys.length);
            return {
              ok: true, replaced: false, imported: imported,
              categories: addCats > 0 ? addCats : 0, changed: true
            };
          });
        }).catch(function (e) {
          return { ok: false, reason: '导入失败（已回滚，原有数据未改动）：' + (e && e.message || e), imported: 0, categories: 0, replaced: false };
        });
      });
    });
  }

  function stateOf(type, refId) {
    var key;
    try { key = makeKey(type, refId); } catch (e) { return null; }
    return cache.get(key) || null;
  }

  function status() {
    return {
      degraded: degraded, usingMemory: usingMemory, reason: degradeReason, ready: !!backend,
      // 迁移可见性：失败/未来版本都要能被 UI 读到，而不是静默成功
      migration: {
        ok: migrationState.ok, failed: migrationState.failed, future: migrationState.future,
        from: migrationState.from, to: migrationState.to, fixed: migrationState.fixed || 0,
        reason: migrationState.reason
      }
    };
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
    // Batch 9A-2：分类 / 批量 / 导入
    categories: categories,
    addCategory: addCategory,
    renameCategory: renameCategory,
    removeCategory: removeCategory,
    assignCategory: assignCategory,
    bulk: bulk,
    validateImport: validateImport,
    previewImport: previewImport,
    applyImport: applyImport,
    // 内部：快照指纹。对外只用于测试与排障（不要用它做业务判断）
    _snapshotToken: tokenOf,
    // 当前写入闸门原因（空串 = 可写）。UI 用它给用户明确提示。
    writeBlockedReason: writeBlockedReason,
    // 内部：自动裁剪入口（测试与排障用；业务代码通过 recordView 间接触发）
    _pruneHistory: pruneHistory,
    _enforceHistoryLimit: enforceHistoryLimit,
    // 测试用：模拟"迁移失败/未来版本"状态（真实路径见 migrateMeta）
    _forceMigrationBlock: function (o) {
      var opt = o || {};
      migrationState.future = !!opt.future;
      migrationState.failed = !!opt.failed;
      migrationState.ok = !(migrationState.future || migrationState.failed);
      migrationState.reason = opt.reason || '测试注入的写入闸门';
      return { future: migrationState.future, failed: migrationState.failed };
    },
    CAT_DEFAULT: CAT_DEFAULT,
    CAT_NAME_MAX: CAT_NAME_MAX,
    SCHEMA_VERSION: SCHEMA_VERSION,
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
      catCache = null;
      setupChannel();
      // readyPromise 必须覆盖迁移本身：否则 init() 会在分类 meta 落盘前就 resolve
      readyPromise = migrateMeta().catch(function () { return null; }).then(refreshCache)
        .then(function () { return { ok: true, degraded: false, reason: '' }; });
      return readyPromise;
    },
    _resetForTest: function () {
      backend = null; usingMemory = false; degraded = false; degradeReason = '';
      readyPromise = null; cache = new Map(); listeners = [];
      catCache = null;
      progressPending = new Map(); if (progressTimer) { clearTimeout(progressTimer); progressTimer = 0; }
    }
  };

  global.Knowledge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
