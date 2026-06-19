'use strict';

const LOG_TAIL = 200; // log lines fetched per tick while on the detail page

// ---- input: physical key -> token --------------------------------------
function normalizeKey(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl-c';
  if (key.name === 'up') return 'up';
  if (key.name === 'down') return 'down';
  if (key.name === 'left') return 'left';
  if (key.name === 'right') return 'right';
  if (key.name === 'escape') return 'escape';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  const ch = (str || '').toLowerCase();
  if (ch.length === 1 && 'skxryjnqh?'.includes(ch)) return ch;
  return null;
}

// ---- pure state machine: (ui, token, state) -> { ui, action } ----------
function selIndex(ui, tunnels) {
  if (!tunnels.length) return -1;
  const i = tunnels.findIndex((t) => t.name === ui.selectedName);
  return i >= 0 ? i : 0;
}

function reduce(ui, token, state) {
  const tunnels = state.tunnels || [];
  // A pending confirm captures input: only `y` confirms, anything else cancels.
  if (ui.confirm) {
    if (token === 'y') {
      return { ui: { ...ui, confirm: null }, action: { type: ui.confirm.type, name: ui.confirm.name } };
    }
    return { ui: { ...ui, confirm: null }, action: null };
  }
  const view = ui.view || 'list';
  const idx = selIndex(ui, tunnels);
  const cur = idx >= 0 ? tunnels[idx] : null;

  // View-specific navigation keys.
  if (view === 'detail') {
    switch (token) {
      case 'up': case 'k': return { ui: { ...ui, logScroll: (ui.logScroll || 0) + 1 }, action: null };
      case 'down': case 'j': return { ui: { ...ui, logScroll: Math.max(0, (ui.logScroll || 0) - 1) }, action: null };
      case 'escape': case 'left': return { ui: { ...ui, view: 'list' }, action: null };
    }
  } else {
    const move = (delta) => {
      if (idx < 0) return ui;
      const ni = Math.max(0, Math.min(tunnels.length - 1, idx + delta));
      return { ...ui, selectedName: tunnels[ni].name };
    };
    switch (token) {
      case 'up': case 'k': return { ui: move(-1), action: null };
      case 'down': case 'j': return { ui: move(1), action: null };
      case 'enter': case 'right': return cur ? { ui: { ...ui, view: 'detail', logScroll: 0 }, action: null } : { ui, action: null };
    }
  }

  // Keys shared by both views.
  switch (token) {
    case 's': return cur ? { ui, action: { type: 'start', name: cur.name } } : { ui, action: null };
    case 'x': return cur ? { ui: { ...ui, confirm: { type: 'stop', name: cur.name } }, action: null } : { ui, action: null };
    case 'r': return cur ? { ui: { ...ui, confirm: { type: 'restart', name: cur.name } }, action: null } : { ui, action: null };
    case '?': case 'h': return { ui: { ...ui, help: !ui.help }, action: null };
    case 'q': case 'ctrl-c': return { ui, action: { type: 'quit' } };
    default: return { ui, action: null };
  }
}

const { buildAddCommand, stateStyle, serviceHealth, colorize, clockTime, SGR, fit, TUNNEL_COLUMNS, tunnelDetailRows } = require('./format');

function countBuckets(tunnels) {
  const c = { connected: 0, starting: 0, problem: 0, idle: 0 };
  for (const t of tunnels) {
    if (t.state === 'connected') c.connected++;
    else if (t.state === 'starting' || t.state === 'retrying') c.starting++;
    else if (t.state === 'failed' || t.state === 'needs-auth') c.problem++;
    else c.idle++;
  }
  return c;
}

// Which slice of rows is visible, keeping the selection in view.
function viewport(count, selectedIdx, bodyRows) {
  if (bodyRows <= 0 || count <= bodyRows) return { start: 0, end: Math.max(0, Math.min(count, bodyRows)) };
  let start = Math.max(0, selectedIdx - Math.floor(bodyRows / 2));
  start = Math.min(start, count - bodyRows);
  return { start, end: start + bodyRows };
}

