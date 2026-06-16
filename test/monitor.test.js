'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeKey, reduce } = require('../src/monitor');

const STATE = {
  daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' },
  tunnels: [
    { name: 'a', host: 'h1', state: 'connected', pid: 10, uptime: '1m', forwards: [] },
    { name: 'b', host: 'h2', state: 'failed', pid: null, uptime: null, forwards: [] },
    { name: 'c', host: 'h3', state: 'idle', pid: null, uptime: null, forwards: [] },
  ],
};
const UI = { selectedName: 'a', confirm: null, help: false, flash: null };

test('normalizeKey maps physical keys to tokens', () => {
  assert.equal(normalizeKey(null, { name: 'up' }), 'up');
  assert.equal(normalizeKey(null, { name: 'down' }), 'down');
  assert.equal(normalizeKey('c', { ctrl: true, name: 'c' }), 'ctrl-c');
  assert.equal(normalizeKey('x', {}), 'x');
  assert.equal(normalizeKey('?', {}), '?');
  assert.equal(normalizeKey(null, { name: 'escape' }), 'escape');
  assert.equal(normalizeKey(null, { name: 'return' }), 'enter');
  assert.equal(normalizeKey('Z', {}), null); // unmapped
});

test('down/up move selection and clamp (no wrap)', () => {
  let r = reduce(UI, 'down', STATE);
  assert.equal(r.ui.selectedName, 'b');
  assert.equal(r.action, null);
  r = reduce(r.ui, 'j', STATE); // j == down
  assert.equal(r.ui.selectedName, 'c');
  r = reduce(r.ui, 'down', STATE); // clamp at end
  assert.equal(r.ui.selectedName, 'c');
  r = reduce({ ...UI, selectedName: 'a' }, 'up', STATE); // clamp at start
  assert.equal(r.ui.selectedName, 'a');
  r = reduce({ ...UI, selectedName: 'b' }, 'k', STATE); // k == up
  assert.equal(r.ui.selectedName, 'a');
});

test('selection is keyed by name across reordering', () => {
  const reordered = { ...STATE, tunnels: [STATE.tunnels[2], STATE.tunnels[0], STATE.tunnels[1]] };
  const r = reduce({ ...UI, selectedName: 'b' }, 'down', reordered);
  // b is at index 2 in reordered; down clamps to last (still b)
  assert.equal(r.ui.selectedName, 'b');
});

test('selection clamps when the selected tunnel vanishes', () => {
  const r = reduce({ ...UI, selectedName: 'gone' }, 'down', STATE);
  // missing -> index 0 -> down -> index 1
  assert.equal(r.ui.selectedName, 'b');
});

test('s starts immediately, no confirm', () => {
  const r = reduce(UI, 's', STATE);
  assert.deepEqual(r.action, { type: 'start', name: 'a' });
  assert.equal(r.ui.confirm, null);
});

test('x opens a stop confirm; y confirms; n cancels', () => {
  let r = reduce(UI, 'x', STATE);
  assert.deepEqual(r.ui.confirm, { type: 'stop', name: 'a' });
  assert.equal(r.action, null);
  const confirmed = reduce(r.ui, 'y', STATE);
  assert.deepEqual(confirmed.action, { type: 'stop', name: 'a' });
  assert.equal(confirmed.ui.confirm, null);
  const cancelled = reduce(r.ui, 'n', STATE);
  assert.equal(cancelled.action, null);
  assert.equal(cancelled.ui.confirm, null);
});

test('Enter and Escape also cancel a pending confirm', () => {
  const open = reduce(UI, 'x', STATE).ui;
  assert.equal(reduce(open, 'enter', STATE).ui.confirm, null);
  assert.equal(reduce(open, 'escape', STATE).ui.confirm, null);
});

