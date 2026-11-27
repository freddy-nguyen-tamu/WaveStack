import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('../reusable/open_reader_journey_ui.py',import.meta.url),'utf8');
const from=src.indexOf('function newTimelineCursor()'),to=src.indexOf('function updatePaging()',from);
const sandbox=vm.createContext({structuredClone});vm.runInContext(src.slice(from,to)+'\nthis.api={newTimelineCursor,nextTimelinePage,timelineMore};',sandbox);
const {newTimelineCursor,nextTimelinePage,timelineMore}=sandbox.api;
const a='a'.repeat(64),b='b'.repeat(64);let requests=[];
const record=(id)=>({period_id:id,ip:'192.0.2.1',start_at:'2026-11-27T00:00:00Z',end_at:'2026-11-27T00:00:00Z'});
const reader=async path=>{requests.push(path);const u=new URL(path,'https://example.test');const offset=Number(u.searchParams.get('offset'));if(u.pathname.endsWith('/archives')){assert.equal(u.searchParams.get('snapshot'),'2');return {batches:[{digest:a},{digest:b}],next_offset:null,snapshot:2};}if(!u.searchParams.has('archive'))return {periods:[record(999)],snapshot:999,archive_epoch:2,next_offset:null};if(u.searchParams.get('archive')===a)return {periods:Array.from({length:250},(_,i)=>record(500-i)),snapshot:500,next_offset:offset===0?250:null};return {periods:[record(1)],snapshot:1,next_offset:null};};
let p=await nextTimelinePage(newTimelineCursor(),reader);assert.equal(p.periods.length,250);assert.equal(p.periods[0].sourceArchive,'');assert.equal(p.periods[0].sourceEpoch,2);assert.equal(p.periods[1].sourceArchive,a);assert.equal(requests.length,3);assert(timelineMore(p.cursor));
const p2=await nextTimelinePage(p.cursor,reader);assert.equal(p2.periods.length,250);assert.equal(p2.periods[0].sourceArchive,a);assert.equal(p2.periods[0].period_id,251);assert(timelineMore(p2.cursor));
const p3=await nextTimelinePage(p2.cursor,reader);assert.equal(p3.periods.at(-1).sourceArchive,b);assert(!timelineMore(p3.cursor));
// Zero pending rows must automatically traverse the GitHub index.
const only=await nextTimelinePage(newTimelineCursor(),async path=>path.includes('/archives')?{batches:[{digest:a}],snapshot:2,next_offset:null}:path.includes('archive=')?{periods:[record(1)],snapshot:1,next_offset:null}:{periods:[],snapshot:0,archive_epoch:2,next_offset:null});assert.equal(only.periods[0].sourceArchive,a);assert(!timelineMore(only.cursor));
// No records and no archive: zero content fetches.
const empty=await nextTimelinePage(newTimelineCursor(),async path=>path.includes('/archives')?{batches:[],snapshot:0,next_offset:null}:{periods:[],snapshot:0,archive_epoch:0,next_offset:null});assert.equal(empty.periods.length,0);assert(!timelineMore(empty.cursor));
// An archive failure does not hide the recent records or discard its cursor.
const failed=await nextTimelinePage(newTimelineCursor(),async path=>{if(path.includes('/archives'))return {batches:[{digest:a}],snapshot:2,next_offset:null};if(path.includes('archive='))throw Error('temporary GitHub failure');return {periods:[record(1)],snapshot:1,archive_epoch:2,next_offset:null};});assert.equal(failed.periods.length,1);assert.match(failed.warning,/temporary/);assert.equal(failed.cursor.archives[0],a);
assert(!src.includes('archive-select'));assert(src.includes('snapshot:p.sourceSnapshot,archive:p.sourceArchive'));console.log('PASS unified history cursor, recent/archive transition, archived-only, empty, bounded lazy pages and failed remote retry');
