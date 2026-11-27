import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {archiveJourneyEvents,journeyRoute} from '../reusable/worker_addon/journey_worker.mjs';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');let calls=0,failBatch=false;
 const db={async exec(s){calls++;sql.exec(s)},prepare(q){return {args:[],bind(...args){this.args=args;return this},async all(){calls++;return {results:sql.prepare(q).all(...this.args)}},async run(){calls++;const r=sql.prepare(q).run(...this.args);return {meta:{changes:r.changes}}}}},async batch(qs){calls++;sql.exec('BEGIN');try{const result=[];for(const q of qs)result.push(await q.run());if(failBatch)throw Error('injected transaction failure');sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={JOURNEY_DB:db,ASSETS:{fetch:async()=>Response.json({chapters:[{id:'ch1',images:[{url:'x'}]}]})}};
 const call=(path,allowed=true,remote)=>journeyRoute(new Request('https://test.example'+path),env,async()=>allowed,remote);
 const table=n=>sql.prepare('SELECT COUNT(*) AS n FROM '+n).get().n;
 const init=()=>call('/api/journey/periods');
 const add=(n,ts='2026-11-25T00:00:00.000Z',ip='192.0.2.1')=>{const id='fixture-'+n;sql.prepare('INSERT INTO journey_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ts,'chapter_read','/comics/comic-a/','comic-a','ch1',ip,'Test City','Texas','US','America/Chicago','DFW');sql.prepare('INSERT INTO journey_event_locations VALUES (?,?,?)').run(id,30,-97);};
 return {sql,db,env,call,init,add,table,calls:()=>calls,fail:v=>{failBatch=v}};
}
const now=Date.parse('2026-11-27T04:00:00Z');
const newRemote=()=>{const files=new Map();let reads=0,writes=0,opens=0,mode='',onWrite=null;return {files,set mode(v){mode=v},set onWrite(v){onWrite=v},counts:()=>({reads,writes,opens}),factory:async()=>{opens++;return {read:async path=>{reads++;if(mode==='readError')throw Error('rate limited');if(mode==='corrupt'&&files.has(path))return new TextEncoder().encode('corrupt');return files.get(path)||null},write:async(path,bytes)=>{writes++;if(mode==='writeError')throw Error('forbidden');assert(!files.has(path));files.set(path,bytes);if(onWrite)onWrite();if(mode==='lost')throw Error('connection lost after commit')}}}}};
{
 const f=fixture(),r=newRemote();assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,0);assert.equal(f.calls(),1);assert.deepEqual(r.counts(),{reads:0,writes:0,opens:0});await f.init();const before=f.calls();assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,0);assert.equal(f.calls()-before,1);f.sql.close();
}
{
 const f=fixture(),r=newRemote();await f.init();for(let i=0;i<507;i++)f.add(i,undefined,i<250?'192.0.2.1':'192.0.2.2');f.sql.prepare("INSERT INTO journey_totals VALUES ('2026-11-25','chapter_read','comic-a','ch1','Test City','Texas','US',507)").run();f.sql.exec('CREATE TABLE manual_comics_v1(id TEXT); INSERT INTO manual_comics_v1 VALUES (\'unchanged\')');r.onWrite=()=>{r.onWrite=null;f.add('new','2026-11-27T04:01:00.000Z')};
 assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,507);assert.equal(r.counts().writes,2);assert.equal(f.table('journey_events'),1);assert.equal(f.table('journey_event_locations'),1);assert.equal(f.table('journey_archive_index'),2);assert.equal(f.table('journey_archive_pending'),0);assert.equal(f.table('manual_comics_v1'),1);assert.equal(f.sql.prepare('SELECT SUM(count) n FROM journey_totals').get().n,507);
 const list=await(await f.call('/api/journey/archives',true,r.factory)).json();assert.equal(list.batches.length,2);assert.equal(list.batches.reduce((a,b)=>a+b.event_count,0),507);const b=list.batches.find(b=>b.event_count===500);const query='&archive='+b.digest;const p=await(await f.call('/api/journey/periods?offset=0'+query,true,r.factory)).json();assert.deepEqual(p.periods.map(x=>x.actions),[250,250]);const e=await(await f.call('/api/journey/period-events?period=1'+query,true,r.factory)).json();assert.equal(e.events.length,200);assert.equal(e.next_offset,200);assert.equal(e.events[0].latitude,30);assert.equal(e.events[0].timezone,'America/Chicago');assert.equal((await(await f.call('/api/journey/period-events?period=1&offset=200'+query,true,r.factory)).json()).events.length,50);
 for(const path of ['/api/journey/archives','/api/journey/periods?offset=0'+query,'/api/journey/period-events?period=1'+query])assert.equal((await f.call(path,false,r.factory)).status,401);
 assert.equal((await f.call('/api/journey/periods?archive=../secret',true,r.factory)).status,400);const old=r.counts().opens;assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,0);assert.equal(r.counts().opens,old);f.sql.close();
}
for(const mode of ['writeError','readError','corrupt']){
 const f=fixture(),r=newRemote();await f.init();f.add(1);r.mode=mode;await assert.rejects(archiveJourneyEvents(f.env,r.factory,now));assert.equal(f.table('journey_events'),1);assert.equal(f.table('journey_event_locations'),1);assert.equal(f.table('journey_archive_pending'),1);assert.equal(f.table('journey_archive_index'),0);r.mode='';assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,1);assert.equal(f.table('journey_events'),0);assert.equal(r.files.size,1);f.sql.close();
}
{
 const f=fixture(),r=newRemote();await f.init();f.add(1);r.mode='lost';assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,1);assert.equal(r.counts().writes,1);f.sql.close();
}
{
 const f=fixture(),r=newRemote();await f.init();f.add(1);f.fail(true);await assert.rejects(archiveJourneyEvents(f.env,r.factory,now));assert.equal(f.table('journey_events'),1);assert.equal(f.table('journey_event_locations'),1);assert.equal(f.table('journey_archive_index'),0);assert.equal(f.table('journey_archive_pending'),1);assert.equal(r.files.size,1);f.fail(false);assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,1);assert.equal(r.counts().writes,1);f.sql.close();
}
{
 const f=fixture(),r=newRemote();await f.init();for(let i=0;i<2001;i++)f.add(i);assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,2000);assert.equal(f.table('journey_events'),1);assert.equal((await archiveJourneyEvents(f.env,r.factory,now)).archived,1);assert.equal(r.files.size,5);f.sql.close();
}
{
 const f=fixture();await f.init();const before=f.calls();await worker.scheduled({scheduledTime:now},f.env,{});assert.equal(f.calls()-before,1);f.sql.close();
}
console.log('PASS nightly empty path, multi-batch archival, exact readback, lost commit response, rate limit/403, tampered bytes, atomic D1 rollback, late visits, geo/history pagination, authentication, backlog and scheduled integration');
