#!/usr/bin/env python3
"""Authorized comic archive -> isolated GitHub Git repositories -> Cloudflare Pages.

This program deliberately does not modify system/global Git configuration and does
not automate login bypass or copyright permissions. Account login uses Git Credential
Manager's documented browser OAuth flow, with a private credential namespace.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import html
import io
import json
import logging
import mimetypes
import os
import re
import shutil
import threading
import queue
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import requests
from reusable.github_cooldown import response_delay, wait as github_wait, git_run, git_throttled, backoff, GitBatchTooLarge, git_size_rejected, cloudflare_retry_delay
from itertools import count
from bs4 import BeautifulSoup
from PIL import Image

from site_specific import site_adapter as ADAPTER

from .progress import Progress, duration, stop_progress
from .image_checkpoint import ChapterImageCheckpoint
from . import open_reader_verify_auth

from .source_session import (SourceAccessPaused, SourceManualActionRequired,
                            SourceRequestGuard, open_source_context, source_browser_context,
                            visit_source_page, classify_browser_page,
                            wait_for_manual_source_access, profile_directory)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".archiver_state"
CONFIG = json.loads((ROOT / "config/default.json").read_text(encoding="utf-8"))
LOG = logging.getLogger("comic")
UA = "Mozilla/5.0 (compatible; AuthorizedComicArchiver/0.3; Browser-verified)"
GITHUB_API = "https://api.github.com"
# Free-tier hard ceilings; lower configured settings remain valid.
CONFIG['github_max_file_bytes']=min(int(CONFIG['github_max_file_bytes']),100*1024**2)
CONFIG['cloudflare_max_file_bytes']=min(int(CONFIG['cloudflare_max_file_bytes']),25*1024**2)
CONFIG['cloudflare_project_max_files']=min(int(CONFIG['cloudflare_project_max_files']),20000)
CONFIG['cloudflare_file_target']=min(int(CONFIG['cloudflare_file_target']),CONFIG['cloudflare_project_max_files'])
CONFIG['pushes_per_minute']=max(1,min(int(CONFIG['pushes_per_minute']),6))
PAGES_LIMIT = CONFIG["cloudflare_max_file_bytes"]


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_slug(value: str, length=60):
    value = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return value[:length].rstrip("-") or "comic"


def clean_url(url):
    s = urlsplit(url)
    # Preserve query parameters that identify a chapter (episode_no, title_no etc.)
    return urlunsplit((s.scheme.lower(), s.netloc.lower(), s.path, s.query, ""))


def atomic_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8"))
    os.replace(tmp, path)


def refresh_extension():
    """Regenerate site-scoped extension from ONE source adapter, no manual edits."""
    template_dir = Path(__file__).resolve().parent / 'extension_templates'
    dst = ROOT / 'extension'
    dst.mkdir(parents=True, exist_ok=True)
    text = (template_dir / 'content.template.js').read_text(encoding='utf-8')
    for name, values in {
        '__READER_SELECTORS__': ADAPTER.READER_SELECTORS,
        '__NEXT_SELECTORS__': ADAPTER.NEXT_NAV_SELECTORS,
        '__PREV_SELECTORS__': ADAPTER.PREV_NAV_SELECTORS,
        '__IMAGE_ATTRIBUTES__': ADAPTER.IMAGE_ATTRIBUTES,
        '__INVALID_IMAGE_MARKERS__': getattr(ADAPTER, 'IMAGE_PLACEHOLDER_URL_MARKERS', ()),
    }.items():
        text = text.replace(name, json.dumps(list(values)))
    (dst / 'content.js').write_text(text, encoding='utf-8')
    manifest = json.loads((template_dir / 'manifest.template.json').read_text(encoding='utf-8'))
    manifest['content_scripts'][0]['matches'] = list(ADAPTER.EXTENSION_MATCHES)
    atomic_json(dst / 'manifest.json', manifest)
    return dst


def event(kind, **data):
    DATA.mkdir(exist_ok=True, parents=True)
    payload = {"at": utc(), "event": kind, **data}
    with (DATA / "events.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    LOG.info("%s %s", kind, " ".join(f"{k}={v}" for k, v in data.items() if k not in {"token", "password"}))


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DATA / "state.sqlite")
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS options(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters(
      chapter_id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'DISCOVERED',
      repository TEXT, commit_sha TEXT, bytes INTEGER NOT NULL DEFAULT 0,
      pages_json TEXT, published_url TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repositories(name TEXT PRIMARY KEY, logical_bytes INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0, last_sha TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS push_events(repository TEXT NOT NULL, ts REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS deployments(project TEXT PRIMARY KEY, product TEXT,
      production_url TEXT, deployed_at TEXT, files INTEGER DEFAULT 0, bytes INTEGER DEFAULT 0);
    """)
    con.commit()
    return con


def get_option(db, key, default=None):
    row = db.execute("SELECT value FROM options WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_option(db, key, value):
    with db:
        db.execute("REPLACE INTO options(key,value) VALUES(?,?)", (key, json.dumps(value)))


def root_metadata(raw: str, source_url: str | None = None):
    """Reusable document inspection using the single site's adapter."""
    soup = BeautifulSoup(raw, "html.parser")
    canon = soup.select_one('link[rel="canonical"]')
    url = html.unescape(source_url or (canon.get('href') if canon else '') or '')
    title = ADAPTER.title_from_html(soup)
    if not title:
        heading = soup.title.get_text(' ', strip=True) if soup.title else 'Untitled comic'
        title = re.split(r"\s*[·|—]\s*|\s+-\s+(?:Ep\.|Ch\.)", heading)[0].strip()
    return url, title


@dataclass(frozen=True)
class Chapter:
    chapter_id: str
    label: str
    url: str


def chapter_links(raw: str, page_url: str):
    """Original chapter-list and prev/next selectors are entirely in the adapter."""
    soup = BeautifulSoup(raw, 'html.parser')
    output, seen = [], set()
    items = []
    for selector in ADAPTER.CHAPTER_LIST_SELECTORS:
        items = soup.select(selector)
        if items:
            break
    for a in items:
        url = clean_url(urljoin(page_url, html.unescape(a.get('href') or '')))
        if not ensure_same_origin(page_url, url) or url in seen:
            continue
        label = a.get_text(' ', strip=True)
        ident = ADAPTER.chapter_identity(a, url, label)
        extractor = getattr(ADAPTER, 'chapter_title_from_anchor', None)
        if callable(extractor):
            label = extractor(a, label or f'Chapter {ident}')
        output.append(Chapter(str(ident), label or f'Chapter {ident}', url))
        seen.add(url)
    linked = []
    for selector in (*ADAPTER.NEXT_NAV_SELECTORS, *ADAPTER.PREV_NAV_SELECTORS):
        for a in soup.select(selector):
            url = clean_url(urljoin(page_url, html.unescape(a.get('href') or '')))
            if not ensure_same_origin(page_url, url) or url in seen:
                continue
            label = a.get('title') or a.get_text(' ', strip=True) or 'Chapter'
            ident = ADAPTER.chapter_identity(a, url, '')
            linked.append(Chapter(str(ident), label, url))
            seen.add(url)
    return output, linked


def chapter_title_from_source(raw: str, fallback: str) -> str:
    """Shared metadata pipeline; site-specific interpretation is in adapter."""
    resolver = getattr(ADAPTER, 'chapter_title_from_html', None)
    if not callable(resolver):
        return fallback
    result = resolver(BeautifulSoup(raw, 'html.parser'), fallback)
    return str(result).strip() if result and str(result).strip() else fallback


def custom_chapter_links(raw: str, page_url: str):
    """Generic fallback for sites that have no explicit native chapter list."""
    if callable(getattr(ADAPTER, 'custom_chapters', None)):
        custom = ADAPTER.custom_chapters(raw, page_url, Chapter)
        if custom is not None:
            return custom
    soup = BeautifulSoup(raw, 'html.parser')
    patterns = re.compile(r'(?:chapter|episode|/ch(?:\W|/)|/ep(?:\W|/)|/viewer(?:\W|/)|/read(?:\W|/))', re.I)
    seen, out = set(), []
    for a in soup.select('a[href]'):
        url = clean_url(urljoin(page_url, a.get('href', '')))
        if not ensure_same_origin(page_url, url) or url in seen:
            continue
        label = a.get_text(' ', strip=True) or a.get('aria-label', '') or a.get('title', '')
        if not (patterns.search(label) or patterns.search(urlsplit(url).path)):
            continue
        # Source-specific identifier rules belong entirely in the adapter,
        # even for the generic traversal fallback.
        ident = ADAPTER.chapter_identity(a, url, label)
        extractor = getattr(ADAPTER, 'chapter_title_from_anchor', None)
        if callable(extractor):
            label = extractor(a, label or f'Chapter {ident}')
        out.append(Chapter(str(ident), label or f'Chapter {ident}', url))
        seen.add(url)
    return out


def _native_list_popup(page):
    for selector in ADAPTER.CHAPTER_MENU_SELECTORS:
        try:
            loc = page.locator(selector)
            if loc.count():
                loc.first.click(timeout=2500)
                page.wait_for_timeout(350)
                ordered, neighbors = chapter_links(page.content(), page.url)
                if ordered or neighbors:
                    return ordered, neighbors
        except Exception:
            pass
    return [], []


def _img_selector(raw: str):
    soup = BeautifulSoup(raw, 'html.parser')
    for selector in ADAPTER.READER_SELECTORS:
        node = soup.select_one(selector)
        if node and node.select('img,[data-page]'):
            return selector
    for selector in ('[data-reader]', 'main', 'article'):
        node = soup.select_one(selector)
        if node and len(node.select('img,[data-page]')) >= 2:
            return selector
    return None


def snapshot_images(raw: str):
    soup = BeautifulSoup(raw, 'html.parser')
    selector = _img_selector(raw)
    container = soup.select_one(selector) if selector else next(
        (x for x in soup.select('div,section,article') if len(x.select('img'))>=3), soup)
    urls = []
    for node in container.select('img'):
        url = next((node.get(attr) for attr in ADAPTER.IMAGE_ATTRIBUTES if node.get(attr)), '')
        if url and not url.startswith(('data:', 'blob:')) and not any(marker in url for marker in getattr(ADAPTER, 'IMAGE_PLACEHOLDER_URL_MARKERS', ())):
            urls.append(url)
    return urls


def inspect_html(raw, url=None):
    url, title = root_metadata(raw, url)
    links, neighbors = chapter_links(raw, url)
    imgs = snapshot_images(raw)
    return {'title': title, 'url': url, 'series_slug': safe_slug(title),
            'native_chapter_list_count': len(links), 'native_navigation_fallbacks': len(neighbors),
            'visible_reader_images': len(imgs), 'first_chapters': [c.__dict__ for c in links[:6]],
            'image_selector': _img_selector(raw),
            'note': 'A static snapshot cannot prove additional lazy images or all chapters exist.'}


def ensure_same_origin(seed, candidate):
    s, c = urlsplit(seed), urlsplit(candidate)
    return s.scheme == c.scheme and s.netloc == c.netloc


class SourceImageServerUnavailable(RuntimeError):
    """One or more reader images have independently verified source-server failures.

    Unlike a capture/bridge error this must not terminate other chapters.
    The affected chapter remains incomplete, with its downloaded images
    checkpointed for a future retry. Never treat it as archived or publishable.
    """
    def __init__(self, chapter_id, missing):
        self.chapter_id = str(chapter_id)
        self.missing = dict(missing)
        super().__init__(f"Chapter {chapter_id}: server-failed image slots " +
                         ','.join(str(k) for k in missing) +
                         '; remaining images checkpointed, chapter deferred and NOT published')


def classify_source_image_server_error(url, report, *, prior_status=None):
    """Return a defensible server-failure classification or None.

    A broken image alone is never sufficient: use observed Chromium Network
    response metadata from the selected managed tab and same-URL DOM status.
    Server refusal / access challenges (401,403,429), blocked extensions,
    timeouts, debugger disconnections, and successful HTTP 200 with bad pixels
    are UNKNOWN/LOCAL failures, not automatically tolerable server failures.
    """
    if not isinstance(report, dict):
        return None
    # The selected-tab webRequest listener can independently confirm actual
    # source HTTP status when DevTools owns the debugger session.
    network = report.get('network')
    observed_via_web_request = (isinstance(network, dict) and
        network.get('source') == 'chrome.webRequest' and
        network.get('observedInManagedTab') is True)
    if report.get('debuggerReady') is not True and not observed_via_web_request:
        return None
    if report.get('capturedOriginal') is True:
        return None
    network, dom = report.get('network'), report.get('dom')
    if not isinstance(network, dict) or not isinstance(dom, dict):
        return None
    if report.get('url') != url or not dom.get('found') or dom.get('loaded') is not False:
        return None
    if network.get('failed') or network.get('fromServiceWorker'):
        return None
    try:
        status = int(network.get('status', 0))
    except (TypeError, ValueError):
        return None
    if status in (404, 410):
        reason = 'confirmed_image_http_' + str(status)
    elif 500 <= status <= 599 and prior_status is not None and 500 <= prior_status <= 599:
        reason = 'repeated_source_http_5xx_after_reload'
    else:
        return None
    return {'url':url, 'status':status, 'reason':reason,
            'dom_dimensions':dom.get('dimensions'), 'debugger_confirmed':True}


def adapter_confirmed_source_missing(page_url, chapter_id, key, selected, url, records):
    """Accept only exact adapter-declared source gaps with a broken DOM image.

    This is *not* an automatic HTTP-200 classification. Source-specific
    identities are supplied exclusively by site_specific/site_adapter.py.
    An image that decodes but cannot be captured is a LOCAL FAILURE.
    """
    if not isinstance(records, dict) or not selected or selected.get('loaded') is not False:
        return None
    try:
        target = str(page_url).rstrip('/')
        matching = [(str(k).rstrip('/'), value) for k,value in records.items()
                    if str(k).rstrip('/') == target]
        if len(matching) != 1:
            return None
        pages = matching[0][1]
        if not isinstance(pages, (list,tuple,set,frozenset)):
            return None
        if str(key) not in {str(int(n)) for n in pages if str(n).isdigit()}:
            return None
        from urllib.parse import urlsplit
        actual = urlsplit(str(url or ''))
        if actual.scheme != 'https' or not actual.netloc:
            return None
        if not str(chapter_id):
            return None
    except (ValueError, TypeError):
        return None
    return {'url': str(url), 'status': None,
            'reason': 'adapter_confirmed_origin_placeholder',
            'adapter_confirmed': True, 'dom_unloaded': True,
            'confirmation': 'verified_absent_on_multiple_devices'}


def scan_browser_images(page, max_steps=1500, stability=5, *, guard=None, visible=True,
                        manual_rounds=0, on_progress=None, checkpoint=None, recovery_reloads=0):
    """Lazily scroll the ORIGINAL site to discover ALL ordered reader images.

    Scroll modestly, sample after the site's own lazy loader has time to run,
    and wait for the actual reader DOM to settle at the true bottom.  The
    MutationObserver detects late image/attribute changes, including those
    arriving between samples. Missing placeholder URLs prevent completion.
    We never force-load an unknown source URL or guess missing pages.
    """
    script = r"""() => {
      const selectors=__SOURCE_READER_SELECTORS__; 
      let root=selectors.map(s=>document.querySelector(s))
        .find(x=>x && x.querySelectorAll('img,[data-page]').length>=1);
      if(!root) {
        const groups=[...document.querySelectorAll('main,article,section,div')]
          .filter(x=>x.querySelectorAll('img').length>=3);
        groups.sort((a,b)=>a.querySelectorAll('img').length-b.querySelectorAll('img').length);
        root=groups[0]||document.querySelector('main')||document.body;
      }
      // Keep an observer on the *reader*, not the entire website.  Reattach if
      // the reader is replaced during client-side navigation.
      let state=window.__comicArchiverLazyScan;
      if(!state || state.root!==root){
        if(state?.observer)state.observer.disconnect();
        state={root, revision:0};
        state.observer=new MutationObserver(muts=>{
          if(muts.length)state.revision++;
        });
        state.observer.observe(root,{subtree:true,childList:true,attributes:true,
          attributeFilter:['src','srcset','data-src','data-original','data-url','data-page','data-index']});
        window.__comicArchiverLazyScan=state;
      }
      const imgs=[...root.querySelectorAll('img')];
      let missingSlots=0;
      const data=imgs.map((im,i)=>{
        const key=im.closest('[data-page]')?.getAttribute('data-page')||
          im.getAttribute('data-index')||
          ((/^(?:page|p)\s*(\d+)$/i.exec(im.getAttribute('alt')||''))||[])[1]||String(i+1);
        const candidates=__SOURCE_IMAGE_ATTRS__
          .map(k=>im.getAttribute(k)||'');
        candidates.push(im.currentSrc||'');
        const url=candidates.find(u=>u && !u.startsWith('data:') &&
          !__SOURCE_PLACEHOLDER_MARKERS__.some(marker=>u.includes(marker)) && !u.startsWith('blob:'))||'';
        if(!url)missingSlots++;
        return {key,url,width:Number(im.getAttribute('width'))||im.naturalWidth||0,
          height:Number(im.getAttribute('height'))||im.naturalHeight||0};
      });
      const declaredPages=root.querySelectorAll('[data-page]').length;
      const readerCount=imgs.length;
      const total=declaredPages||readerCount;
      const html=document.documentElement,body=document.body;
      const height=Math.max(html.scrollHeight,body?.scrollHeight||0);
      const top=window.scrollY||html.scrollTop||0;
      const bottom=Math.max(0,height-innerHeight);
      return {imgs:data,total,readerCount:imgs.length,missingSlots,
        scrollY:top,bottom,height,revision:state.revision};
    }"""
    script = (script.replace('__SOURCE_READER_SELECTORS__', json.dumps(list(ADAPTER.READER_SELECTORS)))
                    .replace('__SOURCE_IMAGE_ATTRS__', json.dumps(list(ADAPTER.IMAGE_ATTRIBUTES)))
                    .replace('__SOURCE_PLACEHOLDER_MARKERS__', json.dumps(list(getattr(ADAPTER, 'IMAGE_PLACEHOLDER_URL_MARKERS', ())))))
    # A small advance (< one viewport) is intentional: jumping a full screen
    # can prevent IntersectionObserver-based sites from ever exposing an image.
    scroll_script = """() => {
      const move=Math.max(160,Math.min(560,Math.floor(innerHeight*0.55)));
      scrollTo({top:scrollY+move,behavior:'instant'});
      return move;
    }"""
    seen, order = {}, []
    # An immutable DOM slot index determines every output filename. This is
    # distinct from URL discovery, which may lag behind the image placeholder.
    slot_order = []
    revisit_attempts = {}
    expected = 0
    prev_signature = None
    stable_bottom = 0
    stable_unloaded = 0
    last_unloaded = None
    missing_slots = 0
    resume_catalog = False
    # Match the historically working two-stage reader flow: first allow the
    # website's normal lazy loader to run to the real bottom, THEN revisit
    # any genuinely missing image. A checkpoint catalog is not a scroll state.
    recovery_phase = False
    bottom_no_progress = 0
    previous_loading = None
    for step in range(max_steps):
        if step % 7 == 0:
            page_state = classify_browser_page(page)
            if page_state in ('challenge', 'login'):
                if not guard or manual_rounds >= 3:
                    raise SourceAccessPaused('Source repeatedly requires manual verification during lazy scrolling; '
                                             'archive state preserved')
                event('SOURCE_SCROLL_NEEDS_HUMAN', reason=page_state, scroll_step=step)
                wait_for_manual_source_access(page, page.url, guard, visible=visible,
                                             reason=f'{page_state} during chapter scrolling')
                # A challenge can replace the DOM and reset scroll position.
                # Restart counting image ordinals to avoid a partial/corrupted chapter.
                return scan_browser_images(page, max_steps=max_steps, stability=stability,
                                           guard=guard, visible=visible,
                                           manual_rounds=manual_rounds+1, on_progress=on_progress, checkpoint=checkpoint, recovery_reloads=recovery_reloads)
        snapshot_hook = getattr(ADAPTER, 'custom_page_snapshot', None)
        custom_info = snapshot_hook(page) if callable(snapshot_hook) else None
        info = custom_info if custom_info is not None else page.evaluate(script)
        expected = max(expected, int(info.get("total") or 0))
        missing_slots = int(info.get("missingSlots") or 0)
        # The extension's DOM snapshot reports actual browser image decode
        # readiness. An href alone is not proof that the CDN served an image.
        unloaded_slots = int(info.get("unloadedSlots") or 0)
        current_keys = []
        for i, im in enumerate(info["imgs"]):
            key = str(im.get('key', i+1))
            if key.isdigit():
                key = str(int(key))
            current_keys.append(key)
        if len(set(current_keys)) != len(current_keys):
            raise RuntimeError('Duplicate reader image ordinals: cannot preserve page order')
        if slot_order and (len(current_keys) < len(slot_order) or
                           current_keys[:len(slot_order)] != slot_order):
            raise RuntimeError('Reader changed the image order during scrolling; refusing to misnumber files')
        slot_order = current_keys
        if all(key.isdigit() for key in slot_order) and slot_order:
            first = int(slot_order[0])
            if [int(k) for k in slot_order] != list(range(first, first+len(slot_order))):
                raise RuntimeError('Reader numeric image ordinals are not in exact consecutive reading order')
        for im in info["imgs"]:
            u = im["url"]
            if not u or u.startswith(("data:", "blob:")) or any(marker in u for marker in getattr(ADAPTER, 'IMAGE_PLACEHOLDER_URL_MARKERS', ())):
                continue
            u = urljoin(page.url, u)
            if urlsplit(u).scheme not in ("https", "http"):
                continue
            key = str(im["key"])
            if key.isdigit():
                key = str(int(key))
            if key in seen and seen[key]["url"] != u:
                # If nodes are recycled, the DOM index is not a reliable page
                # identity. Stop rather than silently skipping/reordering pages.
                raise RuntimeError("Reader reused a page ordinal for a different image; source-specific virtual-page identity is required")
            if key not in seen:
                order.append(key)
            seen[key] = {"url":u,"width":im["width"],"height":im["height"]}
        if expected and len(seen) > expected:
            raise RuntimeError("More reader images than declared page count; inspect source page structure")
        actual_bottom = info["scrollY"] >= info["bottom"] - 4
        # If a previously verified full catalog is identical to the present
        # chapter DOM, no full forward traversal is needed on restart. Visit
        # ONLY incomplete slots; a mismatch reverts to ordinary scrolling.
        fast_resume = bool(checkpoint is not None and step == 0 and
                           checkpoint.catalog_matches(slot_order, seen, expected) and
                           callable(getattr(page, 'recover_unloaded_image', None)))
        if fast_resume:
            event('CHAPTER_RESUME_CATALOG_VERIFIED', chapter=checkpoint.chapter_id,
                  total=len(slot_order), strategy='missing-slots-only')
        if step == 0:
            resume_catalog = fast_resume
        # The 1.5.13 regression was treating a checkpoint catalog as though
        # the current browser had already scrolled to the bottom. That bypassed
        # the entire lazy-loading pass and spent its three retries at once.
        # Keep the real document position independent from verified metadata.
        targeted_mode = bool(actual_bottom or recovery_phase)
        bottom = actual_bottom
        info['physicalAtBottom'] = actual_bottom
        # No downloads beyond the first missing ordinal. The callback enforces
        # that hard barrier even while the browser scrolls to trigger normal
        # website lazy loading for the rest of the reader.
        saved_keys = set(on_progress(info, tuple(slot_order), dict(seen),
                                     targeted_mode) if on_progress else set())
        if not saved_keys.issubset(set(slot_order)):
            raise RuntimeError('Progress callback returned an unknown image ordinal')
        # An interrupted *mid-scroll* run has no bottom-verified catalog.
        # Revalidate its contiguous saved prefix, then reposition the real
        # browser to the FIRST missing DOM slot instead of rescrolling those
        # already-archived images. The rest of the chapter still gets scanned.
        resume_jump = False
        if (step == 0 and checkpoint is not None and not actual_bottom and slot_order):
            prefix = checkpoint.verified_prefix(slot_order, seen)
            if 0 < prefix < len(slot_order):
                key = slot_order[prefix]
                selected = next((im for im,k in zip(info['imgs'], current_keys) if k == key), {})
                recover = getattr(page, 'recover_unloaded_image', None)
                if callable(recover):
                    try:
                        recover(key, selected.get('url') or '')
                    except Exception as exc:
                        if getattr(exc, 'requires_bridge_reconnect', False):
                            raise
                        event('CHAPTER_RESUME_JUMP_UNAVAILABLE', chapter=checkpoint.chapter_id,
                              first_missing=key, reason=str(exc)[:180])
                    else:
                        resume_jump = True
                        event('CHAPTER_RESUME_SKIPPED_VERIFIED_PREFIX', chapter=checkpoint.chapter_id,
                              verified_pages=prefix, first_missing=key)

        server_missing = set(getattr(on_progress, 'server_missing_keys', ())) if on_progress else set()
        if not server_missing.issubset(set(slot_order)) or (server_missing & saved_keys):
            raise RuntimeError('Server-failure evidence does not match the current image catalog')
        all_accounted = bool(slot_order) and len(saved_keys | server_missing) == len(slot_order)
        signature = (len(seen), info["height"], info.get("revision",0),
                     missing_slots, unloaded_slots, int(info.get("readerCount") or 0),
                     len(saved_keys), len(server_missing))
        ready = ((not expected or len(seen) == expected) and not missing_slots and
                 (all_accounted if on_progress else not unloaded_slots))
        if (targeted_mode or (resume_catalog and all_accounted)) and ready and signature == prev_signature:
            stable_bottom += 1
        else:
            stable_bottom = 0
        # The previous implementation immediately exhausted recovery retries
        # at the first not-yet-decoded page. On lazy readers, a falling global
        # unloaded count is proof that ordinary loading is still in progress.
        # Wait for that progress to settle BEFORE any targeted recovery.
        pending_key = next((key for key in slot_order if key not in saved_keys), None)
        if pending_key in server_missing:
            pending_key = next((key for key in slot_order if key not in saved_keys and
                                key not in server_missing), None)
        selected = next((im for im,k in zip(info['imgs'], current_keys) if k == pending_key), None)
        capture_failed = getattr(on_progress, 'failed_key', None) == pending_key
        loading_state = (len(seen), unloaded_slots, len(saved_keys), missing_slots)
        if actual_bottom and pending_key and not recovery_phase:
            if (previous_loading is not None and
                loading_state[0] == previous_loading[0] and
                loading_state[1] >= previous_loading[1] and
                loading_state[2] == previous_loading[2] and
                loading_state[3] == previous_loading[3]):
                bottom_no_progress += 1
            else:
                bottom_no_progress = 0
            # A few real passive observations at the physical bottom are
            # enough to distinguish slow lazy loading from a persistent gap.
            # Never trigger reloading while other images are still arriving.
            if bottom_no_progress >= 6:
                recovery_phase = True
                event('SOURCE_LAZY_PASS_SETTLED', image_key=pending_key,
                      unloaded=unloaded_slots, idle_checks=bottom_no_progress,
                      note='normal forward loading complete; now targeting first unresolved ordinal')
        else:
            bottom_no_progress = 0
        previous_loading = loading_state
        # Explicit, human-verified source gaps are NOT transport errors.
        # Check the exact adapter chapter URL + ordinal AND this document's
        # still-broken <img>. Never excuse a decoded image whose capture failed.
        if on_progress and checkpoint is not None and recovery_phase:
            confirmations = getattr(ADAPTER, 'SOURCE_CONFIRMED_MISSING_PANELS', {})
            register = getattr(on_progress, 'confirm_server_failure', None)
            if callable(register) and isinstance(confirmations, dict):
                newly_confirmed = 0
                for image_key, im in zip(current_keys, info['imgs']):
                    if image_key in saved_keys or image_key in server_missing:
                        continue
                    resolved = seen.get(image_key)
                    if resolved is None or resolved['url'] != urljoin(page.url, im.get('url') or ''):
                        continue
                    classification = adapter_confirmed_source_missing(
                        page.url, checkpoint.chapter_id, image_key, im,
                        resolved['url'], confirmations)
                    if classification:
                        register(image_key, classification)
                        server_missing.add(image_key)
                        newly_confirmed += 1
                        event('SOURCE_IMAGE_EXPLICITLY_CONFIRMED_MISSING',
                              image_key=image_key, chapter=checkpoint.chapter_id,
                              source_url=page.url, continue_later_images=True,
                              source_record_in_adapter=True)
                if newly_confirmed:
                    # Reenter the checkpoint callback with the new exceptions
                    # before attempting any recovery command for these slots.
                    continue
        if on_progress and pending_key and recovery_phase:
            if selected is None:
                raise RuntimeError('Reader ordinal disappeared before verified capture: '+pending_key)
            attempts_done = revisit_attempts.get(pending_key, 0)
            if attempts_done >= 3:
                diag = getattr(page, 'image_diagnostics', None)
                if callable(diag) and selected.get('url'):
                    image_url = urljoin(page.url, selected['url'])
                    try:
                        details = diag(image_url)
                        event('SOURCE_IMAGE_NETWORK_DIAGNOSTICS',
                              image_key=pending_key,
                              network=details.get('network'),
                              dom=details.get('dom'),
                              debugger_ready=details.get('debuggerReady'))
                        seen_status = (details.get('network') or {}).get('status')
                        network_seen = getattr(on_progress, 'server_network_observations', None)
                        if network_seen is None:
                            network_seen = {}
                            on_progress.server_network_observations = network_seen
                        earlier = network_seen.get(pending_key)
                        classification = classify_source_image_server_error(
                            image_url, details,
                            prior_status=(earlier if recovery_reloads > 0 else None))
                        if classification:
                            register = getattr(on_progress, 'confirm_server_failure', None)
                            if callable(register):
                                register(pending_key, classification)
                                event('SOURCE_IMAGE_SERVER_FAILURE_TOLERATED',
                                      image_key=pending_key, status=classification['status'],
                                      reason=classification['reason'],
                                      chapter_will_remain_unpublished=True,
                                      continue_later_images=True)
                                revisit_attempts.pop(pending_key, None)
                                prev_signature = None
                                continue
                        if isinstance(seen_status, int) and 500 <= seen_status <= 599:
                            network_seen[pending_key] = seen_status
                    except Exception as exc:
                        if getattr(exc, 'requires_bridge_reconnect', False):
                            raise
                        event('SOURCE_IMAGE_NETWORK_DIAGNOSTICS_UNAVAILABLE',
                              image_key=pending_key,error_type=type(exc).__name__,
                              reason=str(exc)[:180])
                if recovery_reloads == 0 and callable(getattr(page, 'goto', None)):
                    event('SOURCE_IMAGE_FINAL_CHAPTER_RELOAD', image_key=pending_key,
                          verified_before=len(saved_keys), strategy='one-reload-then-retry')
                    if guard:
                        visit_source_page(page, page.url, guard, visible=visible)
                    else:
                        page.goto(page.url, wait_until='domcontentloaded', timeout=50000)
                    after = getattr(ADAPTER, 'after_chapter_visit', None)
                    if callable(after):
                        after(page, page.url)
                    reset_attempts = getattr(on_progress, 'reset_after_reload', None)
                    if callable(reset_attempts):
                        reset_attempts()
                    return scan_browser_images(page, max_steps=max_steps,
                        stability=stability, guard=guard, visible=visible,
                        manual_rounds=manual_rounds, on_progress=on_progress,
                        checkpoint=checkpoint, recovery_reloads=1)
                # Report just the actual gap. Subsequent slots are deliberately
                # not attempted, not individually defective images.
                raise RuntimeError('First missing image after natural lazy loading and targeted recovery: ' +
                                   pending_key + '; later images deliberately not attempted. Chapter not published.')
            revisit_attempts[pending_key] = attempts_done + 1
            action = getattr(page, 'recover_unloaded_image', None)
            event('SOURCE_IMAGE_TARGETED_RETRY', image_key=pending_key,
                  attempt=revisit_attempts[pending_key],
                  decoded=bool(selected.get('loaded')),
                  blocking_later_images=True, phase='after-natural-lazy-pass')
            if callable(action):
                try:
                    try:
                        result = action(pending_key, selected.get('url') or '',
                                        force_position=True,
                                        refresh_source=(attempts_done == 1))
                    except TypeError as signature_error:
                        if 'unexpected keyword argument' not in str(signature_error):
                            raise
                        result = action(pending_key, selected.get('url') or '')
                except SourceAccessPaused:
                    raise
                except RuntimeError as exc:
                    # A broken transport cannot recover the next image either.
                    # Keep the old deferred retry for genuine per-image failures.
                    if getattr(exc, 'requires_bridge_reconnect', False):
                        raise
                    event('SOURCE_IMAGE_RECOVERY_DEFERRED', image_key=pending_key,
                          attempt=revisit_attempts[pending_key],
                          error_type=type(exc).__name__, reason=str(exc)[:240])
                else:
                    event('SOURCE_IMAGE_TARGETED_RESULT', image_key=pending_key,
                          loaded=bool(result.get('loaded')), reason=result.get('reason',''))
            page.wait_for_timeout(300)
            stable_unloaded = 0
            last_unloaded = None
        elif not on_progress and bottom and expected and len(seen) == expected and not missing_slots and unloaded_slots:
            stable_unloaded = stable_unloaded + 1 if unloaded_slots == last_unloaded else 1
            last_unloaded = unloaded_slots
            if stable_unloaded >= 25:
                raise RuntimeError(
                    f"Chapter scan reached the bottom, but {unloaded_slots}/{expected} source images "
                    "are still not visibly loaded in the browser (naturalWidth=0). "
                    "Inspect the normal tab's CDN image loading; no incomplete chapter was archived."
                )
        else:
            stable_unloaded = 0
            last_unloaded = None
        if step % 25 == 0 or (targeted_mode and stable_bottom == 0):
            event("SOURCE_LAZY_SCROLL_PROGRESS", step=step, discovered=len(seen),
                  expected=expected or None, unresolved_slots=missing_slots,
                  browser_images_not_loaded=unloaded_slots,
                  downloaded_during_scroll=len(saved_keys) if on_progress else None,
                  at_bottom=actual_bottom, resume_missing_only=resume_catalog, stable_checks=stable_bottom)
        if stable_bottom >= stability:
            break
        prev_signature = signature
        # Never scroll beyond a missing image currently in reach. Resume the
        # forward pass only after it has been captured and checkpointed.
        # Restore the old working forward pass: normal scrolling can continue
        # loading the website's images, but the checkpoint callback blocks
        # saving anything beyond the first unresolved ordinal.
        if not targeted_mode and not resume_jump and not (resume_catalog and all_accounted):
            page.evaluate(scroll_script)
        # Observe the *original reader* after the slow scroll.  A late src/data
        # mutation is picked up in the next sample, and resets stability.
        # At a real bottom with a pending gap, sleep passively rather than
        # repeatedly touching the page while its own image requests finish.
        # This grace interval costs nothing on healthy, complete chapters.
        page.wait_for_timeout(1600 if actual_bottom and pending_key and not recovery_phase
                              else 350 if targeted_mode else 300)
    else:
        if on_progress:
            raise RuntimeError('Streaming chapter scan exhausted without verified ordered images; '
                               'downloaded ' + str(len(saved_keys)) + '/' + str(len(slot_order)) +
                               '; no incomplete chapter archived')
        if unloaded_slots:
            raise RuntimeError(f"Lazy-scroll incomplete: {unloaded_slots} chapter images never finished loading in the browser "
                               "(naturalWidth=0). The source tab must display the actual images before archiving; "
                               "the CDN may be blocking those requests")
        if missing_slots:
            raise RuntimeError(f"Lazy-scroll incomplete: {missing_slots} reader image placeholders have no usable source URL (found {len(seen)}/{expected or '?'} images)")
        if expected and len(seen) < expected:
            raise RuntimeError(f"Lazy-scroll incomplete: only {len(seen)}/{expected} reader images found")
        raise RuntimeError("Lazy-scroll scan exhausted before a stable, complete chapter bottom was established")
    if expected and len(seen) != expected:
        raise RuntimeError(f"Missing reader images: found {len(seen)} of {expected}")
    if not order:
        raise RuntimeError("No chapter images identified in the original reader")
    if on_progress:
        if not slot_order or set(order) != set(slot_order):
            raise RuntimeError('Reader ended with unresolved source image URLs; no incomplete chapter published')
        order = list(slot_order)  # DOM reading order, never URL-arrival order.
    if all(k.isdigit() for k in order):
        order = sorted(order, key=lambda k: int(k))
        first = int(order[0])
        if expected and [int(k) for k in order] != list(range(first,first+expected)):
            raise RuntimeError("Page ordinals have gaps or duplicates")
    if on_progress and len(saved_keys | server_missing) != len(slot_order):
        raise RuntimeError('Streaming scan did not resolve every page in DOM order')
    event("SOURCE_LAZY_SCROLL_COMPLETE", discovered=len(order),
          expected=expected or None, downloaded_during_scroll=len(saved_keys) if on_progress else None,
          scroll_steps=step+1,
          stable_bottom_checks=stable_bottom)
    return [(key,seen[key]) for key in order]


def image_download(ctx, url, dest: Path, page_url, max_tries=4, guard=None, *, page=None, visible=True):
    """Validated image fetch using the persistent context's own cookie jar.

    Do not import cookies from another browser, spoof fingerprints, or ignore
    explicit access blocks. A 429 sets a durable per-host cooldown.
    """
    last_error = None
    manual_image_check_done = False
    # Do not throttle local transfer of already-rendered images as though it
    # were an extra CDN HTTP GET. Real HTTP requests still obey source pacing
    # and Retry-After. The browser's normal page loading is not accelerated.
    local_browser_transfer = (getattr(ctx.request, 'reuses_loaded_page_images', False)
                              and urlsplit(url).hostname != urlsplit(page_url).hostname)
    for attempt in range(max_tries):
        try:
            if guard is not None and not local_browser_transfer:
                guard.before(url, operation="image-download")
            response = ctx.request.get(
                url, headers={"Referer": page_url,
                              "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"},
                timeout=45000,
            )
            if response.status in (401, 403) and page is not None and guard is not None and not manual_image_check_done:
                # A CDN 403 might be a genuine access denial, not a CAPTCHA.
                # Offer ONE human-only check in the original reader, then
                # retry the original request once. If still blocked, stop.
                manual_image_check_done = True
                event('SOURCE_IMAGE_ACCESS_NEEDS_HUMAN', host=urlsplit(url).hostname,
                      status=response.status, source_page=page_url)
                wait_for_manual_source_access(
                    page, page_url, guard, visible=visible,
                    reason=f'image host HTTP {response.status}; verify normal site access')
                continue
            if guard is not None and not local_browser_transfer:
                guard.response(response.url, response.status, response.headers)
            if response.status in {500, 502, 503, 504}:
                retry = response.headers.get("retry-after")
                from source_session import retry_after_seconds
                retry_seconds = retry_after_seconds(retry)
                wait = max(2., min(45., retry_seconds if retry_seconds is not None else 2 ** (attempt + 1)))
                event("IMAGE_SERVER_RETRY", host=urlsplit(url).hostname,
                      status=response.status, wait_seconds=round(wait, 2))
                time.sleep(wait)
                continue
            if not response.ok:
                raise RuntimeError(f"HTTP {response.status} from image host {urlsplit(url).hostname}")
            raw = response.body()
            if len(raw) > CONFIG["github_max_file_bytes"]:
                raise RuntimeError("IMAGE_EXCEEDS_GITHUB_FILE_LIMIT")
            with Image.open(io.BytesIO(raw)) as im:
                fmt = im.format
                width, height = im.size
                im.verify()
            ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif",
                   "AVIF": "avif", "BMP": "bmp"}.get((fmt or "").upper())
            if not ext or width <= 0 or height <= 0:
                raise RuntimeError("Unsupported or invalid image format")
            target = dest.with_suffix("." + ext)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            return target, {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                            "width": width, "height": height, "format": ext, "source_url": url}
        except SourceAccessPaused:
            # Never retry a known access restriction with alternate identities.
            raise
        except Exception as exc:
            if getattr(exc, 'requires_bridge_reconnect', False):
                raise
            last_error = exc
            if "EXCEEDS" in str(exc) or "HTTP 403" in str(exc) or "HTTP 401" in str(exc):
                break
            if attempt + 1 < max_tries:
                delay = min(2 ** attempt + 1, 12)
                event("IMAGE_RETRY", host=urlsplit(url).hostname, attempt=attempt + 1,
                      wait_seconds=delay, error_type=type(exc).__name__)
                time.sleep(delay)
    raise RuntimeError(f"Image download failed after {max_tries} attempts: {last_error}")


