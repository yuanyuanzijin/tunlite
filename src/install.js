'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const paths = require('./paths');

// Path segments that mean "this node belongs to a version manager" — pinning one
// is fragile (uninstalling that version, or a service launched without the
// manager's PATH, breaks it).
const VERSION_MANAGER_RE = /[\\/](?:\.nvm|\.fnm|\.volta|fnm_multishells|n[\\/]versions)[\\/]/i;

// Choose an absolute node path to bake into the launcher. Prefer a system node;
// avoid version-manager nodes; fall back to the current one with a warning.
// Returns { path, source: 'override'|'system'|'current'|'version-manager', warn? }.
function pickStableNode(opts = {}) {
  const env = opts.env || process.env;
  const execPath = opts.execPath || process.execPath;
  const existsSync = opts.existsSync || fs.existsSync;
  if (env.TUNLITE_NODE) return { path: env.TUNLITE_NODE, source: 'override' };

  const candidates = os.platform() === 'win32'
    ? [env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', 'node.exe')].filter(Boolean)
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const c of candidates) {
    if (existsSync(c)) return { path: c, source: 'system' };
  }
  if (!VERSION_MANAGER_RE.test(execPath)) return { path: execPath, source: 'current' };
  return { path: execPath, source: 'version-manager', warn: true };
}

// Single-quote a string for POSIX sh.
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function launcherPosix(nodePath, entry) {
  const fallbacks = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']
    .filter((p) => p !== nodePath);
  const list = [shq(nodePath), ...fallbacks].join(' ');
  return `#!/bin/sh
# tunlite launcher — pinned node so nvm/fnm/volta version switches don't break it.
for n in ${list}; do
  [ -x "$n" ] || continue
  "$n" -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' 2>/dev/null \\
    && exec "$n" ${shq(entry)} "$@"
done
command -v node >/dev/null 2>&1 && exec node ${shq(entry)} "$@"
echo "tunlite: no usable node (>=18) found on PATH" >&2
exit 127
`;
}

function launcherWin(nodePath, entry) {
  // Mirror launcherPosix: try the pinned node, then `node` from PATH, gating each
  // on a >=18 check (so nvm/fnm/volta version switches or a too-old node can't
  // silently break the launcher). delayed-expansion (!errorlevel!) lets us forward
  // node's exit code from inside the for body.
  const lines = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    `for %%N in ("${nodePath}" "node") do (`,
    `  %%~N -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" >nul 2>&1 && (`,
    `    %%~N "${entry}" %* & exit /b !errorlevel!`,
    '  )',
    ')',
    'echo tunlite: no usable node ^(^>=18^) found >&2',
    'exit /b 127',
  ];
  return lines.join('\r\n') + '\r\n';
}

// Write the launcher into binDir. POSIX: an executable sh shim named `tunlite`.
// Windows: a `tunlite.cmd`. Returns the launcher path.
function writeLauncher(binDir, entry, nodePath, opts = {}) {
  const platform = opts.platform || (os.platform() === 'win32' ? 'win32' : 'posix');
  const fsm = opts.fs || fs;
  fsm.mkdirSync(binDir, { recursive: true });
  if (platform === 'win32') {
    const link = path.join(binDir, 'tunlite.cmd');
    fsm.writeFileSync(link, launcherWin(nodePath, entry));
    return link;
  }
  const link = path.join(binDir, 'tunlite');
  fsm.rmSync(link, { force: true }); // replace a prior symlink/file
  fsm.writeFileSync(link, launcherPosix(nodePath, entry), { mode: 0o755 });
  fsm.chmodSync(link, 0o755);
  return link;
}

// Short alias command. `tunlite` stays the canonical name; `tun` is the quick
// daily one (both launchers, same pinned-node content, same entry).
const ALIAS_NAME = 'tun';

