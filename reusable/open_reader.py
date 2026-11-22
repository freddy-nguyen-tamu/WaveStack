"""Account-wide, append-only library of archived comics on ONE Cloudflare Worker.

No selector, site URL, chapter-title parser, or per-website hook lives here.
An adapter switch never resets the registry. Discovery only accepts application-
owned local SQLite state, confirmed reader manifests from owned GitHub repos,
or an exact existing Cloudflare reader project. No destructive remote operations.
"""
from __future__ import annotations

import base64
from contextlib import closing
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests

from . import github_streaming

WORKER_NAME = 'open-reader'
REGISTRY_DESCRIPTION = 'Universal Comic Archiver shared open-reader registry (metadata only)'
SCHEMA = 2
SLUG_RE = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$')
VOLUME_RE = re.compile(r'^([a-z0-9-]+)-vol-(\d{3})$')
READER_RE = re.compile(r'^([a-z0-9-]+)-reader$')


def canonical(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalize_chapters(chapters):
    """Fail closed on ill-formed manifests; never publish unknown URL schemes."""
    if not isinstance(chapters, list) or not chapters or len(chapters) > 2000:
        raise ValueError('Missing or invalid chapter list')
    result, ids = [], set()
    for chapter in chapters:
        if not isinstance(chapter, dict):
            raise ValueError('Invalid chapter metadata')
        ident = str(chapter.get('id') or chapter.get('number') or '').strip()
        if not ident or len(ident) > 160 or ident in ids:
            raise ValueError('Duplicate or invalid chapter ID')
        ids.add(ident)
        imgs = chapter.get('images')
        if not isinstance(imgs, list) or not imgs or len(imgs) > 2000:
            raise ValueError('Chapter has no image manifest')
        images = []
        for item in imgs:
            if not isinstance(item, dict):
                raise ValueError('Image entry is not an object')
            url = str(item.get('url') or '')
            parts = urlsplit(url)
            github = item.get('github')
            if github:
                if (not isinstance(github, dict) or
                        not github_streaming.REPO.fullmatch(str(github.get('repo',''))) or
                        not github_streaming.PATH.fullmatch(str(github.get('path',''))) or
                        not re.fullmatch(r'/api/github-image/[a-z0-9-]+/[A-Za-z0-9_.-]+/[1-9][0-9]*\?v=[a-f0-9]{64}',url)):
                    raise ValueError('Invalid indexed GitHub image source')
            elif (parts.scheme != 'https' or not parts.netloc or parts.username or
                    parts.password or parts.fragment or not parts.hostname or
                    not (parts.hostname.endswith('.pages.dev') or
                         parts.hostname.endswith('.workers.dev'))):
                raise ValueError('Archived image must use a trusted HTTPS Cloudflare asset host')
            checksum = str(item.get('sha256') or '').lower()
            if not re.fullmatch(r'[a-f0-9]{64}', checksum):
                raise ValueError('Archived image lacks SHA-256')
            record = {'url': url, 'width': int(item.get('width') or 1),
                      'height': int(item.get('height') or 1), 'sha256': checksum}
            if github:
                record['github'] = {'repo':github['repo'],'path':github['path']}
            images.append(record)
        title = str(chapter.get('title') or chapter.get('label') or f'Chapter {ident}').strip()
        label = str(chapter.get('label') or title).strip()
        result.append({'id': ident, 'number': str(chapter.get('number') or ident),
                       'title': title[:320], 'label': label[:320], 'images': images})
    return result


def validate_comic(slug, title, chapters, *, sources=None):
    slug = str(slug).strip().lower()
    if not SLUG_RE.fullmatch(slug):
        raise ValueError(f'Invalid comic slug: {slug!r}')
    normalized = normalize_chapters(chapters)
    title = str(title or slug.replace('-', ' ').title()).strip()[:200]
    return {'slug': slug, 'title': title, 'chapters': normalized,
            'legacy_urls': sorted({u.rstrip('/') for u in (sources or [])
                                   if isinstance(u, str) and u.startswith('https://')})}


def _is_placeholder(label, chapter_id):
    value = str(label or '').strip().casefold()
    return value in {str(chapter_id).casefold(), 'chapter ' + str(chapter_id).casefold(),
                     'ep. ' + str(chapter_id).casefold(), 'ep ' + str(chapter_id).casefold()}


def merge_comics(a, b):
    """Union chapters, preserve images, prefer real subtitles over generic labels."""
    if a['slug'] != b['slug']:
        raise ValueError('Cannot merge different comic slugs')
    by_id = {str(ch['id']): dict(ch) for ch in a['chapters']}
    for chapter in b['chapters']:
        ident = str(chapter['id'])
        previous = by_id.get(ident)
        if previous is None:
            by_id[ident] = dict(chapter)
            continue
        # If the image set has changed, prefer the independently validated new
        # archive. Only call this with verified candidates.
        merged = dict(github_streaming.preferred_chapter(chapter, previous))
        for key in ('title', 'label'):
            old_title, new_title = previous.get(key, ''), chapter.get(key, '')
            if _is_placeholder(new_title, ident) and not _is_placeholder(old_title, ident):
                merged[key] = old_title
            elif not _is_placeholder(new_title, ident) and _is_placeholder(old_title, ident):
                merged[key] = new_title
            elif len(old_title) > len(new_title) and old_title.startswith(new_title):
                merged[key] = old_title
        by_id[ident] = merged
    # Preserve order from the longest catalog, then append unknown chapter IDs.
    order = list(dict.fromkeys([str(ch['id']) for ch in
                                (b['chapters'] if len(b['chapters']) >= len(a['chapters']) else a['chapters'])] +
                               [str(ch['id']) for ch in a['chapters'] + b['chapters']]))
    return validate_comic(a['slug'], b.get('title') or a['title'],
                          [by_id[ident] for ident in order],
                          sources=a.get('legacy_urls', []) + b.get('legacy_urls', []))


def combine(registry, incoming):
    comics = registry.setdefault('comics', {})
    for slug, comic in incoming.items():
        valid = validate_comic(slug, comic.get('title'), comic['chapters'],
                               sources=comic.get('legacy_urls', []))
        comics[slug] = merge_comics(comics[slug], valid) if slug in comics else valid
    return registry


def state_path(root):
    return Path(root) / '.archiver_state' / 'open_reader_registry.json'


def load_state(root):
    path = state_path(root)
    if not path.is_file():
        return {'version': SCHEMA, 'worker_url': '', 'comics': {}}
    raw = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(raw, dict) or not isinstance(raw.get('comics'), dict):
        raise RuntimeError('Existing open-reader registry is invalid; refusing to overwrite')
    result = {'version': SCHEMA, 'worker_url': str(raw.get('worker_url') or ''), 'comics': {}}
    return combine(result, raw['comics'])


def save_state(engine, registry):
    engine.atomic_json(state_path(engine.ROOT), registry)


def list_local_state_dbs(root):
    base = Path(root) / '.archiver_state'
    output = []
    if (base / 'state.sqlite').is_file():
        output.append(base / 'state.sqlite')
    sites = base / 'sites'
    if sites.is_dir():
        output.extend(sorted(p for p in sites.glob('*/state.sqlite') if p.is_file()))
    return output


def local_candidates(engine):
    comics = {}
    for path in list_local_state_dbs(engine.ROOT):
        try:
            with closing(sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True)) as conn:
                conn.row_factory = sqlite3.Row
                opts = {}
                for rec in conn.execute('SELECT key,value FROM options WHERE key IN (\'series_slug\',\'series_title\')'):
                    opts[rec['key']] = json.loads(rec['value'])
                slug = opts.get('series_slug')
                if not slug or not SLUG_RE.fullmatch(str(slug)):
                    continue
                rows = conn.execute("SELECT chapter_id, label, pages_json, repository FROM chapters "
                                    "WHERE status IN ('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED') "
                                    "AND repository IS NOT NULL ORDER BY ordinal").fetchall()
                if not rows:
                    continue
                deployed = {r['project']: r['production_url'] for r in conn.execute(
                    'SELECT project,production_url FROM deployments WHERE production_url IS NOT NULL')}
                chapters, complete = [], True
                streaming = github_streaming.load_mode(engine.ROOT)
                for row in rows:
                    image_repo = row['repository']
                    host = deployed.get(image_repo[:58])
                    if not host and not streaming:
                        complete = False
                        break
                    manifest = json.loads(row['pages_json'] or '{}')
                    files, images = manifest.get('remote_files'), manifest.get('images')
                    if not files or not images or len(files) != len(images):
                        complete = False
                        break
                    items = []
                    for index, (file, image) in enumerate(zip(files, images),1):
                        digest = image.get('sha256')
                        if streaming:
                            items.append({'url': github_streaming.route(slug,row['chapter_id'],index,digest),
                                          'github':{'repo':image_repo,'path':file},
                                          'width':image.get('width'), 'height':image.get('height'),
                                          'sha256':digest})
                        else:
                            items.append({'url': host.rstrip('/') + '/' + file,
                                          'width': image.get('width'), 'height': image.get('height'),
                                          'sha256': digest})
                    chapters.append({'id': row['chapter_id'], 'label': row['label'],
                                     'title': manifest.get('chapter_title') or row['label'],
                                     'number': row['chapter_id'], 'images': items})
                if not complete:
                    engine.event('OPEN_READER_LOCAL_INCOMPLETE', db=str(path), series=slug,
                                 reason='missing volume host or invalid manifest')
                    continue
                old_reader = deployed.get((slug + '-reader')[:58])
                comic = validate_comic(slug, opts.get('series_title'), chapters,
                                       sources=[old_reader] if old_reader else [])
                comics[slug] = merge_comics(comics[slug], comic) if slug in comics else comic
                print(f'open-reader: recovered {slug} from local SQLite ({len(chapters)} chapters)', flush=True)
        except (sqlite3.Error, ValueError, TypeError, KeyError) as exc:
            engine.event('OPEN_READER_LOCAL_SKIPPED', db=str(path), error=str(exc)[:200])
    return comics


