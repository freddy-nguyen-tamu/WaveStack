'use strict';
// Source-contract regression for a subtle security/consistency bug: bootstrap
// previously selected the FIRST matching URL, often a user's OLD manual tab.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const p=src.slice(src.indexOf('async function pickComicTab('),src.indexOf('async function autoConnect()'));
assert.ok(p.includes("'comicBridgeManagedTabId'"));
assert.ok(p.includes("'comicBridgeManagedSite'"));
assert.ok(p.includes("chrome.tabs,'create'"));
assert.ok(!p.includes('candidates.find(tab=>canonicalPage(tab.url)===canonicalPage(requested))'));
assert.ok(!p.includes('candidates.find(t=>t.active)') || p.indexOf('if(requested)') < p.indexOf('candidates.find(t=>t.active)'));
console.log('PASS matching old/manual tabs are never selected for automatic startup');
