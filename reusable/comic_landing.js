/* Reusable catalogue landing, not loaded by the image-only chapter reader. */
(() => {
 'use strict';
 const root=document.documentElement;
 const match=location.pathname.match(/^\/comics\/([a-z0-9-]+)\/overview\/(?:index\.html)?$/);
 if(!match)return;
 const slug=match[1];
 const storageKey='open-reader:progress:v1:'+slug;
 const $=s=>document.querySelector(s);
 const chapterUrl=id=>'/comics/'+encodeURIComponent(slug)+'/?chapter='+encodeURIComponent(id);
 let saved={};
 try{const v=JSON.parse(localStorage.getItem(storageKey)||'{}');if(v&&typeof v==='object')saved=v}catch{}
 let chapters=[];
 function navigateChapter(event) {
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
   const anchor=event.currentTarget;
   if(!anchor.href||!anchor.href.startsWith(location.origin+'/comics/'))return;
   event.preventDefault();
   const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
   if(reduced){location.assign(anchor.href);return}
   if(root.classList.contains('is-turning'))return;
   root.classList.add('is-turning');
   window.setTimeout(()=>location.assign(anchor.href),500);
 }
 function attachLink(a){a.addEventListener('click',navigateChapter)}
 function render(){
   const q=$('#chapter-search').value.trim().toLocaleLowerCase();
   const list=$('#chapter-list');list.replaceChildren();
   let n=0;
   for(const ch of chapters){
     const label=String(ch.title||ch.label||'Chapter '+ch.id).trim();
     if(q&&!`${label} ${ch.id} ${ch.number||''}`.toLocaleLowerCase().includes(q))continue;
     const a=document.createElement('a');a.className='chapter-card'+(ch.id===saved.chapter?' is-current':'');
     a.href=chapterUrl(ch.id);
     const title=document.createElement('strong');title.textContent=label;
     const hint=document.createElement('span');hint.textContent=ch.id===saved.chapter?'Continue here · Open chapter':'Read chapter';
     a.append(title,hint);attachLink(a);list.append(a);n++;
   }
   if(!n){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching chapters';list.append(empty)}
   $('#chapter-count').textContent=chapters.length+' chapters';
 }
 fetch('../manifest.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Manifest unavailable (HTTP '+r.status+')');return r.json()}).then(data=>{
   if(!Array.isArray(data.chapters)||!data.chapters.length)throw Error('No published chapters');
   chapters=data.chapters.filter(x=>x&&typeof x.id==='string'&&x.id);
   const title=String(data.title||slug.replace(/-/g,' '));
   document.title=title+' · open-reader';
   $('#comic-title').textContent=title;
   $('#breadcrumb-title').textContent=title;
   $('#read-start').href=chapterUrl(chapters[0].id);
   const found=chapters.find(ch=>ch.id===saved.chapter);
   const cont=$('#continue');
   if(found){
     cont.href=chapterUrl(found.id)+'&resume=1';
     cont.removeAttribute('aria-disabled');
     $('#resume-note').textContent='Saved on this device · '+String(found.title||found.label||'Chapter '+found.id);
   }else{
     cont.setAttribute('aria-disabled','true');cont.removeAttribute('href');
     $('#resume-note').textContent='Continue reading becomes available after you open a chapter on this device.';
   }
   $('#chapter-search').addEventListener('input',render);attachLink($('#read-start'));attachLink(cont);
   render();
 }).catch(e=>{$('#chapter-list').textContent='Unable to load chapters: '+String(e.message||e)});
})();
