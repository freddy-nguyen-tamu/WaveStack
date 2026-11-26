"""Targeted, non-destructive shared Open Reader publication.

Uses the verified *live* registry as its baseline. Unlike the account-wide
publisher, neither mode enumerates previously owned GitHub repos/Pages sites,
or verifies historic GitHub image samples. Only the selected comic is sampled
in 'comic' mode. The Worker deployment still stages ALL assets so unrelated
comics are never intentionally removed by Wrangler's asset replacement.
"""
from __future__ import annotations

import json
import re
import sqlite3
import tempfile

import requests
from pathlib import Path
from urllib.parse import urlsplit, quote

from . import github_streaming
from . import open_reader as reader


def current_comic(engine, db):
    """Read only the current adapter's trusted SQLite archive, not other sites."""
    slug = engine.get_option(db, 'series_slug')
    if not isinstance(slug, str) or not reader.SLUG_RE.fullmatch(slug):
        raise RuntimeError('Current comic is not identified by verified local archive state')
    rows = db.execute('SELECT chapter_id,label,pages_json,repository FROM chapters '
                      "WHERE status IN ('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED') "
                      'AND repository IS NOT NULL ORDER BY ordinal').fetchall()
    if not rows:
        raise RuntimeError('No verified GitHub chapter manifests for the selected comic')
    streaming = github_streaming.load_mode(engine.ROOT)
    deployed = {p: url for p, url in db.execute(
        'SELECT project,production_url FROM deployments WHERE production_url IS NOT NULL').fetchall()}
    chapters = []
    for chapter_id, label, manifest_json, repo in rows:
        manifest = json.loads(manifest_json or '{}')
        files, images = manifest.get('remote_files'), manifest.get('images')
        if not files or not images or len(files) != len(images):
            raise RuntimeError('Current comic has an incomplete archived chapter manifest; refusing publication')
        host = deployed.get(repo[:58])
        if not streaming and not host:
            raise RuntimeError('Current comic has no verified public image host: ' + repo)
        items = []
        for index, (path, im) in enumerate(zip(files, images), 1):
            digest = im.get('sha256')
            item = {'url': github_streaming.route(slug, chapter_id, index, digest) if streaming
                    else host.rstrip('/') + '/' + path,
                    'width': im.get('width'), 'height': im.get('height'), 'sha256': digest}
            if streaming:
                item['github'] = {'repo': repo, 'path': path}
            items.append(item)
        chapters.append({'id': chapter_id, 'label': label,
                         'title': manifest.get('chapter_title') or label,
                         'number': chapter_id, 'images': items})
    return reader.validate_comic(slug, engine.get_option(db, 'series_title'), chapters)


def _checkpoint_current(db, engine, registry, slug):
    """Record verified publication ONLY for the selected comic in its SQLite."""
    base = registry['worker_url'].rstrip('/')
    comic = registry['comics'][slug]
    route = base + '/comics/' + slug + '/'
    with db:
        for chapter in comic['chapters']:
            db.execute("UPDATE chapters SET status='PUBLISHED_VERIFIED', published_url=? "
                       "WHERE chapter_id=? AND status IN "
                       "('ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED')",
                       (route + '?chapter=' + quote(str(chapter['id']), safe=''), str(chapter['id'])))
        db.execute('INSERT OR REPLACE INTO deployments '
                   '(project,product,production_url,deployed_at,files,bytes) VALUES (?,?,?,?,?,?)',
                   ('open-reader:' + slug, 'shared-worker', route, engine.utc(), len(comic['chapters']), 0))


def _target_readmes(engine, owner, token, registry, slug):
    """Only repositories referenced by this comic; no account-wide inventory."""
    repos = {im['github']['repo'] for chapter in registry['comics'][slug]['chapters']
             for im in chapter['images'] if im.get('github')}
    route = registry['worker_url'].rstrip('/') + '/comics/' + slug + '/'
    pending = []
    for index, repo in enumerate(sorted(repos), 1):
        print(f'open-reader: README {index}/{len(repos)} {repo}', flush=True)
        try:
            check = engine.github_http('GET', f'{engine.GITHUB_API}/repos/{owner}/{repo}', token)
            data = check.json() if check.status_code == 200 else {}
            if check.status_code != 200 or not isinstance(data,dict) or not data.get('private') or \
                    (data.get('owner') or {}).get('login','').lower() != owner.lower():
                raise RuntimeError('Current comic repository identity could not be verified: ' + repo)
            changed = reader._sync_github_readme(engine, owner, token, repo, slug, route)
            print(f'open-reader: README {repo} ' + ('updated and verified' if changed else 'already current'), flush=True)
        except (RuntimeError, requests.RequestException, ValueError) as exc:
            pending.append(repo)
            print(f'open-reader: README PENDING {repo}: {exc}', flush=True)
    if pending:
        raise RuntimeError('Publication verified; README synchronization pending: ' + ', '.join(pending) +
                           '. Run python run.py --repair-reader-readmes to retry only README files.')


