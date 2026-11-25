"""Single-provider adapter for Relife on truyenqq.com.vn.

Grounding: 2026-11-24 browser runtime capture of /relife/chapter-1.
Original HTTP HTML contains *two identical* 226-item native chapter <select>
menus, newest first; both menus are EMPTY in the hydrated/live HTML.
The 27 chapter-1 artwork images are in .reading-content > .inner and are
served by s40.cc3t.net. The site loads /images/loading.svg and
/images/placeholder.jpg as successfully decoded spinner/placeholder images.

Only this file changes on provider switch. No inferred chapter or CDN URLs:
the frozen catalog below is an exact, captured source menu, used only if
live source HTML and one normal HTTP catalog request cannot supply a menu.
It does not prove chapters created after the capture; fresh catalog wins.
Browser-rendered CDN images use the existing Comic Bridge selected-tab
transfer; the adapter never performs an extra image download or bypasses
challenge pages. Source-origin HTTP failures remain visible and retryable.
"""
from __future__ import annotations

import re
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import urlopen

from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'truyenqq-relife'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'truyenqq-relife-native-select-20261124-v1'
SERIES_SLUG_HINT = 'relife'
DEFAULT_START_URL = 'https://truyenqq.com.vn/relife/chapter-1'
ALLOWED_HOSTS = ('truyenqq.com.vn',)
# This is the only *observed* panel CDN in the supplied runtime/network trace.
# Never give Comic Bridge blanket access to ads, scripts or unknown CDNs.
BRIDGE_IMAGE_HOSTS = ('s40.cc3t.net',)
EXTENSION_MATCHES = ('https://truyenqq.com.vn/relife/chapter-*',)
TITLE_SELECTORS = ('meta[property="og:title"]', 'title')
READER_SELECTORS = ('.reading-content > .inner', '.reading-content .inner')
PAGE_TOTAL_SELECTORS = ()  # One source-declared <img> = one physical panel.
IMAGE_ATTRIBUTES = ('data-src', 'data-original', 'data-lazy-src', 'src')
IMAGE_PLACEHOLDER_URL_MARKERS = (
    '/images/loading.svg', '/images/placeholder.jpg', '/images/image-placeholder.webp',
)
SOURCE_CONFIRMED_MISSING_PANELS = {}

# The unhydrated HTTP HTML supplies the entire authoritative chapter menu.
# Do not set generic next/prev or normal anchor-list selectors: those would
# bypass custom_chapters() and trigger an unnecessary 226-page navigation crawl.
# Native links observed: a.next[href], a.back[href]; menu #select-reading.
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
NATIVE_CHAPTER_MENU_SELECTORS = ('#select-reading option[value]', '#select-reading-2 option[value]')
NATIVE_NEXT_NAV_SELECTORS = ('a.next[href]',)
NATIVE_PREV_NAV_SELECTORS = ('a.back[href]',)

_SITE = 'truyenqq.com.vn'
_CDN = 's40.cc3t.net'
_SEED_PATH = '/relife/chapter-1'
_SLUG = re.compile(r'chapter-(?:0|[1-9][0-9]*)(?:-[0-9]+)*\Z')
_MENU_LOCK = threading.Lock()
_MENU_CACHE = None
_MENU_ATTEMPTED = False

