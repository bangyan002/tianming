'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { Runtime } = require('./runtime.cjs');

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-node-commands-'));
  const entry = path.resolve(__dirname, '../terminal.cjs');
  const key = 'isolated-subcommand-fixture-key';
  let provider, runtime;
  async function command(words, extra = {}, status = 0) {
    const child = spawn(process.execPath, [entry, ...words, '--data-dir', folder, '--json'], {
      env: { ...process.env, PATH: '', TM_BROWSER: '/absent-browser', TM_API_KEY: '', TM_API_URL: '', TM_API_MODEL: '',
        NODE_OPTIONS: '--require=' + path.join(__dirname, 'no-process-preload.cjs'), ...extra }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, status, stdout + stderr);
    assert.equal(stdout.includes(key), false);
    return JSON.parse(stdout);
  }
  async function checkpoint() {
    runtime = new Runtime({ dataDir: folder }); await runtime.start(); await runtime.call('restore');
    const state = await runtime.evaluate('({turn:GM.turn,campaign:GM._campaignId,timeline:GM._timelineId,energy:GM._energy,dialogue:GM._wdState && GM._wdState[GM.wenduiTarget]})');
    await runtime.close(); runtime = undefined; return state;
  }
  async function interactive(lines) {
    const child = spawn(process.execPath, [entry, 'interactive', '--data-dir', folder], {
      env: { ...process.env, PATH: '', TM_API_KEY: '', TM_API_URL: '', TM_API_MODEL: '', NODE_OPTIONS: '--require=' + path.join(__dirname, 'no-process-preload.cjs') }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(lines.join('\n') + '\n');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stdout + stderr); assert.equal(stdout.includes(key), false);
    return stdout;
  }
  try {
    const groups = await command(['list']); assert(groups.some(item => item.group === 'people')); assert(groups.some(item => item.group === 'audience'));
    const help = await command(['help', 'audience']); assert(help.commands.some(item => item.usage === 'audience say "<message>"'));
    assert.deepEqual(await command(['audience', 'help']), help);
    assert.deepEqual(await command(['list', 'audience']), help);
    assert.equal(fs.readdirSync(folder).length, 0, 'Help must work without starting the engine or creating game files.');
    console.log('PASS discoverable command groups and per-group help without engine startup');
    const scripts = await command(['scenario', 'list']); assert.equal(scripts.length, 3);
    assert.equal((await command(['game', 'start', '1'])).status.turn, 1);
    const before = await checkpoint();
    const people = await command(['people', 'list', '王承恩']); assert(people.some(person => person.name === '王承恩'));
    const person = await command(['people', 'show', '王承恩']); assert.equal(person.name, '王承恩'); assert(person.offices.length);
    const offices = await command(['offices', 'list', '王承恩']); assert(offices.some(office => office.holder === '王承恩'));
    const afterQueries = await checkpoint(); assert.equal(afterQueries.turn, before.turn); assert.equal(afterQueries.timeline, before.timeline); assert.equal(afterQueries.energy, before.energy);
    console.log('PASS independent person and office queries; no browsers, shells or turn advancement');

    await command(['audience', 'open', '王承恩']);
    const opened = await checkpoint(); assert.equal(opened.energy, before.energy - 5);
    assert.equal((await command(['audience', 'status'])).target, '王承恩');
    const resumed = await checkpoint(); assert.equal(resumed.energy, opened.energy); assert.equal(resumed.timeline, opened.timeline);
    console.log('PASS independent commands restore the same audience without charging energy again');

    const output = await interactive(['list', 'help audience', 'audience help', 'people show 王承恩', 'offices list 王承恩', 'audience status', '派人查看灾情', 'exit']);
    assert.match(output, /可用命令组/); assert.match(output, /audience say "<message>"/); assert.match(output, /正在召见：王承恩/); assert.match(output, /乾清宫近侍/); assert.match(output, /未知子命令/);
    const afterInteractive = await checkpoint(); assert.equal(afterInteractive.energy, opened.energy); assert.equal(afterInteractive.timeline, opened.timeline);
    assert.equal((await command(['audience', 'status'])).target, '王承恩');
    console.log('PASS interactive English subcommands, live help and exit preserving the current audience');

    let requests = 0;
    provider = http.createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk;
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_window: 1048576 }] })); return; }
      requests++; const body = JSON.parse(text || '{}');
      const content = body.stream ? JSON.stringify({ reply: '臣已核对官位名册，谨候圣谕。', loyaltyDelta: 0, suggestions: [] }) : JSON.stringify({ commitments: [], relays: [] });
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })); }
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const url = 'http://127.0.0.1:' + provider.address().port + '/v1';
    await command(['config', 'set', url, 'fixture-model'], { TM_API_KEY: key });
    const reply = await command(['audience', 'say', '朝中官位如何？']); assert.match(reply.text, /官位名册/); assert(requests > 0);
    const conversation = await command(['audience', 'history']); assert(conversation.messages.some(message => message.role === 'player' && message.content.includes('朝中官位')));
    const afterDialogue = await checkpoint(); assert.equal(afterDialogue.energy, opened.energy); assert.equal(afterDialogue.dialogue.turns, 1);
    await command(['audience', 'close']); assert.equal((await command(['audience', 'status'])).target, null);
    console.log('PASS real streamed AI dialogue and history across separate command processes');

    await command(['edict', 'add', 'economic', '核查仓储，具实奏报。']);
    assert.match((await command(['edict', 'list'])).economic, /核查仓储/);
    await command(['save', 'write', '1', '子命令存档']);
    const file = path.join(folder, 'export.json'); await command(['save', 'export', file]); assert.equal(fs.readFileSync(file, 'utf8').includes(key), false);
    await command(['edict', 'clear']); assert.equal((await command(['edict', 'list'])).economic, '');
    await command(['save', 'load', '1']); assert.match((await command(['edict', 'list'])).economic, /核查仓储/);
    await command(['save', 'import', file]); assert.equal((await command(['config', 'show'])).configured, true);
    assert.match((await command(['people', 'show', '不存在的人'], {}, 1)).error, /未找到/);
    console.log('PASS cross-process drafts, named saves, key-free JSON interchange and failure exit codes');
  } finally {
    if (runtime) await runtime.close();
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
