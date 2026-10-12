'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../tm-save-lifecycle.js'), 'utf8');
const start = source.indexOf('var _autoSaveInFlight=false;'), end = source.indexOf('if(_tmHasNativeFs()){', start);
const capStart = source.indexOf('function _tmHasNativeFs(){'), capEnd = source.indexOf('\n}', capStart) + 2;
assert(start >= 0 && end > start && capStart >= 0 && capEnd > capStart);
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(ipc, bridge) {
  const writes = [], timers = new Map(), warnings = []; let sequence = 0;
  const c = { Date, Promise, JSON, deepClone: clone, tianming: bridge, TM: {platform: {caps: {ipc}}},
    GM: {running:true,sid:'fixture',turn:12,_campaignId:'campaign',_timelineId:'timeline',fullNarrative:'当前游戏正文'},
    P: {conf:{generation:'current'},scenarios:[]}, _tmLoadGen:0,
    _tmStripAiKeyInPlace: value => value, _prepareGMForSave: (GM,P) => ({GM,P}),
    console: {warn: (...args) => warnings.push(args),log(){},error(){}},
    setTimeout(fn,ms) { const id=++sequence;timers.set(id,{fn,ms});return id; }, clearTimeout(id) {timers.delete(id);},
    localStorage: {setItem(){},removeItem(){}},
    TM_SaveDB: {assertWritable(){},async saveManyAtomic(entries,options) {
      assert.equal(options.writeGuard(),true); writes.push(clone(entries));return true;
    }}
  };
  c.window=c;
  c._tmCaptureWorldLease=()=>({gmRef:c.GM,pRef:c.P,campaignId:c.GM._campaignId,sid:c.GM.sid,turn:c.GM.turn,loadGen:0});
  vm.createContext(c);vm.runInContext(source.slice(capStart,capEnd),c);vm.runInContext(source.slice(start,end),c);
  return {c,writes,timers,warnings};
}
async function main() {
  for (const ipc of [false]) {
    const f=fixture(ipc,undefined), before=clone({GM:f.c.GM,P:f.c.P});
    await f.c.requestBackgroundAutosave({reason:'local-first-save',immediate:true});
    const result=await f.c._tmAwaitBackgroundAutosaves();
    assert.equal(result.ok,true);assert.deepEqual(f.writes[0].map(row=>row.id),['autosave','slot_0']);
    assert.deepEqual(f.writes[0][0].gameState,before);assert.deepEqual(clone({GM:f.c.GM,P:f.c.P}),before);
    assert.equal(f.c._autoSaveDeferred,false);assert.equal(f.c._autoSaveFlushTimer,null);
    assert.equal(f.warnings.length,0);
    assert.equal((await f.c._tmRunDesktopAutoSaveTick({force:true})).reason,'browser-storage');
    f.c._autoSaveDeferred=true;
    f.c._autoSaveFlushTimer=f.c.setTimeout(()=>{throw Error('desktop timer must be cancelled');},0);
    assert.equal((await f.c._tmFlushDeferredDesktopAutoSave('legacy-web-flush',{immediate:true})).reason,'browser-storage');
    assert.equal(f.c._autoSaveDeferred,false);assert.equal(f.c._autoSaveFlushTimer,null);
    console.log('PASS real browser background canonical save retains complete GM/P without scheduling desktop IPC');
  }
  const shim={get autoSaveJson(){throw Error('web shim must not be inspected as a desktop transport');}};
  assert.equal((await fixture(false,shim).c._tmRunDesktopAutoSaveTick({force:true})).reason,'browser-storage');
  for (const bridge of [undefined,{isDesktop:true}])
    assert.equal((await fixture(true,bridge).c._tmRunDesktopAutoSaveTick({force:true})).reason,'native-autosave-unavailable');
  console.log('PASS missing/incomplete desktop bridges are skipped without exceptions or native write state');
  for (const text of [true,false]) {
    const sent=[],bridge={isDesktop:true,getAutoSaveSessionToken:()=> 'session',
      autoSave:async data=>{sent.push(data);return{success:true};}};
    if(text)bridge.autoSaveJson=async json=>{sent.push(JSON.parse(json));return{success:true};};
    const f=fixture(true,bridge);f.c._tmAdoptCommittedWorldSnapshot({GM:f.c.GM,P:f.c.P},{transactionId:'committed'});
    assert.equal((await f.c._tmRunDesktopAutoSaveTick({force:true})).ok,true);
    assert.equal(sent.length,1);assert.equal(sent[0].gameState.fullNarrative,'当前游戏正文');
  }
  console.log('PASS real desktop text and legacy autosave transports still receive the committed snapshot');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
