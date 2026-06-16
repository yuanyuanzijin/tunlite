'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Per-channel ring buffer + optional file sink. Emits 'line' events so the
// daemon can fan out to `logs -f` streaming clients.
class LogHub extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.capacity = opts.capacity || 500;
    this.dir = opts.dir || null;
    this.buffers = new Map(); // channel -> array of {ts, line}
    this.streams = new Map(); // channel -> fs write stream
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    }
  }

  _now() {
    // Deterministic-friendly: callers may inject; default to wall clock.
    return this.clock ? this.clock() : Date.now();
  }

  write(channel, line) {
    const entry = { ts: this._now(), line };
    let buf = this.buffers.get(channel);
    if (!buf) { buf = []; this.buffers.set(channel, buf); }
    buf.push(entry);
    if (buf.length > this.capacity) buf.shift();
    if (this.dir) this._fileWrite(channel, entry);
    this.emit('line', { channel, ...entry });
  }

  _fileWrite(channel, entry) {
    let s = this.streams.get(channel);
    if (!s) {
      const safe = channel.replace(/[^A-Za-z0-9._-]/g, '_');
      s = fs.createWriteStream(path.join(this.dir, `${safe}.log`), { flags: 'a' });
      s.on('error', () => {});
      this.streams.set(channel, s);
    }
    const iso = new Date(entry.ts).toISOString();
    s.write(`${iso} ${entry.line}\n`);
  }

  tail(channel, n = 100) {
    const buf = this.buffers.get(channel) || [];
    return buf.slice(Math.max(0, buf.length - n));
  }

  close() {
    for (const s of this.streams.values()) { try { s.end(); } catch (_) {} }
    this.streams.clear();
  }
}

module.exports = { LogHub };