# Source-verbatim option value and text pairs from the browser's original
# document HTTP response. NOT guessed from a chapter-number range; contains
# the actual decimals and latest native entries as observed at capture time.
_CAPTURED_MENU = (
    ('chapter-224', 'Chapter 224'),
    ('chapter-223', 'Chapter 223'),
    ('chapter-222', 'Chapter 222'),
    ('chapter-221-1', 'Chapter 221.1'),
    ('chapter-221', 'Chapter 221'),
    ('chapter-220', 'Chapter 220'),
    ('chapter-219', 'Chapter 219'),
    ('chapter-218', 'Chapter 218'),
    ('chapter-217', 'Chapter 217'),
    ('chapter-216', 'Chapter 216'),
    ('chapter-215', 'Chapter 215'),
    ('chapter-214', 'Chapter 214'),
    ('chapter-213', 'Chapter 213'),
    ('chapter-212', 'Chapter 212'),
    ('chapter-211', 'Chapter 211'),
    ('chapter-210', 'Chapter 210'),
    ('chapter-209', 'Chapter 209'),
    ('chapter-208', 'Chapter 208'),
    ('chapter-207', 'Chapter 207'),
    ('chapter-206', 'Chapter 206'),
    ('chapter-205', 'Chapter 205'),
    ('chapter-204', 'Chapter 204'),
    ('chapter-203', 'Chapter 203'),
    ('chapter-202', 'Chapter 202'),
    ('chapter-201', 'Chapter 201'),
    ('chapter-200', 'Chapter 200'),
    ('chapter-199', 'Chapter 199'),
    ('chapter-198', 'Chapter 198'),
    ('chapter-197', 'Chapter 197'),
    ('chapter-196', 'Chapter 196'),
    ('chapter-195', 'Chapter 195'),
    ('chapter-194', 'Chapter 194'),
    ('chapter-193', 'Chapter 193'),
    ('chapter-192', 'Chapter 192'),
    ('chapter-191', 'Chapter 191'),
    ('chapter-190', 'Chapter 190'),
    ('chapter-189', 'Chapter 189'),
    ('chapter-188', 'Chapter 188'),
    ('chapter-187', 'Chapter 187'),
    ('chapter-186', 'Chapter 186'),
    ('chapter-185', 'Chapter 185'),
    ('chapter-184', 'Chapter 184'),
    ('chapter-183', 'Chapter 183'),
    ('chapter-182', 'Chapter 182'),
    ('chapter-181', 'Chapter 181'),
    ('chapter-180', 'Chapter 180'),
    ('chapter-179', 'Chapter 179'),
    ('chapter-178', 'Chapter 178'),
    ('chapter-177', 'Chapter 177'),
    ('chapter-176', 'Chapter 176'),
    ('chapter-175', 'Chapter 175'),
    ('chapter-174', 'Chapter 174'),
    ('chapter-173', 'Chapter 173'),
    ('chapter-172', 'Chapter 172'),
    ('chapter-171', 'Chapter 171'),
    ('chapter-170', 'Chapter 170'),
    ('chapter-169', 'Chapter 169'),
    ('chapter-168', 'Chapter 168'),
    ('chapter-167', 'Chapter 167'),
    ('chapter-166', 'Chapter 166'),
    ('chapter-165', 'Chapter 165'),
    ('chapter-164', 'Chapter 164'),
    ('chapter-163', 'Chapter 163'),
    ('chapter-162', 'Chapter 162'),
    ('chapter-161', 'Chapter 161'),
    ('chapter-160', 'Chapter 160'),
    ('chapter-159', 'Chapter 159'),
    ('chapter-158', 'Chapter 158'),
    ('chapter-157', 'Chapter 157'),
    ('chapter-156', 'Chapter 156'),
    ('chapter-155', 'Chapter 155'),
    ('chapter-154', 'Chapter 154'),
    ('chapter-153', 'Chapter 153'),
    ('chapter-152', 'Chapter 152'),
    ('chapter-151', 'Chapter 151'),
    ('chapter-150-5', 'Chapter 150.5'),
    ('chapter-150', 'Chapter 150'),
    ('chapter-149', 'Chapter 149'),
    ('chapter-148', 'Chapter 148'),
    ('chapter-147', 'Chapter 147'),
    ('chapter-146', 'Chapter 146'),
    ('chapter-145', 'Chapter 145'),
    ('chapter-144', 'Chapter 144'),
    ('chapter-143', 'Chapter 143'),
    ('chapter-142', 'Chapter 142'),
    ('chapter-141', 'Chapter 141'),
    ('chapter-140', 'Chapter 140'),
    ('chapter-139', 'Chapter 139'),
    ('chapter-138', 'Chapter 138'),
    ('chapter-137', 'Chapter 137'),
    ('chapter-136', 'Chapter 136'),
    ('chapter-135', 'Chapter 135'),
    ('chapter-134', 'Chapter 134'),
    ('chapter-133', 'Chapter 133'),
    ('chapter-132', 'Chapter 132'),
    ('chapter-131', 'Chapter 131'),
    ('chapter-130', 'Chapter 130'),
    ('chapter-129', 'Chapter 129'),
    ('chapter-128', 'Chapter 128'),
    ('chapter-127', 'Chapter 127'),
    ('chapter-126', 'Chapter 126'),
    ('chapter-125', 'Chapter 125'),
    ('chapter-124', 'Chapter 124'),
    ('chapter-123', 'Chapter 123'),
    ('chapter-122', 'Chapter 122'),
    ('chapter-121', 'Chapter 121'),
    ('chapter-120', 'Chapter 120'),
    ('chapter-119', 'Chapter 119'),
    ('chapter-118', 'Chapter 118'),
    ('chapter-117', 'Chapter 117'),
    ('chapter-116', 'Chapter 116'),
    ('chapter-115', 'Chapter 115'),
    ('chapter-114', 'Chapter 114'),
    ('chapter-113', 'Chapter 113'),
    ('chapter-112', 'Chapter 112'),
    ('chapter-111', 'Chapter 111'),
    ('chapter-110', 'Chapter 110'),
    ('chapter-109', 'Chapter 109'),
    ('chapter-108', 'Chapter 108'),
    ('chapter-107', 'Chapter 107'),
    ('chapter-106', 'Chapter 106'),
    ('chapter-105', 'Chapter 105'),
    ('chapter-104', 'Chapter 104'),
    ('chapter-103', 'Chapter 103'),
    ('chapter-102', 'Chapter 102'),
    ('chapter-101', 'Chapter 101'),
    ('chapter-100', 'Chapter 100'),
    ('chapter-99', 'Chapter 99'),
    ('chapter-98', 'Chapter 98'),
    ('chapter-97', 'Chapter 97'),
    ('chapter-96', 'Chapter 96'),
    ('chapter-95', 'Chapter 95'),
    ('chapter-94', 'Chapter 94'),
    ('chapter-93', 'Chapter 93'),
    ('chapter-92', 'Chapter 92'),
    ('chapter-91', 'Chapter 91'),
    ('chapter-90', 'Chapter 90'),
    ('chapter-89', 'Chapter 89'),
    ('chapter-88', 'Chapter 88'),
    ('chapter-87', 'Chapter 87'),
    ('chapter-86', 'Chapter 86'),
    ('chapter-85', 'Chapter 85'),
    ('chapter-84', 'Chapter 84'),
    ('chapter-83', 'Chapter 83'),
    ('chapter-82', 'Chapter 82'),
    ('chapter-81', 'Chapter 81'),
    ('chapter-80', 'Chapter 80'),
    ('chapter-79', 'Chapter 79'),
    ('chapter-78', 'Chapter 78'),
    ('chapter-77', 'Chapter 77'),
    ('chapter-76', 'Chapter 76'),
    ('chapter-75', 'Chapter 75'),
    ('chapter-74', 'Chapter 74'),
    ('chapter-73', 'Chapter 73'),
    ('chapter-72', 'Chapter 72'),
    ('chapter-71', 'Chapter 71'),
    ('chapter-70', 'Chapter 70'),
    ('chapter-69', 'Chapter 69'),
    ('chapter-68', 'Chapter 68'),
    ('chapter-67', 'Chapter 67'),
    ('chapter-66', 'Chapter 66'),
    ('chapter-65', 'Chapter 65'),
    ('chapter-64', 'Chapter 64'),
    ('chapter-63', 'Chapter 63'),
    ('chapter-62', 'Chapter 62'),
    ('chapter-61', 'Chapter 61'),
    ('chapter-60', 'Chapter 60'),
    ('chapter-59', 'Chapter 59'),
    ('chapter-58', 'Chapter 58'),
    ('chapter-57', 'Chapter 57'),
    ('chapter-56', 'Chapter 56'),
    ('chapter-55', 'Chapter 55'),
    ('chapter-54', 'Chapter 54'),
    ('chapter-53', 'Chapter 53'),
    ('chapter-52', 'Chapter 52'),
    ('chapter-51', 'Chapter 51'),
    ('chapter-50', 'Chapter 50'),
    ('chapter-49', 'Chapter 49'),
    ('chapter-48', 'Chapter 48'),
    ('chapter-47', 'Chapter 47'),
    ('chapter-46', 'Chapter 46'),
    ('chapter-45', 'Chapter 45'),
    ('chapter-44', 'Chapter 44'),
    ('chapter-43', 'Chapter 43'),
    ('chapter-42', 'Chapter 42'),
    ('chapter-41', 'Chapter 41'),
    ('chapter-40', 'Chapter 40'),
    ('chapter-39', 'Chapter 39'),
    ('chapter-38', 'Chapter 38'),
    ('chapter-37', 'Chapter 37'),
    ('chapter-36', 'Chapter 36'),
    ('chapter-35', 'Chapter 35'),
    ('chapter-34', 'Chapter 34'),
    ('chapter-33', 'Chapter 33'),
    ('chapter-32', 'Chapter 32'),
    ('chapter-31', 'Chapter 31'),
    ('chapter-30', 'Chapter 30'),
    ('chapter-29', 'Chapter 29'),
    ('chapter-28', 'Chapter 28'),
    ('chapter-27', 'Chapter 27'),
    ('chapter-26', 'Chapter 26'),
    ('chapter-25', 'Chapter 25'),
    ('chapter-24', 'Chapter 24'),
    ('chapter-23', 'Chapter 23'),
    ('chapter-22', 'Chapter 22'),
    ('chapter-21', 'Chapter 21'),
    ('chapter-20', 'Chapter 20'),
    ('chapter-19', 'Chapter 19'),
    ('chapter-18', 'Chapter 18'),
    ('chapter-17', 'Chapter 17'),
    ('chapter-16', 'Chapter 16'),
    ('chapter-15', 'Chapter 15'),
    ('chapter-14', 'Chapter 14'),
    ('chapter-13', 'Chapter 13'),
    ('chapter-12', 'Chapter 12'),
    ('chapter-11', 'Chapter 11'),
    ('chapter-10', 'Chapter 10'),
    ('chapter-9', 'Chapter 9'),
    ('chapter-8', 'Chapter 8'),
    ('chapter-7', 'Chapter 7'),
    ('chapter-6', 'Chapter 6'),
    ('chapter-5', 'Chapter 5'),
    ('chapter-4', 'Chapter 4'),
    ('chapter-3', 'Chapter 3'),
    ('chapter-2', 'Chapter 2'),
    ('chapter-1', 'Chapter 1'),
)


