#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { Browser } = require('./terminal/browser.cjs');

const HELP = `天命 · 终端版
用中文指令操作；指令前可加 /。人物对话中，普通文字发给当前人物；
结束对话后，普通文字记为本回合诏令草稿，用「过回合」提交。

  剧本                    列出可用剧本
  开局 编号或名称          开始新局（覆盖终端自动档，手动档保留）
  国情                    查看日期、国库、指标和诏令草稿
  人物 [名字或地点]        查看人物名册，编号与完整名册一致
  召见 人物名或编号        朝堂问对，随后直接输入对话
  密谈 人物名或编号        私下叙谈
  结束对话                结束召见并保存
  下诏 [政|军|外|经|杂] 内容  追加诏令草稿
  草稿 / 清空诏令          查看 / 清空尚未提交的草稿
  奏疏 [编号]             列出奏疏 / 阅读全文
  批复 编号 准奏|驳回|批示 [内容]  暂存批复，过回合生效
  过回合                  推演并显示结果，自动保存
  史记 [回合数]           阅读最近五回合或指定回合
  存档 [1-9] [名称]       保存手动档（默认 1）
  读档 [0-9|autosave]     恢复存档（默认终端自动档 0）
  存档列表                查看现有存档
  导出 文件.json / 导入 文件.json  与游戏 JSON 存档互通
  配置 [API地址 模型]     设置 AI，密钥在终端单独输入
  配置状态                查看地址、模型和密钥是否配置
  提示 / 选择 编号         阅读游戏弹出的提示并选择
  帮助 / 退出             查看帮助 / 保存后退出

启动：npm run cli -- [--scenario 名称或编号] [--data-dir 目录]
可选：--browser 可执行文件、--no-sandbox（受限 Linux 环境）、--check
环境变量：TM_BROWSER、TM_API_URL、TM_API_MODEL、TM_API_KEY
需要 Node.js 22+ 和 Chromium、Chrome 或 Edge；无需打开游戏窗口。`;

const aliases = {
  '帮助': 'help', 'help': 'help', '?': 'help',
  '剧本': 'scenarios', 'scenarios': 'scenarios', '开局': 'start', 'new': 'start',
  '国情': 'status', '状态': 'status', 'status': 'status', '人物': 'people', 'people': 'people',
  '召见': 'summon', 'talk': 'summon', '密谈': 'private', '结束对话': 'leave', '退朝': 'leave', 'leave': 'leave',
  '下诏': 'edict', '诏令': 'edict', 'edict': 'edict', '草稿': 'drafts', '清空诏令': 'clearEdicts',
  '过回合': 'next', '下一回合': 'next', 'next': 'next', '奏疏': 'memorials', '批复': 'reply',
  '史记': 'history', 'history': 'history', '存档': 'save', 'save': 'save', '读档': 'load', 'load': 'load',
  '存档列表': 'saves', 'saves': 'saves', '导出': 'export', 'export': 'export', '导入': 'import', 'import': 'import',
  '配置': 'configure', 'config': 'configure', '配置状态': 'configStatus', '提示': 'prompt', '选择': 'choose',
  '退出': 'quit', 'quit': 'quit', 'exit': 'quit'
};