// Write the `tun` alias next to the canonical launcher. Guarded: never clobber a
// foreign `tun` already in binDir (one without our marker) so we don't hijack an
// unrelated command. Returns { name, path, written, skipped? }.
function writeAlias(binDir, entry, nodePath, opts = {}) {
  const platform = opts.platform || (os.platform() === 'win32' ? 'win32' : 'posix');
  const fsm = opts.fs || fs;
  const name = platform === 'win32' ? `${ALIAS_NAME}.cmd` : ALIAS_NAME;
  const link = path.join(binDir, name);
  if (fsm.existsSync(link)) {
    let existing = '';
    try { existing = fsm.readFileSync(link, 'utf8'); } catch (_) {}
    if (!/tunlite/.test(existing)) return { name, path: link, written: false, skipped: 'exists' };
  }
  fsm.mkdirSync(binDir, { recursive: true });
  if (platform === 'win32') {
    fsm.writeFileSync(link, launcherWin(nodePath, entry));
    return { name, path: link, written: true };
  }
  fsm.rmSync(link, { force: true });
  fsm.writeFileSync(link, launcherPosix(nodePath, entry), { mode: 0o755 });
  fsm.chmodSync(link, 0o755);
  return { name, path: link, written: true };
}

// Runtime files mirrored from package.json "files".
const RUNTIME_ITEMS = ['bin', 'src', 'skill', 'package.json', 'LICENSE', 'README.md'];

// Copy the runtime from src into libDir atomically-ish: stage to libDir.new,
// validate it runs, then swap. No-op if src is already libDir.
// `validate(entry)` returns an exit code (0 = ok); defaults to spawning node.
function copyRuntime(src, libDir, opts = {}) {
  const fsm = opts.fs || fs;
  if (path.resolve(src) === path.resolve(libDir)) return { copied: false };

  // Self-heal a prior interrupted swap: the swap below renames libDir -> libDir.old
  // then stage -> libDir as two steps. If the process died between them, libDir is
  // missing while the real copy is stranded at libDir.old. Restore it before staging
  // so an interrupted install recovers instead of leaving no runtime at all.
  const oldDir = libDir + '.old';
  if (!fsm.existsSync(libDir) && fsm.existsSync(oldDir)) {
    fsm.renameSync(oldDir, libDir);
  }

  const stage = libDir + '.new';
  fsm.rmSync(stage, { recursive: true, force: true });
  fsm.mkdirSync(stage, { recursive: true });
  for (const item of RUNTIME_ITEMS) {
    const s = path.join(src, item);
    if (fsm.existsSync(s)) fsm.cpSync(s, path.join(stage, item), { recursive: true });
  }

  const entry = path.join(stage, 'bin', 'tunlite.js');
  const validate = opts.validate || ((e) => {
    const node = opts.nodePath || process.execPath;
    return cp.spawnSync(node, [e, 'version'], { encoding: 'utf8' }).status;
  });
  if (validate(entry) !== 0) {
    fsm.rmSync(stage, { recursive: true, force: true });
    throw new Error('staged runtime failed validation');
  }

  fsm.rmSync(oldDir, { recursive: true, force: true });
  if (fsm.existsSync(libDir)) fsm.renameSync(libDir, oldDir);
  fsm.mkdirSync(path.dirname(libDir), { recursive: true });
  fsm.renameSync(stage, libDir);
  fsm.rmSync(oldDir, { recursive: true, force: true }); // clean up the superseded copy
  return { copied: true };
}

function writeManifest(m, opts = {}) {
  const fsm = opts.fs || fs;
  const file = opts.file || paths.installManifestFile();
  fsm.mkdirSync(path.dirname(file), { recursive: true });
  fsm.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  return file;
}

function readManifest(opts = {}) {
  const fsm = opts.fs || fs;
  try { return JSON.parse(fsm.readFileSync(opts.file || paths.installManifestFile(), 'utf8')); }
  catch (_) { return null; }
}

