"""Opt-in chapter-level browser downloads. Existing capture strategy is untouched."""
from __future__ import annotations

# === PERMANENT ADAPTER CONTRACT: KEEP THIS COMMENT IN EVERY FUTURE ADAPTER ===
# When adapting a new website, change only site_specific/site_adapter.py.
# Keep this complete contract comment in every replacement, even if the new
# website uses the legacy acquisition mode. Do not put site-specific selectors,
# URLs, chapter ordering, or filename rules into reusable/ or run.py.
#
# To enable native script-driven chapter acquisition, set
# SOURCE_BROWSER_TRANSPORT = 'extension' and define CHAPTER_DOWNLOAD_JS as a
# nonempty JavaScript expression (usually an immediately invoked function).
# Omit it or set it to None to retain the existing legacy acquisition mode.
# The reusable launcher auto-detects this setting; no CLI mode switch needed.
# Reusable navigates each adapter-discovered chapter, scrolls to a stable bottom,
# then injects this script into the managed tab. The script must return a plain
# synchronous object: {url: location.href, items: [...], loaded: count}.
# Each item must have {key: '1', order: 1, url: 'https://...',
# filename: '0001.jpg', width: 0, height: 0}, with consecutive 1-based keys/order
# and filenames 0001, 0002, ... plus an allowed image extension. Width/height
# are optional decoded natural dimensions (0 if unknown). Discover the exact
# reader pages in reading order from the real attached HTML/runtime capture;
# exclude ads, banners, placeholders, and duplicate non-reader DOM elements.
# Never guess missing URLs, chapter counts, or page order. Use native chapter
# discovery functions for the actual chapter list, canonical URL and labels.
# Declare ALLOWED_HOSTS, BRIDGE_IMAGE_HOSTS, EXTENSION_MATCHES and READER_SELECTORS
# accurately. Use ordinary authorized HTTPS image URLs, not data/blob/canvas,
# login bypasses, or hidden content. Use legacy mode if this contract does not
# fit. Optional script_download_expected(html, url) independently returns
# [(key, url), ...] in exact order for cross-checking the injected plan.
# The injected script specifies the ordered filenames and download commands;
# the reusable native Chrome download manager performs the transfers, checks
# receipts, validates bytes and actual format, and commits durable checkpoints.
# Do not click download anchors or run a second download loop in the adapter.
# Optional CHAPTER_DOWNLOAD_TRANSPORT = 'loaded-resource' reads original image
# bytes already received by the normal managed chapter (Chrome debugger
# permission). Use when ordinary native downloads fail but the page loads the
# images. No alternate CDN request or access-control bypass is attempted.
# Default 'native' retains Chrome's downloads API. Both preserve the same
# ordered plan and validation; neither accepts HTML or an interrupted receipt.
# PERMANENT CORS WARNING: an <img> may render normally and return HTTP 200
# while page-context fetch() fails because the CDN does not allow the reader
# origin (no Access-Control-Allow-Origin). Inspect actual browser network and
# console evidence before selecting a transport; do not infer byte access from
# DOM URLs, decoded dimensions, HTTP 200, or .jpg suffixes. A native download
# may also fail or return HTML even if the reader itself displays the image.
# For an authorized normally loaded image, choose 'loaded-resource' when
# native downloads fail; Chrome must expose the original loaded bytes. Do not
# disable web security, use fetch(mode='no-cors') to obtain opaque bytes,
# forge headers, or retry an actual access denial through another transport.
# Keep this CORS warning in every future adapter and reusable contract.
# Reusable handles GitHub batching, resume, publication and shutdown. Preserve
# existing series identity/checkpoints when changing a source for the same comic.
# Regenerate/reload the extension after a script or host change. Test against
# supplied captures before returning a patch. Never delete this comment block.
# === END PERMANENT ADAPTER CONTRACT ===
import base64, hashlib, io, json, os, re, time, uuid
from pathlib import Path
from urllib.parse import urlsplit
from PIL import Image
from .image_checkpoint import ChapterImageCheckpoint, _atomic_write
from .source_session import SourceAccessPaused


def enabled(adapter):
    return isinstance(getattr(adapter, 'CHAPTER_DOWNLOAD_JS', None), str) and bool(adapter.CHAPTER_DOWNLOAD_JS.strip())


