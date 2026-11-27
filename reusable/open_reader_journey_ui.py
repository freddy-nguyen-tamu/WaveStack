"""Account-wide authenticated chronological IP-period timeline for generated Open Reader assets.

Reader and source-site-independent. No patient tracking, location inference, or third-party analytics.
"""
JOURNEY_HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Journey · Open Reader</title>
<style>
/* Open Reader shared storefront palette. Unique colors belong to IP branches only. */
:root {
  color-scheme:light;
  font-family:Arial,Helvetica,system-ui,sans-serif;
  --or-ink:#0f1111;--or-muted:#565959;--or-header:#131921;
  --or-navigation:#232f3e;--or-accent:#ff9900;--or-accent-soft:#febd69;
  --or-link:#007185;--or-canvas:#eaeded;--or-paper:#fff;
  --or-border:#d5d9d9;--or-gutter:clamp(16px,3.2vw,62px);
  background:var(--or-canvas);color:var(--or-ink);
}
*,*::before,*::after{box-sizing:border-box}
body{width:100%;min-width:0;min-height:100dvh;margin:0;background:var(--or-canvas)}
button,input{font:inherit}
a{color:var(--or-link)}
header{padding:18px var(--or-gutter) 22px;background:var(--or-header);color:#fff;border-bottom:7px solid var(--or-navigation)}
header a{color:#fff;font-size:13px;font-weight:700;text-decoration:none}
header a:hover{text-decoration:underline;color:var(--or-accent-soft)}
header h1{display:flex;align-items:center;margin:9px 0 8px;font-size:clamp(23px,2.3vw,33px);letter-spacing:-.035em}
header h1::before{content:"";width:20px;height:24px;margin-right:11px;border:2px solid var(--or-accent-soft);border-left-width:7px;border-radius:2px 4px 4px 2px;transform:skewY(-4deg);box-shadow:3px 3px 0 #ff990033}
header p{margin:0;color:#e7edf0;font-size:13px}
main{width:100%;max-width:1780px;margin:auto;padding:clamp(18px,3.2vw,46px) var(--or-gutter) 55px}
button{border:1px solid #c89411;border-radius:22px;background:#ffd814;color:var(--or-ink);font-size:14px;font-weight:700;cursor:pointer;padding:10px 19px;min-height:44px}
button:hover{filter:brightness(.96)}
button:focus-visible,.period:focus-visible,a:focus-visible{outline:3px solid var(--or-accent);outline-offset:3px}
#logout,#close,#exit-full{background:#fff;border-color:#a2a6a6;color:var(--or-ink)}
#info{color:var(--or-muted);padding:13px 0;min-height:1.6em;font-size:13px}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:clamp(10px,1.4vw,20px);margin:0 0 24px}
.metric{min-width:0;border:1px solid var(--or-border);border-radius:7px;background:var(--or-paper);padding:18px 21px;box-shadow:0 1px 3px #0f11110e}
.metric::before{content:"";display:block;width:36px;height:4px;background:linear-gradient(90deg,var(--or-accent),var(--or-accent-soft));margin:-18px 0 14px}
.metric strong{display:block;font-size:clamp(1.35rem,2.5vw,2rem);font-variant-numeric:tabular-nums;font-weight:800;overflow-wrap:anywhere}
.metric span{display:block;color:var(--or-muted);font-size:.83rem;margin-top:6px}
section{background:var(--or-paper);border:1px solid var(--or-border);border-radius:7px;padding:clamp(13px,2vw,24px);box-shadow:0 1px 3px #0f11110d;min-width:0}
#timeline-shell{width:100%;height:clamp(380px,61dvh,740px);min-height:350px;overflow:auto;border:1px solid #bfc6c6;border-radius:6px;background:linear-gradient(105deg,#fff,#f3f5f5);scrollbar-gutter:stable}
#timeline-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:0 2px 16px;border-bottom:1px solid #cbd1d3;margin-bottom:17px}
#timeline-toolbar>div:last-child{display:flex;flex-wrap:wrap;gap:9px}
#timeline-toolbar strong{font-size:clamp(18px,2.1vw,26px);letter-spacing:-.02em}
#timeline-toolbar p{margin:6px 0 0;color:var(--or-muted);font-size:13px;line-height:1.45}
#timeline-svg{display:block}#timeline-svg .period{cursor:pointer}
#timeline-svg .period:hover rect.band,#timeline-svg .period:focus rect.band{opacity:.23}
#timeline-scroll{overflow:visible}#timeline-scroll svg text{user-select:none}
#timeline-shell:fullscreen{display:flex;flex-direction:column;width:100vw;height:100dvh;max-height:100dvh;min-height:0;border:0;border-radius:0;background:var(--or-canvas);padding:12px;overflow:hidden}
#timeline-shell:fullscreen #fullscreen-tools{display:flex}
#fullscreen-tools{display:none;justify-content:flex-end;flex:0 0 auto;padding-bottom:7px}
#timeline-shell:fullscreen #timeline-svg{width:100%!important;height:calc(100% - 60px)!important;min-width:0!important;min-height:0!important;flex:1}
#timeline-shell:fullscreen .fullscreen-tip{display:block}
.fullscreen-tip{display:none;align-self:center;color:var(--or-muted);font-size:.78rem}
#timeline-shell:fullscreen #timeline-scroll{flex:1;overflow:hidden;min-height:0}
#modal{width:min(970px,96vw);max-height:94dvh;border:1px solid var(--or-border);border-radius:8px;padding:0;box-shadow:0 24px 100px #0b1e3565;background:var(--or-paper);color:var(--or-ink)}
#modal::backdrop{background:#0f1111a8}
.modalheader{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;background:var(--or-navigation);border-top:5px solid var(--or-accent);color:#fff;padding:15px 20px}
.modalheader h2{margin:0;font-size:1.1rem;overflow-wrap:anywhere}
.modalheader small{color:#d5e1e8}
.modalbody{padding:15px;overflow:auto;max-height:calc(94dvh - 78px)}
#map{height:clamp(190px,33dvh,370px);border:1px solid var(--or-border);border-radius:7px;background:#eaeded}
#map-message{color:var(--or-muted);min-height:20px;font-size:.85rem;margin:8px 0}
#actions{width:100%;border-collapse:collapse;min-width:520px}
#actions td,#actions th{border-bottom:1px solid #dfe5e5;padding:10px;text-align:left;font-size:.86rem}
#actions th{background:#f0f2f2;position:sticky;top:0;color:#343b3e}
#action-scroll{max-height:300px;overflow:auto;border-radius:5px;border:1px solid var(--or-border)}
#loadmore{margin-top:10px;display:none}
#empty{text-align:center;padding:30px;color:var(--or-muted)}
footer{color:var(--or-muted)!important}
@media(max-width:760px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.metrics{gap:9px}.metric{padding:15px 12px}header{padding:16px var(--or-gutter)}#timeline-shell{height:clamp(340px,56dvh,620px)}.modalheader{padding:12px}#modal{width:98vw}#timeline-toolbar>div:last-child{width:100%}#timeline-toolbar button{flex:1}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head>
<body><header><a href="/">← Open Reader</a><h1>Your Journey</h1><p>Visits in chronological IP periods · private administrator view</p></header>
<main><div class="metrics"><div class="metric"><strong id="pagecount">–</strong><span>Page visits</span></div><div class="metric"><strong id="readcount">–</strong><span>Chapter opens</span></div><div class="metric"><strong id="periodcount">–</strong><span>IP periods loaded</span></div><div class="metric"><strong id="citycount">–</strong><span>Locations (chapter opens)</span></div></div>
<section><div id="timeline-toolbar"><div><strong>Chronological visitor tree</strong><p>Downward timeline · each uninterrupted IP run is one colored segment · click anywhere on a segment</p></div><div><button id="refresh" type="button">Refresh</button> <button id="full" type="button">View full tree page</button> <button id="logout" type="button">Sign out</button></div></div>
<div style="display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:0 0 12px"><label for="archive-select">History source</label><select id="archive-select" style="font:inherit;max-width:100%;padding:10px;border:1px solid var(--or-border);border-radius:6px;background:#fff"><option value="">Recent visits (D1)</option></select><button id="archive-load" type="button">Load archived batches</button><span id="archive-status" role="status" style="font-size:13px;color:var(--or-muted)"></span></div><div id="timeline-shell"><div id="fullscreen-tools"><button id="exit-full" type="button">Exit full screen</button></div><div id="timeline-scroll"><svg id="timeline-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chronological IP-period tree"></svg></div><div class="fullscreen-tip">Scaled to show the current tree page · Esc or Back to exit</div></div>
<div style="display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:12px"><button id="newer" type="button" disabled>Newer periods</button><button id="older" type="button" disabled>Older periods</button></div>
<div id="info" role="status" aria-live="polite">Loading your timeline…</div><div id="empty" hidden>No visitor periods recorded yet.</div></section>
<dialog id="modal" aria-label="Visitor period details"><div class="modalheader"><div><h2 id="detailtitle">Visitor period</h2><small id="detailmeta"></small></div><button id="close" type="button" aria-label="Close details">Close ×</button></div><div class="modalbody"><div id="map" aria-label="Draggable approximate location map"></div><div id="map-message"></div><div id="action-scroll"><table id="actions"><thead><tr><th>Time</th><th>Event</th><th>Route / chapter</th><th>Approximate location</th></tr></thead><tbody id="actionbody"></tbody></table></div><button id="loadmore" type="button">Load more actions</button></div></dialog>
<footer style="color:#61748a;padding:15px 5px;font-size:.82rem">Recent detailed records move nightly to a private GitHub archive after verified transfer. Select an archived batch to view its timeline; an IP period spanning batches is shown in separate segments. Lifetime totals remain available. Approximate location is based on Cloudflare's network geolocation, not GPS. Map tiles © OpenStreetMap contributors.</footer></main>
<script>
(()=>{'use strict';
const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
const shell=$('timeline-shell'),svg=$('timeline-svg'),modal=$('modal');
let archiveId="",archiveOffset=0,archiveDone=false;
let periods=[],active=null,periodOffset=0,olderOffset=null,snapshot=null,fetching=false,nextEvents=null,map=null,mapMarkers=null,allGeo=[],fullscreenBack=false,actionGeneration=0,actionBusy=false;
const nice=t=>{const d=new Date(t);return Number.isFinite(d.valueOf())?d.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Unknown'};
const num=n=>Number(n||0).toLocaleString();
function color(ip,id){let x=2166136261;for(const c of ip+'|'+id){x^=c.charCodeAt(0);x=Math.imul(x,16777619)}return 'hsl('+((x>>>0)%360)+' 68% 43%)'}
function lane(ip,id){let x=0;for(const c of ip){x=(Math.imul(x,31)+c.charCodeAt(0))>>>0}return 125+(x%8)*78+(id%2)*12}
function sEl(tag,attrs={},text){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=String(text);return e}
function draw(){
 svg.replaceChildren();const width=1240,unit=110,height=Math.max(220,periods.length*unit+98);
 svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('preserveAspectRatio','xMidYMin meet');
 svg.style.width=Math.max(1080,shell.clientWidth-35)+'px';svg.style.height=height+'px';
 svg.append(sEl('text',{x:20,y:29,'font-size':15,fill:'#565959','font-weight':700},'EARLIEST ON THIS PAGE ↓  |  IP period sequence'));
 let previous=125;
 periods.forEach((p,i)=>{
  const y=54+i*unit,col=color(p.ip,p.period_id),x=lane(p.ip,p.period_id);
  // A colored branch connects every period to its predecessor.
  if(i)svg.append(sEl('path',{d:`M ${previous} ${y-32} V ${y-12} H ${x} V ${y+14}`,fill:'none',stroke:col,'stroke-width':5,'stroke-linejoin':'round',opacity:.74}));
  const g=sEl('g',{class:'period',role:'button',tabindex:'0','aria-label':`${p.ip}-${nice(p.start_at)} to ${nice(p.end_at)}; ${p.actions} actions`});
  const b=sEl('rect',{class:'band',x:16,y:y,width:width-35,height:unit-12,rx:13,fill:col,opacity:.085});g.append(b);
  g.append(sEl('rect',{x:16,y:y,width:width-35,height:unit-12,rx:13,fill:'transparent','pointer-events':'all'}));
  g.append(sEl('circle',{cx:x,cy:y+37,r:17,fill:col,stroke:'#fff','stroke-width':4}));
  g.append(sEl('line',{x1:x,y1:y+36,x2:710,y2:y+36,stroke:col,'stroke-width':3,'stroke-dasharray':'10 8'}));
  g.append(sEl('text',{x:725,y:y+25,'font-size':18,'font-weight':750,fill:'#0f1111'},`${p.ip} · ${num(p.actions)} actions`));
  g.append(sEl('text',{x:725,y:y+53,'font-size':13,fill:'#565959'},`${nice(p.start_at)}  →  ${nice(p.end_at)}`));
  g.append(sEl('text',{x:725,y:y+73,'font-size':12,fill:'#565959'},`Period ${p.period_id} · ${p.city||'Unknown'}, ${p.country||'Unknown'}`));
  g.addEventListener('click',()=>openPeriod(p));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPeriod(p)}});
  svg.append(g);previous=x;
 });
 if(document.fullscreenElement===shell){svg.style.width='100%';svg.style.height='100%';svg.setAttribute('preserveAspectRatio','xMidYMid meet')}
 $('periodcount').textContent=num(periods.length);
}
async function read(url){const r=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(r.status===401){location.replace('/login/?next='+encodeURIComponent(location.pathname));throw Error('Sign-in required')}const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function updatePaging(){ $('newer').disabled=fetching||periodOffset===0;$('older').disabled=fetching||olderOffset===null; }
async function loadPeriods(offset=0,renew=false){if(fetching)return;fetching=true;updatePaging();try{
  $('info').textContent='Loading chronological IP runs…';
  if(renew){const stats=await read('/api/journey/stats');$('pagecount').textContent=num(stats.totals.page_view);$('readcount').textContent=num(stats.totals.chapter_read);$('citycount').textContent=num(stats.location_count??stats.cities?.length);}
  const query='/api/journey/periods?offset='+offset+(!renew&&snapshot!==null?'&snapshot='+snapshot:'')+(archiveId?'&archive='+archiveId:'');
  const data=await read(query);
  if(!Array.isArray(data.periods)||!Number.isSafeInteger(data.snapshot)||data.snapshot<0||
    (data.next_offset!==null&&(!Number.isSafeInteger(data.next_offset)||data.next_offset<=offset)))throw Error('Invalid history pagination response');
  snapshot=data.snapshot;periodOffset=offset;olderOffset=data.next_offset;
  periods=data.periods.sort((a,b)=>a.period_id-b.period_id);draw();$('empty').hidden=periods.length!==0;
  shell.scrollTop=0;$('info').textContent=periods.length?`Showing ${num(periods.length)} IP periods, oldest first within this page. ${num(offset)} newer periods. Use Older periods to browse this batch; select archived batches for older visits.`:(archiveId?'No visits in this archived batch.':'No pending visits. Select an archived batch to view history.');
 }catch(e){$('info').textContent=e.message}finally{fetching=false;updatePaging()}}
function refresh(){archiveOffset=0;archiveDone=false;$('archive-load').disabled=false;$('archive-load').textContent='Load archived batches';$('archive-status').textContent='';return loadPeriods(0,true)}
$('archive-load').onclick=async()=>{if(archiveDone)return;$('archive-load').disabled=true;try{const d=await read('/api/journey/archives?offset='+archiveOffset);for(const b of d.batches){if(!/^[a-f0-9]{64}$/.test(b.digest)||Array.from($('archive-select').options).some(o=>o.value===b.digest))continue;const o=document.createElement('option');o.value=b.digest;o.textContent=nice(b.start_at)+' – '+nice(b.end_at)+' · '+num(b.event_count)+' visits';$('archive-select').append(o)}archiveDone=d.next_offset===null;archiveOffset=d.next_offset??archiveOffset;$('archive-status').textContent=archiveDone?'All archived batches listed':'More archived batches available';$('archive-load').textContent=archiveDone?'All batches listed':'Load older batches';}catch(e){$('archive-status').textContent=e.message}finally{$('archive-load').disabled=archiveDone}};
$('archive-select').onchange=()=>{if(fetching){$('archive-select').value=archiveId;return}archiveId=$('archive-select').value;snapshot=null;periodOffset=0;olderOffset=null;periods=[];draw();loadPeriods(0,true)};
$('newer').onclick=()=>loadPeriods(Math.max(0,periodOffset-250));$('older').onclick=()=>{if(olderOffset!==null)loadPeriods(olderOffset)};
function row(e){const tr=document.createElement('tr');for(const value of [nice(e.created_at),e.kind,(e.slug?e.slug+(e.chapter?' / '+e.chapter:''):e.path),[e.city,e.region,e.country].filter(v=>v&&v!=='Unknown').join(', ')||'Unknown']){const td=document.createElement('td');td.textContent=value;tr.append(td)}$('actionbody').append(tr)}
async function leaflet(){if(window.L)return window.L;return new Promise((resolve,reject)=>{
 const link=document.createElement('link');link.rel='stylesheet';link.href='https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';document.head.append(link);
 const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';script.onload=()=>resolve(window.L);script.onerror=()=>reject(Error('Map library unavailable'));document.head.append(script);
})}
async function mapDraw(){if(!allGeo.length){$('map-message').textContent='No geographic coordinates in this period. Historic records remain listed without inferred coordinates.';$('map').hidden=true;return}
 $('map').hidden=false;try{const L=await leaflet();if(!modal.open)return;
 if(!map){map=L.map('map',{zoomControl:true,scrollWheelZoom:false});L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap contributors'}).addTo(map);mapMarkers=L.layerGroup().addTo(map)}
 mapMarkers.clearLayers();const seen=new Set(),bounds=[];
 for(const e of allGeo){const la=Number(e.latitude),lo=Number(e.longitude);if(!Number.isFinite(la)||!Number.isFinite(lo)||Math.abs(la)>90||Math.abs(lo)>180)continue;
 const key=la.toFixed(2)+'|'+lo.toFixed(2);if(seen.has(key))continue;seen.add(key);bounds.push([la,lo]);
 const label=document.createElement('span');label.textContent=[e.city,e.region,e.country].filter(Boolean).join(', ');const marker=L.marker([la,lo]).bindPopup(label);mapMarkers.addLayer(marker)}
 map.invalidateSize();if(bounds.length>1)map.fitBounds(bounds,{padding:[25,25],maxZoom:9});else if(bounds.length)map.setView(bounds[0],8);
 $('map-message').textContent='Drag the map to explore. Pins show approximate network-derived locations; they are not GPS.';
 }catch(e){$('map-message').textContent=e.message+'; event locations remain listed.'}}
async function loadActions(){if(!active||actionBusy||nextEvents===null)return;const selected=active,gen=actionGeneration,offset=nextEvents;actionBusy=true;$('loadmore').disabled=true;try{
 const d=await read('/api/journey/period-events?period='+selected.period_id+'&offset='+offset+'&snapshot='+selected.snapshot+(selected.archive?'&archive='+selected.archive:''));if(gen!==actionGeneration||selected!==active)return;
 if(!Array.isArray(d.events)||(d.next_offset!==null&&(!Number.isSafeInteger(d.next_offset)||d.next_offset<=offset)))throw Error('Invalid action pagination response');
 d.events.forEach(e=>{row(e);if(e.latitude!==null&&e.latitude!==undefined&&e.longitude!==null&&e.longitude!==undefined)allGeo.push(e)});
 nextEvents=d.next_offset;$('loadmore').style.display=nextEvents===null?'none':'inline-block';await mapDraw();
 }catch(e){if(gen===actionGeneration){$('map-message').textContent=e.message;$('loadmore').style.display='inline-block'}}finally{if(gen===actionGeneration){actionBusy=false;$('loadmore').disabled=false}}}
function openPeriod(p){actionGeneration++;actionBusy=false;active={...p,snapshot,archive:archiveId};nextEvents=0;allGeo=[];$('loadmore').style.display='none';$('actionbody').replaceChildren();$('detailtitle').textContent=`${p.ip}-${nice(p.start_at)} → ${nice(p.end_at)}`;
 $('detailmeta').textContent=`${num(p.actions)} actions · period ${p.period_id}`;$('map').hidden=true;$('map-message').textContent='Loading period locations…';modal.showModal();loadActions()}
modal.addEventListener('close',()=>{actionGeneration++;actionBusy=false;active=null;nextEvents=null});$('close').onclick=()=>modal.close();$('loadmore').onclick=()=>{if(nextEvents!==null)loadActions()};$('refresh').onclick=refresh;
$('logout').onclick=async()=>{await fetch('/api/admin/logout',{method:'POST',credentials:'same-origin',headers:{Origin:location.origin}});location.replace('/login/')};
async function enterFullscreen(){if(!shell.requestFullscreen){$('info').textContent='Fullscreen unavailable in this browser';return}try{await shell.requestFullscreen();history.pushState({journeyFullscreen:true},'',location.pathname+location.search+'#timeline-fullscreen');fullscreenBack=true;draw()}catch(e){$('info').textContent=e.message}}
function exitFullscreen(){if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});if(fullscreenBack){fullscreenBack=false;history.replaceState(null,'',location.pathname+location.search)}}
$('full').onclick=enterFullscreen;$('exit-full').onclick=exitFullscreen;
document.addEventListener('fullscreenchange',()=>{draw();if(!document.fullscreenElement&&fullscreenBack){fullscreenBack=false;history.replaceState(null,'',location.pathname+location.search)}});
window.addEventListener('popstate',()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});if(modal.open)modal.close()});
let resizeTick;window.addEventListener('resize',()=>{clearTimeout(resizeTick);resizeTick=setTimeout(draw,130)});
refresh();
})();
</script></body></html>'''
