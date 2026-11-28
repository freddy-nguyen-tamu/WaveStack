"""Two explicitly selected English reader chapters; independent scoped archive."""
from __future__ import annotations
# === PERMANENT ADAPTER CONTRACT: KEEP THIS COMMENT IN EVERY FUTURE ADAPTER ===
# When adapting a new website, change only site_specific/site_adapter.py.
# Keep this complete contract comment in every replacement, even if the new
# website uses the legacy acquisition mode. Do not put site-specific selectors,
# URLs, chapter ordering, or filename rules into reusable/ or run.py.
#
# To enable native script-driven chapter acquisition, set
# SOURCE_BROWSER_TRANSPORT = 'extension' and define CHAPTER_DOWNLOAD_JS as a
# nonempty JavaScript expression (usually an immediately invoked function).
# Omit it or set it to None to retain the existing legacy acquisition mode.
# The reusable launcher auto-detects this setting; no CLI mode switch needed.
# Reusable navigates each adapter-discovered chapter, scrolls to a stable bottom,
# then injects this script into the managed tab. The script must return a plain
# synchronous object: {url: location.href, items: [...], loaded: count}.
# Each item must have {key: '1', order: 1, url: 'https://...',
# filename: '0001.jpg', width: 0, height: 0}, with consecutive 1-based keys/order
# and filenames 0001, 0002, ... plus an allowed image extension. Width/height
# are optional decoded natural dimensions (0 if unknown). Discover the exact
# reader pages in reading order from the real attached HTML/runtime capture;
# exclude ads, banners, placeholders, and duplicate non-reader DOM elements.
# Never guess missing URLs, chapter counts, or page order. Use native chapter
# discovery functions for the actual chapter list, canonical URL and labels.
# Declare ALLOWED_HOSTS, BRIDGE_IMAGE_HOSTS, EXTENSION_MATCHES and READER_SELECTORS
# accurately. Use ordinary authorized HTTPS image URLs, not data/blob/canvas,
# login bypasses, or hidden content. Use legacy mode if this contract does not
# fit. Optional script_download_expected(html, url) independently returns
# [(key, url), ...] in exact order for cross-checking the injected plan.
# The injected script specifies the ordered filenames and download commands;
# the reusable native Chrome download manager performs the transfers, checks
# receipts, validates bytes and actual format, and commits durable checkpoints.
# Do not click download anchors or run a second download loop in the adapter.
# Optional CHAPTER_DOWNLOAD_TRANSPORT = 'loaded-resource' reads original image
# bytes already received by the normal managed chapter (Chrome debugger
# permission). Use when ordinary native downloads fail but the page loads the
# images. No alternate CDN request or access-control bypass is attempted.
# Default 'native' retains Chrome's downloads API. Both preserve the same
# ordered plan and validation; neither accepts HTML or an interrupted receipt.
# PERMANENT CORS WARNING: an <img> may render normally and return HTTP 200
# while page-context fetch() fails because the CDN does not allow the reader
# origin (no Access-Control-Allow-Origin). Inspect actual browser network and
# console evidence before selecting a transport; do not infer byte access from
# DOM URLs, decoded dimensions, HTTP 200, or .jpg suffixes. A native download
# may also fail or return HTML even if the reader itself displays the image.
# For an authorized normally loaded image, choose 'loaded-resource' when
# native downloads fail; Chrome must expose the original loaded bytes. Do not
# disable web security, use fetch(mode='no-cors') to obtain opaque bytes,
# forge headers, or retry an actual access denial through another transport.
# Keep this CORS warning in every future adapter and reusable contract.
# Reusable handles GitHub batching, resume, publication and shutdown. Preserve
# existing series identity/checkpoints when changing a source for the same comic.
# Regenerate/reload the extension after a script or host change. Test against
# supplied captures before returning a patch. Never delete this comment block.
# ADDITIVE ORDERED-DOM MODE (not a change to the HTTPS-only modes above):
# CHAPTER_DOWNLOAD_TRANSPORT = 'ordered-dom' supports normal DOM images whose
# blob URLs may expire or whose HTTPS responses cannot be fetched under CORS.
# The synchronous adapter plan returns {url: canonical chapter URL, items,
# loaded, total}; items use the same key/order/filename contract, but url is
# chapter URL + '#reader-page-N' (stable slot identity, NEVER a fetch URL),
# and selector is a unique CSS selector for the exact img within READER_SELECTORS.
# script_download_expected is REQUIRED and independently validates the complete
# native slot count/order from HTML. No guessed slots, ad images or hidden pages.
# Generic code positions each declared image, validates the live document, reads
# same-origin live blobs or authorized already-delivered HTTPS bytes, otherwise
# exports origin-clean decoded pixels (PNG, never represented as original bytes).
# CORS/tainted canvas, unsupported sources and explicit access denial fail closed;
# do not intercept revocation, disable CORS, forge headers or bypass protections.
# Python receives bounded individual receipts, checkpoints each validated image,
# creates one verified chapter ZIP locally and passes the existing ordered files
# to the unchanged GitHub publisher. No browser download prompts or external CDN.
# All selectors, chapter URLs, and native catalog proof remain in the adapter.
# === END PERMANENT ADAPTER CONTRACT ===

