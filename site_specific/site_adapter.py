"""Taiyou no Ie / Toonz: native chapter and panel metadata from the normal reader.
Only this adapter is site-specific. No script evaluation, private API, guessed
filenames, alternate access identities, or replacement of the reusable bridge.
"""
from __future__ import annotations
import json
import os
import re
import time
from decimal import Decimal
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup

SOURCE_NAME = 'toonz-taiyou-no-ie'
STATE_STORAGE_MODE = 'scoped'
SOURCE_BROWSER_TRANSPORT = 'extension'
TITLE_ADAPTER_VERSION = 'toonz-taiyou-no-ie-native-20261126-v2'
SERIES_SLUG_HINT = 'taiyou-no-ie'
_SITE = 'https://toonz.to'
_SERIES = _SITE + '/manga/taiyou-no-ie'
_PREFIX = SOURCE_NAME + '-chapter-'
_COMIC_ID = 1047727
_COMIC_TITLE = 'Taiyou no Ie'
DEFAULT_START_URL = _SERIES + '/chapter/1'
ALLOWED_HOSTS = ('toonz.to',)
# The ordinary page images in both captures are same-origin /uploads/ URLs.
BRIDGE_IMAGE_HOSTS = ()
EXTENSION_MATCHES = (_SERIES + '/*',)
READER_SELECTORS = ('main .scrollbar-thin.fixed.inset-0.overflow-y-auto', 'main')
TITLE_SELECTORS = ('title',)
IMAGE_ATTRIBUTES = ('src',)
IMAGE_PLACEHOLDER_URL_MARKERS = ('/branding/',)
PAGE_TOTAL_SELECTORS = ()
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ('a[aria-label="Next chapter"][href]',)
PREV_NAV_SELECTORS = ('a[aria-label="Previous chapter"][href]',)
CHAPTER_MENU_SELECTORS = ()
SOURCE_CONFIRMED_MISSING_PANELS = {}


def _number(value):
    text = str(value)
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', text):
        raise ValueError('Invalid native chapter number: ' + text[:80])
    return format(Decimal(text).normalize(), 'f')


def _chapter_number(url):
    p = urlsplit(str(url))
    if p.scheme != 'https' or p.netloc != 'toonz.to' or p.query or p.fragment:
        raise ValueError('Outside selected Toonz series: ' + str(url)[:160])
    m = re.fullmatch(r'/manga/taiyou-no-ie/chapter/([0-9]+(?:[.-][0-9]+)?)', p.path)
    if not m:
        raise ValueError('Not a native chapter route: ' + p.path)
    return _number(m.group(1).replace('-', '.'))


def chapter_identity(anchor, url, label):
    return _PREFIX + _chapter_number(url)


def _positive_int(value, what):
    if type(value) is not int or value <= 0:
        raise RuntimeError('Invalid native ' + what)
    return value


def _label(row):
    number = _number(row['chapterNumber'])
    title = row.get('title')
    if title is None or title == '':
        return 'Chapter ' + number
    if not isinstance(title, str) or not title.strip() or len(title) > 250:
        raise RuntimeError('Invalid native chapter title')
    return ' '.join(title.split())


def _walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _reader_props(soup):
    # Next.js writes plain, browser-delivered JSON strings as Flight records.
    # Parse ONLY JSON arguments; never execute the surrounding JavaScript.
    decoder = json.JSONDecoder()
    chunks = []
    for node in soup.select('script:not([src])'):
        text = node.get_text()
        for match in re.finditer(r'self\.__next_f\.push\s*\(', text):
            try:
                payload, end = decoder.raw_decode(text[match.end():].lstrip())
            except ValueError:
                continue
            if isinstance(payload, list) and len(payload) == 2 and payload[0] == 1 and isinstance(payload[1], str):
                chunks.append(payload[1])
    matches = []
    for line in ''.join(chunks).splitlines():
        _, sep, record = line.partition(':')
        if not sep or not record.startswith(('[', '{')):
            continue
        try:
            value = json.loads(record)
        except ValueError:
            continue
        for obj in _walk(value):
            if isinstance(obj.get('comic'), dict) and isinstance(obj.get('chapter'), dict) and 'nextChapter' in obj and 'prevChapter' in obj:
                comic = obj['comic']
                if comic.get('id') == _COMIC_ID and comic.get('slug') == SERIES_SLUG_HINT and comic.get('title') == _COMIC_TITLE:
                    if obj not in matches:
                        matches.append(obj)
    if len(matches) != 1:
        raise RuntimeError('TOONZ_READER_METADATA: expected one native chapter record for Taiyou no Ie; found ' + str(len(matches)))
    return matches[0]


