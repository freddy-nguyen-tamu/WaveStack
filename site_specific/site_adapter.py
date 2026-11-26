"""MangaDex: sole site-specific adapter; series verified from seed chapter.

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
SOURCE_NAME = 'mangadex-sasen-mo-warukunai-en'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'mangadex-sasen-mo-warukunai-v2'
SERIES_SLUG_HINT = 'sasen-mo-warukunai'
_SERIES_TITLE = 'Sasen mo Warukunai'
_MANGA = 'd0a90f8a-03ac-480d-a65c-e645eeec97c7'
_GROUP = 'afb17c55-229e-484f-b26a-5959c85fd383'
# All seven exact native UUIDs observed in the complete English group aggregate.
_CAPTURED_CHAPTERS = {1: '3442d5d4-c3f4-49ac-a041-3a30ee54f4fe', 2: '4daf1ffb-ee63-44f4-80c0-2d48dc8ab6cb', 3: '42377370-ab6e-4e67-8fcf-8931c90744ff', 4: '04e39cd1-bed9-446d-bd20-b870f594aafc', 5: 'a03f1685-8a3b-4a59-b44c-83955f82b6b2', 6: 'f16d90c6-81ec-479b-8ae0-fe992b7a71ea', 7: '6bcd30e2-1458-4805-a545-169b5eac1cd2'}
ARCHIVED_SOURCE_CHAPTER_COUNT = 7
_METADATA = {}
DEFAULT_START_URL = 'https://mangadex.org/chapter/3442d5d4-c3f4-49ac-a041-3a30ee54f4fe'
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
    if (parsed.scheme != 'https' or parsed.netloc != 'mangadex.org' or parsed.query or parsed.fragment):
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


def _validate_metadata(data, uid):
    if not isinstance(data, dict) or data.get('id') != uid or data.get('type') != 'chapter':
        raise RuntimeError('MangaDex chapter metadata identity mismatch')
    attrs = data.get('attributes') or {}
    rel = data.get('relationships') or []
    manga = {r.get('id') for r in rel if r.get('type') == 'manga'}
    groups = {r.get('id') for r in rel if r.get('type') == 'scanlation_group'}
    number = next((n for n, ident in _CAPTURED_CHAPTERS.items() if ident == uid), None)
    if (number is None or manga != {_MANGA} or _GROUP not in groups or
        attrs.get('translatedLanguage') != 'en' or str(attrs.get('chapter')) != str(number) or
        attrs.get('externalUrl') or attrs.get('isUnavailable') or
        type(attrs.get('pages')) is not int or attrs['pages'] < 1):
        raise RuntimeError('MangaDex chapter identity/availability mismatch: '+uid)
    return data


def _seed_info():
    global _SEED
    with _LOCK:
        if _SEED is None:
            uid = _uuid_from_url(DEFAULT_START_URL)
            data = _validate_metadata(_api_json('/chapter/'+uid)['data'], uid)
            _METADATA[uid] = data
            _SEED = {'manga':_MANGA, 'lang':'en', 'groups':frozenset({_GROUP}), 'seed':uid}
        return _SEED


def _feed_chapters():
    global _FEED
    with _LOCK:
        if _FEED is not None: return _FEED
        seed = _seed_info()
        # Public group-scoped aggregate was captured from the normal reader.
        # Compare its complete native chapter identities before trusting the feed.
        agg = _api_json('/manga/'+_MANGA+'/aggregate', params=[
            ('translatedLanguage[]','en'),('groups[]',_GROUP)])
        actual = {}
        volumes = agg.get('volumes')
        if not isinstance(volumes,dict) or not volumes:
            raise RuntimeError('MangaDex aggregate is missing volumes')
        for volume in volumes.values():
            rows = volume.get('chapters') or {}
            if not isinstance(rows,dict) or volume.get('count') != len(rows):
                raise RuntimeError('MangaDex aggregate has incomplete chapter rows')
            for row in rows.values():
                n = str(row.get('chapter'))
                if n in actual or row.get('isUnavailable'):
                    raise RuntimeError('MangaDex aggregate contains duplicate/unavailable chapters')
                actual[n] = row.get('id')
        if actual != {str(n):u for n,u in _CAPTURED_CHAPTERS.items()}:
            raise RuntimeError('MangaDex live aggregate differs from the captured seven-chapter edition; refusing incomplete or changed catalog')
        # Reuse prior MangaDex feed approach, with full pagination and seed-group
        # identity. Never select a different translation of a known chapter.
        offset=0; total=None; found={}; seen_ids=set()
        while total is None or offset < total:
            result=_api_json('/manga/'+seed['manga']+'/feed',params=[
                ('translatedLanguage[]',seed['lang']),('order[chapter]','asc'),
                ('limit','100'),('offset',str(offset))])
            portion=result.get('data'); value=result.get('total')
            if (not isinstance(portion,list) or type(value) is not int or not 1<=value<=100000 or
                (total is not None and value!=total) or result.get('offset',offset)!=offset or not portion):
                raise RuntimeError('MangaDex feed incomplete or changed during pagination')
            total=value
            for ch in portion:
                uid=str(ch.get('id',''))
                if not _UUID.fullmatch(uid) or uid in seen_ids:
                    raise RuntimeError('Invalid/duplicate MangaDex feed UUID')
                seen_ids.add(uid)
                if uid in _CAPTURED_CHAPTERS.values():
                    found[uid]=_validate_metadata(ch,uid)
            offset+=len(portion)
            if offset>total: raise RuntimeError('MangaDex feed exceeded declared total')
        if set(found)!=set(_CAPTURED_CHAPTERS.values()):
            raise RuntimeError('MangaDex feed omitted one or more verified chapters')
        _METADATA.update(found)
        _FEED=tuple(found[u] for u in _CAPTURED_CHAPTERS.values())
        return _FEED


def _chapter_metadata(uid):
    with _LOCK:
        if uid not in _CAPTURED_CHAPTERS.values():
            raise RuntimeError('Chapter is outside the verified MangaDex series catalog')
        if uid not in _METADATA:
            _METADATA[uid] = _validate_metadata(_api_json('/chapter/'+uid)['data'],uid)
        return _METADATA[uid]


def chapter_identity(anchor, url, label):
    return 'mdx-' + _uuid_from_url(url)


def title_from_html(soup):
    # root_metadata is called on EMPTY HTML before Chrome opens.
    if not soup.get_text(strip=True) and not soup.find(True):
        return _SERIES_TITLE
    title=soup.title.get_text(' ',strip=True) if soup.title else ''
    match=re.search(r'\bChapter\s+[^|]+\s+-\s+(.+?)\s+-\s+MangaDex\s*$',title,re.I)
    if match and match.group(1).strip()==_SERIES_TITLE:
        return _SERIES_TITLE
    og=soup.select_one('meta[property="og:title"]')
    if og and re.fullmatch(re.escape(_SERIES_TITLE)+r'(?: - Vol\. \d+(?:\.\d+)? Ch\. \d+(?:\.\d+)?)? - MangaDex',str(og.get('content') or '')):
        return _SERIES_TITLE
    raise RuntimeError('MangaDex page did not provide the expected series title')


def chapter_title_from_anchor(anchor,fallback): return fallback

def chapter_title_from_html(soup,fallback): return fallback

def title_catalog_url(saved_url): return saved_url or DEFAULT_START_URL

def accept_catalog_title(chapter_id,title):
    return str(chapter_id) in {'mdx-'+u for u in _CAPTURED_CHAPTERS.values()} and bool(str(title).strip())

def chapter_title_is_generic(label,chapter_id):return False


def custom_chapters(raw_html,page_url,chapter_class):
    if _uuid_from_url(page_url) not in _CAPTURED_CHAPTERS.values():
        raise RuntimeError('Source URL outside verified MangaDex series')
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


def captured_native_chapter_titles():
    # Reuse already observed API titles when the optional HTML title audit fails.
    if _FEED is None: return {}
    return native_chapter_titles_from_catalog('', DEFAULT_START_URL)


def _at_home(chapter_uuid):
    with _LOCK:
        if chapter_uuid in _AT_HOME: return _AT_HOME[chapter_uuid]
        expected=_chapter_metadata(chapter_uuid)['attributes']['pages']
        data=_api_json('/at-home/server/'+chapter_uuid)
        node=data.get('chapter') or {}; hash_value=str(node.get('hash') or '')
        files=node.get('data')
        base=str(data.get('baseUrl') or '').rstrip('/')
        parsed=urlsplit(base)
        host=parsed.hostname or ''
        if not (parsed.scheme=='https' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.port is None and parsed.path in ('','/')
                and (host=='uploads.mangadex.org' or host=='mangadex.org' or host.endswith('.mangadex.network'))):
            raise RuntimeError('Unrecognized/untrusted MangaDex image delivery host: '+host)
        if not re.fullmatch(r'[A-Za-z0-9]{20,128}',hash_value) or not isinstance(files,list) or not files:
            raise RuntimeError('MangaDex chapter image manifest missing hash/page list')
        if any(not isinstance(name,str) or not _PANEL_FILE.fullmatch(name) or '/' in name or '..' in name for name in files):
            raise RuntimeError('MangaDex returned an unsafe image filename')
        if len(files)!=expected: raise RuntimeError('MangaDex @Home page count differs from native chapter metadata')
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
    _DOM.pop(chapter,None)
    def get_exact_image(url,headers=None,timeout=45000):
        # Every requested URL must be an exact member of THIS chapter's @Home
        # manifest. The native DOM filename identifies its decoded blob.
        names,urls=_at_home(chapter)
        if url not in urls:
            raise RuntimeError('Image not in current MangaDex chapter manifest')
        native_name=names[urls.index(url)]
        blob=_DECODED_BLOBS.get(chapter,{}).get(native_name)
        if blob and getattr(ctx,'bridge',None):
            response=ctx.bridge.rpc('read_loaded_blob',{
                'url':blob,'reader_selectors':list(READER_SELECTORS),
                'require_clean_pixels':True},timeout=45)
            if response.get('status')==200 and response.get('base64'):
                import base64
                from reusable.browser_bridge import BrowserResponse
                data=base64.b64decode(response['base64'],validate=True)
                return BrowserResponse(url,200,response.get('headers') or {},data,
                                       response.get('via') or 'decoded-source-tab-blob')
            if response.get('status') != 424:
                # Never retry an access denial or transport error as an alternate path.
                raise RuntimeError('MangaDex decoded-image transfer failed: '+str(response.get('status')))
            # Only a local blob lifetime failure permits the original, declared
            # public @Home request. Explicit HTTP denial remains handled by engine.
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
    # Match real source URL to the DOM filename, never infer the filename
    # from a recycled DOM index. Re-read HTML even when mount count stays equal.
    soup=BeautifulSoup(page.content(),'html.parser')
    root=soup.select_one('.md--reader-pages')
    indices=_ALT_NAMES.get(chapter) or {n:i for i,n in enumerate(names)}
    by_src={}; native_positions=[]
    if root:
        for im in root.select('img'):
            src=str(im.get('src') or '').strip(); alt=str(im.get('alt') or '').strip()
            if not src or src.startswith('data:'): continue
            if alt not in indices:
                raise RuntimeError('MangaDex rendered filename absent from verified @Home manifest: '+alt[:100])
            pos=indices[alt]
            if src in by_src or pos in native_positions:
                raise RuntimeError('Duplicate MangaDex panel identity')
            by_src[src]=pos; native_positions.append(pos)
    if native_positions!=sorted(native_positions):
        raise RuntimeError('MangaDex DOM image order differs from verified @Home manifest')
    by_name={}; matched=[]; decoded={}
    for node in raw_imgs:
        src=str(node.get('url') or '')
        if src not in by_src or not node.get('loaded'): continue
        pos=by_src[src]
        if pos in matched: raise RuntimeError('Duplicate MangaDex snapshot panel')
        matched.append(pos); by_name[names[pos]]=node
        if (src.startswith('blob:https://mangadex.org/') and
            int(node.get('width') or 0)>0 and int(node.get('height') or 0)>0):
            decoded[names[pos]]=src
    if matched!=sorted(matched):
        raise RuntimeError('MangaDex snapshot image order differs from verified @Home manifest')
    _DECODED_BLOBS[chapter]=decoded
    if matched:
        _DOM[chapter]=True
    if not _DOM.get(chapter):
        return {**info,'imgs':[],'total':len(names),'readerCount':len(raw_imgs),
                'missingSlots':len(names),'unloadedSlots':len(names)}
    if not root:
        raise RuntimeError('Verified MangaDex reader disappeared during acquisition')
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
