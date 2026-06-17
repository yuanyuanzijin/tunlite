#!/usr/bin/env node
'use strict';

// Demo-only `ssh` stand-in used ONLY to record the monitor GIF/screenshots
// (docs/monitor.tape). It is NOT used by the test suite — tests use fake-ssh.js.
//
// Unlike fake-ssh.js (one global behavior via env), this varies by destination
// host, so a SINGLE daemon can show a realistic mix of states at once:
//   host contains 'flap'   -> exits 255 quickly  -> daemon shows `retrying`, restarts climb
//   host contains 'noauth' -> publickey denial    -> daemon shows `needs-auth`
//   otherwise              -> stays up until killed -> `connected`

const argv = process.argv.slice(2);
const isTunnel = argv.includes('-N');
const dest = argv.find((a) => a.includes('@')) || argv[argv.length - 1] || '';

if (!isTunnel) {
  // auth probe (`ssh ... <host> true`): deny only for a 'noauth' host.
  process.exit(/noauth/.test(dest) ? 255 : 0);
}

if (/noauth/.test(dest)) { process.stderr.write('Permission denied (publickey).\n'); process.exit(255); }
if (/flap/.test(dest)) { setTimeout(() => process.exit(255), 120); return; }

// healthy tunnel: run until killed
const timer = setInterval(() => {}, 1 << 30);
const stop = () => { clearInterval(timer); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
