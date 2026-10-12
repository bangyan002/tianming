'use strict';
const assert=require('assert/strict');
const {fixture,response,rawParse,run}=require('./lib-emergency-recovery');
const tests=[],test=(name,fn)=>tests.push({name,fn});
const body={model:'fixture',messages:[{role:'user',content:'原始完整输入'}]},url='https://fixture.invalid/v1/chat/completions';
const first='[{"name":"甲","updates":{"loyalty":-3},"reason":"原样保留\\n因果"}]';
const second='[{"name":"乙","updates":{"stress":2},"reason":"第二段"}]';
const raw=(a,b)=>'{"turn_summary":"完整推演","char_updates":'+a+',"player_status":"待执行","char_updates":'+b+'}';
async function parse(f,text,id='sc1',normal=async text=>rawParse(text)){
 let calls=0;f.c.fetch=async()=>{calls++;return response(text);};
 f.c.callAI=async()=>{throw Error('First-value normalization must not request a recovery model');};
 const data=await f.c._aiFetchWithRetry(url,body,null,{id,maxRetries:2});
 const result=await f.c.TM.RecoveryRuntime.parse(text,data,'推演',{id,body,url,expectedKeys:id==='sc1'?['char_updates','edict_feedback']:['houren_xishuo']},normal);
 return {result,calls};
}
test('SC1 keeps the entire first character array and records later arrays without extra calls or writes',async()=>{
 const f=fixture();try{const before=JSON.stringify(f.c.GM),text=raw(first,second),{result,calls}=await parse(f,text);
  assert.equal(calls,1);assert(result.parsed);assert.equal(result.sourceRaw,text);assert.equal(result.parsed.char_updates.length,1);
  assert.equal(result.parsed.char_updates[0].name,'甲');assert.equal(result.parsed.char_updates[0].updates.loyalty,-3);assert.equal(result.parsed.char_updates[0].reason,'原样保留\n因果');
  const duplicate=result.normalization.duplicateFields[0];assert.equal(duplicate.path,'$.char_updates');assert.equal(duplicate.keptRaw,first);assert.equal(duplicate.ignoredRaw,second);
  assert(f.c.TM.RecoveryAdapters.sourcePreserved(text,result));assert.equal(JSON.stringify(f.c.GM),before);assert.equal(f.events.length,0);
 }finally{f.dispose();}
});
test('the first empty array remains authoritative and identical arrays cannot apply a delta twice',async()=>{
 for(const arrays of [['[]',first],[first,'[]'],[first,first]]){const f=fixture();try{const {result,calls}=await parse(f,raw(...arrays));assert.equal(calls,1);assert.equal(JSON.stringify(result.parsed.char_updates),JSON.stringify(JSON.parse(arrays[0])));assert.equal(result.normalization.identicalArrays,arrays[0]===arrays[1]?1:0);}finally{f.dispose();}}
});
test('the reported efficacy conflict and other nested fields keep first values across three or more occurrences',async()=>{
 const f=fixture();try{const text='{"edict_feedback":[{"efficacy":0.8,"efficacy":0.5,"efficacy":0.2,"result":"第一次","result":"第二次"}],"turn_summary":"完整"}',{result,calls}=await parse(f,text);
  assert.equal(calls,1);assert.equal(result.parsed.edict_feedback[0].efficacy,0.8);assert.equal(result.parsed.edict_feedback[0].result,'第一次');assert.equal(result.normalization.duplicateFields.length,3);
  const report=f.c.TM.RecoveryRuntime.jsonNormalization();assert.equal(report.call,'sc1');assert.equal(report.sourceRaw,text);assert.equal(report.duplicateFields[0].keptRaw,'0.8');assert.equal(report.duplicateFields[0].ignoredRaw,'0.5');report.sourceRaw='consumer rewrite';assert.equal(f.c.TM.RecoveryRuntime.jsonNormalization().sourceRaw,text);
 }finally{f.dispose();}
});
test('the same policy applies to SC2 and remains active when optional model recovery is disabled',async()=>{
 for(const mode of ['auto','off']){const f=fixture({mode});try{const text='{"houren_xishuo":"第一段","houren_xishuo":"第二段","new_activities":[],"new_activities":[{"name":"后面的事项"}]}', {result,calls}=await parse(f,text,'sc2');assert.equal(calls,1);assert.equal(result.parsed.houren_xishuo,'第一段');assert.equal(result.parsed.new_activities.length,0);assert(f.c.TM.RecoveryAdapters.sourcePreserved(text,result));}finally{f.dispose();}}
});
test('object values normalize recursively without overlapping removals, and arrays retain separate objects',()=>{
 const f=fixture();try{const A=f.c.TM.RecoveryAdapters,text='{"entry":{"x":1,"x":2,"rows":[{"x":3,"x":4},{"x":5}]},"entry":{"x":9,"x":10},"tail":true}',folded=A.normalizeJSON(text);assert(folded.changed);const parsed=A.strict(folded.raw);assert.equal(parsed.entry.x,1);assert.equal(parsed.entry.rows.length,2);assert.equal(parsed.entry.rows[0].x,3);assert.equal(parsed.entry.rows[1].x,5);assert.equal(parsed.tail,true);assert.equal(folded.duplicateFields.length,3);
 }finally{f.dispose();}
});
test('null, false, zero, empty strings and decoded key aliases remain valid first values',()=>{
 const f=fixture();try{const A=f.c.TM.RecoveryAdapters;for(const value of ['null','false','0','""']){const folded=A.normalizeJSON('{"x":'+value+',"x":99}');assert(folded.changed);assert.equal(JSON.stringify(A.strict(folded.raw).x),value);}
  const folded=A.normalizeJSON('{"x":1,"\\u0078":2,"x":3}');assert(folded.changed);assert.equal(A.strict(folded.raw).x,1);assert.equal(folded.duplicateFields.length,2);
 }finally{f.dispose();}
});
test('source certificates reject changed first values, missing fields and a forged normalized response',async()=>{
 const f=fixture();try{const text=raw(first,second),{result}=await parse(f,text),A=f.c.TM.RecoveryAdapters;
  for(const edit of [r=>{r.parsed.char_updates.pop();},r=>{r.parsed.char_updates[0].updates.loyalty=99;},r=>{r.raw='{"char_updates":[]}';}]){const changed=JSON.parse(JSON.stringify(result));edit(changed);assert.equal(A.sourcePreserved(text,changed),false);}
 }finally{f.dispose();}
});
test('complete legacy table sidecars and fenced JSON remain intact',async()=>{
 const f=fixture();try{const sidecar='\n<tableEdit><!-- updateRow(0, 0, {"1":"原文"}) --></tableEdit>',text='```json\n'+raw(first,second)+'\n```'+sidecar;
  const {result,calls}=await parse(f,text,'sc1',async text=>({raw:text,parsed:JSON.parse(text.split('\n')[1]),truncated:false,repaired:false}));assert.equal(calls,1);assert(result.parsed);assert(result.raw.endsWith(sidecar));assert.equal(result.parsed.char_updates.length,1);
 }finally{f.dispose();}
});
test('normalization preserves unique literal bytes and rejects broken syntax, unsafe retained numbers and reserved keys',()=>{
 const f=fixture();try{const A=f.c.TM.RecoveryAdapters,unique='{"char_updates":'+first+',"amount":1.00,"zero":-0}';assert.equal(A.normalizeJSON(unique).changed,false);
  const folded=A.normalizeJSON('{"amount":1.00,"amount":2,"zero":-0,"keep":"原文"}');assert(folded.changed);assert(folded.raw.includes('"amount":1.00'));assert(folded.raw.includes('"zero":-0'));assert(folded.raw.includes('"keep":"原文"'));
  for(const text of ['{"x":1,"x":2} {"other":3}','{"x":1,"x":','{"x":9007199254740992,"x":1}','{"__proto__":{},"x":1,"x":2}'])assert.equal(A.normalizeJSON(text).changed,false,text);
  assert.throws(()=>A.strict('{"x":1,"x":2}'));
 }finally{f.dispose();}
});
test('final emergency entry can return a validated first-value result without spending model calls',async()=>{
 const f=fixture();try{const text='{"edict_feedback":[{"efficacy":0.8,"efficacy":0.5}],"turn_summary":"完整"}';f.c.P.conf.aiCallRetryOverrides={sc1:0};f.c.fetch=async()=>response(text);const data=await f.c._aiFetchWithRetry(url,body,null,{id:'sc1'});f.c.callAI=async()=>{throw Error('No emergency call is needed');};
  const result=await f.c.TM.RecoveryRuntime.finalSC1({raw:text,data,body,validate:p=>p.edict_feedback[0].efficacy===0.8});assert(result.ok);assert.equal(result.receipt.calls,0);assert.equal(result.receipt.applied,false);assert.equal(result.value.parsed.edict_feedback[0].efficacy,0.8);assert.equal(f.events.length,0);
 }finally{f.dispose();}
});
run(tests);
