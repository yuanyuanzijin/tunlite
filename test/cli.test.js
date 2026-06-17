'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/cli');

const FAKE_SSH = path.join(__dirname, '..', 'fixtures', 'fake-ssh.js');

// Capture stdout/stderr from a CLI run.
function capture() {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

// withEnv is polymorphic:
//   withEnv()            -> the legacy fixture: a fresh TUNLITE_HOME + fake ssh,
//                           returns { home, restore() } (existing tests use this).
//   withEnv(env, fn)     -> set the given keys, run fn, restore, return fn's value
//                           (new install/onboarding tests use this).
function withEnv(env, fn) {
  if (env && typeof fn === 'function') {
    const prev = {};
    for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
    const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
    let result;
    try { result = fn(); } catch (e) { restore(); throw e; }
    if (result && typeof result.then === 'function') {
      return result.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
    }
    restore();
    return result;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-cli-'));
  const prev = {};
  const set = (k, v) => { prev[k] = process.env[k]; process.env[k] = v; };
  set('TUNLITE_HOME', home);
  set('TUNLITE_SOCKET', path.join(home, 'd.sock'));
  set('TUNLITE_SSH', FAKE_SSH);
  set('FAKE_SSH_PROBE', '0'); // pretend passwordless already works
  set('FAKE_SSH_MODE', 'stay');
  set('TUNLITE_FAKE_AUTOSTART', '1'); // NEVER touch the real launchd/systemd from tests
  return {
    home,
    restore() { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } },
  };
}

// io capture in the shape the new install/onboarding tests expect:
// { out: { write, text() }, err: { write, text() } }.
function mkio() {
  const mk = () => { const buf = []; return { write: (s) => buf.push(s), text: () => buf.join('') }; };
  return { out: mk(), err: mk() };
}

const cli = { run };

async function tunlite(io, ...args) { return run(args, io); }

test('un-anchored note: stderr-only, and suppressed entirely in --json mode', async (t) => {
  const env = withEnv(); // fresh TUNLITE_HOME -> guaranteed un-anchored
  t.after(() => env.restore());

  const c1 = capture();
  await tunlite(c1.io, 'status');
  assert.match(c1.err(), /run `tunlite install` to anchor/); // human mode: note on stderr
  assert.doesNotMatch(c1.out(), /to anchor/);                // never pollutes stdout

  const c2 = capture();
  await tunlite(c2.io, 'status', '--json');
  assert.doesNotMatch(c2.err(), /to anchor/);                // --json: no note even on stderr
  assert.doesNotMatch(c2.out(), /to anchor/);
  JSON.parse(c2.out());                                      // stdout parses as pure JSON
});

test('add / list / rm via config (no daemon)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  let c = capture();
  assert.equal(await tunlite(c.io, 'add', 'local', 'web', '--to', 'me@host', '--remote', '80', '--local', '8080'), 0);
  assert.match(c.out(), /added "web"/);

  c = capture();
  await tunlite(c.io, 'list');
  assert.match(c.out(), /web\s+me@host\s+local 127\.0\.0\.1:8080 → localhost:80/);

  c = capture();
  assert.equal(await tunlite(c.io, 'rm', 'web'), 0);
  assert.match(c.out(), /removed "web"/);

  c = capture();
  assert.equal(await tunlite(c.io, 'rm', 'web'), 3); // not found
});

test('rename changes the name and preserves config', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'remote', 'tmux-4705', '--to', 'root@203.0.113.10', '--local', '4705');

  let c = capture();
  assert.equal(await tunlite(c.io, 'rename', 'tmux-4705', 'progress-board-4705'), 0);
  assert.match(c.out(), /renamed "tmux-4705" -> "progress-board-4705"/);

  c = capture();
  await tunlite(c.io, 'list', '--json');
  const tunnels = JSON.parse(c.out());
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].name, 'progress-board-4705');
  assert.equal(tunnels[0].host, 'root@203.0.113.10');
  assert.equal(tunnels[0].forwards[0].srcPort, 4705);

  // old name gone, target-exists and missing-source rejected
  assert.equal(await tunlite(capture().io, 'rename', 'tmux-4705', 'x'), 3); // not found
  await tunlite(capture().io, 'add', 'dynamic', 'other', '--to', 'me@h', '--local', '1080');
  assert.equal(await tunlite(capture().io, 'rename', 'other', 'progress-board-4705'), 2); // exists
  assert.equal(await tunlite(capture().io, 'rename', 'other', 'Bad Name'), 2); // invalid
});

