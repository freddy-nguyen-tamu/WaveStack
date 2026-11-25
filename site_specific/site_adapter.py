"""Orange Marmalade, Comix native reader. Only source-specific code lives here.

Grounded in 2026-11-25 captured chapter-0 DOM and runtime. The capture contains native chapter navigation metadata, but not the entire
catalog. Discover from ordinary native HTML if available, or follow the site's
actual next-chapter links. Never synthesize opaque IDs, decode protected API
payloads, bypass an access denial, or declare a partial catalog complete.
The reusable bridge supports normal document and nested reader scrolling.
All Comix-specific discovery and image identity stay in this file.
"""
from __future__ import annotations
import json
import re
import sys
from decimal import Decimal
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup

SOURCE_BROWSER_TRANSPORT = 'extension'
SOURCE_NAME = 'comix-orange-marmalade'
STATE_STORAGE_MODE = 'scoped'
TITLE_ADAPTER_VERSION = 'comix-orange-marmalade-native-20261125-v6'
SERIES_SLUG_HINT = 'orange-marmalade'
DEFAULT_START_URL = 'https://comix.to/title/65gg-orange-marmalade/6312339-chapter-0'
ALLOWED_HOSTS = ('comix.to',)
BRIDGE_IMAGE_HOSTS = ('8pl.olivawrites.site', '8pl.lifebetweenlines.site',
                      '8pl.quietreflectionsblog.site', '8pl.ericlog.site',
                      '8pl.mycreativespace.site', '8pl.pureandsimpleshop.site',
                      '8pl.homeandheartshop.site', '8pl.notesbykevin.site')
# The installed bridge sourceMatches() accepts a single trailing wildcard.
# Python chapter_identity still checks the exact native chapter route.
EXTENSION_MATCHES = ('https://comix.to/title/65gg-orange-marmalade/*',)
TITLE_SELECTORS = ('meta[property="og:title"]', 'title')
READER_SELECTORS = ('.rpage-main__inner',)
# CDN names rotate. Unlisted URLs are eligible only for already-decoded
# pixels from this precise native slot; never grant broad CDN permissions.
BRIDGE_RENDERED_IMAGE_SELECTOR = '.rpage-main__inner .rpage-page[data-page] img.rpage-page__img'
PAGE_TOTAL_SELECTORS = ('.rpage-progress__seg',)
IMAGE_ATTRIBUTES = ('src',)
IMAGE_PLACEHOLDER_URL_MARKERS = ('/assets/gotaku-banner-',)
SOURCE_CONFIRMED_MISSING_PANELS = {}
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()

_SITE = 'https://comix.to'
_PATH = '/title/65gg-orange-marmalade/'
_LAST = 120
_PREFIX = 'comix-orange-marmalade-chapter-'
_NEXT = _SITE + _PATH + '6312417-chapter-1'
_LAST_URL = _SITE + _PATH + '7613251-chapter-120'
_OBSERVED_119_URL = _SITE + _PATH + '10825677-chapter-119'
_SERIES_URL = _SITE + _PATH.rstrip('/')
_DISCOVERED_CATALOG = ()
# Native URLs imported from the user's normal browser UI, not a guessed range.
# BEGIN CAPTURED CATALOG
_CAPTURED_CATALOG = ()
# END CAPTURED CATALOG


def _chapter_number(url):
    p = urlsplit(str(url or ''))
    if (p.scheme != 'https' or p.netloc != 'comix.to' or p.query or p.fragment
            or not p.path.startswith(_PATH)):
        raise ValueError('Unexpected Comix comic/URL: '+str(url)[:180])
    m = re.fullmatch(r'[0-9]+-chapter-([0-9]+(?:[.-][0-9]+)?)', p.path[len(_PATH):])
    if not m:
        raise ValueError('Unexpected native chapter route: '+p.path)
    return m.group(1).replace('-', '.')


def _id(number):
    return _PREFIX + number


def chapter_identity(anchor, url, label):
    return _id(_chapter_number(url))


def _json_script(soup, name):
    node = soup.select_one('script#'+name+'[type="application/json"]')
    if node is None:
        return {}
    try:
        data = json.loads(node.get_text())
    except (ValueError, TypeError):
        raise RuntimeError('Invalid native Comix metadata: '+name)
    if not isinstance(data, dict):
        raise RuntimeError('Invalid native Comix metadata object: '+name)
    return data


