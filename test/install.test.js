'use strict';
const test = require('node:test');
const assert = require('node:assert');
const install = require('../src/install');

// ── Task 2: pickStableNode ────────────────────────────────────────────────────

test('pickStableNode: $TUNLITE_NODE override wins', () => {
  const r = install.pickStableNode({ env: { TUNLITE_NODE: '/opt/node/bin/node' }, existsSync: () => false });
  assert.equal(r.path, '/opt/node/bin/node');
  assert.equal(r.source, 'override');
});

test('pickStableNode: prefers a system node over the current nvm node', () => {
  const r = install.pickStableNode({
    env: {},
    execPath: '/Users/me/.nvm/versions/node/v20.0.0/bin/node',
    existsSync: (p) => p === '/usr/local/bin/node',
  });
  assert.equal(r.path, '/usr/local/bin/node');
  assert.equal(r.source, 'system');
});

test('pickStableNode: falls back to current node with a warning when only nvm exists', () => {
  const r = install.pickStableNode({
    env: {},
    execPath: '/Users/me/.nvm/versions/node/v20.0.0/bin/node',
    existsSync: () => false,
  });
  assert.equal(r.path, '/Users/me/.nvm/versions/node/v20.0.0/bin/node');
  assert.equal(r.source, 'version-manager');
  assert.equal(r.warn, true);
});

test('pickStableNode: uses current node (no warning) when it is not version-managed', () => {
  const r = install.pickStableNode({ env: {}, execPath: '/usr/bin/node', existsSync: () => false });
  assert.equal(r.source, 'current');
  assert.ok(!r.warn);
});

// ── Task 3: writeLauncher ─────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

test('writeLauncher (posix) writes a pinned-node shim with a >=18 guard, executable', () => {
  if (os.platform() === 'win32') return; // posix shape
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-launch-'));
  const link = install.writeLauncher(dir, '/lib/tunlite/bin/tunlite.js', '/usr/local/bin/node', { platform: 'posix' });
  const body = fs.readFileSync(link, 'utf8');
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /\/usr\/local\/bin\/node/);
  assert.match(body, /\/lib\/tunlite\/bin\/tunlite\.js/);
  assert.match(body, /process\.versions\.node/);            // version guard present
  assert.ok(!fs.lstatSync(link).isSymbolicLink());          // NOT a symlink
  assert.ok((fs.statSync(link).mode & 0o111) !== 0);        // executable
});

test('writeLauncher (windows) writes a .cmd shim pinning node.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-launchw-'));
  const link = install.writeLauncher(dir, 'C:\\lib\\tunlite\\bin\\tunlite.js', 'C:\\nodejs\\node.exe', { platform: 'win32' });
  assert.ok(link.endsWith('tunlite.cmd'));
  const body = fs.readFileSync(link, 'utf8');
  assert.match(body, /node\.exe/);
  assert.match(body, /tunlite\.js/);
  assert.match(body, /process\.versions\.node/);   // >=18 guard present (mirrors posix)
  assert.match(body, /node"\)/);                    // falls back to `node` on PATH
});

// ── Task 4: copyRuntime ───────────────────────────────────────────────────────

test('copyRuntime stages, validates, and swaps the runtime into libDir', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-src-'));
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'bin', 'tunlite.js'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(src, 'src'));
  fs.writeFileSync(path.join(src, 'src', 'x.js'), 'module.exports={}\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"tunlite","version":"9.9.9"}\n');
  const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lib-')), 'tunlite');

  const r = install.copyRuntime(src, lib, { validate: () => 0 }); // stub node validation -> ok
  assert.equal(r.copied, true);
  assert.ok(fs.existsSync(path.join(lib, 'bin', 'tunlite.js')));
  assert.ok(fs.existsSync(path.join(lib, 'package.json')));
  assert.ok(!fs.existsSync(lib + '.new'));
});

test('copyRuntime is a no-op when src === libDir', () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-same-'));
  const r = install.copyRuntime(lib, lib, { validate: () => 0 });
  assert.equal(r.copied, false);
});

test('copyRuntime aborts and leaves no stage if validation fails', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-srcbad-'));
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'bin', 'tunlite.js'), 'x\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"tunlite","version":"9.9.9"}\n');
  const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-libbad-')), 'tunlite');
  assert.throws(() => install.copyRuntime(src, lib, { validate: () => 1 }), /validation/);
  assert.ok(!fs.existsSync(lib + '.new'));
});

