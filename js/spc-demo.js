/**
 * Batch 9C-2A：SPC 统计过程控制与过程能力实验室 —— UI 模块
 * （原生 SVG，无框架、无后端、无上传、无持久化）
 *
 * 两种模式严格区分：
 *   A. 理论参数模式：均值与标准差由用户直接输入（总体参数），只展示正态分布下的
 *      能力指数与理论不良率；不产生控制图，不使用任何样本估计。
 *   B. 实测数据分析：解析用户粘贴的单列测量序列，计算描述统计、I-MR 控制图、
 *      四项异常规则、可选冻结基线、Cp/Cpk/Pp/Ppk、直方图与实测超规比例。
 *
 * 职责：
 *   - renderPage()：纯字符串渲染页面骨架（可深链、可被路由直接 innerHTML）；
 *   - mount(root)：绑定输入/模式/示例/基线，全部监听器挂在 root 内部节点上，
 *     路由切换销毁 DOM 即完成清理，不注册任何 window/document 级监听器；
 *   - getState(root)：只读数值快照，供测试做**数值**断言。
 *
 * 大样本图表抽样只影响绘制；统计与异常检测始终使用全部原始样本，
 * 异常点强制绘制，异常列表按全部样本索引给出。
 * 颜色全部走站点设计令牌（var(--color-*)），深浅主题自动适配。
 */
