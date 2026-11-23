// This module is appended to the *staged* reader app.js so it can reuse its
// original togglePanel(), nextChapter(), and updateAuto() safely, not duplicate them.
{
  const panel = $('#reader-panel');
  const pages = $('#pages');
  const home = document.createElement('button');
  home.type = 'button';
  home.id = 'or-library-back';
  home.hidden = true;
  home.setAttribute('aria-label', 'Return to the Open Reader homepage');
  // The homepage's transparent golden favicon is also the only back icon.
  home.textContent = '';
  home.title = 'Return to the Open Reader homepage';
  document.body.append(home);
  const flip = document.createElement('div');
  flip.className = 'or-page-flip'; flip.setAttribute('aria-hidden', 'true');
  document.body.append(flip);
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let leaving = false;
  const leave = (target='/') => {
    if(leaving)return;
    leaving = true;
    window.OpenReaderSaveProgress?.();
    if(reduced()){location.assign(target);return}
    document.documentElement.classList.add('or-flip-exit');
    setTimeout(()=>location.assign(target),420);
  };
  home.addEventListener('click',()=>leave('/'));
  // The comic title is a genuine overview link. Keep the original #panel-series
  // element in place so native title updates and panel controls still work.
  const seriesName = $('#panel-series');
  const seriesLink = document.createElement('a');
  seriesLink.className = 'or-comic-overview-link';
  seriesLink.href = new URL('./overview/', location.href).href;
  seriesLink.setAttribute('aria-label', 'Open this comic homepage and browse chapters');
  seriesLink.title = 'Browse chapters of this comic';
  seriesName.parentNode.insertBefore(seriesLink, seriesName);
  seriesLink.append(seriesName);
  seriesLink.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    leave(seriesLink.href);
  });
  // Reveal on actual mouse movement or when the navigation bar opens.
  // Hide after five seconds of no movement, regardless of whether the bar is open.
  let backIdleTimer = 0;
  const revealBack = () => {
    if(leaving)return;
    home.hidden = false;
    clearTimeout(backIdleTimer);
    backIdleTimer = setTimeout(() => {home.hidden = true}, 5000);
  };
  const syncBack = () => {if(!panel.hidden)revealBack()};
  new MutationObserver(syncBack).observe(panel,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('pointermove', e => {
    if(e.pointerType === 'mouse')revealBack();
  }, {passive:true});
  window.addEventListener('mousemove', e => {
    // Fallback for browsers that do not implement Pointer Events.
    if(!window.PointerEvent)revealBack();
  }, {passive:true});
  syncBack();

  // Trigger the animation only on entering from outside another chapter page.
  // Existing internal chapter links and nextChapter() retain their instant flow.
  let fromReader = false;
  try {const u = new URL(document.referrer);fromReader = u.origin===location.origin &&
      /^\/comics\/[a-z0-9-]+\/(?:index\.html)?$/.test(u.pathname)} catch {}
  const skipFlip = sessionStorage.getItem('open-reader:skip-entry-flip') === location.pathname;
  sessionStorage.removeItem('open-reader:skip-entry-flip');
  const navigation=performance.getEntriesByType?.('navigation')?.[0];
  const isReload=navigation?.type==='reload';
  if(!fromReader && !skipFlip && !isReload && !reduced()){
    document.documentElement.classList.add('or-flip-enter');
    setTimeout(()=>document.documentElement.classList.remove('or-flip-enter'),440);
  }
  // When an ordinary chapter link navigates within the reader, explicitly
  // mark the next load as internal even if the browser strips Referer.
  document.addEventListener('click', e => {
    if(e.button!==0||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
    const a=e.target.closest?.('#panel-chapters a.panel-chapter');
    if(!a)return;
    try {
      const u=new URL(a.href,location.href);
      if(u.origin===location.origin && u.pathname===location.pathname){
        sessionStorage.setItem('open-reader:skip-entry-flip',u.pathname);
        const next=u.searchParams.get('chapter');
        if(next)window.OpenReaderTrackChapter?.(next,0);
      }
    } catch {}
  },true);
  // Wrap the original chapter navigation rather than replacing its logic.
  const chapterNext = nextChapter;
  nextChapter = function(direction, auto=false) {
    const target = manifest?.chapters?.[chapterIndex + direction];
    // Going FORWARD past the final published chapter leaves this comic's reader
    // and opens its overview with the same page-flip as any other exit.
    // Normal chapter-to-chapter flow stays inside the unmodified original.
    if(!target && direction > 0 && manifest?.chapters?.length &&
       chapterIndex === manifest.chapters.length - 1 && !transitioning &&
       !(auto && !allLoaded())) {
      if(auto){settings.auto=false;write();}
      leave(seriesLink.href);
      return;
    }
    if(target && !transitioning && !(auto && !allLoaded())){
      sessionStorage.setItem('open-reader:skip-entry-flip',location.pathname);
      window.OpenReaderTrackChapter?.(target.id,0);
    }
    return chapterNext(direction,auto);
  };

  // Ctrl+Shift alone toggles the panel on releasing either modifier. Do not
  // intercept Ctrl+Shift+T/other browser shortcuts; Shift+Enter still works.
  let chord=false, chordUsed=false;
  window.addEventListener('keydown', e => {
    if(e.key==='Control'||e.key==='Shift'){
      if(e.ctrlKey&&e.shiftKey&&!e.repeat){chord=true;chordUsed=false}
    }else if(chord)chordUsed=true;
  },true);
  window.addEventListener('keyup', e => {
    if(chord && (e.key==='Control'||e.key==='Shift')){
      if(!chordUsed && !leaving)togglePanel();
      chord=false;chordUsed=false;
    }
  },true);

  // Existing single Enter still toggles auto-scroll. Four quick presses leave
  // to the main library, restoring the pre-sequence auto-scroll preference.
  let enterCount=0, lastEnter=0, enterAuto=false;
  window.addEventListener('keydown', e => {
    if(e.key==='?' && !e.ctrlKey&&!e.altKey&&!e.metaKey && !panelOpen && !activeInput()){
      e.preventDefault();e.stopImmediatePropagation();leave('./settings.html');return;
    }
    if(e.key!=='Enter'||e.repeat||e.ctrlKey||e.altKey||e.metaKey||e.shiftKey)return;
    const now=performance.now();
    if(now-lastEnter>370 || enterCount===0){enterCount=0;enterAuto=settings.auto}
    lastEnter=now;enterCount++;
    if(enterCount===4){
      e.preventDefault();e.stopImmediatePropagation();
      updateAuto(enterAuto);enterCount=0;
      leave('/');
    }
  },true);

  // Touch: horizontal swipe left=previous, right=next, not the inverse.
  // Single/double tap retains native scrolling; triple opens the navigator,
  // quadruple exits. Delaying the triple action permits a fourth tap.
  let touch=null,taps=0,lastTap=0,tapTimer=0;
  const resetTaps=()=>{taps=0;clearTimeout(tapTimer)};
  document.addEventListener('touchstart', e => {
    touch=null;
    if(e.touches.length!==1||leaving)return;
    if(e.target.closest?.('button,input,textarea,select,a,[contenteditable="true"]'))return;
    const t=e.touches[0];touch={id:t.identifier,x:t.clientX,y:t.clientY,time:performance.now()};
  },{passive:true});
  document.addEventListener('touchend', e => {
    if(!touch||e.changedTouches.length!==1||e.changedTouches[0].identifier!==touch.id)return;
    const t=e.changedTouches[0],dx=t.clientX-touch.x,dy=t.clientY-touch.y;
    const age=performance.now()-touch.time;touch=null;
    if(Math.abs(dx)>68 && Math.abs(dx)>Math.abs(dy)*1.35 && age<1100){
      resetTaps();if(!panelOpen)nextChapter(dx<0?-1:1);return;
    }
    if(Math.abs(dx)>24||Math.abs(dy)>24||age>290)return;
    const now=performance.now();
    if(now-lastTap>430)resetTaps();
    lastTap=now;taps++;
    if(taps===4){resetTaps();leave('/');return}
    if(taps===3){clearTimeout(tapTimer);tapTimer=setTimeout(()=>{
      if(taps===3 && !leaving)togglePanel();resetTaps();
    },440)}
  },{passive:true});
  document.addEventListener('touchcancel',()=>{touch=null;resetTaps()},{passive:true});
}
