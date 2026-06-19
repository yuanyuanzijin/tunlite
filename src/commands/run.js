'use strict';

// `run` — a daemon-less, foreground, supervised single tunnel built entirely
// from inline flags (never reads config). State is self-reported: human lines on
// stderr, or NDJSON on stdout with --json. Clean shutdown on SIGTERM/SIGINT.
//
// Exit contract:
//   0  clean shutdown (SIGTERM/SIGINT), or normal supervisor stop
//   2  usage: missing --to, no forward, or a bad target/jump/forward spec
//   1  ssh binary not found
//   With --exit-on-failure (otherwise the supervisor keeps retrying):
//     4  needs-auth
//     1  blocked / failed

const { EXIT, fail, parseFlags, collectForwards } = require('../cli-core');
const config = require('../config');
const ssh = require('../ssh');
const { Supervisor, STATE } = require('../supervisor');

// Backstop: force a clean exit if the supervisor never emits STOPPED after stop().
// Must exceed the supervisor's stop grace (STOP_GRACE_MS = 3000).
const SHUTDOWN_BACKSTOP_MS = 4000;

// `--json` is a global flag (stripped before dispatch, surfaced via opts.json),
// so it is NOT declared here; opts.json carries it. `--exit-on-failure` is a
// real per-command flag.
async function run(args, io, opts = {}) {
  let flags;
  try {
    ({ flags } = parseFlags(args, {
      value: ['--to', '-i', '--jump', '--name'],
      repeat: ['-L', '-R', '-D', '--ssh-opt'],
      bool: ['--exit-on-failure'],
    }));
  } catch (e) { fail(e.message); }

  if (!flags['--to']) {
    fail('usage: tunlite run --to user@host[:port] -L … | -R … | -D … [--name LABEL] [--json] [--exit-on-failure]');
  }

  let target, forwards, jump;
  try {
    target = config.parseTarget(flags['--to']);
    forwards = collectForwards(flags);
    jump = config.parseJump(flags['--jump']);
  } catch (e) { fail(e.message); }
  if (forwards.length === 0) { fail('run needs at least one forward (-L / -R / -D)'); }

  if (!ssh.commandExists(ssh.sshBinary())) { fail(`ssh not found (${ssh.sshBinary()})`, EXIT.ERROR); }

  const tunnel = {
    name: flags['--name'] || target.host,
    host: target.host,
    port: target.port || 22,
    identityFile: flags['-i'] || null,
    jump,
    forwards,
    sshOptions: flags['--ssh-opt'] || [],
  };
  const json = Boolean(opts.json);
  const exitOnFailure = Boolean(flags['--exit-on-failure']);

  const sup = new Supervisor(tunnel, {}, {});

  return new Promise((resolve) => {
    let done = false;
    // Foreground command: own SIGTERM/SIGINT for a clean stop -> exit 0. These
    // are registered only inside run() (never at module load) so they don't leak
    // into other commands; a `run` process is short-lived and terminal-driven.
    // Declared before finish() so finish() can detach it on cleanup.
    const onSignal = () => {
      sup.once('state', (s) => { if (s.state === STATE.STOPPED) finish(EXIT.OK); });
      sup.stop();
      // Backstop in case the ssh child wedges and never reaches STOPPED. unref so
      // it can never, on its own, hold the event loop open past a clean stop (the
      // bin entry drains the loop rather than calling process.exit).
      const t = setTimeout(() => finish(EXIT.OK), SHUTDOWN_BACKSTOP_MS);
      if (typeof t.unref === 'function') t.unref();
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      sup.stop();
      resolve(code);
    };

    let stoppedEmitted = false;
    sup.on('state', (s) => {
      // STOPPED is terminal for a run, but stop() can fire during shutdown from
      // both onSignal and finish() — emit the terminal line exactly once.
      if (s.state === STATE.STOPPED) {
        if (stoppedEmitted) return;
        stoppedEmitted = true;
      }
      if (json) {
        // One NDJSON line per state change: the tunnel's CHANGING state plus a
        // `ts` (epoch ms). Field names match `status --json` (sourced from the
        // same sup.status() snapshot); the static config fields it also carries
        // (host/port/forwards/…) are intentionally dropped — they never change
        // during a run and would just be per-line noise.
        const snap = sup.status();
        io.out.write(JSON.stringify({
          ts: Date.now(),
          name: snap.name,
          state: snap.state,
          pid: snap.pid,
          restarts: snap.restarts,
          uptimeMs: snap.uptimeMs,
          lastError: snap.lastError,
          lastExitCode: snap.lastExitCode,
        }) + '\n');
      } else {
        const extra = s.state === STATE.CONNECTED
          ? ` (pid ${sup.pid})`
          : (sup.lastError ? `: ${sup.lastError}` : '');
        io.err.write(`${s.state}${extra}\n`);
      }
      if (exitOnFailure) {
        // Defer the stop to the next tick: the supervisor sets its slow re-probe
        // timer (this._timer = setTimeout(…, NEEDS_AUTH_RETRY_MS)) AFTER emitting
        // the state, so stopping synchronously inside this handler would clear the
        // timers before that one exists, leaving it dangling and keeping the event
        // loop (and the process) alive for the full retry interval. Running on the
        // next tick lets _classifyAndReact finish arming the timer first, so
        // sup.stop()'s _clearTimers() actually cancels it.
        if (s.state === STATE.NEEDS_AUTH) return setImmediate(() => finish(EXIT.NEEDS_AUTH));
        if (s.state === STATE.BLOCKED || s.state === STATE.FAILED) return setImmediate(() => finish(EXIT.ERROR));
      }
    });
    sup.on('log', (l) => { if (!json) io.err.write(`${l}\n`); });

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    sup.start();
  });
}

module.exports = { run };
