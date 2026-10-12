'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {fixture,response,isEmergency,agentReply,rawParse,run}=require('./lib-emergency-recovery');
const {functionSource}=require('./lib-perf-round1');
const tests=[],test=(name,fn)=>tests.push({name,fn});
const body={model:'fixture',messages:[{role:'user',content:'原始完整推演，不得改变结果'}]},url='https://fixture.invalid/v1';
function parser(c){
 const source=fs.readFileSync(path.join(__dirname,'../tm-endturn-ai.js'),'utf8');
 const names=['_hasExpectedJsonKey','_normalizeParsedJsonForExpected','_jsonFinishReason','_looksJsonUnclosed','_parseOrRepairJsonResultNormal','_parseOrRepairJsonResult'];
 vm.runInContext(names.map(name=>functionSource(source,name)).join('\n'),c);
 const utils=fs.readFileSync(path.join(__dirname,'../tm-utils.js'),'utf8');
 vm.runInContext(functionSource(utils,'extractJSON'),c);
}
const sc1d='{"shilu_text":"实录原文🙂，引号内的 } 与 [括号] 必须保留"},"shizhengji":"中段时政，不得丢失","szj_title":"秋日纪事","basis_refs":[{"id":"edict-1","quote":"原诏的逐字片段"}],"szj_summary":"保留摘要"}';
const extra=sc1d.indexOf('},"shizhengji"');
const bracePlan={edits:[{start:extra,end:extra+1,expected:'}',replacement:''}]};
test('SC1d can obtain a real preview and finish after deleting only the premature root closer',async()=>{
 const f=fixture(),c=f.c,order=[];try{
  c.P.conf.aiCallRetryOverrides={sc1d:0};c.fetch=async(_url,o)=>{const b=JSON.parse(o.body);if(isEmergency(b)){order.push('agent');return response(agentReply(b.messages[0].content,bracePlan));}order.push('normal');return response(sc1d);};
  const before=JSON.stringify(c.GM),data=await c._aiFetchWithRetry(url,body,null,{id:'sc1d'});
  const out=await c.TM.RecoveryRuntime.parse(sc1d,data,'实录',{id:'sc1d',url,body,expectedKeys:['shilu_text','shizhengji'],repair:false},async text=>rawParse(text));
  assert(out.emergencyReceipt.verified);assert.equal(out.emergencyReceipt.applied,false);
  assert.equal(out.raw,sc1d.slice(0,extra)+sc1d.slice(extra+1));
  assert.equal(out.parsed.shilu_text,'实录原文🙂，引号内的 } 与 [括号] 必须保留');
  assert.equal(out.parsed.shizhengji,'中段时政，不得丢失');assert.equal(out.parsed.basis_refs[0].id,'edict-1');assert.equal(out.parsed.szj_summary,'保留摘要');
  assert.equal(order.indexOf('agent'),1);assert(c.TM.RecoveryAdapters.sourcePreserved(sc1d,out));assert.equal(JSON.stringify(c.GM),before);
 }finally{f.dispose();}
});
test('the source certificate accepts a lossless ordinary repair of the same root closer',()=>{
 const f=fixture();try{const raw=f.c.TM.RecoveryAdapters.edited(sc1d,bracePlan.edits,true);assert(f.c.TM.RecoveryAdapters.sourcePreserved(sc1d,{raw,parsed:JSON.parse(raw),repaired:true}));}finally{f.dispose();}
});
test('root repair never merges separate documents or moves nested fields to another owner',()=>{
 const f=fixture(),A=f.c.TM.RecoveryAdapters;try{
  const two='{"events":[]} {"amount":900}';
  const between=two.indexOf('} {');
  assert.throws(()=>A.edited(two,[{start:between,end:between+3,expected:'} {',replacement:','}],true));
  const nested='{"entry":{"x":1},"y":2}';
  const close=nested.indexOf('},\"y\"'),end=nested.lastIndexOf('}');
  assert.throws(()=>A.edited(nested,[{start:close,end:close+1,expected:'}',replacement:''},{start:end,end:end,expected:'',replacement:'}'}],true));
  assert.equal(A.sourcePreserved(nested,{parsed:{entry:{x:1,y:2}},raw:'{"entry":{"x":1,"y":2}}',repaired:true}),false);
 }finally{f.dispose();}
});
test('tool arguments keep the existing separator-only contract',()=>{
 const f=fixture();try{assert.throws(()=>f.c.TM.RecoveryAdapters.edited(sc1d,bracePlan.edits));}finally{f.dispose();}
});
test('a missing tail, changed scalar and lost middle field cannot get a root-repair certificate',()=>{
 const f=fixture(),A=f.c.TM.RecoveryAdapters;try{
  assert.throws(()=>A.edited(sc1d.slice(0,-1),bracePlan.edits,true));
  const amount='{"amount":100},"events":[]}';
  assert.throws(()=>A.edited(amount,[{start:10,end:13,expected:'100',replacement:'200'},{start:13,end:14,expected:'}',replacement:''}],true));
  const shortened='{"shilu_text":"实录原文🙂，引号内的 } 与 [括号] 必须保留","szj_summary":"保留摘要"}';
  assert.equal(A.sourcePreserved(sc1d,{raw:shortened,parsed:JSON.parse(shortened),repaired:true}),false);
 }finally{f.dispose();}
});
test('SC2 valid canonical fields pass the actual parser even when expected keys use older aliases',async()=>{
 const f=fixture(),c=f.c;try{
  parser(c);let sent=0;const raw='{"houren_xishuo":"后人戏说，全文原样保留🙂","new_activities":[{"name":"保留事项"}]}';
  c.fetch=async()=>{sent++;return response(raw);};c.callAI=async()=>{throw Error('valid narrative must not start emergency recovery');};
  const data=await c._aiFetchWithRetry(url,body,null,{id:'sc2'});
  const out=await c._parseOrRepairJsonResult(raw,data,'后人戏说',{id:'sc2',url,body,expectedKeys:['hourenXishuo','houren','zhengwen']});
  assert(out.parsed);assert.equal(out.raw,raw);assert.equal(out.parsed.zhengwen,'后人戏说，全文原样保留🙂');assert.equal(out.parsed.new_activities[0].name,'保留事项');assert.equal(sent,1);assert.equal(f.events.length,0);
 }finally{f.dispose();}
});
test('SC2 emergency boundary uses the original alias normalizer without fabricating source fields or spending model calls',async()=>{
 const f=fixture(),c=f.c;try{
  parser(c);c.extractJSON=()=>null;c.P.conf.aiCallRetryOverrides={sc2:0};let sent=0;
  const raw='{"houren_xishuo":"完整的原叙事","new_activities":[]}';c.fetch=async()=>{sent++;return response(raw);};
  c.callAI=async()=>{throw Error('deterministic alias normalization needs no recovery model');};
  const data=await c._aiFetchWithRetry(url,body,null,{id:'sc2'});
  const out=await c._parseOrRepairJsonResult(raw,data,'后人戏说',{id:'sc2',url,body,expectedKeys:['hourenXishuo','houren','zhengwen'],repair:false});
  assert(out.emergencyReceipt.verified);assert.equal(out.emergencyReceipt.calls,0);assert.equal(out.emergencyReceipt.policy,'field-aliases');assert.equal(out.raw,raw);
  assert.equal(out.parsed.houren_xishuo,'完整的原叙事');assert.equal(out.parsed.zhengwen,'完整的原叙事');assert.equal(sent,1);assert.equal(f.events.length,0);
 }finally{f.dispose();}
});
test('SC2 malformed separators are verified after the same alias normalization and all activities survive',async()=>{
 const f=fixture(),c=f.c;try{
  parser(c);c.P.conf.aiCallRetryOverrides={sc2:0};const raw='{"houren_xishuo", "没有新增或改写的叙事","new_activities":[{"id":"a1","name":"原事项"}]}',at=raw.indexOf(','),plan={edits:[{start:at,end:at+1,expected:',',replacement:':'}]};
  c.fetch=async(_u,o)=>{const b=JSON.parse(o.body);return response(isEmergency(b)?agentReply(b.messages[0].content,plan):raw);};
  const data=await c._aiFetchWithRetry(url,body,null,{id:'sc2'});
  const out=await c.TM.RecoveryRuntime.parse(raw,data,'后人戏说',{id:'sc2',url,body,expectedKeys:['hourenXishuo','houren','zhengwen'],normalizeParsed:p=>c._normalizeParsedJsonForExpected(p,['hourenXishuo','houren','zhengwen']),repair:false},async text=>rawParse(text));
  assert(out.emergencyReceipt.verified);assert.equal(out.parsed.zhengwen,'没有新增或改写的叙事');assert.equal(out.parsed.new_activities[0].id,'a1');assert.equal(out.raw,raw.slice(0,at)+':'+raw.slice(at+1));
 }finally{f.dispose();}
});
test('alias normalization cannot certify a missing narrative or bypass its original type schema',async()=>{
 const f=fixture(),c=f.c;try{
  parser(c);c.callAI=async()=>JSON.stringify({tools:[{name:'finish',input:{needsPlayer:true,reason:'原文没有合法叙事'}}]});
  for(const raw of ['{"new_activities":[]}','{"houren_xishuo":42,"new_activities":[]}']){
   const result=await c.TM.RecoveryAdapters.json({id:'sc2',raw,normalExhausted:true,error:{code:'AI_PARSE_INVALID'},normalizeParsed:p=>c._normalizeParsedJsonForExpected(p,['zhengwen']),validate:p=>typeof p.zhengwen==='string'});
   assert(!result.ok);assert(!result.value);
  }
 }finally{f.dispose();}
});
run(tests);