def _slug(url):
    p = urlsplit(str(url or ''))
    if (p.scheme != 'https' or p.hostname != _SITE or p.port is not None or
            p.username or p.password or p.query or p.fragment):
        raise ValueError('Only the observed HTTPS Relife chapter host is accepted: '+str(url))
    path = p.path.rstrip('/')
    if not path.startswith('/relife/'):
        raise ValueError('Not a Relife chapter: '+str(url))
    tail = path[len('/relife/'):]
    if not _SLUG.fullmatch(tail):
        raise ValueError('Unrecognized source chapter slug: '+str(url))
    return tail


def chapter_identity(anchor, url, label):
    return 'truyenqq-relife-' + _slug(url)


def title_from_html(soup):
    texts=[]
    for selector in ('meta[property="og:title"]', 'title'):
        tag=soup.select_one(selector)
        if tag is not None:
            texts.append(str(tag.get('content') or '') if tag.name=='meta'
                         else tag.get_text(' ',strip=True))
    for title in texts:
        if re.match(r'^\s*relife\s*(?:[-:|]|$)', title, flags=re.I):
            return 'Relife'
    if not texts:
        return None
    raise RuntimeError('Source page does not identify the captured Relife comic')


def chapter_title_from_anchor(anchor, fallback):
    return anchor.get_text(' ',strip=True) if anchor is not None else fallback


