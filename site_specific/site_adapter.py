"""Single-site adapter for Annoying Alice on ToonGod (Madara/WordPress).

This is the ONLY file to replace for a new comic/source. All archiving,
resumption, repo rotation, GitHub verification, Cloudflare open-reader library
migration, viewer, credentials, throttling, and shutdown remain reusable.

The chapter HTML provided by the user contains a native 98-entry <select>
chapter list, including "Chapter 98 - The End", and reader images inside
.reading-content. Native URLs are read from option[data-redirect]; none are
invented by incrementing chapter numbers.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'  # Ordinary already-open Chrome/Firefox, no WebDriver.
BRIDGE_IMAGE_HOSTS = ('i.tngcdn.com',)  # Site-specific CDN; reusable bridge checks it.
SOURCE_NAME = 'toongod-annoying-alice'
STATE_STORAGE_MODE = 'scoped'
SERIES_SLUG_HINT = 'annoying-alice'
ARCHIVED_SOURCE_CHAPTER_COUNT = 98  # Verified in supplied Chapter 1 HTML.
TITLE_ADAPTER_VERSION = '1'
DEFAULT_START_URL = 'https://www.toongod.org/webtoon/annoying-alice/chapter-1/'
ALLOWED_HOSTS = ('www.toongod.org', 'toongod.org')
EXTENSION_MATCHES = (
    'https://www.toongod.org/webtoon/annoying-alice/*',
    'https://toongod.org/webtoon/annoying-alice/*',
)
TITLE_SELECTORS = ('#chapter-heading', '.c-breadcrumb a[href$="/annoying-alice/"]')

# Madara's complete native chapter list is <select><option data-redirect=...>,
# NOT a[href]. The reusable engine handles anchors through chapter_links();
# leave these selectors unmatched to enable its documented custom_chapters hook
# without mistaking the Next link for the entire comic's chapter catalog.
CHAPTER_LIST_SELECTORS = ('a[data-comic-archive-chapter-list][href]',)
NEXT_NAV_SELECTORS = ('a[data-comic-archive-discovery-next][href]',)
PREV_NAV_SELECTORS = ('a[data-comic-archive-discovery-prev][href]',)
CHAPTER_MENU_SELECTORS = ('button[data-comic-archive-chapter-popup]',)

READER_SELECTORS = ('.reading-content', '.page-break')
IMAGE_ATTRIBUTES = ('data-src', 'data-original', 'data-lazy-src', 'src')
PAGE_TOTAL_SELECTORS = ('.reading-content img.wp-manga-chapter-img',)

_CHAPTER_PATH = re.compile(r'^/webtoon/annoying-alice/chapter-(\d+)(?:-[a-z0-9-]+)?/?$', re.I)
_TITLE_FROM_HEADING = re.compile(r'^(.+?)\s*[-–—]\s*Chapter\s*\d+\b', re.I)
_TITLE_FROM_LABEL = re.compile(r'^Chapter\s*(\d+)(?:\s*[-–—:]\s*.+)?$', re.I)


def title_from_html(soup) -> str | None:
    """Obtain the series title, not the current chapter's full page title."""
    heading = soup.select_one('#chapter-heading')
    if heading:
        m = _TITLE_FROM_HEADING.match(heading.get_text(' ', strip=True))
        if m:
            return m.group(1).strip()
    series = soup.select_one('.c-breadcrumb a[href$="/annoying-alice/"]')
    if series:
        title = series.get_text(' ', strip=True)
        if title:
            return title
    canonical = soup.select_one('link[rel="canonical"][href]')
    if canonical and '/webtoon/annoying-alice/' in canonical.get('href', ''):
        return 'Annoying Alice'
    return None


def chapter_identity(anchor, url: str, label: str) -> str:
    """Identity is the source's native URL chapter number, not list position."""
    for candidate in (anchor.get('data-redirect', ''), anchor.get('href', ''), url):
        match = _CHAPTER_PATH.match(urlsplit(str(candidate or '')).path)
        if match:
            return str(int(match.group(1)))
    text = str(label or '').strip()
    match = _TITLE_FROM_LABEL.match(text)
    return str(int(match.group(1))) if match else (text or urlsplit(url).path)


def _native_options(raw_html: str, page_url: str) -> list[tuple[str, str, str]]:
    """Read the ORIGINAL select's URLs and titles; reject unrelated entries."""
    soup = BeautifulSoup(raw_html, 'html.parser')
    choices = soup.select('select.single-chapter-select')
    if not choices:
        return []
    # The chapter selector appears three times (header, footer, sticky bar).
    # Use ONE complete native list, never duplicate chapters.
    native = max(choices, key=lambda element: len(element.select('option[data-redirect]')))
    by_num: dict[int, tuple[str, str, str]] = {}
    seed_host = urlsplit(page_url).hostname
    for option in native.select('option[data-redirect]'):
        candidate = urljoin(page_url, (option.get('data-redirect') or '').strip())
        parts = urlsplit(candidate)
        match = _CHAPTER_PATH.match(parts.path)
        if not match or parts.scheme != 'https' or parts.hostname != seed_host:
            continue
        num = int(match.group(1))
        if num < 1:
            continue
        title = ' '.join(option.get_text(' ', strip=True).split())
        if not title:
            continue
        number_in_title = _TITLE_FROM_LABEL.match(title)
        if not number_in_title or int(number_in_title.group(1)) != num:
            # Never silently attribute another chapter's title to this URL.
            continue
        entry = (str(num), title, candidate)
        if num in by_num and by_num[num] != entry:
            raise RuntimeError('Conflicting source chapter URLs or titles for chapter ' + str(num))
        by_num[num] = entry
    return [by_num[k] for k in sorted(by_num)]


