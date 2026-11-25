"""Exercise the authenticated final stage and real focused no-op publisher, offline."""
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, mock
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import requests
from reusable import engine as e, open_reader as r, open_reader_focused as f
from reusable import open_reader_verify_auth as a, shared_reader_volume as v, github_streaming as gs

URL = 'https://open-reader.fixture.workers.dev'
SLUG = 'fixture-comic'
REPO = SLUG + '-vol-001'
COOKIE = '9999999999.' + 'a'*43
FRONTEND = 'f'*64
PANEL = b'fixture-image-bytes'
DIGEST = hashlib.sha256(PANEL).hexdigest()

def reply(code, obj=None, raw=None, headers=None):
    response = requests.Response()
    response.status_code = code
    response.headers.update(headers or {})
    response._content = raw if raw is not None else r.canonical(obj or {})
    response.url = URL
    return response

class Completion(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(e,'ROOT',self.root))
        self.stack.enter_context(mock.patch.object(e,'DATA',self.root/'.archiver_state'/'sites'/'fixture'))
        self.db = e.init_db(); self.addCleanup(self.db.close)
        for key,val in [('series_slug',SLUG),('series_title','Fixture Comic'),
                        ('chapter_catalog_complete',True),('chapter_catalog_total',2)]:
            e.set_option(self.db,key,val)
        for i in ('1','2.5'):
            manifest={'chapter_title':'Chapter '+i,'images':[{'sha256':DIGEST,'width':30,'height':40}],
                      'remote_files':[f'chapters/{i}/0001.png']}
            self.db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status,repository,pages_json) VALUES(?,?,?,?,?,?,?)',
                            (i,'Chapter '+i,'https://source.invalid/'+i,1 if i=='1' else 2,
                             'ARCHIVED_PENDING_DEPLOYMENT',REPO,json.dumps(manifest)))
        self.db.commit()
        self.stack.enter_context(mock.patch.object(gs,'load_mode',return_value={'owner':'owner'}))
        self.comic=f.current_comic(e,self.db)
        self.registry={'version':r.SCHEMA,'worker_url':URL,'comics':{SLUG:self.comic},'verified_frontend_hash':FRONTEND}
        r.save_state(e,self.registry)
        self.live=r._registry_payload(self.registry,FRONTEND)
        self.backup={k:self.registry[k] for k in ('version','worker_url','comics')}
        self.readme=(f'# Existing text\n\n<!-- open-reader:begin -->\n\nShared comic library: [open-reader]({URL}/)\n\nRead this series: [{SLUG}]({URL}/comics/{SLUG}/)\n\n<!-- open-reader:end -->\n').encode()
        self.files={'/registry.json':r.canonical(self.live), '/source-issues.json':r.canonical({'schema':'comicarchiver.source_issue_feed.v1','cases':[],'resolved_ids':[]}),
                    '/comics/'+SLUG+'/manifest.json':r.canonical({'chapters':self.comic['chapters']}),
                    '/':b'home','/upload-catalog.json':b'{}','/comics/'+SLUG+'/settings':b'settings'}
        self.gets=[];self.posts=[];self.github_calls=[]
        a._CACHE.clear(); self.addCleanup(a._CACHE.clear)
        self.stack.enter_context(mock.patch.object(a,'_load',side_effect=lambda origin:a._CACHE.get(origin)))
        self.stack.enter_context(mock.patch.object(a,'_save',side_effect=lambda origin,cookie:a._CACHE.__setitem__(origin,cookie)))
        self.stack.enter_context(mock.patch.dict(os.environ,{'OPEN_READER_VERIFY_PASSWORD':'fixture-password'}))
        self.stack.enter_context(mock.patch.object(a.requests,'get',side_effect=self.http_get))
        self.stack.enter_context(mock.patch.object(a.requests,'post',side_effect=self.http_post))
        self.stack.enter_context(mock.patch.object(e,'credential_for_selected',return_value=('owner','token')))
        self.stack.enter_context(mock.patch.object(e,'github_http',side_effect=self.github))
        self.stack.enter_context(mock.patch.object(e,'select_cloudflare_account'))
        self.stack.enter_context(mock.patch.object(e,'event'))
        self.stack.enter_context(mock.patch.object(r,'_reader_hash',return_value=FRONTEND))
        self.stack.enter_context(mock.patch.object(r,'stage_worker_assets',side_effect=self.stage))
        self.stack.enter_context(mock.patch('reusable.partial_chapter_publish.publish_partial_checkpoints',return_value={}))
        self.stack.enter_context(mock.patch.object(r,'_assert_no_unowned_existing_worker'))
        self.deploy=self.stack.enter_context(mock.patch.object(r,'_deploy',side_effect=AssertionError('must not deploy unchanged assets')))
        self.stack.enter_context(mock.patch('time.sleep'))

    def http_get(self,url,**kw):
        self.gets.append((url,kw))
        if not url.startswith(URL+'/'):
            return reply(200,raw=PANEL)
        if kw.get('headers',{}).get('Cookie') != 'reader_site='+COOKIE:
            return reply(401)
        path=url[len(URL):]
        if path=='/api/reader-health':
            return reply(200,{'script':'open-reader-panel-replacement-v1','github_streaming_configured':True})
        if path.endswith('/settings.html'):
            return reply(307,headers={'Location':path[:-5]})
        if path=='/api/github-replacements.json':
            return reply(200,{'schema':'reader-github-replacements-v1','panels':{}})
        if path.startswith('/api/github-image/'):
            return reply(200,raw=PANEL)
        if path in self.files:
            return reply(200,raw=self.files[path])
        return reply(404)

    def http_post(self,url,**kw):
        self.posts.append(url)
        self.assertEqual(url,URL+'/api/admin/login')
        response=reply(200); response.cookies.set('reader_site',COOKIE); return response

    def github(self,method,url,token,**kw):
        self.github_calls.append((method,url))
        self.assertEqual(method,'GET')  # no mutation on already-current run
        if '/contents/chapters/' in url:
            return reply(200,raw=PANEL)
        if '/contents/registry.json' in url or '/contents/README.md' in url:
            data=r.canonical(self.backup) if '/registry.json' in url else self.readme
            sha=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
            return reply(200,{'sha':sha,'encoding':'base64','content':base64.b64encode(data).decode()})
        return reply(200,{'private':True,'owner':{'login':'owner'},'default_branch':'main'})

    def stage(self,root,registry,stage,**kw):
        self.assertEqual(r._registry_payload(registry,FRONTEND),self.live)
        for path,data in self.files.items():
            name='index.html' if path=='/' else path.lstrip('/')+('.html' if path.endswith('/settings') else '')
            target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        return self.live

    def main_run(self, args):
        with mock.patch.object(e,'init_db',return_value=self.db), mock.patch.object(e,'_inherit_shared_github_auth'), \
             mock.patch.object(e,'status'), mock.patch('reusable.title_reconcile.reconcile_native_titles'), \
             mock.patch.object(sys,'argv',['run.py',*args]), mock.patch.object(e,'request_windows_shutdown_after_completion') as shutdown, \
             mock.patch.object(e,'archive_run',side_effect=AssertionError('no source crawl')), redirect_stdout(io.StringIO()) as out:
            e.main()
            shutdown.assert_not_called()
        return out.getvalue()

    def test_normal_focused_noop_runs_all_final_checks_and_completion(self):
        output=self.main_run(['--deploy','--authorized','--open-reader-update-scope','comic','--skip-initial-github-check'])
        self.assertIn('RUN COMPLETE',output);self.assertIn('focused assets already live; no upload',output)
        self.assertIn('verified fixture-comic (2 archived chapters)',output)
        self.assertEqual(len(self.posts),1)
        target=URL+'/comics/'+SLUG+'/manifest.json'
        self.assertEqual(len([u for u,k in self.gets if u==target]),2)
        self.assertTrue(all(k['headers']['Cookie']=='reader_site='+COOKIE for u,k in self.gets if u==target))
        self.assertTrue(e.all_work_completed(self.db,mode='shared-worker',worker_url=URL))
        self.deploy.assert_not_called()

    def test_repair_completion_avoids_staging_and_image_checks(self):
        f._checkpoint_current(self.db,e,self.registry,SLUG)
        # main closes the connection in its recovery-only branch; avoid double close in cleanup
        output=self.main_run(['--repair-reader-readmes'])
        self.assertIn('RUN COMPLETE',output)
        self.assertFalse(any('/api/github-image/' in u or '/settings' in u for u,k in self.gets))
        self.assertFalse(any('/contents/chapters/' in u for _,u in self.github_calls))
        self.deploy.assert_not_called()

    def test_final_check_reuses_session(self):
        a._CACHE[URL]=COOKIE
        self.assertTrue(v.verify_current_in_shared_reader(e,self.db,URL));self.assertEqual(self.posts,[])

    def test_final_check_logs_in_once_when_needed(self):
        self.assertTrue(v.verify_current_in_shared_reader(e,self.db,URL))
        self.assertTrue(v.verify_current_in_shared_reader(e,self.db,URL));self.assertEqual(len(self.posts),1)

    def test_missing_chapter_rejected(self):
        self.files['/comics/'+SLUG+'/manifest.json']=r.canonical({'chapters':[{'id':'1'}]})
        with self.assertRaisesRegex(RuntimeError,'omitted 1'):v.verify_current_in_shared_reader(e,self.db,URL)

    def test_duplicate_id_rejected(self):
        self.files['/comics/'+SLUG+'/manifest.json']=r.canonical({'chapters':[{'id':'1'},{'id':'1'}]})
        with self.assertRaisesRegex(RuntimeError,'duplicate'):v.verify_current_in_shared_reader(e,self.db,URL)

    def test_unauthorized_after_login_is_not_misreported_as_missing(self):
        with mock.patch.object(a.requests,'get',return_value=reply(401)):
            with self.assertRaisesRegex(RuntimeError,'session was rejected'):v.verify_current_in_shared_reader(e,self.db,URL)
        self.assertEqual(len(self.posts),1)

    def test_500_is_not_misreported_as_missing(self):
        with mock.patch.object(a.requests,'get',return_value=reply(500)):
            with self.assertRaisesRegex(RuntimeError,'HTTP 500'):v.verify_current_in_shared_reader(e,self.db,URL)
        self.assertEqual(self.posts,[])

    def test_external_redirect_rejected(self):
        with mock.patch.object(a.requests,'get',return_value=reply(302,headers={'Location':'https://other.invalid/login'})):
            with self.assertRaisesRegex(RuntimeError,'HTTP 302'):v.verify_current_in_shared_reader(e,self.db,URL)
        self.assertEqual(self.posts,[])

    def test_legacy_asset_verification_uses_auth_without_leaking_to_pages(self):
        a._CACHE[URL]=COOKIE
        e.verify_cloudflare_asset(URL+'/api/github-image/fixture-comic/1/1?v='+DIGEST,DIGEST,attempts=1)
        e.verify_cloudflare_asset('https://other.pages.dev/image.png',DIGEST,attempts=1)
        self.assertEqual(self.gets[-2][1]['headers']['Cookie'],'reader_site='+COOKIE)
        self.assertNotIn('Cookie',self.gets[-1][1].get('headers',{}))

    def test_adoption_uses_auth_and_rejects_path(self):
        with mock.patch.object(e,'init_db',return_value=self.db),mock.patch.object(e,'_inherit_shared_github_auth'),mock.patch.object(e,'status'),mock.patch.object(sys,'argv',['run.py','--open-reader-url',URL]):
            e.main()
        self.assertEqual(len(self.posts),1)
        with mock.patch.object(e,'init_db',return_value=self.db),mock.patch.object(sys,'argv',['run.py','--open-reader-url',URL+'/other']):
            with self.assertRaisesRegex(RuntimeError,'production URL'):e.main()

    def test_health_failure_does_not_redeploy(self):
        with mock.patch.object(a.requests,'get',side_effect=lambda url,**kw:reply(503) if url.endswith('/api/reader-health') else self.http_get(url,**kw)):
            with self.assertRaisesRegex(RuntimeError,'HTTP 503'):e.deploy_run(self.db,update_scope='comic')
        self.deploy.assert_not_called()

    def test_asset_timeout_does_not_redeploy(self):
        def get(url,**kw):
            if url.endswith('/settings'):raise requests.Timeout('fixture timeout')
            return self.http_get(url,**kw)
        with mock.patch.object(a.requests,'get',side_effect=get):
            with self.assertRaisesRegex(RuntimeError,'Timeout'):e.deploy_run(self.db,update_scope='comic')
        self.deploy.assert_not_called()

    def test_proven_static_mismatch_allows_stale_recovery(self):
        def get(url,**kw):
            if url==URL+'/' and kw.get('headers',{}).get('Cookie'):return reply(200,raw=b'old')
            return self.http_get(url,**kw)
        with mock.patch.object(a.requests,'get',side_effect=get):
            with self.assertRaisesRegex(AssertionError,'must not deploy'):e.deploy_run(self.db,update_scope='comic')
        self.deploy.assert_called_once()

    def test_wrong_chapter_url_prevents_completion(self):
        f._checkpoint_current(self.db,e,self.registry,SLUG)
        self.db.execute('UPDATE chapters SET published_url=? WHERE chapter_id=?',(URL+'/comics/'+SLUG+'/?chapter=wrong','1'))
        self.assertFalse(e.all_work_completed(self.db,mode='shared-worker',worker_url=URL))

    def test_changed_dynamic_manifest_allows_redeployment_when_overlays_healthy(self):
        target=URL+'/comics/'+SLUG+'/manifest.json'
        def get(url,**kw):
            if url==target and kw.get('headers',{}).get('Cookie'):
                return reply(200,{'chapters':[]})
            return self.http_get(url,**kw)
        with mock.patch.object(a.requests,'get',side_effect=get):
            with self.assertRaisesRegex(AssertionError,'must not deploy'):
                e.deploy_run(self.db,update_scope='comic')
        self.deploy.assert_called_once()

    def test_unavailable_overlay_does_not_redeploy(self):
        target=URL+'/comics/'+SLUG+'/manifest.json'
        def get(url,**kw):
            if url==target and kw.get('headers',{}).get('Cookie'):
                return reply(200,{'chapters':[]})
            if url.endswith('/api/github-replacements.json'):
                return reply(503)
            return self.http_get(url,**kw)
        with mock.patch.object(a.requests,'get',side_effect=get):
            with self.assertRaisesRegex(RuntimeError,'replacement index: HTTP 503'):
                e.deploy_run(self.db,update_scope='comic')
        self.deploy.assert_not_called()

    def test_full_publisher_final_check_and_completion(self):
        with mock.patch.object(r,'local_candidates',return_value={SLUG:self.comic}), \
             mock.patch.object(r,'remote_candidates',return_value=({}, {r.WORKER_NAME, REPO})):
            output=self.main_run(['--deploy','--authorized','--open-reader-update-scope','full','--skip-initial-github-check'])
        self.assertIn('RUN COMPLETE',output)
        self.assertTrue(e.all_work_completed(self.db,mode='shared-worker',worker_url=URL))
        self.assertEqual(len(self.posts),1)
        self.deploy.assert_not_called()
