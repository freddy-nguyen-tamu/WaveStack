"""Cooperative, unlimited waits for explicit GitHub throttling only.
Never suppress permission, quota-capacity, integrity or ambiguous write errors.
"""
import math
import re
import subprocess
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from itertools import count


def backoff(attempt):
    # Unlimited number of cooldowns; cap the delay, not the retry count.
    return min(3600, 60 * (2 ** min(attempt, 6)))


def response_delay(response, attempt=0, now=None):
    if response.status_code not in (403, 429):
        return None
    headers = {str(k).lower(): str(v) for k,v in response.headers.items()}
    message = str(response.text).lower()
    primary = headers.get('x-ratelimit-remaining') == '0'
    if not (primary or response.status_code == 429 or headers.get('retry-after') or 'secondary rate limit' in message or 'abuse detection' in message or 'api rate limit exceeded' in message):
        return None
    now = time.time() if now is None else now
    delay = backoff(attempt)
    retry = headers.get('retry-after')
    if retry:
        try: value = float(retry)
        except ValueError:
            try: value = parsedate_to_datetime(retry).timestamp() - now
            except (TypeError, ValueError, OverflowError): value = 0
        if math.isfinite(value): delay = max(delay, value)
    if primary:
        try:
            value = float(headers['x-ratelimit-reset']) - now + 3
            if math.isfinite(value): delay = max(delay, value)
        except (ValueError, KeyError): pass
    return delay


def git_throttled(message):
    if isinstance(message, bytes): message = message.decode('utf-8','replace')
    msg = str(message or '').lower()
    return bool('secondary rate limit' in msg or 'api rate limit' in msg or re.search(r'(?:\bhttp\s+429\b|\b(?:error|returned error|status(?: code)?)[ :]+429\b|\btoo many requests\b|\b(?:secondary |api )?rate limit(?:ed| exceeded| reached|ing)\b|\babuse detection\b)', msg))


def wait(delay, reason, sleep=None):
    wake = datetime.fromtimestamp(time.time()+delay,timezone.utc).isoformat(timespec='seconds')
    print(f'WAIT_GITHUB_LIMIT: {reason}; sleeping {delay:.0f}s until {wake}. No retry-count limit; Ctrl+C to stop safely.',flush=True)
    (sleep or time.sleep)(delay)


def git_run(cmd, **kwargs):
    """Retry explicit throttles on ordinary remote Git operations. For pushes,
    inspect the ref after the cooldown, and replay only the identical non-force
    commit if needed. The callers still perform their usual remote verification.
    """
    if len(cmd)<2 or cmd[1] not in ('push','fetch','ls-remote','clone'):
        return subprocess.run(cmd,**kwargs)
    push = cmd[1]=='push'
    m = re.fullmatch(r'([0-9a-f]{40,64}):(refs/heads/[A-Za-z0-9_.\-/]+)',str(cmd[3])) if push and len(cmd)==4 else None
    for attempt in count():
        p = subprocess.run(cmd,**kwargs)
        if not p.returncode or not git_throttled(p.stderr): return p
        # Unknown or destructive refspecs retain their original behavior.
        if push and not m: return p
        wait(backoff(attempt),'Git transport rate limit')
        if push:
            check = git_run([cmd[0],'ls-remote',cmd[2],m[2]], cwd=kwargs.get('cwd'), env=kwargs.get('env'), capture_output=True, timeout=120)
            if check.returncode: return p
            out = check.stdout.decode('utf-8','replace') if isinstance(check.stdout,bytes) else check.stdout
            if out.strip().split()[:1]==[m[1]]:
                # Exact commit already reached remote. Do not replay.
                return subprocess.CompletedProcess(cmd,0,'' if isinstance(p.stdout,str) else b'', '' if isinstance(p.stderr,str) else b'')
            # Non-force Git rejects concurrent incompatible changes.


class GitBatchTooLarge(RuntimeError):
    """Explicit server rejection of aggregate push size, not a permission error."""

def git_size_rejected(message):
    if isinstance(message, bytes): message=message.decode('utf-8','replace')
    return bool(re.search(r'pack exceeds maximum allowed size|push (?:is )?too large|push size limit|maximum push size|(?:http|returned error|status(?: code)?)[ :]+413\b|request entity too large|payload too large',str(message or ''),re.I))

def cloudflare_retry_delay(message, attempt=0, now=None):
    """Recognize only explicit quotas; permanent storage/asset limits do not wait."""
    msg=str(message or '').lower(); now=time.time() if now is None else now
    if re.search(r'daily (?:row |request |read |write )*(?:limit|quota)|(?:daily|per day).{0,40}(?:rows read|rows written|requests).{0,40}(?:limit|exceed)',msg):
        return max(backoff(attempt),86400-now%86400+5)
    if re.search(r'\b(?:http|status(?: code)?|returned error)[ :]+429\b|too many requests|rate limit(?:ed| exceeded| reached)',msg):
        retry=re.search(r'retry-after[\s:="\']+(\d+)',msg)
        return max(backoff(attempt),int(retry[1]) if retry else 300)
    return None