test('r opens a restart confirm; y confirms', () => {
  const open = reduce(UI, 'r', STATE);
  assert.deepEqual(open.ui.confirm, { type: 'restart', name: 'a' });
  assert.deepEqual(reduce(open.ui, 'y', STATE).action, { type: 'restart', name: 'a' });
});

test('? toggles help; q and ctrl-c quit', () => {
  assert.equal(reduce(UI, '?', STATE).ui.help, true);
  assert.equal(reduce({ ...UI, help: true }, 'h', STATE).ui.help, false);
  assert.deepEqual(reduce(UI, 'q', STATE).action, { type: 'quit' });
  assert.deepEqual(reduce(UI, 'ctrl-c', STATE).action, { type: 'quit' });
});

test('actions are no-ops with an empty tunnel list', () => {
  const empty = { daemon: { running: true }, tunnels: [] };
  const ui = { selectedName: null, confirm: null, help: false, flash: null };
  assert.equal(reduce(ui, 's', empty).action, null);
  assert.equal(reduce(ui, 'x', empty).ui.confirm, null);
});

test('list + enter opens the detail view at logScroll 0', () => {
  const r = reduce(UI, 'enter', STATE);
  assert.equal(r.ui.view, 'detail');
  assert.equal(r.ui.logScroll, 0);
  assert.equal(r.action, null);
});

test('list + enter is a no-op with an empty tunnel list', () => {
  const empty = { daemon: { running: true }, tunnels: [] };
  const ui = { selectedName: null, confirm: null, help: false, flash: null };
  assert.notEqual(reduce(ui, 'enter', empty).ui.view, 'detail');
});

test('detail + escape returns to the list', () => {
  const d = { ...UI, view: 'detail', logScroll: 3 };
  assert.equal(reduce(d, 'escape', STATE).ui.view, 'list');
});

test('detail + up/down scroll logs and floor at 0', () => {
  const d = { ...UI, view: 'detail', logScroll: 0 };
  assert.equal(reduce(d, 'up', STATE).ui.logScroll, 1);
  assert.equal(reduce(d, 'k', STATE).ui.logScroll, 1);
  assert.equal(reduce({ ...d, logScroll: 2 }, 'down', STATE).ui.logScroll, 1);
  assert.equal(reduce({ ...d, logScroll: 2 }, 'j', STATE).ui.logScroll, 1);
  assert.equal(reduce({ ...d, logScroll: 0 }, 'down', STATE).ui.logScroll, 0);
});

test('detail + s/x/r still act on the selected tunnel', () => {
  const d = { ...UI, view: 'detail', selectedName: 'a' };
  assert.deepEqual(reduce(d, 's', STATE).action, { type: 'start', name: 'a' });
  assert.deepEqual(reduce(d, 'x', STATE).ui.confirm, { type: 'stop', name: 'a' });
  assert.deepEqual(reduce(d, 'r', STATE).ui.confirm, { type: 'restart', name: 'a' });
});

test('detail + q and ctrl-c quit', () => {
  const d = { ...UI, view: 'detail' };
  assert.deepEqual(reduce(d, 'q', STATE).action, { type: 'quit' });
  assert.deepEqual(reduce(d, 'ctrl-c', STATE).action, { type: 'quit' });
});

const { layout } = require('../src/monitor');

const SIZE = { columns: 100, rows: 24 };
const FULL = {
  daemon: { running: true, pid: 41234, version: '0.2.0', uptime: '2d3h' },
  paths: { home: '/repo/.tunlite-dev', config: '/repo/.tunlite-dev/config/config.json' },
  tunnels: [
    { name: 'tmux-prod-19999', host: 'root@example.com', state: 'connected', pid: 41250, uptime: '2d3h', port: 22,
      forwards: [{ type: 'remote', bind: '0.0.0.0', srcPort: 19999, destHost: 'localhost', destPort: 19999 }] },
    { name: 'db-5432', host: 'root@db.internal', state: 'failed', pid: null, uptime: null, port: 2222,
      forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 5432, destHost: 'localhost', destPort: 5432 }] },
  ],
};

