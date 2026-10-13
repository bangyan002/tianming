#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { Runtime } = require('./terminal/runtime.cjs');
const { parseCommand, getCatalog, tokenize, complete } = require('./terminal/commands.cjs');

function parse(line) {
  const words = tokenize(line);
  return words.length ? parseCommand(words) : { action: 'empty' };
}

function showHelp(command, json = false) {
  const group = command.args && command.args.group;
  const compact = command.action === 'catalog' && !group;
  const catalog = getCatalog(group, compact);
  if (json) { write(JSON.stringify(catalog)); return; }
  if (compact) {
    write('可用命令组：');
    catalog.forEach(item => write('  ' + item.group.padEnd(12) + item.description));
  } else {
    const entries = group ? [catalog] : catalog;
    write(group ? catalog.group + ' · ' + catalog.description : '天命 · Node 终端版');
    entries.forEach(item => {
      if (!group) write('\n' + item.group + ' · ' + item.description);
      item.commands.forEach(command => write('  ' + command.usage + '\n    ' + command.description));
    });
  }
  write('\nlist：列出命令组；help <group> / <group> help：查看子命令。');
  write('interactive：连续交互会话；exit / quit：保存后退出。交互会话支持 Tab 补全。');
  if (!group && !compact) {
    write('\n例：tianming people show 王承恩（安装命令：npm run install:cli）');
    write('全局参数：--data-dir <目录>、--json、--check、--scenario <剧本>（交互开局）');
    write('环境变量：TM_API_URL、TM_API_MODEL、TM_API_KEY');
    write('需要 Node.js 22+；首次运行 npm run setup:cli 安装终端依赖。');
  }
}

