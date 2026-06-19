'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const completion = require('../src/completion');
const config = require('../src/config');
const { run, HELP } = require('../src/cli');

function capture() {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

test('script() emits per-shell completion containing verbs and the names callback', () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const s = completion.script(shell);
    assert.match(s, /\bstatus\b/);
    assert.match(s, /\bimport\b/);
    assert.match(s, /completion names/); // dynamic tunnel-name source
    assert.match(s, /\btunlite\b/);      // registered for the canonical name
    assert.match(s, /\btun\b/);          // ...and the short alias
  }
});

test('script() rejects an unknown shell', () => {
  assert.throws(() => completion.script('powershell'), /unsupported shell/);
});

test('tunnelNames reads names straight from a config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-comp-'));
  const file = path.join(dir, 'config.json');
  const c = config.defaultConfig();
  config.upsertTunnel(c, { name: 'web-8080', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1080 }] });
  config.upsertTunnel(c, { name: 'db-5432', host: 'me@h', forwards: [{ type: 'dynamic', srcPort: 1081 }] });
  config.save(c, file);
  assert.deepEqual(completion.tunnelNames(file).sort(), ['db-5432', 'web-8080']);
});

test('tunnelNames returns [] for a missing config (no throw)', () => {
  assert.deepEqual(completion.tunnelNames(path.join(os.tmpdir(), 'nope-xyz', 'config.json')), []);
});

test('CLI: completion <shell> prints to stdout; bad shell is a usage error', async () => {
  const c = capture();
  assert.equal(await run(['completion', 'bash'], c.io), 0);
  assert.match(c.out(), /complete -F _tunlite tunlite/);

  const c2 = capture();
  assert.equal(await run(['completion', 'oops'], c2.io), 2);
  assert.match(c2.err(), /usage: tunlite completion/);
});

test('CLI: completion names prints bare tunnel names, one per line', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-compcli-'));
  const prev = process.env.TUNLITE_HOME;
  process.env.TUNLITE_HOME = home;
  try {
    await run(['add', 'web-8080', '--to', 'me@h', '-D', '1080'], capture().io);
    const c = capture();
    assert.equal(await run(['completion', 'names'], c.io), 0);
    assert.equal(c.out().trim(), 'web-8080');
  } finally {
    if (prev === undefined) delete process.env.TUNLITE_HOME; else process.env.TUNLITE_HOME = prev;
  }
});

test('detectShell maps $SHELL basename to a supported shell, else null', () => {
  assert.equal(completion.detectShell({ SHELL: '/bin/zsh' }), 'zsh');
  assert.equal(completion.detectShell({ SHELL: '/usr/bin/bash' }), 'bash');
  assert.equal(completion.detectShell({ SHELL: '/usr/local/bin/fish' }), 'fish');
  assert.equal(completion.detectShell({ SHELL: '/bin/ksh' }), null);
  assert.equal(completion.detectShell({}), null);
});

test('rcPath points each shell at its target file under home', () => {
  assert.equal(completion.rcPath('zsh', '/h'), path.join('/h', '.zshrc'));
  assert.equal(completion.rcPath('bash', '/h'), path.join('/h', '.bashrc'));
  assert.equal(completion.rcPath('fish', '/h'), path.join('/h', '.config', 'fish', 'completions', 'tunlite.fish'));
  assert.throws(() => completion.rcPath('ksh', '/h'), /unsupported shell/);
});

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-rc-')); }

test('installInto (zsh) appends a marker block to ~/.zshrc, preserving prior content', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');
  const r = completion.installInto('zsh', { home });
  assert.equal(r.action, 'added');
  assert.equal(r.path, path.join(home, '.zshrc'));
  const body = fs.readFileSync(r.path, 'utf8');
  assert.match(body, /export FOO=1/);                       // existing content kept
  assert.match(body, /eval "\$\(tunlite completion zsh\)"/); // our line added
  assert.ok(body.includes(completion.MARK_BEGIN));
});

test('installInto is idempotent — second run updates in place, no duplicate block', () => {
  const home = tmpHome();
  completion.installInto('zsh', { home });
  const r = completion.installInto('zsh', { home });
  assert.equal(r.action, 'updated');
  const body = fs.readFileSync(r.path, 'utf8');
  const count = body.split(completion.MARK_BEGIN).length - 1;
  assert.equal(count, 1); // exactly one block
});

test('installInto works when the rc file does not exist yet', () => {
  const home = tmpHome();
  const r = completion.installInto('bash', { home });
  assert.equal(r.action, 'added');
  assert.match(fs.readFileSync(r.path, 'utf8'), /tunlite completion bash/);
});