test('add local/remote/dynamic build the right forward objects with smart defaults', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const get = async (name) => {
    const c = capture();
    await tunlite(c.io, 'list', '--json');
    return JSON.parse(c.out()).find((r) => r.name === name);
  };

  // local, --remote only -> listen locally on the same port, target localhost
  assert.equal(await tunlite(capture().io, 'add', 'local', 'db', '--to', 'u@h', '--remote', '5432'), 0);
  assert.deepEqual((await get('db')).forwards[0],
    { type: 'local', bind: '127.0.0.1', srcPort: 5432, destHost: 'localhost', destPort: 5432 });

  // local with a target host, a distinct local port, and an SSH :port in --to
  assert.equal(await tunlite(capture().io, 'add', 'local', 'db2', '--to', 'u@h:2222', '--remote', 'db.int:5432', '--local', '15432'), 0);
  const t2 = await get('db2');
  assert.equal(t2.port, 2222);
  assert.deepEqual(t2.forwards[0],
    { type: 'local', bind: '127.0.0.1', srcPort: 15432, destHost: 'db.int', destPort: 5432 });

  // remote, --local only + a public --remote bind on the server
  assert.equal(await tunlite(capture().io, 'add', 'remote', 'web', '--to', 'u@h', '--local', '3000', '--remote', '0.0.0.0:9000'), 0);
  assert.deepEqual((await get('web')).forwards[0],
    { type: 'remote', bind: '0.0.0.0', srcPort: 9000, destHost: 'localhost', destPort: 3000 });

  // dynamic, default port 1080
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'px', '--to', 'u@h'), 0);
  assert.deepEqual((await get('px')).forwards[0], { type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 });

  // missing required endpoints / unknown subcommand -> usage error
  assert.equal(await tunlite(capture().io, 'add', 'local', 'x', '--to', 'u@h'), 2); // needs --remote
  assert.equal(await tunlite(capture().io, 'add', 'remote', 'y', '--to', 'u@h'), 2); // needs --local
  assert.equal(await tunlite(capture().io, 'add', 'bogus', 'z', '--to', 'u@h'), 2);   // unknown sub
});

test('up starts a daemon and reaches connected, then down/stop', async (t) => {
  const env = withEnv();
  t.after(async () => {
    const c = capture();
    try { await tunlite(c.io, 'daemon', 'stop'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
    env.restore();
  });

  // remote forward so connected doesn't depend on a real local listener
  let c = capture();
  await tunlite(c.io, 'add', 'remote', 'rev', '--to', 'me@host', '--local', '3000', '--remote', '9000');

  c = capture();
  const code = await tunlite(c.io, 'up', 'rev');
  assert.equal(code, 0, c.out() + c.err());

  // poll status until connected
  let connected = false;
  for (let i = 0; i < 40; i++) {
    const s = capture();
    await run(['status', '--json'], s.io);
    const rows = JSON.parse(s.out()).tunnels;
    if (rows[0] && rows[0].state === 'connected') { connected = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(connected, 'tunnel should reach connected');

  c = capture();
  await tunlite(c.io, 'down', 'rev');
  assert.match(c.out(), /stopped: rev/);
});

test('tags: add/set manage labels; --tag filters and selects (no daemon)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const out = async (...args) => { const c = capture(); await tunlite(c.io, ...args); return c.out(); };
  const json = async (...args) => JSON.parse(await out(...args));
  const get = async (name) => (await json('list', '--json')).find((r) => r.name === name);

  // add --tag: repeatable + comma + dedupe
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'a', '--to', 'u@h', '--tag', 'work', '--tag', 'db,work'), 0);
  assert.deepEqual((await get('a')).tags, ['work', 'db']);
  await tunlite(capture().io, 'add', 'dynamic', 'b', '--to', 'u@h', '--tag', 'work');
  await tunlite(capture().io, 'add', 'dynamic', 'c', '--to', 'u@h', '--tag', 'prod');

  // invalid tag char -> usage error, tunnel not created
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'z', '--to', 'u@h', '--tag', 'bad tag'), 2);
  assert.equal(await get('z'), undefined);

  // set --tag replaces the whole set; --no-tags clears
  assert.equal(await tunlite(capture().io, 'set', 'a', '--tag', 'staging'), 0);
  assert.deepEqual((await get('a')).tags, ['staging']);
  assert.equal(await tunlite(capture().io, 'set', 'a', '--no-tags'), 0);
  assert.deepEqual((await get('a')).tags, []);
  await tunlite(capture().io, 'set', 'a', '--tag', 'work'); // restore for selection checks

  // list --tag filters (union); plain list shows tags inline
  assert.deepEqual((await json('list', '--tag', 'work', '--json')).map((r) => r.name).sort(), ['a', 'b']);
  assert.match(await out('list'), /\[work\]/);
  assert.equal(await tunlite(capture().io, 'list', '--tag', 'nope'), 0); // empty filter is not an error
  assert.match(await out('list', '--tag', 'nope'), /no tunnels tagged "nope"/);

  // status --tag filters to the matching set
  assert.deepEqual((await json('status', '--tag', 'prod', '--json')).tunnels.map((r) => r.name), ['c']);

  // down --tag selects the union (a + b flip off; c untouched)
  assert.equal(await tunlite(capture().io, 'down', '--tag', 'work'), 0);
  assert.equal((await get('a')).enabled, false);
  assert.equal((await get('b')).enabled, false);
  assert.equal((await get('c')).enabled, true);

  // name AND --tag -> usage (2); --tag with no match -> not-found (3)
  assert.equal(await tunlite(capture().io, 'down', 'c', '--tag', 'prod'), 2);
  assert.equal(await tunlite(capture().io, 'down', '--tag', 'nope'), 3);
});

