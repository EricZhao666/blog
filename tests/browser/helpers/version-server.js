// Batch 6B-1.1：合成"版本化站点"服务器（仅供 SW 正确性验证）
//
// 与 tests/browser/helpers/server.js 的区别：
//   - 由 fixtures/swsite 提供一套极小的合成站点，四个资源各自带版本标记（{{ver}}），
//     页面把"本页实际用到的 html/css/js/data 版本"汇总到 window.__versions，
//     因此"同页混版"可以被直接观测到；
//   - 支持全局 / 逐路径首字节延迟（模拟外壳快、data.js 慢的真实形状）；
//   - 支持逐路径故障注入（500 / 断流）；
//   - /blog/sw.js 直接读仓库里的真实 sw.js，可选用 CACHE_VERSION 改写模拟发布新 SW。
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * @param {object} opts
 * @param {string} opts.siteDir 合成站点目录
 * @param {string} opts.swPath  真实 sw.js 路径
 * @param {string} [opts.prefix]
 */
function createVersionServer(opts) {
  const siteDir = opts.siteDir;
  const swPath = opts.swPath;
  const prefix = opts.prefix || '/blog';

  const state = {
    version: 1,          // 资源版本：替换文件里的 {{ver}}
    swTag: null,         // 非空时给 CACHE_VERSION 追加 '-<tag>'，模拟发布新 SW
    latencyMs: 0,        // 全局首字节延迟（sw.js 除外，避免拖慢更新检查）
    pathLatency: {},     // 逐路径覆盖，如 { '/js/data.js': 2000 }
    faults: {},          // 逐路径故障：500 | 'abort'
    hits: {},            // 逐路径命中次数
    bytes: {}            // 逐路径响应体字节
  };

  function latencyFor(rel) {
    return Object.prototype.hasOwnProperty.call(state.pathLatency, rel)
      ? state.pathLatency[rel]
      : state.latencyMs;
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.indexOf(prefix) !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('outside scope');
    }
    let rel = urlPath.slice(prefix.length) || '/';
    if (rel === '') rel = '/';
    if (rel.endsWith('/')) rel += 'index.html';

    state.hits[rel] = (state.hits[rel] || 0) + 1;

    // 故障也遵守延迟：慢链路下的 5xx 应该是"很晚才失败"，而不是瞬间失败
    const fault = state.faults[rel];
    const faultDelay = rel === '/sw.js' ? 0 : latencyFor(rel);
    if (fault === 'abort') {
      if (faultDelay) setTimeout(() => req.destroy(), faultDelay);
      else req.destroy();
      return;
    }
    if (typeof fault === 'number') {
      const sendFault = () => {
        res.writeHead(fault, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('injected ' + fault);
      };
      if (faultDelay) setTimeout(sendFault, faultDelay); else sendFault();
      return;
    }

    let body;
    if (rel === '/sw.js') {
      if (!fs.existsSync(swPath)) {
        res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('sw.js not found: ' + swPath);
      }
      body = fs.readFileSync(swPath);
      if (state.swTag) {
        body = Buffer.from(body.toString('utf8')
          .replace(/CACHE_VERSION = '([^']+)'/, "CACHE_VERSION = '$1-" + state.swTag + "'"));
      }
    } else {
      const file = path.join(siteDir, rel.replace(/^\//, ''));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('not found');
      }
      const raw = fs.readFileSync(file, 'utf8');
      body = Buffer.from(raw.split('{{ver}}').join(String(state.version)), 'utf8');
    }

    state.bytes[rel] = (state.bytes[rel] || 0) + body.length;
    const send = () => {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
        // 关掉浏览器 HTTP 缓存，保证观测到的是 SW 行为而不是磁盘缓存
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      });
      res.end(body);
    };
    const delay = rel === '/sw.js' ? 0 : latencyFor(rel);
    if (delay) setTimeout(send, delay); else send();
  });

  return { server, state };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

module.exports = { createVersionServer, listen };