def title_from_html(soup):
    data = _json_script(soup, 'initial-data')
    if data:
        detail = data.get('queries', {}).get('["manga","detail","65gg"]', {})
        if detail.get('hid') != '65gg' or detail.get('title') != 'Orange Marmalade':
            raise RuntimeError('Native metadata does not identify Orange Marmalade')
        return detail['title']
    if not soup.title and not soup.select_one('meta[property="og:title"]'):
        return None
    raise RuntimeError('Orange Marmalade native series identity unavailable; check the current reader page')


def chapter_title_from_anchor(anchor, fallback):
    return fallback


def chapter_title_from_html(soup, fallback):
    # Never use the chapter dropdown's first label. Bind title to actual chapter.
    sync = _json_script(soup, 'syncData')
    if sync:
        if sync.get('manga_id') != '65gg' or sync.get('name') != 'Orange Marmalade':
            raise RuntimeError('Current reader belongs to a different comic')
        expected = re.fullmatch(r'Chapter ([0-9]+(?:\.[0-9]+)?)', str(fallback))
        if expected is None or Decimal(str(sync.get('number'))) != Decimal(expected.group(1)):
            raise RuntimeError('Current reader chapter does not match saved native catalog')
    return fallback


def _validate_catalog(rows):
    by_number = {}
    for row in rows:
        url = row if isinstance(row, str) else row.get('url', '')
        url = str(url).strip()
        n = _chapter_number(url)
        value = Decimal(n)
        if value < 0 or value > _LAST:
            raise ValueError('Chapter outside captured series range: '+n)
        if value in by_number and by_number[value] != url:
            raise ValueError('Multiple editions for chapter '+n+'; select one native URL per chapter')
        by_number[value] = url
    missing = [str(n) for n in range(_LAST+1) if Decimal(n) not in by_number]
    if missing:
        raise ValueError(f'Native catalog is incomplete: {len(by_number)} unique chapter numbers; '
                         'missing '+', '.join(missing[:20])+(' ...' if len(missing)>20 else ''))
    # The capture proves these are the first two chapters in the chosen edition.
    if by_number.get(Decimal(0)) != DEFAULT_START_URL or by_number.get(Decimal(1)) != _NEXT:
        raise ValueError('Catalog does not match the captured chapter-0 -> chapter-1 edition')
    return tuple(by_number[n] for n in sorted(by_number))


def _native_links(raw, page_url):
    """Extract actual URLs from native anchors and plain JSON metadata only."""
    soup = BeautifulSoup(raw, 'html.parser')
    data = _json_script(soup, 'initial-data')
    detail = data.get('queries', {}).get('["manga","detail","65gg"]', {})
    if detail.get('hid') != '65gg' or detail.get('title') != 'Orange Marmalade':
        return []
    values = [a.get('href') for a in soup.select('a[href]')]
    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from walk(item)
        elif isinstance(value, list):
            for item in value:
                yield from walk(item)
        elif isinstance(value, str) and ('/title/65gg-orange-marmalade/' in value):
            yield value
    # The firstChapterUrl metadata points to a different edition than the
    # user's actual starting reader. Do not mix editions silently.
    queries = {k:v for k,v in data.get('queries', {}).items()
               if k != '["manga","detail","65gg"]'}
    values.extend(walk(queries))
    found = set()
    for value in values:
        if not isinstance(value, str):
            continue
        url = urljoin(page_url, value)
        try:
            _chapter_number(url)
        except ValueError:
            continue
        found.add(url)
    return sorted(found)