test('up --tag brings up every tunnel carrying that label', async (t) => {
  const env = withEnv();
  t.after(async () => {
    try { await tunlite(capture().io, 'daemon', 'stop'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
    env.restore();
  });
  // remote forwards so connected doesn't depend on a real local listener
  await tunlite(capture().io, 'add', 'remote', 'rev-a', '--to', 'me@host', '--local', '3001', '--remote', '9001', '--tag', 'grp');
  await tunlite(capture().io, 'add', 'remote', 'rev-b', '--to', 'me@host', '--local', '3002', '--remote', '9002', '--tag', 'grp');
  await tunlite(capture().io, 'add', 'remote', 'solo', '--to', 'me@host', '--local', '3003', '--remote', '9003', '--tag', 'other', '--disabled');

  assert.equal(await tunlite(capture().io, 'up', '--tag', 'grp'), 0);

  let ok = false;
  for (let i = 0; i < 40; i++) {
    const s = capture();
    await run(['status', '--json'], s.io);
    const byName = Object.fromEntries(JSON.parse(s.out()).tunnels.map((r) => [r.name, r.state]));
    if (byName['rev-a'] === 'connected' && byName['rev-b'] === 'connected') { ok = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(ok, 'both grp tunnels should reach connected');

  // the untagged-for-this-group tunnel was never enabled by the tag selection
  const c = capture();
  await run(['list', '--json'], c.io);
  assert.equal(JSON.parse(c.out()).find((r) => r.name === 'solo').enabled, false);
});

test('uninstall --purge removes config and state', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const fsmod = require('fs');

  let c = capture();
  await tunlite(c.io, 'add', 'local', 'web', '--to', 'me@host', '--remote', '80', '--local', '8080');
  const cfgDir = require('../src/paths').configDir();
  assert.ok(fsmod.existsSync(cfgDir), 'config dir should exist after add');

  c = capture();
  const code = await tunlite(c.io, 'uninstall', '--purge', '--json');
  assert.equal(code, 0);
  assert.ok(!fsmod.existsSync(cfgDir), 'config dir should be gone after purge');
});

test('uninstall without --purge keeps config', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const fsmod = require('fs');
  let c = capture();
  await tunlite(c.io, 'add', 'dynamic', 'web', '--to', 'me@host', '--local', '1080');
  const cfgDir = require('../src/paths').configDir();
  c = capture();
  await tunlite(c.io, 'uninstall', '--json');
  assert.ok(fsmod.existsSync(cfgDir), 'config dir should remain without --purge');
});

test('uninstall --force is accepted (no usage error) and completes the teardown', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  let c = capture();
  await tunlite(c.io, 'add', 'dynamic', 'web', '--to', 'me@host', '--local', '1080');
  c = capture();
  const code = await tunlite(c.io, 'uninstall', '--force'); // --force must be a known flag, not exit 2
  assert.equal(code, 0);
  assert.match(c.out(), /tunlite removed/);
});

test('check reflects passwordless probe via exit code', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  process.env.FAKE_SSH_PROBE = '0';
  let c = capture();
  assert.equal(await tunlite(c.io, 'check', 'me@host'), 0);
  process.env.FAKE_SSH_PROBE = '255';
  c = capture();
  assert.equal(await tunlite(c.io, 'check', 'me@host'), 4); // needs-auth
});

test('skill install / status / uninstall into a sandbox dir', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-skills-'));
  const dest = path.join(skillsDir, 'ssh-tunnel', 'SKILL.md');

  assert.equal(await tunlite(capture().io, 'skill', 'install', '--dir', skillsDir, '--json'), 0);
  assert.ok(fs.existsSync(dest), 'SKILL.md should be copied into the skills dir');

  const c = capture();
  await tunlite(c.io, 'skill', 'status', '--json');
  const rows = JSON.parse(c.out());
  assert.ok(rows.some((r) => r.present && r.path.includes('ssh-tunnel')), 'status lists the install');

  await tunlite(capture().io, 'skill', 'uninstall', '--json');
  assert.ok(!fs.existsSync(path.join(skillsDir, 'ssh-tunnel')), 'skill dir removed on uninstall');
});

test('uninstall also removes installed skills (synced teardown)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-skills2-'));
  await tunlite(capture().io, 'skill', 'install', '--dir', skillsDir);
  assert.ok(fs.existsSync(path.join(skillsDir, 'ssh-tunnel', 'SKILL.md')));
  await tunlite(capture().io, 'uninstall', '--json'); // full teardown
  assert.ok(!fs.existsSync(path.join(skillsDir, 'ssh-tunnel')), 'full uninstall removes the skill too');
});

test('add rejects an invalid SSH port in --to (exit 2), no silent fallback to 22', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());

  for (const bad of ['abc', '0', '70000', '22.5', '-1']) {
    const c = capture();
    const code = await tunlite(c.io, 'add', 'local', 'web', '--to', `me@host:${bad}`, '--remote', '80');
    assert.equal(code, 2, `port "${bad}" should be a usage error`);
    assert.match(c.err(), /port/);
  }
  // and it was NOT created
  const c = capture();
  await tunlite(c.io, 'list');
  assert.doesNotMatch(c.out(), /web/);
});

test('add accepts a valid non-default SSH port via --to host:port', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const code = await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@host:2222', '--remote', '80', '--local', '8080');
  assert.equal(code, 0);
  const c = capture();
  await tunlite(c.io, 'list', '--json');
  const rows = JSON.parse(c.out());
  assert.equal(rows.find((r) => r.name === 'web').port, 2222);
});

test('check rejects an invalid SSH port in the target (exit 2) before probing', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  const code = await tunlite(c.io, 'check', 'me@host:nope');
  assert.equal(code, 2);
  assert.match(c.err(), /port/);
});

test('unknown flags are rejected as a usage error (exit 2)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'up', '--bogus'), 2);
  const c = capture();
  const code = await tunlite(c.io, 'add', 'local', 'web', '--to', 'me@host', '--remote', '80', '--local', '8080', '--nope');
  assert.equal(code, 2);
  assert.match(c.err(), /unknown option/);
  // declared boolean flags still work
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'd', '--to', 'me@h', '--local', '1080', '--disabled'), 0);
});

test('update refuses to self-update from a source checkout', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  const code = await tunlite(c.io, 'update', '--json');
  assert.equal(code, 0);
  const res = JSON.parse(c.out());
  assert.equal(res.action, 'refused');
  assert.equal(res.reason, 'git');
});

