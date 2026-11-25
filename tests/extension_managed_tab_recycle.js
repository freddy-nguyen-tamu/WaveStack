'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const raw=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const chapter='https://reader.example.test/comics/sample/chapter/83/';
const ping={ok:true,url:chapter,bridgeContentProtocol:6};
function setup({owned=true,direct=ping,listener=ping}={}) {
  const record={created:0,removed:0,reloaded:0,updated:0,scroll:0,pings:0};
  const storage={comicBridgeManagedTabId:owned?7:99,comicBridgeManagedSite:'reader.example.test'};
  const tabs={
    get(id,cb){cb({id,url:chapter,status:'complete',active:true,title:'Chapter 83'});},
    sendMessage(id,msg,cb){
      if(msg.type==='SCROLL'){record.scroll++;return;} // response lost, uncertain whether moved
      if(msg.type==='PING'){
        record.pings++;
        if(listener===null)return;
        cb(listener);
      }
    },
    create(){record.created++;throw Error('NO NEW TAB ALLOWED');},
    remove(){record.removed++;throw Error('NO TAB REMOVAL ALLOWED');},
    reload(){record.reloaded++;throw Error('NO RELOAD ALLOWED');},
    update(){record.updated++;throw Error('NO NAVIGATION ALLOWED');},
    query(filter,cb){cb([]);}
  };
  const chrome={tabs,scripting:{executeScript(){}},runtime:{id:'123456789',lastError:null,
    getManifest(){return {content_scripts:[{matches:['https://reader.example.test/*']}]};},
    onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
    storage:{local:{get(keys,cb){cb({...storage});},set(data,cb){Object.assign(storage,data);cb();}}},
    alarms:{create(){},onAlarm:{addListener(){}}}
  };
  const src=raw.replace('setTimeout(()=>autoConnect(),200);','// no initial autoconnect in test')
    .replace('const BROWSER_IO_STALL_MS = 18000;','const BROWSER_IO_STALL_MS = 30;');
  const env={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(env);
  vm.runInContext(src+`
    state={tabId:7,port:18765,token:'TOKEN'};
    directTabCommand=async()=>globalThis.__direct;
    globalThis.__direct=null;
    globalThis.__test={recycle:recycleManagedChapterTab,read:()=>({tab:state.tabId})};`,env);
  env.__direct=direct;
  return {env,record,storage};
}
(async()=>{
  const good=setup();
  const result=await good.env.__test.recycle();
  assert.equal(result.transport_reset,true);
  assert.equal(result.tab_id,7,'existing tab ID remains the only managed tab');
  assert.equal(result.url,chapter);
  assert.equal(good.env.__test.read().tab,7);
  assert.deepEqual(good.record,{created:0,removed:0,reloaded:0,updated:0,scroll:0,pings:0},
    'never double scroll or create/close/reload another tab');
  assert.equal(good.storage.comicBridgeManagedTabId,7);

  // A stalled/invalid direct-script PING may use an already-running listener;
  // this remains read-only and must never send another relative scroll.
  const fallback=setup({direct:null});
  const resumed=await fallback.env.__test.recycle();
  assert.equal(resumed.tab_id,7);
  assert.equal(fallback.record.scroll,0);
  assert.equal(fallback.record.pings,1);
  assert.equal(fallback.record.created,0);

  const unsafe=setup({owned:false});
  await assert.rejects(unsafe.env.__test.recycle(),/not owned by Comic Bridge/);
  assert.equal(unsafe.record.created,0);
  assert.equal(unsafe.env.__test.read().tab,7);

  const failed=setup({direct:null,listener:null});
  await assert.rejects(failed.env.__test.recycle(),
    /Same-tab scroll transport could not be verified; no new tab, reload, or second SCROLL attempted/);
  assert.equal(failed.record.scroll,0);
  assert.equal(failed.record.pings,1);
  assert.equal(failed.record.created,0);
  assert.equal(failed.record.reloaded,0);

  const wrong=setup({direct:{ok:true,url:'https://reader.example.test/other/',bridgeContentProtocol:6},
    listener:{ok:true,url:'https://reader.example.test/other/',bridgeContentProtocol:6}});
  await assert.rejects(wrong.env.__test.recycle(),/Same-tab scroll transport could not be verified/);
  assert.equal(wrong.record.created,0);
  console.log('PASS legacy same-tab diagnostic is read-only; it does not itself prove scroll completion');
})().catch(error=>{console.error(error);process.exit(1)});
