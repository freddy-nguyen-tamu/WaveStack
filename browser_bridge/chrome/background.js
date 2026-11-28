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
               window.__comicBridgeNestedScrollRevision !== 1 ||
               (command.payload?.rendered_reader_selector && window.__comicBridgeScopedRenderedRevision !== 1) ||
               ((command.type==='RECOVER_IMAGE_STATUS' || command.payload?.recovery_id) &&
                window.__comicBridgeRecoveryReceiptRevision !== 1) ||
               typeof window.__comicBridgeDirect !== 'function' ||
               ((command.type==='SCROLL' || command.type==='SCROLL_STATUS') &&
                window.__comicBridgeScrollRevision !== 1))
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
      if(/RECOVERY_(DOCUMENT_CHANGED|RECEIPT_UNKNOWN|RECEIPT_UNVERIFIED)/.test(failure)) throw error;
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
let scrollCommandSequence = 0;
let recoveryCommandSequence = 0;
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

async function captureVisibleImage(url, readerSelector=null) {
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
  let scopedTabUrl=null;
  if(readerSelector) {
    if(typeof readerSelector!=='string' || readerSelector.length>180 || !key.startsWith('https://'))
      throw Error('Invalid scoped rendered reader request');
    const selected=await checkedIO(tabsGet(state.tabId),'verify scoped reader tab');
    if(!sourceMatches(selected.url)) throw Error('Rendered image outside managed reader');
    scopedTabUrl=selected.url;
    const observation=await checkedIO(send(state.tabId,{type:'IMAGE_STATUS',payload:{url:key,rendered_reader_selector:readerSelector}}),'verify exact decoded native reader image');
    if(observation?.rendered_reader_revision!=='scoped-rendered-reader-v1' || !observation.loaded || observation.count!==1)
      throw Error('No unique decoded native reader image; refusing unapproved CDN access');
  }
  if(!imagePermission(key) && !selectedBlob && !scopedTabUrl) throw Error('Image URL not allowed by adapter or decoded tab');
  const prior=scopedTabUrl ? null : visualImages.get(key);
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
    if(scopedTabUrl && (await checkedIO(tabsGet(state.tabId),'verify reader tile document')).url!==scopedTabUrl)
      throw Error('Managed reader changed during image capture');
    const r=await checkedIO(send(state.tabId,{type:'CAPTURE_IMAGE_TILE',payload:{url:key,offsetCss:nextCss,
      ...(scopedTabUrl?{rendered_reader_selector:readerSelector}:{})}}), 'position image tile');
    if(scopedTabUrl && r?.rendered_reader_revision!=='scoped-rendered-reader-v1')
      throw Error('Scoped image tile not verified; reload extension');
    if(!r?.ok || !r.loaded) throw Error('The image is not visibly decoded in the paired tab: '+String(r?.reason||key));
    if (!r.rect || !r.rect.width || !r.rect.height) throw Error('Image has no visible dimensions');
    if(!canvas) {
      sourceWidth=Math.round(r.naturalWidth);sourceHeight=Math.round(r.naturalHeight);
      if(!sourceWidth || !sourceHeight || sourceWidth*sourceHeight>36000000) throw Error('Rendered image dimensions exceed safe limit');
      canvas=new OffscreenCanvas(sourceWidth,sourceHeight);
      ctx=canvas.getContext('2d',{alpha:false});
      if(!ctx) throw Error('2D screenshot renderer unavailable');
    }
    if(scopedTabUrl && (Math.round(r.naturalWidth)!==sourceWidth || Math.round(r.naturalHeight)!==sourceHeight))
      throw Error('Native reader image dimensions changed during capture');
    const rect=r.rect;
    // Only capture the unobscured viewport; keep space for sticky headers.
    const bounds=r.captureBounds;
    const start=Math.max(nextCss,Math.max(0,(bounds ? bounds.top : 90)-rect.top));
    const end=Math.min(rect.height, (bounds ? bounds.bottom : r.viewportHeight-12)-rect.top);
    if((bounds || scopedTabUrl) && (start>nextCss+0.5 || rect.left<(bounds?.left??0)-0.5 ||
        rect.left+rect.width>(bounds?.right??r.viewportWidth)+0.5))
      throw Error('Reader image is clipped: refusing to save an incomplete rendered panel');
    // A native image may be a single row (or column). Require actual
    // positive coverage, not an arbitrary >1 CSS-pixel tile height.
    // A very thin whole image must be fully visible, with no rounding gap.
    const geometryEpsilon=1e-6;
    if(!(end>start) || (rect.height<=1 && (start>geometryEpsilon || end<rect.height-geometryEpsilon)))
      throw Error('Image cannot be fully captured at this viewport size; '+
      JSON.stringify({tile,offset:nextCss,rect,viewport:[r.viewportWidth,r.viewportHeight],
        bounds:bounds||null,scroll:r.scrollDiagnostics||null}));
    // chrome.tabs.captureVisibleTab enforces 2 screenshots/sec. The CDP
    // selected-tab fallback does not need this additional artificial delay.
    const wait=screenshotBackend==='chrome-tabs'
      ? Math.max(0,SCREENSHOT_GAP_MS-(Date.now()-lastScreenshotAt)) : 0;
    if(wait) await sleep(wait);
    const dataURL=await checkedIO(selectedTabScreenshot(
      await checkedIO(tabsGet(state.tabId), 'screenshot tab lookup')), 'capture selected-tab pixels');
    lastScreenshotAt=Date.now();
    if(scopedTabUrl && (await checkedIO(tabsGet(state.tabId),'verify captured reader document')).url!==scopedTabUrl)
      throw Error('Managed reader changed while capturing pixels');
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
      // CSS pixels and bitmap pixels differ with zoom/device scale. For
      // extremely thin tiles, require at least one real screenshot pixel
      // and enough samples for the native rows/columns being written.
      // Never turn a clipped or collapsed larger image into a fake strip.
      const sampleHeight=(end-start)*scaleY, sampleWidth=(right-left)*scaleX;
      if((end-start<=1 && (sampleHeight<1-geometryEpsilon || sampleHeight<destHeight-geometryEpsilon)) ||
         (rect.width<=1 && (left>rect.left+geometryEpsilon || right<rect.left+rect.width-geometryEpsilon ||
           sampleWidth<1-geometryEpsilon || sampleWidth<destWidth-geometryEpsilon)))
        throw Error('Thin image has insufficient visible bitmap pixels; use normal browser zoom or restore its native layout');
      ctx.drawImage(bmp,left*scaleX,(rect.top+start)*scaleY,
        (right-left)*scaleX,(end-start)*scaleY,
        destX,destY,destWidth,destHeight);
    } finally {bmp.close?.();}
    if(end>=rect.height-0.5) {
      const blob=await checkedIO(canvas.convertToBlob({type:'image/png'}), 'encode image PNG');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      if(!bytes.length || bytes.length>MAX_IMAGE_BYTES) throw Error('Rendered PNG exceeds per-image limit');
      const base64=bytesToBase64(bytes);
      if(!scopedTabUrl) {
        visualImages.set(key,base64);
        if(visualImages.size>3) visualImages.delete(visualImages.keys().next().value);
      }
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
  const tab=await checkedIO(tabsGet(state.tabId),'inspect managed tab',5000);
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
          canonicalPage(response.url)===canonicalPage(tab.url)) return {...response,
            tab_id:tab.id, tab_title:String(tab.title||'').slice(0,200)};
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
// Never create or close a Chrome tab to recover a stalled SCROLL. That
// behavior used to open a duplicate chapter and could provoke native repost
// dialogs, while discarding browser-rendered image bytes. The scroll may
// already have executed, so do NOT send it again. Probe only the original
// extension-owned document; Python can restart its scanner from checkpoints.
// Keep the historical function/transport marker for existing release gates.
async function recycleManagedChapterTab() {
  if (!state) throw Error('No paired tab to resynchronize');
  const tabId=state.tabId;
  const original=await checkedIO(tabsGet(tabId),'inspect managed tab before resynchronizing',5000);
  if (!original || !sourceMatches(original.url))
    throw Error('Untrusted tab cannot be resynchronized');
  const saved=await checkedIO(storageGet(['comicBridgeManagedTabId','comicBridgeManagedSite']),
    'verify managed tab ownership',5000);
  const hostname=new URL(original.url).hostname;
  if (saved.comicBridgeManagedTabId!==tabId || saved.comicBridgeManagedSite!==hostname)
    throw Error('Refusing to resynchronize a tab not owned by Comic Bridge');

  const failures=[];
  let ping;
  // The SCROLL listener may have become unresponsive while the isolated-world
  // one-shot command still works. PING is read-only; no reload/navigation.
  if (chrome.scripting?.executeScript) {
    try {
      ping=await checkedIO(directTabCommand(tabId,{type:'PING'}),
        'read existing document via one-shot PING',10000);
    } catch(error) {failures.push('one-shot PING: '+String(error));}
  }
  const validPing = reply => reply?.ok===true && reply.bridgeContentProtocol===6 &&
    canonicalPage(reply.url)===canonicalPage(original.url) && sourceMatches(reply.url);
  if (!validPing(ping)) {
    if (ping) failures.push('one-shot PING did not identify the same chapter document');
    try {
      ping=await checkedIO(sendRaw(tabId,{type:'PING'}),
        'read existing content listener PING',4500);
    } catch(error) {failures.push('listener PING: '+String(error));}
  }
  if (!validPing(ping))
    throw Error('Same-tab scroll transport could not be verified; no new tab, '
      +'reload, or second SCROLL attempted. '+failures.join('; ').slice(0,250));
  const current=await checkedIO(tabsGet(tabId),'verify existing tab after PING',5000);
  if (!current || state.tabId!==tabId || !sourceMatches(current.url) ||
      canonicalPage(current.url)!==canonicalPage(original.url) || current.status==='loading')
    throw Error('Managed tab navigated while recovering; refusing unverified scroll restart');
  console.info('COMIC_BRIDGE_SAME_TAB_RESYNCHRONIZED: tab_id='+tabId);
  return {transport_reset:true,tab_id:tabId,url:current.url,
    reason:'existing managed chapter document responded; restart scanner from checkpoint'};
}

