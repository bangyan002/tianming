/* One task ledger for orders, evidence and report delivery. AI feedback is a claim, not a receipt. */
(function(root){'use strict';var TM=root.TM=root.TM||{},arr=x=>Array.isArray(x)?x:[];
function day(g){return TM.TaxPolicy.now(g);}function days(g){return TM.TaxPolicy.turnDays(g);}
function alive(c){return !!c&&c.alive!==false&&!c.dead;}
function actor(g,c,name){return arr(g.chars).find(x=>c.actorId?x.id===c.actorId:x.name===name)||null;}
function ledger(g){if(!g._npcCommitments||typeof g._npcCommitments!=='object'||Array.isArray(g._npcCommitments))g._npcCommitments={};return g._npcCommitments;}
function all(g){var out=[];Object.keys(g._npcCommitments||{}).forEach(name=>arr(g._npcCommitments[name]).forEach(c=>{if(c&&c.task)out.push({name:name,c:c,actor:actor(g,c,name)});}));return out;}
function deadline(g,text,value){
 var literal=String(text||'').match(/^([零一二两三四五六七八九十百\d]+)\s*(个?月|回合|年|天|日)(?:内|前)?$/);
 if(literal)return Math.max(1,Math.ceil(TM.TaxPolicy.number(literal[1])*({'月':30,'个月':30,'年':360,'回合':days(g),'天':1,'日':1}[literal[2]])/days(g)));
 if(Number.isFinite(Number(value))&&Number(value)>0)return Number(value);
 var m=String(text).match(/(?:限(?:期)?|第)?([零一二两三四五六七八九十百\d]+)\s*(个?月|回合|年|天|日)(?:之?内|前)?[^，。；]{0,12}(?:汇报|回报|复命|具奏|奏报|查清|办结|完成)/);
 if(!m)return 3;var n=TM.TaxPolicy.number(m[1]);
 return Math.max(1,Math.ceil(n*({'月':30,'个月':30,'年':360,'回合':days(g),'天':1,'日':1}[m[2]])/days(g)));
}
function category(text){if(/查|核|审|稽|调查/.test(text))return 'query';if(/税|赋|财政|钱粮/.test(text))return 'finance';if(/撰|拟|编写|写成/.test(text))return 'write';if(/侦|密探|刺探/.test(text))return 'intel';return 'other';}
function create(g,name,text,opts){
 opts=opts||{};var ch=arr(g.chars).find(c=>c&&(c.id===name||c.name===name));
 if(!alive(ch)||ch.isPlayer)return {ok:false,reason:'承办人不在册或不可领命'};
 var pf=TM.TaxPolicy.player(g),aff=ch.factionId||ch.faction;
 if(aff&&aff!==pf.id&&aff!==pf.name&&!String(aff).startsWith(pf.name+'·'))return {ok:false,reason:'不可将本朝交办直接强加给外国人物'};
 text=String(text||'').trim();if(!text||text.length>12000)return {ok:false,reason:'交办内容为空或过长'};
 var list=ledger(g)[ch.name];if(!Array.isArray(list))list=g._npcCommitments[ch.name]=[];
 var turn=Number(g.turn)||0,source=opts.sourceId||'direct:'+turn+':'+ch.id+':'+text;
 var old=list.find(c=>c&&c.sourceId===source&&c.task===text);if(old)return {ok:true,task:old,duplicate:true};
 var seq=(Number(g._imperialOrderSequence)||0)+1;g._imperialOrderSequence=seq;
 var c={id:'order-'+turn+'-'+seq,actorId:ch.id||'',task:text,sourceText:text,sourceId:source,sourceType:opts.sourceType||'direct-order',
 assignedTurn:turn,assignedDay:day(g),deadline:deadline(g,text,opts.deadline),category:opts.category||category(text),
 willingness:Number.isFinite(opts.willingness)?Math.max(0,Math.min(1,opts.willingness)):.6,status:'pending',progress:0,attempts:0,
 feedback:'',responsibility:'npc',_source:opts.sourceType||'direct-order',schemaVersion:2,verificationStatus:'pending',reportState:'not_due'};
 c.dueDay=c.assignedDay+c.deadline*days(g);c.sourceRefs=[{type:c.sourceType,id:source,turn:turn,authority:'player_pin'}];list.push(c);
 if(opts.executeTax&&!/若|倘|查明后|核验后|待.*后|是否/.test(text)){
  var tax=TM.TaxPolicy.apply(g,text,{}, {sourceId:'task:'+c.id});
  if(tax.ok)c.taxReceiptIds=tax.receiptIds;else if(tax.handled)c.executionBlock=tax.reason;
 }
 if(root.NpcMemorySystem)root.NpcMemorySystem.remember(ch.name,'奉命：'+text,'敬',7,'天子',{type:'commitment',source:'witnessed',sourceRefs:c.sourceRefs,taskId:c.id});
 g._continuityRevision=(Number(g._continuityRevision)||0)+1;return {ok:true,task:c};
}
function timing(g,c){
 var span=days(g),due=Number.isFinite(c.dueDay)?c.dueDay:
 Math.max(0,(Number.isFinite(c.assignedTurn)?c.assignedTurn:Number(g.turn)||0)-1)*span+(Number(c.deadline)||3)*span;
 var left=due-day(g);return {dueDay:due,leftDays:left,leftTurns:left<0?-Math.ceil(-left/span):Math.ceil(left/span),overdue:left<0};
}
function awaitingReview(c){return !!c&&c.status!=='cancelled'&&c.verificationStatus==='pending_review';}
function personnelProof(g,c){
 var HS=TM.OfficeHolderState;if(!HS)return null;
 var text=String(c.sourceText||c.task||'').replace(/\s+/g,''),requirements=[],refs=[],supported=true;
 var chars=arr(g.chars).filter(alive),names=chars.map(ch=>ch.name).filter(Boolean).sort((a,b)=>b.length-a.length);
 if(!names.length)return null;
 var rx=names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 var appoint=new RegExp('^(?:任命|擢升|擢任|擢拜|改任|起用|起复|授任|着任|特命|特授|命|授|擢|拜)('+rx+')(?:为|出任|担任|兼任|加兼|兼|任)(.+)$');
 var remove=new RegExp('^(?:原任|现任)?('+rx+')(?:着免|免职|罢免|革职|着革|罢黜)$');
 var removeFirst=new RegExp('^(?:免去|罢免|免职|革职|撤职|着免)('+rx+')$');
 text.split(/[，,。；;·\n]/).filter(Boolean).forEach(s=>{
  if(/^(?:官员任命|人事任免|任免)$/.test(s))return;
  var m=s.match(appoint),d=s.match(remove)||s.match(removeFirst);
  if(m)requirements.push({kind:'appoint',name:m[1],title:m[2]});
  else if(d)requirements.push({kind:'dismiss',name:d[1]});else supported=false;
 });
 if(!supported||!requirements.length)return null; // A personnel receipt cannot cover a second, unrelated obligation.
 var pf=TM.TaxPolicy.player(g),rows=HS.positions(g).filter(r=>
 !r.organizationId||r.organizationId===pf.id||r.organizationId===pf.name);
 var seats=[];
 for(var r of requirements){
  var ch=chars.filter(ch=>ch.name===r.name);if(ch.length!==1)return {ok:false,refs:[],reason:'任免对象身份尚未核实'};ch=ch[0];
  if(r.kind==='appoint'){
   var hits=rows.filter(a=>{
    var n=String(a.node.name||'').replace(/\s+/g,''),p=String(a.pos.name||'').replace(/\s+/g,'');
    return a.pos.enabled!==false&&a.pos.status!=='abolished'&&(r.title===p||r.title===n+p);
   });
   if(hits.length!==1||!HS.read(g,hits[0].pos).holders.some(h=>h.char===ch))
    return {ok:false,refs:[],reason:r.name+'尚未实际就任指定官职，须核对官制任职记录'};
   seats.push(hits[0]);refs.push({type:'office_assignment',id:hits[0].pos.id||hits[0].key,actorId:ch.id,taskId:c.id});
  }
 }
 for(var r of requirements.filter(r=>r.kind==='dismiss')){
  var ch=chars.find(ch=>ch.name===r.name),check=seats.length?seats:rows;
  if(!check.length||check.some(a=>HS.read(g,a.pos).holders.some(h=>h.char===ch)))
   return {ok:false,refs:[],reason:r.name+'仍在原任官职，免职尚未落实'};
  refs.push({type:'office_dismissal',id:'dismissal:'+c.id+':'+ch.id,actorId:ch.id,taskId:c.id});
 }
 return {ok:true,refs:refs};
}
function resultText(c){
 return arr(c.executionEvidence).map(e=>e.label+'：'+(['applied','unchanged','partial'].includes(e.status)?
 e.visibility==='reported'?'已记入相关账目':JSON.stringify(e.before)+' → '+JSON.stringify(e.after):e.note||'尚待落实')).join('\n');
}
function bindWork(g,work,input){
 var id=input&&(input.taskId||input._taskId);if(!id||!work||!work.id||!String(work.content||work.text||'').trim())return false;
 var matches=all(g).filter(x=>x.c.id===id&&x.c.category==='write'&&x.c.status!=='cancelled'&&
 alive(x.actor)&&x.actor.name===work.author&&Number(work.turn)>=Number(x.c.assignedTurn));
 if(matches.length!==1)return false;work._taskId=id;work._taskActorId=matches[0].actor.id||'';return true;
}
function verified(g,c){
 if(!c||c.status==='cancelled')return {ok:false,refs:[],reason:'原交办已撤回'};
 if(c.playerAcceptance&&c.playerAcceptance.taskId===c.id)return {ok:true,refs:[c.playerAcceptance]};
 var receipts=arr(g.fiscalConfig&&g.fiscalConfig.taxPolicies).filter(p=>
  arr(c.taxReceiptIds).includes(p.id)&&p.sourceId==='task:'+c.id||p.sourceId===c.sourceId&&p.sourceId.indexOf('edict:')===0);
 if(receipts.length&&TM.TaxPolicy.coversTask&&TM.TaxPolicy.coversTask(g,c.task))return {ok:true,refs:receipts.map(p=>({type:'tax_policy',id:p.id,taskId:c.id}))};
 var ch=actor(g,c,'');
 var works=arr(g.culturalWorks).filter(w=>w&&w._taskId===c.id&&alive(ch)&&w.author===ch.name&&
 (!w._taskActorId||w._taskActorId===ch.id)&&Number(w.turn)>=Number(c.assignedTurn)&&String(w.content||w.text||'').trim());
 if(c.category==='write'&&works.length&&!/(?:并|及|同时|另|且)(?:命[^，。；]{0,20})?(?:修建|修复|兴建|免除|征收|出兵|拨|发放|任命|罢免|调遣)/.test(c.task))return {ok:true,refs:works.map(w=>({type:'written_work',id:w.id,taskId:c.id}))};
 var personnel=personnelProof(g,c);if(personnel)return personnel;
 return {ok:false,refs:[],reason:'此类结果须由朕核对承办反馈并验收；尚无自动核验凭据'};
}
function label(c){return c.status==='cancelled'?'原命已撤回':c.verificationStatus==='legacy_unverified'?'旧记录称完成·未核验':c.verificationStatus==='pending_review'?'承办自报完成·待核验':c.status==='completed'?'已核验完成':c.status==='failed'?'未完成·已逾期':c.status==='delayed'?'逾期或受阻':'承办中';}
function memorialRecord(r){return {id:r.id,from:r.from,title:'交办复命：'+r.content.split('\n')[0].slice(0,35),subject:'交办复命',summary:r.content,content:r.content,type:'report',category:'政务',turn:r.turn,status:'pending',read:false,_taskId:r.taskId,_taskReportId:r.id,_taskLedgerGenerated:true};}
function deliver(g,r){
 if(['read','intercepted','dismissed'].includes(r.state))return;
 if(r.channel==='letter'){
  if(arr(g.letters).some(l=>l._taskReportId===r.id)||arr(g._pendingNpcLetters).some(q=>q.taskReportId===r.id))return;
  if(!Array.isArray(g._pendingNpcLetters))g._pendingNpcLetters=[];
  g._pendingNpcLetters.push({from:r.from,content:r.content,type:'report',replyExpected:false,taskId:r.taskId,taskReportId:r.id});r.state='queued';
 }else if(r.channel==='audience'){
  if(arr(g._pendingAudiences).some(q=>q.taskReportId===r.id))return;
  if(r.state==='delivered'){r.state='dismissed';return;}
  if(!Array.isArray(g._pendingAudiences))g._pendingAudiences=[];
  g._pendingAudiences.push({_qid:r.id,name:r.from,reason:r.content,turn:r.turn,taskId:r.taskId,taskReportId:r.id});r.state='delivered';
 }else{
  if(!Array.isArray(g.memorials))g.memorials=[];
  if(!g.memorials.some(m=>m._taskReportId===r.id))g.memorials.push(memorialRecord(r));r.state='delivered';
 }
}
function mergeMemorials(g,next){
 var protectedRows=arr(g.memorials).filter(m=>m&&m._taskLedgerGenerated&&m._taskReportId&&
  (!m.read&&!m._playerRead&&!['approved','rejected','annotated','referred'].includes(m.status)||m.turn===g.turn));
 var seen=new Set(),out=[];
 protectedRows.concat(arr(next)).forEach(m=>{if(!m)return;var id=m._taskReportId||m.id;if(id&&seen.has(id))return;if(id)seen.add(id);out.push(m);});return out;
}
function report(g,name,c,reason){
 if(!Array.isArray(g._imperialReports))g._imperialReports=[];
 var signature=reason+':'+String(c.lastUpdateTurn||'')+':'+c.status+':'+String(c.feedback||'');
 if(g._imperialReports.some(r=>r.taskId===c.id&&r.signature===signature))return;
 var ch=actor(g,c,name),live=alive(ch),from=live?ch.name:'有司';
 var id='task-report:'+c.id+':'+(g._imperialReports.filter(r=>r.taskId===c.id).length+1);
 var text='交办复命｜'+c.task+'\n状态：'+label(c)+'。\n'+
 (c.verificationStatus==='verified'?'已核对执行凭据：'+arr(c.evidenceRefs).map(r=>r.id).join('、')+'。':
 arr(c.executionEvidence).length?'本次执行记录：'+resultText(c)+'。交办整体结果待朕验收。':'交办整体结果尚待核验，可查阅承办反馈后验收或退回补办。')+
 (c.feedback?'\n承办反馈（自述）：'+c.feedback:'\n截至本次核验，没有新的承办反馈。')+
 (!live?'\n原承办人已故、失联或不在名册，须另行指定责任人。':'');
 var channel=live&&(/传书|鸿雁|来函/.test(c.task)||(ch.location&&ch.location!==(g._capital||'京城')))?'letter':/面奏|请见|问对/.test(c.task)&&live?'audience':'memorial';
 var rec={id:id,taskId:c.id,actorId:c.actorId,from:from,reason:reason,signature:signature,turn:Number(g.turn)||0,channel:channel,state:'queued',content:text};
 g._imperialReports.push(rec);deliver(g,rec);c.reportState=rec.state;c.lastReportId=id;
 if(root.addEB)root.addEB('交办复命',from+'：'+label(c)+'（'+(channel==='letter'?'已交驿递':channel==='audience'?'已请见':'已呈奏疏')+'）');
}
function syncSourceEdict(g,c){
 if(!String(c.sourceId||'').startsWith('edict:'))return;
 var e=arr(g._edictTracker).find(e=>'edict:'+e.id===c.sourceId);if(!e||['cancelled','revoked','rejected'].includes(e.status))return;
 var linked=all(g).filter(x=>x.c.sourceId===c.sourceId),done=linked.length&&linked.every(x=>x.c.verificationStatus==='verified');
 e.verificationStatus=done?'verified':linked.some(x=>awaitingReview(x.c))?'pending_review':'pending';
 if(done){e.status='completed';e.progressPercent=100;e.verifiedAtTurn=Number(g.turn)||0;}
 else if(e.status==='completed'||e.verificationStatus==='pending_review')e.status='executing';
}
function update(g,name,c,u){
 if(!c||!u||c.status==='cancelled'||c._terminalSettled&&c.verificationStatus==='verified')return;
 var ch=actor(g,c,name);if(!alive(ch)){c.executionBlock='原承办人不可继续执行';report(g,name,c,'actor-unavailable');return;}
 if(c.actorId&&u.npcName&&u.npcName!==ch.name)return;
 var proof=verified(g,c),wantsComplete=u.status==='completed'||u.consequenceType==='success';
 var fingerprint=JSON.stringify(u),turn=Number(g.turn)||0;
 if(c._updateTurn!==turn){c._updateTurn=turn;c._updateKeys=[];}
 if(arr(c._updateKeys).includes(fingerprint)&&!(wantsComplete&&proof.ok&&c.verificationStatus!=='verified'))return;c._updateKeys.push(fingerprint);
 var progress=u.progressPercent!=null?Number(u.progressPercent):u.progress!=null?Number(u.progress):
 u.progress_delta!=null?(Number(c.progress)||0)+Number(u.progress_delta):Number(c.progress)||0;
 if(Number.isFinite(progress))c.progress=Math.max(0,Math.min(100,progress));
 c.lastUpdateTurn=turn;c.lastUpdateDay=day(g);if(typeof u.feedback==='string')c.feedback=u.feedback.slice(0,8000);
 c.schemaVersion=2;if(!c.actorId)c.actorId=ch.id||'';
 // A new receipt or player acceptance can settle a previously deduplicated claim in the same turn.
 if(wantsComplete&&proof.ok){
  c.status='completed';c.progress=100;c.verificationStatus='verified';c.evidenceRefs=proof.refs;c.overdue=false;delete c._failReason;
  c._terminalSettled=true;c._terminalSettledTurn=turn;c._terminalSettledKind='verified_completed';
 }else if(wantsComplete){
  c.status='executing';c.verificationStatus='pending_review';c._terminalSettled=false;
  c.executionBlock=proof.reason;c.reportedComplete=true;c.overdue=false;delete c._failReason;
  c.completionReport={turn:turn,day:day(g),feedback:c.feedback||'承办人称已完成，未说明具体结果。',progress:c.progress};
 }else if(u.status==='failed'||u.status==='obstructed'||u.consequenceType==='abandoned'){
  c.status='failed';c.verificationStatus='reported_failure';c._terminalSettled=true;c.reportedComplete=false;
  c._terminalSettledTurn=turn;c._failReason=String(u.failReason||'承办人报告未能完成');
 }else if(['pending','executing','delayed'].includes(u.status))c.status=u.status;
 if(root.NpcMemorySystem&&(c.feedback||wantsComplete)){
  var accepted=c.verificationStatus==='verified';
  root.NpcMemorySystem.remember(ch.name,(accepted?'有凭据确认：':'承办自述（尚待核验）：')+c.task+'——'+(c.feedback||label(c)),
   '平',7,'天子',{type:'task_report',source:accepted?'witnessed':'reported',credibility:accepted?95:55,
    taskId:c.id,factStatus:accepted?'verified':'unverified_claim',sourceRefs:accepted?c.evidenceRefs:c.sourceRefs});
 }
 syncSourceEdict(g,c);
 if(wantsComplete||c.status==='failed'||c.feedback)report(g,ch.name,c,wantsComplete?'completion':'progress');
 g._continuityRevision=(Number(g._continuityRevision)||0)+1;
}
function updates(g,list){arr(list).forEach(u=>{if(!u||!u.id)return;var matches=all(g).filter(x=>x.c.id===u.id);if(matches.length===1)update(g,matches[0].name,matches[0].c,u);});}
function fromDialogue(g,sources,feedback){
 arr(sources).forEach(s=>{if(!s||!s.npc||!s.task)return;
  var prior=all(g).filter(x=>(x.actor?x.actor.name:x.name)===s.npc&&x.c.task===s.task&&['direct-order','edict'].includes(x.c.sourceType||x.c._source)&&!x.c._terminalSettled);
  var created=prior.length===1?{ok:true,task:prior[0].c,duplicate:true}:create(g,s.npc,s.task,{sourceId:'dialogue:'+String(s.source_conv_id||g.turn+':'+s.npc),sourceType:s.source_type||'dialogue',category:s.category,deadline:deadline(g,s.deadline||s.task),willingness:s.willingness});
  if(created.ok){var c=created.task;c._sc1qSourceConvId=s.source_conv_id||'';c._sc1qSource=s.source_type||'';c._sc1qTarget=s.required_npc_action||'';c._sc1qPlayerEmphasis=s.player_emphasis||'';var ref={type:'dialogueCommitment',id:s.source_conv_id||c.id,authority:'court_report',turn:g.turn,role:'commitment_source'};c.sourceRefs=arr(c.sourceRefs).filter(r=>!(r.type===ref.type&&r.id===ref.id)).concat([ref]);c.basisRefs=c.sourceRefs;}
 });
 arr(feedback).forEach(u=>{if(!u||!u.npc)return;var candidates=all(g).filter(x=>x.actor&&x.actor.name===u.npc&&
  (u.source_conv_id?(x.c.sourceId==='dialogue:'+u.source_conv_id||arr(x.c.sourceRefs).some(r=>r.type==='dialogueCommitment'&&r.id===u.source_conv_id)):typeof u.task==='string'&&x.c.task===u.task));
  if(u.task&&candidates.length>1)candidates=candidates.filter(x=>x.c.task===u.task);
  if(candidates.length===1)update(g,candidates[0].name,candidates[0].c,u);
 });
}
function ingestEdicts(g){
 arr(g._edictTracker).forEach(e=>{
  if(!e||!e.id||!e.content||['pending_delivery','rejected','cancelled','revoked','completed','failed','archived'].includes(e.status))return;
  var text=String(e.content);arr(g.chars).forEach(ch=>{
   if(!alive(ch)||ch.isPlayer||!ch.name)return;
   var escaped=ch.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   if(!new RegExp('(?:命|责成|交由|着|令)[^，,。；;]{0,18}'+escaped).test(text))return;
   create(g,ch.name,text,{sourceId:'edict:'+e.id,sourceType:'edict',executeTax:false});
  });
 });
}
function refreshReports(g){
 arr(g._imperialReports).forEach(r=>{
  deliver(g,r);
  if(r.channel==='letter'){
   var l=arr(g.letters).find(l=>l._taskReportId===r.id);
   if(l)r.state=l._playerRead?'read':l.status==='returned'?'delivered':l.status==='intercepted'?'intercepted':'in_transit';
  }else if(r.channel==='memorial'){
   var m=arr(g.memorials).find(m=>m._taskReportId===r.id);
   if(m&&(m.read||m._playerRead||['approved','rejected','annotated','referred'].includes(m.status)))r.state='read';
  }
  var x=all(g).find(x=>x.c.id===r.taskId);if(x&&x.c.lastReportId===r.id)x.c.reportState=r.state;
 });
}
function tick(g){
 ingestEdicts(g);var today=day(g);all(g).forEach(x=>{
  var source=String(x.c.sourceId||'');
  var edict=source.startsWith('edict:')?arr(g._edictTracker).find(e=>e.id===source.slice(6)):null;
  if(edict&&['cancelled','revoked','rejected'].includes(edict.status)&&x.c.verificationStatus!=='verified'){
   x.c.status='cancelled';x.c._terminalSettled=true;x.c.verificationStatus='cancelled';x.c.feedback='原交办已撤回，不再继续执行';report(g,x.name,x.c,'cancelled');return;
  }
  if(x.c.status==='cancelled')return;
  var c=x.c,ch=x.actor;if(!Number.isFinite(c.assignedTurn))c.assignedTurn=Number(g.turn)||0;
  if(!Number.isFinite(c.dueDay))c.dueDay=Math.max(0,c.assignedTurn-1)*days(g)+(Number(c.deadline)||3)*days(g);
  if(ch&&ch.id&&!c.actorId)c.actorId=ch.id;
  if(c.status==='completed'){
   if(c.verificationStatus!=='verified')c.verificationStatus=c.verificationStatus||'legacy_unverified';
   if(c.schemaVersion===2&&!c.lastReportId)report(g,x.name,c,'completion');return;
  }
  var proof=verified(g,c);
  if(c.status==='failed'){
   if(c.verificationStatus!=='unverified_lapsed'||!c.reportedComplete&&!proof.ok)return;
   c.status='executing';c._terminalSettled=false;c.overdue=false;delete c._failReason;
   delete c._terminalSettledTurn;delete c._terminalSettledKind;
   c.verificationStatus='pending_review';c.reviewRecovered=true;
   report(g,x.name,c,'review-recovered');
  }
  if(proof.ok){
   update(g,x.name,c,{status:'completed',feedback:c.feedback||'已查见与本项命令绑定的执行凭据'});return;
  }
  if(awaitingReview(c)){c.overdue=false;return;} // A submitted result awaits the player's decision, not another NPC deadline.
  if(today>=c.dueDay){
   c.overdue=true;c.status='delayed';
   var last=Number.isFinite(c.lastUpdateDay)?c.lastUpdateDay:Number.isFinite(c.lastUpdateTurn)?Math.max(0,c.lastUpdateTurn-1)*days(g):c.assignedDay||0;
   if(today>c.dueDay+2*days(g)&&today-last>2*days(g)){
    c.status='failed';c._terminalSettled=true;c._failReason='逾期未复命';
    c.verificationStatus='report_lapsed';
   }
   report(g,x.name,c,c.status==='failed'?'lapsed':'overdue');
  }
 });refreshReports(g);
}
function context(g,name){
 return all(g).filter(x=>x.actor?x.actor.name===name:x.name===name)
 .sort((a,b)=>Number(!!b.c.overdue)-Number(!!a.c.overdue)||(a.c.dueDay||Infinity)-(b.c.dueDay||Infinity))
 .slice(0,12).map(x=>'['+x.c.id+'] '+x.c.task+'；'+label(x.c)+'；进度为承办自报'+(Number(x.c.progress)||0)+'%；'+
 '复命状态：'+(x.c.reportState||'未报告')+'；期限第'+x.c.dueDay+'日'+(x.c.feedback?'；反馈：'+x.c.feedback:'')).join('\n');
}
function guardEdict(g,feedback,effects) {
 if(!feedback||!feedback.edictId)return feedback;
 var linked=all(g).filter(x=>x.c.sourceId==='edict:'+feedback.edictId);
 var tracker=arr(g._edictTracker).find(e=>e.id===feedback.edictId);
 if(tracker&&['cancelled','revoked','rejected'].includes(tracker.status))return Object.assign({},feedback,{status:tracker.status,completionVerified:false});
 if(Array.isArray(effects))linked.forEach(x=>{
  x.c.executionEvidence=effects.filter(e=>e&&arr(e.edictIds).includes(feedback.edictId)&&e.visibility!=='hidden').map(e=>({
   type:'edict_effect',id:e.ref,taskId:x.c.id,label:e.label||'执行记录',status:e.status,visibility:e.visibility,
   before:e.visibility==='reported'?null:e.before,after:e.visibility==='reported'?null:e.after,note:e.note||''}));
 });
 if(['pending','executing','delayed','completed','failed','obstructed'].includes(feedback.status))
  linked.forEach(x=>update(g,x.name,x.c,feedback));
 if(feedback.status!=='completed')return feedback;
 var proofs=TM.TaxPolicy.receipts(g,'edict:'+feedback.edictId);
 if(!linked.length&&!proofs.length)return feedback;
 var ok=linked.length?linked.every(x=>verified(g,x.c).ok):proofs.length>0;
 if(tracker){tracker.reportedStatus='completed';tracker.verificationStatus=ok?'verified':'pending_review';}
 return ok?Object.assign({},feedback,{completionVerified:true}):Object.assign({},feedback,{completionVerified:false,status:'executing',feedback:'承办自报完成，尚待核验。'+String(feedback.feedback||'')});
}
function acceptByPlayer(g,id){
 if(g.busy)return false;
 var found=all(g).filter(x=>x.c.id===id);
 if(found.length!==1||!alive(found[0].actor))return false;
 var c=found[0].c;if(!awaitingReview(c))return false;
 c.playerAcceptance={id:'player-acceptance:'+id,taskId:id,type:'player_review',turn:Number(g.turn)||0};
 update(g,found[0].name,c,{status:'completed',feedback:c.feedback||'御前验收通过'});
 return c.verificationStatus==='verified';
}
function returnByPlayer(g,id){
 if(g.busy)return false;var found=all(g).filter(x=>x.c.id===id);
 if(found.length!==1||!alive(found[0].actor)||!awaitingReview(found[0].c))return false;
 var c=found[0].c;c.verificationStatus='pending';c.reportedComplete=false;c.status='executing';
 c._terminalSettled=false;c.overdue=false;delete c._failReason;delete c.executionBlock;
 c.lastUpdateTurn=Number(g.turn)||0;c.lastUpdateDay=day(g);c.dueDay=day(g)+2*days(g);
 c.feedback='御前退回补办：请补充具体结果，限两回合再复命。';c.reviewReturnedAtTurn=c.lastUpdateTurn;
 g._continuityRevision=(Number(g._continuityRevision)||0)+1;syncSourceEdict(g,c);report(g,found[0].name,c,'review-returned');return true;
}
TM.ImperialOrders={create:create,all:all,update:update,updates:updates,fromDialogue:fromDialogue,
 tick:tick,ingestEdicts:ingestEdicts,verified:verified,context:context,label:label,guardEdict:guardEdict,
 mergeMemorials:mergeMemorials,acceptByPlayer:acceptByPlayer,returnByPlayer:returnByPlayer,refreshReports:refreshReports,
 awaitingReview:awaitingReview,timing:timing,bindWork:bindWork,resultText:resultText};
root.tmAcceptImperialTask=function(id){
 if(!root.GM||typeof root.confirm!=='function')return false;
 if(!root.confirm('确认已核对本项交办的执行结果？验收不会凭空改变税制、钱粮或军队。'))return false;
 var ok=acceptByPlayer(root.GM,id);
 if(ok&&typeof root._wdShowCommitTracker==='function')root._wdShowCommitTracker();
 return ok;
};
root.tmReturnImperialTask=function(id){
 if(!root.GM||typeof root.confirm!=='function'||!root.confirm('退回此项复命，命承办人补充结果并于两回合内再奏？'))return false;
 var ok=returnByPlayer(root.GM,id);if(ok&&typeof root._wdShowCommitTracker==='function')root._wdShowCommitTracker();return ok;
};
})(typeof window!=='undefined'?window:globalThis);
