'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const SKILL_NAME = 'ssh-tunnel';

// Where the skill source lives. Normally that's the running copy
// (`<runtime>/skill/ssh-tunnel`). But the combined `install` runs this step
// AFTER anchor()'s cleanupLegacy() may have deleted the location we're running
// from (an npm-global dir whose skill/ then vanishes mid-install). The anchored
// libDir always carries a fresh copy (RUNTIME_ITEMS includes 'skill'), so fall
// back to it via the install manifest. Returns the first candidate that actually
// holds a SKILL.md, else the running-copy path (so the "not found" error names
// the expected location).
function sourceDir(opts = {}) {
  const fsm = opts.fs || fs;
  const runningDir = opts.runningDir || path.join(__dirname, '..');
  const candidates = [path.join(runningDir, 'skill', SKILL_NAME)];
  try {
    const m = JSON.parse(fsm.readFileSync(opts.manifestFile || paths.installManifestFile(), 'utf8'));
    if (m && m.libDir) candidates.push(path.join(m.libDir, 'skill', SKILL_NAME));
  } catch (_) { /* no/unreadable manifest — running copy is the only candidate */ }
  for (const c of candidates) {
    if (fsm.existsSync(path.join(c, 'SKILL.md'))) return c;
  }
  return candidates[0];
}
function manifestFile() { return path.join(paths.dataDir(), 'skills.json'); }

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch (_) { return []; }
}
function writeManifest(list) {
  fs.mkdirSync(path.dirname(manifestFile()), { recursive: true });
  fs.writeFileSync(manifestFile(), JSON.stringify([...new Set(list)], null, 2));
}

// Resolve a skills directory from a choice: user | cwd | <explicit path>.
function resolveDir(choice) {
  if (!choice || choice === 'user') {
    return process.env.TUNLITE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
  }
  if (choice === 'cwd' || choice === '.') return path.join(process.cwd(), '.claude', 'skills');
  return choice;
}

function isOurSkill(dest) {
  try { return fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes(`name: ${SKILL_NAME}`); }
  catch (_) { try { return fs.lstatSync(dest).isSymbolicLink(); } catch (_) { return false; } }
}

// Remove only skill dirs that are ours; returns the ones removed.
function removeRecorded(targets) {
  const removed = [];
  for (const dest of targets) {
    let present = false;
    try { fs.lstatSync(dest); present = true; } catch (_) {}
    if (present && isOurSkill(dest)) { fs.rmSync(dest, { recursive: true, force: true }); removed.push(dest); }
  }
  return removed;
}

// Compare each recorded skill install against the bundled SKILL.md the running
// runtime ships (which always matches THIS CLI version). Symlinked installs are
// live, so they're current by definition. A copied install whose SKILL.md differs
// from the bundled one is 'stale' — the usual cause is `tunlite update` bumping
// the bundled skill while the installed copy stayed behind. Comparing content
// (not a version stamp) means zero false positives: a release that didn't touch
// the skill leaves copies byte-identical, so nothing is flagged.
// Returns [{ dest, state: 'ok' | 'stale' | 'missing' | 'link' }].
function freshness(opts = {}) {
  const fsm = opts.fs || fs;
  const bundledFile = path.join(opts.sourceDir || sourceDir(), 'SKILL.md');
  let ref = null;
  try { ref = fsm.readFileSync(bundledFile, 'utf8'); } catch (_) { /* unreadable → can't compare */ }
  const out = [];
  for (const dest of (opts.manifest || readManifest())) {
    let st = null;
    try { st = fsm.lstatSync(dest); } catch (_) { out.push({ dest, state: 'missing' }); continue; }
    if (st.isSymbolicLink()) { out.push({ dest, state: 'link' }); continue; }
    let cur = null;
    try { cur = fsm.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'); } catch (_) { /* gone */ }
    if (cur == null) out.push({ dest, state: 'missing' });
    else if (ref == null) out.push({ dest, state: 'ok' }); // no reference to compare → don't nag
    else out.push({ dest, state: cur === ref ? 'ok' : 'stale' });
  }
  return out;
}

module.exports = {
  SKILL_NAME, sourceDir, manifestFile, readManifest, writeManifest, resolveDir, removeRecorded, freshness,
};
