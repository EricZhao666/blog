// Batch 6C：可切换站点的静态服务器（模拟"部署新版本"）
//
// 同一 origin 下先服务旧站点目录，测试中途把 state.active 切到新站点目录，
// 浏览器看到的是同一个 URL、不同字节的 sw.js / html / js —— 这正是真实发布时的形态。
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

/**
 * @param {object} opts
 * @param {string[]} opts.roots 站点根目录列表（0 = 旧版，1 = 新版…）
 * @param {string} [opts.prefix]
 */
function createSwitchServer(opts) {
  const roots = opts.roots;
  const prefix = opts.prefix || '/blog';
  const state = {
    active: 0,
    faults: {},     // 路径 → 状态码
    delay: {},      // 路径 → 毫秒
    hits: {},       // 路径 → 命中次数
    served: {},     // 路径 → 最近一次响应来自哪个站点下标
    override: {}    // 路径 → 指定站点下标（模拟"新旧资源混部"）
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.indexOf(prefix) !== 0) { res.writeHead(404); return res.end('outside scope'); }
    let rel = urlPath.slice(prefix.length) || '/';
    if (rel === '') rel = '/';
    if (rel.endsWith('/')) rel += 'index.html';

    state.hits[rel] = (state.hits[rel] || 0) + 1;
    const site = Object.prototype.hasOwnProperty.call(state.override, rel) ? state.override[rel] : state.active;
    state.served[rel] = site;

    const fault = state.faults[rel];
    if (fault) {
      res.writeHead(fault, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('injected ' + fault);
    }

    const root = roots[site];
    const file = path.join(root, rel.replace(/^\//, ''));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    const body = fs.readFileSync(file);
    const send = () => {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      });
      res.end(body);
    };
    const delay = state.delay[rel] || 0;
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

module.exports = { createSwitchServer, listen };
