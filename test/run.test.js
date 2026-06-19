'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'tunlite.js');
const FAKE_SSH = path.join(__dirname, '..', 'fixtures', 'fake-ssh.js');

function spawnRun(args, env = {}) {
  return cp.spawn(process.execPath, [BIN, 'run', ...args], {
    env: { ...process.env, TUNLITE_SSH: FAKE_SSH, TUNLITE_FAKE_AUTOSTART: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('run streams NDJSON state on stdout and exits 0 on SIGTERM', async () => {
  const child = spawnRun(['--to', 'me@host', '-R', '9300:localhost:3000', '--json'],
    { FAKE_SSH_MODE: 'stay' });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => {
    child.stdout.on('data', () => { if (/"state":"(connected|starting)"/.test(out)) resolve(); });
    setTimeout(resolve, 2500);
  });
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 0);
  // Locked NDJSON contract: each line is JSON carrying the dynamic state plus a
  // `ts` (epoch ms). Field names match `status --json` (sourced from sup.status()).
  const KEYS = ['ts', 'name', 'state', 'pid', 'restarts', 'uptimeMs', 'lastError', 'lastExitCode'];
  const lines = out.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'expected at least one NDJSON line');
  for (const ln of lines) {
    let obj;
    assert.doesNotThrow(() => { obj = JSON.parse(ln); }, `each stdout line is JSON: ${ln}`);
    assert.deepEqual(Object.keys(obj).sort(), [...KEYS].sort(), `line has exactly the contract keys: ${ln}`);
    assert.equal(typeof obj.ts, 'number', 'ts is epoch ms (number)');
    assert.equal(typeof obj.state, 'string', 'state is a string');
    assert.equal(typeof obj.uptimeMs, 'number', 'uptimeMs is a number');
  }
  // STOPPED is terminal: shutdown calls stop() from both onSignal and finish(),
  // but the contract emits the terminal line exactly once (no duplicate).
  const stopped = lines.filter((ln) => /"state":"stopped"/.test(ln));
  assert.ok(stopped.length <= 1, `terminal stopped emitted at most once, got ${stopped.length}`);
});

test('run --exit-on-failure exits 4 on auth failure', async () => {
  const child = spawnRun(['--to', 'me@host', '-R', '9301:localhost:3000', '--exit-on-failure', '--json'],
    { FAKE_SSH_MODE: 'authfail' });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 4);
});

test('run --exit-on-failure exits 1 when endpoint is already locked (blocked)', async (t) => {
  const fs = require('fs');
  const os = require('os');
  // Both processes share TUNLITE_HOME -> share the endpoint-lock dir
  // (<home>/data/locks). The holder claims L:127.0.0.1:18080 and stays; the
  // intruder claims the same key, the live holder makes acquire() fail, the
  // supervisor enters BLOCKED, and --exit-on-failure maps BLOCKED -> exit 1.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-run-lock-'));
  const env = { TUNLITE_HOME: home, FAKE_SSH_MODE: 'stay' };

  const holder = spawnRun(['--to', 'me@host', '-L', '18080:localhost:80', '--json'], env);
  t.after(async () => {
    // Stop the holder with SIGTERM, not SIGKILL: run's shutdown handler reaps its
    // ssh child, so the fake-ssh grandchild exits too. SIGKILL kills only the run
    // process and orphans fake-ssh (spawned without `detached`, so a signal to run
    // is never delivered to it) — that leaked one stray node process per test run.
    // Await the exit so the reap completes before the runner moves on; SIGKILL is
    // a last-resort fallback if SIGTERM is somehow ignored.
    holder.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
      holder.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Wait until the holder owns the lock. The lock is acquired synchronously
  // before the first spawn, so 'starting' (or 'connected' after the grace) both
  // mean the lock is held. Fall back to a timeout so a wedged holder can't hang.
  let hout = '';
  await new Promise((resolve) => {
    holder.stdout.on('data', (d) => {
      hout += d;
      if (/"state":"(connected|starting)"/.test(hout)) resolve();
    });
    setTimeout(resolve, 3000);
  });

  // Second process claims the same endpoint -> blocked -> exit 1.
  const intruder = spawnRun(['--to', 'me@host', '-L', '18080:localhost:80', '--exit-on-failure', '--json'], env);
  let iout = '';
  intruder.stdout.on('data', (d) => { iout += d; });
  const code = await new Promise((r) => intruder.on('exit', (c) => r(c)));
  assert.equal(code, 1, `intruder should exit 1 (blocked); stdout was: ${iout}`);
  assert.match(iout, /"state":"blocked"/, 'intruder should report the blocked state');
});

test('run rejects missing --to / missing forward with usage exit 2', async () => {
  const c1 = spawnRun([]); // no --to, no forward
  assert.equal(await new Promise((r) => c1.on('exit', (x) => r(x))), 2);
  const c2 = spawnRun(['--to', 'me@host']); // no forward
  assert.equal(await new Promise((r) => c2.on('exit', (x) => r(x))), 2);
});
