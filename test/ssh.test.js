'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ssh = require('../src/ssh');

const FAKE_SSH = path.join(__dirname, '..', 'fixtures', 'fake-ssh.js');

const settings = { keepalive: { intervalSec: 15, countMax: 3 }, connectTimeoutSec: 10 };

test('buildArgs for a local forward, batch mode', () => {
  const t = {
    host: 'me@example.com', port: 22,
    forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'localhost', destPort: 80 }],
    sshOptions: [],
  };
  const args = ssh.buildArgs(t, settings);
  assert.ok(args.includes('-N') && args.includes('-T'));
  assert.ok(args.join(' ').includes('BatchMode=yes'));
  assert.ok(args.join(' ').includes('ServerAliveInterval=15'));
  assert.ok(args.join(' ').includes('ExitOnForwardFailure=yes'));
  const li = args.indexOf('-L');
  assert.equal(args[li + 1], '127.0.0.1:8080:localhost:80');
  assert.equal(args[args.length - 1], 'me@example.com');
  // `--` terminates option parsing immediately before the destination host so a
  // host beginning with `-` can never be read by ssh as an option.
  assert.equal(args[args.length - 2], '--');
});

test('buildArgs places `--` right before the host (argv-injection guard)', () => {
  const t = {
    host: 'me@example.com', port: 22,
    forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }],
    sshOptions: ['-o', 'Compression=yes'],
  };
  const args = ssh.buildArgs(t, settings);
  const dd = args.indexOf('--');
  assert.ok(dd >= 0, 'expected `--` in argv');
  assert.equal(args[dd + 1], 'me@example.com', '`--` must sit immediately before the host');
  assert.equal(dd, args.length - 2, 'host is the final token, `--` the one before it');
});

test('buildArgs honors port, identity, remote and dynamic forwards', () => {
  const t = {
    host: 'me@host', port: 2222, identityFile: '/keys/id',
    forwards: [
      { type: 'remote', bind: '127.0.0.1', srcPort: 9000, destHost: 'localhost', destPort: 3000 },
      { type: 'dynamic', bind: '0.0.0.0', srcPort: 1080 },
    ],
    sshOptions: ['-o', 'Compression=yes'],
  };
  const args = ssh.buildArgs(t, settings);
  const s = args.join(' ');
  assert.ok(s.includes('-p 2222'));
  assert.ok(s.includes('-i /keys/id'));
  assert.ok(s.includes('IdentitiesOnly=yes'));
  assert.ok(s.includes('-R 127.0.0.1:9000:localhost:3000'));
  assert.ok(s.includes('-D 0.0.0.0:1080'));
  assert.ok(s.includes('Compression=yes'));
});

test('buildArgs without batch omits BatchMode', () => {
  const t = { host: 'h', port: 22, forwards: [{ type: 'dynamic', srcPort: 1080 }], sshOptions: [] };
  const args = ssh.buildArgs(t, settings, { batch: false });
  assert.ok(!args.join(' ').includes('BatchMode'));
});

test('listeningPorts returns only local and dynamic', () => {
  const t = {
    forwards: [
      { type: 'local', bind: '127.0.0.1', srcPort: 8080 },
      { type: 'remote', bind: '127.0.0.1', srcPort: 9000 },
      { type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 },
    ],
  };
  assert.deepEqual(ssh.listeningPorts(t), [
    { host: '127.0.0.1', port: 8080 },
    { host: '127.0.0.1', port: 1080 },
  ]);
});

test('forwardEndpoints keys local/dynamic by bind:port and remote by host:bind:port', () => {
  const t = {
    host: 'me@host',
    forwards: [
      { type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'ex', destPort: 80 },
      { type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 },
      { type: 'remote', bind: '127.0.0.1', srcPort: 9000, destHost: 'localhost', destPort: 3000 },
    ],
  };
  assert.deepEqual(ssh.forwardEndpoints(t), [
    'L:127.0.0.1:8080',
    'L:127.0.0.1:1080',
    'R:me@host:127.0.0.1:9000',
  ]);
});

test('forwardEndpoints defaults an omitted bind to 127.0.0.1', () => {
  const t = { host: 'h', forwards: [{ type: 'local', srcPort: 22, destHost: 'x', destPort: 22 }] };
  assert.deepEqual(ssh.forwardEndpoints(t), ['L:127.0.0.1:22']);
});

test('endpointConflicts finds shared endpoints with other tunnels, skipping self', () => {
  const cfg = { tunnels: [
    { name: 'web', host: 'h1', forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'x', destPort: 80 }] },
    { name: 'api', host: 'h2', forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }] },
  ] };
  const dup = { name: 'web2', host: 'h3', forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'y', destPort: 90 }] };
  assert.deepEqual(ssh.endpointConflicts(cfg, dup), [{ key: 'L:127.0.0.1:8080', otherName: 'web' }]);

  const free = { name: 'web3', host: 'h3', forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 7070, destHost: 'y', destPort: 90 }] };
  assert.deepEqual(ssh.endpointConflicts(cfg, free), []);

  assert.deepEqual(ssh.endpointConflicts(cfg, cfg.tunnels[0]), []);
});

