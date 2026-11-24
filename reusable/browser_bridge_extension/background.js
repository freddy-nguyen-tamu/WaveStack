/* One selected real browser tab + authenticated loopback Python. No automation stealth. */
let state = null;
let polling = false;
let lastError = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Browser APIs including StorageArea require their owning object as `this`.
// Passing e.g. chrome.storage.local.set into an unbound callback wrapper
// throws TypeError: Illegal invocation in Chrome/Firefox.
const call = (owner, name, ...args) => new Promise((resolve, reject) => {
  try {
    owner[name](...args, value => {
      const err = chrome.runtime.lastError;
      err ? reject(Error(err.message)) : resolve(value);
    });
  } catch (error) { reject(error); }
});
const tabsGet = id => call(chrome.tabs, 'get', id);
const tabsUpdate = (id, change) => call(chrome.tabs, 'update', id, change);
const sendRaw = (id, payload) => call(chrome.tabs, 'sendMessage', id, payload);
const lostReceiver = error => /receiving end does not exist|could not establish connection|message port closed|frame.*removed|no frame with id/i.test(String(error));
// Chrome's isolated-world script injection is a one-shot RPC into the live
// document. It doesn't require a long-lived content-script message receiver.
async function directTabCommand(id, payload) {
  const end=Date.now()+30000;
  let failure='not yet ready';
  while(Date.now()<end) {
    try {
      const tab=await tabsGet(id);
      if(!sourceMatches(tab.url) || tab.status==='loading') {
        await sleep(250); continue;
      }
      const target={tabId:id};
      // Most normal chapter documents already have the content script. Do not
      // inject the same file for every missing image: the redundant scripting
      // call itself can stall, especially in a busy/background Chrome tab.
      const dispatch = async () => {
        const reply=await chrome.scripting.executeScript({target,
          func: command => {
            if(window.__comicBridgeContentLoadedVersion !== 10 ||
               typeof window.__comicBridgeDirect !== 'function')
              return {__bridgeError:'Page command transport not initialized'};
            return window.__comicBridgeDirect(command);
          },args:[payload]});
        return reply?.[0]?.result;
      };
      let result=await dispatch();
      if (result?.__bridgeError==='Page command transport not initialized') {
        // A newly navigated tab or old extension content needs one injection.
        await chrome.scripting.executeScript({target,files:['content.js']});
        result=await dispatch();
      }
      if (result === undefined || result === null)
        throw Error('Page command transport returned no result');
      if(result?.__bridgeError) throw Error(result.__bridgeError);
      // A chapter navigation may finish between injection and dispatch.
      // The next operation automatically gets a fresh document on retry.
      if(result?.error) throw Error(String(result.error));
      return result;
    } catch(error) {
      failure=String(error);
      if(!lostReceiver(error) && !/context|frame|document|transport|navigation|cannot access/i.test(failure))
        throw error;
      await sleep(350);
    }
  }
  throw Error('Selected comic document did not become ready: '+failure);
}
// One-shot classifier: read only the CURRENT managed tab DOM. A prior content.js
// closure can survive until navigation and keep reporting a passive badge as a
// challenge. Do not replace the stable SCROLL/image message transport.
function classifyLiveDOM() {
  const visible = el => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r=el.getBoundingClientRect();
    if (!r || r.width<=0 || r.height<=0) return false;
    for (let n=el; n && n.nodeType===1; n=n.parentElement) {
      const s=getComputedStyle(n);
      if (s.display==='none' || s.visibility==='hidden' || s.visibility==='collapse') return false;
    }
    return true;
  };
  const passiveBadge = el => !!el.closest?.('.grecaptcha-badge');
  // Identical pre-existing challenge selectors: do not remove real checks.
  const challenged=[...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], #challenge-running, .cf-challenge, input[name*="captcha" i], .g-recaptcha, [data-sitekey]')];
  return {
    login:[...document.querySelectorAll('form input[type=password]')].some(visible),
    challenge:challenged.some(el => visible(el) && !passiveBadge(el)),
    title:document.title||'',
    classifierRevision:'live-dom-badge-aware-2'
  };
}

async function send(id,payload) {
  // Always classify the currently rendered managed tab, not a cached/old
  // content-script closure. No navigation, clicks or source requests.
  if (payload?.type === 'CLASSIFY' && chrome.scripting?.executeScript) {
    const result = await checkedIO(chrome.scripting.executeScript({
      target:{tabId:id}, func:classifyLiveDOM
    }), 'read current-tab challenge state');
    const state = result?.[0]?.result;
    if (!state || typeof state.challenge !== 'boolean' || typeof state.login !== 'boolean')
      throw Error('Current-tab challenge classifier returned no valid result');
    return state;
  }
  // A chapter transition creates a NEW document/receiver. The old receiver
  // can leave a RECOVER_IMAGE message pending even after PING succeeded.
  // RECOVER_IMAGE moves one known DOM tile, then restores the scroll offset:
  // issue it exactly once as a self-contained script in the current document,
  // rather than racing a possibly-stale asynchronous message receiver.
  // Never apply this to non-idempotent forward SCROLL or navigation.
  if(payload?.type==='RECOVER_IMAGE' && chrome.scripting?.executeScript)
    return directTabCommand(id,payload);
  // Fast path: reuse the live listener. A content listener left in an inactive
  // document can fail to answer CAPTURE_IMAGE_TILE even though the image is
  // decoded. Only this idempotent, absolute-position command can be safely
  // retried through direct injection; NEVER race SCROLL or navigation because
  // that could advance the reader twice and corrupt page order.
  const tile=payload?.type==='CAPTURE_IMAGE_TILE';
  try {
    if(tile && chrome.scripting?.executeScript) {
      let wake;
      const idle=new Promise(resolve=>{wake=setTimeout(()=>resolve(null),1400);});
      const raw=sendRaw(id,payload);
      let response;
      try {response=await Promise.race([raw,idle]);}
      finally {clearTimeout(wake);}
      if(response===null) {
        console.warn('Comic Bridge: content listener unresponsive for tile; retrying same position via fresh selected-tab injection');
        return directTabCommand(id,payload);
      }
      return response;
    }
    return await sendRaw(id,payload);
  } catch(error) {
    if (!lostReceiver(error) || !state || state.tabId!==id) throw error;
    if (chrome.scripting?.executeScript) return directTabCommand(id,payload);
    // Firefox fallback on the original active source tab.
    await waitContent(20000,(await tabInfo()).url);
    return sendRaw(id,payload);
  }
}
const storageSet = data => call(chrome.storage.local, 'set', data);
const storageGet = keys => call(chrome.storage.local, 'get', keys);

// A cross-origin image CDN is declared by the site adapter in the extension
// manifest. Such sites must NEVER start crawling without tab-response capture.
// Standalone extension fetch is known to be rejected on these image CDNs.
function requiresTabCapture() {
  const manifest = chrome.runtime.getManifest();
  const sourceOrigins = new Set((manifest.content_scripts?.[0]?.matches || []).map(p => {
    try { return new URL(p.replace(/\*/g, 'chapter')).origin; } catch {return '';} 
  }));
  const grants = [...(manifest.host_permissions || []), ...(manifest.permissions || [])];
  return grants.some(p => {
    if (typeof p !== 'string' || !p.startsWith('https://')) return false;
    try {return !sourceOrigins.has(new URL(p.replace(/\*/g, 'resource')).origin);}
    catch {return false;}
  });
}


