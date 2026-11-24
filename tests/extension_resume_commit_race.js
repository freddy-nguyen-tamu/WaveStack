'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const site='reader.example.test';
const old=`https://${site}/comic/a/chapter-00/`;
const target=`https://${site}/comic/a/chapter-18/`;
const manifest={version:'1',content_scripts:[{matches:[`https://${site}/*`]}],host_permissions:[`https://${site}/*`]};
const tabs=[{id:10,url:old,status:'complete',active:true,windowId:1}];
let helloUrls=[];let storage={comicBridgeManagedTabId:10,comicBridgeManagedSite:site};
const events={addListener(){},removeListener(){}};
const chrome={runtime:{id:'test-extension',lastError:null,getManifest:()=>manifest,
      onStartup:events,onInstalled:events,onMessage:events},
  alarms:{create(){},onAlarm:events},
  storage:{local:{get(_keys,cb){cb({...storage});},set(updates,cb){Object.assign(storage,updates);cb();}}},
  tabs:{onActivated:events,onCreated:events,onUpdated:events,
    query(_x,cb){cb(tabs.map(t=>({...t})));},
    get(id,cb){cb(tabs.find(t=>t.id===id)||null);},
    update(id,changes,cb){const t=tabs.find(t=>t.id===id);const stale={...t};
       if(changes.url){t.status='loading';setTimeout(()=>{t.url=changes.url;t.status='complete';},60);}
       cb(stale);},
    sendMessage(id,msg,cb){const t=tabs.find(t=>t.id===id);
      if(msg.type==='PING')cb({ok:true,bridgeContentProtocol:6,url:t.url});else cb({ok:true});}},
  scripting:{async executeScript(){return [];}}
};
const fetch=async (url,opts)=>{
 if(url.endsWith('/bootstrap'))return {ok:true,json:async()=>({site,port:18765,
      token:'a_1234567890123456789012345678',protocol:'visual-transfer-2',startup_url:target})};
 if(url.endsWith('/hello')){helloUrls.push(JSON.parse(opts.body).url);return {ok:true,json:async()=>({ok:true})};}
 if(url.endsWith('/next'))return new Promise(()=>{});
 if(url.endsWith('/heartbeat'))return {ok:true,json:async()=>({ok:true})};
 throw Error(url);
};
const sandbox={chrome,fetch,URL,Set,Map,Promise,Date,JSON,Number,Math,Error,String,console,
  setTimeout(fn,ms){if([200,2500,5000].includes(ms))return 1;return setTimeout(fn,ms);},
  clearTimeout,Uint8Array,Blob,OffscreenCanvas:function(){}};
vm.createContext(sandbox);
vm.runInContext(src+'\nglobalThis.__test={autoConnect,getError(){return lastError;}};',sandbox);
(async()=>{
  await sandbox.__test.autoConnect();
  assert.equal(sandbox.__test.getError(),'');
  assert.equal(tabs[0].url,target);
  assert.ok(helloUrls.length>=1);
  assert.ok(helloUrls.every(url=>url===target),'never pair stale prologue before URL commit');
  console.log('PASS async tabs.update stale result cannot pair to old document before resume target');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
