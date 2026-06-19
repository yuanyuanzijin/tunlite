'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { Supervisor, STATE, isBenignStderr } = require('../src/supervisor');

const FAKE_SSH = path.join(__dirname, '..', 'fixtures', 'fake-ssh.js');

const os = require('os');
const fs = require('fs');
const { beforeEach, afterEach } = require('node:test');

let _LOCKHOME;
beforeEach(() => {
  _LOCKHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-sup-'));
  process.env.TUNLITE_HOME = _LOCKHOME;
});
afterEach(() => {
  delete process.env.TUNLITE_HOME;
  try { fs.rmSync(_LOCKHOME, { recursive: true, force: true }); } catch (_) {}
});

function tunnel(extra = {}) {
  return {
    name: 'web', host: 'me@host', port: 22,
    forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 0 }],
    sshOptions: [], enabled: true, autoSetupKey: true, ...extra,
  };
}

function waitFor(emitter, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const states = [];
    const to = setTimeout(() => reject(new Error(`timeout; saw states: ${states.join(',')}`)), timeoutMs);
    emitter.on('state', (s) => {
      states.push(s.state);
      if (predicate(s, states)) { clearTimeout(to); resolve({ s, states }); }
    });
  });
}

test('reaches connected when ssh stays alive', async () => {
  // fake-ssh reads FAKE_SSH_MODE from the inherited env.
  process.env.FAKE_SSH_MODE = 'stay';
  const sup = new Supervisor(tunnel({ forwards: [{ type: 'remote', bind: '127.0.0.1', srcPort: 9000, destHost: 'localhost', destPort: 3000 }] }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 120 });
  sup.start();
  const { s } = await waitFor(sup, (x) => x.state === STATE.CONNECTED);
  assert.equal(s.state, STATE.CONNECTED);
  sup.stop();
  await waitFor(sup, (x) => x.state === STATE.STOPPED);
});

test('auth failure -> needs-auth and emits event', async () => {
  process.env.FAKE_SSH_MODE = 'authfail';
  const sup = new Supervisor(tunnel(),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 500, needsAuthRetryMs: 100000 });
  let needsAuthFired = false;
  sup.on('needs-auth', () => { needsAuthFired = true; });
  sup.start();
  await waitFor(sup, (x) => x.state === STATE.NEEDS_AUTH);
  assert.equal(needsAuthFired, true);
  sup.stop();
});

const lock = require('../src/lock');

test('second tunnel on the same endpoint goes blocked, then connects after the first releases', async () => {
  process.env.FAKE_SSH_MODE = 'stay';
  const fwd = [{ type: 'remote', bind: '127.0.0.1', srcPort: 9100, destHost: 'localhost', destPort: 3000 }];
  const a = new Supervisor(tunnel({ name: 'a', host: 'me@host', forwards: fwd }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 60 });
  a.start();
  await waitFor(a, (x) => x.state === STATE.CONNECTED);

  const b = new Supervisor(tunnel({ name: 'b', host: 'me@host', forwards: fwd }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 60, needsAuthRetryMs: 80 });
  b.start();
  const { s } = await waitFor(b, (x) => x.state === STATE.BLOCKED);
  assert.equal(s.state, STATE.BLOCKED);
  assert.match(b.status().lastError, /held by tunnel a/);

  a.stop();
  await waitFor(a, (x) => x.state === STATE.STOPPED);
  await waitFor(b, (x) => x.state === STATE.CONNECTED);
  b.stop();
  await waitFor(b, (x) => x.state === STATE.STOPPED);
});

test('fail-open: a lock subsystem error does not stop the tunnel', async () => {
  process.env.FAKE_SSH_MODE = 'stay';
  const throwingLock = { acquire() { throw new Error('locks dir unwritable'); }, release() {} };
  const sup = new Supervisor(
    tunnel({ forwards: [{ type: 'remote', bind: '127.0.0.1', srcPort: 9101, destHost: 'localhost', destPort: 3000 }] }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 60, lock: throwingLock });
  sup.start();
  const { s } = await waitFor(sup, (x) => x.state === STATE.CONNECTED);
  assert.equal(s.state, STATE.CONNECTED);
  sup.stop();
  await waitFor(sup, (x) => x.state === STATE.STOPPED);
});

test('isBenignStderr flags ssh noise but not real errors', () => {
  assert.ok(isBenignStderr('setsockopt TCP_NODELAY: Invalid argument'));
  assert.ok(isBenignStderr('** WARNING: connection is not using a post-quantum key exchange algorithm.'));
  assert.ok(isBenignStderr('** This session may be vulnerable to "store now, decrypt later" attacks.'));
  assert.ok(!isBenignStderr('Permission denied (publickey).'));
  assert.ok(!isBenignStderr('Error: remote port forwarding failed for listen port 19999'));
  assert.ok(!isBenignStderr('connect to host x port 22: Operation timed out'));
});

