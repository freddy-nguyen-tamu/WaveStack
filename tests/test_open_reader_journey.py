"""Provider-independent Your Journey regression and safety tests."""
from pathlib import Path
import json
import tempfile
import unittest

from reusable import open_reader_journey,open_reader


class JourneyTests(unittest.TestCase):
    def test_static_routes_tracking_and_verified_chapter_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'comics/a/overview').mkdir(parents=True)
            (root/'index.html').write_text('<html><head></head><body><p class="subtitle">Your comic library</p></body></html>')
            for relative in ('comics/a/index.html','comics/a/settings.html','comics/a/overview/index.html'):
                (root/relative).write_text('<html><head></head><body>READER ALREADY WORKING</body></html>')
            app=root/'comics/a/app.js'
            old='  chapter=manifest.chapters[chapterIndex];\nnext();'
            app.write_text(old)
            initial=open_reader_journey.augment_assets(root)
            self.assertEqual(initial['tracked_html_routes'],6)
            self.assertIn('href="/your-journey/"',(root/'index.html').read_text(encoding='utf-8'))
            self.assertIn('Your Journey',(root/'your-journey/index.html').read_text(encoding='utf-8'))
            self.assertIn('CF', (root/'privacy/index.html').read_text(encoding='utf-8').replace('Cloudflare','CF'))
            for p in root.rglob('*.html'):
                self.assertEqual(p.read_text(encoding='utf-8').count('src="/journey-track.js"'),1)
            contents=app.read_text(encoding='utf-8')
            self.assertIn("chapterId:chapter.id",contents)
            self.assertEqual(contents.count('open-reader:chapter-ready'),1)
            self.assertIn('next();',contents)
            open_reader_journey.augment_assets(root)
            self.assertEqual(app.read_text(encoding='utf-8'),contents)
            self.assertEqual((root/'index.html').read_text(encoding='utf-8').count('href="/your-journey/"'),1)
            self.assertNotIn('chrome', open_reader_journey.TRACK_JS.lower())

    def test_bad_native_reader_signal_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'comics/a').mkdir(parents=True)
            (root/'index.html').write_text('<html><head></head><p class="subtitle">Your comic library</p></html>')
            (root/'comics/a/app.js').write_text('chapter=id;')
            with self.assertRaisesRegex(RuntimeError,'chapter selection changed'):
                open_reader_journey.augment_assets(root)

    def test_d1_config_is_scoped_accountwide_not_site_specific(self):
        with tempfile.TemporaryDirectory() as tmp:
            project=Path(tmp)/'project'
            (project/'reusable/worker_addon').mkdir(parents=True)
            (project/'reusable/worker_addon/panel_replacement_worker.mjs').write_text('// existing worker')
            stage=Path(tmp)/'stage';stage.mkdir()
            cfg=json.loads(open_reader._worker_config(stage,Path(tmp),project).read_text(encoding='utf-8'))
            self.assertNotIn('d1_databases',cfg)
            state=project/'.archiver_state';state.mkdir()
            dbid='12345678-1234-1234-1234-123456789abc'
            (state/'open_reader_journey.json').write_text(json.dumps({'database_id':dbid}))
            cfg=json.loads(open_reader._worker_config(stage,Path(tmp),project).read_text(encoding='utf-8'))
            self.assertEqual(cfg['d1_databases'],[{'binding':'JOURNEY_DB','database_name':'open-reader-journey','database_id':dbid}])
            self.assertIn('/api/*',cfg['assets']['run_worker_first'])
            self.assertNotIn('site_specific',json.dumps(cfg))
            (state/'open_reader_journey.json').write_text(json.dumps({'database_id':'bad'}))
            with self.assertRaisesRegex(RuntimeError,'Invalid Journey D1'):
                open_reader._worker_config(stage,Path(tmp),project)

if __name__=='__main__':unittest.main()
