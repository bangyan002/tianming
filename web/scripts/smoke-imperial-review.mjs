import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import perf from './lib-perf-round1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = f => fs.readFileSync(path.join(root, 'web', f), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
function harness() {
  const g = {turn:1, running:true, playerInfo:{factionId:'own', factionName:'本朝'},
    time:{daysPerTurn:30}, _capital:'京城', chars:[
      {id:'a', name:'袁崇焕', faction:'本朝', alive:true, location:'京城', loyalty:80},
      {id:'b', name:'崔呈秀', faction:'本朝', alive:true, location:'京城', loyalty:60}
    ], facs:[{id:'own', name:'本朝'}], officeTree:[], memorials:[], currentIssues:[],
    culturalWorks:[], _edictTracker:[], fiscalConfig:{taxList:[]}};
  const c = {console, GM:g, P:{conf:{deptReplyEnabled:true}, playerInfo:g.playerInfo},
    SettlementPipeline:{register(){}}, addEB(){}, escHtml:s=>String(s ?? ''),
    findCharByName:n=>g.chars.find(x=>x.name===n)};
  c.window=c; c.globalThis=c; vm.createContext(c);
  for (const f of ['tm-tax-policy.js','tm-office-holder-state.js','tm-imperial-orders.js','tm-endturn-helpers.js']) {
    vm.runInContext(read(f), c, {filename:f});
  }
  for (const f of ['_wdCommitBuckets','_wdCommitRow']) vm.runInContext(perf.functionSource(read('tm-wendui.js'), f), c);
  return {g,c,O:c.TM.ImperialOrders,create:(text,opts={})=>c.TM.ImperialOrders.create(g,'袁崇焕',text,opts).task};
}

