'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
async function scenario({needsInjection=false}={}) {
  const chapter=n=>`https://reader.example.test/webtoon/sample/chapter-${n}/`;
  const grant='https://reader.example.test/webtoon/sample/*';
  let url=chapter(1),loading=false,receiverAlive=false;
  let scriptInjected=0,directExecuted=0, bootstrap=0,hello=0, reloads=0;
  const updatedListeners=new Set();
  let tabId=7,alarmReady=false;
  const inbox=[];
  let shutDown=false;
  const manifest={version:'1.5.14',host_permissions:[grant,'https://images.example.test/*'],content_scripts:[{matches:[grant]}]};
  const storage={local:{get(_keys,cb){cb({});},set(_data,cb){cb();}}};
  const chrome={
    runtime:{id:'comic-bridge-test-client',lastError:null,getManifest:()=>manifest,onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
    storage,
    alarms:{create(name,o){assert.equal(name,'comic-bridge-autoconnect');alarmReady=true;},onAlarm:{addListener:()=>{}}},
    tabs:{
      onUpdated:{addListener(fn){updatedListeners.add(fn);},removeListener(fn){updatedListeners.delete(fn);}},
      reload(id,opts,cb){
        assert.equal(id,tabId);assert.equal(opts.bypassCache,false);reloads++;
        setTimeout(()=>{loading=true; for(const fn of updatedListeners)fn(tabId,{status:'loading'});
          setTimeout(()=>{loading=false;for(const fn of updatedListeners)fn(tabId,{status:'complete'});},8);},5);
        cb();
      },
      get(id,cb){assert.equal(id,tabId);cb({id,url,status:loading?'loading':'complete',active:true,windowId:1});},
      query(_x,cb){cb([{id:tabId,url,status:'complete',active:true}]);},
      update(_id,change,cb){url=change.url;loading=true;receiverAlive=false;cb({id:tabId,url,status:'loading'});
        setTimeout(()=>{loading=false;},30);},
      sendMessage(){throw Error('Could not establish connection. Receiving end does not exist.');},
    },
    scripting:{async executeScript({target,files,func,args}){
      assert.equal(target.tabId,tabId);
      if(files){assert.deepEqual(Array.from(files),['content.js']);scriptInjected++;return [];}
      directExecuted++;
      // Simulates a freshly navigated document whose content handler has not loaded.
      if(needsInjection && scriptInjected===0)
        return [{result:{__bridgeError:'Page command transport not initialized'}}];
      // Simulates current document isolated-world dispatch; has NO message receiver.
      const command=args[0];
      let data;
      if(command.type==='PING') data={ok:true,url,bridgeContentProtocol:6};
      else if(command.type==='SNAPSHOT') data={imgs:[],total:0,url};
      else if(command.type==='PAGE') data={url,html:'<html></html>'};
      else data={ok:true,url};
      return [{result:data}];
    }}
  };
  const fetch=async (target,options={})=>{
    if(target.endsWith('/bootstrap')){
      assert.equal(options.headers['X-Comic-Bridge-Bootstrap'],'1');
      assert.equal(options.headers['X-Comic-Bridge-Client'],chrome.runtime.id);
      bootstrap++;
      return {ok:true,json:async()=>({token:'abc_123456789012345678901234',port:18765,site:'reader.example.test',protocol:'visual-transfer-2'})};
    }
    if(target.endsWith('/hello')){
      assert.equal(options.headers['X-Comic-Bridge-Client'],chrome.runtime.id);
      hello++;
      const obj=JSON.parse(options.body);
      assert.equal(obj.url,url);
      return {ok:true,json:async()=>({ok:true})};
    }
    if(target.endsWith('/next')) return {ok:true,json:async()=>({command:null})};
    if(target.endsWith('/result')) return {ok:true,json:async()=>({ok:true})};
    throw Error('unexpected fetch '+target);
  };
  const sandbox={chrome,fetch,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,
    setTimeout,clearTimeout,OffscreenCanvas:function(){},Uint8Array,Blob};
  vm.createContext(sandbox);
  vm.runInContext(src+`\nglobalThis.__testBridge={autoConnect,execute,stop(){state=null;},getState(){return state;}};`,sandbox);
  await sandbox.__testBridge.autoConnect();
  assert.equal(hello,1,'no popup / code: auto /hello from background');
  assert.equal(bootstrap,1);
  assert.ok(sandbox.__testBridge.getState()?.token);
  assert.ok(alarmReady);
  for(let n=2;n<=4;n++){
    let next=await sandbox.__testBridge.execute({action:'navigate',payload:{url:chapter(n)}});
    assert.equal(next.url,chapter(n));
    const snapshot=await sandbox.__testBridge.execute({action:'snapshot',payload:{reader_selectors:['.reading-content']}});
    assert.equal(snapshot.url,chapter(n),'must execute against NEW document');
  }
  const same=await sandbox.__testBridge.execute({action:'navigate',payload:{url:chapter(4)}});
  assert.equal(same.url,chapter(4));
  assert.equal(reloads,1,'same-URL navigation must do a real reload');
  assert.ok(directExecuted>=6, 'one direct command per navigation and snapshot');
  assert.equal(scriptInjected,needsInjection ? 1 : 0,
    'inject once only when a new document lacks the handler; never on every chapter');
  sandbox.__testBridge.stop();
  return {bootstrap,hello,scriptInjected,directExecuted};
}
(async()=>{
  const warm=await scenario({needsInjection:false});
  const cold=await scenario({needsInjection:true});
  console.log('PASS persistent zero-code pairing, 3 next-chapter navigations, no redundant injections, one cold-start injection', {warm,cold});
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
