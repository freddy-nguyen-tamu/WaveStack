"""Generate installed extension manifests from provider-neutral source templates.

The reusable bridge never stores a website host or comic path. Only the active
site_specific.site_adapter supplies URL patterns and CDN hosts.
"""
from __future__ import annotations

import json
import re
from pathlib import Path


def _hosts(adapter):
    raw = tuple(getattr(adapter, 'ALLOWED_HOSTS', ())) + tuple(getattr(adapter,'BRIDGE_IMAGE_HOSTS', ()))
    out=[]
    for host in raw:
        if (isinstance(host,str) and re.fullmatch(r'[A-Za-z0-9.-]+',host) and
                '..' not in host and host not in out):
            out.append(host)
        else:
            if host not in out:
                raise ValueError('Invalid site adapter host: '+str(host))
    return [f'https://{host}/*' for host in out]


def generate_installed_manifests(root: Path, adapter, *, port: int = 18765):
    """Idempotent build-time output; never edits the source or adapter."""
    root=Path(root)
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('Invalid local bridge port')
    matches=list(getattr(adapter,'EXTENSION_MATCHES',()))
    if not matches or any(not isinstance(m,str) or not m.startswith('https://') or
                          '://' not in m or '*' not in m for m in matches):
        raise ValueError('site_adapter.EXTENSION_MATCHES must contain valid HTTPS match patterns')
    urls=_hosts(adapter)
    changed=[]
    for browser in ('chrome','firefox'):
        source=root/'reusable'/'browser_bridge_extension'/f'manifest.{browser}.json'
        target=root/'browser_bridge'/browser/'manifest.json'
        data=json.loads(source.read_text(encoding='utf-8'))
        data['content_scripts'][0]['matches']=matches
        grants=list(dict.fromkeys([f'http://127.0.0.1:{port}/*',*urls]))
        if browser=='chrome':
            data['host_permissions']=grants
        else:
            data['permissions']=list(dict.fromkeys([x for x in data['permissions']
                                                    if not x.startswith(('https://','http://'))]+grants))
        serialized=json.dumps(data,indent=2,ensure_ascii=False)+'\n'
        if not target.exists() or target.read_text(encoding='utf-8')!=serialized:
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(serialized,encoding='utf-8')
            changed.append(browser)
    return changed
