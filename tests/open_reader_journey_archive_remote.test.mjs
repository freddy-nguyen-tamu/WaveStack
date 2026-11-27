import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {journeyArchiveRemote} from '../reusable/worker_addon/panel_replacement_worker.mjs';
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const env={GITHUB_OWNER:'test-owner',GITHUB_APP_ID:'100',GITHUB_APP_INSTALLATION_ID:'101',GITHUB_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}).toString()};
let privateRepo=true,missing=false,writes=0,files=new Map(),calls=[];
globalThis.fetch=async(url,opts={})=>{calls.push([url,opts.method]);
 if(url.includes('/app/installations/101/access_tokens'))return Response.json({token:'secret-test-installation-token',expires_at:new Date(Date.now()+3600000).toISOString()});
 assert.equal(opts.headers.Authorization,'Bearer secret-test-installation-token');
 const root='https://api.github.com/repos/test-owner/open-reader-journey-history';
 assert(url.startsWith(root));
 if(url===root)return missing?new Response('',{status:403}):Response.json({private:privateRepo,name:'open-reader-journey-history',owner:{login:'test-owner'},default_branch:'main',archived:false});
 const path=url.slice(root.length+10).split('?')[0];
 if(opts.method==='PUT'){writes++;const data=JSON.parse(opts.body);assert.equal(data.branch,'main');assert(!data.sha);files.set(path,Buffer.from(data.content,'base64'));return Response.json({content:{path}},{status:201});}
 const value=files.get(path);return value?new Response(value,{headers:{'Content-Type':'application/json'}}):new Response('',{status:404});
};
const path='events/2026/11/2026-11-26/'+'a'.repeat(64)+'.json';
let remote=await journeyArchiveRemote(env);assert.equal(await remote.read(path),null);const b=new TextEncoder().encode('{"schema":"fixture"}');await remote.write(path,b);assert.deepEqual(await remote.read(path),b);assert.equal(writes,1);await assert.rejects(remote.read('../secret'));await assert.rejects(remote.write('other/path',b));
privateRepo=false;await assert.rejects(journeyArchiveRemote(env),/private/);assert.equal(writes,1);missing=true;await assert.rejects(journeyArchiveRemote(env),/403/);assert.equal(writes,1);assert(calls.every(([url])=>url.includes('/app/installations/')||url.includes('/repos/test-owner/open-reader-journey-history')));console.log('PASS private repository enforcement, fixed archive namespace, server-side auth, write and independent readback, 403 refusal');