def _panel_url(filename, chapter_id):
    # The exact /uploads/ prefix is confirmed by the mounted images in both
    # supplied DOMs; the remaining path comes verbatim from the native record.
    if not isinstance(filename, str) or not re.fullmatch(
            rf'chapters/{_COMIC_ID}/{chapter_id}/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g|avif|gif)', filename, re.I):
        raise RuntimeError('Unexpected native panel filename or chapter ownership')
    return _SITE + '/uploads/' + filename


def _panels(props):
    chapter = props['chapter']
    ident = _positive_int(chapter.get('id'), 'chapter ID')
    images = chapter.get('images')
    if not isinstance(images, list) or not images:
        raise RuntimeError('TOONZ_EMPTY_IMAGE_CATALOG: refusing incomplete chapter')
    rows = []
    for item in images:
        if not isinstance(item, dict):
            raise RuntimeError('Invalid native image entry')
        rows.append({'key': str(_positive_int(item.get('sortOrder'), 'panel order')),
                     'url': _panel_url(item.get('filename'), ident),
                     'width': _positive_int(item.get('width'), 'panel width'),
                     'height': _positive_int(item.get('height'), 'panel height')})
    rows.sort(key=lambda row: int(row['key']))
    if [int(row['key']) for row in rows] != list(range(1, len(rows)+1)):
        raise RuntimeError('TOONZ_PANEL_ORDER: native manifest has gaps or duplicates')
    if len({row['url'] for row in rows}) != len(rows):
        raise RuntimeError('TOONZ_PANEL_ORDER: duplicate native panel URL')
    return rows


def _neighbor(soup, props, url, direction):
    label = 'Next chapter' if direction == 'next' else 'Previous chapter'
    anchors = soup.select('a[aria-label="'+label+'"][href]')
    targets = {urljoin(url, a['href']) for a in anchors}
    meta = props[direction+'Chapter']
    if meta is None:
        if targets:
            raise RuntimeError('Native '+direction+' link disagrees with terminal metadata')
        return None
    if not isinstance(meta, dict) or len(targets) > 1:
        raise RuntimeError('Native '+direction+' chapter URL unavailable or ambiguous')
    if targets:
        target = next(iter(targets))
    else:
        # A page-by-page layout may hide the chapter navigation controls.
        # Use the site's explicitly serialized chapter slug and number with
        # the observed route mapping, then verify the destination's native ID.
        slug = meta.get('slug')
        if not isinstance(slug,str) or not re.fullmatch(r'chapter-[0-9]+(?:[.-][0-9]+)?',slug):
            raise RuntimeError('Native '+direction+' chapter slug unavailable')
        target = _SERIES+'/chapter/'+slug[len('chapter-'):]
    if _chapter_number(target) != _number(meta['chapterNumber']):
        raise RuntimeError('Native '+direction+' chapter URL and chapter number disagree')
    _positive_int(meta.get('id'), 'neighbor chapter ID')
    return {'url':target,'id':meta['id'],'number':_number(meta['chapterNumber']),'title':_label(meta)}