// True when the currently-running code (or opts.dir) is the anchored copy.
function isAnchored(opts = {}) {
  const m = readManifest(opts);
  if (!m || !m.libDir) return false;
  const here = path.resolve(opts.dir || path.join(__dirname, '..'));
  // Compare canonical (symlink-resolved) paths. Node realpaths a module's
  // __dirname, so `here` is already canonical, but the manifest stores the
  // literal libDir — they differ whenever libDir is reached through a symlink
  // (e.g. /home -> /var/home on Fedora Silverblue/CoreOS, or /tmp -> /private/tmp
  // on macOS). Without this a correct install reports un-anchored forever — the
  // nudge never clears and `update` refuses to self-update. realpathSync throws
  // on a missing path, so fall back to the literal for stale/absent dirs.
  const canon = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  return canon(m.libDir) === canon(here);
}

// Best-effort: converge to one install by removing a prior npm-global `tunlite`
// (only ever `tunlite`, never the legacy `tunl`). Skipped in sandboxes.
function cleanupLegacy(opts = {}) {
  if (process.env.TUNLITE_FAKE_AUTOSTART) return { skipped: true, removed: [] };
  const spawnSync = opts.spawnSync || cp.spawnSync;
  const removed = [];
  try {
    const ls = spawnSync('npm', ['ls', '-g', '--depth=0', '--json'], { encoding: 'utf8' });
    let has = false;
    try { has = !!(JSON.parse(ls.stdout || '{}').dependencies || {}).tunlite; } catch (_) {}
    if (has) {
      const u = spawnSync('npm', ['uninstall', '-g', 'tunlite'], { encoding: 'utf8' });
      if (u && u.status === 0) removed.push('npm:tunlite');
    }
  } catch (_) { /* npm absent or failed — ignore */ }
  return { removed };
}

// Where the launcher goes: $TUNLITE_BIN, else /usr/local/bin if writable, else
// ~/.local/bin (posix) / %LOCALAPPDATA%\tunlite\bin (win).
function pickBinDir(opts = {}) {
  const env = opts.env || process.env;
  const access = opts.accessSync || ((p, m) => fs.accessSync(p, m));
  if (env.TUNLITE_BIN) return env.TUNLITE_BIN;
  if (os.platform() === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'tunlite', 'bin');
  }
  try { access('/usr/local/bin', fs.constants.W_OK); return '/usr/local/bin'; }
  catch (_) { return path.join(os.homedir(), '.local', 'bin'); }
}

function isOnPath(binDir, env = process.env) {
  const sep = os.platform() === 'win32' ? ';' : ':';
  const norm = (p) => path.resolve(p);
  return (env.PATH || '').split(sep).some((p) => p && norm(p) === norm(binDir));
}

