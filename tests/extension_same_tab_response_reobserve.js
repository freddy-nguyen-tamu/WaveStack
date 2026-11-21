const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const chapter='https://www.toongod.org/webtoon/annoying-alice/chapter-1/';
const asset='https://i.tngcdn.com/manga/001.jpg';
const image=Buffer.from('actual original bytes');
const b64=image.toString('base64');
let cbMsg,cbEvent,cbDetach;const results=[];let jobs=[{id:'image_1',action:'image',payload:{url:asset}}];
let extensionOriginCdnGets=0;let sameTabRequested=0;
const bound=(o,name,fn)=>o[name]=function(...args){assert.equal(this,o);return fn(...args);};
const chrome={runtime:{onMessage:{addListener:f=>cbMsg=f},lastError:null,getManifest:()=>({
  host_permissions:['https://www.toongod.org/*','https://i.tngcdn.com/*'],
  content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]
}),getPlatformInfo:cb=>cb({os:'win'})}};
chrome.tabs={};bound(chrome.tabs,'get',(id,cb)=>cb({id,url:chapter}));
bound(chrome.tabs,'sendMessage',(id,msg,cb)=>{
 if(msg.type==='REOBSERVE_LOADED_IMAGE') {
   sameTabRequested++;
   cbEvent({tabId:id},'Network.responseReceived',{type:'Image',requestId:'retry-same-tab',response:{status:200,url:asset}});
   cbEvent({tabId:id},'Network.loadingFinished',{requestId:'retry-same-tab'});
   cb({ok:true,loaded:true});
 } else cb({ok:true,url:chapter});
});
chrome.storage={local:{}};bound(chrome.storage.local,'set',(data,cb)=>cb());
chrome.debugger={onEvent:{addListener:fn=>cbEvent=fn},onDetach:{addListener:fn=>cbDetach=fn}};
bound(chrome.debugger,'attach',(tab,version,cb)=>cb());
bound(chrome.debugger,'detach',(tab,cb)=>cb());
bound(chrome.debugger,'sendCommand',(tab,cmd,p,cb)=>{
 if(cmd==='Network.getResponseBody') cb({body:b64,base64Encoded:true});
 else if(cmd==='Page.getResourceTree') cb({frameTree:{frame:{id:'test'},resources:[]}});
 else if(cmd==='Page.captureSnapshot') cb({data:''});
 else cb({});
});
const ctx={chrome,URL,Blob,console:{debug(){},warn(){}},setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();return t;},
 fetch:async(url,opt)=>{
   const u=new URL(url);
   if(u.hostname==='127.0.0.1') {
     if(u.pathname==='/next')return {ok:true,json:async()=>({command:jobs.shift()||null})};
     if(u.pathname==='/result') {results.push(JSON.parse(opt.body));return {ok:true,json:async()=>({ok:true})};}
     return {ok:true,json:async()=>({ok:true})};
   }
   extensionOriginCdnGets++;
   return {ok:false,status:403,url,headers:{get:()=>null}};
 }};
vm.runInNewContext(source,ctx);
(async()=>{
 const connect=await new Promise(resolve=>cbMsg({type:'CONNECT',tabId:9,port:18765,token:'abcdefghijklmnopqrstuvwxyz123'},null,resolve));
 assert(connect.ok,JSON.stringify(connect));
 const until=Date.now()+5000;
 while(results.length<1&&Date.now()<until) await new Promise(r=>setTimeout(r,20));
 assert.equal(results.length,1);
 assert.equal(results[0].data?.status,200,JSON.stringify(results[0]));
 assert.equal(Buffer.from(results[0].data.base64,'base64').toString(),image.toString());
 assert.equal(sameTabRequested,1,'normal existing tab image was reobserved');
 assert.equal(extensionOriginCdnGets,0,'no separate denied CDN request');
 console.log('PASS: already-visible image is reobserved in same browser tab; original response bytes captured without separate CDN fetch');
})().catch(e=>{console.error(e);process.exitCode=1});
