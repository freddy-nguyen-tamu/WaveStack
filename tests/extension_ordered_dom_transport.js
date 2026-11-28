'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const src=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const url='https://reader.example.test/chapter/1/',token='a'.repeat(32),digest='test',cdn='https://images.example.test/a.png';
const items=[{key:'1',order:1,url:url+'#reader-page-1',filename:'0001.png',selector:'img[data-index="1"]'}];
const tab={id:7,url,status:'complete'};let canon=url,fetchCount=0,canvasCount=0,blobExpired=false,tainted=false,changed=false,scrolls=0,missingPhase=null,lookupError=false,slotAbsent=false,slotDuplicate=false,duplicateKind='distinct';
const im={tagName:'IMG',complete:true,naturalWidth:10,naturalHeight:20,currentSrc:'blob:https://reader.example.test/temporary',closest:()=>null,scrollIntoView:()=>{scrolls++;tab.url=url+'2/';},getBoundingClientRect:()=>({width:10,height:20})};
const duplicate={...im};
const imageBlob=new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'});
const document={querySelector:()=>({href:canon}),querySelectorAll:()=>{if(lookupError)throw Error('fixture lookup error');return [{querySelectorAll:()=>slotAbsent?[]:slotDuplicate?[im,Object.assign(duplicate,im,{currentSrc:duplicateKind==='same'?im.currentSrc:im.currentSrc+'-other',hidden:duplicateKind==='hidden',complete:duplicateKind!=='unloaded',differentPixels:duplicateKind==='distinct'})]:[im]}];},createElement:()=>({getContext:()=>{let drawn;return {drawImage:e=>{drawn=e;canvasCount++;},getImageData:()=>{if(tainted){const e=new Error('tainted');e.name='SecurityError';throw e;}return {data:new Uint8Array([drawn?.differentPixels?2:1])};}};},toBlob(cb){if(tainted){const e=new Error('tainted');e.name='SecurityError';throw e;}cb(imageBlob);}})};
const chrome={runtime:{id:'test',lastError:null,getManifest:()=>({host_permissions:['https://reader.example.test/*','https://images.example.test/*'],content_scripts:[{matches:['https://reader.example.test/*']}]}),onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},tabs:{get(_id,cb){cb(tab);}},storage:{local:{get(k,cb){cb({});},set(d,cb){cb();}}},alarms:{create(){},onAlarm:{addListener(){}}},scripting:{executeScript:async ({files,func,args})=>{if(files){box.__comicArchiverNativePlan={digest,plan:{url,items,total:1,loaded:1}};return [{}];}if(args?.[4]===missingPhase){missingPhase=null;return [{}];}return [{result:await func(...(args||[]))}];}}};
const box={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob,AbortSignal,crypto,document,location:{origin:'https://reader.example.test',href:url},getComputedStyle:e=>({display:'block',visibility:'visible',opacity:e.hidden?'0':'1'}),fetch:async()=>{fetchCount++;if(blobExpired)throw Error('revoked');return {ok:true,blob:async()=>imageBlob};},createImageBitmap:async()=>({width:10,height:20,close(){}}),btoa:s=>Buffer.from(s,'binary').toString('base64')};
vm.createContext(box);vm.runInContext(src.replace('setTimeout(()=>autoConnect(),200);','// unit test')+`\nstate={tabId:7};globalThis.exec=execute;globalThis.capture=(url,b64)=>capturedImages.set(url,{base64:b64,size:4});globalThis.deny=url=>imageNetworkStatus.set(url,{status:403});globalThis.clearStatus=()=>imageNetworkStatus.clear();`,box);
(async()=>{const exec=(action,payload)=>box.exec({action,payload});assert.equal((await exec('script_capabilities',{})).orderedDom,true);
await exec('script_dom_plan',{url,digest,reader_selectors:['.reader']});const payload={url,token,item:items[0],position:true};
let r=await exec('script_dom_read',payload);assert.equal(r.via,'reader-blob-original');assert.equal(fetchCount,1);assert.equal(canvasCount,0);assert.equal(scrolls,1);assert.equal(tab.url,url+'2/');
blobExpired=true;r=await exec('script_dom_read',{...payload,position:false});assert.equal(r.via,'reader-decoded-png');assert.equal(canvasCount,1);
tainted=true;r=await exec('script_dom_read',payload);assert.equal(r.state,'denied');assert.match(r.reason,/SecurityError/);tainted=false;
im.currentSrc=cdn;box.capture(cdn,'iVBORw==');let before=fetchCount;r=await exec('script_dom_read',payload);assert.equal(r.via,'reader-https-original');assert.equal(fetchCount,before);
box.deny(cdn);r=await exec('script_dom_read',payload);assert.equal(r.state,'denied');assert.equal(fetchCount,before);box.clearStatus();
im.currentSrc='https://unapproved.example.test/a.png';r=await exec('script_dom_read',payload);assert.equal(r.state,'denied');
im.currentSrc='blob:https://elsewhere.example.test/a';r=await exec('script_dom_read',payload);assert.equal(r.state,'denied');
im.currentSrc='blob:https://reader.example.test/replaced';im.complete=false;r=await exec('script_dom_read',payload);assert.equal(r.state,'pending');im.complete=true;
// Chrome can omit InjectionResult.result for a page-side exception or
// transient execution failure. No data should be accepted for that receipt.
for(const phase of ['position','inspect','export']) {
  missingPhase=phase;r=await exec('script_dom_read',payload);
  assert.equal(r.state,'pending');assert.match(r.reason,new RegExp('missing '+phase+' receipt'));
  assert.equal(r.key,'1');assert.equal(r.base64,undefined);
  r=await exec('script_dom_read',payload);assert.equal(r.state,'complete');
}
lookupError=true;r=await exec('script_dom_read',payload);assert.equal(r.state,'unavailable');assert.match(r.reason,/locate: Error: fixture lookup error/);lookupError=false;
slotAbsent=true;r=await exec('script_dom_read',payload);assert.equal(r.state,'pending');assert.match(r.reason,/temporarily absent/);slotAbsent=false;
slotDuplicate=true;r=await exec('script_dom_read',payload);assert.equal(r.state,'pending');assert.match(r.reason,/different decoded pixels/);assert.match(r.reason,/"matches":2/);assert.match(r.reason,/"phase":"inspect"/);assert.equal(r.base64,undefined);
for(const kind of ['hidden','same','equivalent']) {duplicateKind=kind;r=await exec('script_dom_read',payload);assert.equal(r.state,'complete',kind);}
duplicateKind='equivalent';tainted=true;r=await exec('script_dom_read',payload);assert.equal(r.state,'denied');assert.match(r.reason,/SecurityError/);tainted=false;
duplicateKind='unloaded';r=await exec('script_dom_read',payload);assert.equal(r.state,'pending');assert.match(r.reason,/ambiguous/);
slotDuplicate=false;
r=await exec('script_dom_read',payload);assert.equal(r.state,'complete');
im.tagName='DIV';r=await exec('script_dom_read',payload);assert.equal(r.state,'unavailable');assert.match(r.reason,/"tag":"DIV"/);im.tagName='IMG';
im.closest=()=>({});r=await exec('script_dom_read',payload);assert.equal(r.state,'unavailable');assert.match(r.reason,/"invalidAncestor":true/);im.closest=()=>null;
await assert.rejects(exec('script_dom_read',{...payload,item:{...items[0],selector:'img'}}),/differs/);
canon='https://reader.example.test/chapter/2/';await assert.rejects(exec('script_dom_read',payload),/document replaced/);
console.log('PASS original blob, revoked blob PNG, tainted canvas, loaded HTTPS, denial, host scope, pending load, route changes, wrong slot and document');})().catch(e=>{console.error(e);process.exitCode=1});
