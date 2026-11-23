#!/usr/bin/env node
'use strict';
/**
 * Batch 9E：学习统计口径专项（无浏览器）
 *
 * 直接 require 真实 js/learning-stats.js，覆盖：
 *   空记录 / 去重 / 已浏览判定 / 收藏与待读重叠 / 人工已读与未读 /
 *   进度与完成率边界 / 项目无进度 / 已删除内容 / 未知元数据 / 多方向 /
 *   分类新建删除重命名 / 500 与 2000 记录规模 / 输入不可变 / 不支持项清单。
 *
 * 用法：node tests/test54_learning_stats.js
 */
const path = require('path');
const LS = require(path.resolve(__dirname, '..', 'js', 'learning-stats.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const NOW = 1764000000000;   // 固定时间，避免用例依赖真实时钟
const DAY = 86400000;

function rec(type, refId, over) {
  return Object.assign({
    key: type + ':' + refId, type: type, refId: refId, title: '',
    fav: 0, favAt: 0, favCat: 'default', later: 0, laterAt: 0,
    readState: 'none', progress: 0,
    firstSeenAt: 0, lastSeenAt: 0, doneAt: 0, updatedAt: 0
  }, over || {});
}

function post(id, over) { return rec('post', id, over); }
function project(id, over) { return rec('project', id, over); }

const CATS = [
  { id: 'default', name: '默认分类', system: true },
  { id: 'cat-a', name: '论文', system: false }
];

// 内容元数据：content[type][refId]
function content(extra) {
  const base = {
    post: {
      p1: { title: '文章一', tags: ['机器人', '技术笔记'] },
      p2: { title: '文章二', tags: ['深度学习'] },
      p3: { title: '文章三', tags: ['随笔', '生活'] },
      p4: { title: '文章四', tags: ['AI', 'Python'] }
    },
    project: {
      pr1: { title: '抓取项目', tags: ['机械臂'], tech: ['ROS2', 'PyTorch'] }
    },
    course: {
      c1: { title: '机器人与自动化', category: '机器人与自动化' }
    },
    paper: {
      pp1: { title: '双足论文', category: '双足机器人', collections: ['已读'] }
    },
    lib: {
      l1: { title: 'MATLAB 备份', category: 'MATLAB 备份' }
    }
  };
  if (!extra) return base;
  Object.keys(extra).forEach(function (k) {
    if (extra[k] === null) delete base[k];
    else base[k] = extra[k];
  });
  return base;
}

function run(records, opts) {
  return LS.summarize(Object.assign({
    records: records, categories: CATS, content: content(), now: NOW
  }, opts || {}));
}

// ---------------------------------------------------------------- K1 空记录
(function () {
  const s = run([]);
  check('K1.1 空记录：全部计数为 0',
    s.totals.records === 0 && s.totals.viewed === 0 && s.totals.fav === 0 &&
    s.totals.later === 0 && s.totals.reading === 0 && s.totals.done === 0,
    JSON.stringify(s.totals));
  check('K1.2 空记录：类型与最近浏览为空数组',
    Array.isArray(s.types) && s.types.length === 0 && s.recent.length === 0 && s.recentTotal === 0);
  check('K1.3 空记录：完成率为 0 而不是 NaN',
    s.completion.rate === 0 && s.completion.viewed === 0 && s.completion.remaining === 0,
    String(s.completion.rate));
  check('K1.4 空记录：分类仍然列出但计数为 0',
    s.favCategories.length === 2 && s.favCategories.every(function (c) { return c.count === 0; }));
  check('K1.5 空记录：方向计数全 0 且合计 0',
    s.directions.length === 5 && s.directionTotals.assignments === 0 && s.directionTotals.uniqueContent === 0);
  check('K1.6 输出带稳定版本号与生成时间',
    s.version === 1 && s.generatedAt === NOW, s.version + '/' + s.generatedAt);
})();

// ---------------------------------------------------------------- K2 去重
(function () {
  const s = run([
    post('p1', { lastSeenAt: NOW - 1000, updatedAt: 10, title: '旧标题' }),
    post('p1', { lastSeenAt: NOW - 1000, updatedAt: 20, title: '新标题' }),
    rec('project', 'p1', { lastSeenAt: NOW - 500 })
  ]);
  check('K2.1 同一 type:refId 只算一条，重复被记录',
    s.totals.records === 2 && s.totals.rawRecords === 3 && s.totals.duplicates === 1,
    JSON.stringify(s.totals));
  check('K2.2 重复键保留 updatedAt 较新的记录', s.recent[1].title === '新标题' || s.recent[0].title === '新标题',
    s.recent.map(function (r) { return r.title; }).join(','));
  check('K2.3 不同 type 的相同 refId 不去重',
    s.types.length === 2 && s.totals.viewed === 2);
})();

// ---------------------------------------------------------------- K3 已浏览判定
(function () {
  const s = run([
    post('p1', { lastSeenAt: NOW - 1000 }),
    post('p2', { lastSeenAt: 0, fav: 1, favAt: NOW - 2000 }),
    post('p3', { lastSeenAt: 0 })
  ]);
  check('K3.1 已浏览按 lastSeenAt > 0 判断', s.totals.viewed === 1, s.totals.viewed);
  check('K3.2 只有收藏没有浏览 → 计入 silent 而不是已浏览',
    s.totals.silent === 1 && s.types.find(function (t) { return t.type === 'post'; }).viewed === 1,
    JSON.stringify(s.totals));
  check('K3.3 清理过历史的记录不进入最近浏览', s.recent.length === 1 && s.recent[0].refId === 'p1');
})();

// ---------------------------------------------------------------- K4 收藏与待读重叠
(function () {
  const s = run([
    post('p1', { fav: 1, later: 1 }),
    post('p2', { fav: 1 })
  ]);
  check('K4.1 收藏与待读分别计数', s.totals.fav === 2 && s.totals.later === 1);
  check('K4.2 重叠数量单独给出（不能相加当唯一内容数）', s.totals.favLater === 1 && s.totals.records === 2,
    s.totals.fav + '+' + s.totals.later + ' overlap=' + s.totals.favLater);
  check('K4.3 收藏合计与收藏分类合计一致', s.favTotal === s.totals.fav);
})();

// ---------------------------------------------------------------- K5 人工已读 / 未读
(function () {
  const s = run([
    post('p1', { readState: 'done', stateSource: 'manual', doneAt: NOW - 100, lastSeenAt: NOW - 100, progress: 0 }),
    post('p2', { readState: 'none', stateSource: 'manual', progress: 0, lastSeenAt: NOW - 200 }),
    post('p3', { readState: 'done', lastSeenAt: NOW - 300, progress: 0.98 })
  ]);
  check('K5.1 readState=done 计为已完成（人工标记不伪造 progress）',
    s.totals.done === 2 && s.completion.doneManual === 1 && s.completion.doneAuto === 1,
    JSON.stringify(s.completion));
  check('K5.2 标记未读不计为完成也不计为阅读中',
    s.totals.reading === 0 && s.completion.done === 2);
  check('K5.3 完成率 = 已完成文章 / 已浏览文章',
    s.completion.viewed === 3 && s.completion.done === 2 && s.completion.rate === 0.667,
    s.completion.done + '/' + s.completion.viewed + '=' + s.completion.rate);
})();

// ---------------------------------------------------------------- K6 进度与完成率边界
(function () {
  const s = run([
    post('p1', { readState: 'reading', progress: 0.99, lastSeenAt: NOW - 100 }),
    post('p2', { readState: 'done', progress: 1, lastSeenAt: NOW - 200 }),
    post('p3', { readState: 'none', progress: 0, lastSeenAt: NOW - 300 }),
    post('p4', { readState: 'reading', progress: 0.5, lastSeenAt: 0 })
  ]);
  check('K6.1 progress=0.99 但状态是阅读中 → 不算完成',
    s.completion.done === 1, String(s.completion.done));
  check('K6.2 未浏览但有进度的文章不进分母，只做口径提示',
    s.completion.viewed === 3 && s.completion.progressOnly === 1, JSON.stringify(s.completion));
  check('K6.3 完成率保留三位小数', s.completion.rate === 0.333, String(s.completion.rate));
  check('K6.4 进度被限制在 0–1 之间', s.recent.every(function (r) { return r.progress >= 0 && r.progress <= 1; }));
})();

// ---------------------------------------------------------------- K7 项目无可靠进度
(function () {
  const s = run([
    project('pr1', { readState: 'done', lastSeenAt: NOW - 100 }),
    post('p1', { lastSeenAt: NOW - 200 })
  ]);
  check('K7.1 项目已完成不进入文章完成率', s.completion.done === 0 && s.completion.rate === 0,
    JSON.stringify(s.completion));
  check('K7.2 无进度类型被显式列为排除项',
    s.completion.excludedTypes.length === 1 && s.completion.excludedTypes[0].type === 'project',
    JSON.stringify(s.completion.excludedTypes));
  check('K7.3 非文章内容的已读数单独给出', s.completion.markedDoneOther === 1);
})();

// ---------------------------------------------------------------- K8 已删除内容
(function () {
  const s = run([post('gone', { lastSeenAt: NOW - 100, fav: 1, title: '已删除的合成文章' })]);
  check('K8.1 元数据已加载但找不到 → 记为失效内容', s.quality.missing === 1 && s.quality.unknownMeta === 0,
    JSON.stringify(s.quality));
  check('K8.2 失效记录仍可用记录内标题展示', s.recent[0].title === '已删除的合成文章' && s.recent[0].metaState === 'missing');
  check('K8.3 失效内容不会被强行归入某个方向', s.directionTotals.unattributed === 1);
})();

// ---------------------------------------------------------------- K9 未知元数据
(function () {
  const s = run([rec('note', 'n1', { lastSeenAt: NOW - 100, title: '一条笔记' })]);
  check('K9.1 元数据未加载 → 记 unknown 而不是 missing',
    s.quality.unknownMeta === 1 && s.quality.missing === 0, JSON.stringify(s.quality));
  check('K9.2 元数据未知时归入未分类', s.directionTotals.unattributed === 1);
  check('K9.3 类型分布仍然可用', s.types.length === 1 && s.types[0].type === 'note' && s.types[0].count === 1);
})();

// ---------------------------------------------------------------- K10 多方向
(function () {
  const s = run([post('p4', { lastSeenAt: NOW - 100 })]);
  check('K10.1 一条内容可以命中多个方向',
    s.directionTotals.assignments === 2 && s.directionTotals.uniqueContent === 1,
    JSON.stringify(s.directionTotals));
  check('K10.2 多方向计数被单独统计', s.directionTotals.multiDirection === 1);
  check('K10.3 方向计数之和允许大于唯一内容数',
    s.directions.reduce(function (a, d) { return a + d.count; }, 0) === 2);
})();

// ---------------------------------------------------------------- K11 分类新建 / 删除 / 重命名
(function () {
  const before = run([post('p1', { fav: 1, favCat: 'cat-a' })]);
  check('K11.1 收藏分类按 id 归集',
    before.favCategories.find(function (c) { return c.id === 'cat-a'; }).count === 1);

  const renamed = run([post('p1', { fav: 1, favCat: 'cat-a' })], {
    categories: [{ id: 'default', name: '默认分类', system: true }, { id: 'cat-a', name: '改名后的分类', system: false }]
  });
  check('K11.2 分类重命名后同一收藏跟随新名称',
    renamed.favCategories.find(function (c) { return c.id === 'cat-a'; }).name === '改名后的分类' &&
    renamed.favCategories.find(function (c) { return c.id === 'cat-a'; }).count === 1);

  const removed = run([post('p1', { fav: 1, favCat: 'cat-gone' })]);
  check('K11.3 分类被删除后归入未知分类',
    removed.unknownFavCategory === 1 &&
    removed.favCategories.some(function (c) { return c.unknown && c.count === 1; }),
    JSON.stringify(removed.favCategories));

  const added = run([post('p1', { fav: 1 }), post('p2', { fav: 1, favCat: 'cat-new' })], {
    categories: CATS.concat([{ id: 'cat-new', name: '新建分类', system: false }])
  });
  check('K11.4 新建分类立即出现在分布里（含 0 的也列出）',
    added.favCategories.length === 3 &&
    added.favCategories.find(function (c) { return c.id === 'cat-new'; }).count === 1);
  check('K11.5 分类按计数降序、同分保持定义顺序',
    added.favCategories[0].count >= added.favCategories[1].count);
})();

// ---------------------------------------------------------------- K12 最近浏览与窗口
(function () {
  const records = [
    post('p1', { lastSeenAt: NOW - 10 * DAY }),
    post('p2', { lastSeenAt: NOW - 2 * DAY }),
    post('p3', { lastSeenAt: NOW - 40 * DAY }),
    post('p4', { lastSeenAt: NOW - 1 * DAY })
  ];
  const s = run(records, { recentLimit: 2 });
  check('K12.1 最近浏览按时间倒序并遵守上限',
    s.recent.length === 2 && s.recent[0].refId === 'p4' && s.recent[1].refId === 'p2' && s.recentTotal === 4,
    s.recent.map(function (r) { return r.refId; }).join(','));
  check('K12.2 最近方向只统计窗口内的浏览',
    s.recentDirections.windowDays === 30 && s.recentDirections.uniqueContent === 3,
    JSON.stringify({ unique: s.recentDirections.uniqueContent, days: s.recentDirections.windowDays }));
  check('K12.3 窗口起点随 now 计算', s.recentDirections.since === NOW - 30 * DAY);
  const s2 = run(records, { recentWindowDays: 60 });
  check('K12.4 窗口可配置', s2.recentDirections.uniqueContent === 4 && s2.recentDirections.windowDays === 60);
  const s3 = run([post('p3', { lastSeenAt: NOW - 40 * DAY })]);
  check('K12.5 窗口外内容不产生最近方向',
    s3.recentDirections.uniqueContent === 0 && s3.recentDirections.assignments === 0);
})();

// ---------------------------------------------------------------- K13 规模化
(function () {
  const records = [];
  for (let i = 0; i < 2000; i++) {
    records.push(post('bulk-' + i, {
      lastSeenAt: NOW - i * 1000,
      fav: i % 3 === 0 ? 1 : 0,
      later: i % 5 === 0 ? 1 : 0,
      readState: i % 7 === 0 ? 'done' : (i % 11 === 0 ? 'reading' : 'none'),
      progress: i % 7 === 0 ? 0.5 : 0
    }));
  }
  const t0 = Date.now();
  const s = run(records);
  const ms = Date.now() - t0;
  check('K13.1 2000 条记录全部计入', s.totals.records === 2000, String(s.totals.records));
  check('K13.2 2000 条记录聚合计时 < 500ms', ms < 500, ms + 'ms');
  check('K13.3 2000 条记录的类型分布与收藏合计自洽',
    s.types[0].count === 2000 && s.favTotal === s.totals.fav, s.types[0].count + '/' + s.favTotal);

  const small = records.slice(0, 500);
  const s500 = run(small);
  check('K13.4 500 条记录结果自洽',
    s500.totals.records === 500 && s500.completion.viewed === 500);
})();

// ---------------------------------------------------------------- K14 输入不可变
(function () {
  const records = [
    post('p1', { lastSeenAt: NOW - 100, fav: 1, favCat: 'cat-a', progress: 0.4, readState: 'reading' }),
    rec('note', 'n1', { lastSeenAt: NOW - 200 })
  ];
  const categories = [{ id: 'default', name: '默认分类', system: true }];
  const contentMap = content();
  const snap = JSON.stringify({ records: records, categories: categories, content: contentMap });
  LS.summarize({ records: records, categories: categories, content: contentMap, now: NOW });
  check('K14.1 聚合过程不修改输入数据', JSON.stringify({ records: records, categories: categories, content: contentMap }) === snap);
  check('K14.2 返回的是新对象（不与输入共享引用）',
    (function () {
      const s = LS.summarize({ records: records, categories: categories, content: contentMap, now: NOW });
      return s.recent !== records && s.types !== records;
    })());
})();

// ---------------------------------------------------------------- K15 方向规则
(function () {
  check('K15.1 AI 不会命中 Training（ASCII 词边界）',
    LS.hasKeyword('Training pipeline', 'AI') === false && LS.hasKeyword('AI', 'AI') === true);
  check('K15.2 分类名里的 Python 命中 software',
    LS.classify(['Python 代码']).indexOf('software') !== -1);
  check('K15.3 C++ 命中 software', LS.classify(['C++']).indexOf('software') !== -1);
  check('K15.4 学习资料不会被当成机器学习', LS.classify(['学习资料']).indexOf('ai') === -1);
  check('K15.5 机器人与自动化命中 robotics', LS.classify(['机器人与自动化']).indexOf('robotics') !== -1);
  check('K15.6 通用标签不强行归类', LS.classify(['技术笔记', '随笔', '生活']).length === 0);
  check('K15.7 规则只看元数据，不接受标题字段', LS.classify([]).length === 0);
  check('K15.8 空值与非法值安全', LS.classify(null).length === 0 && LS.hasKeyword(null, 'AI') === false);
})();

// ---------------------------------------------------------------- K16 不支持的统计项
(function () {
  const s = run([]);
  const keys = s.unsupported.map(function (u) { return u.key; });
  check('K16.1 明确声明不提供访问次数/时长/连续天数',
    keys.indexOf('visits') !== -1 && keys.indexOf('timeSpent') !== -1 &&
    keys.indexOf('streak') !== -1 && keys.indexOf('dailyMinutes') !== -1,
    keys.join(','));
  check('K16.2 每项都带原因', s.unsupported.every(function (u) { return !!u.reason; }));
  check('K16.3 输出里没有任何"次数/时长"类字段',
    !('visits' in s.totals) && !('timeSpent' in s.totals) && !('streak' in s.totals));
})();

// ---------------------------------------------------------------- K17 健壮性
(function () {
  check('K17.1 无参数调用不抛错', (function () {
    try { const s = LS.summarize(); return s.totals.records === 0; } catch (e) { return false; }
  })());
  check('K17.2 非法记录（缺 type/refId）被忽略', (function () {
    const s = LS.summarize({ records: [{ type: 'post' }, null, 3, { refId: 'x' }], categories: [], content: null, now: NOW });
    return s.totals.records === 0;
  })());
  check('K17.3 build 与 summarize 等价', LS.build === LS.summarize);
  check('K17.4 暴露的方向定义与规则可读',
    LS.DIRECTIONS.length === 5 && LS.DIRECTIONS[4].key === 'unknown' && !!LS.RULES.robotics);
})();

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);