test('probeAuth resolves ok on exit 0 (already passwordless)', async () => {
  process.env.FAKE_SSH_PROBE = '0';
  const r = await ssh.probeAuth('me@host', { sshBinary: FAKE_SSH });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
});

test('probeAuth resolves not-ok on auth failure (needs setup-key)', async () => {
  process.env.FAKE_SSH_PROBE = '255';
  const r = await ssh.probeAuth('me@host', { sshBinary: FAKE_SSH });
  assert.equal(r.ok, false);
  assert.equal(r.code, 255);
  delete process.env.FAKE_SSH_PROBE;
});

// A tunnel-only / forced-command account (e.g. root@example.com for a reverse
// tunnel) authenticates fine but refuses to run our probe command and never
// closes the session. probeAuth must detect the auth-success line and return
// FAST (well under a second) — not wait out a timeout — reporting passwordless
// OK (restricted).
test('probeAuth returns fast on a post-auth stall, flagged restricted', { timeout: 8000 }, async () => {
  process.env.FAKE_SSH_PROBE_HANG = '1';
  process.env.FAKE_SSH_PROBE_STDERR =
    'Authenticated to fake ([127.0.0.1]:22) using "publickey".\nOnly SSH tunnel allowed';
  const t0 = Date.now();
  const r = await ssh.probeAuth('root@tunnelonly', { sshBinary: FAKE_SSH });
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `expected a fast resolve, took ${dt}ms`);
  assert.equal(r.ok, true); // we authenticated; the host just won't run a command
  assert.equal(r.restricted, true);
  assert.notEqual(r.timedOut, true); // resolved by the auth signal, not the timeout
  delete process.env.FAKE_SSH_PROBE_HANG;
  delete process.env.FAKE_SSH_PROBE_STDERR;
});

// An auth denial must stay not-ok and also return fast.
test('probeAuth returns fast and not-ok on an auth denial', { timeout: 8000 }, async () => {
  process.env.FAKE_SSH_PROBE_HANG = '1';
  process.env.FAKE_SSH_PROBE_STDERR = 'Permission denied (publickey).';
  const t0 = Date.now();
  const r = await ssh.probeAuth('root@nope', { sshBinary: FAKE_SSH });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.ok, false);
  delete process.env.FAKE_SSH_PROBE_HANG;
  delete process.env.FAKE_SSH_PROBE_STDERR;
});

// Safety net: a host that connects but emits NO recognizable signal and hangs
// must still not block forever — the hard budget fires and, lacking any
// auth-failure signature, we report ok (restricted) rather than hang.
test('probeAuth falls back to the hard timeout when no signal appears', { timeout: 8000 }, async () => {
  process.env.FAKE_SSH_PROBE_HANG = '1';
  delete process.env.FAKE_SSH_PROBE_STDERR;
  const r = await ssh.probeAuth('root@silent', { sshBinary: FAKE_SSH, hardTimeoutSec: 1 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, true);
  assert.equal(r.restricted, true);
  delete process.env.FAKE_SSH_PROBE_HANG;
});

test('buildArgs adds -J for ProxyJump hops', () => {
  const t = {
    host: 'me@target', port: 22,
    forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }],
    jump: ['bastion', 'b2@gw:2222'], sshOptions: [],
  };
  const args = ssh.buildArgs(t, settings);
  const j = args.indexOf('-J');
  assert.ok(j >= 0, 'expected -J in argv');
  assert.equal(args[j + 1], 'bastion,b2@gw:2222');
});

test('buildArgs omits -J when there is no jump', () => {
  const t = { host: 'h', port: 22, forwards: [{ type: 'dynamic', srcPort: 1080 }], sshOptions: [] };
  assert.ok(!ssh.buildArgs(t, settings).includes('-J'));
});

test('probeAuth threads -J jump and sshOptions into the ssh argv', async () => {
  const fs = require('fs');
  const os = require('os');
  const log = path.join(os.tmpdir(), `tunlite-probe-${process.pid}-${Date.now()}.log`);
  process.env.FAKE_SSH_PROBE = '0';
  process.env.FAKE_SSH_LOG = log;
  try {
    await ssh.probeAuth('me@target', { sshBinary: FAKE_SSH, jump: ['bastion'], sshOptions: ['-o', 'Compression=yes'] });
    const logged = fs.readFileSync(log, 'utf8');
    assert.ok(logged.includes('-J bastion'), `expected -J bastion in: ${logged}`);
    assert.ok(logged.includes('Compression=yes'), `expected sshOptions in: ${logged}`);
  } finally {
    delete process.env.FAKE_SSH_PROBE;
    delete process.env.FAKE_SSH_LOG;
    try { fs.unlinkSync(log); } catch (_) { /* ignore */ }
  }
});