def chapter_title_from_html(soup, fallback):
    # The catalogue label belongs to this exact chapter identity. Never read
    # the whole chapter dropdown: it starts with the newest chapter.
    expected = re.fullmatch(r'Chapter\s+([0-9]+(?:\.[0-9]+)?)', str(fallback).strip(), flags=re.I)
    for selector in ('.chapter-title h1', 'h1.current-book', 'meta[property="og:title"]', 'title'):
        node = soup.select_one(selector)
        if node is None:
            continue
        label = str(node.get('content') or '') if node.name == 'meta' else node.get_text(' ', strip=True)
        match = re.search(r'\bChapter\s+([0-9]+(?:\.[0-9]+)?)\b', label, flags=re.I)
        if match and (not expected or match.group(1) == expected.group(1)):
            return 'Chapter '+match.group(1)
    return fallback


def _parse_menu(raw, page_url):
    _slug(page_url)
    soup=BeautifulSoup(raw or '', 'html.parser')
    raw_groups=[]
    for selector in NATIVE_CHAPTER_MENU_SELECTORS:
        entries=soup.select(selector)
        if not entries:
            continue
        menu=[]
        for o in entries:
            raw_href=str(o.get('value') or '').strip()
            url=urljoin(page_url,raw_href)
            slug=_slug(url)
            if raw_href.startswith('//'):
                raise RuntimeError('Source menu contains a protocol-relative chapter URL')
            label=o.get_text(' ',strip=True)
            if not re.fullmatch(r'Chapter\s+[0-9]+(?:\.[0-9]+)?',label,flags=re.I):
                raise RuntimeError('Unexpected native Relife chapter title: '+repr(label))
            menu.append((slug,label))
        if len({slug for slug,label in menu}) != len(menu):
            raise RuntimeError('Duplicate chapter in source native menu')
        raw_groups.append(menu)
    if len(raw_groups)>1 and any(x!=raw_groups[0] for x in raw_groups[1:]):
        raise RuntimeError('Top and bottom chapter menus disagree; refuse incomplete catalog')
    return tuple(raw_groups[0]) if raw_groups else ()