def _native_next(raw, url):
    soup = BeautifulSoup(raw, 'html.parser')
    if title_from_html(soup) != 'Orange Marmalade':
        raise RuntimeError('Native series identity unavailable during chapter discovery')
    meta = _json_script(soup, 'syncData')
    n = Decimal(_chapter_number(url))
    if (meta.get('manga_id') != '65gg' or meta.get('name') != 'Orange Marmalade'
            or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', str(meta.get('number')))
            or Decimal(str(meta.get('number'))) != n):
        raise RuntimeError('Native next-chapter metadata unavailable for '+url)
    nxt = meta.get('next_chapter_url')
    if not nxt:
        if n == _LAST:
            return None
        # The captured chapter 119 has disabled Next and empty syncData next,
        # but its own series detail explicitly publishes the final chapter URL.
        # Only bridge a one-chapter gap; never jump over missing chapters.
        detail = _json_script(soup, 'initial-data').get('queries', {}).get(
            '["manga","detail","65gg"]', {})
        if (n == _LAST - 1 and detail.get('finalChapter') == _LAST
                and detail.get('latestChapter') == _LAST):
            candidate = urljoin(url, str(detail.get('latestChapterUrl') or ''))
            if candidate == _LAST_URL and Decimal(_chapter_number(candidate)) == _LAST:
                print('COMIX_NATIVE_FINAL_LINK: chapter 119 has no Next; using series latestChapterUrl for 120', flush=True)
                return candidate
        raise RuntimeError('Native navigation ended before chapter 120; incomplete catalog refused')
    nxt = urljoin(url, str(nxt))
    m = Decimal(_chapter_number(nxt))
    if not n < m <= _LAST:
        raise RuntimeError('Native chapter navigation loop or out-of-order chapter')
    return nxt


def _public_html(url, guard):
    # Ordinary public HTML only. The runtime capture's encrypted XHR is NOT
    # replayed or decoded; an actual access denial is respected.
    import requests
    guard.before(url, operation='native-chapter-catalog')
    r = requests.get(url, headers={'Accept':'text/html',
                     'User-Agent':'AuthorizedComicMetadata/1.0'},
                     timeout=(10,25), allow_redirects=False)
    guard.response(url, r.status_code, dict(r.headers))
    if r.status_code != 200 or 'html' not in r.headers.get('Content-Type','text/html').lower():
        raise RuntimeError(f'Native public chapter metadata unavailable (HTTP {r.status_code})')
    return r.text


def _discover_catalog(raw_html, page_url, fetch):
    # Try a complete catalog in the supplied DOM, then the public series page.
    # If the public page is a client-side shell, follow only real native
    # next_chapter_url metadata where available. No guessed numeric route IDs.
    if page_url != DEFAULT_START_URL:
        raise RuntimeError('Full native discovery must start at the selected chapter 0 edition')
    if title_from_html(BeautifulSoup(raw_html, 'html.parser')) != 'Orange Marmalade':
        raise RuntimeError('Live source series identity not established')
    if _native_next(raw_html, page_url) != _NEXT:
        raise RuntimeError('Selected chapter edition no longer matches the supplied native navigation')
    try:
        return _validate_catalog(_native_links(raw_html,page_url))
    except ValueError:
        pass
    series = fetch(_SERIES_URL)
    try:
        return _validate_catalog(_native_links(series,_SERIES_URL))
    except ValueError:
        pass
    rows = [page_url]
    raw, url = raw_html, page_url
    while True:
        nxt = _native_next(raw,url)
        if nxt is None:
            break
        if nxt in rows or len(rows) >= 1000:
            raise RuntimeError('Native navigation loop or chapter safety limit reached')
        print('COMIX_NATIVE_DISCOVERY: '+_chapter_number(nxt)+' / 120', flush=True)
        raw = fetch(nxt)
        rows.append(nxt)
        url = nxt
    return _validate_catalog(rows)


def custom_chapters(raw_html, page_url, chapter_class):
    global _DISCOVERED_CATALOG
    _chapter_number(page_url)
    if _CAPTURED_CATALOG:
        rows = _validate_catalog(_CAPTURED_CATALOG)
    else:
        from reusable.source_session import SourceRequestGuard
        root = Path(__file__).resolve().parents[1]
        config = json.loads((root/'config/default.json').read_text(encoding='utf-8'))
        guard = SourceRequestGuard(root/'.archiver_state'/'sites'/SOURCE_NAME,
            min_interval_seconds=config.get('source_min_host_interval_seconds',1.5),
            max_inline_wait_seconds=config.get('source_max_inline_wait_seconds',25))
        rows = _discover_catalog(raw_html,page_url,lambda url:_public_html(url,guard))
    _DISCOVERED_CATALOG = rows
    if page_url not in rows:
        raise RuntimeError('Current reader edition not present in native catalog')
    print('COMIX_NATIVE_CATALOG_VERIFIED entries='+str(len(rows)), flush=True)
    return [chapter_class(chapter_identity(None,u,''), 'Chapter '+_chapter_number(u), u) for u in rows]