// ---- ANSI helpers ------------------------------------------------------
// Build a header line from [text, color] segments, padding/truncating to width
// by VISIBLE length so embedded color codes never throw off alignment.
function styledLine(segments, sep, width, color) {
  const plain = segments.map((s) => s[0]).join(sep);
  if (!color || plain.length >= width) return fit(plain, width);
  const painted = segments.map((s) => colorize(s[0], s[1], true)).join(sep);
  return painted + ' '.repeat(width - plain.length);
}

const HEADER_LINES = 8; // title, sep, daemon, counts, home, config, sep, column-header
const FOOTER_LINES = 2; // sep, footer

function colWidths(tunnels, width) {
  const name = Math.min(24, Math.max(4, ...tunnels.map((t) => t.name.length)));
  const state = 13, type = 8, pid = 7, up = 6, restarts = 8;
  // "> " marker (2) + 7 single-space gaps between the 8 cells + the fixed cells.
  const used = 2 + 7 + name + state + type + pid + up + restarts;
  const remaining = width - used;
  if (remaining < 12) return { name, state, host: 6, type, route: 6, pid, up, restarts };
  const maxHost = Math.max(4, ...tunnels.map((t) => (t.host || '').length + (t.port && Number(t.port) !== 22 ? String(t.port).length + 1 : 0)));
  let host = Math.min(maxHost, Math.max(6, Math.floor(remaining * 0.4)));
  let route = remaining - host;
  if (route < 6) { route = 6; host = Math.max(6, remaining - route); }
  return { name, state, host, type, route, pid, up, restarts };
}

function rowText(t, W, selected, color) {
  const marker = selected ? '>' : ' ';
  const cells = TUNNEL_COLUMNS.map((c) => {
    const text = fit(c.cell(t), W[c.key]);
    if (c.key === 'state') { const g = stateStyle(t.state); return colorize(text, g.color, color); }
    return text;
  });
  const row = `${marker} ` + cells.join(' ');
  return (color && selected) ? colorize(row, 'reverse', true) : row;
}

// ---- detail view -------------------------------------------------------
// "label     value" row. Pads the label cell to 10 cols. The value may carry one
// color; we only paint it when it fits (an ANSI string would break fit()'s width
// math otherwise). paint()'s per-line \x1b[K clears any unused tail.
function field(label, valuePlain, valueColor, width, color) {
  const head = fit(` ${label}`, 10);
  const plain = head + valuePlain;
  if (color && valueColor && SGR[valueColor] && plain.length <= width) {
    return head + colorize(valuePlain, valueColor, true);
  }
  return fit(plain, width);
}