// Optional local adapter-script acquisition. No dynamic eval, no screenshot RPC.
// PERMANENT MODE CONTRACT: do not delete. Only the adapter defines a
// website-specific chapter download plan. The reusable layer executes the
// trusted installed script, validates its ordered URL/filename commands and
// handles native browser receipts. See reusable/chapter_script.py.
let nativeChapterPlan=null;
function nativeAllowedImage(raw) {
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:' || u.username || u.password || u.port) return false;
    return (chrome.runtime.getManifest().host_permissions||[]).some(p=>p==='https://'+u.hostname+'/*');
  } catch {return false;}
}
// Permanent CORS warning: successful <img> rendering or HTTP 200 does NOT
// imply that page-context fetch() can read a cross-origin response. Do not
// disable browser security, use opaque no-cors responses as bytes, or treat
// an interrupted/HTML download as an image. See the adapter contract.
function scriptCapabilities() {
  // Feature detection is read-only and has no chapter document dependency.
  // The tab may be between documents after /hello; no script is injected here.
  const scripting=!!chrome.scripting?.executeScript;
  return {revision:'native-chapter-download-v2',
    native:scripting && !!chrome.downloads?.download && !!chrome.downloads?.search,
    loadedResource:scripting && !!chrome.debugger?.attach && !!chrome.debugger?.sendCommand};
}
async function nativeChapterCommand(action,payload,tab) {
  const tabId=state.tabId;
  const expected=canonicalPage(payload.url);
  const capabilities=scriptCapabilities();
  if(action.startsWith('script_resource_') ? !capabilities.loadedResource :
     action.startsWith('script_download_') ? !capabilities.native : !chrome.scripting?.executeScript)
    throw Error('SCRIPT_DOWNLOAD: requested transport unavailable; reload current Chrome/Edge extension');
  const documentError=(phase,t)=>Error('SCRIPT_DOWNLOAD: chapter document changed ('+phase+
    '; expected='+expected+'; actual='+canonicalPage(t?.url)+'; status='+String(t?.status||'unknown')+
    '; pending='+canonicalPage(t?.pendingUrl)+')');
  const isReady=t=>!!t && state?.tabId===tabId && canonicalPage(t.url)===expected &&
    (!t.pendingUrl || canonicalPage(t.pendingUrl)===expected) && t.status!=='loading';
  if(!expected || !sourceMatches(expected)) throw documentError('invalid requested chapter',tab);
  // Only wait for a navigation to the exact expected chapter. This is a
  // bounded read-only readiness check: no extra navigation, reload or action.
  const waitingForExpected=t=>!!t && state?.tabId===tabId &&
    (t.pendingUrl ? canonicalPage(t.pendingUrl)===expected :
      canonicalPage(t.url)===expected && t.status==='loading');
  const deadline=Date.now()+12000;
  while(!isReady(tab) && waitingForExpected(tab) && Date.now()<deadline) {
    await sleep(250);
    tab=await checkedIO(tabsGet(tabId),'wait for requested chapter document',5000);
  }
  if(!isReady(tab)) {
    if(waitingForExpected(tab)) throw Error('Selected-tab browser API stalled: requested chapter still loading before '+action);
    throw documentError('before '+action,tab);
  }
  const target={tabId};
  const verify=async()=>{
    const after=await checkedIO(tabsGet(tabId),'native download document',5000);
    if(!isReady(after)) throw documentError('after '+action,after);
  };
  if(action==='script_resource_prepare') {
    await checkedIO(attachSelectedTab(),'attach normal reader response observer',10000);
    if(!inspectedReady || inspectedTabId!==tabId) throw Error('SCRIPT_RESOURCE: selected-tab response inspection unavailable');
    await verify(); return {ready:true};
  }
  if(action==='script_scroll') {
    const result=await checkedIO(chrome.scripting.executeScript({target,func:(reset,selectors,wanted)=>{
      if(location.href!==wanted) throw Error('SCRIPT_DOWNLOAD: wrong scroll document');
      const root=selectors.map(s=>document.querySelector(s)).find(Boolean);
      if(!root) throw Error('SCRIPT_DOWNLOAD: reader absent');
      const imgs=[...root.querySelectorAll('img')].filter(im=>!im.closest('noscript,script'));
      const el=document.scrollingElement||document.documentElement;
      const height=el.scrollHeight, y=el.scrollTop, bottom=Math.max(0,height-innerHeight);
      const atBottom=y>=bottom-2;
      // Synchronous absolute movement. No page timers or paint awaits.
      window.scrollTo({top:reset?0:Math.min(bottom,y+Math.max(1,Math.floor(innerHeight*.8))),behavior:'instant'});
      return {url:location.href,height,count:imgs.length,loaded:imgs.filter(x=>x.complete&&x.naturalWidth>0&&x.naturalHeight>0).length,atBottom:!reset&&atBottom};
    },args:[!!payload.reset,payload.reader_selectors||[],tab.url]}),'native chapter scroll',10000);
    await verify(); return result?.[0]?.result;
  }
  if(action==='script_plan') {
    // The local file is generated exclusively from the trusted installed Python adapter.
    await checkedIO(chrome.scripting.executeScript({target,files:['chapter_download_adapter.js']}),'native chapter script',10000);
    const result=await checkedIO(chrome.scripting.executeScript({target,func:()=>globalThis.__comicArchiverNativePlan}),'native chapter script result',10000);
    const envelope=result?.[0]?.result;
    if(!envelope || envelope.digest!==payload.digest) throw Error('SCRIPT_DOWNLOAD: stale adapter script; reload Comic Bridge');
    const plan=envelope.plan;
    await verify();
    if(!plan || canonicalPage(plan.url)!==expected || !Array.isArray(plan.items) || !plan.items.length || plan.items.length>2000)
      throw Error('SCRIPT_DOWNLOAD: invalid native catalog');
    for(const [i,x] of plan.items.entries()) {
      if(x.key!==String(i+1) || x.order!==i+1 || !new RegExp('^'+String(i+1).padStart(4,'0')+'\\.(jpg|jpeg|png|webp|avif|gif|bmp)$').test(x.filename) || !nativeAllowedImage(x.url))
        throw Error('SCRIPT_DOWNLOAD: invalid adapter download command');
    }
    nativeChapterPlan={tabId,url:expected,items:plan.items};
    return plan;
  }
  if(!nativeChapterPlan || nativeChapterPlan.tabId!==tabId || nativeChapterPlan.url!==expected || !/^[a-f0-9]{32}$/.test(payload.token||'') || !Array.isArray(payload.items) || !payload.items.length || payload.items.length>6)
    throw Error('SCRIPT_DOWNLOAD: missing verified chapter plan');
  for(const x of payload.items) {
    const match=nativeChapterPlan.items[Number(x.order)-1];
    if(!match || ['key','order','url','filename'].some(k=>match[k]!==x[k])) throw Error('SCRIPT_DOWNLOAD: command differs from adapter plan');
  }
  if(action==='script_resource_position' || action==='script_resource_read') {
    if(payload.items.length!==1) throw Error('SCRIPT_RESOURCE: one ordered resource per response');
    if(!inspectedReady || inspectedTabId!==tabId) throw Error('SCRIPT_RESOURCE: selected-tab response observer detached');
    const item=payload.items[0];
    const found=await checkedIO(chrome.scripting.executeScript({target,func:(url,wanted,position,attrs,selectors)=>{
      if(location.href!==wanted) throw Error('SCRIPT_RESOURCE: wrong document');
      const exact=raw=>{try{const u=new URL(raw,location.href);u.hash='';return u.href===url;}catch{return false;}};
      const roots=selectors.map(s=>document.querySelector(s)).filter(Boolean);
      const matches=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('img')]))].filter(im=>!im.closest('noscript,script') &&
        [im.currentSrc,im.getAttribute('src'),...attrs.map(a=>im.getAttribute(a))].some(x=>x&&exact(x)));
      if(!matches.length) return {found:false,loaded:false};
      const im=matches.find(x=>x.complete&&x.naturalWidth>0&&x.naturalHeight>0&&exact(x.currentSrc||x.src))||matches[0];
      if(position) im.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      return {found:true,loaded:im.complete&&im.naturalWidth>0&&im.naturalHeight>0&&exact(im.currentSrc||im.src),width:im.naturalWidth,height:im.naturalHeight};
    },args:[normalizeResourceUrl(item.url),tab.url,action==='script_resource_position',payload.image_attributes||[],payload.reader_selectors||[]]}),'read exact reader resource state',10000);
    const dom=found?.[0]?.result;
    await verify();
    if(!dom?.found) throw Error('SCRIPT_RESOURCE: exact image URL absent from current reader');
    if(action==='script_resource_position') return {positioned:true,loaded:dom.loaded};
    const key=normalizeResourceUrl(item.url);
    const http=imageNetworkStatus.get(key)||imageWebRequestStatus.get(key);
    if(http?.status>=400) return {key:item.key,url:item.url,state:'denied',status:http.status};
    let body=capturedImages.get(key)?.base64;
    // Only read already-delivered bytes. Never re-request a failed CDN URL,
    // change referrer/cookies, bypass CORS, or alter source access decisions.
    if(!body && dom.loaded) {
      try {
        const tree=await checkedIO(cdp('Page.getResourceTree'),'inspect loaded resource tree',10000);
        const r=findFrameResource(tree.frameTree,key);
        if(r) {
          const bytes=await checkedIO(cdp('Page.getResourceContent',r),'read already loaded image',10000);
          if(bytes?.base64Encoded && storeOriginalImage(key,bytes.content)) body=bytes.content;
        }
      } catch(e) {if(/Selected-tab browser API stalled/.test(String(e))) throw e;}
      if(!body) {
        await checkedIO(recoverExistingPageSnapshot(),'read loaded page snapshot',15000);
        body=capturedImages.get(key)?.base64;
      }
    }
    await verify();
    if(!body) return {key:item.key,url:item.url,state:dom.loaded?'unavailable':'pending'};
    return {key:item.key,url:item.url,state:'complete',base64:body,via:'managed-reader-original-response',width:dom.loaded?dom.width:0,height:dom.loaded?dom.height:0};
  }
  const receipt=async item=>{
    const relative='ComicArchiver-script/'+payload.token+'/'+item.filename;
    const ledgerKey='nativeDownload:'+payload.token+':'+item.key;
    const ledger=(await checkedIO(call(chrome.storage.local,'get',ledgerKey),'native download ledger',5000))[ledgerKey];
    if(ledger && (ledger.url!==item.url || ledger.relative!==relative)) throw Error('SCRIPT_DOWNLOAD: conflicting download ledger');
    const query=ledger?.id!==undefined?{id:ledger.id}:{url:item.url};
    const entries=await checkedIO(call(chrome.downloads,'search',query),'native download status',5000);
    const suffix='/'+relative;
    const norm=d=>String(d.filename||'').replace(/\\/g,'/');
    const scoped=d=>norm(d).includes('/ComicArchiver-script/'+payload.token+'/') && norm(d).split('/').slice(-3,-1).join('/')==='ComicArchiver-script/'+payload.token;
    const owned=entries.filter(d=>d.url===item.url && (d.byExtensionId===chrome.runtime.id || (ledger?.id===d.id && !d.byExtensionId)));
    // Chrome can report temporary paths while a transfer is active and can
    // choose another final extension/name. The persisted ID, not a filename,
    // binds the receipt to the exact adapter URL and ordinal. Never recover a
    // renamed external file by URL alone when the start acknowledgement is lost.
    const candidates=owned.filter(d=>ledger?.id!==undefined ? d.id===ledger.id : norm(d).endsWith(suffix));
    if(candidates.length>1) throw Error('SCRIPT_DOWNLOAD: duplicate browser download receipts');
    const d=candidates[0];
    if(!d) return {key:item.key,url:item.url,filename:item.filename,state:'pending',ledger,relative,ledgerKey};
    if(d.finalUrl && (!nativeAllowedImage(d.finalUrl) || canonicalPage(d.finalUrl)!==canonicalPage(item.url))) throw Error('SCRIPT_DOWNLOAD: native download redirected away from the exact planned image URL');
    const idBound=Number.isInteger(d.id) && (ledger?.id===d.id || norm(d).endsWith(suffix));
    const extensionOwned=d.byExtensionId===chrome.runtime.id;
    const managed=scoped(d);
    if(d.state==='complete' && (!d.exists || !d.filename || !idBound || (!managed && !extensionOwned)))
      throw Error('SCRIPT_DOWNLOAD: completed native file missing or receipt ownership uncertain');
    return {key:item.key,url:item.url,filename:item.filename,state:d.state,path:d.filename||'',error:d.error||'',id:d.id,idBound,extensionOwned,managed,fileSize:d.fileSize??-1,canResume:!!d.canResume,ledger,relative,ledgerKey};
  };
  if(action==='script_download_status') {
    const receipts=[];
    for(const item of payload.items) {
      const r=await receipt(item);
      receipts.push({key:r.key,url:r.url,filename:r.filename,state:r.state,path:r.path,error:r.error,id:r.id,idBound:r.idBound,extensionOwned:r.extensionOwned,managed:r.managed,fileSize:r.fileSize});
    }
    await verify(); return {receipts};
  }
  if(action==='script_download_start') {
    const interval=Math.max(1000,Math.min(25000,Number(payload.interval_ms)||1500));
    for(const item of payload.items) {
      await verify();
      const r=await receipt(item);
      if(r.state==='interrupted') {
        if(r.canResume && ['NETWORK_FAILED','NETWORK_TIMEOUT','NETWORK_DISCONNECTED'].includes(r.error) && (r.ledger?.resumes||0)<2) {
          await checkedIO(call(chrome.storage.local,'set',{[r.ledgerKey]:{url:item.url,relative:r.relative,id:r.id,resumes:(r.ledger?.resumes||0)+1}}),'native download retry receipt',5000);
          await checkedIO(call(chrome.downloads,'resume',r.id),'native download resume',5000);
          await sleep(interval);
        }
        continue;
      }
      if(r.state!=='pending') continue;
      // If start ACK was lost, never issue a second download. Native history may
      // populate after a delay; status polling can recover the exact path.
      if(r.ledger) continue;
      const intent={url:item.url,relative:r.relative};
      await checkedIO(call(chrome.storage.local,'set',{[r.ledgerKey]:intent}),'native download intent',5000);
      const id=await checkedIO(call(chrome.downloads,'download',{url:item.url,filename:r.relative,saveAs:false,conflictAction:'uniquify'}),'native download start',10000);
      await checkedIO(call(chrome.storage.local,'set',{[r.ledgerKey]:{...intent,id}}),'native download receipt',5000);
      await sleep(interval);
    }
    return {started:true};
  }
  throw Error('SCRIPT_DOWNLOAD: unsupported command');
}

