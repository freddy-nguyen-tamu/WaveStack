"""One-file source adapter for ManhwaRead / Childhood Friends.

Evidence: site_runtime_capture_manhwaread.com_2026-11-23T14-03-35-202Z.txt.
The site provides a complete native chapter menu and a numbered #imagesList
reader. Its six observed prologue images are decoded, same-origin ``blob:``
resources. The adapter does not derive image URLs from guesses, follow an
unobserved CDN, or make second-origin image fetches.

All existing reusable/browser_bridge/run.py code remains unchanged. The
existing generic extension action ``read_loaded_blob`` supplies exact bytes
from the already-decoded image in the selected normal Chrome tab.
"""
from __future__ import annotations

import base64
import re
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'manhwaread-childhood-friends'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'manhwaread-childhood-friends-dom-blob-v1'
SERIES_SLUG_HINT = 'childhood-friends'
DEFAULT_START_URL = 'https://manhwaread.com/manhwa/childhood-friends/chapter-00-prologue/'
ALLOWED_HOSTS = ('manhwaread.com',)
# The captured image bytes were browser-created blobs, not direct CDN images.
# Do not add API/advertising hosts as image extension permissions.
BRIDGE_IMAGE_HOSTS = ()
EXTENSION_MATCHES = ('https://manhwaread.com/manhwa/childhood-friends/*',)
TITLE_SELECTORS = ('meta[property="og:title"]', 'title')
# This source exposes a COMPLETE chapter menu in the initial chapter DOM.
# The generic discovery engine's validated-catalog shortcut runs when no
# ordinary list/navigation selectors are configured. Route the native menu
# through custom_chapters(), which validates it before returning all links.
# No reusable traversal, browser bridge, or publication behavior is modified.
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()  # Native complete chapter menu is authoritative.
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
READER_SELECTORS = ('#imagesList',)
PAGE_TOTAL_SELECTORS = ('#imagesList .image-page[data-page]',)
IMAGE_ATTRIBUTES = ('data-src', 'data-lazy-src', 'data-original', 'src')
IMAGE_PLACEHOLDER_URL_MARKERS = ()
SOURCE_CONFIRMED_MISSING_PANELS = {}

_SERIES_PATH = '/manhwa/childhood-friends/'
_CHAPTER_SLUG = re.compile(r'chapter-[a-z0-9][a-z0-9-]{0,120}\Z')
_PAGE_INDEX = re.compile(r'(?:0|[1-9][0-9]{0,5})\Z')
_BLOB_PREFIX = 'blob:https://manhwaread.com/'
# This is a LOCAL identity token, never a URL to request from ManhwaRead.
# Its chapter+ordinal identity is stable across new browser blob UUIDs and
# preserves verified checkpoint references across interrupted runs.
_LOCAL_PREFIX = 'https://manhwaread.com/__comicarchiver_local_blob_v1__/'

# Current page's observed, decoded blob URL for each verified DOM ordinal.
# This cache never stores pixels, site credentials, or a source CDN address.
_ACTIVE = {'chapter': None, 'blobs': {}}


def _chapter_slug(url: str) -> str:
    p = urlsplit(str(url))
    if p.scheme != 'https' or p.hostname != 'manhwaread.com' or p.port is not None or p.username or p.password:
        raise ValueError('Chapter URL must be the observed HTTPS ManhwaRead host')
    if p.query or p.fragment or not p.path.startswith(_SERIES_PATH):
        raise ValueError('Unexpected chapter URL or query parameters: ' + str(url))
    tail = p.path[len(_SERIES_PATH):].strip('/')
    if '/' in tail or not _CHAPTER_SLUG.fullmatch(tail):
        raise ValueError('Not a verified Childhood Friends chapter path: ' + str(url))
    return tail


def chapter_identity(anchor, url, label):
    # URL-derived identity does not depend on a dynamic DOM index or a guessed
    # next-chapter number. The exact URL must occur in the source chapter list.
    return 'mhr-childhood-friends-' + _chapter_slug(url)


