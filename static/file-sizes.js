"use strict";

const FILE_SIZE_COLORS=["#2c62a3","#c8612a","#2a8a6c","#b88a1b","#a65686","#5f7f2e","#6656ad","#b8453f"];
let fileSizeClipSeq=0;

// Same binary units as monitor_file's human_size.
function binaryUnit(value) {
  const units=["B","KiB","MiB","GiB","TiB","PiB"];
  let index=0;
  while(index<units.length-1 && Math.abs(value)>=1024**(index+1))index++;
  return [1024**index,units[index]];
}

function formatFileBytes(bytes,suffix="") {
  if(bytes==null || !Number.isFinite(bytes))return "—";
  const [scale,unit]=binaryUnit(bytes);
  return `${(bytes/scale).toFixed(2)} ${unit}${suffix}`;
}

function formatLiveTime(seconds) {
  if(seconds==null || !Number.isFinite(seconds))return "—";
  const total=Math.round(seconds);
  return [Math.floor(total/3600),Math.floor(total/60)%60,total%60].map(value=>String(value).padStart(2,"0")).join(":");
}

// 1-2-5 ticks enclosing [min,max] on a log axis; decades only when that gives more than 7.
function logTicks(min,max) {
  const exponent=value=>Math.floor(Math.log10(value)+1e-9);
  const all=[];
  for(let power=exponent(min)-1;power<=exponent(max)+1;power++)for(const unit of [1,2,5])all.push(Number((unit*10**power).toPrecision(12)));
  let low=0, high=all.findIndex(tick=>tick>=max*(1-1e-9));
  while(all[low+1]<=min*(1+1e-9))low++;
  if(low===high){low--;high++;}
  const ticks=all.slice(low,high+1);
  if(ticks.length<=7)return ticks;
  const from=exponent(min), to=Math.ceil(Math.log10(max)-1e-9), stride=Math.ceil((to-from)/6);
  const decades=[];
  for(let power=from;decades.length===0 || decades.at(-1)<max*(1-1e-9);power+=stride)decades.push(Number((10**power).toPrecision(12)));
  return decades;
}

// Ticks for fractional deviations: cover +-bound when fixed, or +-2*tolerance and all values when auto; at most 5 intervals.
function deviationTicks(values,tolerance,bound=null) {
  const low=bound>0 ? -bound : Math.min(-2*tolerance,...values);
  const high=bound>0 ? bound : Math.max(2*tolerance,...values);
  for(let power=0.01;;power*=10){
    for(const unit of [5,10,20,25]){
      const step=unit*power, from=Math.floor(low/step+1e-9), to=Math.ceil(high/step-1e-9);
      if(to-from<=5)return Array.from({length:to-from+1},(_,index)=>Number(((from+index)*step).toPrecision(12)));
    }
  }
}

function formatDeviation(value) {
  if(value==null || !Number.isFinite(value))return "";
  const percent=Math.round(value*1000)/10;
  return `${percent>0 ? "+" : percent<0 ? "−" : ""}${Math.abs(percent).toFixed(1)}%`;
}

function fileSizeMedian(values) {
  const sorted=values.filter(value=>value>0).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const middle=sorted.length>>1;
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}

// rate = bytes / live time. The common trend of a Run is the median over DAQs of rate / baseline,
// and deviation = rate / baseline / trend - 1, so a change shared by all DAQs cancels.
function fileSizeSeries(data) {
  const runs=data.runs || [];
  const series=(data.sources || []).slice(0,FILE_SIZE_COLORS.length).map((source,slot)=>{
    const points=runs.map(run=>{
      const size=run.sizes?.[source.name] || null;
      const bytes=size?.bytes ?? null;
      return {bytes,rate:bytes!=null && run.live_time_sec>0 ? bytes/run.live_time_sec : null,
        error:size?.error || null,fileCount:size?.file_count ?? null,deviation:null};
    });
    return {name:source.name,enabled:source.enabled!==false,color:FILE_SIZE_COLORS[slot],points,
      baseline:fileSizeMedian(points.map(point=>point.rate))};
  });
  const trend=()=>runs.map((_,position)=>{
    const scaled=series.filter(item=>item.baseline && item.points[position].rate!=null).map(item=>item.points[position].rate/item.baseline);
    return scaled.length>1 ? fileSizeMedian(scaled) : null;
  });
  // Second pass: take each baseline relative to the trend, so varying conditions do not bias it.
  const first=trend();
  for(const item of series){
    item.baseline=fileSizeMedian(item.points.map((point,position)=>first[position] && point.rate!=null ? point.rate/first[position] : null)) || item.baseline;
  }
  const common=trend();
  for(const item of series)item.points.forEach((point,position)=>{
    if(item.baseline && common[position] && point.rate!=null)point.deviation=point.rate/item.baseline/common[position]-1;
  });
  return series;
}

