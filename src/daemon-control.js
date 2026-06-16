'use strict';

// Daemon-process lifecycle (ping / ensure-running / restart-for-new-code) plus
// the self-update plumbing (tarball fetch + update rendering). These manage the
// supervisor PROCESS, distinct from the in-daemon tunnel reconcile. Imports from
// cli-core for shared primitives; never requires ./cli.

const cp = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const ipc = require('./ipc');
const autostart = require('./autostart');
const { EXIT, line, sleep } = require('./cli-core');

const ENTRY = path.join(__dirname, '..', 'bin', 'tunlite.js');

async function daemonPing(socketPath = paths.socketPath()) {
  try { return await ipc.request(socketPath, 'ping', {}, { timeoutMs: 1500 }); }
  catch (_) { return null; }
}

async function ensureDaemon(io) {
  const sock = paths.socketPath();
  const ping = await daemonPing(sock);
  if (ping) return ping;
  // Start detached so tunnels keep running after the CLI exits. windowsHide
  // keeps the detached daemon from opening its own console window on Windows
  // (detached children get one by default).
  const child = cp.spawn(process.execPath, [ENTRY, 'daemon', 'run'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    const p = await daemonPing(sock);
    if (p) { line(io, `daemon started (pid ${p.pid})`); return p; }
    await sleep(100);
  }
  throw Object.assign(new Error('daemon failed to start'), { exitCode: EXIT.DAEMON });
}

// Fetch a runtime tarball (no git, no npm) into a temp dir; returns the dir.
// Honors TUNLITE_ARCHIVE_URL for offline/mirror use; otherwise builds the
// GitHub `/archive/<ref>.tar.gz` URL from the repo url (works for branches and
// tags). Tries curl, then
// wget, then extracts with tar (--strip-components=1 drops the top dir).
function archiveFetch(repoUrl, tag) {
  const ref = tag || 'master';
  const base = require('./update').httpsRepoUrl(repoUrl).replace(/\.git$/, '');
  const url = process.env.TUNLITE_ARCHIVE_URL || `${base}/archive/${ref}.tar.gz`;
  // Only fetch over an encrypted transport (https) or a local file (no network).
  // Reject http and every other scheme so a MITM or a hostile mirror can't
  // downgrade the self-update channel and feed arbitrary code that then gets
  // anchored and run as the pinned entrypoint.
  if (!/^https:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    throw Object.assign(
      new Error(`refusing to fetch update over insecure URL "${url}" (only https:// or file:// allowed)`),
      { exitCode: EXIT.ERROR },
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-update-'));
  try {
    const fetcher = ['curl', '-fsSL', url];
    let r = cp.spawnSync(fetcher[0], fetcher.slice(1), { encoding: 'buffer' });
    if (r.error || r.status !== 0) {
      r = cp.spawnSync('wget', ['-qO-', url], { encoding: 'buffer' });
      if (r.error || r.status !== 0) throw new Error(`could not fetch ${url} (need curl or wget)`);
    }
    const tar = cp.spawnSync('tar', ['xz', '--strip-components=1', '-C', dir], { input: r.stdout });
    if (tar.error || tar.status !== 0) throw new Error('failed to extract update tarball (need tar)');
    return dir;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// Restart the daemon PROCESS so it loads new code (distinct from commands.restart,
// which restarts tunnels in the running daemon). Service-aware: with the OS
// service installed, KeepAlive relaunches it; otherwise spawn a fresh one.
async function restartDaemonProcess(io) {
  const before = await daemonPing();
  if (!before) return { restarted: false, reason: 'not-running' };
  const oldPid = before.pid;
  let serviceInstalled = false;
  try { serviceInstalled = autostart.adapterFor().status(autostart.context()).installed; } catch (_) {}
  line(io, 'restarting daemon to apply new code (tunnels blip ~1s)…');
  try { await ipc.request(paths.socketPath(), 'shutdown', {}); } catch (_) {}
  if (serviceInstalled) {
    for (let i = 0; i < 100; i++) {
      const p = await daemonPing();
      if (p && p.pid !== oldPid) return { restarted: true, via: 'service', pid: p.pid, version: p.version };
      await sleep(100);
    }
    return { restarted: false, reason: 'service-relaunch-timeout' };
  }
  for (let i = 0; i < 50; i++) { if (!(await daemonPing())) break; await sleep(100); }
  const p = await ensureDaemon(io);
  return { restarted: true, via: 'spawn', pid: p.pid, version: p.version };
}

function renderUpdate(io, res) {
  switch (res.action) {
    case 'refused':
      line(io, 'running from a source checkout — not self-updating. Update with git, then re-run `tunlite install`');
      return;
    case 'check':
      line(io, `current ${res.current}, ${res.explicit ? 'requested' : 'latest'} ${res.target} — ${res.available ? 'would update' : 'up to date'}`);
      return;
    case 'up-to-date':
      line(io, res.explicit ? `already on ${res.current}` : `already on the latest (${res.current})`);
      return;
    case 'updated': {
      const r = res.restarted;
      let tail;
      if (res.restartSkipped) tail = ' (daemon not restarted; new code applies on next start)';
      else if (r && r.restarted) tail = ` — daemon restarted (pid ${r.pid})`;
      else if (r && r.reason === 'not-running') tail = ' (daemon was not running)';
      else if (r && r.reason === 'service-relaunch-timeout') tail = ' — daemon did not return within 10s; the OS service should relaunch it shortly (check: tunlite status)';
      else tail = ' — daemon restart did not confirm; run: tunlite daemon start';
      line(io, `updated ${res.from} -> ${res.to}${tail}`);
      return;
    }
    default:
      line(io, JSON.stringify(res));
  }
}

module.exports = { daemonPing, ensureDaemon, archiveFetch, restartDaemonProcess, renderUpdate };
