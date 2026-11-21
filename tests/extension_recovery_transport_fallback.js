'use strict';
// A Chrome scripting API can stall independently of the already-installed
// content listener. Recover one DOM ordinal through the listener without
// ever repeating forward scroll/navigation; do not silently mark failure saved.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const bg=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const source=bg.replace('const BROWSER_IO_STALL_MS = 18000;', 'const BROWSER_IO_STALL_MS = 65;')
  .replace("action==='recover_image' ? 11000", "action==='recover_image' ? 65")
  .replace("'recover_image existing-listener fallback', 8500", "'recover_image existing-listener fallback', 65")
  .replace('setTimeout(()=>autoConnect(),200);','// no auto connect in test');
assert.notEqual(source,bg);
const chapter='https://reader.example.test/story/chapter-82/';
const imgUrl='https://images.example.test/ch82/0056.jpg';
async function scenario({receiverHangs}) {
  let injections=0, messages=0, recoverMessages=0, scrollMessages=0;
  const chrome={
    runtime:{id:'test',lastError:null,getManifest:()=>({
      content_scripts:[{matches:['https://reader.example.test/story/*']}],
      host_permissions:['https://images.example.test/*']}),
      onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
    tabs:{
      get(id,cb){assert.equal(id,7);cb({id,url:chapter,status:'complete',active:true});},
      sendMessage(id,cmd,cb){assert.equal(id,7);messages++;
        if(cmd.type==='RECOVER_IMAGE') {recoverMessages++;
          if(!receiverHangs) cb({key:'56',loaded:true,reason:'loaded in old listener'});
        } else if(cmd.type==='SCROLL') {scrollMessages++; /* intentionally stalled */}
        else cb({ok:true});
      }
    },
    scripting:{executeScript:async({target})=>{
      assert.equal(target.tabId,7);injections++;
      // The scripting API never resolves while Chrome is busy, even though
      // the tab messaging receiver can still answer.
      return new Promise(()=>{});
    }}
  };
  const ctx={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(ctx);
  vm.runInContext(source+'\nstate={tabId:7};globalThis.__probe={execute};',ctx);
  const start=Date.now();
  const promise=ctx.__probe.execute({action:'recover_image',payload:{key:'56',url:imgUrl,
    reader_selectors:['main'],image_attributes:['src']}});
  if(receiverHangs){
    await assert.rejects(promise,/stalled.*recover_image existing-listener fallback/);
  } else {
    const result=await promise;
    assert.equal(result.key,'56');assert.equal(result.loaded,true);
  }
  assert.ok(Date.now()-start<300,'recovery must not wait through a full chapter timeout');
  assert.equal(injections,1,'one scripting attempt: do not queue repeated stalled injections');
  assert.equal(recoverMessages,1,'only idempotent recovery can use the listener fallback');
  // Non-idempotent forward scroll is deliberately never resent.
  await assert.rejects(ctx.__probe.execute({action:'scroll',payload:{}}),/stalled.*scroll page command/);
  assert.equal(scrollMessages,1);
  assert.equal(injections,1);
  assert.equal(messages,2);
}
(async()=>{
  await scenario({receiverHangs:false});
  await scenario({receiverHangs:true});
  console.log('PASS stalled recover_image scripting fallback, exhausted listener failure, no duplicate forward scroll');
})().catch(e=>{console.error(e);process.exitCode=1});
