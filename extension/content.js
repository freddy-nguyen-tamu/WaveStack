(() => {
  'use strict';
  // Site scope is generated from the attached HTML. This extension never navigates
  // to extension-origin pages while reading and never intercepts wheel events.
  const KEY='cleanSourceComicReader.v3';
  const readerSelectors=[".md--reader-pages"];
  const findReader=()=>readerSelectors.map(s=>document.querySelector(s)).find(el=>el && el.querySelectorAll('img,[data-page]').length);
  let root=findReader();
  if(!root)return;
  const style=document.createElement('style');
  style.textContent=`html{scroll-behavior:auto!important;scroll-snap-type:none!important;}
    body{overflow-x:hidden!important;background:#080808!important;margin:0!important;}
    .clean-comic-reader-root{margin:0 auto!important;padding:0!important;max-width:100vw!important;display:flex!important;flex-direction:column!important;align-items:center!important;gap:0!important;}
    .clean-comic-reader-root img{width:min(100vw,1100px)!important;max-width:100%!important;height:auto!important;object-fit:contain!important;display:block!important;margin:0 auto!important;float:none!important;position:static!important;transform:none!important;}
    .clean-comic-reader-root [data-page]{max-width:100%;margin:0 auto!important;}
    .clean-comic-reader-root *{scroll-snap-align:none!important;animation:none!important;transition:none!important;}`;
  document.documentElement.append(style);
  root.classList.add('clean-comic-reader-root');
  // Hide unrelated site UI by following the actual reader's ancestor chain;
  // do not remove reader nodes that source JavaScript may mutate later.
  let branch=root;
  while(branch && branch!==document.body){
    const parent=branch.parentElement;
    if(!parent)break;
    for(const child of parent.children){
      if(child!==branch && child.tagName!=='SCRIPT' && child.tagName!=='STYLE'){
        child.dataset.cleanReaderHidden='1';child.style.setProperty('display','none','important');
      }
    }
    branch=parent;
  }
  let speed=80,enabled=false,wasEnabled=false,prior=0,frac=0,lastBottom=0,raf=0,holdUp=false,holdDown=false;
  const loaded=new Map(),failed=new Map();
  chrome.storage.local.get([KEY],result=>{const value=result[KEY]||{};speed=Math.max(5,Number(value.speed)||80);enabled=!!value.enabled;wasEnabled=enabled;});
  const persist=()=>chrome.storage.local.set({[KEY]:{speed,enabled}});
  function discover(){
    root=findReader()||root;
    const images=[...root.querySelectorAll('img')];
    for(const im of images){
      const src=["src", "data-src", "data-original"].map(a=>im.getAttribute(a)).find(Boolean)||im.currentSrc;
      if(!src||src.startsWith('data:'))continue;
      if(!loaded.has(im)){
        loaded.set(im,false);
        im.addEventListener('load',()=>{loaded.set(im,true);failed.delete(im)},{passive:true});
        im.addEventListener('error',()=>{loaded.set(im,false);failed.set(im,(failed.get(im)||0)+1)},{passive:true});
      }
      im.setAttribute('loading','eager');
      // The original site sometimes uses lazy placeholder URLs. Restore the
      // legitimate source URL from its own data attributes without bypassing access.
      if(im.getAttribute('src')!==src && ![].some(marker=>src.includes(marker))) im.setAttribute('src',src);
      if(im.complete && im.naturalWidth>0)loaded.set(im,true);
      else if(failed.has(im)&&failed.get(im)<4){
        const k=failed.get(im);failed.set(im,k+1);
        setTimeout(()=>{if(!im.complete||!im.naturalWidth)im.src=src},Math.min(16000,1000*2**k));
      }
    }
  }
  const observer=new MutationObserver(()=>discover());
  observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['src','data-src','data-url']});
  discover();
  function links(){
    // Native reader navigation always has priority. No manufactured URLs if
    // native next/previous links are present.
    const prev=[...document.querySelectorAll([].join(','))]
      .find(a=>a.href && !a.classList.contains('dim'));
    const next=[...document.querySelectorAll([].join(','))]
      .find(a=>a.href && !a.classList.contains('dim'));
    return {prev:prev?.href||null,next:next?.href||null};
  }
  const navigate=(dir,automatic=false)=>{
    if(automatic && [...loaded.values()].some(v=>!v))return;
    if(automatic && [...failed.values()].some(x=>x>=4))return;
    const {prev,next}=links();const url=dir>0?next:prev;
    if(!url){if(automatic){enabled=false;persist()}return;}
    // Navigate to the actual original website chapter URL.
    location.assign(url);
  };
  const interactive=()=>document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
  addEventListener('keydown',e=>{
    if(interactive()||e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.key==='ArrowRight'){e.preventDefault();if(!e.repeat)navigate(1);}
    if(e.key==='ArrowLeft'){e.preventDefault();if(!e.repeat)navigate(-1);}
    if(e.key==='ArrowUp'){e.preventDefault();holdUp=true;}
    if(e.key==='ArrowDown'){e.preventDefault();holdDown=true;}
    if(e.key==='Enter'&&!e.repeat){e.preventDefault();enabled=!enabled;persist();}
  },true);
  addEventListener('keyup',e=>{if(e.key==='ArrowUp')holdUp=false;if(e.key==='ArrowDown')holdDown=false},true);
  addEventListener('blur',()=>{holdUp=false;holdDown=false;prior=0});
  document.addEventListener('visibilitychange',()=>{prior=0});
  let lastScan=0, bottomSince=0;
  function frame(now){
    raf=requestAnimationFrame(frame);
    const dt=prior?Math.min((now-prior)/1000,.05):0;prior=now;
    if(document.hidden)return;
    if(now-lastScan>950){discover();lastScan=now;}
    const dir=holdDown?1:holdUp?-1:enabled?1:0;
    if(dir){frac+=dir*speed*dt;const step=frac>0?Math.floor(frac):Math.ceil(frac);frac-=step;
      if(step)window.scrollBy({top:step,behavior:'instant'});
    }
    const remaining=Math.max(0,document.documentElement.scrollHeight-innerHeight-scrollY);
    if(enabled && dir>0 && remaining<=2){
      const accounted=[...root.querySelectorAll('[data-page]')].length;
      if(accounted && loaded.size<accounted){bottomSince=0;return;}
      if([...loaded.values()].some(v=>!v)){bottomSince=0;return;}
      if(!bottomSince)bottomSince=now;
      if(now-bottomSince>850)navigate(1,true);
    } else bottomSince=0;
  }
  raf=requestAnimationFrame(frame);
})();
