"use strict";

class MonitorPoller {
  constructor({request,onResult,setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=id=>clearTimeout(id),clock=Date.now}) {
    Object.assign(this,{request,onResult,setTimer,clearTimer,clock});
    this.slots=[];this.visible=false;this.state='unknown';this.revision='';this.ready=true;this.lastStableState=null;this.transition='';
  }
  configure(items,revision) {
    this.stop();this.revision=revision;
    this.slots=items.map((item,index)=>({item,index,generation:0,active:false,timer:null,deadline:null,controller:null,refreshPending:false}));
    this.sync();
  }
  eligible(item) {
    const needsOverview=item.send_query_params && (item.query_params || []).some(arg=>!['run_history_json','current_run_json'].includes(arg.source));
    return this.visible && (!needsOverview || this.ready) && item.enabled!==false && (item.timing==='always' || !item.timing ||
      item.timing==='running' && ['running','nssta'].includes(this.state) || item.timing==='idle' && this.state==='stopped');
  }
  context(visible,state,ready=true,transition='') {
    const active=new Set(this.slots.filter(slot=>slot.active));
    const stable=['stopped','running','nssta'].includes(state);
    const stateChanged=stable && this.lastStableState && this.lastStableState!==state;
    const operationChanged=transition && this.transition && transition!==this.transition;
    // State and operation history can arrive in adjacent status responses.
    const sameTransition=operationChanged && !stateChanged && this.pendingTransition?.state===state && this.clock()-this.pendingTransition.at<3000;
    const changed=stateChanged || (operationChanged && !sameTransition);
    if(stateChanged && !operationChanged)this.pendingTransition={state,at:this.clock()};
    else if(operationChanged)this.pendingTransition=null;
    this.visible=visible;this.state=state;this.ready=ready;
    if(stable)this.lastStableState=state;
    if(transition)this.transition=transition;
    this.sync();
    if(changed)this.slots.forEach(slot=>{if(active.has(slot) && slot.active)this.refreshSlot(slot);});
  }
  refreshSlot(slot) {
    if(slot.controller){slot.refreshPending=true;return;}
    this.clearTimer(slot.timer);slot.timer=null;this.read(slot);
  }
  pause(slot) {
    slot.active=false;slot.generation++;this.clearTimer(slot.timer);slot.timer=null;
    this.clearTimer(slot.deadline);slot.deadline=null;
    slot.controller?.abort();slot.controller=null;
    slot.refreshPending=false;
  }
  stop() {this.slots.forEach(slot=>this.pause(slot));}
  sync() {
    this.slots.forEach(slot=>{
      if(!this.eligible(slot.item)){if(slot.active)this.pause(slot);return;}
      if(!slot.active){slot.active=true;this.read(slot);}
    });
  }
  async read(slot) {
    const generation=++slot.generation,revision=this.revision,started=this.clock();
    const controller=new AbortController();slot.controller=controller;
    let timedOut=false;
    const timeout=this.setTimer(()=>{timedOut=true;controller.abort();},(slot.item.timeout_sec ?? 10)*1000+500);
    slot.deadline=timeout;
    const current=()=>slot.active && generation===slot.generation && revision===this.revision;
    try {
      const result=await this.request(slot.index,revision,controller.signal);
      if(current() && result.revision===revision)this.onResult(slot.index,result);
    }catch(error){
      if(current() && !error.stale)this.onResult(slot.index,{status:timedOut ? 'timeout' : 'fail',data:null,
        message:timedOut ? `Timed out after ${slot.item.timeout_sec ?? 10} seconds` : error.message,checked_at:new Date().toISOString()});
    }finally{
      this.clearTimer(timeout);
      if(current()){
        slot.controller=null;
        slot.deadline=null;
        if(slot.refreshPending){slot.refreshPending=false;this.read(slot);}
        else slot.timer=this.setTimer(()=>this.read(slot),Math.max(0,(slot.item.interval_sec ?? 5)*1000-(this.clock()-started)));
      }
    }
  }
}

function mountMonitors({workspace,base,items,revision,isLive}) {
  const panel=document.createElement('section');panel.className='panel monitor-panel';
  workspace.appendChild(panel);
  let definitions=items || [];
  const poller=new MonitorPoller({
    request:async(index,revision,signal)=>{
      const response=await fetch(`${base}/monitors/${index}?revision=${encodeURIComponent(revision)}`,{signal});
      const value=await response.json();
      if(!response.ok){const error=new Error(value.detail || `HTTP ${response.status}`);error.stale=response.status===409;throw error;}
      return value;
    },
    onResult:(index,result)=>{
      if(!isLive())return;
      const card=panel.querySelector(`[data-monitor="${index}"]`);if(!card)return;
      card.className='monitor-card '+(result.status==='error' ? 'monitor-error' : ['fail','timeout'].includes(result.status) ? 'monitor-warning' : '');
      card.querySelector('.monitor-status').textContent=result.status.toUpperCase();
      card.querySelector('.monitor-value').innerHTML=formatDAQ(result.data);
      card.querySelector('.monitor-message').textContent=result.message || '';
      card.querySelector('.monitor-time').textContent=result.checked_at ? new Date(result.checked_at).toLocaleTimeString() : '';
    }
  });
  function configure(items,revision) {
    poller.stop();definitions=items || [];
    const enabled=definitions.some(item=>item.enabled!==false);
    panel.hidden=!enabled;workspace.classList.toggle('with-monitors',enabled);
    panel.innerHTML='<div class="panel-head"><h2>Monitor API</h2><span class="small-text muted">Display only</span></div><div class="panel-body">'+definitions.map((item,index)=>item.enabled===false ? '' : `<article class="monitor-card" data-monitor="${index}"><div class="monitor-card-head"><strong>${escapeRunHTML(item.name)}</strong><span class="monitor-status">WAITING</span></div><div class="monitor-value muted">No result yet</div><div class="monitor-message"></div><div class="monitor-meta"><span>${escapeRunHTML({always:'Every time',running:'During running',idle:'During IDLE'}[item.timing] || 'Every time')} · ${item.interval_sec ?? 5}s</span><time class="monitor-time"></time></div></article>`).join('')+'</div>';
    poller.configure(definitions,revision);
  }
  configure(definitions,revision);
  return {configure,context:(visible,state,ready,transition)=>poller.context(visible,state,ready,transition),stop:()=>poller.stop(),destroy:()=>{poller.stop();panel.remove();}};
}

if(typeof module!=='undefined')module.exports={MonitorPoller};
