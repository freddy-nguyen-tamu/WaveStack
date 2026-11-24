import assert from 'node:assert/strict';
import {generateKeyPairSync,webcrypto} from 'node:crypto';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
const origin='https://open-reader.example.test';
const owner='example-account';
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=privateKey.export({format:'pem',type:'pkcs8'});
const slug='test-comic',ch='82',panel=2;
const caseId='b'.repeat(20);
const image=(url,placeholder=false)=>placeholder?{placeholder:true,panel:2,confirmed_missing:true}:({url,width:3,height:3});
const manifest={title:'Test comic',chapters:[{id:ch,images:[image('/one'),image('',true),image('/three')]}]};
const issues={schema:'comicarchiver.source_issue_feed.v1',cases:[{id:caseId,status:'source_server_unavailable',work_slug:slug,work:'Test comic',episode:'Chapter 82',episode_id:ch,panel}]};
const repo=new Map(), fetches=[];
const encode=b=>Buffer.from(b).toString('base64');
let readBroken=false, metaSha=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
  const url=String(input), method=options.method||'GET';fetches.push({url,method});
  if(url.includes('/app/installations/'))return Response.json({token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()});
  const u=new URL(url);
  const prefix=`/repos/${owner}/open-reader/contents/`;
  assert.ok(u.pathname.startsWith(prefix),url);
  const key=decodeURIComponent(u.pathname.slice(prefix.length));
  if(method==='GET'){
    if(!repo.has(key))return new Response('not found',{status:404});
    const bytes=repo.get(key);
    if(readBroken && key.startsWith('overrides/'))return new Response('not found',{status:404});
    if(key==='overrides.json')return Response.json({type:'file',sha:'test'+metaSha,content:encode(bytes)});
    // Emulate GitHub API returning JSON metadata for a binary even if raw requested.
    return Response.json({type:'file',size:bytes.length,encoding:'base64',content:encode(bytes)});
  }
  if(method==='PUT'){
    const data=JSON.parse(options.body); const bytes=Buffer.from(data.content,'base64');
    repo.set(key,new Uint8Array(bytes));metaSha++;
    return Response.json({content:{sha:'test'+metaSha}},{status:201});
  }
  throw Error('Unmocked '+method+' '+key);
};
const env={GITHUB_OWNER:owner,GITHUB_APP_ID:'123456',GITHUB_APP_INSTALLATION_ID:'654321',GITHUB_APP_PRIVATE_KEY:String(pem),
 READER_ADMIN_PASSWORD:'this-is-a-test-password-valid',READER_SESSION_HMAC_KEY:'x'.repeat(50),
 ASSETS:{fetch:async r=>{
 const path=new URL(r.url).pathname;
 if(path==='/source-issues.json')return Response.json(issues);
 if(path==='/comics/'+slug+'/manifest.json')return Response.json(manifest);
 return new Response('not found',{status:404});
 }}
};
let siteCookie='';
const request=(path,opts={})=>worker.fetch(new Request(origin+path,{...opts,headers:{Cookie:siteCookie,...(opts.headers||{})}}),env);
try{
 let resp=await request('/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:env.READER_ADMIN_PASSWORD})});
 assert.equal(resp.status,200);const cookie=resp.headers.get('Set-Cookie').split(';')[0];siteCookie=cookie;
 const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(50).fill(1)]);
 resp=await request(`/api/admin/github-image/${slug}/${ch}/${panel}`,{method:'POST',headers:{Origin:origin,'Content-Type':'image/png',Cookie:cookie},body:png});
 assert.equal(resp.status,200,await resp.clone().text());
 const saved=await resp.json();assert.equal(saved.readback_verified,true);
 resp=await request(`/comics/${slug}/manifest.json`);assert.equal(resp.status,200);
 const live=(await resp.json()).chapters[0].images;
 assert.equal(live[0].url,'/one');assert.equal(live[2].url,'/three');
 assert.equal(live[1].placeholder,undefined);assert.equal(live[1].sha256,saved.sha256);
 assert.match(live[1].url,/^\/api\/github-image\/test-comic\/82\/2\?v=/);
 resp=await request(live[1].url);assert.equal(resp.status,200,await resp.clone().text());
 assert.equal(resp.headers.get('content-type'),'image/png');
 assert.deepEqual(new Uint8Array(await resp.arrayBuffer()),png);
 // Subsequent upload must not return false success if storage cannot be read.
 const changed=new Uint8Array(png);changed[25]++;
 readBroken=true;
 resp=await request(`/api/admin/github-image/${slug}/${ch}/${panel}`,{method:'POST',headers:{Origin:origin,'Content-Type':'image/png',Cookie:cookie},body:changed});
 assert.equal(resp.status,502);
 assert.match((await resp.json()).error,/read-back verification failed/);
 console.log('PASS github repair upload/readback, JSON metadata response, immutable manifest override, exact slot, failure reporting');
}finally{globalThis.fetch=originalFetch}

