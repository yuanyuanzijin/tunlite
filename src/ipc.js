'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Newline-delimited JSON framing over a unix socket / Windows named pipe.
//
// Request:  { id, cmd, args }
// Response: { id, ok: true, data } | { id, ok: false, error: {code,message} }
// Stream:   { id, ok: true, stream: true } then { id, event, ... } frames.

function isWindows() {
  return os.platform() === 'win32';
}

// --- line reader ---------------------------------------------------------
function lineReader(socket, onLine) {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        onLine(msg);
      }
    }
  });
}

function send(socket, obj) {
  try { socket.write(JSON.stringify(obj) + '\n'); } catch (_) { /* ignore */ }
}

// --- server --------------------------------------------------------------
// handlers: { [cmd]: async (args, ctx) => data }
// ctx = { push(frame), onClose(cb), socket }
class Server extends EventEmitter {
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.server = net.createServer((socket) => this._onConn(socket));
  }

  _onConn(socket) {
    const closeCbs = [];
    socket.on('close', () => closeCbs.forEach((cb) => { try { cb(); } catch (_) {} }));
    socket.on('error', () => {});
    lineReader(socket, async (msg) => {
      const { id, cmd, args } = msg || {};
      const handler = this.handlers[cmd];
      if (!handler) {
        send(socket, { id, ok: false, error: { code: 'unknown_cmd', message: `unknown command: ${cmd}` } });
        return;
      }
      const ctx = {
        socket,
        streaming: false,
        push(frame) {
          if (!this.streaming) {
            this.streaming = true;
            send(socket, { id, ok: true, stream: true });
          }
          send(socket, { id, event: frame });
        },
        onClose(cb) { closeCbs.push(cb); },
      };
      try {
        const data = await handler(args || {}, ctx);
        if (!ctx.streaming) {
          send(socket, { id, ok: true, data });
        }
      } catch (err) {
        send(socket, { id, ok: false, error: { code: err.code || 'error', message: err.message } });
      }
    });
  }

  listen(socketPath) {
    prepareSocketPath(socketPath);
    return this._tryListen(socketPath, true);
  }

  // Listen, applying the stale-socket dance on UNIX domain sockets. On
  // EADDRINUSE we probe the existing socket: if a live daemon answers we fail
  // (so a racing second daemon exits cleanly and the caller's ping loop adopts
  // the running one); only a stale file from a dead daemon is unlinked, and then
  // we retry the listen exactly once (retry=false).
  _tryListen(socketPath, retry) {
    return new Promise((resolve, reject) => {
      const onError = async (err) => {
        if (!isWindows() && retry && err && err.code === 'EADDRINUSE') {
          const live = await isSocketLive(socketPath);
          if (live) { reject(err); return; }
          // Stale socket from a dead daemon: remove it and retry listen once.
          try { fs.unlinkSync(socketPath); } catch (_) {}
          this._tryListen(socketPath, false).then(resolve, reject);
          return;
        }
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(socketPath, () => {
        this.server.removeListener('error', onError);
        this._socketPath = socketPath;
        // The socket inode only exists once we're listening; lock it to the owner
        // so no other local user can drive the daemon (named pipes on Windows are
        // ACL'd, not chmod'd — skip there).
        if (!isWindows()) {
          try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
        }
        resolve(this);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this.server.close(() => {
        if (!isWindows() && this._socketPath) {
          try { fs.unlinkSync(this._socketPath); } catch (_) {}
        }
        resolve();
      });
    });
  }
}

function prepareSocketPath(socketPath) {
  if (isWindows()) return;
  // Owner-only dir: when the socket falls back to ~/.tunlite/ (macOS has no
  // XDG_RUNTIME_DIR) this keeps other local users from reaching the socket.
  // Do NOT unlink the socket here: a racing second daemon would otherwise yank a
  // LIVE daemon's socket out from under it. Stale-socket cleanup is handled in
  // _tryListen, gated on probing whether a live listener answers.
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
}

// Probe a unix socket path by connecting to it. Resolves true if a live listener
// accepts the connection (so the file belongs to a running daemon), false if the
// connect fails (stale file from a dead daemon, or no listener).
function isSocketLive(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { socket.destroy(); } catch (_) {} resolve(v); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

// --- client --------------------------------------------------------------
function connect(socketPath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    // Destroy the failed socket so its handle is released. A caller that retries
    // on a loop (e.g. the monitor's per-tick fetch hitting a transiently
    // unreachable daemon) would otherwise leak one handle per attempt — on
    // Windows that piles up and keeps the event loop from draining cleanly.
    const onErr = (err) => { cleanup(); try { socket.destroy(); } catch (_) {} reject(err); };
    const onTimeout = () => { cleanup(); socket.destroy(); reject(new Error('ipc connect timeout')); };
    const t = setTimeout(onTimeout, timeoutMs);
    function cleanup() {
      clearTimeout(t);
      socket.removeListener('error', onErr);
      socket.removeListener('connect', onConn);
    }
    function onConn() { cleanup(); resolve(socket); }
    socket.once('error', onErr);
    socket.once('connect', onConn);
  });
}

// One-shot request/response. The timeout bounds the WHOLE exchange (connect +
// reply), so a wedged daemon that accepts the connection but never answers can
// never hang the caller.
async function request(socketPath, cmd, args = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const socket = await connect(socketPath, timeoutMs);
  return new Promise((resolve, reject) => {
    const id = '1';
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => {
      socket.destroy();
      reject(Object.assign(new Error('daemon did not respond in time'), { code: 'timeout' }));
    }), timeoutMs);
    lineReader(socket, (msg) => {
      if (msg.id !== id) return;
      finish(() => {
        socket.end();
        if (msg.ok) resolve(msg.data);
        else reject(Object.assign(new Error(msg.error?.message || 'ipc error'), { code: msg.error?.code }));
      });
    });
    socket.on('error', (e) => finish(() => reject(e)));
    send(socket, { id, cmd, args });
  });
}

