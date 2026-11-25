"""Authenticated Cloudflare reader verification with a Windows DPAPI-protected session.

Generic deploy utility. Never bypasses the Worker login gate, persists passwords,
logs cookies, or sends credentials to any host other than the configured Worker.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlsplit

import requests

_ROOT = Path(__file__).resolve().parents[1]
_LOCK = threading.RLock()
_CACHE: dict[str,str] = {}
_HOST = re.compile(r'^open-reader\.[a-z0-9-]+\.workers\.dev$',re.I)


def _safe_origin(url: str) -> str | None:
    parts=urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.port or not parts.hostname or not _HOST.fullmatch(parts.hostname):
        return None
    return 'https://' + parts.hostname.lower()


def _session_file(origin: str) -> Path:
    tag=hashlib.sha256(origin.encode()).hexdigest()[:20]
    return _ROOT / '.archiver_state' / 'open_reader_verifier' / (tag + '.dpapi')


def _dpapi(data: bytes, *, encrypt: bool) -> bytes:
    if os.name != 'nt':
        raise RuntimeError('Secure persistent verifier sessions require Windows DPAPI')
    from ctypes import windll
    from ctypes import POINTER, byref, c_void_p, cast, create_string_buffer

    class DATA_BLOB(ctypes.Structure):
        _fields_=[('cbData',ctypes.wintypes.DWORD),('pbData',POINTER(ctypes.c_byte))]
    buffer=create_string_buffer(data,len(data))
    source=DATA_BLOB(len(data),cast(buffer,POINTER(ctypes.c_byte)))
    output=DATA_BLOB()
    func=windll.crypt32.CryptProtectData if encrypt else windll.crypt32.CryptUnprotectData
    func.argtypes = [
        POINTER(DATA_BLOB),
        c_void_p if encrypt else POINTER(c_void_p),
        POINTER(DATA_BLOB),
        c_void_p,
        c_void_p,
        ctypes.wintypes.DWORD,
        POINTER(DATA_BLOB),
    ]
    func.restype=ctypes.wintypes.BOOL
    # CRYPTPROTECT_UI_FORBIDDEN (0x1), prevents interactive Windows dialogs.
    if not func(byref(source),None,None,None,None,1,byref(output)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData,output.cbData)
    finally:
        windll.kernel32.LocalFree.argtypes=[c_void_p]
        windll.kernel32.LocalFree.restype=c_void_p
        windll.kernel32.LocalFree(cast(output.pbData,c_void_p))


def _load(origin: str) -> str | None:
    if origin in _CACHE:
        return _CACHE[origin]
    try:
        raw=_dpapi(_session_file(origin).read_bytes(),encrypt=False)
        payload=json.loads(raw.decode('utf8'))
        cookie=payload.get('reader_site') if payload.get('origin')==origin else None
        if cookie and re.fullmatch(r'\d{10,13}\.[A-Za-z0-9_-]+',cookie):
            _CACHE[origin]=cookie
            return cookie
    except (OSError,ValueError,UnicodeError,RuntimeError,KeyError):
        pass
    return None


def _save(origin: str, cookie: str) -> None:
    if not re.fullmatch(r'\d{10,13}\.[A-Za-z0-9_-]+',cookie):
        raise RuntimeError('Worker returned malformed site session cookie')
    _CACHE[origin]=cookie
    if os.name!='nt':
        return  # Never persist plaintext on other platforms.
    path=_session_file(origin)
    encrypted=_dpapi(json.dumps({'origin':origin,'reader_site':cookie}).encode(),encrypt=True)
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    try:
        tmp.write_bytes(encrypted)
        os.replace(tmp,path)
    finally:
        tmp.unlink(missing_ok=True)


def _cookie_header(cookie: str) -> str:
    return 'reader_site='+cookie


def _fetch(url: str, *, cookie: str | None, kwargs: dict):
    args=dict(kwargs)
    headers=dict(args.pop('headers',{}) or {})
    if cookie:
        headers['Cookie']=_cookie_header(cookie)
    args['headers']=headers
    args['allow_redirects']=False  # A protected HTML page redirects to login, never treat it as a verified asset.
    response = requests.get(url, **args)
    if cookie and 200 <= response.status_code < 300:
        renewed = getattr(response, 'cookies', {}).get('reader_site')
        origin = _safe_origin(url)
        if origin and renewed and renewed != cookie:
            _save(origin, renewed)
    return response


def _requires_login(response, origin: str) -> bool:
    if response.status_code==401:
        return True
    if response.status_code in (301,302,303,307,308):
        dest=response.headers.get('Location','')
        return dest.startswith('/login') or dest.startswith(origin+'/login')
    return False


def _exchange_password(origin: str) -> str:
    password=os.environ.get('OPEN_READER_VERIFY_PASSWORD')
    if not password:
        if not sys.stdin.isatty():
            raise RuntimeError('Authenticated Open Reader verification requires a site session. '
                               'Run from an interactive CMD to sign in once (password is not stored).')
        print('Open Reader requires a signed-in site session to verify protected publication.',flush=True)
        password=getpass.getpass('Open Reader site password (not saved): ')
    if not password:
        raise RuntimeError('Empty Open Reader verification password')
    # Browser login endpoint requires the normal same-origin Origin header.
    resp=requests.post(origin+'/api/admin/login',json={'password':password},
                       headers={'Origin':origin,'Cache-Control':'no-store'},timeout=30,allow_redirects=False)
    if resp.status_code!=200:
        raise RuntimeError('Open Reader verifier login refused (HTTP '+str(resp.status_code)+'). '
                           'Check the existing site password and Worker configuration.')
    cookie=resp.cookies.get('reader_site')
    if not cookie:
        raise RuntimeError('Open Reader login succeeded but returned no site-wide session cookie')
    _save(origin,cookie)
    print('open-reader: authenticated deployment verification session ready (Windows user-bound).',flush=True)
    return cookie


def get(url: str, **kwargs):
    """HTTP GET with optional user-authorized session. Other hosts remain untouched."""
    origin=_safe_origin(url)
    if not origin:
        return requests.get(url,**kwargs)
    with _LOCK:
        cookie=_load(origin)
        response=_fetch(url,cookie=cookie,kwargs=kwargs)
        if not _requires_login(response,origin):
            return response
        # The cookie might have expired or be invalidated by a rotated secret.
        # Never mistake an authentication challenge for an absent Worker.
        cookie=_exchange_password(origin)
        response=_fetch(url,cookie=cookie,kwargs=kwargs)
        if _requires_login(response,origin):
            raise RuntimeError('Open Reader session was rejected immediately after successful login; '
                               'check Worker secrets and the production hostname.')
        return response