function mountFileSizes({base,eid,config,readOnly=false,isLive=()=>true,confirm=async()=>true,notify=()=>{}}) {
  const tableScroll=document.querySelector("#view-history .table-scroll");
  if(!config?.file_size_api?.length || !tableScroll)return {activate(){},destroy(){}};
  const SVG="http://www.w3.org/2000/svg", RANGES=[5,10,20,50,100,200], TOP=8, RATE_H=108, DEV_H=92, PAD=8, AXIS=24, RIGHT=14, TOLERANCE=0.1;
  const DEV_SCALES=[
    {value:"0.2",label:"±20%",bound:0.2},
    {value:"0.5",label:"±50%",bound:0.5},
    {value:"1",label:"±100%",bound:1},
    {value:"auto",label:"Auto",bound:null},
  ];
  const storageKey="babirl-runcon:file-size-runs:"+eid;
  const devScaleKey="babirl-runcon:file-size-dev-scale:"+eid;
  let limit=50, devScale="0.2";
  try{const saved=Number(localStorage.getItem(storageKey));if(RANGES.includes(saved))limit=saved;}catch{}
  try{const saved=localStorage.getItem(devScaleKey);if(DEV_SCALES.some(item=>item.value===saved))devScale=saved;}catch{}
  tableScroll.insertAdjacentHTML("beforebegin",`<details class="fs-section" open><summary class="fs-summary"><span>File size</span><div class="actions fs-toolbar"><label class="fs-range">Runs<select class="input" data-fs="limit">${RANGES.map(value=>`<option value="${value}"${value===limit ? " selected" : ""}>Last ${value}</option>`).join("")}</select></label><label class="fs-range">Deviation<select class="input" data-fs="dev-scale">${DEV_SCALES.map(item=>`<option value="${item.value}"${item.value===devScale ? " selected" : ""}>${item.label}</option>`).join("")}</select></label><button class="button small" type="button" data-fs="refresh">↻ Refresh</button>${readOnly ? "" : '<button class="button small" type="button" data-fs="missing">Fetch missing</button><button class="button small" type="button" data-fs="all">Re-fetch all</button>'}</div></summary><div class="fs-body"><div class="fs-message" hidden></div><div class="fs-content" hidden><div class="fs-legend"></div><div class="fs-charts"><div class="fs-plot" tabindex="0" aria-label="File size rate and deviation by Run"></div><div class="fs-tooltip" role="status" hidden></div></div><details class="fs-table"><summary>Table</summary><div class="table-scroll"><table></table></div></details></div></div></details>`);
  const root=document.querySelector("#view-history .fs-section");
  let data=null,series=[],hover=null,visible=false,requestId=0,pollId=0,busy=false,layout=null,frame=0,lastWidth=0,timer=null,error="";
  const get=selector=>root.querySelector(selector);
  const canvas=document.createElement("canvas").getContext("2d");
  const measure=text=>canvas.measureText(text).width;
  const runTitle=run=>`${run.runname}${runNumber(run.runnumber)}`;

  function node(name,attrs,parent) {
    const item=document.createElementNS(SVG,name);
    for(const [key,value] of Object.entries(attrs))item.setAttribute(key,value);
    if(parent)parent.appendChild(item);
    return item;
  }
  function element(tag,className="",text=null) {
    const item=document.createElement(tag);
    if(className)item.className=className;
    if(text!=null)item.textContent=text;
    return item;
  }
  function lineKey(color) {
    const key=document.createElementNS(SVG,"svg");
    key.setAttribute("width","18");key.setAttribute("height","10");key.setAttribute("aria-hidden","true");
    node("line",{x1:1,x2:17,y1:5,y2:5,stroke:color,"stroke-width":1.5,"stroke-linecap":"round"},key);
    node("circle",{cx:9,cy:5,r:2.5,fill:color},key);
    return key;
  }
  function clippedMarker(parent,cx,above,color,seamY,bottomY,active=false) {
    const halfW=active ? 5 : 4;
    const tipY=above ? seamY+(active ? 1.5 : 2) : bottomY-(active ? 1.5 : 2);
    const baseY=above ? seamY+(active ? 8 : 7.5) : bottomY-(active ? 8 : 7.5);
    return node("polygon",{
      points:`${cx.toFixed(1)},${tipY.toFixed(1)} ${(cx-halfW).toFixed(1)},${baseY.toFixed(1)} ${(cx+halfW).toFixed(1)},${baseY.toFixed(1)}`,
      fill:color,
      class:active ? "fs-marker-active fs-marker-clipped" : "fs-marker-out fs-marker-clipped",
    },parent);
  }
  const values=key=>series.flatMap(item=>item.points.map(point=>point[key])).filter(value=>value!=null);
  const deviationLabel=value=>element("span",value!=null && Math.abs(value)>TOLERANCE ? "fs-dev fs-dev-out" : "fs-dev",formatDeviation(value));

  function renderButtons() {
    if(readOnly)return;
    const enabled=!!data?.sources?.some(item=>item.enabled);
    for(const name of ["missing","all"])get(`[data-fs="${name}"]`).disabled=busy || !enabled;
  }

  function render() {
    const message=get(".fs-message"), content=get(".fs-content");
    message.replaceChildren();
    if(error)message.append(element("div","notice red",`File sizes unavailable: ${error}`));
    if(data && !data.sources.length)message.append(element("p","muted","No File size APIs configured."));
    else if(data && !data.runs.length)message.append(element("p","muted","No saved Runs yet."));
    content.hidden=!data?.sources.length || !data.runs.length;
    renderButtons();
    if(content.hidden){layout=null;message.hidden=!message.childElementCount;return;}
    series=fileSizeSeries(data);
    const failed=series.filter(item=>item.points.at(-1).error);
    if(failed.length)message.append(element("div","notice amber",`${runTitle(data.runs.at(-1))}: `+failed.map(item=>`${item.name} · ${item.points.at(-1).error}`).join("; ")));
    message.hidden=!message.childElementCount;
    const legend=get(".fs-legend");legend.replaceChildren(element("span","muted",`Latest: ${runTitle(data.runs.at(-1))}`));
    for(const item of series){
      const point=item.points.at(-1), entry=element("span","fs-legend-item");
      entry.append(lineKey(item.color),element("span","fs-legend-name",item.name),
        element("span","fs-legend-value",formatFileBytes(point.rate,"/s")),deviationLabel(point.deviation));
      if(!item.enabled)entry.append(element("span","muted","· disabled"));
      legend.append(entry);
    }
    renderTable();
    renderCharts();
  }

  function renderCharts() {
    const charts=get(".fs-charts");
    if(!charts.clientWidth || !series.length)return;
    lastWidth=charts.clientWidth;
    canvas.font=`11px ${getComputedStyle(root).fontFamily}`;
    const width=Math.floor(charts.clientWidth), count=data.runs.length;
    const rates=values("rate").filter(value=>value>0);
    const [scale,unit]=binaryUnit(Math.max(0,...rates) || 1);
    const rateTicks=rates.length ? logTicks(Math.min(...rates)/scale,Math.max(...rates)/scale) : [1,10];
    const devBound=DEV_SCALES.find(item=>item.value===devScale)?.bound ?? null;
    const devTicks=deviationTicks(values("deviation"),TOLERANCE,devBound);
    const rateText=value=>String(Number(value.toPrecision(3))), devText=value=>String(Math.round(value*100)).replace("-","−");
    const maxTickW=Math.max(...rateTicks.map(value=>measure(rateText(value))),...devTicks.map(value=>measure(devText(value))));
    const left=Math.max(48,Math.ceil(maxTickW)+30);
    const step=(width-left-RIGHT)/count;
    const seamY=TOP+RATE_H, bottomY=seamY+DEV_H, height=bottomY+AXIS;
    const x0=left+0.5, x1=width-RIGHT-0.5, yTop=TOP+0.5, ySeam=seamY+0.5, yBottom=bottomY+0.5;
    const logMin=Math.log(rateTicks[0]), logSpan=Math.log(rateTicks.at(-1))-logMin;
    // Log axis; a zero rate sits on the bottom edge of the panel.
    const yRate=value=>value>0 ? TOP+PAD+(RATE_H-2*PAD)*(1-(Math.log(value)-logMin)/logSpan) : seamY;
    const devMin=devTicks[0], devMax=devTicks.at(-1), devSpan=devMax-devMin;
    const yDev=value=>seamY+PAD+(DEV_H-2*PAD)*(1-(value-devMin)/devSpan);
    const yDevLine=value=>Math.max(seamY-2000,Math.min(bottomY+2000,yDev(value)));

    const svg=node("svg",{width,height,viewBox:`0 0 ${width} ${height}`,"aria-hidden":"true"});
    const devClipId=`fs-dev-clip-${++fileSizeClipSeq}`;
    const defs=node("defs",{},svg);
    const clip=node("clipPath",{id:devClipId},defs);
    node("rect",{x:x0,y:ySeam,width:Math.max(0,x1-x0),height:DEV_H},clip);

    const bandTop=Math.max(ySeam,yDev(TOLERANCE)), bandBottom=Math.min(yBottom,yDev(-TOLERANCE));
    if(bandBottom>bandTop)node("rect",{x:x0,y:bandTop,width:Math.max(0,x1-x0),height:bandBottom-bandTop,class:"fs-band"},svg);
    for(const [ticks,yFn] of [[rateTicks,yRate],[devTicks,yDev]]){
      for(const tick of ticks){
        const gy=Math.round(yFn(tick))+0.5;
        node("line",{x1:x0,x2:x1,y1:gy,y2:gy,class:"fs-grid"},svg);
      }
    }
    const zeroY=Math.round(yDev(0))+0.5;
    node("line",{x1:x0,x2:x1,y1:zeroY,y2:zeroY,class:"fs-reference"},svg);

    const hoverLayer=node("g",{},svg);
    const x=index=>left+step*(index+.5);
    function drawPaths(parent,yFn,valueFn) {
      for(const item of series){
        const points=item.points.map(valueFn);
        const path=points.map((value,index)=>value==null ? "" : `${points[index-1]==null ? "M" : "L"}${x(index).toFixed(1)} ${yFn(value).toFixed(1)}`).join("");
        if(path)node("path",{d:path,stroke:item.color,class:"fs-line"},parent);
      }
    }
    const devClipLayer=node("g",{"clip-path":`url(#${devClipId})`},svg);
    drawPaths(svg,yRate,point=>point.rate==null ? null : point.rate/scale);
    drawPaths(devClipLayer,yDevLine,point=>point.deviation);

    node("rect",{x:x0,y:yTop,width:x1-x0,height:RATE_H,class:"fs-frame"},svg);
    node("rect",{x:x0,y:ySeam,width:x1-x0,height:DEV_H,class:"fs-frame"},svg);

    function drawYTicks(ticks,yFn,textFn) {
      for(const tick of ticks){
        const ty=Math.round(yFn(tick))+0.5;
        node("line",{x1:x0,x2:x0+4,y1:ty,y2:ty,class:"fs-axis-tick"},svg);
        node("line",{x1:x1-4,x2:x1,y1:ty,y2:ty,class:"fs-axis-tick"},svg);
        node("text",{x:left-6,y:ty,class:"fs-tick","text-anchor":"end","dominant-baseline":"middle"},svg).textContent=textFn(tick);
      }
    }
    drawYTicks(rateTicks,yRate,rateText);
    drawYTicks(devTicks,yDev,devText);

    // Labeled Runs get mirrored ticks on every edge; the others only a short tick on the bottom axis.
    const every=Math.max(1,Math.ceil((measure("00000")+8)/step));
    data.runs.forEach((run,index)=>{
      const cx=Math.round(x(index))+0.5;
      if((count-1-index)%every){
        if(step>=6)node("line",{x1:cx,x2:cx,y1:yBottom-2,y2:yBottom,class:"fs-axis-tick"},svg);
        return;
      }
      node("line",{x1:cx,x2:cx,y1:yTop,y2:yTop+4,class:"fs-axis-tick"},svg);
      node("line",{x1:cx,x2:cx,y1:ySeam-3,y2:ySeam+3,class:"fs-axis-tick"},svg);
      node("line",{x1:cx,x2:cx,y1:yBottom-4,y2:yBottom,class:"fs-axis-tick"},svg);
      node("text",{x:x(index),y:bottomY+15,class:"fs-tick","text-anchor":"middle"},svg).textContent=runNumber(run.runnumber);
    });

    const rateLabel=node("text",{x:12,y:TOP+RATE_H/2,class:"fs-ylabel","text-anchor":"middle","dominant-baseline":"middle",transform:`rotate(-90 12 ${TOP+RATE_H/2})`},svg);
    rateLabel.textContent=`Rate [${unit}/s]`;
    const devLabel=node("text",{x:12,y:seamY+DEV_H/2,class:"fs-ylabel","text-anchor":"middle","dominant-baseline":"middle",transform:`rotate(-90 12 ${seamY+DEV_H/2})`},svg);
    devLabel.textContent="Deviation [%]";

    // Points outside the tolerance band or clipped range keep a distinct marker at any density.
    for(const item of series){
      const rates=item.points.map(point=>point.rate==null ? null : point.rate/scale);
      rates.forEach((value,index)=>{
        if(value!=null && (step>=12 || (rates[index-1]==null && rates[index+1]==null)))
          node("circle",{cx:x(index),cy:yRate(value),r:2.5,fill:item.color,class:"fs-marker"},svg);
      });
      const deviations=item.points.map(point=>point.deviation);
      deviations.forEach((value,index)=>{
        if(value==null)return;
        if(value>devMax || value<devMin)clippedMarker(svg,x(index),value>devMax,item.color,seamY,bottomY);
        else if(Math.abs(value)>TOLERANCE)node("circle",{cx:x(index),cy:yDev(value),r:4,fill:item.color,class:"fs-marker-out"},svg);
        else if(step>=12 || (deviations[index-1]==null && deviations[index+1]==null))node("circle",{cx:x(index),cy:yDev(value),r:2.5,fill:item.color,class:"fs-marker"},svg);
      });
    }

    const activeLayer=node("g",{},svg);
    get(".fs-plot").replaceChildren(svg);
    layout={left,step,count,width,x,seamY,bottom:bottomY,yRate,yDev,devMin,devMax,scale,hoverLayer,activeLayer};
    renderHover();
  }

  function renderHover() {
    const tip=get(".fs-tooltip");
    if(!layout){tip.hidden=true;return;}
    layout.hoverLayer.replaceChildren();layout.activeLayer.replaceChildren();
    if(hover==null){tip.hidden=true;return;}
    const xPos=layout.x(hover), cx=Math.round(xPos)+0.5;
    node("line",{x1:cx,x2:cx,y1:TOP,y2:layout.bottom,class:"fs-crosshair"},layout.hoverLayer);
    for(const item of series){
      const point=item.points[hover];
      if(point.rate!=null)node("circle",{cx:xPos,cy:layout.yRate(point.rate/layout.scale),r:4,fill:item.color,class:"fs-marker-active"},layout.activeLayer);
      if(point.deviation!=null){
        if(point.deviation>layout.devMax || point.deviation<layout.devMin)clippedMarker(layout.activeLayer,xPos,point.deviation>layout.devMax,item.color,layout.seamY,layout.bottom,true);
        else node("circle",{cx:xPos,cy:layout.yDev(point.deviation),r:4,fill:item.color,class:"fs-marker-active"},layout.activeLayer);
      }
    }
    const run=data.runs[hover];
    const head=element("div","fs-tip-head");
    head.append(element("strong","",runTitle(run)),element("span","muted",`Live time ${formatLiveTime(run.live_time_sec)}`));
    const grid=element("div","fs-tip-grid");
    tip.replaceChildren(head,grid);
    // Same top-to-bottom order as the lines in the rate panel; missing values last.
    const rows=series.map((item,order)=>({item,order,rate:item.points[hover].rate ?? -Infinity}))
      .sort((a,b)=>b.rate-a.rate || a.order-b.order);
    for(const {item} of rows){
      const point=item.points[hover];
      const key=element("span","fs-key");key.style.background=item.color;
      const detail=point.bytes!=null
        ? [formatFileBytes(point.bytes),point.fileCount!=null ? `${point.fileCount} file${point.fileCount===1 ? "" : "s"}` : null].filter(Boolean).join(" · ")
        : point.error || "Not read yet";
      grid.append(key,element("span","fs-tip-name",item.name),element("strong","fs-tip-rate",formatFileBytes(point.rate,"/s")),
        deviationLabel(point.deviation),element("span","fs-tip-detail",detail));
    }
    tip.hidden=false;
    const widthLimit=get(".fs-charts").clientWidth;
    tip.style.left=`${Math.max(0,xPos+16+tip.offsetWidth>widthLimit ? xPos-16-tip.offsetWidth : xPos+16)}px`;
  }

  function setHover(index) {
    if(index===hover)return;
    hover=index;renderHover();
  }

  function renderTable() {
    const head=element("thead"), groups=element("tr"), columns=element("tr");
    for(const label of ["Run","Start","Live time"]){const cell=element("th","",label);cell.rowSpan=2;groups.append(cell);}
    for(const item of series){
      const cell=element("th","fs-group");cell.colSpan=3;cell.append(lineKey(item.color),document.createTextNode(item.name));groups.append(cell);
      columns.append(element("th","","Size"),element("th","","Rate"),element("th","","Deviation"));
    }
    head.append(groups,columns);
    const body=element("tbody");
    for(let index=data.runs.length-1;index>=0;index--){
      const run=data.runs[index], row=element("tr");
      row.append(element("td","",runTitle(run)),element("td","",formatTime(run.started_at)),element("td","",formatLiveTime(run.live_time_sec)));
      for(const item of series){
        const point=item.points[index];
        if(point.bytes==null){const cell=element("td","fs-cell-missing",point.error || "Not read yet");cell.colSpan=3;row.append(cell);continue;}
        row.append(element("td","",formatFileBytes(point.bytes)),element("td","",formatFileBytes(point.rate,"/s")),element("td","",formatDeviation(point.deviation) || "—"));
      }
      body.append(row);
    }
    get(".fs-table table").replaceChildren(head,body);
  }

  async function load() {
    const id=++requestId;
    root.classList.add("fs-loading");
    try{
      const response=await fetch(`${base}/file-sizes?limit=${limit}`);
      const value=await response.json();
      if(!response.ok)throw new Error(typeof value.detail==="string" ? value.detail : `HTTP ${response.status}`);
      if(id!==requestId || !isLive())return;
      data=value;error="";hover=null;
    }catch(problem){
      if(id!==requestId || !isLive())return;
      error=problem.message;
    }finally{
      if(id===requestId && isLive()){root.classList.remove("fs-loading");render();}
    }
  }

  // New Runs and sizes recorded after Stop change the version.
  async function poll(id) {
    if(id!==pollId || !isLive())return;
    if(!busy && data){
      try{
        const response=await fetch(`${base}/file-sizes/version`);
        const value=await response.json();
        if(id===pollId && response.ok && !busy && value.version!==data.version)await load();
      }catch{}
    }
    if(id===pollId && isLive())timer=setTimeout(()=>poll(id),3000);
  }

  async function refresh(force) {
    if(busy)return;
    if(force && !await confirm("Re-fetch all file sizes?",`Read the last ${limit} saved Runs again? Recorded sizes are kept if a read fails.`,"Re-fetch"))return;
    busy=true;renderButtons();
    try{
      const response=await fetch(`${base}/file-sizes/refresh`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({limit,force})});
      const value=await response.json();
      if(!response.ok)throw new Error(typeof value.detail==="string" ? value.detail : `HTTP ${response.status}`);
      if(!isLive())return;
      const read=value.requested-value.skipped;
      notify(!value.requested ? "No missing file sizes" : [`Read ${read} sizes`,`${value.updated} recorded`,
        value.error_count ? `${value.error_count} failed` : null,value.skipped ? `${value.skipped} skipped (API unreachable)` : null].filter(Boolean).join(" · "),
        !!(value.error_count || value.skipped));
    }catch(problem){if(isLive())notify(problem.message,true);}
    finally{busy=false;if(isLive())await load();}
  }

  get(".fs-toolbar").onclick=event=>event.stopPropagation();
  root.ontoggle=()=>{
    if(!root.open)setHover(null);
    else if(visible && data)renderCharts();
  };
  get('[data-fs="limit"]').onchange=event=>{
    limit=Number(event.target.value);
    try{localStorage.setItem(storageKey,String(limit));}catch{}
    load();
  };
  get('[data-fs="dev-scale"]').onchange=event=>{
    devScale=event.target.value;
    try{localStorage.setItem(devScaleKey,devScale);}catch{}
    if(visible && data)renderCharts();
  };
  get('[data-fs="refresh"]').onclick=()=>load();
  if(!readOnly){get('[data-fs="missing"]').onclick=()=>refresh(false);get('[data-fs="all"]').onclick=()=>refresh(true);}
  for(const plot of root.querySelectorAll(".fs-plot")){
    plot.addEventListener("pointermove",event=>{
      if(!layout)return;
      const offset=event.clientX-plot.getBoundingClientRect().left;
      setHover(offset<layout.left || offset>layout.width-RIGHT ? null : Math.min(layout.count-1,Math.max(0,Math.floor((offset-layout.left)/layout.step))));
    });
    plot.addEventListener("pointerleave",()=>setHover(null));
    plot.addEventListener("focus",()=>{if(layout && hover==null)setHover(layout.count-1);});
    plot.addEventListener("blur",()=>setHover(null));
    plot.addEventListener("keydown",event=>{
      if(!layout)return;
      const last=layout.count-1, moves={ArrowLeft:-1,ArrowRight:1};
      if(event.key in moves)setHover(Math.min(last,Math.max(0,(hover ?? last)+moves[event.key])));
      else if(event.key==="Home")setHover(0);
      else if(event.key==="End")setHover(last);
      else if(event.key==="Escape")setHover(null);
      else return;
      event.preventDefault();
    });
  }
  const observer=typeof ResizeObserver==="function" ? new ResizeObserver(()=>{
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      const width=get(".fs-charts").clientWidth;
      if(visible && width && width!==lastWidth)renderCharts();
    });
  }) : null;
  observer?.observe(root);

  return {
    async activate(on) {
      visible=on;clearTimeout(timer);
      const id=++pollId;
      if(!on){setHover(null);return;}
      await load();
      if(!readOnly)poll(id);
    },
    destroy() {requestId++;pollId++;visible=false;clearTimeout(timer);observer?.disconnect();cancelAnimationFrame(frame);},
  };
}

if(typeof module!=="undefined")module.exports={formatFileBytes,formatLiveTime,logTicks,deviationTicks,formatDeviation,fileSizeMedian,fileSizeSeries};
