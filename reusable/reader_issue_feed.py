"""Source-side failure cases for the universal shared comic reader.

Public feed contains only work/chapter/panel identities and independently
confirmed origin statuses. No cookies, signed URLs, captured images or tokens.
Source-specific naming/selection still lives in site_specific/site_adapter.py.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


def _utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _option(db, key, default=''):
    try:
        row = db.execute('SELECT value FROM options WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default
    except (sqlite3.DatabaseError, TypeError, ValueError):
        return default


def _accepted(record):
    if not isinstance(record, dict):
        return False
    if (record.get('reason') == 'adapter_confirmed_origin_placeholder' and
        record.get('adapter_confirmed') is True and
        record.get('dom_unloaded') is True and
        str(record.get('url') or '').startswith('https://')):
        return True
    if record.get('debugger_confirmed') is not True:
        return False
    try:
        status = int(record['status'])
    except (KeyError, TypeError, ValueError):
        return False
    reason = record.get('reason')
    return (status in (404, 410) and reason == f'confirmed_image_http_{status}') or (
        500 <= status <= 599 and reason == 'repeated_source_http_5xx_after_reload')


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        return None


def build_issue_feed(project_root: Path, *, reader_base='') -> dict:
    """Aggregate current unresolved cases from every locally registered work.

    Status PUBLISHED_VERIFIED means chapter was successfully archived with every
    image and therefore has no active missing-image alert. A previously recorded
    server error is also considered resolved if its specific key is now verified
    in the per-image checkpoint. Otherwise keep it visible until remediation.
    """
    root = Path(project_root)
    state = root / '.archiver_state'
    dirs = sorted((state / 'sites').iterdir()) if (state / 'sites').is_dir() else []
    if (state / 'state.sqlite').is_file():
        dirs.insert(0, state)
    cases = []
    resolved_ids = set()
    for scope in dirs:
        db_path = scope / 'state.sqlite'
        if not db_path.is_file():
            continue
        try:
            con = sqlite3.connect(f'file:{db_path.as_posix()}?mode=ro', uri=True)
            try:
                comic = str(_option(con, 'series_title', scope.name))
                slug = str(_option(con, 'series_slug', scope.name))
                chapters = con.execute('SELECT chapter_id,label,url,status FROM chapters').fetchall()
            finally:
                con.close()
        except sqlite3.DatabaseError:
            continue
        for episode_id, episode, source_url, status in chapters:
            verified = status in {'ARCHIVED_VERIFIED', 'ARCHIVED_PENDING_DEPLOYMENT', 'PUBLISHED_VERIFIED'}
            folder = scope / 'temporary_downloads' / re.sub(r'[^a-z0-9]+', '-', str(episode_id).casefold()).strip('-')[:45].rstrip('-')
            report = _read_json(folder / 'confirmed_server_failures.json')
            if not isinstance(report, dict) or str(report.get('chapter_id')) != str(episode_id):
                continue
            failures = report.get('failures')
            if not isinstance(failures, dict):
                continue
            checkpoint = _read_json(folder / '.image-checkpoint.json')
            saved = checkpoint.get('images', {}) if isinstance(checkpoint, dict) else {}
            for key, evidence in failures.items():
                if not _accepted(evidence):
                    continue
                try:
                    panel = int(key)
                    if panel <= 0 or panel > 100000:
                        continue
                except (ValueError, TypeError):
                    continue
                ident = hashlib.sha256(f'{slug}\x00{episode_id}\x00{panel}'.encode()).hexdigest()[:20]
                if verified or str(key) in saved:
                    resolved_ids.add(ident)
                    continue
                case = {
                    'id': ident,
                    'work': comic,
                    'work_slug': slug,
                    'episode': str(episode),
                    'episode_id': str(episode_id),
                    'panel': panel,
                    'status': 'source_server_unavailable',
                    'http_status': int(evidence['status']) if evidence.get('status') is not None else None,
                    'reason': evidence['reason'],
                    'first_reported_at': str(report.get('recorded_at') or ''),
                }
                if reader_base:
                    # Do not assert a chapter route without the Worker registry's
                    # own route mapping. This is a work-level navigation URL.
                    case['reader_url'] = reader_base.rstrip('/') + '/comics/' + quote(slug, safe='') + '/'
                cases.append(case)
    cases.sort(key=lambda x: (x['work'].casefold(), x['episode_id'], x['panel']))
    return {
        'schema': 'comicarchiver.source_issue_feed.v1',
        'generated_at': _utc(),
        'count': len(cases),
        'affected_works': len({x['work_slug'] for x in cases}),
        'resolved_ids': sorted(resolved_ids),
        'cases': cases,
    }


def write_issue_feed(project_root: Path, dest: Path, *, reader_base='') -> dict:
    dest = Path(dest)
    payload = build_issue_feed(project_root, reader_base=reader_base)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + '.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, dest)
    return payload
