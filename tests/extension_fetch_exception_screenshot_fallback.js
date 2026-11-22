// Generic extension fetch-exception fallback; zero source-specific logic.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'reusable/browser_bridge_extension/background.js'),'utf8');
const bgn=src.indexOf("  if (action === 'image') {");
const end=src.indexOf("  if(action==='image_diagnostics')",bgn);
assert.ok(bgn>=0 && end>bgn,'existing generic image handler exists');
const code='async function imageJob(job) { const {action,payload}=job;\n'
  + src.slice(bgn,end) + '\n}\nimageJob';
const url='https://reader.example.test/path/01.jpg';
const b64='T1JJR0lOQUwtQllURVM=';
async function run({fetchResult='success',loaded=true,captureFails=false,captureEnabled=true}={}) {
  let fetchCalls=0, screenshotCalls=0, statusCalls=0;
  const env={URL,Error,String,JSON,ArrayBuffer,
    capturedImages:new Map(), normalizeResourceUrl:u=>u,
    imagePermission:u=>u===url,
    requiresTabCapture:()=>false,
    captureDiagnostics:()=>({debuggerAttached:true}),
    state:{tabId:42},
    send:async(tab,msg)=>{assert.equal(tab,42);assert.equal(msg.type,'IMAGE_STATUS');
      assert.equal(msg.payload.url,url);statusCalls++;return {loaded};},
    captureVisibleImage:async u=>{assert.equal(u,url);screenshotCalls++;
      if(captureFails)throw Error('screenshot failed');
      return {base64:'UE5H',via:'rendered-png'};},
    toBase64:async b=>b64,
    fetch:async(u,opts)=>{fetchCalls++;assert.equal(u,url);
      assert.equal(opts.credentials,'include');assert.equal(opts.cache,'default');
      if(fetchResult==='reject')throw TypeError('Failed to fetch');
      return {ok:fetchResult==='success',url:u,status:fetchResult==='success'?200:403,
        headers:{get:()=>null},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};},
    lastError:'',console
  };
  const fn=vm.runInNewContext(code,env);
  const result=await fn({action:'image',payload:{url}});
  return {result,fetchCalls,screenshotCalls,statusCalls,env};
}
(async()=>{
  const original=await run();
  assert.equal(original.result.status,200);
  assert.equal(original.result.base64,b64,'valid original-byte response remains preferred');
  assert.equal(original.screenshotCalls,0);
  assert.equal(original.statusCalls,0);

  const cors=await run({fetchResult:'reject',loaded:true});
  assert.equal(cors.result.status,200,'CORS exception must not strand a decoded image');
  assert.equal(cors.result.via,'rendered-png','truthful pixel-fidelity label');
  assert.equal(cors.result.base64,'UE5H');
  assert.equal(cors.screenshotCalls,1);
  assert.equal(cors.statusCalls,1);
  assert.match(cors.result.diagnostics.originalFetchError,/Failed to fetch/);

  const missing=await run({fetchResult:'reject',loaded:false});
  assert.equal(missing.result.status,424,'never fabricate an image if DOM is not decoded');
  assert.equal(missing.screenshotCalls,0);

  const blockedCapture=await run({fetchResult:'reject',loaded:true,captureFails:true});
  assert.equal(blockedCapture.result.status,424);
  assert.match(blockedCapture.result.diagnostics.renderFallbackError,/screenshot failed/);

  const httpError=await run({fetchResult:'http403',loaded:true});
  assert.equal(httpError.result.status,200,'pre-existing HTTP-error fallback preserved');
  assert.equal(httpError.result.via,'rendered-png');
  assert.equal(httpError.screenshotCalls,1);

  assert.ok(src.includes("if (requiresTabCapture()) {"),'pre-existing CDN screenshot mode preserved');
  assert.ok(src.includes("if(payload?.type==='RECOVER_IMAGE' && chrome.scripting?.executeScript)"),
    'exact-image recovery not removed');
  for(const browser of ['chrome','firefox']) {
    assert.equal(fs.readFileSync(path.join(root,'browser_bridge',browser,'background.js'),'utf8'),src,
      'installed background matches canonical bridge code');
  }
  console.log('PASS: generic CORS exception, decoded PNG fallback, missing image safety, '
    +'failed screenshot safety, original-byte success, existing 403 behavior, mirror parity');
})().catch(error=>{console.error(error);process.exit(1)});