test('update rejects an unknown flag (exit 2)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'update', '--bogus'), 2);
});

test('--version prints the current version', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  assert.equal(await tunlite(c.io, '--version'), 0);
  assert.equal(c.out().trim(), require('../package.json').version);
});

test('status --json returns the unified {daemon, tunnels} shape', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  await tunlite(c.io, 'status', '--json'); // daemon not running in this sandbox
  const res = JSON.parse(c.out());
  assert.equal(res.daemon.running, false);
  assert.ok(Array.isArray(res.tunnels));
});

test('status text output carries a state glyph per tunnel and an overall daemon line', async (t) => {
  const env = withEnv();
  const prevNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1'; // force deterministic plain output regardless of how tests are run
  t.after(() => { env.restore(); if (prevNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prevNoColor; });

  await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@host', '--remote', '80', '--local', '8080');
  const c = capture();
  const code = await tunlite(c.io, 'status'); // no --json; daemon not running in this sandbox
  const out = c.out();
  assert.match(out, /● daemon\s+not running/);   // overall service line carries a glyph
  assert.match(out, /○ daemon-stopped/);          // per-tunnel state shows glyph + label
  assert.doesNotMatch(out, /\x1b\[/);             // NO_COLOR -> no ANSI escape codes leak
  assert.equal(code, 5);                          // EXIT.DAEMON when the daemon is down
});

test('monitor refuses non-interactive use and points at status --json', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  const code = await tunlite(c.io, 'monitor', '--json'); // --json forces the refusal path, TTY-independent
  assert.equal(code, 2);
  assert.match(c.err(), /interactive terminal/);
  assert.match(c.err(), /status --json/);
});

test('install anchors: copies runtime, writes launcher + manifest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cli-install-'));
  const bin = path.join(home, 'bin');
  const env = {
    TUNLITE_HOME: home, TUNLITE_BIN: bin,
    TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1',
  };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], io));
  assert.equal(code, 0);
  const install = require('../src/install');
  // The harness restores env after the run, so read the manifest by its explicit
  // path under this test's TUNLITE_HOME rather than via the (now-restored) env.
  const manFile = path.join(home, 'data', 'install.json');
  const man = install.readManifest({ file: manFile });
  assert.ok(fs.existsSync(path.join(home, 'lib', 'bin', 'tunlite.js')) || fs.existsSync(man.libDir + '/bin/tunlite.js'));
  assert.ok(fs.existsSync(path.join(bin, 'tunlite')) || fs.existsSync(path.join(bin, 'tunlite.cmd')));
  assert.ok(man);
});

test('install writes the `tun` alias; full uninstall removes it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-alias-cli-'));
  const bin = path.join(home, 'bin');
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: bin, TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], mkio()));
  const tun = fs.existsSync(path.join(bin, 'tun')) || fs.existsSync(path.join(bin, 'tun.cmd'));
  assert.ok(tun, 'tun alias created next to tunlite');

  await withEnv(env, () => cli.run(['uninstall'], mkio()));
  assert.ok(!fs.existsSync(path.join(bin, 'tun')) && !fs.existsSync(path.join(bin, 'tun.cmd')), 'tun alias removed');
});

test('uninstall leaves a foreign `tun` alone', async () => {
  if (os.platform() === 'win32') return; // posix `tun` name; the cmd path mirrors it
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-alias-foreign-cli-'));
  const bin = path.join(home, 'bin');
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: bin, TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], mkio()));
  // replace our tun with someone else's command, then uninstall
  fs.writeFileSync(path.join(bin, 'tun'), '#!/bin/sh\necho not ours\n');
  await withEnv(env, () => cli.run(['uninstall'], mkio()));
  assert.ok(fs.existsSync(path.join(bin, 'tun')), 'a foreign tun must survive uninstall');
  fs.rmSync(path.join(bin, 'tun'), { force: true });
});

test('install --service --skill user runs autostart (sandbox) + writes skill manifest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cli-onb-'));
  const skills = path.join(home, 'skills');
  const env = {
    TUNLITE_HOME: home, TUNLITE_BIN: path.join(home, 'bin'),
    TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1',
    TUNLITE_SKILLS_DIR: skills,
  };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['install', '--yes', '--service', '--skill', 'user'], io));
  assert.equal(code, 0);
  // sandbox autostart adapter reports installed=false but install() returned ok; assert it was invoked via output
  assert.match(io.out.text(), /service/i);
  assert.ok(fs.existsSync(path.join(skills, 'ssh-tunnel', 'SKILL.md')));
});

test('install --no-service --no-skill skips both', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cli-skip-'));
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: path.join(home, 'bin'), TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], io));
  assert.equal(code, 0);
});