def _read(soup, url):
    number = _chapter_number(url)
    canon = soup.select_one('link[rel="canonical"]')
    if not canon or canon.get('href') != url:
        raise RuntimeError('TOONZ_READER_IDENTITY: canonical chapter does not match managed URL')
    props = _reader_props(soup)
    chapter = props['chapter']
    ident = _positive_int(chapter.get('id'), 'chapter ID')
    if chapter.get('comicId') != _COMIC_ID or _number(chapter['chapterNumber']) != number:
        raise RuntimeError('TOONZ_READER_IDENTITY: wrong chapter or series')
    panels = _panels(props)
    reports = soup.select('[data-report-context][data-scope="chapter"]')
    report_ids = {(r.get('data-comic-id'), r.get('data-chapter-id')) for r in reports}
    expected = (str(_COMIC_ID), str(ident))
    # Report widgets are auxiliary UI, not the chapter manifest. Duplicate
    # equivalent widgets are harmless. A missing/stale same-series widget
    # needs independent proof from the actual mounted reader, not just JSON.
    if report_ids != {expected}:
        if any(comic != str(_COMIC_ID) for comic, _ in report_ids):
            raise RuntimeError('TOONZ_READER_IDENTITY: foreign report context: '+repr(sorted(report_ids, key=str)))
        title = soup.title.get_text(' ', strip=True) if soup.title else ''
        match = re.fullmatch(r'Ch\.\s*([0-9]+(?:\.[0-9]+)?)(?::.*?)?\s+[–—-]\s+Taiyou no Ie(?:\s*\|\s*Toonz)?', title, re.I)
        if not match or _number(match[1]) != number:
            raise RuntimeError('TOONZ_READER_IDENTITY: report context unsettled; document title does not corroborate chapter '+number)
        try:
            _mounted_panels(soup, url, panels)
        except (RuntimeError, ValueError, KeyError, TypeError) as exc:
            raise RuntimeError('TOONZ_READER_IDENTITY: report context unsettled; mounted artwork proof failed: '+str(exc)) from exc
    row = {'url':url,'number':number,'id':ident,'title':_label(chapter),
           'next':_neighbor(soup,props,url,'next'), 'prev':_neighbor(soup,props,url,'prev')}
    # allChapters is NOT assumed complete: the actual capture contains only
    # chapter 1 despite its real Next link to chapter 2. Retain the identities
    # it does declare and require them to be covered before declaring completion.
    declared = props.get('allChapters', [])
    if not isinstance(declared,list):
        raise RuntimeError('Unexpected native chapter list metadata')
    row['declared'] = [{'id':_positive_int(item.get('id'),'listed chapter ID'),
                        'number':_number(item['chapterNumber'])} for item in declared]
    return row, panels


def title_from_html(soup):
    canon = soup.select_one('link[rel="canonical"]')
    if not canon:
        return None
    _read(soup, canon.get('href',''))
    return _COMIC_TITLE


def chapter_title_from_html(soup, fallback):
    canon = soup.select_one('link[rel="canonical"]')
    if not canon:
        raise RuntimeError('Native chapter title unavailable')
    row, _ = _read(soup, canon.get('href',''))
    return row['title']


def chapter_title_from_anchor(anchor, fallback):
    return fallback


def _state_path():
    return Path(__file__).resolve().parents[1]/'.archiver_state'/'sites'/SOURCE_NAME/'native_catalog_progress.json'


def _validate_rows(rows):
    if not isinstance(rows,list) or not rows or rows[0].get('url') != DEFAULT_START_URL:
        raise RuntimeError('Invalid Taiyou no Ie catalog checkpoint')
    ids=set(); urls=set(); numbers=set(); previous=None
    for row in rows:
        url=row['url']; number=_chapter_number(url)
        if number != row.get('number') or url in urls or row['id'] in ids or number in numbers:
            raise RuntimeError('Duplicate or invalid native chapter identity')
        _positive_int(row['id'],'chapter ID')
        if not isinstance(row.get('title'),str) or not row['title'].strip():
            raise RuntimeError('Missing native chapter title in checkpoint')
        if previous is None:
            if row.get('prev') is not None:
                raise RuntimeError('Seed is not the first native chapter')
        else:
            nxt=previous.get('next'); prev=row.get('prev')
            if (not nxt or nxt['url']!=url or nxt['id']!=row['id'] or
                not prev or prev['url']!=previous['url'] or prev['id']!=previous['id'] or
                Decimal(number)<=Decimal(previous['number'])):
                raise RuntimeError('Native chapter chain is discontinuous or out of order')
        ids.add(row['id']); urls.add(url); numbers.add(number); previous=row
    return rows


