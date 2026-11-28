'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const site='www.reader.example.test';
const page=n=>`https://${site}/webtoon/sample/chapter-${n}/`;
const grant=`https://${site}/*`;
function setup(tabsInitial, startupUrl=page(62), managed={}, startupNonce='') {
  let tabs=tabsInitial.map(x=>({...x}));
  let storageState={...managed};
  let created=0, bootstrap=0, hello=0, reloaded=0;
  const waiters={};
  const manifest={version:'1.5.14',permissions:['tabs','storage','alarms'],host_permissions:[grant,'http://127.0.0.1:18765/*'],content_scripts:[{matches:[grant]}]};
  const chrome={
    runtime:{id:'local-test-extension-id',lastError:null,getManifest:()=>manifest,reload(){reloaded++;},
      onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},
    storage:{local:{get(_keys,cb){cb({...storageState});},set(_x,cb){Object.assign(storageState,_x);cb();}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    tabs:{onActivated:{addListener(){}},onCreated:{addListener(){}},onUpdated:{addListener(){}},
      query(_opts,cb){cb([...tabs]);},
      create(opts,cb){created++;const tab={id:200+created,url:opts.url,status:'complete',active:true,windowId:1};tabs.push(tab);cb(tab);},
      get(id,cb){const tab=tabs.find(x=>x.id===id);cb(tab||null);},
      update(id,change,cb){const tab=tabs.find(x=>x.id===id);Object.assign(tab,change);cb(tab);},
      sendMessage(id,message,cb){if(message.type==='PING')cb({ok:true,bridgeContentProtocol:6,url:tabs.find(t=>t.id===id).url});else cb({ok:true});}},
    scripting:{async executeScript(){return [];}}
  };
  const fetch=async (target,options={})=>{
    if(target.endsWith('/bootstrap')){
      bootstrap++;
      return {ok:true,json:async()=>({site,port:18765,protocol:'visual-transfer-2',token:'a_1234567890123456789012345678',startup_url:startupUrl,startup_nonce:startupNonce})};
    }
    if(target.endsWith('/hello')){hello++;return {ok:true,json:async()=>({ok:true})};}
    if(target.endsWith('/next'))return new Promise(()=>{});
    if(target.endsWith('/heartbeat'))return {ok:true,json:async()=>({ok:true})};
    throw Error('Unexpected request '+target);
  };
  const sandbox={chrome,fetch,URL,Set,Map,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout(fn,ms){if(ms===200 || ms===2500 || ms===5000)return 1;return setTimeout(fn,ms);},
    clearTimeout,Uint8Array,Blob,OffscreenCanvas:function(){}};
  vm.createContext(sandbox);
  vm.runInContext(src+'\nglobalThis.__test={autoConnect,pickComicTab,trustedStartupUrl,getState(){return state;}};',sandbox);
  return {test:sandbox.__test, get:()=>({created,bootstrap,hello,reloaded,tabs,storageState})};
}
async function main(){
  const exact=setup([{id:1,url:page(62),status:'complete',active:true,windowId:1}]);
  await exact.test.autoConnect();
  assert.equal(exact.get().created,1,'creates owned tab even when an older matching tab exists');
  assert.equal(exact.get().hello>=1,true,'automatically pairs without UI/codes');
  assert.equal(exact.test.getState().tabId,201);
  assert.equal(exact.get().tabs.find(t=>t.id===1).url,page(62));

  const old=setup([{id:10,url:page(1),status:'complete',active:true,windowId:1}]);
  await old.test.autoConnect();
  assert.equal(old.get().created,1,'creates target instead of hijacking unrelated old chapter');
  assert.equal(old.get().tabs.find(t=>t.id===10).url,page(1),'original tab remains untouched');
  assert.equal(old.test.getState().tabId,201);
  assert.equal(old.get().tabs.at(-1).url,page(62));

  // A previous automatic run's own tab may be resumed and navigated to the
  // next unfinished chapter. Even then, an arbitrary old matching tab is ignored.
  const managed=setup([
    {id:7,url:page(1),status:'complete',active:true,windowId:1},
    {id:88,url:page(60),status:'complete',active:false,windowId:1},
  ],page(62),{comicBridgeManagedTabId:88,comicBridgeManagedSite:site});
  await managed.test.autoConnect();
  assert.equal(managed.get().created,0,'reuses only an extension-owned tab');
  assert.equal(managed.test.getState().tabId,88);
  assert.equal(managed.get().tabs.find(t=>t.id===88).url,page(62));
  assert.equal(managed.get().tabs.find(t=>t.id===7).url,page(1));
  // A stale managed ID pointing to an unrelated site must NOT be hijacked.
  const stale=setup([{id:88,url:'https://unrelated.example.test/',status:'complete',active:true,windowId:1}]
    ,page(62),{comicBridgeManagedTabId:88,comicBridgeManagedSite:site});
  await stale.test.autoConnect();
  assert.equal(stale.get().created,1,'stale tab identity forces a fresh owned tab');
  assert.equal(stale.get().tabs.find(t=>t.id===88).url,'https://unrelated.example.test/');

  const empty=setup([]);
  await empty.test.autoConnect();
  assert.equal(empty.get().created,1,'no pre-opened tabs required');
  assert.equal(empty.get().hello>=1,true,'new tab paired by itself');

  const forbidden=setup([],'https://evil.example.test/');
  await forbidden.test.autoConnect();
  assert.equal(forbidden.get().created,0,'never creates unauthorized page');
  assert.equal(forbidden.get().hello,0,'no pairing without permitted URL');

  const forbiddenWithOld=setup([{id:1,url:page(62),status:'complete',active:true,windowId:1}],
    'https://evil.example.test/');
  await forbiddenWithOld.test.autoConnect();
  assert.equal(forbiddenWithOld.get().created,0);
  assert.equal(forbiddenWithOld.get().hello,0,'invalid startup URL must NOT fall back to old tab');

  // A new Python process must force unpacked extension code + changed
  // provider permissions to load once, BEFORE it creates or selects any tab.
  const nonce='a'.repeat(32);
  const cold=setup([],page(62),{},nonce);
  await cold.test.autoConnect();
  assert.equal(cold.get().reloaded,1,'refresh extension on first run');
  assert.equal(cold.get().created,0,'never start a chapter using a stale manifest');
  assert.equal(cold.get().hello,0,'never pair the stale background worker');
  assert.equal(cold.get().storageState.comicBridgeRefreshedStartupNonce,nonce);
  await cold.test.autoConnect();
  assert.equal(cold.get().reloaded,1,'same run never reloads twice');
  assert.equal(cold.get().created,1);
  assert.equal(cold.get().hello,1);
  const retired=setup([],page(62),{comicBridgeRefreshedStartupNonce:nonce,comicBridgeRetiredStartupNonce:nonce},nonce);
  await retired.test.autoConnect();
  assert.equal(retired.get().created,0,'released session cannot reopen its reader');
  assert.equal(retired.get().hello,0);
  const invalid=setup([],page(62),{},'not-a-valid-nonce');
  await invalid.test.autoConnect();
  assert.equal(invalid.get().created,0,'bad session nonce must not open a chapter');
  console.log('PASS extension-owned tab creation ignores older matching tabs + exact resume URL + silent pairing + cross-site rejection');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
