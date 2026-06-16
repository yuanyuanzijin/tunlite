'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Backoff } = require('../src/backoff');

test('baseDelay grows exponentially and caps', () => {
  const b = new Backoff({ baseMs: 1000, factor: 2, capMs: 10000, jitter: 0 });
  assert.equal(b.baseDelay(0), 1000);
  assert.equal(b.baseDelay(1), 2000);
  assert.equal(b.baseDelay(2), 4000);
  assert.equal(b.baseDelay(3), 8000);
  assert.equal(b.baseDelay(4), 10000); // capped
  assert.equal(b.baseDelay(10), 10000);
});

test('next() with no jitter advances deterministically', () => {
  const b = new Backoff({ baseMs: 500, factor: 2, capMs: 5000, jitter: 0 });
  assert.equal(b.next(), 500);
  assert.equal(b.next(), 1000);
  assert.equal(b.next(), 2000);
});

test('reset() returns to attempt 0', () => {
  const b = new Backoff({ baseMs: 100, factor: 2, capMs: 5000, jitter: 0 });
  b.next();
  b.next();
  b.reset();
  assert.equal(b.next(), 100);
});

test('jitter stays within +/- band of base delay', () => {
  // rng fixed at 0 -> -span ; at ~1 -> +span
  const low = new Backoff({ baseMs: 1000, factor: 2, capMs: 9999, jitter: 0.2 }, () => 0);
  assert.equal(low.baseDelay(0), 1000);
  assert.equal(low.next(), 800); // 1000 - 20%
  const high = new Backoff({ baseMs: 1000, factor: 2, capMs: 9999, jitter: 0.2 }, () => 0.999999);
  const d = high.next();
  assert.ok(d <= 1200 && d >= 1199, `expected ~1200, got ${d}`);
});
