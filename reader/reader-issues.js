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
  let lastRefresh=0, pending=null, cases=[], uploadEnabled=false;
  const close=()=>{box.hidden=true;button.setAttribute('aria-expanded','false');login.hidden=true;password.value='';pending=null};
  button.onclick=()=>{box.hidden=!box.hidden;button.setAttribute('aria-expanded',String(!box.hidden));if(!box.hidden)refresh(true)};
  q('#ri-close').onclick=close;
  q('#ri-cancel').onclick=()=>{login.hidden=true;pending=null;password.value=''};
  document.addEventListener('pointerdown',e=>{if(!root.contains(e.target))close()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!box.hidden)close()});
  const text=(tag,str,cl)=>{const x=document.createElement(tag);x.textContent=str;if(cl)x.className=cl;return x};
  const groupKey=c=>`${c.work_slug}\u0000${c.episode_id}`;
  const setStatus=str=>{feedback.textContent=str};
  async function upload(c,file,secondTry=false) {
    if(!file)return;
    // The GitHub-only homepage uploader is additive. It writes to the verified
    // panel slot instead of the legacy R2 replacement endpoint.
    if(window.OpenReaderGithubUpload){
      await window.OpenReaderGithubUpload.uploadIssue(c,file);
      return;
    }
    if(!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>12*1024*1024 || file.size<32) {
      setStatus('Choose a JPEG, PNG or WebP image up to 12 MiB.');return;
    }
    if(!uploadEnabled){setStatus('Uploads are not configured. An administrator must enable R2 and Worker secrets.');return;}
    setStatus(`Uploading ${c.work}, ${c.episode}, panel ${c.panel}…`);
    try {
      const r=await fetch('/api/panel-replacements/'+encodeURIComponent(c.id),{
        method:'POST',body:file,headers:{'Content-Type':file.type,'X-Reader-Upload':'1'},credentials:'same-origin',cache:'no-store'
      });
      if(r.status===401 && !secondTry){pending={c,file};login.hidden=false;password.focus();setStatus('Admin sign-in required to upload replacements.');return;}
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(data.error || `Upload failed: HTTP ${r.status}`);
      pending=null;login.hidden=true;password.value='';setStatus('Replacement saved. You may select the same panel again to overwrite it.');
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
      // A source-missing chapter may not be published yet. In that case
      // link to its actual source chapter rather than a nonexistent reader
      // route. For published missing-panel cases use the reader query route.
      let destination='';
      const published=window.OpenReaderGithubUpload?.hasChapter?.(first.work_slug,first.episode_id);
      if(published && /^[a-z0-9-]+$/.test(first.work_slug) && /^[A-Za-z0-9_.-]+$/.test(first.episode_id)){
        destination='/comics/'+encodeURIComponent(first.work_slug)+'/?chapter='+encodeURIComponent(first.episode_id);
      }
      if(!destination && typeof first.source_chapter_url==='string'){
        try{const u=new URL(first.source_chapter_url);if(u.protocol==='https:' && !u.username && !u.password){destination=u.href}}catch{}
      }
      if(!destination && !window.OpenReaderGithubUpload && /^[a-z0-9-]+$/.test(first.work_slug) && /^[A-Za-z0-9_.-]+$/.test(first.episode_id)){
        destination='/comics/'+encodeURIComponent(first.work_slug)+'/?chapter='+encodeURIComponent(first.episode_id);
      }
      if(destination){
        const link=text('a','Open affected chapter','ri-chapter-link');link.href=destination;
        if(destination.startsWith('https://')){link.target='_blank';link.rel='noopener noreferrer'}
        group.append(link);
      }
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
        const chooser=document.createElement('input');chooser.type='file';chooser.accept='image/jpeg,image/png,image/webp';chooser.hidden=true;
        chooser.setAttribute('aria-label',`Replacement image for ${c.work} ${c.episode} panel ${c.panel}`);
        chooser.onchange=()=>{const file=chooser.files?.[0];if(file)upload(c,file);chooser.value=''};
        const action=text('button',c.replacement_present?'Replace again':'Upload replacement','ri-upload');action.type='button';
        action.disabled=!uploadEnabled;
        action.title=uploadEnabled?'Upload a verified replacement':'Administrator must enable R2 and Worker secrets';
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
      uploadEnabled=Boolean(feed.upload_enabled);
      draw(feed.cases.filter(c=>c && c.status==='source_server_unavailable' && typeof c.work==='string' && typeof c.work_slug==='string' && typeof c.episode_id==='string' && Number.isInteger(c.panel) && c.panel>0 && /^[a-f0-9]{20}$/.test(c.id)));
    }catch(err){summary.textContent=String(err?.message||err)}
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  window.addEventListener('pageshow',()=>refresh());
  refresh(true);
  window.OpenReaderIssues={refresh};
})();
