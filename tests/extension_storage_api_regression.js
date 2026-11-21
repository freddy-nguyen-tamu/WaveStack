// Regression for Chromium/Firefox WebExtension API "Illegal invocation".
// Exercise the real background script using context-sensitive mock browser APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(process.argv[2] || path.resolve(__dirname, '../reusable/browser_bridge_extension/background.js'));
const source = fs.readFileSync(sourcePath, 'utf8');

async function simulate({storageFailure=false} = {}) {
  const expectedUrl = 'https://www.toongod.org/webtoon/annoying-alice/chapter-1/';
  const uploads = [];
  const errors = [];
  let messageListener;
  let fetchNext = 0;
  let setCount = 0;

  const storageArea = {
    set(data, callback) {
      if (this !== storageArea) throw new TypeError('Illegal invocation: StorageArea.set');
      setCount++;
      if (storageFailure) throw new Error('Quota exceeded');
      assert.equal(data.lastPort,18765);
      callback();
    },
    get(keys, callback) {
      if (this !== storageArea) throw new TypeError('Illegal invocation: StorageArea.get');
      callback({});
    }
  };
  const tabs = {
    get(id, callback) {
      if (this !== tabs) throw new TypeError('Illegal invocation: tabs.get');
      assert.equal(id, 7);
      callback({id:7, url:expectedUrl});
    },
    update(id, changes, callback) {
      if (this !== tabs) throw new TypeError('Illegal invocation: tabs.update');
      callback({id, url:changes.url});
    },
    sendMessage(id, payload, callback) {
      if (this !== tabs) throw new TypeError('Illegal invocation: tabs.sendMessage');
      if (payload.type === 'PAGE') callback({url:expectedUrl, html:'<html>fixture</html>'});
      else if (payload.type === 'PING') callback({ok:true, url:expectedUrl});
      else throw new Error('Unexpected action '+payload.type);
    }
  };
  const runtime = {
    lastError: null,
    onMessage: {addListener:listener=>messageListener=listener},
    getManifest() {return {content_scripts:[{matches:['https://www.toongod.org/*']}]};},
    getPlatformInfo(callback) {
      if (this !== runtime) throw new TypeError('Illegal invocation: runtime.getPlatformInfo');
      callback({os:'win'});
    }
  };
  const chrome = {tabs, storage:{local:storageArea}, runtime};
  const context = {chrome, URL, Blob, console:{warn:(...parts)=>errors.push(parts.join(' ')),debug:()=>{}},
    setTimeout:(fn, ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},
    clearTimeout, fetch:async (url, options) => {
      const p=new URL(url).pathname;
      assert.equal(options.headers['X-Comic-Bridge-Token'],'abcdefghijklmnopqrstuvwxyz123');
      if (p === '/hello') return {ok:true,json:async()=>({ok:true})};
      if (p === '/next') {
        fetchNext++;
        return {ok:true,json:async()=>({command:fetchNext===1 ? {id:'j1',action:'page'} : null})};
      }
      if (p === '/result') {
        const obj=JSON.parse(options.body);
        uploads.push(obj);
        return {ok:true,json:async()=>({ok:true})};
      }
      throw new Error('Unexpected endpoint '+p);
    }};
  vm.runInNewContext(source,context,{filename:sourcePath});
  assert.equal(typeof messageListener, 'function');
  const response=await new Promise(resolve=>messageListener({type:'CONNECT', tabId:7, port:18765,
    token:'abcdefghijklmnopqrstuvwxyz123'}, {}, resolve));
  assert.equal(response.ok,true,JSON.stringify(response));
  const until=Date.now()+1200;
  while(uploads.length===0 && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(setCount,1);
  assert.equal(uploads.length,1,`Expected command loop to run; got ${JSON.stringify(uploads)}`);
  assert.equal(uploads[0].ok,true);
  assert.equal(uploads[0].data.html,'<html>fixture</html>');
  if (storageFailure) assert(errors.some(s=>s.includes('unable to remember port')));
  else assert.equal(errors.length,0, JSON.stringify(errors));
}

(async()=>{
  await simulate({storageFailure:false});
  await simulate({storageFailure:true});
  console.log('PASS: extension connects and processes browser requests with owner-bound API methods');
  console.log('PASS: storage persistence failure cannot strand the already-paired Python server');
})().catch(e=>{console.error(e);process.exitCode=1;});
