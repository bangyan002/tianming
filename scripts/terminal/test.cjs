'use strict';
// Focused acceptance with the real browser/runtime and a disposable profile.
// Only external AI responses are fixtures; no player keys or saves are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Browser } = require('./browser.cjs');
const { parse, safeText, options } = require('../terminal.cjs');

async function main() {
  assert.deepEqual(parse('下诏 经 清点仓储'), { action: 'edict', args: { category: 'economic', text: '清点仓储' } });
  assert.deepEqual(parse('/召见 王承恩'), { action: 'summon', args: { query: '王承恩' } });
  assert.deepEqual(parse('派人查看灾情'), { action: 'text', args: { text: '派人查看灾情' } });
  assert.equal(parse('存档 9 中文名称').args.slot, 9);
  assert.equal(parse('读档 0').args.id, 'slot_0');
  assert.throws(() => parse('存档 10'), /1 到 9/);
  assert.throws(() => parse('批复 1 批示'), /用法/);
  assert.throws(() => parse('/typo'), /未知指令/);
  assert.throws(() => options(['--unknown']), /未知启动参数/);
  assert.equal(safeText('中文\x1b[31m\x07\n正常'), '中文[31m\n正常');
  console.log('PASS Chinese commands, validation and terminal control sanitization');

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-terminal-test-'));
  let browser, provider, capturedRequest, streamCancelled = false;
  async function call(action, args) { return (await browser.call(action, args)).result; }
  try {
    browser = new Browser({ dataDir: folder, noSandbox: process.argv.includes('--no-sandbox') });
    await browser.start();
    // Deny all external fetches, including incidental runtime background work.
    await browser.evaluate(`window.__terminalOriginalFetch=window.fetch;window.fetch=function(url,opts){if(new URL(url,location.href).origin!==location.origin)return Promise.reject(Error('test-external-network-denied'));return __terminalOriginalFetch.apply(this,arguments);};`);
    const competing = new Browser({ dataDir: folder });
    await assert.rejects(competing.start(), /已有终端游戏/);
    await competing.close();
    assert.equal((await call('scenarios')).length, 3);
    await call('start', { query: '1' });
    assert.equal((await call('status')).turn, 1);
    await assert.rejects(call('next'), /配置/);
    assert.equal((await call('status')).turn, 1);
    console.log('PASS official scenario launch and no-key turn guard');

    for (const category of ['political', 'military', 'diplomatic', 'economic', 'other']) {
      await call('edict', { category, text: category + '：终端试验诏令' });
    }
    await call('edict', { category: 'economic', text: '追加核查仓储' });
    const drafts = (await call('status')).drafts;
    assert(drafts.economic.includes('economic：终端试验诏令\n\n追加核查仓储'));
    await call('save', { slot: 1, name: '终端试验' });
    await call('clearEdicts');
    assert.equal((await call('status')).drafts.economic, '');
    await call('load', { id: 'slot_1' });
    assert.deepEqual((await call('status')).drafts, drafts);
    const input = await browser.evaluate(`(()=>{const d=TMPhase8FormalBridge.drafts.syncFormalEdictDraftsToLegacyInputs();return ['edict-pol','edict-mil','edict-dip','edict-eco','edict-oth'].map(id=>document.getElementById(id).value);})()`);
    assert(input.every(text => text.includes('终端试验诏令')));
    console.log('PASS all five draft categories reach real turn inputs; save/load restores them');

    await call('summon', { query: '王承恩' });
    await assert.rejects(call('say', { text: '如何救济灾民？' }), /配置/);
    const key = 'terminal-test-key-must-not-leak';
    // A provider with no CORS headers. The terminal transport must deliver JSON
    // and streaming chunks unchanged, and cancel upstream on browser abort.
    provider = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      capturedRequest = { method: req.method, authorization: req.headers.authorization, body };
      if (req.url.endsWith('/stream') || req.url.endsWith('/slow')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('first\n');
        const timer = setTimeout(() => res.end('second\n'), req.url.endsWith('/slow') ? 5000 : 250);
        res.on('close', () => { clearTimeout(timer); if (req.url.endsWith('/slow') && !res.writableEnded) streamCancelled = true; });
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, text: '中文回复' })); }
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const api = 'http://127.0.0.1:' + provider.address().port + '/v1';
    await call('configure', { url: api, model: 'fixture-model', key });
    assert.deepEqual(await browser.evaluate(`(async()=>{const r=await __terminalOriginalFetch(${JSON.stringify(api + '/probe')},{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+P.ai.key},body:JSON.stringify({messages:[{role:'user',content:'终端请求'}]})});return r.json();})()`), { ok: true, text: '中文回复' });
    assert.equal(capturedRequest.authorization, 'Bearer ' + key);
    assert.match(capturedRequest.body, /终端请求/);
    assert.deepEqual(await browser.evaluate(`(async()=>{const r=await __terminalOriginalFetch(${JSON.stringify(api + '/stream')}),reader=r.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);let rest='';for(;;){const chunk=await reader.read();if(chunk.done)break;rest+=new TextDecoder().decode(chunk.value);}return [first,rest];})()`), ['first\n', 'second\n']);
    await browser.evaluate(`(async()=>{const controller=new AbortController();const r=await __terminalOriginalFetch(${JSON.stringify(api + '/slow')},{signal:controller.signal});await r.body.getReader().read();controller.abort();})()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(streamCancelled, true);
    console.log('PASS provider transport without CORS, request integrity, streaming and abort');
    await call('configure', { url: 'https://terminal-fixture.invalid/v1', model: 'fixture-model', key });
    await browser.evaluate(`window.__terminalDialogueCalls=[];window.callAIMessagesStream=async function(messages,tokens,opts){__terminalDialogueCalls.push(messages);const text=JSON.stringify({reply:'臣建议先清查仓储，具实奏报。',loyaltyDelta:0,suggestions:[]});if(opts&&opts.onChunk)opts.onChunk(text);return text;};window.callAI=async function(){await new Promise(r=>setTimeout(r,30));return '{"commitments":[],"relays":[]}';};`);
    const reply = await call('say', { text: '如何救济灾民？' });
    assert.equal(reply.target, '王承恩');
    assert.match(reply.text, /清查仓储/);
    assert(await browser.evaluate(`__terminalDialogueCalls.some(messages=>messages.some(m=>m.role==='user'&&m.content.includes('如何救济灾民'))) `));
    await call('leave');
    assert.equal((await call('status')).target, null);
    const exported = await call('export');
    assert.equal(exported.includes(key), false);
    assert.equal(JSON.parse(exported).gameState.turn, 1);
    assert.equal((await call('configStatus')).configured, true);
    console.log('PASS real question/answer flow and key-free export');

    await call('clearEdicts');
    await call('edict', { category: 'other', text: '命王承恩具奏近日见闻。' });
    // Replace only the inference boundary. The real turn transaction, systems,
    // collection, history presentation and canonical IndexedDB save still run.
    await browser.evaluate(`window.__terminalTurnCalls=0;window._endTurn_aiInfer=async function(edicts,xinglu,memRes,oldVars,ctx){
      window.__terminalTurnCalls++;window.__terminalSubmittedEdicts=edicts;
      const result={timeRatio:1,shizhengji:'王承恩已具奏近日见闻。',zhengwen:'有司按诏办理。',turnSummary:'具奏见闻',playerStatus:'办理中',playerInner:'核对奏报。',shiluText:'有司按诏办理。',szjTitle:'具奏见闻',szjSummary:'具奏见闻',hourenXishuo:'',personnelChanges:[],events:[],char_updates:[],office_assignments:[],fiscal_adjustments:[],changes:[],npc_actions:[],edictActions:{appointments:[],dismissals:[],deaths:[],armyBuilds:[],rewards:[],payArrears:[]}};
      if(ctx){ctx.results.sc1=result;ctx.results.aiResult=result;ctx.record=Object.assign(ctx.record||{},result);}return result;};`);
    const next = await call('next');
    assert.equal(next.status.turn, 2);
    assert.match(next.report, /王承恩/);
    assert.equal(await browser.evaluate('__terminalTurnCalls'), 1);
    assert.match(await browser.evaluate('__terminalSubmittedEdicts.other'), /具奏近日见闻/);
    assert.equal((await call('status')).drafts.other, '');
    assert.equal((await call('history')).slice(-1)[0].turn, 1);
    console.log('PASS actual turn transaction advances once, submits drafts and renders history');

    await call('save', { slot: 2, name: '第二回合' });
    await browser.close();
    browser = new Browser({ dataDir: folder, noSandbox: process.argv.includes('--no-sandbox') });
    await browser.start();
    await browser.evaluate(`window.fetch=function(){return Promise.reject(Error('test-external-network-denied'));};`);
    await call('load', { id: 'slot_2' });
    assert.equal((await call('status')).turn, 2);
    assert.equal((await call('configStatus')).configured, true);
    await call('load', { id: 'slot_1' });
    assert.deepEqual((await call('status')).drafts, drafts);
    await call('import', { data: JSON.parse(exported) });
    assert.equal((await call('status')).turn, 1);
    assert.equal((await call('configStatus')).configured, true);
    console.log('PASS process restart preserves slots and API config; JSON import restores game');
  } finally {
    if (browser) await browser.close();
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