def _catalog_checkpoint():
    return (Path(__file__).resolve().parents[1] / '.archiver_state' /
            'sites' / SOURCE_NAME / 'native_catalog_progress.json')


def _validate_prefix(rows):
    rows = list(rows)
    if not rows or rows[0] != DEFAULT_START_URL:
        raise ValueError('Catalog prefix must start at captured chapter zero')
    numbers = [Decimal(_chapter_number(u)) for u in rows]
    if numbers != [Decimal(i) for i in range(len(rows))] or len(rows) > _LAST+1:
        raise ValueError('Catalog prefix must be consecutive and unique')
    if len(rows) > 1 and rows[1] != _NEXT:
        raise ValueError('Catalog prefix does not match captured first edition')
    if len(rows) > _LAST and rows[_LAST] != _LAST_URL:
        raise ValueError('Catalog prefix does not match captured final URL')
    return rows


def _save_catalog_prefix(rows, *, origin='native-browser'):
    rows = _validate_prefix(rows)
    path = _catalog_checkpoint()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as out:
        json.dump({'schema':1,'source':SOURCE_NAME,'seed':DEFAULT_START_URL,
                   'origin':origin,'rows':rows}, out)
        out.flush()
        import os
        os.fsync(out.fileno())
    tmp.replace(path)


def _load_catalog_prefix():
    path = _catalog_checkpoint()
    if not path.exists():
        return [DEFAULT_START_URL]
    data = json.loads(path.read_text(encoding='utf-8'))
    if (data.get('schema') != 1 or data.get('source') != SOURCE_NAME or
            data.get('seed') != DEFAULT_START_URL):
        raise RuntimeError('Native catalog checkpoint belongs to a different source')
    return _validate_prefix(data['rows'])


def _read_live_chapter(page, url, visit):
    import time
    visit(page, url)
    deadline = time.monotonic()+20
    while True:
        raw = page.content()
        soup = BeautifulSoup(raw, 'html.parser')
        meta = _json_script(soup, 'syncData')
        if (page.url == url and meta.get('manga_id') == '65gg' and
                str(meta.get('number')) == _chapter_number(url)):
            if title_from_html(soup) != 'Orange Marmalade':
                raise RuntimeError('Native reader series identity mismatch')
            read = _json_script(soup, 'initial-data').get('read', {})
            if read:
                expected_id = int(urlsplit(url).path.rsplit('/',1)[1].split('-chapter-')[0])
                if read.get('chapterId') != expected_id or read.get('mangaHid') != '65gg':
                    raise RuntimeError('Native reader edition identity mismatch: '+url)
            if url == _LAST_URL:
                # A metadata link alone is not proof that the final chapter loads.
                _declared_slots(soup)
            return raw
        if time.monotonic() >= deadline:
            raise RuntimeError('Native reader metadata did not settle: '+url)
        page.wait_for_timeout(500)


def custom_browser_chapters(context, seed_url, seed_html, chapter_class, visit):
    """Use normal paired browser and persist each validated native visit."""
    global _DISCOVERED_CATALOG
    if seed_url != DEFAULT_START_URL or _native_next(seed_html, seed_url) != _NEXT:
        raise RuntimeError('Native chapter-zero edition does not match capture')
    if _CAPTURED_CATALOG:
        rows = _validate_catalog(_CAPTURED_CATALOG)
    else:
        try:
            rows = _validate_catalog(_native_links(seed_html, seed_url))
        except ValueError:
            # Only the actual extension-backed context owns persistent
            # browser-discovery state. Offline callers/fixture contexts must
            # never mutate or consume a real user's checkpoint.
            persistent = getattr(context, 'bridge', None) is not None
            rows = _load_catalog_prefix() if persistent else [seed_url]
            page = context.new_page()
            try:
                raw, url = seed_html, seed_url
                if len(rows) > 1:
                    url = rows[-1]
                    print('COMIX_CATALOG_RESUME: '+str(len(rows))+' saved chapter URLs; checking '+url, flush=True)
                    raw = _read_live_chapter(page, url, visit)
                elif persistent:
                    _save_catalog_prefix(rows)
                while True:
                    nxt = _native_next(raw, url)
                    if nxt is None:
                        break
                    if nxt in rows or Decimal(_chapter_number(nxt)) != len(rows):
                        raise RuntimeError('Native navigation is not consecutive; refusing incomplete catalog')
                    print('COMIX_BROWSER_CATALOG: '+_chapter_number(nxt)+' / 120', flush=True)
                    raw = _read_live_chapter(page, nxt, visit)
                    rows.append(nxt)
                    if persistent:
                        _save_catalog_prefix(rows)
                    url = nxt
            finally:
                page.close()
            rows = _validate_catalog(rows)
    _DISCOVERED_CATALOG = rows
    print('COMIX_NATIVE_CATALOG_VERIFIED entries='+str(len(rows)), flush=True)
    return [chapter_class(chapter_identity(None,u,''), 'Chapter '+_chapter_number(u), u) for u in rows]


