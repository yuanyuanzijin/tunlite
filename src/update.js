'use strict';

const fs = require('fs');
const path = require('path');

// Numeric semver-ish compare; ignores any pre-release suffix. -1 / 0 / 1.
function compareVersions(a, b) {
  const parse = (s) => String(s).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// undefined/'' -> undefined (means "latest"); 'X.Y.Z' or 'vX.Y.Z' -> 'vX.Y.Z'.
// Anything else throws a usage error (exitCode 2 == EXIT.USAGE in cli.js).
function normalizeTag(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw Object.assign(new Error(`invalid version "${v}" (want X.Y.Z or vX.Y.Z)`), { exitCode: 2 });
  return `v${m[1]}.${m[2]}.${m[3]}`;
}

// Resolve symlinks so path comparisons are apples-to-apples. The running
// __dirname is canonicalized by Node's module loader, so a caller passing a
// symlinked install root would otherwise read differently.
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

// 'source' = a dev checkout (a .git, or no install marker) -> refuse self-update.
// 'installed' = an anchored copy (our .tunlite-install marker present) -> update.
function detectInstallMethod(installRoot) {
  const root = realpathOrSelf(installRoot);
  if (fs.existsSync(path.join(root, '.git'))) return 'source';
  if (fs.existsSync(path.join(root, '.tunlite-install'))) return 'installed';
  return 'source';
}

// git+ssh://git@host:port/path.git | git+https://host/path.git | scp-like -> https://host/path.git
function httpsRepoUrl(repositoryUrl) {
  let s = String(repositoryUrl || '').replace(/^git\+/, '');
  let m = /^ssh:\/\/[^@/]+@([^:/]+)(?::\d+)?\/(.+)$/.exec(s);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^[^@/]+@([^:/]+):(.+)$/.exec(s); // scp-like host:path
  if (m) return `https://${m[1]}/${m[2]}`;
  return s;
}

// Orchestrate an update. All side effects are injected via `deps` so this is
// fully unit-testable with fakes (no network, daemon, or filesystem needed).
// Crucially: it re-anchors from a fetched tarball — it NEVER runs
// `npm install -g <folder>` (which symlinked the global command at a temp dir
// then deleted it: "update succeeded but tunlite vanished").
//   opts:  { version, check, noRestart, force }
//   deps:  { currentVersion, detectMethod, fetch, readVersion, anchor,
//            restartDaemon, rmTemp, log }
async function runUpdate(opts = {}, deps = {}) {
  const { currentVersion, detectMethod, fetch, readVersion, anchor, restartDaemon, rmTemp, log = () => {} } = deps;

  if (detectMethod() === 'source') return { action: 'refused', reason: 'source-checkout' };

  const tag = normalizeTag(opts.version); // throws {exitCode:2} on garbage, before any fetch
  let tempDir;
  try {
    tempDir = await fetch(tag); // tag undefined => latest (default branch)
    const target = readVersion(tempDir);
    const explicit = Boolean(tag);
    const cmp = compareVersions(target, currentVersion);
    const wouldChange = explicit ? cmp !== 0 : cmp > 0; // latest only moves forward

    if (opts.check) return { action: 'check', current: currentVersion, target, available: wouldChange, explicit };
    if (!wouldChange && !opts.force) return { action: 'up-to-date', current: currentVersion, target, explicit };

    log(`installing ${target} (was ${currentVersion})…`);
    anchor(tempDir);

    let restarted = null;
    if (!opts.noRestart) restarted = await restartDaemon();
    return { action: 'updated', from: currentVersion, to: target, restarted, restartSkipped: Boolean(opts.noRestart) };
  } finally {
    if (tempDir && rmTemp) { try { await rmTemp(tempDir); } catch (_) { /* best effort */ } }
  }
}

module.exports = { compareVersions, normalizeTag, detectInstallMethod, httpsRepoUrl, realpathOrSelf, runUpdate };
