"use strict";

function mountRunTimer({root,base,request,onChange,onError}) {
  const get=selector=>root.querySelector(selector);
  let state=null, loadedId=null, ignoredId=null;
  const enabled=get('#timer-enabled'), repeat=get('#timer-repeat');
  const fields=['#timer-hours','#timer-minutes','#timer-seconds','#timer-repeat','#timer-count'];
  const dirtyComments=new Set();
  let commentQueue={}, commentBusy=false;
  let lockPhase='unknown', lockCycle=null, lastStartId=null, repeatVisible=false;
  function setCommentEditable(value){
    for(const name of ['header','ender'])get('#'+name+'-edit').checked=value;
  }
  setCommentEditable(true);
  const storageKey='babirl-run-timer:'+base;
  function savePreferences(){
    try{
      localStorage.setItem(storageKey,JSON.stringify({enabled:enabled.checked,repeat:repeat.checked,
        hours:get('#timer-hours').value,minutes:get('#timer-minutes').value,
        seconds:get('#timer-seconds').value,count:get('#timer-count').value}));
    }catch{}
  }
  try{
    const saved=JSON.parse(localStorage.getItem(storageKey));
    if(saved){
      enabled.checked=saved.enabled===true;repeat.checked=saved.repeat===true;
      for(const [name,selector,max] of [['hours','#timer-hours',8760],['minutes','#timer-minutes',59],['seconds','#timer-seconds',59],['count','#timer-count',1000000]]){
        const value=Number(saved[name]);
        if(Number.isInteger(value) && value>=(name==='count' ? 1 : 0) && value<=max)get(selector).value=value;
      }
    }
  }catch{}
  function render(){
    const active=!!state?.active;
    const showLocks=enabled.checked && repeat.checked;
    if(lockPhase==='idle')setCommentEditable(true);
    else if(showLocks && !repeatVisible && lockPhase==='running')setCommentEditable(false);
    repeatVisible=showLocks;
    get('#timer-options').hidden=!enabled.checked;
    get('#timer-repeat-options').hidden=!repeat.checked;
    get('#manual-stop').hidden=!(enabled.checked && repeat.checked);
    for(const name of ['header','ender']){
      get('#'+name+'-lock-control').hidden=!showLocks;
      get('#'+name+'-edit').disabled=lockPhase==='idle';
      get('#'+name+'-lock-state').textContent=get('#'+name+'-edit').checked ? 'Editable' : 'Locked';
    }
    get('.control-actions').classList.toggle('with-manual-stop',enabled.checked && repeat.checked);
    enabled.disabled=active;
    fields.forEach(selector=>get(selector).disabled=active);
    get('#timer-progress').textContent=`Completed ${state?.completed_runs ?? 0} / ${state?.total_runs ?? Number(get('#timer-count').value)}`;
    const left=state?.remaining_sec;
    get('#timer-status').hidden=!enabled.checked && !active;
    get('#timer-status').textContent=state ? (active && left!=null ? `Time left ${Math.floor(left/3600)}h ${Math.floor(left/60)%60}m ${left%60}s${state.finish_requested ? ' · finishing this Run' : ''}` : state.message) : '';
    get('#timer-status').classList.toggle('error-text',state?.phase==='failed');
  }
  for(const input of [enabled,...fields.map(get)])input.addEventListener('input',()=>{
    if(!state?.active){ignoredId=state?.id ?? ignoredId;state=null;}
    savePreferences();render();onChange();
  });
  render();
  async function flushComments(){
    if(commentBusy)return;
    commentBusy=true;
    try{
      while(Object.keys(commentQueue).length){
        const changes=commentQueue;commentQueue={};
        if(!state?.active)return;
        await request(base+'/timer/comments',{method:'PATCH',body:{id:state.id,...changes}});
      }
    }catch(error){onError?.(error.message);}
    finally{commentBusy=false;}
  }
  for(const name of ['header','ender'])get('#'+name+'-edit').onchange=()=>{render();onChange();};
  return {
    starting(){setCommentEditable(false);lockPhase='running';render();},
    syncLocks(status){
      const op=status?.active_operation;
      const starting=op && ['start','nssta'].includes(op.action);
      const timer=status?.run_timer;
      const phase=status?.state?.state;
      const cycle=timer?.active ? timer.id+':'+timer.completed_runs : null;
      if(status?.connected && phase==='stopped' && !starting && !(timer?.active && timer.phase==='starting')){
        lockPhase='idle';lockCycle=null;lastStartId=null;setCommentEditable(true);
      }else if(starting || ['running','nssta'].includes(phase) || (timer?.active && timer.phase==='starting')){
        if(lockPhase!=='running' || (cycle!==null && cycle!==lockCycle) || (starting && op.id!==lastStartId))setCommentEditable(false);
        lockPhase='running';lockCycle=cycle;
        if(starting)lastStartId=op.id;
      }
      render();
    },
    changeComment(name,value){
      if(!state?.active)return;
      dirtyComments.add(name);
      if(new TextEncoder().encode(value).length>79 || value.includes('\0'))return;
      commentQueue[name]=value;flushComments();
    },
    repeating:()=>enabled.checked && repeat.checked,
    spec(){
      if(!enabled.checked)return null;
      const hours=Number(get('#timer-hours').value), minutes=Number(get('#timer-minutes').value), seconds=Number(get('#timer-seconds').value);
      const total=Number(get('#timer-count').value), duration=hours*3600+minutes*60+seconds;
      if(![hours,minutes,seconds].every(Number.isInteger) || hours<0 || minutes<0 || minutes>59 || seconds<0 || seconds>59 || duration<1 || duration>31536000)
        throw new Error('Timer: enter a duration of at least 1 second (minutes and seconds: 0–59).');
      if(repeat.checked && (!Number.isInteger(total) || total<1 || total>1000000))throw new Error('Timer: total Runs must be an integer from 1 to 1000000.');
      return {duration_sec:duration,repeat:repeat.checked,total_runs:repeat.checked ? total : 1};
    },
    update(value){
      if(value && !value.active && value.id===ignoredId){state=null;render();return;}
      state=value;
      if(value?.active && value.id!==loadedId){
        dirtyComments.clear();commentQueue={};
        loadedId=value.id;enabled.checked=true;repeat.checked=value.repeat;
        get('#timer-hours').value=Math.floor(value.duration_sec/3600);
        get('#timer-minutes').value=Math.floor(value.duration_sec/60)%60;
        get('#timer-seconds').value=value.duration_sec%60;
        get('#timer-count').value=value.total_runs;
        savePreferences();
      }
      if(value?.active){
        for(const name of ['header','ender']){
          const input=get('#run-'+name);
          if(value[name]===input.value)dirtyComments.delete(name);
          if(!dirtyComments.has(name))input.value=value[name] ?? '';
        }
      }
      render();
    },
    active:()=>!!state?.active,
    defersStop:()=>!!state?.active && state.repeat,
    finishRequested:()=>!!state?.active && state.finish_requested,
    async finish(){state=await request(base+'/timer/finish',{method:'POST'});render();onChange();},
  };
}
