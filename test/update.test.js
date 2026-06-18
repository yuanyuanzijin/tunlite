'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../src/update');

test('compareVersions orders numerically, handles v-prefix and 9<10', () => {
  assert.equal(u.compareVersions('0.1.2', '0.1.1'), 1);
  assert.equal(u.compareVersions('0.1.1', '0.1.1'), 0);
  assert.equal(u.compareVersions('v0.1.1', '0.1.1'), 0);
  assert.equal(u.compareVersions('0.1.9', '0.1.10'), -1);
  assert.equal(u.compareVersions('1.0.0', '0.9.9'), 1);
});

test('normalizeTag: empty -> undefined, adds v, validates X.Y.Z', () => {
  assert.equal(u.normalizeTag(undefined), undefined);
  assert.equal(u.normalizeTag(''), undefined);
  assert.equal(u.normalizeTag('0.1.0'), 'v0.1.0');
  assert.equal(u.normalizeTag('v2.3.4'), 'v2.3.4');
  assert.throws(() => u.normalizeTag('abc'));
  assert.throws(() => u.normalizeTag('1.2'));
  assert.throws(() => u.normalizeTag('1.2.3.4'));
});

test('detectInstallMethod: marker -> installed, .git -> git, bare -> unmanaged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-det-'));
  assert.equal(u.detectInstallMethod(root), 'unmanaged');            // bare dir
  fs.writeFileSync(path.join(root, '.tunlite-install'), 'x');
  assert.equal(u.detectInstallMethod(root), 'installed');            // marker wins
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-git-'));
  fs.mkdirSync(path.join(repo, '.git'));
  assert.equal(u.detectInstallMethod(repo), 'git');                  // dev checkout
});

test('pickLatestTag: highest semver, ignores non-semver, null when none', () => {
  assert.equal(u.pickLatestTag(['v0.9.0', 'v0.9.2', 'v0.9.1']), 'v0.9.2');
  assert.equal(u.pickLatestTag(['0.9.9', 'v0.10.0', 'v0.9.0']), 'v0.10.0'); // 10 > 9, not lexicographic
  assert.equal(u.pickLatestTag(['nightly', 'latest', 'v1.2.3']), 'v1.2.3');
  assert.equal(u.pickLatestTag(['main', 'dev']), null);
  assert.equal(u.pickLatestTag([]), null);
});

test('runUpdate: installed + newer -> fetch, anchor, restart; never npm install -g <folder>', async () => {
  const calls = [];
  const res = await u.runUpdate({}, {
    currentVersion: '0.1.0',
    detectMethod: () => 'installed',
    fetch: async () => { calls.push('fetch'); return '/tmp/fake'; },
    readVersion: () => '0.2.0',
    anchor: () => { calls.push('anchor'); },
    restartDaemon: async () => { calls.push('restart'); return { restarted: true, pid: 1 }; },
    rmTemp: () => {},
    log: () => {},
  });
  assert.equal(res.action, 'updated');
  assert.deepEqual(calls, ['fetch', 'anchor', 'restart']);
});

test('httpsRepoUrl normalizes git+ssh and git+https to the same https url', () => {
  const want = 'https://github.com/yuanyuanzijin/tunlite.git';
  assert.equal(u.httpsRepoUrl('git+ssh://git@github.com/yuanyuanzijin/tunlite.git'), want);
  assert.equal(u.httpsRepoUrl('git+https://github.com/yuanyuanzijin/tunlite.git'), want);
  assert.equal(u.httpsRepoUrl('https://github.com/yuanyuanzijin/tunlite.git'), want);
});

function makeDeps(over = {}) {
  const calls = { fetch: [], anchor: [], restart: 0, rm: [] };
  const deps = {
    currentVersion: '0.1.1',
    detectMethod: () => 'installed',
    fetch: async (tag) => { calls.fetch.push({ tag }); return '/tmp/fake-fetch'; },
    readVersion: () => '0.1.2',
    anchor: (d) => { calls.anchor.push(d); },
    restartDaemon: async () => { calls.restart++; return { restarted: true, pid: 999 }; },
    rmTemp: async (d) => { calls.rm.push(d); },
    log: () => {},
    ...over,
  };
  return { deps, calls };
}

