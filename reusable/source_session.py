"""Rate-conscious browser access with native Firefox and optional Playwright Chromium.

This module deliberately DOES NOT disguise WebDriver, spoof browser fingerprints,
rotate identities/proxies, defeat CAPTCHA, import unrelated browser cookies, or
circumvent rate limits. Every source domain/browser gets its own dedicated persistent profile.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit


class SourceAccessPaused(RuntimeError):
    """Source site asked us to wait or requires manual intervention."""
    def __init__(self, reason: str, resume_at_utc: str | None = None):
        self.reason = reason
        self.resume_at_utc = resume_at_utc
        super().__init__(reason + (f"; earliest retry {resume_at_utc}" if resume_at_utc else ""))


class SourceManualActionRequired(SourceAccessPaused):
    """A headless source session must be reopened visibly for human action."""


CHALLENGE_OBSERVATION_SECONDS = 20.0


def _operator_requested_stop():
    """Nonblocking console check: Q is optional; Ctrl+C always works.

    Never call input() while a challenge might clear on its own. This reads
    only the local terminal, not the website or browser.
    """
    if not sys.stdin.isatty():
        return False
    if os.name == 'nt':
        try:
            import msvcrt
            while msvcrt.kbhit():
                if msvcrt.getwch().lower() == 'q':
                    return True
        except (ImportError, OSError):
            pass
    else:
        try:
            import select
            if select.select([sys.stdin], [], [], 0)[0]:
                return sys.stdin.readline().strip().lower() in ('q', 'quit', 'stop', 'exit')
        except (OSError, ValueError):
            pass
    return False


def _passive_reader_ready(page, requested_url):
    """One read-only observation of the existing document, NEVER navigation.

    Calling content() also updates the cached URL of the extension's BridgePage
    after a browser-initiated redirect. Neither content(), classify, nor
    reader_ready() requests the source website or changes its scroll position.
    """
    page.content()
    requested = urlsplit(requested_url)
    landed = urlsplit(getattr(page, 'url', '') or '')
    if (landed.scheme not in ('http', 'https') or
            requested.hostname != landed.hostname or
            requested.path.rstrip('/') != landed.path.rstrip('/')):
        return False, 'browser is not showing the requested chapter'
    state = classify_browser_page(page)
    if state is not None:
        return False, f'page still reports {state}'
    checker = getattr(page, 'reader_ready', None)
    if callable(checker):
        return (True, 'reader DOM is ready') if checker() else (False, 'reader is not ready')
    # Other Playwright page implementations lack reader_ready(). Inspect
    # document structure and decoded content without clicking or scrolling.
    ready = page.evaluate(r"""() => {
      const root=document.querySelector('main,article,[role="main"]');
      if(!root) return false;
      return [...root.querySelectorAll('img')].some(im =>
        im.complete && im.naturalWidth>0 && im.naturalHeight>0);
    }""")
    return (True, 'reader content is present') if ready else (False, 'reader image not decoded')


def wait_for_manual_source_access(page, url, guard, *, visible=True, reason='human verification'):
    """Wait, then passively inspect the already-open browser every 20 seconds.

    During each whole sleep interval Python performs NO browser RPC, page
    navigation, scroll, fetch, or image capture. The next single observation
    reads the current DOM; it cannot reset an automatically clearing challenge.
    Actual 429/Retry-After and denied network requests are never retried here.
    """
    host = safe_host(url)
    if not visible:
        guard.emit('SOURCE_VISIBLE_BROWSER_REQUIRED', host=host, reason=reason)
        raise SourceManualActionRequired(
            f'{host} requires manual interaction ({reason}); reopen the saved profile visibly')
    guard.emit('SOURCE_HUMAN_INTERVENTION_REQUIRED', host=host, reason=reason)
    print('\n' + '=' * 70, flush=True)
    print('SOURCE WEBSITE NEEDS YOUR ATTENTION:', host, flush=True)
    print('Reason:', reason, flush=True)
    print('Browser left completely alone for 20 seconds at a time.', flush=True)
    print('The archiver checks ONLY the existing tab DOM between pauses.', flush=True)
    print('It resumes automatically when the requested chapter is ready.', flush=True)
    print('If manual verification is required, complete it normally in the tab.', flush=True)
    print('Press Q to stop at the next check, or Ctrl+C immediately.', flush=True)
    print('=' * 70, flush=True)
    check = 0
    while True:
        try:
            # No periodic callback, browser manipulation, or source requests.
            time.sleep(CHALLENGE_OBSERVATION_SECONDS)
        except KeyboardInterrupt as exc:
            raise SourceAccessPaused('Challenge wait stopped; checkpoint preserved') from exc
        if _operator_requested_stop():
            raise SourceAccessPaused('Operator stopped challenge wait; checkpoint preserved')
        check += 1
        try:
            ready, detail = _passive_reader_ready(page, url)
        except Exception as exc:
            # A transient browser navigation can invalidate the old document.
            # Do NOT navigate again or turn it into a source traffic loop.
            ready, detail = False, f'page observation unavailable: {type(exc).__name__}'
        if ready:
            guard.emit('SOURCE_PASSIVE_CHALLENGE_CLEARED', host=host,
                       checks=check, verification='existing-tab-reader-dom')
            print(f'Chapter ready after {check} passive check(s). Continuing without reloading.',
                  flush=True)
            # This represents confirmed in-tab document readiness, NOT a new
            # HTTP response. The original 200 challenge response is obsolete.
            from types import SimpleNamespace
            return SimpleNamespace(url=page.url, status=200, headers={})
        guard.emit('SOURCE_PASSIVE_CHALLENGE_PENDING', host=host,
                   checks=check, reason=detail)
        print(f'Passive check {check}: {detail}; sleeping another 20 seconds.', flush=True)


def safe_host(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"Not a valid HTTP(S) website: {url!r}")
    return parsed.hostname.lower()


def profile_directory(data_dir: Path, source_url: str, *, browser="firefox") -> Path:
    """Domain-based and isolated; never read Chrome/Firefox's real user profile."""
    host = safe_host(source_url)
    digest = hashlib.sha256(host.encode("utf-8")).hexdigest()[:12]
    name = re.sub(r"[^a-z0-9]+", "-", host).strip("-")[:60]
    return data_dir / "source_browser_profiles" / browser / f"{name}-{digest}"