test('copyRuntime self-heals an interrupted swap (libDir missing, libDir.old present)', () => {
  // Simulate a crash between the two renames of a prior swap: the real runtime is
  // stranded at libDir.old and libDir itself is gone. A fresh copyRuntime must
  // restore libDir from libDir.old at the START, before staging, then complete a
  // clean swap. On the happy path the recovered runtime is replaced by src and
  // .old is cleaned up.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-srcheal-'));
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'bin', 'tunlite.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"tunlite","version":"9.9.9"}\n');

  const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-libheal-')), 'tunlite');
  // The stranded copy: libDir.old holds the previous (interrupted) runtime; libDir is absent.
  fs.mkdirSync(lib + '.old', { recursive: true });
  fs.writeFileSync(path.join(lib + '.old', 'marker'), 'stranded\n');
  assert.ok(!fs.existsSync(lib));

  const r = install.copyRuntime(src, lib, { validate: () => 0 });
  assert.equal(r.copied, true);
  assert.ok(fs.existsSync(path.join(lib, 'bin', 'tunlite.js')), 'libDir restored + repopulated');
  assert.ok(!fs.existsSync(lib + '.old'), 'stale .old cleaned up after a successful swap');
  assert.ok(!fs.existsSync(lib + '.new'));
});

test('copyRuntime restores libDir from libDir.old even if the new staging fails validation', () => {
  // The key recovery guarantee: with libDir missing and libDir.old present, a
  // copyRuntime whose new staging fails validation must still have restored the
  // stranded runtime to libDir (the old code deleted .old, leaving nothing).
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-srcfail-'));
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'bin', 'tunlite.js'), 'x\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"tunlite","version":"9.9.9"}\n');

  const lib = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-libfail-')), 'tunlite');
  fs.mkdirSync(lib + '.old', { recursive: true });
  fs.writeFileSync(path.join(lib + '.old', 'marker'), 'stranded\n');
  assert.ok(!fs.existsSync(lib));

  assert.throws(() => install.copyRuntime(src, lib, { validate: () => 1 }), /validation/);
  // Recovered: libDir now exists with the previously-stranded content.
  assert.ok(fs.existsSync(path.join(lib, 'marker')), 'libDir restored from libDir.old before staging');
  assert.equal(fs.readFileSync(path.join(lib, 'marker'), 'utf8'), 'stranded\n');
});

// ── Task 5: manifest + isAnchored ────────────────────────────────────────────

test('writeManifest/readManifest round-trip; isAnchored matches libDir', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-man-')), 'install.json');
  const lib = '/lib/tunlite';
  install.writeManifest({ libDir: lib, binDir: '/usr/local/bin', nodePath: '/usr/local/bin/node', version: '9.9.9' }, { file });
  const m = install.readManifest({ file });
  assert.equal(m.libDir, lib);
  assert.equal(m.version, '9.9.9');
  assert.equal(install.isAnchored({ file, dir: lib }), true);
  assert.equal(install.isAnchored({ file, dir: '/somewhere/node_modules/tunlite' }), false);
});

test('readManifest returns null when absent', () => {
  assert.equal(install.readManifest({ file: '/no/such/install.json' }), null);
});

// ── Task 6: cleanupLegacy ─────────────────────────────────────────────────────

