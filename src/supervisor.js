'use strict';

const cp = require('child_process');
const net = require('net');
const { EventEmitter } = require('events');
const ssh = require('./ssh');
const { Backoff } = require('./backoff');

// States the supervised tunnel can be in.
const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  CONNECTED: 'connected',
  RETRYING: 'retrying',
  NEEDS_AUTH: 'needs-auth',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

// How long the ssh child must survive before we call it "connected".
const CONNECT_GRACE_MS = 3000;
// Slow re-probe interval while waiting for the user to run `setup-key`.
const NEEDS_AUTH_RETRY_MS = 30000;
// Grace after SIGTERM before we escalate to SIGKILL on a wedged child.
const STOP_GRACE_MS = 3000;

class Supervisor extends EventEmitter {
  constructor(tunnel, settings = {}, opts = {}) {
    super();
    this.tunnel = tunnel;
    this.settings = settings;
    this.opts = opts;
    this.sshBinary = opts.sshBinary || ssh.sshBinary();
    this.backoff = new Backoff(settings.backoff || {});
    this.state = STATE.IDLE;
    this.child = null;
    this.startedAt = null;
    this.connectedAt = null;
    this.restarts = 0;
    this.lastError = null;
    this.lastExitCode = null;
    this._timer = null;
    this._graceTimer = null;
    this._killTimer = null;
    this._stopped = false;
    // injectable for tests
    this._spawnFn = opts.spawn || cp.spawn;
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;
    this._now = opts.now || (() => Date.now());
    this._connectGraceMs = opts.connectGraceMs ?? CONNECT_GRACE_MS;
    this._needsAuthRetryMs = opts.needsAuthRetryMs ?? NEEDS_AUTH_RETRY_MS;
    this._stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  }

