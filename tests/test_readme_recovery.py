"""README-only recovery; offline HTTP fault injection and a real SQLite checkpoint."""
import base64
import hashlib
import sqlite3
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace
import requests
from reusable import open_reader as o, open_reader_focused as f

URL = 'https://open-reader.test-account.workers.dev'
ROUTE = URL + '/comics/comic-a/'
REPO = 'comic-a-vol-002'
ORIGINAL = b'# Existing archive\r\n\r\nKeep all of this.\r\n'

def blob(data):
    return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()

def reply(status, **kw):
    return SimpleNamespace(status_code=status, json=lambda:kw)

class GitHub:
    GITHUB_API = 'https://api.github.com'
    def __init__(self, faults=(), fallback_fault=False):
        self.data = ORIGINAL
        self.faults = list(faults)
        self.calls = []
        self.tree = None
        self.fallback_fault = fallback_fault
        self.desired = None
    def github_http(self, method, url, token, **kw):
        self.calls.append((method,url,kw))
        prefix = self.GITHUB_API+'/repos/owner/'+REPO
        assert url.startswith(prefix), url
        path = url[len(prefix):]
        if method=='GET' and path.startswith('/contents/README.md?ref='):
            return reply(200, sha=blob(self.data), encoding='base64', content=base64.b64encode(self.data).decode())
        if method=='PUT' and path=='/contents/README.md':
            assert kw['json']['sha']==blob(self.data)
            self.desired=base64.b64decode(kw['json']['content'])
            fault = self.faults.pop(0) if self.faults else 200
            if fault=='committed500':
                self.data=self.desired
                return reply(500)
            if fault=='concurrent':
                self.data+=b'New external edit'
                return reply(500)
            if fault=='timeout':raise requests.Timeout()
            if fault==200:self.data=self.desired
            return reply(fault)
        if method=='GET' and path=='/git/ref/heads/main': return reply(200,object={'sha':'head'})
        if method=='GET' and path=='/git/commits/head': return reply(200,tree={'sha':'parent-tree'})
        if method=='POST' and path=='/git/blobs':
            self.desired=base64.b64decode(kw['json']['content']);return reply(201,sha=blob(self.desired))
        if method=='POST' and path=='/git/trees':
            self.tree=kw['json'];return reply(201,sha='new-tree')
        if method=='POST' and path=='/git/commits':
            assert kw['json']['parents']==['head'];return reply(201,sha='new-commit')
        if method=='PATCH' and path=='/git/refs/heads/main':
            assert kw['json']=={'sha':'new-commit','force':False}
            self.data=self.desired
            if self.fallback_fault:raise requests.Timeout()
            return reply(200)
        raise AssertionError((method,path))

