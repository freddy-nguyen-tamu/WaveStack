"""Offline retry regressions: saved identity, read-only API, no unsafe write replay."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock
from http.client import RemoteDisconnected
import requests
from reusable import engine

def response(status=200,login='owner'):
    r=Mock(status_code=status,headers={},text='');r.json.return_value={'login':login};return r

def disconnect():
    return requests.exceptions.ConnectionError('Connection aborted.',RemoteDisconnected('Remote end closed connection without response'))

class GithubReadRecovery(unittest.TestCase):
    def setUp(self):
        vals={'github_owner':'owner','github_credential_namespace':'saved-namespace'}
        for p in [patch.object(engine,'_inherit_shared_github_auth'),patch.object(engine,'get_option',side_effect=lambda db,key: vals.get(key)),patch.object(engine,'isolated_git_environment',return_value={'GCM_INTERACTIVE':'0','GIT_TERMINAL_PROMPT':'0'}),patch.object(engine.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='username=owner\npassword=test-secret\n',stderr='')),patch.object(engine,'event'),patch.object(engine.time,'sleep')]:
            p.start();self.addCleanup(p.stop)
    def test_exact_attached_disconnect_then_success(self):
        with patch.object(engine.requests,'get',side_effect=[disconnect(),response()]) as get:
            self.assertEqual(engine.credential_for_selected(object()),('owner','test-secret'))
            self.assertEqual(get.call_count,2)
            self.assertEqual(get.call_args.args,(engine.GITHUB_API+'/user',))
            engine.subprocess.run.assert_called_once()
            self.assertEqual(engine.subprocess.run.call_args.kwargs['env']['GCM_INTERACTIVE'],'0')
            engine.time.sleep.assert_called_once_with(2)
    def test_exhaustion_stays_fail_closed(self):
        with patch.object(engine.requests,'get',side_effect=disconnect()) as get:
            with self.assertRaisesRegex(RuntimeError,'checkpoints retained'):
                engine.credential_for_selected(object())
            self.assertEqual(get.call_count,3)
    def test_transient_http_retried_but_not_wrong_account(self):
        with patch.object(engine.requests,'get',side_effect=[response(503),response(200,'other')]) as get:
            with self.assertRaisesRegex(RuntimeError,'identity mismatch'):
                engine.credential_for_selected(object())
            self.assertEqual(get.call_count,2)
    def test_auth_denied_not_retried(self):
        for status in (401,403,429):
            with self.subTest(status=status),patch.object(engine.requests,'get',return_value=response(status)) as get:
                with self.assertRaisesRegex(RuntimeError,'HTTP '+str(status)):
                    engine.credential_for_selected(object())
                get.assert_called_once()
    def test_ssl_not_retried(self):
        with patch.object(engine.requests,'get',side_effect=requests.exceptions.SSLError('bad certificate')) as get:
            with self.assertRaises(requests.exceptions.SSLError):engine.credential_for_selected(object())
            get.assert_called_once()
    def test_get_and_head_retry(self):
        for method in ('GET','HEAD'):
            with self.subTest(method=method),patch.object(engine.requests,'request',side_effect=[disconnect(),response(502),response()]) as request:
                self.assertEqual(engine.github_http(method,engine.GITHUB_API+'/repos/owner/repo','token').status_code,200)
                self.assertEqual(request.call_count,3)
    def test_no_ambiguous_write_replay(self):
        for method in ('POST','PUT','PATCH','DELETE'):
            with self.subTest(method=method),patch.object(engine.requests,'request',side_effect=disconnect()) as request:
                with self.assertRaises(requests.exceptions.ConnectionError):engine.github_http(method,engine.GITHUB_API+'/repos/owner/repo','token')
                request.assert_called_once()
    def test_no_write_replay_5xx(self):
        with patch.object(engine.requests,'request',return_value=response(503)) as request:
            self.assertEqual(engine.github_http('PUT',engine.GITHUB_API+'/repos/owner/repo','token').status_code,503)
            request.assert_called_once()
if __name__=='__main__':unittest.main()