def _validate_plan(plan, chapter_url, bridge, limit):
    if not isinstance(plan, dict) or plan.get('url') != chapter_url:
        raise RuntimeError('SCRIPT_DOWNLOAD: wrong chapter document')
    items=plan.get('items')
    if not isinstance(items,list) or not 0 < len(items) <= limit:
        raise RuntimeError('SCRIPT_DOWNLOAD: missing or excessive reader images')
    for i,item in enumerate(items,1):
        if (not isinstance(item,dict) or item.get('order') != i or item.get('key') != str(i)
            or not re.fullmatch(rf'{i:04d}\.(?:jpg|jpeg|png|webp|avif|gif|bmp)', str(item.get('filename','')))):
            raise RuntimeError('SCRIPT_DOWNLOAD: invalid ordered filename or ordinal')
        url=item.get('url',''); u=urlsplit(url)
        if u.scheme!='https' or u.username or u.password or u.port or u.hostname not in ({bridge.allowed_site}|bridge.allowed_cdn):
            raise RuntimeError('SCRIPT_DOWNLOAD: image URL not explicitly authorized by adapter')
        bridge.validate_image(url)
    return items


def _token(directory, chapter_url, items):
    path=directory/'.script-download.json'
    digest=hashlib.sha256(json.dumps([(x['key'],x['url'],x['filename']) for x in items],ensure_ascii=False).encode()).hexdigest()
    if path.exists():
        old=json.loads(path.read_text(encoding='utf-8'))
        if old.get('url')!=chapter_url or old.get('digest')!=digest or not re.fullmatch(r'[a-f0-9]{32}',str(old.get('token',''))):
            raise RuntimeError('SCRIPT_DOWNLOAD: saved source catalog changed; retain checkpoint and investigate')
        return old['token']
    token=uuid.uuid4().hex
    _atomic_write(path,{'url':chapter_url,'digest':digest,'token':token})
    return token


def _receipt_path(receipt, item, token):
    if receipt.get('url')!=item['url'] or receipt.get('filename')!=item['filename'] or receipt.get('state')!='complete':
        raise RuntimeError('SCRIPT_DOWNLOAD: mismatched native download receipt')
    path=Path(receipt['path'])
    managed=tuple(path.parts[-3:-1])==('ComicArchiver-script',token)
    exact=managed and path.name==item['filename']
    # An exact staging path is sufficient for legacy receipts. For any renamed
    # file require the extension's persisted ID binding to this exact URL/key.
    if not exact and (receipt.get('idBound') is not True or type(receipt.get('id')) is not int
                      or (not managed and receipt.get('extensionOwned') is not True)):
        raise RuntimeError('SCRIPT_DOWNLOAD: renamed file has no trusted native download ID')
    if (not path.is_absolute() or '..' in path.parts or not path.is_file()
        or any(p.is_symlink() or getattr(p,'is_junction',lambda:False)() for p in (path,*path.parents))):
        raise RuntimeError('SCRIPT_DOWNLOAD: native download path missing or unsafe')
    size=receipt.get('fileSize',-1)
    if isinstance(size,int) and size>=0 and path.stat().st_size!=size:
        raise RuntimeError('SCRIPT_DOWNLOAD: completed file size differs from browser receipt')
    return path


def _import(receipt,item,token,directory,checkpoint,limit):
    path=_receipt_path(receipt,item,token)
    if not 0 < path.stat().st_size <= limit:
        raise RuntimeError('SCRIPT_DOWNLOAD: downloaded image exceeds file limit or is empty')
    raw=path.read_bytes()
    result=_save_bytes(raw,item,directory,checkpoint,limit)
    # Only remove files inside the dedicated native staging area.
    if tuple(path.parts[-3:-1])==('ComicArchiver-script',token):
        try: path.unlink()
        except OSError: pass
    return result


def _save_bytes(raw,item,directory,checkpoint,limit):
    if not 0 < len(raw) <= limit:
        raise RuntimeError('SCRIPT_DOWNLOAD: image is empty or exceeds file limit')
    with Image.open(io.BytesIO(raw)) as im:
        fmt=im.format; width,height=im.size; im.verify()
    ext={'JPEG':'jpg','PNG':'png','WEBP':'webp','GIF':'gif','AVIF':'avif','BMP':'bmp'}.get(fmt)
    if not ext or min(width,height)<=0:
        raise RuntimeError('SCRIPT_DOWNLOAD: invalid downloaded image')
    if item.get('width') and item.get('height') and (width,height)!=(item['width'],item['height']):
        raise RuntimeError('SCRIPT_DOWNLOAD: image dimensions differ from decoded reader')
    target=directory/f"{item['order']:04d}.{ext}"
    tmp=target.with_suffix(target.suffix+'.part')
    with tmp.open('wb') as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,target)
    result=checkpoint.record_image(item['key'],item['order'],item['url'],target,{
        'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'width':width,'height':height,
        'format':ext,'source_url':item['url']})
    return result


