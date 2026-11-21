// Deterministic regression: read already-loaded image bytes from the one
// paired Chromium tab. An extension-origin CDN GET returning 403 is not enough.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../reusable/browser_bridge_extension/background.js'),'utf8');
const chapter = 'https://www.toongod.org/webtoon/annoying-alice/chapter-1/';
const asset = 'https://i.tngcdn.com/fixture/001.jpg';
const imgBytes = Buffer.from('this_is_a_simulated_image_body');
async function runCase({available, permitted=true}) {
  let receiveMessage, receiveEvent, receiveDetach;
  const results=[];
  const cdpCalls=[];
  const visits=[];
  const warnings=[];
  let fetchNext=0;
  const port=18765;
  const binding = (obj, key, impl) => {obj[key]=function(...args) {
    assert.equal(this,obj,'Chrome API detached: '+key);
    return impl(...args);
  };};
  const chrome={};
  const tabs={};
  binding(tabs,'get',(id,cb)=>cb({id,url:chapter}));
  binding(tabs,'update',(id,changes,cb)=>cb({id,url:changes.url}));
  binding(tabs,'sendMessage',(id,msg,cb)=>cb({ok:true,url:chapter}));
  chrome.tabs=tabs;
  const local={};binding(local,'set',(data,cb)=>cb());
  chrome.storage={local};
  const runtime={lastError:null,onMessage:{addListener:fn=>receiveMessage=fn},
    getManifest:()=>({host_permissions:['https://i.tngcdn.com/*'],content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]}),
    getPlatformInfo(cb){cb({os:'win'});}};
  chrome.runtime=runtime;
  const debuggerObject={onEvent:{addListener:fn=>receiveEvent=fn}, onDetach:{addListener:fn=>receiveDetach=fn}};
  binding(debuggerObject,'attach',(target,version,cb)=>{ assert.equal(target.tabId,7);cb(); });
  binding(debuggerObject,'detach',(target,cb)=>cb());
  binding(debuggerObject,'sendCommand',(target,method,params,cb)=>{
    cdpCalls.push({target,method,params});
    assert.equal(target.tabId,7);
    if(method === 'Page.getResourceTree') cb({frameTree:{frame:{id:'correct-frame'},resources:available?[{type:'Image',url:asset}]:[]}});
    else if(method === 'Page.getResourceContent') {assert.equal(params.frameId,'correct-frame'); cb({content:imgBytes.toString('base64'),base64Encoded:true});}
    else cb({});
  });
  chrome.debugger=debuggerObject;
  const job = {id:'a1',action:'image',payload:{url: permitted?asset:'https://unrelated.example/001.jpg'}};
  const context = {chrome, URL, Blob, console:{debug:()=>{},warn:(...a)=>warnings.push(a.join(' '))},
    setTimeout:(fn,ms)=>{const timeout=setTimeout(fn,ms);timeout.unref?.();return timeout;},
    fetch:async (url,options) => {
      const p = new URL(url);
      visits.push(url);
      if(p.hostname === '127.0.0.1') {
        assert.equal(options.headers['X-Comic-Bridge-Token'],'abcdefghijklmnopqrstuvwxyz123');
        if(p.pathname === '/hello') return {ok:true,json:async()=>({ok:true})};
        if(p.pathname === '/next') {fetchNext++;return {ok:true,json:async()=>({command:fetchNext===1?job:null})};}
        if(p.pathname === '/result') {results.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};}
      }
      assert.equal(p.href,asset);
      return {ok:false,status:403,url:asset,headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(0)};
    }};
  vm.runInNewContext(source,context);
  const result=await new Promise(res=>receiveMessage({type:'CONNECT',tabId:7,port,
    token:'abcdefghijklmnopqrstuvwxyz123'},null,res));
  assert.equal(result.ok,true,JSON.stringify(result));
  const until=Date.now()+1200;
  while(!results.length && Date.now()<until) await new Promise(r=>setTimeout(r,12));
  assert.equal(results.length,1,JSON.stringify(warnings));
  if (!permitted) {
    assert.equal(results[0].ok,false);
    assert.match(results[0].error,/no declared permission/i);
  } else if (available) {
    assert.equal(results[0].ok,true,JSON.stringify(results[0]));
    assert.equal(results[0].data.status,200);
    assert.equal(Buffer.from(results[0].data.base64,'base64').toString(),imgBytes.toString());
    assert.equal(visits.filter(x=>x.startsWith('https://')).length,0,'must reuse the already loaded image');
    assert(cdpCalls.some(c=>c.method==='Page.getResourceContent'));
  } else {
    assert.equal(results[0].ok,true);
    assert.equal(results[0].data.status,424);
    assert.equal(results[0].data.base64,'');
    assert.equal(visits.filter(x=>x.startsWith('https://')).length,0,'no remote retry for CDN after capture miss');
  }
  assert.equal(cdpCalls.every(c=>c.target.tabId===7),true);
}
(async()=>{
  await runCase({available:true});
  await runCase({available:false});
  await runCase({available:true,permitted:false});
  console.log('PASS: paired tab image bytes reused; restricted hosts rejected; CDN 403 never misreported as success');
})().catch(e=>{console.error(e);process.exitCode=1;});