def _validate_menu(rows):
    if not rows:
        raise RuntimeError('Relife chapter catalog missing: refusing to guess URLs')
    if len(rows)<len(_CAPTURED_MENU):
        raise RuntimeError('Relife catalog has fewer rows than the 226 independently observed chapter entries')
    if len(set(rows))!=len(rows) or len({slug for slug,_ in rows})!=len(rows):
        raise RuntimeError('Relife catalog has duplicate entries')
    captured=dict(_CAPTURED_MENU)
    observed=dict(rows)
    changed=[(k,v,observed.get(k)) for k,v in captured.items() if observed.get(k)!=v]
    if changed:
        raise RuntimeError('Relife native catalog contradicted previously observed chapter identities/labels: '
                           +str(changed[:3]))
    if 'chapter-1' not in observed:
        raise RuntimeError('Seed chapter missing from Relife catalog')
    return tuple(rows)


def _source_catalog():
    """One metadata-only HTTP read if live JS removed native menu options.

    If the normal source request is blocked, fall back to the browser-captured
    exact menu; never fabricate the next chapter or request unknown image URLs.
    The original chapter browser session remains the access authority.
    """
    global _MENU_CACHE, _MENU_ATTEMPTED
    with _MENU_LOCK:
        if _MENU_ATTEMPTED:
            return _MENU_CACHE
        _MENU_ATTEMPTED=True
        try:
            with urlopen(DEFAULT_START_URL,timeout=12) as response:
                landed=response.geturl()
                if urlsplit(landed).hostname != _SITE or urlsplit(landed).path.rstrip('/') != _SEED_PATH:
                    raise RuntimeError('Catalog HTTP request redirected to a different site or chapter')
                if response.status != 200:
                    raise RuntimeError('Catalog HTTP response status: '+str(response.status))
                body=response.read(2*1024*1024+1)
                if len(body)>2*1024*1024:
                    raise RuntimeError('Catalog HTTP HTML exceeded 2 MiB safety bound')
                raw=body.decode('utf-8','replace')
                fresh=_parse_menu(raw,DEFAULT_START_URL)
                if fresh:
                    _MENU_CACHE=_validate_menu(fresh)
                    print('RELIFE_CATALOG_SOURCE: verified_live_http_native_menu entries='+str(len(_MENU_CACHE)),flush=True)
                    return _MENU_CACHE
                # A 200 challenge page or changed document is NOT proof of a
                # complete catalog; do not silently treat it as a valid result.
                raise RuntimeError('Live HTTP document contained no native chapter menu')
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            print('RELIFE_CATALOG_SOURCE: live HTTP catalog unavailable ('+type(exc).__name__+
                  '); using 226 exact browser-captured options from 2026-11-24',flush=True)
            _MENU_CACHE=_CAPTURED_MENU
        return _MENU_CACHE


