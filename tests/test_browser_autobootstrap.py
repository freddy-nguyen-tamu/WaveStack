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


# Additive regression cases for one-shot terminal-side quiet image readiness.
# Keep the original bootstrap and credential boundary tests unchanged.
from unittest.mock import patch
from reusable import browser_bridge as quiet_bridge


class QuietImageGraceRegression(unittest.TestCase):
    def test_first_probe_quiet_wait_retries_exactly_once(self):
        from unittest.mock import Mock
        client = Mock()
        client.rpc.side_effect = [
            quiet_bridge.BrowserBridgeError('Browser probe failed: Error: No decoded CDN image on the selected page'),
            {'base64': 'saved-byte-proof'},
        ]
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            out = quiet_bridge._probe_with_one_quiet_image_grace(client, ['.generic-reader'])
        self.assertEqual(out['base64'], 'saved-byte-proof')
        self.assertEqual(client.rpc.call_count, 2)
        sleep.assert_called_once_with(10)
        self.assertEqual(client.rpc.call_args_list[0], client.rpc.call_args_list[1])

    def test_first_probe_stops_after_one_quiet_retry(self):
        from unittest.mock import Mock
        client = Mock()
        issue = quiet_bridge.BrowserBridgeError('No decoded CDN image on the selected page')
        client.rpc.side_effect = [issue, issue]
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            with self.assertRaisesRegex(quiet_bridge.BrowserBridgeError, 'Stopping without touching'):
                quiet_bridge._probe_with_one_quiet_image_grace(client, ())
        self.assertEqual(client.rpc.call_count, 2)
        sleep.assert_called_once_with(10)

    def test_other_probe_errors_fail_without_delay(self):
        from unittest.mock import Mock
        client = Mock()
        client.rpc.side_effect = quiet_bridge.BrowserBridgeError('Permission denied')
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            with self.assertRaisesRegex(quiet_bridge.BrowserBridgeError, 'Permission denied'):
                quiet_bridge._probe_with_one_quiet_image_grace(client, ())
        client.rpc.assert_called_once()
        sleep.assert_not_called()

    def test_empty_chapter_snapshot_one_quiet_retry(self):
        from unittest.mock import Mock
        from types import SimpleNamespace
        client = Mock()
        client.tab_url = 'https://example.org/chapter/next'
        client.rpc.side_effect = [
            {'imgs': [], 'total': 0},
            {'imgs': [{'key': '1', 'url': 'https://example.org/one.png'}], 'total': 1},
        ]
        context = SimpleNamespace(bridge=client, reader_selectors=['.reader'], image_attributes=['src'])
        page = quiet_bridge.BridgePage(context)
        page._expect_reader_images = True
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            result = page.evaluate('/* MutationObserver */')
        self.assertEqual(len(result['imgs']), 1)
        self.assertEqual(client.rpc.call_count, 2)
        sleep.assert_called_once_with(10)

    def test_still_empty_chapter_stops_after_one_retry(self):
        from unittest.mock import Mock
        from types import SimpleNamespace
        client = Mock()
        client.tab_url = 'https://example.org/chapter/next'
        client.rpc.return_value = {'imgs': []}
        page = quiet_bridge.BridgePage(SimpleNamespace(bridge=client, reader_selectors=[], image_attributes=[]))
        page._expect_reader_images = True
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            with self.assertRaisesRegex(quiet_bridge.BrowserBridgeError, 'Stopping this chapter'):
                page.evaluate('/* MutationObserver */')
        self.assertEqual(client.rpc.call_count, 2)
        sleep.assert_called_once_with(10)

    def test_normal_lazy_slots_and_unproven_pages_are_unchanged(self):
        from unittest.mock import Mock
        from types import SimpleNamespace
        client = Mock()
        client.tab_url = 'https://example.org/chapter/next'
        client.rpc.return_value = {'imgs': [{'key': '1', 'loaded': False}], 'total': 1}
        page = quiet_bridge.BridgePage(SimpleNamespace(bridge=client, reader_selectors=[], image_attributes=[]))
        page._expect_reader_images = True
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            self.assertEqual(page.evaluate('/* MutationObserver */')['total'], 1)
        client.rpc.assert_called_once()
        sleep.assert_not_called()
        client.reset_mock()
        client.rpc.return_value = {'imgs': []}
        page._expect_reader_images = False
        with patch.object(quiet_bridge.time, 'sleep') as sleep:
            self.assertEqual(page.evaluate('/* MutationObserver */')['imgs'], [])
        client.rpc.assert_called_once()
        sleep.assert_not_called()

if __name__=='__main__':unittest.main()
