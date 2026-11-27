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
let dbReady = new WeakMap();
async function ready(db){
 if(!db)throw new Invalid('Import catalog requires the existing Journey D1 binding.',503);
 if(!dbReady.has(db))dbReady.set(db,(async()=>{
  await db.exec("CREATE TABLE IF NOT EXISTS manual_comics_v1 (slug TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, chapters TEXT NOT NULL, updated_at TEXT NOT NULL);");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_local_pages_v1 (slug TEXT NOT NULL, sha TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, repo TEXT NOT NULL, PRIMARY KEY(slug,sha));");
  await db.exec("CREATE TABLE IF NOT EXISTS manual_pages_v1 (slug TEXT NOT NULL, sha TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(slug,sha));");
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
async function pageLocation(db,slug,sha){
 const old=await db.prepare('SELECT sha,width,height,size FROM manual_pages_v1 WHERE slug=? AND sha=?').bind(slug,sha).first();
 if(old)return {...old,repo:'open-reader',path:filePath(slug,sha)};
 const p=await db.prepare('SELECT sha,width,height,size,repo FROM manual_local_pages_v1 WHERE slug=? AND sha=?').bind(slug,sha).first();
 if(!p)return null;
 if(!new RegExp('^'+slug+'-vol-[0-9]{3}$').test(p.repo))throw new Invalid('Invalid imported volume',503);
 return {...p,path:'pages/'+sha+'.png'};
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
 const local=path.match(/^\/api\/manual-comics\/(import-[a-f0-9]{32})\/local-(init|index)$/);
 if(!api&&!image&&!comic&&!lib&&!local)return null;
 try{
  if(!['GET','HEAD'].includes(method)&&req.headers.get('Origin')!==u.origin)throw new Invalid('Same-origin required',403);
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
     await db.prepare("INSERT OR IGNORE INTO manual_comics_v1(slug,title,status,revision,metadata,chapters,updated_at) VALUES (?,?,'draft',0,?,'[]',?)").bind(slug,m.title,JSON.stringify(m),new Date().toISOString()).run();r=await row(db,slug);
    }
    if(!r||r.status==='deleted')throw new Invalid('Deleted or unavailable import',409);
    return json(decode(r));
   }
   if(!r||r.status==='deleted')throw new Invalid('Import not found or deleted',404);
   if(!Number.isInteger(body.revision)||body.revision!==r.revision)throw new Invalid('Import revision changed',409);
   if(!Number.isInteger(body.volume)||body.volume<1||body.volume>999||!SHA.test(body.index||''))throw new Invalid('Invalid volume index');
   const repo=slug+'-vol-'+String(body.volume).padStart(3,'0');
   const file=await deps.githubFile(env,repo,'indexes/'+body.index+'.json');
   if(file.throttled||file.status===429){
    const n=Number(file.retry), date=Date.parse(file.retry||''), reset=Number(file.reset)*1000;
    const seconds=Math.ceil(Math.max(60,Number.isFinite(n)?n:0,Number.isFinite(date)?(date-Date.now())/1000:0,Number.isFinite(reset)?(reset-Date.now())/1000+3:0));
    return new Response(JSON.stringify({error:'GitHub index read rate limited; wait and retry'}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':String(seconds)}});
   }
   if(file.status!==200)throw new Invalid('GitHub index unavailable (HTTP '+file.status+'). Grant the existing reader GitHub App access to this private volume, then resume.',502);
   if(!file.body||file.body.length>128*1024||await deps.shaHex(file.body)!==body.index)throw new Invalid('Index checksum mismatch',502);
   let idx;try{idx=JSON.parse(new TextDecoder().decode(file.body));}catch{throw new Invalid('Invalid volume index');}
   if(idx.slug!==slug||idx.volume!==body.volume||!Array.isArray(idx.pages)||!idx.pages.length||idx.pages.length>100)throw new Invalid('Invalid volume index identity');
   const unique=new Set();
   for(const p of idx.pages){if(!SHA.test(p?.sha||'')||unique.has(p.sha)||![p.width,p.height,p.size].every(Number.isSafeInteger)||p.width<1||p.height<1||p.width>20000||p.height>20000||p.width*p.height>MAX_PIXELS||p.size<45||p.size>MAX_BYTES)throw new Invalid('Invalid indexed page');unique.add(p.sha);}
   const previous=await pages(db,slug);const known=new Set(previous.map(p=>p.sha));
   if(previous.length+idx.pages.filter(p=>!known.has(p.sha)).length>LIMIT*3)throw new Invalid('Too many staged pages',413);
   // 15 rows x 6 parameters, within D1's 100 bound parameter limit. Each
   // statement checks the revision/tombstone again. Replaying is idempotent.
   for(let i=0;i<idx.pages.length;i+=15){const part=idx.pages.slice(i,i+15);const vals=part.flatMap(p=>[slug,p.sha,p.width,p.height,p.size,repo]);
    const selects=part.map(()=> 'SELECT ?,?,?,?,?,?').join(' UNION ALL ');
    await db.prepare('INSERT OR IGNORE INTO manual_local_pages_v1(slug,sha,width,height,size,repo) SELECT * FROM ('+selects+') WHERE EXISTS(SELECT 1 FROM manual_comics_v1 WHERE slug=? AND revision=? AND status!=\'deleted\')').bind(...vals,slug,r.revision).run();
   }
   const current=await row(db,slug);if(!current||current.status==='deleted'||current.revision!==r.revision)throw new Invalid('Import changed during index registration',409);
   return json({ok:true,count:idx.pages.length});
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
   const allowed=new Set(['','index.html','app.js','style.css','settings','settings.html','overview','overview/','overview/index.html']);
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
  if(image||api?.[2]){
   if(method!=='GET')throw new Invalid('Method not allowed',405);
   const sha=(image||api)[2];
   if(image&&(r.status!=='published'||!JSON.parse(r.chapters).some(c=>c.pages.includes(sha))))throw new Invalid('Page is not published',404);
   const p=await pageLocation(db,slug,sha);
   if(!p)throw new Invalid('Page not found',404);
   const f=await deps.githubFile(env,p.repo,p.path);
   if(f.status!==200||f.body.length!==p.size||await deps.shaHex(f.body)!==sha)throw new Invalid('GitHub page missing or checksum mismatch',502);
   return new Response(f.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':'"'+sha+'"'}});
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
  if(method==='GET')return json({...decode(r),pages:await pages(db,slug)});
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
 }catch(e){if(e instanceof Invalid)return json({error:e.message},e.status);console.error('MANUAL_IMPORT_ERROR',String(e?.message||e));return json({error:'Import storage temporarily unavailable. Existing published comics are unchanged.'},503);}
}