// --- setup-key rejects a shell-injecting public key before spawning ----------
// A `.pub` comment carrying a single quote / newline must NOT be interpolated
// into the remote command; setupKey validates pubContent first and throws, so
// no ssh process is ever spawned against the target.
function withKeyPair(pubContent) {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-setupkey-'));
  const priv = path.join(dir, 'id_test');
  fs.writeFileSync(priv, 'PRIVATE', { mode: 0o600 }); // exists -> ensureKeypair won't generate
  fs.writeFileSync(`${priv}.pub`, pubContent, { mode: 0o644 });
  return { priv, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

for (const [label, bad] of [
  ['single quote in comment', "ssh-ed25519 AAAA evil' ; rm -rf ~ ; '"],
  ['embedded newline', 'ssh-ed25519 AAAA host\necho pwned'],
]) {
  test(`setupKey rejects a public key with a ${label} (no spawn)`, () => {
    const cp = require('child_process');
    const kp = withKeyPair(bad);
    const orig = cp.spawnSync;
    let spawned = 0;
    cp.spawnSync = (...a) => { spawned++; return orig(...a); };
    try {
      assert.throws(
        () => ssh.setupKey('me@host', { identityFile: kp.priv, noSshCopyId: true, sshBinary: FAKE_SSH }),
        /single line with no single-quote|single line|single-quote/,
      );
      assert.equal(spawned, 0, 'no remote command should be spawned for an injecting key');
    } finally {
      cp.spawnSync = orig;
      kp.cleanup();
    }
  });
}

test('setupKey accepts a normal public key (spawns the fallback ssh)', () => {
  const cp = require('child_process');
  const kp = withKeyPair('ssh-ed25519 AAAAClean tunlite@host');
  const orig = cp.spawnSync;
  let spawned = 0;
  cp.spawnSync = (...a) => { spawned++; return orig(...a); };
  try {
    // FAKE_SSH exits 0; noSshCopyId forces the portable fallback path.
    const r = ssh.setupKey('me@host', { identityFile: kp.priv, noSshCopyId: true, sshBinary: FAKE_SSH });
    assert.equal(r.method, 'append');
    assert.ok(spawned >= 1, 'a clean key should reach the spawn');
  } finally {
    cp.spawnSync = orig;
    kp.cleanup();
  }
});

test('parseForward -L/-R/-D round-trip with forwardArgs', () => {
  const L = ssh.parseForward('-L', '8080:example.com:80');
  assert.deepEqual(L, { type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'example.com', destPort: 80 });
  assert.deepEqual(ssh.forwardArgs(L), ['-L', '127.0.0.1:8080:example.com:80']);

  const L4 = ssh.parseForward('-L', '0.0.0.0:8080:db.int:5432');
  assert.deepEqual(L4, { type: 'local', bind: '0.0.0.0', srcPort: 8080, destHost: 'db.int', destPort: 5432 });

  const R = ssh.parseForward('-R', '9000:localhost:3000');
  assert.deepEqual(R, { type: 'remote', bind: '127.0.0.1', srcPort: 9000, destHost: 'localhost', destPort: 3000 });

  const D = ssh.parseForward('-D', '1080');
  assert.deepEqual(D, { type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 });
  const D2 = ssh.parseForward('-D', '0.0.0.0:1080');
  assert.deepEqual(D2, { type: 'dynamic', bind: '0.0.0.0', srcPort: 1080 });
});

test('parseForward handles bracketed IPv6 and re-brackets via forwardArgs', () => {
  const f = ssh.parseForward('-L', '[::1]:8080:[fe80::1]:80');
  assert.deepEqual(f, { type: 'local', bind: '::1', srcPort: 8080, destHost: 'fe80::1', destPort: 80 });
  assert.deepEqual(ssh.forwardArgs(f), ['-L', '[::1]:8080:[fe80::1]:80']);
});

test('parseForward normalizes * bind to 0.0.0.0', () => {
  assert.equal(ssh.parseForward('-L', '*:8080:h:80').bind, '0.0.0.0');
});

test('parseForward rejects the tightened-out cases', () => {
  assert.throws(() => ssh.parseForward('-L', '/tmp/x.sock:h:80'), /socket/i); // unix socket
  assert.throws(() => ssh.parseForward('-R', '1080'), /host/i);               // bare -R (no target)
  assert.throws(() => ssh.parseForward('-L', '8080:h'), /host/i);             // too few fields
  assert.throws(() => ssh.parseForward('-L', '99999:h:80'), /1–65535/);       // port range
  assert.throws(() => ssh.parseForward('-L', 'abc:h:80'), /invalid port/);    // non-numeric port
  assert.throws(() => ssh.parseForward('-L', ':8080:h:80'), /empty bind/);    // empty explicit bind
  assert.throws(() => ssh.parseForward('-L', '8080::80'), /empty host/);      // empty target host
  assert.throws(() => ssh.parseForward('-D', ''), /needs a spec/);            // empty
});