function text(lines) { return lines.join('\n'); }

test('layout: daemon-up header has daemon line + counts', () => {
  const t = text(layout(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, SIZE));
  assert.match(t, /daemon\s+running\s+pid 41234\s+v0\.2\.0\s+up 2d3h/);
  assert.match(t, /tunnels 2 total/);
  assert.match(t, /● 1 connected/);
  assert.match(t, /✕ 1 problem/);
});

test('layout: selected row is marked, others are not', () => {
  const lines = layout(FULL, { selectedName: 'db-5432', confirm: null, help: false, flash: null }, SIZE);
  const sel = lines.find((l) => l.includes('db-5432'));
  const other = lines.find((l) => l.includes('tmux-prod-19999'));
  assert.match(sel, /^>/);
  assert.match(other, /^ /);
});

test('layout: confirm prompt replaces the key-hint footer', () => {
  const t = text(layout(FULL, { selectedName: 'db-5432', confirm: { type: 'stop', name: 'db-5432' }, help: false, flash: null }, SIZE));
  assert.match(t, /stop "db-5432"\? \(y\/N\)/);
  assert.doesNotMatch(t, /s start {3}x stop/);
});

test('layout: daemon-down shows a banner', () => {
  const down = { daemon: { running: false }, tunnels: FULL.tunnels };
  const t = text(layout(down, { selectedName: 'db-5432', confirm: null, help: false, flash: null }, SIZE));
  assert.match(t, /daemon\s+not running/);
});

