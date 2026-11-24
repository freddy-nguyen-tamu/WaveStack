import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import worker from '../reusable/worker_addon/panel_replacement_worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://reader.example.test';
const password='a-persistently-secure-reader-password';
const key='a-very-long-hmac-key-for-testing-auth-1234567890';
const known={
 '/':new Response('<html><head></head><body>Reader homepage</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}}),
 '/your-journey/':new Response('<html><body>Private journey</body></html>',{headers:{'Content-Type':'text/html'}}),
 '/comics/c1/manifest.json':Response.json({chapters:[{id:'1',images:[]}]}),
 '/reader-issues.js':new Response('SECRET SCRIPT',{headers:{'Content-Type':'application/javascript'}})
};
const queried=[];
const fakeDB={
  async exec() {},
  prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this},async all(){queried.push({sql:this.sql,args:this.args});
    if(sql.includes('FROM grouped GROUP BY period_id'))return {results:[{period_id:3,ip:'1.1.1.1',start_at:'2026-11-24T00:00:00.000Z',end_at:'2026-11-24T02:00:00.000Z',actions:300,city:'X',country:'US'}]};
    if(sql.includes('LEFT JOIN journey_event_locations'))return {results:[{created_at:'2026-11-24T00:00:00.000Z',kind:'page_view',ip:'1.1.1.1',latitude:30,longitude:-96}]};
    return {results:[]};
  },async run() {return {success:true}}};},
};
const env={ASSETS:{fetch:async req=>known[new URL(req.url).pathname]?.clone()||new Response('missing',{status:404})},
  JOURNEY_DB:fakeDB,READER_ADMIN_PASSWORD:password,READER_SESSION_HMAC_KEY:key};
const call=(path,opts={})=>worker.fetch(new Request(origin+path,opts),env);
const passwordRequest=pass=>({method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:pass})});
let r=await call('/');assert.equal(r.status,302);assert.match(r.headers.get('location'),/^\/login\//);
r=await call('/your-journey/');assert.equal(r.status,302);
r=await call('/reader-issues.js');assert.equal(r.status,401);
r=await call('/comics/c1/manifest.json');assert.equal(r.status,401);
r=await call('/api/github-image/c1/1/1');assert.equal(r.status,401);
r=await call('/api/journey/stats');assert.equal(r.status,401);
r=await call('/login/');assert.equal(r.status,200);const loginHtml=await r.text();assert.match(loginHtml,/autocomplete="current-password"/);
for(const token of ['--or-header:#131921','--or-accent:#ff9900','--or-canvas:#eaeded','--or-border:#d5d9d9'])assert.ok(loginHtml.includes(token),'login and homepage must share theme token '+token);
r=await call('/api/admin/login',passwordRequest('bad'));assert.equal(r.status,401);
r=await call('/api/admin/login',passwordRequest(password));assert.equal(r.status,200);
const cookie=r.headers.get('set-cookie');assert.match(cookie,/reader_site=/);assert.match(cookie,/Path=\//);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/Max-Age=7776000/);
const token=cookie.split(';')[0],authorized=(path,opts={})=>call(path,{...opts,headers:{Cookie:token,...(opts.headers||{})}});
r=await authorized('/');assert.equal(r.status,200);assert.match(await r.text(),/Reader homepage/);
const oldExpiry=String(Math.floor(Date.now()/1000)+7*86400);
const oldSigned=createHmac('sha256',key).update(oldExpiry+':reader-site:v2').digest('base64url');
r=await call('/',{headers:{Cookie:`reader_site=${oldExpiry}.${oldSigned}`}});
assert.equal(r.status,200,'near-expiry session still authenticates');
assert.match(r.headers.get('set-cookie'),/Max-Age=7776000/,'HTML access renews long-lived session');
r=await authorized('/reader-issues.js');assert.equal(r.status,200);
r=await authorized('/your-journey/');assert.equal(r.status,200);
r=await authorized('/comics/c1/manifest.json');assert.equal(r.status,200);
r=await authorized('/api/admin/session');assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Path=\//);
r=await authorized('/api/journey/periods');assert.equal(r.status,200);
const data=await r.json();assert.equal(data.periods[0].actions,300);assert.equal(data.periods[0].period_id,3);
r=await authorized('/api/journey/period-events?period=3');assert.equal(r.status,200);assert.equal((await r.json()).events[0].latitude,30);
assert.ok(queried.some(x=>x.sql.includes('LAG(e.ip)')&&x.sql.includes('GROUP BY period_id')));
assert.ok(queried.some(x=>x.sql.includes('LEFT JOIN journey_event_locations')));
const legacyExpiry=String(Math.floor(Date.now()/1000)+600);
const legacySignature=createHmac('sha256',key).update(legacyExpiry+':reader-panel-admin:v1').digest('base64url');
r=await call('/api/admin/session',{headers:{Cookie:`reader_admin=${legacyExpiry}.${legacySignature}`}});
assert.equal(r.status,200,'existing signed API-scoped sessions must migrate');assert.match(r.headers.get('set-cookie'),/^reader_site=/);
r=await authorized('/api/admin/logout',{method:'POST',headers:{Origin:origin}});assert.equal(r.status,200);
assert.match(r.headers.get('set-cookie'),/Max-Age=0/);assert.match(r.headers.get('set-cookie'),/reader_admin=/);
r=await call('/api/admin/session');assert.equal(r.status,401);
console.log('PASS site-wide gate, static assets, reader streams, 90-day signed cookie, legacy upgrade, logout, timeline period endpoints');
