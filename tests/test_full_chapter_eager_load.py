"""Shared reader queue and source-issue upload regression tests (offline)."""
import subprocess
import shutil
import tempfile
import unittest
from pathlib import Path
from reusable import open_reader

ROOT=Path(__file__).resolve().parents[1]

class SequentialAndUploadTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.project=Path(temp.name)/'project'
        (self.project/'reader').mkdir(parents=True)
        (self.project/'reusable/worker_addon').mkdir(parents=True)
        for src in (ROOT/'reader').iterdir():
            if src.is_file():shutil.copy2(src,self.project/'reader'/src.name)
        for name in ('open_reader_homepage_addon.py','comic_landing.py','comic_landing.css',
                     'comic_landing.js','reader_progress.js','reader_chapter_enhancement.css',
                     'reader_chapter_enhancement.js','gold_favicon.py','github_streaming.py',
                     'github_upload_bell.js','partial_chapter_publish.py'):
            shutil.copy2(ROOT/'reusable'/name,self.project/'reusable'/name)
        shutil.copy2(ROOT/'reusable/worker_addon/panel_replacement_worker.mjs',
                     self.project/'reusable/worker_addon/panel_replacement_worker.mjs')
        image=lambda n:{'url':'https://images.invalid/'+n+'.png','width':10,'height':10}
        self.registry={'comics':{'sample':{'title':'Sample','slug':'sample','chapters':[
            {'id':'before','images':[image('prev')]},
            {'id':'partial','images':[image('a'),{'placeholder':True,'panel':2,'confirmed_missing':True},image('c')]},
            {'id':'complete','images':[image('a'),image('b'),image('c')]},
            {'id':'after','images':[image('next')]}]}}}
        self.stage=Path(temp.name)/'stage'
        open_reader.stage_worker_assets(self.project,self.registry,self.stage)
        self.app=self.stage/'comics/sample/app.js'

    def test_stage_contains_chapter_only_ordered_queue_not_parallel_gate(self):
        code=self.app.read_text(encoding='utf8')
        self.assertIn('const chapterSequentialLoading=true;',code)
        self.assertIn('const WINDOW_SIZE=3;',code)
        self.assertIn('for(let ordinal=0;ordinal<known.length;ordinal++){',code)
        self.assertIn('await new Promise(resolve=>setTimeout(resolve,100));',code)
        self.assertIn('pages.insertBefore(prepared.figure,loading);',code)
        self.assertIn("if(chapterSequentialLoading||!known.length)return;",code)
        self.assertNotIn('realImages.forEach(needPreload)',code)
        self.assertNotIn('chapterLoadGateActive',code)
        self.assertIn('function nextChapter(dir, auto=false)',code)
        proc=subprocess.run(['node','--check',str(self.app)],text=True,capture_output=True,timeout=20)
        self.assertEqual(proc.returncode,0,proc.stderr)

    def test_loader_simulated_in_order_with_and_without_placeholders(self):
        js=r'''
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
document.documentElement.classList={add(){},remove(){}};
const selected=process.argv[2],u=new URL('https://reader.test/comics/sample/?chapter='+selected);
const location={href:u.href,origin:u.origin,pathname:u.pathname,assign(){throw Error('unexpected navigation')}};
const storage={getItem(){return null},setItem(){},removeItem(){}};
const window={addEventListener(){},dispatchEvent(){},matchMedia(){return {matches:true}},PointerEvent:class{}};
const perf={now:()=>clock,getEntriesByType:()=>[]};
const img=n=>({url:'https://images.invalid/'+n+'.png',width:10,height:10});
const manifest={title:'Sample',chapters:[{id:'before',images:[img('prev')]},
 {id:'partial',images:[img('a'),{placeholder:true,panel:2,confirmed_missing:true},img('c')]},
 {id:'complete',images:[img('a'),img('b'),img('c')]}, {id:'after',images:[img('next')]}]};
const ctx={document,window,location,localStorage:storage,sessionStorage:storage,performance:perf,
 MutationObserver:class{observe(){}},CustomEvent:class{},URL,console,requestAnimationFrame:()=>1,clearTimeout:()=>{},
 setTimeout(fn,ms){scheduled.push({fn,ms});return scheduled.length},
 fetch:async()=>({ok:true,json:async()=>manifest})};
const nav=new Element('nav');nav.append(elem('#panel-series'));elem('#pages').isConnected=true;
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),ctx,{filename:'app.js'});
async function flush(){for(let i=0;i<40;i++)await Promise.resolve()}
async function tick(){const idx=scheduled.findIndex(x=>x.ms===100);if(idx<0)throw Error('missing sequential poll timer');const [t]=scheduled.splice(idx,1);clock+=t.ms;t.fn();await flush()}
(async()=>{
 await flush();
 const expected=selected==='partial' ? [img('a').url,img('c').url]:[img('a').url,img('b').url,img('c').url];
 assert.deepEqual(requested,expected,'max three current-chapter images request immediately');
 const pages=elem('#pages');assert.equal(pages.children.length,1);assert.equal(pages.children[0].className,'or-chapter-load-screen');
 imgs[0].naturalWidth=10;imgs[0].onload();await tick();
 assert.equal(pages.children[0].tag,'figure','first panel visible immediately');
 assert.equal(pages.children[0].children[0],imgs[0]);
 assert.deepEqual(requested,expected,'early window remains bounded regardless of scrolling');
 if(selected==='partial')assert.equal(pages.children[1].className,'or-missing-panel','missing marker in exact second slot');
 assert.equal(pages.children.at(-1).className,'or-chapter-load-screen','spinner remains until done');
 imgs[1].naturalWidth=10;imgs[1].onload();await tick();
 assert.equal(requested.length,selected==='complete'?3:2,'only selected-chapter images requested');
 if(selected==='complete'){
   assert.deepEqual(requested,expected,'three ordered chapter requests');
   imgs[2].naturalWidth=10;imgs[2].onload();await tick();
 }
 assert.equal(pages.children.length,3,'three ordered panels, no spinner after finish');
 assert.equal(pages.children.at(-1).tag,'figure');
 assert.deepEqual(requested,expected);
 console.log('PASS sequential '+selected);
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        for chapter in ('partial','complete'):
            with self.subTest(chapter=chapter):
                run=subprocess.run(['node','-e',js,str(self.app),chapter],text=True,capture_output=True,timeout=20)
                self.assertEqual(run.returncode,0,run.stdout+'\n'+run.stderr)
                self.assertIn('PASS sequential '+chapter,run.stdout)

    def test_issue_bell_uses_github_route_when_github_configured(self):
        js=r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class E {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.style={};this.hidden=false;this.files=null;this.textContent='';this.className='';}
 append(...xs){this.children.push(...xs)}replaceChildren(...xs){this.children=[...xs]}
 setAttribute(k,v){this.attrs[k]=v}getAttribute(k){return this.attrs[k]}
 querySelector(s){if(!this._controls)this._controls=new Map();if(!this._controls.has(s))this._controls.set(s,new E(s));return this._controls.get(s)}
 addEventListener(){}click(){}focus(){}
}
const issues=[{id:'4f6d7ab981769760c5dc',status:'source_server_unavailable',work:'Annoying Alice',work_slug:'annoying-alice',episode:'Chapter 82',episode_id:'82',panel:56},
 {id:'6fe769c5c9b812fa92be',status:'source_server_unavailable',work:'Annoying Alice',work_slug:'annoying-alice',episode:'Chapter 82',episode_id:'82',panel:57}];
let root=null,choosers=[],requests=[],uploadResult=[],uploadAttempts=0;
const document={head:new E('head'),body:new E('body'),hidden:false,readyState:'complete',
 getElementById:()=>null,createElement(tag){const x=new E(tag);if(tag==='aside')root=x;
 if(tag==='input')choosers.push(x);return x},
 createDocumentFragment(){return new E('fragment')},addEventListener(){} };
const route=process.argv[2];
const fetch=async(url,options={})=>{
 requests.push({url,options});
 if(url==='/source-issues.json')return {ok:true,json:async()=>({schema:'comicarchiver.source_issue_feed.v1',upload_enabled:true,cases:issues})};
 if(url==='/api/reader-health')return {ok:true,json:async()=>({github_streaming_configured:route.startsWith('github'),storage_configured:route==='r2'})};
 if(url==='/api/admin/login')return {ok:true,status:200,json:async()=>({ok:true})};
 if(url.startsWith('/api/admin/github-image/')||url.startsWith('/api/panel-replacements/')){
   uploadResult.push(url);uploadAttempts++;
   if(route==='github-login'&&uploadAttempts===1)return {ok:false,status:401,json:async()=>({error:'Admin sign-in required'})};
   return {ok:true,status:200,json:async()=>({ok:true})};}
 return {ok:false,status:404,json:async()=>({error:'unexpected'})};
};
const posted=[],stored=[];
class Channel { constructor(name){assert.equal(name,'open-reader-panel-repairs-v1')} postMessage(value){posted.push(value)} close(){} }
const ctx={document,window:{addEventListener(){}},location:{origin:'https://reader.test',pathname:'/'},
 URL,fetch,console,setTimeout(){},BroadcastChannel:Channel,localStorage:{setItem(key,value){stored.push({key,value})}}};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),ctx,{filename:'reader-issues.js'});
(async()=>{for(let i=0;i<60;i++)await Promise.resolve();
 const chooser=choosers.find(x=>x.attrs['aria-label']?.includes('panel 56'));
 assert(chooser,'missing issue upload chooser');
 chooser.files=[{type:'image/png',size:50}];chooser.onchange();
 for(let i=0;i<100;i++)await Promise.resolve();
 if(route==='github-login'){
   root.querySelector('#ri-password').value='test password';
   await root.querySelector('#ri-login').onsubmit({preventDefault(){}});
   for(let i=0;i<100;i++)await Promise.resolve();
 }
 const want=route.startsWith('github')?'/api/admin/github-image/annoying-alice/82/56':'/api/panel-replacements/4f6d7ab981769760c5dc';
 assert.deepEqual(uploadResult,route==='github-login'?[want,want]:[want]);
 assert.equal(posted.length,1,'emit exactly after successful upload');
 assert.equal(posted[0].slug,'annoying-alice');assert.equal(posted[0].chapter,'82');
 assert.equal(posted[0].panel,56);assert.equal(stored[0]?.key,'open-reader:panel-repaired');
 console.log('PASS issue upload route '+route);
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        for route in ('github','github-login','r2'):
            with self.subTest(route=route):
                run=subprocess.run(['node','-e',js,str(ROOT/'reader/reader-issues.js'),route],text=True,capture_output=True,timeout=20)
                self.assertEqual(run.returncode,0,run.stdout+'\n'+run.stderr)

if __name__=='__main__':unittest.main()