def title_from_html(soup):
    tag = soup.select_one('meta[property="og:title"]')
    heading = str(tag.get('content') or '') if tag else ''
    heading = heading or (soup.title.get_text(' ', strip=True) if soup.title else '')
    if not heading:
        return None  # Initial HTML is allowed to be empty before tab navigation.
    match = re.search(r'^Reading\s+(.+?)\s+-\s+Chapter\s+[0-9]+', heading, re.I)
    if not match or match.group(1).strip() != 'Childhood Friends':
        raise RuntimeError('Source title is not the captured Childhood Friends work')
    return match.group(1).strip()


def chapter_title_from_anchor(anchor, fallback):
    label = anchor.get_text(' ', strip=True) if anchor is not None else ''
    return label or fallback


def chapter_title_from_html(soup, fallback):
    current = soup.select_one('a.chapter-item.current')
    label = current.get_text(' ', strip=True) if current else ''
    return label or fallback


def _menu(raw_html, page_url, chapter_class):
    _chapter_slug(page_url)
    soup = BeautifulSoup(raw_html, 'html.parser')
    entries = soup.select('a.chapter-item[href]')
    if not entries:
        raise RuntimeError('Native chapter catalog absent from current DOM; do not guess chapter URLs')
    # Runtime capture on 2026-11-23 positively observed chapters 00 through 30.
    # A shorter DOM is an incomplete snapshot, never a complete catalog.
    if len(entries) < 31:
        raise RuntimeError('Native chapter catalog incomplete: fewer than 31 captured links; retry after the menu finishes loading')
    observed, urls, indexes = [], set(), set()
    for a in entries:
        link = urljoin(page_url, a.get('href') or '')
        slug = _chapter_slug(link)
        if link in urls:
            raise RuntimeError('Duplicate chapter URL in native catalog: ' + link)
        urls.add(link)
        index = a.get('data-index')
        if index is not None:
            if not index.isdigit() or int(index) in indexes:
                raise RuntimeError('Native chapter catalog has duplicate or invalid data-index')
            indexes.add(int(index))
        label = a.get_text(' ', strip=True)
        if not label:
            raise RuntimeError('Native chapter link has no title: ' + slug)
        observed.append((int(index) if index is not None else None,
                         chapter_class('mhr-childhood-friends-' + slug, label, link)))
    # The original HTTP HTML has the complete list in reading order but no
    # data-index; the hydrated DOM adds data-index. Preserve observed order
    # unless *every* row has an explicit, non-duplicated native index.
    if any(index is not None for index, _ in observed):
        if not all(index is not None for index, _ in observed):
            raise RuntimeError('Native chapter catalog has mixed indexed/unindexed rows; refusing partial catalog')
        if sorted(index for index, _ in observed) != list(range(len(observed))):
            raise RuntimeError('Native chapter catalog has missing or noncontiguous data-index values')
        observed.sort(key=lambda row: row[0])
    if not any(_chapter_slug(ch.url) == _chapter_slug(DEFAULT_START_URL) for _, ch in observed):
        raise RuntimeError('Captured seed chapter is absent from the native catalog')
    return [ch for _, ch in observed]


def custom_chapters(raw_html, page_url, chapter_class):
    # The generic engine normally uses CHAPTER_LIST_SELECTORS directly.
    # If the list disappears from a later page, this fallback fails closed
    # instead of assuming the currently visible chapter is the last one.
    return _menu(raw_html, page_url, chapter_class)


def title_catalog_url(saved_url):
    candidate = saved_url or DEFAULT_START_URL
    _chapter_slug(candidate)
    return candidate


class _MenuChapter:
    def __init__(self, chapter_id, label, url):
        self.chapter_id, self.label, self.url = chapter_id, label, url


def native_chapter_titles_from_catalog(raw_html, page_url):
    return {c.chapter_id: c.label for c in _menu(raw_html, page_url, _MenuChapter)}


def accept_catalog_title(chapter_id, label):
    return (str(chapter_id).startswith('mhr-childhood-friends-chapter-')
            and isinstance(label, str) and bool(label.strip()))


def _local_image_url(slug: str, key: str) -> str:
    return f'{_LOCAL_PREFIX}{slug}/page-{int(key):06d}'


