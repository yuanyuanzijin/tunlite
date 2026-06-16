'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const { VERSION } = require('./version');
const { DEFAULT_ALERT_EVENTS } = require('./config');
const channels = require('./channels');

// Cap the response body we buffer from a webhook endpoint. The channel check()
// only needs the first bytes (e.g. a small JSON {errcode,...}); a hostile or
// misbehaving endpoint could otherwise stream unbounded data into the daemon.
const MAX_RESPONSE_BYTES = 8 * 1024;

// Default poster: fire-and-forget POST of a pre-formatted body with a short
// timeout. Resolves { status, text } once the response completes; rejects on
// network/timeout error. Pure Node http/https — no runtime dependency.
function defaultPost(url, { body, contentType = 'application/json' } = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { reject(new Error(`bad webhook url: ${url}`)); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const buf = Buffer.from(raw);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'content-type': contentType, 'content-length': buf.length },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      let settled = false;
      const finish = () => { if (settled) return; settled = true; resolve({ status: res.statusCode, text }); };
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (settled) return;
        text += d;
        // Once we have enough, stop reading: truncate, tear down the response so
        // the endpoint can't keep streaming, and resolve with the bytes so far.
        if (Buffer.byteLength(text) >= MAX_RESPONSE_BYTES) {
          text = text.slice(0, MAX_RESPONSE_BYTES);
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.on('error', reject);
    req.end(buf);
  });
}

// Watches per-tunnel state transitions and the daemon lifecycle, POSTing a
// webhook on meaningful edges. Edge-triggered (not level), so a reconnect storm
// alerts once, not per attempt:
//   up         starting  -> connected            (first connect / after a stop)
//   down       connected -> retrying             (a tunnel that was up dropped)
//   failed     anything  -> failed               (forward failure; first entry)
//   needs-auth anything  -> needs-auth           (auth broken; first entry)
//   recovered  down/auth -> connected            (only after a down/auth was alerted)
//   stopped    anything  -> stopped              (intentional down/remove)
// Daemon-scope events (daemon-up / daemon-down / daemon-crash) are fired by the
// daemon directly via daemonEvent().
class Alerter {
  constructor({ settings, post, log, now, hostname, version } = {}) {
    this.settings = settings || {};
    this.post = post || defaultPost;
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this.hostname = hostname || os.hostname();
    this.version = version || VERSION;
    // Suppress tunnel events during daemon shutdown (one daemon-down covers it).
    this.suspended = false;
    // name -> { prev, downAlerted, authAlerted }
    this.tunnels = new Map();
  }

  setSettings(settings) { this.settings = settings || {}; }

  forget(name) { this.tunnels.delete(name); }

  // Returns { url, channel, events } when alerting is enabled, else null.
  _cfg() {
    const w = this.settings && this.settings.alerts && this.settings.alerts.webhook;
    if (!w || !w.url || w.enabled === false) return null;
    // Never fetch a non-http(s) url (a hand-edited file://, junk, etc.): treat it
    // as disabled rather than hand it to the poster.
    if (!/^https?:\/\//i.test(w.url)) return null;
    return {
      url: w.url,
      channel: w.channel || 'generic',
      events: Array.isArray(w.events) ? w.events : DEFAULT_ALERT_EVENTS,
    };
  }

  // Feed each supervisor `state` event here. `status` is supervisor.status().
  onState(name, host, status) {
    if (this.suspended) return;
    const st = (status && status.state) || 'idle';
    let rec = this.tunnels.get(name);
    if (!rec) { rec = { prev: 'idle', downAlerted: false, authAlerted: false }; this.tunnels.set(name, rec); }
    const prev = rec.prev;
    rec.prev = st;

    let event = null;
    if (st === 'connected') {
      if (rec.downAlerted || rec.authAlerted) {
        event = 'recovered';
        rec.downAlerted = false;
        rec.authAlerted = false;
      } else {
        event = 'up'; // first connect, or back up after a clean stop
      }
    } else if (st === 'needs-auth') {
      if (!rec.authAlerted) { event = 'needs-auth'; rec.authAlerted = true; }
    } else if (st === 'failed') {
      if (prev !== 'failed') { event = 'failed'; rec.downAlerted = true; }
    } else if (st === 'retrying') {
      // Only a *drop* from a healthy tunnel counts as "down"; initial connect
      // failures (never reached connected) don't alert.
      if (prev === 'connected' && !rec.downAlerted) { event = 'down'; rec.downAlerted = true; }
    } else if (st === 'stopped') {
      event = 'stopped';
      rec.downAlerted = false;
      rec.authAlerted = false;
    } else if (st === 'idle') {
      rec.downAlerted = false;
      rec.authAlerted = false;
    }

    if (event) this._send(event, { scope: 'tunnel', tunnel: name, host: host || null, status });
  }

  // Fire a daemon-scope event. Returns the in-flight post promise (so shutdown
  // can wait for daemon-down to go out), or null when nothing is sent.
  daemonEvent(event) {
    return this._send(event, { scope: 'daemon', tunnel: null, host: null, status: null });
  }

  // Build the payload, apply the url + events filter, POST. Never throws — an
  // alert failure must not touch the tunnel or the daemon. Returns the promise.
  _send(event, { scope, tunnel, host, status }) {
    const cfg = this._cfg();
    if (!cfg) return null;
    if (!cfg.events.includes(event)) return null;
    const payload = {
      scope,
      tunnel: tunnel || null,
      host: host || null,
      event,
      state: (status && status.state) || null,
      lastError: (status && status.lastError) || null,
      restarts: (status && status.restarts) || 0,
      ts: this.now(),
      machine: this.hostname,
      version: this.version,
    };
    const who = tunnel || '(daemon)';
    const ch = channels.resolve(cfg.channel);
    const req = ch.format(payload);
    return Promise.resolve()
      .then(() => this.post(cfg.url, req))
      .then((res) => {
        const v = ch.check((res && res.status) || 0, (res && res.text) || '');
        this.log(`alert ${event} ${who} -> ${channels.redactUrl(cfg.url)} [${ch.label}] ${v.ok ? 'ok' : 'REJECTED'}${v.detail ? ` (${v.detail})` : ''}`);
      })
      .catch((e) => { this.log(`alert ${event} ${who} failed: ${e.message}`); });
  }
}

module.exports = { Alerter, defaultPost };
