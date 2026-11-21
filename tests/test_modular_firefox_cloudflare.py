import json
import re
import tempfile
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comic_archiver as engine
from source_session import open_source_context, mark_source_session_ready, profile_directory
from site_specific import site_adapter


class ModularFirefoxCloudflareTests(unittest.TestCase):
    def test_single_site_adapter_controls_source_behavior(self):
        raw = '<html><head><title>Ep. 1 | Else</title></head><body><a class="subj">Webtoon Story</a><div class="episode_lst"><li data-episode-no="7"><a href="/episode/7">Ep 7</a></li></div><div id="_imageList"><img data-url="https://img.test/1.jpg" /></div></body></html>'
        self.assertEqual(engine.root_metadata(raw)[1], 'Webtoon Story')
        self.assertEqual([x.chapter_id for x in engine.chapter_links(raw, 'https://www.webtoons.com/a')[0]], ['7'])
        self.assertEqual(engine.snapshot_images(raw), ['https://img.test/1.jpg'])
        self.assertEqual(site_adapter.SOURCE_NAME, 'webtoon')

    def test_extension_generated_from_one_adapter(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(engine, 'ROOT', Path(td)):
                engine.refresh_extension()
                generated = json.loads((Path(td)/'extension/manifest.json').read_text())
                self.assertEqual(generated['content_scripts'][0]['matches'], site_adapter.EXTENSION_MATCHES)
                js=(Path(td)/'extension/content.js').read_text()
                self.assertIn('requestAnimationFrame', js)
                self.assertNotIn('__NEXT_SELECTORS__', js)
                self.assertIn('a._nextEpisode[href]', js)
                self.assertNotIn("addEventListener('wheel'", js)

    def test_wrangler_utf8_stdout_and_undecodable_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            exe=root/'node_modules/.bin/wrangler'
            exe.parent.mkdir(parents=True)
            exe.touch()
            data=('👋 Cloudflare account 472a957ec92f9ba8843f6891220945cd\n').encode('utf-8')+b'\x8f'
            fake=SimpleNamespace(args=['wrangler','whoami'],returncode=0,stdout=data,stderr=b'')
            with patch.object(engine, 'ROOT', root), patch.object(engine, 'DATA', root/'state'), \
                 patch.object(engine.subprocess, 'run', return_value=fake):
                res=engine.npx_wrangler(['whoami'])
                self.assertIsInstance(res.stdout,str)
                self.assertIn('472a957ec92f9ba8843f6891220945cd', res.stdout)
                self.assertIn('�', res.stdout)
                engine.select_cloudflare_account()
                self.assertEqual((root/'state/cloudflare_account.txt').read_text(), '472a957ec92f9ba8843f6891220945cd')

    def test_cloudflare_account_selection_handles_none_output_safely(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            fake=SimpleNamespace(stdout=None,stderr=None)
            with patch.object(engine,'DATA',root),patch.object(engine,'npx_wrangler',return_value=fake):
                with self.assertRaisesRegex(RuntimeError, 'no recognizable'):
                    engine.select_cloudflare_account()

    def test_archive_complete_skips_source_and_reads_pending_state(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(engine,'DATA',Path(td)):
                db=engine.init_db()
                self.assertFalse(engine.archive_is_complete(db))
                db.execute("INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES('60','Episode 60','https://webtoons.com/60',59,'ARCHIVED_PENDING_DEPLOYMENT')")
                db.commit()
                engine.set_option(db, 'chapter_catalog_complete', True)
                engine.set_option(db, 'chapter_catalog_total', 1)
                self.assertTrue(engine.archive_is_complete(db))
                db.execute("INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES('61','Episode 61','https://webtoons.com/61',60,'DISCOVERED')")
                db.commit()
                self.assertFalse(engine.archive_is_complete(db))
                db.close()

    def test_firefox_profile_isolated_and_auto_headless_after_visible_success(self):
        with tempfile.TemporaryDirectory() as td:
            kw=[]
            fake=SimpleNamespace(firefox=SimpleNamespace(launch_persistent_context=lambda **k: kw.append(k) or k))
            source='https://www.webtoons.com/en/story'
            first=open_source_context(fake,Path(td),source)
            self.assertFalse(first['headless'])
            self.assertIn('/firefox/',first['user_data_dir'].replace('\\','/'))
            mark_source_session_ready(Path(td),source,browser='firefox')
            again=open_source_context(fake,Path(td),source)
            self.assertTrue(again['headless'])
            self.assertNotEqual(profile_directory(Path(td),source,browser='chromium'),profile_directory(Path(td),source,browser='firefox'))

if __name__ == '__main__': unittest.main()
