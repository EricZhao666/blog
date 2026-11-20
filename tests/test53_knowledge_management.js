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
  const state = { failBulk: false, failReplace: false, failAll: false, failUpdaterAt: -1, writes: 0 };
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
    setMeta(k, v) { meta.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
    readAll() {
      if (state.failAll) return Promise.reject(new Error('injected readAll failure'));
      return Promise.resolve({
        rows: Array.from(map.values()).map(v => JSON.parse(JSON.stringify(v))),
        cats: meta.has('favCategories') ? JSON.parse(JSON.stringify(meta.get('favCategories'))) : null
      });
    },
    mutate(key, updater) {
      return enqueue(() => {
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
          if (state.failBulk) throw new Error('injected bulk failure');
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
    replaceAll(rows, cats) {
      return enqueue(() => {
        const s = snap();
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

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('SPEC ERROR:', e && e.stack || e);
  process.exit(1);
});