(function (global) {
  'use strict';

  var DEBOUNCE_MS = 150;
  var CW = 760, CH = 260;
  var PAD = { left: 72, right: 58, top: 18, bottom: 34 };
  var HIST_H = 240;
  var MAX_LABEL_ITEMS = 20;

  var SPEC_FIELDS = [
    { id: 'spcLsl', key: 'lsl', label: '规格下限 LSL', step: 'any' },
    { id: 'spcUsl', key: 'usl', label: '规格上限 USL', step: 'any' },
    { id: 'spcTarget', key: 'target', label: '目标值（可选）', step: 'any' }
  ];

  function SC() { return global.SpcCalculation; }

  // ---------------------------------------------------------------- 格式化

  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    var n = Math.abs(v) < Math.pow(10, -d) / 2 ? 0 : v;
    return n.toFixed(d);
  }

  function fmtSmart(v) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    var a = Math.abs(v);
    if (a !== 0 && a < 0.001) return v.toExponential(3);
    if (a >= 1e6) return v.toExponential(3);
    return fmt(v, 4);
  }

  function pctOrDash(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    return fmt(v * 100, d === undefined ? 2 : d) + '%';
  }

  function ppmText(v) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (v === 0) return '0（模型估计）';
    if (v < 0.001) return '< 0.001';
    return fmt(v, v < 1 ? 4 : 2);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function unitOf(r) {
    return (r && r.spec && r.spec.unit) ? ' ' + r.spec.unit : '';
  }

  // ---------------------------------------------------------------- 页面骨架

  function specFieldRow(f) {
    return '<label class="spc-input-label" for="' + f.id + '">' + f.label +
      '<input id="' + f.id + '" type="number" step="' + f.step + '" inputmode="decimal"></label>';
  }

  function renderPage() {
    var exOpts = SC().EXAMPLES.map(function (ex) {
      return '<option value="' + ex.id + '">' + esc(ex.name) + '</option>';
    }).join('') + '<option value="custom">自定义数据</option>';

    return '' +
      '<div class="spc-page" id="spcDemoRoot">' +
      '<h1 class="page-title">SPC 统计过程控制与过程能力实验室</h1>' +
      '<p class="page-desc">单值—移动极差（I-MR）控制图与过程能力分析：实测模式解析你粘贴的单列测量序列，' +
      '计算统计量、控制界限、四项异常规则、Cp/Cpk/Pp/Ppk 与实测超规比例；理论参数模式只按你输入的总体均值与标准差' +
      '展示正态分布下的能力指数。两种模式的数据来源不同，不混用。全部计算在本机浏览器完成，不上传任何数据。' +
      '教学工具，不能替代企业正式 SPC 或质量放行系统。</p>' +

      '<div class="spc-layout">' +
      '<div class="spc-main">' +

      // 状态与提示
      '<section class="spc-card" aria-labelledby="spcStatusTitle">' +
      '<h2 class="spc-card-title" id="spcStatusTitle">数据状态与口径提示</h2>' +
      '<p class="spc-mode-line">当前模式：<strong id="spcModeLabel">实测数据分析</strong>' +
      '<span class="spc-mode-hint" id="spcModeHint"></span></p>' +
      '<p class="spc-error" id="spcError" aria-live="polite"></p>' +
      '<ul class="spc-warnings" id="spcWarnings" aria-live="polite"></ul>' +
      '</section>' +

      // 统计指标
      '<section class="spc-card" id="spcStatsCard" aria-labelledby="spcStatsTitle">' +
      '<h2 class="spc-card-title" id="spcStatsTitle">样本统计（保留原始生产顺序）</h2>' +
      '<dl class="spc-stats" id="spcStatsBody"></dl>' +
      '</section>' +

      // I 图
      '<section class="spc-card" id="spcICard" aria-labelledby="spcITitle">' +
      '<h2 class="spc-card-title" id="spcITitle">I 控制图（单值，n=1 子组）</h2>' +
      '<div class="spc-chart-wrap"><svg id="spcChartI" class="spc-chart" viewBox="0 0 ' + CW + ' ' + CH + '" role="img" aria-label="I 控制图"></svg></div>' +
      '<div class="spc-legend" id="spcLegendI"></div>' +
      '<p class="spc-chart-note" id="spcNoteI"></p>' +
      '<div class="spc-table-wrap"><table class="spc-limit-table"><caption class="spc-visually-hidden">I 图中心线与控制界限数值</caption>' +
      '<thead><tr><th scope="col">要素</th><th scope="col">数值</th><th scope="col">性质</th></tr></thead>' +
      '<tbody class="spc-limit-body" data-chart="i"></tbody></table></div>' +
      '</section>' +

      // MR 图
      '<section class="spc-card" id="spcMrCard" aria-labelledby="spcMrTitle">' +
      '<h2 class="spc-card-title" id="spcMrTitle">MR 控制图（相邻移动极差，长度 2）</h2>' +
      '<div class="spc-chart-wrap"><svg id="spcChartMR" class="spc-chart" viewBox="0 0 ' + CW + ' ' + CH + '" role="img" aria-label="MR 移动极差控制图"></svg></div>' +
      '<div class="spc-legend" id="spcLegendMR"></div>' +
      '<p class="spc-chart-note" id="spcNoteMR"></p>' +
      '<div class="spc-table-wrap"><table class="spc-limit-table"><caption class="spc-visually-hidden">MR 图中心线与控制界限数值</caption>' +
      '<thead><tr><th scope="col">要素</th><th scope="col">数值</th><th scope="col">性质</th></tr></thead>' +
      '<tbody class="spc-limit-body" data-chart="mr"></tbody></table></div>' +
      '</section>' +

      // 直方图
      '<section class="spc-card" id="spcHistCard" aria-labelledby="spcHistTitle">' +
      '<h2 class="spc-card-title" id="spcHistTitle">分布（实测直方图 / 理论正态密度）</h2>' +
      '<div class="spc-chart-wrap"><svg id="spcChartHist" class="spc-chart" viewBox="0 0 ' + CW + ' ' + HIST_H + '" role="img" aria-label="测量值直方图"></svg></div>' +
      '<div class="spc-legend" id="spcLegendHist"></div>' +
      '<p class="spc-chart-note" id="spcNoteHist"></p>' +
      '<dl class="spc-dist-facts" id="spcDistFacts"></dl>' +
      '</section>' +

      // 过程能力
      '<section class="spc-card" id="spcCapCard" aria-labelledby="spcCapTitle">' +
      '<h2 class="spc-card-title" id="spcCapTitle">过程能力指数</h2>' +
      '<div class="spc-table-wrap"><table class="spc-cap-table"><caption class="spc-visually-hidden">过程能力指数与计算口径</caption>' +
      '<thead><tr><th scope="col">指数</th><th scope="col">数值</th><th scope="col">计算口径</th><th scope="col">波动口径</th></tr></thead>' +
      '<tbody id="spcCapBody"></tbody></table></div>' +
      '<p class="spc-cap-note" id="spcCapNote"></p>' +
      '<p class="spc-hint" id="spcCapThreshold"></p>' +
      '</section>' +

      // 异常规则
      '<section class="spc-card" id="spcViolCard" aria-labelledby="spcViolTitle">' +
      '<h2 class="spc-card-title" id="spcViolTitle">异常规则命中（默认不排除任何样本）</h2>' +
      '<ul class="spc-violations" id="spcViolList"></ul>' +
      '<p class="spc-hint">这里只实现四项规则（单点越界、连续 8 点同侧、连续 6 点单调、移动极差越界），' +
      '不是 Nelson / Western Electric 全部规则。异常样本不会被自动删除，控制界限也不会自动重算。</p>' +
      '</section>' +

      // 理论模式说明（实测模式下隐藏）
      '<section class="spc-card" id="spcTheoryCard" hidden aria-labelledby="spcTheoryTitle">' +
      '<h2 class="spc-card-title" id="spcTheoryTitle">理论参数模式说明</h2>' +
      '<p class="spc-hint">理论参数模式没有实测样本，因此不绘制 I/MR 控制图、不做异常检测、' +
      '不计算 Pp/Ppk（整体波动需要实测样本标准差）。Cp/Cpk 使用你输入的标准差作为 σ，' +
      '属于总体参数假设，不是从过程数据估计出来的。</p>' +
      '</section>' +

      '</div>' +

      // 右侧面板
      '<aside class="spc-panel" aria-label="数据与参数面板">' +

      '<div class="spc-field">' +
      '<span class="spc-field-title">分析模式</span>' +
      '<div class="spc-modes" role="radiogroup" aria-label="分析模式">' +
      '<label class="spc-radio"><input type="radio" name="spcMode" id="spcModeMeasured" value="measured" checked>' +
      '<span>实测数据分析</span></label>' +
      '<label class="spc-radio"><input type="radio" name="spcMode" id="spcModeTheory" value="theoretical">' +
      '<span>理论参数实验</span></label>' +
      '</div>' +
      '<p class="spc-mode-desc" id="spcModeDesc">粘贴单列测量值，按真实生产顺序计算控制图与能力指数。</p>' +
      '</div>' +

      // 实测输入
      '<div class="spc-field" id="spcMeasuredFields">' +
      '<span class="spc-field-title">测量数据（单列，最多 ' + SC().MAX_SAMPLES + ' 个）</span>' +
      '<textarea id="spcData" class="spc-textarea" rows="8" spellcheck="false" ' +
      'aria-describedby="spcDataHelp" placeholder="每行一个数值，或用逗号/分号/空格分隔"></textarea>' +
      '<p class="spc-hint" id="spcDataHelp">支持换行、英文/中文逗号、分号、空格、制表符分隔；' +
      '小数点用「.」，不支持千分位逗号、单位后缀或多列日志。非法数据会指出行号与该行第几个数据，' +
      '不会静默删除后继续计算。</p>' +
      '<label class="spc-input-label" for="spcExample">教学示例（全部为合成数据）' +
      '<select id="spcExample">' + exOpts + '</select></label>' +
      '<p class="spc-example-note" id="spcExampleNote"></p>' +
      '<button type="button" id="spcReset" class="spc-btn">恢复默认示例</button>' +
      '</div>' +

      // 理论输入
      '<div class="spc-field" id="spcTheoryFields" hidden>' +
      '<span class="spc-field-title">总体参数（用户输入，非样本估计）</span>' +
      '<label class="spc-input-label" for="spcMean">过程均值 μ' +
      '<input id="spcMean" type="number" step="any" inputmode="decimal"></label>' +
      '<label class="spc-input-label" for="spcSd">过程标准差 σ（必须 > 0）' +
      '<input id="spcSd" type="number" step="any" min="0" inputmode="decimal"></label>' +
      '</div>' +

      // 规格
      '<div class="spc-field">' +
      '<span class="spc-field-title">规格与单位</span>' +
      SPEC_FIELDS.map(specFieldRow).join('') +
      '<label class="spc-input-label" for="spcUnit">测量单位（可选，仅显示）' +
      '<input id="spcUnit" type="text" maxlength="12" inputmode="text"></label>' +
      '</div>' +

      // 冻结基线
      '<div class="spc-field" id="spcBaselineField">' +
      '<span class="spc-field-title">冻结控制界限（基准样本段）</span>' +
      '<p class="spc-hint">设定基准后，I/MR 控制界限固定为基准段的估计值；后续样本按固定界限检测，' +
      '不会因为新增异常而重算界限把异常掩盖掉。</p>' +
      '<div class="spc-range">' +
      '<label class="spc-input-label" for="spcBaselineStart">起始序号<input id="spcBaselineStart" type="number" min="1" step="1" inputmode="numeric"></label>' +
      '<label class="spc-input-label" for="spcBaselineEnd">结束序号<input id="spcBaselineEnd" type="number" min="1" step="1" inputmode="numeric"></label>' +
      '</div>' +
      '<div class="spc-btn-row">' +
      '<button type="button" id="spcFreeze" class="spc-btn">建立/更新基准</button>' +
      '<button type="button" id="spcClearBaseline" class="spc-btn">清除基准</button>' +
      '</div>' +
      '<p class="spc-baseline-state" id="spcBaselineState">未建立基准：控制界限由当前全部样本估计。</p>' +
      '</div>' +

      '<div class="spc-explain">' +
      '<p><strong>I 图</strong>：CL = 样本均值；UCL/LCL = CL ± 3σ_within；σ_within = 平均移动极差 ÷ 1.128（d2，长度 2）。</p>' +
      '<p><strong>MR 图</strong>：CL = 平均移动极差；UCL = 3.267 × CL（D4）；LCL = 0（D3）。</p>' +
      '<p><strong>短期 vs 整体</strong>：Cp/Cpk 用 σ_within（相邻差分的短期波动）；Pp/Ppk 用样本标准差 s（整体离散）。' +
      '两者不可混用，也不能互换解释。</p>' +
      '<p><strong>控制界限 ≠ 规格界限</strong>：控制界限来自过程自身的短期波动，用来判断过程是否稳定；' +
      '规格界限来自工程/客户要求，用来判断产品是否合格。稳定不等于合格，合格也不等于稳定。</p>' +
      '<p><strong>基线冻结</strong>：先取一段确认稳定的样本建立基准，之后固定界限监测。' +
      '对比"使用全部样本"与"冻结基线"两种口径，可以看清界限被新增数据拖动造成的掩盖效应。</p>' +
      '</div>' +
      '<span id="spcLive" class="spc-visually-hidden" aria-live="polite"></span>' +
      '</aside>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 图表工具

  function scaleY(v, min, max, top, bottom) {
    if (!(max > min)) return (top + bottom) / 2;
    return top + (bottom - top) * (1 - (v - min) / (max - min));
  }

  function niceRange(values) {
    var min = values[0], max = values[0];
    for (var i = 1; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    return { min: min, max: max };
  }

  /**
   * 标签避让：按 y 排序后逐项推开，保证相邻标签至少 gap 像素，
   * 避免 UCL 与 USL 在接近时重叠（视觉上无法区分统计界限与规格界限）。
   */
  function placeLabels(items, gap) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
    }
    return sorted;
  }

  function svgText(x, y, text, cls, anchor) {
    return '<text class="' + cls + '" x="' + x.toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '"' +
      (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(text) + '</text>';
  }

  function axisFrame(inner) {
    var top = PAD.top, bottom = CH - PAD.bottom;
    return '<line class="spc-axis" x1="' + PAD.left + '" y1="' + bottom + '" x2="' + (CW - PAD.right) + '" y2="' + bottom + '"></line>' +
      '<line class="spc-axis" x1="' + PAD.left + '" y1="' + top + '" x2="' + PAD.left + '" y2="' + bottom + '"></line>' + inner;
  }

  // ---------------------------------------------------------------- I 图

  function renderChartI(svg, note, legend, r) {
    var st = r.stats;
    var lim = r.limits.i;
    if (!st || st.n < 2 || lim.ucl === null) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      legend.innerHTML = '';
      note.hidden = false;
      note.textContent = '样本不足 2 个或无法估计移动极差：I 图控制界限不可建立（不宣称已建立控制界限）。';
      return;
    }
    svg.removeAttribute('hidden');
    note.hidden = false;

    var spec = r.spec || {};
    // 图形数据直接使用统计量派生的范围，避免把 5000 个点全部塞进 DOM
    var yCandidates = [lim.ucl, lim.lcl, lim.cl, st.min, st.max];
    var specDrawn = false;
    if (spec.ok) {
      var controlSpan = Math.max(lim.ucl, st.max) - Math.min(lim.lcl, st.min);
      var specSpan = Math.max(spec.usl, st.max) - Math.min(spec.lsl, st.min);
      // 规格界限离控制范围过远时裁剪（否则数据折线被压成一条线），并在图注说明
      if (specSpan <= (controlSpan || 1) * 8) {
        yCandidates.push(spec.usl, spec.lsl);
        specDrawn = true;
      }
    }
    var range = niceRange(yCandidates);
    var pad = (range.max - range.min) * 0.08 || Math.abs(range.max) * 0.01 || 1;
    var yMin = range.min - pad, yMax = range.max + pad;
    var top = PAD.top, bottom = CH - PAD.bottom;
    var left = PAD.left, right = CW - PAD.right;
    var plotW = right - left;

    function xOf(i) { return r.n === 1 ? left + plotW / 2 : left + plotW * (i / (r.n - 1)); }
    function yOf(v) { return scaleY(v, yMin, yMax, top, bottom); }

    var html = '';
    // 基线区间底色
    if (r.baseline) {
      var bx0 = xOf(r.baseline.start - 1), bx1 = xOf(r.baseline.end - 1);
      html += '<rect class="spc-band" x="' + bx0.toFixed(1) + '" y="' + top + '" width="' + Math.max(1, bx1 - bx0).toFixed(1) +
        '" height="' + (bottom - top) + '"></rect>';
    }
    // 网格（三条参考刻度）
    [yMax, (yMax + yMin) / 2, yMin].forEach(function (v) {
      html += '<line class="spc-grid" x1="' + left + '" y1="' + yOf(v).toFixed(1) + '" x2="' + right + '" y2="' + yOf(v).toFixed(1) + '"></line>';
      html += svgText(left - 6, yOf(v), fmtSmart(v), 'spc-tick', 'end');
    });
    // 规格界限（虚线，工程要求）
    if (specDrawn) {
      html += '<line class="spc-line spc-line--spec" x1="' + left + '" y1="' + yOf(spec.usl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(spec.usl).toFixed(1) + '"></line>';
      html += '<line class="spc-line spc-line--spec" x1="' + left + '" y1="' + yOf(spec.lsl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(spec.lsl).toFixed(1) + '"></line>';
    }
    // 控制界限（点划线，统计）
    html += '<line class="spc-line spc-line--limit" x1="' + left + '" y1="' + yOf(lim.ucl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(lim.ucl).toFixed(1) + '"></line>';
    html += '<line class="spc-line spc-line--limit" x1="' + left + '" y1="' + yOf(lim.lcl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(lim.lcl).toFixed(1) + '"></line>';
    // 中心线（实线）
    html += '<line class="spc-line spc-line--cl" x1="' + left + '" y1="' + yOf(lim.cl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(lim.cl).toFixed(1) + '"></line>';

    // 数据折线（抽样绘制，异常点强制补充）
    var pts = r.chartSample.indexes;
    var d = '';
    for (var k = 0; k < pts.length; k++) {
      var idx = pts[k];
      d += (k ? 'L' : 'M') + xOf(idx).toFixed(1) + ' ' + yOf(r.values[idx]).toFixed(1);
    }
    html += '<path class="spc-series" d="' + d + '"></path>';
    for (var m = 0; m < pts.length; m++) {
      var pi = pts[m];
      var isViol = r.pointRules[pi] && r.pointRules[pi].length > 0;
      html += '<circle class="spc-dot' + (isViol ? ' spc-dot--violation' : '') + '" cx="' + xOf(pi).toFixed(1) +
        '" cy="' + yOf(r.values[pi]).toFixed(1) + '" r="' + (isViol ? 4 : 2.2) + '"></circle>';
    }
    for (var f = 0; f < r.chartSample.forced.length; f++) {
      var fi = r.chartSample.forced[f];
      html += '<circle class="spc-dot spc-dot--violation" cx="' + xOf(fi).toFixed(1) +
        '" cy="' + yOf(r.values[fi]).toFixed(1) + '" r="4"></circle>';
    }

    // 界限标签（避让后输出）
    var labels = [
      { y: yOf(lim.ucl), text: 'UCL ' + fmtSmart(lim.ucl), cls: 'spc-label spc-label--limit' },
      { y: yOf(lim.cl), text: 'CL ' + fmtSmart(lim.cl), cls: 'spc-label spc-label--cl' },
      { y: yOf(lim.lcl), text: 'LCL ' + fmtSmart(lim.lcl), cls: 'spc-label spc-label--limit' }
    ];
    if (specDrawn) {
      labels.push({ y: yOf(spec.usl), text: 'USL ' + fmtSmart(spec.usl), cls: 'spc-label spc-label--spec' });
      labels.push({ y: yOf(spec.lsl), text: 'LSL ' + fmtSmart(spec.lsl), cls: 'spc-label spc-label--spec' });
    }
    placeLabels(labels, 10).forEach(function (it) {
      html += svgText(right - 2, Math.max(top + 4, Math.min(bottom - 2, it.y)), it.text, it.cls, 'end');
    });

    html += svgText(left, CH - 10, '样本序号 1', 'spc-tick', 'start');
    html += svgText(right, CH - 10, r.n + '（生产顺序）', 'spc-tick', 'end');
    svg.innerHTML = axisFrame(html);
    svg.setAttribute('aria-label', 'I 控制图，共 ' + r.n + ' 个按生产顺序排列的单值；中心线 ' + fmtSmart(lim.cl) +
      '，上控制界限 ' + fmtSmart(lim.ucl) + '，下控制界限 ' + fmtSmart(lim.lcl) +
      (specDrawn ? '，规格上限 ' + fmtSmart(spec.usl) + '，规格下限 ' + fmtSmart(spec.lsl) : ''));

    legend.innerHTML = legendHtml(true, specDrawn);
    note.textContent = '控制界限由' + (r.limits.frozen ? '冻结基线' : '当前全部样本') + '估计；' +
      '图形为显示抽样（每 ' + r.chartSample.step + ' 个样本画 1 点，异常点强制绘制），' +
      '统计与异常检测使用全部 ' + r.n + ' 个原始样本。' +
      (spec.ok && !specDrawn ? ' 规格界限离控制范围过远，未在图中绘制（数值见下表与能力卡）。' : '');

    // 界限数值表（图形不是唯一表达）
    var rows = [
      ['UCL（I 图上限）', fmtSmart(lim.ucl), '统计控制界限'],
      ['CL（I 图中心线）', fmtSmart(lim.cl), '样本均值'],
      ['LCL（I 图下限）', fmtSmart(lim.lcl), '统计控制界限']
    ];
    if (spec.ok) {
      rows.push(['USL（规格上限）', fmtSmart(spec.usl), '工程规格界限']);
      rows.push(['LSL（规格下限）', fmtSmart(spec.lsl), '工程规格界限']);
    }
    var body = svg.closest('.spc-card').querySelector('tbody.spc-limit-body[data-chart="i"]');
    if (body) {
      body.innerHTML = rows.map(function (row) {
        return '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + esc(row[1]) + unitOf(r) + '</td><td>' + esc(row[2]) + '</td></tr>';
      }).join('');
    }
  }

  function legendHtml(withSpec, specDrawn) {
    var items = [
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--limit"></span>控制界限（统计，来自短期波动）</span>',
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--cl"></span>中心线</span>',
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--series"></span>实测序列</span>',
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--violation"></span>规则命中点</span>'
    ];
    if (withSpec) {
      items.push('<span class="spc-legend-item"><span class="spc-swatch spc-swatch--spec"></span>规格界限（工程要求，不可替代控制界限）</span>');
    }
    return items.join('');
  }

  // ---------------------------------------------------------------- MR 图

  function renderChartMR(svg, note, legend, r) {
    var lim = r.limits.mr;
    var mr = r.stats.mr;
    if (!mr || mr.count < 1 || lim.ucl === null) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      legend.innerHTML = '';
      note.hidden = false;
      note.textContent = '移动极差数量不足：至少需要 2 个样本才能估计 MR 图。';
      return;
    }
    svg.removeAttribute('hidden');
    note.hidden = false;

    var mrs = mr.values;
    var top = PAD.top, bottom = CH - PAD.bottom;
    var left = PAD.left, right = CW - PAD.right;
    var plotW = right - left;
    var yMax = Math.max(lim.ucl, lim.cl) * 1.15;
    if (!(yMax > 0)) yMax = 1;
    var yMin = 0;

    function xOf(i) { return mrs.length === 1 ? left + plotW / 2 : left + plotW * (i / (mrs.length - 1)); }
    function yOf(v) { return scaleY(v, yMin, yMax, top, bottom); }

    var html = '';
    if (r.baseline) {
      var s0 = Math.max(0, r.baseline.start - 2);
      var s1 = Math.max(0, r.baseline.end - 2);
      html += '<rect class="spc-band" x="' + xOf(s0).toFixed(1) + '" y="' + top + '" width="' +
        Math.max(1, xOf(s1) - xOf(s0)).toFixed(1) + '" height="' + (bottom - top) + '"></rect>';
    }
    [yMax, yMax / 2, 0].forEach(function (v) {
      html += '<line class="spc-grid" x1="' + left + '" y1="' + yOf(v).toFixed(1) + '" x2="' + right + '" y2="' + yOf(v).toFixed(1) + '"></line>';
      html += svgText(left - 6, yOf(v), fmtSmart(v), 'spc-tick', 'end');
    });
    html += '<line class="spc-line spc-line--limit" x1="' + left + '" y1="' + yOf(lim.ucl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(lim.ucl).toFixed(1) + '"></line>';
    html += '<line class="spc-line spc-line--cl" x1="' + left + '" y1="' + yOf(lim.cl).toFixed(1) + '" x2="' + right + '" y2="' + yOf(lim.cl).toFixed(1) + '"></line>';
    html += '<line class="spc-line spc-line--limit" x1="' + left + '" y1="' + yOf(0).toFixed(1) + '" x2="' + right + '" y2="' + yOf(0).toFixed(1) + '"></line>';

    var d = '';
    for (var i = 0; i < mrs.length; i++) {
      d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(mrs[i]).toFixed(1);
    }
    html += '<path class="spc-series" d="' + d + '"></path>';
    for (var j = 0; j < mrs.length; j++) {
      var isViol = r.pointRules[j + 1] && r.pointRules[j + 1].indexOf('mr-beyond-limits') !== -1;
      html += '<circle class="spc-dot' + (isViol ? ' spc-dot--violation' : '') + '" cx="' + xOf(j).toFixed(1) +
        '" cy="' + yOf(mrs[j]).toFixed(1) + '" r="' + (isViol ? 4 : 2) + '"></circle>';
    }

    var labels = [
      { y: yOf(lim.ucl), text: 'UCL ' + fmtSmart(lim.ucl), cls: 'spc-label spc-label--limit' },
      { y: yOf(lim.cl), text: 'CL ' + fmtSmart(lim.cl), cls: 'spc-label spc-label--cl' },
      { y: yOf(0), text: 'LCL 0', cls: 'spc-label spc-label--limit' }
    ];
    placeLabels(labels, 10).forEach(function (it) {
      html += svgText(right - 2, Math.max(top + 4, Math.min(bottom - 2, it.y)), it.text, it.cls, 'end');
    });
    html += svgText(left, CH - 10, 'MR 序号 2', 'spc-tick', 'start');
    html += svgText(right, CH - 10, r.n + '（相邻差分）', 'spc-tick', 'end');

    svg.innerHTML = axisFrame(html);
    svg.setAttribute('aria-label', 'MR 移动极差控制图，共 ' + mrs.length + ' 个相邻差分；中心线 ' +
      fmtSmart(lim.cl) + '，上控制界限 ' + fmtSmart(lim.ucl) + '，下控制界限 0');
    legend.innerHTML = legendHtml(false, false);
    note.textContent = 'MR 图反映相邻样本的短期波动；MR 长度固定为 2（d2=1.128、D4=3.267、D3=0）。' +
      '缓慢漂移时 MR 可能仍然很小，此时 I 图会先出现连续同侧信号，这是 I-MR 组合的常见局限。';

    var body = svg.closest('.spc-card').querySelector('tbody.spc-limit-body[data-chart="mr"]');
    if (body) {
      body.innerHTML = [
        ['UCL（MR 图上限）', fmtSmart(lim.ucl), 'D4 × MR均值（D4=3.267）'],
        ['CL（MR 图中心线）', fmtSmart(lim.cl), '平均移动极差'],
        ['LCL（MR 图下限）', fmtSmart(lim.lcl), 'D3 × MR均值（D3=0）'],
        ['平均移动极差', fmtSmart(mr.mean), '全部相邻差分的平均'],
        ['σ_within', fmtSmart(r.limits.sigmaWithin), 'MR均值 ÷ 1.128']
      ].map(function (row) {
        return '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + esc(row[1]) + unitOf(r) + '</td><td>' + esc(row[2]) + '</td></tr>';
      }).join('');
    }
  }

  // ---------------------------------------------------------------- 直方图

  function renderHistogram(svg, note, legend, r, facts) {
    var hist = r.histogram;
    if (!hist) {
      svg.innerHTML = '';
      svg.setAttribute('hidden', '');
      legend.innerHTML = '';
      note.hidden = false;
      note.textContent = '没有可用于分布图的样本。';
      return;
    }
    svg.removeAttribute('hidden');
    note.hidden = false;

    var top = PAD.top, bottom = HIST_H - PAD.bottom;
    var left = PAD.left, right = CW - PAD.right;
    var plotW = right - left;
    var vMin = hist.viewMin, vMax = hist.viewMax;
    var maxCount = 1;
    hist.bins.forEach(function (b) { if (b.count > maxCount) maxCount = b.count; });
    if (r.fit.ok) {
      // 拟合曲线的峰值计数（pdf × n × binWidth）也纳入 Y 范围
      var mean = r.fit.mean, s = r.fit.s;
      var peakPdf = 1 / (s * Math.sqrt(2 * Math.PI));
      maxCount = Math.max(maxCount, peakPdf * r.n * (hist.binWidth || (vMax - vMin) / 10));
    }
    var yMaxH = maxCount * 1.15;

    function xOf(v) { return left + plotW * ((v - vMin) / (vMax - vMin || 1)); }
    function yOf(c) { return bottom - (bottom - top) * (c / yMaxH); }

    var html = '';
    [0, yMaxH / 2, yMaxH].forEach(function (c) {
      html += '<line class="spc-grid" x1="' + left + '" y1="' + yOf(c).toFixed(1) + '" x2="' + right + '" y2="' + yOf(c).toFixed(1) + '"></line>';
      html += svgText(left - 6, yOf(c), fmt(c, 0), 'spc-tick', 'end');
    });

    hist.bins.forEach(function (b) {
      if (!b.count) return;
      var x0 = xOf(b.x0), x1 = xOf(b.x1);
      var w = Math.max(1, x1 - x0 - 1);
      html += '<rect class="spc-bar" x="' + x0.toFixed(1) + '" y="' + yOf(b.count).toFixed(1) +
        '" width="' + w.toFixed(1) + '" height="' + Math.max(1, bottom - yOf(b.count)).toFixed(1) + '"></rect>';
    });

    // 规格界限
    var specLabels = [];
    if (r.spec.ok) {
      html += '<line class="spc-line spc-line--spec" x1="' + xOf(r.spec.lsl).toFixed(1) + '" y1="' + top + '" x2="' + xOf(r.spec.lsl).toFixed(1) + '" y2="' + bottom + '"></line>';
      html += '<line class="spc-line spc-line--spec" x1="' + xOf(r.spec.usl).toFixed(1) + '" y1="' + top + '" x2="' + xOf(r.spec.usl).toFixed(1) + '" y2="' + bottom + '"></line>';
      specLabels.push({ y: top + 12, x: xOf(r.spec.lsl), text: 'LSL ' + fmtSmart(r.spec.lsl), cls: 'spc-label spc-label--spec', anchor: 'middle' });
      specLabels.push({ y: top + 12, x: xOf(r.spec.usl), text: 'USL ' + fmtSmart(r.spec.usl), cls: 'spc-label spc-label--spec', anchor: 'middle' });
    }
    // 均值线
    if (isFinite(hist.dataMin)) {
      html += '<line class="spc-line spc-line--mean" x1="' + xOf(r.stats.mean).toFixed(1) + '" y1="' + top + '" x2="' + xOf(r.stats.mean).toFixed(1) + '" y2="' + bottom + '"></line>';
    }
    // 正态拟合曲线（明确标注为模型）
    if (r.fit.ok) {
      var N = 80;
      var px0 = hist.dataMin - (hist.dataMax - hist.dataMin) * 0.06;
      var px1 = hist.dataMax + (hist.dataMax - hist.dataMin) * 0.06;
      var path = '';
      for (var g = 0; g <= N; g++) {
        var xv = px0 + (px1 - px0) * (g / N);
        var z = (xv - r.fit.mean) / r.fit.s;
        var pdf = Math.exp(-0.5 * z * z) / (r.fit.s * Math.sqrt(2 * Math.PI));
        var cnt = pdf * r.n * (hist.binWidth || (hist.dataMax - hist.dataMin) / 10);
        path += (g ? 'L' : 'M') + xOf(xv).toFixed(1) + ' ' + yOf(cnt).toFixed(1);
      }
      html += '<path class="spc-fit" d="' + path + '"></path>';
    }

    specLabels.forEach(function (l) {
      html += svgText(l.x, l.y, l.text, l.cls, l.anchor);
    });
    html += svgText(left, HIST_H - 10, fmtSmart(vMin), 'spc-tick', 'start');
    html += svgText(right, HIST_H - 10, fmtSmart(vMax), 'spc-tick', 'end');
    svg.innerHTML = axisFrame(html);
    svg.setAttribute('aria-label', '测量值直方图，' + hist.k + ' 个分箱，样本均值 ' + fmtSmart(r.stats.mean) +
      (r.spec.ok ? '，规格下限 ' + fmtSmart(r.spec.lsl) + '，规格上限 ' + fmtSmart(r.spec.usl) : ''));

    legend.innerHTML = [
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--bar"></span>实测频数</span>',
      r.fit.ok ? '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--fit"></span>正态拟合（模型假设，非实测分布）</span>' : '',
      '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--mean"></span>样本均值</span>',
      r.spec.ok ? '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--spec"></span>规格界限</span>' : ''
    ].filter(Boolean).join('');

    note.textContent = '直方图只描述当前样本；叠加的正态曲线是在「均值为样本均值、σ 为样本标准差 s」假设下的模型，' +
      '不表示过程真的服从正态分布，也不是对未来不良率的可靠预测。';

    var rows = [
      ['实测规格外数量', r.outOfSpec.count === null ? '不适用（规格无效）' : r.outOfSpec.count + ' / ' + r.n],
      ['实测规格外比例', r.outOfSpec.ratio === null ? '不适用' : pctOrDash(r.outOfSpec.ratio, 3)],
      ['正态拟合理论 PPM（模型估计）', r.fit.ok && r.spec.ok ? ppmText(r.fit.ppmTotal) : '不适用']
    ];
    facts.innerHTML = rows.map(function (row) {
      return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
    }).join('');
  }

  // ---------------------------------------------------------------- 能力与异常

  function capCell(v, status, digits) {
    if (v === null || v === undefined) {
      var map = {
        'no-spec': '规格无效',
        'insufficient-samples': '样本不足',
        'zero-within-variation': 'σ_within=0，不适用',
        'zero-variation': 's=0，不适用',
        'not-applicable-theoretical': '理论模式不适用',
        'ok': '–'
      };
      return '<span class="spc-na">' + (map[status] || '不适用') + '</span>';
    }
    return '<strong>' + fmt(v, digits === undefined ? 3 : digits) + '</strong>';
  }

  function renderCapability(root, r) {
    var cap = r.capability;
    var body = root.querySelector('#spcCapBody');
    if (!body) return;
    var b = r.mode === 'theoretical' ? '理论参数（σ 由用户输入）' : (cap.basis === 'baseline' ? '冻结基线段' : '当前全部样本');
    var rows = [
      ['Cp', cap.cp, cap.status.cp, '(USL − LSL) / (6σ_within)', '短期'],
      ['Cpu', cap.cpu, cap.status.cpu, '(USL − mean) / (3σ_within)', '短期'],
      ['Cpl', cap.cpl, cap.status.cpl, '(mean − LSL) / (3σ_within)', '短期'],
      ['Cpk', cap.cpk, cap.status.cpk, 'min(Cpu, Cpl)，负值保留不截断', '短期'],
      ['Pp', cap.pp, cap.status.pp, '(USL − LSL) / (6s)', '整体'],
      ['Ppk', cap.ppk, cap.status.ppk, 'min((USL−mean)/(3s), (mean−LSL)/(3s))', '整体']
    ];
    body.innerHTML = rows.map(function (row) {
      return '<tr><th scope="row">' + row[0] + '</th><td>' + capCell(row[1], row[2]) +
        '</td><td>' + esc(row[3]) + '</td><td>' + row[4] + '</td></tr>';
    }).join('');

    var note = root.querySelector('#spcCapNote');
    if (r.mode === 'theoretical') {
      note.textContent = '理论参数模式：mean = ' + fmtSmart(r.mean) + '，σ = ' + fmtSmart(r.sd) +
        '（你输入的总体参数）。这里没有实测样本，Pp/Ppk 与实测超规比例均不适用。';
    } else {
      var st = r.stats;
      note.textContent = 'σ_within = ' + fmtSmart(r.limits.sigmaWithin) + '（' +
        (r.limits.frozen ? '冻结基线' : '全部样本') + '平均移动极差 ÷ 1.128）；s = ' + fmtSmart(st.s) +
        '（样本标准差，n−1）。能力指数基于' + b + '计算；' +
        (r.limits.frozen
          ? '监测段（第 ' + (r.baseline.end + 1) + ' 个样本起）不参与能力估计，其偏移请见控制图与异常列表。'
          : '过程尚未验证稳定，能力指数只能作为当前样本的描述。') +
        (r.monitoring ? ' 监测段 ' + r.monitoring.count + ' 个样本相对基线均值偏移 ' +
          fmtSmart(r.monitoring.meanShift) + unitOf(r) + '。' : '');
    }

    root.querySelector('#spcCapThreshold').textContent =
      '1.33 与 1.67 是常见的参考门槛（例如部分行业把 1.33 视作最低可接受、1.67 视作较高要求），' +
      '并非所有行业或客户都采用同一验收标准；高 Cpk 也不能证明过程受控或产品合格——' +
      '它是相对于规格宽度的波动描述，不包含过程稳定性判断。';
  }

  function renderViolations(root, r) {
    var list = root.querySelector('#spcViolList');
    if (!list) return;
    var rules = SC().RULES;
    var order = ['i-beyond-limits', 'i-run-same-side', 'i-trend', 'mr-beyond-limits'];
    if (r.mode === 'theoretical') {
      list.innerHTML = '<li class="spc-violation spc-violation--none">理论参数模式没有实测样本，不做异常检测。</li>';
      return;
    }
    var html = '';
    order.forEach(function (rid) {
      var hit = null;
      for (var i = 0; i < r.violations.length; i++) if (r.violations[i].rule === rid) hit = r.violations[i];
      var def = rules[rid];
      if (!hit) {
        html += '<li class="spc-violation spc-violation--none"><strong>' + esc(def.name) + '</strong>' +
          '<span class="spc-violation-count">未命中</span>' +
          '<p class="spc-violation-def">' + esc(def.definition) + '</p></li>';
        return;
      }
      var shown = hit.indexes.slice(0, MAX_LABEL_ITEMS).map(function (i) { return '第 ' + i + ' 个'; }).join('、');
      if (hit.indexes.length > MAX_LABEL_ITEMS) shown += ' … 共 ' + hit.indexes.length + ' 个';
      html += '<li class="spc-violation spc-violation--hit"><strong>' + esc(def.name) + '</strong>' +
        '<span class="spc-violation-count">命中 ' + hit.indexes.length + ' 个</span>' +
        '<p class="spc-violation-def">' + esc(def.definition) + '</p>' +
        '<p class="spc-violation-where">位置：' + esc(shown) + '</p></li>';
    });
    list.innerHTML = html;
  }

  function renderStats(root, r, parsed) {
    var body = root.querySelector('#spcStatsBody');
    if (!body) return;
    if (r.mode === 'theoretical') {
      body.innerHTML = [
        ['样本数量', '不适用（理论参数模式）'],
        ['过程均值 μ', fmtSmart(r.mean) + unitOf(r)],
        ['过程标准差 σ', fmtSmart(r.sd) + unitOf(r)],
        ['规格下限 LSL', r.spec.lsl === null ? '–' : fmtSmart(r.spec.lsl) + unitOf(r)],
        ['规格上限 USL', r.spec.usl === null ? '–' : fmtSmart(r.spec.usl) + unitOf(r)]
      ].map(function (row) {
        return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
      }).join('');
      return;
    }
    var st = r.stats;
    var rows = [
      ['样本数量 n', st.n + ' 个（原始顺序保留）'],
      ['均值', fmtSmart(st.mean) + unitOf(r)],
      ['中位数', fmtSmart(st.median) + unitOf(r)],
      ['最小值 / 最大值', fmtSmart(st.min) + ' / ' + fmtSmart(st.max) + unitOf(r)],
      ['极差 (max − min)', fmtSmart(st.range) + unitOf(r)],
      ['样本标准差 s（n−1）', st.s === null ? '样本不足' : (st.s === 0 ? '0（未观测到波动）' : fmtSmart(st.s) + unitOf(r))],
      ['平均移动极差', st.mr.mean === null ? '样本不足' : fmtSmart(st.mr.mean) + unitOf(r)],
      ['短期波动 σ_within', r.limits.sigmaWithin === null ? '样本不足'
        : (r.limits.sigmaWithin === 0 ? '0（未观测到短期波动）' : fmtSmart(r.limits.sigmaWithin) + unitOf(r))],
      ['实测规格外数量', r.outOfSpec.count === null ? '不适用（规格无效）' : r.outOfSpec.count + ' / ' + st.n],
      ['实测规格外比例', r.outOfSpec.ratio === null ? '不适用' : pctOrDash(r.outOfSpec.ratio, 3)],
      ['重复数值', (parsed && parsed.duplicateCount ? parsed.duplicateCount : 0) + ' 个（保留，不去重）']
    ];
    body.innerHTML = rows.map(function (row) {
      return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
    }).join('');
  }

  // ---------------------------------------------------------------- mount

  function mount(root) {
    if (!root || !SC()) return null;
    var state = {
      mode: 'measured',
      text: '',
      values: [],
      parsed: null,
      spec: { lsl: SC().DEFAULTS.lsl, usl: SC().DEFAULTS.usl, target: SC().DEFAULTS.target, unit: SC().DEFAULTS.unit },
      theory: { mean: SC().DEFAULTS.mean, sd: SC().DEFAULTS.sd },
      baselineRange: null,
      result: null,
      error: '',
      computeCount: 0,
      chart: { drawn: 0, total: 0 }
    };
    var timer = 0;
    var listeners = [];
    var destroyed = false;

    function $(id) { return root.querySelector('#' + id); }
    function setLive(msg) {
      var el = $('spcLive');
      if (el) el.textContent = msg;
    }
    function setError(msg) {
      state.error = msg || '';
      var el = $('spcError');
      if (el) el.textContent = state.error;
    }

    function readNumber(id) {
      var el = $(id);
      if (!el) return null;
      var raw = String(el.value).trim();
      if (raw === '') return null;
      var v = Number(raw);
      return isFinite(v) ? v : NaN;
    }

    function readSpec() {
      var lsl = readNumber('spcLsl');
      var usl = readNumber('spcUsl');
      var target = readNumber('spcTarget');
      var unitEl = $('spcUnit');
      return {
        lsl: lsl === null ? null : lsl,
        usl: usl === null ? null : usl,
        target: target === null ? null : target,
        unit: unitEl ? String(unitEl.value || '').slice(0, 12) : ''
      };
    }

    function readBaseline() {
      var s = readNumber('spcBaselineStart');
      var e = readNumber('spcBaselineEnd');
      if (s === null || e === null) return state.baselineRange;
      if (!isFinite(s) || !isFinite(e)) return state.baselineRange;
      return { start: s, end: e };
    }

    /** 解析并计算；任何失败都清空结果，绝不用旧结果冒充新输入。 */
    function runCompute() {
      timer = 0;
      if (destroyed) return;
      var r;
      if (state.mode === 'theoretical') {
        state.spec = readSpec();
        var mean = readNumber('spcMean');
        var sd = readNumber('spcSd');
        state.theory = { mean: mean, sd: sd };
        r = SC().computeTheoretical({
          mean: mean === null ? NaN : mean,
          sd: sd === null ? NaN : sd,
          lsl: state.spec.lsl, usl: state.spec.usl,
          target: state.spec.target, unit: state.spec.unit
        });
      } else {
        state.spec = readSpec();
        var parsed = SC().parseMeasurements($('spcData').value);
        if (!parsed.ok) {
          state.parsed = parsed;
          state.values = [];
          state.result = null;
          state.chart = { drawn: 0, total: 0 };
          setError(parsed.message);
          renderEmpty('当前输入未通过校验，未进行任何计算。');
          $('spcWarnings').innerHTML = '';
          setLive('输入非法：' + parsed.message);
          return;
        }
        state.parsed = parsed;
        state.values = parsed.values;
        r = SC().computeMeasured({
          values: parsed.values,
          spec: state.spec,
          baseline: state.baselineRange
        });
        if (!r.ok) {
          state.result = null;
          setError(r.message);
          renderEmpty('计算未完成。');
          return;
        }
      }

      if (!r.ok) {
        state.result = null;
        setError(r.message);
        renderEmpty('计算未完成。');
        return;
      }
      setError('');
      state.result = r;
      state.computeCount++;
      render(r);
    }

    function schedule() {
      if (timer) return;
      timer = global.setTimeout(runCompute, DEBOUNCE_MS);
    }

    function renderEmpty(message) {
      $('spcStatsBody').innerHTML = '<dt>状态</dt><dd>' + esc(message) + '</dd>';
      ['spcChartI', 'spcChartMR', 'spcChartHist'].forEach(function (id) {
        var svg = $(id);
        if (svg) { svg.innerHTML = ''; svg.setAttribute('hidden', ''); }
      });
      ['spcLegendI', 'spcLegendMR', 'spcLegendHist'].forEach(function (id) {
        var el = $(id);
        if (el) el.innerHTML = '';
      });
      ['spcNoteI', 'spcNoteMR', 'spcNoteHist'].forEach(function (id) {
        var el = $(id);
        if (el) { el.hidden = false; el.textContent = message; }
      });
      root.querySelector('tbody.spc-limit-body[data-chart="i"]').innerHTML = '';
      root.querySelector('tbody.spc-limit-body[data-chart="mr"]').innerHTML = '';
      $('spcDistFacts').innerHTML = '';
      $('spcCapBody').innerHTML = '<tr><td colspan="4" class="spc-na">' + esc(message) + '</td></tr>';
      $('spcCapNote').textContent = '';
      $('spcViolList').innerHTML = '<li class="spc-violation spc-violation--none">' + esc(message) + '</li>';
    }

    function render(r) {
      $('spcModeLabel').textContent = r.mode === 'theoretical' ? '理论参数实验' : '实测数据分析';
      $('spcModeHint').textContent = r.mode === 'theoretical'
        ? '（μ、σ 由你输入；不是样本估计）'
        : '（全部计算在本机完成，不上传数据）';

      var warnEl = $('spcWarnings');
      var msgs = [];
      if (r.mode === 'measured' && state.parsed) {
        msgs = msgs.concat(state.parsed.warnings || []);
        if (state.parsed.duplicateCount > 0) {
          msgs.push('样本量 ' + state.parsed.count + ' 个，其中重复值 ' + state.parsed.duplicateCount +
            ' 个——重复测量按独立样本保留，未做合并或删除。');
        }
      }
      msgs = msgs.concat(r.warnings || []);
      warnEl.innerHTML = msgs.map(function (m) {
        return '<li>' + esc(m) + '</li>';
      }).join('');

      var theoretical = r.mode === 'theoretical';
      $('spcStatsCard').hidden = false;
      $('spcICard').hidden = theoretical;
      $('spcMrCard').hidden = theoretical;
      $('spcHistCard').hidden = theoretical;
      $('spcViolCard').hidden = theoretical;
      $('spcTheoryCard').hidden = !theoretical;
      $('spcBaselineField').hidden = theoretical;
      $('spcMeasuredFields').hidden = theoretical;
      $('spcTheoryFields').hidden = !theoretical;

      renderStats(root, r, state.parsed);
      renderCapability(root, r);
      renderViolations(root, r);

      if (theoretical) {
        // 理论模式只画分布（正态密度），与控制图无关
        renderTheoryChart(r);
        state.chart = { drawn: 0, total: 0 };
      } else {
        renderChartI($('spcChartI'), $('spcNoteI'), $('spcLegendI'), r);
        renderChartMR($('spcChartMR'), $('spcNoteMR'), $('spcLegendMR'), r);
        renderHistogram($('spcChartHist'), $('spcNoteHist'), $('spcLegendHist'), r, $('spcDistFacts'));
        state.chart = { drawn: r.chartSample.drawn, total: r.chartSample.total };
        renderBaselineState(r);
      }
      setLive('已重新计算：' + (theoretical
        ? '理论模式，Cpk ' + fmt(r.capability.cpk, 3)
        : '实测 ' + r.n + ' 个样本，命中 ' + countHits(r) + ' 条规则'));
    }

    function countHits(r) {
      var n = 0;
      (r.violations || []).forEach(function (v) { n++; });
      return n;
    }

    function renderBaselineState(r) {
      var el = $('spcBaselineState');
      if (!el) return;
      if (!r.baseline) {
        el.textContent = '未建立基准：控制界限由当前全部 ' + r.n + ' 个样本估计。';
        return;
      }
      el.textContent = '已冻结基线：第 ' + r.baseline.start + '–' + r.baseline.end + ' 个样本（' +
        r.baseline.count + ' 个），基准均值 ' + fmtSmart(r.baseline.mean) + '，σ_within ' +
        fmtSmart(r.baseline.sigmaWithin) + '。控制界限固定，后续 ' +
        (r.monitoring ? r.monitoring.count : 0) + ' 个样本按固定界限监测。';
    }

    // 理论模式分布图：复用直方图画布，绘制正态密度曲线 + 规格线（无样本）
    function renderTheoryChart(r) {
      var svg = $('spcChartHist');
      var note = $('spcNoteHist');
      var legend = $('spcLegendHist');
      if (!svg) return;
      svg.removeAttribute('hidden');
      var spec = r.spec;
      var lo = spec.ok ? spec.lsl : r.mean - 4 * r.sd;
      var hi = spec.ok ? spec.usl : r.mean + 4 * r.sd;
      var span = Math.max(hi - lo, 1e-9);
      var vMin = Math.min(lo, r.mean - 3.6 * r.sd) - span * 0.02;
      var vMax = Math.max(hi, r.mean + 3.6 * r.sd) + span * 0.02;
      var top = PAD.top, bottom = HIST_H - PAD.bottom;
      var left = PAD.left, right = CW - PAD.right;
      var plotW = right - left;
      var peak = 1 / (r.sd * Math.sqrt(2 * Math.PI));
      var yMax = peak * 1.1;
      function xOf(v) { return left + plotW * ((v - vMin) / (vMax - vMin || 1)); }
      function yOf(d) { return bottom - (bottom - top) * (d / yMax); }

      var html = '';
      [0, yMax / 2, yMax].forEach(function (d) {
        html += '<line class="spc-grid" x1="' + left + '" y1="' + yOf(d).toFixed(1) + '" x2="' + right + '" y2="' + yOf(d).toFixed(1) + '"></line>';
        html += svgText(left - 6, yOf(d), d.toExponential(1), 'spc-tick', 'end');
      });
      var path = '';
      for (var g = 0; g <= 100; g++) {
        var xv = vMin + (vMax - vMin) * (g / 100);
        var z = (xv - r.mean) / r.sd;
        var pdf = Math.exp(-0.5 * z * z) / (r.sd * Math.sqrt(2 * Math.PI));
        path += (g ? 'L' : 'M') + xOf(xv).toFixed(1) + ' ' + yOf(pdf).toFixed(1);
      }
      html += '<path class="spc-fit" d="' + path + '"></path>';
      html += '<line class="spc-line spc-line--mean" x1="' + xOf(r.mean).toFixed(1) + '" y1="' + top + '" x2="' + xOf(r.mean).toFixed(1) + '" y2="' + bottom + '"></line>';
      if (spec.ok) {
        html += '<line class="spc-line spc-line--spec" x1="' + xOf(spec.lsl).toFixed(1) + '" y1="' + top + '" x2="' + xOf(spec.lsl).toFixed(1) + '" y2="' + bottom + '"></line>';
        html += '<line class="spc-line spc-line--spec" x1="' + xOf(spec.usl).toFixed(1) + '" y1="' + top + '" x2="' + xOf(spec.usl).toFixed(1) + '" y2="' + bottom + '"></line>';
        html += svgText(xOf(spec.lsl), top + 12, 'LSL ' + fmtSmart(spec.lsl), 'spc-label spc-label--spec', 'middle');
        html += svgText(xOf(spec.usl), top + 12, 'USL ' + fmtSmart(spec.usl), 'spc-label spc-label--spec', 'middle');
      }
      html += svgText(left, HIST_H - 10, fmtSmart(vMin), 'spc-tick', 'start');
      html += svgText(right, HIST_H - 10, fmtSmart(vMax), 'spc-tick', 'end');
      svg.innerHTML = axisFrame(html);
      svg.setAttribute('aria-label', '理论正态分布曲线，均值 ' + fmtSmart(r.mean) + '，标准差 ' + fmtSmart(r.sd) +
        (spec.ok ? '，规格下限 ' + fmtSmart(spec.lsl) + '，规格上限 ' + fmtSmart(spec.usl) : ''));
      legend.innerHTML = '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--fit"></span>理论正态密度（假设，非实测）</span>' +
        '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--mean"></span>过程均值 μ</span>' +
        (spec.ok ? '<span class="spc-legend-item"><span class="spc-swatch spc-swatch--spec"></span>规格界限</span>' : '');
      note.textContent = '理论参数模式：曲线由你输入的 μ 与 σ 完全决定，没有样本、没有控制图；' +
        '理论 PPM = ' + (r.ppm ? ppmText(r.ppm.total) : '不适用') + '（模型估计，不是实测不良率）。';
      $('spcDistFacts').innerHTML = [
        ['理论不良率 PPM（模型估计）', r.ppm ? ppmText(r.ppm.total) : '不适用'],
        ['低于 LSL 的 PPM', r.ppm ? ppmText(r.ppm.below) : '不适用'],
        ['高于 USL 的 PPM', r.ppm ? ppmText(r.ppm.above) : '不适用']
      ].map(function (row) {
        return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
      }).join('');
    }

    // ------------------------------------------------------------ 事件

    function onModeChange() {
      var chosen = root.querySelector('input[name="spcMode"]:checked');
      state.mode = chosen ? chosen.value : 'measured';
      $('spcModeDesc').textContent = state.mode === 'measured'
        ? '粘贴单列测量值，按真实生产顺序计算控制图与能力指数。'
        : '输入过程均值与标准差（总体参数），观察规格变化对 Cp/Cpk 的影响；不使用任何样本估计。';
      $('spcModeLabel').textContent = state.mode === 'measured' ? '实测数据分析' : '理论参数实验';
      runCompute();
    }

    function onDataInput() {
      state.text = $('spcData').value;
      var ex = $('spcExample');
      if (ex && ex.value !== 'custom') {
        ex.value = 'custom';
        $('spcExampleNote').textContent = '自定义数据：当前内容为你粘贴/编辑的测量序列。';
      }
      schedule();
    }

    function onExampleChange() {
      var id = $('spcExample').value;
      if (id === 'custom') {
        $('spcExampleNote').textContent = '自定义数据：当前内容为你粘贴/编辑的测量序列。';
        return;
      }
      loadExample(id);
    }

    function loadExample(id) {
      var ex = SC().EXAMPLES.filter(function (e) { return e.id === id; })[0];
      if (!ex) return;
      var text = SC().exampleText(id);
      $('spcData').value = text;
      state.text = text;
      $('spcLsl').value = String(ex.spec.lsl);
      $('spcUsl').value = String(ex.spec.usl);
      $('spcTarget').value = String(ex.spec.target);
      $('spcUnit').value = ex.spec.unit;
      $('spcExample').value = id;
      $('spcExampleNote').textContent = ex.note;
      state.baselineRange = null;
      $('spcBaselineStart').value = '1';
      $('spcBaselineEnd').value = String(Math.min(20, SC().exampleValues(id).length));
      runCompute();
      setLive('已载入示例：' + ex.name);
    }

    function onReset() {
      loadExample('centered');
      state.baselineRange = null;
      $('spcBaselineState').textContent = '未建立基准：控制界限由当前全部样本估计。';
      runCompute();
    }

    function onFreeze() {
      var s = readNumber('spcBaselineStart');
      var e = readNumber('spcBaselineEnd');
      if (s === null || e === null || !isFinite(s) || !isFinite(e)) {
        setError('请填写基线起始与结束序号（整数），再用「建立/更新基准」。');
        return;
      }
      // 先在数学层验证，避免把非法区间写入状态
      var probe = SC().buildBaseline(state.values, s, e);
      if (!probe.ok) {
        setError(probe.message);
        return;
      }
      state.baselineRange = { start: s, end: e };
      setError('');
      runCompute();
      setLive('已冻结基线：第 ' + s + '–' + e + ' 个样本');
    }

    function onClearBaseline() {
      state.baselineRange = null;
      setError('');
      runCompute();
      setLive('已清除基线：控制界限回到全部样本估计');
    }

    function onSpecChange() {
      runCompute();
    }

    // 初始化输入值
    var def = SC().DEFAULTS;
    $('spcLsl').value = String(def.lsl);
    $('spcUsl').value = String(def.usl);
    $('spcTarget').value = String(def.target);
    $('spcUnit').value = def.unit;
    $('spcMean').value = String(def.mean);
    $('spcSd').value = String(def.sd);
    $('spcData').value = SC().exampleText(def.example);
    $('spcExample').value = def.example;
    $('spcExampleNote').textContent = SC().EXAMPLES[0].note;
    $('spcBaselineStart').value = '1';
    $('spcBaselineEnd').value = '20';
    $('spcModeDesc').textContent = '粘贴单列测量值，按真实生产顺序计算控制图与能力指数。';

    listeners.push([$('spcData'), 'input', onDataInput]);
    listeners.push([$('spcExample'), 'change', onExampleChange]);
    listeners.push([$('spcReset'), 'click', onReset]);
    listeners.push([$('spcFreeze'), 'click', onFreeze]);
    listeners.push([$('spcClearBaseline'), 'click', onClearBaseline]);
    ['spcLsl', 'spcUsl', 'spcTarget', 'spcUnit'].forEach(function (id) {
      listeners.push([$(id), 'change', onSpecChange]);
    });
    ['spcMean', 'spcSd'].forEach(function (id) {
      listeners.push([$(id), 'change', onSpecChange]);
    });
    listeners.push([$('spcModeMeasured'), 'change', onModeChange]);
    listeners.push([$('spcModeTheory'), 'change', onModeChange]);

    listeners.forEach(function (l) {
      if (l[0]) l[0].addEventListener(l[1], l[2]);
    });

    runCompute();

    var handle = {
      getState: function () { return snapshot(state); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        listeners.forEach(function (l) {
          if (l[0]) l[0].removeEventListener(l[1], l[2]);
        });
        if (timer) global.clearTimeout(timer);
      }
    };
    root.__spcHandle = handle;
    return handle;
  }

  // ---------------------------------------------------------------- 快照

  function snapshot(state) {
    var r = state.result;
    var base = {
      mode: state.mode,
      spec: { lsl: state.spec.lsl, usl: state.spec.usl, target: state.spec.target, unit: state.spec.unit },
      parseOk: state.mode === 'theoretical' ? null : !!(state.parsed && state.parsed.ok),
      parseError: state.mode !== 'theoretical' && state.parsed && !state.parsed.ok ? state.parsed.error : null,
      error: state.error,
      computeCount: state.computeCount,
      chartDrawn: state.chart.drawn,
      chartTotal: state.chart.total
    };
    if (!r || !r.ok) {
      return Object.assign(base, {
        sampleCount: state.values.length, duplicateCount: 0,
        mean: null, median: null, min: null, max: null, range: null,
        s: null, mrMean: null, sigmaWithin: null,
        limits: null, limitsFrozen: false, limitsBasis: null,
        violationCounts: null, violations: [],
        cp: null, cpu: null, cpl: null, cpk: null, pp: null, ppk: null,
        capStatus: null, capBasis: null, capFlags: [],
        outOfSpecCount: null, outOfSpecRatio: null,
        ppmFittedTotal: null, ppmTheoreticalTotal: null,
        baseline: null, monitoring: null,
        chartDrawn: 0, chartTotal: state.values.length
      });
    }
    if (r.mode === 'theoretical') {
      return Object.assign(base, {
        sampleCount: 0, duplicateCount: 0,
        mean: r.mean, median: null, min: null, max: null, range: null,
        s: r.sd, mrMean: null, sigmaWithin: null,
        limits: null, limitsFrozen: false, limitsBasis: null,
        violationCounts: null, violations: [],
        cp: r.capability.cp, cpu: r.capability.cpu, cpl: r.capability.cpl, cpk: r.capability.cpk,
        pp: r.capability.pp, ppk: r.capability.ppk,
        capStatus: r.capability.status, capBasis: 'theoretical', capFlags: r.capability.flags,
        outOfSpecCount: null, outOfSpecRatio: null,
        ppmFittedTotal: r.ppm ? r.ppm.total : null,
        ppmTheoreticalTotal: r.ppm ? r.ppm.total : null,
        baseline: null, monitoring: null
      });
    }
    return Object.assign(base, {
      sampleCount: r.n,
      duplicateCount: state.parsed ? state.parsed.duplicateCount : 0,
      mean: r.stats.mean,
      median: r.stats.median,
      min: r.stats.min,
      max: r.stats.max,
      range: r.stats.range,
      s: r.stats.s,
      mrMean: r.stats.mr.mean,
      sigmaWithin: r.limits.sigmaWithin,
      limits: {
        i: { cl: r.limits.i.cl, ucl: r.limits.i.ucl, lcl: r.limits.i.lcl },
        mr: { cl: r.limits.mr.cl, ucl: r.limits.mr.ucl, lcl: r.limits.mr.lcl }
      },
      limitsFrozen: !!r.limits.frozen,
      limitsBasis: r.limitsBasis,
      violationCounts: r.violationCounts,
      violations: r.violations.map(function (v) {
        return { rule: v.rule, name: v.name, indexes: v.indexes.slice(), count: v.count };
      }),
      cp: r.capability.cp,
      cpu: r.capability.cpu,
      cpl: r.capability.cpl,
      cpk: r.capability.cpk,
      pp: r.capability.pp,
      ppk: r.capability.ppk,
      capStatus: r.capability.status,
      capBasis: r.capability.basis,
      capFlags: r.capability.flags.slice(),
      outOfSpecCount: r.outOfSpec.count,
      outOfSpecRatio: r.outOfSpec.ratio,
      ppmFittedTotal: r.fit.ok ? r.fit.ppmTotal : null,
      ppmTheoreticalTotal: r.fit.ok ? r.fit.ppmTotal : null,
      baseline: r.baseline ? {
        start: r.baseline.start, end: r.baseline.end, count: r.baseline.count,
        mean: r.baseline.mean, sigmaWithin: r.baseline.sigmaWithin
      } : null,
      monitoring: r.monitoring,
      chartDrawn: state.chart.drawn,
      chartTotal: state.chart.total,
      flags: r.flags.slice()
    });
  }

  function getState(root) {
    return root && root.__spcHandle ? root.__spcHandle.getState() : null;
  }

  var api = {
    VERSION: 1,
    DEBOUNCE_MS: DEBOUNCE_MS,
    renderPage: renderPage,
    mount: mount,
    getState: getState
  };

  global.SpcDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