def _app_git_tools():
    """Find installed/portable Git + GCM without changing any global PATH/config.

    Git for Windows frequently exposes git.exe in cmd/ on PATH, while the
    git-credential-manager.exe binary lives only in mingw64/bin/; checking
    shutil.which('git-credential-manager') alone is therefore incorrect.
    """
    git = shutil.which("git") or shutil.which("git.exe")
    gcm = shutil.which("git-credential-manager") or shutil.which("git-credential-manager.exe")
    roots = [ROOT / ".archiver_tools" / "PortableGit"]
    for key in ("ProgramFiles", "ProgramFiles(x86)"):
        if os.environ.get(key):
            roots.append(Path(os.environ[key]) / "Git")
    if os.name == "nt":
        roots.append(Path(r"C:\Program Files\Git"))
    if git:
        gp = Path(git).resolve()
        roots.extend((gp.parent.parent, gp.parent))
    for root in roots:
        if not git:
            for rel in ("cmd/git.exe", "bin/git.exe", "git.exe"):
                candidate = root / rel
                if candidate.is_file():
                    git = str(candidate)
                    break
        if not gcm:
            for rel in ("mingw64/bin/git-credential-manager.exe",
                        "mingw64/libexec/git-core/git-credential-manager.exe",
                        "cmd/git-credential-manager.exe",
                        "bin/git-credential-manager.exe",
                        "git-credential-manager.exe"):
                candidate = root / rel
                if candidate.is_file():
                    gcm = str(candidate)
                    break
    return git, gcm


def _shared_github_auth_metadata():
    """Read only NONSECRET account/namespace metadata from the old app state.

    Series-specific state must not fragment authorization. The GCM namespace
    points to the existing secure OS credential-store entry; no token/cookie
    is read from or copied into SQLite or a file here.
    """
    root_state = ROOT / ".archiver_state"
    root_db = root_state / "state.sqlite"
    candidates = []
    # A deliberate app-only account switch takes precedence over legacy roots.
    saved = root_state / "shared_github_auth.json"
    if saved.is_file():
        try:
            data = json.loads(saved.read_text(encoding='utf-8'))
            candidates.append((data.get('owner'), data.get('namespace')))
        except (OSError, ValueError):
            pass
    if root_db.is_file():
        try:
            with contextlib.closing(sqlite3.connect(str(root_db), timeout=5)) as old:
                rows = dict(old.execute(
                    "SELECT key,value FROM options "
                    "WHERE key IN ('github_owner','github_credential_namespace')"
                ).fetchall())
            candidates.append((json.loads(rows.get('github_owner', 'null')),
                               json.loads(rows.get('github_credential_namespace', 'null'))))
        except (sqlite3.Error, ValueError, TypeError) as exc:
            LOG.warning('Legacy app login metadata unavailable: %s', type(exc).__name__)
    for owner, namespace in candidates:
        if (isinstance(owner, str) and re.fullmatch(r'[A-Za-z0-9-]{1,39}', owner) and
            isinstance(namespace, str) and re.fullmatch(r'[A-Za-z0-9_.-]{8,160}', namespace)):
            return owner, namespace
    return None


def _save_shared_github_auth(owner, namespace):
    """Keep only a username and credential namespace, never an OAuth secret."""
    if not (isinstance(owner, str) and isinstance(namespace, str)):
        return
    atomic_json(ROOT / '.archiver_state' / 'shared_github_auth.json',
                {'owner': owner, 'namespace': namespace})


def _inherit_shared_github_auth(db):
    if get_option(db, 'github_owner') or get_option(db, 'github_auth_auto_import_disabled', False):
        return False
    candidate = _shared_github_auth_metadata()
    if candidate is None:
        return False
    owner, namespace = candidate
    with db:
        db.execute("REPLACE INTO options(key,value) VALUES(?,?)",
                   ('github_owner', json.dumps(owner)))
        db.execute("REPLACE INTO options(key,value) VALUES(?,?)",
                   ('github_credential_namespace', json.dumps(namespace)))
    event('GITHUB_APP_LOGIN_REUSED', account=owner, credentials='OS-credential-manager',
          source_requests=0, terminal_git_changes=0)
    return True


def isolated_git_environment():
    DATA.mkdir(parents=True, exist_ok=True)
    cfg = DATA / "isolated-gitconfig"
    if not cfg.exists():
        cfg.write_text("[credential]\n\thelper = manager\n\tuseHttpPath = false\n[init]\n\tdefaultBranch = main\n", encoding="utf-8")
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(("GIT_CONFIG_", "GIT_ASKPASS", "GCM_")) or key in {"SSH_ASKPASS", "GITHUB_TOKEN", "GH_TOKEN", "GIT_SSH_COMMAND", "GIT_SSH"}:
            del env[key]
    env.update({"GIT_CONFIG_GLOBAL": str(cfg), "GIT_CONFIG_NOSYSTEM": "1",
                "GCM_NAMESPACE": "universal-comic-archiver-2026", "GCM_GITHUB_AUTHMODES": "browser",
                "GCM_PROVIDER": "github", "GIT_TERMINAL_PROMPT": "1"})
    # COMICARCHIVER_AUTH_BLOB_TRANSFER_20261122 — use existing selected GitHub auth; no background OAuth.
    shared_auth = _shared_github_auth_metadata()
    if shared_auth is not None:
        env['GCM_NAMESPACE'] = shared_auth[1]
    env['GCM_INTERACTIVE'] = '0'
    env['GIT_TERMINAL_PROMPT'] = '0'
    # Fix the *child* environment only. No system/user PATH changes; no
    # git config --global, credential-helper overwrite or other account logout.
    git_bin, gcm_bin = _app_git_tools()
    additional = [str(Path(p).parent) for p in (git_bin, gcm_bin) if p]
    if additional:
        env['PATH'] = os.pathsep.join(additional + [env.get('PATH', '')])
    return env


