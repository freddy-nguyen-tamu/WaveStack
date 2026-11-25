"""Reusable metadata-only native chapter title reconciliation.

Scans at most ONE source chapter-list page, without lazy scrolling or downloading
any image bytes. The single site adapter decides how to extract native titles.
Already-archived images remain untouched; GitHub title changes update only
chapter manifest blobs, followed by an updated Cloudflare reader manifest.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import requests

from .title_maintenance import update_manifest_titles, candidate_title


def adapter_revision(adapter):
    return hashlib.sha256(Path(adapter.__file__).read_bytes()).hexdigest()[:20]


def extract_title_map(adapter, raw_html, page_url):
    hook = getattr(adapter, 'native_chapter_titles_from_catalog', None)
    if not callable(hook):
        return {}
    try:
        mapping = hook(raw_html, page_url)
    except Exception:
        return {}
    return validate_title_map(adapter, mapping)


def validate_title_map(adapter, mapping):
    if not isinstance(mapping, dict):
        return {}
    validator = getattr(adapter, 'accept_catalog_title', None)
    result = {}
    for ident, text in mapping.items():
        ident = str(ident)
        name = candidate_title(text)
        try:
            valid = not callable(validator) or validator(ident, name or '')
        except Exception:
            valid = False
        if name and valid:
            result[ident] = name
    return result


def captured_catalog(adapter, emit):
    """Use only an adapter's explicitly captured native metadata, never a guessed label."""
    hook = getattr(adapter, 'captured_native_chapter_titles', None)
    if not callable(hook):
        return {}
    try:
        mapping = validate_title_map(adapter, hook())
    except Exception as exc:
        emit('TITLE_CAPTURE_SKIPPED', reason=type(exc).__name__)
        return {}
    if mapping:
        emit('TITLE_CATALOG_CAPTURE_REUSED', native_chapters=len(mapping),
             images_downloaded=0, chapter_scrolls=0)
    return mapping


def fetch_catalog(adapter, source_url, *, request_get=None, saved_html=None, emit=None):
    """Use existing HTML when supplied; otherwise one paced public metadata GET."""
    emit = emit or (lambda *a, **k: None)
    if saved_html:
        mapping = extract_title_map(adapter, saved_html, source_url)
        emit('TITLE_CATALOG_LOCAL_SCAN', found=len(mapping), images_downloaded=0)
        return mapping or captured_catalog(adapter, emit)
    source_url = str(source_url or getattr(adapter, 'DEFAULT_START_URL', '') or '')
    url_fn = getattr(adapter, 'title_catalog_url', None)
    if callable(url_fn):
        source_url = str(url_fn(source_url) or '')
    parts = urlsplit(source_url)
    allowed = {str(x).lower() for x in getattr(adapter, 'ALLOWED_HOSTS', ())}
    if parts.scheme != 'https' or not parts.hostname or parts.hostname.lower() not in allowed:
        emit('TITLE_CATALOG_SKIPPED', reason='source_not_whitelisted')
        return {}
    try:
        getter = request_get or requests.get
        response = getter(source_url, timeout=25, allow_redirects=False,
                          headers={'Accept': 'text/html', 'User-Agent': 'AuthorizedComicMetadata/1.0'})
        if response.status_code != 200 or 'html' not in response.headers.get('Content-Type', 'text/html').lower():
            emit('TITLE_CATALOG_SKIPPED', reason=f'http_{response.status_code}')
            return captured_catalog(adapter, emit)
        mapping = extract_title_map(adapter, response.text, source_url)
        emit('TITLE_CATALOG_CHECKED', native_chapters=len(mapping), images_downloaded=0, chapter_scrolls=0)
        return mapping or captured_catalog(adapter, emit)
    except (requests.RequestException, OSError, ValueError) as exc:
        emit('TITLE_CATALOG_SKIPPED', reason=type(exc).__name__)
        return captured_catalog(adapter, emit)


