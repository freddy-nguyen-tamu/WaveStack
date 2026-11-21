"""Regression tests for explicitly human-operated source access checks.

No challenge is solved or bypassed: continuation requires a real 2xx navigation
in the original visible browser after the human presses ENTER.
"""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock, call, sentinel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reusable import source_session as sess
from reusable import engine

URL = 'https://example.org/comic/chapter-1'


class BrowserPage:
    url = URL

    def __init__(self, statuses):
        self.statuses = iter(statuses)
        self.visited = []

    def goto(self, url, **kwargs):
        self.url = url
        self.visited.append(url)
        return SimpleNamespace(url=url, status=next(self.statuses), headers={})


class HumanVerificationTests(unittest.TestCase):
    def guard(self, root):
        events = []
        return sess.SourceRequestGuard(Path(root), min_interval_seconds=0,
                                       emit=lambda name, **attrs: events.append((name, attrs))), events

    def test_403_waits_for_human_and_only_succeeds_after_200(self):
        with tempfile.TemporaryDirectory() as td:
            guard, events = self.guard(td)
            page = BrowserPage([403, 403, 200])
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', side_effect=['', '']), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                resp = sess.visit_source_page(page, URL, guard, visible=True)
            self.assertEqual(resp.status, 200)
            self.assertEqual(len(page.visited), 3)
            self.assertIn('SOURCE_HUMAN_RECHECK_INCOMPLETE', [e[0] for e in events])
            self.assertIn('SOURCE_HUMAN_INTERVENTION_VERIFIED', [e[0] for e in events])

    def test_http_200_redirect_to_homepage_is_not_counted_as_chapter_access(self):
        with tempfile.TemporaryDirectory() as td:
            guard, events = self.guard(td)
            page = BrowserPage([403, 200, 200])
            original = page.goto
            visited = 0
            def redirect_once(url, **kwargs):
                nonlocal visited
                visited += 1
                response = original(url, **kwargs)
                if visited == 2:
                    page.url = 'https://example.org/'
                    response.url = page.url
                return response
            page.goto = redirect_once
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', side_effect=['', '']), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                response = sess.visit_source_page(page, URL, guard, visible=True)
            self.assertEqual(response.status, 200)
            self.assertEqual(visited, 3)
            self.assertTrue(any(not e[1]['same_reader_path'] for e in events
                                if e[0] == 'SOURCE_HUMAN_RECHECK_INCOMPLETE'))

    def test_403_human_can_quit_without_a_recheck(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            page = BrowserPage([403])
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', return_value='q'), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                with self.assertRaises(sess.SourceAccessPaused):
                    sess.visit_source_page(page, URL, guard, visible=True)
            self.assertEqual(page.visited, [URL])

    def test_headless_403_requires_visible_browser_not_console_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            page = BrowserPage([403])
            with patch('builtins.input', side_effect=AssertionError('Unexpected prompt')), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                with self.assertRaises(sess.SourceManualActionRequired):
                    sess.visit_source_page(page, URL, guard, visible=False)
            self.assertEqual(page.visited, [URL])

    def test_challenge_with_http_200_also_waits_for_human(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            page = BrowserPage([200, 200])
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', return_value=''), \
                 patch.object(sess, 'classify_browser_page', side_effect=['challenge', None]):
                resp = sess.visit_source_page(page, URL, guard, visible=True)
            self.assertEqual(resp.status, 200)
            self.assertEqual(len(page.visited), 2)

    def test_image_host_denial_offers_one_human_check_then_stops_if_still_denied(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            status = lambda: SimpleNamespace(url='https://images.example.org/a.jpg',
                                             status=403, headers={}, ok=False)
            ctx = SimpleNamespace(request=SimpleNamespace(get=MagicMock(side_effect=[status(), status()])))
            with patch.object(engine, 'wait_for_manual_source_access') as human, \
                 patch.object(engine, 'event'):
                with self.assertRaises(sess.SourceAccessPaused):
                    engine.image_download(ctx, 'https://images.example.org/a.jpg',
                                          Path(td)/'1', URL, max_tries=4,
                                          guard=guard, page=sentinel.page)
            human.assert_called_once()
            self.assertEqual(ctx.request.get.call_count, 2)

    def test_image_host_rate_limit_does_not_offer_manual_check(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            reply = SimpleNamespace(url='https://images.example.org/a.jpg',
                                    status=429, headers={'retry-after':'120'}, ok=False)
            ctx = SimpleNamespace(request=SimpleNamespace(get=MagicMock(return_value=reply)))
            with patch.object(engine, 'wait_for_manual_source_access') as human:
                with self.assertRaises(sess.SourceAccessPaused):
                    engine.image_download(ctx, reply.url, Path(td)/'1', URL,
                                          guard=guard, page=sentinel.page)
            human.assert_not_called()

    def test_rate_limit_never_opens_manual_prompt(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            page = BrowserPage([429])
            with patch('builtins.input', side_effect=AssertionError('Unexpected prompt')), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                with self.assertRaises(sess.SourceAccessPaused) as err:
                    sess.visit_source_page(page, URL, guard, visible=True)
            self.assertIn('429', str(err.exception))

    def test_noninteractive_403_does_not_hang(self):
        with tempfile.TemporaryDirectory() as td:
            guard, _ = self.guard(td)
            page = BrowserPage([403])
            with patch.object(sess.sys.stdin, 'isatty', return_value=False), \
                 patch('builtins.input', side_effect=AssertionError('Unexpected prompt')), \
                 patch.object(sess, 'classify_browser_page', return_value=None):
                with self.assertRaises(sess.SourceAccessPaused) as err:
                    sess.visit_source_page(page, URL, guard, visible=True)
            self.assertIn('interactive terminal', str(err.exception))

    def test_scrolling_challenge_restores_complete_scan_from_start(self):
        p = MagicMock()
        p.url = URL
        p.evaluate.return_value = {
            'total': 1, 'imgs': [{'key': '1', 'url': 'https://example.org/image.jpg',
                                   'width': 100, 'height': 200}],
            'missingSlots': 0, 'height': 1000, 'scrollY': 1000,
            'bottom': 1000, 'revision': 0, 'readerCount': 1}
        with patch.object(engine, 'classify_browser_page', side_effect=['challenge', None]), \
             patch.object(engine, 'wait_for_manual_source_access', return_value=None) as human, \
             patch.object(engine, 'event'):
            images = engine.scan_browser_images(p, max_steps=4, stability=1,
                                                guard=sentinel.guard, visible=True)
        self.assertEqual(len(images), 1)
        human.assert_called_once()

    def test_engine_reopens_browser_visible_only_once_on_headless_challenge(self):
        with patch.object(engine, '_archive_run_once',
                          side_effect=[sess.SourceManualActionRequired('manual action'), 'complete']) as inner, \
             patch.object(engine, 'event'):
            result = engine.archive_run(sentinel.db, None, URL, 200, True)
        self.assertEqual(result, 'complete')
        self.assertEqual(inner.call_count, 2)
        self.assertEqual(inner.call_args.kwargs['source_headless'], False)
        self.assertEqual(inner.call_args.kwargs['skip_remote_reconcile'], True)

    def test_visible_browser_does_not_loop_on_failed_manual_check(self):
        with patch.object(engine, '_archive_run_once',
                          side_effect=sess.SourceManualActionRequired('blocked')) as inner, \
             patch.object(engine, 'event'):
            with self.assertRaises(sess.SourceManualActionRequired):
                engine.archive_run(sentinel.db, None, URL, 200, True,
                                   source_headless=False)
        self.assertEqual(inner.call_count, 1)


if __name__ == '__main__':
    unittest.main()

# The navigation-timeout variant must not enter a manual prompt for arbitrary
# connectivity errors; only a visibly recognized challenge can request it.
class NavigationTimeoutTests(unittest.TestCase):
    def test_timeout_when_challenge_visible_waits_for_human(self):
        with tempfile.TemporaryDirectory() as td:
            guard = sess.SourceRequestGuard(Path(td), min_interval_seconds=0)
            page = BrowserPage([200])
            original_goto = page.goto
            calls = 0
            def maybe_timeout(url, **kw):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise TimeoutError('challenge prevented DOMContentLoaded')
                return original_goto(url, **kw)
            page.goto = maybe_timeout
            with patch.object(sess.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', return_value=''), \
                 patch.object(sess, 'classify_browser_page', side_effect=['challenge', None]):
                self.assertEqual(sess.visit_source_page(page, URL, guard).status, 200)
            self.assertEqual(calls, 2)

    def test_unrelated_timeout_is_not_swallowed(self):
        with tempfile.TemporaryDirectory() as td:
            guard = sess.SourceRequestGuard(Path(td), min_interval_seconds=0)
            page = BrowserPage([])
            page.goto = MagicMock(side_effect=TimeoutError('network down'))
            with patch.object(sess, 'classify_browser_page', return_value=None), \
                 patch('builtins.input', side_effect=AssertionError('unexpected human prompt')):
                with self.assertRaises(TimeoutError):
                    sess.visit_source_page(page, URL, guard)
