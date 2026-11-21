"""Genuine installed Mozilla Firefox source transport (Selenium/GeckoDriver).

This is NOT Playwright's specially built Firefox.  It selects the actual
Firefox.exe installed on Windows and keeps a private, persistent source profile.
Selenium is standard WebDriver automation: it does NOT hide the automation
flag, solve challenges, change security settings or circumvent access controls.
The website may still refuse automation even after human interaction.

Expose only the small Playwright-shaped interface used by the REUSABLE
archiver; all comic selectors and URL parsing remain in site_adapter.py.
"""
from __future__ import annotations

import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import requests


def installed_firefox_binary() -> Path:
    """Fail rather than silently install/use the Playwright Firefox build."""
    locations = []
    supplied = os.environ.get('COMIC_ARCHIVER_FIREFOX_BINARY', '').strip().strip('"')
    if supplied:
        locations.append(Path(supplied))
    for env in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'):
        root = os.environ.get(env)
        if root:
            if env == 'LOCALAPPDATA':
                locations.append(Path(root) / 'Programs' / 'Mozilla Firefox' / 'firefox.exe')
            else:
                locations.append(Path(root) / 'Mozilla Firefox' / 'firefox.exe')
    if os.name == 'nt':
        locations.extend((Path(r'C:\Program Files\Mozilla Firefox\firefox.exe'),
                          Path(r'C:\Program Files (x86)\Mozilla Firefox\firefox.exe')))
    binary = shutil.which('firefox.exe' if os.name == 'nt' else 'firefox')
    if binary:
        locations.append(Path(binary))
    # HKLM/HKCU registry is a secondary locator for nonstandard installs.
    if os.name == 'nt':
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                for base in (r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
                             r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe'):
                    try:
                        with winreg.OpenKey(hive, base) as key:
                            path, _ = winreg.QueryValueEx(key, '')
                            locations.append(Path(path))
                    except OSError:
                        pass
        except ImportError:
            pass
    for path in locations:
        if path.is_file() and path.name.lower() in ('firefox.exe', 'firefox'):
            return path.resolve()
    raise RuntimeError('Installed Mozilla Firefox (firefox.exe) was not found. Install normal Firefox '
                       'from mozilla.org, or set COMIC_ARCHIVER_FIREFOX_BINARY to its full path. '
                       'Playwright Firefox is deliberately not used.')


@dataclass
class BrowserResponse:
    url: str
    status: int  # HTML/DOM classification, not a raw network status
    headers: dict
    status_verified: bool = False


class NativeLocator:
    def __init__(self, page, selector: str):
        self.page = page
        self.selector = selector

    def count(self) -> int:
        from selenium.webdriver.common.by import By
        self.page._activate()
        return len(self.page.context.driver.find_elements(By.CSS_SELECTOR, self.selector))

    @property
    def first(self):
        return self

    def click(self, timeout=2500):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        self.page._activate()
        el = WebDriverWait(self.page.context.driver, max(1.0, timeout / 1000.0)).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, self.selector)))
        el.click()


class NativeFirefoxPage:
    is_native_firefox = True

    def __init__(self, context, handle):
        self.context, self.handle = context, handle
        self._closed = False

    def _activate(self):
        if self._closed:
            raise RuntimeError('Source Firefox tab is already closed')
        if self.context._closed:
            raise RuntimeError('Source Firefox has already been closed')
        self.context.driver.switch_to.window(self.handle)

    @property
    def url(self):
        self._activate()
        return self.context.driver.current_url

    def content(self):
        self._activate()
        return self.context.driver.page_source

    def evaluate(self, source: str):
        self._activate()
        # The engine/site adapter pass a JavaScript arrow FUNCTION, not a raw
        # statement. Execute it unmodified in the actual Firefox DOM.
        script = source.strip()
        return self.context.driver.execute_script('return (' + script + ')();')

    def locator(self, selector: str):
        return NativeLocator(self, selector)

    def wait_for_timeout(self, milliseconds: float):
        time.sleep(milliseconds / 1000.0)

    def reader_ready(self) -> bool:
        """Generic evidence of a real reader, using adapter-provided selectors."""
        selectors = list(self.context.reader_selectors)
        if not selectors:
            return False
        try:
            self._activate()
            return bool(self.context.driver.execute_script(
                '''const selectors = arguments[0];
                   return selectors.some(sel => {
                     try { const root = document.querySelector(sel);
                       return root && root.querySelectorAll('img').length >= 1; }
                     catch (_) { return false; }
                   });''', selectors))
        except Exception:
            return False

    def _page_response(self):
        self._activate()
        state = self.context.driver.execute_script('''
          return {title: document.title || '', text:
            (document.body && document.body.innerText || '').slice(0, 650)};
        ''') or {}
        title = str(state.get('title', '')).lower()
        text = str(state.get('text', '')).strip().lower()
        # WebDriver does not expose HTTP status. Treat obvious error pages as
        # denied and treat HTTP 429 content as a cooldown, never as success.
        if re.search(r'(?:^|\b)(?:429|too many requests|rate limit exceeded)(?:\b|$)', title) or re.match(
                r'^(?:error\s*)?429\b|^too many requests\b', text):
            status = 429
        elif (re.search(r'(?:403|forbidden|access denied|blocked|just a moment|attention required)', title)
              or re.match(r'^(?:error\s*)?403\b|^(?:access denied|you have been blocked|sorry, you have been blocked)', text)
              or re.search(r'\berror\s*1020\b', text)):
            status = 403
        else:
            status = 200  # Tentative: reader_ready() is required for manual clearance.
        return BrowserResponse(self.context.driver.current_url, status, {})

    def goto(self, url: str, *, wait_until='domcontentloaded', timeout=50000):
        from selenium.common.exceptions import TimeoutException
        self._activate()
        self.context.driver.set_page_load_timeout(max(5, timeout / 1000.0))
        try:
            self.context.driver.get(url)
        except TimeoutException:
            # Some challenge interstitials deliberately postpone page load.
            # Return a classified page if its DOM is accessible; otherwise
            # propagate so the source guard decides whether to prompt.
            try:
                return self._page_response()
            except Exception:
                raise
        return self._page_response()

    def close(self):
        """Reusable callers close chapter *views*, not the persistent Firefox tab.

        The normal crawler calls page.close() after every discovery/chapter.
        For installed Firefox, these are aliases of ONE original tab: never
        close it or require a new challenge for the next chapter.  The owning
        context is closed only once the source-archive session has finished.
        """
        return


