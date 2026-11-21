'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js');
const raw=fs.readFileSync(file,'utf8');
const chapter='https://reader.example.test/comics/sample/chapter/83/';
function setup(owned) {
  let created=0, closed=[], calls=[], messages=0;
  const storage={comicBridgeManagedTabId:owned?7:99,comicBridgeManagedSite:'reader.example.test'};
  const tabs={
    get(id,cb){cb({id,url:chapter,status:'complete',active:true});},
    sendMessage(id,msg,cb){messages++; /* intentionally no callback: stalled */},
    create(conf,cb){assert.equal(conf.url,chapter);created++;cb({id:20,url:conf.url});},
    remove(id,cb){closed.push(id);cb();},
    query(filter,cb){cb([]);}
  };
  const chrome={tabs,scripting:{},runtime:{id:'123456789',lastError:null,
    getManifest(){return {content_scripts:[{matches:['https://reader.example.test/*']}]};},
    onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
    storage:{local:{get(keys,cb){cb({...storage});},set(data,cb){Object.assign(storage,data);cb();}}},
    alarms:{create(){},onAlarm:{addListener(){}}}
  };
  const src=raw.replace('setTimeout(()=>autoConnect(),200);','// autoConnect disabled in regression')
    .replace('const BROWSER_IO_STALL_MS = 18000;','const BROWSER_IO_STALL_MS = 35;');
  const env={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,Uint8Array,Blob};
  vm.createContext(env);
  vm.runInContext(src + `\nstate={tabId:7,port:18765,token:'TOKEN'};
    waitContent=async()=>({ok:true,url:${JSON.stringify(chapter)}});
    api=async(path,payload)=>{globalThis.__apiEvents.push({path,payload});return {ok:true};};
    globalThis.__apiEvents=[];
    globalThis.__test={execute,read:()=>({tab:state.tabId})};`,env);
  return {env,read:()=>({created,closed,messages,storage,apiEvents:env.__apiEvents})};
}
(async()=>{
  const t=setup(true);
  const result=await t.env.__test.execute({action:'scroll'});
  assert.equal(result.transport_reset,true);
  assert.equal(result.tab_id,20);
  assert.equal(t.env.__test.read().tab,20);
  const d=t.read();
  assert.equal(d.created,1,'one new managed tab');
  assert.deepEqual(d.closed,[7],'old managed tab closed only after new one ready');
  assert.equal(d.messages,1,'NON-IDEMPOTENT SCROLL MUST NOT BE SENT TWICE');
  assert.equal(d.storage.comicBridgeManagedTabId,20);
  assert.equal(d.apiEvents.filter(x=>x.path==='/hello').length,1);
  assert.equal(d.apiEvents.find(x=>x.path==='/hello').payload.tab_id,20);

  const unsafe=setup(false);
  await assert.rejects(unsafe.env.__test.execute({action:'scroll'}), /not owned by Comic Bridge/);
  assert.equal(unsafe.read().created,0);
  assert.equal(unsafe.env.__test.read().tab,7);
  console.log('PASS non-idempotent scroll recycled safely, ownership enforced, Python rebound, no double scroll');
})().catch(error=>{console.error(error);process.exit(1)});
