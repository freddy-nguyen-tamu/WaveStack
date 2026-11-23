"use strict";
// Generic bridge regression: decoded blob panels belong to the source reader,
// and visible clones must be selected over hidden originals. Never fetch blob.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/content.js'),'utf8');
const origin='https://reader.example.test';
const blob='blob:'+origin+'/f2fae603-5afd-4000-b134-5e87aa2e2509';
function img(url,{visible=true,loaded=true,alt='first.png'}={}){
 return {currentSrc:url,src:url,alt,complete:loaded,naturalWidth:loaded?600:0,naturalHeight:loaded?1100:0,
  getBoundingClientRect(){return {top:0,width:visible?600:0,height:visible?1100:0};},
  getAttribute(k){return k==='alt'?alt:k==='src'?url:null;},closest(){return null;}};
}
const hidden=img(blob,{visible:false}),clone=img(blob,{visible:true});
const root={querySelector:()=>hidden,querySelectorAll:()=>[hidden]};
const document={images:[hidden,clone],body:root,documentElement:{scrollHeight:1200},
 querySelector(q){return q==='.reader'?root:null;}};
const window={scrollY:0,innerHeight:800};
const ctx={document,window,location:{href:origin+'/chapter/100'},URL,
 chrome:{runtime:{onMessage:{addListener(){}}}},MutationObserver:class {observe(){}},
 console,Date,Math,Number,Promise,setTimeout,clearTimeout,innerHeight:800,innerWidth:900};
vm.runInNewContext(script,ctx);
(async()=>{
 assert.equal(window.__comicBridgeContentLoadedVersion,10);
 const probe=await window.__comicBridgeDirect({type:'FIRST_LOADED_IMAGE',
  payload:{origins:[],reader_selectors:['.reader']}});
 assert.equal(probe.url,blob);
 const snap=await window.__comicBridgeDirect({type:'SNAPSHOT',
  payload:{reader_selectors:['.reader'],image_attributes:['src']}});
 assert.equal(snap.imgs[0].url,blob);
 assert.equal(snap.imgs[0].loaded,true);
 hidden.complete=false;hidden.naturalWidth=hidden.naturalHeight=0;
 const denied=await window.__comicBridgeDirect({type:'FIRST_LOADED_IMAGE',
  payload:{origins:[],reader_selectors:['.reader']}});
 assert.equal(denied.url,'','a visible clone alone cannot grant access outside the reader');
 console.log('PASS: reader-scoped blob readiness, no guessed image URL, no undecoded panel');
})().catch(e=>{console.error(e);process.exitCode=1;});

// COMICARCHIVER_AUTH_BLOB_TRANSFER_20261122 — run exact browser-blob transfer regression in normal JS preflight
require('./extension_loaded_blob_exact.js');
