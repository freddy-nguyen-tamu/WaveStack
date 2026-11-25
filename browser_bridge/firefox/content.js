/* Generic DOM transport: no site selectors, credentials, or source URLs embedded. */
(() => {
  // Versioned guard: a previously installed extension may have injected
  // an older content script into this tab. Upgrade without refreshing it.
  if (window.__comicBridgeContentLoadedVersion === 10 &&
      window.__comicBridgeScrollRevision === 1 &&
      typeof window.__comicBridgeDirect === 'function') return;
  window.__comicBridgeContentLoadedVersion = 10;
  window.__comicBridgeContentLoaded = true;
  // Document-scoped result ledger survives an in-place content script upgrade.
  // Only the current chapter may answer status for a command; navigation loses it.
  window.__comicBridgeScrollRevision = 1;
  const scrollLedger = window.__comicBridgeScrollLedger || Object.create(null);
  window.__comicBridgeScrollLedger = scrollLedger;
  const scrollHistory = window.__comicBridgeScrollOrder || [];
  window.__comicBridgeScrollOrder = scrollHistory;

  const html = () => ({url: location.href, html: '<!doctype html>\n' + document.documentElement.outerHTML});
  const classify = () => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    // A small reCAPTCHA v3 badge at the viewport edge is not a challenge wall.
    // Preserve every existing hard-challenge selector and the login check.
    const passiveRecaptchaBadge = el => !!el.closest('.grecaptcha-badge');
    return {
      login: [...document.querySelectorAll('form input[type=password]')].some(visible),
      challenge: [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], #challenge-running, .cf-challenge, input[name*="captcha" i], .g-recaptcha, [data-sitekey]')].some(el => visible(el) && !passiveRecaptchaBadge(el)),
      title: document.title || ''
    };
  };
  function snapshot(p) {
    const selectors = p.reader_selectors || [];
    const attrs = p.image_attributes || ['data-src','data-original','src'];
    let root = selectors.map(s => { try {return document.querySelector(s);} catch {return null;} })
      .find(n => n && n.querySelector('img,[data-page]'));
    if (!root) root = document.querySelector('main,article') || document.body;
    let state = window.__comicBridgeReaderObserver;
    if (!state || state.root !== root) {
      if (state?.observer) state.observer.disconnect();
      state = {root, revision:0};
      state.observer = new MutationObserver(() => {state.revision++;});
      state.observer.observe(root, {subtree:true, childList:true, attributes:true,
        attributeFilter:['src','srcset','data-src','data-original','data-lazy-src','data-page']});
      window.__comicBridgeReaderObserver = state;
    }
    // For a site-specific reader, the first selector defines its image container.
    const nodes = [...root.querySelectorAll('img')].filter(im => im.closest('script,noscript') === null);
    let missingSlots = 0;
    let unloadedSlots = 0;
    const imgs = nodes.map((im,i) => {
      const rect = im.getBoundingClientRect();
      // Prefer the actual loaded response URL over a lazy-loading placeholder.
      const candidates = im.naturalWidth > 0
        ? [(im.currentSrc || '').trim(), ...attrs.map(a => (im.getAttribute(a) || '').trim())]
        : [...attrs.map(a => (im.getAttribute(a) || '').trim()), (im.currentSrc || '').trim()];
      const url = candidates.find(s => s && !/^(data:|blob:|about:)/i.test(s)) ||
        (im.complete && im.naturalWidth>0 && im.naturalHeight>0
          ? candidates.find(s => s && /^blob:https:\/\//i.test(s)) || '' : '');
      if (!url) missingSlots++;
      if (!im.complete || !im.naturalWidth || !im.naturalHeight) unloadedSlots++;
      const ordinal = im.closest('[data-page]')?.getAttribute('data-page') ||
                      im.getAttribute('data-index') || String(i+1);
      return {key:String(ordinal),url,width:im.naturalWidth || 0,height:im.naturalHeight || 0,
        loaded:!!(im.complete && im.naturalWidth && im.naturalHeight),
        pageY:rect.top+window.scrollY};
    });
    const doc = document.documentElement, body = document.body;
    const height = Math.max(doc.scrollHeight, body?.scrollHeight || 0);
    return {imgs,total:nodes.length,readerCount:nodes.length,missingSlots,unloadedSlots,
      scrollY:window.scrollY || doc.scrollTop || 0,
      bottom:Math.max(0, height-window.innerHeight),viewportHeight:innerHeight,height,revision:state.revision};
  }
  function imageStatus(url) {
    const key = raw => {try {const u=new URL(raw,location.href);u.hash='';return u.href;}catch{return '';}};
    const requested=key(url);
    const imgs=[...document.querySelectorAll('img')].filter(im=>
      [im.currentSrc,im.src,im.getAttribute('data-src'),im.getAttribute('data-original'),
       im.getAttribute('data-lazy-src')].some(candidate=>candidate && key(candidate.trim())===requested));
    // A decoded placeholder is not a decoded requested image. The data-src
    // may match the request while currentSrc still points at a site spinner.
    return {found:imgs.length>0,loaded:imgs.some(im=>im.complete && im.naturalWidth>0 && im.naturalHeight>0 &&
      key(im.currentSrc || im.src)===requested),
      count:imgs.length,visible:imgs.some(im=>{const r=im.getBoundingClientRect();return r.width>0 && r.height>0;}),
      dimensions:imgs.map(im=>[im.naturalWidth||0,im.naturalHeight||0]).slice(0,3)};
  }
  // Revisit one known missing image in the ORIGINAL reader, rather than
  // repeatedly waiting at the bottom and then abandoning the chapter.
  // Generic selectors and attributes are passed from site_specific/site_adapter.py.
  async function recoverImage(p) {
    const selectors=Array.isArray(p.reader_selectors) ? p.reader_selectors : [];
    const root=selectors.map(x=>{try{return document.querySelector(x);}catch{return null;}})
      .find(x=>x && x.querySelector('img,[data-page]')) ||
      document.querySelector('main,article') || document.body;
    const nodes=[...root.querySelectorAll('img')].filter(im=>!im.closest('script,noscript'));
    const key=String(p.key ?? '');
    const attrs=Array.isArray(p.image_attributes) ? p.image_attributes : [];
    const wanted=String(p.url||'').trim();
    const absolute = value => {
      try { const raw=String(value||'').trim();if(!raw)return '';const u=new URL(raw,location.href);u.hash='';return u.href; }
      catch {return '';}
    };
    const desired=absolute(wanted);
    const nodeKey=(im,i)=>String(im.closest('[data-page]')?.getAttribute('data-page')||
                                  im.getAttribute('data-index')||i+1);
    const matches=nodes.map((im,i)=>({im,key:nodeKey(im,i)})).filter(x=>x.key===key);
    if (matches.length!==1) return {loaded:false,key,reason:'Image ordinal not unique in current reader DOM',matches:matches.length};
    const im=matches[0].im;
    const urls=[im.currentSrc,im.getAttribute('src'),im.src,...attrs.map(a=>im.getAttribute(a))]
      .map(absolute).filter(Boolean);
    // Never navigate or replace a source: verify that this is still the same
    // image before touching it, so a virtualized reader can't mix pages.
    if(desired && !urls.includes(desired))
      return {loaded:false,key,reason:'Image source changed during revisit'};
    // Compare decoded bytes with the ACTUAL requested panel source. A decoded
    // spinner or thumbnail does not mean the data-src image is ready. This
    // remains generic: no website names, placeholder filenames, or CDN rules.
    const isReady=()=>im.isConnected && im.complete && im.naturalWidth>0 &&
      im.naturalHeight>0 && (!desired || absolute(im.currentSrc || im.src)===desired);
    if(isReady() && !p.force_position) return {loaded:true,key,width:im.naturalWidth,height:im.naturalHeight,alreadyReady:true};
    // Keep the viewport on the missing image. Restoring the previous offset
    // (often the bottom) after EVERY attempt caused an endless up/down
    // teleport and prevented lazy IntersectionObservers from settling.
    // Only the first targeted revisit may jump; subsequent checks stay here.
    im.loading='eager';
    if (p.refresh_source && !isReady() && desired.startsWith('https:') && urls.includes(desired)) {
      // Retry exactly the original DOM-declared URL in the normal document,
      // once only, after ordinary lazy observation failed. Never invent a CDN.
      im.src=desired;
    }
    // Targeted correction happens once per missing slot; a decoded image
    // requires no re-scroll.  Keep the camera there while lazy loading settles.
    const rect=im.getBoundingClientRect();
    await moveViewportTo(window.scrollY+rect.top+(rect.height-window.innerHeight)/2,210);
    const paintReady=await waitForPaintOrTimer();
    const deadline=Date.now()+6500;
    while(Date.now()<deadline && !isReady()){
      if(!im.isConnected) break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    return {loaded:isReady(),key,width:im.naturalWidth||0,height:im.naturalHeight||0,
      paintReady,reason:isReady()?'requested image decoded after targeted scroll':
      (!im.isConnected?'Reader replaced image node':
      (im.complete && im.naturalWidth>0 && im.naturalHeight>0 ?
       'Decoded placeholder or different URL; requested image still not loaded' :
       'Requested image still has naturalWidth=0'))};
  }

  // Replay ONLY an image already present and decoded in this specific page.
  // It remains a normal <img> request from the original tab; URL and browser
  // identity are unchanged, and we do not touch other browser tabs.
  async function reobserveLoadedImage(raw) {
    const normalize = value => {try {const u=new URL(String(value||'').trim(),location.href);u.hash='';return u.href;}catch{return '';}};
    const wanted=normalize(raw);
    if (!wanted || !wanted.startsWith('https://')) return {ok:false,reason:'invalid URL'};
    const match=[...document.images].find(im =>
      [im.currentSrc,im.src,im.getAttribute('src'),im.getAttribute('data-src'),im.getAttribute('data-original')]
        .some(a => normalize(a)===wanted) && im.complete && im.naturalWidth>0);
    if (!match) return {ok:false,loaded:false,reason:'requested image is not decoded in selected tab'};
    const probe=document.createElement('img');
    probe.alt='';probe.decoding='async';probe.loading='eager';
    probe.style.cssText='position:fixed!important;left:-100px!important;top:-100px!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;';
    document.body.appendChild(probe);
    try {
      const outcome=await Promise.race([
        new Promise(resolve=>{probe.onload=()=>resolve(true);probe.onerror=()=>resolve(false);
          probe.src=wanted;}),
        new Promise(resolve=>setTimeout(()=>resolve(false),6000))
      ]);
      return {ok:outcome,loaded:outcome,reason:outcome?'decoded in original tab':'browser did not reload original image'};
    } finally {probe.remove();}
  }

  const abs = value => {try {let u=new URL(String(value||'').trim(),location.href);u.hash='';return u.href;}catch{return '';}};
  const matchesImage = (im,url) => [im.currentSrc,im.src,im.getAttribute('src'),im.getAttribute('data-src'),
    im.getAttribute('data-original')].some(v=>abs(v)===abs(url));
  // Compatibility cascade: preserve the existing external-CDN probe first.
  // A site may instead have decoded panels at its own origin; the adapter
  // already specifies the reader container, so add this narrow fallback.
  const firstLoadedImage = options => {
    const origins=Array.isArray(options) ? options : (options?.origins || []);
    let image=[...document.images].find(im=>im.complete && im.naturalWidth>0 &&
      (origins||[]).some(o=>abs(im.currentSrc).startsWith(o+'/')));
    if (!image && !Array.isArray(options)) {
      for(const selector of (Array.isArray(options?.reader_selectors) ? options.reader_selectors : [])) {
        let root;
        try { root=document.querySelector(selector); } catch { continue; }
        if (!root) continue;
        image=[...root.querySelectorAll('img')].find(im=>im.complete && im.naturalWidth>0 &&
          im.naturalHeight>0 && abs(im.currentSrc || im.src).startsWith('https://'));
        if (image) break;
      }
    }
    // A browser can display same-origin blob: pages whose original CDN URL
    // never appears in the DOM. This is a generic rendered-image fallback.
    // Use the existing selected-tab screenshot capture, not a second fetch.
    if (!image && !Array.isArray(options)) {
      for(const selector of (Array.isArray(options?.reader_selectors) ? options.reader_selectors : [])) {
        let root; try {root=document.querySelector(selector);} catch {continue;}
        if (!root) continue;
        const original=[...root.querySelectorAll('img')].find(im=>im.complete && im.naturalWidth>0 &&
          im.naturalHeight>0 && (im.currentSrc||im.src||'').startsWith('blob:'));
        if (!original) continue;
        const source=abs(original.currentSrc||original.src);
        // A clean-reader extension may hide the original image DOM and show a
        // visible clone. Both point at the exact same already-decoded blob URL.
        // Prefer that visible clone so screenshot capture cannot target 0x0.
        image=[...document.images].find(im => im.complete && im.naturalWidth>0 &&
          abs(im.currentSrc||im.src)===source && (()=>{const r=im.getBoundingClientRect?.();return r&&r.width>0&&r.height>0;})()) || original;
        break;
      }
    }
    return {url:image ? abs(image.currentSrc) : ''};
  };
  // Background/minimized Chrome tabs can stop delivering requestAnimationFrame.
  // This is a paint synchronization fallback, not a chapter timeout. Never
  // leave a Chrome extension message unanswered just because frames stop.
  function waitForPaintOrTimer(maxWaitMs=250) {
    return new Promise(resolve => {
      let done=false;
      let timer;
      const finish=painted => {
        if(done) return;
        done=true;
        clearTimeout(timer);
        resolve(painted);
      };
      timer=setTimeout(()=>finish(false),maxWaitMs);
      try {
        requestAnimationFrame(()=>requestAnimationFrame(()=>finish(true)));
      } catch {finish(false);}
    });
  }
  // Visible, bounded progression; no one-frame jumps across the scrollbar.
  // Timers, not rAF, drive motion so a paused animation clock cannot strand
  // a browser-extension command. The final position is exact for screenshots.
  async function moveViewportTo(destination, duration=180) {
    const start=Number(window.scrollY)||0;
    const target=Math.max(0,Number(destination)||0);
    const distance=target-start;
    if(Math.abs(distance)<2) return target;
    const steps=Math.max(3,Math.min(14,Math.round(duration/24)));
    const interval=Math.max(12,Math.floor(duration/steps));
    for(let i=1;i<=steps;i++) {
      const t=i/steps;
      const eased=t*t*(3-2*t);
      window.scrollTo({top:i===steps?target:start+distance*eased,behavior:'instant'});
      if(i<steps) await new Promise(resolve=>setTimeout(resolve,interval));
    }
    return target;
  }
  async function imageTile(p) {
    // Hidden source widgets and visible reader clones may share the same
    // blob URL. Prefer the decoded, visible image instead of a zero-size node.
    const candidates=[...document.images].filter(im=>matchesImage(im,p.url) &&
      im.complete && im.naturalWidth>0 && im.naturalHeight>0);
    const img=candidates.find(im=>{const r=im.getBoundingClientRect();
      return r.width>0 && r.height>0;}) || candidates[0];
    if(!img) return {ok:false,reason:'No image DOM element matches requested URL'};
    if(!img.complete || !img.naturalWidth || !img.naturalHeight)
      return {ok:false,reason:'Source image has not decoded'};
    const rect=img.getBoundingClientRect();
    const docY=rect.top+window.scrollY;
    // Place the next unseen slice just below any sticky page header.
    await moveViewportTo(Math.max(0,docY+Math.max(0,Number(p.offsetCss)||0)-100), 130);
    const paintReady=await waitForPaintOrTimer();
    // Force fresh layout geometry even when Chrome has paused the animation clock.
    // A deferred paint is an observation, not grounds to skip/renumber a page.
    const r=img.getBoundingClientRect();
    return {ok:true,loaded:true,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,
      paintReady,rect:{left:r.left,top:r.top,width:r.width,height:r.height},
      viewportWidth:innerWidth,viewportHeight:innerHeight};
  }
  // Return page data directly to chrome.scripting.executeScript. This
  // survives document navigation without a persistent message receiver.
  // The identical dispatch is also available to Firefox's message transport.
  async function dispatch(message) {
    if (message?.type === 'PAGE') return html();
    if (message?.type === 'FIRST_LOADED_IMAGE') return firstLoadedImage(message.payload || {});
    if (message?.type === 'CAPTURE_IMAGE_TILE') return imageTile(message.payload || {});
    if (message?.type === 'CLASSIFY') return classify();
    if (message?.type === 'SNAPSHOT') return snapshot(message.payload || {});
    if (message?.type === 'IMAGE_STATUS') return imageStatus(message.payload?.url);
    if (message?.type === 'RECOVER_IMAGE') return recoverImage(message.payload || {});
    if (message?.type === 'REOBSERVE_LOADED_IMAGE') return reobserveLoadedImage(message.payload?.url);
    if (message?.type === 'SCROLL_POSITION') return {scrollY:window.scrollY};
    if (message?.type === 'RESTORE_SCROLL') {
      const pos=Number(message.payload?.scrollY);
      if (!Number.isFinite(pos) || pos < 0) return {error:'Invalid scroll restore position'};
      window.scrollTo({top:pos,behavior:'instant'});
      return {scrollY:window.scrollY};
    }
    if (message?.type === 'SCROLL_STATUS') {
      // Read-only. Never issue a second relative scroll after an uncertain ACK.
      const id=String(message.payload?.command_id||'');
      const entry=scrollLedger[id];
      return entry ? {...entry,scrollY:window.scrollY,url:location.href} :
        {command_id:id,status:'unknown',url:location.href,scrollY:window.scrollY};
    }
    if (message?.type === 'SCROLL') {
      const move=Math.max(450,Math.floor(innerHeight*.85));
      const id=String(message.payload?.command_id||'');
      // Legacy callers retain their existing visible animated behavior. Only
      // generic Python archiving sends IDs and uses the non-timer transport.
      if (!id) {
        const from=window.scrollY;
        await moveViewportTo(from+move,210);
        return move;
      }
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
        return {error:'Invalid scroll command ID'};
      if (scrollLedger[id]) {
        const entry=scrollLedger[id];
        return {...entry,scrollY:window.scrollY,url:location.href};
      }
      // Record BEFORE changing the page so any lost reply is observable.
      // Absolute instant position avoids background-tab timer throttling and
      // ensures this ID can never advance the page more than once.
      const from=Number(window.scrollY)||0;
      const target=Math.max(0,from+move);
      const entry={command_id:id,status:'issued',from,target,move,url:location.href};
      scrollLedger[id]=entry;
      scrollHistory.push(id);
      if (scrollHistory.length>128) delete scrollLedger[scrollHistory.shift()];
      window.scrollTo({top:target,behavior:'instant'});
      entry.status='applied';
      entry.observed=Number(window.scrollY)||0;
      return {...entry,scrollY:entry.observed};
    }
    if (message?.type === 'PING') return {ok:true,url:location.href,bridgeContentProtocol:6};
    return {error:'Unknown page command'};
  }
  window.__comicBridgeDirect = dispatch;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    Promise.resolve().then(()=>dispatch(message)).then(respond,
      error=>respond({error:String(error)}));
    return true;
  });
})();
