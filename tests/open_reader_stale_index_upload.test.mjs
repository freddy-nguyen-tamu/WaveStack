import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, webcrypto} from 'node:crypto';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://reader.test',owner='fixture-owner',slug='missing-fixture',chapter='82',panel=2;
const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(90).fill(91)]);
const sha=createHash('sha256').update(png).digest('hex');
const path=`overrides/${slug}/${chapter}/${panel}-${sha}.png`;
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const repo=new Map(),seen=[];
const oldFetch=globalThis.fetch,oldCaches=globalThis.caches;
globalThis.fetch=async(input,opt={})=>{
 const u=new URL(String(input));seen.push(u.pathname);
 if(u.pathname.includes('/app/installations/'))return Response.json({token:'fixture-token',expires_at:new Date(Date.now()+3600000).toISOString()});
 const prefix=`/repos/${owner}/open-reader/contents/`;
 assert.ok(u.pathname.startsWith(prefix),u.pathname);
 const key=decodeURIComponent(u.pathname.slice(prefix.length));
 if(!repo.has(key))return new Response('missing',{status:404});
 const bytes=repo.get(key);
 return Response.json({type:'file',encoding:'base64',size:bytes.length,sha:'fixture',content:Buffer.from(bytes).toString('base64')});
};
globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
const manifest={title:'Missing Fixture',chapters:[{id:chapter,images:[
 {url:'/a.png',width:3,height:3}, {placeholder:true,panel,confirmed_missing:true}, {url:'/c.png',width:3,height:3}
]}]};
const issues={schema:'comicarchiver.source_issue_feed.v1',cases:[{id:'d'.repeat(20),work_slug:slug,episode_id:chapter,panel,status:'source_server_unavailable'}]};
const env={GITHUB_OWNER:owner,GITHUB_APP_ID:'123456',GITHUB_APP_INSTALLATION_ID:'654321',
 GITHUB_APP_PRIVATE_KEY:String(privateKey.export({format:'pem',type:'pkcs8'})),ASSETS:{fetch:async request=>{
  const p=new URL(request.url).pathname;
  if(p===`/comics/${slug}/manifest.json`)return Response.json(manifest);
  if(p==='/source-issues.json')return Response.json(issues);
  return new Response('missing',{status:404});
 }}};
env.READER_ADMIN_PASSWORD='AnotherStrongFixturePassword01234';env.READER_SESSION_HMAC_KEY='long-fixture-hmac-secret-long-fixture-hmac-secret';
const auth=await worker.fetch(new Request(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:env.READER_ADMIN_PASSWORD})}),env);
assert.equal(auth.status,200);const siteCookie=auth.headers.get('Set-Cookie').split(';')[0];
try{
 // Prewarm the isolate with an EMPTY override index. A different upload
 // isolate later inserts the replacement; this worker is still stale.
 const before=await worker.fetch(new Request(`${origin}/comics/${slug}/manifest.json`,{headers:{Cookie:siteCookie}}),env,{});
 assert.equal((await before.json()).chapters[0].images[1].placeholder,true);
 const index={schema:'reader-github-overrides-v1',panels:{
  [`${slug}:${chapter}:${panel}`]:{repo:'open-reader',path,sha256:sha,content_type:'image/png'}
 }};
 repo.set('overrides.json',new TextEncoder().encode(JSON.stringify(index)));
 repo.set(path,png);
 const req=new Request(`${origin}/api/github-image/${slug}/${chapter}/${panel}?v=${sha}`,{headers:{Cookie:siteCookie}});
 const response=await worker.fetch(req,env,{waitUntil(){}});
 assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
 assert.ok(seen.filter(p=>p.endsWith('overrides.json')).length>=2,
   'newly uploaded missing panel must bypass stale 15s memo once');
 console.log('PASS newly uploaded missing-panel image read-back survives stale Worker override memo');
}finally{globalThis.fetch=oldFetch;globalThis.caches=oldCaches}