def source_profile_marker(data_dir: Path, source_url: str, *, browser='firefox') -> Path:
    return profile_directory(data_dir, source_url, browser=browser) / 'source_session_verified.json'


def should_run_headless(data_dir: Path, source_url: str, *, browser='firefox') -> bool:
    """Headless only after the same browser profile has successfully loaded a source."""
    marker = source_profile_marker(data_dir, source_url, browser=browser)
    try:
        return bool(json.loads(marker.read_text(encoding='utf-8')).get('verified'))
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return False


def mark_source_session_ready(data_dir: Path, source_url: str, *, browser='firefox'):
    marker = source_profile_marker(data_dir, source_url, browser=browser)
    marker.parent.mkdir(parents=True, exist_ok=True)
    tmp = marker.with_suffix('.tmp')
    tmp.write_text(json.dumps({'verified': True, 'browser': browser,
                               'verified_at_utc': datetime.now(timezone.utc).isoformat()}), encoding='utf-8')
    os.replace(tmp, marker)


def open_source_context(playwright, data_dir: Path, source_url: str,
                        *, headless=None, browser='firefox'):
    """Dedicated persistent Playwright context, optionally running headless.

    Firefox is default, matching the user's working Selenium approach, but
    Chromium supports headless persistent contexts too. Lazy loading is still
    driven by the same scroll/MutationObserver logic in either browser.
    The browser stores session state in an application-owned per-host profile.
    No normal Firefox or Chrome profile is read or modified.
    """
    if browser not in ('firefox', 'chromium'):
        raise ValueError(f'Unsupported source browser {browser!r}')
    profile = profile_directory(data_dir, source_url, browser=browser)
    profile.parent.mkdir(parents=True, exist_ok=True)
    if headless is None:
        headless = should_run_headless(data_dir, source_url, browser=browser)
    if headless and not should_run_headless(data_dir, source_url, browser=browser):
        raise RuntimeError('First source-browser session must be visible. Run --source-login or --archive without --source-headless first.')
    try:
        browser_type = getattr(playwright, browser)
        return browser_type.launch_persistent_context(
            user_data_dir=str(profile), headless=headless,
            viewport={'width': 1300, 'height': 1000}, accept_downloads=False)
    except Exception as exc:
        raise RuntimeError(f'Could not open {browser} source profile {profile}. '
            'Close other archiver processes using this profile and retry; '
            'the profile has not been deleted. Details: ' + str(exc)) from exc


