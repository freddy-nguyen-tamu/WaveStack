"""Pre-publish GitHub image volumes missing a verified shared-reader asset host.

This is reusable infrastructure. Source URL selectors/identities remain exclusively
in site_specific/site_adapter.py. No source-site requests or original images are
modified. Existing shared Worker source code and prior comics are left alone.
"""
from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path

import requests


def _validated_repositories(engine, db):
    rows = engine._reader_archive_rows(db)
    grouped = {}
    for row in rows:
        repo = row['repository']
        if not repo or not row['pages_json']:
            raise RuntimeError('Archive row has no GitHub repo/manifest: ' + str(row['chapter_id']))
        m = json.loads(row['pages_json'])
        imgs, files = m.get('images'), m.get('remote_files')
        if not isinstance(imgs, list) or not imgs or not isinstance(files, list) or len(files) != len(imgs):
            raise RuntimeError('Invalid GitHub image manifest for chapter ' + str(row['chapter_id']))
        if any(not isinstance(x, dict) or not isinstance(x.get('sha256'), str) or len(x['sha256']) != 64 for x in imgs):
            raise RuntimeError('Unverified image entry in chapter ' + str(row['chapter_id']))
        grouped.setdefault(repo, []).append(row)
    return grouped


def _first_last_checks(engine, url, rows):
    if not url or not url.startswith('https://'):
        return False
    try:
        for row, index in ((rows[0], 0), (rows[-1], -1)):
            m = json.loads(row['pages_json'])
            engine.verify_cloudflare_asset(
                url.rstrip('/') + '/' + m['remote_files'][index],
                expected_sha256=m['images'][index]['sha256'], attempts=2)
        return True
    except (RuntimeError, ValueError, IndexError, KeyError, requests.RequestException) as exc:
        engine.event('SHARED_READER_VOLUME_VERIFICATION_RETRY_REQUIRED',
                     volume=rows[0]['repository'], reason=str(exc)[-500:])
        return False


def ensure_current_image_hosts(engine, db):
    """Make current comic's already-archived image volumes available to its Worker.

    GitHub archive is source of truth; Pages is a verifiable image-only cache.
    A missing/incomplete source chapter never becomes published by this call.
    """
    groups = _validated_repositories(engine, db)
    if not groups:
        return {}
    volume_hosts = {}
    account_selected = False
    owner = None
    for repo, rows in groups.items():
        project = repo[:58]
        fp = engine._volume_fingerprint(rows)
        prior = db.execute('SELECT product,production_url FROM deployments WHERE project=?',
                           (project,)).fetchone()
        if (prior and prior[0] in ('pages', 'workers') and prior[1] and
                engine.get_option(db, f'deployed_volume_fingerprint:{prior[0]}:{project}') == fp and
                _first_last_checks(engine, prior[1], rows)):
            volume_hosts[repo] = prior[1]
            engine.event('SHARED_READER_VOLUME_REUSED', project=project, url=prior[1],
                         archived_chapters=len(rows), source_requests=0)
            continue
        expected_files = sum(len(json.loads(row['pages_json'])['images']) for row in rows)
        if expected_files > engine.CONFIG['cloudflare_project_max_files']:
            raise RuntimeError(f'{repo}: {expected_files} assets exceeds the Pages project limit; '
                               'refusing partial publication')
        if not account_selected:
            engine.select_cloudflare_account()
            owner, _ = engine.credential_for_selected(db)
            account_selected = True
        engine.event('SHARED_READER_MISSING_VOLUME_HOST', volume=repo,
                     project=project, archived_chapters=len(rows), files=expected_files,
                     source_requests=0)
        print(f'open-reader: preparing verified image host for {repo} '
              f'({len(rows)} archived chapters, {expected_files} images; no source recrawl)', flush=True)
        with tempfile.TemporaryDirectory(prefix='comic-open-reader-missing-host-') as folder:
            target = Path(folder)
            copied = engine._fetch_verified_files(db, rows, target, owner)
            if len(copied) != expected_files or any(f.stat().st_size > engine.PAGES_LIMIT for f, _, _ in copied):
                raise RuntimeError('GitHub image volume staging incomplete or asset too large')
            url = engine.deploy_cloudflare_assets(db, project, target, mode='pages')
            if not _first_last_checks(engine, url, rows):
                raise RuntimeError('New Cloudflare Pages image volume failed SHA-256 verification: ' + repo)
            with db:
                db.execute('REPLACE INTO deployments(project,product,production_url,deployed_at,files,bytes) '
                           'VALUES(?,?,?,?,?,?)',
                           (project, 'pages', url, engine.utc(), len(copied),
                            sum(f.stat().st_size for f, _, _ in copied)))
            engine.set_option(db, f'deployed_volume_fingerprint:pages:{project}', fp)
            volume_hosts[repo] = url
            engine.event('SHARED_READER_VOLUME_PUBLISHED', project=project, url=url,
                         images=len(copied), archived_chapters=len(rows), source_requests=0)
    return volume_hosts


def verify_current_in_shared_reader(engine, db, url):
    """Fail closed if the shared publisher silently omits the active comic.

    Validation uses the *deployed* per-comic manifest, not its local cache.
    Confirmed server-missing chapters are excluded from expected published IDs.
    """
    rows = engine._reader_archive_rows(db)
    if not rows:
        return True
    slug = engine.get_option(db, 'series_slug')
    if not slug:
        raise RuntimeError('Cannot verify active comic: series slug is missing')
    if not isinstance(url, str) or not url.startswith('https://'):
        raise RuntimeError('Shared publisher did not return a verified Worker URL')
    target = url.rstrip('/') + '/comics/' + slug + '/manifest.json'
    try:
        response = requests.get(target, timeout=35)
        response.raise_for_status()
        manifest = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError('Shared open-reader omitted current comic or its manifest: ' + target) from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get('chapters'), list):
        raise RuntimeError('Active comic manifest has no chapter catalog: ' + target)
    found = {str(item.get('id')) for item in manifest['chapters'] if isinstance(item, dict)}
    expected = {str(row['chapter_id']) for row in rows}
    missing = expected - found
    if missing:
        raise RuntimeError(f'Shared open-reader omitted {len(missing)} GitHub-verified chapters '
                           f'from {slug}: {sorted(missing)[:12]}. '
                           'Existing archives are intact; deployment is not considered complete.')
    engine.event('SHARED_READER_CURRENT_COMIC_VERIFIED', slug=slug, url=target,
                 verified_chapters=len(expected), confirmed_server_failures_excluded=True)
    print(f'open-reader: verified {slug} ({len(expected)} archived chapters) in the shared Worker',
          flush=True)
    return True
