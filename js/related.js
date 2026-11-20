/**
 * Batch 9B-1：可解释的相关内容推荐（纯算法模块）
 *
 * 设计约束（见 BATCH9B1_REPORT.md）：
 *   - 纯静态、无网络、无 DOM、无 store：只做"输入元数据 → 排序结果"的纯函数计算，
 *     因此可以直接在 node 里做单元测试，也不会因为存储/渲染异常影响阅读；
 *   - 完全确定性：不使用 Date / Math.random / localeCompare，相同输入必得相同输出；
 *   - 只使用站点里真实存在的字段（标签、系列、分类、技术栈、标题、摘要、正文内链），
 *     不做同义词映射、不猜测不存在的关联；
 *   - 归一化只影响匹配，展示永远使用原始串（raw），不改动任何正式内容。
 *
 * 对外 API（挂在 window.Related，node 下挂 module.exports）：
 *   Related.buildIndex(items)                     -> index
 *   Related.recommend(index, sourceKey, opts)     -> [{ key, type, refId, title, href, score, reasons }]
 *   Related.extractLinks(text)                    -> [{ type, refId, key }]
 *   Related.splitId(key) / Related.hrefFor(type, refId) / Related.typeLabel(type)
 *   Related.formatReasons(reasons, max) / Related.WEIGHTS / Related.version
 */
