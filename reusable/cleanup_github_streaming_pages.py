#!/usr/bin/env python3
"""After a verified GitHub-streaming migration, remove ONLY obsolete image Pages projects.

Default = audit only. --execute performs irreversible deletion of verified,
known image-host Pages projects; never touches Github, reader projects or R2.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import requests

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from reusable.github_streaming import load_mode, route
from reusable import engine

def sha(b):return hashlib.sha256(b).hexdigest()

def audit():
    config=load_mode(ROOT)
    if not config:raise RuntimeError('GitHub streaming mode is not enabled')
    state=ROOT/'.archiver_state/open_reader_registry.json'
    registry=json.loads(state.read_text(encoding='utf-8'))
    base=str(registry.get('worker_url') or '').rstrip('/')
    if not base.startswith('https://') or not base.endswith('.workers.dev'):
        raise RuntimeError('Missing verified shared Worker URL; refusing Pages project deletion')
    local=registry.get('comics')
    if not isinstance(local,dict) or not local:
        raise RuntimeError('No backed-up comics in shared reader registry')
    session=requests.Session()
    def get(path,*,timeout=60):
        r=session.get(base+path,headers={'Cache-Control':'no-cache'},timeout=timeout)
        r.raise_for_status();return r
    health=get('/api/reader-health').json()
    if health.get('github_streaming_configured') is not True:
        raise RuntimeError('Worker is not configured for GitHub streaming')
    live=get('/registry.json').json().get('comics')
    if not isinstance(live,dict) or set(local)!=set(live):
        raise RuntimeError('Live Worker comic catalog differs from GitHub streaming checkpoint')
    repos={}
    total=0
    for slug,comic in local.items():
        lc=live[slug]
        if [c['id'] for c in comic['chapters']] != [c['id'] for c in lc.get('chapters',[])]:
            raise RuntimeError(f'Live Worker dropped/reordered chapters: {slug}')
        page_manifest=get('/comics/'+slug+'/manifest.json').json()
        index={str(c['id']):c for c in page_manifest.get('chapters',[])}
        if set(index)!={str(c['id']) for c in comic['chapters']}:
            raise RuntimeError(f'Live chapter manifest incomplete: {slug}')
        for ch in comic['chapters']:
            ident=str(ch['id']);live_images=index[ident].get('images')
            if len(ch['images']) != len(live_images or []):
                raise RuntimeError(f'Live image count differs: {slug}/{ident}')
            for i,(expected,current) in enumerate(zip(ch['images'],live_images),1):
                src=expected.get('github')
                if not isinstance(src,dict) or not re.fullmatch(r'[a-f0-9]{64}',str(expected.get('sha256'))) or not isinstance(src.get('repo'),str):
                    raise RuntimeError(f'Unmigrated GitHub panel: {slug}/{ident}/{i}')
                if (expected['url']!=route(slug,ident,i,expected['sha256']) or
                    current.get('url')!=expected['url'] or current.get('sha256')!=expected['sha256']):
                    raise RuntimeError(f'Live GitHub route wrong: {slug}/{ident}/{i}')
                repos.setdefault(src['repo'],[]).append(expected)
                total+=1
    # One live first + last panel from EACH previously deployed image volume.
    # Full manifests and hashes checked above, and GitHub upload already
    # verified remote tree identities when archiving.
    for repo,images in sorted(repos.items()):
        for im in (images[:1]+images[-1:] if len(images)>1 else images):
            r=get(im['url'],timeout=90)
            if sha(r.content)!=im['sha256']:
                raise RuntimeError(f'Worker->GitHub image SHA mismatch: {repo}')
    engine.select_cloudflare_account()
    known={p['name'] for p in engine.list_pages_projects()}
    victims=sorted(repo for repo in repos if repo in known and re.fullmatch(r'[a-z0-9-]+-vol-\d{3}',repo))
    print(f'LIVE VERIFIED: {len(local)} comics, {total} indexed GitHub routes, {len(repos)} origin repositories')
    print(f'Old Pages IMAGE volumes eligible for deletion: {len(victims)}')
    for repo in victims:print('  ',repo)
    print('Reader Pages projects, GitHub repos and any R2 bucket are never deleted by this command.')
    return victims

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--execute',action='store_true',help='Delete each verified obsolete Pages volume; cannot be undone')
    args=p.parse_args()
    victims=audit()
    if not args.execute:
        print('DRY RUN ONLY. After confirming the shared reader works, rerun with --execute.')
        return
    # Executing --execute is explicit authorization; no guessed project list.
    for repo in victims:
        print('Deleting obsolete Cloudflare Pages image project:',repo,flush=True)
        engine.npx_wrangler(['pages','project','delete',repo,'--yes'])
    print('Deleted only verified-obsolete Cloudflare Pages image projects: '+str(len(victims)))

if __name__=='__main__':main()