test('runUpdate: newer latest anchors and restarts, cleans up', async () => {
  const { deps, calls } = makeDeps();
  const res = await u.runUpdate({}, deps);
  assert.equal(res.action, 'updated');
  assert.equal(res.to, '0.1.2');
  assert.equal(calls.anchor.length, 1);
  assert.equal(calls.restart, 1);
  assert.deepEqual(calls.rm, ['/tmp/fake-fetch']);
});

test('runUpdate: same version is a no-op (no anchor, no restart)', async () => {
  const { deps, calls } = makeDeps({ readVersion: () => '0.1.1' });
  const res = await u.runUpdate({}, deps);
  assert.equal(res.action, 'up-to-date');
  assert.equal(calls.anchor.length, 0);
  assert.equal(calls.restart, 0);
  assert.equal(res.explicit, false);
});

test('runUpdate: latest never auto-downgrades', async () => {
  const { deps, calls } = makeDeps({ readVersion: () => '0.1.0' });
  const res = await u.runUpdate({}, deps);
  assert.equal(res.action, 'up-to-date');
  assert.equal(calls.anchor.length, 0);
});

test('runUpdate: explicit older version downgrades (rollback)', async () => {
  const { deps, calls } = makeDeps({ readVersion: () => '0.1.0' });
  const res = await u.runUpdate({ version: 'v0.1.0' }, deps);
  assert.equal(res.action, 'updated');
  assert.equal(res.to, '0.1.0');
  assert.equal(calls.fetch[0].tag, 'v0.1.0');
  assert.equal(calls.anchor.length, 1);
});

test('runUpdate: explicit same version is a no-op unless --force', async () => {
  let r = await u.runUpdate({ version: '0.1.1' }, makeDeps({ readVersion: () => '0.1.1' }).deps);
  assert.equal(r.action, 'up-to-date');
  assert.equal(r.explicit, true);
  const { deps, calls } = makeDeps({ readVersion: () => '0.1.1' });
  r = await u.runUpdate({ version: '0.1.1', force: true }, deps);
  assert.equal(r.action, 'updated');
  assert.equal(calls.anchor.length, 1);
});

test('runUpdate: --check never anchors', async () => {
  const { deps, calls } = makeDeps();
  const res = await u.runUpdate({ check: true }, deps);
  assert.equal(res.action, 'check');
  assert.equal(res.available, true);
  assert.equal(calls.anchor.length, 0);
  assert.equal(calls.restart, 0);
});

test('runUpdate: --no-restart anchors but does not bounce the daemon', async () => {
  const { deps, calls } = makeDeps();
  const res = await u.runUpdate({ noRestart: true }, deps);
  assert.equal(res.action, 'updated');
  assert.equal(calls.anchor.length, 1);
  assert.equal(calls.restart, 0);
});

test('runUpdate: a non-anchored install refuses, touches nothing (reason = method)', async () => {
  for (const method of ['git', 'npm-global', 'unmanaged']) {
    const { deps, calls } = makeDeps({
      detectMethod: () => method,
      fetch: async () => { throw new Error('should not fetch'); },
    });
    const res = await u.runUpdate({}, deps);
    assert.equal(res.action, 'refused');
    assert.equal(res.reason, method);
    assert.equal(calls.anchor.length, 0);
  }
});

test('runUpdate: latest resolves the newest tag and fetches THAT, not the branch', async () => {
  const { deps, calls } = makeDeps({
    readVersion: () => '0.9.3',
    resolveLatestTag: async () => 'v0.9.3',
  });
  const res = await u.runUpdate({}, deps); // no explicit version => latest
  assert.equal(res.action, 'updated');
  assert.equal(calls.fetch[0].tag, 'v0.9.3'); // fetched the resolved tag, not undefined (master)
});

test('runUpdate: an explicit version skips tag resolution', async () => {
  let resolved = 0;
  const { deps, calls } = makeDeps({
    readVersion: () => '0.1.1',
    resolveLatestTag: async () => { resolved++; return 'v9.9.9'; },
  });
  await u.runUpdate({ version: 'v0.1.1' }, deps);
  assert.equal(resolved, 0, 'explicit version must not call resolveLatestTag');
  assert.equal(calls.fetch[0].tag, 'v0.1.1');
});

