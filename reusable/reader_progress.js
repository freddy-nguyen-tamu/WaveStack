/* Per-comic, persistent local-device progress; no server tracking or new API. */
(() => {
 'use strict';
 const match=location.pathname.match(/^\/comics\/([a-z0-9-]+)\/(?:index\.html)?$/);
 if(!match)return;
 const key='open-reader:progress:v1:'+match[1];
 let saved=null;
 try {const v=JSON.parse(localStorage.getItem(key)||'null');
   if(v&&typeof v.chapter==='string'&&v.chapter)saved=v} catch {}
 window.OpenReaderLocalProgress=saved;
 const requested=new URL(location.href);
 const wantResume=requested.searchParams.get('resume')==='1';
 if(!requested.searchParams.has('chapter')&&saved?.chapter){
    requested.searchParams.set('chapter',saved.chapter);
    history.replaceState(history.state,'',requested.toString());
 }
 let active='', initialized=false, lastWrite=0, leaving=false;
 const detect=()=>{
   const a=document.querySelector('#panel-chapters .panel-chapter.active');
   if(!a||!document.querySelector('#pages figure'))return '';
   try{return new URL(a.href,location.href).searchParams.get('chapter')||''}catch{return ''}
 };
 function save(force=false){
   if(leaving||!active)return;
   if(!force&&Date.now()-lastWrite<700)return;
   lastWrite=Date.now();
   try{localStorage.setItem(key,JSON.stringify({chapter:active,y:Math.max(0,Math.round(scrollY)),updated:Date.now()}))}catch{}
 }
 window.OpenReaderSaveProgress=()=>save(true);
 window.OpenReaderTrackChapter=(id,y=0)=>{
   if(typeof id!=='string'||!id)return;
   leaving=true;
   try{localStorage.setItem(key,JSON.stringify({chapter:id,y:Math.max(0,Math.round(y)),updated:Date.now()}))}catch{}
 };
 const timer=setInterval(()=>{
   const found=detect();if(!found)return;
   active=found;initialized=true;clearInterval(timer);
   const y=wantResume&&saved?.chapter===active?Number(saved.y)||0:0;
   if(y>0){
     requestAnimationFrame(()=>requestAnimationFrame(()=>{
       const max=Math.max(0,(document.scrollingElement?.scrollHeight||0)-innerHeight);
       window.scrollTo({top:Math.min(y,max),left:0,behavior:'instant'});
       save(true);
     }));
   }else save(true);
 },55);
 setTimeout(()=>{if(!initialized)clearInterval(timer)},20000);
 window.addEventListener('scroll',()=>save(),{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)save(true)});
 window.addEventListener('pagehide',()=>save(true));
 window.addEventListener('pageshow',e=>{
   if(e.persisted){leaving=false;save(true)}
 });
})();
