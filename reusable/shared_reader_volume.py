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

from . import open_reader_verify_auth


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


def _verify_volume_state(engine, url, rows, *, attempts=2):
    """Check real public bytes; distinguish transient hosting faults from bad data.

    An HTTP 522 is not evidence of a corrupt asset. Do not upload a complete
    GitHub volume again solely because its existing Cloudflare hostname is
    temporarily unreachable. A deployment is trusted ONLY after SHA-256 checks.
    """
    if not isinstance(url, str) or not url.startswith('https://'):
        return 'invalid', 'Missing trusted HTTPS Pages project URL'
    try:
        for row, index in ((rows[0], 0), (rows[-1], -1)):
            manifest = json.loads(row['pages_json'])
            engine.verify_cloudflare_asset(
                url.rstrip('/') + '/' + manifest['remote_files'][index],
                expected_sha256=manifest['images'][index]['sha256'],
                attempts=attempts)
        return 'verified', ''
    except (RuntimeError, ValueError, IndexError, KeyError,
            requests.RequestException) as exc:
        import re
        reason = str(exc)[-500:]
        engine.event('SHARED_READER_VOLUME_VERIFICATION_RETRY_REQUIRED',
                     volume=rows[0]['repository'], reason=reason)
        transient = bool(re.search(
            r'\b(?:HTTP\s+(?:408|425|429|5\d\d)|timed?\s*out|timeout|'
            r'connection\s+(?:reset|aborted|error)|temporarily|'
            r'network\s+(?:error|unreachable))\b', reason, re.I))
        return ('transient' if transient else 'invalid'), reason


def _first_last_checks(engine, url, rows):
    """Backward-compatible boolean verification used by older callers."""
    return _verify_volume_state(engine, url, rows)[0] == 'verified'


def _owned_project_creation_logged(engine, project):
    """Only auto-adopt a Pages project that this installation created itself.

    Existing unowned projects still go through the previous explicit-confirmation
    behavior; matching a generic project name is never sufficient ownership.
    """
    log_path = getattr(engine, 'DATA', None)
    if log_path is None:
        return False
    log_path = Path(log_path) / 'events.jsonl'
    try:
        with log_path.open('r', encoding='utf-8') as stream:
            for line in stream:
                if 'CLOUDFLARE_PAGES_PROJECT_CREATED' not in line:
                    continue
                try:
                    event_record = json.loads(line)
                except ValueError:
                    continue
                if (event_record.get('event') == 'CLOUDFLARE_PAGES_PROJECT_CREATED'
                        and event_record.get('project') == project):
                    return True
    except (FileNotFoundError, PermissionError, OSError):
        return False
    return False


def _checkpoint_verified_host(engine, db, project, url, rows, fingerprint,
                              *, files=None, byte_count=None):
    """Only called AFTER independently checking the live first/last file hashes."""
    if files is None:
        files = sum(len(json.loads(r['pages_json'])['images']) for r in rows)
    if byte_count is None:
        byte_count = sum(int(im.get('bytes') or 0) for r in rows
                         for im in json.loads(r['pages_json'])['images'])
    with db:
        db.execute('REPLACE INTO deployments(project,product,production_url,deployed_at,files,bytes) '
                   'VALUES(?,?,?,?,?,?)',
                   (project, 'pages', url, engine.utc(), files, byte_count))
    engine.set_option(db, f'deployed_volume_fingerprint:pages:{project}', fingerprint)
    # A completed public verification supersedes any upload awaiting verification.
    with db:
        db.execute('DELETE FROM options WHERE key=?',
                   (f'pending_shared_volume_upload:pages:{project}',))