function safeText(value) {
  // Game/AI text must not control the terminal through escape sequences.
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
function write(value) { process.stdout.write(safeText(value) + '\n'); }
function showDrafts(drafts) {
  const names = { political: '政令', military: '军令', diplomatic: '外交', economic: '经济', other: '其他', xingluPub: '行录' };
  const rows = Object.keys(names).filter(key => drafts && drafts[key]);
  if (!rows.length) write('尚无诏令草稿。');
  for (const key of rows) write(names[key] + '：\n' + drafts[key]);
}
function showStatus(state) {
  if (!state.running) { write('尚未开局。输入 scenario list 查看剧本，game start <scenario> 开局，或 save load 恢复存档。'); return; }
  write(state.scenario + '\n第 ' + state.turn + ' 回合 · ' + state.date + '\n' + state.player + ' · ' + state.faction);
  const names = { money: '库银', grain: '粮食', soldiers: '兵员', manpower: '人力' };
  const treasury = Object.keys(names).filter(key => state.treasury[key] !== undefined).map(key => names[key] + ' ' + state.treasury[key]);
  if (treasury.length) write('国库：' + treasury.join(' · '));
  if (state.variables.length) write(state.variables.map(row => row.name + ' ' + row.value + row.unit).join(' · '));
  if (state.target) write('正在与 ' + state.target + ' 对话。');
}
function showPrompt(result) {
  if (!result.text) { write('当前没有游戏提示。'); return; }
  write(result.text);
  result.choices.forEach((label, i) => write((i + 1) + '. ' + label));
  if (result.choices.length) write('输入 prompt choose <number> 继续。');
}
function showPerson(result) {
  write(result.name + ' · ' + result.role + '\n势力：' + result.faction + ' · 派系：' + (result.party || '无') + '\n所在地：' + result.location + ' · ' + (result.alive ? '在世' : '已故'));
  const labels = { age: '年龄', loyalty: '忠诚', health: '健康', intelligence: '才智', administration: '行政', politics: '政治', military: '军事' };
  write(Object.keys(labels).filter(key => result[key] !== undefined).map(key => labels[key] + ' ' + result[key]).join(' · '));
  if (result.personality) write('性情：' + result.personality);
  if (result.offices.length) showOffices(result.offices); else write('现任官位：官制名册中未列任职。');
  write(result.summonable ? '当前可召见。' : '当前不能直接召见，可查看所在地及人物状态。');
}
function showOffices(rows) {
  if (!rows.length) { write('未找到对应官位。'); return; }
  rows.forEach(row => write(row.index + '. ' + row.department + ' / ' + row.name + ' · ' + row.rank + ' · ' + (row.holder || '空缺') + (row.function ? '\n   职掌：' + row.function : '')));
}
function options(argv) {
  const result = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (['--help', '-h'].includes(option)) result.help = true;
    else if (option === '--check') result.check = true;
    else if (option === '--json') result.json = true;
    else if (option === '--') { result.words.push(...argv.slice(i + 1)); break; }
    else if (['--data-dir', '--scenario'].includes(option)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(option + ' 缺少参数');
      result[{ '--data-dir': 'dataDir', '--scenario': 'scenario' }[option]] = value;
    } else if (option === '--private' && result.words.length) result.words.push(option);
    else if (option.startsWith('-')) throw new Error('未知启动参数：' + option);
    else result.words.push(option);
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  const command = opts.help ? parseCommand(['help', ...opts.words.slice(0, 1)]) : opts.words.length ? parseCommand(opts.words) : opts.check || opts.scenario ? { interactive: true } : { action: 'help', args: {} };
  if (['help', 'catalog'].includes(command.action)) { showHelp(command, opts.json); return; }
  if (opts.scenario && !command.interactive) throw Error('--scenario 仅用于 interactive；独立开局使用 game start <scenario>。');
  const single = !command.interactive;
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('终端版需要 Node.js 22 或更新版本。');
  const runtime = new Runtime(opts);
  let muted = false, rl, input, active = false, stopping = false, exitSaved = false;
  const output = new Writable({ write(chunk, encoding, next) { if (!muted) process.stdout.write(chunk); next(); } });
  async function read(label, secret = false) {
    write(label); muted = secret;
    try { const line = await input.next(); return line.done ? null : line.value; }
    finally { muted = false; if (secret) { if (rl) rl.history = []; write(''); } }
  }
  async function invoke(action, args = {}) {
    const started = Date.now();
    const progress = setInterval(() => {
      if (!opts.json && !muted && !runtime.dialog) write('仍在处理，已等待 ' + Math.floor((Date.now() - started) / 1000) + ' 秒……');
    }, 20000);
    try { return (await runtime.call(action, args)).result; }
    finally { clearInterval(progress); }
  }
  async function execute(command) {
    let { action, args } = command;
    if (action === 'empty') return;
    if (['help', 'catalog'].includes(action)) { showHelp(command, opts.json); return; }
    if (command.interactive) throw Error('当前已在交互会话中。输入 list 查看命令组。');
    if (action === 'configure') {
      const current = await invoke('configStatus');
      if (opts.json && (!(args.url || process.env.TM_API_URL || current.url) || !(args.model || process.env.TM_API_MODEL || current.model) || !(process.env.TM_API_KEY || current.configured))) throw Error('JSON 模式请提供地址、模型，并用 TM_API_KEY 提供密钥。');
      if (opts.json) { args.url = args.url || process.env.TM_API_URL || current.url; args.model = args.model || process.env.TM_API_MODEL || current.model; }
      args.url = args.url || process.env.TM_API_URL || await read('API 地址' + (current.url ? '（回车保留 ' + current.url + '）' : '') + '：') || current.url;
      args.model = args.model || process.env.TM_API_MODEL || await read('模型 ID' + (current.model ? '（回车保留 ' + current.model + '）' : '') + '：') || current.model;
      args.key = process.env.TM_API_KEY || (opts.json && current.configured ? '' : await read('API 密钥（输入不回显' + (current.configured ? '，回车保留现有密钥' : '') + '）：', true));
      if (args.key === null) throw new Error('配置输入已结束。');
      if (!args.key && current.configured) delete args.key;
    }
    if (action === 'quit') {
      const state = await invoke('status');
      if (state.running) await invoke('save', { slot: 0, name: '终端自动存档' });
      write(opts.json ? JSON.stringify({ saved: state.running }) : state.running ? '已保存。下次启动会自动继续当前游戏及召见。' : '已退出。');
      exitSaved = true;
      stopping = true; return;
    }
    if (action === 'export') {
      const file = path.resolve(args.file), text = await invoke('export');
      // Exclusive create protects a pre-existing user save from accidental overwrite.
      await fs.promises.writeFile(file, text + '\n', { flag: 'wx', mode: 0o600 });
      write(opts.json ? JSON.stringify({ file }) : '已导出：' + file); return;
    }
    if (action === 'import') args = { data: JSON.parse(await fs.promises.readFile(path.resolve(args.file), 'utf8')) };
    if (action === 'drafts') { const state = await invoke('status'); if (opts.json) write(JSON.stringify(state.drafts)); else showDrafts(state.drafts); return; }
    if (!opts.json && action === 'next') write('正在推演，完成后会显示回合结果并保存……');
    if (!opts.json && action === 'say') write('正在等待人物回复……');
    const result = await invoke(action, args);
    if (opts.json) { write(JSON.stringify(result)); return; }
    switch (action) {
      case 'scenarios': result.forEach((row, i) => write((i + 1) + '. ' + row.name + (row.role ? ' · ' + row.role : ''))); break;
      case 'start':
        if (result.pending) showPrompt(result.prompt);
        else { write(result.opening); showStatus(result.status); } break;
      case 'status': showStatus(result); showDrafts(result.drafts); break;
      case 'people':
        result.forEach(row => write(row.index + '. ' + row.name + ' · ' + row.role + ' · ' + row.location + (row.alive ? (row.summonable ? ' · 可召见' : '') : ' · 已故')));
        if (!result.length) write('未找到人物。'); break;
      case 'person': showPerson(result); break;
      case 'offices': showOffices(result); break;
      case 'office': showOffices([result]); break;
      case 'audienceStatus': write(result.target ? '正在召见：' + result.target + ' · ' + (result.mode === 'private' ? '私下叙谈' : '朝堂问对') : '当前没有召见人物。'); break;
      case 'audienceHistory': write('与 ' + result.target + ' 的对话：'); result.messages.forEach(row => write((row.role === 'player' ? '你' : row.role === 'npc' ? result.target : '记录') + '：' + row.content)); break;
      case 'summon': write(result.target + '：\n' + result.greeting + '\n用 audience say "内容" 对话，audience close 结束召见。'); break;
      case 'say': write(result.target + '：\n' + result.text); break;
      case 'leave': write('召见已结束。'); break;
      case 'edict': write('已记入诏令草稿并保存。用 turn next 提交。'); break;
      case 'clearEdicts': write('诏令草稿已清空。'); break;
      case 'next': write(result.report); showStatus(result.status); break;
      case 'memorials':
        if (Array.isArray(result)) { result.forEach(row => write(row.index + '. ' + row.title + ' · ' + row.from + ' · ' + (row.status || '待批'))); if (!result.length) write('暂无奏疏。'); }
        else write(result.title + ' · ' + result.from + '\n' + result.content + (result.reply ? '\n朱批：' + result.reply : '')); break;
      case 'reply': write('已暂存批复，turn next 时生效。'); break;
      case 'history': result.forEach(row => write('第 ' + row.turn + ' 回合\n' + row.text)); if (!result.length) write('暂无对应史记。'); break;
      case 'saves': result.forEach(row => write(row.id + ' · ' + (row.name || row.type || '') + ' · 第 ' + row.turn + ' 回合 · ' + (row.scenarioName || ''))); if (!result.length) write('暂无存档。'); break;
      case 'save': write('已保存到槽位 ' + result.slot + '，第 ' + result.turn + ' 回合。'); break;
      case 'load': case 'import': showStatus(result); showDrafts(result.drafts); break;
      case 'configure': case 'configStatus': write('API：' + (result.url || '未配置') + '\n模型：' + (result.model || '未配置') + '\n密钥：' + (result.configured ? '已配置' : '未配置')); break;
      case 'prompt': case 'choose': showPrompt(result); break;
    }
  }
  const interrupt = () => {
    if (active) { write('当前操作仍在处理中。完成后输入 exit 保存进度。'); return; }
    stopping = true; if (rl) rl.close();
  };
  try {
    if (!single && !opts.json) write('天命 · Node 终端版正在启动……');
    await runtime.start();
    if (opts.check) { const count = (await invoke('scenarios')).length; write(opts.json ? JSON.stringify({ ready: true, scenarios: count, runtime: 'node' }) : 'Node 终端引擎就绪，可用剧本：' + count); return; }
    rl = readline.createInterface({ input: process.stdin, output, completer: complete, terminal: !!(process.stdin.isTTY && process.stdout.isTTY) });
    rl.setPrompt('天命> ');
    input = rl[Symbol.asyncIterator]();
    rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
    runtime.onDialog = async dialog => {
      if (dialog.type === 'alert') { if (!opts.json) write(dialog.message); runtime.answerDialog(true); return; }
      if (opts.json) { runtime.answerDialog(false); return; }
      const reply = await read(safeText(dialog.message) + (dialog.type === 'prompt' ? '\n请输入答复：' : '\n输入 y 确认，其他输入取消：'));
      runtime.answerDialog(dialog.type === 'prompt' && reply !== null || /^(y|yes|是|确认)$/i.test(reply || ''), dialog.type === 'prompt' ? reply || '' : undefined);
    };
    if (process.env.TM_API_URL && process.env.TM_API_MODEL && process.env.TM_API_KEY) {
      await invoke('configure', { url: process.env.TM_API_URL, model: process.env.TM_API_MODEL, key: process.env.TM_API_KEY });
      if (!single && !opts.json) write('已应用环境变量中的 AI 配置。');
    }
    if (!single || !['start', 'scenarios', 'configure', 'configStatus'].includes(command.action)) await invoke('restore');
    if (single) { active = true; await execute(command); active = false; return; }
    write('输入 list 查看命令组，help <group> 查看子命令；按 Tab 补全。');
    write('scenario list 查看剧本，game start <scenario> 开局。已有游戏会自动恢复。');
    if (opts.scenario) { active = true; await execute({ action: 'start', args: { query: opts.scenario } }); active = false; }
    while (!stopping) {
      if (process.stdout.isTTY) rl.prompt();
      const next = await input.next(); if (next.done) break;
      active = true;
      try { await execute(parse(next.value)); }
      catch (error) { write('操作未完成：' + error.message); }
      finally { active = false; }
    }
    if (!exitSaved && !runtime.closed) {
      const state = await invoke('status');
      if (state.running) await invoke('save', { slot: 0, name: '终端自动存档' });
    }
  } finally {
    if (rl) rl.close(); process.removeListener('SIGINT', interrupt);
    await runtime.close();
  }
}

function run(argv = process.argv.slice(2)) {
  return main(argv).catch(error => { write(argv.includes('--json') ? JSON.stringify({ error: error.message, code: error.code }) : '操作未完成：' + error.message); process.exitCode = 1; });
}
if (require.main === module) run();
module.exports = { main, run, parse, safeText, options };
