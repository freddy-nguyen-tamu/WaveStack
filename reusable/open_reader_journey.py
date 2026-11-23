"""Provider-independent, additive Open Reader /your-journey statistics assets.

Only modifies the GENERATED Worker assets, never reader/ source files or archives.
"""
from __future__ import annotations
from pathlib import Path

TRACK_JS = r'''/* Open Reader first-party, same-origin visit signals. No cookies or fingerprints. */
(() => {
  'use strict';
  // Respect explicit browser privacy signals. No cross-site tracking.
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return;
  const path = location.pathname;
  const allowed = path==='/' || path==='/index.html' || /^\/(?:your-journey|privacy)\/(?:index\.html)?$/.test(path)
    || /^\/comics\/[a-z0-9-]+\/(?:index\.html|settings\.html|overview\/(?:index\.html)?)?$/.test(path);
  if (!allowed) return;
  function record(kind, chapter_id) {
    const event_id = crypto.randomUUID ? crypto.randomUUID() :
      Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
    const payload = {kind, path, event_id};
    if (chapter_id) payload.chapter_id=chapter_id;
    fetch('/api/journey/track', {method:'POST', credentials:'same-origin', keepalive:true,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(() => {});
  }
  // The event represents an actual page opening, not an image or background API request.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>record('page_view'),{once:true});
  else record('page_view');
  let chapterSent = false, activeChapter = '';
  window.addEventListener('open-reader:chapter-ready',e=>{
    const id=e.detail?.chapterId;
    if(chapterSent || typeof id!=='string' || !id)return;
    chapterSent=true; activeChapter=id;
    record('chapter_read',id);
  });
  // Browser back/forward cache restores are navigations too, without DOMContentLoaded.
  window.addEventListener('pageshow',e=>{
    if(e.persisted){ record('page_view'); if(activeChapter)record('chapter_read',activeChapter); }
  });
})();
'''

