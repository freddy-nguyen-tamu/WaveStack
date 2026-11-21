// Simulates a real Chrome debugger image response, after the tab loads it
// but before Python asks for the image bytes. No network retry may occur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const code = fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const chapter='https://www.toongod.org/webtoon/annoying-alice/chapter-1/';
const asset='https://i.tngcdn.com/comic/001.jpg';
const bytes=Buffer.from('original image bytes as loaded by normal browser');
const code64=bytes.toString('base64');
const bound=(owner,name,fun)=>{owner[name]=function(...args){assert.equal(this,owner,`unbound ${name}`);return fun(...args);};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run(kind) {
  let onMessage, onEvent, onDetach;
  let jobs=[{id:'scroll',action:'scroll'}, {id:'image',action:'image',payload:{url:asset}}];
  let results=[]; let resourceBodyCalls=0; let newRemoteFetches=0;
  const chrome={};
  const tabs={};
  bound(tabs,'get',(tabId,cb)=>cb({id:tabId,url:chapter}));
  bound(tabs,'update',(tabId,change,cb)=>cb({id:tabId,url:change.url}));
  bound(tabs,'sendMessage',(tabId,msg,cb)=>{
    if (msg.type==='SCROLL' && kind==='live') {
      onEvent({tabId:23},'Network.responseReceived',{
        type:'Image',requestId:'image-request-23',response:{status:200,url:asset}
      });
      onEvent({tabId:23},'Network.loadingFinished',{requestId:'image-request-23'});
      // Let the asynchronous getResponseBody call finish while lazy scrolling.
      setTimeout(()=>cb({ok:true}),30);
    } else cb({ok:true, url:chapter});
  });
  chrome.tabs=tabs;
  const storage={};bound(storage,'set',(obj,cb)=>cb());
  chrome.storage={local:storage};
  chrome.runtime={onMessage:{addListener:fn=>onMessage=fn},lastError:null,
    getManifest:()=>({host_permissions:['https://i.tngcdn.com/*'],content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]}),
    getPlatformInfo:cb=>cb({os:'win'})};
  const debuggerAPI={onEvent:{addListener:fn=>onEvent=fn},onDetach:{addListener:fn=>onDetach=fn}};
  bound(debuggerAPI,'attach',(target,protocol,cb)=>cb());
  bound(debuggerAPI,'detach',(target,cb)=>cb());
  bound(debuggerAPI,'sendCommand',(target,cmd,params,cb)=>{
    assert.equal(target.tabId,23);
    if (cmd==='Network.getResponseBody') {resourceBodyCalls++;cb({base64Encoded:true,body:code64});}
    else if (cmd==='Page.getResourceTree') cb({frameTree:{frame:{id:'same-tab'},resources:[]}});
    else if (cmd==='Page.captureSnapshot') {
      const mhtml='MIME-Version: 1.0\r\nContent-Type: multipart/related; type="text/html"; boundary="BOUNDARY-01"\r\n\r\n' +
        '--BOUNDARY-01\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: base64\r\n' +
        'Content-Location: '+asset+'\r\n\r\n'+code64+'\r\n--BOUNDARY-01--\r\n';
      cb({data:kind==='mhtml'?mhtml:''});
    } else cb({});
  });
  chrome.debugger=debuggerAPI;
  const context={chrome,URL,Blob,console:{debug:()=>{},warn:()=>{}},
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},
    fetch:async (url,options)=>{
      const location=new URL(url);
      if(location.hostname==='127.0.0.1') {
        if(location.pathname==='/hello') return {ok:true,json:async()=>({ok:true})};
        if(location.pathname==='/next') return {ok:true,json:async()=>({command:jobs.shift()||null})};
        if(location.pathname==='/result') {results.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};}
      }
      newRemoteFetches++;
      return {ok:false,status:403,url,headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(0)};
    }};
  vm.runInNewContext(code,context);
  const connection=await new Promise(resolve=>onMessage({type:'CONNECT',tabId:23,port:18765,
    token:'abcdefghijklmnopqrstuvwxyz123'},null,resolve));
  assert.equal(connection.ok,true,JSON.stringify(connection));
  const until=Date.now()+1800;
  while(results.length<2 && Date.now()<until) await wait(15);
  assert.equal(results.length,2,'both jobs processed');
  assert.equal(results[1].ok,true,JSON.stringify(results[1]));
  assert.equal(results[1].data.status,200);
  assert.deepEqual(Buffer.from(results[1].data.base64,'base64'),bytes);
  assert.equal(newRemoteFetches,0,'image bytes must come from tab memory, not a new CDN request');
  if(kind==='live') {
    assert.equal(results[1].data.via,'captured-during-scroll');
    assert.equal(resourceBodyCalls,1,'capture body when loading finished, not later');
  } else {
    assert.equal(results[1].data.via,'loaded-page-snapshot');
    assert.equal(resourceBodyCalls,0);
  }
}
(async()=>{
  await run('live');
  await run('mhtml');
  console.log('PASS: original image response cached during lazy scroll; pre-pair loaded MHTML resource recovered');
})().catch(error=>{console.error(error);process.exitCode=1;});
