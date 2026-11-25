'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const dir=path.resolve(__dirname,'../reusable/browser_bridge_extension');
const chapter='https://reader.example.test/story/chapter-138';
const content=fs.readFileSync(path.join(dir,'content.js'),'utf8');
const background=fs.readFileSync(path.join(dir,'background.js'),'utf8');
function page(){
  let scrolls=[];
  const window={scrollY:2100,innerHeight:800};
  window.scrollTo=({top})=>{scrolls.push(top);window.scrollY=top;};
  const ctx={window,document:{},location:{href:chapter},innerHeight:800,
    chrome:{runtime:{onMessage:{addListener(){}}}},URL,Math,Number,String,Date,Promise,Error,
    setTimeout,clearTimeout,requestAnimationFrame:cb=>setTimeout(cb,0)};
  vm.createContext(ctx);vm.runInContext(content,ctx);
  return {window,scrolls};
}
function backgroundTest({mode}){
  const {window,scrolls}=page();
  let requests=0, tabCreates=0, tabReloads=0, fromStatus=0;
  const tab={id:7,url:chapter,status:'complete',title:'chapter 138'};
  const chrome={
    runtime:{id:'test',lastError:null,getManifest(){return {content_scripts:[{matches:['https://reader.example.test/*']}]};},
      onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
    tabs:{get(_id,cb){cb(tab);},create(){tabCreates++},remove(){throw Error('NO TAB CLOSE');},
      reload(){tabReloads++},sendMessage(_id,m,cb){cb({ok:true})}},
    storage:{local:{get(keys,cb){cb({});},set(data,cb){cb();}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    scripting:{executeScript(){}}
  };
  const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(sandbox);
  const shorter=background.replace('setTimeout(()=>autoConnect(),200);','// disabled for unit test')
    .replace('const BROWSER_IO_STALL_MS = 18000;','const BROWSER_IO_STALL_MS = 20;');
  vm.runInContext(shorter+`
    state={tabId:7,port:18765,token:'test'};
    directTabCommand=async (id,message)=>globalThis.__relay(id,message);
    globalThis.__testExecute=execute;
  `,sandbox);
  sandbox.__relay=async (_id,m)=>{
    if(m.type==='SCROLL'){
      requests++;
      if(mode==='never')return new Promise(()=>{});
      const actual=window.__comicBridgeDirect(m);
      if(mode==='lost')return new Promise(()=>{}); // execution succeeded, ACK never arrives
      return actual;
    }
    if(m.type==='SCROLL_STATUS'){
      fromStatus++;
      return window.__comicBridgeDirect(m);
    }
    throw Error('unexpected type: '+m.type);
  };
  return {sandbox,window,scrolls,read:()=>({requests,tabCreates,tabReloads,fromStatus})};
}
(async()=>{
  // Same ID is idempotent even when the first reply was lost.
  const p=page();const op={type:'SCROLL',payload:{command_id:'abc-1'}};
  const first=await p.window.__comicBridgeDirect(op);
  const again=await p.window.__comicBridgeDirect(op);
  const status=await p.window.__comicBridgeDirect({type:'SCROLL_STATUS',payload:{command_id:'abc-1'}});
  assert.equal(first.status,'applied');assert.equal(again.target,first.target);
  assert.equal(status.status,'applied');assert.equal(p.scrolls.length,1);
  assert.equal(p.window.scrollY,2780);
  const q=backgroundTest({mode:'success'});
  assert.equal(await q.sandbox.__testExecute({action:'scroll'}),680);
  assert.equal(q.read().requests,1);assert.equal(q.read().fromStatus,0);
  const lost=backgroundTest({mode:'lost'});
  assert.equal(await lost.sandbox.__testExecute({action:'scroll'}),680);
  assert.equal(lost.read().requests,1,'lost response must never resend SCROLL');
  assert.ok(lost.read().fromStatus>=1,'read-only receipt required');
  assert.equal(lost.scrolls.length,1,'exactly one DOM scroll despite lost ACK');
  assert.equal(lost.read().tabCreates,0);assert.equal(lost.read().tabReloads,0);
  const absent=backgroundTest({mode:'never'});
  await assert.rejects(absent.sandbox.__testExecute({action:'scroll'}),/SCROLL_OUTCOME_UNKNOWN/);
  assert.equal(absent.scrolls.length,0);assert.equal(absent.read().requests,1);
  assert.equal(absent.read().tabCreates,0);assert.equal(absent.read().tabReloads,0);
  console.log('PASS: idempotent absolute scroll, delayed/lost acknowledgment receipt, safe unknown outcome');
})().catch(e=>{console.error(e);process.exitCode=1});
