'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { DEFAULTS: BACKOFF_DEFAULTS } = require('./backoff');
const { KNOWN_CHANNELS } = require('./channels');

// Alert events, in two scopes.
//   tunnel:  up/stopped are normal start/stop; down/recovered bracket a drop;
//            needs-auth/failed flag states that won't fix themselves quickly.
//   daemon:  the supervisor process starting, stopping cleanly, or having
//            crashed (detected at the next start from a stale pidfile).
const TUNNEL_EVENTS = ['up', 'down', 'recovered', 'needs-auth', 'failed', 'stopped'];
const DAEMON_EVENTS = ['daemon-up', 'daemon-down', 'daemon-crash'];
const ALERT_EVENTS = [...TUNNEL_EVENTS, ...DAEMON_EVENTS];
// Group selectors usable in `alerts events <list>`.
const ALERT_GROUPS = { tunnel: TUNNEL_EVENTS, daemon: DAEMON_EVENTS, all: ALERT_EVENTS };
// What a fresh config subscribes to: the "something's wrong / recovered" set,
// minus the chatty normal-lifecycle events.
const DEFAULT_ALERT_EVENTS = ['down', 'recovered', 'needs-auth', 'failed', 'daemon-crash'];

const DEFAULT_SETTINGS = {
  backoff: { ...BACKOFF_DEFAULTS },
  keepalive: { intervalSec: 15, countMax: 3 },
  connectTimeoutSec: 10,
  logLevel: 'info',
  // Webhook alerts; disabled by default (url:null, enabled:false).
  alerts: { webhook: { url: null, channel: 'generic', enabled: false, events: [...DEFAULT_ALERT_EVENTS] } },
};

// Expand event tokens (concrete names, a group name, `all`, or `none`) into a
// deduped list of concrete event names. Throws on an unknown token.
function expandEvents(tokens) {
  const out = [];
  const add = (e) => { if (!out.includes(e)) out.push(e); };
  for (const raw of tokens) {
    const tok = String(raw).trim();
    if (!tok || tok === 'none') continue;
    if (ALERT_GROUPS[tok]) { for (const e of ALERT_GROUPS[tok]) add(e); continue; }
    if (ALERT_EVENTS.includes(tok)) { add(tok); continue; }
    throw new Error(`unknown alert event/group "${tok}" (events: ${ALERT_EVENTS.join(', ')}; groups: tunnel, daemon, all, none)`);
  }
  return out;
}

function defaultConfig() {
  return { version: 1, settings: cloneSettings(DEFAULT_SETTINGS), tunnels: [] };
}

function cloneSettings(s) {
  return JSON.parse(JSON.stringify(s));
}

// Split a "[host:]port" / "host" / "[ipv6]" / "[ipv6]:port" string into
// { host, port }. host is '' when absent, port is null when absent. A bare
// all-digits string is a port. An unbracketed multi-colon value is treated as a
// bare IPv6 host (no port) — bracket it to attach a port. Throws on a non-numeric
// port after a single colon.
function splitHostPort(s) {
  s = String(s);
  const br = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (br) return { host: br[1], port: br[2] ? Number(br[2]) : null };
  const colons = (s.match(/:/g) || []).length;
  if (colons === 0) {
    if (/^\d+$/.test(s)) return { host: '', port: Number(s) };
    return { host: s, port: null };
  }
  if (colons === 1) {
    const i = s.indexOf(':');
    const portStr = s.slice(i + 1);
    if (!/^\d+$/.test(portStr)) throw new Error(`invalid port in "${s}" (want [host:]port)`);
    return { host: s.slice(0, i), port: Number(portStr) };
  }
  return { host: s, port: null }; // unbracketed IPv6 literal, no port
}

