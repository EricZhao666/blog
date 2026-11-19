'use strict';
// Batch 8E-4：跨浏览器测试公共辅助
//
// 目标：
//   - 明确选择目标引擎（chromium / firefox / webkit），每个引擎独立进程与独立 BrowserContext；
//   - 统一结果格式（PASS / FAIL / SKIP / BLOCKED），写 JSON 供矩阵汇总；
//   - 独立 artifact 目录，按引擎隔离；
//   - 不改动既有 64 套回归入口（本文件只被新入口引用）。
const path = require('path');
const fs = require('fs');
const pw = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PREFIX = '/blog';
const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'];
const REPORT_DIR = path.join(ROOT, 'tests', 'reports', 'b8e4');
const ARTIFACT_ROOT = path.join(ROOT, 'tests', 'browser', 'artifacts', 'b8e4');

function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const out = { engines: ENGINE_NAMES.slice(), scenario: null };
  args.forEach(function (a) {
    if (a.indexOf('--engines=') === 0) {
      out.engines = a.slice('--engines='.length).split(',').map(function (s) { return s.trim(); })
        .filter(Boolean);
    } else if (a.indexOf('--scenario=') === 0) {
      out.scenario = a.slice('--scenario='.length).trim();
    }
  });
  const bad = out.engines.filter(function (e) { return ENGINE_NAMES.indexOf(e) === -1; });
  if (bad.length) throw new Error('未知引擎: ' + bad.join(', ') + '（允许: ' + ENGINE_NAMES.join('/') + '）');
  if (!out.engines.length) throw new Error('至少需要一个引擎');
  return out;
}

