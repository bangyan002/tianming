'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { install } = require('./install.cjs');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-command-install-'));
const binDir = path.join(folder, '命令 空间'), cwd = path.join(folder, '另一个目录');
const dataDir = path.join(folder, '临时存档');
fs.mkdirSync(cwd);
function command(words, status = 0, input) {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? process.execPath : 'tianming', windows ? [path.join(binDir, 'tianming-terminal.cjs'), ...words] : words, {
    cwd, input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH, TM_API_KEY: '', TM_API_URL: '', TM_API_MODEL: '', NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'no-process-preload.cjs')) }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout;
}
try {
  const installed = install({ binDir });
  install({ binDir }); // Reinstalling must keep the same working command.
  assert(JSON.parse(command(['list', '--json'])).some(item => item.group === 'people'));
  assert.equal(JSON.parse(command(['help', 'audience', '--json'])).group, 'audience');
  assert.match(JSON.parse(command(['unknown-command', '--json'], 1)).error, /未知子命令/);
  console.log('PASS installed command works outside the repository with Chinese and spaces in the bin path; errors retain exit codes');

  const ready = JSON.parse(command(['--check', '--data-dir', dataDir, '--json']));
  assert.equal(ready.runtime, 'node'); assert(ready.scenarios > 0);
  const output = command(['interactive', '--data-dir', dataDir], 0, 'list\nhelp audience\nexit\n');
  assert.match(output, /可用命令组/); assert.match(output, /audience say/); assert.match(output, /已退出/);
  console.log('PASS installed command boots the real Node engine and preserves interactive stdin without child executables');

  install({ binDir, uninstall: true });
  assert.equal(fs.existsSync(installed.command), false);
  fs.writeFileSync(installed.command, 'existing personal command');
  assert.throws(() => install({ binDir }), /已保留原文件/);
  assert.throws(() => install({ binDir, uninstall: true }), /已保留原文件/);
  assert.equal(fs.readFileSync(installed.command, 'utf8'), 'existing personal command');
  if (process.platform !== 'win32') {
    fs.unlinkSync(installed.command);
    fs.symlinkSync(path.join(folder, 'missing-personal-command'), installed.command);
    assert.throws(() => install({ binDir }), /已保留原文件/);
    assert(fs.lstatSync(installed.command).isSymbolicLink());
  }
  console.log('PASS uninstall removes only our command; existing files and broken foreign links remain untouched');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
