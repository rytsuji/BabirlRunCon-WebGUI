"use strict";

function runNumber(value) {
  if (value === undefined || value === null || value === "") return "—";
  return String(value).padStart(4, "0");
}

function escapeRunHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function formatDAQ(value, key = "") {
  const esc = escapeRunHTML;
  const labels = {runinfo:"Run",runnumber:"Run Number",runname:"Run Name",startdate:"Start Time",stopdate:"Stop Time",
    runstatus:"DAQ State",eflist:"Event Senders",hdlist:"Storage",mtlist:"Tape Devices",ebinfo:"Event Builder",
    ssminfo:"SSM",efn:"ES Number",hdn:"Disk Number",onoff:"Enabled",evtn:"Events",es_event_num:"ES Events",
    event_num:"EB Events",daq_config:"DAQ Configuration",config_snapshot:"Experiment Configuration"};
  const label = text => esc(labels[text] || text.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  if (value === null || value === undefined) return '<span class="muted">—</span>';
  if (typeof value !== "object") return esc(key === "runnumber" || key === "current_number" ? runNumber(value) : value);
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="muted">None</span>';
    if (value.every(v => v && typeof v === "object" && !Array.isArray(v))) {
      const keys = [...new Set(value.flatMap(v => Object.keys(v)))];
      return `<div class="table-scroll"><table class="daq-table"><thead><tr>${keys.map(k => `<th>${label(k)}</th>`).join("")}</tr></thead><tbody>${value.map(row => `<tr>${keys.map(k => `<td>${formatDAQ(row[k],k)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return value.map(v => formatDAQ(v,key)).join(", ");
  }
  return `<dl class="daq-fields">${Object.entries(value).map(([k,v]) => `<dt>${label(k)}</dt><dd>${formatDAQ(v,k)}</dd>`).join("")}</dl>`;
}

function runSummary(record) {
  const run = record.daq_config?.runinfo || {};
  return {...record, runname:run.runname ?? record.runname, runnumber:run.runnumber ?? record.runnumber,
    header:run.header ?? record.header, started_at:run.startdate ?? record.started_at, finished_at:run.stopdate ?? record.finished_at};
}

function runDownload(record) {
  // No UI-only fields, database keys, UUIDs, or duplicated snapshots.
  return {mode:record.mode,status:record.status,daq_config:record.daq_config,
    event_num:record.event_num,es_event_num:record.es_event_num,config_snapshot:record.config_snapshot,
    ...(record.error ? {error:record.error} : {})};
}

function formatESCounters(counters, efInfo = []) {
  const esc = escapeRunHTML;
  const items = Object.entries(counters || {}).map(([key,value]) => {
    const info = efInfo.find(ef => String(ef.efn ?? ef.id) === key || ef.host === key) || {};
    return value && typeof value === "object" ? value : {efn:info.efn ?? info.id ?? key,name:info.name || key,evtn:value};
  });
  if (!items.length) return '<span class="muted">No ES counts available</span>';
  return items.map(item => `<span class="es-counter"><span class="muted">ES ${esc(item.efn ?? "—")}</span><span title="${esc(item.host || "")}">${esc(item.name || item.host || "—")}</span><strong>${item.evtn == null ? "—" : esc(Number(item.evtn).toLocaleString())}</strong></span>`).join("");
}

function formatConfigChanges(current,previous,kind,currentES,previousES) {
  const key={eflist:'eflist',hdlist:'hdlist',ssm:'ssminfo'}[kind];
  const select=(value,es)=>kind==='es' ? es : key ? value?.[key] : value;
  function fields(value,path='',out={}) {
    if(value && typeof value==='object' && Object.keys(value).length){
      if(Array.isArray(value))value.forEach((item,index)=>fields(item,`${path}${item?.efn!=null ? 'ES '+item.efn : item?.hdn!=null ? 'Disk '+item.hdn : '['+index+']'}`,out));
      else Object.entries(value).forEach(([name,item])=>fields(item,path ? path+' / '+name : name,out));
    }else out[path || 'Value']=value;
    return out;
  }
  const now=fields(select(current,currentES)),old=fields(select(previous,previousES));
  const keys=[...new Set([...Object.keys(now),...Object.keys(old)])];
  const changed=name=>JSON.stringify(now[name])!==JSON.stringify(old[name]);
  const display=(values,name)=>Object.prototype.hasOwnProperty.call(values,name) ? formatDAQ(values[name],name.split(' / ').pop()) : '<span class="muted">Not present</span>';
  return `<p class="small-text">${keys.filter(changed).length} changed fields · highlighted</p><div class="config-diff-wrap"><table class="config-diff"><thead><tr><th>Field</th><th>Current</th><th>Previous</th></tr></thead><tbody>${keys.map(name=>`<tr class="${changed(name) ? 'config-changed' : ''}"><th>${escapeRunHTML(name.replace(/_/g,' '))}</th><td>${display(now,name)}</td><td>${display(old,name)}</td></tr>`).join('')}</tbody></table></div>`;
}

if (typeof module !== "undefined") module.exports = {runNumber,formatDAQ,runSummary,runDownload,formatESCounters,formatConfigChanges};
