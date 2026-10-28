// Batch 6B：HTTP 层观测探针（只观测，不改变响应语义）
//
// 为什么需要它：
//   1) 经 SW 返回的响应在页面 Resource Timing 里 transferSize = 0，页面侧看不到
//      「SW 后台预取/后台校验」实际拉了多少字节；只有在 HTTP 层才能逐请求记账。
//   2) 6B 要比较多个 SW 候选策略，必须能在不修改仓库 sw.js 的前提下，把
//      /blog/sw.js 的响应替换成候选文件（独立测试副本）。
//
// 设计：
//   - 纯转发：不改 status / headers / body（除显式 override 的路径外），不做限速。
//   - 逐请求记录：路径、开始/结束时刻（相对探针启动，毫秒）、状态码、响应体字节数。
//   - 字节数只统计响应体（不含响应头）；本站静态资源不经压缩，等于文件字节数。
//   - 反向用法：移动端整形代理在下游（浏览器 ↔ 整形 ↔ 本探针 ↔ 静态服务器），
//     因此探针看到的是整形之后真正从服务器取到的字节，不会漏记 SW 发起的请求。
const http = require('http');

/**
 * @param {object} opts
 * @param {number} opts.targetPort 上游静态服务器端口
 * @param {string} [opts.targetHost]
 * @param {Object<string, {body: Buffer|string, headers?: object}>} [opts.overrides]
 *        按路径替换响应（用于注入候选 Service Worker）
 */
function createProbe(opts) {
  const targetHost = opts.targetHost || '127.0.0.1';
  const targetPort = opts.targetPort;
  const overrides = opts.overrides || {};
  const t0 = Date.now();

  // 允许在测量过程中切换候选文件（例如逐个候选 SW 注入），无需重启服务器
  function setOverride(path, body, headers) {
    overrides[path] = { body: body, headers: headers || {} };
  }

  const state = {
    requests: 0,
    bytes: 0,
    records: []      // 每次请求一条
  };

  const now = () => Date.now() - t0;

  const server = http.createServer((clientReq, clientRes) => {
    const path = decodeURIComponent(clientReq.url.split('?')[0]);
    const rec = { path: path, method: clientReq.method, start: now(), end: null, status: null, bytes: 0, overridden: false };
    state.requests++;
    state.records.push(rec);

    const ov = overrides[path];
    if (ov) {
      // bodyFn 允许按请求动态生成（例如跟随测试服务器的版本改写模拟发布新 SW）
      const raw = typeof ov.bodyFn === 'function' ? ov.bodyFn() : ov.body;
      const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      rec.overridden = true;
      rec.status = 200;
      rec.bytes = body.length;
      state.bytes += body.length;
      // 候选 SW 必须不被浏览器 HTTP 缓存复用，否则下一轮会拿到旧脚本
      clientRes.writeHead(200, Object.assign({
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      }, ov.headers || {}));
      rec.end = now();
      return clientRes.end(body);
    }

    const up = http.request({
      host: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: Object.assign({}, clientReq.headers, { connection: 'close' }),
      agent: false
    }, (upRes) => {
      rec.status = upRes.statusCode;
      try {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
      } catch (e) {
        clientRes.destroy();
        return;
      }
      upRes.on('data', (chunk) => {
        rec.bytes += chunk.length;
        state.bytes += chunk.length;
      });
      upRes.on('end', () => { rec.end = now(); });
      upRes.pipe(clientRes);
      upRes.on('error', () => clientRes.destroy());
    });
    up.on('error', () => {
      rec.status = 502;
      rec.end = now();
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      clientRes.end('probe upstream error');
    });
    clientReq.pipe(up);
  });

  return {
    server,
    state,
    setOverride,
    // 从某个时刻（相对探针 t0）开始的记录快照，供单轮测量做增量统计
    since(mark) {
      return state.records.filter(r => r.start >= mark);
    },
    mark() {
      return now();
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

module.exports = { createProbe, listen };
