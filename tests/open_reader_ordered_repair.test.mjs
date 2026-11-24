import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, webcrypto} from 'node:crypto';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const url='https://open-reader.test';
const owner='fixture-owner';
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=privateKey.export({format:'pem',type:'pkcs8'});
const slug='comic-fixture', chapterId='82', missingPanel=2;
const caseId='e'.repeat(20);
const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(64).fill(9)]);
const sha=createHash('sha256').update(png).digest('hex');
const path=`overrides/${slug}/${chapterId}/${missingPanel}-${sha}.png`;
const manifest={title:'Fixture',chapters:[
 {id:chapterId,images:[{url:'/first.png',width:5,height:5},{placeholder:true,panel:2,confirmed_missing:true},{url:'/third.png',width:5,height:5}]},
 {id:'83',images:[{url:'/later.png',width:5,height:5}]}
]};
const issues={schema:'comicarchiver.source_issue_feed.v1',cases:[
 {id:caseId,work_slug:slug,episode_id:chapterId,panel:missingPanel,status:'source_server_unavailable'}]};
const repo=new Map();
const calls=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,opt={})=>{
 const target=new URL(String(input));
 const method=opt.method||'GET';
 calls.push({method,url:target.href});
 if(target.pathname.includes('/app/installations/'))
   return Response.json({token:'fixture-token',expires_at:new Date(Date.now()+3600000).toISOString()});
 const prefix=`/repos/${owner}/open-reader/contents/`;
 assert.ok(target.pathname.startsWith(prefix),'unexpected GitHub request '+target);
 const key=decodeURIComponent(target.pathname.slice(prefix.length));
 if(method!=='GET')throw Error('unexpected GitHub mutation '+method);
 if(!repo.has(key))return new Response('missing',{status:404});
 const body=repo.get(key);
 const encoded=Buffer.from(body).toString('base64');
 return Response.json({type:'file',encoding:'base64',size:body.length,sha:'fake',content:encoded});
};
globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
const env={GITHUB_OWNER:owner,GITHUB_APP_ID:'123456',GITHUB_APP_INSTALLATION_ID:'654321',
 GITHUB_APP_PRIVATE_KEY:String(pem),ASSETS:{fetch:async req=>{
 const path=new URL(req.url).pathname;
 if(path===`/comics/${slug}/manifest.json`)return Response.json(manifest);
 if(path==='/source-issues.json')return Response.json(issues);
 return new Response('not found',{status:404});
}}};
const getManifest=async suffix=>{
 const result=await worker.fetch(new Request(`${url}/comics/${slug}/manifest.json${suffix}`),env,{});
 assert.equal(result.status,200,await result.clone().text());
 return result.json();
};
try{
 // A different Worker request previously saw an empty index and memoized it.
 let data=await getManifest('');
 assert.equal(data.chapters[0].images[1].placeholder,true);
 const index={schema:'reader-github-overrides-v1',panels:{
  [`${slug}:${chapterId}:${missingPanel}`]:{repo:'open-reader',path,sha256:sha,content_type:'image/png'}
 }};
 repo.set('overrides.json',new TextEncoder().encode(JSON.stringify(index)));
 repo.set(path,png);
 // Normal cached requests need not hit GitHub on every page/image.
 data=await getManifest('');
 assert.equal(data.chapters[0].images[1].placeholder,true);
 const reads=()=>calls.filter(x=>x.method==='GET'&&x.url.includes('overrides.json')).length;
 const oldReads=reads();
 data=await getManifest('?refresh-repairs-for=82');
 assert.equal(reads(),oldReads+1,'exactly one fresh index fetch for partial chapter');
 assert.equal(data.chapters[0].images[0].url,'/first.png');
 assert.equal(data.chapters[0].images[2].url,'/third.png');
 assert.equal(data.chapters[1].images[0].url,'/later.png');
 const image=data.chapters[0].images[1];
 assert.equal(image.placeholder,undefined);
 assert.equal(image.sha256,sha);
 assert.equal(image.url,`/api/github-image/${slug}/${chapterId}/${missingPanel}?v=${sha}`);
 const read=await worker.fetch(new Request(url+image.url),env,{});
 assert.equal(read.status,200,await read.clone().text());
 assert.equal(read.headers.get('content-type'),'image/png');
 assert.deepEqual(new Uint8Array(await read.arrayBuffer()),png);
 // Requesting a COMPLETE chapter does not cause a new GitHub index read.
 await getManifest('?refresh-repairs-for=83');
 assert.equal(reads(),oldReads+1);
 // Invalid chapter hints do not enable a forced index read.
 await getManifest('?refresh-repairs-for=outside');
 assert.equal(reads(),oldReads+1);
 console.log('PASS repaired slots resolved before queue, source panels unchanged, verified image bytes, no extra read for completed chapter');
}finally{globalThis.fetch=originalFetch;}
