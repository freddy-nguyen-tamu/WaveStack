"""Regression tests: never claim Open Reader is current when pages are broken."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from reusable import open_reader as reader


class OpenReaderPublicSanity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stage = Path(self.tmp.name)
        for name, data in {
            'index.html': b'<html>Shared library</html>',
            'library.json': b'{"comics":[]}',
            'registry.json': b'{"comics":{}}',
            'comics/sample/manifest.json': b'{"chapters":[]}',
            'comics/sample/index.html': b'<html>Comic reader</html>',
            'comics/sample/app.js': b'console.log("reader");',
        }.items():
            p = self.stage / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        self.registry = {'comics': {'sample': {}}}
        self.calls = []

    def fake_get(self, url, **kwargs):
        self.calls.append(url)
        rel = url.split('workers.dev/', 1)[1]
        path = rel + 'index.html' if not rel or rel.endswith('/') else rel
        p = self.stage / path
        if p.is_file():
            return SimpleNamespace(status_code=200, content=p.read_bytes())
        return SimpleNamespace(status_code=404, content=b'Not found')

    def test_verified_worker_checks_real_home_and_reader_routes(self):
        with patch.object(reader.requests, 'get', side_effect=self.fake_get):
            reader._verify_published('https://open-reader.account.workers.dev', self.stage, self.registry)
        self.assertIn('https://open-reader.account.workers.dev/', self.calls)
        self.assertIn('https://open-reader.account.workers.dev/comics/sample/', self.calls)
        self.assertIn('https://open-reader.account.workers.dev/comics/sample/app.js', self.calls)
        self.assertEqual(len(self.calls), 6)

    def test_missing_homepage_must_not_pass_silent_noop(self):
        base = self.fake_get
        def missing_root(url, **kwargs):
            if url.endswith('workers.dev/'):
                return SimpleNamespace(status_code=404, content=b'Not found')
            return base(url, **kwargs)
        with patch.object(reader.requests, 'get', side_effect=missing_root), \
             patch('time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'live URL is unavailable or outdated'):
                reader._verify_published('https://open-reader.account.workers.dev', self.stage, self.registry)

    def test_missing_comic_route_must_not_pass_silent_noop(self):
        base = self.fake_get
        def missing_comic(url, **kwargs):
            if url.endswith('/comics/sample/'):
                return SimpleNamespace(status_code=404, content=b'Not found')
            return base(url, **kwargs)
        with patch.object(reader.requests, 'get', side_effect=missing_comic), \
             patch('time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'comics/sample'):
                reader._verify_published('https://open-reader.account.workers.dev', self.stage, self.registry)

    def test_missing_reader_javascript_must_not_pass_silent_noop(self):
        base = self.fake_get
        def missing_js(url, **kwargs):
            if url.endswith('/comics/sample/app.js'):
                return SimpleNamespace(status_code=404, content=b'Not found')
            return base(url, **kwargs)
        with patch.object(reader.requests, 'get', side_effect=missing_js), \
             patch('time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'app.js'):
                reader._verify_published('https://open-reader.account.workers.dev', self.stage, self.registry)

    def test_stale_homepage_is_not_mistaken_for_complete(self):
        base = self.fake_get
        def wrong_html(url, **kwargs):
            if url.endswith('workers.dev/'):
                return SimpleNamespace(status_code=200, content=b'<html>Old reader</html>')
            return base(url, **kwargs)
        with patch.object(reader.requests, 'get', side_effect=wrong_html), \
             patch('time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'checksum differs'):
                reader._verify_published('https://open-reader.account.workers.dev', self.stage, self.registry)


if __name__ == '__main__':
    unittest.main()
