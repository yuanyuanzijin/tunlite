#!/usr/bin/env node
'use strict';

// Gate the Node version FIRST, before requiring src/cli (and the modern syntax
// it pulls in). On a too-old runtime this prints a clear message and exits,
// instead of letting install look "done" and then crash on a SyntaxError.
// node-check is ES5-only so it parses on any Node; keep this block ES5 too.
var gate = require('../src/node-check').check(process.versions.node);
if (!gate.ok) {
  process.stderr.write(gate.message);
  process.exit(1);
}

require('../src/cli').run(process.argv.slice(2))
  .then(function (code) { process.exitCode = code || 0; })
  .catch(function (err) {
    process.stderr.write('fatal: ' + (err.stack || err.message) + '\n');
    process.exitCode = 1;
  });
