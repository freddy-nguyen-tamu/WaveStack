import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_session import (profile_directory, SourceRequestGuard,
                            SourceAccessPaused, retry_after_seconds,
                            classify_browser_page, open_source_context,
                            visit_source_page)


class SourceSessionTests(unittest.TestCase):
    def test_profile_is_domain_scoped_and_stable(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            a = profile_directory(base, 'https://example.org/a?x=1')
            b = profile_directory(base, 'https://example.org/other')
            c = profile_directory(base, 'https://other.org/a')
            self.assertEqual(a, b)
            self.assertNotEqual(a, c)
            self.assertTrue(str(a).startswith(str(base)))

    def test_http_retry_after_seconds_and_date(self):
        self.assertEqual(retry_after_seconds('90'), 90)
        self.assertIsNone(retry_after_seconds('junk'))
        clock = 1750000000
        d = datetime.fromtimestamp(clock + 120, timezone.utc)
        self.assertAlmostEqual(retry_after_seconds(format_datetime(d), now=clock), 120, delta=1)

    def test_rate_limit_persists_across_process_restarts(self):
        with tempfile.TemporaryDirectory() as temp:
            items = []
            a = SourceRequestGuard(Path(temp), min_interval_seconds=0,
                                   max_inline_wait_seconds=0.01,
                                   emit=lambda name, **kw: items.append((name, kw)))
            with self.assertRaises(SourceAccessPaused):
                a.response('https://images.example.org/a.png', 429,
                           {'Retry-After': '120'})
            self.assertTrue((Path(temp) / 'source_cooldowns.json').exists())
            again = SourceRequestGuard(Path(temp), min_interval_seconds=0,
                                       max_inline_wait_seconds=0.01)
            with self.assertRaises(SourceAccessPaused) as error:
                again.before('https://images.example.org/b.png')
            self.assertIn('earliest retry', str(error.exception))
            again.before('https://separate-host.example.org/other.png')
            self.assertTrue(any(k == 'SOURCE_RATE_LIMITED' for k, _ in items))

    def test_explicit_forbidden_status_stops_not_retries(self):
        with tempfile.TemporaryDirectory() as temp:
            guard = SourceRequestGuard(Path(temp), min_interval_seconds=0)
            with self.assertRaises(SourceAccessPaused) as error:
                guard.response('https://example.org/private', 403)
            self.assertIn('403', str(error.exception))

    def test_persistent_context_uses_separate_profile(self):
        calls = []
        fake = SimpleNamespace(firefox=SimpleNamespace(
            launch_persistent_context=lambda **kwargs: calls.append(kwargs) or 'OK'))
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(open_source_context(fake, Path(temp),
                              'https://example.org/first'), 'OK')
            self.assertFalse(calls[0]['headless'])
            self.assertTrue(calls[0]['user_data_dir'].startswith(temp))
            with self.assertRaisesRegex(RuntimeError, 'visible'):
                open_source_context(fake, Path(temp), 'https://fresh.org/first',
                                    headless=True)
            from source_session import mark_source_session_ready
            mark_source_session_ready(Path(temp), 'https://example.org/first', browser='firefox')
            self.assertEqual(open_source_context(fake, Path(temp), 'https://example.org/first'), 'OK')
            self.assertTrue(calls[-1]['headless'])
            self.assertEqual(open_source_context(fake, Path(temp), 'https://example.org/first', headless=False), 'OK')
            self.assertFalse(calls[-1]['headless'])

    def test_detects_login_and_challenge_not_story_text(self):
        class Page:
            url = 'https://example.org/comic/chapter-1'
            def __init__(self, state): self.state = state
            def evaluate(self, script): return self.state
        self.assertIsNone(classify_browser_page(Page({'login': False, 'challenge': False,
                                                      'title': 'An adventure about logins'})))
        self.assertEqual(classify_browser_page(Page({'login': True, 'challenge': False,
                                                     'title': 'Comic'})), 'login')
        self.assertEqual(classify_browser_page(Page({'login': False, 'challenge': True,
                                                     'title': 'Comic'})), 'challenge')

    def test_navigation_respects_429_before_parsing(self):
        with tempfile.TemporaryDirectory() as temp:
            guard = SourceRequestGuard(Path(temp), min_interval_seconds=0)
            class FakePage:
                url='https://example.org/reader'
                def goto(self, url, **kwargs):
                    return SimpleNamespace(url=url, status=429, headers={'retry-after': '75'})
            with self.assertRaises(SourceAccessPaused):
                visit_source_page(FakePage(), 'https://example.org/reader', guard)

if __name__ == '__main__':
    unittest.main()
