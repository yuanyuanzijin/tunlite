'use strict';

// Compact, unit-carrying duration for human output: 45s · 1m30s · 3m · 2h47m · 1d2h · 2d.
// Shows at most the two largest non-zero units; carries s->m->h->d.
function formatDuration(ms) {
  let s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60); s %= 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  let h = Math.floor(m / 60); m %= 60;
  if (h < 24) return m ? `${h}h${m}m` : `${h}h`;
  const d = Math.floor(h / 24); h %= 24;
  return h ? `${d}d${h}h` : `${d}d`;
}

// Local wall-clock HH:MM:SS for a ms timestamp — shorter than ISO for log rows.
function clockTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Pad/truncate plain text to exactly `w` columns (shared by status & monitor).
function fit(s, w) {
  s = String(s == null ? '' : s);
  if (w <= 0) return '';
  if (s.length <= w) return s + ' '.repeat(w - s.length);
  if (w === 1) return '…';
  return s.slice(0, w - 1) + '…';
}

// ssh target host, with :port appended only when the connect port isn't 22.
function hostWithPort(t) {
  const p = t.port;
  return (p && Number(p) !== 22) ? `${t.host}:${p}` : t.host;
}

// A forward's accurate kind and its endpoints (no type word).
function forwardType(f) { return f.type; }
function forwardRoute(f) {
  if (f.type === 'dynamic') return `${f.bind}:${f.srcPort}`;
  return `${f.bind}:${f.srcPort} → ${f.destHost}:${f.destPort}`;
}
function forwardTypes(t) {
  const seen = [];
  for (const f of t.forwards || []) if (!seen.includes(f.type)) seen.push(f.type);
  return seen.join(',') || '—';
}
function forwardRoutes(t) {
  return (t.forwards || []).map(forwardRoute).join(', ') || '—';
}