def _exact_ordinal(url: str, chapter: str) -> str:
    if not url.startswith(_LOCAL_PREFIX):
        raise RuntimeError('Only local image references proven by the live reader are supported')
    suffix = url[len(_LOCAL_PREFIX):]
    match = re.fullmatch(re.escape(chapter) + r'/page-([0-9]{6})', suffix)
    if not match or int(match.group(1)) < 1:
        raise RuntimeError('Unrecognized or cross-chapter image identity')
    return str(int(match.group(1)))


def after_chapter_visit(page, page_url):
    slug = _chapter_slug(page_url)
    if _chapter_slug(page.url) != slug:
        raise RuntimeError('Selected Chrome tab is not displaying the expected chapter')
    ctx = getattr(page, 'context', None)
    req = getattr(ctx, 'request', None)
    bridge = getattr(ctx, 'bridge', None)
    if req is None or bridge is None:
        raise RuntimeError('Childhood Friends blob images require the existing normal-Chrome Comic Bridge')
    # Always reset on chapter entry or a reload. Never use another chapter's
    # previous blob IDs, or bytes from an earlier browser document.
    _ACTIVE['chapter'] = slug
    _ACTIVE['blobs'] = {}

    def read_verified_rendered_panel(url, headers=None, timeout=45000):
        if _chapter_slug(page.url) != slug or _ACTIVE['chapter'] != slug:
            raise RuntimeError('Reader navigated away before decoded image transfer')
        key = _exact_ordinal(str(url), slug)
        # Refresh the browser's *current* blob UUID immediately before
        # transfer. Lazy readers can recreate URLs without changing the
        # stable chapter+ordinal checkpoint identity.
        snapshot = custom_page_snapshot(page)
        current = next((im for im in snapshot['imgs'] if im['key'] == key), None)
        if not current or not current['loaded'] or current['url'] != str(url):
            raise RuntimeError('Requested panel is not decoded at its verified DOM ordinal')
        blob_url = _ACTIVE['blobs'].get(key)
        if not blob_url or not blob_url.startswith(_BLOB_PREFIX):
            raise RuntimeError('Requested panel has no observed decoded blob; keep checkpoint and retry after scrolling')
        answer = bridge.rpc('read_loaded_blob', {
            'url': blob_url, 'reader_selectors': list(READER_SELECTORS)},
            timeout=max(35, min(60, float(timeout)/1000 + 5)))
        if answer.get('status') != 200 or not answer.get('base64'):
            # Diagnostic only: retain the exact-image and checkpoint fail-closed gate.
            # The generic bridge reports the reason its pixel fallback failed.
            detail = answer.get('diagnostics') or {}
            if not isinstance(detail, dict):
                detail = {}
            revision = str(answer.get('bridge_revision') or 'MISSING_RELOAD_EXTENSION')[:70]
            pixel_error = str(detail.get('pixelFallbackError') or 'not reported')[:260]
            original_error = str(answer.get('reason') or 'unavailable')[:160]
            raise RuntimeError('Selected Chrome document could not return already-decoded panel '
                               + key + ': ' + original_error
                               + '; bridge_revision=' + revision
                               + '; pixelFallbackError=' + pixel_error)
        data = base64.b64decode(answer['base64'], validate=True)
        if not (0 < len(data) <= 20 * 1024 * 1024):
            raise RuntimeError('Decoded image has invalid byte length')
        from reusable.browser_bridge import BrowserResponse
        # Generic image_download verifies Pillow format/dimensions and SHA-256.
        return BrowserResponse(url, 200, answer.get('headers') or {}, data,
                               answer.get('via') or 'decoded-source-tab-blob')

    req.get = read_verified_rendered_panel
    req.reuses_loaded_page_images = True

    # The generic recovery API expects the current DOM image *source* URL.
    # Our checkpoint key is intentionally a durable local ordinal instead of
    # an ephemeral blob UUID. Translate just at this adapter boundary, keeping
    # the bridge's exact-current-source anti-reorder check unchanged.
    if not hasattr(page, '_mhr_original_recover_image'):
        page._mhr_original_recover_image = page.recover_unloaded_image

    def recover_verified_ordinal(key, virtual_url, **options):
        ordinal = _exact_ordinal(str(virtual_url), slug) if virtual_url else str(key)
        if str(key) != ordinal:
            raise RuntimeError('Image recovery ordinal does not match checkpoint identity')
        snapshot = custom_page_snapshot(page)
        current = next((im for im in snapshot['imgs'] if im['key'] == ordinal), None)
        if current is None:
            raise RuntimeError('Recovery ordinal is absent from the current reader')
        actual = _ACTIVE['blobs'].get(ordinal) if current['loaded'] else ''
        return page._mhr_original_recover_image(ordinal, actual or '', **options)

    page.recover_unloaded_image = recover_verified_ordinal