  start() {
    this._stopped = false;
    this._spawn();
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { name: this.tunnel.name, state, ...extra });
  }

  _spawn() {
    if (this._stopped) return;
    this._clearTimers();
    const args = ssh.buildArgs(this.tunnel, this.settings, { batch: true });
    this.startedAt = this._now();
    this.connectedAt = null;
    this._setState(STATE.STARTING);
    this.emit('log', `starting ssh ${this.sshBinary} ${args.join(' ')}`);

    let child;
    try {
      // windowsHide: never pop a console window for the ssh child on Windows
      // (otherwise each tunnel spawns its own terminal; closing it drops the
      // connection and the reconnect spawns another). No-op off Windows.
      child = this._spawnFn(this.sshBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      this.lastError = err.message;
      return this._scheduleRetry();
    }
    this.child = child;
    this.pid = child.pid;

    if (child.stderr) {
      child.stderr.on('data', (d) => this._onStderr(String(d)));
    }
    if (child.stdout) {
      child.stdout.on('data', (d) => this.emit('log', String(d).trimEnd()));
    }

    child.on('error', (err) => {
      this.lastError = err.message;
      this.emit('log', `spawn error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.pid = null;
      this.lastExitCode = code;
      this._clearTimers();
      if (this._stopped) {
        this._setState(STATE.STOPPED);
        return;
      }
      this.emit('log', `ssh exited code=${code} signal=${signal}`);
      this._classifyAndReact(code);
    });

    // After the grace period, if still alive, consider it connected.
    this._graceTimer = this._setTimeout(() => {
      if (this.child && !this._stopped) {
        this._confirmConnected();
      }
    }, this._connectGraceMs);
  }

  _onStderr(text) {
    this.emit('log', text.trimEnd());
    // capture the most informative line as lastError, ignoring benign ssh noise
    const line = text.trim().split('\n').filter(Boolean).pop();
    if (line && !isBenignStderr(line)) this.lastError = line;
  }

  _confirmConnected() {
    const ports = ssh.listeningPorts(this.tunnel);
    if (ports.length === 0) {
      // remote-only (-R): trust process liveness
      this._markConnected();
      return;
    }
    // ssh is up either way; probe the first expected local listener only for a
    // health hint, then mark connected regardless of the result.
    probePort(ports[0], 1500).then((listening) => {
      if (this._stopped || !this.child) return;
      if (!listening) {
        this.emit('log', `listener ${ports[0].host}:${ports[0].port} not accepting yet`);
      }
      this._markConnected();
    });
  }

  _markConnected() {
    this.connectedAt = this._now();
    // Clear pre-connect failure residue so a healthy tunnel reads clean.
    this.lastError = null;
    this.lastExitCode = null;
    this._setState(STATE.CONNECTED, { pid: this.pid });
  }

  _classifyAndReact(code) {
    const err = (this.lastError || '').toLowerCase();
    const forwardFailure = err.includes('forward') || err.includes('address already in use') || err.includes('bind');
    const authFailure = err.includes('permission denied') || err.includes('publickey') || err.includes('authentication');

    if (authFailure) {
      this._setState(STATE.NEEDS_AUTH, { lastError: this.lastError });
      this.emit('needs-auth', { name: this.tunnel.name });
      // slow periodic re-check in case the user runs setup-key
      this._timer = this._setTimeout(() => this._spawn(), this._needsAuthRetryMs);
      return;
    }
    if (forwardFailure) {
      this._setState(STATE.FAILED, { lastError: this.lastError });
      // Forward failures (e.g. local port in use) won't fix themselves quickly;
      // retry slowly rather than hot-looping.
      this._timer = this._setTimeout(() => this._spawn(), this._needsAuthRetryMs);
      return;
    }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._stopped) return;
    // Only treat the last connection as "stable" (and reset the backoff) if it was
    // sustained at least resetAfterMs; a tunnel that merely survives the connect
    // grace and then drops keeps escalating instead of hot-looping at the base delay.
    if (this.connectedAt && (this._now() - this.connectedAt) >= this.backoff.opts.resetAfterMs) {
      this.backoff.reset();
    }
    this.restarts += 1;
    const delay = this.backoff.next();
    this._setState(STATE.RETRYING, { delayMs: delay, restarts: this.restarts });
    this.emit('log', `reconnecting in ${delay}ms (attempt ${this.restarts})`);
    this._timer = this._setTimeout(() => this._spawn(), delay);
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    if (this.child) {
      const child = this.child;
      // Arm the force-kill BEFORE sending SIGTERM: kill() can fire the child's
      // 'exit' synchronously (e.g. an already-dead pid, or a fake child in
      // tests), and that exit handler calls _clearTimers() to cancel this timer.
      // If we armed it after, a synchronous exit would leave the timer dangling
      // and SIGKILL a pid we no longer own.
      //
      // The timer survives only if the child IGNORES SIGTERM (never exits) — then
      // it escalates. (Gating on child.killed would be wrong: it's true the
      // moment any signal is delivered, so a process that ignores SIGTERM would
      // never get SIGKILL.)
      this._killTimer = this._setTimeout(() => {
        this._killTimer = null;
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }, this._stopGraceMs);
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    } else {
      this._setState(STATE.STOPPED);
    }
  }

  _clearTimers() {
    if (this._timer) { this._clearTimeout(this._timer); this._timer = null; }
    if (this._graceTimer) { this._clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this._killTimer) { this._clearTimeout(this._killTimer); this._killTimer = null; }
  }

  status() {
    const now = this._now();
    return {
      name: this.tunnel.name,
      host: this.tunnel.host,
      port: this.tunnel.port,
      identityFile: this.tunnel.identityFile,
      sshOptions: this.tunnel.sshOptions,
      jump: this.tunnel.jump,
      tags: this.tunnel.tags,
      enabled: this.tunnel.enabled,
      autoSetupKey: this.tunnel.autoSetupKey,
      state: this.state,
      pid: this.pid || null,
      restarts: this.restarts,
      uptimeMs: this.connectedAt ? now - this.connectedAt : 0,
      lastError: this.lastError,
      lastExitCode: this.lastExitCode,
      forwards: this.tunnel.forwards,
    };
  }
}

// ssh prints these to stderr but they don't mean the tunnel failed — don't let
// them masquerade as lastError in `status`.
const BENIGN_STDERR = [
  /TCP_NODELAY/i,
  /post-quantum/i,
  /store now, decrypt later/i,
  /openssh\.com\/pq/i,
  /not using a post-quantum/i,
  /^\s*\*\*/, // the "** WARNING ... **" banner lines
];

function isBenignStderr(line) {
  return BENIGN_STDERR.some((re) => re.test(line));
}

// Resolve true if something is listening on host:port within timeoutMs.
function probePort({ host, port }, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

module.exports = { Supervisor, STATE, probePort, isBenignStderr };
