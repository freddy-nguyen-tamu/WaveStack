import assert from 'node:assert/strict';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
const ORIGIN='https://open-reader.example.test';
class TestDB {
  constructor(){this.execCalls=0;this.batches=[];this.queries=[];this.active=0;this.maxActive=0;this.schemaSql=[];}
  async exec(s){
    this.execCalls++;
    // Regression: D1's newline-separated exec interface must receive exactly
    // one complete, single-line SQL DDL per call, not multiline fragments.
    assert.doesNotMatch(s,/\r|\n/);
    assert.match(s,/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    assert.match(s,/;$/);
    this.schemaSql.push(s);
  }
  prepare(q){const that=this;return {query:q,bind(...args){this.args=args;return this;},async all(){
    that.active++;that.maxActive=Math.max(that.maxActive,that.active);
    try{await Promise.resolve();that.queries.push(q);return {results:[]};}
    finally{that.active--;}
  }}}
  async batch(queries){this.batches.push(queries);return queries.map(()=>({success:true}));}
}
const db=new TestDB();
const env={ASSETS:{async fetch(req){const path=new URL(req.url).pathname;
  if(path==='/comics/comic-a/manifest.json')return new Response(JSON.stringify({chapters:[{id:'ch1',images:[{url:'test'}]}]}));
  if(path==='/your-journey/')return new Response('Your Journey');
  return new Response('no asset',{status:404});}},
  JOURNEY_DB:db,READER_ADMIN_PASSWORD:'SomeVeryStrongTestPasswordHere',READER_SESSION_HMAC_KEY:'abcdef0123456789abcdef0123456789abcdef01'};
const request=(path,opts={},geo)=>{
 const req=new Request(ORIGIN+path,opts);
 if(geo)Object.defineProperty(req,'cf',{value:geo});
 return req;
};
const call=(path,opts={},geo)=>worker.fetch(request(path,opts,geo),env);
const event=(id,kind,path='/comics/comic-a/')=>({event_id:id,kind,path,chapter_id:'ch1'});
const post=(payload,origin=ORIGIN)=>({method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.19'},body:JSON.stringify(payload)});
let response=await call('/api/journey/track',post(event('12345678-aaaa-bbbb-cccc-123456789abc','chapter_read')), {city:'College Station',region:'Texas',country:'US',timezone:'America/Chicago',colo:'DFW'});
assert.equal(response.status,202);
assert.equal(db.batches.length,1);
assert.equal(db.batches[0].length,3);
assert.ok(db.batches[0][0].query.includes('INSERT INTO journey_events'));
assert.equal(db.batches[0][0].args[6],'203.0.113.19');
assert.equal(db.batches[0][0].args[7],'College Station');
assert.equal(db.batches[0][1].args[2],'comic-a');
assert.equal(db.batches[0][1].args[3],'ch1');
response=await call('/api/journey/track',post(event('22345678-aaaa-bbbb-cccc-123456789abc','page_view','/')));
assert.equal(response.status,202);
assert.equal(db.batches[1][1].args[1],'page_view');
response=await call('/api/journey/track',post(event('32345678-aaaa-bbbb-cccc-123456789abc','chapter_read'),'https://untrusted.example'));
assert.equal(response.status,403);
response=await call('/api/journey/track',post(event('42345678-aaaa-bbbb-cccc-123456789abc','chapter_read','/comics/comic-a/overview/')));
assert.equal(response.status,400);
response=await call('/api/journey/track',post({...event('52345678-aaaa-bbbb-cccc-123456789abc','chapter_read'),chapter_id:'fake'}));
assert.equal(response.status,404);
response=await call('/api/journey/stats');assert.equal(response.status,401);
const login=await call('/api/admin/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:env.READER_ADMIN_PASSWORD})});
assert.equal(login.status,200);
const cookie=login.headers.get('Set-Cookie').split(';')[0];
response=await call('/api/journey/stats',{headers:{Cookie:cookie}});assert.equal(response.status,200);
const summary=await response.json();assert.equal(summary.retention_days,30);
assert.equal(summary.recent.length,0);
assert.equal(db.queries.length,6);
assert.equal(db.maxActive,1,'D1 summary queries must not execute concurrently');
assert.equal(db.execCalls,4,'D1 schema must initialize as four independent DDL calls');
assert.ok(db.schemaSql.some(s=>s.includes('journey_events')));
assert.ok(db.schemaSql.some(s=>s.includes('journey_totals')));
response=await call('/api/reader-health');assert.equal((await response.json()).journey_storage_configured,true);
const withoutDB={...env,JOURNEY_DB:undefined};
response=await worker.fetch(request('/api/journey/track',post(event('62345678-aaaa-bbbb-cccc-123456789abc','page_view','/'))),withoutDB);
assert.equal(response.status,503);
console.log('PASS: D1 geo/IP recording, verified chapter identity, page views, admin-only stats, no-database failure, CSRF and no fake chapter');