from contextlib import contextmanager


@contextmanager
def source_browser_context(data_dir: Path, source_url: str, *, headless=None,
                           browser='firefox', reader_selectors=(), initial_chapter_url=None):
    """Shared browser API; installed Firefox is ALWAYS visible.

    Only the transport differs. Crawling, selectors, chapter navigation,
    session/access policies and data persistence remain reusable.
    """
    if browser == 'extension':
        from .browser_bridge import source_extension_context
        from site_specific import site_adapter
        with source_extension_context(data_dir, source_url, adapter=site_adapter,
                                      reader_selectors=reader_selectors,
                                      initial_chapter_url=initial_chapter_url) as ctx:
            yield ctx
    elif browser == 'firefox':
        if headless is True:
            print('Installed Firefox mode is always visible; ignoring --source-headless.', flush=True)
        from .native_firefox import open_native_firefox
        ctx = open_native_firefox(data_dir, source_url,
                                  reader_selectors=reader_selectors)
        try:
            yield ctx
        finally:
            ctx.close()
    else:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = open_source_context(pw, data_dir, source_url,
                                      headless=headless, browser=browser)
            try:
                yield ctx
            finally:
                ctx.close()


def retry_after_seconds(header: str | None, *, now: float | None = None) -> float | None:
    if not header:
        return None
    text = header.strip()
    try:
        return max(0.0, float(text))
    except (TypeError, ValueError):
        pass
    try:
        date = parsedate_to_datetime(text)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0.0, date.timestamp() - (time.time() if now is None else now))
    except (TypeError, ValueError, OverflowError):
        return None


class SourceRequestGuard:
    """Gentle per-host pacing and durable server-directed cooldowns.

    A 429 is NOT a reason to switch proxy/account or evade detection; archive
    state remains intact and the operator can rerun after the cooldown.
    """
    def __init__(self, data_dir: Path, *, min_interval_seconds: float = 1.5,
                 max_inline_wait_seconds: float = 25.0, emit=None):
        self.path = data_dir / "source_cooldowns.json"
        self.min_interval_seconds = max(0.0, float(min_interval_seconds))
        self.max_inline_wait_seconds = max(0.0, float(max_inline_wait_seconds))
        self.emit = emit or (lambda event, **fields: None)
        self.next_request_monotonic: dict[str, float] = {}
        self.cooldowns: dict[str, float] = {}
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self.cooldowns = {str(k): float(v) for k, v in raw.items() if float(v) > time.time()}
            except (OSError, ValueError, TypeError):
                self.emit("SOURCE_COOLDOWN_STATE_INVALID", path=str(self.path))

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cooldowns, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def before(self, url: str, *, operation: str = "request"):
        host = safe_host(url)
        now = time.time()
        remains_cooldown = max(0.0, self.cooldowns.get(host, 0) - now)
        remains_pacing = max(0.0, self.next_request_monotonic.get(host, 0) - time.monotonic())
        delay = max(remains_cooldown, remains_pacing)
        if delay > self.max_inline_wait_seconds:
            next_utc = datetime.fromtimestamp(now + delay, tz=timezone.utc).isoformat(timespec="seconds")
            self.emit("SOURCE_WAIT_REQUIRED", host=host, operation=operation,
                      remaining_seconds=round(delay, 2), resume_at_utc=next_utc)
            raise SourceAccessPaused(f"Source host {host} requires a cooldown", next_utc)
        if delay > 0:
            self.emit("SOURCE_PACING", host=host, operation=operation, wait_seconds=round(delay, 2))
            time.sleep(delay)
        self.next_request_monotonic[host] = time.monotonic() + self.min_interval_seconds

    def response(self, url: str, status: int, headers: dict | None = None):
        host = safe_host(url)
        headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        if status == 429:
            # If Retry-After isn't supplied, take a conservative pause and stop.
            seconds = retry_after_seconds(headers.get("retry-after"))
            seconds = max(60.0, seconds if seconds is not None else 120.0)
            self.cooldowns[host] = max(self.cooldowns.get(host, 0), time.time() + seconds)
            self._save()
            resume = datetime.fromtimestamp(self.cooldowns[host], timezone.utc).isoformat(timespec="seconds")
            self.emit("SOURCE_RATE_LIMITED", host=host, status=status,
                      retry_after_seconds=round(seconds, 2), resume_at_utc=resume)
            raise SourceAccessPaused(f"HTTP 429 from {host}; respecting server retry window", resume)
        if status in (401, 403):
            self.emit("SOURCE_ACCESS_DENIED", host=host, status=status)
            raise SourceAccessPaused(f"HTTP {status} from {host}; check site access in a normal visible browser; no bypass attempted")


