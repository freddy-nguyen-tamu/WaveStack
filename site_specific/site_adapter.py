"""Your Eternal Lies — bonus chapters only, native Comix reader.
Only source-specific rules live here. Use the installed normal browser, native
navigation and decoded artwork; do not replay private APIs or bypass denials.
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

SOURCE_NAME = 'comix-your-eternal-lies-bonus'
STATE_STORAGE_MODE = 'scoped'
SOURCE_BROWSER_TRANSPORT = 'extension'
TITLE_ADAPTER_VERSION = 'comix-your-eternal-lies-bonus-20261126-v2'
SERIES_SLUG_HINT = 'your-eternal-lies-bonus-chapters'
_SITE = 'https://comix.to'
_PATH = '/title/xkwzm-your-eternal-lies/'
_SERIES_URL = _SITE + _PATH.rstrip('/')
_COMIC_TITLE = 'Your Eternal Lies'
_ARCHIVE_TITLE = 'Your Eternal Lies - Bonus Chapters'
_MANGA_HID = 'xkwzm'
_MANGA_ID = 47591
_DETAIL_KEY = json.dumps(['manga','detail',_MANGA_HID], separators=(',', ':'))
_PREFIX = SOURCE_NAME + '-chapter-'
_NUMBERS = tuple('75.'+str(i) for i in range(1,7))
_LAST = _NUMBERS[-1]
DEFAULT_START_URL = _SITE + _PATH + '7130706-chapter-75.1'
_NEXT = _SITE + _PATH + '7130720-chapter-75.2'
_LAST_URL = _SITE + _PATH + '11010610-chapter-75.6'
ALLOWED_HOSTS = ('comix.to',)
EXTENSION_MATCHES = (_SITE + _PATH + '*',)
TITLE_SELECTORS = ('title',)
READER_SELECTORS = ('.rpage-main__inner',)
BRIDGE_RENDERED_IMAGE_SELECTOR = '.rpage-main__inner .rpage-page[data-page] img.rpage-page__img'
PAGE_TOTAL_SELECTORS = ('.rpage-progress__seg',)
IMAGE_ATTRIBUTES = ('src',)
IMAGE_PLACEHOLDER_URL_MARKERS = ('/assets/gotaku-banner-',)
SOURCE_CONFIRMED_MISSING_PANELS = {}
CHAPTER_LIST_SELECTORS = ()
NEXT_NAV_SELECTORS = ()
PREV_NAV_SELECTORS = ()
CHAPTER_MENU_SELECTORS = ()
BRIDGE_IMAGE_HOSTS = ('lov.brianjournal.site', 'lov.designwithheart.site', 'lov.gentlelivingnotes.site', 'lov.littlecraftshop.site')
# Exact descriptive titles transcribed from the supplied expanded native menu.
_CAPTURED_TITLES = {'75.6': {'Manta': 'Afterword (The end)', 'Official': 'Afterword [END]'}, '75.5': {'Manta': 'Bonus Episode 5', 'Official': 'Bonus Episodes Finale - Series Finale'}, '75.4': {'Manta': 'Bonus Episode 4', 'Official': 'Bonus Episode 4'}, '75.3': {'Manta': 'Bonus Episode 3', 'Official': 'Bonus Episode 3'}, '75.2': {'Manta': 'Bonus Episode 2', 'Official': 'Bonus Chapter 2'}, '75.1': {'Manta': 'Bonus Episode 1', 'Official': 'Bonus Episode 1'}}


def _chapter_number(url):
    p = urlsplit(str(url or ''))
    if p.scheme != 'https' or p.netloc != 'comix.to' or p.query or p.fragment or not p.path.startswith(_PATH):
        raise ValueError('Unexpected Comix series/URL: '+str(url)[:180])
    m = re.fullmatch(r'[0-9]+-chapter-([0-9]+(?:\.[0-9]+)?)', p.path[len(_PATH):])
    if not m or m.group(1) not in _NUMBERS:
        raise ValueError('Outside selected bonus chapter range: '+p.path)
    return m.group(1)


def _id(number):
    return _PREFIX+number


def chapter_identity(anchor, url, label):
    return _id(_chapter_number(url))


def _json_script(soup,name):
    node=soup.select_one('script#'+name+'[type="application/json"]')
    if node is None: return {}
    value=json.loads(node.get_text())
    if not isinstance(value,dict): raise RuntimeError('Invalid native metadata '+name)
    return value


def _detail(soup):
    data=_json_script(soup,'initial-data')
    detail=data.get('queries',{}).get(_DETAIL_KEY,{})
    if (detail.get('hid')!=_MANGA_HID or detail.get('id')!=_MANGA_ID or detail.get('title')!=_COMIC_TITLE):
        raise RuntimeError('Native series identity mismatch')
    return detail


def title_from_html(soup):
    # engine.root_metadata('', source_url) is invoked before the normal browser
    # is opened. There is no document to authenticate at that point. Return the
    # configured title provisionally; the engine calls this hook again with the
    # real page before saving series identity or discovering any chapters.
    if not soup.contents:
        return _ARCHIVE_TITLE
    _detail(soup)
    return _ARCHIVE_TITLE


def _reader_group(soup):
    node=soup.select_one('.rpage-chap-ending__meta strong')
    return node.get_text(' ',strip=True) if node else ''


def _label(number,group):
    title=_CAPTURED_TITLES.get(number,{}).get(group)
    return 'Chapter '+number+(' — '+title if title else '')


def _reader_identity(soup,number,url=None):
    # The supplied capture has stale SSR read=75.5/7130743 and og:title=75.5,
    # but the hydrated reader, syncData, toolbar, ending and active menu agree
    # on 75.1. Treat only corroborated SSR lag as stale, not a same-number
    # edition mismatch or cross-series metadata.
    detail=_detail(soup)
    if Decimal(str(detail.get('latestChapter'))) != Decimal(_LAST):
        raise RuntimeError('Native available bonus range changed')
    sync=_json_script(soup,'syncData')
    if (sync.get('manga_id')!=_MANGA_HID or sync.get('name')!=_COMIC_TITLE
            or sync.get('manga_url')!=_SERIES_URL or str(sync.get('number'))!=number):
        raise RuntimeError('Native syncData chapter identity mismatch: '+number)
    title=soup.title.get_text(' ',strip=True) if soup.title else ''
    toolbar=soup.select_one('.rpage-floatctl__chap > .mono')
    ending=soup.select_one('.rpage-chap-ending__meta > span')
    comic=soup.select_one('.rpage-chap-ending__title')
    group=_reader_group(soup)
    if (title!=_COMIC_TITLE+' · Ch.'+number or toolbar is None or toolbar.get_text(strip=True)!='Ch.'+number
            or ending is None or ending.get_text(strip=True)!='Ch. '+number
            or comic is None or comic.get_text(strip=True)!=_COMIC_TITLE
            or urljoin(_SITE,comic.get('href',''))!=_SERIES_URL or not group):
        raise RuntimeError('Hydrated reader labels do not agree: '+number)
    active=soup.select('.rpage-modal--chaplist .rpage-chaplist__item.is-active')
    for node in active:
        num=node.select_one('.rpage-chaplist__num'); g=node.select_one('.rpage-chaplist__group')
        if not num or num.get_text(strip=True)!='Ch.'+number or not g or g.get_text(strip=True)!=group:
            raise RuntimeError('Active native menu row disagrees with reader')
    read=_json_script(soup,'initial-data').get('read',{})
    if read.get('mangaHid')!=_MANGA_HID or read.get('mangaId')!=_MANGA_ID:
        raise RuntimeError('Server metadata belongs to another series')
    native_number=str(read.get('chapterNumber'))
    if native_number==number:
        if url is not None and str(read.get('chapterId'))!=urlsplit(url).path.rsplit('/',1)[1].split('-chapter-')[0]:
            raise RuntimeError('Same-number native edition mismatch')
    else:
        og=soup.select_one('meta[property="og:title"]')
        if (not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?',native_number) or not og
                or og.get('content')!=_COMIC_TITLE+' · Ch.'+native_number):
            raise RuntimeError('Uncorroborated stale server metadata')
        if url is not None and str(read.get('chapterId'))==urlsplit(url).path.rsplit('/',1)[1].split('-chapter-')[0]:
            raise RuntimeError('Server ID and number contradict one another')
    return group


def chapter_title_from_anchor(anchor,fallback):
    return fallback


def chapter_title_from_html(soup,fallback):
    match=re.fullmatch(r'Chapter (75\.[1-6])(?: — .+)?',str(fallback))
    if not match: raise RuntimeError('Unexpected saved bonus chapter title: '+str(fallback))
    number=match.group(1)
    return _label(number,_reader_identity(soup,number))


def _native_next(raw,url):
    soup=BeautifulSoup(raw,'html.parser')
    number=_chapter_number(url)
    _reader_identity(soup,number,url)
    nxt=_json_script(soup,'syncData').get('next_chapter_url')
    if number==_LAST:
        if nxt: raise RuntimeError('Native navigation continues beyond captured bonus ending; verify range')
        return None
    expected=_NUMBERS[_NUMBERS.index(number)+1]
    if not nxt:
        # The detail explicitly declares the last URL. Only use it to bridge
        # the very final step, never to skip an interior bonus chapter.
        candidate=urljoin(url,str(_detail(soup).get('latestChapterUrl') or ''))
        if expected==_LAST and candidate==_LAST_URL:
            print('COMIX_NATIVE_FINAL_LINK: using declared last bonus URL',flush=True)
            return candidate
        raise RuntimeError('Native navigation ended before '+expected)
    target=urljoin(url,str(nxt))
    if _chapter_number(target)!=expected or (number==_NUMBERS[0] and target!=_NEXT):
        raise RuntimeError('Native next link skipped chapter or changed starting edition')
    return target


def _catalog_checkpoint():
    return Path(__file__).resolve().parents[1]/'.archiver_state'/'sites'/SOURCE_NAME/'native_bonus_catalog.json'


def _validate_prefix(rows):
    if not isinstance(rows,list) or not rows or len(rows)>len(_NUMBERS):
        raise ValueError('Invalid bonus catalog size')
    for i,row in enumerate(rows):
        if not isinstance(row,dict) or _chapter_number(row.get('url'))!=_NUMBERS[i]:
            raise ValueError('Bonus chapter catalog order mismatch')
        if not isinstance(row.get('group'),str) or not row['group'] or row.get('label')!=_label(_NUMBERS[i],row['group']):
            raise ValueError('Bonus catalog label/edition mismatch')
    if rows[0]['url']!=DEFAULT_START_URL or (len(rows)>1 and rows[1]['url']!=_NEXT):
        raise ValueError('Bonus catalog does not match captured starting edition')
    return rows


def _load_catalog():
    path=_catalog_checkpoint()
    if not path.exists(): return []
    obj=json.loads(path.read_text(encoding='utf-8'))
    if obj.get('schema')!=1 or obj.get('source')!=SOURCE_NAME or obj.get('seed')!=DEFAULT_START_URL:
        raise RuntimeError('Bonus checkpoint identity mismatch')
    return _validate_prefix(obj['rows'])


def _save_catalog(rows):
    _validate_prefix(rows)
    path=_catalog_checkpoint(); path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    with tmp.open('w',encoding='utf-8') as f:
        json.dump({'schema':1,'source':SOURCE_NAME,'seed':DEFAULT_START_URL,'rows':rows},f,ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    tmp.replace(path)


def _read_live(page,url,visit):
    # The existing visit callback owns source throttling and access checks.
    visit(page,url)
    deadline=time.monotonic()+25
    error='no native reader snapshot'
    while time.monotonic()<deadline:
        raw=page.content()
        try:
            if page.url!=url: raise RuntimeError('Managed tab is not at expected chapter')
            soup=BeautifulSoup(raw,'html.parser')
            group=_reader_identity(soup,_chapter_number(url),url)
            numbers,slots=_declared_slots(soup)
            if set(numbers)!=set(slots) or not any(slots.values()):
                raise RuntimeError('Native artwork slots not fully declared')
            return raw,group
        except (ValueError,RuntimeError,TypeError) as exc:
            error=str(exc)
        page.wait_for_timeout(500)
    raise RuntimeError('Native bonus reader did not settle at '+url+': '+error)


def custom_browser_chapters(context,seed_url,seed_html,chapter_class,visit):
    if seed_url!=DEFAULT_START_URL or _native_next(seed_html,seed_url)!=_NEXT:
        raise RuntimeError('Discovery must begin with the supplied bonus chapter URL')
    persistent=getattr(context,'bridge',None) is not None
    rows=_load_catalog() if persistent else []
    page=context.new_page()
    try:
        if rows:
            url=rows[-1]['url']; raw,group=_read_live(page,url,visit)
            if rows[-1]['group']!=group: raise RuntimeError('Saved bonus translation group changed')
            print('COMIX_BONUS_RESUME: '+str(len(rows))+' verified URLs',flush=True)
        else:
            url=seed_url; raw=seed_html
            soup=BeautifulSoup(raw,'html.parser'); group=_reader_identity(soup,_NUMBERS[0],url)
            numbers,slots=_declared_slots(soup)
            if set(numbers)!=set(slots) or not any(slots.values()): raise RuntimeError('Seed artwork slots not fully declared')
            rows=[{'url':url,'group':group,'label':_label(_NUMBERS[0],group)}]
            if persistent: _save_catalog(rows)
        while True:
            nxt=_native_next(raw,url)
            if nxt is None: break
            if len(rows)>=len(_NUMBERS): raise RuntimeError('Bonus range exceeded')
            raw,group=_read_live(page,nxt,visit)
            # Native next determines the actual edition; prefer the selected
            # translation, but preserve the title of the actual final reader.
            if group!=rows[0]['group'] and not (nxt==_LAST_URL and _chapter_number(nxt)==_LAST):
                raise RuntimeError('Native navigation changed translation group before final bonus chapter')
            url=nxt; number=_chapter_number(url)
            rows.append({'url':url,'group':group,'label':_label(number,group)})
            _validate_prefix(rows)
            if persistent: _save_catalog(rows)
            print('COMIX_BONUS_CHAPTER: '+rows[-1]['label']+' | '+group,flush=True)
        if len(_validate_prefix(rows))!=len(_NUMBERS): raise RuntimeError('Incomplete bonus catalog')
    finally:
        page.close()
    print('COMIX_BONUS_CATALOG_VERIFIED: 6 chapters (75.1–75.6)',flush=True)
    return [chapter_class(_id(_chapter_number(r['url'])),r['label'],r['url']) for r in rows]


def custom_chapters(raw_html,page_url,chapter_class):
    # Do not allow the generic anchor crawler to wander into the main story.
    raise RuntimeError('Bonus discovery requires the normal browser catalog hook')


def title_catalog_url(saved_url):
    return _SERIES_URL


def captured_native_chapter_titles():
    rows=_load_catalog()
    if len(rows)!=len(_NUMBERS): return {}
    return {_id(_chapter_number(r['url'])):r['label'] for r in rows}


def native_chapter_titles_from_catalog(raw_html,page_url):
    return captured_native_chapter_titles()


def accept_catalog_title(chapter_id,label):
    if not isinstance(chapter_id,str) or not chapter_id.startswith(_PREFIX): return False
    n=chapter_id[len(_PREFIX):]
    return n in _NUMBERS and (label=='Chapter '+n or label in {_label(n,g) for g in _CAPTURED_TITLES[n]})

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
    if set(slots) != set(numbers):
        raise RuntimeError('Native artwork slot set disagrees with declared page total')
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
    original_url = page.url
    number = _chapter_number(original_url)
    info = page.evaluate('() => { /* MutationObserver */ return {imgs:[]}; }')
    html = page.content()
    if page.url != original_url:
        raise RuntimeError('Managed tab changed chapter during snapshot')
    soup = BeautifulSoup(html, 'html.parser')
    _reader_identity(soup, number, original_url)
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



def adapter_self_test():
    # Exercise the URL-first startup contract, not just fully hydrated HTML.
    assert title_from_html(BeautifulSoup('', 'html.parser'))==_ARCHIVE_TITLE
    try:
        title_from_html(BeautifulSoup('<html><title>Another comic</title></html>', 'html.parser'))
    except RuntimeError:
        pass
    else:
        raise AssertionError('Nonempty unrelated document must not pass series identity')
    assert _chapter_number(DEFAULT_START_URL)=='75.1'
    assert _chapter_number(_NEXT)=='75.2'
    assert _chapter_number(_LAST_URL)=='75.6'
    assert EXTENSION_MATCHES[0].count('*')==1
    assert all(set(_CAPTURED_TITLES[n])=={'Official','Manta'} for n in _NUMBERS)
    assert not accept_catalog_title(_PREFIX+'75','Chapter 75')
    assert accept_rendered_image_url('https://future-cdn.example/hi/panel_1')
    assert not accept_rendered_image_url('https://future-cdn.example/ad.png')
    return {'bonus_chapters':len(_NUMBERS),'native_title_rows':sum(map(len,_CAPTURED_TITLES.values()))}

_ADAPTER_PREFLIGHT_PROOF=adapter_self_test()
if __name__=='__main__':
    print(adapter_self_test())