// 只使用 Playwright 锁定版本自带的浏览器，不依赖系统安装的 Chrome/Safari。
async function launchEngine(name) {
  const type = pw[name];
  if (!type) throw new Error('Playwright 未提供引擎: ' + name);
  const browser = await type.launch({ headless: true });
  return { browser: browser, version: browser.version(), engine: name };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 结果记录器：每条 check 一行，结束时写 JSON；FAIL 自动存截图（仅失败场景，节省磁盘）。
function createReporter(specName, engine, browserVersion) {
  const started = Date.now();
  const checks = [];
  const outDir = ensureDir(path.join(ARTIFACT_ROOT, engine));
  const consoleLines = [];

  function log(line) {
    consoleLines.push(line);
    console.log(line);
  }

  function record(status, scenario, name, detail, extra) {
    checks.push({
      scenario: scenario,
      name: name,
      status: status,
      detail: detail === undefined ? '' : String(detail),
      ms: (extra && extra.ms) || 0
    });
    const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : status === 'BLOCKED' ? 'BLOCK' : 'FAIL';
    log(tag + ' [' + engine + '][' + scenario + '] ' + name +
      (detail === undefined || detail === '' ? '' : '  (' + detail + ')'));
  }

  return {
    engine: engine,
    outDir: outDir,
    log: log,
    pass: function (scenario, name, detail, extra) { record('PASS', scenario, name, detail, extra); },
    fail: function (scenario, name, detail, extra) { record('FAIL', scenario, name, detail, extra); },
    skip: function (scenario, name, reason) { record('SKIP', scenario, name, reason); },
    blocked: function (scenario, name, reason) { record('BLOCKED', scenario, name, reason); },
    check: function (scenario, name, cond, detail, extra) {
      if (cond) record('PASS', scenario, name, detail, extra);
      else record('FAIL', scenario, name, detail, extra);
      return !!cond;
    },
    screenshot: async function (page, label) {
      try {
        const file = path.join(outDir, 'fail-' + label.replace(/[^\w.-]+/g, '_') + '.png');
        await page.screenshot({ path: file, fullPage: false });
        return path.relative(ROOT, file);
      } catch (e) {
        return '';
      }
    },
    finish: function (status) {
      const totals = { pass: 0, fail: 0, skip: 0, blocked: 0 };
      checks.forEach(function (c) {
        if (c.status === 'PASS') totals.pass++;
        else if (c.status === 'FAIL') totals.fail++;
        else if (c.status === 'SKIP') totals.skip++;
        else totals.blocked++;
      });
      const payload = {
        spec: specName,
        engine: engine,
        playwright: require('playwright/package.json').version,
        browser_version: browserVersion || '',
        node: process.version,
        platform: process.platform,
        started_at: new Date(started).toISOString(),
        duration_ms: Date.now() - started,
        status: status,
        totals: totals,
        checks: checks
      };
      ensureDir(REPORT_DIR);
      const file = path.join(REPORT_DIR, specName + '-' + engine + '.json');
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      log('SUMMARY [' + engine + '] pass=' + totals.pass + ' fail=' + totals.fail +
        ' skip=' + totals.skip + ' blocked=' + totals.blocked +
        ' duration=' + (payload.duration_ms / 1000).toFixed(1) + 's json=' + path.relative(ROOT, file));
      return { totals: totals, file: file, durationMs: payload.duration_ms };
    }
  };
}

// 每个引擎独立入口的执行器：launch 失败记为 BLOCKED（环境），不伪造 PASS。
async function runEngines(opts) {
  const parsed = opts.args;
  const results = [];
  for (const engine of parsed.engines) {
    const reporter = createReporter(opts.specName, engine, '');
    let launched = null;
    try {
      launched = await launchEngine(engine);
    } catch (err) {
      reporter.blocked('ENV', '浏览器启动', (err && err.message) || String(err));
      results.push(reporter.finish('BLOCKED'));
      continue;
    }
    const withVersion = createReporter(opts.specName, engine, launched.version);
    withVersion.log('ENGINE [' + engine + '] version=' + launched.version +
      ' playwright=' + require('playwright/package.json').version + ' node=' + process.version);
    try {
      await opts.run({ browser: launched.browser, engine: engine, reporter: withVersion, outDir: withVersion.outDir });
    } catch (err) {
      withVersion.fail('RUNNER', '场景执行器异常', (err && err.stack ? err.stack.split('\n')[0] : String(err)));
    } finally {
      try { await launched.browser.close(); } catch (e) { /* 忽略关闭异常 */ }
    }
    const totals = withVersion.finish('DONE');
    // finish 已写 JSON；这里重写一次 status 以外的统计以保持单文件
    results.push(totals);
  }
  const agg = results.reduce(function (a, r) {
    a.pass += r.totals.pass; a.fail += r.totals.fail;
    a.skip += r.totals.skip; a.blocked += r.totals.blocked;
    return a;
  }, { pass: 0, fail: 0, skip: 0, blocked: 0 });
  console.log('TOTAL pass=' + agg.pass + ' fail=' + agg.fail + ' skip=' + agg.skip +
    ' blocked=' + agg.blocked + ' engines=' + parsed.engines.join(','));
  if (agg.fail > 0) return 1;
  if (agg.blocked > 0) return 2;
  return 0;
}

// 阻止第三方请求（giscus / CDN），让离线与超时判定只受本地服务器影响。
async function blockExternal(context) {
  await context.route('**/*', function (route) {
    const url = route.request().url();
    if (url.indexOf('http://127.0.0.1') === 0 || url.indexOf('data:') === 0 ||
      url.indexOf('blob:') === 0 || url.indexOf('about:') === 0) {
      return route.continue();
    }
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

module.exports = {
  ROOT: ROOT,
  PREFIX: PREFIX,
  ENGINE_NAMES: ENGINE_NAMES,
  REPORT_DIR: REPORT_DIR,
  ARTIFACT_ROOT: ARTIFACT_ROOT,
  parseArgs: parseArgs,
  launchEngine: launchEngine,
  createReporter: createReporter,
  runEngines: runEngines,
  blockExternal: blockExternal,
  ensureDir: ensureDir,
  sleep: sleep
};
