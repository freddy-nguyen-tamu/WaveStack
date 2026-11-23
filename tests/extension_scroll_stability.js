'use strict';
// Test the live DOM commands and the actual browser pixel-capture transport.
// Before this fix these checks fail because every capture/recovery restores
// the old viewport, typically chapter bottom, causing repeated teleporting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'../reusable/browser_bridge_extension');
const bg = fs.readFileSync(path.join(root,'background.js'),'utf8');
const content = fs.readFileSync(path.join(root,'content.js'),'utf8');
const chapter = 'https://reader.example.test/story/chapter-82/';
const imageUrl = 'https://images.example.test/ch82/0056.png';

async function contentCase() {
  let scrolls=[];
  const window={scrollY:10000,innerHeight:800};
  const im={isConnected:true,complete:false,naturalWidth:0,naturalHeight:0,
    currentSrc:imageUrl,src:imageUrl,
    closest(){return null;},getAttribute(name){return name==='src'?imageUrl:null;},
    getBoundingClientRect(){return {left:0,top:4000-window.scrollY,width:720,height:900};}};
  const root={querySelector:()=>im,querySelectorAll:()=>[im]};
  const document={body:root,documentElement:root,images:[im],querySelector:()=>root};
  window.scrollTo=({top})=>{window.scrollY=top;scrolls.push(top);
    if (top<5000 && !im.complete) setTimeout(()=>{
      im.complete=true;im.naturalWidth=720;im.naturalHeight=900;},20);
  };
  const ctx={window,document,location:{href:chapter},URL,
    chrome:{runtime:{onMessage:{addListener(){}}}},
    requestAnimationFrame:cb=>setTimeout(cb,0),setTimeout,clearTimeout,
    scrollTo:window.scrollTo,innerHeight:800,innerWidth:900,
    console,Math,Number,String,Date,Promise,Error};
  Object.defineProperty(ctx,'scrollY',{get:()=>window.scrollY});
  vm.createContext(ctx);vm.runInContext(content,ctx);
  assert.equal(window.__comicBridgeContentLoadedVersion,10);
  const recovered=await window.__comicBridgeDirect({type:'RECOVER_IMAGE',payload:{key:'1',url:imageUrl,
    reader_selectors:['main'],image_attributes:['src']}});
  assert.equal(recovered.loaded,true);
  assert.equal(window.scrollY,4050,'targeted recovery must stay near image, not teleport to bottom');
  assert.ok(scrolls.length>=3,'targeted movement must be animated');
  assert.ok(scrolls.every((y,i)=>i===0||y<=scrolls[i-1]),'recovery must not bounce to page bottom');
  const result=await window.__comicBridgeDirect({type:'SCROLL'});
  assert.equal(result,680,'forward scroll should cover 85% viewport for speed');
  assert.equal(window.scrollY,4730);
  assert.ok(scrolls.length>=6,'forward movement should be visibly animated');
  assert.ok(scrolls.slice(-7).every((y,i,a)=>i===0||y>=a[i-1]));
}

async function captureCase() {
  let messages=[];
  const imageData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==';
  let screenshots=0;
  const manifest={content_scripts:[{matches:['https://reader.example.test/story/*']}],
    host_permissions:['https://images.example.test/*']};
  const chrome={runtime:{id:'test',lastError:null,getManifest:()=>manifest,
      onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
    tabs:{get(id,cb){assert.equal(id,7);cb({id,url:chapter,active:true,windowId:3,status:'complete'});},
      sendMessage(id,message,cb){messages.push(message.type);
        if(message.type==='CAPTURE_IMAGE_TILE')cb({ok:true,loaded:true,
          naturalWidth:720,naturalHeight:350,
          rect:{left:40,top:100,width:720,height:350},viewportWidth:800,viewportHeight:900});
        else if(message.type==='SCROLL_POSITION')cb({scrollY:10000});
        else if(message.type==='RESTORE_SCROLL')cb({scrollY:10000});
        else cb({ok:true});},
      captureVisibleTab(_windowId,_opts,cb){screenshots++;cb('data:image/png;base64,'+imageData);}}
  };
  class OffscreenCanvas{
    getContext(){return {drawImage(){}};}
    async convertToBlob(){return new Blob([Buffer.from(imageData,'base64')],{type:'image/png'});}
  }
  const vmctx={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob,Buffer,OffscreenCanvas,
    createImageBitmap:async()=>({width:800,height:900,close(){}}),
    fetch:async()=>({blob:async()=>new Blob([Buffer.from(imageData,'base64')])}),
    btoa:s=>Buffer.from(s,'binary').toString('base64')};
  vm.createContext(vmctx);
  vm.runInContext(bg.replace('setTimeout(()=>autoConnect(),200);','// off in test')+
    '\nstate={tabId:7,port:18765,token:"test"};globalThis.__probe={captureVisibleImage};',vmctx);
  const out=await vmctx.__probe.captureVisibleImage(imageUrl);
  assert.equal(out.via,'rendered-png');
  assert.equal(screenshots,1);
  assert.deepEqual(messages,['CAPTURE_IMAGE_TILE'],
    'each screenshot must not restore previous bottom position or reread it');
}
(async()=>{await contentCase();await captureCase();
 console.log('PASS screenshot stays on ordered image; missing-image recovery stays targeted; gentle forward scroll');
})().catch(e=>{console.error(e);process.exitCode=1});
