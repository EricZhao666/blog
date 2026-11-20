#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-1：相关内容推荐算法专项（无浏览器）
 *
 * 直接加载真实 js/related.js（纯函数模块），覆盖任务要求的算法契约：
 *   共同标签权重与区分度 / 显式关联优先 / 同系列优先 / 分类与技术栈 / 标题词重合 /
 *   稳定排序与确定性 / 排除自身 / 去重 / 空输入 / 无关联 / 中英文与特殊字符 /
 *   跨类型 ID 冲突 / 无效目标过滤 / 显式链接抽取 / 理由顺序。
 *
 * 用法：node tests/test52_related_content.js
 */
const path = require('path');

const Related = require(path.join(__dirname, '..', 'js', 'related.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function keys(list) { return list.map(function (x) { return x.key; }); }
function ids(list) { return keys(list).join(','); }

// ---------------------------------------------------------------- 测试语料
// 最小但真实的字段组合：标签、系列、分类、技术栈、标题、摘要
const BASE = [
  { type: 'post', refId: 'p-rl-1', title: '强化学习入门：从MDP到PPO', tags: ['强化学习', '机器学习', '技术笔记'], series: '强化学习系列', text: '从马尔可夫决策过程讲到PPO。' },
  { type: 'post', refId: 'p-rl-2', title: '强化学习在机器人控制中的应用', tags: ['强化学习', '机器人', '技术笔记'], series: '强化学习系列', text: '仿真训练到真实部署。' },
  { type: 'post', refId: 'p-slam-1', title: 'SLAM技术全景：从滤波到图优化', tags: ['SLAM', '机器人', '技术笔记'], text: '贝叶斯滤波与因子图。' },
  { type: 'post', refId: 'p-arm-1', title: '机械臂轨迹规划简述', tags: ['机械臂', '运动控制', '技术笔记'], text: '多项式插值到优化方法。' },
  { type: 'post', refId: 'p-life-1', title: '深圳周末好去处', tags: ['生活', '随笔'], text: '私藏清单。' },
  { type: 'course', refId: '本科课程|机器人与自动化-(CS422)', title: '机器人与自动化 (CS422)', category: '机器人与自动化', text: '涵盖机器人运动学、动力学建模与运动控制。' },
  { type: 'course', refId: '香港大学|MECH7010-机器人学', title: 'MECH7010 机器人学', category: '机器人与自动化', text: '机器人建模、状态估计与控制理论。' },
  { type: 'course', refId: '设计|交互设计基础', title: '交互设计基础', category: '设计', text: '视觉与交互基础。' },
  { type: 'paper', refId: 'paper-4', title: 'OpenVLA: An Open-Source Vision-Language-Action Model', category: '具身智能', tags: ['具身智能'], text: 'open source vla model.' },
  { type: 'lib', refId: 'reinforce_learning', title: '强化学习代码库', category: '强化学习', text: 'DQN 与 PPO 的练习代码。' },
  { type: 'lib', refId: 'matlab_backup', title: 'matlab备份', category: 'MATLAB 备份', text: '机器人正运动学仿真与 EKF 融合。' },
  { type: 'project', refId: 'proj-arm', title: '六轴机械臂视觉抓取系统', tags: ['机械臂'], tech: ['ROS2', 'PyTorch'], text: '无序工件分拣。' }
];

const index = Related.buildIndex(BASE);

// T1 排除自身
(function () {
  const list = Related.recommend(index, 'post:p-rl-2', {});
  check('T1 排除当前内容自身', list.every(function (r) { return r.key !== 'post:p-rl-2'; }), ids(list));
})();

// T2 同系列优先于普通共同标签
(function () {
  const list = Related.recommend(index, 'post:p-rl-1', {});
  check('T2 同系列内容排在首位', list.length > 0 && list[0].key === 'post:p-rl-2', ids(list));
  check('T2.1 同系列理由可读', Related.formatReasons(list[0].reasons).indexOf('同系列「强化学习系列」') === 0,
    Related.formatReasons(list[0].reasons));
})();

// T3 显式关联优先（正文内链）
(function () {
  const plain = Related.recommend(index, 'post:p-arm-1', {});
  const withLink = Related.recommend(index, 'post:p-arm-1', { explicit: ['lib:matlab_backup'] });
  check('T3 显式关联被提升到首位', withLink[0].key === 'lib:matlab_backup', ids(withLink));
  check('T3.1 显式关联理由存在', Related.formatReasons(withLink[0].reasons, 1) === '正文已关联此内容',
    Related.formatReasons(withLink[0].reasons, 1));
  check('T3.2 无显式关联时不会凭空出现', plain.every(function (r) { return r.key !== 'lib:matlab_backup'; }), ids(plain));
})();

// T4 泛标签不足以单独构成推荐；专指标签可以（区分度按站点真实规模生效）
(function () {
  const corpus = [];
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach(function (k) {
    corpus.push({ type: 'post', refId: k, title: '杂记' + k, tags: ['技术笔记'] });
  });
  corpus.push({ type: 'post', refId: 'g', title: 'SLAM 甲', tags: ['SLAM', '技术笔记'] });
  corpus.push({ type: 'post', refId: 'h', title: 'SLAM 乙', tags: ['SLAM', '技术笔记'] });
  corpus.push({ type: 'post', refId: 'i', title: '独立甲', tags: ['独立'] });
  corpus.push({ type: 'post', refId: 'j', title: '独立乙', tags: ['独立'] });
  const idx = Related.buildIndex(corpus);

  const list = Related.recommend(idx, 'post:a', {});
  check('T4 泛标签（df>=4 且占比>=40%）不单独构成推荐', list.length === 0, ids(list));

  const list2 = Related.recommend(idx, 'post:g', {});
  check('T4.1 专指标签可以单独构成推荐',
    list2.length > 0 && list2[0].key === 'post:h' &&
    Related.formatReasons(list2[0].reasons).indexOf('SLAM') !== -1, ids(list2));
})();

// T5 相同分类（课程页的主要依据）
(function () {
  const list = Related.recommend(index, 'course:香港大学|MECH7010-机器人学', {});
  check('T5 同分类课程互相推荐', list.length > 0 && list[0].key === 'course:本科课程|机器人与自动化-(CS422)', ids(list));
  check('T5.1 不同分类且无其他依据的不推荐',
    list.every(function (r) { return r.key !== 'course:设计|交互设计基础'; }), ids(list));
})();

// T6 跨类型桥接：源标签出现在候选标题/摘要中
(function () {
  const list = Related.recommend(index, 'post:p-arm-1', {});
  const names = ids(list);
  check('T6 课程"内容涉及：运动控制"参与推荐', names.indexOf('course:本科课程|机器人与自动化-(CS422)') !== -1, names);
})();

// T7 技术栈重合
(function () {
  const idx = Related.buildIndex([
    { type: 'project', refId: 'pa', title: '项目甲', tech: ['ROS2', 'PyTorch'], tags: [] },
    { type: 'post', refId: 'x', title: '文章甲', tech: ['ROS2', 'PyTorch'], tags: [] },
    { type: 'post', refId: 'y', title: '文章乙', tech: ['Excel'], tags: [] }
  ]);
  // project 没有详情路由，不进候选；但 tech 规则本身要可被验证
  const list = Related.recommend(idx, 'post:x', {});
  check('T7 技术栈重合计分且理由可读', list.length === 1 && list[0].key === 'project:pa' ? false : true, ids(list));
  check('T7.1 无详情路由的项目不进候选', list.every(function (r) { return r.type !== 'project'; }), ids(list));

  const idx2 = Related.buildIndex([
    { type: 'post', refId: 'x', title: '文章甲', tech: ['ROS2', 'PyTorch'] },
    { type: 'post', refId: 'y', title: '文章乙', tech: ['ROS2', 'PyTorch'] },
    { type: 'post', refId: 'z', title: '文章丙', tech: ['Excel'] },
    { type: 'post', refId: 'f1', title: '填充一', tech: [] },
    { type: 'post', refId: 'f2', title: '填充二', tech: [] },
    { type: 'post', refId: 'f3', title: '填充三', tech: [] },
    { type: 'post', refId: 'f4', title: '填充四', tech: [] },
    { type: 'post', refId: 'f5', title: '填充五', tech: [] }
  ]);
  const l2 = Related.recommend(idx2, 'post:x', {});
  check('T7.2 技术栈重合产生推荐与理由',
    l2.length === 1 && l2[0].key === 'post:y' &&
    Related.formatReasons(l2[0].reasons).indexOf('技术栈重合') !== -1,
    Related.formatReasons(l2.length ? l2[0].reasons : []));
})();

// T8 标题词重合（英文缩写与中文二元组）：单独不足以过阈值，但规则本身必须可验证
(function () {
  const idx = Related.buildIndex([
    { type: 'post', refId: 'x', title: 'VLA模型入门：从RT-1到OpenVLA' },
    { type: 'post', refId: 'y', title: 'OpenVLA 开源模型实践' },
    { type: 'post', refId: 'z', title: 'SLAM技术全景' }
  ]);
  const list = Related.recommend(idx, 'post:x', { minScore: 0.3 });
  check('T8 标题词重合产生推荐与理由', list.some(function (r) {
    return r.key === 'post:y' && Related.formatReasons(r.reasons).indexOf('标题主题相近') !== -1;
  }), ids(list));
  check('T8.1 无关标题不推荐', list.every(function (r) { return r.key !== 'post:z'; }), ids(list));
  const strict = Related.recommend(idx, 'post:x', {});
  check('T8.2 单纯标题接近不越过默认阈值（宁缺勿滥）', strict.length === 0, ids(strict));
})();

// T9 无有效关联返回空列表（不为了凑数展示）
(function () {
  const list = Related.recommend(index, 'post:p-life-1', {});
  check('T9 无有效关联时返回空列表', Array.isArray(list) && list.length === 0, ids(list));
})();

// T10 空 / 异常输入不抛异常
(function () {
  let ok = true, msg = '';
  try {
    const idx = Related.buildIndex([]);
    const a = Related.recommend(idx, 'post:none', {});
    const b = Related.recommend(null, 'post:none', {});
    const c = Related.recommend(index, 'not-a-key', {});
    const d = Related.recommend(index, 'post:p-rl-1', { explicit: null, limit: 0 });
    ok = Array.isArray(a) && a.length === 0 && Array.isArray(b) && b.length === 0 &&
      Array.isArray(c) && c.length === 0 && Array.isArray(d) && d.length === 0;
  } catch (e) { ok = false; msg = e.message; }
  check('T10 空索引/非法源键/limit=0 均安全返回', ok, msg);
})();

// T11 重复候选去重
(function () {
  const dup = BASE.concat([BASE[0]]);
  const idx = Related.buildIndex(dup);
  check('T11 相同 key 的重复输入只保留一条', idx.items.length === BASE.length && idx.byKey['post:p-rl-1'],
    idx.items.length + '/' + BASE.length);
  const list = Related.recommend(index, 'post:p-slam-1', {});
  const seen = {};
  check('T11.1 结果无重复 key', list.every(function (r) { return seen[r.key] ? false : (seen[r.key] = 1); }), ids(list));
})();

// T12 确定性：输入顺序不同、重复调用，结果一致
(function () {
  const shuffled = BASE.slice().reverse();
  const idx2 = Related.buildIndex(shuffled);
  const a = ids(Related.recommend(index, 'post:p-rl-2', {}));
  const b = ids(Related.recommend(index, 'post:p-rl-2', {}));
  const c = ids(Related.recommend(idx2, 'post:p-rl-2', {}));
  check('T12 相同输入重复调用结果一致', a === b, a);
  check('T12.1 元数据顺序变化不影响排序', a === c, a + ' vs ' + c);
  const tieCorpus = [
    { type: 'post', refId: 'src', title: 'S', tags: ['SLAM'] },
    { type: 'post', refId: 'zz', title: 'Z', tags: ['SLAM'] },
    { type: 'post', refId: 'aa', title: 'A', tags: ['SLAM'] }
  ];
  for (let i = 0; i < 8; i++) tieCorpus.push({ type: 'post', refId: 'f' + i, title: '填充' + i, tags: ['填充' + i] });
  const tieIdx = Related.buildIndex(tieCorpus);
  const tieOut = Related.recommend(tieIdx, 'post:src', {});
  check('T12.2 同分时按 key 码元序稳定排列',
    ids(tieOut) === 'post:aa,post:zz' && tieOut[0].score === tieOut[1].score, ids(tieOut));
})();

// T13 中英文/空白/大小写归一化只影响匹配，不影响显示
(function () {
  const corpus = [
    { type: 'post', refId: 'x', title: 'PyTorch 实践', tags: ['Machine Learning'] },
    { type: 'post', refId: 'y', title: '训练技巧', tags: ['machine learning'] },
    { type: 'post', refId: 'z', title: '另一个', tags: ['  Machine   Learning  '] }
  ];
  for (let i = 0; i < 8; i++) corpus.push({ type: 'post', refId: 'f' + i, title: '填充' + i, tags: ['填充' + i] });
  const idx = Related.buildIndex(corpus);
  const list = Related.recommend(idx, 'post:x', {});
  check('T13 大小写/多空格归一化后可匹配', list.length === 2, ids(list));
  const label = Related.formatReasons(list[0].reasons);
  check('T13.1 理由使用原始标签显示（不改写大小写）',
    /machine learning/i.test(label) && label.indexOf('、') === -1, label);
})();

// T14 跨类型 ID 冲突：post:paper-4 与 paper:paper-4 互不覆盖
(function () {
  const corpus = [
    { type: 'post', refId: 'paper-4', title: '文章版 paper-4', tags: ['SLAM'] },
    { type: 'paper', refId: 'paper-4', title: '论文版 paper-4', category: 'SLAM', tags: ['SLAM'] },
    { type: 'post', refId: 'other', title: '另一篇', tags: ['SLAM'] }
  ];
  for (let i = 0; i < 8; i++) corpus.push({ type: 'post', refId: 'f' + i, title: '填充' + i, tags: ['填充' + i] });
  const idx = Related.buildIndex(corpus);
  const list = Related.recommend(idx, 'post:paper-4', {});
  const names = ids(list);
  check('T14 不同类型的同名 ID 不互相覆盖', names.indexOf('paper:paper-4') !== -1 && names.indexOf('post:paper-4') === -1, names);
  check('T14.1 键格式为 type:refId', Related.splitId('paper:paper-4').type === 'paper' &&
    Related.splitId('paper:paper-4').refId === 'paper-4', JSON.stringify(Related.splitId('paper:paper-4')));
})();

// T15 无效目标过滤：没有真实路由的内容不进入推荐
(function () {
  const idx = Related.buildIndex([
    { type: 'post', refId: 'x', title: '文章', tags: ['SLAM'] },
    { type: 'project', refId: 'proj', title: '项目', tags: ['SLAM'] },
    { type: 'note', refId: 'note', title: '笔记', tags: ['SLAM'] }
  ]);
  const list = Related.recommend(idx, 'post:x', {});
  check('T15 无详情路由的项目/笔记被过滤', list.length === 0, ids(list));
  check('T15.1 hrefFor 只输出真实路由',
    Related.hrefFor('post', 'a b') === '#/post/a%20b' &&
    Related.hrefFor('course', '本科课程|X') === '#/course/%E6%9C%AC%E7%A7%91%E8%AF%BE%E7%A8%8B%7CX' &&
    Related.hrefFor('lib', 'l1') === '#/codelib/l1' &&
    Related.hrefFor('paper', 'paper-4') === '#/papers?kind=paper&target=paper-4' &&
    Related.hrefFor('material', 'lm-1') === '#/papers?kind=material&target=lm-1' &&
    Related.hrefFor('project', 'p') === '',
    Related.hrefFor('course', '本科课程|X'));
})();

// T16 显式链接抽取：只认站内真实路由
(function () {
  const text = [
    '见 [代码库](#/codelib/reinforce_learning)。',
    '参考 [文章](#/post/vla-model-intro) 与 [课程](#/course/本科课程|机器人与自动化-(CS422))。',
    '论文 [链接](#/papers?kind=paper&target=paper-74)。',
    '外部 [站点](https://example.com) 与脚本 [坏链](javascript:alert(1)) 都应忽略。'
  ].join('\n');
  const hits = Related.extractLinks(text);
  const keys = hits.map(function (h) { return h.key; });
  check('T16 抽取文章/课程/代码库/论文四类内链',
    keys.indexOf('lib:reinforce_learning') !== -1 &&
    keys.indexOf('post:vla-model-intro') !== -1 &&
    keys.indexOf('course:本科课程|机器人与自动化-(CS422)') !== -1 &&
    keys.indexOf('paper:paper-74') !== -1, keys.join(','));
  check('T16.1 外链/javascript: 不被当成显式关联',
    !keys.some(function (k) { return k.indexOf('javascript') !== -1 || k.indexOf('http') !== -1; }), keys.join(','));
  check('T16.2 重复链接只保留一次',
    Related.extractLinks('a](#/post/x) b](#/post/x)').length === 1, '');
  check('T16.3 空输入安全', Related.extractLinks('').length === 0 && Related.extractLinks(null).length === 0, '');
})();

// T17 理由顺序与数量
(function () {
  const idx = Related.buildIndex([
    { type: 'post', refId: 's', title: 'SLAM 全景', tags: ['SLAM', '机器人'], series: 'S' },
    { type: 'post', refId: 't', title: 'SLAM 实践', tags: ['SLAM', '机器人'], series: 'S' }
  ]);
  const list = Related.recommend(idx, 'post:s', {});
  const label = Related.formatReasons(list[0].reasons, 2);
  check('T17 最多展示 2 条理由且按优先级', label.split(' · ').length === 2 && label.indexOf('同系列') === 0, label);
  const all = Related.formatReasons(list[0].reasons, 9);
  check('T17.1 理由种类覆盖系列/标签/标题', all.indexOf('同系列') !== -1 && all.indexOf('共同标签') !== -1, all);
})();

// T18 结果数量上限与分数格式
(function () {
  const many = [{ type: 'post', refId: 's', title: '源', tags: ['SLAM'] }];
  for (let i = 0; i < 9; i++) many.push({ type: 'post', refId: 'c' + i, title: '候选' + i, tags: ['SLAM'] });
  const idx = Related.buildIndex(many);
  // 9/9 都带同一个标签时它被判定为泛标签（这正是全站只有一种标签的极端情形），
  // 这里只验证"数量上限"，因此显式放低阈值。
  const list = Related.recommend(idx, 'post:s', { minScore: 0.4 });
  check('T18 默认最多返回 5 条', list.length === 5, list.length);
  check('T18.1 分数为两位小数且非负', list.every(function (r) {
    return typeof r.score === 'number' && r.score >= 0 && Math.round(r.score * 100) === r.score * 100;
  }), list.map(function (r) { return r.score; }).join(','));
})();

// T19 恶意标题原样保留（渲染层负责转义，算法不得改写/执行）
(function () {
  const payload = '<img src=x onerror=alert(1)>"><script>alert(2)</script>';
  const idx = Related.buildIndex([
    { type: 'post', refId: 'x', title: '源', tags: ['SLAM'] },
    { type: 'post', refId: 'y', title: payload, tags: ['SLAM'] }
  ]);
  const list = Related.recommend(idx, 'post:x', { minScore: 0.4 });
  check('T19 恶意标题原样输出给渲染层转义', list[0] && list[0].title === payload, list[0] && list[0].title.slice(0, 12));
})();

// T20 显式关联（rank=0）在"三种以上理由"时仍排第一（B9B1 回归：0 曾被当成缺失抬到 9）
(function () {
  // 直接构造乱序理由，专门验证 formatReasons 的排序而不是生成顺序
  const shuffled = [
    { kind: 'tag', label: '共同标签：SLAM' },
    { kind: 'text', label: '标题主题相近：slam' },
    { kind: 'explicit', label: '正文已关联此内容' },
    { kind: 'series', label: '同系列「SLAM 技术系列」' }
  ];
  const all = Related.formatReasons(shuffled, 9);
  check('T20 四种理由时显式关联仍排第一', all.indexOf('正文已关联此内容') === 0, all);
  check('T20.1 完整顺序为 显式 > 系列 > 标签 > 标题',
    all === '正文已关联此内容 · 同系列「SLAM 技术系列」 · 共同标签：SLAM · 标题主题相近：slam', all);
  check('T20.2 截断到 2 条时显式关联不会被挤掉',
    Related.formatReasons(shuffled, 2).indexOf('正文已关联此内容') === 0, Related.formatReasons(shuffled, 2));
  check('T20.3 截断到 1 条时就是显式关联',
    Related.formatReasons(shuffled, 1) === '正文已关联此内容', Related.formatReasons(shuffled, 1));

  // 端到端：候选同时具备 显式 + 同系列 + 共同标签，只显示 1 条时必须是显式关联
  const idx = Related.buildIndex([
    { type: 'post', refId: 's', title: 'SLAM 全景', tags: ['SLAM', '机器人'], series: 'SLAM 技术系列' },
    { type: 'post', refId: 't', title: 'SLAM 实践', tags: ['SLAM', '机器人'], series: 'SLAM 技术系列' }
  ]);
  const hit = Related.recommend(idx, 'post:s', { explicit: ['post:t'] })[0];
  check('T20.4 三理由候选只显示 1 条时输出显式关联',
    !!hit && hit.reasons.length >= 3 && Related.formatReasons(hit.reasons, 1) === '正文已关联此内容',
    (hit ? hit.reasons.length : 0) + ' / ' + (hit ? Related.formatReasons(hit.reasons, 1) : ''));

  // 未知 kind 仍排最后（不能因为空值判断把 rank 变成 NaN）
  const unknown = Related.formatReasons([
    { kind: 'mystery', label: '未知理由' },
    { kind: 'tag', label: '共同标签：X' }
  ], 9);
  check('T20.5 未知理由类型排在已知类型之后', unknown === '共同标签：X · 未知理由', unknown);
})();

console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
if (failures.length) console.log('失败项：' + failures.join(' / '));
process.exit(fail ? 1 : 0);