def ensure_current_image_hosts(engine, db):
    """Make GitHub-verified archives available to the shared Worker without recrawling.

    Cloudflare's accepted upload and its public SHA-256 verification are separate
    durable stages. Retrying a failed public probe must never redownload/reupload
    hundreds of MiB merely because a Pages hostname returned HTTP 522.
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
        pending_key = f'pending_shared_volume_upload:pages:{project}'
        prior = db.execute('SELECT product,production_url FROM deployments WHERE project=?',
                           (project,)).fetchone()
        # Original verified-deployment reuse remains the first and cheapest path.
        if (prior and prior[0] in ('pages', 'workers') and prior[1] and
                engine.get_option(db, f'deployed_volume_fingerprint:{prior[0]}:{project}') == fp):
            state, reason = _verify_volume_state(engine, prior[1], rows)
            if state == 'verified':
                volume_hosts[repo] = prior[1]
                engine.event('SHARED_READER_VOLUME_REUSED', project=project, url=prior[1],
                             archived_chapters=len(rows), source_requests=0)
                continue
            if state == 'transient':
                engine.event('SHARED_READER_VOLUME_PUBLIC_HOST_TEMPORARY_FAILURE',
                             project=project, url=prior[1], reason=reason,
                             github_downloads=0, cloudflare_uploads=0)
                raise RuntimeError('Previously verified Cloudflare Pages host is temporarily '
                                   'unavailable; no reupload attempted: ' + project + ': ' + reason)
            # An actual mismatch keeps the original repair flow rather than
            # treating the remote content as verified.

        # This checkpoint is written immediately after Wrangler says the upload
        # succeeded, BEFORE its public URL has necessarily warmed up.
        pending = engine.get_option(db, pending_key)
        if (isinstance(pending, dict) and pending.get('fingerprint') == fp
                and isinstance(pending.get('url'), str)
                and pending['url'].startswith('https://')):
            state, reason = _verify_volume_state(engine, pending['url'], rows, attempts=4)
            if state == 'verified':
                _checkpoint_verified_host(engine, db, project, pending['url'], rows, fp,
                                          files=pending.get('files'),
                                          byte_count=pending.get('bytes'))
                volume_hosts[repo] = pending['url']
                engine.event('SHARED_READER_PENDING_UPLOAD_VERIFIED',
                             project=project, url=pending['url'],
                             github_downloads=0, cloudflare_uploads=0)
                continue
            engine.event('SHARED_READER_PENDING_UPLOAD_AWAITING_VERIFICATION',
                         project=project, url=pending['url'], reason=reason,
                         github_downloads=0, cloudflare_uploads=0)
            raise RuntimeError('Cloudflare already accepted this volume upload, but its '
                               'public images are not SHA-256 verified yet; no GitHub '
                               're-download or Cloudflare reupload was attempted. '
                               'Rerun python run.py --deploy --authorized later. '
                               'Volume: ' + project + '; reason: ' + reason)

        expected_files = sum(len(json.loads(row['pages_json'])['images']) for row in rows)
        if expected_files > engine.CONFIG['cloudflare_project_max_files']:
            raise RuntimeError(f'{repo}: {expected_files} assets exceeds the Pages project limit; '
                               'refusing partial publication')
        if not account_selected:
            engine.select_cloudflare_account()
            owner, _ = engine.credential_for_selected(db)
            account_selected = True

        # Previous versions lost the successful-upload checkpoint. Recover an
        # existing, installation-created Pages project by checking its actual
        # published bytes BEFORE rebuilding anything from GitHub. An unknown
        # pre-existing project does not qualify for silent adoption.
        if not prior and _owned_project_creation_logged(engine, project):
            existing = next((p for p in engine.list_pages_projects()
                             if p.get('name') == project), None)
            if existing:
                existing_url = engine.cloudflare_pages_url(existing)
                state, reason = _verify_volume_state(engine, existing_url, rows, attempts=4)
                if state == 'verified':
                    _checkpoint_verified_host(engine, db, project, existing_url, rows, fp)
                    volume_hosts[repo] = existing_url
                    engine.event('SHARED_READER_PREVIOUS_UPLOAD_ADOPTED',
                                 project=project, url=existing_url,
                                 github_downloads=0, cloudflare_uploads=0)
                    continue
                if state == 'transient':
                    engine.event('SHARED_READER_EXISTING_UPLOAD_WAITING',
                                 project=project, url=existing_url, reason=reason,
                                 github_downloads=0, cloudflare_uploads=0)
                    raise RuntimeError('Cloudflare Pages project exists but its public URL '
                                       'temporarily fails; preserving it without reupload. '
                                       'Rerun python run.py --deploy --authorized later. '
                                       'Volume: ' + project + '; reason: ' + reason)
                # If the contents are definitely incorrect, keep the earlier
                # explicit Pages project ownership/repair safeguards.

        engine.event('SHARED_READER_MISSING_VOLUME_HOST', volume=repo,
                     project=project, archived_chapters=len(rows), files=expected_files,
                     source_requests=0)
        print(f'open-reader: preparing verified image host for {repo} '
              f'({len(rows)} archived chapters, {expected_files} images; no source recrawl)',
              flush=True)
        with tempfile.TemporaryDirectory(prefix='comic-open-reader-missing-host-') as folder:
            target = Path(folder)
            copied = engine._fetch_verified_files(db, rows, target, owner)
            if len(copied) != expected_files or any(f.stat().st_size > engine.PAGES_LIMIT for f, _, _ in copied):
                raise RuntimeError('GitHub image volume staging incomplete or asset too large')
            url = engine.deploy_cloudflare_assets(db, project, target, mode='pages')
            staged_bytes = sum(f.stat().st_size for f, _, _ in copied)
            # Persist successful upload BEFORE contacting the public Pages URL.
            # This is deliberately NOT a verified deployment record.
            engine.set_option(db, pending_key,
                              {'fingerprint': fp, 'url': url, 'files': len(copied),
                               'bytes': staged_bytes})
            engine.event('SHARED_READER_UPLOAD_PENDING_PUBLIC_VERIFICATION',
                         project=project, url=url, files=len(copied), bytes=staged_bytes)
            state, reason = _verify_volume_state(engine, url, rows, attempts=4)
            if state != 'verified':
                engine.event('SHARED_READER_UPLOAD_AWAITING_VERIFICATION',
                             project=project, url=url, reason=reason,
                             github_redownload_on_resume=False,
                             cloudflare_reupload_on_resume=False)
                raise RuntimeError('Cloudflare upload succeeded, but public image verification '
                                   'has not succeeded: ' + project + '. Retained an upload '
                                   'checkpoint; rerun python run.py --deploy --authorized '
                                   'without rebuilding this volume. Reason: ' + reason)
            _checkpoint_verified_host(engine, db, project, url, rows, fp,
                                      files=len(copied), byte_count=staged_bytes)
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
    if (not isinstance(url, str) or
            open_reader_verify_auth._safe_origin(url) != url.rstrip('/')):
        raise RuntimeError('Shared publisher did not return a verified Worker URL')
    import re
    if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', slug):
        raise RuntimeError('Cannot verify active comic: invalid series slug')
    target = url.rstrip('/') + '/comics/' + slug + '/manifest.json'
    try:
        response = open_reader_verify_auth.get(target, timeout=35,
                                               headers={'Cache-Control': 'no-cache'})
        if response.status_code != 200:
            raise RuntimeError(f'Shared reader final manifest verification failed: HTTP {response.status_code} at {target}; publication checkpoint retained')
        manifest = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError('Cannot inspect shared reader final manifest: ' + target +
                           '; publication checkpoint retained') from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get('chapters'), list):
        raise RuntimeError('Active comic manifest has no chapter catalog: ' + target)
    ids = [str(item['id']) for item in manifest['chapters']
           if isinstance(item, dict) and item.get('id') is not None]
    if len(ids) != len(manifest['chapters']) or len(ids) != len(set(ids)):
        raise RuntimeError('Active comic manifest has missing or duplicate chapter IDs: ' + target)
    found = set(ids)
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
