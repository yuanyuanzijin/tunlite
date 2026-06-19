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
