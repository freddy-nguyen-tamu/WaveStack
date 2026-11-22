#!/usr/bin/env python3
"""One-time setup for Cloudflare Worker -> private GitHub App streaming.

GitHub App keys remain only in the user's downloaded PEM and Cloudflare secrets;
never copy them to the project, state, Git, environment variables or command line.
"""
from __future__ import annotations
import argparse
import base64
import getpass
import json
import re
import secrets
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def _der_len(n:int)->bytes:
    if n<128:return bytes([n])
    bits=n.to_bytes((n.bit_length()+7)//8,'big')
    return bytes([0x80 | len(bits)])+bits

def _tag(code:int,payload:bytes)->bytes:
    return bytes([code])+_der_len(len(payload))+payload

def _pkcs8(pem:str)->str:
    """GitHub downloads PKCS#1; Web Crypto requires PKCS#8. No dependencies."""
    if '-----BEGIN PRIVATE KEY-----' in pem:
        b64=re.search(r'-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----',pem)
        if not b64:raise ValueError('Invalid PKCS#8 PEM')
        binary=base64.b64decode(re.sub(r'\s+','',b64.group(1)),validate=True)
    elif '-----BEGIN RSA PRIVATE KEY-----' in pem:
        b64=re.search(r'-----BEGIN RSA PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END RSA PRIVATE KEY-----',pem)
        if not b64:raise ValueError('Invalid GitHub RSA private key')
        rsa=base64.b64decode(re.sub(r'\s+','',b64.group(1)),validate=True)
        if len(rsa)<500 or rsa[:1]!=b'\x30':raise ValueError('Invalid RSA key DER')
        # PrivateKeyInfo := SEQUENCE {version 0, rsaEncryption OID + NULL,
        # privateKey OCTET STRING carrying the original PKCS#1 RSAPrivateKey}.
        alg=_tag(0x30,bytes.fromhex('06092a864886f70d0101010500'))
        binary=_tag(0x30,b'\x02\x01\x00'+alg+_tag(0x04,rsa))
    else:raise ValueError('Expected a GitHub App RSA private key PEM')
    lines=base64.b64encode(binary).decode('ascii')
    return '-----BEGIN PRIVATE KEY-----\n'+'\n'.join(lines[i:i+64] for i in range(0,len(lines),64))+'\n-----END PRIVATE KEY-----\n'

def _run(args, *, input_text=None):
    p=subprocess.run(['npx','--no-install','wrangler',*args],input=input_text,text=True,
                     capture_output=True,timeout=180,check=False,cwd=ROOT)
    if p.returncode:
        # CLI output can include contextual info: do not leak it if the request
        # carried a secret or the credentials have been rejected.
        if input_text is not None:raise RuntimeError('Cloudflare refused to save '+args[2])
        raise RuntimeError('Wrangler failed: '+(p.stderr or p.stdout)[-700:])
    return p.stdout

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner',required=True,help='Owner of ALL private GitHub archive repositories')
    parser.add_argument('--app-id',required=True,help='GitHub App ID')
    parser.add_argument('--installation-id',required=True,help='GitHub App installation ID')
    parser.add_argument('--pem',required=True,type=Path,help='GitHub App downloaded PEM key (PKCS#1 or PKCS#8)')
    parser.add_argument('--preserve-admin-password',action='store_true',
        help='Use existing Worker admin secrets without resetting them')
    parser.add_argument('--dry-run',action='store_true',help='Validate local input, no remote or local changes')
    a=parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9-]{1,39}',a.owner) or not a.app_id.isdecimal() or not a.installation_id.isdecimal():
        parser.error('Bad GitHub owner, App ID, or installation ID')
    if not (ROOT/'reusable/open_reader.py').is_file() or not (ROOT/'reusable/github_streaming.py').is_file():
        parser.error('Run from an installed, updated ComicArchiver project')
    pem=_pkcs8(a.pem.read_text(encoding='ascii'))
    print('GitHub App key parsed/converted to PKCS#8 in memory (no new key file).')
    print('App must have Contents read/write access to all image-volume repos and the private open-reader repo.')
    if a.dry_run:
        print('DRY RUN: no secrets uploaded, no streaming mode enabled.');return
    print('Cloudflare account used by Wrangler:')
    print(_run(['whoami'])[-1200:])
    if input('Use this Cloudflare account for open-reader? Type YES: ').strip()!='YES':
        raise SystemExit('Aborted without changes')
    admin=None
    if not a.preserve_admin_password:
        admin=getpass.getpass('Admin upload password (20+ chars, not saved locally): ')
        if len(admin)<20:raise SystemExit('Password too short')
        if admin!=getpass.getpass('Repeat admin password: '):raise SystemExit('Password mismatch')
    _run(['secret','put','GITHUB_APP_PRIVATE_KEY','--name','open-reader'],input_text=pem)
    if admin is not None:
        _run(['secret','put','READER_ADMIN_PASSWORD','--name','open-reader'],input_text=admin+'\n')
        _run(['secret','put','READER_SESSION_HMAC_KEY','--name','open-reader'],
             input_text=secrets.token_urlsafe(48)+'\n')
    state=ROOT/'.archiver_state/github_streaming_mode.json'
    state.parent.mkdir(parents=True,exist_ok=True)
    payload={'mode':'github-on-demand-v1','owner':a.owner,'app_id':a.app_id,
             'installation_id':a.installation_id}
    temp=state.with_suffix('.json.tmp')
    temp.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf-8')
    temp.replace(state)
    print('GitHub streaming mode enabled; secrets are stored only in Cloudflare.')
    print('Run: python run.py --deploy --authorized')
    print('DO NOT remove Cloudflare Pages volumes until new image routes verify.')

if __name__=='__main__':main()