test('layout: empty tunnel list shows an add hint', () => {
  const t = text(layout({ daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' }, tunnels: [] },
    { selectedName: null, confirm: null, help: false, flash: null }, SIZE));
  assert.match(t, /no tunnels/);
});

test('renderLines: --tag filter annotates the title and the empty message', () => {
  const { renderLines } = require('../src/monitor');
  const ui = { selectedName: 'db-5432', confirm: null, help: false, flash: null };
  const titled = renderLines(FULL, ui, SIZE, { color: false, tagFilter: ['prod', 'db'] }).join('\n');
  assert.match(titled, /tunlite monitor · tag prod,db/);
  const empty = renderLines({ daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' }, tunnels: [] },
    { selectedName: null, confirm: null, help: false, flash: null }, SIZE, { color: false, tagFilter: ['prod'] }).join('\n');
  assert.match(empty, /no tunnels tagged prod/);
});

test('layout: help overlay lists the keys', () => {
  const t = text(layout(FULL, { selectedName: 'db-5432', confirm: null, help: true, flash: null }, SIZE));
  assert.match(t, /start/);
  assert.match(t, /restart/);
  assert.match(t, /quit/);
});

test('layout: narrow width truncates the forward column with an ellipsis', () => {
  const t = text(layout(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, { columns: 48, rows: 24 }));
  assert.match(t, /…/);
});

test('layout: header shows the env home dir and config path', () => {
  const t = text(layout(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, SIZE));
  assert.match(t, /home\s+\/repo\/\.tunlite-dev/);
  assert.match(t, /config\s+\/repo\/\.tunlite-dev\/config\/config\.json/);
});

test('layout: missing paths fall back to a system-default home label', () => {
  const noPaths = { daemon: FULL.daemon, tunnels: FULL.tunnels };
  const t = text(layout(noPaths, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, SIZE));
  assert.match(t, /home\s+system default/);
});

test('layout: HOST column folds in :port for non-22 ssh ports; TYPE and ROUTE columns present', () => {
  // Use a wide terminal so the host:port fits without truncation
  const wide = { columns: 140, rows: 24 };
  const lines = layout(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, wide);
  const header = lines.find((l) => /\bHOST\b/.test(l) && /\bTYPE\b/.test(l) && /\bROUTE\b/.test(l));
  assert.ok(header, 'column header includes HOST, TYPE and ROUTE columns');
  assert.match(header, /HOST\s+TYPE\s+ROUTE/);
  const row = lines.find((l) => l.includes('db-5432'));
  assert.match(row, /2222/); // db-5432's ssh port folded into HOST as root@db.internal:2222
});

const { paint } = require('../src/monitor');

test('paint: colors the whole connected state cell green and the daemon line by health; reverses the selected row', () => {
  const s = paint(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, SIZE, { color: true });
  assert.ok(s.startsWith('\x1b[H'));          // home cursor
  assert.match(s, /\x1b\[32m● connected/);     // whole "● connected" cell green, not just the glyph
  assert.match(s, /\x1b\[31m● daemon/);        // daemon line colored red (FULL has a failed tunnel)
  assert.match(s, /\x1b\[7m/);                 // reverse-video selected row
  assert.match(s, /\x1b\[J/);                  // clear-to-end at the bottom
});

test('paint: no ANSI color codes when color is disabled', () => {
  const s = paint(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false, flash: null }, SIZE, { color: false });
  assert.doesNotMatch(s, /\x1b\[3[123]m/);     // no fg-color codes
  assert.doesNotMatch(s, /\x1b\[7m/);          // no reverse
  assert.ok(s.startsWith('\x1b[H'));           // still positions the cursor
});

const { EventEmitter } = require('events');
const { runMonitor } = require('../src/monitor');

function fakeDeps(overrides = {}) {
  const calls = { start: [], stop: [], restart: [], setRawMode: [], pause: [], fetchCount: 0, fetchLogs: [] };
  const input = new EventEmitter();
  input.pause = () => calls.pause.push(true); // real stdin keeps the loop alive until paused
  const writes = [];
  const state = {
    daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' },
    tunnels: [
      { name: 'a', host: 'h1', state: 'connected', pid: 10, uptime: '1m', forwards: [] },
      { name: 'b', host: 'h2', state: 'connected', pid: 11, uptime: '2m', forwards: [] },
    ],
  };
  const deps = {
    fetchState: async () => { calls.fetchCount++; return state; },
    fetchLogs: async (name, n) => { calls.fetchLogs.push({ name, n }); return [{ ts: 1000, line: 'hello' }]; },
    start: async (n) => { calls.start.push(n); },
    stop: async (n) => { calls.stop.push(n); },
    restart: async (n) => { calls.restart.push(n); },
    input,
    output: { write: (s) => writes.push(s), columns: 100, rows: 24 },
    setRawMode: (b) => calls.setRawMode.push(b),
    now: () => 1000,
    schedule: () => 1,        // no auto-tick in the test
    cancel: () => {},
    installSignals: false,
    color: false,
    ...overrides,
  };
  return { deps, input, writes, calls, state };
}

const flush = () => new Promise((r) => setImmediate(r));

test('runMonitor: down + x + y stops the second tunnel, then q quits and restores', async () => {
  const { deps, input, writes, calls } = fakeDeps();
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();                                  // initial fetch + paint
  input.emit('keypress', null, { name: 'down' }); // select 'b'
  await flush();
  input.emit('keypress', 'x', {});                // open stop confirm
  await flush();
  input.emit('keypress', 'y', {});                // confirm
  await flush();
  assert.deepEqual(calls.stop, ['b']);
  assert.ok(calls.fetchCount >= 2, 'an immediate refresh follows the action');
  input.emit('keypress', 'q', {});                // quit
  const code = await p;
  assert.equal(code, 0);
  assert.deepEqual(calls.setRawMode, [true, false]); // raw on at start, off on cleanup
  assert.deepEqual(calls.pause, [true]);          // input paused so the process can actually exit
  const tail = writes.join('');
  assert.match(tail, /\x1b\[\?25h/);              // cursor shown again
  assert.match(tail, /\x1b\[\?1049l/);            // left the alternate screen
});

test('runMonitor: quit calls deps.exit(0) synchronously (Windows quit-hang fix)', async () => {
  // The real cli passes process.exit here so `q` exits in the same tick as the
  // keypress, instead of relying on the resolve→await→process.exit path that
  // stalls for seconds on Windows after raw-mode teardown.
  const exits = [];
  const { deps, input } = fakeDeps({ exit: (c) => exits.push(c) });
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', 'q', {});
  const code = await p;
  assert.equal(code, 0);
  assert.deepEqual(exits, [0]); // exit hook fired exactly once with 0
});

test('runMonitor: actions are suppressed when the daemon is down', async () => {
  const { deps, input, calls } = fakeDeps({
    fetchState: async () => ({ daemon: { running: false }, tunnels: [{ name: 'a', host: 'h', state: 'daemon-stopped', pid: null, uptime: null, forwards: [] }] }),
  });
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', 'x', {});
  await flush();
  input.emit('keypress', 'y', {});
  await flush();
  assert.deepEqual(calls.stop, []);               // no stop attempted with daemon down
  input.emit('keypress', 'q', {});
  assert.equal(await p, 0);
});

test('runMonitor: a failing initial fetch does not wedge — paints and still restores on quit', async () => {
  let first = true;
  const { deps, input, calls } = fakeDeps({
    fetchState: async () => { if (first) { first = false; throw new Error('ipc boom'); } return { daemon: { running: false }, tunnels: [] }; },
  });
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  // The first fetch rejected, but raw mode is on and the promise is alive (not wedged).
  assert.deepEqual(calls.setRawMode, [true]);
  input.emit('keypress', 'q', {});
  assert.equal(await p, 0);
  assert.deepEqual(calls.setRawMode, [true, false]); // terminal restored on quit
});

const { renderLines } = require('../src/monitor');

const DETAIL_STATE = {
  daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' },
  tunnels: [
    { name: 'db-5432', host: 'root@db.internal', state: 'failed', pid: null, restarts: 4,
      lastExitCode: 255, uptime: null, port: 22,
      lastError: 'ssh: connect to host db.internal port 22: timed out',
      forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 5432, destHost: 'localhost', destPort: 5432 }] },
  ],
};
const DETAIL_UI = { view: 'detail', selectedName: 'db-5432', confirm: null, help: false, flash: null, logScroll: 0 };
const LOGS = [
  { ts: new Date(2020, 0, 1, 12, 1, 3).getTime(), line: 'state -> retrying' },
  { ts: new Date(2020, 0, 1, 12, 1, 5).getTime(), line: 'ssh: connect to host db.internal port 22: timed out' },
  { ts: new Date(2020, 0, 1, 12, 1, 5).getTime(), line: 'state -> failed' },
];

test('renderLines detail: header, info block and newest log line', () => {
  const t = renderLines(DETAIL_STATE, DETAIL_UI, SIZE, { logs: LOGS }).join('\n');
  assert.match(t, /tunlite ▸ db-5432/);
  assert.match(t, /state\s+✕ failed/);
  assert.match(t, /restarts\s+4/);
  assert.match(t, /exit\s+255/);
  assert.match(t, /root@db\.internal/);
  assert.match(t, /listen\s+127\.0\.0\.1:5432 \(local\)/);
  assert.match(t, /target\s+localhost:5432 \(reachable from server\)/);
  assert.match(t, /error\s+ssh: connect/);
  assert.match(t, /recent logs/);
  assert.match(t, /12:01:05 state -> failed/);
});

test('renderLines detail: shows the ssh connect port and a copy-paste add command', () => {
  const t = renderLines(DETAIL_STATE, DETAIL_UI, SIZE, { logs: LOGS }).join('\n');
  assert.match(t, /ssh\s+port 22/);
  assert.match(t, /add \(copy\):/);
  assert.match(t, /tunlite add local db-5432 --to root@db\.internal --remote 5432/);
});

test('renderLines detail: a long add command wraps with backslash continuations, no ellipsis', () => {
  const long = { ...DETAIL_STATE.tunnels[0], port: 2222, identityFile: '~/.ssh/id_ed25519' };
  const st = { ...DETAIL_STATE, tunnels: [long] };
  const lines = renderLines(st, DETAIL_UI, { columns: 56, rows: 30 }, { logs: [] });
  const i = lines.findIndex((l) => /add \(copy\):/.test(l));
  assert.ok(i >= 0, 'has the add label');
  const end = lines.findIndex((l) => /recent logs/.test(l));   // command block only, not the footer
  const block = lines.slice(i + 1, end).join('\n');
  assert.doesNotMatch(block, /…/);                  // command itself is never ellipsis-truncated
  assert.match(lines[i + 1], /\\\s*$/);             // first command line continues
  assert.match(block, /~\/\.ssh\/id_ed25519/);      // a tail flag that would've been cut survives (may wrap)
  assert.match(block, /root@db\.internal:2222/);    // SSH port now rides in --to host:port
});

test('renderLines detail: empty logs show a no-logs note', () => {
  const t = renderLines(DETAIL_STATE, DETAIL_UI, SIZE, { logs: [] }).join('\n');
  assert.match(t, /\(no logs\)/);
});

test('renderLines detail: scrolling up shows older log lines (logRows == 1)', () => {
  // detailRows=15 (tunnelDetailRows for this fixture) + 1 add label + 1 add cmd = 17 infoRows
  // fixed = 1+1+17+1+1+1 = 22; logRows = rows - 22; for logRows=1, need rows=23
  const tiny = { columns: 100, rows: 23 };
  const at0 = renderLines(DETAIL_STATE, { ...DETAIL_UI, logScroll: 0 }, tiny, { logs: LOGS }).join('\n');
  assert.match(at0, /12:01:05 state -> failed/);     // newest pinned at bottom
  const at1 = renderLines(DETAIL_STATE, { ...DETAIL_UI, logScroll: 1 }, tiny, { logs: LOGS }).join('\n');
  assert.match(at1, /12:01:05 ssh: connect/);        // one line up
  assert.doesNotMatch(at1, /12:01:05 state -> failed/);
});

test('renderLines detail: too small shows the fallback', () => {
  const t = renderLines(DETAIL_STATE, DETAIL_UI, { columns: 100, rows: 8 }, { logs: LOGS }).join('\n');
  assert.match(t, /terminal too small/);
});

test('renderLines detail help lists the detail keys', () => {
  const t = renderLines(DETAIL_STATE, { ...DETAIL_UI, help: true }, SIZE, { logs: LOGS }).join('\n');
  assert.match(t, /scroll/);
  assert.match(t, /back/);
  assert.match(t, /quit/);
});

test('paint detail: colors the failed state cell red', () => {
  const s = paint(DETAIL_STATE, DETAIL_UI, SIZE, { color: true, logs: LOGS });
  assert.match(s, /\x1b\[31m✕ failed/);
});

const { clampScroll } = require('../src/monitor');

test('runMonitor: enter opens detail and fetches logs for the selected tunnel', async () => {
  const { deps, input, calls } = fakeDeps();
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();                                    // initial fetch (list view, no log fetch)
  assert.equal(calls.fetchLogs.length, 0);
  input.emit('keypress', null, { name: 'return' }); // enter -> detail
  await flush();
  assert.ok(calls.fetchLogs.length >= 1, 'logs fetched on drill-in');
  assert.equal(calls.fetchLogs[0].name, 'a');
  input.emit('keypress', 'q', {});
  assert.equal(await p, 0);
});

test('runMonitor: escape leaves detail and stops fetching logs', async () => {
  const { deps, input, calls } = fakeDeps();
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', null, { name: 'return' }); // enter detail
  await flush();
  const before = calls.fetchLogs.length;
  input.emit('keypress', null, { name: 'escape' }); // back to list
  await flush();
  input.emit('keypress', null, { name: 'down' });   // list nav must not fetch logs
  await flush();
  assert.equal(calls.fetchLogs.length, before);
  input.emit('keypress', 'q', {});
  await p;
});

test('runMonitor: scrolling in detail does not refetch logs', async () => {
  const { deps, input, calls } = fakeDeps();
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', null, { name: 'return' });
  await flush();
  const before = calls.fetchLogs.length;
  input.emit('keypress', null, { name: 'up' });
  await flush();
  input.emit('keypress', null, { name: 'up' });
  await flush();
  assert.equal(calls.fetchLogs.length, before, 'scroll keys reuse logs in hand');
  input.emit('keypress', 'q', {});
  await p;
});

test('runMonitor: a rejecting fetchLogs does not wedge the detail view', async () => {
  const { deps, input } = fakeDeps({ fetchLogs: async () => { throw new Error('logs boom'); } });
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', null, { name: 'return' }); // enter detail -> fetchLogs throws
  await flush();
  input.emit('keypress', 'q', {});                  // still quits cleanly
  assert.equal(await p, 0);
});

test('clampScroll caps logScroll to the visible window and is a no-op off detail', () => {
  const size = { columns: 100, rows: 24 };
  const listUi = { view: 'list', selectedName: 'db-5432', logScroll: 5 };
  assert.equal(clampScroll(listUi, [], size, DETAIL_STATE), listUi); // off detail: unchanged ref
  const ui = { view: 'detail', selectedName: 'db-5432', logScroll: 999 };
  const logs = Array.from({ length: 2 }, (_, i) => ({ ts: 1000, line: `l${i}` }));
  const out = clampScroll(ui, logs, size, DETAIL_STATE);             // 2 logs, big window -> max 0
  assert.equal(out.logScroll, 0);
});

test('renderLines detail: multiple forwards each get a row and logs still fit', () => {
  const multi = {
    daemon: { running: true, pid: 1, version: '0.2.0', uptime: '1m' },
    tunnels: [{
      name: 'multi', host: 'root@h', state: 'connected', pid: 7, restarts: 0,
      lastExitCode: null, uptime: '5m', lastError: null,
      forwards: [
        { type: 'local', bind: '127.0.0.1', srcPort: 5432, destHost: 'localhost', destPort: 5432 },
        { type: 'remote', bind: '0.0.0.0', srcPort: 8080, destHost: 'localhost', destPort: 80 },
      ],
    }],
  };
  const ui = { view: 'detail', selectedName: 'multi', confirm: null, help: false, flash: null, logScroll: 0 };
  // detailRows=17 (state,host,ssh + 3*local + 3*remote + pid,up,restarts,exit,identity,options,autokey,enabled)
  // infoRows=19, fixed=22; need rows>=23 for logRows>=1; use 30 for comfort
  const t = renderLines(multi, ui, { columns: 100, rows: 30 }, { logs: LOGS }).join('\n');
  assert.match(t, /listen\s+127\.0\.0\.1:5432 \(local\)/);
  assert.match(t, /listen\s+0\.0\.0\.0:8080 \(on server\)/);
  assert.match(t, /12:01:05 state -> failed/); // newest log still rendered: logRows accounts for both forwards
});

// ---- left/right view switching -----------------------------------------
test('normalizeKey maps left/right arrows', () => {
  assert.equal(normalizeKey(null, { name: 'left' }), 'left');
  assert.equal(normalizeKey(null, { name: 'right' }), 'right');
});

test('list + right enters detail; detail + left returns to list', () => {
  const r = reduce(UI, 'right', STATE);
  assert.equal(r.ui.view, 'detail');
  assert.equal(r.ui.logScroll, 0);
  assert.equal(r.action, null);
  const back = reduce({ ...UI, view: 'detail', logScroll: 2 }, 'left', STATE);
  assert.equal(back.ui.view, 'list');
});

test('list + left and detail + right are inert', () => {
  assert.notEqual(reduce(UI, 'left', STATE).ui.view, 'detail'); // list + left stays in list
  const d = { ...UI, view: 'detail', logScroll: 2 };
  const r = reduce(d, 'right', STATE);
  assert.equal(r.ui.view, 'detail');     // detail + right stays in detail
  assert.equal(r.ui.logScroll, 2);       // and doesn't disturb scroll
});

test('list + right is a no-op with an empty tunnel list', () => {
  const empty = { daemon: { running: true }, tunnels: [] };
  const ui = { selectedName: null, confirm: null, help: false, flash: null };
  assert.notEqual(reduce(ui, 'right', empty).ui.view, 'detail');
});

// ---- flicker-free repaint (frameDelta) ---------------------------------
const { frameDelta } = require('../src/monitor');

test('frameDelta: no prior frame or row-count change → full repaint', () => {
  const full = frameDelta(null, ['a', 'b', 'c']);
  assert.ok(full.startsWith('\x1b[H'));
  assert.ok(full.endsWith('\x1b[J'));
  assert.match(full, /a\x1b\[K/);
  const grew = frameDelta(['a', 'b'], ['a', 'b', 'c']);
  assert.ok(grew.startsWith('\x1b[H'));
  assert.ok(grew.endsWith('\x1b[J'));
});

test('frameDelta: identical frames produce no output', () => {
  assert.equal(frameDelta(['a', 'b', 'c'], ['a', 'b', 'c']), '');
});

test('frameDelta: only changed rows are rewritten, absolutely positioned', () => {
  const out = frameDelta(['h', 'x', 'c'], ['h', 'y', 'c']);
  assert.equal(out, '\x1b[2;1Hy\x1b[K');   // only row 2 (1-based) changed
  assert.doesNotMatch(out, /\x1b\[H/);     // not a full-screen repaint
});

test('runMonitor: a per-tick content change repaints only the changed row (no full-frame flicker)', async () => {
  let tickFn = null;
  let up = '5m20s';
  const dynState = () => ({
    daemon: { running: true, pid: 1, version: '0.3.2', uptime: '2h' },
    tunnels: [{ name: 'a', host: 'h', state: 'connected', pid: 10, restarts: 0, lastExitCode: null, uptime: up, lastError: null, forwards: [] }],
  });
  const { deps, input, writes } = fakeDeps({
    fetchState: async () => dynState(),
    schedule: (fn) => { tickFn = fn; return 1; },
  });
  const p = runMonitor({ out: deps.output, err: { write() {} } }, deps, { intervalMs: 1000 });
  await flush();
  input.emit('keypress', null, { name: 'return' }); // enter detail
  await flush(); await flush();
  writes.length = 0;
  up = '5m21s';                                       // one cell changes
  tickFn(); await flush(); await flush();
  const delta = writes.join('');
  assert.doesNotMatch(delta, /\x1b\[H/);              // NOT a full-screen repaint
  assert.match(delta, /\x1b\[\d+;1H/);                // an absolutely-positioned row rewrite
  assert.ok(delta.length < 120, `expected a partial update, got ${delta.length} bytes`);
  input.emit('keypress', 'q', {});
  await p;
});

test('monitor list header uses the unified columns (TYPE/ROUTE/RESTARTS, no SSH)', () => {
  const lines = layout(FULL, { selectedName: 'tmux-prod-19999', confirm: null, help: false }, { columns: 100, rows: 24 });
  const header = lines.find((l) => /NAME/.test(l) && /STATE/.test(l));
  assert.ok(header, 'has a column header');
  assert.match(header, /TYPE/);
  assert.match(header, /ROUTE/);
  assert.match(header, /RESTARTS/);
  assert.doesNotMatch(header, /\bSSH\b/);
});
