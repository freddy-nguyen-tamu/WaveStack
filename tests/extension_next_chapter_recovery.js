'use strict';
// Regression: chapter 1 succeeds and the next, newly navigated chapter has
// an unloaded image. Chrome suspends rAF AND the long-lived RECOVER_IMAGE
// message receiver. Neither condition may strand Python or reorder pages.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../reusable/browser_bridge_extension');
const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
const first='https://reader.example.test/story/chapter-1/';
const second='https://reader.example.test/story/chapter-2/';
const imgURL='https://images.example.test/chapter-2/0001.png';
let currentUrl=first, page=null, injections=0, directCalls=0;
let scrollCommands=0, recoveredMessages=0, navs=0;
const manifest={content_scripts:[{matches:['https://reader.example.test/story/*']}],
  host_permissions:['https://images.example.test/*']};
const chrome={runtime:{id:'test-chapter-handoff',lastError:null,getManifest:()=>manifest,
    onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
  tabs:{get(id,callback){assert.equal(id,7);callback({id,url:currentUrl,status:'complete',active:true,windowId:3});},
    update(id,config,callback){assert.equal(id,7);navs++;currentUrl=config.url;page=createPage(currentUrl,false);
      callback({id,url:currentUrl,status:'complete',active:true,windowId:3});},
    sendMessage(id,message,callback){assert.equal(id,7);
      if(message.type==='RECOVER_IMAGE') {recoveredMessages++;return;} // stale callback never fires
      if(message.type==='SCROLL') scrollCommands++;
      page.send(message,callback);
    }} ,
  scripting:{executeScript:async({target,files,func,args})=>{
    assert.equal(target.tabId,7,'never touch any other tab');
    if(files) {assert.deepEqual(Array.from(files),['content.js']);injections++;
      page.inject();return [];
    }
    directCalls++;
    const response=await page.injected(func,args[0]);
    return [{result:response}];
  }}
};
function createPage(url,alreadyLoaded) {
  const listeners=[];
  const window={scrollY:0,
    __comicBridgeContentLoadedVersion:6,
    __comicBridgeDirect:()=>({oldImplementation:true})};
  const img={isConnected:true,complete:alreadyLoaded,naturalWidth:alreadyLoaded?800:0,
    naturalHeight:alreadyLoaded?1400:0,currentSrc:imgURL,src:imgURL,
    loading:'lazy',closest(){return null;},getAttribute(name){return name==='src' ? imgURL : null;},
    scrollIntoView(){window.scrollY=220;
      // Browser lazy loader eventually resolves even though the paint clock
      // never delivers a frame after navigating to the new chapter.
      setTimeout(()=>{this.complete=true;this.naturalWidth=800;this.naturalHeight=1400;},150);
    },getBoundingClientRect(){return {left:0,top:220-window.scrollY,width:500,height:1000};}};
  const root={querySelector(sel){return sel==='img,[data-page]'?img:null;},
    querySelectorAll(sel){return sel==='img'?[img]:[];}};
  const document={images:[img],body:root,documentElement:root,
    querySelector(sel){return sel==='.reader'||sel==='main,article'?root:null;}};
  window.scrollTo=({top})=>{window.scrollY=top;};
  const pageChrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}}}};
  const sandbox={window,document,chrome:pageChrome,location:{href:url},URL,
    requestAnimationFrame(){/* stopped in background tab */},
    setTimeout,clearTimeout,Date,Promise,Math,Number,Error,String,console};
  vm.createContext(sandbox);
  const inject=()=>vm.runInContext(content,sandbox);
  inject();
  assert.equal(window.__comicBridgeContentLoadedVersion,7,'upgrade must replace old in-page content transport');
  return {img,inject,window,
    send(message,callback){
      assert.ok(listeners.length);
      listeners[listeners.length-1](message,{},callback);
    },
    async injected(func,arg){
      sandbox.__command=arg;
      return await vm.runInContext(`(${func.toString()})(__command)`,sandbox);
    }
  };
}
const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
  setTimeout,clearTimeout,Uint8Array,Blob};
vm.createContext(sandbox);
// Suppress auto-connect; the test explicitly owns the one paired tab.
const script=background.replace('setTimeout(()=>autoConnect(),200);','// test: no auto connect');
assert.notEqual(script,background,'test auto-connect guard changed');
vm.runInContext(script+'\nstate={tabId:7};globalThis.__test={execute,send};',sandbox);
(async()=>{
  page=createPage(first,true);
  const firstPing=await sandbox.__test.send(7,{type:'PING'});
  assert.equal(firstPing.url,first);
  await sandbox.__test.execute({action:'navigate',payload:{url:second}});
  assert.equal(navs,1);
  assert.equal(currentUrl,second);
  // If the extension uses the old listener, this call never returns; if
  // recoverImage awaits rAF with no timer, even fresh injection hangs.
  const start=Date.now();
  const result=await Promise.race([
    sandbox.__test.execute({action:'recover_image',payload:{key:'1',url:imgURL,
      reader_selectors:['.reader'],image_attributes:['src']}}),
    new Promise((_,reject)=>setTimeout(()=>reject(Error('chapter transition stalled: no RECOVER_IMAGE response')),1200))
  ]);
  assert.equal(result.key,'1');
  assert.equal(result.loaded,true);
  assert.equal(result.paintReady,false,'must not depend on rAF in new chapter');
  assert.equal(page.window.scrollY,0,'restore scroll, do not corrupt reading progression');
  assert.equal(recoveredMessages,0,'must not wait on stale async RECOVER_IMAGE listener');
  assert.equal(directCalls,1,'send only one idempotent new-document recovery');
  assert.equal(injections,1);
  assert.equal(scrollCommands,0,'must not duplicate forward scrolling');
  assert.ok(Date.now()-start<1000,'must return before the old 18-second watchdog');
  console.log('PASS first->next chapter new-document recovery with suspended rAF and unresponsive old receiver');
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
