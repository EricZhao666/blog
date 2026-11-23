/**
 * Batch 9E：本地学习统计聚合（纯计算模块）
 *
 * 职责：
 *   - 把 Knowledge 记录 + 分类定义 + 内容元数据聚合成一份只读统计快照；
 *   - 所有口径（去重、已完成、完成率分母、方向归属）都在本文件里显式定义；
 *   - 不做 IO、不写库、不改输入、不注册定时器，可直接被 9F 复用。
 *
 * 边界：
 *   - 没有逐次浏览事件日志，因此不提供访问次数 / 阅读时长 / 在线分钟 / 连续天数；
 *   - 不根据标题猜测技术方向（只认文章标签、课程分类、论文分类、项目标签与技术栈、代码库分类）；
 *   - 项目 / 课程 / 论文 / 资料 / 代码库没有可靠的逐段阅读进度，不进入文章完成率分母。
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var RECENT_LIMIT = 8;
  var RECENT_WINDOW_DAYS = 30;

  var TYPE_ORDER = ['post', 'course', 'paper', 'material', 'lib', 'project', 'note'];
  var TYPE_LABELS = {
    post: '文章', course: '课程', paper: '论文', material: '资料',
    lib: '代码库', project: '项目', note: '笔记'
  };

  // 技术方向：key 稳定，label 只用于展示
  var DIRECTIONS = [
    { key: 'robotics', label: '机器人与具身智能' },
    { key: 'industrial', label: '工业自动化与智能制造' },
    { key: 'ai', label: '人工智能与机器学习' },
    { key: 'software', label: '软件开发与其他技术' },
    { key: 'unknown', label: '未分类' }
  ];

  // 方向归属规则：只匹配内容自带的元数据字段（标签 / 分类 / 技术栈 / 论文集），不读标题。
  // 同一内容命中多个方向时计入多个方向 —— 方向计数之和可以大于唯一内容数。
  var RULES = {
    robotics: [
      '机器人', '机械臂', '具身智能', 'VLA', 'SLAM', '抓取', '运动控制', '力控', '柔顺控制',
      '阻抗控制', '导航', '无人机', '双足', '软体机器人', 'ROS', 'ROS2', 'MoveIt2',
      'Isaac Gym', 'ORB-SLAM3', 'Cartographer', '机器人与自动化', 'AGV'
    ],
    industrial: [
      '智能制造', '产线', '工业', '数字孪生', 'OPC UA', 'Modbus', 'Profinet', 'EtherCAT',
      'PLC', '注塑', '焊接', '边缘计算', 'Jetson', '信号与控制', '电子与硬件', '时序数据库'
    ],
    ai: [
      '人工智能', '机器学习', '深度学习', '强化学习', '神经网络', 'AI', 'PyTorch',
      'TensorRT', 'Transformers', '计算机视觉', 'YOLO', '人工智能与机器学习'
    ],
    software: [
      '软件开发', '前端', '后端', '计算机科学', '综合代码仓库', 'Python', 'C++', 'Linux',
      'Three.js', 'WebSocket', 'MATLAB'
    ]
  };

  // 明确不提供的统计项（口径上没有数据来源），9F 直接复用这份清单，避免各处自造指标
  var UNSUPPORTED = [
    { key: 'visits', label: '总访问次数', reason: '没有逐次浏览事件日志；Knowledge 每条记录只有一个 lastSeenAt 时间戳' },
    { key: 'timeSpent', label: '阅读时长', reason: '没有计时采样，进度只按滚动百分比估算' },
    { key: 'dailyMinutes', label: '每天在线分钟数', reason: '同上：只有进度采样，没有在线时长数据' },
    { key: 'streak', label: '连续学习天数', reason: '历史记录会被裁剪（上限 500 条），且导入数据的日期来自文件，不能代表真实学习日期' },
    { key: 'frequency', label: '精确历史阅读频率', reason: '记录只有首次/最近浏览时间，没有中间的浏览序列' }
  ];

  // ---------------------------------------------------------------- 工具
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ASCII 关键词按词边界匹配（避免 AI 命中 train），中文关键词按子串匹配
  function hasKeyword(value, keyword) {
    var v = String(value == null ? '' : value).toLowerCase();
    var k = String(keyword == null ? '' : keyword).toLowerCase();
    if (!v || !k) return false;
    if (/[a-z0-9]/.test(k)) {
      var re = new RegExp('(^|[^a-z0-9])' + escapeRe(k) + '($|[^a-z0-9])');
      return re.test(v);
    }
    return v.indexOf(k) !== -1;
  }

  // 方向归属：values 为元数据字符串数组；返回命中的方向 key 列表（不含 unknown）
  function classify(values) {
    var list = [];
    (Array.isArray(values) ? values : []).forEach(function (raw) {
      var v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) return;
      DIRECTIONS.forEach(function (d) {
        if (d.key === 'unknown') return;
        if (list.indexOf(d.key) !== -1) return;
        var rules = RULES[d.key] || [];
        for (var i = 0; i < rules.length; i++) {
          if (hasKeyword(v, rules[i])) { list.push(d.key); return; }
        }
      });
    });
    return list;
  }

  function directionLabel(key) {
    for (var i = 0; i < DIRECTIONS.length; i++) {
      if (DIRECTIONS[i].key === key) return DIRECTIONS[i].label;
    }
    return key;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function readMeta(content, type, refId) {
    if (!content) return { state: 'unknown' };
    var bucket = content[type];
    if (!bucket) return { state: 'unknown' };
    var raw = null;
    if (typeof bucket.get === 'function') raw = bucket.get(String(refId));
    else if (Object.prototype.hasOwnProperty.call(bucket, String(refId))) raw = bucket[String(refId)];
    if (!raw) return { state: 'missing' };
    return { state: 'exists', meta: raw };
  }

  function titleOf(rec, resolved) {
    var own = String(rec && rec.title ? rec.title : '').trim();
    if (own) return own;
    if (resolved && resolved.state === 'exists' && resolved.meta) {
      var t = resolved.meta.title || resolved.meta.name || '';
      t = String(t || '').trim();
      if (t) return t;
    }
    return '';
  }

  // 元数据里可用于方向判断的字段：标签 / 分类 / 技术栈 / 论文集
  function metaKeywords(resolved) {
    if (!resolved || resolved.state !== 'exists' || !resolved.meta) return [];
    var m = resolved.meta;
    var out = [];
    function push(v) {
      if (typeof v === 'string') { if (v.trim()) out.push(v.trim()); return; }
      if (Array.isArray(v)) {
        v.forEach(function (x) { if (typeof x === 'string' && x.trim()) out.push(x.trim()); });
      }
    }
    push(m.tags);
    push(m.tech);
    push(m.category);
    push(m.collections);
    push(m.kind);
    return out;
  }

  // 记录去重：严格按 type:refId 唯一（key 字段只作兼容，不作为统计键）
  function uniqueRecords(records) {
    var map = new Map();
    var duplicates = 0;
    (Array.isArray(records) ? records : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var type = typeof raw.type === 'string' ? raw.type : '';
      var refId = raw.refId == null ? '' : String(raw.refId);
      if (!type || !refId) return;
      var key = type + ':' + refId;
      var prev = map.get(key);
      if (prev) {
        duplicates++;
        // 同一键出现两次时保留 updatedAt 较新的那条，结果仍然唯一
        if (num(raw.updatedAt) > num(prev.updatedAt)) map.set(key, raw);
        return;
      }
      map.set(key, raw);
    });
    return { list: Array.from(map.values()), duplicates: duplicates };
  }

  // ---------------------------------------------------------------- 聚合入口
  function summarize(input) {
    var opt = input || {};
    var now = num(opt.now) || Date.now();
    var recentLimit = num(opt.recentLimit) || RECENT_LIMIT;
    var windowDays = num(opt.recentWindowDays) || RECENT_WINDOW_DAYS;
    var categories = Array.isArray(opt.categories) ? opt.categories : [];
    var content = opt.content || null;

    var uniq = uniqueRecords(opt.records);
    var rows = uniq.list;

    var typeCount = {};
    var typeViewed = {};
    var viewed = 0, fav = 0, later = 0, reading = 0, done = 0, favLater = 0, silent = 0;
    var missing = 0, unknownMeta = 0, untitled = 0;
    var recentItems = [];
    var windowStart = now - windowDays * 86400000;
    var windowRows = 0;

    var dirCount = {};
    DIRECTIONS.forEach(function (d) { dirCount[d.key] = 0; });
    var dirAssignments = 0, multiDirection = 0;
    var recentDirCount = {};
    DIRECTIONS.forEach(function (d) { recentDirCount[d.key] = 0; });
    var recentDirAssignments = 0, recentMulti = 0;

    // 完成率：只统计有可靠进度的文章
    var postViewed = 0, postDone = 0, postDoneManual = 0, postDoneAuto = 0, postProgressOnly = 0;
    var otherTypes = {};
    var markedDoneOther = 0;

    var favByCat = {};
    var favTotal = 0;

    rows.forEach(function (rec) {
      var type = rec.type;
      var refId = String(rec.refId);
      var resolved = readMeta(content, type, refId);
      var title = titleOf(rec, resolved);
      var lastSeenAt = num(rec.lastSeenAt);
      var isViewed = lastSeenAt > 0;
      var isFav = !!rec.fav;
      var isLater = !!rec.later;
      var state = rec.readState === 'reading' || rec.readState === 'done' ? rec.readState : 'none';
      var progress = Math.max(0, Math.min(1, Number(rec.progress) || 0));

      typeCount[type] = (typeCount[type] || 0) + 1;
      if (isViewed) { typeViewed[type] = (typeViewed[type] || 0) + 1; viewed++; }
      if (isFav) fav++;
      if (isLater) later++;
      if (isFav && isLater) favLater++;
      if (state === 'reading') reading++;
      if (state === 'done') done++;
      if (!isViewed && (isFav || isLater || state !== 'none')) silent++;

      if (resolved.state === 'missing') missing++;
      if (resolved.state === 'unknown') unknownMeta++;
      if (!title) untitled++;

      if (isFav) {
        favTotal++;
        var cat = String(rec.favCat || 'default');
        favByCat[cat] = (favByCat[cat] || 0) + 1;
      }

      // 方向归属：多方向计数之和允许大于唯一内容数
      var keys = classify(metaKeywords(resolved));
      if (!keys.length) keys = ['unknown'];
      if (keys.length > 1) multiDirection++;
      keys.forEach(function (k) {
        dirCount[k] = (dirCount[k] || 0) + 1;
        dirAssignments++;
      });

      if (isViewed && lastSeenAt >= windowStart) {
        windowRows++;
        if (keys.length > 1) recentMulti++;
        keys.forEach(function (k) {
          recentDirCount[k] = (recentDirCount[k] || 0) + 1;
          recentDirAssignments++;
        });
      }

      if (type === 'post') {
        if (isViewed) postViewed++;
        if (state === 'done') {
          if (isViewed) postDone++;
          if (rec.stateSource === 'manual') postDoneManual++;
          else postDoneAuto++;
        }
        // progress>0 但历史已被清理：不进分母，只作为口径提示
        if (!isViewed && progress > 0) postProgressOnly++;
      } else {
        otherTypes[type] = (otherTypes[type] || 0) + 1;
        if (state === 'done') markedDoneOther++;
      }

      if (isViewed) {
        recentItems.push({
          key: type + ':' + refId,
          type: type,
          refId: refId,
          title: title,
          lastSeenAt: lastSeenAt,
          progress: progress,
          readState: state,
          metaState: resolved.state
        });
      }
    });

    recentItems.sort(function (a, b) {
      if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    var types = TYPE_ORDER.filter(function (t) { return typeCount[t]; }).map(function (t) {
      return {
        type: t, label: TYPE_LABELS[t] || t,
        count: typeCount[t] || 0,
        viewed: typeViewed[t] || 0
      };
    }).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    });

    // 收藏分类：已定义分类全部列出（含 0），未知分类单独归并
    var catRows = categories.map(function (c, i) {
      var id = String(c && c.id != null ? c.id : '');
      return {
        id: id,
        name: String(c && c.name ? c.name : id),
        system: !!(c && c.system),
        count: favByCat[id] || 0,
        unknown: false,
        order: i
      };
    });
    var knownIds = {};
    catRows.forEach(function (c) { knownIds[c.id] = true; });
    var unknownCatCount = 0;
    Object.keys(favByCat).forEach(function (id) {
      if (knownIds[id]) return;
      unknownCatCount += favByCat[id];
    });
    if (unknownCatCount) {
      catRows.push({
        id: '', name: '未知分类', system: false,
        count: unknownCatCount, unknown: true, order: 9999
      });
    }
    catRows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.order - b.order;
    });

    var directions = DIRECTIONS.map(function (d) {
      return { key: d.key, label: d.label, count: dirCount[d.key] || 0 };
    }).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return DIRECTIONS.findIndex(function (d) { return d.key === a.key; }) -
        DIRECTIONS.findIndex(function (d) { return d.key === b.key; });
    });

    var recentDirections = DIRECTIONS.map(function (d) {
      return { key: d.key, label: d.label, count: recentDirCount[d.key] || 0 };
    }).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return DIRECTIONS.findIndex(function (d) { return d.key === a.key; }) -
        DIRECTIONS.findIndex(function (d) { return d.key === b.key; });
    });

    var excluded = TYPE_ORDER.filter(function (t) { return otherTypes[t]; }).map(function (t) {
      return { type: t, label: TYPE_LABELS[t] || t, count: otherTypes[t] };
    });

    return {
      version: VERSION,
      generatedAt: now,
      totals: {
        records: rows.length,
        rawRecords: (Array.isArray(opt.records) ? opt.records.length : 0),
        duplicates: uniq.duplicates,
        viewed: viewed,
        fav: fav,
        later: later,
        reading: reading,
        done: done,
        favLater: favLater,
        silent: silent
      },
      types: types,
      favCategories: catRows,
      favTotal: favTotal,
      unknownFavCategory: unknownCatCount,
      directions: directions,
      directionTotals: {
        assignments: dirAssignments,
        uniqueContent: rows.length,
        multiDirection: multiDirection,
        unattributed: dirCount.unknown || 0
      },
      recent: recentItems.slice(0, recentLimit),
      recentTotal: recentItems.length,
      recentDirections: {
        windowDays: windowDays,
        since: windowStart,
        directions: recentDirections,
        assignments: recentDirAssignments,
        uniqueContent: windowRows,
        multiDirection: recentMulti
      },
      completion: {
        // 只有文章有可靠的滚动进度；其余内容类型不进入分母
        scope: 'post',
        viewed: postViewed,
        done: postDone,
        remaining: Math.max(0, postViewed - postDone),
        rate: postViewed ? Math.round((postDone / postViewed) * 1000) / 1000 : 0,
        doneManual: postDoneManual,
        doneAuto: postDoneAuto,
        progressOnly: postProgressOnly,
        excludedTypes: excluded,
        markedDoneOther: markedDoneOther
      },
      quality: {
        missing: missing,
        unknownMeta: unknownMeta,
        untitled: untitled,
        unknownFavCategory: unknownCatCount
      },
      unsupported: UNSUPPORTED.slice()
    };
  }

  var api = {
    VERSION: VERSION,
    RECENT_LIMIT: RECENT_LIMIT,
    RECENT_WINDOW_DAYS: RECENT_WINDOW_DAYS,
    TYPES: TYPE_ORDER,
    TYPE_LABELS: TYPE_LABELS,
    DIRECTIONS: DIRECTIONS,
    RULES: RULES,
    UNSUPPORTED: UNSUPPORTED,
    hasKeyword: hasKeyword,
    classify: classify,
    directionLabel: directionLabel,
    summarize: summarize,
    // 别名：9F 可以继续用 build()，与 summarize 完全等价
    build: summarize
  };

  global.LearningStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
