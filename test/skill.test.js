'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skill = require('../src/skill');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tunlite-skill-')); }
function plantSkill(dir) {
  const d = path.join(dir, 'skill', skill.SKILL_NAME);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${skill.SKILL_NAME}\n---\n`);
  return d;
}
function writeManifest(file, libDir) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ libDir }) + '\n');
}

test('sourceDir: prefers the running copy when it carries SKILL.md', () => {
  const run = tmp();
  const want = plantSkill(run);
  const got = skill.sourceDir({ runningDir: run, manifestFile: path.join(tmp(), 'absent.json') });
  assert.equal(got, want);
});

// Regression: combined `install` from an npm-global dir — cleanupLegacy deletes
// the running copy's skill/ mid-anchor, so sourceDir must fall back to the
// anchored libDir recorded in the install manifest instead of erroring.
test('sourceDir: falls back to the anchored libDir when the running copy is gone', () => {
  const run = tmp();                 // running dir with NO skill/ (simulates the deleted npm dir)
  const lib = tmp();
  const want = plantSkill(lib);      // anchored copy still has the skill
  const mf = path.join(tmp(), 'install.json');
  writeManifest(mf, lib);
  const got = skill.sourceDir({ runningDir: run, manifestFile: mf });
  assert.equal(got, want);
  assert.ok(fs.existsSync(path.join(got, 'SKILL.md')));
});

test('sourceDir: returns the running-copy path (for a stable error) when nothing has SKILL.md', () => {
  const run = tmp();
  const mf = path.join(tmp(), 'install.json');
  writeManifest(mf, tmp());          // manifest points at a libDir with no skill either
  const got = skill.sourceDir({ runningDir: run, manifestFile: mf });
  assert.equal(got, path.join(run, 'skill', skill.SKILL_NAME));
  assert.ok(!fs.existsSync(path.join(got, 'SKILL.md')));
});

// Plant an installed copy dir holding a SKILL.md with the given body.
function plantCopy(body) {
  const dest = path.join(tmp(), skill.SKILL_NAME);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), body);
  return dest;
}

test('freshness: identical copy is ok, drifted copy is stale', () => {
  const bundled = plantSkill(tmp());            // bundled SKILL.md (reference)
  const ref = fs.readFileSync(path.join(bundled, 'SKILL.md'), 'utf8');
  const okDest = plantCopy(ref);                // byte-identical → current
  const staleDest = plantCopy(ref + '\n# drifted\n');
  const res = skill.freshness({ sourceDir: bundled, manifest: [okDest, staleDest] });
  const state = Object.fromEntries(res.map((r) => [r.dest, r.state]));
  assert.equal(state[okDest], 'ok');
  assert.equal(state[staleDest], 'stale');
});

test('freshness: symlink install is live, missing dest reported', () => {
  const bundled = plantSkill(tmp());
  const linkDest = path.join(tmp(), skill.SKILL_NAME);
  fs.symlinkSync(bundled, linkDest);            // points at the live source
  const gone = path.join(tmp(), 'never-installed');
  const res = skill.freshness({ sourceDir: bundled, manifest: [linkDest, gone] });
  const state = Object.fromEntries(res.map((r) => [r.dest, r.state]));
  assert.equal(state[linkDest], 'link');
  assert.equal(state[gone], 'missing');
});

test('freshness: unreadable bundled reference does not nag (copy reported ok)', () => {
  const noBundle = path.join(tmp(), 'skill', skill.SKILL_NAME);  // no SKILL.md planted
  const dest = plantCopy('---\nname: ssh-tunnel\n---\nanything\n');
  const res = skill.freshness({ sourceDir: noBundle, manifest: [dest] });
  assert.equal(res[0].state, 'ok');
});
