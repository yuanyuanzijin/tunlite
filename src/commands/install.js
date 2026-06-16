'use strict';

// `install` / `uninstall` CLI command handlers (anchor + onboarding, teardown)
// plus the `skill` and shell-completion command wrappers. These wrap the existing
// install / completion / skill libraries — the libs stay separate; this module is
// only the CLI surface. Imports shared primitives from cli-core and daemonPing
// from daemon-control; never requires ../cli.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const ipc = require('../ipc');
const autostart = require('../autostart');
const skillmod = require('../skill');
const installer = require('../install');
const completionmod = require('../completion');
const { EXIT, parseFlags, jsonOut, line, errline, canPrompt, confirm } = require('../cli-core');
const { daemonPing } = require('../daemon-control');

// Register the OS autostart service (drives the autostart adapter; sandboxed
// under TUNLITE_FAKE_AUTOSTART). Returns a structured result so the `install`
// orchestrator can fold it into its single JSON document and read its exit
// code; `.code` carries the EXIT.* semantics (used by the `install service`
// handler, which returns it directly).
async function installService(_args, io, opts) {
  const ctx = autostart.context();
  let adapter;
  try { adapter = autostart.adapterFor(); } catch (e) { errline(io, e.message); return { ok: false, code: EXIT.ERROR, error: e.message }; }
  const res = adapter.install(ctx);
  const code = res.ok ? EXIT.OK : EXIT.ERROR;
  if (opts.json) { jsonOut(io, res); return { ok: res.ok, code, ...res }; }
  line(io, res.ok ? `service installed: ${res.path}` : `service install failed: ${res.output}`);
  if (res.note) line(io, res.note);
  return { ok: res.ok, code, ...res };
}

// Wire shell completion into the user's shell (install completion [shell]).
async function completionInstall(args, io, opts) {
  if (process.platform === 'win32') { errline(io, 'shell completion is not supported on Windows'); return EXIT.USAGE; }
  const { positionals } = parseFlags(args);
  const shell = positionals[0] || completionmod.detectShell();
  if (!['bash', 'zsh', 'fish'].includes(shell)) {
    errline(io, 'usage: tunlite install completion <bash|zsh|fish>  (could not detect $SHELL)');
    return EXIT.USAGE;
  }
  const res = completionmod.installInto(shell);
  if (opts.json) { jsonOut(io, res); return EXIT.OK; }
  line(io, `${res.action === 'updated' ? 'updated' : 'enabled'} ${shell} completion in ${res.path}`);
  line(io, `reload with:  ${res.reload}`);
  return EXIT.OK;
}

// Remove shell completion (uninstall completion [shell]).
async function completionUninstall(args, io, opts) {
  if (process.platform === 'win32') { if (opts.json) jsonOut(io, { removed: false }); else line(io, 'shell completion is not supported on Windows'); return EXIT.OK; }
  const { positionals } = parseFlags(args);
  const shell = positionals[0] || completionmod.detectShell();
  if (!['bash', 'zsh', 'fish'].includes(shell)) {
    errline(io, 'usage: tunlite uninstall completion <bash|zsh|fish>  (could not detect $SHELL)');
    return EXIT.USAGE;
  }
  const res = completionmod.removeFrom(shell);
  if (opts.json) { jsonOut(io, res); return EXIT.OK; }
  line(io, res.removed ? `removed ${shell} completion from ${res.path}` : `no ${shell} completion found (${res.path})`);
  return EXIT.OK;
}

// Decide service/skill choices from flags, env, or an interactive prompt.
async function onboardChoices(flags, io) {
  // service: --service / --no-service / env TUNLITE_SERVICE=yes|no / prompt
  let service;
  if (flags['--service']) service = true;
  else if (flags['--no-service']) service = false;
  else if (process.env.TUNLITE_SERVICE) service = /^y(es)?$/i.test(process.env.TUNLITE_SERVICE);
  else if (flags['--yes'] || flags['-y']) service = false;
  else if (canPrompt()) service = await confirm(io, 'Register tunlite to start on login (autostart the daemon)? [y/N] ');
  else service = false;

  // skill: --skill <dir> / --no-skill / env TUNLITE_SKILL=user|cwd|path|no / prompt
  let skill = null;
  if (flags['--no-skill']) skill = null;
  else if (flags['--skill']) skill = flags['--skill'];
  else if (process.env.TUNLITE_SKILL) skill = /^no$/i.test(process.env.TUNLITE_SKILL) ? null : process.env.TUNLITE_SKILL;
  else if (flags['--yes'] || flags['-y']) skill = null;
  else if (canPrompt() && await confirm(io, 'Install the tunlite agent skill for Claude Code? [y/N] ')) skill = 'user';

  // completion: --completion / --no-completion / env TUNLITE_COMPLETION=yes|no /
  // prompt. Resolves to a shell name to wire, or false. Only offered when a
  // supported shell is detected (and never on Windows).
  const detected = process.platform === 'win32' ? null : completionmod.detectShell();
  let completion = false;
  if (flags['--no-completion']) completion = false;
  else if (flags['--completion']) completion = detected;
  else if (process.env.TUNLITE_COMPLETION) completion = /^y(es)?$/i.test(process.env.TUNLITE_COMPLETION) ? detected : false;
  else if (flags['--yes'] || flags['-y']) completion = false;
  else if (detected && canPrompt() && await confirm(io, `Enable shell completion for ${detected}? [y/N] `)) completion = detected;
  return { service, skill, completion };
}

