'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

function sshBinary() {
  return process.env.TUNLITE_SSH || 'ssh';
}

function sshKeygenBinary() {
  return process.env.TUNLITE_SSH_KEYGEN || 'ssh-keygen';
}

// Build the ssh argument vector (excluding the binary name) for a tunnel.
function buildArgs(tunnel, settings = {}, opts = {}) {
  const batch = opts.batch !== false; // daemon tunnels are always non-interactive
  const keepalive = settings.keepalive || { intervalSec: 15, countMax: 3 };
  const connectTimeout = settings.connectTimeoutSec || 10;
  const args = ['-N', '-T'];
  if (batch) args.push('-o', 'BatchMode=yes');
  args.push('-o', `ServerAliveInterval=${keepalive.intervalSec}`);
  args.push('-o', `ServerAliveCountMax=${keepalive.countMax}`);
  args.push('-o', 'ExitOnForwardFailure=yes');
  args.push('-o', `ConnectTimeout=${connectTimeout}`);
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  if (tunnel.identityFile) {
    args.push('-i', paths.expandHome(tunnel.identityFile));
    args.push('-o', 'IdentitiesOnly=yes');
  }
  if (tunnel.port && tunnel.port !== 22) {
    args.push('-p', String(tunnel.port));
  }
  if (Array.isArray(tunnel.jump) && tunnel.jump.length) {
    args.push('-J', tunnel.jump.join(','));
  }
  for (const f of tunnel.forwards || []) {
    args.push(...forwardArgs(f));
  }
  if (Array.isArray(tunnel.sshOptions)) {
    args.push(...tunnel.sshOptions);
  }
  // `--` ends option parsing so a host beginning with `-` (despite config-load
  // validation) can never be read by ssh as an option (e.g. -oProxyCommand=...).
  args.push('--');
  args.push(tunnel.host);
  return args;
}

function forwardArgs(f) {
  if (f.type === 'dynamic') {
    return ['-D', `${f.bind || '127.0.0.1'}:${f.srcPort}`];
  }
  const flag = f.type === 'remote' ? '-R' : '-L';
  return [flag, `${f.bind || '127.0.0.1'}:${f.srcPort}:${f.destHost}:${f.destPort}`];
}

// Local listening ports we expect for a tunnel (for health probing).
function listeningPorts(tunnel) {
  return (tunnel.forwards || [])
    .filter((f) => f.type === 'local' || f.type === 'dynamic')
    .map((f) => ({ host: f.bind || '127.0.0.1', port: f.srcPort }));
}

// Stderr signatures from `ssh -v`. Auth SUCCESS is announced the instant the
// key is accepted ("Authenticated to host (...) using ..."), before any remote
// command runs — that's our early go signal. Auth FAILURE is what sshd emits
// when it will NOT let us in.
const AUTH_SUCCESS_RE = /\bAuthenticated to |\bAuthentication succeeded\b/i;
const AUTH_FAILURE_RE =
  /permission denied|too many authentication failures|no matching (?:host key type|key exchange method|cipher)|host key verification failed|could not resolve hostname|connection (?:refused|timed out|closed)/i;

// Probe whether passwordless (key-based) auth works for host. Resolves
// { ok, code, timedOut, restricted, stderr }. ok === true means we got in
// without a password.
//
// We run with `-v` and decide from the auth-phase signal, NOT from how the
// session ends — so a reachable host returns in well under a second instead of
// waiting out a timeout:
//   * "Authenticated to ..."  -> ok. A normal host's `true` exits 0 right after;
//     a tunnel-only / forced-command account just hangs, so we give the command
//     a brief grace to exit cleanly, else conclude `restricted` (still ok).
//   * an auth-failure line     -> not ok, return immediately.
//
// `ConnectTimeout` only bounds TCP setup, so a hard wall-clock budget over the
// WHOLE exchange (plus ServerAliveInterval/CountMax) is kept as a safety net for
// the rare host that neither authenticates nor fails — without it a server that
// holds the connection open would hang `probeAuth` (and thus `tunlite check`/`up`)
// forever. Same fix shape as ipc.request(): connect-only timeout ≠ full-exchange
// timeout.
function probeAuth(host, opts = {}) {
  return new Promise((resolve) => {
    const connectTimeout = opts.timeoutSec || 8;
    const hardMs = (opts.hardTimeoutSec || connectTimeout + 4) * 1000;
    const graceMs = opts.graceMs != null ? opts.graceMs : 400;
    const args = [
      '-v',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-o', 'ServerAliveInterval=3',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
    if (opts.identityFile) {
      args.push('-i', paths.expandHome(opts.identityFile), '-o', 'IdentitiesOnly=yes');
    }
    if (opts.port && opts.port !== 22) args.push('-p', String(opts.port));
    if (Array.isArray(opts.jump) && opts.jump.length) args.push('-J', opts.jump.join(','));
    if (Array.isArray(opts.sshOptions) && opts.sshOptions.length) args.push(...opts.sshOptions);
    // `--` ends option parsing so a host beginning with `-` can't be read as a flag.
    args.push('--', host, 'true');

    const child = cp.spawn(opts.sshBinary || sshBinary(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true, // don't flash a console window during `check` on Windows
    });
    let stderr = '';
    let done = false;
    let graceTimer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      resolve(result);
    };

    const hardTimer = setTimeout(() => {
      // Connected but never authenticated and never failed within budget. No
      // auth-failure signature means we most likely did get in; report ok but
      // flagged, rather than hang.
      const restricted = !AUTH_FAILURE_RE.test(stderr);
      finish({ ok: restricted, code: null, timedOut: true, restricted, stderr });
    }, hardMs);

    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (done || graceTimer) return;
        if (AUTH_FAILURE_RE.test(stderr)) {
          finish({ ok: false, code: 255, stderr });
        } else if (AUTH_SUCCESS_RE.test(stderr)) {
          graceTimer = setTimeout(
            () => finish({ ok: true, code: null, restricted: true, authenticated: true, stderr }),
            graceMs,
          );
        }
      });
    }

    child.on('error', (err) => finish({ ok: false, code: -1, error: err.message, stderr }));
    // Clean exit: covers a normal host whose `true` ran (code 0) and non-verbose
    // stubs. Wins over the grace timer when the command exits first.
    child.on('exit', (code) => finish({ ok: code === 0, code, stderr }));
  });
}