def repair_verified_readmes(engine, db):
    """Documentation-only recovery; never deploy, archive, or mark a chapter verified."""
    state = reader.load_state(engine.ROOT)
    url = str(state.get('worker_url') or '').rstrip('/')
    if not re.fullmatch(r'https://open-reader\.[a-z0-9-]+\.workers\.dev', url):
        raise RuntimeError('No verified shared Worker URL; run normal publication first')
    slug = engine.get_option(db, 'series_slug')
    comic = state['comics'].get(slug)
    rows = db.execute('SELECT chapter_id,status,published_url FROM chapters').fetchall()
    route = url + '/comics/' + str(slug) + '/'
    if (not comic or not rows or
            {str(row[0]) for row in rows} != {str(ch['id']) for ch in comic['chapters']} or
            any(status != 'PUBLISHED_VERIFIED' or not link or
                link != route + '?chapter=' + quote(str(chid), safe='') for chid, status, link in rows)):
        raise RuntimeError('Current comic is not fully checkpointed as published; run normal publication first')
    # Compare current local archive identity, the live index and the durable
    # private index. Do not rely on stale SQLite alone and do not repeat image
    # or asset verification for a documentation-only operation.
    current = current_comic(engine, db)
    if reader.canonical(current['chapters']) != reader.canonical(comic['chapters']):
        raise RuntimeError('Current archive metadata differs from verified registry; run normal publication first')
    owner, token = engine.credential_for_selected(db)
    if not owner or not token:
        raise RuntimeError('GitHub authentication is required to repair README files')
    print('open-reader: checking live and private registry for README-only recovery', flush=True)
    live = reader._public_json(url + '/registry.json')
    saved, known_sha = reader._remote_shared_registry(engine, owner, token, {reader.WORKER_NAME})
    expected = {'version':reader.SCHEMA, 'worker_url':url, 'comics':state['comics']}
    if (not known_sha or not isinstance(live, dict) or live.get('version') != reader.SCHEMA or
            reader.canonical(live.get('comics')) != reader.canonical(state['comics']) or
            reader.canonical(saved) != reader.canonical(expected)):
        raise RuntimeError('Live/private registry differs from verified local index; run normal publication first')
    if state.get('verified_frontend_hash') and live.get('frontend_hash') != state['verified_frontend_hash']:
        raise RuntimeError('Live frontend differs from previously verified version; run normal publication first')
    _target_readmes(engine, owner, token, state, slug)
    print('README REPAIR COMPLETE: documentation only; no archive, asset or deployment changes.', flush=True)


