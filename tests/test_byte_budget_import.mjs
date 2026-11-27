import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash,webcrypto} from 'node:crypto';
import {manualRoute} from '../reusable/worker_addon/manual_import_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const {DirectUpload}=await import('data:text/javascript;base64,'+readFileSync(new URL('../reusable/manual_direct_upload.js',import.meta.url)).toString('base64'));
const sql=new DatabaseSync(':memory:');
const db={async exec(s){sql.exec(s)},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const st of stmts)out.push(await st.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}},prepare(s){return {args:[],bind(...a){this.args=a;return this},async first(){return sql.prepare(s).get(...this.args)||null},async all(){return {results:sql.prepare(s).all(...this.args)}},async run(){return {meta:{changes:Number(sql.prepare(s).run(...this.args).changes)}}}}}};
const origin='https://reader.example.test', slug='import-'+'a'.repeat(32), chapter='ch-'+'b'.repeat(32), endpoint='/api/manual-comics/'+slug, owner='owner';
const store=new Map(), writes=[], reads=[];let registered=0, remoteReads=0, reservations=0, failRegistration=true;
const shaHex=async b=>createHash('sha256').update(b).digest('hex');
const env={GITHUB_OWNER:owner,JOURNEY_DB:db,ASSETS:{fetch:async()=>new Response('',{status:404})}};
const deps={githubConfigured:()=>true,shaHex,browserImportToken:async(_e,repo)=>{reservations++;return {owner,repo,token:'scoped-fixture',branch:'main',expires_at:new Date(Date.now()+3600000).toISOString()}},
 githubFile:async(_e,repo,path)=>{remoteReads++;const body=store.get(repo+'/'+path);return body?{status:200,body}:{status:404}},
 importVolumeInventory:async(_e,repo)=>({status:200,branch:'main',files:new Map([...store].filter(([key])=>key.startsWith(repo+'/')).map(([key,v])=>[key.slice(repo.length+1),v.length])),blobs:new Map([...store].filter(([key])=>key.startsWith(repo+'/')).map(([key,v])=>[key.slice(repo.length+1),createHash('sha1').update(`blob ${v.length}\0`).update(v).digest('hex')]))})};
const call=(path,method='GET',body)=>manualRoute(new Request(origin+path,{method,headers:{Origin:origin},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,deps);
const metadata={title:'80 pages packed'};
assert.equal((await call(endpoint+'/local-init','POST',{owner,metadata,browser:true})).status,200);
const nativeFetch=globalThis.fetch;
try{
 globalThis.fetch=async(url,opts)=>{
  const str=String(url);if(str.startsWith('/')){
   if(str.endsWith('/local-index')&&failRegistration){failRegistration=false;return Response.json({error:'simulated registration pause'},{status:409});}
   const r=await call(str,opts.method,JSON.parse(opts.body));if(str.endsWith('/local-index')&&r.ok)registered++;return r;
  }
  if(str.endsWith('/installation/token'))return new Response(null,{status:204});
  const match=new URL(str).pathname.match(/^\/repos\/owner\/([^/]+)\/contents\/(.+)$/);assert.ok(match,str);
  const key=match[1]+'/'+match[2];assert.equal(opts.headers.Authorization,'Bearer scoped-fixture');
  if(opts.method==='PUT'){const b=JSON.parse(opts.body);assert.equal(b.branch,'main');writes.push(key);if(store.has(key))return new Response(null,{status:422});store.set(key,new Uint8Array(Buffer.from(b.content,'base64')));return new Response(null,{status:201});}
  assert.equal(new URL(str).searchParams.get('ref'),'main');reads.push(key);const b=store.get(key);return b?new Response(b):new Response(null,{status:404});
 };
 const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn6KKK7DkP/9k=','base64');
 const up=new DirectUpload({slug,revision:0,owner,writeInterval:0,pause:async()=>{}});
 // A valid JPEG with a distinct COM marker in every file.
 const wanted=[];for(let i=0;i<80;i++){const raw=new Uint8Array(Buffer.concat([jpeg.subarray(0,jpeg.length-2),Buffer.from([255,254,0,3,i]),jpeg.subarray(jpeg.length-2)]));wanted.push(raw);await up.add({blob:new Blob([raw]),format:'jpg',width:1,height:1});}
 await assert.rejects(up.register(),/simulated registration pause/);assert.equal(writes.length,2);assert.equal(reads.length,2);assert.equal(writes.filter(k=>k.includes('/packs/')).length,1);assert.equal(writes.filter(k=>k.includes('/pages/')).length,0);
 await up.register();assert.equal(writes.length,2);assert.equal(registered,1);assert.equal(reservations,1);
 const ids=await Promise.all(wanted.map(shaHex));
 const r=await call(endpoint,'PUT',{revision:0,metadata,chapters:[{id:chapter,number:'1',title:'Chapter 1',pages:ids}]});assert.equal(r.status,200,await r.text());
 remoteReads=0;
 // Sequential image requests share the hot verified pack. Concurrent calls
 // also coalesce within the isolate. Existing image URLs remain unchanged.
 for(let i=0;i<80;i++){const r=await call('/api/manual-image/'+slug+'/'+ids[i]);assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),wanted[i]);}
 assert.equal(remoteReads,1);
 const deleted=await call(endpoint,'DELETE',{revision:1,confirm:metadata.title});assert.equal(deleted.status,200);assert.equal((await call('/api/manual-image/'+slug+'/'+ids[0])).status,404);
 console.log('PASS: 80 pages, 1 pack PUT + 1 index PUT, 2 browser readbacks, registration retry without reupload, 1 upstream pack read, exact bytes and deleted access blocked.');
}finally{globalThis.fetch=nativeFetch;sql.close();}
