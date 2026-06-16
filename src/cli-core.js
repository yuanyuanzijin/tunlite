'use strict';

// Shared CLI primitives: exit codes, IO helpers, the flag parser, and small
// interactive/daemon-down helpers. Imported by cli.js and every command module;
// it must NOT require ./cli (keeps the dependency one-directional, no cycles).

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOTFOUND: 3, NEEDS_AUTH: 4, DAEMON: 5 };

// ---- tiny flag parser ---------------------------------------------------
// valueFlags: flags that consume the next token. repeatFlags: collect into array.
function parseFlags(args, { value = [], repeat = [], bool = [] } = {}) {
  const valueSet = new Set([...value, ...repeat]);
  const repeatSet = new Set(repeat);
  const boolSet = new Set(bool);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') {
      let key = a;
      let val;
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq >= 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
      if (valueSet.has(key)) {
        if (val === undefined) { val = args[++i]; }
        if (repeatSet.has(key)) { (flags[key] ||= []).push(val); }
        else flags[key] = val;
      } else if (boolSet.has(key)) {
        flags[key] = true;
      } else {
        // A flag the command does not declare — a typo, not a silent `true`.
        throw Object.assign(new Error(`unknown option "${key}" for this command`), { exitCode: EXIT.USAGE });
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function jsonOut(io, obj) { io.out.write(JSON.stringify(obj, null, 2) + '\n'); }
function line(io, s = '') { io.out.write(s + '\n'); }
function errline(io, s) { io.err.write(s + '\n'); }

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Minimal y/N prompt on the controlling terminal.
// On a real terminal we hand the prompt straight to readline.question: in
// terminal mode readline refreshes the current line, which ERASES a prompt
// written separately beforehand — so it must own the text it renders. In
// non-TTY / captured-`io` contexts (tests) readline does not refresh, so we
// write the prompt through io.out where the caller can see it and pass readline
// an empty query. For the real CLI io.out IS process.stdout, so either way the
// prompt is printed exactly once.
function confirm(io, prompt) {
  return new Promise((resolve) => {
    const tty = Boolean(process.stdout.isTTY);
    if (!tty) io.out.write(prompt);
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(tty ? prompt : '', (ans) => { rl.close(); resolve(/^y(es)?$/i.test((ans || '').trim())); });
  });
}

// Consistent, actionable guidance when the daemon isn't reachable.
function printDaemonDown(io) {
  errline(io, 'the tunlite daemon is not running — tunnels are not active.');
  errline(io, '  start it now:        tunlite daemon start');
  errline(io, '  start it at login:   tunlite install service   (auto-starts and keeps it alive)');
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

module.exports = {
  EXIT, parseFlags, jsonOut, line, errline, isInteractive, sleep, confirm,
  printDaemonDown, pad,
};
