// 本地静态服务器：把仓库挂在 /blog/ 子路径下，模拟 GitHub Pages 部署形态，
// 并支持按路径注入故障（改写状态码 / 断流 / 延迟 / 内容版本）。
// 说明：Service Worker 发起的请求不经过 Playwright 的 page.route，
//      所以故障注入必须在真实 HTTP 层完成。
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function createServer(rootDir, prefix) {
  prefix = prefix || '/blog';
  const state = {
    version: 1,          // v2 时给 app.js 追加标记，模拟发布更新
    faults: {},          // '/blog/js/app.js': 500 | 'abort'
    delays: {},          // '/blog/index.html': 1500
    hits: {}             // 每个路径被请求次数（含 SW 发起的）
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (!urlPath.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('outside scope');
    }
    let rel = urlPath.slice(prefix.length) || '/';
    if (rel === '') rel = '/';
    if (rel.endsWith('/')) rel += 'index.html';
    const key = rel;
    state.hits[key] = (state.hits[key] || 0) + 1;

    const fault = state.faults[key];
    if (fault === 'abort') {
      req.destroy();
      return;
    }
    if (typeof fault === 'number') {
      res.writeHead(fault, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('injected ' + fault);
    }

    // 合成资源：用于验证运行期缓存容量淘汰，无需真实文件
    const gen = /^\/gen\/(\d+)\.txt$/.exec(rel);
    if (gen) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('gen-' + gen[1]);
    }

    const file = path.join(rootDir, rel.replace(/^\//, ''));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }

    let body = fs.readFileSync(file);
    // 模拟发布：只改 app.js 的内容，用于验证 network-first 能拿到新版本
    if (rel === '/js/app.js' && state.version >= 2) {
      body = Buffer.concat([body, Buffer.from('\n// build:v' + state.version + '\n')]);
    }

    const delay = state.delays[key] || 0;
    const send = () => {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // 关掉浏览器 HTTP 缓存，避免干扰 network-first 的观测
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      });
      res.end(body);
    };
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

module.exports = { createServer, listen };