test('top-level `service`/`skill` are gone; `install service` works', async () => {
  const io1 = mkio();
  assert.equal(await cli.run(['service', 'install'], io1), 2 /* USAGE: unknown command */);
  assert.match(io1.err.text(), /unknown command/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-isvc-'));
  const io2 = mkio();
  const code = await withEnv({ TUNLITE_HOME: home, TUNLITE_FAKE_AUTOSTART: '1' },
    () => cli.run(['install', 'service'], io2));
  assert.equal(code, 0);
});

test('`install skill status` and `install skill --dir cwd` route to skill module', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-iskill-'));
  const io = mkio();
  const code = await withEnv({ TUNLITE_HOME: home }, () => cli.run(['install', 'skill', 'status'], io));
  assert.equal(code, 0);

  // `install skill --dir cwd` (no explicit `install` verb) must also route to the
  // skill installer, not the anchor. `--dir cwd` resolves to
  // <process.cwd()>/.claude/skills, so run it from a throwaway temp cwd to keep
  // the artifact out of the repo, and assert it actually wrote SKILL.md + exit 0.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-iskill2-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-iskill2-cwd-'));
  const prevCwd = process.cwd();
  process.chdir(tmpCwd);
  try {
    const io2 = mkio();
    const code2 = await withEnv(
      { TUNLITE_HOME: home2, TUNLITE_FAKE_AUTOSTART: '1' },
      () => cli.run(['install', 'skill', '--dir', 'cwd'], io2),
    );
    assert.equal(code2, 0, io2.err.text());
    const cwdDest = path.join(tmpCwd, '.claude', 'skills', 'ssh-tunnel', 'SKILL.md');
    assert.ok(fs.existsSync(cwdDest), 'install skill --dir cwd wrote SKILL.md under cwd/.claude/skills');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test('install --json --service --skill emits exactly one JSON document', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-onb-json-'));
  const skills = path.join(home, 'skills');
  const env = {
    TUNLITE_HOME: home, TUNLITE_BIN: path.join(home, 'bin'),
    TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1',
    TUNLITE_SKILLS_DIR: skills,
  };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['install', '--json', '--yes', '--service', '--skill', 'user'], io));
  assert.equal(code, 0);
  // stdout must be a SINGLE parseable JSON document despite the service + skill
  // sub-steps (their own jsonOut output is suppressed in --json mode).
  const parsed = JSON.parse(io.out.text());
  assert.ok(parsed.libDir && parsed.launcher && parsed.entry, 'has the anchor fields');
  assert.ok(parsed.onboard, 'has an onboard block');
  assert.equal(parsed.onboard.skill, 'user');
  assert.equal(parsed.onboard.serviceCode, 0);
  assert.equal(parsed.onboard.skillCode, 0);
  assert.equal(parsed.onboard.service.ok, true); // structured service result, sandbox ok
  assert.ok(fs.existsSync(path.join(skills, 'ssh-tunnel', 'SKILL.md')), 'skill actually installed');
});

test('install propagates an opted-in skill-step failure to a non-zero exit', async () => {
  // Offline failure path: point --skill at a path WHOSE PARENT IS A FILE, so the
  // skill installer's mkdirSync(dirname(dest)) hits ENOTDIR. No network, no real
  // machine state touched (sandbox autostart + a temp HOME). Service is skipped.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-onb-fail-'));
  const blocker = path.join(home, 'not-a-dir');
  fs.writeFileSync(blocker, 'x'); // a regular file where a skills dir would go
  const badSkillDir = path.join(blocker, 'sub'); // dirname() is a file -> ENOTDIR
  const env = {
    TUNLITE_HOME: home, TUNLITE_BIN: path.join(home, 'bin'),
    TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1',
  };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['install', '--no-service', '--skill', badSkillDir], io));
  assert.notEqual(code, 0); // anchor succeeded, but the requested skill step failed
});

test('uninstall removes launcher + lib using the manifest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-'));
  const bin = path.join(home, 'bin');
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: bin, TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], mkio()));
  const install = require('../src/install');
  // The harness restores env after the run, so read the manifest by its explicit
  // path under this test's TUNLITE_HOME rather than via the (now-restored) env.
  const libDir = install.readManifest({ file: path.join(home, 'data', 'install.json') }).libDir;
  assert.ok(fs.existsSync(libDir));
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['uninstall'], io));
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(libDir));
  assert.ok(!fs.existsSync(path.join(bin, 'tunlite')) && !fs.existsSync(path.join(bin, 'tunlite.cmd')));
});

test('uninstall service removes only the service', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-svc-'));
  const io = mkio();
  const code = await withEnv({ TUNLITE_HOME: home, TUNLITE_FAKE_AUTOSTART: '1' }, () => cli.run(['uninstall', 'service'], io));
  assert.equal(code, 0);
});

test('uninstall --purge deletes config + data + socket', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-purge-'));
  const bin = path.join(home, 'bin');
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: bin, TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  // Anchor first so config + data dirs exist, then write a tunnel into config too.
  await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], mkio()));
  await withEnv(env, () => cli.run(['add', 'local', 'web', '--to', 'me@host', '--remote', '80', '--local', '8080'], mkio()));
  // Compute the explicit paths the same shape paths.js does under this TUNLITE_HOME,
  // to dodge the env-restore timing (env is restored after each withEnv call).
  const cfgDir = path.join(home, 'config');
  const dataDir = path.join(home, 'data');
  assert.ok(fs.existsSync(cfgDir), 'config dir exists before purge');
  assert.ok(fs.existsSync(dataDir), 'data dir exists before purge');
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['uninstall', '--purge'], io));
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(cfgDir), 'config dir gone after purge');
  assert.ok(!fs.existsSync(dataDir), 'data dir gone after purge');
});