def _catalog_from_html_or_verified_capture(raw, page_url):
    parsed=_parse_menu(raw,page_url)
    if parsed:
        return _validate_menu(parsed)
    result=_source_catalog()
    if result is None:
        raise RuntimeError('Current Relife catalog unavailable; no verified chapter list')
    return _validate_menu(result)


def custom_chapters(raw_html, page_url, chapter_class):
    rows=_catalog_from_html_or_verified_capture(raw_html,page_url)
    # Native selects are newest-first; archive oldest-first, preserving
    # subchapters and all original labels, never inferring chapter numbers.
    return [chapter_class(chapter_identity(None,urljoin(DEFAULT_START_URL,'/relife/'+slug),label),
                          label,urljoin(DEFAULT_START_URL,'/relife/'+slug))
            for slug,label in reversed(rows)]


def title_catalog_url(saved_url):
    _slug(saved_url or DEFAULT_START_URL)
    return saved_url or DEFAULT_START_URL


def native_chapter_titles_from_catalog(raw_html,page_url):
    class _Chapter:
        def __init__(self,chapter_id,label,url):
            self.chapter_id,self.label,self.url=chapter_id,label,url
    return {x.chapter_id:x.label for x in custom_chapters(raw_html,page_url,_Chapter)}


def captured_native_chapter_titles():
    """Exact previously observed native labels; no HTTP or browser access."""
    return {chapter_identity(None, urljoin(DEFAULT_START_URL, '/relife/' + slug), label): label
            for slug, label in _validate_menu(_CAPTURED_MENU)}


def accept_catalog_title(chapter_id,label):
    if not isinstance(chapter_id, str) or not chapter_id.startswith('truyenqq-relife-'):
        return False
    slug = chapter_id.removeprefix('truyenqq-relife-')
    match = re.fullmatch(r'Chapter\s+([0-9]+(?:\.[0-9]+)?)', str(label), flags=re.I)
    return bool(match and _SLUG.fullmatch(slug) and slug.removeprefix('chapter-').replace('-', '.') == match.group(1))


