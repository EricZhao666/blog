#!/usr/bin/env node
'use strict';
/**
 * Batch 9A-2：知识库分类 / 批量管理 / 显式状态 / 安全导入专项（无浏览器）
 *
 * 通过 vm 加载真实 js/knowledge.js，注入一个语义与 IndexedDB 对齐的假后端
 * （mutateMany / runAtomic / replaceAll 均为"失败整体回滚"），覆盖：
 *   分类增删改与默认分类保护、删除分类迁移归属、批量事务与回滚、
 *   显式已读/未读与过期进度、导出完整性、导入校验/预览/合并/替换/降级拒绝/往返一致。
 *
 * 用法：node tests/test53_knowledge_management.js
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

// ---------------------------------------------------------------- 假后端
// 语义对齐 IDB：写操作在队列内串行；mutateMany / runAtomic / replaceAll 失败时整体回滚。
function makeBackend() {
  const map = new Map();
  const meta = new Map();
  const state = {
    failBulk: false, failReplace: false, failAll: false, failUpdaterAt: -1, writes: 0,
    failSetMetaCat: false, failMigrateMany: false,
    onNextMutate: null          // 在"已取到候选、尚未写入"的时刻插入回调（模拟闸门在排队期间关闭）
  };
  let chain = Promise.resolve();
  function enqueue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(function () { });
    return p;
  }
  function snap() {
    return { rows: new Map(Array.from(map.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])), meta: new Map(meta) };
  }
  function restore(s) {
    map.clear(); s.rows.forEach((v, k) => map.set(k, v));
    meta.clear(); s.meta.forEach((v, k) => meta.set(k, v));
  }
  return {
    state: state,
    kind: 'idb',
    get(key) { return Promise.resolve(map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null); },
    getAll() {
      if (state.failAll) return Promise.reject(new Error('injected read failure'));
      return Promise.resolve(Array.from(map.values()).map(v => JSON.parse(JSON.stringify(v))));
    },
    getMeta(k) { return Promise.resolve(meta.has(k) ? JSON.parse(JSON.stringify(meta.get(k))) : null); },
    setMeta(k, v) {
      if (state.failSetMetaCat && k === 'favCategories') return Promise.reject(new Error('injected setMeta failure'));
      meta.set(k, JSON.parse(JSON.stringify(v)));
      return Promise.resolve();
    },
    readAll() {
      if (state.failAll) return Promise.reject(new Error('injected readAll failure'));
      return Promise.resolve({
        rows: Array.from(map.values()).map(v => JSON.parse(JSON.stringify(v))),
        cats: meta.has('favCategories') ? JSON.parse(JSON.stringify(meta.get('favCategories'))) : null
      });
    },
    mutate(key, updater) {
      return enqueue(() => {
        if (state.onNextMutate) { const fn = state.onNextMutate; state.onNextMutate = null; fn(); }
        const cur = map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
        const next = updater(cur);
        if (next === null) map.delete(key);
        else if (next !== undefined) map.set(key, JSON.parse(JSON.stringify(next)));
        state.writes++;
        return next === undefined ? cur : (next ? JSON.parse(JSON.stringify(next)) : null);
      });
    },
    mutateMany(keys, updater) {
      return enqueue(() => {
        const s = snap();
        const out = [];
        try {
          if (state.failBulk || state.failMigrateMany) throw new Error('injected bulk failure');
          (keys || []).forEach((key, i) => {
            if (state.failUpdaterAt === i) throw new Error('injected updater failure');
            const cur = map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
            const next = updater(cur, key);
            if (next === null) map.delete(key);
            else if (next !== undefined) map.set(key, JSON.parse(JSON.stringify(next)));
            out.push(next === undefined ? cur : next);
          });
          state.writes++;
          return out;
        } catch (e) { restore(s); throw e; }
      });
    },
    runAtomic(metaUpdater, keys, recUpdater) {
      return enqueue(() => {
        const s = snap();
        try {
          if (state.failBulk) throw new Error('injected atomic failure');
          const curMeta = meta.has('favCategories') ? JSON.parse(JSON.stringify(meta.get('favCategories'))) : null;
          const nm = metaUpdater(curMeta);
          if (nm !== undefined) meta.set('favCategories', JSON.parse(JSON.stringify(nm)));
          const out = [];
          (keys || []).forEach((key, i) => {
            if (state.failUpdaterAt === i) throw new Error('injected updater failure');
            const cur = map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
            const next = recUpdater(cur, key);
            if (next === null) map.delete(key);
            else if (next !== undefined) map.set(key, JSON.parse(JSON.stringify(next)));
            out.push(next === undefined ? cur : next);
          });
          state.writes++;
          return { meta: nm === undefined ? curMeta : nm, records: out };
        } catch (e) { restore(s); throw e; }
      });
    },
    replaceAll(rows, cats, expect) {
      return enqueue(() => {
        const s = snap();
        if (expect) {
          // 与实现一致：权威检查发生在"清空之前"，同一队列内
          const cur = LAST_API._snapshotToken({
            rows: Array.from(map.values()),
            cats: meta.has('favCategories') ? meta.get('favCategories') : null
          });
          if (cur !== expect) return { ok: false, conflict: true };
        }
        try {
          if (state.failReplace) throw new Error('injected replace failure');
          map.clear();
          (rows || []).forEach(r => map.set(r.key, JSON.parse(JSON.stringify(r))));
          meta.set('favCategories', JSON.parse(JSON.stringify(cats)));
          state.writes++;
          return true;
        } catch (e) { restore(s); throw e; }
      });
    },
    clear() { map.clear(); meta.clear(); return Promise.resolve(); }
  };
}

let LAST_API = null;

function loadModule(backend) {
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    localStorage: { setItem() { }, getItem() { return null; }, removeItem() { } },
    document: { dispatchEvent() { }, addEventListener() { } },
    CustomEvent: function () { },
    BroadcastChannel: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: 'js/knowledge.js' });
  const api = sandbox.window.Knowledge;
  LAST_API = api;
  if (backend) api._injectBackend(backend);
  return { api: api, sandbox: sandbox };
}

async function setup() {
  const b = makeBackend();
  const m = loadModule(b);
  await m.api.init();
  return { b, m, api: m.api };
}

// ---------------------------------------------------------------- 导入样本
function makeExport(over) {
  const base = {
    app: 'ericzhao-blog',
    kind: 'knowledge',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    persistence: 'indexeddb',
    source: 'database',
    degraded: false,
    complete: true,
    warning: '',
    categories: [{ id: 'default', name: '默认分类', system: true }, { id: 'cat-a', name: '论文', system: false }],
    records: [
      { key: 'post:imp1', type: 'post', refId: 'imp1', title: '导入文章一', fav: 1, favAt: 1000, favCat: 'cat-a', later: 0, laterAt: 0, readState: 'reading', progress: 0.4, firstSeenAt: 900, lastSeenAt: 1000, doneAt: 0, updatedAt: 1000 },
      { key: 'post:imp2', type: 'post', refId: 'imp2', title: '导入文章二', fav: 0, favAt: 0, favCat: 'default', later: 1, laterAt: 1100, readState: 'done', progress: 1, firstSeenAt: 0, lastSeenAt: 1100, doneAt: 1100, updatedAt: 1100 }
    ]
  };
  return Object.assign(base, over || {});
}

(async function run() {
  // ============================================================ 分类
  {
    const { b, api } = await setup();
    const def = await api.categories();
    check('K1 默认分类自动补齐且排第一', def.length === 1 && def[0].id === 'default' && def[0].name === '默认分类',
      JSON.stringify(def));

    const bad1 = await api.removeCategory('default');
    check('K2 默认分类不可删除', bad1.ok === false && /默认分类不可删除/.test(bad1.reason || ''), bad1.reason);

    const add = await api.addCategory('  论文  阅读  ');
    check('K3 新建分类并归一化空白', add.ok === true && add.category.name === '论文 阅读' && !!add.category.id,
      JSON.stringify(add.category));

    const add2 = await api.addCategory('论文 阅读');
    check('K4 重复名称被拒绝（大小写/空白归一后比较）', add2.ok === false && /同名/.test(add2.reason), add2.reason);

    const add3 = await api.addCategory('   ');
    check('K5 空名称被拒绝', add3.ok === false && /不能为空/.test(add3.reason), add3.reason);

    const add4 = await api.addCategory('x'.repeat(api.CAT_NAME_MAX + 1));
    check('K6 超长名称被拒绝', add4.ok === false && /最多/.test(add4.reason), add4.reason);

    const ren = await api.renameCategory(add.category.id, '文献综述');
    const afterRename = await api.categories();
    check('K7 重命名保留分类 ID', ren.ok === true && afterRename.some(c => c.id === add.category.id && c.name === '文献综述'),
      JSON.stringify(afterRename));

    // 收藏归属 + 删除分类迁移
    await api.recordView('post', 'p1', { title: 'A' });
    await api.setFlag('post', 'p1', 'fav', true);
    await api.assignCategory('post:p1', add.category.id);
    await api.recordView('post', 'p2', { title: 'B' });
    await api.setFlag('post', 'p2', 'later', true);
    await api.recordView('post', 'p3', { title: 'C' });
    await api.setFlag('post', 'p3', 'fav', true);

    const before = await api.list({ flag: 'fav', cat: add.category.id });
    check('K8 收藏可移动到自定义分类并可按分类筛选', before.length === 1 && before[0].key === 'post:p1',
      before.map(r => r.key).join(','));

    const del = await api.removeCategory(add.category.id);
    const after = await api.list({ flag: 'fav' });
    const p1 = after.filter(r => r.key === 'post:p1')[0];
    check('K9 删除分类后收藏原子迁回默认分类且记录保留',
      del.ok === true && del.moved === 1 && !!p1 && p1.favCat === 'default',
      JSON.stringify({ moved: del.moved, favCat: p1 && p1.favCat }));

    const p2 = (await api.list({ flag: 'later' })).filter(r => r.key === 'post:p2')[0];
    const p3 = (await api.list({ flag: 'fav' })).filter(r => r.key === 'post:p3')[0];
    check('K10 分类操作不影响待读与其他收藏', !!p2 && p2.later === 1 && !!p3 && p3.fav === 1, JSON.stringify([!!p2, !!p3]));

    // 事务失败：删除分类不得留下半成品
    const add5 = await api.addCategory('会失败的分类');
    await api.assignCategory('post:p1', add5.category.id);
    b.state.failBulk = true;
    const delFail = await api.removeCategory(add5.category.id);
    b.state.failBulk = false;
    const stillThere = (await api.categories()).some(c => c.id === add5.category.id);
    const p1Again = (await api.list({ flag: 'fav' })).filter(r => r.key === 'post:p1')[0];
    check('K11 删除分类事务失败时整体回滚（分类与归属都保留）',
      delFail.ok === false && stillThere && p1Again.favCat === add5.category.id,
      JSON.stringify({ ok: delFail.ok, stillThere, cat: p1Again && p1Again.favCat }));
  }

  // ============================================================ 批量
  {
    const { b, api } = await setup();
    const cat = await api.addCategory('批量分类');
    for (let i = 0; i < 5; i++) {
      await api.recordView('post', 'b' + i, { title: 'B' + i });
      await api.setFlag('post', 'b' + i, 'fav', true);
    }
    const keys = ['post:b0', 'post:b1', 'post:b2'];

    const moved = await api.bulk(keys, 'cat', { catId: cat.category.id });
    const inCat = await api.list({ flag: 'fav', cat: cat.category.id });
    check('B1 批量移动分类（单事务）',
      moved.ok === true && moved.changed === 3 && inCat.length === 3, JSON.stringify(moved));

    const off = await api.bulk(keys, 'fav-off');
    const favs = await api.list({ flag: 'fav' });
    const rec0 = (await api.list({})).filter(r => r.key === 'post:b0')[0];
    check('B2 批量取消收藏不删除记录且保留分类归属',
      off.ok === true && favs.length === 2 && rec0 && rec0.fav === 0 && rec0.favCat === cat.category.id,
      JSON.stringify({ favs: favs.length, rec0: rec0 && { fav: rec0.fav, cat: rec0.favCat } }));

    const laterOn = await api.bulk(keys, 'later-on');
    const laterOff = await api.bulk(['post:b0'], 'later-off');
    const laterRows = await api.list({ flag: 'later' });
    check('B3 批量加入/移出待读',
      laterOn.ok === true && laterOn.changed === 3 && laterOff.ok === true && laterRows.length === 2,
      JSON.stringify({ on: laterOn.changed, left: laterRows.length }));

    await api.saveProgress('post', 'b3', 0.5);
    const done = await api.bulk(['post:b3'], 'read-done');
    const doneRec = api.state('post', 'b3');
    check('B4 批量标记已读建立 done + doneAt 且不伪造进度',
      done.ok === true && doneRec.readState === 'done' && doneRec.doneAt > 0 && doneRec.progress === 0.5,
      JSON.stringify({ st: doneRec.readState, p: doneRec.progress, doneAt: doneRec.doneAt }));

    const none = await api.bulk(['post:b3'], 'read-none');
    const noneRec = api.state('post', 'b3');
    check('B5 批量标记未读清空进度与 doneAt',
      none.ok === true && noneRec.readState === 'none' && noneRec.progress === 0 && noneRec.doneAt === 0,
      JSON.stringify({ st: noneRec.readState, p: noneRec.progress, doneAt: noneRec.doneAt }));

    await api.recordView('post', 'h1', { title: 'H1' });
    await api.setFlag('post', 'h1', 'fav', true);
    await api.recordView('post', 'h2', { title: 'H2' });      // 纯历史：没有任何长期状态
    const hist = await api.bulk(['post:h1', 'post:h2'], 'history-clear');
    const h1 = api.state('post', 'h1');
    const h2 = api.state('post', 'h2');
    check('B6 批量清理历史：纯历史整条删除，带长期状态的只清历史',
      hist.ok === true && !!h1 && h1.lastSeenAt === 0 && h1.fav === 1 && !h2 && hist.deleted === 1,
      JSON.stringify({ h1: h1 && { seen: h1.lastSeenAt, fav: h1.fav }, h2exists: !!h2, deleted: hist.deleted }));

    b.state.failBulk = true;
    const failBulk = await api.bulk(['post:b1', 'post:b2'], 'fav-on');
    b.state.failBulk = false;
    const b1 = api.state('post', 'b1');
    check('B7 批量事务失败整体回滚（不会只改一半）',
      failBulk.ok === false && b1.fav === 0 && /回滚/.test(failBulk.reason || ''),
      JSON.stringify({ ok: failBulk.ok, fav: b1.fav }));

    const empty = await api.bulk([], 'fav-on');
    const unknown = await api.bulk(['post:b0'], 'nuke');
    check('B8 空选择与未知动作安全处理', empty.ok === true && empty.total === 0 && unknown.ok === false,
      JSON.stringify({ empty: empty.total, unknown: unknown.ok }));

    const untouched = await api.list({ flag: 'fav' });
    check('B9 批量只影响传入的 key', untouched.every(r => keys.indexOf(r.key) === -1), untouched.map(r => r.key).join(','));
  }

  // ============================================================ 显式状态与过期进度
  {
    const { api } = await setup();
    await api.recordView('post', 'r1', { title: 'R1' });
    await api.saveProgress('post', 'r1', 0.6);
    check('R1 自动进度建立 reading 状态', (api.state('post', 'r1')).readState === 'reading');

    await api.setReadState('post', 'r1', 'none');
    const unread = api.state('post', 'r1');
    check('R2 标记未读清空 progress 与 doneAt',
      unread.readState === 'none' && unread.progress === 0 && unread.doneAt === 0,
      JSON.stringify({ st: unread.readState, p: unread.progress }));

    await api.saveProgress('post', 'r1', 0.3);
    check('R3 显式未读后自动进度不复活 reading', (api.state('post', 'r1')).readState === 'none',
      api.state('post', 'r1').readState);

    await api.setReadState('post', 'r1', 'done');
    const done1 = api.state('post', 'r1');
    await api.saveProgress('post', 'r1', 0.2);
    const done2 = api.state('post', 'r1');
    check('R4 手动完成不会被后续滚动退回未读（进度仍可记录位置）',
      done1.readState === 'done' && done1.progress === 0 &&
      done2.readState === 'done' && done2.progress === 0.2,
      JSON.stringify({ before: done1.progress, after: done2.progress, st: done2.readState }));

    // 过期节流任务：先安排一个进度，再手动标记未读，最后 flush
    await api.recordView('post', 'r2', { title: 'R2' });
    api.scheduleProgress('post', 'r2', 0.8);
    await api.setReadState('post', 'r2', 'none');
    await api.flushProgress();
    const r2 = api.state('post', 'r2');
    check('R5 手动状态修改后，未落盘的旧节流任务不覆盖新状态',
      r2.readState === 'none' && r2.progress === 0, JSON.stringify({ st: r2.readState, p: r2.progress }));

    // 再次"打开页面"只更新 lastSeenAt
    await api.recordView('post', 'r1', { title: 'R1' });
    check('R6 再次浏览不会把 done 退回未读', (api.state('post', 'r1')).readState === 'done',
      api.state('post', 'r1').readState);
  }

  // ============================================================ 导出
  {
    const { b, api } = await setup();
    await api.setFlag('post', 'e1', 'fav', true);
    const dump = await api.exportData();
    check('E1 导出包含分类与记录且标记完整',
      dump.app === 'ericzhao-blog' && dump.kind === 'knowledge' && dump.schemaVersion === 2 &&
      Array.isArray(dump.categories) && dump.categories.length >= 1 && dump.complete === true &&
      dump.persistence === 'indexeddb' && dump.source === 'database' && dump.records.length >= 1,
      JSON.stringify({ v: dump.schemaVersion, cats: dump.categories.length, n: dump.records.length }));

    // 并发读取：A 失败不能污染 B 的完整性判断
    b.state.failAll = true;
    const badP = api.exportData();
    b.state.failAll = false;
    const goodP = api.exportData();
    const [bad, good] = await Promise.all([badP, goodP]);
    check('E2 并发导出的完整性互不影响（不再共享 _lastReadOk）',
      bad.complete === false && !!bad.warning && good.complete === true && good.records.length >= 1,
      JSON.stringify({ bad: bad.complete, good: good.complete }));

    const round = await api.applyImport(await api.exportData(), { mode: 'merge', resolve: () => true });
    check('E3 本站导出的文件可以原样导回（幂等）',
      round.ok === true && round.imported === 0, JSON.stringify(round));
  }

  // ============================================================ 导入校验
  {
    const { api } = await setup();
    const v = (fn) => { try { const r = fn(); return r && r.ok === undefined ? { ok: true } : r; } catch (e) { return { ok: false, errors: [e.message] }; } };

    const unknown = v(() => api.validateImport(makeExport({ schemaVersion: 99 })));
    check('I1 未知 schemaVersion 明确拒绝', unknown.ok === false && /未来版本|非法/.test(unknown.errors.join() || ''),
      (unknown.errors || []).join(' | '));

    const wrongApp = v(() => api.validateImport(makeExport({ app: 'other' })));
    check('I2 app/kind 不匹配拒绝', wrongApp.ok === false, (wrongApp.errors || []).join(' | '));

    const proto = JSON.parse('{"app":"ericzhao-blog","kind":"knowledge","schemaVersion":2,"records":[{"key":"post:x","__proto__":{"polluted":1}}]}');
    const protoRes = api.validateImport(proto);
    check('I3 原型污染字段被拒绝', protoRes.ok === false && /__proto__/.test(protoRes.errors.join()),
      protoRes.errors.join(' | '));

    const dup = makeExport();
    dup.records.push(JSON.parse(JSON.stringify(dup.records[0])));
    const dupRes = api.validateImport(dup);
    check('I4 重复 key 被拒绝', dupRes.ok === false && /重复/.test(dupRes.errors.join()), dupRes.errors.join(' | '));

    const badEnum = makeExport();
    badEnum.records[0].readState = 'finished';
    const enumRes = api.validateImport(badEnum);
    check('I5 readState 枚举非法被拒绝', enumRes.ok === false && /readState/.test(enumRes.errors.join()));

    const badProgress = makeExport();
    badProgress.records[0].progress = 1.5;
    const progRes = api.validateImport(badProgress);
    check('I6 progress 越界被拒绝', progRes.ok === false && /progress/.test(progRes.errors.join()));

    const badTs = makeExport();
    badTs.records[0].updatedAt = 'yesterday';
    const tsRes = api.validateImport(badTs);
    check('I7 时间戳非法被拒绝', tsRes.ok === false && /时间戳/.test(tsRes.errors.join()));

    const badKey = makeExport();
    badKey.records[0].key = 'post:imp1';
    badKey.records[0].type = 'course';
    const keyRes = api.validateImport(badKey);
    check('I8 type 与 key 不一致被拒绝', keyRes.ok === false && /不一致/.test(keyRes.errors.join()));

    const v1 = makeExport({ schemaVersion: 1, categories: undefined });
    const v1Res = api.validateImport(v1);
    check('I9 v1 历史导出（无 categories）可接受并补默认分类',
      v1Res.ok === true && v1Res.payload.categories.length === 1 && v1Res.payload.categories[0].id === 'default',
      JSON.stringify(v1Res.payload && v1Res.payload.categories));

    const tooBig = api.validateImport(makeExport(), { bytes: 3 * 1024 * 1024 });
    check('I10 超出文件大小上限被拒绝', tooBig.ok === false && /MB/.test(tooBig.errors.join()));
  }

  // ============================================================ 预览与合并
  {
    const { api } = await setup();
    await api.setFlag('post', 'imp1', 'fav', true);         // 造成一条冲突
    const payload = makeExport();

    const preview = await api.previewImport(payload, { resolve: () => true });
    check('M1 预览统计：新增/冲突/分类',
      preview.ok === true && preview.total === 2 && preview.conflicts === 1 && preview.incoming === 1 &&
      preview.newCategories === 1 && preview.categoryConflicts === 0,
      JSON.stringify({ total: preview.total, inc: preview.incoming, con: preview.conflicts, nc: preview.newCategories }));

    const stale = await api.previewImport(payload, { resolve: (t, id) => id !== 'imp2' });
    check('M2 预览统计已失效内容（不再导入）', stale.ok === true && stale.stale === 1, JSON.stringify(stale));

    const applied = await api.applyImport(payload, { mode: 'merge', resolve: () => true, expectToken: preview.token });
    const rows = await api.list({});
    const imp1 = rows.filter(r => r.key === 'post:imp1')[0];
    check('M3 合并导入只新增不冲突的记录，冲突保留本地',
      applied.ok === true && applied.imported === 1 && !!imp1 && imp1.title === '',
      JSON.stringify({ imported: applied.imported, title: imp1 && imp1.title }));

    const cats = await api.categories();
    check('M4 合并导入新增分类，且默认分类仍在',
      cats.length === 2 && cats.some(c => c.id === 'cat-a') && cats[0].id === 'default',
      cats.map(c => c.id).join(','));

    const imp2 = rows.filter(r => r.key === 'post:imp2')[0];
    check('M5 导入记录字段完整（fav/later/readState/progress）',
      !!imp2 && imp2.later === 1 && imp2.readState === 'done' && imp2.progress === 1,
      JSON.stringify(imp2 && { later: imp2.later, st: imp2.readState }));

    const again = await api.applyImport(payload, { mode: 'merge', resolve: () => true });
    check('M6 重复导入幂等（不产生重复记录）', again.ok === true && again.imported === 0,
      JSON.stringify(again));

    // 本地多出来的记录不因导入而删除
    await api.setFlag('post', 'local-only', 'later', true);
    const keep = await api.applyImport(payload, { mode: 'merge', resolve: () => true });
    const kept = (await api.list({})).some(r => r.key === 'post:local-only');
    check('M7 合并不会删除本地多出的记录', keep.ok === true && kept === true, String(kept));

    // 分类引用悬空 → 落默认分类
    const dangling = makeExport({ categories: [{ id: 'default', name: '默认分类', system: true }] });
    dangling.records[0].key = 'post:dang';
    dangling.records[0].refId = 'dang';
    dangling.records[0].favCat = 'cat-missing';
    const dangApply = await api.applyImport(dangling, { mode: 'merge', resolve: () => true });
    const dangRec = (await api.list({ fav: 1 })).filter(r => r.key === 'post:dang')[0];
    check('M8 导入记录引用不存在的分类时归入默认分类',
      dangApply.ok === true && !!dangRec && dangRec.favCat === 'default',
      JSON.stringify({ ok: dangApply.ok, cat: dangRec && dangRec.favCat }));
  }

  // ============================================================ 替换模式
  {
    const { b, api } = await setup();
    await api.setFlag('post', 'old1', 'fav', true);
    await api.setFlag('post', 'old2', 'later', true);

    const incomplete = makeExport({ complete: false, persistence: 'cache', source: 'cache' });
    const refuse = await api.applyImport(incomplete, { mode: 'replace', resolve: () => true, confirm: true });
    const still = await api.list({});
    check('P1 不完整备份禁止替换',
      refuse.ok === false && /完整备份/.test(refuse.reason || '') && still.length >= 2,
      refuse.reason);

    const noConfirm = await api.applyImport(makeExport(), { mode: 'replace', resolve: () => true });
    check('P2 替换必须二次确认', noConfirm.ok === false && /二次确认/.test(noConfirm.reason || ''), noConfirm.reason);

    const preview = await api.previewImport(makeExport(), { resolve: () => true });
    check('P3 完整备份标记可替换', preview.canReplace === true, JSON.stringify({ canReplace: preview.canReplace }));

    const replaced = await api.applyImport(makeExport(), {
      mode: 'replace', resolve: () => true, confirm: true, expectToken: preview.token
    });
    const afterRows = await api.list({});
    check('P4 替换模式清空旧记录并写入导入集合',
      replaced.ok === true && replaced.replaced === true &&
      afterRows.length === 2 && afterRows.every(r => r.key.indexOf('post:old') !== 0),
      JSON.stringify({ n: afterRows.length }));

    // 替换失败：原数据必须完整保留
    await setup2();
    async function setup2() { /* 占位：保持块结构清晰 */ }
    const b2 = makeBackend();
    const m2 = loadModule(b2);
    await m2.api.init();
    await m2.api.setFlag('post', 'safe1', 'fav', true);
    const p2 = await m2.api.previewImport(makeExport(), { resolve: () => true });
    b2.state.failReplace = true;
    const failReplace = await m2.api.applyImport(makeExport(), {
      mode: 'replace', resolve: () => true, confirm: true, expectToken: p2.token
    });
    b2.state.failReplace = false;
    const survived = await m2.api.list({});
    check('P5 替换失败后原数据完整保留',
      failReplace.ok === false && survived.length === 1 && survived[0].key === 'post:safe1',
      JSON.stringify({ ok: failReplace.ok, n: survived.length }));

    // token 变化 → 拒绝（确认期间其他标签页写入）
    const p3 = await m2.api.previewImport(makeExport(), { resolve: () => true });
    await m2.api.setFlag('post', 'newer', 'fav', true);
    const tokenFail = await m2.api.applyImport(makeExport(), {
      mode: 'merge', resolve: () => true, expectToken: p3.token
    });
    check('P6 确认期间数据变化时拒绝导入并提示重新预览',
      tokenFail.ok === false && /重新预览/.test(tokenFail.reason || ''), tokenFail.reason);
  }

  // ============================================================ 降级与往返
  {
    const b = makeBackend();
    const m = loadModule(b);
    await m.api.init();
    // 模拟持久化不可用：切到内存降级
    const sandboxApi = m.api;
    await sandboxApi.setFlag('post', 'x1', 'fav', true);
    const dump = await sandboxApi.exportData();

    const b2 = makeBackend();
    const m2 = loadModule(b2);
    await m2.api.init();
    const rt = await m2.api.applyImport(dump, { mode: 'merge', resolve: () => true });
    const rows = await m2.api.list({});
    const src = dump.records[0];
    const dst = rows.filter(r => r.key === src.key)[0];
    check('R7 导出→导入往返：记录字段一致',
      rt.ok === true && !!dst && dst.fav === src.fav && dst.favCat === src.favCat &&
      dst.readState === src.readState && dst.updatedAt === src.updatedAt,
      JSON.stringify({ src: src.key, dst: dst && dst.key }));
  }

  {
    // 降级模式（无 indexedDB）禁止导入
    const sandbox = {
      console: console,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      localStorage: { setItem() { }, getItem() { return null; } },
      document: { dispatchEvent() { }, addEventListener() { } },
      CustomEvent: function () { },
      BroadcastChannel: null
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.indexedDB = undefined;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SRC, ctx, { filename: 'js/knowledge.js' });
    const api = sandbox.window.Knowledge;
    await api.init();
    const res = await api.applyImport(makeExport(), { mode: 'merge', resolve: () => true });
    check('R8 内存降级模式拒绝导入（不宣称保存成功）',
      res.ok === false && /降级|不可用/.test(res.reason || ''), res.reason);
  }

  // ============================================================ 修订：人工状态往返（Task 1）
  {
    const { b, api } = await setup();
    await api.recordView('post', 'm1', { title: '人工已读' });
    await api.saveProgress('post', 'm1', 0.7);
    await api.setReadState('post', 'm1', 'done');          // 人工已读
    await api.recordView('post', 'm2', { title: '人工未读' });
    await api.saveProgress('post', 'm2', 0.5);
    await api.setReadState('post', 'm2', 'none');          // 人工未读

    const dump = await api.exportData();
    const rec1 = dump.records.filter(r => r.key === 'post:m1')[0];
    const rec2 = dump.records.filter(r => r.key === 'post:m2')[0];
    check('T1.1 导出保留 stateSource 与 manualStateAt',
      !!rec1 && rec1.stateSource === 'manual' && rec1.manualStateAt > 0 &&
      !!rec2 && rec2.stateSource === 'manual' && rec2.manualStateAt > 0,
      JSON.stringify([rec1 && rec1.stateSource, rec1 && rec1.manualStateAt, rec2 && rec2.stateSource]));

    const v = api.validateImport(JSON.parse(JSON.stringify(dump)), {});
    const vr1 = v.ok ? v.payload.records.filter(r => r.key === 'post:m1')[0] : null;
    check('T1.2 校验后字段仍存在且类型正确',
      v.ok === true && !!vr1 && vr1.stateSource === 'manual' && vr1.manualStateAt === rec1.manualStateAt,
      JSON.stringify(vr1 && { s: vr1.stateSource, t: vr1.manualStateAt }));

    // 导入到全新库（模拟换设备），再"重新打开数据库"
    const b2 = makeBackend();
    const m2 = loadModule(b2);
    await m2.api.init();
    const r1 = await m2.api.applyImport(v.payload, { mode: 'merge', resolve: () => true });
    const m3 = loadModule(b2);                             // 同一后端重新 init = 重新打开数据库
    await m3.api.init();
    const st1 = m3.api.state('post', 'm1') || {};
    const st2 = m3.api.state('post', 'm2') || {};
    check('T1.3 替换/合并并重新打开后人工状态仍有效',
      r1.ok === true && st1.readState === 'done' && st1.stateSource === 'manual' && st1.manualStateAt > 0,
      JSON.stringify({ ok: r1.ok, st: st1.readState, src: st1.stateSource }));

    // 旧滚动任务不得覆盖人工状态
    await m3.api.saveProgress('post', 'm1', 0.2);
    await m3.api.saveProgress('post', 'm2', 0.8);
    const a1 = m3.api.state('post', 'm1');
    const a2 = m3.api.state('post', 'm2');
    check('T1.4 导入后旧滚动进度不覆盖人工操作',
      a1.readState === 'done' && a1.progress === 0.2 && a2.readState === 'none' && a2.progress === 0,
      JSON.stringify({ m1: [a1.readState, a1.progress], m2: [a2.readState, a2.progress] }));

    // 兼容：v1 文件与不带这两个字段的 v2 文件
    const noFields = JSON.parse(JSON.stringify(dump));
    noFields.records.forEach(r => { delete r.stateSource; delete r.manualStateAt; });
    const v2 = api.validateImport(noFields, {});
    check('T1.5 缺省字段的 v2 文件仍可导入',
      v2.ok === true && v2.payload.records.every(r => r.stateSource === undefined),
      JSON.stringify(v2.errors));

    const v1 = api.validateImport(Object.assign({}, noFields, { schemaVersion: 1 }), {});
    check('T1.6 v1 文件仍可导入且不产生人工字段',
      v1.ok === true && v1.payload.records.every(r => r.stateSource === undefined && r.manualStateAt === undefined),
      JSON.stringify(v1.errors));

    // 非法值必须拒绝
    const badSrc = JSON.parse(JSON.stringify(dump));
    badSrc.records[0].stateSource = 'robot';
    const badAt = JSON.parse(JSON.stringify(dump));
    badAt.records[0].manualStateAt = -5;
    const r1x = api.validateImport(badSrc, {});
    const r2x = api.validateImport(badAt, {});
    check('T1.7 stateSource / manualStateAt 非法值被拒绝',
      r1x.ok === false && /stateSource/.test(r1x.errors.join()) &&
      r2x.ok === false && /manualStateAt/.test(r2x.errors.join()),
      [r1x.errors.join('|'), r2x.errors.join('|')].join(' // '));
  }

  // ============================================================ 修订：替换的并发检查（Task 2）
  {
    const { b, api } = await setup();
    await api.setFlag('post', 'c1', 'fav', true);
    await api.setFlag('post', 'c2', 'later', true);

    // 指纹必须能区分"条数相同、最大时间戳相同"的不同状态
    // （旧实现 = 条数 + 最大 updatedAt，同一毫秒写入或等量替换会碰撞）
    const rowsA = [{
      key: 'post:a', type: 'post', refId: 'a', updatedAt: 1000, fav: 1, later: 0,
      favCat: 'default', readState: 'reading', progress: 0.5, doneAt: 0, manualStateAt: 0, lastSeenAt: 1000
    }];
    const rowsB = [JSON.parse(JSON.stringify(rowsA[0]))];
    rowsB[0].favCat = 'cat-x';
    const oldStyle = function (rows) {
      let max = 0;
      rows.forEach(r => { if ((r.updatedAt || 0) > max) max = r.updatedAt || 0; });
      return rows.length + ':' + max;
    };
    const tA = api._snapshotToken({ rows: rowsA, cats: [{ id: 'default', name: '默认分类', system: true }] });
    const tB = api._snapshotToken({ rows: rowsB, cats: [{ id: 'default', name: '默认分类', system: true }] });
    const tC = api._snapshotToken({ rows: rowsA, cats: [{ id: 'default', name: '改名', system: true }] });
    check('T2.1 新指纹能识别"同条数同最大时间戳"的内容变化',
      rowsA.length === rowsB.length && oldStyle(rowsA) === oldStyle(rowsB) &&
      tA !== tB && tA !== tC,
      JSON.stringify({ old: oldStyle(rowsA), tA, tB, tC }));

    // 竞争窗口：预览拿到 token → 另一标签页写入 → 用旧 token 调后端替换
    const prev = await api.previewImport(makeExport(), { resolve: () => true });
    await api.setFlag('post', 'c3', 'fav', true);           // 模拟另一个标签页
    const direct = await b.replaceAll([], [], prev.token);
    const rowsAfter = await api.list({});
    check('T2.2 事务内的权威检查拒绝过期 token（不写任何数据）',
      direct && direct.ok === false && direct.conflict === true &&
      rowsAfter.length === 3, JSON.stringify({ direct, n: rowsAfter.length }));

    // 走 applyImport 的完整路径同样被拒
    const p2 = await api.previewImport(makeExport(), { resolve: () => true });
    await api.setFlag('post', 'c4', 'later', true);
    const stale = await api.applyImport(makeExport(), {
      mode: 'replace', confirm: true, resolve: () => true, expectToken: p2.token
    });
    const rows2 = await api.list({});
    check('T2.3 applyImport 在竞争窗口后拒绝替换且原数据不变',
      stale.ok === false && /重新预览/.test(stale.reason || '') && rows2.length === 4,
      JSON.stringify({ ok: stale.ok, n: rows2.length }));

    // token 一致时仍可替换（不做无条件重试，但正确的 token 不应被误判）
    const p3 = await api.previewImport(makeExport(), { resolve: () => true });
    const good = await api.applyImport(makeExport(), {
      mode: 'replace', confirm: true, resolve: () => true, expectToken: p3.token
    });
    check('T2.4 token 未变时替换正常完成', good.ok === true && good.replaced === true,
      JSON.stringify({ ok: good.ok, n: good.imported }));
  }

  // ============================================================ 修订：迁移可见性（Task 3）
  {
    // 场景一：v1 库 + 分类 meta 写入失败 → 必须报错、不升版本
    const b1 = makeBackend();
    await b1.setMeta('schemaVersion', 1);                  // 先造一个 v1 库
    await b1.mutate('post:x1', function () {
      return {
        key: 'post:x1', type: 'post', refId: 'x1', title: 'X1', fav: 0, favAt: 0, favCat: 'default',
        later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 1, lastSeenAt: 1,
        doneAt: 0, updatedAt: 1
      };
    });
    b1.state.failSetMetaCat = true;
    const m1b = loadModule(b1);                            // 首次 init 即触发迁移
    await m1b.api.init();
    const st1 = m1b.api.status();
    const ver1 = await b1.getMeta('schemaVersion');
    check('T3.1 迁移失败不再静默：status 报告失败且版本未升',
      st1.migration.failed === true && st1.migration.ok === false &&
      /迁移未完成/.test(st1.migration.reason) && Number(ver1) !== 2,
      JSON.stringify({ failed: st1.migration.failed, ver: ver1, reason: st1.migration.reason }));

    // 场景二：恢复正常后重新 init 能自愈
    b1.state.failSetMetaCat = false;
    const m1c = loadModule(b1);
    await m1c.api.init();
    const st2 = m1c.api.status();
    const ver2 = await b1.getMeta('schemaVersion');
    const cats2 = await m1c.api.categories();
    check('T3.2 恢复后重新初始化可安全完成迁移',
      st2.migration.ok === true && st2.migration.failed === false &&
      Number(ver2) === 2 && cats2[0].id === 'default',
      JSON.stringify({ ok: st2.migration.ok, ver: ver2 }));

    // 场景三：分类已写、记录修正失败 → 部分状态可见，重试后可修复
    const b3 = makeBackend();
    const m3 = loadModule(b3);
    await m3.api.init();
    // 直接写一条"收藏指向不存在分类"的脏记录，模拟 9A-1 遗留数据
    await b3.mutate('post:orphan', function () {
      return {
        key: 'post:orphan', type: 'post', refId: 'orphan', title: '悬空', fav: 1, favAt: 1,
        favCat: 'cat-gone', later: 0, laterAt: 0, readState: 'none', progress: 0,
        firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 1
      };
    });
    b3.state.failSetMetaCat = true;
    const m3b = loadModule(b3);
    await m3b.api.init();
    const partial = m3b.api.status();
    const orphanBefore = await b3.get('post:orphan');
    check('T3.3 中途失败时状态可见，记录保持原样（不会半修改）',
      partial.migration.failed === true && !!orphanBefore && orphanBefore.favCat === 'cat-gone',
      JSON.stringify({ failed: partial.migration.failed, cat: orphanBefore && orphanBefore.favCat }));

    b3.state.failSetMetaCat = false;
    b3.state.failMigrateMany = false;
    const m3c = loadModule(b3);
    await m3c.api.init();
    const orphanAfter = await b3.get('post:orphan');
    check('T3.4 重试后悬空分类被修回默认分类',
      orphanAfter && orphanAfter.favCat === 'default',
      JSON.stringify(orphanAfter && orphanAfter.favCat));

    // 场景四：未来版本不得被降级覆盖
    const b4 = makeBackend();
    await b4.setMeta('schemaVersion', 9);
    await b4.setMeta('favCategories', [{ id: 'default', name: '默认分类', system: true }, { id: 'cat-future', name: '未来分类', system: false }]);
    const m4 = loadModule(b4);
    await m4.api.init();
    const st4 = m4.api.status();
    const ver4 = await b4.getMeta('schemaVersion');
    const addBlocked = await m4.api.addCategory('新分类');
    const impBlocked = await m4.api.applyImport(makeExport(), { mode: 'merge', resolve: () => true });
    const cats4 = await b4.getMeta('favCategories');
    check('T3.5 未来版本不降级：版本不变、分类原样、写操作被拒',
      st4.migration.future === true && Number(ver4) === 9 &&
      cats4.length === 2 && cats4[1].id === 'cat-future' &&
      addBlocked.ok === false && impBlocked.ok === false,
      JSON.stringify({ ver: ver4, future: st4.migration.future, add: addBlocked.ok, imp: impBlocked.ok }));
  }

  // ============================================================ 修订：统一写入闸门（Task 4）
  async function assertAllWritesBlocked(label, api, getRows) {
    const before = JSON.stringify(await getRows());
    await api.recordView('post', 'gate1', { title: '闸门' });
    await api.setFlag('post', 'gate1', 'fav', true);
    await api.setFlag('post', 'gate1', 'later', true);
    await api.setReadState('post', 'gate1', 'done');
    await api.saveProgress('post', 'gate1', 0.5);
    await api.clearHistory('post:gate1');
    await api.remove('post:gate1');
    await api.bulk(['post:gate1'], 'fav-off');
    await api.addCategory('闸门分类');
    await api.assignCategory('post:gate1', 'default');
    const imp = await api.applyImport(makeExport(), { mode: 'merge', resolve: () => true });
    const after = JSON.stringify(await getRows());
    const rows = JSON.parse(after);
    check(label + ' 所有持久化写入被拒绝且数据字节级不变',
      before === after && rows.length === 2 && !rows.some(r => r.key === 'post:gate1') &&
      imp.ok === false,
      JSON.stringify({ same: before === after, n: rows.length, imp: imp.ok }));
  }

  {
    // 场景 A：未来版本（真实迁移路径置位）
    const b = makeBackend();
    await b.setMeta('schemaVersion', 9);
    await b.setMeta('favCategories', [{ id: 'default', name: '默认分类', system: true }]);
    await b.mutate('post:g1', () => ({ key: 'post:g1', type: 'post', refId: 'g1', title: '既有', fav: 1, favAt: 1, favCat: 'default', later: 0, laterAt: 0, readState: 'none', progress: 0, firstSeenAt: 1, lastSeenAt: 1, doneAt: 0, updatedAt: 1 }));
    await b.mutate('post:g2', () => ({ key: 'post:g2', type: 'post', refId: 'g2', title: '既有二', fav: 0, favAt: 0, favCat: 'default', later: 1, laterAt: 1, readState: 'none', progress: 0, firstSeenAt: 1, lastSeenAt: 1, doneAt: 0, updatedAt: 1 }));
    const m = loadModule(b);
    await m.api.init();
    const st = m.api.status();
    await assertAllWritesBlocked('T4.1 未来版本', m.api, () => b.getAll());
    check('T4.2 未来版本：状态可读、只读查询与导出仍可用',
      st.migration.future === true && (await m.api.list({})).length === 2 &&
      (await m.api.counts()).fav >= 1 &&
      (await m.api.exportData()).complete === true &&
      (await b.getMeta('schemaVersion')) === 9,
      JSON.stringify({ future: st.migration.future }));
  }

  {
    // 场景 B：迁移失败（测试注入，真实失败路径见 T3.1）
    const { b, api } = await setup();
    await api.recordView('post', 'k1', { title: 'K1' });
    await api.recordView('post', 'k2', { title: 'K2' });
    await api.setFlag('post', 'k1', 'fav', true);
    await api.setFlag('post', 'k2', 'later', true);
    api._forceMigrationBlock({ failed: true, reason: '迁移未完成：测试注入' });
    await assertAllWritesBlocked('T4.3 迁移失败', api, () => b.getAll());
    check('T4.4 迁移失败：只读与导出正常、无内存降级',
      api.status().degraded === false && (await api.list({})).length === 2 &&
      (await api.exportData()).source === 'database',
      JSON.stringify(api.status()));

    // 恢复后写入回到原行为
    api._forceMigrationBlock({});
    const ok = await api.setFlag('post', 'k1', 'later', true);
    check('T4.5 闸门解除后写入恢复正常', !!ok && ok.later === 1, JSON.stringify(ok && ok.later));
  }

  // ============================================================ 修订：自动裁剪也走闸门（Task B）
  async function seedHistory(b, n) {
    for (let i = 0; i < n; i++) {
      const key = 'post:hist' + i;
      await b.mutate(key, () => ({
        key: key, type: 'post', refId: 'hist' + i, title: 'H' + i,
        fav: 0, favAt: 0, favCat: 'default', later: 0, laterAt: 0,
        readState: 'none', progress: 0,
        firstSeenAt: 1000 + i, lastSeenAt: 1000 + i, doneAt: 0, updatedAt: 1000 + i
      }));
    }
  }

  {
    // T5.1 未来版本：不启动新的自动裁剪
    const b = makeBackend();
    await b.setMeta('schemaVersion', 9);
    await b.setMeta('favCategories', [{ id: 'default', name: '默认分类', system: true }]);
    await seedHistory(b, 520);
    const m = loadModule(b);
    await m.api.init();
    const before = JSON.stringify(await b.getAll());
    const removed = await m.api._pruneHistory(0);
    m.api._enforceHistoryLimit();
    await new Promise(r => setTimeout(r, 30));
    const after = JSON.stringify(await b.getAll());
    check('T5.1 未来版本下自动裁剪被闸门拦截（记录与 meta 均不变）',
      removed === 0 && before === after && (await b.getMeta('schemaVersion')) === 9,
      JSON.stringify({ removed, same: before === after }));
  }

  {
    // T5.2 迁移失败：同样不裁剪
    const { b, api } = await setup();
    await seedHistory(b, 520);
    api._forceMigrationBlock({ failed: true, reason: '迁移未完成：测试注入' });
    const before = JSON.stringify(await b.getAll());
    const removed = await api._pruneHistory(0);
    const after = JSON.stringify(await b.getAll());
    check('T5.2 迁移失败态下自动裁剪被拦（记录不变）',
      removed === 0 && before === after, JSON.stringify({ removed, same: before === after }));
  }

  {
    // T5.3 正常 v2：历史上限照常生效（不被闸门误伤）
    const { b, api } = await setup();
    await seedHistory(b, 520);
    const removed = await api._pruneHistory(0);
    const rows = await b.getAll();
    check('T5.3 正常 v2 下历史裁剪到 500 且不误删受保护记录',
      removed === 20 && rows.length === 500, JSON.stringify({ removed, left: rows.length }));
  }

  {
    // T5.4 已排队的裁剪：真正写入前被闸门拦下
    const { b, api } = await setup();
    await seedHistory(b, 520);
    b.state.onNextMutate = () => api._forceMigrationBlock({ failed: true, reason: '排队期间关闭' });
    const before = (await b.getAll()).length;
    const removed = await api._pruneHistory(0);
    const after = await b.getAll();
    check('T5.4 已排队的自动裁剪在写入前再次检查闸门（一条都不删）',
      removed === 0 && after.length === before && before === 520,
      JSON.stringify({ removed, before, after: after.length }));
  }

  {
    // T5.5 迁移修复不被闸门阻断：失败态下重新 init 仍能修悬空分类
    const b = makeBackend();
    await b.setMeta('schemaVersion', 1);
    await b.mutate('post:orphan2', () => ({
      key: 'post:orphan2', type: 'post', refId: 'orphan2', title: '悬空', fav: 1, favAt: 1,
      favCat: 'cat-missing', later: 0, laterAt: 0, readState: 'none', progress: 0,
      firstSeenAt: 1, lastSeenAt: 1, doneAt: 0, updatedAt: 1
    }));
    const m = loadModule(b);
    await m.api.init();
    const rec = await b.get('post:orphan2');
    check('T5.5 迁移修复本身不被写入闸门阻断',
      rec && rec.favCat === 'default' && (await b.getMeta('schemaVersion')) === 2,
      JSON.stringify({ cat: rec && rec.favCat }));
  }

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('SPEC ERROR:', e && e.stack || e);
  process.exit(1);
});