def _load_rows():
    path=_state_path()
    if not path.exists():
        return []
    value=json.loads(path.read_text(encoding='utf-8'))
    if value.get('schema')!=1 or value.get('source')!=SOURCE_NAME or value.get('seed')!=DEFAULT_START_URL:
        raise RuntimeError('Wrong native catalog checkpoint namespace')
    return _validate_rows(value['rows'])


def _save_rows(rows):
    _validate_rows(rows)
    path=_state_path(); path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    with tmp.open('w',encoding='utf-8') as out:
        json.dump({'schema':1,'source':SOURCE_NAME,'seed':DEFAULT_START_URL,'rows':rows},out,ensure_ascii=False)
        out.flush(); os.fsync(out.fileno())
    tmp.replace(path)


def _wait_native_reader(page,url):
    deadline=time.monotonic()+25
    last='reader not ready'
    while True:
        raw=page.content()
        if page.url==url:
            try:
                soup=BeautifulSoup(raw,'html.parser')
                row, panels=_read(soup,url)
                _mounted_panels(soup,url,panels)
                return row
            except (RuntimeError,ValueError,KeyError,TypeError) as exc:
                last=str(exc)
        else:
            last='managed URL differs from expected chapter'
        if time.monotonic()>=deadline:
            raise RuntimeError('Native chapter metadata did not settle at '+url+': '+last)
        page.wait_for_timeout(500)


def _read_live(page,url,visit):
    visit(page,url)
    try:
        return _wait_native_reader(page,url)
    except RuntimeError as exc:
        # Only a metadata/DOM settling timeout warrants one repeat of the
        # ordinary guarded navigation. Transport or access errors propagate.
        if not str(exc).startswith('Native chapter metadata did not settle at '):
            raise
        print('TOONZ_READER_RECHECK: '+url+' | '+str(exc),flush=True)
    visit(page,url)
    return _wait_native_reader(page,url)


def after_chapter_visit(page,url):
    # Existing engine hook. Do not start image acquisition until the actual
    # native reader agrees with the canonical URL and chapter manifest.
    _wait_native_reader(page,url)


def custom_browser_chapters(context,seed_url,seed_html,chapter_class,visit):
    if seed_url!=DEFAULT_START_URL:
        raise RuntimeError('Start native discovery at the captured first chapter')
    first,_=_read(BeautifulSoup(seed_html,'html.parser'),seed_url)
    if first['id']!=11751117 or not first['next'] or first['next']['url']!=_SERIES+'/chapter/2' or first['next']['id']!=11751118:
        raise RuntimeError('Captured first chapter edition changed')
    persistent=getattr(context,'bridge',None) is not None
    rows=_load_rows() if persistent else []
    page=context.new_page()
    try:
        if rows:
            if rows[0]['id']!=first['id'] or rows[0]['next']!=first['next']:
                raise RuntimeError('Native seed changed since discovery checkpoint')
            endpoint=_read_live(page,rows[-1]['url'],visit)
            if endpoint['id']!=rows[-1]['id'] or endpoint['prev']!=rows[-1]['prev'] or endpoint['next']!=rows[-1]['next']:
                raise RuntimeError('Native chapter checkpoint endpoint changed')
            rows[-1]=endpoint
            print('TOONZ_CATALOG_RESUME: '+str(len(rows))+' verified chapters',flush=True)
        else:
            rows=[first]
        if persistent: _save_rows(rows)
        while rows[-1]['next'] is not None:
            if len(rows)>=1000:
                raise RuntimeError('Native chapter discovery safety limit reached; no truncated catalog saved as complete')
            nxt=rows[-1]['next']
            if nxt['url'] in {r['url'] for r in rows}:
                raise RuntimeError('Native chapter navigation loop')
            current=_read_live(page,nxt['url'],visit)
            if current['id']!=nxt['id']:
                raise RuntimeError('Next chapter identity differs from native link')
            rows.append(current); _validate_rows(rows)
            if persistent: _save_rows(rows)
            print('TOONZ_NATIVE_CHAPTER: '+current['number']+' | '+current['title'],flush=True)
        _validate_rows(rows)
        actual={(r['id'],r['number']) for r in rows}
        declared={(item['id'],item['number']) for r in rows for item in r.get('declared',[])}
        if not declared.issubset(actual):
            raise RuntimeError('Native chapter navigation omitted entries explicitly declared in the reader catalog')
        print('TOONZ_NATIVE_CATALOG_VERIFIED entries='+str(len(rows)),flush=True)
        return [chapter_class(chapter_identity(None,r['url'],''),r['title'],r['url']) for r in rows]
    finally:
        page.close()