(function (global) {
  'use strict';

  var VERSION = '9b1.2';   // 9b1.2：修复 formatReasons 把 explicit(rank=0) 当成缺失排到最后

  var TYPES = ['post', 'course', 'paper', 'material', 'lib', 'project', 'note'];

  var TYPE_LABELS = {
    post: '文章',
    course: '课程',
    paper: '论文',
    material: '学习资料',
    lib: '代码库',
    project: '项目',
    note: '笔记'
  };

  // 权重集中在这里：全部为"可解释的固定常数"，没有隐式学习参数。
  // 依据见 BATCH9B1_REPORT.md「权重与区分度验证」。
  var WEIGHTS = {
    explicit: 4.0,      // 正文内链（显式关联），最高优先
    series: 3.0,        // 同系列
    tagBase: 1.0,       // 每个共同标签的基础分
    tagIdf: 1.0,        // 每个共同标签的区分度加成（ln(N/df)）
    tagCap: 4.0,        // 标签总分上限，避免"标签多的文章"通吃
    tagGeneric: 0.5,    // 泛标签（df/N >= 0.4，如"技术笔记"）只给低权重
    tagGenericRatio: 0.4,
    topic: 1.8,         // 源标签出现在候选标题/摘要中（跨类型桥接）
    topicCap: 2.6,
    category: 1.8,      // 同分类（课程/论文/资料/代码库的主要关联依据）
    techBase: 0.6,
    techIdf: 0.4,
    techCap: 2.0,
    title: 1.2,         // 标题词重合（重叠系数）
    titleCap: 1.2,
    titleMin: 2         // 至少 2 个共同 token 才计分（1 个仅限 >=4 字符的缩写）
  };

  var MIN_SCORE = 1.6;     // 低于该分视为"无有效关联"，宁缺勿滥
  var MAX_RESULTS = 5;     // 首版每区最多 5 条
  var REASON_MAX = 2;      // 每张卡片最多展示 2 条理由

  // 用于 links 抽取：只认站点里真实存在的路由
  var LINK_PATTERNS = [
    { type: 'post', re: /^#\/post\/([^?#\s"'<>]+)/ },
    { type: 'course', re: /^#\/course\/([^?#\s"'<>]+)/ },
    { type: 'lib', re: /^#\/codelib\/([^?#\s"'<>]+)/ }
  ];
  var PAPERS_LINK_RE = /^#\/papers\?([^#\s"'<>]+)/;

  // ---------------------------------------------------------------- 基础工具

  function isString(v) { return typeof v === 'string' && v.length > 0; }

  // 归一化：仅用于匹配。全角→半角（仅 ASCII 区）、小写、去首尾与压缩空白。
  function norm(v) {
    if (typeof v !== 'string') return '';
    var s = v;
    try {
      if (s.normalize) s = s.normalize('NFKC');
    } catch (e) { /* 老引擎忽略 */ }
    return s.toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
  }

  function uniq(list) {
    var seen = Object.create(null);
    var out = [];
    (list || []).forEach(function (x) {
      var n = norm(x);
      if (!n || seen[n]) return;
      seen[n] = true;
      out.push(n);
    });
    return out;
  }

  // 原始串去重（保留首次出现的显示形态，不去改写大小写/空格）
  function uniqRaw(list) {
    var seen = Object.create(null);
    var out = [];
    (list || []).forEach(function (x) {
      if (!isString(x)) return;
      var n = norm(x);
      if (!n || seen[n]) return;
      seen[n] = true;
      out.push(x);
    });
    return out;
  }

  // 文本 token：拉丁词（含 ROS2 / C++ / OPC-UA）+ 中文二元组
  // 中文没有空格，二元组是稳定且与引擎无关的替代方案（不用分词库，不加依赖）。
  function tokens(text) {
    var s = norm(text);
    if (!s) return [];
    var out = [];
    var latin = s.match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
    latin.forEach(function (w) {
      if (w.length >= 2) out.push(w);
    });
    var cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
    cjk.forEach(function (run) {
      if (run.length === 1) return;
      for (var i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    });
    return uniq(out);
  }

  function makeKey(type, refId) { return type + ':' + refId; }

  function splitId(key) {
    if (!isString(key)) return null;
    var i = key.indexOf(':');
    if (i <= 0) return null;
    var type = key.slice(0, i);
    var refId = key.slice(i + 1);
    if (TYPES.indexOf(type) === -1 || !refId) return null;
    return { type: type, refId: refId };
  }

  // 只输出站点里真实存在的路由；没有稳定目标的内容（项目/笔记）返回空串，
  // 由调用方把它们排除在候选之外 —— 绝不构造"看起来能用"的假详情路由。
  function hrefFor(type, refId) {
    if (!isString(refId)) return '';
    var id = encodeURIComponent(refId);
    if (type === 'post') return '#/post/' + id;
    if (type === 'course') return '#/course/' + id;
    if (type === 'lib') return '#/codelib/' + id;
    if (type === 'paper') return '#/papers?kind=paper&target=' + id;
    if (type === 'material') return '#/papers?kind=material&target=' + id;
    return '';
  }

  function typeLabel(type) { return TYPE_LABELS[type] || ''; }

  // ---------------------------------------------------------------- 索引构建

  /**
   * items: [{ type, refId, title, tags?, category?, series?, tech?, text? }]
   * tags 里可包含论文的 collections（用户自建文件夹，属于真实标注）。
   */
  function buildIndex(items) {
    var list = [];
    var byKey = Object.create(null);
    (items || []).forEach(function (raw) {
      if (!raw || !isString(raw.refId) || TYPES.indexOf(raw.type) === -1) return;
      var key = makeKey(raw.type, raw.refId);
      if (byKey[key]) return;                       // 重复候选：保留首个
      var item = {
        key: key,
        type: raw.type,
        refId: raw.refId,
        title: isString(raw.title) ? raw.title : raw.refId,
        href: hrefFor(raw.type, raw.refId),         // 无有效路由 => '' => 不进候选池
        tagsRaw: uniqRaw(raw.tags),
        tags: uniq(raw.tags),
        categoryRaw: isString(raw.category) ? raw.category : '',
        category: norm(raw.category),
        seriesRaw: isString(raw.series) ? raw.series : '',
        series: norm(raw.series),
        techRaw: uniqRaw(raw.tech),
        tech: uniq(raw.tech),
        text: isString(raw.text) ? raw.text : ''
      };
      item.titleTokens = tokens(item.title);
      item.titleTokenSet = Object.create(null);
      item.titleTokens.forEach(function (t) { item.titleTokenSet[t] = true; });
      // 摘要只用于"源标签出现在候选文本里"的桥接匹配，不直接参与分词打分：
      // 文章摘要里有大量"本文/梳理"这类模板词，按词重合会给出一堆无意义理由。
      item.plain = norm(item.title + ' ' + item.text);
      item.plainTitle = norm(item.title);
      byKey[key] = item;
      list.push(item);
    });

    // 标签/技术栈的文档频率：用于"区分度"权重（df=1 的标签不可能有共同项，忽略）
    var tagDf = Object.create(null);
    var techDf = Object.create(null);
    var taggedCount = 0;
    list.forEach(function (it) {
      if (it.tags.length) taggedCount++;
      it.tags.forEach(function (t) { tagDf[t] = (tagDf[t] || 0) + 1; });
      it.tech.forEach(function (t) { techDf[t] = (techDf[t] || 0) + 1; });
    });

    return {
      items: list,
      byKey: byKey,
      size: list.length,
      taggedCount: taggedCount || 1,
      tagDf: tagDf,
      techDf: techDf
    };
  }

  function idf(df, size) {
    if (!df || !size || df >= size) return 0;
    return Math.log(size / df);
  }

  // 单个共同标签的权重：泛标签（40% 以上带标签的内容都有，且至少 4 条）降权，
  // 其余按 df 给区分度加成。区分度用"带标签内容数"做分母，
  // 避免课程/论文这类没有标签的类型把分母稀释成无意义的值；
  // 加 df>=4 的下限是为了让内容量很小的站点（或测试语料）不会被误判成"全是泛标签"。
  function tagWeight(index, tag) {
    var df = index.tagDf[tag] || 1;
    var generic = df >= 4 && (df / index.taggedCount) >= WEIGHTS.tagGenericRatio;
    if (generic) return WEIGHTS.tagGeneric;
    return WEIGHTS.tagBase + WEIGHTS.tagIdf * idf(df, index.taggedCount);
  }

  // ---------------------------------------------------------------- 打分

  function scorePair(index, src, cand, explicitSet) {
    var reasons = [];
    var score = 0;

    if (explicitSet && explicitSet[cand.key]) {
      score += WEIGHTS.explicit;
      reasons.push({ kind: 'explicit', label: '正文已关联此内容' });
    }

    if (src.series && dst(src.series, cand.series)) {
      score += WEIGHTS.series;
      reasons.push({ kind: 'series', label: '同系列「' + src.seriesRaw + '」' });
    }

    var sharedTags = [];
    var tagScore = 0;
    src.tags.forEach(function (t) {
      if (cand.tags.indexOf(t) === -1) return;
      sharedTags.push(t);
      tagScore += tagWeight(index, t);
    });
    if (sharedTags.length) {
      score += Math.min(tagScore, WEIGHTS.tagCap);
      reasons.push({
        kind: 'tag',
        label: '共同标签：' + displayList(src.tagsRaw, sharedTags)
      });
    }

    if (src.category && dst(src.category, cand.category)) {
      score += WEIGHTS.category;
      reasons.push({ kind: 'category', label: '同分类：' + cand.categoryRaw });
    }

    var sharedTech = [];
    var techScore = 0;
    src.tech.forEach(function (t) {
      if (cand.tech.indexOf(t) === -1) return;
      sharedTech.push(t);
      techScore += WEIGHTS.techBase + WEIGHTS.techIdf * idf(index.techDf[t], index.size);
    });
    if (sharedTech.length) {
      score += Math.min(techScore, WEIGHTS.techCap);
      reasons.push({
        kind: 'tech',
        label: '技术栈重合：' + displayList(src.techRaw, sharedTech)
      });
    }

    var shared = [];
    src.titleTokens.forEach(function (t) {
      if (cand.titleTokenSet[t]) shared.push(t);
    });
    var titleHit = shared.length >= WEIGHTS.titleMin ||
      shared.some(function (t) { return t.length >= 4; });
    if (titleHit) {
      var minSize = Math.min(src.titleTokens.length, cand.titleTokens.length) || 1;
      score += Math.min(WEIGHTS.title * (shared.length / minSize), WEIGHTS.titleCap);
      reasons.push({
        kind: 'text',
        label: '标题主题相近：' + shared.slice(0, 3).join('、')
      });
    }

    // 跨类型桥接：源内容的标签直接出现在候选的标题/摘要里（课程、论文、代码库没有标签）。
    // 只在没有任何共同标签时启用，避免与标签分重复计算。
    if (!sharedTags.length) {
      var hitTags = [];
      src.tags.forEach(function (t) {
        if (tagWeight(index, t) <= WEIGHTS.tagGeneric) return;   // 泛标签不算"内容涉及"
        if (!hitInText(t, cand.plain)) return;
        if (hitTags.length < 3) hitTags.push(t);
      });
      if (hitTags.length) {
        score += Math.min(WEIGHTS.topic * hitTags.length, WEIGHTS.topicCap);
        reasons.push({
          kind: 'topic',
          label: '内容涉及：' + displayList(src.tagsRaw, hitTags)
        });
      }
    }

    return { score: score, reasons: reasons };
  }

  // 标签是否为候选文本中的独立词：中文按子串，拉丁按词边界（避免 ai 命中 training）
  function hitInText(tag, plain) {
    if (!tag || !plain) return false;
    if (/^[\x00-\x7f]+$/.test(tag)) {
      var esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(plain);
    }
    return plain.indexOf(tag) !== -1;
  }

  function dst(a, b) { return !!a && a === b; }

  // 共同 token 是归一化后的串，展示时尽量换回候选侧的原始大小写（如 ROS2 / PyTorch）
  function displayList(rawList, normList) {
    var byNorm = Object.create(null);
    rawList.forEach(function (r) { byNorm[norm(r)] = r; });
    return normList.slice(0, 3).map(function (n) { return byNorm[n] || n; }).join('、');
  }

  // 理由优先级：显式 > 同系列 > 标签 > 分类 > 技术栈 > 文本
  var REASON_RANK = { explicit: 0, series: 1, tag: 2, topic: 3, category: 4, tech: 5, text: 6 };

  // 注意：显式关联的 rank 是 0，不能写 `REASON_RANK[kind] || 9`——
  // 那样 0 会被当成"缺失"抬到 9，把最重要的理由排到最后（B9B1 修复）。
  function reasonRank(kind) {
    var r = REASON_RANK[kind];
    return (r === undefined || r === null) ? 9 : r;
  }

  function formatReasons(reasons, max) {
    var limit = typeof max === 'number' ? max : REASON_MAX;
    return (reasons || [])
      .slice()
      .map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) {
        var d = reasonRank(a.r.kind) - reasonRank(b.r.kind);
        return d || (a.i - b.i);   // 同级别保持生成顺序，避免依赖引擎的 sort 稳定性
      })
      .slice(0, limit)
      .map(function (x) { return x.r.label; })
      .join(' · ');
  }

  /**
   * opts: { explicit: ['lib:x', ...], limit, minScore }
   * 返回按 (score desc, key asc) 排序的推荐列表；同分用 key 的码元序，
   * 不用 localeCompare（结果随引擎/系统语言变化，会破坏确定性）。
   */
  function recommend(index, sourceKey, opts) {
    var o = opts || {};
    var src = index && index.byKey ? index.byKey[sourceKey] : null;
    if (!src) return [];
    var explicitSet = Object.create(null);
    (o.explicit || []).forEach(function (k) { explicitSet[k] = true; });
    var limit = typeof o.limit === 'number' ? o.limit : MAX_RESULTS;
    var minScore = typeof o.minScore === 'number' ? o.minScore : MIN_SCORE;

    var out = [];
    index.items.forEach(function (cand) {
      if (cand.key === src.key) return;             // 排除自身
      if (!cand.href) return;                       // 无稳定目标：不进推荐
      var r = scorePair(index, src, cand, explicitSet);
      if (r.score < minScore) return;               // 不为了凑数量展示弱关联
      out.push({
        key: cand.key,
        type: cand.type,
        refId: cand.refId,
        title: cand.title,
        href: cand.href,
        score: Math.round(r.score * 100) / 100,
        reasons: r.reasons
      });
    });

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });

    // 去重（key 已唯一，这里再按 type+refId 兜底）后截断
    var seen = Object.create(null);
    var deduped = [];
    out.forEach(function (r) {
      if (seen[r.key]) return;
      seen[r.key] = true;
      deduped.push(r);
    });
    return deduped.slice(0, limit);
  }

  // ---------------------------------------------------------------- 显式关联

  /**
   * 从正文 / 笔记 Markdown 里抽取站内真实链接，作为"显式关联"信号。
   * 只认已知路由，解析失败静默跳过（不影响阅读）。
   */
  function extractLinks(text) {
    if (!isString(text)) return [];
    var out = [];
    var seen = Object.create(null);
    // 链接目标允许出现成对括号（课程 ID 形如 `本科课程|机器人与自动化-(CS422)`），
    // 因此按"非括号字符 或 一层成对括号"匹配，而不是简单排除 `)`。
    var re = /\]\(((?:[^\s()]|\([^\s()]*\))+)\)|href="([^"]+)"/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var url = m[1] || m[2] || '';
      if (url.indexOf('#/') !== 0) continue;
      var hit = null;
      for (var i = 0; i < LINK_PATTERNS.length; i++) {
        var mm = LINK_PATTERNS[i].re.exec(url);
        if (mm) {
          var refId = mm[1];
          try { refId = decodeURIComponent(refId); } catch (e) { /* 保留原样 */ }
          hit = { type: LINK_PATTERNS[i].type, refId: refId };
          break;
        }
      }
      if (!hit) {
        var pm = PAPERS_LINK_RE.exec(url);
        if (pm) {
          try {
            var qs = new URLSearchParams(pm[1]);
            var kind = qs.get('kind');
            var target = qs.get('target');
            if (target && (kind === 'paper' || kind === 'material')) {
              hit = { type: kind, refId: target };
            }
          } catch (e) { /* 忽略 */ }
        }
      }
      if (!hit) continue;
      var key = makeKey(hit.type, hit.refId);
      if (seen[key]) continue;
      seen[key] = true;
      hit.key = key;
      out.push(hit);
    }
    return out;
  }

  var api = {
    version: VERSION,
    WEIGHTS: WEIGHTS,
    MIN_SCORE: MIN_SCORE,
    MAX_RESULTS: MAX_RESULTS,
    TYPE_LABELS: TYPE_LABELS,
    buildIndex: buildIndex,
    recommend: recommend,
    extractLinks: extractLinks,
    splitId: splitId,
    hrefFor: hrefFor,
    typeLabel: typeLabel,
    formatReasons: formatReasons,
    tokens: tokens,
    norm: norm
  };

  global.Related = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
