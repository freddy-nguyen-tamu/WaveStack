/* Browser-only upload. No PDF or image bytes traverse Open Reader. */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// GitHub files can be much larger, but the authenticated reader buffers packs
// in a 128 MB Worker isolate. Preserve the existing tested 12 MiB ceiling.
export const PACK_MAX_BYTES=12*1024*1024;
// This is a D1 metadata transaction budget, NOT a GitHub image-count limit.
export const INDEX_TARGET_BYTES=32*1024;
const encoder=new TextEncoder();
function indexRecordBytes(p){return encoder.encode(JSON.stringify({...p,pack:'0'.repeat(64),offset:PACK_MAX_BYTES,packSize:PACK_MAX_BYTES,packGit:'0'.repeat(40)})).length+1;}
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
export const sha256=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
async function gitBlobId(bytes){const header=new TextEncoder().encode(`blob ${bytes.length}\0`),raw=new Uint8Array(header.length+bytes.length);raw.set(header);raw.set(bytes,header.length);return hex(await crypto.subtle.digest('SHA-1',raw));}
function base64(bytes){const chunks=[];for(let i=0;i<bytes.length;i+=16384)chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));return btoa(chunks.join(''));}
export function waitSeconds(r,n,now=Date.now()){
 const retry=r.headers.get('Retry-After'),reset=r.headers.get('X-RateLimit-Remaining')==='0'?Number(r.headers.get('X-RateLimit-Reset'))*1000:0;
 return Math.ceil(Math.max(Math.min(3600,60*2**Math.min(n,6)),Number(retry)||0,((retry&&!/^\d+$/.test(retry)?Date.parse(retry)||0:0)-now)/1000,(reset-now)/1000+3));
}
export function timedFetch(url,options={},ms=120000){return fetch(url,{...options,signal:AbortSignal.timeout(ms)});}
export function resourceError(status,message){
 const text=String(message||'');
 return status===413||((status===400||status===422||status===500||status===503)&&/payload too large|request entity too large|(?:batch|request|file|body|index|pack).{0,50}(?:too large|exceeds.{0,20}(?:size|byte)|size limit)|too many (?:subrequests|sql variables|bound parameters)|exceeded (?:cpu|memory|resource) limit|worker resource limit|error\s*1102/i.test(text));
}
export function dailyQuota(message){return /daily (?:row |request |read |write )*(?:limit|quota)|(?:daily|per day).{0,40}(?:rows read|rows written|requests).{0,40}(?:limit|exceed)|D1_ERROR:.*(?:exceeded.*(?:daily|rows read|rows written)|daily.*limit)|(?:error(?: code)?[\s:"]+1027\b)/i.test(String(message||''));}
class BatchTooLarge extends Error{constructor(message){super(message);this.name='BatchTooLarge';}}
const transient=e=>e instanceof TypeError||['AbortError','TimeoutError','NetworkError'].includes(e?.name);
export async function limited(request,report,{pause=sleep,clock=()=>Date.now(),stage='GitHub request',retryServer=true}={}){
 let n=0,network=0;
 async function retry(detail){if(++network>4)throw Error(`${stage} did not finish after repeated connection/server failures: ${detail}. Retry Save to resume.`);const ms=Math.min(30000,1000*2**network);report(`${stage} · ${detail} · retrying in ${ms/1000}s (${network}/4)`);await pause(ms);}
 for(;;){let r;try{r=await request();}catch(e){if(!transient(e))throw e;await retry(e.name||'Network error');continue;}
  const message=(r.status>=400)?await r.clone().text().catch(()=> ''):'';
  if(resourceError(r.status,message))return r;
  const daily=dailyQuota(message);
  const throttled=daily||r.status===429||(r.status===403&&(r.headers.get('X-RateLimit-Remaining')==='0'||r.headers.has('Retry-After')||/secondary rate limit|api rate limit exceeded|abuse detection/i.test(message)));
  if(!throttled){if(retryServer&&(r.status===408||[500,502,503,504].includes(r.status))){let detail='HTTP '+r.status;try{const data=JSON.parse(message);if(typeof data.error==='string')detail+=' — '+data.error.slice(0,500);}catch{}await retry(detail);continue;}return r;}
  const seconds=Math.max(waitSeconds(r,n++,clock()),daily?Math.ceil((86400000-clock()%86400000)/1000)+5:0),until=clock()+seconds*1000;network=0;
  while(clock()<until){report(`${stage} · Provider cooldown · ${Math.ceil((until-clock())/1000)} seconds remaining. Will resume automatically.`);await pause(Math.min(1000,until-clock()));}
 }
}
export class DirectUpload{
 constructor({slug,revision,owner,report=()=>{},pause=sleep,clock=()=>Date.now(),writeInterval=1050,volumeLimit=700*1024*1024,packLimit=PACK_MAX_BYTES,resume=null}){if(!/^import-[a-f0-9]{32}$/.test(slug)||!owner)throw Error('Invalid import storage identity');Object.assign(this,{slug,revision,owner,report,pause,clock,writeInterval,volumeLimit});this.batch=resume?.batch||'ch-'+crypto.randomUUID().replaceAll('-','');this.size=resume?.size||0;this.reuse=new Set(resume?.paths||[]);this.reusePacks=new Set(resume?.packs||[]);this.pending=new Map();this.known=new Map();this.token=null;this.volume=resume?.volume??null;this.lastWrite=-Infinity;this.registration=null;this.pack=[];this.packBytes=0;this.packLimit=Math.max(1,Math.min(PACK_MAX_BYTES,packLimit));this.indexBytes=256;}
 async site(path,body){const stage=path==='index'?'Registering verified pages':path==='recover'?'Discovering uploaded indexes':'Preparing private GitHub storage';this.report(stage);const r=await limited(()=>timedFetch(`/api/manual-comics/${this.slug}/local-${path}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:this.owner,revision:this.revision,...body})},60000),this.report,{pause:this.pause,clock:this.clock,stage,retryServer:path!=='browser-token'});const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{data={};}if(!r.ok){const msg=data.error||(resourceError(r.status,raw)?'Worker resource limit (HTTP '+r.status+')':'HTTP '+r.status);if(path==='index'&&resourceError(r.status,msg)&&!/Too many staged pages|Maximum.*pages/i.test(msg))throw new BatchTooLarge(msg);throw Error(`${stage}: ${msg}`);}return data;}
 async access(){if(this.token&&Date.parse(this.token.expires_at)>this.clock()+120000)return this.token;const t=await this.site('browser-token',{batch:this.batch});if(t.owner!==this.owner||t.repo!==`${this.slug}-vol-${String(t.volume).padStart(3,'0')}`||!Number.isInteger(t.volume)||typeof t.token!=='string'||!Number.isFinite(Date.parse(t.expires_at)))throw Error('Invalid scoped GitHub token');if(this.volume!==null&&this.volume!==t.volume)throw Error('Import volume changed');if(t.branch!==undefined&&(typeof t.branch!=='string'||!t.branch||t.branch.length>255))throw Error('Invalid GitHub default branch');this.volume=t.volume;this.token=t;return t;}
 async git(method,path,body,raw=false){const stage=method==='PUT'?'Uploading to GitHub':'Verifying GitHub bytes';this.report(stage);const request=async()=>{const t=await this.access();if(method==='PUT'){const delay=this.lastWrite+this.writeInterval-this.clock();if(delay>0)await this.pause(delay);this.lastWrite=this.clock();}return timedFetch(`https://api.github.com/repos/${encodeURIComponent(t.owner)}/${t.repo}/contents/${path}${method==='GET'&&t.branch?'?ref='+encodeURIComponent(t.branch):''}`,{method,cache:'no-store',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+t.token,Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({...body,...(t.branch?{branch:t.branch}:{})})}:{})});};return limited(async()=>{let r=await request();if(r.status===401){this.token=null;r=await request();}return r;},this.report,{pause:this.pause,clock:this.clock,stage});}
 async verified(path,bytes,digest){
  // Immutable content address: no preliminary GET for each new image. A retry
  // of a committed PUT returns conflict, then the same readback verifies it.
  const r=await this.git('PUT',path,{message:'Open Reader import '+digest.slice(0,12),content:base64(bytes)});
  if(r.status>=400&&resourceError(r.status,await r.clone().text().catch(()=>'')))throw new BatchTooLarge(`GitHub rejected batch size (HTTP ${r.status})`);
  if(![200,201,409,422].includes(r.status))throw Error(`GitHub upload HTTP ${r.status}`);
  let last;
  for(let i=0;i<4;i++){
   let existing=await this.git('GET',path,null,true);if(existing.status===404&&i<3){await this.pause(500*2**i);continue;}
   if(!existing.ok)throw Error(`GitHub readback HTTP ${existing.status}`);
   try{let actual=new Uint8Array(await existing.arrayBuffer());if(actual.length!==bytes.length||await sha256(actual)!==digest){if(/(?:application\/(?:[\w.+-]+\+)?json|text\/json)/i.test(existing.headers.get('Content-Type')||'')){let data;try{data=JSON.parse(new TextDecoder().decode(actual));}catch{}if(data?.type==='file'&&data.encoding==='base64'&&typeof data.content==='string'&&data.content.length<18*1024*1024)actual=Uint8Array.from(atob(data.content.replace(/\s/g,'')),c=>c.charCodeAt(0));}if(actual.length!==bytes.length||await sha256(actual)!==digest)throw Error('GitHub image/index integrity mismatch. No publication performed.');}return;}
   catch(e){last=e;if(!transient(e)||i===3)throw e;await this.pause(500*2**i);}
  }throw last||Error('GitHub readback unavailable');
 }
 async uploadPack(group){
  const bytes=new Uint8Array(group.reduce((n,x)=>n+x.bytes.length,0));let offset=0;
  for(const item of group){bytes.set(item.bytes,offset);offset+=item.bytes.length;}
  const digest=await sha256(bytes),packGit=await gitBlobId(bytes);this.report(`Uploading ${group.length} pages as one ${(bytes.length/1048576).toFixed(2)} MiB batch`);
  const path='packs/'+digest+'.bin';
  if(this.reusePacks.has(digest)){
   const response=await this.git('GET',path,null,true);if(!response.ok)throw Error('Existing packed batch readback HTTP '+response.status);
   let actual=new Uint8Array(await response.arrayBuffer());if(actual.length!==bytes.length||await sha256(actual)!==digest){let m;try{m=JSON.parse(new TextDecoder().decode(actual));if(m?.type==='file'&&m.encoding==='base64'&&typeof m.content==='string'&&m.content.length<18*1024*1024)actual=Uint8Array.from(atob(m.content.replace(/\s/g,'')),c=>c.charCodeAt(0));}catch{}if(actual.length!==bytes.length||await sha256(actual)!==digest)throw Error('Existing pack integrity mismatch');}
   this.size-=bytes.length;this.reusePacks.delete(digest);
  }else await this.verified(path,bytes,digest);
  offset=0;for(const {p,bytes:part} of group){Object.assign(p,{pack:digest,offset,packSize:bytes.length,packGit});offset+=part.length;}

 }
 async flushPack(){
  while(this.pack.length){
   let group=[],size=0;for(const item of this.pack){if(group.length&&size+item.bytes.length>this.packLimit)break;group.push(item);size+=item.bytes.length;}
   try{await this.uploadPack(group);}catch(e){if(!(e instanceof BatchTooLarge)||group.length===1)throw e;this.packLimit=Math.max(Math.max(...group.map(x=>x.bytes.length)),Math.floor(size/2));this.report(`Provider rejected ${size} byte batch; scaling down to ${this.packLimit} bytes`);continue;}
   this.pack.splice(0,group.length);this.packBytes-=size;
  }
 }
 shouldRegister(){return this.indexBytes>=Math.max(256,(this.indexLimit||INDEX_TARGET_BYTES)-1024);}
 async register(){
  if(!this.pending.size)return;await this.flushPack();
  while(this.pending.size){
   if(!this.registration){
    const batch=[];let size=256;
    // Full packs are atomic index units. Never divide a pack between indexes.
    const units=new Map();for(const p of this.pending.values()){const key=p.pack||p.sha;if(!units.has(key))units.set(key,[]);units.get(key).push(p);}
    for(const unit of units.values()){const n=unit.reduce((a,p)=>a+indexRecordBytes(p),0);if(batch.length&&size+n>(this.indexLimit||INDEX_TARGET_BYTES))break;batch.push(...unit);size+=n;}
    const bytes=encoder.encode(JSON.stringify({slug:this.slug,volume:this.volume,pages:batch}));this.registration={bytes,digest:await sha256(bytes),uploaded:false,batch,units:new Set(batch.map(p=>p.pack||p.sha)).size};
   }
   const r=this.registration;this.report(`Registering ${r.batch.length} verified pages`);
   try{if(!r.uploaded){await this.verified('indexes/'+r.digest+'.json',r.bytes,r.digest);r.uploaded=true;}await this.site('index',{volume:this.volume,index:r.digest});}
   catch(e){if(!(e instanceof BatchTooLarge)||r.units===1)throw e;this.indexLimit=Math.max(256,Math.floor(r.bytes.length/2));this.registration=null;this.report(`Scaling down metadata batch to ${this.indexLimit} bytes`);continue;}
   for(const p of r.batch)this.pending.delete(p.sha);this.registration=null;this.indexBytes=256+[...this.pending.values()].reduce((n,p)=>n+indexRecordBytes(p),0);
  }
 }
 async close(){if(this.token){const t=this.token;this.token=null;try{await timedFetch('https://api.github.com/installation/token',{method:'DELETE',credentials:'omit',headers:{Authorization:'Bearer '+t.token,Accept:'application/vnd.github+json'}},5000);}catch{/* short-lived token expires; never persist it */}}}
 async add(rendered){const bytes=new Uint8Array(await rendered.blob.arrayBuffer()),sha=await sha256(bytes);if(!bytes.length||bytes.length>12*1024*1024)throw Error('Image exceeds storage ceiling');if(this.known.has(sha))return this.known.get(sha);const format=rendered.format||'png';if(!['png','jpg'].includes(format))throw Error('Invalid page format');if(this.registration||this.shouldRegister())await this.register();const path='pages/'+sha+'.'+format;let reuse=this.reuse.has(sha+'.'+format);if(!reuse&&this.size+bytes.length>this.volumeLimit&&this.size){await this.register();await this.close();this.batch='ch-'+crypto.randomUUID().replaceAll('-','');this.volume=null;this.size=0;this.reuse.clear();this.reusePacks.clear();}await this.access();if(reuse){const old=await this.git('GET',path,null,true);if(!old.ok)throw Error('Previously uploaded page unavailable (HTTP '+old.status+'). Existing draft retained.');let actual=new Uint8Array(await old.arrayBuffer());if(actual.length!==bytes.length||await sha256(actual)!==sha){let m;try{m=JSON.parse(new TextDecoder().decode(actual));if(m?.type==='file'&&m.encoding==='base64'&&typeof m.content==='string'&&m.content.length<18*1024*1024)actual=Uint8Array.from(atob(m.content.replace(/\s/g,'')),c=>c.charCodeAt(0));}catch{}if(actual.length!==bytes.length||await sha256(actual)!==sha)throw Error('Previously uploaded page integrity mismatch');}}else if(this.pack.length&&(this.packBytes+bytes.length>this.packLimit)){await this.flushPack();}
 const p={sha,width:rendered.width,height:rendered.height,size:bytes.length,format};
 if(!reuse){this.pack.push({p,bytes});this.packBytes+=bytes.length;this.size+=bytes.length;}
 this.pending.set(sha,p);this.indexBytes+=indexRecordBytes(p);this.known.set(sha,p);return p;}
}
