'use strict';
const $=id=>document.getElementById(id), api='/api/arcade/', MAX=16*1024*1024;
let checkpointKind='', fullCheckpoint=false;
let profile='', active=null, capture=null, ready=false, etag=null, localKey='', lastHash='', blocked=false, running=null, draft=null, timer=null, lastCloud=0;
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const digest=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
const status=(s,bad=false)=>{$('status').textContent=s;$('status').dataset.error=String(bad);};
const req=(url,opts={})=>fetch(api+url,{...opts,credentials:'same-origin',cache:'no-store',headers:{...(profile?{'X-Arcade-Profile':profile}:{}),...opts.headers}});
async function expect(r){if(!r.ok){let error;try{error=(await r.json()).error;}catch{}throw Error(error||`HTTP ${r.status}`);}return r;}
let database;
function db(){return database??=new Promise((resolve,reject)=>{const r=indexedDB.open('open-reader-arcade-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function local(mode,value){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('drafts',mode==='get'?'readonly':'readwrite'),store=tx.objectStore('drafts');const r=mode==='get'?store.get(localKey):mode==='put'?store.put(value,localKey):store.delete(localKey);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
async function setDraft(value){draft=value;try{await local('put',value);}catch{status('Local storage unavailable; attempting cloud save.',true);}}
function script(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('Emulator runtime could not load'));document.head.append(s);});}
const route=g=>`/arcade/${g.id}/`;
function showLibrary(games){$('library').hidden=false;for(const game of games){const card=document.createElement('article'),h=document.createElement('h2'),p=document.createElement('p'),b=document.createElement('button');h.textContent=game.title;p.textContent=game.ready?(game.engine==='ruffle'?'Flash · native game saves':game.engine==='psx'?'PlayStation · emulator save states':'Arcade · emulator save states'):(game.reason||'Game files not installed');b.textContent='Play / continue';b.disabled=!game.ready;b.onclick=()=>location.assign(route(game));card.append(h,p,b);$('games').append(card);}status('Cloud saves connected.');}
const savePath=()=>`save/${active.id}/${active.version}`;
const romPath=f=>`${location.origin}${api}rom/${active.id}/${active.version}/${f.name}`;
// Fetch immutable authenticated Cloudflare parts with bounded parallelism.
// Reuse the existing verified local cache keys from v4.
async function loadDisc(game){
 const d=game.disc,files=game.files;
 if(!d||!Array.isArray(d.parts)||!d.parts.length||d.parts.length>100||!Number.isSafeInteger(d.size)||d.size<=0||d.size>700*1024*1024||!/^[a-z0-9-]+\.chd$/.test(d.name))throw Error('Invalid disc catalog');
 const parts=d.parts.map((name,i)=>{const f=files.find(x=>x.name===name);if(name!==`disc-${String(i).padStart(4,'0')}.part`||!f||!Number.isSafeInteger(f.size)||f.size<=0||f.size>8*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha))throw Error('Invalid disc part '+name);return f;});
 if(parts.reduce((n,f)=>n+f.size,0)!==d.size)throw Error('Disc size mismatch');
 let cache=null;try{cache=await caches.open('open-reader-arcade-disc-v1-'+profile);}catch{}
 let received=0,cursor=0,failed=null;const chunks=new Array(parts.length),controller=new AbortController();
 async function fetchPart(f){
  const key=romPath(f)+'?verified='+f.sha;
  const url=`/arcade-disc/${f.sha}/${f.name}`;let bytes=null;
  if(cache)try{const hit=await cache.match(key);if(hit){const b=new Uint8Array(await hit.arrayBuffer());if(b.length===f.size&&await digest(b)===f.sha)bytes=b;else await cache.delete(key);}}catch{}
  if(!bytes){let error;for(let attempt=0;attempt<5;attempt++){
   try{
    if(controller.signal.aborted)throw Object.assign(Error('Disc loading cancelled'),{fatal:true});
    const r=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])});
    if(!r.ok){let detail='';try{detail=(await r.json()).error||'';}catch{}const ray=r.headers.get('cf-ray');throw Object.assign(Error(`${f.name}: Cloudflare HTTP ${r.status}${detail?' — '+detail:''}${ray?' (Ray '+ray+')':''}`),{fatal:[401,403,404].includes(r.status)});}
    if(r.headers.get('X-Arcade-Storage')!=='cloudflare-static-assets')throw Object.assign(Error('Disc route is not running Arcade Cloudflare v5. Redeploy and refresh.'),{fatal:true});
    const b=new Uint8Array(await r.arrayBuffer());if(b.length!==f.size||await digest(b)!==f.sha)throw Error(f.name+': disc part integrity mismatch');bytes=b;break;
   }catch(e){error=e;if(e.fatal||controller.signal.aborted)throw e;if(attempt<4)await new Promise(r=>setTimeout(r,Math.min(12000,1000*2**attempt)));}
  }if(!bytes)throw error;if(cache)try{await cache.put(key,new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}}));}catch{}}
  return bytes;
 }
 async function worker(){while(!failed&&cursor<parts.length){const i=cursor++;try{const b=await fetchPart(parts[i]);chunks[i]=b;received+=b.length;if(!failed)status(`Loading disc from Cloudflare: ${Math.round(received/d.size*100)}% (${Math.round(received/1048576)} / ${Math.round(d.size/1048576)} MiB)`);}catch(e){if(!failed){failed=e;controller.abort();}return;}}}
 await Promise.all(Array.from({length:Math.min(4,parts.length)},worker));if(failed)throw failed;
 const file=new File(chunks,`${profile}-${game.version.slice(0,16)}-${d.name}`,{type:'application/octet-stream'});
 if(file.size!==d.size)throw Error('Disc reconstruction failed');return file;
}

