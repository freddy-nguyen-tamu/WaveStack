// Explicit same-URL chapter recovery must reload the managed tab, not PING stale content.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../reusable/browser_bridge_extension/background.js'),'utf8');
const navigate=src.split("if (action === 'navigate') {")[1].split("if (action === 'probe') {")[0];
assert.match(navigate,/desired\.href !== current\.href/);
assert.match(navigate,/call\(chrome\.tabs,'reload',tabId/);
assert.match(navigate,/chrome\.tabs\.onUpdated\.addListener\(observer\)/);
assert.match(navigate,/info\.status==='loading'/);
assert.match(navigate,/info\.status==='complete' && sawLoading/);
console.log('PASS same-URL managed-tab reload waits for the new document');