// Guard a destructive rmSync against a malformed/hand-edited install manifest:
// libDir comes from disk and could point anywhere, so refuse the filesystem root,
// the home dir itself, or any path whose name doesn't obviously look like ours.
function safeToRemoveLib(libDir) {
  const r = path.resolve(libDir);
  if (r === path.parse(r).root) return false;             // filesystem root (/ or C:\)
  if (r === path.resolve(os.homedir())) return false;     // the home dir itself
  if (!/tunlite|[\\/]lib([\\/]|$)/i.test(r)) return false; // neither "tunlite" nor a "lib" segment
  return true;
}

// Install the companion agent skill into a Claude Code skills dir.
// Reached only via `install skill` / `uninstall skill` (no top-level surface):
//   tunlite install skill [--dir user|cwd|<path>] [--link]
//   tunlite uninstall skill [--dir ...]   (no --dir removes all recorded installs)
//   tunlite install skill status
async function skill(args, io, opts) {
  const sub = args[0];
  const { flags } = parseFlags(args.slice(1), { value: ['--dir'], bool: ['--link'] });
  if (sub === 'install') {
    const src = skillmod.sourceDir();
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) { errline(io, `skill source not found: ${src}`); return EXIT.ERROR; }
    const dest = path.join(skillmod.resolveDir(flags['--dir']), skillmod.SKILL_NAME);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    if (flags['--link']) fs.symlinkSync(path.resolve(src), dest);
    else fs.cpSync(src, dest, { recursive: true });
    skillmod.writeManifest([...skillmod.readManifest(), dest]);
    if (opts.json) { jsonOut(io, { installed: dest, mode: flags['--link'] ? 'link' : 'copy' }); return EXIT.OK; }
    line(io, `skill installed: ${dest}  (${flags['--link'] ? 'symlink' : 'copy'})`);
    line(io, 'open a new Claude Code session in that scope to load it.');
    return EXIT.OK;
  }
  if (sub === 'uninstall') {
    const manifest = skillmod.readManifest();
    const targets = flags['--dir'] ? [path.join(skillmod.resolveDir(flags['--dir']), skillmod.SKILL_NAME)] : manifest.slice();
    const removed = skillmod.removeRecorded(targets);
    skillmod.writeManifest(manifest.filter((d) => !targets.includes(d)));
    if (opts.json) { jsonOut(io, { removed }); return EXIT.OK; }
    line(io, removed.length ? `skill removed: ${removed.join(', ')}` : 'no installed skill found');
    return EXIT.OK;
  }
  if (sub === 'status' || !sub) {
    const rows = skillmod.readManifest().map((d) => ({ path: d, present: fs.existsSync(path.join(d, 'SKILL.md')) }));
    if (opts.json) { jsonOut(io, rows); return EXIT.OK; }
    if (!rows.length) { line(io, `skill not installed (run: tunlite install skill)`); return EXIT.OK; }
    for (const r of rows) line(io, `${r.present ? 'present' : 'MISSING'}  ${r.path}`);
    return EXIT.OK;
  }
  errline(io, `unknown skill subcommand: ${sub}`); return EXIT.USAGE;
}

