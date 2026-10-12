'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {fixture,response,agentReply,run}=require('./lib-emergency-recovery');
const tests=[],test=(name,fn)=>tests.push({name,fn});
const body={model:'fixture',messages:[{role:'user',content:'完整原始上下文'}]},url='https://fixture.invalid/v1/chat/completions';
test('SC1 preserves exact parse failure and response after rollback and exports it',async()=>{
 const f=fixture(),c=f.c;try{
  c.P.conf.aiCallRetryOverrides={sc1:0};const raw='{"turn_summary":"原意", "events":[}';
  c.fetch=async()=>response(raw);const data=await c._aiFetchWithRetry(url,body,null,{id:'sc1'});
  c.callAI=async prompt=>{assert(prompt.includes('JSON'));return JSON.stringify({tools:[{name:'finish',input:{needsPlayer:true,reason:'不能补造缺失内容'}}]});};
  const failed=await c.TM.RecoveryRuntime.finalSC1({raw,data,body,validate:()=>false});assert.equal(failed.ok,false);
  c.GM._turnAiResults={subcall1_raw:'旧的成功回合'};
  const report=c.TM.RecoveryRuntime.sc1Failure();assert.equal(report.raw,raw);assert.equal(report.reason,'json-syntax');assert(report.jsonError);assert.equal(report.finishReason,'stop');
  const source=fs.readFileSync(path.join(__dirname,'../tm-ai-infra.js'),'utf8'),start=source.indexOf('function exportAIDiagnosticsJSON()'),end=source.indexOf('\n}',start)+2;
  c.ensureAIDiagnostics=()=>({turn:c.GM.turn});vm.runInContext(source.slice(start,end),c);
  const exported=c.exportAIDiagnosticsJSON();assert.equal(exported.sc1Failure.raw,raw);assert(exported.sc1Failure.jsonError);assert(!JSON.stringify(exported).includes(c.P.ai.key));
  report.raw='consumer rewrite';assert.equal(c.TM.RecoveryRuntime.sc1Failure().raw,raw);
 }finally{f.dispose();}
});
test('valid JSON with incomplete SC1 fields is reported separately from a syntax error',async()=>{
 const f=fixture({mode:'off'}),c=f.c;try{
  const raw='{"turn_summary":"只有摘要"}';await c.TM.RecoveryRuntime.finalSC1({raw,data:{choices:[{finish_reason:'stop'}]},body,validate:()=>false});
  const report=c.TM.RecoveryRuntime.sc1Failure();assert.equal(report.reason,'structured-contract');assert.equal(report.jsonError,'');assert.equal(JSON.stringify(report.parsedKeys),'["turn_summary"]');
 }finally{f.dispose();}
});
test('source validation still reports reserved fields without changing the original content',async()=>{
 const f=fixture({mode:'off'}),c=f.c;try{
  const raw='{"events":[1],"__proto__":{}}';await c.TM.RecoveryRuntime.finalSC1({raw,data:null,body,validate:()=>true});
  const report=c.TM.RecoveryRuntime.sc1Failure();assert.equal(report.reason,'source-validation');assert(report.sourceError.includes('保留字段'));assert.equal(report.raw,raw);
 }finally{f.dispose();}
});
test('recovery receives the exact native parser error and still accepts only verified separator repair',async()=>{
 const f=fixture(),c=f.c;try{
  const raw='{"turn_summary":"完整原意" "events":[1],"player_status":"完整"}',at=raw.indexOf(' "events"');
  const plan={edits:[{start:at,end:at,expected:'',replacement:','}]};c.P.conf.aiCallRetryOverrides={sc1:0};
  c.fetch=async()=>response(raw);const data=await c._aiFetchWithRetry(url,body,null,{id:'sc1'});let nativeError='';try{JSON.parse(raw);}catch(e){nativeError=e.message;}
  c.callAI=async prompt=>{assert(prompt.includes(JSON.stringify(nativeError).slice(1,-1)));return agentReply(prompt,plan);};
  const fixed=await c.TM.RecoveryRuntime.finalSC1({raw,data,body,validate:p=>p.turn_summary==='完整原意'&&p.events[0]===1});assert(fixed.ok);
  assert.equal(fixed.value.raw,raw.slice(0,at)+','+raw.slice(at));assert.equal(c.TM.RecoveryRuntime.sc1Failure().raw,raw);assert.equal(c.TM.RecoveryRuntime.sc1Failure().recovered,true);
 }finally{f.dispose();}
});
run(tests);