class NativeImageReply:
    def __init__(self, reply):
        self.status = reply.status_code
        self.url = reply.url
        self.headers = dict(reply.headers)
        self.ok = reply.ok
        self._raw = reply.content

    def body(self):
        return self._raw


class NativeImageRequest:
    def __init__(self, context):
        self.context = context

    def get(self, url, *, headers=None, timeout=45000):
        # Reuse only cookies the website deliberately stored in this dedicated
        # human-controlled Firefox profile. No fingerprint spoofing or proxy
        # rotation. The CDN's real HTTP status is enforced by the core engine.
        session = requests.Session()
        try:
            browser = self.context.driver
            for cookie in browser.get_cookies():
                scope = {'path': cookie.get('path') or '/'}
                if cookie.get('domain'):
                    scope['domain'] = cookie['domain']
                session.cookies.set(cookie['name'], cookie['value'], **scope)
            result = session.get(url, headers=headers, timeout=timeout / 1000.0)
            return NativeImageReply(result)
        finally:
            session.close()


class NativeFirefoxContext:
    is_native_firefox = True

    def __init__(self, driver, *, reader_selectors=()):
        self.driver = driver
        self.reader_selectors = tuple(reader_selectors)
        self._closed = False
        # Exactly ONE original source tab for the entire source archive run.
        # All generic new_page()/close() operations reuse this same view.
        # In particular, discovering chapters must not open 98 new tabs.
        self._source_tab = NativeFirefoxPage(self, driver.current_window_handle)
        self.request = NativeImageRequest(self)

    @property
    def pages(self):
        if self._closed:
            return []
        return [self._source_tab]

    def new_page(self):
        if self._closed:
            raise RuntimeError('Native Firefox context already closed')
        # Do not open a second tab. Reuse the same WebDriver session, window,
        # cookies, history, and source-browser profile for every chapter.
        return self._source_tab

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.driver.quit()


def open_native_firefox(data_dir: Path, source_url: str, *, reader_selectors=()):
    try:
        from selenium import webdriver
        from selenium.webdriver.firefox.options import Options
    except ImportError as exc:
        raise RuntimeError('Selenium is required for installed Firefox. Install it with '
                           'python -m pip install -r requirements.txt, then rerun python run.py') from exc
    from .source_session import profile_directory
    binary = installed_firefox_binary()
    profile = profile_directory(data_dir, source_url, browser='firefox-native')
    profile.mkdir(parents=True, exist_ok=True)
    options = Options()
    options.binary_location = str(binary)
    # -profile (NOT options.profile) tells geckodriver to use the exact source
    # directory, not a temporary copy, preserving user-entered challenges.
    options.add_argument('-profile')
    options.add_argument(str(profile.resolve()))
    print('Installed Mozilla Firefox:', binary, flush=True)
    print('Persistent source Firefox profile:', profile, flush=True)
    print('Keeping ONE Firefox tab for all chapter navigation, discovery, and downloads.', flush=True)
    print('The browser will stay VISIBLE for any manual website verification.', flush=True)
    try:
        driver = webdriver.Firefox(options=options)
    except Exception as exc:
        raise RuntimeError('Could not launch the INSTALLED Mozilla Firefox with GeckoDriver. '
                           'Close any other archiver session using this dedicated profile. '
                           'Selenium Manager may need network access to install GeckoDriver; '
                           'normal Firefox must already be installed. Details: ' + str(exc)) from exc
    try:
        driver.set_script_timeout(45)
        return NativeFirefoxContext(driver, reader_selectors=reader_selectors)
    except Exception:
        driver.quit()
        raise