// Parse an SSH target "[user@]host[:port]" for --to / check / setup-key. host
// keeps the user@ prefix; port is the SSH port (null if not given → caller's 22).
function parseTarget(value) {
  if (!value || typeof value !== 'string') throw new Error('missing target (user@host[:port])');
  const at = value.lastIndexOf('@');
  const user = at >= 0 ? value.slice(0, at + 1) : '';
  const { host, port } = splitHostPort(at >= 0 ? value.slice(at + 1) : value);
  if (!host) throw new Error(`invalid target "${value}" (want user@host[:port])`);
  if (host.startsWith('-')) throw new Error(`invalid host "${host}" in "${value}" (a host may not start with "-" — it would be read by ssh as an option)`);
  if (port !== null && !isValidPort(port)) throw new Error(`invalid SSH port "${port}" in "${value}" (expected an integer 1–65535)`);
  return { host: user + host, port };
}

// Parse a ProxyJump spec "[user@]host[:port][,...]" (ssh -J) into an array of
// normalized hop strings. Accepts a comma-separated string or an array; each hop
// is validated like an SSH target. Returns [] when absent. Throws on a bad hop.
function parseJump(value) {
  if (value === undefined || value === null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const hops = [];
  for (const part of parts) {
    const s = String(part).trim();
    if (!s) continue;
    const { host, port } = parseTarget(s);
    // host still carries any user@ prefix; guard the host part itself so a hop
    // like "-oProxyCommand=..." can never reach ssh's -J as an option.
    const at = host.lastIndexOf('@');
    const bare = at >= 0 ? host.slice(at + 1) : host;
    if (bare.startsWith('-')) throw new Error(`invalid jump hop "${s}" (a host may not start with "-" — it would be read by ssh as an option)`);
    hops.push(port ? `${host}:${port}` : host);
  }
  return hops;
}

// Parse free-form tag input into a normalized list of labels. Accepts a single
// string, a comma-separated string, or an array of either; trims, splits on
// commas, drops blanks, dedupes (order-preserving). Each tag uses the same
// charset as tunnel names so it's safe for the shell, JSON and completion.
// Returns [] when absent. Throws on an illegal character.
function parseTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    for (const part of String(item).split(',')) {
      const s = part.trim();
      if (!s) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error(`invalid tag "${s}" (use letters, digits, . _ -)`);
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

// Parse a "[host:]port" forward endpoint (--local / --remote / socks). The port
// is required; host is '' when absent (caller supplies the default).
function parseAddr(value, label = 'address') {
  if (value === undefined || value === null || value === '') throw new Error(`missing ${label} ([host:]port)`);
  const { host, port } = splitHostPort(String(value));
  if (port === null) throw new Error(`invalid ${label} "${value}" (want [host:]port)`);
  if (!isValidPort(port)) throw new Error(`invalid port "${port}" in "${value}" (expected an integer 1–65535)`);
  return { host, port };
}

// Single rule for "is this a usable TCP port": an integer in 1..65535.
function isValidPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function requirePort(v, spec) {
  const n = Number(v);
  if (!isValidPort(n)) {
    throw new Error(`invalid port "${v}" in "${spec}"`);
  }
  return n;
}

// Validate a tunnel definition, returning a normalized copy. Throws on error.
function validateTunnel(t) {
  if (!t || typeof t !== 'object') throw new Error('tunnel must be an object');
  if (!t.name || !/^[A-Za-z0-9._-]+$/.test(t.name)) {
    throw new Error(`invalid tunnel name "${t.name}" (use letters, digits, . _ -)`);
  }
  if (!t.host || typeof t.host !== 'string') {
    throw new Error(`tunnel "${t.name}" missing host (user@host)`);
  }
  const forwards = Array.isArray(t.forwards) ? t.forwards : [];
  if (forwards.length === 0) {
    throw new Error(`tunnel "${t.name}" has no forwards (-L/-R/-D)`);
  }
  const normForwards = forwards.map((f) => {
    if (f.type === 'dynamic') {
      return { type: 'dynamic', bind: f.bind || '127.0.0.1', srcPort: requirePort(f.srcPort, t.name) };
    }
    return {
      type: f.type,
      bind: f.bind || '127.0.0.1',
      srcPort: requirePort(f.srcPort, t.name),
      destHost: f.destHost,
      destPort: requirePort(f.destPort, t.name),
    };
  });
  return {
    name: t.name,
    host: t.host,
    port: t.port ? requirePort(t.port, t.name) : 22,
    identityFile: t.identityFile || null,
    jump: parseJump(t.jump),
    tags: parseTags(t.tags),
    forwards: normForwards,
    sshOptions: Array.isArray(t.sshOptions) ? t.sshOptions.slice() : [],
    enabled: t.enabled !== false,
    autoSetupKey: t.autoSetupKey !== false,
  };
}

// Normalize + validate settings.alerts in place. A missing block is filled with
// defaults; a present one must use an http(s) url (or null) and known event names.
function validateAlerts(settings) {
  if (!settings.alerts || typeof settings.alerts !== 'object') {
    settings.alerts = cloneSettings(DEFAULT_SETTINGS.alerts);
    return;
  }
  const w = settings.alerts.webhook && typeof settings.alerts.webhook === 'object'
    ? settings.alerts.webhook : (settings.alerts.webhook = {});
  if (w.url === undefined || w.url === null || w.url === '') {
    w.url = null;
  } else if (typeof w.url !== 'string' || !/^https?:\/\//i.test(w.url)) {
    throw new Error(`invalid alerts.webhook.url "${w.url}" (must be an http(s) URL or null)`);
  }
  if (w.events === undefined) {
    w.events = [...DEFAULT_ALERT_EVENTS];
  } else if (!Array.isArray(w.events)) {
    throw new Error('alerts.webhook.events must be an array');
  } else {
    for (const e of w.events) {
      if (!ALERT_EVENTS.includes(e)) {
        throw new Error(`unknown alert event "${e}" (known: ${ALERT_EVENTS.join(', ')})`);
      }
    }
  }
  if (w.channel === undefined || w.channel === null) {
    w.channel = 'generic';
  } else if (!KNOWN_CHANNELS.includes(w.channel)) {
    throw new Error(`unknown alerts.webhook.channel "${w.channel}" (known: ${KNOWN_CHANNELS.join(', ')})`);
  }
  if (w.enabled === undefined) {
    w.enabled = false;
  } else if (typeof w.enabled !== 'boolean') {
    throw new Error('alerts.webhook.enabled must be a boolean');
  }
}

function validateConfig(c) {
  const out = defaultConfig();
  if (c && c.settings) {
    out.settings = deepMerge(out.settings, c.settings);
  }
  validateAlerts(out.settings);
  const tunnels = (c && Array.isArray(c.tunnels)) ? c.tunnels : [];
  const seen = new Set();
  out.tunnels = tunnels.map((t) => {
    const v = validateTunnel(t);
    if (seen.has(v.name)) throw new Error(`duplicate tunnel name "${v.name}"`);
    seen.add(v.name);
    return v;
  });
  return out;
}

function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

function load(file = paths.configFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultConfig();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${err.message}`);
  }
  return validateConfig(parsed);
}

function save(config, file = paths.configFile()) {
  const valid = validateConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return valid;
}

function findTunnel(config, name) {
  return config.tunnels.find((t) => t.name === name) || null;
}

function upsertTunnel(config, tunnel) {
  const v = validateTunnel(tunnel);
  const idx = config.tunnels.findIndex((t) => t.name === v.name);
  if (idx >= 0) config.tunnels[idx] = v;
  else config.tunnels.push(v);
  return v;
}

function removeTunnel(config, name) {
  const idx = config.tunnels.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  config.tunnels.splice(idx, 1);
  return true;
}

module.exports = {
  DEFAULT_SETTINGS,
  ALERT_EVENTS,
  ALERT_GROUPS,
  DEFAULT_ALERT_EVENTS,
  expandEvents,
  defaultConfig,
  isValidPort,
  splitHostPort,
  parseTarget,
  parseJump,
  parseTags,
  parseAddr,
  validateTunnel,
  validateConfig,
  load,
  save,
  findTunnel,
  upsertTunnel,
  removeTunnel,
};