// Wrap a shell command to `width` columns, breaking only at spaces and adding a
// trailing " \" on every line but the last, so a long command stays fully
// visible (never ellipsis-truncated) AND still pastes back as one command.
// Each returned line is indented by `indent` spaces.
function wrapCommand(cmd, width, indent) {
  const avail = Math.max(8, width - indent - 2); // -2 leaves room for the " \"
  const pad = ' '.repeat(indent);
  const rows = [];
  let line = '';
  for (const w of String(cmd).split(' ')) {
    if (line && line.length + 1 + w.length > avail) { rows.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) rows.push(line);
  return rows.map((l, i) => pad + l + (i < rows.length - 1 ? ' \\' : ''));
}

// A horizontal rule with a centered label: ───── recent logs ─────.
function dividerLabel(label, width) {
  const text = ` ${label} `;
  if (text.length >= width) return fit(label, width);
  const left = Math.floor((width - text.length) / 2);
  return '─'.repeat(left) + text + '─'.repeat(width - text.length - left);
}

// How many log rows fit below the (variable-height) info block.
function detailLogRows(state, ui, size) {
  const height = Math.max(8, size.rows || 24);
  const t = (state.tunnels || []).find((x) => x.name === ui.selectedName);
  const width = Math.max(24, size.columns || 80);
  const detailRows = t ? tunnelDetailRows(t).length : 1;
  const addRows = t ? wrapCommand(buildAddCommand(t), width, 3).length : 1;
  // info block: one line per detail row + an "add (copy):" label line + wrapped command.
  const infoRows = detailRows + 1 + addRows;
  const fixed = 1 + 1 + infoRows + 1 + 1 + 1; // header, sep, info, divider, footer sep, footer
  return Math.max(0, height - fixed);
}

// Bound logScroll to [0, max(0, L - visibleRows)] so it can't drift past the
// top of the buffer. No-op (same ref) unless we're on the detail page.
function clampScroll(ui, logs, size, state) {
  if ((ui.view || 'list') !== 'detail') return ui;
  const logRows = detailLogRows(state, ui, size);
  const L = logs ? logs.length : 0;
  const s = Math.min(Math.max(0, ui.logScroll || 0), Math.max(0, L - logRows));
  return s === (ui.logScroll || 0) ? ui : { ...ui, logScroll: s };
}

function detailLines(state, ui, size, opts) {
  const color = !!opts.color;
  const width = Math.max(24, size.columns || 80);
  const sep = '─'.repeat(width);
  const t = (state.tunnels || []).find((x) => x.name === ui.selectedName);
  if (!t) return [fit('tunnel unavailable — press esc', width)];
  const logRows = detailLogRows(state, ui, size);
  if (logRows < 1) return [fit('terminal too small', width)];

  const lines = [];
  const title = `tunlite ▸ ${t.name}`;
  const hints = 'esc back  q quit';
  const gap = Math.max(2, width - title.length - hints.length);
  lines.push(fit(title + ' '.repeat(gap) + hints, width));      // header
  lines.push(sep);                                              // sep

  for (const [label, value, vcolor] of tunnelDetailRows(t)) {
    lines.push(field(label, value, vcolor, width, color));
  }
  lines.push(fit(' add (copy):', width));                       // label; command wraps below
  for (const l of wrapCommand(buildAddCommand(t), width, 3)) lines.push(fit(l, width));

  lines.push(dividerLabel('recent logs', width));              // divider

  const logs = opts.logs || [];
  const L = logs.length;
  if (L === 0) {
    lines.push(fit('  (no logs)', width));
    for (let i = 1; i < logRows; i++) lines.push(fit('', width));
  } else {
    const scroll = Math.min(Math.max(0, ui.logScroll || 0), Math.max(0, L - logRows));
    const end = L - scroll;
    const start = Math.max(0, end - logRows);
    for (let i = start; i < end; i++) lines.push(fit(` ${clockTime(logs[i].ts)} ${logs[i].line}`, width));
    for (let i = end - start; i < logRows; i++) lines.push(fit('', width));
  }

  lines.push(sep);                                             // footer sep
  let footer;
  if (ui.confirm) footer = ` ${ui.confirm.type} "${ui.confirm.name}"? (y/N)`;
  else if (ui.flash && (opts.now == null || ui.flash.until > opts.now)) footer = ' ' + ui.flash.text;
  else footer = ' ↑↓ scroll logs   s start   x stop   r restart   esc back';
  lines.push(fit(footer, width));                             // footer
  return lines;
}

// ---- the renderer: plain (layout) or colored (paint) -------------------
function renderLines(state, ui, size, opts = {}) {
  const color = !!opts.color;
  const width = Math.max(24, size.columns || 80);
  const height = Math.max(8, size.rows || 24);
  const sep = '─'.repeat(width);
  const tunnels = state.tunnels || [];

  if (ui.help) {
    if ((ui.view || 'list') === 'detail') {
      return [
        fit('tunlite monitor — detail keys', width), sep,
        fit('  ↑/k up      ↓/j down   (scroll logs)', width),
        fit('  s start     x stop (y/N)   r restart (y/N)', width),
        fit('  esc back    ?/h help       q quit', width),
        sep, fit(' press ? to close', width),
      ];
    }
    return [
      fit('tunlite monitor — keys', width), sep,
      fit('  ↑/k up      ↓/j down    ↵ details', width),
      fit('  s start     x stop (y/N)   r restart (y/N)', width),
      fit('  ?/h help    q quit', width),
      sep, fit(' press ? to close', width),
    ];
  }
  if ((ui.view || 'list') === 'detail') return detailLines(state, ui, size, opts);

  const lines = [];
  const intervalS = opts.intervalMs ? (opts.intervalMs / 1000) : 1;
  const hints = `refresh ${intervalS}s   ↑↓ select  ? help  q quit`;
  const title = (opts.tagFilter && opts.tagFilter.length) ? `tunlite monitor · tag ${opts.tagFilter.join(',')}` : 'tunlite monitor';
  const gap = Math.max(2, width - title.length - hints.length);
  lines.push(fit(title + ' '.repeat(gap) + hints, width));     // 0 title
  lines.push(sep);                                             // 1 sep
  const running = !!(state.daemon && state.daemon.running);
  const health = serviceHealth(running, tunnels);            // 2 daemon (colored by overall health)
  const dPlain = running
    ? `● daemon  running   pid ${state.daemon.pid}   v${state.daemon.version}   up ${state.daemon.uptime || '0s'}`
    : '● daemon  not running — tunnels are not active (run `tunlite enable all`)';
  lines.push(colorize(fit(dPlain, width), health, color));
  const b = countBuckets(tunnels);                            // 3 counts (each bucket in its own color)
  const seg = (glyph, n, word, col) => [`${glyph} ${n} ${word}`, n > 0 ? col : 'dim'];
  lines.push(styledLine([
    [`tunnels ${tunnels.length} total`, 'dim'],
    seg('●', b.connected, 'connected', 'green'),
    seg('◌', b.starting, 'starting', 'yellow'),
    seg('✕', b.problem, 'problem', 'red'),
    seg('○', b.idle, 'idle', 'dim'),
  ], '   ', width, color));
  // env paths: a glance at which environment this is (dev sandbox vs system
  // default) and where config lives, so you never act on the wrong tunlite.
  const p = state.paths || {};
  const pathRow = (label, val) => colorize(fit(`${label.padEnd(7)}${val}`, width), 'dim', color);
  lines.push(pathRow('home', p.home || 'system default'));   // 4 env root (TUNLITE_HOME) or system default
  lines.push(pathRow('config', p.config || '—'));            // 5 config.json
  lines.push(sep);                                            // 6 sep
  const W = colWidths(tunnels.length ? tunnels : [{ name: 'x', host: 'x', forwards: [] }], width);
  const header = `  ` + TUNNEL_COLUMNS.map((c) => fit(c.header, W[c.key])).join(' ');
  lines.push(fit(header, width));                            // 7 column header

  const bodyRows = Math.max(0, height - HEADER_LINES - FOOTER_LINES);
  if (bodyRows < 1) return [fit('terminal too small', width)];
  if (tunnels.length === 0) {
    const empty = (opts.tagFilter && opts.tagFilter.length)
      ? `  no tunnels tagged ${opts.tagFilter.join(', ')}`
      : '  no tunnels — add one with `tunlite add <name> --to user@host -L ...`';
    lines.push(fit(empty, width));
    for (let i = 1; i < bodyRows; i++) lines.push(fit('', width));
  } else {
    const idx = Math.max(0, tunnels.findIndex((t) => t.name === ui.selectedName));
    const { start, end } = viewport(tunnels.length, idx, bodyRows);
    for (let i = start; i < end; i++) lines.push(rowText(tunnels[i], W, i === idx, color));
    for (let i = end - start; i < bodyRows; i++) lines.push(fit('', width));
  }

  lines.push(sep);                                           // footer sep
  let footer;
  if (ui.confirm) footer = ` ${ui.confirm.type} "${ui.confirm.name}"? (y/N)`;
  else if (ui.flash && (opts.now == null || ui.flash.until > opts.now)) footer = ' ' + ui.flash.text;
  else footer = ' s start   x stop   r restart   q quit';
  lines.push(fit(footer, width));                           // footer

  return lines;
}

function layout(state, ui, size) { return renderLines(state, ui, size, { color: false }); }

// Compose the full terminal frame as ONE write string (flicker-free).
function paint(state, ui, size, opts = {}) {
  const lines = renderLines(state, ui, size, { ...opts, color: opts.color !== false });
  return '\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J';
}

// Turn the prevLines frame into newLines with the minimal terminal write. With no
// prior frame or a changed row count, do a full repaint (home + all rows +
// clear-to-end), identical to paint(); otherwise rewrite ONLY the rows that
// actually differ, each absolutely positioned (\x1b[row;1H), so unchanged rows
// (header, separators, idle log lines) are never touched. This is what keeps a
// per-tick change like a ticking uptime from redrawing — and flickering — the
// whole screen.
function frameDelta(prevLines, newLines) {
  if (!prevLines || prevLines.length !== newLines.length) {
    return '\x1b[H' + newLines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J';
  }
  let buf = '';
  for (let i = 0; i < newLines.length; i++) {
    if (newLines[i] !== prevLines[i]) buf += `\x1b[${i + 1};1H` + newLines[i] + '\x1b[K';
  }
  return buf;
}

// ---- IO shell ----------------------------------------------------------
function runMonitor(io, deps, opts = {}) {
  const intervalMs = opts.intervalMs || 1000;
  const out = deps.output;
  const size = () => ({ columns: out.columns || 80, rows: out.rows || 24 });
  let state = { daemon: { running: false }, tunnels: [] };
  let ui = { view: 'list', selectedName: null, confirm: null, help: false, flash: null, logScroll: 0 };
  let logs = [];
  let prevLogLen = 0;
  let prevLines = null;
  let prevDims = null;
  let timer = null;
  let resolveFn = null;
  let done = false;
  let sig = null;

  // Render the next frame and emit only what changed since the last one. A new
  // size (or first paint) forces a full repaint; otherwise frameDelta rewrites
  // just the differing rows, so the screen doesn't flicker every tick.
  const repaint = () => {
    const sz = size();
    const dims = sz.columns + 'x' + sz.rows;
    const newLines = renderLines(state, ui, sz, { color: deps.color !== false, intervalMs, now: deps.now(), logs, tagFilter: opts.tagFilter });
    const delta = frameDelta(prevDims === dims ? prevLines : null, newLines);
    if (delta) out.write(delta);
    prevLines = newLines;
    prevDims = dims;
  };

  const refresh = async () => {
    state = await deps.fetchState();
    if (!ui.selectedName || !state.tunnels.some((t) => t.name === ui.selectedName)) {
      ui = { ...ui, selectedName: state.tunnels[0] ? state.tunnels[0].name : null };
      if ((ui.view || 'list') === 'detail') ui = { ...ui, view: 'list', logScroll: 0 }; // selected tunnel vanished
    }
    if (ui.flash && ui.flash.until <= deps.now()) ui = { ...ui, flash: null };
    if ((ui.view || 'list') === 'detail' && ui.selectedName && typeof deps.fetchLogs === 'function') {
      let next;
      try { next = await deps.fetchLogs(ui.selectedName, LOG_TAIL); }
      catch (_) { next = logs; }                       // keep last tail on error
      if (!Array.isArray(next)) next = [];
      // Anchor while paused: bump scroll by the lines added this tick so the
      // viewport doesn't jump. Estimated from the length delta — blind once the
      // daemon ring buffer saturates (length stops growing), where a fast-logging
      // tunnel can still drift the view up by the evicted count.
      const added = Math.max(0, next.length - prevLogLen);
      if ((ui.logScroll || 0) > 0 && added > 0) ui = { ...ui, logScroll: (ui.logScroll || 0) + added };
      logs = next;
      prevLogLen = next.length;
    } else {
      // Not on the detail page: drop any held logs. The list renderer ignores
      // opts.logs, so the brief stale window right after Esc is invisible.
      logs = [];
      prevLogLen = 0;
    }
    ui = clampScroll(ui, logs, size(), state);
    repaint();
  };

  const cleanup = () => {
    if (timer) { deps.cancel(timer); timer = null; }
    deps.input.removeListener('keypress', onKey);
    if (deps.offResize) deps.offResize(onResize);
    if (sig) { process.removeListener('SIGINT', sig); process.removeListener('SIGTERM', sig); sig = null; }
    try { deps.setRawMode(false); } catch (_) {}
    // Raw mode resumes stdin and refs its TTY handle; setRawMode(false) does NOT
    // release it. Without releasing it, the live stdin handle keeps the event
    // loop alive and `tunlite monitor` hangs after quitting. Pause (+ unref) it so
    // the process can actually exit.
    if (deps.input) {
      if (typeof deps.input.pause === 'function') deps.input.pause();
      if (typeof deps.input.unref === 'function') deps.input.unref();
    }
    out.write('\x1b[?25h\x1b[?1049l'); // show cursor, leave alternate screen
  };

  const finish = (code) => { if (done) return; done = true; resolveFn(code); };

  // Quit for good: restore the terminal, resolve the promise, then exit the
  // process SYNCHRONOUSLY via deps.exit when provided. On Windows the caller's
  // `await runMonitor(...); process.exit()` path can stall for several seconds —
  // once raw mode is torn down the event loop doesn't drain the await
  // continuation promptly, so `q` appears to hang. Exiting here, in the same
  // tick as the keypress, sidesteps that. Tests omit deps.exit, so they simply
  // observe the resolved promise.
  const quit = (code) => {
    if (done) return;
    cleanup();
    finish(code);
    if (typeof deps.exit === 'function') deps.exit(code);
  };

  async function onKey(str, key) {
    const token = normalizeKey(str, key);
    if (!token) return;
    const prevView = ui.view || 'list';
    const res = reduce(ui, token, state);
    ui = res.ui;
    const action = res.action;
    if (action && action.type === 'quit') { return quit(0); }
    if (action) {
      if (!state.daemon || !state.daemon.running) {
        ui = { ...ui, flash: { text: 'daemon not running', until: deps.now() + 1500 } };
        repaint();
        return;
      }
      ui = { ...ui, flash: { text: `${action.type} ${action.name}…`, until: deps.now() + 1500 } };
      repaint();
      try { await deps[action.type](action.name); }
      catch (e) { ui = { ...ui, flash: { text: `error: ${e.message}`, until: deps.now() + 2500 } }; }
      await refresh(); // immediate refresh so the new state shows without waiting a tick
      return;
    }
    if (prevView !== 'detail' && (ui.view || 'list') === 'detail') {
      logs = []; prevLogLen = 0;  // fresh page
      await refresh();            // pull this tunnel's logs now, don't wait a tick
      return;
    }
    ui = clampScroll(ui, logs, size(), state);
    repaint();
  }

  // Repaint only; logScroll's upper bound is re-clamped inside the renderer
  // (detailLines), so a resize can't leave the log window out of range.
  const onResize = () => repaint();

  return new Promise((resolve) => {
    resolveFn = resolve;
    deps.setRawMode(true);
    out.write('\x1b[?1049h\x1b[?25l'); // enter alternate screen, hide cursor
    deps.input.on('keypress', onKey);
    if (deps.onResize) deps.onResize(onResize);
    if (deps.installSignals !== false) {
      sig = () => { quit(0); };
      process.on('SIGINT', sig);
      process.on('SIGTERM', sig);
    }
    // Resilient startup: a failing FIRST fetch must still paint + keep ticking
    // (and leave the terminal restorable) — never wedge before the ticker exists.
    const startTicker = () => { timer = deps.schedule(() => { refresh().catch(() => {}); }, intervalMs); };
    refresh().catch(() => repaint()).finally(startTicker);
  });
}

module.exports = { normalizeKey, reduce, countBuckets, viewport, layout, renderLines, paint, runMonitor, detailLogRows, clampScroll, frameDelta };
