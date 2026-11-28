'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const read=n=>fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/',n),'utf8');
const content=read('content.js'), background=read('background.js').replace('setTimeout(()=>autoConnect(),200);','// no startup in test');
const chapter='https://reader.example.test/chapter-3/', url='https://images.example.test/chapter-3/page-21.jpg';
async function scenario({mode='decode',refresh=false}={}) {
  let positions=0, writes=0, polls=0, pageTimers=0;
  const window={innerHeight:800,scrollY:0,scrollTo({top}){positions++;this.scrollY=top;}};
  const imgs=Array.from({length:35},(_,i)=>({isConnected:true,complete:i!==20,naturalWidth:i===20?0:720,naturalHeight:i===20?0:900,
    currentSrc:i===20?'':`https://images.example.test/chapter-3/page-${i+1}.jpg`,loading:'lazy',closest:()=>null,
    getBoundingClientRect(){return {top:10000-window.scrollY,height:900,width:720};},
    getAttribute(k){return k==='data-src'?`https://images.example.test/chapter-3/page-${i+1}.jpg`:k==='src'?this.source||null:null;}}));
  const img=imgs[20];Object.defineProperty(img,'src',{get(){return this.source||'';},set(v){writes++;this.source=v;}});
  const root={querySelector:()=>img,querySelectorAll:()=>imgs};
  const doc={body:root,documentElement:root,querySelector:()=>root};
  const chrome={runtime:{id:'test',getManifest:()=>({content_scripts:[{matches:['https://reader.example.test/*']}],host_permissions:['https://images.example.test/*']}),onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},tabs:{get(id,cb){cb({id,url:chapter,status:'complete'});}},scripting:{async executeScript({args}){const cmd=args[0];if(cmd.type==='RECOVER_IMAGE_STATUS') {polls++;if(mode==='decode'||mode==='wrong') {img.currentSrc=mode==='wrong'?'https://images.example.test/other.jpg':url;img.complete=true;img.naturalWidth=720;img.naturalHeight=900;}if(mode==='replaced') imgs[20]={...img};}return [{result:await window.__comicBridgeDirect(cmd)}];}}};
  const ctx={window,document:doc,location:{href:chapter},chrome,URL,console,innerHeight:800,innerWidth:1000,
    setTimeout(){pageTimers++;throw Error('page timers intentionally unavailable');},clearTimeout(){},requestAnimationFrame(){throw Error('paint suspended');}};
  vm.createContext(ctx);vm.runInContext(content,ctx);
  const bgCtx={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(bgCtx);vm.runInContext(background.replace('const deadline=Date.now()+7000;','const deadline=Date.now()+520;')+'\nstate={tabId:7};globalThis.probe=execute;',bgCtx);
  const payload={key:'21',url,reader_selectors:['.reader'],image_attributes:['data-src','src'],force_position:true,refresh_source:refresh};
  const promise=bgCtx.probe({action:'recover_image',payload});
  if(mode==='replaced') await assert.rejects(promise,/RECOVERY_DOCUMENT_CHANGED/);
  else {const result=await promise;assert.equal(result.loaded,mode==='decode');}
  assert.equal(positions,1,'exactly one absolute position change');assert.equal(writes,refresh?1:0);assert.equal(pageTimers,0);assert.ok(polls>=1);
}
(async()=>{await scenario();await scenario({refresh:true});await scenario({mode:'wrong'});await scenario({mode:'replaced'});await scenario({mode:'pending'});console.log('PASS 35-slot lazy receipt recovery, paused page timers, exact URL, no duplicate source mutation, changed node rejected, unresolved remains false');})().catch(e=>{console.error(e);process.exitCode=1;});
