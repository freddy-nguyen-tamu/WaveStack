/* Imported comics are separate from the static archive registry. All calls enter
 * after the existing site-wide session check. Only this namespace is writable.
 * GitHub is the image store; D1 contains only metadata and publication pointers. */
const SLUG = /^import-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const CID = /^ch-[a-f0-9]{32}$/;
const LIMIT = 2000, MAX_BYTES = 12*1024*1024, MAX_PIXELS = 24_000_000;
const encoder = new TextEncoder();
const json = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
class Invalid extends Error {constructor(message,status=400){super(message);this.status=status;}}
function providerFailure(e){
 const msg=String(e?.message||e);
 if(/daily (?:row |request |read |write )*(?:limit|quota)|(?:daily|per day).{0,40}(?:rows read|rows written|requests).{0,40}(?:limit|exceed)|D1_ERROR:.*(?:exceeded.*(?:daily|rows read|rows written)|daily.*limit)/i.test(msg))return new Response(JSON.stringify({error:'Cloudflare daily quota reached; waiting until midnight UTC'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(Math.ceil((86400000-Date.now()%86400000)/1000)+5)}});
 if(/too many (?:subrequests|sql variables|bound parameters)|exceeded (?:cpu|memory|resource) limit|error\s*1102/i.test(msg))return json({error:'Batch exceeds Worker resource limit; reduce batch size'},413);
 return null;
}
let dbReady = new WeakMap();
async function ready(db){
 if(!db)throw new Invalid('Import catalog requires the existing Journey D1 binding.',503);
 if(!dbReady.has(db))dbReady.set(db,(async()=>{
  await db.exec("CREATE TABLE IF NOT EXISTS manual_comics_v1 (slug TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, chapters TEXT NOT NULL, updated_at TEXT NOT NULL);");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_local_pages_v1 (slug TEXT NOT NULL, sha TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, repo TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'png', PRIMARY KEY(slug,sha));");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_browser_volumes_v1 (slug TEXT NOT NULL, revision INTEGER NOT NULL, batch TEXT NOT NULL, volume INTEGER NOT NULL, marker TEXT NOT NULL, PRIMARY KEY(slug,batch), UNIQUE(slug,volume));");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_pages_v1 (slug TEXT NOT NULL, sha TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(slug,sha));");
  // Existing rows all used PNG. Add a column without rebuilding any tables.
  const columns=async()=>((await db.prepare('PRAGMA table_info(manual_local_pages_v1)').all()).results||[]);
  if(!(await columns()).some(c=>c.name==='format')){try{await db.exec("ALTER TABLE manual_local_pages_v1 ADD COLUMN format TEXT NOT NULL DEFAULT 'png'");}catch(e){if(!(await columns()).some(c=>c.name==='format'))throw e;}}
  await db.exec("CREATE TABLE IF NOT EXISTS manual_pack_pages_v1 (slug TEXT NOT NULL, sha TEXT NOT NULL, pack TEXT NOT NULL, offset INTEGER NOT NULL, pack_size INTEGER NOT NULL, PRIMARY KEY(slug,sha));");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_index_receipts_v1 (slug TEXT NOT NULL, revision INTEGER NOT NULL, volume INTEGER NOT NULL, digest TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(slug,revision,volume,digest));");
 })().catch(e=>{dbReady.delete(db);throw e;}));
 await dbReady.get(db);return db;
}
const text=(value,max,required=false)=>{
 if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))throw new Invalid('Invalid metadata field (maximum '+max+' characters).');
 return value.trim();
};
function metadata(body){return {title:text(body?.title,240,true),author:text(body?.author??'',240),description:text(body?.description??'',4000),language:text(body?.language??'',80),status:text(body?.status??'',80)};}
async function payload(req){
 if(!req.body)throw new Invalid('Missing request body');
 const reader=req.body.getReader(), chunks=[];let total=0;
 try{while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>512*1024){await reader.cancel();throw new Invalid('Metadata too large',413);}chunks.push(r.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let i=0;for(const b of chunks){bytes.set(b,i);i+=b.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Invalid('Invalid JSON');}
}
function pngInfo(b){
 if(!b||b.length<45||b.length>MAX_BYTES||![137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x))throw new Invalid('Upload must be a normalized PNG under 12 MiB.',415);
 const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(v.getUint32(8)!==13||v.getUint32(12)!==0x49484452)throw new Invalid('Invalid PNG header',415);
 const width=v.getUint32(16),height=v.getUint32(20);
 if(!width||!height||width>20000||height>20000||width*height>MAX_PIXELS)throw new Invalid('Image exceeds 24 megapixels or dimension limit',413);
 let pos=8,idat=false,ended=false;
 while(pos+12<=b.length){const n=v.getUint32(pos),kind=v.getUint32(pos+4);if(n>b.length-pos-12)throw new Invalid('Truncated PNG',415);if(kind===0x49444154)idat=true;pos+=n+12;if(kind===0x49454e44){ended=n===0&&pos===b.length;break;}}
 if(!idat||!ended)throw new Invalid('Incomplete PNG',415);
 return {width,height};
}
const filePath=(slug,sha)=>`manual-imports/${slug}/${sha}.png`;
function b64(bytes){const parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(parts.join(''));}
async function row(db,slug){return db.prepare('SELECT * FROM manual_comics_v1 WHERE slug=?').bind(slug).first();}
async function pages(db,slug){
 const old=(await db.prepare('SELECT sha,width,height,size FROM manual_pages_v1 WHERE slug=?').bind(slug).all()).results||[];
 const local=(await db.prepare('SELECT sha,width,height,size FROM manual_local_pages_v1 WHERE slug=?').bind(slug).all()).results||[];
 return [...new Map([...local,...old].map(p=>[p.sha,p])).values()];
}
// The published image hot path is independent of schema initialization. A
// successfully published comic necessarily has these tables. Legacy PNGs and
// browser JPEGs are resolved with the same priority as the original manifest.
async function publishedPage(db,slug,sha){
 await ready(db);
 const p=await db.prepare(`SELECT p.sha,p.width,p.height,p.size,p.repo,p.format,pack.pack,pack.offset,pack.pack_size FROM (
  SELECT sha,width,height,size,'open-reader' AS repo,'png' AS format,0 AS priority FROM manual_pages_v1 WHERE slug=? AND sha=?
  UNION ALL SELECT sha,width,height,size,repo,format,1 AS priority FROM manual_local_pages_v1 WHERE slug=? AND sha=?
 ) p LEFT JOIN manual_pack_pages_v1 pack ON pack.slug=? AND pack.sha=p.sha AND p.priority=1 WHERE EXISTS (SELECT 1 FROM manual_comics_v1 c,json_each(c.chapters) ch,json_each(ch.value,'$.pages') pg WHERE c.slug=? AND c.status='published' AND pg.value=?) ORDER BY p.priority LIMIT 1`).bind(slug,sha,slug,sha,slug,slug,sha).first();
 return locationFor(p,slug,sha);
}
function locationFor(p,slug,sha){
 if(!p)return null;
 if(p.repo==='open-reader')return {...p,path:filePath(slug,sha)};
 if(!new RegExp('^'+slug+'-vol-[0-9]{3}$').test(p.repo))throw new Invalid('Invalid imported volume',503);
 if(!['png','jpg'].includes(p.format))throw new Invalid('Invalid imported page format',503);
 if(p.pack){if(!SHA.test(p.pack)||!Number.isSafeInteger(p.offset)||!Number.isSafeInteger(p.pack_size)||p.offset<0||p.pack_size>MAX_BYTES||p.offset+p.size>p.pack_size)throw new Invalid('Invalid packed image location',503);return {...p,path:'packs/'+p.pack+'.bin'};}
 return {...p,path:'pages/'+sha+'.'+p.format};
}
async function pageLocation(db,slug,sha){
 const old=await db.prepare('SELECT sha,width,height,size FROM manual_pages_v1 WHERE slug=? AND sha=?').bind(slug,sha).first();
 if(old)return locationFor({...old,repo:'open-reader',format:'png'},slug,sha);
 return locationFor(await db.prepare('SELECT p.sha,p.width,p.height,p.size,p.repo,p.format,b.pack,b.offset,b.pack_size FROM manual_local_pages_v1 p LEFT JOIN manual_pack_pages_v1 b ON b.slug=p.slug AND b.sha=p.sha WHERE p.slug=? AND p.sha=?').bind(slug,sha).first(),slug,sha);
}
// Pack bytes never escape this authenticated per-page endpoint. Share concurrent
// fetches and cache verified immutable containers, not unverified upstream data.
const packFlights=new Map();
let recentPack=null;
async function packedFile(req,env,deps,p){
 const key=new Request(new URL('/api/manual-pack-cache/'+p.repo+'/'+p.pack+'?size='+p.pack_size,req.url));
 const cache=deps.ctx?.waitUntil?globalThis.caches?.default:null;
 const identity=key.url+':'+String(env.GITHUB_OWNER)+':'+String(env.GITHUB_APP_INSTALLATION_ID);
 if(recentPack?.identity===identity&&recentPack.until>Date.now())return recentPack.value;
 if(packFlights.has(identity))return packFlights.get(identity);
 const task=(async()=>{
  if(cache){try{const hit=await cache.match(key);if(hit&&hit.headers.get('ETag')==='"'+p.pack+'"'){const body=new Uint8Array(await hit.arrayBuffer());if(body.length===p.pack_size)return {status:200,body};}}catch{}}
  // One scoped inventory for a volume, reused by subsequent containers. This
  // is the same App/default branch that registration checks.
  let f=await deps.githubFile(env,p.repo,p.path);
  if(f.status===404&&deps.importVolumeInventory){const inv=await deps.importVolumeInventory(env,p.repo);if(inv.status!==200)return inv;if(inv.files.get(p.path)!==p.pack_size)return {status:404};f=await deps.githubFile(env,p.repo,p.path,{ref:inv.branch,readToken:inv.readToken});}
  if(f.status!==200)return f;
  if(f.body?.length!==p.pack_size||await deps.shaHex(f.body)!==p.pack)throw new Invalid('GitHub batch checksum mismatch',502);
  if(cache){const stored=new Response(f.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'public,max-age=31536000,immutable','ETag':'"'+p.pack+'"'}});deps.ctx.waitUntil(cache.put(key,stored).catch(()=>{}));}
  return f;
 })();packFlights.set(identity,task);try{const value=await task;if(value.status===200)recentPack={identity,until:Date.now()+60000,value};return value;}finally{if(packFlights.get(identity)===task)packFlights.delete(identity);}
}
async function serveManualPage(req,env,deps,p,sha,cacheable){
 if(!p)throw new Invalid('Page is not published or not indexed',404);
 const format=p.format||'png',mime=format==='jpg'?'image/jpeg':'image/png';
 const headers={'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':'"'+sha+'"'};
 // Cache only verified bytes, after the Worker session gate AND current D1
 // publication membership check. Never cache an error or a draft preview.
 const cache=cacheable&&deps.ctx?.waitUntil?globalThis.caches?.default:null;
 const key=new Request(new URL('/api/manual-image-cache/'+p.repo+'/'+sha+'.'+format+'?size='+p.size,req.url));
 if(cache){try{const hit=await cache.match(key);if(hit&&hit.headers.get('ETag')===headers.ETag&&hit.headers.get('Content-Type')===mime&&hit.headers.get('X-Manual-Verified-Size')===String(p.size))return new Response(req.method==='HEAD'?null:hit.body,{headers});}catch(e){console.warn('MANUAL_IMAGE_CACHE_READ',String(e?.message||e));}}
 let f;
 try{f=p.pack?await packedFile(req,env,deps,p):await deps.githubFile(env,p.repo,p.path);if(p.pack&&f.status===200)f={...f,body:f.body.subarray(p.offset,p.offset+p.size)};}catch(e){console.error('MANUAL_IMAGE_UPSTREAM',p.repo,sha.slice(0,12),String(e?.message||e));throw new Invalid('GitHub image fetch failed; check Worker MANUAL_IMAGE_UPSTREAM logs',502);}
 if(f?.throttled||f?.status===429){const now=Date.now(),n=Number(f.retry),date=Date.parse(f.retry||''),reset=Number(f.reset)*1000;const seconds=Math.ceil(Math.max(60,Number.isFinite(n)?n:0,Number.isFinite(date)?(date-now)/1000:0,Number.isFinite(reset)?(reset-now)/1000+3:0));return new Response(JSON.stringify({error:'GitHub image read rate limited'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(seconds)}});}
 if(f?.status===404&&!p.pack&&p.repo!=='open-reader'&&deps.importVolumeInventory){
  // Only consider volumes already reserved for THIS import. Never search
  // unrelated comics or issue public URLs. Exact filename/size + SHA readback
  // is required before a fallback can be returned to the reader.
  const slug=p.repo.slice(0,-8), db=env.JOURNEY_DB;
  const reserved=(await db.prepare('SELECT volume FROM manual_browser_volumes_v1 WHERE slug=? ORDER BY volume DESC LIMIT 8').bind(slug).all()).results||[];
  const candidates=[...new Set([p.repo,...reserved.map(x=>slug+'-vol-'+String(x.volume).padStart(3,'0'))])].slice(0,9);
  let primary='unknown', recovered=null;
  for(const repo of candidates){
   const inventory=await deps.importVolumeInventory(env,repo);
   if(repo===p.repo)primary=inventory.status===200?'private repository accessible; expected page '+(inventory.files.get(p.path)===p.size?'exists':'missing or wrong size'):(inventory.stage||'GitHub')+' HTTP '+inventory.status;
   if(inventory.throttled||inventory.status===429){f=inventory;break;}
   if(inventory.status!==200)continue;
   // Accept a differently named extension only if the final bytes still
   // match the original digest AND its expected image signature below.
   for(const path of [p.path,'pages/'+sha+'.'+(format==='jpg'?'png':'jpg')]){
    if(inventory.files.get(path)!==p.size)continue;
    const found=await deps.githubFile(env,repo,path,{ref:inventory.branch,readToken:inventory.readToken});
    if(found.throttled||found.status===429){f=found;break;}
    if(found.status===200&&found.body?.length===p.size&&await deps.shaHex(found.body)===sha){recovered=found;break;}
   }
   if(recovered||f.throttled||f.status===429)break;
  }
  if(recovered)f=recovered;
  else if(!f.throttled&&f.status!==429)throw new Invalid('GitHub page unavailable: '+p.repo+'/'+p.path+'; '+primary+'. No matching verified copy in checked volumes of this comic.',502);
 }
 if(f?.throttled||f?.status===429)return new Response(JSON.stringify({error:'GitHub image read rate limited'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(Math.max(60,Number(f.retry)||0,(Number(f.reset)||0)-Math.floor(Date.now()/1000)+3))}});
 if(f?.status!==200){console.error('MANUAL_IMAGE_HTTP',p.repo,sha.slice(0,12),f?.status);throw new Invalid('GitHub image unavailable (upstream HTTP '+(f?.status||'unknown')+'). Check App access to the private import volume.',502);}
 if(!f.body||f.body.length!==p.size||await deps.shaHex(f.body)!==sha){console.error('MANUAL_IMAGE_INTEGRITY',p.repo,sha.slice(0,12),p.size,f.body?.length);throw new Invalid('GitHub page byte count or SHA-256 mismatch',502);}
 if(format==='jpg'&&!(f.body[0]===255&&f.body[1]===216&&f.body[2]===255&&f.body[f.body.length-2]===255&&f.body[f.body.length-1]===217))throw new Invalid('Invalid JPEG page',502);
 if(format==='png'&&![137,80,78,71,13,10,26,10].every((v,i)=>f.body[i]===v))throw new Invalid('Invalid PNG page',502);
 if(cache){const immutable=new Response(f.body,{headers:{...headers,'Cache-Control':'public,max-age=31536000,immutable','X-Manual-Verified-Size':String(p.size)}});deps.ctx.waitUntil(cache.put(key,immutable).catch(e=>console.warn('MANUAL_IMAGE_CACHE_WRITE',String(e?.message||e))));}
 return new Response(req.method==='HEAD'?null:f.body,{headers});
}
const decode=r=>({slug:r.slug,revision:r.revision,publication:r.status,metadata:JSON.parse(r.metadata),chapters:JSON.parse(r.chapters)});
function validateChapters(chapters,verified){
 if(!Array.isArray(chapters)||!chapters.length||chapters.length>LIMIT)throw new Invalid('At least one nonempty chapter is required.');
 const ids=new Set();let count=0;
 return chapters.map((c,i)=>{
  if(!CID.test(c?.id)||ids.has(c.id))throw new Invalid('Invalid or duplicate chapter ID');ids.add(c.id);
  if(!Array.isArray(c.pages)||!c.pages.length)throw new Invalid('Chapter '+(i+1)+' has no pages');
  count+=c.pages.length;if(count>LIMIT)throw new Invalid('Maximum 2,000 pages per imported comic',413);
  if(c.pages.some(x=>typeof x!=='string'||!SHA.test(x)||!verified.has(x)))throw new Invalid('Chapter references an unverified or foreign page');
  return {id:c.id,number:text(c.number??String(i+1),80,true),title:text(c.title??`Chapter ${i+1}`,320,true),pages:c.pages};
 });
}
function manifest(r,all){const x=decode(r),map=new Map(all.map(p=>[p.sha,p]));return {title:x.metadata.title,metadata:x.metadata,manual_import:true,chapters:x.chapters.map(c=>({id:c.id,number:c.number,title:c.title,label:c.title,images:c.pages.map(sha=>{
 const p=map.get(sha);if(!p)throw new Invalid('Published page metadata missing',503);
 return {url:`/api/manual-image/${r.slug}/${sha}`,width:p.width,height:p.height,sha256:sha};
 })}))};}
