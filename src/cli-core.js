'use strict';

// Shared CLI primitives: exit codes, IO helpers, the flag parser, and small
// interactive/daemon-down helpers. Imported by cli.js and every command module;
// it must NOT require ./cli (keeps the dependency one-directional, no cycles).

const fs = require('fs');

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOTFOUND: 3, NEEDS_AUTH: 4, DAEMON: 5 };

// A user-facing CLI failure that carries its exit code. Thrown (not returned) so
// the one dispatcher catch renders every command's errors consistently: the
// message verbatim on stderr, or `{ error, code }` on stdout under --json.
class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
// Shorthand for `throw new CliError(...)`. Defaults to a usage error (exit 2).
function fail(message, exitCode = EXIT.USAGE) { throw new CliError(message, exitCode); }

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

function answeredYes(ans) { return /^y(es)?$/i.test((ans || '').trim()); }

// Can we run an interactive prompt right now? True when stdin+stdout are a
// terminal (a direct CLI run), OR when stdout is a terminal and a controlling
// tty exists even though stdin is piped — e.g. `curl … | sh`, where stdin
// carries the install script, not the user's keystrokes. (No /dev/tty on
// Windows, so the piped case can't prompt there.)
function canPrompt() {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  if (process.stdout.isTTY && process.platform !== 'win32') {
    try { fs.closeSync(fs.openSync('/dev/tty', 'r')); return true; } catch (_) { /* no tty */ }
  }
  return false;
}

// y/N prompt. WHERE the answer is read mirrors canPrompt()'s reasoning:
//   1. stdin is a tty            → readline owns stdin/stdout and renders the prompt.
//   2. stdin piped, stdout a tty → read the answer from /dev/tty, so we neither
//      consume the piped script (`curl | sh`) nor leave the prompt invisible.
//   3. otherwise (tests / no tty) → write the prompt through io.out (where a
//      captured-io caller can see it) and read whatever is on stdin.
// readline must OWN the text it prints (terminal-mode line refresh erases a
// separately-written prompt), so cases 1–2 pass the prompt to rl.question.
function confirm(io, prompt) {
  return new Promise((resolve) => {
    const readline = require('readline');
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (ans) => { rl.close(); resolve(answeredYes(ans)); });
      return;
    }
    if (process.stdout.isTTY && process.platform !== 'win32') {
      try {
        const fd = fs.openSync('/dev/tty', 'r');
        const input = fs.createReadStream(null, { fd, autoClose: true });
        const rl = readline.createInterface({ input, output: process.stdout });
        rl.question(prompt, (ans) => { rl.close(); try { input.destroy(); } catch (_) {} resolve(answeredYes(ans)); });
        return;
      } catch (_) { /* no controlling terminal — fall through */ }
    }
    io.out.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', (ans) => { rl.close(); resolve(answeredYes(ans)); });
  });
}

// Consistent, actionable guidance when the daemon isn't reachable.
function printDaemonDown(io) {
  errline(io, 'the tunlite daemon is not running — tunnels are not active.');
  errline(io, '  start it now:        tunlite daemon start');
  errline(io, '  start it at login:   tunlite install service   (auto-starts and keeps it alive)');
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// Levenshtein edit distance (iterative, single row) — small inputs (command names).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1]
        ? prevDiag
        : 1 + Math.min(prevDiag, prev[j], prev[j - 1]);
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}

// "Did you mean" for a mistyped command/subcommand. `aliases` maps known
// wrong-word inputs to the right verb (e.g. up -> enable); those win outright.
// Otherwise pick the closest candidate by edit distance, but only suggest when
// it's close enough to be a plausible typo (<= 2 edits, and fewer than the input
// length so 2-char inputs need an exact-ish match). Returns the suggestion or null.
function suggest(input, candidates, aliases = {}) {
  if (Object.prototype.hasOwnProperty.call(aliases, input)) return aliases[input];
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return (bestD <= 2 && bestD < input.length) ? best : null;
}

// Format the "unknown <thing>" usage error with an optional "did you mean" and a
// trailing hint, and throw it as a usage (2) CliError. Centralizes the wording so
// every dispatcher (top-level + webhook/daemon/install subverbs) reads the same.
function failUnknown(thing, input, candidates, { aliases = {}, hint } = {}) {
  const guess = suggest(input, candidates, aliases);
  const dym = guess ? ` — did you mean \`${guess}\`?` : '';
  fail(`unknown ${thing}: ${input}${dym}${hint ? `\n${hint}` : ''}`);
}

// Build forwards[] from repeated -L/-R/-D flags (each value parsed by ssh.parseForward).
function collectForwards(flags) {
  const ssh = require('./ssh');
  const out = [];
  for (const flag of ['-L', '-R', '-D']) {
    for (const spec of flags[flag] || []) out.push(ssh.parseForward(flag, spec));
  }
  return out;
}

// Warn-only: print a stderr line for every endpoint `tunnel` shares with another
// tunnel already in `cfg`. Never changes the exit code (Layer A's lock enforces).
function warnEndpointConflicts(io, cfg, tunnel) {
  const ssh = require('./ssh');
  for (const c of ssh.endpointConflicts(cfg, tunnel)) {
    errline(io, `warning: forward endpoint ${c.key} is also used by tunnel "${c.otherName}" — only one can bind; they will conflict if both run`);
  }
}

module.exports = {
  EXIT, CliError, fail, parseFlags, jsonOut, line, errline, isInteractive, canPrompt, sleep, confirm,
  printDaemonDown, pad, warnEndpointConflicts, collectForwards, levenshtein, suggest, failUnknown,
};
