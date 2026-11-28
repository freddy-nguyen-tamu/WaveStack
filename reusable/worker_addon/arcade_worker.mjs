// All requests reach this module only after the existing Open Reader site gate.
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const hash=async x=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',x)));
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff',...headers}});
const fail=(msg,status)=>json({error:msg},status);
const MAX=16*1024*1024, WIRE_MAX=4*Math.ceil(MAX/3)+5, CHUNK=1000000, KEY=/^[a-f0-9]{64}$/;
// Stable non-secret save namespace shared by every authenticated site session.
const SHARED_ID='a323db4c994cfafe10bac867f06304f665d465e6050fcb5abe1d0e55d5b0495c';
async function body(req,max){if(Number(req.headers.get('Content-Length')||0)>max||!req.body)throw Error('Invalid body size');let n=0,parts=[];const reader=req.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw Error('Body too large');}parts.push(value);}}finally{reader.releaseLock();}const out=new Uint8Array(n);let p=0;for(const b of parts){out.set(b,p);p+=b.length;}return out;}
async function catalog(req,env){const r=await env.ASSETS.fetch(new Request(new URL('/arcade/games.json',req.url)));if(!r.ok)throw Error('Arcade catalog unavailable');return await r.json();}
// Called only after the outer Worker authenticates the site session.
// Serve Cloudflare's own immutable static asset stream; never buffer or hash
// megabytes in the Free Worker. The installer and browser verify SHA-256.
async function cloudDisc(req,env,path){
 if(!['GET','HEAD'].includes(req.method))return fail('Method not allowed',405);
 if(!/^\/arcade-disc\/[a-f0-9]{64}\/disc-\d{4}\.part$/.test(path))return fail('Unknown disc part',404);
 try{
  const asset=await env.ASSETS.fetch(new Request(new URL(path,req.url),{method:req.method}));
  if(asset.status!==200)return fail('Cloudflare disc asset unavailable (HTTP '+asset.status+'); redeploy Arcade v5',asset.status===404?404:503);
  const headers=new Headers(asset.headers);headers.set('Content-Type','application/octet-stream');headers.set('Cache-Control','private,no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('X-Arcade-Storage','cloudflare-static-assets');
  return new Response(req.method==='HEAD'?null:asset.body,{status:200,headers});
 }catch(e){console.error('ARCADE_STATIC_DISC',e?.name);return fail('Cloudflare disc asset temporarily unavailable',503);}
}
export async function arcadeRoute(req,env,{githubFile}){
 const path=new URL(req.url).pathname;
 if(path.startsWith('/arcade-disc/'))return cloudDisc(req,env,path);
 if(!path.startsWith('/api/arcade/'))return null;
 try{
 if(!env.ARCADE_DB)return fail('Arcade cloud storage not configured',503);
 if(!['GET','HEAD'].includes(req.method)&&req.headers.get('Origin')!==new URL(req.url).origin)return fail('Same-origin required',403);
 // The outer Worker already enforces validSession. No secondary account, password, or cookie.
 const id=SHARED_ID;
 if(path==='/api/arcade/session'&&req.method==='GET')return json({profile:id});
 
 const m=path.match(/^\/api\/arcade\/(rom|save)\/([a-z0-9-]{1,60})(?:\/([a-f0-9]{64}))?(?:\/([A-Za-z0-9_.-]+))?$/);if(!m)return fail('Unknown arcade endpoint',404);
 const [,action,slug,version,filename]=m,game=(await catalog(req,env)).games.find(g=>g.id===slug&&g.version===version&&g.ready);
 if(!game)return fail('Game/version unavailable',404);
 if(action==='rom'&&['GET','HEAD'].includes(req.method)){
  const f=game.files.find(f=>f.name===filename);if(!f||!KEY.test(f.sha)||!Number.isSafeInteger(f.size)||f.size<=0||f.size>32*1024*1024)return fail('Unknown game asset',404);
  if(game.engine==='psx'&&game.disc?.parts?.includes(f.name))return cloudDisc(req,env,`/arcade-disc/${f.sha}/${f.name}`);
  const headers={'Content-Type':'application/octet-stream','Content-Length':String(f.size),'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'};
  if(req.method==='HEAD')return new Response(null,{headers});
  const r=await githubFile(env,'open-reader',`arcade-roms/${f.sha}/${f.name}`);if(r.status!==200)return fail('GitHub game asset unavailable',r.throttled?429:502);
  if(r.body.length!==f.size||await hash(r.body)!==f.sha)return fail('Game asset integrity mismatch',502);
  // Verify immutable private GitHub asset before serving it.
  return new Response(r.body,{headers});
 }
 if(action!=='save'||filename)return fail('Method not allowed',405);
 if(req.headers.get('X-Arcade-Profile')!==id)return fail('Arcade client outdated; reload the page',409);
 const object=`v1/${id}/${slug}/${version}`;
 const db=env.ARCADE_DB;
 if(req.method==='GET'){
  // Single SELECT is a consistent snapshot, even during a simultaneous save.
  const result=await db.prepare('SELECT part,revision,saved_at,payload FROM arcade_checkpoint_v1 WHERE object_key=? ORDER BY part').bind(object).all();
  if(!result.success)throw Error('D1 read failed');const rows=result.results;
  if(!rows.length)return new Response(null,{status:404,headers:{'Cache-Control':'private,no-store'}});
  const head=rows[0],count=Number(head.payload);
  if(head.part!==-1||!Number.isInteger(count)||count<1||count>Math.ceil(WIRE_MAX/CHUNK)||rows.length!==count+1||rows.slice(1).some((r,i)=>r.part!==i||r.revision!==head.revision))throw Error('Incomplete checkpoint');
  return new Response(rows.slice(1).map(r=>r.payload).join(''),{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'private,no-store','ETag':'"'+head.revision+'"','X-Arcade-Saved-At':head.saved_at}});
 }
 if(req.method!=='PUT')return fail('Method not allowed',405);
 const match=req.headers.get('If-Match'),none=req.headers.get('If-None-Match');if(!((match&&/^"[a-f0-9]{32,64}"$/.test(match)&&!none)||(!match&&none==='*')))return fail('Save revision required',428);
 let wire;try{wire=new TextDecoder('utf-8',{fatal:true}).decode(await body(req,WIRE_MAX));}catch{return fail('Save too large or invalid',413);}
 // Browser encodes/compresses locally; avoid expensive base64 conversion inside the Free Worker.
 const prefix=wire.startsWith('raw:')?4:wire.startsWith('gzip:')?5:0;
 const n=wire.length-prefix;
 if(!prefix||n<4||n%4||/[^A-Za-z0-9+/=]/.test(wire.slice(prefix))||/=/.test(wire.slice(prefix,-2))||!/[A-Za-z0-9+/](?:==|=)?$/.test(wire.slice(-3)))return fail('Invalid checkpoint encoding',400);
 const revision=crypto.randomUUID().replaceAll('-',''),updated=new Date().toISOString(),count=Math.ceil(wire.length/CHUNK);
 const stmt=(sql,...params)=>db.prepare(sql).bind(...params);
 const statements=[match?
  stmt('UPDATE arcade_checkpoint_v1 SET revision=?,saved_at=?,payload=? WHERE object_key=? AND part=-1 AND revision=?',revision,updated,String(count),object,match.slice(1,-1)):
  stmt('INSERT INTO arcade_checkpoint_v1(object_key,part,revision,saved_at,payload) VALUES(?,-1,?,?,?) ON CONFLICT(object_key,part) DO NOTHING',object,revision,updated,String(count))];
 // Every dependent statement checks the winning revision. D1 batch is atomic;
 // stale writers cannot delete or replace any committed chunks.
 statements.push(stmt('DELETE FROM arcade_checkpoint_v1 WHERE object_key=? AND part>=0 AND EXISTS(SELECT 1 FROM arcade_checkpoint_v1 WHERE object_key=? AND part=-1 AND revision=?)',object,object,revision));
 for(let i=0;i<count;i++)statements.push(stmt('INSERT INTO arcade_checkpoint_v1(object_key,part,revision,saved_at,payload) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM arcade_checkpoint_v1 WHERE object_key=? AND part=-1 AND revision=?)',object,i,revision,updated,wire.slice(i*CHUNK,(i+1)*CHUNK),object,revision));
 const results=await db.batch(statements);
 if(results.some(r=>!r.success))throw Error('D1 write failed');
 if(results[0].meta.changes!==1)return fail('Another device updated this save. Local draft retained; reload to use cloud progress.',412);
 return json({ok:true,updated},200,{'ETag':'"'+revision+'"'});
 }catch(e){console.error('ARCADE_ROUTE_ERROR',e?.name);return fail('Arcade service temporarily unavailable',503);}
}
