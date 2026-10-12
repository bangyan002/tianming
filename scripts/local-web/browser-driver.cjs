'use strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) { const request = this.pending.get(data.id); if (request) { this.pending.delete(data.id); data.error ? request.reject(new Error(JSON.stringify(data.error))) : request.resolve(data.result); } }
      else this.events.push(data);
      if(data.method==='Fetch.requestPaused'){
        let request;try{request=JSON.parse(data.params.request.postData||'{}');}catch(_){request={};}
        setTimeout(()=>this.send('Fetch.continueRequest',{requestId:data.params.requestId},data.sessionId).catch(()=>{}),request.store==='projects'?1500:0);
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve,reject) => {
      const id = ++this.sequence, timer = setTimeout(() => {this.pending.delete(id);reject(new Error('CDP timeout: '+method));},60000);
      this.pending.set(id, {resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      this.socket.send(JSON.stringify({id,method,params,sessionId}));
    });
  }
  async evaluate(session, expression) {
    const r = await this.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true}, session);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async page(url, isolated = true, slowProject = false) {
    const browserContextId = isolated ? (await this.send('Target.createBrowserContext')).browserContextId : undefined;
    const {targetId} = await this.send('Target.createTarget', {url:'about:blank', browserContextId});
    const {sessionId} = await this.send('Target.attachToTarget', {targetId,flatten:true});
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.addScriptToEvaluateOnNewDocument',{source:'performance.setResourceTimingBufferSize(3000);'},sessionId);
    if(slowProject)await this.send('Fetch.enable',{patterns:[{urlPattern:'*/__tm_storage__/read',requestStage:'Request'}]},sessionId);
    await this.send('Page.navigate', {url}, sessionId);
    return sessionId;
  }
  async ready(session, expression) {
    for (let i=0; i<300; i++) {
      try { if (await this.evaluate(session, expression)) return; } catch (_) {}
      await delay(100);
    }
    throw new Error('Browser readiness timed out: ' + expression);
  }
}
module.exports = CDP;
