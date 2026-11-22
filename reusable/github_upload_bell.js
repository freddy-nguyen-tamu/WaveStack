/* Homepage-only additive panel uploader. The existing notification bell, issue
   feed, login, and per-comic reader pages remain untouched. */
(() => {
  'use strict';
  const boot=async()=>{
    const pop=document.getElementById('ri-popover');
    if(!pop || document.getElementById('gh-upload-panel'))return;
    const panel=document.createElement('section');panel.id='gh-upload-panel';
    panel.style.cssText='padding:12px 16px;border-bottom:1px solid #ffffff25;display:grid;gap:9px;color:#e9edf6';
    const heading=document.createElement('strong');heading.textContent='Repair a chapter panel · GitHub';
    const help=document.createElement('p');help.textContent='Upload a missing or damaged image. The file is saved in private GitHub, never in Cloudflare image storage.';
    help.style.cssText='margin:0;font-size:12px;color:#b9c2d6';
    const makeSelect=(label)=>{
      const wrapper=document.createElement('label');wrapper.style.cssText='display:grid;gap:4px;font-size:12px';wrapper.append(document.createTextNode(label));
      const element=document.createElement('select');element.style.cssText='width:100%;padding:8px;border:1px solid #64748b;border-radius:7px;background:#0d1727;color:#fff';
      wrapper.append(element);panel.append(wrapper);return element;
    };
    panel.append(heading,help);
    const work=makeSelect('Comic');const chapter=makeSelect('Chapter');const ordinal=makeSelect('Image / panel');
    const shortcut=document.createElement('a');shortcut.textContent='Open selected chapter';
    shortcut.style.cssText='font-size:12px;color:#9ad7f4;text-decoration:underline';
    const updateShortcut=()=>{
      const slug=work.value,id=chapter.value;
      if(!/^[a-z0-9-]+$/.test(slug)||! /^[A-Za-z0-9_.-]+$/.test(id)){
        shortcut.removeAttribute('href');shortcut.hidden=true;return;
      }
      shortcut.hidden=false;
      shortcut.href='/comics/'+encodeURIComponent(slug)+'/?chapter='+encodeURIComponent(id);
    };
    panel.append(shortcut);
    const uploader=document.createElement('input');uploader.type='file';uploader.accept='image/jpeg,image/png,image/webp';uploader.style.maxWidth='100%';
    const password=document.createElement('input');password.type='password';password.placeholder='Admin password (if prompted)';password.autocomplete='current-password';
    password.hidden=true;password.style.cssText='padding:8px;border:1px solid #64748b;border-radius:7px;background:#0d1727;color:#fff';
    const submit=document.createElement('button');submit.type='button';submit.textContent='Save replacement to GitHub';
    submit.style.cssText='border:1px solid #75a2a1;background:#166358;color:white;border-radius:7px;padding:8px;cursor:pointer';
    const status=document.createElement('p');status.setAttribute('role','status');status.style.cssText='margin:0;font-size:12px;color:#a9dee4;overflow-wrap:anywhere';
    panel.append(uploader,password,submit,status);
    const summary=pop.querySelector('#ri-summary');
    if(summary)summary.after(panel);else pop.append(panel);
    const fill=(sel,items,toLabel,toValue)=>{
      sel.replaceChildren();for(const item of items){const o=document.createElement('option');o.value=toValue(item);o.textContent=toLabel(item);sel.append(o)};
    };
    let comics=[];
    function chooseComic(){const found=comics.find(c=>c.slug===work.value);fill(chapter,found?.chapters||[],x=>x.title||x.id,x=>x.id);chooseChapter();updateShortcut()}
    function chooseChapter(){const found=comics.find(c=>c.slug===work.value)?.chapters.find(c=>c.id===chapter.value);
      fill(ordinal,Array.from({length:Math.min(found?.count||0,2000)},(_,i)=>i+1),x=>'Panel '+x,x=>String(x));updateShortcut()}
    work.addEventListener('change',chooseComic);chapter.addEventListener('change',chooseChapter);
    async function signIn(){
      if(!password.value){password.hidden=false;password.focus();status.textContent='Enter the admin password, then submit again.';return false}
      const r=await fetch('/api/admin/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:password.value})});
      password.value='';const data=await r.json().catch(()=>({}));
      if(!r.ok){status.textContent=data.error||'Admin login failed';return false}
      password.hidden=true;return true;
    }
    async function push(retry=false){
      const file=uploader.files?.[0];
      if(!file || !['image/png','image/jpeg','image/webp'].includes(file.type) || file.size<32 || file.size>12*1024*1024){
        status.textContent='Select a JPEG, PNG or WebP image (max 12 MiB).';return;
      }
      if(!work.value||!chapter.value||!ordinal.value){status.textContent='Select a comic, chapter, and panel.';return}
      submit.disabled=true;status.textContent='Saving to private GitHub…';
      try{
        const route='/api/admin/github-image/'+[work.value,chapter.value,ordinal.value].map(encodeURIComponent).join('/');
        const response=await fetch(route,{method:'POST',body:file,headers:{'Content-Type':file.type},credentials:'same-origin'});
        if(response.status===401 && !retry){
          submit.disabled=false;return await signIn()&&push(true);
        }
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw Error(data.error||'Upload failed: HTTP '+response.status);
        status.textContent='Verified panel saved to GitHub. Its image appears on the next chapter refresh.';
        uploader.value='';window.OpenReaderIssues?.refresh?.(true);
      }catch(e){status.textContent=String(e.message||e)}finally{submit.disabled=false}
    }
    submit.onclick=()=>push(false);
    window.OpenReaderGithubUpload = {
      hasChapter(slug,id){return !!comics.find(x=>x.slug===slug)?.chapters?.some(x=>x.id===id)},
      async uploadIssue(c,file){
        const cFound=comics.find(x=>x.slug===c.work_slug),ch=cFound?.chapters?.find(x=>x.id===c.episode_id);
        if(!ch || !(c.panel>0 && c.panel<=ch.count)){
          status.textContent='This chapter has not been published with a verified panel slot yet. The archived reader cannot replace it.';
          return false;
        }
        work.value=c.work_slug;chooseComic();chapter.value=c.episode_id;chooseChapter();ordinal.value=String(c.panel);
        updateShortcut();
        // Use the exact registered chapter/panel, not any filename from the browser.
        const dt=new DataTransfer();dt.items.add(file);uploader.files=dt.files;
        await push(false);return true;
      },
      selectChapter(slug,id,panel){
        if(!comics.some(x=>x.slug===slug))return false;
        work.value=slug;chooseComic();chapter.value=id;chooseChapter();
        if(panel)ordinal.value=String(panel);updateShortcut();return true;
      }
    };
    try{
      const r=await fetch('/upload-catalog.json',{cache:'no-store'});
      if(!r.ok)throw Error('Upload catalog unavailable');
      const data=await r.json();if(data.schema!=='github-upload-catalog-v1'||!Array.isArray(data.comics))throw Error('Invalid upload catalog');
      comics=data.comics;fill(work,comics,x=>x.title,x=>x.slug);chooseComic();
      window.OpenReaderIssues?.refresh?.(true);
    }catch(e){status.textContent=String(e.message||e);submit.disabled=true}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