function parse(line) {
  line = line.trim();
  if (!line) return { action: 'empty' };
  const match = line.match(/^\/?([^\s]+)(?:\s+([\s\S]*))?$/);
  const action = aliases[match[1]], text = (match[2] || '').trim();
  if (!action) {
    if (line.startsWith('/')) throw new Error('未知指令，输入「帮助」查看用法。');
    return { action: 'text', args: { text: line } };
  }
  let args = {};
  switch (action) {
    case 'start': case 'people': case 'summon': case 'private': case 'memorials': args.query = text; break;
    case 'edict': {
      const category = { '政': 'political', '政令': 'political', '军': 'military', '军令': 'military', '外': 'diplomatic', '外交': 'diplomatic', '经': 'economic', '经济': 'economic', '杂': 'other', '其他': 'other' };
      const m = text.match(/^(\S+)\s+([\s\S]+)$/);
      args = m && category[m[1]] ? { category: category[m[1]], text: m[2] } : { category: 'other', text };
      if (!args.text) throw new Error('用法：下诏 [政|军|外|经|杂] 内容'); break;
    }
    case 'save': {
      const m = text.match(/^(\d+)(?:\s+([\s\S]+))?$/);
      if (text && !m) throw new Error('用法：存档 [1-9] [名称]');
      args = { slot: m ? Number(m[1]) : 1, name: m && m[2] || '终端手动存档' };
      if (args.slot < 1 || args.slot > 9) throw new Error('手动存档编号须为 1 到 9。'); break;
    }
    case 'load':
      if (text && !/^[0-9]$|^autosave$|^pre_endturn$/.test(text)) throw new Error('用法：读档 [0-9|autosave|pre_endturn]');
      args.id = !text ? 'slot_0' : /^\d$/.test(text) ? 'slot_' + text : text; break;
    case 'reply': {
      const m = text.match(/^([1-9]\d*)\s+(准奏|驳回|批示)(?:\s+([\s\S]+))?$/);
      if (!m || m[2] === '批示' && !m[3]) throw new Error('用法：批复 编号 准奏|驳回|批示 [内容]');
      args = { index: Number(m[1]), decision: { '准奏': 'approved', '驳回': 'rejected', '批示': 'annotated' }[m[2]], text: m[3] || '' }; break;
    }
    case 'history':
      if (text && !/^[1-9]\d*$/.test(text)) throw new Error('回合数须为正整数。');
      args.turn = text ? Number(text) : undefined; break;
    case 'choose':
      if (!/^[1-9]\d*$/.test(text)) throw new Error('用法：选择 编号（先输入「提示」查看选项）');
      args.index = Number(text); break;
    case 'export': case 'import':
      if (!text) throw new Error('请提供 JSON 文件路径。');
      args.file = text.replace(/^(["'])(.*)\1$/, '$2'); break;
    case 'configure': {
      const fields = text.split(/\s+/).filter(Boolean);
      if (fields.length && fields.length !== 2) throw new Error('用法：配置 [API地址 模型]（密钥单独输入）');
      args = { url: fields[0], model: fields[1] }; break;
    }
  }
  if (['start', 'summon', 'private'].includes(action) && !text) throw new Error('请提供名称或编号。');
  return { action, args };
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
  if (!state.running) { write('尚未开局。输入「剧本」查看剧本，或「读档」恢复终端自动档。'); return; }
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
  if (result.choices.length) write('输入「选择 编号」继续。');
}
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (['--help', '-h'].includes(option)) result.help = true;
    else if (option === '--check') result.check = true;
    else if (option === '--no-sandbox') result.noSandbox = true;
    else if (['--browser', '--data-dir', '--scenario'].includes(option)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(option + ' 缺少参数');
      result[{ '--browser': 'browser', '--data-dir': 'dataDir', '--scenario': 'scenario' }[option]] = value;
    } else throw new Error('未知启动参数：' + option);
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) { write(HELP); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('终端版需要 Node.js 22 或更新版本。');
  const browser = new Browser(opts);
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
      if (!muted && !browser.dialog) write('仍在处理，已等待 ' + Math.floor((Date.now() - started) / 1000) + ' 秒……');
    }, 20000);
    try { return (await browser.call(action, args)).result; }
    finally { clearInterval(progress); }
  }
  async function execute(command) {
    let { action, args } = command;
    if (action === 'empty') return;
    if (action === 'help') { write(HELP); return; }
    if (action === 'text') { const state = await invoke('status'); action = state.target ? 'say' : 'edict'; }
    if (action === 'private') { action = 'summon'; args.private = true; }
    if (action === 'configure') {
      const current = await invoke('configStatus');
      args.url = args.url || process.env.TM_API_URL || await read('API 地址' + (current.url ? '（回车保留 ' + current.url + '）' : '') + '：') || current.url;
      args.model = args.model || process.env.TM_API_MODEL || await read('模型 ID' + (current.model ? '（回车保留 ' + current.model + '）' : '') + '：') || current.model;
      args.key = process.env.TM_API_KEY || await read('API 密钥（输入不回显' + (current.configured ? '，回车保留现有密钥' : '') + '）：', true);
      if (args.key === null) throw new Error('配置输入已结束。');
      if (!args.key && current.configured) delete args.key;
    }
    if (action === 'quit') {
      const state = await invoke('status');
      if (state.running) { await invoke('leave'); write('已保存到终端自动档。下次输入「读档」继续。'); }
      exitSaved = true;
      stopping = true; return;
    }
    if (action === 'export') {
      const file = path.resolve(args.file), text = await invoke('export');
      // Exclusive create protects a pre-existing user save from accidental overwrite.
      await fs.promises.writeFile(file, text + '\n', { flag: 'wx', mode: 0o600 });
      write('已导出：' + file); return;
    }
    if (action === 'import') args = { data: JSON.parse(await fs.promises.readFile(path.resolve(args.file), 'utf8')) };
    if (action === 'drafts') { const state = await invoke('status'); showDrafts(state.drafts); return; }
    if (action === 'next') write('正在推演，完成后会显示回合结果并保存……');
    if (action === 'say') write('正在等待人物回复……');
    const result = await invoke(action, args);
    switch (action) {
      case 'scenarios': result.forEach((row, i) => write((i + 1) + '. ' + row.name + (row.role ? ' · ' + row.role : ''))); break;
      case 'start':
        if (result.pending) showPrompt(result.prompt);
        else { write(result.opening); showStatus(result.status); } break;
      case 'status': showStatus(result); showDrafts(result.drafts); break;
      case 'people':
        result.forEach(row => write(row.index + '. ' + row.name + ' · ' + row.role + ' · ' + row.location + (row.alive ? (row.summonable ? ' · 可召见' : '') : ' · 已故')));
        if (!result.length) write('未找到人物。'); break;
      case 'summon': write(result.target + '：\n' + result.greeting + '\n现在直接输入你要说的话；用「结束对话」结束召见。'); break;
      case 'say': write(result.target + '：\n' + result.text); break;
      case 'leave': write('召见已结束。'); break;
      case 'edict': write('已记入诏令草稿并保存。用「过回合」提交。'); break;
      case 'clearEdicts': write('诏令草稿已清空。'); break;
      case 'next': write(result.report); showStatus(result.status); break;
      case 'memorials':
        if (Array.isArray(result)) { result.forEach(row => write(row.index + '. ' + row.title + ' · ' + row.from + ' · ' + (row.status || '待批'))); if (!result.length) write('暂无奏疏。'); }
        else write(result.title + ' · ' + result.from + '\n' + result.content + (result.reply ? '\n朱批：' + result.reply : '')); break;
      case 'reply': write('已暂存批复，过回合生效。'); break;
      case 'history': result.forEach(row => write('第 ' + row.turn + ' 回合\n' + row.text)); if (!result.length) write('暂无对应史记。'); break;
      case 'saves': result.forEach(row => write(row.id + ' · ' + (row.name || row.type || '') + ' · 第 ' + row.turn + ' 回合 · ' + (row.scenarioName || ''))); if (!result.length) write('暂无存档。'); break;
      case 'save': write('已保存到槽位 ' + result.slot + '，第 ' + result.turn + ' 回合。'); break;
      case 'load': case 'import': showStatus(result); showDrafts(result.drafts); break;
      case 'configure': case 'configStatus': write('API：' + (result.url || '未配置') + '\n模型：' + (result.model || '未配置') + '\n密钥：' + (result.configured ? '已配置' : '未配置')); break;
      case 'prompt': case 'choose': showPrompt(result); break;
    }
  }
  const interrupt = () => {
    if (active) { write('当前操作仍在处理中。完成后输入「退出」保存进度。'); return; }
    stopping = true; if (rl) rl.close();
  };
  try {
    write('天命 · 终端版正在启动……');
    await browser.start();
    if (opts.check) { write('终端引擎就绪，可用剧本：' + (await invoke('scenarios')).length); return; }
    rl = readline.createInterface({ input: process.stdin, output, terminal: !!(process.stdin.isTTY && process.stdout.isTTY) });
    input = rl[Symbol.asyncIterator]();
    rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
    browser.onDialog = async dialog => {
      const reply = await read(safeText(dialog.message) + (dialog.type === 'prompt' ? '\n请输入答复：' : '\n输入 y 确认，其他输入取消：'));
      await browser.answerDialog(dialog.type === 'alert' || dialog.type === 'prompt' && reply !== null || /^y$/i.test(reply || ''), dialog.type === 'prompt' ? reply || '' : undefined);
    };
    if (process.env.TM_API_URL && process.env.TM_API_MODEL && process.env.TM_API_KEY) {
      await invoke('configure', { url: process.env.TM_API_URL, model: process.env.TM_API_MODEL, key: process.env.TM_API_KEY });
      write('已应用环境变量中的 AI 配置。');
    }
    write('输入「帮助」查看指令。「剧本」查看剧本；「读档」继续上次游戏。');
    if (opts.scenario) { active = true; await execute({ action: 'start', args: { query: opts.scenario } }); active = false; }
    while (!stopping) {
      if (process.stdout.isTTY) process.stdout.write('天命> ');
      const next = await input.next(); if (next.done) break;
      active = true;
      try { await execute(parse(next.value)); }
      catch (error) { write('操作未完成：' + error.message); }
      finally { active = false; }
    }
    if (!exitSaved && !browser.closed) {
      const state = await invoke('status');
      if (state.running) await invoke('leave');
    }
  } finally {
    if (rl) rl.close(); process.removeListener('SIGINT', interrupt);
    await browser.close();
  }
}

if (require.main === module) main().catch(error => { write('启动或退出失败：' + error.message); process.exitCode = 1; });
module.exports = { main, parse, safeText, options };
