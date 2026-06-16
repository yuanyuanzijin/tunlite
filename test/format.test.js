'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatDuration, clockTime, stateStyle, serviceHealth, colorize, buildAddCommand } = require('../src/format');

test('stateStyle maps each state to a glyph + color, falls back for unknown', () => {
  assert.deepEqual(stateStyle('connected'), { glyph: '●', color: 'green', label: 'connected' });
  assert.deepEqual(stateStyle('starting'), { glyph: '◌', color: 'yellow', label: 'starting' });
  assert.deepEqual(stateStyle('retrying'), { glyph: '◌', color: 'yellow', label: 'retrying' });
  assert.deepEqual(stateStyle('needs-auth'), { glyph: '⚠', color: 'red', label: 'needs-auth' });
  assert.deepEqual(stateStyle('failed'), { glyph: '✕', color: 'red', label: 'failed' });
  assert.deepEqual(stateStyle('idle'), { glyph: '○', color: 'dim', label: 'idle' });
  assert.deepEqual(stateStyle('daemon-stopped'), { glyph: '○', color: 'dim', label: 'daemon-stopped' });
});

test('serviceHealth: red when down or any problem, yellow when starting, else green', () => {
  assert.equal(serviceHealth(false, []), 'red');                                  // daemon down
  assert.equal(serviceHealth(true, []), 'green');                                 // up, nothing to do
  assert.equal(serviceHealth(true, [{ state: 'connected' }]), 'green');
  assert.equal(serviceHealth(true, [{ state: 'connected' }, { state: 'starting' }]), 'yellow');
  assert.equal(serviceHealth(true, [{ state: 'retrying' }]), 'yellow');
  assert.equal(serviceHealth(true, [{ state: 'starting' }, { state: 'failed' }]), 'red'); // problem wins
  assert.equal(serviceHealth(true, [{ state: 'needs-auth' }]), 'red');
});

test('colorize wraps in an SGR pair only when enabled and the color is known', () => {
  assert.equal(colorize('x', 'green', true), '\x1b[32mx\x1b[0m');
  assert.equal(colorize('x', 'red', true), '\x1b[31mx\x1b[0m');
  assert.equal(colorize('x', 'green', false), 'x');
  assert.equal(colorize('x', 'nope', true), 'x');
});

test('formatDuration carries s -> m -> h -> d, two-segment compact', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45 * 1000), '45s');
  assert.equal(formatDuration(90 * 1000), '1m30s');
  assert.equal(formatDuration(180 * 1000), '3m');
  assert.equal(formatDuration(10032 * 1000), '2h47m');   // 2h47m12s -> 2h47m
  assert.equal(formatDuration(26 * 3600 * 1000), '1d2h'); // 26h -> 1d2h
  assert.equal(formatDuration(2 * 86400 * 1000), '2d');
  assert.equal(formatDuration(3 * 3600 * 1000), '3h');    // exactly 3h, no minutes
});

test('clockTime formats a timestamp as local HH:MM:SS, zero-padded', () => {
  assert.equal(clockTime(new Date(2020, 0, 1, 13, 5, 9).getTime()), '13:05:09');
  assert.equal(clockTime(new Date(2020, 0, 1, 0, 0, 0).getTime()), '00:00:00');
  assert.equal(clockTime(new Date(2020, 0, 1, 9, 30, 0).getTime()), '09:30:00');
});

test('buildAddCommand: minimal local — default port, bind, host and listen port omitted', () => {
  const cmd = buildAddCommand({
    name: 'db-5432', host: 'root@db.internal', port: 22,
    forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 5432, destHost: 'localhost', destPort: 5432 }],
  });
  assert.equal(cmd, 'tunlite add local db-5432 --to root@db.internal --remote 5432');
});

test('buildAddCommand: remote with SSH :port, identity, server bind, ssh-opt, disabled', () => {
  const cmd = buildAddCommand({
    name: 'tmux', host: 'root@example.com', port: 2222, identityFile: '~/.ssh/id_ed25519',
    forwards: [{ type: 'remote', bind: '0.0.0.0', srcPort: 19999, destHost: 'localhost', destPort: 19999 }],
    sshOptions: ['ServerAliveInterval=15'], enabled: false,
  });
  assert.equal(cmd,
    'tunlite add remote tmux --to root@example.com:2222 --local 19999 --remote 0.0.0.0:19999 '
    + '-i ~/.ssh/id_ed25519 --ssh-opt ServerAliveInterval=15 --disabled');
});

test('buildAddCommand: dynamic — default port+bind dropped, non-default bind kept', () => {
  assert.equal(
    buildAddCommand({ name: 's', host: 'h', port: 22, forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }] }),
    'tunlite add dynamic s --to h');
  assert.equal(
    buildAddCommand({ name: 's', host: 'h', port: 22, forwards: [{ type: 'dynamic', bind: '0.0.0.0', srcPort: 1080 }] }),
    'tunlite add dynamic s --to h --local 0.0.0.0:1080');
});

test('buildAddCommand: local with a distinct local port and --no-auto-key', () => {
  const cmd = buildAddCommand({
    name: 'web', host: 'u@h', port: 22, autoSetupKey: false,
    forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'localhost', destPort: 80 }],
  });
  assert.equal(cmd, 'tunlite add local web --to u@h --remote 80 --local 8080 --no-auto-key');
});