def publish(engine, db, *, scope):
    if scope not in ('comic', 'site'):
        raise ValueError('Focused publishing supports comic or site only')
    state = reader.load_state(engine.ROOT)
    url = str(state.get('worker_url') or '').rstrip('/')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.path or parsed.query or parsed.fragment or
            not re.fullmatch(r'open-reader\.[a-z0-9-]+\.workers\.dev', parsed.hostname or '')):
        raise RuntimeError('Focused publication requires a previously verified shared Worker URL. '
                           'Choose full sync once to establish it.')
    # Live registry is authoritative; never build from potentially stale SQLite
    # snapshots of other comics. Fetching this ONE index is needed to prevent loss.
    live = reader._public_json(url + '/registry.json')
    if not isinstance(live,dict) or live.get('version') != reader.SCHEMA or \
            not isinstance(live.get('comics'),dict) or not live['comics']:
        raise RuntimeError('Existing live shared library is unavailable or invalid; refusing partial publishing')
    registry = {'version':reader.SCHEMA, 'worker_url':url, 'comics':{}}
    reader.combine(registry, live['comics'])
    current_slug = engine.get_option(db, 'series_slug') if scope == 'comic' else None
    pending = set(state['comics']) - set(registry['comics'])
    if pending - ({current_slug} if current_slug else set()):
        raise RuntimeError('Other comics exist only in local registry; choose full sync to avoid dropping them: '
                           + ', '.join(sorted(pending)))
    shared_frontend_changed = False
    if scope == 'comic':
        comic = current_comic(engine, db)
        current_slug = comic['slug']
        if current_slug not in registry['comics'] and len(set(state['comics']) - set(registry['comics'])) > 1:
            raise RuntimeError('Other unpublished comics require full sync first')
        reader.combine(registry, {current_slug: comic})
        # Shared changes affect every generated reader route. Expand STATIC
        # verification, not historical repository discovery or image sampling.
        # Preserve all other live comic manifests and retain the private registry
        # consistency checks below.
        frontend_hash = reader._reader_hash(engine.ROOT)
        shared_frontend_changed = (frontend_hash != live.get('frontend_hash')
                                   or frontend_hash != state.get('verified_frontend_hash'))
        if shared_frontend_changed:
            print('open-reader: shared frontend changed; verifying all frontend routes '
                  'with current-comic image samples only. Other comics preserved.', flush=True)
    owner, token = engine.credential_for_selected(db)
    if not owner or not token:
        raise RuntimeError('Authenticated GitHub account is required to protect the private registry')
    engine.select_cloudflare_account()
    # One GitHub registry version/ownership check, not 19+ repository scans.
    saved, known_sha = reader._remote_shared_registry(engine,owner,token,{reader.WORKER_NAME})
    if saved is None or not known_sha:
        raise RuntimeError('Private remote reader registry is missing; use full sync once before focused updates')
    remote_slugs = set(saved['comics'])
    if remote_slugs - set(registry['comics']):
        raise RuntimeError('Private registry contains comics not deployed live. Full sync is required.')
    # If GitHub knows newer chapters for another comic, fail rather than
    # overwriting that metadata with a smaller live snapshot.
    for slug in remote_slugs - ({current_slug} if current_slug else set()):
        if reader.canonical(saved['comics'][slug]) != reader.canonical(registry['comics'][slug]):
            raise RuntimeError('Private registry differs from live for '+slug+'; full sync required to reconcile safely')
    streaming = github_streaming.load_mode(engine.ROOT)
    if scope == 'comic':
        if streaming:
            if owner.lower() != streaming['owner'].lower():
                raise RuntimeError('Selected GitHub account differs from streaming owner')
            github_streaming.validate_github_samples(engine, owner, token,
                {'comics': {current_slug:registry['comics'][current_slug]}})
        else:
            reader._validate_live_assets(registry['comics'][current_slug],engine)
    with tempfile.TemporaryDirectory(prefix='comic-open-reader-focused-') as tmp:
        stage = Path(tmp)
        partial_records = None
        if streaming:
            # Retain any independently verified incomplete-chapter placeholders
            # in ALL existing comics, even when unrelated comics are not sampled.
            from .partial_chapter_publish import publish_partial_checkpoints
            partial_records = publish_partial_checkpoints(engine.ROOT,engine,owner,token)
        payload = reader.stage_worker_assets(engine.ROOT, registry, stage,
                                             partial_records=partial_records)
        verify_slugs = {current_slug} if scope == 'comic' else set()
        verify_kwargs = {'verify_slugs': verify_slugs}
        if shared_frontend_changed:
            verify_kwargs = {'verify_slugs': None, 'verify_image_slugs': {current_slug}}
        # Shared reader JavaScript is generated separately for every comic.
        # A site-only frontend change must verify those static routes too,
        # without requesting old image samples or reconciling archives.
        site_frontend_changed = (scope == 'site' and (
            payload.get('frontend_hash') != live.get('frontend_hash') or
            (state.get('verified_frontend_hash') and
             state['verified_frontend_hash'] != payload.get('frontend_hash'))))
        if site_frontend_changed:
            verify_kwargs = {'verify_slugs': None, 'verify_image_slugs': set()}
        # Shared-route changes may live ONLY in Worker JS and leave the static
        # registry hash unchanged, so a site-only request must always deploy.
        if scope == 'comic' and reader.canonical(live) == reader.canonical(payload):
            try:
                reader._verify_published(url,stage,registry, **verify_kwargs)
            except reader.PublishedAssetsStale:
                print('open-reader: targeted assets stale; redeploying.',flush=True)
            else:
                if scope == 'comic':
                    registry['verified_frontend_hash'] = frontend_hash
                reader.save_state(engine,registry)
                reader._checkpoint_shared_registry(engine,db,owner,token,registry,
                                                   known_sha,{reader.WORKER_NAME})
                if scope == 'comic':
                    _checkpoint_current(db,engine,registry,current_slug)
                    _target_readmes(engine,owner,token,registry,current_slug)
                print('open-reader: focused assets already live; no upload.',flush=True)
                return url
        reader._assert_no_unowned_existing_worker(engine,registry)
        print('open-reader: publishing complete assets; verifying '+
              ('current comic plus shared routes' if scope == 'comic' else 'shared routes only') +
              '. Older comics preserved from live registry.',flush=True)
        deployed = reader._deploy(engine,stage,registry)
        reader._verify_published(deployed,stage,registry, **verify_kwargs)
        registry['worker_url']=deployed
        if scope == 'comic':
            registry['verified_frontend_hash'] = frontend_hash
        elif site_frontend_changed:
            registry['verified_frontend_hash'] = payload['frontend_hash']
        elif (state.get('verified_frontend_hash') and
              state['verified_frontend_hash'] == payload.get('frontend_hash')):
            # Site-only verification does not verify every comic route; retain
            # an existing matching fingerprint but never claim a new one.
            registry['verified_frontend_hash'] = state['verified_frontend_hash']
        reader.save_state(engine,registry)
        reader._checkpoint_shared_registry(engine,db,owner,token,registry,
                                           known_sha,{reader.WORKER_NAME})
        if scope == 'comic':
            _checkpoint_current(db,engine,registry,current_slug)
            _target_readmes(engine,owner,token,registry,current_slug)
        print('open-reader: '+scope+' update verified; '
              + ('all frontend routes checked; ' if shared_frontend_changed or site_frontend_changed else '')
              + 'old comic images not resampled.',flush=True)
        return deployed
