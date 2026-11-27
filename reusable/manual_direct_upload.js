/* Browser-only upload. No PDF or image bytes traverse Open Reader. */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
export const sha256=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
function base64(bytes){const chunks=[];for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));return btoa(chunks.join(''));}
export function waitSeconds(r,n,now=Date.now()){
 const retry=r.headers.get('Retry-After'),reset=r.headers.get('X-RateLimit-Remaining')==='0'?Number(r.headers.get('X-RateLimit-Reset'))*1000:0;
 return Math.ceil(Math.max(Math.min(3600,60*2**Math.min(n,6)),Number(retry)||0,((retry&&!/^\d+$/.test(retry)?Date.parse(retry)||0:0)-now)/1000,(reset-now)/1000+3));
}
export function timedFetch(url,options={},ms=120000){return fetch(url,{...options,signal:AbortSignal.timeout(ms)});}
const transient=e=>e instanceof TypeError||['AbortError','TimeoutError','NetworkError'].includes(e?.name);
export async function limited(request,report,{pause=sleep,clock=()=>Date.now(),stage='GitHub request',retryServer=true}={}){
 let n=0,network=0;
 async function retry(detail){if(++network>4)throw Error(`${stage} did not finish after repeated connection/server failures: ${detail}. Retry Save to resume.`);const ms=Math.min(30000,1000*2**network);report(`${stage} · ${detail} · retrying in ${ms/1000}s (${network}/4)`);await pause(ms);}
 for(;;){let r;try{r=await request();}catch(e){if(!transient(e))throw e;await retry(e.name||'Network error');continue;}
  if(retryServer&&(r.status===408||[500,502,503,504].includes(r.status))){let detail='HTTP '+r.status;try{const data=await r.clone().json();if(typeof data.error==='string')detail+=' — '+data.error.slice(0,500);}catch{}await retry(detail);continue;}
  if(r.status!==429&&r.status!==403)return r;
  const message=await r.clone().text().catch(()=> '');
  if(r.status===403&&r.headers.get('X-RateLimit-Remaining')!=='0'&&!r.headers.get('Retry-After')&&!/secondary rate limit|api rate limit exceeded|abuse detection/i.test(message))return r;
  const seconds=waitSeconds(r,n++,clock()),until=clock()+seconds*1000;network=0;
  while(clock()<until){report(`${stage} · GitHub cooldown · ${Math.ceil((until-clock())/1000)} seconds remaining. Will resume automatically.`);await pause(Math.min(1000,until-clock()));}
 }
}
export class DirectUpload{
 constructor({slug,revision,owner,report=()=>{},pause=sleep,clock=()=>Date.now(),writeInterval=1050,volumeLimit=700*1024*1024,resume=null}){if(!/^import-[a-f0-9]{32}$/.test(slug)||!owner)throw Error('Invalid import storage identity');Object.assign(this,{slug,revision,owner,report,pause,clock,writeInterval,volumeLimit});this.batch=resume?.batch||'ch-'+crypto.randomUUID().replaceAll('-','');this.size=resume?.size||0;this.reuse=new Set(resume?.paths||[]);this.pending=new Map();this.known=new Map();this.token=null;this.volume=resume?.volume??null;this.lastWrite=-Infinity;this.registration=null;}
 async site(path,body){const stage=path==='index'?'Registering verified pages':path==='recover'?'Discovering uploaded indexes':'Preparing private GitHub storage';this.report(stage);const r=await limited(()=>timedFetch(`/api/manual-comics/${this.slug}/local-${path}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:this.owner,revision:this.revision,...body})},60000),this.report,{pause:this.pause,clock:this.clock,stage,retryServer:path!=='browser-token'});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(`${stage}: ${data.error||'HTTP '+r.status}`);return data;}
 async access(){if(this.token&&Date.parse(this.token.expires_at)>this.clock()+120000)return this.token;const t=await this.site('browser-token',{batch:this.batch});if(t.owner!==this.owner||t.repo!==`${this.slug}-vol-${String(t.volume).padStart(3,'0')}`||!Number.isInteger(t.volume)||typeof t.token!=='string'||!Number.isFinite(Date.parse(t.expires_at)))throw Error('Invalid scoped GitHub token');if(this.volume!==null&&this.volume!==t.volume)throw Error('Import volume changed');this.volume=t.volume;this.token=t;return t;}
 async git(method,path,body,raw=false){const stage=method==='PUT'?'Uploading to GitHub':'Verifying GitHub bytes';this.report(stage);const request=async()=>{const t=await this.access();if(method==='PUT'){const delay=this.lastWrite+this.writeInterval-this.clock();if(delay>0)await this.pause(delay);this.lastWrite=this.clock();}return timedFetch(`https://api.github.com/repos/${encodeURIComponent(t.owner)}/${t.repo}/contents/${path}`,{method,cache:'no-store',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+t.token,Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});};return limited(async()=>{let r=await request();if(r.status===401){this.token=null;r=await request();}return r;},this.report,{pause:this.pause,clock:this.clock,stage});}
 async verified(path,bytes,digest){
  // Immutable content address: no preliminary GET for each new image. A retry
  // of a committed PUT returns conflict, then the same readback verifies it.
  const r=await this.git('PUT',path,{message:'Open Reader import '+digest.slice(0,12),content:base64(bytes)});
  if(![200,201,409,422].includes(r.status))throw Error(`GitHub upload HTTP ${r.status}`);
  let last;
  for(let i=0;i<4;i++){
   let existing=await this.git('GET',path,null,true);if(existing.status===404&&i<3){await this.pause(500*2**i);continue;}
   if(!existing.ok)throw Error(`GitHub readback HTTP ${existing.status}`);
   try{let actual=new Uint8Array(await existing.arrayBuffer());if(actual.length!==bytes.length||await sha256(actual)!==digest){if(/application\/json/i.test(existing.headers.get('Content-Type')||'')){let data;try{data=JSON.parse(new TextDecoder().decode(actual));}catch{}if(data?.type==='file'&&data.encoding==='base64'&&typeof data.content==='string'&&data.content.length<18*1024*1024)actual=Uint8Array.from(atob(data.content.replace(/\s/g,'')),c=>c.charCodeAt(0));}if(actual.length!==bytes.length||await sha256(actual)!==digest)throw Error('GitHub image/index integrity mismatch. No publication performed.');}return;}
   catch(e){last=e;if(!transient(e)||i===3)throw e;await this.pause(500*2**i);}
  }throw last||Error('GitHub readback unavailable');
 }
 async register(){if(!this.pending.size)return;const batch=[...this.pending.values()];if(!this.registration){const bytes=new TextEncoder().encode(JSON.stringify({slug:this.slug,volume:this.volume,pages:batch}));const digest=await sha256(bytes);this.registration={bytes,digest,uploaded:false};}const r=this.registration;this.report(`Registering ${batch.length} verified pages`);if(!r.uploaded){await this.verified('indexes/'+r.digest+'.json',r.bytes,r.digest);r.uploaded=true;}await this.site('index',{volume:this.volume,index:r.digest});this.pending.clear();this.registration=null;}
 async close(){if(this.token){const t=this.token;this.token=null;try{await timedFetch('https://api.github.com/installation/token',{method:'DELETE',credentials:'omit',headers:{Authorization:'Bearer '+t.token,Accept:'application/vnd.github+json'}},5000);}catch{/* short-lived token expires; never persist it */}}}
 async add(rendered){const bytes=new Uint8Array(await rendered.blob.arrayBuffer()),sha=await sha256(bytes);if(!bytes.length||bytes.length>12*1024*1024)throw Error('Image exceeds storage ceiling');if(this.known.has(sha))return this.known.get(sha);const format=rendered.format||'png';if(!['png','jpg'].includes(format))throw Error('Invalid page format');if(this.registration)await this.register();const path='pages/'+sha+'.'+format;let reuse=this.reuse.has(sha+'.'+format);if(!reuse&&this.size+bytes.length>this.volumeLimit&&this.size){await this.register();await this.close();this.batch='ch-'+crypto.randomUUID().replaceAll('-','');this.volume=null;this.size=0;this.reuse.clear();}await this.access();if(reuse){const old=await this.git('GET',path,null,true);if(!old.ok)throw Error('Previously uploaded page unavailable (HTTP '+old.status+'). Existing draft retained.');let actual=new Uint8Array(await old.arrayBuffer());if(actual.length!==bytes.length||await sha256(actual)!==sha){let m;try{m=JSON.parse(new TextDecoder().decode(actual));if(m?.type==='file'&&m.encoding==='base64'&&typeof m.content==='string'&&m.content.length<18*1024*1024)actual=Uint8Array.from(atob(m.content.replace(/\s/g,'')),c=>c.charCodeAt(0));}catch{}if(actual.length!==bytes.length||await sha256(actual)!==sha)throw Error('Previously uploaded page integrity mismatch');}}else{await this.verified(path,bytes,sha);this.size+=bytes.length;}const p={sha,width:rendered.width,height:rendered.height,size:bytes.length,format};this.pending.set(sha,p);this.known.set(sha,p);return p;}
}
