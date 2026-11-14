"use strict";
const GUI_BUILD = "v1-20261114-connections-29";

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const html = escapeHTML;
const app = $("#app");
let mode = "http";
let routeVersion = 0;
let pageCleanup=()=>{};
window.addEventListener('pagehide',()=>pageCleanup());
window.addEventListener('pageshow',event=>{if(event.persisted)route();});
let timer = null;
let dirtyEditor = false;
let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {"Content-Type":"application/json", ...options.headers},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = data.detail ?? data.error ?? "Request failed";
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail)
      ? detail.map(x => `${x.loc?.join(".")}: ${x.msg}`).join("; ") : JSON.stringify(detail));
  }
  return data;
}

function toast(message, error = false) {
  const target = $("#toast");
  target.textContent = message;
  target.className = `toast${error ? " error" : ""}`;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, error ? 8000 : 3500);
}

function confirmAction(title, message, label = "Confirm") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-button").textContent = label;
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {once:true});
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}

function pill(text, type = "") {
  return `<span class="pill ${type}"><span class="dot ${type}"></span>${html(text)}</span>`;
}
function statusPill(state) {
  return pill(({stopped:"IDLE",running:"RUNNING",nssta:"NSSTA",unknown:"UNKNOWN"})[state] || state.toUpperCase(),
    ({stopped:"green",running:"blue",nssta:"amber",unknown:"red"})[state] || "");
}
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && date.getFullYear()<=1970) return "—";
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {hour12:false});
}
function pretty(value) { return html(JSON.stringify(value, null, 2)); }
function footer() { return `<footer class="footer"><span>DAQ CONTROL / EXPERIMENT WORKSPACE</span><span>Connected API mode</span></footer>`; }
function crumbs(name, extra = "") {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Experiments</a><span class="sep">/</span>${extra ? `<a href="/experiments/${encodeURIComponent(name.id)}">${html(name.name)}</a><span class="sep">/</span>${extra}` : `<span>${html(name.name)}</span>`}</nav>`;
}

async function navigate(url, replace = false) {
  if (dirtyEditor && !await confirmAction("Unsaved changes", "Leave this page and discard your configuration edits?", "Discard changes")) return;
  dirtyEditor = false;
  if (replace) history.replaceState({}, "", url); else history.pushState({}, "", url);
  window.scrollTo(0, 0);
  await route();
}

document.addEventListener("click", event => {
  const link = event.target.closest("a[href]");
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const url = new URL(link.href, location.href);
  if (url.origin === location.origin && !link.hasAttribute("download") && !link.target) {
    event.preventDefault(); navigate(url.pathname + url.search);
  }
});
window.addEventListener("popstate", () => { dirtyEditor = false; route(); });
window.addEventListener("beforeunload", event => {
  if (dirtyEditor) { event.preventDefault(); event.returnValue = ""; }
});

async function route() {
  pageCleanup();pageCleanup=()=>{};
  clearTimeout(timer);
  $("#top-connections").hidden=true;
  $("#top-experiment").hidden=true;$("#top-experiment").replaceChildren();
  $("#top-edit-config").hidden=true;$("#top-edit-config").removeAttribute("href");
  const version = ++routeVersion;
  app.classList.remove("control-page","config-editor");
  document.body.classList.remove("compact-control");
  try {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "experiments" && parts[1]) {
      const eid = decodeURIComponent(parts[1]);
      const data = await api(`/api/experiments/${encodeURIComponent(eid)}/config`);
      if (version !== routeVersion) return;
      if (parts[2] === "edit") await editorPage(eid, data, version);
      else await controlPage(eid, data.config, version, data.revision);
    } else if (new URLSearchParams(location.search).has("new")) {
      const copyID=new URLSearchParams(location.search).get("copy");
      const copy=copyID ? await api(`/api/experiments/${encodeURIComponent(copyID)}/config`) : null;
      if(version!==routeVersion)return;
      newExperimentPage(copy?.config);
    }
    else await indexPage(version);
  } catch (error) {
    if (version !== routeVersion) return;
    app.innerHTML = `<nav class="breadcrumbs"><a href="/">← Experiments</a></nav><h1>Unable to open this page</h1><p class="error-text">${html(error.message)}</p><button class="button" id="retry-page">Try again</button>`;
    $("#retry-page").onclick = route;
  }
}

async function indexPage(version) {
  const experiments = await api("/api/experiments");
  if (version !== routeVersion) return;
  app.innerHTML = `
    <div class="eyebrow">EXPERIMENT WORKSPACE</div>
    <div class="page-head"><div><h1>Experiments</h1><p class="subtitle">Choose an experiment to monitor and control your DAQ.</p></div><a class="button primary" href="/?new=1"><span>＋</span> New experiment</a></div>
    <div class="experiment-grid">${experiments.map(exp => `
      <article class="panel experiment-card">
        <div class="actions" style="justify-content:space-between"><span class="server-icon" aria-hidden="true">▤</span></div>
        <div class="card-title"><h2>${html(exp.name)}</h2>${exp.error ? pill("CONFIG ERROR","red") : exp.active_operation ? pill("BUSY","blue") : pill("READY")}</div>
        <p class="card-description">${html(exp.error || exp.description || "No description provided.")}</p>
        <div class="card-footer"><span class="small-text muted">${html(exp.eb?.name || "—")} <span class="mono">${html(exp.eb?.host || "")}</span></span>
        <div class="actions">${exp.error ? "" : `<a class="button small" href="/?new=1&amp;copy=${encodeURIComponent(exp.id)}">Copy</a>`}<button class="button small" data-delete="${html(exp.id)}">Delete</button>${exp.error ? "" : `<a class="button text" href="/experiments/${encodeURIComponent(exp.id)}/edit">Edit config</a><a class="button" href="/experiments/${encodeURIComponent(exp.id)}">Open control <span>↗</span></a>`}</div></div>
      </article>`).join("") || `<div class="panel panel-body"><p class="muted">No experiments yet. Create your first experiment to get started.</p></div>`}</div>
    <div class="index-note"><span>ⓘ</span><span>Each experiment keeps its own configuration and database. Opening a control page does not change DAQ settings.</span></div>${footer()}`;
  app.querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{
    try {
      const eid=button.dataset.delete;
      const name=experiments.find(experiment=>experiment.id===eid)?.name || "this experiment";
      if(!await confirmAction("Delete experiment?",`Remove ${name} and its configuration/history from the experiment list? DAQ processes will not be stopped. Files are retained in experiments/.trash for recovery.`,"Delete experiment"))return;
      const latest=await api(`/api/experiments/${encodeURIComponent(eid)}/config`);
      await api(`/api/experiments/${encodeURIComponent(eid)}`,{method:"DELETE",body:{confirmation:eid,revision:latest.revision}});
      toast("Experiment deleted");await route();
    }catch(error){toast(error.message,true);}
  });

}

function newExperimentPage(copyConfig=null) {
  app.innerHTML = `${crumbs({name:"New experiment",id:""})}<div class="page-head"><div><h1>New experiment</h1><p class="subtitle">${copyConfig ? 'Copy settings into a new experiment. ID, name and description start blank; Run history is not copied.' : 'Create an independent configuration and Run database.'}</p></div></div>
    <form id="new-form" class="panel new-form"><div class="panel-body">
      <div class="field"><label for="new-id">Experiment URL path (ID)</label><input id="new-id" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" placeholder="physics_2026"><p class="form-note">${html(location.origin)}/experiments/&lt;ID&gt; · Leave blank to generate automatically. Use letters, numbers, hyphens and underscores.</p></div>
      <div class="field"><label for="new-name">Name</label><input id="new-name" required maxlength="200" placeholder="Experiment name"></div>
      <div class="field"><label for="new-description">Description</label><textarea id="new-description" placeholder="A short description of this experiment"></textarea></div>
      <div class="two-columns"><div class="field"><label for="new-eb">Event Builder name</label><input id="new-eb" required value="EventBuilder"></div><div class="field"><label for="new-host">Event Builder host</label><input id="new-host" required placeholder="EBserver"></div></div>
      <div class="field"><label for="new-api">Run Control API · base URL</label><input id="new-api" type="url" required placeholder="http://APIserver:5000"></div>
      <div class="field"><label class="check-label"><input id="new-nssta" type="checkbox" checked>Enable NSSTA (non-saving acquisition)</label></div>
      <p class="form-note">Restart, pre-run and post-run API hooks can be added in the configuration editor.</p>
      </div><div class="panel-foot actions end"><a class="button" href="/">Cancel</a><button class="button primary" type="submit">Create experiment</button></div></form>${footer()}`;
  if(copyConfig){
    $("#new-eb").value=copyConfig.eb.name;$("#new-host").value=copyConfig.eb.host;
    $("#new-api").value=copyConfig.run_control_api.api;$("#new-nssta").checked=copyConfig.run_control_api.enable_nssta;
  }
  $("#new-form").onsubmit = async event => {
    event.preventDefault(); const button = $("button[type=submit]", event.target); button.disabled = true;
    try {
      const config = {...(copyConfig ? structuredClone(copyConfig) : {}),experiment:{name:$("#new-name").value.trim(),description:$("#new-description").value},
        eb:{name:$("#new-eb").value.trim(),host:$("#new-host").value.trim()},
        run_control_api:{...(copyConfig?.run_control_api || {}),name:copyConfig?.run_control_api.name || $("#new-eb").value.trim(),api:$("#new-api").value.trim(),enable_nssta:$("#new-nssta").checked}};
      const id = $("#new-id").value.trim();
      if(id) config.experiment.id = id;
      const result = await api("/api/experiments", {method:"POST",body:config});
      toast("Experiment created"); await navigate(`/experiments/${result.id}`);
    } catch (error) { toast(error.message,true); button.disabled = false; }
  };
}

async function controlPage(eid, config, version, revision) {
  const base = `/api/experiments/${encodeURIComponent(eid)}`;
  let historyMode = "saved", restartOverride=false, configView=null;
  let stopWaitStarted=null, stopWaitTicker=null, stopWaitId=null;
  let lastErrorSignature='', lastRestartFinished=null, lastTransitionId=null;
  let current = null, historyData = {runs:[], recall:{runs:[]}, operations:[]};
  let draftDirty = false, headerDirty = false, pending = false, historyError = "", refreshRequested = true, loadedHistoryVersion = null, connectionsRequested = true, forceConnections=false;
  app.classList.add("control-page");
  document.body.classList.add("compact-control");
  $("#top-experiment").innerHTML=`<h1>${html(config.experiment.name)}</h1><p>${html(config.experiment.description)}</p>`;
  $("#top-experiment").hidden=false;
  $("#top-edit-config").href=`/experiments/${encodeURIComponent(eid)}/edit`;
  $("#top-edit-config").hidden=false;
  app.innerHTML = `
    <nav class="tabs" role="tablist" aria-label="Control modules"><button class="tab active" id="tab-control" role="tab" aria-selected="true" aria-controls="view-control">Run Control</button><button class="tab" id="tab-api" role="tab" aria-selected="false" aria-controls="view-api">API</button><button class="tab" id="tab-history" role="tab" aria-selected="false" aria-controls="view-history">Run History</button></nav>
    <div id="connection-warning" class="section" hidden></div>
    <div id="control-errors" class="notice red section" role="alert" hidden></div>
    <div id="view-control" role="tabpanel" aria-labelledby="tab-control" class="control-workspace">
      <section class="panel connection-panel"><div class="panel-head"><h2>Connections</h2><button class="button small" id="refresh-connections">↻ Refresh</button></div><div class="panel-body">
        <div class="connection-row"><div><span class="connection-label">RUN CONTROL API</span><span class="connection-address mono">${html(config.run_control_api.api)}</span></div><span id="api-connection">${pill("CHECKING")}</span></div>
        <div class="connection-row"><div><span class="connection-label">EVENT BUILDER / BABILD</span><span class="connection-address">${html(config.eb.name)} <span class="mono muted">${html(config.eb.host)}</span></span></div><span id="connection">${pill("CHECKING")}</span></div>
        <details id="es-connection-details" class="es-connection-details"><summary><span>Event Senders · ON / SCR / PAS</span><span class="es-summary-actions"><span id="es-connection-lamp">${pill("ES NOT CHECKED")}</span><button id="esconnect" class="button small" type="button">esconnect</button></span></summary><div id="es-connection-list" class="es-connection-list"></div></details><p class="form-note" id="connection-checked">Read-only checks on access, transitions and Refresh; every 2s while IDLE. esconnect is manual only.</p>
      </div></section>
      <section class="panel operation-panel"><div class="panel-head"><h2>Operation</h2><span id="operation-status" class="operation-status">No active operation</span></div><div class="panel-body" id="operation-body"><div class="step-empty">Ready. Operation progress will appear here.</div></div></section>
      <section class="panel run-settings-panel"><div class="panel-head"><h2>Run control</h2><span class="small-text muted">Configure · acquire · stop</span></div><div class="panel-body">
        <div class="field recall-field"><label for="recall">Recall saved Run</label><select id="recall"><option value="">Choose a saved Run name…</option></select></div>
        <div class="field-row"><div class="field"><label for="run-name">Run name</label><input id="run-name" autocomplete="off" placeholder="physics" maxlength="79"></div><div class="field"><label for="run-number">Current number</label><input id="run-number" type="number" min="0" max="2147483647" step="1"></div></div>
        <div class="actions apply-row"><button class="button small" id="apply-run" disabled>Set Run Name / Number</button><span class="form-note" id="draft-status">Current controller values</span></div>
        <div class="field header-field"><div class="comment-label-row"><label for="run-header">Header<span class="comment-bytes" id="header-limit"><span id="header-bytes">0</span> / 79 bytes</span></label><label class="check-label lock-switch comment-lock" id="header-lock-control" hidden><input type="checkbox" role="switch" id="header-edit" aria-label="Edit Header"><span id="header-lock-state">Locked</span><span class="comment-lock-note">(next Start)</span></label></div><textarea id="run-header" aria-label="Header" aria-describedby="header-limit" maxlength="79" rows="2" placeholder="Describe this Run"></textarea></div>
        <div class="field ender-field"><div class="comment-label-row"><label for="run-ender">Ender<span class="comment-bytes" id="ender-limit"><span id="ender-bytes">0</span> / 79 bytes</span></label><label class="check-label lock-switch comment-lock" id="ender-lock-control" hidden><input type="checkbox" role="switch" id="ender-edit" aria-label="Edit Ender"><span id="ender-lock-state">Locked</span><span class="comment-lock-note">(next Stop)</span></label></div><textarea id="run-ender" aria-label="Ender" aria-describedby="ender-limit" maxlength="79" rows="2" placeholder="Comment saved when the Run stops"></textarea></div>
        <div class="run-timer"><div class="timer-heading"><label class="check-label timer-switch"><input type="checkbox" role="switch" id="timer-enabled">Timer</label><span id="timer-status" class="small-text muted" role="status"></span></div><div id="timer-options" hidden><div class="timer-duration"><label>h<input class="input" id="timer-hours" type="number" min="0" max="8760" step="1" value="0"></label><label>min<input class="input" id="timer-minutes" type="number" min="0" max="59" step="1" value="1"></label><label>sec<input class="input" id="timer-seconds" type="number" min="0" max="59" step="1" value="0"></label><label class="check-label timer-switch"><input type="checkbox" role="switch" id="timer-repeat">Repeat</label></div><div id="timer-repeat-options" class="timer-repeat-options" hidden><label>Total Runs<input class="input" id="timer-count" type="number" min="1" max="1000000" step="1" value="2"></label><span id="timer-progress" class="small-text">Completed 0 / 2</span></div></div></div>
        <div class="control-actions ${config.run_control_api.enable_nssta ? "" : "two-actions"}"><button class="button start-button" id="start" disabled>▶ Start</button><button class="button stop-button" id="stop" disabled>■ Stop</button>${config.run_control_api.enable_nssta ? `<button class="button nssta-button" id="nssta" disabled>▷ NSSTA</button>` : ""}<button class="button stop-button" id="manual-stop" hidden disabled>■ Manual Stop</button></div>
        <p id="stop-wait" class="form-note mono" role="status" aria-live="polite" hidden></p>
        <div class="restart-row"><div><h3>Restart DAQ</h3></div><button class="button restart-button" id="restart" disabled>↻ Restart DAQ</button></div>
      </div></section>
      <section class="panel overview-panel"><div class="panel-head"><h2>Run overview</h2><div class="actions"><button class="button small" id="refresh-snapshot">↻ Refresh</button><span id="daq-state">${pill("CONNECTING")}</span></div></div><div class="panel-body">
        <div class="stat-grid"><div><div class="stat-label">RUN NAME</div><div class="stat-value" id="live-name">—</div></div><div><div class="stat-label">CURRENT NUMBER</div><div class="stat-value" id="live-number">—</div></div><div><div class="stat-label">EVENTS</div><div class="stat-value blue" id="live-events">—</div></div></div>
        <dl class="detail-list"><dt>Header</dt><dd id="live-header">—</dd><dt>Ender</dt><dd id="live-ender">—</dd><dt>Start time</dt><dd id="live-start">—</dd><dt>Stop time</dt><dd id="live-stop">—</dd></dl>
        <div id="es-counters" class="es-counters" aria-label="ES event counts"></div><div class="divider"></div><div class="actions"><button class="button small" id="show-config" aria-expanded="false" aria-controls="config-details">DAQ configuration</button><button class="button small" id="show-config-json" aria-expanded="false" aria-controls="config-details">DAQ configuration (JSON)</button></div><div id="config-details" hidden><div id="live-config" class="daq-format">Waiting for DAQ…</div></div>
        <p id="acquisition-warning" class="form-note error-text" hidden></p>
      </div><div class="panel-foot small-text muted" id="last-checked">Values are read from the DAQ controller.</div></section>
    </div>
    <section id="view-api" role="tabpanel" aria-labelledby="tab-api" class="section" hidden></section>
    <section id="view-history" role="tabpanel" aria-labelledby="tab-history" class="panel section" hidden><div class="panel-head"><h2>Run history</h2><label class="actions">Mode <select id="history-mode" class="input"><option value="saved" selected>Saved</option><option value="nssta">NSSTA</option><option value="all">All</option></select></label></div><p id="history-error" class="notice amber" hidden></p><div class="table-scroll"><table><thead><tr><th>Run</th><th>Mode</th><th>Header</th><th>Ender</th><th>Started</th><th>Status</th><th></th></tr></thead><tbody id="run-history"><tr><td colspan="7" class="empty-cell">No recorded Runs yet.</td></tr></tbody></table></div></section>${footer()}`;

  const workspace=$("#view-control");
  for(const panelNames of [["run-settings-panel","operation-panel"],["overview-panel","connection-panel"]]){
    const column=document.createElement("div");column.className="control-column";
    for(const name of panelNames)column.appendChild(workspace.querySelector("."+name));
    workspace.appendChild(column);
  }

  let monitorRevision=revision;
  const monitors=mountMonitors({workspace,base,items:config.monitor_api,revision,isLive:()=>version===routeVersion});
  function monitorContext(){
    const transition=historyData.operations.find(op=>['start','nssta','stop','restart'].includes(op.action) && op.finished_at)?.id || '';
    monitors.context(selectedModule==='control' && !document.hidden,current?.connected && !current.active_operation ? current.state.state : 'unknown',
      current?.state?.runname!=null,transition);
  }
  document.addEventListener('visibilitychange',monitorContext);
  pageCleanup=()=>{monitors.destroy();document.removeEventListener('visibilitychange',monitorContext);};
  const utilities = mountWebutil({eid,config,isLive:()=>version===routeVersion,getState:()=>current,
    onMutate:()=>{refreshRequested=true;poll();},
    checkConnections:async()=>{
      const result=await api(base+"/connections/refresh",{method:"POST"});
      refreshRequested=true;poll();return result;
    }});
  const manualAPIs=mountManualAPIs({base,items:config.manual_api || [],revision,getState:()=>current,onBusyChange:()=>{controls();poll();},isLive:()=>version===routeVersion});
  const controlCleanup=pageCleanup;pageCleanup=()=>{manualAPIs.destroy();controlCleanup();};
  let selectedModule = "control";
  monitorContext();
  function selectTab(name, focus = false) {
    const returningToControl = name === "control" && selectedModule !== "control";
    selectedModule = name;
    for (const key of utilities.ids) {
      const selected = key === name, button = $("#tab-" + key);
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      $("#view-" + key).hidden = !selected;
      if (selected && focus) button.focus();
    }
    utilities.activate(name);
    manualAPIs.activate(name==="api");
    monitorContext();
    if(returningToControl) { connectionsRequested=true;forceConnections=true; refreshRequested=true; poll(); }
  }
  for (const name of utilities.ids) {
    const tab = $("#tab-" + name);
    tab.onclick = () => selectTab(name);
    tab.onkeydown = event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index=utilities.ids.indexOf(name), direction=event.key==="ArrowLeft" ? -1 : 1;
        selectTab(event.key==="Home" ? utilities.ids[0] : event.key==="End" ? utilities.ids.at(-1) : utilities.ids[(index+direction+utilities.ids.length)%utilities.ids.length],true);
      }
    };
  }
  selectTab("control");
  $("#history-mode").onchange=()=>{historyMode=$("#history-mode").value;loadedHistoryVersion=null;$("#run-history").innerHTML='<tr><td colspan="7">Loading Runs…</td></tr>';poll();};
  $("#refresh-connections").onclick = () => { connectionsRequested = true; forceConnections=true; refreshRequested = true; poll(); };
  $("#esconnect").onclick=async event=>{
    event.preventDefault();event.stopPropagation();
    try{await api(base+'/connections/connect',{method:'POST'});connectionsRequested=true;refreshRequested=true;await poll();}
    catch(error){toast(error.message,true);}
  };
  $("#refresh-snapshot").onclick = () => { refreshRequested = true; poll(); };

  const runTimer=mountRunTimer({root:app,base,request:api,onChange:controls,onError:message=>toast(message,true)});

  function controls() {
    const availability = daqControlState({status:current ? {...current,restart_unlocked:restartOverride || current.restart_unlocked} : {restart_unlocked:restartOverride},pending,draftDirty,
      header:$("#run-header").value,runname:$("#run-name").value,
      runnumber:$("#run-number").value,restartConfigured:config.restart_api.some(hook=>hook.enabled!==false) || ["babinfo","babild","babissm","babian"].some(name=>config.babimo?.[name])});
    $("#header-bytes").textContent = availability.bytes;
    const manualLocked=manualAPIs.busy() || !!current?.manual_api_pending;
    const lockReason=manualLocked ? "Waiting for a manual API response. Run controls are locked until completion or timeout." : "";
    const enderBytes=new TextEncoder().encode($("#run-ender").value).length;
    $("#ender-bytes").textContent=enderBytes;
    const enderReason=enderBytes>79 || $("#run-ender").value.includes("\0") ? "Ender must be at most 79 UTF-8 bytes, without NUL." : "";
    for (const [id,reason] of [["start",availability.startReason],["nssta",availability.startReason],
      ["stop",availability.stopReason],["apply-run",availability.setReason],["restart",availability.restartReason]]) {
      const button = $("#" + id);
      if (button) { const blocked=lockReason || reason || (id==="stop" ? enderReason : "");button.disabled = !!blocked; button.title = blocked || "Ready"; }
    }
    if(runTimer.active()){
      for(const id of ['start','nssta','apply-run']){const button=$('#'+id);if(button)button.disabled=true;}
      if(runTimer.finishRequested())$('#stop').disabled=true;
      else if(runTimer.defersStop() && !$('#stop').disabled)$('#stop').title='Finish the current timed Run, then end repetition.';
    }
    $('#manual-stop').disabled=manualLocked || !!availability.stopReason || !!enderReason;
    $('#manual-stop').title='Send Stop immediately and reset timer counts.';
    $("#esconnect").disabled=manualLocked || pending || !!current?.active_operation || current?.state?.state!=='stopped' || !current?.connected || !!current?.eb_owner || current?.state?.target?.allow_writes===false;
    for (const selector of ["#run-name","#run-number","#recall"]) $(selector).disabled = runTimer.active() || manualLocked || !availability.editable;
    $("#draft-status").textContent = draftDirty ? "Edited · set before Start" : "Current controller values";
    $("#draft-status").style.color = draftDirty ? "var(--amber)" : "";
    const commentBlocked=manualLocked || pending || !!current?.eb_owner || current?.state?.target?.allow_writes===false;
    const headerEditable=runTimer.active() ? !runTimer.repeating() || $("#header-edit").checked : availability.editable;
    $("#run-header").disabled=commentBlocked || !headerEditable;
    $("#run-ender").disabled=commentBlocked || (runTimer.repeating() && !$("#ender-edit").checked) || (!runTimer.active() && !!current?.active_operation);
    if(runTimer.repeating() && !$("#header-edit").checked)$("#run-header").disabled=true;
  }

  function renderLiveConfig() {
    const raw=current?.state?.raw_config || {};
    $("#config-details").hidden=configView===null;
    $("#live-config").innerHTML=configView==="json"
      ? `<pre class="raw-json">${html(JSON.stringify(raw,null,2))}</pre>` : formatDAQ(raw);
    for(const [id,view] of [["show-config","details"],["show-config-json","json"]]){
      const selected=configView===view, button=$("#"+id);
      button.setAttribute("aria-expanded",String(selected));
      button.classList.toggle("primary",selected);
    }
  }
  for(const [id,view] of [["show-config","details"],["show-config-json","json"]]){
    $("#"+id).onclick=()=>{configView=configView===view ? null : view;renderLiveConfig();};
  }

  for (const selector of ["#run-name","#run-number"]) $(selector).addEventListener("input", () => {
    draftDirty = $("#run-name").value !== current?.state?.runname || Number($("#run-number").value) !== current?.state?.runnumber;
    controls();
  });
  $("#run-ender").addEventListener("input",()=>{runTimer.changeComment("ender",$("#run-ender").value);controls();});
  $("#run-header").addEventListener("input", () => { headerDirty = true;runTimer.changeComment("header",$("#run-header").value); controls(); });
  $("#recall").onchange = () => {
    const memory = historyData.recall.runs[Number($("#recall").value)];
    if ($("#recall").value === "" || !memory) return;
    $("#run-name").value = memory.name; $("#run-number").value = memory.current_number;
    $("#run-header").value = memory.prev_header; headerDirty = true;
    draftDirty = memory.name !== current?.state?.runname || memory.current_number !== current?.state?.runnumber;
    controls(); toast("Saved values loaded into the form. Nothing has been sent to DAQ.");
  };
  $("#apply-run").onclick = async () => {
    const runname = $("#run-name").value.trim(), runnumber = Number($("#run-number").value);
    if (!runname || /\s/.test(runname) || !Number.isInteger(runnumber) || runnumber < 0) return toast("Enter a one-token Run name and a nonnegative integer.",true);
    if (!await confirmAction("Set Run Name / Number?", `Set the controller's Run name to ${runname} and current number to ${runnumber}?`, "Set values")) return;
    pending = true; controls();
    try { await api(base+"/run-config", {method:"POST",body:{runname,runnumber}}); draftDirty = false; toast("Run settings applied"); }
    catch (error) { toast(error.message,true); }
    finally { pending = false; await poll(); }
  };

  function clearStopWait() {
    clearTimeout(stopWaitTicker);stopWaitStarted=null;
    if(version===routeVersion && $("#stop-wait"))$("#stop-wait").hidden=true;
  }
  function updateStopWait() {
    if(version!==routeVersion || stopWaitStarted===null)return;
    const limit=config.run_control_api.stop_timeout ?? 10;
    const elapsed=Math.floor((performance.now()-stopWaitStarted)/1000);
    $("#stop-wait").hidden=false;
    $("#stop-wait").textContent=`Stop sent · verifying DAQ / ES… ${elapsed} s / ${limit} s`;
    if(elapsed<limit)stopWaitTicker=setTimeout(updateStopWait,1000);
  }
  async function performAction(action,immediate=false) {
      if(action==='stop' && !immediate && runTimer.defersStop()){
        try{await runTimer.finish();}catch(error){toast(error.message,true);}
        return;
      }
      let timerSpec=null;
      if(['start','nssta'].includes(action)){
        try{timerSpec=runTimer.spec();}catch(error){toast(error.message,true);return;}
      }
      if (action === "restart" && !await confirmAction(restartOverride ? "Emergency Restart DAQ?" : "Restart DAQ?", restartOverride ? "Stop was not confirmed. Restart babinfo and babild, plus the selected processes and Restart APIs, even if acquisition is still running? The unfinished Run will be interrupted after DAQ is verified idle. Post-run APIs will not run." : "Restart the selected processes and configured Restart APIs? Any unfinished Run will be closed only after DAQ is verified idle.", "Restart DAQ")) return;
      if(["start","nssta"].includes(action))runTimer.starting();
      pending = true; controls();
      if(action==="stop"){clearStopWait();stopWaitStarted=performance.now();stopWaitId=null;updateStopWait();}
      try {
        const accepted=await api(base+"/actions", {method:"POST",body:{action,header:$("#run-header").value,ender:action==="stop" || timerSpec ? $("#run-ender").value : "",...(timerSpec ? {timer:timerSpec} : {}),force_restart:action==="restart" && restartOverride}});
        if(action==="stop"){
          stopWaitId=accepted.id;
          restartOverride=false;
        }
        if(["start","nssta","restart"].includes(action))restartOverride=false;
        if(action==="restart"){
          clearStopWait();
          $("#control-errors").hidden=true;
          $("#control-errors").innerHTML="";
          $("#connection-warning").hidden=true;
        }
        $("#toast").hidden=true;
        if (action === "start" || action === "nssta") headerDirty = false;
      } catch (error) { if(action==="stop")clearStopWait();toast(error.message,true); }
      finally { pending = false; await poll(); }
  }
  for(const action of ["start","stop","nssta","restart"]){
    const button=$("#"+action);if(button)button.onclick=()=>performAction(action);
  }
  $("#manual-stop").onclick=()=>performAction("stop",true);

  function renderOperation(op) {
    if (!op) return;
    $("#operation-status").textContent = op.status.toUpperCase();
    const container = $("#operation-body");
    const open = new Set([...container.querySelectorAll("details[open]")].map(el => el.dataset.step));
    container.innerHTML = `<p class="small-text ${op.status === "failed" || op.status === "unknown" ? "error-text" : "muted"}" style="margin:0 0 16px">${html(op.message)}</p><ul class="step-list">${op.steps.map((step,index) => `
      <li class="step-item"><div class="step-main"><span><span class="step-icon ${step.status}">${step.status === "running" ? `<span class="spinner"></span>` : step.status === "succeeded" ? "✓" : "!"}</span>${html(step.name)}</span><span class="operation-status">${html(step.status)}</span></div>
      ${step.api ? `<div class="step-sub mono">${html(step.api)}</div>` : ""}${step.error ? `<p class="small-text error-text">${html(step.error)}</p>` : ""}
      ${step.response ? `<details data-step="${index}" ${open.has(String(index)) ? "open" : ""}><summary>Response / output</summary><pre>${pretty(step.response)}</pre></details>` : ""}</li>`).join("") || `<li class="small-text muted">Waiting to execute…</li>`}</ul>`;
  }

  let polling = false, lastHistory = "", lastVerifiedAt = null;
  async function poll() {
    if (polling || version !== routeVersion) return;
    clearTimeout(timer); polling = true;
    try {
      const refresh = refreshRequested; refreshRequested = false;
      const status = await api(base+"/status" + (refresh ? "?refresh=true" : ""));
      let hist = historyData;
      if (loadedHistoryVersion !== status.history_version || historyError) {
        try {
          const requestedMode=historyMode;
          hist = await api(base+"/history?mode="+requestedMode);
          if(requestedMode!==historyMode){loadedHistoryVersion=null;return;}
          hist.runs = hist.runs.map(runSummary);
          loadedHistoryVersion = status.history_version; historyError = "";
        } catch (error) { historyError = error.message; }
      }
      if (version !== routeVersion) return;
      const readErrors=Object.values(status.state?.acquisition_errors || {});
      const errorSignature=JSON.stringify([status.control_errors || [],readErrors]);
      if(errorSignature!==lastErrorSignature){
        if((status.control_errors || []).length || readErrors.length){connectionsRequested=true;forceConnections=true;}
        lastErrorSignature=errorSignature;
      }
      const restarted=hist.operations.find(op=>op.action==='restart' && op.finished_at);
      const transition=hist.operations.find(op=>['start','nssta','stop','restart'].includes(op.action) && op.finished_at);
      if(transition && transition.id!==lastTransitionId){connectionsRequested=true;lastTransitionId=transition.id;}
      if(restarted && restarted.id!==lastRestartFinished){
        if(lastRestartFinished!==null || status.active_operation?.action==='restart' || Date.now()-Date.parse(restarted.finished_at)<10000){
          setTimeout(()=>{if(version===routeVersion){connectionsRequested=true;refreshRequested=true;poll();}},3000);
        }
        lastRestartFinished=restarted.id;
      }
      if (connectionsRequested && !status.active_operation) {
        connectionsRequested = false;
        const justChecked=status.es_connections?.checked_at && Date.now()-Date.parse(status.es_connections.checked_at)<1000;
        if (status.connected && (forceConnections || !justChecked)) {
          try { status.es_connections = await api(base+"/connections/refresh",{method:"POST"}); }
          catch (error) { status.es_connections = {supported:true,items:[],error:error.message}; }
        }
        forceConnections=false;
      }
      if (version !== routeVersion) return;
      if(status.config_revision && status.config_revision!==monitorRevision){
        monitors.stop();
        const latest=await api(base+'/config');
        if(version!==routeVersion)return;
        monitorRevision=latest.revision;monitors.configure(latest.config.monitor_api,monitorRevision);
      }
      runTimer.update(status.run_timer);runTimer.syncLocks(status);
      current = status;historyData = hist; manualAPIs.update(); monitorContext(); restartOverride=!!status.restart_unlocked;
      const waiting=status.active_operation;
      if(waiting?.wait_started_at){
        clearTimeout(stopWaitTicker);
        const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(waiting.created_at))/1000));
        const recovery=status.stop_recovery;
        const recoveryMessage=status.restart_unlocked ? "Restart DAQ is available." : waiting.action==="stop" && status.control_errors?.length
          ? `Restart DAQ available in ${Math.ceil(recovery?.wait_seconds ?? 0)} s if errors remain.` : "";
        $("#stop-wait").hidden=false;
        $("#stop-wait").textContent=`${waiting.action.toUpperCase()} ${waiting.wait_timed_out ? "timeout" : "pending"} · ${elapsed} s elapsed / ${waiting.wait_timeout_sec} s timeout. ${recoveryMessage}`;
      }else if(status.stop_recovery && status.control_errors?.length && !status.restart_unlocked){
        clearTimeout(stopWaitTicker);
        $("#stop-wait").hidden=false;
        $("#stop-wait").textContent=`Stop failed · ${Math.floor(status.stop_recovery.elapsed_seconds)} s elapsed. Restart DAQ available in ${Math.ceil(status.stop_recovery.wait_seconds)} s if errors remain.`;
      }else{clearStopWait();}
      const retainedErrors=status.control_errors || [];
      $("#control-errors").hidden=!retainedErrors.length;
      $("#control-errors").innerHTML=retainedErrors.map(error=>`<div><strong>${html(error.action.toUpperCase())} failed</strong>${error.messages.map(message=>`<div style="white-space:pre-wrap;overflow-wrap:anywhere">${html(message)}</div>`).join('')}</div>`).join('');
      const liveErrors=[...readErrors,...(status.es_connections?.items || []).filter(item=>item.error).map(item=>item.error)];
      if(liveErrors.length){
        $("#control-errors").hidden=false;
        $("#control-errors").innerHTML+=`<div><strong>ES / DAQ read errors</strong>${[...new Set(liveErrors)].map(message=>`<div style="white-space:pre-wrap;overflow-wrap:anywhere">${html(message)}</div>`).join('')}</div>`;
      }
      if(stopWaitId){
        const attemptedStop=status.active_operation?.id===stopWaitId ? status.active_operation : hist.operations.find(op=>op.id===stopWaitId);
        if(attemptedStop?.stop_confirmed && status.connected && status.state.state==="stopped")clearStopWait();
      }
      $("#history-error").hidden = !historyError;
      $("#history-error").textContent = historyError ? "Run history / recall unavailable: " + historyError : "";
      $("#recall").title = historyError || "Load saved values into the form without changing DAQ.";
      const state = status.state;
      const apiConnection = status.api_connection || {connected:status.connected,error:status.error};
      $("#api-connection").innerHTML = pill(apiConnection.connected ? "API OK" : "API UNAVAILABLE", apiConnection.connected ? "green" : "red");
      $("#api-connection").title = apiConnection.error || "API health check; no DAQ operation is performed.";
      const ebConnection = status.eb_connection || {connected:status.connected,error:status.error};
      $("#connection").innerHTML = pill(ebConnection.connected ? "EB READ OK" : "EB UNAVAILABLE",ebConnection.connected ? "green" : "red");
      $("#connection").title = status.error || "babild configuration was read through the Run Control API. This does not check babimo or babinfo.";
      if (status.connected) lastVerifiedAt = status.snapshot_at;
      $("#connection-checked").textContent = `Connection check: ${formatTime(status.connection_checked_at)} · snapshot`;
      const es = status.es_connections;
      const enabled = (es?.items || []).filter(item => item.enabled);
      $("#es-connection-lamp").innerHTML = !status.connected ? pill('ES UNKNOWN','amber') : !es ? pill("ES NOT CHECKED") : !es.supported ? pill("ES API UPDATE", "amber")
        : es.error ? pill("ES CHECK FAILED", "red") : !enabled.length ? pill("ES NONE ENABLED")
        : pill(`ES ${enabled.filter(item => item.connect === 1).length}/${enabled.length} CONNECTED`,es.all_on_connected ? "green" : "red");
      const topConnections=$("#top-connections");
      topConnections.hidden=false;
      topConnections.innerHTML=$("#api-connection").innerHTML+$("#connection").innerHTML+$("#es-connection-lamp").innerHTML;
      $("#es-connection-list").innerHTML = es?.error ? `<p class="small-text muted">${html(es.error)}</p>` :
        (es?.items || []).map(item => `<div class="es-connection-item ${item.enabled ? "" : "muted"}"><span>ES ${html(item.efn)}</span><span title="${html(item.host)}"><span class="es-mode">${html(normalizeEFMode(item.onoff ?? item.mode) ?? (item.enabled ? "UNKNOWN" : "OFF"))}</span> ${html(item.name || item.host)}</span><span class="${!item.enabled ? 'muted' : item.connect===1 ? 'es-status-connected' : item.connect===0 ? 'es-status-disconnected' : 'es-status-unknown'}">${item.enabled ? (item.connect === 1 ? "● Connected" : item.connect === 0 ? "○ connect=0" : "? Unknown") : "OFF · excluded"}</span>${item.error ? `<span class="error-text">${html(item.error)}</span>` : ""}</div>`).join("") || '<span class="muted">No ES configured</span>';
      $("#daq-state").innerHTML = statusPill(state.state);
      for (const [id,value] of [["live-name",state.runname],["live-number",runNumber(state.runnumber)],["live-events",state.event_num == null ? null : Number(state.event_num).toLocaleString()],["live-header",state.header],["live-ender",state.ender || "—"],["live-start",formatTime(state.start_time)],["live-stop",formatTime(state.stop_time)]]) $("#"+id).textContent = value ?? "—";
      renderLiveConfig();
      $("#es-counters").innerHTML = formatESCounters(state.es_event_num,state.ef_info);
      $("#last-checked").textContent = `Snapshot ${formatTime(status.snapshot_at)} · counters ${formatTime(status.events_at)} · ${config.run_control_api.event_poll_interval_sec ?? 2}s`;
      const errors = state.acquisition_errors || {};
      $("#acquisition-warning").hidden = !Object.keys(errors).length;
      $("#acquisition-warning").textContent = "Some details could not be read: " + Object.values(errors).join("; ");
      if (!draftDirty && status.connected) {
        $("#run-name").value = state.runname; $("#run-number").value = state.runnumber;
      }
      if (!headerDirty && status.connected && !runTimer.active()) $("#run-header").value = state.header || "";
      const warning = $("#connection-warning");
      warning.hidden = true;
      if (!status.connected || status.eb_owner || state.target?.allow_writes === false) {
        warning.hidden = false;
        const canRecover=!status.eb_owner && !status.active_operation && !["running","nssta"].includes(state.state) && state.target?.allow_writes!==false && (config.restart_api.some(hook=>hook.enabled!==false) || ["babinfo","babild","babissm","babian"].some(name=>config.babimo?.[name]));
        const message=status.eb_owner ? `This EB is in use by experiment ${status.eb_owner}.` : state.target?.allow_writes===false ? "The Run Control API has writes disabled. Enable daq.allow_writes on the API server." : !status.connected ? "DAQ cannot be controlled because the connection is unavailable. Try restarting DAQ?" : "";
        warning.innerHTML=`<div class="notice ${!status.connected ? "red" : "amber"}" style="margin:0"><p>${html(message)}</p>${canRecover ? '<div class="actions"><button class="button small" id="recover-daq">Yes, restart DAQ</button></div>' : ''}</div>`;
        if($("#recover-daq"))$("#recover-daq").onclick=()=>{if(!$("#restart").disabled)$("#restart").click();};
      }
      if(status.restart_unlocked){
        warning.hidden=false;
        warning.innerHTML='<div class="notice red">Restart DAQ is available. Waiting does not resend the command. Restart requires manual confirmation.</div>';
      }
      const signature = JSON.stringify([hist,historyMode]);
      if (signature !== lastHistory) {
        lastHistory = signature;
        const selected = $("#recall").value;
        $("#recall").innerHTML = `<option value="">Choose a saved Run name…</option>` + hist.recall.runs.map((r,index) => `<option value="${index}">${html(r.name)} · ${runNumber(r.current_number)}</option>`).join("");
        $("#recall").value = selected;
        $("#run-history").innerHTML = hist.runs.map((run,index) => `<tr><td><strong>${html(run.runname)}</strong> <span class="mono muted">${runNumber(run.runnumber)}</span></td><td>${run.mode === "nssta" ? "NSSTA" : "Saved"}</td><td class="wrap">${html(run.header)}</td><td class="wrap">${html(run.ender || "")}</td><td>${html(formatTime(run.started_at))}</td><td>${pill(run.status, ["completed","stopped"].includes(run.status) ? "green" : run.status === "running" ? "blue" : ["failed","postprocess_failed","unknown"].includes(run.status) ? "red" : "")}</td><td class="actions"><button class="button small" data-inspect="${index}" aria-expanded="false">Details ↓</button><button class="button small" data-history-json="${index}" aria-expanded="false">JSON ↓</button></td></tr><tr id="run-detail-${index}" hidden><td colspan="7"><div class="run-expanded">${formatDAQ(runDownload(run))}</div></td></tr>`).join("") || `<tr><td colspan="7" class="empty-cell">No Runs match this mode.</td></tr>`;
        $("#run-history").querySelectorAll("[data-inspect], [data-history-json]").forEach(button => button.onclick = () => {
          const index=button.dataset.inspect ?? button.dataset.historyJson;
          const row=$("#run-detail-"+index), view=button.dataset.inspect!==undefined ? "details" : "json";
          const close=!row.hidden && row.dataset.view===view;
          const record=runDownload(historyData.runs[Number(index)]);
          row.hidden=close;row.dataset.view=view;
          row.querySelector(".run-expanded").innerHTML=view==="json"
            ? `<pre class="raw-json">${html(JSON.stringify(record,null,2))}</pre>` : formatDAQ(record);
          for(const item of button.parentElement.querySelectorAll("button")){
            const selected=!close && item===button;
            item.setAttribute("aria-expanded",String(selected));
            item.textContent=(item.dataset.inspect!==undefined ? "Details" : "JSON")+(selected ? " ↑" : " ↓");
          }
        });
      }
      renderOperation(status.active_operation || hist.operations[0]); controls(); utilities.updateStatus(status);
    } catch (error) {
      if (version !== routeVersion) return;
      current = null; manualAPIs.update(); monitorContext(); controls(); utilities.updateStatus(null);
      $("#connection").innerHTML = pill("UNKNOWN", "red");
      $("#api-connection").innerHTML = pill("UNKNOWN", "red");
      $("#top-connections").hidden=false;
      $("#top-connections").innerHTML=pill('API UNKNOWN','red')+pill('EB UNKNOWN','red')+pill('ES UNKNOWN','amber');
      $("#connection-checked").textContent = `GUI connection lost · last EB read: ${lastVerifiedAt ? formatTime(lastVerifiedAt) : "not yet verified"} · retrying`;
      $("#daq-state").innerHTML = statusPill("unknown");
      $("#connection-warning").hidden = false;
      $("#connection-warning").innerHTML = `<div class="notice red">${html(error.message)} · Controls are disabled until the connection recovers.</div>`;
    } finally {
      polling = false;
      if (version === routeVersion) timer = setTimeout(poll,1000);
    }
  }
  await poll();
}