test('uninstall service leaves lib + launcher intact (early-return isolation)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-svc2-'));
  const bin = path.join(home, 'bin');
  const env = { TUNLITE_HOME: home, TUNLITE_BIN: bin, TUNLITE_NODE: process.execPath, TUNLITE_FAKE_AUTOSTART: '1' };
  await withEnv(env, () => cli.run(['install', '--no-service', '--no-skill'], mkio()));
  const install = require('../src/install');
  const libDir = install.readManifest({ file: path.join(home, 'data', 'install.json') }).libDir;
  assert.ok(fs.existsSync(libDir), 'lib exists after anchor');
  const launcher = path.join(bin, 'tunlite');
  const launcherWin = path.join(bin, 'tunlite.cmd');
  assert.ok(fs.existsSync(launcher) || fs.existsSync(launcherWin), 'launcher exists after anchor');
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['uninstall', 'service'], io));
  assert.equal(code, 0);
  // `uninstall service` removes ONLY the service: lib + launcher must survive.
  assert.ok(fs.existsSync(libDir), 'lib still present after `uninstall service`');
  assert.ok(fs.existsSync(launcher) || fs.existsSync(launcherWin), 'launcher still present after `uninstall service`');
});

test('uninstall with a missing manifest does not crash (steps simply skipped)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-nomf-'));
  // Fresh TUNLITE_HOME, no prior install -> readManifest() returns null.
  const env = { TUNLITE_HOME: home, TUNLITE_FAKE_AUTOSTART: '1' };
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['uninstall'], io));
  assert.equal(code, 0);
});

test('uninstall refuses to delete a suspicious libDir (safety guard)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-uninst-guard-'));
  // A throwaway dir whose basename contains NEITHER "tunlite" NOR "lib" -> the
  // guard must classify it as suspicious and refuse to remove it. We point only
  // the MANIFEST's libDir at it; the real home/lib are never at risk.
  const danger = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-'));
  const env = { TUNLITE_HOME: home, TUNLITE_FAKE_AUTOSTART: '1' };
  const install = require('../src/install');
  // Write a manifest by explicit path under this home, libDir -> the danger dir.
  await withEnv(env, () => install.writeManifest(
    { libDir: danger, binDir: path.join(home, 'bin'), nodePath: process.execPath, version: '0.0.0', installedAt: Date.now() },
    { file: path.join(home, 'data', 'install.json') },
  ));
  const io = mkio();
  const code = await withEnv(env, () => cli.run(['uninstall', '--json'], io));
  assert.equal(code, 0);
  assert.ok(fs.existsSync(danger), 'suspicious dir must survive — guard prevents deletion');
  const res = JSON.parse(io.out.text());
  assert.ok(res.steps.some((s) => /NOT removed.*suspicious/i.test(s)), 'a suspicious/NOT-removed step is reported');
  fs.rmSync(danger, { recursive: true, force: true }); // cleanup the throwaway dir
});

test('status --json includes service and skill objects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-statusj-'));
  const io = mkio();
  await withEnv({ TUNLITE_HOME: home, TUNLITE_FAKE_AUTOSTART: '1' }, () => cli.run(['status', '--json'], io));
  // daemon down -> EXIT.DAEMON (5) is fine; assert the shape, not the code
  const out = JSON.parse(io.out.text());
  assert.ok('service' in out);
  assert.ok('skill' in out);
  assert.equal(out.service.installed, false); // sandbox autostart reports not-installed
  assert.ok('daemon' in out && 'tunnels' in out); // the unified status keys still coexist
});

test('un-anchored hint prints when running outside the anchored libDir', async () => {
  // No manifest -> not anchored. Any benign command should emit the hint on stderr.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-hint-'));
  const io = mkio();
  await withEnv({ TUNLITE_HOME: home }, () => cli.run(['list'], io));
  assert.match(io.err.text(), /tunlite install/);
});

test('no hint for `install`, `version`, `help` themselves', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-nohint-'));
  const io = mkio();
  await withEnv({ TUNLITE_HOME: home }, () => cli.run(['version'], io));
  assert.doesNotMatch(io.err.text(), /run `tunlite install`/);
});

test('status list renders an aligned table with a header', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@h', '--remote', '80', '--local', '8080');
  const c = capture();
  const code = await tunlite(c.io, 'status');
  assert.match(c.out(), /NAME\s+STATE\s+HOST\s+TYPE\s+ROUTE\s+PID\s+UP\s+RESTARTS/);
  assert.match(c.out(), /web/);
  assert.match(c.out(), /local/);
  assert.equal(code, 5); // EXIT.DAEMON — daemon not running in tests
});

test('status <name> renders a vertical detail with full params', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@h', '--remote', '80', '--local', '8080');
  const c = capture();
  await tunlite(c.io, 'status', 'web');
  assert.match(c.out(), /^web/m);
  assert.match(c.out(), /type\s+local/);
  assert.match(c.out(), /listen\s+127\.0\.0\.1:8080 \(local\)/);
  assert.match(c.out(), /target\s+localhost:80 \(reachable from server\)/);
  assert.match(c.out(), /enabled\s+yes/);
});

test('status <unknown> exits NOTFOUND', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  const code = await tunlite(c.io, 'status', 'nope');
  assert.equal(code, 3); // EXIT.NOTFOUND
  assert.match(c.err(), /no such tunnel/);
});

test('status --json shape is unchanged (daemon/tunnels/service/skill)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@h', '--remote', '80');
  const c = capture();
  await tunlite(c.io, 'status', '--json');
  const obj = JSON.parse(c.out());
  assert.ok('daemon' in obj && 'tunnels' in obj && 'service' in obj && 'skill' in obj);
  assert.equal(obj.tunnels[0].name, 'web');
});

test('add local/remote/dynamic produce the right f.type', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'local', 'a', '--to', 'me@h', '--remote', '80');
  await tunlite(capture().io, 'add', 'remote', 'b', '--to', 'me@h', '--local', '3000');
  await tunlite(capture().io, 'add', 'dynamic', 'c', '--to', 'me@h');
  const c = capture();
  await tunlite(c.io, 'status', '--json');
  const types = Object.fromEntries(JSON.parse(c.out()).tunnels.map((x) => [x.name, x.forwards[0].type]));
  assert.deepEqual(types, { a: 'local', b: 'remote', c: 'dynamic' });
});

