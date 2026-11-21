"""Account-wide, append-only library of archived comics on ONE Cloudflare Worker.

No selector, site URL, chapter-title parser, or per-website hook lives here.
An adapter switch never resets the registry. Discovery only accepts application-
owned local SQLite state, confirmed reader manifests from owned GitHub repos,
or an exact existing Cloudflare reader project. No destructive remote operations.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests

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
            if (parts.scheme != 'https' or not parts.netloc or parts.username or
                    parts.password or parts.fragment or not parts.hostname or
                    not (parts.hostname.endswith('.pages.dev') or
                         parts.hostname.endswith('.workers.dev'))):
                raise ValueError('Archived image must use a trusted HTTPS Cloudflare asset host')
            checksum = str(item.get('sha256') or '').lower()
            if not re.fullmatch(r'[a-f0-9]{64}', checksum):
                raise ValueError('Archived image lacks SHA-256')
            images.append({'url': url, 'width': int(item.get('width') or 1),
                           'height': int(item.get('height') or 1), 'sha256': checksum})
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
        merged = dict(chapter if len(chapter['images']) >= len(previous['images']) else previous)
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
            with sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True) as conn:
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
                for row in rows:
                    image_repo = row['repository']
                    host = deployed.get(image_repo[:58])
                    if not host:
                        complete = False
                        break
                    manifest = json.loads(row['pages_json'] or '{}')
                    files, images = manifest.get('remote_files'), manifest.get('images')
                    if not files or not images or len(files) != len(images):
                        complete = False
                        break
                    items = []
                    for file, image in zip(files, images):
                        items.append({'url': host.rstrip('/') + '/' + file,
                                      'width': image.get('width'), 'height': image.get('height'),
                                      'sha256': image.get('sha256')})
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
        if not host:
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
                             'images': [{'url': host.rstrip('/') + '/' + p,
                                         'sha256': im['sha256'], 'width': im.get('width'),
                                         'height': im.get('height')} for p, im in zip(paths, pages)]})
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
    return sha(canonical(files))


def _registry_payload(registry, frontend_hash):
    return {'version': SCHEMA, 'frontend_hash': frontend_hash,
            'comics': {k: registry['comics'][k] for k in sorted(registry['comics'])}}


def _index_html():
    return '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>open-reader</title><style>
:root{color-scheme:dark;font-family:system-ui,Segoe UI,sans-serif;background:#0b0b0d;color:#eee}*{box-sizing:border-box}body{margin:0 auto;max-width:950px;padding:clamp(20px,5vw,54px)}h1{font-size:clamp(27px,5vw,44px);letter-spacing:-.04em;margin:0 0 12px}.subtitle{color:#8f919b;margin:0 0 36px}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}.comic{padding:20px;border:1px solid #292b31;border-radius:12px;color:inherit;text-decoration:none;background:#141518;transition:border-color .15s,transform .15s}.comic:hover,.comic:focus-visible{border-color:#9396a4;transform:translateY(-2px)}.comic b{display:block;margin-bottom:10px;font-size:18px;line-height:1.35}.comic small{color:#999ca8}#search{background:#17181c;border:1px solid #383942;border-radius:8px;color:#eee;font:inherit;padding:12px;width:min(100%,450px);margin:0 0 25px}.empty{color:#9295a0}
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
                           'route': f'/comics/{slug}/'}
                          for slug, comic in sorted(registry['comics'].items())]}
    (stage / 'library.json').write_bytes(canonical(summary))
    for slug, comic in sorted(registry['comics'].items()):
        dest = stage / 'comics' / slug
        dest.mkdir(parents=True, exist_ok=True)
        for file in (Path(root) / 'reader').iterdir():
            if file.is_file():
                shutil.copy2(file, dest / file.name)
        (dest / 'manifest.json').write_bytes(canonical({'title': comic['title'],
                                                        'chapters': comic['chapters']}))
    return payload


def _worker_config(stage, config_dir):
    cfg = {'name': WORKER_NAME, 'compatibility_date': '2026-11-20',
           'assets': {'directory': str(Path(stage).resolve()),
                      'not_found_handling': '404-page'}}
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
        cfg = _worker_config(stage, tmp)
        p = engine.npx_wrangler(['deploy', '--config', str(cfg)], cwd=Path(tmp),
                                progress_label='Cloudflare Workers upload: open-reader')
        output = (p.stdout or '') + '\n' + (p.stderr or '')
    matches = re.findall(r'https://open-reader\.[a-zA-Z0-9-]+\.workers\.dev', output)
    if matches:
        return matches[-1].rstrip('/')
    # The Worker may have an existing hostname, or Wrangler may omit the URL.
    old = registry.get('worker_url', '').rstrip('/')
    if old and urlsplit(old).hostname and urlsplit(old).hostname.endswith('.workers.dev'):
        return old
    raise RuntimeError('Worker deployed but the production workers.dev hostname was not reported; '
                       'the previous library was not overwritten in local state. '
                       'Check Cloudflare Workers > open-reader for its production URL.')


def _verify_published(worker_url, staged, registry):
    """Prove the public library AND its reader pages work, not just JSON files.

    On unchanged deployments this is the gate for skipping Wrangler. The old
    gate verified only JSON and could declare success with a broken homepage.
    """
    stage = Path(staged)
    # Check every deployed reader asset, including JavaScript and styles. An
    # unchanged registry alone does not prove that a comic can actually render.
    # Static Workers serve directory index.html at the public trailing-slash
    # route; checking /index.html would miss a broken user-facing / URL.
    paths = []
    for source in sorted(p for p in stage.rglob('*') if p.is_file()):
        relative = source.relative_to(stage).as_posix()
        public_path = relative[:-len('index.html')] if relative.endswith('index.html') else relative
        paths.append((relative, public_path))

    for relative, public_path in paths:
        expected = sha((stage / relative).read_bytes())
        url = worker_url.rstrip('/') + '/' + public_path
        problem = 'no response'
        for attempt in range(5):
            try:
                response = requests.get(url, headers={'Cache-Control': 'no-cache'}, timeout=40)
                if response.status_code == 200 and sha(response.content) == expected:
                    break
                problem = (f'HTTP {response.status_code}' if response.status_code != 200
                           else 'HTTP 200 but deployed content checksum differs')
            except requests.RequestException as exc:
                problem = f'{type(exc).__name__}: {exc}'
            if attempt < 4:
                import time
                print(f'open-reader: verifying {url}: {problem}; retry {attempt+1}/5', flush=True)
                time.sleep(min(10, 2**attempt))
        else:
            raise RuntimeError(f'Open Reader live URL is unavailable or outdated: {url} '
                               f'({problem}); refusing to claim deployment complete')
        print(f'open-reader: HTTP 200 + SHA-256 OK {url}', flush=True)



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
            with sqlite3.connect(path) as conn:
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