def custom_page_snapshot(page):
    slug = _chapter_slug(page.url)
    if _ACTIVE['chapter'] != slug:
        raise RuntimeError('Image snapshot requested before binding the expected chapter')
    # The existing BridgePage.evaluate routes this source-neutral DOM scan to
    # its already installed snapshot action, with READER_SELECTORS supplied
    # from THIS adapter. Native Playwright uses the equivalent DOM expression.
    result = page.evaluate('''() => { /* MutationObserver - reader DOM snapshot */
      const root=document.querySelector('#imagesList');
      if(!root) return {imgs:[],total:0,missingSlots:0,unloadedSlots:0,
        readerCount:0,scrollY:scrollY||0,bottom:0,viewportHeight:innerHeight};
      const imgs=[...root.querySelectorAll('.image-page[data-page] img.reading-image')]
        .map(im=>{
          const rect=im.getBoundingClientRect();
          return {key:im.closest('[data-page]').getAttribute('data-page'),
            url:im.currentSrc||im.getAttribute('src')||'',
            loaded:!!(im.complete && im.naturalWidth>0 && im.naturalHeight>0),
            width:im.naturalWidth||0,height:im.naturalHeight||0,
            pageY:rect.top+scrollY};
        });
      const height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
      return {imgs,total:imgs.length,readerCount:imgs.length,
        missingSlots:imgs.filter(x=>!x.url).length,
        unloadedSlots:imgs.filter(x=>!x.loaded).length,
        scrollY:scrollY||0,bottom:Math.max(0,height-innerHeight),
        viewportHeight:innerHeight,height,revision:0};
    }''')
    if not isinstance(result, dict):
        raise RuntimeError('Selected reader returned no structured DOM image snapshot')
    images = result.get('imgs') or []
    if not images:
        raise RuntimeError('No #imagesList image slots in selected chapter; do not archive a blank/challenge page')
    if not isinstance(images, list):
        raise RuntimeError('Reader image slots are not a list')
    converted = []
    new_blobs = {}
    for index, node in enumerate(images, 1):
        key = str(node.get('key', '')).strip()
        # The captured reader uses contiguous data-page ordinals starting at 1.
        if not _PAGE_INDEX.fullmatch(key) or int(key) != index:
            raise RuntimeError('Reader panel data-page numbering changed or was reordered')
        loaded = node.get('loaded') is True and int(node.get('width') or 0) > 0 and int(node.get('height') or 0) > 0
        source = str(node.get('url') or '').strip()
        virtual_url = ''
        if loaded:
            if not source.startswith(_BLOB_PREFIX):
                raise RuntimeError('Decoded panel is not a proven same-origin blob; no unverified CDN fallback')
            new_blobs[key] = source
            virtual_url = _local_image_url(slug, key)
        converted.append({'key':key, 'url':virtual_url, 'loaded':loaded,
                          'width':int(node.get('width') or 0),
                          'height':int(node.get('height') or 0),
                          'pageY':float(node.get('pageY') or 0)})
    # Update only observed decoded slots. Browser-created blob UUIDs can change
    # during lazy loading, without changing the persistent chapter+panel identity.
    _ACTIVE['blobs'].update(new_blobs)
    return {**result, 'imgs':converted, 'total':len(converted),
            'readerCount':len(converted),
            'missingSlots':sum(not im['url'] for im in converted),
            'unloadedSlots':sum(not im['loaded'] for im in converted)}
