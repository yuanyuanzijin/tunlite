'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autostart = require('../src/autostart');
const install = require('../src/install');

const ctx = autostart.context({ nodePath: '/usr/local/bin/node', entry: '/opt/tunlite/bin/tunlite.js', logDir: '/var/log/tunlite' });

test('launchd plist contains label, args, keepalive', () => {
  const { path: p, content } = autostart.launchd.render(ctx);
  assert.ok(p.endsWith('io.github.yuanyuanzijin.tunlite.plist'));
  assert.ok(content.includes('<string>io.github.yuanyuanzijin.tunlite</string>'));
  assert.ok(content.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(content.includes('<string>/opt/tunlite/bin/tunlite.js</string>'));
  assert.ok(content.includes('<string>daemon</string>'));
  assert.ok(content.includes('<key>KeepAlive</key>'));
  assert.ok(content.includes('<key>RunAtLoad</key>'));
});

test('launchd parseRunning treats a live pid as running, not just state=running', () => {
  const { parseRunning } = autostart.launchd;
  // classic wording
  assert.equal(parseRunning('\tstate = running\n'), true);
  // newer/alternate wording where the state line differs but a live pid is shown
  assert.equal(parseRunning('\tstate = waiting\n\tpid = 12345\n'), true);
  assert.equal(parseRunning('foo\n  pid = 7\nbar'), true);
  // not running: no running state and no pid
  assert.equal(parseRunning('\tstate = not running\n'), false);
  assert.equal(parseRunning(''), false);
  assert.equal(parseRunning(undefined), false);
  // a bare `pid` mention without a number must not count
  assert.equal(parseRunning('last exit pid = (none)\n'), false);
});

test('systemd unit has ExecStart and Restart=always', () => {
  const { path: p, content } = autostart.systemd.render(ctx);
  // Default unit name is the short `tunlite.service` (not the reverse-DNS launchd
  // label) — pin the basename exactly so the default can't silently drift.
  assert.equal(path.basename(p), 'tunlite.service');
  assert.ok(content.includes('ExecStart=/usr/local/bin/node /opt/tunlite/bin/tunlite.js daemon run'));
  assert.ok(content.includes('Restart=always'));
  assert.ok(content.includes('WantedBy=default.target'));
});

test('systemd unit name derives from ctx (explicit ctx honored, not the live env)', () => {
  // An explicit ctx with a custom systemdUnit must drive the unit name even when
  // no TUNLITE_SERVICE_LABEL is set in the environment — proving the adapter
  // reads ctx, not process.env directly (the bug this fix closed).
  const prev = process.env.TUNLITE_SERVICE_LABEL;
  delete process.env.TUNLITE_SERVICE_LABEL;
  try {
    const custom = { ...ctx, systemdUnit: 'com.example.sandbox', systemdDir: '/tmp/tl-systemd' };
    const { path: p } = autostart.systemd.render(custom);
    assert.equal(p, '/tmp/tl-systemd/com.example.sandbox.service');
    // And the default ctx (no override) is unchanged — short name, conventional dir.
    const def = autostart.context({ nodePath: '/n', entry: '/e', logDir: '/l' });
    assert.equal(def.systemdUnit, 'tunlite');
    assert.equal(path.basename(autostart.systemd.render(def).path), 'tunlite.service');
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_SERVICE_LABEL; else process.env.TUNLITE_SERVICE_LABEL = prev;
  }
});

test('windows task command is quoted', () => {
  const { content } = autostart.windows.render(ctx);
  assert.equal(content, '"/usr/local/bin/node" "/opt/tunlite/bin/tunlite.js" daemon run');
});

test('adapterFor picks the right platform', () => {
  assert.equal(autostart.adapterFor('darwin'), autostart.launchd);
  assert.equal(autostart.adapterFor('linux'), autostart.systemd);
  assert.equal(autostart.adapterFor('win32'), autostart.windows);
  assert.throws(() => autostart.adapterFor('sunos'));
});

test('TUNLITE_SERVICE_LABEL + TUNLITE_LAUNCH_AGENTS_DIR isolate the service identity', () => {
  const prevLabel = process.env.TUNLITE_SERVICE_LABEL;
  const prevDir = process.env.TUNLITE_LAUNCH_AGENTS_DIR;
  process.env.TUNLITE_SERVICE_LABEL = 'com.tunlite.sandbox';
  process.env.TUNLITE_LAUNCH_AGENTS_DIR = '/tmp/tunlite-sandbox-agents';
  try {
    const c = autostart.context();
    assert.equal(c.label, 'com.tunlite.sandbox');
    const { path: p } = autostart.launchd.render(c);
    assert.equal(p, '/tmp/tunlite-sandbox-agents/com.tunlite.sandbox.plist');
    assert.ok(!p.includes('io.github.yuanyuanzijin.tunlite'), 'must not reference the real label');
  } finally {
    if (prevLabel === undefined) delete process.env.TUNLITE_SERVICE_LABEL; else process.env.TUNLITE_SERVICE_LABEL = prevLabel;
    if (prevDir === undefined) delete process.env.TUNLITE_LAUNCH_AGENTS_DIR; else process.env.TUNLITE_LAUNCH_AGENTS_DIR = prevDir;
  }
});

test('autostart context prefers manifest nodePath + lib entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ctx-'));
  const prev = process.env.TUNLITE_HOME; process.env.TUNLITE_HOME = home;
  try {
    install.writeManifest({ libDir: '/lib/tunlite', binDir: '/usr/local/bin', nodePath: '/usr/local/bin/node', version: '9.9.9' });
    const ctx = autostart.context();
    assert.equal(ctx.nodePath, '/usr/local/bin/node');
    assert.equal(ctx.entry, path.join('/lib/tunlite', 'bin', 'tunlite.js'));
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev;
  }
});

test('TUNLITE_FAKE_AUTOSTART forces the no-op sandbox adapter (never touches the real OS)', () => {
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    assert.equal(autostart.adapterFor('darwin'), autostart.sandbox);
    assert.equal(autostart.adapterFor('linux'), autostart.sandbox);
    assert.equal(autostart.adapterFor('win32'), autostart.sandbox);
    assert.equal(autostart.sandbox.uninstall().removed, false);
    assert.equal(autostart.sandbox.status().installed, false);
  } finally {
    delete process.env.TUNLITE_FAKE_AUTOSTART;
  }
});
