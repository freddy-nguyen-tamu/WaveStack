'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const url='https://reader.example.test/chapter/9/', token='a'.repeat(32), digest='test';
const tab={id:7,url,status:'complete'}, entries=[],storage={}; let starts=0;
const items=Array.from({length:3},(_,i)=>({key:String(i+1),order:i+1,url:'https://images.example.test/'+i+'.jpg',filename:String(i+1).padStart(4,'0')+'.jpg'}));
const chrome={runtime:{id:'test',lastError:null,getManifest:()=>({host_permissions:['https://images.example.test/*'],content_scripts:[{matches:['https://reader.example.test/*']}]}),onStartup:{addListener(){}},onInstalled:{addListener(){}},onMessage:{addListener(){}}},tabs:{get(_id,cb){cb(tab);}},storage:{local:{get(key,cb){cb({[key]:storage[key]});},set(data,cb){Object.assign(storage,data);cb();}}},alarms:{create(){},onAlarm:{addListener(){}}},scripting:{executeScript:async ({files})=>files?[{}]:[{result:{digest,plan:{url,items,loaded:3}}}]},downloads:{download(opts,cb){starts++;entries.push({id:starts,url:opts.url,finalUrl:opts.url,filename:'/downloads/'+opts.filename,byExtensionId:'test',exists:true,state:'complete'});cb(starts);},search(q,cb){cb(entries.filter(x=>q.id!==undefined?x.id===q.id:x.url===q.url));}}};
const box={chrome,URL,Map,Set,Promise,Date,JSON,Number,Math,Error,String,console,setTimeout,clearTimeout,Uint8Array,Blob};vm.createContext(box);vm.runInContext(src.replace('setTimeout(()=>autoConnect(),200);','// unit test')+`\nstate={tabId:7};globalThis.exec=execute;`,box);
(async()=>{const exec=(action,payload)=>box.exec({action,payload});tab.status='loading';tab.pendingUrl=url;tab.url='https://reader.example.test/chapter/8/';
const caps=await exec('script_capabilities',{});assert.equal(caps.revision,'native-chapter-download-v2');assert.equal(caps.native,true);assert.equal(caps.loadedResource,false);
setTimeout(()=>{tab.url=url;tab.status='complete';delete tab.pendingUrl;},50);
await exec('script_plan',{url,digest});
tab.url='https://reader.example.test/chapter/8/';await assert.rejects(exec('script_plan',{url,digest}),/chapter document changed.*expected=.*chapter\/9.*actual=.*chapter\/8/);tab.url=url;
tab.pendingUrl='https://reader.example.test/chapter/10/';await assert.rejects(exec('script_plan',{url,digest}),/chapter document changed/);delete tab.pendingUrl;
await exec('script_plan',{url,digest});const payload={url,token,items,interval_ms:1000};await exec('script_download_start',payload);await exec('script_download_start',payload);assert.equal(starts,3);const rec=(await exec('script_download_status',payload)).receipts;assert.deepEqual(JSON.parse(JSON.stringify(rec.map(x=>x.filename))),items.map(x=>x.filename));assert.ok(rec.every(x=>x.state==='complete'));await assert.rejects(exec('script_download_start',{...payload,items:[{...items[0],filename:'0002.jpg'}]}),/differs/);// Chrome may report temporary or renamed actual paths, but the recorded ID
// and original URL stay fixed. Verify in-progress, same-directory rename,
// and external filename chosen by Chrome, without a second download.
entries[0].state='in_progress';entries[0].filename='/downloads/Unconfirmed 123.crdownload';
assert.equal((await exec('script_download_status',payload)).receipts[0].state,'in_progress');
entries[0].state='complete';entries[0].filename='/downloads/ComicArchiver-script/'+token+'/0001.webp';
let changed=(await exec('script_download_status',payload)).receipts[0];assert.equal(changed.filename,'0001.jpg');assert.equal(changed.id,1);assert.equal(changed.managed,true);assert.equal(changed.idBound,true);
entries[0].filename='/downloads/server-name.webp';changed=(await exec('script_download_status',payload)).receipts[0];assert.equal(changed.extensionOwned,true);assert.equal(changed.managed,false);assert.equal(changed.path,'/downloads/server-name.webp');
await exec('script_download_start',payload);assert.equal(starts,3);
entries[0].byExtensionId=undefined;await assert.rejects(exec('script_download_status',payload),/ownership uncertain/);
entries[0].byExtensionId='test';entries[0].finalUrl='https://images.example.test/wrong.jpg';await assert.rejects(exec('script_download_status',payload),/redirected/);
entries[0].finalUrl=items[0].url;
await assert.rejects(exec('script_plan',{url,digest:'wrong'}),/stale/);console.log('PASS native batch start, no duplicate on retry, receipt order, temporary filename, renamed receipt, owner and URL checks, stale script rejected');})().catch(e=>{console.error(e);process.exitCode=1});