test('old verbs forward/reverse/socks are gone (usage error)', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  const code = await tunlite(c.io, 'add', 'forward', 'x', '--to', 'me@h', '--remote', '80');
  assert.equal(code, 2); // EXIT.USAGE
  assert.match(c.err(), /add <local\|remote\|dynamic>/);
});

test('doctor: tunnel configured + daemon down => exit 1 with a problems summary', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  await tunlite(capture().io, 'add', 'local', 'web', '--to', 'me@h', '--remote', '80', '--local', '8080');
  const c = capture();
  const code = await tunlite(c.io, 'doctor');
  assert.equal(code, 1); // a fail exists (daemon down with a tunnel configured)
  assert.match(c.out(), /environment/);
  assert.match(c.out(), /daemon & service/);
  assert.match(c.out(), /tunnel:web/);
  assert.match(c.out(), /problems/);
});

test('doctor --json returns {ok, summary, checks[]}', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const c = capture();
  await tunlite(c.io, 'doctor', '--json');
  const obj = JSON.parse(c.out());
  assert.equal(typeof obj.ok, 'boolean');
  assert.ok(Array.isArray(obj.checks));
  assert.ok(obj.summary && typeof obj.summary.fail === 'number');
});

test('add --jump stores normalized ProxyJump hops', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'add', 'local', 'web-80', '--to', 'me@h', '--remote', '80', '--jump', 'user@bastion:2222'), 0);
  const c = capture();
  await tunlite(c.io, 'list', '--json');
  assert.deepEqual(JSON.parse(c.out())[0].jump, ['user@bastion:2222']);
});

test('forward add/list/rm manage multiple forwards on a tunnel', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'multi-1080', '--to', 'me@h'), 0);

  // append a second forward to the same tunnel
  assert.equal(await tunlite(capture().io, 'forward', 'add', 'multi-1080', 'local', '--remote', '5432', '--local', '5432'), 0);
  let c = capture();
  await tunlite(c.io, 'forward', 'list', 'multi-1080', '--json');
  assert.equal(JSON.parse(c.out()).length, 2);

  // remove the second forward
  assert.equal(await tunlite(capture().io, 'forward', 'rm', 'multi-1080', '2'), 0);
  c = capture();
  await tunlite(c.io, 'list', '--json');
  assert.equal(JSON.parse(c.out())[0].forwards.length, 1);

  // refuse to remove the last remaining forward (usage error)
  assert.equal(await tunlite(capture().io, 'forward', 'rm', 'multi-1080', '1'), 2);

  // unknown tunnel -> not found
  assert.equal(await tunlite(capture().io, 'forward', 'add', 'nope', 'dynamic'), 3);
});

test('set updates host, port and jump on an existing tunnel', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'sx-1080', '--to', 'me@old'), 0);
  assert.equal(await tunlite(capture().io, 'set', 'sx-1080', '--to', 'me@new:2222', '--jump', 'user@bastion'), 0);
  const c = capture();
  await tunlite(c.io, 'list', '--json');
  const tn = JSON.parse(c.out())[0];
  assert.equal(tn.host, 'me@new');
  assert.equal(tn.port, 2222);
  assert.deepEqual(tn.jump, ['user@bastion']);
});

test('set with no fields is a usage error; unknown tunnel is not found', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'add', 'dynamic', 'sx2-1080', '--to', 'me@h'), 0);
  assert.equal(await tunlite(capture().io, 'set', 'sx2-1080'), 2);
  assert.equal(await tunlite(capture().io, 'set', 'nope', '--to', 'me@h'), 3);
});

// --- webhook url redaction (secret lives in the path/query) ---------------
const SECRET_URL = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
const SECRET_TAIL = 'XXXXSECRET';

test('webhook set/status redact the url in both human and --json output', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());

  // set (human): success line shows the redacted url, never the secret tail
  let c = capture();
  assert.equal(await tunlite(c.io, 'webhook', 'set', SECRET_URL), 0);
  assert.match(c.out(), /hooks\.slack\.com/);
  assert.doesNotMatch(c.out(), new RegExp(SECRET_TAIL));

  // set (--json): url field is redacted; daemonRunning still present
  c = capture();
  assert.equal(await tunlite(c.io, 'webhook', 'set', SECRET_URL, '--json'), 0);
  let obj = JSON.parse(c.out());
  assert.equal(obj.webhook.url, 'https://hooks.slack.com/…');
  assert.ok('daemonRunning' in obj);
  assert.doesNotMatch(c.out(), new RegExp(SECRET_TAIL));

  // status (human + --json): redacted
  c = capture();
  await tunlite(c.io, 'webhook', 'status');
  assert.match(c.out(), /hooks\.slack\.com/);
  assert.doesNotMatch(c.out(), new RegExp(SECRET_TAIL));
  c = capture();
  await tunlite(c.io, 'webhook', 'status', '--json');
  obj = JSON.parse(c.out());
  assert.equal(obj.webhook.url, 'https://hooks.slack.com/…');
  assert.doesNotMatch(c.out(), new RegExp(SECRET_TAIL));

  // the real (unredacted) url is still persisted on disk
  const cfg = require('../src/config').load(require('../src/paths').configFile());
  assert.equal(cfg.settings.alerts.webhook.url, SECRET_URL);
});

