"""Additive static-asset stage hook for ComicArchiver's *existing* shared Worker.

Call augment_assets(temp_assets_dir, project_root) from reusable/open_reader.py
IMMEDIATELY BEFORE invoking Wrangler. Do not replace the existing publisher.

This module contains no comic website-specific rules. The public issue feed is
built from existing state and never makes source-site requests.
"""
from __future__ import annotations
import re
import shutil
from pathlib import Path
from reusable.reader_issue_feed import write_issue_feed

ASSETS = ('reader-issues.js', 'reader-issues.css')
ICONS_HEAD = ('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
              '<link rel="icon" href="/favicon.ico" sizes="any">'
              '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">'
              '<link rel="apple-touch-icon" href="/favicon-180.png">')
HEAD = ICONS_HEAD + '<script defer src="/reader-issues.js"></script>'



def _natural_chapter_key(value):
    """Compare source-provided IDs numerically, preserving published order otherwise."""
    return tuple((1, int(token)) if token.isdigit() else (0, token.casefold())
                 for token in re.findall(r'[0-9]+|[^0-9]+', str(value)))


def _stage_confirmed_missing_chapters(asset_root: Path, feed: dict, partial_records=None) -> int:
    """Add navigation-only chapters to generated manifests, never GitHub archives.

    Source issue records are the sole authority for a missing chapter. A missing
    chapter contains NO invented image URLs or fabricated page count, and never
    replaces a real chapter that appears in a verified published manifest.
    """
    import json
    from urllib.parse import urlsplit

    groups = {}
    for case in feed.get('cases', []):
        if not isinstance(case, dict) or case.get('status') != 'source_server_unavailable':
            continue
        slug, chapter_id = str(case.get('work_slug', '')), str(case.get('episode_id', ''))
        if not re.fullmatch(r'[a-z0-9-]+', slug) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', chapter_id):
            continue
        if not re.fullmatch(r'[a-f0-9]{20}', str(case.get('id', ''))):
            continue
        try:
            number = int(case['panel'])
        except (KeyError, TypeError, ValueError):
            continue
        if number < 1 or number > 100000:
            continue
        pair = (slug, chapter_id)
        row = groups.setdefault(pair, {'panels': set(), 'label': chapter_id, 'url': ''})
        row['panels'].add(number)
        episode = str(case.get('episode') or '').strip()
        if episode and len(episode) <= 320:
            row['label'] = episode
        raw_url = str(case.get('source_chapter_url') or '')
        try:
            u = urlsplit(raw_url)
            if u.scheme == 'https' and u.hostname and not u.username and not u.password and not u.fragment:
                row['url'] = raw_url
        except ValueError:
            pass

    partial_records = partial_records or {}
    inserted = 0
    counts = {}
    for slug in sorted({k[0] for k in groups}):
        path = asset_root / 'comics' / slug / 'manifest.json'
        if not path.is_file():
            continue  # Never create an unowned comic route from an issue record.
        manifest = json.loads(path.read_text(encoding='utf-8'))
        chapters = manifest.get('chapters')
        if not isinstance(chapters, list):
            raise RuntimeError('Invalid staged comic manifest at ' + str(path))
        existing = {str(ch.get('id')) for ch in chapters if isinstance(ch, dict)}
        added = 0
        pending = [(cid, row) for (work, cid), row in groups.items()
                   if work == slug and cid not in existing]
        pending.sort(key=lambda item: _natural_chapter_key(item[0]))
        for cid, row in pending:
            # Incomplete chapters are readable: original DOM ordinals remain
            # intact, verified checkpoint panels stream from private GitHub,
            # and only absent positions become non-image placeholders.
            batch = partial_records.get((slug, cid), {})
            available = batch.get('images', {}) if isinstance(batch, dict) else {}
            total = batch.get('total', 0) if isinstance(batch, dict) else 0
            if not isinstance(available, dict) or not isinstance(total, int):
                raise RuntimeError('Malformed partial chapter checkpoint index')
            ordinals = sorted(row['panels'])
            total = max([total, *ordinals, *(int(k) for k in available)] or [0])
            if total > 2000 or total < 1:
                raise RuntimeError('Untrusted partial chapter panel count: ' + cid)
            images = []
            for ordinal in range(1, total + 1):
                verified = available.get(ordinal)
                if verified is not None:
                    if ordinal in row['panels']:
                        raise RuntimeError('Confirmed missing panel conflicts with checkpoint: ' + cid)
                    if (not isinstance(verified, dict) or not isinstance(verified.get('github'), dict)
                            or verified['github'].get('repo') != 'open-reader'
                            or not str(verified.get('url', '')).startswith('/api/github-image/')
                            or not re.fullmatch(r'[a-f0-9]{64}', str(verified.get('sha256', '')))):
                        raise RuntimeError('Invalid unverified partial image: ' + cid)
                    images.append(verified)
                else:
                    images.append({'placeholder': True, 'panel': ordinal,
                                   'confirmed_missing': ordinal in row['panels'],
                                   'width': 1100, 'height': 1500})
            placeholder = {
                'id': cid, 'number': cid, 'title': row['label'], 'label': row['label'],
                'images': images, 'source_unavailable': True, 'partial': True,
                'available_panels': sorted(int(k) for k in available),
                'unavailable_panels': ordinals,
                'panel_count_confirmed': bool(batch.get('count_confirmed')),
            }
            if row['url']:
                placeholder['source_chapter_url'] = row['url']
            key = _natural_chapter_key(cid)
            index = next((i for i, chapter in enumerate(chapters)
                          if key < _natural_chapter_key(str(chapter.get('id', '')))), len(chapters))
            chapters.insert(index, placeholder)
            added += 1
        if added:
            path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                       separators=(',', ':')), encoding='utf-8')
            counts[slug] = added
            inserted += added

    if counts:
        library_path = asset_root / 'library.json'
        library = json.loads(library_path.read_text(encoding='utf-8'))
        for comic in library.get('comics', []):
            n = counts.get(str(comic.get('slug', '')), 0)
            if n:
                comic['archived_chapters'] = int(comic['chapters'])
                comic['unavailable_chapters'] = n
                comic['chapters'] += n
        library_path.write_text(json.dumps(library, ensure_ascii=False, sort_keys=True,
                                           separators=(',', ':')), encoding='utf-8')
    return inserted