// Chromium: read *already loaded* resources from the selected, user-paired tab.
// A CDN may permit normal <img> loads but refuse a new extension-origin fetch.
// Do not spoof headers, alter site protections, inspect other tabs or copy cookies.
let inspectedTabId = null;
let inspectedReady = false;
// Generic JavaScript-dialog policy for the extension-owned navigation.
let dialogNavigationInFlight = false;
let handledNavigationDialogs = 0;
const imageRequests = new Map(); // URL -> requestId, only this tab
const imageByRequest = new Map(); // requestId -> URL, cleared per chapter
const imageNetworkStatus = new Map(); // Sanitized CDP Network status (DevTools equivalent), this tab only
const imageWebRequestStatus = new Map(); // Permitted selected-tab HTTP status; independent of debugger
const networkRequestUrl = new Map(); // requestId -> permitted image URL, bounded per chapter
const capturedImages = new Map(); // URL -> original base64 response body
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 72 * 1024 * 1024;
const MAX_CAPTURE_IMAGES = 250;
let capturedBytes = 0;
let captureFailures = 0;
let snapshotAttempted = false;
const normalizeResourceUrl = raw => {
  try { const u = new URL(String(raw || '').trim()); u.hash = ''; return u.href; }
  catch { return ''; }
};
const imagePermission = raw => {
  const normalized = normalizeResourceUrl(raw);
  if (!normalized || !normalized.startsWith('https://')) return false;
  const origin = new URL(normalized).origin;
  const permitted = chrome.runtime.getManifest().host_permissions || [];
  return permitted.some(p => p === origin + '/*');
};
function clearImageMemory() {
  imageRequests.clear();
  imageByRequest.clear();
  imageNetworkStatus.clear();
  imageWebRequestStatus.clear();
  networkRequestUrl.clear();
  capturedImages.clear();
  capturedBytes = 0;
  captureFailures = 0;
  snapshotAttempted = false;
  visualImages.clear();
}
function storeOriginalImage(url, base64) {
  if (!imagePermission(url) || typeof base64 !== 'string' || !base64 ||
      base64.length > MAX_IMAGE_BYTES * 4 / 3 + 8) return false;
  const size = Math.floor(base64.length * 3 / 4);
  if (!size || size > MAX_IMAGE_BYTES) return false;
  const old = capturedImages.get(url);
  if (old) capturedBytes -= old.size;
  capturedImages.delete(url);
  capturedImages.set(url, {base64, size});
  capturedBytes += size;
  while (capturedImages.size > MAX_CAPTURE_IMAGES || capturedBytes > MAX_CAPTURE_BYTES) {
    const oldest = capturedImages.keys().next().value;
    capturedBytes -= capturedImages.get(oldest).size;
    capturedImages.delete(oldest);
  }
  return capturedImages.has(url);
}
const cdp = async (method, params={}) => {
  if (!chrome.debugger || inspectedTabId !== state?.tabId || !inspectedReady)
    throw Error('Chrome debugger unavailable on the paired tab');
  return call(chrome.debugger, 'sendCommand', {tabId: inspectedTabId}, method, params);
};
async function attachSelectedTab() {
  if (!chrome.debugger?.attach || !state) return false;
  if (inspectedTabId === state.tabId && inspectedReady) return true;
  if (inspectedTabId !== null) {
    try {await call(chrome.debugger, 'detach', {tabId: inspectedTabId});} catch {}
  }
  inspectedTabId = null;
  inspectedReady = false;
  clearImageMemory();
  const tabId = state.tabId;
  await call(chrome.debugger, 'attach', {tabId}, '1.3');
  inspectedTabId = tabId;
  try {
    await call(chrome.debugger, 'sendCommand', {tabId}, 'Page.enable', {});
    await call(chrome.debugger, 'sendCommand', {tabId}, 'Network.enable', {
      maxTotalBufferSize: 96 * 1024 * 1024,
      maxResourceBufferSize: MAX_IMAGE_BYTES
    });
    inspectedReady = true;
  } catch (e) {
    try {await call(chrome.debugger, 'detach', {tabId});} catch {}
    inspectedTabId = null;
    throw e;
  }
  return true;
}
// Independent HTTP evidence even when DevTools or the debugger owns the tab.
// Permissions are still generated EXCLUSIVELY from the active site adapter.
const permittedWebRequestUrls=(chrome.runtime.getManifest().host_permissions || [])
  .filter(p=>p.startsWith('https://') && p.endsWith('/*'));
