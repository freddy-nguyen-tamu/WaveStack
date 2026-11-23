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
 try{
   await ready(env.JOURNEY_DB);
   // D1 batch runs these statements in one atomic transaction. Duplicate
   // event_ids roll back the aggregate increment instead of overcounting.
   await env.JOURNEY_DB.batch([
    env.JOURNEY_DB.prepare('INSERT INTO journey_events (event_id,created_at,kind,path,slug,chapter,ip,city,region,country,timezone,colo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,timestamp,kind,path,slug,chapter,ip,city,region,country,timezone,colo),
    env.JOURNEY_DB.prepare('INSERT INTO journey_totals (day,kind,slug,chapter,city,region,country,count) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(day,kind,slug,chapter,city,region,country) DO UPDATE SET count=count+1').bind(day,kind,slug,chapter,city,region,country),
    env.JOURNEY_DB.prepare('DELETE FROM journey_events WHERE created_at < ?').bind(cutoff),
   ]);
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
export async function journeyRoute(req,env,validSession){
 const path=new URL(req.url).pathname;
 if(path==='/api/journey/track' && req.method==='POST')return track(req,env);
 if(path==='/api/journey/stats' && req.method==='GET')return statistics(req,env,validSession);
 if(path.startsWith('/api/journey/'))return bad('Method or route not allowed',405);
 return null;
}
export const journeyConfigured = env => !!env.JOURNEY_DB;

export async function purgeJourneyEvents(env){
 if(!env.JOURNEY_DB)return;
 await ready(env.JOURNEY_DB);
 const cutoff=new Date(Date.now()-RETAIN_DAYS*86400000).toISOString();
 await env.JOURNEY_DB.prepare('DELETE FROM journey_events WHERE created_at < ?').bind(cutoff).run();
}
