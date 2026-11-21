"use strict";
// Realistic MV3 mocks: fast content script message and old-tab receiver fallback.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8')
  .replace('const BROWSER_IO_STALL_MS = 18000;', 'const BROWSER_IO_STALL_MS = 25;');
const url='https://www.toongod.org/webtoon/annoying-alice/chapter-5/';
const manifest={host_permissions:['https://i.tngcdn.com/*','https://www.toongod.org/webtoon/annoying-alice/*'],
  content_scripts:[{matches:['https://www.toongod.org/webtoon/annoying-alice/*']}],version:'1.5.7'};
let fast=0, injection=0, receiverMissing=false, blockReceiver=false;
const chrome={runtime:{id:'comic-bridge-test-client',lastError:null,getManifest:()=>manifest,
    onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
  tabs:{sendMessage(_id,msg,callback){fast++;
      if(blockReceiver) return;
      if(receiverMissing){chrome.runtime.lastError={message:'Could not establish connection. Receiving end does not exist.'};callback();chrome.runtime.lastError=null;}
      else callback({ok:true,url,bridgeContentProtocol:6,type:msg.type});},
    get(_id,callback){callback({id:7,url,status:'complete',active:true,windowId:1});}},
  scripting:{executeScript:async({target,files,args})=>{
      assert.equal(target.tabId,7);injection++;
      return files ? [] : [{result:{ok:true,url,bridgeContentProtocol:6,type:args[0].type}}];
  }}
};
const sandbox={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
  setTimeout,clearTimeout,Uint8Array,Blob};
vm.createContext(sandbox);
vm.runInContext(source+'\nstate={tabId:7};globalThis.__test={send,checkedIO,execute};',sandbox);
(async()=>{
  const fastReply=await sandbox.__test.send(7,{type:'SCROLL'});
  assert.equal(fastReply.type,'SCROLL');assert.equal(injection,0);
  receiverMissing=true;
  const fallback=await sandbox.__test.send(7,{type:'PING'});
  assert.equal(fallback.type,'PING');assert.equal(injection,2);
  await assert.rejects(sandbox.__test.checkedIO(new Promise(()=>{}),'unresponsive browser'),/stalled.*unresponsive browser/);
  receiverMissing=false;blockReceiver=true;
  await assert.rejects(sandbox.__test.execute({action:'scroll',payload:{}}),/stalled.*scroll page command/);
  console.log('PASS live-tab fast path, navigation-safe receiver fallback, hung browser API watchdog');
})().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)});
