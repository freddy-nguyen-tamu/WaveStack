/* Smooth minimal comic reader. No wheel handlers are registered, ever. */
const $ = (s) => document.querySelector(s);
const params = new URL(location.href).searchParams;
const store = 'universal-comic-reader-v3';
let settings = {};
try { settings = JSON.parse(localStorage.getItem(store) || '{}'); } catch { settings = {}; }
settings.speed = Math.max(5, Math.min(1500, Number(settings.speed) || 80));
settings.auto = Boolean(settings.auto);
const write = () => localStorage.setItem(store, JSON.stringify(settings));
let manifest, chapter, chapterIndex, known = [], imageObserver, transitioning=false;
let raf=0, previous=0, remainder=0, heldUp=false, heldDown=false, pendingRestore=0;
let lastScrollSave=0, completionStart=0;
let panelOpen=false, prePanelFocus=null;
const scroller = () => document.scrollingElement || document.documentElement;
const maxY = () => Math.max(0, scroller().scrollHeight - innerHeight);
function saveProgress() {
  const now=performance.now(); if(now-lastScrollSave<850) return;
  lastScrollSave=now; if(chapter) {settings.lastChapter=chapter.id; settings.lastY=scrollY; write();}
}
window.addEventListener('scroll',saveProgress,{passive:true});
function allLoaded(){return known.length>0 && known.every(x=>x.status==='loaded');}
function firstMissing(){return known.find(x=>x.status!=='loaded');}
function needPreload(im){
  if(im.status==='loaded'||im.status==='loading')return;
  im.status='loading';
  const image=im.el; const u=im.url;
  image.onload=()=>{im.status='loaded'; im.failures=0; image.dataset.loaded='yes';};
  image.onerror=()=>{
    im.status='failed'; im.failures=(im.failures||0)+1;
    if(im.failures<=4) setTimeout(()=>{im.status='waiting';needPreload(im)}, Math.min(15000,700*2**im.failures));
  };
  image.src=u;
}
function triggerNearby(){
  if(!known.length)return;
  const y=scrollY, margin=Math.max(2000,innerHeight*3);
  // Update a limited visible window; only inspect dimensions when scroll changes.
  for(const im of known){
    if(im.status==='loaded')continue;
    const bound=im.el.parentElement.getBoundingClientRect();
    if(bound.top>-margin && bound.top<innerHeight+margin)needPreload(im);
  }
}
let preloadScheduled=false;
window.addEventListener('scroll',()=>{if(!preloadScheduled){preloadScheduled=true;requestAnimationFrame(()=>{preloadScheduled=false;triggerNearby()});}}, {passive:true});
function nextChapter(dir, auto=false){
  if(transitioning||!manifest)return;
  if(auto&&!allLoaded()) { triggerNearby();return; }
  const ix=chapterIndex+dir;
  if(ix<0||ix>=manifest.chapters.length){ if(auto&&dir>0){ settings.auto=false;write();} return; }
  transitioning=true;
  settings.lastY=0;settings.lastChapter=manifest.chapters[ix].id;write();
  const next=manifest.chapters[ix];
  const url=new URL(location.href);
  url.searchParams.set('chapter',next.id);
  location.assign(url.toString());
}
function activeInput(){return document.activeElement?.matches('input,textarea,select,button,[contenteditable="true"]');}
const clampSpeed = value => Math.max(5,Math.min(1500,Number(value)||80));
function updateSpeed(value){
  settings.speed=clampSpeed(value);write();
  $('#panel-speed').value=Math.min(600,settings.speed);
  $('#panel-speed-number').value=settings.speed;
  $('#panel-speed-text').textContent=`${settings.speed} px/s`;
}
function updateAuto(enabled){settings.auto=Boolean(enabled);completionStart=0;write();$('#panel-auto').checked=settings.auto;}
function panelChapterTitle(ch){return String(ch.title||ch.label||`Chapter ${ch.id}`).trim();}
function drawChapterList(){
  const list=$('#panel-chapters');if(!manifest||!list)return;
  const term=$('#panel-search').value.trim().toLocaleLowerCase();
  const frag=document.createDocumentFragment();let count=0;
  manifest.chapters.forEach((ch,i)=>{
    const label=panelChapterTitle(ch);
    if(term && !`${ch.id} ${ch.label||''} ${label}`.toLocaleLowerCase().includes(term))return;
    count++;
    const a=document.createElement('a');a.className='panel-chapter'+(i===chapterIndex?' active':'');
    const target=new URL(location.href);target.searchParams.set('chapter',ch.id);
    a.href=target.toString();a.textContent=label;
    if(i===chapterIndex)a.setAttribute('aria-current','page');
    frag.append(a);
  });
  list.replaceChildren(frag);
  $('#panel-chapter-count').textContent=`${count} of ${manifest.chapters.length} chapters`;
}
function togglePanel(force){
  const next=force===undefined?!panelOpen:Boolean(force);
  if(next===panelOpen)return;
  panelOpen=next;
  $('#reader-panel').hidden=!panelOpen;
  $('#panel-backdrop').hidden=!panelOpen;
  if(panelOpen){
    prePanelFocus=document.activeElement;
    $('#panel-series').textContent=manifest?.title||document.title;
    updateSpeed(settings.speed);$('#panel-auto').checked=settings.auto;
    drawChapterList();
    $('#panel-search').focus({preventScroll:true});
    $('#reader-panel').querySelector('.panel-chapter.active')?.scrollIntoView({block:'nearest'});
  } else {
    if(prePanelFocus&&typeof prePanelFocus.focus==='function')prePanelFocus.focus({preventScroll:true});
    else document.activeElement?.blur?.();
  }
}
$('#panel-close').addEventListener('click',()=>togglePanel(false));
$('#panel-backdrop').addEventListener('click',()=>togglePanel(false));
$('#panel-speed').addEventListener('input',e=>updateSpeed(e.target.value));
$('#panel-speed-number').addEventListener('change',e=>updateSpeed(e.target.value));
$('#panel-auto').addEventListener('change',e=>updateAuto(e.target.checked));
$('#panel-search').addEventListener('input',drawChapterList);

