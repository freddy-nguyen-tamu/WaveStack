"""Regression contracts: shared Worker is additive across adapter changes."""
from __future__ import annotations
import base64
import hashlib
import json
import sqlite3
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from reusable import open_reader as o
from reusable import engine


def comic(slug, count=2, *, suffix=''):
    items=[]
    for n in range(1, count+1):
        raw=f'{slug}-{n}'.encode()
        items.append({'id':str(n), 'label':f'Ep. {n}',
                      'title':f'Ep. {n} - {slug} {suffix}'.strip(),
                      'images':[{'url':f'https://{slug}-vol-001.pages.dev/chapters/{n}/1.jpg',
                                 'width':450, 'height':900, 'sha256':hashlib.sha256(raw).hexdigest()}]})
    return o.validate_comic(slug,slug.title(),items)


def copy_reader_fixture(root):
    # Staging verifies actual frontend contracts; minimal toy HTML/JS no
    # longer represents the deployed reader. Copy only application files.
    project = Path(__file__).resolve().parents[1]
    shutil.copytree(project / 'reader', root / 'reader')
    shutil.copytree(project / 'reusable', root / 'reusable',
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))


class OpenReaderContracts(unittest.TestCase):
    def test_merge_preserves_old_series_and_prefers_real_titles(self):
        registry={'comics':{'comic-a':comic('comic-a')}}
        o.combine(registry, {'comic-b':comic('comic-b')})
        self.assertEqual(set(registry['comics']),{'comic-a','comic-b'})
        a=registry['comics']['comic-a']
        incoming=comic('comic-a')
        incoming['chapters'][0]['title']='Ep. 1'
        o.combine(registry,{'comic-a':incoming})
        self.assertEqual(registry['comics']['comic-a']['chapters'][0]['title'],a['chapters'][0]['title'])

    def test_unsafe_manifest_refused(self):
        a=comic('comic-a')
        a['chapters'][0]['images'][0]['url']='http://localhost:8800/secret'
        with self.assertRaises(ValueError):
            o.combine({'comics':{}},{'comic-a':a})

    def test_local_sqlite_finds_multiple_prior_series(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            for idx,slug in enumerate(('comic-a','comic-b')):
                path=root/'.archiver_state'/('sites/'+slug if idx else '')/'state.sqlite'
                path.parent.mkdir(parents=True,exist_ok=True)
                con=sqlite3.connect(path)
                con.executescript('CREATE TABLE options(key TEXT,value TEXT);'
                                  'CREATE TABLE chapters(chapter_id TEXT,label TEXT,pages_json TEXT,repository TEXT,status TEXT,ordinal INTEGER);'
                                  'CREATE TABLE deployments(project TEXT,production_url TEXT);')
                con.executemany('INSERT INTO options VALUES (?,?)', [('series_slug',json.dumps(slug)),('series_title',json.dumps(slug.title()))])
                checksum=hashlib.sha256(b'data').hexdigest()
                manifest={'remote_files':['chapters/1/1.jpg'],
                          'images':[{'sha256':checksum,'width':20,'height':35}],
                          'chapter_title':'Episode one'}
                con.execute('INSERT INTO chapters VALUES (?,?,?,?,?,?)',('1','Ep. 1',json.dumps(manifest),slug+'-vol-001','PUBLISHED_VERIFIED',0))
                con.execute('INSERT INTO deployments VALUES (?,?)',(slug+'-vol-001','https://'+slug+'-vol-001.pages.dev'))
                con.execute('INSERT INTO deployments VALUES (?,?)',(slug+'-reader','https://'+slug+'-reader.pages.dev'))
                con.commit();con.close()
            dummy=SimpleNamespace(ROOT=root,event=lambda *args,**kwargs:None)
            result=o.local_candidates(dummy)
            self.assertEqual(set(result),{'comic-a','comic-b'})
            self.assertEqual(result['comic-b']['chapters'][0]['title'],'Episode one')

    def test_worker_redeploy_accumulates_comics_and_skips_same_build(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);copy_reader_fixture(root)
            dummy=SimpleNamespace(ROOT=root,credential_for_selected=lambda db:('owner','token'),
                                  select_cloudflare_account=lambda:None,
                                  atomic_json=lambda path,data:(path.parent.mkdir(parents=True,exist_ok=True),path.write_text(json.dumps(data),encoding='utf8')))
            worker='https://open-reader.account.workers.dev'
            remote=[];uploads=[]
            def deploy(engine,stage,registry):
                uploads.append(json.loads((stage/'registry.json').read_text('utf8')))
                remote[:]=[uploads[-1]]
                return worker
            active={'comic-a':comic('comic-a')}
            def live(registry):
                if remote:
                    newer=registry['comics'];registry['comics']={}
                    o.combine(registry,remote[0]['comics']);o.combine(registry,newer)
                    return remote[0]
                return None
            with patch.object(o,'local_candidates',side_effect=lambda en:active),\
                 patch.object(o,'remote_candidates',return_value=({},set())),\
                 patch.object(o,'_validate_live_assets'),\
                 patch.object(o,'_load_live_worker',side_effect=live),\
                 patch.object(o,'_assert_no_unowned_existing_worker'),\
                 patch.object(o,'_finalize_legacy_links'),\
                 patch.object(o,'_remote_shared_registry',return_value=(None,None)),\
                 patch.object(o,'_checkpoint_shared_registry'),\
                 patch.object(o,'_deploy',side_effect=deploy),\
                 patch.object(o,'_verify_published'):
                self.assertEqual(o.publish(dummy,object()),worker)
                self.assertEqual(set(uploads[-1]['comics']),{'comic-a'})
                active={'comic-b':comic('comic-b')}
                self.assertEqual(o.publish(dummy,object()),worker)
                self.assertEqual(set(uploads[-1]['comics']),{'comic-a','comic-b'})
                self.assertEqual(o.publish(dummy,object()),worker)
                self.assertEqual(len(uploads),2,'unchanged library must not redeploy')
                self.assertEqual(set(o.load_state(root)['comics']),{'comic-a','comic-b'})

    def test_static_route_uses_existing_reader_app_without_new_site_code(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);copy_reader_fixture(root)
            reg={'comics':{'comic-a':comic('comic-a'),'comic-b':comic('comic-b')}}
            out=root/'staged';o.stage_worker_assets(root,reg,out)
            self.assertTrue((out/'comics/comic-a/manifest.json').exists())
            self.assertTrue((out/'comics/comic-b/app.js').exists())
            self.assertIn('comic-a', (out/'library.json').read_text('utf8'))
            self.assertEqual(json.loads((out/'comics/comic-a/manifest.json').read_text('utf8'))['chapters'][0]['id'],'1')
            self.assertIn('Find a comic',(out/'index.html').read_text('utf8'))

    def test_existing_worker_without_registry_cannot_be_overwritten(self):
        dummy=SimpleNamespace(npx_wrangler=lambda *a,**kw:SimpleNamespace(returncode=0,stdout='[{"id":"abc"}]',stderr=''))
        with self.assertRaisesRegex(RuntimeError,'already exists'):
            o._assert_no_unowned_existing_worker(dummy, {'worker_url':''})


    def test_first_run_of_new_adapter_uses_its_default_url_without_flags(self):
        import sys
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE options(key TEXT,value TEXT)')
        db.execute('CREATE TABLE chapters(chapter_id TEXT,status TEXT)')
        observed=[]
        from reusable import title_reconcile
        with patch.object(engine,'init_db',return_value=db), \
             patch.object(engine,'_inherit_shared_github_auth'), \
             patch.object(engine,'archive_run',side_effect=lambda con,source_html,url,*rest,**kw:observed.append(url)), \
             patch.object(engine,'deploy_run'), \
             patch.object(engine,'all_work_completed',return_value=False), \
             patch.object(engine,'status'), \
             patch.object(title_reconcile,'reconcile_native_titles'), \
             patch.object(sys,'argv',['run.py','--resume','--authorized']):
            engine.main()
        self.assertEqual(observed,[engine.ADAPTER.DEFAULT_START_URL])
        db.close()

    def test_adapter_not_changed_by_new_publisher(self):
        self.assertEqual(engine.build_parser().parse_args([]).cloudflare_mode,'shared-worker')
        self.assertIn('shared-worker',engine.build_parser().format_help())


    def test_github_registry_backup_initializes_and_verifies(self):
        record = {'version':o.SCHEMA, 'worker_url':'https://open-reader.acct.workers.dev',
                  'comics':{'comic-a':comic('comic-a')}}
        saved = {'content':None, 'sha':None}
        creates=[]; writes=[]
        class Fake:
            GITHUB_API='https://api.github.com'
            def github_http(self,method,url,token,**kw):
                if method=='POST':
                    creates.append(kw['json'])
                    return SimpleNamespace(status_code=201,json=lambda:{})
                if method=='GET':
                    if url.endswith('/repos/owner/open-reader'):
                        if not creates:
                            return SimpleNamespace(status_code=404,json=lambda:{})
                        return SimpleNamespace(status_code=200,json=lambda:{'private':True,'default_branch':'master',
                                                                             'description':o.REGISTRY_DESCRIPTION})
                    if saved['content'] is None:
                        return SimpleNamespace(status_code=404,json=lambda:{})
                    return SimpleNamespace(status_code=200,json=lambda:{'sha':saved['sha'],
                        'content':base64.b64encode(saved['content']).decode()})
                if method=='PUT':
                    writes.append(kw['json'])
                    data=base64.b64decode(kw['json']['content'])
                    saved['content']=data;saved['sha']='new-blob'
                    return SimpleNamespace(status_code=201,json=lambda:{})
                raise AssertionError(method)
        fake=Fake()
        with patch.object(o,'_repo_contents',side_effect=lambda eng,owner,tok,repo,fp,**kw:saved['content']):
            o._checkpoint_shared_registry(fake,object(),'owner','token',record,None,set())
            o._checkpoint_shared_registry(fake,object(),'owner','token',record,'new-blob',{'open-reader'})
        self.assertEqual(len(creates),1)
        self.assertTrue(creates[0]['private'])
        self.assertEqual(len(writes),1,'identical registry should never create a new commit')
        self.assertEqual(writes[0]['branch'],'master')
        self.assertEqual(json.loads(saved['content'])['comics']['comic-a']['slug'],'comic-a')

    def test_github_registry_concurrent_write_is_not_overwritten(self):
        class Fake:
            GITHUB_API='https://api.github.com'
            def github_http(self,method,url,token,**kwargs):
                self_ = self
                if method=='PUT':
                    raise AssertionError('Concurrent write must never PUT')
                if url.endswith('/repos/owner/open-reader'):
                    return SimpleNamespace(status_code=200,json=lambda:{'private':True,'default_branch':'main'})
                return SimpleNamespace(status_code=200,json=lambda:{'sha':'newer-version'})
        with self.assertRaisesRegex(RuntimeError,'changed during publication'):
            o._checkpoint_shared_registry(Fake(),object(),'owner','token',
                {'worker_url':'https://open-reader.acct.workers.dev','comics':{}},
                'old-version', {'open-reader'})

    def test_readme_updater_preserves_old_text_and_is_idempotent(self):
        old=b'# Old archive\n\nKeep original info\n'
        record={'bytes':old,'sha':'initial'};updates=[]
        class Fake:
            GITHUB_API='https://api.github.com'
            def github_http(self,method,url,token,**kw):
                if method=='PUT':
                    updates.append(kw['json'])
                    record['bytes']=base64.b64decode(kw['json']['content'])
                    record['sha']='updated'
                    return SimpleNamespace(status_code=200,json=lambda:{})
                return SimpleNamespace(status_code=200,json=lambda:{'sha':record['sha']})
        with patch.object(o,'_repo_contents',side_effect=lambda *a:record['bytes']):
            route='https://open-reader.acct.workers.dev/comics/comic-a/'
            self.assertTrue(o._sync_github_readme(Fake(),'owner','token','comic-a-reader','comic-a',route))
            self.assertFalse(o._sync_github_readme(Fake(),'owner','token','comic-a-reader','comic-a',route))
        self.assertEqual(len(updates),1)
        self.assertIn(b'Keep original info',record['bytes'])
        self.assertIn(b'<!-- open-reader:begin -->',record['bytes'])

    def test_legacy_pages_project_discovery_recovers_reader(self):
        doc={'title':'A','chapters':comic('comic-a')['chapters']}
        class Fake:
            def list_pages_projects(self):
                return [{'name':'comic-a-reader','subdomain':'comic-a-reader.pages.dev'}]
            def credential_for_selected(self,db):return ('owner','token')
        with patch.object(o,'_owned_repos',return_value=set()), \
             patch.object(o,'_public_json',return_value=doc), \
             patch.object(o,'_volume_manifest_candidates',return_value={}):
            found,repos=o.remote_candidates(Fake(),object(),{})
        self.assertEqual(len(found['comic-a']['chapters']),2)
        self.assertIn('https://comic-a-reader.pages.dev',found['comic-a']['legacy_urls'])
        self.assertEqual(repos,set())

    def test_legacy_volume_metadata_recovery_without_reader_or_local_db(self):
        checksum=hashlib.sha256(b'img').hexdigest()
        manifest={'chapter_id':'1','label':'Ep. 1','chapter_title':'Ep. 1 - Extra',
                  'remote_files':['chapters/1/0001.jpg'],
                  'images':[{'sha256':checksum,'width':300,'height':800}]}
        class Fake:
            GITHUB_API='https://api.github.com'
            def github_http(self,method,url,token,**kw):
                if '/git/trees/' in url:
                    return SimpleNamespace(status_code=200,json=lambda:{'tree':[
                        {'path':'chapters/1/manifest.json','type':'blob'},
                        {'path':'chapters/1/0001.jpg','type':'blob'}]})
                return SimpleNamespace(status_code=200,json=lambda:{'content':base64.b64encode(json.dumps(manifest).encode()).decode()})
        result=o._volume_manifest_candidates(Fake(),'owner','token',{'comic-a-vol-001'},
             {'comic-a-vol-001':'https://comic-a-vol-001.pages.dev'}, {})
        self.assertEqual(result['comic-a']['chapters'][0]['title'],'Ep. 1 - Extra')
        self.assertIn('comic-a-vol-001.pages.dev',result['comic-a']['chapters'][0]['images'][0]['url'])

    def test_github_old_reader_manifest_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            # Content API response has base64; legacy reader repo is a valid
            # source of truth when all SQLite files are missing.
            sample=comic('comic-a')
            raw=json.dumps({'title':'Recovered A','chapters':sample['chapters']}).encode()
            class Dummy:
                GITHUB_API='https://api.github.com'
                def github_http(self,method,url,token,**k):
                    if url.endswith('website%2Fmanifest.json'):
                        raise AssertionError('Path separators must be preserved')
                    if url.endswith('/website/manifest.json?ref=main'):
                        return SimpleNamespace(status_code=200,json=lambda:{'content':base64.b64encode(raw).decode(),'sha':'x'})
                    return SimpleNamespace(status_code=404)
            out=o._repo_contents(Dummy(),'owner','token','comic-a-reader','website/manifest.json')
            self.assertEqual(json.loads(out)['title'],'Recovered A')

if __name__=='__main__':unittest.main()
