'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lock = require('../src/lock');
const paths = require('../src/paths');

// Fresh sandbox home per test so lock files never collide across tests and
// never touch the real system.
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-lock-'));
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = home;
  try { return fn(home); }
  finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const me = { name: 'a', pid: process.pid };

test('acquire then release frees the key', () => {
  withHome(() => {
    const r1 = lock.acquire(['L:127.0.0.1:8080'], me);
    assert.equal(r1.ok, true);
    lock.release(r1.handle);
    const r2 = lock.acquire(['L:127.0.0.1:8080'], me);
    assert.equal(r2.ok, true);
    lock.release(r2.handle);
  });
});

test('a live holder is a conflict', () => {
  withHome(() => {
    const r1 = lock.acquire(['L:127.0.0.1:8080'], { name: 'a', pid: process.pid });
    assert.equal(r1.ok, true);
    const r2 = lock.acquire(['L:127.0.0.1:8080'], { name: 'b', pid: process.pid });
    assert.equal(r2.ok, false);
    assert.equal(r2.key, 'L:127.0.0.1:8080');
    assert.equal(r2.holder.name, 'a');
    lock.release(r1.handle);
  });
});

test('a dead holder is stale and gets stolen', () => {
  withHome(() => {
    fs.mkdirSync(paths.lockDir(), { recursive: true });
    const enc = Buffer.from('L:127.0.0.1:8080').toString('base64url') + '.lock';
    fs.writeFileSync(path.join(paths.lockDir(), enc),
      JSON.stringify({ pid: 2147483646, name: 'ghost', ts: 1 }));
    const r = lock.acquire(['L:127.0.0.1:8080'], me);
    assert.equal(r.ok, true); // stolen
    lock.release(r.handle);
  });
});

test('multi-key acquire is all-or-nothing', () => {
  withHome(() => {
    const held = lock.acquire(['B'], { name: 'other', pid: process.pid });
    assert.equal(held.ok, true);
    const r = lock.acquire(['A', 'B'], { name: 'me', pid: process.pid });
    assert.equal(r.ok, false);
    assert.equal(r.key, 'B');
    const a = lock.acquire(['A'], me);
    assert.equal(a.ok, true);
    lock.release(a.handle);
    lock.release(held.handle);
  });
});

test('release is safe on null / empty handles', () => {
  withHome(() => {
    assert.doesNotThrow(() => lock.release(null));
    assert.doesNotThrow(() => lock.release({ keys: [] }));
  });
});
