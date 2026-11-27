import hashlib, tempfile, unittest, subprocess, os, contextlib, io
from pathlib import Path
from unittest.mock import patch, Mock
from types import SimpleNamespace
import requests
from PIL import Image
import pymupdf as fitz
from reusable import github_cooldown as cd, local_comic_uploader as lu, engine

def response(status=200,headers=None,text=''):
    return Mock(status_code=status,headers=headers or {},text=text)

class LocalUploadTests(unittest.TestCase):
    def test_rate_headers_and_backoff(self):
        self.assertEqual(cd.response_delay(response(403,{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'8000'}),0,now=1000),7003)
        self.assertEqual(cd.response_delay(response(429,{'Retry-After':'7200'}),12),7200)
        self.assertEqual([cd.backoff(i) for i in range(8)],[60,120,240,480,960,1920,3600,3600])
        self.assertIsNone(cd.response_delay(response(403,{},'Permission denied')))
    def test_run_py_read_write_unlimited_confirmed_rate(self):
        for method in ('GET','PUT','POST'):
            with contextlib.redirect_stdout(io.StringIO()),self.subTest(method=method),patch.object(engine.requests,'request',side_effect=[response(429)]*12+[response()]) as req,patch.object(engine,'event'),patch.object(engine.time,'sleep') as sleep:
                self.assertEqual(engine.github_http(method,'https://api.github.com/repos/a/b','token').status_code,200)
                self.assertEqual(req.call_count,13);self.assertEqual(sleep.call_count,12);self.assertEqual(sleep.call_args.args,(3600,))
    def test_local_read_and_create_after_many_rates(self):
        waits=[];gh=lu.GitHub('owner','token',{},lambda *a:None,wait=waits.append)
        with patch.object(lu.requests,'get',side_effect=[response(403,{},'secondary rate limit')]*12+[response()]):
            self.assertEqual(gh.read('/user').status_code,200)
        self.assertEqual(len(waits),12);self.assertEqual(waits[-1],3600)
        with patch.object(gh,'repo_info',side_effect=[None]*13+[{'description':'marker'}]),patch.object(lu.requests,'post',side_effect=[response(429)]*12+[response(201)]) as post:
            gh.ensure_repo('repo','marker');self.assertEqual(post.call_count,13)
    def test_git_reconcile_after_throttle(self):
        oid='a'*40;cmd=['git','push','origin',oid+':refs/heads/main'];error=subprocess.CompletedProcess(cmd,1,b'',b'error: HTTP 429 Too Many Requests');ok=subprocess.CompletedProcess(cmd,0,(oid+'\trefs/heads/main\n').encode(),b'')
        with patch.object(cd.subprocess,'run',side_effect=[error,ok]) as run,patch.object(cd,'wait'):
            self.assertEqual(cd.git_run(cmd,capture_output=True).returncode,0);self.assertEqual(run.call_count,2);self.assertEqual(run.call_args.args[0][1],'ls-remote')
    def test_git_many_rejections_no_retry_ceiling(self):
        cmd=['git','fetch','origin','main'];err=subprocess.CompletedProcess(cmd,1,b'',b'error: HTTP 429');ok=subprocess.CompletedProcess(cmd,0,b'',b'')
        with patch.object(cd.subprocess,'run',side_effect=[err]*12+[ok]),patch.object(cd,'wait') as w:
            self.assertEqual(cd.git_run(cmd,capture_output=True).returncode,0);self.assertEqual(w.call_count,12)
    def test_permanent_git_error_no_retry(self):
        cmd=['git','push','origin','a'*40+':refs/heads/main'];err=subprocess.CompletedProcess(cmd,1,b'',b'permission denied (403)')
        with patch.object(cd.subprocess,'run',return_value=err) as r,patch.object(cd,'wait') as w:
            self.assertEqual(cd.git_run(cmd,capture_output=True).returncode,1);r.assert_called_once();w.assert_not_called()
    def test_real_pdf_path_render_and_changed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'sample.pdf';d=fitz.open()
            for i in range(3):d.new_page(width=300,height=600).insert_text((50,50),f'Page {i}')
            d.save(path);d.close();r=lu.Renderer()
            f=r.probe(path);self.assertEqual(f['count'],3)
            hashes=[]
            for i in range(3):
                raw,w,h=r.render(f,i,1200,0);self.assertEqual((w,h),(1200,2400));hashes.append(lu.digest(raw));self.assertLessEqual(len(raw),lu.MAX_IMAGE)
            self.assertEqual(len(set(hashes)),3);r.close();path.write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'Source file changed'):r.render(f,0,1200,0)
    def test_real_git_push_remote_byte_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);repo=root/'source';remote=root/'remote.git';verify=root/'verify';repo.mkdir();gh=lu.GitHub('owner','token',os.environ.copy(),lambda *a:None,wait=lambda s:None)
            gh.git(['init','--bare',str(remote)],root);gh.git(['init','-b','main'],repo)
            content=b'known sample bytes';(repo/'page.png').write_bytes(content);gh.git(['add','page.png'],repo);gh.git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','fixture'],repo);oid=gh.git(['rev-parse','HEAD'],repo)
            files=[('page.png',lu.digest(content),len(content))];gh.push_verified(repo,verify,str(remote),oid,'',files);gh.push_verified(repo,verify,str(remote),oid,'',files)
            self.assertEqual(gh.remote_head(str(remote),repo),oid)
            with self.assertRaisesRegex(RuntimeError,'SHA-256 mismatch'):gh.push_verified(repo,verify,str(remote),oid,'',[('page.png','0'*64,len(content))])
    def test_local_push_waits_beyond_old_ceiling(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);gh=lu.GitHub('owner','token',{},lambda *a:None,wait=lambda s:None);oid='a'*40
            with patch.object(gh,'remote_head',side_effect=[lu.GitError('HTTP 429')]*12+[oid,oid]),patch.object(gh,'git',side_effect=['','',oid,b'x']),patch.object(gh,'cooldown') as cooldown:
                gh.push_verified(root,root/'verify','url',oid,'',[('x',lu.digest(b'x'),1)]);self.assertEqual(cooldown.call_count,12)
    def test_checkpoint_reloads(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'job.sqlite';j=lu.Journal(path);j.put({'finished':False,'completed':['abc',None]});self.assertEqual(lu.Journal(path).get()['completed'],['abc',None])
    def test_job_rotates_volumes_and_resumes_after_index_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);remotes=root/'remotes';remotes.mkdir();work=root/'work';work.mkdir();path=root/'sample.pdf'
            d=fitz.open()
            for i in range(4):d.new_page(width=120,height=240).insert_text((15,30),f'Page {i}')
            d.save(path);d.close();render=lu.Renderer();f=render.probe(path)
            sizes=[len(render.render(f,i,600,0)[0]) for i in range(4)];render.close()
            class LocalGH(lu.GitHub):
                def repo_info(self,name):return {'description':'fixture'} if (remotes/name).exists() else None
                def ensure_repo(self,name,marker):
                    if not (remotes/name).exists():self.git(['init','--bare',str(remotes/name)],remotes)
                def git(self,args,cwd,**kw):
                    args=[str(remotes/(a.rsplit('/',1)[-1].removesuffix('.git'))) if a.startswith('https://github.com/owner/') else a for a in args]
                    return super().git(args,cwd,**kw)
            gh=LocalGH('owner','not-a-real-token',os.environ.copy(),lambda *a:None,wait=lambda s:None)
            class Site:
                def __init__(self):self.fail=True;self.indexes=[];self.state={'revision':0,'publication':'draft','metadata':{},'chapters':[]};self.final=0
                def request(self,path,method='GET',body=None):
                    if path.endswith('/local-init'):return {'revision':0}
                    if path.endswith('/local-index'):
                        if self.fail:self.fail=False;raise lu.SiteError(503,'fixture index interruption')
                        self.indexes.append(body);return {'ok':True}
                    if method=='GET':return self.state
                    if method=='PUT':self.state={**body,'revision':1,'publication':'published'};self.final+=1;return {'revision':1}
                    raise AssertionError(path)
            site=Site();journal=lu.Journal(work/'job.sqlite');slug='import-'+'a'*32;cid='ch-'+'b'*32
            job={'id':'fixture','owner':'owner','sources':{f['id']:f},'works':[{'slug':slug,'revision':0,'metadata':{'title':'Fixture'},'chapters':[{'id':cid,'number':'1','title':'One','count':4}],'flat':[{'source':f['id'],'page':i} for i in range(4)],'completed':[None]*4,'pending':[]}],'pdf_width':600,'image_limit':0,'finished':False}
            journal.put(job);u=lu.UploadJob(work,journal,gh,site,lambda *a:None,batch=max(sizes)+1,volume=128*1024+max(sizes)+512)
            with self.assertRaises(lu.SiteError):u.run(job)
            checkpoint=journal.get();self.assertTrue(checkpoint['works'][0]['remote_verified']);self.assertFalse(checkpoint['finished']);self.assertTrue(checkpoint['works'][0]['pending'])
            u.run(checkpoint);done=journal.get();self.assertTrue(done['finished']);self.assertEqual(site.final,1);self.assertEqual(len(site.state['chapters'][0]['pages']),4);self.assertEqual(len(set(site.state['chapters'][0]['pages'])),4)
            self.assertGreater(len(list(remotes.iterdir())),1);self.assertFalse(list((work/'fixture'/'spool').iterdir()))
    def test_every_journal_connection_is_closed_on_success_and_failure(self):
        import sqlite3
        opened=[]
        class TrackingConnection(sqlite3.Connection):
            def close(self):
                self.closed=True
                super().close()
        real=sqlite3.connect
        def connect(*a,**kw):
            c=real(*a,**kw,factory=TrackingConnection);c.closed=False;opened.append(c);return c
        with tempfile.TemporaryDirectory() as t,patch.object(lu.sqlite3,'connect',side_effect=connect):
            p=Path(t)/'job.sqlite';j=lu.Journal(p);self.assertTrue(all(c.closed for c in opened))
            j.put({'data':'ok'});self.assertEqual(j.get(),{'data':'ok'})
            with self.assertRaises(TypeError):j.put({'not_json':object()})
            self.assertTrue(all(c.closed for c in opened));self.assertGreaterEqual(len(opened),4)
            for c in opened:
                with self.assertRaises(sqlite3.ProgrammingError):c.execute('SELECT 1')
            new=p.with_suffix('.renamed');p.rename(new);new.unlink()
    def test_pragma_error_closes_handle(self):
        connection=Mock();connection.execute.side_effect=OSError('fixture PRAGMA failed')
        j=object.__new__(lu.Journal);j.path=Path('unused')
        with patch.object(lu.sqlite3,'connect',return_value=connection):
            with self.assertRaises(OSError):j.connect()
        connection.close.assert_called_once()
    def test_pdf_probe_and_thumbnail_close_file_even_on_error(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'日本語 comic.pdf'
            with fitz.open() as doc:
                doc.new_page(width=90,height=180);doc.save(path)
            gh=SimpleNamespace(report=None);site=SimpleNamespace(report=None)
            app=lu.Companion('https://example.test',site,gh,Path(t)/'state')
            f=app.preview.probe(path);self.assertIsNone(app.preview.doc);app.sources[f['id']]=f
            self.assertTrue(app.thumbnail(f['id'],0).startswith(b'\x89PNG'));self.assertIsNone(app.preview.doc)
            with self.assertRaises(RuntimeError):app.thumbnail(f['id'],100)
            self.assertIsNone(app.preview.doc);path.unlink()
    def test_pdf_probe_closes_encrypted_document(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'locked.pdf'
            with fitz.open() as doc:
                doc.new_page();doc.save(path,encryption=fitz.PDF_ENCRYPT_AES_256,user_pw='test-pass',owner_pw='owner-pass')
            r=lu.Renderer()
            with self.assertRaisesRegex(RuntimeError,'Password-protected'):r.probe(path)
            self.assertIsNone(r.doc);self.assertIsNone(r.key);path.unlink()
    def test_picker_process_utf8_and_cancel(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'日本語 page.png'
            with Image.new('RGB',(12,24)) as im:im.save(path)
            app=lu.Companion('https://example.test',SimpleNamespace(report=None),SimpleNamespace(report=None),Path(t)/'state')
            with patch.object(lu.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=lu.encode([str(path)]),stderr=b'')) as call:
                result=app.pick();self.assertEqual(result[0]['name'],path.name);self.assertEqual(result[0]['count'],1);self.assertNotIn('path',result[0]);self.assertIn('tkinter',call.call_args.args[0][-1])
            with patch.object(lu.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'[]',stderr=b'')):
                self.assertEqual(app.pick(),[])
            path.unlink()
    def test_atomic_write_failure_keeps_old_file_no_temp_leak(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'checkpoint';path.write_bytes(b'old')
            with patch.object(lu.os,'replace',side_effect=PermissionError('fixture locked')):
                with self.assertRaises(PermissionError):lu.atomic(path,b'new')
            self.assertEqual(path.read_bytes(),b'old');self.assertEqual(list(Path(t).iterdir()),[path])
    def test_git_environment_isolated_and_permanent_repo_rejected(self):
        gh=lu.GitHub('owner','token',{'GIT_DIR':'wrong','GIT_INDEX_FILE':'wrong','GCM_NAMESPACE':'keep'},lambda *a:None,wait=lambda s:None)
        self.assertNotIn('GIT_DIR',gh.env);self.assertNotIn('GIT_INDEX_FILE',gh.env);self.assertEqual(gh.env['GCM_NAMESPACE'],'keep')
        with patch.object(gh,'repo_info',return_value=None),patch.object(lu.requests,'post',return_value=response(422)) as post,patch.object(gh,'cooldown') as wait:
            with self.assertRaisesRegex(RuntimeError,'422'):gh.ensure_repo('repo','marker')
            post.assert_called_once();wait.assert_not_called()
    def test_inventory_rate_limit_keeps_live_progress_and_read_retry(self):
        from reusable import archive_inventory as ai
        err=subprocess.CompletedProcess(['git','fetch'],1,b'',b'HTTP 429');ok=subprocess.CompletedProcess(['git','fetch'],0,b'yes',b'')
        for label in (None,'metadata progress'):
            target='_git_with_live_progress' if label else 'run'
            obj=ai if label else ai.subprocess
            with patch.object(obj,target,side_effect=[err]*12+[ok]),patch.object(ai,'wait') as w:
                self.assertEqual(ai._git(Path('.'),{},'fetch','origin','main',progress_label=label),'yes');self.assertEqual(w.call_count,12)
    def test_title_config_prefixed_fetch_waits_without_losing_stdin(self):
        from reusable import title_maintenance as tm
        with patch.object(tm,'_exec_git_once',side_effect=[RuntimeError('HTTP 429')]*12+[b'ok']) as call,patch.object(tm,'wait') as w:
            self.assertEqual(tm._exec_git(Path('.'),{},'-c','fetch.negotiationAlgorithm=noop','fetch','origin','--stdin',data=b'abc\n',raw=True),b'ok')
            self.assertEqual(w.call_count,12);self.assertTrue(all(x.kwargs['data']==b'abc\n' for x in call.call_args_list))
if __name__=='__main__':unittest.main()
