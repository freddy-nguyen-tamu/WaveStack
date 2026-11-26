
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.dataset={};this.attrs={};this.parentElement=null;
    this.parentNode=null;this.textContent='';this.hidden=true;this.value='';this.className='';this.isConnected=false;}
  append(...things){for(const o of things){if(o.tag==='fragment'){this.append(...[...o.children]);o.children=[];continue;}
    if(o.parentElement)o.parentElement.children=o.parentElement.children.filter(x=>x!==o);
    this.children.push(o);o.parentElement=this;o.parentNode=this;o.isConnected=this.isConnected;}}
  insertBefore(o,b){if(o.parentElement)o.parentElement.children=o.parentElement.children.filter(x=>x!==o);
    let idx=this.children.indexOf(b); if(idx<0)throw Error('no anchor');this.children.splice(idx,0,o);
    o.parentElement=this;o.parentNode=this;o.isConnected=true;}
  replaceChildren(...things){for(const c of this.children){c.parentElement=null;c.parentNode=null};this.children=[];this.append(...things)}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(x=>x!==this);
    this.parentElement=null;this.parentNode=null}}
  setAttribute(k,v){this.attrs[k]=v}getAttribute(k){return this.attrs[k]||null}
  removeAttribute(k){delete this.attrs[k]}
  addEventListener(){}insertBefore_(x){this.append(x)}
  getBoundingClientRect(){return {top:0}}
}
const targets=new Map();function elem(s){if(!targets.has(s))targets.set(s,new Element('div'));return targets.get(s)}
const requested=[],imgs=[],scheduled=[];let clock=1000;
const document={referrer:'',body:new Element('body'),documentElement:new Element('html'),
 createElement(type){const x=new Element(type);if(type==='img'){
   imgs.push(x);x.decode=async()=>{assert.equal(x.naturalWidth,10)};
   Object.defineProperty(x,'src',{set(v){this.source=v;this.attrs.src=v;requested.push(v);},get(){return this.source}});
 }return x;}, createDocumentFragment(){return new Element('fragment')},
 createElementNS(_,tag){return new Element(tag)},querySelector:elem,addEventListener(){}
};
document.documentElement.classList={add(){},remove(){}};document.scrollingElement={scrollHeight:1700};
const selected=process.argv[2],u=new URL('https://reader.test/comics/sample/?chapter='+selected);
const assigned=[],reloads=[],hist=[],events=[],handlers={};
const location={href:u.href,origin:u.origin,pathname:u.pathname,assign(v){assigned.push(v)},reload(){reloads.push(this.href)}};
const history={state:null,replaceState(v,_,url){this.state=v;location.href=url;hist.push(['replace',url,v])},pushState(v,_,url){this.state=v;location.href=url;hist.push(['push',url,v])}};
const storage={getItem(){return null},setItem(){},removeItem(){}};
const window={addEventListener(n,cb){(handlers[n]||=[]).push(cb)},dispatchEvent(e){events.push(e)},matchMedia(){return {matches:true}},PointerEvent:class{},scrollTo({top}){ctx.scrollY=top}};
const perf={now:()=>clock,getEntriesByType:()=>[]};
const img=n=>({url:'https://images.invalid/'+n+'.png',width:10,height:10});
const manifest={title:'Sample',chapters:[{id:'before',images:[img('prev')]},
 {id:'partial',images:[img('a'),{placeholder:true,panel:2,confirmed_missing:true},img('c')]},
 {id:'complete',images:[img('a'),img('b'),img('c')]}, {id:'after',images:[img('next'),img('next2'),img('next3')]}, {id:'last',images:[img('last')]}]};
const ctx={document,window,location,history,scrollY:0,innerHeight:700,localStorage:storage,sessionStorage:storage,performance:perf,
 MutationObserver:class{observe(){}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},URL,console,requestAnimationFrame:()=>1,clearTimeout:()=>{},
 setTimeout(fn,ms){scheduled.push({fn,ms});return scheduled.length},
 fetch:async()=>({ok:true,json:async()=>manifest})};
const nav=new Element('nav');nav.append(elem('#panel-series'));elem('#pages').isConnected=true;
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),ctx,{filename:'app.js'});
async function flush(){for(let i=0;i<40;i++)await Promise.resolve()}
async function tick(){const idx=scheduled.findIndex(x=>x.ms===100);if(idx<0)throw Error('missing sequential poll timer');const [t]=scheduled.splice(idx,1);clock+=t.ms;t.fn();await flush()}

