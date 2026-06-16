'use strict';

const os = require('os');
const path = require('path');

const APP = 'tunlite';

// Allow tests / advanced users to relocate everything under one root.
function root() {
  return process.env.TUNLITE_HOME || null;
}

function home() {
  return os.homedir();
}

// Config directory: where config.json lives.
function configDir() {
  if (root()) return path.join(root(), 'config');
  const platform = os.platform();
  if (platform === 'win32') {
    const base = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    return path.join(base, APP);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
  return path.join(base, APP);
}

// Data/state directory: logs, generated keys metadata, pid files.
function dataDir() {
  if (root()) return path.join(root(), 'data');
  const platform = os.platform();
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    return path.join(base, APP);
  }
  const base = process.env.XDG_STATE_HOME || path.join(home(), '.local', 'state');
  return path.join(base, APP);
}

function logDir() {
  return path.join(dataDir(), 'logs');
}

// Stable runtime copy location (independent of how the bits were delivered).
function libDir() {
  if (root()) return path.join(root(), 'lib');
  const platform = os.platform();
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
    return path.join(base, APP, 'lib');
  }
  const base = process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share');
  return path.join(base, APP);
}

// Records the canonical install (libDir, binDir, pinned node, version).
function installManifestFile() {
  return path.join(dataDir(), 'install.json');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function pidFile() {
  return path.join(dataDir(), 'daemon.pid');
}

// IPC endpoint: unix domain socket path, or Windows named pipe.
function socketPath() {
  if (process.env.TUNLITE_SOCKET) return process.env.TUNLITE_SOCKET;
  const platform = os.platform();
  if (platform === 'win32') {
    return '\\\\.\\pipe\\tunlite-daemon';
  }
  if (root()) return path.join(root(), 'daemon.sock');
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, APP, 'daemon.sock');
  return path.join(home(), '.tunlite', 'daemon.sock');
}

// Expand a leading ~ to the home directory.
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return home();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home(), p.slice(2));
  }
  return p;
}

module.exports = {
  APP,
  home,
  configDir,
  dataDir,
  logDir,
  libDir,
  configFile,
  pidFile,
  socketPath,
  expandHome,
  installManifestFile,
};
