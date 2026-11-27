import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const src=fs.readFileSync(new URL('../reusable/manual_import.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../reusable/manual_import.html',import.meta.url),'utf8');
assert.match(html,/option value="pdf-chapters"/);assert.match(html,/id="chapters-per-pdf"[^>]*value="1"/);
const controls=Object.fromEntries(Object.entries({'pages-per':'2','files-per':'2','pdf-width':'1800','image-limit':'0','group-mode':'pdf-chapters','pdf-mode':'separate','chapters-per-pdf':'3'}).map(([k,v])=>[k,{value:v}]));
controls.editor={scrollIntoView(){}};
const ctx=vm.createContext({location:{hostname:'127.0.0.1',port:'18766'},crypto:{randomUUID},document:{getElementById:k=>controls[k]},confirm:()=>true,URL:{revokeObjectURL(){}},console});
// Run the actual preparation and grouping code, replacing only browser I/O.
vm.runInContext(src.slice(0,src.indexOf("$('pick-files').onclick=")),ctx);
vm.runInContext(`let lastNotice='';notice=(msg)=>{lastNotice=msg};setBusy=v=>{busy=v};sourcePages=f=>f.pages||[f.name];`,ctx);
const run=s=>vm.runInContext(s,ctx),json=s=>JSON.parse(JSON.stringify(run(s)));
const sizes='works.map(w=>w.chapters.map(c=>c.pages.length))';
const ordered='works.map(w=>w.chapters.flatMap(c=>c.pages))';
const a={name:'A.pdf',type:'application/pdf',pages:Array.from({length:10},(_,i)=>'a'+i)};
const b={name:'B.pdf',type:'application/pdf',pages:Array.from({length:7},(_,i)=>'b'+i)};
const inputs=[a,b];ctx.inputs=inputs;
async function prepare(mode='separate',n='3',data=inputs){controls['pdf-mode'].value=mode;controls['chapters-per-pdf'].value=n;ctx.inputs=data;run('files=inputs.slice();works=[];editSlug=null');await run('prepare()');}
await prepare();assert.deepEqual(json(sizes),[[4,3,3],[3,2,2]]);assert.deepEqual(json(ordered),[a.pages,b.pages]);
await prepare('combined');assert.deepEqual(json(sizes),[[4,3,3,3,2,2]]);assert.deepEqual(json(ordered),[[...a.pages,...b.pages]]);assert.deepEqual(json('works[0].chapters.map(c=>c.number)'),['1','2','3','4','5','6']);
await prepare('separate','1');assert.deepEqual(json(sizes),[[10],[7]]);
await prepare('combined','10',[a]);assert.deepEqual(json(sizes),[Array(10).fill(1)]);
await prepare('combined','3',[{name:'x.png'},a,{name:'y.png'},{name:'z.png'},{name:'w.png'}]);assert.deepEqual(json(sizes),[[1,4,3,3,2,1]]);assert.deepEqual(json(ordered),[['x.png',...a.pages,'y.png','z.png','w.png']]);
await prepare('combined','11',[a]);assert.deepEqual(json(sizes),[]);assert.match(run('lastNotice'),/A.pdf: 10 pages cannot fill 11/);assert.equal(run('files.length'),1);
for(const value of ['0','1.5','2001','']){await prepare('combined',value,[a]);assert.deepEqual(json(sizes),[]);assert.match(run('lastNotice'),/Invalid value/);}
// Invalid split must leave the existing preview and selected files intact.
await prepare('separate','1',[a]);const old=json(ordered);controls['chapters-per-pdf'].value='11';ctx.inputs=[b];run('files=inputs.slice()');await run('prepare()');assert.deepEqual(json(ordered),old);assert.equal(run('files.length'),1);
// Append to an existing import; preserve existing chapter titles and order.
controls['chapters-per-pdf'].value='3';run("works[0].slug='import-fixture';works[0].chapters[0].title='Original';editSlug='import-fixture';files=inputs.slice()");await run('prepare()');assert.deepEqual(json(sizes),[[10,3,2,2]]);assert.deepEqual(json('works[0].chapters.map(c=>c.title)'),['Original','Chapter 2','Chapter 3','Chapter 4']);
// All original grouping modes stay unchanged and ignore the new count field.
for(const [mode,expected] of [['auto',[10,7]],['pages',[2,2,2,2,2,2,2,2,1]],['files',[17]],['single',[17]]]){controls['group-mode'].value=mode;await prepare('combined','bad');assert.deepEqual(json(sizes),[expected]);assert.deepEqual(json(ordered),[[...a.pages,...b.pages]]);}
console.log('PDF chapter count: PASS (separate, combined, 1, N=pages, mixed files, invalid counts, retained preview, append and four legacy modes)');
