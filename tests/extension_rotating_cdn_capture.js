'use strict';
// Captured reader geometry: a 717px window, 700x1240 panels, five slots.
// The test uses synthetic pixels and a scrollable reader, not remote artwork.
const assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const dir=path.resolve(__dirname,'../reusable/browser_bridge_extension');
const content=fs.readFileSync(path.join(dir,'content.js'),'utf8');
const bg=fs.readFileSync(path.join(dir,'background.js'),'utf8');
const chapter='https://reader.example.test/story/chapter-0';
const url='https://rotating.example.test/hi/panel_123';
const selector='.reader img.panel';
let scopedNodes,cdnFetches=0; let activeUrl=chapter;
const window={scrollY:0,innerHeight:717};let windowMoves=0,scrolls=[];
window.scrollTo=()=>{windowMoves++};
const doc={scrollHeight:717},body={scrollHeight:717};
const surface={parentElement:body,clientHeight:717,clientWidth:1600,scrollHeight:5860,scrollTop:0,
  overflow:'auto',getBoundingClientRect:()=>({left:0,top:0,width:1600,height:717}),
  scrollTo({top}){this.scrollTop=Math.min(Math.max(top,0),this.scrollHeight-this.clientHeight);scrolls.push(this.scrollTop);}};
const root={parentElement:surface,querySelector:()=>img,querySelectorAll:()=>[img]};
const img={parentElement:root,complete:true,naturalWidth:700,naturalHeight:1240,currentSrc:url,src:url,
  closest:()=>null,getAttribute:k=>k==='src'?url:null,
  getBoundingClientRect:()=>({left:443,top:-surface.scrollTop,width:700,height:1240})};
const document={images:[img],body,documentElement:doc,querySelector:()=>root,querySelectorAll:s=>s===selector?scopedNodes:[]};
scopedNodes=[img];
const ctx={window,document,URL,location:{href:chapter},innerWidth:1600,innerHeight:717,
  getComputedStyle:el=>({overflowY:el.overflow||'visible'}),MutationObserver:class{observe(){}},
  requestAnimationFrame:cb=>setTimeout(cb,0),setTimeout,clearTimeout,console,
  chrome:{runtime:{onMessage:{addListener(){}}}}};
vm.createContext(ctx);vm.runInContext(content,ctx);
const run=m=>window.__comicBridgeDirect(m);
(async()=>{
  const snap=await run({type:'SNAPSHOT',payload:{reader_selectors:['.reader']}});
  assert.equal(snap.scrollY,0);assert.equal(snap.bottom,5143);assert.equal(snap.viewportHeight,717);assert.equal(snap.nestedScroll,true);
  // Real background capture loop calls the real content command in the VM.
  const draws=[];const payload='data:image/png;base64,iVBORw0KGgo=';
  const chrome={runtime:{id:'test',getManifest:()=>({content_scripts:[{matches:['https://reader.example.test/story/*']}],host_permissions:['https://cdn.example.test/*']}),onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
    tabs:{get(id,cb){cb({id,url:activeUrl,active:true,windowId:3,status:'complete'})},
      sendMessage(id,msg,cb){run(msg).then(cb)},captureVisibleTab(id,opts,cb){cb(payload)}}};
  class OffscreenCanvas{constructor(w,h){assert.equal(w,700);assert.equal(h,1240)}getContext(){return {drawImage(...args){draws.push(args.slice(1))}}}async convertToBlob(){return new Blob([new Uint8Array([1,2,3])])}}
  const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob,OffscreenCanvas,
    createImageBitmap:async()=>({width:1600,height:717,close(){}}),fetch:async u=>{if(!u.startsWith('data:')){cdnFetches++;throw Error('unexpected network fetch');}return {blob:async()=>new Blob([])}},btoa:s=>Buffer.from(s,'binary').toString('base64')};
  vm.createContext(sandbox);vm.runInContext(bg.replace('setTimeout(()=>autoConnect(),200);','// off')+'\nstate={tabId:7};globalThis.capture=captureVisibleImage;globalThis.executeJob=execute;',sandbox);
  const first=await run({type:'FIRST_LOADED_IMAGE',payload:{rendered_reader_selector:selector}});
  assert.equal(first.url,url);assert.equal(first.rendered_reader_revision,'scoped-rendered-reader-v1');
  await assert.rejects(sandbox.executeJob({action:'image',payload:{url}}),/no declared permission/);
  const proof=await sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}});
  assert.equal(proof.via,'rendered-png');assert.equal(proof.rendered_reader_revision,'scoped-rendered-reader-v1');assert.equal(draws.length,2);
  assert.equal(cdnFetches,0,'no unlisted CDN fetch');
  scopedNodes=[];await assert.rejects(sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}}),/No unique decoded native reader image/);
  scopedNodes=[img,img];await assert.rejects(sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}}),/No unique decoded native reader image/);
  scopedNodes=[img];img.currentSrc='https://different.example.test/hi/panel_123';
  await assert.rejects(sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}}),/No unique decoded native reader image/);
  img.currentSrc=url;img.complete=false;await assert.rejects(sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}}),/No unique decoded native reader image/);
  img.complete=true;activeUrl='https://other.example.test/story/chapter-0';await assert.rejects(sandbox.executeJob({action:'image',payload:{url,rendered_reader_selector:selector}}),/no longer on this source/);
  activeUrl=chapter;assert.equal(cdnFetches,0);assert.equal(draws.length,2);
  let end=0;for(const d of draws){const [sx,sy,sw,sh,dx,dy,dw,dh]=d;assert.equal(dx,0);assert.equal(dw,700);assert.ok(Math.abs(dy-end)<1e-6);assert.ok(sy>=0 && sy+sh<=717+1e-6);end=dy+dh;}
  assert.ok(Math.abs(end-1240)<1e-6,'all pixels captured, no black/missing strips');assert.equal(windowMoves,0);
  const before=surface.scrollTop;
  const receipt=await run({type:'SCROLL',payload:{command_id:'nested-1'}});
  assert.equal(receipt.status,'applied');assert.equal(surface.scrollTop,before+Math.floor(717*.65));
  const count=scrolls.length;await run({type:'SCROLL',payload:{command_id:'nested-1'}});assert.equal(scrolls.length,count);
  const snap2=await run({type:'SNAPSHOT',payload:{reader_selectors:['.reader']}});
  assert.equal(snap2.scrollY,surface.scrollTop);assert.equal(windowMoves,0);
  // A declared slot initially has no image at all, like captured pages 4-5.
  const slot={isConnected:true,parentElement:root,getAttribute:k=>k==='data-page'?'4':null,
    getBoundingClientRect:()=>({left:443,top:3720-surface.scrollTop,width:700,height:1240}),
    querySelectorAll:()=>surface.scrollTop>=3700?[mounted]:[]};
  const mounted={complete:true,naturalWidth:700,naturalHeight:1240,closest:()=>slot};
  root.querySelectorAll=selector=>selector==='[data-page]'?[slot]:[img];
  const recovery=await run({type:'RECOVER_IMAGE',payload:{key:'4',url:'',reader_selectors:['.reader']}});
  assert.equal(recovery.loaded,true);assert.equal(surface.scrollTop,3720);assert.equal(windowMoves,0);
  console.log('PASS: unlisted CDN native panel, contiguous pixel coverage, no CDN fetch, rejects unscoped/duplicate/unloaded/wrong-document image, preserves nested scroll and missing-slot recovery');
})().catch(e=>{console.error(e);process.exitCode=1});
