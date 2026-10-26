// 测试侧下行网络整形代理（仅供性能基线使用）
//
// 为什么不用 CDP 限速：
//   实测（Chrome 156）`Network.emulateNetworkConditions` 只在页面 target 上生效，
//   而本站同源请求全部经 Service Worker 转发，SW 发起的 fetch 不受页面级限速影响
//   （实测 1.6Mbps 限速下 114KB 的 data.js 仍在 20ms 内完成）。
//   因此移动端网络条件改为在 HTTP 层整形：所有请求（含 SW 发起的）统一经过本代理。
//
// 代理只做字节转发 + 节奏控制，不修改响应内容与响应头，
// 上游仍然是 tests/browser/helpers/server.js 提供的固定测试服务器。
const http = require('http');

/**
 * @param {object} opts
 * @param {number} opts.targetPort     上游静态服务器端口
 * @param {number} [opts.latencyMs]    每次响应首字节延迟（近似 1×RTT）
 * @param {number} [opts.downloadKbps] 全局下行带宽上限（kbps），0/未设置表示不限速
 * @param {string} [opts.targetHost]
 */
function createShapingProxy(opts) {
  const targetHost = opts.targetHost || '127.0.0.1';
  const targetPort = opts.targetPort;
  const latencyMs = opts.latencyMs || 0;
  const downloadKbps = opts.downloadKbps || 0;
  const bytesPerSec = downloadKbps > 0 ? (downloadKbps * 1024) / 8 : 0;

  // 全局虚拟放行时刻：所有响应共享同一条下行链路
  let allowAt = 0;
  const stats = { requests: 0, bytes: 0 };

  function scheduleWrite(res, buf, first) {
    const now = Date.now();
    const start = Math.max(now, allowAt) + (first ? latencyMs : 0);
    const cost = bytesPerSec ? (buf.length / bytesPerSec) * 1000 : 0;
    allowAt = start + cost;
    stats.bytes += buf.length;
    const delay = Math.max(0, start - now);
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(buf);
    }, delay);
    return allowAt;
  }

  const server = http.createServer((clientReq, clientRes) => {
    stats.requests++;
    let lastReleaseAt = 0;
    const up = http.request({
      host: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: Object.assign({}, clientReq.headers, { connection: 'close' }),
      agent: false
    }, (upRes) => {
      try {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
      } catch (e) {
        clientRes.destroy();
        return;
      }
      let first = true;
      upRes.on('data', (chunk) => {
        lastReleaseAt = scheduleWrite(clientRes, chunk, first);
        first = false;
      });
      upRes.on('end', () => {
        // 结束时间跟随最后一字节的放行时间
        const endDelay = Math.max(0, lastReleaseAt - Date.now());
        setTimeout(() => { if (!clientRes.writableEnded) clientRes.end(); }, endDelay);
      });
      upRes.on('error', () => clientRes.destroy());
    });
    up.on('error', () => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      clientRes.end('proxy upstream error');
    });
    clientReq.pipe(up);
  });

  // 已排队但尚未放行的下行耗时（毫秒）。链路空闲时返回 0。
  // 用途：预热后必须等队列排空再开始测量，否则预取流量会把热启动/搜索的首次加载算慢。
  function queuedMs() {
    return Math.max(0, allowAt - Date.now());
  }

  return { server, stats, config: { latencyMs, downloadKbps, bytesPerSec }, queuedMs };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

module.exports = { createShapingProxy, listen };
