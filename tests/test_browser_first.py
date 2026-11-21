"""Offline regression tests for URL-only, browser-first initialization."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comic_archiver as a

BASE = Path(__file__).resolve().parents[1]
HTML = '''<!doctype html><html><head><title>Ep. 1 | Demo</title><link rel="canonical" href="https://test.invalid/episode/1" /></head>
<body><a class="subj">Demo Series</a><div class="episode_lst"><li data-episode-no="1"><a href="/episode/1">Episode 1</a></li></div>
<div id="_imageList"><img src="https://cdn.invalid/1.jpg" /><img src="https://cdn.invalid/2.jpg" /></div></body></html>'''


class BrowserFirstTests(unittest.TestCase):
    def test_windows_setup_never_requests_html_file(self):
        script = (BASE / 'setup_and_publish.ps1').read_text(encoding='utf-8')
        self.assertNotIn('OpenFileDialog', script)
        self.assertNotIn('Select the saved comic reader page source', script)
        self.assertIn("STEP 1/3: GITHUB WEBSITE SIGN-IN", script)
        self.assertIn("STEP 2/3: CLOUDFLARE WEBSITE SIGN-IN", script)
        self.assertIn("STEP 3/3: OPEN COMIC WEBPAGE", script)
        self.assertIn('--default-source-url', script)
        self.assertIn("'--source-url'", script)
        self.assertLess(script.index('STEP 1/3'), script.index('STEP 2/3'))
        self.assertLess(script.index('STEP 2/3'), script.index('STEP 3/3'))

    def test_bundled_url_points_to_attached_reader(self):
        from site_specific.site_adapter import DEFAULT_START_URL
        url = DEFAULT_START_URL
        self.assertTrue(url.startswith('https://www.webtoons.com/'))
        self.assertIn('episode_no=1', url)

    def test_url_only_archive_uses_live_html_not_file_picker(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'extension').mkdir()
            (root / 'extension/manifest.json').write_text('{"content_scripts":[{"matches":["https://example.invalid/*"]}]}')
            page = MagicMock()
            page.url = 'https://test.invalid/episode/1'
            page.content.return_value = HTML
            ctx = MagicMock()
            ctx.pages = [page]
            fake_pw = MagicMock()
            with patch.object(a, 'DATA', root / 'state'), \
                 patch.object(a, 'ROOT', root), \
                 patch.object(a, 'open_source_context', return_value=ctx), \
                 patch.object(a, 'visit_source_page'), \
                 patch.object(a, 'discover_from_live', return_value=[]), \
                 patch('playwright.sync_api.sync_playwright', return_value=fake_pw):
                db = a.init_db()
                a.archive_run(db, None, 'https://test.invalid/episode/1', 0, True)
                self.assertEqual(a.get_option(db, 'series_title'), 'Demo Series')
                self.assertEqual(a.get_option(db, 'source_url'), 'https://test.invalid/episode/1')
                self.assertEqual(a.get_option(db, 'source_html_path'), None)
                page.content.assert_called_once()
                # Closing the only persistent Chromium tab can terminate the
                # context on Windows; the tab must outlive discovery.
                page.close.assert_not_called()
                ctx.close.assert_called_once()

    def test_source_anchor_stays_open_while_chapter_discovery_opens_new_tab(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'extension').mkdir()
            (root / 'extension/manifest.json').write_text('''{"content_scripts":[{"matches":["https://example.invalid/*"]}]}''')
            anchor = MagicMock()
            anchor.url = 'https://test.invalid/episode/1'
            anchor.content.return_value = HTML
            context = MagicMock()
            context.pages = [anchor]
            new_tab = MagicMock()

            def open_new_tab():
                if anchor.close.called:
                    raise RuntimeError('BrowserContext.new_page: Target page, context or browser has been closed')
                return new_tab

            context.new_page.side_effect = open_new_tab
            playwright = MagicMock()

            def simulated_discovery(ctx, *args, **kwargs):
                self.assertIs(ctx, context)
                tab = ctx.new_page()
                tab.close()
                return []

            with patch.object(a, 'DATA', root / 'state'), \
                 patch.object(a, 'ROOT', root), \
                 patch.object(a, 'open_source_context', return_value=context), \
                 patch.object(a, 'visit_source_page'), \
                 patch.object(a, 'discover_from_live', side_effect=simulated_discovery), \
                 patch('playwright.sync_api.sync_playwright', return_value=playwright):
                db = a.init_db()
                try:
                    a.archive_run(db, None, 'https://test.invalid/episode/1', 1, True)
                    self.assertFalse(anchor.close.called)
                    self.assertTrue(new_tab.close.called)
                    context.close.assert_called_once()
                finally:
                    db.close()

    def test_login_uses_provider_browser_flow_without_terminal_username(self):
        with tempfile.TemporaryDirectory() as td:
            fake_token='fake-test-token'
            p = MagicMock()
            p.returncode = 0
            p.stdout = f'protocol=https\nhost=github.com\nusername=example\npassword={fake_token}\n'
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {'login': 'selected-browser-user'}
            with patch.object(a, 'DATA', Path(td)), \
                 patch.object(a.shutil, 'which', return_value='git'), \
                 patch.object(a.subprocess, 'run', return_value=p) as run, \
                 patch.object(a.requests, 'get', return_value=resp), \
                 patch('builtins.input', return_value='y'):
                db = a.init_db()
                owner, token = a.github_login(db, force=True)
                self.assertEqual(owner, 'selected-browser-user')
                self.assertEqual(token, fake_token)
                self.assertNotIn('username=', run.call_args.kwargs['input'])
                self.assertEqual(run.call_args.kwargs['env']['GCM_GITHUB_AUTHMODES'], 'browser')
                self.assertEqual(a.get_option(db, 'github_owner'), 'selected-browser-user')

if __name__=='__main__':
    unittest.main()