export function isManualSlug(slug){return SLUG.test(slug||'');}
export async function manualChapterPublished(env,slug,chapter){
 if(!isManualSlug(slug)||!env.JOURNEY_DB)return false;
 try{const db=await ready(env.JOURNEY_DB),r=await row(db,slug);return r?.status==='published'&&JSON.parse(r.chapters).some(c=>c.id===chapter&&c.pages.length>0);}catch{return false;}
}
export async function manualRoute(req,env,deps){
 const u=new URL(req.url), path=u.pathname, method=req.method;
 const api=path.match(/^\/api\/manual-comics(?:\/(import-[a-f0-9]{32})(?:\/pages(?:\/([a-f0-9]{64}))?)?)?$/);
 const image=path.match(/^\/api\/manual-image\/(import-[a-f0-9]{32})\/([a-f0-9]{64})$/);
 const comic=path.match(/^\/comics\/(import-[a-f0-9]{32})\/(.*)$/);
 const lib=path==='/api/manual-library';
 const local=path.match(/^\/api\/manual-comics\/(import-[a-f0-9]{32})\/local-(init|index|browser-token|recover)$/);
 if(!api&&!image&&!comic&&!lib&&!local)return null;
 try{
  if(!['GET','HEAD'].includes(method)&&req.headers.get('Origin')!==u.origin)throw new Invalid('Same-origin required',403);
  if(image){
   if(!['GET','HEAD'].includes(method))throw new Invalid('Method not allowed',405);
   if(!env.JOURNEY_DB)throw new Invalid('Import catalog unavailable',503);
   if(!deps.githubConfigured(env))throw new Invalid('GitHub streaming not configured',503);
   const p=await publishedPage(env.JOURNEY_DB,image[1],image[2]);
   return await serveManualPage(req,env,deps,p,image[2],true);
  }
  const db=await ready(env.JOURNEY_DB);
  if(lib||api&&!api[1]&&method==='GET'){
   if(method!=='GET')throw new Invalid('Method not allowed',405);
   const result=await db.prepare(lib?"SELECT slug,title,status,revision,json_array_length(chapters) AS chapter_count FROM manual_comics_v1 WHERE status='published' ORDER BY title,slug":"SELECT slug,title,status,revision,json_array_length(chapters) AS chapter_count FROM manual_comics_v1 WHERE status!='deleted' ORDER BY updated_at DESC").all();
   const comics=(result.results||[]).map(r=>{return {slug:r.slug,title:r.title,chapters:r.chapter_count,publication:r.status,revision:r.revision,route:`/comics/${r.slug}/overview/`};});
   return json({comics,ready:!!deps.githubConfigured(env),...(lib?{}:{local_upload:true,owner:env.GITHUB_OWNER||null})});
  }
  if(api&&!api[1]&&method==='POST'){
   if(!deps.githubConfigured(env))throw new Invalid('Existing GitHub streaming credentials are not configured',503);
   const m=metadata(await payload(req));let slug='import-'+crypto.randomUUID().replaceAll('-','');
   const existing=await env.ASSETS.fetch(new Request(new URL(`/comics/${slug}/manifest.json`,u)));
   if(existing.ok)throw new Invalid('Slug collision; retry creation',409);
   await db.prepare("INSERT INTO manual_comics_v1(slug,title,status,revision,metadata,chapters,updated_at) VALUES (?,?,'draft',0,?,'[]',?)").bind(slug,m.title,JSON.stringify(m),new Date().toISOString()).run();
   return json({slug,revision:0,publication:'draft',metadata:m,chapters:[],pages:[]},201);
  }
  // The authenticated local uploader commits and independently reads back every
  // image. The Worker reads only content-addressed index JSON, never upload bytes.
  if(local){
   if(method!=='POST')throw new Invalid('Method not allowed',405);
   if(!deps.githubConfigured(env))throw new Invalid('GitHub streaming not configured',503);
   const slug=local[1],body=await payload(req);
   if(body.owner!==env.GITHUB_OWNER)throw new Invalid('Uploader GitHub owner does not match reader installation',409);
   let r=await row(db,slug);
   if(local[2]==='init'){
    const m=metadata(body.metadata);
    if(!r){
     const existing=await env.ASSETS.fetch(new Request(new URL(`/comics/${slug}/manifest.json`,u)));
     if(existing.ok)throw new Invalid('Slug collision',409);
     // Browser re-selection must not silently create another draft for the same title.
     // Local companion keeps its existing contract. The guard is atomic in D1.
     if(body.browser===true){
      await db.prepare("INSERT OR IGNORE INTO manual_comics_v1(slug,title,status,revision,metadata,chapters,updated_at) SELECT ?,?,'draft',0,?,'[]',? WHERE NOT EXISTS(SELECT 1 FROM manual_comics_v1 WHERE status='draft' AND title=? COLLATE NOCASE)").bind(slug,m.title,JSON.stringify(m),new Date().toISOString(),m.title).run();
      r=await row(db,slug);
      if(!r){const prior=await db.prepare("SELECT slug FROM manual_comics_v1 WHERE status='draft' AND title=? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1").bind(m.title).first();if(prior)return json({error:'An unpublished draft with this title already exists. Open it in Manage imported comics and recover its uploaded pages, or choose a different title for a distinct comic.',draft:prior.slug},409);throw new Invalid('Draft creation did not complete',409);}
     }else{await db.prepare("INSERT OR IGNORE INTO manual_comics_v1(slug,title,status,revision,metadata,chapters,updated_at) VALUES (?,?,'draft',0,?,'[]',?)").bind(slug,m.title,JSON.stringify(m),new Date().toISOString()).run();r=await row(db,slug);}
    }
    if(!r||r.status==='deleted')throw new Invalid('Deleted or unavailable import',409);
    return json(decode(r));
   }
   if(!r||r.status==='deleted')throw new Invalid('Import not found or deleted',404);
   if(!Number.isInteger(body.revision)||body.revision!==r.revision)throw new Invalid('Import revision changed',409);
   if(local[2]==='browser-token'){
    if(!deps.browserImportToken)throw new Invalid('Browser storage is unavailable',503);
    if(typeof body.batch!=='string'||!CID.test(body.batch))throw new Invalid('Invalid upload batch');
    let reserved=await db.prepare('SELECT * FROM manual_browser_volumes_v1 WHERE slug=? AND batch=?').bind(slug,body.batch).first();
    if(!reserved){
     // Reserve from the high end so older local imports can keep their low-numbered volumes.
     const existing=(await db.prepare('SELECT volume FROM manual_browser_volumes_v1 WHERE slug=?').bind(slug).all()).results||[];
     const indexed=(await db.prepare('SELECT DISTINCT repo FROM manual_local_pages_v1 WHERE slug=?').bind(slug).all()).results||[];
     const used=new Set([...existing.map(x=>x.volume),...indexed.map(x=>Number(x.repo.slice(-3)))]);
     let volume=999;while(volume>0&&used.has(volume))volume--;
     if(!volume)throw new Invalid('No unused import volumes remain',409);
     await db.prepare('INSERT OR IGNORE INTO manual_browser_volumes_v1(slug,revision,batch,volume,marker) VALUES (?,?,?,?,?)').bind(slug,r.revision,body.batch,volume,'open-reader-browser:'+crypto.randomUUID()).run();
     reserved=await db.prepare('SELECT * FROM manual_browser_volumes_v1 WHERE slug=? AND batch=?').bind(slug,body.batch).first();
    }
    if(!reserved||reserved.revision!==r.revision)throw new Invalid('Import volume reservation changed; reopen import',409);
    const repo=slug+'-vol-'+String(reserved.volume).padStart(3,'0');
    try{return json({...await deps.browserImportToken(env,repo,reserved.marker),volume:reserved.volume});}
    catch(e){const f=e.githubFailure;if(f?.throttled)return new Response(JSON.stringify({error:'GitHub rate limited; waiting'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(Math.max(60,Number(f.retry)||0,(Number(f.reset)||0)-Math.floor(Date.now()/1000)+3))}});
     console.error('BROWSER_IMPORT_PROVISION',String(e.message));throw new Invalid('Cannot provision private import volume. Site owner: approve GitHub App Repository creation (write) and Contents (write), with access to new repositories. '+String(e.message),503);}
   }
   if(local[2]==='recover'){
    if(r.status!=='draft')throw new Invalid('Only unpublished drafts can be recovered',409);
    if(!Number.isInteger(body.volume)||body.volume<1||body.volume>999)throw new Invalid('Invalid recovery volume');
    const reserved=await db.prepare('SELECT volume FROM manual_browser_volumes_v1 WHERE slug=? AND revision=? AND volume=?').bind(slug,r.revision,body.volume).first();
    if(!reserved)throw new Invalid('No reserved browser volume for this draft',404);
    const repo=slug+'-vol-'+String(body.volume).padStart(3,'0');
    const listing=await deps.gh(env,'GET',repo,'indexes');
    if(listing.status===404){
     // The last batch may have stopped before writing its index. Inventory only
     // content-addressed page names and sizes; no binary bytes enter the Worker.
     const pageList=await deps.gh(env,'GET',repo,'pages');
     if(pageList.status===404){
      const inv=deps.importVolumeInventory?await deps.importVolumeInventory(env,repo):null;
      if(inv?.status===200){const packs=[...inv.files].filter(([path,size])=>/^packs\/[a-f0-9]{64}\.bin$/.test(path)&&size>0&&size<=MAX_BYTES);return json({indexes:[],paths:[],packs:packs.map(([path])=>path.slice(6,-4)),size:packs.reduce((n,[,size])=>n+size,0)});}
      return json({indexes:[],missing:true,paths:[],size:0});
     }
     if(!pageList.ok)throw new Invalid('GitHub page inventory HTTP '+pageList.status,pageList.status===403?403:502);
     const entries=await pageList.json();if(!Array.isArray(entries)||entries.length>=1000)throw new Invalid('Page inventory truncated; keep the original files and contact the site administrator',409);
     const valid=entries.filter(x=>x.type==='file'&&/^[a-f0-9]{64}\.(png|jpg)$/.test(x.name)&&Number.isSafeInteger(x.size)&&x.size>0&&x.size<=MAX_BYTES);
     return json({indexes:[],paths:valid.map(x=>x.name),size:valid.reduce((n,x)=>n+x.size,0)});
    }
    if(!listing.ok){const message=await listing.text();if(listing.status===429||listing.status===403&&(listing.headers.get('X-RateLimit-Remaining')==='0'||listing.headers.has('Retry-After')||/rate limit/i.test(message)))return new Response(JSON.stringify({error:'GitHub recovery rate limited'}),{status:429,headers:{'Content-Type':'application/json','Retry-After':listing.headers.get('Retry-After')||'60'}});throw new Invalid('GitHub recovery listing HTTP '+listing.status,listing.status===403?403:502);}
    const entries=await listing.json();if(!Array.isArray(entries)||entries.length>=1000)throw new Invalid('Invalid or truncated GitHub index directory',409);
    return json({indexes:entries.filter(x=>x.type==='file'&&/^[a-f0-9]{64}\.json$/.test(x.name)).map(x=>x.name.slice(0,-5)).sort()});
   }
   if(!Number.isInteger(body.volume)||body.volume<1||body.volume>999||!SHA.test(body.index||''))throw new Invalid('Invalid volume index');
   const repo=slug+'-vol-'+String(body.volume).padStart(3,'0');
   const receipt=await db.prepare('SELECT count FROM manual_index_receipts_v1 WHERE slug=? AND revision=? AND volume=? AND digest=?').bind(slug,r.revision,body.volume,body.index).first();
   if(receipt&&!body.recover)return json({ok:true,count:receipt.count});
   let inventory=null;const indexPath='indexes/'+body.index+'.json';
   let file=await deps.githubFile(env,repo,indexPath);
   if(file.status===404&&deps.importVolumeInventory){inventory=await deps.importVolumeInventory(env,repo,{fresh:true});if(inventory.status===200)file=await deps.githubFile(env,repo,indexPath,{ref:inventory.branch,readToken:inventory.readToken});else if(inventory.throttled)file=inventory;}
   if(file.throttled||file.status===429){
    const n=Number(file.retry), date=Date.parse(file.retry||''), reset=Number(file.reset)*1000;
    const seconds=Math.ceil(Math.max(60,Number.isFinite(n)?n:0,Number.isFinite(date)?(date-Date.now())/1000:0,Number.isFinite(reset)?(reset-Date.now())/1000+3:0));
    return new Response(JSON.stringify({error:'GitHub index read rate limited; wait and retry'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(seconds)}});
   }
   if(file.status!==200)throw new Invalid('GitHub index unavailable (HTTP '+file.status+'). Check reader App access to this private volume and retry the existing draft.',[401,403,404].includes(file.status)?409:502);
   if(!file.body||file.body.length>128*1024||await deps.shaHex(file.body)!==body.index)throw new Invalid('Index checksum mismatch',502);
   let idx;try{idx=JSON.parse(new TextDecoder().decode(file.body));}catch{throw new Invalid('Invalid volume index');}
   if(idx.slug!==slug||idx.volume!==body.volume||!Array.isArray(idx.pages)||!idx.pages.length||idx.pages.length>LIMIT)throw new Invalid('Invalid volume index identity');
   const unique=new Set();
   for(const p of idx.pages){if(!SHA.test(p?.sha||'')||unique.has(p.sha)||![p.width,p.height,p.size].every(Number.isSafeInteger)||p.width<1||p.height<1||p.width>20000||p.height>20000||p.width*p.height>MAX_PIXELS||p.size<45||p.size>MAX_BYTES||!['png','jpg'].includes(p.format??'png'))throw new Invalid('Invalid indexed page');unique.add(p.sha);}
   const packed=new Map();
   for(const p of idx.pages){
    if(p.pack===undefined&&p.offset===undefined&&p.packSize===undefined&&p.packGit===undefined)continue;
    if(!SHA.test(p.pack||'')||!/^[a-f0-9]{40}$/.test(p.packGit||'')||!Number.isSafeInteger(p.offset)||!Number.isSafeInteger(p.packSize)||p.offset<0||p.packSize<45||p.packSize>MAX_BYTES||p.offset+p.size>p.packSize)throw new Invalid('Invalid packed page metadata');
    const list=packed.get(p.pack)||[];list.push(p);packed.set(p.pack,list);
   }
   for(const list of packed.values()){let offset=0;const size=list[0].packSize;for(const p of [...list].sort((a,b)=>a.offset-b.offset)){if(p.offset!==offset||p.packSize!==size||p.packGit!==list[0].packGit)throw new Invalid('Incomplete or overlapping pack index');offset+=p.size;}if(offset!==size)throw new Invalid('Incomplete pack index');}
   // An index is not proof that its referenced pages exist. Verify the exact
   // repository/default-branch tree (one inventory per batch, no image relay).
   if(!deps.importVolumeInventory)throw new Invalid('Import storage verification is unavailable',503);
   inventory=inventory||await deps.importVolumeInventory(env,repo,{fresh:true});
   if(inventory.throttled||inventory.status===429)return new Response(JSON.stringify({error:'GitHub page inventory rate limited'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(Math.max(60,Number(inventory.retry)||0,(Number(inventory.reset)||0)-Math.floor(Date.now()/1000)+3))}});
   if(inventory.status!==200)throw new Invalid('Cannot verify private volume '+repo+' ('+(inventory.stage||'inventory')+' HTTP '+inventory.status+'). Existing draft retained.',409);
   const missing=idx.pages.filter(p=>inventory.files.get(p.pack?'packs/'+p.pack+'.bin':'pages/'+p.sha+'.'+(p.format??'png'))!==(p.pack?p.packSize:p.size));
   for(const [digest,group] of packed){if(inventory.blobs?.get('packs/'+digest+'.bin')!==group[0].packGit)throw new Invalid('Packed Git object verification failed for '+digest+'; existing draft retained.',409);}
   if(missing.length)throw new Invalid('Volume '+repo+' is missing '+missing.length+' indexed page file(s), or their sizes differ. Existing draft retained; no publication. First: '+missing[0].sha,409);
   // New encodings are only enabled in the explicitly reserved browser volume.
   if(idx.pages.some(p=>p.format==='jpg'||p.pack)&&!await db.prepare('SELECT volume FROM manual_browser_volumes_v1 WHERE slug=? AND revision=? AND volume=?').bind(slug,r.revision,body.volume).first())throw new Invalid('JPEG index requires a reserved browser volume',409);
   // Use a single JSON parameter rather than a generated UNION of dozens of
   // SELECTs. SQLite/D1 JSON functions are already used by the catalog.
   const compact=JSON.stringify(idx.pages.map(p=>({...p,format:p.format??'png'})));
   const total=await db.prepare("SELECT COUNT(*) AS n FROM (SELECT sha FROM manual_pages_v1 WHERE slug=? UNION SELECT sha FROM manual_local_pages_v1 WHERE slug=? UNION SELECT json_extract(value,'$.sha') FROM json_each(?))").bind(slug,slug,compact).first();
   if(Number(total.n)>LIMIT*3)throw new Invalid('Too many staged pages',413);
   if(!receipt){
    const insert=db.prepare("INSERT OR IGNORE INTO manual_local_pages_v1(slug,sha,width,height,size,repo,format) SELECT ?,json_extract(value,'$.sha'),json_extract(value,'$.width'),json_extract(value,'$.height'),json_extract(value,'$.size'),?,json_extract(value,'$.format') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM manual_comics_v1 WHERE slug=? AND revision=? AND status!='deleted')").bind(slug,repo,compact,slug,r.revision);
    const mark=db.prepare("INSERT OR IGNORE INTO manual_index_receipts_v1(slug,revision,volume,digest,count) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM manual_comics_v1 WHERE slug=? AND revision=? AND status!='deleted')").bind(slug,r.revision,body.volume,body.index,idx.pages.length,slug,r.revision);
    const packInsert=db.prepare("INSERT OR IGNORE INTO manual_pack_pages_v1(slug,sha,pack,offset,pack_size) SELECT ?,json_extract(value,'$.sha'),json_extract(value,'$.pack'),json_extract(value,'$.offset'),json_extract(value,'$.packSize') FROM json_each(?) WHERE json_type(value,'$.pack')='text' AND NOT EXISTS(SELECT 1 FROM manual_local_pages_v1 p WHERE p.slug=? AND p.sha=json_extract(value,'$.sha')) AND EXISTS(SELECT 1 FROM manual_comics_v1 WHERE slug=? AND revision=? AND status!='deleted')").bind(slug,compact,slug,slug,r.revision);
    try{const results=await db.batch([packInsert,insert,mark]);if(results?.some(x=>x.success===false))throw Error('D1 returned an unsuccessful batch');}catch(e){const limited=providerFailure(e);if(limited)return limited;console.error('MANUAL_INDEX_D1',String(e?.message||e));throw new Invalid('D1 page-index transaction failed. Uploaded files are retained. Check Worker logs for MANUAL_INDEX_D1.',503);}
   }
   const current=await row(db,slug);if(!current||current.status==='deleted'||current.revision!==r.revision)throw new Invalid('Import changed during index registration',409);
   return json({ok:true,count:idx.pages.length,...(body.recover?{pages:idx.pages}: {})});
  }
  const slug=(api||image||comic)?.[1];
  if(!slug)throw new Invalid('Method not allowed',405);
  const r=await row(db,slug);
  if(!r){if(comic)return null;throw new Invalid('Import not found',404);}
  if(r.status==='deleted')throw new Invalid('Import was deleted',404);
  if(comic){
   if(r.status!=='published')throw new Invalid('Comic is not published',404);
   if(!['GET','HEAD'].includes(method))throw new Invalid('Method not allowed',405);
   const tail=comic[2];
   if(tail==='manifest.json')return json(manifest(r,await pages(db,slug)));
   // Reuse the unmodified, staged chapter-reader and overview assets. Never
   // fetch arbitrary paths or another comic's manifest. URL stays canonical.
   const allowed=new Set(['','index.html','app.js','style.css','settings','settings.html','overview','overview/','overview/index.html','favicon.ico','favicon-16.png','favicon-32.png','favicon-48.png','favicon-180.png','favicon-192.png','favicon-512.png','reader-issues.css','reader-issues.js','source-issue-bell.css','source-issue-bell.js']);
   if(!allowed.has(tail))throw new Invalid('Unknown imported comic route',404);
   if(tail==='overview')return new Response(null,{status:302,headers:{Location:`/comics/${slug}/overview/`,'Cache-Control':'private, no-store'}});
   const mapped=tail;
   const response=await env.ASSETS.fetch(new Request(new URL('/manual-reader-template/'+mapped,u),{method}));
   // Cloudflare standalone HTML redirects refer to the template, not the
   // imported route. Resolve only a same-origin known canonical redirect.
   if([301,302,307,308].includes(response.status)){
    const to=new URL(response.headers.get('Location')||'',u.origin);
    if(to.origin===u.origin&&to.pathname.startsWith('/manual-reader-template/')){
      const suffix=to.pathname.slice('/manual-reader-template/'.length);
      if(allowed.has(suffix))return new Response(null,{status:response.status,headers:{Location:`/comics/${slug}/${suffix}`,'Cache-Control':'private, no-store'}});
    }
    throw new Invalid('Unexpected reader template redirect',502);
   }
   return response;
  }
  const pageRoute=api&&path.endsWith('/pages');
  if(api?.[2]){
   if(method!=='GET')throw new Invalid('Method not allowed',405);
   const p=await pageLocation(db,slug,api[2]);
   return await serveManualPage(req,env,deps,p,api[2],false);
  }
  if(pageRoute&&method==='POST'){
   if(!deps.githubConfigured(env))throw new Invalid('GitHub streaming not configured',503);
   const bytes=await deps.boundedBody(req),{width,height}=pngInfo(bytes),sha=await deps.shaHex(bytes);
   const p=await db.prepare('SELECT sha,width,height,size FROM manual_pages_v1 WHERE slug=? AND sha=?').bind(slug,sha).first();
   if(p)return json(p); // already verified, idempotent resume
   const count=await db.prepare('SELECT COUNT(*) AS n FROM manual_pages_v1 WHERE slug=?').bind(slug).first();
   // Allow replacement pages while editing; the active manifest remains capped.
   if(Number(count.n)>=LIMIT*3)throw new Invalid('Import has too many staged pages',413);
   const dest=filePath(slug,sha);
   const sent=await deps.gh(env,'PUT','open-reader',dest,{data:{message:`Add imported page ${slug} ${sha.slice(0,12)}`,content:b64(bytes)}});
   if(![201,409,422].includes(sent.status))throw new Invalid('GitHub upload failed: HTTP '+sent.status,502);
   // Independently verify remote bytes before indexing the upload. An interrupted
   // PUT is recovered by the same content address, not by overwriting a file.
   const check=await deps.githubFile(env,'open-reader',dest);
   if(check.status!==200||check.body.length!==bytes.length||await deps.shaHex(check.body)!==sha)throw new Invalid('GitHub readback failed; retry same page',502);
   const saved=await db.prepare("INSERT OR IGNORE INTO manual_pages_v1(slug,sha,width,height,size) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM manual_comics_v1 WHERE slug=? AND status!='deleted')").bind(slug,sha,width,height,bytes.length,slug).run();
   const stored=await db.prepare('SELECT sha,width,height,size FROM manual_pages_v1 WHERE slug=? AND sha=?').bind(slug,sha).first();
   if(!stored)throw new Invalid('Import was deleted while uploading',409);
   return json(stored,201);
  }
  if(pageRoute)throw new Invalid('Method not allowed',405);
  if(method==='GET'){const volumes=r.status==='draft'?(await db.prepare('SELECT volume,batch FROM manual_browser_volumes_v1 WHERE slug=? AND revision=? ORDER BY volume DESC').bind(slug,r.revision).all()).results||[]:[];return json({...decode(r),pages:await pages(db,slug),volumes});}
  if(method==='PUT'||method==='DELETE'){
   const body=await payload(req);
   if(!Number.isInteger(body.revision)||body.revision!==r.revision)throw new Invalid('Comic changed in another tab. Reopen it before saving.',409);
   if(method==='DELETE'){
    if(body.confirm!==r.title)throw new Invalid('Title confirmation does not match');
    const result=await db.prepare("UPDATE manual_comics_v1 SET status='deleted',revision=revision+1,updated_at=? WHERE slug=? AND revision=? AND status!='deleted'").bind(new Date().toISOString(),slug,r.revision).run();
    if(result.meta?.changes!==1)throw new Invalid('Comic changed; reopen before deleting',409);
    return json({ok:true,deleted:true});
   }
   const m=metadata(body.metadata),verified=new Set((await pages(db,slug)).map(x=>x.sha)),chapters=validateChapters(body.chapters,verified);
   const encoded=JSON.stringify(chapters);if(encoder.encode(encoded).length>512*1024)throw new Invalid('Manifest too large',413);
   const result=await db.prepare("UPDATE manual_comics_v1 SET title=?,metadata=?,chapters=?,status='published',revision=revision+1,updated_at=? WHERE slug=? AND revision=? AND status!='deleted'").bind(m.title,JSON.stringify(m),encoded,new Date().toISOString(),slug,r.revision).run();
   if(result.meta?.changes!==1)throw new Invalid('Comic changed; reopen before saving',409);
   return json({ok:true,slug,revision:r.revision+1,route:`/comics/${slug}/overview/`});
  }
  throw new Invalid('Method not allowed',405);
 }catch(e){const limited=providerFailure(e);if(limited)return limited;if(e instanceof Invalid)return json({error:e.message},e.status);console.error('MANUAL_IMPORT_ERROR',String(e?.message||e));return json({error:'Import storage temporarily unavailable. Existing published comics are unchanged.'},503);}
}