test('runUpdate: resolveLatestTag -> null falls back to the default source', async () => {
  const { deps, calls } = makeDeps({ resolveLatestTag: async () => null });
  const res = await u.runUpdate({}, deps);
  assert.equal(res.action, 'updated');
  assert.equal(calls.fetch[0].tag, null); // fetch(null) => archiveFetch uses env/master
});

test('runUpdate: fetch failure does not anchor or restart', async () => {
  const { deps, calls } = makeDeps({ fetch: async () => { throw new Error('could not fetch'); } });
  await assert.rejects(() => u.runUpdate({ version: 'v9.9.9' }, deps));
  assert.equal(calls.anchor.length, 0);
  assert.equal(calls.restart, 0);
});

test('runUpdate: garbage version throws a usage error before fetching', async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(() => u.runUpdate({ version: 'nope' }, deps), (e) => e.exitCode === 2);
  assert.equal(calls.fetch.length, 0);
});

// ── archiveFetch + end-to-end update flow (offline) ───────────────────────────
// These cover the real fetch/extract + re-anchor path that the unit fakes above
// never exercise — which is why the "update dead on real installs" bug shipped
// green. Everything is offline: fixtures are local tarballs served via file://.

const cp = require('child_process');
const cli = require('../src/cli');
const installer = require('../src/install');

// Build a .tgz whose single top-level dir holds the given files, so that
// `tar --strip-components=1` yields them at the extraction root.
function makeFixtureTgz(files) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fixsrc-'));
  const top = path.join(work, 'tunlite-fixture');
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(top, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  const tgz = path.join(work, 'fixture.tgz');
  const r = cp.spawnSync('tar', ['czf', tgz, '-C', work, 'tunlite-fixture']);
  if (r.status !== 0) throw new Error('failed to build fixture tarball: ' + String(r.stderr || ''));
  return tgz;
}

test('archiveFetch extracts a file:// tarball to a dir with bin/tunlite.js + package.json', () => {
  const tgz = makeFixtureTgz({
    'bin/tunlite.js': '#!/usr/bin/env node\nconsole.log("v");\n',
    'package.json': '{"name":"tunlite","version":"1.2.3"}\n',
  });
  const prev = process.env.TUNLITE_ARCHIVE_URL;
  process.env.TUNLITE_ARCHIVE_URL = 'file://' + tgz;
  let dir;
  try {
    dir = cli.archiveFetch('https://example.invalid/x.git', undefined);
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'tunlite.js')), 'bin/tunlite.js present');
    assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'package.json present');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.3');
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_ARCHIVE_URL; else process.env.TUNLITE_ARCHIVE_URL = prev;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveFetch handles an archive larger than spawnSync default maxBuffer (1 MB)', () => {
  // Regression for the Critical bug where the fetcher captured the tarball into a
  // 1 MB-default stdout buffer: once the GitHub repo archive (docs/recordings/…)
  // crossed 1 MB, curl was SIGTERM'd with ENOBUFS and update died with a bogus
  // "need curl or wget". An ~2 MB incompressible payload keeps the .tgz over 1 MB.
  const big = require('crypto').randomBytes(2 * 1024 * 1024).toString('base64');
  const tgz = makeFixtureTgz({
    'bin/tunlite.js': '#!/usr/bin/env node\nconsole.log("v");\n',
    'package.json': '{"name":"tunlite","version":"4.5.6"}\n',
    'docs/blob.bin': big,
  });
  assert.ok(fs.statSync(tgz).size > 1024 * 1024, 'fixture tarball must exceed the old 1 MB limit');
  const prev = process.env.TUNLITE_ARCHIVE_URL;
  process.env.TUNLITE_ARCHIVE_URL = 'file://' + tgz;
  let dir;
  try {
    dir = cli.archiveFetch('https://example.invalid/x.git', undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '4.5.6');
    assert.ok(!fs.existsSync(path.join(dir, 'archive.tar.gz')), 'downloaded archive is cleaned up');
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_ARCHIVE_URL; else process.env.TUNLITE_ARCHIVE_URL = prev;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveFetch refuses an insecure (http) archive URL', () => {
  const prev = process.env.TUNLITE_ARCHIVE_URL;
  process.env.TUNLITE_ARCHIVE_URL = 'http://mirror.invalid/x.tar.gz';
  try {
    assert.throws(
      () => cli.archiveFetch('https://example.invalid/x.git', undefined),
      /insecure URL/,
      'http:// must be rejected before any fetch',
    );
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_ARCHIVE_URL; else process.env.TUNLITE_ARCHIVE_URL = prev;
  }
});

