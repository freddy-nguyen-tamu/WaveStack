import assert from 'node:assert/strict';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';

const ORIGIN='https://open-reader.example.test';
const id='a'.repeat(20), id2='b'.repeat(20);
const originals=Array.from({length:118},(_,i)=>({url:`https://images.example.test/${i+1}.jpg`,width:720,height:700}));
const cases=[
  {id,work:'Annoying Alice',work_slug:'annoying-alice',episode:'Episode 82',episode_id:'82',panel:56,status:'source_server_unavailable',reason:'adapter_confirmed_origin_placeholder'},
  {id:id2,work:'Annoying Alice',work_slug:'annoying-alice',episode:'Episode 82',episode_id:'82',panel:57,status:'source_server_unavailable',reason:'adapter_confirmed_origin_placeholder'}
];
const files=new Map([
 ['/source-issues.json',new Response(JSON.stringify({schema:'comicarchiver.source_issue_feed.v1',cases}),{headers:{'Content-Type':'application/json'}})],
 ['/comics/annoying-alice/manifest.json',new Response(JSON.stringify({title:'Annoying Alice',chapters:[{id:'82',images:originals}]}),{headers:{'Content-Type':'application/json'}})],
 ['/',new Response('<html><head><title>Open reader</title></head><body>Home</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})]
]);
class Bucket {
  data=new Map();
  async put(k,b,opts={}) {this.data.set(k,{bytes:typeof b==='string'?new TextEncoder().encode(b):new Uint8Array(b),options:opts})}
  async head(k) { const r=this.data.get(k);return r?{httpMetadata:r.options.httpMetadata,customMetadata:r.options.customMetadata,httpEtag:'"etag"'}:null }
  async get(k) { const r=this.data.get(k);if(!r)return null;return {body:r.bytes,httpMetadata:r.options.httpMetadata,customMetadata:r.options.customMetadata,httpEtag:'"etag"',json:async()=>JSON.parse(new TextDecoder().decode(r.bytes))} }
  async list({prefix='',cursor,limit}) {const keys=[...this.data.keys()].filter(k=>k.startsWith(prefix));return {objects:keys.map(k=>({key:k})),truncated:false}}
}
const bucket=new Bucket();
const env={ASSETS:{fetch:async req=>{
  const k=new URL(req.url).pathname,resp=files.get(k);
  return resp?resp.clone():new Response('Not found',{status:404});
}},PANEL_REPLACEMENTS:bucket,READER_ADMIN_PASSWORD:'A-secure-test-password-at-least-20-chars',READER_SESSION_HMAC_KEY:'0123456789abcdef0123456789abcdef01234567'};
const call=(path,opts={})=>worker.fetch(new Request(ORIGIN+path,opts),env);
const png=Uint8Array.from([137,80,78,71,13,10,26,10,...new Array(80).fill(1)]);
async function run(){
  let r=await call('/api/reader-health');assert.equal((await r.json()).script,'open-reader-panel-replacement-v1');
  r=await call('/source-issues.json');assert.equal(r.status,200);
  let feed=await r.json();assert.equal(feed.count,2);assert.equal(feed.affected_chapters,1);
  r=await call('/');assert.equal(r.status,200);let html=await r.text();assert.match(html,/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg">/);assert.match(html,/reader-issues.js/);
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'image/png'},body:png});assert.equal(r.status,401);
  r=await call('/api/admin/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});assert.equal(r.status,401);
  r=await call('/api/admin/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:env.READER_ADMIN_PASSWORD})});assert.equal(r.status,200);
  const cookie=r.headers.get('Set-Cookie').split(';')[0];assert.match(r.headers.get('Set-Cookie'),/HttpOnly/);
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'image/png','Cookie':cookie},body:png});assert.equal(r.status,200);
  r=await call('/source-issues.json');feed=await r.json();assert.equal(feed.affected_chapters,1);assert.equal(feed.cases.find(x=>x.id===id).replacement_present,true);assert.equal(feed.cases.find(x=>x.id===id2).replacement_present,false);
  r=await call('/api/panel-replacements/'+id);assert.equal(r.status,200);assert.equal(r.headers.get('Content-Type'),'image/png');
  r=await call('/comics/annoying-alice/manifest.json');let m=await r.json();assert.match(m.chapters[0].images[55].url,/api\/panel-replacements/);assert.match(m.chapters[0].images[55].sha256,/^[0-9a-f]{64}$/);assert.equal(m.chapters[0].images[54].url,originals[54].url);assert.equal(m.chapters[0].images[56].url,originals[56].url);
  const newer=new Uint8Array(png);newer[35]=3;
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'image/png','Cookie':cookie},body:newer});assert.equal(r.status,200);
  r=await call('/api/panel-replacements/'+id);assert.equal((new Uint8Array(await r.arrayBuffer()))[35],3);
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'text/html','Cookie':cookie},body:'<script>alert(1)</script>'});assert.equal(r.status,415);
  r=await call('/api/panel-replacements/'+'c'.repeat(20),{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'image/png','Cookie':cookie},body:png});assert.equal(r.status,404);
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'image/png','Cookie':cookie},body:png});assert.equal(r.status,403);
  // Issue remains accessible after feed moves to a new version that omits it.
  files.set('/source-issues.json',new Response(JSON.stringify({schema:'comicarchiver.source_issue_feed.v1',cases:[]}),{headers:{'Content-Type':'application/json'}}));
  r=await call('/source-issues.json');feed=await r.json();assert.equal(feed.cases.length,1);assert.equal(feed.cases[0].id,id);
  // Once the archiver verifies a formerly broken panel, that case is closed,
  // even though its revision history remains durably stored in R2.
  files.set('/source-issues.json',new Response(JSON.stringify({schema:'comicarchiver.source_issue_feed.v1',cases:[],resolved_ids:[id]}),{headers:{'Content-Type':'application/json'}}));
  r=await call('/source-issues.json');feed=await r.json();assert.equal(feed.cases.length,0);
  r=await call('/api/panel-replacements/'+id,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'image/png','Cookie':cookie},body:png});assert.equal(r.status,404);
  console.log('PASS: homepage injection, badge grouping, auth, upload, exact-slot override, reupload, case retention, MIME validation, unknown issue block, CSRF');
}
run().catch(e=>{console.error(e);process.exitCode=1});
