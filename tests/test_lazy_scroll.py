"""Regression tests: patient scrolling of source lazy-reader images."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comic_archiver as app


class MockReader:
    url = 'https://example.invalid/episode/1'
    def __init__(self, *, eventual=True, change_ordinal=False):
        self.pos = 0
        self.waits = []
        self.scrolls = 0
        self.eventual = eventual
        self.change_ordinal = change_ordinal

    def evaluate(self, script):
        if 'scrollTo(' in script and 'const selectors' not in script:
            self.pos = min(2, self.pos + 1)
            self.scrolls += 1
            return 440
        ready = self.pos >= 2 and self.eventual
        first_url = 'https://cdn.example.invalid/different.jpg' if (self.pos > 0 and self.change_ordinal) else 'https://cdn.example.invalid/first.jpg'
        return {'imgs': [
            {'key': '1', 'url': first_url, 'width': 600, 'height': 1000},
            {'key': '2', 'url': 'https://cdn.example.invalid/second.webp' if ready else '', 'width': 600, 'height': 1000},
        ], 'total': 2, 'readerCount': 2, 'missingSlots': int(not ready),
            'scrollY': 1200 if self.pos >= 2 else self.pos * 600,
            'bottom': 1200, 'height': 2000,
            'revision': 1 if ready else 0}

    def wait_for_timeout(self, milliseconds):
        self.waits.append(milliseconds)


class LazyScrollTests(unittest.TestCase):
    def test_scrolls_original_reader_and_waits_for_late_image(self):
        p = MockReader()
        with patch.object(app, 'classify_browser_page', return_value=None), patch.object(app, 'event'):
            pages = app.scan_browser_images(p, max_steps=15, stability=2)
        self.assertEqual([x[0] for x in pages], ['1','2'])
        self.assertTrue(p.scrolls >= 2)
        self.assertEqual(pages[1][1]['url'], 'https://cdn.example.invalid/second.webp')
        self.assertIn(350, p.waits)
        self.assertIn(420, p.waits)

    def test_does_not_complete_with_unresolved_image_slot(self):
        p = MockReader(eventual=False)
        with patch.object(app, 'classify_browser_page', return_value=None), patch.object(app, 'event'):
            with self.assertRaisesRegex(RuntimeError, 'placeholder'):
                app.scan_browser_images(p, max_steps=9, stability=2)

    def test_recycled_ordinal_is_rejected(self):
        p = MockReader(change_ordinal=True)
        with patch.object(app, 'classify_browser_page', return_value=None), patch.object(app, 'event'):
            with self.assertRaisesRegex(RuntimeError, 'reused a page ordinal'):
                app.scan_browser_images(p, max_steps=9, stability=2)

    def test_original_wheel_and_url_are_not_replaced(self):
        script = (Path(__file__).resolve().parents[1]/'extension/content.js').read_text(encoding='utf-8')
        self.assertNotIn("addEventListener('wheel'", script)
        self.assertNotIn('chrome-extension://', script)
        self.assertIn('location.assign(url)', script)

if __name__ == '__main__':
    unittest.main()