def augment_assets(asset_root: Path, project_root: Path, partial_records=None):
    """Return verification record; fail if publisher didn't stage its homepage.

    Never touch user comic images or manifests. Only modifies generated staging
    files. No Cloudflare upload is performed by this function.
    """
    project_root = Path(project_root).resolve()
    asset_root = Path(asset_root).resolve()
    if not asset_root.is_dir() or not (asset_root / 'index.html').is_file():
        raise RuntimeError('Shared-reader build has no homepage index.html: ' + str(asset_root))
    source=project_root/'reader'
    for name in ASSETS:
        f=source/name
        if not f.is_file() or f.stat().st_size==0:
            raise RuntimeError('Missing notification or favicon asset: '+str(f))
        shutil.copy2(f, asset_root/name)
    from reusable.gold_favicon import stage_icons
    icon_names = stage_icons(asset_root)
    html_count=0
    for p in asset_root.rglob('*.html'):
        if not p.resolve().is_relative_to(asset_root):
            raise RuntimeError('Asset path escapes staging directory')
        s=p.read_text(encoding='utf-8')
        # Remove the legacy bell from chapter readers, including old inline
        # injections. Keep source files and the user browser profile unchanged.
        s=re.sub(r'<script\b[^>]*\bsrc=[\"\'](?:/|\./)?source-issue-bell\.js[\"\'][^>]*>\s*</script>', '', s, flags=re.IGNORECASE)
        s=re.sub(r'<script\b[^>]*\bsrc=[\"\'](?:/|\./)?reader-issues\.js[\"\'][^>]*>\s*</script>', '', s, flags=re.IGNORECASE)
        # Canonical root-relative icons. The SVG and all raster fallbacks have
        # transparent pixels; black is never rendered into an icon image.
        s=re.sub(r'<link\b[^>]*\brel=[\"\'](?:shortcut )?icon[\"\'][^>]*>', '', s, flags=re.IGNORECASE)
        s=re.sub(r'<link\b[^>]*\brel=[\"\']apple-touch-icon[\"\'][^>]*>', '', s, flags=re.IGNORECASE)
        if not re.search(r'</head\s*>',s,re.IGNORECASE):
            raise RuntimeError('HTML asset is missing </head>: ' + str(p))
        home = p == asset_root / 'index.html'
        tags = HEAD if home else ICONS_HEAD
        s=re.sub(r'</head\s*>',lambda m:tags+m.group(),s,count=1,flags=re.IGNORECASE)
        p.write_text(s,encoding='utf-8')
        html_count+=1
    import json
    feed=write_issue_feed(project_root,asset_root/'source-issues.json')
    # Public contents should not change merely because run.py was rerun.
    # Runtime R2 issues still carry their own first-reported timestamps.
    stable={k:v for k,v in feed.items() if k!='generated_at'}
    import json
    (asset_root/'source-issues.json').write_text(
        json.dumps(stable,sort_keys=True,separators=(',',':'),ensure_ascii=False),encoding='utf-8')
    missing_chapters = _stage_confirmed_missing_chapters(asset_root, stable, partial_records)
    # Make the already-existing bell's GitHub repair form aware of incomplete
    # chapters and their exact panel positions; never make up an image URL.
    catalog_path=asset_root/'upload-catalog.json'
    if catalog_path.is_file():
        cat=json.loads(catalog_path.read_text(encoding='utf-8'))
        for comic in cat.get('comics', []):
            slug=str(comic.get('slug',''))
            source=asset_root/'comics'/slug/'manifest.json'
            if not source.is_file():continue
            stage_manifest=json.loads(source.read_text(encoding='utf-8'))
            known={str(ch.get('id')) for ch in comic.get('chapters',[])}
            for chapter in stage_manifest.get('chapters',[]):
                if not chapter.get('partial') or str(chapter.get('id')) in known:continue
                comic['chapters'].append({'id':chapter['id'],'title':chapter.get('title') or chapter['id'],
                                         'count':len(chapter.get('images') or [])})
            order={str(ch.get('id')):i for i,ch in enumerate(stage_manifest.get('chapters',[]))}
            comic['chapters'].sort(key=lambda ch:order.get(str(ch.get('id')),len(order)))
        catalog_path.write_text(json.dumps(cat,ensure_ascii=False,sort_keys=True,separators=(',',':')),
                                encoding='utf-8')
    return {'unavailable_chapters': missing_chapters,
            'html_documents':html_count,'issues':feed['count'],
            'affected_chapters':len({(c['work_slug'],c['episode_id']) for c in feed['cases']}),
            'static_assets':len(ASSETS)+len(icon_names)+1}
