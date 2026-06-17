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

// Pick the highest `vX.Y.Z` from a list of tag names (non-semver tags ignored).
// Returns a normalized 'vX.Y.Z', or null if the list has no usable tag. Used to
// resolve "latest" to a real published release instead of the branch tip — so a
// self-update can only ever land on a version that was tagged (and, by our
// release discipline, also published to npm).
function pickLatestTag(names) {
  let best = null;
  for (const n of names || []) {
    const s = String(n).trim();
    if (!/^v?\d+\.\d+\.\d+$/.test(s)) continue;
    if (best === null || compareVersions(s, best) > 0) best = s;
  }
  return best ? normalizeTag(best) : null;
}

// Resolve symlinks so path comparisons are apples-to-apples. The running
// __dirname is canonicalized by Node's module loader, so a caller passing a
// symlinked install root would otherwise read differently.
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

// Classify how this copy was installed, so we only self-update what we anchored
// and otherwise point at the RIGHT updater (keeping that channel's version
// metadata authoritative):
//   'installed'  = our anchored copy (.tunlite-install marker)   -> safe to self-update
//   'git'        = a dev checkout (.git)                          -> git pull
//   'npm-global' = running from under npm's node_modules          -> npm i -g
//   'unmanaged'  = anything else                                  -> re-run the installer
function detectInstallMethod(installRoot) {
  const root = realpathOrSelf(installRoot);
  if (fs.existsSync(path.join(root, '.tunlite-install'))) return 'installed';
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (/[\\/]node_modules[\\/]/.test(root)) return 'npm-global';
  return 'unmanaged';
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
  const { currentVersion, detectMethod, fetch, readVersion, anchor, restartDaemon, rmTemp, resolveLatestTag, log = () => {} } = deps;

  const method = detectMethod();
  if (method !== 'installed') return { action: 'refused', reason: method };

  const explicitTag = normalizeTag(opts.version); // throws {exitCode:2} on garbage, before any fetch
  const explicit = Boolean(explicitTag);
  // For "latest", resolve the newest published TAG (a release that also lives on
  // npm) rather than the branch tip, so an update can never land on an
  // unreleased commit. resolveLatestTag may return null to mean "use the default
  // source" (e.g. a pinned TUNLITE_ARCHIVE_URL); it throws if it can't resolve.
  let tag = explicitTag;
  if (!explicit && resolveLatestTag) tag = await resolveLatestTag();
  let tempDir;
  try {
    tempDir = await fetch(tag); // resolved tag, or undefined => default source
    const target = readVersion(tempDir);
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

module.exports = { compareVersions, normalizeTag, pickLatestTag, detectInstallMethod, httpsRepoUrl, realpathOrSelf, runUpdate };
