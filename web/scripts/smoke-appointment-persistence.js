#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const WEB=path.resolve(__dirname,'..');let passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
function fixture(){
 const c={console:{log(){},warn(){},error(){}},Date,JSON,Math,setTimeout(){},clearTimeout(){},
  P:{playerInfo:{factionName:'本朝',characterName:'天子'},ai:{},conf:{}},
  GM:{turn:1,playerFaction:'本朝',chars:[
   {id:'wce',name:'王承恩',alive:true,faction:'本朝',officialTitle:'宫门',title:'内侍太监',loyalty:90,stress:10,location:'京城'},
   {id:'wtq',name:'王体乾',alive:true,faction:'本朝',officialTitle:'司礼监掌印太监',location:'京城'}
  ],officeTree:[
   {id:'seal-dept',name:'司礼监',positions:[{id:'seal',name:'司礼监掌印太监',holder:'王体乾',establishedCount:1,rank:'正四品'}]},
   {id:'gate-dept',name:'宫门署',positions:[{id:'gate',name:'宫门',holder:'王承恩',establishedCount:1}]},
   {id:'horse-dept',name:'御马监',positions:[{id:'horse',name:'御马监掌印太监',holder:'',establishedCount:1}]}
  ],vars:{},evtLog:[],_turnReport:[],_chronicle:[],qijuHistory:[],facs:[],parties:[],classes:[],armies:[],memorials:[],_edictTracker:[]},
  SettlementPipeline:{register(){}},addEB(){},recordCharacterArc(){},escHtml:String,recordAIDiagnostic(){},_dbg(){}};
 c.window=c;c.globalThis=c;c.findCharByName=n=>c.GM.chars.find(ch=>ch.name===n);vm.createContext(c);
 for(const f of ['tm-office-holder-state.js','tm-office-system.js','tm-ai-change-pathutils.js','tm-ai-change-army.js','tm-ai-change-narrative.js','generated/tm-ai-change-applier.bundle.js','tm-endturn-edict.js'])vm.runInContext(fs.readFileSync(path.join(WEB,f),'utf8'),c,{filename:f});
 const seat=id=>c.GM.officeTree.flatMap(n=>n.positions||[]).find(p=>p.id===id);
 const appointed=c.onAppointment('王承恩','司礼监掌印太监',{dept:'司礼监'});assert(appointed.ok);
 return{c,seat,char:()=>c.findCharByName('王承恩'),apply:p=>c.applyAITurnChanges(p)};
}
test('routine role updates cannot undo a real appointment over seven turns',()=>{
 const h=fixture();
 for(let t=2;t<=8;t++){
  h.c.GM.turn=t;
  const r=h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'宫门',title:'宫门',stress:t},reason:'照常在宫门值守'}]});
  assert.notEqual(r.ok,false);assert.equal(h.char().stress,t);
  assert.equal(h.char().officialTitle,'司礼监掌印太监');assert.notEqual(h.char().title,'宫门');
  h.c._offSyncHoldersFromChars({force:true});
  assert.equal(h.seat('seal').holder,'王承恩');assert.equal(h.seat('gate').holder,'');
 }
});
test('save/reload and office import preserve the new appointment',()=>{
 const h=fixture();h.c.GM=JSON.parse(JSON.stringify(h.c.GM));h.c.GM.turn=5;
 h.apply({char_updates:[{characterId:'wce',updates:{officialTitle:'宫门',stress:22}}]});
 h.c._offSyncHoldersFromChars({force:true,importSeats:true});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');assert.equal(h.seat('seal').holder,'王承恩');
});
test('a same-turn player appointment takes precedence over an unrelated role recap',()=>{
 const h=fixture();h.c.GM._edictTracker=[{id:'appoint',turn:1,status:'pending',content:'命王承恩为司礼监掌印太监。'}];
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'宫门',stress:12},reason:'宫门值守'}]});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');assert.equal(h.char().stress,12);
});
test('an explicit current player appointment remains executable through the compatibility field',()=>{
 const h=fixture();h.c.GM.turn=2;
 h.c.GM._edictTracker=[{id:'new-post',turn:2,status:'pending',content:'命王承恩为御马监掌印太监。'}];
 const r=h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'御马监掌印太监',stress:16}}]});
 assert.notEqual(r.ok,false);assert.equal(h.char().officialTitle,'御马监掌印太监');
 assert.equal(h.seat('horse').holder,'王承恩');assert.equal(h.seat('seal').holder,'');
});
test('a historical edict is not authority to silently reinstate an old job',()=>{
 const h=fixture();h.c.GM.turn=5;
 h.c.GM._edictTracker=[{id:'old-post',turn:1,status:'completed',content:'命王承恩为宫门。'}];
 h.apply({char_updates:[{name:'王承恩',edictId:'old-post',updates:{officialTitle:'宫门'}}]});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');
});
test('an undelivered appointment is not applied by a generic character update',()=>{
 const h=fixture();h.c.GM.turn=2;
 h.c.GM._edictTracker=[{id:'mail-post',turn:2,status:'pending_delivery',content:'命王承恩为御马监掌印太监。'}];
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'御马监掌印太监'}}]});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');assert.notEqual(h.seat('horse').holder,'王承恩');
});
test('a formal personnel action wins over a conflicting character summary',()=>{
 const h=fixture();h.c.GM.turn=3;
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'宫门',stress:18}}],
  office_assignments:[{name:'王承恩',post:'御马监掌印太监',action:'transfer',reason:'奉诏调任'}]});
 assert.equal(h.char().officialTitle,'御马监掌印太监');assert.equal(h.seat('horse').holder,'王承恩');
 assert.equal(h.char().stress,18);
});
test('an explicit appointment career event uses the real seat writer',()=>{
 const h=fixture();h.c.GM.turn=3;
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'御马监掌印太监'},
  careerEvent:{action:'transfer',post:'御马监掌印太监',title:'奉诏调任',summary:'奉诏改任御马监掌印。'}}]});
 assert.equal(h.char().officialTitle,'御马监掌印太监');assert.equal(h.seat('horse').holder,'王承恩');
 assert.equal(h.seat('seal').holder,'');
});
test('an empty ordinary role recap cannot silently dismiss the current holder',()=>{
 const h=fixture();h.c.GM.turn=2;
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:null,title:'',stress:19}}]});
 h.c._offSyncHoldersFromChars({force:true});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');assert.equal(h.seat('seal').holder,'王承恩');assert.equal(h.char().stress,19);
});
test('a current explicit dismissal still clears the real seat through the personnel writer',()=>{
 const h=fixture();h.c.GM.turn=2;
 h.c.GM._edictTracker=[{id:'dismiss',turn:2,status:'pending',content:'王承恩着免。'}];
 const result=h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:''}}]});
 assert.notEqual(result.ok,false);assert(!h.char().officialTitle);assert(!h.seat('seal').holder);
 h.c._offSyncHoldersFromChars({force:true,importSeats:true});assert(!h.char().officialTitle);assert(!h.seat('seal').holder);
});
test('concurrent appointments remain concurrent through later routine updates',()=>{
 const h=fixture();h.c.GM.turn=2;
 h.c.GM._edictTracker=[{id:'concurrent',turn:2,status:'pending',content:'命王承恩以司礼监掌印太监加兼御马监掌印太监。'}];
 h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'御马监掌印太监'}}]});
 assert.equal(h.char().officialTitle,'司礼监掌印太监');assert(h.char().concurrentTitles.includes('御马监掌印太监'));
 h.c.GM.turn=3;h.apply({char_updates:[{name:'王承恩',updates:{officialTitle:'宫门'}}]});
 h.c._offSyncHoldersFromChars({force:true});
 assert.equal(h.seat('seal').holder,'王承恩');assert.equal(h.seat('horse').holder,'王承恩');
});
test('replacement clears stale display titles so synchronization cannot recreate a former office',()=>{
 const h=fixture();h.c.GM.chars.push({id:'minister',name:'甲臣',alive:true,faction:'本朝',officialTitle:'旧部尚书',title:'旧部尚书'});
 h.c.GM.officeTree.push({name:'旧部',positions:[{id:'old-chief',name:'旧部尚书',holder:'甲臣',establishedCount:1}]},
  {name:'新部',positions:[{id:'new-chief',name:'新部尚书',holder:'',establishedCount:1}]});
 h.c.onAppointment('甲臣','新部尚书',{dept:'新部'});h.c._offSyncHoldersFromChars({force:true});
 assert.equal(h.seat('old-chief').holder,'');assert.equal(h.seat('new-chief').holder,'甲臣');
 assert(!h.c._offGetCharOfficeTitles(h.c.findCharByName('甲臣')).includes('旧部尚书'));
});
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