def _history_prefix(history_path):
    """Read only matching visit URLs from a local Chromium History database."""
    import sqlite3
    from contextlib import closing
    with closing(sqlite3.connect(Path(history_path).resolve().as_uri()+'?mode=ro', uri=True, timeout=2)) as db:
        records = db.execute(
            'SELECT urls.url FROM visits JOIN urls ON visits.url=urls.id '
            'WHERE urls.url LIKE ? ORDER BY visits.visit_time, visits.id',
            (_SITE+_PATH+'%',)).fetchall()
    # Match the observed run: chapter 0,1,...119, with possible duplicate
    # visits to the current page. Do not combine conflicting editions or
    # silently bridge missing interior chapters.
    chain = []
    recovered = []
    for (url,) in records:
        try:
            n = Decimal(_chapter_number(url))
        except ValueError:
            continue
        if url == DEFAULT_START_URL:
            if len(chain) <= 1:
                chain = [url]
            else:
                chain = [url]
            continue
        if not chain or url == chain[-1]:
            continue
        if n == len(chain) and (n != 1 or url == _NEXT):
            chain.append(url)
            if url == _OBSERVED_119_URL and len(chain)==120:
                recovered.append(tuple(chain))
        else:
            chain = []
    unique = set(recovered)
    if len(unique)>1:
        raise RuntimeError('Conflicting complete visit sequences in browser history; refusing to select one')
    return list(next(iter(unique))) if unique else []


def _recover_catalog_history():
    import os
    import sqlite3
    base = Path(os.environ.get('LOCALAPPDATA', ''))
    roots = (base/'Google'/'Chrome'/'User Data',
             base/'Microsoft'/'Edge'/'User Data')
    found = set()
    locked = 0
    for root in roots:
        if not root.is_dir():
            continue
        for profile in root.iterdir():
            if profile.name != 'Default' and not re.fullmatch(r'Profile [0-9]+', profile.name):
                continue
            history = profile/'History'
            if not history.is_file():
                continue
            try:
                prefix = _history_prefix(history)
            except (OSError, sqlite3.Error):
                locked += 1
                continue
            if prefix:
                found.add(tuple(_validate_prefix(prefix)))
    if len(found) > 1:
        raise RuntimeError('Multiple conflicting browser visit sequences; no checkpoint written')
    if not found:
        print('COMIX_HISTORY_RECOVERY_UNAVAILABLE: no complete matching 0-119 sequence'+
              ('; some History databases were locked' if locked else '')+
              '. Normal discovery will use persistent checkpoints.', flush=True)
        return False
    rows = list(next(iter(found)))
    existing = _load_catalog_prefix()
    if rows[:min(len(existing),len(rows))] != existing[:min(len(existing),len(rows))]:
        raise RuntimeError('Browser history conflicts with saved checkpoint; no changes written')
    if len(existing)<len(rows):
        _save_catalog_prefix(rows, origin='local-browser-history')
    print('COMIX_HISTORY_RECOVERED: 120 previously visited chapter URLs (0-119). '
          'Next run verifies live chapter 119 and visits chapter 120.', flush=True)
    return True


def title_catalog_url(saved_url):
    return _SERIES_URL


