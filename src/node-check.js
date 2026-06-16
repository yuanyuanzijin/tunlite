'use strict';

// Node-version gate. Kept deliberately ES5-only (var / function / string
// concat) so it PARSES and RUNS on any old Node — it is required by
// bin/tunlite.js before any modern module, so a too-old runtime gets a clear
// message here instead of a cryptic SyntaxError/TypeError deeper in the load.

var MIN_MAJOR = 18;

function check(version, majorOverride) {
  var major = typeof majorOverride === 'number'
    ? majorOverride
    : parseInt(String(version).split('.')[0], 10);
  if (major >= MIN_MAJOR) return { ok: true };
  return {
    ok: false,
    message:
      'tunlite requires Node.js >= ' + MIN_MAJOR + ' — this is Node ' + version + '.\n' +
      'Upgrade Node (https://nodejs.org), or with a version manager:\n' +
      '  nvm install ' + MIN_MAJOR + ' && nvm use ' + MIN_MAJOR + '   # then re-run the install\n',
  };
}

module.exports = { check: check, MIN_MAJOR: MIN_MAJOR };
