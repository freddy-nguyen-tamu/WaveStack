import { manualRoute } from './manual_import_worker.mjs';
import { arcadeRoute } from './arcade_worker.mjs';
import { journeyRoute, journeyConfigured, archiveJourneyEvents } from './journey_worker.mjs';
/* Cloudflare Worker entrypoint for the EXISTING shared-reader assets.
 * Required bindings: env.ASSETS (Workers static assets), env.PANEL_REPLACEMENTS
 * (R2 bucket), secrets READER_ADMIN_PASSWORD and READER_SESSION_HMAC_KEY.
 * Only pre-existing source-issue case IDs can be replaced. Never permits
 * arbitrary chapter or archive modification. No client-side credentials.
 */
const MAX_BYTES = 12 * 1024 * 1024;
// Long-lived signed site-wide session, renewed only near expiration.
const SESSION_SECONDS = 90 * 24 * 3600;
const RENEW_WITHIN_SECONDS = 30 * 24 * 3600;
const esc = encodeURIComponent;
const te = new TextEncoder();
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const error = (message, status) => json({ok:false,error:message},status);
const originOf = req => new URL(req.url).origin;
const base64url = array => btoa(String.fromCharCode(...array)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
const timingEqual = (a,b) => {
  if (a.length !== b.length) return false;
  let out=0;
  for(let i=0;i<a.length;i++) out |= a[i]^b[i];
  return out===0;
};
const sha = async str => new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(str)));
const hmac = async (key,str) => {
  const k=await crypto.subtle.importKey('raw',te.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC',k,te.encode(str))));
};
const cookies = req => Object.fromEntries((req.headers.get('Cookie')||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{let i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
async function validSession(req,env) {
  if (!env.READER_SESSION_HMAC_KEY) return false;
  const jar=cookies(req);
  for(const [value,purpose] of [[jar.reader_site,'reader-site:v2'],[jar.reader_admin,'reader-panel-admin:v1']]){
    if(!value)continue;
    const [expiry,sig,extra]=value.split('.');
    if(extra || !/^\d{10,13}$/.test(expiry) || !sig || Number(expiry)<Math.floor(Date.now()/1000))continue;
    const expected=await hmac(env.READER_SESSION_HMAC_KEY,expiry+':'+purpose);
    if(timingEqual(te.encode(sig),te.encode(expected)))return true;
  }
  return false;
}
// Existing reader_admin cookies are accepted to migrate an already signed-in
// user, but the site-wide cookie uses a distinct name and a new HMAC purpose.
async function issueSiteCookie(env){
  const expiry=String(Math.floor(Date.now()/1000)+SESSION_SECONDS);
  const signature=await hmac(env.READER_SESSION_HMAC_KEY,expiry+':reader-site:v2');
  return `reader_site=${expiry}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}
async function sessionResponse(req,env){
  if(!await validSession(req,env))return error('Sign-in required',401);
  return json({ok:true,authenticated:true},200,{'Set-Cookie':await issueSiteCookie(env)});
}
const logoutCookie='reader_site=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
const SITE_LOGIN_HTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Open Reader</title><style>
:root{color-scheme:light;font:16px Arial,Helvetica,system-ui,sans-serif;--or-ink:#0f1111;--or-muted:#565959;--or-header:#131921;--or-navigation:#232f3e;--or-accent:#ff9900;--or-accent-soft:#febd69;--or-border:#d5d9d9;--or-canvas:#eaeded}
*{box-sizing:border-box}body{min-height:100dvh;margin:0;background:linear-gradient(to bottom,var(--or-header) 0,var(--or-header) 76px,var(--or-navigation) 76px,var(--or-navigation) 113px,var(--or-canvas) 113px,var(--or-canvas) 100%);color:var(--or-ink);display:grid;place-items:center;padding:24px}
main{width:min(100%,440px);padding:28px 29px 32px;background:#fff;border:1px solid var(--or-border);border-radius:7px;box-shadow:0 6px 25px #0f111122;position:relative;overflow:hidden}
main::before{content:"";height:5px;position:absolute;inset:0 0 auto;background:linear-gradient(90deg,var(--or-accent),var(--or-accent-soft),#d9e4e8)}
h1{font-size:clamp(25px,3.2vw,33px);font-weight:800;letter-spacing:-.035em;margin:2px 0 12px}h1::before{content:"";display:inline-block;width:16px;height:22px;margin-right:11px;border:2px solid var(--or-accent);border-left-width:6px;border-radius:2px 4px 4px 2px;transform:skewY(-4deg)}
p{font-size:14px;color:var(--or-muted);line-height:1.55;margin:0 0 22px}
label{display:block;font-size:13px;font-weight:700;margin:0 0 7px}
input,button{font:inherit;width:100%;min-height:44px}
input{background:#fff;color:var(--or-ink);border:2px solid #aeb4b4;border-radius:5px;padding:10px 13px}
input:focus-visible{border-color:var(--or-accent);outline:3px solid #ff990055}
button{background:#ffd814;color:var(--or-ink);border:1px solid #c89411;border-radius:22px;font-weight:700;cursor:pointer;margin-top:16px}
button:hover{filter:brightness(.96)}button:focus-visible{outline:3px solid var(--or-accent);outline-offset:3px}button:disabled{opacity:.7;cursor:wait}
#error{min-height:1.4em;color:#a42517;margin:10px 0 0}
@media(max-width:480px){body{padding:12px}main{padding:24px 20px 26px}}
</style></head><body><main><h1>Open Reader</h1><p>Sign in once to access the library, chapters, and Your Journey. Your session stays signed in across browser restarts.</p><form id="login"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" autofocus required><button>Sign in</button></form><p id="error" role="status"></p></main><script>
const dest=(()=>{const x=new URLSearchParams(location.search).get('next')||'/';try{const u=new URL(x,location.origin);return u.origin===location.origin&&u.pathname!=='/login/'&&u.pathname!=='/login'?u.pathname+u.search+u.hash:'/'}catch{return '/'}})();
fetch('/api/admin/session',{credentials:'same-origin',cache:'no-store'}).then(r=>{if(r.ok)location.replace(dest)}).catch(()=>{});
document.getElementById('login').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;f.querySelector('button').disabled=true;document.getElementById('error').textContent='';try{const response=await fetch('/api/admin/login',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});if(!response.ok)throw Error(response.status===401?'Incorrect password':'Sign-in unavailable');document.getElementById('password').value='';location.replace(dest)}catch(err){document.getElementById('error').textContent=err.message;f.querySelector('button').disabled=false}};
</script></body></html>`;
function loginPage(){return new Response(SITE_LOGIN_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
function unauthenticated(req){
  const u=new URL(req.url);
  if(req.method==='GET' || req.method==='HEAD'){
    const isPage=u.pathname==='/' || u.pathname.endsWith('/') || u.pathname.endsWith('.html');
    if(isPage){const next=u.pathname+u.search;const location='/login/?next='+encodeURIComponent(next);
      return new Response(null,{status:302,headers:{Location:location,'Cache-Control':'no-store'}});}
  }
  return error('Sign-in required',401);
}
async function renewIfNeeded(req,env,response){
  const jar=cookies(req);let shouldRenew=!jar.reader_site;
  if(jar.reader_site){const expiry=Number(jar.reader_site.split('.')[0]);shouldRenew=Number.isFinite(expiry)&&expiry-Math.floor(Date.now()/1000)<RENEW_WITHIN_SECONDS;}
  if(!shouldRenew)return response;
  const headers=new Headers(response.headers);
  headers.set('Set-Cookie',await issueSiteCookie(env));
  // Authenticated resources must not leak from intermediary caches before gate.
  if(/text\/html/i.test(headers.get('Content-Type')||''))headers.set('Cache-Control','private, no-store');
  return new Response(response.body,{status:response.status,headers});
}
const sameOriginPost = req => {
  const o=req.headers.get('Origin');
  return o && o===originOf(req);
};
async function boundedBody(req) {
  if(!req.body)return null;
  const reader=req.body.getReader(), parts=[];
  let size=0;
  try {
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES) { await reader.cancel('Image exceeds 12 MiB'); return null; }
      parts.push(value);
    }
  } finally { try{reader.releaseLock()}catch{} }
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
  return bytes;
}
const images = {
  'image/jpeg': bytes => bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff,
  'image/png': bytes => [137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x),
  'image/webp': bytes => String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP',
};
const isId = id => /^[a-f0-9]{20}$/.test(id||'');
const feedRequest = req => new Request(new URL('/source-issues.json',req.url),{method:'GET'});
async function baseCases(req,env) {
  const response=await env.ASSETS.fetch(feedRequest(req));
  if(!response.ok) return {cases:[],resolved:new Set()};
  let data;
  try{data=await response.json()}catch{return {cases:[],resolved:new Set()}}
  if(data?.schema!=='comicarchiver.source_issue_feed.v1' || !Array.isArray(data.cases))return {cases:[],resolved:new Set()};
  const resolved=new Set((Array.isArray(data.resolved_ids)?data.resolved_ids:[]).filter(isId));
  return {cases:data.cases.filter(x=>x?.status==='source_server_unavailable' && isId(x.id) && !resolved.has(x.id)),resolved};
}
async function casesAndHistory(req,env) {
  const base=await baseCases(req,env), byId=new Map(base.cases.map(c=>[c.id,c]));
  if(env.PANEL_REPLACEMENTS) {
    let cursor;
    do {
      const list=await env.PANEL_REPLACEMENTS.list({prefix:'history/',cursor,limit:500});
      for(const item of list.objects) {
        const stored=await env.PANEL_REPLACEMENTS.get(item.key);
        if(!stored)continue;
        try{const c=await stored.json();if(c && isId(c.id) && !base.resolved.has(c.id) && !byId.has(c.id) && c.status==='source_server_unavailable')byId.set(c.id,c)}catch{}
      }
      cursor=list.truncated ? list.cursor : undefined;
    } while(cursor);
  }
  return [...byId.values()].sort((a,b)=>`${a.work}\x00${a.episode_id}\x00${a.panel}`.localeCompare(`${b.work}\x00${b.episode_id}\x00${b.panel}`));
}
async function issuesResponse(req,env) {
  const cases=await casesAndHistory(req,env);
  let githubOverrides={};
  if(githubConfigured(env)){
    try{githubOverrides=await getOverrides(env)}
    catch(e){return error('GitHub repair index temporarily unavailable: '+e.message,503)}
  }
  const enriched=await Promise.all(cases.map(async c=>{
    const record=githubOverrides[overrideKey(c.work_slug,String(c.episode_id),Number(c.panel))];
    const replacement=(record || !env.PANEL_REPLACEMENTS) ? null : await env.PANEL_REPLACEMENTS.head('panels/'+c.id);
    return {...c,replacement_present:!!record||!!replacement,
      replacement_sha256:record?.sha256||replacement?.customMetadata?.sha256||null};
  }));
  const chapters=new Set(cases.map(c=>c.work_slug+'\x00'+c.episode_id));
  return json({schema:'comicarchiver.source_issue_feed.v1',count:enriched.length,affected_chapters:chapters.size,affected_works:new Set(cases.map(c=>c.work_slug)).size,
    upload_enabled:!!((githubConfigured(env)||env.PANEL_REPLACEMENTS) && typeof env.READER_ADMIN_PASSWORD==='string' && env.READER_ADMIN_PASSWORD.length>=20 && typeof env.READER_SESSION_HMAC_KEY==='string' && env.READER_SESSION_HMAC_KEY.length>=32),cases:enriched});
}
async function login(req,env) {
  if(!sameOriginPost(req))return error('Same-origin request required',403);
  if(typeof env.READER_ADMIN_PASSWORD!=='string' || env.READER_ADMIN_PASSWORD.length<20 || typeof env.READER_SESSION_HMAC_KEY!=='string' || env.READER_SESSION_HMAC_KEY.length<32)return error('Admin credentials are not configured',503);
  let body;
  try{body=await req.json()}catch{return error('Invalid JSON',400)}
  const given=typeof body?.password==='string'?body.password.slice(0,4096):'';
  if(!given || !timingEqual(await sha(given),await sha(env.READER_ADMIN_PASSWORD)))return error('Invalid credentials',401);
  return json({ok:true,expires_in:SESSION_SECONDS,scope:'site'},200,{'Set-Cookie':await issueSiteCookie(env)});
}
async function upload(req,env,id) {
  if(!sameOriginPost(req))return error('Same-origin request required',403);
  if(!env.PANEL_REPLACEMENTS)return error('Upload storage unavailable',503);
  if(!await validSession(req,env))return error('Admin sign-in required',401);
  const cases=await casesAndHistory(req,env), issue=cases.find(c=>c.id===id);
  if(!issue)return error('Not a registered missing-source panel',404);
  const contentType=(req.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
  if(!(contentType in images))return error('JPEG, PNG, or WebP only',415);
  const claimed=Number(req.headers.get('Content-Length') || 0);
  if(claimed>MAX_BYTES)return error('Image exceeds 12 MiB',413);
  const bytes=await boundedBody(req);
  if(!bytes || bytes.length<32)return error('Invalid or oversized image',413);
  if(!images[contentType](bytes))return error('Image signature does not match content type',415);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  const now=new Date().toISOString();
  await env.PANEL_REPLACEMENTS.put('panels/'+id,bytes,{httpMetadata:{contentType},customMetadata:{sha256:hash,updated_at:now,work_slug:String(issue.work_slug),episode_id:String(issue.episode_id),panel:String(issue.panel)}});
  await env.PANEL_REPLACEMENTS.put('history/'+id+'.json',JSON.stringify(issue),{httpMetadata:{contentType:'application/json'}});
  return json({ok:true,id,work:issue.work,episode:issue.episode,panel:issue.panel,revision:hash,updated_at:now});
}
async function panelImage(req,env,id) {
  if(!env.PANEL_REPLACEMENTS)return error('Replacement storage unavailable',503);
  const obj=await env.PANEL_REPLACEMENTS.get('panels/'+id);
  if(!obj)return error('No replacement uploaded',404);
  return new Response(obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=60, must-revalidate','ETag':obj.httpEtag}});
}
async function decorateManifest(req,env) {
  const original=await env.ASSETS.fetch(req);
  if(!original.ok || !env.PANEL_REPLACEMENTS)return original;
  let m;
  try{m=await original.clone().json()}catch{return original}
  if(!Array.isArray(m?.chapters))return original;
  const slug=new URL(req.url).pathname.split('/')[2];
  const cases=(await casesAndHistory(req,env)).filter(x=>x.work_slug===slug);
  let changed=0;
  for(const c of cases){
    const chapter=m.chapters.find(x=>String(x.id)===String(c.episode_id));
    const i=Number(c.panel)-1;
    if(!chapter || !Array.isArray(chapter.images) || i<0 || i>=chapter.images.length)continue;
    const object=await env.PANEL_REPLACEMENTS.head('panels/'+c.id);
    if(!object)continue;
    // Only override the missing panel's exact original slot, never a neighboring image.
    const repaired={...chapter.images[i],url:'/api/panel-replacements/'+c.id+'?v='+esc(object.customMetadata?.sha256||'new'),
      sha256:object.customMetadata?.sha256||chapter.images[i].sha256};
    // A replacement is an image, not a placeholder. Preserve every other
    // slot and its metadata, but clear the original missing-only flags.
    delete repaired.placeholder;
    delete repaired.confirmed_missing;
    chapter.images[i]=repaired;
    changed++;
  }
  return changed ? json(m,200,{'Cache-Control':'no-store'}) : original;
}
function injectHeader(html, path) {
  // Notifications belong to the main library only; not chapter routes.
  if(path!=='/' && path!=='/index.html')return html;
  if(html.includes('src="/reader-issues.js"'))return html;
  const tags='<link rel="icon" type="image/svg+xml" href="/favicon.svg"><script defer src="/reader-issues.js"></script>';
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i,tags+'</head>') : html;
}
async function htmlResponse(req,env) {
  const original=await env.ASSETS.fetch(req);
  if(!original.ok || !/text\/html/i.test(original.headers.get('Content-Type')||''))return original;
  const headers=new Headers(original.headers);
  headers.delete('content-length');headers.delete('etag');headers.delete('content-encoding');
  headers.set('Cache-Control','no-cache');
  return new Response(injectHeader(await original.text(),new URL(req.url).pathname),{status:original.status,headers});
}
/* GitHub App-backed on-demand images and browser-authenticated corrections.
 * Only archived panel identities appear in manifests. A caller cannot choose a
 * repository, file path or write destination. Secrets never enter HTML/assets.
 */
let githubInstallation = null;
let overridesMemo = null;
const STREAM_RE = /^\/api\/github-image\/([a-z0-9-]+)\/([A-Za-z0-9_.-]{1,160})\/([1-9][0-9]*)$/;
const WRITE_RE = /^\/api\/admin\/github-image\/([a-z0-9-]+)\/([A-Za-z0-9_.-]{1,160})\/([1-9][0-9]*)$/;
const REPO_RE = /^[a-z0-9-]+-vol-[0-9]{3}$/;
const FILE_RE = /^chapters\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PARTIAL_FILE_RE = /^partial\/([a-z0-9-]+)\/([A-Za-z0-9_.-]{1,160})\/([0-9]{4,})-([a-f0-9]{64})\.(?:jpg|png|webp|gif)$/;
const toHex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const githubConfigured = env => !!(env.GITHUB_OWNER && /^\d+$/.test(String(env.GITHUB_APP_ID||'')) &&
  /^\d+$/.test(String(env.GITHUB_APP_INSTALLATION_ID||'')) &&
  typeof env.GITHUB_APP_PRIVATE_KEY==='string' && env.GITHUB_APP_PRIVATE_KEY.includes('BEGIN PRIVATE KEY'));
function pemBytes(pem){
  const raw=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
  return Uint8Array.from(atob(raw),x=>x.charCodeAt(0));
}
async function mintGithubToken(env, scope={}) {
  if(!githubConfigured(env))throw new Error('GitHub App secrets not configured');
  const key=await crypto.subtle.importKey('pkcs8',pemBytes(env.GITHUB_APP_PRIVATE_KEY),
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const now=Math.floor(Date.now()/1000);
  const header=base64url(te.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claims=base64url(te.encode(JSON.stringify({iat:now-60,exp:now+540,iss:String(env.GITHUB_APP_ID)})));
  const input=header+'.'+claims;
  const signed=new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,te.encode(input)));
  const jwt=input+'.'+base64url(signed);
  const r=await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,{
    method:'POST',headers:{Accept:'application/vnd.github+json', Authorization:'Bearer '+jwt,
      'X-GitHub-Api-Version':'2026-03-10','User-Agent':'open-reader-streaming'},
    body:JSON.stringify(scope)
  });
  if(!r.ok){const e=new Error('GitHub App installation rejected credential: '+r.status);e.githubFailure=await githubFailure(r);throw e;}
  const data=await r.json();
  if(typeof data.token!=='string' || !data.expires_at)throw new Error('Invalid installation token response');
  return data;
}
async function githubToken(env) {
  if(githubInstallation && githubInstallation.expires>Date.now()+120000)return githubInstallation.value;
  const data=await mintGithubToken(env);
  githubInstallation={value:data.token,expires:Date.parse(data.expires_at)};
  return githubInstallation.value;
}
// Only the server can provision repositories. Browser credentials are limited
// to one newly reserved private import repository; never mint for archive repos.
export async function browserImportToken(env,repo,marker) {
  if(!/^import-[a-f0-9]{32}-vol-[0-9]{3}$/.test(repo)||!/^open-reader-browser:[a-f0-9-]{36}$/.test(marker))throw Error('Invalid import repository identity');
  const owner=String(env.GITHUB_OWNER||'');if(!/^[A-Za-z0-9-]{1,39}$/.test(owner))throw Error('Invalid owner');
  const headers={Authorization:'Bearer '+await githubToken(env),Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'open-reader-streaming'};
  const url='https://api.github.com/repos/'+owner+'/'+repo;
  async function checked(r){if(r.ok)return r;const f=await githubFailure(r);const e=Error('GitHub repository operation HTTP '+r.status);e.githubFailure=f;throw e;}
  let r=await fetch(url,{headers});
  if(r.status===404){
    const created=await fetch('https://api.github.com/user/repos',{method:'POST',headers,body:JSON.stringify({name:repo,description:marker,private:true,auto_init:true,has_issues:false,has_projects:false,has_wiki:false})});
    if(![201,422].includes(created.status))await checked(created);
    // Invalidate the pre-creation installation token before using new storage.
    githubInstallation=null;headers.Authorization='Bearer '+await githubToken(env);
    r=await fetch(url,{headers});
  }
  await checked(r);const info=await r.json();
  if(info.private!==true||info.name!==repo||info.owner?.login?.toLowerCase()!==owner.toLowerCase()||info.description!==marker||!Number.isSafeInteger(info.id))throw Error('Private import repository identity mismatch; refusing browser access');
  const data=await mintGithubToken(env,{repository_ids:[info.id],permissions:{contents:'write'}});
  if(!Array.isArray(data.repositories)||data.repositories.length!==1||data.repositories[0].id!==info.id||data.permissions?.contents!=='write'||Object.entries(data.permissions||{}).some(([k,v])=>!['contents','metadata'].includes(k)&&v!=='none'))throw Error('GitHub did not confirm repository-scoped write access');
  if(typeof info.default_branch!=='string'||!info.default_branch)throw Error('Private import repository has no default branch');
  return {token:data.token,expires_at:data.expires_at,owner,repo,branch:info.default_branch};
}
// Dedicated private history repository. No browser token, no automatic repo
// creation, no expansion of image-upload path allowlists. Check visibility
// before every archival session (and every history retrieval).
export async function journeyArchiveRemote(env){
 const owner=String(env.GITHUB_OWNER||''),repo='open-reader-journey-history';
 if(!/^[A-Za-z0-9-]{1,39}$/.test(owner)||!githubConfigured(env))throw Error('Journey archive GitHub configuration unavailable');
 const root=`https://api.github.com/repos/${owner}/${repo}`;
 const checked=async (url,method='GET',body=null,accept='application/vnd.github+json')=>fetch(url,{method,headers:{Authorization:'Bearer '+await githubToken(env),Accept:accept,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'open-reader-journey',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const response=await checked(root);
 if(!response.ok)throw Error('Journey history repository unavailable (HTTP '+response.status+')');
 const info=await response.json();
 if(info.private!==true||info.name!==repo||info.owner?.login?.toLowerCase()!==owner.toLowerCase()||info.archived===true||!info.default_branch)throw Error('Journey history repository must be private, initialized and writable');
 const branch=info.default_branch;
 function contents(path){if(!/^events\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/.test(path))throw Error('Invalid Journey history path');return root+'/contents/'+path;}
 return {
  async read(path){const r=await checked(contents(path)+'?ref='+encodeURIComponent(branch),'GET',null,'application/vnd.github.raw+json');if(r.status===404)return null;if(!r.ok)throw Error('Journey history read HTTP '+r.status);
   let bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>1500000)throw Error('Journey history response too large');
   // GitHub may return Contents metadata instead of raw bytes.
   if(/(?:application\/(?:[\w.+-]+\+)?json|text\/json)/i.test(r.headers.get('Content-Type')||'')||bytes[0]===123){let m;try{m=JSON.parse(new TextDecoder().decode(bytes))}catch{}if(m?.type==='file'&&m.encoding==='base64'&&typeof m.content==='string'){bytes=Uint8Array.from(atob(m.content.replace(/\s/g,'')),x=>x.charCodeAt(0));}}
   return bytes;
  },
  async write(path,bytes){let parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
   const r=await checked(contents(path),'PUT',{message:'Archive verified Open Reader visitor batch',content:btoa(parts.join('')),branch});if(!r.ok)throw Error('Journey history write HTTP '+r.status);
  }
 };
}

async function gh(env, method, repo, path, {accept='application/vnd.github+json', data, ref, readToken}={}) {
  if(!/^[A-Za-z0-9-]{1,39}$/.test(String(env.GITHUB_OWNER||'')))throw new Error('Bad GitHub account config');
  if(repo!=='open-reader' && !REPO_RE.test(repo))throw new Error('Unrecognized archive repository');
  if(!path.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p) && p!=='.' && p!=='..'))throw new Error('Unsafe archive path');
  const url=`https://api.github.com/repos/${env.GITHUB_OWNER}/${repo}/contents/`+
    path.split('/').map(encodeURIComponent).join('/')+(ref?'?ref='+encodeURIComponent(ref):'');
  const request=async()=>fetch(url,{method,...(method==='GET'&&/^import-[a-f0-9]{32}-vol-[0-9]{3}$/.test(repo)?{signal:AbortSignal.timeout(30000)}:{}),headers:{'Authorization':'Bearer '+(readToken||await githubToken(env)),'Accept':accept,
    'X-GitHub-Api-Version':'2026-03-10','User-Agent':'open-reader-streaming',
    ...(data?{'Content-Type':'application/json'}:{})},
    ...(data?{body:JSON.stringify(data)}:{})});
  let response=await request();
  // A different Worker isolate may still hold a token minted before the
  // import volume was created. Refresh only once, only on reads, never on throttles.
  if(!readToken&&method==='GET'&&/^import-[a-f0-9]{32}-vol-[0-9]{3}$/.test(repo)&&[401,403,404].includes(response.status)&&!(await githubFailure(response.clone())).throttled){githubInstallation=null;response=await request();}
  return response;
}
async function githubFailure(response) {
  const remaining=response.headers.get('X-RateLimit-Remaining'),retry=response.headers.get('Retry-After'),reset=response.headers.get('X-RateLimit-Reset');
  const throttled=response.status===429||(response.status===403&&(remaining==='0'||retry||/secondary rate limit|api rate limit exceeded|abuse detection/i.test(await response.text())));
  return {status:response.status,throttled:!!throttled,retry,reset:remaining==='0'?reset:null};
}
async function githubFile(env, repo, path, options={}) {
  let response;
  try{response=await gh(env,'GET',repo,path,{accept:'application/vnd.github.raw+json',...options});}
  catch(e){if(e.githubFailure?.throttled)return e.githubFailure;throw e;}
  if(!response.ok)return githubFailure(response);
  let body=new Uint8Array(await response.arrayBuffer());
  // GitHub Contents can return JSON metadata even when a raw-image media
  // type was requested. Decode only a bounded, validated file response.
  if(!guessMime(body) && (body[0]===123 || /(?:application\/(?:[\w.+-]+\+)?json|text\/json)/i.test(response.headers.get('Content-Type')||''))) {
    let meta;
    try {meta=JSON.parse(new TextDecoder().decode(body));} catch {meta=null}
    if(meta?.type==='file' && meta.encoding==='base64' &&
       typeof meta.content==='string' && meta.content.length<36*1024*1024 &&
       Number(meta.size)<=25*1024*1024 && Number(meta.size)>=0) {
      try {
        const binary=atob(meta.content.replace(/\s+/g,''));
        body=Uint8Array.from(binary,x=>x.charCodeAt(0));
      }catch{return {status:502}}
    }
  }
  return {status:200,body};
}
// Read-only, repository-scoped probe. Cache per installation and volume so
// a failed chapter does not mint a token or enumerate a tree for every panel.
const importVolumeChecks=new Map();
async function importVolumeInventory(env,repo,{fresh=false}={}){
 if(!/^import-[a-f0-9]{32}-vol-[0-9]{3}$/.test(repo))throw Error('Invalid import volume');
 const owner=String(env.GITHUB_OWNER||'');
 if(!/^[A-Za-z0-9-]{1,39}$/.test(owner))throw Error('Invalid owner');
 const key=owner.toLowerCase()+':'+env.GITHUB_APP_ID+':'+env.GITHUB_APP_INSTALLATION_ID+':'+repo;
 const now=Date.now(), old=importVolumeChecks.get(key);
 if(!fresh&&old&&old.until>now)return old.promise;
 const promise=(async()=>{
  let token;
  try{const minted=await mintGithubToken(env,{repositories:[repo],permissions:{contents:'read'}});if(minted.permissions?.contents!=='read'||!Array.isArray(minted.repositories)||minted.repositories.length!==1||minted.repositories[0].name!==repo)throw Error('GitHub did not confirm exact repository read scope');token=minted.token;}
  catch(e){if(e.githubFailure?.throttled)return e.githubFailure;return {status:e.githubFailure?.status||403,stage:'App repository-scoped token'};}
  const base=`https://api.github.com/repos/${owner}/${repo}`;
  const get=url=>fetch(url,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'open-reader-streaming'},signal:AbortSignal.timeout(20000)});
  let r=await get(base);if(!r.ok)return {...await githubFailure(r),stage:'repository metadata'};
  const info=await r.json();if(info.private!==true||info.name!==repo||info.owner?.login?.toLowerCase()!==owner.toLowerCase()||!info.default_branch)return {status:409,stage:'private repository identity'};
  r=await get(base+'/git/trees/'+encodeURIComponent(info.default_branch)+'?recursive=1');if(!r.ok)return {...await githubFailure(r),stage:'default branch tree'};
  const tree=await r.json();if(tree.truncated||!Array.isArray(tree.tree))return {status:409,stage:'incomplete Git tree'};
  const files=new Map(tree.tree.filter(x=>x.type==='blob'&&/^(?:pages\/[a-f0-9]{64}\.(?:png|jpg)|packs\/[a-f0-9]{64}\.bin)$/.test(x.path)&&Number.isSafeInteger(x.size)).map(x=>[x.path,x.size]));
  const blobs=new Map(tree.tree.filter(x=>files.has(x.path)&&/^[a-f0-9]{40}$/.test(x.sha||'')).map(x=>[x.path,x.sha]));
  return {status:200,files,blobs,branch:info.default_branch,readToken:token};
 })().catch(()=>({status:503,stage:'repository inventory connection'}));
 importVolumeChecks.set(key,{until:now+60000,promise});
 if(importVolumeChecks.size>64){for(const [k,v] of importVolumeChecks){if(v.until<=now)importVolumeChecks.delete(k);}while(importVolumeChecks.size>64)importVolumeChecks.delete(importVolumeChecks.keys().next().value);}
 return promise;
}
async function shaHex(bytes) {return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
async function archiveManifest(req,env,slug) {
  const url=new URL(`/comics/${slug}/manifest.json`,req.url);
  const resp=await env.ASSETS.fetch(new Request(url));
  if(!resp.ok)return null;
  const data=await resp.json().catch(()=>null);
  return Array.isArray(data?.chapters)?data:null;
}
async function locate(req,env,slug,chapter,index) {
  const manifest=await archiveManifest(req,env,slug);
  const row=manifest?.chapters.find(ch=>String(ch.id)===chapter);
  const image=row?.images?.[index-1];
  const src=image?.github;
  // The source-confirmed missing position exists even when no bytes are saved.
  // Admin may repair ONLY one of those registered positions through GitHub.
  if(image?.placeholder===true && Number(image.panel)===index){
    const cases=await baseCases(req,env);
    if(cases.cases.some(c=>c.work_slug===slug && String(c.episode_id)===chapter && Number(c.panel)===index))
      return {image,src:null};
    return null;
  }
  if(!src || !/^[a-f0-9]{64}$/.test(String(image.sha256||'')))return null;
  if(src.repo==='open-reader'){
    const m=PARTIAL_FILE_RE.exec(src.path||'');
    if(!m || m[1]!==slug || m[2]!==chapter || Number(m[3])!==index || m[4]!==image.sha256)return null;
  } else if(!REPO_RE.test(src.repo) || !src.repo.startsWith(slug+'-vol-') || !FILE_RE.test(src.path))return null;
  return {image,src};
}
function decodeB64(s){
  return atob(s.replace(/\s+/g,''));
}
async function getOverrides(env, fresh=false) {
  if(!fresh && overridesMemo && Date.now()-overridesMemo.time<15000)return overridesMemo.value;
  const response=await gh(env,'GET','open-reader','overrides.json');
  if(response.status===404){overridesMemo={time:Date.now(),value:{},blob:null};return overridesMemo.value;}
  if(!response.ok)throw new Error('Cannot read immutable GitHub override index: HTTP '+response.status);
  const meta=await response.json();
  if(meta?.type!=='file' || typeof meta.sha!=='string' || typeof meta.content!=='string')throw new Error('Invalid overrides.json metadata');
  const jsonText=decodeB64(meta.content);
  const bytes=Uint8Array.from(jsonText,x=>x.charCodeAt(0));
  const payload=JSON.parse(new TextDecoder().decode(bytes));
  if(!payload || payload.schema!=='reader-github-overrides-v1' || typeof payload.panels!=='object')throw new Error('Invalid override catalog');
  overridesMemo={time:Date.now(),value:payload.panels,blob:meta.sha};
  return overridesMemo.value;
}
function overrideKey(slug,chapter,index){return slug+':'+chapter+':'+index;}
function safeOverride(entry,slug,chapter,index){
  return entry && entry.repo==='open-reader' &&
   new RegExp('^overrides/'+slug+'/'+chapter+'/'+index+'-[a-f0-9]{64}\\.(?:png|jpg|webp)$').test(entry.path||'') &&
   /^[a-f0-9]{64}$/.test(entry.sha256||'') && typeof entry.content_type==='string';
}
async function readCurrent(req,env,slug,chapter,index,loc) {
  const overrides=await getOverrides(env);
  const o=overrides[overrideKey(slug,chapter,index)];
  if(o && !safeOverride(o,slug,chapter,index))throw new Error('Unsafe override index entry');
  return o?{src:o,sha:o.sha256,contentType:o.content_type}:
           {src:loc.src,sha:loc.image.sha256,contentType:null};
}
function guessMime(bytes) {
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))return 'image/png';
  if(String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
  if(bytes[0]===71 && bytes[1]===73 && bytes[2]===70 && bytes[3]===56)return 'image/gif';
  return null;
}
async function serveGithubImage(req,env,ctx,slug,chapter,index){
  if(!githubConfigured(env))return error('GitHub App is not configured',503);
  const loc=await locate(req,env,slug,chapter,index);
  if(!loc)return error('Unindexed image',404);
  // OPEN_READER_VERIFIED_CACHE_FASTPATH_V1: safe for the exact original
  // manifest SHA only. Replacements still verify their current override index,
  // so reuploads cannot expose an obsolete cached panel as the latest version.
  const version=new URL(req.url).searchParams.get('v');
  if(version && /^[a-f0-9]{64}$/.test(version) && version===loc.image?.sha256){
    const key=new Request(new URL(`/api/github-image/${slug}/${chapter}/${index}?v=${version}`,req.url));
    const hit=await caches.default.match(key);
    if(hit)return hit;
  }
  let selected;
  try{
    selected=await readCurrent(req,env,slug,chapter,index,loc);
    // A freshly repaired source-missing panel may be served by an isolate whose
    // 15-second memo predates the upload. Only a known missing position AND an
    // exact SHA-versioned reader request may force one fresh index read.
    // This neither refreshes complete chapters nor permits arbitrary paths.
    if(!selected.src && loc.image?.placeholder===true &&
       /^[a-f0-9]{64}$/.test(version||'')){
      await getOverrides(env,true);
      selected=await readCurrent(req,env,slug,chapter,index,loc);
    }
  }
  catch(e){return error('GitHub override index unavailable; original archive preserved: '+e.message,503)}
  if(!selected.src)return error('Panel not yet archived or repaired',404);
  const key=new Request(new URL(`/api/github-image/${slug}/${chapter}/${index}?v=${selected.sha}`,req.url));
  const cached=await caches.default.match(key);
  if(cached)return cached;
  let result;
  try{result=await githubFile(env,selected.src.repo,selected.src.path)}
  catch(e){return error('GitHub temporarily unavailable: '+e.message,502)}
  if(result.status!==200)return error('GitHub image unavailable: HTTP '+result.status,502);
  const mime=guessMime(result.body);
  if(!mime || result.body.length>25*1024*1024 || result.body.length<32)return error('GitHub returned invalid image bytes',502);
  if(await shaHex(result.body)!==selected.sha)return error('GitHub image SHA-256 mismatch; refusing corrupt panel',502);
  const versioned=new URL(req.url).searchParams.get('v')===selected.sha;
  const response=new Response(result.body,{headers:{'Content-Type':mime,
    'Cache-Control':versioned?'public,max-age=31536000,immutable':'public,max-age=60,must-revalidate',
    'ETag':'"'+selected.sha+'"','X-Content-Type-Options':'nosniff'}});
  // Keep the Cloudflare cache immutable at the content-addressed key, even
  // when the client used an older unversioned URL. Do not cache error bodies.
  const immutable=new Response(result.body,{headers:{'Content-Type':mime,
    'Cache-Control':'public,max-age=31536000,immutable',
    'ETag':'"'+selected.sha+'"','X-Content-Type-Options':'nosniff'}});
  if(ctx?.waitUntil)ctx.waitUntil(caches.default.put(key,immutable));
  return response;
}
async function addOverride(env,slug,chapter,index,bytes,mime){
  const sha=await shaHex(bytes);
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
  const path=`overrides/${slug}/${chapter}/${index}-${sha}.${ext}`;
  const encodeBytes=bytes=>{
    const parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
    return btoa(parts.join(''));
  };
  // immutable content-addressed file; no overwrites of original archives.
  const content=encodeBytes(bytes);
  let sent=await gh(env,'PUT','open-reader',path,{data:{message:`Add verified reader panel ${slug}/${chapter}/${index}`,
    content}});
  if(sent.status===422){
    const existed=await githubFile(env,'open-reader',path);
    if(existed.status!==200 || await shaHex(existed.body)!==sha)throw new Error('Existing replacement file conflicts');
  }else if(sent.status!==201)throw new Error('GitHub refused replacement image: HTTP '+sent.status);
  const key=overrideKey(slug,chapter,index);
  for(let attempt=0;attempt<4;attempt++){
    await getOverrides(env,true);
    const before=overridesMemo;
    const updated={...before.value,[key]:{repo:'open-reader',path,sha256:sha,content_type:mime}};
    const payload=JSON.stringify({schema:'reader-github-overrides-v1',panels:updated});
    const data={message:`Update reader panel index ${slug}/${chapter}/${index}`,
                content:btoa(unescape(encodeURIComponent(payload)))};
    if(before.blob)data.sha=before.blob;
    const response=await gh(env,'PUT','open-reader','overrides.json',{data});
    if(response.ok){overridesMemo={time:Date.now(),value:updated,blob:response.json? (await response.json()).content?.sha:null};
      return {sha,path};}
    if(![409,422].includes(response.status))throw new Error('GitHub index update failed: HTTP '+response.status);
  }
  throw new Error('GitHub overrides index changed concurrently; image preserved; retry this upload');
}
async function uploadGithubImage(req,env,slug,chapter,index){
  if(!sameOriginPost(req))return error('Same-origin required',403);
  if(!await validSession(req,env))return error('Admin sign-in required',401);
  if(!githubConfigured(env))return error('GitHub App credentials not configured',503);
  const loc=await locate(req,env,slug,chapter,index);
  if(!loc)return error('No matching verified or registered missing panel',404);
  const mime=(req.headers.get('Content-Type')||'').split(';')[0].toLowerCase();
  if(!['image/jpeg','image/png','image/webp'].includes(mime))return error('JPEG PNG or WebP only',415);
  if(Number(req.headers.get('Content-Length')||0)>MAX_BYTES)return error('File too large',413);
  const bytes=await boundedBody(req);
  if(!bytes || bytes.length<32 || !images[mime](bytes))return error('Invalid or oversized image',415);
  try{
    const record=await addOverride(env,slug,chapter,index,bytes,mime);
    // Upload success requires independent READ-BACK through the same storage
    // layer as a reader request. An index commit alone is not proof that the
    // browser can retrieve the image. Never report false success.
    const checked=await githubFile(env,'open-reader',record.path);
    if(checked.status!==200 || guessMime(checked.body)!==mime ||
       await shaHex(checked.body)!==record.sha)
      return error('Replacement stored but read-back verification failed; do not treat this panel as repaired',502);
    const effective=await readCurrent(req,env,slug,chapter,index,loc);
    if(effective.sha!==record.sha || effective.src?.path!==record.path)
      return error('Replacement stored but active reader index does not expose the verified image yet',503);
    return json({ok:true,slug,chapter,index,sha256:record.sha,
      readback_verified:true,stored_in:'private GitHub open-reader repository'});
  }catch(e){return error('GitHub upload failed; original images were not altered: '+e.message,502)}
}
async function overlayGithubManifest(req,env){
  const original=await env.ASSETS.fetch(req);
  if(!original.ok || !githubConfigured(env))return original;
  let manifest;
  try{manifest=await original.clone().json()}catch{return original}
  if(!Array.isArray(manifest?.chapters))return original;
  const slug=new URL(req.url).pathname.split('/')[2];
  // OPEN_READER_ORDERED_REPAIR_MANIFEST_V2
  // On an explicit chapter entry, a placeholder's uploaded replacement must
  // be resolved BEFORE its ordered image queue starts. A single fresh index
  // read is allowed ONLY if this chapter's static manifest contains missing
  // slots. Finished chapters continue using the ordinary memoized index.
  const repairHint=new URL(req.url).searchParams.get('refresh-repairs-for');
  const checkRepair=typeof repairHint==='string' &&
    /^[A-Za-z0-9_.-]{1,160}$/.test(repairHint) &&
    manifest.chapters.some(ch=>String(ch.id)===repairHint &&
      ch.images?.some(image=>image?.placeholder===true));
  let overrides;
  try{overrides=await getOverrides(env,checkRepair)}catch{return error('Image override index unavailable',503)}
  let changed=false;
  for(const ch of manifest.chapters){
    for(let i=0;i<(ch.images||[]).length;i++){
      const entry=overrides[overrideKey(slug,String(ch.id),i+1)];
      if(!entry)continue;
      if(!safeOverride(entry,slug,String(ch.id),i+1))return error('Invalid override index',503);
      const newUrl=`/api/github-image/${encodeURIComponent(slug)}/${encodeURIComponent(ch.id)}/${i+1}?v=${entry.sha256}`;
      if(ch.images[i]?.placeholder===true){
        // A real admin-uploaded image replaces precisely one missing placeholder.
        ch.images[i]={url:newUrl,sha256:entry.sha256,width:ch.images[i].width||1100,
          height:ch.images[i].height||1500,github:{repo:'open-reader',path:entry.path},recovered:true};
      }else{
        ch.images[i]={...ch.images[i],url:newUrl,sha256:entry.sha256};
      }
      changed=true;
    }
  }
  return changed?json(manifest,200,{'Cache-Control':'no-store'}):original;
}

export default {
  async fetch(req,env,ctx) {
    if(!env.ASSETS)return error('Static assets binding missing',503);
    const u=new URL(req.url), path=u.pathname;
    if((path==='/login/' || path==='/login') && req.method==='GET'){
      if(await validSession(req,env))return Response.redirect(u.origin+'/',302);
      return loginPage();
    }
    if(path==='/api/admin/login' && req.method==='POST')return login(req,env);
    if(path==='/api/admin/session' && req.method==='GET')return sessionResponse(req,env);
    if(path==='/api/admin/logout' && req.method==='POST'){
      if(!sameOriginPost(req))return error('Same-origin required',403);
      const response=json({ok:true},200,{'Set-Cookie':logoutCookie});
      response.headers.append('Set-Cookie','reader_admin=; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      response.headers.append('Set-Cookie','or_arcade=; Path=/api/arcade/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      return response;
    }
    // All public routes, including static assets and image streams, require the
    // same site session. Credentials never enter any public file or JS bundle.
    if(!await validSession(req,env))return unauthenticated(req);
    const arcade=await arcadeRoute(req,env,{githubFile});
    if(arcade)return arcade.headers.has('Set-Cookie')?arcade:renewIfNeeded(req,env,arcade);
    const manual=await manualRoute(req,env,{gh,githubFile,shaHex,boundedBody,githubConfigured,browserImportToken,importVolumeInventory,ctx});
    if(manual)return renewIfNeeded(req,env,manual);
    const journey = await journeyRoute(req,env,(r,e)=>validSession(r,e),journeyArchiveRemote);
    if(journey)return renewIfNeeded(req,env,journey);
    if(path==='/api/reader-health' && req.method==='GET')return json({ok:true,script:'open-reader-panel-replacement-v1',
      storage_configured:!!env.PANEL_REPLACEMENTS,github_streaming_configured:githubConfigured(env),journey_storage_configured:journeyConfigured(env)});
    const streaming=path.match(STREAM_RE);
    if(streaming && req.method==='GET')return serveGithubImage(req,env,ctx,streaming[1],streaming[2],Number(streaming[3]));
    const writing=path.match(WRITE_RE);
    if(writing && req.method==='POST')return uploadGithubImage(req,env,writing[1],writing[2],Number(writing[3]));
    if(path==='/api/github-replacements.json' && req.method==='GET' && githubConfigured(env)){
      try {const x=await getOverrides(env);return json({schema:'reader-github-replacements-v1',panels:
        Object.fromEntries(Object.entries(x).map(([key,value])=>[key,value.sha256]))});}
      catch(e){return error('GitHub replacements unavailable: '+e.message,503)}
    }
    if(path==='/source-issues.json' && req.method==='GET')return issuesResponse(req,env);
    const imagePath=path.match(/^\/api\/panel-replacements\/([a-f0-9]{20})$/);
    if(imagePath) {
      if(req.method==='POST')return upload(req,env,imagePath[1]);
      if(req.method==='GET')return panelImage(req,env,imagePath[1]);
      return error('Method not allowed',405);
    }
    if(/^\/comics\/[^/]+\/manifest\.json$/.test(path) && req.method==='GET' && githubConfigured(env))
      return overlayGithubManifest(req,env);
    if(/^\/comics\/[^/]+\/manifest\.json$/.test(path) && req.method==='GET')return decorateManifest(req,env);
    if(req.method==='GET' && (path==='/' || path.endsWith('/') || path.endsWith('.html')))return renewIfNeeded(req,env,await htmlResponse(req,env));
    return env.ASSETS.fetch(req);
  },
  async scheduled(event,env,_ctx){try{const out=await archiveJourneyEvents(env,journeyArchiveRemote,event?.scheduledTime??Date.now());console.log("JOURNEY_ARCHIVE",out.archived,out.reason);}catch(e){const detail=String(e?.message||e);const safe=/^(?:Journey (?:history|archive)|GitHub App installation rejected credential:)/.test(detail)?detail.slice(0,180):"database or network error";console.error("JOURNEY_ARCHIVE_PAUSED",safe);throw Error("Journey archive paused; unverified events remain in D1");}}
};
