'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function defaultBinDir() {
  return process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.local', 'bin');
}
function install({ binDir = defaultBinDir(), uninstall = false, entry = path.resolve(__dirname, '../terminal.cjs') } = {}) {
  binDir = path.resolve(binDir); entry = fs.realpathSync(entry);
  const windows = process.platform === 'win32';
  // Keep the batch file ASCII even when the checkout path contains Chinese.
  const literal = JSON.stringify(entry).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const plan = windows ? [
    { name: 'tianming-terminal.cjs', contents: '// Managed by Tianming terminal installer.\nrequire(' + literal + ').run();\n' },
    { name: 'tianming.cmd', contents: '@echo off\r\nnode "%~dp0tianming-terminal.cjs" %*\r\n' }
  ] : [{ name: 'tianming', link: entry }];
  if (!uninstall) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('终端版需要 Node.js 22 或更新版本。');
    try { require.resolve('jsdom'); require.resolve('fake-indexeddb'); }
    catch (_) { throw Error('请先运行 npm run setup:cli 安装终端依赖。'); }
  }
  // Inspect every destination before changing anything; never replace another
  // application's command or follow a foreign/broken link to write a file.
  for (const item of plan) {
    item.file = path.join(binDir, item.name);
    const stat = fs.lstatSync(item.file, { throwIfNoEntry: false });
    if (!stat) continue;
    const owned = item.link ? stat.isSymbolicLink() && path.resolve(binDir, fs.readlinkSync(item.file)) === entry : stat.isFile() && fs.readFileSync(item.file, 'utf8') === item.contents;
    if (!owned) throw Error('已有其他文件占用命令位置，已保留原文件：' + item.file);
    item.exists = true;
  }
  if (uninstall) {
    for (const item of plan) if (item.exists) fs.unlinkSync(item.file);
  } else {
    fs.mkdirSync(binDir, { recursive: true });
    if (!windows) fs.chmodSync(entry, fs.statSync(entry).mode | 0o111);
    for (const item of plan) if (!item.exists) {
      if (item.link) fs.symlinkSync(item.link, item.file);
      else fs.writeFileSync(item.file, item.contents, { flag: 'wx', mode: 0o755 });
    }
  }
  const normalize = value => { const resolved = path.resolve(value); return windows ? resolved.toLowerCase() : resolved; };
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).some(value => normalize(value) === normalize(binDir));
  return { command: path.join(binDir, windows ? 'tianming.cmd' : 'tianming'), binDir, onPath, uninstall };
}
function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--uninstall') options.uninstall = true;
    else if (argv[i] === '--bin-dir') { const value = argv[++i]; if (!value || value.startsWith('--')) throw Error('--bin-dir 缺少目录。'); options.binDir = value; }
    else if (['--help', '-h'].includes(argv[i])) { console.log('npm run install:cli -- [--bin-dir <目录>]\nnpm run uninstall:cli -- [--bin-dir <目录>]'); return; }
    else throw Error('未知安装参数：' + argv[i]);
  }
  const result = install(options);
  console.log((result.uninstall ? '已卸载：' : '已安装：') + result.command);
  if (!result.uninstall) {
    if (!result.onPath) console.log('请将此目录加入 PATH：' + result.binDir);
    console.log('使用：tianming interactive；tianming list；tianming help audience');
  }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error('命令安装未完成：' + error.message); process.exitCode = 1; }
}
module.exports = { install, defaultBinDir };
