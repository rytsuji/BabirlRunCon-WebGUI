"use strict";

function normalizeEFMode(value) {
  const modes=["OFF","ON","SCR","PAS"];
  if(typeof value==="number")return Number.isInteger(value) ? modes[value] ?? null : null;
  if(typeof value!=="string")return null;
  const text=value.trim().toUpperCase();
  return modes.includes(text) ? text : /^[0-3]$/.test(text) ? modes[Number(text)] : null;
}

if(typeof module!=="undefined")module.exports={normalizeEFMode};

function mountWebutil(context) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const base = `/api/experiments/${encodeURIComponent(context.eid)}`;
  const ids = ["control","raw","history","processes","eflist","hdlist","ssm"];
  const names = {processes:"Process Manager",eflist:"EF List",ssm:"babissm",hdlist:"HD List",raw:"Raw Data"};
  let rawConfig = {}, tab = "control", rawTimer = null, status = null, rawBusy = false;
  const loaded = new Set();
  let processItems=[];
  for (const id of Object.keys(names)) {
    document.querySelector(".control-page .tabs").insertAdjacentHTML("beforeend",`<button class="tab" id="tab-${id}" role="tab" aria-selected="false" aria-controls="view-${id}">${names[id]}</button>`);
    document.querySelector(".control-page .footer").insertAdjacentHTML("beforebegin",`<section class="utility-view section" id="view-${id}" role="tabpanel" aria-labelledby="tab-${id}" hidden></section>`);
  }
  for (const id of ids) document.querySelector(".control-page .tabs").appendChild(document.querySelector("#tab-"+id));
  const get = selector => document.querySelector(selector);
  const input = (name,value,type="text",attrs="") => `<input class="input" aria-label="${esc(name)}" data-field="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
  const check = (name,value,label) => `<label class="check-label"><input type="checkbox" data-field="${name}" ${value ? "checked" : ""}>${label}</label>`;
  const field = (label,content) => `<div class="field"><label>${label}</label>${content}</div>`;
  const enabled = value => String(value).toUpperCase()==="ON" || value===1 || value===true;
  function view(id) { return get("#view-"+id); }
  function panel(title,body,buttons="") {
    return `<div class="panel utility-panel"><div class="panel-head"><h2>${title}</h2><div class="actions">${buttons}</div></div><div class="panel-body"><p class="utility-state form-note">Checking DAQ state…</p>${body}</div></div>`;
  }
  function collect(root) {
    return Object.fromEntries([...root.querySelectorAll("[data-field]")].map(el => [el.dataset.field,el.type==="checkbox" ? el.checked : el.type==="number" ? Number(el.value) : el.value]));
  }
  async function read(kind,efn) {
    return api(base+"/webutil/"+kind+(efn==null ? "" : "?efn="+efn));
  }
  async function save(kind,payload,efn) {
    if (!await confirmAction("Set DAQ configuration?",`Write ${kind === "es" ? "ES "+efn : kind} and verify readback? DAQ must be idle.`,"Set & verify")) return;
    const result = await api(base+"/webutil",{method:"PUT",body:{kind,payload,...(efn==null ? {} : {efn})}});
    if (!context.isLive()) return;
    if (["eflist","hdlist","ssm"].includes(kind)) await load(kind);
    toast("Settings written, verified and reloaded");
    const note = view(tab).querySelector(".utility-result");
    if (note) note.innerHTML = `<details open><summary>Verified result · before / after</summary><div class="utility-readback">${formatDAQ(result)}</div></details>`;
    context.onMutate();
    return result;
  }
  function guarded(callback) {
    return async event => {
      event?.preventDefault();
      try { await callback(event); }
      catch(error) { toast(error.message,true); }
    };
  }
  function modeSelect(value) {
    const mode=normalizeEFMode(value);
    return `<select class="input" aria-label="EF mode" data-field="mode">${mode===null ? `<option value="" selected disabled>Unknown mode (${esc(value)})</option>` : ""}${["OFF","ON","SCR","PAS"].map(m=>`<option value="${m}" ${m===mode ? "selected" : ""}>${m}</option>`).join("")}</select>`;
  }
  function efRow(row={}) {
    return `<tr data-ef-row><td>${input("efn",row.efn ?? 0,"number",'min="0" max="255" required')}</td><td>${input("name",row.name || "","text",'maxlength="79" required')}</td><td>${input("host",row.host || "","text",'maxlength="79" required')}</td><td>${modeSelect(row.onoff ?? row.mode ?? "ON")}</td><td class="actions"><button type="button" class="button small" data-configure aria-expanded="false">▸ Set ES Config</button><button type="button" class="button small" data-remove>×</button></td></tr>`;
  }
  function wireRows(root) {
    root.querySelectorAll("[data-remove]").forEach(button=>button.onclick=()=>{const row=button.closest("tr");if(row.nextElementSibling?.classList.contains("es-detail"))row.nextElementSibling.remove();row.remove();});
    root.querySelectorAll("[data-configure]").forEach(button=>button.onclick=guarded(async()=>{
      const efn=Number(button.closest("tr").querySelector('[data-field="efn"]').value);
      const row=button.closest("tr");
      let detail=row.nextElementSibling;
      if(!detail?.classList.contains("es-detail")){
        row.insertAdjacentHTML("afterend",'<tr class="es-detail"><td colspan="5"><div class="es-inline"></div></td></tr>');
        detail=row.nextElementSibling;
      }
      if(button.getAttribute("aria-expanded")==="true"){detail.hidden=true;button.setAttribute("aria-expanded","false");button.textContent="▸ Set ES Config";return;}
      detail.hidden=false;
      await loadES(efn,detail.querySelector(".es-inline"));
      button.setAttribute("aria-expanded","true");button.textContent="▾ Set ES Config";
    }));
  }
  async function renderEF() {
    const rows=rawConfig.eflist || [];
    view("eflist").innerHTML=panel("Set EF List · Set ES Config",`<div id="ef-form"><div class="table-scroll"><table class="utility-table"><thead><tr><th>ES No.</th><th>Nickname</th><th>Host</th><th>Mode</th><th></th></tr></thead><tbody id="ef-rows">${rows.map(efRow).join("")}</tbody></table></div><div class="actions section"><button class="button" type="button" id="ef-add">＋ Add EF</button><button id="ef-save" class="button blue settings-write" type="button">Set EF List</button></div></div>
      <div class="utility-result section"></div>`,
      '<button class="button small" id="ef-refresh">↻ Read EF list</button><button class="button small" id="ef-check">Check connection</button>');
    wireRows(view("eflist"));
    get("#ef-add").onclick=()=>{
      const used=[...get("#ef-rows").querySelectorAll('[data-field="efn"]')].map(el=>Number(el.value));
      const next=Array.from({length:256},(_,i)=>i).find(i=>!used.includes(i));
      if(next==null)return toast("All EF slots are used",true);
      get("#ef-rows").insertAdjacentHTML("beforeend",efRow({efn:next}));wireRows(view("eflist"));
    };
    get("#ef-save").onclick=guarded(async()=>{
      const rows=[...get("#ef-rows").querySelectorAll("tr[data-ef-row]")].map(collect);
      if(rows.some(row=>normalizeEFMode(row.mode)===null))throw new Error("Select a valid Mode for every EF before saving.");
      await save("eflist",{rows});
    });
    get("#ef-refresh").onclick=guarded(()=>load("eflist"));
    get("#ef-check").onclick=guarded(async()=>{
      const result=await context.checkConnections();
      view(tab).querySelector(".utility-result").innerHTML=`<div class="utility-readback">${formatDAQ(result)}</div>`;
    });
    updateStatus(status);
  }
  async function loadES(efn,holder) {
    if (!Number.isInteger(efn)) throw new Error("Select an ES first");
    const data=await read("es",efn);
    if (!context.isLive())return;
    holder.innerHTML=`<form class="es-form"><p class="small-text muted">ES ${efn} · reported connect=${esc(data.connect)} · receiver port ${esc(data.erport ?? "—")}</p><div class="utility-form-grid es-inline-grid">
      ${field("Event receiver host",input("erhost",data.erhost || "","text",'maxlength="79" required'))}
      ${field("RT driver",input("rtdrv",data.rtdrv || "","text",'maxlength="79"'))}
      ${field("HD1 directory",input("hd1dir",data.hd1dir || "","text",'maxlength="79"'))}
      ${field("HD2 directory",input("hd2dir",data.hd2dir || "","text",'maxlength="79"'))}
      </div><div class="actions">${check("hd1",!!data.hd1,"HD1")}${check("hd2",!!data.hd2,"HD2")}${check("mt",!!data.mt,"MT / RT driver")}<button class="button blue settings-write" type="submit">Set ES Configuration</button></div></form>`;
    const form=holder.querySelector("form");
    form.onsubmit=guarded(async()=>{if(await save("es",collect(form),efn))await loadES(efn,holder);});updateStatus(status);
  }
  function renderSSM() {
    const data=rawConfig.ssminfo || {};
    view("ssm").innerHTML=panel("babissm · setssminfo",`<form id="ssm-form"><div class="field">${check("enabled",enabled(data.onoff),"Enable start / stop manager")}</div><div class="utility-form-grid">${field("SSM host",input("host",data.host || "","text",'maxlength="79"'))}${field("Start command / path",input("start",data.start || "","text",'maxlength="79"'))}${field("Stop command / path",input("stop",data.stop || "","text",'maxlength="79"'))}</div><p class="form-note">These are babild's SSM settings. Saving them does not execute the commands.</p><div class="actions section"><button class="button blue settings-write" type="submit">Set SSM Configuration</button></div></form><div class="utility-result section"></div>`, '<button class="button small" id="ssm-refresh">↻ Read SSM settings</button>');
    get("#ssm-form").onsubmit=guarded(()=>save("ssm",collect(get("#ssm-form"))));
    get("#ssm-refresh").onclick=guarded(()=>load("ssm"));updateStatus(status);
  }
  function hdRow(row={}) {
    return `<tr><td>${input("hdn",row.hdn ?? 0,"number",'min="0" max="9" required')}</td><td>${check("enabled",enabled(row.onoff ?? row.enabled),"ON")}</td><td>${input("path",row.path || "","text",'maxlength="79" required')}</td><td class="muted">${esc(row.free || "—")}</td><td><button type="button" class="button small" data-remove>×</button></td></tr>`;
  }
  function renderHD() {
    view("hdlist").innerHTML=panel("Storage destinations · sethdlist",`<form id="hd-form"><div class="table-scroll"><table class="utility-table"><thead><tr><th>Disk No.</th><th>Enabled</th><th>Path</th><th>Free</th><th></th></tr></thead><tbody id="hd-rows">${(rawConfig.hdlist || []).map(hdRow).join("")}</tbody></table></div><div class="actions section"><button class="button" type="button" id="hd-add">＋ Add destination</button><button class="button blue settings-write" type="submit">Set HD List</button></div></form><div class="utility-result section"></div>`, '<button class="button small" id="hd-refresh">↻ Read HD list</button>');
    wireRows(view("hdlist"));
    get("#hd-add").onclick=()=>{
      const used=[...get("#hd-rows").querySelectorAll('[data-field="hdn"]')].map(el=>Number(el.value));
      const next=Array.from({length:10},(_,i)=>i).find(i=>!used.includes(i));
      if(next==null)return toast("All 10 destinations are used",true);
      get("#hd-rows").insertAdjacentHTML("beforeend",hdRow({hdn:next,enabled:true}));wireRows(view("hdlist"));
    };
    get("#hd-form").onsubmit=guarded(()=>save("hdlist",{rows:[...get("#hd-rows").rows].map(collect)}));
    get("#hd-refresh").onclick=guarded(()=>load("hdlist"));updateStatus(status);
  }
  async function load(id) {
    rawConfig=await read("config");if(!context.isLive())return;
    loaded.add(id);
    if(id==="eflist")renderEF();else if(id==="ssm")renderSSM();else renderHD();
  }
  async function loadProcesses() {
    const previousEFN=get("#process-efn")?.value ?? context.getState?.()?.state?.raw_config?.ebinfo?.efn ?? "1";
    const data=await api(base+"/processes");if(!context.isLive())return;
    processItems=data.items;
    view("processes").innerHTML=panel(`Process Manager <span class="pill ${data.babimo_connected ?? data.items.every(item=>typeof item.running==='boolean') ? 'green' : 'red'}">babimo ${data.babimo_connected ?? data.items.every(item=>typeof item.running==='boolean') ? 'CONNECTED' : 'UNAVAILABLE'}</span>`,`<div class="actions section"><label>EB fragment number <input class="input" id="process-efn" type="number" min="0" max="255" value="${Number(previousEFN)}"></label><input id="process-recovery" type="checkbox" hidden><button id="process-lock" class="button small" type="button" aria-pressed="false">🔒 Emergency control locked</button></div><div class="table-scroll"><table><thead><tr><th>Process</th><th>STATE / PID</th><th>Actions</th></tr></thead><tbody>${data.items.map(item=>`<tr><td>${esc(item.name)}</td><td>${item.running===null ? esc(item.error || "Unavailable") : item.running ? `<span class="process-running">● Running · ${item.pid}</span>` : '<span class="process-stopped">● Stopped</span>'}</td><td class="actions">${["start","stop"].map(action=>`<button class="button small process-action" data-process="${esc(item.name)}" data-action="${action}">${action}</button>`).join("")}</td></tr>`).join("")}</tbody></table></div><div class="utility-result section"></div>`, '<button id="process-refresh" class="button small">↻ Reload processes</button>');
    loaded.add("processes");
    get("#process-efn").value=previousEFN;
    get("#process-recovery").onchange=()=>updateStatus(status);
    get("#process-lock").onclick=guarded(async()=>{
      const checkbox=get('#process-recovery');
      if(!checkbox.checked && !await confirmAction('Unlock emergency process control?','Allows process actions while DAQ is running or unavailable. Actions may interrupt acquisition. Each action still requires confirmation.','Unlock'))return;
      checkbox.checked=!checkbox.checked;
      get('#process-lock').textContent=checkbox.checked ? '🔓 Emergency control unlocked' : '🔒 Emergency control locked';
      get('#process-lock').setAttribute('aria-pressed',String(checkbox.checked));
      updateStatus(status);
    });
    get("#process-refresh").onclick=guarded(loadProcesses);
    view("processes").querySelectorAll(".process-action").forEach(button=>button.onclick=guarded(async()=>{
      const payload={process:button.dataset.process,action:button.dataset.action,efn:Number(get("#process-efn").value),allow_unavailable:get("#process-recovery").checked,allow_running:get("#process-recovery").checked};
      const dependencyNote=payload.action==="stop" ? (payload.process==="babinfo" ? " Also stops babild." : payload.process==="babild" ? " Both babild and babinfo will be stopped." : "") : payload.process==="babinfo" ? " If babinfo is stopped, babild will be stopped before it starts." : payload.process==="babild" ? " babinfo must already be running." : "";
      if(!await confirmAction("Process operation?",`${payload.action} ${payload.process}?${dependencyNote}${payload.allow_unavailable ? " Emergency control is unlocked. This may interrupt acquisition." : " DAQ must be idle."}`,"Execute"))return;
      button.disabled=true;
      try{
        const result=await api(base+"/processes",{method:"POST",body:payload});
        if(!context.isLive())return;
        await loadProcesses();view("processes").querySelector(".utility-result").innerHTML=formatDAQ(result);
        context.onMutate();toast("Process operation verified");
      }finally{if(button.isConnected)button.disabled=false;}
    }));
    updateStatus(status);
  }
  function renderRaw() {
    view("raw").innerHTML=panel("Raw Data Monitor",`<div class="raw-toolbar"><label class="check-label"><input type="checkbox" id="raw-auto">Auto refresh</label><label>Interval <input class="input" id="raw-interval" type="number" min="1" max="60" value="2"> s</label><span id="raw-info" class="small-text muted">Latest buffer only · max 300 records · 512 bytes per record</span></div><div class="raw-table-wrap"><table class="raw-table"><thead><tr><th>Raw data · 16-bit hex / 8 words per line</th><th>RIDF interpretation</th></tr></thead><tbody id="raw-rows"><tr><td colspan="2" class="muted">Read the latest babinfo buffer to inspect raw data.</td></tr></tbody></table></div>`, '<button class="button small" id="raw-read">↻ Read raw data</button>');
    get("#raw-read").onclick=guarded(readRaw);
    get("#raw-auto").onchange=()=>{clearTimeout(rawTimer);if(get("#raw-auto").checked)readRaw().catch(error=>toast(error.message,true));};
    loaded.add("raw");updateStatus(status);
  }
  async function readRaw() {
    if(rawBusy || !context.isLive() || tab!=="raw")return;
    clearTimeout(rawTimer);rawBusy=true;
    try {
      const data=await read("raw");if(!context.isLive() || tab!=="raw")return;
      get("#raw-info").textContent=`${Number(data.bytes).toLocaleString()} bytes · ${data.rows.length} / 300 records${data.truncated ? " · display limited" : ""}`;
      get("#raw-rows").innerHTML=data.rows.slice(0,300).map(row=>{
        const color=[0,1,2].includes(row.class_id) ? "raw-block" : [3,4,6].includes(row.class_id) ? "raw-event" : "raw-other";
        const lines=[];for(let i=0;i<Math.min(row.words.length,256);i+=8)lines.push(row.words.slice(i,i+8).map((word,j)=>`<span class="${i+j<6 ? color : ""}">${Number(word).toString(16).padStart(4,"0")}</span>`).join(" "));
        const seg=row.segment ? `<div class="segment-info">${Object.entries(row.segment).map(([name,value])=>`<span class="seg-${name}">${esc(name)}=${value}${row.segment_names?.[name] ? " "+esc(row.segment_names[name]) : ""}</span>`).join(" ")}</div>` : "";
        return `<tr><td><pre>${lines.join("\n")}${row.truncated ? "\n…" : ""}</pre></td><td><span class="mono muted">0x${Number(row.offset).toString(16).padStart(6,"0")}</span><p class="${color}">${esc(row.error || row.description)}</p>${seg}</td></tr>`;
      }).join("") || '<tr><td colspan="2">The buffer is empty.</td></tr>';
    } catch(error) { if(context.isLive())get("#raw-info").textContent=error.message;throw error; }
    finally {
      rawBusy=false;
      if(context.isLive() && tab==="raw" && get("#raw-auto")?.checked)rawTimer=setTimeout(()=>readRaw().catch(()=>{}),Math.max(1,Number(get("#raw-interval").value)||2)*1000);
    }
  }
  function updateStatus(value) {
    status=value;
    const canWrite=status?.connected && status.state.state==="stopped" && !status.active_operation && !status.active_run && !status.eb_owner && status.state.target?.allow_writes!==false;
    document.querySelectorAll(".utility-view .settings-write").forEach(button=>{button.disabled=!canWrite;});
    document.querySelectorAll(".process-action").forEach(button=>{
      const recoveryStart=!!get("#process-recovery")?.checked;
      const process=processItems.find(item=>item.name===button.dataset.process);
      const unavailable=typeof process?.running!=="boolean";
      const already=button.dataset.action==="start" ? process?.running===true : process?.running===false;
      const missingInfo=button.dataset.action==="start" && button.dataset.process==="babild" && processItems.find(item=>item.name==="babinfo")?.running!==true;
      button.disabled=unavailable || already || missingInfo || (!!status && (!!status.active_operation || (status.active_run && !recoveryStart) || !!status.eb_owner || status.state.target?.allow_writes===false || (["running","nssta"].includes(status.state.state) && !recoveryStart)));
      button.title=unavailable ? "Process state is unavailable. Reload processes." : already ? (button.dataset.action==="start" ? "Already running." : "Already stopped.") : missingInfo ? "Start babinfo before starting babild." : "";
    });
    document.querySelectorAll(".utility-state").forEach(el=>{el.textContent=el.closest("#view-processes") ? (get("#process-recovery")?.checked ? "🔓 Emergency control enabled · operations may interrupt acquisition." : canWrite ? "DAQ is idle · operations available." : "🔒 DAQ running or unavailable · unlock for emergency control.") : el.closest("#view-raw") ? "Read-only monitor · does not change DAQ settings." : canWrite ? "DAQ is idle · settings can be written and verified." : "Read-only while DAQ is running, unavailable, or an operation is active.";});
  }
  async function activate(name) {
    tab=name;clearTimeout(rawTimer);
    if(!Object.keys(names).includes(name))return;
    try {
      if(name==="processes") {await loadProcesses();}
      else if(name==="raw") {if(!loaded.has(name))renderRaw();if(get("#raw-auto")?.checked)await readRaw();}
      else if(!loaded.has(name)){view(name).innerHTML='<p class="muted">Reading DAQ configuration…</p>';await load(name);}
    } catch(error) {view(name).innerHTML=`<div class="notice red">${esc(error.message)}<p>Install the webutil API update, then open this tab again.</p></div>`;toast(error.message,true);}
  }
  return {ids,activate,updateStatus};
}