import re
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
SOURCE_BROWSER_TRANSPORT='extension'
SOURCE_NAME='hentairead-dekaketsu-powerhara-tenchou-ni-shiboraretai'
STATE_STORAGE_MODE='scoped'
TITLE_ADAPTER_VERSION='hentairead-explicit-two-chapters-v1'
_SERIES_TITLE='Dekaketsu PowerHara Tenchou ni Shiboraretai!'
SERIES_SLUG_HINT='dekaketsu-powerhara-tenchou-ni-shiboraretai'
_BASE='https://hentairead.com/hentai/'+SERIES_SLUG_HINT
_CHAPTERS=(_BASE+'/english/',_BASE+'-2/english/')
DEFAULT_START_URL=_CHAPTERS[0]
ALLOWED_HOSTS=('hentairead.com',)
BRIDGE_IMAGE_HOSTS=() # Supplied DOM exposes same-origin blobs, not a verified image CDN.
EXTENSION_MATCHES=tuple(x+'*' for x in _CHAPTERS)
TITLE_SELECTORS=('#readingNavTop .detail-name',)
CHAPTER_LIST_SELECTORS=()
NEXT_NAV_SELECTORS=()
PREV_NAV_SELECTORS=()
CHAPTER_MENU_SELECTORS=()
READER_SELECTORS=('#readingImages',)
PAGE_TOTAL_SELECTORS=('#readingImages > .reading-page > img',)
IMAGE_ATTRIBUTES=('src',)
IMAGE_PLACEHOLDER_URL_MARKERS=()
SOURCE_CONFIRMED_MISSING_PANELS={}
ARCHIVED_SOURCE_CHAPTER_COUNT=2

def _chapter_url(url):
    p=urlsplit(str(url));
    if p.scheme!='https' or p.netloc!='hentairead.com': return None
    for ch in _CHAPTERS:
        base=urlsplit(ch).path
        if p.path.rstrip('/')==base.rstrip('/') or re.fullmatch(re.escape(base)+r'(?:p/)?[1-9]\d*/?',p.path):
            return ch
    return None

def chapter_identity(anchor,url,label):
    ch=_chapter_url(url)
    if ch is None: raise ValueError('Unexpected chapter URL')
    return str(_CHAPTERS.index(ch)+1)

def series_slug_from_url(url):
    return SERIES_SLUG_HINT if _chapter_url(url) else None

def title_from_html(soup):
    heading=soup.select_one('#readingNavTop .detail-name')
    canon=soup.select_one('link[rel="canonical"]')
    if heading and canon and _chapter_url(canon.get('href','')):
        return _SERIES_TITLE
    return None

def _native_slots(raw_html,page_url):
    soup=BeautifulSoup(raw_html,'html.parser')
    canon=soup.select_one('link[rel="canonical"]')
    if not canon or _chapter_url(canon.get('href',''))!=_chapter_url(page_url) or not _chapter_url(page_url):
        raise RuntimeError('Wrong native chapter document')
    imgs=soup.select(PAGE_TOTAL_SELECTORS[0])
    ids=[im.get('data-page') for im in imgs]
    parents=[im.parent.get('data-page') for im in imgs]
    title=soup.title.get_text(' ',strip=True) if soup.title else ''
    count=re.search(r'Page\s+\d+\s+of\s+(\d+)',title,re.I)
    if not count or not imgs or len(imgs)!=int(count.group(1)) or ids!=[str(i) for i in range(1,len(imgs)+1)] or ids!=parents:
        raise RuntimeError('Native chapter slots/count incomplete or nonconsecutive')
    return ids

def custom_chapters(raw_html,page_url,chapter_class):
    _native_slots(raw_html,page_url)
    # Exact two entries supplied by the user, not guessed from navigation.
    return [chapter_class(str(i),f'Chapter {i}',u) for i,u in enumerate(_CHAPTERS,1)]

def custom_browser_chapters(context,seed_url,seed_html,chapter_class,visit):
    return custom_chapters(seed_html,seed_url,chapter_class)

def chapter_title_from_html(soup,fallback): return fallback

def chapter_title_from_anchor(anchor,fallback): return fallback

def title_catalog_url(saved_url): return DEFAULT_START_URL

def native_chapter_titles_from_catalog(raw_html,page_url): return {}

def accept_catalog_title(chapter_id,title): return False

def after_chapter_visit(page,page_url):
    if _chapter_url(page.url)!=_chapter_url(page_url): raise RuntimeError('Unexpected reader redirect')
    _native_slots(page.content(),page_url)

CHAPTER_DOWNLOAD_TRANSPORT='ordered-dom'
CHAPTER_DOWNLOAD_JS=r"""(() => {
  const canonical=document.querySelector('link[rel="canonical"]')?.href;
  const root=document.querySelector('#readingImages');
  if(!canonical || !root) throw Error('Missing reader or canonical link');
  const imgs=[...root.querySelectorAll(':scope > .reading-page > img')];
  const total=Number((document.title.match(/Page\s+\d+\s+of\s+(\d+)/i)||[])[1]);
  if(!imgs.length || imgs.length!==total) throw Error('Incomplete native page list');
  const items=imgs.map((im,i)=>{
    const n=String(i+1);
    if(im.dataset.page!==n || im.parentElement.dataset.page!==n) throw Error('Nonconsecutive reader slots');
    return {key:n,order:i+1,url:canonical+'#reader-page-'+n,filename:n.padStart(4,'0')+'.png',selector:':scope > .reading-page[data-page="'+n+'"] > img[data-page="'+n+'"]'};
  });
  return {url:canonical,items,total,loaded:imgs.filter(im=>im.complete&&im.naturalWidth>0&&im.naturalHeight>0).length};
})()"""

def script_download_expected(raw_html,page_url):
    canonical=_chapter_url(page_url)
    return [(n,canonical+'#reader-page-'+n) for n in _native_slots(raw_html,page_url)]