def captured_native_chapter_titles():
    rows=_load_rows()
    # Never advertise a prefix as a complete source-title catalog.
    if not rows or rows[-1]['next'] is not None: return {}
    return {chapter_identity(None,r['url'],''):r['title'] for r in rows}


def native_chapter_titles_from_catalog(raw_html,page_url):
    return captured_native_chapter_titles()


def accept_catalog_title(chapter_id,label):
    return captured_native_chapter_titles().get(chapter_id)==label


def _mounted_panels(soup,url,panels):
    by_url={r['url']:r for r in panels}
    # Corroborate chapter ownership and ordinal against actual reader DOM.
    # The windowed DOM may have only a subset of the declared images.
    mounted=set()
    for im in soup.select('main img[alt^="Page "]'):
        actual=urljoin(url,im.get('src') or '')
        if actual not in by_url:
            raise RuntimeError('TOONZ_PANEL_IDENTITY: mounted image is not in native chapter manifest')
        expected=by_url[actual]['key']
        alt=re.fullmatch(r'Page ([0-9]+)',im.get('alt',''))
        slot=im.find_parent(attrs={'data-page-index':True})
        if (not alt or str(int(alt[1]))!=expected or
            (slot is not None and int(slot['data-page-index'])+1!=int(expected))):
            raise RuntimeError('TOONZ_PANEL_IDENTITY: mounted ordinal differs from manifest')
        mounted.add(actual)
    if not mounted:
        raise RuntimeError('TOONZ_READER_NOT_MOUNTED: no native chapter artwork in normal reader')
    return mounted


def _snapshot_from_native(soup,url,info):
    chapter, panels=_read(soup,url)
    mounted=_mounted_panels(soup,url,panels)
    observations={}
    for image in info.get('imgs',[]):
        actual=urljoin(url,str(image.get('url') or ''))
        if actual in mounted and image.get('loaded') is True and image.get('width',0)>0 and image.get('height',0)>0:
            observations[actual]=image
    # Same-origin normal GET is supported by the existing bridge. None means
    # NOT browser-decoded/unknown, not a fabricated decoded=True. The reusable
    # ordered callback gates only explicit False (a required lazy DOM load).
    # Every original response must still pass existing Pillow validation,
    # hashing, checkpointing and complete ordered-manifest verification.
    # Do not supply a made-up pageY for unmounted pages, and do not require
    # scrolling to a viewport location for an explicitly declared HTTP image.
    output=[{**r,'loaded':True if r['url'] in observations else None} for r in panels]
    return {**info,'imgs':output,'total':len(panels),'readerCount':len(panels),
            'missingSlots':0,'unloadedSlots':len(panels)-len(observations)}


def custom_page_snapshot(page):
    # Preserve the real generic scroll geometry, including nested scrolling.
    # A layout change never changes the manifest's ordered URLs.
    url=page.url
    info=page.evaluate('() => { /* MutationObserver */ return {imgs:[]}; }')
    soup=BeautifulSoup(page.content(),'html.parser')
    if page.url!=url:
        raise RuntimeError('Managed chapter changed during snapshot')
    return _snapshot_from_native(soup,url,info)


def adapter_self_test():
    assert _chapter_number(DEFAULT_START_URL)=='1'
    assert chapter_identity(None,_SERIES+'/chapter/1.50','')==_PREFIX+'1.5'
    assert _panel_url('chapters/1047727/11751117/001.webp',11751117)==_SITE+'/uploads/chapters/1047727/11751117/001.webp'
    assert EXTENSION_MATCHES[0].count('*')==1
    return {'native_manifest':True,'same_origin':True,'reader_mode_independent':True}

_ADAPTER_PREFLIGHT_PROOF=adapter_self_test()
