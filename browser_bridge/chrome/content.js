/* Generic DOM transport: no site selectors, credentials, or source URLs embedded. */
(() => {
  // Versioned guard: a previously installed extension may have injected
  // an older content script into this tab. Upgrade without refreshing it.
  if (window.__comicBridgeContentLoadedVersion === 7 &&
      typeof window.__comicBridgeDirect === 'function') return;
  window.__comicBridgeContentLoadedVersion = 7;
  window.__comicBridgeContentLoaded = true;

  const html = () => ({url: location.href, html: '<!doctype html>\n' + document.documentElement.outerHTML});
  const classify = () => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      login: [...document.querySelectorAll('form input[type=password]')].some(visible),
      challenge: [...document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], #challenge-running, .cf-challenge, input[name*="captcha" i], .g-recaptcha, [data-sitekey]')].some(visible),
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
      const url = candidates.find(s => s && !/^(data:|blob:|about:)/i.test(s)) || '';
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
    return {found:imgs.length>0,loaded:imgs.some(im=>im.complete && im.naturalWidth>0 && im.naturalHeight>0),
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
    const isReady=()=>im.isConnected && im.complete && im.naturalWidth>0 && im.naturalHeight>0;
    if(isReady()) return {loaded:true,key,width:im.naturalWidth,height:im.naturalHeight,alreadyReady:true};
    const oldY=window.scrollY;
    let didScroll=false;
    try {
      // IntersectionObserver lazy loaders require the original <img> to
      // intersect the viewport. 'eager' merely permits normal browser loading.
      im.loading='eager';
      im.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});
      didScroll=true;
      // Chrome can pause rAF in a background/inactive tab, especially after
      // moving from the first processed chapter into the next document.
      // Never strand the bridge listener while waiting for a frame that may
      // not be delivered. The same bounded paint barrier is used by tiles.
      const paintReady=await waitForPaintOrTimer();
      const deadline=Date.now()+6500;
      while(Date.now()<deadline && !isReady()){
        if(!im.isConnected) break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      return {loaded:isReady(),key,width:im.naturalWidth||0,height:im.naturalHeight||0,
        paintReady,reason:isReady()?'loaded after targeted scroll':(!im.isConnected?'Reader replaced image node':'Image still has naturalWidth=0')};
    } finally {
      if(didScroll) window.scrollTo({top:oldY,behavior:'instant'});
    }
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
  const firstLoadedImage = origins => {
    const image=[...document.images].find(im=>im.complete && im.naturalWidth>0 &&
      (origins||[]).some(o=>abs(im.currentSrc).startsWith(o+'/')));
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
  async function imageTile(p) {
    const img=[...document.images].find(im=>matchesImage(im,p.url));
    if(!img) return {ok:false,reason:'No image DOM element matches requested URL'};
    if(!img.complete || !img.naturalWidth || !img.naturalHeight)
      return {ok:false,reason:'Source image has not decoded'};
    const rect=img.getBoundingClientRect();
    const docY=rect.top+window.scrollY;
    // Place the next unseen slice just below any sticky page header.
    window.scrollTo({top:Math.max(0,docY+Math.max(0,Number(p.offsetCss)||0)-100),behavior:'instant'});
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
    if (message?.type === 'FIRST_LOADED_IMAGE') return firstLoadedImage(message.payload?.origins);
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
    if (message?.type === 'SCROLL') {
      const move=Math.max(450,Math.floor(innerHeight*.85));
      scrollTo({top:scrollY+move,behavior:'instant'});
      return move;
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
