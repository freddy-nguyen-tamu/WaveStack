/* Cloudflare Worker entrypoint for the EXISTING shared-reader assets.
 * Required bindings: env.ASSETS (Workers static assets), env.PANEL_REPLACEMENTS
 * (R2 bucket), secrets READER_ADMIN_PASSWORD and READER_SESSION_HMAC_KEY.
 * Only pre-existing source-issue case IDs can be replaced. Never permits
 * arbitrary chapter or archive modification. No client-side credentials.
 */
const MAX_BYTES = 12 * 1024 * 1024;
const SESSION_SECONDS = 7200;
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
  const cookie=cookies(req).reader_admin || '';
  const [expiry,sig,extra]=cookie.split('.');
  if(extra || !/^\d{10,13}$/.test(expiry) || !sig || Number(expiry) < Math.floor(Date.now()/1000)) return false;
  const expected=await hmac(env.READER_SESSION_HMAC_KEY, expiry+':reader-panel-admin:v1');
  return timingEqual(te.encode(sig),te.encode(expected));
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
  const enriched=await Promise.all(cases.map(async c=>{
    const replacement=env.PANEL_REPLACEMENTS ? await env.PANEL_REPLACEMENTS.head('panels/'+c.id) : null;
    return {...c,replacement_present:!!replacement,
      replacement_sha256:replacement?.customMetadata?.sha256||null};
  }));
  const chapters=new Set(cases.map(c=>c.work_slug+'\x00'+c.episode_id));
  return json({schema:'comicarchiver.source_issue_feed.v1',count:enriched.length,affected_chapters:chapters.size,affected_works:new Set(cases.map(c=>c.work_slug)).size,
    upload_enabled:!!(env.PANEL_REPLACEMENTS && typeof env.READER_ADMIN_PASSWORD==='string' && env.READER_ADMIN_PASSWORD.length>=20 && typeof env.READER_SESSION_HMAC_KEY==='string' && env.READER_SESSION_HMAC_KEY.length>=32),cases:enriched});
}
async function login(req,env) {
  if(!sameOriginPost(req))return error('Same-origin request required',403);
  if(typeof env.READER_ADMIN_PASSWORD!=='string' || env.READER_ADMIN_PASSWORD.length<20 || typeof env.READER_SESSION_HMAC_KEY!=='string' || env.READER_SESSION_HMAC_KEY.length<32)return error('Admin credentials are not configured',503);
  let body;
  try{body=await req.json()}catch{return error('Invalid JSON',400)}
  const given=typeof body?.password==='string'?body.password.slice(0,4096):'';
  if(!given || !timingEqual(await sha(given),await sha(env.READER_ADMIN_PASSWORD)))return error('Invalid credentials',401);
  const expiry=String(Math.floor(Date.now()/1000)+SESSION_SECONDS);
  const signature=await hmac(env.READER_SESSION_HMAC_KEY, expiry+':reader-panel-admin:v1');
  return json({ok:true,expires_in:SESSION_SECONDS},200,{'Set-Cookie':`reader_admin=${expiry}.${signature}; Path=/api/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`});
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
    chapter.images[i]={...chapter.images[i],url:'/api/panel-replacements/'+c.id+'?v='+esc(object.customMetadata?.sha256||'new'),
      sha256:object.customMetadata?.sha256||chapter.images[i].sha256};
    changed++;
  }
  return changed ? json(m,200,{'Cache-Control':'no-store'}) : original;
}
function injectHeader(html) {
  if(html.includes('src="/reader-issues.js"'))return html;
  const tags='<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/favicon-180.png"><script defer src="/reader-issues.js"></script>';
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i,tags+'</head>') : html;
}
async function htmlResponse(req,env) {
  const original=await env.ASSETS.fetch(req);
  if(!original.ok || !/text\/html/i.test(original.headers.get('Content-Type')||''))return original;
  const headers=new Headers(original.headers);
  headers.delete('content-length');headers.delete('etag');headers.delete('content-encoding');
  headers.set('Cache-Control','no-cache');
  return new Response(injectHeader(await original.text()),{status:original.status,headers});
}
export default {
  async fetch(req,env) {
    if(!env.ASSETS)return error('Static assets binding missing',503);
    const u=new URL(req.url), path=u.pathname;
    if(path==='/api/reader-health' && req.method==='GET')return json({ok:true,script:'open-reader-panel-replacement-v1',
      storage_configured:!!env.PANEL_REPLACEMENTS});
    if(path==='/source-issues.json' && req.method==='GET')return issuesResponse(req,env);
    if(path==='/api/admin/login' && req.method==='POST')return login(req,env);
    const imagePath=path.match(/^\/api\/panel-replacements\/([a-f0-9]{20})$/);
    if(imagePath) {
      if(req.method==='POST')return upload(req,env,imagePath[1]);
      if(req.method==='GET')return panelImage(req,env,imagePath[1]);
      return error('Method not allowed',405);
    }
    if(/^\/comics\/[^/]+\/manifest\.json$/.test(path) && req.method==='GET')return decorateManifest(req,env);
    if(req.method==='GET' && (path==='/' || path.endsWith('/') || path.endsWith('.html')))return htmlResponse(req,env);
    return env.ASSETS.fetch(req);
  }
};
