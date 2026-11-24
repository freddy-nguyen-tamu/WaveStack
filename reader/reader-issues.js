/* Shared open-reader notifications. Included ONLY on the shared homepage.
 * Counts AFFECTED CHAPTERS, lists exact missing panels, and permits authenticated
 * upload/overwrite of a registered missing-source panel only. Never stores secrets.
 */
(() => {
  'use strict';
  if(!['/','/index.html'].includes(location.pathname))return;
  if(document.getElementById('reader-issues-widget'))return;
  const css=document.createElement('link');
  css.rel='stylesheet';css.href='/reader-issues.css';document.head.append(css);
  const root=document.createElement('aside');
  root.id='reader-issues-widget'; root.setAttribute('aria-label','Missing source panels');
  root.innerHTML=`<button type="button" id="ri-button" aria-label="Source image notifications" aria-expanded="false" aria-controls="ri-popover" title="Source image notifications"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span id="ri-badge" hidden>0</span></button><section id="ri-popover" hidden aria-label="Missing panels"><header><strong>Source image issues</strong><button type="button" id="ri-close" aria-label="Close">×</button></header><p id="ri-summary" role="status">Checking missing panels…</p><div id="ri-list"></div><form id="ri-login" hidden><label>Admin password<input type="password" id="ri-password" autocomplete="current-password" required minlength="1" /></label><div class="ri-login-actions"><button type="submit">Sign in and upload</button><button id="ri-cancel" type="button">Cancel</button></div></form><p id="ri-feedback" role="status" aria-live="polite"></p></section>`;
  document.body.append(root);
  const q=s=>root.querySelector(s), button=q('#ri-button'), badge=q('#ri-badge'), box=q('#ri-popover');
  const list=q('#ri-list'), summary=q('#ri-summary'), login=q('#ri-login'), password=q('#ri-password'), feedback=q('#ri-feedback');
  let lastRefresh=0, pending=null, cases=[], uploadEnabled=false, githubUploads=false, r2Uploads=false;
  const close=()=>{box.hidden=true;button.setAttribute('aria-expanded','false');login.hidden=true;password.value='';pending=null};
  button.onclick=()=>{box.hidden=!box.hidden;button.setAttribute('aria-expanded',String(!box.hidden));if(!box.hidden)refresh(true)};
  q('#ri-close').onclick=close;
  q('#ri-cancel').onclick=()=>{login.hidden=true;pending=null;password.value=''};
  document.addEventListener('pointerdown',e=>{if(!root.contains(e.target))close()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!box.hidden)close()});
  const text=(tag,str,cl)=>{const x=document.createElement(tag);x.textContent=str;if(cl)x.className=cl;return x};
  const groupKey=c=>`${c.work_slug}\u0000${c.episode_id}`;
  const setStatus=str=>{feedback.textContent=str};
  // Mixed formats are valid in one chapter. Keep JPEG/PNG/WebP in their
  // original format; convert any OTHER browser-decodable raster to PNG.
  async function normalizedPanelFile(file){
    const mime=String(file?.type||'').toLowerCase();
    if(['image/jpeg','image/png','image/webp'].includes(mime)){
      // Validate actual browser decoding, not just filename or magic bytes.
      // A truncated PNG can pass a signature check but fail every reader.
      if(typeof createImageBitmap==='function'){
        let decoded;
        try{decoded=await createImageBitmap(file)}
        catch{throw Error('This image cannot be decoded by the browser. Export a valid PNG/JPEG/WebP and retry.');}
        try{if(!decoded.width||!decoded.height)throw Error('Decoded image has no pixels');}
        finally{decoded.close()}
      }
      return file;
    }
    if(mime==='image/svg+xml')throw Error('SVG is not accepted as a panel image');
    if(!file || (mime && !mime.startsWith('image/')) || typeof createImageBitmap!=='function')
      throw Error('This file cannot be decoded as an image by this browser');
    let bitmap;
    try{bitmap=await createImageBitmap(file)}
    catch{throw Error('Browser cannot decode this image format. Convert it to PNG/JPEG/WebP before upload.');}
    try{
      if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>50000000)
        throw Error('Image dimensions exceed the safe 50-megapixel conversion limit');
      const canvas=document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');
      if(!ctx)throw Error('Canvas decoder unavailable');
      ctx.drawImage(bitmap,0,0);
      const converted=await new Promise((resolve,reject)=>
        canvas.toBlob(blob=>blob?resolve(blob):reject(Error('PNG conversion failed')),'image/png'));
      if(converted.size>12*1024*1024)throw Error('PNG conversion exceeds 12 MiB. Resize or export a JPEG before uploading.');
      return new File([converted],String(file.name||'replacement')+'.png',{type:'image/png'});
    }finally{bitmap.close()}
  }
  async function upload(c,file,secondTry=false) {
    if(!file)return;
    if(file.size>25*1024*1024 || file.size<32){
      setStatus('Choose a valid image no larger than 25 MiB for conversion.');return;
    }
    if(!uploadEnabled){setStatus('Replacement uploads are not configured on the Worker.');return;}
    setStatus(`Uploading ${c.work}, ${c.episode}, panel ${c.panel}…`);
    try {
      // Select precisely one backend; GitHub is preferred where available.
      // Do not mask GitHub errors by falling back to R2.
      const route=githubUploads ? '/api/admin/github-image/'+[
        c.work_slug,String(c.episode_id),String(c.panel)].map(encodeURIComponent).join('/')
        : '/api/panel-replacements/'+encodeURIComponent(c.id);
      const body=await normalizedPanelFile(file);
      const r=await fetch(route,{
        method:'POST',body,headers:{'Content-Type':body.type,'X-Reader-Upload':'1'},credentials:'same-origin',cache:'no-store'
      });
      if(r.status===401 && !secondTry){pending={c,file};login.hidden=false;password.focus();setStatus('Admin sign-in required to upload replacements.');return;}
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(data.error || `Upload failed: HTTP ${r.status}`);
      pending=null;login.hidden=true;password.value='';setStatus(data.readback_verified?'Replacement saved and independently verified; open chapter updates automatically.':'Replacement saved. Open chapter will check for the new image.');
      // OPEN_READER_INSTANT_UPLOAD_SIGNAL_V1: tell already-open same-origin
      // chapter tabs to re-check the published manifest, never trust user data.
      const signal={slug:c.work_slug,chapter:String(c.episode_id),panel:Number(c.panel),at:Date.now()};
      try{
        if(typeof BroadcastChannel==='function'){
          const channel=new BroadcastChannel('open-reader-panel-repairs-v1');
          channel.postMessage(signal);channel.close();
        }
      }catch(error){console.debug('Reader upload channel unavailable',String(error))}
      try{localStorage.setItem('open-reader:panel-repaired',JSON.stringify(signal));}
      catch(error){console.debug('Reader upload storage signal unavailable',String(error))}
      await refresh(true);
    } catch(err){setStatus(String(err?.message||err));}
  }
  login.onsubmit=async e=>{
    e.preventDefault();
    const pass=password.value;
    password.value='';
    if(!pending || !pass)return;
    try{
      const response=await fetch('/api/admin/login',{
        method:'POST',headers:{'Content-Type':'application/json','X-Reader-Upload':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({password:pass})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||`Login failed: HTTP ${response.status}`);
      const saved=pending;await upload(saved.c,saved.file,true);
    }catch(err){login.hidden=false;setStatus(String(err?.message||err));}
  };
  function draw(next){
    cases=next;
    const groups=new Map();
    for(const c of cases){const k=groupKey(c);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c)}
    const n=groups.size;
    badge.hidden=n===0;badge.textContent=n>99?'99+':String(n);
    button.setAttribute('aria-label',`${n} chapter${n===1?'':'s'} with source image issues`);
    summary.textContent=n?`${n} affected chapter${n===1?'':'s'} · ${cases.length} source-missing panel${cases.length===1?'':'s'}`:'No reported source-missing panels.';
    list.replaceChildren();
    const frag=document.createDocumentFragment();
    for(const issues of groups.values()){
      const first=issues[0];
      const group=text('section','', 'ri-chapter');
      const heading=text('div',`${first.work} · ${first.episode}`,'ri-chapter-title');
      group.append(heading);
      const hint=text('p',`Missing panel${issues.length===1?'':'s'}: ${issues.map(c=>c.panel).sort((a,b)=>a-b).join(', ')}`,'ri-chapter-hint');
      group.append(hint);
      // Two independent destinations: never label an external source link
      // as an Open Reader chapter. Keep both links side by side.
      const actions=document.createElement('div');actions.className='ri-chapter-actions';
      if(typeof first.source_chapter_url==='string'){
        try{
          const u=new URL(first.source_chapter_url);
          if(u.protocol==='https:' && u.hostname && !u.username && !u.password){
            const source=text('a','Open original source','ri-chapter-link ri-source-link');
            source.href=u.href;source.target='_blank';source.rel='noopener noreferrer';
            source.title='Open the original publisher chapter in a new tab';
            actions.append(source);
          }
        }catch{}
      }
      if(/^[a-z0-9-]+$/.test(first.work_slug) && /^[A-Za-z0-9_.-]+$/.test(first.episode_id)){
        const reader=text('a','Open affected chapter','ri-chapter-link ri-reader-link');
        reader.href='/comics/'+encodeURIComponent(first.work_slug)+'/?chapter='+encodeURIComponent(first.episode_id);
        reader.title='Open this exact chapter inside Open Reader';
        actions.append(reader);
      }
      if(actions.childElementCount)group.append(actions);
      for(const c of issues){
        const ordinal=Number(c.panel);
        if(!Number.isSafeInteger(ordinal)||ordinal<=0)continue;
        const line=text('div','','ri-panel');
        const status=Number(c.http_status);
        const reason=c.replacement_present?' · replacement saved':
          (Number.isInteger(status)&&status>=400&&status<=599?' · confirmed HTTP '+status:
           ' · confirmed original placeholder');
        const display=text('span','Panel '+ordinal+reason,'ri-panel-label');
        line.append(display);
        const chooser=document.createElement('input');chooser.type='file';chooser.accept='image/*';chooser.hidden=true;
        chooser.setAttribute('aria-label',`Replacement image for ${c.work} ${c.episode} panel ${c.panel}`);
        chooser.onchange=()=>{const file=chooser.files?.[0];if(file)upload(c,file);chooser.value=''};
        const action=text('button',c.replacement_present?'Replace again':'Upload replacement','ri-upload');action.type='button';
        action.disabled=!uploadEnabled;
        action.title=uploadEnabled ? (githubUploads?'Upload a verified replacement to private GitHub':'Upload a verified replacement to R2') : 'Administrator must configure storage and sign-in';
        action.onclick=()=>chooser.click();
        line.append(action,chooser);group.append(line);
      }
      frag.append(group);
    }
    list.append(frag);
  }
  async function refresh(force=false){
    if(!force && Date.now()-lastRefresh<30000)return;
    lastRefresh=Date.now();
    try{
      const response=await fetch('/source-issues.json',{cache:'no-store',credentials:'same-origin'});
      if(!response.ok)throw new Error('Issue feed unavailable (HTTP '+response.status+')');
      const feed=await response.json();
      if(feed.schema!=='comicarchiver.source_issue_feed.v1'||!Array.isArray(feed.cases))throw new Error('Invalid source issue feed');
      // The feed's upload_enabled flag is not an R2 capability check.
      // Keep issues visible if health temporarily cannot be queried.
      let health=null;
      try {
        const healthResponse=await fetch('/api/reader-health',{cache:'no-store',credentials:'same-origin'});
        if(healthResponse.ok) health=await healthResponse.json();
      } catch (_) { /* health diagnostics are best effort */ }
      githubUploads=health?.github_streaming_configured===true;
      r2Uploads=health?.storage_configured===true;
      uploadEnabled=Boolean(feed.upload_enabled)&&(githubUploads||r2Uploads);
      draw(feed.cases.filter(c=>c && c.status==='source_server_unavailable' && typeof c.work==='string' && typeof c.work_slug==='string' && typeof c.episode_id==='string' && Number.isInteger(c.panel) && c.panel>0 && /^[a-f0-9]{20}$/.test(c.id)));
    }catch(err){summary.textContent=String(err?.message||err)}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  window.addEventListener('pageshow',()=>refresh());
  refresh(true);
  window.OpenReaderIssues={refresh};
})();