def git(args, *, cwd=None, check=True, stdin=None, text_output=True):
    p = git_run(["git", *args], input=stdin, cwd=cwd, env=isolated_git_environment(),
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        # Git errors can contain remote URLs; no tokens are ever placed in URLs by us.
        raise RuntimeError("Git command failed: " + " ".join(args[:3]) + ": " + p.stderr[-1600:])
    return p.stdout.strip() if text_output else p


def github_login(db, force=False):
    """Begin interactive GitHub browser OAuth with *isolated* GCM credentials.

    Do not ask for an account name or a manually created token. GCM presents the
    actual supported browser authentication flow. Verify the authenticated
    identity from GitHub itself before allowing any upload. The existing
    terminal/global credentials are never selected as a fallback.
    """
    installed_git, installed_gcm = _app_git_tools()
    if not installed_git or not installed_gcm:
        raise RuntimeError("Git Credential Manager was not found in the existing Git or archiver-local portable Git installation. Run setup_and_publish.ps1 once; existing Git configuration will not be changed.")
    current = get_option(db, "github_owner")
    if current and not force:
        return credential_for_selected(db)
    namespace = "comic-archiver-browser-" + uuid.uuid4().hex
    env = isolated_git_environment()
    env["GCM_NAMESPACE"] = namespace
    env["GCM_GITHUB_AUTHMODES"] = "browser"
    # Only this explicit login path may open browser OAuth.
    env['GCM_INTERACTIVE'] = 'auto'
    env['GIT_TERMINAL_PROMPT'] = '1'
    print("\nGITHUB SIGN-IN")
    print("Git Credential Manager will open GitHub's official browser sign-in.")
    print("Choose the account for this comic archiver, not necessarily your terminal's account.")
    print("No manually created token, saved HTML file, or Git configuration changes are needed.")
    # Username intentionally omitted so the browser account choice comes first.
    prompt = "protocol=https\nhost=github.com\n\n"
    proc = git_run(["git", "credential", "fill"], input=prompt,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if proc.returncode:
        raise RuntimeError("GitHub browser sign-in was not completed. Retry the setup or --github-login. "
                           + proc.stderr[-350:])
    secret = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
    token = secret.get("password")
    if not token:
        raise RuntimeError("Git Credential Manager did not return a usable authentication result")
    response = _github_read_with_retry(requests.get, GITHUB_API + "/user", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"}, timeout=20)
    if response.status_code != 200:
        raise RuntimeError(f"GitHub identity verification failed (HTTP {response.status_code}). No upload attempted.")
    actual = response.json().get("login", "")
    if not actual:
        raise RuntimeError("GitHub did not identify the signed-in user; refusing to proceed")
    print(f"\nSigned in to GitHub as @{actual}.")
    if current and current.lower() != actual.lower():
        print(f"Previously selected archiver account: @{current}. The other account remains untouched.")
    if input(f"Use @{actual} for this archiver's repositories? [y/N]: ").strip().lower() != "y":
        print("To choose another account, switch accounts at https://github.com in the browser,")
        print("then rerun with --github-login. Your existing terminal Git configuration stays unchanged.")
        raise RuntimeError("GitHub account was not confirmed; no upload attempted")
    set_option(db, "github_owner", actual)
    set_option(db, "github_credential_namespace", namespace)
    set_option(db, "github_auth_auto_import_disabled", False)
    _save_shared_github_auth(actual, namespace)
    event("GITHUB_LOGIN_CONFIRMED", account=actual)
    return actual, token


def _github_read_with_retry(request, *args, **kwargs):
    """Bounded retries for read-only GitHub requests; never replay a write."""
    attempt = 0
    rate_attempt = 0
    while True:
        try:
            response = request(*args, **kwargs)
        except requests.exceptions.SSLError:
            raise
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            if attempt == 2:
                raise RuntimeError('GitHub read unavailable after 3 attempts; existing checkpoints retained. Retry the normal run later.') from exc
            reason = type(exc).__name__
        else:
            delay = response_delay(response, rate_attempt)
            if delay is not None:
                event('WAIT_GITHUB_API', wait_seconds=delay, reason='explicit_rate_limit')
                github_wait(delay, 'GitHub API read rate limit', sleep=time.sleep)
                rate_attempt += 1
                continue
            if response.status_code not in (408, 500, 502, 503, 504) or attempt == 2:
                return response
            reason = 'HTTP ' + str(response.status_code)
        delay = 2 ** (attempt + 1)
        event('GITHUB_READ_RETRY', attempt=attempt + 1, next_attempt=attempt + 2, wait_seconds=delay, reason=reason)
        time.sleep(delay)
        attempt += 1


def credential_for_selected(db):
    _inherit_shared_github_auth(db)
    owner = get_option(db, "github_owner")
    if not owner:
        raise RuntimeError('No saved GitHub account. Run python run.py --github-login once; normal archiving must not start OAuth.')
    env = isolated_git_environment()
    namespace = get_option(db, "github_credential_namespace")
    if not namespace:
        raise RuntimeError('Saved GitHub namespace missing. Run python run.py --github-login once; no implicit OAuth attempted.')
    env["GCM_NAMESPACE"] = namespace
    p = git_run(["git", "credential", "fill"], input=f"protocol=https\nhost=github.com\nusername={owner}\n\n",
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if p.returncode:
        raise RuntimeError('Saved GitHub credential lookup failed for the selected namespace. '
                           'Run python run.py --github-login once; no repeated OAuth will launch. '
                           + p.stderr[-240:])
    values = dict(line.split("=", 1) for line in p.stdout.splitlines() if "=" in line)
    token = values.get("password")
    if not token:
        raise RuntimeError("Selected account credentials unavailable")
    r = _github_read_with_retry(requests.get, GITHUB_API + "/user", headers={"Authorization": f"Bearer {token}",
                     "Accept": "application/vnd.github+json"}, timeout=20)
    if r.status_code != 200:
        if r.status_code in (401, 403):
            raise RuntimeError(f"GitHub identity verification denied (HTTP {r.status_code}); refusing push. Check credentials or rate limits.")
        raise RuntimeError(f"GitHub identity verification unavailable (HTTP {r.status_code}); checkpoints retained; retry normal run later.")
    if r.json().get("login", "").lower() != owner.lower():
        raise RuntimeError("GitHub login identity mismatch. Run --github-login again; refusing push.")
    return owner, token


def github_http(method, url, token, **kwargs):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    headers.update(kwargs.pop("headers", {}))
    for attempt in count():
        if method.upper() in {'GET', 'HEAD'}:
            response = _github_read_with_retry(requests.request, method, url, headers=headers, timeout=40, **kwargs)
        else:
            # Retry only an explicitly rejected rate-limited write. Never replay
            # a connection loss, 5xx, or an ordinary permission denial here.
            response = requests.request(method, url, headers=headers, timeout=40, **kwargs)
        remaining = response.headers.get('X-RateLimit-Remaining')
        event('GITHUB_API_QUOTA', method=method, status=response.status_code,
              remaining=remaining or 'UNKNOWN', reset_unix=response.headers.get('X-RateLimit-Reset') or 'UNKNOWN')
        delay = response_delay(response, attempt)
        if delay is None:
            return response
        event('WAIT_GITHUB_API', wait_seconds=delay, reason='explicit_rate_limit')
        github_wait(delay, 'GitHub API write rate limit', sleep=time.sleep)


def ensure_remote_repo(name, db, token):
    owner = get_option(db, "github_owner")
    header = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    r = github_http("GET", f"{GITHUB_API}/repos/{owner}/{name}", token)
    if r.status_code == 200:
        j = r.json()
        if j["owner"]["login"].lower() != owner.lower():
            raise RuntimeError("Repository owner mismatch")
        if not j.get("private"):
            raise RuntimeError("Existing repository is not private; refusing to use it without explicit configuration")
        event("GITHUB_REPOSITORY_USAGE", repo=name, provider_repo_kib=j.get("size", "UNKNOWN"))
        return f"https://github.com/{owner}/{name}.git"
    if r.status_code != 404:
        raise RuntimeError(f"Repository lookup HTTP {r.status_code}, possible API quota/authorization problem")
    event("GITHUB_CREATE_REPO_REQUESTED", repo=name)
    r = github_http("POST", f"{GITHUB_API}/user/repos", token, json={"name": name, "private": True,
                      "auto_init": False, "description": "Authorized comic image archive"})
    if r.status_code not in (201,):
        print(f"Automatic repository creation unavailable (HTTP {r.status_code}).")
        print(f"In the browser, create a PRIVATE repository named {name} under account {owner}.")
        webbrowser.open(f"https://github.com/new?name={name}")
        input("After creating the PRIVATE repository, press Enter to verify it: ")
        chk = github_http("GET", f"{GITHUB_API}/repos/{owner}/{name}", token)
        if chk.status_code != 200 or not chk.json().get("private"):
            raise RuntimeError("New private GitHub repository could not be verified")
    event("GITHUB_REPO_READY", repo=name)
    return f"https://github.com/{owner}/{name}.git"


GITHUB_PUSH_HARD_BYTES = 2 * 1024**3
GITHUB_PUSH_HEADROOM_BYTES = 64 * 1024**2


def github_push_payload_budget():
    """Budget raw staged bytes below GitHub's 2 GiB packed-push ceiling.

    The margin covers pack headers, manifests, trees and incompressible input.
    A lower user-configured budget is respected. Repository rotation is separate.
    """
    return min(GITHUB_PUSH_HARD_BYTES - GITHUB_PUSH_HEADROOM_BYTES,
               int(CONFIG['max_push_mib']) * 1024**2)


def paced_push(db, repo):
    now = time.time()
    old = db.execute("SELECT ts FROM push_events WHERE repository=? AND ts>? ORDER BY ts",
                     (repo, now-60)).fetchall()
    count = CONFIG["pushes_per_minute"]
    if len(old) >= count:
        delay = max(0, old[len(old)-count][0] + 61 - time.time())
        event("WAIT_GITHUB_PUSH_WINDOW", repo=repo, wait_seconds=round(delay, 2), next_at=utc())
        time.sleep(delay)
    with db:
        db.execute("INSERT INTO push_events VALUES (?, ?)", (repo, time.time()))


def _verify_remote_chapter_tree(remote: str, env: dict, commit: str,
                                expected_blobs: dict[str, str], chapter_prefix: str):
    """Independently fetch the remote commit+tree and prove the referenced blobs.

    The previously validated SHA-256 image bytes were Git-hashed locally and
    pushed. The remote commit ID authenticates its tree; each remote tree entry
    must reference the exact local Git object ID. No one-RPC-per-image lazy blob
    fetch is needed. This is cryptographic object verification, NOT a download
    and second SHA-256 computation of all remote image contents.
    """
    if not expected_blobs or any(not isinstance(k, str) or not k for k in expected_blobs):
        raise RuntimeError('Remote verification received an empty/invalid expected object set')
    with tempfile.TemporaryDirectory(prefix='comic-verify-tree-') as vv:
        check = Path(vv)

        def verify_git(*args):
            proc = git_run(['git', *args], cwd=check, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if proc.returncode:
                raise RuntimeError('GitHub remote tree verification failed: '
                                   + proc.stderr.decode('utf-8', 'replace')[-800:])
            return proc.stdout

        verify_git('init', '-q')
        verify_git('remote', 'add', 'origin', remote)
        # A normal GitHub protocol-v2 partial fetch transfers commit + tree
        # objects, not the accumulated chapter image blobs.
        verify_git('fetch', '--depth=1', '--filter=blob:none', 'origin', 'main')
        tip = verify_git('rev-parse', 'FETCH_HEAD').decode('ascii').strip()
        if tip != commit:
            raise RuntimeError('Verification fetch remote branch SHA mismatch')
        prefixes = [chapter_prefix] if isinstance(chapter_prefix, str) else list(chapter_prefix)
        raw = verify_git('ls-tree', '-r', '-z', '--full-tree', tip,
                         '--', 'README.md', *prefixes)
        observed = {}
        for entry in raw.split(b'\0'):
            if not entry:
                continue
            if b'\t' not in entry:
                raise RuntimeError('Malformed GitHub remote tree entry')
            meta, path_bytes = entry.split(b'\t', 1)
            attributes = meta.split()
            if len(attributes) != 3 or attributes[0] != b'100644' or attributes[1] != b'blob':
                raise RuntimeError('Unexpected GitHub object type/mode')
            path = path_bytes.decode('utf-8', 'surrogateescape')
            if path in observed:
                raise RuntimeError('Duplicate GitHub remote tree path: ' + path)
            observed[path] = attributes[2].decode('ascii')
        if set(observed) != set(expected_blobs):
            missing = sorted(set(expected_blobs) - set(observed))
            extras = sorted(set(observed) - set(expected_blobs))
            raise RuntimeError('GitHub remote chapter file list mismatch; missing='
                               + repr(missing[:8]) + ' extra=' + repr(extras[:8]))
        for path, expected_id in expected_blobs.items():
            if observed[path] != expected_id:
                raise RuntimeError(f'GitHub remote object ID differs for {path}; local data retained')
        return len(observed)


def stage_one_chapter(db, repo, chapter, files, manifest, token, *, additional=()):
    """Stage images in one Git index batch, then verify remote commit/tree IDs.

    This stays provider-agnostic and does not read or modify site adapter state.
    """
    owner = get_option(db, 'github_owner')
    remote = ensure_remote_repo(repo, db, token)
    env = isolated_git_environment()
    env['GCM_NAMESPACE'] = get_option(db, 'github_credential_namespace') or 'comic-archiver-unauthorized'

    def g(*args, cwd):
        p = git_run(['git', *args], cwd=cwd, env=env, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode:
            if args[0]=='push' and git_size_rejected(p.stderr):
                raise GitBatchTooLarge('GitHub rejected packed push size; local files retained')
            raise RuntimeError(f'git {args[0]} failed: {p.stderr[-900:]}')
        return p.stdout.strip()

    entries = [(chapter, files, manifest), *additional]
    for ch, paths, meta in entries:
        if not paths or len(paths) != len(meta.get('images', [])):
            raise RuntimeError('Chapter files/manifest count mismatch; refusing push')
        if any(path.stat().st_size>CONFIG['github_max_file_bytes'] for path in paths):
            raise RuntimeError('Individual image exceeds GitHub file size limit; local files retained')
    staged_bytes = sum(path.stat().st_size for _, paths, _ in entries for path in paths)
    if staged_bytes > github_push_payload_budget():
        raise RuntimeError('GitHub batch exceeds safe 2 GiB push payload budget; files retained')
    first_chapter = chapter
    with tempfile.TemporaryDirectory(prefix='comic-git-') as tmp:
        work = Path(tmp)
        g('init', '-q', '-b', 'main', cwd=work)
        g('remote', 'add', 'origin', remote, cwd=work)
        latest = git_run(['git', 'fetch', '--depth=1', '--filter=blob:none', 'origin', 'main'],
                                cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if latest.returncode and 'couldn\'t find remote ref' not in latest.stderr and 'could not find remote ref' not in latest.stderr:
            raise RuntimeError('Could not fetch existing repository safely: ' + latest.stderr[-900:])
        parent = g('rev-parse', 'FETCH_HEAD', cwd=work) if latest.returncode == 0 else None
        if parent:
            g('read-tree', parent, cwd=work)
        expected_blobs = {}
        plans = []
        input_paths, all_remote = [], []
        prefixes = set()
        for chapter, files, manifest in entries:
            prefix = 'chapters/' + safe_slug(chapter.chapter_id, 45) + '/'
            if prefix in prefixes:
                raise RuntimeError('Duplicate chapter archive prefix')
            prefixes.add(prefix)
            remote_paths = []
            for file, image in zip(files, manifest['images']):
                if not file.is_file() or file.is_symlink() or file.name in ('', '.', '..') or '/' in file.name or '\\' in file.name:
                    raise RuntimeError('Unsafe/missing image staged for GitHub: ' + str(file))
                digest = hashlib.sha256()
                count = 0
                with file.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block); count += len(block)
                if digest.hexdigest() != image.get('sha256') or count != image.get('bytes'):
                    raise RuntimeError('Image bytes changed after validation: ' + file.name)
                remote_paths.append(prefix + file.name)
                input_paths.append(str(file))
            all_remote.extend(remote_paths)
            plans.append((chapter, manifest, prefix, remote_paths))
        if len(all_remote) != len(set(all_remote)):
            raise RuntimeError('Duplicate image filenames in chapter batch')
        if any('\n' in path or '\r' in path for path in input_paths):
            raise RuntimeError('Unsafe newline in image path')
        proc = git_run(['git', 'hash-object', '-w', '--stdin-paths'], cwd=work,
                              env=env, input='\n'.join(input_paths) + '\n', text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode:
            raise RuntimeError('Git batch image hashing failed: ' + proc.stderr[-900:])
        image_hashes = proc.stdout.splitlines()
        if len(image_hashes) != len(all_remote) or any(not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', h) for h in image_hashes):
            raise RuntimeError('Git batch image hashing returned incomplete object IDs')
        expected_blobs.update(zip(all_remote, image_hashes))
        # Fetch the old README only once (the existing remote repo is filtered).
        prior_readme = ''
        if parent:
            old = git_run(['git', 'show', f'{parent}:README.md'], cwd=work, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if old.returncode == 0:
                prior_readme = old.stdout.decode('utf-8', errors='replace')
        if not prior_readme:
            prior_readme = f"# {get_option(db, 'series_title', 'Comic archive')}\n\n"
            prior_readme += ('Verified chapter images are archived in this private repository. '
                             'Use the separately published Cloudflare reader for interactive navigation.\n\n')
        for chapter, manifest, prefix, remote_paths in plans:
            if f'<!-- archived-chapter:{chapter.chapter_id} -->' not in prior_readme:
                prior_readme += (f'\n<!-- archived-chapter:{chapter.chapter_id} -->\n'
                                 f'## {chapter.label}\n\n'
                                 f'[Browse chapter images]({prefix})\n\n'
                                 f'[Open first image]({remote_paths[0]})\n\n')
        readme_file = work / 'README.md'
        readme_file.write_bytes(prior_readme.encode('utf-8'))
        expected_blobs['README.md'] = g('hash-object', '-w', str(readme_file), cwd=work)
        for i, (chapter, manifest, prefix, remote_paths) in enumerate(plans):
            manifest_path = work / f'chapter_manifest_{i}.json'
            manifest['remote_files'] = remote_paths
            atomic_json(manifest_path, manifest)
            expected_blobs[prefix + 'manifest.json'] = g('hash-object', '-w', str(manifest_path), cwd=work)
        # One atomic index update instead of a process per image.
        records = b''.join((f'100644 {obj}\t{path}'.encode('utf-8') + b'\0')
                           for path, obj in expected_blobs.items())
        staged = git_run(['git', 'update-index', '-z', '--index-info'], cwd=work, env=env,
                                input=records, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if staged.returncode:
            raise RuntimeError('Git batch index update failed: ' + staged.stderr.decode('utf-8', 'replace')[-900:])
        tree = g('write-tree', '--missing-ok', cwd=work)
        env['GIT_AUTHOR_NAME'] = owner
        env['GIT_AUTHOR_EMAIL'] = f'{owner}@users.noreply.github.com'
        env['GIT_COMMITTER_NAME'] = owner
        env['GIT_COMMITTER_EMAIL'] = env['GIT_AUTHOR_EMAIL']
        cp_args = ['git', 'commit-tree', tree, '-m', f'Archive {len(plans)} chapter(s): {first_chapter.label}']
        if parent:
            cp_args.extend(['-p', parent])
        cp = subprocess.run(cp_args, env=env, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if cp.returncode:
            raise RuntimeError('Could not build commit: ' + cp.stderr[-900:])
        commit = cp.stdout.strip()
        paced_push(db, repo)
        start_push = time.monotonic()
        event('GITHUB_PUSH_START', repo=repo, chapters=[ch.chapter_id for ch,_,_,_ in plans])
        # An uncertain push response must not cause a duplicate or forced push.
        try:
            g('push', 'origin', f'{commit}:refs/heads/main', cwd=work)
        except RuntimeError:
            refs = g('ls-remote', 'origin', 'refs/heads/main', cwd=work)
            if refs.split()[:1] != [commit]:
                raise
        event('GITHUB_PUSH_COMPLETE', repo=repo, chapters=len(plans),
              elapsed_seconds=round(time.monotonic() - start_push, 2))
        refs = g('ls-remote', 'origin', 'refs/heads/main', cwd=work)
        if not refs or refs.split()[0] != commit:
            raise RuntimeError('Remote GitHub branch SHA mismatch; retaining local files')
        start_verify = time.monotonic()
        checked = _verify_remote_chapter_tree(remote, env, commit, expected_blobs, sorted(prefixes))
        for chapter, _, _, paths in plans:
            event('REMOTE_CHAPTER_VERIFIED', repo=repo, chapter=chapter.chapter_id,
                  images=len(paths), commit_sha=commit, checked_git_objects=checked,
                  verification_method='remote_commit_tree_object_ids', per_image_blob_fetches=0,
                  elapsed_seconds=round(time.monotonic() - start_verify, 2))
        return commit, plans[0][3]


def update_local_readme_deployment(db, reader_url: str, volume_urls: dict):
    """Keep this project's README linked to its last actually verified reader."""
    path = ROOT / 'README.md'
    text = path.read_text(encoding='utf-8')
    begin = '<!-- VERIFIED_COMIC_READER_URLS_START -->'
    end = '<!-- VERIFIED_COMIC_READER_URLS_END -->'
    lines = [begin, '## Verified deployed reader', '',
             f'**[{get_option(db,"series_title","Comic reader")} — open reader]({reader_url})**', '',
             'GitHub reader repository: source code, chapter index and homepage README.']
    owner = get_option(db,'github_owner') or ''
    slug = get_option(db,'series_slug') or ''
    lines.append(f'- [Reader source repository](https://github.com/{owner}/{slug}-reader)')
    for repo, url in sorted(volume_urls.items()):
        lines.append(f'- [Image archive `{repo}`](https://github.com/{owner}/{repo}) — '
                     f'assets at {url}; this is not a separate reader homepage')
    lines.extend(['', 'This section is updated only after a verified Cloudflare deployment.', end])
    block = '\n'.join(lines)
    if begin in text and end in text:
        text = re.sub(re.escape(begin)+r'.*?'+re.escape(end),lambda _:block,text,flags=re.S)
    else:
        text = block+'\n\n'+text
    path.write_bytes(text.encode('utf-8'))


def reader_repository_readme(db, reader_url: str) -> str:
    """GitHub root README with the verified Pages/Workers reader link."""
    owner = get_option(db, 'github_owner') or ''
    title = get_option(db, 'series_title') or 'Comic reader'
    slug = get_option(db, 'series_slug') or ''
    lines = [f'# {title}', '', '## Read online', '',
             f'**[Open the live reader]({reader_url})**', '',
             'This is the **reader application/source** repository. Image files are stored',
             'in separate GitHub volume repositories and served from Cloudflare asset projects.',
             'The volume project is an image host, not an independent comic reader.', '',
             '## Chapters', '']
    for ident, label in db.execute('SELECT chapter_id,label FROM chapters ORDER BY ordinal'):
        from urllib.parse import quote
        lines.append(f'- [{label}]({reader_url}/?chapter={quote(str(ident),safe="")})')
    lines.extend(['', '## Image archive volumes', ''])
    for (repo,) in db.execute('SELECT DISTINCT repository FROM chapters WHERE repository IS NOT NULL ORDER BY repository'):
        lines.append(f'- [`{repo}`](https://github.com/{owner}/{repo}) — original archived image assets')
    lines.extend(['', '## Setup', '', 'Install the project and run `python run.py` from its root.',
                  'Publishing and image access require the appropriate rights.', ''])
    return '\n'.join(lines)


def volume_readme_with_links(existing: str, title: str, reader_url: str, volume_url: str, chapters=None) -> str:
    """Preserve every original chapter entry while maintaining a deployment block."""
    begin = '<!-- COMIC_ARCHIVER_DEPLOYMENT_START -->'
    end = '<!-- COMIC_ARCHIVER_DEPLOYMENT_END -->'
    import re as _re
    from urllib.parse import quote
    lines = [begin, '## Read online', '',
             f'**[{title} — live comic reader]({reader_url})**', '',
             f'Asset host: {volume_url} — used by the reader for images, not a separate reading website.',
             'This GitHub volume stores the original archived chapter images.']
    if chapters:
        lines.extend(['', '## Chapter titles', ''])
        for ident, label in chapters:
            lines.append(f'- [{label}]({reader_url}/?chapter={quote(str(ident),safe="")})')
    block = '\n'.join([*lines, end])
    if begin in existing and end in existing:
        return _re.sub(_re.escape(begin)+r'.*?'+_re.escape(end),
                       lambda _:block,existing,flags=_re.S)
    return (existing.rstrip()+'\n\n'+block+'\n') if existing.strip() else ('# '+title+'\n\n'+block+'\n')


def update_volume_readme(db, repo: str, reader_url: str, volume_url: str, *, remote_url: str | None = None):
    """Update ONLY README.md via shallow git plumbing; never clone images."""
    owner = get_option(db, 'github_owner')
    if not owner or not repo.startswith((get_option(db,'series_slug') or '__none__')+'-vol-'):
        raise RuntimeError('Refusing to update unrecognized volume repository')
    env = isolated_git_environment()
    env['GCM_NAMESPACE'] = get_option(db,'github_credential_namespace') or 'comic-archiver-unauthorized'
    env.update({'GIT_AUTHOR_NAME':owner,'GIT_COMMITTER_NAME':owner,
                'GIT_AUTHOR_EMAIL':f'{owner}@users.noreply.github.com',
                'GIT_COMMITTER_EMAIL':f'{owner}@users.noreply.github.com'})
    remote=remote_url or f'https://github.com/{owner}/{repo}.git'
    with tempfile.TemporaryDirectory(prefix='comic-volume-readme-') as dirname:
        wd=Path(dirname)
        def g(*args, check=True):
            proc=git_run(['git',*args],cwd=wd,env=env,capture_output=True)
            if proc.returncode and check:
                raise RuntimeError('Volume README Git failure: '+proc.stderr.decode('utf-8','replace')[-600:])
            return proc
        g('init','-q')
        g('remote','add','origin',remote)
        g('fetch','--depth=1','--filter=blob:none','origin','main')
        parent=g('rev-parse','FETCH_HEAD').stdout.decode().strip()
        old=g('show',f'{parent}:README.md',check=False)
        raw=old.stdout.decode('utf-8','replace') if old.returncode==0 else ''
        chapters = db.execute('SELECT chapter_id,label FROM chapters WHERE repository=? ORDER BY ordinal',
                              (repo,)).fetchall()
        content=volume_readme_with_links(raw, get_option(db,'series_title','Comic reader'),
                                         reader_url, volume_url, chapters=chapters)
        if content==raw:
            event('GITHUB_VOLUME_README_REUSED',repo=repo)
            return False
        g('read-tree',parent)
        file=wd/'README.md';file.write_bytes(content.encode('utf-8'))
        blob=g('hash-object','-w',str(file)).stdout.decode().strip()
        g('update-index','--add','--cacheinfo',f'100644,{blob},README.md')
        tree=g('write-tree').stdout.decode().strip()
        new=g('commit-tree',tree,'-p',parent,'-m','Document verified Cloudflare reader URL').stdout.decode().strip()
        paced_push(db,repo)
        g('push','origin',f'{new}:refs/heads/main')
        ref=g('ls-remote','origin','refs/heads/main').stdout.decode().split()
        if not ref or ref[0]!=new:
            raise RuntimeError('Volume README push ref was not verified')
        # Read the byte-identical README from a separate fetch, not local index.
        with tempfile.TemporaryDirectory(prefix='comic-readme-check-') as verifydir:
            check=Path(verifydir)
            def gv(*args):
                proc=git_run(['git',*args],cwd=check,env=env,capture_output=True)
                if proc.returncode:
                    raise RuntimeError('Could not independently verify remote README')
                return proc.stdout
            gv('init','-q');gv('remote','add','origin',remote)
            gv('fetch','--depth=1','--filter=blob:none','origin','main')
            if gv('show',f'{new}:README.md')!=content.encode('utf-8'):
                raise RuntimeError('Remote README bytes do not match')
        event('GITHUB_VOLUME_README_UPDATED',repo=repo,reader_url=reader_url,volume_url=volume_url)
        return True


def archive_reader_source(db, slug, site_dir, token, reader_url=None):
    """Save complete reader source and latest global index in a private GitHub repo."""
    repo = slug + "-reader"
    owner = get_option(db, "github_owner")
    remote = ensure_remote_repo(repo, db, token)
    env = isolated_git_environment()
    env["GCM_NAMESPACE"] = get_option(db, "github_credential_namespace") or "comic-archiver-unauthorized"
    env.update({"GIT_AUTHOR_NAME": owner, "GIT_COMMITTER_NAME": owner,
                "GIT_AUTHOR_EMAIL": f"{owner}@users.noreply.github.com",
                "GIT_COMMITTER_EMAIL": f"{owner}@users.noreply.github.com"})
    with tempfile.TemporaryDirectory(prefix="comic-reader-source-") as tmp:
        tmp = Path(tmp)
        def run(*args, binary=False, check=True):
            proc = git_run(["git", *args], cwd=tmp, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
            if proc.returncode and check:
                raise RuntimeError("Reader Git operation failed: " + proc.stderr.decode(errors="replace")[-800:])
            return proc.stdout if binary else proc.stdout.decode(errors="replace").strip()
        run("init", "-q", "-b", "main")
        run("remote", "add", "origin", remote)
        # Reader source is small: download blobs in ONE fetch to avoid a
        # network round trip for every README/source file during verification.
        fetched = git_run(["git", "fetch", "--depth=1", "origin", "main"],
                                 cwd=tmp, env=env, capture_output=True)
        if fetched.returncode and b"remote ref" not in fetched.stderr:
            raise RuntimeError("Cannot fetch reader repository before updating")
        parent = run("rev-parse", "FETCH_HEAD") if fetched.returncode == 0 else None
        if parent:
            run("read-tree", parent)
        files = [p for p in site_dir.rglob("*") if p.is_file() and not p.is_symlink()]
        # Commit the ACTUAL runnable, source-separated Python project as well
        # as the reader. Never include .archiver_state, venvs, keys or cookies.
        for source in ("comic_archiver.py", "run.py", "requirements.txt", "README.md",
                       "UPDATE.txt", "package.json", "setup_and_publish.ps1", "setup_and_publish.sh"):
            file = ROOT / source
            if file.is_file() and not file.is_symlink():
                files.append(file)
        for folder in ("reusable", "site_specific", "config", "extension", "tests"):
            directory = ROOT / folder
            if directory.is_dir():
                files.extend(file for file in directory.rglob("*") if file.is_file() and not file.is_symlink()
                             and file.suffix.lower() in {".py", ".js", ".json", ".html", ".css", ".ps1", ".sh"}
                             and "__pycache__" not in file.parts)
        files = list(dict.fromkeys(files))
        checks = []
        for p in files:
            target = ("website/" + p.relative_to(site_dir).as_posix()) if p.is_relative_to(site_dir) else ("publisher/" + p.relative_to(ROOT).as_posix())
            raw = p.read_bytes()
            sha = run("hash-object", "-w", str(p))
            run("update-index", "--add", "--cacheinfo", f"100644,{sha},{target}")
            checks.append((target, hashlib.sha256(raw).hexdigest()))
        # README is at the GitHub repository ROOT, not publisher/README.md.
        # Only the real, verified public deployment URL is used.
        if reader_url:
            readme = reader_repository_readme(db, reader_url)
            path = tmp / "deployed-reader-README.md"
            path.write_bytes(readme.encode('utf-8'))
            digest = run('hash-object', '-w', str(path))
            run('update-index', '--add', '--cacheinfo', f'100644,{digest},README.md')
            checks.append(('README.md', hashlib.sha256(path.read_bytes()).hexdigest()))
        tree = run("write-tree")
        prior_tree = run("rev-parse", f"{parent}^{{tree}}") if parent else None
        if parent and tree == prior_tree:
            # An interrupted previous run may have PUSHED this exact tree and
            # crashed only during verification. Do not manufacture a new commit.
            commit = parent
            event("GITHUB_READER_SOURCE_REUSED", repository=repo, commit_sha=commit)
        else:
            commit_args = ["commit-tree", tree, "-m", "Update verified comic reader source"]
            if parent:
                commit_args.extend(["-p", parent])
            commit = run(*commit_args)
            paced_push(db, repo)
            run("push", "origin", f"{commit}:refs/heads/main")
        if run("ls-remote", "origin", "refs/heads/main").split()[0] != commit:
            raise RuntimeError("Reader source remote SHA mismatch")
        with tempfile.TemporaryDirectory(prefix="comic-reader-verify-") as vv:
            v = Path(vv)
            def vrun(*args):
                p = git_run(["git", *args], cwd=v, env=env, capture_output=True)
                if p.returncode:
                    raise RuntimeError("Reader source remote verification failed")
                return p.stdout
            vrun("init", "-q")
            vrun("remote", "add", "origin", remote)
            vrun("fetch", "--depth=1", "origin", "main")
            if vrun("rev-parse", "FETCH_HEAD").decode().strip() != commit:
                raise RuntimeError("Reader source fetched wrong remote commit")
            for path, expected in checks:
                fetched_bytes = vrun("show", f"{commit}:{path}")
                observed = hashlib.sha256(fetched_bytes).hexdigest()
                if observed != expected:
                    raise RuntimeError(
                        f"Reader source remote file checksum mismatch: {path}; "
                        f"expected={expected}, remote={observed}. Remote content retained."
                    )
        event("GITHUB_READER_SOURCE_VERIFIED", repository=repo, commit_sha=commit, files=len(checks))
    return repo, commit


def repo_for_chapter(db, slug, projected_bytes, projected_files):
    repos = db.execute("SELECT name,logical_bytes,file_count FROM repositories ORDER BY name").fetchall()
    active = next((r for r in reversed(repos) if r[0].startswith(slug + "-vol-")), None)
    max_bytes = CONFIG["github_repo_target_mib"] * 1024**2
    if active and active[1] + projected_bytes <= max_bytes and active[2] + projected_files < 18000:
        return active[0]
    suffix = max([int(r[0].split("-vol-")[-1]) for r in repos if r[0].startswith(slug + "-vol-")] + [0]) + 1
    name = f"{slug[:50]}-vol-{suffix:03d}"
    with db:
        db.execute("INSERT OR IGNORE INTO repositories(name,logical_bytes,file_count,updated_at) VALUES(?,?,?,?)", (name, 0, 0, utc()))
    event("ROTATE_GITHUB_REPOSITORY", next_repository=name, projected_new_bytes=projected_bytes)
    return name


def save_chapters(db, chapters):
    with db:
        for n, ch in enumerate(chapters):
            db.execute("INSERT OR IGNORE INTO chapters(chapter_id,label,url,ordinal,status,updated_at) VALUES(?,?,?,?,'DISCOVERED',?)",
                       (ch.chapter_id, ch.label, ch.url, n, utc()))


def discover_from_live(context, seed_url, seed_html, max_chapters=1000, guard=None, visible=True):
    browser_catalog = getattr(ADAPTER, 'custom_browser_chapters', None)
    if callable(browser_catalog):
        def visit(page, url):
            if guard:
                return visit_source_page(page, url, guard, visible=visible)
            return page.goto(url, wait_until='domcontentloaded', timeout=50000)
        catalog = browser_catalog(context, seed_url, seed_html, Chapter, visit)
        if catalog is not None:
            if not catalog:
                raise RuntimeError('Native browser catalog returned no chapters')
            return catalog[:max_chapters]
    initial, nav = chapter_links(seed_html, seed_url)
    if not initial and not nav:
        # A site adapter can supply a VERIFIED complete catalog from the current
        # DOM; no need to revisit all its chapters before downloading.
        verified_catalog = custom_chapter_links(seed_html, seed_url)
        if verified_catalog:
            return verified_catalog[:max_chapters]
        # Site's own chapter-list button is preferred even if it only exists
        # after JavaScript hydration. Otherwise inspect a source-provided list.
        pg = context.new_page()
        try:
            visit_source_page(pg, seed_url, guard, visible=visible) if guard else pg.goto(seed_url, wait_until="domcontentloaded", timeout=40000)
            initial, nav = _native_list_popup(pg)
            if not initial and not nav:
                initial = custom_chapter_links(pg.content(), pg.url)
        finally:
            pg.close()
    if not initial and not nav:
        raise RuntimeError("No native or source-derived chapter traversal could be verified; refusing to declare all chapters discovered")
    discovered = initial[:] if initial else [Chapter("seed", "Starting chapter", seed_url)]
    known = {clean_url(x.url) for x in discovered}
    pending = nav[:]
    # Inspect the actual native reader links before inventing any chapter URLs.
    for ch in list(discovered):
        if len(discovered) >= max_chapters:
            break
        page = context.new_page()
        try:
            visit_source_page(page, ch.url, guard, visible=visible) if guard else page.goto(ch.url, wait_until="domcontentloaded", timeout=40000)
            raw = page.content()
            ordered, neighbor = chapter_links(raw, page.url)
            if not ordered and not neighbor:
                ordered = custom_chapter_links(raw, page.url)
            for item in ordered + neighbor:
                u = clean_url(item.url)
                if ensure_same_origin(seed_url, u) and u not in known:
                    pending.append(item)
                    known.add(u)
        finally:
            page.close()
    while pending and len(discovered) < max_chapters:
        nxt = pending.pop(0)
        if not any(x.url == nxt.url for x in discovered):
            discovered.append(nxt)
        page = context.new_page()
        try:
            visit_source_page(page, nxt.url, guard, visible=visible) if guard else page.goto(nxt.url, wait_until="domcontentloaded", timeout=40000)
            neighbors, navigation = chapter_links(page.content(), page.url)
            if not neighbors and not navigation:
                neighbors = custom_chapter_links(page.content(), page.url)
            for item in neighbors + navigation:
                u = clean_url(item.url)
                if ensure_same_origin(seed_url, u) and u not in known:
                    known.add(u)
                    pending.append(item)
        finally:
            page.close()
    # Native lists already provide the intended ordering. Additional links append only when
    # not already in the list. The caller should inspect ordering if source has no list.
    unique = list(dict((x.url, x) for x in discovered).values())
    return unique


def acquire_chapter(context, chapter: Chapter, storage: Path, config=CONFIG, guard=None, visible=True):
    acquisition_started = time.monotonic()
    page = context.new_page()
    chapter_dir = storage / safe_slug(chapter.chapter_id, 45)
    chapter_dir.mkdir(parents=True, exist_ok=True)
    try:
        before = getattr(ADAPTER, 'before_chapter_visit', None)
        if callable(before):
            before(page, chapter.url)
        visit_source_page(page, chapter.url, guard, visible=visible) if guard else page.goto(chapter.url, wait_until="domcontentloaded", timeout=50000)
        after = getattr(ADAPTER, 'after_chapter_visit', None)
        if callable(after):
            after(page, chapter.url)
        source_title = chapter_title_from_source(page.content(), chapter.label)
        checkpoint = ChapterImageCheckpoint(chapter_dir, chapter.chapter_id, chapter.url)
        saved = {}
        attempts = {}
        server_failures = {}
        new_images = reused_images = 0
        capture_seconds = 0.0
        # RECYCLED_TAB_SAVED_ORDINALS_V1: a replacement browser tab can expose
        # only a prefix of the chapter before its DOM repopulates. Preserve ALL
        # already-verified saved images, but report only slots in that one
        # transient snapshot to the scanner. Normal strict validation stays on.
        recycled_tab_rehydrating = False
        def save_as_scroll_reveals(info, slot_order, seen, at_bottom):
            nonlocal recycled_tab_rehydrating, new_images, reused_images, capture_seconds
            if len(slot_order) > config['max_pages_per_chapter']:
                raise RuntimeError('Chapter page count exceeds configured safety limit')
            by_key = {str(im.get('key','')): im for im in info['imgs']}
            # Numeric keys are normalized by the scanner; reconcile equivalent
            # spellings here without assuming any provider-specific markup.
            by_key = {(str(int(k)) if k.isdigit() else k): v for k,v in by_key.items()}
            # Preserve the COMPLETE ordered catalog once we have reached the
            # real bottom, even when some images are still missing. This is
            # what makes the following run avoid another full scroll.
            if (info.get('physicalAtBottom', at_bottom) and len(slot_order) == int(info.get('total') or 0) and
                    len(seen) == len(slot_order) and not info.get('missingSlots')):
                checkpoint.record_catalog(slot_order, seen)
            reach = float(info.get('scrollY') or 0) + float(info.get('viewportHeight') or 0) + 120
            # When the full ordered catalog is known, work in reading order.
            # Previously an unloaded image 56 caused 61..118 to be captured
            # first and then 56 to be visited from the bottom. Keeping a
            # contiguous prefix avoids those long backwards jumps.
            ordered_retry = bool(checkpoint.catalog_matches(
                slot_order, seen, len(slot_order)))
            save_as_scroll_reveals.failed_key = None
            for i,key in enumerate(slot_order,1):
                if key in saved or key in server_failures:
                    continue
                resolved = seen.get(key)
                im = by_key.get(key)
                if not resolved or not im or not im.get('url'):
                    break  # first unverified image blocks all later capture
                if resolved['url'] != urljoin(page.url, im['url']):
                    raise RuntimeError('Source image identity changed during ordered download: '+key)
                restored = checkpoint.reuse(key, i, resolved['url'])
                if restored:
                    saved[key] = restored
                    reused_images += 1
                    event('IMAGE_REUSED_FROM_CHECKPOINT',chapter=chapter.chapter_id,
                          image=i,total=len(slot_order),bytes=restored[1]['bytes'])
                    continue
                if im.get('loaded') is False:
                    break  # try this ordinal first, before later pages
                if not at_bottom and 'pageY' in im and info.get('viewportHeight') is not None:
                    if float(im['pageY']) > reach:
                        break  # wait until normal forward scroll reaches this slot
                # Avoid repeated fetches while advancing the reader. At the
                # bottom, targeted retries may attempt a failed image again.
                if attempts.get(key,0) >= 3:
                    save_as_scroll_reveals.failed_key = key
                    break  # scanner must recover/reload or stop, not skip this gap
                attempts[key] = attempts.get(key,0) + 1
                capture_started = time.monotonic()
                try:
                    path, meta = image_download(context, resolved['url'], chapter_dir / f'{i:04d}', chapter.url,
                                                max_tries=(1 if getattr(context.request,
                                                     'reuses_loaded_page_images', False)
                                                     else config['download_retries']),
                                                guard=guard, page=page, visible=visible)
                except SourceAccessPaused:
                    raise
                except Exception as exc:
                    if getattr(exc, 'requires_bridge_reconnect', False):
                        raise
                    event('IMAGE_DEFERRED_FOR_TARGETED_RETRY',chapter=chapter.chapter_id,
                          image=i, error=str(exc)[:250])
                    save_as_scroll_reveals.failed_key = key
                    break  # never attempt a later image after a capture error
                saved[key] = checkpoint.record_image(key, i, resolved['url'], path, meta)
                new_images += 1
                capture_seconds += time.monotonic() - capture_started
                event('IMAGE_VALIDATED',chapter=chapter.chapter_id,image=i,
                      total=len(slot_order),bytes=meta['bytes'],during_scroll=True)
            # Only after an explicit managed-tab replacement may earlier
            # verified ordinals temporarily be absent from the NEW document.
            # Do not discard them from `saved`: all are checked again against
            # the complete final source catalog before chapter publication.
            if recycled_tab_rehydrating:
                previous_ordinal_keys = set(saved)
                current_ordinal_keys = set(slot_order)
                if not previous_ordinal_keys.issubset(current_ordinal_keys):
                    return previous_ordinal_keys.intersection(current_ordinal_keys)
                # Full original saved set is visible again: re-enable the
                # scanner's unmodified strict out-of-catalog rejection.
                recycled_tab_rehydrating = False
            return set(saved)
        def confirm_server_failure(key, classification):
            if key in saved:
                raise RuntimeError('Cannot mark an already verified image as missing')
            server_failures[key] = dict(classification)
            # State is persisted in the normal per-chapter working directory,
            # not the site adapter or permanent Git archive. Later runs can
            # retry these slots, and verified files are kept intact.
            atomic_json(chapter_dir / 'confirmed_server_failures.json', {
                'chapter_id':chapter.chapter_id, 'chapter_url':chapter.url,
                'recorded_at':utc(), 'failures':server_failures})
        save_as_scroll_reveals.confirm_server_failure = confirm_server_failure
        save_as_scroll_reveals.server_missing_keys = server_failures
        save_as_scroll_reveals.server_network_observations = {}
        save_as_scroll_reveals.reset_after_reload = attempts.clear
        # A Chrome content channel can stall after many captures. The extension
        # verifies the SAME owned tab and returns a reset marker. Do not repeat
        # a timed-out relative scroll: it may have moved already. Restart the
        # scanner using verified checkpoints, without creating/reloading tabs.
        from .browser_bridge import BrowserManagedTabRecycled
        for managed_reset in range(3):
            try:
                found = scan_browser_images(page, config['page_scan_steps'], config['page_scan_stability_steps'],
                                            guard=guard, visible=visible, on_progress=save_as_scroll_reveals,
                                            checkpoint=checkpoint)
                break
            except BrowserManagedTabRecycled:
                if managed_reset >= 2:
                    raise RuntimeError('Managed Chrome tab transport stalled repeatedly after two same-tab '
                                       'resynchronizations. Verified checkpoints retained; restart later.')
                event('BROWSER_MANAGED_TAB_RECOVERED', chapter=chapter.chapter_id,
                      attempt=managed_reset+1, verified_images=len(saved),
                      recovery='same-extension-owned-tab; restart scanner from checkpoint')
                recycled_tab_rehydrating = True
                attempts.clear()
                # Do not navigate, reload or create another tab. Check the
                # current document, which may have advanced before the lost
                # response, and then rescan from the saved image prefix.
                page.content()
                if guard:
                    state = classify_browser_page(page)
                    if state in ('challenge', 'login'):
                        wait_for_manual_source_access(page, chapter.url, guard,
                            visible=visible, reason=f'{state} after managed tab resynchronization')
                if callable(after):
                    after(page, chapter.url)
        keys = [key for key, _ in found]
        if server_failures:
            # Save all later reachable images in their original DOM positions;
            # defer the whole chapter. Never invent placeholder image bytes or
            # publish a manifest claiming completeness.
            event('CHAPTER_SERVER_IMAGES_DEFERRED', chapter=chapter.chapter_id,
                  confirmed_missing=list(server_failures), verified_images=len(saved),
                  expected=len(keys), no_incomplete_publication=True)
            raise SourceImageServerUnavailable(chapter.chapter_id, server_failures)
        if any(key not in saved or saved[key][1].get('source_url') != im['url']
               for key,im in found) or len(saved) != len(keys):
            raise RuntimeError('Chapter has missing or changed ordered pages; no incomplete archive can be published')
        files = [saved[key][0] for key in keys]
        manifest = [saved[key][1] for key in keys]
        if [item['order'] for item in manifest] != list(range(1, len(manifest)+1)):
            raise RuntimeError('Manifest image ordinals are out of order; refusing publication')
        if any(Path(item['filename']).stem != f"{i:04d}" for i,item in enumerate(manifest,1)):
            raise RuntimeError('Image filenames are not in exact reading order')
        elapsed = time.monotonic() - acquisition_started
        event('CHAPTER_ACQUISITION_TIMING', chapter=chapter.chapter_id,
              images=len(files), newly_captured=new_images, reused_images=reused_images,
              elapsed_seconds=round(elapsed, 2), successful_capture_seconds=round(capture_seconds, 2),
              seconds_per_new_image=round(capture_seconds / new_images, 2) if new_images else None,
              other_acquisition_seconds=round(max(0, elapsed-capture_seconds), 2))
        return files, {'chapter_id':chapter.chapter_id,'label':source_title,
                       'chapter_title':source_title,'original_url':chapter.url,
                       'images':manifest,'total_images':len(files),'created_at':utc()}
    finally:
        page.close()


def ensure_cleanup(base: Path):
    if base.exists():
        count = sum(1 for p in base.rglob("*") if p.is_file())
        bytes_ = sum(p.stat().st_size for p in base.rglob("*") if p.is_file())
        shutil.rmtree(base)
        if base.exists():
            raise RuntimeError("Local chapter cleanup did not complete")
        event("LOCAL_CHAPTER_CLEANUP_VERIFIED", deleted_files=count, deleted_bytes=bytes_)


def _archive_run_once(db, source_html: Path | None, source_url: str | None, max_chapters, authorized, *, source_headless=None, source_browser="firefox", force_rediscover=False, skip_remote_reconcile=False, retry_server_failures=False):
    """Resume from verified GitHub first; crawl only *unarchived* source chapters.

    A completed source episode catalog survives across all versions that use the
    same .archiver_state. No discovery page, traversal, or lazy scroll is done
    when GitHub already contains the chapter and its manifest has been checked.
    """
    if not authorized:
        raise RuntimeError("Archiving/publishing requires --authorized: you must have permission to download AND republish these images.")
    # Check/reuse the app-owned browser authorization BEFORE visiting the source.
    # A new series has its own SQLite DB, but shares the preselected OS-backed
    # GCM credentials unless explicitly switched. This prevents late failures
    # after all chapter images have already been downloaded and validated.
    credential_for_selected(db)
    # First consult GitHub, without starting Firefox or contacting the source.
    if not skip_remote_reconcile:
        reconcile_github_archive(db)
    else:
        event('GITHUB_INITIAL_RECONCILIATION_SKIPPED',
              note='Trusted previously verified local archive state this run; all newly uploaded chapters still verified remotely')
    if archive_is_complete(db) and not force_rediscover:
        event("ARCHIVE_REUSED_WITHOUT_SOURCE_BROWSER", chapters=db.execute("SELECT COUNT(*) FROM chapters").fetchone()[0],
              action="CLOUDFLARE_ONLY", source_traversal=0, lazy_scrolls=0, source_downloads=0)
        return
    raw = source_html.read_text(encoding="utf-8") if source_html else ""
    seed, title = root_metadata(raw, source_url)
    if not seed.startswith(("https://", "http://")):
        seed = get_option(db, "source_url", "") or getattr(ADAPTER, "DEFAULT_START_URL", "")
    if not seed.startswith(("https://", "http://")):
        raise RuntimeError("Enter the comic's normal webpage URL with --source-url (no HTML file required)")
    set_option(db, "source_url", seed)
    if source_html:
        set_option(db, "source_html_path", str(source_html.resolve()))
    stored = _saved_chapters(db) if _catalog_complete(db) and not force_rediscover else None
    # Confirmed source-side failures are durable exceptions, not downloader
    # failures. Keep their reports in SQLite/checkpoints/the global issue feed,
    # but never spend an ordinary resume rescanning them. A deliberate repair
    # run can opt into --retry-server-failures.
    remaining = (_source_resume_candidates(db, stored, retry_server_failures=retry_server_failures)
                 if stored is not None else None)
    if stored is not None and not remaining:
        # An interrupted post-push cleanup is local-only; do it without
        # opening Chrome or requesting any chapter from the source server.
        for ch in stored:
            status = db.execute('SELECT status FROM chapters WHERE chapter_id=?',
                                (ch.chapter_id,)).fetchone()[0]
            if status == 'ARCHIVED_VERIFIED':
                ensure_cleanup(DATA / 'temporary_downloads' / safe_slug(ch.chapter_id, 45))
                with db:
                    db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT',updated_at=? "
                               "WHERE chapter_id=?", (utc(), ch.chapter_id))
                event('CHAPTER_POSTPUSH_CLEANUP_COMPLETED', chapter=ch.chapter_id,
                      source_requests=0)
        event("ARCHIVE_ALL_KNOWN_CHAPTERS_ALREADY_VERIFIED", chapters=len(stored),
              deferred_server_chapters=db.execute(
                  "SELECT COUNT(*) FROM chapters WHERE status='SOURCE_SERVER_DEFERRED'").fetchone()[0],
              source_requests=0)
        return
    if stored is not None:
        event("CHAPTER_CATALOG_REUSED", total=len(stored), missing=len(remaining),
              traversal_skipped=True, lazy_scrolling_only_for_missing=True)
        if remaining:
            event('BROWSER_RESUME_TARGET', chapter=remaining[0].chapter_id,
                  url=remaining[0].url, verified_skipped=len(stored)-len(remaining),
                  old_seed_not_a_resume_target=True)
    # Normally no pairing deadline: first-run browser login may require a
    # human. Only a bounded recovery attempt after a *lost heartbeat* uses one.
    with source_browser_context(DATA, seed, headless=source_headless,
                                browser=source_browser,
                                reader_selectors=ADAPTER.READER_SELECTORS,
                                initial_chapter_url=(remaining[0].url if remaining else seed),
                                **({'reconnect_timeout': _BRIDGE_RECOVERY_PAIR_TIMEOUT.get()}
                                   if _BRIDGE_RECOVERY_PAIR_TIMEOUT.get() is not None else {})) as ctx:
        guard = SourceRequestGuard(
            DATA, min_interval_seconds=CONFIG.get("source_min_host_interval_seconds", 1.5),
            max_inline_wait_seconds=CONFIG.get("source_max_inline_wait_seconds", 25), emit=event)
        from .source_session import should_run_headless, mark_source_session_ready
        # Installed Mozilla Firefox deliberately stays visible even after a
        # successful previous session, to allow normal human interaction.
        actual_headless = (False if source_browser in ('firefox', 'extension') else
                           (should_run_headless(DATA, seed, browser=source_browser)
                            if source_headless is None else source_headless))
        event("SOURCE_BROWSER_PROFILE_READY", host=urlsplit(seed).hostname,
              profile=str(profile_directory(DATA, seed, browser='firefox-native'
                                    if source_browser == 'firefox' else source_browser)),
              browser='installed-mozilla-firefox' if source_browser == 'firefox' else source_browser,
              visible=not actual_headless)
        try:
            # Keep the original persistent Firefox/Chromium tab alive for the
            # whole session. Closing the last tab can terminate the context.
            anchor_page = ctx.pages[0] if ctx.pages else ctx.new_page()
            if stored is None:
                if not raw:
                    visit_source_page(anchor_page, seed, guard, visible=not actual_headless)
                    raw = anchor_page.content()
                    seed = clean_url(anchor_page.url)
                _, title = root_metadata(raw, seed)
                slug = safe_slug(title, 44)
                set_option(db, "series_slug", slug)
                set_option(db, "series_title", title)
                set_option(db, "source_url", seed)
                refresh_extension()
                mark_source_session_ready(DATA, seed, browser=source_browser)
                chapters = discover_from_live(ctx, seed, raw, max_chapters=max_chapters,
                                              guard=guard, visible=not actual_headless)
                save_chapters(db, chapters)
                event("CHAPTER_DISCOVERY_COMPLETE", total=len(chapters), title=title)
                # This flag saves the traversal work across all future runs.
                # Don't mistake an intentionally truncated --max-chapters
                # discovery for a complete catalog.
                if len(chapters) < max_chapters:
                    set_option(db, "chapter_catalog_complete", True)
                    set_option(db, "chapter_catalog_total", len(chapters))
            else:
                chapters = stored
                slug = get_option(db, "series_slug") or getattr(ADAPTER, "SERIES_SLUG_HINT", "")
                if not slug:
                    raise RuntimeError("Archive has no series slug; refusing to create an ambiguous GitHub repo")
                # Absolutely no episode-list traversal when the previous
                # complete catalog exists; only unresolved chapters are visited.
            pending = []
            pending_bytes = pending_files = 0
            pending_repo = None
            batch_cap = github_push_payload_budget()
            def flush_chapters():
                nonlocal pending_bytes, pending_files, pending_repo, batch_cap
                if not pending:
                    return
                owner, token = credential_for_selected(db)
                def send_group(group):
                    nonlocal batch_cap
                    first = group[0]
                    try:
                        commit, _ = stage_one_chapter(db, pending_repo, first[0], first[1], first[2], token,
                            additional=[(x[0], x[1], x[2]) for x in group[1:]])
                    except GitBatchTooLarge:
                        if len(group) == 1:
                            raise RuntimeError('One chapter exceeds the accepted Git push size; local files retained. Cannot safely split an atomic chapter.')
                        total_bytes=sum(x[3] for x in group)
                        batch_cap=min(batch_cap,max(max(x[3] for x in group),total_bytes//2))
                        mid=1;prefix=group[0][3]
                        while mid<len(group)-1 and prefix+group[mid][3]<=batch_cap:
                            prefix+=group[mid][3];mid+=1
                        event('GITHUB_BATCH_SCALE_DOWN', repo=pending_repo, chapters=len(group), next_chapters=mid)
                        send_group(group[:mid]); send_group(group[mid:]); return
                    with db:
                        for ch, files, manifest, total, folder in group:
                            db.execute("UPDATE chapters SET repository=?,commit_sha=?,bytes=?,pages_json=?,label=?,status='ARCHIVED_VERIFIED',updated_at=? WHERE chapter_id=?",
                                (pending_repo, commit, total, json.dumps(manifest), manifest.get('chapter_title') or ch.label, utc(), ch.chapter_id))
                        db.execute("UPDATE repositories SET logical_bytes=logical_bytes+?,file_count=file_count+?,last_sha=?,updated_at=? WHERE name=?",
                            (sum(x[3] for x in group), sum(len(x[1]) for x in group), commit, utc(), pending_repo))
                    from .reader_issue_feed import write_issue_feed
                    write_issue_feed(ROOT, ROOT / '.archiver_state' / 'source-issues.json')
                    for ch, files, manifest, total, folder in group:
                        ensure_cleanup(folder)
                        with db:
                            db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT',updated_at=? WHERE chapter_id=?", (utc(), ch.chapter_id))
                        event('CHAPTER_COMPLETE', chapter=ch.chapter_id, bytes=total, repo=pending_repo)
                send_group(list(pending))
                pending.clear()
                pending_bytes = pending_files = 0
                pending_repo = None
            for ch in chapters[:max_chapters]:
                existing = db.execute("SELECT status,repository,commit_sha FROM chapters WHERE chapter_id=?",
                                      (ch.chapter_id,)).fetchone()
                if existing and existing[0] in PUBLISHABLE_STATES:
                    event("SKIP_VERIFIED_GITHUB_CHAPTER", chapter=ch.chapter_id,
                          repo=existing[1], source_requests=0)
                    continue
                if existing and existing[0] == 'SOURCE_SERVER_DEFERRED' and not retry_server_failures:
                    event('SKIP_CONFIRMED_SERVER_MISSING_CHAPTER', chapter=ch.chapter_id,
                          reason='known_source_failure_not_downloader_failure',
                          source_requests=0, notification_preserved=True)
                    continue
                folder = DATA / "temporary_downloads" / safe_slug(ch.chapter_id, 45)
                if existing and existing[0] == "ARCHIVED_VERIFIED":
                    # Reconciliation verifies remote before this branch.
                    ensure_cleanup(folder)
                    with db:
                        db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT',updated_at=? WHERE chapter_id=?",
                                   (utc(), ch.chapter_id))
                    continue
                event("CHAPTER_START", chapter=ch.chapter_id, url=ch.url)
                try:
                    files, manifest = acquire_chapter(ctx, ch, DATA / "temporary_downloads",
                                                      guard=guard, visible=not actual_headless)
                except SourceImageServerUnavailable as exc:
                    flush_chapters()
                    # A source-origin 404/410 or repeated 5xx is not a broken
                    # bridge. Keep this chapter retryable while archiving the
                    # remaining chapters. Never upload the incomplete chapter.
                    with db:
                        db.execute("UPDATE chapters SET status='SOURCE_SERVER_DEFERRED',updated_at=? "
                                   "WHERE chapter_id=?", (utc(), ch.chapter_id))
                    from .reader_issue_feed import write_issue_feed
                    active_feed = write_issue_feed(ROOT,
                        ROOT / '.archiver_state' / 'source-issues.json')
                    event('SOURCE_ISSUE_FEED_UPDATED', active_cases=active_feed['count'],
                          affected_works=active_feed['affected_works'],
                          feed=str(ROOT / '.archiver_state' / 'source-issues.json'),
                          public_worker_update_pending=True)
                    event('CHAPTER_SERVER_ERROR_CONTINUING', chapter=ch.chapter_id,
                          missing_images=list(exc.missing),
                          next_chapter=True, checkpoint_retained=True,
                          github_upload=False)
                    continue
                except Exception as exc:
                    flush_chapters()
                    # Attribute the failure to this unfinished chapter, so a
                    # later chapter gets its own bounded recovery budget.
                    from .browser_bridge import BrowserBridgeError
                    if isinstance(exc, BrowserBridgeError):
                        exc.recovery_chapter_id = ch.chapter_id
                    raise
                # Store archive order in new manifests so even an entirely lost
                # SQLite DB can recover exact order from existing remote repos.
                manifest["ordinal"] = next((n for n, c in enumerate(chapters) if c.chapter_id == ch.chapter_id), 0)
                manifest["series_title"] = get_option(db, "series_title", "")
                total = sum(f.stat().st_size for f in files)
                event("CHAPTER_SIZE_PLAN", chapter=ch.chapter_id, image_bytes=total,
                      images=len(files), github_preferred_push_mib=CONFIG["max_push_mib"])
                if total > batch_cap:
                    raise RuntimeError("Chapter exceeds conservative maximum single-push budget; "
                                       "safe multi-commit chunking is not yet implemented. Files retained.")
                oversize = [f.name for f in files if f.stat().st_size > PAGES_LIMIT]
                if oversize:
                    event("CLOUDFLARE_UNPUBLISHABLE_ASSET", chapter=ch.chapter_id, assets=oversize)
                if pending:
                    current = db.execute('SELECT logical_bytes,file_count FROM repositories WHERE name=?', (pending_repo,)).fetchone()
                    if (pending_bytes + total > batch_cap or
                        current[0] + pending_bytes + total > CONFIG['github_repo_target_mib'] * 1024**2 or
                        current[1] + pending_files + len(files) >= 18000):
                        flush_chapters()
                if not pending:
                    pending_repo = repo_for_chapter(db, slug, total, len(files))
                title_chapter = Chapter(ch.chapter_id, manifest.get('chapter_title') or ch.label, ch.url)
                pending.append((title_chapter, files, manifest, total, folder))
                pending_bytes += total; pending_files += len(files)
                event('CHAPTER_QUEUED_FOR_GITHUB_BATCH', chapter=ch.chapter_id, chapters=len(pending), bytes=pending_bytes)
                if pending_bytes >= batch_cap:
                    flush_chapters()
                time.sleep(CONFIG["delay_between_chapters_seconds"])
            flush_chapters()
        finally:
            ctx.close()



def archive_run(db, source_html: Path | None, source_url: str | None, max_chapters, authorized,
                *, source_headless=None, source_browser="firefox", force_rediscover=False,
                skip_initial_github_check=False, retry_server_failures=False):
    """Resume archive and reopen visibly if a headless page needs a human.

    A visible retry is attempted at most once. The source profile and saved
    chapter catalog survive; GitHub is not re-fetched on the same retry.
    """
    try:
        return _archive_run_once(db, source_html, source_url, max_chapters, authorized,
                                 source_headless=source_headless,
                                 source_browser=source_browser,
                                 force_rediscover=force_rediscover,
                                 skip_remote_reconcile=skip_initial_github_check,
                                 retry_server_failures=retry_server_failures)
    except SourceManualActionRequired as exc:
        if source_headless is False:
            raise
        event('SOURCE_REOPENING_VISIBLE_FOR_HUMAN', reason=str(exc), browser=source_browser)
        print('Source requires human verification. Reopening the saved browser profile visibly.',
              flush=True)
        return _archive_run_once(db, source_html, source_url, max_chapters, authorized,
                                 source_headless=False,
                                 source_browser=source_browser,
                                 force_rediscover=force_rediscover,
                                 skip_remote_reconcile=True,
                                 retry_server_failures=retry_server_failures)


from contextvars import ContextVar

_BRIDGE_RECOVERY_PAIR_TIMEOUT = ContextVar('comic_bridge_recovery_pair_timeout', default=None)
_ORIGINAL_ARCHIVE_RUN = archive_run


def archive_run(db, source_html: Path | None, source_url: str | None, max_chapters, authorized,
                *, source_headless=None, source_browser="firefox", force_rediscover=False,
                skip_initial_github_check=False, retry_server_failures=False):
    """Recover known transport failures from durable checkpoints, per chapter."""
    from .browser_bridge import BrowserBridgeError, bridge_recovery_reason
    reconnect_number = 0
    current_recovery_chapter = None
    recovery_counts = {}
    source_waits = 0
    while True:
        token = _BRIDGE_RECOVERY_PAIR_TIMEOUT.set(90 if reconnect_number else None)
        try:
            return _ORIGINAL_ARCHIVE_RUN(
                db, source_html, source_url, max_chapters, authorized,
                source_headless=source_headless, source_browser=source_browser,
                force_rediscover=force_rediscover,
                skip_initial_github_check=skip_initial_github_check or reconnect_number > 0 or source_waits > 0,
                retry_server_failures=retry_server_failures)
        except BrowserBridgeError as exc:
            reason = bridge_recovery_reason(exc)
            if source_browser != 'extension' or not reason:
                raise
            current_recovery_chapter = getattr(exc, 'recovery_chapter_id', None) or current_recovery_chapter
            attempts = recovery_counts.get(current_recovery_chapter, 0)
            if attempts >= 2:
                raise BrowserBridgeError(
                    'BROWSER_BRIDGE_RECONNECT_EXHAUSTED: browser transport failed '
                    f'in three sessions for {current_recovery_chapter or "startup"} ({reason}). '
                    'Stop safely; verified GitHub chapters and local image checkpoints '
                    'are retained. Reload the extension and rerun run.py.') from exc
            recovery_counts[current_recovery_chapter] = attempts + 1
            reconnect_number += 1
            event('BROWSER_BRIDGE_AUTO_RECONNECT', attempt=attempts + 1,
                  chapter=current_recovery_chapter, reason=reason, detail=str(exc)[:240],
                  checkpoint_retained=True, old_verified_chapters_reused=True,
                  old_chapter_navigation_not_replayed=True)
            print(f'BROWSER_BRIDGE_AUTO_RECONNECT: {reason}; '
                  'reopening the first unfinished chapter from verified checkpoints '
                  '(not the source prologue).', flush=True)
            # A previously completed catalog is already persisted; do not repeat
            # an explicit initial refresh on every recovery of that catalog.
            if current_recovery_chapter and force_rediscover and _catalog_complete(db):
                force_rediscover = False
            time.sleep(2)
        except SourceAccessPaused as exc:
            if not exc.resume_at_utc or not ('HTTP 429' in str(exc) or 'requires a cooldown' in str(exc)):
                raise
            try: requested=datetime.fromisoformat(exc.resume_at_utc.replace('Z','+00:00')).timestamp()-time.time()
            except (ValueError,TypeError,OverflowError): raise exc
            delay=max(backoff(source_waits),requested+5);source_waits+=1
            event('WAIT_SOURCE_LIMIT', wait_seconds=delay, reason='source requested cooldown', checkpoint_retained=True)
            print(f'Source rate limit: waiting {delay:.0f}s before resuming saved chapter; Ctrl+C stops safely.',flush=True)
            time.sleep(delay)
            if force_rediscover and _catalog_complete(db):force_rediscover=False
        finally:
            _BRIDGE_RECOVERY_PAIR_TIMEOUT.reset(token)


def source_login(db, source_html: Path | None, source_url: str | None, source_browser="firefox"):
    """Show a persistent source-browser tab for normal manual website login."""
    raw = source_html.read_text(encoding="utf-8") if source_html else ""
    seed, _ = root_metadata(raw, source_url)
    if not seed.startswith(("https://", "http://")):
        seed = get_option(db, "source_url", "")
    if not seed.startswith(("https://", "http://")):
        raise RuntimeError("Provide --source-html or --source-url to open the source login browser")
    with source_browser_context(DATA, seed, headless=False, browser=source_browser,
                                reader_selectors=ADAPTER.READER_SELECTORS) as ctx:
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            guard = SourceRequestGuard(DATA, emit=event)
            # Allow opening a visible login wall without treating it as an error;
            # authentication is performed manually by the user, not by script.
            visit_source_page(page, seed, guard, visible=True)
            print("The dedicated source browser is open. Sign in normally if needed.")
            print("When finished, press ENTER in this terminal. This browser profile will persist.")
            input("Continue: ")
            current_state = classify_browser_page(page)
            if current_state in ('challenge', 'login'):
                wait_for_manual_source_access(page, seed, guard, visible=True,
                                             reason=f'{current_state} after sign-in')
            from .source_session import mark_source_session_ready
            mark_source_session_ready(DATA, seed, browser=source_browser)
            event("SOURCE_MANUAL_BROWSER_SESSION_SAVED", host=urlsplit(seed).hostname, browser=source_browser)
        finally:
            ctx.close()


def cloudflare_account_env():
    env = dict(os.environ)
    preferred = None
    if DATA.exists() and (DATA / "cloudflare_account.txt").exists():
        preferred = (DATA / "cloudflare_account.txt").read_text(encoding="utf-8").strip()
    if preferred:
        env["CLOUDFLARE_ACCOUNT_ID"] = preferred
    # Existing Wrangler browser auth is reused, but do not touch global Git or shell config.
    return env


def _run_monitored_command_once(cmd, *, cwd, env, label, show_provider_lines=False, provider_name="Wrangler"):
    """Read both output streams while printing a heartbeat even if Wrangler is silent.

    On Windows subprocess.run(text=True) uses the console encoding (often cp1252),
    which crashes on Wrangler's UTF-8. Keep raw bytes and decode explicitly.
    Threaded readers avoid stderr/stdout pipe deadlocks and work on Windows.
    """
    p = subprocess.Popen(cmd, cwd=cwd, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    incoming = queue.Queue()
    captures = {'stdout': bytearray(), 'stderr': bytearray()}
    MAX_CAPTURE = 16 * 1024 * 1024
    def read_pipe(stream, name):
        try:
            while True:
                chunk = stream.read1(8192) if hasattr(stream, 'read1') else stream.read(8192)
                if not chunk:
                    break
                incoming.put((name, chunk))
        finally:
            incoming.put((name, None))

    workers = [threading.Thread(target=read_pipe, args=(p.stdout,'stdout'), daemon=True),
               threading.Thread(target=read_pipe, args=(p.stderr,'stderr'), daemon=True)]
    for t in workers:
        t.start()
    progress = Progress(label, interval=3.0)
    finished_streams = set()
    fragments = {'stdout': '', 'stderr': ''}
    last_provider_line = ''
    git_percent_bucket = {}
    try:
        while len(finished_streams) < 2 or p.poll() is None:
            try:
                stream, chunk = incoming.get(timeout=1.0)
            except queue.Empty:
                progress.heartbeat()
                continue
            if chunk is None:
                finished_streams.add(stream)
                progress.heartbeat()
                continue
            data = captures[stream]
            data.extend(chunk)
            if len(data) > MAX_CAPTURE:
                del data[:len(data) - MAX_CAPTURE]
            if show_provider_lines:
                # Print useful, non-secret upload/deploy milestones, never OAuth
                # links or authorization headers. Allow progress output that uses CR.
                combined = fragments[stream] + chunk.decode('utf-8-sig', 'replace')
                lines = re.split(r'[\r\n]', combined)
                fragments[stream] = lines.pop()[-250:]
                for text_line in lines:
                    line = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text_line).strip()
                    if not line or len(line) > 260 or line == last_provider_line:
                        continue
                    low = line.lower()
                    if any(s in low for s in ('token', 'oauth', 'authorization', 'password', 'secret', 'bearer')):
                        continue
                    if any(s in low for s in ('upload', 'deploy', 'asset', 'build', 'publish', 'success', 'pages.dev', 'workers.dev', 'finished', 'total upload', 'receiving objects', 'resolving deltas', 'counting objects', 'enumerating objects')):
                        # A big Git fetch can emit thousands of percentage lines;
                        # keep one per 10% per stage, plus its final line.
                        match = re.search(r'([0-9]{1,3})%', line)
                        if provider_name == 'Git' and match:
                            stage = re.sub(r'\s+[0-9]{1,3}%.*$', '', low).strip()
                            percent = int(match.group(1))
                            bucket = percent // 10
                            if git_percent_bucket.get(stage, -1) >= bucket and 'done.' not in low:
                                continue
                            git_percent_bucket[stage] = bucket
                        if progress.tty:
                            print()
                        print(f'  {provider_name}:', line, flush=True)
                        last_provider_line = line
            progress.heartbeat()
        code = p.wait()
        if code == 0:
            progress.complete('command exited successfully')
        else:
            stop_progress(progress, f'FAILED (exit {code})')
    except BaseException:
        if p.poll() is None:
            p.terminate()
        stop_progress(progress, 'INTERRUPTED')
        raise
    finally:
        for t in workers:
            t.join(timeout=2)
        # Popen pipes remain open unless explicitly closed, even after EOF.
        for stream in (p.stdout, p.stderr):
            if stream:
                stream.close()
    def decode(data):
        return bytes(data).decode('utf-8-sig', errors='replace')
    return subprocess.CompletedProcess(cmd, code, decode(captures['stdout']),
                                       decode(captures['stderr']))


def _run_monitored_command(cmd, *, cwd, env, label, show_provider_lines=False, provider_name="Wrangler"):
    for attempt in count():
        p = _run_monitored_command_once(cmd,cwd=cwd,env=env,label=label,show_provider_lines=show_provider_lines,provider_name=provider_name)
        if not (provider_name=='Git' and len(cmd)>1 and cmd[1] in ('fetch','ls-remote','clone') and p.returncode and git_throttled(p.stderr)):
            return p
        github_wait(backoff(attempt),'GitHub monitored transfer rate limit',sleep=time.sleep)


def npx_wrangler(args, cwd=ROOT, check=True, progress_label=None):
    local = ROOT / "node_modules" / ".bin" / ("wrangler.cmd" if os.name == "nt" else "wrangler")
    if not local.exists():
        raise RuntimeError("Install local Wrangler via npm install; no global installation needed")
    # Process-local Wrangler auth. Never change global Git or shell config.
    env = cloudflare_account_env()
    env['NO_COLOR'] = '1'
    env['FORCE_COLOR'] = '0'
    read_only = args[:1] in (['whoami'],) or args[:2] in (['deployments','list'], ['versions','list'], ['pages','project'], ['d1','list']) and not any(x in args for x in ('create','delete','deploy'))
    for attempt in count():
        if progress_label:
            p = _run_monitored_command([str(local), *args], cwd=cwd, env=env,
                    label=progress_label, show_provider_lines=True)
        else:
            # Short metadata queries retain the original capture path, including
            # backwards-compatible test hooks. They don't create upload stalls.
            raw = subprocess.run([str(local), *args], cwd=cwd, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False)
            stdout = (raw.stdout or b'').decode('utf-8-sig', errors='replace')
            stderr = (raw.stderr or b'').decode('utf-8-sig', errors='replace')
            p = subprocess.CompletedProcess(raw.args, raw.returncode, stdout, stderr)
        delay = cloudflare_retry_delay((p.stderr or '')+'\n'+(p.stdout or ''), attempt) if p.returncode else None
        # Repeat an explicitly rejected identical deploy only before Wrangler
        # reports publication success. A partially published version requires
        # the existing live-state adoption path, not an unconditional redeploy.
        deploy = args[:1]==['deploy'] or args[:2]==['pages','deploy']
        published = bool(re.search(r'(?im)^\s*(?:Uploaded [^\n]+ \(\d|Deployed [^\n]+ triggers|Deployment complete|Current Version ID:)',p.stdout or ''))
        if delay is None or not (read_only or (deploy and not published)):
            break
        event('WAIT_CLOUDFLARE_LIMIT', wait_seconds=delay)
        time.sleep(delay)
    if p.returncode and check:
        raise RuntimeError('Wrangler ' + ' '.join(args[:2]) + ': ' + (p.stderr or p.stdout)[-1200:])
    return p


def select_cloudflare_account():
    if (DATA / "cloudflare_account.txt").exists():
        return
    p = npx_wrangler(["whoami"])
    # Wrangler lists account IDs in the 'whoami' output after browser login.
    output = (p.stdout or '') + '\n' + (p.stderr or '')
    ids = list(dict.fromkeys(re.findall(r"\b[a-f0-9]{32}\b", output, flags=re.I)))
    if len(ids) == 1:
        chosen = ids[0]
    elif len(ids) > 1:
        print("Cloudflare accounts visible through Wrangler:\n" + output)
        chosen = input("Paste one of the listed 32-character account IDs: ").strip()
        if chosen not in ids:
            raise RuntimeError("Cloudflare account selection not in authenticated account list")
    else:
        raise RuntimeError("Wrangler returned no recognizable 32-character Cloudflare account ID. "
                           "The original output was: " + output[-900:])
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "cloudflare_account.txt").write_text(chosen, encoding="utf-8")
    event("CLOUDFLARE_ACCOUNT_SELECTED", account_id=chosen)


def _normalize_pages_project(raw):
    """Normalize Wrangler CLI and Cloudflare API project shapes.

    Wrangler 4.x `pages project list --json` currently emits display columns
    `Project Name` and `Project Domains`, not API `name` and `subdomain`.
    Using only API keys caused a false "not discoverable" after create.
    """
    if not isinstance(raw, dict):
        raise RuntimeError(f"Unexpected Pages project item: {type(raw).__name__}")
    name = raw.get('name') or raw.get('Project Name') or raw.get('project_name')
    if not isinstance(name, str) or not name.strip():
        raise RuntimeError(f"Wrangler Pages project has no recognizable name (keys: {sorted(raw.keys())})")
    domains = (raw.get('subdomain') or raw.get('domain') or
               raw.get('Project Domains') or raw.get('domains') or '')
    if isinstance(domains, (list, tuple)):
        domains = ', '.join(str(x) for x in domains)
    # Some accounts show additional custom domains. Prefer the provider-
    # reported pages.dev production hostname over a custom or preview URL.
    domains = str(domains)
    match = re.search(r'(?:https?://)?([a-z0-9][a-z0-9.-]*\.pages\.dev)(?:[\s,/;]|$)',
                      domains, flags=re.I)
    domain = match.group(1).lower() if match else domains.split(',')[0].strip()
    # Keep the normalized fields distinct from the vendor's original fields.
    return {**raw, 'name': name.strip(), 'subdomain': domain}


def list_pages_projects():
    result = npx_wrangler(['pages', 'project', 'list', '--json'],
                          progress_label='Cloudflare: listing Pages projects')
    output = result.stdout or ''
    try:
        parsed = json.loads(output)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('Cloudflare Pages project list was not valid JSON; '
                           'refusing to guess project ownership. Output: ' +
                           output[:450]) from exc
    if isinstance(parsed, dict):
        parsed = parsed.get('result', parsed.get('projects'))
    if not isinstance(parsed, list):
        raise RuntimeError('Unexpected Cloudflare Pages project list schema: '
                           + type(parsed).__name__)
    return [_normalize_pages_project(item) for item in parsed]


def _confirmed_empty_pages_project(name):
    """Only auto-adopt an existing unknown Pages project if it has NO deploys.

    A previous run could have created it successfully before crashing on
    Wrangler's display-style JSON keys. Reusing an empty project is safe,
    whereas overwriting an unrelated already-deployed site is not.
    """
    result = npx_wrangler(['pages', 'deployment', 'list', '--project-name', name,
                           '--json'], check=False,
                          progress_label=f'Cloudflare: checking existing deployments for {name}')
    if result.returncode != 0:
        return False
    try:
        parsed = json.loads(result.stdout or '')
    except (TypeError, ValueError):
        return False
    if isinstance(parsed, dict):
        parsed = parsed.get('result', parsed.get('deployments'))
    return isinstance(parsed, list) and not parsed


class PagesProjectCreationUnavailable(RuntimeError):
    """A Pages project could not be created after bounded provider-error retries.

    This is an external API failure, not an indication that creating a new
    account or bypassing a limit is appropriate.
    """


def _transient_pages_creation_error(message):
    """Only retry an explicitly transient/unknown provider-side create error."""
    return bool(re.search(r"\b(?:code:\s*8000000|error\s*8000000)\b", str(message), re.I))


def ensure_cloudflare_pages_project(name, db):
    projects = list_pages_projects()
    match = next((p for p in projects if p.get('name') == name), None)
    if match:
        archived_here = db.execute('SELECT 1 FROM deployments WHERE project=?',
                                   (name,)).fetchone()
        if not archived_here:
            if _confirmed_empty_pages_project(name):
                print(f"Cloudflare Pages project '{name}' exists with no deployments; "
                      "reusing it after the interrupted setup.", flush=True)
                event('CLOUDFLARE_EMPTY_PROJECT_REUSED', project=name)
            else:
                print(f"Cloudflare Pages project '{name}' already exists on this account.")
                confirm = input('Use/update this existing project? Type its exact name to approve: ').strip()
                if confirm != name:
                    raise RuntimeError('Refusing to overwrite an unconfirmed existing project')
        return match
    if len(projects) >= 100:
        raise RuntimeError('Cloudflare Pages Free project allowance reached; '
                           'no automatic additional account creation')
    # Cloudflare can reject a valid Pages project creation with an opaque
    # provider-side 8000000. A failed response can still have created the
    # project: recheck the actual list BEFORE another create attempt.
    for attempt in range(3):
        try:
            npx_wrangler(['pages', 'project', 'create', name,
                         '--production-branch', 'main'],
                        progress_label=f'Cloudflare: creating Pages project {name} '
                                       f'(attempt {attempt + 1}/3)')
        except RuntimeError as error:
            print(f'Cloudflare Pages create returned an error for {name}; '
                  'checking whether the project appeared anyway.', flush=True)
            # Some failures arrive AFTER the API commits the new project.
            for check in range(2):
                if check:
                    time.sleep(2)
                try:
                    matched = next((p for p in list_pages_projects()
                                    if p.get('name') == name), None)
                except RuntimeError as listing_error:
                    event('CLOUDFLARE_PROJECT_RECHECK_FAILED', project=name,
                          error=str(listing_error)[-500:])
                    matched = None
                if matched:
                    event('CLOUDFLARE_PROJECT_FOUND_AFTER_ERROR', project=name)
                    return matched
            if not _transient_pages_creation_error(error):
                raise  # permissions/invalid requests are not blindly retried
            event('CLOUDFLARE_PAGES_PROJECT_CREATE_RETRYABLE',
                  project=name, attempt=attempt + 1, error=str(error)[-900:])
            if attempt == 2:
                raise PagesProjectCreationUnavailable(
                    f'Cloudflare repeatedly rejected Pages project {name} with '
                    f'provider error 8000000. Existing projects and GitHub '
                    f'archives are unaffected. {str(error)[-650:]}') from error
            delay = (5, 10)[attempt]
            print(f'Cloudflare: waiting {delay}s before the next bounded '
                  'project-create attempt; no new project names or accounts.',
                  flush=True)
            time.sleep(delay)
            continue
        event('CLOUDFLARE_PAGES_PROJECT_CREATED', project=name)
        # A successful create response is durable evidence, but the project
        # list can lag behind the creation operation.
        for retry in range(4):
            matched = next((p for p in list_pages_projects()
                            if p.get('name') == name), None)
            if matched:
                return matched
            if retry < 3:
                delay = (1, 2, 3)[retry]
                print(f"Cloudflare: project '{name}' not listed yet; "
                      f'retrying in {delay}s...', flush=True)
                time.sleep(delay)
        raise RuntimeError('Cloudflare reported successful Pages creation, but '
                           'the project is not yet listed. Stop without creating '
                           'a second project; rerun to reconcile it.')
    raise AssertionError('Unreachable Pages project retry state')


def cloudflare_pages_url(project, deploy_stdout=""):
    val = project.get("subdomain") or project.get("domain") or ""
    if val.startswith("http"):
        return val.rstrip("/")
    if val and (val.endswith(".pages.dev") or val.endswith(".workers.dev")):
        return "https://" + val.rstrip("/")
    urls = re.findall(r"https://[a-zA-Z0-9.-]+\.pages\.dev", deploy_stdout)
    if urls:
        return urls[-1].rstrip("/")
    raise RuntimeError("Could not establish Cloudflare Pages production URL; refusing to guess")


def deploy_cloudflare_assets(db, project_name, assets_dir, mode="pages"):
    if mode == "pages":
        project = ensure_cloudflare_pages_project(project_name, db)
        p = npx_wrangler(["pages", "deploy", str(assets_dir), "--project-name", project_name, "--branch", "main"], progress_label=f"Cloudflare Pages upload: {project_name}")
        # Query provider-reported subdomain again instead of constructing a URL.
        updated = next((x for x in list_pages_projects() if x.get("name") == project_name), project)
        return cloudflare_pages_url(updated, p.stdout + "\n" + p.stderr)
    if mode != "workers":
        raise RuntimeError("Unsupported Cloudflare mode")
    # Workers static assets: no script is required, and all image requests are
    # asset-first. Config file is OUTSIDE the published asset directory.
    with tempfile.TemporaryDirectory(prefix="comic-wrangler-config-") as tmp:
        cfg = Path(tmp) / "wrangler.json"
        cfg.write_text(json.dumps({"name": project_name, "compatibility_date": "2026-11-19",
            "assets": {"directory": str(assets_dir.resolve())}}, indent=2), encoding="utf-8")
        result = npx_wrangler(["deploy", "--config", str(cfg)], cwd=Path(tmp), progress_label=f"Cloudflare Workers upload: {project_name}")
        out = result.stdout + "\n" + result.stderr
        urls = re.findall(r"https://[a-zA-Z0-9.-]+\.workers\.dev", out)
        if not urls:
            raise RuntimeError("Workers deployment URL was not reported; cannot verify")
        return urls[-1].rstrip("/")


def _fetch_verified_files(db, rows, target, owner, *, remote_url=None):
    """Rebuild one full GitHub volume using ONE fetch, not 1,164 lazy Git fetches.

    Every copied file is independently SHA-256 checked. The archive stays on
    GitHub; any fetched checkout is inside an automatically deleted temp dir.
    """
    if not rows:
        return []
    collected = []
    repo = rows[0]['repository']
    if any(row['repository'] != repo for row in rows):
        raise RuntimeError('Mixed repositories in one Cloudflare volume')
    total_files = sum(len(json.loads(row['pages_json'])['images']) for row in rows)
    total_bytes = sum(int(im.get('bytes') or 0)
                      for row in rows for im in json.loads(row['pages_json'])['images'])
    print(f'Preparing Cloudflare volume {repo}: {total_files:,} images, '
          f'{total_bytes / (1024**2):,.1f} MiB; downloading verified GitHub archive once.',
          flush=True)
    event('CLOUDFLARE_REBUILD_PLANNED', repository=repo, images=total_files,
          image_bytes=total_bytes, source_site_requests=0)
    with tempfile.TemporaryDirectory(prefix='comic-deploy-git-') as work:
        src = Path(work)
        remote = remote_url or f'https://github.com/{owner}/{repo}.git'
        env = isolated_git_environment()
        env['GCM_NAMESPACE'] = get_option(db, 'github_credential_namespace') or 'comic-archiver-unauthorized'
        def git(*params):
            proc = git_run(['git', *params], cwd=src, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if proc.returncode:
                raise RuntimeError('Git rebuild failure: ' +
                                   proc.stderr.decode('utf-8', errors='replace')[-800:])
            return proc.stdout.decode('utf-8', errors='replace').strip()
        git('init', '-q')
        git('remote', 'add', 'origin', remote)
        # IMPORTANT: omit --filter=blob:none here; partial clones can request
        # each image individually later, yielding thousands of serial fetches.
        proc = _run_monitored_command(
            ['git', 'fetch', '--progress', '--depth=1', 'origin', 'main'],
            cwd=src, env=env, label=f'GitHub volume download: {repo}',
            show_provider_lines=True, provider_name='Git')
        if proc.returncode:
            raise RuntimeError('GitHub volume fetch failed: ' + proc.stderr[-1000:])
        print(f'GitHub volume {repo}: unpacking downloaded files...', flush=True)
        # Only a disposable, application-owned temp repository is checked out.
        git('-c', 'core.longpaths=true', 'checkout', '--force', 'FETCH_HEAD')
        progress = Progress(f'Building Cloudflare assets: {repo}', total_files, unit='images',
                            interval=2.0)
        copied_bytes = 0
        try:
            for row in rows:
                manifest = json.loads(row['pages_json'])
                paths = manifest['remote_files']
                images = manifest['images']
                if len(paths) != len(images):
                    raise RuntimeError('Inconsistent archived manifest')
                for im, relative in zip(images, paths):
                    # Git repository paths must be relative, canonical POSIX paths.
                    posix = PurePosixPath(relative)
                    if (not relative or relative.startswith(('/', '\\')) or
                            '\\' in relative or '..' in posix.parts or
                            posix.is_absolute()):
                        raise RuntimeError('Unsafe path in archive manifest')
                    source = src.joinpath(*posix.parts)
                    if not source.is_file() or source.is_symlink():
                        raise RuntimeError(f'GitHub archive missing image: {relative}')
                    data = source.read_bytes()
                    if hashlib.sha256(data).hexdigest() != im['sha256']:
                        raise RuntimeError(f'GitHub archive checksum mismatch: {relative}')
                    dest = target.joinpath(*posix.parts)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    collected.append((dest, im, relative))
                    copied_bytes += len(data)
                    progress.update(len(collected),
                        detail=f'{copied_bytes/(1024**2):.1f} MiB verified and staged')
            progress.complete(f'{copied_bytes/(1024**2):.1f} MiB staged')
        except BaseException:
            stop_progress(progress, 'FAILED; local staging will be discarded')
            raise
    event('CLOUDFLARE_REBUILD_COMPLETE', repository=repo,
          images=len(collected), bytes=copied_bytes)
    return collected


def verify_cloudflare_asset(url: str, expected_sha256: str | None = None,
                            *, expected_chapters: int | None = None,
                            attempts: int = 5):
    """Verify live site with visible retries and heartbeat during slow HTTP GETs."""
    progress = Progress('Verifying Cloudflare public URL', interval=3.0)
    last_error = None
    try:
        for attempt in range(attempts):
            response_box = queue.Queue(maxsize=1)
            def fetch():
                try:
                    response_box.put(('ok', open_reader_verify_auth.get(url, timeout=45)))
                except BaseException as err:
                    response_box.put(('error', err))
            worker = threading.Thread(target=fetch, daemon=True)
            worker.start()
            while True:
                try:
                    result_type, outcome = response_box.get(timeout=1.0)
                    break
                except queue.Empty:
                    progress.heartbeat(detail=f'attempt {attempt+1}/{attempts}')
            if result_type == 'error':
                last_error = str(outcome)
            else:
                response = outcome
                if response.status_code == 200:
                    if expected_sha256 is not None:
                        if hashlib.sha256(response.content).hexdigest() == expected_sha256:
                            progress.complete('image SHA-256 verified')
                            return response
                        last_error = 'published SHA-256 did not match GitHub archive'
                    elif expected_chapters is not None:
                        try:
                            number = len(response.json().get('chapters', []))
                        except ValueError as err:
                            last_error = f'bad published manifest JSON: {err}'
                        else:
                            if number == expected_chapters:
                                progress.complete(f'{number} chapters verified')
                                return response
                            last_error = 'manifest chapter count differs from the verified archive'
                    else:
                        progress.complete('HTTP 200 verified')
                        return response
                else:
                    last_error = f'HTTP {response.status_code}'
            if attempt < attempts - 1:
                wait_seconds = min(12, 2**attempt)
                print(f'  Publication verification attempt {attempt+1}/{attempts} '
                      f'failed ({last_error}); retrying in {wait_seconds}s.', flush=True)
                time.sleep(wait_seconds)
        stop_progress(progress, 'NOT VERIFIED')
        raise RuntimeError(f'Cloudflare verification failed for {url}: {last_error}')
    except BaseException:
        stop_progress(progress, 'FAILED')
        raise


def _volume_fingerprint(rows):
    """Stable digest of exact chapter image SHA-256 and remote asset paths."""
    records = []
    for row in rows:
        m = json.loads(row["pages_json"])
        records.append([row["chapter_id"],
                        [(path, im["sha256"]) for path, im in zip(m["remote_files"], m["images"])]] )
    return hashlib.sha256(json.dumps(records, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _reader_fingerprint(db):
    """Changes whenever stored chapter contents, volume locations, or reader code change."""
    rows = db.execute("SELECT chapter_id,repository,pages_json,label FROM chapters "
                      "WHERE status IN ('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED') ORDER BY ordinal").fetchall()
    volumes = {row[0]: row[1] for row in db.execute(
        "SELECT project,production_url FROM deployments")}
    payload = {
        "chapters": [(row[0], row[1], row[3],
                      json.loads(row[2]).get("chapter_title") or row[3],
                      json.loads(row[2]).get("remote_files"),
                      [im.get("sha256") for im in json.loads(row[2]).get("images", [])]) for row in rows],
        "volumes": [(repo, volumes.get(repo[:58], "")) for repo in sorted({row[1] for row in rows})],
        "reader_files": [(p.name, hashlib.sha256(p.read_bytes()).hexdigest())
                         for p in sorted((ROOT / "reader").iterdir()) if p.is_file()],
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _reader_chapters_for_publication(rows, deployed_projects):
    """Source-independent reader manifest built solely from archived metadata."""
    chapters = []
    for row in rows:
        manifest = json.loads(row["pages_json"])
        repo = row["repository"]
        if repo not in deployed_projects:
            raise RuntimeError(f"Reader publication is missing the asset host for {repo}")
        images = manifest.get("images") or []
        paths = manifest.get("remote_files") or []
        if not images or len(images) != len(paths):
            raise RuntimeError(f"Incomplete archived image manifest for {row['chapter_id']}")
        base = deployed_projects[repo].rstrip("/")
        image_entries = [
            {"url": base + "/" + path, "width": im["width"],
             "height": im["height"], "sha256": im["sha256"]}
            for im, path in zip(images, paths)
        ]
        title = (manifest.get("chapter_title") or row["label"] or
                 manifest.get("label") or ("Chapter " + row["chapter_id"]))
        chapters.append({"id": row["chapter_id"], "number": row["chapter_id"],
                         "label": row["label"], "title": title, "images": image_entries})
    return chapters


def _reader_archive_rows(db):
    old_factory = db.row_factory
    try:
        db.row_factory = sqlite3.Row
        return db.execute(
            "SELECT * FROM chapters WHERE status IN "
            "('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED') ORDER BY ordinal"
        ).fetchall()
    finally:
        db.row_factory = old_factory


def _record_verified_reader_deployment(db, mode, url, chapters, *, physical_project=None):
    """Checkpoint Cloudflare success BEFORE optional GitHub documentation work."""
    slug = get_option(db, 'series_slug')
    project = (slug + '-reader')[:58]
    with db:
        db.execute('REPLACE INTO deployments(project,product,production_url,deployed_at,files,bytes) '
                   'VALUES(?,?,?,?,?,?)', (project, mode, url, utc(), 5, 0))
        for chapter in chapters:
            db.execute("UPDATE chapters SET status='PUBLISHED_VERIFIED',published_url=?,updated_at=? "
                       "WHERE chapter_id=?",
                       (url.rstrip('/') + '/?chapter=' + chapter['id'], utc(), chapter['id']))
    if physical_project:
        # A logical reader entry retains the expected slug-reader name; this
        # option records the actual Pages project hosting those reader files.
        set_option(db, f'colocated_reader_volume:{mode}', physical_project)
    set_option(db, f'deployed_reader_fingerprint:{mode}', _reader_fingerprint(db))
    event('CLOUDFLARE_READER_CHECKPOINT_SAVED', url=url, chapters=len(chapters),
          github_documentation='pending_or_independent')


def _live_reader_matches_local_archive(db, mode, url):
    """Detect a successful prior deployment even if the process crashed afterward.

    Compare ALL chapters, image URL mappings, titles, and the actual frontend
    bytes. A matching chapter COUNT alone is not sufficient to adopt a site.
    """
    volumes = {}
    for (repo,) in db.execute('SELECT DISTINCT repository FROM chapters WHERE repository IS NOT NULL'):
        project = repo[:58]
        row = db.execute('SELECT production_url,product FROM deployments WHERE project=?',
                         (project,)).fetchone()
        if not row or row[1] != mode or not row[0]:
            return False
        volumes[repo] = row[0]
    rows = _reader_archive_rows(db)
    if not rows or len(rows) != db.execute('SELECT COUNT(*) FROM chapters').fetchone()[0]:
        return False
    expected = _reader_chapters_for_publication(rows, volumes)
    response = verify_cloudflare_asset(url.rstrip('/') + '/manifest.json',
                                       expected_chapters=len(expected), attempts=4)
    live = response.json()
    actual = live.get('chapters')
    if live.get('title') != get_option(db, 'series_title') or actual != expected:
        return False
    for file in sorted((ROOT / 'reader').iterdir()):
        if file.is_file():
            verify_cloudflare_asset(url.rstrip('/') + '/' + file.name,
                                    expected_sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                                    attempts=4)
    return True


def _sync_reader_documentation(db, mode, url, volume_urls, stage=None):
    """Independent, resumable GitHub documentation stage. No asset re-upload."""
    target_fingerprint = _reader_fingerprint(db)
    key = f'github_reader_docs_fingerprint:{mode}'
    if get_option(db, key) == target_fingerprint:
        event('GITHUB_READER_DOCUMENTATION_REUSED', url=url, reason='content_fingerprint_match')
        return
    update_local_readme_deployment(db, url, volume_urls)
    slug = get_option(db, 'series_slug')
    if not slug:
        raise RuntimeError('Cannot synchronize GitHub README without saved series identity')
    _, token = credential_for_selected(db)

    def publish_docs(reader_stage):
        print('GitHub: verifying reader source and README (no image downloads)...', flush=True)
        archive_reader_source(db, slug, reader_stage, token, reader_url=url)
        for repository in sorted(volume_urls):
            print(f'GitHub: updating or reusing {repository} README...', flush=True)
            update_volume_readme(db, repository, url, volume_urls[repository])

    if stage is not None:
        publish_docs(stage)
    else:
        # The Cloudflare site is already verified. Reconstruct ONLY its tiny
        # public reader manifest, not the 1,164 archived image blobs.
        with tempfile.TemporaryDirectory(prefix='comic-reader-docs-resume-') as tmp:
            reader_stage = Path(tmp)
            for file in (ROOT / 'reader').iterdir():
                if file.is_file():
                    shutil.copy2(file, reader_stage / file.name)
            response = verify_cloudflare_asset(url.rstrip('/') + '/manifest.json',
                expected_chapters=len(_reader_archive_rows(db)), attempts=2)
            live_manifest = response.json()
            expected = _reader_chapters_for_publication(_reader_archive_rows(db), volume_urls)
            if live_manifest.get('chapters') != expected:
                raise RuntimeError('The live Cloudflare chapter index changed; refusing GitHub sync')
            (reader_stage / 'manifest.json').write_bytes(response.content)
            publish_docs(reader_stage)
    set_option(db, key, target_fingerprint)
    event('GITHUB_READER_DOCUMENTATION_VERIFIED', url=url,
          volumes=len(volume_urls), fingerprint=target_fingerprint)
    print('GitHub: reader and image-volume repository READMEs verified.', flush=True)


def _published_reader_unchanged(db, mode):
    statuses = [row[0] for row in db.execute('SELECT status FROM chapters')]
    if not statuses or any(status != 'PUBLISHED_VERIFIED' for status in statuses):
        return None
    slug = get_option(db, 'series_slug')
    project = (slug + '-reader')[:58] if slug else ''
    rec = db.execute('SELECT production_url,product FROM deployments WHERE project=?',
                     (project,)).fetchone()
    if not rec or rec[1] != mode or not rec[0]:
        return None
    prior_fingerprint = get_option(db, f'deployed_reader_fingerprint:{mode}')
    current_fingerprint = _reader_fingerprint(db)
    try:
        if not _live_reader_matches_local_archive(db, mode, rec[0]):
            return None
    except (RuntimeError, ValueError, KeyError, IndexError, requests.RequestException) as exc:
        event('CLOUDFLARE_READER_REUSE_CHECK_FAILED', reason=str(exc)[:500])
        return None
    if prior_fingerprint != current_fingerprint:
        # A crash after deploy and before the old checkpoint should not force
        # uploading hundreds of megabytes again if production matches exactly.
        set_option(db, f'deployed_reader_fingerprint:{mode}', current_fingerprint)
        event('CLOUDFLARE_READER_EXISTING_DEPLOYMENT_ADOPTED', url=rec[0],
              reason='full_remote_manifest_and_reader_assets_match')
    return rec[0]


def _publish_reader_on_verified_volume(db, reader_stage, grouped, owner,
                                       deployed_projects, *, preferred_project=None):
    """Safe Pages-only fallback when new reader PROJECT creation is unavailable.

    Rebuild the COMPLETE image set from a verified, application-owned GitHub
    volume before replacing that volume's Pages deployment. This preserves
    existing image URLs; uploading only index.html would destroy them.
    Never modify an unrelated project or enable paid hosting.
    """
    if not grouped:
        raise RuntimeError('No owned image volume is available for reader co-hosting')
    static_files = [p for p in reader_stage.iterdir() if p.is_file()]
    candidates = []
    for repo, rows in grouped.items():
        project = repo[:58]
        if preferred_project and project != preferred_project:
            continue
        rec = db.execute('SELECT product,production_url FROM deployments WHERE project=?',
                         (project,)).fetchone()
        if not rec or rec[0] != 'pages' or not rec[1] or deployed_projects.get(repo) != rec[1]:
            continue  # only a verified, archiver-owned, already-published host
        image_count = sum(len(json.loads(r['pages_json'])['images']) for r in rows)
        if image_count + len(static_files) > CONFIG['cloudflare_project_max_files']:
            continue
        reserved = {p.relative_to(reader_stage).as_posix() for p in static_files}
        if any(path in reserved for r in rows
               for path in json.loads(r['pages_json'])['remote_files']):
            continue  # never overwrite an image with reader index assets
        candidates.append((image_count, repo, rows))
    if not candidates:
        raise RuntimeError('Cloudflare cannot create the reader project and no '
                           'verified existing image project has enough safe '
                           'file capacity for a complete co-hosted deployment. '
                           'Archive remains intact; retry when Cloudflare permits '
                           'new projects or contact Cloudflare support.')
    _, repo, rows = min(candidates, key=lambda x: (x[0], x[1]))
    project = repo[:58]
    print(f"Cloudflare: using existing verified Pages project '{project}' "
          'for BOTH the reader and its images, since new project creation is '
          'temporarily unavailable. Rebuilding the COMPLETE volume so no '
          'previous image URLs disappear.', flush=True)
    event('CLOUDFLARE_READER_COLOCATION_START', project=project,
          image_repository=repo, reason='new_pages_project_unavailable')
    existing_reader_bytes = sum(p.stat().st_size for p in static_files)
    copied = _fetch_verified_files(db, rows, reader_stage, owner)
    if any(p.stat().st_size > PAGES_LIMIT for p, _, _ in copied):
        raise RuntimeError('Image exceeds Pages asset limit; cannot co-host')
    url = deploy_cloudflare_assets(db, project, reader_stage, mode='pages')
    # Verify the image bytes stayed identical after publishing the new root.
    for f, image, path in (copied[:1] + copied[-1:] if len(copied) > 1 else copied):
        verify_cloudflare_asset(url.rstrip('/') + '/' + path,
                                expected_sha256=image['sha256'])
    with db:
        db.execute('UPDATE deployments SET deployed_at=?,files=?,bytes=? '
                   'WHERE project=? AND product=?',
                   (utc(), len(copied) + len(static_files),
                    sum(f.stat().st_size for f, _, _ in copied) + existing_reader_bytes,
                    project, 'pages'))
    event('CLOUDFLARE_READER_COLOCATION_VERIFIED', project=project,
          url=url, images=len(copied), total_files=len(copied)+len(static_files))
    return url, project


def deploy_run(db, mode='shared-worker', update_scope='full'):
    if mode == 'shared-worker':
        if update_scope in ('comic','site'):
            from .open_reader_focused import publish as publish_focused
            url=publish_focused(sys.modules[__name__],db,scope=update_scope)
            if update_scope == 'comic':
                from .shared_reader_volume import verify_current_in_shared_reader
                verify_current_in_shared_reader(sys.modules[__name__],db,url)
            return url
        # The shared publisher enumerates only comics with a trusted public
        # image-volume host. A GitHub-verified archive with no Pages host was
        # silently omitted before this preflight, despite intact image files.
        from .shared_reader_volume import ensure_current_image_hosts, verify_current_in_shared_reader
        from .github_streaming import load_mode
        if not load_mode(ROOT):
            ensure_current_image_hosts(sys.modules[__name__], db)
        else:
            print('Cloudflare: GitHub streaming mode: skipping all Pages image-volume transfers.', flush=True)
        from .open_reader import publish
        url = publish(sys.modules[__name__], db)
        verify_current_in_shared_reader(sys.modules[__name__], db, url)
        return url
    print('Cloudflare: verifying existing published reader before any upload...', flush=True)
    already_live = _published_reader_unchanged(db, mode)
    if already_live:
        print('VERIFIED READER URL:', already_live, flush=True)
        vol_urls = {}
        for (repo,) in db.execute('SELECT DISTINCT repository FROM chapters WHERE repository IS NOT NULL'):
            rec = db.execute('SELECT production_url,product FROM deployments WHERE project=?',
                             (repo[:58],)).fetchone()
            if not rec or rec[1] != mode:
                raise RuntimeError(f'Missing verified Cloudflare asset deployment: {repo}')
            vol_urls[repo] = rec[0]
        _sync_reader_documentation(db, mode, already_live, vol_urls)
        event('CLOUDFLARE_DEPLOYMENT_REUSED', url=already_live,
              new_deployments=0, source_site_requests=0)
        print('COMPLETED: live Cloudflare reader and GitHub READMEs verified.', flush=True)
        return
    select_cloudflare_account()
    print("Cloudflare: checking GitHub-archived volumes and local publication records...", flush=True)
    slug = get_option(db, "series_slug")
    if not slug:
        raise RuntimeError("No archived series. Run --archive first.")
    title = get_option(db, "series_title")
    owner, _ = credential_for_selected(db)
    db.row_factory = sqlite3.Row
    pending = db.execute("SELECT * FROM chapters WHERE status IN ('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED') ORDER BY ordinal").fetchall()
    if not pending:
        raise RuntimeError("No verified chapters available for publication")
    # Each immutable or growing image-volume project maps to a GitHub repository.
    # Cloudflare deployment must always include a COMPLETE volume, never a delta.
    grouped = {}
    for r in pending:
        grouped.setdefault(r["repository"], []).append(r)
    print(f'Cloudflare publication plan: {len(grouped)} volume(s), '
          f'{len(pending)} already-archived chapters. No source website requests.', flush=True)
    publication_progress = Progress('Cloudflare image volumes', total=len(grouped), unit='volumes', interval=3.0)
    deployed_projects = {}
    for repo, rows in grouped.items():
        project = repo[:58]
        expected_fingerprint = _volume_fingerprint(rows)
        prior = db.execute("SELECT production_url,product FROM deployments WHERE project=?", (project,)).fetchone()
        if (prior and prior[1] == mode and prior[0] and
                get_option(db, f"deployed_volume_fingerprint:{mode}:{project}") == expected_fingerprint):
            try:
                first = json.loads(rows[0]["pages_json"])
                last = json.loads(rows[-1]["pages_json"])
                for manifest, idx in ((first, 0), (last, -1)):
                    verify_cloudflare_asset(prior[0].rstrip("/") + "/" + manifest["remote_files"][idx],
                                            expected_sha256=manifest["images"][idx]["sha256"], attempts=2)
                deployed_projects[repo] = prior[0]
                publication_progress.update(len(deployed_projects), f"reused {repo}")
                event("CLOUDFLARE_VOLUME_REUSED", project=project, url=prior[0],
                      source_site_requests=0, uploaded_assets=0)
                continue
            except (RuntimeError, ValueError, KeyError, IndexError):
                event("CLOUDFLARE_VOLUME_REDEPLOY_REQUIRED", project=project,
                      reason="live_asset_or_fingerprint_mismatch")
        print(f'Cloudflare volume {repo}: preparing full, checksum-verified GitHub asset set...', flush=True)
        estimated_files = sum(len(json.loads(r["pages_json"])["images"]) for r in rows)
        if estimated_files > CONFIG["cloudflare_project_max_files"]:
            raise RuntimeError(f"{project}: Cloudflare file limit exceeded. Split this repo's assets before deploy.")
        with tempfile.TemporaryDirectory(prefix="comic-cloudflare-volume-") as tmp:
            root = Path(tmp)
            copied = _fetch_verified_files(db, rows, root, owner)
            if any(p.stat().st_size > PAGES_LIMIT for p, _, _ in copied):
                raise RuntimeError(f"{project}: image over 25 MiB. A different serving method is required; refusing incomplete publication.")
            event("CLOUDFLARE_DEPLOY_START", project=project, files=len(copied))
            url = deploy_cloudflare_assets(db, project, root, mode=mode)
            # Check one published image for byte integrity and availability.
            for f, im, rel in copied[:1] + copied[-1:]:
                verify_cloudflare_asset(url + "/" + rel, expected_sha256=im["sha256"])
            with db:
                db.execute("REPLACE INTO deployments(project,product,production_url,deployed_at,files,bytes) VALUES(?,?,?,?,?,?)",
                           (project, mode, url, utc(), len(copied), sum(p.stat().st_size for p, _, _ in copied)))
            deployed_projects[repo] = url
            publication_progress.update(len(deployed_projects), f"verified {repo}")
            set_option(db, f"deployed_volume_fingerprint:{mode}:{project}", expected_fingerprint)
            event("CLOUDFLARE_VOLUME_VERIFIED", project=project, url=url, images=len(copied))
    publication_progress.complete('all image volumes verified')
    # Only now publish global index referencing verified volume projects.
    print('Cloudflare: all image volumes verified. Preparing the main reader index...', flush=True)
    chapters = _reader_chapters_for_publication(pending, deployed_projects)
    with tempfile.TemporaryDirectory(prefix="comic-cloudflare-main-") as tmp:
        stage = Path(tmp)
        for file in (ROOT / "reader").iterdir():
            if file.is_file():
                shutil.copy2(file, stage / file.name)
        atomic_json(stage / "manifest.json", {"title": title, "chapters": chapters, "generated_at": utc()})
        # Publish first, so GitHub READMEs can contain the ACTUAL verified URL.
        name = (slug + "-reader")[:58]
        print('Cloudflare: deploying main reader site...', flush=True)
        colocated_project = None
        saved_colocated = get_option(db, f'colocated_reader_volume:{mode}') if mode == 'pages' else None
        if saved_colocated:
            # Once a series used a co-hosted reader, preserve its stable URL
            # instead of creating a different project on subsequent updates.
            url, colocated_project = _publish_reader_on_verified_volume(
                db, stage, grouped, owner, deployed_projects,
                preferred_project=saved_colocated)
        else:
            try:
                url = deploy_cloudflare_assets(db, name, stage, mode=mode)
            except PagesProjectCreationUnavailable as error:
                if mode != 'pages':
                    raise
                print('Cloudflare is refusing new Pages projects (8000000). '
                      'Attempting safe reader co-hosting instead of re-uploading '
                      'all assets to a new account or leaving the reader offline.',
                      flush=True)
                event('CLOUDFLARE_READER_NEW_PROJECT_UNAVAILABLE',
                      project=name, reason=str(error)[-600:])
                url, colocated_project = _publish_reader_on_verified_volume(
                    db, stage, grouped, owner, deployed_projects)
        verify_cloudflare_asset(url + "/manifest.json",
                                expected_sha256=hashlib.sha256((stage / "manifest.json").read_bytes()).hexdigest())
        if not _live_reader_matches_local_archive(db, mode, url):
            raise RuntimeError('Cloudflare returned a reader different from the archived chapter index; '
                               'not recording a successful deployment')
        # The Cloudflare deployment has ALREADY succeeded. Record this durable
        # checkpoint BEFORE GitHub README/source synchronization. A failure in
        # GitHub docs must not force a second Cloudflare upload on resume.
        _record_verified_reader_deployment(db, mode, url, chapters,
                                           physical_project=colocated_project)
        print('GitHub: synchronizing reader URL and chapter titles...', flush=True)
        # Co-hosting temporarily adds all image files to `stage` for a COMPLETE
        # Pages asset deployment. Those image copies must NEVER be committed to
        # the small GitHub reader-source repository. Rebuild its tiny source
        # staging separately from the published manifest instead.
        _sync_reader_documentation(db, mode, url, deployed_projects,
                                   stage=None if colocated_project else stage)
        print("VERIFIED READER URL:", url, flush=True)
        if all_work_completed(db):
            print(f'COMPLETED: all {len(chapters)} archived chapters are published; no pending work.', flush=True)
        else:
            print(f'Published {len(chapters)} verified chapters; some additional catalog work remains.', flush=True)
        event("CLOUDFLARE_READER_VERIFIED", url=url, chapters=len(chapters))


def audit_resources(db):
    """Non-destructive dependency audit; never delete referenced remote content."""
    slug = get_option(db,'series_slug') or ''
    reader = db.execute('SELECT production_url FROM deployments WHERE project=?',
                        ((slug+'-reader')[:58],)).fetchone()
    print('\nARCHIVE RESOURCE DEPENDENCY AUDIT (read-only)')
    print('Reader repository:', (slug+'-reader') if slug else '(unknown)',
          '— reader source, manifest, README; KEEP')
    print('Reader website:', reader[0] if reader else '(not yet verified)')
    for repo, count in db.execute('SELECT repository,COUNT(*) FROM chapters WHERE repository IS NOT NULL GROUP BY repository ORDER BY repository'):
        proj=repo[:58]
        rec=db.execute('SELECT production_url FROM deployments WHERE project=?',(proj,)).fetchone()
        print(f'Image volume repository: {repo} — {count} chapters; KEEP')
        print(f'Cloudflare image host: {rec[0] if rec else "not deployed"} — KEEP while reader references its image URLs')
    print('No remote repository or project will be deleted automatically.')


def status(db):
    print("\nComic:", get_option(db, "series_title", "(not configured)"))
    stat_count = dict(db.execute("SELECT status,COUNT(*) FROM chapters GROUP BY status"))
    for stat, n in stat_count.items():
        print(f"  {stat}: {n}")
    now=time.time()
    for repo, size, files in db.execute("SELECT name,logical_bytes,file_count FROM repositories ORDER BY name"):
        timestamps = [x[0] for x in db.execute("SELECT ts FROM push_events WHERE repository=? AND ts>? ORDER BY ts", (repo,now-60))]
        limit=CONFIG["pushes_per_minute"]
        remaining_seconds = max(0, int(timestamps[-limit]+61-now)) if len(timestamps)>=limit else 0
        print(f"  GitHub {repo}: {size/1024**2:.1f} MiB logical, {files} images; "
              f"{len(timestamps)}/{limit} pushes in 60s; next allowed in {remaining_seconds}s")
    reader_project = ((get_option(db, 'series_slug') or '') + '-reader')[:58]
    for proj, product, url, files, count_bytes in db.execute("SELECT project,product,production_url,files,bytes FROM deployments"):
        actual_host = get_option(db, f'colocated_reader_volume:{product}') if proj == reader_project else None
        suffix = f' [reader co-hosted on {actual_host}]' if actual_host else ''
        print(f"  Cloudflare {product} {proj}: {url}; {files} files, {count_bytes/1024**2:.1f} MiB{suffix}")
    pending=stat_count.get("ARCHIVED_PENDING_DEPLOYMENT",0)
    print(f"  Pending Cloudflare publication: {pending} verified GitHub chapters")
    print("  Actual provider build/API quotas: UNKNOWN unless returned by provider responses")
    print("  GitHub account:",get_option(db,"github_owner","not selected"))
    try:
        from .open_reader import load_state
        library = load_state(ROOT)
        if library.get('worker_url'):
            print('  Shared open-reader:', library['worker_url'],
                  f"({len(library.get('comics', {}))} comics)")
    except (ValueError, OSError, RuntimeError):
        pass
    print("  Logs:", DATA / "events.jsonl")



def _source_chapter_done(status, *, retry_server_failures=False):
    """Whether this chapter needs NO new source-browser requests.

    A confirmed server-side missing panel stays in SQLite and in the issue feed.
    A GitHub-verified chapter awaiting local cleanup is also not source work.
    Neither status is allowed to masquerade as a published complete chapter.
    """
    return (status in PUBLISHABLE_STATES or status == 'ARCHIVED_VERIFIED' or
            (status == 'SOURCE_SERVER_DEFERRED' and not retry_server_failures))


def _source_resume_candidates(db, stored, *, retry_server_failures=False):
    """Ordered first genuinely unarchived/downloader-failed chapter through newest.

    Does not alter status or source-issue reports. This prevents a known server
    gap (82) from replaying all verified chapters (83--98) on every run.
    """
    rows = dict(db.execute('SELECT chapter_id,status FROM chapters'))
    missing_rows = [ch.chapter_id for ch in stored if str(ch.chapter_id) not in rows]
    if missing_rows:
        raise RuntimeError('Saved chapter catalog and status records disagree: '+str(missing_rows[:8]))
    return [ch for ch in stored if not _source_chapter_done(
        rows[str(ch.chapter_id)], retry_server_failures=retry_server_failures)]


ARCHIVED_STATES = frozenset({"ARCHIVED_VERIFIED", "LOCAL_FILES_DELETED",
                             "ARCHIVED_PENDING_DEPLOYMENT", "PUBLISHED_VERIFIED"})
PUBLISHABLE_STATES = frozenset({"ARCHIVED_PENDING_DEPLOYMENT", "PUBLISHED_VERIFIED"})


def _catalog_complete(db):
    """Trust an actual saved discovery record, including pre-refactor JSONL logs."""
    count = db.execute("SELECT COUNT(*) FROM chapters").fetchone()[0]
    if not count:
        return False
    known = get_option(db, "chapter_catalog_complete", False)
    documented_total = get_option(db, "chapter_catalog_total")
    if known and documented_total == count:
        return True
    # The previous 60-chapter release logged discovery but did not persist a
    # catalog completion flag. Recover it without opening the original site.
    log = DATA / "events.jsonl"
    if log.exists():
        title = get_option(db, "series_title")
        for line in reversed(log.read_text(encoding="utf-8", errors="replace").splitlines()):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("event") != "CHAPTER_DISCOVERY_COMPLETE":
                continue
            if obj.get("total") == count and (not title or obj.get("title") == title):
                set_option(db, "chapter_catalog_complete", True)
                set_option(db, "chapter_catalog_total", count)
                event("CHAPTER_CATALOG_RESTORED", chapters=count, source="legacy_events_jsonl")
                return True
            break  # only the most recent actual complete-discovery event
    # This source-specific value is a recovery hint for the supplied HTML, not
    # a hardcoded generic Webtoon episode count.
    hint = getattr(ADAPTER, "ARCHIVED_SOURCE_CHAPTER_COUNT", None)
    if hint and count == hint and all(
        row[0] in ARCHIVED_STATES
        for row in db.execute("SELECT status FROM chapters")
    ):
        set_option(db, "chapter_catalog_complete", True)
        set_option(db, "chapter_catalog_total", count)
        event("CHAPTER_CATALOG_RESTORED", chapters=count, source="site_adapter_hint")
        return True
    return False


def _saved_chapters(db):
    return [Chapter(str(a), b, c) for a,b,c in
            db.execute("SELECT chapter_id,label,url FROM chapters ORDER BY ordinal,chapter_id")]


def _existing_github_volumes(db, owner, slug, token):
    """Reuse known old/new repos; discover orphan repos after interrupted runs."""
    referenced = {row[0] for row in db.execute(
        "SELECT DISTINCT repository FROM chapters WHERE repository IS NOT NULL")}
    referenced.discard(None)
    # A repo_for_chapter() reservation can exist without any successful push.
    # Do not fetch a nonexistent empty volume placeholder.
    recorded = {row[0] for row in db.execute(
        "SELECT name FROM repositories WHERE last_sha IS NOT NULL OR file_count > 0")}
    known = {r for r in referenced | recorded if r and r.startswith(slug + "-vol-")}
    statuses = [row[0] for row in db.execute("SELECT status FROM chapters")]
    fully_indexed = bool(known and statuses and all(s in ARCHIVED_STATES for s in statuses)
                         and _catalog_complete(db))
    if fully_indexed:
        return sorted(known)
    if not slug:
        return sorted(known)
    found = set(known)
    for page in range(1, 11):
        response = github_http("GET", f"{GITHUB_API}/user/repos", token,
                               params={"affiliation":"owner", "per_page":100, "page":page})
        if response.status_code != 200:
            raise RuntimeError(f"Cannot inventory existing GitHub repos (HTTP {response.status_code}); "
                               "not starting the source crawler blindly")
        data = response.json()
        if not isinstance(data, list):
            raise RuntimeError("Unexpected GitHub repository list response")
        for item in data:
            name = item.get("name", "")
            login = (item.get("owner") or {}).get("login", "")
            if name.startswith(slug + "-vol-") and login.lower() == owner.lower():
                if not item.get("private", False):
                    raise RuntimeError("Existing volume repo is not private: " + name)
                found.add(name)
        if len(data) < 100:
            break
    if found:
        event("GITHUB_EXISTING_VOLUMES_FOUND", count=len(found), repos=sorted(found))
    return sorted(found)


def _manifest_order(manifest):
    """Use immutable saved ordinal, otherwise natural chapter ID/URL order."""
    if isinstance(manifest.get("ordinal"), int):
        return (0, manifest["ordinal"])
    fn = getattr(ADAPTER, "recovered_chapter_order", None)
    if callable(fn):
        custom = fn(manifest)
        if custom is not None:
            return (1, custom)
    ident = str(manifest.get("chapter_id", ""))
    return (2, tuple((0, int(t)) if t.isdigit() else (1, t.casefold())
                     for t in re.split(r"(\d+)", ident)))


def _archived_volume_fingerprint(db, repo):
    """Immutable digest of locally verified remote manifests for one volume.

    A matching Git commit tip plus this digest proves that already-verified
    remote manifest/image bytes have not changed. No repeat packfile download
    is needed on every run. Partial/malformed state may never take this path.
    """
    rows = db.execute('SELECT chapter_id,status,pages_json FROM chapters WHERE repository=? ORDER BY chapter_id',
                      (repo,)).fetchall()
    if not rows or any(status not in ARCHIVED_STATES or not contents for _,status,contents in rows):
        return None
    digest = hashlib.sha256()
    for chapter_id, _, contents in rows:
        digest.update(str(chapter_id).encode('utf-8'))
        digest.update(b'\0')
        digest.update(contents.encode('utf-8'))
        digest.update(b'\0')
    return {'chapters': len(rows), 'fingerprint': digest.hexdigest()}


def reconcile_github_archive(db):
    """Read-only, no-source-site preflight; recover old/new archives from GitHub.

    This deliberately runs before source-browser launch or lazy scrolling.
    Remote manifest/paths are checked for previously verified chapters; remote
    *image bytes* are SHA-256 checked only for records missing trusted local
    verification, avoiding a 1,164-image re-download during normal resume.
    """
    local_count = db.execute("SELECT COUNT(*) FROM chapters").fetchone()[0]
    known_repos = db.execute("SELECT COUNT(*) FROM repositories").fetchone()[0]
    owner = get_option(db, "github_owner")
    if not owner:
        if local_count or known_repos:
            raise RuntimeError("Existing archive state has no selected GitHub account; "
                               "use --github-login. Source crawling is paused to avoid duplicate uploads")
        return {"remote_chapters": 0, "recovered": 0, "repos": 0}
    slug = get_option(db, "series_slug") or getattr(ADAPTER, "SERIES_SLUG_HINT", "")
    if not slug:
        saved_url = get_option(db, "source_url") or getattr(ADAPTER, "DEFAULT_START_URL", "")
        parser = getattr(ADAPTER, "series_slug_from_url", None)
        if callable(parser):
            slug = parser(saved_url)
    if not slug:
        # Other websites can still archive normally with the single adapter;
        # do not invent repositories that cannot be identified safely.
        event("GITHUB_INVENTORY_SKIPPED", reason="series_slug_unknown")
        return {"remote_chapters": 0, "recovered": 0, "repos": 0}
    owner, token = credential_for_selected(db)
    repos = _existing_github_volumes(db, owner, slug, token)
    if not repos:
        if any(row[0] in ARCHIVED_STATES for row in db.execute("SELECT status FROM chapters")):
            raise RuntimeError("SQLite records claim verified GitHub chapters, but the known "
                               "volume repositories are unavailable. Not reopening or redownloading the source")
        event("GITHUB_INVENTORY_EMPTY", slug=slug)
        return {"remote_chapters": 0, "recovered": 0, "repos": 0}
    from .archive_inventory import read_remote_chapters, ArchiveInventoryError
    env = isolated_git_environment()
    env["GCM_NAMESPACE"] = get_option(db, "github_credential_namespace") or "comic-archiver-unauthorized"
    archived_rows = db.execute("SELECT chapter_id,status,pages_json,repository,ordinal FROM chapters").fetchall()
    trusted = {
        (row[0], row[3]): json.loads(row[2])
        for row in archived_rows
        if row[1] in ARCHIVED_STATES and row[2] and row[3]
    }
    remote_chapters = {}
    # Git commit hashes identify immutable remote contents. After one complete
    # SHA-256/manifest verification we can check ls-remote + local fingerprint
    # instead of fetching the same packfile for every future invocation.
    cache = get_option(db, 'github_verified_tips_v1', {})
    if not isinstance(cache, dict):
        cache = {}
    full_catalog = _catalog_complete(db) and bool(archived_rows) and all(
        status in ARCHIVED_STATES for _,status,_,_,_ in archived_rows)
    for repo in repos:
        local_by_id = {chapter_id: manifest for (chapter_id, r), manifest in trusted.items() if r == repo}
        cached = cache.get(repo)
        fingerprint = _archived_volume_fingerprint(db, repo) if full_catalog else None
        found = None
        if (fingerprint and isinstance(cached, dict)
                and cached.get('fingerprint') == fingerprint['fingerprint']
                and cached.get('chapters') == fingerprint['chapters']
                and isinstance(cached.get('tip'), str) and len(cached['tip']) == 40):
            from .archive_inventory import remote_tip, ArchiveInventoryError
            try:
                latest = remote_tip(owner, repo, env)
            except ArchiveInventoryError as ex:
                raise RuntimeError(f'GitHub cannot confirm the saved {repo} commit: {ex}; '
                                   'not re-downloading the source website') from ex
            if latest == cached['tip']:
                print(f'GitHub metadata: {repo} unchanged ({fingerprint["chapters"]} chapters); '
                      'skipped full Git fetch.', flush=True)
                found = [dict(chapter_id=chapter_id, manifest=manifest,
                              repository=repo, tip_sha=latest, previously_verified=True)
                         for chapter_id, manifest in local_by_id.items()]
                event('GITHUB_ARCHIVE_UNCHANGED_COMMIT', repository=repo,
                      chapters=len(found), remote_tip=latest,
                      git_packfile_downloads=0, source_downloads=0)
        if found is None:
            try:
                found = read_remote_chapters(owner, repo, env, local_by_id)
            except ArchiveInventoryError as ex:
                raise RuntimeError(f"Cannot confirm {owner}/{repo}; keeping saved state and "
                                   f"not recrawling the original site. {ex}") from ex
        for record in found:
            ident = record['chapter_id']
            if ident in remote_chapters:
                raise RuntimeError(f"Chapter {ident} appears in multiple GitHub volumes; "
                                   "manual reconciliation required before further uploading")
            remote_chapters[ident] = record
    for chapter_id, status, stored_json, repo, _ in archived_rows:
        if status in ARCHIVED_STATES and chapter_id in remote_chapters and stored_json:
            try:
                local_manifest = json.loads(stored_json)
            except (ValueError, TypeError) as exc:
                raise RuntimeError(f"Saved manifest for verified chapter {chapter_id} is damaged; "
                                   "stop rather than silently recrawl") from exc
            remote_manifest = remote_chapters[chapter_id]["manifest"]
            if local_manifest != remote_manifest:
                from .title_maintenance import only_title_metadata_changed
                if not only_title_metadata_changed(local_manifest, remote_manifest):
                    raise RuntimeError(f"GitHub manifest for previously verified chapter {chapter_id} "
                                       "has changed beyond chapter titles; refusing overwrite or duplicate download")
                with db:
                    db.execute("UPDATE chapters SET label=?,pages_json=?,commit_sha=?,updated_at=? WHERE chapter_id=?",
                               (remote_manifest.get('chapter_title') or remote_manifest.get('label') or chapter_id,
                                json.dumps(remote_manifest,ensure_ascii=False),
                                remote_chapters[chapter_id]['tip_sha'], utc(), chapter_id))
                event('GITHUB_NATIVE_TITLE_METADATA_RECOVERED', chapter=chapter_id,
                      source_image_redownloads=0)
        if status in ARCHIVED_STATES and chapter_id not in remote_chapters:
            raise RuntimeError(f"Previously verified chapter {chapter_id} is now missing "
                               "from the known GitHub repositories. Local files will not be redownloaded")
        if status in ARCHIVED_STATES and remote_chapters[chapter_id]["repository"] != repo:
            raise RuntimeError(f"GitHub volume mismatch for verified chapter {chapter_id}; not uploading duplicates")
    recovered = 0
    existing_ids = {row[0] for row in archived_rows}
    next_ordinal = db.execute("SELECT COALESCE(MAX(ordinal)+1,0) FROM chapters").fetchone()[0]
    sorted_recovered = sorted((x for x in remote_chapters.values() if x["chapter_id"] not in existing_ids),
                              key=lambda x: _manifest_order(x["manifest"]))
    for record in sorted_recovered:
        m = record["manifest"]
        ident = record["chapter_id"]
        ordinal = m.get("ordinal") if isinstance(m.get("ordinal"), int) else next_ordinal
        next_ordinal = max(next_ordinal + 1, ordinal + 1)
        with db:
            db.execute("INSERT INTO chapters (chapter_id,label,url,ordinal,status,repository,commit_sha,bytes,pages_json,updated_at) "
                       "VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (ident, m.get("label") or ident, m.get("original_url") or "", ordinal,
                        "ARCHIVED_VERIFIED", record["repository"], record["tip_sha"],
                        sum(int(im.get("bytes") or 0) for im in m["images"]),
                        json.dumps(m), utc()))
        recovered += 1
        event("GITHUB_CHAPTER_RECOVERED", chapter=ident, repo=record["repository"],
              images=len(m["images"]), remote_sha256_verified=True)
    for record in remote_chapters.values():
        ident = record["chapter_id"]
        if ident in existing_ids:
            row = db.execute("SELECT status,pages_json FROM chapters WHERE chapter_id=?", (ident,)).fetchone()
            if row and row[0] in ARCHIVED_STATES and not row[1]:
                # A legacy database may contain the verified status but not
                # a usable manifest. The remote reader already SHA-256 checked
                # all image bytes because this record was not trusted.
                m = record["manifest"]
                with db:
                    db.execute("UPDATE chapters SET pages_json=?,commit_sha=?,bytes=?,updated_at=? WHERE chapter_id=?",
                               (json.dumps(m), record["tip_sha"],
                                sum(int(im.get("bytes") or 0) for im in m["images"]), utc(), ident))
                recovered += 1
                event("GITHUB_LEGACY_MANIFEST_RESTORED", chapter=ident,
                      remote_sha256_verified=True)
            if row and row[0] not in ARCHIVED_STATES:
                # A previous run may have pushed successfully but crashed before
                # committing SQLite. Independent remote SHA-256 has been checked.
                m = record["manifest"]
                with db:
                    db.execute("UPDATE chapters SET status='ARCHIVED_VERIFIED',repository=?,commit_sha=?,bytes=?,pages_json=?,updated_at=? "
                               "WHERE chapter_id=?",
                               (record["repository"],record["tip_sha"],
                                sum(int(im.get("bytes") or 0) for im in m["images"]),
                                json.dumps(m),utc(),ident))
                recovered += 1
                event("GITHUB_INCOMPLETE_LOCAL_STATE_RECOVERED", chapter=ident,
                      remote_sha256_verified=True)
        # Finalize old verified-but-not-cleaned stages without browser work.
        current = db.execute("SELECT status FROM chapters WHERE chapter_id=?", (ident,)).fetchone()[0]
        if current in {"ARCHIVED_VERIFIED", "LOCAL_FILES_DELETED"}:
            folder = DATA / "temporary_downloads" / safe_slug(ident, 45)
            ensure_cleanup(folder)
            with db:
                db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT',updated_at=? WHERE chapter_id=?",
                           (utc(), ident))
    if remote_chapters and not get_option(db, "series_slug"):
        set_option(db, "series_slug", slug)
    if remote_chapters and not get_option(db, "series_title"):
        one = next(iter(remote_chapters.values()))["manifest"]
        set_option(db, "series_title", one.get("series_title") or slug.replace("-", " ").title())
    # Repository counters are reconstructable from remote manifests, so old
    # sqlite state is not a dependency for avoiding unnecessary repo rotation.
    remote_by_repo = {}
    for record in remote_chapters.values():
        remote_by_repo.setdefault(record["repository"], []).append(record["manifest"])
    for repo, manifests in remote_by_repo.items():
        count = sum(len(m["images"]) for m in manifests)
        size = sum(int(im.get("bytes") or 0) for m in manifests for im in m["images"])
        with db:
            db.execute("INSERT OR IGNORE INTO repositories(name,logical_bytes,file_count,updated_at) VALUES(?,?,?,?)",
                       (repo,size,count,utc()))
            db.execute("UPDATE repositories SET logical_bytes=?,file_count=?,updated_at=? WHERE name=?",
                       (size,count,utc(),repo))
    _catalog_complete(db)
    if _catalog_complete(db) and remote_chapters and all(
            row[0] in ARCHIVED_STATES for row in db.execute('SELECT status FROM chapters')):
        fresh_cache = dict(cache)
        for repo in repos:
            members = [r for r in remote_chapters.values() if r['repository'] == repo]
            fingerprint = _archived_volume_fingerprint(db, repo)
            if (not fingerprint or fingerprint['chapters'] != len(members)
                    or len({r['tip_sha'] for r in members}) != 1):
                fresh_cache.pop(repo, None)
                continue
            tip = members[0]['tip_sha']
            if isinstance(tip, str) and len(tip) == 40:
                fresh_cache[repo] = {**fingerprint, 'tip': tip}
        set_option(db, 'github_verified_tips_v1', fresh_cache)
    event("GITHUB_ARCHIVE_RECONCILED", repos=len(repos), remote_chapters=len(remote_chapters),
          recovered=recovered, source_site_requests=0, image_redownloads_from_source=0)
    return {"remote_chapters": len(remote_chapters), "recovered": recovered, "repos": len(repos)}


def archive_is_complete(db):
    """True only with a completed saved chapter catalog and cleaned GitHub archives."""
    if not _catalog_complete(db):
        return False
    statuses = [row[0] for row in db.execute("SELECT status FROM chapters")]
    return bool(statuses) and all(status in PUBLISHABLE_STATES for status in statuses)




def all_work_completed(db, *, mode='pages', worker_url=None):
    """Strict shutdown gate for legacy readers AND the shared open-reader Worker.

    A successful no-op publication is still a completed run. For a shared
    Worker, `publish()` must have returned *this run* after verifying every
    image host and every staged HTML/JS/CSS/JSON route; local stale state alone
    can never authorize a shutdown.
    """
    if not _catalog_complete(db):
        return False
    rows = db.execute('SELECT chapter_id,status,published_url FROM chapters').fetchall()
    if not rows or any(status != 'PUBLISHED_VERIFIED' or not url
                       for _,status,url in rows):
        return False
    slug = get_option(db, 'series_slug')
    if not slug:
        return False
    if mode == 'shared-worker':
        if not isinstance(worker_url, str) or not worker_url.startswith('https://open-reader.'):
            return False
        from .open_reader import load_state
        try:
            registry = load_state(ROOT)
        except (OSError, ValueError, RuntimeError, TypeError):
            return False
        if registry.get('worker_url', '').rstrip('/') != worker_url.rstrip('/'):
            return False
        comic = registry.get('comics', {}).get(slug)
        if not comic:
            return False
        expected_ids = {str(chapter_id) for chapter_id,_,_ in rows}
        published_ids = {str(ch.get('id')) for ch in comic.get('chapters', [])}
        if not expected_ids or expected_ids != published_ids:
            return False
        route = worker_url.rstrip('/') + '/comics/' + slug + '/'
        from urllib.parse import quote
        return all(url == route + '?chapter=' + quote(str(chapter_id), safe='')
                   for chapter_id, _, url in rows)
    project = (slug + '-reader')[:58]
    record = db.execute('SELECT production_url FROM deployments WHERE project=?', (project,)).fetchone()
    return bool(record and record[0])


def request_windows_shutdown_after_completion(db, delay_seconds=60, *,
                                              mode='pages', worker_url=None):
    """Explicit opt-in ONLY. Never shutdown on failure/pending work/non-Windows."""
    if not all_work_completed(db, mode=mode, worker_url=worker_url):
        print('No shutdown requested: at least one archive/publication step is incomplete.',
              flush=True)
        return False
    if os.name != 'nt':
        print('Windows shutdown not available on this platform; exiting normally.', flush=True)
        return False
    command = ['shutdown.exe', '/s', '/t', str(delay_seconds),
               '/c', 'Comic Archiver finished and verified Cloudflare publication']
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Windows shutdown request failed: ' +
                           result.stderr.decode('utf-8', errors='replace')[-400:])
    event('WINDOWS_SHUTDOWN_SCHEDULED', seconds_until_shutdown=delay_seconds,
          reason='all_chapters_published_and_verified')
    print(f'Windows shutdown requested: computer will shut down in {delay_seconds} seconds.',
          flush=True)
    print('To cancel immediately in another CMD window: shutdown /a', flush=True)
    return True


def build_parser():
    a = argparse.ArgumentParser(description="Authorized comic archiver, GitHub permanent archive, Cloudflare Pages reader")
    a.add_argument("--source-html", type=Path)
    a.add_argument("--source-url")
    a.add_argument("--source-login", action="store_true", help="Open persistent visible browser for manual source-site login")
    browser_args = a.add_mutually_exclusive_group()
    browser_args.add_argument('--source-headless', action='store_true', help='Force Firefox/Chromium headless; requires existing browser profile')
    browser_args.add_argument('--source-visible', action='store_true', help='Force visible source browser; useful for logging in')
    a.add_argument('--source-browser', choices=('firefox','chromium','extension'),
                   default=getattr(ADAPTER, 'SOURCE_BROWSER_TRANSPORT', 'firefox'),
                   help='Source transport selected by site adapter; extension uses your normal browser')
    a.add_argument('--default-source-url', action='store_true', help='Print initial URL from the ONE source adapter')
    a.add_argument('--archive-needed', action='store_true', help='Reconcile old/new remote GitHub archives, then print READY or NEEDS_ARCHIVE without visiting the source website')
    a.add_argument('--skip-initial-github-check', action='store_true',
                   help='Skip full remote reconciliation of previously archived chapters for this run only; new uploads still verified')
    a.add_argument('--open-reader-update-scope', choices=['full','comic','site'], default='full',
                   help='Full library, current comic only, or shared site routes only')
    a.add_argument('--skip-open-reader-sync', action='store_true',
                   help='Archive only: skip all shared Open Reader discovery, deployment and verification this run')
    a.add_argument('--refresh-extension', action='store_true', help='Regenerate site-scoped extension from site_specific/site_adapter.py')
    a.add_argument("--inspect", action="store_true", help="Only inspect source HTML; no account access or downloads")
    a.add_argument("--github-login", action="store_true")
    a.add_argument("--github-account", action="store_true")
    a.add_argument("--status", action="store_true")
    a.add_argument("--repair-reader-readmes", action="store_true", help="Finish README and final manifest verification for an already published current comic; no deployment or shutdown")
    a.add_argument("--audit-resources", action="store_true", help="Show reader/volume dependencies; does not delete anything")
    a.add_argument("--resume", action="store_true", help="Resume saved archive then publish pending chapters")
    a.add_argument('--retry-server-failures', action='store_true',
                   help='Explicitly revisit chapters with confirmed source-side missing panels')
    a.add_argument("--github-switch-account", action="store_true")
    a.add_argument("--github-logout", action="store_true")
    a.add_argument("--archive", action="store_true")
    a.add_argument("--refresh-chapters", action="store_true", help="Explicitly revisit the original website to discover new episodes; still skip every verified GitHub chapter")
    a.add_argument("--deploy", action="store_true")
    a.add_argument('--refresh-titles', action='store_true',
                   help='Recheck native chapter-list titles even when all images and deployment are complete')
    a.add_argument("--shutdown-on-complete", action="store_true",
                   help="Explicit opt-in: request Windows shutdown with a 60-second cancellation window, ONLY after fully verified publication")
    a.add_argument("--cloudflare-mode", choices=["shared-worker", "pages", "workers"], default="shared-worker",
                   help="Shared open-reader Worker by default; pages/workers are legacy single-series modes")
    a.add_argument("--library-audit", action="store_true",
                   help="Discover and verify all old comics and Cloudflare hosts without publishing")
    a.add_argument("--open-reader-url", type=str,
                   help="Adopt an existing owned open-reader Worker URL after verifying its archived registry")
    a.add_argument("--authorized", action="store_true", help="Confirm permission to download and publicly republish")
    a.add_argument("--max-chapters", type=int, default=1000)
    return a


def main():
    args = build_parser().parse_args()
    if args.repair_reader_readmes and sys.argv[1:] != ["--repair-reader-readmes"]:
        raise SystemExit("--repair-reader-readmes must be used alone")
    # Keep the existing Webtoon archive exactly where older versions stored it.
    # New adapters use their own state without mixing colliding chapter IDs.
    global DATA
    if getattr(ADAPTER, 'STATE_STORAGE_MODE', 'scoped') != 'legacy-root':
        DATA = ROOT / '.archiver_state' / 'sites' / safe_slug(ADAPTER.SOURCE_NAME)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = init_db()
    if args.open_reader_url:
        from .open_reader import load_state, save_state, _public_json, SCHEMA
        url = args.open_reader_url.rstrip('/')
        if open_reader_verify_auth._safe_origin(url) != url:
            raise RuntimeError('Only an actual open-reader.*.workers.dev production URL may be adopted')
        remote = _public_json(url + '/registry.json')
        if (not isinstance(remote, dict) or remote.get('version') != SCHEMA or
                not isinstance(remote.get('comics'), dict)):
            raise RuntimeError('Existing open-reader registry could not be verified. No URL was adopted.')
        existing = load_state(ROOT)
        if existing.get('worker_url', '').rstrip('/') != url:
            # Verification of a different origin cannot be inherited.
            existing.pop('verified_frontend_hash', None)
        existing['worker_url'] = url
        save_state(sys.modules[__name__], existing)
        print('Verified existing open-reader Worker URL:', url)
    if not (args.github_login or args.github_switch_account or args.github_logout):
        _inherit_shared_github_auth(db)
    if args.repair_reader_readmes:
        from .open_reader_focused import repair_verified_readmes
        try:
            repair_verified_readmes(sys.modules[__name__], db)
            from .open_reader import load_state
            from .shared_reader_volume import verify_current_in_shared_reader
            url = load_state(ROOT)['worker_url']
            verify_current_in_shared_reader(sys.modules[__name__], db, url)
            if not all_work_completed(db, mode='shared-worker', worker_url=url):
                raise RuntimeError('Final completion gate did not pass; no publication or archive was changed')
            print('RUN COMPLETE: existing shared reader, chapter manifest and README links verified; no upload or shutdown.', flush=True)
            event('RUN_COMPLETE', chapters=db.execute('SELECT COUNT(*) FROM chapters').fetchone()[0],
                  all_published=True, source_recrawl=False, reader_mode='shared-worker', reader_url=url)
        except (RuntimeError, requests.RequestException, ValueError) as exc:
            print('READER COMPLETION PENDING: ' + str(exc), file=sys.stderr, flush=True)
            raise SystemExit(1) from None
        finally:
            db.close()
        return
    if args.default_source_url:
        print(ADAPTER.DEFAULT_START_URL)
        return
    if args.archive_needed:
        reconcile_github_archive(db)
        print('READY' if archive_is_complete(db) else 'NEEDS_ARCHIVE')
        return
    if args.refresh_extension:
        print('Generated extension:', refresh_extension())
        return
    if args.inspect:
        if args.source_html:
            raw = args.source_html.read_text(encoding="utf-8")
            print(json.dumps(inspect_html(raw, args.source_url), indent=2))
        elif args.source_url:
            with source_browser_context(DATA, args.source_url, headless=False,
                                        browser=args.source_browser,
                                        reader_selectors=ADAPTER.READER_SELECTORS) as ctx:
                try:
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    guard = SourceRequestGuard(DATA, emit=event)
                    visit_source_page(page, args.source_url, guard, visible=True)
                    print(json.dumps(inspect_html(page.content(), page.url), indent=2))
                    # Do not close the sole persistent page before the context.
                    # ctx.close() flushes the dedicated browser profile safely.
                finally:
                    ctx.close()
        else:
            raise SystemExit("--inspect requires --source-url or optional --source-html")
        return
    if args.source_login:
        source_login(db, args.source_html, args.source_url, source_browser=args.source_browser)
        return
    if args.github_account:
        print("Selected GitHub account:", get_option(db, "github_owner", "not selected"))
        return
    if args.github_logout:
        old = get_option(db, "github_owner")
        with db:
            db.execute("DELETE FROM options WHERE key IN ('github_owner','github_credential_namespace')")
        set_option(db, 'github_auth_auto_import_disabled', True)
        event("GITHUB_ACCOUNT_DESELECTED", account=old)
        print("Application GitHub account deselected; unrelated system credentials were not modified.")
        return
    if args.github_switch_account:
        github_login(db, force=True)
        return
    if args.github_login:
        github_login(db, force=True)
        return
    if args.audit_resources:
        audit_resources(db)
        return
    if args.library_audit:
        from .open_reader import publish
        publish(sys.modules[__name__], db, dry_run=True)
        return
    if args.status or not (args.archive or args.deploy or args.resume or args.refresh_titles):
        status(db)
        return
    if args.resume:
        src = get_option(db, "source_html_path")
        saved_url = get_option(db, "source_url")
        if not args.source_url:
            # A new website must require editing ONLY site_adapter.py. Its
            # default start URL is the first-run seed; an existing series
            # still resumes its persisted URL without changing adapters.
            args.source_url = saved_url or getattr(ADAPTER, 'DEFAULT_START_URL', None)
        # URL-first resumes avoid depending on an old saved HTML copy.
        if not args.source_url and not args.source_html and src and Path(src).exists():
            args.source_html = Path(src)
        if not args.source_html and not args.source_url and not get_option(db, "series_slug"):
            raise RuntimeError("No saved comic URL or archive identity. Run with --source-url and --archive")
        args.archive = True
        args.deploy = True
    if args.open_reader_update_scope == 'site':
        if args.cloudflare_mode != 'shared-worker':
            raise SystemExit('Shared-route-only updates require shared-worker mode')
        print('Shared routes only: skipping source crawling, comic metadata reconciliation, and historic image checks.',flush=True)
        args.archive=False
        args.shutdown_on_complete=False
    # Archive-only opt-out is per run. Do not call the shared reader publisher:
    # it scans old GitHub repos, validates all archived hosts, checks Worker assets,
    # and synchronizes READMEs. Newly uploaded chapter integrity checks stay on.
    if args.skip_open_reader_sync:
        if args.cloudflare_mode != 'shared-worker':
            raise SystemExit('--skip-open-reader-sync is only for the shared-worker reader mode')
        if args.deploy:
            print('Shared Open Reader publication + remote verification skipped for THIS run. '
                  'Previously published websites remain unchanged; new chapters await sync.', flush=True)
            args.deploy = False
        if args.shutdown_on_complete:
            print('Automatic shutdown disabled: this run will not verify reader publication.', flush=True)
            args.shutdown_on_complete = False
    deployment_url = None
    try:
        if args.archive:
            desired_headless = True if args.source_headless else False if args.source_visible else None
            archive_run(db, args.source_html, args.source_url, args.max_chapters, args.authorized,
                        source_headless=desired_headless, source_browser=args.source_browser,
                        force_rediscover=args.refresh_chapters,
                        skip_initial_github_check=args.skip_initial_github_check,
                        retry_server_failures=args.retry_server_failures)
        # Metadata is a separate completion axis from image archiving. The
        # source adapter may enrich chapter numbers with full native titles.
        # Check ALL archived chapters (including previously published ones),
        # just once per adapter revision; no image crawl, lazy scrolling or
        # repeated upload. Failed source title extraction is always optional.
        if (args.archive or args.deploy or args.refresh_titles) and args.open_reader_update_scope != 'site':
            from .title_reconcile import reconcile_native_titles
            source_url = (args.source_url or get_option(db, 'source_url') or
                          getattr(ADAPTER, 'DEFAULT_START_URL', ''))
            existing_html = None
            if args.source_html and args.source_html.exists():
                existing_html = args.source_html.read_text(encoding='utf-8')
            reconcile_native_titles(db, ADAPTER, get_option=get_option,
                                    set_option=set_option,
                                    event=event, isolated_git_environment=isolated_git_environment,
                                    paced_push=paced_push, source_url=source_url,
                                    source_html=existing_html, force=args.refresh_titles)
        if args.deploy:
            if not args.authorized:
                raise RuntimeError("Public deployment requires explicit --authorized rights confirmation")
            deployment_url = deploy_run(db, mode=args.cloudflare_mode) if (
                args.open_reader_update_scope == 'full' or not args.skip_initial_github_check
            ) else deploy_run(db, mode=args.cloudflare_mode, update_scope=args.open_reader_update_scope)
    except Exception as ex:
        original_error = str(ex)
        if ("Target page, context or browser has been closed" in original_error or
                "BrowserContext.new_page: Target page" in original_error):
            explanation = (
                "The comic source browser closed unexpectedly. Keep its visible Firefox/Chromium "
                "window open while archiving. The dedicated persistent browser profile and "
                "GitHub/Cloudflare sessions are preserved; rerun the setup or --resume. "
                f"Original Playwright error: {original_error}"
            )
            event("SOURCE_BROWSER_UNEXPECTEDLY_CLOSED", reason=explanation)
            raise RuntimeError(explanation) from ex
        event("RUN_PAUSED", reason=original_error)
        raise
    else:
        completed = bool(args.deploy and args.open_reader_update_scope != 'site' and all_work_completed(
            db, mode=args.cloudflare_mode, worker_url=deployment_url))
        if completed:
            print('RUN COMPLETE: shared reader and all known chapters are published and verified. '
                  'The program is exiting.', flush=True)
            event('RUN_COMPLETE', chapters=db.execute('SELECT COUNT(*) FROM chapters').fetchone()[0],
                  all_published=True, source_recrawl=False, reader_mode=args.cloudflare_mode,
                  reader_url=deployment_url)
            if args.shutdown_on_complete:
                request_windows_shutdown_after_completion(
                    db, mode=args.cloudflare_mode, worker_url=deployment_url)
        elif args.shutdown_on_complete:
            print('Shutdown suppressed: publication incomplete or current comic absent from '
                  'verified shared library; no shutdown was requested.', flush=True)
    finally:
        status(db)


if __name__ == "__main__":
    main()