// Full teardown driven by the install manifest: stop the daemon, remove the OS
// autostart service, remove the agent skill, delete the launcher + lib dir, and
// (with --purge) delete config + state. Sub-targets do one piece only:
//   uninstall service   remove just the autostart service
//   uninstall skill      route to the skill module's uninstall
async function uninstall(args, io, opts) {
  const sub = args[0];
  if (sub === 'service') {
    let adapter;
    try { adapter = autostart.adapterFor(); } catch (e) { errline(io, e.message); return EXIT.ERROR; }
    const res = adapter.uninstall(autostart.context());
    if (opts.json) jsonOut(io, res); else line(io, `service uninstalled (${res.removed ? 'file removed' : 'no file'})`);
    return EXIT.OK;
  }
  if (sub === 'skill') return skill(['uninstall', ...args.slice(1)], io, opts);
  if (sub === 'completion') return completionUninstall(args.slice(1), io, opts);

  const { flags } = parseFlags(args, { bool: ['--purge', '--yes', '-y'] });
  const steps = [];

  const ping = await daemonPing();
  if (ping) {
    try { await ipc.request(paths.socketPath(), 'shutdown', {}); steps.push('stopped daemon'); }
    catch (_) { steps.push('daemon stop failed (ignored)'); }
  } else {
    steps.push('daemon not running');
  }

  try {
    const res = autostart.adapterFor().uninstall(autostart.context());
    steps.push(`service removed (${res.removed ? res.path : 'none'})`);
  } catch (e) {
    steps.push(`service: ${e.message}`);
  }

  // Remove installed agent skills (before purge wipes the manifest).
  const removedSkills = skillmod.removeRecorded(skillmod.readManifest());
  skillmod.writeManifest([]);
  steps.push(`skill removed (${removedSkills.join(', ') || 'none'})`);

  // Remove any shell completion we wired in (idempotent across all known shells).
  if (process.platform !== 'win32') {
    for (const shell of ['zsh', 'bash', 'fish']) {
      try { const r = completionmod.removeFrom(shell); if (r.removed) steps.push(`completion removed (${r.path})`); }
      catch (_) { /* best-effort */ }
    }
  }

  // Remove launcher + lib using the install manifest.
  const m = installer.readManifest();
  if (m && m.binDir) {
    for (const name of ['tunlite', 'tunlite.cmd']) {
      const p = path.join(m.binDir, name);
      // An absent launcher is the normal case (we try both posix + win names);
      // a real failure (e.g. EACCES on a system /usr/local/bin) must surface.
      try { fs.unlinkSync(p); steps.push(`launcher removed (${p})`); }
      catch (e) { if (e.code !== 'ENOENT') steps.push(`launcher NOT removed (${p}): ${e.code}`); }
    }
    // The `tun` alias: only remove it if it's ours (don't delete a foreign tun).
    for (const name of ['tun', 'tun.cmd']) {
      const p = path.join(m.binDir, name);
      try {
        if (/tunlite/.test(fs.readFileSync(p, 'utf8'))) { fs.unlinkSync(p); steps.push(`alias removed (${p})`); }
        else steps.push(`alias NOT removed (foreign ${p})`);
      } catch (e) { if (e.code !== 'ENOENT') steps.push(`alias NOT removed (${p}): ${e.code}`); }
    }
  }
  if (m && m.libDir) {
    if (safeToRemoveLib(m.libDir)) {
      try { fs.rmSync(m.libDir, { recursive: true, force: true }); steps.push(`lib removed (${m.libDir})`); } catch (_) {}
    } else {
      steps.push(`lib NOT removed (suspicious path: ${m.libDir})`);
    }
  }

  let purged = [];
  if (flags['--purge']) {
    for (const dir of [paths.configDir(), paths.dataDir()]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); purged.push(dir); } catch (_) {}
    }
    try { fs.unlinkSync(paths.socketPath()); } catch (_) {}
    steps.push(`purged config + state (${purged.join(', ') || 'nothing'})`);
  } else {
    steps.push(`kept config + state (use --purge to delete: ${paths.configDir()})`);
  }

  if (opts.json) { jsonOut(io, { steps, purged }); return EXIT.OK; }
  for (const s of steps) line(io, `- ${s}`);
  line(io, 'tunlite removed.');
  return EXIT.OK;
}

