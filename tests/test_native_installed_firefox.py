"""Offline contract tests for installed Firefox without actual browser/network access."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reusable import native_firefox as nf
from reusable import source_session as sess


class InstalledFirefoxContract(unittest.TestCase):
    def test_installed_binary_precedes_bundled_playwright_browser(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / 'firefox.exe'
            binary.write_bytes(b'fake for path selection test')
            with patch.dict(os.environ, {'COMIC_ARCHIVER_FIREFOX_BINARY': str(binary)}):
                self.assertEqual(nf.installed_firefox_binary(), binary)

    def test_missing_installed_firefox_does_not_fall_back_to_playwright_build(self):
        with patch.dict(os.environ, {'COMIC_ARCHIVER_FIREFOX_BINARY': '/nonexistent/firefox.exe'}, clear=True), \
             patch.object(nf.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Installed Mozilla Firefox'):
                nf.installed_firefox_binary()

    def test_native_context_uses_real_firefox_and_dedicated_persistent_profile(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / 'firefox.exe'
            binary.touch()
            calls = []
            driver = SimpleNamespace(set_script_timeout=lambda x: calls.append(('script_timeout', x)), current_window_handle='first-tab')
            class FakeOpts:
                def __init__(self):
                    self.arguments = []
                    self.binary_location = None
                def add_argument(self, val):
                    self.arguments.append(val)
            firefox_mod = types.ModuleType('selenium.webdriver.firefox')
            firefox_opts_mod = types.ModuleType('selenium.webdriver.firefox.options')
            firefox_opts_mod.Options = FakeOpts
            webdriver = types.ModuleType('selenium.webdriver')
            webdriver.Firefox = lambda options: (calls.append(('firefox', options)) or driver)
            selenium = types.ModuleType('selenium')
            selenium.webdriver = webdriver
            with patch.dict(sys.modules, {
                'selenium': selenium,
                'selenium.webdriver': webdriver,
                'selenium.webdriver.firefox': firefox_mod,
                'selenium.webdriver.firefox.options': firefox_opts_mod,
            }), patch.object(nf, 'installed_firefox_binary', return_value=binary):
                ctx = nf.open_native_firefox(Path(td), 'https://example.org/ch1',
                                             reader_selectors=['.chapter-images'])
            args = calls[0][1]
            self.assertEqual(args.binary_location, str(binary))
            self.assertEqual(args.arguments[0], '-profile')
            self.assertIn('firefox-native', args.arguments[1])
            self.assertNotIn('-headless', args.arguments)
            self.assertTrue(Path(args.arguments[1]).is_dir())
            self.assertEqual(ctx.reader_selectors, ('.chapter-images',))
            driver.quit = lambda: calls.append(('quit',))
            ctx.close()
            ctx.close()
            self.assertEqual(calls[-1], ('quit',))

    def test_first_manual_confirmation_checks_existing_tab_not_reloads(self):
        target = 'https://example.org/chapter-1'
        with tempfile.TemporaryDirectory() as td:
            events = []
            guard = sess.SourceRequestGuard(Path(td), min_interval_seconds=0,
                emit=lambda name, **kwargs: events.append(name))
            class Page:
                is_native_firefox = True
                url = target
                def __init__(self):
                    self.calls = 0
                def goto(self, *args, **kwargs):
                    self.calls += 1
                    return SimpleNamespace(url=target,status=403,headers={})
                def reader_ready(self):
                    return self.calls == 1
                def _page_response(self):
                    return SimpleNamespace(url=target,status=200,headers={},status_verified=False)
            page = Page()
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', return_value=''), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                response = sess.visit_source_page(page, target, guard, visible=True)
            self.assertEqual(page.calls, 1)
            self.assertEqual(response.status, 200)
            self.assertIn('SOURCE_HUMAN_INTERVENTION_VERIFIED', events)

    def test_native_browser_requires_actual_reader_content_not_just_absent_captcha(self):
        target = 'https://example.org/chapter-1'
        with tempfile.TemporaryDirectory() as td:
            guard = sess.SourceRequestGuard(Path(td), min_interval_seconds=0)
            class Page:
                is_native_firefox = True
                url = target
                def reader_ready(self): return False
                def goto(self, *args, **kwargs):
                    return SimpleNamespace(url=target,status=200,headers={})
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', return_value='q'), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                with self.assertRaisesRegex(sess.SourceAccessPaused, 'Operator stopped'):
                    sess.visit_source_page(Page(), target, guard)

    def test_source_browser_context_does_not_construct_playwright_firefox(self):
        fake = SimpleNamespace(close=lambda:None)
        with patch.object(nf, 'open_native_firefox', return_value=fake) as open_installed:
            with sess.source_browser_context(Path('/tmp'), 'https://example.org/',
                                             browser='firefox', reader_selectors=['.comic']) as ctx:
                self.assertIs(ctx, fake)
        self.assertEqual(open_installed.call_args.kwargs['reader_selectors'], ['.comic'])

    def test_entire_chapter_run_reuses_original_window_after_close(self):
        """Generic engine opens/closes chapter views; native Firefox must not."""
        class WindowSwitch:
            def __init__(self):
                self.selected = []
            def window(self, handle):
                self.selected.append(handle)
            def new_window(self, kind):
                raise AssertionError('Opening a fresh tab loses manual site verification')
        class Driver:
            current_window_handle = 'source-original-tab'
            window_handles = ['source-original-tab']
            current_url = 'about:blank'
            switch_to = WindowSwitch()
            def __init__(self):
                self.visited = []
                self.quit_calls = 0
            def get(self, url):
                self.current_url = url
                self.visited.append(url)
            def set_page_load_timeout(self, value):
                pass
            def execute_script(self, source, *args):
                if 'document.title' in source:
                    return {'title':'Chapter reader', 'text':'Comic images'}
                return None
            def quit(self):
                self.quit_calls += 1
        driver = Driver()
        context = nf.NativeFirefoxContext(driver, reader_selectors=['.reading-content'])
        anchor = context.pages[0]
        chapter_urls = [f'https://example.org/chapter-{n}' for n in range(1, 99)]
        selenium_mod = types.ModuleType('selenium')
        common_mod = types.ModuleType('selenium.common')
        exceptions_mod = types.ModuleType('selenium.common.exceptions')
        exceptions_mod.TimeoutException = type('TimeoutException', (Exception,), {})
        with patch.dict(sys.modules, {'selenium': selenium_mod,
                                      'selenium.common': common_mod,
                                      'selenium.common.exceptions': exceptions_mod}):
            for url in chapter_urls:
                page = context.new_page()
                self.assertIs(page, anchor)
                response = page.goto(url)
                self.assertEqual(response.url, url)
                page.close()  # simulated generic engine per-chapter cleanup
                self.assertEqual(context.pages, [anchor])
                self.assertEqual(driver.window_handles, ['source-original-tab'])
                self.assertEqual(driver.quit_calls, 0)
        self.assertEqual(driver.visited, chapter_urls)
        context.close()
        self.assertEqual(driver.quit_calls, 1)

    def test_native_firefox_image_requests_do_not_navigate_or_close_source_tab(self):
        """CDN bytes use ordinary requests while Firefox stays on the chapter."""
        class Driver:
            current_window_handle = 'original'
            window_handles = ['original']
            current_url = 'https://example.org/chapter-1/'
            def __init__(self):
                self.switch_to = SimpleNamespace(window=lambda h:None, new_window=lambda x: (_ for _ in ()).throw(AssertionError('new tab')))
                self.quits = 0
            def get_cookies(self):
                return [{'name':'session','value':'v','domain':'example.org','path':'/'}]
            def quit(self):
                self.quits += 1
        drv = Driver()
        ctx = nf.NativeFirefoxContext(drv)
        response = SimpleNamespace(status_code=200, url='https://example.org/image.jpg', headers={},
                                   content=b'bytes', ok=True)
        with patch.object(nf.requests.Session, 'get', return_value=response):
            r = ctx.request.get('https://example.org/image.jpg')
        self.assertEqual(r.body(), b'bytes')
        self.assertEqual(drv.current_url, 'https://example.org/chapter-1/')
        self.assertEqual(drv.quits, 0)
        ctx.close()

    def test_manual_exit_never_declares_a_blocked_source_ready(self):
        target = 'https://example.org/chapter-1'
        with tempfile.TemporaryDirectory() as td:
            guard = sess.SourceRequestGuard(Path(td), min_interval_seconds=0)
            page = SimpleNamespace(is_native_firefox=True,url=target,
                                   reader_ready=lambda:False,
                                   goto=lambda *a, **kw: SimpleNamespace(url=target,status=403,headers={}))
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', side_effect=['', 'q']), \
                 patch.object(sess, 'classify_browser_page', return_value='challenge'):
                with self.assertRaises(sess.SourceAccessPaused):
                    sess.wait_for_manual_source_access(page,target,guard,visible=True)


if __name__=='__main__':
    unittest.main()
