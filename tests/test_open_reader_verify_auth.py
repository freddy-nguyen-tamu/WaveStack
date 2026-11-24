"""Auth-gated Worker verification: do not interpret 401/302 as missing backend."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from reusable import open_reader, open_reader_verify_auth as auth

ORIGIN='https://open-reader.test-account.workers.dev'

class ProtectedWorker(unittest.TestCase):
    def setUp(self):
        auth._CACHE.clear()
        self.calls=[]
        self.posted=[]
        self.responses={}
        self.password='long_test_password_123456789'
        self.cookie='9999999999.'+'b'*43

    def server_get(self,url,**kwargs):
        headers=kwargs.get('headers',{})
        self.calls.append((url,headers))
        if not headers.get('Cookie')=='reader_site='+self.cookie:
            if url.rstrip('/')==ORIGIN:
                return SimpleNamespace(status_code=302,headers={'Location':'/login/?next=/'})
            return SimpleNamespace(status_code=401,headers={},content=b'{"error":"Sign-in required"}',json=lambda:{'error':'Sign-in required'})
        path=url.removeprefix(ORIGIN)
        if path=='/api/reader-health':
            payload={'script':'open-reader-panel-replacement-v1','github_streaming_configured':True}
        elif path=='/registry.json':
            payload={'version':2,'comics':{}}
        elif path=='/source-issues.json':
            payload={'schema':'comicarchiver.source_issue_feed.v1','cases':[],'resolved_ids':[]}
        else:
            data=self.responses.get(path)
            if data is None:return SimpleNamespace(status_code=404,headers={},content=b'',json=lambda:{})
            return SimpleNamespace(status_code=200,headers={},content=data,json=lambda:json.loads(data))
        data=json.dumps(payload).encode()
        return SimpleNamespace(status_code=200,headers={},content=data,json=lambda:payload)

    def server_post(self,url,**kwargs):
        self.posted.append((url,kwargs))
        if (url!=ORIGIN+'/api/admin/login' or kwargs.get('headers',{}).get('Origin')!=ORIGIN or
                kwargs.get('json',{}).get('password')!=self.password):
            return SimpleNamespace(status_code=401,cookies={})
        return SimpleNamespace(status_code=200,cookies={'reader_site':self.cookie})

    def test_protected_live_registry_one_login_then_cached_reuse(self):
        with mock.patch.object(auth.requests,'get',side_effect=self.server_get), \
             mock.patch.object(auth.requests,'post',side_effect=self.server_post), \
             mock.patch.object(auth,'_load',side_effect=lambda origin:auth._CACHE.get(origin)), \
             mock.patch.object(auth,'_save',side_effect=lambda origin,cookie:auth._CACHE.__setitem__(origin,cookie)), \
             mock.patch.dict(os.environ,{'OPEN_READER_VERIFY_PASSWORD':self.password}):
            self.assertEqual(open_reader._public_json(ORIGIN+'/registry.json')['version'],2)
            self.assertEqual(open_reader._public_json(ORIGIN+'/registry.json')['version'],2)
        self.assertEqual(len(self.posted),1)
        self.assertEqual(self.calls[0][1].get('Cookie'),None)
        self.assertEqual(self.calls[-1][1]['Cookie'],'reader_site='+self.cookie)

    def test_verify_health_and_all_assets_with_session(self):
        with tempfile.TemporaryDirectory() as folder:
            stage=Path(folder)
            (stage/'source-issues.json').write_text(json.dumps({'schema':'comicarchiver.source_issue_feed.v1','cases':[],'resolved_ids':[]}))
            (stage/'registry.json').write_text(json.dumps({'version':2,'comics':{}}))
            (stage/'index.html').write_bytes(b'PRIVATE HOME')
            self.responses={'/':b'PRIVATE HOME'}
            with mock.patch.object(auth.requests,'get',side_effect=self.server_get), \
                 mock.patch.object(auth.requests,'post',side_effect=self.server_post), \
                 mock.patch.object(auth,'_load',side_effect=lambda origin:auth._CACHE.get(origin)), \
                 mock.patch.object(auth,'_save',side_effect=lambda origin,cookie:auth._CACHE.__setitem__(origin,cookie)), \
                 mock.patch.dict(os.environ,{'OPEN_READER_VERIFY_PASSWORD':self.password}):
                open_reader._verify_published(ORIGIN,stage,{'comics':{}})
            self.assertEqual(len(self.posted),1)
            self.assertTrue(all((not url.startswith(ORIGIN) or headers.get('Cookie')=='reader_site='+self.cookie)
                                for url,headers in self.calls[1:]))

    def test_redirect_detection(self):
        response=SimpleNamespace(status_code=302,headers={'Location':'/login/?next=%2F'})
        self.assertTrue(auth._requires_login(response,ORIGIN))
        response=SimpleNamespace(status_code=302,headers={'Location':'https://other.example/login/'})
        self.assertFalse(auth._requires_login(response,ORIGIN))

    def test_untrusted_host_never_receives_cookie(self):
        with mock.patch.object(auth.requests,'get',return_value=SimpleNamespace(status_code=200)) as getter:
            auth._CACHE[ORIGIN]=self.cookie
            auth.get('https://other.example/path',timeout=4)
        self.assertNotIn('Cookie',getter.call_args.kwargs.get('headers',{}))

    def test_wrong_password_stops_instead_of_faking_success(self):
        with mock.patch.object(auth.requests,'get',side_effect=self.server_get), \
             mock.patch.object(auth.requests,'post',side_effect=self.server_post), \
             mock.patch.object(auth,'_load',return_value=None), \
             mock.patch.dict(os.environ,{'OPEN_READER_VERIFY_PASSWORD':'wrong'}):
            with self.assertRaisesRegex(RuntimeError,'login refused'):
                open_reader._public_json(ORIGIN+'/registry.json')

if __name__=='__main__':unittest.main()