window.addEventListener('keydown',event=>{
  // Shift+Enter is handled before input filtering so the menu can close even
  // while its search box is focused. No shortcut hint is rendered on the page.
  if(event.key==='Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey){
    event.preventDefault();if(!event.repeat)togglePanel();return;
  }
  if(panelOpen){
    if(event.key==='Escape'||event.key==='x'||event.key==='X'){
      event.preventDefault();if(!event.repeat)togglePanel(false);return;
    }
    // Keep navigation keys out of the underlying comic while the menu is open.
    return;
  }
  if(activeInput()||event.altKey||event.ctrlKey||event.metaKey)return;
  switch(event.key){
    case 'ArrowRight':event.preventDefault();if(!event.repeat)nextChapter(1);break;
    case 'ArrowLeft':event.preventDefault();if(!event.repeat)nextChapter(-1);break;
    case 'ArrowUp':event.preventDefault();heldUp=true;break;
    case 'ArrowDown':event.preventDefault();heldDown=true;break;
    case 'Enter':event.preventDefault();if(!event.repeat)updateAuto(!settings.auto);break;
    case '?':event.preventDefault();location.assign('./settings.html');break;
    case 'f':case 'F':event.preventDefault();if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen?.();break;
  }
});
window.addEventListener('keyup',event=>{if(event.key==='ArrowUp')heldUp=false;if(event.key==='ArrowDown')heldDown=false;});
window.addEventListener('blur',()=>{heldUp=false;heldDown=false;previous=0;});
document.addEventListener('visibilitychange',()=>{previous=0;});
function frame(now){
  raf=requestAnimationFrame(frame);
  let dt=previous?Math.min((now-previous)/1000,0.05):0;
  previous=now;
  if(document.hidden||!chapter||transitioning||panelOpen)return;
  let direction=heldDown?1:heldUp?-1:settings.auto?1:0;
  if(!direction){completionStart=0;return;}
  // Do not advance over missing images within/near viewport.
  const missing=firstMissing();
  if(direction>0&&missing){
    const top=missing.el.parentElement.getBoundingClientRect().top;
    if(top>-innerHeight*.75 && top<innerHeight*1.35) {triggerNearby();completionStart=0;return;}
  }
  remainder+=direction*settings.speed*dt;
  let delta=remainder>0?Math.floor(remainder):Math.ceil(remainder);
  remainder-=delta;
  if(delta)window.scrollBy({top:delta,left:0,behavior:'instant'});
  if(settings.auto && direction>0 && maxY()-scrollY<=2){
    if(!allLoaded()) {
      triggerNearby();
      // A user may jump past unvisited pages. Validate all manifest entries
      // before chapter transition instead of stalling forever at the bottom.
      known.filter(x=>x.status==='waiting').slice(0,4).forEach(needPreload);
      completionStart=0;return;
    }
    if(!completionStart)completionStart=now;
    if(now-completionStart>650)nextChapter(1,true);
  } else completionStart=0;
}
async function render(){
  const response=await fetch('./manifest.json',{cache:'no-cache'});
  if(!response.ok)throw new Error('Manifest unavailable: HTTP '+response.status);
  manifest=await response.json();
  if(!Array.isArray(manifest.chapters)||manifest.chapters.length===0)throw new Error('No published chapters');
  document.title=manifest.title||'Comic reader';
  let desired=params.get('chapter')||settings.lastChapter||manifest.chapters[0].id;
  chapterIndex=manifest.chapters.findIndex(ch=>ch.id===desired);
  if(chapterIndex<0)chapterIndex=0;
  chapter=manifest.chapters[chapterIndex];
  $('#panel-series').textContent=manifest.title||'Comic reader';
  updateSpeed(settings.speed);$('#panel-auto').checked=settings.auto;
  drawChapterList();
  const frag=document.createDocumentFragment();
  known=chapter.images.map((item,i)=>{
    const figure=document.createElement('figure');
    const width=Math.max(1,Number(item.width)||1100),height=Math.max(1,Number(item.height)||1500);
    figure.style.aspectRatio=`${width}/${height}`;
    const im=document.createElement('img');
    im.alt=''; im.decoding='async'; im.loading='eager'; im.width=width;im.height=height;
    figure.append(im);frag.append(figure);
    return {status:'waiting',el:im,url:item.url,order:i};
  });
  $('#pages').append(frag);
  // Load first few pages immediately. Subsequent images are loaded ahead by scrolling.
  known.slice(0,Math.min(5,known.length)).forEach(needPreload);
  triggerNearby();
  if(chapter.id===settings.lastChapter && Number(settings.lastY)>0 && !params.has('chapter')){
    requestAnimationFrame(()=>window.scrollTo({top:Math.min(maxY(),settings.lastY),behavior:'instant'}));
  }
  write();
}
render().catch(err=>{console.error('Reader initialization error:',err);settings.auto=false;write();});
raf=requestAnimationFrame(frame);