if (permittedWebRequestUrls.length && chrome.webRequest?.onCompleted?.addListener) {
  chrome.webRequest.onCompleted.addListener(details=>{
    if(!state || details.tabId!==state.tabId || details.type!=='image' ||
       !imagePermission(details.url)) return;
    const url=normalizeResourceUrl(details.url);
    const status=Number(details.statusCode)||0;
    if(status<100 || status>599)return;
    imageWebRequestStatus.set(url,{
      status,source:'chrome.webRequest',fromCache:!!details.fromCache,
      observedInManagedTab:true,failed:false
    });
    if(imageWebRequestStatus.size>400)
      imageWebRequestStatus.delete(imageWebRequestStatus.keys().next().value);
  }, {urls:permittedWebRequestUrls,types:['image']});
}
if (chrome.debugger?.onEvent?.addListener) {
  chrome.debugger.onEvent.addListener((source, method, params={}) => {
    if (!state || source.tabId !== state.tabId || source.tabId !== inspectedTabId ||
        !inspectedReady) return;
    // Chrome JavaScript dialogs are NOT the native form-repost warning.
    // Never auto-accept arbitrary confirm/prompt/security dialogs.
    if (method === 'Page.javascriptDialogOpening') {
      const kind=String(params.type||'');
      if ((kind==='alert' || (kind==='beforeunload' && dialogNavigationInFlight)) &&
          handledNavigationDialogs<3) {
        handledNavigationDialogs++;
        cdp('Page.handleJavaScriptDialog',{accept:true}).then(()=>{
          console.info('BROWSER_DIALOG_AUTO_ACCEPTED kind=js-'+kind);
        }).catch(e=>console.warn('Comic Bridge dialog handler:',String(e)));
      } else {
        console.warn('BROWSER_DIALOG_MANUAL_ACTION_REQUIRED kind='+kind);
      }
      return;
    }
    if (method === 'Network.responseReceived' && params.type === 'Image' &&
        imagePermission(params.response?.url)) {
      const url = normalizeResourceUrl(params.response.url);
      const status = Number(params.response.status) || 0;
      imageNetworkStatus.set(url, {status,
        mimeType:String(params.response.mimeType||'').slice(0,80),
        fromDiskCache:!!params.response.fromDiskCache,
        fromServiceWorker:!!params.response.fromServiceWorker});
      networkRequestUrl.set(params.requestId,url);
      if (imageNetworkStatus.size>400) imageNetworkStatus.delete(imageNetworkStatus.keys().next().value);
      if (networkRequestUrl.size>400) networkRequestUrl.delete(networkRequestUrl.keys().next().value);
      if (status>=200 && status<300) {
        imageRequests.set(url, params.requestId);
        imageByRequest.set(params.requestId, url);
        if (imageRequests.size > 400) imageRequests.delete(imageRequests.keys().next().value);
      }
    } else if (method === 'Network.loadingFinished') {
      // Critical: capture original bytes IMMEDIATELY after the normal page
      // loads an image, rather than waiting until the entire lazy scroll ends.
      // Chromium may evict response bodies long before Python requests them.
      const url = imageByRequest.get(params.requestId);
      if (!url) return;
      imageByRequest.delete(params.requestId);
      cdp('Network.getResponseBody', {requestId:params.requestId}).then(body => {
        if (body.base64Encoded && typeof body.body === 'string')
          storeOriginalImage(url, body.body);
        else captureFailures++;
      }).catch(() => {captureFailures++;});
    } else if (method === 'Network.loadingFailed') {
      const url=networkRequestUrl.get(params.requestId);
      if(url) imageNetworkStatus.set(url,{...(imageNetworkStatus.get(url)||{}),
        failed:true,errorText:String(params.errorText||'').slice(0,130)});
      imageByRequest.delete(params.requestId);
      networkRequestUrl.delete(params.requestId);
    }
  });
}
if (chrome.debugger?.onDetach?.addListener) {
  chrome.debugger.onDetach.addListener(source => {
    if (source.tabId === inspectedTabId) {
      inspectedTabId = null; inspectedReady = false; clearImageMemory();
    }
  });
}
function findFrameResource(frameTree, sought) {
  if (!frameTree) return null;
  const own = (frameTree.resources || []).find(item =>
    item.type === 'Image' && normalizeResourceUrl(item.url) === sought);
  if (own) return {frameId:frameTree.frame.id, url:own.url};
  for (const child of frameTree.childFrames || []) {
    const match = findFrameResource(child, sought);
    if (match) return match;
  }
  return null;
}
// A page may have loaded its first images before the user paired the
// extension. Chrome can sometimes serialize already-loaded resources as
// MHTML. Parse only allowlisted ORIGINAL image bytes, never document content.
// A single best-effort snapshot is permitted per chapter; never reload tabs.
async function recoverExistingPageSnapshot() {
  if (snapshotAttempted || !inspectedReady) return;
  snapshotAttempted = true;
  try {
    const response = await cdp('Page.captureSnapshot', {format:'mhtml'});
    const raw = response?.data;
    if (typeof raw !== 'string' || raw.length > 180 * 1024 * 1024) return;
    const firstHeaderEnd = raw.search(/\r?\n\r?\n/);
    if (firstHeaderEnd < 0 || firstHeaderEnd > 10000) return;
    const header = raw.slice(0, firstHeaderEnd);
    const boundary = header.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
    if (!boundary || boundary.length > 180) return;
    const parts = raw.split('--' + boundary);
    for (const part of parts) {
      const ix = part.search(/\r?\n\r?\n/);
      if (ix < 0 || ix > 8000) continue;
      const partHeaders = part.slice(0, ix);
      if (!/^Content-Type:\s*image\/(?:jpeg|png|webp|gif|avif|bmp)\b/im.test(partHeaders) ||
          !/^Content-Transfer-Encoding:\s*base64\s*$/im.test(partHeaders)) continue;
      const location = partHeaders.match(/^Content-Location:\s*(.+)$/im)?.[1]?.trim();
      if (!location || !imagePermission(location)) continue;
      const body = part.slice(ix).replace(/^\r?\n\r?\n/, '').trim().replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) continue;
      storeOriginalImage(normalizeResourceUrl(location), body);
    }
  } catch(e) { console.debug('Browser page snapshot did not expose original images:',String(e)); }
}

async function browserLoadedImage(url) {
  if (!imagePermission(url)) return null;
  if (!inspectedReady) {
    try {await attachSelectedTab();} catch(e) {
      lastError = 'Chrome cannot inspect already loaded images: ' + String(e);
      return null;
    }
  }
  const key = normalizeResourceUrl(url);
  const saved = capturedImages.get(key);
  if (saved) return {base64:saved.base64, via:'captured-during-scroll'};
  // The image may have loaded BEFORE pairing. Check page memory as a best
  // effort. Never reload the accepted page merely to collect its resources.
  try {
    const result = await cdp('Page.getResourceTree');
    const resource = findFrameResource(result.frameTree, key);
    if (resource) {
      const body = await cdp('Page.getResourceContent', resource);
      if (body.base64Encoded && typeof body.content === 'string' && body.content.length &&
          body.content.length <= MAX_IMAGE_BYTES * 4 / 3 + 8) {
        storeOriginalImage(key, body.content);
        return {base64:body.content,via:'page-resource-cache'};
      }
    }
  } catch(e) {console.debug('Loaded page resource unavailable:',String(e));}
  const id = imageRequests.get(key);
  if (id) {
    try {
      const body = await cdp('Network.getResponseBody', {requestId:id});
      if (body.base64Encoded && typeof body.body === 'string' && body.body.length &&
          body.body.length <= MAX_IMAGE_BYTES * 4 / 3 + 8) {
        storeOriginalImage(key, body.body);
        return {base64:body.body,via:'recent-network-response'};
      }
    } catch(e) {console.debug('Image response body expired:',String(e));}
  }
  await recoverExistingPageSnapshot();
  let recovered = capturedImages.get(key);
  if (recovered) return {base64:recovered.base64,via:'loaded-page-snapshot'};
  // The image was loaded before Chrome's debugger was attached. Re-load only
  // that exact, already decoded DOM image in its ORIGINAL document context;
  // never modify URL, create other tabs, or reload the chapter.
  try {
    const replay = await send(state.tabId, {type:'REOBSERVE_LOADED_IMAGE',payload:{url:key}});
    if (replay?.ok && replay?.loaded) {
      for (let i=0;i<14;i++) {
        await sleep(250);
        recovered=capturedImages.get(key);
        if (recovered) return {base64:recovered.base64,via:'normal-tab-image-reload'};
      }
      // A browser cache hit might not have emitted Network events.
      const latest = imageRequests.get(key);
      if (latest) {
        try {
          const body = await cdp('Network.getResponseBody', {requestId:latest});
          if (body.base64Encoded && typeof body.body === 'string' && storeOriginalImage(key,body.body))
            return {base64:body.body,via:'normal-tab-image-response'};
        } catch {}
      }
    }
  } catch(e) {console.debug('Original-tab image response not accessible:',String(e));}
  const recoveredAfter = capturedImages.get(key);
  if (recoveredAfter) return {base64:recoveredAfter.base64,via:'normal-tab-image-response'};
  return null;
}

