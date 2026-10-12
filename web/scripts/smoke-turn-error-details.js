'use strict';
const assert=require('assert/strict');
const {fixture,load,response,run}=require('./lib-emergency-recovery');
const tests=[],test=(name,fn)=>tests.push({name,fn});
function clock(f){let now=10000;f.c.Date=class extends Date{static now(){return now;}};return ms=>now+=ms;}
function element(tag){return {tagName:tag,children:[],style:{},textContent:'',appendChild(child){this.children.push(child);child.parentNode=this;return child;},get firstChild(){return this.children[0];},remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}};}
function doc(){const body=element('body'),frame=element('div'),sub=element('div');sub.id='loading-sub';body.appendChild(frame);frame.appendChild(sub);function find(el,id){if(el.id===id)return el;for(const child of el.children){const match=find(child,id);if(match)return match;}return null;}return {body,createElement:element,getElementById:id=>find(body,id)};}
test('writeback fields, targets, reasons and stage survive world rollback',()=>{
 const f=fixture();try{const r=f.c.TM.Endturn.Reliability,s=r.begin(),e=Object.assign(Error('写回预检失败'),{code:'ai-writeback-preflight-failed',writebackFailures:[{field:'office_changes',index:2,target:'甲 / 中书令',code:'target-ambiguous',reason:'同名人物有两个，不能唯一定位'}]});
  r.noteFailure(e,{stage:'应用诏令附效',subcall:'sc1'});f.c.GM={turn:1};r.finish(s,'failed',e);
  const result=r.snapshot()[0];assert.equal(result.failure.stage,'应用诏令附效');assert.equal(result.failure.subcall,'sc1');assert.equal(result.failure.category,'world_validation');assert.equal(result.failure.details[0].field,'office_changes[2]');assert(result.failure.details[0].message.includes('甲 / 中书令'));assert(result.failure.details[0].message.includes('两个'));result.failure.details[0].message='changed';assert.notEqual(r.snapshot()[0].failure.details[0].message,'changed');
 }finally{f.dispose();}
});
test('HTTP and timeout reports identify transport phase without copying API response bodies or keys',()=>{
 const f=fixture();try{const r=f.c.TM.Endturn.Reliability;f.c.P.ai.secondary={key:'secondary-secret'};
  const timeout=r.describeError(Object.assign(Error('private raw response'),{code:'AI_TIMEOUT',phase:'body',timeoutMs:180000}));assert(timeout.message.includes('读取完整结果'));assert(timeout.message.includes('180'));assert(!JSON.stringify(timeout).includes('private raw'));
  const rejected=r.describeError(Object.assign(Error('HTTP 503 private payload'),{status:503}));assert(rejected.message.includes('HTTP 503'));assert(!JSON.stringify(rejected).includes('private payload'));
  const failure=r.describeError(Error('fixture-only secondary-secret Bearer abc sk-privatekey'));assert(!JSON.stringify(failure).includes('fixture-only'));assert(!JSON.stringify(failure).includes('secondary-secret'));assert(!JSON.stringify(failure).includes('sk-privatekey'));
 }finally{f.dispose();}
});
test('live phase times are independent and accumulate all attempts without double counting',()=>{
 const f=fixture();try{const advance=clock(f),r=f.c.TM.Endturn.Reliability,s=r.begin(),t=r.requestStart('sc07');advance(2000);r.requestPhase(t,'request');advance(9000);
  let live=r.live();assert.equal(live.requests[0].phaseMs.queue,2000);assert.equal(live.requests[0].phaseMs.request,9000);assert.equal(t.row.phaseMs.request,undefined);
  r.requestPhase(t,'body');advance(3000);r.requestRetry(t,{status:429},1000);advance(1000);r.requestPhase(t,'request');advance(4000);r.requestPhase(t,'body');advance(5000);r.requestEnd(t);r.finish(s,'done');
  const row=r.snapshot()[0].requests[0];assert.equal(row.attempts,2);assert.equal(row.phaseMs.queue,2000);assert.equal(row.phaseMs.request,13000);assert.equal(row.phaseMs.body,8000);assert.equal(row.phaseMs.retry,1000);assert.equal(row.ms,24000);assert.equal(row.retryErrors[0].error.category,'rate_limit');assert.equal(Object.values(row.phaseMs).reduce((a,b)=>a+b,0),row.ms);assert.equal(r.live(),null);
 }finally{f.dispose();}
});
test('real retry adapter reports HTTP failure and actual backoff while preserving its retry policy',async()=>{
 const f=fixture();try{const advance=clock(f),r=f.c.TM.Endturn.Reliability,s=r.begin();let sent=0;f.c._aiRetryDelay=()=>1200;f.c._aiBudgetedRetryWait=async ms=>advance(ms);
  f.c.fetch=async()=>{advance(500);return ++sent===1?{ok:false,status:503,headers:{get(){return null;}},text:async()=>{advance(200);return 'private provider body';}}:response('complete');};
  await f.request({id:'sc07',maxRetries:1});r.finish(s,'done');const row=r.snapshot()[0].requests[0];assert.equal(sent,2);assert.equal(row.attempts,2);assert.equal(row.retryErrors.length,1);assert.equal(row.retryErrors[0].delayMs,1200);assert.equal(row.phaseMs.retry,1200);assert.equal(row.phaseMs['error-body'],200);assert(!JSON.stringify(r.snapshot()).includes('private provider body'));
 }finally{f.dispose();}
});
test('pipeline stage names and world-validity reasons are retained independently of GM',async()=>{
 const f=fixture();try{load(f.c,'tm-endturn-pipeline-executor.js');const r=f.c.TM.Endturn.Reliability,s=r.begin(),e=Object.assign(Error('回合复核未通过'),{validity:{reasons:['时政记为空','主推演结构不完整']}});
  const ctx=f.c.TM.Endturn.Pipeline.buildCtx();f.c.TM.Endturn.PipelineSteps={list:[{name:'post-ai-edict',fn:async()=>{throw e;}}]};await assert.rejects(f.c.TM.Endturn.Pipeline.run(ctx),error=>error===e);r.finish(s,'failed',e);const report=r.snapshot()[0].failure;assert.equal(report.stage,'应用诏令附效');assert.equal(report.details.length,2);assert(report.details[0].message.includes('时政记'));
 }finally{f.dispose();}
});
test('loading details and persistent failure panel use safe text and clean up the heartbeat',()=>{
 const f=fixture();try{f.c.document=doc();let beat,cleared=0;f.c.setInterval=fn=>{beat=fn;return 71;};f.c.clearInterval=id=>{assert.equal(id,71);cleared++;};const advance=clock(f),r=f.c.TM.Endturn.Reliability,s=r.begin(),t=r.requestStart('sc07');r.requestPhase(t,'request');advance(61000);beat();
  const waiting=f.c.document.getElementById('tm-turn-wait-details');assert(waiting.firstChild.textContent.includes('1 分 1 秒'));assert(waiting.children[1].textContent.includes('人物认知（sc07）'));assert(waiting.children[1].textContent.includes('等待接口首响应'));
  const e=Error('<img src=x onerror=alert(1)> 人物甲定位失败');r.noteFailure(e,{stage:'应用诏令附效'});r.finish(s,'failed',e);r.showFailure(e);assert.equal(cleared,1);const panel=f.c.document.getElementById('tm-turn-failure-details');assert(panel.children[1].textContent.includes('<img'));assert.equal(panel.children[1].children.length,0);assert(panel.firstChild.textContent.includes('应用诏令附效'));panel.children[3].onclick();assert.equal(f.c.document.getElementById('tm-turn-failure-details'),null);
 }finally{f.dispose();}
});
test('live diagnostic modal includes slow calls, retry reasons and auxiliary errors after rollback',()=>{
 const f=fixture();try{load(f.c,'tm-endturn-timing-ledger.js');let rendered='';f.c.openGenericModal=(title,html)=>{rendered=html;};const advance=clock(f),r=f.c.TM.Endturn.Reliability,s=r.begin(),t=r.requestStart('sc07');advance(1000);r.requestPhase(t,'request');advance(180000);
  f.c.TM.Endturn.Timing.openDiagnostics();assert(rendered.includes('进行中'));assert(rendered.includes('人物认知'));assert(rendered.includes('等待接口首响应'));r.requestEnd(t,Object.assign(Error('raw private'),{code:'AI_TIMEOUT',timeoutMs:180000,phase:'headers'}));r.noteFailure(Error('地区「甲地」未找到'),{stage:'诏令解析'});f.c.GM={turn:1};r.finish(s,'failed',Error('回合失败'));f.c.TM.Endturn.Timing.openDiagnostics();assert(rendered.includes('地区「甲地」未找到'));assert(rendered.includes('180 秒'));assert(rendered.includes('并行'));assert(!rendered.includes('raw private'));
 }finally{f.dispose();}
});
test('edict quantity ambiguity reports original text and each candidate even with recovery disabled',()=>{
 const f=fixture({mode:'off'});try{const r=f.c.TM.Endturn.Reliability,s=r.begin();const registered=f.c.TM.RecoveryEdict.register('发行宝钞五万贯，又发行十万贯',{ok:false,amountError:true,message:'存在多个发行数额，请明确唯一总额',details:{candidates:[{token:'五万',value:50000,measure:'贯'},{token:'十万',value:100000,measure:'贯'}]}});assert.equal(registered,false);r.finish(s,'done');const issue=r.snapshot()[0].errors[0].error;assert.equal(issue.stage,'诏令数量解析');assert(issue.message.includes('五万贯'));assert(issue.message.includes('十万贯'));assert(issue.message.includes('数值 50000'));assert(issue.message.includes('数值 100000'));
 }finally{f.dispose();}
});
run(tests);
