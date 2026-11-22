'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const content=fs.readFileSync(path.join(__dirname,'..','reusable','browser_bridge_extension','content.js'),'utf8');
function makePage({images,rootImages}) {
  const doc={
    images,
    querySelector(selector){ return selector==='.reader' ? {querySelectorAll(name){ assert.equal(name,'img'); return rootImages; }} : null; },
    documentElement:{},
  };
  const win={};
  const sandbox={window:win,document:doc,location:{href:'https://source.example.test/reader/chapter-1/'},
    URL,chrome:{runtime:{onMessage:{addListener(){}}}},console};
  vm.runInNewContext(content,sandbox);
  return win.__comicBridgeDirect;
}
function image(src,decoded=true) {return {currentSrc:src,src,complete:decoded,naturalWidth:decoded?800:0,naturalHeight:decoded?1200:0};}
(async()=>{
  const ad=image('https://ads.example.test/ad.jpg');
  const local=image('https://source.example.test/panel1.jpg');
  const external=image('https://images.example.test/panel2.jpg');
  let dispatch=makePage({images:[ad,local,external],rootImages:[local,external]});
  let result=await dispatch({type:'FIRST_LOADED_IMAGE',payload:{origins:['https://images.example.test'],reader_selectors:['.reader']}});
  assert.equal(result.url,external.currentSrc,'old external-origin method must retain priority');
  result=await dispatch({type:'FIRST_LOADED_IMAGE',payload:{origins:[],reader_selectors:['.reader']}});
  assert.equal(result.url,local.currentSrc,'fallback must select decoded source panel inside reader only');
  dispatch=makePage({images:[ad,image('https://source.example.test/unloaded.jpg',false)],rootImages:[image('https://source.example.test/unloaded.jpg',false)]});
  result=await dispatch({type:'FIRST_LOADED_IMAGE',payload:{origins:[],reader_selectors:['.reader']}});
  assert.equal(result.url,'','probe must fail closed on entirely undecoded panels');
  console.log('PASS: CDN-first probe retained; reader-only decoded fallback; undecoded fails closed');
})().catch(e=>{console.error(e);process.exitCode=1;});