// Streaming request: invokes onFrame for each event; returns a handle with stop().
// The timeout only bounds the time to the first frame; once streaming starts the
// caller controls the lifetime via stop().
async function stream(socketPath, cmd, args, onFrame, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const socket = await connect(socketPath, timeoutMs);
  const id = '1';
  return new Promise((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => {
      if (started) return;
      socket.destroy();
      reject(Object.assign(new Error('daemon did not respond in time'), { code: 'timeout' }));
    }, timeoutMs);
    lineReader(socket, (msg) => {
      if (msg.id !== id) return;
      if (msg.ok === false) { clearTimeout(timer); socket.end(); reject(new Error(msg.error?.message || 'ipc error')); return; }
      if (msg.stream) {
        started = true;
        clearTimeout(timer);
        resolve({ stop: () => socket.end(), socket });
        return;
      }
      if (msg.event !== undefined) onFrame(msg.event);
    });
    socket.on('error', (e) => { if (!started) { clearTimeout(timer); reject(e); } });
    send(socket, { id, cmd, args });
  });
}

// Collect every frame of a non-following stream into an array, resolving when
// the daemon ends the stream (or the socket closes on error). One-shot tail for
// callers that want it all at once.
async function collect(socketPath, cmd, args, opts = {}) {
  const frames = [];
  const handle = await stream(socketPath, cmd, args, (f) => frames.push(f), opts);
  // Resolve when the daemon ends the stream ('end'/'close'). Backstop with a
  // timeout so a missing close event can't hang the caller forever — on timeout
  // return whatever frames arrived (a partial tail beats a wedged UI).
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { handle.socket.destroy(); } catch (_) {} finish(); }, opts.collectTimeoutMs || 5000);
    handle.socket.on('close', finish);
    handle.socket.on('end', finish);
  });
  return frames;
}

module.exports = { Server, request, stream, connect, collect };