const evaluate=code=>vm.runInContext(code,ctx);
const name=process.argv[3];
async function load(im){im.naturalWidth=10;im.naturalHeight=10;im.complete=true;await im.onload?.();await flush()}
(async()=>{
 await flush();
 const pages=elem('#pages');
 assert.deepEqual(requested,['a','b','c'].map(n=>img(n).url));
 // While the current queue is incomplete, no next panel may be fetched.
 ctx.scrollY=950;evaluate('maybeWarmNextPanel()');assert.equal(requested.length,3);
 for(const im of imgs.slice(0,3)){await load(im);await tick()}
 assert.equal(pages.children.length,3);
 assert.equal(evaluate('chapterSequentialQueueComplete'),true);
 ctx.scrollY=500;evaluate('maybeWarmNextPanel()');assert.equal(requested.length,3);
 ctx.scrollY=720;evaluate('maybeWarmNextPanel()');
 assert.deepEqual(requested,['a','b','c','next'].map(n=>img(n).url));
 evaluate('maybeWarmNextPanel()');assert.equal(requested.length,4);
 const warm=imgs[3];
 if(name==='early'){
   evaluate('nextChapter(1)');assert.equal(assigned.length,1);assert.equal(hist.length,0);return;
 }
 if(name==='failure'){
   warm.onerror();evaluate('nextChapter(1)');assert.equal(assigned.length,1);assert.equal(hist.length,0);return;
 }
 if(name==='timeout'){
   let finish;warm.decode=()=>new Promise(r=>{finish=r});warm.naturalWidth=10;warm.naturalHeight=10;warm.complete=true;
   const pending=warm.onload();const timeout=scheduled.find(x=>x.ms===30000);timeout.fn();finish();await pending;
   evaluate('nextChapter(1)');assert.equal(assigned.length,1);assert.equal(hist.length,0);return;
 }
 await load(warm);assert.equal(evaluate('nextPanelWarm.ready'),true);
 if(name==='stale'){
   manifest.chapters[3].images[0].url=img('changed').url;
   evaluate('nextChapter(1)');assert.equal(assigned.length,1);assert.equal(hist.length,0);return;
 }
 if(name==='repair-busy'){
   window.OpenReaderCanWarmNavigate=()=>false;
   evaluate('nextChapter(1)');assert.equal(assigned.length,1);return;
 }
 evaluate('nextChapter(1)');
 // No async flush: render must have synchronously mounted the exact element.
 assert.equal(pages.children[0].tag,'figure');assert.equal(pages.children[0].children[0],warm);
 assert.equal(pages.children[0].children[0].dataset.loaded,'yes');assert.equal(ctx.scrollY,0);
 assert.equal(assigned.length,0);assert.equal(hist.filter(x=>x[0]==='push').length,1);
 assert.ok(location.href.endsWith('chapter=after'));assert.equal(evaluate('chapter.id'),'after');
 assert.equal(evaluate('chapterSequentialQueueComplete'),false);
 assert.equal(requested.filter(x=>x===img('next').url).length,1);
 assert.deepEqual(requested,['a','b','c','next','next2','next3'].map(n=>img(n).url));
 assert.ok(events.some(e=>e.type==='open-reader:warm-chapter'&&e.detail.chapterId==='after'));
 // Later panels cannot leapfrog panel 2.
 const second=imgs.find(x=>x.src===img('next2').url),third=imgs.find(x=>x.src===img('next3').url);
 await load(third);await tick();assert.equal(pages.children.filter(x=>x.tag==='figure').length,1);
 await load(second);for(let i=0;i<8&&pages.children.filter(x=>x.tag==='figure').length!==3;i++){await tick()}
 await flush();assert.deepEqual(pages.children.map(x=>x.children[0]),[warm,second,third]);
 assert.equal(evaluate('chapterSequentialQueueComplete'),true);
 const previous=hist.find(x=>x[0]==='replace');assert.equal(previous[2].orChapterPosition.y,720);
 location.href=previous[1];history.state=previous[2];for(const cb of handlers.popstate)cb();assert.deepEqual(reloads,[previous[1]]);
 console.log('PASS warm handoff, exact identity, ordered queue, history');
})().catch(e=>{console.error(e);process.exitCode=1});