def classify_browser_page(page) -> str | None:
    """Detect obvious authentication walls and automated-access challenges.

    Avoid broad keyword searches in body text, which cause false alarms for
    stories mentioning words like 'login' or 'captcha'.
    """
    url = (page.url or "").lower()
    if re.search(r"(?:^|/)(?:login|sign-in|signin|auth/login)(?:/|$|\?)", urlsplit(url).path):
        return "login"
    try:
        state = page.evaluate(r"""() => {
          const visible = el => {
            const r=el.getBoundingClientRect(), s=getComputedStyle(el);
            return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';
          };
          const login=[...document.querySelectorAll('form input[type=password]')].some(visible);
          // Ignore ONLY the passive corner badge, not a displayed verification form.
          const passiveRecaptchaBadge = el => !!el.closest('.grecaptcha-badge');
          const challenge=[...document.querySelectorAll(
            'iframe[src*="captcha" i], iframe[title*="captcha" i], #challenge-running, .cf-challenge, input[name*="captcha" i], .g-recaptcha, [data-sitekey]'
          )].some(el => visible(el) && !passiveRecaptchaBadge(el));
          return {login, challenge, title:document.title||''};
        }""")
    except Exception:
        return None
    if state.get("challenge") or re.search(r"(?:attention required|just a moment|verify you are human)", state.get("title", ""), re.I):
        return "challenge"
    if state.get("login"):
        return "login"
    return None


def visit_source_page(page, url, guard: SourceRequestGuard, *, visible=True, login_prompt=True):
    """Navigate normally; let a human handle access checks in a visible tab.

    HTTP 429 and long server-directed cooldowns remain hard stops. A browser
    challenge is observed passively until the already-open tab displays a
    ready reader; no repeated HTTP navigation is used to force clearance.
    """
    guard.before(url, operation="navigation")
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=50000)
    except Exception:
        # Some human-verification interstitials never finish DOMContentLoaded.
        # Let the human handle an actually visible challenge, but do not turn
        # unrelated navigation failures into infinite manual-prompt loops.
        state = classify_browser_page(page)
        if state in ('challenge', 'login'):
            return wait_for_manual_source_access(page, url, guard, visible=visible,
                                                 reason=f'{state} during navigation')
        raise
    if response is not None and response.status not in (401, 403):
        guard.response(response.url, response.status, response.headers)
    state = classify_browser_page(page)
    status = getattr(response, 'status', None)
    reason = None
    if state == 'challenge':
        reason = 'human-verification / bot-check page'
        guard.emit('SOURCE_CHALLENGE_DETECTED', host=safe_host(url), status=status)
    elif state == 'login':
        reason = 'site sign-in required'
    elif status in (401, 403):
        reason = f'HTTP {status} (possible access check or site denial)'
    elif getattr(page, 'is_native_firefox', False) and not page.reader_ready():
        reason = 'reader content not accessible yet in installed Firefox'
    if reason:
        if state == 'login' and not login_prompt:
            raise SourceAccessPaused('Source needs interactive sign-in; run --source-login')
        return wait_for_manual_source_access(page, url, guard, visible=visible, reason=reason)
    return response