// Offline browser-DOM simulation: an already-open partial chapter must display
// a new replacement without a page reload, while all other slots remain intact.
{
  const {readFileSync}=await import('node:fs');
  const {runInNewContext}=await import('node:vm');
  const addon=readFileSync(new URL('../reusable/reader_chapter_enhancement.js',import.meta.url),'utf8');
  const start=addon.indexOf('  const repairedInFlight=new Set();');
  const end=addon.indexOf("  if(typeof setInterval==='function')setInterval",start);
  assert.ok(start>0 && end>start);
  const fragment=addon.slice(start,end)+'\nthis.testRefreshCurrent=refreshCurrentChapterRepairs;';
  const chapter={id:'82',images:[{url:'/a.png'}, {placeholder:true,panel:2}, {url:'/c.png'}]};
  const classSet=[new Set(),new Set(['or-missing-panel']),new Set()];
  let loadRequests=[];
  const figures=classSet.map((classes,i)=>({tagName:'FIGURE',style:{},isConnected:true,
    classList:{contains:name=>classes.has(name),remove:name=>classes.delete(name)},
    removeAttribute(){},replaceChildren(img){this.child=img;}}));
  const pages={children:figures};
  const known=[{status:'loaded',placeholder:false,el:{parentElement:figures[0]}},{status:'loaded',placeholder:true,el:figures[1]},{status:'loaded',placeholder:false,el:{parentElement:figures[2]}}];
  const windowLocation='https://open-reader.example.test/comics/test-comic/?chapter=82';
  const freshManifest={chapters:[{id:'82',images:[chapter.images[0],
    {url:'/api/github-image/test-comic/82/2?v='+('f'.repeat(64)),width:21,height:38},chapter.images[2]]}]};
  class SimImage{
    constructor(){this.naturalWidth=21;this.naturalHeight=38;this.decode=async()=>{}}
    set src(src){this._src=src;loadRequests.push(src);queueMicrotask(()=>this.onload?.())}
    get src(){return this._src}
  }
  const context={document:{hidden:false},pages,chapter,known,URL,Date,Image:SimImage,
    location:{origin:new URL(windowLocation).origin,href:windowLocation},console,
    chapterSequentialQueueComplete:true,
    fetch:async url=>({ok:true,json:async()=>freshManifest})};
  runInNewContext(fragment,context);
  await context.testRefreshCurrent();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(figures[1].child?.naturalWidth,21);
  assert.equal(figures[1].child?.naturalHeight,38);
  assert.equal(figures[1].style.aspectRatio,'21/38');
  assert.equal(known[1].status,'loaded');
  assert.equal(classSet[1].has('or-missing-panel'),false);
  assert.equal(figures[0].child,undefined);assert.equal(figures[2].child,undefined);
  assert.equal(loadRequests.length,1);
  assert.match(loadRequests[0],/\/api\/github-image\/test-comic\/82\/2/);
  console.log('PASS existing reader chapter swaps only missing panel after upload, mixed MIME-independent image slot, no adjacent requests');
}
