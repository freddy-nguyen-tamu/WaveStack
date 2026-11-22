"""Provider-independent GitHub-on-demand image transport for shared Open Reader.

Cloudflare deploys only HTML/JS/CSS/manifests. Immutable archives remain on
private GitHub repositories; the Worker retrieves only images readers request.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

SHA = re.compile(r'^[a-f0-9]{64}$')
REPO = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,97}[a-z0-9])?-vol-\d{3}$')
CHAPTER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$')
PATH = re.compile(r'^chapters/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$')


def mode_path(root):
    return Path(root) / '.archiver_state' / 'github_streaming_mode.json'


def load_mode(root):
    p = mode_path(root)
    if not p.is_file():
        return None
    raw = json.loads(p.read_text(encoding='utf-8'))
    if not isinstance(raw, dict) or raw.get('mode') != 'github-on-demand-v1' or not re.fullmatch(r'[A-Za-z0-9-]{1,39}', raw.get('owner', '')):
        raise RuntimeError('Invalid streaming config: ' + str(p))
    return raw


def route(slug, chapter, ordinal, sha):
    return f'/api/github-image/{quote(slug,safe="")}/{quote(chapter,safe="")}/{ordinal}?v={sha}'


def archive_source(image, slug, chapter):
    """Derive provenance from a previously validated image host, never guess URLs."""
    if image.get('github'):
        orig = image['github']
        repo, path = str(orig.get('repo','')), str(orig.get('path',''))
    else:
        url = urlsplit(str(image.get('url') or ''))
        host = (url.hostname or '').lower()
        if url.scheme != 'https' or url.query or url.fragment or not host.endswith('.pages.dev'):
            raise RuntimeError(f'Cannot migrate image without verified GitHub origin: {slug}/{chapter}; {url.geturl()[:180]}')
        repo = host[:-len('.pages.dev')]
        path = unquote(url.path.lstrip('/'))
    match = PATH.fullmatch(path)
    if not REPO.fullmatch(repo) or not repo.startswith(slug + '-vol-') or not match:
        raise RuntimeError(f'Unexpected GitHub archive provenance for {slug}/{chapter}: {repo}/{path}')
    return {'repo':repo, 'path':path}


def convert_registry(registry):
    """Idempotently migrate all historic comics and chapters; no metadata dropped."""
    total=0
    for slug, comic in registry['comics'].items():
        for chapter in comic['chapters']:
            ident=str(chapter['id'])
            if not CHAPTER.fullmatch(ident):
                raise RuntimeError('Unsafe chapter identity in GitHub streaming migration')
            for i, image in enumerate(chapter['images'],1):
                digest=str(image.get('sha256') or '').lower()
                if not SHA.fullmatch(digest):
                    raise RuntimeError(f'Unverified image {slug}/{ident}/{i}')
                origin=archive_source(image,slug,ident)
                image['github']=origin
                image['url']=route(slug,ident,i,digest)
                total+=1
    return total


def preferred_chapter(candidate,previous):
    """Don't overwrite a migrated chapter with a stale Pages-era discovery."""
    if len(candidate.get('images',[])) > len(previous.get('images',[])):
        return candidate
    if len(candidate.get('images',[])) < len(previous.get('images',[])):
        return previous
    if all(i.get('github') for i in previous['images']) and not all(i.get('github') for i in candidate['images']):
        return previous
    return candidate


def validate_github_samples(engine, owner, token, registry):
    """Verify GitHub source availability and hashes without a full archive clone."""
    groups={}
    for comic in registry['comics'].values():
        for ch in comic['chapters']:
            for im in ch['images']:
                src=im['github']
                groups.setdefault(src['repo'],[]).append(im)
    for repo,images in sorted(groups.items()):
        for im in (images[:1]+images[-1:] if len(images)>1 else images):
            path=im['github']['path']
            url=(f'{engine.GITHUB_API}/repos/{owner}/{repo}/contents/' + '/'.join(quote(p,safe='') for p in path.split('/')))
            resp=engine.github_http('GET',url,token,headers={'Accept':'application/vnd.github.raw+json'})
            if resp.status_code!=200 or hashlib.sha256(resp.content).hexdigest()!=im['sha256']:
                raise RuntimeError(f'GitHub streaming source failed byte integrity: {repo}/{path} (HTTP {resp.status_code})')
        print(f'open-reader: GitHub streaming source validated {repo} ({len(images)} indexed panels; two sampled)',flush=True)
    return groups


def catalog(registry):
    return {'schema':'github-upload-catalog-v1', 'comics':[
        {'slug':slug,'title':comic['title'],'chapters':[
            {'id':ch['id'],'title':ch['title'],'count':len(ch['images'])}
            for ch in comic['chapters']]} for slug,comic in sorted(registry['comics'].items())]}
