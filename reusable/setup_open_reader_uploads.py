#!/usr/bin/env python3
"""Explicit opt-in setup of a Cloudflare R2 panel replacement bucket and Worker secrets.

Run from the actual ComicArchiver project; no secrets are written to files,
logs, Python command lines or Git. An R2 binding marker is written only after
all remote operations succeed, and lives under ignored .archiver_state.
"""
from __future__ import annotations
import argparse
import getpass
import json
import re
import secrets
import shutil
import subprocess
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[1]

def invoke(args, *, password=None, echo=True):
    command=['npx','wrangler',*args]
    if echo: print('Cloudflare Wrangler:', ' '.join(command), flush=True)
    result=subprocess.run(command,input=(password+'\n') if password is not None else None,
                          text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                          timeout=180,check=False)
    if echo and result.stdout:print(result.stdout[-1800:],flush=True)
    if result.returncode:
        raise RuntimeError('Wrangler failed (' + ' '.join(args) + '): ' +
                           result.stdout[-600:])
    return result.stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--project',type=Path,default=DEFAULT)
    parser.add_argument('--bucket',default='open-reader-panel-replacements')
    parser.add_argument('--existing-bucket',action='store_true',
                        help='Use a bucket already created on the correct Cloudflare account')
    parser.add_argument('--dry-run',action='store_true',help='Show planned commands; do not log in or mutate cloud or files')
    args=parser.parse_args()
    root=args.project.resolve()
    if not (root/'reusable/open_reader.py').is_file():
        raise SystemExit('ComicArchiver project not found: '+str(root))
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,62}',args.bucket):
        raise SystemExit('Invalid R2 bucket name')
    if args.dry_run:
        print('No cloud actions taken. Steps:')
        print('npx wrangler whoami')
        if not args.existing_bucket:print('npx wrangler r2 bucket create '+args.bucket)
        print('npx wrangler secret put READER_ADMIN_PASSWORD --name open-reader')
        print('npx wrangler secret put READER_SESSION_HMAC_KEY --name open-reader')
        print('Write ignored R2 binding marker; then run python run.py')
        return
    if not shutil.which('npx'):
        raise SystemExit('npx not found; install Node.js first')
    print('IMPORTANT: confirm Wrangler is logged into the SAME Cloudflare account as the existing open-reader Worker.')
    invoke(['whoami'])
    if not args.existing_bucket:
        invoke(['r2','bucket','create',args.bucket])
    pw=getpass.getpass('New admin upload password (20+ chars, invisible): ')
    if len(pw)<20 or len(pw)>4096:raise SystemExit('Admin password must have 20-4096 characters')
    confirm=getpass.getpass('Repeat admin password: ')
    if pw!=confirm:raise SystemExit('Passwords differ; no secrets changed')
    # Wrangler accepts secret data via stdin. Never print or store them.
    invoke(['secret','put','READER_ADMIN_PASSWORD','--name','open-reader'],password=pw,echo=False)
    invoke(['secret','put','READER_SESSION_HMAC_KEY','--name','open-reader'],
           password=secrets.token_urlsafe(48),echo=False)
    path=root/'.archiver_state/open_reader_uploads.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'r2_bucket':args.bucket},indent=2)+'\n',encoding='utf-8')
    tmp.replace(path)
    print('Upload backend configured. No secrets stored locally.')
    print('Now run python run.py to publish the Worker with its R2 binding.')

if __name__=='__main__':main()