// End-to-end regression guard for the Critical bug: fetch -> readVersion ->
// re-anchor a REAL anchored install, and prove the live libDir is rewritten to
// the new version AND the .tunlite-install marker survives the update.
test('runUpdate end-to-end: real archiveFetch + re-anchor updates the live libDir, marker survives', async () => {
  const repoRoot = path.join(__dirname, '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-'));
  const bin = path.join(home, 'bin');
  const realVersion = require('../package.json').version;

  const prevHome = process.env.TUNLITE_HOME;
  const prevFake = process.env.TUNLITE_FAKE_AUTOSTART;
  const prevUrl = process.env.TUNLITE_ARCHIVE_URL;
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';

  let libDir;
  try {
    // 1. REAL anchor of the repo -> gives a libDir with marker + manifest.
    const anchored = installer.anchor({ src: repoRoot, binDir: bin, env: { TUNLITE_NODE: process.execPath, PATH: bin } });
    libDir = anchored.libDir;
    assert.equal(anchored.version, realVersion);
    assert.ok(fs.existsSync(path.join(libDir, '.tunlite-install')));

    // 2. Build a fixture tarball from the repo's runtime, version bumped to 99.0.0.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2esrc-'));
    const top = path.join(work, 'tunlite-fixture');
    for (const item of ['bin', 'src', 'skill']) {
      const s = path.join(repoRoot, item);
      if (fs.existsSync(s)) fs.cpSync(s, path.join(top, item), { recursive: true });
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    pkg.version = '99.0.0';
    fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const tgz = path.join(work, 'fixture.tgz');
    const tr = cp.spawnSync('tar', ['czf', tgz, '-C', work, 'tunlite-fixture']);
    assert.equal(tr.status, 0, 'fixture tarball built');
    process.env.TUNLITE_ARCHIVE_URL = 'file://' + tgz;

    // 3. Run the real update flow wired like cli.js, but pointed at the temp install.
    const res = await u.runUpdate({}, {
      currentVersion: realVersion,
      detectMethod: () => u.detectInstallMethod(libDir),
      fetch: (tag) => cli.archiveFetch('https://example.invalid/x.git', tag),
      readVersion: (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version,
      anchor: (dir) => installer.anchor({ src: dir, libDir, binDir: bin, env: { TUNLITE_NODE: process.execPath, PATH: bin } }),
      restartDaemon: async () => ({ restarted: false }),
      rmTemp: (d) => fs.rmSync(d, { recursive: true, force: true }),
      log: () => {},
    });

    assert.equal(res.action, 'updated');
    assert.equal(res.to, '99.0.0');
    // The LIVE libDir was actually re-anchored to the new version…
    assert.equal(JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8')).version, '99.0.0');
    // …and the install marker survived the update (re-written by anchor()).
    assert.ok(fs.existsSync(path.join(libDir, '.tunlite-install')), 'marker survives the update');
    assert.equal(u.detectInstallMethod(libDir), 'installed', 'still detected as installed after update');

    fs.rmSync(work, { recursive: true, force: true });
  } finally {
    if (prevHome === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prevHome;
    if (prevFake === undefined) delete process.env.TUNLITE_FAKE_AUTOSTART; else process.env.TUNLITE_FAKE_AUTOSTART = prevFake;
    if (prevUrl === undefined) delete process.env.TUNLITE_ARCHIVE_URL; else process.env.TUNLITE_ARCHIVE_URL = prevUrl;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