async function execute(job) {
  const {action,payload={}}=job;
  // Pairing already established the managed tab. Query features without
  // asking Chrome for a stable document or touching the source website.
  if (action==='script_capabilities') return scriptCapabilities();
  if (action==='release_managed_reader') {
    // Do not re-pair the SAME closing Python session between the release ACK
    // and listener shutdown, even if Chrome restarts the service worker.
    if(state?.managedNonce) await checkedIO(storageSet({comicBridgeRetiredStartupNonce:state.managedNonce}),'retire closing session',3000);
    return releaseOwnedReader(state, true);
  }
  const initialTab=await tabInfo();
  if (action.startsWith('script_')) return nativeChapterCommand(action,payload,initialTab);
  // The browser may detach on navigation or when DevTools takes ownership.
  // Stop BEFORE another scroll if loaded-response inspection was lost.
  // The visual path is independent of debugger state.  Never stall a chapter
  // trying to reattach a debugger that Chrome already rejected.
  // Provider-neutral metadata UI operation. Selectors come from the local adapter.
  // Exactly one visible, enabled button, on the already managed document.
  // One shot only: a lost acknowledgement is never a reason to click again.
  if (action === 'catalog_button') {
    const tabId=state.tabId;
    const before=await checkedIO(tabsGet(tabId),'catalog document',5000);
    if (!sourceMatches(before.url) || before.status==='loading' ||
        canonicalPage(before.url)!==canonicalPage(payload.url)) throw Error('Catalog document changed');
    const selector=payload.selector, text=payload.text;
    if (typeof selector!=='string' || !selector.length || selector.length>240 ||
        (text!==null && text!==undefined && (typeof text!=='string' || text.length>100)))
      throw Error('Invalid catalog control selector');
    if (!chrome.scripting?.executeScript) throw Error('Catalog button requires Chrome/Edge');
    const result=await checkedIO(chrome.scripting.executeScript({target:{tabId},
      func:(selector,text,expected)=>{
        if(location.href!==expected) throw Error('Catalog document changed');
        const visible=el=>el instanceof HTMLButtonElement && el.type==='button' &&
          !el.disabled && el.getAttribute('aria-disabled')!=='true' &&
          el.getClientRects().length>0 && getComputedStyle(el).visibility==='visible';
        const buttons=[...document.querySelectorAll(selector)].filter(el=>visible(el) &&
          (text==null || el.textContent.trim()===text));
        if(buttons.length!==1) throw Error('Expected exactly one enabled catalog button; found '+buttons.length);
        buttons[0].click(); return {clicked:true,url:location.href};
      },args:[selector,text,before.url]}),'catalog button click',10000);
    const receipt=result?.[0]?.result;
    const after=await checkedIO(tabsGet(tabId),'catalog document after click',5000);
    if(!receipt?.clicked || state.tabId!==tabId || canonicalPage(after.url)!==canonicalPage(before.url))
      throw Error('Catalog button outcome unverified');
    return receipt;
  }
  if (action === 'navigate') {
    const desired=new URL(payload.url);
    const current=new URL((await tabsGet(state.tabId)).url);
    if (!sourceMatches(desired.href) || desired.host !== current.host)
      throw Error('Cross-site navigation refused');
    await cleanupArchiverTabs(state.tabId,current.href);
    clearImageMemory();
    nativeChapterPlan=null;
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
    await cleanupArchiverTabs(state.tabId,current.href);
    return {url:result.url,status:200,tab_id:result.tab_id,tab_title:result.tab_title};
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
        }catch(e){
          // ADDITIVE CLEAN PIXEL RECOVERY: the displayed HTMLImageElement can
          // retain decoded pixels even after its blob URL is revoked. Unlike a
          // viewport screenshot, drawImage(image) contains no overlay, toolbar,
          // fixed header or other document UI. Same-origin canvas is required.
          try {
            const image=matches[0], w=image.naturalWidth, h=image.naturalHeight;
            if(!w || !h || w*h>36000000)
              throw Error('Decoded source image has invalid pixel dimensions');
            const canvas=document.createElement('canvas');
            canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d',{alpha:false});
            if(!ctx) throw Error('Decoded image canvas unavailable');
            ctx.drawImage(image,0,0,w,h);
            const blob=await new Promise((resolve,reject)=>{
              try {canvas.toBlob(b=>b?resolve(b):reject(Error('Decoded image PNG encoder returned no blob')),'image/png');}
              catch(error){reject(error);}
            });
            if(!blob || !blob.size || blob.size>20*1024*1024)
              throw Error('Decoded image PNG exceeds transfer bounds');
            const bytes=new Uint8Array(await blob.arrayBuffer());
            const chunks=[];
            for(let i=0;i<bytes.length;i+=16384)
              chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
            return {status:200,base64:btoa(chunks.join('')),
              via:'decoded-source-img-pixels',
              headers:{'content-type':'image/png'},
              width:w,height:h};
          }catch(pixelError){
            return {status:424,reason:'Source document cannot read its decoded blob: '+String(e).slice(0,120)+
              '; clean decoded-image canvas failed: '+String(pixelError).slice(0,180)};
          }
        }
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
      // A source adapter may require strict panel pixels. Other providers retain
      // the original screenshot fallback unchanged. Never certify page UI as art.
      if (payload?.require_clean_pixels === true) {
        return {url:wanted,status:424,base64:'',reason:value.reason||'Clean panel pixels unavailable',
          via:value.via||'decoded-source-tab-blob',headers:value.headers||{},
          diagnostics:{pixelFallbackError:'viewport screenshot disallowed by strict adapter'},
          bridge_revision:'decoded-blob-fallback-diagnostics-v1'};
      }
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
    const first=await checkedIO(send(state.tabId,{type:'FIRST_LOADED_IMAGE',payload:{origins:browserImageOrigins(),reader_selectors:Array.isArray(payload?.reader_selectors)?payload.reader_selectors:[],rendered_reader_selector:payload?.rendered_reader_selector}}), 'probe visible images');
    if(!first?.url) throw Error('No decoded CDN image on the selected page; scroll to the first chapter image and retry pairing');
    if(payload?.rendered_reader_selector) {
      if(first.rendered_reader_revision!=='scoped-rendered-reader-v1') throw Error('Outdated scoped reader extension; reload');
      const result=await captureVisibleImage(first.url,payload.rendered_reader_selector);
      return {url:first.url,status:200,base64:result.base64,via:result.via,rendered_reader_revision:'scoped-rendered-reader-v1'};
    }
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
    if (!imagePermission(u.href)) {
      if(!payload?.rendered_reader_selector) throw Error('Image host has no declared permission; update the site adapter');
      // No CDN fetch, CDP response lookup, optional permission grant or cache lookup.
      const rendered=await captureVisibleImage(u.href,payload.rendered_reader_selector);
      return {url:u.href,status:200,headers:{'content-type':'image/png'},base64:rendered.base64,
        via:rendered.via,rendered_reader_revision:'scoped-rendered-reader-v1'};
    }
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
    if(!imagePermission(key)) {
      if(!payload?.rendered_reader_selector || !key.startsWith('https://'))
        throw Error('Image diagnostics must be limited to adapter-permitted URLs');
      const dom=await checkedIO(send(state.tabId,{type:'IMAGE_STATUS',payload:{url:key,rendered_reader_selector:payload.rendered_reader_selector}}),'scoped reader image status');
      return {url:key,network:null,capturedOriginal:false,dom,debuggerReady:!!inspectedReady};
    }
    let dom=null;
    try {dom=await checkedIO(send(state.tabId,{type:'IMAGE_STATUS',payload:{url:key}}),
      'read-only source image status',3500);} catch {}
    return {url:key,network:imageNetworkStatus.get(key)||imageWebRequestStatus.get(key)||null,
      capturedOriginal:capturedImages.has(key),dom,debuggerReady:!!inspectedReady};
  }
  if (action === 'scroll') {
    // A fresh command ID makes the requested relative *step* idempotent. The
    // document records its absolute target before scrolling. An ACK timeout
    // is not proof the page stopped moving: query this same ID read-only.
    const tabId=state.tabId;
    const before=await checkedIO(tabsGet(tabId),'inspect scroll owner',5000);
    if (!before || !sourceMatches(before.url) || before.status==='loading')
      throw Error('SCROLL_NOT_READY: current chapter tab is not ready');
    const commandId=Date.now().toString(36)+'-'+(++scrollCommandSequence).toString(36);
    const request={type:'SCROLL',payload:{command_id:commandId}};
    // Firefox MV2 has no scripting.executeScript: preserve its installed
    // content-message transport, using the SAME ID/receipt contract.
    const dispatchScroll = command => chrome.scripting?.executeScript ?
      directTabCommand(tabId,command) : sendRaw(tabId,command);
    const valid = value => value?.command_id===commandId && value.status==='applied' &&
      typeof value.move==='number' && Number.isFinite(value.move) &&
      canonicalPage(value.url)===canonicalPage(before.url);
    try {
      const response=await checkedIO(dispatchScroll(request),
        'scroll page command',BROWSER_IO_STALL_MS);
      if (!valid(response)) throw Error('SCROLL_UNVERIFIED: page returned no matching applied command receipt');
      return response.move;
    } catch(error) {
      if (!String(error).includes('Selected-tab browser API stalled: scroll page command'))
        throw error;
      // The first operation may still be executing. Never resend it or start
      // a replacement tab. Inspect the original document's operation ledger.
      for (let attempt=0;attempt<3;attempt++) {
        let receipt;
        try {
          receipt=await checkedIO(dispatchScroll({type:'SCROLL_STATUS',
            payload:{command_id:commandId}}),'read scroll command receipt',7000);
        } catch(statusError) {
          console.warn('COMIC_BRIDGE_SCROLL_ACK_PENDING',String(statusError).slice(0,170));
        }
        if (valid(receipt)) {
          const after=await checkedIO(tabsGet(tabId),'verify scroll document',5000);
          if (state.tabId!==tabId || canonicalPage(after.url)!==canonicalPage(before.url) ||
              after.status==='loading') throw Error('SCROLL_DOCUMENT_CHANGED: refusing stale receipt');
          console.info('COMIC_BRIDGE_SCROLL_ACK_RECOVERED command_id='+commandId);
          return receipt.move;
        }
        if (receipt && receipt.status!=='unknown' && receipt.status!=='issued')
          throw Error('SCROLL_OUTCOME_UNVERIFIED: unexpected command state');
        if(attempt<2) await sleep(350);
      }
      throw Error('SCROLL_OUTCOME_UNKNOWN: command may have executed; no second scroll, '+
        'tab replacement, or scanner reset is safe. Keep chapter checkpoint intact.');
    }
  }
  const type={page:'PAGE',snapshot:'SNAPSHOT',classify:'CLASSIFY',scroll:'SCROLL',recover_image:'RECOVER_IMAGE'}[action];
  if (!type) throw Error('Unsupported command');
  // Also watch ordinary scroll/snapshot commands. A stalled content-script
  // message must not block the single extension command queue indefinitely.
  let result;
  const commandPayload=action==='recover_image' ? {...payload,
    recovery_id:Date.now().toString(36)+'-'+(++recoveryCommandSequence).toString(36),
    recovery_chapter:canonicalPage(initialTab.url)} : payload;
  const recoveryTabId=state.tabId;
  try {
    // recoverImage waits at most ~7 seconds for a lazy-loaded DOM image. A
    // longer scripting wait means the Chrome API/transport is stalled, not
    // that we should abandon every other image in this chapter.
    result=await checkedIO(send(state.tabId,{type,payload:commandPayload}), action+' page command',
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
    const tab=await checkedIO(tabsGet(state.tabId),'inspect managed tab for image recovery',5000);
    if(!sourceMatches(tab.url) || tab.status==='loading') throw error;
    result=await checkedIO(sendRaw(state.tabId,{type,payload:commandPayload}),
      'recover_image existing-listener fallback', 8500);
  }
  // Old responses have no receipt and retain exactly their existing behavior.
  // A short ACK is not an image success: poll read-only from the extension
  // worker, which is independent of the reader's throttled animation timers.
  if(action==='recover_image' && result?.recovery_id) {
    const expected=commandPayload.recovery_id;
    const requested=String(payload.url||'').trim();
    const chapter=canonicalPage(initialTab.url);
    const valid=r=>r?.recovery_id===expected && r.key===String(payload.key) &&
      r.requested===requested && canonicalPage(r.chapter_url)===chapter &&
      (r.status==='pending' || r.status==='decoded') && r.loaded===(r.status==='decoded') &&
      (!r.loaded || (r.width>0 && r.height>0));
    const deadline=Date.now()+7000;
    if(!valid(result)) throw Error('RECOVERY_RECEIPT_UNVERIFIED: wrong document, ordinal or URL');
    console.info('COMIC_BRIDGE_LAZY_RECOVERY_ACK key='+payload.key);
    while(!result.loaded && Date.now()<deadline) {
      await sleep(250);
      if(state.tabId!==recoveryTabId) throw Error('RECOVERY_DOCUMENT_CHANGED: managed tab changed');
      const command={type:'RECOVER_IMAGE_STATUS',payload:commandPayload};
      const status=chrome.scripting?.executeScript ? directTabCommand(recoveryTabId,command) : sendRaw(recoveryTabId,command);
      // Do not replay mutation after an uncertain status read. Existing
      // reconnect/checkpoint handling owns a genuinely stalled transport.
      result=await checkedIO(status,'read lazy image recovery receipt',3000);
      if(result?.error) throw Error(result.error);
      if(!valid(result)) throw Error('RECOVERY_RECEIPT_UNVERIFIED: wrong document, ordinal or URL');
    }
    if(state.tabId!==recoveryTabId) throw Error('RECOVERY_DOCUMENT_CHANGED: managed tab changed');
    const after=await checkedIO(tabsGet(recoveryTabId),'verify lazy recovery document',5000);
    if(canonicalPage(after.url)!==chapter || after.status==='loading') throw Error('RECOVERY_DOCUMENT_CHANGED: chapter changed');
    console.info('COMIC_BRIDGE_LAZY_RECOVERY_RESULT key='+payload.key+' loaded='+result.loaded);
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
// Only close our uniquely marked launch tabs and blank/duplicate chapter
// popups whose opener is the managed reader. Never close manual reader tabs.
function isArchiverWakeTab(t) {
  return !!t && !t.pinned && /^about:blank#comicarchiver-[a-f0-9]{32}$/.test(t.url||'') &&
    (!t.pendingUrl || t.pendingUrl===t.url);
}
async function cleanupArchiverTabs(managedId, previousUrl='', includeWakeTabs=true, wakeNonce='', verify=false) {
  if (!chrome.tabs?.query || !chrome.tabs?.remove) {
    if(verify) throw Error('Owned tab cleanup API unavailable');
    return 0;
  }
  const all=await checkedIO(call(chrome.tabs,'query',{}),'list owned auxiliary tabs',5000);
  const tagged=t=>isArchiverWakeTab(t) && (includeWakeTabs ||
    (!!wakeNonce && t.url==='about:blank#comicarchiver-'+wakeNonce));
  const children=new Set([managedId]);
  for(let i=0;i<all.length;i++) for(const t of all) if(children.has(t.openerTabId)) children.add(t.id);
  const removable=t=>t.id!==managedId && !t.pinned && (tagged(t) || (children.has(t.id) &&
    (!t.pendingUrl || t.pendingUrl===t.url) && (t.url==='about:blank' || (previousUrl && canonicalPage(t.url)===canonicalPage(previousUrl)))));
  let closed=0;
  for(const tab of all.filter(removable)) {
    try {
      const now=await tabsGet(tab.id);
      if(!removable(now) || now.url!==tab.url || now.openerTabId!==tab.openerTabId) continue;
      await checkedIO(call(chrome.tabs,'remove',tab.id),'close owned auxiliary tab',5000); closed++;
    } catch(e) { console.warn('COMIC_BRIDGE_OWNED_TAB_CLEANUP:',String(e)); }
  }
  if(closed) console.info('COMIC_BRIDGE_OWNED_TABS_CLOSED count='+closed);
  if(verify) {
    const remaining=await checkedIO(call(chrome.tabs,'query',{}),'verify owned auxiliary tabs closed',5000);
    if(remaining.some(removable)) throw Error('Owned auxiliary tabs still open');
  }
  return closed;
}
// Release only a tab whose saved automatic-session ownership still matches.
// A disconnect may race the next Python launch: do not close its new wake tab.
async function releaseOwnedReader(session, includeWakeTabs=false) {
  if (!session?.managedSite || !Number.isInteger(session.tabId)) return {closed:false,reason:'not automatic'};
  const id=session.tabId;
  const keys=['comicBridgeManagedTabId','comicBridgeManagedSite','comicBridgeManagedNonce'];
  const owns=s=>s.comicBridgeManagedTabId===id && s.comicBridgeManagedSite===session.managedSite &&
    (s.comicBridgeManagedNonce||'')===(session.managedNonce||'');
  const safe=t=>{try{return !!t && !t.pinned && sourceMatches(t.url) &&
    new URL(t.url).hostname===session.managedSite && (!t.pendingUrl ||
      (sourceMatches(t.pendingUrl) && new URL(t.pendingUrl).hostname===session.managedSite));}catch{return false;}};
  if(!owns(await checkedIO(storageGet(keys),'verify reader ownership',3000))) return {closed:false,reason:'ownership changed'};
  let tab;
  try {tab=await checkedIO(tabsGet(id),'inspect reader before release',3000);} catch(e) {return {closed:false,reason:String(e)};}
  if(!safe(tab) && !isArchiverWakeTab(tab)) return {closed:false,reason:'reader no longer owned'};
  // Close children before their opener, which Chrome may otherwise forget.
  const auxiliaryClosed=await cleanupArchiverTabs(id,tab.url,includeWakeTabs,session.managedNonce,true);
  if(inspectedTabId===id) {
    try {if(chrome.debugger?.detach) await checkedIO(call(chrome.debugger,'detach',{tabId:id}),'release reader debugger',3000);} catch(e) {console.warn('COMIC_BRIDGE_DEBUGGER_RELEASE:',String(e));}
    inspectedTabId=null;inspectedReady=false;clearImageMemory();nativeChapterPlan=null;
  }
  if(!owns(await checkedIO(storageGet(keys),'recheck reader ownership',3000))) return {closed:false,reason:'ownership changed'};
  const now=await checkedIO(tabsGet(id),'recheck reader tab',3000);
  if((!safe(now) && !isArchiverWakeTab(now)) || now.url!==tab.url) return {closed:false,reason:'reader navigated'};
  await checkedIO(call(chrome.tabs,'remove',id),'release owned reader',5000);
  const remaining=await checkedIO(call(chrome.tabs,'query',{}),'verify reader tab closed',5000);
  if(remaining.some(t=>t.id===id)) throw Error('Owned reader tab still open');
  await storageSet({comicBridgeManagedTabId:null,comicBridgeManagedSite:null,comicBridgeManagedNonce:null});
  console.info('COMIC_BRIDGE_READER_RELEASED tab_id='+id);
  return {closed:true,tab_id:id,auxiliary_closed:auxiliaryClosed};
}
async function pickComicTab(site, startupUrl='', nonce='') {
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
    const saved=await storageGet(['comicBridgeManagedTabId','comicBridgeManagedSite','comicBridgeManagedNonce']).catch(()=>({}));
    const managed=candidates.find(tab => tab.id===saved.comicBridgeManagedTabId &&
      saved.comicBridgeManagedSite===site && !tab.pinned);
    // Consume the launcher-created tab instead of opening a second tab/window.
    // Never use an ordinary about:blank or a manually opened reader.
    const wake=(tabs||[]).filter(t=>isArchiverWakeTab(t) &&
      (!nonce || t.url==='about:blank#comicarchiver-'+nonce)).sort((a,b)=>Number(!!b.active)-Number(!!a.active))[0];
    const previousSession=!!nonce && nonce!==saved.comicBridgeManagedNonce;
    if(managed && !previousSession && !wake) {
      if(canonicalPage(managed.url)!==canonicalPage(requested)) {
        await cleanupArchiverTabs(managed.id,managed.url);
        return tabsUpdate(managed.id,{url:requested,active:true});
      }
      return managed;
    }
    // Create the destination BEFORE closing the former tab so that we never
    // close the only Chrome window and lose the extension during a restart.
    const owned=wake ? await tabsUpdate(wake.id,{url:requested,active:true}) :
      await call(chrome.tabs,'create',{url:requested,active:true});
    if(managed && managed.id!==owned.id) {
      try {await releaseOwnedReader({tabId:managed.id,managedSite:site,managedNonce:saved.comicBridgeManagedNonce||''},false);}
      catch(e) {console.warn('COMIC_BRIDGE_STALE_READER_RELEASE:',String(e));}
    }
    await storageSet({comicBridgeManagedTabId:owned.id,comicBridgeManagedSite:site,comicBridgeManagedNonce:nonce});
    if(wake) console.info('COMIC_BRIDGE_WAKE_TAB_REUSED tab_id='+owned.id);
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
    // Run-scoped reload once BEFORE tab matching and pairing. This reloads
    // unpacked script changes and provider-specific manifest permissions, even
    // when Chrome kept an old MV3 worker alive after files were edited. The
    // nonce is not a credential; the actual bridge token is still required.
    // Persist BEFORE reloading, otherwise Chrome could restart in a loop.
    if(config.startup_nonce) {
      if(!/^[a-f0-9]{32}$/i.test(config.startup_nonce))
        throw Error('Invalid local startup refresh nonce');
      const previous=await storageGet(['comicBridgeRefreshedStartupNonce','comicBridgeRetiredStartupNonce']);
      if(previous.comicBridgeRetiredStartupNonce===config.startup_nonce) return;
      if(previous.comicBridgeRefreshedStartupNonce!==config.startup_nonce) {
        if(typeof chrome.runtime.reload!=='function')
          throw Error('This browser does not support updating the unpacked extension automatically');
        await storageSet({comicBridgeRefreshedStartupNonce:config.startup_nonce});
        console.info('COMIC_BRIDGE_STARTUP_REFRESH: reloading installed extension for this run');
        chrome.runtime.reload();
        return;
      }
    }
    const tab=await pickComicTab(config.site,config.startup_url,config.startup_nonce||'');
    if(!tab) { lastError='No authorized comic tab or startup URL available';return;}
    state={tabId:tab.id,port:config.port,token:config.token,
      managedSite:config.startup_url?config.site:null,managedNonce:config.startup_nonce||''};
    try {
      // No debugger requirement: pixel capture is available in normal Chrome.
      // tabs.update may return the OLD document before the resume URL commits.
      // Use the trusted bootstrap URL for document readiness and first /hello;
      // otherwise a previous prologue can incorrectly claim this Python run.
      const expectedResumeUrl=trustedStartupUrl(config.site,config.startup_url);
      await waitContent(20000,expectedResumeUrl || tab.url);
      const readyTab=await tabInfo();
      await cleanupArchiverTabs(readyTab.id,readyTab.url);
      if(expectedResumeUrl && canonicalPage(readyTab.url)!==canonicalPage(expectedResumeUrl))
        throw Error('BROWSER_RESUME_TARGET_NOT_READY: managed tab is not at the requested unfinished chapter');
      await api('/hello',{url:readyTab.url,
        bridge_protocol:'visual-transfer-2',capabilities:['probe','image','content-v2'],
        startup_refresh_revision:1,tab_ownership:'extension-managed',tab_id:state.tabId,
        tab_title:String((await tabInfo()).title||'').slice(0,200)});
      await storageSet({lastPort:port,selectedTabId:tab.id}).catch(()=>{});
      lastError='';
      workLoop();
    } catch(error) {
      try {await releaseOwnedReader(state,false);} catch(e) {console.warn('COMIC_BRIDGE_PAIR_RELEASE:',String(e));}
      state=null;throw error;
    }
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
  if(changeInfo?.url || changeInfo?.status==='complete') {
    autoConnect();
    // A wake tab can arrive AFTER an already-running extension paired. Close
    // only the uniquely tagged auxiliary, even if it appeared in a new window.
    const session=state;
    if(session?.managedSite && polling && !autoConnecting && _tabId!==session.tabId) {
      (async()=>{const tab=await tabsGet(_tabId);
        if(state===session && isArchiverWakeTab(tab) &&
          tab.url==='about:blank#comicarchiver-'+session.managedNonce) await checkedIO(call(chrome.tabs,'remove',_tabId),'close late wake tab',5000);
      })().catch(()=>{});
    }
  }
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
        startup_refresh_revision:1,tab_ownership:'extension-managed',tab_id:state.tabId,
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
      if(command.action==='release_managed_reader') break;
    }
  } catch(e) {
    lastError=String(e);
    if (state) console.warn('Comic Bridge:',lastError);
  } finally {
    // Keep polling locked until old session cleanup finishes. On a hard Python
    // exit there is no cleanup RPC, so the extension owns this fallback.
    try {await releaseOwnedReader(state,false);} catch(e) {console.warn('COMIC_BRIDGE_DISCONNECT_RELEASE:',String(e));}
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
