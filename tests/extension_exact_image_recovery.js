'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/content.js'),'utf8');
const image='https://img.example.test/issue/0002.jpg';
const chapter='https://reader.example.test/chapter/1';
async function scenario({decoded,forcePosition,refreshSource}) {
  let y=0,changes=[],sourceWrites=[];
  const window={innerHeight:800,scrollY:y};
  const img={isConnected:true,complete:decoded,naturalWidth:decoded?720:0,naturalHeight:decoded?900:0,
    currentSrc:image,loading:'lazy',closest:()=>null,
    getAttribute:n=>n==='src'?image:null,
    getBoundingClientRect(){return {top:400-window.scrollY,left:0,width:500,height:900};}};
  let source=image;
  Object.defineProperty(img,'src',{get:()=>source,set:value=>{
    sourceWrites.push(value);source=value;
    setTimeout(()=>{img.complete=true;img.naturalWidth=720;img.naturalHeight=900;},10);
  }});
  const root={querySelector:()=>img,querySelectorAll:()=>[img]};
  const document={body:root,documentElement:root,images:[img],querySelector:()=>root};
  window.scrollTo=({top})=>{window.scrollY=top;changes.push(top);};
  const box={window,document,location:{href:chapter},URL,chrome:{runtime:{onMessage:{addListener(){}}}},
    requestAnimationFrame:cb=>setTimeout(cb,0),setTimeout,clearTimeout,Math,Number,String,Date,
    Promise,Error,console,innerHeight:800,innerWidth:900};
  vm.createContext(box);vm.runInContext(src,box);
  assert.equal(window.__comicBridgeContentLoadedVersion,10);
  const ans=await window.__comicBridgeDirect({type:'RECOVER_IMAGE',payload:{key:'1',url:image,
    reader_selectors:['.reader'],image_attributes:['src'],force_position:forcePosition,
    refresh_source:refreshSource}});
  assert.equal(ans.loaded,true);
  if(forcePosition) {
    assert.ok(changes.length>=3,'must visibly move into the exact image');
    assert.equal(window.scrollY,450,'must finish centered on the image');
    assert.ok(changes.every((v,i)=>i===0||v>=changes[i-1]),'must not teleport back to bottom');
  }
  if(refreshSource) assert.deepEqual(sourceWrites,[image],'only retry the original exact URL once');
  else assert.deepEqual(sourceWrites,[],'do not re-request an image that already decoded');
}
(async()=>{await scenario({decoded:false,forcePosition:true,refreshSource:true});
  await scenario({decoded:true,forcePosition:true,refreshSource:false});
  console.log('PASS exact-URL retry; decoded-image camera rescue; no duplicate requests or viewport resets');
})().catch(e=>{console.error(e);process.exit(1)});
