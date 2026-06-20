'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { diagnose } = require('../src/doctor');

// A deps object where everything is healthy by default; override per test.
function deps(over = {}) {
  return Object.assign({
    commandExists: () => true,
    probeAuth: async () => ({ ok: true }),
    probePort: async () => false,        // nothing listening locally
    keypairExists: () => '/home/u/.ssh/id_ed25519',
    isAnchored: () => true,
    readManifest: () => ({ binDir: '/usr/local/bin', nodePath: '/usr/local/bin/node' }),
    isOnPath: () => true,
    fileExists: () => true,
    daemonStatus: async () => ({ running: true, tunnels: [] }),
    serviceStatus: () => ({ platform: 'darwin', installed: true, running: true }),
    loadConfig: () => ({ tunnels: [] }),
    skillFreshness: () => [],            // no skill installs by default (machine-independent)
  }, over);
}
const find = (r, id) => r.checks.find((c) => c.id === id);

test('all healthy, no tunnels: ok=true, no failures', async () => {
  const r = await diagnose({ deps: deps() });
  assert.equal(r.ok, true);
  assert.equal(r.summary.fail, 0);
  assert.equal(find(r, 'ssh-client').status, 'ok');
  assert.equal(find(r, 'daemon').status, 'info'); // no tunnels
});

test('missing ssh client is a failure with a fix', async () => {
  const r = await diagnose({ deps: deps({ commandExists: (n) => n !== 'ssh' }) });
  const c = find(r, 'ssh-client');
  assert.equal(c.status, 'fail');
  assert.match(c.fix, /OpenSSH/);
  assert.equal(r.ok, false);
});

test('config that fails to load => config-valid fail, per-tunnel skipped', async () => {
  const r = await diagnose({ deps: deps({ loadConfig: () => { throw new Error('bad json'); } }) });
  const c = find(r, 'config-valid');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /bad json/);
  assert.ok(!r.checks.some((x) => x.group.startsWith('tunnel:')));
});

test('tunnels configured but daemon down => daemon fail', async () => {
  const r = await diagnose({ deps: deps({
    loadConfig: () => ({ tunnels: [{ name: 'web', host: 'me@h', port: 22, enabled: true, identityFile: null,
      forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'localhost', destPort: 80 }] }] }),
    daemonStatus: async () => ({ running: false, tunnels: [] }),
  }) });
  assert.equal(find(r, 'daemon').status, 'fail');
  assert.match(find(r, 'daemon').fix, /tunlite enable/);
});

test('per-tunnel auth fail suggests setup-key', async () => {
  const r = await diagnose({ deps: deps({
    loadConfig: () => ({ tunnels: [{ name: 'web', host: 'me@h', port: 22, enabled: true, identityFile: null,
      forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'localhost', destPort: 80 }] }] }),
    daemonStatus: async () => ({ running: false, tunnels: [] }),
    probeAuth: async () => ({ ok: false }),
  }) });
  const auth = r.checks.find((c) => c.group === 'tunnel:web' && c.id === 'tunnel-auth');
  assert.equal(auth.status, 'fail');
  assert.match(auth.fix, /setup-key me@h/);
});

test('local port occupied while down => warn (bind will fail)', async () => {
  const r = await diagnose({ deps: deps({
    loadConfig: () => ({ tunnels: [{ name: 'web', host: 'me@h', port: 22, enabled: true, identityFile: null,
      forwards: [{ type: 'local', bind: '127.0.0.1', srcPort: 8080, destHost: 'localhost', destPort: 80 }] }] }),
    daemonStatus: async () => ({ running: false, tunnels: [] }),
    probePort: async () => true, // occupied
  }) });
  const port = r.checks.find((c) => c.group === 'tunnel:web' && c.id === 'tunnel-ports');
  assert.equal(port.status, 'warn');
  assert.match(port.detail, /already in use/);
});

test('doctor <name> focuses one tunnel even if disabled', async () => {
  const cfg = { tunnels: [
    { name: 'a', host: 'me@h', port: 22, enabled: false, identityFile: null, forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1080 }] },
    { name: 'b', host: 'me@h', port: 22, enabled: true, identityFile: null, forwards: [{ type: 'dynamic', bind: '127.0.0.1', srcPort: 1081 }] },
  ] };
  const r = await diagnose({ name: 'a', deps: deps({ loadConfig: () => cfg, daemonStatus: async () => ({ running: false, tunnels: [] }) }) });
  assert.ok(r.checks.some((c) => c.group === 'tunnel:a'));
  assert.ok(!r.checks.some((c) => c.group === 'tunnel:b'));
});

test('no skill installs => no skill-fresh check at all', async () => {
  const r = await diagnose({ deps: deps() });   // skillFreshness defaults to []
  assert.equal(find(r, 'skill-fresh'), undefined);
});

test('fresh skill install => skill-fresh ok, no failure', async () => {
  const r = await diagnose({ deps: deps({ skillFreshness: () => [{ dest: '/u/.claude/skills/ssh-tunnel', state: 'ok' }] }) });
  assert.equal(find(r, 'skill-fresh').status, 'ok');
  assert.equal(r.summary.fail, 0);
});

test('stale skill install => skill-fresh warn pointing at install skill', async () => {
  const r = await diagnose({ deps: deps({ skillFreshness: () => [
    { dest: '/u/.claude/skills/ssh-tunnel', state: 'stale' },
    { dest: '/proj/.claude/skills/ssh-tunnel', state: 'ok' },
  ] }) });
  const c = find(r, 'skill-fresh');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /older than the bundled/);
  assert.match(c.fix, /tunlite install skill/);
  assert.equal(r.ok, true);   // a stale skill is a warning, never a hard failure
});