async function install(args, io, opts) {
  const sub = args[0];
  if (sub === 'service') return (await installService(args.slice(1), io, opts)).code;
  if (sub === 'skill') {
    const rest = args.slice(1);
    const verb = ['status', 'uninstall', 'install'].includes(rest[0]) ? rest[0] : 'install';
    const tail = rest[0] === verb ? rest.slice(1) : rest;
    return skill([verb, ...tail], io, opts);
  }
  if (sub === 'completion') return completionInstall(args.slice(1), io, opts);

  const { flags } = parseFlags(args, {
    value: ['--lib', '--bin', '--node', '--skill'],
    bool: ['--yes', '-y', '--service', '--no-service', '--no-skill', '--completion', '--no-completion'],
  });
  const env = { ...process.env };
  if (flags['--node']) env.TUNLITE_NODE = flags['--node'];
  if (flags['--bin']) env.TUNLITE_BIN = flags['--bin'];

  // --lib / --bin are passed straight to anchor(); --node flows via env to pickStableNode.
  const res = installer.anchor({ env, libDir: flags['--lib'], binDir: flags['--bin'] });
  if (res.nodeWarn) errline(io, `note: pinned a version-manager node (${res.nodePath}); the autostart service may not survive a node version switch. Set TUNLITE_NODE to a system node to override.`);

  const { service, skill: skillChoice, completion } = await onboardChoices(flags, io);

  // In --json mode the sub-steps must NOT print anything of their own (we
  // emit one combined document at the end), so we run them with json:false
  // (to avoid a second JSON object) AND route their io to a sink that
  // swallows all output. In human mode they keep printing their own lines to
  // the real io. Either way we capture each opted-in step's exit code so a
  // failed requested step can't be masked by a successful anchor.
  const subOpts = opts.json ? { ...opts, json: false } : opts;
  const sink = { write() {} };
  const subIo = opts.json ? { out: sink, err: sink } : io;
  let serviceResult = false;
  let serviceCode = EXIT.OK;
  if (service) {
    serviceResult = await installService([], subIo, subOpts);
    serviceCode = serviceResult.code;
  }
  let skillCode = EXIT.OK;
  if (skillChoice) {
    // skill can fail by returning a non-OK code OR by throwing (e.g.
    // an unwritable --dir). Either way it's a failed opted-in step, not a
    // reason to abandon the install summary, so catch + degrade.
    try { skillCode = await skill(['install', '--dir', skillChoice], subIo, subOpts); }
    catch (e) { errline(io, `skill install failed: ${e.message}`); skillCode = EXIT.ERROR; }
  }
  let completionRes = null;
  if (completion) {
    try { completionRes = completionmod.installInto(completion); }
    catch (e) { errline(io, `completion install failed: ${e.message}`); }
  }
  const onboard = { service: serviceResult, skill: skillChoice || null, completion: completionRes, serviceCode, skillCode };

  // Degrade the overall exit code if any opted-in step failed; the anchor
  // succeeding must not hide a requested service/skill step failure.
  const failed = (service && serviceCode !== EXIT.OK) || (skillChoice && skillCode !== EXIT.OK);
  const exit = failed ? EXIT.ERROR : EXIT.OK;

  if (opts.json) { jsonOut(io, { ...res, onboard }); }
  else {
    line(io, `installed: ${res.libDir}`);
    line(io, `launcher:  ${res.launcher} -> ${res.entry}  (node: ${res.nodePath})`);
    if (res.alias) {
      line(io, res.alias.written
        ? `alias:     ${res.alias.path}  (short name: tun)`
        : `alias:     skipped — ${res.alias.path} already exists and isn't ours (use tunlite)`);
    }
    if (completionRes) line(io, `completion: ${completionRes.path}  (reload: ${completionRes.reload})`);
    if (!res.onPath) {
      line(io, '');
      const pu = res.pathUpdate || {};
      if (process.platform === 'win32') {
        // Windows: anchor() tried to persist the user PATH for us.
        if (pu.applicable && !pu.error) {
          line(io, `NOTE: added ${res.binDir} to your user PATH — open a NEW terminal for tunlite to be found.`);
        } else {
          line(io, pu.error
            ? `NOTE: couldn't set your user PATH automatically (${pu.error}). Add ${res.binDir} yourself (PowerShell), then reopen the terminal:`
            : `NOTE: ${res.binDir} is not on your PATH. Add it (PowerShell), then reopen the terminal:`);
          line(io, `  [Environment]::SetEnvironmentVariable('Path',[Environment]::GetEnvironmentVariable('Path','User')+';${res.binDir}','User')`);
        }
      } else {
        line(io, `NOTE: ${res.binDir} is not on your PATH. Add it, e.g.:`);
        line(io, `  echo 'export PATH="${res.binDir}:$PATH"' >> ~/.profile && . ~/.profile`);
      }
    }
    if (service && serviceCode !== EXIT.OK) line(io, 'WARNING: service install was requested but failed (see above) — autostart is NOT set up.');
    if (skillChoice && skillCode !== EXIT.OK) line(io, 'WARNING: skill install was requested but failed (see above) — the agent skill was NOT installed.');
    line(io, failed ? 'tunlite anchored, but a requested onboarding step failed (see warnings above).' : 'tunlite ready — try: tunlite help');
  }
  return exit;
}

module.exports = { install, uninstall, skill, installService, completionInstall, completionUninstall };