function commandExists(name) {
  const probe = os.platform() === 'win32' ? 'where' : 'which';
  const r = cp.spawnSync(probe, [name], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}

// Ensure a usable keypair exists. Returns { privateKey, publicKey, generated }.
// Reuses an existing default key when present, otherwise generates ed25519.
function ensureKeypair(opts = {}) {
  const sshDir = path.join(os.homedir(), '.ssh');
  if (opts.identityFile) {
    const priv = paths.expandHome(opts.identityFile);
    const pub = `${priv}.pub`;
    if (fs.existsSync(priv)) {
      if (!fs.existsSync(pub)) derivePublicKey(priv, pub);
      return { privateKey: priv, publicKey: pub, generated: false };
    }
    fs.mkdirSync(path.dirname(priv), { recursive: true, mode: 0o700 });
    generateKey(priv, opts.comment);
    return { privateKey: priv, publicKey: pub, generated: true };
  }
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const priv = path.join(sshDir, name);
    if (fs.existsSync(priv)) {
      const pub = `${priv}.pub`;
      if (!fs.existsSync(pub)) derivePublicKey(priv, pub);
      return { privateKey: priv, publicKey: pub, generated: false };
    }
  }
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const priv = path.join(sshDir, 'id_ed25519');
  generateKey(priv, opts.comment);
  return { privateKey: priv, publicKey: `${priv}.pub`, generated: true };
}

function generateKey(priv, comment) {
  const args = ['-t', 'ed25519', '-N', '', '-f', priv, '-C', comment || `tunlite@${os.hostname()}`];
  const r = cp.spawnSync(sshKeygenBinary(), args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ssh-keygen failed to generate a key');
}

function derivePublicKey(priv, pub) {
  const r = cp.spawnSync(sshKeygenBinary(), ['-y', '-f', priv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not derive public key from ${priv}`);
  fs.writeFileSync(pub, r.stdout, { mode: 0o644 });
}

// Install our public key on the target so future logins are passwordless.
// Interactive: prompts for the target password once (stdio inherited).
// Returns { ok }.
function setupKey(host, opts = {}) {
  const kp = ensureKeypair(opts);
  const pubContent = fs.readFileSync(kp.publicKey, 'utf8').trim();
  // The portable fallback interpolates pubContent into a single-quoted remote
  // command. A `.pub` whose comment carries a single quote or a newline would
  // break out of the quoting and run arbitrary commands on the TARGET. A normal
  // OpenSSH public key is one line with no single quote, so reject anything else
  // BEFORE spawning rather than try to escape it through an interactive (stdin
  // password) ssh session.
  if (pubContent.includes('\n') || pubContent.includes("'")) {
    throw new Error(`refusing to use public key ${kp.publicKey}: it must be a single line with no single-quote character`);
  }
  const port = opts.port && opts.port !== 22 ? ['-p', String(opts.port)] : [];
  const jump = (Array.isArray(opts.jump) && opts.jump.length) ? ['-o', `ProxyJump=${opts.jump.join(',')}`] : [];

  if (!opts.noSshCopyId && commandExists('ssh-copy-id')) {
    const args = ['-i', kp.publicKey, ...port, ...jump, host];
    const r = cp.spawnSync('ssh-copy-id', args, { stdio: 'inherit' });
    if (r.status === 0) return { ok: true, method: 'ssh-copy-id', key: kp };
    // fall through to portable method on failure
  }

  // Portable fallback: append the key over a password ssh session.
  const remote = [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    `{ grep -qxF '${pubContent}' ~/.ssh/authorized_keys || printf '%s\\n' '${pubContent}' >> ~/.ssh/authorized_keys; }`,
  ].join(' && ');
  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    ...port,
    ...jump,
    host,
    remote,
  ];
  const r = cp.spawnSync(opts.sshBinary || sshBinary(), args, { stdio: 'inherit' });
  return { ok: r.status === 0, method: 'append', key: kp };
}

module.exports = {
  sshBinary,
  buildArgs,
  forwardArgs,
  listeningPorts,
  probeAuth,
  commandExists,
  ensureKeypair,
  setupKey,
};