test('cleanupLegacy is a no-op under TUNLITE_FAKE_AUTOSTART', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    let called = false;
    const r = install.cleanupLegacy({ spawnSync: () => { called = true; return { status: 0, stdout: '' }; } });
    assert.equal(r.skipped, true);
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

test('cleanupLegacy uninstalls a prior npm-global tunlite, never touches tunl', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  delete process.env.TUNLITE_FAKE_AUTOSTART;
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('ls')) return { status: 0, stdout: '{"dependencies":{"tunlite":{"version":"0.4.0"}}}' };
    return { status: 0, stdout: '' };
  };
  try {
    const r = install.cleanupLegacy({ spawnSync });
    assert.ok(r.removed.includes('npm:tunlite'));
    assert.ok(calls.some((c) => c === 'npm uninstall -g tunlite'));
    assert.ok(!calls.some((c) => /tunl(\s|$)/.test(c.replace('tunlite', '')))); // never `tunl`
  } finally {
    if (prev !== undefined) process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

// ── Task 7: pickBinDir, isOnPath, anchor ─────────────────────────────────────

test('isOnPath detects the bin dir in PATH', () => {
  assert.equal(install.isOnPath('/usr/local/bin', { PATH: '/x:/usr/local/bin:/y' }), true);
  assert.equal(install.isOnPath('/opt/bin', { PATH: '/x:/y' }), false);
});

test('anchor() copies runtime, writes launcher + manifest, reports node source', () => {
  const repoRoot = path.join(__dirname, '..'); // the real repo: valid runtime to copy
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-anchor-'));
  const prevHome = process.env.TUNLITE_HOME;
  const prevFake = process.env.TUNLITE_FAKE_AUTOSTART;
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1'; // skip legacy cleanup
  try {
    const bin = path.join(home, 'bin');
    const r = install.anchor({ src: repoRoot, binDir: bin, env: { TUNLITE_NODE: process.execPath, PATH: bin } });
    assert.ok(fs.existsSync(path.join(r.libDir, 'bin', 'tunlite.js')));
    assert.ok(fs.existsSync(r.launcher));
    const m = install.readManifest();
    assert.equal(m.libDir, r.libDir);
    assert.equal(m.nodePath, process.execPath);
    assert.equal(r.onPath, true);
  } finally {
    if (prevHome === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prevHome;
    if (prevFake === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prevFake;
  }
});

// Regression for the Critical bug: `update` was dead on every real install
// because anchor() never wrote the `.tunlite-install` marker that
// detectInstallMethod keys on — so an anchored libDir read as 'source' and
// update refused. Assert a REAL anchor writes the marker AND that update's
// detector then classifies the libDir as 'installed'.
test('anchor() writes the .tunlite-install marker so update detects an anchored install', () => {
  const update = require('../src/update');
  const repoRoot = path.join(__dirname, '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-marker-'));
  const prevHome = process.env.TUNLITE_HOME;
  const prevFake = process.env.TUNLITE_FAKE_AUTOSTART;
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    const bin = path.join(home, 'bin');
    const r = install.anchor({ src: repoRoot, binDir: bin, env: { TUNLITE_NODE: process.execPath, PATH: bin } });
    assert.ok(fs.existsSync(path.join(r.libDir, '.tunlite-install')), 'marker file present in libDir');
    assert.equal(update.detectInstallMethod(r.libDir), 'installed', 'update detects the anchored libDir');
  } finally {
    if (prevHome === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prevHome;
    if (prevFake === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prevFake;
  }
});

// Regression: anchor() must remove a prior npm-global tunlite BEFORE writing the
// launcher. binDir can be the same dir npm uses for global bins (e.g.
// /usr/local/bin), so `npm uninstall -g tunlite` running AFTER writeLauncher
// would delete the launcher we just wrote ("update succeeded but tunlite
// vanished"). Inject a cleanupLegacy that nukes binDir/tunlite (mimicking npm's
// bin removal) and assert the launcher still exists afterward.
test('anchor() runs legacy cleanup before writing the launcher (npm uninstall cannot clobber it)', () => {
  if (os.platform() === 'win32') return; // posix launcher name is `tunlite`
  const repoRoot = path.join(__dirname, '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-clobber-'));
  const bin = path.join(home, 'bin');
  const prevHome = process.env.TUNLITE_HOME;
  const prevFake = process.env.TUNLITE_FAKE_AUTOSTART;
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  // Simulate `npm uninstall -g tunlite` deleting binDir/tunlite. If this runs
  // AFTER writeLauncher, the launcher is gone; if BEFORE, writeLauncher recreates it.
  const cleanupLegacy = () => { fs.rmSync(path.join(bin, 'tunlite'), { force: true }); return { removed: ['npm:tunlite'] }; };
  try {
    const r = install.anchor({ src: repoRoot, binDir: bin, env: { TUNLITE_NODE: process.execPath, PATH: bin }, cleanupLegacy });
    assert.ok(fs.existsSync(r.launcher), 'launcher survives the legacy npm cleanup');
  } finally {
    if (prevHome === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prevHome;
    if (prevFake === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prevFake;
  }
});

// ── ensureUserPath (Windows user-PATH auto-write) ────────────────────────────

test('ensureUserPath: posix is a no-op and never spawns', () => {
  let spawned = false;
  const r = install.ensureUserPath('/x/bin', { platform: 'posix', spawnSync: () => { spawned = true; } });
  assert.deepEqual(r, { applicable: false });
  assert.equal(spawned, false);
});

test('ensureUserPath: win32 skipped under TUNLITE_FAKE_AUTOSTART (never touches the registry)', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    let spawned = false;
    const r = install.ensureUserPath('C:\\x\\bin', { platform: 'win32', spawnSync: () => { spawned = true; } });
    assert.deepEqual(r, { applicable: false });
    assert.equal(spawned, false);
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

test('ensureUserPath: win32 appends via PowerShell user-scope SetEnvironmentVariable', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  delete process.env.TUNLITE_FAKE_AUTOSTART;
  const bin = 'C:\\Users\\jinlu\\AppData\\Local\\tunlite\\bin';
  let call;
  const spawnSync = (cmd, args) => { call = { cmd, args }; return { status: 0, stdout: 'changed\n' }; };
  try {
    const r = install.ensureUserPath(bin, { platform: 'win32', spawnSync });
    assert.deepEqual(r, { applicable: true, changed: true });
    assert.match(call.cmd, /powershell/i);
    const script = call.args[call.args.length - 1];
    assert.ok(script.includes(bin), 'script embeds the bin dir');
    assert.match(script, /SetEnvironmentVariable\('Path',[^)]*'User'\)/); // user scope, not setx
    assert.match(script, /-notcontains/);                                 // idempotency guard
  } finally {
    if (prev !== undefined) process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

test('ensureUserPath: win32 reports changed:false when already present', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  delete process.env.TUNLITE_FAKE_AUTOSTART;
  try {
    const r = install.ensureUserPath('C:\\x\\bin', { platform: 'win32', spawnSync: () => ({ status: 0, stdout: 'present\n' }) });
    assert.deepEqual(r, { applicable: true, changed: false });
  } finally {
    if (prev !== undefined) process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

test('ensureUserPath: win32 surfaces a failed write as an error (so the CLI can fall back)', () => {
  const prev = process.env.TUNLITE_FAKE_AUTOSTART;
  delete process.env.TUNLITE_FAKE_AUTOSTART;
  try {
    const r = install.ensureUserPath('C:\\x\\bin', { platform: 'win32', spawnSync: () => ({ status: 1, stderr: 'access denied' }) });
    assert.equal(r.applicable, true);
    assert.equal(r.changed, false);
    assert.match(r.error, /access denied/);
    // and when spawn itself throws (powershell missing)
    const r2 = install.ensureUserPath('C:\\x\\bin', { platform: 'win32', spawnSync: () => { throw new Error('spawn powershell ENOENT'); } });
    assert.match(r2.error, /ENOENT/);
  } finally {
    if (prev !== undefined) process.env.TUNLITE_FAKE_AUTOSTART = prev;
  }
});

// ── pickBinDir: injectable accessSync ─────────────────────────────────────────

test('pickBinDir: TUNLITE_BIN env var wins', () => {
  assert.equal(install.pickBinDir({ env: { TUNLITE_BIN: '/x' } }), '/x');
});

test('pickBinDir: access succeeds → returns /usr/local/bin', () => {
  if (os.platform() === 'win32') return;
  assert.equal(install.pickBinDir({ env: {}, accessSync: () => {} }), '/usr/local/bin');
});

test('pickBinDir: access throws → falls back to ~/.local/bin', () => {
  if (os.platform() === 'win32') return;
  assert.equal(
    install.pickBinDir({ env: {}, accessSync: () => { throw new Error('no'); } }),
    path.join(os.homedir(), '.local', 'bin'),
  );
});

// ── writeAlias (short `tun` alias) ────────────────────────────────────────────

test('writeAlias writes a `tun` launcher pointing at the same entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-alias-'));
  const r = install.writeAlias(dir, '/lib/bin/tunlite.js', process.execPath, { platform: 'posix' });
  assert.equal(r.written, true);
  assert.equal(r.name, 'tun');
  const content = fs.readFileSync(path.join(dir, 'tun'), 'utf8');
  assert.match(content, /tunlite/);            // carries our marker (so uninstall can recognize it)
  assert.match(content, /tunlite\.js/);        // points at the entry
});

test('writeAlias refuses to clobber a foreign `tun`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-alias-foreign-'));
  fs.writeFileSync(path.join(dir, 'tun'), '#!/bin/sh\necho someone elses tool\n');
  const r = install.writeAlias(dir, '/lib/bin/tunlite.js', process.execPath, { platform: 'posix' });
  assert.equal(r.written, false);
  assert.equal(r.skipped, 'exists');
  assert.match(fs.readFileSync(path.join(dir, 'tun'), 'utf8'), /someone elses tool/); // untouched
});

test('writeAlias rewrites its own prior `tun` (idempotent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-alias-idem-'));
  install.writeAlias(dir, '/lib/bin/tunlite.js', process.execPath, { platform: 'posix' });
  const r = install.writeAlias(dir, '/lib/bin/tunlite.js', process.execPath, { platform: 'posix' });
  assert.equal(r.written, true); // ours -> overwrite is fine
});