test('benign stderr does not surface as lastError once connected', async () => {
  process.env.FAKE_SSH_MODE = 'stay';
  process.env.FAKE_SSH_STDERR = 'setsockopt TCP_NODELAY: Invalid argument';
  const sup = new Supervisor(
    tunnel({ forwards: [{ type: 'remote', bind: '127.0.0.1', srcPort: 9001, destHost: 'localhost', destPort: 3000 }] }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 120 });
  sup.start();
  await waitFor(sup, (x) => x.state === STATE.CONNECTED);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sup.status().lastError, null, 'connected tunnel should read clean');
  assert.equal(sup.status().lastExitCode, null);
  delete process.env.FAKE_SSH_STDERR;
  sup.stop();
});

test('transient failure triggers retry with backoff', async () => {
  process.env.FAKE_SSH_MODE = 'quickfail';
  const sup = new Supervisor(tunnel(),
    { backoff: { baseMs: 15, capMs: 60, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 100000 });
  sup.start();
  await waitFor(sup, (_s, states) =>
    states.filter((x) => x === STATE.RETRYING).length >= 2 &&
    states.filter((x) => x === STATE.STARTING).length >= 2);
  assert.ok(sup.restarts >= 2);
  sup.stop();
});

test('ssh children are spawned with windowsHide so no console window pops up on Windows', () => {
  let captured = null;
  const makeChild = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 4242;
    c.kill = () => {};
    return c;
  };
  const sup = new Supervisor(
    tunnel(),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    {
      sshBinary: 'ssh',
      // no-op timers keep the test synchronous (no lingering grace/force-kill timer)
      setTimeout: () => 0,
      clearTimeout: () => {},
      spawn: (bin, args, options) => { captured = { bin, args, options }; return makeChild(); },
    },
  );
  sup.start();
  assert.ok(captured, 'the injected spawn should have been used');
  assert.equal(captured.options.windowsHide, true);
  sup.stop();
});

test('status() surfaces the definition fields needed to reconstruct the tunnel', () => {
  const sup = new Supervisor(
    tunnel({ port: 2222, identityFile: '~/.ssh/id', sshOptions: ['ServerAliveInterval=15'], tags: ['work', 'prod'], enabled: true, autoSetupKey: false }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH });
  const st = sup.status(); // no start(): status reads straight from the tunnel def
  assert.equal(st.port, 2222);
  assert.equal(st.identityFile, '~/.ssh/id');
  assert.deepEqual(st.sshOptions, ['ServerAliveInterval=15']);
  assert.deepEqual(st.tags, ['work', 'prod']);
  assert.equal(st.enabled, true);
  assert.equal(st.autoSetupKey, false);
});

test('backoff only resets after a connection survives resetAfterMs (flapping escalates)', () => {
  // Fully deterministic: a controllable clock plus injected timers we fire on
  // demand. We drive connect->drop cycles where each connection lasts LESS than
  // resetAfterMs, then one that lasts AT LEAST resetAfterMs, and assert the
  // scheduled retry delay escalates while flapping but snaps back to base once a
  // connection is sustained long enough to be considered stable.
  const RESET_AFTER = 10000;
  const BASE = 100;
  let clock = 0;
  // One pending injected timer at a time is all the supervisor needs here: the
  // grace timer (then cleared on connect) and the retry timer. We capture the
  // most recently scheduled callback and fire it explicitly.
  const timers = new Map();
  let nextId = 1;
  const fakeSetTimeout = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const fire = (id) => { const fn = timers.get(id); timers.delete(id); fn(); };

  // Fake ssh child; exit is triggered manually via child.emit('exit', ...).
  let child = null;
  const makeChild = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 1234;
    c.kill = () => {};
    return c;
  };

  const sup = new Supervisor(
    tunnel({ forwards: [{ type: 'remote', bind: '127.0.0.1', srcPort: 9100, destHost: 'localhost', destPort: 3000 }] }),
    { backoff: { baseMs: BASE, capMs: 100000, factor: 2, jitter: 0, resetAfterMs: RESET_AFTER } },
    {
      sshBinary: 'ssh',
      now: () => clock,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      spawn: () => { child = makeChild(); return child; },
    },
  );

  const retryDelays = [];
  sup.on('state', (s) => { if (s.state === STATE.RETRYING) retryDelays.push(s.delayMs); });

  // Run one connect (held for `holdMs`) -> drop cycle, return the retry delay.
  const cycle = (holdMs) => {
    sup._spawn();                // STARTING; schedules the grace timer (one pending timer)
                                 // (drives the reconnect/backoff path directly; the
                                 // initial endpoint-lock acquire is out of scope here)
    const graceId = [...timers.keys()].pop();
    fire(graceId);               // grace elapsed, still alive -> remote-only marks CONNECTED
    assert.equal(sup.state, STATE.CONNECTED);
    clock += holdMs;             // connection sustained for holdMs
    child.emit('exit', 255, null); // drop -> _classifyAndReact -> _scheduleRetry
    assert.equal(sup.state, STATE.RETRYING);
    const retryId = [...timers.keys()].pop();
    fakeClearTimeout(retryId);   // don't auto-respawn; we drive each cycle ourselves
    return retryDelays[retryDelays.length - 1];
  };

  // Three short-lived cycles (each well under resetAfterMs) -> escalating delays.
  const d1 = cycle(BASE);
  const d2 = cycle(BASE);
  const d3 = cycle(BASE);
  assert.equal(d1, 100, 'first retry at base delay');
  assert.equal(d2, 200, 'flapping connection must not reset -> escalates');
  assert.equal(d3, 400, 'still escalating across short-lived connections');

  // Now a connection sustained for >= resetAfterMs, then a drop: backoff resets,
  // so the next retry is back at the base delay.
  const d4 = cycle(RESET_AFTER);
  assert.equal(d4, 100, 'a connection held >= resetAfterMs resets backoff to base');

  sup.stop();
});