test('a submitted completion stays awaiting review after many turns, with its full result', () => {
  const h=harness(), t=h.create('查清陕西账册');
  h.g.turn=3;
  h.O.update(h.g,'袁崇焕',t,{status:'completed',progress:100,feedback:'已呈原簿及逐项勾稽结果，待御前验收。'});
  h.g.turn=20; h.O.tick(h.g);
  assert.equal(t.verificationStatus,'pending_review'); assert.notEqual(t.status,'failed');
  assert.equal(t.overdue,false); assert(h.c._wdCommitBuckets().review.some(x=>x.c===t));
  const html=h.c._wdCommitRow({nm:'袁崇焕',c:t},'review');
  assert(html.includes('待朕验收')); assert(html.includes('逐项勾稽结果'));
  assert(html.includes('退回补办')); assert(!html.includes('逾期 16 回合'));
  assert(h.O.acceptByPlayer(h.g,t.id)); assert.equal(t.verificationStatus,'verified');
});
test('legacy false lapse with a submitted result reopens, but explicit reported failure does not', () => {
  const h=harness(),t=h.create('核对账册');
  Object.assign(t,{status:'failed',reportedComplete:true,verificationStatus:'unverified_lapsed',
    _terminalSettled:true,_failReason:'逾期未提交可核验的结果',feedback:'具奏结果已呈。'});
  const genuine=h.create('另外一案');
  Object.assign(genuine,{status:'failed',reportedComplete:true,verificationStatus:'reported_failure',_terminalSettled:true});
  h.g.turn=30; h.O.tick(h.g);
  assert.equal(t.verificationStatus,'pending_review'); assert.equal(t.status,'executing');
  assert.equal(t._terminalSettled,false); assert.equal(t._failReason,undefined);
  assert.equal(genuine.status,'failed');
});
test('an unreported task can still lapse; progress alone cannot fabricate a result', () => {
  const h=harness(),t=h.create('核查军粮');
  t.progress=100; h.g.turn=20; h.O.tick(h.g);
  assert.equal(t.status,'failed'); assert.equal(t._failReason,'逾期未复命');
  assert(!h.O.acceptByPlayer(h.g,t.id));
});
test('returning a result resumes work with a new deadline, survives reload and blocks stale approval', () => {
  const h=harness(),t=h.create('核对账册');
  h.O.update(h.g,'袁崇焕',t,{status:'completed',feedback:'核对已毕。'});
  h.g.turn=10;
  assert(h.O.returnByPlayer(h.g,t.id)); assert.equal(t.verificationStatus,'pending');
  assert.equal(t.reportedComplete,false); assert(t.dueDay>h.c.TM.TaxPolicy.now(h.g));
  assert(!h.O.acceptByPlayer(h.g,t.id));
  const reload=JSON.parse(JSON.stringify(h.g)); h.O.tick(reload);
  assert.equal(reload._npcCommitments['袁崇焕'][0].status,'executing');
});
test('personnel verification reads the actual seat and checks replacement and dismissal together', () => {
  const h=harness();
  const pos={id:'war-chief',name:'兵部尚书',rank:'2',actualHolders:[{characterId:'a',name:'旧姓名',generated:true}],holder:'崔呈秀'};
  h.g.officeTree=[{id:'war',name:'兵部',positions:[pos]}];
  const t=h.create('命 袁崇焕 为 兵部兵部尚书·原任 崔呈秀 着免，官员任命');
  h.O.tick(h.g); assert.equal(t.status,'completed');
  assert(t.evidenceRefs.some(r=>r.type==='office_assignment')); assert(t.evidenceRefs.some(r=>r.type==='office_dismissal'));
  assert.equal(pos.holder,'崔呈秀'); // Verification is a read, not another appointment.
});
test('a title string or a different department seat cannot verify an appointment', () => {
  const h=harness(); h.g.chars[0].officialTitle='兵部尚书';
  h.g.officeTree=[{name:'兵部',positions:[{id:'war',name:'尚书',holder:'崔呈秀'}]},
    {name:'户部',positions:[{id:'tax',name:'尚书',holder:'袁崇焕'}]}];
  const t=h.create('命袁崇焕为兵部尚书·原任崔呈秀着免');
  assert(!h.O.verified(h.g,t).ok); h.O.tick(h.g); assert.notEqual(t.status,'completed');
});
test('a partially replaced seat and a compound construction directive are not fully verified', () => {
  const h=harness();
  h.g.officeTree=[{name:'兵部',positions:[{id:'war',name:'兵部尚书',actualHolders:[{characterId:'a'},{characterId:'b'}]}]}];
  assert(!h.O.verified(h.g,h.create('命袁崇焕为兵部尚书·原任崔呈秀着免')).ok);
  h.g.officeTree[0].positions[0].actualHolders.pop();
  assert(!h.O.verified(h.g,h.create('命袁崇焕为兵部尚书，并修复边城')).ok);
});
test('old personnel failures recover only when the real seat now satisfies the whole order', () => {
  const h=harness(),t=h.create('命袁崇焕为兵部尚书·原任崔呈秀着免');
  Object.assign(t,{status:'failed',verificationStatus:'unverified_lapsed',_terminalSettled:true,_failReason:'逾期未提交可核验的结果'});
  h.g.officeTree=[{name:'兵部',positions:[{id:'war',name:'兵部尚书',holder:'袁崇焕'}]}];
  h.O.tick(h.g); assert.equal(t.status,'completed'); assert.equal(t.verificationStatus,'verified');
});
test('written results must bind to the correct living author and task, not just a claimed task id', () => {
  const h=harness(),t=h.create('撰写军粮核查条陈',{category:'write'});
  const work={id:'w',author:'袁崇焕',content:'军粮勾稽条陈全文。',turn:1};
  assert(h.O.bindWork(h.g,work,{taskId:t.id})); h.g.culturalWorks.push(work); h.O.tick(h.g);
  assert.equal(t.status,'completed');
  const other=h.create('撰写另一篇文书',{category:'write'});
  assert(!h.O.bindWork(h.g,{id:'wrong',author:'崔呈秀',content:'别人的文章',turn:1},{taskId:other.id}));
  assert(!h.O.verified(h.g,other).ok);
});
test('changing turn length does not make the tracker contradict the task due day', () => {
  const h=harness(),t=h.create('查核账册',{deadline:3});
  h.g.time.daysPerTurn=7; h.g.turn=5; h.O.tick(h.g);
  assert.equal(t.dueDay,90); assert(h.c._wdCommitBuckets().active.some(x=>x.c===t));
});
test('department reply reads canonical ID-only holders and recovers after filling a real vacancy', () => {
  const h=harness(),pos={id:'war-chief',name:'尚书',rank:'2',actualHolders:[{characterId:'a'}],holder:''};
  h.g.officeTree=[{name:'兵部',positions:[pos]}];
  h.g.deptTasks=[{dept:'兵部',task:'核议边饷',dueIn:1,status:'pending'}];
  h.c._tickDeptTasksReply(); assert.equal(h.g.deptTasks[0].status,'replied');
  assert(h.g.currentIssues[0].description.includes('袁崇焕'));
  pos.actualHolders=[];
  h.g.turn=2; const t={dept:'兵部',task:'核议第二案',dueIn:1,status:'pending'}; h.g.deptTasks.push(t);
  h.c._tickDeptTasksReply(); assert.equal(t.status,'overdue');
  pos.actualHolders=[{characterId:'a'}]; h.g.turn=3; h.c._tickDeptTasksReply();
  assert.equal(t.status,'replied'); assert.equal(t.repliedAtTurn,3);
  const n=h.g.currentIssues.length; h.c._tickDeptTasksReply(); assert.equal(h.g.currentIssues.length,n);
});
test('a department with an unnamed occupant is not falsely reported as vacant', () => {
  const h=harness(); h.g.officeTree=[{name:'兵部',positions:[{name:'尚书',actualCount:1,occupancyStatus:'unrecorded'}]}];
  h.g.deptTasks=[{dept:'兵部',task:'核议边饷',dueIn:1,status:'pending'}];
  h.c._tickDeptTasksReply(); assert.equal(h.g.deptTasks[0].status,'overdue');
  assert(h.g.currentIssues[0].description.includes('姓名'));
  assert(!h.g.currentIssues[0].description.includes('主官虚悬'));
});
test('player acceptance and a new execution receipt can settle the same completion claim in its original turn', () => {
  const h=harness(),t=h.create('核对账册');
  h.O.update(h.g,'袁崇焕',t,{status:'completed',feedback:'核对已毕。'});
  assert(h.O.acceptByPlayer(h.g,t.id)); assert.equal(t.status,'completed');
});
test('actual edict feedback reaches its linked task and awaits review instead of lapsing', () => {
  const h=harness(); vm.runInContext(read('tm-edict-outcomes.js'),h.c);
  const text='命袁崇焕核查边饷';
  h.g._edictTracker=[{id:'e',content:text,status:'pending',turn:1}]; h.O.tick(h.g);
  h.c.TM.EdictOutcomes.receive(h.g,{edict_feedback:[{content:text,status:'completed',feedback:'边饷原册已核，具奏结果待验。'}]},[],1,[]);
  const t=h.O.all(h.g)[0].c; assert.equal(t.verificationStatus,'pending_review');
  h.g.turn=30; h.O.tick(h.g); assert.notEqual(t.status,'failed');
  assert(h.O.acceptByPlayer(h.g,t.id)); assert.equal(h.g._edictTracker[0].status,'completed');
  assert.equal(h.g._edictTracker[0].verificationStatus,'verified');
});
function council(h) {
  for (const [file,names] of [
    ['tm-chaoyi-tinyi.js',['_ty2_isServingOfficial','_ty2_openSetup']],
    ['tm-tinyi-v3-persona.js',['_ty3_calcEligibilityByStatus','_ty3_findByRole','_ty3_recommendAttendees']],
    ['tm-tinyi-v3.js',['_ty3_isEligibleOfficial']]
  ]) for(const name of names) vm.runInContext(perf.functionSource(read(file),name),h.c);
  Object.assign(h.c,{TAG_TO_RECOMMEND:{},_isAtCapital:()=>true,_isPlayerFactionChar:()=>true,
    _cyGetRank:c=>c.rankLevel||4,getRankLevel:r=>Number(r)||4,_ty2_courtReady:()=>true,CY:{open:true,phase:'setup'}});
}
test('removed officials with old high ranks and authored titles cannot enter any automatic council pool', () => {
  const h=harness(); council(h);
  h.g.chars[1].officialTitle=''; h.g.chars[1].title='兵部尚书'; h.g.chars[1].rankLevel=2; h.g.chars[1].prestige=100;
  h.g.chars[0].officialTitle='兵部尚书';
  h.g.officeTree=[{name:'兵部',positions:[{id:'war',name:'兵部尚书',actualHolders:[{characterId:'a'}]}]}];
  h.g.parties=[{name:'旧党',leader:'崔呈秀'}];
  assert(!h.c._ty2_isServingOfficial(h.g.chars[1])); assert(!h.c._ty3_isEligibleOfficial(h.g.chars[1]));
  assert.equal(h.c._ty3_calcEligibilityByStatus(h.g.chars[1]).category,'不召');
  const names=Array.from(h.c._ty3_recommendAttendees('边饷',[],{}));
  assert.deepEqual(names,['袁崇焕']);
  let rendered=''; const element={style:{},querySelectorAll:()=>[]};
  h.c.document={getElementById:id=>id==='ty2-setup-bg'?null:element,
    createElement:()=>({style:{},querySelectorAll:()=>[],set innerHTML(s){rendered=s;}}),body:{appendChild(){}}};
  h.c._ty2_openSetup(); assert(rendered.includes('袁崇焕')); assert(!rendered.includes('崔呈秀'));
});
test('holding another real post keeps a dismissed minister eligible; explicit reappointment works immediately', () => {
  const h=harness(); council(h); h.g.chars[1].officialTitle='';
  const pos={id:'clerk',name:'侍郎',actualHolders:[{characterId:'b'}]};
  h.g.officeTree=[{name:'文书署',positions:[pos]}];
  assert(h.c._ty2_isServingOfficial(h.g.chars[1]));
  pos.actualHolders=[]; assert(!h.c._ty2_isServingOfficial(h.g.chars[1]));
  pos.actualHolders=[{characterId:'b'}]; assert(h.c._ty2_isServingOfficial(h.g.chars[1]));
});
test('the real dismissal executor clears ID-only seats so later derivation cannot reinstate them', () => {
  const h=harness();
  vm.runInContext(read('tm-office-system.js'),h.c);
  for (const name of ['_edictCloneState','_edictRestoreState','applyEdictActions']) vm.runInContext(perf.functionSource(read('tm-endturn-edict.js'),name),h.c);
  const pos={id:'war',name:'兵部尚书',establishedCount:1,holder:'',actualHolders:[{characterId:'b',name:'',generated:true}]};
  h.g.officeTree=[{name:'兵部',positions:[pos]}];
  h.g.chars[1].officialTitle='兵部尚书';
  const result=h.c.applyEdictActions({dismissals:[{character:'崔呈秀'}]});
  assert.equal(result.ok,true); assert(!h.c.TM.OfficeHolderState.read(h.g,pos).holders.some(x=>x.char===h.g.chars[1]));
  h.c._offSyncHoldersFromChars({importSeats:true}); assert.equal(h.g.chars[1].officialTitle,'');
});
test('actual state changes are presented as execution evidence while the overall report awaits review', () => {
  const h=harness();
  for(const f of ['tm-edict-outcomes.js','tm-edict-effects.js'])vm.runInContext(read(f),h.c);
  const text='命袁崇焕推进边饷核查';
  h.g.vars={'边饷核查进度':{value:0,min:0,max:100}};
  h.g._edictTracker=[{id:'progress',content:text,status:'pending',turn:1}];h.O.tick(h.g);
  const ctx={input:{edicts:[],resolutionTurn:1},apply:{}},p={resource_changes:{'边饷核查进度':100},
    edict_feedback:[{edictId:'progress',status:'completed',feedback:'勾稽已毕，结果具奏。',effectRefs:['resource_changes.边饷核查进度']}]};
  const E=h.c.TM.EdictEffects,O=h.c.TM.EdictOutcomes;
  E.begin(h.g,h.c.P,ctx,p);E.applyAuxiliary(h.g,ctx);
  const effects=E.finish(h.g,ctx,p);O.receive(h.g,p,[],1,effects);
  assert.equal(h.g.vars['边饷核查进度'].value,100);
  const task=h.O.all(h.g)[0].c;assert.equal(task.verificationStatus,'pending_review');
  const html=h.c._wdCommitRow({nm:'袁崇焕',c:task},'review');
  assert(html.includes('0 → 100'));assert(O.feedbackHtml(O.forTurn(h.g,1),1).includes('已复命·待验收'));
  assert(!O.forTurn(h.g,1)[0].note.includes('尚无'));
});
test('blocked and partially executed edict receipts are not displayed as completed', () => {
  const h=harness();vm.runInContext(read('tm-edict-outcomes.js'),h.c);
  const text='命袁崇焕核验边饷';h.g._edictTracker=[{id:'blocked',content:text,status:'pending',turn:1}];h.O.tick(h.g);
  const O=h.c.TM.EdictOutcomes;
  O.receive(h.g,{edict_feedback:[{edictId:'blocked',status:'completed',feedback:'称已完成。'}]},[],1,
    [{ref:'fiscal_adjustments[0]',edictIds:['blocked'],status:'blocked',label:'边饷拨款',note:'库款不足',visibility:'public'}]);
  assert.equal(h.g._edictTracker[0].status,'partial');
  assert(h.O.resultText(h.O.all(h.g)[0].c).includes('库款不足'));
  assert(!O.feedbackHtml(O.forTurn(h.g,1),1).includes('已办结'));
});
test('an undelivered edict cannot report completion into a previously linked task', () => {
  const h=harness();vm.runInContext(read('tm-edict-outcomes.js'),h.c);
  const text='命袁崇焕核验边饷';h.g._edictTracker=[{id:'on-road',content:text,status:'pending',turn:1}];h.O.tick(h.g);
  const t=h.O.all(h.g)[0].c;h.g._edictTracker[0]._letterIds=['post'];h.g.letters=[{id:'post',status:'traveling'}];
  h.c.TM.EdictOutcomes.receive(h.g,{edict_feedback:[{edictId:'on-road',status:'completed',feedback:'自称办妥。'}]},[],1,[]);
  assert.equal(t.verificationStatus,'pending'); assert.equal(t.reportedComplete,undefined);
  assert.equal(h.g._edictTracker[0].status,'pending_delivery');
});
test('a written artifact cannot settle a second construction obligation', () => {
  const h=harness(),t=h.create('撰写军饷条陈，并修复城墙',{category:'write'});
  const work={id:'compound-work',author:'袁崇焕',content:'军饷条陈全文。',turn:1};
  assert(h.O.bindWork(h.g,work,{taskId:t.id}));h.g.culturalWorks.push(work);
  assert(!h.O.verified(h.g,t).ok);
});
console.log(JSON.stringify({passed,failed})); process.exitCode=failed?1:0;
