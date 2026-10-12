// Attribute summaries describe a character; changing offices requires a personnel action.
const rows=value=>Array.isArray(value)?value:[];
const title=value=>String(value==null?'':value).replace(/\s+/g,'').trim();
const officeActions=/^(appoint|appointment|transfer|concurrent|dismiss|dismissal|remove|retire)$/;
function sameActor(row,ch){
  const id=row&&(row.characterId||row.charId);
  return !!row&&(id?String(id)===String(ch.id):[row.name,row.character,row.charName].includes(ch.name));
}
function delivered(g,e){
  return !/^(pending_delivery|cancelled|revoked|rejected|failed)$/.test(e.status||'')&&
    !rows(e._letterIds).some(id=>{
      const letter=rows(g.letters).find(l=>l&&l.id===id);
      return !letter||!['delivered','returned','replying'].includes(letter.status);
    });
}
function sameOffice(root,requested,position){
  if(title(requested)===title(position))return true;
  if(typeof root._offResolveSeat!=='function')return false;
  const requestedSeat=root._offResolveSeat('',requested),sourceSeat=root._offResolveSeat('',position);
  return !!requestedSeat&&!!sourceSeat&&requestedSeat.pos===sourceSeat.pos;
}
export function officeUpdateIntent(g,root,ch,update,output,requested){
  // These actions are applied later by their own writer and take precedence over a recap.
  for(const field of ['office_assignments','appointments','personnel_changes']){
    if(rows(output[field]).some(row=>sameActor(row,ch)&&officeActions.test(String(row.action||row.type||'appoint'))))
      return {kind:'structured'};
  }
  const wanted=title(requested);
  if(wanted===title(ch.officialTitle))return {kind:'unchanged'};
  const turn=Number(g.turn)||0,sources=[];
  rows(g.edicts).forEach(e=>{
    if(e&&Number(e.turn)===turn&&e.status==='promulgated'&&delivered(g,e))sources.push(e.text||e.content||'');
  });
  rows(g._edictTracker).forEach(e=>{
    if(e&&(Number(e.turn)===turn||Number(e.lastSubmittedTurn)===turn)&&delivered(g,e))sources.push(e.content||'');
  });
  if(typeof root.extractEdictActions==='function'){
    for(const source of sources){
      let parsed;try{parsed=root.extractEdictActions(source);}catch(_){continue;}
      const assignment=rows(parsed.appointments).find(a=>sameActor(a,ch)&&sameOffice(root,wanted,a.position));
      if(assignment)return {kind:'appoint',position:assignment.position,concurrent:!!assignment.concurrent};
      if(!wanted&&rows(parsed.dismissals).some(a=>sameActor(a,ch)))return {kind:'dismiss'};
    }
  }
  // A typed career transition is a supported compatibility form, rather than a job label.
  const event=update.careerEvent||{},action=String(event.action||event.type||event.kind||'');
  const post=event.post||event.newPosition||event.position;
  if(/^(appoint|appointment|transfer|concurrent)$/.test(action)&&wanted&&title(post)===wanted)
    return {kind:'appoint',position:post,concurrent:action==='concurrent'||event.concurrent===true};
  if(!wanted&&/^(dismiss|dismissal|remove|retire)$/.test(action))return {kind:'dismiss'};
  return {kind:'recap'};
}