test('stop() force-kills a child that ignores SIGTERM after the grace', () => {
  // Injected timers we fire on demand + a fake child that records the signals it
  // is sent but NEVER emits 'exit' (a wedged ssh ignoring SIGTERM).
  const timers = new Map();
  let nextId = 1;
  const fakeSetTimeout = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const fire = (id) => { const fn = timers.get(id); if (fn) { timers.delete(id); fn(); } };

  const signals = [];
  const makeChild = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 4242;
    c.killed = false;
    c.kill = (sig) => { signals.push(sig); c.killed = true; /* never exits */ };
    return c;
  };

  const sup = new Supervisor(
    tunnel(),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: 'ssh', setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, spawn: () => makeChild(), stopGraceMs: 3000 },
  );
  sup.start();
  // start() schedules the grace timer; drop it so only stop()'s kill timer remains.
  const graceId = [...timers.keys()].pop();
  fakeClearTimeout(graceId);

  sup.stop();
  assert.deepEqual(signals, ['SIGTERM'], 'SIGTERM sent on stop');
  const killId = [...timers.keys()].pop();
  assert.ok(killId, 'a force-kill timer is scheduled and tracked');
  fire(killId); // grace elapses, child still alive
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'a child that ignores SIGTERM IS force-killed');
});

test('stop() does NOT force-kill a child that exits on SIGTERM, and clears the timer', () => {
  const timers = new Map();
  let nextId = 1;
  const fakeSetTimeout = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };

  const signals = [];
  let theChild = null;
  const makeChild = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 4243;
    c.killed = false;
    c.kill = (sig) => { signals.push(sig); c.killed = true; if (sig === 'SIGTERM') c.emit('exit', null, 'SIGTERM'); };
    return c;
  };

  const sup = new Supervisor(
    tunnel(),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: 'ssh', setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, spawn: () => { theChild = makeChild(); return theChild; }, stopGraceMs: 3000 },
  );
  sup.start();
  const graceId = [...timers.keys()].pop();
  fakeClearTimeout(graceId);

  sup.stop(); // SIGTERM -> child exits -> exit handler clears the kill timer
  assert.deepEqual(signals, ['SIGTERM'], 'only SIGTERM; no force-kill needed');
  assert.equal(sup._killTimer, null, 'the force-kill timer is cleared once the child exits');
  assert.equal(timers.size, 0, 'no timers left pending');
  assert.equal(sup.state, STATE.STOPPED);
});

test('local/dynamic tunnel reaches connected even if the port probe fails', async () => {
  process.env.FAKE_SSH_MODE = 'stay';
  const sup = new Supervisor(
    tunnel({ forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 0 }] }),
    { backoff: { baseMs: 10, capMs: 50, jitter: 0 } },
    { sshBinary: FAKE_SSH, connectGraceMs: 80 });
  sup.start();
  const { s } = await waitFor(sup, (x) => x.state === STATE.CONNECTED);
  assert.equal(s.state, STATE.CONNECTED);
  sup.stop();
});
