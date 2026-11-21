'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.resolve(__dirname, '../reusable/browser_bridge_extension/background.js'),'utf8');
const chosen = 'https://www.toongod.org/webtoon/annoying-alice/chapter-3/';
const manifest = {version:'1.5.7',host_permissions:['https://www.toongod.org/webtoon/annoying-alice/*','https://i.tngcdn.com/*','http://127.0.0.1:18765/*'], content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}]};
assert.ok(!manifest.host_permissions.includes('<all_urls>'), 'the fix must NOT request all-sites access');
let tabCaptureCalls=0, debugCaptureCalls=0, debugAttached=0;
let lastError=null;
const testB64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==';
const chrome = {
  runtime:{id:'comic-bridge-test-client',get lastError(){return lastError;},getManifest:()=>manifest,onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
  tabs:{
    captureVisibleTab(_windowId,_opts,cb){tabCaptureCalls++;lastError={message:"Either the '<all_urls>' or 'activeTab' permission is required."};cb(undefined);lastError=null;},
    get(id,cb){assert.equal(id,7);cb({id,url:chosen,windowId:9,active:true,status:'complete'});}
  },
  debugger:{
    attach(target,version,cb){assert.equal(target.tabId,7);assert.equal(version,'1.3');debugAttached++;cb();},
    sendCommand(target,method,params,cb){assert.equal(target.tabId,7);if(method==='Page.captureScreenshot') {
      assert.equal(params.captureBeyondViewport,false);debugCaptureCalls++;cb({data:testB64});
    } else if(method==='Page.enable'||method==='Network.enable') cb({});
    else throw Error(`Unexpected debugger command ${method}`);},
    onEvent:{addListener(){}},onDetach:{addListener(){}}
  }
};
const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob};
vm.createContext(sandbox);
vm.runInContext(src+'\nstate={tabId:7,port:18765,token:"test"};globalThis.__shot=selectedTabScreenshot;',sandbox);
(async()=>{
  const tab={id:7,url:chosen,windowId:9};
  let shot=await sandbox.__shot(tab);
  assert.equal(shot,'data:image/png;base64,'+testB64);
  assert.equal(tabCaptureCalls,1);
  assert.equal(debugCaptureCalls,1);
  assert.equal(debugAttached,1);
  shot=await sandbox.__shot(tab);
  assert.equal(shot,'data:image/png;base64,'+testB64);
  assert.equal(tabCaptureCalls,1,'no repeated failed captureVisibleTab calls');
  assert.equal(debugCaptureCalls,2);
  assert.equal(debugAttached,1,'debugger reused on same tab');
  await assert.rejects(()=>sandbox.__shot({id:8,url:chosen,windowId:9}),/selected comic tab/);
  await assert.rejects(()=>sandbox.__shot({id:7,url:'https://google.com/',windowId:9}),/selected comic tab/);
  console.log('PASS screenshot permission rejection -> existing debugger permission, only selected tab, no all-sites access');
})().catch(err=>{console.error(err);process.exit(1);});
