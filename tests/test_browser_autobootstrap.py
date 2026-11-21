"""No pairing-code bootstrap: trusted extension-origin or privileged headers."""
import json
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from reusable.browser_bridge import LocalBridge, BRIDGE_PROTOCOL

URL='https://www.toongod.org/webtoon/annoying-alice/chapter-3/'
class AutomaticBridgeBootstrapTests(unittest.TestCase):
    def test_bootstrap_requires_extension_headers_and_claims_after_hello(self):
        bridge=LocalBridge(URL, port=0, image_hosts=['i.tngcdn.com'])
        bridge.start()
        url=f'http://127.0.0.1:{bridge.port}'
        def get(origin=None,secret=None,path='/bootstrap',client='local-reader-identity',bootstrap=True):
            headers={}
            if origin:headers['Origin']=origin
            if client:headers['X-Comic-Bridge-Client']=client
            if bootstrap:headers['X-Comic-Bridge-Bootstrap']='1'
            if secret:headers['X-Comic-Bridge-Token']=secret
            with urlopen(Request(url+path,headers=headers),timeout=4) as resp:
                return json.loads(resp.read())
        try:
            for origin in ('https://www.toongod.org', 'null'):
                with self.assertRaises(HTTPError) as e:get(origin)
                self.assertEqual(e.exception.code,403)
            with self.assertRaises(HTTPError) as e:get(None,bootstrap=False)
            self.assertEqual(e.exception.code,403)
            with self.assertRaises(HTTPError) as e:get(None,client='')
            self.assertEqual(e.exception.code,403)
            # Chrome MV3 privileged background fetch can omit Origin on GET.
            # This is safe only with custom headers, since website JS preflight
            # is not approved by the local listener.
            originless=get(None)
            identity='chrome-extension://local-reader-identity'
            data=get(identity)
            self.assertEqual(data['token'],originless['token'])
            self.assertEqual(data['site'],'www.toongod.org')
            self.assertEqual(data['port'],bridge.port)
            self.assertEqual(data['protocol'],BRIDGE_PROTOCOL)
            self.assertGreaterEqual(len(data['token']),20)
            # Unauthenticated bootstrap no longer claims the session.
            other=get('chrome-extension://untrusted-other',client='other-local-identity')
            self.assertEqual(other['token'],data['token'])
            with self.assertRaises(HTTPError) as e:get(identity,'wrong','/next')
            self.assertEqual(e.exception.code,401)
            payload=json.dumps({'url':URL,'bridge_protocol':BRIDGE_PROTOCOL,
              'capabilities':['probe','image','content-v2']}).encode()
            req=Request(url+'/hello',data=payload,method='POST',headers={
                'Origin':identity,'X-Comic-Bridge-Client':'local-reader-identity',
                'X-Comic-Bridge-Token':data['token'],'Content-Type':'application/json'})
            with urlopen(req,timeout=4) as resp:self.assertTrue(json.load(resp)['ok'])
            self.assertTrue(bridge.ready.is_set())
            with self.assertRaises(HTTPError) as e:get('chrome-extension://untrusted-other',client='other-local-identity')
            self.assertEqual(e.exception.code,403)
            # Even without Origin, another client must not claim this session.
            with self.assertRaises(HTTPError) as e:get(None,client='other-local-identity')
            self.assertEqual(e.exception.code,403)
        finally:bridge.close()
    def test_python_restart_rotates_secret_without_new_user_code(self):
        seen=[]
        for _ in range(2):
            bridge=LocalBridge(URL,port=0)
            bridge.start()
            try:
                with urlopen(Request(f'http://127.0.0.1:{bridge.port}/bootstrap',headers={
                  'Origin':'chrome-extension://local-reader-identity',
                  'X-Comic-Bridge-Bootstrap':'1','X-Comic-Bridge-Client':'local-reader-identity'}),timeout=4) as resp:
                    seen.append(json.load(resp)['token'])
            finally:bridge.close()
        self.assertNotEqual(*seen)
if __name__=='__main__':unittest.main()
