"use strict";

const DAQ_ARGUMENT_SOURCES={runname:'Run name',runnumber:'Current Run number',header:'Header',event_num:'Event count',start_time:'Start time (babirl)',stop_time:'Stop time (babirl)',state:'DAQ state',getconfig_json:'getconfig (JSON)',current_run_json:'Latest Run History (JSON)'};
function argumentDescription(source){
  if(source==='custom')return 'Web GUI input: entered manually in the API tab. The template is a placeholder, never a default value.';
  if(source==='current_run_json')return 'Web GUI: the latest saved Run History entry (including an in-progress Run). Same JSON as Run History → JSON: mode, status, daq_config, event_num, es_event_num, config_snapshot, and error when present.';
  if(source==='state')return 'Web GUI state mapped from babirl: stopped (IDLE), running (START), nssta (NSSTA), unknown.';
  if(source==='getconfig_json')return 'babirl: the shared Run overview getconfig snapshot (runinfo, eflist, hdlist and other DAQ settings).';
  return 'babirl via the shared Run overview snapshot: '+({runname:'current Run name.',runnumber:'current Run number, without zero padding.',header:'Run header.',event_num:'current event count.',start_time:'Run start time, formatted by the Web GUI.',stop_time:'Run stop time, formatted by the Web GUI.'}[source] || 'current DAQ value.');
}

function mountManualAPIs({base,items,revision,getState,isLive,onBusyChange=()=>{}}){
  const root=document.querySelector('#view-api');
  const timingsText=item=>(item.timings || ['always']).map(value=>({always:'Every time',running:'During running',idle:'During IDLE'}[value])).join(' / ');
  root.innerHTML=items.map((item,index)=>`<section class="panel manual-api-panel" data-api-index="${index}">
    <div class="panel-head"><div class="actions"><h2>${escapeHTML(item.name)}</h2>${pill(item.enabled ? 'ENABLED' : 'DISABLED',item.enabled ? 'green' : '')}</div><span class="small-text muted">${escapeHTML(timingsText(item))}</span></div>
    <div class="manual-api-layout panel-body"><form class="manual-api-content" data-api-index="${index}"><h3>Content</h3><p class="form-note mono wrap">${escapeHTML(item.method)} ${escapeHTML(item.api)}</p>
    ${item.send_query_params ? item.query_params.map((argument,n)=>`<div class="manual-query-row"><label for="manual-input-${index}-${n}">${escapeHTML(argument.name)}</label>${argument.source==='custom' ? `<input class="input" id="manual-input-${index}-${n}" data-custom="${escapeHTML(argument.name)}" maxlength="65536" placeholder="${escapeHTML(argument.placeholder)}" ${item.enabled ? '' : 'disabled'}>` : `<span class="form-note" id="manual-input-${index}-${n}">${escapeHTML(DAQ_ARGUMENT_SOURCES[argument.source] || argument.source)}</span>`}</div>`).join('') : ''}
    <button class="button primary small section" type="submit" ${item.enabled ? '' : 'disabled'}>Run API</button></form>
    <section class="manual-api-response"><h3>Output</h3><p class="manual-result-status form-note" role="status">Run this API to display its response.</p><pre class="manual-api-output"></pre></section></div></section>`).join('') || `<div class="panel panel-body"><p class="muted">No manual APIs configured.</p><a class="button small" href="${base.replace('/api/','/')}/edit">Edit configuration</a></div>`;
  let visible=false,destroyed=false;
  const requests=new Map();
  const busy=()=>[...requests.values()].some(item=>!item.timings.includes('always'));
  const notify=()=>{if(isLive() && root.isConnected)onBusyChange();};
  function allowed(item){
    const timings=item.timings || ['always'],snapshot=getState();
    const state=snapshot?.connected ? snapshot.state?.state : 'unknown';
    return item.enabled && (timings.includes('always') || (!snapshot?.active_operation && !snapshot?.manual_api_pending && !busy() &&
      ((timings.includes('running') && ['running','nssta'].includes(state)) || (timings.includes('idle') && state==='stopped'))));
  }
  function update(){
    root.querySelectorAll('form').forEach(form=>{
      const item=items[Number(form.dataset.apiIndex)],button=form.querySelector('button');
      button.disabled=form.dataset.pending==='true' || !allowed(item);
      button.title=!item.enabled ? 'Disabled in Edit configuration' : !allowed(item) ? 'Unavailable in the current DAQ state, or another operation is pending' : '';
    });
  }
  root.querySelectorAll('form').forEach(form=>form.onsubmit=async event=>{
    event.preventDefault();
    const index=Number(form.dataset.apiIndex),item=items[index],button=form.querySelector('button');
    if(!allowed(item) || button.disabled || !visible)return;
    const signal=new AbortController();
    const panel=form.closest('[data-api-index].manual-api-panel');
    const output=panel.querySelector('.manual-api-output'),status=panel.querySelector('.manual-result-status');
    requests.set(signal,item);form.dataset.pending="true";update();notify();
    status.textContent='Requesting…';status.className='manual-result-status form-note';output.textContent='';
    try{
      const arguments_=Object.fromEntries([...form.querySelectorAll('[data-custom]')].map(input=>[input.dataset.custom,input.value]));
      const result=await api(`${base}/manual/${index}`,{method:'POST',body:{revision,arguments:arguments_},signal:signal.signal});
      if(!isLive() || destroyed)return;
      status.textContent=(result.success ? 'Completed' : 'Failed')+(result.http_status ? ` · HTTP ${result.http_status}` : '')+` · ${formatTime(result.checked_at)}`;
      status.className='manual-result-status form-note '+(result.success ? '' : 'error-text');
      output.textContent=result.error || (typeof result.data==='string' ? result.data : JSON.stringify(result.data,null,2));
    }catch(error){
      if(error.name!=='AbortError' && isLive() && !destroyed){status.textContent=error.message;status.className='manual-result-status form-note error-text';}
    }finally{
      requests.delete(signal);form.dataset.pending="false";
      if(!destroyed){update();notify();}
    }
  });
  function stop(){destroyed=true;for(const request of requests.keys())request.abort();requests.clear();}
  update();
  return {activate(active){visible=active;update();},update,busy,destroy:stop};
}