JOURNEY_HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Journey · open-reader</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#273440;background:#f6f7f9}
*{box-sizing:border-box}body{margin:0}header{background:#243348;color:#fff;padding:22px max(20px,calc((100% - 1120px)/2))}
header a{color:#e9cf8d;text-decoration:none}h1{font-size:clamp(1.45rem,3vw,2rem);margin:.3em 0}h2{font-size:1.12rem;margin:0 0 12px}
main{max-width:1160px;margin:auto;padding:24px 20px 70px}section{background:#fff;border:1px solid #dfe5ea;border-radius:12px;padding:20px;margin:20px 0;overflow:auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.cards>div{background:#fff;border:1px solid #dfe5ea;border-radius:10px;padding:20px}
.count{font-size:2rem;font-weight:750;font-variant-numeric:tabular-nums}.muted{color:#667789;font-size:.89rem}table{width:100%;border-collapse:collapse;min-width:530px}
th,td{padding:10px;text-align:left;border-bottom:1px solid #e9ecf0;font-size:.91rem}th{color:#52657b;background:#f5f7f9;position:sticky;top:0}
button{background:#243c54;color:#fff;border:0;border-radius:7px;padding:11px 18px;cursor:pointer}button:hover{background:#365676}
input{padding:11px;border:1px solid #bfc8d0;border-radius:6px;max-width:100%;font:inherit}
form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.error{color:#9c281f}.layout{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:16px}.layout section{margin:0}
footer{margin-top:24px;font-size:.86rem;color:#53667c}a{color:#205b86}
</style></head><body><header><a href="/">← Open Reader</a><h1>Your Journey</h1><div>Private readership statistics · visits, chapters, and approximate geography</div></header>
<main><section id="signin"><h2>Administrator sign-in</h2><p class="muted">Individual IP addresses and location details are private. Sign in using the existing Open Reader administrator password.</p>
<form id="login"><input type="password" id="password" required autocomplete="current-password" placeholder="Admin password" aria-label="Admin password"><button type="submit">Unlock stats</button></form><p role="status" id="login-error" class="error"></p></section>
<div id="dashboard" hidden><div class="cards"><div><div class="muted">Website page visits</div><div class="count" id="pages">0</div></div><div><div class="muted">Chapter opens</div><div class="count" id="reads">0</div></div><div><div class="muted">Comics read</div><div class="count" id="works">0</div></div><div><div class="muted">Cities with chapter opens</div><div class="count" id="places">0</div></div></div>
<div class="layout"><section><h2>Readership by comic</h2><table><thead><tr><th>Comic</th><th>Chapter opens</th></tr></thead><tbody id="comics"></tbody></table></section>
<section><h2>Chapter opens by location</h2><table><thead><tr><th>City / region / country</th><th>Opens</th></tr></thead><tbody id="cities"></tbody></table></section></div>
<section><h2>Most-read chapters</h2><table><thead><tr><th>Comic</th><th>Chapter</th><th>Opens</th></tr></thead><tbody id="chapters"></tbody></table></section>
<section><h2>Comics by location</h2><table><thead><tr><th>City</th><th>Comic</th><th>Opens</th></tr></thead><tbody id="comic-cities"></tbody></table></section>
<section><h2>Recent visitor details</h2><p class="muted">Administrator only. IP records are retained for up to 30 days; summary counts remain available afterward. Locations are Cloudflare's approximate network geolocation, not precise GPS coordinates.</p>
<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px"><input id="filter" placeholder="Filter IP, comic, city..." aria-label="Filter visits"><button id="refresh" type="button">Refresh</button></div>
<table><thead><tr><th>UTC time</th><th>Type</th><th>Comic / chapter</th><th>IP</th><th>City</th><th>Region</th><th>Country</th><th>Timezone</th></tr></thead><tbody id="recent"></tbody></table></section>
</div><footer><a href="/privacy/">Privacy information</a> · Counts represent page opens and chapter selections, not unique people or completed chapters.</footer></main>
<script>
(() => {
 const $=id=>document.getElementById(id), fmt=n=>Number(n||0).toLocaleString();let recent=[];
 const cell=(tr,value)=>{let td=document.createElement('td');td.textContent=String(value??'');tr.append(td)};
 const fill=(id,rows,cols)=>{let b=$(id);b.replaceChildren();for(const record of rows){let tr=document.createElement('tr');for(const c of cols)cell(tr,typeof c==='function'?c(record):record[c]);b.append(tr)}if(!rows.length){let tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=cols.length;td.textContent='No visits recorded yet';tr.append(td);b.append(tr)}};
 const loc=r=>[r.city,r.region,r.country].filter(x=>x&&x!=='Unknown').join(', ')||'Unknown';
 const drawRecent=()=>{const term=$('filter').value.trim().toLowerCase();fill('recent',recent.filter(r=>Object.values(r).join(' ').toLowerCase().includes(term)),['created_at','kind',r=>[r.slug,r.chapter].filter(Boolean).join(' / ')||r.path,'ip','city','region','country','timezone'])};
 async function load(){const res=await fetch('/api/journey/stats',{credentials:'same-origin',cache:'no-store'});if(res.status===401){$('signin').hidden=false;$('dashboard').hidden=true;return}const data=await res.json();if(!res.ok)throw Error(data.error||'Statistics unavailable');
 $('signin').hidden=true;$('dashboard').hidden=false;$('pages').textContent=fmt(data.totals.page_view);$('reads').textContent=fmt(data.totals.chapter_read);
 $('works').textContent=fmt(data.comics.filter(x=>Number(x.views)>0).length);$('places').textContent=fmt(data.cities.length);
 fill('comics',data.comics,['slug',r=>fmt(r.views)]);fill('cities',data.cities,[loc,r=>fmt(r.views)]);fill('chapters',data.chapters,['slug','chapter',r=>fmt(r.views)]);
 fill('comic-cities',data.comic_cities,[loc,'slug',r=>fmt(r.views)]);recent=data.recent;drawRecent();}
 $('login').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{const r=await fetch('/api/admin/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});if(!r.ok)throw Error('Sign-in failed ('+r.status+')');$('password').value='';await load()}catch(err){$('login-error').textContent=err.message}});
 $('refresh').addEventListener('click',()=>load().catch(e=>alert(e.message)));$('filter').addEventListener('input',drawRecent);
 load().catch(e=>{$('login-error').textContent=e.message});
})();
</script></body></html>'''

PRIVACY_HTML = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy · Open Reader</title><style>body{font:17px/1.7 system-ui;max-width:720px;margin:5vh auto;padding:0 18px;color:#283749}a{color:#235c88}</style></head><body><a href="/">← Open Reader</a><h1>Visitor statistics and privacy</h1><p>Open Reader records a page visit when a page opens, and a chapter open when a published chapter is selected. These are counts of events, not unique readers or proof that a chapter was finished.</p><p>The Cloudflare Worker records the connecting IP address and approximate city, region, country, and timezone supplied by Cloudflare. This is approximate network-derived location, not GPS. Detailed records are visible only to the site administrator and are retained for up to 30 days; aggregate counts are stored longer. No cross-site analytics service or tracking cookie is used. Browser Global Privacy Control and Do Not Track signals are honored.</p><p><a href="/your-journey/">Your Journey</a></p></body></html>'''


def augment_assets(stage: Path) -> dict:
    """Create two new routes and insert a passive, first-party tracker in HTML.

    Reuses the existing generated reader's selected chapter identity. A
    manifest-unavailable or nonexistent chapter can never be counted as read.
    """
    stage=Path(stage)
    (stage / 'journey-track.js').write_text(TRACK_JS,encoding='utf-8')
    for route,html in [('your-journey',JOURNEY_HTML),('privacy',PRIVACY_HTML)]:
        folder=stage/route;folder.mkdir(parents=True,exist_ok=True)
        (folder/'index.html').write_text(html,encoding='utf-8')
    appfiles=list((stage/'comics').glob('*/app.js')) if (stage/'comics').exists() else []
    hook='  chapter=manifest.chapters[chapterIndex];'
    signal="  window.dispatchEvent(new CustomEvent('open-reader:chapter-ready',{detail:{chapterId:chapter.id}}));"
    for app in appfiles:
        content=app.read_text(encoding='utf-8')
        if signal not in content:
            if content.count(hook)!=1:raise RuntimeError('Generated chapter selection changed; no unsafe tracking injection: '+str(app))
            content=content.replace(hook,hook+'\n'+signal,1)
            app.write_text(content,encoding='utf-8')
    count=0
    for path in stage.rglob('*.html'):
        html=path.read_text(encoding='utf-8')
        script='<script defer src="/journey-track.js"></script>'
        if script not in html:
            if '</head>' not in html:raise RuntimeError('Generated HTML head unavailable: '+str(path))
            html=html.replace('</head>',script+'</head>',1)
        if path==stage/'index.html' and 'href="/your-journey/"' not in html:
            target='<p class="subtitle">Your comic library</p>'
            link='<p class="subtitle">Your comic library <a href="/your-journey/" style="float:right;margin-right:17px;color:#f5d99f;font-weight:650;text-decoration:underline">Your Journey</a> <a href="/privacy/" style="float:right;margin-right:17px;color:#f5d99f;font-size:.75rem">Privacy</a></p>'
            if html.count(target)!=1:raise RuntimeError('Homepage navigation changed; refuse ambiguous route injection')
            html=html.replace(target,link,1)
        path.write_text(html,encoding='utf-8')
        count+=1
    return {'tracked_html_routes':count,'reader_scripts':len(appfiles)}
