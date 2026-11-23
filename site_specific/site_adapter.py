"""MangaDex / Wotaku ni Koi wa Muzukashii: sole site-specific adapter.

Chapter traversal and rendered panel filenames are verified against MangaDex's
public API. The normal Chrome/Comic Bridge profile, state, checksums, and
publishing infrastructure are reused unchanged. No chapter URLs are guessed.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit, urljoin
import re
import threading
import time
import requests
from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'mangadex-wotakoi-en'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'mangadex-api-feed-v1'
SERIES_SLUG_HINT = 'wotaku-ni-koi-wa-muzukashii'
DEFAULT_START_URL = 'https://mangadex.org/chapter/a2524342-07a7-4b9d-998d-c1ac081f7b3c/2'
ALLOWED_HOSTS = ('mangadex.org',)
BRIDGE_IMAGE_HOSTS = ('api.mangadex.org', 'uploads.mangadex.org')
EXTENSION_MATCHES = ('https://mangadex.org/chapter/*',)
TITLE_SELECTORS = ('meta[property="og:title"]',)
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
READER_SELECTORS = ('.md--reader-pages',)
PAGE_TOTAL_SELECTORS = ('.md--reader-pages img',)
IMAGE_ATTRIBUTES = ('src', 'data-src', 'data-original')
IMAGE_PLACEHOLDER_URL_MARKERS = ()
SOURCE_CONFIRMED_MISSING_PANELS = {}

_API = 'https://api.mangadex.org'
_UUID = re.compile(r'^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$', re.I)
_PANEL_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,240}\.(?:png|jpe?g|webp|avif|gif)$', re.I)
_SESSION = requests.Session()
_SESSION.headers.update({'Accept':'application/json', 'User-Agent':'ComicArchiver/1.5.17 (+MangaDex public API; image integrity verification)'})
_LOCK = threading.RLock()
_LAST_API_REQUEST = 0.0
_SEED = None
_FEED = None
_AT_HOME = {}
_DOM = {}
_IMAGE_URLS = set()
_ALT_NAMES = {}  # chapter UUID -> dataSaver filename mapping onto canonical data order
# COMICARCHIVER_AUTH_BLOB_TRANSFER_20261122 provider-specific exact decoded image references.
# This is cache metadata only, never a substitute for actual image bytes.
_DECODED_BLOBS = {}  # chapter UUID -> {verified canonical image filename: blob URL}



def _uuid_from_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'mangadex.org':
        raise ValueError('MangaDex chapter must use https://mangadex.org')
    pieces = parsed.path.strip('/').split('/')
    if len(pieces) not in (2,3) or pieces[0] != 'chapter' or not _UUID.fullmatch(pieces[1]):
        raise ValueError('MangaDex chapter URL must contain a verified UUID: '+url)
    if len(pieces) == 3 and (not pieces[2].isdigit() or int(pieces[2]) < 1):
        raise ValueError('Invalid MangaDex page number')
    return pieces[1].lower()


def _api_json(path, *, params=None):
    """Bounded public API access. Fail closed on 403, 429 or incomplete feeds."""
    global _LAST_API_REQUEST
    if not (path.startswith('/') and '://' not in path and '..' not in path):
        raise ValueError('Unsafe MangaDex API path')
    with _LOCK:
        delay = max(0, .37 - (time.monotonic()-_LAST_API_REQUEST))
        if delay: time.sleep(delay)
        _LAST_API_REQUEST = time.monotonic()
        response = _SESSION.get(_API+path,params=params,timeout=(10,35),allow_redirects=False)
    if response.status_code == 429:
        raise RuntimeError('MangaDex API rate-limited (429). Stop and retry after its Retry-After interval; no chapters skipped.')
    if response.status_code in (401,403):
        raise RuntimeError(f'MangaDex API access denied ({response.status_code}); not bypassing site protection')
    if response.status_code != 200:
        raise RuntimeError(f'MangaDex API {path} returned {response.status_code}; chapter discovery not complete')
    data = response.json()
    if not isinstance(data,dict) or data.get('result') != 'ok':
        raise RuntimeError('MangaDex API returned an incomplete/invalid result')
    return data


def _seed_info():
    global _SEED
    with _LOCK:
        if _SEED is None:
            uid = _uuid_from_url(DEFAULT_START_URL)
            data = _api_json('/chapter/'+uid)['data']
            attr=data.get('attributes') or {}
            lang=str(attr.get('translatedLanguage') or '')
            manga=[r.get('id') for r in data.get('relationships',[]) if r.get('type') == 'manga']
            if not manga or not _UUID.fullmatch(manga[0]) or not re.fullmatch(r'[a-z]{2}(?:-[a-z]{2})?',lang):
                raise RuntimeError('Seed chapter has no verifiable manga and language')
            groups={r.get('id') for r in data.get('relationships',[]) if r.get('type')=='scanlation_group'}
            _SEED={'manga':manga[0], 'lang':lang, 'groups':frozenset(groups), 'seed':uid}
        return _SEED


def _numeric(label):
    try: return Decimal(str(label))
    except (InvalidOperation, TypeError): return None


def _feed_chapters():
    global _FEED
    with _LOCK:
        if _FEED is not None: return _FEED
        seed = _seed_info()
        entries=[]; offset=0; total=None; limit=100
        while total is None or offset < total:
            result=_api_json('/manga/'+seed['manga']+'/feed',params=[
                ('translatedLanguage[]',seed['lang']),('order[chapter]','asc'),
                ('limit',str(limit)),('offset',str(offset))])
            portion=result.get('data')
            value=result.get('total')
            if not isinstance(portion,list) or not isinstance(value,int) or value < 1 or value > 100000:
                raise RuntimeError('Incomplete MangaDex chapter feed metadata')
            if total is not None and total != value:
                raise RuntimeError('MangaDex chapter feed changed during pagination; retry next run')
            total=value
            if offset >= total: break
            if not portion:
                raise RuntimeError(f'MangaDex chapter feed ended prematurely at {offset}/{total}')
            for ch in portion:
                aid=ch.get('id',''); attrs=ch.get('attributes') or {}
                relations=ch.get('relationships') or []
                manga=[r.get('id') for r in relations if r.get('type')=='manga']
                if not _UUID.fullmatch(str(aid)) or attrs.get('translatedLanguage') != seed['lang']:
                    raise RuntimeError('MangaDex chapter feed contained invalid UUID or unexpected language')
                if manga and seed['manga'] not in manga:
                    raise RuntimeError('MangaDex feed mixed different manga IDs')
                if attrs.get('externalUrl'): continue  # No actual MangaDex image reader.
                grp={r.get('id') for r in relations if r.get('type')=='scanlation_group'}
                entries.append((ch, bool(grp & seed['groups'])))
            offset+=len(portion)
            if offset > total: raise RuntimeError('MangaDex feed page exceeded declared total')
        if not entries: raise RuntimeError('No MangaDex chapters in the seed language')
        # Duplicate translations of the same logical volume/chapter: prefer the
        # seed's scanlation group, then stable publication time/UUID. Preserve
        # extra/unnumbered chapters by their unique actual UUIDs.
        chosen={}
        for chapter, preferred in entries:
            attrs=chapter['attributes']; number=attrs.get('chapter'); volume=attrs.get('volume')
            n=_numeric(number)
            key=('number',str(volume or ''),str(n)) if n is not None else ('uuid',chapter['id'])
            publish=str(attrs.get('publishAt') or attrs.get('createdAt') or '')
            score=(0 if preferred else 1,publish,chapter['id'])
            if key not in chosen or score < chosen[key][0]: chosen[key]=(score,chapter)
        normalized=[entry[1] for entry in chosen.values()]
        def sort_key(ch):
            attr=ch['attributes']; n=_numeric(attr.get('chapter')); v=_numeric(attr.get('volume'))
            return (0 if n is not None else 1,n if n is not None else Decimal(0),
                    v if v is not None else Decimal(-1),str(attr.get('publishAt') or ''),ch['id'])
        normalized.sort(key=sort_key)
        if seed['seed'] not in [ch['id'] for ch in normalized]:
            # Seed can be a duplicate translation for the same chapter; retain
            # its exact selected chapter instead of silently skipping the seed.
            matching=next((ch for ch,_ in entries if ch['id']==seed['seed']),None)
            if matching is None: raise RuntimeError('Seed chapter is absent from the complete language-filtered feed')
            for i,ch in enumerate(normalized):
                a,b=matching['attributes'],ch['attributes']
                if a.get('chapter')==b.get('chapter') and a.get('volume')==b.get('volume'):
                    normalized[i]=matching; break
            else: normalized.append(matching);normalized.sort(key=sort_key)
        _FEED=tuple(normalized)
        return _FEED


def chapter_identity(anchor, url, label):
    return 'mdx-' + _uuid_from_url(url)


def title_from_html(soup):
    title=soup.title.get_text(' ',strip=True) if soup.title else ''
    match=re.search(r'\bChapter\s+[^|]+\s+-\s+(.+?)\s+-\s+MangaDex\s*$',title,re.I)
    if match:return match.group(1).strip()
    og=soup.select_one('meta[property="og:title"]')
    if og and og.get('content'):return og['content'].strip()
    return 'Wotaku ni Koi wa Muzukashii' if '/chapter/' in title else None


def chapter_title_from_anchor(anchor,fallback): return fallback

def chapter_title_from_html(soup,fallback): return fallback

def title_catalog_url(saved_url): return saved_url or DEFAULT_START_URL

def accept_catalog_title(chapter_id,title):return bool(str(title).strip())

def chapter_title_is_generic(label,chapter_id):return False


def custom_chapters(raw_html,page_url,chapter_class):
    _uuid_from_url(page_url)
    result=[]
    for ch in _feed_chapters():
        at=ch['attributes']; number=at.get('chapter'); volume=at.get('volume'); title=str(at.get('title') or '').strip()
        label=('Vol. '+str(volume)+' ' if volume else '')+('Ch. '+str(number) if number else 'Special')
        if title: label+=' - '+title
        result.append(chapter_class('mdx-'+ch['id'], label,
                                    'https://mangadex.org/chapter/'+ch['id']))
    return result


class _NativeChapter:
    def __init__(self,chapter_id,label,url):
        self.chapter_id,self.label,self.url=chapter_id,label,url


def native_chapter_titles_from_catalog(raw_html,page_url):
    return {ch.chapter_id:ch.label for ch in custom_chapters(raw_html,page_url,_NativeChapter)}


def _at_home(chapter_uuid):
    with _LOCK:
        if chapter_uuid in _AT_HOME: return _AT_HOME[chapter_uuid]
        data=_api_json('/at-home/server/'+chapter_uuid)
        node=data.get('chapter') or {}; hash_value=str(node.get('hash') or '')
        files=node.get('data')
        base=str(data.get('baseUrl') or '').rstrip('/')
        parsed=urlsplit(base)
        host=parsed.hostname or ''
        if not (parsed.scheme=='https' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                and (host=='uploads.mangadex.org' or host=='mangadex.org' or host.endswith('.mangadex.network'))):
            raise RuntimeError('Unrecognized/untrusted MangaDex image delivery host: '+host)
        if not re.fullmatch(r'[A-Za-z0-9]{20,128}',hash_value) or not isinstance(files,list) or not files:
            raise RuntimeError('MangaDex chapter image manifest missing hash/page list')
        if any(not isinstance(name,str) or not _PANEL_FILE.fullmatch(name) or '/' in name or '..' in name for name in files):
            raise RuntimeError('MangaDex returned an unsafe image filename')
        if len(set(files))!=len(files):raise RuntimeError('Duplicate MangaDex panel names; refusing reorder')
        saver=node.get('dataSaver') or []
        if saver and (not isinstance(saver,list) or len(saver)!=len(files) or
                      len(set(saver))!=len(saver) or
                      any(not isinstance(n,str) or not _PANEL_FILE.fullmatch(n) for n in saver)):
            raise RuntimeError('MangaDex saver-quality panel order is invalid')
        indices={name:i for i,name in enumerate(files)}
        for i,name in enumerate(saver):
            if name in indices and indices[name]!=i:
                raise RuntimeError('Conflicting MangaDex data/saver panel identity')
            indices[name]=i
        _ALT_NAMES[chapter_uuid]=indices
        urls=tuple(base+'/data/'+hash_value+'/'+name for name in files)
        _AT_HOME[chapter_uuid]=(tuple(files),urls)
        _IMAGE_URLS.update(urls)
        return _AT_HOME[chapter_uuid]


def _http_image_get(url,headers=None,timeout=45000):
    # Exact identity allowlist comes from this chapter's @Home manifest, never
    # from guessed URLs or a broad CDN regex. No source browser cookies sent.
    with _LOCK:
        if url not in _IMAGE_URLS:
            raise RuntimeError('Image URL not present in the verified MangaDex chapter manifest')
    session=requests.Session()
    response=session.get(url,headers={'Accept':'image/*','Referer':'https://mangadex.org/'},
                         timeout=(10,max(10,float(timeout)/1000)),allow_redirects=False)
    from reusable.browser_bridge import BrowserResponse
    return BrowserResponse(url,response.status_code,dict(response.headers),response.content,'api-at-home')


def after_chapter_visit(page,page_url):
    chapter=_uuid_from_url(page_url)
    _at_home(chapter)
    ctx=getattr(page,'context',None)
    req=getattr(ctx,'request',None)
    if req is None: raise RuntimeError('MangaDex adapter requires a normal browser context')
    _DECODED_BLOBS.pop(chapter,None)
    def get_exact_image(url,headers=None,timeout=45000):
        # Every requested URL must be an exact member of THIS chapter's @Home
        # manifest. The native DOM filename identifies its decoded blob.
        names,urls=_at_home(chapter)
        if url not in urls:
            raise RuntimeError('Image not in current MangaDex chapter manifest')
        native_name=names[urls.index(url)]
        blob=_DECODED_BLOBS.get(chapter,{}).get(native_name)
        if blob and getattr(ctx,'bridge',None):
            try:
                response=ctx.bridge.rpc('read_loaded_blob',{
                    'url':blob,'reader_selectors':list(READER_SELECTORS)},timeout=45)
                if response.get('status')==200 and response.get('base64'):
                    import base64
                    from reusable.browser_bridge import BrowserResponse
                    data=base64.b64decode(response['base64'],validate=True)
                    return BrowserResponse(url,200,response.get('headers') or {},data,
                                           'decoded-source-tab-blob')
            except Exception:
                # A blob may be evicted during page hydration; fall back to the
                # unchanged authenticated @Home URL and its ordinary integrity checks.
                pass
        return _http_image_get(url,headers=headers,timeout=timeout)
    req.get=get_exact_image
    # Generic engine still validates every returned byte using Pillow/SHA-256.
    # HTTP fallback is a real provider request and remains request-guarded.
    req.reuses_loaded_page_images=False
    req._mangadex_verified_api=True


def custom_page_snapshot(page):
    chapter=_uuid_from_url(page.url)
    names,urls=_at_home(chapter)
    # The fixed reusable bridge returns its real DOM snapshot for this marker.
    # A native Playwright browser executes the full source-neutral expression.
    info=page.evaluate('''() => { /* MutationObserver */
      const root=document.querySelector('.md--reader-pages');
      const imgs=[...(root?.querySelectorAll('img')||[])].map((im,i)=>({
        key:String(i+1),url:im.currentSrc||im.src||'',
        loaded:!!(im.complete&&im.naturalWidth&&im.naturalHeight),
        width:im.naturalWidth||0,height:im.naturalHeight||0,
        pageY:im.getBoundingClientRect().top+scrollY}));
      const height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
      return {imgs,total:imgs.length,readerCount:imgs.length,unloadedSlots:imgs.filter(x=>!x.loaded).length,
        scrollY:scrollY||0,bottom:Math.max(0,height-innerHeight),height,viewportHeight:innerHeight,revision:0};
    }''')
    if not isinstance(info,dict): raise RuntimeError('MangaDex browser returned no snapshot')
    raw_imgs=info.get('imgs') or []
    old=_DOM.get(chapter)
    # Reuse native filenames while the browser DOM order/length is stable.
    # Recheck the HTML if a lazy page has added/removed image elements.
    if old is None or len(old)!=len(raw_imgs):
        soup=BeautifulSoup(page.content(),'html.parser')
        root=soup.select_one('.md--reader-pages')
        observed=[str(im.get('alt') or '').strip() for im in root.select('img')] if root else []
        if len(observed)!=len(raw_imgs):
            # A script race while the reader hydrates; retry on next snapshot.
            observed=[]
        _DOM[chapter]=tuple(observed)
    observed=_DOM[chapter]
    native_seen=set(); native_order=[]
    by_name={}
    indices=_ALT_NAMES.get(chapter) or {n:i for i,n in enumerate(names)}
    if observed:
        for ix,alt in enumerate(observed):
            if not _PANEL_FILE.fullmatch(alt):
                raise RuntimeError('MangaDex rendered image has no exact native filename: '+alt[:100])
            if alt in native_seen: raise RuntimeError('Duplicate rendered MangaDex image filename')
            native_seen.add(alt);native_order.append(alt)
            pos=indices.get(alt)
            if pos is not None:
                by_name[names[pos]]=raw_imgs[ix]
                node=raw_imgs[ix]
                source=str(node.get('url') or '')
                if (source.startswith('blob:https://mangadex.org/') and
                        node.get('loaded') and int(node.get('width') or 0)>0 and
                        int(node.get('height') or 0)>0):
                    _DECODED_BLOBS.setdefault(chapter,{})[names[pos]]=source
        # Every native page must appear in API reading order, even if the
        # native reader has only loaded the first subset so far.
        positions=[indices.get(n,-1) for n in native_order]
        if -1 in positions or positions!=sorted(positions):
            raise RuntimeError('MangaDex DOM image order differs from verified @Home manifest')
    if not observed:
        # A valid API manifest alone is NOT evidence that the requested chapter
        # rendered in the paired browser. Wait for its real reader DOM rather
        # than archiving a login screen or an unrelated chapter.
        return {**info,'imgs':[],'total':len(names),'readerCount':len(raw_imgs),
                'missingSlots':len(names),'unloadedSlots':len(names)}
    # MangaDex's API supplies the complete authoritative ORIGINAL file list and
    # reading order. A SPA may virtualize or lazily mount only a few images in
    # the DOM. That is not evidence those missing DOM nodes lack image bytes.
    # Every HTTP image is verified with Pillow/SHA-256 by the generic engine.
    entries=[]
    for i,(name,url) in enumerate(zip(names,urls),1):
        node=by_name.get(name)
        entries.append({'key':str(i),'url':url,'loaded':True,
                        'width':node.get('width',0) if node else 0,
                        'height':node.get('height',0) if node else 0,
                        'pageY':node.get('pageY',0) if node else 0})
    return {**info,'imgs':entries,'total':len(entries),'readerCount':len(raw_imgs),
            'missingSlots':0,'unloadedSlots':0}
