'use strict';
// Focused real-browser acceptance. All databases and network faults are isolated.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const CDP = require('./browser-driver.cjs');
const ROOT = path.resolve(__dirname, '../..'), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-local-first-'));
const dataDir = path.join(folder, 'data'), fixture = path.join(ROOT, 'web', '_codex_local_first_' + process.pid + '.html');
let browser, connection, port;
function lifecycle(action) {
  const result = spawnSync(path.join(ROOT, 'local_start.sh'), [action, '--port', '0', '--bind', '127.0.0.1', '--data-dir', dataDir], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
}
async function api(route, body) {
  const boot = await (await fetch('http://127.0.0.1:'+port+'/__tm_storage__/bootstrap')).json();
  const response = await fetch('http://127.0.0.1:'+port+'/__tm_storage__/'+route,
    {method:'POST',headers:{'Content-Type':'application/json','X-TM-Storage-ID':boot.datasetId},body:JSON.stringify(body)});
  assert(response.ok); return response.json();
}
async function main() {
  fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="play" onclick="window.steps=(window.steps||0)+1">继续游戏</button><script src="/tm-storage.js"></script></body></html>`);
  lifecycle('start'); port = JSON.parse(fs.readFileSync(path.join(dataDir,'server.json'))).port;
  browser = spawn('chromium', ['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+path.join(folder,'profile')], {stdio:['ignore','ignore','pipe']});
  const endpoint = await new Promise((resolve,reject) => {
    let output = ''; const timer = setTimeout(()=>reject(Error('Chromium start timeout')),15000);
    browser.stderr.on('data', chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    browser.on('exit',code=>{clearTimeout(timer);reject(Error('Chromium exited '+code));});
  });
  const socket = new WebSocket(endpoint); await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  connection = new CDP(socket);
  const url = 'http://127.0.0.1:'+port+'/'+path.basename(fixture), first = await connection.page(url);
  const ready = session => connection.ready(session, 'window.TMServerStorage && TMServerStorage.mode==="local-first" && TM_SaveDB.isAvailable()');
  await ready(first);
  assert.equal(await connection.evaluate(first,`!!document.getElementById('tm-server-save-status') && document.querySelector('#tm-server-save-status button').textContent==='保存到服务器'`),true);
  assert.equal(await connection.evaluate(first, `(async()=>{
    const state={GM:{turn:1,history:['before'],text:'中文😀'},P:{conf:{}}};
    const identity={transactionId:'background:worker-fixture'};
    const pending=TM_SaveDB.createCanonicalPayload(state,identity);state.GM.history.push('later');
    const payload=await pending,bytes=new TextEncoder().encode(payload.json);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    return JSON.parse(payload.json).GM.history.length===1 && payload.state===state &&
      payload.checksum===digest && await SaveCompression.decompress(payload.compressed)===payload.json;
  })()`),true);
  console.log('PASS worker canonical preparation freezes input before yielding and preserves exact JSON/checksum/compression');
  assert.equal(await connection.evaluate(first, `(async()=>{
    const supported=SaveCompression.supported,encoder=window.TextEncoder;let pending;
    try{SaveCompression.supported=false;window.TextEncoder=undefined;
      pending=TM_SaveDB.createCanonicalPayload({text:'中文😀'},{transactionId:'background:compatibility-fixture'});
    }finally{SaveCompression.supported=supported;window.TextEncoder=encoder;}
    const p=await pending;let hash=2166136261;
    for(let i=0;i<p.json.length;i++)hash=Math.imul(hash^p.json.charCodeAt(i),16777619);
    return p.compressed===p.json && p.checksum==='fnv1a-'+(hash>>>0).toString(16).padStart(8,'0');
  })()`),true);
  console.log('PASS worker respects the page\'s original compression and checksum fallback choices');
  await connection.evaluate(first, `(async()=>{
    localStorage.setItem('tm_api',JSON.stringify({key:'fixture-only'}));
    await TM_SaveDB.saveProject({scenarios:[{id:'custom-fixture',name:'本机案卷'}],conf:{text:'传输压缩'.repeat(200000)},ai:{}});
    await TM_SaveDB.save('slot_0',{GM:{turn:42},P:{}},{turn:42});
    await TMServerStorage.flush();
  })()`);
  assert.equal((await api('open',{name:'tianming_db'})).version,0);
  assert.deepEqual((await (await fetch('http://127.0.0.1:'+port+'/__tm_storage__/bootstrap')).json()).values,{});
  await connection.send('Page.navigate',{url},first); await ready(first);
  assert.deepEqual(await connection.evaluate(first,`(async()=>[(await TM_SaveDB.load('slot_0')).gameState.GM.turn,(await TM_SaveDB.loadProject()).scenarios[0].name,JSON.parse(localStorage.getItem('tm_api')).key])()`),[42,'本机案卷','fixture-only']);
  console.log('PASS native local persistence survives reload; no automatic server writes');

  await connection.evaluate(first, `window.__realFetch=window.fetch;window.fetch=async()=>{throw new TypeError('fixture offline');};`);
  assert.equal(await connection.evaluate(first, `(async()=>{
    await TM_SaveDB.save('slot_0',{GM:{turn:43},P:{}},{turn:43});
    try{await TMServerStorage.syncToServer();}catch(_){}
    document.getElementById('play').click();
    return (await TM_SaveDB.load('slot_0')).gameState.GM.turn===43 && steps===1 && !document.getElementById('tm-server-storage-error');
  })()`),true);
  console.log('PASS upload failure retains local progress and keeps gameplay usable');
  await connection.evaluate(first, `window.fetch=async function(url,init){
    if(String(url).endsWith('/outcome')&&window.__lost)throw new TypeError('fixture receipt unavailable');
    const response=await __realFetch(url,init);
    if(String(url).endsWith('/commit')&&!window.__lost){window.__lost=true;window.__wireBytes=init.body.size;throw new TypeError('fixture response lost');}
    return response;
  };`);
  await connection.evaluate(first, `(async()=>{try{await TMServerStorage.syncToServer();}catch(_){};await TM_SaveDB.save('slot_0',{GM:{turn:44},P:{}},{turn:44});})()`);
  assert.equal((await api('open',{name:'tianming_db'})).revision,1);
  await connection.send('Page.navigate',{url},first); await ready(first);
  assert.equal(await connection.evaluate(first,`(async()=>{await TMServerStorage.syncToServer();return (await TM_SaveDB.load('slot_0')).gameState.GM.turn;})()`),44);
  assert.equal((await api('open',{name:'tianming_db'})).revision,2);
  assert.equal(await connection.evaluate(first,'TMServerStorage.status().dirty'),false);
  console.log('PASS durable upload receipt recovery after reload preserves newer local changes without duplicate commit');

  const second = await connection.page(url); await ready(second);
  assert.deepEqual(await connection.evaluate(second,`(async()=>[(await TM_SaveDB.load('slot_0')).gameState.GM.turn,JSON.parse(localStorage.getItem('tm_api')).key])()`),[44,'fixture-only']);
  assert.equal(await connection.evaluate(second, `(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('binary-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('rows');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('rows','readwrite');tx.objectStore('rows').put({blob:new Blob(['音频']),vector:new Float32Array([0.25,1.5])},'asset');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    await TMServerStorage.syncToServer();return true;
  })()`),true);
  const third=await connection.page(url);await ready(third);
  assert.equal(await connection.evaluate(third,`(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('binary-fixture');r.onsuccess=()=>resolve(r.result);});const value=await new Promise(resolve=>{const r=db.transaction('rows').objectStore('rows').get('asset');r.onsuccess=()=>resolve(r.result);});db.close();return await value.blob.text()==='音频'&&value.vector instanceof Float32Array&&value.vector[1]===1.5;})()`),true);
  console.log('PASS explicit upload shares progress across browsers and preserves Blob/typed-array records');

  await connection.evaluate(first, `window.GM={sid:'custom-fixture',turn:45};window.P={scenarios:[{id:'custom-fixture',name:'当前案卷'}],conf:{},ai:{key:'primary-fixture',secondary:{key:'secondary-fixture'}}};
    window.requestBackgroundAutosave=async()=>{window.__capture=TM_SaveDB.save('autosave',{GM:structuredClone(GM),P:structuredClone(P)},{turn:GM.turn});return{ok:true};};
    window._tmAwaitBackgroundAutosaves=async()=>{await __capture;return{ok:true};};`);
  // Click the actual UI; capture the current GM through the existing local autosave hook.
  await connection.evaluate(first, `document.querySelector('#tm-server-save-status button').click();`);
  await connection.ready(first,'TMServerStorage.status().lastUpload && !TMServerStorage.status().capturing && !TMServerStorage.status().uploading && !TMServerStorage.status().dirty');
  assert.equal(await connection.evaluate(first,`(async()=>(await TM_SaveDB.load('autosave')).gameState.GM.turn)()`),45);
  assert.equal(await connection.evaluate(first,`(async()=>{const p=await TM_SaveDB.loadProject();return !p.ai.key&&!p.ai.secondary.key&&P.ai.key==='primary-fixture'&&P.ai.secondary.key==='secondary-fixture';})()`),true);
  console.log('PASS save button captures current runtime progress into local autosave before upload');
  assert.equal(await connection.evaluate(first,`(async()=>{const worker=window.Worker;window.Worker=undefined;try{await TMServerStorage.saveLocal();return (await TM_SaveDB.load('autosave')).gameState.GM.turn===45;}finally{window.Worker=worker;}})()`),true);
  console.log('PASS browsers without Worker retain the original local-save fallback');

  assert.equal(await connection.evaluate(first, `(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('legacy-job-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('rows');r.onsuccess=()=>resolve(r.result);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('rows','readwrite');tx.objectStore('rows').put('current-browser-copy','item');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    const boot=await (await fetch('/__tm_storage__/bootstrap')).json();
    const frame=document.createElement('iframe');frame.style.display='none';document.body.appendChild(frame);
    try{
      const raw=frame.contentWindow.indexedDB;
      const queue=await new Promise(resolve=>{const r=raw.open('__tm_local_first__:'+boot.datasetId+':upload-journal');r.onsuccess=()=>resolve(r.result);});
      await new Promise((resolve,reject)=>{const tx=queue.transaction('jobs','readwrite');
        tx.objectStore('jobs').put({name:'legacy-job-fixture',token:'older-generation',body:{id:'legacy-format-job',name:'legacy-job-fixture',revision:0,version:1,
          schema:{rows:{keyPath:null,indexes:{}}},operations:[{type:'put',store:'rows',key:'item',value:'pending-before-worker',indexes:{}}]}});
        tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});queue.close();
    }finally{frame.remove();}
    await TMServerStorage.syncToServer();return true;
  })()`),true);
  assert.equal((await api('open',{name:'legacy-job-fixture'})).revision,2);
  assert.equal((await api('outcome',{id:'legacy-format-job'})).committed,true);
  assert.equal((await api('read',{name:'legacy-job-fixture',store:'rows',revision:2})).rows[0].value,'current-browser-copy');
  console.log('PASS worker recovers old-format pending uploads with their original ids and then preserves newer local content');

  // Changing the world while upload is waiting must remain a pending local change.
  await connection.evaluate(first, `(async()=>{window.__realFetch=window.fetch;window.fetch=async function(url,init){if(String(url).endsWith('/commit'))await new Promise(resolve=>window.__continueUpload=resolve);return __realFetch(url,init);};
    await TM_SaveDB.save('slot_0',{GM:{turn:46},P:{}},{turn:46});window.__upload=TMServerStorage.syncToServer();})()`);
  await connection.ready(first,'!!window.__continueUpload');
  await connection.evaluate(first,`(async()=>{await TM_SaveDB.save('slot_0',{GM:{turn:47},P:{}},{turn:47});window.__continueUpload();await __upload;window.fetch=__realFetch;})()`);
  assert.equal(await connection.evaluate(first,'TMServerStorage.status().dirty'),true);
  console.log('PASS new gameplay changes during background upload stay pending locally');

  const app=await connection.page('http://127.0.0.1:'+port+'/');
  await connection.ready(app,'document.readyState==="complete" && typeof P!=="undefined" && P.scenarios.some(s=>s.id==="custom-fixture") && window.TMServerStorage && TMServerStorage.mode==="local-first"');
  assert.equal(await connection.evaluate(app,`!!document.getElementById('tm-server-save-status') && !document.getElementById('tm-server-storage-error') && window.__tmStartupContract && __tmStartupContract.ok`),true);
  console.log('PASS actual game startup imports server project without overwriting local-first saves');

  const revision=(await api('open',{name:'tianming_db'})).revision;
  await api('commit',{id:'other-page',name:'tianming_db',revision,operations:[]});
  assert.equal(await connection.evaluate(first,`(async()=>{try{await TMServerStorage.syncToServer();}catch(e){if(e.name!=='ServerConflictError')throw e;}document.getElementById('play').click();return (await TM_SaveDB.load('slot_0')).gameState.GM.turn===47&&steps===1&&!document.getElementById('tm-server-storage-error');})()`),true);
  console.log('PASS remote conflicts never overwrite server data or lock the local game');
  console.log('Local-first browser acceptance PASS; isolated evidence:',folder);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
  if(connection)connection.socket.close();if(browser)browser.kill('SIGTERM');
  try{lifecycle('stop');}catch(_){} if(fs.existsSync(fixture))fs.unlinkSync(fixture);
});
