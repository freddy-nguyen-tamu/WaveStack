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
const RETAIN_DAYS = 30;
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
 const cutoff=new Date(now.getTime()-RETAIN_DAYS*86400000).toISOString();
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
    env.JOURNEY_DB.prepare('DELETE FROM journey_events WHERE created_at < ?').bind(cutoff),
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
    'SELECT created_at,kind,path,slug,chapter,ip,city,region,country,timezone,colo FROM journey_events ORDER BY created_at DESC LIMIT 200'
   ];
   // Issue reads sequentially to avoid exhausting simultaneous D1 connections.
   const rows=[];
   for(const query of queries)rows.push(await env.JOURNEY_DB.prepare(query).all());
   const [totals,comics,chapters,cities,comic_cities,recent]=rows.map(x=>x.results||[]);
   return result({ok:true,retention_days:RETAIN_DAYS,totals:Object.fromEntries(totals.map(x=>[x.kind,x.views])),
     comics,chapters,cities,comic_cities,recent});
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
 FROM journey_events e
), grouped AS (
 SELECT *,SUM(CASE WHEN prior_ip IS NULL OR ip<>prior_ip THEN 1 ELSE 0 END)
  OVER(ORDER BY created_at,row_seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS period_id
 FROM ordered
) `;
async function periods(req,env,validSession){
 if(!await validSession(req,env))return bad('Sign-in required',401);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 const u=new URL(req.url),offset=Number(u.searchParams.get('offset')||'0');
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)return bad('Invalid offset');
 try{
  await ready(env.JOURNEY_DB);
  const sql=PERIOD_CTE+`SELECT period_id,MIN(ip) AS ip,MIN(created_at) AS start_at,
    MAX(created_at) AS end_at,COUNT(*) AS actions,MIN(row_seq) AS first_seq,
    MAX(row_seq) AS last_seq,MIN(city) AS city,MIN(region) AS region,
    MIN(country) AS country
    FROM grouped GROUP BY period_id ORDER BY period_id DESC LIMIT ? OFFSET ?`;
  const data=await env.JOURNEY_DB.prepare(sql).bind(251,offset).all();
  const found=data.results||[],more=found.length>250;
  return result({ok:true,periods:found.slice(0,250),next_offset:more?offset+250:null,
    retention_days:RETAIN_DAYS});
 }catch(e){console.error('JOURNEY_PERIODS_ERROR',String(e?.message||e));return bad('Timeline unavailable',503)}
}
async function periodEvents(req,env,validSession){
 if(!await validSession(req,env))return bad('Sign-in required',401);
 if(!env.JOURNEY_DB)return bad('Journey D1 database not configured',503);
 const u=new URL(req.url),id=Number(u.searchParams.get('period'));
 const offset=Number(u.searchParams.get('offset')||'0');
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(offset)||offset<0||offset>1000000)return bad('Invalid period or offset');
 try{
  await ready(env.JOURNEY_DB);
  const sql=PERIOD_CTE+`SELECT grouped.created_at,grouped.kind,grouped.path,
    grouped.slug,grouped.chapter,grouped.ip,grouped.city,grouped.region,
    grouped.country,grouped.timezone,grouped.colo,
    geo.latitude AS latitude,geo.longitude AS longitude
    FROM grouped LEFT JOIN journey_event_locations geo ON grouped.event_id=geo.event_id
    WHERE grouped.period_id=? ORDER BY grouped.created_at,grouped.row_seq LIMIT ? OFFSET ?`;
  const data=await env.JOURNEY_DB.prepare(sql).bind(id,201,offset).all();
  const found=data.results||[],more=found.length>200;
  return result({ok:true,events:found.slice(0,200),next_offset:more?offset+200:null});
 }catch(e){console.error('JOURNEY_PERIOD_EVENTS_ERROR',String(e?.message||e));return bad('Period unavailable',503)}
}
export async function journeyRoute(req,env,validSession){
 const path=new URL(req.url).pathname;
 if(path==='/api/journey/track' && req.method==='POST')return track(req,env);
 if(path==='/api/journey/stats' && req.method==='GET')return statistics(req,env,validSession);
 if(path==='/api/journey/periods' && req.method==='GET')return periods(req,env,validSession);
 if(path==='/api/journey/period-events' && req.method==='GET')return periodEvents(req,env,validSession);
 if(path.startsWith('/api/journey/'))return bad('Method or route not allowed',405);
 return null;
}
export const journeyConfigured = env => !!env.JOURNEY_DB;

export async function purgeJourneyEvents(env){
 if(!env.JOURNEY_DB)return;
 await ready(env.JOURNEY_DB);
 const cutoff=new Date(Date.now()-RETAIN_DAYS*86400000).toISOString();
 await env.JOURNEY_DB.prepare('DELETE FROM journey_events WHERE created_at < ?').bind(cutoff).run();
 await env.JOURNEY_DB.prepare('DELETE FROM journey_event_locations WHERE event_id NOT IN (SELECT event_id FROM journey_events)').run();
}
