'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogHub } = require('../src/log');

// A fresh temp dir per call; the caller removes it in an after-hook.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-log-'));
}

test('ring buffer caps at capacity; oldest lines drop, tail(n) returns the last n', () => {
  // Small capacity so the cap is easy to exercise deterministically. No dir =>
  // pure in-memory, no file sink.
  const hub = new LogHub({ capacity: 3 });
  for (let i = 1; i <= 5; i++) hub.write('chan', `line ${i}`);

  // Capacity is 3, so the two oldest (1, 2) must have been dropped.
  const all = hub.tail('chan', 100).map((e) => e.line);
  assert.deepEqual(all, ['line 3', 'line 4', 'line 5']);

  // tail(n) returns only the last n of what remains.
  assert.deepEqual(hub.tail('chan', 2).map((e) => e.line), ['line 4', 'line 5']);

  // tail on an unknown channel is empty, not a throw.
  assert.deepEqual(hub.tail('nope', 10), []);
});

test('each write emits a line event with {channel, ts, line} (drives logs -f)', () => {
  // Inject a deterministic clock so ts is exact.
  const hub = new LogHub({ capacity: 10 });
  hub.clock = () => 1234;

  const seen = [];
  hub.on('line', (e) => seen.push(e));
  hub.write('web', 'hello');
  hub.write('db', 'world');

  assert.equal(seen.length, 2);
  // The daemon/supervisor consume {ts, line}; the hub also tags the channel so a
  // single `logs -f` listener can filter by channel.
  assert.deepEqual(seen[0], { channel: 'web', ts: 1234, line: 'hello' });
  assert.deepEqual(seen[1], { channel: 'db', ts: 1234, line: 'world' });
  // The buffered entry shape is exactly {ts, line}.
  assert.deepEqual(hub.tail('web', 1)[0], { ts: 1234, line: 'hello' });
});

test('with a dir, writes append to <channel>.log and read back', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hub = new LogHub({ dir, capacity: 10 });
  hub.clock = () => Date.parse('2026-06-09T00:00:00.000Z');
  hub.write('web', 'first');
  hub.write('web', 'second');
  hub.close(); // flush + close the write stream so the file is fully on disk

  // close() ends the stream asynchronously; wait until the bytes have landed.
  const file = path.join(dir, 'web.log');
  for (let i = 0; i < 50 && (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length < 2); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  // Each on-disk line is "<ISO timestamp> <text>".
  assert.match(lines[0], /^2026-06-09T00:00:00\.000Z first$/);
  assert.match(lines[1], /^2026-06-09T00:00:00\.000Z second$/);

  // The in-memory tail still serves the same entries while the dir is in use.
  assert.deepEqual(hub.tail('web', 10).map((e) => e.line), ['first', 'second']);
});

test('a malicious channel name cannot escape the log dir (no path traversal)', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hub = new LogHub({ dir, capacity: 10 });
  // Path-traversal / separator characters in the channel name.
  const evil = '../../etc/passwd';
  hub.write(evil, 'pwned');
  hub.close();

  // The filename is sanitized: every non [A-Za-z0-9._-] char becomes '_', so the
  // file lands flatly inside `dir` and never above it.
  const expected = path.join(dir, `${evil.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  for (let i = 0; i < 50 && !fs.existsSync(expected); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(fs.existsSync(expected), 'sanitized log file should exist inside the dir');

  // The resolved path stays within the log dir, and nothing escaped it: the dir
  // holds ONLY the flat sanitized file. (Probing a real path like
  // `<dir>/../../etc/passwd` is wrong — on a shallow tmp root such as Linux's
  // /tmp it resolves to the system's own /etc/passwd, which exists regardless
  // of this code, so the check would spuriously fail there.)
  assert.ok(path.resolve(expected).startsWith(path.resolve(dir) + path.sep),
    'the log file must stay inside the log dir');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(expected)],
    'only the sanitized flat file should exist; nothing escaped the log dir');
});
