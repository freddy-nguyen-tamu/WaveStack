"""Offline user-flow regressions: reader isolation, gold favicon, resume, gestures.

This stages the real published frontend; it never calls GitHub or Cloudflare.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import json
import shutil
import subprocess
import unittest
from PIL import Image
from reusable import open_reader

ROOT=Path(__file__).resolve().parents[1]


class ReaderLandingNavigation(unittest.TestCase):
    def setUp(self):
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        path=Path(self.tmp.name)
        fake=path/'project';(fake/'reader').mkdir(parents=True)
        (fake/'reusable'/'worker_addon').mkdir(parents=True)
        for f in (ROOT/'reader').iterdir():
            if f.is_file():shutil.copy2(f,fake/'reader'/f.name)
        for name in ('open_reader_homepage_addon.py','comic_landing.py','comic_landing.css',
                     'comic_landing.js','reader_progress.js','reader_chapter_enhancement.js',
                     'reader_chapter_enhancement.css','gold_favicon.py','github_streaming.py',
                     'github_upload_bell.js'):
            shutil.copy2(ROOT/'reusable'/name,fake/'reusable'/name)
        shutil.copy2(ROOT/'reusable'/'worker_addon'/'panel_replacement_worker.mjs',
                     fake/'reusable'/'worker_addon'/'panel_replacement_worker.mjs')
        self.fake=fake;self.stage=path/'stage'
        self.chapter={'id':'chapter-1','label':'Episode 1','title':'Episode 1','number':'1',
                      'images':[{'url':'https://example.pages.dev/01.png',
                                 'sha256':hashlib.sha256(b'ok').hexdigest(),
                                 'width':500,'height':900}]}
        reg={'comics':{'comic-a':{'title':'Comic A','slug':'comic-a','chapters':[self.chapter]}}}
        open_reader.stage_worker_assets(self.fake,reg,self.stage)

    def test_landing_routes_and_homepage_only_bell(self):
        library=json.loads((self.stage/'library.json').read_text(encoding='utf-8'))
        self.assertEqual(library['comics'][0]['route'],'/comics/comic-a/overview/')
        landing=(self.stage/'comics/comic-a/overview/index.html').read_text(encoding='utf-8')
        for text in ('Read from beginning','Continue reading','Browse chapters'):
            self.assertIn(text,landing)
        for route in ('index.html','comics/comic-a/overview/index.html',
                      'comics/comic-a/index.html','comics/comic-a/settings.html'):
            html=(self.stage/route).read_text(encoding='utf-8')
            self.assertEqual(html.count('src="/reader-issues.js"'),1 if route=='index.html' else 0)
            self.assertEqual(html.count('href="/favicon.svg"'),1)
            self.assertNotIn('src="./source-issue-bell.js"',html)

    def test_icon_has_alpha_not_dark_background(self):
        png=Image.open(self.stage/'favicon-180.png').convert('RGBA')
        self.assertEqual(png.getpixel((0,0))[3],0)
        self.assertEqual(png.getpixel((90,90))[3],0)
        self.assertTrue(any(p[3]>100 and p[0]>200 and p[1]>100 and p[2]<190
                            for p in png.get_flattened_data()))
        svg=(self.stage/'favicon.svg').read_text(encoding='utf-8')
        self.assertIn('fill="none"',svg)
        self.assertNotIn('#000000',svg)

    def test_original_reader_source_unchanged_and_staged_addon(self):
        original=(self.fake/'reader'/'app.js').read_text(encoding='utf-8')
        staged=(self.stage/'comics/comic-a/app.js').read_text(encoding='utf-8')
        self.assertIn('const chapterNext = nextChapter;',staged)
        self.assertIn('window.OpenReaderLocalProgress?.chapter',staged)
        self.assertIn("const store = 'universal-comic-reader-v3';",original)
        self.assertNotIn('const chapterNext = nextChapter;',original)
        self.assertEqual((self.fake/'reader/style.css').read_bytes(),(self.stage/'comics/comic-a/style.css').read_bytes())
        css=(self.stage/'reader-chapter-enhancement.css').read_text(encoding='utf-8')
        self.assertIn('margin-top:-1px',css)
        self.assertIn('#reader-panel',css)
        self.assertIn('or-library-back',css)
        self.assertIn('@media(prefers-reduced-motion:reduce)',css)
        script=(self.stage/'comics/comic-a/index.html').read_text(encoding='utf-8')
        self.assertIn('reader-progress.js',script)
        self.assertIn('reader-chapter-enhancement.css',script)

    def test_shortcut_implementation_and_syntax(self):
        script=(self.stage/'comics/comic-a/app.js').read_text(encoding='utf-8')
        for fragment in ("taps===3","taps===4","enterCount===4", "e.key==='Control'",
                         'nextChapter(dx<0?-1:1)', "leave('/')",'new MutationObserver(syncBack)'):
            self.assertIn(fragment,script)
        for target in ('comics/comic-a/app.js','comic-landing.js','reader-progress.js'):
            js=self.stage/target
            proc=subprocess.run(['node','--check',str(js)],capture_output=True,text=True,timeout=10)
            self.assertEqual(proc.returncode,0,proc.stderr)

if __name__=='__main__':unittest.main()
