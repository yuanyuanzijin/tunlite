'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipc = require('../src/ipc');

function tmpSock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-ipc-'));
  return path.join(dir, 'd.sock');
}

test('request/response round trip', async (t) => {
  if (os.platform() === 'win32') return; // unix-socket path test
  const sock = tmpSock();
  const server = new ipc.Server({
    ping: async () => ({ pong: true }),
    echo: async (args) => ({ got: args.msg }),
    boom: async () => { throw new Error('kaboom'); },
  });
  await server.listen(sock);
  t.after(() => server.close());

  assert.deepEqual(await ipc.request(sock, 'ping'), { pong: true });
  assert.deepEqual(await ipc.request(sock, 'echo', { msg: 'hi' }), { got: 'hi' });
  await assert.rejects(() => ipc.request(sock, 'boom'), /kaboom/);
  await assert.rejects(() => ipc.request(sock, 'nope'), /unknown command/);
});

test('socket file is 0600 and its parent dir 0700 (no other-user access)', async (t) => {
  if (os.platform() === 'win32') return; // named pipes are ACL'd, not chmod'd
  const sock = tmpSock();
  const server = new ipc.Server({ ping: async () => ({ pong: true }) });
  await server.listen(sock);
  t.after(() => server.close());

  const sockMode = fs.statSync(sock).mode & 0o777;
  assert.equal(sockMode, 0o600, `socket should be 0600, got 0${sockMode.toString(8)}`);
  const dirMode = fs.statSync(path.dirname(sock)).mode & 0o777;
  assert.equal(dirMode, 0o700, `socket dir should be 0700, got 0${dirMode.toString(8)}`);
});

test('a stale socket file (no listener) is cleaned up and listen succeeds', async (t) => {
  if (os.platform() === 'win32') return; // unix-socket stale-file dance
  const sock = tmpSock();
  // Leave a bare file where the socket would be — a leftover from a dead daemon
  // that never got to unlink it. listen() must remove it and bind cleanly.
  fs.writeFileSync(sock, '');
  const server = new ipc.Server({ ping: async () => ({ pong: true }) });
  await server.listen(sock);
  t.after(() => server.close());
  assert.deepEqual(await ipc.request(sock, 'ping'), { pong: true });
});

test('a live socket makes a second listen fail rather than clobber the first', async (t) => {
  if (os.platform() === 'win32') return; // unix-socket stale-file dance
  const sock = tmpSock();
  const first = new ipc.Server({ ping: async () => ({ from: 'first' }) });
  await first.listen(sock);
  t.after(() => first.close());

  const second = new ipc.Server({ ping: async () => ({ from: 'second' }) });
  await assert.rejects(() => second.listen(sock), (err) => err.code === 'EADDRINUSE',
    'a second daemon must not steal a live socket');

  // The first daemon is still the one answering on the socket.
  assert.deepEqual(await ipc.request(sock, 'ping'), { from: 'first' });
});

test('streaming frames then close', async (t) => {
  if (os.platform() === 'win32') return;
  const sock = tmpSock();
  const server = new ipc.Server({
    feed: async (args, ctx) => {
      ctx.push({ n: 1 });
      ctx.push({ n: 2 });
      ctx.socket.end();
    },
  });
  await server.listen(sock);
  t.after(() => server.close());

  const frames = [];
  await new Promise((resolve, reject) => {
    ipc.stream(sock, 'feed', {}, (f) => frames.push(f))
      .then((h) => h.socket.on('close', resolve))
      .catch(reject);
  });
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }]);
});

test('request times out instead of hanging when the daemon never replies', async (t) => {
  if (os.platform() === 'win32') return;
  const sock = tmpSock();
  // Handler accepts the connection but never resolves and never pushes — a wedged daemon.
  const server = new ipc.Server({ wedge: () => new Promise(() => {}) });
  await server.listen(sock);
  t.after(() => server.close());

  const started = Date.now();
  await assert.rejects(
    () => ipc.request(sock, 'wedge', {}, { timeoutMs: 250 }),
    (err) => err.code === 'timeout');
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang');
});

test('request to a missing socket fails fast (daemon down)', async () => {
  if (os.platform() === 'win32') return;
  const sock = tmpSock(); // never listened on
  await assert.rejects(() => ipc.request(sock, 'ping', {}, { timeoutMs: 1000 }));
});

test('collect gathers all stream frames then resolves on close', async (t) => {
  if (os.platform() === 'win32') return;
  const sock = tmpSock();
  const server = new ipc.Server({
    logs: async (args, ctx) => {
      ctx.push({ ts: 1, line: 'a' });
      ctx.push({ ts: 2, line: 'b' });
      ctx.socket.end();
    },
  });
  await server.listen(sock);
  t.after(() => server.close());

  const frames = await ipc.collect(sock, 'logs', { name: 'x', follow: false, n: 10 });
  assert.deepEqual(frames, [{ ts: 1, line: 'a' }, { ts: 2, line: 'b' }]);
});

test('collect resolves via the timeout backstop (returns partial frames) when the stream never closes', async (t) => {
  if (os.platform() === 'win32') return;
  const sock = tmpSock();
  const server = new ipc.Server({
    // pushes frames but NEVER ends the socket — simulates a missing close event
    logs: async (args, ctx) => { ctx.push({ ts: 1, line: 'a' }); ctx.push({ ts: 2, line: 'b' }); /* no end() */ },
  });
  await server.listen(sock);
  t.after(() => server.close());

  const started = Date.now();
  const frames = await ipc.collect(sock, 'logs', { name: 'x', follow: false, n: 10 }, { collectTimeoutMs: 200 });
  assert.deepEqual(frames, [{ ts: 1, line: 'a' }, { ts: 2, line: 'b' }]);
  assert.ok(Date.now() - started < 2000, 'resolved via the timeout backstop, not hung');
});
