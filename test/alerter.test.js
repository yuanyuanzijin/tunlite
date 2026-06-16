'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Alerter, defaultPost } = require('../src/alerter');

// An alerter wired to a spy poster and a fixed clock/host/version.
function mkAlerter(settings, posts) {
  return new Alerter({
    settings,
    post: (url, req) => { posts.push({ url, payload: req.body, req }); return Promise.resolve({ status: 200, text: '' }); },
    now: () => 1000,
    hostname: 'testbox',
    version: '9.9.9',
  });
}

const ENABLED = { alerts: { webhook: { url: 'http://hook/x', events: ['down', 'recovered', 'needs-auth', 'failed'] } } };
const status = (state, extra = {}) => ({ state, lastError: null, restarts: 0, ...extra });

// drive a sequence of states for one tunnel
async function drive(a, name, states) {
  for (const s of states) a.onState(name, 'me@host', status(s));
  await new Promise((r) => setImmediate(r)); // let the queued posts flush
}

test('a drop from connected fires "down" exactly once', async () => {
  const posts = [];
  const a = mkAlerter(ENABLED, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying', 'starting', 'retrying']);
  const downs = posts.filter((p) => p.payload.event === 'down');
  assert.equal(downs.length, 1, 'down should fire once, not per retry');
  assert.equal(downs[0].payload.tunnel, 'web');
  assert.equal(downs[0].payload.host, 'me@host');
  assert.equal(downs[0].payload.machine, 'testbox');
  assert.equal(downs[0].payload.version, '9.9.9');
});

test('initial connect failure (never connected) does NOT fire down', async () => {
  const posts = [];
  const a = mkAlerter(ENABLED, posts);
  await drive(a, 'web', ['starting', 'retrying', 'starting', 'retrying']);
  assert.equal(posts.length, 0);
});

test('recovery fires only after a down was alerted', async () => {
  const posts = [];
  const a = mkAlerter(ENABLED, posts);
  // first connect: no event; drop -> down; reconnect -> recovered
  await drive(a, 'web', ['starting', 'connected', 'retrying', 'starting', 'connected']);
  const events = posts.map((p) => p.payload.event);
  assert.deepEqual(events, ['down', 'recovered']);
});

test('needs-auth fires once; recovery clears it', async () => {
  const posts = [];
  const a = mkAlerter(ENABLED, posts);
  await drive(a, 'web', ['starting', 'needs-auth', 'needs-auth', 'starting', 'connected']);
  assert.deepEqual(posts.map((p) => p.payload.event), ['needs-auth', 'recovered']);
});

test('failed fires once on entry', async () => {
  const posts = [];
  const a = mkAlerter(ENABLED, posts);
  await drive(a, 'web', ['starting', 'connected', 'failed', 'failed']);
  assert.deepEqual(posts.map((p) => p.payload.event), ['failed']);
});

test('disabled when no url is set', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: null, events: ['down'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying']);
  assert.equal(posts.length, 0);
});

test('events filter suppresses unlisted events', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'http://h', events: ['recovered'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying', 'starting', 'connected']);
  assert.deepEqual(posts.map((p) => p.payload.event), ['recovered']); // down filtered out
});

test('setSettings switches the webhook live', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: null, events: ['down'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying']); // disabled -> nothing
  assert.equal(posts.length, 0);
  a.setSettings({ alerts: { webhook: { url: 'http://h', events: ['down'] } } });
  await drive(a, 'db', ['starting', 'connected', 'retrying']); // now enabled
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.tunnel, 'db');
});

test('a throwing poster is swallowed and logged, never thrown', async () => {
  const logs = [];
  const a = new Alerter({
    settings: ENABLED,
    post: () => Promise.reject(new Error('boom')),
    log: (l) => logs.push(l),
    now: () => 1, hostname: 'h', version: 'v',
  });
  a.onState('web', 'me@host', status('connected'));
  a.onState('web', 'me@host', status('retrying')); // fires down -> post rejects
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => /failed: boom/.test(l)), 'failure is logged');
});

const ALL = { alerts: { webhook: { url: 'http://hook/x', events: require('../src/config').ALERT_EVENTS } } };

test('"up" fires on first connect when subscribed', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'http://h', events: ['up'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected']);
  assert.deepEqual(posts.map((p) => p.payload.event), ['up']);
  assert.equal(posts[0].payload.scope, 'tunnel');
});

test('"stopped" fires on an intentional stop', async () => {
  const posts = [];
  const a = mkAlerter(ALL, posts);
  await drive(a, 'web', ['starting', 'connected', 'stopped']);
  assert.deepEqual(posts.map((p) => p.payload.event), ['up', 'stopped']);
});