def acquire(page, chapter, directory, adapter, config, guard, event, utc, source_title):
    bridge=getattr(getattr(page,'context',None),'bridge',None)
    if bridge is None:
        raise RuntimeError('SCRIPT_DOWNLOAD requires the installed Chrome/Edge Comic Bridge')
    chapter_url=chapter.url
    transport=getattr(adapter,'CHAPTER_DOWNLOAD_TRANSPORT','native')
    if transport not in ('native','loaded-resource'):
        raise RuntimeError('SCRIPT_DOWNLOAD: unknown adapter transport')
    if transport=='loaded-resource':
        ready=bridge.rpc('script_resource_prepare',{'url':chapter_url},timeout=35)
        if ready.get('ready') is not True: raise RuntimeError('SCRIPT_RESOURCE: response observer not ready')
    # One ordinary forward scroll, without per-image recovery or screenshot RPCs.
    stable=0; previous=None
    for step in range(int(config['page_scan_steps'])):
        info=bridge.rpc('script_scroll',{'url':chapter_url,'reset':step==0,'reader_selectors':list(adapter.READER_SELECTORS)},timeout=30)
        if info.get('url')!=chapter_url:
            raise RuntimeError('SCRIPT_DOWNLOAD: scroll document changed')
        signature=(info.get('height'),info.get('count'),info.get('loaded'))
        stable=stable+1 if info.get('atBottom') and signature==previous else 0
        previous=signature
        if stable>=int(config['page_scan_stability_steps']): break
        time.sleep(.25 if not info.get('atBottom') else .6)
    else: raise RuntimeError('SCRIPT_DOWNLOAD: reader bottom did not stabilize')
    plan=bridge.rpc('script_plan',{'url':chapter_url,'digest':hashlib.sha256(adapter.CHAPTER_DOWNLOAD_JS.strip().encode('utf-8')).hexdigest()},timeout=35)
    items=_validate_plan(plan,chapter_url,bridge,int(config['max_pages_per_chapter']))
    # Independently reconcile with the adapter's native HTML image catalog when supplied.
    expected=getattr(adapter,'script_download_expected',None)
    if callable(expected) and expected(page.content(),chapter_url)!=[(x['key'],x['url']) for x in items]:
        raise RuntimeError('SCRIPT_DOWNLOAD: injected script differs from native reader HTML')
    token=_token(directory,chapter_url,items)
    checkpoint=ChapterImageCheckpoint(directory,chapter.chapter_id,chapter_url)
    checkpoint.record_catalog([x['key'] for x in items],{x['key']:{'url':x['url']} for x in items})
    saved={}; pending=[]
    for item in items:
        reused=checkpoint.reuse(item['key'],item['order'],item['url'])
        if reused:
            saved[item['key']]=reused
            event('IMAGE_REUSED_FROM_CHECKPOINT',chapter=chapter.chapter_id,image=item['order'],total=len(items),bytes=reused[1]['bytes'])
        else: pending.append(item)
    event('SCRIPT_DOWNLOAD_PLAN',chapter=chapter.chapter_id,total=len(items),reused=len(saved),missing=len(pending),loaded=plan.get('loaded'))
    # The loaded-resource transport reads only bytes already received by the
    # managed chapter. If normal forward scrolling missed a lazy image, move
    # to its declared DOM element once and poll independently. No fresh CDN
    # download, screenshot, spoofed headers, or use of failed native receipts.
    if transport=='loaded-resource':
        for item in pending:
            payload={'url':chapter_url,'token':token,'items':[item],
                     'reader_selectors':list(adapter.READER_SELECTORS),
                     'image_attributes':list(getattr(adapter,'IMAGE_ATTRIBUTES',()))}
            positioned=False; deadline=time.monotonic()+45
            while True:
                receipt=bridge.rpc('script_resource_read',payload,timeout=65)
                if receipt.get('key')!=item['key'] or receipt.get('url')!=item['url']:
                    raise RuntimeError('SCRIPT_RESOURCE: wrong image receipt')
                state=receipt.get('state')
                if state=='complete':
                    raw=base64.b64decode(receipt['base64'],validate=True)
                    check=dict(item)
                    if receipt.get('width') and receipt.get('height'):
                        if item.get('width') and (item['width'],item['height'])!=(receipt['width'],receipt['height']):
                            raise RuntimeError('SCRIPT_RESOURCE: decoded dimensions changed')
                        check.update(width=receipt['width'],height=receipt['height'])
                    saved[item['key']]=_save_bytes(raw,check,directory,checkpoint,int(config['github_max_file_bytes']))
                    event('IMAGE_VALIDATED',chapter=chapter.chapter_id,image=item['order'],total=len(items),bytes=saved[item['key']][1]['bytes'],during_scroll=False,via='managed-reader-original-response')
                    break
                if state=='denied':
                    raise SourceAccessPaused(f"Reader image request failed: HTTP {receipt.get('status')} at ordinal {item['order']}; no alternate request attempted")
                if state not in ('pending','unavailable'):
                    raise RuntimeError('SCRIPT_RESOURCE: unknown resource receipt state')
                if time.monotonic()>deadline:
                    raise RuntimeError(f"SCRIPT_RESOURCE: original reader bytes unavailable for image {item['order']}; checkpoints retained")
                if not positioned and state=='pending':
                    r=bridge.rpc('script_resource_position',payload,timeout=35)
                    if r.get('positioned') is not True: raise RuntimeError('SCRIPT_RESOURCE: positioning not acknowledged')
                    positioned=True
                time.sleep(.75)
        pending=[]
    # A small source download window; separate from GitHub's adaptive batching.
    # Each start is paced; status polling does not perform a network image GET.
    for offset in range(0,len(pending),6):
        group=pending[offset:offset+6]
        payload={'url':chapter_url,'token':token,'items':group}
        if guard:
            for host in dict.fromkeys(urlsplit(x['url']).hostname for x in group):
                guard.before(next(x['url'] for x in group if urlsplit(x['url']).hostname==host),operation='native-chapter-download')
        payload['interval_ms']=round(1000*max(1.0,getattr(guard,'min_interval_seconds',1.5)))
        bridge.rpc('script_download_start',payload,timeout=120)
        deadline=time.monotonic()+300
        left={x['key']:x for x in group}
        while left:
            receipts=bridge.rpc('script_download_status',{**payload,'items':list(left.values())},timeout=45).get('receipts',[])
            if len(receipts)!=len(left) or {r.get('key') for r in receipts}!=set(left):
                raise RuntimeError('SCRIPT_DOWNLOAD: incomplete native download status receipt')
            # Reject aliased files before importing or deleting either receipt.
            completed=[r for r in receipts if r.get('state')=='complete']
            paths=[os.path.normcase(os.path.abspath(r.get('path',''))) for r in completed]
            ids=[r.get('id') for r in completed if r.get('id') is not None]
            if len(paths)!=len(set(paths)) or len(ids)!=len(set(ids)):
                raise RuntimeError('SCRIPT_DOWNLOAD: multiple pages share a native file or download ID')
            # Save every completed download before surfacing any failed sibling.
            failures=[]
            for receipt in receipts:
                key=receipt['key']; item=left[key]
                if receipt.get('state')=='complete':
                    actual=Path(receipt['path'])
                    if actual.name!=item['filename'] or tuple(actual.parts[-3:-1])!=('ComicArchiver-script',token):
                        event('SCRIPT_DOWNLOAD_FILENAME_RECONCILED',chapter=chapter.chapter_id,image=item['order'],requested=item['filename'],actual=actual.name,download_id=receipt.get('id'),outside_staging=tuple(actual.parts[-3:-1])!=('ComicArchiver-script',token))
                    saved[key]=_import(receipt,item,token,directory,checkpoint,int(config['github_max_file_bytes']))
                    event('IMAGE_VALIDATED',chapter=chapter.chapter_id,image=item['order'],total=len(items),bytes=saved[key][1]['bytes'],during_scroll=False)
                    del left[key]
                elif receipt.get('state')=='interrupted':
                    error=str(receipt.get('error','unknown'))
                    failures.append(error)
                    del left[key]
                elif receipt.get('state') not in ('in_progress','pending'):
                    raise RuntimeError('SCRIPT_DOWNLOAD: unknown native download state')
            if failures:
                if any(e in ('SERVER_FORBIDDEN','SERVER_UNAUTHORIZED') for e in failures):
                    raise SourceAccessPaused('Native browser download denied: '+', '.join(failures))
                raise RuntimeError('SCRIPT_DOWNLOAD: native download interrupted: '+', '.join(failures))
            if left:
                if time.monotonic()>deadline: raise RuntimeError('SCRIPT_DOWNLOAD: download manager did not complete; files retained for resume')
                time.sleep(.75)
    if len(saved)!=len(items): raise RuntimeError('SCRIPT_DOWNLOAD: incomplete chapter')
    files=[saved[x['key']][0] for x in items]; manifest=[saved[x['key']][1] for x in items]
    if [x['order'] for x in manifest]!=list(range(1,len(items)+1)) or any(Path(x['filename']).stem!=f'{i:04d}' for i,x in enumerate(manifest,1)):
        raise RuntimeError('SCRIPT_DOWNLOAD: invalid final manifest order')
    event('SCRIPT_DOWNLOAD_COMPLETE',chapter=chapter.chapter_id,images=len(files))
    return files,{'chapter_id':chapter.chapter_id,'label':source_title,'chapter_title':source_title,'original_url':chapter_url,'images':manifest,'total_images':len(files),'created_at':utc()}