def _manifest_to_comic(manifest, slug, source_url):
    if not isinstance(manifest, dict) or not isinstance(manifest.get('chapters'), list):
        raise ValueError('Not an archiver reader manifest')
    return validate_comic(slug, manifest.get('title'), manifest['chapters'], sources=[source_url])


def _public_json(url, *, timeout=25):
    p = urlsplit(url)
    if (p.scheme != 'https' or not p.hostname or
            not (p.hostname.endswith('.pages.dev') or p.hostname.endswith('.workers.dev'))):
        raise ValueError('Only trusted Cloudflare project URLs can be queried')
    resp = requests.get(url, timeout=timeout, headers={'Cache-Control': 'no-cache'})
    if resp.status_code != 200:
        raise RuntimeError(f'Cloudflare manifest HTTP {resp.status_code} for {url}')
    return resp.json()


def _repo_contents(engine, owner, token, repo, filepath, *, ref="main"):
    url = (f'{engine.GITHUB_API}/repos/{owner}/{repo}/contents/' +
           '/'.join(quote(part, safe='') for part in filepath.split('/')) + '?ref=' + quote(ref, safe=''))
    response = engine.github_http('GET', url, token)
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise RuntimeError(f'Cannot inspect existing GitHub {repo}/{filepath}: HTTP {response.status_code}')
    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError(f'GitHub returned unexpected contents for {repo}/{filepath}')
    if body.get('content'):
        return base64.b64decode(body['content'], validate=False)
    # GitHub /contents excludes file contents for larger (>1 MiB) files.
    blob = body.get('sha')
    if not blob:
        raise RuntimeError(f'GitHub did not supply file content or blob SHA: {repo}/{filepath}')
    res = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{repo}/git/blobs/{blob}', token)
    if res.status_code != 200:
        raise RuntimeError(f'Cannot fetch GitHub metadata blob {repo}/{filepath}: HTTP {res.status_code}')
    return base64.b64decode(res.json()['content'], validate=False)


def _owned_repos(engine, owner, token):
    """Enumerate authenticated OWNER repositories; never sweep other accounts."""
    names = set()
    for page in range(1, 21):
        r = engine.github_http('GET', f'{engine.GITHUB_API}/user/repos?affiliation=owner&per_page=100&page={page}', token)
        if r.status_code != 200:
            raise RuntimeError(f'GitHub repository inventory unavailable: HTTP {r.status_code}; refusing incomplete registry deploy')
        batch = r.json()
        if not isinstance(batch, list):
            raise RuntimeError('Unexpected GitHub repository inventory response')
        for record in batch:
            if (isinstance(record, dict) and isinstance(record.get('owner'), dict) and
                    str(record['owner'].get('login', '')).lower() == owner.lower()):
                if record.get('private') is True:
                    names.add(record.get('name', ''))
        if len(batch) < 100:
            break
    else:
        raise RuntimeError('GitHub repository inventory exceeded 2000 items; refusing incomplete scan')
    return names


def _volume_manifest_candidates(engine, owner, token, repos, page_projects, existing):
    """Recover old series that lack reader manifests/local SQLite from Git metadata.

    Uses only chapter manifest JSON, never image blobs or the original source.
    Only visits volume repos matching an already created image Pages project.
    """
    output = {}
    for repo in sorted(repos):
        matched = VOLUME_RE.fullmatch(repo)
        if not matched:
            continue
        slug = matched.group(1)
        if slug in existing:  # current local DB, GitHub reader or legacy Pages is richer
            continue
        host = page_projects.get(repo)
        streaming = github_streaming.load_mode(getattr(engine, 'ROOT', Path(__file__).resolve().parent.parent))
        if not host and not streaming:
            continue
        tree = engine.github_http('GET',
            f'{engine.GITHUB_API}/repos/{owner}/{repo}/git/trees/main?recursive=1', token)
        if tree.status_code != 200:
            raise RuntimeError(f'Cannot inspect old archive {repo} tree: HTTP {tree.status_code}')
        meta = [x['path'] for x in tree.json().get('tree', [])
                if re.fullmatch(r'chapters/[^/]+/manifest\.json', x.get('path', ''))]
        if not meta:
            continue
        chapters = []
        for filepath in sorted(meta):
            blob = _repo_contents(engine, owner, token, repo, filepath)
            manifest = json.loads(blob)
            pages = manifest.get('images', [])
            paths = manifest.get('remote_files', [])
            if len(pages) != len(paths) or not pages:
                raise RuntimeError(f'Incomplete chapter metadata in {repo}/{filepath}')
            chapter_id = str(manifest.get('chapter_id') or filepath.split('/')[1])
            chapters.append({'id': chapter_id,
                             'number': chapter_id,
                             'title': manifest.get('chapter_title') or manifest.get('label') or f'Chapter {chapter_id}',
                             'label': manifest.get('label') or f'Chapter {chapter_id}',
                             'images': [({'url': github_streaming.route(slug,chapter_id,i,im['sha256']),
                                           'github':{'repo':repo,'path':p},
                                           'sha256':im['sha256'],'width':im.get('width'),'height':im.get('height')}
                                          if streaming else
                                          {'url': host.rstrip('/') + '/' + p,
                                           'sha256':im['sha256'],'width':im.get('width'),
                                           'height':im.get('height')})
                                         for i,(p,im) in enumerate(zip(paths,pages),1)]})
        # Do not mistake lexicographic filename order for episode order.
        chapters.sort(key=lambda c: (0, int(c['id'])) if c['id'].isdigit() else (1, c['id']))
        comic = validate_comic(slug, slug.replace('-', ' ').title(), chapters)
        output[slug] = merge_comics(output[slug], comic) if slug in output else comic
        print(f'open-reader: recovered {slug} from {repo} ({len(chapters)} remote manifests)', flush=True)
    return output