test('buildAddCommand: values with spaces/specials get single-quoted', () => {
  const cmd = buildAddCommand({
    name: 'weird name', host: 'u@h', port: 22, forwards: [],
    sshOptions: ['ProxyCommand=ssh -W %h:%p jump'],
  });
  assert.match(cmd, /tunlite add 'weird name' --to u@h/);
  assert.match(cmd, /--ssh-opt 'ProxyCommand=ssh -W %h:%p jump'/);
});

const {
  hostWithPort, forwardType, forwardRoute, forwardTypes, forwardRoutes,
  TUNNEL_COLUMNS, renderTunnelTable, tunnelDetailRows, checkStyle, fit,
} = require('../src/format');

const LOCAL = { name: 'web', host: 'me@h', port: 22, state: 'connected', pid: 5, uptime: '3m', restarts: 0,
  forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: '10.0.0.5', destPort: 80 }] };
const REMOTE = { name: 'rev', host: 'me@h', port: 2222, state: 'failed', restarts: 2, lastError: 'bind failed',
  forwards: [{ type: 'remote', bind: '0.0.0.0', srcPort: 9000, destHost: 'localhost', destPort: 3000 }] };
const SOCKS = { name: 'sk', host: 'me@h', port: 22, state: 'connected', restarts: 0,
  forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }] };

test('fit pads and truncates to width', () => {
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('abcdef', 4), 'abc…');
});

test('hostWithPort appends :port only when ssh port != 22', () => {
  assert.equal(hostWithPort(LOCAL), 'me@h');
  assert.equal(hostWithPort(REMOTE), 'me@h:2222');
});

test('forwardType/forwardRoute expose the real type and endpoints', () => {
  assert.equal(forwardType(LOCAL.forwards[0]), 'local');
  assert.equal(forwardRoute(LOCAL.forwards[0]), '127.0.0.1:8080 → 10.0.0.5:80');
  assert.equal(forwardRoute(SOCKS.forwards[0]), '127.0.0.1:1080');
  assert.equal(forwardTypes(SOCKS), 'dynamic');
  assert.equal(forwardRoutes(REMOTE), '0.0.0.0:9000 → localhost:3000');
});

test('TUNNEL_COLUMNS headers and order', () => {
  assert.deepEqual(TUNNEL_COLUMNS.map((c) => c.header),
    ['NAME', 'STATE', 'HOST', 'TYPE', 'ROUTE', 'PID', 'UP', 'RESTARTS']);
});

test('renderTunnelTable: header + a row, plain (no color)', () => {
  const lines = renderTunnelTable([LOCAL], { color: false });
  assert.match(lines[0], /NAME/);
  assert.match(lines[0], /TYPE/);
  assert.match(lines[0], /ROUTE/);
  assert.match(lines[1], /web/);
  assert.match(lines[1], /local/);
});

test('renderTunnelTable: error row gets a dim sub-line', () => {
  const lines = renderTunnelTable([REMOTE], { color: false });
  assert.ok(lines.some((l) => l.includes('↳') && l.includes('bind failed')));
});

test('tunnelDetailRows: full field set with per-type side notes', () => {
  const rows = tunnelDetailRows(LOCAL);
  const by = Object.fromEntries(rows.map((r) => [r[0], r[1]]));
  assert.equal(by.type, 'local');
  assert.match(by.listen, /127\.0\.0\.1:8080 \(local\)/);
  assert.match(by.target, /10\.0\.0\.5:80 \(reachable from server\)/);
  assert.equal(by.enabled, 'yes');
  assert.equal(by.autokey, 'on');
  assert.ok(!rows.some((r) => r[0] === 'error')); // no error row when lastError null
  const rrows = tunnelDetailRows(REMOTE);
  const rby = Object.fromEntries(rrows.map((r) => [r[0], r[1]]));
  assert.match(rby.listen, /0\.0\.0\.0:9000 \(on server\)/);
  assert.match(rby.target, /localhost:3000 \(on this machine\)/);
  assert.ok(rrows.some((r) => r[0] === 'error' && r[1] === 'bind failed'));
  const srows = tunnelDetailRows(SOCKS);
  assert.ok(!srows.some((r) => r[0] === 'target')); // dynamic has no target row
});

test('tunnelDetailRows: tags row shown only when tags are present', () => {
  assert.ok(!tunnelDetailRows(LOCAL).some((r) => r[0] === 'tags')); // none -> no row
  const rows = tunnelDetailRows({ ...LOCAL, tags: ['work', 'prod'] });
  const by = Object.fromEntries(rows.map((r) => [r[0], r[1]]));
  assert.equal(by.tags, 'work, prod');
});

test('checkStyle maps statuses to glyph+color', () => {
  assert.deepEqual(checkStyle('ok'), { glyph: '✓', color: 'green' });
  assert.deepEqual(checkStyle('warn'), { glyph: '!', color: 'yellow' });
  assert.deepEqual(checkStyle('fail'), { glyph: '✗', color: 'red' });
  assert.deepEqual(checkStyle('info'), { glyph: '·', color: 'dim' });
  assert.deepEqual(checkStyle('skip'), { glyph: '·', color: 'dim' });
});