// Shell-quote a value only when it would otherwise be reinterpreted by the shell.
// The unquoted set is deliberately broad (paths, user@host, key=value ssh-opts,
// a leading ~) so the common add command stays clean and copy-pasteable; spaces,
// quotes, globs, etc. force single-quoting.
function shellQuote(s) {
  s = String(s);
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Render a [host:]port endpoint, dropping a default host so the reconstructed
// command matches what a user would naturally type.
function addr(host, port, dflt) {
  return host && host !== dflt ? `${host}:${port}` : `${port}`;
}

// Reconstruct the `tunlite add <local|remote|dynamic>` command that recreates
// this tunnel, so the monitor detail page can show a copy-pasteable definition.
// Default-valued parts (SSH port 22, bind 127.0.0.1, target localhost, listen
// port == target port, socks 1080, enabled, auto key on) are omitted to keep the
// line short. Built from the first forward (a tunnel defines exactly one).
function buildAddCommand(t) {
  const f = (t.forwards || [])[0];
  const target = (t.port && Number(t.port) !== 22) ? `${t.host}:${t.port}` : t.host;
  const head = ['tunlite add'];
  const tail = [];
  if (t.identityFile) tail.push('-i', shellQuote(t.identityFile));
  for (const o of t.sshOptions || []) tail.push('--ssh-opt', shellQuote(o));
  if (t.enabled === false) tail.push('--disabled');
  if (t.autoSetupKey === false) tail.push('--no-auto-key');

  let parts;
  if (!f) {
    parts = [...head, shellQuote(t.name), '--to', shellQuote(target)];
  } else if (f.type === 'dynamic') {
    parts = [...head, 'dynamic', shellQuote(t.name), '--to', shellQuote(target)];
    if (!(f.bind === '127.0.0.1' && f.srcPort === 1080)) parts.push('--local', addr(f.bind, f.srcPort, '127.0.0.1'));
  } else if (f.type === 'remote') {
    parts = [...head, 'remote', shellQuote(t.name), '--to', shellQuote(target), '--local', addr(f.destHost, f.destPort, 'localhost')];
    if (!(f.bind === '127.0.0.1' && f.srcPort === f.destPort)) parts.push('--remote', addr(f.bind, f.srcPort, '127.0.0.1'));
  } else {
    parts = [...head, 'local', shellQuote(t.name), '--to', shellQuote(target), '--remote', addr(f.destHost, f.destPort, 'localhost')];
    if (!(f.bind === '127.0.0.1' && f.srcPort === f.destPort)) parts.push('--local', addr(f.bind, f.srcPort, '127.0.0.1'));
  }
  return [...parts, ...tail].join(' ');
}

// ---- state styling (shared by `status` and `monitor`) ------------------
// ANSI SGR codes. colorize() is a no-op when `on` is false or the color is
// unknown, so callers gate on TTY / NO_COLOR without branching.
const SGR = { green: '32', yellow: '33', red: '31', dim: '2', reverse: '7' };
function colorize(text, color, on) {
  return on && SGR[color] ? `\x1b[${SGR[color]}m${text}\x1b[0m` : text;
}

// state -> { glyph, color, label }. One source of truth for both commands.
const STATE_STYLE = {
  connected: { glyph: '●', color: 'green' },
  starting: { glyph: '◌', color: 'yellow' },
  retrying: { glyph: '◌', color: 'yellow' },
  'needs-auth': { glyph: '⚠', color: 'red' },
  failed: { glyph: '✕', color: 'red' },
};
function stateStyle(state) {
  const s = STATE_STYLE[state];
  return s
    ? { glyph: s.glyph, color: s.color, label: state }
    : { glyph: '○', color: 'dim', label: state }; // idle/stopped/disabled/daemon-stopped
}

// One ordered column spec shared by `status` (table) and `monitor` (list). Each
// cell() returns plain text (used for width math); STATE is colorized by the
// caller via stateStyle().
const TUNNEL_COLUMNS = [
  { key: 'name', header: 'NAME', cell: (t) => t.name },
  { key: 'state', header: 'STATE', cell: (t) => { const g = stateStyle(t.state); return `${g.glyph} ${g.label}`; } },
  { key: 'host', header: 'HOST', cell: hostWithPort },
  { key: 'type', header: 'TYPE', cell: forwardTypes },
  { key: 'route', header: 'ROUTE', cell: forwardRoutes },
  { key: 'pid', header: 'PID', cell: (t) => (t.pid ? String(t.pid) : '—') },
  { key: 'up', header: 'UP', cell: (t) => t.uptime || '—' },
  { key: 'restarts', header: 'RESTARTS', cell: (t) => String(t.restarts == null ? 0 : t.restarts) },
];

// Render tunnels as an aligned table (dim header + rows), 2-space gaps. Colors the
// STATE cell per row; a row with a lastError gets a dim "↳ <err>" sub-line. Caller
// adds the daemon/skill lines. Returns an array of lines.
function renderTunnelTable(tunnels, { color = false } = {}) {
  const caps = { name: 24, host: 40, route: 40 };
  const width = {};
  for (const c of TUNNEL_COLUMNS) {
    const cap = caps[c.key] || Infinity;
    const max = Math.max(c.header.length, ...tunnels.map((t) => Math.min(cap, c.cell(t).length)));
    width[c.key] = Math.min(cap, max);
  }
  const lines = [];
  lines.push(colorize(TUNNEL_COLUMNS.map((c) => fit(c.header, width[c.key])).join('  '), 'dim', color));
  for (const t of tunnels) {
    const cells = TUNNEL_COLUMNS.map((c) => {
      const text = fit(c.cell(t), width[c.key]);
      if (c.key === 'state') { const g = stateStyle(t.state); return colorize(text, g.color, color); }
      return text;
    });
    lines.push(cells.join('  '));
    if (t.lastError) lines.push(colorize(`  ↳ ${t.lastError}`, 'dim', color));
  }
  return lines;
}

// Side notes that disambiguate a forward's two ends (this is where -L/-R flip).
function forwardListenNote(type) {
  return type === 'remote' ? '(on server)' : (type === 'dynamic' ? '(local SOCKS)' : '(local)');
}
function forwardTargetNote(type) {
  return type === 'remote' ? '(on this machine)' : '(reachable from server)';
}

// [label, value, color|null] rows describing a tunnel in full — shared by
// `status <name>` and the monitor detail pane.
function tunnelDetailRows(t) {
  const g = stateStyle(t.state);
  const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const rows = [];
  rows.push(['state', `${g.glyph} ${g.label}`, g.color]);
  rows.push(['host', dash(t.host), null]);
  rows.push(['ssh', `port ${t.port || 22}`, null]);
  if (t.jump && t.jump.length) rows.push(['jump', t.jump.join(', '), null]);
  for (const f of t.forwards || []) {
    rows.push(['type', f.type, null]);
    rows.push(['listen', `${f.bind}:${f.srcPort} ${forwardListenNote(f.type)}`, null]);
    if (f.type !== 'dynamic') rows.push(['target', `${f.destHost}:${f.destPort} ${forwardTargetNote(f.type)}`, null]);
  }
  rows.push(['pid', dash(t.pid), null]);
  rows.push(['up', dash(t.uptime), null]);
  rows.push(['restarts', String(t.restarts == null ? 0 : t.restarts), null]);
  rows.push(['exit', dash(t.lastExitCode), null]);
  rows.push(['identity', dash(t.identityFile), null]);
  rows.push(['options', (t.sshOptions && t.sshOptions.length) ? t.sshOptions.join(' ') : '—', null]);
  rows.push(['autokey', t.autoSetupKey === false ? 'off' : 'on', null]);
  rows.push(['enabled', t.enabled === false ? 'no' : 'yes', null]);
  if (t.tags && t.tags.length) rows.push(['tags', t.tags.join(', '), null]);
  if (t.lastError) rows.push(['error', t.lastError, 'red']);
  return rows;
}

// Glyph + color for a doctor check status.
const CHECK_STYLE = {
  ok: { glyph: '✓', color: 'green' },
  warn: { glyph: '!', color: 'yellow' },
  fail: { glyph: '✗', color: 'red' },
  info: { glyph: '·', color: 'dim' },
  skip: { glyph: '·', color: 'dim' },
};
function checkStyle(status) { return CHECK_STYLE[status] || CHECK_STYLE.info; }

// Overall service health as a color, so the daemon line tells the whole story
// at a glance: red when down or anything is broken, yellow while connecting,
// else green.
function serviceHealth(running, tunnels = []) {
  if (!running) return 'red';
  const states = tunnels.map((t) => t.state);
  if (states.some((s) => s === 'failed' || s === 'needs-auth')) return 'red';
  if (states.some((s) => s === 'starting' || s === 'retrying')) return 'yellow';
  return 'green';
}

module.exports = {
  formatDuration, clockTime, buildAddCommand, stateStyle, serviceHealth,
  colorize, SGR, fit, hostWithPort, forwardType, forwardRoute, forwardTypes, forwardRoutes,
  TUNNEL_COLUMNS, renderTunnelTable, tunnelDetailRows, checkStyle,
};