def remote_candidates(engine, db, existing):
    owner, token = engine.credential_for_selected(db)
    names = _owned_repos(engine, owner, token)
    pages = {}
    for project in engine.list_pages_projects():
        name = project.get('name', '')
        if not (READER_RE.fullmatch(name) or VOLUME_RE.fullmatch(name)):
            continue
        subdomain = project.get('subdomain', '')
        if subdomain and str(subdomain).endswith('.pages.dev'):
            pages[name] = 'https://' + str(subdomain).split(',')[0].strip().removeprefix('https://')
    found = {}
    # GitHub reader repo is a durable copy of the old reader's manifest.
    for repo in sorted(names):
        m = READER_RE.fullmatch(repo)
        if not m or repo == WORKER_NAME:
            continue
        slug = m.group(1)
        for filepath in ('website/manifest.json', 'manifest.json'):
            payload = _repo_contents(engine, owner, token, repo, filepath)
            if payload is None:
                continue
            try:
                comic = _manifest_to_comic(json.loads(payload), slug, pages.get(repo, ''))
            except (ValueError, KeyError, TypeError) as exc:
                engine.event('OPEN_READER_GITHUB_MANIFEST_SKIPPED', repository=repo,
                             reason=str(exc)[:180])
                continue
            found[slug] = merge_comics(found[slug], comic) if slug in found else comic
            break
    # Old publicly published Pages reader manifests can carry updates not yet
    # saved to their GitHub source repository.
    for project, url in sorted(pages.items()):
        match = READER_RE.fullmatch(project)
        if not match and not VOLUME_RE.fullmatch(project):
            continue
        slug = (match or VOLUME_RE.fullmatch(project)).group(1)
        try:
            manifest = _public_json(url.rstrip('/') + '/manifest.json')
            comic = _manifest_to_comic(manifest, slug, url)
        except (requests.RequestException, RuntimeError, ValueError, TypeError, KeyError):
            continue  # image-only Pages volumes legitimately have no reader manifest
        found[slug] = merge_comics(found[slug], comic) if slug in found else comic
    recovered = _volume_manifest_candidates(engine, owner, token, names, pages,
                                            dict.fromkeys([*existing, *found]))
    combine({'comics': found}, recovered)
    print(f'open-reader: scanned {len(names)} private owned GitHub repos and '
          f'{len(pages)} legacy Pages projects; found {len(found)} comic(s)', flush=True)
    return found, names


def _validate_live_assets(comic, engine):
    """Recheck every known image-volume host, with visible heartbeat and retries.

    Checks first+last SHA-256 per host. Never revisits the original comic site
    or downloads original source images; these are published-host integrity checks.
    """
    by_host = {}
    for chapter in comic['chapters']:
        for image in chapter['images']:
            host = urlsplit(image['url']).hostname
            by_host.setdefault(host, []).append(image)
    for host, images in sorted(by_host.items()):
        samples = images[:1] + images[-1:] if len(images) > 1 else images
        for image in samples:
            engine.verify_cloudflare_asset(image['url'], expected_sha256=image['sha256'],
                                          attempts=3)



def _load_live_worker(registry):
    worker_url = registry.get('worker_url', '').rstrip('/')
    if not worker_url:
        return None
    try:
        live = _public_json(worker_url + '/registry.json')
    except (RuntimeError, ValueError, requests.RequestException) as exc:
        raise RuntimeError('Previous open-reader deployment cannot be inspected; refusing '
                           'to overwrite a potentially larger live library: ' + str(exc)) from exc
    if not isinstance(live, dict) or not isinstance(live.get('comics'), dict):
        raise RuntimeError('Previous open-reader registry is malformed; refusing overwrite')
    # An older published Worker must not revert newer chapter metadata found
    # in verified local/GitHub/Pages sources. Use live as the baseline and
    # reapply current verified candidates with higher precedence.
    newer = registry['comics']
    registry['comics'] = {}
    combine(registry, live['comics'])
    combine(registry, newer)
    return live


def _reader_hash(root):
    files = {p.name: sha(p.read_bytes()) for p in sorted((root / 'reader').iterdir())
             if p.is_file()}
    files['open-reader-homepage'] = sha(_index_html().encode('utf-8'))
    for relative in ('reusable/open_reader_homepage_addon.py',
                     'reusable/worker_addon/panel_replacement_worker.mjs',
                     'reusable/github_streaming.py', 'reusable/github_upload_bell.js',
                     'reusable/comic_landing.py', 'reusable/comic_landing.css',
                     'reusable/comic_landing.js', 'reusable/reader_progress.js',
                     'reusable/reader_chapter_enhancement.css',
                     'reusable/reader_chapter_enhancement.js',
                     'reusable/gold_favicon.py'):
        file = Path(root) / relative
        if not file.is_file():
            # Legacy and isolated non-streaming test projects do not have the
            # optional GitHub transport. Refuse only in configured mode.
            if relative in ('reusable/github_streaming.py', 'reusable/github_upload_bell.js') and not github_streaming.load_mode(root):
                continue
            raise RuntimeError('Missing shared-reader integration source: ' + relative)
        files[relative] = sha(file.read_bytes())
    return sha(canonical(files))


def _registry_payload(registry, frontend_hash):
    return {'version': SCHEMA, 'frontend_hash': frontend_hash,
            'comics': {k: registry['comics'][k] for k in sorted(registry['comics'])}}


def _index_html():
    return '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>open-reader</title><style>
/* open-reader homepage only | Amazon-like editorial storefront treatment
 * Keeps existing markup, library search, comic links and notifications intact.
 * Never loaded by /comics/<slug>/ reader pages.
 */