test('daemonEvent posts a daemon-scope payload with null tunnel/host', async () => {
  const posts = [];
  const a = mkAlerter(ALL, posts);
  const p = a.daemonEvent('daemon-up');
  assert.ok(p && typeof p.then === 'function', 'returns an awaitable promise');
  await p;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.event, 'daemon-up');
  assert.equal(posts[0].payload.scope, 'daemon');
  assert.equal(posts[0].payload.tunnel, null);
  assert.equal(posts[0].payload.host, null);
});

test('daemonEvent returns null (no post) when the event is not subscribed', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'http://h', events: ['down'] } } }, posts);
  assert.equal(a.daemonEvent('daemon-up'), null);
  assert.equal(posts.length, 0);
});

test('suspended drops tunnel events but daemonEvent still fires', async () => {
  const posts = [];
  const a = mkAlerter(ALL, posts);
  a.suspended = true;
  await drive(a, 'web', ['starting', 'connected', 'stopped']); // all tunnel events suppressed
  assert.equal(posts.filter((p) => p.payload.scope === 'tunnel').length, 0);
  await (a.daemonEvent('daemon-down') || Promise.resolve());
  assert.deepEqual(posts.map((p) => p.payload.event), ['daemon-down']);
});

test('defaultPost POSTs the channel body and resolves {status,text}', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { received.push({ method: req.method, ct: req.headers['content-type'], body }); res.statusCode = 200; res.end('{"errcode":0}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await defaultPost(`http://127.0.0.1:${port}/hook`, { body: { event: 'test', n: 1 }, contentType: 'application/json' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"errcode":0}');
    assert.equal(received[0].method, 'POST');
    assert.match(received[0].ct, /application\/json/);
    assert.deepEqual(JSON.parse(received[0].body), { event: 'test', n: 1 });
  } finally {
    server.close();
  }
});

test('defaultPost caps the response body and still resolves on a flood', async () => {
  // An endpoint that streams far more than the cap. defaultPost must bound the
  // captured text and still resolve (never buffer unbounded data into the daemon).
  const chunk = 'x'.repeat(4096);
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    let n = 0;
    // Stream ~128 KB in 4 KB chunks; stop once the client tears the socket down.
    const pump = () => {
      if (n >= 32 || res.writableEnded || res.destroyed) { try { res.end(); } catch (_) {} return; }
      n += 1;
      if (res.write(chunk)) setImmediate(pump); else res.once('drain', pump);
    };
    req.on('data', () => {});
    req.on('end', pump);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await defaultPost(`http://127.0.0.1:${port}/hook`, { body: { event: 'flood' } });
    assert.equal(r.status, 200);
    assert.ok(r.text.length <= 8 * 1024, `captured text must be bounded, got ${r.text.length}`);
    assert.ok(r.text.length > 0, 'some body should be captured');
  } finally {
    server.close();
  }
});

test('wecom channel sends a {msgtype:text} body', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'https://qyapi.weixin.qq.com/x', channel: 'wecom', events: ['down'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].req.body.msgtype, 'text');
  assert.match(posts[0].req.body.text.content, /tunnel web is down/);
});

test('a channel REJECTED verdict is logged, not thrown', async () => {
  const logs = [];
  const a = new Alerter({
    settings: { alerts: { webhook: { url: 'https://qyapi.weixin.qq.com/x', channel: 'wecom', events: ['down'] } } },
    post: () => Promise.resolve({ status: 200, text: '{"errcode":93000,"errmsg":"invalid"}' }),
    log: (l) => logs.push(l),
    now: () => 1, hostname: 'h', version: 'v',
  });
  a.onState('web', 'me@host', status('connected'));
  a.onState('web', 'me@host', status('retrying'));
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => /REJECTED/.test(l) && /errcode 93000/.test(l)), 'rejection is logged');
});

test('enabled:false suppresses alerts even with a url set', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'http://h', enabled: false, events: ['down'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying']);
  assert.equal(posts.length, 0);
});

test('the post log line redacts the url (secret tail never logged)', async () => {
  const logs = [];
  const secretUrl = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
  const a = new Alerter({
    settings: { alerts: { webhook: { url: secretUrl, events: ['down'] } } },
    post: () => Promise.resolve({ status: 200, text: '' }),
    log: (l) => logs.push(l),
    now: () => 1, hostname: 'h', version: 'v',
  });
  a.onState('web', 'me@host', status('connected'));
  a.onState('web', 'me@host', status('retrying')); // fires down -> post -> log
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => /down/.test(l) && /hooks\.slack\.com/.test(l)), 'host stays visible in the log');
  assert.ok(!logs.some((l) => /SECRET/.test(l)), 'the secret path is never logged');
});

test('a non-http(s) configured url is treated as disabled (never fetched)', async () => {
  const posts = [];
  const a = mkAlerter({ alerts: { webhook: { url: 'file:///etc/passwd', events: ['down'] } } }, posts);
  await drive(a, 'web', ['starting', 'connected', 'retrying']);
  assert.equal(posts.length, 0, 'a file:// url must never be posted to');
});
