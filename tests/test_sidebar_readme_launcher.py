import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bs4 import BeautifulSoup
from site_specific import site_adapter
import reusable.engine as engine

ROOT = Path(__file__).resolve().parents[1]


class ReaderAndMetadataTests(unittest.TestCase):
    def test_adapted_webtoon_episode_title(self):
        markup = '''<html><head><meta property="og:title" content="Example Series - Ep. 23"></head>
            <body><h1 class="subj_episode" title="Ep. 23 — The Reunion">Ep. 23</h1>
            <div class="episode_lst"><li data-episode-no="23"><a href="/ep-23?episode_no=23"><span class="subj">Ep. 23 — The Reunion</span></a></li></div>
            </body></html>'''
        soup = BeautifulSoup(markup, 'html.parser')
        anchor = soup.select_one('a')
        self.assertEqual(site_adapter.chapter_title_from_anchor(anchor, 'Ep. 23'), 'Ep. 23 — The Reunion')
        self.assertEqual(engine.chapter_title_from_source(markup, 'Ep. 23'), 'Ep. 23 — The Reunion')

    def test_fallback_uses_original_chapter_label_not_invented_title(self):
        self.assertEqual(engine.chapter_title_from_source('<html></html>', 'Chapter 4'), 'Chapter 4')

    def test_reader_keyboard_menu_no_wheel_handlers(self):
        code = (ROOT / 'reader/app.js').read_text(encoding='utf-8')
        html = (ROOT / 'reader/index.html').read_text(encoding='utf-8')
        for name in ('panel-speed', 'panel-search', 'panel-chapters', 'panel-auto', 'panel-close'):
            self.assertIn(name, html)
        self.assertIn("event.key==='Enter' && event.shiftKey", code)
        self.assertIn("event.key==='x'", code)
        self.assertIn('togglePanel(false)', code)
        self.assertIn('requestAnimationFrame', code)
        self.assertNotIn('addEventListener(\'wheel\'', code)
        self.assertIn('id="reader-panel" hidden', html)

    def test_readme_generator_contains_real_urls_and_all_chapters(self):
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE options(key TEXT PRIMARY KEY,value TEXT)')
        db.execute('CREATE TABLE chapters(chapter_id TEXT,label TEXT,ordinal INT,repository TEXT)')
        for key, val in [('series_title','Demo Story'),('series_slug','demo-story'),('github_owner','example')]:
            import json
            db.execute('INSERT INTO options VALUES(?,?)',(key,json.dumps(val)))
        db.execute('INSERT INTO chapters VALUES(?,?,?,?)',('1.5','Special episode',2,'demo-story-vol-001'))
        db.execute('INSERT INTO chapters VALUES(?,?,?,?)',('1','Episode One',1,'demo-story-vol-001'))
        readme=engine.reader_repository_readme(db,'https://demo-reader.pages.dev')
        self.assertIn('https://demo-reader.pages.dev/?chapter=1.5',readme)
        self.assertLess(readme.index('Episode One'),readme.index('Special episode'))
        self.assertIn('https://github.com/example/demo-story-vol-001',readme)

    def test_volume_readme_preserves_chapter_content_and_is_idempotent(self):
        prior='# Demo Story\n\n<!-- archived-chapter:1 -->\n## Episode One\n'
        first=engine.volume_readme_with_links(prior,'Demo Story','https://demo-reader.pages.dev','https://demo-assets.pages.dev')
        second=engine.volume_readme_with_links(first,'Demo Story','https://demo-reader.pages.dev','https://demo-assets.pages.dev')
        self.assertEqual(first,second)
        self.assertIn('<!-- archived-chapter:1 -->',first)
        self.assertIn('https://demo-reader.pages.dev',first)

    def test_runner_is_root_level_and_defaults_to_resume(self):
        runner=(ROOT/'run.py').read_text(encoding='utf-8')
        self.assertIn("['--resume', '--authorized']",runner)
        self.assertIn("'-NoProfile'",runner)

    def test_remote_volume_readme_only_changes_readme(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory)
            bare=home/'origin.git'
            subprocess.run(['git','init','--bare','-q',str(bare)],check=True)
            work=home/'work';work.mkdir()
            def git(*args):
                subprocess.run(['git',*args],cwd=work,check=True,capture_output=True)
            git('init','-q','-b','main')
            git('config','user.name','Tester');git('config','user.email','test@example.invalid')
            (work/'README.md').write_text('# Demo Story\n\n## Chapter One\n')
            (work/'001.jpg').write_bytes(b'fake-image-bytes')
            original=hashlib.sha256((work/'001.jpg').read_bytes()).hexdigest()
            git('add','.');git('commit','-m','seed','-q')
            git('remote','add','origin',str(bare));git('push','-q','origin','main')
            db=sqlite3.connect(':memory:')
            db.execute('CREATE TABLE options(key TEXT PRIMARY KEY,value TEXT)')
            db.execute('CREATE TABLE chapters(chapter_id TEXT,label TEXT,repository TEXT,ordinal INTEGER)')
            db.execute('INSERT INTO chapters VALUES(?,?,?,?)',
                       ('46', "Ep. 46 - Valentine's Day Post-Mortem", 'demo-vol-001', 46))
            import json
            for key,val in [('github_owner','tester'),('series_slug','demo'),('series_title','Demo Story'),('github_credential_namespace','tests')]:
                db.execute('INSERT INTO options VALUES(?,?)',(key,json.dumps(val)))
            with patch.object(engine,'paced_push',return_value=None),patch.object(engine,'event',return_value=None):
                self.assertTrue(engine.update_volume_readme(db,'demo-vol-001','https://reader.pages.dev','https://assets.pages.dev',remote_url=str(bare)))
                self.assertFalse(engine.update_volume_readme(db,'demo-vol-001','https://reader.pages.dev','https://assets.pages.dev',remote_url=str(bare)))
            data=subprocess.run(['git','--git-dir',str(bare),'show','main:001.jpg'],capture_output=True,check=True).stdout
            self.assertEqual(hashlib.sha256(data).hexdigest(),original)
            remote_readme=subprocess.run(['git','--git-dir',str(bare),'show','main:README.md'],capture_output=True,check=True).stdout.decode()
            self.assertIn('https://reader.pages.dev',remote_readme)
            self.assertIn('## Chapter One',remote_readme)
            self.assertIn("Ep. 46 - Valentine's Day Post-Mortem", remote_readme)

if __name__ == '__main__':
    unittest.main()
