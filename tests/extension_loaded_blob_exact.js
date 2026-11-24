'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const origin='https://reader.example.test';
const one='blob:'+origin+'/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const two='blob:'+origin+'/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const pixels=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]);
const makeImage=url=>({currentSrc:url,src:url,complete:true,naturalWidth:400,naturalHeight:200});
const ims=[makeImage(one),makeImage(two)];
let requested=[];
const ctx={
  console,Date,Math,Promise,URL,Uint8Array,Error,String,Array,Number,Set,Map,Buffer,
  btoa:s=>Buffer.from(s,'binary').toString('base64'),
  location:{origin},
  document:{querySelector:s=>s==='.reader'?{querySelectorAll:tag=>tag==='img'?ims:[]}:null},
  fetch: async url=>{
    assert.ok([one,two].includes(url));requested.push(url);
    return {ok:true,headers:{get:k=>'image/png'},arrayBuffer:async()=>pixels.buffer};
  },
  setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,
};
ctx.chrome={
  runtime:{lastError:null,getManifest:()=>({content_scripts:[{matches:[origin+'/chapter/*']}],host_permissions:[origin+'/*']}),onMessage:{addListener(){}}},
  tabs:{get(_id,cb){cb({id:12,url:origin+'/chapter/test'});}},
  scripting:{executeScript:async ({func,args,world})=>{assert.equal(world,'MAIN');return [{result:await func(...args)}];}},
};
vm.createContext(ctx);
const script=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
vm.runInContext(script,ctx);
vm.runInContext('state={tabId:12}',ctx);
(async()=>{
  for(const url of [one,two]){
    const r=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',payload:{url,reader_selectors:['.reader']}});
    assert.equal(r.status,200);
    assert.deepEqual(Buffer.from(r.base64,'base64'),Buffer.from(pixels));
    assert.equal(r.via,'decoded-source-tab-blob');
  }
  assert.deepEqual(requested,[one,two]);
  await assert.rejects(()=>vm.runInContext('execute',ctx)({action:'read_loaded_blob',
    payload:{url:'blob:https://evil.test/secret',reader_selectors:['.reader']}}),/does not belong/);
  ims[0].complete=false;
  const notDecoded=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',payload:{url:one,reader_selectors:['.reader']}});
  assert.equal(notDecoded.status,424);
  assert.equal(requested.length,2);
  // A decoded image can survive URL.revokeObjectURL in the visible
  // document. Only a matched, decoded image may use rendered-PNG fallback.
  ims[0].complete=true;
  const screenshotCalls=[];
  vm.runInContext(`captureVisibleImage=async function(url) {
    globalThis.screenshotCalls.push(url);
    return {base64:'UE5H',via:'rendered-png'};
  };`,ctx);
  ctx.screenshotCalls=screenshotCalls;
  ctx.fetch=async()=>{throw TypeError('Failed to fetch');};
  const revived=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',payload:{url:one,reader_selectors:['.reader']}});
  assert.equal(revived.status,200);
  assert.equal(revived.via,'rendered-png');
  assert.equal(revived.headers['content-type'],'image/png');
  assert.deepEqual(screenshotCalls,[one],'only exact decoded image captured');
  // Missing and changed images still fail safely, without screenshot attempts.
  ims[0].complete=false;
  const absent=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',payload:{url:one,reader_selectors:['.reader']}});
  assert.equal(absent.status,424);
  assert.equal(screenshotCalls.length,1);
  ims[0].complete=true;
  vm.runInContext(`captureVisibleImage=async function(url) { throw Error('screenshot unavailable'); };`,ctx);
  const failed=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',payload:{url:one,reader_selectors:['.reader']}});
  assert.equal(failed.status,424,'screenshot failure must not mark image valid');
  assert.match(failed.diagnostics.pixelFallbackError,/screenshot unavailable/);
  assert.equal(revived.bridge_revision,'decoded-blob-fallback-diagnostics-v1');
  assert.equal(failed.bridge_revision,'decoded-blob-fallback-diagnostics-v1');
  // Direct decoded-image fallback returns source pixels, not viewport UI.
  // A strict source never falls back to screenshots when canvas is unavailable.
  ctx.document.createElement=tag=>{
    assert.equal(tag,'canvas');
    return {getContext:()=>({drawImage:im=>assert.equal(im,ims[0])}),
      toBlob:callback=>callback({size:pixels.length,arrayBuffer:async()=>pixels.buffer})};
  };
  ctx.fetch=async()=>{throw TypeError('revoked blob');};
  const clean=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',
    payload:{url:one,reader_selectors:['.reader'],require_clean_pixels:true}});
  assert.equal(clean.status,200);
  assert.equal(clean.via,'decoded-source-img-pixels');
  assert.deepEqual(Buffer.from(clean.base64,'base64'),Buffer.from(pixels));
  assert.equal(screenshotCalls.length,1,'strict image extraction never uses screenshot');
  ctx.document.createElement=()=>({getContext:()=>({drawImage:()=>{throw Error('tainted canvas');}})});
  const strictFailure=await vm.runInContext('execute',ctx)({action:'read_loaded_blob',
    payload:{url:one,reader_selectors:['.reader'],require_clean_pixels:true}});
  assert.equal(strictFailure.status,424);
  assert.match(strictFailure.reason,/tainted canvas/);
  assert.match(strictFailure.diagnostics.pixelFallbackError,/disallowed/);
  assert.equal(screenshotCalls.length,1);
  console.log('PASS: original decoded blobs, revoked-blob PNG fallback, missing and failed-capture safety');
})().catch(e=>{console.error(e);process.exitCode=1;});