class ReadmeRecovery(unittest.TestCase):
    def sync(self, gh):
        with patch('time.sleep'):
            return o._sync_github_readme(gh,'owner','token',REPO,'comic-a',ROUTE)
    def writes(self,gh): return [x for x in gh.calls if x[0]=='PUT']
    def test_transient_500_then_success(self):
        gh=GitHub([500,200]);self.assertTrue(self.sync(gh));self.assertEqual(len(self.writes(gh)),2)
        self.assertIn(ORIGINAL.rstrip(),gh.data);self.assertIn(ROUTE.encode(),gh.data)
        self.assertFalse(self.sync(gh));self.assertEqual(len(self.writes(gh)),2)
    def test_committed_despite_500(self):
        gh=GitHub(['committed500']);self.assertTrue(self.sync(gh));self.assertEqual(len(self.writes(gh)),1)
    def test_timeout_then_success(self):
        gh=GitHub(['timeout',200]);self.assertTrue(self.sync(gh));self.assertEqual(len(self.writes(gh)),2)
    def test_persistent_500_uses_one_file_tree(self):
        gh=GitHub([500,500]);self.assertTrue(self.sync(gh))
        self.assertEqual(gh.tree,{'base_tree':'parent-tree','tree':[{'path':'README.md','mode':'100644','type':'blob','sha':blob(gh.data)}]})
        self.assertIn(ROUTE.encode(),gh.data);self.assertIn(ORIGINAL.rstrip(),gh.data)
    def test_fallback_commit_response_lost(self):
        gh=GitHub([500,500],fallback_fault=True);self.assertTrue(self.sync(gh));self.assertIn(ROUTE.encode(),gh.data)
    def test_concurrent_write_not_overwritten(self):
        gh=GitHub(['concurrent']);
        with self.assertRaisesRegex(RuntimeError,'changed during sync'):self.sync(gh)
        self.assertEqual(len(self.writes(gh)),1);self.assertTrue(gh.data.endswith(b'New external edit'))
    def test_conflict_no_blind_retry(self):
        gh=GitHub([409]);
        with self.assertRaisesRegex(RuntimeError,'conflict'):self.sync(gh)
        self.assertEqual(len(self.writes(gh)),1)
    def test_permission_no_retry(self):
        gh=GitHub([403]);
        with self.assertRaisesRegex(RuntimeError,'HTTP 403'):self.sync(gh)
        self.assertEqual(len(self.writes(gh)),1)
    def test_incomplete_marker_stops_before_write(self):
        gh=GitHub();gh.data+=b'<!-- open-reader:begin -->'
        with self.assertRaisesRegex(RuntimeError,'incomplete'):self.sync(gh)
        self.assertEqual(len(self.writes(gh)),0)
    def test_failed_repo_does_not_block_other_repos(self):
        comic={'chapters':[{'images':[{'github':{'repo':r}} for r in ['a','b','c']]}]}
        reg={'worker_url':URL,'comics':{'comic-a':comic}}
        gh=SimpleNamespace(GITHUB_API='https://api.github.com',github_http=lambda *a:reply(200,private=True,owner={'login':'owner'}))
        seen=[]
        def update(*args):
            repo=args[3];seen.append(repo)
            if repo=='b':raise RuntimeError('server error')
            return True
        with patch.object(o,'_sync_github_readme',side_effect=update):
            with self.assertRaisesRegex(RuntimeError,'pending: b'):f._target_readmes(gh,'owner','token',reg,'comic-a')
        self.assertEqual(seen,['a','b','c'])

class DocsOnly(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE chapters(chapter_id,status,published_url)')
        self.db.execute('INSERT INTO chapters VALUES(?,?,?)',('1','PUBLISHED_VERIFIED',ROUTE+'?chapter=1'))
        self.comic={'chapters':[{'id':'1','images':[{'github':{'repo':REPO}}]}]}
        self.saved={'version':o.SCHEMA,'worker_url':URL,'comics':{'comic-a':self.comic}}
        self.state=dict(self.saved,verified_frontend_hash='f'*64)
        self.live={'version':o.SCHEMA,'frontend_hash':'f'*64,'comics':self.saved['comics']}
        self.engine=SimpleNamespace(ROOT='unused',get_option=lambda *a:'comic-a',credential_for_selected=lambda db:('owner','token'))
    def tearDown(self):self.db.close()
    def run_repair(self):
        with patch.object(o,'load_state',return_value=self.state),patch.object(f,'current_comic',return_value=self.comic),\
            patch.object(o,'_public_json',return_value=self.live),patch.object(o,'_remote_shared_registry',return_value=(self.saved,'sha')),\
            patch.object(f,'_target_readmes') as sync,patch.object(o,'_deploy',side_effect=AssertionError('deploy')),\
            patch.object(o,'_verify_published',side_effect=AssertionError('asset verification')),\
            patch.object(o,'_checkpoint_shared_registry',side_effect=AssertionError('registry mutation')):
            f.repair_verified_readmes(self.engine,self.db)
            sync.assert_called_once_with(self.engine,'owner','token',self.state,'comic-a')
    def test_verified_docs_only(self):self.run_repair()
    def test_unpublished_refused(self):
        self.db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT'")
        with self.assertRaisesRegex(RuntimeError,'not fully checkpointed'):self.run_repair()
    def test_live_registry_change_refused(self):
        self.live=dict(self.live,comics={})
        with self.assertRaisesRegex(RuntimeError,'registry differs'):self.run_repair()
    def test_private_registry_change_refused(self):
        self.saved=dict(self.saved,comics={})
        with self.assertRaisesRegex(RuntimeError,'registry differs'):self.run_repair()
    def test_live_frontend_change_refused(self):
        self.live=dict(self.live,frontend_hash='e'*64)
        with self.assertRaisesRegex(RuntimeError,'frontend differs'):self.run_repair()

if __name__=='__main__':unittest.main()
