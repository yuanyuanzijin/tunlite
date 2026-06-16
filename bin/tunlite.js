#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

run(process.argv.slice(2))
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    process.stderr.write(`fatal: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
