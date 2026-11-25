"""Offline regression tests for source metadata repair and shared publication."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from reusable import title_reconcile as titles, open_reader as reader
from site_specific import site_adapter

URL='https://open-reader.example.workers.dev'

class Recovery(unittest.TestCase):
    def test_http_403_uses_only_validated_capture(self):
        adapter=SimpleNamespace(DEFAULT_START_URL='https://example.test/chapter/1',
            ALLOWED_HOSTS=['example.test'],
            captured_native_chapter_titles=lambda:{'1':'Chapter 1','2':'Chapter 2','3':'Chapter 99'},
            accept_catalog_title=lambda ident,label:label=='Chapter '+ident)
        events=[]
        get=lambda *a,**k:SimpleNamespace(status_code=403,headers={})
        self.assertEqual(titles.fetch_catalog(adapter,adapter.DEFAULT_START_URL,
            request_get=get,emit=lambda name,**kw:events.append(name)),
            {'1':'Chapter 1','2':'Chapter 2'})
        self.assertIn('TITLE_CATALOG_CAPTURE_REUSED',events)

    def test_installed_adapter_capture_repairs_all_verified_rows(self):
        hook=getattr(site_adapter,'captured_native_chapter_titles',None)
        if not callable(hook):
            self.skipTest('Current adapter has no verified capture')
        native=hook()
        self.assertTrue(native)
        db=sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.executescript("""CREATE TABLE chapters(chapter_id TEXT PRIMARY KEY,label TEXT,repository TEXT,pages_json TEXT,status TEXT,ordinal INTEGER,commit_sha TEXT);
            CREATE TABLE repositories(name TEXT PRIMARY KEY,last_sha TEXT);""")
        db.execute("INSERT INTO repositories VALUES('volume','old')")
        for i,(ident,label) in enumerate(native.items()):
            manifest={'chapter_id':ident,'label':'Incorrect','chapter_title':'Incorrect',
                      'images':[{'sha256':'a'*64}], 'remote_files':['panel.png']}
            db.execute('INSERT INTO chapters VALUES(?,?,?,?,?,?,?)',
                       (ident,'Incorrect','volume',json.dumps(manifest),'ARCHIVED_PENDING_DEPLOYMENT',i,'old'))
        options={'github_owner':'test'}
        def git_update(repo,owner,updates,env,pace):
            self.assertEqual(len(updates),len(native))
            return 'new',{ident:{**obj,'chapter_title':label,'label':label,'title_source':source}
                          for ident,(obj,label,source) in updates.items()}
        with patch.object(titles.requests,'get',return_value=SimpleNamespace(status_code=403,headers={})), \
             patch.object(titles,'update_manifest_titles',side_effect=git_update):
            result=titles.reconcile_native_titles(db,site_adapter,get_option=lambda _,k:options.get(k),
                set_option=lambda _,k,v:options.__setitem__(k,v),event=lambda *a,**k:None,
                isolated_git_environment=lambda:{},paced_push=lambda *a:None,
                source_url=site_adapter.DEFAULT_START_URL)
        self.assertEqual(result['changed'],len(native))
        self.assertEqual(result['skipped'],0)
        for ident,label,raw,status in db.execute('SELECT chapter_id,label,pages_json,status FROM chapters'):
            self.assertEqual(label,native[ident])
            self.assertEqual(json.loads(raw)['images'],[{'sha256':'a'*64}])
            self.assertEqual(status,'ARCHIVED_PENDING_DEPLOYMENT')

    def test_shared_assets_and_only_selected_image_samples(self):
        with tempfile.TemporaryDirectory() as td:
            stage=Path(td)
            (stage/'source-issues.json').write_text(json.dumps({'cases':[]}))
            (stage/'upload-catalog.json').write_text('{}')
            for slug in ('old','new'):
                d=stage/'comics'/slug;d.mkdir(parents=True)
                (d/'settings.html').write_text(slug)
            accessed=[]
            from hashlib import sha256
            def get(url,**kwargs):
                path=url.removeprefix(URL)
                accessed.append(path)
                if path=='/api/reader-health':
                    return SimpleNamespace(status_code=200,json=lambda:{
                        'script':'open-reader-panel-replacement-v1','github_streaming_configured':True})
                if path.endswith('/settings.html'):
                    return SimpleNamespace(status_code=307,headers={'Location':path[:-5]})
                if path.endswith('/settings'):
                    path+='.html'
                if path.startswith('/api/github-image/'):
                    return SimpleNamespace(status_code=200,content=b'image')
                return SimpleNamespace(status_code=200,content=(stage/path.lstrip('/')).read_bytes())
            registry={'comics':{slug:{'chapters':[{'images':[{
                'github':{'repo':slug},'url':'/api/github-image/'+slug,
                'sha256':sha256(b'image').hexdigest()}]}]} for slug in ('old','new')}}
            with patch.object(reader.open_reader_verify_auth,'get',side_effect=get):
                reader._verify_published(URL,stage,registry,verify_slugs=None,verify_image_slugs={'new'})
            self.assertIn('/comics/old/settings',accessed)
            self.assertIn('/comics/new/settings',accessed)
            self.assertIn('/api/github-image/new',accessed)
            self.assertNotIn('/api/github-image/old',accessed)

if __name__=='__main__':unittest.main()
