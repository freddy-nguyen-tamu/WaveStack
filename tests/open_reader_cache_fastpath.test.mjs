import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, webcrypto} from 'node:crypto';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root='https://reader.test',owner='fixture-owner',slug='cache-fixture',chapter='88';
const img=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(128).fill(33)]);
const sha=createHash('sha256').update(img).digest('hex');
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const manifest={chapters:[{id:chapter,images:[{url:`/api/github-image/${slug}/${chapter}/1?v=${sha}`,
  sha256:sha,github:{repo:`${slug}-vol-001`,path:`chapters/${chapter}/0001.png`},width:1,height:1}]}]};
let ghReads=0,cacheHits=0;
const memo=new Map(), pending=[];
const nativeFetch=globalThis.fetch,nativeCaches=globalThis.caches;
globalThis.caches={default:{
 async match(req){const v=memo.get(String(req.url));if(v){cacheHits++;return v.clone()}return null},
 async put(req,response){memo.set(String(req.url),response.clone());}
}};
globalThis.fetch=async(input,opt={})=>{
 const u=new URL(String(input));
 if(u.pathname.includes('/app/installations/'))return Response.json({token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()});
 if(u.pathname.includes('/repos/')){
   ghReads++;
   if(u.pathname.endsWith('overrides.json'))return new Response('not found',{status:404});
   assert.ok(u.pathname.endsWith(`/${slug}-vol-001/contents/chapters/${chapter}/0001.png`),u.pathname);
   return new Response(img,{headers:{'Content-Type':'image/png'}});
 }
 throw Error('Unexpected network request '+u);
};
const env={GITHUB_OWNER:owner,GITHUB_APP_ID:'12345',GITHUB_APP_INSTALLATION_ID:'54321',
 GITHUB_APP_PRIVATE_KEY:String(privateKey.export({type:'pkcs8',format:'pem'})),
 ASSETS:{fetch:async req=>new URL(req.url).pathname===`/comics/${slug}/manifest.json`?
  Response.json(manifest):new Response('missing',{status:404})}};
env.READER_ADMIN_PASSWORD='AnotherStrongFixturePassword01234';env.READER_SESSION_HMAC_KEY='long-fixture-hmac-secret-long-fixture-hmac-secret';
const auth=await worker.fetch(new Request(root+'/api/admin/login',{method:'POST',headers:{Origin:root,'Content-Type':'application/json'},body:JSON.stringify({password:env.READER_ADMIN_PASSWORD})}),env);
assert.equal(auth.status,200);const siteCookie=auth.headers.get('Set-Cookie').split(';')[0];
const req=new Request(root+manifest.chapters[0].images[0].url,{headers:{Cookie:siteCookie}});
const context={waitUntil:p=>pending.push(p)};
try{
 const first=await worker.fetch(req,env,context);
 assert.equal(first.status,200,await first.clone().text());
 assert.deepEqual(new Uint8Array(await first.arrayBuffer()),img);
 assert.match(first.headers.get('cache-control'),/max-age=31536000,immutable/);
 await Promise.all(pending);
 assert.ok(ghReads>=2,'must verify bytes and index on initial miss');
 const originalReads=ghReads;
 const second=await worker.fetch(req,env,context);
 assert.equal(second.status,200);
 assert.deepEqual(new Uint8Array(await second.arrayBuffer()),img);
 assert.equal(ghReads,originalReads,'verified warm-cache image must not look up GitHub again');
 assert.equal(cacheHits,1,'exactly one verified cache hit');
 // The current published manifest must still be checked. Removing an image
 // from the manifest cannot leak stale cached bytes of that removed panel.
 manifest.chapters[0].images=[];
 const withdrawn=await worker.fetch(req,env,context);
 assert.equal(withdrawn.status,404,'deleted panel must not remain accessible from cache');
 assert.equal(ghReads,originalReads);
 console.log('PASS warm SHA-versioned image cache skips GitHub, unlisted panels cannot read stale cache');
}finally{globalThis.fetch=nativeFetch;globalThis.caches=nativeCaches}
