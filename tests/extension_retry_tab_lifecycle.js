'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const site='reader.example.test',url=`https://${site}/chapter/21/`,old='a'.repeat(32),fresh='b'.repeat(32),wake='about:blank#comicarchiver-'+fresh;
function setup(initial,stored){
 const tabs=initial.map(x=>({...x})), storage={...stored}, events=[];
 const chrome={runtime:{id:'test',lastError:null,getManifest:()=>({host_permissions:[`https://${site}/*`],content_scripts:[{matches:[`https://${site}/*`]}]}),onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},tabs:{get(id,cb){cb(tabs.find(t=>t.id===id));},query(q,cb){cb([...tabs]);},remove(id,cb){events.push(['remove',id]);const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1);cb();},update(id,v,cb){events.push(['update',id]);const t=tabs.find(t=>t.id===id);Object.assign(t,v);cb(t);},create(v,cb){events.push(['create',100]);const t={id:100,...v};tabs.push(t);cb(t);}},storage:{local:{get(k,cb){cb({...storage});},set(v,cb){Object.assign(storage,v);cb();}}},alarms:{create(){},onAlarm:{addListener(){}}},debugger:{detach(t,cb){events.push(['detach',t.tabId]);cb();}}};
 const box={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob};vm.createContext(box);vm.runInContext(src.replace('setTimeout(()=>autoConnect(),200);','// unit test')+`\nglobalThis.pick=pickComicTab;globalThis.release=releaseOwnedReader;globalThis.exec=execute;globalThis.setSession=s=>{state=s;inspectedTabId=s.tabId;inspectedReady=true};`,box);
 return {box,tabs,storage,events};
}
const owner={comicBridgeManagedTabId:7,comicBridgeManagedSite:site,comicBridgeManagedNonce:old};
const session={tabId:7,managedSite:site,managedNonce:old};
(async()=>{
 const a=setup([{id:7,url},{id:8,url:wake,active:true},{id:9,url:'about:blank'},{id:10,url:'about:blank',openerTabId:7},{id:11,url},{id:12,url:'https://unrelated.test/'}],owner);
 const next=await a.box.pick(site,url,fresh);
 assert.equal(next.id,8);assert.equal(next.url,url);assert.deepEqual(a.events,[['update',8],['remove',10],['remove',7]]);assert.deepEqual(a.tabs.map(t=>t.id),[8,9,11,12]);assert.equal(a.storage.comicBridgeManagedNonce,fresh);
 const b=setup([{id:7,url},{id:8,url:wake},{id:9,url:'about:blank'},{id:10,url:'about:blank',openerTabId:7},{id:11,url}],owner);
 b.box.setSession(session);
 const receipt=await b.box.exec({action:'release_managed_reader'});assert.equal(receipt.closed,true);assert.deepEqual(b.events,[['remove',8],['remove',10],['detach',7],['remove',7]]);assert.deepEqual(b.tabs.map(t=>t.id),[9,11]);assert.equal(b.storage.comicBridgeManagedTabId,null);assert.equal(b.storage.comicBridgeRetiredStartupNonce,old);
 const c=setup([{id:7,url},{id:8,url:wake},{id:11,url},{id:12,url:'about:blank#comicarchiver-'+old}],owner);
 await c.box.release(session,false);assert.deepEqual(c.tabs.map(t=>t.id),[8,11]); // hard-crash cleanup must leave next attempt's marker
 const d=setup([{id:7,url},{id:8,url}],{...owner,comicBridgeManagedNonce:fresh});
 assert.equal((await d.box.release(session,true)).closed,false);assert.equal(d.events.length,0);
 const e=setup([{id:7,url},{id:11,url}],owner);assert.equal((await e.box.pick(site,url,fresh)).id,100);assert.deepEqual(e.events,[['create',100],['remove',7]]);
 const f=setup([{id:7,url:'https://unrelated.test/'},{id:11,url}],owner);assert.equal((await f.box.release(session,true)).closed,false);assert.equal(f.events.length,0);
 const g=setup([{id:7,url},{id:8,url:'about:blank#comicarchiver-'+old},{id:11,url}],owner);
 g.box.chrome.tabs.remove=(id,cb)=>{g.events.push(['refused-remove',id]);cb();};
 await assert.rejects(g.box.release(session,true),/Owned auxiliary tabs still open/);
 assert.equal(g.storage.comicBridgeManagedTabId,7,'retain ownership if cleanup fails');
 console.log('PASS fresh retry tab, wake-tab reuse, graceful/hard crash cleanup, stale session isolation, personal tabs preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
