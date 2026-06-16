'use strict';

// Linux systemd (user) service adapter.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Unit name is derived from ctx (ctx.systemdUnit, computed in index.js context())
// so an explicit ctx is honored — mirrors launchd reading ctx.label. Falls back
// to the default when called without a ctx.
function unitName(ctx) { return `${(ctx && ctx.systemdUnit) || 'tunlite'}.service`; }

function unitPath(ctx) {
  const dir = (ctx && ctx.systemdDir) || process.env.TUNLITE_SYSTEMD_DIR;
  if (dir) return path.join(dir, unitName(ctx));
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user', unitName(ctx));
}

function render(ctx) {
  const content = `[Unit]
Description=tunlite SSH tunnel manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${ctx.nodePath} ${ctx.entry} daemon run
Restart=always
RestartSec=5
Environment=PATH=${ctx.pathEnv}

[Install]
WantedBy=default.target
`;
  return { path: unitPath(ctx), content };
}

function userctl(args, opts = {}) {
  return cp.spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', ...opts });
}

function install(ctx) {
  const { path: file, content } = render(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(ctx.logDir, { recursive: true });
  fs.writeFileSync(file, content);
  userctl(['daemon-reload']);
  const r = userctl(['enable', '--now', unitName(ctx)]);
  return {
    path: file,
    ok: r.status === 0,
    output: (r.stderr || r.stdout || '').trim(),
    note: 'For tunnels to start before login, run: loginctl enable-linger',
  };
}

function uninstall(ctx) {
  const file = unitPath(ctx);
  userctl(['disable', '--now', unitName(ctx)]);
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch (_) {}
  userctl(['daemon-reload']);
  return { path: file, ok: true, removed };
}

function status(ctx) {
  const file = unitPath(ctx);
  const installed = fs.existsSync(file);
  const active = userctl(['is-active', unitName(ctx)]);
  const enabled = userctl(['is-enabled', unitName(ctx)]);
  return {
    platform: 'systemd',
    installed,
    running: (active.stdout || '').trim() === 'active',
    enabled: (enabled.stdout || '').trim() === 'enabled',
    path: file,
  };
}

module.exports = { render, install, uninstall, status, unitPath, unitName };
