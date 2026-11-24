"""Publish ONLY byte-verified partial chapter checkpoints to GitHub.

An incomplete source chapter is never made into a verified archive. Its saved
panels are isolated under private open-reader/partial/, independently verified
by the Git blob checksum, and exposed solely through the Worker image proxy.
No source request, Cloudflare image upload, or archive-state rewrite occurs.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import quote

from PIL import Image

from reusable import github_streaming
from reusable.reader_issue_feed import build_issue_feed

SAFE_ID = re.compile(r'^[A-Za-z0-9_.-]{1,160}$')
SAFE_SLUG = re.compile(r'^[a-z0-9-]{1,100}$')
SHA = re.compile(r'^[a-f0-9]{64}$')
EXTENSIONS = {'JPEG': ('jpg', 'image/jpeg'), 'PNG': ('png', 'image/png'),
              'WEBP': ('webp', 'image/webp'), 'GIF': ('gif', 'image/gif')}
MAX_PANEL_BYTES = 25 * 1024 * 1024


def _scope_for(root, slug):
    base = Path(root) / '.archiver_state'
    candidates = ([base] if (base / 'state.sqlite').is_file() else [])
    candidates += sorted(p for p in (base / 'sites').iterdir() if (p / 'state.sqlite').is_file()) if (base / 'sites').is_dir() else []
    found = []
    for scope in candidates:
        try:
            with closing(sqlite3.connect(f'file:{(scope / "state.sqlite").as_posix()}?mode=ro', uri=True)) as con:
                row = con.execute('SELECT value FROM options WHERE key=?', ('series_slug',)).fetchone()
                recorded = json.loads(row[0]) if row else ''
            if recorded == slug:
                found.append(scope)
        except (sqlite3.DatabaseError, ValueError, TypeError):
            continue
    if len(found) > 1:
        raise RuntimeError('Ambiguous local source checkpoint scope for ' + slug)
    return found[0] if found else None


def _checked_checkpoint(scope, slug, chapter):
    import os
    folder = scope / 'temporary_downloads' / re.sub(r'[^a-z0-9]+','-',chapter.casefold()).strip('-')[:45].rstrip('-')
    point = folder / '.image-checkpoint.json'
    if not point.is_file():
        return 0, False, {}
    try:
        disk = json.loads(point.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, ValueError):
        return 0, False, {}
    if disk.get('version') != 1 or disk.get('chapter_id') != chapter or not isinstance(disk.get('images'), dict):
        return 0, False, {}
    catalog = disk.get('catalog')
    count_confirmed = isinstance(catalog, list) and 0 < len(catalog) <= 2000
    total = len(catalog) if count_confirmed else 0
    saved = {}
    for key, record in disk['images'].items():
        if not isinstance(record, dict) or record.get('key') != str(key) or not isinstance(record.get('meta'), dict):
            continue
        ordinal = record.get('order')
        if not isinstance(ordinal, int) or ordinal<1 or ordinal>2000:
            continue
        filename = record.get('filename')
        if not isinstance(filename,str) or not re.fullmatch(r'\d{4,}\.(?:jpg|jpeg|png|webp|gif|avif|bmp)', filename, re.I):
            continue
        if Path(filename).stem != f'{ordinal:04d}':
            continue
        path = folder / filename
        if path.is_symlink() or not path.is_file() or path.parent.resolve()!=folder.resolve():
            continue
        meta = record['meta']
        if (not SHA.fullmatch(str(meta.get('sha256',''))) or
                meta.get('source_url') != record.get('url')):
            continue
        try:
            raw = path.read_bytes()
            if len(raw)!=meta.get('bytes') or hashlib.sha256(raw).hexdigest()!=meta['sha256']:
                continue
            with Image.open(io.BytesIO(raw)) as img:
                if img.size != (meta.get('width'),meta.get('height')):
                    continue
                image_format = (img.format or '').upper()
                if image_format not in EXTENSIONS:
                    # Convert a supported decoded panel losslessly to PNG.
                    img.load()
                    converted=io.BytesIO()
                    img.save(converted,format='PNG')
                    raw=converted.getvalue()
                    image_format='PNG'
                else:
                    img.verify()
            if not (32 <= len(raw) <= MAX_PANEL_BYTES):
                continue
        except (OSError, ValueError, SyntaxError, TypeError):
            continue
        ext, mime = EXTENSIONS[image_format]
        saved[ordinal] = {'bytes':raw, 'sha256':hashlib.sha256(raw).hexdigest(),
                          'width':int(meta['width']), 'height':int(meta['height']),
                          'ext':ext, 'content_type':mime}
        total = max(total,ordinal)
    return total, count_confirmed, saved


def _git_blob_sha(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode('ascii') + b'\0' + raw).hexdigest()


def _github_put_verified(engine, owner, token, path, raw):
    target = f'{engine.GITHUB_API}/repos/{owner}/open-reader/contents/' + '/'.join(quote(p, safe='') for p in path.split('/'))
    expected_sha = _git_blob_sha(raw)
    def inspect():
        response = engine.github_http('GET', target + '?ref=main', token)
        if response.status_code == 200:
            data = response.json()
            if data.get('type') != 'file' or data.get('sha') != expected_sha:
                raise RuntimeError('Private GitHub partial path conflicts with different content: '+path)
            return True
        if response.status_code == 404:
            return False
        raise RuntimeError(f'Cannot verify private GitHub checkpoint file (HTTP {response.status_code}): {path}')
    if inspect():
        return
    response=engine.github_http('PUT',target,token,json={
        'message':'Add verified incomplete-chapter panel (not an archive completion)',
        'branch':'main', 'content':base64.b64encode(raw).decode('ascii')})
    if response.status_code not in (200,201,409,422):
        raise RuntimeError(f'GitHub refused checkpoint image (HTTP {response.status_code}): {path}')
    # A concurrent write is accepted only if the remote Git blob exactly matches.
    if not inspect():
        raise RuntimeError('GitHub partial panel upload did not become visible: '+path)



# Keep this remote recovery generic: a verified incomplete panel must survive
# deletion/rotation of its LOCAL checkpoint. The private GitHub copy is immutable.
_REMOTE_PARTIAL_NAME = re.compile(r'^([0-9]{4,})-([a-f0-9]{64})\.(jpg|png|webp|gif)$')


def _recover_remote_partial(engine, owner, token, slug, chapter, missing, local_saved):
    """Recover already-verified private-GitHub partial pixels without source visits.

    A directory listing is only a locator. Every recovered entry is downloaded
    from the exact private repo and independently checked against Git blob SHA,
    the SHA-256 embedded in its immutable filename, and decoded image format.
    Local validated checkpoint bytes take precedence when they still exist.
    Ambiguity or unreadable remote bytes aborts publication; we never replace
    verified partial panels with placeholders on an uncertain remote read.
    """
    base = f'{engine.GITHUB_API}/repos/{owner}/open-reader/contents/'
    prefix = f'partial/{slug}/{chapter}/'
    directory = base + '/'.join(quote(p, safe='') for p in prefix.rstrip('/').split('/'))
    response = engine.github_http('GET', directory + '?ref=main', token)
    if response.status_code == 404:
        return {}
    if response.status_code != 200:
        raise RuntimeError(f'Cannot reconcile private GitHub partial panels for {slug}/{chapter} '
                           f'(HTTP {response.status_code}); refusing to publish placeholders')
    entries = response.json()
    if not isinstance(entries, list) or len(entries) >= 1000:
        raise RuntimeError(f'Invalid/oversized GitHub partial directory for {slug}/{chapter}; '
                           'refusing to replace previously verified partial panels')
    candidates = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError('Malformed GitHub partial-directory record')
        name = str(entry.get('name', ''))
        m = _REMOTE_PARTIAL_NAME.fullmatch(name)
        if not m:
            continue   # unrelated files in a GitHub directory are not panels
        ordinal = int(m[1])
        if ordinal < 1 or ordinal > 2000 or name != f'{ordinal:04d}-{m[2]}.{m[3]}':
            raise RuntimeError('Unsafe GitHub partial-panel ordinal: ' + name)
        path = prefix + name
        if (entry.get('type') != 'file' or entry.get('path') != path or
                not re.fullmatch(r'[a-f0-9]{40}', str(entry.get('sha', ''))) or
                not isinstance(entry.get('size'), int) or
                not 32 <= entry['size'] <= MAX_PANEL_BYTES):
            raise RuntimeError('Unverifiable GitHub partial-panel metadata: ' + path)
        if ordinal in missing:
            raise RuntimeError('Remote partial image conflicts with confirmed missing panel: ' + path)
        if ordinal in local_saved:
            # This file is already validated locally; the original write path
            # below still checks its exact remote SHA or uploads if absent.
            continue
        candidates.setdefault(ordinal, []).append((path, m[2], m[3], entry))
    recovered = {}
    for ordinal, files in sorted(candidates.items()):
        if len(files) != 1:
            raise RuntimeError(f'Ambiguous immutable versions of partial panel {slug}/{chapter}/{ordinal}; '
                               'refusing to choose incorrect pixels')
        path, expected_hash, expected_ext, meta = files[0]
        url = base + '/'.join(quote(p, safe='') for p in path.split('/'))
        result = engine.github_http('GET', url + '?ref=main', token,
                                    headers={'Accept': 'application/vnd.github.raw+json'})
        if result.status_code != 200:
            raise RuntimeError(f'GitHub partial image unavailable (HTTP {result.status_code}): {path}')
        raw = result.content
        if not isinstance(raw, bytes) or len(raw) != meta['size'] or not 32 <= len(raw) <= MAX_PANEL_BYTES:
            raise RuntimeError('GitHub partial image length mismatch: ' + path)
        if hashlib.sha256(raw).hexdigest() != expected_hash or _git_blob_sha(raw) != meta['sha']:
            raise RuntimeError('GitHub partial image hash mismatch: ' + path)
        try:
            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
                fmt = (image.format or '').upper()
                if fmt not in EXTENSIONS or EXTENSIONS[fmt][0] != expected_ext:
                    raise ValueError('unexpected image encoding')
                if width < 1 or height < 1 or width * height > 100_000_000:
                    raise ValueError('unsafe decoded image dimensions')
                image.verify()
        except (OSError, SyntaxError, TypeError, ValueError) as exc:
            raise RuntimeError('Undecodable GitHub partial panel: ' + path) from exc
        recovered[ordinal] = {
            'url': github_streaming.route(slug, chapter, ordinal, expected_hash),
            'width': width, 'height': height, 'sha256': expected_hash,
            'github': {'repo': 'open-reader', 'path': path},
        }
    return recovered


def publish_partial_checkpoints(root, engine, owner, token):
    """Return only panels independently verified on private GitHub.

    A pre-existing missing-image issue is required; no synthetic orphan chapters.
    Caller invokes this only after the one-time streaming setup is enabled.
    """
    if not github_streaming.load_mode(root):
        return {}
    feed = build_issue_feed(Path(root))
    groups = {}
    for case in feed.get('cases', []):
        if (case.get('status') != 'source_server_unavailable' or
                not SAFE_SLUG.fullmatch(str(case.get('work_slug',''))) or
                not SAFE_ID.fullmatch(str(case.get('episode_id','')))):
            continue
        pair=(case['work_slug'],case['episode_id'])
        groups.setdefault(pair,set()).add(int(case['panel']))
    records={}
    for (slug,chapter),missing in sorted(groups.items()):
        scope=_scope_for(root,slug)
        # The locally archived comic may have been moved or its temporary
        # checkpoint cleaned up. Private GitHub partial pixels still count.
        total,confirmed,saved = _checked_checkpoint(scope,slug,chapter) if scope else (0,False,{})
        total=max([total,*missing])
        if total>2000:
            raise RuntimeError('Incomplete chapter has too many panel positions')
        # A record cannot simultaneously be confirmed absent and locally verified.
        if missing.intersection(saved):
            raise RuntimeError('Missing-source case conflicts with validated checkpoint')
        records[(slug,chapter)]={'total':total,'count_confirmed':confirmed,'images':{}}
        records[(slug,chapter)]['_saved']=saved
    if not records:
        return records
    repo=engine.github_http('GET',f'{engine.GITHUB_API}/repos/{owner}/open-reader',token)
    if repo.status_code!=200 or repo.json().get('private') is not True or repo.json().get('owner',{}).get('login','').lower()!=owner.lower():
        raise RuntimeError('GitHub streaming partial panels require your existing PRIVATE open-reader repository and Contents write access')
    for (slug,chapter),row in sorted(records.items()):
        saved=row.pop('_saved')
        missing=groups[(slug,chapter)]
        remote=_recover_remote_partial(engine,owner,token,slug,chapter,missing,saved)
        row['images'].update(remote)
        if row['count_confirmed'] and any(n > row['total'] for n in remote):
            raise RuntimeError('Remote partial panel exceeds confirmed source catalog: ' + chapter)
        row['total']=max([row['total'],*remote.keys()])
        for ordinal,item in sorted(saved.items()):
            name=f'{ordinal:04d}-{item["sha256"]}.{item["ext"]}'
            path=f'partial/{slug}/{chapter}/{name}'
            _github_put_verified(engine,owner,token,path,item['bytes'])
            row['images'][ordinal]={
                'url':github_streaming.route(slug,chapter,ordinal,item['sha256']),
                'width':item['width'],'height':item['height'],'sha256':item['sha256'],
                'github':{'repo':'open-reader','path':path}}
        print(f'open-reader: partial chapter {slug}/{chapter}: '
              f'{len(row["images"])} checkpoint images verified on GitHub '
              f'({len(remote)} recovered remotely); {row["total"]} known positions; '
              'missing slots kept as placeholders',flush=True)
    return records
