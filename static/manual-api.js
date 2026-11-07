"use strict";

const DAQ_ARGUMENT_SOURCES={runname:'Run name',runnumber:'Current Run number',header:'Header',event_num:'Event count',start_time:'Start time (babirl)',stop_time:'Stop time (babirl)',state:'DAQ state',getconfig_json:'getconfig (JSON)',current_run_json:'Current Run record (JSON)',run_history_json:'Run history: latest 50 (JSON)'};
function argumentDescription(source){
  if(source==='custom')return 'Web GUI input: entered manually in the API tab. The template is a placeholder, never a default value.';
  if(source==='current_run_json' || source==='run_history_json')return 'Web GUI Run records: mode, status, daq_config, event_num, es_event_num, config_snapshot, error (when present). Run history includes the latest 50 records; current Run selects the latest record.';
  if(source==='state')return 'Web GUI state mapped from babirl: stopped (IDLE), running (START), nssta (NSSTA), unknown.';
  if(source==='getconfig_json')return 'babirl: the getconfig JSON response (runinfo, eflist, hdlist and other DAQ settings).';
  return 'babirl: '+({runname:'current Run name.',runnumber:'current Run number, without zero padding.',header:'Run header.',event_num:'current event count.',start_time:'Run start time, formatted by the Web GUI.',stop_time:'Run stop time, formatted by the Web GUI.'}[source] || 'current DAQ value.');
}

function mountManualAPIs({base,items,revision,getState,isLive}){
  const root=document.querySelector('#view-api');
  root.innerHTML=`<div class="manual-api-layout"><section class="panel"><div class="panel-head"><h2>API controls</h2><a class="button small" href="${base.replace('/api/','/')}/edit">Edit configuration</a></div><div class="panel-body" id="manual-api-controls"></div></section><section class="panel"><div class="panel-head"><h2>API output</h2><span id="manual-api-result-name" class="small-text muted"></span></div><div class="panel-body"><p id="manual-api-result-status" class="form-note">Run an API to display its response.</p><pre id="manual-api-result" class="manual-api-output"></pre></div></section></div>`;
  const controls=root.querySelector('#manual-api-controls');
  controls.innerHTML=items.map((item,index)=>`<form class="manual-api-card" data-api-index="${index}"><div class="actions"><h3>${escapeHTML(item.name)}</h3>${pill(item.enabled ? 'ENABLED' : 'DISABLED',item.enabled ? 'green' : '')}</div><p class="form-note">${(item.timings || ['always']).map(value=>({always:'Every time',running:'During running',idle:'During IDLE'}[value])).join(' / ')}</p><p class="form-note mono wrap">${escapeHTML(item.method)} ${escapeHTML(item.api)}</p>${item.send_query_params ? item.query_params.map(argument=>argument.source==='custom' ? `<div class="field"><label>${escapeHTML(argument.name)}<input data-custom="${escapeHTML(argument.name)}" maxlength="65536" placeholder="${escapeHTML(argument.placeholder)}" ${item.enabled ? '' : 'disabled'}></label></div>` : `<p class="form-note"><strong>${escapeHTML(argument.name)}</strong> ← ${escapeHTML(DAQ_ARGUMENT_SOURCES[argument.source] || argument.source)}</p>`).join('') : ''}<button class="button primary small section" type="submit" ${item.enabled ? '' : 'disabled'}>Run API</button></form>`).join('') || '<p class="muted">No manual APIs configured. Add Manual APIs in Edit configuration.</p>';
  let visible=false,generation=0;
  const requests=new Set();
  const output=root.querySelector('#manual-api-result');
  const status=root.querySelector('#manual-api-result-status');
  function allowed(item){
    const timings=item.timings || ['always'],snapshot=getState();
    const state=snapshot?.connected ? snapshot.state?.state : 'unknown';
    return item.enabled && (timings.includes('always') || (timings.includes('running') && ['running','nssta'].includes(state)) || (timings.includes('idle') && state==='stopped'));
  }
  function update(){
    controls.querySelectorAll('form').forEach(form=>{
      const item=items[Number(form.dataset.apiIndex)],button=form.querySelector('button');
      button.disabled=form.dataset.pending==='true' || !allowed(item);
      button.title=!item.enabled ? 'Disabled in Edit configuration' : !allowed(item) ? 'Unavailable in the current DAQ state' : '';
    });
  }
  controls.querySelectorAll('form').forEach(form=>form.onsubmit=async event=>{
    event.preventDefault();
    const index=Number(form.dataset.apiIndex),item=items[index],button=form.querySelector('button');
    if(!allowed(item) || button.disabled || !visible)return;
    const signal=new AbortController(),epoch=generation;
    requests.add(signal);form.dataset.pending="true";button.disabled=true;
    root.querySelector('#manual-api-result-name').textContent=item.name;
    status.textContent='Requesting…';status.className='form-note';output.textContent='';
    try{
      const arguments_=Object.fromEntries([...form.querySelectorAll('[data-custom]')].map(input=>[input.dataset.custom,input.value]));
      const result=await api(`${base}/manual/${index}`,{method:'POST',body:{revision,arguments:arguments_},signal:signal.signal});
      if(!isLive() || !visible || epoch!==generation)return;
      root.querySelector('#manual-api-result-name').textContent=item.name;
      status.textContent=(result.success ? 'Completed' : 'Failed')+(result.http_status ? ` · HTTP ${result.http_status}` : '')+` · ${formatTime(result.checked_at)}`;
      status.className='form-note '+(result.success ? '' : 'error-text');
      output.textContent=result.error || (typeof result.data==='string' ? result.data : JSON.stringify(result.data,null,2));
    }catch(error){
      if(error.name!=='AbortError' && isLive() && visible && epoch===generation){status.textContent=error.message;status.className='form-note error-text';}
    }finally{requests.delete(signal);form.dataset.pending="false";update();}
  });
  function stop(){generation++;if(requests.size){status.textContent="Request cancelled locally. Check the remote API before retrying.";status.className="form-note";}for(const request of requests)request.abort();requests.clear();}
  update();
  return {activate(active){visible=active;if(!active)stop();update();},update,destroy:stop};
}