test('webhook test redacts the url (human + --json) and posts the full url', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  const http = require('http');
  // A local server stands in for the webhook endpoint; capture the path it's hit on.
  let hitPath = null;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { hitPath = req.url; res.statusCode = 200; res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const realUrl = `http://127.0.0.1:${port}/services/SECRETPATH`;

  assert.equal(await tunlite(capture().io, 'webhook', 'set', realUrl), 0);

  // human success line: redacted (host visible, secret path hidden)
  let c = capture();
  const code = await tunlite(c.io, 'webhook', 'test');
  assert.equal(code, 0, c.out() + c.err());
  assert.match(c.out(), /127\.0\.0\.1/);
  assert.doesNotMatch(c.out(), /SECRETPATH/);
  // but the POST went to the FULL url (the daemon-side request keeps the secret)
  assert.equal(hitPath, '/services/SECRETPATH');

  // --json: url field redacted
  c = capture();
  await tunlite(c.io, 'webhook', 'test', '--json');
  const obj = JSON.parse(c.out());
  assert.equal(obj.url, 'http://127.0.0.1:' + port + '/…');
  assert.doesNotMatch(c.out(), /SECRETPATH/);
});

test('export redacts the webhook url but leaves on-disk config intact', async (t) => {
  const env = withEnv();
  t.after(() => env.restore());
  assert.equal(await tunlite(capture().io, 'webhook', 'set', SECRET_URL), 0);

  const c = capture();
  assert.equal(await tunlite(c.io, 'export'), 0);
  const dump = JSON.parse(c.out());
  assert.equal(dump.settings.alerts.webhook.url, 'https://hooks.slack.com/…');
  assert.doesNotMatch(c.out(), new RegExp(SECRET_TAIL));

  // the persisted config still carries the real url (export didn't mutate it)
  const cfg = require('../src/config').load(require('../src/paths').configFile());
  assert.equal(cfg.settings.alerts.webhook.url, SECRET_URL);
});

// --- logs honors --json (NDJSON) ------------------------------------------
test('logs --json emits NDJSON (one JSON object per line); human path unchanged', async (t) => {
  const env = withEnv();
  t.after(async () => {
    try { await tunlite(capture().io, 'daemon', 'stop'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
    env.restore();
  });
  // Bring a tunnel up so the daemon is running and has a log channel to tail.
  await tunlite(capture().io, 'add', 'remote', 'rev', '--to', 'me@host', '--local', '3000', '--remote', '9000');
  assert.equal(await tunlite(capture().io, 'up', 'rev'), 0);

  // Wait until the daemon has emitted at least one log line for the tunnel.
  let lines = [];
  for (let i = 0; i < 40; i++) {
    const c = capture();
    await tunlite(c.io, 'logs', 'rev', '--json');
    lines = c.out().split('\n').filter((l) => l.trim());
    if (lines.length) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(lines.length > 0, 'expected at least one log frame');
  // Every emitted line is an independently parseable JSON object with ts + line.
  for (const l of lines) {
    const o = JSON.parse(l);
    assert.equal(typeof o.ts, 'number');
    assert.equal(typeof o.line, 'string');
  }

  // Human path: ISO-prefixed text, NOT JSON.
  const h = capture();
  await tunlite(h.io, 'logs', 'rev');
  const hline = h.out().split('\n').filter((l) => l.trim())[0];
  assert.ok(hline, 'expected a human log line');
  assert.match(hline, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp prefix
  assert.throws(() => JSON.parse(hline)); // not JSON
});

// --- logs (non-follow) returns EVERY frame, not a 200ms-timer subset ---------
// The old non-follow branch resolved on a fixed 200ms timer and truncated when a
// large `-n` produced more frames than arrived in 200ms; the fix resolves on the
// daemon's real stream end, so all lines must arrive however long the tail takes.
test('logs (non-follow) returns all lines, not a 200ms-timer subset', async (t) => {
  const env = withEnv();
  const { Server } = require('../src/ipc');
  const paths = require('../src/paths');

  const N = 400;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A logs handler honoring the daemon's NON-FOLLOW contract (push every frame,
  // then end the stream) but spreading the dump over MORE than the old 200ms
  // window. The old fixed-timer branch stopped the read at 200ms and truncated;
  // the fix resolves on the real stream-end, so all N frames must arrive.
  const server = new Server({
    ping: async () => ({ pid: process.pid, version: 'test', uptimeMs: 0 }),
    logs: async (args, ctx) => {
      const n = Math.min(args.n || 100, N);
      for (let i = 0; i < n; i++) {
        ctx.push({ ts: Date.now(), line: `line-${i}` });
        if (i % 50 === 49) await sleep(40); // ~280ms spread, well past the old 200ms timer
      }
      if (!ctx.streaming) ctx.push({ ts: Date.now(), line: '' }); // empty-tail sentinel
      ctx.socket.end(); // signal end-of-stream for non-follow
    },
  });
  await server.listen(paths.socketPath());

  t.after(async () => { try { await server.close(); } catch (_) {} env.restore(); });

  const c = capture();
  const code = await tunlite(c.io, 'logs', 'rev', '-n', String(N), '--json');
  assert.equal(code, 0);
  const lines = c.out().split('\n').filter((l) => l.trim());
  assert.equal(lines.length, N, `expected all ${N} frames, got ${lines.length}`);
  // frames are intact and in order
  assert.equal(JSON.parse(lines[0]).line, 'line-0');
  assert.equal(JSON.parse(lines[N - 1]).line, `line-${N - 1}`);
});