// VISUAL-FIDELITY FALLBACK: a screenshot of decoded pixels from the ONE
// selected browser tab. This is not the original response; always label PNG.
// Chrome's captureVisibleTab requires <all_urls> or a user-activated activeTab
// grant, EVEN if a site-specific host permission exists. Unattended operation
// uses Page.captureScreenshot via the already-declared debugger permission
// when Chrome denies captureVisibleTab; no blanket all-sites grant is needed.
const visualImages = new Map();
let lastScreenshotAt = 0;
let screenshotBackend = 'auto';
const SCREENSHOT_GAP_MS = 560; // Chrome tabs capture API rate limit; NOT used for debugger.
// A hanging Chrome API must fail this ONE image, not block later scroll jobs.
// This is a per-I/O inactivity watchdog, never a chapter/run time limit.
const BROWSER_IO_STALL_MS = 18000;
async function checkedIO(task, name, timeoutMs=BROWSER_IO_STALL_MS) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(task),
      new Promise((_, reject) => {timeout=setTimeout(() => reject(
        Error('Selected-tab browser API stalled: '+name)), timeoutMs);})
    ]);
  } finally { clearTimeout(timeout); }
}
const browserImageOrigins = () => {
  const source = new Set((chrome.runtime.getManifest().content_scripts?.[0]?.matches || []).map(p => {
    try{return new URL(p.replace(/\*/g, 'source')).origin;}catch{return '';}
  }));
  return (chrome.runtime.getManifest().host_permissions || []).filter(p => p.startsWith('https://'))
    .map(p => {try{return new URL(p.replace(/\*/g, 'resource')).origin;}catch{return '';}})
    .filter(o => o && !source.has(o));
};
const bytesToBase64 = bytes => {
  const chunks=[];
  for (let i=0;i<bytes.length;i+=16384) chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(chunks.join(''));
};
async function selectedTabScreenshot(tab) {
  // Neither capture API may be used for arbitrary tabs or off-site documents.
  if(!state || tab.id !== state.tabId || !sourceMatches(tab.url))
    throw Error('Screenshot refused outside the selected comic tab');
  let tabError = '';
  if(screenshotBackend !== 'debugger' && chrome.tabs.captureVisibleTab) {
    try {
      const screenshot = await call(chrome.tabs,'captureVisibleTab',tab.windowId,{format:'png'});
      if(typeof screenshot !== 'string' || !screenshot.startsWith('data:image/png;base64,'))
        throw Error('Chrome returned no screenshot PNG');
      screenshotBackend = 'chrome-tabs';
      return screenshot;
    } catch(error) {
      tabError = String(error);
      // Only the Chrome-specific capture permission failure warrants a switch
      // to debugger screenshots. Do not conceal unrelated capture failures.
      if(!/all_urls|activeTab|permission is required|permission not granted/i.test(tabError))
        throw error;
      screenshotBackend = 'debugger';
    }
  }
  if(!chrome.debugger?.attach || !chrome.debugger?.sendCommand)
    throw Error('Automatic screenshot needs the declared debugger permission; '+tabError);
  try {
    if(inspectedTabId !== state.tabId || !inspectedReady)
      await attachSelectedTab();
    const result = await cdp('Page.captureScreenshot', {
      format:'png',fromSurface:true,captureBeyondViewport:false
    });
    const data = result?.data;
    if(typeof data !== 'string' || !data ||
       data.length > MAX_IMAGE_BYTES * 4 / 3 + 8 ||
       !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw Error('Chrome debugger returned invalid screenshot PNG');
    return 'data:image/png;base64,' + data;
  } catch(error) {
    throw Error('Automatic screenshot unavailable on selected tab: '+String(error)+
      (tabError ? ' (captureVisibleTab: '+tabError+')' : '')+
      '. Close DevTools on that tab, then rerun Python; no pairing code is required.');
  }
}

async function captureVisibleImage(url) {
  const key=normalizeResourceUrl(url);
  // Same-origin blob images can already be fully decoded in the selected
  // browser tab. Only accept an actual decoded DOM image and an exact origin
  // match, then capture its rendered pixels. Never fetch arbitrary blob URLs.
  let selectedBlob=false;
  if(key.startsWith('blob:')) {
    const selected=await checkedIO(tabsGet(state.tabId),'verify blob owning tab');
    const blobOrigin=new URL(key).origin;
    selectedBlob=sourceMatches(selected.url) && blobOrigin===new URL(selected.url).origin &&
      !!(await checkedIO(send(state.tabId,{type:'IMAGE_STATUS',payload:{url:key}}),'verify decoded blob')).loaded;
  }
  if(!imagePermission(key) && !selectedBlob) throw Error('Image URL not allowed by adapter or decoded tab');
  const prior=visualImages.get(key);
  if(prior) return {base64:prior,via:'rendered-png'};
  if ((!chrome.tabs.captureVisibleTab && !chrome.debugger?.attach) ||
      typeof OffscreenCanvas === 'undefined' ||
      typeof createImageBitmap !== 'function')
    throw Error('Chrome screenshot and image-composition APIs unavailable');
  const tab=await checkedIO(tabsGet(state.tabId), 'get selected tab');
  if(!tab.active) await checkedIO(tabsUpdate(state.tabId,{active:true}), 'focus selected tab');
  // Do not restore a stale scroll offset between individual screenshots.
  // In particular, checkpoint resumes often start at the bottom; restoring
  // that bottom after each tile visibly teleported up/down 100+ times.
  // Screenshots now advance the normal tab toward the next ordered image.
  let canvas=null, ctx=null, nextCss=0, sourceWidth=0, sourceHeight=0;
  for(let tile=0;tile<100;tile++) {
    const r=await checkedIO(send(state.tabId,{type:'CAPTURE_IMAGE_TILE',payload:{url:key,offsetCss:nextCss}}), 'position image tile');
    if(!r?.ok || !r.loaded) throw Error('The image is not visibly decoded in the paired tab: '+String(r?.reason||key));
    if (!r.rect || !r.rect.width || !r.rect.height) throw Error('Image has no visible dimensions');
    if(!canvas) {
      sourceWidth=Math.round(r.naturalWidth);sourceHeight=Math.round(r.naturalHeight);
      if(!sourceWidth || !sourceHeight || sourceWidth*sourceHeight>36000000) throw Error('Rendered image dimensions exceed safe limit');
      canvas=new OffscreenCanvas(sourceWidth,sourceHeight);
      ctx=canvas.getContext('2d',{alpha:false});
      if(!ctx) throw Error('2D screenshot renderer unavailable');
    }
    const rect=r.rect;
    // Only capture the unobscured viewport; keep space for sticky headers.
    const start=Math.max(nextCss,Math.max(0,90-rect.top));
    const end=Math.min(rect.height, r.viewportHeight-12-rect.top);
    if(end<=start+1) throw Error('Image cannot be fully captured at this viewport size');
    // chrome.tabs.captureVisibleTab enforces 2 screenshots/sec. The CDP
    // selected-tab fallback does not need this additional artificial delay.
    const wait=screenshotBackend==='chrome-tabs'
      ? Math.max(0,SCREENSHOT_GAP_MS-(Date.now()-lastScreenshotAt)) : 0;
    if(wait) await sleep(wait);
    const dataURL=await checkedIO(selectedTabScreenshot(
      await checkedIO(tabsGet(state.tabId), 'screenshot tab lookup')), 'capture selected-tab pixels');
    lastScreenshotAt=Date.now();
    const bmp=await checkedIO(createImageBitmap(
      await checkedIO((await checkedIO(fetch(dataURL), 'decode screenshot data URL')).blob(), 'read screenshot blob')),
      'decode screenshot bitmap');
    try {
      const scaleX=bmp.width/r.viewportWidth, scaleY=bmp.height/r.viewportHeight;
      const destY=start/rect.height*sourceHeight;
      const destHeight=(end-start)/rect.height*sourceHeight;
      // The image may be horizontally centered and scaled by browser zoom.
      const left=Math.max(0,rect.left);
      const right=Math.min(r.viewportWidth,rect.left+rect.width);
      const destX=(left-rect.left)/rect.width*sourceWidth;
      const destWidth=(right-left)/rect.width*sourceWidth;
      ctx.drawImage(bmp,left*scaleX,(rect.top+start)*scaleY,
        (right-left)*scaleX,(end-start)*scaleY,
        destX,destY,destWidth,destHeight);
    } finally {bmp.close?.();}
    if(end>=rect.height-0.5) {
      const blob=await checkedIO(canvas.convertToBlob({type:'image/png'}), 'encode image PNG');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      if(!bytes.length || bytes.length>MAX_IMAGE_BYTES) throw Error('Rendered PNG exceeds per-image limit');
      const base64=bytesToBase64(bytes);
      visualImages.set(key,base64);
      if(visualImages.size>3) visualImages.delete(visualImages.keys().next().value);
      return {base64,via:'rendered-png'};
    }
    nextCss=end;
  }
  throw Error('Visual image capture exceeded the tile safety limit');
}

function captureDiagnostics() {
  return {debuggerAttached:!!inspectedReady, capturedImages:capturedImages.size,
          capturedBytes, captureFailures, observedImageRequests:imageRequests.size,
          pageSnapshotChecked:snapshotAttempted};
}

async function api(path, data) {
  if (!state) throw Error('Not connected');
  const response = await fetch('http://127.0.0.1:' + state.port + path, {
    method:data === undefined ? 'GET' : 'POST',
    headers:{'Content-Type':'application/json','X-Comic-Bridge-Token':state.token,
      'X-Comic-Bridge-Client':chrome.runtime.id},
    body:data === undefined ? undefined : JSON.stringify(data),
    cache:'no-store'
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || ('HTTP ' + response.status));
  return result;
}
function sourceMatches(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    // Permission patterns are generated from site_specific/site_adapter.py.
    const patterns = chrome.runtime.getManifest().content_scripts?.[0]?.matches || [];
    return patterns.some(p => {
      const parts = p.split('*');
      return parts.length === 2 && parsed.href.startsWith(parts[0]);
    });
  } catch {return false;}
}
async function tabInfo() {
  const tab=await tabsGet(state.tabId);
  if (!tab || !sourceMatches(tab.url)) throw Error('Selected tab is no longer on this source website');
  return tab;
}
// Wait for the *destination document*, not merely a tab on the same site.
// tabs.update() resolves before navigation necessarily commits.  A PING from
// the previous chapter can otherwise be accepted and immediately disappear.
const canonicalPage = value => {
  try { const u = new URL(value); u.hash = ''; return u.href; } catch { return ''; }
};
async function waitContent(timeoutMs=85000, targetUrl='') {
  const until=Date.now()+timeoutMs;
  const wanted=canonicalPage(targetUrl);
  let lastInject=0;
  let lastProblem='';
  while(Date.now()<until) {
    let tab;
    try {tab=await tabInfo();}
    catch(e) {lastProblem=String(e);await sleep(350);continue;}
    // Wait until Chrome has reached the requested URL and its new document is
    // no longer loading, before injecting code into that document.
    if (wanted && canonicalPage(tab.url)!==wanted) {
      await sleep(250);continue;
    }
    if (tab.status==='loading') {await sleep(250);continue;}
    try {
      const response=await send(state.tabId,{type:'PING'});
      if (response?.ok && response.bridgeContentProtocol===6 &&
          sourceMatches(response.url) &&
          (!wanted || canonicalPage(response.url)===wanted) &&
          canonicalPage(response.url)===canonicalPage(tab.url)) return response;
      lastProblem='Content-script PING belongs to a different document or old protocol';
    } catch(e) {lastProblem=String(e);}
    // Initial injection may race with commit; permit further attempts after
    // the destination reports complete, instead of trying exactly once.
    if (Date.now()-lastInject >= 1200) {
      lastInject=Date.now();
      try {
        if (chrome.scripting?.executeScript)
          await chrome.scripting.executeScript({target:{tabId:state.tabId},files:['content.js']});
        else if (chrome.tabs.executeScript)
          await call(chrome.tabs,'executeScript',state.tabId,{file:'content.js'});
      } catch(e) {lastProblem=String(e);}
    }
    await sleep(350);
  }
  throw Error('Comic Bridge content script not ready in destination chapter '+
    (wanted || '(current tab)')+'; '+lastProblem+
    '. Keep the selected tab open and verify extension access to its URL.');
}
async function toBase64(bytes) {
  const blob = new Blob([bytes]);
  const reader=new FileReader();
  return new Promise((resolve,reject) => {
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(Error('Image conversion failed'));
    reader.readAsDataURL(blob);
  });
}
// A genuinely stalled selected-tab content channel is a LOCAL failure, never
// permission to record a server-missing image or silently advance a chapter.
// Recycle only the tab this extension explicitly created. Python will restart
// the scan from per-image checkpoints; it will NOT retry a non-idempotent SCROLL.
async function recycleManagedChapterTab() {
  if (!state) throw Error('No paired tab to recycle');
  const oldId=state.tabId;
  const old=await checkedIO(tabsGet(oldId),'inspect managed tab before recycling',5000);
  if (!old || !sourceMatches(old.url)) throw Error('Untrusted tab cannot be recycled');
  const saved=await checkedIO(storageGet(['comicBridgeManagedTabId','comicBridgeManagedSite']),
      'verify managed tab ownership',5000);
  const hostname=new URL(old.url).hostname;
  if (saved.comicBridgeManagedTabId!==oldId || saved.comicBridgeManagedSite!==hostname)
    throw Error('Refusing to recycle a tab not owned by Comic Bridge');
  let replacement=null;
  try {
    replacement=await checkedIO(call(chrome.tabs,'create',{url:old.url,active:true}),
      'create new managed chapter tab',12000);
    if (!replacement || !Number.isInteger(replacement.id) || replacement.id===oldId)
      throw Error('Chrome did not create a distinct managed tab');
    state.tabId=replacement.id;
    await checkedIO(waitContent(45000,old.url),'initialize new managed chapter document',48000);
    await checkedIO(storageSet({comicBridgeManagedTabId:replacement.id,
      comicBridgeManagedSite:hostname,selectedTabId:replacement.id}),
      'persist replacement managed tab',6000);
    // Rebind the Python listener before completing the pending RPC, or its
    // next command might be attributed to the closed old tab.
    await checkedIO(api('/hello',{url:old.url,bridge_protocol:'visual-transfer-2',
      capabilities:['probe','image','content-v2'],
      tab_ownership:'extension-managed',tab_id:replacement.id}),
      'rebind Python to replacement tab',6000);
    clearImageMemory();
    // Only an extension-owned tab is eligible; user's other Chrome tabs remain.
    try {await checkedIO(call(chrome.tabs,'remove',oldId),
      'close stalled extension-owned tab',3000);} catch(error) {
      console.warn('Comic Bridge: old managed tab could not be closed:',String(error));
    }
    return {transport_reset:true,tab_id:replacement.id,url:old.url,
      reason:'stalled selected-tab scroll transport; new managed document ready'};
  } catch(error) {
    state.tabId=oldId;
    if (replacement?.id) {
      try {await checkedIO(call(chrome.tabs,'remove',replacement.id),
        'close unsuccessful replacement tab',2500);} catch {}
    }
    throw error;
  }
}

async function execute(job) {
  const {action,payload={}}=job;
  await tabInfo();
  // The browser may detach on navigation or when DevTools takes ownership.
  // Stop BEFORE another scroll if loaded-response inspection was lost.
  // The visual path is independent of debugger state.  Never stall a chapter
  // trying to reattach a debugger that Chrome already rejected.
  if (action === 'navigate') {
    const desired=new URL(payload.url);
    const current=new URL((await tabsGet(state.tabId)).url);
    if (!sourceMatches(desired.href) || desired.host !== current.host)
      throw Error('Cross-site navigation refused');
    clearImageMemory();
    if (desired.href !== current.href) {
      await tabsUpdate(state.tabId,{url:desired.href});
    } else {
      // A recovery reload must create a NEW document even at the SAME URL.
      // The prior no-op reused a stalled content script forever. Observe the
      // loading->complete transition; a same-URL PING alone is not proof.
      const tabId=state.tabId;
      const completed=new Promise((resolve,reject)=>{
        let sawLoading=false, done=false, timer;
        const finish=error=>{
          if(done)return; done=true;clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(observer);
          error?reject(error):resolve();
        };
        const observer=(id,info)=>{
          if(id!==tabId)return;
          if(info.status==='loading')sawLoading=true;
          if(info.status==='complete' && sawLoading)finish();
        };
        chrome.tabs.onUpdated.addListener(observer);
        timer=setTimeout(()=>finish(Error('Same-URL reload did not finish loading')),45000);
        // Listener is installed BEFORE starting reload. There is no valid
        // shortcut based on the existing page answering a PING.
      });
      await Promise.all([completed,call(chrome.tabs,'reload',tabId,{bypassCache:false})]);
    }
    // Never accept the old chapter's receiver while navigation commits.
    const result=await waitContent(85000, desired.href);
    return {url:result.url,status:200};
  }
  // COMICARCHIVER_AUTH_BLOB_TRANSFER_20261122 provider-neutral extension action follows
  // Generic browser-memory transfer for a decoded blob: image.  This reads
  // the image that the source page ALREADY created, in its own main world.
  // There is no external fetch, cookie copy, extension-origin CDN request,
  // redirect or bypass. Source selectors are supplied by the ONE site adapter.
  if (action === 'read_loaded_blob') {
    const tab=await tabsGet(state.tabId);
    if (!sourceMatches(tab.url)) throw Error('Decoded image requested outside the selected site');
    const origin=new URL(tab.url).origin;
    const wanted=String(payload?.url||'').trim();
    if (!wanted.startsWith('blob:'+origin+'/'))
      throw Error('Decoded blob does not belong to the selected source page');
    const roots=Array.isArray(payload?.reader_selectors)?payload.reader_selectors:[];
    if (!roots.length || roots.length>12 || roots.some(x=>typeof x!=='string' || x.length>180))
      throw Error('Decoded image requires adapter-defined reader selectors');
    const raw=await checkedIO(chrome.scripting.executeScript({
      target:{tabId:state.tabId}, world:'MAIN',
      func:async (blobUrl,selectors,expectedOrigin)=>{
        if (location.origin!==expectedOrigin || !blobUrl.startsWith('blob:'+location.origin+'/'))
          return {status:403,reason:'Blob origin/document mismatch'};
        const roots=selectors.map(s=>{try{return document.querySelector(s);}catch{return null;}}).filter(Boolean);
        const images=roots.flatMap(r=>[...r.querySelectorAll('img')]);
        const matches=images.filter(im=>(im.currentSrc||im.src||'')===blobUrl &&
          im.complete && im.naturalWidth>0 && im.naturalHeight>0);
        if (!matches.length) return {status:424,reason:'No decoded matching image in the current reader'};
        try {
          // This is a local browser blob read, not a request to the image CDN.
          const result=await fetch(blobUrl);
          if(!result.ok) return {status:424,reason:'The local blob is no longer accessible'};
          const bytes=new Uint8Array(await result.arrayBuffer());
          if(!bytes.length || bytes.length>20*1024*1024)
            return {status:413,reason:'Decoded reader image exceeds size limit'};
          const chunks=[];
          for(let i=0;i<bytes.length;i+=16384)
            chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
          return {status:200,base64:btoa(chunks.join('')),via:'decoded-source-tab-blob',
            headers:{'content-type':result.headers.get('content-type')||'application/octet-stream'}};
        }catch(e){return {status:424,reason:'Source document cannot read its decoded blob: '+String(e).slice(0,120)};}
      },args:[wanted,roots,origin]
    }), 'read exact decoded image from managed browser tab',35000);
    const value=raw?.[0]?.result;
    if(!value || !Number.isInteger(value.status))
      throw Error('Decoded browser image returned no structured result');
    if (value.status===200 && (!value.base64 || value.base64.length>MAX_IMAGE_BYTES*4/3+8))
      throw Error('Decoded image result exceeds transport limit');
    // ADDITIVE: a decoded <img> may keep displaying a browser-created blob
    // after the source page revokes its blob URL.  MAIN-world fetch then
    // raises TypeError despite real pixels being visible.  Keep original
    // byte transfer as the first choice.  Only for this exact failed local
    // blob read, reuse the existing selected-tab rendered-PNG capture, which
    // rechecks the exact image URL and decoded state before capturing tiles.
    // Never replace this with a cross-origin request or guessed CDN address.
    if (value.status===424 &&
        /^(Source document cannot read its decoded blob:|The local blob is no longer accessible)/.test(value.reason||'')) {
      try {
        const rendered=await captureVisibleImage(wanted);
        if (!rendered?.base64 || rendered.base64.length>MAX_IMAGE_BYTES*4/3+8)
          throw Error('Selected-tab rendered image returned no bounded PNG');
        console.info('BROWSER_DECODED_BLOB_PIXEL_FALLBACK exact_image=true fidelity=rendered-png');
        return {url:wanted,status:200,base64:rendered.base64,
          headers:{'content-type':'image/png'},via:'rendered-png',
          diagnostics:{blobReadFailed:true,visualProof:true},
          bridge_revision:'decoded-blob-fallback-diagnostics-v1'};
      } catch (error) {
        // The existing 424 remains authoritative when screenshot recovery
        // cannot prove the exact image. Preserve image-order/checkpoint gates.
        return {url:wanted,status:value.status,base64:'',
          headers:value.headers||{},via:value.via||'decoded-source-tab-blob',
          reason:value.reason||'',
          diagnostics:{pixelFallbackError:String(error).slice(0,320)},
          bridge_revision:'decoded-blob-fallback-diagnostics-v1'};
      }
    }
    return {url:wanted,status:value.status,base64:value.base64||'',
      headers:value.headers||{},via:value.via||'decoded-source-tab-blob',
      reason:value.reason||'',bridge_revision:'decoded-blob-fallback-diagnostics-v1'};
  }
  if (action === 'probe') {
    // Open tabs predating extension installation need content-script injection.
    await waitContent(10000);
    const first=await checkedIO(send(state.tabId,{type:'FIRST_LOADED_IMAGE',payload:{origins:browserImageOrigins(),reader_selectors:Array.isArray(payload?.reader_selectors)?payload.reader_selectors:[]}}), 'probe visible images');
    if(!first?.url) throw Error('No decoded CDN image on the selected page; scroll to the first chapter image and retry pairing');
    const already=capturedImages.get(normalizeResourceUrl(first.url));
    const original=already ? {base64:already.base64,via:'captured-during-scroll'} : null;
    // For browser-created blob URLs, original bytes are intentionally not
    // recoverable via the CDN cache. Prove real displayed pixels instead.
    const result=first.url.startsWith('blob:')
      ? await captureVisibleImage(first.url)
      : (original || await captureVisibleImage(first.url));
    return {url:first.url,status:200,base64:result.base64,via:result.via};
  }
  if (action === 'image') {
    const u=new URL(payload.url);
    if (u.protocol !== 'https:') throw Error('Images must use HTTPS');
    if (!imagePermission(u.href)) throw Error('Image host has no declared permission; update the site adapter');
    // Read the actual image response the human-selected tab already received.
    // This avoids a redundant extension-origin CDN request that may return 403.
    const already=capturedImages.get(normalizeResourceUrl(u.href));
    const loaded = already ? {base64:already.base64,via:'captured-during-scroll'} : null;
    if (loaded) return {url:u.href,status:200,headers:{},base64:loaded.base64,via:loaded.via};
    if (requiresTabCapture()) {
      const rendered=await captureVisibleImage(u.href);
      return {url:u.href,status:200,headers:{},base64:rendered.base64,via:rendered.via};
    }
    // When an adapter declares a cross-origin CDN, DO NOT issue the separate
    // extension fetch known to get 403. Report what the normal tab can render.
    if (requiresTabCapture()) {
      const diagnostics=captureDiagnostics();
      try {diagnostics.tabImage=await send(state.tabId,{type:'IMAGE_STATUS',payload:{url:u.href}});} catch{}
      return {url:u.href,status:424,headers:{},base64:'',diagnostics,
        reason:'No original image bytes were available from the paired browser tab'};
    }
    // Same-origin sites may still use a normal extension fetch.
    // A normal <img> can decode in the managed tab even when a SEPARATE
    // extension-origin fetch throws (CORS on redirects, network failures).
    // The existing HTTP-error fallback below cannot run when fetch rejects.
    // Keep original-byte success unchanged; use only the already-implemented
    // rendered-pixel capture if this particular fetch failed AND the exact
    // image is decoded in the currently managed tab.
    let response;
    try {
      response=await fetch(u.href,{credentials:'include',cache:'default'});
    } catch(fetchError) {
      const diagnostics=captureDiagnostics();
      diagnostics.originalFetchError=String(fetchError).slice(0,240);
      try {
        diagnostics.tabImage=await send(state.tabId,{type:'IMAGE_STATUS',payload:{url:u.href}});
      } catch(statusError) {
        diagnostics.tabStatusError=String(statusError).slice(0,240);
      }
      if (diagnostics.tabImage?.loaded) {
        try {
          const rendered=await captureVisibleImage(u.href);
          if (rendered?.base64) {
            return {url:u.href,status:200,headers:{},base64:rendered.base64,
              via:rendered.via,diagnostics};
          }
        } catch(captureError) {
          diagnostics.renderFallbackError=String(captureError).slice(0,240);
        }
      }
      lastError='Original image fetch rejected; decoded-tab fallback unavailable. '
        + JSON.stringify(diagnostics);
      return {url:u.href,status:424,headers:{},base64:'',
        reason:'Original-byte fetch rejected; visible-image recovery unavailable',
        diagnostics};
    }
    const bytes=response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
    if (bytes.byteLength > 90*1024*1024) throw Error('Image exceeds safety limit');
    const encoded= response.ok ? await toBase64(bytes) : '';
    const diagnostics=captureDiagnostics();
    if (!response.ok) {
      try {diagnostics.tabImage=await send(state.tabId,{type:'IMAGE_STATUS',payload:{url:u.href}});} catch{}
      // Additive fallback after a failed original-byte fetch. Preserve the
      // existing original response path for every site where it works.
      if (diagnostics.tabImage?.loaded) {
        try {
          const rendered=await captureVisibleImage(u.href);
          if (rendered?.base64) return {url:u.href,status:200,headers:{},base64:rendered.base64,via:rendered.via,
            diagnostics:{...diagnostics,originalFetchStatus:response.status}};
        } catch (error) {
          diagnostics.renderFallbackError=String(error).slice(0,240);
        }
      }
      lastError='Image not recoverable from loaded tab; extension fetch HTTP '+response.status+'. '+JSON.stringify(diagnostics);
    }
    return {url:response.url,status:response.status,headers:{'retry-after':response.headers.get('retry-after') || ''},base64:encoded,diagnostics};
  }
  if(action==='image_diagnostics') {
    const key=normalizeResourceUrl(payload?.url);
    if(!imagePermission(key)) throw Error('Image diagnostics must be limited to adapter-permitted URLs');
    let dom=null;
    try {dom=await checkedIO(send(state.tabId,{type:'IMAGE_STATUS',payload:{url:key}}),
      'read-only source image status',3500);} catch {}
    return {url:key,network:imageNetworkStatus.get(key)||imageWebRequestStatus.get(key)||null,
      capturedOriginal:capturedImages.has(key),dom,debuggerReady:!!inspectedReady};
  }
  const type={page:'PAGE',snapshot:'SNAPSHOT',classify:'CLASSIFY',scroll:'SCROLL',recover_image:'RECOVER_IMAGE'}[action];
  if (!type) throw Error('Unsupported command');
  // Also watch ordinary scroll/snapshot commands. A stalled content-script
  // message must not block the single extension command queue indefinitely.
  let result;
  try {
    // recoverImage waits at most ~7 seconds for a lazy-loaded DOM image. A
    // longer scripting wait means the Chrome API/transport is stalled, not
    // that we should abandon every other image in this chapter.
    result=await checkedIO(send(state.tabId,{type,payload}), action+' page command',
      action==='recover_image' ? 11000 : BROWSER_IO_STALL_MS);
  } catch(error) {
    if (action==='scroll' &&
        String(error).includes('Selected-tab browser API stalled: scroll page command')) {
      // SCROLL may have executed before its response was lost. A new document
      // and fresh scanner, not a second SCROLL, is the only safe recovery.
      try {return await recycleManagedChapterTab();}
      catch(recoveryError) {
        // Preserve the original failure classification and a precise reason
        // for any unsafe/unavailable tab recovery. Never invent server faults.
        throw Error(String(error)+'; managed-tab recovery unavailable: '+String(recoveryError));
      }
    }
    if(action!=='recover_image' ||
       !String(error).includes('Selected-tab browser API stalled: recover_image page command')) throw error;
    // The scripting API may hang independently from tabs.sendMessage. Fall
    // back once to the already-installed content listener in this SAME tab.
    // This command targets one absolute ordinal, not forward scroll or nav.
    console.warn('Comic Bridge: recovery injection stalled; trying existing tab listener once');
    const tab=await tabsGet(state.tabId);
    if(!sourceMatches(tab.url) || tab.status==='loading') throw error;
    result=await checkedIO(sendRaw(state.tabId,{type,payload}),
      'recover_image existing-listener fallback', 8500);
  }
  if (result?.error) throw Error(result.error);
  return result;
}
// Auto-discovery and authorization are strictly local. The Python listener
// serves a per-run token only to browser-extension origins (never web pages).
const AUTO_PORT=18765;
let autoConnecting=false;
function trustedStartupUrl(site, startupUrl) {
  try {
    const u=new URL(startupUrl);
    if(u.protocol!=='https:' || u.hostname!==site || !sourceMatches(u.href) ||
       u.username || u.password) return '';
    return u.href;
  } catch {return '';}
}
async function pickComicTab(site, startupUrl='') {
  const requested=trustedStartupUrl(site,startupUrl);
  // Never silently fall back to a manual tab when an automatic startup URL is invalid.
  if(startupUrl && !requested) return null;
  const tabs=await call(chrome.tabs,'query',{});
  const candidates=(tabs||[]).filter(tab => {
    if(!sourceMatches(tab.url)) return false;
    try {return new URL(tab.url).hostname===site;} catch{return false;}
  });
  if(requested) {
    // The extension owns the archiver tab. Never select an arbitrary tab with
    // the same URL: Chrome tabs.query() is not creation-order sorted, and the
    // user's older manual tab must NEVER be repurposed for an automatic run.
    const saved=await storageGet(['comicBridgeManagedTabId','comicBridgeManagedSite']).catch(()=>({}));
    const managed=candidates.find(tab => tab.id===saved.comicBridgeManagedTabId &&
      saved.comicBridgeManagedSite===site);
    if(managed) {
      if(canonicalPage(managed.url)!==canonicalPage(requested))
        return tabsUpdate(managed.id,{url:requested,active:true});
      return managed;
    }
    const owned=await call(chrome.tabs,'create',{url:requested,active:true});
    await storageSet({comicBridgeManagedTabId:owned.id,comicBridgeManagedSite:site});
    return owned;
  }
  // No startup URL: retain the original manual-only fallback for legacy
  // callers. An automatic current release always supplies startup_url.
  if(!candidates.length) return null;
  const preferred=await storageGet(['selectedTabId']).catch(()=>({}));
  return candidates.find(t=>t.id===preferred.selectedTabId) ||
         candidates.find(t=>t.active) || candidates[0];
}
async function autoConnect() {
  if(autoConnecting || polling || state) return;
  autoConnecting=true;
  try {
    const saved=await storageGet(['lastPort']).catch(()=>({}));
    const port=Number(saved.lastPort)||AUTO_PORT;
    if(!Number.isInteger(port)||port<1024||port>65535) return;
    const resp=await fetch('http://127.0.0.1:'+port+'/bootstrap',
      {cache:'no-store',headers:{Accept:'application/json',
        'X-Comic-Bridge-Bootstrap':'1',
        'X-Comic-Bridge-Client':chrome.runtime.id}});
    const config=await resp.json().catch(()=>({}));
    if(!resp.ok) throw Error('Local bridge bootstrap HTTP '+resp.status+
      ': '+String(config.error||'unknown server rejection'));

    if(config.protocol!=='visual-transfer-2'||!Number.isInteger(config.port)||
       !/^[A-Za-z0-9_-]{20,100}$/.test(config.token)) throw Error('Unexpected local bridge protocol');
    const tab=await pickComicTab(config.site,config.startup_url);
    if(!tab) { lastError='No authorized comic tab or startup URL available';return;}
    state={tabId:tab.id,port:config.port,token:config.token};
    try {
      // No debugger requirement: pixel capture is available in normal Chrome.
      // tabs.update may return the OLD document before the resume URL commits.
      // Use the trusted bootstrap URL for document readiness and first /hello;
      // otherwise a previous prologue can incorrectly claim this Python run.
      const expectedResumeUrl=trustedStartupUrl(config.site,config.startup_url);
      await waitContent(20000,expectedResumeUrl || tab.url);
      const readyTab=await tabInfo();
      if(expectedResumeUrl && canonicalPage(readyTab.url)!==canonicalPage(expectedResumeUrl))
        throw Error('BROWSER_RESUME_TARGET_NOT_READY: managed tab is not at the requested unfinished chapter');
      await api('/hello',{url:readyTab.url,
        bridge_protocol:'visual-transfer-2',capabilities:['probe','image','content-v2'],
        tab_ownership:'extension-managed',tab_id:state.tabId,
        tab_title:String((await tabInfo()).title||'').slice(0,200)});
      await storageSet({lastPort:port,selectedTabId:tab.id}).catch(()=>{});
      lastError='';
      workLoop();
    } catch(error) {state=null;throw error;}
  } catch(error) {
    lastError=String(error);
  } finally {autoConnecting=false;}
}
// Manifest V3 workers may be suspended; alarms wake them even when no popup
// is open. Restarted Python processes issue a new bootstrap token automatically.
if(chrome.alarms?.create) {
  try {chrome.alarms.create('comic-bridge-autoconnect',{periodInMinutes:0.5});} catch {}
  chrome.alarms.onAlarm?.addListener(alarm => {
    if(alarm.name==='comic-bridge-autoconnect') autoConnect();
  });
}
chrome.runtime.onStartup?.addListener(()=>autoConnect());
chrome.runtime.onInstalled?.addListener(()=>autoConnect());
chrome.tabs.onActivated?.addListener(()=>autoConnect());
chrome.tabs.onCreated?.addListener(()=>autoConnect());
chrome.tabs.onUpdated?.addListener((_tabId,changeInfo)=>{
  if(changeInfo?.url || changeInfo?.status==='complete') autoConnect();
});
setTimeout(()=>autoConnect(),200);
// The Python RPC may run for an arbitrarily long healthy image/chapter job.
// Heartbeats allow it to distinguish real browser work from a dead MV3 worker.
if (typeof setInterval === 'function') setInterval(() => {
  if (!state || !polling) return;
  api('/heartbeat', {active:true}).catch(() => {});
}, 5000);

async function workLoop() {
  if (polling || !state) return;
  polling=true;
  try {
    await api('/hello',{url:(await tabInfo()).url,bridge_protocol:'visual-transfer-2',capabilities:['probe','image','content-v2'],
        tab_ownership:'extension-managed',tab_id:state.tabId,
        tab_title:String((await tabInfo()).title||'').slice(0,200)});
    while (state) {
      const command=(await checkedIO(api('/next'), 'poll local Python bridge')).command;
      if (!command) {
        // Chrome MV3 service workers suspend while idle. Refresh the extension
        // API activity timer during long archive runs.
        if (chrome.runtime.getPlatformInfo) {
          try {await call(chrome.runtime, 'getPlatformInfo');} catch {}
        }
        await sleep(700);continue;
      }
      let response;
      try {
        if(command.action==='navigate') {
          dialogNavigationInFlight=true;
          handledNavigationDialogs=0;
          // Best-effort: the existing debugger also observes JS dialogs.
          try {await attachSelectedTab();}
          catch(e) {console.debug('Managed tab JS dialog monitor unavailable:',String(e));}
        }
        response={id:command.id,ok:true,data:await execute(command)};
      } catch(e) {response={id:command.id,ok:false,error:String(e)};}
      finally {if(command.action==='navigate')dialogNavigationInFlight=false;}
      await checkedIO(api('/result',response), 'deliver local Python result');
    }
  } catch(e) {
    lastError=String(e);
    if (state) console.warn('Comic Bridge:',lastError);
  } finally {
    polling=false;
    // Python may restart with a new per-run token. Never retry the stale one.
    state=null;
    setTimeout(()=>autoConnect(), 2500);
  }
}
chrome.runtime.onMessage.addListener((m,_sender,respond) => {
  if(m?.type==='AUTO_CONNECT') {
    (async()=>{
      if(m.tabId) {
        const tab=await tabsGet(m.tabId);
        if(!sourceMatches(tab.url)) throw Error('Select a supported comic chapter');
        await storageSet({selectedTabId:m.tabId});
        if(state && state.tabId!==m.tabId) state=null;
      }
      await autoConnect();
      return {ok:!!state,connected:!!state,error:lastError};
    })().then(respond,e=>respond({ok:false,error:String(e)}));
    return true;
  }
  if(m?.type==='STATUS') {
    respond({connected:!!state,polling,tabId:state?.tabId||null,
      error:lastError,bridgeProtocol:'visual-transfer-2',
      extensionVersion:chrome.runtime.getManifest().version,
      capture:captureDiagnostics()});
  }
});
