"""Regression coverage for ambiguous registry writes; no remote network."""
import base64
import unittest
from types import SimpleNamespace
from unittest import mock
import requests
from reusable import open_reader as reader

REGISTRY = {'worker_url':'https://open-reader.owner.workers.dev','comics':{}}
DATA = reader.canonical({'version':reader.SCHEMA, **REGISTRY})
OLD = b'old registry'

def response(status, data=None):
    return SimpleNamespace(status_code=status, json=lambda: data or {})

class FakeGitHub:
    GITHUB_API = 'https://api.github.com'
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.content = OLD
        self.sha = 'original'
        self.calls = []
        self.new_blob = None
        self.ref_conflict = False
    def store(self, data, sha='new-blob'):
        self.content, self.sha = data, sha
    def github_http(self, method, url, token, **kw):
        self.calls.append((method, url, kw))
        if method=='GET' and url.endswith('/repos/owner/open-reader'):
            return response(200, {'private':True,'default_branch':'main'})
        if method=='GET' and '/contents/registry.json?' in url:
            return response(200, {'sha':self.sha,'content':base64.b64encode(self.content).decode()})
        if method=='PUT':
            assert kw['json']['sha'] == self.sha
            status, write = next(self.outcomes)
            if write=='ours': self.store(base64.b64decode(kw['json']['content']))
            if write=='other': self.store(b'newer registry', 'other')
            if status is None: raise requests.Timeout('test')
            return response(status)
        if method=='GET' and '/git/ref/' in url: return response(200,{'object':{'sha':'head'}})
        if method=='GET' and '/git/commits/' in url: return response(200,{'tree':{'sha':'old-tree'}})
        if method=='POST' and url.endswith('/git/blobs'):
            self.new_blob=base64.b64decode(kw['json']['content']); return response(201,{'sha':'new-blob'})
        if method=='POST' and url.endswith('/git/trees'):
            assert kw['json']=={'base_tree':'old-tree','tree':[{'path':'registry.json','mode':'100644','type':'blob','sha':'new-blob'}]}
            return response(201,{'sha':'new-tree'})
        if method=='POST' and url.endswith('/git/commits'):
            assert kw['json']['parents']==['head']; assert kw['json']['tree']=='new-tree'
            return response(201,{'sha':'commit'})
        if method=='PATCH' and '/git/refs/' in url:
            assert kw['json']=={'sha':'commit','force':False}
            if self.ref_conflict:
                self.store(b'newer registry','other'); return response(422)
            self.store(self.new_blob); return response(200)
        raise AssertionError((method,url))

class RegistryRecovery(unittest.TestCase):
    def checkpoint(self, fake):
        with mock.patch('time.sleep'):
            reader._checkpoint_shared_registry(fake, None,'owner','token', REGISTRY,'original',{'open-reader'})
    def test_500_then_success(self):
        f=FakeGitHub([(500,None),(200,'ours')]); self.checkpoint(f)
        self.assertEqual(f.content, DATA)
        self.assertEqual(sum(m=='PUT' for m,_,_ in f.calls),2)
    def test_500_but_commit_succeeded(self):
        f=FakeGitHub([(500,'ours')]); self.checkpoint(f)
        self.assertEqual(f.content, DATA)
        self.assertEqual(sum(m=='PUT' for m,_,_ in f.calls),1)
    def test_timeout_but_commit_succeeded(self):
        f=FakeGitHub([(None,'ours')]); self.checkpoint(f)
        self.assertEqual(f.content,DATA)
        self.assertEqual(sum(m=='PUT' for m,_,_ in f.calls),1)
    def test_concurrent_change_not_overwritten(self):
        f=FakeGitHub([(500,'other')])
        with self.assertRaisesRegex(RuntimeError,'changed during publication'): self.checkpoint(f)
        self.assertEqual(f.content,b'newer registry')
        self.assertEqual(sum(m=='PUT' for m,_,_ in f.calls),1)
    def test_persistent_500_nonforced_fallback(self):
        f=FakeGitHub([(500,None),(500,None)]); self.checkpoint(f)
        self.assertEqual(f.content, DATA)
        self.assertEqual(sum(m=='PATCH' for m,_,_ in f.calls),1)
    def test_fallback_concurrent_branch_change(self):
        f=FakeGitHub([(500,None),(500,None)]); f.ref_conflict=True
        with self.assertRaisesRegex(RuntimeError,'changed during publication'): self.checkpoint(f)
        self.assertEqual(f.content,b'newer registry')
    def test_permission_failure_not_retried(self):
        f=FakeGitHub([(403,None)])
        with self.assertRaisesRegex(RuntimeError,'HTTP 403'): self.checkpoint(f)
        self.assertEqual(sum(m=='PUT' for m,_,_ in f.calls),1)
    def test_bad_success_readback_fails(self):
        f=FakeGitHub([(200,None)])
        with self.assertRaisesRegex(RuntimeError,'checksum mismatch'): self.checkpoint(f)
    def test_existing_exact_bytes_no_write(self):
        f=FakeGitHub([]); f.content=DATA; self.checkpoint(f)
        self.assertFalse(any(m in ('PUT','POST','PATCH') for m,_,_ in f.calls))

if __name__=='__main__': unittest.main()
