"""Toonily / Breakaway : Joys of Travel — source switch, same archive identity.

Source-specific URL rules, native catalog and reader container are derived from
all three DOM/HTML snapshots in the 2026-11-28 Toonily runtime capture.
Keep the existing Toonily-scoped database shown in the current runtime log.
Chapters 1–8 and partial chapter 9 checkpoints remain authoritative; no new
archive recovery or source migration is needed. Same series slug and title.
"""
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
# === END PERMANENT ADAPTER CONTRACT ===

import re
from decimal import Decimal
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'toonily-breakaway-joys-of-travel'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'toonily-breakaway-native-div-options-v1'
SERIES_SLUG_HINT = 'breakaway-joys-of-travel'
_SERIES_TITLE = 'Breakaway : Joys of Travel'
_BASE = 'https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/'
DEFAULT_START_URL = _BASE + 'chapter-3/'
ALLOWED_HOSTS = ('toonily.com',)
BRIDGE_IMAGE_HOSTS = ('data.tnlycdn.com',)
EXTENSION_MATCHES = ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/*',)
TITLE_SELECTORS = ('h1', 'meta[property="og:title"]')
CHAPTER_LIST_SELECTORS = ()  # Native options are DIVs, not anchors.
NEXT_NAV_SELECTORS = ('a.next_page[href]',)
PREV_NAV_SELECTORS = ('a.prev_page[href]',)
CHAPTER_MENU_SELECTORS = ('.chapter-trigger',)
READER_SELECTORS = ('.reading-content',)
PAGE_TOTAL_SELECTORS = ('.reading-content .page-break > img.wp-manga-chapter-img',)
IMAGE_ATTRIBUTES = ('data-src', 'data-original', 'data-lazy-src', 'src')
IMAGE_PLACEHOLDER_URL_MARKERS = ('/wp-content/assets/999.png',)
SOURCE_CONFIRMED_MISSING_PANELS = {}
ARCHIVED_SOURCE_CHAPTER_COUNT = 131
# Exact URLs observed in both native chapter menus; never synthesize a URL.
_CAPTURED_CATALOG = (
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-1/', 'Chapter 1'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-2/', 'Chapter 2'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-3/', 'Chapter 3'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-4/', 'Chapter 4'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-5/', 'Chapter 5'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-6/', 'Chapter 6'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-7/', 'Chapter 7'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-8/', 'Chapter 8'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-9/', 'Chapter 9'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-10/', 'Chapter 10'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-11/', 'Chapter 11'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-12/', 'Chapter 12'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-13/', 'Chapter 13'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-14/', 'Chapter 14'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-15/', 'Chapter 15'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-16/', 'Chapter 16'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-17/', 'Chapter 17'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-18/', 'Chapter 18'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-19/', 'Chapter 19'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-20/', 'Chapter 20'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-21/', 'Chapter 21'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-22/', 'Chapter 22'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-23/', 'Chapter 23'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-24/', 'Chapter 24'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-25/', 'Chapter 25'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-26/', 'Chapter 26'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-27/', 'Chapter 27'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-28/', 'Chapter 28'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-29/', 'Chapter 29'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-30/', 'Chapter 30'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-31/', 'Chapter 31'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-32/', 'Chapter 32'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-33/', 'Chapter 33'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-34/', 'Chapter 34'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-35/', 'Chapter 35'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-36/', 'Chapter 36'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-37/', 'Chapter 37'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-38/', 'Chapter 38'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-39/', 'Chapter 39'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-40/', 'Chapter 40'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-41/', 'Chapter 41'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-42/', 'Chapter 42'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-43/', 'Chapter 43'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-44/', 'Chapter 44'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-45/', 'Chapter 45'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-46/', 'Chapter 46'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-47/', 'Chapter 47'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-48/', 'Chapter 48'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-49/', 'Chapter 49'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-50/', 'Chapter 50'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-51/', 'Chapter 51'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-52/', 'Chapter 52'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-53/', 'Chapter 53'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-54/', 'Chapter 54'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-55/', 'Chapter 55'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-56/', 'Chapter 56'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-57/', 'Chapter 57'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-58/', 'Chapter 58'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-59/', 'Chapter 59'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-60/', 'Chapter 60'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-61/', 'Chapter 61'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-62/', 'Chapter 62'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-63/', 'Chapter 63'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-64/', 'Chapter 64'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-65/', 'Chapter 65'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-66/', 'Chapter 66'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-67/', 'Chapter 67'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-68/', 'Chapter 68'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-69/', 'Chapter 69'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-70/', 'Chapter 70'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-71/', 'Chapter 71'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-72/', 'Chapter 72'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-73/', 'Chapter 73'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-74/', 'Chapter 74'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-75/', 'Chapter 75'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-76/', 'Chapter 76'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-77/', 'Chapter 77'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-78/', 'Chapter 78'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-79/', 'Chapter 79'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-80/', 'Chapter 80'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-81/', 'Chapter 81'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-82/', 'Chapter 82'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-83/', 'Chapter 83'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-84/', 'Chapter 84'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-85/', 'Chapter 85'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-86/', 'Chapter 86'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-87/', 'Chapter 87'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-88/', 'Chapter 88'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-89/', 'Chapter 89'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-90/', 'Chapter 90'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-91/', 'Chapter 91'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-92/', 'Chapter 92'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-93/', 'Chapter 93'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-94/', 'Chapter 94'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-95/', 'Chapter 95'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-96/', 'Chapter 96'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-97/', 'Chapter 97'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-98/', 'Chapter 98'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-99/', 'Chapter 99'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-100/', 'Chapter 100'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-101/', 'Chapter 101'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-102/', 'Chapter 102'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-103/', 'Chapter 103'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-104/', 'Chapter 104'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-105/', 'Chapter 105'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-106/', 'Chapter 106'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-107/', 'Chapter 107'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-108/', 'Chapter 108'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-109/', 'Chapter 109'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-110/', 'Chapter 110'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-111/', 'Chapter 111'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-112/', 'Chapter 112'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-113/', 'Chapter 113'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-114/', 'Chapter 114'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-115/', 'Chapter 115'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-116/', 'Chapter 116'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-117/', 'Chapter 117'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-118/', 'Chapter 118'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-119/', 'Chapter 119'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-120/', 'Chapter 120'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-121/', 'Chapter 121'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-122/', 'Chapter 122'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-123/', 'Chapter 123'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-124/', 'Chapter 124'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-125/', 'Chapter 125'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-126/', 'Chapter 126'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-127/', 'Chapter 127'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-128/', 'Chapter 128'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-129/', 'Chapter 129'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-130/', 'Chapter 130'),
    ('https://toonily.com/serie/breakaway-joys-of-travel-f99c6f14/chapter-131/', 'Chapter 131 - The End'),
)

_CHAPTER_PATH = re.compile(r'/serie/breakaway-joys-of-travel-f99c6f14/chapter-(\d+(?:[.-]\d+)?)(?:-end)?/?$', re.I)


def _chapter_url(raw, base=DEFAULT_START_URL):
    u = urlsplit(urljoin(base, str(raw or '').strip()))
    if (u.scheme != 'https' or u.netloc != 'toonily.com' or u.query or u.fragment
            or not _CHAPTER_PATH.fullmatch(u.path)):
        return None
    return 'https://toonily.com' + u.path.rstrip('/') + '/'


def chapter_identity(anchor, url, label):
    clean = _chapter_url(url)
    if not clean:
        raise ValueError('Not a native Toonily Breakaway chapter URL: ' + str(url))
    return _CHAPTER_PATH.fullmatch(urlsplit(clean).path).group(1).replace('-', '.')


def series_slug_from_url(url):
    return SERIES_SLUG_HINT if _chapter_url(url) or str(url).rstrip('/') == _BASE.rstrip('/') else None


def title_from_html(soup):
    h = soup.select_one('h1')
    og = soup.select_one('meta[property="og:title"]')
    for text in (h.get_text(' ', strip=True) if h else '', og.get('content','') if og else ''):
        if re.match(r'^Breakaway\s*:\s*Joys of Travel(?:\s|$)', text, re.I):
            return _SERIES_TITLE
    return None


def _label(ident, native):
    # Keep the existing archive's capitalization and chapter title convention.
    if ident == '131' and re.fullmatch(r'Chapter\s+131\s*[-–—]\s*(?:The\s+)?End', native, re.I):
        return 'Chapter 131 - END'
    return native


def _native_catalog(raw_html, page_url):
    soup = BeautifulSoup(raw_html, 'html.parser')
    menus = []
    for menu in soup.select('.chapter-options'):
        options = menu.select('.chapter-option[data-redirect]')
        if not options:
            continue
        found = {}
        for opt in options:
            url = _chapter_url(opt.get('data-redirect'), page_url)
            if not url:
                raise RuntimeError('Unexpected native chapter option; refusing to omit it')
            ident = chapter_identity(opt, url, '')
            label = opt.get_text(' ', strip=True)
            if not re.match(r'^Chapter\s+' + re.escape(ident) + r'(?:\s|$)', label, re.I) or ident in found:
                raise RuntimeError('Invalid or duplicate native chapter option: ' + ident)
            found[ident] = (url, _label(ident, label))
        menus.append(found)
    if not menus:
        return ()
    if any(menu != menus[0] for menu in menus[1:]):
        raise RuntimeError('Native chapter menus disagree; refusing incomplete discovery')
    return tuple(menus[0][k] for k in sorted(menus[0], key=Decimal))


def _reader_images(soup):
    root = soup.select_one('.reading-content')
    if not root:
        return []
    # The Discord banner image-999 and related thumbnails are outside this root.
    # Scanner uses this exact root; do not silently filter unexpected children.
    return root.select('img:not(noscript img)')


def _catalog(raw_html, page_url):
    current = _chapter_url(page_url)
    soup = BeautifulSoup(raw_html, 'html.parser')
    if not current or title_from_html(soup) != _SERIES_TITLE or not _reader_images(soup):
        raise RuntimeError('Expected Toonily Breakaway reader not found; no catalog inferred')
    required = {chapter_identity(None,u,l):(u,_label(chapter_identity(None,u,l),l)) for u,l in _CAPTURED_CATALOG}
    native = _native_catalog(raw_html, page_url)
    if native:
        observed = {chapter_identity(None,u,l):(u,l) for u,l in native}
        if not required.keys() <= observed.keys():
            missing = sorted(required.keys()-observed.keys(), key=Decimal)
            raise RuntimeError('Live catalog omits captured chapters: ' + ', '.join(missing))
        if current not in {u for u,l in native}:
            raise RuntimeError('Active reader URL not in native menu')
        return native
    # Only use captured exact options when the live reader and its native
    # neighboring links independently corroborate this source and position.
    exact = tuple(required.values())
    urls = [u for u,l in exact]
    if current not in urls:
        raise RuntimeError('No live menu and current chapter is not in captured catalog')
    i = urls.index(current)
    for selector, j in ((NEXT_NAV_SELECTORS[0], i+1), (PREV_NAV_SELECTORS[0], i-1)):
        if 0 <= j < len(urls):
            links = {_chapter_url(a.get('href'),page_url) for a in soup.select(selector)}
            if links != {urls[j]}:
                raise RuntimeError('No live menu and captured neighbor not corroborated')
    print('Toonily: using exact captured catalog corroborated by native navigation', flush=True)
    return exact


def custom_chapters(raw_html, page_url, chapter_class):
    return [chapter_class(chapter_identity(None,u,l),l,u) for u,l in _catalog(raw_html,page_url)]


def custom_browser_chapters(context, seed_url, seed_html, chapter_class, visit):
    chapters = custom_chapters(seed_html, seed_url, chapter_class)
    ids = {ch.chapter_id for ch in chapters}
    gaps = [str(n) for n in range(1,132) if str(n) not in ids]
    if gaps:
        raise RuntimeError('Captured complete catalog unexpectedly missing: '+', '.join(gaps))
    print('Toonily: native catalog '+str(len(chapters))+' chapters; chapters 31–39 included.',flush=True)
    return chapters


def chapter_title_from_anchor(anchor, fallback):
    return fallback


def chapter_title_from_html(soup, fallback):
    h = soup.select_one('h1')
    if h:
        match = re.match(r'^Breakaway\s*:\s*Joys of Travel\s*(?:[-–—]\s*)?(Chapter\s+.+)$',h.get_text(' ',strip=True),re.I)
        if match:
            title=match.group(1).strip()
            # Prefer the normalized catalog label when the heading has no subtitle.
            if re.fullmatch(r'Chapter\s+\d+(?:\.\d+)?',title,re.I):
                return fallback
            ident=re.match(r'Chapter\s+(\d+(?:\.\d+)?)',title,re.I)
            if ident:
                return _label(ident.group(1),title)
    return fallback


def title_catalog_url(saved_url):
    return DEFAULT_START_URL


def native_chapter_titles_from_catalog(raw_html,page_url):
    return {chapter_identity(None,u,l):l for u,l in _native_catalog(raw_html,page_url)}


def captured_native_chapter_titles():
    return {chapter_identity(None,u,l):_label(chapter_identity(None,u,l),l) for u,l in _CAPTURED_CATALOG}


def accept_catalog_title(chapter_id,title):
    # The existing ToonGod manifests for 1 and 2 are immutable for this switch.
    if str(chapter_id) in ('1','2'):
        return False
    m = re.match(r'^Chapter\s+(\d+(?:\.\d+)?)(?:\s|$)',str(title),re.I)
    return bool(m and m.group(1)==str(chapter_id))


def chapter_title_is_generic(label,chapter_id):
    return not bool(re.match(r'^Chapter\s+'+re.escape(str(chapter_id))+r'(?:\s|$)',str(label),re.I))


def after_chapter_visit(page,page_url):
    current = _chapter_url(page.url)
    if not current or current != _chapter_url(page_url):
        raise RuntimeError('Reader redirected away from the requested chapter')
    soup = BeautifulSoup(page.content(),'html.parser')
    images = _reader_images(soup)
    if title_from_html(soup) != _SERIES_TITLE or not images:
        raise RuntimeError('Expected Breakaway reader container absent')
    if any('wp-manga-chapter-img' not in (im.get('class') or []) for im in images):
        raise RuntimeError('Unexpected image inside chapter reader')
    ids = [im.get('id','') for im in images]
    if all(re.fullmatch(r'image-\d+',i) for i in ids):
        nums = [int(i.split('-')[-1]) for i in ids]
        if nums != list(range(nums[0], nums[0]+len(nums))) or nums[0] not in (0,1):
            raise RuntimeError('Nonconsecutive native panel DOM IDs')
    # The captured source uses ordinary HTTPS src, sometimes browser-native
    # lazy loading; do not change the page or require images already decoded.
    for im in images:
        for attr in IMAGE_ATTRIBUTES:
            value = str(im.get(attr) or '').strip()
            if not value or value.startswith(('data:','blob:','about:')):
                continue
            u = urlsplit(urljoin(page_url,value))
            if u.scheme != 'https' or u.hostname not in BRIDGE_IMAGE_HOSTS:
                raise RuntimeError('Unexpected chapter image origin: '+str(u.hostname))

# Optional console-script acquisition contract. Only this file knows the site.
# The script returns native browser download commands in exact DOM order; the
# generic Chrome download manager executes them with deterministic filenames.
CHAPTER_DOWNLOAD_TRANSPORT = 'loaded-resource'
CHAPTER_DOWNLOAD_JS = r"""(() => {
  const root = document.querySelector('.reading-content');
  if (!root) throw Error('Missing native chapter reader');
  const all = [...root.querySelectorAll('img')].filter(im => !im.closest('noscript,script'));
  if (!all.length || all.some(im => !im.matches('.page-break > img.wp-manga-chapter-img')))
    throw Error('Unexpected reader image structure');
  const first = Number((all[0].id.match(/^image-(\d+)$/)||[])[1]);
  if (![0,1].includes(first)) throw Error('Invalid native first image ID');
  const items = all.map((im,i) => {
    if (im.id !== 'image-'+(first+i)) throw Error('Nonconsecutive native image IDs');
    const raw = im.getAttribute('data-src') || im.getAttribute('data-original') || im.getAttribute('data-lazy-src') || im.getAttribute('src');
    const u = new URL(raw,location.href);
    if (u.protocol !== 'https:' || u.hostname !== 'data.tnlycdn.com' || !u.pathname.startsWith('/chapters/') || u.username || u.password || u.port)
      throw Error('Unexpected reader image URL');
    const ext = (u.pathname.match(/\.(jpg|jpeg|png|webp|gif|avif|bmp)$/i)||[])[1];
    if (!ext) throw Error('Unknown native image extension');
    return {key:String(i+1),order:i+1,url:u.href,filename:String(i+1).padStart(4,'0')+'.'+ext.toLowerCase(),
      width:im.complete?im.naturalWidth:0,height:im.complete?im.naturalHeight:0};
  });
  return {url:location.href,items,loaded:all.filter(im=>im.complete&&im.naturalWidth>0&&im.naturalHeight>0).length};
})()"""


def script_download_expected(raw_html, page_url):
    images = _reader_images(BeautifulSoup(raw_html,'html.parser'))
    result=[]
    for i,im in enumerate(images,1):
        raw=next((str(im.get(attr)).strip() for attr in IMAGE_ATTRIBUTES if im.get(attr)), '')
        result.append((str(i),urljoin(page_url,raw)))
    return result
