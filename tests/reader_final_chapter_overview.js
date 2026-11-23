'use strict';
// Provider-neutral reader regressions. No network, browser, or GitHub required.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const addon=fs.readFileSync(path.join(__dirname,'../reusable/reader_chapter_enhancement.js'),'utf8');

function makeReader({index=0,ready=true,reduced=false}={}) {
  const queued=[];
  const events=new Map();
  const calls=[];
  const assigned=[];
  const set=(obj,name,fn)=>{
    if(!obj.handlers) obj.handlers={};
    (obj.handlers[name]||=[]).push(fn);
  };
  const node=(name)=>({name,hidden:true,handlers:{},children:[],attributes:{},
    classList:{add(){},remove(){}},
    addEventListener(name,cb){set(this,name,cb)},
    setAttribute(k,v){this.attributes[k]=v},
    append(...els){this.children.push(...els)},
    appendChild(el){this.children.push(el)},
    replaceChildren(){},
    parentNode:{insertBefore(el,child){child._navLink=el}}
  });
  const panel=node('panel'),pages=node('pages'),heading=node('heading'),body=node('body');
  const classes=new Set();
  const doc={body,referrer:'',documentElement:{classList:{add(c){classes.add(c)},remove(c){classes.delete(c)}}},
    createElement:node,
    querySelector(s){return {'#reader-panel':panel,'#pages':pages,'#panel-series':heading}[s]||null},
    addEventListener(name,cb){set(this,name,cb)}
  };
  const storage=new Map();
  const location={href:'https://open-reader.example/comics/comic-a/?chapter=c2',
    pathname:'/comics/comic-a/',origin:'https://open-reader.example',
    assign(u){assigned.push(new URL(u,this.href).href)}
  };
  const win={handlers:{},matchMedia(){return {matches:reduced}},
    addEventListener(name,cb){set(this,name,cb)},
    OpenReaderSaveProgress(){calls.push('save-progress')},
    OpenReaderTrackChapter(id,y){calls.push(['track',id,y])},PointerEvent:function(){}};
  const context=vm.createContext({
    $:doc.querySelector.bind(doc),document:doc,window:win,location,
    URL,performance:{now(){return 1000},getEntriesByType(){return [{type:'reload'}]}},
    sessionStorage:{getItem(k){return storage.get(k)||null},setItem(k,v){storage.set(k,v)},removeItem(k){storage.delete(k)}},
    setTimeout(fn,time){queued.push({fn,time});return queued.length},clearTimeout(){},
    MutationObserver:class{observe(){}},
    manifest:{title:'Comic A',chapters:[{id:'c1'},{id:'c2'}]},
    chapterIndex:index,transitioning:false,panelOpen:false,settings:{auto:true},
    write(){calls.push('write')},
    allLoaded(){return ready},
    nextChapter(dir,auto){calls.push(['native',dir,auto])},
    updateAuto(){},togglePanel(){},activeInput(){return false}
  });
  vm.runInContext(addon,context,{filename:'reader_chapter_enhancement.js'});
  return {context,queued,calls,assigned,classes,heading,location,
    flush(){for(const task of queued.splice(0))task.fn()}
  };
}

function testNextWithinComic(){
  const app=makeReader({index:0});
  app.context.nextChapter(1);
  assert.equal(app.calls.filter(x=>Array.isArray(x)&&x[0]==='native').length,1);
  assert.equal(app.assigned.length,0);
  assert.equal(app.classes.has('or-flip-exit'),false);
  assert.equal(app.context.sessionStorage.getItem('open-reader:skip-entry-flip'),'/comics/comic-a/');
}
function testNextAtEnd(){
  const app=makeReader({index:1});
  app.context.nextChapter(1);
  assert.ok(app.classes.has('or-flip-exit'),'must flip when leaving final chapter');
  assert.deepEqual(app.calls,['save-progress']);
  app.flush();
  assert.deepEqual(app.assigned,['https://open-reader.example/comics/comic-a/overview/']);
}
function testAutoWaitsUntilImagesLoaded(){
  const app=makeReader({index:1,ready:false});
  app.context.nextChapter(1,true);
  assert.equal(app.assigned.length,0);
  assert.deepEqual(app.calls.map(x=>Array.isArray(x)?x[0]:x),['native']);
}
function testAutoAtEndDisablesAuto(){
  const app=makeReader({index:1,ready:true});
  app.context.nextChapter(1,true);
  assert.equal(app.context.settings.auto,false);
  assert.ok(app.calls.includes('write'));
  app.flush();
  assert.deepEqual(app.assigned,['https://open-reader.example/comics/comic-a/overview/']);
}
function testPreviousAtStartKeepsOldBehavior(){
  const app=makeReader({index:0});
  app.context.nextChapter(-1);
  assert.deepEqual(app.calls.map(x=>Array.isArray(x)?x[0]:x),['native']);
  app.flush();
  assert.equal(app.assigned.length,0);
}
function testComicTitle(){
  // Verified by real script construction, listener, URL and DOM parent handling.
  const app=makeReader({index:0});
  assert.ok(app.heading._navLink,'original title should be wrapped in a link');
  assert.equal(app.heading._navLink.children[0],app.heading);
  assert.equal(app.heading._navLink.href,'https://open-reader.example/comics/comic-a/overview/');
  let prevented=false;
  app.heading._navLink.handlers.click[0]({button:0,preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.ok(app.classes.has('or-flip-exit'));
  app.flush();
  assert.deepEqual(app.assigned,['https://open-reader.example/comics/comic-a/overview/']);
}
function testModifierClickLeavesNativeLink(){
  const app=makeReader({index:0});
  let prevented=false;
  app.heading._navLink.handlers.click[0]({button:0,ctrlKey:true,preventDefault(){prevented=true}});
  assert.equal(prevented,false);
  assert.equal(app.classes.has('or-flip-exit'),false);
}
function testReducedMotionDirectNavigation(){
  const app=makeReader({index:1,reduced:true});
  app.context.nextChapter(1);
  assert.deepEqual(app.assigned,['https://open-reader.example/comics/comic-a/overview/']);
  assert.equal(app.classes.has('or-flip-exit'),false);
}
for(const test of [testNextWithinComic,testNextAtEnd,testAutoWaitsUntilImagesLoaded,
    testAutoAtEndDisablesAuto,testPreviousAtStartKeepsOldBehavior,testComicTitle,
    testModifierClickLeavesNativeLink,testReducedMotionDirectNavigation]){
  test();
}
console.log('PASS: 8 generic reader final-chapter / comic-title / animation regressions');
