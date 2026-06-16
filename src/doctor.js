'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ssh = require('./ssh');
const config = require('./config');
const paths = require('./paths');
const ipc = require('./ipc');
const installer = require('./install');
const autostart = require('./autostart');
const { probePort } = require('./supervisor');

// Read-only default key lookup — never generates (unlike ssh.ensureKeypair).
function defaultKeypairExists() {
  const dir = path.join(os.homedir(), '.ssh');
  for (const n of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// { running, tunnels:[{name,state,lastError,...}] } from the live daemon, if any.
async function defaultDaemonStatus() {
  let ping = null;
  try { ping = await ipc.request(paths.socketPath(), 'ping', {}); } catch (_) {}
  if (!ping) return { running: false, tunnels: [] };
  let tunnels = [];
  try { tunnels = await ipc.request(paths.socketPath(), 'status', {}); } catch (_) {}
  return { running: true, tunnels: tunnels || [] };
}

function defaultDeps() {
  return {
    commandExists: ssh.commandExists,
    probeAuth: ssh.probeAuth,
    probePort: (hp) => probePort(hp, 1500),
    keypairExists: defaultKeypairExists,
    isAnchored: () => installer.isAnchored(),
    readManifest: () => installer.readManifest(),
    isOnPath: (binDir) => installer.isOnPath(binDir),
    fileExists: (p) => { try { return fs.existsSync(p); } catch (_) { return false; } },
    daemonStatus: defaultDaemonStatus,
    serviceStatus: () => autostart.adapterFor().status(autostart.context()),
    loadConfig: (file) => config.load(file),
  };
}

async function diagnoseTunnel(t, { d, sshOk, runtime, running }) {
  const group = `tunnel:${t.name}`;
  const out = [];
  const push = (id, title, status, detail, fix = null) => out.push({ group, id, title, status, detail, fix });

  const rtState = runtime ? runtime.state : (running ? 'idle' : 'daemon-stopped');
  push('tunnel-state', `${t.name}: state`, 'info',
    running ? `daemon reports: ${rtState}${runtime && runtime.lastError ? ` (${runtime.lastError})` : ''}` : 'daemon not running',
    null);

  if (!sshOk) {
    push('tunnel-auth', `${t.name}: reachability`, 'skip', 'skipped — ssh not found', null);
  } else {
    const probe = await d.probeAuth(t.host, { port: t.port || 22, identityFile: t.identityFile, jump: t.jump, sshOptions: t.sshOptions });
    if (probe.ok && probe.restricted) push('tunnel-auth', `${t.name}: reachability`, 'ok', `${t.host}: passwordless OK (tunnel-only host)`, null);
    else if (probe.ok) push('tunnel-auth', `${t.name}: reachability`, 'ok', `${t.host}: passwordless OK`, null);
    else push('tunnel-auth', `${t.name}: reachability`, 'fail', `${t.host}: not passwordless`, `tunlite setup-key ${t.host}`);
  }

  const connected = runtime && runtime.state === 'connected';
  for (const f of t.forwards || []) {
    const where = `${f.bind}:${f.srcPort}`;
    if (f.type === 'remote') {
      push('tunnel-ports', `${t.name}: ${where}`, 'info', 'remote (-R) listener is on the server — not probed locally', null);
      continue;
    }
    const listening = await d.probePort({ host: f.bind || '127.0.0.1', port: f.srcPort });
    if (connected) {
      if (listening) push('tunnel-ports', `${t.name}: ${where}`, 'ok', 'connected and accepting', null);
      else push('tunnel-ports', `${t.name}: ${where}`, 'warn', 'connected but not accepting yet', null);
    } else if (listening) {
      push('tunnel-ports', `${t.name}: ${where}`, 'warn', `port ${f.srcPort} already in use — bind will fail`, `free ${where} or change the listen port`);
    } else {
      push('tunnel-ports', `${t.name}: ${where}`, 'ok', `port ${f.srcPort} is free`, null);
    }
  }
  return out;
}

// diagnose({ configFile, name, deps }) -> { checks, summary, ok }
async function diagnose(opts = {}) {
  const d = Object.assign(defaultDeps(), opts.deps || {});
  const configFile = opts.configFile || paths.configFile();
  const checks = [];
  const add = (group, id, title, status, detail, fix = null) => checks.push({ group, id, title, status, detail, fix });

  // environment
  const sshOk = d.commandExists('ssh');
  add('env', 'ssh-client', 'ssh client', sshOk ? 'ok' : 'fail',
    sshOk ? 'found on PATH' : 'ssh not found on PATH',
    sshOk ? null : 'install an OpenSSH client (e.g. brew install openssh / apt install openssh-client)');
  const keygenOk = d.commandExists('ssh-keygen');
  add('env', 'ssh-keygen', 'ssh-keygen', keygenOk ? 'ok' : 'warn',
    keygenOk ? 'found on PATH' : 'not found (only needed to generate keys)',
    keygenOk ? null : 'install OpenSSH (provides ssh-keygen)');
  const keyPath = d.keypairExists();
  add('env', 'ssh-key', 'SSH private key', keyPath ? 'ok' : 'warn',
    keyPath ? `using ${keyPath}` : 'no default key in ~/.ssh (id_ed25519|id_ecdsa|id_rsa)',
    keyPath ? null : 'tunlite setup-key <user@host>   (generates one if missing)');

  // install
  const manifest = d.readManifest();
  const anchored = d.isAnchored();
  add('install', 'anchored', 'anchored install', anchored ? 'ok' : 'warn',
    anchored ? 'running from the anchored copy' : 'not anchored (running from a dev / node_modules copy)',
    anchored ? null : 'tunlite install');
  if (manifest && manifest.binDir) {
    const onPath = d.isOnPath(manifest.binDir);
    add('install', 'on-path', 'on PATH', onPath ? 'ok' : 'warn',
      onPath ? `${manifest.binDir} is on PATH` : `${manifest.binDir} not on PATH`,
      onPath ? null : 'tunlite install   (or add the binDir to PATH)');
    const nodeOk = manifest.nodePath ? d.fileExists(manifest.nodePath) : false;
    add('install', 'pinned-node', 'pinned node', nodeOk ? 'ok' : 'warn',
      nodeOk ? `pinned node ${manifest.nodePath}` : `pinned node missing: ${manifest.nodePath || '(none)'}`,
      nodeOk ? null : 'tunlite install   (re-pick a stable node)');
  } else {
    add('install', 'pinned-node', 'pinned node', 'info', 'no install manifest yet (covered by: anchored)', null);
  }

  // config
  let cfg = null, cfgErr = null;
  try { cfg = d.loadConfig(configFile); } catch (e) { cfgErr = e.message; }
  add('install', 'config-valid', 'config file', cfgErr ? 'fail' : 'ok',
    cfgErr ? cfgErr : `valid (${configFile})`,
    cfgErr ? `fix the JSON at ${configFile}` : null);

  // daemon + service
  const dstat = await d.daemonStatus(configFile);
  const defined = cfg ? cfg.tunnels : [];
  if (defined.length === 0) {
    add('daemon', 'daemon', 'daemon', 'info', dstat.running ? 'running (no tunnels configured)' : 'not running (no tunnels configured)', null);
  } else if (dstat.running) {
    add('daemon', 'daemon', 'daemon', 'ok', 'running', null);
  } else {
    add('daemon', 'daemon', 'daemon', 'fail', `${defined.length} tunnel(s) configured but the daemon is not running`, 'tunlite up');
  }

  let svc = null;
  try { svc = d.serviceStatus(); } catch (_) { svc = null; }
  if (!svc || svc.platform === 'sandbox') {
    add('daemon', 'service', 'autostart service', 'info', svc ? 'sandbox (service untouched)' : 'service status unavailable on this platform', null);
  } else if (svc.installed) {
    add('daemon', 'service', 'autostart service', 'ok', svc.running ? 'installed and running' : 'installed (not running)', null);
  } else if (defined.length > 0) {
    add('daemon', 'service', 'autostart service', 'warn', 'not installed — tunnels won\'t start at boot', 'tunlite install service');
  } else {
    add('daemon', 'service', 'autostart service', 'info', 'not installed', null);
  }

  // per-tunnel (concurrent; appended in target order for stable output)
  if (cfg) {
    const targets = opts.name
      ? cfg.tunnels.filter((t) => t.name === opts.name)
      : cfg.tunnels.filter((t) => t.enabled);
    const byName = {};
    for (const r of dstat.tunnels || []) byName[r.name] = r;
    const perTunnel = await Promise.all(targets.map((t) =>
      diagnoseTunnel(t, { d, sshOk, runtime: byName[t.name], running: dstat.running })));
    for (const arr of perTunnel) for (const c of arr) checks.push(c);
  }

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) { if (c.status === 'ok') summary.ok++; else if (c.status === 'warn') summary.warn++; else if (c.status === 'fail') summary.fail++; }
  return { checks, summary, ok: summary.fail === 0 };
}

module.exports = { diagnose };