// Persist binDir into the Windows *user* PATH (HKCU) so a freshly-opened terminal
// finds `tunlite`. We shell out to PowerShell's .NET API rather than `setx`
// because setx truncates at 1024 chars and writes back the merged system+user
// PATH (corrupting the user value); SetEnvironmentVariable(...,'User') edits only
// the user scope AND broadcasts WM_SETTINGCHANGE so new shells pick it up.
// Idempotent: a case-insensitive match means no-op (re-runs on every update).
// POSIX is intentionally a no-op — the printed `~/.profile` hint already works
// there and auto-editing a user's shell rc is more invasive than asked.
// Skipped under TUNLITE_FAKE_AUTOSTART so sandboxes/tests never touch the real
// registry. Returns one of:
//   { applicable: false }                              // posix or fake mode
//   { applicable: true,  changed: true }               // appended to user PATH
//   { applicable: true,  changed: false }              // already present
//   { applicable: true,  changed: false, error: <msg> }// the write attempt failed
function ensureUserPath(binDir, opts = {}) {
  const platform = opts.platform || (os.platform() === 'win32' ? 'win32' : 'posix');
  if (platform !== 'win32') return { applicable: false };
  if (process.env.TUNLITE_FAKE_AUTOSTART) return { applicable: false };
  const spawnSync = opts.spawnSync || cp.spawnSync;
  // Single-quote for PowerShell ('' escapes a literal quote); inside single
  // quotes $ and \ are literal, so a Windows path needs no further escaping.
  const lit = `'${String(binDir).replace(/'/g, "''")}'`;
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$bin = ${lit}`,
    "$cur = [Environment]::GetEnvironmentVariable('Path','User')",
    'if ([string]::IsNullOrEmpty($cur)) {',
    "  [Environment]::SetEnvironmentVariable('Path',$bin,'User'); 'changed'",
    "} elseif (($cur -split ';') -notcontains $bin) {",
    "  $sep = if ($cur.EndsWith(';')) { '' } else { ';' }",
    "  [Environment]::SetEnvironmentVariable('Path',$cur+$sep+$bin,'User'); 'changed'",
    "} else { 'present' }",
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    if (!r || r.status !== 0) {
      const msg = (r && (r.stderr || '').trim()) || (r && r.error && r.error.message) || `powershell exited ${r && r.status}`;
      return { applicable: true, changed: false, error: msg };
    }
    return { applicable: true, changed: /changed/.test(r.stdout || '') };
  } catch (e) {
    return { applicable: true, changed: false, error: e.message };
  }
}

// Full anchor: pick node -> copy runtime -> write launcher -> manifest -> clean
// legacy. Returns a result object for the CLI to render.
function anchor(opts = {}) {
  const env = opts.env || process.env;
  const src = opts.src || path.join(__dirname, '..');
  const libDir = opts.libDir || paths.libDir();
  const binDir = opts.binDir || pickBinDir({ env });
  const node = pickStableNode({ env });
  const runCleanupLegacy = opts.cleanupLegacy || cleanupLegacy;

  const copied = copyRuntime(src, libDir, { nodePath: node.path }).copied;
  // Remove a prior npm-global tunlite BEFORE writing our launcher. binDir can be
  // the very dir npm uses for global bins (e.g. /usr/local/bin), so running
  // `npm uninstall -g tunlite` AFTER writeLauncher could delete the launcher we
  // just wrote ("update succeeded but tunlite vanished"). copyRuntime has already
  // staged libDir from src, so dropping the old npm copy now is safe.
  const legacy = runCleanupLegacy({});
  const entry = path.join(libDir, 'bin', 'tunlite.js');
  const launcher = writeLauncher(binDir, entry, node.path);
  const alias = writeAlias(binDir, entry, node.path, { platform: opts.platform });
  const version = JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8')).version;
  // Write the install marker into libDir. This is what `update`'s
  // detectInstallMethod keys on to tell an anchored install (updatable) apart
  // from a dev checkout. It must live at the install location and be re-created
  // on every (re-)anchor — an update swaps in a fresh libDir without the marker,
  // so writing it here (not in copyRuntime/RUNTIME_ITEMS) restores it each time.
  fs.writeFileSync(path.join(libDir, '.tunlite-install'), version + '\n');
  writeManifest({ libDir, binDir, nodePath: node.path, version, installedAt: Date.now() });

  // On Windows, persist binDir into the user PATH so a new terminal finds tunlite
  // without the user editing env vars by hand. Skip when binDir is already on the
  // process PATH (nothing to do). POSIX returns {applicable:false} (no-op).
  const onPath = isOnPath(binDir, env);
  const pathUpdate = onPath ? { applicable: false } : ensureUserPath(binDir, { platform: opts.platform });

  return {
    libDir, binDir, entry, launcher, alias, version, copied, legacy,
    nodePath: node.path, nodeSource: node.source, nodeWarn: !!node.warn,
    onPath, pathUpdate,
  };
}

module.exports = {
  pickStableNode, writeLauncher, writeAlias, ALIAS_NAME, copyRuntime,
  writeManifest, readManifest, isAnchored,
  cleanupLegacy, pickBinDir, isOnPath, ensureUserPath, anchor,
};
