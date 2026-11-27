import { isManualSlug, manualChapterPublished } from './manual_import_worker.mjs';
/* Provider-independent Open Reader visit statistics.
 * Persistent D1 records; IP details visible only to the existing reader admin.
 * Every page_view is a document navigation; every chapter_read is a confirmed
 * published chapter selection. Asset/image/CDN requests are never counted.
 */
const SLUG = '[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?';
const PAGE = new RegExp('^/comics/(' + SLUG + ')/(?:index\\.html|settings\\.html|overview/(?:index\\.html)?)?$');
const CHAPTER_PAGE = new RegExp('^/comics/(' + SLUG + ')/(?:index\\.html)?$');
const CHAPTER_ID = /^[A-Za-z0-9_.-]{1,160}$/;
const EVENT_ID = /^[a-f0-9-]{20,60}$/;
// Null means no application-imposed expiration. Existing rows are retained.
const RETAIN_DAYS = null;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS journey_events (
 event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
 path TEXT NOT NULL, slug TEXT NOT NULL, chapter TEXT NOT NULL,
 ip TEXT NOT NULL, city TEXT NOT NULL, region TEXT NOT NULL,
 country TEXT NOT NULL, timezone TEXT NOT NULL, colo TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journey_events_time ON journey_events(created_at DESC);
CREATE TABLE IF NOT EXISTS journey_totals (
 day TEXT NOT NULL, kind TEXT NOT NULL, slug TEXT NOT NULL, chapter TEXT NOT NULL,
 city TEXT NOT NULL, region TEXT NOT NULL, country TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day,kind,slug,chapter,city,region,country)
);
CREATE INDEX IF NOT EXISTS idx_journey_totals_kind ON journey_totals(kind,slug,chapter);
CREATE TABLE IF NOT EXISTS journey_event_locations (
 event_id TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL
);
`;
let schemaDb=null, schemaPromise=null;
async function ready(db){
 if(schemaDb!==db || !schemaPromise){
   schemaDb=db;
   // D1.exec uses newline-separated SQL. Multiline CREATE statements cannot
   // safely be passed together as one script; submit one complete statement
   // per call, flattening its whitespace. These DDLs are all idempotent.
   schemaPromise=(async()=>{
     for(const part of SCHEMA.split(';')){
       const sql=part.trim().replace(/\s+/g,' ');
       if(sql)await db.exec(sql+';');
     }
   })().catch(e=>{schemaDb=null;schemaPromise=null;throw e;});
 }
 return schemaPromise;
}
const name = (value,limit=100) => typeof value==='string' && value.trim() ? value.trim().slice(0,limit) : 'Unknown';
const validPage = path => path==='/' || path==='/index.html' || path==='/your-journey/' ||
  path==='/your-journey/index.html' || path==='/privacy/' || path==='/privacy/index.html' || PAGE.test(path);
const getSlug = path => path.match(PAGE)?.[1] || '';
const validIP = value => typeof value==='string' && value.length<=45 &&
 /^(?:[0-9.]{7,15}|[0-9a-fA-F:.]{2,45})$/.test(value) ? value : 'Unknown';
const bad = (s,n=400) => new Response(JSON.stringify({ok:false,error:s}),{status:n,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const result = (data,n=200) => new Response(JSON.stringify(data),{status:n,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
async function chapterIsPublished(req,env,slug,chapter){
 if(isManualSlug(slug))return manualChapterPublished(env,slug,chapter);
 const url=new URL('/comics/'+slug+'/manifest.json',req.url);
 const r=await env.ASSETS.fetch(new Request(url,{method:'GET'}));
 if(!r.ok)return false;
 try{
  const data=await r.json();
  return Array.isArray(data.chapters) && data.chapters.some(c=>String(c?.id)===chapter && Array.isArray(c.images) && c.images.length>0);
 }catch{return false;}
}
async function track(req,env){
 if(req.headers.get('Origin')!==new URL(req.url).origin)return bad('Same-origin required',403);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 if((Number(req.headers.get('Content-Length'))||0)>1024)return bad('Event too large',413);
 let payload;
 try{payload=await req.json();}catch{return bad('Invalid event JSON');}
 const kind=payload?.kind;
 const path=payload?.path;
 const id=payload?.event_id;
 if(!['page_view','chapter_read'].includes(kind) || typeof path!=='string' || !validPage(path) ||
    typeof id!=='string' || !EVENT_ID.test(id))return bad('Invalid event identity');
 const slug=getSlug(path);
 let chapter='';
 if(kind==='chapter_read'){
   chapter=String(payload?.chapter_id||'');
   if(!slug || !CHAPTER_PAGE.test(path) || !CHAPTER_ID.test(chapter))return bad('Invalid chapter identity');
   if(!await chapterIsPublished(req,env,slug,chapter))return bad('Unpublished chapter',404);
 }
 const cf=req.cf||{};
 const ip=validIP(req.headers.get('CF-Connecting-IP'));
 const city=name(cf.city,80),region=name(cf.region,80),country=name(cf.country,8);
 const timezone=name(cf.timezone,80),colo=name(cf.colo,12);
 const now=new Date();
 const timestamp=now.toISOString(),day=timestamp.slice(0,10);
 // Cloudflare gives network-derived approximate location, never GPS.
 const lat=Number(cf.latitude),lng=Number(cf.longitude);
 const geoOk=cf.latitude!==undefined && cf.longitude!==undefined &&
   Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
 try{
   await ready(env.JOURNEY_DB);
   // D1 batch runs these statements in one atomic transaction. Duplicate
   // event_ids roll back the aggregate increment instead of overcounting.
   const updates=[
    env.JOURNEY_DB.prepare('INSERT INTO journey_events (event_id,created_at,kind,path,slug,chapter,ip,city,region,country,timezone,colo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,timestamp,kind,path,slug,chapter,ip,city,region,country,timezone,colo),
    env.JOURNEY_DB.prepare('INSERT INTO journey_totals (day,kind,slug,chapter,city,region,country,count) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(day,kind,slug,chapter,city,region,country) DO UPDATE SET count=count+1').bind(day,kind,slug,chapter,city,region,country),
   ];
   if(geoOk)updates.push(env.JOURNEY_DB.prepare('INSERT INTO journey_event_locations(event_id,latitude,longitude) VALUES (?,?,?)').bind(id,lat,lng));
   await env.JOURNEY_DB.batch(updates);
 }catch(e){
   if(/UNIQUE constraint failed: journey_events.event_id/i.test(String(e?.message||e)))return result({ok:true,duplicate:true});
   console.error('JOURNEY_TRACK_D1_ERROR',String(e?.message||e));
   return bad('Journey storage is temporarily unavailable',503);
 }
 return result({ok:true},202);
}
async function statistics(req,env,validSession){
 if(!await validSession(req,env))return bad('Admin sign-in required',401);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 try{
   await ready(env.JOURNEY_DB);
   const queries=[
    'SELECT kind,COALESCE(SUM(count),0) AS views FROM journey_totals GROUP BY kind',
    "SELECT slug,SUM(count) AS views FROM journey_totals WHERE kind='chapter_read' GROUP BY slug ORDER BY views DESC LIMIT 200",
    "SELECT slug,chapter,SUM(count) AS views FROM journey_totals WHERE kind='chapter_read' GROUP BY slug,chapter ORDER BY views DESC LIMIT 500",
    "SELECT country,region,city,SUM(count) AS views FROM journey_totals WHERE kind='chapter_read' GROUP BY country,region,city ORDER BY views DESC LIMIT 200",
    "SELECT country,region,city,slug,SUM(count) AS views FROM journey_totals WHERE kind='chapter_read' GROUP BY country,region,city,slug ORDER BY views DESC LIMIT 500",
    'SELECT created_at,kind,path,slug,chapter,ip,city,region,country,timezone,colo FROM journey_events ORDER BY created_at DESC LIMIT 200',
    "SELECT COUNT(*) AS n FROM (SELECT country,region,city FROM journey_totals WHERE kind='chapter_read' GROUP BY country,region,city)"
   ];
   // Issue reads sequentially to avoid exhausting simultaneous D1 connections.
   const rows=[];
   for(const query of queries)rows.push(await env.JOURNEY_DB.prepare(query).all());
   const [totals,comics,chapters,cities,comic_cities,recent,locationCounts]=rows.map(x=>x.results||[]);
   return result({ok:true,retention_days:RETAIN_DAYS,totals:Object.fromEntries(totals.map(x=>[x.kind,x.views])),
     comics,chapters,cities,comic_cities,recent,location_count:Number(locationCounts[0]?.n??0)});
 }catch(e){
   // Server-side only: no password, session cookie, IP, or visitor records logged.
   console.error('JOURNEY_STATS_D1_ERROR',String(e?.message||e));
   return bad('Journey statistics are temporarily unavailable',503);
 }
}
// Consecutive, chronological IP runs: the same IP separated by any other
// address always begins a NEW period. Never group by IP alone or by fixed time
// buckets. rowid is the durable tie-breaker for events with equal timestamps.
const PERIOD_CTE=`WITH ordered AS (
 SELECT e.rowid AS row_seq,e.event_id,e.created_at,e.kind,e.path,e.slug,e.chapter,
        e.ip,e.city,e.region,e.country,e.timezone,e.colo,
        LAG(e.ip) OVER(ORDER BY e.created_at,e.rowid) AS prior_ip
 FROM journey_events e WHERE e.rowid<=?
), grouped AS (
 SELECT *,SUM(CASE WHEN prior_ip IS NULL OR ip<>prior_ip THEN 1 ELSE 0 END)
  OVER(ORDER BY created_at,row_seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS period_id
 FROM ordered
) `;
// Freeze the read view at the maximum committed rowid. New visits cannot
// shift offsets or change period IDs while an administrator browses history.
async function historySnapshot(db,u){
 const raw=u.searchParams.get('snapshot');
 if(raw!==null){const n=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(n)||n<0)throw new RangeError('Invalid snapshot');return n;}
 const r=await db.prepare('SELECT COALESCE(MAX(rowid),0) AS snapshot FROM journey_events').all();
 const n=Number(r.results?.[0]?.snapshot??0);
 if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid stored snapshot');
 return n;
}
const validOffset=n=>Number.isSafeInteger(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER-251;
async function periods(req,env,validSession){
 if(!await validSession(req,env))return bad('Sign-in required',401);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 const u=new URL(req.url),offset=Number(u.searchParams.get('offset')||'0');
 if(!validOffset(offset))return bad('Invalid offset');
 try{
  await ready(env.JOURNEY_DB);
  const epoch=await unifiedEpoch(env.JOURNEY_DB,u);
  const snapshot=await historySnapshot(env.JOURNEY_DB,u);
  const sql=PERIOD_CTE+`SELECT period_id,MIN(ip) AS ip,MIN(created_at) AS start_at,
    MAX(created_at) AS end_at,COUNT(*) AS actions,MIN(row_seq) AS first_seq,
    MAX(row_seq) AS last_seq,MIN(city) AS city,MIN(region) AS region,
    MIN(country) AS country
    FROM grouped GROUP BY period_id ORDER BY period_id DESC LIMIT ? OFFSET ?`;
  const data=await env.JOURNEY_DB.prepare(sql).bind(snapshot,251,offset).all();
  if(epoch!==null&&epoch!==await archiveEpoch(env.JOURNEY_DB))return bad('History was archived during browsing. Refresh the timeline.',409);
  const found=data.results||[],more=found.length>250;
  return result({ok:true,periods:found.slice(0,250),next_offset:more?offset+250:null,
    retention_days:RETAIN_DAYS,snapshot,...(epoch===null?{}:{archive_epoch:epoch})});
 }catch(e){if(e instanceof RangeError)return bad(e.message);if(e.historyChanged)return bad(e.message,409);console.error('JOURNEY_PERIODS_ERROR',String(e?.message||e));return bad('Timeline unavailable',503)}
}
async function periodEvents(req,env,validSession){
 if(!await validSession(req,env))return bad('Sign-in required',401);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 const u=new URL(req.url),id=Number(u.searchParams.get('period'));
 const offset=Number(u.searchParams.get('offset')||'0');
 if(!Number.isSafeInteger(id)||id<1||!validOffset(offset))return bad('Invalid period or offset');
 try{
  await ready(env.JOURNEY_DB);
  const epoch=await unifiedEpoch(env.JOURNEY_DB,u);
  const snapshot=await historySnapshot(env.JOURNEY_DB,u);
  const sql=PERIOD_CTE+`SELECT grouped.created_at,grouped.kind,grouped.path,
    grouped.slug,grouped.chapter,grouped.ip,grouped.city,grouped.region,
    grouped.country,grouped.timezone,grouped.colo,
    geo.latitude AS latitude,geo.longitude AS longitude
    FROM grouped LEFT JOIN journey_event_locations geo ON grouped.event_id=geo.event_id
    WHERE grouped.period_id=? ORDER BY grouped.created_at,grouped.row_seq LIMIT ? OFFSET ?`;
  const data=await env.JOURNEY_DB.prepare(sql).bind(snapshot,id,201,offset).all();
  if(epoch!==null&&epoch!==await archiveEpoch(env.JOURNEY_DB))return bad('History was archived during browsing. Refresh the timeline.',409);
  const found=data.results||[],more=found.length>200;
  return result({ok:true,events:found.slice(0,200),next_offset:more?offset+200:null,snapshot});
 }catch(e){if(e instanceof RangeError)return bad(e.message);if(e.historyChanged)return bad(e.message,409);console.error('JOURNEY_PERIOD_EVENTS_ERROR',String(e?.message||e));return bad('Period unavailable',503)}
}
export async function journeyRoute(req,env,validSession,remoteFactory){
 const path=new URL(req.url).pathname;
 if(req.method==='GET'&&(path==='/api/journey/archives'||(['/api/journey/periods','/api/journey/period-events'].includes(path)&&new URL(req.url).searchParams.has('archive')))){
  if(!await validSession(req,env))return bad('Sign-in required',401);
  if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
  try{return path==='/api/journey/archives'?await archiveList(req,env):await archivedHistory(req,env,remoteFactory);}
  catch{console.error('JOURNEY_ARCHIVE_READ_FAILED');return bad('Archived history temporarily unavailable',503);}
 }
 if(path==='/api/journey/track' && req.method==='POST')return track(req,env);
 if(path==='/api/journey/stats' && req.method==='GET')return statistics(req,env,validSession);
 if(path==='/api/journey/periods' && req.method==='GET')return periods(req,env,validSession);
 if(path==='/api/journey/period-events' && req.method==='GET')return periodEvents(req,env,validSession);
 if(path.startsWith('/api/journey/'))return bad('Method or route not allowed',405);
 return null;
}
export const journeyConfigured = env => !!env.JOURNEY_DB;

// Archive is append-only. D1 keeps a compact index and one bounded pending
// transaction; event/geo rows remain until independent GitHub readback succeeds.
const ARCHIVE_REPO='open-reader-journey-history';
const ARCHIVE_BATCH=500, ARCHIVE_BATCHES=4;
const ARCHIVE_DIGEST=/^[a-f0-9]{64}$/;
const ARCHIVE_ENCODER=new TextEncoder();
const archiveSha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const archivePath=(day,digest)=>`events/${day.slice(0,4)}/${day.slice(5,7)}/${day}/${digest}.json`;
let archiveSchemaDb=null,archiveSchemaPromise=null;
async function archiveReady(db){
 if(archiveSchemaDb!==db||!archiveSchemaPromise){archiveSchemaDb=db;archiveSchemaPromise=(async()=>{
  await db.exec('CREATE TABLE IF NOT EXISTS journey_archive_pending (slot INTEGER PRIMARY KEY CHECK(slot=1), digest TEXT NOT NULL, path TEXT NOT NULL, payload TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, event_count INTEGER NOT NULL);');
  await db.exec('CREATE TABLE IF NOT EXISTS journey_archive_index (digest TEXT PRIMARY KEY, path TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, event_count INTEGER NOT NULL);');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_journey_archive_end ON journey_archive_index(end_at DESC,digest DESC);');
 })().catch(e=>{archiveSchemaDb=null;archiveSchemaPromise=null;throw e;});}
 return archiveSchemaPromise;
}
const one=async statement=>(await statement.all()).results?.[0]||null;
async function archiveEpoch(db){await archiveReady(db);return Number((await one(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM journey_archive_index')))?.n??0);}
async function unifiedEpoch(db,u){if(u.searchParams.get('unified')!=='1')return null;const n=await archiveEpoch(db),raw=u.searchParams.get('epoch');if(raw!==null&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))))throw new RangeError('Invalid history epoch');if(raw!==null&&Number(raw)!==n){const e=Error('History was archived during browsing. Refresh the timeline.');e.historyChanged=true;throw e;}return n;}
const pending=db=>one(db.prepare('SELECT * FROM journey_archive_pending WHERE slot=1'));
const eventQuery=`SELECT e.rowid AS row_seq,e.event_id,e.created_at,e.kind,e.path,e.slug,e.chapter,e.ip,e.city,e.region,e.country,e.timezone,e.colo,g.latitude,g.longitude FROM journey_events e LEFT JOIN journey_event_locations g ON e.event_id=g.event_id WHERE e.created_at < ? ORDER BY e.created_at,e.rowid LIMIT ${ARCHIVE_BATCH}`;
function missingTable(e){return /no such table: (?:main\.)?journey_events\b/i.test(String(e?.message||e));}
async function selectBatch(db,cutoff){return (await db.prepare(eventQuery).bind(cutoff).all()).results||[];}
function validateArchive(p,bytes){
 const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(data.schema!=='open-reader.journey.events.v1'||!Array.isArray(data.events)||data.events.length!==Number(p.event_count)||!data.events.length||data.events.length>ARCHIVE_BATCH)throw Error('Invalid archive payload');
 if(data.events[0].created_at!==p.start_at||data.events.at(-1).created_at!==p.end_at||new Set(data.events.map(e=>e.event_id)).size!==data.events.length)throw Error('Archive event identity mismatch');
 return data.events;
}
async function verifyArchive(p,bytes){
 if(!ARCHIVE_DIGEST.test(p.digest)||p.path!==archivePath(p.start_at.slice(0,10),p.digest)||await archiveSha(bytes)!==p.digest)throw Error('Journey archive SHA-256 mismatch');
 return validateArchive(p,bytes);
}
export async function archiveJourneyEvents(env,remoteFactory,now=Date.now()){
 const db=env.JOURNEY_DB;if(!db)return {archived:0,reason:'no database'};
 // Fast path: ONE indexed read; do not initialize schema, mint GitHub
 // credentials, create a commit, or perform network I/O for an empty queue.
 const cutoff=new Date(now).toISOString();let available;
 try{available=await one(db.prepare('SELECT event_id FROM journey_events WHERE created_at < ? ORDER BY created_at LIMIT 1').bind(cutoff));}catch(e){if(missingTable(e))return {archived:0,reason:'empty'};throw e;}
 if(!available)return {archived:0,reason:'empty'};
 await ready(db);await archiveReady(db);
 let remote=null,archived=0;
 for(let i=0;i<ARCHIVE_BATCHES;i++){
  let p=await pending(db);
  if(!p){
   let rows=await selectBatch(db,cutoff);if(!rows.length)break;
   let payload,bytes;for(;;){payload=JSON.stringify({schema:'open-reader.journey.events.v1',events:rows});bytes=ARCHIVE_ENCODER.encode(payload);if(bytes.length<=1024*1024)break;if(rows.length===1)throw Error('Journey archive event exceeds safety bound; retained');rows=rows.slice(0,Math.ceil(rows.length/2));}
   const digest=await archiveSha(bytes),start=rows[0].created_at,end=rows.at(-1).created_at;
   // INSERT OR IGNORE makes concurrent scheduled invocations agree on one
   // exact immutable batch; no second selection can change its contents.
   const selected=JSON.stringify(rows.map(e=>[e.event_id,e.created_at]));
   await db.prepare(`INSERT OR IGNORE INTO journey_archive_pending(slot,digest,path,payload,start_at,end_at,event_count)
    SELECT 1,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM json_each(?) j JOIN journey_events e ON e.event_id=json_extract(j.value,'$[0]') AND e.created_at=json_extract(j.value,'$[1]'))=?`).bind(digest,archivePath(start.slice(0,10),digest),payload,start,end,rows.length,selected,rows.length).run();
   p=await pending(db);if(!p)continue;
  }
  const bytes=ARCHIVE_ENCODER.encode(p.payload),rows=await verifyArchive(p,bytes);
  if(!remote)remote=await remoteFactory(env);
  let existing=await remote.read(p.path);
  if(existing===null){
   try{await remote.write(p.path,bytes);}catch(e){
    // A network failure can hide a successful commit. Read back once; no blind
    // write retries or indefinite waiting inside a scheduled Worker.
    existing=await remote.read(p.path);if(existing===null)throw e;
   }
   if(existing===null)existing=await remote.read(p.path);
  }
  if(existing===null)throw Error('Journey archive remote readback missing');
  await verifyArchive(p,existing);
  // One atomic D1 transaction. Delete only the exact frozen event IDs AND
  // timestamps, guarded by the pending digest, never by a broad date filter.
  // New arrivals, aggregates, manual imports and other tables are untouched.
  const ids=JSON.stringify(rows.map(e=>[e.event_id,e.created_at]));
  const guard='EXISTS (SELECT 1 FROM journey_archive_pending WHERE slot=1 AND digest=?)';
  const matches="(e.event_id,e.created_at) IN (SELECT json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]') FROM json_each(?) j)";
  const receipt=await db.batch([
   db.prepare('INSERT OR IGNORE INTO journey_archive_index(digest,path,start_at,end_at,event_count) SELECT digest,path,start_at,end_at,event_count FROM journey_archive_pending WHERE slot=1 AND digest=?').bind(p.digest),
   db.prepare(`DELETE FROM journey_event_locations WHERE ${guard} AND event_id IN (SELECT e.event_id FROM journey_events e WHERE ${matches})`).bind(p.digest,ids),
   db.prepare(`DELETE FROM journey_events AS e WHERE ${guard} AND ${matches}`).bind(p.digest,ids),
   db.prepare('DELETE FROM journey_archive_pending WHERE slot=1 AND digest=?').bind(p.digest)
  ]);
  archived+=Number(receipt?.[2]?.meta?.changes??rows.length);
 }
 return {archived,reason:'completed bounded nightly pass'};
}
async function archiveList(req,env){
 await archiveReady(env.JOURNEY_DB);
 const u=new URL(req.url),offset=Number(u.searchParams.get('offset')||0);
 if(!validOffset(offset))return bad('Invalid archive offset');
 // Freeze the append-only archive index for the current browsing session.
 // rowid is insertion order and breaks ties for same-timestamp batches.
 const raw=u.searchParams.get('snapshot');
 let snapshot;
 if(raw===null){snapshot=Number((await one(env.JOURNEY_DB.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM journey_archive_index')))?.n??0);}
 else{snapshot=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(snapshot)||snapshot<0)return bad('Invalid archive snapshot');}
 const found=(await env.JOURNEY_DB.prepare('SELECT digest,start_at,end_at,event_count FROM journey_archive_index WHERE rowid<=? ORDER BY end_at DESC,rowid DESC LIMIT 51 OFFSET ?').bind(snapshot,offset).all()).results||[];
 return result({ok:true,batches:found.slice(0,50),next_offset:found.length>50?offset+50:null,snapshot});
}
async function archivedHistory(req,env,remoteFactory){
 const u=new URL(req.url),digest=u.searchParams.get('archive'),offset=Number(u.searchParams.get('offset')||0);
 if(!ARCHIVE_DIGEST.test(digest||'')||!validOffset(offset))return bad('Invalid archive or offset');
 await archiveReady(env.JOURNEY_DB);
 const p=await one(env.JOURNEY_DB.prepare('SELECT * FROM journey_archive_index WHERE digest=?').bind(digest));
 if(!p)return bad('Archive not found',404);
 const remote=await remoteFactory(env),bytes=await remote.read(p.path);
 if(bytes===null)throw Error('Archive unavailable');
 const rows=await verifyArchive(p,bytes),groups=[];
 for(const e of rows){let g=groups.at(-1);if(!g||g.ip!==e.ip){g={period_id:groups.length+1,ip:e.ip,start_at:e.created_at,end_at:e.created_at,actions:0,first_seq:e.row_seq,last_seq:e.row_seq,city:e.city,region:e.region,country:e.country,events:[]};groups.push(g);}g.end_at=e.created_at;g.last_seq=e.row_seq;g.actions++;g.events.push(e);}
 if(u.pathname==='/api/journey/period-events'){
  const id=Number(u.searchParams.get('period'));if(!Number.isSafeInteger(id)||id<1)return bad('Invalid period');
  const events=groups[id-1]?.events||[];return result({ok:true,events:events.slice(offset,offset+200),next_offset:events.length>offset+200?offset+200:null,snapshot:rows.length});
 }
 const periods=groups.reverse().map(({events,...g})=>g);
 return result({ok:true,periods:periods.slice(offset,offset+250),next_offset:periods.length>offset+250?offset+250:null,snapshot:rows.length,retention_days:null});
}