def custom_page_snapshot(page):
    """Correct site's misleading loaded spinner state without source requests.

    Comic Bridge's generic snapshot gives the image order and actual decode
    status. The same currently loaded page HTML exposes the original data-src
    and current src. A spinner can have naturalWidth>0, but it is not artwork.
    Return the declared real URL with loaded=False until the browser actually
    decodes that *same* real URL. Never infer panel names or visit a CDN here.
    """
    _slug(page.url)
    info=page.evaluate(r"""() => { /* MutationObserver: source browser DOM reader snapshot */
      const root=document.querySelector('.reading-content > .inner') ||
                 document.querySelector('.reading-content .inner');
      if(!root) return {imgs:[],total:0,missingSlots:0,unloadedSlots:0,
                       scrollY:scrollY||0,bottom:0,viewportHeight:innerHeight};
      const imgs=[...root.querySelectorAll('img')].map((im,i)=>{
        const rect=im.getBoundingClientRect();
        return {key:String(i+1),url:im.currentSrc||im.getAttribute('src')||'',
          loaded:!!(im.complete&&im.naturalWidth>0&&im.naturalHeight>0),
          width:im.naturalWidth||0,height:im.naturalHeight||0,
          pageY:rect.top+scrollY};
      });
      const height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
      return {imgs,total:imgs.length,readerCount:imgs.length,
        missingSlots:imgs.filter(v=>!v.url).length,
        unloadedSlots:imgs.filter(v=>!v.loaded).length,
        scrollY:scrollY||0,bottom:Math.max(0,height-innerHeight),
        viewportHeight:innerHeight,height,revision:0};
    }""")
    if not isinstance(info,dict) or not isinstance(info.get('imgs'),list):
        raise RuntimeError('Comic Bridge did not return structured current-document image evidence')
    html=page.content()
    _slug(page.url)  # A managed-tab recycle must not silently change chapter.
    soup=BeautifulSoup(html, 'html.parser')
    root=None
    for selector in READER_SELECTORS:
        root=soup.select_one(selector)
        if root is not None:
            break
    if root is None:
        raise RuntimeError('The current chapter has no source .reading-content image container')
    nodes=root.select('img')
    observations=info['imgs']
    if not nodes or len(nodes)!=len(observations):
        raise RuntimeError('Reader image nodes changed while scanning; retry this chapter without guessing ordinals')
    out=[]
    for i,(node,obs) in enumerate(zip(nodes,observations),1):
        if str(obs.get('key') or '') != str(i):
            raise RuntimeError('Reader panel numbering changed during the DOM snapshot')
        declared=str(node.get('data-src') or node.get('data-original') or
                     node.get('data-lazy-src') or node.get('src') or '').strip()
        if not declared:
            out.append({'key':str(i),'url':'','loaded':False,
                        'width':0,'height':0,'pageY':float(obs.get('pageY') or 0)})
            continue
        normalized=urljoin(page.url,declared)
        p=urlsplit(normalized)
        if any(marker in normalized for marker in IMAGE_PLACEHOLDER_URL_MARKERS):
            out.append({'key':str(i),'url':'','loaded':False,
                        'width':0,'height':0,'pageY':float(obs.get('pageY') or 0)})
            continue
        if p.scheme!='https' or p.hostname!=_CDN or p.port is not None or p.username or p.password:
            raise RuntimeError('Unrecognized real chapter image host, adjust adapter after observation: '+normalized[:180])
        if not p.path.startswith('/chapters/') or p.query or p.fragment:
            raise RuntimeError('Unexpected chapter image CDN path or query: '+normalized[:180])
        actual=urljoin(page.url,str(node.get('src') or '').strip())
        snapshot_url=urljoin(page.url,str(obs.get('url') or '').strip())
        # The source's spinner SVG is a decoded image; the real URL is loaded
        # only when its current src and the bridge's decoded src both agree.
        loaded=(obs.get('loaded') is True and actual==normalized and
                snapshot_url==normalized and int(obs.get('width') or 0)>0 and
                int(obs.get('height') or 0)>0)
        out.append({'key':str(i),'url':normalized,'loaded':loaded,
                    'width':int(obs.get('width') or 0) if loaded else 0,
                    'height':int(obs.get('height') or 0) if loaded else 0,
                    'pageY':float(obs.get('pageY') or 0)})
    return {**info,'imgs':out,'total':len(out),'readerCount':len(out),
            'missingSlots':sum(not image['url'] for image in out),
            'unloadedSlots':sum(not image['loaded'] for image in out)}


