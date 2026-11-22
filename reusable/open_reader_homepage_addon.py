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


def augment_assets(asset_root: Path, project_root: Path):
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
    feed=write_issue_feed(project_root,asset_root/'source-issues.json')
    # Public contents should not change merely because run.py was rerun.
    # Runtime R2 issues still carry their own first-reported timestamps.
    stable={k:v for k,v in feed.items() if k!='generated_at'}
    import json
    (asset_root/'source-issues.json').write_text(
        json.dumps(stable,sort_keys=True,separators=(',',':'),ensure_ascii=False),encoding='utf-8')
    return {'html_documents':html_count,'issues':feed['count'],
            'affected_chapters':len({(c['work_slug'],c['episode_id']) for c in feed['cases']}),
            'static_assets':len(ASSETS)+len(icon_names)+1}