test('removeFrom (zsh) strips our block and leaves the rest intact', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.zshrc'), 'line1\nline2\n');
  completion.installInto('zsh', { home });
  const r = completion.removeFrom('zsh', { home });
  assert.equal(r.removed, true);
  const body = fs.readFileSync(r.path, 'utf8');
  assert.ok(!body.includes(completion.MARK_BEGIN));
  assert.match(body, /line1/);
  assert.match(body, /line2/);
});

test('removeFrom is a safe no-op when nothing was installed', () => {
  const home = tmpHome();
  const r = completion.removeFrom('zsh', { home });
  assert.equal(r.removed, false);
});

test('installInto/removeFrom (fish) create and delete the completions file', () => {
  const home = tmpHome();
  const r = completion.installInto('fish', { home });
  assert.match(fs.readFileSync(r.path, 'utf8'), /__tunlite_names/);
  const rm = completion.removeFrom('fish', { home });
  assert.equal(rm.removed, true);
  assert.ok(!fs.existsSync(r.path));
});

test('COMMANDS no longer advertises the internal `completion` verb', () => {
  assert.ok(!completion.COMMANDS.includes('completion'));
  assert.ok(completion.COMMANDS.includes('install'));   // still a user verb
  assert.ok(completion.COMMANDS.includes('status'));
});

test('CLI: install completion <shell> writes the block; uninstall completion removes it', async () => {
  if (process.platform === 'win32') return; // posix shells only
  const home = tmpHome();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const c = capture();
    assert.equal(await run(['install', 'completion', 'zsh'], c.io), 0);
    assert.match(c.out(), /enabled zsh completion/);
    assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /tunlite completion zsh/);

    const c2 = capture();
    assert.equal(await run(['uninstall', 'completion', 'zsh'], c2.io), 0);
    assert.match(c2.out(), /removed zsh completion/);
    assert.ok(!fs.readFileSync(path.join(home, '.zshrc'), 'utf8').includes(completion.MARK_BEGIN));
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});

test('CLI: install completion with no shell + undetectable $SHELL is a usage error', async () => {
  if (process.platform === 'win32') return;
  const prevS = process.env.SHELL;
  process.env.SHELL = '/bin/ksh'; // unsupported -> detectShell returns null
  try {
    const c = capture();
    assert.equal(await run(['install', 'completion'], c.io), 2);
    assert.match(c.err(), /could not detect|usage: tunlite install completion/);
  } finally {
    if (prevS === undefined) delete process.env.SHELL; else process.env.SHELL = prevS;
  }
});

test('bare uninstall strips completion from known shells', async () => {
  if (process.platform === 'win32') return;
  const home = tmpHome();
  const saved = {
    HOME: process.env.HOME, TUNLITE_HOME: process.env.TUNLITE_HOME,
    TUNLITE_FAKE_AUTOSTART: process.env.TUNLITE_FAKE_AUTOSTART,
  };
  process.env.HOME = home;
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    completion.installInto('zsh', { home });
    assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /tunlite completion/);
    const c = capture();
    assert.equal(await run(['uninstall'], c.io), 0);
    assert.ok(!fs.readFileSync(path.join(home, '.zshrc'), 'utf8').includes(completion.MARK_BEGIN));
    assert.match(c.out(), /completion removed/);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('install -y wires shell completion for the detected shell', async () => {
  if (process.platform === 'win32') return;
  const home = tmpHome();
  const saved = {
    HOME: process.env.HOME, SHELL: process.env.SHELL,
    TUNLITE_HOME: process.env.TUNLITE_HOME, TUNLITE_FAKE_AUTOSTART: process.env.TUNLITE_FAKE_AUTOSTART,
  };
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  process.env.TUNLITE_HOME = home;
  process.env.TUNLITE_FAKE_AUTOSTART = '1';
  try {
    const c = capture();
    const code = await run([
      'install', '--yes',
      '--bin', path.join(home, 'bin'), '--node', process.execPath, '--json',
    ], c.io);
    assert.equal(code, 0);
    const doc = JSON.parse(c.out());
    assert.ok(doc.onboard.completion, 'completion recorded in onboard summary');
    assert.match(doc.onboard.completion.path, /\.zshrc$/);
    assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /tunlite completion zsh/);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('help hides the raw completion command but documents install completion', () => {
  assert.doesNotMatch(HELP, /completion <bash\|zsh\|fish>/); // raw command no longer advertised
  assert.match(HELP, /install completion/);                   // user-facing entry present
  assert.match(HELP, /uninstall \[service\|skill\|completion\]/);
});

test('doctor is a completion command and takes a tunnel-name arg', () => {
  const { COMMANDS, NAME_COMMANDS } = require('../src/completion');
  assert.ok(COMMANDS.includes('doctor'));
  assert.ok(NAME_COMMANDS.includes('doctor'));
});