def adapter_self_test():
    """Fast offline chapter/host/placeholder checks, callable without a browser.

    Imported only from this file: no additional provider-specific test file
    or reusable change is required. The normal run.py preflight handles the
    global reusable/bridge compatibility and regression suites.
    """
    class Chapter:
        def __init__(self,chapter_id,label,url):
            self.chapter_id,self.label,self.url=chapter_id,label,url
    rows=_validate_menu(_CAPTURED_MENU)
    assert len(rows)==226 and rows[0]==('chapter-224','Chapter 224')
    assert rows[-1]==('chapter-1','Chapter 1')
    parsed=custom_chapters('<select id="select-reading">'+''.join(
        '<option value="/relife/'+slug+'">'+label+'</option>' for slug,label in rows)
        +'</select>',DEFAULT_START_URL,Chapter)
    assert len(parsed)==226 and parsed[0].label=='Chapter 1' and parsed[-1].label=='Chapter 224'
    assert any(c.label=='Chapter 221.1' and c.url.endswith('/chapter-221-1') for c in parsed)
    assert len(set(c.chapter_id for c in parsed))==226
    assert len(captured_native_chapter_titles()) == 226
    assert captured_native_chapter_titles()['truyenqq-relife-chapter-150-5'] == 'Chapter 150.5'
    assert all(accept_catalog_title(k, v) for k, v in captured_native_chapter_titles().items())
    assert not accept_catalog_title('truyenqq-relife-chapter-2', 'Chapter 226')
    heading = BeautifulSoup('<div class="navi"><select><option>Chapter 224</option>'
                            '</select></div><div class="chapter-title"><h1>Relife : Chapter 2</h1></div>',
                            'html.parser')
    assert chapter_title_from_html(heading, 'Chapter 2') == 'Chapter 2'
    wrong_heading = BeautifulSoup('<h1 class="current-book">Chapter 224</h1>', 'html.parser')
    assert chapter_title_from_html(wrong_heading, 'Chapter 150.5') == 'Chapter 150.5'
    for bad in ('http://truyenqq.com.vn/relife/chapter-1',
                'https://evil.example/relife/chapter-1',
                'https://truyenqq.com.vn/relife/chapter-225?x=1'):
        try:_slug(bad)
        except ValueError:pass
        else:raise AssertionError('Untrusted chapter identity accepted: '+bad)
    class Page:
        url=DEFAULT_START_URL
        def __init__(self,src):self.src=src
        def evaluate(self,s):
            return {'imgs':[{'key':'1','url':self.src,'loaded':True,'width':100,'height':125,'pageY':0}],
                    'scrollY':0,'bottom':0,'viewportHeight':700,'total':1,'readerCount':1}
        def content(self):
            return ('<div class="reading-content"><div class="inner">'
                    '<img data-src="https://s40.cc3t.net/chapters/example/panel.jpg" src="'+self.src+'">'
                    '</div></div>')
    spinner=custom_page_snapshot(Page('/images/loading.svg'))
    assert spinner['imgs'][0]['loaded'] is False and spinner['imgs'][0]['url'].endswith('/panel.jpg')
    real=custom_page_snapshot(Page('https://s40.cc3t.net/chapters/example/panel.jpg'))
    assert real['imgs'][0]['loaded'] is True
    return {'chapters':226,'real_panels_observed_in_seed':27,'hosts':(_SITE,_CDN)}

# The adapter itself is the ONLY provider-specific test fixture allowed on a
# one-file site switch. run.py imports it before its existing global tests.
_ADAPTER_PREFLIGHT_PROOF = adapter_self_test()