def custom_chapters(raw_html, current_url, chapter_class):
    """Turn Madara's native option[data-redirect] into generic Chapter entries.

    This hook is the only site-dependent traversal code. It refuses to mark
    a partial or unverified catalog as complete. The reusable engine archives
    in the supplied chronological order and resumes from its own database.
    """
    rows = _native_options(raw_html, current_url)
    numbers = [int(chapter_id) for chapter_id, _, _ in rows]
    if (not numbers or len(numbers) < ARCHIVED_SOURCE_CHAPTER_COUNT or
            numbers != list(range(1, max(numbers) + 1))):
        raise RuntimeError('Annoying Alice native chapter catalog incomplete; '
                           'expected at least 98 consecutive chapters from the site dropdown. '
                           'Reopen the source in a normal browser and retry.')
    return [chapter_class(chapter_id, label, url) for chapter_id, label, url in rows]


def chapter_title_from_anchor(anchor, fallback: str) -> str:
    return ' '.join(anchor.get_text(' ', strip=True).split()) or fallback


def chapter_title_from_html(soup, fallback: str) -> str:
    """Use the real chapter heading when it is at least as descriptive.

    The source's short chapter heading must not overwrite a richer native
    dropdown title (e.g. "Chapter 98 - The End").
    """
    heading = soup.select_one('#chapter-heading')
    if not heading:
        return fallback
    full = ' '.join(heading.get_text(' ', strip=True).split())
    match = re.search(r'\b(Chapter\s*\d+(?:\s*[-–—:]\s*.+)?)$', full, re.I)
    candidate = match.group(1).strip() if match else ''
    return candidate if candidate and len(candidate) > len(fallback or '') else fallback


def native_chapter_titles_from_catalog(raw_html: str, page_url: str) -> dict[str, str]:
    """Metadata-only title repair: no images, scrolling, or guessed titles."""
    return {chapter_id: title for chapter_id, title, _ in _native_options(raw_html, page_url)}


def title_catalog_url(saved_url: str) -> str:
    # A native selector exists on Chapter 1, avoiding additional chapter visits.
    return DEFAULT_START_URL


def accept_catalog_title(chapter_id: str, title: str) -> bool:
    match = _TITLE_FROM_LABEL.match(title.strip())
    return bool(match and chapter_id.isdigit() and
                int(match.group(1)) == int(chapter_id))


def chapter_title_is_generic(label: str, chapter_id: str) -> bool:
    # "Chapter 1" is itself the actual published title, not a missing subtitle.
    return bool(re.fullmatch(r'\s*Chapter\s*' + re.escape(str(chapter_id)) + r'\s*', label, re.I))


def custom_page_snapshot(page):
    """Site-only image detection, ignoring adverts, logos, and comment avatars.

    ToonGod's HTML prepends whitespace to data-src, which must be stripped.
    The reusable lazy-scroll algorithm still controls scroll, completeness,
    rate limiting, and downloads. This hook only describes reader DOM state.
    """
    return page.evaluate(r"""() => {
      const root=document.querySelector('.reading-content');
      if(!root)return {imgs:[],total:0,readerCount:0,missingSlots:0,
        scrollY:window.scrollY||0,bottom:0,height:0,revision:0};
      let state=window.__comicAnnoyingAliceSnapshot;
      if(!state || state.root!==root){
        if(state?.observer)state.observer.disconnect();
        state={root,revision:0};
        state.observer=new MutationObserver(mutations=>{
          if(mutations.length)state.revision++;
        });
        state.observer.observe(root,{subtree:true,childList:true,attributes:true,
          attributeFilter:['src','data-src','data-original','data-lazy-src']});
        window.__comicAnnoyingAliceSnapshot=state;
      }
      const nodes=[...root.querySelectorAll('img.wp-manga-chapter-img')];
      let missingSlots=0;
      const imgs=nodes.map((im,i)=>{
        const candidates=['data-src','data-original','data-lazy-src','src']
          .map(a=>(im.getAttribute(a)||'').trim());
        candidates.push((im.currentSrc||'').trim());
        const url=candidates.find(s=>s && !s.startsWith('data:') &&
          !s.startsWith('blob:') && !s.startsWith('about:'))||'';
        if(!url)missingSlots++;
        return {key:String(i+1),url,width:im.naturalWidth||0,
          height:im.naturalHeight||0};
      });
      const html=document.documentElement,body=document.body;
      const height=Math.max(html.scrollHeight,body?.scrollHeight||0);
      return {imgs,total:nodes.length,readerCount:nodes.length,missingSlots,
        scrollY:window.scrollY||html.scrollTop||0,
        bottom:Math.max(0,height-window.innerHeight),height,revision:state.revision};
    }""")


# ComicArchiver explicit human-verified source-image exceptions (1.5.16)
SOURCE_CONFIRMED_MISSING_PANELS = {
    **globals().get('SOURCE_CONFIRMED_MISSING_PANELS', {}),
    'https://www.toongod.org/webtoon/annoying-alice/chapter-82/': (56, 57),
}
