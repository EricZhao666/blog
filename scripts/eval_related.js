#!/usr/bin/env node
/**
 * Batch 9B-1：推荐质量评估样本生成器
 *
 * 直接读取站点真实数据（js/data.js、js/courses.js、js/papers.js、js/codefiles.js
 * 与 data/posts/*.md），用 js/related.js 的同一套算法产出 BATCH9B1_RECOMMENDATION_EVAL.csv。
 *
 * 说明：本脚本只做"规则一致性 + 定性"评估，不产出准确率/NDCG 等需要人工标注的指标。
 *
 * Batch 9D：加 `--projects` 时额外把 6 个项目纳入候选与源，
 * 输出到 BATCH9D_PROJECT_RECOMMENDATION_EVAL.csv（多一列 cand_example）。
 * 不带参数时行为与 9B-1 完全一致，**不会覆盖历史基线**。
 *
 * 用法：
 *   node scripts/eval_related.js                     # 9B-1 基线（默认输出 BATCH9B1_...csv）
 *   node scripts/eval_related.js --projects          # 9D：含项目样本
 *   node scripts/eval_related.js [输出路径] [--projects]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const WITH_PROJECTS = process.argv.indexOf('--projects') !== -1;
const ARGS = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0);
const OUT = ARGS[0] || path.join(ROOT, WITH_PROJECTS
  ? 'BATCH9D_PROJECT_RECOMMENDATION_EVAL.csv'
  : 'BATCH9B1_RECOMMENDATION_EVAL.csv');

// 与浏览器端一致：在隔离作用域里求值数据文件（这些文件是 `const X = [...]` 形式）
function loadData(rel, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const fn = new Function(src + '\nreturn {' + names.join(',') + '};');
  return fn();
}

const Related = require(path.join(ROOT, 'js', 'related.js'));

function readPostBody(id) {
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'posts', id + '.md'), 'utf8');
  } catch (e) {
    return '';
  }
}

// Playwright/浏览器外的最简路由校验：只允许站点已知的 hash 路由
const ROUTE_OK = [
  /^#\/post\/[^?#]+$/,
  /^#\/course\/[^?#]+$/,
  /^#\/codelib\/[^?#]+$/,
  /^#\/papers\?kind=(paper|material)&target=[^?#]+$/,
  /^#\/project\/[^?#]+$/
];

function hrefValid(href) {
  return !!href && ROUTE_OK.some((re) => re.test(href));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ------------------------------------------------------------------ 数据装配

const { POSTS } = loadData('js/data.js', ['POSTS']);
const { COURSES } = loadData('js/courses.js', ['COURSES']);
const { PAPERS, LEARNING_MATERIALS } = loadData('js/papers.js', ['PAPERS', 'LEARNING_MATERIALS']);
const { CODE_LIBS } = loadData('js/codefiles.js', ['CODE_LIBS']);
const { PROJECTS } = loadData('js/projects.js', ['PROJECTS']);

const items = [];
POSTS.forEach((p) => items.push({
  type: 'post', refId: p.id, title: p.title, tags: p.tags || [],
  series: p.series || '', text: p.excerpt || ''
}));
COURSES.forEach((c) => items.push({
  type: 'course', refId: c.id, title: c.name, category: c.category || '', text: c.description || ''
}));
PAPERS.forEach((p) => items.push({
  type: 'paper', refId: p.id, title: p.title, tags: p.collections || [],
  category: p.category || '', text: p.abstract || ''
}));
(LEARNING_MATERIALS || []).forEach((m) => items.push({
  type: 'material', refId: m.id, title: m.name, category: m.category || '', text: m.subcategory || ''
}));
CODE_LIBS.forEach((l) => items.push({
  type: 'lib', refId: l.id, title: l.name, category: l.category || '', text: l.description || ''
}));

// Batch 9D：项目进入候选（标签 + 技术栈 + 描述），示例身份随行记录
if (WITH_PROJECTS) {
  PROJECTS.forEach((p) => items.push({
    type: 'project', refId: p.id, title: p.name, tags: p.tags || [], tech: p.tech || [],
    text: [p.description, (p.highlights || []).join(' ')].filter(Boolean).join(' '),
    example: !!p.example
  }));
}

const index = Related.buildIndex(items);

// ------------------------------------------------------------------ 样本选择
// 覆盖任务要求的五类：机器人/具身智能、工业自动化、AI/ML、课程与基础、标签稀疏或跨主题。
const POST_SAMPLES = POSTS.map((p) => p.id);
const COURSE_SAMPLES = [
  '本科课程|机器人与自动化-(CS422)',
  '香港大学|GRCNN-抓取检测',
  '本科课程|机器学习与神经网络'
].filter((id) => COURSES.some((c) => c.id === id));

const GROUP_OF = {
  'embodied-ai-notes': '机器人与具身智能',
  'vla-model-intro': '机器人与具身智能',
  'sim-to-real-gap': '机器人与具身智能',
  'arm-trajectory-planning': '机器人与具身智能',
  'robot-grasping-survey': '机器人与具身智能',
  'force-compliance-control': '机器人与具身智能',
  'robotics-textbook-notes': '课程与基础技术',
  'slam-overview-filtering-to-graph': '机器人与具身智能',
  'visual-slam-frontend': '机器人与具身智能',
  'deep-learning-in-slam': '机器人与具身智能',
  'rl-from-mdp-to-ppo': '人工智能与机器学习',
  'rl-robot-control': '人工智能与机器学习',
  'ml-fundamentals-overview': '人工智能与机器学习',
  'smart-production-line': '工业自动化与智能制造',
  'vla-industrial-challenges': '工业自动化与智能制造',
  'industrial-protocols-notes': '工业自动化与智能制造',
  'digital-twin-manufacturing': '工业自动化与智能制造',
  'shenzhen-weekend': '标签稀疏 / 跨主题'
};

const rows = [];
const meta = [];

function collect(sourceType, sourceId, sourceTitle, group, text) {
  const key = sourceType + ':' + sourceId;
  const explicit = Related.extractLinks(text).map((x) => x.key);
  const list = Related.recommend(index, key, { explicit: explicit });
  const seenHref = Object.create(null);
  const all = [];                                  // 用于重复检测：完整结果（含 >5）
  const wider = Related.recommend(index, key, { explicit: explicit, limit: 99 });
  wider.forEach((r) => {
    const dup = !!seenHref[r.href];
    seenHref[r.href] = true;
    all.push({ r, dup });
  });

  meta.push({
    source: key,
    title: sourceTitle,
    group: group,
    candidates: wider.length,
    shown: list.length,
    explicit: explicit.length,
    minScore: Related.MIN_SCORE
  });

  if (!list.length) {
    rows.push({
      source_type: sourceType, source_id: sourceId, source_title: sourceTitle, group: group,
      rank: 0, cand_type: '', cand_id: '', cand_title: '', score: '',
      reasons: '（无有效关联，返回空列表）', href: '', href_valid: '',
      duplicate: '', cand_example: '', review: 'PASS：无关联时不展示无关内容'
    });
    return;
  }

  list.forEach((r, i) => {
    const row = all.find((x) => x.r.key === r.key);
    const dup = !!(row && row.dup);
    const valid = hrefValid(r.href);
    const hasReason = !!(r.reasons && r.reasons.length);
    rows.push({
      source_type: sourceType,
      source_id: sourceId,
      source_title: sourceTitle,
      group: group,
      rank: i + 1,
      cand_type: r.type,
      cand_id: r.refId,
      cand_title: r.title,
      score: r.score,
      reasons: Related.formatReasons(r.reasons, 2),
      href: r.href,
      href_valid: valid ? 'yes' : 'no',
      duplicate: dup ? 'yes' : 'no',
      cand_example: r.example ? 'yes' : 'no',
      review: (valid && hasReason && !dup) ? 'PASS' : 'FAIL'
    });
  });

  // 截断之外是否还有合格候选（说明"最多 5 条"是主动截断，不是无内容）
  if (wider.length > list.length) {
    rows.push({
      source_type: sourceType, source_id: sourceId, source_title: sourceTitle, group: group,
      rank: '>+' + (wider.length - list.length),
      cand_type: '', cand_id: '', cand_title: '', score: '',
      reasons: '（同分/低分的额外候选已按上限截断）', href: '', href_valid: '', duplicate: '',
      cand_example: '', review: 'INFO：主动截断，未展示'
    });
  }
}

POST_SAMPLES.forEach((id) => {
  const post = POSTS.find((p) => p.id === id);
  collect('post', id, post.title, GROUP_OF[id] || '其他', readPostBody(id));
});
COURSE_SAMPLES.forEach((id) => {
  const c = COURSES.find((x) => x.id === id);
  collect('course', id, c.name, '课程与基础技术', c.description || '');
});
// Batch 9D：6 个项目全部作为源，覆盖 项目→文章 / 项目→项目 / 项目→其他类型
if (WITH_PROJECTS) {
  PROJECTS.forEach((p) => {
    collect('project', p.id, p.name, '项目（示例数据）', p.description || '');
  });
}

// ------------------------------------------------------------------ 输出

const header = [
  'source_type', 'source_id', 'source_title', 'group', 'rank',
  'cand_type', 'cand_id', 'cand_title', 'score', 'reasons',
  'href', 'href_valid', 'duplicate'
].concat(WITH_PROJECTS ? ['cand_example'] : []).concat(['review']);

const lines = [header.join(',')];
rows.forEach((r) => lines.push(header.map((k) => csvCell(r[k])).join(',')));
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

// 控制台摘要（供报告引用）
const ok = rows.filter((r) => r.review === 'PASS').length;
const fail = rows.filter((r) => r.review === 'FAIL').length;
const empty = rows.filter((r) => r.rank === 0).length;
const noDup = rows.filter((r) => r.duplicate === 'yes').length;
console.log('sources evaluated:', meta.length, '(posts', POST_SAMPLES.length, '/ courses', COURSE_SAMPLES.length,
  '/ projects', WITH_PROJECTS ? PROJECTS.length : 0, ')');
console.log('recommendation rows:', rows.length, 'PASS', ok, 'FAIL', fail, 'empty sources', empty, 'dup links', noDup);
console.log('index size:', index.size, 'items');
console.log('written:', OUT);
