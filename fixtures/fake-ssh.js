#!/usr/bin/env node
'use strict';

// A controllable stand-in for the real `ssh` binary, used in tests.
//
// It distinguishes two call shapes:
//   * auth probe:  `ssh ... <host> true`  (no -N)  -> exit FAKE_SSH_PROBE (default 0)
//   * tunnel:      `ssh -N -T ... <host>`          -> behave per FAKE_SSH_MODE
//
// FAKE_SSH_MODE (tunnel behavior):
//   stay      -> run until killed (optionally open FAKE_SSH_LISTEN host:port)
//   quickfail -> exit 255 after ~50ms (transient network flap)
//   authfail  -> print publickey denial, exit 255
//   portbusy  -> print bind error, exit 255
//
// FAKE_SSH_LOG, if set, gets one line appended per invocation with argv.

const fs = require('fs');
const net = require('net');

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) {
  try { fs.appendFileSync(process.env.FAKE_SSH_LOG, argv.join(' ') + '\n'); } catch (_) {}
}

const isTunnel = argv.includes('-N');

if (!isTunnel) {
  // Auth probe.
  if (process.env.FAKE_SSH_PROBE_HANG) {
    // Tunnel-only / forced-command account: authentication succeeds but the
    // server refuses to run our command and never closes the session. Emit any
    // configured banner, then hang until killed. A safety net exits after 20s
    // so a child leaked by a hung (unfixed) caller can't live forever.
    if (process.env.FAKE_SSH_PROBE_STDERR) process.stderr.write(process.env.FAKE_SSH_PROBE_STDERR + '\n');
    setTimeout(() => process.exit(0), 20000);
    setInterval(() => {}, 1 << 30);
    return;
  }
  process.exit(Number(process.env.FAKE_SSH_PROBE || 0));
}

const mode = process.env.FAKE_SSH_MODE || 'stay';
switch (mode) {
  case 'authfail':
    process.stderr.write('Permission denied (publickey).\n');
    process.exit(255);
    break;
  case 'quickfail':
    setTimeout(() => process.exit(255), 50);
    break;
  case 'portbusy':
    process.stderr.write('bind: Address already in use\n');
    process.exit(255);
    break;
  case 'stay':
  default: {
    if (process.env.FAKE_SSH_STDERR) process.stderr.write(process.env.FAKE_SSH_STDERR + '\n');
    let server = null;
    const listen = process.env.FAKE_SSH_LISTEN;
    if (listen) {
      const [host, port] = listen.split(':');
      server = net.createServer(() => {});
      server.listen(Number(port), host);
    }
    const timer = setInterval(() => {}, 1 << 30);
    const shutdown = () => { clearInterval(timer); if (server) server.close(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    break;
  }
}