def reconcile_native_titles(db, adapter, *, get_option, set_option, event,
                            isolated_git_environment, paced_push,
                            source_url=None, source_html=None, force=False):
    """Check ALL archived chapter titles, even those already PUBLISHED_VERIFIED.

    Runs at most once per adapter revision unless explicitly forced. Remote Git
    metadata is written transactionally with separate verification. If native
    title extraction fails, SKIP without changing archive/upload state.
    """
    marker = 'native_title_catalog_audited_revision'
    revision = adapter_revision(adapter)
    if not force and get_option(db, marker) == revision:
        return {'checked': 0, 'changed': 0, 'skipped': 0, 'already_checked': True}
    rows = db.execute('SELECT chapter_id,label,repository,pages_json,status FROM chapters ORDER BY ordinal').fetchall()
    prepared = []
    for ident,label,repo,pages_json,status in rows:
        if not repo or not pages_json or status not in {
            'ARCHIVED_VERIFIED','LOCAL_FILES_DELETED','ARCHIVED_PENDING_DEPLOYMENT','PUBLISHED_VERIFIED'
        }:
            continue
        try:
            obj = json.loads(pages_json)
        except (ValueError, TypeError):
            continue
        if obj.get('images') and obj.get('remote_files'):
            prepared.append((str(ident), label, repo, obj))
    if not prepared:
        return {'checked': 0, 'changed': 0, 'skipped': 0, 'already_checked': False}
    catalog = fetch_catalog(adapter, source_url, saved_html=source_html, emit=event)
    changes_by_repo = {}
    skipped = []
    identical = 0
    for ident,label,repo,obj in prepared:
        native = catalog.get(ident)
        if native is None:
            skipped.append(ident)
            continue
        current = str(obj.get('chapter_title') or obj.get('label') or label or '').strip()
        if (current == native and str(obj.get('label') or '').strip() == native
                and str(label or '').strip() == native):
            identical += 1
            continue
        changes_by_repo.setdefault(repo, {})[ident] = (obj, native, 'source_native_catalog')
    changed = 0
    planned = sum(len(updates) for updates in changes_by_repo.values())
    event('TITLE_METADATA_PLAN', repositories=len(changes_by_repo),
          chapters_to_update=planned, already_correct=identical, unavailable=len(skipped))
    print(f'Title repair: {planned} chapter manifests across {len(changes_by_repo)} repositories; '
          f'{identical} already correct. No image downloads.', flush=True)
    for index, (repo, updates) in enumerate(sorted(changes_by_repo.items()), 1):
        print(f'Title repair repository {index}/{len(changes_by_repo)}: {repo} ({len(updates)} chapters)', flush=True)
        owner = get_option(db, 'github_owner')
        if not owner:
            event('TITLE_BACKFILL_SKIPPED', reason='no_selected_github_account', repo=repo)
            skipped.extend(updates.keys())
            continue
        environment = isolated_git_environment()
        environment['GCM_NAMESPACE'] = get_option(db, 'github_credential_namespace') or 'comic-archiver-unauthorized'
        new_sha, final_manifests = update_manifest_titles(repo, owner, updates, environment,
                                                          pace=lambda r: paced_push(db, r))
        if not final_manifests:
            continue
        with db:
            # A Git commit updates the tip for ALL chapters in the volume,
            # not just chapters whose title changed.
            if new_sha:
                db.execute('UPDATE chapters SET commit_sha=? WHERE repository=?',(new_sha,repo))
                db.execute('UPDATE repositories SET last_sha=? WHERE name=?',(new_sha,repo))
            for ident,manifest in final_manifests.items():
                db.execute('UPDATE chapters SET label=?,pages_json=? WHERE chapter_id=?',
                           (manifest.get('chapter_title') or manifest.get('label') or ident,
                            json.dumps(manifest,ensure_ascii=False), ident))
        changed += len(updates)
        event('TITLE_METADATA_VERIFIED', repo=repo, updated_chapters=len(updates),
              git_commit=new_sha, image_objects_modified=0, images_redownloaded=0)
    # Do not mark an incomplete capture-backed repair as complete. Ordinary
    # optional adapters retain their previous once-per-revision behavior.
    if not skipped or not callable(getattr(adapter, 'captured_native_chapter_titles', None)):
        set_option(db, marker, revision)
    event('TITLE_CATALOG_RECONCILED', checked=len(prepared), changed=changed,
          already_correct=identical, skipped=len(skipped), source_scrolls=0,
          images_redownloaded=0, completed_chapters_untouched=True)
    print(f'Chapter titles: checked {len(prepared)}, updated {changed}, unchanged {identical}, '
          f'unavailable {len(skipped)}. No chapter images downloaded.', flush=True)
    return {'checked': len(prepared), 'changed': changed, 'skipped': len(skipped),
            'already_checked': False}
