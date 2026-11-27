import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const {DirectUpload,limited,resourceError}=await import('data:text/javascript;base64,'+readFileSync(new URL('../reusable/manual_direct_upload.js',import.meta.url)).toString('base64'));
const store=new Map(), indexCounts=[], sizes=[], events=[];
let now=Date.UTC(2026,10,27,23,59,0), calls=0;
const report=x=>events.push(x), pause=async ms=>{now+=ms;}, clock=()=>now;
const slug='import-'+'a'.repeat(32),u=new DirectUpload({slug,revision:0,owner:'owner',writeInterval:0,clock,pause,report,packLimit:1000});
u.access=async()=>{u.volume=997;return {};};
u.git=async(method,path,body)=>{if(method==='PUT'){const bytes=Buffer.from(body.content,'base64');if(path.startsWith('packs/')){sizes.push(bytes.length);if(bytes.length>250)return Response.json({message:'payload too large'},{status:413});}store.set(path,bytes);return new Response(null,{status:201});}return store.has(path)?new Response(store.get(path)):new Response(null,{status:404});};
u.site=async(_path,body)=>{const bytes=store.get('indexes/'+body.index+'.json');const idx=JSON.parse(bytes);indexCounts.push(idx.pages.length);if(idx.pages.length>3){ // explicit API 413, use actual site error parser
 const orig=globalThis.fetch;globalThis.fetch=async()=>Response.json({error:'Batch exceeds Worker resource limit; reduce batch size'},{status:413});try{return await DirectUpload.prototype.site.call(u,'index',body);}finally{globalThis.fetch=orig;}
 }return {ok:true};};
for(let i=0;i<8;i++){const bytes=new Uint8Array(100).fill(i+1);await u.add({blob:new Blob([bytes]),format:'png',width:1,height:1});}
await u.register();assert.equal(u.pending.size,0);assert.equal(sizes[0],800);assert.ok(sizes.some(x=>x<=250));assert.ok(indexCounts.some(x=>x>3));assert.ok(indexCounts.some(x=>x<=3));assert.equal(u.known.size,8);assert.equal([...u.known.values()].every(x=>x.pack&&x.packSize<=250),true);
let n=0;const res=await limited(async()=>++n===1?Response.json({error:'Cloudflare daily quota reached'},{status:503}):new Response('ok'),report,{pause,clock});assert.equal(res.status,200);assert.ok(now>=Date.UTC(2026,10,28,0,0,0));
let retries=0;const denied=await limited(async()=>{retries++;return new Response('permission denied',{status:403});},report,{pause,clock});assert.equal(denied.status,403);assert.equal(retries,1);assert.equal(resourceError(422,'invalid owner'),false);
console.log('PASS: explicit GitHub 413 scales byte packs, Worker resource rejection splits complete-pack indexes, daily quota waits to midnight, permanent 403 never retried.');
