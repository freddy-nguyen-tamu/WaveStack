"""Tritinia Scans / We May Be an Inexperienced Couple but…

All source-specific behavior lives here. The original HTML contains chapter
options for every volume, even the ones hidden by the volume picker. Never
fabricate chapter URLs by incrementing a chapter number.
"""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from PIL import Image
from pathlib import Path
import json

SOURCE_BROWSER_TRANSPORT = 'extension'  # Reuse ordinary Chrome and Comic Bridge.
SOURCE_NAME = 'tritinia-inexperienced-couple'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = '1'
SERIES_SLUG_HINT = 'we-may-be-an-inexperienced-couple-but'
ARCHIVED_SOURCE_CHAPTER_COUNT = 140  # Minimum verified from supplied HTML.
DEFAULT_START_URL = (
    'https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-1/'
)
_BASE_PATH = '/manga/we-may-be-an-inexperienced-couple-but/'
ALLOWED_HOSTS = ('tritinia.org',)
# Exclude injected adverts and badge images: only numbered native panels count.
# All sampled panel URLs are same-origin; no extra advertising hosts are granted.
BRIDGE_IMAGE_HOSTS = ('tritinia.org',)  # The 33 real panels use this origin.
EXTENSION_MATCHES = ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/*',)
TITLE_SELECTORS = (
    '.c-breadcrumb a[href*="/manga/"]',
    '.breadcrumb a[href*="/manga/"]',
)
# Native chapter choices are <option data-redirect>, not <a href>. The
# generic anchor-only discovery must defer to custom_chapters() below.
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
READER_SELECTORS = ('.reading-content',)
PAGE_TOTAL_SELECTORS = ('.reading-content .page-break > img[id]',
                        '.reading-content .page-break > picture > img[id]',
                        '.reading-content .page-break img[id]')
IMAGE_ATTRIBUTES = ('data-src', 'data-original', 'data-lazy-src', 'src')
IMAGE_PLACEHOLDER_URL_MARKERS = ('/images/refresh.png',)
SOURCE_CONFIRMED_MISSING_PANELS = {}

# ADAPTIVE_PICTURE_SOURCE_SELECTION_V1
# Do not special-case one chapter or suffix. Every <picture> panel advertises
# fallback/source URLs; prefer a declared URL that the installed Pillow can
# decode AND the generic engine can archive. Source-specific host restrictions
# remain enforced by the existing bridge/engine.
_ARCHIVABLE_PICTURE_FORMATS = frozenset(('JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF', 'BMP'))
_SUPPORTED_PICTURE_SUFFIXES = frozenset(
    suffix.lower() for suffix, fmt in Image.registered_extensions().items()
    if fmt.upper() in _ARCHIVABLE_PICTURE_FORMATS
)


def _declared_picture_sources(img, base_url):
    """Return only actual URLs declared by this one native picture, in order.

    Handles image src and lazy attributes, img/srcset, <source>/srcset and
    srcset density descriptors; never guesses a nearby file or host.
    """
    values = []
    for attr in ('data-src', 'src', 'data-original', 'data-lazy-src'):
        raw = str(img.get(attr) or '').strip()
        if raw:
            values.append(raw)
    def parse_srcset(value):
        # Native srcsets on this provider contain URLs and optional 1x/2x or
        # width descriptors. Ignore data URIs and malformed candidates.
        for item in str(value or '').split(','):
            fields = item.strip().split()
            if fields:
                values.append(fields[0])
    parse_srcset(img.get('srcset'))
    picture = img.parent if getattr(img.parent, 'name', None) == 'picture' else None
    if picture is not None:
        for source in picture.find_all('source', recursive=False):
            parse_srcset(source.get('srcset'))
            raw = str(source.get('src') or '').strip()
            if raw:
                values.append(raw)
    results = []
    for raw in values:
        if raw.lower().startswith(('data:', 'blob:', 'about:', 'javascript:')):
            continue
        absolute = urljoin(base_url, raw)
        parsed = urlsplit(absolute)
        if parsed.scheme != 'https' or parsed.hostname not in set(ALLOWED_HOSTS) | set(BRIDGE_IMAGE_HOSTS):
            continue
        if any(marker in absolute for marker in IMAGE_PLACEHOLDER_URL_MARKERS):
            continue
        if absolute not in results:
            results.append(absolute)
    return tuple(results)


def _picture_decodable_fallback(declared):
    """Pick a same-panel fallback by actual local decoder availability.

    Favors the native img's own normal URL because it generally represents the
    same art at full native resolution. Source-only alternatives are permitted
    only when their exact URL occurs in this picture's declared srcset.
    """
    for absolute in declared:
        if Path(urlsplit(absolute).path).suffix.lower() in _SUPPORTED_PICTURE_SUFFIXES:
            return absolute
    return ''


def _chapter_path(url: str):
    parts = urlsplit(url).path.strip('/').split('/')
    if len(parts) != 4 or parts[:2] != ['manga', SERIES_SLUG_HINT] or \
            not re.fullmatch(r'volume-\d+', parts[2]) or \
            not re.fullmatch(r'[a-z0-9][a-z0-9-]*', parts[3]):
        return None
    return int(parts[2][len('volume-'):]), parts[3]


def _chapter_id(url: str) -> str:
    value = _chapter_path(url)
    if value is None:
        raise ValueError('Not a native chapter URL for this series: ' + url)
    volume, slug = value
    # A path slug alone can collide after file-name truncation. The digest
    # distinguishes alternate edits and same-number fractional chapters.
    digest = hashlib.sha256(urlsplit(url).path.encode('utf-8')).hexdigest()[:8]
    return f'v{volume:02d}-{slug[:25]}-{digest}'


def chapter_identity(anchor, url: str, label: str) -> str:
    return _chapter_id(url)


def title_from_html(soup) -> str | None:
    heading = soup.title.get_text(' ', strip=True) if soup.title else ''
    if ' - Ch.' in heading:
        return heading.split(' - Ch.', 1)[0].strip()
    for selector in TITLE_SELECTORS:
        for a in soup.select(selector):
            if '/manga/' in (a.get('href') or ''):
                title = ' '.join(a.get_text(' ', strip=True).split())
                if title:
                    return title
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    if ' - Ch.' in title:
        return title.split(' - Ch.', 1)[0].strip()
    return None


def chapter_title_from_anchor(anchor, fallback: str) -> str:
    return fallback


def chapter_title_from_html(soup, fallback: str) -> str:
    for selector in ('.c-breadcrumb li:last-child', '.breadcrumb li:last-child'):
        el = soup.select_one(selector)
        if el:
            native = ' '.join(el.get_text(' ', strip=True).split())
            if native and len(native) > len(fallback) and re.search(r'\bCh\.?\s*\d', native, re.I):
                return native
    return fallback


def native_chapter_titles_from_catalog(raw_html: str, page_url: str) -> dict[str, str]:
    """Use native choice text; individual chapter pages provide longer titles."""
    try:
        chapters = custom_chapters(raw_html, page_url, _ChapterStub)
    except RuntimeError:
        return {}  # Metadata refresh must not turn a partial source page into titles.
    return {ch.chapter_id: ch.label for ch in chapters if not ch.label.endswith('...')}


class _ChapterStub:
    def __init__(self, chapter_id, label, url):
        self.chapter_id, self.label, self.url = chapter_id, label, url


def title_catalog_url(saved_url: str) -> str:
    return saved_url or DEFAULT_START_URL


def accept_catalog_title(chapter_id: str, title: str) -> bool:
    return bool(str(title).strip() and re.search(r'\bCh\.?\s*\d', str(title), re.I))


def chapter_title_is_generic(label: str, chapter_id: str) -> bool:
    return bool(re.fullmatch(r'(?:Vol\.?\s*\d+\s*)?Ch\.?\s*\d+(?:\.\d+)?', label.strip(), re.I))


def custom_chapters(raw_html: str, page_url: str, chapter_class):
    """Return exact native catalog in volume/reading order, with no URL guessing.

    Both top and bottom selectors repeat all sixteen volume lists. Dedupe by
    canonical URL, retaining intentional variants (e.g. two chapter-55 edits).
    """
    soup = BeautifulSoup(raw_html, 'html.parser')
    groups = soup.select('div.selectpicker_chapter[for^="volume-id-"]')
    if not groups:
        # Additive source-specific fallback; original parser below is unchanged.
        return _catalog_without_volume_wrappers(soup, page_url, chapter_class)
    seen, entries = set(), []
    for group in groups:
        opts = group.select('select.single-chapter-select option[data-redirect]')
        for opt in reversed(opts):  # Native lists are newest-to-oldest.
            url = urljoin(page_url, (opt.get('data-redirect') or '').strip())
            parts = urlsplit(url)
            if parts.scheme != 'https' or parts.netloc != 'tritinia.org' or \
                    _chapter_path(url) is None:
                continue
            clean = parts._replace(query='', fragment='').geturl()
            if clean in seen:
                continue
            seen.add(clean)
            volume, slug = _chapter_path(clean)
            label = ' '.join(opt.get_text(' ', strip=True).split())
            if not re.search(r'\bCh\.?\s*\d', label, re.I):
                # Avoid inventing a chapter label from a truncated URL.
                continue
            entries.append((volume, clean, label))
    # Verify the complete known catalog before considering discovery successful.
    # A partial JavaScript render or challenge page must NOT silently mark the
    # series complete and lose later chapters. Future additions are permitted.
    volumes = {vol for vol, _, _ in entries}
    if len(entries) < ARCHIVED_SOURCE_CHAPTER_COUNT or not set(range(1, 17)).issubset(volumes):
        raise RuntimeError(
            f'Tritinia chapter dropdown incomplete: {len(entries)} distinct chapters, '
            f'volumes {sorted(volumes)}; expected at least 140 over volumes 1-16')
    # Sort only by volume: options are newest-to-oldest inside each volume,
    # and reversal above preserves native fractional/alternate versions.
    entries.sort(key=lambda x: x[0])
    ids = [_chapter_id(url) for _, url, _ in entries]
    if len(ids) != len(set(ids)):
        raise RuntimeError('Tritinia chapter identities collide; stop before saving SQLite catalog')
    return [chapter_class(_chapter_id(url), label, url) for _, url, label in entries]


# The reader content can contain injected adverts and a "refresh" icon. The
# generic browser bridge sees all <img> descendants, but only images with a
# numeric native IMG id directly within .page-break, or nested one level
# inside its native <picture>, are manga panels here. Keep this site-specific
# filter here instead of hardcoding provider logic in the bridge.
_SNAPSHOT_JS = r'''() => {
  // MutationObserver compatibility: the generic extension maps this to SNAPSHOT.
  const root=document.querySelector('.reading-content');
  if (!root) throw new Error('Tritinia reading-content is absent');
  const nodes=[...root.querySelectorAll('.page-break > img[id], .page-break > picture > img[id], .page-break img[id]')]
    .filter(im => /^\d+$/.test(im.id))
    .filter(im => {
      const direct=im.parentElement?.classList.contains('page-break') ||
        (im.parentElement?.tagName==='PICTURE' && im.parentElement.parentElement?.classList.contains('page-break'));
      if(direct) return true; // preserve both historical paths
      const group=im.closest('.page-break');
      return group && [...group.querySelectorAll('img[id]')].filter(x=>/^\d+$/.test(x.id)).length===1;
    });
  if (!nodes.length) throw new Error('No native numbered manga images');
  const imgs=nodes.map((im,i) => {
    const r=im.getBoundingClientRect();
    const attrs=['data-src','data-original','data-lazy-src','src'];
    const urls=(im.naturalWidth>0 ? [im.currentSrc,...attrs.map(a=>im.getAttribute(a))] :
                [...attrs.map(a=>im.getAttribute(a)),im.currentSrc]);
    const selected=urls.find(x=>x&&!/^(data:|blob:|about:)/i.test(x))||'';
    const pictureUnloaded=im.parentElement?.tagName==='PICTURE' &&
      !(im.complete&&im.naturalWidth&&im.naturalHeight);
    // Reuse the declared img fallback for any locally decodable codec, not
    // merely JPEG. This is the Playwright branch; the extension branch
    // independently validates sources against cached native HTML below.
    const compatible=new Set(__SUPPORTED_PICTURE_SUFFIXES__);
    const supported=raw=>{try {
      if(!raw || /^(data:|blob:|about:|javascript:)/i.test(raw)) return false;
      const u=new URL(raw,location.href);
      return u.protocol==='https:' && compatible.has((u.pathname.match(/\.[^.\/]+$/)||[''])[0].toLowerCase());
    }catch{return false;}};
    const own=['data-src','src','data-original','data-lazy-src']
      .map(a=>im.getAttribute(a)).filter(Boolean);
    const srcset=(raw)=>String(raw||'').split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);
    const picture=im.parentElement?.tagName==='PICTURE'?im.parentElement:null;
    const alternatives=picture?[...picture.querySelectorAll('source')]
      .flatMap(s=>[...srcset(s.getAttribute('srcset')),s.getAttribute('src')].filter(Boolean)):[];
    const chosen=picture?[...own,...srcset(im.getAttribute('srcset')),...alternatives].find(supported)||'':'';
    return {key:String(i+1),url:pictureUnloaded?'':(chosen||selected),
      width:im.naturalWidth||0,height:im.naturalHeight||0,
      loaded:!!(im.complete&&im.naturalWidth&&im.naturalHeight),
      pageY:r.top+scrollY};
  });
  const height=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
  return {panelFilterApplied:true,imgs,total:imgs.length,readerCount:imgs.length,
    missingSlots:imgs.filter(x=>!x.url).length,
    unloadedSlots:imgs.filter(x=>!x.loaded).length,
    scrollY:window.scrollY||0,bottom:Math.max(0,height-innerHeight),
    viewportHeight:innerHeight,height,revision:0};
}'''
_SNAPSHOT_JS = _SNAPSHOT_JS.replace('__SUPPORTED_PICTURE_SUFFIXES__',
                                    json.dumps(sorted(_SUPPORTED_PICTURE_SUFFIXES)))
_PANEL_INDEX_CACHE = {}


def custom_page_snapshot(page):
    """Filter only native panels. Works in normal Playwright or Comic Bridge.

    In the extension, `evaluate` returns a generic snapshot regardless of the
    supplied JS. One HTML read per chapter gives the panel DOM positions so the
    ad/refresh images can be excluded without modifying bridge infrastructure.
    """
    raw = page.evaluate(_SNAPSHOT_JS)
    if not isinstance(raw, dict):
        raise RuntimeError('Invalid source reader snapshot')
    if raw.get('panelFilterApplied') is True:
        return raw
    key = (id(page), page.url)
    if key not in _PANEL_INDEX_CACHE or len(raw.get('imgs', ())) != _PANEL_INDEX_CACHE[key][0]:
        soup = BeautifulSoup(page.content(), 'html.parser')
        root = soup.select_one('.reading-content')
        if root is None:
            raise RuntimeError('Tritinia reading-content missing from source DOM')
        all_imgs = root.select('img')
        # Preserve the working direct-child rule, and append support for
        # native panels wrapped in <picture>. Both require numeric IMG IDs
        # inside .page-break; advertisements and <source> tags are excluded.
        indices = [i for i, im in enumerate(all_imgs) if
                   im.parent is not None and
                   re.fullmatch(r'\d+', str(im.get('id', ''))) and
                   ('page-break' in im.parent.get('class', ()) or
                    (im.parent.name == 'picture' and
                     im.parent.parent is not None and
                     'page-break' in im.parent.parent.get('class', ())) or
                    (lambda group: bool(group and len([
                        node for node in group.select('img[id]')
                        if re.fullmatch(r'\d+', str(node.get('id', '')))
                    ]) == 1))(im.find_parent(class_='page-break')))]
        if not indices:
            raise RuntimeError('No numbered manga panels found (refusing to save advert images)')
        native_ids = [str(all_imgs[i].get('id')) for i in indices]
        if len(set(native_ids)) != len(native_ids):
            raise RuntimeError('Duplicate native page IDs: cannot guarantee DOM reading order')
        # Preserve native ordinal only if the first N nodes remain aligned.
        # Dynamic ad insertions are detected by identity verification below.
        urls = [str(all_imgs[i].get('data-src') or all_imgs[i].get('src') or '').strip() for i in indices]
        # Cache everything needed for repeated scans; NEVER reference the
        # temporary all_imgs outside this branch (the prior crash).
        picture_details = []
        for position in indices:
            node = all_imgs[position]
            is_picture = getattr(node.parent, 'name', None) == 'picture'
            declared = _declared_picture_sources(node, page.url) if is_picture else ()
            fallback = _picture_decodable_fallback(declared) if is_picture else ''
            picture_details.append((is_picture, frozenset(declared), fallback))
        _PANEL_INDEX_CACHE[key] = (len(all_imgs), indices, urls, picture_details)
    expected_count, indices, urls, picture_details = _PANEL_INDEX_CACHE[key]
    images = raw.get('imgs', [])
    if len(images) != expected_count:
        raise RuntimeError('Reader DOM count changed while scanning; retry chapter before saving files')
    chosen = []
    for ordinal, (position, native_url) in enumerate(zip(indices, urls), start=1):
        img = dict(images[position])
        is_picture, declared, compatible_fallback = picture_details[ordinal-1]
        # Direct IMG panels continue down the original, strict URL path.
        # Picture panels wait for the browser to actually decode something:
        # their currentSrc may initially point to an unloaded placeholder.
        if is_picture and not img.get('loaded'):
            img['url'] = ''
        observed = str(img.get('url', '')).strip()
        if native_url and observed and urljoin(page.url, native_url) != urljoin(page.url, observed):
            if not is_picture or urljoin(page.url, observed) not in declared:
                raise RuntimeError('Reader image order/URL changed; refusing to archive a wrong panel')
        if is_picture and img.get('loaded') and compatible_fallback:
            # This URL was genuinely declared by the SAME picture, and its
            # suffix has an installed decoder. No MIME guessing, URL rewriting,
            # cross-panel substitution or automatic bypass of image validation.
            img['url'] = compatible_fallback
        # Preserve the generic bridge DOM-index key for its target-recovery API.
        # The known source HTML has all manga panels first, with ads afterward.
        if str(img.get('key')) != str(ordinal):
            raise RuntimeError('Injected image changed native panel ordinals; cannot safely capture')
        chosen.append(img)
    return {**raw, 'imgs':chosen, 'total':len(chosen), 'readerCount':len(chosen),
            'missingSlots':sum(not p.get('url') for p in chosen),
            'unloadedSlots':sum(not p.get('loaded') for p in chosen)}


# Additional Tritinia fallback: this exact 140-entry native catalog was extracted
# from the user-supplied original chapter HTML (16 volumes, 280 duplicated
# dropdown options). It is not a computed/chapter-number URL sequence. The
# normal live dropdown parser above ALWAYS takes precedence. This snapshot is
# used only when a functioning reader has lost its native dropdown DOM.
_VERIFIED_NATIVE_CATALOG_FROM_HTML = (
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-1/', 'Ch. 1 - First Night Retry...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-2-how-to-ask-a-new-bride-merakiscans/', 'Ch. 2 - How to ask a new b...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-3-signal-for-the-act-merakiscans/', 'Ch. 3 - Signal for the Act...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-4-humble-vacation-merakiscans/', 'Ch. 4 - Humble Vacation [M...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-5-bath-for-themselves-merakiscans/', 'Ch. 5 - Bath for themselve...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-6-nurses-office-girl-talk-merakiscans/', 'Ch. 6 - Nurse’s Office Gir...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-7-my-wife-was-a-cat-merakiscans/', 'Ch. 7 - My wife was a cat...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-1/ch-8-punishment-for-cheating-merakiscans/', 'Ch. 8 - Punishment for Che...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-9-mark-it-on-your-body-merakiscans/', 'Vol. 2 Ch. 9 - Mark it on...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-10-high-school-girl-merakiscans/', 'Vol. 2 Ch. 10 - High Schoo...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-10-5-wrapped-in-kindness-merakiscans/', 'Vol. 2 Ch. 10.5 - Wrapped...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-11-husbands-secret-merakiscans/', 'Vol. 2 Ch. 11 - Husband’s...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-12-night-of-eternal-oath-merakiscans/', 'Vol. 2 Ch. 12 - Night of E...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-13-selfish-sex-merakiscans/', 'Vol. 2 Ch. 13 - Selfish Se...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-14-your-temperature-merakiscans/', 'Vol. 2 Ch. 14 - Your Tempe...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-15-alluring-aroma-merakiscans/', 'Vol. 2 Ch. 15 - Alluring A...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-16-my-wife-is-too-cute-it-hurts-merakiscans/', 'Vol. 2 Ch. 16 - My Wife is...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-2/vol-2-ch-17-training-for-real-merakiscans/', 'Vol. 2 Ch. 17 - Training f...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-18-early-morning-date-merakiscans/', 'Vol. 3 Ch. 18 - Early Morn...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-18-5-young-magazine-special-chapter-merakiscans/', 'Vol. 3 Ch. 18.5 - Young Ma...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-19-lovers-quarrel-merakiscans/', "Vol. 3 Ch. 19 - Lover's Qu..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-20-two-soaked-in-rain-merakiscans/', 'Vol. 3 Ch. 20 - Two Soaked...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-21-isolated-room-merakiscans/', 'Vol. 3 Ch. 21 - Isolated R...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-22-cant-hold-back-merakiscans/', 'Vol. 3 Ch. 22 - Can’t Hold...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-23-for-my-special-person-merakiscans/', 'Vol. 3 Ch. 23 - For My Spe...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-23-5-my-wifes-secret-merakiscans/', "Vol. 3 Ch. 23.5 - My Wife'..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-24-misunderstanding-merakiscans/', 'Vol. 3 Ch. 24 - Misunderst...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-3/vol-3-ch-25-i-am-a-teacher/', 'Vol. 3 Ch. 25 - I Am A Tea...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-26-night-infirmary/', 'Vol. 4 Ch. 26 - Night Infi...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-27-handsome/', 'Vol. 4 Ch. 27 - Handsome...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-28-i-want-to-show-off/', 'Vol. 4 Ch. 28 - I Want to...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-28-5-massage/', 'Vol. 4 Ch. 28.5 - Massage...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-29-failure/', 'Vol. 4 Ch. 29 - Failure...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-30-to-the-point-of-tears/', 'Vol. 4 Ch. 30 - To The Poi...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-31-luckiest-moment-in-life/', 'Vol. 4 Ch. 31 - Luckiest M...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-32-the-other-side-of-the-first-night/', 'Vol. 4 Ch. 32 - The Other...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-33-the-husbands-obsession/', 'Vol. 4 Ch. 33 - The Husban...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-4/vol-4-ch-34-my-home-is-the-best/', 'Vol. 4 Ch. 34 - My Home is...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-35-charming-body/', 'Vol. 5 Ch. 35 - Charming B...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-36-naked-skinship/', 'Vol. 5 Ch. 36 - Naked Skin...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-37-birthday/', 'Vol. 5 Ch. 37 - Birthday...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-38-present/', 'Vol. 5 Ch. 38 - Present...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-39-insensitive-husband/', 'Vol. 5 Ch. 39 - Insensitiv...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-40-nursing/', 'Vol. 5 Ch. 40 - Nursing...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-41-preperation-for-the-worst/', 'Vol. 5 Ch. 41 - Preperatio...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-42-feast/', 'Vol. 5 Ch. 42 - Feast...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-5/vol-5-ch-43-i-want-it/', 'Vol. 5 Ch. 43 - I Want It...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-44-i-cant-wait-any-longer/', "Vol. 6 Ch. 44 - I can't wa..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-45-to-be-with-you/', 'Vol. 6 Ch. 45 - To Be With...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-46-his-body/', 'Vol. 6 Ch. 46 - His Body...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-47-fashion-show/', 'Vol. 6 Ch. 47 - Fashion Sh...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-48-i-just-want-her-all-for-myself/', 'Vol. 6 Ch. 48 - I Just Wan...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-49-sumikas-father/', "Vol. 6 Ch. 49 - Sumika's F..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-50-the-morning-after-a-good-time/', 'Vol. 6 Ch. 50 - The Mornin...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-6/vol-6-ch-51-a-bride/', 'Vol. 6 Ch. 51 - A Bride...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-52-no-matter-how-many-times/', 'Vol. 7 Ch. 52 - No Matter...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-53-lets-play-inside/', "Vol. 7 Ch. 53 - Let's Play..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-54-i-want-to-be-alone/', 'Vol. 7 Ch. 54 - I Want To...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-55-while-hes-asleep/', "Vol. 7 Ch. 55 - While He's..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-55-while-hes-asleep-1/', "Vol. 7 Ch. 55 - While He's..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-55-1-while-hes-asleep-uncensored/', 'Vol. 7 Ch. 55.1 - While He...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-56-someday/', 'Vol. 7 Ch. 56 - Someday...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-57-when-i-was-on-my-own/', 'Vol. 7 Ch. 57 - When I Was...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-58-our-dream-house/', 'Vol. 7 Ch. 58 - Our Dream...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-59-new-home/', 'Vol. 7 Ch. 59 - New Home...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-7/vol-7-ch-60-poor-movers/', 'Vol. 7 Ch. 60 - Poor Mover...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-61-a-caring-wife/', 'Vol. 8 Ch. 61 - A Caring W...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-62-marriage-a-bittersweet-journey/', 'Vol. 8 Ch. 62 - Marriage,...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-63-school-reunion/', 'Vol. 8 Ch. 63 - School Reu...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-64-a-relaxing-date/', 'Vol. 8 Ch. 64 - A Relaxing...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-65-changes-in-our-new-home/', 'Vol. 8 Ch. 65 - Changes In...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-66-confession-reply/', 'Vol. 8 Ch. 66 - Confession...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-67-cosplay-battle/', 'Vol. 8 Ch. 67 - Cosplay Ba...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-8/vol-8-ch-68-my-friends-girlfriend/', "Vol. 8 Ch. 68 - My Friend'..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-68-1-extra/', 'Vol. 9 Ch. 68.1 - Extra...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-68-2-special-chapter-how-did-the-confession-happen/', 'Vol. 9 Ch. 68.2 - Special...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-69-our-difference/', 'Vol. 9 Ch. 69 - Our Differ...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-70-solution/', 'Vol. 9 Ch. 70 - Solution...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-71-night-routine-for-a-single-day/', 'Vol. 9 Ch. 71 - Night Rout...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-72-masquerade-party/', 'Vol. 9 Ch. 72 - Masquerade...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-73-i-have-never-stopped-looking-at-you/', 'Vol. 9 Ch. 73 - I have ne...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-74-new-years-eve/', "Vol. 9 Ch. 74 - New Year'..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-75-happy-new-year/', 'Vol. 9 Ch. 75 - Happy New...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-76-first-letter-of-the-year/', 'Vol. 9 Ch. 76 - First Lett...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-9/vol-9-ch-76-5/', 'Vol. 9 Ch. 76.5 - Crossov...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-77-mothers-new-year-eve/', "Vol. 10 Ch. 77 - Mother's..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-78-feels-like-southern-island/', 'Vol. 10 Ch. 78 - Feels lik...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-79-lets-play/', "Vol. 10 Ch. 79 - Let's Pla..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-80-consultation/', 'Vol. 10 Ch. 80 - Consultat...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-81-im-on-your-side/', "Vol. 10 Ch. 81 - I'm on yo..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-82-straightforward/', 'Vol. 10 Ch. 82 - Straightf...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-10/vol-10-ch-83-sumika-becomes-an-announcer/', 'Vol. 10 Ch. 83 - Sumika Be...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-84-sumikas-birthday/', "Vol. 11 Ch. 84 - Sumika's..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-85-online-salon/', 'Vol. 11 Ch. 85 - Online Sa...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-86-overwhelming-growth-4-panel-extra/', 'Vol. 11 Ch. 86 - Overwhelm...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-87-slip-of-tongue/', 'Vol. 11 Ch. 87 - Slip of T...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-88-ways-of-apologizing/', 'Vol. 11 Ch. 88 - Ways of A...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-89-stay-with-me/', 'Vol. 11 Ch. 89 - Stay With...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-90-the-mood-that-time/', 'Vol. 11 Ch. 90 - The mood...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-11/vol-11-ch-91/', 'Vol. 11. Ch. 91 - Senior a...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-92/', 'Vol. 12. Ch. 92 - Becoming...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-93/', 'Vol. 12. Ch. 93 - Because...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-94/', 'Vol. 12. Ch. 94 - Hanami D...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-95/', "Vol. 12. Ch. 95 - Let's pl..."),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-96/', 'Vol. 12. Ch. 96 - Hobby-le...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-97/', 'Vol. 12. Ch. 97 - Fickle H...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-98/', 'Vol. 12. Ch. 98 - New Ling...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-12/vol-12-ch-99/', 'Vol. 12. Ch. 99 - Punishme...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-100/', 'Vol. 13. Ch. 100 - Conques...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-101/', 'Vol. 13. Ch. 101 - Dazzlin...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-102/', 'Vol. 13. Ch. 102 - Health...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-103/', 'Vol. 13. Ch. 103 - Things...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-104/', 'Vol. 13. Ch. 104 - Delusio...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-105/', 'Vol. 13. Ch. 105'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-106/', 'Vol. 13. Ch. 106 - To The...'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-13/vol-13-ch-107/', 'Vol. 13. Ch. 107'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-108/', 'Vol. 14. Ch. 108'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-109/', 'Vol. 14. Ch. 109'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-110/', 'Vol. 14. Ch. 110'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-111/', 'Vol. 14. Ch. 111'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-112/', 'Vol. 14. Ch. 112'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-113/', 'Vol. 14. Ch. 113'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-114/', 'Vol. 14. Ch. 114'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-14/vol-14-ch-115/', 'Vol. 14. Ch. 115'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-116/', 'Ch. 116'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-117/', 'Ch. 117'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-118/', 'Ch. 118'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-119/', 'Ch. 119'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-120/', 'Ch. 120'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-121/', 'Ch. 121'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-122/', 'Ch. 122'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-15/ch-123/', 'Ch. 123'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-124/', 'Ch. 124'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-125/', 'Ch. 125'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-126/', 'Ch. 126'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-127/', 'Ch. 127'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-128/', 'Ch. 128'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-129/', 'Ch. 129'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-130/', 'Ch. 130'),
    ('https://tritinia.org/manga/we-may-be-an-inexperienced-couple-but/volume-16/ch-131/', 'Ch. 131'),
)


def _catalog_without_volume_wrappers(soup, page_url, chapter_class):
    """Append cases for a live chapter page whose usual volume containers vanish.

    Keep the original group-based parser and its completeness gate untouched.
    Prefer any complete native option lists; use the verified HTML snapshot only
    when the native dropdown is entirely absent on an actual chapter reader.
    """
    native_selects = soup.select('select.single-chapter-select')
    extracted = []
    seen = set()
    for select in native_selects:
        for opt in reversed(select.select('option[data-redirect]')):
            url = urljoin(page_url, (opt.get('data-redirect') or '').strip())
            parts = urlsplit(url)
            if parts.scheme != 'https' or parts.netloc != 'tritinia.org' or _chapter_path(url) is None:
                continue
            clean = parts._replace(query='', fragment='').geturl()
            if clean in seen:
                continue
            label = ' '.join(opt.get_text(' ', strip=True).split())
            if not re.search(r'\bCh\.?\s*\d', label, re.I):
                continue
            seen.add(clean)
            extracted.append((_chapter_path(clean)[0], clean, label))

    if native_selects:
        # Never substitute a static catalog for a partial live catalog: it may
        # include new chapters or indicate a change needing human inspection.
        records = extracted
        source = 'native unwrapped chapter options'
    else:
        # Independent proof the page is really the requested chapter, rather
        # than a verification interstitial, advertisement, or unrelated URL.
        canonical = soup.select_one('link[rel="canonical"][href]')
        canonical_url = urljoin(page_url, canonical.get('href', '')) if canonical else page_url
        if _chapter_path(page_url) is None or _chapter_path(canonical_url) != _chapter_path(page_url):
            raise RuntimeError('Tritinia native volume/chapter selector missing; chapter canonical URL not verified')
        reader = soup.select_one('.reading-content')
        panels = reader.select('.page-break > img[id]') if reader else []
        if not any(re.fullmatch(r'\d+', str(im.get('id', ''))) for im in panels):
            raise RuntimeError('Tritinia native volume/chapter selector missing; real numbered reader panels absent')
        title = soup.title.get_text(' ', strip=True) if soup.title else ''
        if not title or 'inexperienced couple' not in title.lower():
            raise RuntimeError('Tritinia native volume/chapter selector missing; expected series title absent')
        import warnings
        warnings.warn('Tritinia live dropdown absent but native reader is available; using '
                      '140 exact chapter URLs independently verified from supplied original HTML. '
                      'Re-run --refresh-chapters when a newer live catalog becomes available.',
                      RuntimeWarning, stacklevel=2)
        records = [(_chapter_path(url)[0], url, label)
                   for url, label in _VERIFIED_NATIVE_CATALOG_FROM_HTML]
        source = 'verified supplied HTML native catalog'

    records.sort(key=lambda x: x[0])
    volumes = {vol for vol, _, _ in records}
    if len(records) < ARCHIVED_SOURCE_CHAPTER_COUNT or not set(range(1, 17)).issubset(volumes):
        raise RuntimeError(f'Tritinia {source} incomplete: {len(records)} distinct chapters, '
                           f'volumes {sorted(volumes)}; expected >=140 and volumes 1-16')
    ids = [_chapter_id(url) for _, url, _ in records]
    if len(ids) != len(set(ids)) or len({url for _,url,_ in records}) != len(records):
        raise RuntimeError('Tritinia native catalog duplicate chapter identities')
    if any(urlsplit(url).netloc != 'tritinia.org' or _chapter_path(url) is None
           for _,url,_ in records):
        raise RuntimeError('Tritinia native catalog contains an unverified external URL')
    return [chapter_class(_chapter_id(url), label, url) for _,url,label in records]
