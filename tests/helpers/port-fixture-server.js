'use strict';

const fs = require('fs');
const http = require('http');
const { requestedPort, listen } = require('./port');

const server = http.createServer((req, res) => {
  if (req.url === '/__shutdown') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bye');
    server.close(() => process.exit(0));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    url: req.url
  }));
});

(async () => {
  try {
    const port = await listen(server, requestedPort());
    const line = String(port) + '\n' + String(process.pid) + '\n';
    const file = process.env.PORT_FILE;
    if (file) fs.writeFileSync(file, line, 'utf8');
    process.stdout.write('PORT=' + port + '\n');
  } catch (err) {
    process.stderr.write('ERR ' + (err && err.code ? err.code + ' ' : '') +
      (err && err.message ? err.message : String(err)) + '\n');
    process.exit(2);
  }
})();

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
