"""Build-only hook. Import content is never folded into the static registry."""
from pathlib import Path
import shutil
import hashlib
import json

PDF_VERSION = '4.10.38'
SOURCE_FILES = ('reusable/manual_import.py', 'reusable/manual_import_browser.html',
                'reusable/manual_import.css', 'reusable/manual_import_browser.js', 'reusable/manual_direct_upload.js',
                'reusable/worker_addon/manual_import_worker.mjs')


def pdf_assets(root):
    p = Path(root) / '.archiver_tools' / 'open-reader-import' / 'node_modules' / 'pdfjs-dist'
    if not p.is_dir():
        return []
    package = json.loads((p/'package.json').read_text(encoding='utf-8'))
    if package.get('version') != PDF_VERSION:
        raise RuntimeError('Unexpected PDF.js version; rerun the Add Comic installer')
    files = [(p/'build'/name, name) for name in ('pdf.mjs','pdf.worker.mjs')]
    for sub in ('cmaps','standard_fonts','wasm'):
        folder=p/sub
        if folder.is_dir():
            files.extend((f, f.relative_to(p).as_posix()) for f in sorted(folder.rglob('*')) if f.is_file())
    if not all(f.is_file() for f,_ in files):
        raise RuntimeError('PDF.js dependency incomplete; rerun the Add Comic installer')
    if (p/'LICENSE').is_file(): files.append((p/'LICENSE','LICENSE.txt'))
    return files


def enabled(root):
    return (Path(root) / 'reusable' / 'manual_import.html').is_file()


def hash_inputs(root):
    if not enabled(root): return {}
    out={}
    for name in SOURCE_FILES:
        p=Path(root)/name
        if not p.is_file(): raise RuntimeError('Missing Add Comic integration: '+name)
        out[name]=hashlib.sha256(p.read_bytes()).hexdigest()
    for f,rel in pdf_assets(root):
        out['manual-pdf/'+rel]=hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def stage_assets(root, stage):
    root,stage=Path(root),Path(stage)
    if not enabled(root): return
    target=stage/'add-comic';target.mkdir(exist_ok=True)
    for src,dst in [('manual_import_browser.html','add-comic/index.html'),('manual_import_browser.js','manual-import.js'),('manual_direct_upload.js','manual-direct-upload.js'),('manual_import.css','manual-import.css')]:
        shutil.copy2(root/'reusable'/src,stage/dst)
    vendor=pdf_assets(root)
    for f,rel in vendor:
        dst=stage/'manual-pdf'/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,dst)
    if not vendor:
        print('WARNING: Add Comic image imports are enabled; PDF.js is missing. Run the patch installer to enable PDF imports.',flush=True)
    # Add a link to the existing homepage after Journey has added its links.
    # Do not modify its static library.json or registry.json: deployment verification
    # and older archive reconciliation continue to compare their exact bytes.
    home=stage/'index.html';html=home.read_text(encoding='utf-8')
    anchor='<p class="subtitle">Your comic library'
    if html.count(anchor)!=1:raise RuntimeError('Homepage navigation changed; refusing ambiguous Add Comic link')
    html=html.replace(anchor,anchor+' <a href="/add-comic/" style="margin-left:auto;margin-right:14px;color:#f5d99f;font-weight:650;text-decoration:underline;white-space:nowrap">Add Comic</a>',1)
    html=html.replace('</head>','<style>@media(max-width:520px){.subtitle{font-size:11px;letter-spacing:0;gap:4px}.subtitle::before{margin-right:4px;flex:none}.subtitle a{margin-right:4px!important;font-size:11px!important;white-space:nowrap}.subtitle a[href="/add-comic/"]{margin-left:auto!important}}</style></head>',1)
    # Preserve original load/search behavior and separately merge dynamic imports.
    needle='comics=x.comics||[];render()'
    if html.count(needle)!=1:raise RuntimeError('Homepage library loader changed; refusing ambiguous Add Comic integration')
    html=html.replace(needle,needle+";fetch('/api/manual-library',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Imports temporarily unavailable');return r.json()}).then(y=>{const known=new Set(comics.map(c=>c.slug));comics=comics.concat((y.comics||[]).filter(c=>!known.has(c.slug)));render()}).catch(()=>{const hint=document.createElement('p');hint.className='empty';hint.textContent='Imported comics are temporarily unavailable. Your existing library is unchanged.';grid.after(hint)})",1)
    # The warning is inside the existing grid area only when imports cannot load.
    html=html.replace('grid.after(hint)','grid.append(hint)')
    home.write_text(html,encoding='utf-8')
    # Edit metadata link and description appear only on the imported overview.
    overview=stage/'manual-reader-template'/'overview'/'index.html'
    html=overview.read_text(encoding='utf-8')
    marker='<p id="resume-note"'
    if html.count(marker)!=1:raise RuntimeError('Overview layout changed; refusing ambiguous import metadata insertion')
    html=html.replace(marker,'<div id="manual-meta" class="meta"></div><div class="actions"><a class="action secondary" id="manual-edit" href="/add-comic/">Edit comic</a></div><p id="resume-note"',1)
    html=html.replace('</head>','<script defer src="/manual-overview.js"></script></head>',1)
    overview.write_text(html,encoding='utf-8')
    (stage/'manual-overview.js').write_text("""(()=>{const slug=location.pathname.match(/^\\/comics\\/(import-[a-f0-9]{32})\\/overview\\//)?.[1];if(!slug)return;const a=document.getElementById('manual-edit');a.href='/add-comic/?edit='+encodeURIComponent(slug);fetch('../manifest.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(m=>{if(!m?.metadata)return;const e=document.getElementById('manual-meta'),v=m.metadata;for(const s of [v.author&&'Author: '+v.author,v.language&&'Language: '+v.language,v.status&&'Status: '+v.status,v.description].filter(Boolean)){const p=document.createElement('p');p.textContent=s;e.append(p)}}).catch(()=>{});})();""",encoding='utf-8')
