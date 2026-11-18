'use strict';

/**
 * Test-only port helper.
 *
 * Default: 0 -> the operating system picks an ephemeral port.
 * Override: TEST_PORT=<0..65535> (used by focused/manual debugging only).
 *
 * This is deliberately not a "probe-then-close" allocator: the socket that
 * receives the port is the same socket that keeps serving requests.
 */
function requestedPort(name) {
  const key = name || 'TEST_PORT';
  const raw = process.env[key];
  if (raw === undefined || raw === '') return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(key + ' must be an integer in 0..65535, got: ' + raw);
  }
  return port;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host || '127.0.0.1');
  });
}

module.exports = { requestedPort, listen };