async function editorPage(eid, data, version) {
  let config = structuredClone(data.config), revision = data.revision, editorMode = "form", metadataUnlocked = false;
  app.classList.add("config-editor");
  let savedConfig=structuredClone(config), savedYaml=data.yaml, savedOnce=false;
  const configSections=new Map();
  const experimentURL=new URL(data.experiment_path || `/experiments/${encodeURIComponent(eid)}`,location.origin).href;
  app.innerHTML = `${crumbs(config.experiment, "Configuration")}<div class="page-head"><div><div class="eyebrow">EXPERIMENT CONFIGURATION</div><h1>Edit configuration</h1><p class="subtitle">${html(config.experiment.name)} </p></div><a class="button" href="/experiments/${encodeURIComponent(eid)}">← Back to control</a></div>
    <div class="panel panel-body section"><div class="field"><label>Experiment URL</label><a class="mono wrap" href="${html(experimentURL)}" target="_blank" rel="noopener">${html(experimentURL)}</a><p class="form-note">Configured GUI port: ${html(data.server_port ?? location.port)}</p></div></div><div class="editor-layout"><aside class="editor-aside"><h3>Configuration</h3><p>Experiment</p><p>Event Builder</p><p>Run Control API</p><p>babimo · Restart DAQ</p><p>APIs</p><div class="divider"></div><p>Saved to:</p><p class="mono">config/<br>experiment.yaml</p><p>Saving does not contact DAQ. Active operations and unfinished Run records must be resolved first. A backup is kept on save.</p></aside>
    <div class="editor-content"><div class="actions" style="justify-content:space-between"><label class="check-label lock-switch"><input id="metadata-lock" type="checkbox" role="switch">Edit experiment details <span id="metadata-lock-state" class="lock-state">Locked</span></label><div class="editor-switch"><button id="mode-form" class="active" type="button">Form</button><button id="mode-yaml" type="button">YAML</button></div></div>
    <div id="editor-form"></div><div id="editor-yaml" class="field" hidden><label for="yaml-source">experiment.yaml</label><textarea id="yaml-source" class="yaml-editor" spellcheck="false"></textarea></div>
    <section class="panel section"><div class="panel-head"><h2>Configuration history</h2><button class="button small" id="reload-edits">Reload history</button></div><div class="panel-body"><div class="actions history-selection"><label class="check-label"><input type="checkbox" id="select-all-edits">Select all</label><span class="small-text muted" id="selected-edits-count">0 selected</span><button type="button" class="button small danger" id="delete-selected-edits" disabled>Delete selected</button></div><div id="config-edits"></div></div></section>
    <div class="field section"><label for="edit-comment">History comment (optional)</label><input id="edit-comment" maxlength="1000" placeholder="Describe this configuration change"></div><div class="editor-toolbar"><span class="small-text muted" id="save-state">No unsaved changes</span><div class="actions"><a id="editor-back" class="button" href="/experiments/${encodeURIComponent(eid)}">Cancel &amp; Back to control</a><button id="discard-config" class="button danger" type="button" hidden>Discard changes</button><button id="save-config" class="button primary">Save</button></div></div></div></div>${footer()}`;
  $("#yaml-source").value = data.yaml;
  let historyBusy=false;
  const selectedEdits=new Set();
  function updateHistorySelection(){
    const boxes=[...$("#config-edits").querySelectorAll('[data-select-edit]')];
    const all=$("#select-all-edits");
    all.checked=boxes.length>0 && selectedEdits.size===boxes.length;
    all.indeterminate=selectedEdits.size>0 && selectedEdits.size<boxes.length;
    all.disabled=historyBusy || !boxes.length;
    $("#selected-edits-count").textContent=`${selectedEdits.size} selected`;
    $("#delete-selected-edits").disabled=historyBusy || !selectedEdits.size;
    boxes.forEach(box=>{box.checked=selectedEdits.has(Number(box.dataset.selectEdit));box.disabled=historyBusy;});
    $("#config-edits").querySelectorAll('[data-delete-edit]').forEach(button=>button.disabled=historyBusy);
    $("#reload-edits").disabled=historyBusy;
  }
  $("#select-all-edits").onchange=()=>{
    selectedEdits.clear();
    if($("#select-all-edits").checked)$("#config-edits").querySelectorAll('[data-select-edit]').forEach(box=>selectedEdits.add(Number(box.dataset.selectEdit)));
    updateHistorySelection();
  };
  async function deleteHistory(ids){
    if(historyBusy || !ids.length)return;
    historyBusy=true;updateHistorySelection();
    try{
      if(!await confirmAction("Delete configuration history?",`Permanently delete ${ids.length} selected history ${ids.length===1 ? 'entry' : 'entries'}? The current configuration and Run history will not change.`,"Delete history"))return;
      await api(`/api/experiments/${encodeURIComponent(eid)}/config-history/delete`,{method:"POST",body:{ids,revision}});
      ids.forEach(id=>selectedEdits.delete(id));
      toast("Configuration history deleted");await loadEdits();
    }catch(error){toast(error.message,true);}
    finally{historyBusy=false;if(version===routeVersion)updateHistorySelection();}
  }
  $("#delete-selected-edits").onclick=()=>deleteHistory([...selectedEdits]);
  async function loadEdits(){
    const edits=await api(`/api/experiments/${encodeURIComponent(eid)}/config-history`);
    if(version!==routeVersion)return;
    $("#config-edits").innerHTML=edits.map(edit=>`<div class="history-entry"><input type="checkbox" class="history-select" data-select-edit="${edit.id}" aria-label="Select configuration history ${edit.id}"><details><summary>${html(formatTime(edit.created_at))} · ${html(edit.action)}${edit.comment ? " · "+html(edit.comment) : ""}</summary><div class="history-entry-body"><div class="history-comment-row"><label for="history-comment-${edit.id}">History comment</label><input id="history-comment-${edit.id}" maxlength="1000" data-comment="${edit.id}" value="${html(edit.comment || "")}"><button class="button small" data-save-comment="${edit.id}">Save comment</button></div><pre class="history-yaml">${html(edit.yaml)}</pre></div></details><div class="actions history-entry-actions"><button class="button small" data-restore="${edit.id}">Restore this configuration</button><button class="button small danger" data-delete-edit="${edit.id}">Delete</button></div></div>`).join("") || '<p class="form-note">No configuration history.</p>';
    const availableIds=new Set(edits.map(edit=>edit.id));
    for(const id of selectedEdits)if(!availableIds.has(id))selectedEdits.delete(id);
    $("#config-edits").querySelectorAll('[data-select-edit]').forEach(box=>box.onchange=()=>{
      const id=Number(box.dataset.selectEdit);
      if(box.checked)selectedEdits.add(id);else selectedEdits.delete(id);
      updateHistorySelection();
    });
    updateHistorySelection();
    $("#config-edits").querySelectorAll('[data-save-comment]').forEach(button=>button.onclick=async()=>{
      try{
        const id=button.dataset.saveComment;
        await api(`/api/experiments/${encodeURIComponent(eid)}/config-history/${id}`,{method:"PATCH",body:{comment:$("#config-edits").querySelector(`[data-comment="${id}"]`).value}});
        toast("History comment saved");await loadEdits();
      }catch(error){toast(error.message,true);}
    });
    $("#config-edits").querySelectorAll('[data-restore]').forEach(button=>button.onclick=async()=>{
      try{
        const edit=edits.find(item=>item.id===Number(button.dataset.restore));
        if(!await confirmAction("Restore configuration?","Restore the selected revision and replace current settings? Unsaved edits will be discarded. The current saved version remains in history.","Restore"))return;
        const restored=await api('/api/config/parse',{method:'POST',body:{yaml:edit.yaml}});
        restored.experiment.id=eid;
        const snapshot=await api('/api/config/serialize',{method:'POST',body:restored});
        const result=await api(`/api/experiments/${encodeURIComponent(eid)}/config`,{method:"PUT",body:{yaml:snapshot.yaml,revision,allow_metadata_edit:true,comment:`Restored configuration #${edit.id}`}});
        revision=result.revision;config=restored;savedConfig=structuredClone(restored);savedYaml=result.yaml;
        $("#yaml-source").value=savedYaml;$("#edit-comment").value="";
        editorMode="form";$("#editor-form").hidden=false;$("#editor-yaml").hidden=true;
        $("#mode-form").classList.add("active");$("#mode-yaml").classList.remove("active");
        renderForm();savedOnce=true;markClean("Configuration restored and applied");
        $(".config-editor .subtitle").textContent=config.experiment.name;
        toast("Configuration restored and applied");await loadEdits();
      }catch(error){toast(error.message,true);}
    });
    $("#config-edits").querySelectorAll('[data-delete-edit]').forEach(button=>button.onclick=()=>deleteHistory([Number(button.dataset.deleteEdit)]));
  }
  $("#reload-edits").onclick=()=>loadEdits().catch(error=>toast(error.message,true));
  loadEdits().catch(error=>toast(error.message,true));

  function field(label, id, value, extra = "") { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${html(value)}" ${extra}></div>`; }
  function renderForm() {
    $("#editor-form").querySelectorAll('details[data-config-section]').forEach(el=>{
      configSections.set(el.dataset.configSection,el.open);
    });
    $("#editor-form").innerHTML = `<div class="editor-content">
      <section class="panel"><div class="panel-head"><h2>Experiment</h2><span class="small-text muted">Name / Description</span></div><div class="panel-body">${field("Experiment URL path (ID)","edit-id",config.experiment.id,'maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"')}<p class="form-note">/experiments/&lt;ID&gt; · Letters, numbers, hyphens and underscores. Changing this moves the existing settings and history to the new URL.</p>${field("Name","edit-name",config.experiment.name,'maxlength="200"')}<div class="field"><label for="edit-description">Description</label><textarea id="edit-description">${html(config.experiment.description)}</textarea></div></div></section>
      <section class="panel"><div class="panel-head"><h2>Event Builder</h2></div><div class="panel-body"><div class="two-columns">${field("Name","edit-eb-name",config.eb.name)}${field("Host","edit-eb-host",config.eb.host)}</div></div></section>
      <section class="panel babimo-settings"><div class="panel-head"><h2>babimo · Restart DAQ</h2></div><div class="panel-body"><p class="form-note">Restart selected processes on the EB host via babimo. Saved per experiment. New experiments select babinfo and babild. babinfo and babild are stopped together; babinfo starts before babild.</p>${field("EB fragment number for offline recovery (optional)","edit-babimo-efn",config.babimo?.efn ?? "",'type="number" min="0" max="255" placeholder="Use the actual EB fragment number"')}<div class="babimo-options section">${["babinfo","babild","babissm","babian"].map(name=>`<label class="check-label"><input id="babimo-${name}" type="checkbox" ${config.babimo?.[name] ? "checked" : ""}>${name}</label>`).join("")}</div></div></section>
      <section class="panel api-settings"><div class="panel-head"><h2>APIs</h2></div><div class="api-settings-body"><details class="api-config-group" data-config-section="run-control" ${configSections.get("run-control") ? "open" : ""}><summary>Run Control API</summary><div class="panel-body config-api-fields">${field("Name","edit-api-name",config.run_control_api.name)}${field("Base URL","edit-api-url",config.run_control_api.api,'type="url"')}${field("Event polling interval (seconds)","edit-event-interval",config.run_control_api.event_poll_interval_sec ?? 2,'type="number" min="1" max="3600" step="0.5"')}${field("Start timeout (seconds)","edit-start-timeout",config.run_control_api.start_timeout ?? 10,'type="number" min="1" max="3600"')}${field("Stop timeout (seconds)","edit-stop-timeout",config.run_control_api.stop_timeout ?? 10,'type="number" min="1" max="3600"')}${field("Enable Restart DAQ after (seconds)","edit-restart-delay",config.run_control_api.restart_enable_after_sec ?? 5,'type="number" min="1" max="3600"')}${field("Idle connection check interval (seconds) · fixed at 2","edit-idle-interval",2,'type="number" disabled')}<p class="form-note">Start/Stop timeout defines when a timeout error appears. Restart enable delay starts when a Stop error or timeout occurs. Existing Start/Run errors start the delay at the Stop click. No commands are resent. Idle checks are read-only.</p>${field("Token environment variable (optional)","edit-api-token",config.run_control_api.token_env || "",'placeholder="BABIRL_API_TOKEN"')}<p class="form-note">Tokens stay on the backend. Enter an environment variable name, not the token.</p><div class="section"><label class="check-label"><input type="checkbox" id="edit-nssta" ${config.run_control_api.enable_nssta ? "checked" : ""}>Enable NSSTA (non-saving acquisition)</label></div></div></details>
      ${["start","stop","restart","monitor","manual"].map(type => `<details class="api-config-group" data-config-section="${type}" ${configSections.get(type) ? "open" : ""}><summary><span>${{start:"Start APIs",stop:"Stop APIs",restart:"Restart APIs",monitor:"Monitor APIs",manual:"Manual APIs"}[type]}</span><span class="small-text muted">${config[type+"_api"].length} APIs</span></summary><div class="panel-body"><div class="actions api-add-row"><button class="button small" data-add="${type}" type="button">＋ Add API</button></div><div id="hooks-${type}">${renderHooks(type)}</div></div></details>`).join("")}</div></section></div>`;
    $("#editor-form").querySelectorAll('details[data-config-section]').forEach(el=>{
      el.ontoggle=()=>{if(el.isConnected)configSections.set(el.dataset.configSection,el.open);};
    });
    $("#edit-id").disabled=!metadataUnlocked;$("#edit-name").disabled=!metadataUnlocked;
    $("#edit-description").disabled=!metadataUnlocked;
    $("#editor-form").querySelectorAll("input,textarea,select").forEach(el => {el.addEventListener("input", markDirty);el.addEventListener("change",markDirty);});
    $("#editor-form").querySelectorAll("[data-add]").forEach(button => button.onclick = () => {
      collectForm(); const key = button.dataset.add+"_api";
      config[key].push({name:"",api:"",enabled:true,...(['restart','monitor','manual'].includes(button.dataset.add) ? {} : {run_on_nssta:false}),...(button.dataset.add==='monitor' ? {interval_sec:5,timeout_sec:10,timing:'always'} : {}),...(button.dataset.add==='manual' ? {method:'POST',timings:['always'],timeout_sec:10,send_query_params:true,argument_transport:'query',query_params:[]} : {})});
      configSections.set(button.dataset.add,true);
      configSections.set(`hook-${button.dataset.add}-${config[key].length-1}`,true);
      const group=$("#editor-form").querySelector(`[data-config-section="${button.dataset.add}"]`);
      if(group)group.open=true;
      markDirty(); renderForm();
    });
    $("#editor-form").querySelectorAll("[data-remove]").forEach(button => button.onclick = () => {
      collectForm(); config[button.dataset.kind+"_api"].splice(Number(button.dataset.remove),1); markDirty(); renderForm();
    });
    $("#editor-form").querySelectorAll("[data-move]").forEach(button => button.onclick = () => {
      collectForm(); const array = config[button.dataset.kind+"_api"], i = Number(button.dataset.index), j = i+Number(button.dataset.move);
      const type=button.dataset.kind;
      const first=$(`[data-config-section="hook-${type}-${i}"]`), second=$(`[data-config-section="hook-${type}-${j}"]`);
      first.dataset.configSection=`hook-${type}-${j}`;second.dataset.configSection=`hook-${type}-${i}`;
      [array[i],array[j]] = [array[j],array[i]]; markDirty(); renderForm();
    });
    $("#editor-form").querySelectorAll('[data-manual-timing]').forEach(checkbox=>checkbox.onchange=()=>{
      const index=checkbox.dataset.index,key=checkbox.dataset.manualTiming;
      if(key==='always' && checkbox.checked){
        $(`#manual-${index}-timing-running`).checked=false;$(`#manual-${index}-timing-idle`).checked=false;
      }else if(key!=='always' && checkbox.checked)$(`#manual-${index}-timing-always`).checked=false;
      if(!['always','running','idle'].some(value=>$(`#manual-${index}-timing-${value}`).checked))$(`#manual-${index}-timing-always`).checked=true;
      collectForm();markDirty();
    });
    $("#editor-form").querySelectorAll('[data-argument-source]').forEach(select=>select.onchange=()=>{collectForm();markDirty();renderForm();});
    $("#editor-form").querySelectorAll('[data-query-toggle]').forEach(checkbox=>checkbox.onchange=()=>{collectForm();markDirty();renderForm();});
    $("#editor-form").querySelectorAll('[data-query-add]').forEach(button=>button.onclick=()=>{
      collectForm();const hook=config[button.dataset.kind+'_api'][Number(button.dataset.index)];
      hook.query_params ??= [];hook.query_params.push({name:'arg_'+(hook.query_params.length+1),source:button.dataset.kind==='manual' ? 'custom' : 'runname',...(button.dataset.kind==='manual' ? {placeholder:''} : {})});markDirty();renderForm();
    });
    $("#editor-form").querySelectorAll('[data-query-remove]').forEach(button=>button.onclick=()=>{
      collectForm();config[button.dataset.kind+'_api'][Number(button.dataset.index)].query_params.splice(Number(button.dataset.queryRemove),1);markDirty();renderForm();
    });
  }
  function renderQueryParams(type,index,hook){
    const prefix=`hook-${type}-${index}`;
    const sources=type==='manual' ? {custom:'Free input',...DAQ_ARGUMENT_SOURCES} : DAQ_ARGUMENT_SOURCES;
    return `<div class="section"><label class="check-label"><input type="checkbox" id="${prefix}-query-enabled" data-query-toggle ${hook.send_query_params ? 'checked' : ''}>${type==='manual' ? 'Send arguments' : 'Send DAQ arguments'}</label><div ${hook.send_query_params ? '' : 'hidden'}><label>Send as<select class="input" id="${prefix}-argument-transport"><option value="query" ${hook.argument_transport!=='json' ? 'selected' : ''}>Query parameters</option>${type==='monitor' ? '' : `<option value="json" ${hook.argument_transport==='json' ? 'selected' : ''}>JSON body</option>`}</select></label><p class="form-note">${type==='monitor' ? 'GET query parameters use the latest cached DAQ values. JSON objects are sent as JSON strings. No additional DAQ requests are made.' : 'Arguments use the shared Run overview snapshot; Start/Stop hooks use their verified transition snapshot. Run numbers are not padded. JSON body keeps JSON object types.'}</p>${(hook.query_params || []).map((argument,n)=>`<div class="actions section"><label>Argument name<input class="input" id="${prefix}-arg-${n}-name" maxlength="64" value="${html(argument.name)}" placeholder="run_number"></label><label>Value source<select class="input" data-argument-source data-kind="${type}" data-index="${index}" id="${prefix}-arg-${n}-source">${Object.entries(sources).map(([key,label])=>`<option value="${key}" ${argument.source===key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button type="button" class="button small" data-query-remove="${n}" data-kind="${type}" data-index="${index}">×</button></div>${type==='manual' && argument.source==='custom' ? field('Input template (placeholder only)',`${prefix}-arg-${n}-placeholder`,argument.placeholder || '', 'maxlength="1000"') : ''}<p class="form-note argument-description">${html(argumentDescription(argument.source))}</p>`).join('')}<button type="button" class="button small section" data-query-add data-kind="${type}" data-index="${index}">＋ Add argument</button></div></div>`;
  }
  function renderHooks(type) {
    return config[type+"_api"].map((hook,index,array) => `<div class="hook-entry"><details class="hook-row" data-hook="${type}" data-config-section="hook-${type}-${index}" ${configSections.get(`hook-${type}-${index}`) ? 'open' : ''}><summary><span>${html(hook.name || 'New API')}</span></summary><div class="hook-content">
      <div class="two-columns">${field("Name",`hook-${type}-${index}-name`,hook.name)}${field("URL · full endpoint",`hook-${type}-${index}-api`,hook.api,'type="url"')}</div>
      ${field("Token environment variable (optional)",`hook-${type}-${index}-token`,hook.token_env || "")}
      ${type==='manual' ? `<div class="section"><span class="small-text">Available</span><div class="actions">${Object.entries({always:'Every time',running:'During running',idle:'During IDLE'}).map(([key,label])=>`<label class="check-label"><input type="checkbox" data-manual-timing="${key}" data-index="${index}" id="manual-${index}-timing-${key}" ${(hook.timings || ['always']).includes(key) ? 'checked' : ''}>${label}</label>`).join('')}</div><p class="form-note">Every time includes unavailable DAQ states. During running includes NSSTA. During IDLE requires a confirmed stopped state.</p></div><div class="two-columns"><label>Method<select class="input" id="manual-${index}-method"><option ${hook.method==='GET' ? 'selected' : ''}>GET</option><option ${hook.method!=='GET' ? 'selected' : ''}>POST</option></select></label>${field('Timeout (seconds)',`manual-${index}-timeout`,hook.timeout_sec ?? 10,'type="number" min="1" max="3600"')}</div>` : ''}${type==='monitor' ? renderMonitorFields(index,hook)+renderQueryParams(type,index,hook) : type==='restart' ? '' : renderQueryParams(type,index,hook)}
      <div class="hook-row-actions">${!['restart','monitor','manual'].includes(type) ? `<label class="check-label"><input type="checkbox" id="hook-${type}-${index}-nssta" ${hook.run_on_nssta ? "checked" : ""}>Also run for NSSTA</label>` : `<span class="small-text muted">${type==='monitor' ? 'Scheduled GET · display only' : type==='manual' ? 'Run manually from the API tab' : 'Runs while DAQ is idle'}</span>`}
      </div></div></details><div class="hook-quick-actions"><div class="hook-order"><span>${index+1}</span><button class="button small" type="button" title="Move up" data-kind="${type}" data-index="${index}" data-move="-1" ${index === 0 ? "disabled" : ""}>↑</button><button class="button small" type="button" title="Move down" data-kind="${type}" data-index="${index}" data-move="1" ${index === array.length-1 ? "disabled" : ""}>↓</button></div><label class="check-label"><input type="checkbox" id="hook-${type}-${index}-enabled" ${hook.enabled!==false ? 'checked' : ''}>Enabled</label><button class="button small danger" type="button" data-kind="${type}" data-remove="${index}" aria-label="Delete ${html(hook.name || 'API')}">Delete</button></div></div>`).join("") || `<p class="small-text muted" style="margin:0">No APIs configured. This step will be skipped.</p>`;
  }
  function renderMonitorFields(index,hook){
    return `<div class="two-columns">${field('Polling interval (seconds)',`monitor-${index}-interval`,hook.interval_sec ?? 5,'type="number" min="1" max="3600"')}${field('Timeout (seconds)',`monitor-${index}-timeout`,hook.timeout_sec ?? 10,'type="number" min="1" max="3600"')}</div><label>Timing<select class="input" id="monitor-${index}-timing">${Object.entries({always:'Every time',running:'During running',idle:'During IDLE'}).map(([key,label])=>`<option value="${key}" ${(hook.timing || 'always')===key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p class="form-note">GET · JSON · Display only. Failures never change DAQ state.</p>`;
  }
  function collectForm() {
    config.experiment.id = $("#edit-id").value.trim();
    config.experiment.name = $("#edit-name").value;
    config.experiment.description = $("#edit-description").value;
    config.babimo = Object.fromEntries(["babinfo","babild","babissm","babian"].map(name=>[name,$("#babimo-"+name).checked]));
    config.babimo.efn=$("#edit-babimo-efn").value==="" ? null : Number($("#edit-babimo-efn").value);
    config.eb = {name:$("#edit-eb-name").value,host:$("#edit-eb-host").value};
    config.run_control_api = {name:$("#edit-api-name").value,api:$("#edit-api-url").value,enable_nssta:$("#edit-nssta").checked,event_poll_interval_sec:Number($("#edit-event-interval").value),start_timeout:Number($("#edit-start-timeout").value),stop_timeout:Number($("#edit-stop-timeout").value),restart_enable_after_sec:Number($("#edit-restart-delay").value),idle_connection_interval_sec:Number($("#edit-idle-interval").value)};
    if ($("#edit-api-token").value.trim()) config.run_control_api.token_env = $("#edit-api-token").value.trim();
    for (const type of ["start","stop","restart","monitor","manual"]) config[type+"_api"] = config[type+"_api"].map((_,index) => {
      const hook = {name:$(`#hook-${type}-${index}-name`).value,api:$(`#hook-${type}-${index}-api`).value,enabled:$(`#hook-${type}-${index}-enabled`).checked};
      if (!['restart','monitor','manual'].includes(type)) hook.run_on_nssta = $(`#hook-${type}-${index}-nssta`).checked;
      if(type!=='restart'){
        hook.send_query_params=$(`#hook-${type}-${index}-query-enabled`).checked;
        if(type!=='monitor') hook.argument_transport=$(`#hook-${type}-${index}-argument-transport`).value;
        hook.query_params=(_.query_params || []).map((argument,n)=>({name:$(`#hook-${type}-${index}-arg-${n}-name`).value.trim(),source:$(`#hook-${type}-${index}-arg-${n}-source`).value,...(type==='manual' ? {placeholder:$(`#hook-${type}-${index}-arg-${n}-placeholder`)?.value ?? argument.placeholder ?? ''} : {})}));
      }
      if(type==='manual'){hook.timings=['always','running','idle'].filter(key=>$(`#manual-${index}-timing-${key}`).checked);hook.method=$(`#manual-${index}-method`).value;hook.timeout_sec=Number($(`#manual-${index}-timeout`).value);}
      if(type==='monitor'){hook.interval_sec=Number($(`#monitor-${index}-interval`).value);hook.timeout_sec=Number($(`#monitor-${index}-timeout`).value);hook.timing=$(`#monitor-${index}-timing`).value;}
      const token = $(`#hook-${type}-${index}-token`).value.trim(); if (token) hook.token_env = token;
      return hook;
    });
  }
  $("#metadata-lock").onchange=()=>{
    metadataUnlocked=$("#metadata-lock").checked;
    $("#metadata-lock-state").textContent=metadataUnlocked ? "Editable" : "Locked";
    $("#edit-id").disabled=!metadataUnlocked;$("#edit-name").disabled=!metadataUnlocked;$("#edit-description").disabled=!metadataUnlocked;
  };
  $("#edit-comment").addEventListener("input",markDirty);
  function markDirty() { dirtyEditor = true; $("#save-state").textContent = "Unsaved changes"; $("#discard-config").hidden=false; $("#editor-back").textContent="Cancel & Back to control"; }
  function markClean(message) {
    dirtyEditor=false;$("#discard-config").hidden=true;$("#save-state").textContent=message;
    $("#editor-back").textContent=savedOnce ? "Back to control" : "Cancel & Back to control";
  }
  function noChanges() {
    savedOnce=true;markClean("No changes to save");toast("No changes to save.");
  }
  $("#discard-config").onclick=()=>{
    config=structuredClone(savedConfig);
    $("#yaml-source").value=savedYaml;
    $("#edit-comment").value="";
    renderForm();
    markClean("No unsaved changes");
  };
  renderForm(); $("#yaml-source").addEventListener("input", markDirty);
  $("#mode-yaml").onclick = async () => {
    if (editorMode === "yaml") return;
    try {
      collectForm(); const result = await api("/api/config/serialize",{method:"POST",body:config});
      if (version !== routeVersion) return;
      $("#yaml-source").value = result.yaml; editorMode = "yaml";
      $("#editor-form").hidden = true; $("#editor-yaml").hidden = false;
      $("#mode-yaml").classList.add("active"); $("#mode-form").classList.remove("active");
    } catch (error) { toast(error.message,true); }
  };
  $("#mode-form").onclick = async () => {
    if (editorMode === "form") return;
    try {
      config = await api("/api/config/parse",{method:"POST",body:{yaml:$("#yaml-source").value}});
      renderForm(); editorMode = "form";
      $("#editor-form").hidden = false; $("#editor-yaml").hidden = true;
      $("#mode-form").classList.add("active"); $("#mode-yaml").classList.remove("active");
    } catch (error) { toast(error.message,true); }
  };
  $("#save-config").onclick = async () => {
    const historyComment=$("#edit-comment").value;
    if(!dirtyEditor && !historyComment.trim()){noChanges();return;}
    const button = $("#save-config"); button.disabled = true;
    const controls=[...app.querySelectorAll("input,textarea,select,button")].filter(el=>el!==button && !el.disabled);controls.forEach(el=>el.disabled=true);
    try {
      let raw = $("#yaml-source").value;
      if (editorMode === "form") { collectForm(); raw = (await api("/api/config/serialize",{method:"POST",body:config})).yaml; }
      const parsed=await api("/api/config/parse",{method:"POST",body:{yaml:raw}});
      if(JSON.stringify(parsed)===JSON.stringify(savedConfig) && (editorMode==="form" || raw===savedYaml)){
        if(!historyComment.trim()){noChanges();return;}
        raw=savedYaml;
      }
      const result = await api(`/api/experiments/${encodeURIComponent(eid)}/config`,{method:"PUT",body:{yaml:raw,revision,comment:historyComment,allow_metadata_edit:metadataUnlocked}});
      revision = result.revision; config=parsed;savedConfig=structuredClone(parsed);savedYaml=raw;
      $("#yaml-source").value=raw;$("#edit-comment").value="";if(editorMode==="form")renderForm();savedOnce=true;markClean("Saved");
      toast("Configuration saved");
      if(result.experiment_id && result.experiment_id!==eid){await navigate(`/experiments/${encodeURIComponent(result.experiment_id)}/edit`,true);return;}
      await loadEdits();
    } catch (error) { toast(error.message,true); }
    finally { button.disabled = false; controls.forEach(el=>el.disabled=false); }
  };
}

(async () => {
  try {
    const info = await api("/api/info"); mode = info.mode;
    if(info.build_id !== GUI_BUILD) throw new Error("GUI files and Python server versions differ. Update the complete GUI, restart Python, and reload this page.");
    $(".top-version").title = GUI_BUILD;

    await route();
  } catch (error) { app.innerHTML = `<h1>Connection unavailable</h1><p>${html(error.message)}</p>`; }
})();