:root {
  color-scheme: light;
  font-family: Arial, Helvetica, system-ui, sans-serif;
  --or-ink: #0f1111;
  --or-muted: #565959;
  --or-header: #131921;
  --or-navigation: #232f3e;
  --or-accent: #ff9900;
  --or-accent-soft: #febd69;
  --or-link: #007185;
  --or-paper: #fff;
  --or-canvas: #eaeded;
  --or-gutter: clamp(16px, 3.2vw, 62px);
  background: var(--or-canvas);
  color: var(--or-ink);
}
*, *::before, *::after { box-sizing: border-box; }
html { min-width: 0; }
body {
  width: 100%;
  min-width: 0;
  max-width: none;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(184px, 23%) minmax(0, 1fr);
  grid-template-areas: "brand search" "navigation navigation" "catalog catalog";
  grid-template-rows: 79px 45px minmax(0, 1fr);
  align-content: start;
  align-items: start;
  background: linear-gradient(to bottom,
    var(--or-header) 0, var(--or-header) 79px,
    var(--or-navigation) 79px, var(--or-navigation) 124px,
    var(--or-canvas) 124px, var(--or-canvas) 100%);
  overflow-x: clip;
}
h1 {
  grid-area: brand;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 79px;
  margin: 0;
  padding: 0 12px 0 var(--or-gutter);
  color: #fff;
  font-size: clamp(21px, 1.8vw, 30px);
  font-weight: 800;
  letter-spacing: -.045em;
  line-height: 1.1;
  white-space: nowrap;
}
h1::before {
  content: "";
  display: inline-block;
  flex: 0 0 auto;
  width: 20px;
  height: 24px;
  margin-right: 11px;
  border: 2px solid var(--or-accent-soft);
  border-left-width: 7px;
  border-radius: 2px 4px 4px 2px;
  transform: skewY(-4deg);
  box-shadow: 3px 3px 0 rgba(255,153,0,.2);
}
#search {
  grid-area: search;
  align-self: center;
  justify-self: start;
  display: block;
  width: min(860px, calc(100% - 86px));
  min-width: 0;
  max-width: none;
  height: 43px;
  margin: 0;
  padding: 10px 48px 10px 15px;
  border: 2px solid var(--or-accent-soft);
  border-radius: 5px;
  outline: 0;
  background-color: #fff;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' fill='none' stroke='%23565959' stroke-width='2.3' stroke-linecap='round'%3E%3Ccircle cx='9.5' cy='9.5' r='6.3'/%3E%3Cpath d='m14.5 14.5 5.2 5.2'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 15px center;
  color: var(--or-ink);
  font: 400 15px/1.35 Arial, Helvetica, system-ui, sans-serif;
  box-shadow: 0 1px 3px rgba(0,0,0,.18);
  transition: border-color .17s ease, box-shadow .17s ease;
  -webkit-appearance: none;
  appearance: none;
}
#search::placeholder { color: #626a70; opacity: 1; }
#search:hover { border-color: #ff9900; }
#search:focus-visible, #search:focus {
  border-color: var(--or-accent);
  box-shadow: 0 0 0 3px rgba(255,153,0,.35);
}
.subtitle {
  grid-area: navigation;
  display: flex;
  align-items: center;
  min-width: 0;
  width: 100%;
  height: 45px;
  margin: 0;
  padding: 0 var(--or-gutter);
  border-top: 1px solid rgba(255,255,255,.08);
  color: #f2f5f7;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: .015em;
}
.subtitle::before {
  content: "";
  display: inline-block;
  width: 3px;
  height: 15px;
  margin-right: 11px;
  border-radius: 2px;
  background: var(--or-accent);
}
#grid {
  grid-area: catalog;
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: none;
  margin: 0;
  padding: clamp(26px, 3.4vw, 55px) var(--or-gutter) clamp(52px, 7vw, 100px);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 270px), 1fr));
  gap: clamp(15px, 1.5vw, 24px);
  align-content: start;
  align-items: stretch;
}
#grid::before {
  content: "Browse your collection";
  grid-column: 1 / -1;
  display: block;
  min-width: 0;
  margin: 0 0 6px;
  padding: 0 0 clamp(15px, 1.8vw, 22px);
  border-bottom: 1px solid #cbd1d3;
  color: var(--or-ink);
  font-size: clamp(20px, 2vw, 27px);
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -.02em;
}
.comic {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 192px;
  margin: 0;
  padding: 24px 21px 20px;
  overflow: hidden;
  border: 1px solid #d5d9d9;
  border-radius: 7px;
  background: var(--or-paper);
  color: var(--or-ink);
  box-shadow: 0 1px 3px rgba(15,17,17,.055);
  text-decoration: none;
  transition: border-color .17s ease, transform .17s ease, box-shadow .17s ease;
}
.comic::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 5px;
  background: linear-gradient(90deg, #ff9900 0%, #febd69 45%, #d9e4e8 100%);
}
.comic b {
  display: block;
  margin: 8px 0 21px;
  color: #0f1111;
  font-size: clamp(17px, 1.34vw, 21px);
  font-weight: 700;
  letter-spacing: -.018em;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.comic small {
  display: inline-block;
  align-self: flex-start;
  margin: 0 0 18px;
  padding: 6px 9px;
  border: 1px solid #e7eaea;
  border-radius: 4px;
  background: #f0f2f2;
  color: var(--or-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.comic::after {
  content: "Open comic  ›";
  display: block;
  margin-top: auto;
  padding-top: 2px;
  color: var(--or-link);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
}
.comic:hover, .comic:focus-visible {
  border-color: #b7c4c7;
  box-shadow: 0 5px 18px rgba(15,17,17,.13);
  transform: translateY(-2px);
}
.comic:hover::after, .comic:focus-visible::after {
  color: #c45500;
  text-decoration: underline;
}
.comic:focus-visible { outline: 3px solid var(--or-accent); outline-offset: 3px; }
.empty {
  grid-column: 1 / -1;
  width: 100%;
  margin: 0;
  padding: 23px 25px;
  border: 1px solid #d5d9d9;
  border-radius: 6px;
  background: var(--or-paper);
  color: var(--or-muted);
  font-size: 14px;
  line-height: 1.5;
}
/* Homepage-only positioning. Reader route's bell and drawer CSS are unchanged. */
html body #reader-issues-widget {
  top: max(17px, env(safe-area-inset-top));
  right: max(var(--or-gutter), env(safe-area-inset-right));
}
html body #reader-issues-widget #ri-button {
  width: 43px;
  height: 43px;
  border: 1px solid rgba(255,255,255,.25);
  border-radius: 5px;
  background: #273545;
  box-shadow: none;
  backdrop-filter: none;
}
html body #reader-issues-widget #ri-button:hover,
html body #reader-issues-widget #ri-button:focus-visible {
  border-color: var(--or-accent-soft);
  background: #36495d;
}
html body #reader-issues-widget #ri-popover { border-radius: 7px; }
@media (max-width: 760px) {
  body { grid-template-columns: minmax(164px, 30%) minmax(0, 1fr); }
  h1 { font-size: clamp(20px, 2.9vw, 23px); }
  #search { width: calc(100% - 76px); }
  #grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 226px), 1fr)); }
}
@media (max-width: 560px) {
  body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "brand" "search" "navigation" "catalog";
    grid-template-rows: 65px 64px 42px minmax(0, 1fr);
    background: linear-gradient(to bottom,
      var(--or-header) 0, var(--or-header) 129px,
      var(--or-navigation) 129px, var(--or-navigation) 171px,
      var(--or-canvas) 171px, var(--or-canvas) 100%);
  }
  h1 { height: 65px; font-size: 24px; }
  #search {
    justify-self: stretch;
    width: auto;
    max-width: none;
    height: 43px;
    margin: 0 var(--or-gutter);
  }
  .subtitle { height: 42px; }
  #grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 235px), 1fr)); }
  html body #reader-issues-widget { top: max(11px, env(safe-area-inset-top)); }
}
@media (max-width: 350px) {
  h1 { font-size: 21px; }
  h1::before { margin-right: 8px; width: 17px; height: 22px; }
  .comic { padding: 20px 17px 17px; }
}
@media (prefers-reduced-motion: reduce) {
  #search, .comic { transition: none; }
  .comic:hover, .comic:focus-visible { transform: none; }
}
</style></head><body><h1>open-reader</h1><p class="subtitle">Your comic library</p><input id="search" type="search" placeholder="Find a comic" aria-label="Find a comic"><main id="grid" aria-live="polite"></main><script type="module">
const grid=document.querySelector('#grid');let comics=[];
function render(){const q=document.querySelector('#search').value.trim().toLowerCase();grid.replaceChildren();for(const comic of comics.filter(c=>(c.title+' '+c.slug).toLowerCase().includes(q))){const a=document.createElement('a');a.className='comic';a.href=comic.route;const t=document.createElement('b');t.textContent=comic.title;const meta=document.createElement('small');meta.textContent=comic.chapters+' chapters';a.append(t,meta);grid.append(a);}if(!grid.childElementCount){const p=document.createElement('p');p.className='empty';p.textContent='No matching comics';grid.append(p);}}
document.querySelector('#search').addEventListener('input',render);fetch('/library.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Library unavailable');return r.json()}).then(x=>{comics=x.comics||[];render()}).catch(e=>{grid.textContent='Could not load the library. Please refresh.';console.error(e)});
</script></body></html>'''


def stage_worker_assets(root, registry, stage):
    stage = Path(stage)
    stage.mkdir(parents=True, exist_ok=True)
    payload = _registry_payload(registry, _reader_hash(root))
    (stage / 'index.html').write_bytes(_index_html().encode('utf-8'))
    (stage / 'registry.json').write_bytes(canonical(payload))
    summary = {'comics': [{'slug': slug, 'title': comic['title'],
                           'chapters': len(comic['chapters']),
                           'route': f'/comics/{slug}/overview/'}
                          for slug, comic in sorted(registry['comics'].items())]}
    (stage / 'library.json').write_bytes(canonical(summary))
    from .comic_landing import HTML as COMIC_LANDING_HTML
    for source_name, staged_name in (
        ('comic_landing.css', 'comic-landing.css'),
        ('comic_landing.js', 'comic-landing.js'),
        ('reader_progress.js', 'reader-progress.js'),
        ('reader_chapter_enhancement.css', 'reader-chapter-enhancement.css'),
    ):
        shutil.copy2(Path(root) / 'reusable' / source_name, stage / staged_name)
    for slug, comic in sorted(registry['comics'].items()):
        dest = stage / 'comics' / slug
        dest.mkdir(parents=True, exist_ok=True)
        for file in (Path(root) / 'reader').iterdir():
            if file.is_file():
                shutil.copy2(file, dest / file.name)
        (dest / 'manifest.json').write_bytes(canonical({'title': comic['title'],
                                                        'chapters': comic['chapters']}))
        overview = dest / 'overview'
        overview.mkdir(exist_ok=True)
        (overview / 'index.html').write_text(COMIC_LANDING_HTML, encoding='utf-8')
        # Add local-device resume tracking, a seamless page surface and new
        # input shortcuts to STAGED assets only. The original reader/app.js,
        # style.css, and all existing controls remain unmodified on disk.
        reader_html = dest / 'index.html'
        original = reader_html.read_text(encoding='utf-8')
        insert = ('<link rel="stylesheet" href="/reader-chapter-enhancement.css">'
                  '<script src="/reader-progress.js"></script>')
        if '</head>' not in original:
            raise RuntimeError('Staged reader has no head element')
        reader_html.write_text(original.replace('</head>', insert + '</head>', 1), encoding='utf-8')
        app = dest / 'app.js'
        native_app = app.read_text(encoding='utf-8')
        # Prevent cross-comic progress leakage from the old shared settings key.
        needle = "let desired=params.get('chapter')||settings.lastChapter||manifest.chapters[0].id;"
        updated = "let desired=params.get('chapter')||window.OpenReaderLocalProgress?.chapter||manifest.chapters[0].id;"
        if native_app.count(needle) != 1:
            raise RuntimeError('Reader chapter selection has changed; refusing an unsafe progress patch')
        native_app = native_app.replace(needle, updated, 1)
        nav_addon = (Path(root) / 'reusable' / 'reader_chapter_enhancement.js').read_text(encoding='utf-8')
        if 'open-reader:skip-entry-flip' in native_app:
            raise RuntimeError('Existing reader app contains the supplemental navigation logic; refusing duplicates')
        app.write_text(native_app + '\n' + nav_addon + '\n', encoding='utf-8')
    if github_streaming.load_mode(root):
        (stage / 'upload-catalog.json').write_bytes(canonical(github_streaming.catalog(registry)))
        script = Path(root) / 'reusable' / 'github_upload_bell.js'
        if not script.is_file():
            raise RuntimeError('Missing GitHub bell integration')
        shutil.copy2(script, stage / 'github-upload-bell.js')
        home = stage / 'index.html'
        html = home.read_text(encoding='utf-8')
        html = html.replace('</head>', '<script defer src="/github-upload-bell.js"></script></head>', 1)
        home.write_text(html, encoding='utf-8')
    # The staging hook adds favicons to every route, but the issue bell to the homepage only.
    # Never mutate the local reader/ files or any downloaded chapter archive.
    from reusable.open_reader_homepage_addon import augment_assets
    stats = augment_assets(stage, root)
    print(f'open-reader: golden favicon on {stats["html_documents"]} routes, homepage-only notifications; '
          f'{stats["affected_chapters"]} affected chapters ({stats["issues"]} panels)', flush=True)
    return payload


def _worker_config(stage, config_dir, root=None):
    root = Path(root) if root is not None else Path(__file__).resolve().parent.parent
    worker = root / 'reusable' / 'worker_addon' / 'panel_replacement_worker.mjs'
    if not worker.is_file():
        raise RuntimeError('Missing open-reader Worker script: ' + str(worker))
    cfg = {'name': WORKER_NAME, 'compatibility_date': '2026-11-21',
           'main': str(worker.resolve()),
           'assets': {'directory': str(Path(stage).resolve()),
                      'not_found_handling': '404-page', 'binding': 'ASSETS',
                      # Assets, including chapter images and scripts, stay on the
                      # static fast path. Only authenticated API and dynamic
                      # issue/manifest routes invoke the Worker first.
                      'run_worker_first': ['/api/*', '/source-issues.json',
                                           '/comics/*/manifest.json']}}
    streaming = github_streaming.load_mode(root)
    if streaming:
        cfg['vars'] = {'GITHUB_OWNER':streaming['owner'],
                       'GITHUB_APP_ID':str(streaming['app_id']),
                       'GITHUB_APP_INSTALLATION_ID':str(streaming['installation_id'])}
    settings_file = root / '.archiver_state' / 'open_reader_uploads.json'
    if settings_file.is_file():
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        bucket = settings.get('r2_bucket') if isinstance(settings, dict) else None
        if not isinstance(bucket, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,62}', bucket):
            raise RuntimeError('Invalid R2 bucket configuration: ' + str(settings_file))
        cfg['r2_buckets'] = [{'binding':'PANEL_REPLACEMENTS','bucket_name':bucket}]
    path = Path(config_dir) / 'wrangler.json'
    path.write_bytes(canonical(cfg))
    return path


def _assert_no_unowned_existing_worker(engine, registry):
    """Prevent a first publish from overwriting an unrelated open-reader Worker."""
    out = engine.npx_wrangler(['deployments', 'list', '--name', WORKER_NAME, '--json'],
                              check=False, progress_label='Cloudflare: checking existing open-reader Worker')
    combined = (out.stdout or '') + '\n' + (out.stderr or '')
    if out.returncode:
        # A non-existing script is the only failure we may treat as fresh.
        if re.search(r'not found|does not exist|no such worker|script not found|10007',
                     combined, re.I):
            return
        raise RuntimeError('Could not establish ownership of existing open-reader Worker; '
                           'refusing to overwrite: ' + combined[-700:])
    try:
        deployments = json.loads(out.stdout)
    except (ValueError, TypeError):
        raise RuntimeError('Wrangler did not return verifiable Worker deployment inventory; '
                           'refusing to overwrite an unknown Worker')
    if isinstance(deployments, dict):
        deployments = deployments.get('deployments') or deployments.get('result') or []
    if not isinstance(deployments, list):
        raise RuntimeError('Unexpected existing Worker deployment listing; refusing overwrite')
    if deployments and not registry.get('worker_url'):
        raise RuntimeError('A Cloudflare Worker named open-reader already exists, but its '
                           'registry URL is not recorded in this application. Refusing '
                           'to overwrite unrelated content. Recover the URL from Cloudflare '
                           'Workers & Pages and set --open-reader-url once.')


def _deploy(engine, stage, registry):
    with tempfile.TemporaryDirectory(prefix='open-reader-config-') as tmp:
        cfg = _worker_config(stage, tmp, root=engine.ROOT)
        p = engine.npx_wrangler(['deploy', '--config', str(cfg)], cwd=Path(tmp),
                                progress_label='Cloudflare Workers upload: open-reader')
        output = (p.stdout or '') + '\n' + (p.stderr or '')
    matches = re.findall(r'https://open-reader\.[a-zA-Z0-9-]+\.workers\.dev', output)
    if matches:
        return matches[-1].rstrip('/')
    old = registry.get('worker_url', '').rstrip('/')
    if old and urlsplit(old).hostname and urlsplit(old).hostname.endswith('.workers.dev'):
        return old
    raise RuntimeError('Worker deployed but the production workers.dev hostname was not reported; '
                       'the previous library was not overwritten in local state. '
                       'Check Cloudflare Workers > open-reader for its production URL.')


def _verify_published(worker_url, staged, registry):
    """Validate all deployed assets, allowing *only* registered panel overlays.

    /source-issues.json is computed dynamically with R2 replacement states.
    /comics/slug/manifest.json may rewrite an exact source-missing panel to its
    verified uploaded replacement. All other fields and assets remain immutable.
    """
    stage = Path(staged)
    # Verify the dynamic Worker script, not just assets-only Cloudflare hosting.
    check = requests.get(worker_url.rstrip('/') + '/api/reader-health',
                         headers={'Cache-Control':'no-cache'}, timeout=40)
    if check.status_code != 200 or check.json().get('script') != 'open-reader-panel-replacement-v1':
        raise RuntimeError('Open Reader Worker backend is absent or outdated; refusing success')
    if (stage / 'upload-catalog.json').is_file() and not check.json().get('github_streaming_configured'):
        raise RuntimeError('GitHub App credentials missing on Worker; preserving previous Cloudflare image volumes')
    expected_feed = json.loads((stage / 'source-issues.json').read_text(encoding='utf-8'))
    source_ids = {c['id'] for c in expected_feed['cases']}
    live_feed = None
    github_replacements = None

    def validate_feed(data):
        if (not isinstance(data, dict) or
                data.get('schema') != 'comicarchiver.source_issue_feed.v1' or
                not isinstance(data.get('cases'), list)):
            return False
        ids = {c.get('id') for c in data['cases'] if isinstance(c, dict)}
        resolved = set(expected_feed.get('resolved_ids') or [])
        return source_ids.issubset(ids) and not ids.intersection(resolved)

    def validate_manifest(relative, deployed):
        """Allow a URL/hash rewrite only at a source-issue panel's exact slot."""
        expected = json.loads((stage / relative).read_text(encoding='utf-8'))
        if canonical(expected) == canonical(deployed):
            return True
        # GitHub manual replacements may alter only the exact image revision
        # identified by an independently fetched, read-only overrides catalog.
        nonlocal github_replacements
        if (stage / 'upload-catalog.json').is_file() and isinstance(deployed,dict):
            parts=Path(relative).parts
            if len(parts)==3 and parts[0]=='comics' and parts[2]=='manifest.json':
                if github_replacements is None:
                    response=requests.get(worker_url.rstrip('/')+'/api/github-replacements.json',timeout=30)
                    if response.ok and response.json().get('schema')=='reader-github-replacements-v1':
                        github_replacements=response.json().get('panels') or {}
                    else:
                        github_replacements={}
                original=json.loads(json.dumps(expected))
                edited=json.loads(json.dumps(deployed))
                if (isinstance(edited.get('chapters'),list) and
                        len(edited['chapters'])==len(original.get('chapters',[]))):
                    ok=True
                    for ch,prev_ch in zip(edited['chapters'],original['chapters']):
                        if ch.get('id')!=prev_ch.get('id') or len(ch.get('images',[]))!=len(prev_ch.get('images',[])):
                            ok=False;break
                        for i,(im,prev) in enumerate(zip(ch['images'],prev_ch['images']),1):
                            if im==prev:continue
                            expected_sha=github_replacements.get(f'{parts[1]}:{ch["id"]}:{i}')
                            expected_url=github_streaming.route(parts[1],str(ch['id']),i,str(expected_sha))
                            if (not re.fullmatch('[a-f0-9]{64}',str(expected_sha)) or
                                    im.get('sha256')!=expected_sha or im.get('url')!=expected_url or
                                    {k:v for k,v in im.items() if k not in ('sha256','url')} !=
                                    {k:v for k,v in prev.items() if k not in ('sha256','url')}):
                                ok=False;break
                            im.update({'sha256':prev['sha256'],'url':prev['url']})
                        if not ok:break
                    if ok and canonical(edited)==canonical(original):
                        return True
        if live_feed is None or not isinstance(deployed, dict):
            return False
        parts = Path(relative).parts
        if len(parts) != 3 or parts[0] != 'comics' or parts[2] != 'manifest.json':
            return False
        slug = parts[1]
        chapters = deployed.get('chapters')
        old_chapters = expected.get('chapters')
        if (not isinstance(chapters, list) or not isinstance(old_chapters, list) or
                len(chapters) != len(old_chapters)):
            return False
        allowed = {(str(c['episode_id']), int(c['panel'])): c for c in live_feed['cases']
                   if isinstance(c, dict) and c.get('work_slug') == slug and
                   str(c.get('episode_id','')) and
                   str(c.get('panel','')).isdigit() and
                   re.fullmatch(r'[a-f0-9]{20}', str(c.get('id','')))}
        normalized = json.loads(json.dumps(deployed))
        for ch, old in zip(normalized['chapters'], old_chapters):
            if str(ch.get('id')) != str(old.get('id')) or not isinstance(ch.get('images'), list):
                return False
            if len(ch['images']) != len(old['images']):
                return False
            for i, image in enumerate(ch['images']):
                previous = old['images'][i]
                if image == previous:
                    continue
                case = allowed.get((str(ch['id']), i+1))
                if not case or not case.get('replacement_present'):
                    return False
                prefix = '/api/panel-replacements/' + case['id'] + '?v='
                if (not isinstance(image,dict) or
                        not isinstance(image.get('url'),str) or
                        not image['url'].startswith(prefix) or
                        image.get('sha256') != case.get('replacement_sha256') or
                        not re.fullmatch(r'[0-9a-f]{64}', str(image.get('sha256','')))):
                    return False
                image['url'] = previous['url']
                image['sha256'] = previous['sha256']
        return canonical(normalized) == canonical(expected)

    for source in sorted(p for p in stage.rglob('*') if p.is_file()):
        relative = source.relative_to(stage).as_posix()
        public_path = relative[:-len('index.html')] if relative.endswith('index.html') else relative
        expected_hash = sha(source.read_bytes())
        url = worker_url.rstrip('/') + '/' + public_path
        problem = 'no response'
        for attempt in range(5):
            try:
                response = requests.get(url, headers={'Cache-Control': 'no-cache'}, timeout=40)
                if response.status_code == 200:
                    if sha(response.content) == expected_hash:
                        break
                    if relative == 'source-issues.json':
                        data = response.json()
                        if validate_feed(data):
                            live_feed = data
                            break
                    elif relative.startswith('comics/') and relative.endswith('/manifest.json'):
                        if live_feed is None:
                            feed_response = requests.get(worker_url.rstrip('/') + '/source-issues.json',
                                                         headers={'Cache-Control':'no-cache'}, timeout=40)
                            if feed_response.ok and validate_feed(feed_response.json()):
                                live_feed = feed_response.json()
                        if validate_manifest(relative, response.json()):
                            break
                    problem = 'HTTP 200 but unexpected dynamic content or SHA-256 mismatch'
                else:
                    problem = f'HTTP {response.status_code}'
            except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
                problem = f'{type(exc).__name__}: {exc}'
            if attempt < 4:
                import time
                print(f'open-reader: verifying {url}: {problem}; retry {attempt+1}/5', flush=True)
                time.sleep(min(10, 2**attempt))
        else:
            raise RuntimeError(f'Open Reader live URL is unavailable or outdated: {url} '
                               f'({problem}); refusing to claim deployment complete')
        print(f'open-reader: HTTP 200 + integrity OK {url}', flush=True)
    if (stage / 'upload-catalog.json').is_file():
        # Inspect actual Worker -> private GitHub -> browser bytes BEFORE any
        # old Pages project could be considered redundant.
        found = {}
        for slug, comic in registry['comics'].items():
            for ch in comic['chapters']:
                for im in ch['images']:
                    orig=im.get('github')
                    if orig:
                        found.setdefault(orig['repo'],[]).append(im)
        for repo, images in sorted(found.items()):
            for im in (images[:1]+images[-1:] if len(images)>1 else images):
                target=worker_url.rstrip('/')+im['url']
                response=requests.get(target,timeout=60,headers={'Cache-Control':'no-cache'})
                if response.status_code!=200 or sha(response.content)!=im['sha256']:
                    raise RuntimeError('Worker GitHub image verification failed: '+repo+': '+target+
                                       ' (HTTP '+str(response.status_code)+')')
            print('open-reader: live GitHub-on-demand pixels verified '+repo,flush=True)


def _sync_github_readme(engine, owner, token, repo, slug, route):
    """Non-destructively replace ONLY a marker-owned README block via GitHub API.

    The 409/422 compare-and-swap conflict is not retried blindly. All original
    README lines and image/tree files remain in the original repository.
    """
    url = f'{engine.GITHUB_API}/repos/{owner}/{repo}/contents/README.md'
    response = engine.github_http('GET', url + '?ref=main', token)
    if response.status_code not in (200, 404):
        raise RuntimeError(f'Cannot check {repo} README: HTTP {response.status_code}')
    sha_value = None
    if response.status_code == 200:
        info = response.json()
        sha_value = info.get('sha')
        if not sha_value:
            raise RuntimeError(f'GitHub omitted README blob identity: {repo}')
        body = _repo_contents(engine, owner, token, repo, 'README.md')
        original = body.decode('utf-8')
    else:
        original = f'# {slug.replace("-", " ").title()}\n'
    start = '<!-- open-reader:begin -->'
    end = '<!-- open-reader:end -->'
    marker = (f'{start}\n\nShared comic library: '
              f'[{WORKER_NAME}]({route.split("/comics/")[0]}/)\n\n'
              f'Read this series: [{slug}]({route})\n\n{end}')
    if start in original and end in original and original.index(start) < original.index(end):
        before, tail = original.split(start, 1)
        _, after = tail.split(end, 1)
        updated = before + marker + after
    elif start in original or end in original:
        raise RuntimeError(f'Existing {repo} README contains incomplete open-reader markers; refusing overwrite')
    else:
        updated = original.rstrip() + '\n\n' + marker + '\n'
    if updated == original:
        return False
    payload = {'message': 'Document verified open-reader library route',
               'content': base64.b64encode(updated.encode('utf-8')).decode('ascii'),
               'branch': 'main'}
    if sha_value:
        payload['sha'] = sha_value
    save = engine.github_http('PUT', url, token, json=payload)
    if save.status_code not in (200, 201):
        raise RuntimeError(f'{repo} README changed during sync or GitHub rejected update '
                           f'(HTTP {save.status_code}); no other repository files modified')
    after = _repo_contents(engine, owner, token, repo, 'README.md')
    if after != updated.encode('utf-8'):
        raise RuntimeError(f'{repo} README remote verification mismatch')
    return True



def _remote_shared_registry(engine, owner, token, repo_names):
    """Private GitHub open-reader registry is the durable discovery index."""
    if WORKER_NAME not in repo_names:
        return None, None
    info = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}', token)
    if info.status_code != 200 or info.json().get('private') is not True:
        raise RuntimeError('Cannot verify private GitHub open-reader registry ownership')
    branch = info.json().get('default_branch') or 'main'
    endpoint = (f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}/contents/'
                'registry.json?ref=' + quote(branch, safe=''))
    response = engine.github_http('GET', endpoint, token)
    if response.status_code == 404:
        info = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}', token)
        if (info.status_code == 200 and info.json().get('private') is True and
                info.json().get('description') == REGISTRY_DESCRIPTION):
            # A prior run might have created the private registry repository
            # and crashed before writing its first registry.json. Recover.
            return None, None
        raise RuntimeError('A GitHub repo named open-reader already exists without '
                           'a recognized archiver registry; refusing to overwrite it')
    if response.status_code != 200:
        raise RuntimeError(f'Cannot inspect GitHub open-reader registry: HTTP {response.status_code}')
    raw = _repo_contents(engine, owner, token, WORKER_NAME, 'registry.json', ref=branch)
    decoded = json.loads(raw)
    if (not isinstance(decoded, dict) or decoded.get('version') != SCHEMA or
            not isinstance(decoded.get('comics'), dict)):
        raise RuntimeError('Existing GitHub open-reader registry is not a recognized '
                           'comic archive; refusing to overwrite it')
    blob_sha = response.json().get('sha')
    if not blob_sha:
        raise RuntimeError('GitHub shared registry returned no version token')
    return decoded, blob_sha


def _checkpoint_shared_registry(engine, db, owner, token, registry, known_sha, owned_repos):
    """One private repo, version-checked PUT, no image blobs, no deletes."""
    if WORKER_NAME not in owned_repos:
        check = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}', token)
        if check.status_code == 404:
            created = engine.github_http('POST', f'{engine.GITHUB_API}/user/repos', token,
                json={'name':WORKER_NAME,'private':True,'auto_init':True,
                      'description':REGISTRY_DESCRIPTION})
            if created.status_code != 201:
                raise RuntimeError('Cannot create private GitHub open-reader registry '
                                   f'(HTTP {created.status_code}); Worker is verified and saved. '
                                   'Rerun to retry only this step.')
        elif (check.status_code != 200 or check.json().get('private') is not True or
              check.json().get('description') != REGISTRY_DESCRIPTION):
            raise RuntimeError('GitHub open-reader repo already exists but is not an archiver-'
                               'owned private registry; refusing to modify it')
    meta = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}', token)
    if meta.status_code != 200 or meta.json().get('private') is not True:
        raise RuntimeError('New open-reader backup repository could not be verified as private')
    branch = meta.json().get('default_branch') or 'main'
    endpoint = f'{engine.GITHUB_API}/repos/{owner}/{WORKER_NAME}/contents/registry.json'
    # Check for concurrent publication before changing a shared registry.
    response = engine.github_http('GET', endpoint + '?ref=' + quote(branch, safe=''), token)
    current_sha = response.json().get('sha') if response.status_code == 200 else None
    if response.status_code not in (200, 404):
        raise RuntimeError(f'Cannot check GitHub shared registry before sync: HTTP {response.status_code}')
    if known_sha != current_sha:
        raise RuntimeError('GitHub open-reader registry changed during publication; refusing '
                           'to overwrite a newer library. Rerun python run.py to merge it.')
    output = {'version':SCHEMA, 'worker_url':registry['worker_url'], 'comics':registry['comics']}
    data = canonical(output)
    if current_sha:
        saved = _repo_contents(engine, owner, token, WORKER_NAME, 'registry.json', ref=branch)
        if saved == data:
            return
    payload = {'message':'Back up verified open-reader library registry',
               'content':base64.b64encode(data).decode('ascii'), 'branch':branch}
    if current_sha:
        payload['sha'] = current_sha
    updated = engine.github_http('PUT', endpoint, token, json=payload)
    if updated.status_code not in (200,201):
        raise RuntimeError('GitHub could not checkpoint shared library index '
                           f'(HTTP {updated.status_code}). Worker remains verified; rerun to retry.')
    verified = _repo_contents(engine, owner, token, WORKER_NAME, 'registry.json', ref=branch)
    if verified != data:
        raise RuntimeError('GitHub shared library index remote checksum mismatch')
    print(f'open-reader: shared registry saved to private GitHub {owner}/{WORKER_NAME}',flush=True)


def _checkpoint_legacy_sqlite(engine, registry):
    """After Worker verification, update old chapter links, not image archives."""
    base = registry['worker_url'].rstrip('/')
    for path in list_local_state_dbs(engine.ROOT):
        try:
            with closing(sqlite3.connect(path)) as conn:
                row = conn.execute("SELECT value FROM options WHERE key='series_slug'").fetchone()
                if not row:
                    continue
                slug = json.loads(row[0])
                comic = registry['comics'].get(slug)
                if not comic:
                    continue
                allowed = {str(c['id']) for c in comic['chapters']}
                route = base + '/comics/' + slug + '/'
                with conn:
                    for ident in allowed:
                        conn.execute("UPDATE chapters SET status='PUBLISHED_VERIFIED', "
                                     "published_url=? WHERE chapter_id=? AND status IN "
                                     "('PUBLISHED_VERIFIED','ARCHIVED_PENDING_DEPLOYMENT')",
                                     (route + '?chapter=' + quote(ident, safe=''), ident))
                    conn.execute("INSERT OR REPLACE INTO deployments "
                                 "(project,product,production_url,deployed_at,files,bytes) "
                                 "VALUES (?,?,?,?,?,?)",
                                 ('open-reader:' + slug, 'shared-worker', route, engine.utc(),
                                  len(comic['chapters']), 0))
        except (sqlite3.Error, ValueError) as exc:
            raise RuntimeError(f'Could not checkpoint {path} with verified shared reader URL: {exc}') from exc


def _finalize_legacy_links(engine, registry, owner, token, owned_repos):
    """Repair outdated README routes and SQLite URLs after verified publish.

    Failures never undo Worker deployment or image archives. A later run simply
    resumes this documentation checkpoint without deploying Workers again.
    """
    _checkpoint_legacy_sqlite(engine, registry)
    worker = registry['worker_url'].rstrip('/')
    for slug in sorted(registry['comics']):
        route = f'{worker}/comics/{slug}/'
        series_repos = sorted(repo for repo in owned_repos
                              if repo == slug + '-reader' or
                              (VOLUME_RE.fullmatch(repo) and
                               VOLUME_RE.fullmatch(repo).group(1) == slug))
        for repo in series_repos:
            print(f'open-reader: checking GitHub {repo} README...', flush=True)
            changed = _sync_github_readme(engine, owner, token, repo, slug, route)
            if changed:
                print(f'open-reader: GitHub {repo} README now links to shared reader', flush=True)
    # Local README has a discoverable URL too, even if current adapter changed.
    file = engine.ROOT / 'README.md'
    if file.is_file():
        old = file.read_text(encoding='utf-8')
        marker = '<!-- shared-open-reader-url -->'
        line = f'{marker}\n\nShared Cloudflare Worker library: {worker}/'
        if marker in old:
            prefix = old.split(marker, 1)[0].rstrip()
            # Keep developer documentation after an explicit end marker only.
            ending = '<!-- /shared-open-reader-url -->'
            if ending not in old:
                raise RuntimeError('Local README contains an unfinished open-reader marker; not overwriting it')
            suffix = old.split(ending, 1)[1]
            updated = prefix + '\n\n' + line + '\n' + ending + suffix
        else:
            updated = old.rstrip() + '\n\n' + line + '\n<!-- /shared-open-reader-url -->\n'
        if updated != old:
            file.write_bytes(updated.encode('utf-8'))


def publish(engine, db, *, dry_run=False):
    """Full account-wide reconciliation on every publish; never delete old comics."""
    registry = load_state(engine.ROOT)
    # Recover from local state first. If a previous run saved the consolidated
    # Worker registry, union it before considering current-site artifacts.
    combine(registry, local_candidates(engine))
    owner, token = engine.credential_for_selected(db)
    if not owner or not token:
        raise RuntimeError('GitHub login required for complete library discovery')
    # Wrangler Pages listing is read-only; errors stop publication instead of
    # silently dropping previous source sites from the new Worker.
    engine.select_cloudflare_account()
    remote, owned_repos = remote_candidates(engine, db, registry['comics'])
    combine(registry, remote)
    saved_remote_registry, known_registry_sha = _remote_shared_registry(
        engine, owner, token, owned_repos)
    if saved_remote_registry:
        original = registry['comics']
        registry['comics'] = {}
        combine(registry, saved_remote_registry['comics'])
        combine(registry, original)
        if not registry.get('worker_url'):
            registry['worker_url'] = saved_remote_registry.get('worker_url', '')
    live = _load_live_worker(registry)
    if not registry['comics']:
        raise RuntimeError('No verified legacy or local comics available for open-reader')
    print(f'open-reader: verifying archived image hosts for {len(registry["comics"])} comics...', flush=True)
    streaming_mode = github_streaming.load_mode(engine.ROOT)
    if streaming_mode:
        if owner.lower()!=streaming_mode['owner'].lower():
            raise RuntimeError('Streaming config Github owner differs from active archive account')
        count=github_streaming.convert_registry(registry)
        # GitHub itself is the only permanent image store; no Pages-volume
        # preflight or asset reconstruction is performed in this mode.
        github_streaming.validate_github_samples(engine,owner,token,registry)
        print(f'open-reader: indexed {count} GitHub image routes without Pages uploads',flush=True)
    else:
        for slug, comic in registry['comics'].items():
            _validate_live_assets(comic, engine)
            print(f'  Verified {slug}: {len(comic["chapters"])} chapters; no image downloads from source', flush=True)
    if dry_run:
        print('open-reader library audit (no remote changes):', flush=True)
        for slug, comic in sorted(registry['comics'].items()):
            print(f'  {slug}: {len(comic["chapters"])} chapters', flush=True)
        return registry.get('worker_url', '')
    with tempfile.TemporaryDirectory(prefix='comic-open-reader-') as tmp:
        stage = Path(tmp)
        payload = stage_worker_assets(engine.ROOT, registry, stage)
        if live is not None and canonical(live) == canonical(payload):
            # The old Worker is still live, and the frontend/manifest bytes match.
            # No deployed Worker version is replaced unnecessarily.
            try:
                _verify_published(registry['worker_url'], stage, registry)
            except RuntimeError:
                print('open-reader: stale Worker static files detected; republishing...', flush=True)
            else:
                save_state(engine, registry)
                _checkpoint_shared_registry(engine, db, owner, token, registry,
                                            known_registry_sha, owned_repos)
                _finalize_legacy_links(engine, registry, owner, token, owned_repos)
                print('open-reader: all known comics already current; no upload necessary.', flush=True)
                return registry['worker_url']
        _assert_no_unowned_existing_worker(engine, registry)
        print(f'open-reader: publishing {len(registry["comics"])} comics as ONE Worker...', flush=True)
        url = _deploy(engine, stage, registry)
        _verify_published(url, stage, registry)
        registry['worker_url'] = url
        save_state(engine, registry)
        _checkpoint_shared_registry(engine, db, owner, token, registry,
                                    known_registry_sha, owned_repos)
        _finalize_legacy_links(engine, registry, owner, token, owned_repos)
        print(f'OPEN-READER URL: {url}', flush=True)
        print(f'COMPLETED: {len(registry["comics"])} comics are verified in one Worker.', flush=True)
        return url