def captured_native_chapter_titles():
    # Only real captured URLs; do not pretend that all 121 are captured.
    rows = _DISCOVERED_CATALOG or _CAPTURED_CATALOG or (DEFAULT_START_URL,_NEXT,_LAST_URL)
    return {_id(_chapter_number(u)): 'Chapter '+_chapter_number(u) for u in rows}


def native_chapter_titles_from_catalog(raw_html, page_url):
    # Title maintenance must stay a single metadata request, not a full crawl.
    rows = _native_links(raw_html,page_url)
    return {**captured_native_chapter_titles(),
            **{_id(_chapter_number(u)):'Chapter '+_chapter_number(u) for u in rows}}


def accept_catalog_title(chapter_id, label):
    return (isinstance(chapter_id, str) and chapter_id.startswith(_PREFIX) and
            bool(re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', chapter_id[len(_PREFIX):])) and
            label == 'Chapter '+chapter_id[len(_PREFIX):])


def _declared_slots(soup):
    root = soup.select_one('.rpage-main__inner')
    if root is None:
        raise RuntimeError('Comix reader container unavailable')
    # Native progress segments declare the chapter total even when image nodes
    # are still unmounted. Do not count the sponsored image or comment avatars.
    segs = soup.select('.rpage-progress__seg')
    numbers = []
    for item in segs:
        m = re.fullmatch(r'Go to page ([0-9]+)', str(item.get('aria-label', '')))
        if not m:
            raise RuntimeError('Unknown native page progress label')
        numbers.append(int(m.group(1)))
    if not numbers or numbers != list(range(1, len(numbers)+1)):
        raise RuntimeError('Native page total/order not verified; refusing incomplete archive')
    slots = {}
    for wrapper in root.select('.rpage-page[data-page]'):
        k = int(wrapper['data-page'])
        if k in slots or k not in numbers:
            raise RuntimeError('Duplicate or out-of-range native reader page')
        images = wrapper.select('img.rpage-page__img')
        if len(images) > 1:
            raise RuntimeError('More than one artwork image in native page '+str(k))
        slots[k] = images[0] if images else None
    return numbers, slots


def accept_rendered_image_url(url):
    """Shape check, NOT network authorization. The bridge independently proves
    a unique decoded currentSrc inside BRIDGE_RENDERED_IMAGE_SELECTOR.
    """
    try:
        p = urlsplit(url)
        host = p.hostname or ''
        return bool(p.scheme == 'https' and not p.username and not p.password
                    and p.port is None and p.netloc == host and not p.fragment
                    and not p.query and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', host)
                    and re.fullmatch(r'/hi/[A-Za-z0-9_-]+', p.path))
    except (ValueError, TypeError):
        return False


def _image_url(raw, page_url):
    if not raw or str(raw).startswith(('data:', 'about:')):
        return ''
    url = urljoin(page_url, str(raw))
    p = urlsplit(url)
    if not accept_rendered_image_url(url):
        raise RuntimeError('COMIX_INVALID_NATIVE_PANEL_URL: '+str(p.hostname)+' '+p.path[:12])
    return url


def custom_page_snapshot(page):
    # BridgePage.evaluate accepts only its existing generic snapshot operation.
    # No arbitrary JS execution, direct CDN fetch or private API replay.
    number = _chapter_number(page.url)
    info = page.evaluate('() => { /* MutationObserver */ return {imgs:[]}; }')
    html = page.content()
    if _chapter_number(page.url) != number:
        raise RuntimeError('Managed tab changed chapter during snapshot')
    soup = BeautifulSoup(html, 'html.parser')
    chapter_title_from_html(soup, 'Chapter '+number)
    numbers, slots = _declared_slots(soup)
    by_key = {}
    for im in info.get('imgs', []):
        key = str(im.get('key', ''))
        by_key.setdefault(key, []).append(im)
    out = []
    for k in numbers:
        node = slots.get(k)
        url = _image_url(node.get('src', '') if node else '', page.url)
        matches = [x for x in by_key.get(str(k), []) if url and urljoin(page.url, str(x.get('url') or '')) == url]
        if len(matches) > 1:
            raise RuntimeError('Ambiguous live image observation for native page '+str(k))
        obs = matches[0] if matches else {}
        loaded = bool(obs.get('loaded') is True and obs.get('width',0)>0 and obs.get('height',0)>0)
        out.append({'key':str(k),'url':url,'loaded':loaded,
                    'width':int(obs.get('width') or 0) if loaded else 0,
                    'height':int(obs.get('height') or 0) if loaded else 0,
                    'pageY':float(obs.get('pageY') or 0)})
    # Diagnose a real geometry mismatch if the live reader did not expose
    # a scrollable surface; never declare the currently mounted subset complete.
    viewport = float(info.get('viewportHeight') or 0)
    if (viewport and float(info.get('bottom') or 0) <= 4 and
            any(x['pageY'] >= viewport for x in out) and len(out)>1 and
            any(not x['loaded'] for x in out)):
        raise RuntimeError('COMIX_NESTED_SCROLL: native artwork extends beyond the viewport with unloaded slots, but '
                           'the live bridge detected no scrollable reader surface. Reload the updated extension; '
                           'verify the native reader layout if this persists.')
    return {**info,'imgs':out,'total':len(numbers),'readerCount':len(numbers),
            'missingSlots':sum(not x['url'] for x in out),
            'unloadedSlots':sum(not x['loaded'] for x in out)}


def _import_catalog(raw):
    payload = json.loads(raw.lstrip('\ufeff'))
    if not isinstance(payload, dict) or payload.get('source') != _SITE+_PATH.rstrip('/'):
        raise ValueError('Capture must come from the Orange Marmalade native UI')
    rows = _validate_catalog(payload.get('links', ()))
    p = Path(__file__).resolve()
    s = p.read_text(encoding='utf-8')
    replacement = '# BEGIN CAPTURED CATALOG\n_CAPTURED_CATALOG = (\n'+''.join('    '+repr(u)+',\n' for u in rows)+')\n# END CAPTURED CATALOG'
    updated, n = re.subn(r'^# BEGIN CAPTURED CATALOG\n.*?^# END CAPTURED CATALOG', lambda _:replacement,s,flags=re.M|re.S)
    if n != 1:
        raise RuntimeError('Adapter catalog markers changed; nothing written')
    compile(updated,str(p),'exec')
    tmp = p.with_suffix('.tmp')
    tmp.write_text(updated,encoding='utf-8')
    tmp.replace(p)
    print(f'PASS: imported {len(rows)} actual chapter URLs into the single adapter')


def adapter_self_test():
    assert all(p.count('*') == 1 and p.endswith('*') for p in EXTENSION_MATCHES)
    assert any(DEFAULT_START_URL.startswith(p[:-1]) for p in EXTENSION_MATCHES)
    assert _chapter_number(DEFAULT_START_URL)=='0'
    assert _chapter_number(_NEXT)=='1'
    assert chapter_identity(None,_NEXT,'')==_PREFIX+'1'
    assert not accept_catalog_title(_PREFIX+'1','Chapter 120')
    assert accept_rendered_image_url('https://lov.digitalsoulstudio.site/hi/bEqPbYfo')
    assert accept_rendered_image_url('https://future-cdn.example/hi/panel_1')
    assert not accept_rendered_image_url('http://future-cdn.example/hi/panel_1')
    assert not accept_rendered_image_url('https://future-cdn.example/ad.png')
    assert not accept_rendered_image_url('https://127.0.0.1/hi/panel_1')
    try: _validate_catalog([DEFAULT_START_URL,_NEXT])
    except ValueError: pass
    else: raise AssertionError('incomplete catalog accepted')
    if _CAPTURED_CATALOG:
        assert len(_validate_catalog(_CAPTURED_CATALOG))>=121
    return {'captured_catalog_entries':len(_CAPTURED_CATALOG),'observed_cdn_hosts':len(BRIDGE_IMAGE_HOSTS)}


_ADAPTER_PREFLIGHT_PROOF = adapter_self_test()
if __name__ == '__main__':
    if sys.argv[1:] == ['--import-catalog']:
        _import_catalog(sys.stdin.read())
    elif sys.argv[1:] == ['--recover-catalog-history']:
        _recover_catalog_history()
    elif sys.argv[1:] == ['--check']:
        print(adapter_self_test())
    else:
        raise SystemExit('Use --import-catalog (JSON via stdin), --recover-catalog-history, or --check')
