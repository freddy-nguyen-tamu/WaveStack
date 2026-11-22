// Non-destructive regression for the PASSIVE badge vs a blocking verification.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'reusable/browser_bridge_extension/background.js'),'utf8');
const start=src.indexOf('function classifyLiveDOM() {');
const end=src.indexOf('\nasync function send(id,payload) {',start);
assert.ok(start>=0 && end>start,'live DOM classifier must exist before send()');
const script=src.slice(start,end)+'\nclassifyLiveDOM()';
function makeElement({badge=false,visible=true,hiddenParent=false}={}) {
  const badgeNode={nodeType:1,hidden:false,parentElement:null};
  const invisibleParent={nodeType:1,hidden:true,parentElement:null};
  return {nodeType:1,hidden:false, parentElement:hiddenParent?invisibleParent:(badge?badgeNode:null),
    getBoundingClientRect(){return {width:visible?256:0,height:visible?60:0}},
    closest(selector){return (badge&&selector==='.grecaptcha-badge')?badgeNode:null}};
}
function classify({challenged=[],logins=[],title='Ordinary manga chapter'}={}) {
  const document={title,querySelectorAll(selector){
    if(selector==='form input[type=password]')return logins;
    assert.ok(selector.includes('#challenge-running') && selector.includes('[data-sitekey]'));
    return challenged;
  }};
  return vm.runInNewContext(script,{document,getComputedStyle:el=>({display:el.hidden?'none':'block',visibility:'visible'})});
}
let state=classify({challenged:[makeElement({badge:true})]});
assert.equal(state.challenge,false,'passive badge cannot pause a readable chapter');
assert.equal(state.classifierRevision,'live-dom-badge-aware-2');
assert.equal(classify({challenged:[makeElement({badge:true}),makeElement()]}).challenge,true,'real challenge outside passive badge must still block');
assert.equal(classify({challenged:[makeElement()]}).challenge,true,'real challenge blocks');
assert.equal(classify({challenged:[makeElement({visible:false})]}).challenge,false,'hidden iframe does not block');
assert.equal(classify({challenged:[makeElement({badge:true})],logins:[makeElement()]}).login,true,'visible login still detected');
assert.equal(classify({logins:[makeElement({hiddenParent:true})]}).login,false,'hidden modal login is not active login wall');
assert.equal(classify({title:'A comic about captcha'}).challenge,false,'story text does not trigger');
assert.ok(src.includes("if (payload?.type === 'CLASSIFY' && chrome.scripting?.executeScript)"),'live classifier must override stale content receiver');
assert.ok(src.includes("if(payload?.type==='RECOVER_IMAGE' && chrome.scripting?.executeScript)"),'preserve exact image recovery');
assert.ok(src.includes("const tile=payload?.type==='CAPTURE_IMAGE_TILE'"),'preserve fast image capture');
for(const browser of ['chrome','firefox']) {
  const background=fs.readFileSync(path.join(root,'browser_bridge',browser,'background.js'),'utf8');
  const canonical=fs.readFileSync(path.join(root,'reusable/browser_bridge_extension/background.js'),'utf8');
  assert.equal(background,canonical,'installed background must exactly match reusable source');
}
console.log('PASS: passive badge, active challenge, login, hidden modal, live-tab path, bridge parity');