// Compress in the browser, not the Free Worker; local drafts remain raw emulator bytes.
function to64(bytes){if(typeof bytes.toBase64==='function')return bytes.toBase64();let out='';for(let i=0;i<bytes.length;i+=24576)out+=btoa(String.fromCharCode(...bytes.subarray(i,i+24576)));return out;}
function from64(s){if(typeof Uint8Array.fromBase64==='function')return Uint8Array.fromBase64(s);const raw=atob(s),b=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);return b;}
async function encodeSave(bytes){if(typeof CompressionStream==='function'&&bytes.length>=1024){const gz=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());if(gz.length<bytes.length)return 'gzip:'+to64(gz);}return 'raw:'+to64(bytes);}
async function decodeSave(wire){const prefix=wire.startsWith('raw:')?4:wire.startsWith('gzip:')?5:0;if(!prefix||wire.length>4*Math.ceil(MAX/3)+5)throw Error('Invalid cloud checkpoint encoding');const bytes=from64(wire.slice(prefix));if(prefix===4){if(bytes.length>MAX)throw Error('Checkpoint too large');return bytes;}if(typeof DecompressionStream!=='function')throw Error('Browser does not support gzip save restoration');const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();let n=0,parts=[];try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>MAX){await reader.cancel();throw Error('Checkpoint too large');}parts.push(value);}}finally{reader.releaseLock();}const out=new Uint8Array(n);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;}
// arcade-save-v7: scoped Flash storage and verified PlayStation checkpoint capture.
const CARD_TAG=new TextEncoder().encode('OR-PSX-CARD-V7\0');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function asBytes(x){if(x instanceof ArrayBuffer)return new Uint8Array(x).slice();if(ArrayBuffer.isView(x))return new Uint8Array(x.buffer,x.byteOffset,x.byteLength).slice();return null;}
function isCard(x){return !!x&&x.length>CARD_TAG.length&&CARD_TAG.every((b,i)=>x[i]===b);}
function wrapCard(x){const out=new Uint8Array(CARD_TAG.length+x.length);out.set(CARD_TAG);out.set(x,CARD_TAG.length);return out;}
function validSOL(v){try{if(typeof v!=='string'||v.length<16||v.length>4*Math.ceil(MAX/3))return false;const h=atob(v.slice(0,16));return h.charCodeAt(0)===0&&h.charCodeAt(1)===191&&h.slice(6,10)==='TCSO';}catch{return false;}}
function flashStorage(url,initial,onWrite){
 const native=window.localStorage, u=new URL(url,location.href), host=u.hostname+'/', path=u.pathname.replace(/^\//,'');
 const root=host+path+'/', folder=host+path.slice(0,path.lastIndexOf('/')+1);
 // The core uses host/localPath/name, including host//name for explicit root scope.
 // Only migrate known game-specific legacy records; never scan other site data into cloud.
 const allowed=k=>typeof k==='string'&&k.startsWith(host)&&k.length<4096&&!k.split('/').some(p=>p.startsWith('.'));
 const known=k=>allowed(k)&&(k.startsWith(root)||k.startsWith(folder)||/chaos[-_ ]?faction[-_ ]?2/i.test(k));
 const map=new Map();let hadNative=false;
 if(initial){const data=JSON.parse(new TextDecoder().decode(initial));if(data.format!=='ruffle-sharedobjects-v1'||!Array.isArray(data.entries))throw Error('Unrecognized Flash save');for(const p of data.entries){if(!Array.isArray(p)||p.length!==2||p.some(x=>typeof x!=='string'))throw Error('Invalid Flash SharedObject checkpoint');if(allowed(p[0])&&validSOL(p[1]))map.set(p[0],p[1]);}if(data.entries.length&&!map.size)throw Error('Previous Flash checkpoint contains no valid SharedObjects; preserved for recovery');hadNative=true;}
 else{for(let i=0;i<native.length;i++){const k=native.key(i);if(known(k)){const v=native.getItem(k);if(validSOL(v)){map.set(k,v);hadNative=true;}}}}
 // A game-specific shadow Storage supports WebIDL named properties AND method calls.
 // It is confined to this document; real Open Reader localStorage is never copied wholesale.
 const misc=new Map(), removed=new Set();const all=()=>new Map([...misc,...map]);
 // Recover legacy root-scoped SharedObjects only when the game asks for that exact key.
 const get=k=>{k=String(k);if(map.has(k))return map.get(k);if(misc.has(k))return misc.get(k);if(!initial&&!removed.has(k)&&allowed(k)){const v=native.getItem(k);if(validSOL(v)){map.set(k,v);hadNative=true;onWrite();return v;}}return undefined;};
 const set=(k,v)=>{k=String(k);v=String(v);removed.add(k);if(allowed(k)&&validSOL(v)){if(map.get(k)!==v){map.set(k,v);hadNative=true;onWrite();}}else{if(map.delete(k)){hadNative=true;onWrite();}misc.set(k,v);}};
 const del=k=>{k=String(k);removed.add(k);misc.delete(k);if(map.delete(k)){hadNative=true;onWrite();}};
 const methods={getItem:k=>get(k)??null,setItem:set,removeItem:del,key:i=>[...all().keys()][Number(i)]??null,clear:()=>{misc.clear();if(map.size){for(const k of map.keys())removed.add(k);map.clear();hadNative=true;onWrite();}}};
 const target=Object.create(Storage.prototype), proxy=new Proxy(target,{
  get(t,k){if(k==='length')return all().size;if(Object.hasOwn(methods,k))return methods[k];if(k===Symbol.toStringTag)return 'Storage';return typeof k==='string'?get(k):undefined;},
  set(t,k,v){set(k,v);return true;},deleteProperty(t,k){del(k);return true;},
  ownKeys(){return [...all().keys()];},has(t,k){return k==='length'||Object.hasOwn(methods,k)||all().has(k);},
  getOwnPropertyDescriptor(t,k){if(all().has(k))return {value:all().get(k),configurable:true,enumerable:true,writable:true};}
 });
 Object.defineProperty(window,'localStorage',{configurable:true,get:()=>proxy});
 if(window.localStorage!==proxy)throw Error('Could not attach Flash save storage');
 return ()=>hadNative?new TextEncoder().encode(JSON.stringify({format:'ruffle-sharedobjects-v1',entries:[...map].sort((a,b)=>a[0].localeCompare(b[0]))})):null;
}
async function capturePSX(gm,hasFull){
 let reason='empty state';
 for(let i=0;i<3;i++){
  try{const bytes=asBytes(await gm.getState());if(bytes?.length){if(bytes.length>MAX)throw Error('full state exceeds 16 MiB');return bytes;}reason='core returned zero bytes';}catch(e){reason=e.message||String(e);}
  if(i<2)await sleep(150*(i+1));
 }
 if(hasFull())throw Error('Full PlayStation state unavailable ('+reason+'); previous full checkpoint preserved');
 try{const card=asBytes(await gm.getSaveFile());if(card?.length===131072&&card[0]===77&&card[1]===67)return wrapCard(card);throw Error('No valid 128 KiB memory card available');}catch(e){throw Error('PlayStation state unavailable ('+reason+'); memory card fallback: '+e.message);}
}
async function restorePSX(gm,bytes){
 if(!isCard(bytes)){await gm.loadState(bytes);return;}
 const card=bytes.subarray(CARD_TAG.length);if(card.length!==131072||card[0]!==77||card[1]!==67)throw Error('Invalid PlayStation memory card checkpoint');
 const p=gm.getSaveFilePath();if(typeof p!=='string'||!p.startsWith('/data/saves/')||p.split('/').includes('..'))throw Error('Unexpected emulator memory card path');
 gm.writeFile(p,card);gm.loadSaveFiles();
}

async function cloudRead(){const r=await req(savePath());if(r.status===404)return {etag:null,bytes:null};await expect(r);const tag=r.headers.get('ETag');if(!tag)throw Error('Cloud save missing revision');return {etag:tag,bytes:await decodeSave(await r.text())};}
async function checkpoint(force=false){
 if(!ready||!capture||blocked){if(force)status(blocked?'Cloud save blocked; resolve the previous error or conflict.':'Game is not ready to save yet.',true);return false;}
 if(running){await running;return force?checkpoint(true):false;}
 running=(async()=>{try{
  if(force)status('Capturing game progress…');const raw=await capture();if(!raw||!raw.byteLength){if(force)status(active.engine==='ruffle'?'Flash has not written native progress yet. Finish a level or use the in-game save, then retry.':'Emulator returned no checkpoint; previous save preserved.',true);return false;}
  checkpointKind=active.engine==='ruffle'?'Flash native progress':isCard(raw)?'PlayStation memory card (in-game progress only)':'Full emulator state';
  const bytes=new Uint8Array(raw);if(bytes.length>MAX)throw Error('Checkpoint exceeds 16 MiB');const hash=await digest(bytes);
  if(hash===lastHash){if(force)status(checkpointKind+' already synced.');return true;}
  await setDraft({bytes,hash,base:etag,pending:true});if(active.engine==='psx'&&!isCard(bytes))fullCheckpoint=true;
  const r=await req(savePath(),{method:'PUT',headers:{'Content-Type':'text/plain; charset=utf-8',...(etag?{'If-Match':etag}:{'If-None-Match':'*'})},body:await encodeSave(bytes),signal:AbortSignal.timeout(60000)});
  if(r.status===412||r.status===409){blocked=true;status('Cloud conflict: another device updated the shared save. Export this local checkpoint before reopening; cloud save was not overwritten.',true);return false;}
  await expect(r);const next=r.headers.get('ETag');if(!next)throw Error('Cloud write response missing revision');etag=next;lastHash=hash;lastCloud=Date.now();if(active.engine==='psx'&&!isCard(bytes))fullCheckpoint=true;await setDraft({bytes,hash,base:etag,pending:false});status(checkpointKind+' cloud saved ('+bytes.length.toLocaleString()+' bytes) at '+new Date(lastCloud).toLocaleTimeString()+'. Safe to continue on another device.');return true;
 }catch(e){status('Cloud save not confirmed: '+e.message+'. Local checkpoint retained if browser storage is available.',true);return false;}})();
 try{return await running;}finally{running=null;}
}
async function start(game){active=game;$('player').hidden=false;$('title').textContent=game.title;$('save').disabled=true;$('exit').disabled=true;localKey=profile+'/'+game.id+'/'+game.version;
 status('Checking cloud checkpoint before starting…');const cloud=await cloudRead();etag=cloud.etag;lastHash=cloud.bytes?await digest(cloud.bytes):'';
 try{draft=await local('get');}catch{draft=null;}
 let initial=cloud.bytes;fullCheckpoint=game.engine==='psx'&&!!cloud.bytes&&!isCard(cloud.bytes);
 if(draft?.pending&&draft?.bytes&&draft.hash!==lastHash){if(draft.base===etag){if(confirm('A newer unsynced checkpoint exists on this device. Resume it and sync to cloud?'))initial=new Uint8Array(draft.bytes);else await setDraft({bytes:initial,hash:lastHash,base:etag,pending:false});}else{blocked=true;status('An unsynced local checkpoint conflicts with cloud progress. Export it, then choose Reload cloud to discard this local draft.',true);const b=document.createElement('button');b.textContent='Reload cloud (discard local draft)';b.onclick=async()=>{if(confirm('Discard the conflicting local checkpoint?')){await local('delete');location.reload();}};$('player').append(b);return;}}
 if(initial===cloud.bytes && cloud.bytes)await setDraft({bytes:cloud.bytes,hash:lastHash,base:etag,pending:false});
 function begin(){ready=true;$('save').disabled=false;$('exit').disabled=false;status(initial?'Saved checkpoint supplied to emulator. Cloud autosave enabled.':'Game started. Cloud autosave enabled.');timer=setInterval(()=>void checkpoint(),30000);if(initial&&draft?.pending&&draft.hash!==lastHash)void checkpoint();}
 if(game.engine==='ruffle'){
  let flushTimer=null;
  capture=flashStorage(romPath(game.files[0]),initial,()=>{clearTimeout(flushTimer);flushTimer=setTimeout(()=>{if(ready)void checkpoint();},1000);});
  window.RufflePlayer={config:{autoplay:'on',allowScriptAccess:false,allowNetworking:'internal'}};await script('/arcade/ruffle/ruffle.js');const player=window.RufflePlayer.newest().createPlayer();$('game').append(player);await player.ruffle().load({url:romPath(game.files[0]),autoplay:'on',allowScriptAccess:false,allowNetworking:'internal'});begin();status(initial?'Flash native save restored. New progress syncs every 30 seconds.':'Flash loaded. Progress syncs after the game writes its native save.');if(capture())void checkpoint();
 }else{
  const psx=game.engine==='psx';const gameUrl=psx?await loadDisc(game):romPath(game.files[0]);
  const bios=psx&&game.bios?game.files.find(f=>f.name===game.bios):null;
  const base='https://cdn.emulatorjs.org/4.2.3/data/';Object.assign(window,{EJS_player:'#game',EJS_core:psx?'pcsx_rearmed':'mame2003_plus',EJS_gameUrl:gameUrl,...(psx?{EJS_gameName:gameUrl.name,EJS_disableCue:true,EJS_defaultOptions:{retroarch_core:'pcsx_rearmed'},...(bios?{EJS_biosUrl:romPath(bios)}:{})}:{}),EJS_pathtodata:base,EJS_gameID:parseInt((await digest(new TextEncoder().encode(localKey))).slice(0,8),16),EJS_startOnLoaded:true,EJS_threads:false,EJS_disableDatabases:true,EJS_onGameStart:async()=>{try{const emulator=window.EJS_emulator;const gm=emulator?.gameManager;if(psx&&emulator?.getCore?.()!=='pcsx_rearmed')throw Error('Unexpected PlayStation core; cloud saves disabled to protect compatibility');if(!gm||typeof gm.getState!=='function'||typeof gm.loadState!=='function')throw Error('Save-state API unavailable');if(!psx&&gm.functions?.supportsStates&&!gm.functions.supportsStates())throw Error('This core does not support save states for this ROM');if(initial){if(psx)await restorePSX(gm,initial);else await gm.loadState(initial);status(isCard(initial)?'Memory card restored; use the in-game load menu.':'Checkpoint passed to emulator; verify that the fight resumed.');}if(psx&&initial&&!isCard(initial))fullCheckpoint=true;capture=psx?()=>capturePSX(gm,()=>fullCheckpoint):async()=>{const x=asBytes(await gm.getState());if(!x?.length)throw Error('Core returned empty state');return x;};if(initial&&!isCard(initial)){const b=document.createElement('button');b.textContent='Confirm resumed game & enable autosave';b.onclick=()=>{b.remove();begin();};$('player').querySelector('.actions').append(b);status('Cloud checkpoint loaded into emulator. Confirm that the game resumed before enabling autosave.');}else{begin();if(isCard(initial))status('Cloud memory card restored. Load in-game progress; autosave enabled.');}}catch(e){blocked=true;status('Game save unavailable: '+e.message,true);}}});
  // MAME ZIP keeps its basename; PSX File keeps the original CHD extension.
  await script(base+'loader.js');setTimeout(()=>{if(!ready&&!blocked)status('Emulator did not report game start. Verify the ROM/core combination in browser console.',true);},90000);
 }
}
// arcade-home-return-v6
const homeReturn = $('home-return');
if (homeReturn) {
 let leavingHome = false;
 homeReturn.addEventListener('click', async e => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  if (leavingHome) return;
  leavingHome = true;
  try {
   if (!active) { location.assign('/'); return; }
   if (ready && !blocked) {
    status('Saving cloud progress before returning…');
    if (await checkpoint(true)) { location.assign('/'); return; }
   }
   if (confirm('Cloud save not confirmed. Return to Open Reader homepage anyway? Recent progress may be lost.')) location.assign('/');
  } catch (err) { status('Unable to return safely: '+err.message,true); }
  finally { leavingHome = false; }
 });
}
$('leave').onclick=e=>{if(!confirm('Leave without waiting for a cloud save? Recent progress may be lost.'))e.preventDefault();};
$('save').onclick=()=>void checkpoint(true);
$('exit').onclick=async()=>{if(await checkpoint(true)||(!blocked&&active?.engine==='ruffle'&&!draft&&!lastHash&&confirm('This Flash game has not written a save yet. Return anyway?')))location.assign('/arcade/');};
$('export').onclick=()=>{if(!draft?.bytes){status('No local checkpoint available.',true);return;}const url=URL.createObjectURL(new Blob([draft.bytes],{type:'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=active.id+'-checkpoint.bin';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('full').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else $('stage').requestFullscreen().catch(e=>status(e.message,true));};
window.addEventListener('online',()=>void checkpoint());document.addEventListener('visibilitychange',()=>{if(document.hidden)void checkpoint();});window.addEventListener('pagehide',()=>{void checkpoint();});
(async()=>{try{const s=await req('session');if(s.status===401){status('Open Reader site session expired. Reload the page to continue.',true);return;}profile=(await (await expect(s)).json()).profile;$('who').textContent='Cloud saves enabled';const data=await (await expect(await fetch('/arcade/games.json',{cache:'no-store'}))).json();const id=location.pathname.split('/')[2];if(!id||id==='index.html')showLibrary(data.games);else{const g=data.games.find(g=>g.id===id);if(!g?.ready)throw Error(g?.reason||'Game not available');await start(g);}}catch(e){status(e.message,true);}})();
