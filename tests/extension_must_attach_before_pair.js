// Fail early if the browser cannot inspect already loaded CDN image responses.
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const chapter='https://www.toongod.org/webtoon/annoying-alice/chapter-1/';
function setup({supported=true,denied=false}) {
 let onMessage;let hello=0;let attach=0;let ops=[];
 const chrome={runtime:{lastError:null,onMessage:{addListener:fn=>onMessage=fn},
   getManifest:()=>({host_permissions:['https://www.toongod.org/*','https://i.tngcdn.com/*','http://127.0.0.1:18765/*'],content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]}),getPlatformInfo:cb=>cb({})}};
 const wrap=(o,k,fn)=>o[k]=function(...a){assert.equal(this,o);return fn(...a);};
 chrome.tabs={};wrap(chrome.tabs,'get',(id,cb)=>cb({id,url:chapter}));
 wrap(chrome.tabs,'sendMessage',(id,msg,cb)=>cb({ok:true,url:chapter}));
 chrome.storage={local:{}};wrap(chrome.storage.local,'set',(x,cb)=>cb());
 if(supported){chrome.debugger={onEvent:{addListener:fn=>{}},onDetach:{addListener:fn=>{}}};
   wrap(chrome.debugger,'attach',(t,v,cb)=>{attach++;if(denied)chrome.runtime.lastError={message:'Another debugger is attached'};cb();chrome.runtime.lastError=null;});
   wrap(chrome.debugger,'sendCommand',(t,cmd,params,cb)=>{ops.push(cmd);cb({})});
   wrap(chrome.debugger,'detach',(t,cb)=>cb());
 }
 const scope={chrome,URL,Blob,console:{debug(){},warn(){}},setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();return t;},
  fetch:async(url)=>{if(url.includes('/hello'))hello++;return {ok:true,json:async()=>({command:null})};}};
 vm.runInNewContext(source,scope);
 return {onMessage:m=>new Promise(resolve=>onMessage(m,null,resolve)),state:()=>({hello,attach,ops})};
}
(async()=>{
 const msg={type:'CONNECT',tabId:1,port:18765,token:'abcdefghijklmnopqrstuvwxyz123'};
 const noChrome=setup({supported:false});const fail=await noChrome.onMessage(msg);
 assert.equal(fail.ok,false);assert.match(fail.error,/Chrome\/Edge/);assert.equal(noChrome.state().hello,0);
 const denied=setup({denied:true});const refuse=await denied.onMessage(msg);
 assert.equal(refuse.ok,false);assert.match(refuse.error,/Another debugger/);assert.equal(denied.state().hello,0);
 const allowed=setup({});const success=await allowed.onMessage(msg);
 assert.equal(success.ok,true);assert.equal(allowed.state().hello,2);
 assert.deepEqual(allowed.state().ops,['Page.enable','Network.enable']);
 console.log('PASS: Firefox and denied Chrome debugger do NOT pair or start a crawl; enabled inspector starts before Python hello');
})().catch(e=>{console.error(e);process.exitCode=1});
