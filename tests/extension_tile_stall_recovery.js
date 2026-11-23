'use strict';
// Regression for chapter-6 failure: a decoded image must not become an 18s
// "position image tile" stall when Chrome pauses requestAnimationFrame.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const base=path.resolve(__dirname,'../reusable/browser_bridge_extension');
const content=fs.readFileSync(path.join(base,'content.js'),'utf8');
const background=fs.readFileSync(path.join(base,'background.js'),'utf8');
const chapter='https://www.toongod.org/webtoon/annoying-alice/chapter-6/';
const image='https://i.tngcdn.com/chapters/6/29.jpg';
async function contentCase(painted) {
  const window={scrollY:0};
  const img={complete:true,naturalWidth:760,naturalHeight:1300,
    currentSrc:image,src:image,getAttribute:()=>null,
    getBoundingClientRect:()=>({left:70,top:250-window.scrollY,width:420,height:720})};
  const document={images:[img]};
  window.scrollTo=(target)=>{window.scrollY=target.top;};
  const raf=painted ? cb=>setTimeout(cb,0) : ()=>{};
  const sandbox={window,document,chrome:{runtime:{onMessage:{addListener(){}}}},
    location:{href:chapter},innerWidth:1100,innerHeight:700,
    requestAnimationFrame:raf,scrollTo:window.scrollTo,
    getComputedStyle:()=>({}),URL,setTimeout,clearTimeout,Promise,Number,String,Math,Date,Error,console};
  vm.createContext(sandbox); vm.runInContext(content,sandbox);
  assert.equal(window.__comicBridgeContentLoadedVersion,10);
  const start=Date.now();
  const result=await window.__comicBridgeDirect({type:'CAPTURE_IMAGE_TILE',payload:{url:image,offsetCss:200}});
  const elapsed=Date.now()-start;
  assert.equal(result.ok,true);
  assert.equal(result.paintReady,painted);
  assert.equal(result.naturalWidth,760);
  assert.ok(elapsed<950,`imageTile was blocked for ${elapsed}ms`);
  assert.equal(window.scrollY,350);
  return elapsed;
}
async function backgroundCase() {
  const source=background
    .replace('setTimeout(()=>autoConnect(),200);','// autoConnect suppressed in regression')
    .replace('setTimeout(()=>resolve(null),1400);','setTimeout(()=>resolve(null),30);')
    .replace('const BROWSER_IO_STALL_MS = 18000;','const BROWSER_IO_STALL_MS = 50;');
  assert.ok(background.includes('setTimeout(()=>resolve(null),1400);'));
  assert.ok(background.includes("const tile=payload?.type==='CAPTURE_IMAGE_TILE'"));
  let injections=0, dispatched=0, messages=0;
  const chrome={runtime:{id:'test',lastError:null,
      onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}},
      getManifest:()=>({content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]})},
    tabs:{sendMessage(){messages++;/* never sends reply, simulates stalled old listener */},
      get(id,cb){assert.equal(id,7);cb({id,url:chapter,status:'complete',active:true});}},
    scripting:{executeScript:async({target,files,args})=>{
      assert.equal(target.tabId,7);
      if(files){injections++;assert.deepEqual(Array.from(files),['content.js']);return [];}
      dispatched++;assert.equal(args[0].type,'CAPTURE_IMAGE_TILE');
      return [{result:{ok:true,loaded:true,naturalWidth:760,naturalHeight:1300,
        rect:{left:70,top:50,width:420,height:720},viewportWidth:1100,viewportHeight:700}}];
    }}
  };
  const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(sandbox);
  vm.runInContext(source+'\nstate={tabId:7};globalThis.__probe={send,checkedIO};',sandbox);
  const reply=await sandbox.__probe.send(7,{type:'CAPTURE_IMAGE_TILE',payload:{url:image,offsetCss:200}});
  assert.equal(reply.ok,true);
  assert.equal(messages,1);
  assert.equal(injections,0);
  assert.equal(dispatched,1);
  // Non-idempotent forward scrolling must NEVER trigger a second transport.
  await assert.rejects(
    sandbox.__probe.checkedIO(sandbox.__probe.send(7,{type:'SCROLL'}),'scroll must not retry'),
    /stalled.*scroll must not retry/);
  assert.equal(injections,0,'a scroll command was incorrectly retried');
  assert.equal(messages,2);
}
(async()=>{
  const noFrames=await contentCase(false);
  await contentCase(true);
  await backgroundCase();
  console.log(`PASS tile paint fallback (${noFrames}ms), stalled-message recovery, no duplicate scrolling`);
})().catch(e=>{console.error(e);process.exit(1)});
