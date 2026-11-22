"""Regression tests for shared home bell, favicon, and narrow panel overlays.

No browser/CDN/GitHub/Cloudflare calls. These fail before a real run if the
publisher forgets the homepage, loses an issue, or trusts arbitrary uploads.
"""
from __future__ import annotations
import json
from contextlib import closing
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

from reusable import open_reader as reader

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://open-reader.example.workers.dev'

class ReaderHomepageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name)/'project'
        (self.project/'reader').mkdir(parents=True)
        (self.project/'reusable/worker_addon').mkdir(parents=True)
        for item in (ROOT/'reader').iterdir():
            if item.is_file():shutil.copy2(item, self.project/'reader'/item.name)
        for name in ('open_reader_homepage_addon.py', 'comic_landing.py',
                     'comic_landing.css', 'comic_landing.js', 'reader_progress.js',
                     'reader_chapter_enhancement.css', 'reader_chapter_enhancement.js',
                     'gold_favicon.py'):
            shutil.copy2(ROOT/'reusable'/name,self.project/'reusable'/name)
        shutil.copy2(ROOT/'reusable/worker_addon/panel_replacement_worker.mjs',
                     self.project/'reusable/worker_addon/panel_replacement_worker.mjs')
        site = self.project/'.archiver_state/sites/comic-a'
        site.mkdir(parents=True)
        with closing(sqlite3.connect(site/'state.sqlite')) as con:
            with con:
                con.execute('CREATE TABLE options (key TEXT,value TEXT)')
                con.execute('CREATE TABLE chapters (chapter_id TEXT,label TEXT,url TEXT,status TEXT)')
                con.executemany('INSERT INTO options VALUES (?,?)',
                                [('series_title',json.dumps('Comic A')),
                                 ('series_slug',json.dumps('comic-a'))])
                con.execute('INSERT INTO chapters VALUES (?,?,?,?)',
                            ('82','Episode 82','https://example.test/82','SOURCE_SERVER_DEFERRED'))
        folder = site/'temporary_downloads/82';folder.mkdir(parents=True)
        failure = {'status':None,'reason':'adapter_confirmed_origin_placeholder',
                   'adapter_confirmed':True,'dom_unloaded':True,
                   'url':'https://example.test/056.jpg'}
        (folder/'confirmed_server_failures.json').write_text(json.dumps({
            'chapter_id':'82','recorded_at':'2026-11-21T16:00:00Z',
            'failures':{'56':failure,'57':failure}}), encoding='utf-8')
        self.comic = {'slug':'comic-a','title':'Comic A','chapters':[{
            'id':'82','number':'82','label':'Episode 82','title':'Episode 82',
            'images':[{'url':f'https://sample.pages.dev/{i}.png',
                       'width':720,'height':700,'sha256':'a'*64} for i in range(1,4)]}]}
        self.stage = Path(self.tmp.name)/'staged'
        reader.stage_worker_assets(self.project,{'comics':{'comic-a':self.comic}},self.stage)

    def test_homepage_only_bell_transparent_gold_favicon_all_routes(self):
        self.assertEqual(2,json.loads((self.stage/'source-issues.json').read_text(encoding='utf-8'))['count'])
        for fn in ('index.html','comics/comic-a/index.html','comics/comic-a/settings.html',
                   'comics/comic-a/overview/index.html'):
            html = (self.stage/fn).read_text(encoding='utf-8')
            self.assertEqual(html.count('src="/reader-issues.js"'),1 if fn=='index.html' else 0)
            self.assertEqual(html.count('href="/favicon.svg"'),1)
            self.assertEqual(html.count('href="/favicon.ico"'),1)
            self.assertNotIn('src="./source-issue-bell.js"',html)
        for fn in ('favicon.ico','favicon.svg','favicon-32.png','reader-issues.js','reader-issues.css'):
            self.assertTrue((self.stage/fn).is_file())
        from PIL import Image
        icon=Image.open(self.stage/'favicon-32.png').convert('RGBA')
        self.assertEqual(icon.getpixel((0,0))[3],0)
        self.assertTrue(any(p[0]>p[2] and p[1]>p[2] and p[3] for p in icon.get_flattened_data()))
        original=(self.stage/'source-issues.json').read_bytes()
        reader.stage_worker_assets(self.project,{'comics':{'comic-a':self.comic}},self.stage)
        self.assertEqual(original,(self.stage/'source-issues.json').read_bytes())

    def test_worker_config_preserves_static_route_and_opt_in_r2(self):
        config=reader._worker_config(self.stage,Path(self.tmp.name),self.project)
        obj=json.loads(config.read_text(encoding='utf-8'))
        self.assertEqual(obj['name'],'open-reader')
        self.assertEqual(obj['assets']['binding'],'ASSETS')
        self.assertIn('/source-issues.json',obj['assets']['run_worker_first'])
        self.assertNotIn('r2_buckets',obj)
        p=self.project/'.archiver_state/open_reader_uploads.json'
        p.write_text(json.dumps({'r2_bucket':'open-reader-panel-replacements'}), encoding='utf-8')
        obj=json.loads(reader._worker_config(self.stage,Path(self.tmp.name),self.project).read_text(encoding='utf-8'))
        self.assertEqual(obj['r2_buckets'][0]['binding'],'PANEL_REPLACEMENTS')

    def test_dynamic_replacement_validation_only_exact_slot(self):
        assets={('/'+p.relative_to(self.stage).as_posix()).replace('/index.html','/'):
                p.read_bytes() for p in self.stage.rglob('*') if p.is_file()}
        original=json.loads((self.stage/'comics/comic-a/manifest.json').read_text(encoding='utf-8'))
        issues=json.loads((self.stage/'source-issues.json').read_text(encoding='utf-8'))
        issue=next(c for c in issues['cases'] if c['panel']==56)
        live_issues={**issues,'upload_enabled':True,
                     'cases':[{**c,'replacement_present':c['id']==issue['id'],
                               'replacement_sha256':'f'*64 if c['id']==issue['id'] else None}
                              for c in issues['cases']]}
        modified=json.loads(json.dumps(original))
        # This fixture has only 3 images, so simulate replacement at panel 1.
        # Use a legitimate additional issue record exactly matching panel 1.
        first={**issue,'panel':1,'id':'c'*20,'replacement_present':True,
               'replacement_sha256':'f'*64}
        live_issues['cases'].append(first)
        modified['chapters'][0]['images'][0]['url']='/api/panel-replacements/'+'c'*20+'?v='+('f'*64)
        modified['chapters'][0]['images'][0]['sha256']='f'*64
        def fake_get(url,**kwargs):
            path=urlsplit(url).path
            if path=='/api/reader-health': data=json.dumps({'script':'open-reader-panel-replacement-v1'}).encode()
            elif path=='/source-issues.json':data=json.dumps(live_issues).encode()
            elif path=='/comics/comic-a/manifest.json':data=json.dumps(modified).encode()
            else:data=assets.get(path,b'')
            return SimpleNamespace(status_code=200 if data else 404,ok=bool(data),content=data,
                                   json=lambda: json.loads(data))
        with patch.object(reader.requests,'get',side_effect=fake_get), patch('time.sleep',return_value=None):
            reader._verify_published(BASE,self.stage,{})
            modified['chapters'][0]['images'][1]['url']='https://attacker.invalid/rogue.png'
            with self.assertRaisesRegex(RuntimeError,'mismatch|unexpected'):
                reader._verify_published(BASE,self.stage,{})

    def test_worker_hash_changes_on_backend_edit(self):
        before=reader._reader_hash(self.project)
        file=self.project/'reusable/worker_addon/panel_replacement_worker.mjs'
        file.write_text(file.read_text(encoding='utf-8')+'\n// new backend version\n', encoding='utf-8')
        self.assertNotEqual(before,reader._reader_hash(self.project))

if __name__=='__main__': unittest.main()
