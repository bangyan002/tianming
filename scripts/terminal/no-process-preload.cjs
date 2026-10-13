'use strict';
// Acceptance-only preload: a CLI command and its workers must never spawn a
// browser, Electron, a shell or any other child executable.
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw Error('Terminal acceptance forbids child executables: ' + name); };
}
